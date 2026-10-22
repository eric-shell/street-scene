import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, planRoads } from '../src/city/world';
import { distToSegment } from '../src/sim/math';
import { Rng } from '../src/sim/prng';
import { riverCenter } from '../src/city/districts/river';
import { RAIL, buildRailCurve, dirOn, projectOnCurve, sampleCurve, curvePoint, trackFor, trackLateral } from '../src/city/railCurve';
import type { RailCurve } from '../src/city/railCurve';
import { TRAIN, buildRun, makeService, runAt, trackS, trainLength, tripsAt } from '../src/city/railTimetable';
import type { TripState } from '../src/city/railTimetable';
import { elColumnAt, elCurve, elRowIndex, streetChain } from '../src/city/districts/subway';

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

/** Plans (planRoads only: the graph, the areas and their builds) of `want` seeds from a stream that have an El. */
function elPlans(stream: number, want: number): ReturnType<typeof planRoads>[] {
  const rng = new Rng(stream);
  const out: ReturnType<typeof planRoads>[] = [];
  for (let i = 0; i < 300 && out.length < want; i++) {
    const plan = planRoads(rng.int(0, 0x7fffffff));
    if (plan.districts.areas.some((a) => a.kind === 'subway')) out.push(plan);
  }
  return out;
}

/** Tightest radius of the curve's city part (m), from the heading change per sample. */
function minRadius(curve: RailCurve): number {
  let r = Infinity;
  for (let i = Math.ceil(curve.cityA / RAIL.step) + 1; i * RAIL.step < curve.cityB; i++) {
    const dot = curve.tx[i] * curve.tx[i - 1] + curve.tz[i] * curve.tz[i - 1];
    const cross = curve.tx[i - 1] * curve.tz[i] - curve.tz[i - 1] * curve.tx[i];
    const turn = Math.abs(Math.atan2(cross, dot));
    if (turn > 1e-9) r = Math.min(r, RAIL.step / turn);
  }
  return r;
}

