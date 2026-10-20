/**
 * The world the simulation queries: terrain height, surface type, static
 * collision and progress along the active route. Built once per race from
 * (seed, route kind) and never mutated afterwards.
 */
import { CITY } from './config';
import { CityBlocks, Wall, generateBlocks } from './blocks';
import { RoadGraph, generateRoadGraph } from './roadGraph';
import { BarrierGroup, Route, RouteKind, buildRoute, findCircuitNodes, findSprintNodes, routeBarrierGroups, routeBarriers, routeRails } from './route';
import { Prop, buildPropGrid } from './props';
import { SpatialGrid } from './spatial';
import { Terrain, createTerrain } from './terrain';
import { cos, distToSegment, segmentT, sin, sqrt } from '../sim/math';
import { CityDistricts, planDistricts } from './districts';
import { Area, SURFACE_PHYSICS, Surface, SurfacePhysics } from './districts/types';

export type { Surface, SurfacePhysics } from './districts/types';

/** Which tuning surface entry (road / sidewalk / offroad) a surface drives with. */
export function surfacePhysics(s: Surface): SurfacePhysics {
  return SURFACE_PHYSICS[s];
}

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
  /** District areas (downtown blocks, parks, river, ...) and their builds. */
  districts: CityDistricts;
}

export interface World extends City {
  route: Route;
  /** City walls plus this route's barriers and corner rails. */
  walls: Wall[];
  wallGrid: SpatialGrid;
  /** Closed side street barriers grouped per intersection (see route.ts). Barrier walls carry `group`. */
  barrierGroups: BarrierGroup[];
  /**
   * Open world (test drive): no route barriers, corner rails, parked cars or
   * crowds; every street is drivable. The route still exists for the grid.
   */
  openWorld?: boolean;
  /** Destructible props (same array as blocks.props). Broken state lives on RaceState.brokenProps. */
  props: Prop[];
  /** Broadphase over props by id (each prop inserted with its radius). */
  propGrid: SpatialGrid;
  /**
   * Props this route's barriers or rails stand on. Props are generated per
   * city but barriers per route, so these start every race as removed
   * (RaceState.brokenProps = 2): no collision, not rendered, no debris.
   */
  coveredProps: number[];
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): { gx: number; gz: number };
  surfaceAt(x: number, z: number): Surface;
  collideCircle(x: number, z: number, r: number, out: Contact[]): number;
  collideBox(cx: number, cz: number, yaw: number, halfLength: number, halfWidth: number, out: Contact[]): number;
  /** Distance to the nearest wall, capped at maxDist. */
  wallClearance(x: number, z: number, maxDist: number): number;
  routeProgress(x: number, z: number, hintSeg?: number): RouteProgress;
  /** Every district area (same array as districts.areas). */
  areas: Area[];
  /** Area at a point (4 m raster): the block, park, plaza, channel... or null on plain streets. */
  areaAt(x: number, z: number): Area | null;
}

export function createCity(seed: number): City {
  const graph = generateRoadGraph(seed);
  // Districts claim space and edit the graph (alleys, shortcuts, roundabouts, bridges) first.
  const districts = planDistricts(seed, graph);
  const terrain = createTerrain(seed, districts.heightMods);
  const blocks = generateBlocks(seed, graph, terrain, districts.blocksInput);
  districts.finalize(blocks);
  return { seed, graph, terrain, blocks, districts };
}

/** Rails are planned around node centers; roundabouts get none (their ring has its own outer walls). */
function awayFromRoundabouts<T extends Wall>(graph: RoadGraph, rails: T[]): T[] {
  const rings = graph.nodes.filter((n) => n.ring);
  if (!rings.length) return rails;
  const bad = new Set<number>();
  for (const w of rails) {
    for (const n of rings) {
      const r = n.ring!.outer + CITY.sidewalk + 25;
      if (distToSegment(n.x, n.z, w.ax, w.az, w.bx, w.bz) < r) bad.add(w.group ?? -1);
    }
  }
  return rails.filter((w) => !bad.has(w.group ?? -1));
}

export function createRoute(city: City, kind: RouteKind): Route {
  const nodes = kind === 'circuit' ? findCircuitNodes(city.graph, city.seed) : findSprintNodes(city.graph, city.seed);
  return buildRoute(city.graph, kind, nodes);
}

export function createWorld(seed: number, kind: RouteKind, city: City = createCity(seed), opts: { openWorld?: boolean } = {}): World {
  const route = createRoute(city, kind);
  const { graph, blocks, terrain } = city;
  const openWorld = opts.openWorld === true;
  const rails = openWorld ? [] : awayFromRoundabouts(graph, routeRails(graph, route, blocks.props, blocks.walls));
  const barrierGroups = openWorld ? [] : routeBarrierGroups(graph, blocks.mouths, route, rails);
  const walls = blocks.walls.concat(routeBarriers(graph, blocks.mouths, route, barrierGroups), rails);
  const props = blocks.props;
  const propGrid = buildPropGrid(graph, props);
  const coveredProps = propsUnderWalls(props, propGrid, walls.slice(blocks.walls.length));
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
    let walk = Infinity;
    for (const id of scratch) {
      const e = graph.edges[id];
      const a = graph.nodes[e.a];
      const b = graph.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - e.width / 2;
      if (d < best) best = d;
      if (d - e.sidewalk < walk) walk = d - e.sidewalk;
    }
    // District surface patches win over the street classification by priority (road 5, sidewalk 3).
    const patch = city.districts.surfaceAt(x, z);
    const base = best <= 0 ? 5 : walk <= 0 ? 3 : 0;
    if (patch && patch.priority > base) return patch.surface;
    return base === 5 ? 'road' : base === 3 ? 'sidewalk' : 'offroad';
  }

  const pts = route.points;
  const nseg = pts.length - 1;
  const HINT_REACH = 40;
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
      // At least two segments each way, and at least HINT_REACH m (roundabout arcs are short).
      consider(hintSeg);
      for (const dir of [-1, 1]) {
        let covered = 0;
        for (let k = 1; k < nseg / 2 && (k <= 2 || covered < HINT_REACH); k++) {
          let i = hintSeg + dir * k;
          if (route.closed) i = (i + nseg) % nseg;
          if (i < 0 || i >= nseg) break;
          consider(i);
          covered += route.cum[i + 1] - route.cum[i];
        }
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
    barrierGroups,
    openWorld,
    props,
    coveredProps,
    propGrid,
    heightAt: terrain.heightAt,
    slopeAt: terrain.slopeAt,
    surfaceAt,
    collideCircle,
    collideBox,
    wallClearance,
    routeProgress,
    areas: city.districts.areas,
    areaAt: city.districts.areaAt,
  };
}

/** Ids of non-streetlight props that a route wall (barrier or rail) passes through. */
function propsUnderWalls(props: Prop[], grid: SpatialGrid, routeWalls: Wall[]): number[] {
  const out = new Set<number>();
  const scratch: number[] = [];
  for (const w of routeWalls) {
    grid.query(Math.min(w.ax, w.bx) - 3, Math.min(w.az, w.bz) - 3, Math.max(w.ax, w.bx) + 3, Math.max(w.az, w.bz) + 3, scratch);
    for (const id of scratch) {
      const p = props[id];
      if (p.kind !== 'streetlight' && distToSegment(p.x, p.z, w.ax, w.az, w.bx, w.bz) <= p.radius + 0.1) out.add(id);
    }
  }
  return [...out].sort((a, b) => a - b);
}
