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
 * candidate blocks nearest the center it takes the one whose race passes
 * grade best (plazaSite), and every route that drives by gets a pass
 * (plazaPasses, route.ts RoutePass) of one of three shapes: round a corner
 * the route turns at (the plaza inside the turn: off the street before the
 * corner, round the landmark's steps as the apex or straight through the
 * arch, back onto the next street); a chicane along one side the route runs
 * (off the street, straight across the paving past the landmark or through
 * the arch, back onto the same street further on: the common one); or a U
 * cut straight across the block between two corners the route turns at in
 * turn, skipping the side between (rare: the route has to wrap the block).
 * The first pass places the landmark on or beside its straight (the arch
 * turned along it), as near the block's middle as a gentle line allows; the
 * routes are steered toward such blocks while they are picked (events.ts, a
 * side wish of every flavour). A pass straight long enough for the grid may
 * very seldom carry a circuit's start line, under the arch or beside the
 * column (RoutePass.start, ROUTE.passStartChance). The graph is untouched
 * (no road, no curb: only a granite band in the paving marks the way, drawn
 * by the renderer): only the racing line leaves the street, so a car may
 * still go round by it. The plaza's clutter and the street furniture keep off
 * the passes. The streets a pass leaves and rejoins are claimed, so nothing
 * planned later stands in its way. Without such a block the plaza stands
 * where it would have, off the race.
 *
 * Grand Tour events (src/city/events.ts) always get one, on the block
 * nearest the center that both routes run along (or either one), searched
 * further out than usual.
 */
import { CITY, ROUTE } from '../config';
import { DEG, Vec2, abs, atan2, cos, distToSegment, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { type RoadGraph, isBendNode } from '../roadGraph';
import { type PassClear, alongStreet, leaving, passRun, startEdges, streetEdges } from './passes';
import { PASS_START_RUN, type RoutePass } from '../route';
import type { Area, DistrictModule, PlanContext, PlannedEvent } from './types';
import type { BlockFace } from '../blocks';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polyWalls, polygonCentroid, smooth01, type Smooth } from './geom';
import { convexRing } from './park';
import { riverCenter } from './river';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

const CFG = CITY.districts.monument;
/** The passes' clearances off junctions, shortcut mouths and the route's turns (passes.ts). */
const CLEAR: PassClear = { junction: CFG.passJunctionClear, mouth: CFG.passMouthClear, turn: CFG.passTurnClear };
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
 * The shapes a pass takes: round a corner the route turns at (the plaza inside the turn), a
 * chicane that leaves one street the route runs along and rejoins it further on (through), or a
 * U cut straight across the block between two corners the route wraps, skipping the side between.
 */
type PassShapeKind = 'corner' | 'through' | 'ucut';
const PASS_SHAPES: readonly PassShapeKind[] = ['corner', 'through', 'ucut'];

/**
 * A place on a route where a pass of some shape could go at block f: the anchor junction `node`
 * with the edges the route arrives (`eA`) and leaves (`eB`) by, for a U cut the second corner
 * `node2` and the street `e2` the route leaves it by (-1 otherwise), and how far out (m) the
 * pass may leave and rejoin the streets (passRun): back along eA from the node (`maxA`) and on
 * along eB from the node, or e2 from node2 (`maxB`). A through pass measures both its ends on
 * along eB.
 */
interface Place {
  shape: PassShapeKind;
  node: number;
  eA: number;
  eB: number;
  node2: number;
  e2: number;
  maxA: number;
  maxB: number;
}

/**
 * A pass picked for a place: the distances out (m: `a` back along eA, or on along eB for a
 * through pass; `b` on), a through pass's swing in run `e` and depth `d` off the street's
 * middle (m), and its sharpest bend (rad).
 */
interface PassPick extends Place {
  a: number;
  b: number;
  e: number;
  d: number;
  turn: number;
}

/** What passLine lays a line for: the place and the picked distances. */
type PassGeom = Omit<PassPick, 'turn' | 'maxA' | 'maxB'>;

/** A pass's line with the way the route arrives at its first point and leaves its last (unit). */
interface PassLine {
  pts: Vec2[];
  din: Vec2;
  dout: Vec2;
}

