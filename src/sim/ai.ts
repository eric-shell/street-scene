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
 * Timed gates (a drawbridge going up, sim/gates.ts): they brake to a stop
 * short of one that will be down when they get there, queue behind the cars
 * already waiting and hold still, with the stuck and reverse-out logic off.
 */
import type { World } from '../city/world';
import type { RoadGraph } from '../city/roadGraph';
import type { RaceCar, RaceState } from './race';
import { InputFrame, NEUTRAL_INPUT } from './input';
import { DEG, TAU, type Vec2, abs, approach, atan2, clamp, cos, lerp, sign, sin, sqrt } from './math';
import { GRAVITY } from './tuning';
import { DT, TICK_HZ } from './constants';
import { Rng } from './prng';
import { type Route, routeSample } from '../city/route';
import { CITY } from '../city/config';
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
  /** Traffic: lateral offset (m) taken round a traffic car ahead. */
  dodgeOffset: 2.6,
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

/**
 * Rival personalities: the ranges rollDrivers draws a field from, and what
 * aggression (0 patient .. 1 all elbows) changes at the wheel. Pairs are
 * [min, max] for drawn traits and [at aggression 0, at 1] for the rest.
 */
export const DRIVER = {
  /**
   * Pace on top of the difficulty's: the field's own lines, corner cuts and shortcuts are quicker than
   * the shared line, so its speeds are trimmed to this (a race runs as long as it did with every
   * rival on the shared line, and the difficulty keeps its meaning); each driver drawn skill either side.
   */
  pace: 0.9,
  skill: 0.025,
  /** Line: share of the road's room it uses (1 = the shared line's full sweep). */
  width: [0.65, 1],
  /** Line: the favoured side sits up to this share of its room off the middle. */
  side: 0.5,
  /** Line: the sweep slides along the route this far (m), early (negative) to late apex. */
  apex: [-8, 12],
  /** Line: wander amplitude (m) and wavelength (m), so lines differ corner by corner... */
  wander: [0.3, 1.5],
  wavelength: [140, 260],
  /** ...capped so its bend (1/m) never costs the straights speed: 0.9 g holds about 85 m/s on it. */
  wanderBend: 0.0012,
  /**
   * Line: the minimum curvature solve, coarse to fine (sample stride, passes), the pull toward the
   * wanted offsets at the finest stride (against the bend: low keeps the corner sweeps whole), and the
   * passes that settle an apex shift.
   */
  levels: [
    { stride: 8, iterations: 150 },
    { stride: 2, iterations: 200 },
    { stride: 1, iterations: 40 },
  ],
  pull: 0.002,
  apexIterations: 8,
  /**
   * Sweep frame: gaussian (m) that rounds the centerline into its reference, how far out (m) its
   * bounds are looked for and in how many halvings, how many centerline samples either way are
   * checked, and the share of a bend's radius an offset to its inside may take.
   */
  frameSigma: 8,
  frameReach: 16,
  frameSteps: 11,
  frameWindow: 6,
  frameFold: 0.8,
  /** Corner speed, as a share of AI.lateralGrip, and noise either side. */
  grip: [0.95, 1.05],
  gripNoise: 0.02,
  /** Planned braking, as a share of AI.brakeDecel (late brakers brake later and harder), and noise either side. */
  braking: [0.88, 1.18],
  brakingNoise: 0.04,
  /** Consistency drawn (1 = metronome); at 0 the pace errs up to this share either side, per this many m of race. */
  consistency: [0.3, 1],
  slip: 0.06,
  section: 60,
  /** Green light to full throttle (s); waiting, the brake holds the car (under the 0.5 that would engage reverse). */
  reaction: [0.04, 0.38],
  reactionBrake: 0.45,
  /** Nitrous kept back for passes and the final push (share of the tank), and noise either side. */
  reserve: [0.5, 0],
  reserveNoise: 0.1,
  /** The final push: the last share of the race, where the reserve goes too. */
  finalPush: 0.25,
  /** Nitrous lights when the line ahead is this much faster than the car (m/s), and stays lit this long (s). */
  nitroLead: [9, 4],
  nitroHold: [0.9, 1.6],
  /** Passing: a car in its path this far ahead (m) is passed, with this lateral gap (m) on top of both half widths. */
  passLook: [16, 30],
  passClear: [1.1, 0.4],
  /** Passing: how far past the line's edge margin (m) it squeezes for a gap. */
  squeeze: [0, 0.3],
  /**
   * Off its line (passing, blocking, giving room, dodging) it keeps this clear (m) of walls past its
   * half width: a side with a wall there (an El pillar, a barrier) is no way past, and a target that
   * close is pulled back toward the line, halving at most offPulls times.
   */
  wallClear: 0.6,
  offPulls: 3,
  /** Passing: a car counts as passed once this far (m) behind, nose to tail; until it is alongside, closing on it no faster than this (m/s). */
  passDone: 1.5,
  passDelta: [6, 12],
  /** From this aggression it dives for the inside of the next corner, below `patient` it waits out a braking zone (the line ahead slower than this share of its speed). */
  diveFrom: 0.6,
  patient: 0.4,
  brakeZone: 0.82,
  /** A turn under this (sine of the heading change over the next 40 m) is a straight: no inside to dive for. */
  straight: 0.15,
  /** No pass starts where the road ahead narrows (within narrowLook samples) under this much room for its middle (m): two abreast will not fit. */
  narrowRoom: 3,
  narrowLook: 12,
  /**
   * Following a car it cannot pass (yet): time gap (s) and standing gap (m) kept, the braking (m/s^2)
   * its speed allows for closing to that gap, and how far ahead (m) a car in its path is watched for it.
   */
  followGap: [0.6, 0.12],
  followMin: 1.5,
  followDecel: 8,
  followLook: 45,
  /** A car ahead slower than this (m/s) is not followed (crashed, reversing out): around it, room or not. */
  followSpeed: 6,
  /** Queued within this (m, nose to tail) behind a moving car, no progress is expected of it. */
  queueGap: 12,
  /** Blocking: from this aggression, a car closing from behind within blockRange (m) draws the line toward it, up to blockMax (m) at 1. */
  blockFrom: 0.55,
  blockRange: 14,
  blockMax: 2,
  /** Giving room: under this aggression, a car alongside gets up to giveRoom (m) more lateral gap (at 0). */
  giveFrom: 0.45,
  giveRoom: 1.2,
  /**
   * Never closing in on a car alongside: lateral gap (m) kept on top of both half widths. Where its
   * line turns in toward one, it holds off, and drops this much (m/s) under it to let it by unless
   * it is that much quicker already.
   */
  sideGap: [0.5, 0.1],
  /** ...moving aside for it at most this far (m) off its line; past that it lets it by, or holds its line. */
  holdOff: 1.5,
  yieldLead: 1.5,
  /** Level with the car alongside within this (m, along); it does not wait on a car slower than yieldMin (m/s). */
  yieldLevel: 0.5,
  yieldMin: 3,
  /** Lateral moves off its line (m/s). */
  moveRate: [2.4, 3.6],
  /**
   * Corner cutting (0..1, leaning with aggression, noise either side): at 1 the line may run cutRoom
   * (m) past the edge margin on the inside of a bend (the frame bending at least cutBend, 1/m), its
   * apexes clipped tightest; never on a straight or a corner's outside, where barriers close the side
   * streets and rails guard the turn.
   */
  cut: [0, 1],
  cutNoise: 0.3,
  cutRoom: 1,
  cutBend: 1 / 80,
  /** ...or this share of a narrow street's room, when that is less. */
  cutShare: 0.35,
  /** Shortcuts: the chance (per shortcut, per lap) it takes one, leaning with aggression, and noise either side: about one in five over a field. */
  shortcut: [0.05, 0.35],
  shortcutNoise: 0.08,
  /**
   * A shortcut's detour starts on its line this far (m of route) before the alley's entry (room to
   * brake for the turn in), follows it to detourTurn before the entry, and is back on it detourTurn
   * past the exit, the detour ending detourRejoin past it.
   */
  detourLead: 70,
  detourTurn: 12,
  detourRejoin: 36,
  /** Down the alley: top speed (m/s), and room either side of its middle for passing (m; a 5.2 m alley has next to none). */
  alleySpeed: 20,
  detourRoom: 0.3,
  /**
   * The turns into and out of the alley are rounded within the street (relaxation passes) from
   * mouthOut (m) out on the street to mouthIn inside the alley's entry and exit, where the path is held
   * on its middle so the car is lined up before the walls start (the street's half width and sidewalk
   * out from the route's middle); its own line before and after stays as it is.
   */
  mouthPasses: 30,
  mouthIn: 8,
  mouthOut: 16,
  /** Steering lookahead on a detour (m, and m per m/s): tighter than on the open road, for a 5.2 m alley. */
  detourLook: 4,
  detourLookPerSpeed: 0.25,
  /** Further than this (m) off the detour (a reset, a tow, a car shoved out of it): back to its own line. */
  detourLost: 10,
} as const;

