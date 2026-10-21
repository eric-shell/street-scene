/**
 * The drawbridge: one street bridge over the river channel per city becomes a
 * bascule bridge, two leaves hinged just outside the channel's top edges that
 * rise on a schedule, with gate arms across the deck at both ends. The
 * schedule is one timed gate cycle (sim/gates.ts): open most of the time,
 * then a warning, the arms come down, the leaves rise, hold and come back
 * down, the arms go up. Everything here is static data built from the seed;
 * the state at a tick is leafAngle / gatePhase of that tick, so World stays
 * immutable and a replay sees the same bridge.
 *
 * Which bridge: chosen per city once both routes are known (markDrawbridge,
 * from planRoads), preferring one the circuit and the sprint both cross on
 * top, then the circuit's, then the sprint's, then any; never one carrying a
 * route's start, grid or finish. Per city rather than per route because its
 * span must be kept clear of street furniture before the blocks are built
 * (reserved circles in the river's build): a streetlight would be left
 * standing in mid air over a raised leaf.
 *
 * In the sim the deck stays where it is (the bridge body is solid ground at
 * street level, like every bridge: the channel never passes under one), and
 * the two gates are the only thing that changes: they block from a few
 * seconds before the leaves start up until the arms are half way back up.
 * A car still on the span when the leaves start up is towed off to the
 * approach behind the nearer gate (sim/hazards.ts). The renderer
 * (render/drawbridge.ts) draws the leaves, the pit under them, the
 * counterweight houses, the control cabin, the gates and their lights from
 * the same pure functions at the interpolated sim time.
 */
import type { RoadGraph, RoadEdge } from './roadGraph';
import type { RouteKind } from './route';
import { buildRoute, routeSample } from './route';
import { riverCenter } from './districts/river';
import type { Area, AreaBuild } from './districts/types';
import { DEG, cos, distToSegment, sin, sqrt } from '../sim/math';
import { Rng, deriveSeed } from '../sim/prng';
import { TICK_HZ } from '../sim/constants';
import type { GateCycle, GateSet } from '../sim/gates';
import { gatePhase, makeGate } from '../sim/gates';

/** Drawbridge layout and schedule. Distances in m, times in s, angles in rad. */
export const DRAWBRIDGE = {
  /** Cycle length range: the bridge goes up once per cycle. */
  period: [58, 74],
  /** The first warning comes at least this long after tick 0 (3 s of countdown, then racing), within one period more. */
  firstAfter: 21,
  /** Lights and bell with the arms still up; arms coming down. */
  warn: 4,
  lower: 2.5,
  /** Arms down, leaves still flat: a car caught on the span drives off. */
  clear: 1.5,
  /** Leaves rising, holding up (range), coming down, then down again before the arms go up. */
  rise: 4,
  hold: [1.5, 3.5],
  descend: 4,
  settle: 0.5,
  /** Arms going back up (the gates block until they are half way). */
  raise: 2,
  /** Raised leaf angle. */
  maxAngle: 78 * DEG,
  /** Hinge lines (parallel to the channel) stand this far outside its top edge. */
  hingeClear: 1.2,
  /** Gate lines (square across the street) keep at least this far outside the hinge lines, on the approach. */
  gateGap: 3.6,
  /** Each junction keeps this far beyond its gate (a queue and the junction mouth). */
  approach: 30,
  /** Drawbridge streets cross the channel within this angle of square to it (the diagonals cross at about 45). */
  maxSkew: 52 * DEG,
  /** Route start lines, grid slots and sprint finishes keep this far from the span (the stretch between the gates). */
  startClear: 80,
  /** Street furniture keeps off the span and the gates: circles this far apart along both sidewalks. */
  reserveStep: 3,
  /** A car whose center is within this of the leaves (beyond the hinge lines) is towed off. */
  towMargin: 1.5,
  /** Towed cars land this far beyond their gate line (center, m). */
  towBack: 6,
} as const;

/**
 * The drawbridge of a world: static geometry and timing. Read by the sim, the
 * AI, the renderer and the HUD. Two frames meet at the span center: the
 * street's (axis d, left normal n: u along, w across) and the channel's
 * (tangent t, normal m toward +l). The hinge lines run along t at
 * m-distance ±hinge, so a leaf is about as long as the channel is wide
 * whatever the skew (a parallelogram on a diagonal street); the gates stand
 * square across the street at u = ±gate.
 */
