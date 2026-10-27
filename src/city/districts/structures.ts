/**
 * Site rules shared by the structures built over and around streets: the
 * tunnels (tunnel.ts) and the overpasses (overpass.ts). Pure and
 * deterministic.
 *
 *  - A street-local frame: origin on a street's centerline, u along it, v
 *    across it along (-uz, ux), so a bore or a deck is a few numbers.
 *  - How far a junction reaches along each street that meets it: its curbs
 *    and sidewalk corners, a route closure standing ROUTE.barrierSetbackHeadOn
 *    into the street, and the corner rails that run ROUTE.railReach past the
 *    corner along the back of the sidewalk. Which streets a route closes or
 *    turns at is only known per race, so a structure keeps clear of every
 *    junction's full reach, like the El's columns (subway.ts).
 *  - What a structure keeps away from: the river channel (bridges, ramps and
 *    banks), the El (its deck and columns), the elevated highway (its deck,
 *    columns and ramps), hill slopes (their grades would
 *    tilt a bore or a deck), roundabouts (their rings are wider than their
 *    streets) and the other structures.
 */
import { CITY, ROUTE } from '../config';
import type { Chain, RoadEdge, RoadGraph, RoadNode } from '../roadGraph';
import { chainCum, chainOf, isBendNode } from '../roadGraph';
import type { EdgeMouths } from '../blocks';
import { Vec2, distToSegment, sqrt } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Area, PlanContext } from './types';
import { HillShape, plateauDistance, shapeOf } from './hills';
import { riverCenter } from './river';
import { bluffFootprint } from './bluff';
import { distToPolygonEdge, pointInPolygon, polygonBounds } from './geom';
import { NodeHeap } from '../graphSearch';
import { circuitStart, routeRuns } from '../route';

/** Street local frame: origin on the centerline, u along the street (unit), v across it along (-uz, ux) (the right of travel along +u, yaw convention of sim/math). */
export interface Frame {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
}

/** (u, v) of a world point in a frame. */
export function toLocal(f: Frame, x: number, z: number): { u: number; v: number } {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return { u: dx * f.ux + dz * f.uz, v: -dx * f.uz + dz * f.ux };
}

/** World point at (u, v) in a frame. */
export function toWorld(f: Frame, u: number, v: number): Vec2 {
  return { x: f.cx + f.ux * u - f.uz * v, z: f.cz + f.uz * u + f.ux * v };
}

/** Frame at distance s along edge e from its node a. */
export function edgeFrame(g: RoadGraph, e: RoadEdge, s: number): Frame {
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  return { cx: a.x + ux * s, cz: a.z + uz * s, ux, uz };
}

/**
 * A street between two junctions as a run: its chain (roadGraph.ts), the polyline of its nodes
 * and the distance along it at each (m). Structures that need a stretch of street longer than one
 * piece (a bore, a lane closure) measure along the run and stand on a straight chord of it.
 */
export interface StreetRun {
  chain: Chain;
  pts: Vec2[];
  cum: number[];
  length: number;
}

export function streetRun(g: RoadGraph, chain: Chain): StreetRun {
  return { chain, pts: chain.nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z })), cum: chainCum(g, chain), length: chain.length };
}

/** Index of the piece of a run that holds distance s along it. */
export function runPiece(run: StreetRun, s: number): number {
  let i = 0;
  while (i + 1 < run.chain.edges.length && run.cum[i + 1] <= s) i++;
  return i;
}

