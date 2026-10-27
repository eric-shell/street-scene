/**
 * The seed's city plan (roadGraph.ts cityPlan, CITY.plan): every seed lays out its own city (grid
 * size and spacing, downtown off the middle, boulevards, avenues, diagonals, a superblock) while the
 * map stays the size the camera, fog and backdrop are built for, and every seed still builds a city
 * with both routes.
 */
import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { cityPlan, edgeBetween, generateRoadGraph, graphIsConnected } from '../src/city/roadGraph';
import { createCity, createWorld } from '../src/city/world';
import { Rng } from '../src/sim/prng';

const P = CITY.plan;

/** 60 seeds from a fixed stream. */
const seeds = (() => {
  const rng = new Rng(20261026);
  return Array.from({ length: 60 }, () => rng.int(0, 0x7fffffff));
})();

describe('city plan', () => {
  it('varies the grid per seed, deterministically, within the map size the scene is built for', () => {
    let offCentre = 0;
    let superblocks = 0;
    const spacings = new Set<number>();
    const heights = new Set<number>();
    for (const seed of seeds) {
      const plan = cityPlan(seed);
      expect(JSON.stringify(cityPlan(seed))).toBe(JSON.stringify(plan));
      const g = generateRoadGraph(seed);
      expect(JSON.stringify(generateRoadGraph(seed))).toBe(JSON.stringify(g));
      expect(g.plan).toEqual(plan);
      expect(graphIsConnected(g)).toBe(true);

      expect(plan.spacing).toBeGreaterThanOrEqual(P.spacing[0]);
      expect(plan.spacing).toBeLessThanOrEqual(P.spacing[1]);
      expect(plan.gridW).toBeGreaterThanOrEqual(P.gridW[0]);
      expect(plan.gridW).toBeLessThanOrEqual(P.gridW[1]);
      expect(plan.gridH).toBeGreaterThanOrEqual(P.gridH[0]);
      expect(plan.gridH).toBeLessThanOrEqual(P.gridH[1]);
      expect(plan.boulevardRows.length).toBeGreaterThanOrEqual(1);
      expect(plan.boulevardRows.length).toBeLessThanOrEqual(P.boulevards.length);
      expect(plan.avenueCols.length).toBeGreaterThanOrEqual(1);
      expect(plan.avenueCols.length).toBeLessThanOrEqual(P.avenues.length);
      expect(plan.diagonals).toBeGreaterThanOrEqual(1);
      expect(plan.diagonals).toBeLessThanOrEqual(P.diagonals.length);
      expect(plan.removeFraction).toBeGreaterThanOrEqual(P.removeFraction[0]);
      expect(plan.removeFraction).toBeLessThanOrEqual(P.removeFraction[1]);
      spacings.add(plan.spacing);
      heights.add(plan.gridH);

      // Grid junctions where every planner looks for them: id j * gridW + i, all of them there.
      for (let id = 0; id < plan.gridW * plan.gridH; id++) {
        expect(g.nodes[id].gi).toBe(id % plan.gridW);
        expect(g.nodes[id].gj).toBe(Math.floor(id / plan.gridW));
      }
      const b = g.bounds;
      for (const span of [b.maxX - b.minX, b.maxZ - b.minZ]) {
        expect(span).toBeGreaterThan(1350);
        expect(span).toBeLessThan(1750);
      }
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      if (Math.hypot(plan.downtown.x - cx, plan.downtown.z - cz) > 120) offCentre++;

      // A superblock's streets are gone (before any district plans), every junction along it still joins two roads.
      const sb = plan.superblock;
      if (sb) {
        superblocks++;
        const at = (k: number, l: number) => (sb.axis === 'row' ? l * plan.gridW + k : k * plan.gridW + l);
        for (let k = sb.from; k < sb.from + sb.cells; k++) {
          const a = sb.axis === 'row' ? at(k, sb.line) : at(sb.line, k);
          const c = sb.axis === 'row' ? at(k + 1, sb.line) : at(sb.line, k + 1);
          // No street (no chain through bend nodes either: a dropped street was never subdivided).
          expect(g.edges.some((e) => e.chain !== undefined && [e.a, e.b].includes(a) && [e.a, e.b].includes(c))).toBe(false);
          expect(edgeBetween(g, a, c)).toBe(-1);
          expect(g.nodes[a].edges.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
    expect(spacings.size).toBeGreaterThan(10);
    expect(heights.size).toBe(P.gridH[1] - P.gridH[0] + 1);
    expect(offCentre / seeds.length).toBeGreaterThanOrEqual(0.3);
    expect(superblocks / seeds.length).toBeGreaterThanOrEqual(0.25);
  });

  // A city and both worlds cost about a second a seed: four tests of 15 keep each well inside the per-test limit.
  it.each([0, 1, 2, 3])('builds a city with both routes on every seed (part %i of 4)', (part) => {
    for (const seed of seeds.slice(part * 15, part * 15 + 15)) {
      const city = createCity(seed);
      for (const kind of ['circuit', 'sprint'] as const) {
        const w = createWorld(seed, kind, city);
        expect(w.route.nodes.length, `seed ${seed} ${kind}`).toBeGreaterThan(3);
        expect(w.route.length, `seed ${seed} ${kind}`).toBeGreaterThan(500);
        if (kind === 'circuit') expect(w.route.closed).toBe(true);
      }
    }
  });
});
