import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { planRoads } from '../src/city/world';
import { WEEKEND_FEATURES, weekendOf, weekendSeeds } from '../src/city/weekend';
import { createCity } from '../src/city/world';
import { CITY } from '../src/city/config';
import { districtModule } from '../src/city/districts';
import { regionOf, spineDirection } from '../src/city/districts/weekendRegion';
import { pointInPolygon } from '../src/city/districts/geom';
import { turnAt } from '../src/city/roadGraph';
import { LOST, createRace, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { yawOf } from '../src/sim/math';
import { input, raceConfig } from './helpers';

const KINDS = WEEKEND_FEATURES.map((f) => f.kind) as string[];

describe('weekendOf', () => {
  it('reads Saturdays and Sundays off the seed digits', () => {
    expect(weekendOf(20261031)).toMatchObject({ day: 'sat', year: 2026, month: 10, dayOfMonth: 31 });
    expect(weekendOf(20261101)).toMatchObject({ day: 'sun', year: 2026, month: 11, dayOfMonth: 1 });
    // Consecutive weekend days are consecutive ordinals.
    expect(weekendOf(20261101)!.ordinal).toBe(weekendOf(20261031)!.ordinal + 1);
  });

  it('is null for weekdays, impossible dates, non-dates and years out of range', () => {
    expect(weekendOf(20261102)).toBeNull(); // Monday
    expect(weekendOf(20261131)).toBeNull(); // no 31st of November
    expect(weekendOf(20260229)).toBeNull(); // 2026 is no leap year
    expect(weekendOf(20280229)).toBeNull(); // a real date, a Tuesday
    expect(weekendOf(12345678)).toBeNull(); // year 1234
    expect(weekendOf(99999999)).toBeNull();
    expect(weekendOf(20261)).toBeNull(); // not eight digits
    expect(weekendOf(20241228)).toBeNull(); // a Saturday before 2025
  });

  it('indexes the rotation right before the reference Saturday (negative ordinals)', () => {
    const p = weekendOf(20251004)!; // a Saturday
    expect(p.day).toBe('sat');
    expect(p.ordinal).toBeLessThan(0);
    const n = WEEKEND_FEATURES.length;
    expect(p.kind).toBe(WEEKEND_FEATURES[((p.ordinal % n) + n) % n].kind);
    // 2026-01-03 is ordinal 0, the first feature.
    expect(weekendOf(20260103)).toMatchObject({ ordinal: 0, kind: WEEKEND_FEATURES[0].kind });
  });

  it('walks the feature list in order over consecutive weekend days', () => {
    const seeds = weekendSeeds({ year: 2026, month: 1, dayOfMonth: 3 }, 12);
    expect(seeds).toHaveLength(12);
    seeds.forEach((seed, i) => {
      const p = weekendOf(seed)!;
      expect(p.ordinal).toBe(i);
      expect(p.kind).toBe(WEEKEND_FEATURES[i % WEEKEND_FEATURES.length].kind);
      expect(p.day).toBe(i % 2 === 0 ? 'sat' : 'sun');
    });
  });
});

describe('weekend plumbing', () => {
  it('plans no weekend special on seeds that are not weekend dates', () => {
    const rng = new Rng(777);
    for (let i = 0; i < 30; i++) {
      let seed = rng.int(0, 0x7fffffff);
      while (weekendOf(seed)) seed = rng.int(0, 0x7fffffff);
      const plan = planRoads(seed);
      expect(plan.districts.areas.some((a) => KINDS.includes(a.kind))).toBe(false);
      expect(plan.graph.edges.some((e) => e.kind === 'feature')).toBe(false);
      expect(plan.event.special).toBeUndefined();
    }
  });

  it('carves the picked region on the next 12 weekend seeds, and both routes drive its spine from entry to exit', () => {
    for (const seed of weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 12)) {
      const plan = planRoads(seed);
      const pick = weekendOf(seed)!;
      const areas = plan.districts.areas.filter((a) => KINDS.includes(a.kind));
      expect(areas.length, `seed ${seed}`).toBe(1);
      const a = areas[0];
      expect(a.kind).toBe(pick.kind);
      const r = regionOf(a)!;
      expect(r, `seed ${seed}`).not.toBeNull();
      // 6 to 12 cells, every block inside claimed by the area, an entry and an exit on the ring.
      const cells = a.params.along * a.params.across;
      expect(cells).toBeGreaterThanOrEqual(6);
      expect(cells).toBeLessThanOrEqual(12);
      expect(a.faces.length).toBeGreaterThanOrEqual(2);
      expect(r.spine.length).toBeGreaterThanOrEqual(4);
      for (const e of r.spineEdges) expect(plan.graph.edges[e].kind).toBe('feature');
      // The flares carry straight on from the approach streets: the first piece is the street's width, never a 90 degree gate.
      for (const [end, next, approach] of [
        [r.spine[0], r.spine[1], r.approachE],
        [r.spine[r.spine.length - 1], r.spine[r.spine.length - 2], r.approachX],
      ]) {
        const N = plan.graph.nodes[end];
        const P = plan.graph.nodes[approach];
        const Q = plan.graph.nodes[next];
        const turn = turnAt(plan.graph, approach, end, next);
        expect(turn, `seed ${seed}`).toBeLessThan((CITY.districts.weekend.maxApproachDeg * Math.PI) / 180 + 0.01);
        expect(Math.hypot(Q.x - N.x, Q.z - N.z)).toBeCloseTo(CITY.districts.weekend.flare, 0);
        expect(Math.hypot(P.x - N.x, P.z - N.z)).toBeGreaterThan(5);
      }
      expect(spineDirection(plan.graph, plan.routeNodes.circuit, true, r), `seed ${seed} circuit`).not.toBe(0);
      expect(spineDirection(plan.graph, plan.routeNodes.sprint, false, r), `seed ${seed} sprint`).not.toBe(0);
      expect(a.params.special).toBe(1);
      expect(plan.event.special?.kind).toBe(pick.kind);
    }
  });

  it('hands over two to six lines entry to exit, the spine first, inside the region', () => {
    for (const seed of weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 3)) {
      const city = createCity(seed);
      const a = city.districts.areas.find((x) => KINDS.includes(x.kind))!;
      const r = regionOf(a)!;
      const lines = districtModule(a.kind).lines!(a);
      expect(lines.length, `seed ${seed}`).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(6);
      expect(lines[0].kind).toBe('spine');
      expect(lines.filter((l) => l.kind === 'spine').length).toBe(1);
      expect(new Set(lines.map((l) => l.id)).size).toBe(lines.length);
      const E = r.path[0];
      const X = r.path[r.path.length - 1];
      for (const l of lines) {
        expect(l.difficulty).toBeGreaterThanOrEqual(1);
        expect(l.difficulty).toBeLessThanOrEqual(3);
        expect(l.width).toBeGreaterThan(2);
        expect(Math.hypot(l.path[0].x - E.x, l.path[0].z - E.z)).toBeLessThan(1);
        expect(Math.hypot(l.path[l.path.length - 1].x - X.x, l.path[l.path.length - 1].z - X.z)).toBeLessThan(1);
        // Every point but the two ends (the ring's junctions) stands inside the region.
        for (const p of l.path.slice(1, -1)) expect(pointInPolygon(p.x, p.z, a.polygon), `${a.kind} ${l.id}`).toBe(true);
      }
    }
  });
});

