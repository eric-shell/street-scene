import type { World } from '../src/city/world';
import { createRace, RaceConfig, RaceState, stepRace } from '../src/sim/race';
import { createAi, autopilotInput } from '../src/sim/ai';
import { stockPerformance, PerformanceBuild } from '../src/sim/build';
import { InputFrame, unpackInput } from '../src/sim/input';

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
    player: { name: 'Player', carId: 'proto', performance: perf },
    opponents: Array.from({ length: opponents }, (_, i) => ({ name: `AI ${i + 1}`, carId: ['protoCompact', 'protoHatch'][i % 2], performance: stockPerformance() })),
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

export const input = (p: Partial<InputFrame>): InputFrame => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, nitrous: false, shift: 0, reset: false, ...p });