/** A rival's personality for one race (rollDrivers): how it drives, never what it drives. */
export interface Driver {
  /** 0 patient and clean .. 1 all elbows: braking, passing, following, blocking, nitrous. */
  aggression: number;
  /** Pace multiplier on top of the difficulty's. */
  skill: number;
  /** Share of the road's room its line uses (0..1). */
  width: number;
  /** Favoured side of the road, -1 right .. 1 left. */
  side: number;
  /** Apex shift along the route (m): positive turns in late. */
  apex: number;
  /** Line wander amplitude (m), wavelength (m) and phase (rad). */
  wander: number;
  wavelength: number;
  phase: number;
  /** Corner speed, as a multiplier on AI.lateralGrip. */
  grip: number;
  /** Planned braking, as a multiplier on AI.brakeDecel. */
  braking: number;
  /** 0 erratic .. 1 metronome: pace error per stretch of the race. */
  consistency: number;
  /** Green light to full throttle (s). */
  reaction: number;
  /** Nitrous share kept back for passes and the final push. */
  reserve: number;
  /** 0..1: how far past the edge margin its line clips the inside of a corner (DRIVER.cutRoom at 1). */
  cut: number;
  /** Chance (0..1) it takes a given shortcut on a given lap. */
  shortcuts: number;
  /** Seed of its pace errors and shortcut calls. */
  seed: number;
}

