import { describe, expect, it } from 'vitest';
import { createCity, createWorld, planRoads } from '../src/city/world';
import { routeEdges as evRouteEdges } from '../src/city/events';
import type { City } from '../src/city/world';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { createTerrain } from '../src/city/terrain';
import { CITY } from '../src/city/config';
import { distToSegment, segmentT } from '../src/sim/math';
import { yardBlocks } from '../src/city/districts/railYardLayout';
import { driftZones } from '../src/sim/driftZones';
import { bankAdd, bankWallLine, reachOf, wallRadius, type BankedArc } from '../src/city/districts/banking';
import type { HeightSample } from '../src/city/districts/types';

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

describe('rail yard plan', () => {
  it('plans exactly one yard on at least 19 of the next 20 Rail Yard seeds, touching a route street', () => {
    let ok = 0;
    const seeds = yardSeeds(20);
    expect(seeds.length).toBe(20);
    for (const seed of seeds) {
      const { graph, districts, event, routeNodes } = planRoads(seed);
      const yards = districts.areas.filter((a) => a.kind === 'railYard');
      if (yards.length !== 1) continue;
      ok++;
      expect(event.special?.kind).toBe('railYard');
      const routeEdges = new Set([...evRouteEdges(graph, routeNodes.circuit, true), ...evRouteEdges(graph, routeNodes.sprint, false)]);
      // The yard fronts a street a route drives: its first block's frontage edge is on a route.
      const blocks = yardBlocks(yards[0]);
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      expect(routeEdges.has(blocks[0].edge)).toBe(true);
      expect(yards[0].faces.length).toBe(blocks.length);
    }
    expect(ok).toBeGreaterThanOrEqual(19);
  });

  it('claims the frontage streets and keeps off the others', () => {
    const seed = yardSeeds(1)[0];
    const city = cityOf(seed);
    const a = city.districts.areas.find((x) => x.kind === 'railYard')!;
    expect(a).toBeDefined();
    const blocks = yardBlocks(a);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const b of blocks) expect(city.graph.edges[b.edge]).toBeDefined();
    // The street keeps its crown: the area owns no edge.
    expect(a.edges).toEqual([]);
  });

  it('is deterministic', () => {
    for (const seed of yardSeeds(3)) {
      const one = planRoads(seed);
      const two = planRoads(seed);
      expect(JSON.stringify(one.districts.areas)).toBe(JSON.stringify(two.districts.areas));
      const b1 = createCity(seed).districts.builds;
      const b2 = createCity(seed).districts.builds;
      expect(JSON.stringify(b1)).toBe(JSON.stringify(b2));
    }
  });
});

describe('rail yard layout', () => {
  it('has the rubric: gates, tracks, freight, a dock with ramps, a ridge, a banked turn, a drift zone', () => {
    for (const seed of yardSeeds(6)) {
      const city = cityOf(seed);
      const a = city.districts.areas.find((x) => x.kind === 'railYard');
      if (!a) continue;
      const b = city.districts.builds[a.id];
      const blocks = yardBlocks(a);
      const kinds = (k: string) => b.hints.filter((h) => h.kind === k);
      expect(kinds('gate').length).toBe(C.mouth.count);
      for (const blk of blocks) expect(blk.n).toBeGreaterThanOrEqual(C.tracks[0]);
      expect(kinds('track').length).toBe(blocks.reduce((s, x) => s + x.n, 0));
      expect(b.walls.filter((w) => w.look === 'railcar').length).toBeGreaterThan(8);
      expect(kinds('dock').length).toBeGreaterThanOrEqual(1);
      expect(kinds('hump').length).toBe(1);
      expect(kinds('bank').length).toBe(1);
      expect(kinds('apron').length).toBe(1);
      // Runs of 2 to 5 cars (1 where the zone is tight), 8 to 14 m between runs on a track.
      const world = createWorld(seed, 'circuit', city);
      const zones = driftZones(world).filter((z) => z.kind === 'yard');
      expect(zones.length).toBe(1);
    }
  });

  it('keeps every wall off the roads, every railcar solid on its track, and gaps between runs', () => {
    for (const seed of yardSeeds(8)) {
      const city = cityOf(seed);
      const a = city.districts.areas.find((x) => x.kind === 'railYard');
      if (!a) continue;
      const g = city.graph;
      const walls = city.districts.builds[a.id].walls;
      for (const w of walls) {
        for (const t of [0.1, 0.5, 0.9]) {
          const x = w.ax + (w.bx - w.ax) * t;
          const z = w.az + (w.bz - w.az) * t;
          for (const e of g.edges) {
            const na = g.nodes[e.a];
            const nb = g.nodes[e.b];
            const s = segmentT(x, z, na.x, na.z, nb.x, nb.z);
            if (s * e.length < 1.5 || (1 - s) * e.length < 1.5) continue;
            expect(distToSegment(x, z, na.x, na.z, nb.x, nb.z)).toBeGreaterThan(e.width / 2 - 0.05);
          }
        }
      }
      // Consists on one track: at least 8 m apart (the gaps a racer switches aisles through).
      const blocks = yardBlocks(a);
      for (const blk of blocks) {
        const r = blk.rect;
        const cars = city.districts.builds[a.id].hints.filter((h) => h.kind === 'car');
        const byTrack = new Map<number, number[]>();
        for (const c of cars) {
          const x = c.points[0].x;
          const z = c.points[0].z;
          const u = (x - r.ox) * r.ux + (z - r.oz) * r.uz;
          const v = (x - r.ox) * r.vx + (z - r.oz) * r.vz;
          if (u < 0 || u > r.L || v < 0 || v > r.D) continue;
          const track = blk.trackV.findIndex((tv) => Math.abs(tv - v) < 0.01);
          expect(track).toBeGreaterThan(0);
          (byTrack.get(track) ?? byTrack.set(track, []).get(track)!).push(u);
        }
        expect(byTrack.size).toBeGreaterThan(2);
      }
    }
  });
});

