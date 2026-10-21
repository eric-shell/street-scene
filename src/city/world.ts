/**
 * The world the simulation queries: terrain height, surface type, static
 * collision and progress along the active route. Built once per race from
 * (seed, route kind) and never mutated afterwards.
 */
import { CITY, ROUTE } from './config';
import { CityBlocks, Solid, Wall, generateBlocks } from './blocks';
import { RoadGraph, generateRoadGraph } from './roadGraph';
import { BarrierGroup, RailWall, Route, RouteKind, buildRoute, findCircuitNodes, findSprintNodes, routeBarrierGroups, routeRails } from './route';
import { Prop, buildPropGrid } from './props';
import { SpatialGrid } from './spatial';
import { Terrain, createTerrain } from './terrain';
import { cos, distToSegment, segmentT, sin, sqrt } from '../sim/math';
import { CityDistricts, planDistricts } from './districts';
import { carveRouteShortcuts, hasShortcutSpot, qualifiedCount } from './districts/alley';
import { CityEvent, EventFlavourId, eventOffer, eventRoutePreference, pickEventFlavour, resolveEvent, routeEdges } from './events';

/** Routes tried (the first pick, then alternatives) until one has room for a shortcut. */
const ROUTE_TRIES = 12;
import { pointInPolygon } from './districts/geom';
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
  /**
   * Both routes' graph nodes in driving order, picked while the city is
   * planned (see planRoads) so their shortcuts could be carved into it.
   */
  routeNodes: Record<RouteKind, number[]>;
  /** The seed's named event (Hill Climb, River Run, ...; see events.ts), which the routes were picked to match. */
  event: CityEvent;
}

/**
 * The street network as the game drives it: the road graph, every district
 * planned, and both routes picked as soon as the street topology is final.
 * Each route then gets its guaranteed shortcuts carved into the graph
 * (carveRouteShortcuts), which splits some of its edges; the stored node
 * lists include those split nodes, so routes stay on the same streets.
 * Cheap (no blocks): tests use it to sweep many seeds. `forceFlavour`
 * overrides the seed's drawn event flavour (tests and tools comparing them).
 */
