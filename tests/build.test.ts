import { describe, expect, it } from 'vitest';
import { applyBuild, defaultBuild, stockPerformance, validateBuild, PerformanceBuild } from '../src/sim/build';
import { getBaseTuning, PERFORMANCE_CATEGORIES } from '../src/sim/tuning';
import { measureStats } from '../src/sim/stats';
import { decodeShareCode, encodeShareCode } from '../src/garage/storage';
import { validateCatalog } from '../scripts/validateParts';
import { createRace, stepRace } from '../src/sim/race';
import { raceConfig } from './helpers';
import { createAi, autopilotInput } from '../src/sim/ai';

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
    expect(b.carId).toBe('proto');
    expect(b.name.length).toBeLessThanOrEqual(24);
    expect(b.name).not.toContain('<');
    expect(b.visual.paint.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.visual.paint.finish).toBe('metallic');
    expect(b.visual.wheels.size).toBe(1.25);
    expect(b.visual.stance.rideHeight).toBe(-0.08);
    expect(b.visual.stance.camberFront).toBe(-10);
    expect(b.visual.decals.length).toBe(8);
    expect(b.visual.decals[0].pos[0]).toBe(4);
    expect(b.visual.decals[0].scale).toBe(3);
    expect(b.visual.parts.spoiler).toBe('ok_id');
    expect(b.visual.parts.hood).toBeUndefined();
    expect(b.performance.engine).toBe(3);
    expect(b.performance.turbo).toBe(0);
    expect(b.performance.tires).toBe(2);
  });

  it('share codes round trip to the same build', async () => {
    const b = defaultBuild('gc14');
    b.name = 'Midnight Club';
    b.visual.paint = { color: '#19e6ff', finish: 'pearl' };
    b.visual.parts = { spoiler: 'gc14_spoiler_1', body: 'gc14_body_kit2', wheels: 'wheel_s64_2' };
    b.visual.decals.push({ shape: 'number', color: '#ff3df2', pos: [0.9, 0.6, 0.2], normal: [1, 0, 0], rotation: 12, scale: 0.7, mirror: true, text: '42' });
    b.visual.underglow = { enabled: true, color: '#ff00aa', pattern: 'wave' };
    b.performance.engine = 3;
    b.performance.nitrous = 2;
    const code = await encodeShareCode(b);
    expect(code.length).toBeLessThan(700);
    const back = await decodeShareCode(code);
    expect(back).toEqual(validateBuild(b));
    expect(await decodeShareCode('garbage!!')).toBeNull();
  });

  it('visual choices never change the tuning the sim uses', () => {
    const a = defaultBuild('proto');
    const b = defaultBuild('proto');
    b.visual.parts = { spoiler: 'proto_spoiler_gtwing', frontBumper: 'proto_frontBumper_widemouth' };
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
    const run = (perf: PerformanceBuild) => {
      const r = createRace(raceConfig(5150, 'sprint', 0, perf));
      const pilot = createAi(7, 1);
      for (let i = 0; i < 60 * 30; i++) stepRace(r, autopilotInput(r, r.cars[0], pilot));
      return r.cars[0].dist;
    };
    expect(run(allTier(3))).toBeGreaterThan(run(stockPerformance()) + 50);
  });
});
