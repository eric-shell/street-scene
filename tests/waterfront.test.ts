import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { City, World } from '../src/city/world';
import { createTerrain } from '../src/city/terrain';
import { Rng } from '../src/sim/prng';
import { cos, distToSegment, segmentT, sin } from '../src/sim/math';
import type { Area } from '../src/city/districts/types';
import { WALL_LOOKS } from '../src/city/districts/types';
import { insideBuilding } from '../src/city/blocks';
import { pointInPolygon } from '../src/city/districts/geom';
import { coastV, frameU, frameV, harborFrame, harborWater, waterLevel, waterSpan } from '../src/city/districts/waterfrontShape';
import * as THREE from 'three';
import { WATERFRONT_LOOKS, harborSea, waterfrontRenderer } from '../src/render/districts/waterfront';
import { GeoBuilder } from '../src/render/geoBuilder';
import type { DistrictKit } from '../src/render/districts/kit';
import type { Wall } from '../src/city/blocks';
import type { WallLook } from '../src/city/districts/types';
import { waterfrontRolled } from '../src/city/districts/waterfront';
import { createRace, stepRace } from '../src/sim/race';
import { createCar, stepCar } from '../src/sim/car';
import { collideCarWithWorld } from '../src/sim/collision';
import { baseTuning, input, raceConfig } from './helpers';

const CFG = CITY.districts.waterfront;

const harborOf = (areas: readonly Area[]) => areas.find((a) => a.kind === 'waterfront');

/** Seeds (from a stream) whose city plans a harbor: rolled (cheap), then planned (planRoads only). */
function harborSeeds(stream: number, want: number): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 400 && out.length < want; i++) {
    const seed = rng.int(0, 0x7fffffff);
    if (waterfrontRolled(seed) && harborOf(planRoads(seed).districts.areas)) out.push(seed);
  }
  return out;
}

/** A few finished cities with a harbor, their circuit and sprint worlds and the harbor area. */
const cities: { city: City; worlds: World[]; a: Area }[] = harborSeeds(31, 4).map((seed) => {
  const city = createCity(seed);
  const worlds = [createWorld(seed, 'circuit', city), createWorld(seed, 'sprint', city)];
  return { city, worlds, a: harborOf(city.districts.areas)! };
});

/** (u, v) of a point in the harbor's frame. */
const uv = (a: Area, x: number, z: number) => {
  const f = harborFrame(a);
  return { u: frameU(f, x, z), v: frameV(f, x, z) };
};

