import { describe, expect, it } from 'vitest';
import { FIREWORKS, fireworksPlan } from '../src/render/sky/fireworks';
import { RoarSchedule, STADIUM, stadiumPlan, stadiumSpot } from '../src/render/sky/stadium';

const SEEDS = 2000;

describe('fireworks', () => {
  it('is a pure function of the seed, on about 30% of seeds', () => {
    let have = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = fireworksPlan(seed);
      expect(JSON.stringify(fireworksPlan(seed))).toBe(JSON.stringify(p));
      if (p) have++;
    }
    expect(have / SEEDS).toBeGreaterThan(0.26);
    expect(have / SEEDS).toBeLessThan(0.34);
  });

  it('starts 20 to 90 s in, runs 2 to 4 minutes at 4 to 12 s a shell, and ends with a salvo', () => {
    let checked = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const p = fireworksPlan(seed);
      if (!p) continue;
      checked++;
      const first = p.shells[0];
      expect(first.launch).toBeGreaterThanOrEqual(FIREWORKS.start[0]);
      expect(first.launch).toBeLessThan(FIREWORKS.start[1] + 1e-9);
      expect(p.end - p.start).toBeGreaterThan(FIREWORKS.duration[0] - 15);
      expect(p.end - p.start).toBeLessThan(FIREWORKS.duration[1] + 15);
      const body = p.shells.slice(0, p.shells.length - FIREWORKS.finale);
      for (let i = 1; i < body.length; i++) {
        const gap = body[i].launch - body[i - 1].launch;
        expect(gap).toBeGreaterThanOrEqual(FIREWORKS.gap[0] - 1e-9);
        expect(gap).toBeLessThan(FIREWORKS.gap[1] + 1e-9);
      }
      for (const s of p.shells) {
        expect(s.count).toBeGreaterThanOrEqual(FIREWORKS.count[0]);
        expect(s.count).toBeLessThanOrEqual(FIREWORKS.count[1]);
        expect(s.burst).toBeCloseTo(s.launch + s.rise, 9);
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('never bursts more than three times in a second (the flash cap)', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const p = fireworksPlan(seed);
      if (!p) continue;
      const t = p.shells.map((s) => s.burst);
      for (let i = 0; i + 3 < t.length; i++) expect(t[i + 3] - t[i]).toBeGreaterThan(1);
    }
  });
});

describe('stadium', () => {
  it('stands on about 25% of seeds, a pure function of the seed, apart from the fireworks', () => {
    let have = 0;
    let both = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const p = stadiumPlan(seed);
      expect(JSON.stringify(stadiumPlan(seed))).toBe(JSON.stringify(p));
      if (p) have++;
      if (p && fireworksPlan(seed)) both++;
    }
    expect(have / SEEDS).toBeGreaterThan(0.21);
    expect(have / SEEDS).toBeLessThan(0.29);
    // Independent streams: the overlap is the product of the shares (about 7.5%).
    expect(both / SEEDS).toBeGreaterThan(0.04);
    expect(both / SEEDS).toBeLessThan(0.11);
  });

  it('moves to the lowest stretch of the near ridge nearest its wish', () => {
    const plan = stadiumPlan(Array.from({ length: 200 }, (_, i) => i + 1).find((s) => stadiumPlan(s))!)!;
    const flat = Array.from({ length: 180 }, () => 100);
    flat[40] = flat[41] = flat[39] = flat[38] = flat[42] = flat[43] = flat[37] = flat[36] = flat[44] = flat[45] = flat[35] = flat[34] = flat[46] = 5;
    const spot = stadiumSpot({ ...plan, azimuth: (100 / 180) * Math.PI * 2 }, flat);
    expect(Math.abs(spot.azimuth - (40 / 180) * Math.PI * 2)).toBeLessThan(0.25);
  });

  it('roars every 40 to 120 s on a schedule of its own', () => {
    const a = new RoarSchedule(5);
    const b = new RoarSchedule(5);
    expect(JSON.stringify(b.get(20))).toBe(JSON.stringify(a.get(20)));
    expect(a.get(0).t).toBeGreaterThanOrEqual(STADIUM.roar.first[0]);
    for (let i = 1; i < 20; i++) {
      const gap = a.get(i).t - a.get(i - 1).t;
      expect(gap).toBeGreaterThanOrEqual(STADIUM.roar.gap[0]);
      expect(gap).toBeLessThan(STADIUM.roar.gap[1]);
    }
    expect(JSON.stringify(new RoarSchedule(6).get(2))).not.toBe(JSON.stringify(a.get(2)));
  });
});