describe('progress and lost in a region', () => {
  it('a car on a line far from the spine is never lost and its progress runs on', () => {
    // The first Scrapyard day: a region three cells across, room for a line 100 m and more off the spine.
    const seed = 20261031;
    const cfg = raceConfig(seed, 'circuit', 0);
    const r = createRace(cfg);
    const w = r.world;
    const a = w.areas.find((x) => x.kind === 'scrapyard')!;
    const reg = regionOf(a)!;
    const dir = spineDirection(w.graph, w.route.nodes, true, reg, false);
    expect(dir).not.toBe(0);
    const spine = dir > 0 ? reg.path : reg.path.slice().reverse();
    // The line: the spine (past its flares) offset sideways as far as the region allows, up to 150 m.
    const inner = spine.slice(1, -1);
    const along: { x: number; z: number; nx: number; nz: number }[] = [];
    for (let i = 0; i + 1 < inner.length; i++) {
      const p = inner[i];
      const q = inner[i + 1];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      for (let d = 0; d < len; d += 2) along.push({ x: p.x + ((q.x - p.x) * d) / len, z: p.z + ((q.z - p.z) * d) / len, nx: -(q.z - p.z) / len, nz: (q.x - p.x) / len });
    }
    let best = { off: 0, side: 1 };
    for (const side of [1, -1]) {
      for (let off = 150; off > best.off; off -= 5) {
        if (along.every((s) => pointInPolygon(s.x + s.nx * off * side, s.z + s.nz * off * side, a.polygon))) {
          best = { off, side };
          break;
        }
      }
    }
    expect(best.off).toBeGreaterThanOrEqual(90);
    // Where the spine bends toward the line's side a plain offset folds back on itself: keep the points that move on along
    // the spine (each one's nearest spine point further on than the last's), the way a car driving that side would.
    const nearestS = (x: number, z: number): number => {
      let bestD = Infinity;
      let bestS = 0;
      let acc = 0;
      for (let i = 0; i + 1 < spine.length; i++) {
        const p = spine[i];
        const q = spine[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
        const t = Math.max(0, Math.min(1, ((x - p.x) * (q.x - p.x) + (z - p.z) * (q.z - p.z)) / (len * len)));
        const d = Math.hypot(x - p.x - (q.x - p.x) * t, z - p.z - (q.z - p.z) * t);
        if (d < bestD) {
          bestD = d;
          bestS = acc + t * len;
        }
        acc += len;
      }
      return bestS;
    };
    const line: { x: number; z: number }[] = [];
    let last = -Infinity;
    for (const s of along) {
      const p = { x: s.x + s.nx * best.off * best.side, z: s.z + s.nz * best.off * best.side };
      const ns = nearestS(p.x, p.z);
      if (ns <= last + 0.5) continue;
      last = ns;
      line.push(p);
    }
    // A plain offset runs through the yard's set pieces (the Scrapyard's scrap mountains fill its far side), and a wall shoving the
    // car is not what this is about: where the module hands over a ground line that far out (the perimeter road), drive it instead.
    const farLine = districtModule(a.kind)
      .lines?.(a)
      .filter((l) => l.kind === 'alt' && l.level === 'ground')
      .map((l) => ({ l, off: Math.max(...l.path.map((p) => Math.min(...spine.map((q) => Math.hypot(p.x - q.x, p.z - q.z))))) }))
      .sort((x, y) => y.off - x.off)[0];
    if (farLine && farLine.off >= 90) {
      const pts = dir > 0 ? farLine.l.path : farLine.l.path.slice().reverse();
      line.length = 0;
      last = -Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
        for (let d = 0; d < len; d += 2) {
          const p = { x: pts[i].x + ((pts[i + 1].x - pts[i].x) * d) / len, z: pts[i].z + ((pts[i + 1].z - pts[i].z) * d) / len };
          if (!pointInPolygon(p.x, p.z, a.polygon)) continue;
          const ns = nearestS(p.x, p.z);
          if (ns <= last + 0.5) continue;
          last = ns;
          line.push(p);
        }
      }
    }
    // The plain projection's corridor is far away along it: without the region the car would be lost.
    const farOut = line.filter((p) => {
      const q = w.routeProgress(p.x, p.z);
      return Math.abs(q.lateral) - w.route.segWidth[q.seg] / 2 > LOST.lateral;
    });
    expect(farOut.length).toBeGreaterThan(line.length / 3);
    // Drive it at 25 m/s, the car put on the line every tick (the line crosses the yard's set pieces: this is about the race's bookkeeping).
    r.tick = r.countdownTicks;
    r.phase = 'racing';
    const rc = r.cars[0];
    const c = rc.state;
    let prev = -Infinity;
    let start = NaN;
    let t = 0;
    const speed = 25;
    for (let k = 0; k + 1 < line.length; ) {
      const p = line[k];
      const q = line[k + 1];
      const yaw = yawOf(q.x - p.x, q.z - p.z);
      placeCar(c, p.x, p.z, yaw, w);
      const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      c.vx = ((q.x - p.x) / len) * speed;
      c.vz = ((q.z - p.z) / len) * speed;
      stepRace(r, input({ throttle: 1 }));
      expect(rc.stuckTime, `tick ${t}`).toBe(0);
      expect(rc.dist, `tick ${t}`).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = rc.dist;
      if (t === 0) start = rc.dist;
      t++;
      // 25 m/s over 2 m steps: a step every 0.08 s, so a sample every few ticks.
      k = Math.floor((t * speed) / 60 / 2);
    }
    expect(r.events.some((e) => e.type === 'reset' && e.car === 0)).toBe(false);
    expect(r.events.some((e) => e.type === 'wrongWay' && e.car === 0)).toBe(false);
    // The progress covered is the spine's share of the route the line runs beside.
    expect(prev - start).toBeGreaterThan(along.length * 2 * 0.6);
  });
});
