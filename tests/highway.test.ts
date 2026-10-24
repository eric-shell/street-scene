import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { City, World } from '../src/city/world';
import { Rng } from '../src/sim/prng';
import { riverCenter } from '../src/city/districts/river';
import { polygonBounds, pointInPolygon } from '../src/city/districts/geom';
import { HIGHWAY_HALF, deckTopAt, deckUnderAt, highwayDeck } from '../src/city/districts/highway/shape';
import type { HighwayDeck } from '../src/city/districts/highway/shape';
import { highwayRolled } from '../src/city/districts/highway/line';
import { highwayGates } from '../src/city/districts/highway/settle';
import { axisAt, rampHeightAlong } from '../src/city/districts/highway/rampAxis';
import { curvePoint, projectOnCurve, sampleCurve } from '../src/city/railCurve';
import { elCurve } from '../src/city/districts/subway';
import { createRace, resetToStreet, stepRace } from '../src/sim/race';
import { GRAVITY } from '../src/sim/tuning';
import { clamp, sin, cos } from '../src/sim/math';
import type { Area } from '../src/city/districts/types';
import { input, raceConfig } from './helpers';

const CFG = CITY.districts.highway;

/** Seeds (from a stream) whose city plans a highway, planRoads only (cheap). */
function highwaySeeds(stream: number, want: number): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 200 && out.length < want; i++) {
    const seed = rng.int(0, 0x7fffffff);
    if (highwayRolled(seed)) out.push(seed);
  }
  return out;
}

const deckOf = (areas: readonly Area[]) => areas.find((a) => a.kind === 'highway' && a.variant === 'deck');

/** A few finished cities with a highway, and their open (free roam) worlds. */
const worlds: { city: City; world: World; deck: HighwayDeck }[] = (() => {
  return highwaySeeds(91, 3).map((seed) => {
    const city = createCity(seed);
    const world = createWorld(seed, 'circuit', city, { openWorld: true });
    return { city, world, deck: highwayDeck(deckOf(world.areas)!, world.areas) };
  });
})();

describe('elevated highway (plan)', () => {
  it('rolls on 60% of seeds from its own stream, and every seed that rolls it gets one', () => {
    const rng = new Rng(2026);
    let rolled = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (highwayRolled(rng.int(0, 0x7fffffff))) rolled++;
    expect(rolled / n).toBeGreaterThan(CFG.chance - 0.025);
    expect(rolled / n).toBeLessThan(CFG.chance + 0.025);
    // The roll is the plan's: a seed that rolls it is planned one (the planner always finds a line and
    // its ramps), one that does not has none.
    const seeds = new Rng(77);
    for (let i = 0; i < 24; i++) {
      const seed = seeds.int(0, 0x7fffffff);
      expect(!!deckOf(planRoads(seed).districts.areas), `seed ${seed}`).toBe(highwayRolled(seed));
    }
  });

  it('crosses the whole map along its rows, swinging once or twice, clear of the river, the same way every time', () => {
    for (const seed of highwaySeeds(5, 10)) {
      const plan = planRoads(seed);
      const areas = plan.districts.areas.filter((a) => a.kind === 'highway');
      const deck = deckOf(areas)!;
      const g = plan.graph;
      const p = deck.path;
      // West to east, from past one map edge to past the other.
      const xs = [p[0].x, p[p.length - 1].x].sort((a, b) => a - b);
      expect(xs[0]).toBeLessThan(g.bounds.minX);
      expect(xs[1]).toBeGreaterThan(g.bounds.maxX);
      expect(deck.params.swings).toBeLessThanOrEqual(CFG.swings[1]);
      const rows = Array.from({ length: CITY.gridW }, (_, i) => deck.params[`row${i}`]);
      for (let i = 1; i < rows.length; i++) if (rows[i] >= 0 && rows[i - 1] >= 0) expect(Math.abs(rows[i] - rows[i - 1])).toBeLessThanOrEqual(1);
      // Its deck clear of the river channel.
      for (const r of plan.districts.areas.filter((a) => a.kind === 'river')) {
        for (const q of p) {
          if (q.x < r.params.x0 || q.x > r.params.x1) continue;
          expect(Math.abs(q.z - riverCenter(r.params, q.x))).toBeGreaterThan(r.params.top + HIGHWAY_HALF);
        }
      }
      // Two to four ramps, each its own area on the deck's side.
      const ramps = areas.filter((a) => a.variant === 'ramp');
      expect(ramps.length).toBeGreaterThanOrEqual(CFG.ramps[0]);
      expect(ramps.length).toBeLessThanOrEqual(CFG.ramps[1]);
      for (const r of ramps) {
        expect(r.params.deck).toBe(deck.id);
        expect(r.params.grade).toBeLessThanOrEqual(CFG.rampGrade);
      }
      const again = planRoads(seed).districts.areas.filter((a) => a.kind === 'highway');
      expect(JSON.stringify(again)).toBe(JSON.stringify(areas));
    }
  });
});

