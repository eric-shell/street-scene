import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity } from '../src/city/world';
import { distToSegment } from '../src/sim/math';
import { riverCenter } from '../src/city/districts/river';
import { RAIL, buildRailCurve, dirOn, sampleCurve, curvePoint, trackFor, trackLateral } from '../src/render/railCurve';
import { TRAIN, buildRun, makeService, runAt, trackS, trainLength, tripsAt } from '../src/render/railTimetable';
import type { TripState } from '../src/render/railTimetable';

const CFG = CITY.districts.subway;
/** Seeds with a railway (chance 0.75), found once. */
const cities = (() => {
  const out: ReturnType<typeof createCity>[] = [];
  for (let s = 1; out.length < 10 && s < 60; s++) {
    const c = createCity(s);
    if (c.districts.areas.some((a) => a.kind === 'subway')) out.push(c);
  }
  return out;
})();

describe('elevated railway (city)', () => {
  it('is common: most cities get one', () => {
    expect(cities.length).toBe(10);
  });

  it('every pillar and stair wall is drawn, off the roads, and stairs come in pairs at stations', () => {
    let stations = 0;
    for (const c of cities) {
      const area = c.districts.areas.find((a) => a.kind === 'subway')!;
      const b = c.districts.builds[area.id];
      const g = c.graph;
      const pillars = b.props.filter((p) => p.kind === 'pillar');
      const stairs = b.props.filter((p) => p.kind === 'stair');
      const hints = b.hints.filter((h) => h.kind === 'station');
      stations += hints.length;
      expect(hints.length).toBeLessThanOrEqual(area.params.stations);
      expect(stairs.length).toBe(hints.length * 2);
      for (const w of b.walls) {
        expect(w.look).toBe('pillar');
        const mx = (w.ax + w.bx) / 2;
        const mz = (w.az + w.bz) / 2;
        // Drawn: on a pillar footing's circle or a stair's footprint rectangle.
        const onPillar = pillars.some((p) => Math.abs(Math.hypot(mx - p.x, mz - p.z) - p.size) < 0.12);
        const onStair = stairs.some((s) => {
          const ux = Math.sin(s.yaw);
          const uz = Math.cos(s.yaw);
          const t = (mx - s.x) * ux + (mz - s.z) * uz;
          const l = -(mx - s.x) * uz + (mz - s.z) * ux;
          return t > -0.05 && t < s.size + 0.05 && Math.abs(l) < CFG.stairWidth / 2 + 0.05;
        });
        expect(onPillar || onStair).toBe(true);
        // Never on a road surface.
        for (const e of g.edges) {
          const A = g.nodes[e.a];
          const B = g.nodes[e.b];
          expect(distToSegment(w.ax, w.az, A.x, A.z, B.x, B.z)).toBeGreaterThan(e.width / 2);
        }
      }
      // Stairs stay out of the river channel.
      const rivers = c.districts.areas.filter((a) => a.kind === 'river');
      for (const s of stairs) for (const rv of rivers) expect(Math.abs(s.z - riverCenter(rv.params, s.x))).toBeGreaterThan(rv.params.top);
    }
    expect(stations).toBeGreaterThan(cities.length);
  });

  it('plans the same railway every time', () => {
    const seed = 2;
    const a = createCity(seed).districts;
    const b = createCity(seed).districts;
    const pick = (d: typeof a) => {
      const area = d.areas.find((x) => x.kind === 'subway');
      return JSON.stringify(area ? { area, build: d.builds[area.id] } : null);
    };
    expect(pick(a)).toBe(pick(b));
  });
});

