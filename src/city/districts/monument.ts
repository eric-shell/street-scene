/**
 * Monument: one plaza block near the center of the city with a tall
 * floodlit landmark, visible from across town. The block's frontage is
 * opened like a park's (no walls: racers cut straight across the plaza),
 * its surface is concrete at sidewalk level, buildings are kept out, and
 * the landmark stands on a solid base ringed by steps. The outer step edge
 * is the collision (walls with look 'monument', drawn by
 * render/districts/monument.ts); for the triumphal arch the two piers are
 * the collision and the opening between them is wide enough to drive
 * through. The paving rises in a gentle dome toward the landmark (a terrain
 * height modifier, flat from the steps in, fading out before the plaza edge)
 * so a car cutting across pitches a little. Planter pots ring the steps,
 * benches face the landmark, flower beds and a cafe corner fill the paving
 * and lantern posts line the plaza edge, all destructible. Three kinds, one
 * per seed: an obelisk, a statue column or a triumphal arch.
 *
 * The monument is planned after the routes and comes to the race: of the
 * candidate blocks nearest the center it takes the one the most routes turn
 * round (the plaza on the inside of the turn), and each such corner gets a
 * race pass (plazaPasses, route.ts RoutePass): the racing line leaves the
 * street before the corner, crosses the paving and rejoins the next street
 * after it, round the landmark's steps with the landmark as the apex, or
 * straight through the arch. The first pass places the landmark, at the
 * middle of its chord (the arch turned along it), as near the block's middle
 * as a gentle line allows; the routes are steered toward such corners while
 * they are picked (events.ts, a side wish of every flavour). The graph is
 * untouched (no road, no curb: only a granite band in the paving marks the
 * way, drawn by the renderer): only
 * the racing line cuts the corner, so a car may still go round by the
 * street. The plaza's clutter and the street furniture keep off the passes.
 * The streets a pass leaves and rejoins are claimed, so nothing planned later
 * stands in its way. Without such a block the plaza stands where it would
 * have, off the race.
 *
 * Grand Tour events (src/city/events.ts) always get one, on the block
 * nearest the center that both routes run along (or either one), searched
 * further out than usual.
 */
import { CITY, ROUTE } from '../config';
import { DEG, Vec2, abs, atan2, cos, distToSegment, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { type RoadGraph, isBendNode } from '../roadGraph';
import { type RoutePass, circuitStart, turnAngle } from '../route';
import type { Area, DistrictModule, PlanContext, PlannedEvent } from './types';
import type { BlockFace } from '../blocks';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polyWalls, polygonCentroid, smooth01, type Smooth } from './geom';
import { convexRing } from './park';
import { riverCenter } from './river';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

const CFG = CITY.districts.monument;
/** A Grand Tour's monument may stand this far from the center (m), wherever both routes pass a block that can hold it. */
export const TOUR_REACH = 650;
const KINDS = ['obelisk', 'column', 'arch'] as const;

/** Rectangle centred on c: `len` along u, `wide` across. */
function centredRect(c: Vec2, u: Vec2, len: number, wide: number): Vec2[] {
  const v = { x: -u.z, z: u.x };
  const hl = len / 2;
  const hw = wide / 2;
  return [
    { x: c.x - u.x * hl - v.x * hw, z: c.z - u.z * hl - v.z * hw },
    { x: c.x + u.x * hl - v.x * hw, z: c.z + u.z * hl - v.z * hw },
    { x: c.x + u.x * hl + v.x * hw, z: c.z + u.z * hl + v.z * hw },
    { x: c.x - u.x * hl + v.x * hw, z: c.z - u.z * hl + v.z * hw },
  ];
}

/** The arch's two piers about c with the axis along u: footprints (len along u, wide across), -v side first. */
function archPiers(c: Vec2, u: Vec2): Vec2[][] {
  const off = CFG.archGap / 2 + CFG.pierWidth / 2;
  return [-1, 1].map((sgn) => centredRect({ x: c.x - u.z * off * sgn, z: c.z + u.x * off * sgn }, u, CFG.pierDepth, CFG.pierWidth));
}

/** What a pass is laid round: the landmark's kind, its middle, its yaw (the arch's axis) and the plaza's outline. */
interface PassShape {
  kind: string;
  c: Vec2;
  yaw: number;
  ring: Vec2[];
}

/**
 * A corner a route turns round with the plaza inside the turn: the node and the block sides' edges
 * at it, in driving order, and how far out along each street (m) the pass may leave or rejoin it
 * (passRun).
 */
interface Corner {
  node: number;
  eA: number;
  eB: number;
  maxA: number;
  maxB: number;
}

/** A pass picked for a corner: how far out it leaves and rejoins the street (m), and its sharpest bend (rad). */
interface PassPick extends Corner {
  a: number;
  b: number;
  turn: number;
}

