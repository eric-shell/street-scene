import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { carSnapshot, raceConfig, replayLog, runAutopilot } from './helpers';
import { MAX_OPPONENTS, createRace, standings, stepRace } from '../src/sim/race';
import { autopilotInput, createAi } from '../src/sim/ai';

describe('AI opponents', () => {
  // Fifty random seeds in two halves of one stream, each well inside the per test time limit under a full
  // suite's load.
  const ROUTE_SEEDS = (() => {
    const rng = new Rng(2024);
    return Array.from({ length: 50 }, () => rng.int(0, 0x7fffffff));
  })();
  it.each([
    [0, 25],
    [25, 50],
  ])('complete every route for random seeds %i to %i without getting stuck', (from, to) => {
    const failures: string[] = [];
    for (let i = from; i < to; i++) {
      const seed = ROUTE_SEEDS[i];
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
    const rng = new Rng(910);
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

describe('rival personalities', () => {
  it('each race rolls its own field from aiSeed (the same seed, the same field), every rival on its own line', () => {
    const drivers = (aiSeed: number) => JSON.stringify(createRace({ ...raceConfig(4242, 'circuit', 4), aiSeed }).cars.slice(1).map((c) => c.ai!.driver));
    expect(drivers(1)).toBe(drivers(1));
    expect(drivers(1)).not.toBe(drivers(2));
    const r = createRace({ ...raceConfig(4242, 'circuit', 4), aiSeed: 1 });
    const lines = r.cars.slice(1).map((c) => c.ai!.line!);
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        let apart = 0;
        for (let k = 0; k < lines[i].n; k++) apart += Math.abs(lines[i].offset[k] - lines[j].offset[k]);
        expect(apart / lines[i].n, `rivals ${i + 1} and ${j + 1}`).toBeGreaterThan(0.5);
      }
    }
  });

  it('rivals that take every shortcut get down the alleys and over the jumps', () => {
    const failures: string[] = [];
    for (const [seed, mode] of [[31337, 'circuit'], [4242, 'sprint'], [2024, 'circuit']] as const) {
      const r = createRace({ ...raceConfig(seed, mode, 3), aiSeed: 3 });
      for (const c of r.cars.slice(1)) c.ai!.takes.fill(1);
      const pilot = createAi(0.97);
      const was = r.cars.map(() => -1);
      let started = 0;
      let through = 0;
      while (r.tick < 420 * 60 && !r.cars.every((c) => c.finished)) {
        stepRace(r, autopilotInput(r, r.cars[0], pilot));
        for (const c of r.cars.slice(1)) {
          const ai = c.ai!;
          if (was[c.index] < 0 && ai.detour >= 0) started++;
          if (was[c.index] >= 0 && ai.detour < 0 && ai.didx >= ai.detours[was[c.index]].line.n - 4) through++;
          was[c.index] = ai.detour;
        }
      }
      for (const c of r.cars.slice(1)) {
        const resets = r.events.filter((e) => e.type === 'reset' && e.car === c.index).length;
        if (!c.finished) failures.push(`${seed} ${mode}: ${c.name} did not finish`);
        else if (resets > 2) failures.push(`${seed} ${mode}: ${c.name} needed ${resets} resets`);
      }
      if (started < 3 || through < started * 0.75) failures.push(`${seed} ${mode}: ${through} of ${started} detours driven through`);
    }
    expect(failures).toEqual([]);
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
