/**
 * Picks a closed circuit and a point to point sprint through the road graph,
 * places checkpoints and a start grid, lists the route's shortcuts (carved
 * into the city for it, see districts/alley.ts) and closes off side streets.
 */
import { CITY, ROUTE } from './config';
import { RoadGraph, edgeBetween, otherNode } from './roadGraph';
import { EdgeMouths, Sector, Wall, computeMouths, computeSectors, makeWall } from './blocks';
import { Rng, deriveSeed } from '../sim/prng';
import { shortcutSpan } from './districts/alley';
import { DEG, Vec2, abs, atan2, clamp, cos, distToSegment, lineIntersectT, sign, sin, sqrt, wrapAngle, yawOf } from '../sim/math';

export type RouteKind = 'circuit' | 'sprint';

export interface GridSlot {
  x: number;
  z: number;
  yaw: number;
  s: number;
}

export interface Route {
  kind: RouteKind;
  closed: boolean;
  /** Graph nodes in driving order. Circuits do not repeat the first node at the end. */
  nodes: number[];
  /** Graph edges in driving order. */
  edges: number[];
  /** Driving polyline. For circuits points[last] == points[0]. */
  points: Vec2[];
  /** Cumulative distance at each point. */
  cum: number[];
  /** Road width of each polyline segment. */
  segWidth: number[];
  length: number;
  startS: number;
  finishS: number;
  checkpoints: number[];
  grid: GridSlot[];
  closedStreets: { edge: number; node: number }[];
  /**
   * Real shortcuts of this route: back alley edges with both ends on it that
   * save distance (see shortcutSpan), entry (a) first in driving order. Every
   * other shortcut edge at a route junction is closed off like a side street.
   */
  shortcuts: RouteShortcut[];
  tightCorners: number;
  sweepers: number;
}

export interface RouteShortcut {
  /** Graph edge (a back alley flagged shortcut). */
  edge: number;
  /** Entry (on the route at sIn) and exit (at sOut) in world metres. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Route distance at the entry and the exit (m); on circuits sOut may wrap past the start (sOut < sIn). */
  sIn: number;
  sOut: number;
  /** Length of the alley itself (m). */
  length: number;
}

export interface RouteSample {
  x: number;
  z: number;
  /** Unit tangent. */
  tx: number;
  tz: number;
  seg: number;
}

function dijkstra(g: RoadGraph, from: number, to: number, weight: Float64Array, blockedNode: Uint8Array, blockedEdge: Uint8Array): number[] | null {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) return null;
    if (u === to) break;
    done[u] = 1;
    for (const eid of g.nodes[u].edges) {
      if (blockedEdge[eid]) continue;
      const v = otherNode(g.edges[eid], u);
      if (blockedNode[v] && v !== to) continue;
      const nd = dist[u] + weight[eid];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }
  const path: number[] = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  path.reverse();
  return path[0] === from ? path : null;
}

/** Signed turn angle at b for the path a -> b -> c. */
function turnAngle(g: RoadGraph, a: number, b: number, c: number): number {
  const A = g.nodes[a];
  const B = g.nodes[b];
  const C = g.nodes[c];
  const d1x = B.x - A.x;
  const d1z = B.z - A.z;
  const d2x = C.x - B.x;
  const d2z = C.z - B.z;
  return atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
}

interface CornerStats {
  tight: number;
  sweepers: number;
  maxTurn: number;
}

function cornerStats(g: RoadGraph, nodes: number[], closed: boolean): CornerStats {
  let tight = 0;
  let sweepers = 0;
  let maxTurn = 0;
  const n = nodes.length;
  const from = closed ? 0 : 1;
  const to = closed ? n : n - 1;
  for (let i = from; i < to; i++) {
    const a = nodes[(i - 1 + n) % n];
    const b = nodes[i];
    const c = nodes[(i + 1) % n];
    const t = abs(turnAngle(g, a, b, c)) / DEG;
    maxTurn = Math.max(maxTurn, t);
    if (t >= ROUTE.tightDeg) tight++;
    else if (t >= ROUTE.sweeperMinDeg && t <= ROUTE.sweeperMaxDeg) sweepers++;
  }
  return { tight, sweepers, maxTurn };
}

function pathLength(g: RoadGraph, nodes: number[], closed: boolean): number {
  let len = 0;
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) {
    const a = g.nodes[nodes[i]];
    const b = g.nodes[nodes[(i + 1) % nodes.length]];
    len += sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
  }
  return len;
}

function randomWeights(g: RoadGraph, rng: Rng): Float64Array {
  const w = new Float64Array(g.edges.length);
  g.edges.forEach((e, i) => {
    // Favor the wide fast roads a little so routes have long straights, and raceway alleys so
    // more races squeeze through one.
    const kindBias = e.kind === 'boulevard' ? 0.7 : e.kind === 'diagonal' ? 0.75 : e.kind === 'avenue' ? 0.85 : e.kind === 'alley' ? 0.78 : 1;
    const r = rng.range(0.45, 1.9);
    // Back alley shortcuts are never part of a route (Infinity is never relaxed).
    w[i] = e.shortcut ? Infinity : e.length * kindBias * r;
  });
  return w;
}

function score(stats: CornerStats, len: number, minLen: number, maxLen: number): number {
  let s = 0;
  if (len < minLen) s -= (minLen - len) / 100;
  if (len > maxLen) s -= (len - maxLen) / 100;
  s -= Math.max(0, ROUTE.minTightCorners - stats.tight) * 2;
  s -= Math.max(0, ROUTE.minSweepers - stats.sweepers) * 2;
  s -= Math.max(0, stats.maxTurn - ROUTE.maxTurnDeg) * 10;
  return s;
}

