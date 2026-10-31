import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { Rng } from '../src/sim/prng';
import { createWorld, planRoads, type Contact, type World } from '../src/city/world';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { createTerrain } from '../src/city/terrain';
import type { Area } from '../src/city/districts/types';
import { pointInPolygon } from '../src/city/districts/geom';
import { regionOf } from '../src/city/districts/weekendRegion';
import { undergroundLines, undergroundClosures } from '../src/city/districts/underground';
import {
  DECK_RIGHT,
  F,
  P_OUT,
  ROAD_MID,
  ROAD_OUT,
  VERGE_OUT,
  bridgePoint,
  kickerFlight,
  profileAt,
  rampShare,
  toTravel,
  toWorld,
  undergroundBox,
  undergroundHeight,
  undergroundSite,
  worldDir,
  type Kicker,
  type UgSite,
} from '../src/city/districts/undergroundShape';
import { LEVEL_GAP } from '../src/sim/constants';
import { createCar, stepCar } from '../src/sim/car';
import { collideCarWithWorld } from '../src/sim/collision';
import { baseTuning, input, raceConfig, runAutopilot } from './helpers';

const CFG = CITY.districts.underground;

/** The next `n` Underground days from 2026-11-01. */
function undergroundSeeds(n: number): number[] {
  return weekendSeeds({ year: 2026, month: 11, dayOfMonth: 1 }, n * 4).filter((s) => weekendOf(s)?.kind === 'underground').slice(0, n);
}

const SEEDS = undergroundSeeds(20);

/** The seed's world, its Underground area and site, and the base terrain (the grade without any district). */
function site(seed: number): { w: World; a: Area; s: UgSite; base: ReturnType<typeof createTerrain> } {
  const w = createWorld(seed, 'circuit');
  const a = w.areas.find((x) => x.kind === 'underground' && x.params.planned) as Area;
  return { w, a, s: undergroundSite(a), base: createTerrain(seed) };
}

/** Coast a car over a kicker at `v` (held to the lip): where it first comes back down, travel frame, and its height over grade there. */
function throwOff(w: World, s: UgSite, base: ReturnType<typeof createTerrain>, k: Kicker, v: number): { s: number; w: number; dy: number } | null {
  const d = worldDir(s, k.hs, k.hw);
  const p = toWorld(s, k.footS - k.hs * 30, k.footW - k.hw * 30);
  const c = createCar(p.x, p.z, Math.atan2(d.x, d.z), w.heightAt(p.x, p.z));
  const t = baseTuning();
  let air = 0;
  for (let i = 0; i < 60 * 5; i++) {
    const tr = toTravel(s, c.x, c.z);
    if ((tr.s - k.lipS) * k.hs + (tr.w - k.lipW) * k.hw < -1) {
      c.vx = d.x * v;
      c.vz = d.z * v;
    }
    stepCar(c, t, input({}), { world: w });
    collideCarWithWorld(c, t, w);
    if (c.wheels.every((x) => !x.contact)) air++;
    else if (air > 20) {
      const tr2 = toTravel(s, c.x, c.z);
      return { s: tr2.s, w: tr2.w, dy: c.y - base.heightAt(c.x, c.z) };
    }
  }
  return null;
}

/** Drive a car from (s, w) along (ds, dw) at v for `ticks` (held for `hold` ticks): where it ends, its height over grade and its speed. */
function drive(w: World, s: UgSite, base: ReturnType<typeof createTerrain>, s0: number, w0: number, ds: number, dw: number, v: number, ticks: number, hold = 20) {
  const l = Math.hypot(ds, dw);
  const d = worldDir(s, ds / l, dw / l);
  const p = toWorld(s, s0, w0);
  const c = createCar(p.x, p.z, Math.atan2(d.x, d.z), w.heightAt(p.x, p.z, 1e4));
  const t = baseTuning();
  let vy = 0;
  for (let i = 0; i < ticks; i++) {
    if (i < hold) {
      c.vx = d.x * v;
      c.vz = d.z * v;
    }
    stepCar(c, t, input({ throttle: 0.3 }), { world: w });
    collideCarWithWorld(c, t, w);
    vy = Math.max(vy, Math.abs(c.vy));
  }
  const tr = toTravel(s, c.x, c.z);
  return { s: tr.s, w: tr.w, dy: c.y - base.heightAt(c.x, c.z), speed: Math.hypot(c.vx, c.vz), vy };
}

