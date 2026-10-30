/**
 * Site finder shared by the weekend specials (weekend.ts, docs/weekend.md): the
 * rail yard, the underground trench and the scrapyard each take one or two plain
 * blocks that front a street the races drive, and want the same short list of
 * candidates, best first. Pure and deterministic; reads PlanContext.event, so it
 * only works for modules planned after the topology hook (registry slot after
 * the back alleys).
 *
 * A candidate block face (BlockFace, one per block) qualifies when
 *  - it is interior and unclaimed, with no edge that is claimed (the El's and the
 *    highway's streets, a lake's shore, a monument's held passes), a bridge, a
 *    shortcut or a level crossing, no roundabout corner, and it overlaps no
 *    ctx.keepOut polygon (the car park sites held while the alleys are carved);
 *  - it keeps clear (HAZARD_MARGIN m, siteClear in structures.ts) of the El, the
 *    highway, the channel, hill slopes, roundabout rings and bluffs, at its
 *    corners and along its ring. Hills are planned after the weekend modules, so
 *    they keep their slopes off what is claimed here;
 *  - it shares at least one face edge with a street that a route drives (the
 *    `edges` of the site: which routes, the frontage length along it, the stretch
 *    between the junctions' closures and rails), further than `keepOffStartFinish`
 *    m along the route from that route's start and finish, and off the start
 *    straights (structures.ts raceStreets). Lake, park and monument blocks are
 *    held by faces or edge claims; the night market and the car park plan after
 *    the weekend modules, so there is nothing of theirs to avoid yet.
 * With `blocks: 2` a site also needs a neighbour: an unclaimed qualifying block
 * across a plain street (not a route, bridge, shortcut or claimed street) from the
 * first, which is `along` when it fronts the same route street (the next block down
 * it) and a `cross` neighbour (behind or beside) otherwise.
 *
 * Order: frontage on every route first, then the longer frontage, then the nearer to
 * the start gantry (the circuit's start line, else any route's start; the keep-off
 * already holds the grid clear), then face id. A worker takes the first site it can fit its
 * layout on and claims its faces (and, to keep the night market and lane closures
 * off the street, the frontage edges) through ctx.addArea / ctx.claims.
 *
 * Opening a block's frontage: the parks' way is AreaBuild.openings and exclusions
 * (park.ts, monument.ts push the block ring into both; blocks.ts removes the city
 * frontage walls whose inside probe falls in an opening and keeps buildings out of
 * an exclusion). That is not a function anywhere, so `openFrontage` is the shared
 * form of the two pushes.
 *
 * The LOST rule every set piece must satisfy (sim/race.ts updateLost): a racing car more
 * than LOST.lateral (60 m) from the route corridor for LOST.time (5 s) is reset to the
 * road, and instantly beyond LOST.farLateral (160 m). A route's car parks and a harbor's
 * quay cut have their own exemptions (carPark/progress.ts onCarPark, harborCut.ts
 * onQuayCut: a car on them is not lost); a weekend area's kind is in CORRIDOR_AREAS
 * (types.ts), and while a car is inside the area's polygon it counts as on the corridor
 * (the lost timer only runs down). So the polygon must cover every drivable part of the
 * set piece, and a part outside it that is more than 60 m from the route's streets is a
 * reset waiting to happen; a one or two block site beside the route keeps all of it well
 * inside 60 m anyway.
 */
import { ROUTE } from '../config';
import { computeMouths } from '../blocks';
import type { BlockFace } from '../blocks';
import type { RoadGraph } from '../roadGraph';
import { chainOf } from '../roadGraph';
import { circuitStart } from '../route';
import type { Vec2 } from '../../sim/math';
import type { AreaBuild, PlanContext } from './types';
import { convexRing } from './park';
import { pointInPolygon, polygonBounds, polygonCentroid } from './geom';
import { edgeFaces, junctionReach, raceStreets, siteClear, siteHazards } from './structures';
import type { SiteHazards } from './structures';