describe('elevated highway (levels)', () => {
  it('puts a car on the deck or in the street under it by its height, with exact slopes up there', () => {
    expect(worlds.length).toBe(3);
    const P = curvePoint();
    for (const { world: w, deck: d } of worlds) {
      expect(d.settled).toBe(true);
      for (let s = d.sW + 15; s < d.sE - 15; s += 37) {
        sampleCurve(d.curve, s, P);
        for (const v of [-5, 0.8, 6]) {
          const x = P.x - P.tz * v;
          const z = P.z + P.tx * v;
          const ground = w.heightAt(x, z);
          const top = deckTopAt(d, s);
          // Well clear of the street: at least the clearance (the start gantry's 11.9 m fits under it).
          expect(deckUnderAt(d, s) - ground).toBeGreaterThan(11.9);
          expect(w.heightAt(x, z, top + 0.3)).toBeCloseTo(top, 1);
          expect(w.heightAt(x, z, ground + 0.3)).toBe(ground);
          expect(w.upperLevel(x, z, top)).toBe(true);
          expect(w.upperLevel(x, z, ground)).toBe(false);
          expect(w.surfaceAt(x, z, top)).toBe('road');
          // Up there the slope is the deck's.
          const sl = w.slopeAt(x, z, top);
          const e = 0.05;
          const gx = (w.heightAt(x + e, z, top) - w.heightAt(x - e, z, top)) / (2 * e);
          const gz = (w.heightAt(x, z + e, top) - w.heightAt(x, z - e, top)) / (2 * e);
          expect(Math.abs(sl.gx - gx) + Math.abs(sl.gz - gz)).toBeLessThan(0.02);
          // A gentle deck: no grade a car notices, no crest to fly off.
          expect(Math.hypot(sl.gx, sl.gz)).toBeLessThan(0.07);
        }
      }
    }
  });

  it('ramps climb from their mouth to the deck at a comfortable grade, flush at both ends, no launch at the crest', () => {
    for (const { world: w, deck: d } of worlds) {
      expect(d.ramps.length).toBeGreaterThanOrEqual(CFG.ramps[0]);
      expect(d.ramps.length).toBeLessThanOrEqual(CFG.ramps[1]);
      for (const r of d.ramps) {
        const ax = r.axis;
        const pr = r.profile;
        expect(pr.ready).toBe(true);
        expect(pr.grade).toBeLessThanOrEqual(CFG.rampGrade);
        expect(pr.grade).toBeGreaterThan(0.03);
        // Vertical curves: a car leaves the ground over a crest of curvature k at sqrt(g / k). The fastest a
        // car takes the ramp's turn (radius r at 1.6 g) plus a margin stays under that at the top; at the
        // foot the sag adds under 1 g at that speed (no bottoming out).
        const crest = Math.abs(pr.grade - pr.g1) / pr.e1;
        const sag = Math.abs(pr.grade - pr.g0) / pr.e0;
        const vTurn = Math.sqrt(1.6 * GRAVITY * ax.r) + 8;
        expect(Math.sqrt(GRAVITY / crest)).toBeGreaterThan(vTurn);
        expect((vTurn * vTurn * sag) / GRAVITY).toBeLessThan(1);
        // The world's surface along the axis is the profile, continuous, flush with the street at the mouth
        // and with the deck at the top.
        let prev = NaN;
        for (let u = 0.2; u <= ax.length; u += 0.5) {
          const q = axisAt(ax, u);
          const y = rampHeightAlong(ax, pr, u).y;
          const h = w.heightAt(q.x, q.z, y);
          if (u > pr.blend) expect(h).toBeCloseTo(y, 3);
          if (!Number.isNaN(prev)) expect(Math.abs(h - prev)).toBeLessThan(0.5 * (CFG.rampGrade + 0.02));
          prev = h;
        }
        const foot = axisAt(ax, 0.2);
        expect(Math.abs(w.heightAt(foot.x, foot.z, 0) - w.heightAt(foot.x, foot.z))).toBeLessThan(0.05);
        expect(Math.abs(rampHeightAlong(ax, pr, ax.length).y - deckTopAt(d, r.sa))).toBeLessThan(0.01);
      }
    }
  });

  it('stops cars by level: its barriers only up on the deck, its columns only below it', () => {
    for (const { world: w, deck: d } of worlds) {
      const own = w.walls.filter((x) => x.look === 'highway');
      const barriers = own.filter((x) => x.bottom !== undefined);
      const columns = own.filter((x) => x.under !== undefined);
      expect(barriers.length).toBeGreaterThan(100);
      expect(columns.length).toBeGreaterThan(40);
      const P = curvePoint();
      for (const wall of [...barriers, ...columns]) {
        const mx = (wall.ax + wall.bx) / 2;
        const mz = (wall.az + wall.bz) / 2;
        const ground = w.heightAt(mx, mz);
        if (wall.bottom !== undefined) expect(wall.bottom).toBeGreaterThan(ground + 6);
        if (wall.under !== undefined) {
          expect(wall.under).toBeGreaterThan(ground + 6);
          expect(wall.under).toBeLessThan(ground + 30);
        }
      }
      // A hammerhead column on the deck line: a car in the street hits it, a car up on the deck rolls over it.
      const pier = w.districts.builds[d.area.id].props.find((p) => p.kind === 'pier');
      if (pier) {
        // Beside it, across the deck: inside the column down in the street, clear of the median up there.
        const pr = projectOnCurve(d.curve, pier.x, pier.z);
        sampleCurve(d.curve, pr.s, P);
        const px = pier.x - P.tz * 1.4;
        const pz = pier.z + P.tx * 1.4;
        const ground = w.heightAt(px, pz);
        const contacts: Parameters<World['collideCircle']>[3] = [];
        expect(w.collideCircle(px, pz, 0.5, contacts, ground + 0.4)).toBeGreaterThan(0);
        const top = w.heightAt(px, pz, ground + 100);
        expect(top).toBeGreaterThan(ground + 10);
        expect(w.collideCircle(px, pz, 0.5, contacts, top + 0.3)).toBe(0);
      }
      // The deck's barriers: a car up there meets them, a car in the street beneath passes under (where
      // nothing else stands down there: a column, a frontage).
      const contacts: Parameters<World['collideCircle']>[3] = [];
      let checked = 0;
      for (const b of barriers) {
        if (b.solid) continue;
        const cx = (b.ax + b.bx) / 2 + b.nx * 0.3;
        const cz = (b.az + b.bz) / 2 + b.nz * 0.3;
        const ground = w.heightAt(cx, cz);
        // Over the street (not a block the deck crosses), out of reach of any wall below (and its 3 m band).
        if (w.surfaceAt(cx, cz) === 'offroad' || w.wallClearance(cx, cz, 4, ground + 0.4) < 3.2) continue;
        expect(w.collideCircle(cx, cz, 0.6, contacts, b.bottom! + 2)).toBeGreaterThan(0);
        expect(w.collideCircle(cx, cz, 0.6, contacts, ground + 0.4)).toBe(0);
        checked++;
      }
      expect(checked).toBeGreaterThan(50);
    }
  });

  it('every wall under the deck stops only the cars beneath it', () => {
    for (const { world: w, deck: d } of worlds) {
      const P = curvePoint();
      for (const wall of w.walls) {
        if (wall.look === 'highway' || wall.kind !== 'wall') continue;
        const mx = (wall.ax + wall.bx) / 2;
        const mz = (wall.az + wall.bz) / 2;
        // Inside the deck's drivable footprint (well inside its edges)?
        let inside = false;
        for (let s = d.sW; s <= d.sE && !inside; s += 4) {
          sampleCurve(d.curve, s, P);
          const along = (mx - P.x) * P.tx + (mz - P.z) * P.tz;
          const lat = -(mx - P.x) * P.tz + (mz - P.z) * P.tx;
          if (Math.abs(along) < 2 && Math.abs(lat) < HIGHWAY_HALF - 1) inside = true;
        }
        if (inside) expect(wall.under, `${wall.look} wall at ${mx.toFixed(1)}, ${mz.toFixed(1)}`).toBeDefined();
      }
    }
  });
});

