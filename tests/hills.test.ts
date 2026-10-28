import { describe, expect, it } from 'vitest';
import { CITY, ROAD_PHYSICS, ROUTE } from '../src/city/config';
import { ROAD } from '../src/sim/tuning';
import { createCity, createWorld } from '../src/city/world';
import { raceConfig, runAutopilot } from './helpers';
import { Rng, deriveSeed } from '../src/sim/prng';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { distToSegment } from '../src/sim/math';
import { hillAt, hillOutline, plateauDistance, shapeOf } from '../src/city/districts/hills';
import { TOUR_REACH, plazaPasses } from '../src/city/districts/monument';
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
    let short = 0;
    for (let i = 0; i < 24; i++) {
      const c = createCity(rng.int(0, 0x7fffffff));
      const hs = c.districts.areas.filter((a) => a.kind === 'hills');
      // The river across the whole map, the El and a bluff (on about four cities in ten) leave some cities room for one cluster only.
      expect(hs.length).toBeGreaterThanOrEqual(1);
      if (hs.length < HILLS.count[0]) short++;
      expect(hs.length).toBeLessThanOrEqual(HILLS.count[1]);
      // San Francisco's stepped hill has a test of its own (below).
      for (const h of hs.filter((x) => x.variant !== 'terraced')) {
        // A Hill Climb's hill that does not fit as a cluster stands on its route block alone (hills.ts).
        expect(h.faces.length).toBeGreaterThanOrEqual(c.event.drawn === 'hillClimb' ? 1 : HILLS.blocks[0]);
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
        if (!hs.some((h) => h.variant !== 'terraced' && pointInPolygon(mx, mz, h.polygon))) continue;
        if (hs.some((h) => h.variant === 'terraced' && pointInPolygon(mx, mz, h.polygon))) continue;
        let edgeMax = 0;
        for (let t = 0.02; t <= 0.98; t += 0.04) {
          const sl = c.terrain.slopeAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
          edgeMax = Math.max(edgeMax, Math.hypot(sl.gx, sl.gz));
        }
        worst = Math.max(worst, edgeMax);
        steepest = Math.max(steepest, edgeMax);
      }
    }
    expect(short).toBeLessThanOrEqual(4);
    // ...and what a street's crown adds along its centreline as it eases in past a junction (the steepest part of the smoothstep is 1.5 x the rise over the ramp).
    const crownFade = (1.5 * Math.max(ROAD.crownStreet, ROAD.crownAvenue, ROAD.crownDiagonal, ROAD.crownBoulevard) * CITY.width.boulevard) / 2 / ROAD_PHYSICS.crown.junctionRamp;
    expect(worst).toBeLessThan(HILLS.maxGrade + 0.056 + 0.005 + crownFade);
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

  it('San Francisco: now and then one hill steps down from a summit junction, every junction level, the streets between steep', () => {
    const TER = HILLS.terraced;
    const rng = new Rng(57);
    const out = { h: 0, gx: 0, gz: 0 };
    const at = (s: ReturnType<typeof shapeOf>, x: number, z: number) => {
      out.h = out.gx = out.gz = 0;
      hillAt(s, x, z, out);
      return { h: out.h, gx: out.gx, gz: out.gz };
    };
    // The ramps' grade: the step over the block less both tables and an ease.
    const cap = TER.step[1] / (CITY.spacing - 2 * TER.flat - TER.ease);
    let found = 0;
    let rolled = 0;
    let tried = 0;
    for (let i = 0; i < 160 && found < 3; i++) {
      const seed = rng.int(0, 0x7fffffff);
      tried++;
      if (!new Rng(deriveSeed(seed, 'district:hills:terraced')).chance(TER.chance)) continue;
      rolled++;
      const c = createCity(seed);
      const ts = c.districts.areas.filter((a) => a.kind === 'hills' && a.variant === 'terraced');
      expect(ts.length).toBeLessThanOrEqual(1);
      if (!ts.length) continue;
      found++;
      const t = ts[0];
      const s = shapeOf(t);
      expect(s.h).toBeGreaterThanOrEqual(TER.tiers * TER.step[0] - 1e-9);
      expect(at(s, s.cx, s.cz).h).toBeCloseTo(s.h, 6);
      // C1 with an exact gradient through the warp, and never past the ramps' grade.
      for (let k = 0; k < 120; k++) {
        const x = s.cx + rng.range(-1.6 * s.w, 1.6 * s.w);
        const z = s.cz + rng.range(-1.6 * s.w, 1.6 * s.w);
        const v = at(s, x, z);
        const e = 0.01;
        expect(Math.abs(v.gx - (at(s, x + e, z).h - at(s, x - e, z).h) / (2 * e))).toBeLessThan(2e-4);
        expect(Math.abs(v.gz - (at(s, x, z + e).h - at(s, x, z - e).h) / (2 * e))).toBeLessThan(2e-4);
        expect(Math.hypot(v.gx, v.gz)).toBeLessThan(cap * 1.12);
      }
      // Every grid junction on it stands level, on the summit's table or a ring's, and its blocks keep their buildings.
      let junctions = 0;
      for (const n of c.graph.nodes) {
        if (n.gi < 0 || plateauDistance(s, n.x, n.z).d > s.w) continue;
        junctions++;
        const v = at(s, n.x, n.z);
        expect(Math.hypot(v.gx, v.gz), `seed ${seed} junction ${n.id}`).toBe(0);
      }
      expect(junctions).toBeGreaterThanOrEqual(9);
      expect(c.blocks.buildings.some((b) => pointInPolygon(b.x, b.z, t.polygon))).toBe(true);
      // Nothing out past its last ramp.
      for (const p of hillOutline(s, s.w * 1.8)) expect(at(s, p.x, p.z).h).toBe(0);
    }
    expect(found).toBeGreaterThanOrEqual(2);
    // Now and then: the roll passes on some seeds only (a rolled seed may also fail to find room, but need not).
    expect(rolled).toBeGreaterThanOrEqual(found);
    expect(tried).toBeGreaterThan(rolled);
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
      // The reach is measured from downtown's centre, wherever the seed's plan put it (not the grid's middle).
      const cx0 = g.plan.downtown.x;
      const cz0 = g.plan.downtown.z;
      // A Grand Tour puts the plaza on a block its routes pass, further out (monument.ts TOUR_REACH), and so does
      // a race pass, whose landmark stands at the middle of the pass's chord, off the block's middle.
      expect(Math.hypot(m.params.cx - cx0, m.params.cz - cz0)).toBeLessThanOrEqual(m.params.passes ? TOUR_REACH + 80 : (w.event.drawn === 'grandTour' ? TOUR_REACH : MON.reach) + 1);
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
      // Probed 22 m from the landmark the roomiest way (a pass may have set it off the block's middle).
      const probes = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ x: m.params.cx + Math.cos((k * Math.PI) / 4) * 22, z: m.params.cz + Math.sin((k * Math.PI) / 4) * 22 }));
      const probe = probes.reduce((p, q) => (distToPolygonEdge(q.x, q.z, m.polygon) * (pointInPolygon(q.x, q.z, m.polygon) ? 1 : -1) > distToPolygonEdge(p.x, p.z, m.polygon) * (pointInPolygon(p.x, p.z, m.polygon) ? 1 : -1) ? q : p));
      const px = probe.x;
      const pz = probe.z;
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

  it('races by the plaza cross it, round a corner or across the block onto another street: round the steps or through the arch, clear of the walls and the clutter', () => {
    const rng = new Rng(5);
    let crossings = 0;
    const kinds = new Set<string>();
    const shapes = new Set<number>();
    for (let i = 0; i < 90 && crossings < 8; i++) {
      const city = createCity(rng.int(0, 0x7fffffff));
      const m = city.districts.areas.find((a) => a.kind === 'monument');
      if (!m || !m.params.passes) continue;
      const passes = plazaPasses(city.graph, m);
      expect(passes.length).toBe(m.params.passes);
      for (let k = 0; k < m.params.passes; k++) shapes.add(m.params[`p${k}shape`]);
      passes.forEach((p, k) => {
        // Never off a street and back onto it, a cut a racer skips by driving straight on: it leaves one street and rejoins another.
        expect(p.edgeA).toBeGreaterThanOrEqual(0);
        expect(p.edgeA).not.toBe(p.edgeB);
        // A U cut (shape 1) runs straight past the landmark or through the arch: its start point is on its straight.
        if (m.params[`p${k}shape`] === 0) return;
        expect(p.start).toBeDefined();
        expect(p.start!.straight).toBeGreaterThan(10);
      });
      for (const kind of ['circuit', 'sprint'] as const) {
        const w = createWorld(city.seed, kind, city);
        const P = w.route.points;
        const on = P.filter((p) => pointInPolygon(p.x, p.z, m.polygon) && distToPolygonEdge(p.x, p.z, m.polygon) > 2);
        if (!on.length) continue;
        crossings++;
        kinds.add(m.variant);
        // Every metre of the line on the paving keeps half its width off the landmark's walls (and any other).
        for (let k = 0; k + 1 < P.length; k++) {
          const len = Math.hypot(P[k + 1].x - P[k].x, P[k + 1].z - P[k].z);
          for (let t = 0; t <= len; t += 1) {
            const x = P[k].x + ((P[k + 1].x - P[k].x) * t) / len;
            const z = P[k].z + ((P[k + 1].z - P[k].z) * t) / len;
            if (!pointInPolygon(x, z, m.polygon)) continue;
            expect(w.wallClearance(x, z, 10)).toBeGreaterThan(MON.passWidth / 2 - 1);
          }
        }
        // Through the arch: the line runs over the landmark's middle, between the piers.
        if (m.variant === 'arch') {
          let d = Infinity;
          for (let k = 0; k + 1 < P.length; k++) d = Math.min(d, distToSegment(m.params.cx, m.params.cz, P[k].x, P[k].z, P[k + 1].x, P[k + 1].z));
          expect(d).toBeLessThan(0.5);
        }
      }
      // Nothing of the plaza's clutter stands on a pass.
      for (const p of city.blocks.props.filter((q) => q.area === m.id)) {
        for (const ps of passes) for (let k = 0; k + 1 < ps.points.length; k++) expect(distToSegment(p.x, p.z, ps.points[k].x, ps.points[k].z, ps.points[k + 1].x, ps.points[k + 1].z)).toBeGreaterThan(MON.passWidth / 2);
      }
    }
    expect(crossings).toBeGreaterThanOrEqual(4);
    expect(kinds.size).toBeGreaterThan(1);
    // Corner passes occur, and nothing but corner passes and U cuts (rare: a route has to wrap the block).
    expect(shapes.has(0)).toBe(true);
    for (const sh of shapes) expect([0, 1]).toContain(sh);
  });

  it('a circuit may start on a pass: the line under the arch or beside the column, the grid on the paving clear of the walls, and the race runs', () => {
    // The draw is rare (ROUTE.passStartChance): force it for the seeds whose circuits take a pass straight enough.
    const knob = ROUTE as unknown as { passStartChance: number };
    const was = knob.passStartChance;
    knob.passStartChance = 1;
    try {
      let starts = 0;
      // About one seed in a hundred starts on one (seed 60 did until Harbor Run reshuffled the event draws; 145 and
      // 191 do now): the first is checked, since a city costs half a second and the scan runs well past a hundred.
      for (let seed = 0; seed < 240 && starts < 1; seed++) {
        const city = createCity(seed);
        const m = city.districts.areas.find((a) => a.kind === 'monument');
        if (!m?.params.passes) continue;
        const w = createWorld(seed, 'circuit', city);
        if (!w.route.passStart) continue;
        starts++;
        expect(w.route.startS).toBe(0);
        // The line at the landmark: on the arch's middle, or beside an obelisk or column.
        const S = w.route.points[0];
        const d = Math.hypot(S.x - m.params.cx, S.z - m.params.cz);
        if (m.variant === 'arch') expect(d).toBeLessThan(0.5);
        else expect(d).toBeLessThan(MON.base + MON.steps + MON.passWidth / 2 + 2);
        for (const g of w.route.grid) {
          expect(pointInPolygon(g.x, g.z, m.polygon)).toBe(true);
          expect(w.surfaceAt(g.x, g.z)).toBe('concrete');
          expect(w.collideCircle(g.x, g.z, 1.2, [], w.heightAt(g.x, g.z))).toBe(0);
        }
        // Behind the line the pass runs straight for the whole grid; the lap goes on from under the arch.
        const last = w.route.points[w.route.points.length - 2];
        expect(Math.hypot(last.x - S.x, last.z - S.z)).toBeGreaterThanOrEqual(ROUTE.gridFirstRow + 4 * ROUTE.gridRowSpacing);
        const r = runAutopilot(raceConfig(seed, 'circuit', 3), 420, true);
        for (const c of r.cars) expect(c.finished, `seed ${seed} ${c.name}`).toBe(true);
        expect(r.events.filter((e) => e.type === 'reset').length).toBeLessThanOrEqual(2);
      }
      // About one circuit in a hundred takes a pass straight enough (the routes vary with every city change).
      expect(starts).toBeGreaterThanOrEqual(1);
    } finally {
      knob.passStartChance = was;
    }
  }, 300000);
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
