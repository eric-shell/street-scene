/**
 * Rolling ground height: a few meters of rise and fall over long wavelengths,
 * so you feel crests and dips while driving, but grades stay under ~5%.
 * Three sinusoid terms; slopeAt is their exact analytic gradient.
 */
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
  // Drawn after the original three so p1..p3 (and the big hills) keep their place per seed.
  const p4 = rng.range(0, TAU);
  const a1 = CITY.hillAmp1;
  const a2 = CITY.hillAmp2;
  const a3 = CITY.hillAmp3;
  const f1 = CITY.hillFreq1;
  const f2 = CITY.hillFreq2;
  const f3 = CITY.hillFreq3;
  // The third term runs along a skewed axis so its crests cross the street grid at an angle.
  const kx = f3 * 0.8;
  const kz = f3 * 0.6;
  return {
    heightAt(x, z) {
      return a1 * sin(x * f1 + p1) * cos(z * f1 * 0.9 + p2) + a2 * sin((x + z) * f2 + p3) + a3 * sin(x * kx - z * kz + p4);
    },
    slopeAt(x, z) {
      const s = a2 * f2 * cos((x + z) * f2 + p3);
      const t = a3 * cos(x * kx - z * kz + p4);
      return {
        gx: a1 * f1 * cos(x * f1 + p1) * cos(z * f1 * 0.9 + p2) + s + t * kx,
        gz: -a1 * f1 * 0.9 * sin(x * f1 + p1) * sin(z * f1 * 0.9 + p2) + s - t * kz,
      };
    },
  };
}
