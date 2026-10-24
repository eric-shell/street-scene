/**
 * Racecraft: how a rival drives against the other cars. Given the line it follows and the steering target
 * on it, racecraft says what lateral offset to steer for (passing, blocking, giving room, following a car
 * it cannot pass), the speed cap that costs it and the car alongside it must not close on. Reads the race,
 * writes only the Craft scratch it is handed and the AI's own memory (passCar, passSide).
 */
import type { RaceCar, RaceState } from '../race';
import { abs, clamp, cos, lerp, sin, sqrt, wrapIndex } from '../math';
import { DRIVER } from './drivers';
import { type RacingLine, turnAhead } from './racingLine';

/**
 * What racecraft asks for: the lateral offset from the line to steer for, null
 * to drive the line, a speed cap (m/s), and the car alongside (null for none),
 * which side (m, left positive) and how near it may come.
 */
export interface Craft {
  target: number | null;
  cap: number;
  passing: boolean;
  /** Following close behind a moving car it cannot pass: a queue, not a car stuck. */
  queued: boolean;
  beside: RaceCar | null;
  besideSide: number;
  besideAhead: number;
  besideGap: number;
}

/** Scratch for racecraft (one AI car at a time). */
export const craft: Craft = { target: null, cap: Infinity, passing: false, queued: false, beside: null, besideSide: 0, besideAhead: 0, besideGap: 0 };

/**
 * Racecraft against the other racers. A pass in hand holds its side until the
 * car is behind. A slower car in the path ahead is passed on the side with the
 * room (both: the inside of the next corner from DRIVER.diveFrom, otherwise the
 * nearer way round); a patient driver waits out a braking zone, and with no
 * room either side it follows at its time gap. With nobody to pass, an
 * aggressive driver leans toward a car closing from behind and a calm one gives
 * room to a car alongside. Nobody closes in on a car alongside.
 */