/** The driver without a personality: the race's shared line, no pace error, nothing held back, no shortcuts. Test autopilots drive as this. */
export const NEUTRAL_DRIVER: Readonly<Driver> = Object.freeze({ aggression: 0.5, skill: 1, width: 1, side: 0, apex: 0, wander: 0, wavelength: 200, phase: 0, grip: 1, braking: 1, consistency: 1, reaction: 0, reserve: 0, cut: 0, shortcuts: 0, seed: 0 });

/** The race's sweep frame (sweepFrame): its road bounds, and the bounds a full corner cutter may use (DRIVER.cutRoom wider on the inside of a bend, where no lane closure narrows them). */
export interface SweepFrame extends RacingLine {
  cutLo: Float64Array;
  cutHi: Float64Array;
}

/**
 * A route shortcut as one driver takes it (driverDetours): off its line
 * before the alley's entry, down the alley and over any jump exit, back onto
 * its line past the exit.
 */
export interface Detour {
  /** Samples of the driver's line where it turns off and where it is back on. */
  from: number;
  to: number;
  /** The path, sampled like a racing line on its own middle (the alley leaves no room to pass), at this driver's speeds. */
  line: RacingLine;
}

/** What a rival drives in a race: its own line, the race distance (m) and laps, and its detours (one per route shortcut it could take). */
export interface Course {
  line: RacingLine;
  distance: number;
  laps: number;
  detours: Detour[];
}

export interface RacingLine {
  n: number;
  closed: boolean;
  x: Float64Array;
  z: Float64Array;
  /** Route s of the sample's centerline point (a detour: m along it). */
  s: Float64Array;
  /** Reference point of the sample, which offsets hang off: the centerline (the shared line), the sweep frame's rounded reference (a driver's line), the path itself (a detour). */
  cx: Float64Array;
  cz: Float64Array;
  /** Unit left normal of the reference. */
  nx: Float64Array;
  nz: Float64Array;
  /** Max lateral offset allowed from the reference either way (to stay in the road). */
  room: Float64Array;
  /** Offset bounds from the reference (m): the road's, narrowed on the closed side past a lane closure. */
  lo: Float64Array;
  hi: Float64Array;
  /** Lateral offset of the line from the reference. */
  offset: Float64Array;
  speed: Float64Array;
}