/**
 * The point `d` m from `node` along the street through edge `eid` (on through bend nodes and
 * junctions it runs straight across), with the street's direction there away from the node, or
 * null past where the street ends or turns. passRun says how far a pass may go.
 */
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

/** Radius of the line round an obelisk or column: the steps, half the line and a little (m). */
const ROUND_R = CFG.base + CFG.steps + CFG.passWidth / 2 + 1;

/** Unit normal to the direction (ux, uz) on the side of point `toward` from point `from`. */
function sideNormal(ux: number, uz: number, from: Vec2, toward: Vec2): Vec2 {
  const n = { x: -uz, z: ux };
  return (toward.x - from.x) * n.x + (toward.z - from.z) * n.z >= 0 ? n : { x: uz, z: -ux };
}

/**
 * A pass's street points: where it leaves and rejoins the streets as its shape measures them
 * (A then B in the route's driving order), with the street's direction there away from the
 * node (B's for a through pass, whose A is measured the same way).
 */
function passEnds(g: RoadGraph, k: PassGeom): { A: { p: Vec2; u: Vec2 }; B: { p: Vec2; u: Vec2 } } | null {
  const A = k.shape === 'through' ? alongStreet(g, k.node, k.eB, k.a) : alongStreet(g, k.node, k.eA, k.a);
  const B = k.shape === 'ucut' ? alongStreet(g, k.node2, k.e2, k.b) : alongStreet(g, k.node, k.eB, k.b);
  return A && B ? { A, B } : null;
}

/**
 * The racing line of a pass, side A's street point first, with the way the route runs at both
 * ends. Round a corner: leaving the street `a` m before it, round the steps (on the corner's
 * side of the landmark, the turn's apex) or straight through the arch along its axis, back onto
 * the street `b` m after it. Through: off the street `a` m along it, swinging `d` m onto the
 * paving over `e` m, straight past the landmark (or through the arch), back over `e` m to the
 * street `b` m along it. U cut: the straight chord from `a` m before the first corner to `b` m
 * past the second. Null where the streets are too short or a corner no turn.
 */
function passLine(g: RoadGraph, s: PassShape, k: PassGeom): PassLine | null {
  const ends = passEnds(g, k);
  if (!ends) return null;
  const { A, B } = ends;
  if (k.shape === 'through') {
    const u = A.u;
    const n = sideNormal(u.x, u.z, A.p, polygonCentroid(s.ring));
    const P1 = { x: A.p.x + u.x * k.e + n.x * k.d, z: A.p.z + u.z * k.e + n.z * k.d };
    const P2 = { x: B.p.x - u.x * k.e + n.x * k.d, z: B.p.z - u.z * k.e + n.z * k.d };
    if ((P2.x - P1.x) * u.x + (P2.z - P1.z) * u.z < CFG.passStraightMin) return null;
    return { pts: [A.p, P1, P2, B.p], din: u, dout: B.u };
  }
  const din = { x: -A.u.x, z: -A.u.z };
  const dout = B.u;
  if (k.shape === 'ucut') return { pts: [A.p, B.p], din, dout };
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
    return { pts: [A.p, { x: s.c.x - ux * L, z: s.c.z - uz * L }, { x: s.c.x + ux * L, z: s.c.z + uz * L }, B.p], din, dout };
  }
  const side = cross > 0 ? 1 : -1;
  const t1 = tangentPoint(A.p, s.c, ROUND_R, side);
  // Leaving the circle for B with c on `side` is arriving at it from B with c on the other.
  const t2 = tangentPoint(B.p, s.c, ROUND_R, -side);
  if (!t1 || !t2) return null;
  const a1 = atan2(t1.z - s.c.z, t1.x - s.c.x);
  let sweep = atan2(t2.z - s.c.z, t2.x - s.c.x) - a1;
  while (sweep * side < 0) sweep += side * 2 * Math.PI;
  if (abs(sweep) > Math.PI) return null;
  const pts = [A.p];
  const steps = Math.max(1, Math.ceil(abs(sweep) / (12 * DEG)));
  for (let i = 0; i <= steps; i++) {
    const ang = a1 + (sweep * i) / steps;
    pts.push({ x: s.c.x + cos(ang) * ROUND_R, z: s.c.z + sin(ang) * ROUND_R });
  }
  pts.push(B.p);
  return { pts, din, dout };
}