/** `variant` > 0 draws an alternative circuit from its own random stream (planRoads uses it when a circuit has no room for a shortcut). */
export function findCircuitNodes(g: RoadGraph, seed: number, variant = 0): number[] {
  const rng = new Rng(deriveSeed(seed, variant ? `circuit:${variant}` : 'circuit'));
  let best: number[] | null = null;
  let bestScore = -Infinity;
  const n = g.nodes.length;
  for (let attempt = 0; attempt < ROUTE.maxAttempts; attempt++) {
    const w = randomWeights(g, rng);
    const a = rng.int(0, n - 1);
    const b = rng.int(0, n - 1);
    const A = g.nodes[a];
    const B = g.nodes[b];
    const sep = sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2);
    if (sep < 290 || sep > 940) continue;
    const none = new Uint8Array(n);
    const p1 = dijkstra(g, a, b, w, none, new Uint8Array(g.edges.length));
    if (!p1 || p1.length < 3) continue;
    const blockedN = new Uint8Array(n);
    for (let i = 1; i < p1.length - 1; i++) blockedN[p1[i]] = 1;
    const blockedE = new Uint8Array(g.edges.length);
    for (let i = 0; i + 1 < p1.length; i++) blockedE[edgeBetween(g, p1[i], p1[i + 1])] = 1;
    const p2 = dijkstra(g, b, a, w, blockedN, blockedE);
    if (!p2 || p2.length < 3) continue;
    const cycle = p1.concat(p2.slice(1, -1));
    const len = pathLength(g, cycle, true);
    const stats = cornerStats(g, cycle, true);
    if (stats.maxTurn > ROUTE.maxTurnDeg && best) continue;
    const sc = score(stats, len, ROUTE.circuitMinLength, ROUTE.circuitMaxLength);
    if (sc > bestScore) {
      bestScore = sc;
      best = cycle;
    }
    if (sc >= 0) break;
  }
  if (!best) throw new Error('could not find a circuit');
  return best;
}

/** `variant` > 0 draws an alternative sprint from its own random stream (see findCircuitNodes). */
export function findSprintNodes(g: RoadGraph, seed: number, variant = 0): number[] {
  const rng = new Rng(deriveSeed(seed, variant ? `sprint:${variant}` : 'sprint'));
  const n = g.nodes.length;
  const span = sqrt((g.bounds.maxX - g.bounds.minX) ** 2 + (g.bounds.maxZ - g.bounds.minZ) ** 2);
  let best: number[] | null = null;
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < ROUTE.maxAttempts; attempt++) {
    const w = randomWeights(g, rng);
    const a = rng.int(0, n - 1);
    const b = rng.int(0, n - 1);
    const via = rng.int(0, n - 1);
    const A = g.nodes[a];
    const B = g.nodes[b];
    if (sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2) < span * 0.4) continue;
    // Sprints start and end on a street, not in a roundabout.
    if (A.ring || B.ring) continue;
    if (via === a || via === b) continue;
    // Go through a waypoint so sprints wind across town instead of beelining.
    const p1 = dijkstra(g, a, via, w, new Uint8Array(n), new Uint8Array(g.edges.length));
    if (!p1) continue;
    const blocked = new Uint8Array(n);
    for (let i = 0; i < p1.length - 1; i++) blocked[p1[i]] = 1;
    if (blocked[b]) continue;
    const p2 = dijkstra(g, via, b, w, blocked, new Uint8Array(g.edges.length));
    if (!p2) continue;
    const p = p1.concat(p2.slice(1));
    // The first edge hosts the start grid, so it has to be long and straight enough.
    const first = g.edges[edgeBetween(g, p[0], p[1])];
    if (first.length < 90) continue;
    const len = pathLength(g, p, false);
    const stats = cornerStats(g, p, false);
    if (stats.maxTurn > ROUTE.maxTurnDeg && best) continue;
    const sc = score(stats, len, ROUTE.sprintMinLength, ROUTE.sprintMaxLength);
    if (sc > bestScore) {
      bestScore = sc;
      best = p;
    }
    if (sc >= 0) break;
  }
  if (!best) throw new Error('could not find a sprint');
  return best;
}

function polylineFrom(g: RoadGraph, nodes: number[], closed: boolean) {
  const edges: number[] = [];
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) edges.push(edgeBetween(g, nodes[i], nodes[(i + 1) % nodes.length]));
  return edges;
}

