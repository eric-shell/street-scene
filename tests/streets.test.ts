import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import type { Contact, World } from '../src/city/world';
import type { Solid } from '../src/city/blocks';
import { CITY } from '../src/city/config';
import { createRace, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { distToSegment } from '../src/sim/math';
import { pointInPolygon } from '../src/city/districts/geom';
import { carSnapshot, input, raceConfig } from './helpers';

/** Distance from (x, z) to a solid's outline. */
function toOutline(s: Solid, x: number, z: number): number {
  return Math.min(...s.faces.map((f) => distToSegment(x, z, f.ax, f.az, f.bx, f.bz)));
}

describe('small solids', () => {
  it('push a car out of tree trunks, El pillars and stairs and plaza fountains, never through them', () => {
    const looks = new Set<string>();
    const out: Contact[] = [];
    for (const seed of [1, 42]) {
      const w = createWorld(seed, 'circuit');
      const done = new Set<Solid>();
      for (const wall of w.blocks.walls) {
        const s = wall.solid;
        // Car park parapets are long slabs meeting at their corners (a probe there touches both): carPark.test.ts covers them.
        if (!s || done.has(s) || wall.look === 'carPark') continue;
        done.add(s);
        looks.add(wall.look!);
        const cx = s.faces.reduce((t, f) => t + f.ax, 0) / s.faces.length;
        const cz = s.faces.reduce((t, f) => t + f.az, 0) / s.faces.length;
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          // Out from the middle to the outline, then a 0.9 m car circle overlapping it by 0.15 m or more.
          let t = 0;
          while (s.faces.every((f) => (cx + dx * t - f.ax) * f.nx + (cz + dz * t - f.az) * f.nz < 0)) t += 0.01;
          const x = cx + dx * (t + 0.75);
          const z = cz + dz * (t + 0.75);
          const n = w.collideCircle(x, z, 0.9, out);
          const mine = out.slice(0, n).filter((c) => toOutline(s, c.px, c.pz) < 0.01);
          expect(mine.length, `${wall.look} seed ${seed}`).toBe(1);
          // Pushed back out (not toward the far side) and by no more than the overlap.
          expect(mine[0].nx * dx + mine[0].nz * dz).toBeGreaterThan(0);
          expect(mine[0].depth).toBeLessThanOrEqual(0.9);
        }
      }
    }
    expect(looks.has('tree')).toBe(true);
    expect(looks.has('pillar')).toBe(true);
  });

  it('stop a car that drives into a park tree on the side it came from, from any direction', () => {
    const w = createWorld(1, 'circuit', undefined, { openWorld: true });
    const trunks = [...new Set(w.blocks.walls.filter((x) => x.look === 'tree').map((x) => x.solid!))];
    let runs = 0;
    for (const s of trunks.slice(0, 6)) {
      const cx = s.faces.reduce((t, f) => t + f.ax, 0) / s.faces.length;
      const cz = s.faces.reduce((t, f) => t + f.az, 0) / s.faces.length;
      // Trunks on level ground: on a park mound's steep flank a car slides around the trunk or rolls
      // back short (which trunks the first parks have depends on everything planned before them).
      const sl = w.slopeAt(cx, cz);
      if (Math.hypot(sl.gx, sl.gz) > 0.08) continue;
      for (let k = 0; k < 16; k++) {
        const d = { x: Math.cos((k * Math.PI) / 8), z: Math.sin((k * Math.PI) / 8) };
        // A clear run up of 10 m toward the trunk: no wall, and no lamp post or bench to turn the car aside first.
        const clear = (x: number, z: number) => w.wallClearance(x, z, 2.2) >= 2.2 && !w.props.some((p) => Math.hypot(p.x - x, p.z - z) < p.radius + 2.2);
        if (![3.5, 5, 7, 9, 11, 13].every((o) => clear(cx + d.x * o, cz + d.z * o))) continue;
        runs++;
        const r = createRace({ ...raceConfig(1, 'circuit', 0), openWorld: true }, w);
        r.tick = r.countdownTicks;
        const c = r.cars[0].state;
        placeCar(c, cx + d.x * 10, cz + d.z * 10, Math.atan2(-d.x, -d.z), w);
        c.vx = -d.x * 12;
        c.vz = -d.z * 12;
        for (let i = 0; i < 90; i++) {
          stepRace(r, input({ throttle: 0.6 }));
          // Never shoved through to the far side, not even for a tick.
          expect((c.x - cx) * d.x + (c.z - cz) * d.z, `trunk at ${cx.toFixed(0)},${cz.toFixed(0)} from ${k * 22.5} deg`).toBeGreaterThan(0);
        }
        const hit = Math.hypot(c.x - cx, c.z - cz);
        for (let i = 0; i < 150; i++) stepRace(r, input({ brake: 1 }));
        expect(Math.hypot(c.x - cx, c.z - cz)).toBeGreaterThan(hit + 2);
      }
    }
    expect(runs).toBeGreaterThan(10);
  });
});

