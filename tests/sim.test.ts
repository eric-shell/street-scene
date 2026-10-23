import { describe, expect, it } from 'vitest';
import { createCar, gridRev, placeCar, refillNitrous, stepCar } from '../src/sim/car';
import type { CarState } from '../src/sim/car';
import { applyBuild, stockPerformance } from '../src/sim/build';
import { CAR_IDS, CarTuning, NITRO_STAGES, SELECTABLE_CAR_IDS, driveSplit, getBaseTuning, tuningHash } from '../src/sim/tuning';
import { DT } from '../src/sim/constants';
import { createRace, stepRace } from '../src/sim/race';
import { WorldHit, collideCarWithWorld } from '../src/sim/collision';
import { DEG } from '../src/sim/math';
import { packInput, quantizeInput, unpackInput } from '../src/sim/input';
import { applySavedTuning, importValues, tuningParams } from '../src/ui/panels/tuningPanel';
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

describe('nitrous stages', () => {
  const world = flatWorld();
  const t = getBaseTuning('proto');

  /** A car rolling at 20 m/s with `nitro` stages in the tank. */
  function rolling(nitro: number): CarState {
    const c = createCar(0, 0, 0, 0);
    while (c.speed < 20) stepCar(c, t, input({ throttle: 1 }), { world });
    c.nitro = nitro;
    return c;
  }

  /** Hold throttle and nitrous (while `held` says so) for `seconds`: the chain refills seen and the ticks boosted. */
  function hold(c: CarState, seconds: number, held = (_tick: number) => true) {
    const chains: number[] = [];
    let boosted = 0;
    for (let i = 0; i < seconds * 60; i++) {
      stepCar(c, t, input({ throttle: 1, nitrous: held(i) }), { world });
      if (c.nitroActive) boosted++;
      if (c.nitroChain > 0) chains.push(c.nitroChain);
    }
    return { chains, boosted };
  }

  it('style fills the stages in order up to a full tank, and says what paid', () => {
    const c = createCar(0, 0, 0, 0);
    c.nitro = 0;
    c.drifting = true;
    c.slipAngle = 40 * DEG;
    c.nearMiss = true;
    refillNitrous(c, t);
    expect(c.nitroGain.drift).toBeCloseTo(t.nitrous.refillDrift * DT, 12);
    expect(c.nitroGain.nearMiss).toBeCloseTo(t.nitrous.refillNearMiss * DT, 12);
    expect(c.nitroGain.draft).toBe(0);
    let level = c.nitro;
    for (let i = 0; i < 60 * 40; i++) {
      refillNitrous(c, t);
      expect(c.nitro).toBeGreaterThanOrEqual(level);
      level = c.nitro;
    }
    expect(c.nitro).toBe(NITRO_STAGES);
    // A full tank takes no more, and no callout claims any.
    refillNitrous(c, t);
    expect(c.nitroGain.drift + c.nitroGain.nearMiss).toBe(0);
  });

  it('burns the top stage first, each a little harder than the one below', () => {
    const plain = rolling(0);
    hold(plain, 1);
    const gain: number[] = [];
    for (let stage = 1; stage <= NITRO_STAGES; stage++) {
      const c = rolling(stage);
      stepCar(c, t, input({ throttle: 1, nitrous: true }), { world });
      expect(c.nitroStage).toBe(stage);
      hold(c, 1 - DT);
      gain.push(c.speed - plain.speed);
    }
    expect(gain[0]).toBeGreaterThan(2);
    expect(gain[1]).toBeGreaterThan(gain[0] * 1.03);
    expect(gain[2]).toBeGreaterThan(gain[1] * 1.03);
    // Slightly: the top stage is not a different car.
    expect(gain[2]).toBeLessThan(gain[0] * 1.5);
    // Two and a half stages burn half of stage 3, then stage 2.
    const c = rolling(2.5);
    hold(c, (0.5 * t.nitrous.capacity) - 0.05);
    expect(c.nitroStage).toBe(3);
    hold(c, 0.1);
    expect(c.nitroStage).toBe(2);
  });

  it('held until the tank runs dry, a burn from full stages chains a refill and goes on', () => {
    for (const [start, refills] of [
      [0.9, []],
      [1, [t.nitrous.chainRefill[0]]],
      [2, [t.nitrous.chainRefill[1]]],
      [2.5, [t.nitrous.chainRefill[1]]],
      // A full tank chains a whole stage, and that stage chains once more.
      [3, [t.nitrous.chainRefill[2], t.nitrous.chainRefill[0]]],
    ] as [number, number[]][]) {
      const c = rolling(start);
      const { chains, boosted } = hold(c, 20);
      expect(chains, `from ${start} stages`).toEqual(refills);
      const stages = start + refills.reduce((a, b) => a + b, 0);
      expect(Math.abs(boosted - stages * t.nitrous.capacity * 60), `from ${start} stages`).toBeLessThan(2);
      expect(c.nitro).toBe(0);
    }
  });

  it('letting go ends the run: the next press chains on what is left', () => {
    const c = rolling(2);
    // A second of boost, a tick off the button, then on until dry: the run restarts on 1 full stage.
    const { chains } = hold(c, 20, (i) => i !== 60);
    expect(chains).toEqual([t.nitrous.chainRefill[0]]);
    // Off the throttle with the button held only pauses the run.
    const d = rolling(2);
    for (let i = 0; i < 20 * 60; i++) {
      stepCar(d, t, input({ throttle: i >= 60 && i < 75 ? 0 : 1, nitrous: true }), { world });
      if (d.nitroChain > 0) {
        expect(d.nitroChain).toBe(t.nitrous.chainRefill[1]);
        return;
      }
    }
    throw new Error('the paused run never chained');
  });

  it('a drag run with chained nitrous replays bit for bit', () => {
    const cfg = { ...raceConfig(31337, 'drag', 0), laps: 1 };
    const r = createRace(cfg);
    let chained = 0;
    while (r.tick < r.countdownTicks + 60 * 8) {
      stepRace(r, input({ throttle: 1, nitrous: r.tick >= r.countdownTicks }));
      chained += r.cars[0].state.nitroChain;
    }
    expect(chained).toBeCloseTo(t.nitrous.chainRefill[0], 9);
    expect(carSnapshot(replayLog(cfg, r.inputLog))).toBe(carSnapshot(r));
  });
});

