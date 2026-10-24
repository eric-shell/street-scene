/**
 * Race lifecycle: grid, countdown, progress along the route, laps,
 * checkpoints, positions, wrong way, reset to road, drafting, drift scoring,
 * and the player input log. Everything here is pure and deterministic: given
 * the same config and the same input frames, every tick is identical.
 * Five modes: circuit laps, the A to B sprint, drift (score attack on the
 * circuit), drag (one rival side by side down a straight) and waypoint (the
 * city is open, the race is to reach its waypoints in order by any streets).
 */
import { createCity, createWorld, World, City, RouteProgress } from '../city/world';
import { GridSlot, Route, RouteKind, RouteWaypoint, routeSample } from '../city/route';
import { carParkProgress, onCarPark } from '../city/districts/carPark';
import { highwayResetPose } from '../city/districts/highway/settle';
import { CarState, createCar, gridRev, groundPitch, groundRoll, refillNitrous, steerLimit, stepCar, wheelRpm, type StepEnv } from './car';
import { relocateCar } from './reset';
import { WorldHit, carsOverlap, collideCarWithWorld, collideCars, detectNearMiss } from './collision';
import { CRASH_EVENT, DT, TICK_HZ } from './constants';
import { InputFrame, NEUTRAL_INPUT, packInput, quantizeInput } from './input';
import { CarTuning } from './tuning';
import { PerformanceBuild, tuningForBuild, validatePerformance } from './build';
import { DEG, PI, TAU, abs, atan2, clamp, cos, distToSegment, segmentT, sin, sqrt, wrapIndex, yawOf } from './math';
import { AiState, Course, aiInput, buildRacingLine, createAi, driverDetours, driverLine, RacingLine, rollDrivers, sweepFrame } from './ai';
import { deriveSeed } from './prng';
import { stepProps } from './props';
import { RailState, createRailState } from './rails';
import { TrafficState, createTraffic, stepTraffic, trafficTuning } from './traffic';
import { DriftZoneState, createDriftZoneState, stepDriftZones } from './driftZones';
import { waitingAtGate } from './gates';
import { stepLevelCrossings } from './levelCrossing';

export type RaceMode = 'circuit' | 'sprint' | 'drift' | 'drag' | 'waypoint';

/** The route each mode runs on (drift laps the circuit). */
export const MODE_ROUTE: Record<RaceMode, RouteKind> = { circuit: 'circuit', sprint: 'sprint', drift: 'circuit', drag: 'drag', waypoint: 'waypoint' };

/** Modes run once from A to B: one lap, finished on the line. */
export const POINT_TO_POINT: ReadonlySet<RaceMode> = new Set(['sprint', 'drag', 'waypoint']);
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
  /**
   * Seed of the rivals' personalities (src/sim/ai.ts rollDrivers): rolled fresh
   * for every race start, so each race's field drives its own lines its own
   * way; replays carry it. Missing (older replays, tests) = derived from `seed`.
   */
  aiSeed?: number;
  /**
   * Open world only: the player starts here, rolling, instead of on the grid
   * (free roam from the menu carries on from the car cruising behind it,
   * game/streetStage.ts). Ignored on a grid start; absent, the grid as ever.
   */
  start?: StartPose;
}

