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
import { beachRolled, waterfrontRolled } from '../src/city/districts/waterfront';
import { duneMod } from '../src/city/districts/waterfrontBeach';
import { homeOf } from '../src/shared/home';
import { cityIdentity } from '../src/render/cityIdentity';
import { createRace, stepRace } from '../src/sim/race';
import { createCar, stepCar } from '../src/sim/car';
import { collideCarWithWorld } from '../src/sim/collision';
import { baseTuning, carSnapshot, flatWorld, input, raceConfig } from './helpers';
import { driftZones } from '../src/sim/driftZones';
import type { Contact } from '../src/city/world';

const CFG = CITY.districts.waterfront;

const harborOf = (areas: readonly Area[]) => areas.find((a) => a.kind === 'waterfront');

/** Seeds (from a stream) whose city plans a harbor: rolled (cheap), then planned (planRoads only). */
function harborSeeds(stream: number, want: number, variant?: string): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 400 && out.length < want; i++) {
    const seed = rng.int(0, 0x7fffffff);
    if (!waterfrontRolled(seed)) continue;
    const a = harborOf(planRoads(seed).districts.areas);
    if (a && (!variant || a.variant === variant)) out.push(seed);
  }
  return out;
}

/** A few finished cities with a harbor, their circuit and sprint worlds and the harbor area. */
const cities: { city: City; worlds: World[]; a: Area }[] = [...harborSeeds(31, 2, 'harbor'), ...harborSeeds(31, 2, 'marina')].map((seed) => {
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
      expect(a.params.pb - a.params.pa).toBeGreaterThanOrEqual((a.variant === 'beach' ? CFG.beach.minLength : CFG.minLength) - 1e-6);
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

describe('waterfront (marina)', () => {
  it('is a variant of about 45% of the waterfronts, the same every time, and leaves harbor seeds as they were', () => {
    const rng = new Rng(4242);
    const count = { harbor: 0, marina: 0 };
    for (let i = 0; i < 400 && count.harbor + count.marina < 60; i++) {
      const seed = rng.int(0, 0x7fffffff);
      if (!waterfrontRolled(seed)) continue;
      const a = harborOf(planRoads(seed).districts.areas);
      if (!a) continue;
      expect(['harbor', 'marina', 'beach']).toContain(a.variant);
      // A beach is the beach stream's pick; every other waterfront is a harbor or a marina as it always was.
      if (a.variant === 'beach') {
        expect(beachRolled(seed)).toBe(true);
        continue;
      }
      count[a.variant as 'harbor' | 'marina']++;
      if (count.harbor + count.marina <= 4) expect(harborOf(planRoads(seed).districts.areas)!.variant).toBe(a.variant);
    }
    const share = count.marina / (count.harbor + count.marina);
    expect(count.harbor + count.marina).toBe(60);
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.65);
  });

  it('moors boats at pontoons behind the railing, with a club, a fuel dock and bollards; no jetty, crane or ship', () => {
    const marinas = cities.filter((c) => c.a.variant === 'marina');
    expect(marinas.length).toBeGreaterThanOrEqual(2);
    for (const { city, a } of marinas) {
      const b = city.districts.builds[a.id];
      const p = a.params;
      const kinds = new Set(b.props.map((x) => x.kind));
      expect(b.hints.filter((h) => h.kind === 'pontoon').length).toBeGreaterThanOrEqual(1);
      expect(b.hints.some((h) => h.kind === 'clubhouse')).toBe(true);
      expect(b.hints.some((h) => h.kind === 'fuel')).toBe(true);
      expect(b.hints.some((h) => h.kind === 'jetty')).toBe(false);
      for (const k of ['crane', 'stack', 'ship']) expect(kinds.has(k)).toBe(false);
      expect(kinds.has('sailboat') || kinds.has('yacht')).toBe(true);
      expect(b.destructibles.filter((d) => d.kind === 'bollard').length).toBeGreaterThan(10);
      // Every mooring is out past the sea wall, none on the quay.
      for (const pr of b.props) {
        if (!['sailboat', 'yacht', 'dinghy'].includes(pr.kind) || pr.kind === 'dinghy' && pr.height < 0.5) continue;
        expect(frameV(harborFrame(a), pr.x, pr.z)).toBeGreaterThan(coastV(p, frameU(harborFrame(a), pr.x, pr.z)));
      }
      // Bollards stand on the quay, inside the railing, clear of the road.
      for (const d of b.destructibles.filter((x) => x.kind === 'bollard')) {
        const { u, v } = uv(a, d.x, d.z);
        expect(v).toBeLessThan(coastV(p, u) - CFG.railInset);
      }
    }
  });

  it('plans and builds the same marina every time', () => {
    const { city, a } = cities.find((c) => c.a.variant === 'marina')!;
    const again = createCity(city.seed);
    const b = harborOf(again.districts.areas)!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(again.districts.builds[b.id])).toBe(JSON.stringify(city.districts.builds[a.id]));
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
        // On the quay (between its lanterns and clutter): dock paving (cobbles across a mouth) over the water by the
        // freeboard, the plain landscape off the loading ramps.
        const ramps = city.districts.builds[a.id].hints.filter((h) => h.kind === 'ramp');
        const onRamp = ramps.some((h) => u > h.values[0] - 1 && u < h.values[0] + h.values[1] + 1);
        if (u > p.pa + 1 && u < p.pb - 1) {
          const back = c - rng.range(0.3, CFG.quayWidth - 1);
          const qq = { x: u * p.ux + back * p.vx, z: u * p.uz + back * p.vz };
          expect(['quay', 'cobble']).toContain(w.surfaceAt(qq.x, qq.z));
          if (!onRamp) expect(w.heightAt(qq.x, qq.z)).toBe(base.heightAt(qq.x, qq.z));
          expect(w.heightAt(qq.x, qq.z)).toBeGreaterThan(waterLevel(p, u) + CFG.freeboard - 0.6);
          // Sidewalk height on the quay, like a plaza.
          expect(w.driveHeightAt(qq.x, qq.z)).toBeCloseTo(w.heightAt(qq.x, qq.z) + CITY.curbHeight, 6);
        }
        // Wherever the ground is under the water, it is the harbor's water (the wall's face aside).
        const any = c + rng.range(-40, 170);
        const qa = { x: u * p.ux + any * p.vx, z: u * p.uz + any * p.vz };
        if (w.heightAt(qa.x, qa.z) < waterLevel(p, u) - 0.05 && any > c + p.fall) expect(w.surfaceAt(qa.x, qa.z)).toBe('water');
      }
      // Slopes match heights across the wall's face, the fades, the open water and the loading ramps.
      const ramps = city.districts.builds[a.id].hints.filter((h) => h.kind === 'ramp');
      for (let k = 0; k < 400; k++) {
        const r = ramps.length && k % 2 ? ramps[k % ramps.length].values : null;
        const u = r ? rng.range(r[0] - 1, r[0] + r[1] + 1) : rng.range(p.eA0 + 1, p.eB1 - 1);
        const v = r ? coastV(p, u) - rng.range(-1, r[2] + 1) : coastV(p, u) + rng.range(-5, p.vf1 - coastV(p, u) + 5);
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
  it('a race leaves the quay open, as free roam does: a car driven at it through a mouth gets on', () => {
    let entered = 0;
    let tried = 0;
    for (const seed of harborSeeds(53, 4)) {
      const city = createCity(seed);
      const a = harborOf(city.districts.areas)!;
      const b = city.districts.builds[a.id];
      const t = baseTuning();
      for (const world of [createWorld(seed, 'circuit', city), createWorld(seed, 'circuit', city, { openWorld: true })]) {
        // Nothing race only on the quay: the same walls in a race as in free roam.
        expect(world.walls.filter((w) => w.area === a.id).length).toBe(city.blocks.walls.filter((w) => w.area === a.id).length);
        for (const h of b.hints.filter((x) => x.kind === 'quayMouth')) {
          // From the street square to the frontage at the mouth's middle, facing the quay.
          const [pa, pb] = h.points;
          const m = { x: (pa.x + pb.x) / 2, z: (pa.z + pb.z) / 2 };
          const nx = a.params.vx;
          const nz = a.params.vz;
          const c = createCar(m.x - nx * 16, m.z - nz * 16, Math.atan2(nx, nz), world.heightAt(m.x - nx * 16, m.z - nz * 16));
          c.vx = nx * 14;
          c.vz = nz * 14;
          // On: in the quay and 3 m past the gate posts' line.
          const past = uv(a, m.x, m.z).v + 3;
          let on = false;
          for (let k = 0; k < 120 && !on; k++) {
            stepCar(c, t, input({ throttle: 0.6 }), { world });
            collideCarWithWorld(c, t, world);
            if (pointInPolygon(c.x, c.z, a.polygon) && uv(a, c.x, c.z).v > past) on = true;
          }
          tried++;
          if (on) entered++;
        }
      }
    }
    expect(tried).toBeGreaterThan(8);
    // Square at the frontage from the street, through the middle of a mouth, a car reaches the lane along the water
    // (a parked car or a hydrant on the way may stop the odd one).
    expect(entered / tried).toBeGreaterThan(0.85);
  });

  it('rivals racing along the quay never reach the water, finish, and the race replays identically', () => {
    // The first harbor city (from a stream) whose sprint runs down the street along the quay (the harbor goes
    // where the races run, CFG.raceBonus). The route must pass well inside the bar the rivals are held to (30 m): a field's
    // racing line sits a few metres off the route's own line.
    const rng = new Rng(1265);
    let found: { seed: number; w: ReturnType<typeof createWorld>; a: NonNullable<ReturnType<typeof harborOf>> } | null = null;
    const alongOf = (a: NonNullable<ReturnType<typeof harborOf>>) => (x: number, z: number) => {
      const { u, v } = uv(a, x, z);
      return u > a.params.pa && u < a.params.pb ? coastV(a.params, u) - v : Infinity;
    };
    for (let i = 0; i < 60 && !found; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const city = createCity(seed);
      const h = harborOf(city.districts.areas);
      if (!h) continue;
      const cand = createWorld(seed, 'sprint', city);
      const along = alongOf(h);
      if (Math.min(...cand.route.points.map((q) => along(q.x, q.z))) < 24) found = { seed, w: cand, a: h };
    }
    expect(found).not.toBeNull();
    const { seed, w, a } = found!;
    const p = a.params;
    const along = alongOf(a);
    let nearest = Infinity;
    const snaps: string[] = [];
    for (let run = 0; run < 2; run++) {
      const race = createRace(raceConfig(seed, 'sprint', 4), w);
      for (let t = 0; t < 60 * 300 && !race.cars.slice(1).every((c) => c.finished); t++) {
        stepRace(race, input({}));
        if (run) continue;
        for (const rc of race.cars.slice(1)) {
          const { u, v } = uv(a, rc.state.x, rc.state.z);
          expect(v).toBeLessThan(coastV(p, u) - 0.2);
          nearest = Math.min(nearest, along(rc.state.x, rc.state.z));
        }
      }
      // Every rival finishes past the open quay, the same way both times.
      expect(race.cars.slice(1).every((c) => c.finished)).toBe(true);
      snaps.push(carSnapshot(race));
    }
    expect(snaps[1]).toBe(snaps[0]);
    // They did race past it.
    expect(nearest).toBeLessThan(30);
  });
});

describe('waterfront (render)', () => {
  it('draws every wall it owns, the water out past the far ridge and the dressing, with no stray vertex', () => {
    for (const { worlds, a } of [cities[0], cities[cities.length - 1]]) {
      const world = worlds[0];
      const walls = new Map<WallLook, Wall[]>();
      for (const w of world.walls) if (w.kind === 'wall' && w.look) (walls.get(w.look) ?? walls.set(w.look, []).get(w.look)!).push(w);
      const kit = makeKit(world, walls);
      const group = kit.group;
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
      if (a.variant === 'marina') {
        // The marina adds its boats and docks to the shared builders: more glow and paint than the same quay without it.
        expect(kit.paint.vertexCount).toBeGreaterThan(200);
        expect(kit.glow.vertexCount).toBeGreaterThan(1000);
      }
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

/** A district kit over a world (its walls by look) with fresh builders, as the scene builds one. */
function makeKit(world: World, walls: Map<WallLook, Wall[]> = wallsByLook(world)): DistrictKit {
  return {
    world,
    h: world.heightAt,
    solid: new GeoBuilder(true),
    ground: new GeoBuilder(true),
    paint: new GeoBuilder(true),
    glow: new GeoBuilder(true),
    hazard: new GeoBuilder(),
    foliage: new GeoBuilder(true),
    trees: new GeoBuilder(true),
    group: new THREE.Group(),
    race: { solid: new GeoBuilder(true), glow: new GeoBuilder(true), group: new THREE.Group() },
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
}

function wallsByLook(world: World): Map<WallLook, Wall[]> {
  const walls = new Map<WallLook, Wall[]>();
  for (const w of world.walls) if (w.kind === 'wall' && w.look) (walls.get(w.look) ?? walls.set(w.look, []).get(w.look)!).push(w);
  return walls;
}

/**
 * Cells (0.5 m) of a harbor's quay a car can stand on in `world`: flooded from the lane, through every cell
 * clear of walls and solids at radius r (props are destructible, so they never stop the flood). Keyed i * 1e5 + j.
 */
function quayReach(world: World, a: Area, r: number): Set<number> {
  const p = a.params;
  const out: Contact[] = [];
  const C = 0.5;
  const key = (i: number, j: number) => i * 100000 + j;
  const ok = new Map<number, boolean>();
  const pass = (i: number, j: number) => {
    const k = key(i, j);
    let v = ok.get(k);
    if (v === undefined) {
      const x = i * C;
      const z = j * C;
      const { u, v: vv } = uv(a, x, z);
      v = u > p.pa && u < p.pb && vv < coastV(p, u) && pointInPolygon(x, z, a.polygon) && world.collideCircle(x, z, r, out) === 0;
      ok.set(k, v);
    }
    return v;
  };
  const reach = new Set<number>();
  const stack: [number, number][] = [];
  for (let u = p.pa + 5; u < p.pb - 5; u += 25) {
    const d = (CFG.yard.lane[0] + CFG.yard.lane[1]) / 2;
    stack.push([Math.round((u * p.ux + (coastV(p, u) - d) * p.vx) / C), Math.round((u * p.uz + (coastV(p, u) - d) * p.vz) / C)]);
  }
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const k = key(i, j);
    if (reach.has(k) || !pass(i, j)) continue;
    reach.add(k);
    stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
  return reach;
}

describe('waterfront (yard)', () => {
  it('nothing drawn on the quay that a car drives through, nor a wall with nothing drawn, even with the race scene lent to free roam', () => {
    // The menu's street stage is built from the race world and lends its scene to free roam (game/streetStage.ts lend),
    // whose world is the open one: what the harbor draws in the race world must collide in the open world.
    for (const { city, worlds, a } of cities) {
      const open = createWorld(city.seed, 'circuit', city, { openWorld: true });
      const kit = makeKit(worlds[0]);
      waterfrontRenderer.build(kit, [a]);
      const reach = quayReach(open, a, 0.7);
      const key = (x: number, z: number) => Math.round(x / 0.5) * 100000 + Math.round(z / 0.5);
      const drawn = new Set<number>();
      const ghosts: string[] = [];
      for (const gb of [kit.solid, kit.glow]) {
        const P = gb.positions;
        const I = gb.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
          const A = I[t] * 3;
          const B = I[t + 1] * 3;
          const Cc = I[t + 2] * 3;
          const e1 = [P[B] - P[A], P[B + 1] - P[A + 1], P[B + 2] - P[A + 2]];
          const e2 = [P[Cc] - P[A], P[Cc + 1] - P[A + 1], P[Cc + 2] - P[A + 2]];
          const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          const len = Math.hypot(n[0], n[1], n[2]);
          // Upright faces only: the sides of whatever stands on the quay.
          if (len < 1e-6 || Math.abs(n[1] / len) > 0.4) continue;
          const steps = Math.min(24, Math.max(2, Math.ceil(Math.sqrt(len / 2) / 0.25)));
          for (let s1 = 0; s1 <= steps; s1++) {
            for (let s2 = 0; s2 <= steps - s1; s2++) {
              const w1 = s1 / steps;
              const w2 = s2 / steps;
              const x = P[A] + e1[0] * w1 + e2[0] * w2;
              const y = P[A + 1] + e1[1] * w1 + e2[1] * w2;
              const z = P[A + 2] + e1[2] * w1 + e2[2] * w2;
              const g = open.driveHeightAt(x, z);
              // At a car body's height over the ground.
              if (y < g + 0.25 || y > g + 1.2) continue;
              drawn.add(key(x, z));
              const i = Math.round(x / 0.5);
              const j = Math.round(z / 0.5);
              const k = (di: number, dj: number) => (i + di) * 100000 + (j + dj);
              if (reach.has(k(0, 0)) && reach.has(k(1, 0)) && reach.has(k(-1, 0)) && reach.has(k(0, 1)) && reach.has(k(0, -1))) ghosts.push(`${x.toFixed(1)},${z.toFixed(1)}`);
            }
          }
        }
      }
      expect(ghosts.slice(0, 5), `${city.seed} drawn but drivable through`).toEqual([]);
      // Every wall the harbor owns has something drawn on it.
      for (const w of open.walls) {
        if (w.area !== a.id) continue;
        const x = (w.ax + w.bx) / 2 - w.nx * 0.15;
        const z = (w.az + w.bz) / 2 - w.nz * 0.15;
        let hit = false;
        for (let di = -1; di <= 1 && !hit; di++) for (let dj = -1; dj <= 1 && !hit; dj++) if (drawn.has(key(x + di * 0.5, z + dj * 0.5))) hit = true;
        expect(hit, `${city.seed} ${w.look} at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(true);
      }
    }
  });

  it('the quay is drivable end to end, and every mouth onto it is open', () => {
    for (const { city, a } of cities) {
      const open = createWorld(city.seed, 'circuit', city, { openWorld: true });
      const p = a.params;
      // A car's width clear of every wall and solid from one end of the quay to the other.
      const reach = quayReach(open, a, 1.2);
      let lo = Infinity;
      let hi = -Infinity;
      for (const k of reach) {
        const i = Math.round(k / 100000);
        const j = k - i * 100000;
        const u = uv(a, i * 0.5, j * 0.5).u;
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
      }
      expect(lo, `${city.seed}`).toBeLessThan(p.pa + 8);
      expect(hi, `${city.seed}`).toBeGreaterThan(p.pb - 8);
      const b = city.districts.builds[a.id];
      const mouths = b.hints.filter((h) => h.kind === 'quayMouth');
      expect(mouths.length, `${city.seed}`).toBeGreaterThan(0);
      for (const h of mouths) {
        // Across the mouth between its posts, clear of walls and props, on the quay and onto the sidewalk before it.
        const [pa, pb] = h.points;
        const span = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        for (let s = 1.5; s < span - 1.5; s += 1) {
          for (const dv of [-3, 0, 3]) {
            const x = pa.x + ((pb.x - pa.x) * s) / span + p.vx * dv;
            const z = pa.z + ((pb.z - pa.z) * s) / span + p.vz * dv;
            expect(open.collideCircle(x, z, 0.9, []), `${city.seed} mouth at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(0);
            expect(open.props.some((q) => Math.hypot(q.x - x, q.z - z) < q.radius + 0.6), `${city.seed} prop in the mouth at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(false);
          }
        }
      }
    }
  });

  it('lays out a skid pad, loading ramps at 6%, and on working docks containers and forklifts off the lane', () => {
    for (const { city, worlds, a } of cities) {
      const w = worlds[0];
      const p = a.params;
      const b = city.districts.builds[a.id];
      // The skid pad is a drift zone, clear of walls and props.
      const pad = b.hints.find((h) => h.kind === 'skidPad');
      expect(pad, `${city.seed}`).toBeDefined();
      const zone = driftZones(w).find((z) => z.kind === 'dock');
      expect(zone?.area).toBe(a.id);
      const [cx, cz, r] = pad!.values;
      expect(r).toBeGreaterThanOrEqual(CFG.yard.pad[0]);
      expect(w.wallClearance(cx, cz, r + 2)).toBeGreaterThan(r);
      expect(w.props.some((q) => Math.hypot(q.x - cx, q.z - cz) < r + q.radius)).toBe(false);
      // Ramps: never steeper than about 6% along the quay, back to the plain quay at their ends.
      for (const h of b.hints.filter((x) => x.kind === 'ramp')) {
        const [u0, span] = h.values;
        // The ramp's own slope: the world's less the landscape's.
        const base = createTerrain(city.seed);
        let steepest = 0;
        for (let u = u0; u <= u0 + span; u += 0.5) {
          const q = { x: u * p.ux + (coastV(p, u) - 6) * p.vx, z: u * p.uz + (coastV(p, u) - 6) * p.vz };
          const sl = w.slopeAt(q.x, q.z);
          const s0 = base.slopeAt(q.x, q.z);
          steepest = Math.max(steepest, Math.abs((sl.gx - s0.gx) * p.ux + (sl.gz - s0.gz) * p.uz));
        }
        expect(steepest).toBeGreaterThan(0.05);
        expect(steepest).toBeLessThan(0.066);
      }
      // Solids stand off the lane along the water.
      for (const wall of w.walls) {
        if (wall.area !== a.id || !wall.solid || (wall.look !== 'container' && wall.look !== 'forklift')) continue;
        for (const q of [{ x: wall.ax, z: wall.az }, { x: wall.bx, z: wall.bz }]) {
          const { u, v } = uv(a, q.x, q.z);
          expect(coastV(p, u) - v).toBeGreaterThan(CFG.yard.lane[1] - 0.05);
        }
      }
      const kinds = new Set(b.walls.map((x) => x.look));
      if (a.variant === 'marina') expect(kinds.has('container')).toBe(false);
    }
    // Working docks get the container lane and a forklift (on the harbor cities that have the room).
    expect(cities.filter((c) => c.a.variant === 'harbor').some((c) => c.city.districts.builds[c.a.id].walls.some((x) => x.look === 'container'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The beach variant (districts/waterfrontBeach.ts)

const BEACH = CFG.beach;

/** Seeds (from a stream) whose waterfront plans as a beach: rolled by the beach stream (cheap), then planned. */
function beachSeeds(stream: number, want: number): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 4000 && out.length < want; i++) {
    const seed = rng.int(0, 0x7fffffff);
    if (!waterfrontRolled(seed) || !beachRolled(seed)) continue;
    if (harborOf(planRoads(seed).districts.areas)?.variant === 'beach') out.push(seed);
  }
  return out;
}

const beaches: { city: City; worlds: World[]; a: Area }[] = beachSeeds(88, 3).map((seed) => {
  const city = createCity(seed);
  return { city, worlds: [createWorld(seed, 'circuit', city), createWorld(seed, 'sprint', city)], a: harborOf(city.districts.areas)! };
});

/** The world point d m in from the waterline at u (beach frame). */
const beachPt = (a: Area, u: number, d: number) => {
  const p = a.params;
  return { x: u * p.ux + (coastV(p, u) - d) * p.vx, z: u * p.uz + (coastV(p, u) - d) * p.vz };
};

/** Cells (0.5 m) of a beach a car of radius r can stand on: flooded from the boardwalk's middle through every cell clear of walls and solids. Keyed i * 1e5 + j. */
function beachReach(world: World, a: Area, r: number): Set<number> {
  const p = a.params;
  const out: Contact[] = [];
  const C = 0.5;
  const key = (i: number, j: number) => i * 100000 + j;
  const ok = new Map<number, boolean>();
  const pass = (i: number, j: number) => {
    const k = key(i, j);
    let v = ok.get(k);
    if (v === undefined) {
      const x = i * C;
      const z = j * C;
      const q = uv(a, x, z);
      v = q.u > p.pa && q.u < p.pb && q.v < coastV(p, q.u) && pointInPolygon(x, z, a.polygon) && world.collideCircle(x, z, r, out) === 0;
      ok.set(k, v);
    }
    return v;
  };
  const reach = new Set<number>();
  const stack: [number, number][] = [];
  for (let u = p.pa + 5; u < p.pb - 5; u += 25) {
    const q = beachPt(a, u, p.sand + 7);
    stack.push([Math.round(q.x / C), Math.round(q.z / C)]);
  }
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const k = key(i, j);
    if (reach.has(k) || !pass(i, j)) continue;
    reach.add(k);
    stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
  return reach;
}

describe('waterfront (beach)', () => {
  it('is likelier in a Miami home, a variant of the waterfronts the beach stream rolls, and the home is the renderer\'s', () => {
    // The city reads the home through shared/home.ts; the renderer's identity is the same pick.
    const rng = new Rng(5);
    for (let i = 0; i < 40; i++) {
      const seed = rng.int(0, 0x7fffffff);
      expect(cityIdentity(seed).home).toBe(homeOf(seed));
    }
    let miami = 0;
    let other = 0;
    let nMiami = 0;
    let nOther = 0;
    const r2 = new Rng(6);
    for (let i = 0; i < 6000; i++) {
      const seed = r2.int(0, 0x7fffffff);
      const roll = beachRolled(seed);
      if (homeOf(seed) === 'miami') {
        nMiami++;
        if (roll) miami++;
      } else {
        nOther++;
        if (roll) other++;
      }
    }
    expect(miami / nMiami).toBeGreaterThan(BEACH.chance.miami - 0.06);
    expect(miami / nMiami).toBeLessThan(BEACH.chance.miami + 0.06);
    expect(other / nOther).toBeGreaterThan(BEACH.chance.other - 0.03);
    expect(other / nOther).toBeLessThan(BEACH.chance.other + 0.03);
    // A Miami waterfront is mostly a beach, the others rarely; a rolled beach that finds no flat enough stretch is the harbor it would have been.
    expect(beaches.length).toBeGreaterThanOrEqual(3);
    for (const { a } of beaches) {
      expect(a.variant).toBe('beach');
      expect(a.params.pb - a.params.pa).toBeGreaterThanOrEqual(BEACH.minLength - 1e-6);
      expect(a.params.beach).toBe(1);
    }
  });

  it('plans and builds the same beach every time', () => {
    const { city, a } = beaches[0];
    const again = createCity(city.seed);
    const b = harborOf(again.districts.areas)!;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(again.districts.builds[b.id])).toBe(JSON.stringify(city.districts.builds[a.id]));
    expect(JSON.stringify(again.blocks.walls)).toBe(JSON.stringify(city.blocks.walls));
  });

  it('the sand slopes from the waterline at its tuned grade, the boardwalk is the street\'s ground, with exact slopes throughout', () => {
    const rng = new Rng(11);
    for (const { city, worlds, a } of beaches) {
      const w = worlds[0];
      const p = a.params;
      const base = createTerrain(city.seed);
      const b = city.districts.builds[a.id];
      const dunes = b.hints.filter((h) => h.kind === 'dune');
      const onDune = (u: number) => dunes.some((h) => u > h.values[0] - 1 && u < h.values[0] + h.values[1] + 1);
      for (let k = 0; k < 300; k++) {
        const u = rng.range(p.pa + 5, p.pb - 5);
        // At the waterline the drive height is the water's surface; the sand rises by the slope inland.
        const d = rng.range(0.5, 3);
        const q = beachPt(a, u, d);
        if (!onDune(u)) {
          expect(w.surfaceAt(q.x, q.z)).toBe('sand');
          // (The sand blends into the street's ground over its whole width, so a few centimetres off the pure profile near the water.)
          expect(Math.abs(w.driveHeightAt(q.x, q.z) - (waterLevel(p, u) + p.slope * d))).toBeLessThan(0.12);
        }
        // Out on the water: 'water', the sea floor under the surface.
        const out = coastV(p, u) + rng.range(p.fall + 0.05, 170);
        const qw = { x: u * p.ux + out * p.vx, z: u * p.uz + out * p.vz };
        expect(w.surfaceAt(qw.x, qw.z)).toBe('water');
        expect(Math.abs(w.heightAt(qw.x, qw.z) - (waterLevel(p, u) - p.depth))).toBeLessThan(1e-6);
        // Past the dune edge the ground is the street's: the plain landscape, planks over it at curb height.
        const qb = beachPt(a, u, p.sand + rng.range(0.5, 6));
        if (pointInPolygon(qb.x, qb.z, a.polygon) && !onDune(u)) {
          expect(w.heightAt(qb.x, qb.z)).toBe(base.heightAt(qb.x, qb.z));
          expect(['boardwalk', 'cobble']).toContain(w.surfaceAt(qb.x, qb.z));
        }
      }
      // Slopes match heights across the sand, the shelf, the open water and the dunes.
      for (let k = 0; k < 400; k++) {
        const u = rng.range(p.eA0 + 1, p.eB1 - 1);
        const v = coastV(p, u) + rng.range(-p.sand - 3, p.vf1 - coastV(p, u) + 5);
        const x = u * p.ux + v * p.vx;
        const z = u * p.uz + v * p.vz;
        const s = w.slopeAt(x, z);
        const e = 0.002;
        const gx = (w.heightAt(x + e, z) - w.heightAt(x - e, z)) / (2 * e);
        const gz = (w.heightAt(x, z + e) - w.heightAt(x, z - e)) / (2 * e);
        expect(Math.abs(s.gx - gx)).toBeLessThan(2e-3 * Math.max(1, Math.abs(gx)));
        expect(Math.abs(s.gz - gz)).toBeLessThan(2e-3 * Math.max(1, Math.abs(gz)));
      }
      for (const h of dunes) {
        // A dune ridge is the terrain rule's 6% at its steepest, back to the plain ground at its ends.
        const [u0, span, crest, H] = h.values;
        const mod = duneMod(p, harborFrame(a), u0, crest);
        const hs = { h: 0, gx: 0, gz: 0 };
        let steepest = 0;
        let top = 0;
        for (let u = u0; u <= u0 + span; u += 0.5) {
          for (let d = crest - 20; d <= crest + 20; d += 0.5) {
            const q = beachPt(a, u, d);
            hs.h = hs.gx = hs.gz = 0;
            mod.add(q.x, q.z, hs);
            steepest = Math.max(steepest, Math.hypot(hs.gx, hs.gz));
            top = Math.max(top, hs.h);
          }
        }
        expect(steepest).toBeGreaterThan(0.05);
        expect(steepest).toBeLessThan(0.066);
        expect(top).toBeCloseTo(H, 2);
      }
    }
  });

  it('walls: the surf end to end with its normals onto the sand, towers, pier and posts, never on a road; nothing else', () => {
    for (const { city, worlds, a } of beaches) {
      const p = a.params;
      const g = city.graph;
      const walls = city.blocks.walls.filter((w) => w.area === a.id);
      const looks = new Set(walls.map((w) => w.look));
      for (const l of looks) expect(['surf', 'quayFence', 'quayPost', 'lifeguard', 'pier', 'tree', 'warehouse']).toContain(l);
      expect(looks.has('surf')).toBe(true);
      expect(looks.has('quayRail')).toBe(false);
      const scratch: number[] = [];
      for (const w of walls) {
        expect(WALL_LOOKS).toContain(w.look);
        for (const t of [0.1, 0.5, 0.9]) {
          const x = w.ax + (w.bx - w.ax) * t;
          const z = w.az + (w.bz - w.az) * t;
          city.blocks.edgeGrid.query(x - 1, z - 1, x + 1, z + 1, scratch);
          for (const id of scratch) {
            const e = g.edges[id];
            const A = g.nodes[e.a];
            const B2 = g.nodes[e.b];
            const s = segmentT(x, z, A.x, A.z, B2.x, B2.z);
            if (s * e.length < 1.5 || (1 - s) * e.length < 1.5) continue;
            expect(distToSegment(x, z, A.x, A.z, B2.x, B2.z)).toBeGreaterThan(e.width / 2 - 0.05);
          }
        }
      }
      const surf = walls.filter((w) => w.look === 'surf');
      let covered = 0;
      for (let i = 0; i < surf.length; i++) {
        covered += Math.hypot(surf[i].bx - surf[i].ax, surf[i].bz - surf[i].az);
        if (i) expect(Math.hypot(surf[i].ax - surf[i - 1].bx, surf[i].az - surf[i - 1].bz)).toBeLessThan(1e-6);
        expect(surf[i].nx * p.vx + surf[i].nz * p.vz).toBeLessThan(-0.8);
        // The surf stands up the sand from the waterline, so the water is never reached.
        const { u, v } = uv(a, surf[i].ax, surf[i].az);
        expect(coastV(p, u) - v).toBeCloseTo(BEACH.surfInset, 1);
      }
      expect(covered).toBeGreaterThan(p.pb - p.pa - 1);
      expect(walls.filter((w) => w.look === 'quayFence').length).toBe(2);
      // No race route runs on the sand or the planks.
      for (const w of worlds) {
        for (const q of w.route.points) {
          const { u, v } = uv(a, q.x, q.z);
          expect(v).toBeLessThan(coastV(p, u) - p.sand);
          expect(['sand', 'water']).not.toContain(w.surfaceAt(q.x, q.z));
        }
      }
    }
  });

  it('the boardwalk and the sand are drivable end to end, every mouth is open, a car at speed stops at the surf', () => {
    let mouthCount = 0;
    for (const { city, a } of beaches) {
      const open = createWorld(city.seed, 'circuit', city, { openWorld: true });
      const p = a.params;
      const reach = beachReach(open, a, 1.2);
      let lo = Infinity;
      let hi = -Infinity;
      let sandCells = 0;
      let boardCells = 0;
      for (const k of reach) {
        const i = Math.round(k / 100000);
        const j = k - i * 100000;
        const { u, v } = uv(a, i * 0.5, j * 0.5);
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
        if (coastV(p, u) - v < p.sand) sandCells++;
        else boardCells++;
      }
      expect(lo, `${city.seed}`).toBeLessThan(p.pa + 8);
      expect(hi, `${city.seed}`).toBeGreaterThan(p.pb - 8);
      // Both the planks and a good deal of the sand are reachable from the lane.
      expect(boardCells).toBeGreaterThan(2000);
      expect(sandCells).toBeGreaterThan(4000);
      const b = city.districts.builds[a.id];
      const mouths = b.hints.filter((h) => h.kind === 'quayMouth');
      mouthCount += mouths.length;
      for (const h of mouths) {
        const [pa, pb] = h.points;
        const span = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        for (let s = 1.5; s < span - 1.5; s += 1) {
          for (const dv of [-3, 0, 3]) {
            const x = pa.x + ((pb.x - pa.x) * s) / span + p.vx * dv;
            const z = pa.z + ((pb.z - pa.z) * s) / span + p.vz * dv;
            expect(open.collideCircle(x, z, 0.9, []), `${city.seed} mouth at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(0);
            expect(open.props.some((q) => Math.hypot(q.x - x, q.z - z) < q.radius + 0.6), `${city.seed} prop in the mouth at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(false);
          }
        }
      }
      // Flat out at the water from the boardwalk, square and glancing, a car stops at the surf, twice the same.
      const snaps: string[] = [];
      for (let run = 0; run < 2; run++) {
        const log: string[] = [];
        for (const t of [0.3, 0.7]) {
          const u = p.pa + (p.pb - p.pa) * t;
          for (const ang of [0, 0.5]) {
            const q = beachPt(a, u, p.sand + 4);
            const dx = p.vx * cos(ang) + p.ux * sin(ang);
            const dz = p.vz * cos(ang) + p.uz * sin(ang);
            const cfg = { ...raceConfig(city.seed, 'circuit', 0), openWorld: true, start: { x: q.x, z: q.z, yaw: Math.atan2(dx, dz), speed: 22, tick: 0 } };
            const race = createRace(cfg, open);
            const car = race.cars[0].state;
            for (let i = 0; i < 300; i++) {
              stepRace(race, input({ throttle: 1 }));
              const c = uv(a, car.x, car.z);
              expect(c.v).toBeLessThan(coastV(p, c.u) - 0.2);
              expect(open.surfaceAt(car.x, car.z)).not.toBe('water');
            }
            log.push(JSON.stringify([car.x, car.z, car.yaw]));
          }
        }
        snaps.push(log.join('|'));
      }
      expect(snaps[1]).toBe(snaps[0]);
    }
    // Streets meet the beach in mouths (a city whose streets all stop short of the frontage gets none, and its fences have gaps).
    expect(mouthCount).toBeGreaterThan(2);
  });

  it('sand is slow and slidey, the boardwalk firm: the same pull gets a car half as far on the sand', () => {
    const t = baseTuning();
    expect(t.surface.sandGrip).toBeLessThan(t.surface.cobbleGrip);
    expect(t.surface.sandGrip).toBeLessThan(t.surface.quayGrip);
    expect(t.surface.sandDrag).toBeGreaterThan(t.surface.cobbleDrag);
    // Flat out for four seconds from rest on each (a flat world with the one surface): sand's speed is under 60% of the planks'.
    const speedOn = (surface: string): number => {
      const world = { ...flatWorld(), surfaceAt: () => surface } as unknown as World;
      const c = createCar(0, 0, 0, 0);
      for (let i = 0; i < 240; i++) stepCar(c, t, input({ throttle: 1 }), { world });
      return c.speed;
    };
    expect(speedOn('sand')).toBeLessThan(speedOn('boardwalk') * 0.6);
    expect(speedOn('sand')).toBeGreaterThan(5);
    // The planks drive as cobbles, to the bit.
    expect(speedOn('boardwalk')).toBe(speedOn('cobble'));
  });

  it('lays out a drift strip on the hard sand (a zone of kind beach), dunes, towers, courts and the pier', () => {
    for (const { city, worlds, a } of beaches) {
      const w = worlds[0];
      const p = a.params;
      const b = city.districts.builds[a.id];
      const strip = b.hints.find((h) => h.kind === 'beachZone');
      if (strip) {
        const zone = driftZones(w).find((z) => z.kind === 'beach');
        expect(zone?.area).toBe(a.id);
        const [u0, u1, d0, d1] = strip.values;
        const mid = beachPt(a, (u0 + u1) / 2, (d0 + d1) / 2);
        expect(driftZones(w).some((z) => pointInPolygon(mid.x, mid.z, z.polygon))).toBe(true);
        expect(u1 - u0).toBeGreaterThanOrEqual(BEACH.zoneLength[0] - 1e-6);
        // Nothing stands in it: no wall, no prop.
        for (let u = u0; u <= u1; u += 4) {
          for (let d = d0; d <= d1; d += 1.5) {
            const q = beachPt(a, u, d);
            expect(w.collideCircle(q.x, q.z, 0.9, [])).toBe(0);
            expect(w.props.some((pr) => Math.hypot(pr.x - q.x, pr.z - q.z) < pr.radius + 0.9)).toBe(false);
          }
        }
        // The strip lies on the sand.
        expect(w.surfaceAt(mid.x, mid.z)).toBe('sand');
      }
      expect(b.hints.some((h) => h.kind === 'dune')).toBe(true);
      expect(b.hints.filter((h) => h.kind === 'lifeguard').length).toBeGreaterThanOrEqual(1);
      expect(b.destructibles.filter((d) => d.kind === 'umbrella').length).toBeGreaterThan(1);
      expect(b.props.filter((q) => q.kind === 'palm').length).toBeGreaterThan(10);
      // Palms are the sim's solid trunks.
      expect(b.walls.filter((x) => x.look === 'tree').length).toBe(b.props.filter((q) => q.kind === 'palm').length * 6);
      // The pier (when the boardwalk had room) is a solid from the boardwalk to the waterline.
      for (const h of b.hints.filter((x) => x.kind === 'pier')) {
        const [root, tip] = h.points;
        expect(frameV(harborFrame(a), tip.x, tip.z)).toBeGreaterThan(coastV(p, frameU(harborFrame(a), tip.x, tip.z)) + 30);
        expect(frameV(harborFrame(a), root.x, root.z)).toBeLessThan(coastV(p, frameU(harborFrame(a), root.x, root.z)) - p.sand);
        expect(b.walls.filter((x) => x.look === 'pier').length).toBe(4);
      }
    }
  });

  it('rivals racing past a beach never reach the sea, finish, and the race replays identically', () => {
    const { city, a } = beaches[0];
    const p = a.params;
    for (const kind of ['sprint', 'circuit'] as const) {
      const w = createWorld(city.seed, kind, city);
      const snaps: string[] = [];
      for (let run = 0; run < 2; run++) {
        const race = createRace(raceConfig(city.seed, kind, 4), w);
        for (let t = 0; t < 60 * 300 && !race.cars.slice(1).every((c) => c.finished); t++) {
          stepRace(race, input({}));
          if (run) continue;
          for (const rc of race.cars.slice(1)) {
            const { u, v } = uv(a, rc.state.x, rc.state.z);
            expect(v).toBeLessThan(coastV(p, u) - 0.2);
          }
        }
        expect(race.cars.slice(1).every((c) => c.finished)).toBe(true);
        snaps.push(carSnapshot(race));
      }
      expect(snaps[1]).toBe(snaps[0]);
    }
  });

  it('draws every wall it owns and nothing a car drives through, with the race scene lent to free roam', () => {
    for (const { city, worlds, a } of beaches) {
      const open = createWorld(city.seed, 'circuit', city, { openWorld: true });
      // The same walls in the race world and the open one: nothing race only on the beach.
      expect(worlds[0].walls.filter((w) => w.area === a.id).length).toBe(open.walls.filter((w) => w.area === a.id).length);
      const kit = makeKit(worlds[0]);
      waterfrontRenderer.build(kit, [a]);
      const names = kit.group.children.map((c) => c.name);
      expect(names).toContain('harborWater');
      expect(names).toContain('beachSurf');
      for (const gb of [kit.solid, kit.ground, kit.paint, kit.glow, kit.trees, kit.foliage]) {
        expect(gb.vertexCount).toBeGreaterThan(0);
        for (const v of gb.positions) expect(Number.isFinite(v)).toBe(true);
      }
      // Every look draws something of its own.
      for (const look of ['surf', 'lifeguard', 'pier', 'quayPost', 'quayFence'] as const) {
        const own = (kit.walls.get(look) ?? []).filter((w) => w.area === a.id);
        if (!own.length) continue;
        const only = new Map<WallLook, Wall[]>([[look, own]]);
        const k2 = { ...makeKit(worlds[0], only), group: new THREE.Group() };
        waterfrontRenderer.build(k2, [a]);
        expect(k2.solid.vertexCount, look).toBeGreaterThan(0);
      }
      // Each wall has geometry within a metre or two of its middle, in the builders that stand things up.
      const spots: Vec3[] = [];
      for (const gb of [kit.solid, kit.glow, kit.trees]) for (let i = 0; i < gb.positions.length; i += 3) spots.push([gb.positions[i], gb.positions[i + 1], gb.positions[i + 2]]);
      const cell = new Map<number, number>();
      for (const [x, , z] of spots) cell.set(Math.round(x / 2) * 100000 + Math.round(z / 2), 1);
      for (const w of open.walls) {
        if (w.area !== a.id) continue;
        const x = (w.ax + w.bx) / 2 - w.nx * 0.15;
        const z = (w.az + w.bz) / 2 - w.nz * 0.15;
        let hit = false;
        for (let di = -1; di <= 1 && !hit; di++) for (let dj = -1; dj <= 1 && !hit; dj++) if (cell.has((Math.round(x / 2) + di) * 100000 + Math.round(z / 2) + dj)) hit = true;
        expect(hit, `${city.seed} ${w.look} at ${x.toFixed(1)},${z.toFixed(1)}`).toBe(true);
      }
      // Nothing drawn upright at a car's height stands where a car can drive: the sides of what is drawn are walls.
      const reach = beachReach(open, a, 0.7);
      const ghosts: string[] = [];
      for (const gb of [kit.solid, kit.glow]) {
        const P = gb.positions;
        const I = gb.indices;
        for (let t = 0; t + 2 < I.length; t += 3) {
          const A = I[t] * 3;
          const B2 = I[t + 1] * 3;
          const Cc = I[t + 2] * 3;
          const e1 = [P[B2] - P[A], P[B2 + 1] - P[A + 1], P[B2 + 2] - P[A + 2]];
          const e2 = [P[Cc] - P[A], P[Cc + 1] - P[A + 1], P[Cc + 2] - P[A + 2]];
          const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          const len = Math.hypot(n[0], n[1], n[2]);
          if (len < 1e-6 || Math.abs(n[1] / len) > 0.4) continue;
          const steps = Math.min(24, Math.max(2, Math.ceil(Math.sqrt(len / 2) / 0.25)));
          for (let s1 = 0; s1 <= steps; s1++) {
            for (let s2 = 0; s2 <= steps - s1; s2++) {
              const x = P[A] + (e1[0] * s1 + e2[0] * s2) / steps;
              const y = P[A + 1] + (e1[1] * s1 + e2[1] * s2) / steps;
              const z = P[A + 2] + (e1[2] * s1 + e2[2] * s2) / steps;
              const g = open.driveHeightAt(x, z);
              if (y < g + 0.25 || y > g + 1.2) continue;
              const i = Math.round(x / 0.5);
              const j = Math.round(z / 0.5);
              const k = (di: number, dj: number) => (i + di) * 100000 + (j + dj);
              if (reach.has(k(0, 0)) && reach.has(k(1, 0)) && reach.has(k(-1, 0)) && reach.has(k(0, 1)) && reach.has(k(0, -1))) ghosts.push(`${x.toFixed(1)},${z.toFixed(1)}`);
            }
          }
        }
      }
      expect(ghosts.slice(0, 5), `${city.seed} drawn but drivable through`).toEqual([]);
    }
  });
});

type Vec3 = [number, number, number];
