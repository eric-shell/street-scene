/**
 * Deterministic AI drivers. They follow a racing line smoothed from the route
 * centerline within the road width (narrowed past lane closures, so they
 * swing round the roadworks), aim for curvature based target speeds with
 * a braking lookahead, use nitrous on straights, dodge each other with lateral
 * offsets and get mild rubber banding computed purely from race state.
 * Steering counter steers body slip (wheels toward the direction of travel),
 * brakes ease off with steering lock so they never trail brake into a spin,
 * and a car pinned nose in against a wall, rail, barrier or car reverses out
 * with the nose swinging toward the line before the stuck reset kicks in.
 * Timed gates (a drawbridge going up, sim/gates.ts): they brake to a stop
 * short of one that will be down when they get there, queue behind the cars
 * already waiting and hold still, with the stuck and reverse-out logic off.
 */
import type { World } from '../city/world';
import type { RaceCar, RaceState } from './race';
import { InputFrame, NEUTRAL_INPUT } from './input';
import { DEG, abs, approach, atan2, clamp, cos, lerp, sign, sin, sqrt } from './math';
import { GRAVITY } from './tuning';
import { DT } from './constants';
import { routeSample } from '../city/route';
import { trafficAhead } from './traffic';
import { GATE_AI, GateWait, gateSpeedCap } from './gates';
import { laneClosures } from '../city/districts/roadworks';

export const AI = {
  spacing: 4,
  edgeMargin: 2.3,
  smoothIterations: 80,
  lateralGrip: 0.9,
  /** Braking the speed profile plans with (m/s^2): about half what full brake (tires plus assist) does. */
  brakeDecel: 10,
  /** m/s over the profile speed that asks for full brake. */
  brakeSpan: 5,
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
  /** Recovery: pressing on below this speed (m/s) for blockedTime (s) means nose in against something. */
  blockedSpeed: 1.8,
  blockedTime: 0.45,
  /** Gap (m) at the nose below which the car counts as nose in against a wall. */
  noseClear: 0.5,
  /** Then reverse out, steering the nose toward the line, for up to this long (s). */
  reverseTime: 1.6,
  /** Reverse at least this long (s) before driving off once the nose points at the line within reverseDoneDeg. */
  reverseMin: 0.55,
  reverseDoneDeg: 25,
  /** Sliding: above this body slip (deg) counter steer harder, feather the throttle and ease the brake. */
  slideDeg: 12,
  /** Counter steer per rad of body slip, always (wheels toward the direction of travel) and extra while sliding. */
  slipCounter: 0.3,
  slideCounter: 0.4,
  /** Brake eased off by this share at full steering lock (no trail braking into a slide). */
  brakeSteerRelief: 0.55,
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
  /** Offset bounds from the centerline (m): -room and room, narrowed on the closed side past a lane closure. */
  lo: Float64Array;
  hi: Float64Array;
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
  /** Seconds spent pressing on without moving (nose in against a wall, car or barrier). */
  blocked: number;
  /** Seconds left reversing out (0 = driving normally), time reversed so far and the reverse steer. */
  reverse: number;
  reversed: number;
  reverseSteer: number;
}

/** Scratch for gateSpeedCap (one AI car at a time). */
const gateWait: GateWait = { cap: Infinity, waiting: false };

