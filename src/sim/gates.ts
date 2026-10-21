/**
 * Timed gates: the generic mechanism behind every scheduled road hazard (the
 * drawbridge over the river, city/drawbridge.ts; a level crossing would use
 * the same pieces). A gate is a one sided wall across a road that stops cars
 * only while its schedule says so; the schedule (GateCycle) is static data
 * and the state at any tick is a pure function of that tick (gatePhase), so
 * World stays immutable, nothing is kept on RaceState, a replay sees exactly
 * the same gates, and the renderer animates arms and lights from the same
 * function at the interpolated sim time.
 *
 * A cycle runs: open, then warn (lights and bell, arms still up), lowering
 * (arms coming down), closed (arms down) and raising (arms going back up).
 * Gates block from the start of `closed` until the arms are half way back up.
 * A cycle may close more than once a period (`more`): a level crossing
 * (city/levelCrossings.ts) closes for the trains of both directions, which
 * share one headway at different phases. Without `more` it is the single
 * closure above, unchanged.
 *
 * Collision (collideGates, called from sim/collision.ts for every car circle):
 * a blocking gate holds back a car whose center is on its holding side (the
 * side its normal points to), with the same one sided push as a wall, so a
 * fast car cannot tunnel through; a car whose center is already past the line
 * (caught on a drawbridge span when the gates came down) drives out freely.
 * Gates are not part of World.walls (they stand across a road, which no
 * static wall may), and each carries a WallLook its renderer draws.
 *
 * Racers: gateSpeedCap (sim/ai.ts) brakes an AI to a stop short of a gate
 * that will be blocking when it gets there, queues it behind cars already
 * waiting, and tells it to stop its stuck and reverse-out logic meanwhile;
 * waitingAtGate keeps race.ts from counting a waiting car as lost.
 * Per tick cost: a bounding circle test per gate per car circle; only cars
 * near a gate do more.
 */
import type { Contact } from '../city/world';
import type { WallLook } from '../city/districts/types';
import type { RaceCar, RaceState } from './race';
import { TICK_HZ } from './constants';
import { cos, segmentT, sin, sqrt } from './math';

/** A gate schedule in sim ticks. Pure data: the state at tick t is gatePhase(cycle, t). */
export interface GateCycle {
  /** Cycle length (ticks). */
  period: number;
  /** Tick the first cycle starts (its warning begins); the gates stand open before it (ticks). */
  start: number;
  /** Warning with the arms still up (ticks). */
  warn: number;
  /** Arms coming down (ticks). */
  lower: number;
  /** Arms down (ticks). */
  closed: number;
  /** Arms going back up (ticks). */
  raise: number;
  /**
   * More closures each period: each starts its warning `at` ticks after the cycle's own, stays
   * down `closed` ticks and shares warn, lower and raise. Sorted by `at`; no two closures' warn to
   * raise windows overlap, nor wrap into the next period's first one (merge them when they would).
   */
  more?: { at: number; closed: number }[];
}

export type GatePhaseName = 'open' | 'warn' | 'lowering' | 'closed' | 'raising';

/** The state of a cycle at one (possibly fractional) tick. */
export interface GatePhase {
  name: GatePhaseName;
  /** Ticks into the current phase. */
  t: number;
  /** Length of the current phase (ticks; open runs to the next warning). */
  len: number;
  /** Arm position: 0 up, 1 down. */
  arm: number;
  /** True while the gates stop cars. */
  blocking: boolean;
  /** Ticks until the gates next start blocking (0 while blocking). */
  untilBlock: number;
  /** Ticks until the current block ends, or the next one does when not blocking. */
  untilClear: number;
  /** Ticks since the current cycle started (-1 before the first cycle). */
  cycleT: number;
}

/** A timed gate across a road: a one sided wall that blocks while its cycle says so. */
export interface TimedGate {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit normal toward the side it holds traffic back on (the approach). */
  nx: number;
  nz: number;
  /** What draws it (the renderer that owns the look). */
  look: WallLook;
  /** Index into GateSet.cycles. */
  cycle: number;
  /** Midpoint and half length (m): the broadphase circle. */
  cx: number;
  cz: number;
  half: number;
}