export interface Drawbridge {
  /** Bridge edge (road graph) and the river area it crosses. */
  edge: number;
  area: number;
  /** Span center: where the street's axis crosses the river centerline (m). */
  cx: number;
  cz: number;
  /** Unit axis along the street (from node a to node b) and its left normal. */
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  /** Unit channel tangent at the crossing (toward +x) and normal toward +l. */
  tx: number;
  tz: number;
  mx: number;
  mz: number;
  /** Deck half width to the outer sidewalk lines (m), roadway half width (m), sidewalk width (m), lanes. */
  half: number;
  road: number;
  sidewalk: number;
  lanes: number;
  /** Hinge lines at m-distance ±hinge from the center (m); the gates stand at u = ±gate along the axis (m). */
  hinge: number;
  gate: number;
  /** Its cycle in World.timedGates.cycles, and its two gates there (the -axis end first). */
  cycle: number;
  gates: number[];
  /** Leaf motion inside the gates' closed phase (ticks): flat, rising, up, coming down. */
  clear: number;
  rise: number;
  hold: number;
  descend: number;
  /** Raised leaf angle (rad). */
  maxAngle: number;
}

/** Where a bridge edge crosses the river and how far its hinges and gates stand from there (see Drawbridge). */
export interface BridgeFrame {
  cx: number;
  cz: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  tx: number;
  tz: number;
  mx: number;
  mz: number;
  half: number;
  hinge: number;
  gate: number;
  /** Distance from the center to node a and node b (m). */
  toA: number;
  toB: number;
  /** |sin| of the angle between the street and square across the channel. */
  skew: number;
}

/** l (signed distance across the channel from its centerline) of a point. */
function lOf(p: Record<string, number>, x: number, z: number): number {
  return z - riverCenter(p, x);
}

/** Geometry of bridge edge `eid` over river `area`, or null when it does not cross it. */
export function bridgeFrame(g: RoadGraph, area: Area, eid: number): BridgeFrame | null {
  const p = area.params;
  const e = g.edges[eid];
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
  const dx = (b.x - a.x) / len;
  const dz = (b.z - a.z) / len;
  const la = lOf(p, a.x, a.z);
  if (la * lOf(p, b.x, b.z) >= 0) return null;
  // Crossing of the centerline along the axis, by bisection.
  let lo = 0;
  let hi = len;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (lOf(p, a.x + dx * mid, a.z + dz * mid) < 0 === la < 0) lo = mid;
    else hi = mid;
  }
  const u0 = (lo + hi) / 2;
  const cx = a.x + dx * u0;
  const cz = a.z + dz * u0;
  const nx = -dz;
  const nz = dx;
  const half = e.width / 2 + e.sidewalk;
  // The channel's frame at the crossing: tangent t, normal m toward +l.
  const slope = p.amp * p.k * cos(p.k * cx + p.phase);
  const tl = sqrt(1 + slope * slope);
  const tx = 1 / tl;
  const tz = slope / tl;
  const mx = -tz;
  const mz = tx;
  const dm = Math.abs(dx * mx + dz * mz);
  const nm = Math.abs(nx * mx + nz * mz);
  // Hinge lines along t, outside the channel's top edge (the meander bends away from a straight line by
  // a few cm over a deck's width), and the gates square across the street, clear of them on every lane.
  const hinge = p.top + DRAWBRIDGE.hingeClear;
  const gate = (hinge + DRAWBRIDGE.gateGap + half * nm) / Math.max(1e-3, dm);
  const skew = Math.abs(dx * tx + dz * tz);
  return { cx, cz, dx, dz, nx, nz, tx, tz, mx, mz, half, hinge, gate, toA: u0, toB: len - u0, skew };
}

/** True for a bridge edge a drawbridge fits on: a through street (not an alley), not too skewed, room for both approaches. */
function suitable(e: RoadEdge, f: BridgeFrame | null): f is BridgeFrame {
  if (!f || e.shortcut || (e.kind !== 'street' && e.kind !== 'avenue' && e.kind !== 'boulevard' && e.kind !== 'diagonal')) return false;
  if (f.skew > sin(DRAWBRIDGE.maxSkew)) return false;
  const room = f.gate + DRAWBRIDGE.approach;
  return f.toA >= room && f.toB >= room;
}

