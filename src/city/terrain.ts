/**
 * Rolling ground height: a few meters of rise and fall over long wavelengths,
 * so you feel crests and dips while driving, but grades stay under ~5%.
 * Three sinusoid terms; slopeAt is their exact analytic gradient.
 * District height modifiers (river channel, park hills, planter islands) are
 * added on top through a coarse grid, each with its own exact gradient.
 */
import { CITY } from './config';
import { Rng, deriveSeed } from '../sim/prng';
import { cos, sin, TAU } from '../sim/math';
import type { HeightMod, HeightSample } from './districts/types';

export interface Terrain {
  heightAt(x: number, z: number): number;
  /** Analytic gradient (dh/dx, dh/dz). */
  slopeAt(x: number, z: number): { gx: number; gz: number };
}

export function createTerrain(seed: number, mods: HeightMod[] = []): Terrain {
  const base = createBaseTerrain(seed);
  if (!mods.length) return base;
  // Coarse grid of modifier ids by bounding box; queries visit one cell.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const m of mods) {
    minX = Math.min(minX, m.minX);
    minZ = Math.min(minZ, m.minZ);
    maxX = Math.max(maxX, m.maxX);
    maxZ = Math.max(maxZ, m.maxZ);
  }
  const cell = 32;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cell));
  const cells: (number[] | undefined)[] = new Array(cols * rows);
  mods.forEach((m, id) => {
    const i0 = Math.max(0, Math.floor((m.minX - minX) / cell));
    const i1 = Math.min(cols - 1, Math.floor((m.maxX - minX) / cell));
    const j0 = Math.max(0, Math.floor((m.minZ - minZ) / cell));
    const j1 = Math.min(rows - 1, Math.floor((m.maxZ - minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) (cells[j * cols + i] ??= []).push(id);
  });
  const sample: HeightSample = { h: 0, gx: 0, gz: 0 };
  const modsAt = (x: number, z: number): number[] | undefined => {
    if (x < minX || z < minZ || x > maxX || z > maxZ) return undefined;
    const i = Math.min(cols - 1, Math.floor((x - minX) / cell));
    const j = Math.min(rows - 1, Math.floor((z - minZ) / cell));
    return cells[j * cols + i];
  };
  const accumulate = (x: number, z: number, list: number[]) => {
    sample.h = 0;
    sample.gx = 0;
    sample.gz = 0;
    for (const id of list) {
      const m = mods[id];
      if (x >= m.minX && x <= m.maxX && z >= m.minZ && z <= m.maxZ) m.add(x, z, sample);
    }
  };
  return {
    heightAt(x, z) {
      const h = base.heightAt(x, z);
      const list = modsAt(x, z);
      if (!list) return h;
      accumulate(x, z, list);
      return h + sample.h;
    },
    slopeAt(x, z) {
      const s = base.slopeAt(x, z);
      const list = modsAt(x, z);
      if (!list) return s;
      accumulate(x, z, list);
      return { gx: s.gx + sample.gx, gz: s.gz + sample.gz };
    },
  };
}

function createBaseTerrain(seed: number): Terrain {
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