/** Every timed gate of a world and their schedules, in a fixed order. */
export interface GateSet {
  cycles: GateCycle[];
  gates: TimedGate[];
}

/** Share of the raise the gates still block for: cars wait until the arms are half way up. */
const BLOCK_RAISE_SHARE = 0.5;

/** Ticks of a cycle the gates block for. */
export function blockTicks(c: GateCycle): number {
  return c.closed + c.raise * BLOCK_RAISE_SHARE;
}

/** Ticks since the current cycle started, or -1 before the first one. */
function cycleTime(c: GateCycle, tick: number): number {
  const u = tick - c.start;
  if (u < 0) return -1;
  return u - Math.floor(u / c.period) * c.period;
}

/** True while the gates of cycle `c` stop cars at `tick` (the sim's cheap test). */
export function gateBlocking(c: GateCycle, tick: number): boolean {
  if (c.more) return gatePhase(c, tick, moreScratch).blocking;
  const u = cycleTime(c, tick);
  if (u < 0) return false;
  const b0 = c.warn + c.lower;
  return u >= b0 && u < b0 + blockTicks(c);
}

/** Full state of cycle `c` at a tick (fractional ticks for render times). Writes into `out` when given. */
export function gatePhase(c: GateCycle, tick: number, out?: GatePhase): GatePhase {
  const p: GatePhase = out ?? { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };
  if (c.more) return morePhase(c, tick, p);
  const u = cycleTime(c, tick);
  const b0 = c.warn + c.lower;
  const b1 = b0 + blockTicks(c);
  const closeEnd = b0 + c.closed;
  const raiseEnd = closeEnd + c.raise;
  p.cycleT = u;
  if (u < 0) {
    p.name = 'open';
    p.t = tick;
    p.len = c.start;
    p.arm = 0;
    p.blocking = false;
    p.untilBlock = c.start - tick + b0;
    p.untilClear = p.untilBlock + blockTicks(c);
    return p;
  }
  p.blocking = u >= b0 && u < b1;
  p.untilBlock = p.blocking ? 0 : u < b0 ? b0 - u : c.period - u + b0;
  p.untilClear = p.blocking ? b1 - u : p.untilBlock + blockTicks(c);
  if (u < c.warn) {
    p.name = 'warn';
    p.t = u;
    p.len = c.warn;
    p.arm = 0;
  } else if (u < b0) {
    p.name = 'lowering';
    p.t = u - c.warn;
    p.len = c.lower;
    p.arm = c.lower > 0 ? p.t / c.lower : 1;
  } else if (u < closeEnd) {
    p.name = 'closed';
    p.t = u - b0;
    p.len = c.closed;
    p.arm = 1;
  } else if (u < raiseEnd) {
    p.name = 'raising';
    p.t = u - closeEnd;
    p.len = c.raise;
    p.arm = c.raise > 0 ? 1 - p.t / c.raise : 0;
  } else {
    p.name = 'open';
    p.t = u - raiseEnd;
    p.len = c.period - raiseEnd;
    p.arm = 0;
  }
  return p;
}

const moreScratch: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };

/** Closure k of a cycle with `more`: warning start offset in the period and its closed length (k = 0 is the cycle's own). */
function closureAt(c: GateCycle, k: number): number {
  return k === 0 ? 0 : c.more![k - 1].at;
}
function closureClosed(c: GateCycle, k: number): number {
  return k === 0 ? c.closed : c.more![k - 1].closed;
}

/**
 * gatePhase for a cycle with several closures a period: the phase of the one
 * whose warn to raise window holds the tick, else open, with the times to the
 * next block counted to whichever closure blocks next.
 */
