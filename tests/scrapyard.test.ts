import { describe, expect, it } from 'vitest';
import { planRoads } from '../src/city/world';
import { routeEdges as routeEdgesOf } from '../src/city/events';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { CITY } from '../src/city/config';
import { createTerrain } from '../src/city/terrain';
import { bankedRing, bankedRingMod, crestHeight, tangentRings } from '../src/city/districts/banking';
import type { HeightSample } from '../src/city/districts/types';
import { scrapLayout, yardJumpMods } from '../src/city/districts/scrapyard';
import { yardPoint } from '../src/city/districts/scrapyardLayout';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { PROP_DEFS } from '../src/city/props';
import { driftZones } from '../src/sim/driftZones';
import { gateBlocking } from '../src/sim/gates';
import type { GateCycle } from '../src/sim/gates';
import { createRace, stepRace } from '../src/sim/race';
import type { RaceState } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { yawOf } from '../src/sim/math';
import { Rng } from '../src/sim/prng';
import { input, raceConfig } from './helpers';

const C = CITY.districts.scrapyard;

/** The next `n` scrapyard days from the first weekend of the test season. */
function scrapSeeds(n: number): number[] {
  return weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, n * 3 + 3).filter((s) => weekendOf(s)!.kind === 'scrapyard').slice(0, n);
}

/** Height and gradient of a modifier at a point. */
function sample(mod: { add(x: number, z: number, out: HeightSample): void }, x: number, z: number): HeightSample {
  const out = { h: 0, gx: 0, gz: 0 };
  mod.add(x, z, out);
  return out;
}

const SEEDS = scrapSeeds(20);
const MAIN = 20261031;

/** The first tick at or after `from` where the press stays open for the next ten seconds. */
function openTick(c: GateCycle, from: number): number {
  for (let t = from; ; t++) {
    let open = true;
    for (let k = 0; k < 600 && open; k += 20) open = !gateBlocking(c, t + k);
    if (open) return t;
  }
}

/** A race on the first Scrapyard day, built once for the tests that drive in it. */
let shared: RaceState | null = null;
function race(): RaceState {
  if (!shared) shared = createRace(raceConfig(MAIN, 'circuit', 0));
  const r = createRace(raceConfig(MAIN, 'circuit', 0), shared.world);
  r.tick = r.countdownTicks;
  r.phase = 'racing';
  return r;
}

describe('the scrapyard plan', () => {
  it('plans one yard on a route block on at least 19 of the next 20 Scrapyard days, the same every time', () => {
    expect(SEEDS).toHaveLength(20);
    let planned = 0;
    for (const seed of SEEDS) {
      const plan = planRoads(seed);
      const areas = plan.districts.areas.filter((a) => a.kind === 'scrapyard');
      expect(areas.length).toBeLessThanOrEqual(1);
      if (areas.length !== 1) continue;
      planned++;
      expect(plan.event.special?.kind).toBe('scrapyard');
      // It touches a route edge (its frontage is the route street) and holds the block's corner nodes.
      const routeEdges = new Set(Object.values(plan.routeNodes).flatMap((nodes, i) => routeEdgesOf(plan.graph, nodes, i === 0)));
      expect(areas[0].edges.some((e) => routeEdges.has(e))).toBe(true);
      expect(areas[0].nodes.length).toBeGreaterThan(2);
      expect(areas[0].params.cuts).toBeGreaterThanOrEqual(2);
      const again = planRoads(seed);
      expect(JSON.stringify(again.districts.areas)).toBe(JSON.stringify(plan.districts.areas));
    }
    expect(planned).toBeGreaterThanOrEqual(19);
  });

  it('plans nothing on weekdays and on the other weekend specials', () => {
    const others = weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 6).filter((s) => weekendOf(s)!.kind !== 'scrapyard');
    for (const seed of [20261026, 20261027, ...others.slice(0, 2)]) expect(planRoads(seed).districts.areas.some((a) => a.kind === 'scrapyard')).toBe(false);
  });
});