describe('driving parameters file', () => {
  it('the base car (proto) resolves to the latest exported tuning (plus deliberate edits since)', () => {
    // Sidewalks were later set to road traction on purpose, and the brakes made much stronger (more
    // tire force, a touch more front bias, plus the arcade assist the export predates). The export
    // predates the rename from s64 and the shared wheel size; geometry comes from the manifest. (The
    // export's car, the retired Proto Compact, drove base on a final drive shortened for its 0.31 m tire.)
    // Counter steer lock was later allowed to reach the direction of travel at any slip angle; the drift
    // aids and the handbrake were remodelled on real wheel speed (the fixture carries the surviving keys).
    const t = getBaseTuning('proto');
    const expected = {
      ...exported.tuning,
      carId: t.carId,
      geometry: t.geometry,
      surface: { ...exported.tuning.surface, sidewalkGrip: 1 },
      brakes: { ...exported.tuning.brakes, force: 16250, frontBias: 0.68 },
      steering: { ...exported.tuning.steering, counterSteerAllowance: 1 },
    };
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
    expect(SELECTABLE_CAR_IDS.sort()).toEqual(['protoCoupe', 'protoHatch', 'protoWagon']);
  });

  it('keeps each car\'s character: a front biased AWD hatch, a light high revving RWD coupe, an even AWD wagon', () => {
    const hatch = getBaseTuning('protoHatch');
    const coupe = getBaseTuning('protoCoupe');
    const wagon = getBaseTuning('protoWagon');
    expect(hatch.drivetrain.layout).toBe('awd');
    expect(driveSplit(hatch).front).toBeGreaterThan(driveSplit(hatch).rear);
    expect(driveSplit(coupe)).toEqual({ front: 0, rear: 1 });
    expect(driveSplit(wagon)).toEqual({ front: 0.5, rear: 0.5 });
    expect(coupe.mass).toBeLessThan(hatch.mass);
    expect(coupe.mass).toBeLessThan(wagon.mass);
    expect(coupe.engine.redline).toBeGreaterThan(Math.max(hatch.engine.redline, wagon.engine.redline));
    // The wagon's turbo plateau arrives earliest: its peak torque comes at the lowest rpm.
    const peakRpm = (t: CarTuning) => t.engine.torqueCurve.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    expect(peakRpm(wagon)).toBeLessThan(peakRpm(hatch));
    expect(peakRpm(hatch)).toBeLessThan(peakRpm(coupe));
  });

  it('every tuning parameter in the panel has a tooltip', () => {
    for (const p of tuningParams(getBaseTuning('proto'))) expect(p.tip, p.path).not.toMatch(/^No description/);
  });

  it('the panel imports its own export format exactly', () => {
    const t = getBaseTuning('protoHatch');
    applySavedTuning(t, importValues(exported, 'protoHatch'));
    expect(t).toMatchObject({ ...exported.tuning, carId: 'protoHatch', geometry: getBaseTuning('protoHatch').geometry });
    // drivingParams.json style nested blocks work too.
    const u = getBaseTuning('proto');
    expect(applySavedTuning(u, importValues({ tires: { gripRear: 1.1 }, drivetrain: { layout: 'awd' } }, 'proto'))).toBe(2);
    expect(u.tires.gripRear).toBe(1.1);
    expect(u.drivetrain.layout).toBe('awd');
  });

  it('saved tuning panel values are fingerprinted per car', () => {
    expect(tuningHash('protoCoupe')).toMatch(/^[0-9a-f]{8}$/);
    expect(tuningHash('protoCoupe')).not.toBe(tuningHash('protoHatch'));
    expect(tuningHash('protoCoupe')).toBe(tuningHash('protoCoupe'));
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
    const t = getBaseTuning('proto');
    const off = launch(t, false);
    const on = launch(t, true);
    expect(off.spinTicks).toBeGreaterThan(15);
    expect(on.spinTicks).toBe(0);
    expect(on.maxSpin).toBe(0);
  });

  it('full throttle mid corner gives power oversteer without traction control, not with it', () => {
    const t = getBaseTuning('proto');
    const off = cornerExit(t, false);
    const on = cornerExit(t, true);
    expect(off.spinTicks).toBeGreaterThan(20);
    expect(off.maxSlip).toBeGreaterThan(20 * DEG);
    expect(on.spinTicks).toBe(0);
    expect(on.maxSlip).toBeLessThan(10 * DEG);
  });

  it('wheelspin happens on the driven axle only', () => {
    const fwd = getBaseTuning('proto');
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
    const rwd = getBaseTuning('proto');
    const awd = getBaseTuning('proto');
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

describe('drifting and the handbrake', () => {
  const world = flatWorld();
  const forwardSpeed = (c: CarState) => c.vx * Math.sin(c.yaw) + c.vz * Math.cos(c.yaw);

  /** First gear flick, then a scripted hold: throttle with a little counter steer. Returns the car. */
  function flickAndHold(throttle: number, holdTicks: number): CarState {
    const t = getBaseTuning('proto');
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 150; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    c.manualGearbox = true;
    for (let i = 0; i < 24; i++) stepCar(c, t, input({ throttle: 0.6, steer: -1, handbrake: true }), { world });
    for (let i = 0; i < holdTicks; i++) stepCar(c, t, input({ throttle, steer: 0.3 }), { world });
    return c;
  }

  it('throttle in a slide spins the rear wheels up to the limiter, and lifting hooks them back up', () => {
    const t = getBaseTuning('proto');
    // The gearing this was written for: the retired Proto Compact's final drive, 4.32 on a 0.31 m tire.
    // On base's taller gearing the slide settles torque limited short of the limiter.
    t.gearbox.finalDrive = 4.32 * t.geometry.wheelRadius / 0.31;
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 150; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    c.manualGearbox = true;
    for (let i = 0; i < 24; i++) stepCar(c, t, input({ throttle: 0.6, steer: -1, handbrake: true }), { world });
    let maxRpm = 0;
    let maxRatio = 0;
    let maxSpin = 0;
    for (let i = 0; i < 90; i++) {
      stepCar(c, t, input({ throttle: 1, steer: 0.3 }), { world });
      maxRpm = Math.max(maxRpm, c.rpm);
      maxRatio = Math.max(maxRatio, c.wheelSpeedRear / Math.max(1, forwardSpeed(c)));
      maxSpin = Math.max(maxSpin, c.spinRear);
    }
    // The engine is locked to the spinning wheels: it climbs to the limiter (the stock car settles torque
    // limited just under it in first) with the tread well ahead of the road.
    expect(maxRpm).toBeGreaterThan(t.engine.redline * 0.9);
    expect(maxRatio).toBeGreaterThan(1.5);
    expect(maxSpin).toBe(1);
    expect(Math.abs(c.slipAngle)).toBeGreaterThan(30 * DEG);
    // Lift: the tires pull the wheels back to road speed within 0.6 s, even against first gear's inertia.
    for (let i = 0; i < 36; i++) stepCar(c, t, input({ steer: 0.3 }), { world });
    expect(c.spinRear).toBe(0);
    expect(c.wheelSpeedRear / Math.max(1, forwardSpeed(c))).toBeLessThan(1.15);
    // Undriven front wheels never spin.
    expect(c.spinFront).toBe(0);
  });

  it('the handbrake locks the rear wheels, turns the car in with the steering, and revs the engine free', () => {
    const t = getBaseTuning('proto');
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 240; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    for (let i = 0; i < 30; i++) {
      stepCar(c, t, input({ throttle: 1, steer: -1, handbrake: true }), { world });
      if (i >= 6) {
        expect(c.wheels[2].spinRate).toBe(0);
        expect(c.wheels[3].spinRate).toBe(0);
      }
    }
    expect(Math.abs(c.slipAngle)).toBeGreaterThan(15 * DEG);
    // Clutch out while the locked rear is the driven axle: the throttle revs the engine to the limiter.
    expect(c.rpm).toBeGreaterThan(t.engine.redline * 0.9);
    expect(c.wheels[0].spinRate).toBeGreaterThan(20);
  });

  it('handbrake and brake together stop the car along its path: no reverse, no swivel', () => {
    const t = getBaseTuning('proto');
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 300; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    let minYawRate = Infinity;
    let maxYawRate = -Infinity;
    for (let i = 0; i < 240; i++) {
      stepCar(c, t, input({ brake: 1, steer: -1, handbrake: true }), { world });
      minYawRate = Math.min(minYawRate, c.yawRate);
      maxYawRate = Math.max(maxYawRate, c.yawRate);
      expect(c.gear).toBeGreaterThan(0);
    }
    // It rotated one way under the handbrake and never got whipped back the other.
    expect(maxYawRate).toBeGreaterThan(0.5);
    expect(minYawRate).toBeGreaterThan(-0.3);
    expect(c.speed).toBeLessThan(0.5);
    expect(Math.abs(c.slipAngle)).toBeLessThan(5 * DEG);
  });

  it('a drift replays bit for bit', () => {
    const a = JSON.stringify(flickAndHold(0.8, 120));
    const b = JSON.stringify(flickAndHold(0.8, 120));
    expect(a).toBe(b);
  });
});

describe('launch control and the pedal combos', () => {
  const world = flatWorld();
  const withLaunch = (carId: string, launchRpm: number) => applyBuild(getBaseTuning(carId), { ...stockPerformance(), launchRpm });

  it('the two-step bounces the engine under the launch rpm on the grid; off, the grid revs as it always has', () => {
    const t = withLaunch('proto', 5000);
    expect(t.launch.twoStepRpm).toBe(5000);
    const c = createCar(0, 0, 0, 0);
    let cuts = 0;
    let low = Infinity;
    for (let i = 0; i < 120; i++) {
      gridRev(c, t, input({ throttle: 1 }), DT);
      if (i >= 30) {
        low = Math.min(low, c.rpm);
        if (c.twoStepCut > 0) cuts++;
      }
      expect(c.rpm).toBeLessThanOrEqual(5000);
    }
    // Held just under the set point, the spark off a good share of the time: the stutter.
    expect(low).toBeGreaterThanOrEqual(5000 - t.launch.twoStepDepth);
    expect(cuts).toBeGreaterThan(20);
    expect(cuts).toBeLessThan(80);
    expect(c.lineLock).toBe(false);
    const free = createCar(0, 0, 0, 0);
    const stock = applyBuild(getBaseTuning('proto'), stockPerformance());
    for (let i = 0; i < 120; i++) gridRev(free, stock, input({ throttle: 1 }), DT);
    expect(free.rpm).toBeCloseTo(stock.engine.redline * 0.85, 0);
    expect(free.twoStepCut).toBe(0);
    expect(free.wheelspin).toBe(false);
  });

  it('gas and brake standing is a line lock: the driven wheels spin, the car stays put, in the countdown too', () => {
    const t = applyBuild(getBaseTuning('proto'), stockPerformance());
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 120; i++) stepCar(c, t, input({ throttle: 1, brake: 1 }), { world });
    expect(c.lineLock).toBe(true);
    expect(c.spinRear).toBeGreaterThan(0.5);
    expect(c.spinFront).toBe(0);
    expect(c.wheelspin).toBe(true);
    expect(c.speed).toBeLessThan(1);
    expect(Math.abs(c.z)).toBeLessThan(1.5);
    // On the grid the same combo spins the rear up without the physics running.
    const g = createCar(0, 0, 0, 0);
    for (let i = 0; i < 90; i++) gridRev(g, t, input({ throttle: 1, brake: 1 }), DT);
    expect(g.lineLock).toBe(true);
    expect(g.spinRear).toBeGreaterThan(0.5);
    expect(g.wheelSpeedFront).toBe(0);
    expect(g.wheels[2].skid).toBeGreaterThan(0.5);
    // Front drive spins the front instead.
    const f = { ...t, drivetrain: { ...t.drivetrain, layout: 'fwd' as const } };
    const fc = createCar(0, 0, 0, 0);
    for (let i = 0; i < 120; i++) stepCar(fc, f, input({ throttle: 1, brake: 1 }), { world });
    expect(fc.spinFront).toBeGreaterThan(0.5);
    expect(fc.spinRear).toBe(0);
  });

  it('gas and brake rolling is antilag on a turbo car only: boost pinned, no drive, and full boost on release', () => {
    expect(getBaseTuning('protoCoupe').engine.turbo).toBe(true);
    expect(getBaseTuning('proto').engine.turbo).toBe(false);
    const roll = (carId: string) => {
      const t = applyBuild(getBaseTuning(carId), stockPerformance());
      const c = createCar(0, 0, 0, 0);
      for (let i = 0; i < 180; i++) stepCar(c, t, input({ throttle: 1 }), { world });
      const before = c.speed;
      let held = 0;
      for (let i = 0; i < 30; i++) {
        stepCar(c, t, input({ throttle: 1, brake: 1 }), { world });
        if (c.antilag) held++;
      }
      return { c, t, before, held };
    };
    const turbo = roll('protoCoupe');
    expect(turbo.held).toBe(30);
    expect(turbo.c.boost).toBe(1);
    expect(turbo.c.speed).toBeLessThan(turbo.before - 3);
    expect(turbo.c.rpm).toBeGreaterThan(turbo.t.launch.antilagRpm - turbo.t.launch.twoStepDepth - 1);
    // Off the brake: boost stays pinned for the hold, then the spool model takes over.
    stepCar(turbo.c, turbo.t, input({ throttle: 1 }), { world });
    expect(turbo.c.antilag).toBe(false);
    expect(turbo.c.boost).toBe(1);
    expect(turbo.c.antilagHold).toBeGreaterThan(0);
    // Braked to a standstill with the gas still down, the combo turns into the line lock.
    for (let i = 0; i < 120; i++) stepCar(turbo.c, turbo.t, input({ throttle: 1, brake: 1 }), { world });
    expect(turbo.c.antilag).toBe(false);
    expect(turbo.c.lineLock).toBe(true);
    expect(turbo.c.spinRear).toBeGreaterThan(0.5);
    const na = roll('proto');
    expect(na.held).toBe(0);
    expect(na.c.boost).toBe(0);
  });

  it('a turbo spools: boost builds under load and bleeds off the throttle', () => {
    const t = applyBuild(getBaseTuning('protoCoupe'), stockPerformance());
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 90; i++) stepCar(c, t, input({ throttle: 1 }), { world });
    expect(c.boost).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) stepCar(c, t, input({}), { world });
    expect(c.boost).toBe(0);
  });

  it('a two-step launch with a burnout replays bit for bit', () => {
    const run = () => {
      const t = withLaunch('protoCoupe', 5500);
      const c = createCar(0, 0, 0, 0);
      for (let i = 0; i < 60; i++) gridRev(c, t, input({ throttle: 1, brake: i < 30 ? 1 : 0 }), DT);
      for (let i = 0; i < 180; i++) stepCar(c, t, input({ throttle: 1, brake: i > 120 ? 1 : 0 }), { world });
      return c;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
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
    const t = getBaseTuning('proto');
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

  it('reports spark telemetry (wall scrapes, bottoming out) that never feeds back into the physics', () => {
    const t = getBaseTuning('proto');
    const run = (world: World, garbage: boolean) => {
      const c = createCar(3 - t.geometry.halfWidth, 0, 0, 0);
      c.vz = 35;
      c.vx = 1.5;
      let maxScrape = 0;
      let normal = 0;
      for (let i = 0; i < 60; i++) {
        if (garbage) {
          // The sim must only write these: scrambling them changes nothing.
          c.scrape = 999;
          c.scrapeNx = c.scrapeNz = 7;
          c.bottomOut = 5;
          c.bottomWheel = 3;
        }
        stepCar(c, t, input({ throttle: 0.6, steer: -0.15 }), { world });
        c.impact = collideCarWithWorld(c, t, world);
        if (c.scrape > maxScrape) {
          maxScrape = c.scrape;
          normal = c.scrapeNx;
        }
      }
      return { maxScrape, normal, end: [c.x, c.z, c.vx, c.vz, c.yaw] };
    };
    const wall = run(wallWorld('wall'), false);
    expect(wall.maxScrape).toBeGreaterThan(20);
    expect(wall.normal).toBe(-1);
    expect(run(wallWorld('wall'), true).end).toEqual(wall.end);
    const open = run(flatWorld(), false);
    expect(open.maxScrape).toBe(0);
    // Dropped onto the road from a jump: the suspension runs out of travel and the underbody hits.
    const c = createCar(0, 0, 0, 1.2);
    c.vz = 25;
    c.vy = -5;
    let bottom = 0;
    for (let i = 0; i < 60; i++) {
      stepCar(c, t, input({}), { world: flatWorld() });
      bottom = Math.max(bottom, c.bottomOut);
    }
    expect(bottom).toBeGreaterThan(0.01);
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

describe('landings, banks and brakes', () => {
  /** A river style channel: floor at -4.2 m for |z| < 11, a smoothstep bank up to the street at |z| = 19. */
  function bankWorld(): World {
    const F = 11;
    const W = 8;
    const D = 4.2;
    const u = (z: number) => Math.min(1, Math.max(0, (Math.abs(z) - F) / W));
    return {
      ...flatWorld(),
      heightAt: (_x: number, z: number) => -D * (1 - u(z) * u(z) * (3 - 2 * u(z))),
      driveHeightAt: (_x: number, z: number) => -D * (1 - u(z) * u(z) * (3 - 2 * u(z))),
      slopeAt: (_x: number, z: number) => ({ gx: 0, gz: Math.abs(z) < F + W ? (D * 6 * u(z) * (1 - u(z)) * Math.sign(z)) / W : 0 }),
    } as World;
  }

  it('a hard landing squats, rebounds a little and settles without leaving the ground', () => {
    for (const id of SELECTABLE_CAR_IDS) {
      const t = getBaseTuning(id);
      const world = flatWorld();
      const c = createCar(0, 0, 0, 0);
      for (let i = 0; i < 120; i++) stepCar(c, t, input({}), { world });
      const rest = c.y;
      c.y = rest + 7;
      c.vz = 25;
      let landed = -1;
      let low = 0;
      let high = -Infinity;
      for (let i = 0; i < 240; i++) {
        stepCar(c, t, input({}), { world });
        const down = c.wheels.some((w) => w.contact);
        if (landed < 0) {
          if (down) landed = i;
          continue;
        }
        expect(down, `${id}: off the ground ${i - landed} ticks after landing`).toBe(true);
        low = Math.min(low, c.y - rest);
        if (i > landed + 6) high = Math.max(high, c.y - rest);
      }
      // Into the bump stops but well clear of the chassis (0.35 m), then a small rebound over rest.
      expect(low, id).toBeLessThan(-0.12);
      expect(low, id).toBeGreaterThan(-0.3);
      expect(high, id).toBeGreaterThan(0.01);
      expect(high, id).toBeLessThan(0.1);
      expect(Math.abs(c.y - rest), id).toBeLessThan(0.01);
    }
  });

  it('lies over on a steep bank and holds a line along it with all four wheels down', () => {
    const t = getBaseTuning('proto');
    const world = bankWorld();
    // Lanes on the bank (|z| m) and speeds (m/s): 31 degrees and the steepest 38.
    for (const [lane, v] of [
      [13, 17],
      [15, 25],
      [15, 36],
      [17, 25],
    ]) {
      const c = createCar(0, 0, 0, 0);
      placeCar(c, -300, lane, Math.PI / 2, world);
      c.vx = v;
      let worst = 0;
      for (let i = 0; i < 240; i++) {
        // Pursuit along +x: aim at the lane a lookahead ahead (headings from +x grow toward +z, the car's right).
        const want = Math.atan2(lane - c.z, 8 + c.speed * 0.6);
        const steer = Math.max(-1, Math.min(1, (want - Math.atan2(Math.cos(c.yaw), Math.sin(c.yaw))) * 3));
        stepCar(c, t, input({ throttle: c.speed < v ? 0.7 : 0.2, steer }), { world });
        if (i < 30) continue;
        expect(c.wheels.every((w) => w.contact), `lane ${lane} at ${v} m/s, tick ${i}`).toBe(true);
        const sl = world.slopeAt(c.x, c.z);
        const groundRoll = Math.atan2(sl.gx * Math.cos(c.yaw) - sl.gz * Math.sin(c.yaw), 1);
        worst = Math.max(worst, Math.abs(c.roll - groundRoll));
      }
      expect(Math.abs(c.z - lane), `lane ${lane} at ${v} m/s`).toBeLessThan(3);
      expect(worst, `lane ${lane} at ${v} m/s`).toBeLessThan(9 * DEG);
    }
  });

  it('brakes hard: 160 km/h to a stop in under 60 m, shorter with upgraded brakes', () => {
    const stop = (t: CarTuning) => {
      const c = createCar(0, 0, 0, 0);
      c.vz = 160 / 3.6;
      for (let i = 0; i < 600 && c.vz > 0.3; i++) stepCar(c, t, input({ brake: 1 }), { world: flatWorld() });
      return c.z;
    };
    for (const id of SELECTABLE_CAR_IDS) {
      const stock = stop(getBaseTuning(id));
      expect(stock, id).toBeLessThan(60);
      expect(stop(applyBuild(getBaseTuning(id), { ...stockPerformance(), brakes: 3 })), id).toBeLessThan(stock - 5);
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