/** Points every metre or so along a polyline (its vertices included), with the distance along it. */
function samples(pts: Vec2[]): { x: number; z: number; s: number }[] {
  const out: { x: number; z: number; s: number }[] = [];
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const l = sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2);
    const n = Math.max(1, Math.ceil(l));
    for (let q = 0; q < n; q++) out.push({ x: pts[i].x + ((pts[i + 1].x - pts[i].x) * q) / n, z: pts[i].z + ((pts[i + 1].z - pts[i].z) * q) / n, s: s + (l * q) / n });
    s += l;
  }
  const last = pts[pts.length - 1];
  out.push({ x: last.x, z: last.z, s });
  return out;
}

/**
 * A pass line's sharpest bend (rad, from the street before it to the street after), or null when
 * it will not do: a bend past CFG.passMaxTurn; a point on the paving without room for the line
 * (except right where it crosses the plaza's edge); a car that keeps to the streets left further
 * from the line than CFG.passCornerMax (the corner it cuts, a chicane's depth); or (the arch)
 * the line through a pier, or (an obelisk or column, whose line a chicane or U cut runs past)
 * through the steps.
 */
function passTurn(g: RoadGraph, s: PassShape, k: PassGeom, line: PassLine): number | null {
  const half = CFG.passWidth / 2;
  const { pts, din, dout } = line;
  const far = (p: Vec2) => {
    let near = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) near = Math.min(near, distToSegment(p.x, p.z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z));
    return near;
  };
  if (k.shape === 'through' ? k.d > CFG.passCornerMax : far(g.nodes[k.node]) > CFG.passCornerMax || (k.shape === 'ucut' && far(g.nodes[k.node2]) > CFG.passCornerMax)) return null;
  // A chicane's straight lies on the paving proper, not along the plaza's edge.
  if (k.shape === 'through' && [pts[1], pts[2]].some((p) => !pointInPolygon(p.x, p.z, s.ring) || distToPolygonEdge(p.x, p.z, s.ring) < half)) return null;
  // Inside the plaza the line keeps half its width off the edge, except within that of where it
  // crosses the edge coming in or going out.
  const sm = samples(pts);
  const inside = sm.map((p) => pointInPolygon(p.x, p.z, s.ring));
  const crossings: number[] = [];
  for (let i = 1; i < sm.length; i++) if (inside[i] !== inside[i - 1]) crossings.push(sm[i].s);
  if (!crossings.length) return null;
  for (let i = 0; i < sm.length; i++) {
    if (!inside[i] || crossings.some((c) => abs(c - sm[i].s) < half + 1)) continue;
    if (distToPolygonEdge(sm[i].x, sm[i].z, s.ring) < half) return null;
  }
  let px = din.x;
  let pz = din.z;
  let worst = 0;
  for (let i = 0; i < pts.length; i++) {
    let nx = dout.x;
    let nz = dout.z;
    if (i + 1 < pts.length) {
      const l = sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2) || 1;
      nx = (pts[i + 1].x - pts[i].x) / l;
      nz = (pts[i + 1].z - pts[i].z) / l;
    }
    worst = Math.max(worst, abs(atan2(px * nz - pz * nx, px * nx + pz * nz)));
    px = nx;
    pz = nz;
  }
  if (worst > (k.shape === 'ucut' ? CFG.passUcutMaxTurn : CFG.passMaxTurn) * DEG) return null;
  if (s.kind === 'arch') {
    // Every point of the line keeps half its width (and a little) off both piers.
    for (const pier of archPiers(s.c, { x: sin(s.yaw), z: cos(s.yaw) })) for (const p of sm) if (pointInPolygon(p.x, p.z, pier) || distToPolygonEdge(p.x, p.z, pier) < half + 0.3) return null;
  } else if (k.shape !== 'corner') {
    // ... and off the steps: the line runs past them, not round them.
    if (far(s.c) < CFG.base + CFG.steps + half) return null;
  }
  return worst;
}

/**
 * Where a start line could go on a pass's line, and how far the line runs straight inside the
 * plaza either side of it (m): at the landmark (the arch's middle, or the point beside an obelisk
 * or column), on a straight piece of the line. Null for a line that bends there.
 */