describe('banked rings', () => {
  const ring = bankedRing(100, -40, 22, C.bank);
  const mod = bankedRingMod(ring);

  it('rise to the configured crest over the floor and fall back to grade, 0 outside the box', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 0; r <= ring.rimR + 1; r += 0.05) {
      const h = sample(mod, ring.cx + r, ring.cz).h;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(lo).toBeCloseTo(-C.bank.dip, 6);
    expect(hi).toBeCloseTo(crestHeight(ring), 3);
    expect(hi - lo).toBeCloseTo(C.bank.rise, 3);
    expect(sample(mod, ring.cx + ring.rimR + 0.5, ring.cz)).toEqual({ h: 0, gx: 0, gz: 0 });
    // The box edge: the modifier is exactly 0 and flat there.
    expect(sample(mod, mod.maxX - 1e-9, ring.cz).h).toBeCloseTo(0, 9);
    expect(sample(mod, ring.cx, mod.minZ + 1e-9).h).toBeCloseTo(0, 9);
  });

  it('has a gradient that matches the numeric slope everywhere, banks included', () => {
    const rng = new Rng(4242);
    const e = 1e-4;
    for (let i = 0; i < 400; i++) {
      const x = ring.cx + rng.range(-ring.rimR - 2, ring.rimR + 2);
      const z = ring.cz + rng.range(-ring.rimR - 2, ring.rimR + 2);
      const s = sample(mod, x, z);
      const gx = (sample(mod, x + e, z).h - sample(mod, x - e, z).h) / (2 * e);
      const gz = (sample(mod, x, z + e).h - sample(mod, x, z - e).h) / (2 * e);
      expect(Math.abs(s.gx - gx)).toBeLessThan(2e-3);
      expect(Math.abs(s.gz - gz)).toBeLessThan(2e-3);
    }
    // The bank's steepest slope is smoothstep's 1.5 x rise / width.
    let steepest = 0;
    for (let r = ring.floorR; r <= ring.crestR; r += 0.02) steepest = Math.max(steepest, Math.abs(sample(mod, ring.cx + r, ring.cz).gx));
    expect(steepest).toBeCloseTo((1.5 * C.bank.rise) / C.bank.bankWidth, 2);
  });

  it('compose into a figure eight whose rims touch at a flat neck at grade', () => {
    const [a, b] = tangentRings(0, 0, 1, 0, 22, C.bank);
    expect(b.cx - a.cx).toBeCloseTo(2 * a.rimR, 9);
    const sum = (x: number, z: number) => sample(bankedRingMod(a), x, z).h + sample(bankedRingMod(b), x, z).h;
    expect(sum(0, 0)).toBe(0);
    expect(sum(0, 1.5)).toBeCloseTo(0, 9);
  });
});