export function buildRoute(g: RoadGraph, kind: RouteKind, routeNodes: number[]): Route {
  const closed = kind === 'circuit';
  let nodes = routeNodes.slice();
  let edges = polylineFrom(g, nodes, closed);
  let points: Vec2[];
  let segWidth: number[];
  /** Polyline point of every plain (non roundabout) route node. */
  const nodePoint = new Map<number, number>();

  if (closed) {
    // Start line in the middle of the longest straight.
    let li = 0;
    edges.forEach((e, i) => {
      if (g.edges[e].length > g.edges[edges[li]].length) li = i;
    });
    nodes = nodes.slice(li + 1).concat(nodes.slice(0, li + 1));
    edges = polylineFrom(g, nodes, true);
    // edges[last] is now the longest edge (from nodes[last] to nodes[0]).
    const A = g.nodes[nodes[nodes.length - 1]];
    const B = g.nodes[nodes[0]];
    const mid = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
    const longest = g.edges[edges[edges.length - 1]];
    points = [mid];
    segWidth = [];
    const n = nodes.length;
    nodes.forEach((id, i) => {
      const w = i === 0 ? longest.width : g.edges[edges[i - 1]].width;
      if (!g.nodes[id].ring) nodePoint.set(id, points.length);
      appendNode(g, points, segWidth, w, nodes[(i - 1 + n) % n], id, nodes[(i + 1) % n]);
    });
    points.push({ x: mid.x, z: mid.z });
    segWidth.push(longest.width);
  } else {
    points = [];
    segWidth = [];
    nodes.forEach((id, i) => {
      if (!g.nodes[id].ring || i === 0 || i === nodes.length - 1) nodePoint.set(id, points.length);
      appendNode(g, points, segWidth, i === 0 ? 0 : g.edges[edges[i - 1]].width, i > 0 ? nodes[i - 1] : -1, id, i + 1 < nodes.length ? nodes[i + 1] : -1);
    });
  }

  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + sqrt((points[i].x - points[i - 1].x) ** 2 + (points[i].z - points[i - 1].z) ** 2));
  }
  const length = cum[cum.length - 1];
  const startS = closed ? 0 : ROUTE.sprintStartOffset;
  let finishS = closed ? length : length - ROUTE.sprintFinishOffset;
  if (!closed) {
    // Keep the finish line on a straight, out of intersections (move it earlier, never shorten the runout).
    for (let i = points.length - 2; i > 0; i--) {
      if (abs(finishS - cum[i]) < ROUTE.sprintFinishNodeClear) finishS = cum[i] - ROUTE.sprintFinishNodeClear;
    }
  }

  const span = finishS - startS;
  const count = Math.max(4, Math.round(span / ROUTE.checkpointSpacing));
  const checkpoints: number[] = [];
  for (let i = 1; i <= count; i++) checkpoints.push(startS + (span * i) / count);

  const stats = cornerStats(g, nodes, closed);
  const route: Route = {
    kind,
    closed,
    nodes,
    edges,
    points,
    cum,
    segWidth,
    length,
    startS,
    finishS,
    checkpoints,
    grid: [],
    closedStreets: [],
    shortcuts: [],
    tightCorners: stats.tight,
    sweepers: stats.sweepers,
  };

  for (let i = 0; i < 4; i++) {
    const s = startS - ROUTE.gridFirstRow - i * ROUTE.gridRowSpacing;
    const p = routeSample(route, s);
    const half = route.segWidth[p.seg] / 2;
    const lateral = (i % 2 === 0 ? 1 : -1) * Math.min(2.6, half - 1.7);
    // left normal of tangent (tx, tz) is (tz, -tx)
    route.grid.push({ x: p.x + p.tz * lateral, z: p.z - p.tx * lateral, yaw: yawOf(p.tx, p.tz), s });
  }

  // Shortcuts: back alleys joining two points of the route that save distance stay open (both ends);
  // any other back alley at a route junction is closed off like a side street.
  const open = new Set<number>();
  for (const e of g.edges) {
    if (!e.shortcut) continue;
    const ia = nodePoint.get(e.a);
    const ib = nodePoint.get(e.b);
    if (ia === undefined || ib === undefined) continue;
    const span = shortcutSpan(cum[ia], cum[ib], e.length, length, closed, startS, finishS);
    if (!span) continue;
    const A = g.nodes[span.aFirst ? e.a : e.b];
    const B = g.nodes[span.aFirst ? e.b : e.a];
    route.shortcuts.push({ edge: e.id, ax: A.x, az: A.z, bx: B.x, bz: B.z, sIn: span.sIn, sOut: span.sOut, length: e.length });
    open.add(e.id);
  }
  const onRoute = new Set(edges);
  const routeNodeSet = new Set(nodes);
  for (const nid of routeNodeSet) {
    for (const eid of g.nodes[nid].edges) {
      if (!onRoute.has(eid) && !open.has(eid)) route.closedStreets.push({ edge: eid, node: nid });
    }
  }
  return route;
}

/**
 * Append a route node's points to the driving polyline. Plain intersections
 * are one point at the node. Roundabouts (node.ring) are driven around the
 * island counterclockwise seen from above with the island on the driver's
 * left (decreasing atan2 angle): an entry point on the incoming road just
 * outside the ring, an arc at the middle of the ring road, an exit point on
 * the outgoing road. `inWidth` is the width of the segment arriving at the
 * first appended point (ignored for the very first point).
 */
function appendNode(g: RoadGraph, points: Vec2[], segWidth: number[], inWidth: number, prev: number, id: number, next: number): void {
  const P = g.nodes[id];
  const ring = P.ring;
  const push = (p: Vec2, w: number) => {
    if (points.length) segWidth.push(w);
    points.push(p);
  };
  if (!ring || prev < 0 || next < 0) {
    push({ x: P.x, z: P.z }, inWidth);
    return;
  }
  const A = g.nodes[prev];
  const B = g.nodes[next];
  const li = sqrt((P.x - A.x) ** 2 + (P.z - A.z) ** 2) || 1;
  const lo = sqrt((B.x - P.x) ** 2 + (B.z - P.z) ** 2) || 1;
  const din = { x: (P.x - A.x) / li, z: (P.z - A.z) / li };
  const dout = { x: (B.x - P.x) / lo, z: (B.z - P.z) / lo };
  const ringW = ring.outer - ring.island;
  const Rd = (ring.outer + ring.island) / 2;
  const Re = ring.outer + 3;
  const aE = atan2(-din.z, -din.x);
  const aX = atan2(dout.z, dout.x);
  let sweep = aE - aX;
  while (sweep <= 1e-6) sweep += 2 * Math.PI;
  while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
  const delta = Math.min(30 * DEG, sweep / 3);
  push({ x: P.x - din.x * Re, z: P.z - din.z * Re }, inWidth);
  const arc = sweep - 2 * delta;
  const steps = Math.max(1, Math.ceil(arc / (15 * DEG)));
  for (let k = 0; k <= steps; k++) {
    const a = aE - delta - (arc * k) / steps;
    push({ x: P.x + cos(a) * Rd, z: P.z + sin(a) * Rd }, ringW);
  }
  push({ x: P.x + dout.x * Re, z: P.z + dout.z * Re }, ringW);
}

export function wrapS(route: Route, s: number): number {
  if (!route.closed) return s;
  const L = route.length;
  return ((s % L) + L) % L;
}

/** Position and tangent at distance s along the route. */
export function routeSample(route: Route, sIn: number): RouteSample {
  const s = route.closed ? wrapS(route, sIn) : Math.max(0, Math.min(route.length, sIn));
  const cum = route.cum;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = route.points[lo];
  const b = route.points[lo + 1];
  const segLen = cum[lo + 1] - cum[lo] || 1;
  const t = (s - cum[lo]) / segLen;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    tx: (b.x - a.x) / segLen,
    tz: (b.z - a.z) / segLen,
    seg: lo,
  };
}