/** Unit direction of edge `eid` leaving `node`. */
function leaving(g: RoadGraph, node: number, eid: number): Vec2 {
  const e = g.edges[eid];
  const A = g.nodes[node];
  const B = g.nodes[e.a === node ? e.b : e.a];
  const l = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
  return { x: (B.x - A.x) / l, z: (B.z - A.z) / l };
}

/** The edge at node `n` that carries on straight from edge `e` (a bend node's other piece, or a street running on through a junction that is no shortcut's mouth), or -1. */
function straightOn(g: RoadGraph, n: number, e: number): number {
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
function alongStreet(g: RoadGraph, node: number, eid: number, d: number): { p: Vec2; u: Vec2 } | null {
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
function streetEdges(g: RoadGraph, node: number, eid: number, d: number): number[] {
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

/** Where a line from E touches the circle (c, R) with c on `side` of it (1: the side a turn with a positive cross product turns to). */
function tangentPoint(E: Vec2, c: Vec2, R: number, side: number): Vec2 | null {
  const dx = c.x - E.x;
  const dz = c.z - E.z;
  const D = sqrt(dx * dx + dz * dz);
  if (D < R + 1) return null;
  // Rotate the bearing to c away from it by asin(R / D), toward -side.
  const s = (-side * R) / D;
  const co = sqrt(1 - (R * R) / (D * D));
  const hx = (dx / D) * co - (dz / D) * s;
  const hz = (dx / D) * s + (dz / D) * co;
  const t = D * co;
  return { x: E.x + hx * t, z: E.z + hz * t };
}

/**
 * The racing line of a pass round corner `k`, side A's street point first: leaving the street
 * `a` m before the corner, then round the steps (on the corner's side of the landmark, which is
 * the turn's apex) or straight through the arch along its axis, back onto the street `b` m after
 * it. Null where the streets are too short or the corner no turn.
 */
function passLine(g: RoadGraph, s: PassShape, k: Pick<Corner, 'node' | 'eA' | 'eB'>, a: number, b: number): Vec2[] | null {
  const A = alongStreet(g, k.node, k.eA, a);
  const B = alongStreet(g, k.node, k.eB, b);
  if (!A || !B) return null;
  const din = { x: -A.u.x, z: -A.u.z };
  const dout = B.u;
  const cross = din.x * dout.z - din.z * dout.x;
  if (abs(cross) < 0.3) return null;
  if (s.kind === 'arch') {
    let ux = sin(s.yaw);
    let uz = cos(s.yaw);
    if ((B.p.x - A.p.x) * ux + (B.p.z - A.p.z) * uz < 0) {
      ux = -ux;
      uz = -uz;
    }
    const L = CFG.pierDepth / 2 + CFG.passApproach;
    return [A.p, { x: s.c.x - ux * L, z: s.c.z - uz * L }, { x: s.c.x + ux * L, z: s.c.z + uz * L }, B.p];
  }
  const side = cross > 0 ? 1 : -1;
  const R = CFG.base + CFG.steps + CFG.passWidth / 2 + 1;
  const t1 = tangentPoint(A.p, s.c, R, side);
  // Leaving the circle for B with c on `side` is arriving at it from B with c on the other.
  const t2 = tangentPoint(B.p, s.c, R, -side);
  if (!t1 || !t2) return null;
  const a1 = atan2(t1.z - s.c.z, t1.x - s.c.x);
  let sweep = atan2(t2.z - s.c.z, t2.x - s.c.x) - a1;
  while (sweep * side < 0) sweep += side * 2 * Math.PI;
  if (abs(sweep) > Math.PI) return null;
  const pts = [A.p];
  const steps = Math.max(1, Math.ceil(abs(sweep) / (12 * DEG)));
  for (let i = 0; i <= steps; i++) {
    const ang = a1 + (sweep * i) / steps;
    pts.push({ x: s.c.x + cos(ang) * R, z: s.c.z + sin(ang) * R });
  }
  pts.push(B.p);
  return pts;
}

/**
 * A pass line's sharpest bend (rad, from the street before it to the street after), or null when
 * it will not do: a bend past CFG.passMaxTurn, a point on the paving without room for the line,
 * the line nowhere near the corner, or (the arch) through a pier.
 */
function passTurn(g: RoadGraph, s: PassShape, k: Corner, pts: Vec2[]): number | null {
  const half = CFG.passWidth / 2;
  const K = g.nodes[k.node];
  let near = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) near = Math.min(near, distToSegment(K.x, K.z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z));
  if (near > CFG.passCornerMax) return null;
  for (let i = 1; i + 1 < pts.length; i++) if (!pointInPolygon(pts[i].x, pts[i].z, s.ring) || distToPolygonEdge(pts[i].x, pts[i].z, s.ring) < half) return null;
  const uA = leaving(g, k.node, k.eA);
  const uB = leaving(g, k.node, k.eB);
  let px = -uA.x;
  let pz = -uA.z;
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    let nx = uB.x;
    let nz = uB.z;
    if (i + 1 < pts.length) {
      const l = sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2) || 1;
      nx = (pts[i + 1].x - pts[i].x) / l;
      nz = (pts[i + 1].z - pts[i].z) / l;
    }
    worst = Math.max(worst, abs(atan2(px * nz - pz * nx, px * nx + pz * nz)));
    px = nx;
    pz = nz;
  }
  if (worst > CFG.passMaxTurn * DEG) return null;
  if (s.kind === 'arch') {
    // Every point of the line keeps half its width (and a little) off both piers.
    for (const pier of archPiers(s.c, { x: sin(s.yaw), z: cos(s.yaw) })) {
      for (let i = 0; i + 1 < pts.length; i++) {
        const l = sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2);
        const n = Math.max(1, Math.ceil(l));
        for (let q = 0; q <= n; q++) {
          const x = pts[i].x + ((pts[i + 1].x - pts[i].x) * q) / n;
          const z = pts[i].z + ((pts[i + 1].z - pts[i].z) * q) / n;
          if (pointInPolygon(x, z, pier) || distToPolygonEdge(x, z, pier) < half + 0.3) return null;
        }
      }
    }
  }
  return worst;
}

