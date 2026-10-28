import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { CITY } from '../src/city/config';
import { homeOf } from '../src/city/regions';
import { distToPath } from '../src/city/districts/geom';
import { createRace, stepRace, type RaceConfig } from '../src/sim/race';
import { CABLE_CAR, cableCarAt, cableLine, cableTuning, departureBell, type CableCarPose } from '../src/sim/cableCar';
import type { CarState } from '../src/sim/car';
import type { CarTuning } from '../src/sim/tuning';
import { CABLE_CAR_BODY, TRAFFIC } from '../src/sim/tuning';
import { TRAFFIC_LAYOUT, trafficNet } from '../src/sim/traffic';
import { TICK_HZ } from '../src/sim/constants';
import { packInput } from '../src/sim/input';
import { carSnapshot, input, raceConfig, replayLog } from './helpers';

/** sf homes (city/regions.ts homeOf) and a few others. */
const SF = [20261019, 4, 21];
const OTHERS = [1, 2, 3, 9];

/** Deepest overlap (m) of two bodies' contact circles (collision.ts circleOffsets: three along each, 0.95 of the half width). */
function depth(a: CarState, ta: CarTuning, b: CarState, tb: CarTuning): number {
  const circles = (t: CarTuning) => {
    const r = t.geometry.halfWidth * 0.95;
    const span = Math.max(0, t.geometry.halfLength - r);
    return [-span, 0, span].map((u) => ({ u, r }));
  };
  let worst = -Infinity;
  for (const p of circles(ta))
    for (const q of circles(tb)) {
      const d = Math.hypot(a.x + Math.sin(a.yaw) * p.u - b.x - Math.sin(b.yaw) * q.u, a.z + Math.cos(a.yaw) * p.u - b.z - Math.cos(b.yaw) * q.u);
      worst = Math.max(worst, p.r + q.r - d);
    }
  return worst;
}

const pose = (): CableCarPose => ({ s: 0, v: 0, dir: 1, x: 0, z: 0, yaw: 0, departIn: 0 });

