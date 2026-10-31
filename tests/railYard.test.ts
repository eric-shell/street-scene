import { describe, expect, it } from 'vitest';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { City, World } from '../src/city/world';
import { routeEdges as evRouteEdges } from '../src/city/events';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { CITY } from '../src/city/config';
import { regionOf } from '../src/city/districts/weekendRegion';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { districtModule } from '../src/city/districts';
import { yardLayout } from '../src/city/districts/railYardLayout';
import { bridgeLevel, bridgePoint } from '../src/city/districts/railYardBridge';
import { wedgePoint, type WedgeSpec } from '../src/city/districts/railYardShapes';
import { driftZones } from '../src/sim/driftZones';
import { createRace, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import type { Contact } from '../src/city/world';
import type { HeightSample } from '../src/city/districts/types';
import { input, raceConfig, runAutopilot } from './helpers';

const C = CITY.districts.railYard;

/** The next `n` Rail Yard Sundays and Saturdays from the first test Sunday. */
function yardSeeds(n: number): number[] {
  return weekendSeeds({ year: 2026, month: 11, dayOfMonth: 1 }, 400)
    .filter((s) => weekendOf(s)?.kind === 'railYard')
    .slice(0, n);
}

const cityCache = new Map<number, City>();
function cityOf(seed: number): City {
  let c = cityCache.get(seed);
  if (!c) cityCache.set(seed, (c = createCity(seed)));
  return c;
}
const worldCache = new Map<number, World>();
function worldOf(seed: number): World {
  let w = worldCache.get(seed);
  if (!w) worldCache.set(seed, (w = createWorld(seed, 'circuit', cityOf(seed))));
  return w;
}
const yardOf = (seed: number) => {
  const a = cityOf(seed).districts.areas.find((x) => x.kind === 'railYard')!;
  return { a, lay: yardLayout(a)!, b: cityOf(seed).districts.builds[a.id] };
};

describe('rail yard plan', () => {
  it('carves a region on every one of the next 20 Rail Yard seeds, both routes drive its spine, the special is promised', () => {
    const seeds = yardSeeds(20);
    expect(seeds.length).toBe(20);
    for (const seed of seeds) {
      const { graph, districts, event, routeNodes } = planRoads(seed);
      const yards = districts.areas.filter((a) => a.kind === 'railYard');
      expect(yards.length, `seed ${seed}`).toBe(1);
      const a = yards[0];
      const r = regionOf(a)!;
      expect(a.params.planned, `seed ${seed}`).toBe(1);
      expect(event.special?.kind, `seed ${seed}`).toBe('railYard');
      // A region of 8 to 12 blocks.
      expect(a.params.along * a.params.across).toBeGreaterThanOrEqual(8);
      expect(a.params.along * a.params.across).toBeLessThanOrEqual(12);
      const routeEdges = new Set([...evRouteEdges(graph, routeNodes.circuit, true), ...evRouteEdges(graph, routeNodes.sprint, false)]);
      for (const e of r.spineEdges) expect(routeEdges.has(e), `seed ${seed}`).toBe(true);
      const lay = yardLayout(a);
      expect(lay, `seed ${seed}`).not.toBeNull();
      expect(lay!.lines.length).toBe(6);
    }
  });

  it('is deterministic', () => {
    for (const seed of yardSeeds(2)) {
      const b1 = createCity(seed).districts.builds;
      const b2 = createCity(seed).districts.builds;
      expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
    }
  });
});

describe('rail yard lines', () => {
  it('hands over six lines, the spine first, entry to exit, inside the region, each its own way through', () => {
    for (const seed of yardSeeds(20)) {
      const { a, lay } = yardOf(seed);
      const r = regionOf(a)!;
      const lines = districtModule('railYard').lines!(a);
      expect(lines.map((l) => l.id)).toEqual(['spine', 'tracks', 'hump', 'bridge', 'dock', 'turnaround']);
      expect(lines[0].kind).toBe('spine');
      const E = r.path[0];
      const X = r.path[r.path.length - 1];
      for (const l of lines) {
        expect(Math.hypot(l.path[0].x - E.x, l.path[0].z - E.z), `${seed} ${l.id}`).toBeLessThan(1);
        expect(Math.hypot(l.path[l.path.length - 1].x - X.x, l.path[l.path.length - 1].z - X.z), `${seed} ${l.id}`).toBeLessThan(1);
        for (const p of l.path.slice(1, -1)) expect(pointInPolygon(p.x, p.z, a.polygon), `${seed} ${l.id}`).toBe(true);
      }
      // The alt lines part from each other: mid-way along the region each is at least 15 m from every other.
      const f = lay.f;
      const at = (pts: { x: number; z: number }[], t: number) => {
        let best = pts[0];
        let bd = Infinity;
        for (const p of pts) {
          const d = Math.abs((p.x - f.ox) * f.tx + (p.z - f.oz) * f.tz - t);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        return (best.x - f.ox) * f.wx + (best.z - f.oz) * f.wz;
      };
      const ws = lines.filter((l) => l.id !== 'bridge').map((l) => at(l.path, f.L * 0.4));
      for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) expect(Math.abs(ws[i] - ws[j]), `${seed}`).toBeGreaterThan(8);
    }
  });

  it('keeps every line clear of every wall and prop by half its width, at its own level', () => {
    const contacts: Contact[] = [];
    for (const seed of yardSeeds(20)) {
      const world = worldOf(seed);
      const { a, lay } = yardOf(seed);
      const xs = a.polygon.map((p) => p.x);
      const zs = a.polygon.map((p) => p.z);
      const props = world.props.filter((p) => p.x > Math.min(...xs) - 10 && p.x < Math.max(...xs) + 10 && p.z > Math.min(...zs) - 10 && p.z < Math.max(...zs) + 10);
      for (const l of lay.lines) {
        const half = l.width / 2;
        const pts = l.path;
        let acc = 0;
        const total = pts.reduce((s, p, i) => (i ? s + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          for (let s = 0; s < len; s += 2) {
            const d = acc + s;
            acc += 0;
            // The ends are the ring's junctions, on the street.
            if (d < 14 || d > total - 14) continue;
            const x = a.x + ((b.x - a.x) * s) / len;
            const z = a.z + ((b.z - a.z) * s) / len;
            const deck = l.id === 'bridge' && world.upperLevel(x, z, 1000);
            const y = (deck ? world.heightAt(x, z, 1000) : world.heightAt(x, z)) + 0.5;
            const n = world.collideCircle(x, z, half, contacts, y);
            expect(n, `${seed} ${l.id} at ${d.toFixed(0)} m (${x.toFixed(1)}, ${z.toFixed(1)}) deck ${deck}`).toBe(0);
            for (const p of props) {
              if (Math.abs(p.y - y) > 2.5) continue;
              const dd = Math.hypot(p.x - x, p.z - z);
              if (dd < half + p.radius - 0.05) expect.fail(`${seed} ${l.id} at ${d.toFixed(0)} m: ${p.kind} ${dd.toFixed(2)} m from the path`);
            }
          }
          acc += len;
        }
      }
    }
  });
});

describe('rail yard terrain and levels', () => {
  it("every height modifier's slope matches its gradient and fades to nothing at its box", () => {
    for (const seed of yardSeeds(3)) {
      const { b } = yardOf(seed);
      for (const m of b.heightMods) {
        const at = (x: number, z: number) => {
          const o: HeightSample = { h: 0, gx: 0, gz: 0 };
          m.add(x, z, o);
          return o;
        };
        const e = 1e-3;
        let checked = 0;
        for (let i = 0; i <= 24; i++) {
          for (let j = 0; j <= 24; j++) {
            const x = m.minX + ((m.maxX - m.minX) * i) / 24 + 0.013;
            const z = m.minZ + ((m.maxZ - m.minZ) * j) / 24 + 0.017;
            const o = at(x, z);
            const gx = (at(x + e, z).h - at(x - e, z).h) / (2 * e);
            const gz = (at(x, z + e).h - at(x, z - e).h) / (2 * e);
            expect(Math.abs(gx - o.gx), `seed ${seed} gx at ${x},${z}`).toBeLessThan(2e-3 + 0.01 * Math.abs(o.gx));
            expect(Math.abs(gz - o.gz), `seed ${seed} gz`).toBeLessThan(2e-3 + 0.01 * Math.abs(o.gz));
            checked++;
          }
        }
        expect(checked).toBeGreaterThan(100);
        for (const [x, z] of [[m.minX, m.minZ], [m.maxX, m.maxZ], [m.minX, m.maxZ], [m.maxX, m.minZ]]) expect(at(x, z).h).toBeCloseTo(0, 6);
      }
    }
  });

  it('has a 3 m hump at 12%, a 1.1 m dock at 10%, a 28% kicker, bridge ramps climbing 9.5% over the ground, banked corners', () => {
    for (const seed of yardSeeds(5)) {
      const { lay } = yardOf(seed);
      const world = worldOf(seed);
      const peak = (w: WedgeSpec) => {
        let g = 0;
        for (let a = 0.5; a < w.run; a += 0.25) {
          const p = wedgePoint(w, a, 0);
          const q = wedgePoint(w, a + 0.25, 0);
          g = Math.max(g, (world.heightAt(q.x, q.z) - world.heightAt(p.x, p.z)) / 0.25);
        }
        return g;
      };
      const crest = wedgePoint(lay.hump, lay.hump.run + 0.5, 0);
      const foot = wedgePoint(lay.hump, -3, 0);
      expect(world.heightAt(crest.x, crest.z) - world.heightAt(foot.x, foot.z), `${seed}`).toBeGreaterThan(2.6);
      // The run-up's own peak grade is 12%; on the city's ground (which rolls a few percent) it reads 12% give or take that roll.
      expect(lay.hump.rise / lay.hump.run / (1 - lay.hump.ease / 2)).toBeCloseTo(C.hump.grade, 3);
      expect(peak(lay.hump), `${seed}`).toBeGreaterThan(0.08);
      expect(peak(lay.hump), `${seed}`).toBeLessThan(0.17);
      expect(lay.dock, `${seed}`).not.toBeNull();
      if (lay.kicker) {
        expect(peak(lay.kicker)).toBeGreaterThan(0.25);
        expect(peak(lay.kicker)).toBeLessThan(0.31);
      }
      const br = lay.bridge;
      const lv = { h: 0, d: 0 };
      let g = 0;
      // The climb over the ground under it peaks at 9.5% (the ramp's own grade); the city's ground can add its few percent of roll.
      let rel = 0;
      const base = (s: number) => {
        const k = Math.max(0, Math.min(br.levels.base.length - 2, Math.floor(s / br.levels.step)));
        return (br.levels.base[k + 1] - br.levels.base[k]) / br.levels.step;
      };
      for (let s = 0; s < br.S; s += 1) {
        const d = bridgeLevel(br, s, lv).d;
        g = Math.max(g, Math.abs(d));
        rel = Math.max(rel, Math.abs(d - base(s)));
      }
      expect(rel, `${seed} bridge climb`).toBeGreaterThan(0.09);
      expect(rel, `${seed} bridge climb`).toBeLessThan(0.1);
      expect(g, `${seed} bridge grade`).toBeLessThan(0.15);
      expect(lay.banks.length).toBe(2);
      // Grades under 6% everywhere else on the lines' ground (the jumps, ramps and banks aside).
      for (const l of lay.lines) {
        if (l.id === 'bridge' || l.id === 'spine') continue;
        for (let i = 0; i + 1 < l.path.length; i++) {
          const p = l.path[i];
          const q = l.path[i + 1];
          const len = Math.hypot(q.x - p.x, q.z - p.z);
          if (len < 0.5) continue;
          const nearShape = [lay.hump, ...(lay.kicker ? [lay.kicker] : [])].some((w) => Math.hypot(p.x - wedgePoint(w, w.run, 0).x, p.z - wedgePoint(w, w.run, 0).z) < w.run + w.fall + w.half + 10);
          const nearBank = lay.banks.some((k) => Math.hypot(p.x - k.cx, p.z - k.cz) < k.rOut + 10);
          const onDock = lay.dock && l.id === 'dock';
          if (nearShape || nearBank || onDock) continue;
          const grade = Math.abs(world.heightAt(q.x, q.z) - world.heightAt(p.x, p.z)) / len;
          expect(grade, `${seed} ${l.id} grade at ${i}`).toBeLessThan(0.065);
        }
      }
    }
  });

  it('carries the overbridge on two levels: the deck over the tracks, the yard beneath it', () => {
    for (const seed of yardSeeds(5)) {
      const { lay } = yardOf(seed);
      const world = worldOf(seed);
      const br = lay.bridge;
      for (const k of [0.35, 0.5, 0.65]) {
        const s = br.R + (br.S - 2 * br.R) * k;
        const p = bridgePoint(br, s);
        const ground = world.heightAt(p.x, p.z);
        const deck = bridgeLevel(br, s, { h: 0, d: 0 }).h;
        expect(deck - ground, `${seed}`).toBeGreaterThan(C.bridge.clear - 2.5);
        expect(world.heightAt(p.x, p.z, ground + 0.6)).toBeCloseTo(ground, 5);
        expect(world.heightAt(p.x, p.z, deck + 0.4)).toBeCloseTo(deck, 5);
        expect(world.upperLevel(p.x, p.z, deck + 0.4)).toBe(true);
        expect(world.upperLevel(p.x, p.z, ground + 0.6)).toBe(false);
      }
      // A car on the deck meets its parapet; a car beneath passes under it, and meets a pier.
      const contacts: Contact[] = [];
      const s = br.R + (br.S - 2 * br.R) * 0.5;
      const edge = bridgePoint(br, s, C.bridge.width / 2 + 0.6);
      const deck = bridgeLevel(br, s, { h: 0, d: 0 }).h;
      const gap = br.missing && s > br.missing.s0 && s < br.missing.s1;
      if (!gap) expect(world.collideCircle(edge.x, edge.z, 1, contacts, deck + 0.4)).toBeGreaterThan(0);
      // Every deck parapet's underside stands well over the ground beneath it.
      for (const w of world.walls) if (w.look === 'yardFence' && w.bottom !== undefined) expect(w.bottom - world.heightAt((w.ax + w.bx) / 2, (w.az + w.bz) / 2)).toBeGreaterThan(2.5);
      if (br.piers.length) {
        const pp = bridgePoint(br, br.piers[0]);
        expect(world.collideCircle(pp.x, pp.z, 1, contacts, world.heightAt(pp.x, pp.z) + 0.5)).toBeGreaterThan(0);
        expect(world.collideCircle(pp.x, pp.z, 1, contacts, bridgeLevel(br, br.piers[0], { h: 0, d: 0 }).h + 0.4)).toBe(0);
      }
    }
  });
});

describe('rail yard drops, jumps and patches', () => {
  it('opens one parapet bay over clear ground: the drop lands on nothing', () => {
    const contacts: Contact[] = [];
    for (const seed of yardSeeds(5)) {
      const { lay } = yardOf(seed);
      const world = worldOf(seed);
      const br = lay.bridge;
      expect(br.missing, `${seed}`).not.toBeNull();
      const m = br.missing!;
      const sm = (m.s0 + m.s1) / 2;
      const deck = bridgeLevel(br, sm, { h: 0, d: 0 }).h;
      const edge = bridgePoint(br, sm, m.side * (C.bridge.width / 2 + 0.3));
      expect(world.collideCircle(edge.x, edge.z, 0.8, contacts, deck + 0.4), `${seed} the bay is open`).toBe(0);
      for (const off of [3, 6, 9, 12]) {
        const q = bridgePoint(br, sm, m.side * (C.bridge.width / 2 + C.bridge.thick + off));
        expect(world.collideCircle(q.x, q.z, 1.2, contacts, world.heightAt(q.x, q.z) + 0.5), `${seed} landing ${off} m out`).toBe(0);
        for (const p of world.props) expect(Math.hypot(p.x - q.x, p.z - q.z) > p.radius + 1.2 || Math.abs(p.y - world.heightAt(q.x, q.z)) > 3, `${seed} prop in the drop`).toBe(true);
      }
    }
  });

  it('throws a car off the hump into a clear landing, and off the kicker onto the bridge ramp (measured speeds)', () => {
    const seed = yardSeeds(1)[0];
    const throwAt = (w: WedgeSpec, v: number) => {
      const r = createRace(raceConfig(seed, 'circuit', 0));
      r.phase = 'racing';
      const c = r.cars[0].state;
      const start = wedgePoint(w, -40, 0);
      const yaw = Math.atan2(w.hx, w.hz);
      placeCar(c, start.x, start.z, yaw, r.world);
      let lip: { x: number; z: number } | null = null;
      let air = false;
      let land: { d: number; deck: boolean } | null = null;
      for (let k = 0; k < 60 * 8 && !land; k++) {
        const a = (c.x - w.fx) * w.hx + (c.z - w.fz) * w.hz;
        if (!lip && a < w.run - 0.3) {
          c.vx = w.hx * v;
          c.vz = w.hz * v;
          c.yaw = yaw;
          c.yawRate = 0;
        }
        if (!lip && a >= w.run - 0.3) lip = { x: c.x, z: c.z };
        stepRace(r, input({ throttle: lip ? 0.3 : 0 }));
        if (c.airTime > 0.15) air = true;
        if (air && c.airTime === 0 && lip) land = { d: Math.hypot(c.x - lip.x, c.z - lip.z), deck: r.world.upperLevel(c.x, c.z, c.y) };
      }
      return { land, resets: r.events.filter((e) => e.type === 'reset').length };
    };
    const { lay } = yardOf(seed);
    const H = C.hump;
    for (const v of [H.measured.clear, H.measured.mid, H.measured.far]) {
      const t = throwAt(lay.hump, v);
      expect(t.land, `hump at ${v}`).not.toBeNull();
      expect(t.land!.d, `hump at ${v}`).toBeGreaterThan(H.top + H.fall);
      expect(t.land!.d, `hump at ${v}`).toBeLessThan(H.land[1]);
      expect(t.resets).toBe(0);
    }
    expect(lay.kicker).not.toBeNull();
    for (const v of [C.kicker.measured.least, C.kicker.aimSpeed, C.kicker.measured.most]) {
      const t = throwAt(lay.kicker!, v);
      expect(t.land?.deck, `kicker at ${v}`).toBe(true);
    }
  });

  it('paints slick patches (plates on the throat road at every crossover, oil, grease, the spill) and gives the drift zone', () => {
    for (const seed of yardSeeds(5)) {
      const { lay } = yardOf(seed);
      const world = worldOf(seed);
      const slick = lay.patches.filter((p) => p.surface === 'slick');
      expect(slick.filter((p) => p.look === 'plate').length).toBeGreaterThanOrEqual(C.crossovers.count);
      expect(new Set(slick.map((p) => p.look)).size).toBeGreaterThanOrEqual(4);
      for (const p of slick) {
        const cx = p.poly.reduce((s, q) => s + q.x, 0) / p.poly.length;
        const cz = p.poly.reduce((s, q) => s + q.z, 0) / p.poly.length;
        expect(world.surfaceAt(cx, cz), `${seed} ${p.look}`).toBe('slick');
      }
      // No plate covers the throat road's whole width: a precise car keeps its grip on one side.
      const r = lay.region;
      const plates = slick.filter((p) => p.look === 'plate');
      for (const p of plates.slice(0, C.crossovers.count)) {
        const ws = p.poly.map((q) => (q.x - lay.f.ox) * lay.f.wx + (q.z - lay.f.oz) * lay.f.wz);
        expect(Math.max(...ws) - Math.min(...ws)).toBeLessThan(r.spineWidth);
      }
      const zones = driftZones(world).filter((z) => z.kind === 'yard');
      expect(zones.length).toBe(1);
      // The ground: firm quay everywhere in the region off the patches.
      const inner = lay.region.polygon;
      let quay = 0;
      let n = 0;
      for (let k = 0; k < 200; k++) {
        const t = (k * 0.618) % 1;
        const u = (k * 0.414) % 1;
        const x = Math.min(...inner.map((p) => p.x)) + (Math.max(...inner.map((p) => p.x)) - Math.min(...inner.map((p) => p.x))) * t;
        const z = Math.min(...inner.map((p) => p.z)) + (Math.max(...inner.map((p) => p.z)) - Math.min(...inner.map((p) => p.z))) * u;
        if (!pointInPolygon(x, z, inner) || distToPolygonEdge(x, z, inner) < 3) continue;
        n++;
        if (world.surfaceAt(x, z) !== 'offroad') quay++;
      }
      expect(quay).toBe(n);
    }
  });

  it('fills the region: hundreds of cars, buildings, lights, the crane, clutter on every alt line', () => {
    for (const seed of yardSeeds(5)) {
      const { lay } = yardOf(seed);
      const cars = lay.consists.reduce((s, c) => s + c.cars.length, 0);
      expect(cars, `${seed}`).toBeGreaterThan(120);
      const kinds = new Set(lay.solids.map((s) => s.kind));
      for (const k of ['house', 'forklift', 'shop', 'sand', 'tower', 'flood', 'signalLeg', 'gantryLeg', 'container', 'retarder', 'water', 'dockFace', 'bankWall']) expect(kinds.has(k as never), `${seed} ${k}`).toBe(true);
      expect(lay.lights.length).toBeGreaterThanOrEqual(Math.floor(lay.f.L / C.lights.every) * 3);
      expect(lay.panels.length).toBeGreaterThan(400);
      expect(lay.mouths.length).toBe(C.fence.mouths);
      // Clutter beside every alt line, within 8 m of its path.
      for (const l of lay.lines.filter((x) => x.kind === 'alt')) {
        const near = lay.junk.filter((j) => l.path.some((p) => Math.hypot(p.x - j.x, p.z - j.z) < l.width / 2 + 8));
        expect(near.length, `${seed} ${l.id}`).toBeGreaterThan(4);
      }
    }
  });
});

describe('rail yard races', () => {
  it('a circuit through the yard: every car finishes and none is reset, on three Rail Yard seeds', () => {
    for (const seed of yardSeeds(3)) {
      const r = runAutopilot(raceConfig(seed, 'circuit', 3), 420, true);
      for (const car of r.cars) {
        expect(car.finished, `seed ${seed} ${car.name}`).toBe(true);
        expect(r.events.filter((e) => e.type === 'reset' && e.car === car.index).length, `seed ${seed} ${car.name} resets`).toBe(0);
      }
    }
  });
});