describe('waterfront (plan)', () => {
  it('turns about a third of cities into a harbor town, the same every time', () => {
    // The roll is the first draw of the module's stream: CFG.chance of seeds.
    const rng = new Rng(2027);
    let rolled = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (waterfrontRolled(rng.int(0, 0x7fffffff))) rolled++;
    expect(rolled / n).toBeGreaterThan(CFG.chance - 0.025);
    expect(rolled / n).toBeLessThan(CFG.chance + 0.025);
    // Most seeds that roll one find a side free enough (the El, the river and the expressway take the rest),
    // so about a third of cities have a harbor; one that does not roll has none.
    const seeds = new Rng(77);
    let tried = 0;
    let got = 0;
    let none = 0;
    const sides = new Set<number>();
    while (tried < 24) {
      const seed = seeds.int(0, 0x7fffffff);
      if (!waterfrontRolled(seed)) {
        if (none++ < 4) expect(harborOf(planRoads(seed).districts.areas)).toBeUndefined();
        continue;
      }
      tried++;
      const a = harborOf(planRoads(seed).districts.areas);
      if (!a) continue;
      got++;
      sides.add(a.params.side);
      // A quay runs at least minLength along its side, the water level tilting no more than maxTilt.
      expect(a.params.pb - a.params.pa).toBeGreaterThanOrEqual(CFG.minLength - 1e-6);
      expect(Math.abs(a.params.wt)).toBeLessThanOrEqual(CFG.maxTilt + 1e-9);
    }
    expect(got / tried).toBeGreaterThan(0.65);
    expect(CFG.chance * (got / tried)).toBeGreaterThan(0.25);
    expect(CFG.chance * (got / tried)).toBeLessThan(0.45);
    // Harbors face every way.
    expect(sides.size).toBeGreaterThanOrEqual(3);
    // Deterministic: the same seed plans and builds the same harbor, walls, terrain and all.
    for (const { city, a } of cities.slice(0, 2)) {
      const again = createCity(city.seed);
      const b = harborOf(again.districts.areas)!;
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(again.districts.builds[b.id])).toBe(JSON.stringify(city.districts.builds[a.id]));
      expect(JSON.stringify(again.blocks.walls)).toBe(JSON.stringify(city.blocks.walls));
      const p = a.params;
      for (let u = p.pa; u <= p.pb; u += 37) {
        for (const dv of [-20, -2, 0.4, 3, 40]) {
          const q = { x: u * p.ux + (coastV(p, u) + dv) * p.vx, z: u * p.uz + (coastV(p, u) + dv) * p.vz };
          expect(again.terrain.heightAt(q.x, q.z)).toBe(city.terrain.heightAt(q.x, q.z));
        }
      }
    }
  });

  it('keeps clear of everything else that reaches past the city edge', () => {
    for (const { city, a } of cities) {
      const p = a.params;
      const f = harborFrame(a);
      // Nothing else stands out over the water or the quay: the El, the river, the expressway, the bluff.
      const [w0, w1] = waterSpan(p);
      for (const o of city.districts.areas) {
        if (!['subway', 'river', 'highway', 'bluff'].includes(o.kind)) continue;
        for (const q of [...o.polygon, ...o.path]) {
          const u = frameU(f, q.x, q.z);
          const v = frameV(f, q.x, q.z);
          if (u < Math.min(w0, p.pa) - 2 || u > Math.max(w1, p.pb) + 2) continue;
          expect(v, `${o.kind} at u ${u.toFixed(0)}`).toBeLessThan(coastV(p, u) - CFG.quayWidth);
        }
      }
      // No building on the quay, in a warehouse's recess or out on the water.
      const water = harborWater(a, 300);
      const sheds = city.districts.builds[a.id].hints.filter((h) => h.kind === 'warehouse').map((h) => h.points);
      for (const b of city.blocks.buildings) {
        const { u } = uv(a, b.x, b.z);
        if (u < p.pa - CFG.mole - 30 || u > p.pb + CFG.mole + 30) continue;
        for (const poly of [a.polygon, water, ...sheds]) {
          expect(pointInPolygon(b.x, b.z, poly)).toBe(false);
          for (const q of poly) if (Math.abs(q.x - b.x) < 30 && Math.abs(q.z - b.z) < 30 && pointInPolygon(q.x, q.z, poly)) expect(insideBuilding(b, q.x, q.z, -0.3)).toBe(false);
        }
      }
    }
  });
});