/** Where and how the player starts off the grid: a pose on a street, a speed, and the sim tick the clock starts on. */
export interface StartPose {
  x: number;
  z: number;
  /** Heading (rad): forward is (sin yaw, cos yaw). */
  yaw: number;
  /** Rolling speed along the heading (m/s). */
  speed: number;
  /** Ground height it was on (m): picks the level under a river bridge deck (World.heightAt); the deck when missing. */
  y?: number;
  /**
   * First tick of the race: the timed gates, the trains and the El are
   * pure schedules of the tick, so starting on the tick the menu city showed
   * keeps them where they were on screen.
   */
  tick: number;
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
  /** Waypoint races: the waypoints (route.waypoints, the finish excluded) this car has reached, a bit each. */
  waypointsReached: number;
  /** Waypoint races: the target this car is heading for, an index into route.waypoints (the finish once every waypoint is reached). */
  waypointTarget: number;
  finished: boolean;
  finishTick: number;
  wrongWayTime: number;
  wrongWay: boolean;
  resetCooldown: number;
  /** Time left passing through other cars, racers and traffic, after a reset (s); 0 = solid. */
  passThrough: number;
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
  /** What happened this race, in order (RaceEvent): the session turns each into HUD messages, sounds and effects. */
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

/** Wall hit events: the least impact speed that makes one (m/s); car crashes and the gap between events are CRASH_EVENT's. */
const WALL_EVENT_SPEED = 3;

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
  /** Waypoint races: the player may finish off the route's line, so the runout just brakes straight with this. */
  freeBrake: 0.4,
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
/** A drag is head to head: the player and one rival. */
export const DRAG_OPPONENTS = 1;

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
    laps: POINT_TO_POINT.has(cfgIn.mode) ? 1 : Math.max(1, Math.min(10, Math.round(cfgIn.laps))),
    opponents: cfgIn.mode === 'drift' || cfgIn.openWorld ? [] : cfgIn.opponents.slice(0, cfgIn.mode === 'drag' ? DRAG_OPPONENTS : MAX_OPPONENTS),
    player: { ...cfgIn.player, performance: validatePerformance(cfgIn.player.performance) },
  };
  const kind = MODE_ROUTE[config.mode];
  // A waypoint race runs in the open city: no barriers between the waypoints, any street goes.
  const open = config.openWorld === true || config.mode === 'waypoint';
  const w =
    world && world.seed === config.seed && world.route.kind === kind && (world.openWorld === true) === open
      ? world
      : createWorld(config.seed, kind, cityForSeed(config.seed), { openWorld: open });
  const route = w.route;
  const entrants = [config.player, ...config.opponents];
  const line = buildRacingLine(w);
  const distance = route.closed ? route.length * config.laps : route.finishS - route.startS;
  // Every rival drives its own way: a personality rolled per race, its own line through the sweep frame, and its shortcut detours.
  const drivers = rollDrivers(deriveSeed(config.aiSeed ?? config.seed, 'drivers'), config.opponents.length);
  const frame = drivers.length ? sweepFrame(line) : null;
  const courses: Course[] = drivers.map((d) => {
    const own = driverLine(frame!, d);
    return { line: own, distance, laps: config.laps, detours: driverDetours(own, route, w.graph, d) };
  });
  const slots = gridSlots(route.grid, entrants.length);
  // Off the grid (open world only): the player's start pose and the tick the clock starts on.
  const start = open ? config.start : undefined;
  const tick0 = start?.tick ?? 0;
  const cars: RaceCar[] = entrants.map((e, i) => {
    const slot = i === 0 && start ? start : slots[i];
    const tuning = tuningForBuild(e.carId, validatePerformance(e.performance));
    const state = createCar(slot.x, slot.z, slot.yaw, w.driveHeightAt(slot.x, slot.z, i === 0 && start ? start.y : undefined));
    if (i === 0 && start) rollCar(state, tuning, start.speed, w);
    state.manualGearbox = i === 0 && config.manualGearbox;
    // AI drives with traction control: stable lines, no power oversteer surprises.
    state.tractionControl = i === 0 ? config.tractionControl === true : true;
    // The grid stands just behind the start line, so resolve it from the start's segment: a start on a
    // bridge deck over the channel may have the lap's floor leg running right beneath it, and nearest in
    // plan alone would put a car there. A handoff pose (free roam) is wherever the car was: no hint.
    const p = w.routeProgress(slot.x, slot.z, i === 0 && start ? undefined : startSeg(route));
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
      lapStartTick: tick0,
      lapTimes: [],
      bestLap: 0,
      nextCheckpoint: 0,
      waypointsReached: 0,
      waypointTarget: 0,
      finished: false,
      finishTick: 0,
      wrongWayTime: 0,
      wrongWay: false,
      resetCooldown: 0,
      passThrough: 0,
      stuckTime: 0,
      ai: i === 0 ? null : createAi(DIFFICULTY_PACE[config.difficulty], drivers[i - 1], courses[i - 1]),
    };
  });
  // A start off the grid is a car already on screen: its traffic spawns out of sight, as respawns do.
  const traffic = config.traffic ? createTraffic(w, cars, config.seed, config.openWorld === true, !!start) : null;
  return {
    config,
    world: w,
    line,
    tick: tick0,
    phase: 'countdown',
    countdownTicks: config.openWorld ? 0 : COUNTDOWN_SECONDS * TICK_HZ,
    cars,
    distance,
    inputLog: [],
    drift: { total: 0, current: 0, multiplier: 1, chainTime: 0, graceTime: 0, zoneBonus: 0 },
    events: [],
    hitTicks: { wall: cars.map(() => -CRASH_EVENT.gap), pair: cars.flatMap(() => cars.map(() => -CRASH_EVENT.gap)) },
    brokenProps: coveredPropsRemoved(w),
    brokenArms: new Uint8Array((w.timedGates?.gates.length ?? 0) * 2),
    rails: createRailState(w),
    traffic,
    driftZones: createDriftZoneState(w, cars.length),
  };
}