/** The gentlest pass round corner `k` about a landmark already placed (the distances out tried every CFG.passStep), or null. */
function bestPass(g: RoadGraph, s: PassShape, k: Corner): PassPick | null {
  let best: PassPick | null = null;
  let bestScore = Infinity;
  for (let a = CFG.passReach[0]; a <= Math.min(CFG.passReach[1], k.maxA); a += CFG.passStep) {
    for (let b = CFG.passReach[0]; b <= Math.min(CFG.passReach[1], k.maxB); b += CFG.passStep) {
      const pts = passLine(g, s, k, a, b);
      const turn = pts && passTurn(g, s, k, pts);
      if (turn === null || turn === undefined) continue;
      // Gentlest first; between near equals, the shorter detour.
      const score = turn + (a + b) * 0.001;
      if (score < bestScore) {
        bestScore = score;
        best = { ...k, a, b, turn };
      }
    }
  }
  return best;
}

/**
 * The first pass of a plaza places its landmark: round corner `k`, leaving the street `a` m out and
 * rejoining it `b` m out, with the landmark at the middle of the chord between (the arch along it,
 * the obelisk or column the apex the line turns round), standing inside the plaza with room. Of
 * those that will do, the gentlest with the landmark nearest the block's middle.
 */
function placingPass(g: RoadGraph, f: BlockFace, kind: string, yaw0: number, k: Corner): { pick: PassPick; c: Vec2; yaw: number } | null {
  const mid = polygonCentroid(f.ring);
  const Rs = CFG.base + CFG.steps;
  let best: { pick: PassPick; c: Vec2; yaw: number } | null = null;
  let bestScore = Infinity;
  for (let a = CFG.passReach[0]; a <= Math.min(CFG.passReach[1], k.maxA); a += CFG.passStep) {
    const A = alongStreet(g, k.node, k.eA, a);
    if (!A) continue;
    for (let b = CFG.passReach[0]; b <= Math.min(CFG.passReach[1], k.maxB); b += CFG.passStep) {
      const B = alongStreet(g, k.node, k.eB, b);
      if (!B) continue;
      const c = { x: (A.p.x + B.p.x) / 2, z: (A.p.z + B.p.z) / 2 };
      const yaw = kind === 'arch' ? atan2(B.p.x - A.p.x, B.p.z - A.p.z) : yaw0;
      const fits =
        kind === 'arch'
          ? archPiers(c, { x: sin(yaw), z: cos(yaw) }).every((pier) => pier.every((p) => pointInPolygon(p.x, p.z, f.ring) && distToPolygonEdge(p.x, p.z, f.ring) > 3))
          : pointInPolygon(c.x, c.z, f.ring) && distToPolygonEdge(c.x, c.z, f.ring) > Rs + 3;
      if (!fits) continue;
      const s = { kind, c, yaw, ring: f.ring };
      const pts = passLine(g, s, k, a, b);
      const turn = pts && passTurn(g, s, k, pts);
      if (turn === null || turn === undefined) continue;
      // A bend 10 degrees gentler is worth the landmark standing about 40 m further off the middle.
      const score = turn + sqrt((c.x - mid.x) ** 2 + (c.z - mid.z) ** 2) * 0.0045;
      if (score < bestScore) {
        bestScore = score;
        best = { pick: { ...k, a, b, turn }, c, yaw };
      }
    }
  }
  return best;
}