describe('waterfront (sim)', () => {
  it('walls: drawn by the waterfront renderer, on the quay never the road, the railing end to end', () => {
    for (const { city, worlds, a } of cities) {
      const p = a.params;
      const g = city.graph;
      const walls = city.blocks.walls.filter((w) => w.area === a.id);
      expect(walls.length).toBeGreaterThan(10);
      const scratch: number[] = [];
      for (const w of walls) {
        expect(WALL_LOOKS).toContain(w.look);
        expect(WATERFRONT_LOOKS).toContain(w.look);
        for (const t of [0.1, 0.5, 0.9]) {
          const x = w.ax + (w.bx - w.ax) * t;
          const z = w.az + (w.bz - w.az) * t;
          city.blocks.edgeGrid.query(x - 1, z - 1, x + 1, z + 1, scratch);
          for (const id of scratch) {
            const e = g.edges[id];
            const A = g.nodes[e.a];
            const B = g.nodes[e.b];
            const s = segmentT(x, z, A.x, A.z, B.x, B.z);
            if (s * e.length < 1.5 || (1 - s) * e.length < 1.5) continue;
            expect(distToSegment(x, z, A.x, A.z, B.x, B.z)).toBeGreaterThan(e.width / 2 - 0.05);
          }
        }
      }
      // The railing runs the whole quay without a gap, its normals in onto the quay.
      const rail = walls.filter((w) => w.look === 'quayRail');
      let covered = 0;
      for (let i = 0; i < rail.length; i++) {
        const w = rail[i];
        covered += Math.hypot(w.bx - w.ax, w.bz - w.az);
        if (i) expect(Math.hypot(w.ax - rail[i - 1].bx, w.az - rail[i - 1].bz)).toBeLessThan(1e-6);
        expect(w.nx * p.vx + w.nz * p.vz).toBeLessThan(-0.8);
      }
      expect(covered).toBeGreaterThan(p.pb - p.pa - 1);
      // A fence at each end from the frontage to the railing.
      expect(walls.filter((w) => w.look === 'quayFence').length).toBe(2);
      // Every route stays on the streets, its corridor nowhere near the water.
      for (const w of worlds) {
        for (let i = 0; i < w.route.points.length; i++) {
          const q = w.route.points[i];
          const half = w.route.segWidth[Math.min(i, w.route.segWidth.length - 1)] / 2;
          const { u, v } = uv(a, q.x, q.z);
          expect(v + half).toBeLessThan(coastV(p, u) - CFG.railInset);
          expect(w.surfaceAt(q.x, q.z)).not.toBe('water');
        }
      }
    }
  });

  it('the water surface and the lowered ground agree, with exact slopes, the quay standing over the water', () => {
    const rng = new Rng(9);
    for (const { city, worlds, a } of cities) {
      const w = worlds[0];
      const p = a.params;
      const base = createTerrain(city.seed);
      const [w0, w1] = waterSpan(p);
      for (let k = 0; k < 500; k++) {
        const u = rng.range(Math.max(w0, p.pa - 300), Math.min(w1, p.pb + 300));
        const c = coastV(p, u);
        // Out on the water: 'water', the ground at the seabed under the surface.
        const out = c + rng.range(p.fall + 0.05, 170);
        const qw = { x: u * p.ux + out * p.vx, z: u * p.uz + out * p.vz };
        expect(w.surfaceAt(qw.x, qw.z)).toBe('water');
        expect(Math.abs(w.heightAt(qw.x, qw.z) - (waterLevel(p, u) - p.depth))).toBeLessThan(1e-6);
        // On the quay (between its lanterns and clutter): concrete over the water by the freeboard, the plain landscape.
        if (u > p.pa + 1 && u < p.pb - 1) {
          const back = c - rng.range(0.3, CFG.quayWidth - 1);
          const qq = { x: u * p.ux + back * p.vx, z: u * p.uz + back * p.vz };
          expect(w.surfaceAt(qq.x, qq.z)).toBe('concrete');
          expect(w.heightAt(qq.x, qq.z)).toBe(base.heightAt(qq.x, qq.z));
          expect(w.heightAt(qq.x, qq.z)).toBeGreaterThan(waterLevel(p, u) + CFG.freeboard - 0.6);
          // Sidewalk height on the quay, like a plaza.
          expect(w.driveHeightAt(qq.x, qq.z)).toBeCloseTo(w.heightAt(qq.x, qq.z) + CITY.curbHeight, 6);
        }
        // Wherever the ground is under the water, it is the harbor's water (the wall's face aside).
        const any = c + rng.range(-40, 170);
        const qa = { x: u * p.ux + any * p.vx, z: u * p.uz + any * p.vz };
        if (w.heightAt(qa.x, qa.z) < waterLevel(p, u) - 0.05 && any > c + p.fall) expect(w.surfaceAt(qa.x, qa.z)).toBe('water');
      }
      // Slopes match heights across the wall's face, the fades and the open water.
      for (let k = 0; k < 400; k++) {
        const u = rng.range(p.eA0 + 1, p.eB1 - 1);
        const v = coastV(p, u) + rng.range(-5, p.vf1 - coastV(p, u) + 5);
        const x = u * p.ux + v * p.vx;
        const z = u * p.uz + v * p.vz;
        const s = w.slopeAt(x, z);
        const e = 0.002;
        const gx = (w.heightAt(x + e, z) - w.heightAt(x - e, z)) / (2 * e);
        const gz = (w.heightAt(x, z + e) - w.heightAt(x, z - e)) / (2 * e);
        expect(Math.abs(s.gx - gx)).toBeLessThan(2e-3 * Math.max(1, Math.abs(gx)));
        expect(Math.abs(s.gz - gz)).toBeLessThan(2e-3 * Math.max(1, Math.abs(gz)));
      }
    }
  });

  it('a car driven flat out at the harbor stops at the railing, every time', () => {
    for (const { city, a } of cities.slice(0, 3)) {
      const w = createWorld(city.seed, 'circuit', city, { openWorld: true });
      const p = a.params;
      const snaps: string[] = [];
      for (let run = 0; run < 2; run++) {
        const log: string[] = [];
        for (const t of [0.2, 0.5, 0.8]) {
          const u = p.pa + (p.pb - p.pa) * t;
          const c = coastV(p, u);
          // From the quay's back, square at the water and at a glancing angle.
          for (const ang of [0, 0.6]) {
            const v0 = c - CFG.quayWidth + 1.5;
            const sx = u * p.ux + v0 * p.vx;
            const sz = u * p.uz + v0 * p.vz;
            const dx = p.vx * cos(ang) + p.ux * sin(ang);
            const dz = p.vz * cos(ang) + p.uz * sin(ang);
            const cfg = { ...raceConfig(city.seed, 'circuit', 0), openWorld: true, start: { x: sx, z: sz, yaw: Math.atan2(dx, dz), speed: 22, tick: 0 } };
            const race = createRace(cfg, w);
            const car = race.cars[0].state;
            for (let i = 0; i < 150; i++) {
              stepRace(race, input({ throttle: 1 }));
              const q = uv(a, car.x, car.z);
              expect(q.v).toBeLessThan(coastV(p, q.u) - 0.2);
              expect(w.surfaceAt(car.x, car.z)).not.toBe('water');
              expect(car.y).toBeGreaterThan(waterLevel(p, q.u) + 0.5);
            }
            log.push(JSON.stringify([car.x, car.z, car.yaw]));
          }
        }
        snaps.push(log.join('|'));
      }
      expect(snaps[1]).toBe(snaps[0]);
    }
  });
});

