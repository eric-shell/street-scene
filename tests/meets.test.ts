import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { planMeets } from '../src/render/meetPlan';
import type { RailWall } from '../src/city/route';
import { RAIL } from '../src/sim/rails';
import { Rng } from '../src/sim/prng';
import { distToSegment } from '../src/sim/math';
import { CITY } from '../src/city/config';

const cars = [
  { length: 4.45, width: 2, variants: 3 },
  { length: 3.95, width: 1.61, variants: 3 },
];
const opts = { cars, peopleDensity: 1, peopleDepth: 9, carRows: 5 };

/** Distance behind the nearest piece of the zone's barrier (m, along -normal). */
function depthBehind(chain: RailWall[], x: number, z: number): number {
  let best = Infinity;
  let depth = 0;
  for (const w of chain) {
    const dx = w.bx - w.ax;
    const dz = w.bz - w.az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - w.ax) * dx + (z - w.az) * dz) / l2));
    const px = w.ax + dx * t;
    const pz = w.az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      depth = -((x - px) * w.nx + (z - pz) * w.nz);
    }
  }
  return depth;
}

describe('street meets', () => {
  it('pack a crowd against every cyan barrier, thinning back among parked cars, off the course', () => {
    const rng = new Rng(21);
    let people = 0;
    let carsTotal = 0;
    const byDepth = { front: 0, back: 0 };
    const carRows = [0, 0];
    for (let i = 0; i < 6; i++) {
      const w = createWorld(rng.int(0, 0x7fffffff), i % 2 ? 'sprint' : 'circuit');
      const plan = planMeets(w, opts);
      // Deterministic for a world.
      expect(JSON.stringify(planMeets(w, opts))).toBe(JSON.stringify(plan));
      // Every closure across a street with room behind it gets a meet (a closed alley is too narrow and
      // cluttered for one, a stub of a street too short).
      const meetRails = new Set(plan.zones.filter((z) => z.closure).map((z) => z.rail));
      for (const g of w.barrierGroups) {
        const e = w.graph.edges[g.edges[0]];
        if (e.width < CITY.width.street || e.length < 60) continue;
        expect(meetRails.has((g.walls[0] as RailWall).group)).toBe(true);
      }
      for (const zone of plan.zones) {
        const chain = w.walls.filter((x) => x.kind === 'rail' && (x as RailWall).group === zone.rail) as RailWall[];
        for (const p of zone.people) {
          people++;
          const d = depthBehind(chain, p.x, p.z);
          // Behind the barrier, clear of how far a hit can shove it, never on the course.
          expect(d).toBeGreaterThan(RAIL.maxOffset + 0.2);
          // (Past the ends of a sprint the road carries on behind its end closures: that is off the course too.)
          const rp = w.routeProgress(p.x, p.z);
          const beyondEnds = !w.route.closed && (rp.s < 0.5 || rp.s > w.route.length - 0.5);
          if (!beyondEnds) expect(Math.abs(rp.lateral)).toBeGreaterThan(w.route.segWidth[rp.seg] / 2);
          // Never in one of the route's shortcuts (alley, sidewalks or mouths).
          for (const sc of w.route.shortcuts) expect(distToSegment(p.x, p.z, sc.ax, sc.az, sc.bx, sc.bz)).toBeGreaterThan(w.graph.edges[sc.edge].width / 2 + w.graph.edges[sc.edge].sidewalk);
          if (d < RAIL.maxOffset + 2.5) byDepth.front++;
          else if (d > RAIL.maxOffset + 5) byDepth.back++;
        }
        for (const ci of zone.cars) {
          carsTotal++;
          const c = plan.cars[ci];
          const d = depthBehind(chain, c.x, c.z);
          // Behind the packed crowd, and never parked in a shortcut.
          expect(d).toBeGreaterThan(RAIL.maxOffset + 2.4);
          for (const sc of w.route.shortcuts) expect(distToSegment(c.x, c.z, sc.ax, sc.az, sc.bx, sc.bz)).toBeGreaterThan(w.graph.edges[sc.edge].width / 2 + w.graph.edges[sc.edge].sidewalk);
          if (d < RAIL.maxOffset + 8) carRows[0]++;
          else if (d > RAIL.maxOffset + 14) carRows[1]++;
        }
      }
    }
    expect(people).toBeGreaterThan(2000);
    expect(carsTotal).toBeGreaterThan(300);
    // Dense at the barrier, thin at the back; cars too (the front row against the three back rows, per row).
    expect(byDepth.front).toBeGreaterThan(byDepth.back * 2);
    expect(carRows[0]).toBeGreaterThan(carRows[1] / 3);
  });

  it('are empty in an open world', () => {
    const w = createWorld(7, 'circuit', undefined, { openWorld: true });
    const plan = planMeets(w, opts);
    expect(plan.zones.length).toBe(0);
    expect(plan.cars.length).toBe(0);
  });
});