/** driveHeightAt over the terrain. */
const lift = (w: World, x: number, z: number) => w.driveHeightAt(x, z) - w.heightAt(x, z);

describe('curbs', () => {
  it('lift wheels by the curb height on sidewalks and roundabout rings, eased across the curb', () => {
    const w = createWorld(11, 'circuit', undefined, { openWorld: true });
    const g = w.graph;
    let streets = 0;
    for (const e of g.edges) {
      if (e.kind !== 'street' || e.length < 100 || e.bridge || e.shortcut || streets >= 20) continue;
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const ux = (B.x - A.x) / e.length;
      const uz = (B.z - A.z) / e.length;
      const at = (o: number) => ({ x: (A.x + B.x) / 2 - uz * o, z: (A.z + B.z) / 2 + ux * o });
      const walk = at(e.width / 2 + e.sidewalk / 2);
      if (w.surfaceAt(walk.x, walk.z) !== 'sidewalk' || w.areaAt(walk.x, walk.z)) continue;
      streets++;
      expect(lift(w, at(0).x, at(0).z)).toBe(0);
      expect(lift(w, at(e.width / 2 - 0.5).x, at(e.width / 2 - 0.5).z)).toBe(0);
      expect(lift(w, walk.x, walk.z)).toBeCloseTo(CITY.curbHeight, 9);
      // Rising, never stepping, across the curb.
      let prev = 0;
      for (let o = e.width / 2 - CITY.curbRamp.road - 0.05; o <= e.width / 2 + CITY.curbRamp.walk + 0.05; o += 0.02) {
        const l = lift(w, at(o).x, at(o).z);
        expect(l).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(l - prev).toBeLessThan(CITY.curbHeight * 0.2);
        prev = l;
      }
    }
    expect(streets).toBeGreaterThan(10);
    const rings = w.areas.filter((a) => a.kind === 'roundabout');
    expect(rings.length).toBeGreaterThan(0);
    for (const a of rings) {
      const { x, z, outer, island } = a.params;
      for (let k = 0; k < 12; k++) {
        const c = Math.cos((k * Math.PI) / 6);
        const s = Math.sin((k * Math.PI) / 6);
        const rr = (outer + island) / 2;
        expect(lift(w, x + c * rr, z + s * rr)).toBe(0);
        const rw = outer + CITY.sidewalk / 2;
        if (w.surfaceAt(x + c * rw, z + s * rw) === 'sidewalk') expect(lift(w, x + c * rw, z + s * rw)).toBeCloseTo(CITY.curbHeight, 9);
      }
    }
  });

  it('carry a car up onto the sidewalk, the same way every time', () => {
    const w = createWorld(11, 'circuit', undefined, { openWorld: true });
    const g = w.graph;
    const e = g.edges.filter((x) => x.kind === 'street' && x.length > 130 && !x.bridge && !x.shortcut).sort((a, b) => b.length - a.length)[3];
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const ux = (B.x - A.x) / e.length;
    const uz = (B.z - A.z) / e.length;
    const side = (c: { x: number; z: number }) => (c.x - (A.x + B.x) / 2) * -uz + (c.z - (A.z + B.z) / 2) * ux;
    const run = () => {
      const r = createRace({ ...raceConfig(11, 'circuit', 0), openWorld: true }, w);
      r.tick = r.countdownTicks;
      const c = r.cars[0].state;
      // Settled on the road 3 m inside the left curb, then across it at 40 degrees until the whole car
      // is over it, then stopped and settled on the sidewalk.
      const a = (40 * Math.PI) / 180;
      const dx = ux * Math.cos(a) - uz * Math.sin(a);
      const dz = uz * Math.cos(a) + ux * Math.sin(a);
      placeCar(c, (A.x + B.x) / 2 - uz * (e.width / 2 - 3), (A.z + B.z) / 2 + ux * (e.width / 2 - 3), Math.atan2(dx, dz), w);
      for (let i = 0; i < 60; i++) stepRace(r, input({}));
      const onRoad = c.y - w.heightAt(c.x, c.z);
      for (let i = 0; i < 240 && side(c) < e.width / 2 + 1.8; i++) stepRace(r, input({ throttle: 0.25 }));
      for (let i = 0; i < 90; i++) stepRace(r, input({ brake: 1 }));
      return { r, onRoad, onWalk: c.y - w.heightAt(c.x, c.z), surface: w.surfaceAt(c.x, c.z) };
    };
    const one = run();
    const two = run();
    expect(one.surface).toBe('sidewalk');
    // Up by about the curb: riding on the paving, not sunk into it.
    expect(one.onWalk - one.onRoad).toBeGreaterThan(CITY.curbHeight * 0.6);
    expect(one.onWalk - one.onRoad).toBeLessThan(CITY.curbHeight * 1.6);
    expect(carSnapshot(two.r)).toBe(carSnapshot(one.r));
  });
});

