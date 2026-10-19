/**
 * The world the simulation queries: terrain height, surface type, static
 * collision and progress along the active route. Built once per race from
 * (seed, route kind) and never mutated afterwards.
 */
import { CITY } from './config';
import { CityBlocks, Wall, generateBlocks } from './blocks';
import { RoadGraph, generateRoadGraph } from './roadGraph';
import { Route, RouteKind, buildRoute, findCircuitNodes, findSprintNodes, routeBarriers } from './route';
import { SpatialGrid } from './spatial';
import { Terrain, createTerrain } from './terrain';
import { cos, distToSegment, segmentT, sin, sqrt } from '../sim/math';

export type Surface = 'road' | 'sidewalk' | 'offroad';

export interface Contact {
  /** Push direction (unit) out of the wall into drivable space. */
  nx: number;
  nz: number;
  depth: number;
  /** Contact point on the wall. */
  px: number;
  pz: number;
  kind: Wall['kind'];
}

export interface RouteProgress {
  /** Distance along the route polyline. */
  s: number;
  /** Signed offset from the centerline, positive = left of travel direction. */
  lateral: number;
  seg: number;
  /** Unit tangent of the segment. */
  tx: number;
  tz: number;
}

export interface City {
  seed: number;
  graph: RoadGraph;
  terrain: Terrain;
  blocks: CityBlocks;
}

export interface World extends City {
  route: Route;
  /** City walls plus this route's barriers. */
  walls: Wall[];
  wallGrid: SpatialGrid;
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): { gx: number; gz: number };
  surfaceAt(x: number, z: number): Surface;
  collideCircle(x: number, z: number, r: number, out: Contact[]): number;
  collideBox(cx: number, cz: number, yaw: number, halfLength: number, halfWidth: number, out: Contact[]): number;
  /** Distance to the nearest wall, capped at maxDist. */
  wallClearance(x: number, z: number, maxDist: number): number;
  routeProgress(x: number, z: number, hintSeg?: number): RouteProgress;
}

export function createCity(seed: number): City {
  const graph = generateRoadGraph(seed);
  const terrain = createTerrain(seed);
  const blocks = generateBlocks(seed, graph, terrain);
  return { seed, graph, terrain, blocks };
}

export function createRoute(city: City, kind: RouteKind): Route {
  const nodes = kind === 'circuit' ? findCircuitNodes(city.graph, city.seed) : findSprintNodes(city.graph, city.seed);
  return buildRoute(city.graph, kind, nodes);
}

