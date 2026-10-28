/**
 * An AI car's memory: the Course a rival drives (its own line and detours), the AiState that tracks where it
 * is on that line, what racecraft and recovery are doing and its progress watchdog (createAi), and the pace
 * error it makes per stretch of the race (slipAt). Only the AI itself writes it; the sim reads the race state.
 */
import { clamp, lerp } from '../math';
import { Rng } from '../prng';
import { DRIVER, NEUTRAL_DRIVER, type Driver } from './drivers';
import type { RacingLine } from './racingLine';
import type { Detour } from './driverLine';

/** What a rival drives in a race: its own line, the race distance (m) and laps, and its detours (one per route shortcut it could take). */
export interface Course {
  line: RacingLine;
  distance: number;
  laps: number;
  detours: Detour[];
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
  /** Progress watchdog: distance at the last checkpoint of the timer, and the detour sample then (down a shortcut). */
  watchDist: number;
  watchIdx: number;
  watchTime: number;
  /** Seconds spent pressing on without moving (nose in against a wall, car or barrier). */
  blocked: number;
  /** Seconds left reversing out (0 = driving normally), time reversed so far and the reverse steer. */
  reverse: number;
  reversed: number;
  reverseSteer: number;
}

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
  return { driver, line: course?.line ?? null, slips, detours, takes, laps, detour: -1, didx: -1, idx: -1, pace: pace * driver.skill, dodge: 0, passCar: -1, passSide: 0, stuckTime: 0, nitroHold: 0, watchDist: -1e9, watchIdx: -1, watchTime: 0, blocked: 0, reverse: 0, reversed: 0, reverseSteer: 0 };
}

/** Pace error where the car is in the race (consistency): one value per DRIVER.section, blended between. */
export function slipAt(ai: AiState, dist: number): number {
  const n = ai.slips.length;
  if (n < 2) return 1;
  const f = clamp(dist / DRIVER.section, 0, n - 1);
  const k = Math.min(n - 2, Math.floor(f));
  return lerp(ai.slips[k], ai.slips[k + 1], f - k);
}