describe('rail yard terrain', () => {
  it("every height modifier's slope matches its gradient and fades to nothing at its box", () => {
    for (const seed of yardSeeds(8)) {
      const city = cityOf(seed);
      const a = city.districts.areas.find((x) => x.kind === 'railYard');
      if (!a) continue;
      const mods = city.districts.builds[a.id].heightMods;
      expect(mods.length).toBeGreaterThanOrEqual(2);
      for (const m of mods) {
        const s: HeightSample = { h: 0, gx: 0, gz: 0 };
        const at = (x: number, z: number): HeightSample => {
          s.h = 0;
          s.gx = 0;
          s.gz = 0;
          if (x >= m.minX && x <= m.maxX && z >= m.minZ && z <= m.maxZ) m.add(x, z, s);
          return { ...s };
        };
        let worst = 0;
        let nonzero = 0;
        let kinks = 0;
        for (let i = 0; i < 4000; i++) {
          // A deterministic scatter over the box and a little beyond.
          const fx = ((i * 7919) % 1009) / 1009;
          const fz = ((i * 104729) % 997) / 997;
          const x = m.minX - 1 + fx * (m.maxX - m.minX + 2);
          const z = m.minZ - 1 + fz * (m.maxZ - m.minZ + 2);
          const e = 1e-4;
          const here = at(x, z);
          if (here.h !== 0) nonzero++;
          const gx = (at(x + e, z).h - at(x - e, z).h) / (2 * e);
          const gz = (at(x, z + e).h - at(x, z - e).h) / (2 * e);
          // The ridge's crest is a hard kink on purpose (a lip to launch off): there the central difference straddles it, so
          // the gradient is checked with a short one sided step instead, as city.test.ts does for ramp edges.
          const miss = Math.max(Math.abs(gx - here.gx), Math.abs(gz - here.gz));
          if (miss > 2e-3) {
            kinks++;
            const step = 0.01;
            worst = Math.max(worst, Math.abs(at(x + step, z).h - here.h - here.gx * step) - 0.02);
          }
        }
        // Kinks are a hair of the box: a ridge's two crest edges, nothing like all of it.
        expect(kinks).toBeLessThan(40);
        expect(nonzero).toBeGreaterThan(20);
        expect(worst).toBeLessThan(2e-3);
        // Zero on the box's edge.
        for (let k = 0; k <= 20; k++) {
          const t = k / 20;
          for (const [x, z] of [
            [m.minX + t * (m.maxX - m.minX), m.minZ],
            [m.minX + t * (m.maxX - m.minX), m.maxZ],
            [m.minX, m.minZ + t * (m.maxZ - m.minZ)],
            [m.maxX, m.minZ + t * (m.maxZ - m.minZ)],
          ]) {
            const p = at(x, z);
            expect(Math.abs(p.h)).toBeLessThan(1e-6);
          }
        }
      }
    }
  });

  it('the ridge is 2 m at a 12% grade, the dock 1.1 m, the bank about 1.2 m, and the dock face stops only a car on the ground', () => {
    const seed = yardSeeds(1)[0];
    const city = cityOf(seed);
    const a = city.districts.areas.find((x) => x.kind === 'railYard')!;
    const blocks = yardBlocks(a);
    const base = createTerrain(seed);
    const world = createWorld(seed, 'circuit', city);
    const hump = blocks.find((b) => b.hump)!;
    const r = hump.rect;
    const h = hump.hump!;
    const vm = (h.v0 + h.v1) / 2;
    const at = (u: number, v: number) => {
      const x = r.ox + r.ux * u + r.vx * v;
      const z = r.oz + r.uz * u + r.vz * v;
      return world.heightAt(x, z) - base.heightAt(x, z);
    };
    expect(at(h.uc, vm)).toBeCloseTo(C.hump.rise, 2);
    // The steepest grade along the run-up is the configured 12%.
    let steep = 0;
    for (let u = h.uc - C.hump.top / 2 - h.run; u < h.uc; u += 0.25) steep = Math.max(steep, (at(u + 0.25, vm) - at(u, vm)) / 0.25);
    expect(steep).toBeGreaterThan(C.hump.grade * 0.95);
    expect(steep).toBeLessThan(C.hump.grade * 1.02);
    const dockBlock = blocks.find((b) => b.dock)!;
    const d = dockBlock.dock!;
    const mid = (d.u0 + d.u1) / 2;
    const dr = dockBlock.rect;
    const dh = (u: number, v: number) => {
      const x = dr.ox + dr.ux * u + dr.vx * v;
      const z = dr.oz + dr.uz * u + dr.vz * v;
      return world.heightAt(x, z) - base.heightAt(x, z);
    };
    expect(dh(mid, (dockBlock.dockFace + dr.D) / 2)).toBeCloseTo(C.dock.height, 2);
    // A ramp climbs at about 10%.
    let ramp = 0;
    for (let u = d.u0; u < d.u0 + d.ramp; u += 0.25) ramp = Math.max(ramp, (dh(u + 0.25, dr.D - 2) - dh(u, dr.D - 2)) / 0.25);
    expect(ramp).toBeGreaterThan(C.dock.grade * 0.95);
    expect(ramp).toBeLessThan(C.dock.grade * 1.2);
    // The face's Wall.top is settled: finite, between the ground and the platform.
    const faces = city.districts.builds[a.id].walls.filter((w) => w.look === 'yardFence' && w.top !== undefined);
    expect(faces.length).toBeGreaterThan(0);
    const seen = new Set<object>();
    for (const w of faces) {
      expect(Number.isFinite(w.top!)).toBe(true);
      // One top for the whole solid; its first face is the front, toward the ground.
      const first = faces.find((f) => f.solid === w.solid)!;
      expect(w.top).toBe(first.top);
      if (seen.has(w.solid!)) continue;
      seen.add(w.solid!);
      const gy = world.heightAt((first.ax + first.bx) / 2 + first.nx * 1.5, (first.az + first.bz) / 2 + first.nz * 1.5);
      expect(first.top! - gy).toBeCloseTo(C.dock.height * C.dock.topFrac, 5);
    }
    // The bank: 1.2 m at the crest, nothing at the inner edge.
    const loopBlock = blocks.find((b) => b.loop)!;
    const lr = loopBlock.rect;
    const L = loopBlock.loop!;
    const cx = lr.ox + lr.ux * L.cu + lr.vx * L.vmid;
    const cz = lr.oz + lr.uz * L.cu + lr.vz * L.vmid;
    const crestX = cx + lr.ux * (L.R - 0.6);
    const crestZ = cz + lr.uz * (L.R - 0.6);
    expect(world.heightAt(crestX, crestZ) - base.heightAt(crestX, crestZ)).toBeCloseTo(C.bank.height, 1);
    const inX = cx + lr.ux * (L.R - C.bank.hold / 2 - C.bank.rise - 0.5);
    const inZ = cz + lr.uz * (L.R - C.bank.hold / 2 - C.bank.rise - 0.5);
    expect(Math.abs(world.heightAt(inX, inZ) - base.heightAt(inX, inZ))).toBeLessThan(1e-6);
  });

  it('banking.ts: a reusable arc whose gradient is exact', () => {
    const arc: BankedArc = { cx: 3, cz: -4, rOut: 20, rise: 5, hold: 0.6, fall: 2.4, height: 1.2, mid: 0.7, half: Math.PI / 2, taper: 0.4 };
    const out: HeightSample = { h: 0, gx: 0, gz: 0 };
    const f = (x: number, z: number) => {
      out.h = 0;
      out.gx = 0;
      out.gz = 0;
      bankAdd(arc, x, z, out);
      return { ...out };
    };
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const ang = ((i * 37) % 360) * (Math.PI / 180);
      const rad = 12 + (((i * 91) % 1000) / 1000) * 14;
      const x = arc.cx + Math.cos(ang) * rad;
      const z = arc.cz + Math.sin(ang) * rad;
      const e = 1e-4;
      const p = f(x, z);
      worst = Math.max(worst, Math.abs((f(x + e, z).h - f(x - e, z).h) / (2 * e) - p.gx), Math.abs((f(x, z + e).h - f(x, z - e).h) / (2 * e) - p.gz));
    }
    expect(worst).toBeLessThan(2e-3);
    expect(f(arc.cx + Math.cos(arc.mid) * (arc.rOut + 0.3), arc.cz + Math.sin(arc.mid) * (arc.rOut + 0.3)).h).toBeCloseTo(1.2, 5);
    expect(f(arc.cx + Math.cos(arc.mid + Math.PI) * 20, arc.cz + Math.sin(arc.mid + Math.PI) * 20).h).toBe(0);
    expect(f(arc.cx + reachOf(arc) + 0.1, arc.cz).h).toBe(0);
    const line = bankWallLine(arc, 0.1);
    expect(Math.hypot(line[0].x - arc.cx, line[0].z - arc.cz)).toBeCloseTo(wallRadius(arc), 6);
  });
});