/** The square kept free of buildings and pockets behind each gate end: half length along the street, depth behind the building line (m). */
const GATE_END = { along: 3, depth: 4 } as const;

/**
 * Pick the city's drawbridge once both routes are planned (planRoads): record
 * its edge in the river area's params (`drawbridge`) and keep street
 * furniture off its span and gates (reserved circles in the river's build,
 * read when the blocks are generated). No river, or no bridge that fits: no
 * drawbridge.
 */
export function markDrawbridge(seed: number, g: RoadGraph, areas: Area[], builds: AreaBuild[], routeNodes: Record<RouteKind, number[]>): void {
  const river = areas.find((a) => a.kind === 'river');
  if (!river) return;
  const routes = (['circuit', 'sprint'] as RouteKind[]).map((kind) => buildRoute(g, kind, routeNodes[kind]));
  // Start lines, finishes and grids: none of them on or near a drawbridge.
  const keepClear: { x: number; z: number }[] = [];
  for (const r of routes) {
    const s = routeSample(r, r.startS);
    keepClear.push({ x: s.x, z: s.z });
    const f = routeSample(r, r.finishS);
    keepClear.push({ x: f.x, z: f.z });
    for (const slot of r.grid) keepClear.push({ x: slot.x, z: slot.z });
  }
  const onRoute = (kind: number, eid: number) => routes[kind].edges.includes(eid);
  const touches = (eid: number) => {
    const e = g.edges[eid];
    return routeNodes.circuit.includes(e.a) || routeNodes.circuit.includes(e.b) || routeNodes.sprint.includes(e.a) || routeNodes.sprint.includes(e.b);
  };
  const rng = new Rng(deriveSeed(seed, 'drawbridge'));
  const candidates = river.edges.filter((eid) => g.edges[eid].bridge);
  rng.shuffle(candidates);
  let best = -1;
  let bestScore = -1;
  for (const eid of candidates) {
    const f = bridgeFrame(g, river, eid);
    if (!suitable(g.edges[eid], f)) continue;
    const ax = f.cx - f.dx * f.gate;
    const az = f.cz - f.dz * f.gate;
    const bx = f.cx + f.dx * f.gate;
    const bz = f.cz + f.dz * f.gate;
    if (keepClear.some((q) => distToSegment(q.x, q.z, ax, az, bx, bz) < DRAWBRIDGE.startClear)) continue;
    // Both routes over it, then the circuit's, then the sprint's; off-route bridges away from route junctions first.
    const score = (onRoute(0, eid) ? 4 : 0) + (onRoute(1, eid) ? 2 : 0) + (!onRoute(0, eid) && !onRoute(1, eid) && !touches(eid) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = eid;
    }
  }
  if (best < 0) return;
  river.params.drawbridge = best;
  const f = bridgeFrame(g, river, best)!;
  const e = g.edges[best];
  const walkMid = e.width / 2 + e.sidewalk / 2;
  const span = f.gate + 3;
  const reserved = builds[river.id].reserved;
  for (let u = -span; u <= span + 1e-6; u += DRAWBRIDGE.reserveStep) {
    for (const s of [-1, 1]) reserved.push({ x: f.cx + f.dx * u + f.nx * s * walkMid, z: f.cz + f.dz * u + f.nz * s * walkMid, r: e.sidewalk / 2 + 1.3 });
  }
  // Each gate end meets the building line: keep a plaza, lot or verge from opening right there (a car
  // could slip round a closed gate through it). With no building or pocket allowed in a small square
  // behind each end, the frontage there stays a wall (the parapet, or a low boundary wall).
  const exclusions = builds[river.id].exclusions;
  for (const s of [-1, 1]) {
    for (const side of [-1, 1]) {
      const ex = f.cx + f.dx * s * f.gate + f.nx * side * f.half;
      const ez = f.cz + f.dz * s * f.gate + f.nz * side * f.half;
      const square = (a: number, b: number) => ({ x: ex + f.dx * a + f.nx * side * b, z: ez + f.dz * a + f.nz * side * b });
      exclusions.push([square(-GATE_END.along, -0.5), square(GATE_END.along, -0.5), square(GATE_END.along, GATE_END.depth), square(-GATE_END.along, GATE_END.depth)]);
    }
  }
}

/**
 * The world's timed gates and drawbridge (createWorld): the river's marked
 * bridge with its seeded schedule, or an empty set without one.
 */
