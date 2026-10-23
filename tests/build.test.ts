import { describe, expect, it } from 'vitest';
import { applyBuild, stockPerformance, PerformanceBuild } from '../src/sim/build';
import { defaultBuild, validateBuild } from '../src/shared/carBuild';
import { DEFAULT_CAR_ID, getBaseTuning, PERFORMANCE_CATEGORIES } from '../src/sim/tuning';
import { measureStats } from '../src/sim/stats';
import { decodeShareCode, encodeShareCode } from '../src/garage/storage';
import { validateCatalog } from '../scripts/validateParts';
import { createRace, stepRace } from '../src/sim/race';
import { raceConfig } from './helpers';
import { createAi, autopilotInput } from '../src/sim/ai';
import { MAX_BEAD, beadForSize, detectProfile, remapWheel, sizeForBead } from '../src/render/car/wheelFit';
import { BlipScript, RevModel } from '../src/garage/revModel';

const allTier = (t: 0 | 1 | 2 | 3): PerformanceBuild => {
  const p = stockPerformance();
  for (const c of PERFORMANCE_CATEGORIES) p[c] = t;
  return p;
};

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
      performance: { engine: 7, turbo: -2, tires: 1.6 },
    });
    expect(b.carId).toBe('protoHatch');
    expect(b.name.length).toBeLessThanOrEqual(24);
    expect(b.name).not.toContain('<');
    expect(b.visual.paint.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.visual.paint.finish).toBe('metallic');
    // Legacy single wheel size, camber and offset migrate onto both axles (clamped).
    expect(b.visual.stance.front.wheelSize).toBe(1.25);
    expect(b.visual.stance.rear.wheelSize).toBe(1.25);
    expect(b.visual.stance.rideHeight).toBe(-0.08);
    expect(b.visual.stance.front.camber).toBe(-10);
    expect(b.visual.stance.rear.camber).toBe(0);
    expect(b.visual.stance.front.offset).toBe(0);
    expect(b.visual.decals.length).toBe(8);
    expect(b.visual.decals[0].pos[0]).toBe(4);
    expect(b.visual.decals[0].scale).toBe(3);
    // carId was invalid, so per-car parts were dropped
    expect(b.visual.parts.spoiler).toBeUndefined();
    expect(b.visual.parts.hood).toBeUndefined();
    expect(b.performance.engine).toBe(3);
    expect(b.performance.turbo).toBe(0);
    expect(b.performance.tires).toBe(2);
  });

  it('share codes round trip to the same build', async () => {
    const b = defaultBuild('protoHatch');
    b.name = 'Midnight Club';
    b.visual.paint = { color: '#19e6ff', finish: 'pearl' };
    b.visual.parts = { spoiler: 'protoHatch_spoiler_1', frontBumper: 'protoHatch_frontBumper_kurogane', wheels: 'wheel_yari' };
    b.visual.decals.push({ shape: 'number', color: '#ff3df2', pos: [0.9, 0.6, 0.2], normal: [1, 0, 0], rotation: 12, scale: 0.7, mirror: true, text: '42' });
    b.visual.wheels = { color: '#ffcc00', rearColor: '#1a1b1f', rearPart: 'wheel_kumo', tire: 'standard', rearTire: 'stretched' };
    b.visual.underglow = { enabled: true, color: '#ff00aa', color2: '#00ffaa', pattern: 'chase', brightness: 1.4, speed: 2, size: 1.2 };
    b.visual.stance = { rideHeight: -0.045, front: { camber: -3.5, offset: 0.015, wheelSize: 1.05 }, rear: { camber: -7, offset: 0.05, wheelSize: 1.2 } };
    b.performance.engine = 3;
    b.performance.nitrous = 2;
    const code = await encodeShareCode(b);
    expect(code.length).toBeLessThan(700);
    const back = await decodeShareCode(code);
    expect(back).toEqual(validateBuild(b));
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
    expect(b.visual.stance.front).toEqual({ camber: -4, offset: 0.02, wheelSize: 1.1 });
    expect(b.visual.stance.rear).toEqual({ camber: -6, offset: 0.02, wheelSize: 1.1 });
    // A legacy single wheel color paints both axles; a rear color of its own is kept.
    expect(b.visual.wheels).toMatchObject({ color: '#ffffff', rearColor: '#ffffff' });
    expect(validateBuild({ visual: { wheels: { color: '#ffffff', rearColor: '#1a1b1f' } } }).visual.wheels).toMatchObject({ color: '#ffffff', rearColor: '#1a1b1f' });
    // Builds from before per axle wheels and tires wear the front's wheel and the standard tire all round.
    expect(b.visual.wheels).toMatchObject({ rearPart: null, tire: 'standard', rearTire: 'standard' });
    // A rear tire of its own is kept; a missing one follows the front, an unknown one falls back.
    expect(validateBuild({ visual: { wheels: { tire: 'stretched' } } }).visual.wheels).toMatchObject({ tire: 'stretched', rearTire: 'stretched' });
    expect(validateBuild({ visual: { wheels: { tire: 'stretched', rearTire: 'bald', rearPart: 'wheel_protoHatch_1' } } }).visual.wheels).toMatchObject({ tire: 'stretched', rearTire: 'stretched', rearPart: 'wheel_kaze' });
    // The first set's shapes: both stretches are the stretched tire, the meaty one standard.
    expect(validateBuild({ visual: { wheels: { tire: 'aggressiveStretch', rearTire: 'meaty' } } }).visual.wheels).toMatchObject({ tire: 'stretched', rearTire: 'standard' });
    // New per axle values win over legacy ones and are clamped independently.
    const n = validateBuild({ visual: { stance: { camberFront: -4, front: { camber: -2, offset: 0.5, wheelSize: 0.9 }, rear: { wheelSize: 2 } } } });
    expect(n.visual.stance.front).toEqual({ camber: -2, offset: 0.08, wheelSize: 0.9 });
    expect(n.visual.stance.rear).toEqual({ camber: 0, offset: 0, wheelSize: 1.25 });
  });

  it('old share codes (single axle stance) still load', async () => {
    // Encoded by the pre per axle format: wheels.size 1.15, camber -6 / -8.5, offset 0.04.
    const legacy =
      'zPZDdToQwEIVfxRxvB9J2gazzEl6YeGPMplta2Eh2CUVRCe9uZlBvvibzc87prHgGW8IVjMehvXua_TVEEAIYXbAVCB_gFaMXhhsY9_YhNimBkC5gjNFPAzbCHLRZ28Z6EMZZNpYejKWPcTjlpjo5GZTaivwNtqWt6Vc1pRCMkX4bwC-vhKwKUw8uTGkOhJDARUMIE7g4ljXhlsCmNJXYX2S6fZNC_a9qjT06VX3vpB-v4OSHHP8GjIm1fia4PcWhTU7iy0nyHH37BcJ50jPl0e2vZN8I_SA70SenEvOwS1jvvFiO6gh2hBlsCJ_KTjkps_KsXJQ3sNm2Hw';
    const b = await decodeShareCode(legacy);
    expect(b).not.toBeNull();
    expect(b!.name).toBe('Old Stance');
    expect(b!.visual.stance.rideHeight).toBe(-0.03);
    expect(b!.visual.stance.front).toEqual({ camber: -6, offset: 0.04, wheelSize: 1.15 });
    expect(b!.visual.stance.rear).toEqual({ camber: -8.5, offset: 0.04, wheelSize: 1.15 });
    expect(b!.visual.wheels).toEqual({ color: '#ffcc00', rearColor: '#ffcc00', rearPart: null, tire: 'standard', rearTire: 'standard' });
    // Saved before the cars were renamed: the wheel id follows the rename.
    expect(b!.visual.parts.wheels).toBe('wheel_yari');
    expect(b!.performance.engine).toBe(2);
  });

  it('visual choices never change the tuning the sim uses', () => {
    const a = defaultBuild('protoHatch');
    const b = defaultBuild('protoHatch');
    b.visual.parts = { spoiler: 'protoHatch_spoiler_1', rearBumper: 'protoHatch_rearBumper_hayate', sideSkirts: 'protoHatch_sideSkirts_kurogane' };
    b.visual.stance.rideHeight = -0.08;
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

describe('performance upgrades', () => {
  it('measurably improve acceleration and top speed', () => {
    const stock = measureStats(applyBuild(getBaseTuning('proto'), stockPerformance()));
    const street = measureStats(applyBuild(getBaseTuning('proto'), allTier(1)));
    const extreme = measureStats(applyBuild(getBaseTuning('proto'), allTier(3)));
    expect(street.zeroTo100).toBeLessThan(stock.zeroTo100);
    expect(extreme.zeroTo100).toBeLessThan(street.zeroTo100 - 0.2);
    expect(street.topSpeed).toBeGreaterThan(stock.topSpeed);
    expect(extreme.topSpeed).toBeGreaterThan(stock.topSpeed + 15);
  });

  it('an upgraded car covers more ground in the same race time', () => {
    // A minute of racing: long enough to include straights, where the upgrade tells (the first few
    // hundred meters of a sprint can be corner after corner, where the autopilot's cornering speed rules).
    const run = (perf: PerformanceBuild) => {
      const r = createRace(raceConfig(5150, 'sprint', 0, perf));
      const pilot = createAi(1);
      for (let i = 0; i < 60 * 60; i++) stepRace(r, autopilotInput(r, r.cars[0], pilot));
      return r.cars[0].dist;
    };
    expect(run(allTier(3))).toBeGreaterThan(run(stockPerformance()) + 50);
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
