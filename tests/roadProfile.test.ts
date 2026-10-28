import { describe, expect, it } from 'vitest';
import { ROAD_PHYSICS } from '../src/city/config';
import { createCity, createRoute, createWorld } from '../src/city/world';
import type { City, World } from '../src/city/world';
import { lipAt, lipSeries, lipSpread, type Lip } from '../src/city/roadProfile';
import type { HeightSample } from '../src/city/districts/types';
import { highwayDeck } from '../src/city/districts/highway/shape';
import { deckPoint } from '../src/city/districts/highway/shape';
import { createCar, placeCar, stepCar } from '../src/sim/car';
import { Rng } from '../src/sim/prng';
import { ROAD } from '../src/sim/tuning';
import { baseTuning, carSnapshot, input, raceConfig, runAutopilot } from './helpers';

const SEEDS = [20261019, 7, 32];
const cities = new Map<number, City>();
const cityOf = (seed: number): City => {
  let c = cities.get(seed);
  if (!c) cities.set(seed, (c = createCity(seed)));
  return c;
};

/** The profile's height and gradient at a point. */
function sample(city: City, x: number, z: number): HeightSample {
  const out: HeightSample = { h: 0, gx: 0, gz: 0 };
  city.roadProfile.mod.add(x, z, out);
  return out;
}

/** The analytic gradient against central differences, at every point. */
function expectExact(f: (x: number, z: number) => HeightSample, points: { x: number; z: number }[]): void {
  const e = 1e-4;
  for (const p of points) {
    const s = f(p.x, p.z);
    const gx = (f(p.x + e, p.z).h - f(p.x - e, p.z).h) / (2 * e);
    const gz = (f(p.x, p.z + e).h - f(p.x, p.z - e).h) / (2 * e);
    expect(Math.abs(s.gx - gx), `gx at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`).toBeLessThan(2e-5);
    expect(Math.abs(s.gz - gz), `gz at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`).toBeLessThan(2e-5);
  }
}