function passStart(s: PassShape, k: PassGeom, pts: Vec2[]): { s: number; straight: number } | null {
  if (k.shape === 'corner' && s.kind !== 'arch') return null;
  // The straight piece: a chicane's or corner arch pass's middle, the U cut's whole chord.
  const i = pts.length === 2 ? 0 : 1;
  const P = pts[i];
  const Q = pts[i + 1];
  const l = sqrt((Q.x - P.x) ** 2 + (Q.z - P.z) ** 2) || 1;
  const ux = (Q.x - P.x) / l;
  const uz = (Q.z - P.z) / l;
  const t = (s.c.x - P.x) * ux + (s.c.z - P.z) * uz;
  if (t < 0 || t > l) return null;
  // Straight inside the plaza: from the foot to where the piece leaves the plaza, or ends.
  const run = (dir: number) => {
    let d = 0;
    const lim = dir > 0 ? l - t : t;
    for (; d < lim; d += 1) if (!pointInPolygon(P.x + ux * (t + dir * d), P.z + uz * (t + dir * d), s.ring)) break;
    return Math.min(d, lim);
  };
  let before = 0;
  for (let q = 0; q < i; q++) before += sqrt((pts[q + 1].x - pts[q].x) ** 2 + (pts[q + 1].z - pts[q].z) ** 2);
  return { s: before + t, straight: Math.min(run(-1), run(1)) };
}

/** Whether a landmark of `kind` at c facing yaw stands inside block f with room: the arch's piers, or the steps, well off the edge. */
function landmarkFits(f: BlockFace, kind: string, c: Vec2, yaw: number): boolean {
  if (kind === 'arch') return archPiers(c, { x: sin(yaw), z: cos(yaw) }).every((pier) => pier.every((p) => pointInPolygon(p.x, p.z, f.ring) && distToPolygonEdge(p.x, p.z, f.ring) > 3));
  return pointInPolygon(c.x, c.z, f.ring) && distToPolygonEdge(c.x, c.z, f.ring) > CFG.base + CFG.steps + 3;
}

/**
 * Every pass geometry worth trying at place `k`: the distances out every CFG.passStep within the
 * place's reach (a through pass's ends both on along the street, its swing in runs from
 * CFG.passEntry, its depth `d` given by the caller from where it leaves the street).
 */
function* geometries(g: RoadGraph, k: Place, depth: (A: Vec2, u: Vec2) => number[]): Generator<PassGeom> {
  const base = { shape: k.shape, node: k.node, eA: k.eA, eB: k.eB, node2: k.node2, e2: k.e2 };
  if (k.shape === 'through') {
    for (let a = CFG.passThroughFrom; a <= Math.min(CFG.passReach[1], k.maxB); a += CFG.passStep) {
      const A = alongStreet(g, k.node, k.eB, a);
      if (!A) continue;
      for (const d of depth(A.p, A.u)) {
        if (d < CFG.passWidth) continue;
        for (const e of CFG.passEntry) for (let b = a + 2 * e + CFG.passStraightMin; b <= k.maxB; b += CFG.passStep) yield { ...base, a, b, e, d };
      }
    }
    return;
  }
  for (let a = CFG.passReach[0]; a <= Math.min(CFG.passReach[1], k.maxA); a += CFG.passStep) {
    for (let b = CFG.passReach[0]; b <= Math.min(CFG.passReach[1], k.maxB); b += CFG.passStep) yield { ...base, a, b, e: 0, d: 0 };
  }
}

/**
 * Where a pass's line puts the landmark: at the middle of a corner pass's chord (the arch along
 * it, the obelisk or column the apex the line turns round); at the middle of a chicane's or a U
 * cut's straight (the arch along it), set ROUND_R off it away from the street for an obelisk or
 * column, so the line runs straight past the steps.
 */
