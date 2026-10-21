/**
 * Race lifecycle: grid, countdown, progress along the route, laps,
 * checkpoints, positions, wrong way, reset to road, drafting, drift scoring,
 * and the player input log. Everything here is pure and deterministic: given
 * the same config and the same input frames, every tick is identical.
 */
import { createCity, createWorld, World, City } from '../city/world';
import { GridSlot, routeSample } from '../city/route';
import { carParkProgress, onCarPark } from '../city/districts/carPark';
import { CarState, createCar, placeCar, refillNitrous, stepCar } from './car';
import { WorldHit, collideCarWithWorld, collideCars, detectNearMiss } from './collision';
import { DT, TICK_HZ } from './constants';
import { InputFrame, NEUTRAL_INPUT, packInput, quantizeInput } from './input';
import { CarTuning } from './tuning';
import { PerformanceBuild, tuningForBuild, validatePerformance } from './build';
import { DEG, abs, atan2, clamp, cos, distToSegment, lerp, sin, sqrt, yawOf } from './math';
import { AiState, aiInput, buildRacingLine, createAi, RacingLine } from './ai';
import { stepProps } from './props';
import { RailState, createRailState } from './rails';
import { TrafficState, createTraffic, stepTraffic } from './traffic';
import { DriftZoneState, createDriftZoneState, stepDriftZones } from './driftZones';
import { waitingAtGate } from './gates';
import { stepHazards } from './hazards';

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
  /**
   * Open world (free roam): no opponents, no route barriers, rails, parked
   * cars or crowds (World.openWorld), no countdown, laps, wrong way or route
   * resets. Free roam on any street; only a car that is truly lost off the
   * road network gets put back, on the nearest street.
   */
  openWorld?: boolean;
  /** Ambient traffic on the streets the race does not use (src/sim/traffic.ts). Missing in old replays = off. */
  traffic?: boolean;
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
  /** Of `current`, the points the drift zone multiplier added (before the chain multiplier). */
  zoneBonus: number;
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
  /** 1 = level crossing gate arm snapped off this race, indexed gate * 2 + half (src/sim/levelCrossing.ts). Fresh per race. */
  brokenArms: Uint8Array;
  /** Corner rail pieces displaced by hits this race (src/sim/rails.ts). Fresh per race. */
  rails: RailState;
  /** Ambient traffic (src/sim/traffic.ts), null when the config has it off. */
  traffic: TrafficState | null;
  /** Drift zone visits per car (src/sim/driftZones.ts). Fresh per race. */
  driftZones: DriftZoneState;
}

/** Impact sound events: minimum impact speed (m/s) and minimum gap between events (ticks). */
const CRASH_EVENT_SPEED = 2;
const WALL_EVENT_SPEED = 3;
const HIT_EVENT_GAP = Math.round(0.25 * TICK_HZ);

/**
 * Sim events, consumed by the session for HUD messages, sounds and effects.
 * 'prop': value = prop id broken. 'arm': value = level crossing arm snapped off (RaceState.brokenArms index). 'crash': value = impact speed (m/s), other = car index hit.
 * 'wall': value = impact speed (m/s), kind = wall kind hit.
 * A 'crash' with `traffic` set hit that traffic car (r.traffic.cars index); car is -1 when traffic hit traffic.
 * 'driftBank': value = points banked, other = of those, the drift zone bonus (when there was one).
 */