/** How far (m) a site's ring keeps from the El, the highway, the channel, slopes, roundabout rings and bluffs. */
export const HAZARD_MARGIN = 6;
/** Default distance (m) along a route a site's frontage keeps from its start and finish: the grid, the gantry and the crowds. */
export const START_FINISH_CLEAR = 150;
/** Spacing (m) of the ring samples checked against the hazards. */
const RING_STEP = 20;

/** One street a route drives along a candidate block. */
export interface FrontEdge {
  /** Graph edge id. */
  edge: number;
  /** Routes (bit i set for PlannedEvent.routes[i]: 0 the circuit, 1 the sprint) that drive it clear of their start and finish. */
  routes: number;
  /** Length (m) of the block's sidewalk line straight along this edge. */
  length: number;
  /** The stretch (m) of the edge between its junctions' closures and corner rails; 0 when they meet. */
  clear: number;
}

/** A second block of a two block site. */
export interface SiteNeighbour {
  face: BlockFace;
  /** The plain street edge between the two blocks. */
  via: number;
  /** The neighbour fronts the same route street as the first block (the next block down it); false: behind or beside. */
  along: boolean;
  /** The neighbour's own route frontage (m), 0 for a `cross` one, and the routes (bit mask) that drive it. */
  frontage: number;
  routes: number;
}

/** A candidate site: a block that fronts the race. */
export interface FrontageSite {
  face: BlockFace;
  /** The block's streets that a route drives, longest frontage first. */
  edges: FrontEdge[];
  /** Union of the edges' routes (bit mask). */
  routes: number;
  /** Total length (m) of the block's sidewalk line along the route streets. */
  frontage: number;
  /** Which side of the route's travel (left of travel (tx, tz) is (-tz, tx)) the block lies, on its longest route street. */
  side: 'left' | 'right';
  centroid: Vec2;
  /** The ring is convex (park.ts convexRing): the shapes that fit a block ring in one piece want it. */
  convex: boolean;
  /** Straight line distance (m) from the centroid to the nearest start gantry. */
  startDist: number;
  /** Qualifying neighbours, best first (along before cross, then longer frontage, then id); empty unless `blocks` is 2. */
  neighbours: SiteNeighbour[];
}

export interface SiteOptions {
  /** Least route frontage (m) of the first block. */
  minFrontage: number;
  /** 1: any qualifying block; 2: only blocks that also have a neighbour for a two block site. */
  blocks: 1 | 2;
  /** Distance (m) along a route the frontage keeps from its start and finish (default START_FINISH_CLEAR). */
  keepOffStartFinish?: number;
}

/** Open a block's frontage for an area: no city frontage walls, no buildings inside the ring (what the parks do). */
export function openFrontage(b: AreaBuild, ring: Vec2[]): void {
  b.exclusions.push(ring);
  b.openings.push(ring);
}

/** A route's driving line: edge i joins nodes[i] and nodes[i + 1]; `marks` are the arc lengths of its start and finish lines. */
interface RouteLine {
  edges: number[];
  cum: number[];
  total: number;
  closed: boolean;
  marks: number[];
  /** Where the start line is. */
  start: Vec2;
  nodes: number[];
}

function routeLine(g: RoadGraph, r: { nodes: number[]; edges: number[]; closed: boolean }): RouteLine {
  const m = r.edges.length;
  const cum = [0];
  for (let i = 0; i < m; i++) {
    const a = g.nodes[r.nodes[i]];
    const b = g.nodes[r.nodes[(i + 1) % r.nodes.length]];
    const len = r.edges[i] >= 0 ? g.edges[r.edges[i]].length : Math.hypot(b.x - a.x, b.z - a.z);
    cum.push(cum[i] + len);
  }
  const total = cum[m];
  let marks: number[];
  let start: Vec2;
  if (r.closed && m > 0) {
    const cs = circuitStart(g, r.nodes);
    marks = [cum[cs.index] + cs.t * (cum[cs.index + 1] - cum[cs.index])];
    const a = g.nodes[r.nodes[cs.index]];
    const b = g.nodes[r.nodes[(cs.index + 1) % r.nodes.length]];
    start = { x: a.x + (b.x - a.x) * cs.t, z: a.z + (b.z - a.z) * cs.t };
  } else {
    marks = [0, Math.max(0, total - ROUTE.sprintFinishOffset)];
    const a = g.nodes[r.nodes[0]];
    start = { x: a.x, z: a.z };
  }
  return { edges: r.edges, cum, total, closed: r.closed, marks, start, nodes: r.nodes };
}

