import { describe, expect, it } from 'vitest';
import { createCity, createWorld } from '../src/city/world';
import type { City } from '../src/city/world';
import { BUS_BAY, bayFrame, bayHitsCircle, bayInset, bayPoint } from '../src/city/busBays';
import { CITY } from '../src/city/config';
import { isBendNode } from '../src/city/roadGraph';
import { FURNITURE_KINDS, PROP_DEFS } from '../src/city/props';
import { PLANT, ROADWORKS, laneClosures } from '../src/city/districts/roadworks';
import plantModels from '../src/assets/plantModels.json';
import type { Area } from '../src/city/districts/types';
import { createRace, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { yawOf } from '../src/sim/math';
import { Rng } from '../src/sim/prng';
import { carSnapshot, input, raceConfig, replayLog, runAutopilot } from './helpers';

const SEEDS = [42, 20261019, 777, 31337];

/** A roadworks area's street frame: (s along from node a, v in from the closed curb) of a point. */
function zoneFrame(w: City, a: Area) {
  const e = w.graph.edges[a.params.edge];
  const A = w.graph.nodes[e.a];
  const B = w.graph.nodes[e.b];
  const len = Math.hypot(B.x - A.x, B.z - A.z);
  const dx = (B.x - A.x) / len;
  const dz = (B.z - A.z) / len;
  const nx = -dz * a.params.side;
  const nz = dx * a.params.side;
  return (x: number, z: number) => ({ s: (x - A.x) * dx + (z - A.z) * dz, v: e.width / 2 - ((x - A.x) * nx + (z - A.z) * nz) });
}

const zones = (w: City) => w.districts.areas.filter((a) => a.kind === 'roadworks');

describe('bus bays', () => {
  it('are the same every time and only on plain streets, clear of junctions, pillars and lane closures', () => {
    let total = 0;
    for (const seed of SEEDS) {
      const c = createCity(seed);
      expect(JSON.stringify(createCity(seed).blocks.bays)).toBe(JSON.stringify(c.blocks.bays));
      // Bus bays only (a park path's mouth is a bay too, cut where its path crosses: tests/parkMouths).
      const bays = c.blocks.bays.filter((b) => b.kind === 'bus');
      total += bays.length;
      const closed = new Set(zones(c).map((a) => a.params.edge));
      const reserved = c.districts.builds.flatMap((b) => b.reserved);
      bays.forEach((b, i) => {
        expect(b.id).toBe(i);
        expect(b.kind).toBe('bus');
        const e = c.graph.edges[b.edge];
        expect(['street', 'avenue', 'diagonal', 'boulevard']).toContain(e.kind);
        expect(e.shortcut || e.bridge).toBeFalsy();
        expect(closed.has(b.edge)).toBe(false);
        // Away from both junction ends of its block side: crosswalks, corners, traffic lights, alley and
        // shortcut mouths (a bend node between two pieces of the street has none of those).
        if (!isBendNode(c.graph, e.a)) expect(b.s0).toBeGreaterThanOrEqual(BUS_BAY.endClear);
        if (!isBendNode(c.graph, e.b)) expect(b.s1).toBeLessThanOrEqual(b.len - BUS_BAY.endClear);
        // (A bend node, where a street goes on through its kink, is no junction: no crosswalk, corner or light there.)
        for (const n of c.graph.nodes) if (!isBendNode(c.graph, n.id)) for (const p of b.polygon) expect(Math.hypot(p.x - n.x, p.z - n.z)).toBeGreaterThan(BUS_BAY.endClear);
        // No El pillar or stair on its stretch of sidewalk.
        for (const q of reserved) {
          const f = bayFrame(b, q.x, q.z);
          if (f.s > b.s0 - q.r && f.s < b.s1 + q.r) expect(f.v < -q.r || f.v > e.sidewalk + q.r).toBe(true);
        }
        // The shelter stands at the back of the narrowed sidewalk.
        const stops = c.blocks.props.filter((p) => p.bay === b.id);
        expect(stops.length).toBe(1);
        const f = bayFrame(b, stops[0].x, stops[0].z);
        expect(f.v - stops[0].depth!).toBeGreaterThan(b.depth);
        expect(f.v + stops[0].depth!).toBeLessThan(e.sidewalk);
      });
    }
    // Some of the bus stops, not all of them.
    expect(total).toBeGreaterThan(SEEDS.length * 6);
  });

  it('are road where the curb stepped back, with a curb the sim climbs like any other, and nothing stands in them', () => {
    for (const seed of SEEDS.slice(0, 2)) {
      const w = createWorld(seed, 'circuit');
      for (const b of w.blocks.bays) {
        for (let s = b.s0 + 0.25; s < b.s1; s += 0.75) {
          const inset = bayInset(b, s);
          // Inside: road and flat (beyond the curb ramp's reach onto the road).
          if (inset > 0.6) {
            for (const v of [-1, 0, inset - 0.3]) {
              const p = bayPoint(b, s, v);
              expect(w.surfaceAt(p.x, p.z)).toBe('road');
              expect(w.driveHeightAt(p.x, p.z)).toBeCloseTo(w.heightAt(p.x, p.z), 9);
            }
          }
          // Behind the indented curb: sidewalk at full curb height.
          const q = bayPoint(b, s, inset + 0.3);
          expect(w.surfaceAt(q.x, q.z)).toBe('sidewalk');
          expect(w.driveHeightAt(q.x, q.z) - w.heightAt(q.x, q.z)).toBeCloseTo(CITY.curbHeight, 9);
        }
        // No prop reaches into the bay (shelters by their capsule's thickness).
        for (const p of w.props) {
          if (Math.hypot(p.x - b.from.x - b.u.x * (b.s0 + b.s1) / 2, p.z - b.from.z - b.u.z * (b.s0 + b.s1) / 2) > 30) continue;
          expect(bayHitsCircle(b, p.x, p.z, p.depth ?? p.radius, 0), `${p.kind} ${p.id}`).toBe(false);
        }
      }
    }
  });

  it('let a car run the length of the bay along its curb, and its shelter still stops a car driven into it', () => {
    const w = createWorld(42, 'circuit', undefined, { openWorld: true });
    const b = w.blocks.bays[0];
    const shelter = w.props.find((p) => p.bay === b.id)!;
    const launch = (from: { x: number; z: number }, dir: { x: number; z: number }, speed: number) => {
      const r = createRace({ ...raceConfig(42, 'circuit', 0), openWorld: true }, w);
      expect(r.world).toBe(w);
      r.tick = r.countdownTicks;
      r.phase = 'racing';
      const c = r.cars[0].state;
      placeCar(c, from.x, from.z, yawOf(dir.x, dir.z), w);
      c.vx = dir.x * speed;
      c.vz = dir.z * speed;
      for (const wh of c.wheels) wh.spinRate = speed / r.cars[0].tuning.geometry.wheelRadius;
      return r;
    };
    // Down the full depth stretch with the car's side 0.25 m off the back curb: the shelter is behind it.
    const r = launch(bayPoint(b, b.s0 + b.taper + 2.5, 0), b.u, 12);
    const half = r.cars[0].tuning.geometry.halfWidth;
    const hl = r.cars[0].tuning.geometry.halfLength;
    const start = bayPoint(b, b.s0 + b.taper + hl, b.depth - half - 0.25);
    placeCar(r.cars[0].state, start.x, start.z, yawOf(b.u.x, b.u.z), w);
    let ticks = 0;
    while (bayFrame(b, r.cars[0].state.x, r.cars[0].state.z).s < b.s1 - b.taper - hl && ticks < 200) {
      stepRace(r, input({ throttle: 0.15 }));
      ticks++;
    }
    expect(ticks).toBeGreaterThan(30);
    expect(r.brokenProps[shelter.id]).toBe(0);
    expect(r.events.some((e) => e.type === 'prop')).toBe(false);
    // Head on into the shelter's middle from across the bay: it comes down.
    const f = bayFrame(b, shelter.x, shelter.z);
    const from = bayPoint(b, f.s, f.v - 7);
    const l = Math.hypot(shelter.x - from.x, shelter.z - from.z);
    const r2 = launch(from, { x: (shelter.x - from.x) / l, z: (shelter.z - from.z) / l }, 14);
    for (let i = 0; i < 60; i++) stepRace(r2, input({}));
    expect(r2.brokenProps[shelter.id]).toBe(1);
  });
});

describe('neighbourhood furniture', () => {
  it('lines the sidewalks with hydrants, mailboxes, meters, phone booths and vending machines, by neighbourhood', () => {
    const counts: Record<string, number> = {};
    // Meters and mailboxes per neighbourhood: [core, ring, outer].
    const meters = [0, 0, 0];
    const mail = [0, 0, 0];
    for (const seed of SEEDS.slice(0, 3)) {
      const c = createCity(seed);
      const cx = (c.graph.bounds.minX + c.graph.bounds.maxX) / 2;
      const cz = (c.graph.bounds.minZ + c.graph.bounds.maxZ) / 2;
      for (const p of c.blocks.props) {
        if (!(FURNITURE_KINDS as readonly string[]).includes(p.kind)) continue;
        counts[p.kind] = (counts[p.kind] ?? 0) + 1;
        expect(p.area).toBeUndefined();
        const f = Math.exp(-((p.x - cx) ** 2 + (p.z - cz) ** 2) / CITY.downtownRadius ** 2);
        const tier = f > 0.55 ? 0 : f > 0.2 ? 1 : 2;
        if (p.kind === 'parkingMeter') meters[tier]++;
        if (p.kind === 'mailbox') mail[tier]++;
      }
    }
    for (const k of FURNITURE_KINDS) expect(counts[k] ?? 0, k).toBeGreaterThan(20);
    // Downtown is metered; the outer neighbourhoods have the mailboxes.
    expect(meters[0]).toBeGreaterThan(meters[2] * 3);
    expect(mail[2]).toBeGreaterThan(mail[0]);
    // A hydrant is a real knock, a meter barely one (props.test.ts rams them).
    expect(PROP_DEFS.hydrant.mass * PROP_DEFS.hydrant.anchor).toBeGreaterThan(PROP_DEFS.garbageCan.mass * 3);
    expect(PROP_DEFS.parkingMeter.mass * PROP_DEFS.parkingMeter.anchor).toBeLessThan(PROP_DEFS.garbageCan.mass * 1.2);
  });
});

describe('roadworks', () => {
  it('close a short stretch of curb lane on a few streets, the routes among them, the same every time', () => {
    let onCircuit = 0;
    let onSprint = 0;
    for (const seed of SEEDS) {
      const c = createCity(seed);
      const again = createCity(seed);
      const zs = zones(c);
      expect(JSON.stringify(zones(again))).toBe(JSON.stringify(zs));
      expect(JSON.stringify(zs.map((a) => c.districts.builds[a.id]))).toBe(JSON.stringify(zones(again).map((a) => again.districts.builds[a.id])));
      expect(zs.length).toBeGreaterThanOrEqual(2);
      expect(zs.length).toBeLessThanOrEqual(ROADWORKS.perRoute * 2 + ROADWORKS.extra[1]);
      const circuit = createWorld(seed, 'circuit', c).route;
      const sprint = createWorld(seed, 'sprint', c).route;
      if (zs.some((a) => circuit.edges.includes(a.params.edge))) onCircuit++;
      if (zs.some((a) => sprint.edges.includes(a.params.edge))) onSprint++;
      for (const a of zs) {
        const P = a.params;
        const e = c.graph.edges[P.edge];
        const total = P.sB - P.sA + 2 * P.taper;
        expect(total).toBeGreaterThanOrEqual(30 - 1e-9);
        expect(total).toBeLessThanOrEqual(60 + 1e-9);
        // Never on a route's closed side street (the street meets are there).
        for (const r of [circuit, sprint]) {
          if (r.edges.includes(P.edge)) continue;
          expect(r.nodes.includes(e.a) || r.nodes.includes(e.b)).toBe(false);
        }
        // Clear of the junctions at both ends (a bend node between two pieces of the street is none).
        for (const n of [e.a, e.b]) {
          if (isBendNode(c.graph, n)) continue;
          const N = c.graph.nodes[n];
          for (const p of a.polygon) expect(Math.hypot(p.x - N.x, p.z - N.z)).toBeGreaterThan(ROADWORKS.mouthClear);
        }
      }
    }
    expect(onCircuit).toBeGreaterThanOrEqual(SEEDS.length - 1);
    expect(onSprint).toBeGreaterThanOrEqual(SEEDS.length - 1);
  });

  it('leave the rest of the street open: cones and barriers along the closure, the solid plant behind them', () => {
    for (const seed of SEEDS) {
      const c = createCity(seed);
      for (const a of zones(c)) {
        const P = a.params;
        const e = c.graph.edges[P.edge];
        const at = zoneFrame(c, a);
        // An open carriageway well over a lane and a half wide beside the barriers' reach.
        expect(e.width - P.close - ROADWORKS.barrierReach).toBeGreaterThan(7.5);
        const mine = c.blocks.props.filter((p) => p.area === a.id);
        expect(mine.filter((p) => p.kind === 'trafficCone').length).toBeGreaterThanOrEqual(8);
        expect(mine.filter((p) => p.kind === 'waterBarrier').length).toBeGreaterThanOrEqual(5);
        for (const p of mine) {
          const f = at(p.x, p.z);
          expect(f.v + p.radius, p.kind).toBeLessThanOrEqual(P.close + ROADWORKS.barrierReach + 1e-6);
          expect(f.s).toBeGreaterThan(P.sA - P.taper - 1);
          expect(f.s).toBeLessThan(P.sB + P.taper + 1);
          // Everything along the closure breaks: nothing a car could hit stands in the open lane.
          expect(PROP_DEFS[p.kind].breakSpeed).toBeLessThanOrEqual(1);
        }
        const solids = c.blocks.walls.filter((w) => w.look === 'roadworks' && w.area === a.id);
        expect(solids.length).toBeGreaterThanOrEqual(4);
        for (const w of solids) {
          for (const [x, z] of [
            [w.ax, w.az],
            [w.bx, w.bz],
          ]) {
            const f = at(x, z);
            expect(f.v).toBeGreaterThan(0.2);
            expect(f.v).toBeLessThanOrEqual(P.close - 0.6 + 1e-6);
            expect(f.s).toBeGreaterThanOrEqual(P.sA - 1e-6);
            expect(f.s).toBeLessThanOrEqual(P.sB + 1e-6);
          }
          expect(w.solid).toBeDefined();
        }
      }
    }
  });

  it("size the excavator's walls to the model the renderer draws", () => {
    const m = plantModels.pieces.excavator;
    const X = PLANT.excavator;
    for (const [sim, model] of [
      [X.along, m.length],
      [X.across, m.width],
      [X.arm, m.reach],
      [X.stick[0], m.stick.from],
      [X.stick[1], m.stick.to],
      [X.center, m.stick.center],
      [X.width, m.stick.width],
    ]) expect(sim).toBeCloseTo(model, 2);
    // Every city has excavators, and each one fits its closure: a body and a stick wall, at its hint's scale.
    let seen = 0;
    for (const seed of SEEDS) {
      const c = createCity(seed);
      for (const a of zones(c)) {
        for (const h of c.districts.builds[a.id].hints.filter((x) => x.kind === 'excavator')) {
          seen++;
          const k = h.values[2];
          expect(k).toBeGreaterThanOrEqual(X.minScale);
          expect(k).toBeLessThanOrEqual(1);
          expect(h.values[0]).toBeCloseTo(X.along * k, 6);
          expect(h.values[1]).toBeCloseTo(X.across * k, 6);
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(SEEDS.length);
  });

  it('the racing line swings round every closure on the route, and AI races still finish', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      for (const mode of ['circuit', 'sprint'] as const) {
        const w = createWorld(seed, mode);
        const r = createRace(raceConfig(seed, mode, 0), w);
        const line = r.line;
        const cls = laneClosures(w.areas, w.graph);
        for (const a of zones(w)) {
          if (!w.route.edges.includes(a.params.edge)) continue;
          const at = zoneFrame(w, a);
          for (let i = 0; i < line.n; i++) {
            const f = at(line.x[i], line.z[i]);
            if (f.s < a.params.sA - a.params.taper || f.s > a.params.sB + a.params.taper) continue;
            if (f.v < -2 || f.v > w.graph.edges[a.params.edge].width + 2) continue;
            checked++;
            expect(f.v).toBeGreaterThanOrEqual(a.params.close + ROADWORKS.barrierReach + ROADWORKS.aiMargin - 1e-3);
          }
        }
        expect(cls.length).toBe(zones(w).length);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('AI fields race through the closures and replay identically', () => {
    const rng = new Rng(616);
    const failures: string[] = [];
    let crossed = 0;
    for (let i = 0; i < 4; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const mode = i % 2 === 0 ? 'circuit' : 'sprint';
      const cfg = raceConfig(seed, mode, 3, undefined, 1);
      const r = runAutopilot(cfg, 420, true);
      if (zones(r.world).some((a) => r.world.route.edges.includes(a.params.edge))) crossed++;
      for (const car of r.cars.slice(1)) {
        const resets = r.events.filter((e) => e.type === 'reset' && e.car === car.index).length;
        if (!car.finished) failures.push(`seed ${seed} ${mode}: ${car.name} did not finish`);
        else if (resets > 4) failures.push(`seed ${seed} ${mode}: ${car.name} needed ${resets} resets`);
      }
      if (i === 0) {
        const again = replayLog(cfg, r.inputLog);
        expect(carSnapshot(again)).toBe(carSnapshot(r));
        expect(Array.from(again.brokenProps)).toEqual(Array.from(r.brokenProps));
      }
    }
    expect(failures).toEqual([]);
    expect(crossed).toBeGreaterThanOrEqual(3);
  });
});