export function createAi(index: number, pace: number): AiState {
  // Small fixed personality per grid slot, no randomness needed.
  const bias = (((index * 37) % 5) - 2) * 0.35;
  return { idx: -1, pace: pace * (1 - ((index * 13) % 3) * 0.012), bias, dodge: 0, stuckTime: 0, nitroHold: 0, watchDist: -1e9, watchTime: 0, blocked: 0, reverse: 0, reversed: 0, reverseSteer: 0 };
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
  // Lane closures (roadworks) take the closed side's room away along their stretch.
  const lo = roomMin.map((v) => -v);
  const hi = Float64Array.from(roomMin);
  for (const c of laneClosures(world.areas ?? [], world.graph)) {
    for (let i = 0; i < n; i++) {
      const rx = cx[i] - c.ax;
      const rz = cz[i] - c.az;
      const along = rx * c.dx + rz * c.dz;
      const lat = rx * c.nx + rz * c.nz;
      // On that street's carriageway, within the stretch; the line's normal says which offset side is closed.
      if (along < c.s0 || along > c.s1 || abs(lat) > c.half) continue;
      const dot = c.nx * nx[i] + c.nz * nz[i];
      if (dot > 0.7) hi[i] = Math.min(hi[i], c.keep);
      else if (dot < -0.7) lo[i] = Math.max(lo[i], -c.keep);
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
      const o = clamp((mx - cx[i]) * nx[i] + (mz - cz[i]) * nz[i], lo[i], hi[i]);
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
  return { n, closed: route.closed, x: px, z: pz, s, nx, nz, room: roomMin, lo, hi, offset: off, speed };
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
  // Ambient traffic keeps off the route, but a car pushed out among it dodges it the same way.
  if (dodgeTarget === 0) {
    const side = trafficAhead(r, c.x, c.z, fx, fz, 22, 1.7);
    if (side) dodgeTarget = side > 0 ? -AI.dodgeOffset : AI.dodgeOffset;
  }
  ai.dodge = approach(ai.dodge, dodgeTarget, AI.dodgeRate * DT);

  const look = AI.lookaheadBase + speed * AI.lookaheadPerSpeed;
  const ti = wrapIdx(line, ai.idx + Math.round(look / AI.spacing));
  const extra = clamp(ai.bias + ai.dodge, line.lo[ti] - line.offset[ti], line.hi[ti] - line.offset[ti]);
  const tx = line.x[ti] + line.nx[ti] * extra;
  const tz = line.z[ti] + line.nz[ti] * extra;
  let steer = pursuitSteer(rc, tx, tz);
  const sliding = abs(c.slipAngle) > AI.slideDeg * DEG && speed > 6;
  // Catch slides: extra counter steer toward the direction of travel.
  if (sliding) steer = clamp(steer - (c.slipAngle * AI.slideCounter) / (rc.tuning.steering.maxDeg * DEG), -1, 1);

  // Speed control: look a little ahead for the binding limit.
  let vt = Infinity;
  for (let k = 0; k <= 3; k++) vt = Math.min(vt, line.speed[wrapIdx(line, ai.idx + k)]);
  vt *= pace;
  // Timed gates: stop short of one that will be down on arrival, behind any queue.
  const gate = gateSpeedCap(r, rc, gateWait);
  vt = Math.min(vt, gate.cap);
  const err = vt - speed;
  let throttle = 0;
  let brake = 0;
  if (err > 0) throttle = clamp(0.35 + err / 4, 0, 1) * (1 - 0.45 * abs(steer));
  else brake = clamp(-err / AI.brakeSpan, 0, 1) * (1 - AI.brakeSteerRelief * abs(steer));
  if (brake > 0.15) throttle = 0;
  // Ease off when sliding: feather the throttle, never stamp on the brakes mid slide.
  if (sliding) {
    throttle *= 0.45;
    brake = Math.min(brake, 0.35);
  }
  // Waiting at a closed gate: hold the car still.
  if (gate.waiting && gate.cap < 0.5 && speed < 1.5) {
    throttle = 0;
    brake = Math.max(brake, GATE_AI.holdBrake);
  }

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

  // Nose in against something: back out, steering so the nose swings toward the line.
  const recover = gate.waiting ? null : recoverInput(r, rc, steer, throttle, tx, tz);
  if (recover) {
    throttle = recover.throttle;
    brake = recover.brake;
    steer = recover.steer;
    nitrous = false;
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
  if (gate.waiting) {
    // Held at a gate: not stuck, not pinned, no progress expected.
    ai.stuckTime = 0;
    ai.watchTime = 0;
    ai.watchDist = rc.dist;
    ai.blocked = 0;
    noProgress = false;
  }
  const reset = ai.stuckTime > AI.stuckTime || rc.wrongWayTime > 3 || noProgress;
  if (reset) {
    ai.stuckTime = 0;
    ai.watchTime = 0;
    ai.watchDist = rc.dist;
  }

  return { throttle, brake, steer, handbrake: false, nitrous, shift: 0, reset };
}

/**
 * Reverse-out recovery. Pressing on below blockedSpeed for blockedTime means
 * the car is pinned (nose in against a wall, rail, barrier or another car):
 * brake into reverse with the steering flipped so the nose swings toward the
 * target, until it points at it (after reverseMin) or reverseTime runs out.
 * Returns the override, or null when driving normally.
 */
function recoverInput(r: RaceState, rc: RaceCar, steer: number, throttle: number, tx: number, tz: number): { throttle: number; brake: number; steer: number } | null {
  const ai = rc.ai!;
  const c = rc.state;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const dx = tx - c.x;
  const dz = tz - c.z;
  // Heading error to the target, positive = target to the left.
  const herr = atan2(dx * fz - dz * fx, dx * fx + dz * fz);
  if (ai.reverse > 0) {
    ai.reverse -= DT;
    ai.reversed += DT;
    if (ai.reverse <= 0 || (ai.reversed > AI.reverseMin && abs(herr) < AI.reverseDoneDeg * DEG)) {
      ai.reverse = 0;
      ai.blocked = 0;
      return null;
    }
    return { throttle: 0, brake: 1, steer: ai.reverseSteer };
  }
  if (c.gear > 0 && throttle > 0.25 && c.speed < AI.blockedSpeed && r.tick >= r.countdownTicks && noseBlocked(r, rc)) ai.blocked += DT;
  else ai.blocked = Math.max(0, ai.blocked - DT * 2);
  if (ai.blocked < AI.blockedTime) return null;
  ai.blocked = 0;
  ai.reverse = AI.reverseTime;
  ai.reversed = 0;
  // Reversing, positive steer (right) swings the nose left: steer toward the target side.
  ai.reverseSteer = abs(herr) < 0.05 ? -sign(steer || 1) : herr > 0 ? 1 : -1;
  return { throttle: 0, brake: 1, steer: ai.reverseSteer };
}

/** Something solid right at the nose: a wall, rail or barrier, or another car. */
function noseBlocked(r: RaceState, rc: RaceCar): boolean {
  const c = rc.state;
  const g = rc.tuning.geometry;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const px = c.x + fx * (g.halfLength - g.halfWidth * 0.5);
  const pz = c.z + fz * (g.halfLength - g.halfWidth * 0.5);
  if (r.world.wallClearance(px, pz, 2) < g.halfWidth + AI.noseClear) return true;
  for (const o of r.cars) {
    if (o === rc) continue;
    const dx = o.state.x - c.x;
    const dz = o.state.z - c.z;
    const ahead = dx * fx + dz * fz;
    if (ahead > 0 && ahead < g.halfLength + o.tuning.geometry.halfLength + 0.6 && abs(dx * fz - dz * fx) < g.halfWidth + o.tuning.geometry.halfWidth) return true;
  }
  // A traffic car at the nose pins it just the same.
  return trafficAhead(r, c.x, c.z, fx, fz, g.halfLength + 3, g.halfWidth) !== 0;
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
  return clamp(-(delta + c.slipAngle * AI.slipCounter) / limit, -1, 1);
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
