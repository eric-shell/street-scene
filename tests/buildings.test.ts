import { describe, expect, it } from 'vitest';
import type { Building } from '../src/city/blocks';
import { createWorld } from '../src/city/world';
import { planArchitecture } from '../src/render/architecture';
import { recessCoplanar } from '../src/render/buildings';

/** Pairs of overlapping footprints with two walls facing the same way in one plane (they z-fight). */
function coplanarWalls(B: readonly Building[]): number {
  const walls = (b: Building) => {
    const ux = Math.cos(b.yaw);
    const uz = -Math.sin(b.yaw);
    const c = (a: number, s: number) => ({ x: b.x + ux * a - uz * s, z: b.z + uz * a + ux * s });
    const P = [c(-b.w / 2, -b.d / 2), c(b.w / 2, -b.d / 2), c(b.w / 2, b.d / 2), c(-b.w / 2, b.d / 2)];
    return P.map((p, k) => ({ p, q: P[(k + 1) % 4] }));
  };
  let n = 0;
  for (let i = 0; i < B.length; i++) {
    for (let j = i + 1; j < B.length; j++) {
      const a = B[i];
      const b = B[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > (Math.hypot(a.w, a.d) + Math.hypot(b.w, b.d)) / 2) continue;
      for (const f of walls(a)) {
        const dx = f.q.x - f.p.x;
        const dz = f.q.z - f.p.z;
        const len = Math.hypot(dx, dz);
        for (const g of walls(b)) {
          const ex = g.q.x - g.p.x;
          const ez = g.q.z - g.p.z;
          if ((dx * ex + dz * ez) / (len * Math.hypot(ex, ez)) < 0.9999) continue;
          if (Math.abs(((g.p.x - f.p.x) * dz - (g.p.z - f.p.z) * dx) / len) > 0.05) continue;
          const t0 = ((g.p.x - f.p.x) * dx + (g.p.z - f.p.z) * dz) / len;
          const t1 = ((g.q.x - f.p.x) * dx + (g.q.z - f.p.z) * dz) / len;
          if (Math.min(len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > 0.5) n++;
        }
      }
    }
  }
  return n;
}

describe('building shells', () => {
  it('step the lower of two coplanar overlapping walls back so they never z-fight', () => {
    for (const seed of [1, 7, 43405381]) {
      const w = createWorld(seed, 'circuit');
      const plans = planArchitecture(w);
      // The city really does overlap walls in one plane, so the test has teeth.
      expect(coplanarWalls(w.blocks.buildings)).toBeGreaterThan(0);
      const B = recessCoplanar(w.blocks.buildings, plans);
      expect(coplanarWalls(B)).toBe(0);
      expect(B.length).toBe(w.blocks.buildings.length);
      B.forEach((b, i) => {
        const o = w.blocks.buildings[i];
        expect(b.w).toBeGreaterThan(o.w * 0.89);
        expect(b.d).toBeGreaterThan(o.d * 0.89);
      });
    }
  });
});
