import { describe, expect, it } from 'vitest';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { World } from '../src/city/world';
import { routeEdges as routeEdgesOf } from '../src/city/events';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { CITY } from '../src/city/config';
import { bankMod, bankedRingMod } from '../src/city/districts/banking';
import type { Area, HeightMod, HeightSample } from '../src/city/districts/types';
import { deckSurface, scrapLayout } from '../src/city/districts/scrapyard';
import type { ScrapLayout } from '../src/city/districts/scrapyard';
import { humpMod, pitMod, tableMod, frameCoords, framePoint } from '../src/city/districts/scrapyardShapes';
import { districtModule } from '../src/city/districts/index';
import { distToPolygonEdge, distToPolyline, pointInPolygon } from '../src/city/districts/geom';
import { createTerrain } from '../src/city/terrain';
import { regionOf, spineDirection, spineWidths } from '../src/city/districts/weekendRegion';
import { PROP_DEFS } from '../src/city/props';
import { driftZones } from '../src/sim/driftZones';
import { gateBlocking } from '../src/sim/gates';
import type { GateCycle } from '../src/sim/gates';
import { createRace, stepRace } from '../src/sim/race';
import type { RaceState } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { yawOf } from '../src/sim/math';
import type { Vec2 } from '../src/sim/math';
import { Rng } from '../src/sim/prng';
import { carSnapshot, input, raceConfig, runAutopilot } from './helpers';

const C = CITY.districts.scrapyard;

/** The next `n` Scrapyard days from the first weekend of the test season. */
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

/** A built world per seed, shared by the tests that read one. */
const worlds = new Map<number, World>();
function worldOf(seed: number): World {
  let w = worlds.get(seed);
  if (!w) worlds.set(seed, (w = createWorld(seed, 'circuit', createCity(seed))));
  return w;
}
const yardOf = (w: World): { area: Area; L: ScrapLayout } => {
  const area = w.areas.find((a) => a.kind === 'scrapyard')!;
  return { area, L: scrapLayout(area) };
};

/** The first tick at or after `from` where the press stays open for the next ten seconds. */
function openTick(c: GateCycle, from: number): number {
  for (let t = from; ; t++) {
    let open = true;
    for (let k = 0; k < 600 && open; k += 20) open = !gateBlocking(c, t + k);
    if (open) return t;
  }
}

/** A racing car on the first Scrapyard day's world, its race built fresh each time. */
let shared: RaceState | null = null;
function race(): RaceState {
  if (!shared) shared = createRace(raceConfig(MAIN, 'circuit', 0), worldOf(MAIN));
  const r = createRace(raceConfig(MAIN, 'circuit', 0), shared.world);
  r.tick = r.countdownTicks;
  r.phase = 'racing';
  return r;
}

/** Launch the car from `back` m before a kicker's lip at `speed` along it, coasting from the lip; first touchdown after the flight. */
function fly(k: { lip: Vec2; dir: Vec2 }, speed: number, back: number) {
  const r = race();
  const w = r.world;
  const gates = w.timedGates!;
  r.tick = openTick(gates.cycles[gates.gates[gates.gates.findIndex((g) => g.look === 'crusher')].cycle], r.tick);
  const rc = r.cars[0];
  const c = rc.state;
  placeCar(c, k.lip.x - k.dir.x * back, k.lip.z - k.dir.z * back, yawOf(k.dir.x, k.dir.z), w);
  rc.seg = -1;
  c.vx = k.dir.x * speed;
  c.vz = k.dir.z * speed;
  for (const wh of c.wheels) wh.spinRate = speed / rc.tuning.geometry.wheelRadius;
  let lip = 0;
  let air = 0;
  let apex = -Infinity;
  let landed: { x: number; z: number; y: number } | null = null;
  for (let i = 0; i < 300 && !landed; i++) {
    const s = (c.x - k.lip.x) * k.dir.x + (c.z - k.lip.z) * k.dir.z;
    stepRace(r, input({ throttle: s < 0 && Math.hypot(c.vx, c.vz) < speed ? 1 : 0 }));
    if (s < 0) lip = Math.hypot(c.vx, c.vz);
    if (c.airTime > 0) {
      air = Math.max(air, c.airTime);
      apex = Math.max(apex, c.y);
    } else if (air > 0.25) landed = { x: c.x, z: c.z, y: c.y };
  }
  return { lip, air, apex: apex - w.heightAt(k.lip.x, k.lip.z), landed, resets: r.events.filter((e) => e.type === 'reset').length, world: w };
}

