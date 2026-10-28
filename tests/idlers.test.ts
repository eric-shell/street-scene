import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { planIdlers } from '../src/city/people/idleSpots';
import { BACK, FWD } from '../src/city/people/placer';
import { CANON } from '../src/city/people/people';

describe('idle people', () => {
  it('are placed deterministically, under the cap, off the route and the gate stands, beside their props', () => {
    let total = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const w = createWorld(seed, seed % 2 ? 'circuit' : 'sprint');
      const route = w.route;
      // Stand-ins for the start and finish gates: the route's two ends.
      const gates = [0, route.length].map((s) => {
        const p = route.points[s === 0 ? 0 : route.points.length - 1];
        return { s, position: { x: p.x, z: p.z } };
      });
      // One canonical density at every graphics quality (the sim collides with these people).
      for (const tier of [CANON.idle]) {
        const opts = { density: tier.density, cap: tier.cap, avoid: { gates } };
        const plan = planIdlers(w, opts);
        expect(JSON.stringify(planIdlers(w, opts))).toBe(JSON.stringify(plan));
        expect(plan.people.length).toBeLessThanOrEqual(tier.cap);
        for (const p of plan.people) {
          const rp = w.routeProgress(p.x, p.z);
          expect(Math.abs(rp.lateral)).toBeGreaterThanOrEqual(route.segWidth[rp.seg] / 2 + 1);
          for (const g of gates) {
            const d = rp.s - g.s;
            const ds = route.closed ? ((((d + route.length / 2) % route.length) + route.length) % route.length) - route.length / 2 : d;
            expect(ds < -BACK || ds > FWD).toBe(true);
          }
          if (p.anchorProp >= 0) {
            const prop = w.props[p.anchorProp];
            expect(Math.hypot(p.x - prop.x, p.z - prop.z)).toBeLessThan(1.6);
            expect(w.coveredProps).not.toContain(p.anchorProp);
          }
        }
        total += plan.people.length;
      }
    }
    expect(total).toBeGreaterThan(0);
  });
});
