import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CITY } from '../src/city/config';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { City } from '../src/city/world';
import { graphIsConnected, isRiverEdge } from '../src/city/roadGraph';
import { createTerrain } from '../src/city/terrain';
import { distToPolygonEdge, pointInPolygon, polygonBounds } from '../src/city/districts/geom';
import { lakeLevels, lakeRings, lakeRolled } from '../src/city/districts/lake';
import { riverL } from '../src/city/districts/river';
import type { Area, WallLook } from '../src/city/districts/types';
import type { Wall } from '../src/city/blocks';
import { distToSegment } from '../src/sim/math';
import type { Vec2 } from '../src/sim/math';
import { Rng } from '../src/sim/prng';
import { createRace, stepRace } from '../src/sim/race';
import { autopilotInput, createAi } from '../src/sim/ai';
import { GeoBuilder } from '../src/render/geoBuilder';
import { lakeRenderer } from '../src/render/districts/lake';
import type { DistrictKit } from '../src/render/districts/kit';
import { raceConfig } from './helpers';

const CFG = CITY.districts.lake;

const lakeOf = (areas: readonly Area[]) => areas.find((a) => a.kind === 'lake');

/** Seeds (from a stream) whose city plans a lake: those that roll one (cheap) and find their blocks (planRoads). */
function lakeSeeds(stream: number, want: number): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 400 && out.length < want; i++) {
    const seed = rng.int(0, 999999999);
    if (lakeRolled(seed) && lakeOf(planRoads(seed).districts.areas)) out.push(seed);
  }
  return out;
}

/** A few finished cities with a lake. */
const cities: { city: City; lake: Area }[] = lakeSeeds(31, 4).map((seed) => {
  const city = createCity(seed);
  return { city, lake: lakeOf(city.districts.areas)! };
});

/** Segment ab crosses the polygon's outline. */
function crossesRing(a: Vec2, b: Vec2, ring: readonly Vec2[]): boolean {
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i];
    const d = ring[(i + 1) % ring.length];
    const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
    if (Math.abs(den) < 1e-12) continue;
    const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
    const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
    if (t > 0 && t < 1 && u > 0 && u < 1) return true;
  }
  return false;
}

describe('lake (plan)', () => {
  it('rolls on about a third of seeds from its own stream, and nearly every seed that rolls it plans one', () => {
    const rng = new Rng(2027);
    let rolled = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (lakeRolled(rng.int(0, 0x7fffffff))) rolled++;
    expect(rolled / n).toBeGreaterThan(CFG.chance - 0.025);
    expect(rolled / n).toBeLessThan(CFG.chance + 0.025);
    const seeds = new Rng(78);
    let lakes = 0;
    let rolls = 0;
    for (let i = 0; i < 30; i++) {
      const seed = seeds.int(0, 0x7fffffff);
      const lake = lakeOf(planRoads(seed).districts.areas);
      if (lake) lakes++;
      if (lakeRolled(seed)) rolls++;
      // A seed that does not roll one never has one; one that does finds its blocks, but for the odd city
      // whose plain blocks all stand where the river or the expressway will (measured: 96 of 100 find them).
      if (!lakeRolled(seed)) expect(lake, `seed ${seed}`).toBeUndefined();
    }
    expect(rolls).toBeGreaterThan(5);
    expect(lakes).toBeGreaterThanOrEqual(rolls * 0.85);
  });

  it('merges two to four blocks by deleting the streets between them, the same way every time', () => {
    for (const seed of lakeSeeds(5, 10)) {
      const a = planRoads(seed);
      const b = planRoads(seed);
      expect(JSON.stringify(b.districts.areas)).toBe(JSON.stringify(a.districts.areas));
      expect(JSON.stringify(b.graph)).toBe(JSON.stringify(a.graph));
      const g = a.graph;
      const lake = lakeOf(a.districts.areas)!;
      expect(lake.params.blocks).toBeGreaterThanOrEqual(CFG.blocks[0]);
      expect(lake.params.blocks).toBeLessThanOrEqual(CFG.blocks[1]);
      // One block, claimed by the lake alone; no street runs into it (the deleted ones are gone).
      expect(lake.faces.length).toBe(1);
      const { rail } = lakeRings(lake);
      for (const e of g.edges) {
        const A = g.nodes[e.a];
        const B = g.nodes[e.b];
        expect(pointInPolygon(A.x, A.z, rail) || pointInPolygon(B.x, B.z, rail) || crossesRing(A, B, rail), `seed ${seed} edge ${e.id}`).toBe(false);
      }
      // No dead ends, still one network, grid junctions where every planner looks for them.
      expect(graphIsConnected(g)).toBe(true);
      // (The river's channel ends at its tunnel portals: its only dead ends.)
      for (const n of g.nodes) if (!n.edges.some((e) => isRiverEdge(g.edges[e]))) expect(n.edges.length).toBeGreaterThanOrEqual(2);
      for (const n of g.nodes) if (n.gi >= 0) expect(g.nodes[n.gj * CITY.gridW + n.gi]).toBe(n);
      // Its shore streets and junctions are its own: nothing planned later took one.
      for (const e of lake.edges) expect(a.districts.areas.some((x) => x !== lake && x.kind !== 'downtown' && x.edges.includes(e))).toBe(false);
      // Clear of the river channel, the El and every hill.
      for (const x of a.districts.areas) {
        if (x.kind === 'river') for (const p of lake.polygon) expect(Math.abs(riverL(x.params, p.x, p.z))).toBeGreaterThan(x.params.top + CFG.riverClear);
        if (x.kind === 'subway') for (const p of x.path) expect(pointInPolygon(p.x, p.z, lake.polygon)).toBe(false);
        if (x.kind === 'hills') for (const p of lake.polygon) expect(pointInPolygon(p.x, p.z, x.polygon)).toBe(false);
      }
    }
  });
});

