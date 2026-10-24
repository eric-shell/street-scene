import { describe, expect, it } from 'vitest';
import { applyBuild, isStockSetup, stockPerformance, tuningForBuild, validatePerformance, PerformanceBuild } from '../src/sim/build';
import { defaultBuild, validateBuild } from '../src/shared/carBuild';
import { CAR_IDS, CarTuning, DEFAULT_CAR_ID, SETUP, SETUP_POSITIONS, SETUP_SLIDERS, STOCK_POSITION, getBaseTuning, validateSetup, type SetupPosition, type SetupSlider } from '../src/sim/tuning';
import { measureStats } from '../src/sim/stats';
import { createCar, stepCar } from '../src/sim/car';
import type { World } from '../src/city/world';
import { decodeShareCode, encodeShareCode } from '../src/garage/storage';
import { validateCatalog } from '../scripts/validateParts';
import { createRace } from '../src/sim/race';
import { carSnapshot, flatWorld, input, raceConfig, runAutopilot } from './helpers';
import { MAX_BEAD, beadForSize, detectProfile, remapWheel, sizeForBead } from '../src/render/car/wheelFit';
import { BlipScript, RevModel } from '../src/garage/revModel';

/** The stock setup with one slider moved. */
const setup = (slider: SetupSlider, p: SetupPosition, launchRpm = 0): PerformanceBuild => ({ ...stockPerformance(), launchRpm, [slider]: p });
const tuned = (carId: string, slider: SetupSlider, p: SetupPosition) => tuningForBuild(carId, setup(slider, p));
/** A build saved with the retired component upgrades (every tier at 2). */
const LEGACY_TIERS = { engine: 2, turbo: 2, exhaust: 2, transmission: 2, tires: 2, suspension: 2, brakes: 2, weight: 2, nitrous: 2 };

