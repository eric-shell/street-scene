/**
 * Shared geometry for race passes (route.ts RoutePass): the ways a route
 * leaves the streets to cut across a district (the monument plaza, a park)
 * round a corner of its block. Walks a street from a corner node on through
 * bend nodes and junctions it runs straight across, finds the corners of a
 * block a planned route turns round with how far a pass may reach along
 * each street, and measures a line's bends. The planners decide the line
 * itself (the plaza's arcs round the landmark, the park's path through the
 * middle); nothing here reads a module's config, every clearance comes in
 * as a PassClear. Pure and deterministic.
 */
import { ROUTE } from '../config';
import { DEG, type Vec2, abs, atan2, cos, sqrt } from '../../sim/math';
import { type RoadGraph, isBendNode } from '../roadGraph';
import { circuitStart, turnAngle } from '../route';
import type { BlockFace } from '../blocks';
import type { PlannedEvent } from './types';

/** Room a pass keeps along a street (m): before a junction its street runs straight across, before a shortcut's mouth, after a junction the route turns at. */
export interface PassClear {
  junction: number;
  mouth: number;
  turn: number;
}

/**
 * A corner a route turns round with the district inside the turn: the node and the block sides'
 * edges at it, in driving order, and how far out along each street (m) the pass may leave or
 * rejoin it (passRun).
 */
export interface PassCorner {
  node: number;
  eA: number;
  eB: number;
  maxA: number;
  maxB: number;
}

/** A route as the planners pass it around (PlannedEvent.routes). */
export type PlannedRoute = PlannedEvent['routes'][number];

/** Unit direction of edge `eid` leaving `node`. */
export function leaving(g: RoadGraph, node: number, eid: number): Vec2 {
  const e = g.edges[eid];
  const A = g.nodes[node];
  const B = g.nodes[e.a === node ? e.b : e.a];
  const l = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
  return { x: (B.x - A.x) / l, z: (B.z - A.z) / l };
}

/** Whether two edges leaving one node make a real turn (not within ROUTE.passStraightDeg of straight on). */
export function realTurn(g: RoadGraph, node: number, eA: number, eB: number): boolean {
  const uA = leaving(g, node, eA);
  const uB = leaving(g, node, eB);
  return -(uA.x * uB.x + uA.z * uB.z) <= cos(ROUTE.passStraightDeg * DEG);
}

/** The edge at node `n` that carries on straight from edge `e` (a bend node's other piece, or a street running on through a junction that is no shortcut's mouth), or -1. */
export function straightOn(g: RoadGraph, n: number, e: number): number {
  const N = g.nodes[n];
  if (isBendNode(g, n)) return N.edges[0] === e ? N.edges[1] : N.edges[0];
  // Never across a route shortcut's mouth (its alley must stay a real shortcut, route.ts).
  if (N.edges.some((o) => g.edges[o].shortcut)) return -1;
  const d = leaving(g, n, e);
  let best = -1;
  let bestDot = cos(ROUTE.passStraightDeg * DEG);
  for (const o of N.edges) {
    if (o === e) continue;
    const u = leaving(g, n, o);
    // Straight on: leaving opposite to the way we came in.
    const dot = -(u.x * d.x + u.z * d.z);
    if (dot > bestDot) {
      bestDot = dot;
      best = o;
    }
  }
  return best;
}

/**
 * The point `d` m from `node` along the street through edge `eid` (on through bend nodes and
 * junctions it runs straight across), with the street's direction there away from the node, or
 * null past where the street ends or turns. passRun says how far a pass may go.
 */
export function alongStreet(g: RoadGraph, node: number, eid: number, d: number): { p: Vec2; u: Vec2 } | null {
  let from = node;
  let e = eid;
  let rem = d;
  for (let guard = 0; guard < 64; guard++) {
    const E = g.edges[e];
    const to = E.a === from ? E.b : E.a;
    const A = g.nodes[from];
    const B = g.nodes[to];
    const l = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
    if (rem <= l) {
      const u = { x: (B.x - A.x) / l, z: (B.z - A.z) / l };
      return { p: { x: A.x + u.x * rem, z: A.z + u.z * rem }, u };
    }
    const on = straightOn(g, to, e);
    if (on < 0) return null;
    rem -= l;
    from = to;
    e = on;
  }
  return null;
}

/** The edges from `node` along the street through `eid` (as alongStreet walks it) that the first `d` m run along. */
export function streetEdges(g: RoadGraph, node: number, eid: number, d: number): number[] {
  const out: number[] = [];
  let from = node;
  let e = eid;
  let rem = d;
  for (let guard = 0; guard < 64 && e >= 0 && rem > 0; guard++) {
    out.push(e);
    const E = g.edges[e];
    const to = E.a === from ? E.b : E.a;
    rem -= sqrt((g.nodes[to].x - g.nodes[from].x) ** 2 + (g.nodes[to].z - g.nodes[from].z) ** 2);
    e = straightOn(g, to, e);
    from = to;
  }
  return out;
}

