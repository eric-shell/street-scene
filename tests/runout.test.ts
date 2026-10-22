import { describe, expect, it } from 'vitest';
import { createRace, RaceState, stepRace } from '../src/sim/race';
import { createAi, autopilotInput } from '../src/sim/ai';
import { carSnapshot, input, raceConfig } from './helpers';

/** Drive the player on autopilot until it crosses the line. */
function toFinish(seed: number): RaceState {
  const r = createRace(raceConfig(seed, 'circuit', 0));
  const pilot = createAi(0.97);
  while (r.phase !== 'finished' && r.tick < 60 * 300) stepRace(r, autopilotInput(r, r.cars[0], pilot));
  expect(r.phase).toBe('finished');
  return r;
}

describe('post-finish runout', () => {
  it('ignores the player input once finished, so replays stay identical', () => {
    const a = toFinish(7919);
    const b = toFinish(7919);
    for (let i = 0; i < 60 * 4; i++) {
      stepRace(a, input({ throttle: 1, steer: 1, nitrous: true, handbrake: true, reset: i === 30 }));
      stepRace(b, input({}));
    }
    expect(carSnapshot(a)).toBe(carSnapshot(b));
  });

  it('keeps the car in its lane and brakes it to a stop without hitting anything', () => {
    for (const seed of [7919, 15838, 23757, 31676]) {
      const r = toFinish(seed);
      const c = r.cars[0];
      const lat0 = c.lateral;
      let maxImpact = 0;
      let maxDev = 0;
      for (let i = 0; i < 60 * 12; i++) {
        stepRace(r, input({ throttle: 1 }));
        maxImpact = Math.max(maxImpact, c.state.impact);
        maxDev = Math.max(maxDev, Math.abs(c.lateral - lat0));
      }
      expect(maxImpact, `seed ${seed}`).toBeLessThan(1);
      expect(maxDev, `seed ${seed}`).toBeLessThan(4);
      expect(c.state.speed, `seed ${seed}`).toBeLessThan(0.5);
      expect(c.state.gear, `seed ${seed}`).toBeGreaterThan(0);
    }
  });
});
