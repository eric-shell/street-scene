import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { CITY } from '../src/city/config';
import { createCity, createWorld, planRoads } from '../src/city/world';
import { chainOf, edgeBetween } from '../src/city/roadGraph';
import { computeMouths } from '../src/city/blocks';
import { distToSegment } from '../src/sim/math';
import { ridgeAt, ridgeRawAt, ridgeShape, tunnelShape } from '../src/city/districts/tunnel';
import { gantryShape, viaductShape } from '../src/city/districts/overpass';
import { junctionReach, toLocal } from '../src/city/districts/structures';
import { plateauDistance } from '../src/city/districts/hills';
import { riverCenter } from '../src/city/districts/river';
import type { Area } from '../src/city/districts/types';
import type { City } from '../src/city/world';
import { createRace, stepRace } from '../src/sim/race';
import { routeSample } from '../src/city/route';
import { createAi, autopilotInput } from '../src/sim/ai';
import { carSnapshot, raceConfig } from './helpers';

const TUN = CITY.districts.tunnel;
const OV = CITY.districts.overpass;

/** Cities from a seeded sweep, with every structure they plan. */
const cities: City[] = (() => {
  const rng = new Rng(4711);
  return Array.from({ length: 14 }, () => createCity(rng.int(0, 0x7fffffff)));
})();
const structures = (c: City) => c.districts.areas.filter((a) => a.kind === 'tunnel' || a.kind === 'overpass');

/** Distance from (x, z) to the centerline of edge e. */
function edgeDist(c: City, id: number, x: number, z: number): number {
  const e = c.graph.edges[id];
  const a = c.graph.nodes[e.a];
  const b = c.graph.nodes[e.b];
  return distToSegment(x, z, a.x, a.z, b.x, b.z);
}

/** Never on a road surface: beside every edge's carriageway (its round caps past the nodes aside). */
function offRoads(c: City, x: number, z: number): boolean {
  for (const e of c.graph.edges) {
    const a = c.graph.nodes[e.a];
    const b = c.graph.nodes[e.b];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const t = ((x - a.x) * (b.x - a.x) + (z - a.z) * (b.z - a.z)) / (l * l);
    if (t * l < 1.5 || (1 - t) * l < 1.5) continue;
    if (distToSegment(x, z, a.x, a.z, b.x, b.z) < e.width / 2 - 0.05) return false;
  }
  return true;
}