/** The route segment holding the start line (the last one of a circuit, the one at startS of a sprint). */
function startSeg(route: Route): number {
  const nseg = route.points.length - 1;
  if (route.closed) return nseg - 1;
  let i = 0;
  while (i + 1 < nseg && route.cum[i + 1] <= route.startS) i++;
  return i;
}

/**
 * Set a car rolling at `speed` along its heading, as it would be if it had
 * driven here: lying on the ground's own angle, wheels turning with the road
 * (a still wheel at speed is a locked one), in the gear the automatic would
 * have reached with the revs to match.
 */
function rollCar(c: CarState, t: CarTuning, speed: number, world: World): void {
  const sl = world.slopeAt(c.x, c.z, c.y);
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  c.pitch = groundPitch(sl, fx, fz);
  c.roll = groundRoll(sl, fx, fz);
  c.vx = sin(c.yaw) * speed;
  c.vz = cos(c.yaw) * speed;
  c.speed = speed;
  c.wheelSpeedFront = c.wheelSpeedRear = speed;
  for (const w of c.wheels) w.spinRate = speed / t.geometry.wheelRadius;
  const up = t.gearbox.upshiftRpmFrac * t.engine.redline;
  let gear = 1;
  while (gear < t.gearbox.ratios.length && wheelRpm(t, gear, speed) > up) gear++;
  c.gear = gear;
  c.rpm = Math.max(t.engine.idleRpm, wheelRpm(t, gear, speed));
}

/** Fresh broken-prop flags: props under this route's barriers/rails start removed (2, no debris). */
function coveredPropsRemoved(w: World): Uint8Array {
  const flags = new Uint8Array(w.props?.length ?? 0);
  for (const id of w.coveredProps ?? []) flags[id] = 2;
  return flags;
}

/** Race clock in seconds (0 until the green light; a start off the grid counts from its first tick). */
export function raceTime(r: RaceState): number {
  return Math.max(0, r.tick - r.countdownTicks - (r.config.openWorld && r.config.start ? r.config.start.tick : 0)) / TICK_HZ;
}

export function ticksToSeconds(ticks: number): number {
  return ticks / TICK_HZ;
}