describe('elevated highway (over the El)', () => {
  it('rises over the El trains where the lines cross, and no column of either stands in the way of the other', () => {
    // Seeds where the two cross (the second with the El's columns right under the expressway's deck).
    for (const seed of [365252039, 1340691607]) {
      const c = createCity(seed);
      const sub = c.districts.areas.find((a) => a.kind === 'subway')!;
      const d = highwayDeck(deckOf(c.districts.areas)!, c.districts.areas);
      expect(Number.isFinite(d.sEl)).toBe(true);
      const el = elCurve(sub, c.districts.builds[sub.id], c.terrain.heightAt);
      const P = curvePoint();
      const Q = curvePoint();
      let over = 0;
      for (let s = d.sEl - 60; s <= d.sEl + 60; s += 1) {
        sampleCurve(d.curve, s, P);
        for (const v of [-HIGHWAY_HALF, 0, HIGHWAY_HALF]) {
          const pr = projectOnCurve(el, P.x - P.tz * v, P.z + P.tx * v);
          if (Math.abs(pr.lateral) > CITY.districts.subway.deckWidth / 2) continue;
          sampleCurve(el, pr.s, Q);
          // Clear of the trains (3.8 m) and the track lamps (4.6 m) over the El's ties.
          expect(deckUnderAt(d, s) - Q.y).toBeGreaterThan(5.5);
          over++;
        }
      }
      expect(over).toBeGreaterThan(0);
      // The expressway's columns keep off the El's deck; the El's under the expressway's deck stop only street cars.
      for (const w of c.districts.builds[d.area.id].walls.filter((x) => x.under !== undefined)) {
        const pr = projectOnCurve(el, (w.ax + w.bx) / 2, (w.az + w.bz) / 2);
        if (pr.s > el.cityA && pr.s < el.cityB) expect(Math.abs(pr.lateral)).toBeGreaterThan(CITY.districts.subway.deckWidth / 2 + 1);
      }
      for (const w of c.blocks.walls.filter((x) => x.area === sub.id)) {
        const pr = projectOnCurve(d.curve, (w.ax + w.bx) / 2, (w.az + w.bz) / 2);
        if (Math.abs(pr.lateral) < HIGHWAY_HALF - 1 && pr.s > d.sW && pr.s < d.sE) expect(w.under).toBeDefined();
      }
    }
  });
});

