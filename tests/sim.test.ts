import { describe, expect, it } from 'vitest';
import { createCar, stepCar } from '../src/sim/car';
import { CAR_IDS, CarTuning, SELECTABLE_CAR_IDS, driveSplit, getBaseTuning, tuningHash } from '../src/sim/tuning';
import { WorldHit, collideCarWithWorld } from '../src/sim/collision';
import { DEG } from '../src/sim/math';
import { packInput, quantizeInput, unpackInput } from '../src/sim/input';
import { applySavedTuning, importValues, tuningParams } from '../src/ui/tuningPanel';
import type { Contact, World } from '../src/city/world';
import exported from './fixtures/s64-tuning-export.json';
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
    const c = accelerate(6, false);
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

describe('driving parameters file', () => {
  it('protoCompact resolves to the latest exported tuning (plus deliberate edits since)', () => {
    // Sidewalks were later set to road traction on purpose. The export predates the rename from
    // s64 and the shared wheel size; geometry comes from the manifest, not from the tuning.
    const t = getBaseTuning('protoCompact');
    const expected = { ...exported.tuning, carId: t.carId, geometry: t.geometry, surface: { ...exported.tuning.surface, sidewalkGrip: 1 } };
    expect(t).toMatchObject(expected);
  });

  it('every car resolves with finite numbers and a known drivetrain', () => {
    for (const id of CAR_IDS) {
      const t = getBaseTuning(id);
      for (const p of tuningParams(t)) expect(Number.isFinite(p.min) && p.tip.length > 0).toBe(true);
      expect(['rwd', 'awd', 'fwd']).toContain(t.drivetrain.layout);
    }
    expect(CAR_IDS).not.toContain('cc96');
    expect(CAR_IDS).not.toContain('ar7');
    expect(SELECTABLE_CAR_IDS.sort()).toEqual(['protoCompact', 'protoCoupe', 'protoHatch']);
  });

  it('keeps each car\'s character: protoHatch is a light turbo FWD, protoCompact a rev happy RWD', () => {
    const compact = getBaseTuning('protoCompact');
    const hatch = getBaseTuning('protoHatch');
    expect(driveSplit(compact)).toEqual({ front: 0, rear: 1 });
    expect(driveSplit(hatch)).toEqual({ front: 1, rear: 0 });
    expect(hatch.mass).toBeLessThan(compact.mass);
    expect(hatch.engine.redline).toBeLessThan(compact.engine.redline);
    // Both cars share one wheel size, so they read at the same scale side by side.
    expect(hatch.geometry.wheelRadius).toBe(compact.geometry.wheelRadius);
  });

  it('every tuning parameter in the panel has a tooltip', () => {
    for (const p of tuningParams(getBaseTuning('protoCompact'))) expect(p.tip, p.path).not.toMatch(/^No description/);
  });

  it('the panel imports its own export format exactly', () => {
    const t = getBaseTuning('protoHatch');
    applySavedTuning(t, importValues(exported, 'protoHatch'));
    expect(t).toMatchObject({ ...exported.tuning, carId: 'protoHatch', geometry: getBaseTuning('protoHatch').geometry });
    // drivingParams.json style nested blocks work too.
    const u = getBaseTuning('protoCompact');
    expect(applySavedTuning(u, importValues({ tires: { gripRear: 1.1 }, drivetrain: { layout: 'awd' } }, 'protoCompact'))).toBe(2);
    expect(u.tires.gripRear).toBe(1.1);
    expect(u.drivetrain.layout).toBe('awd');
  });

  it('saved test drive tuning is fingerprinted per car', () => {
    expect(tuningHash('protoCompact')).toMatch(/^[0-9a-f]{8}$/);
    expect(tuningHash('protoCompact')).not.toBe(tuningHash('protoHatch'));
    expect(tuningHash('protoCompact')).toBe(tuningHash('protoCompact'));
  });
});