export interface AiState {
  /** Personality (rollDrivers) and its own line (driverLine); a null line drives the race's shared one. */
  driver: Readonly<Driver>;
  line: RacingLine | null;
  /** Pace multiplier per DRIVER.section of race distance, blended between (consistency); empty for a metronome. */
  slips: Float64Array;
  /** Its shortcut detours, and whether it takes each on each lap (detour * laps + lap - 1). */
  detours: Detour[];
  takes: Uint8Array;
  laps: number;
  /** Detour it is driving (-1 none) and its sample there. */
  detour: number;
  didx: number;
  idx: number;
  pace: number;
  /** Lateral offset (m) from its line, eased toward the racecraft target. */
  dodge: number;
  /** Car index it is passing (-1 none) and the side it passes on (1 left, -1 right). */
  passCar: number;
  passSide: number;
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

/**
 * An AI's memory: a rival with its personality and its course, or without
 * them (test autopilots) a NEUTRAL_DRIVER on the race's shared line. Its pace
 * errors and its shortcut calls are drawn here, from the driver's seed.
 */
export function createAi(pace: number, driver: Readonly<Driver> = NEUTRAL_DRIVER, course?: Course): AiState {
  const rng = new Rng(driver.seed);
  const slips = new Float64Array(course && driver.consistency < 1 ? Math.ceil(Math.max(0, course.distance) / DRIVER.section) + 2 : 0);
  const amp = (1 - driver.consistency) * DRIVER.slip;
  for (let k = 0; k < slips.length; k++) slips[k] = 1 + amp * (2 * rng.next() - 1);
  const detours = course?.detours ?? [];
  const laps = course?.laps ?? 1;
  const takes = new Uint8Array(detours.length * laps);
  for (let k = 0; k < takes.length; k++) takes[k] = rng.chance(driver.shortcuts) ? 1 : 0;
  return { driver, line: course?.line ?? null, slips, detours, takes, laps, detour: -1, didx: -1, idx: -1, pace: pace * driver.skill, dodge: 0, passCar: -1, passSide: 0, stuckTime: 0, nitroHold: 0, watchDist: -1e9, watchTime: 0, blocked: 0, reverse: 0, reversed: 0, reverseSteer: 0 };
}

/**
 * A race's field of personalities, one per rival in grid order. Aggression and
 * the favoured side are spread evenly over the field and then shuffled, so a
 * race always has its hothead and its cautious one, its left line and its
 * right; the rest is drawn per driver. Corner speed, braking, corner cutting
 * and the taste for shortcuts lean with aggression, the nitrous reserve
 * against it.
 */
export function rollDrivers(seed: number, count: number): Driver[] {
  const rng = new Rng(seed);
  const spread = (lo: number, hi: number): number[] => rng.shuffle(Array.from({ length: count }, (_, i) => lerp(lo, hi, (i + rng.next()) / count)));
  const draw = (r: readonly [number, number]): number => rng.range(r[0], r[1]);
  const lean = (r: readonly [number, number], a: number, noise: number): number => lerp(r[0], r[1], a) * (1 + rng.range(-noise, noise));
  const aggression = spread(0, 1);
  const side = spread(-1, 1);
  return aggression.map((a, i) => ({
    aggression: a,
    skill: DRIVER.pace * (1 + rng.range(-DRIVER.skill, DRIVER.skill)),
    width: draw(DRIVER.width),
    side: side[i],
    apex: draw(DRIVER.apex),
    wander: draw(DRIVER.wander),
    wavelength: draw(DRIVER.wavelength),
    phase: rng.range(0, TAU),
    grip: lean(DRIVER.grip, a, DRIVER.gripNoise),
    braking: lean(DRIVER.braking, a, DRIVER.brakingNoise),
    consistency: draw(DRIVER.consistency),
    reaction: draw(DRIVER.reaction),
    reserve: clamp(lerp(DRIVER.reserve[0], DRIVER.reserve[1], a) + rng.range(-DRIVER.reserveNoise, DRIVER.reserveNoise), 0, 1),
    cut: clamp(lerp(DRIVER.cut[0], DRIVER.cut[1], a) + rng.range(-DRIVER.cutNoise, DRIVER.cutNoise), 0, 1),
    shortcuts: clamp(lerp(DRIVER.shortcut[0], DRIVER.shortcut[1], a) + rng.range(-DRIVER.shortcutNoise, DRIVER.shortcutNoise), 0, 1),
    seed: rng.int(0, 0x7fffffff),
  }));
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
  const speed = speedProfile(n, route.closed, px, pz, AI.lateralGrip, AI.brakeDecel);
  return { n, closed: route.closed, x: px, z: pz, s, cx, cz, nx, nz, room: roomMin, lo, hi, offset: off, speed };
}

/**
 * The frame the drivers' own lines are solved in (driverLine). The shared
 * line's offsets hang off the centerline polyline, whose normals swing round
 * a node in one sample: offsets to the inside of a corner fold over each
 * other there, so no line could sweep through it. This frame's reference is
 * the centerline rounded by a gaussian along the route (kept inside the
 * shared line's bounds), and its bounds are measured along the rounded
 * normals: as far either way as the point stays inside the shared bounds of a
 * nearby stretch of centerline (their room and lane closures) or round one of
 * its sample points (the outside of a corner), and to the inside of a bend no
 * further than most of its radius; the corner cutters' bounds the same with
 * the road's edges let out (onRoad). Built once per race; the line itself is
 * left on the reference.
 */
export function sweepFrame(base: RacingLine): SweepFrame {
  const { n, closed } = base;
  const wrap = (i: number): number => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  const step = n > 1 ? base.s[1] - base.s[0] : AI.spacing;
  const sigma = DRIVER.frameSigma / step;
  const reach = Math.ceil(3 * sigma);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sz = 0;
    let sw = 0;
    for (let k = -reach; k <= reach; k++) {
      const w = Math.exp((-k * k) / (2 * sigma * sigma));
      const j = wrap(i + k);
      sx += w * base.cx[j];
      sz += w * base.cz[j];
      sw += w;
    }
    // Kept inside the shared bounds across the road (an alley's are next to nothing), free along it.
    const dx = sx / sw - base.cx[i];
    const dz = sz / sw - base.cz[i];
    const lat = dx * base.nx[i] + dz * base.nz[i];
    const keep = clamp(lat, Math.min(0, base.lo[i]), Math.max(0, base.hi[i])) - lat;
    cx[i] = base.cx[i] + dx + base.nx[i] * keep;
    cz[i] = base.cz[i] + dz + base.nz[i] * keep;
  }
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrap(i - 1);
    const b = wrap(i + 1);
    const dx = cx[b] - cx[a];
    const dz = cz[b] - cz[a];
    const l = sqrt(dx * dx + dz * dz) || 1;
    nx[i] = dz / l;
    nz[i] = -dx / l;
  }
  const frame: SweepFrame = { ...base, x: cx, z: cz, cx, cz, nx, nz, lo: new Float64Array(n), hi: new Float64Array(n), room: new Float64Array(n), offset: new Float64Array(n), cutLo: new Float64Array(n), cutHi: new Float64Array(n) };
  // The shared bounds, and a corner cutter's: the road's edges let out by DRIVER.cutRoom, or a share
  // of the room on a narrow street; a lane closure's side stays put.
  const out = (i: number): number => Math.min(DRIVER.cutRoom, DRIVER.cutShare * Math.max(0, base.room[i]));
  const bounds = [
    { lo: base.lo, hi: base.hi },
    { lo: base.lo.map((v, i) => (v <= -base.room[i] ? v - out(i) : v)), hi: base.hi.map((v, i) => (v >= base.room[i] ? v + out(i) : v)) },
  ];
  for (let i = 0; i < n; i++) {
    const bend = bendAt(frame, i);
    for (const cut of [0, 1]) {
      for (const side of [1, -1]) {
        // A cutter's extra room is only on the inside of a bend; elsewhere its bounds are the frame's.
        if (cut && bend * side < DRIVER.cutBend) {
          if (side > 0) frame.cutHi[i] = frame.hi[i];
          else frame.cutLo[i] = frame.lo[i];
          continue;
        }
        // Bisect for the last point on the road along the normal (the reference itself is on it).
        let inn = 0;
        let out: number = DRIVER.frameReach;
        for (let it = 0; it < DRIVER.frameSteps; it++) {
          const o = (inn + out) / 2;
          if (onRoad(base, bounds[cut].lo, bounds[cut].hi, cx[i] + nx[i] * o * side, cz[i] + nz[i] * o * side, i)) inn = o;
          else out = o;
        }
        // The inside of a bend: offsets past its radius would fold over.
        if (bend * side > 0) inn = Math.min(inn, DRIVER.frameFold / abs(bend));
        if (side > 0) (cut ? frame.cutHi : frame.hi)[i] = inn;
        else (cut ? frame.cutLo : frame.lo)[i] = -inn;
      }
    }
    frame.room[i] = Math.min(frame.hi[i], -frame.lo[i]);
  }
  return frame;
}

