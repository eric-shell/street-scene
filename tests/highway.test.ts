import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { City, World } from '../src/city/world';
import { Rng } from '../src/sim/prng';
import { riverCenter } from '../src/city/districts/river';
import { polygonBounds, pointInPolygon } from '../src/city/districts/geom';
import { HIGHWAY_HALF, LOOP_AT, deckPoint, deckTopAt, deckUnderAt, highwayDeck, laneCenter } from '../src/city/districts/highway/shape';
import type { HighwayDeck, HighwayRamp } from '../src/city/districts/highway/shape';
import { highwayRolled } from '../src/city/districts/highway/line';
import { highwayGates } from '../src/city/districts/highway/settle';
import { alleyMouths } from '../src/city/districts/highway/alleys';
import { axisAt, rampHeightAlong } from '../src/city/districts/highway/rampAxis';
import { curvePoint, projectOnCurve, sampleCurve } from '../src/city/railCurve';
import { elCurve } from '../src/city/districts/subway';
import { createRace, resetToStreet, stepRace } from '../src/sim/race';
import { GRAVITY } from '../src/sim/tuning';
import { clamp, sin, cos } from '../src/sim/math';
import type { Vec2 } from '../src/sim/math';
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

  it('crosses the map along its rows, swinging once or twice, clear of the river, a loop pair at each end and its interchanges an off-ramp beside an on-ramp, the same way every time', () => {
    let withInterchange = 0;
    for (const seed of highwaySeeds(5, 10)) {
      const plan = planRoads(seed);
      const areas = plan.districts.areas.filter((a) => a.kind === 'highway');
      const deck = deckOf(areas)!;
      const g = plan.graph;
      const p = deck.path;
      // West to east, its line planned from past one map edge to past the other.
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
      // A loop pair at each end of the drivable deck: one down off the outgoing carriageway, one up onto
      // the incoming one, on opposite sides of the street beneath.
      const ramps = areas.filter((a) => a.variant === 'ramp');
      for (const r of ramps) {
        expect(r.params.deck).toBe(deck.id);
        expect(r.params.grade).toBeLessThanOrEqual(CFG.rampGrade[1]);
      }
      const loops = ramps.filter((r) => r.params.loop === 1);
      expect(loops.length).toBe(4);
      for (const end of [deck.params.sW, deck.params.sE]) {
        const at = loops.filter((l) => l.params.sa === end);
        expect(at.length).toBe(2);
        expect(at.map((l) => l.params.on).sort()).toEqual([0, 1]);
        expect(at[0].params.side).toBe(-at[1].params.side);
      }
      expect(deck.params.sE - deck.params.sW).toBeGreaterThan(700);
      // Interchanges: on one side, an off-ramp coming down to the street just before a junction and an
      // on-ramp going up from it just past (or past the next one), their runs along the street close.
      const slips = ramps.filter((r) => r.params.loop !== 1);
      expect(slips.length).toBe(2 * deck.params.interchanges);
      expect(deck.params.interchanges).toBeLessThanOrEqual(CFG.interchanges[1]);
      if (deck.params.interchanges > 0) withInterchange++;
      for (const off of slips.filter((r) => r.params.on === 0)) {
        const near = slips.filter((r) => r.params.on === 1 && r.params.side === off.params.side).map((r) => Math.hypot(r.params.fx - off.params.fx, r.params.fz - off.params.fz));
        expect(Math.min(...near)).toBeLessThan(300);
        // Down the way that side's traffic runs: its axis (foot to E) runs against it.
        expect(off.params.along).toBe(-off.params.side);
      }
      for (const on of slips.filter((r) => r.params.on === 1)) expect(on.params.along).toBe(on.params.side);
      const again = planRoads(seed).districts.areas.filter((a) => a.kind === 'highway');
      expect(JSON.stringify(again)).toBe(JSON.stringify(areas));
    }
    // Nearly every city has room for an interchange (a city without one still has its loops at both ends).
    expect(withInterchange).toBeGreaterThanOrEqual(8);
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

  it('ramps and loops climb from their mouth to the deck at a comfortable grade, flush at both ends, no launch at the crest', () => {
    for (const { world: w, deck: d } of worlds) {
      expect(d.ramps.filter((r) => r.loop).length).toBe(4);
      for (const r of d.ramps) {
        const ax = r.axis;
        const pr = r.profile;
        expect(pr.ready).toBe(true);
        expect(pr.grade).toBeLessThanOrEqual(CFG.rampGrade[1]);
        expect(pr.grade).toBeGreaterThan(0.03);
        // Vertical curves: a car leaves the ground over a crest of curvature k at sqrt(g / k). A loop's turn
        // holds a car to what radius r takes at 1.6 g (plus a margin); a slip ramp runs straight, taken at
        // 40 m/s. Up to that the top's crest keeps it down, and the foot's sag adds under 1 g.
        const crest = Math.abs(pr.grade - pr.g1) / pr.e1;
        const sag = Math.abs(pr.grade - pr.g0) / pr.e0;
        const v = r.loop ? Math.sqrt(1.6 * GRAVITY * ax.r) + 8 : 40;
        expect(Math.sqrt(GRAVITY / crest)).toBeGreaterThan(v);
        expect((v * v * sag) / GRAVITY).toBeLessThan(1);
        // The world's surface along the axis is the profile, continuous, flush with the street at the mouth
        // and with the deck at the top.
        let prev = NaN;
        for (let u = 0.2; u <= ax.length; u += 0.5) {
          const q = axisAt(ax, u);
          const y = rampHeightAlong(ax, pr, u).y;
          const h = w.heightAt(q.x, q.z, y);
          if (u > pr.blend) expect(h).toBeCloseTo(y, 3);
          if (!Number.isNaN(prev)) expect(Math.abs(h - prev)).toBeLessThan(0.5 * (CFG.rampGrade[1] + 0.02));
          prev = h;
        }
        const foot = axisAt(ax, 0.2);
        expect(Math.abs(w.heightAt(foot.x, foot.z, 0) - w.heightAt(foot.x, foot.z))).toBeLessThan(0.05);
        expect(Math.abs(rampHeightAlong(ax, pr, ax.length).y - deckTopAt(d, r.sa))).toBeLessThan(0.01);
        // A slip ramp runs along the street at its level before it climbs.
        if (!r.loop) expect(rampHeightAlong(ax, pr, r.flat).y - w.heightAt(axisAt(ax, r.flat).x, axisAt(ax, r.flat).z)).toBeLessThan(0.1);
        // Across its mouth, edge to edge, a car stays at the street's level.
        for (let u = 0; u <= 4; u += 1) {
          const q = axisAt(ax, u);
          for (let v = -r.half; v <= r.half + 1e-9; v += r.half / 3) {
            const x = q.x - q.tz * v;
            const z = q.z + q.tx * v;
            const ground = w.heightAt(x, z);
            expect(Math.abs(w.heightAt(x, z, ground + 0.5) - ground), `mouth u ${u} v ${v.toFixed(1)}`).toBeLessThan(0.6);
          }
        }
      }
    }
  });

  it('ends in its loops with no wall across the deck: the carriageways run straight on into them', () => {
    for (const { world: w, deck: d } of worlds) {
      for (const [sEnd, out] of [
        [d.sW, -1],
        [d.sE, 1],
      ] as const) {
        // The outgoing carriageway is the one whose traffic runs toward this end: on the right of it.
        const side = out;
        for (let back = 60; back >= 2; back -= 2) {
          const s = sEnd - out * back;
          const top = deckTopAt(d, s);
          for (const k of [1, 2]) {
            const p = deckPoint(d.curve, s, side * laneCenter(k));
            expect(w.wallClearance(p.x, p.z, 1.5, top + 0.4), `end ${out} back ${back} lane ${k}`).toBeGreaterThanOrEqual(1.5 - 1e-9);
          }
        }
        // E of both loops lies in its carriageway at the deck's end, LOOP_AT out from the centerline.
        for (const r of d.ramps.filter((x) => x.loop && x.sa === sEnd)) {
          const e = deckPoint(d.curve, sEnd, r.side * LOOP_AT);
          expect(Math.hypot(r.axis.ex - e.x, r.axis.ez - e.z)).toBeLessThan(0.05);
        }
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
        // The deck's barriers stand well up; a ramp's walls from where its bridge is 4 m up (settle.ts),
        // over a car on the ground beneath.
        if (wall.bottom !== undefined) expect(wall.bottom).toBeGreaterThan(ground + (wall.area === d.area.id ? 6 : 1.3));
        // Columns stop cars below the deck, or a ramp's low bridge, all the way up past a car's roof.
        if (wall.under !== undefined) {
          expect(wall.under).toBeGreaterThan(ground + (wall.area === d.area.id ? 6 : 1.8));
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
        // A quarter, half and three quarters along each piece.
        for (const t of [0.25, 0.5, 0.75]) {
          const cx = b.ax + (b.bx - b.ax) * t + b.nx * 0.3;
          const cz = b.az + (b.bz - b.az) * t + b.nz * 0.3;
          const ground = w.heightAt(cx, cz);
          // Over the street (not a block the deck crosses), out of reach of any wall below (and its 3 m band).
          if (w.surfaceAt(cx, cz) === 'offroad' || w.wallClearance(cx, cz, 4, ground + 0.4) < 3.2) continue;
          expect(w.collideCircle(cx, cz, 0.6, contacts, b.bottom! + 2)).toBeGreaterThan(0);
          expect(w.collideCircle(cx, cz, 0.6, contacts, ground + 0.4)).toBe(0);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30);
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

/**
 * Drive a car along a polyline by pure pursuit at about `speed` m/s, from its first point: whether it ever
 * flew (no wheel on the ground), how hard it bottomed out, how far along it got (index of the nearest
 * point) and the car as it ended, its snapshot to compare runs by.
 */
function drivePath(w: World, path: readonly Vec2[], speed: number, seconds: number, y?: number) {
  const a = path[0];
  const b = path[1];
  // Up on the deck when the path starts there (`y`: its top), else in the street.
  const cfg = { ...raceConfig(w.seed, 'circuit', 0), openWorld: true, start: { x: a.x, z: a.z, yaw: Math.atan2(b.x - a.x, b.z - a.z), speed: speed * 0.7, tick: 0, ...(y === undefined ? {} : { y: y + 0.3 }) } };
  const race = createRace(cfg, w);
  const c = race.cars[0].state;
  let airborne = 0;
  let bottom = 0;
  let k = 0;
  for (let t = 0; t < 60 * seconds && k < path.length - 4; t++) {
    // The nearest point a little ahead of the last, then a point about 12 m on.
    let bd = Infinity;
    const k0 = k;
    for (let i = k0; i < Math.min(path.length, k0 + 12); i++) {
      const dd = (path[i].x - c.x) ** 2 + (path[i].z - c.z) ** 2;
      if (dd < bd) {
        bd = dd;
        k = i;
      }
    }
    let j = k;
    let ahead = 0;
    while (j + 1 < path.length && ahead < 12) {
      ahead += Math.hypot(path[j + 1].x - path[j].x, path[j + 1].z - path[j].z);
      j++;
    }
    const tgt = path[j];
    const fx = sin(c.yaw);
    const fz = cos(c.yaw);
    const dx = tgt.x - c.x;
    const dz = tgt.z - c.z;
    const v = dx * fz - dz * fx;
    const steer = clamp((-2.5 * v) / Math.max(4, dx * fx + dz * fz), -1, 1);
    stepRace(race, input({ throttle: c.speed < speed ? 1 : 0, brake: c.speed > speed + 3 ? 0.6 : 0, steer }));
    if (c.wheels.every((wh) => !wh.contact)) airborne++;
    bottom = Math.max(bottom, c.bottomOut);
  }
  return { airborne, bottom, k, car: c, snap: JSON.stringify(c) };
}

/** A path along the deck at lateral v from s0 to s1, every 3 m. */
function alongDeck(d: HighwayDeck, s0: number, s1: number, v: number): Vec2[] {
  const out: Vec2[] = [];
  const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 3));
  for (let k = 0; k <= n; k++) out.push(deckPoint(d.curve, s0 + ((s1 - s0) * k) / n, v));
  return out;
}

/** A path along a ramp's axis from u0 to u1 (either way), every 3 m. */
function alongRamp(r: HighwayRamp, u0: number, u1: number): Vec2[] {
  const out: Vec2[] = [];
  const n = Math.max(1, Math.ceil(Math.abs(u1 - u0) / 3));
  for (let k = 0; k <= n; k++) {
    const q = axisAt(r.axis, u0 + ((u1 - u0) * k) / n);
    out.push({ x: q.x, z: q.z });
  }
  return out;
}

/** The first world with a ramp that passes the test. */
function withRamp(test: (r: HighwayRamp) => boolean): { world: World; deck: HighwayDeck; ramp: HighwayRamp } {
  for (const { world, deck } of worlds) {
    const ramp = deck.ramps.find(test);
    if (ramp) return { world, deck, ramp };
  }
  throw new Error('no such ramp');
}

describe('elevated highway (driving)', () => {
  // The street beneath the deck: its outer lane each way, out from the centerline (m).
  const streetLane = HIGHWAY_HALF - CITY.sidewalk - 3;

  it('a car slips off the street onto an on-ramp and up onto the deck, on the ground all the way, the same way twice', () => {
    const { world: w, deck: d, ramp: r } = withRamp((x) => !x.loop && x.on);
    const sf = projectOnCurve(d.curve, r.axis.fx, r.axis.fz).s;
    const S = r.side;
    const A = r.along;
    // Along the street's outer lane toward the ramp's run, across the cut sidewalk onto it, up it, along its lane onto the deck.
    const path = [...alongDeck(d, sf - A * 50, sf - A * 4, S * streetLane), ...alongRamp(r, r.flat * 0.6, r.axis.length), ...alongDeck(d, r.sa + A * 6, r.sa + A * 36, S * (HIGHWAY_HALF + r.half - 2)), ...alongDeck(d, r.sa + A * 70, r.sa + A * 160, S * laneCenter(2))];
    const run = () => drivePath(w, path, 18, 30);
    const a = run();
    expect(a.k).toBeGreaterThan(path.length - 8);
    expect(a.airborne).toBe(0);
    expect(a.bottom).toBeLessThan(0.02);
    expect(w.upperLevel(a.car.x, a.car.z, a.car.y)).toBe(true);
    expect(run().snap).toBe(a.snap);
  });

  it('a car takes an off-ramp down off the deck and slips into the street beneath going the same way', () => {
    const { world: w, deck: d, ramp: r } = withRamp((x) => !x.loop && !x.on);
    const sf = projectOnCurve(d.curve, r.axis.fx, r.axis.fz).s;
    const S = r.side;
    const A = r.along;
    // Traffic runs E to foot, against the axis: along the deck's outer lane into the lane, down the ramp, out onto the street.
    // Into the lane once it is at full width (past its taper), along it to E, down the ramp, out onto the street.
    const path = [...alongDeck(d, r.sb + A * 90, r.sb + A * 10, S * laneCenter(2)), ...alongDeck(d, r.sb - A * CFG.rampTaper, r.sa + A * 4, S * (HIGHWAY_HALF + r.half - 1.5)), ...alongRamp(r, r.axis.length, r.flat * 0.5), ...alongDeck(d, sf + A * 2, sf - A * 60, S * streetLane)];
    const a = drivePath(w, path, 18, 30, deckTopAt(d, r.sb + A * 90));
    expect(a.k).toBeGreaterThan(path.length - 8);
    expect(a.airborne).toBe(0);
    expect(a.bottom).toBeLessThan(0.02);
    expect(w.upperLevel(a.car.x, a.car.z, a.car.y)).toBe(false);
    expect(Math.abs(a.car.y - w.heightAt(a.car.x, a.car.z))).toBeLessThan(0.3);
  });

  it('a car leaves the deck at its end on the exit loop and lands on the street beneath it', () => {
    const { world: w, deck: d, ramp: r } = withRamp((x) => x.loop && !x.on);
    const out = r.sa === d.sE ? 1 : -1;
    const foot = axisAt(r.axis, 0);
    // Off the leg's end into the street beneath, then along it.
    const into = { x: foot.x - foot.tx * 9, z: foot.z - foot.tz * 9 };
    const sIn = projectOnCurve(d.curve, into.x, into.z).s;
    // Right off the leg into the street's lanes running out toward the end, on the near side.
    const path = [...alongDeck(d, r.sa - out * 90, r.sa, r.side * LOOP_AT), ...alongRamp(r, r.axis.length, 0), into, ...alongDeck(d, sIn + out * 6, sIn + out * 50, r.side * streetLane)];
    const a = drivePath(w, path, 11, 40, deckTopAt(d, r.sa - out * 90));
    expect(a.k).toBeGreaterThan(path.length - 8);
    expect(a.airborne).toBe(0);
    expect(w.upperLevel(a.car.x, a.car.z, a.car.y)).toBe(false);
    expect(Math.abs(a.car.y - w.heightAt(a.car.x, a.car.z))).toBeLessThan(0.3);
  });

  it('a car climbs the entry loop from the street beneath onto the deck', () => {
    const { world: w, deck: d, ramp: r } = withRamp((x) => x.loop && x.on);
    const into = r.sa === d.sE ? -1 : 1;
    const foot = axisAt(r.axis, 0);
    const street = { x: foot.x - foot.tx * 10, z: foot.z - foot.tz * 10 };
    const sSt = projectOnCurve(d.curve, street.x, street.z).s;
    const path = [...alongDeck(d, sSt - into * 50, sSt - into * 12, r.side * streetLane), street, ...alongRamp(r, 0, r.axis.length), ...alongDeck(d, r.sa + into * 4, r.sa + into * 90, r.side * LOOP_AT)];
    const a = drivePath(w, path, 11, 40);
    expect(a.k).toBeGreaterThan(path.length - 8);
    expect(a.airborne).toBe(0);
    expect(w.upperLevel(a.car.x, a.car.z, a.car.y)).toBe(true);
  });

  it('a reset up on the deck puts the car back on the deck; a race shuts the alleys onto streets off the route and leaves the ramps and loops open, free roam opens everything', () => {
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
    // A race shuts an alley's mouth onto a street the route does not take, and no ramp or loop (nothing
    // stands across one); free roam leaves everything open.
    const racing = createWorld(w.seed, 'circuit', city);
    const route = new Set(racing.route.edges);
    const gates = highwayGates(w.areas, route);
    const alleyGates = w.areas.filter((a) => a.kind === 'highway' && a.variant === 'alley').flatMap((a) => alleyMouths(a)).filter((m) => m.edge >= 0 && !route.has(m.edge)).length;
    expect(gates.length).toBe(alleyGates * 4);
    const ramps = new Set(w.areas.filter((a) => a.kind === 'highway' && a.variant === 'ramp').map((a) => a.id));
    expect(gates.some((g) => g.area !== undefined && ramps.has(g.area))).toBe(false);
    const shut = racing.walls.filter((x) => x.look === 'highway' && x.bottom === undefined && x.under === undefined && gates.some((g) => g.ax === x.ax && g.az === x.az));
    expect(shut.length).toBe(gates.length);
    expect(w.walls.some((x) => gates.some((g) => g.ax === x.ax && g.az === x.az && g.bx === x.bx))).toBe(false);
  });
});

describe('elevated highway (alleys)', () => {
  it('opens the frontage under its lanes into alleys: paved, open to the street beneath, walled at the back', () => {
    let alleys = 0;
    for (const { world: w, deck: d } of worlds) {
      for (const a of w.areas.filter((x) => x.kind === 'highway' && x.variant === 'alley')) {
        alleys++;
        const side = a.params.side;
        const mid = (a.params.s0 + a.params.s1) / 2;
        // Along its middle third: road underfoot, and nothing between the street beneath's sidewalk and the
        // back wall (the bents' columns stand on the sidewalk, clear of a car's line in).
        for (let s = mid - (a.params.s1 - a.params.s0) / 6; s <= mid + (a.params.s1 - a.params.s0) / 6; s += 4) {
          const p = deckPoint(d.curve, s, side * (HIGHWAY_HALF + CFG.alleyDepth / 2));
          const ground = w.heightAt(p.x, p.z);
          expect(w.surfaceAt(p.x, p.z, ground + 0.3)).toBe('road');
          expect(w.wallClearance(p.x, p.z, 5, ground + 0.4), `alley at ${s.toFixed(0)}`).toBeGreaterThan(CFG.alleyDepth / 2 - 0.6);
        }
        // Its back wall stands where its polygon ends, a city wall that stops street cars.
        const back = w.walls.filter((x) => x.area === a.id && x.look === 'boundary');
        expect(back.length).toBeGreaterThan(5);
      }
    }
    expect(alleys).toBeGreaterThan(0);
  });
});

describe('river bridges beside the highway', () => {
  it('answer every two level query exactly as before the highway (fingerprint)', () => {
    // FNV-1a over heightAt, driveHeightAt, slopeAt, surfaceAt at three heights and twoLevels, sampled over every
    // bridge deck's span on three seeds (two with a highway), recorded on the commit before the highway's
    // levels joined the river's (DeckSpan `upper`), re-recorded for the per-seed city plans (all three seeds a
    // river and a highway). A change to the river or the terrain moves it on purpose.
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
    expect(h.toString(16)).toBe('c37e5388');
  });
});