describe('the Scrapyard plan', () => {
  it('carves a region and fits the yard on every one of the next 20 Scrapyard days, both routes through it, the same every time', () => {
    expect(SEEDS).toHaveLength(20);
    for (const seed of SEEDS) {
      const plan = planRoads(seed);
      const areas = plan.districts.areas.filter((a) => a.kind === 'scrapyard');
      expect(areas.length, `seed ${seed}`).toBe(1);
      const a = areas[0];
      const r = regionOf(a)!;
      expect(a.params.planned, `seed ${seed}`).toBe(1);
      expect(C.crestRadii as readonly number[]).toContain(a.params.R);
      expect(a.params.along * a.params.across).toBeGreaterThanOrEqual(9);
      expect(plan.event.special?.kind).toBe('scrapyard');
      expect(spineDirection(plan.graph, plan.routeNodes.circuit, true, r)).not.toBe(0);
      expect(spineDirection(plan.graph, plan.routeNodes.sprint, false, r)).not.toBe(0);
      const routeEdges = new Set(Object.values(plan.routeNodes).flatMap((nodes, i) => routeEdgesOf(plan.graph, nodes, i === 0)));
      for (const e of r.spineEdges) expect(routeEdges.has(e)).toBe(true);
      expect(a.params.cuts).toBe(0);
      const again = planRoads(seed);
      expect(JSON.stringify(again.districts.areas)).toBe(JSON.stringify(plan.districts.areas));
    }
  });

  it('hands over five lines, entry to exit, inside the region, on every Scrapyard day', () => {
    for (const seed of SEEDS) {
      const plan = planRoads(seed);
      const a = plan.districts.areas.find((x) => x.kind === 'scrapyard')!;
      const r = regionOf(a)!;
      const lines = districtModule('scrapyard').lines!(a);
      expect(lines.map((l) => l.id)).toEqual(['spine', 'eight', 'canyon', 'deck', 'perimeter']);
      expect(lines.map((l) => l.kind)).toEqual(['spine', 'alt', 'alt', 'alt', 'alt']);
      expect(lines.find((l) => l.id === 'deck')!.level).toBe('deck');
      for (const l of lines) {
        expect(l.path[0]).toEqual(r.path[0]);
        expect(l.path[l.path.length - 1]).toEqual(r.path[r.path.length - 1]);
        for (const p of l.path.slice(1, -1)) expect(pointInPolygon(p.x, p.z, a.polygon), `${seed} ${l.id}`).toBe(true);
      }
      // Every alt line leaves the spine: some of it runs well off the haul road.
      for (const l of lines.slice(1)) expect(Math.max(...l.path.map((p) => distToPolyline(p.x, p.z, r.path)))).toBeGreaterThan(18);
    }
  });

  it('plans nothing on weekdays and on the other weekend specials', () => {
    const others = weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, 6).filter((s) => weekendOf(s)!.kind !== 'scrapyard');
    for (const seed of [20261026, 20261027, ...others.slice(0, 2)]) expect(planRoads(seed).districts.areas.some((a) => a.kind === 'scrapyard')).toBe(false);
  });
});