/**
 * How far out from route node i (m), going `dir` (-1 back along the route, 1 on), a pass may leave
 * or rejoin the route: along the plaza block's `side` edges while the route runs straight on (bend
 * nodes, junctions it crosses), less a clearance where that run ends: CFG.passTurnClear after a
 * junction the route turns at (its closed streets lie behind the pass), CFG.passJunctionClear
 * before one it runs straight across off the block's side (that junction's closed side street may
 * run along the plaza), CFG.passMouthClear before a shortcut's mouth. Never onto a circuit's start
 * straight (grid and line, route.ts circuitStart) nor a sprint's first or last stretch.
 */
function passRun(g: RoadGraph, r: PlannedEvent['routes'][number], i: number, dir: number, side: Set<number>, banned: Set<number>): number {
  const n = r.nodes.length;
  const m = r.edges.length;
  let len = 0;
  let j = i;
  for (let guard = 0; guard < n; guard++) {
    if (!r.closed && (dir < 0 ? j <= 0 : j >= n - 1)) return len - CFG.passJunctionClear;
    const e = dir < 0 ? r.edges[(j - 1 + m) % m] : r.edges[j % m];
    if (!side.has(e) || banned.has(e)) return len - CFG.passJunctionClear;
    len += g.edges[e].length;
    j = r.closed ? (j + dir + n) % n : j + dir;
    const id = r.nodes[j];
    if (isBendNode(g, id)) continue;
    if (g.nodes[id].edges.some((o) => g.edges[o].shortcut)) return len - CFG.passMouthClear;
    if (!r.closed && (j <= 0 || j >= n - 1)) return len - CFG.passJunctionClear;
    const prev = r.nodes[(j - dir + n) % n];
    const next = r.nodes[(j + dir + n) % n];
    if (abs(turnAngle(g, prev, id, next)) > ROUTE.passStraightDeg * DEG) return len - CFG.passTurnClear;
  }
  return len;
}