export function planRoads(seed: number, forceFlavour?: EventFlavourId): { graph: RoadGraph; districts: CityDistricts; routeNodes: Record<RouteKind, number[]>; event: CityEvent } {
  const graph = generateRoadGraph(seed);
  let routeNodes: Record<RouteKind, number[]> | null = null;
  let flavour: EventFlavourId = 'downtownDash';
  // Districts claim space and edit the graph (alleys, shortcuts, roundabouts, bridges) first.
  const districts = planDistricts(seed, graph, {
    topology(ctx) {
      // A route with no room for a shortcut (one wrapped around the river, say) is swapped for the
      // next alternative that has one: alternatives that still match the event (and dive into the
      // channel) first, then routes picked without the preference, since on the rare seed that cannot
      // have both a shortcut on every route outranks the flavour; after ROUTE_TRIES each way the first
      // pick stands.
      const pick = (find: (variant: number, prefer: boolean) => number[], closed: boolean, others: { nodes: number[]; closed: boolean }[]) => {
        const first = { nodes: find(0, true), closed };
        if (hasShortcutSpot(ctx, first, others)) return first;
        for (const prefer of [true, false]) {
          for (let v = 1; v < ROUTE_TRIES; v++) {
            const alt = { nodes: find(v, prefer), closed };
            if (hasShortcutSpot(ctx, alt, others)) return alt;
          }
        }
        return first;
      };
      // The seed's event flavour, drawn from what this city can deliver, says what the routes should
      // have (events.ts); every flavour but River Run also keeps the river dive as a second wish.
      const g = ctx.graph;
      flavour = forceFlavour ?? pickEventFlavour(seed, eventOffer(g, ctx.areas));
      const preferCircuit = eventRoutePreference(flavour, ctx, true);
      const preferSprint = eventRoutePreference(flavour, ctx, false);
      // The circuit is checked against the first sprint pick (whose start and finish it must keep clear).
      const firstSprint = { nodes: findSprintNodes(g, seed, 0, preferSprint), closed: false };
      const circuit = pick((v, p) => findCircuitNodes(g, seed, v, p ? preferCircuit : undefined), true, [firstSprint]);
      const sprint = pick((v, p) => (v ? findSprintNodes(g, seed, v, p ? preferSprint : undefined) : firstSprint.nodes), false, [circuit]);
      carveRouteShortcuts(ctx, [circuit, sprint]);
      // A route left without a cut (the other route's cuts took its only spot) is re-picked on the
      // carved graph and carved again, the other route kept clear as before.
      let sprint2 = sprint;
      let circuit2 = circuit;
      if (!qualifiedCount(g, sprint2)) {
        sprint2 = pick((v, p) => findSprintNodes(g, seed, v, p ? preferSprint : undefined), false, [circuit2]);
        carveRouteShortcuts(ctx, [circuit2, sprint2]);
      }
      if (!qualifiedCount(g, circuit2)) {
        circuit2 = pick((v, p) => findCircuitNodes(g, seed, v, p ? preferCircuit : undefined), true, [sprint2]);
        carveRouteShortcuts(ctx, [circuit2, sprint2]);
      }
      routeNodes = { circuit: circuit2.nodes, sprint: sprint2.nodes };
      // Hills and the monument are planned after this: they read the routes to come to the race.
      return { flavour, routes: [circuit2, sprint2].map((r) => ({ nodes: r.nodes, edges: routeEdges(g, r.nodes, r.closed), closed: r.closed })) };
    },
  });
  if (!routeNodes) throw new Error('routes were not planned');
  const nodes: Record<RouteKind, number[]> = routeNodes;
  const event = resolveEvent(flavour, graph, districts.areas, [
    { nodes: nodes.circuit, closed: true },
    { nodes: nodes.sprint, closed: false },
  ]);
  return { graph, districts, routeNodes: nodes, event };
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
  /** Terrain height (m): the ground everything is draped on, road level. */
  heightAt(x: number, z: number): number;
  /**
   * Height a wheel stands at (m): the terrain plus CITY.curbHeight on the
   * paving the city draws at curb height (sidewalks, roundabout rings,
   * plazas), eased across the curb so a car rolls up onto a sidewalk instead
   * of sinking into it.
   */
  driveHeightAt(x: number, z: number): number;
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
  const { graph, districts, routeNodes, event } = planRoads(seed);
  const terrain = createTerrain(seed, districts.heightMods);
  const blocks = generateBlocks(seed, graph, terrain, districts.blocksInput);
  districts.finalize(blocks);
  return { seed, graph, terrain, blocks, districts, routeNodes, event };
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

/** Drivable infill (corner pockets, plazas, verges, lots) whose frontage is open to the street. */
const POCKETS = new Set(['cornerPlaza', 'plaza', 'verge', 'lot']);

/**
 * A closure barrier ends at its street's building line. Where a drivable
 * pocket opens right there, carry the barrier on across the pocket to its
 * far side, so the pocket is no way around the closure (and nobody drives
 * through the parked cars behind it). Parks stay open: they are shortcuts.
 */
function sealBarriers(city: City, groups: BarrierGroup[]): void {
  const pockets = city.districts.areas.filter((a) => a.kind === 'infill' && POCKETS.has(a.variant));
  const sealed: Wall[] = [];
  for (const gr of groups) {
    for (const w of gr.walls) {
      for (const atA of [true, false]) {
        const ex = atA ? w.ax : w.bx;
        const ez = atA ? w.az : w.bz;
        const ox = atA ? w.bx : w.ax;
        const oz = atA ? w.bz : w.az;
        const len = sqrt((ex - ox) ** 2 + (ez - oz) ** 2) || 1;
        const dx = (ex - ox) / len;
        const dz = (ez - oz) / len;
        const pocket = pockets.find((a) => pointInPolygon(ex + dx * 0.6, ez + dz * 0.6, a.polygon));
        if (!pocket) continue;
        // Farthest crossing of the ray with the pocket outline: where it leaves the pocket.
        let reach = 0;
        const P = pocket.polygon;
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          const q = P[(i + 1) % P.length];
          const sx = q.x - p.x;
          const sz = q.z - p.z;
          const den = dx * sz - dz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((p.x - ex) * sz - (p.z - ez) * sx) / den;
          const u = ((p.x - ex) * dz - (p.z - ez) * dx) / den;
          if (t > 0 && u >= 0 && u <= 1) reach = Math.max(reach, t);
        }
        if (reach <= 0 || reach > 40) continue;
        // Or the first city wall on the way (a fountain basin, a boundary wall), whichever comes first.
        for (const c of city.blocks.walls) {
          if (Math.abs(c.ax - ex) > 45 || Math.abs(c.az - ez) > 45) continue;
          const sx = c.bx - c.ax;
          const sz = c.bz - c.az;
          const den = dx * sz - dz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((c.ax - ex) * sz - (c.az - ez) * sx) / den;
          const u = ((c.ax - ex) * dz - (c.az - ez) * dx) / den;
          // Walls touching the closure's own end count too (reach 0: no seal rather than a crossing).
          if (t > -0.05 && t < reach && u >= 0 && u <= 1) reach = Math.max(0, t);
        }
        if (reach <= 0.1) continue;
        // Just short of the pocket's back curb (never through it); the hair left is far narrower than a car.
        const nx = ex + dx * (reach - 0.05);
        const nz = ez + dz * (reach - 0.05);
        if (atA) {
          w.ax = nx;
          w.az = nz;
        } else {
          w.bx = nx;
          w.bz = nz;
        }
        gr.length += reach - 0.05;
        sealed.push(w);
      }
    }
  }
  // Two closures around one pocket both reach into it: clip them where they cross, a V like merged mouths.
  for (let i = 0; i < sealed.length; i++) {
    for (let j = i + 1; j < sealed.length; j++) {
      const a = sealed[i];
      const b = sealed[j];
      const dax = a.bx - a.ax;
      const daz = a.bz - a.az;
      const dbx = b.bx - b.ax;
      const dbz = b.bz - b.az;
      const den = dax * dbz - daz * dbx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((b.ax - a.ax) * dbz - (b.az - a.az) * dbx) / den;
      const u = ((b.ax - a.ax) * daz - (b.az - a.az) * dax) / den;
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
      const x = a.ax + dax * t;
      const z = a.az + daz * t;
      if (t > 0.5) {
        a.bx = x;
        a.bz = z;
      } else {
        a.ax = x;
        a.az = z;
      }
      if (u > 0.5) {
        b.bx = x;
        b.bz = z;
      } else {
        b.ax = x;
        b.az = z;
      }
    }
  }
}

