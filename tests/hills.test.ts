import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, createWorld } from '../src/city/world';
import { Rng } from '../src/sim/prng';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { distToSegment } from '../src/sim/math';
import { hillAt, hillOutline, plateauDistance, shapeOf } from '../src/city/districts/hills';
import { riverCenter } from '../src/city/districts/river';
import { WALL_LOOKS } from '../src/city/districts/types';
import type { Contact } from '../src/city/world';

const HILLS = CITY.districts.hills;
const MON = CITY.districts.monument;

describe('hills', () => {
  it('lifts two or three clusters of blocks per city on a profile capped at its grade, and the streets on them really climb', () => {
    const rng = new Rng(31);
    let worst = 0;
    let steepest = 0;
    const sizes = new Set<number>();
    const variants = new Set<string>();
    const out = { h: 0, gx: 0, gz: 0 };
    for (let i = 0; i < 24; i++) {
      const c = createCity(rng.int(0, 0x7fffffff));
      const hs = c.districts.areas.filter((a) => a.kind === 'hills');
      expect(hs.length).toBeGreaterThanOrEqual(HILLS.count[0]);
      expect(hs.length).toBeLessThanOrEqual(HILLS.count[1]);
      for (const h of hs) {
        expect(h.faces.length).toBeGreaterThanOrEqual(HILLS.blocks[0]);
        expect(h.faces.length).toBeLessThanOrEqual(HILLS.blocks[1]);
        sizes.add(h.faces.length);
        variants.add(h.variant);
        const s = shapeOf(h);
        expect(Math.abs(s.h)).toBeGreaterThanOrEqual(HILLS.height[0] - 1e-9);
        expect(Math.abs(s.h)).toBeLessThanOrEqual(HILLS.height[1] + 1e-9);
        // The profile alone never passes the cap, reaches its full height on the plateau and is 0 past the slope.
        for (let k = 0; k < 300; k++) {
          const x = s.cx + rng.range(-(s.a + s.w + 5), s.a + s.w + 5);
          const z = s.cz + rng.range(-(s.b + s.w + 5), s.b + s.w + 5);
          out.h = out.gx = out.gz = 0;
          hillAt(s, x, z, out);
          expect(Math.hypot(out.gx, out.gz)).toBeLessThanOrEqual(HILLS.maxGrade + 1e-6);
          expect(Math.abs(out.h)).toBeLessThanOrEqual(Math.abs(s.h) + 1e-9);
        }
        out.h = out.gx = out.gz = 0;
        hillAt(s, s.cx, s.cz, out);
        expect(out.h).toBeCloseTo(s.h, 9);
        for (const p of hillOutline(s, s.w + 0.5)) {
          out.h = out.gx = out.gz = 0;
          hillAt(s, p.x, p.z, out);
          expect(out.h).toBe(0);
        }
      }
      // World grades on hill streets: the cap plus the base terrain's own worst grade, at most.
      const g = c.graph;
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        if (e.kind === 'backAlley' || a.ring || b.ring) continue;
        const mx = (a.x + b.x) / 2;
        const mz = (a.z + b.z) / 2;
        if (!hs.some((h) => pointInPolygon(mx, mz, h.polygon))) continue;
        let edgeMax = 0;
        for (let t = 0.02; t <= 0.98; t += 0.04) {
          const sl = c.terrain.slopeAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
          edgeMax = Math.max(edgeMax, Math.hypot(sl.gx, sl.gz));
        }
        worst = Math.max(worst, edgeMax);
        steepest = Math.max(steepest, edgeMax);
      }
    }
    expect(worst).toBeLessThan(HILLS.maxGrade + 0.056 + 0.005);
    expect(steepest).toBeGreaterThan(0.08);
    expect(sizes.size).toBeGreaterThan(1);
    expect(variants.has('dome') || variants.has('ridge')).toBe(true);
  });

  it('is C1: the analytic gradient matches finite differences everywhere, including the plateau edge and the foot of the slope', () => {
    const c = createCity(20261020);
    const hs = c.districts.areas.filter((a) => a.kind === 'hills');
    expect(hs.length).toBeGreaterThan(0);
    const rng = new Rng(8);
    const out = { h: 0, gx: 0, gz: 0 };
    const at = (s: ReturnType<typeof shapeOf>, x: number, z: number) => {
      out.h = out.gx = out.gz = 0;
      hillAt(s, x, z, out);
      return { h: out.h, gx: out.gx, gz: out.gz };
    };
    for (const h of hs) {
      const s = shapeOf(h);
      const probes = [...hillOutline(s, 0), ...hillOutline(s, s.w), ...hillOutline(s, s.w / 2)];
      for (let k = 0; k < 60; k++) probes.push({ x: s.cx + rng.range(-(s.a + s.w), s.a + s.w), z: s.cz + rng.range(-(s.b + s.w), s.b + s.w) });
      for (const p of probes) {
        const e = 0.01;
        const v = at(s, p.x, p.z);
        const gx = (at(s, p.x + e, p.z).h - at(s, p.x - e, p.z).h) / (2 * e);
        const gz = (at(s, p.x, p.z + e).h - at(s, p.x, p.z - e).h) / (2 * e);
        expect(Math.abs(v.gx - gx)).toBeLessThan(2e-4);
        expect(Math.abs(v.gz - gz)).toBeLessThan(2e-4);
      }
    }
  });

  it('plans the same hills every time, clear of the river channel, roundabouts, the El and each other', () => {
    const rng = new Rng(44);
    for (let i = 0; i < 10; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const a = createCity(seed);
      const b = createCity(seed);
      const hills = (c: typeof a) => c.districts.areas.filter((x) => x.kind === 'hills');
      expect(JSON.stringify(hills(a))).toBe(JSON.stringify(hills(b)));
      const g = a.graph;
      for (const h of hills(a)) {
        const s = shapeOf(h);
        for (const r of a.districts.areas.filter((x) => x.kind === 'river')) {
          for (let x = r.params.x0; x <= r.params.x1; x += 10) expect(plateauDistance(s, x, riverCenter(r.params, x)).d).toBeGreaterThanOrEqual(s.w + r.params.top);
        }
        for (const sub of a.districts.areas.filter((x) => x.kind === 'subway')) for (const p of sub.path) expect(plateauDistance(s, p.x, p.z).d).toBeGreaterThanOrEqual(s.w);
        for (const n of g.nodes) {
          if (!n.ring) continue;
          const q = plateauDistance(s, n.x, n.z);
          expect(q.d > 0 ? q.d >= s.w + n.ring.outer : q.inner >= n.ring.outer).toBe(true);
        }
        for (const o of hills(a)) {
          if (o === h) continue;
          const so = shapeOf(o);
          for (const p of hillOutline(so, 0)) expect(plateauDistance(s, p.x, p.z).d).toBeGreaterThanOrEqual((1 - HILLS.overlap) * (s.w + so.w) - 1e-6);
        }
        // Its blocks are claimed by it alone, and the slope's blocks still have buildings.
        for (const f of h.faces) expect(a.districts.areas.filter((x) => x.kind !== 'infill' && x.faces.includes(f)).length).toBe(1);
      }
    }
  });
});