describe('elevated railway (track curve)', () => {
  it('keeps the deck at full height over the city, smooth, over the river too', () => {
    for (const c of cities.slice(0, 5)) {
      const area = c.districts.areas.find((a) => a.kind === 'subway')!;
      const curve = buildRailCurve(area.path, area.params.side, area.params.deckHeight, c.terrain.heightAt);
      for (let s = curve.cityA; s <= curve.cityB; s += 2) {
        const p = sampleCurve(curve, s, curvePoint());
        expect(p.y - p.ground).toBeGreaterThan(area.params.deckHeight - 0.6);
      }
      // No kinks: the heading turns by under 2 degrees per 2 m sample.
      for (let i = 1; i < curve.n; i++) {
        const dot = curve.tx[i] * curve.tx[i - 1] + curve.tz[i] * curve.tz[i - 1];
        expect(dot).toBeGreaterThan(Math.cos((2 * Math.PI) / 180));
      }
      // Portals at both ends bring the track down to the ground.
      const a = sampleCurve(curve, curve.portalA, curvePoint());
      expect(a.y - a.ground).toBeLessThan(1);
    }
  });

  it('runs the two directions on opposite tracks, the street side one swinging out at stations', () => {
    const path = [
      { x: 0, z: -800 },
      { x: 0, z: 0 },
      { x: 0, z: 800 },
    ];
    for (const side of [1, -1]) {
      const curve = buildRailCurve(path, side, 8.5, () => 0, [{ x: -6, z: 100 }]);
      expect(trackFor(curve, 1)).not.toBe(trackFor(curve, -1));
      expect(dirOn(curve, trackFor(curve, -1))).toBe(-1);
      const st = curve.stations[0].s;
      expect(trackLateral(curve, 0, st)).toBeCloseTo(-RAIL.trackHalf - RAIL.stationSpread, 5);
      expect(trackLateral(curve, 0, st + 400)).toBeCloseTo(-RAIL.trackHalf, 5);
      expect(trackLateral(curve, 1, st)).toBe(RAIL.trackHalf);
      // The pillar side normal points along the area's side (+x for side 1).
      const p = sampleCurve(curve, curve.length / 2, curvePoint());
      expect(Math.sign(p.px)).toBe(side);
    }
  });
});

describe('elevated railway (timetable)', () => {
  const L = 2200;
  const stations = [700, 1500];

  it('is a pure function of time', () => {
    const sv = makeService(1, L, stations, 12);
    const a: TripState[] = [];
    const b: TripState[] = [];
    const times = [0, 31.25, 400.5, 9999.75, 123.5];
    const first = times.map((t) => JSON.stringify(a.slice(0, tripsAt(sv, t, a))));
    // Asked again in another order, with another scratch array: the same trains.
    const again = [...times].reverse().map((t) => JSON.stringify(b.slice(0, tripsAt(sv, t, b))));
    expect(again.reverse()).toEqual(first);
  });

  it('enters at speed, stops centered at every station, and leaves past the far portal', () => {
    const train = trainLength();
    const run = buildRun(L, stations.map((c) => c + train / 2), train);
    const r = { s: 0, v: 0, a: 0 };
    expect(runAt(run, 0, r).v).toBeCloseTo(TRAIN.cruise, 5);
    let prev = -1;
    const stops = new Set<number>();
    for (let t = 0; t <= run.duration; t += 0.25) {
      runAt(run, t, r);
      expect(r.s).toBeGreaterThanOrEqual(prev - 1e-6);
      expect(r.v).toBeLessThanOrEqual(TRAIN.cruise + 1e-6);
      prev = r.s;
      if (r.v < 1e-6) stops.add(Math.round(r.s - train / 2));
    }
    expect([...stops].sort((x, y) => x - y)).toEqual(stations);
    expect(runAt(run, run.duration, r).s).toBeCloseTo(L + train, 3);
  });

  it('runs the other direction the other way along the track', () => {
    const up = makeService(1, L, stations, 0);
    const down = makeService(-1, L, stations, 0);
    const trips: TripState[] = [];
    // Trip 0 (earlier departures are still out on the line too).
    const head = (sv: typeof up, t: number) => {
      const n = tripsAt(sv, t, trips);
      const trip = trips.slice(0, n).find((x) => x.trip === 0);
      return trip ? trackS(sv, trip.s) : NaN;
    };
    // Early in trip 0, between portal and first station.
    expect(head(up, 10.5)).toBeGreaterThan(head(up, 10));
    expect(head(down, 10.5)).toBeLessThan(head(down, 10));
    expect(head(up, 1)).toBeLessThan(L / 2);
    expect(head(down, 1)).toBeGreaterThan(L / 2);
  });
});