describe('wheelspin and traction control', () => {
  const world = flatWorld();

  /** Full throttle from a standstill with the revs up, like a race start. */
  function launch(t: CarTuning, tc: boolean): { spinTicks: number; maxSpin: number } {
    const c = createCar(0, 0, 0, 0);
    c.tractionControl = tc;
    for (let i = 0; i < 30; i++) stepCar(c, t, input({}), { world });
    c.rpm = t.engine.redline * 0.85;
    let spinTicks = 0;
    let maxSpin = 0;
    for (let i = 0; i < 180; i++) {
      stepCar(c, t, input({ throttle: 1 }), { world });
      if (c.wheelspin) spinTicks++;
      maxSpin = Math.max(maxSpin, c.spinRear, c.spinFront);
    }
    return { spinTicks, maxSpin };
  }

  /** Mid corner in first gear, then full throttle while still turning. */
  function cornerExit(t: CarTuning, tc: boolean): { spinTicks: number; maxSlip: number } {
    const c = createCar(0, 0, 0, 0);
    c.tractionControl = tc;
    for (let i = 0; i < 600 && c.speed < 13; i++) stepCar(c, t, input({ throttle: 0.6 }), { world });
    for (let i = 0; i < 60; i++) stepCar(c, t, input({ throttle: 0.2, steer: -0.8 }), { world });
    let spinTicks = 0;
    let maxSlip = 0;
    for (let i = 0; i < 60; i++) {
      stepCar(c, t, input({ throttle: 1, steer: -0.8 }), { world });
      if (c.wheelspin) spinTicks++;
      maxSlip = Math.max(maxSlip, Math.abs(c.slipAngle));
    }
    return { spinTicks, maxSlip };
  }

  it('a high rev launch spins the rear wheels without traction control, not with it', () => {
    const t = getBaseTuning('protoCompact');
    const off = launch(t, false);
    const on = launch(t, true);
    expect(off.spinTicks).toBeGreaterThan(15);
    expect(on.spinTicks).toBe(0);
    expect(on.maxSpin).toBe(0);
  });

  it('full throttle mid corner gives power oversteer without traction control, not with it', () => {
    const t = getBaseTuning('protoCompact');
    const off = cornerExit(t, false);
    const on = cornerExit(t, true);
    expect(off.spinTicks).toBeGreaterThan(20);
    expect(off.maxSlip).toBeGreaterThan(20 * DEG);
    expect(on.spinTicks).toBe(0);
    expect(on.maxSlip).toBeLessThan(10 * DEG);
  });

  it('wheelspin happens on the driven axle only', () => {
    const fwd = getBaseTuning('protoCompact');
    fwd.drivetrain.layout = 'fwd';
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) stepCar(c, fwd, input({}), { world });
    c.rpm = fwd.engine.redline * 0.85;
    let front = 0;
    for (let i = 0; i < 60; i++) {
      stepCar(c, fwd, input({ throttle: 1 }), { world });
      front = Math.max(front, c.spinFront);
      expect(c.spinRear).toBe(0);
    }
    expect(front).toBeGreaterThan(0.2);
  });

  it('AWD launches with less wheelspin than RWD', () => {
    const rwd = getBaseTuning('protoCompact');
    const awd = getBaseTuning('protoCompact');
    awd.drivetrain.layout = 'awd';
    expect(launch(awd, false).spinTicks).toBeLessThan(launch(rwd, false).spinTicks);
  });

  it('AI cars drive with traction control, the player follows the config', () => {
    const r = runAutopilot({ ...raceConfig(11, 'circuit', 2), tractionControl: false }, 1);
    expect(r.cars.map((c) => c.state.tractionControl)).toEqual([false, true, true]);
    const r2 = runAutopilot({ ...raceConfig(11, 'circuit', 0), tractionControl: true }, 1);
    expect(r2.cars[0].state.tractionControl).toBe(true);
  });
});

describe('collisions', () => {
  /** Flat world with one straight wall of the given kind along x = 3 (drivable side x < 3). */
  function wallWorld(kind: Contact['kind']): World {
    return {
      ...flatWorld(),
      collideCircle: (cx: number, cz: number, r: number, out: Contact[]) => {
        out.length = 0;
        const depth = cx + r - 3;
        if (depth > 0) out.push({ nx: -1, nz: 0, depth, px: 3, pz: cz, kind });
        return out.length;
      },
    } as World;
  }

  function scrape(kind: Contact['kind'] | null) {
    const world = kind ? wallWorld(kind) : flatWorld();
    const t = getBaseTuning('protoCompact');
    const c = createCar(3 - t.geometry.halfWidth, 0, 0, 0);
    c.vz = 35;
    c.vx = 1.5;
    const hit: WorldHit = { speed: 0, kind: 'wall' };
    let maxHit = 0;
    let kindSeen: Contact['kind'] | null = null;
    let maxYaw = 0;
    for (let i = 0; i < 60; i++) {
      // Keep leaning into the wall like a car that ran wide.
      stepCar(c, t, input({ throttle: 0.6, steer: -0.15 }), { world });
      c.impact = collideCarWithWorld(c, t, world, hit);
      if (hit.speed > maxHit) {
        maxHit = hit.speed;
        kindSeen = hit.kind;
      }
      maxYaw = Math.max(maxYaw, Math.abs(c.yawRate));
    }
    return { speed: c.speed, maxHit, kindSeen, maxYaw };
  }

  it('scraping a corner rail costs real speed without spinning the car', () => {
    const free = scrape(null);
    const rail = scrape('rail');
    expect(rail.kindSeen).toBe('rail');
    expect(rail.maxHit).toBeGreaterThan(0);
    expect(rail.speed).toBeLessThan(free.speed - 6);
    expect(rail.maxYaw).toBeLessThan(1.5);
  });

  it('a race reports rate limited wall and car crash events for sounds', () => {
    const r = runAutopilot(raceConfig(424242, 'circuit', 3), 120);
    const walls = r.events.filter((e) => e.type === 'wall');
    const crashes = r.events.filter((e) => e.type === 'crash');
    expect(walls.length + crashes.length).toBeGreaterThan(0);
    for (const e of walls) {
      expect(e.value).toBeGreaterThan(3);
      expect(['wall', 'barrier', 'rail']).toContain(e.kind);
    }
    for (const e of crashes) {
      expect(e.value).toBeGreaterThan(2);
      expect(e.other).toBeGreaterThan(e.car);
    }
    const last = new Map<string, number>();
    for (const e of [...walls, ...crashes]) {
      const key = `${e.type}:${e.car}:${e.other ?? ''}`;
      if (last.has(key)) expect(e.tick - last.get(key)!).toBeGreaterThanOrEqual(15);
      last.set(key, e.tick);
    }
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