describe('the yard in a world', () => {
  const r0 = race();
  const w = r0.world;
  const area = w.areas.find((a) => a.kind === 'scrapyard')!;
  const L = scrapLayout(area);
  const base = createTerrain(MAIN);

  it('digs both bowls a metre under grade, banks them to the configured crest and keeps slopes exact', () => {
    for (const ring of L.rings) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let a = 0; a < 6.28; a += 0.5) {
        for (let r = 0; r <= ring.rimR; r += 0.5) {
          const x = ring.cx + Math.cos(a) * r;
          const z = ring.cz + Math.sin(a) * r;
          const d = w.heightAt(x, z) - base.heightAt(x, z);
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
      expect(lo).toBeCloseTo(-C.bank.dip, 1);
      expect(hi).toBeCloseTo(C.bank.rise - C.bank.dip, 1);
      expect(w.surfaceAt(ring.cx, ring.cz + 3)).toBe('offroad');
    }
    // The world's slope answers match its heights in the bowls, the pit and on the kicker.
    const rng = new Rng(99);
    for (let i = 0; i < 300; i++) {
      const p = yardPoint(L.frame, rng.range(0, L.L), rng.range(0, L.D));
      const s = w.slopeAt(p.x, p.z);
      const e = 0.002;
      const gx = (w.heightAt(p.x + e, p.z) - w.heightAt(p.x - e, p.z)) / (2 * e);
      const gz = (w.heightAt(p.x, p.z + e) - w.heightAt(p.x, p.z - e)) / (2 * e);
      expect(Math.abs(s.gx - gx)).toBeLessThan(5e-3);
      expect(Math.abs(s.gz - gz)).toBeLessThan(5e-3);
    }
  });

  it('has a kicker whose slope at the lip is 25 to 32 percent, solid sides and a shallow pit past it', () => {
    const K = C.kicker;
    const up = yardPoint(L.frame, L.canyon.u, L.canyon.lip + 0.05);
    const dn = yardPoint(L.frame, L.canyon.u, L.canyon.lip + 0.55);
    const slope = (w.heightAt(up.x, up.z) - w.heightAt(dn.x, dn.z)) / 0.5;
    expect(slope).toBeGreaterThan(0.25);
    expect(slope).toBeLessThan(0.32);
    const lip = yardPoint(L.frame, L.canyon.u, L.canyon.lip);
    expect(w.heightAt(lip.x, lip.z) - base.heightAt(lip.x, lip.z)).toBeCloseTo(K.rise, 2);
    const pit = L.pit;
    expect(w.heightAt(pit.x, pit.z) - base.heightAt(pit.x, pit.z)).toBeLessThan(-C.pit.depth * 0.5);
    // The mods fade to nothing at their boxes (checked on the pit's and kicker's own).
    for (const m of yardJumpMods(L.frame, L.R, L.canyon.u, L.canyon.lip)) {
      for (const corner of [[m.minX, m.minZ], [m.maxX, m.maxZ], [m.minX, m.maxZ], [m.maxX, m.minZ]]) expect(Math.abs(sample(m, corner[0], corner[1]).h)).toBeLessThan(1e-9);
    }
    // The canyon's walls stand either side of the kicker, every one a solid.
    const walls = w.walls.filter((x) => x.area === area.id && x.look === 'carStack');
    expect(walls.length).toBeGreaterThan(80);
    expect(walls.every((x) => x.solid)).toBe(true);
  });

  it('is a drift zone over the eight', () => {
    const zones = driftZones(w).filter((z) => z.area === area.id);
    expect(zones).toHaveLength(1);
    expect(zones[0].kind).toBe('scrap');
    for (const ring of L.rings) expect(pointInPolygon(ring.cx + 5, ring.cz + 5, zones[0].polygon)).toBe(true);
    expect(pointInPolygon(L.neck.x, L.neck.z, zones[0].polygon)).toBe(true);
  });

  it('keeps every stack off the bowls\' ring roads, an island of stacks in each middle, and the canyon 5 m wide', () => {
    const inner = C.island.ringInner;
    for (const s of L.stacks) {
      for (const ring of L.rings) {
        const ds = s.poly.map((p) => Math.hypot(p.x - ring.cx, p.z - ring.cz));
        if (s.kind === 'island') {
          if (Math.min(...ds) < ring.crestR) expect(Math.max(...ds)).toBeLessThanOrEqual(inner);
        } else {
          // Not inside the annulus [inner, crest]: wholly outside the crest.
          expect(Math.min(...ds)).toBeGreaterThan(ring.crestR);
        }
      }
    }
    expect(L.stacks.filter((s) => s.kind === 'island')).toHaveLength(2 * C.island.count);
    // The canyon's two walls are the aisle apart (stack to stack across it).
    const canyon = L.stacks.filter((s) => s.kind === 'canyon');
    const lateral = (x: number, z: number) => (x - L.frame.o.x) * L.frame.u.x + (z - L.frame.o.z) * L.frame.u.z - L.canyon.u;
    const left = Math.max(...canyon.flatMap((s) => s.poly.map((p) => lateral(p.x, p.z))).filter((d) => d < 0));
    const right = Math.min(...canyon.flatMap((s) => s.poly.map((p) => lateral(p.x, p.z))).filter((d) => d > 0));
    expect(right - left).toBeCloseTo(C.canyon.aisle, 2);
    // Walls never on a road: every wall of the yard stands inside its own block polygon.
    for (const wall of w.walls.filter((x) => x.area === area.id)) {
      const mx = (wall.ax + wall.bx) / 2;
      const mz = (wall.az + wall.bz) / 2;
      expect(pointInPolygon(mx, mz, area.polygon) || distToPolygonEdge(mx, mz, area.polygon) < 1).toBe(true);
    }
  });

  it('draws every wall look it uses, and leaves a clear way in at each cut', () => {
    const looks = new Set(w.walls.filter((x) => x.area === area.id).map((x) => x.look));
    expect([...looks].sort()).toEqual(['carStack', 'crusher', 'scrapFence']);
    expect(area.params.cuts).toBeGreaterThanOrEqual(2);
    // At the middle of each cut the way is open: no wall within a car's width of the line from the street into the yard.
    const P = area.params;
    for (let i = 0; i < P.cuts; i++) {
      const p = area.polygon[P[`c${i}e`]];
      const q = area.polygon[(P[`c${i}e`] + 1) % area.polygon.length];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const t = P[`c${i}t`];
      const x = p.x + ((q.x - p.x) / len) * t;
      const z = p.z + ((q.z - p.z) / len) * t;
      expect(w.wallClearance(x, z, 2)).toBeGreaterThan(1.5);
    }
  });

  it('puts the press across the canyon as a timed gate closed about a third of the time', () => {
    const gates = w.timedGates!;
    const gi = gates.gates.findIndex((g) => g.look === 'crusher');
    expect(gi).toBeGreaterThanOrEqual(0);
    const g = gates.gates[gi];
    const cycle = gates.cycles[g.cycle];
    let blocked = 0;
    for (let t = 0; t < cycle.period; t++) if (gateBlocking(cycle, cycle.start + t)) blocked++;
    expect(blocked / cycle.period).toBeGreaterThan(0.3);
    expect(blocked / cycle.period).toBeLessThan(0.37);
    // It spans the aisle exactly, between the two walls.
    expect(Math.hypot(g.bx - g.ax, g.bz - g.az)).toBeCloseTo(C.canyon.aisle, 6);
    // And it stops a car coming down the canyon while it is down, which drives through while it is open.
    const F = L.frame;
    const run = (closed: boolean): number => {
      const r = race();
      const c = r.cars[0].state;
      const from = yardPoint(F, L.canyon.u, L.canyon.press + 9);
      const dir = { x: -F.w.x, z: -F.w.z };
      // A tick in the middle of a closure, or well into the open stretch.
      const closedAt = cycle.start + Math.round(cycle.warn + cycle.lower + cycle.closed / 2);
      r.tick = closed ? closedAt : cycle.start + cycle.period - Math.round(cycle.period * 0.12);
      placeCar(c, from.x, from.z, yawOf(dir.x, dir.z), r.world);
      r.cars[0].seg = -1;
      c.vx = dir.x * 9;
      c.vz = dir.z * 9;
      for (const wh of c.wheels) wh.spinRate = 9 / r.cars[0].tuning.geometry.wheelRadius;
      let at = Infinity;
      for (let i = 0; i < 110; i++) {
        stepRace(r, input({ throttle: 0.6 }));
        at = Math.min(at, (c.x - F.o.x) * F.w.x + (c.z - F.o.z) * F.w.z);
      }
      return at;
    };
    expect(run(true)).toBeGreaterThan(L.canyon.press - 0.2);
    expect(run(false)).toBeLessThan(L.canyon.press - 3);
  });

  it('launches a car off the kicker past the pit at speed, and a slow one drops into it', () => {
    const F = L.frame;
    const fly = (speed: number) => {
      const r = race();
      const rc = r.cars[0];
      const c = rc.state;
      // The gate is out of the way: this is the jump only.
      r.tick = openTick(w.timedGates!.cycles[w.timedGates!.gates.findIndex((g) => g.look === 'crusher')], r.tick);
      const from = yardPoint(F, L.canyon.u, L.canyon.lip + 18);
      const dir = { x: -F.w.x, z: -F.w.z };
      placeCar(c, from.x, from.z, yawOf(dir.x, dir.z), r.world);
      rc.seg = -1;
      c.vx = dir.x * speed;
      c.vz = dir.z * speed;
      for (const wh of c.wheels) wh.spinRate = speed / rc.tuning.geometry.wheelRadius;
      let air = 0;
      let landed = NaN;
      for (let i = 0; i < 300; i++) {
        const v = Math.hypot(c.vx, c.vz);
        stepRace(r, input({ throttle: v < speed ? 1 : 0 }));
        const wv = (c.x - F.o.x) * F.w.x + (c.z - F.o.z) * F.w.z;
        if (wv < L.canyon.lip + 0.5 && c.airTime > 0) air = Math.max(air, c.airTime);
        if (air > 0.3 && Number.isNaN(landed) && c.airTime === 0) landed = wv;
      }
      return { air, landed };
    };
    const pitEnd = 2 * L.rimR;
    const slow = fly(9);
    const fast = fly(15);
    expect(fast.air).toBeGreaterThan(0.8);
    expect(fast.landed).toBeLessThan(pitEnd);
    expect(slow.landed).toBeGreaterThan(pitEnd);
  });

  it('breaks a tyre stack like any prop: a dull knock at speed, then it stays down', () => {
    const def = PROP_DEFS.tyreStack;
    expect(def.radius).toBeCloseTo(0.5, 1);
    expect(def.mass).toBeCloseTo(60, -1);
    const stacks = w.props.filter((p) => p.kind === 'tyreStack' && p.area === area.id);
    expect(stacks.length).toBeGreaterThan(12);
    // The first one down the canyon: nothing between it and the run up.
    const F = L.frame;
    const inCanyon = stacks
      .map((p) => ({ p, wv: (p.x - F.o.x) * F.w.x + (p.z - F.o.z) * F.w.z, uv: (p.x - F.o.x) * F.u.x + (p.z - F.o.z) * F.u.z - L.canyon.u }))
      .filter((q) => Math.abs(q.uv) < 1.5 && q.wv > L.canyon.press + 2)
      .sort((a, b) => b.wv - a.wv);
    expect(inCanyon.length).toBeGreaterThan(0);
    const { p, wv, uv } = inCanyon[0];
    const r = race();
    r.tick = openTick(w.timedGates!.cycles[w.timedGates!.gates.findIndex((g) => g.look === 'crusher')], r.tick);
    const rc = r.cars[0];
    const c = rc.state;
    const dir = { x: -F.w.x, z: -F.w.z };
    const from = yardPoint(F, L.canyon.u + uv, wv + 9);
    placeCar(c, from.x, from.z, yawOf(dir.x, dir.z), r.world);
    rc.seg = -1;
    c.vx = dir.x * 14;
    c.vz = dir.z * 14;
    for (const wh of c.wheels) wh.spinRate = 14 / rc.tuning.geometry.wheelRadius;
    let before = 0;
    let after = 0;
    let hit = -1;
    for (let i = 0; i < 120; i++) {
      const v = Math.hypot(c.vx, c.vz);
      const n = r.events.length;
      stepRace(r, input({ throttle: 0.2 }));
      if (hit < 0 && r.events.slice(n).some((e) => e.type === 'prop' && e.value === p.id)) {
        hit = r.tick;
        before = v;
      } else if (hit >= 0 && r.tick === hit + 2) {
        after = Math.hypot(c.vx, c.vz);
        break;
      }
    }
    expect(hit).toBeGreaterThan(0);
    expect(r.brokenProps[p.id]).toBe(1);
    const loss = 1 - after / before;
    expect(loss).toBeGreaterThan(0.005);
    expect(loss).toBeLessThan(0.12);
  });
});