describe('tunnels and overpasses (city)', () => {
  it('most cities get a tunnel under a building, many a ridge, a viaduct and a few gantries', () => {
    let ridges = 0;
    let viaducts = 0;
    for (const c of cities) {
      const s = structures(c);
      expect(s.filter((a) => a.variant === 'building').length).toBeGreaterThanOrEqual(1);
      expect(s.filter((a) => a.variant === 'gantry').length).toBeGreaterThanOrEqual(1);
      expect(s.filter((a) => a.variant === 'gantry').length).toBeLessThanOrEqual(OV.gantries[1]);
      if (s.some((a) => a.variant === 'ridge')) ridges++;
      if (s.some((a) => a.variant === 'viaduct')) viaducts++;
    }
    expect(ridges).toBeGreaterThan(cities.length * 0.3);
    expect(viaducts).toBeGreaterThan(cities.length * 0.5);
  });

  it('plans the same structures every time', () => {
    for (const c of cities.slice(0, 4)) {
      const again = createCity(c.seed);
      const pick = (x: City) => JSON.stringify(structures(x).map((a) => ({ a, b: x.districts.builds[a.id] })));
      expect(pick(again)).toBe(pick(c));
      expect(JSON.stringify(again.blocks.walls)).toBe(JSON.stringify(c.blocks.walls));
    }
  });

  it('every tunnel, rock and pier wall is one the renderer draws, and none stands on a road', () => {
    for (const c of cities) {
      const byId = new Map(c.districts.areas.map((a) => [a.id, a]));
      for (const w of c.blocks.walls) {
        if (w.look !== 'tunnel' && w.look !== 'rock' && w.look !== 'pier') continue;
        const a = byId.get(w.area ?? -1)!;
        // The river's bridge piers stand on the channel floor under a deck, on purpose (districts/river.ts).
        if (a.kind === 'river') continue;
        expect(a.kind === 'tunnel' || a.kind === 'overpass').toBe(true);
        for (const t of [0.1, 0.5, 0.9]) expect(offRoads(c, w.ax + (w.bx - w.ax) * t, w.az + (w.bz - w.az) * t)).toBe(true);
        const mx = (w.ax + w.bx) / 2;
        const mz = (w.az + w.bz) / 2;
        if (a.kind === 'tunnel') {
          const s = tunnelShape(a);
          const l = toLocal(s, mx, mz);
          const v = Math.abs(l.v);
          const u = Math.abs(l.u);
          if (w.look === 'tunnel' && !w.solid && v < s.front - 0.3) {
            // Tunnel wall (walkway's back edge) inside the bore, or a wingwall flaring out to the building line.
            if (u <= s.half + 1e-6) expect(v).toBeCloseTo(s.wall, 5);
            else {
              expect(u).toBeLessThanOrEqual(s.half + s.wing + 1e-6);
              expect(v).toBeCloseTo(s.wall + ((s.front - s.wall) * (u - s.half)) / s.wing, 4);
            }
          } else {
            // The building line: shut in behind the walls (tunnel) or the ridge's rock face (rock).
            expect(v).toBeGreaterThan(s.front - 0.3);
            expect(v).toBeLessThan(s.front + 0.3);
            if (w.look === 'tunnel') expect(u).toBeLessThanOrEqual(s.half + s.wing + 1.5);
            else {
              const r = ridgeShape(a);
              expect(u).toBeLessThanOrEqual(r.a + r.w + 3);
            }
          }
        } else {
          const b = c.districts.builds[a.id];
          if (w.solid) {
            // A pier, column, abutment or gantry leg prop stands right there.
            const near = b.props.some((p) => Math.hypot(p.x - mx, p.z - mz) < Math.max(p.size, p.height) + 4);
            expect(near).toBe(true);
          } else {
            // The building line under a viaduct's deck.
            const v = viaductShape(a);
            const lat = Math.abs(-(mx - v.x0) * v.uz + (mz - v.z0) * v.ux);
            expect(lat).toBeLessThan(v.half + 2.6);
          }
        }
      }
    }
  });

  it('bores and gantries keep clear of junctions; viaduct piers stand on their sidewalks', () => {
    for (const c of cities) {
      const mouths = computeMouths(c.graph, c.blocks.sectors);
      for (const a of structures(c)) {
        if (a.kind === 'tunnel') {
          const s = tunnelShape(a);
          // The bore sits on a street: a chain of pieces through bend nodes (roadGraph.ts), its
          // junctions at the chain's ends; params.edge is the piece under the bore's middle.
          const street = chainOf(c.graph, a.params.edge);
          const first = c.graph.edges[street.edges[0]];
          const last = c.graph.edges[street.edges[street.edges.length - 1]];
          const A = c.graph.nodes[street.nodes[0]];
          const B = c.graph.nodes[street.nodes[street.nodes.length - 1]];
          const ux = (B.x - A.x) / Math.hypot(B.x - A.x, B.z - A.z);
          const uz = (B.z - A.z) / Math.hypot(B.x - A.x, B.z - A.z);
          const along = (s.cx - A.x) * ux + (s.cz - A.z) * uz;
          expect(along - s.half - s.wing).toBeGreaterThanOrEqual(junctionReach(c.graph, mouths, first, street.nodes[0]) - 1e-6);
          expect(street.length - along - s.half - s.wing).toBeGreaterThanOrEqual(junctionReach(c.graph, mouths, last, street.nodes[street.nodes.length - 1]) - 1e-6);
          // Every piece it reaches over is the tunnel's.
          for (const id of street.edges) {
            const E = c.graph.edges[id];
            const P = c.graph.nodes[E.a];
            const Q = c.graph.nodes[E.b];
            const lo = Math.min((P.x - A.x) * ux + (P.z - A.z) * uz, (Q.x - A.x) * ux + (Q.z - A.z) * uz);
            const hi = Math.max((P.x - A.x) * ux + (P.z - A.z) * uz, (Q.x - A.x) * ux + (Q.z - A.z) * uz);
            if (hi > along - s.half - s.wing && lo < along + s.half + s.wing) expect(a.edges).toContain(id);
          }
          // Clear of the river channel.
          for (const r of c.districts.areas.filter((x) => x.kind === 'river')) {
            if (s.cx < r.params.x0 || s.cx > r.params.x1) continue;
            expect(Math.abs(s.cz - riverCenter(r.params, s.cx))).toBeGreaterThan(r.params.top + 10);
          }
        } else if (a.variant === 'gantry') {
          const g = gantryShape(a);
          const e = c.graph.edges[a.params.edge];
          for (const p of a.path) {
            const d = edgeDist(c, e.id, p.x, p.z);
            expect(d).toBeGreaterThan(e.width / 2);
            expect(d).toBeLessThan(e.width / 2 + e.sidewalk);
          }
          expect(g.legV).toBeGreaterThan(g.road);
        } else {
          for (const p of c.districts.builds[a.id].props.filter((q) => q.kind === 'pier')) {
            // On the sidewalk of one of the streets it crosses.
            const on = a.edges.some((id) => {
              const e = c.graph.edges[id];
              const d = edgeDist(c, id, p.x, p.z);
              return d > e.width / 2 + 0.5 && d < e.width / 2 + e.sidewalk;
            });
            expect(on).toBe(true);
          }
          expect(a.params.crossings).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('a ridge leaves its street at road level, has an exact gradient and covers the bore', () => {
    let seen = 0;
    const rng = new Rng(3);
    const out = { h: 0, gx: 0, gz: 0 };
    const at = (r: ReturnType<typeof ridgeShape>, x: number, z: number) => {
      out.h = out.gx = out.gz = 0;
      ridgeAt(r, x, z, out);
      return { ...out };
    };
    for (const c of cities) {
      for (const a of structures(c).filter((x) => x.variant === 'ridge')) {
        seen++;
        const r = ridgeShape(a);
        const t = tunnelShape(a);
        // The street's corridor (road and sidewalks) gets nothing, the whole length of its street
        // (every piece of the chain through its bend nodes, roadGraph.ts; the bore stands on its chord).
        const street = chainOf(c.graph, a.params.edge);
        for (const id of street.edges) {
          const e = c.graph.edges[id];
          const A = c.graph.nodes[e.a];
          const B = c.graph.nodes[e.b];
          const ux = (B.x - A.x) / (e.length || 1);
          const uz = (B.z - A.z) / (e.length || 1);
          for (let s = 0; s <= e.length; s += 2) {
            for (const v of [-t.front - 0.2, -t.wall, 0, t.road, t.front + 0.2]) {
              const x = A.x + ux * s - uz * v;
              const z = A.z + uz * s + ux * v;
              expect(at(r, x, z).h).toBe(0);
            }
          }
        }
        // Every other street's corridor too: nothing else crosses the ridge.
        for (const o of c.graph.edges) {
          if (street.edges.includes(o.id)) continue;
          const P = c.graph.nodes[o.a];
          const Q = c.graph.nodes[o.b];
          for (let k = 0; k <= 20; k++) {
            const x = P.x + ((Q.x - P.x) * k) / 20;
            const z = P.z + ((Q.z - P.z) * k) / 20;
            expect(plateauDistance(r, x, z).d).toBeGreaterThan(r.w + o.width / 2 + o.sidewalk);
          }
        }
        // Rock over the bore at least the ceiling slab plus the portal cover, full height behind the cut.
        const cover = TUN.clearance + TUN.slab + TUN.portalCover - 1e-6;
        for (const u of [-t.half, 0, t.half]) {
          const p = { x: t.cx + t.ux * u, z: t.cz + t.uz * u };
          expect(ridgeRawAt(r, p.x, p.z)).toBeGreaterThanOrEqual(cover);
          const q = { x: p.x - t.uz * (r.m1 + 1), z: p.z + t.ux * (r.m1 + 1) };
          expect(at(r, q.x, q.z).h).toBeCloseTo(ridgeRawAt(r, q.x, q.z), 9);
        }
        // C1: analytic gradient against finite differences, including the cut's flanks.
        for (let k = 0; k < 200; k++) {
          const u = rng.range(-(r.a + r.w + 3), r.a + r.w + 3);
          const v = rng.range(-(r.b + r.w + 3), r.b + r.w + 3);
          const x = r.cx + r.ux * u - r.uz * v;
          const z = r.cz + r.uz * u + r.ux * v;
          // A small step: the profile is C1 but not C2 at each smoothstep end, so a central difference
          // straddling one is off by about 1.5 * h * (ridge height) / (ramp length)^2, which at h = 0.005
          // reaches 1e-2 for a 24 m ridge whose corridor mask ramps over 4 m; at 2e-4 it stays under 4e-4.
          const h = 2e-4;
          const g = at(r, x, z);
          expect(Math.abs(g.gx - (at(r, x + h, z).h - at(r, x - h, z).h) / (2 * h))).toBeLessThan(2e-3);
          expect(Math.abs(g.gz - (at(r, x, z + h).h - at(r, x, z - h).h) / (2 * h))).toBeLessThan(2e-3);
        }
        // The world agrees: flat street through it, rock beside it.
        const w = c.terrain;
        const mid = { x: t.cx, z: t.cz };
        const side = { x: t.cx - t.uz * (r.m1 + 2), z: t.cz + t.ux * (r.m1 + 2) };
        expect(w.heightAt(side.x, side.z) - w.heightAt(mid.x, mid.z)).toBeGreaterThan(r.h * 0.8);
        // No building on it.
        for (const b of c.blocks.buildings) expect(plateauDistance(r, b.x, b.z).d).toBeGreaterThan(r.w * 0.5);
      }
    }
    expect(seen).toBeGreaterThan(3);
  });
});

describe('tunnels and overpasses (routes)', () => {
  it('races run through them on a good share of seeds', () => {
    const rng = new Rng(77);
    const n = 40;
    let tunnel = 0;
    let covered = 0;
    for (let i = 0; i < n; i++) {
      const { graph: g, districts, routeNodes } = planRoads(rng.int(0, 0x7fffffff));
      const used = new Set<number>();
      for (const kind of ['circuit', 'sprint'] as const) {
        const nodes = routeNodes[kind];
        const m = kind === 'circuit' ? nodes.length : nodes.length - 1;
        for (let k = 0; k < m; k++) used.add(edgeBetween(g, nodes[k], nodes[(k + 1) % nodes.length]));
      }
      const s = districts.areas.filter((a) => a.kind === 'tunnel' || a.kind === 'overpass');
      const through = (a: Area) => (a.kind === 'tunnel' || a.variant === 'gantry' ? used.has(a.params.edge) : a.edges.some((e) => used.has(e)));
      if (s.some((a) => a.kind === 'tunnel' && through(a))) tunnel++;
      if (s.some((a) => a.variant !== 'gantry' && through(a))) covered++;
    }
    // Placed on the race routes when they are known (PlanContext.event): one race or the other runs through
    // a tunnel on nearly every seed.
    expect(tunnel / n).toBeGreaterThan(0.75);
    expect(covered / n).toBeGreaterThan(0.8);
  });

  it('starts, grids and finishes stay in the open, away from bores, decks and gantries', () => {
    const rng = new Rng(515);
    for (let i = 0; i < 16; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const city = createCity(seed);
      for (const kind of ['circuit', 'sprint'] as const) {
        const w = createWorld(seed, kind, city);
        const spots = [routeSample(w.route, w.route.startS), routeSample(w.route, w.route.finishS), ...w.route.grid];
        for (const a of structures(city)) {
          for (const p of spots) {
            if (a.kind === 'tunnel') {
              const t = tunnelShape(a);
              const l = toLocal(t, p.x, p.z);
              const inside = Math.abs(l.u) < t.half + t.wing + 25 && Math.abs(l.v) < t.front + 5;
              expect(inside).toBe(false);
            } else if (a.variant === 'viaduct') {
              const v = viaductShape(a);
              const along = (p.x - v.x0) * v.ux + (p.z - v.z0) * v.uz;
              const lat = -(p.x - v.x0) * v.uz + (p.z - v.z0) * v.ux;
              expect(along > -5 && along < v.length + 5 && Math.abs(lat) < v.half + 20).toBe(false);
            } else {
              expect(Math.hypot(p.x - a.params.cx, p.z - a.params.cz)).toBeGreaterThan(20);
            }
          }
        }
      }
    }
  });

  it('the AI drives through a tunnel on its route, the same way twice', () => {
    // A seed whose circuit runs through a tunnel.
    const rng = new Rng(2718);
    let seed = -1;
    let bore: Area | null = null;
    for (let i = 0; i < 60 && seed < 0; i++) {
      const s = rng.int(0, 0x7fffffff);
      const { graph: g, districts, routeNodes } = planRoads(s);
      const nodes = routeNodes.circuit;
      const used = new Set<number>();
      for (let k = 0; k < nodes.length; k++) used.add(edgeBetween(g, nodes[k], nodes[(k + 1) % nodes.length]));
      const t = districts.areas.find((a) => a.kind === 'tunnel' && used.has(a.params.edge));
      if (t) {
        seed = s;
        bore = t;
      }
    }
    expect(seed).toBeGreaterThanOrEqual(0);
    const t = tunnelShape(bore!);
    const run = () => {
      const cfg = raceConfig(seed, 'circuit', 2);
      const r = createRace(cfg, createWorld(seed, 'circuit'));
      const pilot = createAi(0.97);
      const inside = r.cars.map(() => false);
      while (r.tick < 420 * 60 && !r.cars.every((c) => c.finished)) {
        stepRace(r, autopilotInput(r, r.cars[0], pilot));
        r.cars.forEach((c, k) => {
          const l = toLocal(t, c.state.x, c.state.z);
          if (Math.abs(l.u) < t.half && Math.abs(l.v) < t.wall) inside[k] = true;
        });
      }
      return { r, inside };
    };
    const a = run();
    expect(a.inside.every(Boolean)).toBe(true);
    for (const c of a.r.cars) {
      expect(c.finished).toBe(true);
      expect(a.r.events.filter((e) => e.type === 'reset' && e.car === c.index).length).toBeLessThanOrEqual(2);
    }
    const b = run();
    expect(carSnapshot(b.r)).toBe(carSnapshot(a.r));
  });
});