/**
 * How far out from route node i (m), going `dir` (-1 back along the route, 1 on), a pass may leave
 * or rejoin the route: along the block's `side` edges while the route runs straight on (bend
 * nodes, junctions it crosses), less a clearance where that run ends: `clear.turn` after a
 * junction the route turns at (its closed streets lie behind the pass), `clear.junction` before
 * one it runs straight across off the block's side (that junction's closed side street may run
 * along the district), `clear.mouth` before a shortcut's mouth. Never onto a circuit's start
 * straight (grid and line, route.ts circuitStart) nor a sprint's first or last stretch.
 */
export function passRun(g: RoadGraph, r: PlannedRoute, i: number, dir: number, side: Set<number>, banned: Set<number>, clear: PassClear): number {
  const n = r.nodes.length;
  const m = r.edges.length;
  let len = 0;
  let j = i;
  for (let guard = 0; guard < n; guard++) {
    if (!r.closed && (dir < 0 ? j <= 0 : j >= n - 1)) return len - clear.junction;
    const e = dir < 0 ? r.edges[(j - 1 + m) % m] : r.edges[j % m];
    if (!side.has(e) || banned.has(e)) return len - clear.junction;
    len += g.edges[e].length;
    j = r.closed ? (j + dir + n) % n : j + dir;
    const id = r.nodes[j];
    if (isBendNode(g, id)) continue;
    if (g.nodes[id].edges.some((o) => g.edges[o].shortcut)) return len - clear.mouth;
    if (!r.closed && (j <= 0 || j >= n - 1)) return len - clear.junction;
    const prev = r.nodes[(j - dir + n) % n];
    const next = r.nodes[(j + dir + n) % n];
    if (abs(turnAngle(g, prev, id, next)) > ROUTE.passStraightDeg * DEG) return len - clear.turn;
  }
  return len;
}

/** Edges a pass never runs along for route r: a circuit's start straight, a sprint's first and last stretches (passRun). */
export function startEdges(g: RoadGraph, r: PlannedRoute): Set<number> {
  const banned = new Set<number>();
  if (r.closed) for (const e of circuitStart(g, r.nodes).run.edges) banned.add(e);
  else {
    let total = 0;
    for (const e of r.edges) total += g.edges[e].length;
    let at = 0;
    for (const e of r.edges) {
      if (at < ROUTE.sprintStartOffset + 60 || at + g.edges[e].length > total - ROUTE.sprintFinishOffset - ROUTE.sprintFinishNodeClear - 60) banned.add(e);
      at += g.edges[e].length;
    }
  }
  return banned;
}

/**
 * Junctions at corners of block f route r turns round (the block's two sides at the corner on the
 * route either side of it; never a bend node, never running straight past a side street), with how
 * far a pass may reach along each.
 */
export function routeCorners(g: RoadGraph, f: BlockFace, r: PlannedRoute, clear: PassClear): PassCorner[] {
  const out: PassCorner[] = [];
  const side = new Set(f.edges);
  const banned = startEdges(g, r);
  const n = r.nodes.length;
  const m = r.edges.length;
  for (let i = r.closed ? 0 : 1; i < (r.closed ? n : n - 1); i++) {
    const node = r.nodes[i];
    const eA = r.edges[(i - 1 + m) % m];
    const eB = r.edges[i % m];
    if (eA === eB || isBendNode(g, node) || !side.has(eA) || !side.has(eB) || !f.corners.some((c) => c.node === node)) continue;
    if (!realTurn(g, node, eA, eB)) continue;
    out.push({ node, eA, eB, maxA: passRun(g, r, i, -1, side, banned, clear), maxB: passRun(g, r, i, 1, side, banned, clear) });
  }
  return out;
}

/**
 * Every junction at a corner of block f where its two sides make a real turn (route planning,
 * before the district exists: a route turning between them may get a pass, events.ts).
 */
export function blockCorners(g: RoadGraph, f: BlockFace): { node: number; eA: number; eB: number }[] {
  const out: { node: number; eA: number; eB: number }[] = [];
  for (const node of new Set(f.corners.map((c) => c.node))) {
    if (isBendNode(g, node)) continue;
    const sides = g.nodes[node].edges.filter((e) => f.edges.includes(e));
    if (sides.length === 2 && realTurn(g, node, sides[0], sides[1])) out.push({ node, eA: sides[0], eB: sides[1] });
  }
  return out;
}

/**
 * The sharpest bend (rad) along a line from the street before it (direction `uIn`, the way the
 * car arrives) to the street after it (`uOut`), the line's own bends included.
 */
export function sharpestBend(pts: readonly Vec2[], uIn: Vec2, uOut: Vec2): number {
  let px = uIn.x;
  let pz = uIn.z;
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    let nx = uOut.x;
    let nz = uOut.z;
    if (i + 1 < pts.length) {
      const l = sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2) || 1;
      nx = (pts[i + 1].x - pts[i].x) / l;
      nz = (pts[i + 1].z - pts[i].z) / l;
    }
    worst = Math.max(worst, abs(atan2(px * nz - pz * nx, px * nx + pz * nz)));
    px = nx;
    pz = nz;
  }
  return worst;
}

/** Length of a polyline (m). */
export function lineLength(pts: readonly Vec2[]): number {
  let l = 0;
  for (let i = 0; i + 1 < pts.length; i++) l += sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2);
  return l;
}