/**
 * Closed side street barriers, grouped for rendering.
 *
 * Every closed street mouth gets one straight barrier segment across the side
 * street (full road plus both sidewalks), just past where its walls start.
 * Mouths that sit next to each other at the same intersection (adjacent in
 * the node's angular edge order, no route edge between them) and whose
 * barrier ends touch or cross are merged into one group; crossing segments
 * are clipped at their intersection so no two barrier walls ever overlap.
 *
 * Shape: a BarrierGroup lists its wall segments in angular order around the
 * node (counterclockwise in atan2(z, x)); each segment runs a -> b in that
 * same order and its normal faces the track. Each barrier Wall carries
 * `group` = index into the group list. Render one row of parked cars behind
 * each segment of a group (behind = along -normal, up to `depth` meters) and
 * one in-air arrow per group at (x, z), facing (nx, nz).
 */
export interface BarrierGroup {
  id: number;
  /** Route node (intersection) the group faces. */
  node: number;
  /** Closed side street edges, one per segment, in the same order as walls. */
  edges: number[];
  /**
   * The closure: straight barrier segments while the world is being built,
   * then (createWorld) cyan modular rail pieces, the same RailWall objects as in
   * World.walls, all with one rail group id.
   */
  walls: Wall[];
  /** Some closed street of the group carries straight on from the incoming road (racers overshoot into it). */
  headOn: boolean;
  /** Arrow anchor: length weighted mean of the segment midpoints. */
  x: number;
  z: number;
  /** Unit normal toward the track (length weighted mean of the segment normals). */
  nx: number;
  nz: number;
  /** Total barrier length. */
  length: number;
  /**
   * Free depth behind the barrier (m) along its side streets before reaching
   * the far intersection or, for streets closed at both ends, half the gap to
   * the barrier at the other end. Minimum over the group's streets.
   */
  depth: number;
}

/** Gap (m) between barrier ends below which neighboring mouths merge into one group. */
const BARRIER_MERGE_GAP = 3;

interface MouthBarrier {
  edge: number;
  node: number;
  /** Index of the edge in the node's angular order. */
  k: number;
  a: Vec2;
  b: Vec2;
  /** Distance from the node along the side street. */
  d: number;
  /** A corner rail already runs right across this mouth: it is the closure, no barrier of its own. */
  railed: boolean;
  headOn?: boolean;
}

function mouthBarrier(g: RoadGraph, mouths: EdgeMouths[], edge: number, node: number, rails: Wall[] = [], setback = 0): MouthBarrier {
  const e = g.edges[edge];
  const m = mouths[edge];
  const p = node === e.a ? m.aP.outer : m.bP.outer;
  const q = node === e.a ? m.aN.outer : m.bN.outer;
  const n = g.nodes[node];
  const far = g.nodes[otherNode(e, node)];
  const dl = sqrt((far.x - n.x) ** 2 + (far.z - n.z) ** 2) || 1;
  const dx = (far.x - n.x) / dl;
  const dz = (far.z - n.z) / dl;
  // Place the barrier straight across the side street, just past where its walls start,
  // so it never cuts into the route corridor at acute junctions.
  const along = (pt: Vec2) => (pt.x - n.x) * dx + (pt.z - n.z) * dz;
  let d = Math.max(along(p), along(q)) + 1.5;
  // Further into the street, keeping room between this end and the far one (which may move in too).
  if (setback > 0) {
    const far0 = (() => {
      const fm = otherNode(e, node) === e.a ? [m.aP.outer, m.aN.outer] : [m.bP.outer, m.bN.outer];
      return Math.max(...fm.map((pt) => (pt.x - far.x) * -dx + (pt.z - far.z) * -dz)) + 1.5;
    })();
    const room = dl - d - far0;
    d += Math.max(0, Math.min(setback, (room - ROUTE.barrierMinRoom) / 2));
  }
  const half = e.width / 2 + e.sidewalk;
  // Stay behind any corner rail that crosses this mouth (a side street leaving
  // right at the outside of a corner), so the barrier never pokes through it.
  // A rail spanning the whole mouth closes the street by itself.
  const span = new Map<number, { lo: number; hi: number }>();
  for (const w of rails) {
    for (const [x, z] of [
      [w.ax, w.az],
      [w.bx, w.bz],
    ]) {
      const al = (x - n.x) * dx + (z - n.z) * dz;
      const lat = (x - n.x) * -dz + (z - n.z) * dx;
      if (al > 0 && al < 60 && abs(lat) <= half + 0.5) {
        d = Math.max(d, al + 1);
        const g = span.get(w.group ?? -1) ?? { lo: Infinity, hi: -Infinity };
        g.lo = Math.min(g.lo, lat);
        g.hi = Math.max(g.hi, lat);
        span.set(w.group ?? -1, g);
      }
    }
  }
  let railed = false;
  for (const g of span.values()) if (g.lo <= -half + 1.5 && g.hi >= half - 1.5) railed = true;
  const cx = n.x + dx * d;
  const cz = n.z + dz * d;
  // (-dz, dx) points toward the next edge in the node's angular order, so a -> b runs counterclockwise.
  return { edge, node, k: n.edges.indexOf(edge), a: { x: cx + dz * half, z: cz - dx * half }, b: { x: cx - dz * half, z: cz + dx * half }, d, railed };
}

/** Proper intersection parameter of segments p0p1 and q0q1 on the first, or null. */
function segCross(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): number | null {
  const d = { x: p1.x - p0.x, z: p1.z - p0.z };
  const e = { x: q1.x - q0.x, z: q1.z - q0.z };
  const t = lineIntersectT(p0, d, q0, e);
  if (t === null || t <= 0 || t >= 1) return null;
  const s = lineIntersectT(q0, e, p0, d);
  if (s === null || s <= 0 || s >= 1) return null;
  return t;
}

/**
 * Barrier groups for every closed side street of the route, in route node
 * order. Pass the route's corner rails so barriers stay behind them.
 */
