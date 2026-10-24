/**
 * The AI's numbers and its people: AI (the shared line's and the driving's tuning), DRIVER (the ranges a
 * rival's personality is drawn from, and what aggression changes at the wheel), the Driver a personality
 * is, the NEUTRAL_DRIVER test autopilots drive as, and rollDrivers, which draws a race's field from its
 * seed. Constants plus the one draw, so every other AI module can read them without a cycle.
 */
import { TAU, clamp, lerp } from '../math';
import { Rng } from '../prng';

export const AI = {
  spacing: 4,
  /** With no place on a line yet, only samples within this (m) of the car's route distance count (see nearestIdx). */
  seedWindow: 60,
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
