/**
 * Ground height: a landscape under the city plus rolling relief on it.
 * Two macro terms (a broad ridge or tilt at a 2.4 km wavelength in a seed-random
 * heading, a gentler valley roughly across it at 3 km) give each seed one side
 * higher than the other, a long rise climbed over several blocks or a wide
 * hollow, so the district features (the bluff, the park hills, the channel) read
 * as part of one terrain instead of bumps on a flat. Three rolling terms on top
 * give the crests and dips you feel lap to lap. The macro waves are so long
 * that their curvature never launches a car; they only add steady grade, which
 * the CITY.hillAmp / hillFreq pairs bound (worst case about 6%). Five
 * sinusoids in all; slopeAt is their exact analytic gradient.
 * District height modifiers (channel, park hills, planter islands) are
 * added on top through a coarse grid, each with its own exact gradient.
 */
import { CITY } from './config';
import { Rng, deriveSeed } from '../sim/prng';
import { cos, DEG, PI, sin, TAU } from '../sim/math';
import type { HeightMod, HeightSample } from './districts/types';

export interface Terrain {
  heightAt(x: number, z: number): number;
  /** Analytic gradient (dh/dx, dh/dz). */
  slopeAt(x: number, z: number): { gx: number; gz: number };
}

/** The base terrain of the last seed built: the planners ask for the plain landscape again and again while one city builds. */
let lastBase: { seed: number; terrain: Terrain } | null = null;

export function createTerrain(seed: number, mods: HeightMod[] = []): Terrain {
  if (lastBase?.seed !== seed) lastBase = { seed, terrain: createBaseTerrain(seed) };
  const base = lastBase.terrain;
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
  // The macro relief draws last for the same reason: the two headings, then the two phases. (Of the
  // equivalent orders this one keeps seed 32's bluff and car park, the reference jump, where they are.)
  const ridgeHeading = rng.range(0, TAU);
  // The valley runs roughly across the ridge (never along it, which would only make one steeper
  // ridge): their steepest grades then add in quadrature, not in line.
  const valleyHeading = ridgeHeading + PI / 2 + rng.range(-CITY.hillValleySkewDeg, CITY.hillValleySkewDeg) * DEG;
  const p5 = rng.range(0, TAU);
  const p6 = rng.range(0, TAU);
  const a1 = CITY.hillAmp1;
  const a2 = CITY.hillAmp2;
  const a3 = CITY.hillAmp3;
  const a4 = CITY.hillAmp4;
  const a5 = CITY.hillAmp5;
  const f1 = CITY.hillFreq1;
  const f2 = CITY.hillFreq2;
  const f3 = CITY.hillFreq3;
  // The third term runs along a skewed axis so its crests cross the street grid at an angle.
  const kx = f3 * 0.8;
  const kz = f3 * 0.6;
  // Macro wave vectors (rad/m along x and z).
  const rx = cos(ridgeHeading) * CITY.hillFreq4;
  const rz = sin(ridgeHeading) * CITY.hillFreq4;
  const vx = cos(valleyHeading) * CITY.hillFreq5;
  const vz = sin(valleyHeading) * CITY.hillFreq5;
  return {
    heightAt(x, z) {
      return a1 * sin(x * f1 + p1) * cos(z * f1 * 0.9 + p2) + a2 * sin((x + z) * f2 + p3) + a3 * sin(x * kx - z * kz + p4) + a4 * sin(x * rx + z * rz + p5) + a5 * sin(x * vx + z * vz + p6);
    },
    slopeAt(x, z) {
      const s = a2 * f2 * cos((x + z) * f2 + p3);
      const t = a3 * cos(x * kx - z * kz + p4);
      const r = a4 * cos(x * rx + z * rz + p5);
      const v = a5 * cos(x * vx + z * vz + p6);
      return {
        gx: a1 * f1 * cos(x * f1 + p1) * cos(z * f1 * 0.9 + p2) + s + t * kx + r * rx + v * vx,
        gz: -a1 * f1 * 0.9 * sin(x * f1 + p1) * sin(z * f1 * 0.9 + p2) + s - t * kz + r * rz + v * vz,
      };
    },
  };
}