/**
 * On the shared line's road near sample j, within bounds lo / hi (offsets
 * from its centerline): inside those of one of the centerline's stretches
 * within DRIVER.frameWindow samples, or round one of its sample points within
 * the tighter of its neighbours' bounds on that side (which fills the outside
 * of a corner, and keeps out of a lane closure).
 */
function onRoad(base: RacingLine, lo: Float64Array, hi: Float64Array, x: number, z: number, j: number): boolean {
  const { n, closed, cx, cz } = base;
  const wrap = (i: number): number => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  for (let k = -DRIVER.frameWindow; k <= DRIVER.frameWindow; k++) {
    const a = wrap(j + k);
    const b = wrap(a + 1);
    const rx = x - cx[a];
    const rz = z - cz[a];
    const dx = cx[b] - cx[a];
    const dz = cz[b] - cz[a];
    const len2 = dx * dx + dz * dz;
    if (len2 > 1e-9 && (closed || a < n - 1)) {
      const u = (rx * dx + rz * dz) / len2;
      const lat = (rx * dz - rz * dx) / sqrt(len2);
      if (u >= 0 && u <= 1 && lat >= lerp(lo[a], lo[b], u) && lat <= lerp(hi[a], hi[b], u)) return true;
    }
    const p = wrap(a - 1);
    const left = len2 > 1e-9 ? rx * dz - rz * dx >= 0 : true;
    const r = left ? Math.min(hi[p], hi[a], hi[b]) : -Math.max(lo[p], lo[a], lo[b]);
    if (r > 0 && rx * rx + rz * rz <= r * r) return true;
  }
  return false;
}

/**
 * One driver's own line, solved in the race's sweep frame (sweepFrame). Its
 * road runs out to the frame's bounds or, as far as it cuts corners, the
 * cutters'; its band is the share of that road it uses, around the middle.
 * It wants its favoured side plus its wander, and a minimum curvature solve
 * (sweep) bends the line through every corner's outside-inside-outside within
 * the band, pulled gently toward what it wants on the straights. An apex
 * shift slides the sweeps along the route. Corner speeds and braking points
 * come from its own grip and braking. Shares the samples, reference and
 * normals; its bounds are its road.
 */
export function driverLine(base: SweepFrame, d: Readonly<Driver>): RacingLine {
  const { n, closed } = base;
  const lo = base.lo.map((v, i) => lerp(v, base.cutLo[i], d.cut));
  const hi = base.hi.map((v, i) => lerp(v, base.cutHi[i], d.cut));
  const step = n > 1 ? base.s[1] - base.s[0] : AI.spacing;
  const length = closed ? n * step : base.s[n - 1];
  // A circuit's wander fits whole waves round the lap, so the line closes on itself.
  const waves = closed ? Math.max(1, Math.round(length / d.wavelength)) : length / d.wavelength;
  const k = (TAU * waves) / Math.max(length, 1);
  const amp = Math.min(d.wander, DRIVER.wanderBend / (k * k));
  const blo = new Float64Array(n);
  const bhi = new Float64Array(n);
  const want = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const mid = (lo[i] + hi[i]) / 2;
    const half = (Math.max(0, hi[i] - lo[i]) / 2) * d.width;
    blo[i] = mid - half;
    bhi[i] = mid + half;
    want[i] = mid + d.side * DRIVER.side * half + amp * sin(k * base.s[i] + d.phase);
  }
  const off = new Float64Array(n);
  for (let i = 0; i < n; i++) off[i] = clamp(want[i], blo[i], bhi[i]);
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  for (const level of DRIVER.levels) sweep(base, blo, bhi, want, off, px, pz, level.stride, level.iterations);
  // Early or late apex: the whole sweep slides along the route, then settles back inside the band.
  const shift = d.apex / step;
  if (shift !== 0) {
    const src = Float64Array.from(off);
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) continue;
      const f = i - shift;
      const j = Math.floor(f);
      const a = closed ? ((j % n) + n) % n : clamp(j, 0, n - 1);
      const b = closed ? (((j + 1) % n) + n) % n : clamp(j + 1, 0, n - 1);
      off[i] = clamp(lerp(src[a], src[b], f - j), blo[i], bhi[i]);
    }
    sweep(base, blo, bhi, want, off, px, pz, 1, DRIVER.apexIterations);
  }
  const speed = speedProfile(n, closed, px, pz, AI.lateralGrip * d.grip, AI.brakeDecel * d.braking);
  return { n, closed, s: base.s, cx: base.cx, cz: base.cz, nx: base.nx, nz: base.nz, room: base.room, lo, hi, x: px, z: pz, offset: off, speed };
}