describe('the lines in a world', () => {
  it('keep every line clear of every wall at its level and every prop by half its width', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const w = worldOf(seed);
      const { area, L } = yardOf(w);
      const r = regionOf(area)!;
      const widths = spineWidths(r);
      const props = w.props.filter((p) => p.area === area.id);
      for (const l of districtModule('scrapyard').lines!(area)) {
        for (let i = 0; i + 1 < l.path.length; i++) {
          const p = l.path[i];
          const q = l.path[i + 1];
          const len = Math.hypot(q.x - p.x, q.z - p.z);
          // The spine's flares are the approach streets' width.
          const half = l.id === 'spine' ? widths[i] / 2 : l.width / 2;
          for (let s = 0; s < len; s += 1) {
            const x = p.x + ((q.x - p.x) * s) / len;
            const z = p.z + ((q.z - p.z) * s) / len;
            if (!pointInPolygon(x, z, area.polygon)) continue;
            const f = frameCoords(L.frame, x, z);
            const onDeck = l.level === 'deck' && f.u > L.deck.u0 && f.u < L.deck.u1 && f.d > L.deck.inner - 0.5 && f.d < L.deck.outer + 0.5;
            const ground = onDeck ? deckSurface(L, w.heightAt, x, z) : w.heightAt(x, z);
            expect(w.wallClearance(x, z, half + 1, ground + 0.3), `${seed} ${l.id} at ${x.toFixed(1)},${z.toFixed(1)}`).toBeGreaterThan(half - 0.05);
            for (const pr of props) {
              if (Math.abs(pr.y - ground) > 2) continue;
              expect(Math.hypot(pr.x - x, pr.z - z) - pr.radius, `${seed} ${l.id} prop ${pr.kind}`).toBeGreaterThan(half - 0.05);
            }
          }
        }
      }
    }
  });

  it('draws every wall look it uses, stands none on the haul road, and leaves the entry and the exit open', () => {
    const w = worldOf(MAIN);
    const { area } = yardOf(w);
    const own = w.walls.filter((x) => x.area === area.id);
    expect([...new Set(own.map((x) => x.look))].sort()).toEqual(['carStack', 'crusher', 'scrapFence']);
    const r = regionOf(area)!;
    for (const wall of own) {
      const mx = (wall.ax + wall.bx) / 2;
      const mz = (wall.az + wall.bz) / 2;
      expect(distToPolyline(mx, mz, r.path)).toBeGreaterThan(C.spineWidth / 2);
      // Every wall is a solid's face (both sides: nothing shoves a car through) and stands inside the region.
      expect(wall.solid).toBeDefined();
      expect(pointInPolygon(mx, mz, area.polygon) || distToPolygonEdge(mx, mz, area.polygon) < C.fence.thickness + 0.05).toBe(true);
    }
    for (const [a, b] of [
      [r.path[0], r.path[1]],
      [r.path[r.path.length - 1], r.path[r.path.length - 2]],
    ]) {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 4; d < len; d += 3) expect(w.wallClearance(a.x + ((b.x - a.x) * d) / len, a.z + ((b.z - a.z) * d) / len, 4)).toBeGreaterThan(3);
    }
  });
});