describe('road profile: crown', () => {
  it('rises toward the middle by the road tuning, flat at the centreline, and its gradient is exact', () => {
    const city = cityOf(20261019);
    const rp = city.roadProfile;
    expect(rp.crowned.length).toBeGreaterThan(100);
    const rng = new Rng(5);
    const pts: { x: number; z: number }[] = [];
    for (const c of rp.crowned) {
      // Mid piece, where the junction fade is long over: the full crown.
      const s = c.clearA + ROAD_PHYSICS.crown.junctionRamp + (c.len - c.clearA - c.clearB - 2 * ROAD_PHYSICS.crown.junctionRamp) / 2;
      const mid = { x: c.ax + c.ux * s, z: c.az + c.uz * s };
      const centre = sample(city, mid.x, mid.z);
      if (c.len > c.clearA + c.clearB + 2 * ROAD_PHYSICS.crown.junctionRamp + 4) {
        // The edge's own crown, unless a neighbour overlaps it (the higher wins), so never below.
        expect(centre.h).toBeGreaterThanOrEqual(c.rise - 1e-9);
      }
      const d = rng.range(-0.9, 0.9) * c.half;
      const x = mid.x - c.uz * d;
      const z = mid.z + c.ux * d;
      if (pts.length < 60) pts.push({ x, z });
      // The kerb is where it meets the plain street: no crown at the strip's edge.
      const kerb = sample(city, mid.x - c.uz * (c.half - 1e-6), mid.z + c.ux * (c.half - 1e-6));
      expect(kerb.h).toBeLessThan(1e-4);
    }
    expectExact((x, z) => sample(city, x, z), pts);
  });

  it('is flat across a junction and eases in past it', () => {
    const city = cityOf(7);
    const g = city.graph;
    let checked = 0;
    for (const n of g.nodes) {
      if (n.edges.length < 3) continue;
      const here = sample(city, n.x, n.z);
      expect(here.h).toBe(0);
      expect(here.gx).toBe(0);
      expect(here.gz).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
    // Slopes on the street stay inside the cross slope the tuning names, doubled at the kerb.
    const worst = Math.max(...city.roadProfile.crowned.map((c) => (2 * c.rise) / c.half));
    expect(worst).toBeLessThanOrEqual(2 * Math.max(ROAD.crownAvenue, ROAD.crownBoulevard, ROAD.crownDiagonal, ROAD.crownStreet) + 1e-9);
  });

  it('is in the terrain: heightAt and slopeAt of the world agree with finite differences on a crown', () => {
    const city = cityOf(20261019);
    const c = city.roadProfile.crowned.find((p) => p.len > p.clearA + p.clearB + 2 * ROAD_PHYSICS.crown.junctionRamp + 4)!;
    const mid = c.clearA + ROAD_PHYSICS.crown.junctionRamp + (c.len - c.clearA - c.clearB - 2 * ROAD_PHYSICS.crown.junctionRamp) / 2;
    const pts = [-0.6, -0.2, 0.3, 0.7].map((q) => ({ x: c.ax + c.ux * mid - c.uz * q * c.half, z: c.az + c.uz * mid + c.ux * q * c.half }));
    expectExact((x, z) => ({ h: city.terrain.heightAt(x, z), ...city.terrain.slopeAt(x, z) }), pts);
  });
});

describe('road profile: humps', () => {
  it('stand only on plain side streets no route drives, never on avenues or boulevards', () => {
    for (const seed of SEEDS) {
      const city = cityOf(seed);
      const claimed = new Set(city.districts.areas.flatMap((a) => a.edges));
      const humps = city.roadProfile.humps;
      expect(humps.length, `seed ${seed}`).toBeGreaterThan(20);
      for (const h of humps) {
        const e = city.graph.edges[h.edge];
        expect(e.kind, `seed ${seed} edge ${h.edge}`).toBe('street');
        expect(claimed.has(h.edge)).toBe(false);
      }
      // The waypoint route is picked from the finished city, after the humps, and may cross one; the three the layout knows are kept clear.
      for (const kind of ['circuit', 'sprint', 'drag'] as const) {
        const edges = new Set(createRoute(city, kind).edges);
        expect(humps.filter((h) => edges.has(h.edge)).length, `seed ${seed} ${kind}`).toBe(0);
      }
    }
  });

  it('are a cosine bump of the tuned height and length with an exact gradient', () => {
    const city = cityOf(20261019);
    const rp = city.roadProfile;
    const hp = rp.humps[0];
    const out: HeightSample = { h: 0, gx: 0, gz: 0 };
    expect(rp.humpHeightAt(hp.x, hp.z, out)).toBeCloseTo(ROAD.humpHeight, 12);
    expect(rp.humpHeightAt(hp.x + hp.ux * (ROAD.humpLength / 2 + 0.01), hp.z + hp.uz * (ROAD.humpLength / 2 + 0.01))).toBe(0);
    expect(rp.humpHeightAt(hp.x + hp.ux * ROAD.humpLength * 0.25, hp.z + hp.uz * ROAD.humpLength * 0.25)).toBeCloseTo(ROAD.humpHeight / 2, 12);
    const rng = new Rng(11);
    const pts = Array.from({ length: 60 }, () => {
      const u = rng.range(-0.48, 0.48) * ROAD.humpLength;
      const d = rng.range(-0.97, 0.97) * hp.half;
      return { x: hp.x + hp.ux * u - hp.uz * d, z: hp.z + hp.uz * u + hp.ux * d };
    });
    expectExact((x, z) => {
      const s: HeightSample = { h: 0, gx: 0, gz: 0 };
      rp.humpHeightAt(x, z, s);
      return s;
    }, pts);
    // Steepest grade of the bump: under the 6% a crest may launch a car at speed (the terrain rule), plus the road's own cross slope.
    expect((ROAD.humpHeight * Math.PI) / ROAD.humpLength).toBeLessThan(0.075);
  });

  it('are laid out the same every time', () => {
    const a = createCity(32).roadProfile.humps;
    const b = createCity(32).roadProfile.humps;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('road profile: joints', () => {
  it('lip: raised cosine, exact slope, zero past its width', () => {
    const lip: Lip = { h: 0, dh: 0 };
    lipAt(0, lip);
    expect(lip.h).toBeCloseTo(ROAD.jointHeight, 12);
    lipAt(ROAD.jointWidth / 2, lip);
    expect(lip.h).toBe(0);
    for (const d of [-0.2, -0.05, 0.1, 0.22]) {
      lipAt(d, lip);
      const dh = lip.dh;
      const e = 1e-6;
      const a: Lip = { h: 0, dh: 0 };
      const b: Lip = { h: 0, dh: 0 };
      lipAt(d + e, a);
      lipAt(d - e, b);
      expect(Math.abs(dh - (a.h - b.h) / (2 * e))).toBeLessThan(1e-6);
    }
    // Series: one every jointSpacing from `first`, none before it.
    lipSeries(100 + 3 * ROAD.jointSpacing, 100, lip);
    expect(lip.h).toBeCloseTo(ROAD.jointHeight, 12);
    lipSeries(100 + 1.5 * ROAD.jointSpacing, 100, lip);
    expect(lip.h).toBe(0);
    lipSeries(90, 100, lip);
    expect(lip.h).toBe(0);
    // A bridge's spread has a joint on each end line.
    lipSpread(-12, -12, 12, lip);
    expect(lip.h).toBeCloseTo(ROAD.jointHeight, 12);
    lipSpread(12, -12, 12, lip);
    expect(lip.h).toBeCloseTo(ROAD.jointHeight, 12);
  });

  it('stand on the highway deck and the bridge decks only, and lift a car on the deck level alone', () => {
    for (const seed of SEEDS) {
      const city = cityOf(seed);
      const world = createWorld(seed, 'circuit', city, { openWorld: true });
      let joints = 0;
      city.districts.builds.forEach((b, i) => {
        const area = city.districts.areas[i];
        for (const d of b.decks) {
          if (!d.joint) continue;
          joints++;
          // Bridge decks over the channel and the highway's deck chunks: never a ramp (solid or not), never anything else.
          expect(area.kind === 'river' ? d.lower !== undefined : area.kind === 'highway' && area.variant === 'deck' && d.upper !== undefined, `seed ${seed} ${area.kind}`).toBe(true);
        }
      });
      expect(joints, `seed ${seed}`).toBeGreaterThan(0);
      // No body height, no joint: the renderer, props and traffic see the plain deck.
      for (const b of city.districts.builds) {
        for (const d of b.decks) {
          if (!d.joint) continue;
          const p = d.polygon[0];
          const q = { x: (p.x + d.polygon[2].x) / 2, z: (p.z + d.polygon[2].z) / 2 };
          expect(world.heightAt(q.x, q.z)).toBe(city.terrain.heightAt(q.x, q.z));
        }
      }
    }
  });

  it('a highway deck joint lifts the deck level by the lip and nothing else moves', () => {
    const seed = 7;
    const city = cityOf(seed);
    const world = createWorld(seed, 'circuit', city, { openWorld: true });
    const area = city.districts.areas.find((a) => a.kind === 'highway' && a.variant === 'deck')!;
    const deck = highwayDeck(area, city.districts.areas);
    const at = (s: number) => deckPoint(deck.curve, s, 0);
    const first = deck.sW + ROAD.jointSpacing / 2;
    const on = at(first + 4 * ROAD.jointSpacing);
    const off = at(first + 4.5 * ROAD.jointSpacing);
    const y = world.heightAt(on.x, on.z, 1000);
    const lifted = world.heightAt(on.x, on.z, y);
    const bare = world.driveHeightAt(off.x, off.z, y) - world.heightAt(off.x, off.z, y);
    expect(bare).toBeCloseTo(0, 9);
    // The deck's own height there, less the joint: the span's upper() written without it.
    const span = city.districts.builds.flatMap((b) => b.decks).find((d) => d.joint && d.upper && pointIn(d.polygon, on.x, on.z))!;
    const raw: HeightSample = { h: 0, gx: 0, gz: 0 };
    span.upper!(on.x, on.z, raw);
    expect(lifted - raw.h).toBeGreaterThan(ROAD.jointHeight * 0.5);
    expect(lifted - raw.h).toBeLessThanOrEqual(ROAD.jointHeight + 1e-9);
  });
});

function pointIn(poly: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Drive a car at constant speed along (yaw) from (x, z) for `ticks`, and report what the springs and the sound saw. */
function crossing(world: World, x: number, z: number, yaw: number, speed: number, ticks: number, y?: number) {
  const t = baseTuning();
  const c = createCar(0, 0, 0, 0);
  placeCar(c, x, z, yaw, world, y);
  let maxVy = 0;
  let airborne = 0;
  let thumps = 0;
  for (let i = 0; i < ticks; i++) {
    c.vx = Math.sin(c.yaw) * speed;
    c.vz = Math.cos(c.yaw) * speed;
    stepCar(c, t, input({}), { world });
    maxVy = Math.max(maxVy, Math.abs(c.vy));
    if (c.wheels.some((w) => !w.contact)) airborne++;
    thumps += (c.thump[0] > 0 ? 1 : 0) + (c.thump[1] > 0 ? 1 : 0);
  }
  return { maxVy, airborne, thumps };
}

describe('road profile: the car', () => {
  it('crosses a speed hump at 60 km/h with all four wheels down and thumps once per axle', () => {
    const seed = 20261019;
    const city = cityOf(seed);
    const world = createWorld(seed, 'circuit', city, { openWorld: true });
    const hp = city.roadProfile.humps[3];
    const yaw = Math.atan2(hp.ux, hp.uz);
    const r = crossing(world, hp.x - hp.ux * 30, hp.z - hp.uz * 30, yaw, 60 / 3.6, Math.round((60 / (60 / 3.6)) * 60));
    expect(r.airborne).toBe(0);
    expect(r.maxVy).toBeLessThan(0.8);
    expect(r.thumps).toBe(2);
  });

  it('crosses the highway deck joints at 50 m/s without leaving the ground', () => {
    const seed = 7;
    const city = cityOf(seed);
    const world = createWorld(seed, 'circuit', city, { openWorld: true });
    const area = city.districts.areas.find((a) => a.kind === 'highway' && a.variant === 'deck')!;
    const deck = highwayDeck(area, city.districts.areas);
    const s0 = deck.sW + 200;
    const p0 = deckPoint(deck.curve, s0, 3);
    const p1 = deckPoint(deck.curve, s0 + 10, 3);
    const y = world.heightAt(p0.x, p0.z, 1000);
    const r = crossing(world, p0.x, p0.z, Math.atan2(p1.x - p0.x, p1.z - p0.z), 50, 90, y);
    expect(r.airborne).toBe(0);
    expect(r.maxVy).toBeLessThan(1.8);
    // Three joints in the 75 m run, front axle and rear axle each.
    expect(r.thumps).toBeGreaterThanOrEqual(4);
  });

  it('races stay deterministic and the field still finishes with humps and joints about', () => {
    for (const seed of [20261019, 7]) {
      const a = runAutopilot(raceConfig(seed, 'circuit', 3), 420, true);
      const b = runAutopilot(raceConfig(seed, 'circuit', 3), 420, true);
      expect(carSnapshot(a)).toBe(carSnapshot(b));
      expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
      expect(a.cars.every((c) => c.finished), `seed ${seed}`).toBe(true);
    }
  });
});