export type RaceEvent = {
  tick: number;
  type: 'lap' | 'checkpoint' | 'finish' | 'wrongWay' | 'reset' | 'driftBank' | 'prop' | 'arm' | 'crash' | 'wall';
  car: number;
  value?: number;
  other?: number;
  kind?: 'wall' | 'barrier' | 'rail';
  traffic?: number;
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
  /** Brake added per m/s over the profile speed (full brake is about 2 g with the assist). */
  brakeGain: 0.13,
  /** Light brake while on or under the profile, so the car always coasts down (about 0.35 g). */
  coastBrake: 0.17,
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

/** Most AI rivals in one race (the start grid has a slot for each, plus the player). */
export const MAX_OPPONENTS = 9;

/**
 * Start slots for `count` entrants, player first. The player starts at the back of the grid,
 * like a street race challenger. Up to four cars take the original staggered slots in order (so
 * their replays hold); a bigger field fills the two-wide grid front to back.
 */
function gridSlots(grid: GridSlot[], count: number): GridSlot[] {
  const order = count <= 4 ? grid.slice(0, count) : grid.slice().sort((a, b) => b.s - a.s).slice(0, count);
  return order.map((_, i) => order[count - 1 - i]);
}

export function createRace(cfgIn: RaceConfig, world?: World): RaceState {
  const config: RaceConfig = {
    ...cfgIn,
    laps: cfgIn.mode === 'sprint' ? 1 : Math.max(1, Math.min(10, Math.round(cfgIn.laps))),
    opponents: cfgIn.mode === 'drift' || cfgIn.openWorld ? [] : cfgIn.opponents.slice(0, MAX_OPPONENTS),
    player: { ...cfgIn.player, performance: validatePerformance(cfgIn.player.performance) },
  };
  const kind = config.mode === 'sprint' ? 'sprint' : 'circuit';
  const open = config.openWorld === true;
  const w =
    world && world.seed === config.seed && world.route.kind === kind && (world.openWorld === true) === open
      ? world
      : createWorld(config.seed, kind, cityForSeed(config.seed), { openWorld: open });
  const route = w.route;
  const entrants = [config.player, ...config.opponents];
  const line = buildRacingLine(w);
  const slots = gridSlots(route.grid, entrants.length);
  const cars: RaceCar[] = entrants.map((e, i) => {
    const slot = slots[i];
    const tuning = tuningForBuild(e.carId, validatePerformance(e.performance));
    const state = createCar(slot.x, slot.z, slot.yaw, w.driveHeightAt(slot.x, slot.z));
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
  const traffic = config.traffic ? createTraffic(w, cars, config.seed, open) : null;
  return {
    config,
    world: w,
    line,
    tick: 0,
    phase: 'countdown',
    countdownTicks: open ? 0 : COUNTDOWN_SECONDS * TICK_HZ,
    cars,
    distance,
    inputLog: [],
    drift: { total: 0, current: 0, multiplier: 1, chainTime: 0, graceTime: 0, lastBank: 0, zoneBonus: 0 },
    events: [],
    hitTicks: { wall: cars.map(() => -HIT_EVENT_GAP), pair: cars.flatMap(() => cars.map(() => -HIT_EVENT_GAP)) },
    brokenProps: coveredPropsRemoved(w),
    brokenArms: new Uint8Array((w.timedGates?.gates.length ?? 0) * 2),
    rails: createRailState(w),
    traffic,
    driftZones: createDriftZoneState(w, cars.length),
  };
}

/** Race clock in seconds (0 until the green light). */
/** Fresh broken-prop flags: props under this route's barriers/rails start removed (2, no debris). */
function coveredPropsRemoved(w: World): Uint8Array {
  const flags = new Uint8Array(w.props?.length ?? 0);
  for (const id of w.coveredProps ?? []) flags[id] = 2;
  return flags;
}

export function raceTime(r: RaceState): number {
  return Math.max(0, r.tick - r.countdownTicks) / TICK_HZ;
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_HZ;
}

/** Reset a car to the road centerline at its current progress. */
export function resetToRoad(r: RaceState, rc: RaceCar): void {
  if (r.config.openWorld) return resetToStreet(r, rc);
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

/** Seconds off the road network before an open world car counts as lost and is put back. */
const OPEN_WORLD_LOST_TIME = 2;

/**
 * Open world reset: onto the right hand lane of the nearest street, facing the
 * way along it closest to the car's heading, clear of the intersections.
 */
export function resetToStreet(r: RaceState, rc: RaceCar): void {
  const g = r.world.graph;
  const c = rc.state;
  let best = -1;
  let bestD = Infinity;
  for (const e of g.edges) {
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const d = distToSegment(c.x, c.z, a.x, a.z, b.x, b.z);
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  if (best < 0) return;
  const e = g.edges[best];
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const len = e.length || 1;
  let tx = (b.x - a.x) / len;
  let tz = (b.z - a.z) / len;
  const margin = Math.min(15, len / 3);
  const u = clamp((c.x - a.x) * tx + (c.z - a.z) * tz, margin, len - margin);
  const px = a.x + tx * u;
  const pz = a.z + tz * u;
  if (sin(c.yaw) * tx + cos(c.yaw) * tz < 0) {
    tx = -tx;
    tz = -tz;
  }
  const lateral = -Math.min(2, e.width * 0.175);
  placeCar(c, px + tz * lateral, pz - tx * lateral, yawOf(tx, tz), r.world);
  rc.resetCooldown = 1;
  rc.stuckTime = 0;
  rc.wrongWayTime = 0;
  r.events.push({ tick: r.tick, type: 'reset', car: rc.index });
}

/** Open world: no laps, checkpoints or wrong way; only a car lost off the road network is put back. */
function updateOpenWorld(r: RaceState, rc: RaceCar): void {
  rc.wrongWay = false;
  rc.wrongWayTime = 0;
  const c = rc.state;
  if (r.world.surfaceAt(c.x, c.z) === 'offroad') rc.stuckTime += DT;
  else rc.stuckTime = 0;
  if (rc.stuckTime > OPEN_WORLD_LOST_TIME) resetToStreet(r, rc);
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
    // The city keeps moving while the grid waits.
    stepTraffic(r);
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
    rc.state.impact = collideCarWithWorld(rc.state, rc.tuning, r.world, hit, r.rails, r.tick);
    if (hit.speed > WALL_EVENT_SPEED && r.tick - r.hitTicks.wall[rc.index] >= HIT_EVENT_GAP) {
      r.hitTicks.wall[rc.index] = r.tick;
      r.events.push({ tick: r.tick, type: 'wall', car: rc.index, kind: hit.kind, value: hit.speed });
    }
  }
  // Destructible street furniture: knocks props down, slows cars, emits 'prop' events.
  stepProps(r);
  // Timed hazards: cars left on a rising drawbridge or on the tracks are towed off, level crossing arms snap (sim/hazards.ts).
  stepHazards(r);
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
  // Ambient traffic drives on, then meets the race cars where they are now.
  stepTraffic(r);
  for (const rc of r.cars) {
    rc.state.nearMiss = detectNearMiss(rc.state, rc.tuning, r.world);
    refillNitrous(rc.state, rc.tuning);
    if (rc.resetCooldown > 0) rc.resetCooldown -= DT;
    updateProgress(r, rc);
  }
  // Drift zones: the extra refill for drifting on the plaza and the lots, and the score multiplier updateDrift reads.
  stepDriftZones(r);
  if (r.config.mode === 'drift') updateDrift(r);

  r.tick++;
}

function updateProgress(r: RaceState, rc: RaceCar): void {
  const route = r.world.route;
  const c = rc.state;
  // Up in one of the route's car parks, progress follows the car park's own line (districts/carPark.ts).
  const p = carParkProgress(r.world, c.x, c.z) ?? r.world.routeProgress(c.x, c.z, rc.seg);
  let delta = p.s - rc.rawS;
  if (route.closed) {
    const L = route.length;
    if (delta < -L / 2) delta += L;
    else if (delta > L / 2) delta -= L;
  }
  const prevS = rc.rawS;
  rc.rawS = p.s;
  rc.seg = p.seg;
  rc.lateral = p.lateral;
  if (r.config.openWorld) return updateOpenWorld(r, rc);
  if (rc.finished) return;
  // Progress never jumps: when the nearest route segment switches far ahead
  // (a cut across a park or a lot), only what the car could have driven this
  // tick counts. Corner cuts stay well under the limit. The route's own
  // shortcuts are the exception: a car in one is credited the stretch it skips.
  if (delta > LOST.maxJump && !inShortcut(route, prevS, p.s, c.x, c.z)) delta = Math.min(delta, c.speed * DT * 1.5 + 0.5);
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
  // Lost: far outside the route corridor (beyond any corner cut, plaza, lot or
  // park crossing), or off every drivable surface (inside a block), for a while.
  // Racing lines over sidewalks, plazas and lots never trigger it.
  // True distance to the projected point (lateral alone misses points beyond a segment's end),
  // checked against the whole route when the hinted window says the car is far out.
  const offFrom = (pp: { s: number; seg: number }) => {
    const q = routeSample(route, pp.s);
    return sqrt((c.x - q.x) ** 2 + (c.z - q.z) ** 2) - route.segWidth[pp.seg] / 2;
  };
  let off = offFrom(p);
  if (off > LOST.lateral) off = offFrom(r.world.routeProgress(c.x, c.z));
  const offroad = c.surface === 'offroad';
  // A car held at a timed gate (the drawbridge going up) is waiting, not lost.
  const held = (off > LOST.lateral || offroad) && waitingAtGate(r.world.timedGates, r.tick, c.x, c.z, c.speed);
  if (off > LOST.farLateral && !held) return resetToRoad(r, rc);
  // Up in one of the route's car parks a car is far from the streets but not lost.
  if (((off > LOST.lateral && !onCarPark(r.world, c.x, c.z)) || offroad) && !held) rc.stuckTime += DT;
  else rc.stuckTime = Math.max(0, rc.stuckTime - DT);
  if (rc.stuckTime > (offroad ? LOST.offroadTime : LOST.time)) resetToRoad(r, rc);
}

/**
 * A forward progress jump from s0 to s1 made inside one of the route's
 * shortcuts: the car is within SHORTCUT.reach of the alley and the jump runs
 * from around its entry to around its exit (positions relative to the entry,
 * wrapped on circuits), so the skipped stretch is credited in full.
 */
function inShortcut(route: World['route'], s0: number, s1: number, x: number, z: number): boolean {
  const L = route.length;
  const rel = (s: number, from: number) => {
    let d = s - from;
    if (route.closed) {
      d = ((d % L) + L) % L;
      if (d > L / 2) d -= L;
    }
    return d;
  };
  for (const sc of route.shortcuts) {
    if (distToSegment(x, z, sc.ax, sc.az, sc.bx, sc.bz) > SHORTCUT.reach) continue;
    const span = rel(sc.sOut, sc.sIn);
    const a = rel(s0, sc.sIn);
    const b = rel(s1, sc.sIn);
    if (a > -SHORTCUT.slack && a < span && b > a && b < span + SHORTCUT.slack) return true;
  }
  return false;
}

/** A shortcut jump counts within `reach` of the alley (m), its progress at most `slack` outside the shortcut's span (m). */
const SHORTCUT = { reach: 14, slack: 40 } as const;

/**
 * When a racing car counts as lost (race modes; see updateOpenWorld for test
 * drive). Distances in m beyond the route's half width, times in s.
 * RaceCar.stuckTime is the lost timer.
 */
export const LOST = {
  /** Further than this from the route corridor for `time` s. */
  lateral: 60,
  time: 5,
  /** Off every drivable surface (inside a block) for this long. */
  offroadTime: 1.5,
  /** Instant reset this far out. */
  farLateral: 160,
  /** Forward progress jumps above this (m per tick) are cut to the distance actually driven. */
  maxJump: 70,
} as const;

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
    d.zoneBonus = 0;
    return;
  }
  if (c.drifting && c.speed > 12 && !rc.wrongWay) {
    const angle = Math.min(abs(c.slipAngle) / DEG, 60);
    const gain = angle * c.speed * DT * 0.6;
    const zoneMul = r.driftZones.cars[0]?.scoreMul ?? 1;
    d.current += gain * zoneMul;
    d.zoneBonus += gain * (zoneMul - 1);
    d.chainTime += DT;
    d.graceTime = 0.7;
    d.multiplier = Math.min(5, 1 + Math.floor(d.chainTime / 2));
  } else if (d.current > 0) {
    d.graceTime -= DT;
    if (d.graceTime <= 0) {
      const banked = Math.round(d.current * d.multiplier);
      const zone = Math.round(d.zoneBonus * d.multiplier);
      d.total += banked;
      d.lastBank = banked;
      r.events.push({ tick: r.tick, type: 'driftBank', car: 0, value: banked, ...(zone > 0 ? { other: zone } : {}) });
      d.current = 0;
      d.multiplier = 1;
      d.chainTime = 0;
      d.zoneBonus = 0;
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
