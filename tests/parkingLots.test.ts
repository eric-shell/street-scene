import { describe, expect, it } from 'vitest';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { World } from '../src/city/world';
import { PARKING_LOT as C } from '../src/city/config';
import { lotCuts, lotLayout } from '../src/city/districts/parkingLot';
import { lotFrame, lotPoint } from '../src/city/districts/parkingLot/layout';
import { WALL_LOOKS, type Area } from '../src/city/districts/types';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { planParking } from '../src/city/parking';
import { driftZones } from '../src/sim/driftZones';
import { distToSegment } from '../src/sim/math';
import { Rng } from '../src/sim/prng';
import { TRAFFIC } from '../src/sim/tuning';

const lotsOf = (w: Pick<World, 'areas'>): Area[] => w.areas.filter((a) => a.kind === 'parkingLot');
const SEEDS = [20261019, 7, 1, 3, 4, 5];

describe('parking lots', () => {
  it('turn up on most seeds, one to three of them, and plan the same twice', () => {
    const rng = new Rng(4242);
    const seeds = Array.from({ length: 30 }, () => rng.int(0, 0x7fffffff));
    let withLots = 0;
    for (const seed of seeds) {
      const plan = planRoads(seed);
      const n = plan.districts.areas.filter((a) => a.kind === 'parkingLot').length;
      expect(n).toBeLessThanOrEqual(3);
      if (n > 0) withLots++;
    }
    expect(withLots / seeds.length).toBeGreaterThanOrEqual(0.8);
    for (const seed of seeds.slice(0, 3)) {
      const a = planRoads(seed).districts.areas.filter((x) => x.kind === 'parkingLot');
      const b = planRoads(seed).districts.areas.filter((x) => x.kind === 'parkingLot');
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('are big, drivable end to end, and fenced but for their curb cuts', () => {
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      const lots = lotsOf(w);
      for (const a of lots) {
        const L = lotLayout(a);
        const area = Math.abs(a.polygon.reduce((s, p, i) => s + (p.x * a.polygon[(i + 1) % a.polygon.length].z - a.polygon[(i + 1) % a.polygon.length].x * p.z), 0)) / 2;
        expect(area).toBeGreaterThan(C.minArea);
        expect(L.depth).toBeGreaterThanOrEqual(C.minDepth);
        expect(L.bays.length).toBeGreaterThan(60);
        const cuts = lotCuts(a);
        expect(cuts.length).toBeGreaterThanOrEqual(2);
        const frame = lotFrame(a);
        // Flood the lot's free ground (walls and props, not the parked cars, which are the hazard) from the first cut.
        const bb = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (const p of a.polygon) {
          bb.minX = Math.min(bb.minX, p.x);
          bb.maxX = Math.max(bb.maxX, p.x);
          bb.minZ = Math.min(bb.minZ, p.z);
          bb.maxZ = Math.max(bb.maxZ, p.z);
        }
        const step = 1.5;
        const cols = Math.ceil((bb.maxX - bb.minX) / step) + 1;
        const rows = Math.ceil((bb.maxZ - bb.minZ) / step) + 1;
        const seen = new Uint8Array(cols * rows);
        const out: never[] = [];
        const free = (x: number, z: number) => w.collideCircle(x, z, 1.2, out, w.heightAt(x, z)) === 0 && pointInPolygon(x, z, a.polygon);
        // Just inside a cut: the polygon edge point, then a few metres along the inward normal.
        const inside = (i: number) => {
          const c = cuts[i];
          const p = a.polygon[c.edge];
          const q = a.polygon[(c.edge + 1) % a.polygon.length];
          const l = Math.hypot(q.x - p.x, q.z - p.z);
          const dx = (q.x - p.x) / l;
          const dz = (q.z - p.z) / l;
          const e = L.fences.find((f) => f.edge === c.edge)!;
          return { x: p.x + dx * c.t + e.nx * 4, z: p.z + dz * c.t + e.nz * 4, outx: p.x + dx * c.t - e.nx * 3, outz: p.z + dz * c.t - e.nz * 3 };
        };
        const start = inside(0);
        const queue: [number, number][] = [[Math.round((start.x - bb.minX) / step), Math.round((start.z - bb.minZ) / step)]];
        while (queue.length) {
          const [i, j] = queue.pop()!;
          if (i < 0 || j < 0 || i >= cols || j >= rows || seen[j * cols + i]) continue;
          if (!free(bb.minX + i * step, bb.minZ + j * step)) continue;
          seen[j * cols + i] = 1;
          queue.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
        }
        const reached = (x: number, z: number) => {
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (seen[(Math.round((z - bb.minZ) / step) + dj) * cols + Math.round((x - bb.minX) / step) + di]) return true;
          return false;
        };
        // Every cut leads to the same open ground: through the lot from any entrance to any exit.
        for (let i = 0; i < cuts.length; i++) expect(reached(inside(i).x, inside(i).z)).toBe(true);
        // Every aisle and the forecourt are reachable.
        for (const r of [...L.aisles, ...(L.zone ? [L.zone] : [])]) {
          const p = lotPoint(frame, (r.u0 + r.u1) / 2, (r.w0 + r.w1) / 2);
          expect(reached(p.x, p.z)).toBe(true);
        }
        // From the street, through the cut, at road level and on road: the curb is cut, the way in is flat.
        for (let i = 0; i < cuts.length; i++) {
          const s = inside(i);
          const ex = (s.x - s.outx) / 7;
          const ez = (s.z - s.outz) / 7;
          for (let t = 0; t <= 7; t += 0.5) {
            const x = s.outx + ex * t;
            const z = s.outz + ez * t;
            expect(w.surfaceAt(x, z)).toBe('road');
            expect(Math.abs(w.driveHeightAt(x, z) - w.heightAt(x, z))).toBeLessThan(0.02);
            expect(w.collideCircle(x, z, 1.2, out, w.heightAt(x, z))).toBe(0);
          }
        }
        // Fenced: a car cannot leave but through a cut. Probe the polygon's boundary a metre in, every 2 m: the fence stops a car
        // there everywhere except across a cut's gap.
        for (let k = 0; k < a.polygon.length; k++) {
          const p = a.polygon[k];
          const q = a.polygon[(k + 1) % a.polygon.length];
          const l = Math.hypot(q.x - p.x, q.z - p.z);
          if (l < 3) continue;
          const e = L.fences.find((f) => f.edge === k);
          if (!e) continue;
          for (let t = 1; t < l - 1; t += 2) {
            const gap = cuts.some((c) => c.edge === k && Math.abs(c.t - t) < c.hw + 1.4);
            const x = p.x + ((q.x - p.x) * t) / l + e.nx * (C.fence.thickness * 0.5);
            const z = p.z + ((q.z - p.z) * t) / l + e.nz * (C.fence.thickness * 0.5);
            const hit = w.collideCircle(x, z, 0.5, out, w.heightAt(x, z)) > 0;
            if (!gap) expect(hit).toBe(true);
          }
        }
      }
    }
  });

  it('hold their cars in the bays, off the aisles, walls and props', () => {
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      const plan = planParking(w);
      const out: never[] = [];
      for (const a of lotsOf(w)) {
        const L = lotLayout(a);
        const frame = lotFrame(a);
        const cars = plan.cars.filter((c) => c.lot === a.id);
        expect(cars.length).toBe(L.cars.length);
        // 45 to 70% of the bays are taken, islands being no bays.
        const bays = L.bays.length - L.islands.length * 2;
        expect(cars.length / bays).toBeGreaterThan(0.35);
        expect(cars.length / bays).toBeLessThan(0.75);
        const kinds = new Set(cars.map((c) => c.kind));
        expect(kinds.size).toBeGreaterThan(4);
        for (const c of L.cars) {
          const bay = L.bays[c.bay];
          const row = L.rows[bay.row];
          const k = TRAFFIC.kinds.find((kd) => kd.name === c.kind)!;
          expect(k).toBeDefined();
          const fx = Math.sin(c.yaw);
          const fz = Math.cos(c.yaw);
          // The body's corners in the lot frame sit inside the bay, up to the nose poking a little into the aisle.
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              const x = c.x + fx * sz * k.halfLength + fz * sx * k.halfWidth;
              const z = c.z + fz * sz * k.halfLength - fx * sx * k.halfWidth;
              const u = (x - frame.o.x) * frame.u.x + (z - frame.o.z) * frame.u.z;
              const wv = (x - frame.o.x) * frame.w.x + (z - frame.o.z) * frame.w.z;
              expect(wv).toBeGreaterThan(row.w0 - 0.8);
              expect(wv).toBeLessThan(row.w1 + 0.8);
              expect(Math.abs(u - bay.u)).toBeLessThan(C.bayWidth / 2 + 0.25);
              for (const ai of L.aisles) {
                // Inside an aisle only by the nose's overhang.
                const inAisle = u > ai.u0 && u < ai.u1 && wv > ai.w0 + 0.9 && wv < ai.w1 - 0.9;
                expect(inAisle).toBe(false);
              }
            }
          }
          // Not on a wall, not on a prop.
          const y = w.heightAt(c.x, c.z);
          expect(w.collideBox(c.x, c.z, c.yaw, k.halfLength, k.halfWidth, out, y)).toBe(0);
          w.propGrid.query(c.x - 4, c.z - 4, c.x + 4, c.z + 4, []);
        }
        for (const p of w.props) {
          if (p.area !== a.id) continue;
          for (const c of L.cars) {
            const k = TRAFFIC.kinds.find((kd) => kd.name === c.kind)!;
            const dx = p.x - c.x;
            const dz = p.z - c.z;
            const along = Math.abs(dx * Math.sin(c.yaw) + dz * Math.cos(c.yaw));
            const across = Math.abs(dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw));
            expect(along < k.halfLength + p.radius && across < k.halfWidth + p.radius).toBe(false);
          }
        }
        // No two bodies overlap (same bay width apart or the rows' depths apart).
        for (let i = 0; i < L.cars.length; i++) {
          for (let j = i + 1; j < L.cars.length; j++) {
            const a1 = L.cars[i];
            const b1 = L.cars[j];
            if ((a1.x - b1.x) ** 2 + (a1.z - b1.z) ** 2 > 36) continue;
            const ka = TRAFFIC.kinds.find((kd) => kd.name === a1.kind)!;
            const kb = TRAFFIC.kinds.find((kd) => kd.name === b1.kind)!;
            // Separated on one of the two bodies' own axes (a box test, the bodies' half sizes).
            const sep = (c: typeof a1, o: typeof b1, hl: number, hw: number) => {
              const dx = o.x - c.x;
              const dz = o.z - c.z;
              return Math.abs(dx * Math.sin(c.yaw) + dz * Math.cos(c.yaw)) - hl > 0 || Math.abs(dx * Math.cos(c.yaw) - dz * Math.sin(c.yaw)) - hw > 0;
            };
            const corners = (c: typeof a1, k: typeof ka) => [-1, 1].flatMap((sx) => [-1, 1].map((sz) => ({ x: c.x + Math.sin(c.yaw) * sz * k.halfLength + Math.cos(c.yaw) * sx * k.halfWidth, z: c.z + Math.cos(c.yaw) * sz * k.halfLength - Math.sin(c.yaw) * sx * k.halfWidth })));
            const anyInside = (c: typeof a1, k: typeof ka, pts: { x: number; z: number }[]) => pts.some((p) => !sep(c, { ...c, x: p.x, z: p.z }, k.halfLength, k.halfWidth));
            expect(anyInside(a1, ka, corners(b1, kb)) || anyInside(b1, kb, corners(a1, ka))).toBe(false);
          }
        }
      }
    }
  });

  it('keep off the routes: no lot fronts a route street or a meet, and the drag strip avoids the cut streets', () => {
    for (const seed of SEEDS) {
      const city = createCity(seed);
      for (const kind of ['circuit', 'sprint', 'drag'] as const) {
        const w = createWorld(seed, kind, city);
        const routeNodes = new Set(w.route.nodes);
        const routeEdges = new Set(w.route.edges);
        for (const a of lotsOf(w)) {
          for (const c of lotCuts(a)) {
            expect(routeEdges.has(c.road)).toBe(false);
            expect(routeNodes.has(w.graph.edges[c.road].a) || routeNodes.has(w.graph.edges[c.road].b)).toBe(false);
          }
          // Every fence piece, and so every frontage the lot opens, is well off the route's line.
          const pts = w.route.points;
          for (const f of lotLayout(a).fences) {
            for (let i = 0; i + 1 < pts.length; i++) expect(distToSegment(f.ax, f.az, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z)).toBeGreaterThan(C.routeEdgeClear - 1);
          }
          // Barriers and rails (the races' closures) stand nowhere near a lot.
          for (const wall of w.walls) if (wall.kind !== 'wall' && distToPolygonEdge(wall.ax, wall.az, a.polygon) < 12 && !pointInPolygon(wall.ax, wall.az, a.polygon)) expect(`${seed} ${kind} ${wall.kind} ${distToPolygonEdge(wall.ax, wall.az, a.polygon).toFixed(1)}`).toBe('wall');
        }
      }
    }
  });

  it('are drift zones on the forecourt, walls carry their looks, and the city is the same twice', () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const w = createWorld(seed, 'circuit');
      const zones = driftZones(w);
      for (const a of lotsOf(w)) {
        for (const wall of w.walls) if (wall.area === a.id) expect(WALL_LOOKS).toContain(wall.look);
        if (a.params.lu > 0) expect(zones.some((z) => z.area === a.id)).toBe(true);
      }
      const again = createWorld(seed, 'circuit');
      expect(JSON.stringify(lotsOf(again).map((a) => lotLayout(a).cars))).toBe(JSON.stringify(lotsOf(w).map((a) => lotLayout(a).cars)));
      expect(planParking(again)).toEqual(planParking(w));
    }
  });
});