describe('elevated railway (city)', () => {
  it('is common: most cities get one', () => {
    expect(cities.length).toBe(10);
  });

  it('crosses the whole map as one line that swings columns on most seeds, every column off the roads and clear of the junctions', () => {
    const plans = elPlans(31, 60);
    expect(plans.length).toBe(60);
    const H = CITY.gridH;
    let swung = 0;
    let twice = 0;
    let crossings = 0;
    for (const plan of plans) {
      const g = plan.graph;
      const sub = plan.districts.areas.find((a) => a.kind === 'subway')!;
      const path = sub.path;
      // One polyline from beyond the south edge to beyond the north (run-offs of 70 m past the end nodes), no
      // gaps (a block with no street is 140 m).
      const cols = Array.from({ length: H }, (_, j) => elColumnAt(sub, j));
      const at = Array.from({ length: H }, (_, j) => elRowIndex(sub, j));
      const last = path[path.length - 1];
      expect(path[0].z).toBeLessThan(g.bounds.minZ);
      expect(last.z).toBeGreaterThan(g.bounds.maxZ);
      expect(Math.hypot(path[0].x - path[at[0]].x, path[0].z - path[at[0]].z)).toBeGreaterThan(60);
      expect(Math.hypot(last.x - path[at[H - 1]].x, last.z - path[at[H - 1]].z)).toBeGreaterThan(60);
      for (let i = 1; i < path.length; i++) expect(Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z)).toBeLessThan(CITY.spacing * 1.5);
      // An anchor on every row's street line, in row order, on the column the line is on there or, inside a
      // swing, between the columns it leaves and joins.
      for (let j = 0; j < H; j++) {
        if (j) expect(at[j]).toBeGreaterThan(at[j - 1]);
        const p = path[at[j]];
        let c = cols[j];
        if (c < 0) {
          let k = j;
          while (cols[k] < 0) k--;
          c = cols[k];
          let m = j;
          while (cols[m] < 0) m++;
          const left = Math.min(c, cols[m]);
          const right = Math.max(c, cols[m]);
          expect(right - left).toBe(1);
          const A = g.nodes[j * CITY.gridW + left];
          const B = g.nodes[j * CITY.gridW + right];
          // On the row's street as it runs: its pieces through bend nodes (a curved street bows a few
          // metres off the chord between its junctions), or the chord where no street joins them.
          const ids = streetChain(g, A.id, B.id) ?? [A.id, B.id];
          let off = Infinity;
          for (let k = 0; k + 1 < ids.length; k++) off = Math.min(off, distToSegment(p.x, p.z, g.nodes[ids[k]].x, g.nodes[ids[k]].z, g.nodes[ids[k + 1]].x, g.nodes[ids[k + 1]].z));
          expect(off).toBeLessThan(2.5);
          expect(Math.hypot(p.x - A.x, p.z - A.z)).toBeGreaterThan(28);
          expect(Math.hypot(p.x - B.x, p.z - B.z)).toBeGreaterThan(28);
          crossings++;
        } else {
          const n = g.nodes[j * CITY.gridW + c];
          expect(n.gi).toBe(c);
          expect(n.gj).toBe(j);
          // Over the curb lane beside its node, or on a bluff's right of way beside the street (its rowOffset from
          // the El's column, where that line meets the row's jittered street; the warp's short wave, roadGraph.ts, bows
          // a column a few metres more between rows).
          const d = Math.hypot(p.x - n.x, p.z - n.z);
          if (j > (sub.params.dj0 ?? Infinity) && j < (sub.params.dj1 ?? -Infinity)) expect(Math.abs(d - (plan.districts.areas.find((a) => a.kind === 'bluff')?.params.rowOffset ?? CITY.districts.bluff.rowOffset))).toBeLessThan(2 * (CITY.jitter + CITY.warp[CITY.warp.length - 1].amp));
          else expect(d).toBeLessThan(CITY.width.boulevard / 2);
        }
      }
      expect(cols[0]).toBeGreaterThanOrEqual(1);
      expect(cols[0]).toBeLessThanOrEqual(CITY.gridW - 2);
      expect(cols[H - 1]).toBeGreaterThanOrEqual(1);
      if (sub.params.swings >= 1) swung++;
      if (sub.params.swings >= 2) twice++;
      expect(cols.filter((c, j) => j && c >= 0 && cols[j - 1] >= 0 && c !== cols[j - 1]).length).toBe(0);
      // Columns: off every road by the footing's radius, inside at most one street's corridor (a sidewalk or a
      // block; the pieces of one bent street count once), clear of every junction's closure reach, in the map.
      const b = plan.districts.builds[sub.id];
      const pillars = b.props.filter((p) => p.kind === 'pillar');
      expect(pillars.length).toBeGreaterThan(25);
      for (const p of pillars) {
        expect(p.x).toBeGreaterThan(g.bounds.minX - 30);
        expect(p.x).toBeLessThan(g.bounds.maxX + 30);
        const hits: number[] = [];
        for (const e of g.edges) {
          const A = g.nodes[e.a];
          const B = g.nodes[e.b];
          const d = distToSegment(p.x, p.z, A.x, A.z, B.x, B.z);
          expect(d).toBeGreaterThan(e.width / 2 + p.size);
          if (d < e.width / 2 + e.sidewalk + p.size) hits.push(e.id);
        }
        const bendNode = (id: number) => g.nodes[id].gi < 0 && g.nodes[id].edges.length <= 2;
        const joined = (a: number, b2: number) => [g.edges[a].a, g.edges[a].b].some((id) => (id === g.edges[b2].a || id === g.edges[b2].b) && bendNode(id));
        let streets = hits.length;
        for (let i = 0; i < hits.length; i++) for (let k = i + 1; k < hits.length; k++) if (joined(hits[i], hits[k])) streets--;
        expect(streets).toBeLessThanOrEqual(1);
        for (const n of g.nodes) if (n.gi >= 0 || n.edges.length > 2) expect(Math.hypot(n.x - p.x, n.z - p.z)).toBeGreaterThan(18);
      }
    }
    // Swings are the rule, a second one the exception; every swing crosses at least one row street mid block.
    expect(swung / plans.length).toBeGreaterThan(0.6);
    expect(twice).toBeGreaterThan(0);
    expect(crossings).toBeGreaterThanOrEqual(swung);
  });

  it('rides curves the trains can take, on every seed', () => {
    for (const plan of elPlans(47, 40)) {
      const sub = plan.districts.areas.find((a) => a.kind === 'subway')!;
      const curve = elCurve(sub, plan.districts.builds[sub.id], () => 0);
      expect(minRadius(curve), `seed with column ${sub.params.column}, ${sub.params.swings} swings`).toBeGreaterThanOrEqual(RAIL.minRadius);
    }
  });

  it('puts its stations on straight street the deck follows', () => {
    let stations = 0;
    for (const plan of elPlans(53, 40)) {
      const g = plan.graph;
      const sub = plan.districts.areas.find((a) => a.kind === 'subway')!;
      const b = plan.districts.builds[sub.id];
      const curve = elCurve(sub, b, () => 0);
      const P = curvePoint();
      for (const st of curve.stations) {
        stations++;
        // The platform and a little beyond it: the heading barely turns (on curved streets too: stations
        // only go where the track's bends under the platform stay this gentle).
        const s0 = st.s - RAIL.platform / 2 - 8;
        const s1 = st.s + RAIL.platform / 2 + 8;
        sampleCurve(curve, s0, P);
        const tx = P.tx;
        const tz = P.tz;
        for (let s = s0; s <= s1; s += 4) {
          sampleCurve(curve, s, P);
          expect(tx * P.tx + tz * P.tz).toBeGreaterThan(Math.cos((4 * Math.PI) / 180));
        }
        // Over the curb lane of a street under the deck, not a swing's block or a bluff's right of way.
        sampleCurve(curve, st.s, P);
        const under = sub.edges.some((eid) => {
          const e = g.edges[eid];
          const A = g.nodes[e.a];
          const B = g.nodes[e.b];
          return distToSegment(P.x, P.z, A.x, A.z, B.x, B.z) < e.width / 2;
        });
        expect(under).toBe(true);
      }
    }
    // Most cities get one or two (curved streets, roadGraph.ts, leave some with no block straight enough
    // under a platform).
    expect(stations).toBeGreaterThanOrEqual(30);
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
    // (Most cities have a station: curved streets leave some with no block straight enough for one.)
    expect(stations).toBeGreaterThanOrEqual(cities.length * 0.75);
  });

  it('plans the same railway every time', () => {
    // A bluff seed, a two swing seed and a plain one.
    for (const seed of [2, 1, 5]) {
      const a = createCity(seed).districts;
      const b = createCity(seed).districts;
      const pick = (d: typeof a) => {
        const area = d.areas.find((x) => x.kind === 'subway');
        return JSON.stringify(area ? { area, build: d.builds[area.id] } : null);
      };
      expect(pick(a)).toBe(pick(b));
      expect(a.areas.some((x) => x.kind === 'subway')).toBe(true);
    }
  });
});

