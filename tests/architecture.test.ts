import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { planArchitecture } from '../src/render/architecture';

describe('architecture plan', () => {
  const seeds = [1, 7, 43405381];

  it('is deterministic, mixes all five cities and many styles', () => {
    for (const seed of seeds) {
      const w = createWorld(seed, 'circuit');
      const a = planArchitecture(w);
      const b = planArchitecture(w);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.length).toBe(w.blocks.buildings.length);
      expect(new Set(a.map((p) => p.region)).size).toBe(5);
      expect(new Set(a.map((p) => p.style)).size).toBeGreaterThanOrEqual(8);
    }
  });

  it('never leaves a neon sign hanging above a building', () => {
    for (const seed of seeds) {
      const w = createWorld(seed, 'circuit');
      const plans = planArchitecture(w);
      plans.forEach((p) => expect(p.h).toBeGreaterThanOrEqual(p.flush - 1e-9));
      expect(plans.filter((p) => p.signed).length).toBeGreaterThan(0);
    }
  });

  it('clusters into neighbourhoods instead of dicing every building', () => {
    for (const seed of seeds) {
      const w = createWorld(seed, 'circuit');
      const B = w.blocks.buildings;
      const plans = planArchitecture(w);
      let same = 0;
      for (let i = 0; i < B.length; i++) {
        let best = -1;
        let bd = Infinity;
        for (let j = 0; j < B.length; j++) {
          if (j === i) continue;
          const d = (B[i].x - B[j].x) ** 2 + (B[i].z - B[j].z) ** 2;
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
        if (plans[best].region === plans[i].region) same++;
      }
      // Five regions diced at random would agree about a fifth of the time; borders and the
      // deliberate mixing keep it well short of all.
      expect(same / B.length).toBeGreaterThan(0.55);
    }
  });
});