export function routeBarrierGroups(g: RoadGraph, mouths: EdgeMouths[], route: Route, rails: Wall[] = []): BarrierGroup[] {
  const byNode = new Map<number, MouthBarrier[]>();
  const order = route.nodes;
  for (const cs of route.closedStreets) {
    let list = byNode.get(cs.node);
    if (!list) byNode.set(cs.node, (list = []));
    const n = g.nodes[cs.node];
    const near = rails.filter((w) => abs(w.ax - n.x) < 60 && abs(w.az - n.z) < 60);
    // Head on: the closed street carries straight on from the incoming road (same test as the renderer's).
    const i = order.indexOf(cs.node);
    const prev = route.closed ? order[(i - 1 + order.length) % order.length] : i > 0 ? order[i - 1] : -1;
    const next = i + 1 < order.length ? order[i + 1] : route.closed ? order[0] : -1;
    const from = prev >= 0 ? g.nodes[prev] : null;
    const to = from ? n : next >= 0 ? g.nodes[next] : null;
    const base = from ?? n;
    const il = to ? sqrt((to.x - base.x) ** 2 + (to.z - base.z) ** 2) || 1 : 1;
    const far = g.nodes[otherNode(g.edges[cs.edge], cs.node)];
    const fl = sqrt((far.x - n.x) ** 2 + (far.z - n.z) ** 2) || 1;
    const headOn = !!to && ((to.x - base.x) * (far.x - n.x) + (to.z - base.z) * (far.z - n.z)) / (il * fl) > 0.55;
    const mb = mouthBarrier(g, mouths, cs.edge, cs.node, near, headOn ? ROUTE.barrierSetbackHeadOn : ROUTE.barrierSetbackSide);
    mb.headOn = headOn;
    if (!mb.railed) list.push(mb);
  }
  const all = [...byNode.values()].flat();
  const barrierAt = (edge: number, node: number) => all.find((b) => b.edge === edge && b.node === node);
  const onRoute = new Set(route.edges);
  const groups: BarrierGroup[] = [];
  for (const [nid, list] of byNode) {
    const n = g.nodes[nid];
    const m = n.edges.length;
    const byK = new Map(list.map((b) => [b.k, b]));
    // Walk the edges counterclockwise starting just after a route edge, so runs never wrap.
    let start = 0;
    while (start < m && !onRoute.has(n.edges[start])) start++;
    let run: MouthBarrier[] = [];
    const runs: MouthBarrier[][] = [];
    for (let i = 1; i <= m; i++) {
      const b = byK.get((start + i) % m);
      if (b) {
        const prev = run[run.length - 1];
        if (prev) {
          const t = segCross(prev.a, prev.b, b.a, b.b);
          if (t !== null) {
            // Crossing walls: clip both at the crossing point so they meet in a V.
            const x = { x: prev.a.x + (prev.b.x - prev.a.x) * t, z: prev.a.z + (prev.b.z - prev.a.z) * t };
            prev.b = x;
            b.a = { x: x.x, z: x.z };
          } else if (sqrt((prev.b.x - b.a.x) ** 2 + (prev.b.z - b.a.z) ** 2) > BARRIER_MERGE_GAP) {
            runs.push(run);
            run = [];
          }
        }
        run.push(b);
      } else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);

    for (const r of runs) {
      const walls: Wall[] = [];
      const edges: number[] = [];
      let sx = 0;
      let sz = 0;
      let snx = 0;
      let snz = 0;
      let length = 0;
      let depth = Infinity;
      let headOn = false;
      for (const b of r) {
        if (b.headOn) headOn = true;
        const w = makeWall(b.a, b.b, { x: n.x, z: n.z }, 'barrier');
        if (!w) continue;
        w.group = groups.length;
        const len = sqrt((b.b.x - b.a.x) ** 2 + (b.b.z - b.a.z) ** 2);
        walls.push(w);
        edges.push(b.edge);
        sx += ((b.a.x + b.b.x) / 2) * len;
        sz += ((b.a.z + b.b.z) / 2) * len;
        snx += w.nx * len;
        snz += w.nz * len;
        length += len;
        // Room behind this barrier before the far end of the side street.
        const e = g.edges[b.edge];
        const farId = otherNode(e, b.node);
        const other = barrierAt(b.edge, farId);
        const farMouth = other ? other.d : mouthBarrier(g, mouths, b.edge, farId).d - 1.5;
        const room = e.length - b.d - farMouth;
        depth = Math.min(depth, other ? room / 2 : room);
      }
      if (!walls.length) continue;
      const nl = sqrt(snx * snx + snz * snz) || 1;
      groups.push({ id: groups.length, node: nid, edges, walls, x: sx / length, z: sz / length, nx: snx / nl, nz: snz / nl, length, depth: Math.max(0, depth), headOn });
    }
  }
  return groups;
}

/** A corner rail sub segment: a 'rail' Wall that also knows which modular rail piece it belongs to. */
export interface RailWall extends Wall {
  kind: 'rail';
  /** Index of the corner rail (all segments of one rail share it). */
  group: number;
  /** Global rail piece index, consecutive along each rail (pieces are sim bodies, see src/sim/rails.ts). */
  piece: number;
}

/** City wall segments around a node: its sector corners and the outer sidewalk lines of its edges. */
function localCityWalls(g: RoadGraph, sectors: Sector[][], mouths: EdgeMouths[], node: number): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (const s of sectors[node]) for (let i = 0; i + 1 < s.outer.length; i++) out.push([s.outer[i], s.outer[i + 1]]);
  for (const eid of g.nodes[node].edges) {
    const m = mouths[eid];
    out.push([m.aP.outer, m.bP.outer], [m.aN.outer, m.bN.outer]);
  }
  return out;
}

/** A corner rail reaching toward a route shortcut's T junction stops this far before it (m). */
const TJUNCTION_CLEAR = 12;

/**
 * Road length beyond the neighbor of route node i (dir -1: before it, +1:
 * after it) through straight-through T junctions whose only other road is a
 * shortcut on the far side from `out` (a rail's outward side): those keep
 * the straight going as far as a corner rail is concerned.
 */
