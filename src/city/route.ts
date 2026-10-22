/**
 * A race's route: the types, and buildRoute, which turns a path of nodes into
 * the Route the sim races (the polyline with its widths and arc lengths,
 * checkpoints, the start grid, the finish, and the shortcuts carved into the
 * city for it, see districts/alley.ts), plus routeSample to walk it. The node
 * paths come from routeSearch.ts (circuit and sprint planned with the city;
 * the drag strip and the waypoint route picked from the finished city, so
 * adding them changed no city); routeBarriers.ts closes the side streets and
 * routeRails.ts lays the corner rails.
 */
import { CITY, ROUTE } from './config';
import { type RoadGraph, edgeBetween, isBendNode, isRiverEdge } from './roadGraph';
import { chainBackwards, routeChains } from './districts/alleyPath';
import { shortcutSpan } from './districts/alleyShortcuts';
import { DEG, type Vec2, abs, atan2, clamp, cos, distToSegment, segmentT, sin, sqrt, yawOf } from '../sim/math';
import { distanceField } from './graphSearch';


/** The routes planned with the city (planRoads carves their shortcuts and car parks into it). */
export type PlannedRouteKind = 'circuit' | 'sprint';
/** Every route a race runs on: the planned two, the drag strip and the waypoint race's suggested route. */
export type RouteKind = PlannedRouteKind | 'drag' | 'waypoint';

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
  /** Waypoint races: the waypoints in order, the finish line last (their s are the checkpoints). */
  waypoints?: RouteWaypoint[];
}

/** A waypoint race target: an intersection the race must pass through, or the finish line. */
export interface RouteWaypoint {
  x: number;
  z: number;
  /** Route distance of the target along the suggested route (m). */
  s: number;
  /** Driving within this of (x, z) reaches it (m). */
  radius: number;
  /** Distance by road from every graph node to the target (m, any street, shortcuts too): the race's progress measure. */
  field: Float64Array;
  /** The finish line: the graph edge it stands on and how far along it from the edge's node a (m); -1 for an intersection. */
  edge: number;
  along: number;
}