describe('waterfront (race)', () => {
  it('a race closes the quay along its whole frontage: no closure can be driven round across it', () => {
    let closures = 0;
    let stopped = 0;
    let entered = 0;
    // A closure ending at the quay is rare (3 of 16 harbors), so two seeds that have one join the sample.
    for (const seed of [...harborSeeds(53, 8), 2015527382, 548196328]) {
      const city = createCity(seed);
      const a = harborOf(city.districts.areas)!;
      const fronts = city.districts.builds[a.id].hints.filter((h) => h.kind === 'frontage');
      expect(fronts.length).toBeGreaterThan(0);
      const open = createWorld(seed, 'circuit', city, { openWorld: true });
      // Free roam leaves the quay open: no gates.
      expect(open.walls.some((w) => w.look === 'quayGate')).toBe(false);
      for (const kind of ['circuit', 'sprint'] as const) {
        const w = createWorld(seed, kind, city);
        const gates = w.walls.filter((x) => x.look === 'quayGate' && x.area === a.id);
        const near = (x: number, z: number, r: number) => gates.some((g) => distToSegment(x, z, g.ax, g.az, g.bx, g.bz) < r);
        // The barriers stand along every metre of the open frontage, without a gap a car could pass.
        for (const h of fronts) {
          const pts = h.points;
          for (let i = 0; i + 1 < pts.length; i++) {
            const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
            for (let s = 0; s <= len; s += 0.5) {
              const t = len > 0 ? s / len : 0;
              expect(near(pts[i].x + (pts[i + 1].x - pts[i].x) * t, pts[i].z + (pts[i + 1].z - pts[i].z) * t, 0.05)).toBe(true);
            }
          }
        }
        // Every closure next to the quay (a barrier piece ending at its frontage) meets that line of barriers.
        for (const gr of w.barrierGroups) {
          for (const piece of gr.walls) {
            for (const [x, z] of [
              [piece.ax, piece.az],
              [piece.bx, piece.bz],
            ]) {
              const p = a.params;
              const u = frameU(harborFrame(a), x, z);
              if (u < p.pa || u > p.pb || !pointInPolygon(x + p.vx * 1.2, z + p.vz * 1.2, a.polygon)) continue;
              closures++;
              expect(near(x, z, 1)).toBe(true);
            }
          }
        }
        // Driven flat out at the quay from the street anywhere along it, a car is stopped at the frontage
        // (and in free roam drives straight onto the quay).
        if (kind !== 'circuit') continue;
        const t = baseTuning();
        for (const h of fronts) {
          for (let i = 1; i + 1 < h.points.length; i += Math.max(1, Math.floor(h.points.length / 4))) {
            const q = h.points[i];
            const r = h.points[i + 1];
            const len = Math.hypot(r.x - q.x, r.z - q.z);
            if (len < 1) continue;
            // In onto the street's sidewalk, square to the frontage, facing the quay.
            const nx = -(r.z - q.z) / len;
            const nz = (r.x - q.x) / len;
            for (const world of [w, open]) {
              const c = createCar(q.x - nx * 7, q.z - nz * 7, Math.atan2(nx, nz), world.heightAt(q.x - nx * 7, q.z - nz * 7));
              c.vx = nx * 18;
              c.vz = nz * 18;
              let on = false;
              for (let k = 0; k < 90; k++) {
                stepCar(c, t, input({ throttle: 1 }), { world });
                collideCarWithWorld(c, t, world);
                if (pointInPolygon(c.x, c.z, a.polygon)) on = true;
              }
              if (world === w) {
                expect(on).toBe(false);
                stopped++;
              } else if (on) entered++;
            }
          }
        }
      }
    }
    expect(closures).toBeGreaterThan(0);
    expect(stopped).toBeGreaterThan(20);
    expect(entered).toBeGreaterThan(stopped / 2);
  });

  it('rivals racing along the quay never reach the water', () => {
    // A seed whose sprint runs down the street along the quay (the harbor goes where the races run, CFG.raceBonus).
    const seed = 1265014699;
    const city = createCity(seed);
    const w = createWorld(seed, 'sprint', city);
    const a = harborOf(city.districts.areas)!;
    const p = a.params;
    const along = (x: number, z: number) => {
      const { u, v } = uv(a, x, z);
      return u > p.pa && u < p.pb ? coastV(p, u) - v : Infinity;
    };
    expect(Math.min(...w.route.points.map((q) => along(q.x, q.z)))).toBeLessThan(30);
    const race = createRace(raceConfig(seed, 'sprint', 4), w);
    let nearest = Infinity;
    for (let t = 0; t < 60 * 150 && !race.cars.slice(1).every((c) => c.finished); t++) {
      stepRace(race, input({}));
      for (const rc of race.cars.slice(1)) {
        const { u, v } = uv(a, rc.state.x, rc.state.z);
        expect(v).toBeLessThan(coastV(p, u) - 0.2);
        nearest = Math.min(nearest, along(rc.state.x, rc.state.z));
      }
    }
    // They did race past it.
    expect(nearest).toBeLessThan(30);
  });
});