function morePhase(c: GateCycle, tick: number, p: GatePhase): GatePhase {
  const n = 1 + c.more!.length;
  const g = tick - c.start;
  const b0 = c.warn + c.lower;
  p.cycleT = g < 0 ? -1 : g - Math.floor(g / c.period) * c.period;
  // Ticks until closure k next starts blocking (its next occurrence, or the first one).
  const untilBlockOf = (k: number) => {
    const s = closureAt(c, k) + b0 - g;
    if (s >= 0) return s;
    const m = -s - Math.floor(-s / c.period) * c.period;
    return m === 0 ? 0 : c.period - m;
  };
  for (let k = 0; k < n; k++) {
    const u0 = g - closureAt(c, k);
    if (u0 < 0) continue;
    const u = u0 - Math.floor(u0 / c.period) * c.period;
    const closed = closureClosed(c, k);
    const block = closed + c.raise * BLOCK_RAISE_SHARE;
    const closeEnd = b0 + closed;
    const raiseEnd = closeEnd + c.raise;
    if (u >= raiseEnd) continue;
    p.blocking = u >= b0 && u < b0 + block;
    if (p.blocking) {
      p.untilBlock = 0;
      p.untilClear = b0 + block - u;
    } else {
      let next = u < b0 ? b0 - u : Infinity;
      let nextK = k;
      if (u >= b0) {
        for (let j = 0; j < n; j++) {
          const d = untilBlockOf(j);
          if (d > 0 && d < next) {
            next = d;
            nextK = j;
          }
        }
      }
      p.untilBlock = next;
      p.untilClear = next + closureClosed(c, nextK) + c.raise * BLOCK_RAISE_SHARE;
    }
    if (u < c.warn) {
      p.name = 'warn';
      p.t = u;
      p.len = c.warn;
      p.arm = 0;
    } else if (u < b0) {
      p.name = 'lowering';
      p.t = u - c.warn;
      p.len = c.lower;
      p.arm = c.lower > 0 ? p.t / c.lower : 1;
    } else if (u < closeEnd) {
      p.name = 'closed';
      p.t = u - b0;
      p.len = closed;
      p.arm = 1;
    } else {
      p.name = 'raising';
      p.t = u - closeEnd;
      p.len = c.raise;
      p.arm = c.raise > 0 ? 1 - p.t / c.raise : 0;
    }
    return p;
  }
  // Open: until the nearest closure's next block.
  let next = Infinity;
  let nextK = 0;
  for (let k = 0; k < n; k++) {
    const d = untilBlockOf(k);
    if (d < next) {
      next = d;
      nextK = k;
    }
  }
  p.name = 'open';
  p.blocking = false;
  p.arm = 0;
  p.t = 0;
  p.len = next - b0;
  p.untilBlock = next;
  p.untilClear = next + closureClosed(c, nextK) + c.raise * BLOCK_RAISE_SHARE;
  return p;
}

/** A gate from a to b holding traffic back on the side of (nx, nz) (a unit normal of a-b). */
export function makeGate(ax: number, az: number, bx: number, bz: number, nx: number, nz: number, look: WallLook, cycle: number): TimedGate {
  const half = sqrt((bx - ax) ** 2 + (bz - az) ** 2) / 2;
  return { ax, az, bx, bz, nx, nz, look, cycle, cx: (ax + bx) / 2, cz: (az + bz) / 2, half };
}

/** Signed distance (m) of a point in front of a gate's line, positive on its holding side. */
export function gateSide(g: TimedGate, x: number, z: number): number {
  return (x - g.ax) * g.nx + (z - g.az) * g.nz;
}

/**
 * Contacts of one car circle (center x, z, radius r) with the gates blocking
 * at `tick`, for the car whose body center is (carX, carZ). Pushed onto `out`
 * (kind 'barrier', the sound of a gate arm) with -1 onto `pieces` (no rail
 * piece); returns how many were added.
 */
