import { describe, expect, it } from 'vitest';
import { renderImpact, SFX_BANKS } from '../src/audio/sfxRecipes';

describe('synthesized impact sounds', () => {
  it('every bank renders finite, normalized, non silent audio', () => {
    for (const b of SFX_BANKS) {
      const d = renderImpact(b, 22050);
      let peak = 0;
      let energy = 0;
      for (const x of d) {
        expect(Number.isFinite(x)).toBe(true);
        peak = Math.max(peak, Math.abs(x));
        energy += x * x;
      }
      expect(peak).toBeLessThanOrEqual(0.96);
      expect(peak).toBeGreaterThan(0.5);
      expect(Math.sqrt(energy / d.length)).toBeGreaterThan(0.01);
    }
  });
});
