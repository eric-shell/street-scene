/**
 * Deterministic AI drivers, each with a personality rolled per race
 * (rollDrivers, from RaceConfig.aiSeed), so no two rivals drive alike and no
 * two races share a field. The race's shared line is smoothed from the route
 * centerline within the road width (narrowed past lane closures, so it swings
 * round the roadworks); test autopilots and the finish runout drive it. Each
 * rival drives its own line (driverLine), a minimum curvature sweep through
 * every corner (outside, inside, outside) solved in a frame rounded through
 * the corners (sweepFrame): the share of the road it uses, the side it
 * favours, an early or late apex, how tight it clips the inside of a corner,
 * a wander that differs corner by corner, its own corner speeds and braking
 * points. Some laps it takes one of the route's shortcuts (driverDetours) down
 * the alley and over any jump exit. Aggression decides the racecraft: how
 * early and how close it passes, on which side (the inside of the next
 * corner, or the easy way round; never two abreast into a bottleneck), whether
 * a patient driver waits out a braking zone, how close it follows a car it
 * cannot pass, whether it leans toward a car closing from behind or gives room
 * to one alongside (and lets it by rather than turn in across it), and how
 * freely it burns nitrous. Consistency adds a little pace error per stretch of
 * the race, reaction time staggers the launch. Traffic is dodged, and mild
 * rubber banding is computed purely from race state.
 * Steering counter steers body slip (wheels toward the direction of travel),
 * brakes ease off with steering lock so they never trail brake into a spin,
 * and a car pinned nose in against a wall, rail, barrier or car reverses out
 * with the nose swinging toward the line before the stuck reset kicks in.
 * Timed gates (a level crossing's, sim/gates.ts): they brake to a stop
 * short of one that will be down when they get there, queue behind the cars
 * already waiting and hold still, with the stuck and reverse-out logic off.
 *
 * The parts live in ai/: drivers (AI and DRIVER tuning, personalities), racingLine (the shared line and the
 * geometry every line shares), driverLine (a rival's own line and its shortcut detours), state (an AI's
 * memory), racecraft (passing, blocking, following) and recovery (reversing out). This module is the
 * per-tick driving built on them and the public surface the rest of the sim imports.
 */
import type { RaceCar, RaceState } from './race';
import { InputFrame, NEUTRAL_INPUT } from './input';
import { DEG, abs, approach, atan2, clamp, cos, lerp, sin, sqrt, wrapIndex } from './math';
import { GRAVITY } from './tuning';
import { DT, TICK_HZ } from './constants';
import { trafficAhead } from './traffic';
import { GATE_AI, GateWait, gateSpeedCap } from './gates';
import { steerLimit } from './car';
import { AI, DRIVER } from './ai/drivers';
import { type RacingLine, bendAt, nearestIdx } from './ai/racingLine';
import { type AiState, slipAt } from './ai/state';
import { craft, racecraft } from './ai/racecraft';
import { recoverInput } from './ai/recovery';

export { AI, DRIVER, NEUTRAL_DRIVER, rollDrivers, type Driver } from './ai/drivers';
export { buildRacingLine, type RacingLine } from './ai/racingLine';
export { driverDetours, driverLine, sweepFrame, type Detour, type SweepFrame } from './ai/driverLine';
export { createAi, type AiState, type Course } from './ai/state';

/** Scratch for gateSpeedCap (one AI car at a time). */
const gateWait: GateWait = { cap: Infinity, waiting: false };

/**
 * The line an AI drives this tick, keeping its place on it (ai.idx, or
 * ai.didx on a detour). Reaching the turn off of a shortcut it takes on this
 * lap, it switches to the detour; at the detour's end, or thrown off it (a
 * reset, a tow, a shove), it is back on its own line.
 */
function courseLine(r: RaceState, rc: RaceCar): RacingLine {
  const ai = rc.ai!;
  const c = rc.state;
  const own = ai.line ?? r.line;
  if (ai.detour < 0) {
    ai.idx = nearestIdx(own, c.x, c.z, ai.idx, ai.idx < 0 ? routeS(r, rc) : NaN);
    const lap = clamp(rc.lap - 1, 0, ai.laps - 1);
    for (let k = 0; k < ai.detours.length; k++) {
      const to = ai.detours[k].from - ai.idx;
      const ahead = own.closed ? ((to % own.n) + own.n) % own.n : to;
      if (ahead >= 0 && ahead <= 4 && ai.takes[k * ai.laps + lap]) {
        ai.detour = k;
        ai.didx = -1;
        break;
      }
    }
    if (ai.detour < 0) return own;
  }
  const dt = ai.detours[ai.detour];
  ai.didx = nearestIdx(dt.line, c.x, c.z, ai.didx);
  const lost = Math.hypot(c.x - dt.line.x[ai.didx], c.z - dt.line.z[ai.didx]) > DRIVER.detourLost;
  if (!lost && ai.didx < dt.line.n - 3) return dt.line;
  ai.detour = -1;
  ai.idx = nearestIdx(own, c.x, c.z, lost ? -1 : dt.to, lost ? routeS(r, rc) : NaN);
  return own;
}