describe('build validation', () => {
  it('clamps and repairs garbage input', () => {
    const b = validateBuild({
      carId: 'nope',
      name: '<script>x</script>'.repeat(5),
      visual: {
        paint: { color: 'red', finish: 'chrome' },
        wheels: { size: 99, color: '#00ff00' },
        stance: { rideHeight: -5, camberFront: -45, offset: 'x' },
        decals: Array.from({ length: 20 }, () => ({ shape: 'flame', pos: [99, 0, 0], normal: [0, 0, 0], scale: 50 })),
        parts: { spoiler: 'ok_id', hood: '../../etc', nonsense: 'x' },
      },
      performance: { suspension: 9, gearing: -4, differential: 2.4, brakeBalance: 'x' },
    });
    expect(b.carId).toBe('protoHatch');
    expect(b.name.length).toBeLessThanOrEqual(24);
    expect(b.name).not.toContain('<');
    expect(b.visual.paint.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.visual.paint.finish).toBe('metallic');
    // Legacy single wheel size, camber and offset migrate onto both axles (clamped).
    expect(b.visual.stance.front.wheelSize).toBe(1.25);
    expect(b.visual.stance.rear.wheelSize).toBe(1.25);
    expect(b.visual.stance.front.rideHeight).toBe(-0.09);
    expect(b.visual.stance.rear.rideHeight).toBe(-0.09);
    expect(b.visual.stance.front.camber).toBe(-10);
    expect(b.visual.stance.rear.camber).toBe(0);
    expect(b.visual.stance.front.offset).toBe(0);
    expect(b.visual.decals.length).toBe(8);
    expect(b.visual.decals[0].pos[0]).toBe(4);
    expect(b.visual.decals[0].scale).toBe(3);
    // carId was invalid, so per-car parts were dropped
    expect(b.visual.parts.spoiler).toBeUndefined();
    expect(b.visual.parts.hood).toBeUndefined();
    expect(b.performance).toMatchObject({ suspension: 5, gearing: 1, differential: 2, brakeBalance: 3 });
  });

  it('share codes round trip to the same build', async () => {
    const b = defaultBuild('protoHatch');
    b.name = 'Midnight Club';
    b.visual.paint = { color: '#19e6ff', finish: 'pearl' };
    b.visual.parts = { spoiler: 'protoHatch_spoiler_1', frontBumper: 'protoHatch_frontBumper_kurogane', wheels: 'wheel_yari' };
    b.visual.decals.push({ shape: 'number', color: '#ff3df2', pos: [0.9, 0.6, 0.2], normal: [1, 0, 0], rotation: 12, scale: 0.7, mirror: true, text: '42' });
    b.visual.wheels = { paint: { color: '#ffcc00', finish: 'candy', match: false }, rearPaint: { color: '#1a1b1f', finish: 'matte', match: true }, rearPart: 'wheel_kumo', tire: 'standard', rearTire: 'stretched' };
    b.visual.calipers = { color: '#ffcc1f', finish: 'pearl', match: true };
    b.visual.underglow = { enabled: true, color: '#ff00aa', color2: '#00ffaa', pattern: 'chase', brightness: 1.4, speed: 2, size: 1.2 };
    b.visual.stance = { front: { rideHeight: -0.045, camber: -3.5, offset: 0.015, wheelSize: 1.05 }, rear: { rideHeight: -0.02, camber: -7, offset: 0.05, wheelSize: 1.2 } };
    b.performance = { suspension: 1, gearing: 5, differential: 4, brakeBalance: 2, launchRpm: 4500, antilagRpm: 5250 };
    const code = await encodeShareCode(b);
    expect(code.length).toBeLessThan(700);
    const back = await decodeShareCode(code);
    expect(back).toEqual(validateBuild(b));
    expect(back!.performance).toEqual({ suspension: 1, gearing: 5, differential: 4, brakeBalance: 2, launchRpm: 4500, antilagRpm: 5250 });
    expect(await decodeShareCode('garbage!!')).toBeNull();
  });

  it('moves builds of the renamed IceMaan cars to the authored ones, and retired cars to the default', () => {
    // The s64 became the Proto Compact, since retired: the build moves to the default car and keeps
    // only its wheels (the parts were the old car's).
    const b = validateBuild({ carId: 's64', visual: { parts: { body: 's64_body_kit2', spoiler: 's64_spoiler_2', wheels: 'wheel_gc14_3' } } });
    expect(b.carId).toBe(DEFAULT_CAR_ID);
    expect(b.visual.parts).toEqual({ wheels: 'wheel_kagero' });
    expect(validateBuild({ carId: 'protoCompact', visual: { parts: { wheels: 'wheel_kiba' } } })).toMatchObject({ carId: DEFAULT_CAR_ID, visual: { parts: { wheels: 'wheel_kumo' } } });
    expect(validateBuild({ carId: 'gc14' }).carId).toBe('protoHatch');
  });

  it('migrates legacy stance from old saves', () => {
    const b = validateBuild({ carId: 'protoHatch', visual: { wheels: { size: 1.1, color: '#ffffff' }, stance: { rideHeight: -0.02, camberFront: -4, camberRear: -6, offset: 0.02 } } });
    // One legacy ride height lowers both axles.
    expect(b.visual.stance.front).toEqual({ rideHeight: -0.02, camber: -4, offset: 0.02, wheelSize: 1.1 });
    expect(b.visual.stance.rear).toEqual({ rideHeight: -0.02, camber: -6, offset: 0.02, wheelSize: 1.1 });
    // A legacy single wheel color paints both axles; a rear color of its own is kept. Both take the default finish.
    expect(b.visual.wheels).toMatchObject({ paint: { color: '#ffffff', finish: 'metallic' }, rearPaint: { color: '#ffffff', finish: 'metallic' } });
    expect(validateBuild({ visual: { wheels: { color: '#ffffff', rearColor: '#1a1b1f' } } }).visual.wheels).toMatchObject({ paint: { color: '#ffffff' }, rearPaint: { color: '#1a1b1f' } });
    // Builds from before caliper paint get the stock red; a missing rear wheel paint follows the front's.
    expect(b.visual.calipers).toEqual({ color: '#c41e3a', finish: 'gloss', match: false });
    expect(validateBuild({ visual: { wheels: { paint: { color: '#123456', finish: 'candy', match: true } } } }).visual.wheels.rearPaint).toEqual({ color: '#123456', finish: 'candy', match: true });
    // Builds from before per axle wheels and tires wear the front's wheel and the standard tire all round.
    expect(b.visual.wheels).toMatchObject({ rearPart: null, tire: 'standard', rearTire: 'standard' });
    // A rear tire of its own is kept; a missing one follows the front, an unknown one falls back.
    expect(validateBuild({ visual: { wheels: { tire: 'stretched' } } }).visual.wheels).toMatchObject({ tire: 'stretched', rearTire: 'stretched' });
    expect(validateBuild({ visual: { wheels: { tire: 'stretched', rearTire: 'bald', rearPart: 'wheel_protoHatch_1' } } }).visual.wheels).toMatchObject({ tire: 'stretched', rearTire: 'stretched', rearPart: 'wheel_kaze' });
    // The first set's shapes: both stretches are the stretched tire, the meaty one standard.
    expect(validateBuild({ visual: { wheels: { tire: 'aggressiveStretch', rearTire: 'meaty' } } }).visual.wheels).toMatchObject({ tire: 'stretched', rearTire: 'standard' });
    // New per axle values win over legacy ones and are clamped independently.
    const n = validateBuild({ visual: { stance: { camberFront: -4, front: { camber: -2, offset: 0.5, wheelSize: 0.9 }, rear: { wheelSize: 2 } } } });
    expect(n.visual.stance.front).toEqual({ rideHeight: 0, camber: -2, offset: 0.09, wheelSize: 0.9 });
    expect(n.visual.stance.rear).toEqual({ rideHeight: 0, camber: 0, offset: 0, wheelSize: 1.25 });
  });

  it('old share codes (single axle stance) still load', async () => {
    // Encoded by the pre per axle format: wheels.size 1.15, camber -6 / -8.5, offset 0.04.
    const legacy =
      'zPZDdToQwEIVfxRxvB9J2gazzEl6YeGPMplta2Eh2CUVRCe9uZlBvvibzc87prHgGW8IVjMehvXua_TVEEAIYXbAVCB_gFaMXhhsY9_YhNimBkC5gjNFPAzbCHLRZ28Z6EMZZNpYejKWPcTjlpjo5GZTaivwNtqWt6Vc1pRCMkX4bwC-vhKwKUw8uTGkOhJDARUMIE7g4ljXhlsCmNJXYX2S6fZNC_a9qjT06VX3vpB-v4OSHHP8GjIm1fia4PcWhTU7iy0nyHH37BcJ50jPl0e2vZN8I_SA70SenEvOwS1jvvFiO6gh2hBlsCJ_KTjkps_KsXJQ3sNm2Hw';
    const b = await decodeShareCode(legacy);
    expect(b).not.toBeNull();
    expect(b!.name).toBe('Old Stance');
    expect(b!.visual.stance.front.rideHeight).toBe(-0.03);
    expect(b!.visual.stance.rear.rideHeight).toBe(-0.03);
    expect(b!.visual.stance.front).toEqual({ rideHeight: -0.03, camber: -6, offset: 0.04, wheelSize: 1.15 });
    expect(b!.visual.stance.rear).toEqual({ rideHeight: -0.03, camber: -8.5, offset: 0.04, wheelSize: 1.15 });
    expect(b!.visual.wheels).toEqual({ paint: { color: '#ffcc00', finish: 'metallic', match: false }, rearPaint: { color: '#ffcc00', finish: 'metallic', match: false }, rearPart: null, tire: 'standard', rearTire: 'standard' });
    // Saved before the cars were renamed: the wheel id follows the rename.
    expect(b!.visual.parts.wheels).toBe('wheel_yari');
    // Saved with the retired component upgrades (engine tier 2): it starts on the stock setup.
    expect(b!.performance).toMatchObject({ suspension: 3, gearing: 3, differential: 3, brakeBalance: 3 });
    expect(b!.performance).not.toHaveProperty('engine');
  });

  it('visual choices never change the tuning the sim uses', () => {
    const a = defaultBuild('protoHatch');
    const b = defaultBuild('protoHatch');
    b.visual.parts = { spoiler: 'protoHatch_spoiler_1', rearBumper: 'protoHatch_rearBumper_hayate', sideSkirts: 'protoHatch_sideSkirts_kurogane' };
    b.visual.stance.front.rideHeight = -0.08;
    expect(applyBuild(getBaseTuning(a.carId), a.performance)).toEqual(applyBuild(getBaseTuning(b.carId), b.performance));
  });
});