/** Point at distance s along a run. */
function runPoint(run: StreetRun, s: number): Vec2 {
  const i = runPiece(run, s);
  const a = run.pts[i];
  const b = run.pts[i + 1];
  const len = run.cum[i + 1] - run.cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - run.cum[i]) / len));
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * A straight frame on the chord of a run between distances s0 and s1 along it (origin at the
 * chord's middle, u along the chord), and how far the street strays from that chord between them
 * (m): the most any bend node in the span is off the chord. A structure built in the frame is
 * straight; its site is good when the stray is within what its walkways and walls allow.
 */
export function chordFrame(run: StreetRun, s0: number, s1: number): { f: Frame; stray: number } {
  const p0 = runPoint(run, s0);
  const p1 = runPoint(run, s1);
  const len = sqrt((p1.x - p0.x) ** 2 + (p1.z - p0.z) ** 2) || 1;
  const ux = (p1.x - p0.x) / len;
  const uz = (p1.z - p0.z) / len;
  let stray = 0;
  for (let i = 1; i + 1 < run.pts.length; i++) {
    if (run.cum[i] <= s0 || run.cum[i] >= s1) continue;
    const p = run.pts[i];
    const d = (p.x - p0.x) * -uz + (p.z - p0.z) * ux;
    if (d < 0 ? -d > stray : d > stray) stray = d < 0 ? -d : d;
  }
  return { f: { cx: (p0.x + p1.x) / 2, cz: (p0.z + p1.z) / 2, ux, uz }, stray };
}

/** Extra room kept past a junction's closure line (m), as for the El's columns. */
const CLOSURE_GAP = 3.5;
/** Extra room kept past the end of a corner rail (m): its rounded corner and fillet. */
const RAIL_GAP = 3;

/**
 * Distance along edge e (m) from node `at` (e.a or e.b) that its junction
 * reaches: the farther sidewalk corner of the mouth, plus whichever of a
 * head-on closure or a corner rail reaches further into the street.
 */
export function junctionReach(g: RoadGraph, mouths: EdgeMouths[], e: RoadEdge, at: number): number {
  // A bend node is not a junction: the street simply goes on through it (roadGraph.ts).
  if (isBendNode(g, at)) return 0;
  const n = g.nodes[at];
  const o = g.nodes[at === e.a ? e.b : e.a];
  const len = sqrt((o.x - n.x) ** 2 + (o.z - n.z) ** 2) || 1;
  const dx = (o.x - n.x) / len;
  const dz = (o.z - n.z) / len;
  const m = mouths[e.id];
  const pts = at === e.a ? [m.aP.outer, m.aN.outer] : [m.bP.outer, m.bN.outer];
  let corner = 0;
  for (const p of pts) corner = Math.max(corner, (p.x - n.x) * dx + (p.z - n.z) * dz);
  // The widest street meeting here sets how far its curbs come out too.
  let half = 0;
  for (const id of n.edges) half = Math.max(half, g.edges[id].width / 2 + g.edges[id].sidewalk);
  return Math.max(corner, half) + Math.max(ROUTE.barrierSetbackHeadOn + CLOSURE_GAP, ROUTE.railReach + RAIL_GAP);
}

/** Faces on each side of every edge (interior faces only), from the block faces. */
export function edgeFaces(faces: { id: number; outer: boolean; edges: number[] }[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const f of faces) {
    if (f.outer) continue;
    for (const e of new Set(f.edges)) {
      let list = out.get(e);
      if (!list) out.set(e, (list = []));
      list.push(f.id);
    }
  }
  return out;
}

/** Everything a structure keeps clear of, gathered once per plan. */
export interface SiteHazards {
  rivers: Area[];
  /** The El's path sampled every few meters, with its deck half width. */
  el: Vec2[];
  elHalf: number;
  hills: HillShape[];
  rings: RoadNode[];
  /** Footprints of the structures planned so far (tunnels and overpasses): circles. */
  taken: { x: number; z: number; r: number }[];
  /** Bluffs' whole footprints (bluff.ts): their own ground, ramps and the El at grade. */
  bluffs?: Vec2[][];
  /** The elevated highway's deck outline and ramps (districts/highway/). */
  highway?: Vec2[][];
}

export function siteHazards(ctx: PlanContext): SiteHazards {
  const el: Vec2[] = [];
  for (const a of ctx.areas) {
    if (a.kind !== 'subway') continue;
    const p = a.path;
    for (let i = 0; i + 1 < p.length; i++) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[i + 1].x - p[i].x, p[i + 1].z - p[i].z) / 6));
      for (let k = 0; k < n; k++) el.push({ x: p[i].x + ((p[i + 1].x - p[i].x) * k) / n, z: p[i].z + ((p[i + 1].z - p[i].z) * k) / n });
    }
    if (p.length) el.push(p[p.length - 1]);
  }
  const taken: SiteHazards['taken'] = [];
  for (const a of ctx.areas) {
    if (a.kind === 'tunnel') taken.push({ x: a.params.cx, z: a.params.cz, r: a.params.reach });
    if (a.kind === 'overpass') takePath(taken, a.path, a.params.reach);
  }
  return {
    rivers: ctx.areas.filter((a) => a.kind === 'river'),
    el,
    elHalf: CITY.districts.subway.deckWidth / 2,
    hills: ctx.areas.filter((a) => a.kind === 'hills').map(shapeOf),
    rings: ctx.graph.nodes.filter((n) => n.ring),
    taken,
    bluffs: ctx.areas.filter((a) => a.kind === 'bluff').map((a) => bluffFootprint(a)),
    highway: ctx.areas.filter((a) => a.kind === 'highway' && a.polygon.length >= 3).map((a) => a.polygon),
  };
}

/** Record a structure's path (a deck line) as circles of radius r every few meters. */
export function takePath(taken: SiteHazards['taken'], path: readonly Vec2[], r: number): void {
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    taken.push({ x: p.x, z: p.z, r });
    if (i + 1 === path.length) break;
    const q = path[i + 1];
    const n = Math.floor(Math.hypot(q.x - p.x, q.z - p.z) / 8);
    for (let k = 1; k < n; k++) taken.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n, r });
  }
}