/**
 * Minimum curvature offsets inside [blo, bhi], pulled toward `want`: projected
 * Gauss-Seidel on the squared second differences of every `stride`th sample
 * (the in-between samples follow linearly), each pass moving a point to where
 * its bend is least along its normal. Coarse strides settle a corner's whole
 * outside-inside-outside sweep in a few hundred passes, where the samples
 * alone would take thousands; the pull is scaled by stride^4 so every level
 * weighs it against the same bend. Writes off, px and pz.
 */
function sweep(base: RacingLine, blo: Float64Array, bhi: Float64Array, want: Float64Array, off: Float64Array, px: Float64Array, pz: Float64Array, stride: number, iterations: number): void {
  const { n, closed, cx, cz, nx, nz } = base;
  const m = closed ? Math.floor(n / stride) : Math.floor((n - 1) / stride) + 1;
  const at = (j: number): number => (closed ? ((j % m) + m) % m : clamp(j, 0, m - 1)) * stride;
  const w = DRIVER.pull * stride ** 4;
  const h = (base.s[n - 1] - base.s[0]) / Math.max(1, n - 1) * stride;
  for (let j = 0; j < m; j++) {
    const i = j * stride;
    px[i] = cx[i] + nx[i] * off[i];
    pz[i] = cz[i] + nz[i] * off[i];
  }
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < m; j++) {
      if (!closed && (j === 0 || j === m - 1)) continue;
      const i = j * stride;
      const a2 = at(j - 2);
      const a1 = at(j - 1);
      const b1 = at(j + 1);
      const b2 = at(j + 2);
      // The bends across the line at a1, i and b1 (second differences along the normals there) are
      // linear in the offset o: A + k o. Each is weighed as curvature squared over its length, the
      // spacings either side as they stand (samples bunch on the inside of a bend, where a second
      // difference undercounts the curvature). o takes the least weighted sum plus the pull.
      const la = sqrt((px[a1] - px[a2]) ** 2 + (pz[a1] - pz[a2]) ** 2);
      const li = sqrt((px[i] - px[a1]) ** 2 + (pz[i] - pz[a1]) ** 2);
      const lb = sqrt((px[b1] - px[i]) ** 2 + (pz[b1] - pz[i]) ** 2);
      const lc = sqrt((px[b2] - px[b1]) ** 2 + (pz[b2] - pz[b1]) ** 2);
      const wa = bendWeight(la, li, h);
      const wi = bendWeight(li, lb, h);
      const wb = bendWeight(lb, lc, h);
      const ea = (px[a2] - 2 * px[a1] + cx[i]) * nx[a1] + (pz[a2] - 2 * pz[a1] + cz[i]) * nz[a1];
      const ei = (px[a1] - 2 * cx[i] + px[b1]) * nx[i] + (pz[a1] - 2 * cz[i] + pz[b1]) * nz[i];
      const eb = (cx[i] - 2 * px[b1] + px[b2]) * nx[b1] + (cz[i] - 2 * pz[b1] + pz[b2]) * nz[b1];
      const ka = nx[i] * nx[a1] + nz[i] * nz[a1];
      const kb = nx[i] * nx[b1] + nz[i] * nz[b1];
      const o = clamp((2 * wi * ei - wa * ka * ea - wb * kb * eb + w * want[i]) / (wa * ka * ka + wb * kb * kb + 4 * wi + w), blo[i], bhi[i]);
      off[i] = o;
      px[i] = cx[i] + nx[i] * o;
      pz[i] = cz[i] + nz[i] * o;
    }
  }
  // The samples between follow linearly, kept inside the band.
  for (let j = 0; j < m; j++) {
    const i0 = j * stride;
    const last = j === m - 1;
    const i1 = last ? (closed ? n : n - 1) : i0 + stride;
    const o1 = last && closed ? off[0] : off[Math.min(i1, n - 1)];
    for (let i = i0 + 1; i < i1 && i < n; i++) off[i] = clamp(lerp(off[i0], o1, (i - i0) / (i1 - i0)), blo[i], bhi[i]);
  }
  for (let i = 0; i < n; i++) {
    px[i] = cx[i] + nx[i] * off[i];
    pz[i] = cz[i] + nz[i] * off[i];
  }
}

/**
 * A driver's detours, one per route shortcut its line reaches: along its line
 * from DRIVER.detourLead before the alley's entry, off it to the entry (the
 * route's middle at the junction), down the alley's path, out of the exit
 * (over a jump exit's lip the flight carries on along the last leg), and back
 * along its line to DRIVER.detourRejoin past the exit; sampled every
 * AI.spacing. Speeds come
 * from the path's curvature at the driver's grip and braking, held to
 * DRIVER.alleySpeed down the alley, and a jump exit's run-up to the launch
 * speeds its landing was planned for (the last bend at bendSpeed, then
 * launchAccel to the lip), so the car comes down on the street.
 */