/** Along-route distance (m) from the stretch [lo, hi] to the arc position s (around the lap on a circuit). */
function gapAlong(line: RouteLine, lo: number, hi: number, s: number): number {
  const direct = (at: number) => (at < lo ? lo - at : at > hi ? at - hi : 0);
  return line.closed ? Math.min(direct(s), direct(s + line.total), direct(s - line.total)) : direct(s);
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/** Do two block outlines overlap (a vertex of either inside the other)? Cheap and enough for the held polygons. */
function overlaps(a: Vec2[], b: Vec2[]): boolean {
  const ba = polygonBounds(a);
  const bb = polygonBounds(b);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxZ < bb.minZ || bb.maxZ < ba.minZ) return false;
  return a.some((p) => pointInPolygon(p.x, p.z, b)) || b.some((p) => pointInPolygon(p.x, p.z, a));
}

/**
 * Candidate sites for a weekend special, best first (see the header). Empty without an event
 * (a planner run outside planRoads) or when no block qualifies.
 */
export function routeFrontageSites(ctx: PlanContext, opts: SiteOptions): FrontageSite[] {
  const event = ctx.event;
  if (!event || !event.routes.length) return [];
  const g = ctx.graph;
  const keepOff = opts.keepOffStartFinish ?? START_FINISH_CLEAR;
  const lines = event.routes.map((r) => routeLine(g, r));
  const allRoutes = (1 << lines.length) - 1;
  const ends = raceStreets(ctx).ends;
  const mouths = computeMouths(g, ctx.sectors());
  const hazards = siteHazards(ctx);
  const faces = ctx.faces();
  const sharing = edgeFaces(faces);
  const faceById = new Map<number, BlockFace>(faces.map((f) => [f.id, f]));

  // Per edge: the routes that drive it clear of the start and finish, and the first (route, index) that does, for the side.
  const driven = new Map<number, { routes: number; route: number; index: number }>();
  const onAnyRoute = new Set<number>();
  lines.forEach((line, ri) => {
    for (let i = 0; i < line.edges.length; i++) {
      const e = line.edges[i];
      if (e < 0) continue;
      onAnyRoute.add(e);
      if (ends.has(e)) continue;
      const lo = line.cum[i];
      const hi = line.cum[i + 1];
      if (line.marks.some((s) => gapAlong(line, lo, hi, s) < keepOff)) continue;
      const d = driven.get(e);
      if (d) d.routes |= 1 << ri;
      else driven.set(e, { routes: 1 << ri, route: ri, index: i });
    }
  });

  const edgeBad = (e: number): boolean => {
    const ed = g.edges[e];
    return !!ed.shortcut || !!ed.bridge || ed.crossing !== undefined || ctx.claims.edge.has(e);
  };

  const plainCache = new Map<number, boolean>();
  /** An interior, unclaimed block with plain streets round it, clear of every hazard and of the held polygons. */
  const plain = (f: BlockFace): boolean => {
    let ok = plainCache.get(f.id);
    if (ok !== undefined) return ok;
    ok = !f.outer && !ctx.claims.face.has(f.id) && !f.edges.some(edgeBad) && !f.corners.some((c) => g.nodes[c.node].ring) && !(ctx.keepOut ?? []).some((p) => overlaps(f.ring, p)) && ringClear(f, hazards);
    plainCache.set(f.id, ok);
    return ok;
  };

  /** The block's streets that a route drives, and the frontage along them. */
  const frontOf = (f: BlockFace): { edges: FrontEdge[]; routes: number; frontage: number } => {
    const out: FrontEdge[] = [];
    let routes = 0;
    let frontage = 0;
    for (const e of [...new Set(f.edges)].sort((p, q) => p - q)) {
      const d = driven.get(e);
      if (!d) continue;
      let length = 0;
      for (let i = 0; i < f.ring.length; i++) if (f.segEdge[i] === e) length += dist(f.ring[i], f.ring[(i + 1) % f.ring.length]);
      if (length <= 0) continue;
      const ed = g.edges[e];
      const clear = Math.max(0, ed.length - junctionReach(g, mouths, ed, ed.a) - junctionReach(g, mouths, ed, ed.b));
      out.push({ edge: e, routes: d.routes, length, clear });
      routes |= d.routes;
      frontage += length;
    }
    out.sort((p, q) => q.length - p.length || p.edge - q.edge);
    return { edges: out, routes, frontage };
  };

  const sites: FrontageSite[] = [];
  for (const f of faces) {
    if (f.outer || ctx.claims.face.has(f.id)) continue;
    const front = frontOf(f);
    if (!front.edges.length || front.frontage < opts.minFrontage || !plain(f)) continue;
    const centroid = polygonCentroid(f.ring);
    const neighbours: SiteNeighbour[] = [];
    if (opts.blocks === 2) {
      const frontStreet = new Set<number>();
      for (const fe of front.edges) for (const e of chainOf(g, fe.edge).edges) frontStreet.add(e);
      for (const x of [...new Set(f.edges)].sort((p, q) => p - q)) {
        // The street between the two blocks must be plain: no route, bridge, shortcut, claim or channel floor.
        if (onAnyRoute.has(x) || edgeBad(x) || g.edges[x].kind === 'channel') continue;
        for (const id of sharing.get(x) ?? []) {
          const b = faceById.get(id);
          if (!b || b.id === f.id || neighbours.some((n) => n.face.id === b.id) || !plain(b)) continue;
          const bf = frontOf(b);
          const along = bf.edges.length > 0 && b.edges.some((e) => frontStreet.has(e) && driven.has(e));
          neighbours.push({ face: b, via: x, along, frontage: along ? bf.frontage : 0, routes: along ? bf.routes : 0 });
        }
      }
      if (!neighbours.length) continue;
      neighbours.sort((p, q) => Number(q.along) - Number(p.along) || q.frontage - p.frontage || p.face.id - q.face.id);
    }
    const top = front.edges[0];
    const d = driven.get(top.edge)!;
    const line = lines[d.route];
    const a = g.nodes[line.nodes[d.index]];
    const b = g.nodes[line.nodes[(d.index + 1) % line.nodes.length]];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const tx = (b.x - a.x) / len;
    const tz = (b.z - a.z) / len;
    const side = (centroid.x - (a.x + b.x) / 2) * -tz + (centroid.z - (a.z + b.z) / 2) * tx > 0 ? 'left' : 'right';
    sites.push({
      face: f,
      edges: front.edges,
      routes: front.routes,
      frontage: front.frontage,
      side,
      centroid,
      convex: convexRing(f.ring),
      startDist: Math.min(...lines.map((l) => dist(l.start, centroid))),
      neighbours,
    });
  }
  const both = (s: FrontageSite) => (s.routes === allRoutes ? 1 : 0);
  return sites.sort((p, q) => both(q) - both(p) || q.frontage - p.frontage || p.startDist - q.startDist || p.face.id - q.face.id);
}

/** The block's ring, sampled every RING_STEP m, and its centroid are all HAZARD_MARGIN clear. */
function ringClear(f: BlockFace, hz: SiteHazards): boolean {
  const c = polygonCentroid(f.ring);
  if (!siteClear(hz, c.x, c.z, HAZARD_MARGIN)) return false;
  for (let i = 0; i < f.ring.length; i++) {
    const p = f.ring[i];
    const q = f.ring[(i + 1) % f.ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / RING_STEP));
    for (let k = 0; k < n; k++) if (!siteClear(hz, p.x + ((q.x - p.x) * k) / n, p.z + ((q.z - p.z) * k) / n, HAZARD_MARGIN)) return false;
  }
  return true;
}