export function buildTimedGates(seed: number, g: RoadGraph, areas: Area[]): { timedGates: GateSet; drawbridge: Drawbridge | null } {
  const timedGates: GateSet = { cycles: [], gates: [] };
  const river = areas.find((a) => a.kind === 'river' && a.params.drawbridge !== undefined);
  if (!river) return { timedGates, drawbridge: null };
  const eid = river.params.drawbridge;
  const f = bridgeFrame(g, river, eid);
  if (!f) return { timedGates, drawbridge: null };
  const e = g.edges[eid];
  const rng = new Rng(deriveSeed(seed, 'drawbridge:schedule'));
  const T = (s: number) => Math.round(s * TICK_HZ);
  const period = T(rng.range(DRAWBRIDGE.period[0], DRAWBRIDGE.period[1]));
  const hold = T(rng.range(DRAWBRIDGE.hold[0], DRAWBRIDGE.hold[1]));
  const clear = T(DRAWBRIDGE.clear);
  const rise = T(DRAWBRIDGE.rise);
  const descend = T(DRAWBRIDGE.descend);
  const cycle: GateCycle = {
    period,
    start: T(DRAWBRIDGE.firstAfter) + rng.int(0, period - 1),
    warn: T(DRAWBRIDGE.warn),
    lower: T(DRAWBRIDGE.lower),
    closed: clear + rise + hold + descend + T(DRAWBRIDGE.settle),
    raise: T(DRAWBRIDGE.raise),
  };
  timedGates.cycles.push(cycle);
  const gates: number[] = [];
  for (const s of [-1, 1]) {
    // Across the deck from parapet to parapet, holding back the traffic coming from this end.
    const gx = f.cx + f.dx * s * f.gate;
    const gz = f.cz + f.dz * s * f.gate;
    gates.push(timedGates.gates.length);
    timedGates.gates.push(makeGate(gx - f.nx * f.half, gz - f.nz * f.half, gx + f.nx * f.half, gz + f.nz * f.half, f.dx * s, f.dz * s, 'gate', 0));
  }
  const drawbridge: Drawbridge = {
    edge: eid,
    area: river.id,
    cx: f.cx,
    cz: f.cz,
    dx: f.dx,
    dz: f.dz,
    nx: f.nx,
    nz: f.nz,
    tx: f.tx,
    tz: f.tz,
    mx: f.mx,
    mz: f.mz,
    half: f.half,
    road: e.width / 2,
    sidewalk: e.sidewalk,
    lanes: e.lanes,
    hinge: f.hinge,
    gate: f.gate,
    cycle: 0,
    gates,
    clear,
    rise,
    hold,
    descend,
    maxAngle: DRAWBRIDGE.maxAngle,
  };
  return { timedGates, drawbridge };
}

/** Smooth start and stop for the leaves. */
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Leaf angle (rad, 0 = down) at a tick (fractional for render times). */
export function leafAngle(db: Drawbridge, set: GateSet, tick: number): number {
  const p = gatePhase(set.cycles[db.cycle], tick);
  if (p.name !== 'closed') return 0;
  let t = p.t - db.clear;
  if (t <= 0) return 0;
  if (t < db.rise) return db.maxAngle * ease(t / db.rise);
  t -= db.rise;
  if (t < db.hold) return db.maxAngle;
  t -= db.hold;
  if (t < db.descend) return db.maxAngle * ease(1 - t / db.descend);
  return 0;
}

/** Position of (x, z) around the span center: u along the street, w to its left, l across the channel toward +l (m). */
export function spanCoords(db: Drawbridge, x: number, z: number): { u: number; w: number; l: number } {
  const rx = x - db.cx;
  const rz = z - db.cz;
  return { u: rx * db.dx + rz * db.dz, w: rx * db.nx + rz * db.nz, l: rx * db.mx + rz * db.mz };
}

/** True when (x, z) is on the leaves: over the deck, within `margin` m beyond the hinge lines. */
export function onSpan(db: Drawbridge, x: number, z: number, margin = 0): boolean {
  const rx = x - db.cx;
  const rz = z - db.cz;
  const w = rx * db.nx + rz * db.nz;
  const l = rx * db.mx + rz * db.mz;
  return Math.abs(l) < db.hinge + margin && Math.abs(w) < db.half + 0.5;
}