/** Reset a car to the road centerline at its current progress (the waypoint race's player: onto the nearest street). */
export function resetToRoad(r: RaceState, rc: RaceCar): void {
  if (r.config.openWorld || (rc.isPlayer && r.config.mode === 'waypoint')) return resetToStreet(r, rc);
  const route = r.world.route;
  let s = route.closed ? rc.rawS : clamp(rc.rawS, 0, route.length);
  let p = routeSample(route, s);
  // Never onto a bridge deck's footprint over the river channel, where two levels stack and the
  // car's level would have to be guessed: a little further along the route, off it.
  for (let k = 0; k < RESET_OFF_DECK.tries && r.world.twoLevels(p.x, p.z); k++) {
    s = route.closed ? s + RESET_OFF_DECK.step : Math.min(route.length, s + RESET_OFF_DECK.step);
    p = routeSample(route, s);
  }
  // Nudge to the right lane so we are not dropped onto another car head on.
  const half = route.segWidth[p.seg] / 2;
  const lateral = -Math.min(2, half * 0.35);
  relocateCar(r, rc, p.x + p.tz * lateral, p.z - p.tx * lateral, yawOf(p.tx, p.tz));
}

/** Seconds off the road network before an open world car counts as lost and is put back. */
const OPEN_WORLD_LOST_TIME = 2;
/** A reset target under a bridge deck moves on along the road by `step` m, up to `tries` times (a deck is about 30 m across). */
const RESET_OFF_DECK = { step: 8, tries: 6 } as const;

/**
 * Open world reset: onto the right hand lane of the nearest street, facing the
 * way along it closest to the car's heading, clear of the intersections.
 */
export function resetToStreet(r: RaceState, rc: RaceCar): void {
  const g = r.world.graph;
  const c = rc.state;
  // Up on the highway (its deck or a ramp): back onto the deck, on the level it was on.
  if (r.world.upperLevel(c.x, c.z, c.y)) {
    const up = highwayResetPose(r.world.areas, c.x, c.z, c.yaw);
    if (up) return relocateCar(r, rc, up.x, up.z, up.yaw, false, up.y + 0.5);
  }
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
  let u = clamp((c.x - a.x) * tx + (c.z - a.z) * tz, margin, len - margin);
  let px = a.x + tx * u;
  let pz = a.z + tz * u;
  // Off a bridge deck's footprint (two levels there), either way along the street.
  for (let k = 1; k <= RESET_OFF_DECK.tries && r.world.twoLevels(px, pz); k++) {
    u = clamp(u + (k % 2 ? k : -k) * RESET_OFF_DECK.step, margin, len - margin);
    px = a.x + tx * u;
    pz = a.z + tz * u;
  }
  if (sin(c.yaw) * tx + cos(c.yaw) * tz < 0) {
    tx = -tx;
    tz = -tz;
  }
  const lateral = -Math.min(2, e.width * 0.175);
  relocateCar(r, rc, px + tz * lateral, pz - tx * lateral, yawOf(tx, tz));
}

/** Open world: no laps, checkpoints or wrong way; only a car lost off the road network is put back. */
function updateOpenWorld(r: RaceState, rc: RaceCar): void {
  rc.wrongWay = false;
  rc.wrongWayTime = 0;
  const c = rc.state;
  // Up on the highway a car is on the road whatever the ground beneath it is.
  if (r.world.surfaceAt(c.x, c.z) === 'offroad' && !r.world.upperLevel(c.x, c.z, c.y)) rc.stuckTime += DT;
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
  // The waypoint race's player may come in down any street: hold the heading (yaw rate damped) and stop.
  if (rc.isPlayer && r.config.mode === 'waypoint') return { ...NEUTRAL_INPUT, steer: clamp(c.yawRate * RUNOUT.yawDamping, -RUNOUT.maxSteer, RUNOUT.maxSteer), brake: RUNOUT.freeBrake };

  // Steer: hold the lane the car crossed the line in, along the route heading a little ahead.
  const ahead = routeSample(route, rc.rawS + c.speed * RUNOUT.lookTime);
  const room = Math.max(0, route.segWidth[ahead.seg] / 2 - RUNOUT.edgeMargin);
  const laneErr = clamp(ro.lateral, -room, room) - rc.lateral; // + = lane is to the left
  const yawDes = yawOf(ahead.tx, ahead.tz) + clamp(laneErr * RUNOUT.laneGain, -RUNOUT.laneMax, RUNOUT.laneMax);
  const velYaw = c.speed > 2 ? atan2(c.vx, c.vz) : c.yaw;
  let err = yawDes - velYaw;
  while (err > PI) err -= TAU;
  while (err < -PI) err += TAU;
  // Yaw rate is positive turning left; positive steer turns right.
  const yrDes = clamp(err * RUNOUT.headingGain, -RUNOUT.maxYawRate, RUNOUT.maxYawRate);
  const delta = atan2((yrDes * t.geometry.wheelbase) / Math.max(3, c.speed), 1);
  const limit = steerLimit(t, c.speed);
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
    vt = Math.min(vt, line.speed[wrapIndex(i0 + k, line.n, line.closed)]);
  }
  const brake = clamp(RUNOUT.coastBrake + (c.speed - vt) * RUNOUT.brakeGain, RUNOUT.coastBrake, 1);
  return { ...NEUTRAL_INPUT, steer, brake };
}