/**
 * Closures become cyan modular rail pieces like the corner rails (src/sim/rails.ts):
 * straight pieces of about ROUTE.railPieceLength along each closure segment, one
 * rail group per barrier group (V joined segments chain like a bent rail), group
 * and piece ids continuing after the corner rails'. The groups' walls become
 * these pieces.
 */
function closureRails(groups: BarrierGroup[], cornerRails: RailWall[]): RailWall[] {
  let rail = 0;
  let piece = 0;
  for (const w of cornerRails) {
    rail = Math.max(rail, w.group + 1);
    piece = Math.max(piece, w.piece + 1);
  }
  const out: RailWall[] = [];
  for (const g of groups) {
    const pieces: RailWall[] = [];
    for (const w of g.walls) {
      const len = sqrt((w.bx - w.ax) ** 2 + (w.bz - w.az) ** 2);
      if (len < 0.05) continue;
      const n = Math.max(1, Math.round(len / ROUTE.railPieceLength));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        pieces.push({
          ax: w.ax + (w.bx - w.ax) * t0,
          az: w.az + (w.bz - w.az) * t0,
          bx: k === n - 1 ? w.bx : w.ax + (w.bx - w.ax) * t1,
          bz: k === n - 1 ? w.bz : w.az + (w.bz - w.az) * t1,
          nx: w.nx,
          nz: w.nz,
          kind: 'rail',
          group: rail,
          piece: piece++,
        });
      }
    }
    g.walls = pieces;
    out.push(...pieces);
    rail++;
  }
  return out;
}

