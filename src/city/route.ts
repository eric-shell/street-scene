/**
 * Picks a closed circuit and a point to point sprint through the road graph,
 * places checkpoints and a start grid, and closes off side streets.
 */
import { CITY, ROUTE } from './config';
import { RoadGraph, edgeBetween, otherNode } from './roadGraph';
import { EdgeMouths, Wall, makeWall } from './blocks';
import { Rng, deriveSeed } from '../sim/prng';
import { DEG, Vec2, abs, atan2, lineIntersectT, sqrt, yawOf } from '../sim/math';

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
  tightCorners: number;
  sweepers: number;
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
    // Favor the wide fast roads a little so routes have long straights.
    const kindBias = e.kind === 'boulevard' ? 0.7 : e.kind === 'diagonal' ? 0.75 : e.kind === 'avenue' ? 0.85 : 1;
    w[i] = e.length * kindBias * rng.range(0.45, 1.9);
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

export function findCircuitNodes(g: RoadGraph, seed: number): number[] {
  const rng = new Rng(deriveSeed(seed, 'circuit'));
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

export function findSprintNodes(g: RoadGraph, seed: number): number[] {
  const rng = new Rng(deriveSeed(seed, 'sprint'));
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
    points = [mid, ...nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z })), { x: mid.x, z: mid.z }];
    segWidth = [longest.width, ...edges.slice(0, -1).map((e) => g.edges[e].width), longest.width];
  } else {
    points = nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
    segWidth = edges.map((e) => g.edges[e].width);
  }

  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + sqrt((points[i].x - points[i - 1].x) ** 2 + (points[i].z - points[i - 1].z) ** 2));
  }
  const length = cum[cum.length - 1];
  const startS = closed ? 0 : ROUTE.sprintStartOffset;
  const finishS = closed ? length : length - ROUTE.sprintFinishOffset;

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

  const onRoute = new Set(edges);
  const routeNodeSet = new Set(nodes);
  for (const nid of routeNodeSet) {
    for (const eid of g.nodes[nid].edges) {
      if (!onRoute.has(eid)) route.closedStreets.push({ edge: eid, node: nid });
    }
  }
  return route;
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

/** Barrier segments across the mouth of every closed side street. */
export function routeBarriers(g: RoadGraph, mouths: EdgeMouths[], route: Route): Wall[] {
  const walls: Wall[] = [];
  for (const cs of route.closedStreets) {
    const e = g.edges[cs.edge];
    const m = mouths[cs.edge];
    const p = cs.node === e.a ? m.aP.outer : m.bP.outer;
    const q = cs.node === e.a ? m.aN.outer : m.bN.outer;
    const node = g.nodes[cs.node];
    const far = g.nodes[otherNode(e, cs.node)];
    const dl = sqrt((far.x - node.x) ** 2 + (far.z - node.z) ** 2) || 1;
    const dx = (far.x - node.x) / dl;
    const dz = (far.z - node.z) / dl;
    // Place the barrier straight across the side street, just past where its walls start,
    // so it never cuts into the route corridor at acute junctions.
    const along = (pt: Vec2) => (pt.x - node.x) * dx + (pt.z - node.z) * dz;
    const d = Math.max(along(p), along(q)) + 1.5;
    const half = e.width / 2 + CITY.sidewalk;
    const cx = node.x + dx * d;
    const cz = node.z + dz * d;
    const w = makeWall({ x: cx - dz * half, z: cz + dx * half }, { x: cx + dz * half, z: cz - dx * half }, { x: node.x, z: node.z }, 'barrier');
    if (w) walls.push(w);
  }
  return walls;
}

/**
 * Long smooth guard rails on the outside of every route corner: a curve from
 * the outer curb of the incoming road, around the outer corner, to the outer
 * curb of the outgoing road. Cars that run wide glance off and keep their
 * momentum instead of nosing into a side street barrier.
 */
export function routeRails(g: RoadGraph, route: Route): Wall[] {
  const walls: Wall[] = [];
  const n = route.nodes.length;
  const from = route.closed ? 0 : 1;
  const to = route.closed ? n : n - 1;
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
    if (abs(turn) < ROUTE.railMinTurnDeg * DEG) continue;
    // Left of a direction d is (dz, -dx). Turning left means the outside is on the right.
    const leftTurn = dout.x * din.z - dout.z * din.x > 0;
    const side = leftTurn ? -1 : 1;
    const oin = { x: side * din.z, z: -side * din.x };
    const oout = { x: side * dout.z, z: -side * dout.x };
    const eIn = g.edges[edgeBetween(g, prevId, id)];
    const eOut = g.edges[edgeBetween(g, id, nextId)];
    const pin = { x: P.x + oin.x * (eIn.width / 2), z: P.z + oin.z * (eIn.width / 2) };
    const pout = { x: P.x + oout.x * (eOut.width / 2), z: P.z + oout.z * (eOut.width / 2) };
    const t = lineIntersectT(pin, din, pout, dout);
    if (t === null) continue;
    const C = { x: pin.x + din.x * t, z: pin.z + din.z * t };
    const reach = Math.min(ROUTE.railReach + (eIn.width + eOut.width) * 0.4, lenIn * 0.42, lenOut * 0.42);
    const A = { x: C.x - din.x * reach, z: C.z - din.z * reach };
    const B = { x: C.x + dout.x * reach, z: C.z + dout.z * reach };
    const steps = ROUTE.railSegments;
    let prev = A;
    for (let k = 1; k <= steps; k++) {
      const u = k / steps;
      const q = {
        x: (1 - u) * (1 - u) * A.x + 2 * (1 - u) * u * C.x + u * u * B.x,
        z: (1 - u) * (1 - u) * A.z + 2 * (1 - u) * u * C.z + u * u * B.z,
      };
      const w = makeWall(prev, q, { x: P.x, z: P.z }, 'rail');
      if (w) walls.push(w);
      prev = q;
    }
  }
  return walls;
}