export function collideGates(set: GateSet, tick: number, carX: number, carZ: number, x: number, z: number, r: number, out: Contact[], pieces: number[]): number {
  let added = 0;
  const gates = set.gates;
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i];
    const reach = g.half + r + 3;
    if ((x - g.cx) ** 2 + (z - g.cz) ** 2 > reach * reach) continue;
    if (!gateBlocking(set.cycles[g.cycle], tick)) continue;
    // Only cars coming at it: a car already past the line drives on out.
    if (gateSide(g, carX, carZ) <= 0) continue;
    const t = segmentT(x, z, g.ax, g.az, g.bx, g.bz);
    const px = g.ax + (g.bx - g.ax) * t;
    const pz = g.az + (g.bz - g.az) * t;
    const dx = x - px;
    const dz = z - pz;
    const sd = dx * g.nx + dz * g.nz;
    if (sd >= r) continue;
    let nx = g.nx;
    let nz = g.nz;
    let depth = r - sd;
    if (t <= 0 || t >= 1) {
      // Past an end: push radially, and only when actually overlapping.
      const d = sqrt(dx * dx + dz * dz);
      if (d >= r) continue;
      if (sd > 0 && d > 1e-6) {
        nx = dx / d;
        nz = dz / d;
        depth = r - d;
      }
    }
    out.push({ nx, nz, depth, px, pz, kind: 'barrier' });
    pieces.push(-1);
    added++;
  }
  return added;
}

/** How racers treat timed gates. Distances in m, times in s. */
export const GATE_AI = {
  /** Gates are looked for this far ahead of the car's center. */
  range: 170,
  /** A car heading at a gate within this lateral reach of its ends still counts (m). */
  endReach: 1,
  /** Minimum share of the heading pointing at the gate's holding side for it to count. */
  facing: 0.3,
  /** The nose stops this far short of the gate line. */
  stopGap: 1.6,
  /** Braking the stop is planned with (m/s^2), a little under AI.brakeDecel so it never overshoots. */
  decel: 6.4,
  /** A car carries on when it reaches the line at least this long before the gates block. */
  commit: 0.6,
  /** Arrival time estimates never assume less speed than this (m/s). */
  minSpeed: 6,
  /** Cars ahead slower than this (m/s: stopping or stopped) within this lateral reach (beyond both half widths) queue it, this far behind them. */
  queueSpeed: 4,
  laneSlack: 0.45,
  queueGap: 1.4,
  /** It counts as waiting (stuck and reverse-out logic off) within this distance of its stop point. */
  waitReach: 30,
  /** Brake held at a standstill (under the 0.5 that would engage reverse). */
  holdBrake: 0.45,
  /** waitingAtGate: within this far in front of a gate that is not open, below this speed (m/s). */
  holdReach: 45,
  holdSpeed: 4,
} as const;

/** Result of gateSpeedCap: the speed to stay under (m/s, Infinity = none) and whether the car is waiting. */
export interface GateWait {
  cap: number;
  waiting: boolean;
}

const phaseScratch: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };

/**
 * Speed cap for a racer approaching timed gates: stop the nose GATE_AI.stopGap
 * short of a gate that will be blocking when the car reaches it (or behind the
 * cars stopping or stopped in its lane), on a constant deceleration profile. A car
 * that reaches the line comfortably before the block, or only after it ends,
 * is left alone. Reads race state only; writes `out`.
 */