describe('the ground', () => {
  const w = worldOf(MAIN);
  const { area, L } = yardOf(w);

  it('shapes it with mods that fade to nothing at their boxes and slopes that match the heights', () => {
    const mods: HeightMod[] = [
      ...L.bowls.map(bankMod),
      ...L.dishes.map(bankedRingMod),
      tableMod(L.kicker.lip, L.kicker.dir, C.kicker),
      pitMod(L.pit.o, L.pit.dir, L.pit.s0, L.pit.s1, C.pit.halfWidth, C.pit.depth, C.pit.ease),
      tableMod(L.launch.lip, L.launch.dir, C.launch),
      humpMod(L.hump.o, L.hump.dir, C.hump, L.hump.half, 2),
    ];
    const rng = new Rng(77);
    const e = 1e-4;
    for (const m of mods) {
      for (const [x, z] of [
        [m.minX, m.minZ],
        [m.maxX, m.maxZ],
        [m.minX, m.maxZ],
        [m.maxX, m.minZ],
      ]) expect(Math.abs(sample(m, x, z).h)).toBeLessThan(1e-9);
      for (let i = 0; i < 300; i++) {
        const x = rng.range(m.minX, m.maxX);
        const z = rng.range(m.minZ, m.maxZ);
        const s = sample(m, x, z);
        expect(Math.abs(s.gx - (sample(m, x + e, z).h - sample(m, x - e, z).h) / (2 * e))).toBeLessThan(3e-3);
        expect(Math.abs(s.gz - (sample(m, x, z + e).h - sample(m, x, z - e).h) / (2 * e))).toBeLessThan(3e-3);
      }
    }
    // The world's answers agree with its heights all over the region, up on the deck too.
    const ws = 0.002;
    for (let i = 0; i < 600; i++) {
      const u = rng.range(0, L.frame.len);
      const d = rng.range(-120, 120);
      const p = framePoint(L.frame, u, d);
      if (!pointInPolygon(p.x, p.z, area.polygon)) continue;
      const y = pointInPolygon(p.x, p.z, L.deck.polygon) && rng.chance(0.5) ? deckSurface(L, w.heightAt, p.x, p.z) + 0.3 : undefined;
      const s = w.slopeAt(p.x, p.z, y);
      expect(Math.abs(s.gx - (w.heightAt(p.x + ws, p.z, y) - w.heightAt(p.x - ws, p.z, y)) / (2 * ws))).toBeLessThan(6e-3);
      expect(Math.abs(s.gz - (w.heightAt(p.x, p.z + ws, y) - w.heightAt(p.x, p.z - ws, y)) / (2 * ws))).toBeLessThan(6e-3);
    }
  });

  it('keeps the haul road and the lines at road grades but for the jumps, the banks and the ramps', () => {
    const base = createTerrain(MAIN);
    // The weighbridge is a 6% climb; the haul road elsewhere is the region's own ground.
    let steepest = 0;
    for (let s = 0; s <= C.hump.ramp * 2 + C.hump.top; s += 0.25) {
      const x = L.hump.o.x + L.hump.dir.x * s;
      const z = L.hump.o.z + L.hump.dir.z * s;
      const g = w.slopeAt(x, z);
      const b = base.slopeAt(x, z);
      steepest = Math.max(steepest, Math.abs((g.gx - b.gx) * L.hump.dir.x + (g.gz - b.gz) * L.hump.dir.z));
    }
    expect(steepest).toBeLessThan(0.08);
    expect(steepest).toBeGreaterThan(0.05);
    // The kicker's lip is 25 to 32 percent, its height the configured rise.
    const up = { x: L.kicker.lip.x - L.kicker.dir.x * 0.3, z: L.kicker.lip.z - L.kicker.dir.z * 0.3 };
    const g = w.slopeAt(up.x, up.z);
    const lipSlope = g.gx * L.kicker.dir.x + g.gz * L.kicker.dir.z;
    expect(lipSlope).toBeGreaterThan(0.25);
    expect(lipSlope).toBeLessThan(0.33);
    // The deck's ramps: about 10%, eased into and out of.
    let ramp = 0;
    for (let u = L.deck.u0; u < L.deck.u0 + C.deck.ramp; u += 0.5) {
      const a = framePoint(L.frame, u, L.deck.dC);
      const b = framePoint(L.frame, u + 0.5, L.deck.dC);
      ramp = Math.max(ramp, (deckSurface(L, w.heightAt, b.x, b.z) - w.heightAt(b.x, b.z) - (deckSurface(L, w.heightAt, a.x, a.z) - w.heightAt(a.x, a.z))) / 0.5);
    }
    expect(ramp).toBeGreaterThan(0.09);
    expect(ramp).toBeLessThan(0.11);
  });

  it('paints firm gravel with slick patches: oil on the haul road, mud in the Eight, the canyon and the wash', () => {
    expect(w.surfaceAt(L.centers[0].x, L.centers[0].z + 15)).toBe('quay');
    expect(L.slicks.length).toBe(C.haulSlick.count + 4);
    for (const p of L.slicks) {
      const c = { x: p.reduce((s, q) => s + q.x, 0) / p.length, z: p.reduce((s, q) => s + q.z, 0) / p.length };
      expect(w.surfaceAt(c.x, c.z)).toBe('slick');
    }
    // Dirt only on the bowls' outsides: under a fifth of the region.
    expect(L.dirt.reduce((s, q) => s + Math.abs((q[1].x - q[0].x) * (q[3].z - q[0].z) - (q[1].z - q[0].z) * (q[3].x - q[0].x)), 0)).toBeLessThan(0.05 * Math.abs(area.polygon.reduce((s, p, i) => s + p.x * area.polygon[(i + 1) % area.polygon.length].z - area.polygon[(i + 1) % area.polygon.length].x * p.z, 0) / 2));
  });

  it('is a drift zone over the Eight', () => {
    const zones = driftZones(w).filter((z) => z.area === area.id);
    expect(zones).toHaveLength(1);
    expect(zones[0].kind).toBe('scrap');
    for (const c of L.centers) expect(pointInPolygon(c.x + 5, c.z + 5, zones[0].polygon)).toBe(true);
    expect(pointInPolygon(L.neck.x, L.neck.z, zones[0].polygon)).toBe(true);
  });

  it('stacks the deck over the canyon: the passage floor and the deck at one point, four metres apart', () => {
    const r = regionOf(area)!;
    void r;
    // The canyon's leg passes under the deck: its middle under the deck's centre line.
    const q = framePoint(L.frame, L.deck.passage, L.deck.dC);
    expect(pointInPolygon(q.x, q.z, L.deck.polygon)).toBe(true);
    const ground = w.heightAt(q.x, q.z);
    expect(w.heightAt(q.x, q.z, ground + 0.4)).toBeCloseTo(ground, 6);
    expect(w.heightAt(q.x, q.z, ground + C.deck.height + 0.4)).toBeCloseTo(ground + C.deck.height, 3);
    // The parapets let a car beneath pass and stop one on the deck; the stacks under it stop only the car below.
    const own = w.walls.filter((x) => x.area === area.id);
    const parapets = own.filter((x) => x.bottom !== undefined);
    expect(parapets.length).toBeGreaterThan(40);
    for (const p of parapets) expect(p.top! - p.bottom!).toBeCloseTo(C.deck.parapetTop + C.deck.under, 1);
    expect(own.filter((x) => x.under !== undefined).length).toBeGreaterThan(40);
    // A car in the passage is clear of the deck's walls; one on the deck above it is clear of the canyon's.
    expect(w.wallClearance(q.x, q.z, 6, ground + 0.3)).toBeGreaterThan(C.canyon.lineWidth / 2);
    expect(w.wallClearance(q.x, q.z, 6, ground + C.deck.height + 0.3)).toBeGreaterThan(C.deck.lineWidth / 2);
  });
});

