import type { World } from '../src/city/world';
import { createRace, RaceConfig, RaceState, stepRace } from '../src/sim/race';
import { createAi, autopilotInput } from '../src/sim/ai';
import { stockPerformance, PerformanceBuild } from '../src/sim/build';
import { InputFrame, unpackInput } from '../src/sim/input';
import { counterSteerLock, type CarState } from '../src/sim/car';
import { geometryFromManifest, type CarTuning } from '../src/sim/tuning';
import params from '../src/sim/drivingParams.json';

/**
 * The car whose geometry baseTuning() wears and the race configs' player drives: the Coupe, the shipped car closest
 * to the retired Proto RS the scenario tests were written on (4.31 by 1.88 m against 4.36 by 1.82, rear wheel drive
 * like base). The Hatch is 2.04 m wide and clips the level crossing arms and kerbs those tests thread.
 */
export const TEST_CAR = 'protoCoupe';

/**
 * drivingParams.json's `base` exactly, with no car's overrides, on TEST_CAR's geometry: the tuning the physics
 * tests mean by "a car", so a change to one shipped car's overrides never moves them. Naturally aspirated, as
 * base is (forced induction is a manifest flag, set by getBaseTuning for the real cars).
 */
export function baseTuning(): CarTuning {
  const base = structuredClone(params.base) as unknown as CarTuning;
  return { ...base, carId: TEST_CAR, geometry: geometryFromManifest(TEST_CAR), engine: { ...base.engine, turbo: false } };
}

/** Endless flat parking lot: no walls, road surface everywhere. */
export function flatWorld(): World {
  return {
    heightAt: () => 0,
    driveHeightAt: () => 0,
    slopeAt: () => ({ gx: 0, gz: 0 }),
    surfaceAt: () => 'road',
    collideCircle: (_x: number, _z: number, _r: number, out: unknown[]) => ((out.length = 0), 0),
    collideBox: (_a: number, _b: number, _c: number, _d: number, _e: number, out: unknown[]) => ((out.length = 0), 0),
    wallClearance: (_x: number, _z: number, m: number) => m,
  } as unknown as World;
}

export function raceConfig(seed: number, mode: RaceConfig['mode'], opponents = 3, perf: PerformanceBuild = stockPerformance(), laps = 1): RaceConfig {
  return {
    seed,
    mode,
    laps,
    player: { name: 'Player', carId: TEST_CAR, performance: perf },
    opponents: Array.from({ length: opponents }, (_, i) => ({ name: `AI ${i + 1}`, carId: ['protoHatch', 'protoWagon'][i % 2], performance: stockPerformance() })),
    difficulty: 'medium',
    manualGearbox: false,
  };
}

/** Run a race with the player on autopilot. */
export function runAutopilot(cfg: RaceConfig, maxSeconds: number, untilAllFinished = false): RaceState {
  const r = createRace(cfg);
  const pilot = createAi(0.97);
  const maxTicks = maxSeconds * 60;
  while (r.tick < maxTicks) {
    if (untilAllFinished ? r.cars.every((c) => c.finished) : r.phase === 'finished') break;
    stepRace(r, autopilotInput(r, r.cars[0], pilot));
  }
  return r;
}

export function replayLog(cfg: RaceConfig, log: number[]): RaceState {
  const r = createRace(cfg);
  for (const packed of log) stepRace(r, unpackInput(packed));
  return r;
}

export function carSnapshot(r: RaceState): string {
  return JSON.stringify(r.cars.map((c) => ({ s: c.state, d: c.dist, lap: c.lap, f: c.finished, ft: c.finishTick, lt: c.lapTimes })));
}

/**
 * The stick input that counter steers a slide of `angle` (rad) by wheel angle, as a driver who knows the car
 * does: the front wheels along the direction of travel, plus `extra` rad of lock (less with a negative one),
 * through whatever counter steer mapping the tuning has (counterSteerLock).
 */
export const counterSteer = (t: CarTuning, c: CarState, angle: number, extra = 0): number =>
  Math.max(-1, Math.min(1, (-Math.sign(angle) * Math.max(0, Math.abs(angle) + extra)) / counterSteerLock(t, c.speed, angle || 1e-3)));

export const input = (p: Partial<InputFrame>): InputFrame => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitrous: false, shift: 0, reset: false, antilag: false, ...p });
