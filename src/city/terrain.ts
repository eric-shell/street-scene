/** Gentle rolling ground height. Mostly flat, a few percent of grade at most. */
import { CITY } from './config';
import { Rng, deriveSeed } from '../sim/prng';
import { cos, sin, TAU } from '../sim/math';

export interface Terrain {
  heightAt(x: number, z: number): number;
  /** Analytic gradient (dh/dx, dh/dz). */
  slopeAt(x: number, z: number): { gx: number; gz: number };
}

export function createTerrain(seed: number): Terrain {
  const rng = new Rng(deriveSeed(seed, 'terrain'));
  const p1 = rng.range(0, TAU);
  const p2 = rng.range(0, TAU);
  const p3 = rng.range(0, TAU);
  const a1 = CITY.hillAmp1;
  const a2 = CITY.hillAmp2;
  const f1 = CITY.hillFreq1;
  const f2 = CITY.hillFreq2;
  return {
    heightAt(x, z) {
      return a1 * sin(x * f1 + p1) * cos(z * f1 * 0.9 + p2) + a2 * sin((x + z) * f2 + p3);
    },
    slopeAt(x, z) {
      const s = a2 * f2 * cos((x + z) * f2 + p3);
      return {
        gx: a1 * f1 * cos(x * f1 + p1) * cos(z * f1 * 0.9 + p2) + s,
        gz: -a1 * f1 * 0.9 * sin(x * f1 + p1) * sin(z * f1 * 0.9 + p2) + s,
      };
    },
  };
}