function insideRun(g: RoadGraph, route: Route, i: number, dir: number, out: Vec2): number {
  const n = route.nodes.length;
  let extra = 0;
  let j = i + dir;
  for (let guard = 0; guard < n; guard++) {
    if (route.closed) j = (j + n) % n;
    else if (j <= 0 || j >= n - 1) break;
    const id = route.nodes[j];
    const node = g.nodes[id];
    const prev = route.nodes[(j - dir + n) % n];
    const next = route.nodes[(j + dir + n) % n];
    if (node.edges.length !== 3 || node.ring) break;
    const third = node.edges.find((eid) => {
      const o = otherNode(g.edges[eid], id);
      return o !== prev && o !== next;
    });
    if (third === undefined || !g.edges[third].shortcut) break;
    const far = g.nodes[otherNode(g.edges[third], id)];
    if ((far.x - node.x) * out.x + (far.z - node.z) * out.z >= 0) break;
    const N = g.nodes[next];
    const P = g.nodes[prev];
    const ax = node.x - P.x;
    const az = node.z - P.z;
    const bx = N.x - node.x;
    const bz = N.z - node.z;
    // Straight through only.
    if (abs(ax * bz - az * bx) > 0.02 * sqrt((ax * ax + az * az) * (bx * bx + bz * bz))) break;
    extra += sqrt(bx * bx + bz * bz);
    j += dir;
  }
  return extra;
}

/** 0 below e0, 1 above e1, a half cosine in between (C1, lowest peak curvature for the rise). */
function cosStep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return (1 - cos(t * Math.PI)) / 2;
}

/** Proper crossing test of segments ab and cd. */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
  if (abs(den) < 1e-12) return false;
  const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

/**
 * Smooth guard rails on the outside of every route corner, at the back of the
 * sidewalk (ROUTE.railInset in front of the building line), so the road and
 * the whole sidewalk stay drivable runoff and no pocket is left between the
 * rail and the city walls. Path: a straight run along the incoming road's
 * outer sidewalk line, a round fillet across the outer corner, and a straight
 * run along the outgoing road's outer sidewalk line, tangent continuous. At a
 * plain bend the fillet follows the rounded sidewalk; at a junction it cuts at
 * most ROUTE.railCornerCut inside the sharp corner. Where the rail crosses the
 * mouth of a closed side street it bends smoothly back to pass behind that
 * street's crosswalk. The path is sampled finely, then cut into modular pieces
 * of about ROUTE.railPieceLength, each made of straight sub segments turning
 * at most ROUTE.railMaxSubDeg. Each rail is one connected chain of 'rail'
 * walls (b of one segment == a of the next), all sharing `group`, with normals
 * toward the drivable side and `piece` numbered along the chain. The fillet is
 * widened until the rail keeps clear of every city wall around the corner
 * (pass the city's walls; without them the sidewalk lines are rebuilt), and
 * the rail eases around street furniture (`props`) it would otherwise touch.
 */