describe('lake (city)', () => {
  it('builds the same city twice', () => {
    const { city } = cities[0];
    const again = createCity(city.seed);
    expect(JSON.stringify(again.districts.builds)).toBe(JSON.stringify(city.districts.builds));
    expect(JSON.stringify(again.blocks.walls)).toBe(JSON.stringify(city.blocks.walls));
    expect(JSON.stringify(again.blocks.props)).toBe(JSON.stringify(city.blocks.props));
  });

  it('keeps buildings out and rings its water with a railing behind a promenade, every wall drawn and off the road', () => {
    for (const { city, lake } of cities) {
      const g = city.graph;
      const { shore, rail } = lakeRings(lake);
      expect(city.blocks.buildings.some((b) => pointInPolygon(b.x, b.z, shore))).toBe(false);
      const walls = city.blocks.walls.filter((w) => w.area === lake.id);
      const looks = new Set(walls.map((w) => w.look));
      expect([...looks].sort()).toEqual(['lakeRail', 'tree']);
      const rails = walls.filter((w) => w.look === 'lakeRail');
      // The railing runs the whole way round, on its line, facing the promenade (outside the water).
      const perimeter = rail.reduce((s, p, i) => s + Math.hypot(rail[(i + 1) % rail.length].x - p.x, rail[(i + 1) % rail.length].z - p.z), 0);
      expect(Math.abs(rails.reduce((s, w) => s + Math.hypot(w.bx - w.ax, w.bz - w.az), 0) - perimeter)).toBeLessThan(0.5);
      for (const w of rails) {
        const mx = (w.ax + w.bx) / 2;
        const mz = (w.az + w.bz) / 2;
        expect(distToPolygonEdge(mx, mz, rail)).toBeLessThan(0.01);
        expect(pointInPolygon(mx + w.nx, mz + w.nz, rail)).toBe(false);
        expect(pointInPolygon(mx - w.nx, mz - w.nz, rail)).toBe(true);
      }
      // No wall of the lake on a road: every one on the promenade or behind it, a car's room off every street.
      for (const w of walls) {
        for (const t of [0, 0.5, 1]) {
          const x = w.ax + (w.bx - w.ax) * t;
          const z = w.az + (w.bz - w.az) * t;
          expect(pointInPolygon(x, z, shore)).toBe(true);
          for (const e of g.edges) {
            const a = g.nodes[e.a];
            const b = g.nodes[e.b];
            expect(distToSegment(x, z, a.x, a.z, b.x, b.z)).toBeGreaterThan(e.width / 2 + e.sidewalk);
          }
        }
      }
      // Trees are solid trunks the renderer draws from the props at their middles.
      const trunks = walls.filter((w) => w.look === 'tree');
      for (const w of trunks) expect(w.solid).toBeDefined();
      const props = city.districts.builds[lake.id].props.filter((p) => p.kind === 'tree');
      for (const s of new Set(trunks.map((w) => w.solid!))) {
        const cx = s.faces.reduce((m, f) => m + f.ax, 0) / s.faces.length;
        const cz = s.faces.reduce((m, f) => m + f.az, 0) / s.faces.length;
        expect(props.some((p) => Math.hypot(p.x - cx, p.z - cz) < 0.05)).toBe(true);
      }
    }
  });

  it('sinks a level water into a basin: water surface behind the coping, the bed under it, the promenade untouched at curb height', () => {
    for (const { city, lake } of cities) {
      const world = createWorld(city.seed, 'circuit', city, { openWorld: true });
      const base = createTerrain(city.seed);
      const { shore, rail, water, bed } = lakeRings(lake);
      const { water: W, bed: F } = lakeLevels(lake);
      expect(F).toBeCloseTo(W - CFG.depth, 6);
      const bb = polygonBounds(shore);
      const rng = new Rng(lake.id + 1);
      let deep = 0;
      let walk = 0;
      for (let k = 0; k < 1500; k++) {
        const x = rng.range(bb.minX, bb.maxX);
        const z = rng.range(bb.minZ, bb.maxZ);
        if (!pointInPolygon(x, z, shore)) continue;
        if (pointInPolygon(x, z, water)) {
          expect(world.surfaceAt(x, z)).toBe('water');
          // Never above the coping's ground; flat at the bed past the bank, well under the water.
          expect(world.heightAt(x, z)).toBeLessThanOrEqual(base.heightAt(x, z) + 1e-9);
          if (pointInPolygon(x, z, bed) && distToPolygonEdge(x, z, bed) > 0.5) {
            expect(world.heightAt(x, z)).toBeCloseTo(F, 6);
            deep++;
          }
        } else if (!pointInPolygon(x, z, rail)) {
          // The promenade: the plain ground, paved at the sidewalk's height.
          expect(world.surfaceAt(x, z)).toBe('concrete');
          expect(world.heightAt(x, z)).toBeCloseTo(base.heightAt(x, z), 9);
          if (distToPolygonEdge(x, z, shore) > 0.5) expect(world.driveHeightAt(x, z) - world.heightAt(x, z)).toBeCloseTo(CITY.curbHeight, 6);
          walk++;
        }
        // Exact slopes, the bank's included (a hair of slack at the bank's creases off the corners).
        const s = world.slopeAt(x, z);
        const e = 0.002;
        const gx = (world.heightAt(x + e, z) - world.heightAt(x - e, z)) / (2 * e);
        const gz = (world.heightAt(x, z + e) - world.heightAt(x, z - e)) / (2 * e);
        if (Math.abs(s.gx - gx) > 1e-3 || Math.abs(s.gz - gz) > 1e-3) {
          const h0 = world.heightAt(x, z);
          expect(Math.abs(world.heightAt(x + 0.01, z) - h0 - s.gx * 0.01)).toBeLessThan(0.02);
        }
      }
      expect(deep).toBeGreaterThan(50);
      expect(walk).toBeGreaterThan(5);
      // The water stands under the coping all the way round, at least the freeboard.
      for (const p of water) expect(world.heightAt(p.x, p.z) - W).toBeGreaterThan(CFG.freeboard - 1e-6);
    }
  });

  it('routes run round it on the shore road, never over the water, and closures of its shore streets reach the railing', () => {
    let sealed = 0;
    for (const { city, lake } of cities) {
      const { shore, rail } = lakeRings(lake);
      for (const kind of ['circuit', 'sprint'] as const) {
        const world = createWorld(city.seed, kind, city);
        const pts = world.route.points;
        for (let i = 0; i + 1 < pts.length; i++) expect(pointInPolygon(pts[i].x, pts[i].z, rail) || crossesRing(pts[i], pts[i + 1], rail)).toBe(false);
        // A shore street's closure carries on across the promenade to the railing: no way round it.
        for (const gr of world.barrierGroups) {
          const ends = gr.walls.flatMap((w) => [
            { x: w.ax, z: w.az },
            { x: w.bx, z: w.bz },
          ]);
          if (!ends.some((p) => pointInPolygon(p.x, p.z, shore) && distToPolygonEdge(p.x, p.z, shore) > 0.5)) continue;
          sealed++;
          expect(ends.some((p) => distToPolygonEdge(p.x, p.z, rail) < 0.3)).toBe(true);
        }
      }
    }
    expect(sealed).toBeGreaterThan(0);
  });

  it('the AI field drives the shore road round it, never into the water', () => {
    // A route along a shore: the first lake city (from a stream) whose circuit or sprint has a node on the shore road.
    let pick: { seed: number; kind: 'circuit' | 'sprint' } | null = null;
    for (const seed of lakeSeeds(41, 12)) {
      const plan = planRoads(seed);
      const lake = lakeOf(plan.districts.areas)!;
      for (const kind of ['circuit', 'sprint'] as const) if (!pick && plan.routeNodes[kind].some((n) => lake.nodes.includes(n))) pick = { seed, kind };
      if (pick) break;
    }
    expect(pick).not.toBeNull();
    const { seed, kind } = pick!;
    const world = createWorld(seed, kind, createCity(seed));
    const { rail } = lakeRings(lakeOf(world.areas)!);
    const near = Math.min(...world.route.points.map((p) => distToPolygonEdge(p.x, p.z, rail)));
    // On the shore road: its center line is the street's half width and sidewalk plus the promenade from the railing.
    expect(near).toBeLessThan(CITY.width.avenue / 2 + CITY.sidewalk + CFG.promenade + 2);
    const r = createRace(raceConfig(seed, kind, 3), world);
    const pilot = createAi(0.97);
    // On round the route until every car has come by the lake (and a few seconds past it), or the race ends.
    const passed = r.cars.map(() => Infinity);
    for (let t = 0; t < 60 * 200 && r.phase !== 'finished'; t++) {
      stepRace(r, autopilotInput(r, r.cars[0], pilot));
      r.cars.forEach((c, k) => {
        expect(pointInPolygon(c.state.x, c.state.z, rail), `tick ${t}`).toBe(false);
        if (passed[k] === Infinity && distToPolygonEdge(c.state.x, c.state.z, rail) < near + 8) passed[k] = t;
      });
      if (passed.every((p) => t > p + 60 * 5)) break;
    }
    for (const p of passed) expect(p).toBeLessThan(Infinity);
  });
});