function landmarkFor(kind: string, k: PassGeom, line: PassLine, ring: Vec2[]): { c: Vec2; yaw: number } {
  const pts = line.pts;
  const i = pts.length === 2 ? 0 : 1;
  const P = k.shape === 'corner' ? pts[0] : pts[i];
  const Q = k.shape === 'corner' ? pts[pts.length - 1] : pts[i + 1];
  const mid = { x: (P.x + Q.x) / 2, z: (P.z + Q.z) / 2 };
  const l = sqrt((Q.x - P.x) ** 2 + (Q.z - P.z) ** 2) || 1;
  const ux = (Q.x - P.x) / l;
  const uz = (Q.z - P.z) / l;
  const yaw = atan2(ux, uz);
  if (kind === 'arch' || k.shape === 'corner') return { c: mid, yaw };
  const n = sideNormal(ux, uz, mid, polygonCentroid(ring));
  return { c: { x: mid.x + n.x * ROUND_R, z: mid.z + n.z * ROUND_R }, yaw };
}

/**
 * A pass's grade (lower is better): its sharpest bend, a bend 10 degrees gentler worth the landmark
 * 40 m further off the block's middle, a longer straight a little and one long enough for a start
 * grid (route.ts PASS_START_RUN) CFG.passStartBias more, and the shape's own bias
 * (CFG.passShapeBias: a U cut crosses the whole plaza, worth a far sharper bend).
 */
function passScore(shape: PassShapeKind, turn: number, c: Vec2, mid: Vec2, straight: number): number {
  return turn + (CFG.passShapeBias[shape] + (straight >= PASS_START_RUN ? CFG.passStartBias : 0)) * DEG + sqrt((c.x - mid.x) ** 2 + (c.z - mid.z) ** 2) * 0.0045 - straight * 0.0008;
}

/**
 * The best pass at place `k` about a landmark already placed, or null. A corner pass bends round
 * it as it stands; a chicane or U cut has to run along the arch's axis through its middle, or
 * straight past the steps of an obelisk or column (its depth taken from the landmark), so a
 * second route only gets one where the geometry happens to agree.
 */
function bestPass(g: RoadGraph, f: BlockFace, s: PassShape, k: Place): PassPick | null {
  const mid = polygonCentroid(f.ring);
  let best: PassPick | null = null;
  let bestScore = Infinity;
  const depth = (A: Vec2, u: Vec2) => {
    const n = sideNormal(u.x, u.z, A, mid);
    return [(s.c.x - A.x) * n.x + (s.c.z - A.z) * n.z - (s.kind === 'arch' ? 0 : ROUND_R)];
  };
  for (const geom of geometries(g, k, depth)) {
    const line = passLine(g, s, geom);
    if (!line) continue;
    if (k.shape !== 'corner') {
      const want = landmarkFor(s.kind, geom, line, f.ring);
      if (sqrt((want.c.x - s.c.x) ** 2 + (want.c.z - s.c.z) ** 2) > CFG.passFitSlack) continue;
      if (s.kind === 'arch' && abs(sin(want.yaw - s.yaw)) > sin(CFG.passFitDeg * DEG)) continue;
    }
    const turn = passTurn(g, s, geom, line);
    if (turn === null) continue;
    const score = passScore(k.shape, turn, s.c, mid, passStart(s, geom, line.pts)?.straight ?? 0);
    if (score < bestScore) {
      bestScore = score;
      best = { ...geom, maxA: k.maxA, maxB: k.maxB, turn };
    }
  }
  return best;
}

/**
 * The first pass of a plaza places its landmark (landmarkFor), standing inside the plaza with
 * room: of the geometries at place `k` that will do, the one passScore grades best. A chicane
 * runs at the depth that puts the landmark level with the block's middle.
 */