describe('elevated highway (driving)', () => {
  it('a car drives up a ramp onto the deck on the ground all the way, the same way twice', () => {
    const { world: w, deck: d } = worlds[0];
    const r = d.ramps[0];
    const ax = r.axis;
    const run = () => {
      const start = axisAt(ax, -12);
      const cfg = { ...raceConfig(w.seed, 'circuit', 0), openWorld: true, start: { x: start.x, z: start.z, yaw: Math.atan2(ax.dx, ax.dz), speed: 14, tick: 0 } };
      const race = createRace(cfg, w);
      const c = race.cars[0].state;
      let airborne = 0;
      let bottom = 0;
      let up = false;
      for (let t = 0; t < 60 * 20 && !up; t++) {
        // Pure pursuit along the axis, 14 m ahead, at a steady 20 m/s.
        let best = 0;
        let bd = Infinity;
        for (let u = -15; u <= ax.length + 40; u += 1) {
          const q = axisAt(ax, u);
          const dd = (q.x - c.x) ** 2 + (q.z - c.z) ** 2;
          if (dd < bd) {
            bd = dd;
            best = u;
          }
        }
        const tgt = axisAt(ax, best + 14);
        const fx = sin(c.yaw);
        const fz = cos(c.yaw);
        const dx = tgt.x - c.x;
        const dz = tgt.z - c.z;
        const v = dx * fz - dz * fx;
        const steer = clamp((-2.5 * v) / Math.max(4, dx * fx + dz * fz), -1, 1);
        stepRace(race, input({ throttle: c.speed < 20 ? 1 : 0, brake: c.speed > 23 ? 0.5 : 0, steer }));
        if (best > 2 && best < ax.length + 10 && c.wheels.every((wh) => !wh.contact)) airborne++;
        bottom = Math.max(bottom, c.bottomOut);
        up = best > ax.length + 25 && w.upperLevel(c.x, c.z, c.y);
      }
      return { up, airborne, bottom, snap: JSON.stringify(c) };
    };
    const a = run();
    expect(a.up).toBe(true);
    expect(a.airborne).toBe(0);
    expect(a.bottom).toBeLessThan(0.02);
    expect(run().snap).toBe(a.snap);
  });

  it('a reset up on the deck puts the car back on the deck; a race shuts the ramps, free roam opens them', () => {
    const { world: w, deck: d, city } = worlds[1];
    const P = curvePoint();
    const s = (d.sW + d.sE) / 2;
    sampleCurve(d.curve, s, P);
    const cfg = { ...raceConfig(w.seed, 'circuit', 0), openWorld: true, start: { x: P.x - P.tz * 3, z: P.z + P.tx * 3, yaw: Math.atan2(P.tx, P.tz), speed: 0, y: deckTopAt(d, s) + 0.3, tick: 0 } };
    const race = createRace(cfg, w);
    const rc = race.cars[0];
    expect(w.upperLevel(rc.state.x, rc.state.z, rc.state.y)).toBe(true);
    for (let t = 0; t < 30; t++) stepRace(race, input({}));
    resetToStreet(race, rc);
    const c = rc.state;
    expect(w.upperLevel(c.x, c.z, c.y)).toBe(true);
    expect(Math.abs(c.y - w.heightAt(c.x, c.z, c.y))).toBeLessThan(0.05);
    expect(w.wallClearance(c.x, c.z, 3, c.y)).toBeGreaterThan(1.5);
    // A race shuts every ramp at its mouth; free roam leaves them open.
    const gates = highwayGates(w.areas);
    expect(gates.length).toBeGreaterThan(0);
    const racing = createWorld(w.seed, 'circuit', city);
    const shut = racing.walls.filter((x) => x.look === 'highway' && x.bottom === undefined && x.under === undefined && gates.some((g) => g.ax === x.ax && g.az === x.az));
    expect(shut.length).toBe(gates.length);
    expect(w.walls.some((x) => gates.some((g) => g.ax === x.ax && g.az === x.az && g.bx === x.bx))).toBe(false);
  });
});