describe('the San Francisco cable car', () => {
  it('runs only on sf homes, on a street off both routes and the drag strip', () => {
    for (const seed of OTHERS) {
      expect(homeOf(seed), `${seed}`).not.toBe('sf');
      expect(createWorld(seed, 'circuit').areas.some((a) => a.kind === 'cableCar'), `${seed}`).toBe(false);
    }
    for (const seed of SF) {
      expect(homeOf(seed)).toBe('sf');
      for (const kind of ['circuit', 'sprint', 'drag'] as const) {
        const w = createWorld(seed, kind);
        const lines = w.areas.filter((a) => a.kind === 'cableCar');
        expect(lines.length, `${seed} ${kind}`).toBe(1);
        const a = lines[0];
        const nodes = new Set(a.edges.flatMap((e) => [w.graph.edges[e].a, w.graph.edges[e].b]));
        for (const n of w.route.nodes) expect(nodes.has(n), `${seed} ${kind} route node ${n}`).toBe(false);
        // Every track point well clear of the route's line: a block away at the least.
        let near = Infinity;
        for (const p of a.path) near = Math.min(near, distToPath(w.route.points, p.x, p.z));
        expect(near, `${seed} ${kind}`).toBeGreaterThan(30);
        // Its shelters are solids of their own look, off the road.
        const shelters = new Set(w.walls.filter((x) => x.look === 'cableCar').map((x) => x.solid));
        expect(shelters.size).toBe(2);
      }
    }
  });

  it('is where the timetable says, a pure function of the tick, and dwells and runs at its speed', () => {
    const w = createWorld(SF[0], 'circuit');
    const l = cableLine(w)!;
    expect(l).not.toBeNull();
    const a = pose();
    const b = pose();
    let top = 0;
    let dwell = 0;
    for (let t = 0; t < l.period * TICK_HZ; t += 7) {
      cableCarAt(l, t, a);
      cableCarAt(l, t, b);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.s).toBeGreaterThanOrEqual(l.s0 - 1e-9);
      expect(a.s).toBeLessThanOrEqual(l.s1 + 1e-9);
      top = Math.max(top, Math.abs(a.v));
      if (a.v === 0) dwell++;
    }
    expect(top).toBeCloseTo(CABLE_CAR_BODY.speed, 3);
    // Two dwells of CABLE_CAR.dwell s in each cycle.
    expect(dwell * 7).toBeGreaterThan(2 * CABLE_CAR.dwell * TICK_HZ * 0.95);
    // A race steps the same car: its body is where the pure function puts it.
    const r = createRace({ ...raceConfig(SF[0], 'circuit', 0), traffic: true });
    for (let i = 0; i < 600; i++) stepRace(r, input({}));
    cableCarAt(l, r.tick - 1, a);
    expect(r.cableCar!.body.x).toBeCloseTo(a.x, 9);
    expect(r.cableCar!.body.z).toBeCloseTo(a.z, 9);
  });

  it('rings its bell on a pure schedule: once at every departure', () => {
    const l = cableLine(createWorld(SF[1], 'circuit'))!;
    const rings: number[] = [];
    const n = Math.ceil(2 * l.period * TICK_HZ);
    for (let k = 0; k < n; k++) if (departureBell(l, k)) rings.push(k);
    expect(rings.length).toBe(4);
    for (const k of rings) {
      expect(departureBell(l, k)).toBe(true);
      // The bell rings bellLead s before the car pulls away.
      const p = cableCarAt(l, k, pose());
      expect(p.v).toBe(0);
      expect(p.departIn).toBeLessThanOrEqual(CABLE_CAR.bellLead + 1 / TICK_HZ);
    }
  });

  it('keeps every traffic lane on its street clear of the track strip, and parks no car there', () => {
    for (const seed of SF) {
      const w = createWorld(seed, 'circuit');
      const a = w.areas.find((x) => x.kind === 'cableCar')!;
      const edges = new Set(a.edges);
      const maxHalf = Math.max(...TRAFFIC.kinds.map((k) => k.halfWidth));
      const need = CITY.districts.cableCar.stripHalf + TRAFFIC_LAYOUT.parkClear + maxHalf - 1e-6;
      let lanes = 0;
      for (const p of trafficNet(w).paths) {
        if (!p.lane || !edges.has(p.edge)) continue;
        lanes++;
        for (let i = 0; i < p.x.length; i++) expect(distToPath(a.path, p.x[i], p.z[i]), `${seed}`).toBeGreaterThanOrEqual(need);
      }
      expect(lanes, `${seed}`).toBeGreaterThan(0);
      expect(CITY.districts.cableCar.stripHalf).toBeGreaterThan(CABLE_CAR_BODY.halfWidth);
    }
  });

  it('stops a race car that drives into it, holds its own line, and replays bit for bit', () => {
    const seed = SF[0];
    const w = createWorld(seed, 'circuit', undefined, { openWorld: true });
    const l = cableLine(w)!;
    // A tick where the car stands at its first terminal with about ten seconds to go.
    const p = pose();
    let tick0 = 0;
    for (let t = 0; t < l.period * TICK_HZ; t++) {
      cableCarAt(l, t, p);
      if (p.v === 0 && p.dir === 1 && p.departIn > 9 && p.departIn < 11) {
        tick0 = t;
        break;
      }
    }
    // The player on the track 30 m up the line, facing the car, rolling at it.
    const at = cableCarAt(l, tick0, pose());
    const fx = Math.sin(at.yaw);
    const fz = Math.cos(at.yaw);
    const cfg: RaceConfig = {
      ...raceConfig(seed, 'circuit', 0),
      openWorld: true,
      traffic: false,
      start: { x: at.x + fx * 30, z: at.z + fz * 30, yaw: at.yaw + Math.PI, speed: 8, tick: tick0 },
    };
    const r = createRace(cfg, w);
    let before = 0;
    let after = -1;
    for (let i = 0; i < 5 * TICK_HZ; i++) {
      const v = Math.hypot(r.cars[0].state.vx, r.cars[0].state.vz);
      const n = r.events.length;
      // At it, then on the handbrake once it has hit, so it stays in front of the cable car.
      stepRace(r, after < 0 ? input({ throttle: 0.5 }) : input({ handbrake: true }));
      if (after < 0 && r.events.slice(n).some((e) => e.type === 'crash' && e.car === 0 && e.traffic === undefined)) {
        before = v;
        after = Math.hypot(r.cars[0].state.vx, r.cars[0].state.vz);
      }
      // Never inside it: shoved out every tick (touching, to the last few float bits, is fine).
      expect(depth(r.cars[0].state, r.cars[0].tuning, r.cableCar!.body, cableTuning()), `tick ${r.tick}`).toBeLessThan(0.01);
    }
    // A head on hit at about 15 m/s stops the race car (seven tonnes do not give).
    expect(before).toBeGreaterThan(10);
    expect(after).toBeLessThan(before * 0.35);
    // The cable car never moved off its pose.
    cableCarAt(l, r.tick - 1, p);
    expect(r.cableCar!.body.x).toBe(p.x);
    expect(r.cableCar!.body.z).toBe(p.z);
    // The player in its way when it pulls away gets the bell, besides the departure's.
    for (let i = 0; i < 9 * TICK_HZ; i++) stepRace(r, input({ handbrake: true }));
    expect(r.cableCar!.bells).toBeGreaterThanOrEqual(2);
    // Replay: the same log, the same race, the same cable car.
    const again = replayLog(cfg, r.inputLog);
    expect(carSnapshot(again)).toBe(carSnapshot(r));
    expect(JSON.stringify(again.cableCar)).toBe(JSON.stringify(r.cableCar));
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(r.events));
    expect(r.inputLog[0]).toBe(packInput(input({ throttle: 0.5 })));
  });
});
