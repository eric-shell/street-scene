/**
 * Race lifecycle: grid, countdown, progress along the route, laps,
 * checkpoints, positions, wrong way, reset to road, drafting, drift scoring,
 * and the player input log. Everything here is pure and deterministic: given
 * the same config and the same input frames, every tick is identical.
 */
import { createCity, createWorld, World, City } from '../city/world';
import { routeSample } from '../city/route';
import { CarState, createCar, placeCar, refillNitrous, stepCar } from './car';
import { WorldHit, collideCarWithWorld, collideCars, detectNearMiss } from './collision';
import { DT, TICK_HZ } from './constants';
import { InputFrame, NEUTRAL_INPUT, packInput, quantizeInput } from './input';
import { CarTuning } from './tuning';
import { PerformanceBuild, tuningForBuild, validatePerformance } from './build';
import { DEG, abs, atan2, clamp, cos, lerp, sin, sqrt, yawOf } from './math';
import { AiState, aiInput, buildRacingLine, createAi, RacingLine } from './ai';
import { stepProps } from './props';

export type RaceMode = 'circuit' | 'sprint' | 'drift';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface RaceEntrant {
  name: string;
  carId: string;
  performance: PerformanceBuild;
}

export interface RaceConfig {
  seed: number;
  mode: RaceMode;
  laps: number;
  player: RaceEntrant;
  opponents: RaceEntrant[];
  difficulty: Difficulty;
  manualGearbox: boolean;
  /** Player driver aid (AI cars always drive with it). Missing in old replays = off. */
  tractionControl?: boolean;
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

export interface RaceCar {
  index: number;
  name: string;
  isPlayer: boolean;
  carId: string;
  tuning: CarTuning;
  state: CarState;
  /** Unwrapped distance driven along the route since the start line (negative on the grid). */
  dist: number;
  rawS: number;
  seg: number;
  lateral: number;
  lap: number;
  lapStartTick: number;
  lapTimes: number[];
  bestLap: number;
  nextCheckpoint: number;
  finished: boolean;
  finishTick: number;
  wrongWayTime: number;
  wrongWay: boolean;
  resetCooldown: number;
  stuckTime: number;
  ai: AiState | null;
  /** Post-finish runout autopilot (player only), created on the first tick after finishing. */
  runout?: { lateral: number; startS: number };
}

export interface DriftScore {
  total: number;
  current: number;
  multiplier: number;
  chainTime: number;
  graceTime: number;
  lastBank: number;
}

export interface RaceState {
  config: RaceConfig;
  world: World;
  line: RacingLine;
  tick: number;
  phase: RacePhase;
  countdownTicks: number;
  cars: RaceCar[];
  /** Total race distance in meters. */
  distance: number;
  /** Packed player input frames, one per tick. */
  inputLog: number[];
  drift: DriftScore;
  /** Player finish order snapshot, filled when the player finishes. */
  events: RaceEvent[];
  /** Last tick a 'wall' event fired per car and a 'crash' event per car pair (i * n + j), for rate limiting. */
  hitTicks: { wall: number[]; pair: number[] };
  /** 1 = prop knocked down this race, indexed by prop id (world.props). Fresh per race. */
  brokenProps: Uint8Array;
}

/** Impact sound events: minimum impact speed (m/s) and minimum gap between events (ticks). */
const CRASH_EVENT_SPEED = 2;
const WALL_EVENT_SPEED = 3;
const HIT_EVENT_GAP = Math.round(0.25 * TICK_HZ);

/**
 * Sim events, consumed by the session for HUD messages, sounds and effects.
 * 'prop': value = prop id broken. 'crash': value = impact speed (m/s), other = car index hit.
 * 'wall': value = impact speed (m/s), kind = wall kind hit.
 */
export type RaceEvent = {
  tick: number;
  type: 'lap' | 'checkpoint' | 'finish' | 'wrongWay' | 'reset' | 'driftBank' | 'prop' | 'crash' | 'wall';
  car: number;
  value?: number;
  other?: number;
  kind?: 'wall' | 'barrier' | 'rail';
};

export const COUNTDOWN_SECONDS = 3;

/**
 * Post-finish runout: once the player crosses the line its input is replaced
 * by a lane-keeping autopilot that brakes along a speed profile so the car
 * stops smoothly further down the road, clear of the barriers.
 */
export const RUNOUT = {
  /** Comfortable braking the speed profile aims for (m/s^2). */
  decel: 6,
  /** Circuits: distance past the line to stop in (m). */
  circuitDistance: 110,
  /** Sprints: stop this far before the end of the route (m). */
  endMargin: 8,
  /** Brake added per m/s over the profile speed. */
  brakeGain: 0.25,
  /** Light brake while on or under the profile, so the car always coasts down. */
  coastBrake: 0.35,
  /** Brake that holds the car once stopped (under the 0.5 that would engage reverse). */
  holdBrake: 0.45,
  /** Below this speed the car counts as stopped (m/s). */
  stopSpeed: 0.8,
  /** Route heading is sampled this many seconds ahead (s). */
  lookTime: 0.4,
  /** The car holds its lane at the line, kept this far inside the road edge (m). */
  edgeMargin: 2.5,
  /** Heading correction per m of lane error (rad/m) and its cap (rad). */
  laneGain: 0.06,
  laneMax: 0.18,
  /** Yaw rate asked for per rad of heading error (1/s), and its cap (rad/s). */
  headingGain: 1.6,
  maxYawRate: 0.7,
  /** Steer per rad/s of yaw rate error (damps weaving). */
  yawDamping: 0.35,
  /** Steering is capped to keep the runout calm. */
  maxSteer: 0.7,
} as const;
const DIFFICULTY_PACE: Record<Difficulty, number> = { easy: 0.86, medium: 0.94, hard: 1.0 };

/** Cached city per seed so restarting a race does not regenerate geometry. */
let cityCache: City | null = null;
export function cityForSeed(seed: number): City {
  if (!cityCache || cityCache.seed !== seed) cityCache = createCity(seed);
  return cityCache;
}

export function createRace(cfgIn: RaceConfig, world?: World): RaceState {
  const config: RaceConfig = {
    ...cfgIn,
    laps: cfgIn.mode === 'sprint' ? 1 : Math.max(1, Math.min(10, Math.round(cfgIn.laps))),
    opponents: cfgIn.mode === 'drift' ? [] : cfgIn.opponents.slice(0, 3),
    player: { ...cfgIn.player, performance: validatePerformance(cfgIn.player.performance) },
  };
  const kind = config.mode === 'sprint' ? 'sprint' : 'circuit';
  const w = world && world.seed === config.seed && world.route.kind === kind ? world : createWorld(config.seed, kind, cityForSeed(config.seed));
  const route = w.route;
  const entrants = [config.player, ...config.opponents];
  const line = buildRacingLine(w);
  // Player starts at the back of the grid, like a street race challenger.
  const slots = entrants.map((_, i) => route.grid[(entrants.length - 1 - i) % route.grid.length]);
  const cars: RaceCar[] = entrants.map((e, i) => {
    const slot = slots[i];
    const tuning = tuningForBuild(e.carId, validatePerformance(e.performance));
    const state = createCar(slot.x, slot.z, slot.yaw, w.heightAt(slot.x, slot.z));
    state.manualGearbox = i === 0 && config.manualGearbox;
    // AI drives with traction control: stable lines, no power oversteer surprises.
    state.tractionControl = i === 0 ? config.tractionControl === true : true;
    const p = w.routeProgress(slot.x, slot.z);
    const startDist = route.closed ? p.s - route.length : p.s - route.startS;
    return {
      index: i,
      name: e.name,
      isPlayer: i === 0,
      carId: e.carId,
      tuning,
      state,
      dist: startDist,
      rawS: p.s,
      seg: p.seg,
      lateral: p.lateral,
      lap: 0,
      lapStartTick: 0,
      lapTimes: [],
      bestLap: 0,
      nextCheckpoint: 0,
      finished: false,
      finishTick: 0,
      wrongWayTime: 0,
      wrongWay: false,
      resetCooldown: 0,
      stuckTime: 0,
      ai: i === 0 ? null : createAi(i, DIFFICULTY_PACE[config.difficulty]),
    };
  });
  const distance = route.closed ? route.length * config.laps : route.finishS - route.startS;
  return {
    config,
    world: w,
    line,
    tick: 0,
    phase: 'countdown',
    countdownTicks: COUNTDOWN_SECONDS * TICK_HZ,
    cars,
    distance,
    inputLog: [],
    drift: { total: 0, current: 0, multiplier: 1, chainTime: 0, graceTime: 0, lastBank: 0 },
    events: [],
    hitTicks: { wall: cars.map(() => -HIT_EVENT_GAP), pair: cars.flatMap(() => cars.map(() => -HIT_EVENT_GAP)) },
    brokenProps: new Uint8Array(w.props?.length ?? 0),
  };
}

/** Race clock in seconds (0 until the green light). */
export function raceTime(r: RaceState): number {
  return Math.max(0, r.tick - r.countdownTicks) / TICK_HZ;
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_HZ;
}

/** Reset a car to the road centerline at its current progress. */
export function resetToRoad(r: RaceState, rc: RaceCar): void {
  const route = r.world.route;
  const s = route.closed ? rc.rawS : clamp(rc.rawS, 0, route.length);
  const p = routeSample(route, s);
  // Nudge to the right lane so we are not dropped onto another car head on.
  const half = route.segWidth[p.seg] / 2;
  const lateral = -Math.min(2, half * 0.35);
  placeCar(rc.state, p.x + p.tz * lateral, p.z - p.tx * lateral, yawOf(p.tx, p.tz), r.world);
  rc.resetCooldown = 1;
  rc.stuckTime = 0;
  rc.wrongWayTime = 0;
  r.events.push({ tick: r.tick, type: 'reset', car: rc.index });
}

/** Deterministic input for a finished player: lane keeping steer and braking to a stop. */
export function runoutInput(r: RaceState, rc: RaceCar): InputFrame {
  const route = r.world.route;
  const c = rc.state;
  const t = rc.tuning;
  if (!rc.runout) rc.runout = { lateral: rc.lateral, startS: rc.rawS };
  const ro = rc.runout;
  if (c.speed < RUNOUT.stopSpeed) return { ...NEUTRAL_INPUT, brake: RUNOUT.holdBrake };

  // Steer: hold the lane the car crossed the line in, along the route heading a little ahead.
  const ahead = routeSample(route, rc.rawS + c.speed * RUNOUT.lookTime);
  const room = Math.max(0, route.segWidth[ahead.seg] / 2 - RUNOUT.edgeMargin);
  const laneErr = clamp(ro.lateral, -room, room) - rc.lateral; // + = lane is to the left
  const yawDes = yawOf(ahead.tx, ahead.tz) + clamp(laneErr * RUNOUT.laneGain, -RUNOUT.laneMax, RUNOUT.laneMax);
  const velYaw = c.speed > 2 ? atan2(c.vx, c.vz) : c.yaw;
  let err = yawDes - velYaw;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  // Yaw rate is positive turning left; positive steer turns right.
  const yrDes = clamp(err * RUNOUT.headingGain, -RUNOUT.maxYawRate, RUNOUT.maxYawRate);
  const delta = atan2((yrDes * t.geometry.wheelbase) / Math.max(3, c.speed), 1);
  const limit = lerp(t.steering.maxDeg, t.steering.highSpeedDeg, clamp(c.speed / t.steering.fadeSpeed, 0, 1)) * DEG;
  const steer = clamp(-delta / limit + (c.yawRate - yrDes) * RUNOUT.yawDamping, -RUNOUT.maxSteer, RUNOUT.maxSteer);

  // Brake: follow a speed profile that reaches zero at the stop point, slower for corners.
  let remaining: number;
  if (route.closed) {
    let d = rc.rawS - ro.startS;
    if (d < -route.length / 2) d += route.length;
    else if (d > route.length / 2) d -= route.length;
    remaining = RUNOUT.circuitDistance - d;
  } else remaining = route.length - RUNOUT.endMargin - rc.rawS;
  let vt = sqrt(2 * RUNOUT.decel * Math.max(0, remaining));
  const line = r.line;
  const step = line.n > 1 ? line.s[1] - line.s[0] : 1;
  const i0 = Math.round(rc.rawS / step);
  for (let k = 0; k <= 8; k++) {
    const i = line.closed ? (((i0 + k) % line.n) + line.n) % line.n : clamp(i0 + k, 0, line.n - 1);
    vt = Math.min(vt, line.speed[i]);
  }
  const brake = clamp(RUNOUT.coastBrake + (c.speed - vt) * RUNOUT.brakeGain, RUNOUT.coastBrake, 1);
  return { ...NEUTRAL_INPUT, steer, brake };
}

/** Advance the race exactly one tick with the player's input frame. */
export function stepRace(r: RaceState, rawInput: InputFrame): void {
  const input = quantizeInput(rawInput);
  r.inputLog.push(packInput(input));
  const racing = r.tick >= r.countdownTicks;

  // Gather inputs first so AI decisions see a consistent snapshot.
  const inputs: InputFrame[] = r.cars.map((rc) => {
    // After the finish the player's controls are ignored and the runout drives the car.
    if (rc.isPlayer) return rc.finished ? runoutInput(r, rc) : input;
    return aiInput(r, rc);
  });

  if (!racing) {
    // Grid: engines rev, cars hold still.
    for (let i = 0; i < r.cars.length; i++) {
      const c = r.cars[i].state;
      const t = r.cars[i].tuning;
      const target = t.engine.idleRpm + inputs[i].throttle * (t.engine.redline * 0.85 - t.engine.idleRpm);
      c.rpm += (target - c.rpm) * 0.15;
    }
    r.tick++;
    if (r.tick === r.countdownTicks) r.phase = r.phase === 'countdown' ? 'racing' : r.phase;
    return;
  }

  // Drafting: someone close ahead in your slipstream.
  for (const rc of r.cars) {
    const c = rc.state;
    c.drafting = false;
    if (c.speed < 20) continue;
    const fx = sin(c.yaw);
    const fz = cos(c.yaw);
    for (const other of r.cars) {
      if (other === rc) continue;
      const dx = other.state.x - c.x;
      const dz = other.state.z - c.z;
      const ahead = dx * fx + dz * fz;
      const side = abs(dx * fz - dz * fx);
      if (ahead > 4 && ahead < 26 && side < 2.2) {
        c.drafting = true;
        break;
      }
    }
  }

  for (let i = 0; i < r.cars.length; i++) {
    const rc = r.cars[i];
    const inp = inputs[i];
    if (inp.reset && rc.resetCooldown <= 0) resetToRoad(r, rc);
    stepCar(rc.state, rc.tuning, inp, { world: r.world });
  }
  const hit: WorldHit = { speed: 0, kind: 'wall' };
  for (const rc of r.cars) {
    rc.state.impact = collideCarWithWorld(rc.state, rc.tuning, r.world, hit);
    if (hit.speed > WALL_EVENT_SPEED && r.tick - r.hitTicks.wall[rc.index] >= HIT_EVENT_GAP) {
      r.hitTicks.wall[rc.index] = r.tick;
      r.events.push({ tick: r.tick, type: 'wall', car: rc.index, kind: hit.kind, value: hit.speed });
    }
  }
  // Destructible street furniture: knocks props down, slows cars, emits 'prop' events.
  stepProps(r);
  for (let i = 0; i < r.cars.length; i++) {
    if (r.cars[i].finished) continue;
    for (let j = i + 1; j < r.cars.length; j++) {
      // Finished cars pull out of the race: no contact, so they never block anyone.
      if (r.cars[j].finished) continue;
      const imp = collideCars(r.cars[i].state, r.cars[i].tuning, r.cars[j].state, r.cars[j].tuning);
      if (imp > 0) {
        r.cars[i].state.impact = Math.max(r.cars[i].state.impact, imp);
        r.cars[j].state.impact = Math.max(r.cars[j].state.impact, imp);
        const pair = i * r.cars.length + j;
        if (imp > CRASH_EVENT_SPEED && r.tick - r.hitTicks.pair[pair] >= HIT_EVENT_GAP) {
          r.hitTicks.pair[pair] = r.tick;
          r.events.push({ tick: r.tick, type: 'crash', car: i, other: j, value: imp });
        }
      }
    }
  }
  for (const rc of r.cars) {
    rc.state.nearMiss = detectNearMiss(rc.state, rc.tuning, r.world);
    refillNitrous(rc.state, rc.tuning);
    if (rc.resetCooldown > 0) rc.resetCooldown -= DT;
    updateProgress(r, rc);
  }
  if (r.config.mode === 'drift') updateDrift(r);

  r.tick++;
}

function updateProgress(r: RaceState, rc: RaceCar): void {
  const route = r.world.route;
  const c = rc.state;
  const p = r.world.routeProgress(c.x, c.z, rc.seg);
  let delta = p.s - rc.rawS;
  if (route.closed) {
    const L = route.length;
    if (delta < -L / 2) delta += L;
    else if (delta > L / 2) delta -= L;
  }
  rc.rawS = p.s;
  rc.seg = p.seg;
  rc.lateral = p.lateral;
  if (rc.finished) return;
  const prevDist = rc.dist;
  rc.dist += delta;

  // Checkpoints: global index k across laps sits at distance checkpointDist(k).
  const lapLen = route.closed ? route.length : r.distance;
  const total = route.checkpoints.length * r.config.laps;
  while (rc.nextCheckpoint < total && rc.dist >= checkpointDist(r, rc.nextCheckpoint) - 1e-6) {
    rc.nextCheckpoint++;
    r.events.push({ tick: r.tick, type: 'checkpoint', car: rc.index, value: rc.nextCheckpoint });
  }
  const raceStartTick = r.countdownTicks;
  if (route.closed) {
    const prevLaps = Math.floor(Math.max(0, prevDist) / lapLen);
    const laps = Math.floor(Math.max(0, rc.dist) / lapLen);
    if (prevDist >= 0 || rc.dist >= 0) {
      if (rc.lap === 0 && rc.dist >= 0) {
        rc.lap = 1;
        rc.lapStartTick = raceStartTick;
      }
      if (laps > prevLaps && laps >= 1) {
        const lapTicks = r.tick + 1 - rc.lapStartTick;
        rc.lapTimes.push(lapTicks);
        if (!rc.bestLap || lapTicks < rc.bestLap) rc.bestLap = lapTicks;
        rc.lapStartTick = r.tick + 1;
        rc.lap = laps + 1;
        r.events.push({ tick: r.tick, type: 'lap', car: rc.index, value: laps });
      }
    }
  } else if (rc.lap === 0 && rc.dist >= 0) {
    rc.lap = 1;
    rc.lapStartTick = raceStartTick;
  }
  if (rc.dist >= r.distance && rc.nextCheckpoint >= total) {
    rc.finished = true;
    rc.finishTick = r.tick + 1;
    if (!route.closed) {
      rc.lapTimes.push(rc.finishTick - raceStartTick);
      rc.bestLap = rc.finishTick - raceStartTick;
    }
    r.events.push({ tick: r.tick, type: 'finish', car: rc.index });
    if (rc.isPlayer) r.phase = 'finished';
  }

  // Wrong way and stuck detection.
  const vAlong = c.vx * p.tx + c.vz * p.tz;
  if (vAlong < -3) rc.wrongWayTime += DT;
  else rc.wrongWayTime = Math.max(0, rc.wrongWayTime - DT * 2);
  const wasWrong = rc.wrongWay;
  rc.wrongWay = rc.wrongWayTime > 1.2;
  if (rc.wrongWay && !wasWrong) r.events.push({ tick: r.tick, type: 'wrongWay', car: rc.index });
  // Out of the corridor (should never happen, but never leave a car lost).
  const half = route.segWidth[p.seg] / 2;
  if (abs(p.lateral) > half + 10) resetToRoad(r, rc);
}

export function checkpointDist(r: RaceState, k: number): number {
  const route = r.world.route;
  const n = route.checkpoints.length;
  if (route.closed) return Math.floor(k / n) * route.length + route.checkpoints[k % n];
  return route.checkpoints[k] - route.startS;
}

function updateDrift(r: RaceState): void {
  const rc = r.cars[0];
  const c = rc.state;
  const d = r.drift;
  if (c.impact > 3 && d.current > 0) {
    d.current = 0;
    d.multiplier = 1;
    d.chainTime = 0;
    return;
  }
  if (c.drifting && c.speed > 12 && !rc.wrongWay) {
    const angle = Math.min(abs(c.slipAngle) / DEG, 60);
    d.current += angle * c.speed * DT * 0.6;
    d.chainTime += DT;
    d.graceTime = 0.7;
    d.multiplier = Math.min(5, 1 + Math.floor(d.chainTime / 2));
  } else if (d.current > 0) {
    d.graceTime -= DT;
    if (d.graceTime <= 0) {
      const banked = Math.round(d.current * d.multiplier);
      d.total += banked;
      d.lastBank = banked;
      r.events.push({ tick: r.tick, type: 'driftBank', car: 0, value: banked });
      d.current = 0;
      d.multiplier = 1;
      d.chainTime = 0;
    }
  }
}

export interface Standing {
  car: RaceCar;
  position: number;
  /** Seconds, real when finished or estimated otherwise. */
  time: number;
  estimated: boolean;
}

/** Current order: finished cars by finish tick, then by distance. */
export function standings(r: RaceState): Standing[] {
  const sorted = r.cars.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishTick - b.finishTick || a.index - b.index;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.dist - a.dist || a.index - b.index;
  });
  const now = raceTime(r);
  return sorted.map((car, i) => {
    if (car.finished) return { car, position: i + 1, time: (car.finishTick - r.countdownTicks) / TICK_HZ, estimated: false };
    const remaining = Math.max(0, r.distance - car.dist);
    const avg = now > 1 ? Math.max(15, Math.max(0, car.dist) / now) : 30;
    return { car, position: i + 1, time: now + remaining / avg, estimated: true };
  });
}

export function positionOf(r: RaceState, index: number): number {
  return standings(r).findIndex((s) => s.car.index === index) + 1;
}