export function driverDetours(line: RacingLine, route: Route, graph: RoadGraph, d: Readonly<Driver>): Detour[] {
  const { n, closed } = line;
  const step = n > 1 ? line.s[1] - line.s[0] : AI.spacing;
  const wrap = (i: number): number => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  const sample = (s: number): number => (closed ? wrap(Math.round(s / step)) : s < 0 || s > line.s[n - 1] ? -1 : Math.round(s / step));
  const J = CITY.districts.backAlley.route.jump;
  const out: Detour[] = [];
  for (const sc of route.shortcuts) {
    const from = sample(sc.sIn - DRIVER.detourLead);
    const turn = sample(sc.sIn - DRIVER.detourTurn);
    const back = sample(sc.sOut + DRIVER.detourTurn);
    const to = sample(sc.sOut + DRIVER.detourRejoin);
    if (from < 0 || turn < 0 || back < 0 || to < 0 || sc.points.length < 2) continue;
    const pts: Vec2[] = [];
    const along = (a: number, b: number): void => {
      for (let i = a, k = 0; k <= n; i = wrap(i + 1), k++) {
        pts.push({ x: line.x[i], z: line.z[i] });
        if (i === b) break;
      }
    };
    along(from, turn);
    const entry = pts.length;
    for (const q of sc.points) pts.push({ x: q.x, z: q.z });
    const exit = pts.length - 1;
    along(back, wrap(to + 2));
    // Every AI.spacing along it; the alley's span and its last bend, as distances along it.
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const m = Math.max(2, Math.ceil(cum[pts.length - 1] / AI.spacing) + 1);
    const x = new Float64Array(m);
    const z = new Float64Array(m);
    const ds = new Float64Array(m);
    let leg = 0;
    for (let i = 0; i < m; i++) {
      const t = Math.min(cum[pts.length - 1], (i * cum[pts.length - 1]) / (m - 1));
      while (leg + 2 < pts.length && t > cum[leg + 1]) leg++;
      const f = (t - cum[leg]) / Math.max(1e-9, cum[leg + 1] - cum[leg]);
      x[i] = lerp(pts[leg].x, pts[leg + 1].x, f);
      z[i] = lerp(pts[leg].z, pts[leg + 1].z, f);
      ds[i] = t;
    }
    // Round the turns in and out within the street; the alley's middle and its own line either side stay put.
    for (let it = 0; it < DRIVER.mouthPasses; it++) {
      for (let i = 1; i < m - 1; i++) {
        const mouth = (ds[i] > cum[entry] - DRIVER.mouthOut && ds[i] < cum[entry] + DRIVER.mouthIn) || (ds[i] > cum[exit] - DRIVER.mouthIn && ds[i] < cum[exit] + DRIVER.mouthOut);
        if (!mouth) continue;
        x[i] = (x[i - 1] + x[i + 1]) / 2;
        z[i] = (z[i - 1] + z[i + 1]) / 2;
      }
    }
    const nx = new Float64Array(m);
    const nz = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(m - 1, i + 1);
      const l = Math.hypot(x[b] - x[a], z[b] - z[a]) || 1;
      nx[i] = (z[b] - z[a]) / l;
      nz[i] = -(x[b] - x[a]) / l;
    }
    const speed = speedProfile(m, false, x, z, AI.lateralGrip * d.grip, AI.brakeDecel * d.braking);
    const jump = graph.edges[sc.edges[sc.edges.length - 1]]?.jumpExit === true;
    const bend = cum[Math.max(entry, exit - 1)];
    for (let i = 0; i < m; i++) {
      if (ds[i] < cum[entry] || ds[i] > cum[exit]) continue;
      speed[i] = Math.min(speed[i], DRIVER.alleySpeed);
      if (jump && ds[i] >= bend) speed[i] = Math.min(speed[i], sqrt(J.bendSpeed * J.bendSpeed + 2 * J.launchAccel * (ds[i] - bend)));
    }
    // Braking for those caps too.
    for (let i = m - 2; i >= 0; i--) speed[i] = Math.min(speed[i], sqrt(speed[i + 1] * speed[i + 1] + 2 * AI.brakeDecel * d.braking * (ds[i + 1] - ds[i])));
    const room = new Float64Array(m).fill(DRIVER.detourRoom);
    out.push({ from, to, line: { n: m, closed: false, x, z, s: ds, cx: x, cz: z, nx, nz, room, lo: room.map((v) => -v), hi: room, offset: new Float64Array(m), speed } });
  }
  return out;
}

/**
 * Weight of a second difference between spacings l1 and l2 (m) against one
 * between even spacings h: it measures curvature times l1 l2, and the bend
 * costs curvature squared over (l1 + l2) / 2. Capped either way.
 */
function bendWeight(l1: number, l2: number, h: number): number {
  const ll = Math.max(l1 * l2, 1e-6);
  return clamp((h * h * h * (l1 + l2)) / (2 * ll * ll), 0.05, 20);
}

/** Target speeds from the line's curvature at `grip` (g), then a backward braking pass at `decel` (m/s^2). */
function speedProfile(n: number, closed: boolean, px: Float64Array, pz: Float64Array, grip: number, decel: number): Float64Array {
  const speed = new Float64Array(n);
  const span = 3;
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - span + n) % n : Math.max(0, i - span);
    const b = closed ? (i + span) % n : Math.min(n - 1, i + span);
    const k = curvature(px[a], pz[a], px[i], pz[i], px[b], pz[b]);
    speed[i] = k > 1e-5 ? Math.min(AI.maxSpeed, sqrt((grip * GRAVITY) / k)) : AI.maxSpeed;
  }
  const passes = closed ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = n - 2 + (closed ? 1 : 0); i >= 0; i--) {
      const nextI = (i + 1) % n;
      const ds = AI.spacing;
      speed[i] = Math.min(speed[i], sqrt(speed[nextI] * speed[nextI] + 2 * decel * ds));
    }
  }
  return speed;
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

