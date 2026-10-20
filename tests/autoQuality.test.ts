import { describe, expect, it } from 'vitest';
import { AutoQualityController, guessLevel, MAX_LEVEL, PRESET_LEVEL, QUALITY_LEVELS, DeviceInfo } from '../src/render/autoQuality';
import { QUALITY } from '../src/ui/settings';

/** Drive the controller for `seconds` of frames whose duration depends on the level. */
function run(c: AutoQualityController, seconds: number, dtAt: (level: number, frame: number) => number, active = true): number {
  let changes = 0;
  let t = 0;
  let f = 0;
  while (t < seconds) {
    const before = c.level;
    const dt = dtAt(c.level, f++);
    c.frame(dt, active);
    t += Math.min(dt, 0.1);
    if (c.level !== before) changes++;
  }
  return changes;
}

const desktop: DeviceInfo = { touch: false, coarsePointer: false, dpr: 1, cores: 8, memoryGb: 8, gpu: '', screenW: 1920, screenH: 1080 };

describe('auto quality', () => {
  it('keeps the presets on the ladder', () => {
    for (const q of ['low', 'medium', 'high'] as const) {
      const { tier, ...profile } = QUALITY_LEVELS[PRESET_LEVEL[q]];
      expect(tier).toBe(q);
      expect(profile).toEqual(QUALITY[q]);
    }
  });

  it('guesses from the device', () => {
    expect(guessLevel({ ...desktop, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)' })).toBe(7);
    expect(guessLevel({ ...desktop, gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', cores: 4 })).toBe(1);
    expect(guessLevel({ ...desktop, gpu: 'Google SwiftShader' })).toBe(0);
    const phone: DeviceInfo = { touch: true, coarsePointer: true, dpr: 3, cores: 6, memoryGb: null, gpu: 'Apple GPU', screenW: 390, screenH: 844 };
    expect(guessLevel(phone)).toBeLessThanOrEqual(3);
  });

  it('probes up on headroom, reverts a failed probe and settles without oscillating', () => {
    const c = new AutoQualityController(2);
    // Level 6+ costs 24 ms a frame, the rest hit vsync.
    const changes = run(c, 600, (l) => (l >= 6 ? 0.024 : 1 / 60));
    expect(c.level).toBe(5);
    // 2->5 probes, then a handful of backed off retries of 6 in ten minutes.
    expect(changes).toBeLessThan(14);
  });

  it('steps down on slow frames and stays down', () => {
    const c = new AutoQualityController(MAX_LEVEL);
    // GPU bound: every level down is about 15% cheaper, 30 ms at the top.
    run(c, 300, (l) => 0.03 * Math.pow(0.85, MAX_LEVEL - l));
    expect(c.level).toBeGreaterThanOrEqual(3);
    expect(c.level).toBeLessThanOrEqual(4);
  });

  it('does not sink when lowering quality does not help (CPU bound or throttled)', () => {
    const c = new AutoQualityController(5);
    const changes = run(c, 200, () => 1 / 30);
    expect(c.level).toBeGreaterThanOrEqual(4);
    expect(changes).toBeLessThan(8);
  });

  it('ignores hitches, tab switches and inactive frames', () => {
    const c = new AutoQualityController(4, { ceiling: 4 });
    run(c, 60, (_, f) => (f % 120 === 0 ? 0.2 : f % 600 === 300 ? 2 : 1 / 60));
    expect(c.level).toBe(4);
    run(c, 60, () => 0.05, false);
    expect(c.level).toBe(4);
  });
});