export function gateSpeedCap(r: RaceState, rc: RaceCar, out: GateWait): GateWait {
  out.cap = Infinity;
  out.waiting = false;
  const set = r.world.timedGates;
  if (!set || !set.gates.length) return out;
  const c = rc.state;
  const g0 = rc.tuning.geometry;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  for (const g of set.gates) {
    const reach = GATE_AI.range + g.half;
    if ((c.x - g.cx) ** 2 + (c.z - g.cz) ** 2 > reach * reach) continue;
    const sd = gateSide(g, c.x, c.z);
    if (sd <= 0 || sd > GATE_AI.range) continue;
    const facing = -(fx * g.nx + fz * g.nz);
    if (facing < GATE_AI.facing) continue;
    // Where the heading meets the gate line: inside its span (plus a little at the ends)?
    const along = sd / facing;
    const hx = c.x + fx * along;
    const hz = c.z + fz * along;
    const len = 2 * g.half || 1;
    const t = ((hx - g.ax) * (g.bx - g.ax) + (hz - g.az) * (g.bz - g.az)) / (len * len);
    const slack = GATE_AI.endReach / len;
    if (t < -slack || t > 1 + slack) continue;
    const p = gatePhase(set.cycles[g.cycle], r.tick, phaseScratch);
    if (!p.blocking) {
      const eta = along / Math.max(c.speed, GATE_AI.minSpeed);
      if (eta < p.untilBlock / TICK_HZ - GATE_AI.commit) continue;
      if (eta > p.untilClear / TICK_HZ) continue;
    }
    // Stop point for the car's center along its heading: short of the line, or behind the queue.
    let stop = along - g0.halfLength - GATE_AI.stopGap;
    for (const o of r.cars) {
      if (o === rc || o.finished || o.state.speed > GATE_AI.queueSpeed) continue;
      const dx = o.state.x - c.x;
      const dz = o.state.z - c.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > along + 2) continue;
      const lat = Math.abs(dx * fz - dz * fx);
      if (lat > g0.halfWidth + o.tuning.geometry.halfWidth + GATE_AI.laneSlack) continue;
      stop = Math.min(stop, ahead - (g0.halfLength + o.tuning.geometry.halfLength + GATE_AI.queueGap));
    }
    const cap = sqrt(2 * GATE_AI.decel * Math.max(0, stop));
    if (cap < out.cap) out.cap = cap;
    if (stop < GATE_AI.waitReach) out.waiting = true;
  }
  return out;
}

/**
 * True when a car at (x, z) moving at `speed` (m/s) waits in front of a timed
 * gate that is not open (warning, coming down, down or going up): it is held
 * there, not lost, so the race's stuck timer leaves it alone.
 */
export function waitingAtGate(set: GateSet | undefined, tick: number, x: number, z: number, speed: number): boolean {
  if (!set || speed > GATE_AI.holdSpeed) return false;
  for (const g of set.gates) {
    const reach = GATE_AI.holdReach + g.half;
    if ((x - g.cx) ** 2 + (z - g.cz) ** 2 > reach * reach) continue;
    const sd = gateSide(g, x, z);
    if (sd <= 0 || sd > GATE_AI.holdReach) continue;
    const t = segmentT(x, z, g.ax, g.az, g.bx, g.bz);
    if (t <= 0 || t >= 1) continue;
    const p = gatePhase(set.cycles[g.cycle], tick, phaseScratch);
    if (p.name !== 'open') return true;
  }
  return false;
}

/** The nearest gate a car at (x, z) heading (fx, fz) is coming at within `range` m: index and distance to its line, or null. */
export function gateAhead(set: GateSet | undefined, x: number, z: number, fx: number, fz: number, range: number): { gate: number; dist: number } | null {
  if (!set) return null;
  let gate = -1;
  let dist = Infinity;
  for (let i = 0; i < set.gates.length; i++) {
    const g = set.gates[i];
    const sd = gateSide(g, x, z);
    if (sd <= 0 || sd > range) continue;
    const facing = -(fx * g.nx + fz * g.nz);
    if (facing < GATE_AI.facing) continue;
    const along = sd / facing;
    const hx = x + fx * along;
    const hz = z + fz * along;
    const t = segmentT(hx, hz, g.ax, g.az, g.bx, g.bz);
    if ((hx - (g.ax + (g.bx - g.ax) * t)) ** 2 + (hz - (g.az + (g.bz - g.az) * t)) ** 2 > (GATE_AI.endReach + 2) ** 2) continue;
    if (along < dist) {
      gate = i;
      dist = along;
    }
  }
  return gate >= 0 ? { gate, dist } : null;
}
