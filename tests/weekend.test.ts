import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { planRoads } from '../src/city/world';
import { WEEKEND_FEATURES, weekendOf, weekendSeeds } from '../src/city/weekend';
import type { WeekendKind } from '../src/city/weekend';
import { railYardModule } from '../src/city/districts/railYard';
import { routeFrontageSites } from '../src/city/districts/weekendSites';
import type { FrontageSite } from '../src/city/districts/weekendSites';

const KINDS = WEEKEND_FEATURES.map((f) => f.kind) as string[];

describe('weekendOf', () => {
  it('reads Saturdays and Sundays off the seed digits', () => {
    expect(weekendOf(20261031)).toMatchObject({ day: 'sat', year: 2026, month: 10, dayOfMonth: 31 });
    expect(weekendOf(20261101)).toMatchObject({ day: 'sun', year: 2026, month: 11, dayOfMonth: 1 });
    // Consecutive weekend days are consecutive ordinals.
    expect(weekendOf(20261101)!.ordinal).toBe(weekendOf(20261031)!.ordinal + 1);
  });

  it('is null for weekdays, impossible dates, non-dates and years out of range', () => {
    expect(weekendOf(20261102)).toBeNull(); // Monday
    expect(weekendOf(20261131)).toBeNull(); // no 31st of November
    expect(weekendOf(20260229)).toBeNull(); // 2026 is no leap year
    expect(weekendOf(20280229)).toBeNull(); // a real date, a Tuesday
    expect(weekendOf(12345678)).toBeNull(); // year 1234
    expect(weekendOf(99999999)).toBeNull();
    expect(weekendOf(20261)).toBeNull(); // not eight digits
    expect(weekendOf(20241228)).toBeNull(); // a Saturday before 2025
  });

  it('indexes the rotation right before the reference Saturday (negative ordinals)', () => {
    const p = weekendOf(20251004)!; // a Saturday
    expect(p.day).toBe('sat');
    expect(p.ordinal).toBeLessThan(0);
    const n = WEEKEND_FEATURES.length;
    expect(p.kind).toBe(WEEKEND_FEATURES[((p.ordinal % n) + n) % n].kind);
    // 2026-01-03 is ordinal 0, the first feature.
    expect(weekendOf(20260103)).toMatchObject({ ordinal: 0, kind: WEEKEND_FEATURES[0].kind });
  });

  it('walks the feature list in order over consecutive weekend days', () => {
    const seeds = weekendSeeds({ year: 2026, month: 1, dayOfMonth: 3 }, 12);
    expect(seeds).toHaveLength(12);
    seeds.forEach((seed, i) => {
      const p = weekendOf(seed)!;
      expect(p.ordinal).toBe(i);
      expect(p.kind).toBe(WEEKEND_FEATURES[i % WEEKEND_FEATURES.length].kind);
      expect(p.day).toBe(i % 2 === 0 ? 'sat' : 'sun');
    });
  });
});

describe('weekend plumbing', () => {
  it('plans no weekend special on seeds that are not weekend dates', () => {
    const rng = new Rng(777);
    for (let i = 0; i < 30; i++) {
      let seed = rng.int(0, 0x7fffffff);
      while (weekendOf(seed)) seed = rng.int(0, 0x7fffffff);
      const plan = planRoads(seed);
      expect(plan.districts.areas.some((a) => KINDS.includes(a.kind))).toBe(false);
      expect(plan.event.special).toBeUndefined();
    }
  });

  it('plans the picked special on the next weekend seeds, and the special promised is the area built', () => {
    for (const seed of weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 6)) {
      const plan = planRoads(seed);
      const pick = weekendOf(seed)!;
      expect(pick).not.toBeNull();
      const areas = plan.districts.areas.filter((a) => KINDS.includes(a.kind));
      // At most one special per city, always the picked kind; a seed whose site does not fit promises nothing.
      expect(areas.length).toBeLessThanOrEqual(1);
      for (const a of areas) expect(a.kind).toBe(pick.kind);
      if (areas.length) expect(plan.event.special?.kind).toBe(pick.kind);
      else expect(plan.event.special).toBeUndefined();
    }
  });

  it('routeFrontageSites finds ordered candidates along the routes on weekend seeds', () => {
    // The stub's plan is the one place a PlanContext with the routes exists: wrap it for the run.
    const original = railYardModule.plan;
    const found = new Map<number, { one: FrontageSite[]; two: FrontageSite[]; kind: WeekendKind | undefined }>();
    try {
      railYardModule.plan = (ctx) => {
        found.set(ctx.seed, {
          one: routeFrontageSites(ctx, { minFrontage: 60, blocks: 1 }),
          two: routeFrontageSites(ctx, { minFrontage: 60, blocks: 2 }),
          kind: ctx.weekend?.kind,
        });
      };
      // Every seed runs the module, but only a rail yard seed carries the pick; the finder does not care.
      const seeds = weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 8);
      for (const seed of seeds) planRoads(seed);
      expect(found.size).toBe(seeds.length);
      let withSites = 0;
      for (const { one, two } of found.values()) {
        if (one.length) withSites++;
        // Best first: frontage on every route, then the longer frontage.
        for (let i = 1; i < one.length; i++) {
          const both = (s: FrontageSite) => (s.routes === 3 ? 1 : 0);
          expect(both(one[i - 1]) >= both(one[i])).toBe(true);
          if (both(one[i - 1]) === both(one[i])) expect(one[i - 1].frontage).toBeGreaterThanOrEqual(one[i].frontage);
        }
        for (const s of one) {
          expect(s.frontage).toBeGreaterThanOrEqual(60);
          expect(s.edges.length).toBeGreaterThan(0);
          expect(s.face.outer).toBe(false);
        }
        // Two block sites are a subset of the one block sites and carry a neighbour that is not the block itself.
        const ids = new Set(one.map((s) => s.face.id));
        for (const s of two) {
          expect(ids.has(s.face.id)).toBe(true);
          expect(s.neighbours.length).toBeGreaterThan(0);
          for (const n of s.neighbours) expect(n.face.id).not.toBe(s.face.id);
        }
      }
      expect(withSites).toBeGreaterThanOrEqual(Math.ceil(seeds.length / 2));
    } finally {
      railYardModule.plan = original;
    }
  });
});
