import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { Rng } from '../src/sim/prng';
import { createWorld, planRoads } from '../src/city/world';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { createTerrain } from '../src/city/terrain';
import { toWorld } from '../src/city/districts/structures';
import { floorHalf, kickerFlight, trenchProfile, undergroundHeight, undergroundLayout, undergroundShape } from '../src/city/districts/undergroundShape';
import type { Area } from '../src/city/districts/types';

const CFG = CITY.districts.underground;

/** The next `n` Underground days from 2026-11-01. */
function undergroundSeeds(n: number): number[] {
  return weekendSeeds({ year: 2026, month: 11, dayOfMonth: 1 }, n * 4).filter((s) => weekendOf(s)?.kind === 'underground').slice(0, n);
}

const SEEDS = undergroundSeeds(20);

describe('the Underground', () => {
  it('plans one trench on at least 18 of the next 20 Underground days, and the routes take it', () => {
    let planned = 0;
    let bothRoutes = 0;
    for (const seed of SEEDS) {
      const { districts, event } = planRoads(seed);
      const areas = districts.areas.filter((a) => a.kind === 'underground');
      expect(areas.length, `seed ${seed}`).toBeLessThanOrEqual(1);
      const a = areas[0];
      if (!a) continue;
      // The menu names the special exactly when the trench is built (resolveEvent).
      expect(event.special?.kind, `seed ${seed}`).toBe(a.params.planned ? 'underground' : undefined);
      if (!a.params.planned) continue;
      planned++;
      expect(a.polygon.length).toBeGreaterThanOrEqual(4);
      expect(a.faces.length).toBe(2);
      if (a.params.driven0 && a.params.driven1) bothRoutes++;
    }
    expect(planned).toBeGreaterThanOrEqual(18);
    expect(bothRoutes).toBeGreaterThanOrEqual(16);
  });

  it('never promises a special it does not build (20270905: a bluff planned after the carve stands on the site)', () => {
    const { districts, event } = planRoads(20270905);
    const a = districts.areas.find((x) => x.kind === 'underground');
    expect(a?.params.planned ? event.special?.kind === 'underground' : event.special === undefined).toBe(true);
    // An unplanned area is a claim holder only: no polygon for the corridor rule to match, nothing built.
    if (a && !a.params.planned) {
      expect(a.polygon.length).toBe(0);
      expect(a.faces.length).toBe(0);
    }
    // And on every seed of the sweep a special is named exactly when its area is planned.
    for (const seed of SEEDS) {
      const r = planRoads(seed);
      const u = r.districts.areas.find((x) => x.kind === 'underground');
      expect(r.event.special !== undefined, `seed ${seed}`).toBe(!!u?.params.planned);
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
      expect(graph.edges.some((e) => e.trench)).toBe(false);
    }
  });

  it('digs the floor 5 m down mid-run, ramps at most 11%, and never starts a grid or a finish line in the trench', () => {
    for (const seed of SEEDS.slice(0, 4)) {
      const { districts, graph, routeNodes } = planRoads(seed);
      const a = districts.areas.find((x) => x.kind === 'underground' && x.params.planned);
      if (!a) continue;
      const s = undergroundShape(a);
      const lay = undergroundLayout(s);
      const out = { h: 0, hu: 0, hv: 0 };
      // The axis: deep on the floor, never steeper than a ramp.
      expect(trenchProfile(s, lay.window, 0, 0, out).h).toBeLessThanOrEqual(-4.5);
      let steepest = 0;
      for (let u = -s.top; u <= s.top; u += 0.5) {
        trenchProfile(s, lay.window, u, 0, out);
        steepest = Math.max(steepest, Math.abs(out.hu));
        if (Math.abs(u) > floorHalf(s) + 0.5) expect(Math.abs(out.hu), `seed ${seed} u ${u}`).toBeLessThanOrEqual(0.11);
        expect(out.h).toBeLessThanOrEqual(1e-9);
      }
      expect(steepest).toBeGreaterThan(0.08);
      // The pieces are flagged, so no start grid or finish line is laid on them: the circuit's start is not on the run.
      expect(a.edges.every((e) => graph.edges[e].trench === true)).toBe(true);
      expect(routeNodes.circuit.length).toBeGreaterThan(3);
    }
  });

  it('keeps every slope in step with its height, kicker, rubble and plinth included', () => {
    const rng = new Rng(77);
    for (const seed of SEEDS.slice(0, 3)) {
      const { districts } = planRoads(seed);
      const a = districts.areas.find((x) => x.kind === 'underground' && x.params.planned) as Area;
      const s = undergroundShape(a);
      const lay = undergroundLayout(s);
      const e = 0.001;
      const h = (x: number, z: number) => {
        const o = { h: 0, gx: 0, gz: 0 };
        undergroundHeight(s, lay, x, z, o);
        return o;
      };
      let checked = 0;
      for (let k = 0; k < 4000; k++) {
        // Anywhere in the box, but half of the samples near the kicker and the window where the shapes are busy.
        const near = k % 2 === 0;
        const u = near ? (k % 4 === 0 ? lay.lip.x - rng.range(0, 12) : lay.window + rng.range(-19, 19)) : rng.range(-s.top, s.top);
        const v = near && k % 4 !== 0 ? s.sd * rng.range(s.road - 0.5, s.road + CFG.demolished.run + 0.5) : rng.range(-s.road - 4, s.road + 4);
        const p = toWorld(s, u, v);
        const o = h(p.x, p.z);
        const gx = (h(p.x + e, p.z).h - h(p.x - e, p.z).h) / (2 * e);
        const gz = (h(p.x, p.z + e).h - h(p.x, p.z - e).h) / (2 * e);
        // Kinks (the kicker's lip, the lip of the rubble) may disagree on a hair; compare away from them.
        if (Math.abs(o.gx - gx) > 2e-3 || Math.abs(o.gz - gz) > 2e-3) {
          const probe = (d: number) => Math.abs(h(p.x + d, p.z).h - o.h - o.gx * d);
          expect(probe(1e-4), `seed ${seed} u ${u} v ${v}`).toBeLessThan(2e-3);
        }
        checked++;
      }
      expect(checked).toBe(4000);
    }
  });

  it('builds the walls, floor and service roads on the terrain the world drives', () => {
    const seed = SEEDS[0];
    const w = createWorld(seed, 'circuit');
    const a = w.areas.find((x) => x.kind === 'underground' && x.params.planned) as Area;
    const s = undergroundShape(a);
    const lay = undergroundLayout(s);
    const base = createTerrain(w.seed);
    const rel = (u: number, v: number) => {
      const p = toWorld(s, u, v);
      return w.heightAt(p.x, p.z) - base.heightAt(p.x, p.z);
    };
    // Mid-run the floor is the depth down, the service roads at grade, the surfaces say which is which.
    expect(rel(lay.bus.x + 9, 0)).toBeLessThanOrEqual(-4.5);
    const mid = s.road + CFG.plinth + CFG.service / 2;
    const at = (u: number, v: number) => toWorld(s, u, v);
    for (const side of [1, -1]) {
      expect(Math.abs(rel(-60, side * mid))).toBeLessThan(0.05);
      expect(w.surfaceAt(at(-60, side * mid).x, at(-60, side * mid).z)).toBe('road');
    }
    expect(w.surfaceAt(at(lay.bus.x + 9, 0).x, at(lay.bus.x + 9, 0).z)).toBe('concrete');
    // The kicker lip stands CFG.kicker.lip over the floor and its grade is within the config.
    const K = CFG.kicker;
    const tip = rel(lay.lip.x - lay.heading.x * 0.3, lay.lip.z - lay.heading.z * 0.3);
    expect(tip - rel(lay.foot.x - lay.heading.x * 6, lay.foot.z - lay.heading.z * 6)).toBeGreaterThan(K.lip - 0.4);
    let grade = 0;
    for (let d = 0.5; d < lay.kickLength; d += 0.25) {
      const p = toWorld(s, lay.foot.x + lay.heading.x * d, lay.foot.z + lay.heading.z * d);
      const q = toWorld(s, lay.foot.x + lay.heading.x * (d + 0.25), lay.foot.z + lay.heading.z * (d + 0.25));
      grade = Math.max(grade, (w.heightAt(q.x, q.z) - w.heightAt(p.x, p.z)) / 0.25);
    }
    expect(grade).toBeLessThanOrEqual(K.grade * 1.01 + 0.03);
    expect(grade).toBeGreaterThanOrEqual(K.grade * 0.95 - 0.03);
    // Every plinth, flank, bus and vehicle is a drawn trenchWall; the plinths and flanks are flown over.
    const walls = w.walls.filter((x) => x.look === 'trenchWall');
    expect(walls.length).toBeGreaterThan(100);
    expect(walls.filter((x) => x.top !== undefined).length).toBeGreaterThan(50);
    // The window: no plinth on the demolished side between its ends.
    for (const x of walls) {
      if (x.top === undefined) continue;
      const mx = (x.ax + x.bx) / 2;
      const mz = (x.az + x.bz) / 2;
      const du = (mx - s.cx) * s.ux + (mz - s.cz) * s.uz;
      const dv = -(mx - s.cx) * s.uz + (mz - s.cz) * s.ux;
      if (dv * s.sd > 0 && dv * s.sd < s.road + CFG.plinth + 0.01 && dv * s.sd > s.road - 0.01) expect(Math.abs(du - lay.window)).toBeGreaterThan(CFG.demolished.half - 0.01);
    }
  });

  it('lands a 40 m/s kicker jump on the service road across the street, clear of solids and props', () => {
    const seed = SEEDS[0];
    const w = createWorld(seed, 'circuit');
    const a = w.areas.find((x) => x.kind === 'underground' && x.params.planned) as Area;
    const s = undergroundShape(a);
    const lay = undergroundLayout(s);
    const K = CFG.kicker;
    const f = kickerFlight(lay, 40);
    // About 12 m/s up and a 7 m apex over the floor (the lip is `lip` over it: the apex over grade is less).
    expect(40 * K.grade).toBeGreaterThan(11);
    expect(f.apex + CFG.depth).toBeGreaterThan(6);
    // The throw is toward the other side, and it lands inside the far service road.
    expect(f.land.z * s.sd).toBeLessThan(0);
    const inner = s.road + CFG.plinth;
    expect(Math.abs(f.land.z)).toBeGreaterThan(inner + 0.5);
    expect(Math.abs(f.land.z)).toBeLessThan(inner + CFG.service);
    // It clears the plinth (kerb over grade) where it crosses it.
    const tCross = (inner - Math.abs(lay.lip.z)) / Math.abs(40 * lay.heading.z);
    const y = CFG.kicker.lip - CFG.depth + 40 * K.grade * tCross - 4.905 * tCross * tCross;
    expect(y).toBeGreaterThan(CFG.kerb);
    // Nothing stands in the landing: no solid (the plinth is flown over) and no prop within the width plus margin.
    const reachU = 6;
    const reachV = K.width / 2 + K.landMargin;
    const inLanding = (x: number, z: number, r: number) => {
      const du = (x - s.cx) * s.ux + (z - s.cz) * s.uz - f.land.x;
      const dv = -(x - s.cx) * s.uz + (z - s.cz) * s.ux - f.land.z;
      return Math.abs(du) < reachU + r && Math.abs(dv) < reachV + r;
    };
    for (const x of w.walls) {
      if (x.look !== 'trenchWall' || x.top !== undefined) continue;
      // The hoarding (the service road's outer edge) is the landing's far boundary, not something in it.
      if (Math.abs(-(x.ax - s.cx) * s.uz + (x.az - s.cz) * s.ux) > inner + CFG.service) continue;
      expect(inLanding(x.ax, x.az, 0), `solid in the landing ${JSON.stringify({ u: (x.ax - s.cx) * s.ux + (x.az - s.cz) * s.uz, v: -(x.ax - s.cx) * s.uz + (x.az - s.cz) * s.ux, land: f.land })}`).toBe(false);
    }
    for (const p of w.props) if (p.area === a.id) expect(inLanding(p.x, p.z, p.radius), `${p.kind} in the landing`).toBe(false);
  });
});
