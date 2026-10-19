import { describe, expect, it } from 'vitest';
import { createCar, stepCar } from '../src/sim/car';
import { getBaseTuning } from '../src/sim/tuning';
import { DEG } from '../src/sim/math';
import { packInput, quantizeInput, unpackInput } from '../src/sim/input';
import { carSnapshot, flatWorld, input, raceConfig, replayLog, runAutopilot } from './helpers';

describe('input frames', () => {
  it('pack and unpack quantized frames losslessly', () => {
    const f = quantizeInput(input({ throttle: 0.73, brake: 0.2, steer: -0.41, handbrake: true, nitrous: true, shift: -1, reset: true }));
    expect(unpackInput(packInput(f))).toEqual(f);
  });
});

describe('car physics', () => {
  const world = flatWorld();

  function accelerate(seconds: number, nitro: boolean) {
    const t = getBaseTuning('proto');
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < seconds * 60; i++) stepCar(c, t, input({ throttle: 1, nitrous: nitro }), { world });
    return c;
  }

  it('settles on its suspension and accelerates', () => {
    const c = accelerate(5, false);
    expect(c.speed).toBeGreaterThan(25);
    expect(c.gear).toBeGreaterThanOrEqual(2);
    expect(Math.abs(c.x)).toBeLessThan(1);
    expect(Math.abs(c.y)).toBeLessThan(0.2);
  });

  it('nitrous makes the car faster', () => {
    const plain = accelerate(6, false);
    const boosted = accelerate(6, true);
    expect(boosted.speed).toBeGreaterThan(plain.speed + 3);
    expect(boosted.nitro).toBeLessThan(0.1);
  });

  it('handbrake breaks the rear loose and the car can hold a drift', () => {
    const t = getBaseTuning('proto');
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 5 * 60; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    const entry = c.speed;
    // Flick: steer left with the handbrake.
    for (let i = 0; i < 30; i++) stepCar(c, t, input({ throttle: 0.6, steer: -1, handbrake: true }), { world });
    expect(Math.abs(c.slipAngle)).toBeGreaterThan(15 * DEG);
    // Hold it with counter steer and throttle.
    let drifting = 0;
    for (let i = 0; i < 90; i++) {
      const counter = Math.max(-1, Math.min(1, -c.slipAngle / (25 * DEG)));
      stepCar(c, t, input({ throttle: 0.85, steer: counter * 0.6 }), { world });
      if (c.drifting) drifting++;
    }
    expect(drifting).toBeGreaterThan(45);
    // Drifts keep most of their speed and never spin out.
    expect(c.speed).toBeGreaterThan(entry * 0.5);
    expect(Math.abs(c.slipAngle)).toBeLessThan(70 * DEG);
  });

  it('brakes to a stop and reverses', () => {
    const t = getBaseTuning('proto');
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 120; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    for (let i = 0; i < 300; i++) stepCar(c, t, input({ brake: 1 }), { world });
    expect(c.gear).toBe(-1);
    expect(c.vz).toBeLessThan(-1);
  });
});

describe('determinism', () => {
  it('replaying a recorded input log twice gives identical final state', () => {
    const cfg = raceConfig(424242, 'circuit', 3);
    const original = runAutopilot(cfg, 50);
    const a = replayLog(cfg, original.inputLog);
    const b = replayLog(cfg, original.inputLog);
    expect(carSnapshot(a)).toBe(carSnapshot(original));
    expect(carSnapshot(b)).toBe(carSnapshot(a));
    expect(original.cars[0].dist).toBeGreaterThan(300);
  });
});

describe('driving the routes', () => {
  it('the car can drive a whole circuit and sprint', () => {
    for (const seed of [11, 20261019]) {
      for (const mode of ['circuit', 'sprint'] as const) {
        const r = runAutopilot(raceConfig(seed, mode, 0), 400);
        expect(r.phase).toBe('finished');
        expect(r.events.filter((e) => e.type === 'reset').length).toBeLessThanOrEqual(3);
      }
    }
  });
});
