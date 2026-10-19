/**
 * Deterministic AI drivers. They follow a racing line smoothed from the route
 * centerline within the road width, aim for curvature based target speeds with
 * a braking lookahead, use nitrous on straights, dodge each other with lateral
 * offsets and get mild rubber banding computed purely from race state.
 */
import type { World } from '../city/world';
import type { RaceCar, RaceState } from './race';
import { InputFrame, NEUTRAL_INPUT } from './input';
import { DEG, abs, approach, atan2, clamp, cos, lerp, sin, sqrt } from './math';
import { GRAVITY } from './tuning';
import { DT } from './constants';
import { routeSample } from '../city/route';

export const AI = {
  spacing: 4,
  edgeMargin: 2.3,
  smoothIterations: 80,
  lateralGrip: 0.9,
  brakeDecel: 7.2,
  maxSpeed: 95,
  lookaheadBase: 7,
  lookaheadPerSpeed: 0.42,
  rubberBandRange: 160,
  rubberBandSlow: 0.9,
  rubberBandFast: 1.05,
  dodgeOffset: 2.6,
  dodgeRate: 3,
  stuckSpeed: 1.5,
  stuckTime: 2.5,
  progressWindow: 4,
  progressMin: 8,
} as const;

export interface RacingLine {
  n: number;
  closed: boolean;
  x: Float64Array;
  z: Float64Array;
  /** Route s of the sample's centerline point. */
  s: Float64Array;
  /** Unit left normal of the centerline. */
  nx: Float64Array;
  nz: Float64Array;
  /** Max lateral offset allowed from the line (to stay in the road). */
  room: Float64Array;
  /** Lateral offset of the line from the centerline. */
  offset: Float64Array;
  speed: Float64Array;
}

export interface AiState {
  idx: number;
  pace: number;
  bias: number;
  dodge: number;
  stuckTime: number;
  nitroHold: number;
  /** Progress watchdog: distance at the last checkpoint of the timer. */
  watchDist: number;
  watchTime: number;
}

export function createAi(index: number, pace: number): AiState {
  // Small fixed personality per grid slot, no randomness needed.
  const bias = (((index * 37) % 5) - 2) * 0.35;
  return { idx: -1, pace: pace * (1 - ((index * 13) % 3) * 0.012), bias, dodge: 0, stuckTime: 0, nitroHold: 0, watchDist: -1e9, watchTime: 0 };
}

export function buildRacingLine(world: World): RacingLine {
  const route = world.route;
  const start = route.closed ? 0 : 0;
  const end = route.closed ? route.length : route.length;
  const n = Math.max(8, Math.floor((end - start) / AI.spacing) + (route.closed ? 0 : 1));
  const step = (end - start) / (route.closed ? n : n - 1);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  const s = new Float64Array(n);
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  const room = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const si = start + i * step;
    const p = routeSample(route, si);
    cx[i] = p.x;
    cz[i] = p.z;
    s[i] = si;
    room[i] = route.segWidth[p.seg] / 2 - AI.edgeMargin;
  }
  // Normals from neighbors (smooth across corners).
  for (let i = 0; i < n; i++) {
    const a = route.closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = route.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const dx = cx[b] - cx[a];
    const dz = cz[b] - cz[a];
    const l = sqrt(dx * dx + dz * dz) || 1;
    nx[i] = dz / l;
    nz[i] = -dx / l;
  }
  // Corners: the road is narrower in the polyline sense right at a node; use min of neighbors.
  const roomMin = Float64Array.from(room);
  for (let i = 0; i < n; i++) {
    for (let k = -2; k <= 2; k++) {
      const j = route.closed ? (i + k + n) % n : clamp(i + k, 0, n - 1);
      roomMin[i] = Math.min(roomMin[i], room[j]);
    }
  }
  // Relax toward a smooth line, constrained to the road.
  const off = new Float64Array(n);
  const px = Float64Array.from(cx);
  const pz = Float64Array.from(cz);
  for (let it = 0; it < AI.smoothIterations; it++) {
    for (let i = 0; i < n; i++) {
      if (!route.closed && (i === 0 || i === n - 1)) continue;
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const mx = (px[a] + px[b]) / 2;
      const mz = (pz[a] + pz[b]) / 2;
      const o = clamp((mx - cx[i]) * nx[i] + (mz - cz[i]) * nz[i], -roomMin[i], roomMin[i]);
      off[i] = o;
      px[i] = cx[i] + nx[i] * o;
      pz[i] = cz[i] + nz[i] * o;
    }
  }
  // Target speeds from curvature, then a backward braking pass.
  const speed = new Float64Array(n);
  const span = 3;
  for (let i = 0; i < n; i++) {
    const a = route.closed ? (i - span + n) % n : Math.max(0, i - span);
    const b = route.closed ? (i + span) % n : Math.min(n - 1, i + span);
    const k = curvature(px[a], pz[a], px[i], pz[i], px[b], pz[b]);
    speed[i] = k > 1e-5 ? Math.min(AI.maxSpeed, sqrt((AI.lateralGrip * GRAVITY) / k)) : AI.maxSpeed;
  }
  const passes = route.closed ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = n - 2 + (route.closed ? 1 : 0); i >= 0; i--) {
      const nextI = (i + 1) % n;
      const ds = AI.spacing;
      speed[i] = Math.min(speed[i], sqrt(speed[nextI] * speed[nextI] + 2 * AI.brakeDecel * ds));
    }
  }
  return { n, closed: route.closed, x: px, z: pz, s, nx, nz, room: roomMin, offset: off, speed };
}