function placingPass(g: RoadGraph, f: BlockFace, kind: string, yaw0: number, k: Place): { pick: PassPick; c: Vec2; yaw: number } | null {
  const mid = polygonCentroid(f.ring);
  let best: { pick: PassPick; c: Vec2; yaw: number } | null = null;
  let bestScore = Infinity;
  // ... or shallower (CFG.passDepths), for a gentler swing off the street at the cost of the landmark
  // standing nearer it; never deeper than a car keeping to the street may stray from the line (passTurn).
  const depth = (A: Vec2, u: Vec2) => {
    const n = sideNormal(u.x, u.z, A, mid);
    const full = Math.min(CFG.passCornerMax, (mid.x - A.x) * n.x + (mid.z - A.z) * n.z - (kind === 'arch' ? 0 : ROUND_R));
    return CFG.passDepths.map((k) => full * k);
  };
  for (const geom of geometries(g, k, depth)) {
    // A corner pass's line needs the landmark first (it bends round it, at its chord's middle); the others place it from the line.
    let c = mid;
    let yaw = yaw0;
    if (k.shape === 'corner') {
      const ends = passEnds(g, geom);
      if (!ends) continue;
      c = { x: (ends.A.p.x + ends.B.p.x) / 2, z: (ends.A.p.z + ends.B.p.z) / 2 };
      if (kind === 'arch') yaw = atan2(ends.B.p.x - ends.A.p.x, ends.B.p.z - ends.A.p.z);
    }
    const line = passLine(g, { kind, c, yaw, ring: f.ring }, geom);
    if (!line) continue;
    const at = landmarkFor(kind, geom, line, f.ring);
    const s: PassShape = { kind, c: at.c, yaw: kind === 'arch' ? at.yaw : yaw0, ring: f.ring };
    if (!landmarkFits(f, kind, s.c, s.yaw)) continue;
    const turn = passTurn(g, s, geom, line);
    if (turn === null) continue;
    const score = passScore(k.shape, turn, s.c, mid, passStart(s, geom, line.pts)?.straight ?? 0);
    if (score < bestScore) {
      bestScore = score;
      best = { pick: { ...geom, maxA: k.maxA, maxB: k.maxB, turn }, c: s.c, yaw: s.yaw };
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
/** Whether route r really turns at its node i (more than ROUTE.passStraightDeg between the streets). */
function turnsAt(g: RoadGraph, r: PlannedEvent['routes'][number], i: number): boolean {
  const m = r.edges.length;
  const uA = leaving(g, r.nodes[i], r.edges[(i - 1 + m) % m]);
  const uB = leaving(g, r.nodes[i], r.edges[i % m]);
  return -(uA.x * uB.x + uA.z * uB.z) <= cos(ROUTE.passStraightDeg * DEG);
}

/**
 * The places on route r where a pass could cross block f, with how far each may reach along the
 * streets: the junctions at the block's corners the route turns round (the block's two sides on
 * the route either side of it: corner passes); the corners where it comes onto one of the
 * block's sides, for a chicane along that side (through); and pairs of corners it turns at in
 * turn, wrapping the side between (U cut). Never a bend node, never running straight past a side
 * street. A sprint's first and last nodes are no places.
 */
function passPlaces(g: RoadGraph, f: BlockFace, r: PlannedEvent['routes'][number]): Place[] {
  const out: Place[] = [];
  const side = new Set(f.edges);
  const banned = startEdges(g, r);
  const corner = new Set(f.corners.map((c) => c.node));
  const n = r.nodes.length;
  const m = r.edges.length;
  const inner = (i: number) => r.closed || (i > 0 && i < n - 1);
  for (let i = r.closed ? 0 : 1; i < (r.closed ? n : n - 1); i++) {
    const node = r.nodes[i];
    if (isBendNode(g, node) || !corner.has(node)) continue;
    const eA = r.edges[(i - 1 + m) % m];
    const eB = r.edges[i % m];
    if (eA === eB || !side.has(eB)) continue;
    if (!side.has(eA)) {
      // Coming onto a side: a chicane along it.
      out.push({ shape: 'through', node, eA, eB, node2: -1, e2: -1, maxA: 0, maxB: passRun(g, r, i, 1, side, banned, CLEAR) });
      continue;
    }
    if (!turnsAt(g, r, i)) continue;
    out.push({ shape: 'corner', node, eA, eB, node2: -1, e2: -1, maxA: passRun(g, r, i, -1, side, banned, CLEAR), maxB: passRun(g, r, i, 1, side, banned, CLEAR) });
    // The next junction on along eB's side, if the route turns there onto a third side: a U cut between.
    let j = i;
    for (let q = 1; q <= 4; q++) {
      j = r.closed ? (i + q) % n : i + q;
      if (!inner(j) || !side.has(r.edges[(j - 1 + m) % m])) {
        j = -1;
        break;
      }
      if (!isBendNode(g, r.nodes[j])) break;
      j = -1;
    }
    if (j < 0 || !corner.has(r.nodes[j]) || !turnsAt(g, r, j)) continue;
    const e2 = r.edges[j % m];
    if (!side.has(e2) || e2 === eA || e2 === eB) continue;
    out.push({ shape: 'ucut', node, eA, eB, node2: r.nodes[j], e2, maxA: passRun(g, r, i, -1, side, banned, CLEAR), maxB: passRun(g, r, j, 1, side, banned, CLEAR) });
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
 * through the same place share it), with where the landmark stands and its yaw (the first pass
 * places it, placingPass; without one, the block's middle and its longest side). `served` counts
 * the routes with a pass; `grade` ranks sites: routes served first, then a U cut, then a corner
 * pass (CFG.passSiteGrade), the block's distance from the center the tiebreak (plan).
 */
function plazaSite(g: RoadGraph, f: BlockFace, kind: string, routes: PlannedEvent['routes']): { c: Vec2; yaw: number; passes: PassPick[]; served: number; grade: number } {
  const u0 = longestSide(f);
  let c = polygonCentroid(f.ring);
  let yaw = atan2(u0.x, u0.z);
  let placed = false;
  const passes: PassPick[] = [];
  let served = 0;
  const mid = polygonCentroid(f.ring);
  for (const r of routes) {
    let pick: PassPick | null = null;
    let pickScore = Infinity;
    for (const k of passPlaces(g, f, r)) {
      // Another route's pass through the same place, if this route runs as far along the streets (a corner pass either way round).
      const shared = passes.find((p) => p.shape === k.shape && p.node === k.node && p.node2 === k.node2 && p.eB === k.eB && (k.shape === 'through' || p.eA === k.eA || (k.shape === 'corner' && p.eA === k.eB && p.eB === k.eA)));
      if (shared) {
        const flipped = k.shape === 'corner' && shared.eA !== k.eA;
        const [ma, mb] = flipped ? [k.maxB, k.maxA] : [k.maxA, k.maxB];
        if ((k.shape === 'through' || shared.a <= ma) && shared.b <= mb) {
          pick = shared;
          break;
        }
        continue;
      }
      if (placed) {
        const p = bestPass(g, f, { kind, c, yaw, ring: f.ring }, k);
        const sc = p ? passScore(k.shape, p.turn, c, mid, 0) : Infinity;
        if (p && sc < pickScore) {
          pick = p;
          pickScore = sc;
        }
        continue;
      }
      const p = placingPass(g, f, kind, yaw, k);
      const sc = p ? passScore(k.shape, p.pick.turn, p.c, mid, 0) : Infinity;
      if (p && sc < pickScore) {
        pick = p.pick;
        pickScore = sc;
        c = p.c;
        yaw = p.yaw;
      }
    }
    if (!pick) continue;
    placed = true;
    served++;
    if (!passes.includes(pick)) passes.push(pick);
  }
  const G = CFG.passSiteGrade;
  const grade = served * G.route + (passes.some((p) => p.shape === 'ucut') ? G.ucut : 0) + (passes.some((p) => p.shape === 'corner') ? G.corner : 0);
  return { c, yaw, passes, served, grade };
}

/** The pass params an area carries, per pass i (plan writes them, plazaPasses reads them). */
const PASS_PARAMS = ['shape', 'node', 'eA', 'eB', 'node2', 'e2', 'a', 'b', 'e', 'd'] as const;

/** The race passes a monument area carries (its params p<i>...), as the routes take them (route.ts RoutePass). */
export function plazaPasses(g: RoadGraph, area: Area): RoutePass[] {
  const P = area.params;
  const out: RoutePass[] = [];
  const s: PassShape = { kind: area.variant, c: { x: P.cx, z: P.cz }, yaw: P.yaw, ring: area.polygon };
  for (let i = 0; i < (P.passes ?? 0); i++) {
    const v = (key: (typeof PASS_PARAMS)[number]) => P[`p${i}${key}`];
    const k: PassGeom = { shape: PASS_SHAPES[v('shape')], node: v('node'), eA: v('eA'), eB: v('eB'), node2: v('node2'), e2: v('e2'), a: v('a'), b: v('b'), e: v('e'), d: v('d') };
    const line = passLine(g, s, k);
    if (!line) continue;
    const pass: RoutePass = { node: k.node, edgeA: k.shape === 'through' ? -1 : k.eA, edgeB: k.eB, a: k.shape === 'through' ? -k.a : k.a, b: k.b, points: line.pts, width: CFG.passWidth };
    if (k.shape === 'ucut') {
      pass.node2 = k.node2;
      pass.edge2 = k.e2;
    }
    const start = passStart(s, k, line.pts);
    if (start) pass.start = start;
    out.push(pass);
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
 * The streets a race pass could leave from (route planning, before the plaza exists): the sides
 * of every block that can hold the plaza (monumentSites within `reach`). A route running along
 * one, round a corner of one or wrapping one may get a pass.
 */
export function plazaSides(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>, reach: number): Set<number> {
  const out = new Set<number>();
  for (const { f } of monumentSites(ctx, reach)) for (const e of f.edges) out.add(e);
  return out;
}

/**
 * The pairs of junctions a route wrapping a block that can hold the plaza turns at in turn: the
 * two ends of each of its sides (route planning, events.ts: such a route gets a U cut straight
 * across the plaza). Keys "a-b" with a < b.
 */
export function plazaWraps(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>, reach: number): Set<string> {
  const g = ctx.graph;
  const out = new Set<string>();
  for (const { f } of monumentSites(ctx, reach)) {
    for (const e of f.edges) {
      // The junctions at the side's ends, through its bend nodes.
      const ends = [g.edges[e].a, g.edges[e].b].map((n) => {
        let node = n;
        let via = e;
        for (let guard = 0; guard < 16 && isBendNode(g, node); guard++) {
          via = g.nodes[node].edges[0] === via ? g.nodes[node].edges[1] : g.nodes[node].edges[0];
          node = g.edges[via].a === node ? g.edges[via].b : g.edges[via].a;
        }
        return node;
      });
      if (ends[0] !== ends[1]) out.add(`${Math.min(ends[0], ends[1])}-${Math.max(ends[0], ends[1])}`);
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
    // Better: of the nearest candidates, the block whose passes grade best (plazaSite: the routes it
    // serves, a U cut across it, a corner pass), the nearer the center the better among equals.
    const routes = ctx.event?.routes ?? [];
    let grade = 0;
    for (const p of monumentSites(ctx, TOUR_REACH).slice(0, CFG.passSites)) {
      if (ctx.budget.used + p.f.area > ctx.budget.total) continue;
      const site = plazaSite(ctx.graph, p.f, kind, routes);
      const sg = site.served ? site.grade - p.d * CFG.passSiteGrade.perMetre : 0;
      if (sg <= grade) continue;
      grade = sg;
      f = p.f;
      c = site.c;
      u = { x: sin(site.yaw), z: cos(site.yaw) };
      passes = site.passes;
    }
    if (ctx.budget.used + f.area > ctx.budget.total) return;
    const params: Record<string, number> = { cx: c.x, cz: c.z, ux: u.x, uz: u.z, yaw: atan2(u.x, u.z), area: f.area, height: CFG[kind], flags: rng.int(4, 8), seed: rng.int(1, 0x7ffffffe), passes: passes.length };
    passes.forEach((p, i) => {
      for (const key of PASS_PARAMS) params[`p${i}${key}`] = key === 'shape' ? PASS_SHAPES.indexOf(p.shape) : p[key];
    });
    const area = ctx.addArea({ kind: 'monument', variant: kind, polygon: f.ring, path: [], nodes: [], edges: [], faces: [f.id], params }, f.area);
    // The streets the passes leave and rejoin (and the side a U cut skips) are held, so nothing planned
    // later (an overpass's piers, a tunnel, a lane closure) stands in their way. Held in the claims only:
    // the area's own edges stay empty.
    const g = ctx.graph;
    for (const p of passes) {
      const held = p.shape === 'through' ? streetEdges(g, p.node, p.eB, p.b + CFG.passMouthClear) : [...streetEdges(g, p.node, p.eA, p.a + CFG.passMouthClear), ...streetEdges(g, p.shape === 'ucut' ? p.node2 : p.node, p.shape === 'ucut' ? p.e2 : p.eB, p.b + CFG.passMouthClear)];
      if (p.shape === 'ucut') held.push(...streetEdges(g, p.node, p.eB, 1e9));
      for (const e of held) ctx.claims.edge.set(e, area.id);
    }
  },

  passes: plazaPasses,

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