describe('river bridges beside the highway', () => {
  it('answer every two level query exactly as before the highway (fingerprint)', () => {
    // FNV-1a over heightAt, driveHeightAt, slopeAt, surfaceAt at three heights and twoLevels, sampled over every
    // bridge deck's span on three seeds (two with a highway), recorded on the commit before the highway's
    // levels joined the river's (DeckSpan `upper`). A change to the river or the terrain moves it on purpose.
    let h = 2166136261;
    const mix = (v: number | string | boolean) => {
      const s = typeof v === 'number' ? v.toFixed(9) : String(v);
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    };
    for (const seed of [25135766, 1630930914, 7]) {
      const city = createCity(seed);
      const w = createWorld(seed, 'circuit', city, { openWorld: true });
      const river = w.areas.find((a) => a.kind === 'river');
      if (!river) continue;
      for (const dk of w.districts.builds[river.id].decks) {
        const b = polygonBounds(dk.polygon);
        for (let x = b.minX; x <= b.maxX; x += 2.7) {
          for (let z = b.minZ; z <= b.maxZ; z += 2.3) {
            if (!pointInPolygon(x, z, dk.polygon)) continue;
            const top = w.heightAt(x, z);
            const low = w.heightAt(x, z, -1e9);
            for (const y of [top + 0.3, low + 0.3, (top + low) / 2]) {
              mix(w.heightAt(x, z, y));
              mix(w.driveHeightAt(x, z, y));
              const sl = w.slopeAt(x, z, y);
              mix(sl.gx);
              mix(sl.gz);
              mix(w.surfaceAt(x, z, y));
            }
            mix(w.twoLevels(x, z));
          }
        }
      }
    }
    expect(h.toString(16)).toBe('25485c0d');
  });
});