describe('the jumps and the drop', () => {
  const { L } = yardOf(worldOf(MAIN));

  it('throws the canyon\'s car over the crusher\'s pit at 12 m/s and onto the second bowl\'s bank at 18', () => {
    const B = L.centers[1];
    const slow = fly(L.kicker, 9, 30);
    const clear = fly(L.kicker, 12, 30);
    const bank = fly(L.kicker, 18.8, 30);
    const s = (p: { x: number; z: number } | null) => (p ? (p.x - L.kicker.lip.x) * L.kicker.dir.x + (p.z - L.kicker.lip.z) * L.kicker.dir.z : NaN);
    expect(s(slow.landed)).toBeLessThan(L.pit.s1);
    expect(s(clear.landed)).toBeGreaterThan(L.pit.s1);
    const rad = Math.hypot(bank.landed!.x - B.x, bank.landed!.z - B.z);
    expect(bank.lip).toBeGreaterThan(17);
    expect(rad).toBeLessThan(L.R);
    expect(rad).toBeGreaterThan(L.R - C.bank.rise);
    for (const f of [slow, clear, bank]) expect(f.resets).toBe(0);
  });

  it('launches a car off the haul road onto the deck at 40 m/s, about 7 m up, and turns back one that is too slow', () => {
    const onDeck = (f: ReturnType<typeof fly>) => !!f.landed && pointInPolygon(f.landed.x, f.landed.z, L.deck.polygon) && Math.abs(f.landed.y - deckSurface(L, f.world.heightAt, f.landed.x, f.landed.z)) < 0.6;
    const fast = fly(L.launch, 40, 36);
    expect(onDeck(fast)).toBe(true);
    expect(fast.apex).toBeGreaterThan(6);
    expect(fast.apex).toBeLessThan(8.5);
    expect(fast.resets).toBe(0);
    const slow = fly(L.launch, 30, 36);
    expect(onDeck(slow)).toBe(false);
    expect(slow.resets).toBe(0);
  });

  it('drops a car off the deck at its open edge onto clear ground', () => {
    expect(L.deck.gaps.length).toBe(1);
    const [g0, g1] = L.deck.gaps[0];
    const r = race();
    const w = r.world;
    const rc = r.cars[0];
    const c = rc.state;
    // On the deck, heading for the open spine side at a slant.
    const from = framePoint(L.frame, g0 + 4, L.deck.dC);
    const to = framePoint(L.frame, (g0 + g1) / 2, L.deck.inner - 4);
    const dir = { x: (to.x - from.x) / Math.hypot(to.x - from.x, to.z - from.z), z: (to.z - from.z) / Math.hypot(to.x - from.x, to.z - from.z) };
    placeCar(c, from.x, from.z, yawOf(dir.x, dir.z), w, deckSurface(L, w.heightAt, from.x, from.z) + 0.3);
    expect(c.y).toBeGreaterThan(w.heightAt(from.x, from.z) + C.deck.height - 0.5);
    rc.seg = -1;
    c.vx = dir.x * 9;
    c.vz = dir.z * 9;
    for (const wh of c.wheels) wh.spinRate = 9 / rc.tuning.geometry.wheelRadius;
    let fell = false;
    for (let i = 0; i < 240; i++) {
      stepRace(r, input({ throttle: 0.2 }));
      if (c.airTime > 0.3) fell = true;
    }
    expect(fell).toBe(true);
    expect(c.y - w.heightAt(c.x, c.z)).toBeLessThan(0.6);
    expect(frameCoords(L.frame, c.x, c.z).d).toBeLessThan(L.deck.inner);
    expect(r.events.filter((e) => e.type === 'reset')).toHaveLength(0);
    expect(r.events.filter((e) => e.type === 'wall' || e.type === 'crash')).toHaveLength(0);
  });
});