/**
 * Is (x, z) at least `margin` m clear of the river channel (its top edge), the
 * El's deck, the highway's deck and ramps, every hill's slope, every
 * roundabout's ring and the structures planned so far?
 */
export function siteClear(hz: SiteHazards, x: number, z: number, margin: number): boolean {
  for (const r of hz.rivers) {
    if (x < r.params.x0 - margin || x > r.params.x1 + margin) continue;
    if (Math.abs(z - riverCenter(r.params, x)) < r.params.top + margin) return false;
  }
  for (const p of hz.el) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (hz.elHalf + margin) ** 2) return false;
  for (const s of hz.hills) if (plateauDistance(s, x, z).d < s.w + margin) return false;
  for (const n of hz.rings) if ((n.x - x) ** 2 + (n.z - z) ** 2 < (n.ring!.outer + CITY.sidewalk + margin) ** 2) return false;
  for (const t of hz.taken) if ((t.x - x) ** 2 + (t.z - z) ** 2 < (t.r + margin) ** 2) return false;
  for (const p of hz.bluffs ?? []) if (nearPolygon(x, z, p, margin)) return false;
  for (const p of hz.highway ?? []) if (nearPolygon(x, z, p, margin)) return false;
  return true;
}

/** Outline bounds of the hazard polygons (a hazard set keeps its outlines as they were taken). */
const outlineBounds = new WeakMap<Vec2[], { minX: number; minZ: number; maxX: number; maxZ: number }>();

/** Whether (x, z) is inside the polygon or within `margin` of its edge; a point beyond the bounds widened by the margin is neither. */
function nearPolygon(x: number, z: number, p: Vec2[], margin: number): boolean {
  let bb = outlineBounds.get(p);
  if (!bb) outlineBounds.set(p, (bb = polygonBounds(p)));
  if (x < bb.minX - margin - 1e-6 || x > bb.maxX + margin + 1e-6 || z < bb.minZ - margin - 1e-6 || z > bb.maxZ + margin + 1e-6) return false;
  return pointInPolygon(x, z, p) || distToPolygonEdge(x, z, p) < margin;
}

/** The pieces of edge `eid`'s street (every edge of its chain through the bend nodes, roadGraph.ts), as a set: what a structure on that street skips when it checks the other streets. */
export function streetEdges(g: RoadGraph, eid: number): Set<number> {
  return new Set(chainOf(g, eid).edges);
}

/** Least distance (m) from (x, z) to the corridor (road plus sidewalks) of any edge but those in `skip` (an edge id or a set of them), negative inside one. */
export function corridorGap(g: RoadGraph, x: number, z: number, skip: number | ReadonlySet<number> = -1): number {
  let best = Infinity;
  for (const e of g.edges) {
    if (typeof skip === 'number' ? e.id === skip : skip.has(e.id)) continue;
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const w = e.width / 2 + e.sidewalk;
    // The segment is at least as far as its bounds (Chebyshev under Euclid): too far to beat `best` is skipped.
    const ddx = Math.max(Math.min(a.x, b.x) - x, x - Math.max(a.x, b.x), 0);
    const ddz = Math.max(Math.min(a.z, b.z) - z, z - Math.max(a.z, b.z), 0);
    if (Math.max(ddx, ddz) - w > best + 1e-6) continue;
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - w;
    if (d < best) best = d;
  }
  for (const n of g.nodes) {
    if (!n.ring) continue;
    const d = sqrt((x - n.x) ** 2 + (z - n.z) ** 2) - (n.ring.outer + CITY.sidewalk);
    if (d < best) best = d;
  }
  return best;
}

/** Ordering weight every candidate street keeps on top of its traffic share, so quiet streets still get a structure now and then. */
export const TRAFFIC_FLOOR = 0.015;
/** Ordering weight a street of one of the seed's race routes gets on top (PlanContext.event): it outranks any traffic share. */
export const ON_ROUTE = 1;

/**
 * The race routes as the planners see them, when they run after the topology
 * hook (PlanContext.event): the edges both routes use, and the edges where a
 * race starts or finishes. Structures keep off the latter: a start gantry,
 * its grid and spectators belong in the open, not in a bore or under a deck.
 * Without an event (a planner run on its own) both sets are empty and the
 * traffic estimate alone guides placement.
 */
