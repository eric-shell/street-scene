import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWorld } from '../src/city/world';
import { STREET_TREES } from '../src/city/config';
import { GeoBuilder } from '../src/render/geoBuilder';
import type { DistrictKit } from '../src/render/districts/kit';
import { plantStreetTrees } from '../src/render/districts/streetTrees';

const SEEDS = [20261019, 1, 42];

describe('street trees', () => {
  it('are the same every time and number about a thousand a city', () => {
    for (const seed of SEEDS) {
      const a = createWorld(seed, 'circuit').blocks.trees;
      const b = createWorld(seed, 'circuit').blocks.trees;
      expect(JSON.stringify(a), `${seed}`).toBe(JSON.stringify(b));
      expect(a.length, `${seed}`).toBeGreaterThan(500);
      expect(a.length, `${seed}`).toBeLessThan(2000);
    }
  });

  it('stand on sidewalks, clear of junctions and furniture, each one a solid trunk and every street solid a tree', () => {
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      const { trees } = w.blocks;
      const trunks = new Set(w.blocks.walls.filter((x) => x.look === 'tree' && x.area === undefined).map((x) => x.solid!));
      expect(trunks.size, `${seed}`).toBe(trees.length);
      for (const t of trees) {
        const mine = [...trunks].filter((s) => s.faces.every((f) => Math.hypot(f.ax - t.x, f.az - t.z) < t.radius + 1e-6));
        expect(mine.length, `${seed} trunk at ${t.x.toFixed(1)}, ${t.z.toFixed(1)}`).toBe(1);
        expect(mine[0].faces.length).toBe(STREET_TREES.trunkSides);
        expect(w.surfaceAt(t.x, t.z), `${seed}`).toBe('sidewalk');
        // 14 m (along the curb; a skewed corner measures a few cm less straight) from every junction's curb corners (the mouth points the curbs start from).
        let near = Infinity;
        w.graph.nodes.forEach((n, ni) => {
          if (n.edges.length < 3) return;
          for (const sec of w.blocks.sectors[ni]) for (const c of sec.curb) near = Math.min(near, Math.hypot(c.x - t.x, c.z - t.z));
        });
        expect(near, `${seed} junction`).toBeGreaterThanOrEqual(STREET_TREES.junctionClear - 0.5);
        let pole = Infinity;
        for (const p of w.props) if (p.kind === 'streetlight' || p.kind === 'trafficLight') pole = Math.min(pole, Math.hypot(p.x - t.x, p.z - t.z));
        expect(pole, `${seed} pole`).toBeGreaterThanOrEqual(STREET_TREES.propClear);
      }
    }
  });

  it('stop a car climbing the curb: the sim pushes it out of the trunk', () => {
    const w = createWorld(1, 'circuit');
    const t = w.blocks.trees[0];
    const out: Parameters<typeof w.collideCircle>[3] = [];
    expect(w.collideCircle(t.x + t.radius + 0.5, t.z, 0.9, out)).toBeGreaterThan(0);
  });

  it('are drawn on every trunk: the renderer plants into the district tree layer', () => {
    const w = createWorld(1, 'circuit');
    const kit = {
      world: w,
      h: w.heightAt,
      trees: new GeoBuilder(true),
      group: new THREE.Group(),
      quality: 'low',
      track: (x: unknown) => x,
      animate: () => {},
    } as unknown as DistrictKit;
    plantStreetTrees(kit);
    expect(kit.trees.vertexCount).toBeGreaterThan(w.blocks.trees.length * 20);
  });
});