/** The world each car steps against, reused tick to tick (no allocation per car). */
const stepEnv: StepEnv = { world: null as unknown as World };

/** Advance the race exactly one tick with the player's input frame. */
export function stepRace(r: RaceState, rawInput: InputFrame): void {
  const input = quantizeInput(rawInput);
  r.inputLog.push(packInput(input));
  const racing = r.tick >= r.countdownTicks;

  // Gather inputs first so AI decisions see a consistent snapshot.
  const inputs: InputFrame[] = r.cars.map((rc) => {
    // After the finish the player's controls are ignored and the runout drives the car.
    if (rc.isPlayer) return rc.finished ? runoutInput(r, rc) : input;
    // A drag's rival or a waypoint racer that finished brakes down the runout too (the older modes keep their AI rolling on, as their replays have it).
    if (rc.finished && (r.config.mode === 'drag' || r.config.mode === 'waypoint')) return runoutInput(r, rc);
    return aiInput(r, rc);
  });

  if (!racing) {
    // Grid: engines rev (the two-step and a line lock burnout included, car.ts gridRev), cars hold still.
    for (let i = 0; i < r.cars.length; i++) gridRev(r.cars[i].state, r.cars[i].tuning, inputs[i], DT);
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
    stepEnv.world = r.world;
    stepCar(rc.state, rc.tuning, inp, stepEnv);
  }
  const hit: WorldHit = { speed: 0, kind: 'wall' };
  for (const rc of r.cars) {
    rc.state.impact = collideCarWithWorld(rc.state, rc.tuning, r.world, hit, r.rails, r.tick);
    if (hit.speed > WALL_EVENT_SPEED && r.tick - r.hitTicks.wall[rc.index] >= CRASH_EVENT.gap) {
      r.hitTicks.wall[rc.index] = r.tick;
      r.events.push({ tick: r.tick, type: 'wall', car: rc.index, kind: hit.kind, value: hit.speed });
    }
  }
  // Destructible street furniture: knocks props down, slows cars, emits 'prop' events.
  stepProps(r);
  // Level crossings (sim/levelCrossing.ts): arms snap under cars, a car left on the tracks when a train comes is towed off.
  stepLevelCrossings(r);
  for (let i = 0; i < r.cars.length; i++) {
    if (r.cars[i].finished) continue;
    for (let j = i + 1; j < r.cars.length; j++) {
      // Finished cars pull out of the race: no contact, so they never block anyone; nor does a car just reset.
      if (r.cars[j].finished || r.cars[i].passThrough > 0 || r.cars[j].passThrough > 0) continue;
      const imp = collideCars(r.cars[i].state, r.cars[i].tuning, r.cars[j].state, r.cars[j].tuning);
      if (imp > 0) {
        r.cars[i].state.impact = Math.max(r.cars[i].state.impact, imp);
        r.cars[j].state.impact = Math.max(r.cars[j].state.impact, imp);
        const pair = i * r.cars.length + j;
        if (imp > CRASH_EVENT.speed && r.tick - r.hitTicks.pair[pair] >= CRASH_EVENT.gap) {
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
    if (rc.passThrough > 0) {
      rc.passThrough -= DT;
      // Never solid again inside another car: the window holds until it is clear.
      if (rc.passThrough <= 0 && insideAnotherCar(r, rc)) rc.passThrough = DT;
    }
    updateProgress(r, rc);
  }
  // Drift zones: the extra refill for drifting on the plaza and the lots, and the score multiplier updateDrift reads.
  stepDriftZones(r);
  if (r.config.mode === 'drift') updateDrift(r);

  r.tick++;
}

/** The reset car `rc` sits inside a racer still in the race or a traffic car. */
function insideAnotherCar(r: RaceState, rc: RaceCar): boolean {
  for (const o of r.cars) if (o !== rc && !o.finished && carsOverlap(rc.state, rc.tuning, o.state, o.tuning)) return true;
  for (const c of r.traffic?.cars ?? []) if (c.mode !== 'gone' && carsOverlap(rc.state, rc.tuning, c.body, trafficTuning(c.kind))) return true;
  return false;
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
  if (r.config.mode === 'waypoint') return updateWaypoints(r, rc, p);
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
  if (rc.dist >= r.distance && rc.nextCheckpoint >= total) finishCar(r, rc);
  updateLost(r, rc, p);
}

/** A car crossed the line: its finish tick, an A to B race's time as its one lap, the finish event. */
function finishCar(r: RaceState, rc: RaceCar): void {
  const raceStartTick = r.countdownTicks;
  rc.finished = true;
  rc.finishTick = r.tick + 1;
  if (!r.world.route.closed) {
    rc.lapTimes.push(rc.finishTick - raceStartTick);
    rc.bestLap = rc.finishTick - raceStartTick;
  }
  r.events.push({ tick: r.tick, type: 'finish', car: rc.index });
  if (rc.isPlayer) r.phase = 'finished';
}

/** Scratch for the edges near a car (roadDistance). */
const nearEdges: number[] = [];

/**
 * Distance by road (m) from a point to a waypoint race target: along a street
 * to either of its ends, then the target's distance field on from there
 * (straight along it when the target is the finish on that street). Inside a
 * junction a car is on every road that meets there, so the shortest over all
 * of them counts (the curved grid's oblique corners put a rounded line well
 * off the centerlines, nearer a third street's than the one it turns into);
 * off every road, the nearest street.
 */
export function roadDistance(w: World, t: RouteWaypoint, x: number, z: number): number {
  const g = w.graph;
  w.blocks.edgeGrid.query(x - 1, z - 1, x + 1, z + 1, nearEdges);
  // Off every street's corridor (deep in a park, say): all of them.
  const n = nearEdges.length || g.edges.length;
  let best = -1;
  let bestD = Infinity;
  let onRoad = Infinity;
  for (let i = 0; i < n; i++) {
    const e = g.edges[nearEdges.length ? nearEdges[i] : i];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
    if (d <= e.width / 2) onRoad = Math.min(onRoad, viaEdge(w, t, e.id, x, z));
    if (d < bestD || (d === bestD && e.id < best)) {
      bestD = d;
      best = e.id;
    }
  }
  return onRoad < Infinity ? onRoad : viaEdge(w, t, best, x, z);
}

/** roadDistance along edge `eid`: to either end and on by the field, or straight to the target on it. */
function viaEdge(w: World, t: RouteWaypoint, eid: number, x: number, z: number): number {
  const e = w.graph.edges[eid];
  const a = w.graph.nodes[e.a];
  const b = w.graph.nodes[e.b];
  const u = segmentT(x, z, a.x, a.z, b.x, b.z) * e.length;
  const via = Math.min(u + t.field[e.a], e.length - u + t.field[e.b]);
  return e.id === t.edge ? Math.min(via, abs(u - t.along)) : via;
}

/** Waypoint races: the player's target switches to another waypoint only once it is this much nearer by road (m), so two about as far do not flicker. */
export const WAYPOINT_RACE = { switchMargin: 20 } as const;

/**
 * Waypoint race progress: the waypoints (route.waypoints but the last) count
 * in any order once a car drives within their radius, down whatever streets it
 * took, and the finish line (the last target) once all of them are reached
 * ('checkpoint' events, value = targets reached; nextCheckpoint is that count).
 * The player heads for the nearest waypoint left by road (waypointTarget, what
 * the HUD's arrow points at), the AI for the next one along the suggested
 * route. The distance the standings and the HUD read is the route distance of
 * the k-th target (k = targets reached; for the AI, the target's own index)
 * less the distance by road still to go to the target, never behind the
 * (k-1)-th: the AI's progress watch and the standings both need it to grow as
 * a car closes in, whichever way it goes.
 * The player is free of the route (lost only off every street, as in free
 * roam); the AI drives the suggested route and keeps the route's checks.
 */
function updateWaypoints(r: RaceState, rc: RaceCar, p: RouteProgress): void {
  const route = r.world.route;
  const targets = route.waypoints ?? [];
  const n = targets.length - 1;
  const c = rc.state;
  if (rc.lap === 0) {
    rc.lap = 1;
    rc.lapStartTick = r.countdownTicks;
  }
  const inside = (t: RouteWaypoint) => (c.x - t.x) ** 2 + (c.z - t.z) ** 2 <= t.radius * t.radius;
  for (let i = 0; i < n; i++) {
    if (rc.waypointsReached & (1 << i) || !inside(targets[i])) continue;
    rc.waypointsReached |= 1 << i;
    rc.nextCheckpoint++;
    r.events.push({ tick: r.tick, type: 'checkpoint', car: rc.index, value: rc.nextCheckpoint });
  }
  if (rc.nextCheckpoint === n && inside(targets[n])) {
    rc.nextCheckpoint++;
    r.events.push({ tick: r.tick, type: 'checkpoint', car: rc.index, value: rc.nextCheckpoint });
  }
  if (rc.nextCheckpoint > n) {
    rc.dist = r.distance;
    return finishCar(r, rc);
  }
  let k = rc.nextCheckpoint;
  let d: number;
  if (rc.nextCheckpoint === n) {
    rc.waypointTarget = n;
    d = roadDistance(r.world, targets[n], c.x, c.z);
  } else if (rc.isPlayer) {
    // The nearest waypoint left by road, the current target kept unless another is clearly nearer.
    const cur = rc.waypointsReached & (1 << rc.waypointTarget) || rc.waypointTarget >= n ? -1 : rc.waypointTarget;
    let best = cur;
    d = cur < 0 ? Infinity : roadDistance(r.world, targets[cur], c.x, c.z);
    const keep = d - WAYPOINT_RACE.switchMargin;
    let bestD = cur < 0 ? Infinity : keep;
    for (let i = 0; i < n; i++) {
      if (i === cur || rc.waypointsReached & (1 << i)) continue;
      const di = roadDistance(r.world, targets[i], c.x, c.z);
      if (di < bestD) {
        bestD = di;
        best = i;
        d = di;
      }
    }
    rc.waypointTarget = best;
  } else {
    let i = 0;
    while (rc.waypointsReached & (1 << i)) i++;
    rc.waypointTarget = k = i;
    d = roadDistance(r.world, targets[i], c.x, c.z);
  }
  const reached = k > 0 ? targets[k - 1].s - route.startS : -Infinity;
  rc.dist = Math.max(reached, targets[k].s - route.startS - d);
  if (rc.isPlayer) updateOpenWorld(r, rc);
  else updateLost(r, rc, p);
}

/** Wrong way and stuck detection against the route (race modes; open world cars see updateOpenWorld). */
function updateLost(r: RaceState, rc: RaceCar, p: RouteProgress): void {
  const route = r.world.route;
  const c = rc.state;
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
  // A car held at a timed gate (a level crossing's) is waiting, not lost.
  const held = (off > LOST.lateral || offroad) && waitingAtGate(r.world.timedGates, r.tick, c.x, c.z, c.speed);
  if (off > LOST.farLateral && !held) return resetToRoad(r, rc);
  // Up in one of the route's car parks a car is far from the streets but not lost.
  if (((off > LOST.lateral && !onCarPark(r.world, c.x, c.z)) || offroad) && !held) rc.stuckTime += DT;
  else rc.stuckTime = Math.max(0, rc.stuckTime - DT);
  if (rc.stuckTime > (offroad ? LOST.offroadTime : LOST.time)) resetToRoad(r, rc);
}

/**
 * A forward progress jump from s0 to s1 made inside one of the route's
 * shortcuts: the car is within SHORTCUT.reach of the alley's path and the jump
 * runs from around its entry to around its exit (positions relative to the entry,
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
    let d = Infinity;
    for (let i = 0; i + 1 < sc.points.length; i++) d = Math.min(d, distToSegment(x, z, sc.points[i].x, sc.points[i].z, sc.points[i + 1].x, sc.points[i + 1].z));
    if (d > SHORTCUT.reach) continue;
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

/**
 * Drift scoring (drift mode, the player only): points accrue while the car drifts, by angle and speed, the
 * chain's multiplier climbing the longer it holds; a short grace after the drift ends banks them, a hard
 * hit loses them.
 */
const DRIFT_SCORE = {
  /** A hit harder than this (m/s of impact) loses the chain. */
  breakImpact: 3,
  /** The least speed that scores (m/s). */
  minSpeed: 12,
  /** Slip angle counts up to this (deg). */
  maxAngle: 60,
  /** Points per degree of slip per meter driven. */
  rate: 0.6,
  /** How long after a drift ends the chain waits for another before banking (s). */
  grace: 0.7,
  /** The multiplier grows by one per this many seconds of chain (s), up to maxMultiplier. */
  multiplierStep: 2,
  maxMultiplier: 5,
} as const;

/** End a drift chain: no points pending, the multiplier back to one. */
function clearChain(d: DriftScore): void {
  d.current = 0;
  d.multiplier = 1;
  d.chainTime = 0;
  d.zoneBonus = 0;
}

function updateDrift(r: RaceState): void {
  const rc = r.cars[0];
  const c = rc.state;
  const d = r.drift;
  if (c.impact > DRIFT_SCORE.breakImpact && d.current > 0) return clearChain(d);
  if (c.drifting && c.speed > DRIFT_SCORE.minSpeed && !rc.wrongWay) {
    const angle = Math.min(abs(c.slipAngle) / DEG, DRIFT_SCORE.maxAngle);
    const gain = angle * c.speed * DT * DRIFT_SCORE.rate;
    const zoneMul = r.driftZones.cars[0]?.scoreMul ?? 1;
    d.current += gain * zoneMul;
    d.zoneBonus += gain * (zoneMul - 1);
    d.chainTime += DT;
    d.graceTime = DRIFT_SCORE.grace;
    d.multiplier = Math.min(DRIFT_SCORE.maxMultiplier, 1 + Math.floor(d.chainTime / DRIFT_SCORE.multiplierStep));
  } else if (d.current > 0) {
    d.graceTime -= DT;
    if (d.graceTime <= 0) {
      const banked = Math.round(d.current * d.multiplier);
      const zone = Math.round(d.zoneBonus * d.multiplier);
      d.total += banked;
      r.events.push({ tick: r.tick, type: 'driftBank', car: 0, value: banked, ...(zone > 0 ? { other: zone } : {}) });
      clearChain(d);
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