export function raceStreets(ctx: PlanContext): { route: Set<number>; ends: Set<number> } {
  const route = new Set<number>();
  const ends = new Set<number>();
  const g = ctx.graph;
  for (const r of ctx.event?.routes ?? []) {
    const edges = r.edges.filter((e) => e >= 0);
    for (const e of edges) route.add(e);
    if (!edges.length) continue;
    if (r.closed) {
      // The circuit starts and finishes mid-way along its longest street (route.ts circuitStart): the
      // whole run of pieces through bend nodes is the start straight.
      for (const e of circuitStart(g, r.nodes).run.edges) ends.add(e);
    } else {
      // A sprint's grid is on its first street (its first run of pieces); its finish line
      // ROUTE.sprintFinishOffset before the end.
      for (const e of routeRuns(g, r.nodes, edges, false)[0].edges) ends.add(e);
      let total = 0;
      for (const e of edges) total += g.edges[e].length;
      const lo = total - ROUTE.sprintFinishOffset - 2 * ROUTE.sprintFinishNodeClear - 20;
      const hi = total - ROUTE.sprintFinishOffset + 20;
      let s = 0;
      for (const e of edges) {
        const s1 = s + g.edges[e].length;
        if (s1 > lo && s < hi) ends.add(e);
        s = s1;
      }
    }
  }
  return { route, ends };
}

/** Route finder's kind bias on edge weights (route.ts randomWeights), mirrored for the traffic estimate. */
const KIND_BIAS: Partial<Record<RoadEdge['kind'], number>> = { boulevard: 0.7, diagonal: 0.75, avenue: 0.85, alley: 0.78, channel: ROUTE.channelBias };
/** Shortest path trees grown, and targets walked back per tree, for the traffic estimate. */
const TRAFFIC_SOURCES = 48;
const TRAFFIC_TARGETS = 6;

/**
 * Share of race-like trips (0..1) that use each edge. The routes are picked
 * before the structures are planned, but only planRoads knows them, so the
 * planners estimate where races run instead: shortest paths between random
 * node pairs 290 m or more apart, on edge weights randomized and biased by
 * kind exactly as the route finder does it (route.ts randomWeights). Edges
 * many trips share are the ones circuits and sprints keep coming back to.
 * Uses its own random stream, so it never moves any planner's choices.
 */
export function routeTraffic(g: RoadGraph, seed: number): Float64Array {
  const rng = new Rng(deriveSeed(seed, 'structures:traffic'));
  const n = g.nodes.length;
  const use = new Float64Array(g.edges.length);
  const w = new Float64Array(g.edges.length);
  const dist = new Float64Array(n);
  const via = new Int32Array(n);
  const done = new Uint8Array(n);
  let trips = 0;
  for (let k = 0; k < TRAFFIC_SOURCES; k++) {
    g.edges.forEach((e, i) => (w[i] = e.shortcut ? Infinity : e.length * (KIND_BIAS[e.kind] ?? 1) * rng.range(0.45, 1.9)));
    const src = rng.int(0, n - 1);
    dist.fill(Infinity);
    via.fill(-1);
    done.fill(0);
    dist[src] = 0;
    // Heap Dijkstra (graphSearch.ts NodeHeap): the bend nodes triple the graph, a linear scan per step is too slow.
    const heap = new NodeHeap();
    const popped = { key: 0 };
    heap.push(0, src);
    while (heap.size) {
      const u = heap.pop(popped);
      if (done[u] || popped.key > dist[u]) continue;
      done[u] = 1;
      for (const eid of g.nodes[u].edges) {
        const e = g.edges[eid];
        const v = e.a === u ? e.b : e.a;
        const nd = dist[u] + w[eid];
        if (nd < dist[v]) {
          dist[v] = nd;
          via[v] = eid;
          heap.push(nd, v);
        }
      }
    }
    const S = g.nodes[src];
    for (let t = 0; t < TRAFFIC_TARGETS; t++) {
      const dst = rng.int(0, n - 1);
      const D = g.nodes[dst];
      if ((D.x - S.x) ** 2 + (D.z - S.z) ** 2 < 290 * 290 || via[dst] < 0) continue;
      trips++;
      for (let v = dst; v !== src && via[v] >= 0; ) {
        const e = g.edges[via[v]];
        use[e.id] += 1;
        v = e.a === v ? e.b : e.a;
      }
    }
  }
  if (trips) for (let i = 0; i < use.length; i++) use[i] /= trips;
  return use;
}

/**
 * Ids in a seeded order biased by weight: each draws a key w * u (u uniform)
 * and the largest keys come first, so a weight 4 street usually but not
 * always beats a weight 1 one. Ids with no weight are dropped.
 */
export function weightedOrder(ids: number[], weight: (id: number) => number, rng: Rng): number[] {
  const keyed = ids.map((id) => ({ id, key: weight(id) * rng.next() }));
  keyed.sort((a, b) => b.key - a.key || a.id - b.id);
  return keyed.filter((k) => k.key > 0).map((k) => k.id);
}