describe('waterfront (render)', () => {
  it('draws every wall it owns, the water out past the far ridge and the dressing, with no stray vertex', () => {
    for (const { worlds, a } of cities.slice(0, 2)) {
      const world = worlds[0];
      const walls = new Map<WallLook, Wall[]>();
      for (const w of world.walls) if (w.kind === 'wall' && w.look) (walls.get(w.look) ?? walls.set(w.look, []).get(w.look)!).push(w);
      const group = new THREE.Group();
      const kit: DistrictKit = {
        world,
        h: world.heightAt,
        solid: new GeoBuilder(true),
        ground: new GeoBuilder(true),
        paint: new GeoBuilder(true),
        glow: new GeoBuilder(true),
        foliage: new GeoBuilder(true),
        trees: new GeoBuilder(true),
        group,
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
      // Drawn wall by wall: each of the harbor's walls adds geometry to the solid builder.
      for (const look of WATERFRONT_LOOKS) {
        const own = (walls.get(look) ?? []).filter((w) => w.area === a.id);
        if (!own.length) continue;
        const before = kit.solid.vertexCount;
        walls.set(look, own);
        const only = new Map<WallLook, Wall[]>([[look, own]]);
        const k2 = { ...kit, walls: only, solid: new GeoBuilder(true) };
        waterfrontRenderer.build(k2, [a]);
        expect(k2.solid.vertexCount, look).toBeGreaterThan(before);
      }
      waterfrontRenderer.build(kit, [a]);
      for (const gb of [kit.solid, kit.ground, kit.paint, kit.glow]) {
        expect(gb.vertexCount).toBeGreaterThan(0);
        for (const v of gb.positions) expect(Number.isFinite(v)).toBe(true);
      }
      const names = group.children.map((c) => c.name);
      expect(names).toContain('harborWater');
      expect(names).toContain('harborFlashers');
      // The water reaches past the backdrop's far ridge (1950 m round the camera) from the quay's middle.
      const water = group.getObjectByName('harborWater') as THREE.Mesh;
      water.geometry.computeBoundingBox();
      const bb = water.geometry.boundingBox!;
      const p = a.params;
      const mid = { x: ((p.pa + p.pb) / 2) * p.ux + coastV(p, (p.pa + p.pb) / 2) * p.vx, z: ((p.pa + p.pb) / 2) * p.uz + coastV(p, (p.pa + p.pb) / 2) * p.vz };
      const far = Math.max(Math.abs(bb.max.x - mid.x), Math.abs(bb.min.x - mid.x), Math.abs(bb.max.z - mid.z), Math.abs(bb.min.z - mid.z));
      expect(far).toBeGreaterThan(2400);
      // The backdrop's sea window looks out over the water.
      const sea = harborSea(world)!;
      expect(sea).not.toBeNull();
      const t = sea.from + ((((sea.to - sea.from) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / 2;
      expect(Math.cos(t) * p.vx + Math.sin(t) * p.vz).toBeGreaterThan(0.3);
    }
  });
});