describe('shortcut mouths', () => {
  it('flare into funnels: asphalt out to curved curbs, a raised sidewalk round them, cones lining them', () => {
    let mouths = 0;
    let cones = 0;
    for (const seed of [3, 99, 2024]) {
      const w = createWorld(seed, 'circuit');
      const g = w.graph;
      for (const area of w.areas) {
        if (area.kind !== 'backAlley') continue;
        const alley = g.edges[area.edges[0]];
        for (const nid of area.nodes) {
          const n = g.nodes[nid];
          const secs = w.blocks.sectors[nid];
          const k = n.edges.indexOf(alley.id);
          const m = n.edges.length;
          const cw = secs[(k - 1 + m) % m];
          const ccw = secs[k];
          expect(cw.flared && ccw.flared).toBe(true);
          mouths++;
          // The funnel's opening on the street's curb line is several alleys wide.
          const a = cw.curb[0];
          const b = ccw.curb[ccw.curb.length - 1];
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(alley.width * 2.5);
          for (const [sec, street] of [
            [cw, g.edges[n.edges[(k - 1 + m) % m]]],
            [ccw, g.edges[n.edges[(k + 1) % m]]],
          ] as const) {
            // Never past the middle of the street edge it flares along.
            const end = sec === cw ? sec.curb[0] : sec.curb[sec.curb.length - 1];
            expect(Math.hypot(end.x - n.x, end.z - n.z)).toBeLessThan(street.length / 2 + street.width / 2);
            // Asphalt just inside the curved curb, raised sidewalk between it and the building line.
            const i = sec.curb.length >> 1;
            const c = sec.curb[i];
            const o = sec.outer[i];
            const l = Math.hypot(c.x - o.x, c.z - o.z);
            const inX = c.x + ((c.x - o.x) / l) * 1;
            const inZ = c.z + ((c.z - o.z) / l) * 1;
            expect(w.surfaceAt(inX, inZ)).toBe('road');
            expect(lift(w, inX, inZ)).toBe(0);
            const wx = (c.x + o.x) / 2;
            const wz = (c.z + o.z) / 2;
            expect(w.surfaceAt(wx, wz)).toBe('sidewalk');
            expect(lift(w, wx, wz)).toBeGreaterThan(CITY.curbHeight * 0.5);
          }
        }
        // Everything the alley put down, the funnel cones included, lies in its area.
        for (const p of w.props) {
          if (p.area !== area.id) continue;
          expect(pointInPolygon(p.x, p.z, area.polygon)).toBe(true);
          if (area.variant === 'routeShortcut' && p.kind === 'trafficCone' && w.areaAt(p.x, p.z)?.id === area.id && w.surfaceAt(p.x, p.z) === 'road') cones++;
        }
      }
    }
    expect(mouths).toBeGreaterThan(20);
    expect(cones).toBeGreaterThan(mouths);
  });
});