describe('monument', () => {
  it('stands on an open plaza near the center: every wall drawn and off the roads, the base solid, an arch wide enough to drive through', () => {
    const rng = new Rng(77);
    let seen = 0;
    const kinds = new Set<string>();
    const contacts: Contact[] = [];
    for (let i = 0; i < 20; i++) {
      const w = createWorld(rng.int(0, 0x7fffffff), 'circuit');
      const m = w.areas.find((a) => a.kind === 'monument');
      if (!m) continue;
      seen++;
      kinds.add(m.variant);
      const g = w.graph;
      const cx0 = (g.bounds.minX + g.bounds.maxX) / 2;
      const cz0 = (g.bounds.minZ + g.bounds.maxZ) / 2;
      expect(Math.hypot(m.params.cx - cx0, m.params.cz - cz0)).toBeLessThanOrEqual(MON.reach + 1);
      const walls = w.walls.filter((x) => x.kind === 'wall' && x.look === 'monument' && x.area === m.id);
      expect(walls.length).toBeGreaterThan(3);
      for (const wall of walls) {
        for (const t of [0, 0.5, 1]) {
          const x = wall.ax + (wall.bx - wall.ax) * t;
          const z = wall.az + (wall.bz - wall.az) * t;
          expect(pointInPolygon(x, z, m.polygon)).toBe(true);
          for (const e of g.edges) expect(distToSegment(x, z, g.nodes[e.a].x, g.nodes[e.a].z, g.nodes[e.b].x, g.nodes[e.b].z)).toBeGreaterThan(e.width / 2 + e.sidewalk);
        }
      }
      // The plaza is open concrete with no building, and the landmark is solid where it stands.
      const px = m.params.cx + m.params.ux * 22;
      const pz = m.params.cz + m.params.uz * 22;
      expect(w.surfaceAt(px, pz)).toBe('concrete');
      expect(w.areaAt(px, pz)?.kind).toBe('monument');
      expect(w.blocks.buildings.some((b) => pointInPolygon(b.x, b.z, m.polygon))).toBe(false);
      if (m.variant === 'arch') {
        expect(w.collideCircle(m.params.cx, m.params.cz, MON.archGap / 2 - 0.6, contacts)).toBe(0);
        const vx = -m.params.uz;
        const vz = m.params.ux;
        const off = MON.archGap / 2 + MON.pierWidth / 2;
        expect(w.collideCircle(m.params.cx + vx * (off + MON.pierWidth / 2 + 0.3), m.params.cz + vz * (off + MON.pierWidth / 2 + 0.3), 0.6, contacts)).toBeGreaterThan(0);
      } else {
        const r = MON.base + MON.steps;
        expect(w.collideCircle(m.params.cx + r + 0.3, m.params.cz, 0.6, contacts)).toBeGreaterThan(0);
      }
      const mine = w.props.filter((p) => p.area === m.id);
      expect(mine.some((p) => p.kind === 'planterPot')).toBe(true);
      expect(mine.some((p) => p.kind === 'bench')).toBe(true);
      for (const p of mine) expect(distToPolygonEdge(p.x, p.z, m.polygon)).toBeGreaterThan(1);
    }
    expect(seen).toBeGreaterThan(6);
    expect(kinds.size).toBeGreaterThan(1);
    expect(WALL_LOOKS).toContain('monument');
  });
});

