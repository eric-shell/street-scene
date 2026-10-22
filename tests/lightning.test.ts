import { describe, expect, it } from 'vitest';
import { LIGHTNING, LightningSchedule, strikeLevel } from '../src/render/sky/lightning';

describe('lightning', () => {
  it('strikes on a schedule that is a pure function of the seed, every 15 to 40 s', () => {
    for (const seed of [1, 42, 20261020]) {
      const a = new LightningSchedule(seed);
      const b = new LightningSchedule(seed);
      // Asking in a different order (as a replay seeking would) changes nothing.
      expect(JSON.stringify(b.get(30))).toBe(JSON.stringify(a.get(30)));
      for (let i = 0; i <= 30; i++) expect(JSON.stringify(a.get(i))).toBe(JSON.stringify(b.get(i)));
      const first = a.get(0);
      expect(first.t).toBeGreaterThanOrEqual(LIGHTNING.first[0]);
      expect(first.t).toBeLessThan(LIGHTNING.first[1]);
      for (let i = 1; i <= 30; i++) {
        const gap = a.get(i).t - a.get(i - 1).t;
        expect(gap).toBeGreaterThanOrEqual(LIGHTNING.gap[0]);
        expect(gap).toBeLessThan(LIGHTNING.gap[1]);
      }
      expect(a.indexAt(0)).toBe(-1);
      expect(a.indexAt(a.get(5).t)).toBe(5);
      expect(a.indexAt(a.get(5).t - 0.001)).toBe(4);
    }
    expect(JSON.stringify(new LightningSchedule(1).get(3))).not.toBe(JSON.stringify(new LightningSchedule(2).get(3)));
  });

  it('flashes softly, at most three times in any second, and dies away before the next strike', () => {
    const s = new LightningSchedule(7);
    let inCloud = 0;
    const n = 200;
    for (let i = 0; i < n; i++) {
      const st = s.get(i);
      if (st.inCloud) inCloud++;
      expect(st.strokes.length).toBeLessThanOrEqual(3);
      expect(st.distance / LIGHTNING.sound).toBeGreaterThan(2);
      // Sample the envelope at 240 Hz: never above the strike's power, zero before, gone 4 s later.
      const level = { flash: 0, bolt: 0 };
      expect(strikeLevel(st, st.t - 0.01, level).flash).toBe(0);
      const peaks: number[] = [];
      let prev = 0;
      let rising = false;
      for (let k = 0; k < 240 * 3; k++) {
        const t = st.t + k / 240;
        strikeLevel(st, t, level);
        expect(level.flash).toBeLessThanOrEqual(st.power + 1e-9);
        expect(level.bolt).toBeLessThanOrEqual(level.flash + 1e-9);
        if (level.flash > prev) rising = true;
        else if (rising && level.flash < prev) {
          peaks.push(t);
          rising = false;
        }
        prev = level.flash;
      }
      for (let p = 0; p < peaks.length; p++) expect(peaks.filter((q) => q >= peaks[p] && q < peaks[p] + 1).length).toBeLessThanOrEqual(3);
      expect(strikeLevel(st, st.t + 4, level).flash).toBeLessThan(0.002);
    }
    // About a third of the strikes stay inside the cloud.
    expect(inCloud / n).toBeGreaterThan(LIGHTNING.inCloud - 0.12);
    expect(inCloud / n).toBeLessThan(LIGHTNING.inCloud + 0.12);
  });
});