describe('lake (renderer)', () => {
  it('draws every wall of the lake: the railing along its walls, the trees on their trunks, the water at its level', () => {
    for (const { city, lake } of cities.slice(0, 2)) {
      const world = createWorld(city.seed, 'circuit', city, { openWorld: true });
      const walls = new Map<WallLook, Wall[]>();
      for (const w of world.walls) {
        if (w.kind !== 'wall' || !w.look) continue;
        (walls.get(w.look) ?? walls.set(w.look, []).get(w.look)!).push(w);
      }
      const kit: DistrictKit = {
        world,
        h: world.heightAt,
        solid: new GeoBuilder(true),
        ground: new GeoBuilder(true),
        paint: new GeoBuilder(true),
        glow: new GeoBuilder(true),
        foliage: new GeoBuilder(true),
        trees: new GeoBuilder(true),
        group: new THREE.Group(),
        walls,
        builds: world.districts.builds,
        quality: 'high',
        track: (x) => x,
        animate: () => {},
        view: () => {},
        simTick: (t) => t * 60,
        audible: () => false,
        armBroken: () => false,
      };
      lakeRenderer.build(kit, [lake]);
      for (const gb of [kit.solid, kit.ground, kit.glow, kit.foliage]) expect(gb.vertexCount).toBeGreaterThan(0);
      if (city.districts.builds[lake.id].props.some((p) => p.kind === 'tree')) expect(kit.trees.vertexCount).toBeGreaterThan(0);
      const water = kit.group.children.find((m) => m.name === `lakeWater${lake.id}`) as THREE.Mesh;
      const pos = (water.geometry as THREE.BufferGeometry).getAttribute('position');
      for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(lakeLevels(lake).water, 6);
      // The lights' streaks, and the fountain where the lake has one.
      expect(kit.group.children.some((m) => m.name === 'lakeStreaks')).toBe(true);
      const hints = city.districts.builds[lake.id].hints;
      expect(kit.group.children.some((m) => m.name === 'lakeFountain')).toBe(hints.some((h) => h.kind === 'fountain'));
      // The railing is drawn from its walls: without them the solid builder gets less.
      const bare: DistrictKit = { ...kit, solid: new GeoBuilder(true), group: new THREE.Group(), walls: new Map([...walls].filter(([k]) => k !== 'lakeRail')) };
      lakeRenderer.build(bare, [lake]);
      const posts = (walls.get('lakeRail') ?? []).filter((w) => w.area === lake.id).reduce((s, w) => s + Math.hypot(w.bx - w.ax, w.bz - w.az), 0) / 2.4;
      expect(kit.solid.vertexCount - bare.solid.vertexCount).toBeGreaterThan(posts * 10);
    }
  });
});