describe('parts catalog', () => {
  it('every catalog entry validates against its file', async () => {
    const r = await validateCatalog();
    expect(r.errors).toEqual([]);
    expect(r.checked).toBeGreaterThan(5);
  });
});

describe('setup sliders', () => {
  const world = flatWorld();
  /** Straight up to `kmh` on full throttle, in a world of its own when given. */
  const rollTo = (t: CarTuning, kmh: number, w: World = world) => {
    const c = createCar(0, 0, 0, 0);
    for (let i = 0; i < 60 * 30 && c.speed * 3.6 < kmh; i++) stepCar(c, t, input({ throttle: 1 }), { world: w });
    return c;
  };
  /** Steer `steer` for `ticks` with the rest of `inp`: the heading change (rad). */
  const heading = (t: CarTuning, kmh: number, ticks: number, inp: Parameters<typeof input>[0]) => {
    const c = rollTo(t, kmh);
    const y0 = c.yaw;
    for (let i = 0; i < ticks; i++) stepCar(c, t, input(inp), { world });
    return Math.abs(c.yaw - y0);
  };

  it('position 3 on every slider is the stock car, bit for bit', () => {
    for (const id of CAR_IDS) {
      const base = getBaseTuning(id);
      expect(JSON.stringify(applyBuild(base, stockPerformance())), id).toBe(JSON.stringify(base));
      // With the car's launch rpm only the two-step changes.
      const launch = applyBuild(base, stockPerformance(id));
      expect(JSON.stringify({ ...launch, launch: { ...launch.launch, twoStepRpm: 0 } }), id).toBe(JSON.stringify(base));
      expect(isStockSetup(stockPerformance(id))).toBe(true);
      expect(isStockSetup(setup('gearing', 2))).toBe(false);
    }
  });

  it('every table holds the identity at the stock position, and a bad table throws', () => {
    for (const s of SETUP_SLIDERS) {
      for (const [k, row] of Object.entries(SETUP[s] as Record<string, unknown>)) {
        if (k.startsWith('_')) continue;
        expect((row as number[])[STOCK_POSITION - 1], `${s}.${k}`).toBe(k.endsWith('Mul') ? 1 : 0);
      }
    }
    const good = JSON.parse(JSON.stringify(SETUP));
    expect(() => validateSetup(good)).not.toThrow();
    expect(() => validateSetup({ ...good, turbo: {} })).toThrow(/unknown key "setup.turbo"/);
    expect(() => validateSetup({ ...good, gearing: { finalDriveMul: [1.2, 1.1, 1, 0.9, 0.8], shiftTime: [0, 0, 0, 0, 0] } })).toThrow(/unknown key/);
    expect(() => validateSetup({ ...good, gearing: { finalDriveMul: [1.2, 1.1, 1.05, 0.9, 0.8] } })).toThrow(/must hold 1 at position 3/);
    expect(() => validateSetup({ ...good, gearing: { finalDriveMul: [1.1, 1, 0.9] } })).toThrow(/5 numbers/);
    expect(() => validateSetup({ ...good, gearing: { ...good.gearing, torqueBonus: [0.06, 0.03, 0.01, -0.03, -0.06] } })).toThrow(/must hold 0 at position 3/);
    expect(() => validateSetup({ ...good, gearing: { finalDriveMul: good.gearing.finalDriveMul, firstGearMul: good.gearing.firstGearMul } })).toThrow(/torqueBonus" needs 5 numbers/);
    expect(() => validateSetup({ ...good, differential: { open: [0.8, 0.4, 0, 0, 0] } })).toThrow(/needs 5 numbers/);
  });

  it('validation rounds and clamps positions; builds from before the sliders start on the stock setup', () => {
    expect(validatePerformance({ suspension: 1.4, gearing: 4.6, differential: 0, brakeBalance: 99, launchRpm: 0 })).toEqual({ suspension: 1, gearing: 5, differential: 1, brakeBalance: 5, launchRpm: 0 });
    expect(validatePerformance({})).toEqual(stockPerformance());
    // Old saves, share codes and replay configs: every tier key, the old suspension tier (0..3) among them.
    expect(validatePerformance({ ...LEGACY_TIERS, suspension: 1, launchRpm: 4000 })).toEqual({ ...stockPerformance(), launchRpm: 4000 });
    expect(validatePerformance({ engine: 0, turbo: 0, exhaust: 0, transmission: 0, tires: 0, suspension: 0, brakes: 0, weight: 0, nitrous: 0 }, 'protoCoupe')).toEqual(stockPerformance('protoCoupe'));
    // An old garage slot in localStorage loads with the stock setup and keeps the rest of the build.
    const slot = validateBuild({ carId: 'protoWagon', name: 'Old Slot', performance: LEGACY_TIERS });
    expect(slot.name).toBe('Old Slot');
    expect(slot.performance).toEqual(stockPerformance('protoWagon'));
  });

  it('a stock race, and an old replay config with upgrade tiers, drive exactly as before', () => {
    // Old replays and ghosts carry the retired tiers in their config; at tier 0 they were the stock car.
    const now = carSnapshot(runAutopilot(raceConfig(6001, 'sprint', 1), 20));
    const legacy = { engine: 0, turbo: 0, exhaust: 0, transmission: 0, tires: 0, suspension: 0, brakes: 0, weight: 0, nitrous: 0 } as unknown as PerformanceBuild;
    expect(carSnapshot(runAutopilot(raceConfig(6001, 'sprint', 1, legacy), 20))).toBe(now);
  });

  it('a non-stock setup races deterministically', () => {
    const perf: PerformanceBuild = { suspension: 5, gearing: 1, differential: 1, brakeBalance: 1, launchRpm: 0 };
    const locked: PerformanceBuild = { suspension: 1, gearing: 5, differential: 5, brakeBalance: 5, launchRpm: 0 };
    for (const p of [perf, locked]) {
      const a = carSnapshot(runAutopilot(raceConfig(6002, 'circuit', 1, p), 20));
      expect(carSnapshot(runAutopilot(raceConfig(6002, 'circuit', 1, p), 20))).toBe(a);
      expect(a).not.toBe(carSnapshot(runAutopilot(raceConfig(6002, 'circuit', 1), 20)));
    }
  });

  it('gear ratio: short gears pull harder out of corners and run into the limiter, long ones keep pulling on nitrous', () => {
    /** A corner exit: braked from 130 to 60 km/h (the automatic shifts down on the way), then floored to 140 (s). */
    const exit = (t: CarTuning) => {
      const c = rollTo(t, 130);
      for (let i = 0; i < 600 && c.speed * 3.6 > 60; i++) stepCar(c, t, input({ brake: 0.6 }), { world });
      let i = 0;
      for (; i < 60 * 30 && c.speed * 3.6 < 140; i++) stepCar(c, t, input({ throttle: 1 }), { world });
      return i / 60;
    };
    /** A full tank burned down a long straight from 8 s of full throttle: the top speed and the seconds from 200 to 280 km/h. */
    const nitroRun = (t: CarTuning) => {
      const c = createCar(0, 0, 0, 0);
      c.nitro = 3;
      let top = 0;
      let at200 = 0;
      let at280 = 0;
      for (let i = 0; i < 60 * 30; i++) {
        stepCar(c, t, input({ throttle: 1, nitrous: i > 8 * 60 }), { world });
        top = Math.max(top, c.speed * 3.6);
        if (!at200 && c.speed * 3.6 >= 200) at200 = i;
        if (!at280 && c.speed * 3.6 >= 280) at280 = i;
      }
      return { top, pull: (at280 - at200) / 60 };
    };
    for (const id of ['protoHatch', 'protoCoupe', 'protoWagon']) {
      const st = SETUP_POSITIONS.map((p) => measureStats(tuned(id, 'gearing', p)));
      // The garage's 0-60 slows one step at a time to the right (the torque bonus, with first gear where it was).
      for (let i = 1; i < st.length; i++) expect(st[i].zeroTo60, `${id} ${i + 1}`).toBeGreaterThan(st[i - 1].zeroTo60);
      // Short tops out on its limiter, well under the drag top speed; Long holds the drag top speed (the bonus has faded by then).
      expect(st[0].topSpeed, id).toBeLessThan(st[2].topSpeed * 0.93);
      expect(st[4].topSpeed, id).toBeGreaterThan(st[2].topSpeed * 0.97);
      const ex = [1, 3, 5].map((p) => exit(tuned(id, 'gearing', p as SetupPosition)));
      expect(ex[0], id).toBeLessThan(ex[1] * 0.95);
      expect(ex[2], id).toBeGreaterThan(ex[1] * 1.05);
      // On nitrous the push goes on past the limiter, so every position stays strong; the long box keeps the engine pulling past the stock limiter.
      const [short, stock, long] = [1, 3, 5].map((p) => nitroRun(tuned(id, 'gearing', p as SetupPosition)));
      expect(long.top, id).toBeGreaterThan(stock.top + 5);
      expect(short.top, id).toBeLessThan(stock.top - 5);
      expect(short.top, id).toBeGreaterThan(st[2].topSpeed * 1.25);
      expect(long.pull, id).toBeLessThan(stock.pull * 0.85);
      expect(short.pull, id).toBeGreaterThan(stock.pull * 1.15);
    }
  });

  it('the gearing torque bonus works out of corners and is gone by top speed', () => {
    const t = getBaseTuning('protoHatch');
    const bonus = { ...t, gearbox: { ...t.gearbox, torqueBonus: 0.06 } };
    /** One tick on full throttle from a car rolling at `kmh` in its gear: the speed gained (m/s). */
    const gain = (tt: CarTuning, kmh: number) => {
      const c = createCar(0, 0, 0, 0);
      for (let i = 0; i < 60 * 60 && c.speed * 3.6 < kmh; i++) stepCar(c, t, input({ throttle: 1 }), { world });
      const v0 = c.speed;
      stepCar(c, tt, input({ throttle: 1 }), { world });
      return c.speed - v0;
    };
    expect(gain(bonus, 90)).toBeGreaterThan(gain(t, 90) * 1.04);
    expect(gain(bonus, t.gearbox.torqueBonusFadeEnd * 3.6 + 1)).toBe(gain(t, t.gearbox.torqueBonusFadeEnd * 3.6 + 1));
  });

  it('brake balance: rear bias rotates the car on the brakes and stops longer, front bias stops straight', () => {
    for (const id of ['proto', 'protoHatch']) {
      // Trail braking: brake and steer together from 90 km/h for a second.
      const turn = (p: SetupPosition) => heading(tuned(id, 'brakeBalance', p), 90, 60, { brake: 0.8, steer: 0.5 });
      expect(turn(1), id).toBeGreaterThan(turn(3) * 1.08);
      expect(turn(5), id).toBeLessThan(turn(3) * 0.92);
      const stop = (p: SetupPosition) => {
        const t = tuned(id, 'brakeBalance', p);
        const c = rollTo(t, 100);
        const z0 = c.z;
        for (let i = 0; i < 600 && c.speed > 0.3; i++) stepCar(c, t, input({ brake: 1 }), { world });
        return c.z - z0;
      };
      expect(stop(1), id).toBeGreaterThan(stop(3) + 0.8);
      expect(stop(5), id).toBeLessThan(stop(3) + 0.3);
    }
  });

  it('differential: open loses drive out of a turn and lets slides die, locked pushes on turn in', () => {
    // Floor it mid corner (AWD): the lifted inside wheels cap an open axle's drive.
    const exit = (t: CarTuning) => {
      const c = rollTo(t, 55);
      for (let i = 0; i < 90; i++) stepCar(c, t, input({ steer: 0.55, throttle: c.speed * 3.6 < 55 ? 0.35 : 0.1 }), { world });
      const v0 = c.speed;
      for (let i = 0; i < 90; i++) stepCar(c, t, input({ steer: 0.55, throttle: 1 }), { world });
      return c.speed - v0;
    };
    expect(exit(tuned('protoHatch', 'differential', 1))).toBeLessThan(exit(tuned('protoHatch', 'differential', 3)) * 0.85);
    // A handbrake flick into a powered slide (RWD): the open axle cannot keep the rear spinning.
    const drift = (t: CarTuning) => {
      const c = rollTo(t, 70);
      let held = 0;
      for (let i = 0; i < 240; i++) {
        const flick = i < 21;
        stepCar(c, t, input({ steer: flick ? 1 : 0.25 * Math.sign(c.slipAngle || 1), handbrake: flick, throttle: flick ? 0.5 : 0.75 }), { world });
        if (Math.abs(c.slipAngle) > (15 * Math.PI) / 180) held++;
      }
      return held / 60;
    };
    expect(drift(tuned('proto', 'differential', 1))).toBeLessThan(drift(tuned('proto', 'differential', 3)) - 0.5);
    expect(drift(tuned('proto', 'differential', 5))).toBeGreaterThan(drift(tuned('proto', 'differential', 3)) - 0.1);
    // Turn in off the throttle at 90 km/h: the locked axle fights the rotation.
    for (const id of ['proto', 'protoHatch']) {
      const turn = (p: SetupPosition) => heading(tuned(id, 'differential', p), 90, 48, { steer: 0.6 });
      expect(turn(5), id).toBeLessThan(turn(3) * 0.975);
      expect(turn(4), id).toBeLessThan(turn(3));
    }
  });

  it('suspension: stiff sits flatter and turns in quicker, soft rides kerbs and grips on dirt', () => {
    const rollAt60 = (t: CarTuning) => {
      const c = rollTo(t, 60);
      let r = 0;
      for (let i = 0; i < 120; i++) {
        stepCar(c, t, input({ steer: 0.5, throttle: c.speed * 3.6 < 60 ? 0.4 : 0.15 }), { world });
        r = Math.max(r, Math.abs(c.roll));
      }
      return r;
    };
    // A kerb taken square at 60 km/h (the sim's curb: 9 cm over 34 cm): stiff springs on short travel hit the stops.
    const kerb = (t: CarTuning) => {
      const ramp = (z: number) => (z < 60 ? 0 : z > 60.34 ? 0.09 : 0.09 * ((z - 60) / 0.34) ** 2 * (3 - 2 * ((z - 60) / 0.34)));
      const w = { ...world, heightAt: (_x: number, z: number) => ramp(z), driveHeightAt: (_x: number, z: number) => ramp(z) } as World;
      const c = rollTo(t, 60);
      c.z = 40;
      let over = 0;
      for (let i = 0; i < 90; i++) {
        stepCar(c, t, input({ throttle: 0.4 }), { world: w });
        over = Math.max(over, c.bottomOut);
      }
      return over;
    };
    for (const id of ['proto', 'protoHatch']) {
      const soft = tuned(id, 'suspension', 1);
      const stock = tuned(id, 'suspension', 3);
      const stiff = tuned(id, 'suspension', 5);
      expect(rollAt60(stiff), id).toBeLessThan(rollAt60(stock) * 0.8);
      expect(rollAt60(soft), id).toBeGreaterThan(rollAt60(stock) * 1.15);
      expect(heading(stiff, 90, 48, { steer: 0.6 }), id).toBeGreaterThan(heading(soft, 90, 48, { steer: 0.6 }));
      // Past the sparks' threshold (session.ts SPARK.bottomMin) on stiff; soft and stock ride it.
      expect(kerb(stiff), id).toBeGreaterThan(0.004);
      expect(kerb(soft), id).toBe(0);
      expect(kerb(stock), id).toBe(0);
      // Grip on dirt and cobbles against the road's: soft keeps more of it.
      const offroad = (t: CarTuning) => t.tires.gripRear * t.surface.offroadGrip;
      expect(offroad(soft)).toBeGreaterThan(offroad(stock) * 1.05);
      expect(offroad(stiff)).toBeLessThan(offroad(stock) * 0.95);
      expect(stiff.tires.gripFront).toBeGreaterThan(stock.tires.gripFront);
    }
  });

  it('AI rivals and test configs drive the stock setup', () => {
    const r = createRace(raceConfig(6003, 'circuit', 2));
    for (const car of r.cars) expect(JSON.stringify(car.tuning), car.carId).toBe(JSON.stringify(getBaseTuning(car.carId)));
    expect(SETUP_POSITIONS).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('wheel size keeps the tire outer diameter', () => {
  // A ring of tire verts (bead 0.79 .. tread 1.0) and wheel verts inside, in wheel space (axle = X).
  const ring = (r: number, x: number, n = 16) => Array.from({ length: n }, (_, i) => [x, r * Math.cos((i / n) * Math.PI * 2), r * Math.sin((i / n) * Math.PI * 2)]).flat();
  const tire = [...ring(0.792, 0.4), ...ring(0.88, 0.43), ...ring(1, 0.4), ...ring(1, -0.4), ...ring(0.792, -0.4)];
  const wheel = [...ring(0.2, 0.3), ...ring(0.55, 0.2), ...ring(0.792, 0.42)];
  const radii = (a: number[]) => a.filter((_, i) => i % 3 === 1).map((y, k) => Math.hypot(y, a[k * 3 + 2]));
  const profile = detectProfile(radii(tire), radii(wheel));
  const remapped = (a: number[], size: number) => {
    const out = new Float32Array(a.length);
    remapWheel(a, null, out, null, profile, size);
    return Array.from(out);
  };

  it('finds the bead where the tire meets the wheel', () => {
    expect(profile.outer).toBeCloseTo(1, 5);
    expect(profile.bead).toBeCloseTo(0.792, 3);
    // Closed cylinder tires (Proto RS, placeholder) fall back to the wheel's edge.
    expect(detectProfile([0, 1, 1, 1], [0.7, 0.69, 0.14]).bead).toBeCloseTo(0.7, 5);
  });

  it('grows the wheel, thins the sidewall, never moves the tread or the width', () => {
    for (const size of [0.85, 1, 1.12, 1.25]) {
      const t = remapped(tire, size);
      const r = remapped(wheel, size);
      expect(Math.max(...radii(t))).toBeCloseTo(1, 5);
      // Wheel edge and tire bead stay together.
      const bead = beadForSize(profile, size);
      expect(Math.max(...radii(r))).toBeCloseTo(bead, 5);
      expect(Math.min(...radii(t))).toBeCloseTo(bead, 5);
      expect(bead).toBeLessThanOrEqual(MAX_BEAD + 1e-9);
      // Axial coordinates untouched.
      expect(t.filter((_, i) => i % 3 === 0)).toEqual(tire.filter((_, i) => i % 3 === 0).map((x) => Math.fround(x)));
    }
    expect(beadForSize(profile, 1)).toBeCloseTo(profile.bead, 9);
    expect(beadForSize(profile, 1.25)).toBeGreaterThan(beadForSize(profile, 1.1));
    expect(beadForSize(profile, 0.85)).toBeLessThan(profile.bead);
    // The garage's whole inch wheel size slider inverts the size curve on both sides of stock.
    for (const size of [0.85, 0.93, 1, 1.07, 1.25]) expect(sizeForBead(profile, beadForSize(profile, size))).toBeCloseTo(size, 9);
    expect(sizeForBead(profile, 0)).toBe(0.85);
    expect(sizeForBead(profile, 2)).toBe(1.25);
  });

  it('keeps normals unit length and pointing the same way at size 1', () => {
    const pos = [0, 0.9, 0, 0.1, 0, 0.5];
    const nrm = [0, 1, 0, 1, 0, 0];
    const p = new Float32Array(6);
    const n = new Float32Array(6);
    remapWheel(pos, nrm, p, n, profile, 1);
    expect(Array.from(n)).toEqual(nrm);
    remapWheel(pos, nrm, p, n, profile, 1.25);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
    expect(n[1]).toBeGreaterThan(0.99);
  });
});

describe('garage free rev model', () => {
  it('revs toward the redline, bounces on the limiter and settles back to idle', () => {
    const m = new RevModel({ idle: 900, redline: 7600 });
    const dt = 1 / 60;
    let peak = 0;
    let cuts = 0;
    let rocked = 0;
    for (let i = 0; i < 180; i++) {
      m.step(dt, 1);
      peak = Math.max(peak, m.rpm);
      if (m.limiting) cuts++;
      rocked = Math.max(rocked, Math.abs(m.roll));
    }
    expect(peak).toBeGreaterThan(7400);
    expect(peak).toBeLessThan(7900);
    expect(cuts).toBeGreaterThan(5);
    expect(rocked).toBeGreaterThan(0.01);
    expect(rocked).toBeLessThan(0.08);
    let low = Infinity;
    for (let i = 0; i < 240; i++) {
      m.step(dt, 0);
      low = Math.min(low, m.rpm);
    }
    // A little dip under idle, then back on it.
    expect(low).toBeLessThan(900);
    expect(low).toBeGreaterThan(650);
    expect(Math.abs(m.rpm - 900)).toBeLessThan(30);
  });

  it('a blip script rocks the body and returns to rest', () => {
    const m = new RevModel({ idle: 900, redline: 7200 });
    const b = new BlipScript();
    b.start();
    let rocked = 0;
    for (let i = 0; i < 60 * 6; i++) {
      m.step(1 / 60, b.step(1 / 60));
      rocked = Math.max(rocked, Math.abs(m.roll));
    }
    expect(rocked).toBeGreaterThan(0.01);
    expect(Math.abs(m.roll)).toBeLessThan(0.002);
    expect(b.active).toBe(false);
  });
});