describe('elevated railway (track curve)', () => {
  it('keeps the deck at full height over the city, smooth and gentle, over the river too', () => {
    for (const c of cities) {
      const area = c.districts.areas.find((a) => a.kind === 'subway')!;
      const curve = elCurve(area, c.districts.builds[area.id], c.terrain.heightAt);
      // A bluff's level stretch (and its blends) is tests/bluff.test.ts's business.
      for (let s = curve.cityA; s <= curve.cityB; s += 2) {
        if (s > curve.levelA - curve.blendA && s < curve.levelB + curve.blendB) continue;
        const p = sampleCurve(curve, s, curvePoint());
        expect(p.y - p.ground).toBeGreaterThan(area.params.deckHeight - 0.6);
      }
      // No kinks: the heading turns by under 2 degrees per 2 m sample (a 57 m radius; the trains' limit is RAIL.minRadius).
      for (let i = 1; i < curve.n; i++) {
        const dot = curve.tx[i] * curve.tx[i - 1] + curve.tz[i] * curve.tz[i - 1];
        expect(dot).toBeGreaterThan(Math.cos((2 * Math.PI) / 180));
      }
      expect(minRadius(curve)).toBeGreaterThanOrEqual(RAIL.minRadius);
      // Grades the trains ride stay gentle everywhere, a bluff's blends included (they grow until they do).
      for (let i = Math.ceil(curve.cityA / 2) + 1; i < curve.cityB / 2; i++) expect(Math.abs(curve.deck[i] - curve.deck[i - 1]) / 2).toBeLessThan(RAIL.levelGrade + 0.005);
      // Portals at both ends bring the track down to the ground.
      const a = sampleCurve(curve, curve.portalA, curvePoint());
      expect(a.y - a.ground).toBeLessThan(1);
      // Station platforms are where the hints put them.
      for (const st of curve.stations) {
        const hint = c.districts.builds[area.id].hints.filter((h) => h.kind === 'station')[st.name];
        expect(Math.abs(projectOnCurve(curve, hint.points[0].x, hint.points[0].z).s - st.s)).toBeLessThan(0.01);
      }
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
