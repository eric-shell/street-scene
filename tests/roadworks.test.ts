import { describe, expect, it } from 'vitest';
import { createCity } from '../src/city/world';
import type { City } from '../src/city/world';
import { PROP_DEFS } from '../src/city/props';
import { ROADWORKS, ROADWORKS_VARIANTS } from '../src/city/districts/roadworks';
import type { RoadworksVariant } from '../src/city/districts/roadworks';

const SEEDS = Array.from({ length: 60 }, (_, i) => 100 + i * 7);

const zones = (w: City) => w.districts.areas.filter((a) => a.kind === 'roadworks');

/** (s along from node a, v in from the closed curb) of a point on a closure's street. */
function frameOf(w: City, a: { params: Record<string, number> }) {
  const e = w.graph.edges[a.params.edge];
  const A = w.graph.nodes[e.a];
  const B = w.graph.nodes[e.b];
  const len = Math.hypot(B.x - A.x, B.z - A.z);
  const dx = (B.x - A.x) / len;
  const dz = (B.z - A.z) / len;
  const nx = -dz * a.params.side;
  const nz = dx * a.params.side;
  return (x: number, z: number) => ({ s: (x - A.x) * dx + (z - A.z) * dz, v: e.width / 2 - ((x - A.x) * nx + (z - A.z) * nz) });
}

/** What each variant must bring (hint kinds) and must not. */
const PARTS: Record<RoadworksVariant, { has: string[]; not: string[] }> = {
  lane: { has: ['arrowBoard'], not: ['trench', 'roller', 'tarBoard'] },
  trench: { has: ['arrowBoard', 'trench', 'trenchBox', 'spoil', 'pump'], not: ['excavator', 'roller', 'tarBoard'] },
  resurfacing: { has: ['arrowBoard', 'milled', 'roller', 'tarBoard'], not: ['excavator', 'trench', 'pump'] },
};

describe('roadworks variants', () => {
  const cities = SEEDS.map((s) => createCity(s));

  it('all three appear over 60 seeds, roughly by weight, and the pick is deterministic', () => {
    const count: Record<string, number> = {};
    for (const c of cities) for (const a of zones(c)) count[a.variant] = (count[a.variant] ?? 0) + 1;
    const total = Object.values(count).reduce((x, y) => x + y, 0);
    const wsum = ROADWORKS_VARIANTS.reduce((x, v) => x + ROADWORKS.variants[v], 0);
    for (const v of ROADWORKS_VARIANTS) {
      expect(count[v] ?? 0, v).toBeGreaterThan(0);
      expect(Math.abs((count[v] ?? 0) / total - ROADWORKS.variants[v] / wsum), v).toBeLessThan(0.12);
    }
    for (const s of [SEEDS[0], SEEDS[17]]) {
      const again = createCity(s);
      const c = cities[SEEDS.indexOf(s)];
      expect(JSON.stringify(zones(again).map((a) => [a.variant, again.districts.builds[a.id]]))).toBe(JSON.stringify(zones(c).map((a) => [a.variant, c.districts.builds[a.id]])));
    }
  });

  it('each variant builds its own parts, with the closure walls and props inside the closure and off the open lanes', () => {
    for (const c of cities) {
      for (const a of zones(c)) {
        const P = a.params;
        const v = a.variant as RoadworksVariant;
        const kinds = new Set(c.districts.builds[a.id].hints.map((h) => h.kind));
        for (const k of PARTS[v].has) expect(kinds.has(k), `${v} has ${k}`).toBe(true);
        for (const k of PARTS[v].not) expect(kinds.has(k), `${v} lacks ${k}`).toBe(false);
        const at = frameOf(c, a);
        for (const p of c.blocks.props.filter((q) => q.area === a.id)) {
          const f = at(p.x, p.z);
          expect(f.v + p.radius, p.kind).toBeLessThanOrEqual(P.close + ROADWORKS.barrierReach + 1e-6);
          expect(f.s).toBeGreaterThan(P.sA - P.taper - 1);
          expect(f.s).toBeLessThan(P.sB + P.taper + 1);
          expect(PROP_DEFS[p.kind].breakSpeed).toBeLessThanOrEqual(1);
        }
        const walls = c.blocks.walls.filter((w) => w.look === 'roadworks' && w.area === a.id);
        expect(walls.length).toBeGreaterThanOrEqual(8);
        for (const w of walls) {
          for (const [x, z] of [[w.ax, w.az], [w.bx, w.bz]]) {
            const f = at(x, z);
            expect(f.v).toBeGreaterThan(0.2 - 1e-6);
            expect(f.v).toBeLessThanOrEqual(P.close - 0.6 + 1e-6);
            expect(f.s).toBeGreaterThanOrEqual(P.sA - 1e-6);
            expect(f.s).toBeLessThanOrEqual(P.sB + 1e-6);
          }
        }
      }
    }
  });
});