export function racecraft(r: RaceState, rc: RaceCar, line: RacingLine, i0: number, ti: number, out: Craft): Craft {
  const ai = rc.ai!;
  const a = ai.driver.aggression;
  const c = rc.state;
  const g = rc.tuning.geometry;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  out.target = null;
  out.cap = Infinity;
  out.passing = false;
  out.queued = false;
  out.beside = null;
  // Where the car sits across its own line (m, left positive): the others' offsets are measured from it.
  const myOff = (c.x - line.x[i0]) * line.nx[i0] + (c.z - line.z[i0]) * line.nz[i0];
  const look = lerp(DRIVER.passLook[0], DRIVER.passLook[1], a);
  const clear = lerp(DRIVER.passClear[0], DRIVER.passClear[1], a);
  const squeeze = lerp(DRIVER.squeeze[0], DRIVER.squeeze[1], a);
  // The road either side at the steering target, as offsets from the line.
  const left = line.hi[ti] - line.offset[ti] + squeeze;
  const right = line.lo[ti] - line.offset[ti] - squeeze;
  let front: RaceCar | null = null;
  let frontAhead = Infinity;
  let frontOff = 0;
  let passed: RaceCar | null = null;
  let passAhead = 0;
  let passOff = 0;
  let chaserOff = 0;
  let chaserAhead = -Infinity;
  let besideOff = 0;
  let besideReach = 0;
  let besideSide = Infinity;
  let besideAhead = 0;
  let besideCar: RaceCar | null = null;
  for (const o of r.cars) {
    if (o === rc || o.finished) continue;
    const dx = o.state.x - c.x;
    const dz = o.state.z - c.z;
    const ahead = dx * fx + dz * fz;
    const side = dx * fz - dz * fx; // positive = other is to our left
    const off = myOff + side;
    const reach = g.halfWidth + o.tuning.geometry.halfWidth;
    const len = g.halfLength + o.tuning.geometry.halfLength;
    if (o.index === ai.passCar) {
      passed = o;
      passAhead = ahead;
      passOff = off;
    }
    // In the path: on its line, or where it is steering, and not pulling away.
    if (ahead > 0 && ahead < DRIVER.followLook && ahead < frontAhead && (abs(off) < reach + 0.5 || abs(off - ai.dodge) < reach + 0.5) && o.state.speed < c.speed + 2) {
      front = o;
      frontAhead = ahead;
      frontOff = off;
    }
    if (ahead < -len && ahead > -DRIVER.blockRange && ahead > chaserAhead && abs(side) < reach + 2.5 && o.state.speed > c.speed + 0.5) {
      chaserAhead = ahead;
      chaserOff = off;
    }
    if (abs(ahead) < len + 1 && abs(side) < reach + 1.5 && abs(side) < abs(besideSide)) {
      besideSide = side;
      besideAhead = ahead;
      besideOff = off;
      besideReach = reach;
      besideCar = o;
    }
  }
  // A pass in hand: hold the side until the car is behind, unless the road closes it off or someone else is in the way.
  if (passed && (!front || front === passed)) {
    const og = passed.tuning.geometry;
    const reach = g.halfWidth + og.halfWidth;
    const target = passOff + ai.passSide * (reach + clear);
    if (passAhead > -(g.halfLength + og.halfLength + DRIVER.passDone) && passAhead < look + 10 && target <= left && target >= right && clearAt(r, line, i0, ti, target, g.halfWidth + DRIVER.wallClear, c.y)) {
      out.target = target;
      out.passing = true;
      if (passAhead > g.halfLength + og.halfLength) out.cap = passed.state.speed + lerp(DRIVER.passDelta[0], DRIVER.passDelta[1], a);
    }
  }
  if (!out.passing) ai.passCar = -1;
  if (!out.passing && front) {
    const reach = g.halfWidth + front.tuning.geometry.halfWidth;
    const lt = frontOff + reach + clear;
    const rt = frontOff - reach - clear;
    const canL = lt <= left && clearAt(r, line, i0, ti, lt, g.halfWidth + DRIVER.wallClear, c.y);
    const canR = rt >= right && clearAt(r, line, i0, ti, rt, g.halfWidth + DRIVER.wallClear, c.y);
    // Closing on it: no faster than lets it brake down to its speed at the gap it keeps.
    const keep = DRIVER.followMin + front.state.speed * lerp(DRIVER.followGap[0], DRIVER.followGap[1], a);
    const gap = frontAhead - g.halfLength - front.tuning.geometry.halfLength;
    const follow = sqrt(front.state.speed * front.state.speed + 2 * DRIVER.followDecel * Math.max(0, gap - keep));
    let side = 0;
    // Into a bottleneck (an alley, a lane closure, a bridge) nobody goes two abreast.
    let narrow = false;
    for (let k = 0; k <= DRIVER.narrowLook && !narrow; k += 2) {
      const j = wrapIndex(i0 + k, line.n, line.closed);
      narrow = line.hi[j] - line.lo[j] < DRIVER.narrowRoom;
    }
    if (frontAhead >= look || narrow) side = 0;
    else if (canL && canR) {
      const turn = turnAhead(line, i0, 10);
      if (a >= DRIVER.diveFrom && abs(turn) > DRIVER.straight) side = turn > 0 ? 1 : -1;
      else side = abs(lt - myOff) < abs(rt - myOff) ? 1 : abs(lt - myOff) > abs(rt - myOff) ? -1 : ai.driver.side >= 0 ? 1 : -1;
    } else if (canL) side = 1;
    else if (canR) side = -1;
    const wait = a < DRIVER.patient && line.speed[wrapIndex(i0 + 10, line.n, line.closed)] * ai.pace < c.speed * DRIVER.brakeZone;
    if (side !== 0 && !wait) {
      ai.passCar = front.index;
      ai.passSide = side;
      out.target = side > 0 ? lt : rt;
      out.passing = true;
      // Still behind it while pulling out: no running into it, and no flying by a car that could still move over.
      out.cap = front.state.speed + lerp(DRIVER.passDelta[0], DRIVER.passDelta[1], a);
      if (abs(frontOff - myOff) < reach) out.cap = Math.min(out.cap, sqrt(front.state.speed * front.state.speed + 2 * DRIVER.followDecel * Math.max(0, gap - DRIVER.followMin)));
    } else if (front.state.speed > DRIVER.followSpeed || frontAhead >= look || (narrow && front.state.speed > DRIVER.yieldMin)) {
      out.cap = follow;
      out.queued = gap < DRIVER.queueGap && front.state.speed > DRIVER.yieldMin;
    } else {
      // Crashed or crawling: round it on the roomier side, room or not.
      out.target = left - frontOff > frontOff - right ? lt : rt;
    }
  }
  if (out.target === null && chaserAhead > -Infinity && a > DRIVER.blockFrom) {
    const reach = (DRIVER.blockMax * (a - DRIVER.blockFrom)) / (1 - DRIVER.blockFrom);
    out.target = clamp(chaserOff, -reach, reach);
  }
  const alongside = besideSide !== Infinity;
  if (out.target === null && alongside && a < DRIVER.giveFrom) {
    const give = DRIVER.giveRoom * (1 - a / DRIVER.giveFrom);
    out.target = besideSide > 0 ? Math.min(0, besideOff - besideReach - give) : Math.max(0, besideOff + besideReach + give);
  }
  if (alongside) {
    const gap = besideReach + lerp(DRIVER.sideGap[0], DRIVER.sideGap[1], a);
    const t = out.target ?? ai.dodge;
    out.target = besideSide > 0 ? Math.min(t, Math.max(besideOff - gap, Math.min(t, -DRIVER.holdOff))) : Math.max(t, Math.min(besideOff + gap, Math.max(t, DRIVER.holdOff)));
    out.beside = besideCar;
    out.besideSide = besideSide;
    out.besideAhead = besideAhead;
    out.besideGap = gap;
  }
  return out;
}

/** Clear of walls by `room` (m) at `extra` off the line, at the steering target and halfway to it. */
function clearAt(r: RaceState, line: RacingLine, i0: number, ti: number, extra: number, room: number, y: number): boolean {
  const mid = wrapIndex(i0 + Math.round((((ti - i0) % line.n) + line.n) % line.n / 2), line.n, line.closed);
  for (const i of [ti, mid]) if (r.world.wallClearance(line.x[i] + line.nx[i] * (extra + line.offset[ti] - line.offset[i]), line.z[i] + line.nz[i] * (extra + line.offset[ti] - line.offset[i]), room + 0.1, y) < room) return false;
  return true;
}