/** Edges a pass never runs along for route r: a circuit's start straight, a sprint's first and last stretches (passRun). */
function startEdges(g: RoadGraph, r: PlannedEvent['routes'][number]): Set<number> {
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

/** Junctions at corners of block f route r turns round (the block's two sides at the corner on the route either side of it; never a bend node, never running straight past a side street), with how far a pass may reach along each. */
function routeCorners(g: RoadGraph, f: BlockFace, r: PlannedEvent['routes'][number]): Corner[] {
  const out: Corner[] = [];
  const side = new Set(f.edges);
  const banned = startEdges(g, r);
  const n = r.nodes.length;
  const m = r.edges.length;
  for (let i = r.closed ? 0 : 1; i < (r.closed ? n : n - 1); i++) {
    const node = r.nodes[i];
    const eA = r.edges[(i - 1 + m) % m];
    const eB = r.edges[i % m];
    if (eA === eB || isBendNode(g, node) || !side.has(eA) || !side.has(eB) || !f.corners.some((c) => c.node === node)) continue;
    const uA = leaving(g, node, eA);
    const uB = leaving(g, node, eB);
    if (-(uA.x * uB.x + uA.z * uB.z) > cos(ROUTE.passStraightDeg * DEG)) continue;
    out.push({ node, eA, eB, maxA: passRun(g, r, i, -1, side, banned), maxB: passRun(g, r, i, 1, side, banned) });
  }
  return out;
}

/** The plaza's axis by default: along its longest street side. */
function longestSide(f: BlockFace): Vec2 {
  let best = 0;
  let u: Vec2 = { x: 1, z: 0 };
  for (let i = 0; i < f.ring.length; i++) {
    if (f.segEdge[i] < 0) continue;
    const p = f.ring[i];
    const q = f.ring[(i + 1) % f.ring.length];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (l > best) {
      best = l;
      u = { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
    }
  }
  return u;
}

/**
 * The passes block f can give the routes for a landmark of `kind`: one per route at most (two routes
 * turning round the same corner share it), with where the landmark stands and its yaw (the first
 * pass places it, placingPass; without one, the block's middle and its longest side). `served`
 * counts the routes with a pass.
 */
function plazaSite(g: RoadGraph, f: BlockFace, kind: string, routes: PlannedEvent['routes']): { c: Vec2; yaw: number; passes: PassPick[]; served: number } {
  const u0 = longestSide(f);
  let c = polygonCentroid(f.ring);
  let yaw = atan2(u0.x, u0.z);
  let placed = false;
  const passes: PassPick[] = [];
  let served = 0;
  for (const r of routes) {
    let pick: PassPick | null = null;
    for (const k of routeCorners(g, f, r)) {
      const shared = passes.find((p) => p.node === k.node);
      if (shared) {
        // Another route's pass round the same corner, if this route runs as far along both streets (either way round).
        const [ma, mb] = k.eA === shared.eA ? [k.maxA, k.maxB] : [k.maxB, k.maxA];
        if (shared.a <= ma && shared.b <= mb) pick = shared;
        break;
      }
      if (placed) {
        const p = bestPass(g, { kind, c, yaw, ring: f.ring }, k);
        if (p && (!pick || p.turn < pick.turn)) pick = p;
        continue;
      }
      const p = placingPass(g, f, kind, yaw, k);
      if (p && (!pick || p.pick.turn < pick.turn)) {
        pick = p.pick;
        c = p.c;
        yaw = p.yaw;
      }
    }
    if (!pick) continue;
    placed = true;
    served++;
    if (!passes.includes(pick)) passes.push(pick);
  }
  return { c, yaw, passes, served };
}

/** The race passes a monument area carries (its params p<i>...), as the routes take them (route.ts RoutePass). */
export function plazaPasses(g: RoadGraph, area: Area): RoutePass[] {
  const P = area.params;
  const out: RoutePass[] = [];
  const s: PassShape = { kind: area.variant, c: { x: P.cx, z: P.cz }, yaw: P.yaw, ring: area.polygon };
  for (let i = 0; i < (P.passes ?? 0); i++) {
    const k = { node: P[`p${i}node`], eA: P[`p${i}eA`], eB: P[`p${i}eB`] };
    const a = P[`p${i}a`];
    const b = P[`p${i}b`];
    const points = passLine(g, s, k, a, b);
    if (points) out.push({ node: k.node, edgeA: k.eA, edgeB: k.eB, a, b, points, width: CFG.passWidth });
  }
  return out;
}

/**
 * Blocks that can hold the plaza, nearest the center first, with their
 * centroid's distance from it (m): unclaimed, convex, sized for it, no
 * bridge, shortcut, claimed street or roundabout on their ring, clear of the
 * river and within `reach` of the center. Event flavours (events.ts) ask it
 * before the monument is planned.
 */
export function monumentSites(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>, reach: number): { f: BlockFace; d: number }[] {
  const g = ctx.graph;
  const cx0 = (g.bounds.minX + g.bounds.maxX) / 2;
  const cz0 = (g.bounds.minZ + g.bounds.maxZ) / 2;
  const rivers = ctx.areas.filter((a) => a.kind === 'river');
  return ctx
    .faces()
    .filter((f) => {
      if (f.outer || f.area < CFG.minArea || f.area > CFG.maxArea || ctx.claims.face.has(f.id)) return false;
      if (f.edges.some((e) => g.edges[e].shortcut || g.edges[e].bridge || ctx.claims.edge.has(e))) return false;
      if (f.corners.some((c) => g.nodes[c.node].ring)) return false;
      if (!convexRing(f.ring)) return false;
      const c = polygonCentroid(f.ring);
      if (sqrt((c.x - cx0) ** 2 + (c.z - cz0) ** 2) > reach) return false;
      for (const r of rivers) if (f.ring.some((p) => Math.abs(p.z - riverCenter(r.params, p.x)) < r.params.top + CITY.districts.river.clearance + 4)) return false;
      return true;
    })
    .map((f) => ({ f, d: (() => {
      const c = polygonCentroid(f.ring);
      return sqrt((c.x - cx0) ** 2 + (c.z - cz0) ** 2);
    })() }))
    .sort((p, q) => p.d - q.d || p.f.id - q.f.id);
}

/**
 * The corners a race pass could turn round (route planning, before the plaza exists): every
 * junction at a corner of a block that can hold the plaza (monumentSites within `reach`), with the
 * block's two sides there when they make a real turn. A route turning between them may get a pass.
 */
export function plazaCorners(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>, reach: number): { node: number; eA: number; eB: number }[] {
  const g = ctx.graph;
  const out: { node: number; eA: number; eB: number }[] = [];
  for (const { f } of monumentSites(ctx, reach)) {
    for (const node of new Set(f.corners.map((c) => c.node))) {
      if (isBendNode(g, node)) continue;
      const sides = g.nodes[node].edges.filter((e) => f.edges.includes(e));
      if (sides.length !== 2) continue;
      const uA = leaving(g, node, sides[0]);
      const uB = leaving(g, node, sides[1]);
      if (-(uA.x * uB.x + uA.z * uB.z) > cos(ROUTE.passStraightDeg * DEG)) continue;
      out.push({ node, eA: sides[0], eB: sides[1] });
    }
  }
  return out;
}

export const monumentModule: DistrictModule = {
  kind: 'monument',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    const tour = ctx.event?.flavour === 'grandTour' ? ctx.event.routes.map((r) => new Set(r.edges)) : null;
    if (!rng.chance(CFG.chance) && !tour) return;
    const faces = monumentSites(ctx, tour ? TOUR_REACH : CFG.reach);
    if (!faces.length) return;
    const kind = KINDS[rng.int(0, KINDS.length - 1)];
    // One of the three blocks nearest the center: the landmark anchors downtown without always taking the same block.
    let f = faces[rng.int(0, Math.min(2, faces.length - 1))].f;
    if (tour) {
      // Grand Tour: the nearest block on the most routes (stable sort: nearest first among equals).
      const on = (b: BlockFace) => tour.filter((r) => b.edges.some((e) => r.has(e))).length;
      const best = faces.map((p) => ({ f: p.f, n: on(p.f) })).sort((p, q) => q.n - p.n)[0];
      if (best.n > 0) f = best.f;
    }
    let u = longestSide(f);
    let c = polygonCentroid(f.ring);
    let passes: PassPick[] = [];
    // Better: of the nearest candidates, the block the most routes turn round, where the race crosses the plaza.
    const routes = ctx.event?.routes ?? [];
    let served = 0;
    for (const p of monumentSites(ctx, TOUR_REACH).slice(0, CFG.passSites)) {
      if (ctx.budget.used + p.f.area > ctx.budget.total) continue;
      const site = plazaSite(ctx.graph, p.f, kind, routes);
      if (site.served <= served) continue;
      served = site.served;
      f = p.f;
      c = site.c;
      u = { x: sin(site.yaw), z: cos(site.yaw) };
      passes = site.passes;
    }
    if (ctx.budget.used + f.area > ctx.budget.total) return;
    const params: Record<string, number> = { cx: c.x, cz: c.z, ux: u.x, uz: u.z, yaw: atan2(u.x, u.z), area: f.area, height: CFG[kind], flags: rng.int(4, 8), seed: rng.int(1, 0x7ffffffe), passes: passes.length };
    passes.forEach((p, i) => {
      params[`p${i}node`] = p.node;
      params[`p${i}eA`] = p.eA;
      params[`p${i}eB`] = p.eB;
      params[`p${i}a`] = p.a;
      params[`p${i}b`] = p.b;
    });
    const area = ctx.addArea({ kind: 'monument', variant: kind, polygon: f.ring, path: [], nodes: [], edges: [], faces: [f.id], params }, f.area);
    // The streets the passes leave and rejoin are held, so nothing planned later (an overpass's piers, a
    // tunnel, a lane closure) stands in their way. Held in the claims only: the area's own edges stay empty.
    for (const p of passes) for (const e of [...streetEdges(ctx.graph, p.node, p.eA, p.a + CFG.passMouthClear), ...streetEdges(ctx.graph, p.node, p.eB, p.b + CFG.passMouthClear)]) ctx.claims.edge.set(e, area.id);
  },

  build(ctx, area) {
    const b = emptyBuild();
    const ring = area.polygon;
    const id = area.id;
    const P = area.params;
    const c = { x: P.cx, z: P.cz };
    const u = { x: P.ux, z: P.uz };
    b.exclusions.push(ring);
    b.openings.push(ring);
    b.surfaces.push({ surface: 'concrete', polygon: ring, priority: 2, area: id });
    const lift = CITY.curbHeight;
    let clearR: number;
    if (area.variant === 'arch') {
      // Two piers either side of the axis; the gap between their inner faces is the drive through.
      archPiers(c, u).forEach((poly, i) => {
        b.walls.push(...polyWalls(poly, false, 'monument', id));
        b.hints.push({ kind: 'pier', points: poly, values: [i ? 1 : -1] });
      });
      const off = CFG.archGap / 2 + CFG.pierWidth / 2;
      clearR = off + CFG.pierWidth / 2;
      b.props.push({ kind: 'arch', x: c.x, z: c.z, yaw: P.yaw, size: clearR, height: P.height, area: id });
    } else {
      const Rs = CFG.base + CFG.steps;
      const steps = circlePolygon(c.x, c.z, Rs, 20, P.yaw);
      b.walls.push(...polyWalls(steps, false, 'monument', id));
      b.props.push({ kind: area.variant, x: c.x, z: c.z, yaw: P.yaw, size: CFG.base, height: P.height, area: id });
      b.hints.push({ kind: 'steps', points: steps, values: [CFG.base, CFG.steps] });
      clearR = Rs;
    }
    b.reserved.push({ x: c.x, z: c.z, r: clearR + 1 });
    // The dome: flat from just past the steps (or piers), falling CFG.rise to the plaza level on a circle
    // inscribed in the plaza, so the slope never reaches the sidewalk. Exact gradient for the car.
    const inscribed = distToPolygonEdge(c.x, c.z, ring);
    const domeR = inscribed - CFG.domeInset;
    const flatR = clearR + 2;
    if (domeR > flatR + 4) {
      const rise = CFG.rise;
      b.heightMods.push({
        minX: c.x - domeR,
        minZ: c.z - domeR,
        maxX: c.x + domeR,
        maxZ: c.z + domeR,
        add(px, pz, out) {
          const dx = px - c.x;
          const dz = pz - c.z;
          const r = sqrt(dx * dx + dz * dz);
          if (r >= domeR) return;
          const s = smooth01(flatR, domeR, r, SMOOTH);
          out.h += rise * (1 - s.v);
          if (r > 1e-6 && s.d) {
            out.gx -= (rise * s.d * dx) / r;
            out.gz -= (rise * s.d * dz) / r;
          }
        },
      });
    }
    // Race passes (plazaPass): the racing lines across the paving, for the renderer, with the street
    // furniture and lights kept off their way over the sidewalk (reserved circles) and the plaza's
    // clutter off them.
    const passes = plazaPasses(ctx.graph, area);
    const lane = CFG.passWidth / 2;
    const inLane = (p: Vec2, r: number) =>
      passes.some((ps) => ps.points.some((q, i) => i + 1 < ps.points.length && distToSegment(p.x, p.z, q.x, q.z, ps.points[i + 1].x, ps.points[i + 1].z) < lane + r));
    for (const ps of passes) {
      b.hints.push({ kind: 'pass', points: ps.points, values: [ps.width] });
      for (let i = 0; i + 1 < ps.points.length; i++) {
        const q = ps.points[i];
        const r = ps.points[i + 1];
        const n = Math.max(1, Math.ceil(sqrt((r.x - q.x) ** 2 + (r.z - q.z) ** 2) / 3));
        for (let k = 0; k <= n; k++) b.reserved.push({ x: q.x + ((r.x - q.x) * k) / n, z: q.z + ((r.z - q.z) * k) / n, r: lane });
      }
    }
    // Pavement lights in a ring around the landmark (render only).
    const lamps: Vec2[] = [];
    for (let i = 0; i < 12; i++) {
      const ang = P.yaw + (i / 12) * Math.PI * 2;
      lamps.push({ x: c.x + sin(ang) * (clearR + 3), z: c.z + cos(ang) * (clearR + 3) });
    }
    b.hints.push({ kind: 'lamps', points: lamps.filter((p) => !inLane(p, 0.5)), values: [] });
    // Destructibles: planter pots ringing the steps (not across the arch's opening), benches facing the landmark with a bin each, news boxes by the plaza edge.
    const rng = new Rng(P.seed);
    const inside = (p: Vec2, margin: number) => pointInPolygon(p.x, p.z, ring) && distToPolygonEdge(p.x, p.z, ring) > margin;
    const potR = clearR + CFG.potRing;
    const pots = Math.round((2 * Math.PI * potR) / 3.4);
    for (let i = 0; i < pots; i++) {
      const ang = P.yaw + (i / pots) * Math.PI * 2;
      if (area.variant === 'arch' && Math.abs(sin(ang - P.yaw)) < 0.38) continue;
      const p = { x: c.x + sin(ang) * potR, z: c.z + cos(ang) * potR };
      if (inside(p, 2)) b.destructibles.push({ kind: 'planterPot', x: p.x, z: p.z, yaw: ang, lift, area: id });
    }
    const benches = rng.int(4, 6);
    for (let i = 0; i < benches; i++) {
      const ang = P.yaw + ((i + 0.5) / benches) * Math.PI * 2 + rng.range(-0.15, 0.15);
      if (area.variant === 'arch' && Math.abs(sin(ang - P.yaw)) < 0.45) continue;
      const r = clearR + CFG.benchRing;
      const p = { x: c.x + sin(ang) * r, z: c.z + cos(ang) * r };
      if (!inside(p, 3)) continue;
      // Facing the landmark: local +Z toward it.
      const yaw = atan2(c.x - p.x, c.z - p.z);
      b.destructibles.push({ kind: 'bench', x: p.x, z: p.z, yaw, lift, area: id });
      const q = { x: p.x + cos(yaw) * 1.6, z: p.z - sin(yaw) * 1.6 };
      if (inside(q, 3)) b.destructibles.push({ kind: 'garbageCan', x: q.x, z: q.z, yaw, lift, area: id });
    }
    // Flower beds between the benches: a cluster of bushes on a mulch disc (hint 'bed' for the renderer).
    const beds = rng.int(CFG.beds[0], CFG.beds[1]);
    for (let i = 0; i < beds; i++) {
      const ang = P.yaw + ((i + 0.5) / beds) * Math.PI * 2 + rng.range(-0.2, 0.2);
      if (area.variant === 'arch' && Math.abs(sin(ang - P.yaw)) < 0.4) continue;
      const bc = { x: c.x + sin(ang) * (clearR + CFG.bedRing), z: c.z + cos(ang) * (clearR + CFG.bedRing) };
      const bedR = rng.range(1.6, 2.4);
      if (!inside(bc, 4) || inLane(bc, bedR + 0.5)) continue;
      b.hints.push({ kind: 'bed', points: [bc], values: [bedR] });
      const n = rng.int(3, 5);
      for (let k = 0; k < n; k++) {
        const a2 = rng.range(0, Math.PI * 2);
        const rr = rng.range(0, bedR - 0.7);
        b.destructibles.push({ kind: 'bush', x: bc.x + sin(a2) * rr, z: bc.z + cos(a2) * rr, yaw: rng.range(0, 6.28), lift, area: id });
      }
    }
    // A pot where each of the paving's radial lines ends, short of the plaza edge and clear of the benches.
    for (let k = 0; k < 8; k++) {
      const ang = P.yaw + (k * Math.PI) / 4;
      const r = inscribed - CFG.potInset;
      const p = { x: c.x + sin(ang) * r, z: c.z + cos(ang) * r };
      if (r > clearR + CFG.benchRing + 3 && inside(p, 2)) b.destructibles.push({ kind: 'planterPot', x: p.x, z: p.z, yaw: ang, lift, area: id });
    }
    // A cafe in one of the plaza's corners: a food cart with its tables fanned out toward the landmark.
    const corners = ring.map((p, i) => ({ i, d: sqrt((p.x - c.x) ** 2 + (p.z - c.z) ** 2) })).sort((p, q) => q.d - p.d || p.i - q.i);
    const corner = ring[corners[rng.int(0, Math.min(3, corners.length - 1))].i];
    const toMid = { x: c.x - corner.x, z: c.z - corner.z };
    const lm = sqrt(toMid.x * toMid.x + toMid.z * toMid.z) || 1;
    const cafe = { x: corner.x + (toMid.x / lm) * CFG.cafeInset, z: corner.z + (toMid.z / lm) * CFG.cafeInset };
    if (inside(cafe, 3)) {
      const face = atan2(toMid.x, toMid.z);
      b.destructibles.push({ kind: 'foodCart', x: cafe.x, z: cafe.z, yaw: face + Math.PI / 2, lift, area: id });
      const tables = rng.int(CFG.cafeTables[0], CFG.cafeTables[1]);
      for (let k = 0; k < tables; k++) {
        const a2 = face + rng.range(-1.1, 1.1);
        const d = rng.range(3.2, 6);
        const p = { x: cafe.x + sin(a2) * d, z: cafe.z + cos(a2) * d };
        if (inside(p, 2.5)) b.destructibles.push({ kind: 'cafeTable', x: p.x, z: p.z, yaw: rng.range(0, 6.28), lift, area: id });
      }
    }
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 };
      // A little inside the plaza edge, away from the street.
      const inward = { x: c.x - m.x, z: c.z - m.z };
      const l = sqrt(inward.x * inward.x + inward.z * inward.z) || 1;
      const s = { x: m.x + (inward.x / l) * 3, z: m.z + (inward.z / l) * 3 };
      if (rng.chance(0.6) && inside(s, 2)) b.destructibles.push({ kind: rng.chance(0.5) ? 'newsBox' : 'garbageCan', x: s.x, z: s.z, yaw: atan2(-inward.x, -inward.z), lift, area: id });
    }
    // Lantern posts just inside the plaza edge, an even count per side so none lands on the
    // midpoint where a news box may stand.
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      if (len < CFG.lampSpacing) continue;
      const ux = (q.x - p.x) / len;
      const uz = (q.z - p.z) / len;
      // Inward normal: the side of the edge the landmark is on.
      const sgn = (c.x - p.x) * uz - (c.z - p.z) * ux > 0 ? 1 : -1;
      let n = Math.max(2, Math.round(len / CFG.lampSpacing));
      if (n % 2) n++;
      for (let k = 0; k < n; k++) {
        const s = ((k + 0.5) / n) * len;
        const l = { x: p.x + ux * s + uz * sgn * CFG.lampInset, z: p.z + uz * s - ux * sgn * CFG.lampInset };
        if (inside(l, 1.5)) b.destructibles.push({ kind: 'parkLamp', x: l.x, z: l.z, yaw: atan2(c.x - l.x, c.z - l.z), lift, area: id });
      }
    }
    b.destructibles = b.destructibles.filter((d) => !inLane(d, 1));
    return b;
  },
};
