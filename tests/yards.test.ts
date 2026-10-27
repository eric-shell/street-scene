import { describe, expect, it } from 'vitest';
import type { Contact } from '../src/city/world';
import { createWorld } from '../src/city/world';
import { TRAFFIC } from '../src/sim/tuning';
import { planYards, PARKED_KINDS } from '../src/render/districts/yards';
import { TRAFFIC_MODELS } from '../src/render/traffic/traffic';

/**
 * Invariant 5 for the yard trees and parked cars (render/districts/yards.ts): nothing drawn stops a car without a
 * wall, so every one must stand where no car can drive. The drivable space is flooded from the roads with the sim's
 * own collision (World.collideCircle, a grounded car as a circle a hair under its half width), 0.75 m cells, and
 * every footprint is held against it: no reachable car centre may come within a car's radius of a trunk or a body.
 * Walls that stand only for cars below their top (a culvert lip) count as standing: a flying car is not driving.
 */
const STEP = 0.75;
const RADIUS = 0.85;

function drivable(seed: number) {
  const w = createWorld(seed, 'circuit', undefined, { openWorld: true });
  const b = w.graph.bounds;
  const minX = b.minX - 30;
  const minZ = b.minZ - 30;
  const nx = Math.ceil((b.maxX - b.minX + 60) / STEP);
  const nz = Math.ceil((b.maxZ - b.minZ + 60) / STEP);
  const reach = new Uint8Array(nx * nz);
  const out: Contact[] = [];
  const free = (i: number, j: number) => w.collideCircle(minX + (i + 0.5) * STEP, minZ + (j + 0.5) * STEP, RADIUS, out) === 0;
  const queue = new Int32Array(nx * nz);
  let head = 0;
  let tail = 0;
  for (const e of w.graph.edges) {
    const a = w.graph.nodes[e.a];
    const c = w.graph.nodes[e.b];
    for (let t = 0.1; t < 1; t += 0.2) {
      const i = Math.floor((a.x + (c.x - a.x) * t - minX) / STEP);
      const j = Math.floor((a.z + (c.z - a.z) * t - minZ) / STEP);
      if (i < 0 || j < 0 || i >= nx || j >= nz || reach[j * nx + i] || !free(i, j)) continue;
      reach[j * nx + i] = 1;
      queue[tail++] = j * nx + i;
    }
  }
  while (head < tail) {
    const k = queue[head++];
    const i = k % nx;
    const j = (k / nx) | 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        const jj = j + dj;
        if ((!di && !dj) || ii < 0 || jj < 0 || ii >= nx || jj >= nz || reach[jj * nx + ii] || !free(ii, jj)) continue;
        reach[jj * nx + ii] = 1;
        queue[tail++] = jj * nx + ii;
      }
    }
  }
  /** Distance (m) from the footprint to the nearest reachable car centre within 3 m of it (Infinity: none). */
  const nearest = (f: { x: number; z: number; ux: number; uz: number; hl: number; hw: number }): number => {
    const r = Math.hypot(f.hl, f.hw) + 3;
    let best = Infinity;
    for (let j = Math.max(0, Math.floor((f.z - r - minZ) / STEP)); j <= Math.min(nz - 1, Math.floor((f.z + r - minZ) / STEP)); j++) {
      for (let i = Math.max(0, Math.floor((f.x - r - minX) / STEP)); i <= Math.min(nx - 1, Math.floor((f.x + r - minX) / STEP)); i++) {
        if (!reach[j * nx + i]) continue;
        const dx = minX + (i + 0.5) * STEP - f.x;
        const dz = minZ + (j + 0.5) * STEP - f.z;
        const lu = Math.abs(dx * f.ux + dz * f.uz) - f.hl;
        const lw = f.hw === 0 ? 0 : Math.abs(-dx * f.uz + dz * f.ux) - f.hw;
        best = Math.min(best, f.hw === 0 ? Math.max(0, Math.hypot(dx, dz) - f.hl) : Math.hypot(Math.max(lu, 0), Math.max(lw, 0)));
      }
    }
    return best;
  };
  return { world: w, cells: tail, nearest };
}

describe('yard trees and parked cars', () => {
  it('stand only where no car can drive, and are the same every time', () => {
    for (const seed of [20261019, 7]) {
      const { world, cells, nearest } = drivable(seed);
      expect(cells).toBeGreaterThan(500_000);
      const yards = planYards(world);
      expect(yards.trees.length).toBeGreaterThan(100);
      expect(yards.cars.length).toBeGreaterThan(30);
      for (const t of yards.trees) expect(nearest({ x: t.x, z: t.z, ux: 1, uz: 0, hl: 0.4, hw: 0 })).toBeGreaterThanOrEqual(RADIUS);
      for (const c of yards.cars) {
        expect(c.kind).toBeLessThan(PARKED_KINDS);
        const m = TRAFFIC_MODELS.kinds[TRAFFIC.kinds[c.kind].name];
        expect(nearest({ x: c.x, z: c.z, ux: Math.sin(c.yaw), uz: Math.cos(c.yaw), hl: m.halfLength, hw: m.halfWidth })).toBeGreaterThanOrEqual(RADIUS);
      }
      // The detector sees a car on the road: a tree on a street's centre line is touched.
      const e = world.graph.edges[0];
      const a = world.graph.nodes[e.a];
      const b = world.graph.nodes[e.b];
      expect(nearest({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, ux: 1, uz: 0, hl: 0.4, hw: 0 })).toBeLessThan(RADIUS);
      const again = planYards(createWorld(seed, 'circuit', undefined, { openWorld: true }));
      expect(JSON.stringify([again.trees, again.cars])).toBe(JSON.stringify([yards.trees, yards.cars]));
    }
  });

  it('keep parked cars from overlapping each other', () => {
    const yards = planYards(createWorld(20261019, 'circuit'));
    for (let i = 0; i < yards.cars.length; i++) {
      for (let j = i + 1; j < yards.cars.length; j++) {
        const a = yards.cars[i];
        const b = yards.cars[j];
        // Centres of two cars closer than their shortest half lengths share ground.
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.5);
      }
    }
  });
});