export function routeRails(g: RoadGraph, route: Route, props: readonly { x: number; z: number; radius: number }[] = [], cityWallList?: readonly Wall[]): RailWall[] {
  const sectors = computeSectors(g);
  const mouths = computeMouths(g, sectors);
  const walls: RailWall[] = [];
  const n = route.nodes.length;
  const from = route.closed ? 0 : 1;
  const to = route.closed ? n : n - 1;
  const step = ROUTE.railSampleStep;
  const clear = ROUTE.railCrosswalkClear;
  const cwEnd = ROUTE.railCrosswalkEnd;
  let rail = 0;
  let piece = 0;
  for (let i = from; i < to; i++) {
    const prevId = route.nodes[(i - 1 + n) % n];
    const id = route.nodes[i];
    const nextId = route.nodes[(i + 1) % n];
    const P = g.nodes[id];
    const A0 = g.nodes[prevId];
    const B0 = g.nodes[nextId];
    const lenIn = sqrt((P.x - A0.x) ** 2 + (P.z - A0.z) ** 2);
    const lenOut = sqrt((B0.x - P.x) ** 2 + (B0.z - P.z) ** 2);
    const din = { x: (P.x - A0.x) / lenIn, z: (P.z - A0.z) / lenIn };
    const dout = { x: (B0.x - P.x) / lenOut, z: (B0.z - P.z) / lenOut };
    const turn = atan2(din.x * dout.z - din.z * dout.x, din.x * dout.x + din.z * dout.z);
    const theta = abs(turn);
    if (theta < ROUTE.railMinTurnDeg * DEG) continue;
    // Left of a direction d is (dz, -dx). Turning left means the outside is on the right.
    const leftTurn = dout.x * din.z - dout.z * din.x > 0;
    const side = leftTurn ? -1 : 1;
    const oin = { x: side * din.z, z: -side * din.x };
    const oout = { x: side * dout.z, z: -side * dout.x };
    const eInId = edgeBetween(g, prevId, id);
    const eOutId = edgeBetween(g, id, nextId);
    const eIn = g.edges[eInId];
    const eOut = g.edges[eOutId];
    const hIn = eIn.width / 2 + (eIn.sidewalk ?? CITY.sidewalk) - ROUTE.railInset;
    const hOut = eOut.width / 2 + (eOut.sidewalk ?? CITY.sidewalk) - ROUTE.railInset;
    const pin = { x: P.x + oin.x * hIn, z: P.z + oin.z * hIn };
    const pout = { x: P.x + oout.x * hOut, z: P.z + oout.z * hOut };
    const t = lineIntersectT(pin, din, pout, dout);
    if (t === null) continue;
    // V: where the two rail lines meet, outside the corner.
    const V = { x: pin.x + din.x * t, z: pin.z + din.z * t };

    // Side streets on the outside of the turn: everything not inside the wedge between
    // the incoming road (looking back) and the outgoing road.
    const back = { x: -din.x, z: -din.z };
    const wedge = sign(back.x * dout.z - back.z * dout.x);
    const outside: number[] = [];
    for (const eid of P.edges) {
      if (eid === eInId || eid === eOutId) continue;
      const far = g.nodes[otherNode(g.edges[eid], id)];
      const dl = sqrt((far.x - P.x) ** 2 + (far.z - P.z) ** 2) || 1;
      const d = { x: (far.x - P.x) / dl, z: (far.z - P.z) / dl };
      const inside = sign(back.x * d.z - back.z * d.x) === wedge && sign(d.x * dout.z - d.z * dout.x) === wedge;
      if (!inside) outside.push(eid);
    }

    // Fillet radius. Plain bend: follow the rounded sidewalk (center near P). Junction: the
    // apex sits R(1/c - 1) inside V, at most railCornerCut.
    const c = cos(theta / 2);
    const tanHalf = sin(theta / 2) / c;
    // A route shortcut's T junction on the inside of the turn does not end the straight the rail
    // runs along (its mouth faces away from the rail), so the reach counts the road beyond it.
    // It still stops TJUNCTION_CLEAR short of that junction (its traffic lights and crosswalk).
    const reachOf = (len: number, extra: number) => (extra > 0 ? Math.max(len * 0.42, Math.min((len + extra) * 0.42, len - TJUNCTION_CLEAR)) : len * 0.42);
    const maxReach = Math.min(reachOf(lenIn, insideRun(g, route, i, -1, oin)), reachOf(lenOut, insideRun(g, route, i, 1, oout)));
    const rMax = Math.max(1, (maxReach - 1) / tanHalf);
    let R = Math.min(rMax, outside.length ? (ROUTE.railCornerCut * c) / (1 - c) : Math.max(hIn, hOut) + 0.3);
    // The city's real walls around the corner when given (district features included), else the sidewalk lines.
    const cityWalls: [Vec2, Vec2][] = cityWallList
      ? cityWallList
          .filter((w) => Math.min(w.ax, w.bx) < P.x + 90 && Math.max(w.ax, w.bx) > P.x - 90 && Math.min(w.az, w.bz) < P.z + 90 && Math.max(w.az, w.bz) > P.z - 90)
          .map((w) => [{ x: w.ax, z: w.az }, { x: w.bx, z: w.bz }])
      : localCityWalls(g, sectors, mouths, id);
    const nearProps = props.filter((q) => abs(q.x - P.x) < 70 && abs(q.z - P.z) < 70);
    let best: { pts: Vec2[]; nrm: Vec2[]; score: number } | null = null;
    let grew = false;
    // Crosswalk bends are dropped again if they would bring the rail near a city wall.
    let bends = true;
    let bent = false;

    let pts: Vec2[] = [];
    let nrm: Vec2[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const T = R * tanHalf;
      const reach = Math.max(T + 1, Math.min(ROUTE.railReach + (eIn.width + eOut.width) * 0.4, maxReach));
      const T1 = { x: V.x - din.x * T, z: V.z - din.z * T };
      const T2 = { x: V.x + dout.x * T, z: V.z + dout.z * T };
      // Fillet center: R inside the incoming line (toward P).
      const O = { x: T1.x - oin.x * R, z: T1.z - oin.z * R };
      pts = [];
      nrm = [];
      // Dense samples with the outward (away from the track) normal of the path.
      const run = (p0: Vec2, d: Vec2, len: number, o: Vec2, last: boolean) => {
        const k = Math.max(1, Math.ceil(len / step));
        for (let j = 0; j < k + (last ? 1 : 0); j++) {
          pts.push({ x: p0.x + (d.x * len * j) / k, z: p0.z + (d.z * len * j) / k });
          nrm.push(o);
        }
      };
      run({ x: V.x - din.x * reach, z: V.z - din.z * reach }, din, reach - T, oin, false);
      const a0 = atan2(T1.z - O.z, T1.x - O.x);
      const sweep = wrapAngle(atan2(T2.z - O.z, T2.x - O.x) - a0);
      const arcSteps = Math.max(2, Math.ceil((R * abs(sweep)) / step));
      for (let k = 0; k < arcSteps; k++) {
        const a = a0 + (sweep * k) / arcSteps;
        const ca = cos(a);
        const sa = sin(a);
        pts.push({ x: O.x + ca * R, z: O.z + sa * R });
        nrm.push({ x: ca, z: sa });
      }
      run(T2, dout, reach - T, oout, true);

      // Closed side streets on the outside: where the rail would run over a crosswalk, bend
      // it smoothly back behind the stripes (never forward, which would eat the runoff).
      const shift = new Float64Array(pts.length);
      bent = false;
      for (const eid of bends ? outside : []) {
        const e = g.edges[eid];
        const m = mouths[eid];
        const ca = id === e.a ? m.aP.curb : m.bP.curb;
        const cb = id === e.a ? m.aN.curb : m.bN.curb;
        const mx = (ca.x + cb.x) / 2;
        const mz = (ca.z + cb.z) / 2;
        const far = g.nodes[otherNode(e, id)];
        const dl = sqrt((far.x - P.x) ** 2 + (far.z - P.z) ** 2) || 1;
        const dx = (far.x - P.x) / dl;
        const dz = (far.z - P.z) / dl;
        const half = e.width / 2 + 0.3;
        // Long enough to stay gentle (narrow alley sidewalks included).
        const ramp = Math.max(2.5, (e.sidewalk ?? CITY.sidewalk) - 0.8);
        let minA = Infinity;
        let maxA = -Infinity;
        let nd = 0;
        let nc = 0;
        for (let k = 0; k < pts.length; k++) {
          const rx = pts[k].x - mx;
          const rz = pts[k].z - mz;
          const along = rx * dx + rz * dz;
          if (along < -4 || along > cwEnd + 6 || abs(rx * dz - rz * dx) > half) continue;
          minA = Math.min(minA, along);
          maxA = Math.max(maxA, along);
          nd += nrm[k].x * dx + nrm[k].z * dz;
          nc++;
        }
        if (!nc || maxA < ROUTE.railCrosswalkStart - clear || minA > cwEnd + clear) continue;
        nd /= nc;
        if (nd < 0.3) continue;
        const amount = (cwEnd + clear - minA) / nd;
        if (amount > ROUTE.railMaxBend) continue;
        bent = true;
        for (let k = 0; k < pts.length; k++) {
          const rx = pts[k].x - mx;
          const rz = pts[k].z - mz;
          // Cosine ramps (gentlest curvature for the depth); bends of neighboring streets add up.
          const w = (1 - cosStep(half, half + ramp, abs(rx * dz - rz * dx))) * cosStep(-8, -4, rx * dx + rz * dz);
          shift[k] += amount * w;
        }
      }
      for (let k = 0; k < pts.length; k++) {
        if (shift[k] !== 0) pts[k] = { x: pts[k].x + nrm[k].x * shift[k], z: pts[k].z + nrm[k].z * shift[k] };
      }

      // Keep clear of the city walls around the corner (widen the fillet if it is not) and of
      // street furniture (tighten a junction fillet that sweeps over a corner traffic light).
      let ok = true;
      for (let k = 0; k < pts.length && ok; k++) {
        for (const [a, b] of cityWalls) {
          if (distToSegment(pts[k].x, pts[k].z, a.x, a.z, b.x, b.z) < ROUTE.railInset * 0.5 || (k > 0 && segmentsCross(pts[k - 1], pts[k], a, b))) {
            ok = false;
            break;
          }
        }
      }
      // Only furniture by the fillet counts here (tightening it cannot help anywhere else).
      let propHits = 0;
      const reachV = R * tanHalf + 3;
      for (const q of nearProps) {
        if ((q.x - V.x) ** 2 + (q.z - V.z) ** 2 > reachV * reachV) continue;
        const r2 = (q.radius + ROUTE.railPropClear) ** 2;
        for (let k = 0; k < pts.length; k++) {
          if ((pts[k].x - q.x) ** 2 + (pts[k].z - q.z) ** 2 < r2) {
            propHits++;
            break;
          }
        }
      }
      const score = ok ? propHits : 1e6;
      if (!best || score < best.score) best = { pts, nrm, score };
      if (ok && propHits === 0) break;
      if (!ok && bent) {
        bends = false;
        continue;
      }
      if (!ok) {
        if (R >= rMax) break;
        R = Math.min(rMax, R * 1.3);
        grew = true;
      } else {
        if (grew || !outside.length || R <= 3) break;
        R = Math.max(3, R * 0.75);
      }
    }
    pts = best!.pts;
    nrm = best!.nrm;

    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + sqrt((pts[k].x - pts[k - 1].x) ** 2 + (pts[k].z - pts[k - 1].z) ** 2));
    // Any prop still too close (furniture just inside a closed street, behind the rail): ease the
    // rail away from it with a short smooth bend, toward the track if the prop is behind.
    {
      for (const q of nearProps) {
        let kBest = -1;
        let dBest = Infinity;
        for (let k = 0; k < pts.length; k++) {
          const d = (pts[k].x - q.x) ** 2 + (pts[k].z - q.z) ** 2;
          if (d < dBest) {
            dBest = d;
            kBest = k;
          }
        }
        const need = q.radius + ROUTE.railPropClear - sqrt(dBest);
        if (kBest < 0 || need <= 0) continue;
        const behind = (q.x - pts[kBest].x) * nrm[kBest].x + (q.z - pts[kBest].z) * nrm[kBest].z > 0;
        const amount = behind ? -need - 0.05 : need + 0.05;
        const s0 = cum[kBest];
        const span = ROUTE.railPieceLength * 2.4;
        const bentPts = pts.map((pt, k) => {
          const w = 1 - cosStep(span * 0.25, span, abs(cum[k] - s0));
          return w > 0 ? { x: pt.x + nrm[k].x * amount * w, z: pt.z + nrm[k].z * amount * w } : pt;
        });
        // Bending back must not take the rail near or past a city wall.
        let clearOfWalls = true;
        for (let k = 0; k < pts.length && clearOfWalls; k++) {
          if (bentPts[k] === pts[k]) continue;
          for (const [a, b] of cityWalls) {
            if (distToSegment(bentPts[k].x, bentPts[k].z, a.x, a.z, b.x, b.z) < ROUTE.railInset * 0.5 || (k > 0 && segmentsCross(bentPts[k - 1], bentPts[k], a, b))) {
              clearOfWalls = false;
              break;
            }
          }
        }
        if (clearOfWalls) pts = bentPts;
      }
      for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1] + sqrt((pts[k].x - pts[k - 1].x) ** 2 + (pts[k].z - pts[k - 1].z) ** 2);
    }

    // Cut the path into pieces of equal length, each made of a few straight sub segments.
    const total = cum[cum.length - 1];
    if (total < 1) continue;
    // Heading of each sample segment, for the turn inside a piece.
    const head: number[] = [];
    for (let k = 1; k < pts.length; k++) head.push(atan2(pts[k].z - pts[k - 1].z, pts[k].x - pts[k - 1].x));
    const at = (s: number): { p: Vec2; k: number } => {
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid;
      }
      const u = clamp((s - cum[lo]) / (cum[lo + 1] - cum[lo] || 1), 0, 1);
      return { p: { x: pts[lo].x + (pts[lo + 1].x - pts[lo].x) * u, z: pts[lo].z + (pts[lo + 1].z - pts[lo].z) * u }, k: lo };
    };
    const count = Math.max(1, Math.round(total / ROUTE.railPieceLength));
    const pieceLen = total / count;
    let prev = pts[0];
    let prevS = 0;
    for (let p = 0; p < count; p++) {
      const s0 = p * pieceLen;
      const s1 = p === count - 1 ? total : (p + 1) * pieceLen;
      // Sub segment ends: wherever the path has turned railMaxSubDeg since the last one.
      const ends: { p: Vec2; s: number }[] = [];
      let turned = 0;
      for (let k = at(s0).k + 1; k < pts.length - 1 && cum[k] < s1 - 0.05; k++) {
        turned += abs(wrapAngle(head[k] - head[k - 1]));
        if (cum[k] > s0 + 0.05 && turned >= ROUTE.railMaxSubDeg * DEG) {
          ends.push({ p: pts[k], s: cum[k] });
          turned = 0;
        }
      }
      ends.push({ p: p === count - 1 ? pts[pts.length - 1] : at(s1).p, s: s1 });
      for (const q of ends) {
        // Normal toward the drivable side: inward of the path normal at the segment middle.
        const o = nrm[at((prevS + q.s) / 2).k];
        const w = makeWall(prev, q.p, { x: (prev.x + q.p.x) / 2 - o.x, z: (prev.z + q.p.z) / 2 - o.z }, 'rail');
        if (!w) continue;
        walls.push({ ...w, kind: 'rail', group: rail, piece });
        prev = q.p;
        prevS = q.s;
      }
      piece++;
    }
    rail++;
  }
  return walls;
}