describe('the Underground', () => {
  it('carves a region and digs its trench on every one of the next 20 Underground days, and both routes drive it', () => {
    for (const seed of SEEDS) {
      const { districts, event, graph } = planRoads(seed);
      const areas = districts.areas.filter((a) => a.kind === 'underground');
      expect(areas.length, `seed ${seed}`).toBe(1);
      const a = areas[0];
      const r = regionOf(a)!;
      expect(a.params.planned, `seed ${seed}`).toBe(1);
      // The region: two cells across, four to six along, its blocks all claimed.
      expect(a.params.across).toBe(2);
      expect(a.params.along).toBeGreaterThanOrEqual(4);
      expect(a.faces.length).toBeGreaterThanOrEqual(2);
      // The trench is the spine: feature edges, dead straight, at the floor's width past the flares.
      for (const e of r.spineEdges) expect(graph.edges[e].kind).toBe('feature');
      const A = r.path[0];
      const B = r.path[r.path.length - 1];
      for (const p of r.path) expect(Math.abs((B.x - A.x) * (p.z - A.z) - (B.z - A.z) * (p.x - A.x)) / Math.hypot(B.x - A.x, B.z - A.z)).toBeLessThan(0.01);
      expect(a.params.driven0 && a.params.driven1, `seed ${seed}`).toBeTruthy();
      expect(event.special?.kind, `seed ${seed}`).toBe('underground');
      // The ramps begin right after the flares, a third of the trench is roofed, and the open floor either side holds a bridge and a kicker.
      expect(a.params.top).toBeCloseTo(a.params.half - CITY.districts.weekend.flare - CFG.endClear, 6);
      expect(a.params.roof).toBeCloseTo((a.params.top * 1) / 3, 6);
      expect(a.params.top - CFG.rampRun - a.params.roof).toBeGreaterThanOrEqual(CFG.minOpen);
    }
  });

  it('plans the same city twice', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const a = planRoads(seed);
      const b = planRoads(seed);
      expect(JSON.stringify(a.districts.areas)).toBe(JSON.stringify(b.districts.areas));
      expect(JSON.stringify(a.graph.edges)).toBe(JSON.stringify(b.graph.edges));
      expect(JSON.stringify(a.routeNodes)).toBe(JSON.stringify(b.routeNodes));
    }
  });

  it('plans no trench on a day that is not an Underground day', () => {
    const rng = new Rng(4242);
    let seen = 0;
    while (seen < 30) {
      const seed = rng.int(1, 0x7fffffff);
      if (weekendOf(seed)?.kind === 'underground') continue;
      seen++;
      const { districts, graph } = planRoads(seed);
      expect(districts.areas.some((a) => a.kind === 'underground'), `seed ${seed}`).toBe(false);
      expect(graph.edges.some((e) => e.kind === 'feature')).toBe(false);
      expect(undergroundClosures(districts.areas)).toEqual([]);
    }
  });

  it('names the special exactly when the trench is planned and both routes drive it (20270905 included)', () => {
    for (const seed of [20270905, ...SEEDS.slice(0, 6)]) {
      const { districts, event } = planRoads(seed);
      const u = districts.areas.find((x) => x.kind === 'underground');
      expect(event.special?.kind === 'underground', `seed ${seed}`).toBe(!!(u?.params.planned && u.params.special));
    }
  });

  it('hands over six lines from the entry to the exit, each clear of every solid and prop by half its width at its own level', () => {
    const contacts: Contact[] = [];
    for (const seed of SEEDS.slice(0, 5)) {
      const { w, a, s } = site(seed);
      const r = regionOf(a)!;
      const lines = undergroundLines(s, r);
      const props = w.props.filter((pr) => pointInPolygon(pr.x, pr.z, a.polygon));
      expect(lines.map((l) => l.id)).toEqual(['spine', 'left', 'right', 'plaza', 'gallery', 'bridges']);
      expect(lines[0].kind).toBe('spine');
      expect(lines.filter((l) => l.kind === 'spine').length).toBe(1);
      expect(new Set(lines.map((l) => l.level))).toEqual(new Set(['below', 'ground', 'deck']));
      for (const l of lines) {
        expect(Math.hypot(l.path[0].x - r.path[0].x, l.path[0].z - r.path[0].z)).toBeLessThan(1e-6);
        const X = r.path[r.path.length - 1];
        expect(Math.hypot(l.path[l.path.length - 1].x - X.x, l.path[l.path.length - 1].z - X.z)).toBeLessThan(1e-6);
        for (const p of l.path.slice(1, -1)) expect(pointInPolygon(p.x, p.z, a.polygon), `seed ${seed} ${l.id}`).toBe(true);
        let samples = 0;
        for (let i = 0; i + 1 < l.path.length; i++) {
          const p = l.path[i];
          const q = l.path[i + 1];
          const len = Math.hypot(q.x - p.x, q.z - p.z);
          for (let d = 0; d < len; d += 1) {
            const x = p.x + ((q.x - p.x) * d) / len;
            const z = p.z + ((q.z - p.z) * d) / len;
            if (!pointInPolygon(x, z, a.polygon)) continue;
            samples++;
            // The level the line drives: the terrain for the floor's lines (the decks are above them), the top level for the rest.
            const y = l.level === 'below' ? w.heightAt(x, z) : w.heightAt(x, z, 1e4);
            const n = w.collideCircle(x, z, l.width / 2, contacts, y + 0.3);
            const tr = toTravel(s, x, z);
            expect(n, `seed ${seed} ${l.id} meets a wall at s ${tr.s.toFixed(1)} w ${tr.w.toFixed(1)}`).toBe(0);
            for (const pr of props) {
              if (Math.abs(pr.y - y) > LEVEL_GAP) continue;
              expect(Math.hypot(pr.x - x, pr.z - z) >= pr.radius + l.width / 2, `seed ${seed} ${l.id} meets a ${pr.kind} at s ${tr.s.toFixed(1)} w ${tr.w.toFixed(1)}`).toBe(true);
            }
          }
        }
        expect(samples).toBeGreaterThan(400);
      }
    }
  });

  it('digs the floor 5 m down, ramps at 10% from just past the flares, and keeps every slope in step with its height', () => {
    const rng = new Rng(77);
    for (const seed of SEEDS.slice(0, 3)) {
      const { districts } = planRoads(seed);
      const a = districts.areas.find((x) => x.kind === 'underground' && x.params.planned) as Area;
      const s = undergroundSite(a);
      const ps = { h: 0, hs: 0, hw: 0 };
      expect(profileAt(s, 0, 0, ps).h).toBeCloseTo(-CFG.depth, 6);
      let steepest = 0;
      for (let u = -s.top - 2; u <= s.top + 2; u += 0.5) {
        // Along the axis away from the kickers: the floor's ramps.
        if (s.kickers.some((k) => Math.abs(u - k.lipS) < k.length + 3)) continue;
        profileAt(s, u, -5.5, ps);
        steepest = Math.max(steepest, Math.abs(ps.hs));
        expect(ps.h).toBeLessThanOrEqual(1e-9);
      }
      expect(steepest).toBeGreaterThan(0.095);
      expect(steepest).toBeLessThan(0.105);
      expect(rampShare(s, s.top)).toBe(0);
      expect(rampShare(s, s.fh)).toBe(1);
      // Nothing beyond the box: the profile is 0 all round its edge.
      const box = undergroundBox(s);
      for (let k = 0; k <= 200; k++) {
        const t = k / 200;
        for (const [x, z] of [
          [box.minX + (box.maxX - box.minX) * t, box.minZ],
          [box.minX + (box.maxX - box.minX) * t, box.maxZ],
          [box.minX, box.minZ + (box.maxZ - box.minZ) * t],
          [box.maxX, box.minZ + (box.maxZ - box.minZ) * t],
        ]) {
          const o = { h: 0, gx: 0, gz: 0 };
          undergroundHeight(s, x, z, o);
          expect(o.h).toBe(0);
        }
      }
      // Numeric slopes against the analytic gradient: anywhere, and half the samples where the shapes are busy (kickers,
      // windows, passages, the gallery, the bridges' humps). The min's kinks lie under walls; compare away from them.
      const e = 0.001;
      const h = (x: number, z: number) => {
        const o = { h: 0, gx: 0, gz: 0 };
        undergroundHeight(s, x, z, o);
        return o;
      };
      const g = s.gallery;
      const busy: (() => [number, number])[] = [
        () => {
          const k = s.kickers[rng.int(0, 2)];
          return [k.lipS + rng.range(-12, 3), k.lipW + rng.range(-3, 3)];
        },
        () => [s.windows[rng.int(0, 1)] + rng.range(-19, 19), rng.range(F - 0.5, F + CFG.demolished.run + 0.5)],
        () => [rng.range(g.s0 - 2, g.s1 + 2), rng.range(P_OUT, DECK_RIGHT + 1)],
        () => {
          const br = s.bridges[rng.int(0, 1)];
          const p = bridgePoint(br, rng.range(-ROAD_OUT, ROAD_OUT) / Math.abs(br.aw), rng.range(-5, 5));
          return [p.s, p.w];
        },
      ];
      let compared = 0;
      for (let k = 0; k < 4000; k++) {
        const [u, v] = k % 2 === 0 ? busy[rng.int(0, busy.length - 1)]() : [rng.range(-s.top, s.top), rng.range(-DECK_RIGHT, DECK_RIGHT)];
        const p = toWorld(s, u, v);
        const o = h(p.x, p.z);
        const gx = (h(p.x + e, p.z).h - h(p.x - e, p.z).h) / (2 * e);
        const gz = (h(p.x, p.z + e).h - h(p.x, p.z - e).h) / (2 * e);
        if (Math.abs(o.gx - gx) > 2e-3 || Math.abs(o.gz - gz) > 2e-3) {
          // A kink (the min of two shapes, a kicker's lip): the one-sided slope still matches the gradient on one side.
          const probe = (dx: number, dz: number) => Math.abs(h(p.x + dx, p.z + dz).h - o.h - o.gx * dx - o.gz * dz);
          expect(Math.min(probe(1e-4, 0), probe(-1e-4, 0)) + Math.min(probe(0, 1e-4), probe(0, -1e-4)), `seed ${seed} s ${u} w ${v}`).toBeLessThan(4e-3);
        }
        compared++;
      }
      expect(compared).toBe(4000);
    }
  });

  it('stacks the plaza over the tunnel and the gallery, and each bridge over the floor: two levels at every sample point', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const { w, s, base } = site(seed);
      const at = (u: number, v: number) => toWorld(s, u, v);
      const grade = (u: number, v: number) => base.heightAt(at(u, v).x, at(u, v).z);
      const hi = (u: number, v: number) => w.heightAt(at(u, v).x, at(u, v).z, 1e4) - grade(u, v);
      const lo = (u: number, v: number) => w.heightAt(at(u, v).x, at(u, v).z, -1e4) - grade(u, v);
      // The roof: the deck at grade over the tunnel (5 m down) and over the gallery's floor (6.5 m down in its middle).
      for (const d of s.decks) {
        const u = (d.s0 + d.s1) / 2;
        const v = (d.w0 + d.w1) / 2;
        expect(Math.abs(hi(u, v)), `seed ${seed} deck ${u} ${v}`).toBeLessThan(0.02);
      }
      for (const u of [-s.R + 2, 0, s.R - 2]) {
        expect(Math.abs(hi(u, 0))).toBeLessThan(0.02);
        expect(lo(u, 0)).toBeCloseTo(-CFG.depth, 1);
        expect(w.surfaceAt(at(u, 0).x, at(u, 0).z, grade(u, 0) + 0.2)).toBe('road');
        expect(w.surfaceAt(at(u, 0).x, at(u, 0).z, grade(u, 0) - CFG.depth)).toBe('concrete');
      }
      // The openings: no deck, the floor under both levels.
      for (const o of s.openings) {
        const u = (o.s0 + o.s1) / 2;
        const v = (o.w0 + o.w1) / 2;
        expect(hi(u, v), `seed ${seed} opening ${o.id}`).toBeCloseTo(-CFG.depth, 1);
      }
      // The bridges: the deck its rise over grade, the floor beneath.
      for (const br of s.bridges) {
        for (const p of [-4, 0, 4]) {
          const pt = bridgePoint(br, p / Math.abs(br.aw), 0);
          expect(hi(pt.s, pt.w)).toBeCloseTo(CFG.bridge.rise, 2);
          expect(lo(pt.s, pt.w)).toBeLessThan(-CFG.depth + 0.6);
        }
        // Level where the deck meets the road: no step and no slope to throw a car.
        const end = bridgePoint(br, (P_OUT + 0.05) / Math.abs(br.aw), 0);
        const inn = bridgePoint(br, (P_OUT - 0.05) / Math.abs(br.aw), 0);
        expect(Math.abs(hi(end.s, end.w) - hi(inn.s, inn.w))).toBeLessThan(0.02);
      }
      // The gallery: its floor the drop below the trench floor in its middle, at the floor's level in the passages.
      const g = s.gallery;
      expect(lo((g.down + g.up) / 2 + CFG.gallery.ramp / 2, (CFG.gallery.inner + CFG.gallery.outer) / 2)).toBeCloseTo(-CFG.depth - CFG.gallery.drop, 1);
      for (const p of g.passages) expect(lo((p.ps + p.qs) / 2, (p.pw + p.qw) / 2)).toBeCloseTo(-CFG.depth, 1);
      // The wall between the tunnel and the gallery is solid where they run side by side; the roof's walls stand for neither deck car.
      const contacts: Contact[] = [];
      const mid = toWorld(s, (g.down + g.up) / 2 + CFG.gallery.ramp / 2, (F + CFG.gallery.inner) / 2);
      expect(w.collideCircle(mid.x, mid.z, 0.9, contacts, grade(0, 0) - CFG.depth)).toBeGreaterThan(0);
      expect(w.collideCircle(mid.x, mid.z, 0.9, contacts, w.heightAt(mid.x, mid.z, 1e4))).toBe(0);
    }
  });

  it('throws a car up onto the plaza and the service roads, and every landing between the least and the aim speed is clear', () => {
    const { w, s, base } = site(SEEDS[0]);
    const K = CFG.kicker;
    const contacts: Contact[] = [];
    for (const k of s.kickers) {
      // Measured with the sim: the throw at the aim speed lands up on the level above, clear of the opening's far edge.
      for (const v of k.id === 'plaza' ? [K.deckSpeed + 3, 35, K.aimSpeed] : [K.clearSpeed + 2, K.aimSpeed]) {
        const land = throwOff(w, s, base, k, v);
        expect(land, `${k.id} at ${v}`).not.toBeNull();
        expect(Math.abs(land!.dy), `${k.id} at ${v} lands up top, at s ${land!.s.toFixed(1)} w ${land!.w.toFixed(1)}`).toBeLessThan(1);
        if (k.id === 'plaza') expect(land!.s).toBeGreaterThan(s.openings[0].s1);
        else expect(Math.abs(land!.w)).toBeGreaterThan(P_OUT);
      }
      // Under the least speed the plaza throw falls back through its opening; the side throws meet the kerb.
      const short = throwOff(w, s, base, k, 22);
      expect(short && short.dy < -2, `${k.id} at 22`).toBe(true);
      // The ballistic landing strip: no wall standing at the level above and no prop within the car's reach of it.
      const lo = k.id === 'plaza' ? K.deckSpeed + 3 : K.clearSpeed;
      for (let v = lo; v <= K.aimSpeed + 4; v += 1) {
        const f = kickerFlight(k, v);
        const p = toWorld(s, f.s, f.w);
        const y = w.heightAt(p.x, p.z, 1e4);
        expect(w.collideCircle(p.x, p.z, 1.05, contacts, y + 0.3), `${k.id} at ${v} lands on a wall`).toBe(0);
        for (const pr of w.props) if (Math.abs(pr.y - y) < LEVEL_GAP) expect(Math.hypot(pr.x - p.x, pr.z - p.z) > pr.radius + 2, `${k.id} at ${v} lands on a ${pr.kind}`).toBe(true);
      }
    }
    // The plaza kicker rises 6.4 m over its lip at 40 m/s (its 2.2 m lip over the floor: 8.6 m over the floor).
    expect(kickerFlight(s.kickers[1], 40).apex + CFG.depth).toBeGreaterThan(8.4);
  });

  it('drops a car through the roof, off the windows and over the bridges in one piece', () => {
    const { w, s, base } = site(SEEDS[0]);
    // The drop opening: a plaza car driving into its open end falls to the floor and drives on.
    const oD = s.openings[1];
    for (const v of [12, 25]) {
      const r = drive(w, s, base, oD.s0 - 20, (oD.w0 + oD.w1) / 2, 1, 0, v, 240);
      expect(r.dy, `drop at ${v}`).toBeLessThan(-CFG.depth + 0.6);
      expect(r.speed).toBeGreaterThan(v * 0.7);
    }
    // A demolished window: off the right road, down the rubble, on along the floor.
    for (const c of s.windows) {
      const r = drive(w, s, base, c - 25, ROAD_MID, 25, 5.6 - ROAD_MID, 20, 150);
      expect(r.dy, `window ${c}`).toBeLessThan(-1.5);
      expect(r.speed).toBeGreaterThan(12);
    }
    // A bridge at speed: a hop off its far hump, never a throw.
    for (const br of s.bridges) {
      for (const v of [15, 30]) {
        const a0 = bridgePoint(br, -ROAD_MID / Math.abs(br.aw) - 6, 0);
        const r = drive(w, s, base, a0.s, a0.w, br.as, br.aw, v, 70, 10);
        expect(r.vy, `bridge ${br.s} at ${v}`).toBeLessThan(6);
        expect(r.dy).toBeGreaterThan(-0.5);
      }
    }
  });

  it('paints the slick patches: the burst main, the mud at the spoil heap and the gallery floor', () => {
    for (const seed of SEEDS.slice(0, 2)) {
      const { w, s, base } = site(seed);
      for (const [r, deep] of [
        [s.burst, true],
        [s.mud, false],
        [s.wet, true],
      ] as const) {
        const p = toWorld(s, (r.s0 + r.s1) / 2, (r.w0 + r.w1) / 2);
        const y = deep ? w.heightAt(p.x, p.z) : base.heightAt(p.x, p.z);
        expect(w.surfaceAt(p.x, p.z, y), `seed ${seed}`).toBe('slick');
      }
      // The service roads are asphalt and the verges firm.
      const p = toWorld(s, -s.fh, -ROAD_MID);
      expect(w.surfaceAt(p.x, p.z)).toBe('road');
      const q = toWorld(s, -s.fh - 30, VERGE_OUT - 1);
      expect(w.surfaceAt(q.x, q.z)).toBe('quay');
    }
  });

  it('a circuit through it: the AI keeps off the kickers and the bus, every car finishes and none is reset', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const r = runAutopilot(raceConfig(seed, 'circuit'), 420, true);
      expect(r.cars.every((c) => c.finished), `seed ${seed}`).toBe(true);
      expect(r.events.filter((e) => e.type === 'reset').length, `seed ${seed}`).toBe(0);
    }
  });
});