export function createRoute(city: City, kind: RouteKind): Route {
  return buildRoute(city.graph, kind, city.routeNodes[kind]);
}

export function createWorld(seed: number, kind: RouteKind, city: City = createCity(seed), opts: { openWorld?: boolean } = {}): World {
  const route = createRoute(city, kind);
  const { graph, blocks, terrain } = city;
  const openWorld = opts.openWorld === true;
  const rails = openWorld ? [] : awayFromRoundabouts(graph, routeRails(graph, route, blocks.props, blocks.walls));
  const barrierGroups = openWorld ? [] : routeBarrierGroups(graph, blocks.mouths, route, rails);
  sealBarriers(city, barrierGroups);
  const closures = closureRails(barrierGroups, rails);
  const walls = blocks.walls.concat(rails, closures);
  const props = blocks.props;
  const propGrid = buildPropGrid(graph, props);
  const coveredProps = propsUnderWalls(props, propGrid, walls.slice(blocks.walls.length));
  const pad = 60;
  const wallGrid = SpatialGrid.forBounds(graph.bounds.minX - pad, graph.bounds.minZ - pad, graph.bounds.maxX + pad, graph.bounds.maxZ + pad, CITY.broadphaseCell);
  walls.forEach((w, i) => wallGrid.insertSegment(i, w.ax, w.az, w.bx, w.bz, 0.5));
  const edgeGrid = blocks.edgeGrid;
  const scratch: number[] = [];

  /**
   * Circle against a small convex solid as one body: from outside, pushed off the nearest point
   * of its outline; from inside, out through the nearest face. Never toward the far side.
   */
  function collideSolid(s: Solid, kind: Wall['kind'], x: number, z: number, r: number, out: Contact[]): void {
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < s.faces.length; i++) {
      const f = s.faces[i];
      const sd = (x - f.ax) * f.nx + (z - f.az) * f.nz;
      if (sd > best) {
        best = sd;
        bi = i;
      }
    }
    if (best >= r) return;
    if (best <= 0) {
      const f = s.faces[bi];
      out.push({ nx: f.nx, nz: f.nz, depth: r - best, px: x - f.nx * best, pz: z - f.nz * best, kind });
      return;
    }
    let d2 = Infinity;
    let px = 0;
    let pz = 0;
    for (const f of s.faces) {
      const t = segmentT(x, z, f.ax, f.az, f.bx, f.bz);
      const cx = f.ax + (f.bx - f.ax) * t;
      const cz = f.az + (f.bz - f.az) * t;
      const e2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (e2 < d2) {
        d2 = e2;
        px = cx;
        pz = cz;
      }
    }
    const d = sqrt(d2);
    if (d >= r || d < 1e-9) return;
    out.push({ nx: (x - px) / d, nz: (z - pz) / d, depth: r - d, px, pz, kind });
  }

  function collideCircle(x: number, z: number, r: number, out: Contact[]): number {
    out.length = 0;
    wallGrid.query(x - r - 3, z - r - 3, x + r + 3, z + r + 3, scratch);
    // A solid's faces are consecutive walls and the query is in ascending id order, so they come
    // up one after another: the solid is handled once, at the first of them.
    let lastSolid: Solid | undefined;
    for (const id of scratch) {
      const w = walls[id];
      if (w.solid) {
        if (w.solid !== lastSolid) collideSolid(w.solid, w.kind, x, z, r, out);
        lastSolid = w.solid;
        continue;
      }
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

  const rings = graph.nodes.filter((n) => n.ring);
  /** Flared shortcut mouths: the junction fan out to the curved curbs, and how far it reaches from the node. */
  const fans = graph.nodes.flatMap((n, i) => {
    const secs = blocks.sectors[i];
    if (!secs.some((s) => s.flared)) return [];
    const ring = secs.flatMap((s) => s.curb);
    let reach = 0;
    for (const p of ring) reach = Math.max(reach, sqrt((p.x - n.x) ** 2 + (p.z - n.z) ** 2));
    return [{ x: n.x, z: n.z, ring, reach }];
  });
  const liftScratch: number[] = [];
  const CURB_IN = CITY.curbRamp.road;
  const CURB_SPAN = CITY.curbRamp.road + CITY.curbRamp.walk;
  /** Paving a district draws at curb height: plazas, corner pockets and verges, the monument plaza. */
  const raisedPatch = (area: number): boolean => {
    const a = city.districts.areas[area];
    return a.kind === 'monument' || (a.kind === 'infill' && a.variant !== 'lot' && a.variant !== 'planter');
  };
  /**
   * Curb lift under a point (m). The street classification is surfaceAt's
   * (road strips and their sidewalks, by distance to the edges) plus the
   * roundabout rings (road inside the outer curb, sidewalk around it). A
   * district patch over the sidewalk's priority that is not sidewalk (alley
   * cobbles, the river) keeps the ground flat; plazas at curb height lift.
   * The lift eases in from curbRamp.road out on the road to curbRamp.walk
   * onto the paving.
   */
  function curbLift(x: number, z: number): number {
    edgeGrid.query(x - 1, z - 1, x + 1, z + 1, liftScratch);
    let road = Infinity;
    let walk = Infinity;
    for (const id of liftScratch) {
      const e = graph.edges[id];
      const a = graph.nodes[e.a];
      const b = graph.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - e.width / 2;
      if (d < road) road = d;
      if (d - e.sidewalk < walk) walk = d - e.sidewalk;
    }
    for (const n of rings) {
      const d = sqrt((x - n.x) ** 2 + (z - n.z) ** 2) - n.ring!.outer;
      if (d < road) road = d;
      if (d - CITY.sidewalk < walk) walk = d - CITY.sidewalk;
    }
    // A flared mouth's curved curbs: distance outside its fan (the fan itself is a road patch).
    for (const f of fans) {
      if ((x - f.x) ** 2 + (z - f.z) ** 2 > (f.reach + CITY.sidewalk) ** 2) continue;
      let d = Infinity;
      for (let i = 0; i < f.ring.length; i++) {
        const p = f.ring[i];
        const q = f.ring[(i + 1) % f.ring.length];
        d = Math.min(d, distToSegment(x, z, p.x, p.z, q.x, q.z));
      }
      if (pointInPolygon(x, z, f.ring)) d = -d;
      if (d < road) road = d;
    }
    if (road <= -CURB_IN) return 0;
    const patch = city.districts.surfaceAt(x, z);
    if (patch && patch.priority > 3 && patch.surface !== 'sidewalk') return 0;
    if (walk > 0 && !(patch && (patch.surface === 'sidewalk' || raisedPatch(patch.area)))) return 0;
    const t = (road + CURB_IN) / CURB_SPAN;
    if (t >= 1) return CITY.curbHeight;
    return CITY.curbHeight * t * t * (3 - 2 * t);
  }

  function driveHeightAt(x: number, z: number): number {
    return terrain.heightAt(x, z) + curbLift(x, z);
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
    driveHeightAt,
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
/** Props closer than this (m, beyond their radius) to a route barrier or rail start the race removed. */
const COVER_CLEAR = 0.25;

function propsUnderWalls(props: Prop[], grid: SpatialGrid, routeWalls: Wall[]): number[] {
  const out = new Set<number>();
  const scratch: number[] = [];
  for (const w of routeWalls) {
    grid.query(Math.min(w.ax, w.bx) - 3, Math.min(w.az, w.bz) - 3, Math.max(w.ax, w.bx) + 3, Math.max(w.az, w.bz) + 3, scratch);
    for (const id of scratch) {
      const p = props[id];
      // Clutter a rail would clip (alley tables and crates at the back of a narrow sidewalk) goes too.
      if (p.kind !== 'streetlight' && distToSegment(p.x, p.z, w.ax, w.az, w.bx, w.bz) <= p.radius + COVER_CLEAR) out.add(id);
    }
  }
  return [...out].sort((a, b) => a - b);
}