function curvature(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const bcx = cx - bx;
  const bcz = cz - bz;
  const cross = abs(abx * bcz - abz * bcx);
  const la = sqrt(abx * abx + abz * abz);
  const lb = sqrt(bcx * bcx + bcz * bcz);
  const lc = sqrt((cx - ax) ** 2 + (cz - az) ** 2);
  const den = la * lb * lc;
  return den > 1e-9 ? (2 * cross) / den : 0;
}

function wrapIdx(line: RacingLine, i: number): number {
  return line.closed ? ((i % line.n) + line.n) % line.n : clamp(i, 0, line.n - 1);
}

function nearestIdx(line: RacingLine, x: number, z: number, hint: number): number {
  let best = 0;
  let bestD = Infinity;
  if (hint < 0) {
    for (let i = 0; i < line.n; i++) {
      const d = (line.x[i] - x) ** 2 + (line.z[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
  for (let k = -6; k <= 14; k++) {
    const i = wrapIdx(line, hint + k);
    const d = (line.x[i] - x) ** 2 + (line.z[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Compute this tick's input for an AI car. Reads race state, mutates only the AI's own memory. */
export function aiInput(r: RaceState, rc: RaceCar): InputFrame {
  const ai = rc.ai!;
  const c = rc.state;
  const line = r.line;
  const racing = r.tick >= r.countdownTicks;
  if (!racing) return { ...NEUTRAL_INPUT, throttle: 0.55 };
  if (rc.finished) return { ...NEUTRAL_INPUT, throttle: 0.35, steer: steerToward(r, rc, 0.5) };

  ai.idx = nearestIdx(line, c.x, c.z, ai.idx);
  const speed = c.speed;

  // Rubber banding from progress relative to the player.
  const player = r.cars[0];
  const gap = rc.dist - player.dist;
  const band = gap > 0 ? lerp(1, AI.rubberBandSlow, clamp(gap / AI.rubberBandRange, 0, 1)) : lerp(1, AI.rubberBandFast, clamp(-gap / AI.rubberBandRange, 0, 1));
  const pace = ai.pace * band;

  // Dodge cars ahead.
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  let dodgeTarget = 0;
  for (const other of r.cars) {
    if (other === rc || other.finished) continue;
    const dx = other.state.x - c.x;
    const dz = other.state.z - c.z;
    const ahead = dx * fx + dz * fz;
    const side = dx * fz - dz * fx; // positive = other is to our left
    if (ahead > 0 && ahead < 22 && abs(side) < 2.6 && other.state.speed < speed + 2) {
      dodgeTarget = side > 0 ? -AI.dodgeOffset : AI.dodgeOffset;
      break;
    }
  }
  ai.dodge = approach(ai.dodge, dodgeTarget, AI.dodgeRate * DT);

  const look = AI.lookaheadBase + speed * AI.lookaheadPerSpeed;
  const ti = wrapIdx(line, ai.idx + Math.round(look / AI.spacing));
  const extra = clamp(ai.bias + ai.dodge, -line.room[ti] - line.offset[ti], line.room[ti] - line.offset[ti]);
  const tx = line.x[ti] + line.nx[ti] * extra;
  const tz = line.z[ti] + line.nz[ti] * extra;
  const steer = pursuitSteer(rc, tx, tz);

  // Speed control: look a little ahead for the binding limit.
  let vt = Infinity;
  for (let k = 0; k <= 3; k++) vt = Math.min(vt, line.speed[wrapIdx(line, ai.idx + k)]);
  vt *= pace;
  const err = vt - speed;
  let throttle = 0;
  let brake = 0;
  if (err > 0) throttle = clamp(0.35 + err / 4, 0, 1) * (1 - 0.45 * abs(steer));
  else brake = clamp(-err / 2.5, 0, 1);
  if (brake > 0.15) throttle = 0;
  // Ease off when sliding badly.
  if (abs(c.slipAngle) > 20 * DEG) throttle *= 0.5;

  // Nitrous on straights.
  const far = line.speed[wrapIdx(line, ai.idx + 25)] * pace;
  let nitrous = false;
  if (ai.nitroHold > 0) {
    ai.nitroHold -= DT;
    nitrous = c.nitro > 0.02 && err > 1;
  } else if (c.nitro > 0.35 && err > 6 && far > speed + 8 && abs(steer) < 0.25 && speed > 15) {
    ai.nitroHold = 1.2;
    nitrous = true;
  }

  // Stuck: too slow, or not making progress (e.g. scraping a wall), lets the race reset us.
  if (speed < AI.stuckSpeed) ai.stuckTime += DT;
  else ai.stuckTime = 0;
  ai.watchTime += DT;
  let noProgress = false;
  if (ai.watchTime >= AI.progressWindow) {
    noProgress = rc.dist - ai.watchDist < AI.progressMin;
    ai.watchDist = rc.dist;
    ai.watchTime = 0;
  }
  const reset = ai.stuckTime > AI.stuckTime || rc.wrongWayTime > 3 || noProgress;
  if (reset) {
    ai.stuckTime = 0;
    ai.watchTime = 0;
    ai.watchDist = rc.dist;
  }

  return { throttle, brake, steer, handbrake: false, nitrous, shift: 0, reset };
}

function pursuitSteer(rc: RaceCar, tx: number, tz: number): number {
  const c = rc.state;
  const t = rc.tuning;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const dx = tx - c.x;
  const dz = tz - c.z;
  const u = dx * fx + dz * fz;
  const v = dx * fz - dz * fx; // left positive
  const d2 = u * u + v * v;
  if (d2 < 1e-6) return 0;
  const k = (2 * v) / d2;
  const delta = atan2(k * t.geometry.wheelbase, 1);
  const limit = lerp(t.steering.maxDeg, t.steering.highSpeedDeg, clamp(c.speed / t.steering.fadeSpeed, 0, 1)) * DEG;
  // also counter the body slip a bit
  return clamp(-(delta - c.slipAngle * 0.3) / limit, -1, 1);
}

function steerToward(r: RaceState, rc: RaceCar, _gain: number): number {
  const line = r.line;
  const ai = rc.ai!;
  ai.idx = nearestIdx(line, rc.state.x, rc.state.z, ai.idx);
  const ti = wrapIdx(line, ai.idx + 4);
  return pursuitSteer(rc, line.x[ti], line.z[ti]);
}

/** Autopilot for tests and attract mode: drive any race car like an AI. */
export function autopilotInput(r: RaceState, rc: RaceCar, ai: AiState): InputFrame {
  const saved = rc.ai;
  rc.ai = ai;
  const inp = aiInput(r, rc);
  rc.ai = saved;
  return inp;
}