export function createWorld(seed: number, kind: RouteKind, city: City = createCity(seed)): World {
  const route = createRoute(city, kind);
  const { graph, blocks, terrain } = city;
  const walls = blocks.walls.concat(routeBarriers(graph, blocks.mouths, route));
  const pad = 60;
  const wallGrid = SpatialGrid.forBounds(graph.bounds.minX - pad, graph.bounds.minZ - pad, graph.bounds.maxX + pad, graph.bounds.maxZ + pad, CITY.broadphaseCell);
  walls.forEach((w, i) => wallGrid.insertSegment(i, w.ax, w.az, w.bx, w.bz, 0.5));
  const edgeGrid = blocks.edgeGrid;
  const scratch: number[] = [];

  function collideCircle(x: number, z: number, r: number, out: Contact[]): number {
    out.length = 0;
    wallGrid.query(x - r - 3, z - r - 3, x + r + 3, z + r + 3, scratch);
    for (const id of scratch) {
      const w = walls[id];
      const t = segmentT(x, z, w.ax, w.az, w.bx, w.bz);
      const cx = w.ax + (w.bx - w.ax) * t;
      const cz = w.az + (w.bz - w.az) * t;
      const dx = x - cx;
      const dz = z - cz;
      const sd = dx * w.nx + dz * w.nz;
      // One sided: a center up to 3 m behind the wall still gets pushed back,
      // which stops fast cars tunnelling through.
      if (sd < -3 || sd >= r) continue;
      let nx = w.nx;
      let nz = w.nz;
      let depth = r - sd;
      if (t <= 0 || t >= 1) {
        // Endpoint: push radially, but only if actually overlapping.
        const d = sqrt(dx * dx + dz * dz);
        if (d >= r) continue;
        if (sd > 0 && d > 1e-6) {
          nx = dx / d;
          nz = dz / d;
          depth = r - d;
        }
      }
      out.push({ nx, nz, depth, px: cx, pz: cz, kind: w.kind });
    }
    return out.length;
  }

  const boxScratch: Contact[] = [];
  function collideBox(cx: number, cz: number, yaw: number, halfLength: number, halfWidth: number, out: Contact[]): number {
    // Approximate the box with overlapping circles along its length.
    out.length = 0;
    const n = Math.max(2, Math.ceil(halfLength / halfWidth) + 1);
    const fx = sin(yaw);
    const fz = cos(yaw);
    for (let i = 0; i < n; i++) {
      const u = -halfLength + halfWidth + ((2 * (halfLength - halfWidth)) * i) / (n - 1);
      collideCircle(cx + fx * u, cz + fz * u, halfWidth, boxScratch);
      for (const c of boxScratch) out.push(c);
    }
    return out.length;
  }

  function wallClearance(x: number, z: number, maxDist: number): number {
    wallGrid.query(x - maxDist, z - maxDist, x + maxDist, z + maxDist, scratch);
    let best = maxDist;
    for (const id of scratch) {
      const w = walls[id];
      const d = distToSegment(x, z, w.ax, w.az, w.bx, w.bz);
      if (d < best) best = d;
    }
    return best;
  }

  function surfaceAt(x: number, z: number): Surface {
    edgeGrid.query(x - 1, z - 1, x + 1, z + 1, scratch);
    let best = Infinity;
    for (const id of scratch) {
      const e = graph.edges[id];
      const a = graph.nodes[e.a];
      const b = graph.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - e.width / 2;
      if (d < best) best = d;
    }
    if (best <= 0) return 'road';
    if (best <= CITY.sidewalk) return 'sidewalk';
    return 'offroad';
  }

  const pts = route.points;
  const nseg = pts.length - 1;
  function projectSeg(i: number, x: number, z: number) {
    const a = pts[i];
    const b = pts[i + 1];
    const t = segmentT(x, z, a.x, a.z, b.x, b.z);
    const cx = a.x + (b.x - a.x) * t;
    const cz = a.z + (b.z - a.z) * t;
    return { t, d2: (x - cx) ** 2 + (z - cz) ** 2, cx, cz };
  }

  function routeProgress(x: number, z: number, hintSeg?: number): RouteProgress {
    let bestI = 0;
    let best = Infinity;
    const consider = (i: number) => {
      const p = projectSeg(i, x, z);
      if (p.d2 < best) {
        best = p.d2;
        bestI = i;
      }
    };
    if (hintSeg !== undefined && hintSeg >= 0 && hintSeg < nseg) {
      for (let k = -2; k <= 2; k++) {
        let i = hintSeg + k;
        if (route.closed) i = (i + nseg) % nseg;
        if (i >= 0 && i < nseg) consider(i);
      }
    } else {
      for (let i = 0; i < nseg; i++) consider(i);
    }
    const a = pts[bestI];
    const b = pts[bestI + 1];
    const p = projectSeg(bestI, x, z);
    const segLen = route.cum[bestI + 1] - route.cum[bestI] || 1;
    const tx = (b.x - a.x) / segLen;
    const tz = (b.z - a.z) / segLen;
    return {
      s: route.cum[bestI] + p.t * segLen,
      lateral: (x - p.cx) * tz - (z - p.cz) * tx,
      seg: bestI,
      tx,
      tz,
    };
  }

  return {
    ...city,
    route,
    walls,
    wallGrid,
    heightAt: terrain.heightAt,
    slopeAt: terrain.slopeAt,
    surfaceAt,
    collideCircle,
    collideBox,
    wallClearance,
    routeProgress,
  };
}