describe('special districts share', () => {
  /**
   * Two views of how much of the city is not plain downtown: by street
   * length (an edge counts as special when a district claims it, it is a
   * bridge or a roundabout spoke, its block is claimed, or its middle lies in
   * or within 20 m of a special area's polygon: the hills' slopes, parks, the
   * channel, alleys), and by block area (sample points inside interior
   * blocks whose areaAt is not downtown or infill). Medians over seeds.
   */
  it('keeps downtown to roughly half the streets', () => {
    const rng = new Rng(12);
    const streets: number[] = [];
    const blocks: number[] = [];
    for (let i = 0; i < 16; i++) {
      const c = createCity(rng.int(0, 0x7fffffff));
      const special = c.districts.areas.filter((a) => a.kind !== 'downtown' && a.kind !== 'infill' && a.polygon.length > 2);
      const claimedEdge = new Set<number>();
      for (const a of special) {
        for (const e of a.edges) claimedEdge.add(e);
        for (const f of a.faces) for (const e of c.blocks.faces[f].edges) claimedEdge.add(e);
      }
      const g = c.graph;
      let specialLen = 0;
      let totalLen = 0;
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        const mx = (a.x + b.x) / 2;
        const mz = (a.z + b.z) / 2;
        totalLen += e.length;
        let s = claimedEdge.has(e.id) || !!e.bridge || !!a.ring || !!b.ring;
        if (!s) s = special.some((sp) => pointInPolygon(mx, mz, sp.polygon) || distToPolygonEdge(mx, mz, sp.polygon) < 20);
        if (s) specialLen += e.length;
      }
      streets.push(specialLen / totalLen);
      let sp = 0;
      let tot = 0;
      for (const f of c.blocks.faces) {
        if (f.outer) continue;
        const xs = f.ring.map((p) => p.x);
        const zs = f.ring.map((p) => p.z);
        for (let x = Math.min(...xs) + 4; x < Math.max(...xs); x += 8) {
          for (let z = Math.min(...zs) + 4; z < Math.max(...zs); z += 8) {
            if (!pointInPolygon(x, z, f.ring)) continue;
            tot++;
            const a = c.districts.areaAt(x, z);
            if (a && a.kind !== 'downtown' && a.kind !== 'infill') sp++;
          }
        }
      }
      blocks.push(sp / tot);
    }
    streets.sort((a, b) => a - b);
    blocks.sort((a, b) => a - b);
    const median = (v: number[]) => v[v.length >> 1];
    expect(median(streets)).toBeGreaterThan(0.3);
    expect(median(streets)).toBeLessThan(0.62);
    expect(median(blocks)).toBeGreaterThan(0.12);
  });
});