describe('the press and the clutter', () => {
  const w = worldOf(MAIN);
  const { area, L } = yardOf(w);

  it('puts the press across the canyon as a timed gate closed about a third of the time, holding a car while down', () => {
    const gates = w.timedGates!;
    const gi = gates.gates.findIndex((g) => g.look === 'crusher');
    expect(gi).toBeGreaterThanOrEqual(0);
    const g = gates.gates[gi];
    const cycle = gates.cycles[g.cycle];
    let blocked = 0;
    for (let t = 0; t < cycle.period; t++) if (gateBlocking(cycle, cycle.start + t)) blocked++;
    expect(blocked / cycle.period).toBeGreaterThan(0.3);
    expect(blocked / cycle.period).toBeLessThan(0.37);
    expect(Math.hypot(g.bx - g.ax, g.bz - g.az)).toBeCloseTo(C.canyon.aisle, 6);
    // Down the canyon toward it: held while it is down, through while it is up.
    const c0 = { x: (g.ax + g.bx) / 2, z: (g.az + g.bz) / 2 };
    const run = (closed: boolean): number => {
      const r = race();
      const c = r.cars[0].state;
      const from = { x: c0.x + g.nx * 12, z: c0.z + g.nz * 12 };
      r.tick = closed ? cycle.start + Math.round(cycle.warn + cycle.lower + cycle.closed / 2) : openTick(cycle, r.tick);
      placeCar(c, from.x, from.z, yawOf(-g.nx, -g.nz), r.world);
      r.cars[0].seg = -1;
      c.vx = -g.nx * 8;
      c.vz = -g.nz * 8;
      for (const wh of c.wheels) wh.spinRate = 8 / r.cars[0].tuning.geometry.wheelRadius;
      let past = -Infinity;
      for (let i = 0; i < 160; i++) {
        stepRace(r, input({ throttle: 0.5 }));
        past = Math.max(past, -((c.x - c0.x) * g.nx + (c.z - c0.z) * g.nz));
      }
      return past;
    };
    expect(run(true)).toBeLessThan(0.2);
    expect(run(false)).toBeGreaterThan(3);
  });

  it('dresses every alt line with destructibles, tyre stacks among them', () => {
    expect(PROP_DEFS.tyreStack.radius).toBeCloseTo(0.5, 1);
    const props = w.props.filter((p) => p.area === area.id);
    expect(props.filter((p) => p.kind === 'tyreStack').length).toBeGreaterThan(12);
    for (const l of districtModule('scrapyard').lines!(area).slice(1)) {
      const near = props.filter((p) => distToPolyline(p.x, p.z, l.path) < l.width / 2 + 4);
      expect(near.length, l.id).toBeGreaterThan(3);
    }
    // Scrap mountains fill what the lines leave: most of the region is heaps.
    expect(L.heaps.length).toBeGreaterThan(100);
  });
});

describe('a race through it', () => {
  it('the autopilot and three rivals drive a circuit through it on three Scrapyard days with no reset, all finishing', () => {
    for (const seed of [20261031, 20261108, 20261129]) {
      const r = runAutopilot(raceConfig(seed, 'circuit', 3), 300, true);
      expect(r.cars.every((c) => c.finished), `seed ${seed}`).toBe(true);
      expect(r.events.filter((e) => e.type === 'reset'), `seed ${seed}`).toHaveLength(0);
    }
  });

  it('is deterministic: the same race twice is the same race', () => {
    const cfg = raceConfig(20261129, 'circuit', 1);
    const a = runAutopilot(cfg, 40);
    const b = runAutopilot(cfg, 40);
    expect(carSnapshot(a)).toBe(carSnapshot(b));
  });
});