/** Signed curvature of the line at sample i (1/m), positive bending left. */
function bendAt(line: RacingLine, i: number): number {
  const a = wrapIdx(line, i - 3);
  const b = wrapIdx(line, i + 3);
  const k = curvature(line.x[a], line.z[a], line.x[i], line.z[i], line.x[b], line.z[b]);
  // Left of a heading (fx, fz) is (fz, -fx): the second chord on the left of the first bends left.
  const turn = (line.x[b] - line.x[i]) * (line.z[i] - line.z[a]) - (line.z[b] - line.z[i]) * (line.x[i] - line.x[a]);
  return turn > 0 ? k : -k;
}

/** Sine of the line's heading change from sample i over the next `k` samples, positive turning left. */
function turnAhead(line: RacingLine, i: number, k: number): number {
  const a = wrapIdx(line, i + 1);
  const b = wrapIdx(line, i + k);
  const c = wrapIdx(line, i + k + 1);
  const ax = line.x[a] - line.x[i];
  const az = line.z[a] - line.z[i];
  const bx = line.x[c] - line.x[b];
  const bz = line.z[c] - line.z[b];
  const l = sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
  return l > 1e-9 ? (bx * az - bz * ax) / l : 0;
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

/** Pace error where the car is in the race (consistency): one value per DRIVER.section, blended between. */
function slipAt(ai: AiState, dist: number): number {
  const n = ai.slips.length;
  if (n < 2) return 1;
  const f = clamp(dist / DRIVER.section, 0, n - 1);
  const k = Math.min(n - 2, Math.floor(f));
  return lerp(ai.slips[k], ai.slips[k + 1], f - k);
}

/**
 * What racecraft asks for: the lateral offset from the line to steer for, null
 * to drive the line, a speed cap (m/s), and the car alongside (null for none),
 * which side (m, left positive) and how near it may come.
 */
interface Craft {
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
const craft: Craft = { target: null, cap: Infinity, passing: false, queued: false, beside: null, besideSide: 0, besideAhead: 0, besideGap: 0 };

/**
 * Racecraft against the other racers. A pass in hand holds its side until the
 * car is behind. A slower car in the path ahead is passed on the side with the
 * room (both: the inside of the next corner from DRIVER.diveFrom, otherwise the
 * nearer way round); a patient driver waits out a braking zone, and with no
 * room either side it follows at its time gap. With nobody to pass, an
 * aggressive driver leans toward a car closing from behind and a calm one gives
 * room to a car alongside. Nobody closes in on a car alongside.
 */
function racecraft(r: RaceState, rc: RaceCar, line: RacingLine, i0: number, ti: number, out: Craft): Craft {
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
      const j = wrapIdx(line, i0 + k);
      narrow = line.hi[j] - line.lo[j] < DRIVER.narrowRoom;
    }
    if (frontAhead >= look || narrow) side = 0;
    else if (canL && canR) {
      const turn = turnAhead(line, i0, 10);
      if (a >= DRIVER.diveFrom && abs(turn) > DRIVER.straight) side = turn > 0 ? 1 : -1;
      else side = abs(lt - myOff) < abs(rt - myOff) ? 1 : abs(lt - myOff) > abs(rt - myOff) ? -1 : ai.driver.side >= 0 ? 1 : -1;
    } else if (canL) side = 1;
    else if (canR) side = -1;
    const wait = a < DRIVER.patient && line.speed[wrapIdx(line, i0 + 10)] * ai.pace < c.speed * DRIVER.brakeZone;
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
    ai.idx = nearestIdx(own, c.x, c.z, ai.idx);
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
  ai.idx = nearestIdx(own, c.x, c.z, lost ? -1 : dt.to);
  return own;
}

/** Clear of walls by `room` (m) at `extra` off the line, at the steering target and halfway to it. */
function clearAt(r: RaceState, line: RacingLine, i0: number, ti: number, extra: number, room: number, y: number): boolean {
  const mid = wrapIdx(line, i0 + Math.round((((ti - i0) % line.n) + line.n) % line.n / 2));
  for (const i of [ti, mid]) if (r.world.wallClearance(line.x[i] + line.nx[i] * (extra + line.offset[ti] - line.offset[i]), line.z[i] + line.nz[i] * (extra + line.offset[ti] - line.offset[i]), room + 0.1, y) < room) return false;
  return true;
}

/** Compute this tick's input for an AI car. Reads race state, mutates only the AI's own memory. */
export function aiInput(r: RaceState, rc: RaceCar): InputFrame {
  const ai = rc.ai!;
  const d = ai.driver;
  const c = rc.state;
  const racing = r.tick >= r.countdownTicks;
  if (!racing) return { ...NEUTRAL_INPUT, throttle: 0.55 };
  if (rc.finished) return { ...NEUTRAL_INPUT, throttle: 0.35, steer: steerToward(r, rc, 0.5) };
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
  const ti = wrapIdx(line, idx + Math.round(look / AI.spacing));
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
  for (let k = 0; k <= 3; k++) vt = Math.min(vt, line.speed[wrapIdx(line, idx + k)]);
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
  const far = line.speed[wrapIdx(line, idx + 25)] * pace;
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
  if (r.world.wallClearance(px, pz, 2, c.y) < g.halfWidth + AI.noseClear) return true;
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
  const ai = rc.ai!;
  const line = ai.line ?? r.line;
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