/** A car's route distance from the segment the race tracks for it: what seeds its place on a line (nearestIdx). */
function routeS(r: RaceState, rc: RaceCar): number {
  return r.world.routeProgress(rc.state.x, rc.state.z, rc.seg).s;
}

/** Compute this tick's input for an AI car. Reads race state, mutates only the AI's own memory. */
export function aiInput(r: RaceState, rc: RaceCar): InputFrame {
  const ai = rc.ai!;
  const d = ai.driver;
  const c = rc.state;
  const racing = r.tick >= r.countdownTicks;
  if (!racing) return { ...NEUTRAL_INPUT, throttle: 0.55 };
  if (rc.finished) return { ...NEUTRAL_INPUT, throttle: 0.35, steer: steerToward(r, rc) };
  // Reaction time: still on the brake as the lights go green.
  if (r.tick - r.countdownTicks < d.reaction * TICK_HZ) return { ...NEUTRAL_INPUT, brake: DRIVER.reactionBrake };

  // Its own line, or a shortcut's detour while it takes one.
  const line = courseLine(r, rc);
  const idx = ai.detour >= 0 ? ai.didx : ai.idx;
  const speed = c.speed;

  // Rubber banding from progress relative to the player.
  const player = r.cars[0];
  const gap = rc.dist - player.dist;
  const band = gap > 0 ? lerp(1, AI.rubberBandSlow, clamp(gap / AI.rubberBandRange, 0, 1)) : lerp(1, AI.rubberBandFast, clamp(-gap / AI.rubberBandRange, 0, 1));
  const pace = ai.pace * band * slipAt(ai, rc.dist);

  const look = ai.detour >= 0 ? DRIVER.detourLook + speed * DRIVER.detourLookPerSpeed : AI.lookaheadBase + speed * AI.lookaheadPerSpeed;
  const ti = wrapIndex(idx + Math.round(look / AI.spacing), line.n, line.closed);
  // Racecraft against the other racers, else round any traffic car ahead (they keep off the route, but a car pushed out among them dodges).
  const plan = racecraft(r, rc, line, idx, ti, craft);
  let target = plan.target;
  if (target === null) {
    const side = trafficAhead(r, c.x, c.z, sin(c.yaw), cos(c.yaw), 22, 1.7);
    target = side ? (side > 0 ? -AI.dodgeOffset : AI.dodgeOffset) : 0;
  }
  ai.dodge = approach(ai.dodge, target, lerp(DRIVER.moveRate[0], DRIVER.moveRate[1], d.aggression) * DT);

  const squeeze = lerp(DRIVER.squeeze[0], DRIVER.squeeze[1], d.aggression);
  let extra = clamp(ai.dodge, line.lo[ti] - line.offset[ti] - squeeze, line.hi[ti] - line.offset[ti] + squeeze);
  // Off the line next to a wall (an El pillar, a barrier): back toward the line.
  for (let k = 0; k < DRIVER.offPulls && abs(extra) > 0.5 && r.world.wallClearance(line.x[ti] + line.nx[ti] * extra, line.z[ti] + line.nz[ti] * extra, rc.tuning.geometry.halfWidth + DRIVER.wallClear, c.y) < rc.tuning.geometry.halfWidth + DRIVER.wallClear; k++) extra *= 0.5;
  let tx = line.x[ti] + line.nx[ti] * extra;
  let tz = line.z[ti] + line.nz[ti] * extra;
  // A car alongside where the line turns in (a corner, an alley's mouth): hold off it, and let it by unless clearly quicker.
  // Only the car behind gives way (dead level, the later grid slot), and never to one barely moving, so two never wait on each other.
  let yieldCap = Infinity;
  if (plan.beside) {
    const o = plan.beside;
    const fx = sin(c.yaw);
    const fz = cos(c.yaw);
    const lat = (tx - c.x) * fz - (tz - c.z) * fx;
    const lim = plan.besideSide > 0 ? plan.besideSide - plan.besideGap : plan.besideSide + plan.besideGap;
    const over = plan.besideSide > 0 ? lat - lim : lim - lat;
    if (over > 0) {
      // Away from it, unless that is into a wall: then it holds its line (and drops back if it is the one behind).
      const shift = plan.besideSide > 0 ? over : -over;
      const room = rc.tuning.geometry.halfWidth + DRIVER.wallClear;
      if (r.world.wallClearance(tx - shift * fz, tz + shift * fx, room, c.y) >= room) {
        tx -= shift * fz;
        tz += shift * fx;
      }
      const behind = plan.besideAhead > DRIVER.yieldLevel || (plan.besideAhead > -DRIVER.yieldLevel && o.index < rc.index);
      if (behind && o.state.speed > DRIVER.yieldMin && o.state.speed > speed - DRIVER.yieldLead) yieldCap = o.state.speed - DRIVER.yieldLead;
    }
  }
  let steer = pursuitSteer(rc, tx, tz);
  const sliding = abs(c.slipAngle) > AI.slideDeg * DEG && speed > 6;
  // Catch slides: extra counter steer toward the direction of travel.
  if (sliding) steer = clamp(steer - (c.slipAngle * AI.slideCounter) / (rc.tuning.steering.maxDeg * DEG), -1, 1);

  // Speed control: look a little ahead for the binding limit.
  let vt = Infinity;
  for (let k = 0; k <= 3; k++) vt = Math.min(vt, line.speed[wrapIndex(idx + k, line.n, line.closed)]);
  vt *= pace;
  // Off the line toward the inside of a bend, the radius is tighter: slower.
  const inside = extra * bendAt(line, ti);
  if (inside > 0) vt *= sqrt(Math.max(0.5, 1 - inside));
  // No faster than the bend it takes to reach the steering target (off its line, pushed wide, the turn back is tighter than the line's).
  {
    const fx = sin(c.yaw);
    const fz = cos(c.yaw);
    const u = (tx - c.x) * fx + (tz - c.z) * fz;
    const v = (tx - c.x) * fz - (tz - c.z) * fx;
    const bend = (2 * abs(v)) / Math.max(1, u * u + v * v);
    if (bend > 1e-4) vt = Math.min(vt, sqrt((AI.lateralGrip * d.grip * GRAVITY) / bend));
  }
  vt = Math.min(vt, plan.cap, yieldCap);
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

  // Nitrous on straights, keeping the reserve back for passes and the final push; never down a shortcut (a jump exit's landing is planned without it).
  const far = line.speed[wrapIndex(idx + 25, line.n, line.closed)] * pace;
  const keep = plan.passing || rc.dist > r.distance * (1 - DRIVER.finalPush) ? 0 : d.reserve;
  const lead = lerp(DRIVER.nitroLead[0], DRIVER.nitroLead[1], d.aggression);
  let nitrous = false;
  if (ai.nitroHold > 0) {
    ai.nitroHold -= DT;
    nitrous = c.nitro > keep + 0.02 && err > 1;
  } else if (c.nitro > keep + 0.25 && err > lead * 0.75 && far > speed + lead && abs(steer) < 0.25 && speed > 15) {
    ai.nitroHold = lerp(DRIVER.nitroHold[0], DRIVER.nitroHold[1], d.aggression);
    nitrous = true;
  }
  if (ai.detour >= 0) nitrous = false;

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
  if (ai.detour >= 0 || plan.queued) {
    // Down a shortcut the race credits the skipped stretch only at the exit, and the alley may run
    // against the nearest street; in a queue the pace is the car ahead's: no progress to judge (the
    // stuck timer still is).
    ai.watchTime = 0;
    ai.watchDist = rc.dist;
    noProgress = false;
  }
  const reset = ai.stuckTime > AI.stuckTime || (rc.wrongWayTime > 3 && ai.detour < 0) || noProgress;
  if (reset) {
    ai.stuckTime = 0;
    ai.watchTime = 0;
    ai.watchDist = rc.dist;
  }

  return { throttle, brake, steer, handbrake: false, nitrous, shift: 0, reset, antilag: false };
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
  // Also counter the body slip a bit.
  return clamp(-(delta + c.slipAngle * AI.slipCounter) / steerLimit(t, c.speed), -1, 1);
}

function steerToward(r: RaceState, rc: RaceCar): number {
  const ai = rc.ai!;
  const line = ai.line ?? r.line;
  ai.idx = nearestIdx(line, rc.state.x, rc.state.z, ai.idx, ai.idx < 0 ? routeS(r, rc) : NaN);
  const ti = wrapIndex(ai.idx + 4, line.n, line.closed);
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
