import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { planRoads } from '../src/city/world';
import { eventOffer } from '../src/city/events';

/**
 * How often each special district kind turns up over a sweep of seeds. The multi-storey car park and the
 * bluff are gated by geometry (a site on a route, an El with room), the roundabout and tunnel counts have
 * sit-out chances; the odds should keep cities from all looking alike, so a change that quietly makes
 * one of them rare (or constant) fails here.
 */
const SEEDS = 80;

const rng = new Rng(777);
const seeds = Array.from({ length: SEEDS }, () => rng.int(0, 0x7fffffff));
const plans = seeds.map((seed) => {
  const plan = planRoads(seed);
  const count = (kind: string) => plan.districts.areas.filter((a) => a.kind === kind).length;
  return { seed, plan, carPark: count('carPark'), bluff: count('bluff'), roundabout: count('roundabout'), tunnel: count('tunnel') };
});
const share = (pred: (p: (typeof plans)[number]) => boolean) => plans.filter(pred).length / SEEDS;

describe('district odds', () => {
  it('car parks turn up on a good share of seeds', () => {
    expect(share((p) => p.carPark > 0)).toBeGreaterThanOrEqual(0.08);
  });

  it('bluffs turn up on a good share of seeds', () => {
    expect(share((p) => p.bluff > 0)).toBeGreaterThanOrEqual(0.3);
  });

  it('roundabouts: one on some seeds, never more than four, and a single one cannot draw Ring Rush', () => {
    expect(share((p) => p.roundabout === 1)).toBeGreaterThanOrEqual(0.1);
    for (const p of plans) {
      expect(p.roundabout).toBeLessThanOrEqual(4);
      if (p.roundabout < 2) expect(eventOffer(p.plan.graph, p.plan.districts.areas)).not.toContain('ringRush');
    }
  });

  it('tunnels: none on some seeds', () => {
    expect(share((p) => p.tunnel === 0)).toBeGreaterThanOrEqual(0.1);
  });

  it('plans the same districts twice', () => {
    for (const p of plans.slice(0, 4)) {
      const again = planRoads(p.seed);
      expect(JSON.stringify(again.districts.areas)).toBe(JSON.stringify(p.plan.districts.areas));
    }
  });
});
