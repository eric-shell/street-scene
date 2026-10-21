import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { carSnapshot, raceConfig, replayLog, runAutopilot } from './helpers';
import { MAX_OPPONENTS, standings } from '../src/sim/race';

describe('AI opponents', () => {
  it('complete every route for 50 random seeds without getting stuck', () => {
    const rng = new Rng(2024);
    const failures: string[] = [];
    for (let i = 0; i < 50; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const mode = i % 2 === 0 ? 'circuit' : 'sprint';
      const r = runAutopilot(raceConfig(seed, mode, 3, undefined, 1), 420, true);
      for (const car of r.cars.slice(1)) {
        const resets = r.events.filter((e) => e.type === 'reset' && e.car === car.index).length;
        if (!car.finished) failures.push(`seed ${seed} ${mode}: ${car.name} did not finish (dist ${car.dist.toFixed(0)}/${r.distance.toFixed(0)})`);
        else if (resets > 4) failures.push(`seed ${seed} ${mode}: ${car.name} needed ${resets} resets`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('a full field of nine rivals gets off the two-wide grid and finishes', () => {
    const rng = new Rng(909);
    const failures: string[] = [];
    for (let i = 0; i < 6; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const mode = i % 2 === 0 ? 'circuit' : 'sprint';
      const r = runAutopilot(raceConfig(seed, mode, MAX_OPPONENTS, undefined, 1), 480, true);
      expect(r.cars.length).toBe(MAX_OPPONENTS + 1);
      for (const car of r.cars.slice(1)) {
        const resets = r.events.filter((e) => e.type === 'reset' && e.car === car.index).length;
        if (!car.finished) failures.push(`seed ${seed} ${mode}: ${car.name} did not finish (dist ${car.dist.toFixed(0)}/${r.distance.toFixed(0)})`);
        else if (resets > 4) failures.push(`seed ${seed} ${mode}: ${car.name} needed ${resets} resets`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('a full field replays identically from the input log', () => {
    const cfg = raceConfig(4242, 'circuit', MAX_OPPONENTS);
    const r = runAutopilot(cfg, 60);
    const again = replayLog(cfg, r.inputLog);
    expect(carSnapshot(again)).toBe(carSnapshot(r));
  });
});

describe('replays', () => {
  it('a full race replays identically from the input log', () => {
    const cfg = raceConfig(31337, 'circuit', 3, undefined, 2);
    const original = runAutopilot(cfg, 420, true);
    expect(original.cars[0].finished).toBe(true);
    const replay = replayLog(cfg, original.inputLog);
    // Same finish time and same order for everyone.
    expect(replay.cars[0].finishTick).toBe(original.cars[0].finishTick);
    expect(standings(replay).map((s) => s.car.index)).toEqual(standings(original).map((s) => s.car.index));
    expect(carSnapshot(replay)).toBe(carSnapshot(original));
  });

  it('a solo replay finishes with exactly the same time (ghost source)', () => {
    const cfg = raceConfig(99, 'sprint', 0);
    const original = runAutopilot(cfg, 300);
    const replay = replayLog(cfg, original.inputLog);
    expect(replay.phase).toBe('finished');
    expect(replay.cars[0].finishTick).toBe(original.cars[0].finishTick);
  });
});