export interface RouteShortcut {
  /** Graph edges of the alley's chain (back alleys flagged shortcut), entry first; one edge for a straight alley. */
  edges: number[];
  /** The alley's path, entry first: its junction nodes and the free bend nodes between them (world metres). */
  points: Vec2[];
  /** Entry (on the route at sIn) and exit (at sOut) in world metres: the first and last of `points`. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Route distance at the entry and the exit (m); on circuits sOut may wrap past the start (sOut < sIn). */
  sIn: number;
  sOut: number;
  /** Length of the alley itself along its path (m). */
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

/** A drag's race distance (m): ROUTE.dragBlocks city blocks. */
export const DRAG_DISTANCE = ROUTE.dragBlocks * CITY.spacing;

/** Signed turn angle at b for the path a -> b -> c. */
export function turnAngle(g: RoadGraph, a: number, b: number, c: number): number {
  const A = g.nodes[a];
  const B = g.nodes[b];
  const C = g.nodes[c];
  const d1x = B.x - A.x;
  const d1z = B.z - A.z;
  const d2x = C.x - B.x;
  const d2z = C.z - B.z;
  return atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
}

export interface CornerStats {
  tight: number;
  sweepers: number;
  maxTurn: number;
}

export function cornerStats(g: RoadGraph, nodes: number[], closed: boolean): CornerStats {
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

export function polylineFrom(g: RoadGraph, nodes: number[], closed: boolean) {
  const edges: number[] = [];
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) edges.push(edgeBetween(g, nodes[i], nodes[(i + 1) % nodes.length]));
  return edges;
}

/** A straight of a route: consecutive route edges joined at bend nodes (a street between junctions, or the part of one the route uses). */
export interface RouteRun {
  /** Index into the route's edge list of the run's first edge. */
  from: number;
  /** Its edges in route order (wrapping past the end on a circuit) and their total length (m). */
  edges: number[];
  length: number;
}

/**
 * The route's edges grouped into runs (RouteRun): `edges[i]` joins `nodes[i]` and `nodes[i + 1]`,
 * and a run ends at every node that is not a pass-through bend. A circuit's runs wrap, so the run
 * through nodes[0] starts before the end of the list. The start grid and anything that wants a
 * route's longest straight measure these, not single edges.
 */
export function routeRuns(g: RoadGraph, nodes: number[], edges: number[], closed: boolean): RouteRun[] {
  const m = edges.length;
  const runs: RouteRun[] = [];
  if (!m) return runs;
  // The node before edges[i] is nodes[i]; a run starts at an edge whose start node is a junction.
  let start = 0;
  if (closed) while (start < m && isBendNode(g, nodes[start])) start++;
  if (start >= m) start = 0; // a loop of bends alone (never on a real route)
  let run: RouteRun | null = null;
  for (let k = 0; k < m; k++) {
    const i = (start + k) % m;
    if (!run || !isBendNode(g, nodes[i]) || (!closed && i === 0)) {
      run = { from: i, edges: [], length: 0 };
      runs.push(run);
    }
    run.edges.push(edges[i]);
    run.length += g.edges[edges[i]].length;
  }
  return runs;
}

/**
 * Where a circuit's start line goes: the middle of its longest run that is a street (not the river's
 * floor or a ramp, nor across a level crossing's tracks), as the index of the edge it is on in the
 * circuit's edge list (polylineFrom order on `nodes`) and the parameter along that edge from
 * nodes[index]. The planners that keep the start straight clear mirror buildRoute through this.
 */
export function circuitStart(g: RoadGraph, nodes: number[]): { index: number; t: number; run: RouteRun } {
  const edges = polylineFrom(g, nodes, true);
  const runs = routeRuns(g, nodes, edges, true);
  const river = (r: RouteRun) => r.edges.some((e) => isRiverEdge(g.edges[e]) || g.edges[e].crossing !== undefined);
  let best = runs[0];
  for (const r of runs) {
    const rb = river(r);
    const bb = river(best);
    if ((!rb && bb) || (rb === bb && r.length > best.length)) best = r;
  }
  let s = best.length / 2;
  for (let k = 0; k < best.edges.length; k++) {
    const len = g.edges[best.edges[k]].length;
    if (s <= len || k === best.edges.length - 1) return { index: (best.from + k) % edges.length, t: clamp(len > 0 ? s / len : 0.5, 0, 1), run: best };
    s -= len;
  }
  return { index: best.from, t: 0.5, run: best };
}

/** `waypointNodes`: a waypoint race's waypoints (findWaypointNodes), all on `routeNodes`. */
export function buildRoute(g: RoadGraph, kind: RouteKind, routeNodes: number[], waypointNodes: readonly number[] = []): Route {
  const closed = kind === 'circuit';
  const drag = kind === 'drag';
  let nodes = routeNodes.slice();
  let edges = polylineFrom(g, nodes, closed);
  let points: Vec2[];
  let segWidth: number[];
  /** Polyline point of every plain (non roundabout) route node. */
  const nodePoint = new Map<number, number>();

  if (closed) {
    // Start line in the middle of the longest straight that is a street (the grid, gantries and
    // crowds belong on one, not on the river's floor or a ramp): a run of pieces through bend nodes
    // (circuitStart), so a curving street counts whole.
    const start = circuitStart(g, nodes);
    const li = start.index;
    nodes = nodes.slice(li + 1).concat(nodes.slice(0, li + 1));
    edges = polylineFrom(g, nodes, true);
    // edges[last] is now the start edge (from nodes[last] to nodes[0]), the start line start.t along it.
    const A = g.nodes[nodes[nodes.length - 1]];
    const B = g.nodes[nodes[0]];
    const mid = { x: A.x + (B.x - A.x) * start.t, z: A.z + (B.z - A.z) * start.t };
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
  const startS = closed ? 0 : drag ? ROUTE.dragStartOffset : ROUTE.sprintStartOffset;
  let finishS = closed ? length : length - ROUTE.sprintFinishOffset;
  // A drag runs DRAG_DISTANCE, or on a city without a straight that long, as far as the runout leaves room for.
  if (drag) finishS = startS + Math.min(DRAG_DISTANCE, length - startS - ROUTE.dragRunout);
  // Both clearances move the finish earlier, so either can push it into the other's way: repeat until it stays put.
  else for (let pass = 0, prev = NaN; !closed && finishS !== prev && pass < 8; pass++) {
    prev = finishS;
    // Keep the finish line on a straight, out of intersections (move it earlier, never shorten the runout).
    for (let i = points.length - 2; i > 0; i--) {
      if (abs(finishS - cum[i]) < ROUTE.sprintFinishNodeClear) finishS = cum[i] - ROUTE.sprintFinishNodeClear;
    }
    // ... and short of a level crossing's tracks (districts/bluff.ts), never on them.
    for (let i = 0; i + 1 < nodes.length; i++) {
      const e = g.edges[edges[i]];
      if (e.crossing === undefined) continue;
      const a = g.nodes[e.a];
      const t = e.crossing / (e.length || 1);
      const px = a.x + (g.nodes[e.b].x - a.x) * t;
      const pz = a.z + (g.nodes[e.b].z - a.z) * t;
      for (let k = 0; k + 1 < points.length; k++) {
        const q0 = points[k];
        const q1 = points[k + 1];
        const sl = cum[k + 1] - cum[k];
        if (sl < 1e-6 || distToSegment(px, pz, q0.x, q0.z, q1.x, q1.z) > 1) continue;
        const cs = cum[k] + ((px - q0.x) * (q1.x - q0.x) + (pz - q0.z) * (q1.z - q0.z)) / sl;
        if (abs(finishS - cs) < ROUTE.sprintFinishNodeClear + 20) finishS = cs - ROUTE.sprintFinishNodeClear - 20;
      }
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
  // A waypoint race's checkpoints are its waypoints, at their intersections, then the finish line.
  if (waypointNodes.length) {
    const waypoints: RouteWaypoint[] = waypointNodes.map((id) => {
      const P = g.nodes[id];
      const wide = Math.max(...P.edges.map((e) => g.edges[e].width));
      return { x: P.x, z: P.z, s: cum[nodePoint.get(id) ?? 0], radius: wide / 2 + ROUTE.waypointSlack, field: distanceField(g, [[id, 0]]), edge: -1, along: 0 };
    });
    // The finish stands on the route's street between the last node before it and the next one.
    let k = 0;
    while (k + 2 < nodes.length && cum[nodePoint.get(nodes[k + 1]) ?? 0] <= finishS) k++;
    const fe = g.edges[edges[k]];
    const f = routeSample(route, finishS);
    // Measured on the edge itself: a roundabout node has no polyline point of its own (nodePoint skips
    // ring nodes, whose arcs replace them), so route distances to it are not to be had.
    const FA = g.nodes[fe.a];
    const FB = g.nodes[fe.b];
    const fromA = segmentT(f.x, f.z, FA.x, FA.z, FB.x, FB.z) * fe.length;
    waypoints.push({
      x: f.x,
      z: f.z,
      s: finishS,
      radius: segWidth[f.seg] / 2 + ROUTE.waypointFinishSlack,
      field: distanceField(g, [
        [fe.a, fromA],
        [fe.b, fe.length - fromA],
      ]),
      edge: fe.id,
      along: fromA,
    });
    route.waypoints = waypoints;
    route.checkpoints = waypoints.map((wp) => wp.s);
  }

  // Slots 0-3 are the original staggered grid (one car a row, sides alternating), so races of up to
  // four cars keep their replays. Slots 4-7 fill the empty side of those rows and 8-9 add a fifth row:
  // a two-wide grid for the full field that stays short enough for a sprint's first straight.
  // A drag lines its two cars up side by side, the rest behind; slot 1 (the player's) takes the right hand
  // lane, a negative lateral offset.
  for (let i = 0; i < ROUTE.gridSlots; i++) {
    const row = drag ? Math.floor(i / 2) : i < 8 ? i % 4 : 4;
    const right = drag ? i % 2 === 0 : i < 4 ? i % 2 === 0 : i < 8 ? i % 2 === 1 : i === 8;
    const s = startS - ROUTE.gridFirstRow - row * ROUTE.gridRowSpacing;
    const p = routeSample(route, s);
    const half = route.segWidth[p.seg] / 2;
    const lateral = (right ? 1 : -1) * Math.min(drag ? ROUTE.dragLaneOffset : 2.6, half - 1.7);
    // left normal of tangent (tx, tz) is (tz, -tx)
    route.grid.push({ x: p.x + p.tz * lateral, z: p.z - p.tx * lateral, yaw: yawOf(p.tx, p.tz), s });
  }

  // Shortcuts: back alleys joining two points of the route that save distance stay open (both ends);
  // any other back alley at a route junction is closed off like a side street. The saving is judged
  // along the streets node to node, as the planner that carved the cut judged it: the driving polyline
  // rounds every corner, which could reject a cut the planner accepted. sIn / sOut are polyline
  // distances, the ones race progress uses.
  const nodeCum: number[] = [0];
  for (let i = 0; i < edges.length; i++) nodeCum.push(nodeCum[i] + g.edges[edges[i]].length);
  const nodeTotal = nodeCum[edges.length];
  const nodeS = new Map<number, number>();
  nodes.forEach((id, i) => nodeS.set(id, nodeCum[i]));
  // A shortcut is a chain of shortcut edges through free bend nodes (districts/alleyPath.ts shortcutChain);
  // only its two ends sit on the route.
  const open = new Set<number>();
  for (const c of routeChains(g, nodes)) {
    const a = c.nodes[0];
    const b = c.nodes[c.nodes.length - 1];
    const ia = nodePoint.get(a);
    const ib = nodePoint.get(b);
    const na = nodeS.get(a);
    const nb = nodeS.get(b);
    if (ia === undefined || ib === undefined || na === undefined || nb === undefined) continue;
    const span = shortcutSpan(na, nb, c.length, nodeTotal, closed, closed ? 0 : startS, closed ? nodeTotal : nodeTotal - (length - finishS));
    // A chain carved for the other route whose jump exit this route would meet first is no shortcut here
    // (the face under the lip stops it); closed off at both ends like any side street.
    if (!span || chainBackwards(c, span.aFirst)) continue;
    const points = span.aFirst ? c.points : c.points.slice().reverse();
    const edges = span.aFirst ? c.edges : c.edges.slice().reverse();
    const A = points[0];
    const B = points[points.length - 1];
    route.shortcuts.push({ edges, points, ax: A.x, az: A.z, bx: B.x, bz: B.z, sIn: cum[span.aFirst ? ia : ib], sOut: cum[span.aFirst ? ib : ia], length: c.length });
    for (const id of edges) open.add(id);
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
