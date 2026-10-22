import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { buildRoute } from '../src/city/route';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { City, World } from '../src/city/world';
import { CITY } from '../src/city/config';
import { createTerrain } from '../src/city/terrain';
import { distToSegment, segmentT } from '../src/sim/math';
import { pointInPolygon } from '../src/city/districts/geom';
import { CAR_HALF, LAUNCH_BOUND, ROUTE_INDEX, carParkGeo, carParkHeight, carParks, frontU, groundHeight, rampPoint } from '../src/city/districts/carPark';
import type { CarParkGeo } from '../src/city/districts/carPark';
import { createRace, stepRace } from '../src/sim/race';
import { NEUTRAL_INPUT } from '../src/sim/input';
import { carSnapshot, raceConfig } from './helpers';

const CFG = CITY.districts.carPark;
const DEG = 180 / Math.PI;

/** Seeds of the sweep that got a car park (planRoads only: cheap). */
function sweep(count: number, from = 4242): { seed: number; areas: number }[] {
  const rng = new Rng(from);
  const out: { seed: number; areas: number }[] = [];
  for (let i = 0; i < count; i++) {
    const seed = rng.int(0, 0x7fffffff);
    const n = planRoads(seed).districts.areas.filter((a) => a.kind === 'carPark').length;
    out.push({ seed, areas: n });
  }
  return out;
}

const SWEEP = sweep(60);
const WITH = SWEEP.filter((s) => s.areas > 0).map((s) => s.seed);

/** Unit tangent of the landing street (C to its far node). */
function landing(city: City, g: CarParkGeo): { C: { x: number; z: number }; t: { x: number; z: number }; half: number } {
  const e = city.graph.edges[g.landEdge];
  const C = city.graph.nodes[g.node];
  const Q = city.graph.nodes[e.a === g.node ? e.b : e.a];
  const l = Math.hypot(Q.x - C.x, Q.z - C.z);
  return { C, t: { x: (Q.x - C.x) / l, z: (Q.z - C.z) / l }, half: e.width / 2 };
}

const W = (g: CarParkGeo, u: number, v: number) => ({ x: g.ox + g.ux * u + g.vx * v, z: g.oz + g.uz * u + g.vz * v });

/** Segment a-b touches a convex polygon. */
function touches(ax: number, az: number, bx: number, bz: number, poly: { x: number; z: number }[]): boolean {
  if (pointInPolygon(ax, az, poly) || pointInPolygon(bx, bz, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const d1 = (bx - ax) * (p.z - az) - (bz - az) * (p.x - ax);
    const d2 = (bx - ax) * (q.z - az) - (bz - az) * (q.x - ax);
    const d3 = (q.x - p.x) * (az - p.z) - (q.z - p.z) * (ax - p.x);
    const d4 = (q.x - p.x) * (bz - p.z) - (q.z - p.z) * (bx - p.x);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/**
 * Drive the player's car from the entry street through a car park and down the landing street with
 * a lookahead pursuit driver (ramp and roof turn at modest speed, full throttle and nitrous down the
 * chute once lined up), `bias` m off the chute's line. Returns the launch and landing and the race.
 */
function driveThrough(seed: number, bias: number) {
  const city = createCity(seed);
  const g = carParks(city.districts.areas)[0];
  const kind = g.owner === ROUTE_INDEX.circuit ? 'circuit' : 'sprint';
  const r = createRace(raceConfig(seed, kind, 0));
  while (r.tick < r.countdownTicks) stepRace(r, NEUTRAL_INPUT);
  const rc = r.cars[0];
  const c = rc.state;
  const w = r.world;
  const { C, t, half } = landing(city, g);
  const foot = rampPoint(g, g.apron0, 0);
  const p0 = w.routeProgress(foot.x - g.fnx * 8, foot.z - g.fnz * 8);
  const lane = { x: foot.x - g.fnx * 7.5, z: foot.z - g.fnz * 7.5 };
  const off = (p: { x: number; z: number }) => ({ x: p.x + g.vx * bias, z: p.z + g.vz * bias });
  const path = [{ x: lane.x - p0.tx * 45, z: lane.z - p0.tz * 45 }, { x: lane.x - p0.tx * 14, z: lane.z - p0.tz * 14 }, rampPoint(g, g.apron0 + 2, 0), rampPoint(g, g.apron1 + 3, 0), ...g.path.slice(1, -2), off(g.path[g.path.length - 2]), off(g.path[g.path.length - 1])];
  const iMouth = path.length - 2;
  for (let k = 1; k <= 4; k++) path.push(off({ x: C.x + t.x * 15 * k, z: C.z + t.z * 15 * k }));
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  const at = (s: number) => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const u = Math.min(1, Math.max(0, (s - cum[i]) / (cum[i + 1] - cum[i] || 1)));
    return { x: path[i].x + (path[i + 1].x - path[i].x) * u, z: path[i].z + (path[i + 1].z - path[i].z) * u };
  };
  const project = (x: number, z: number) => {
    let best = Infinity;
    let bs = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const dx = path[i + 1].x - a.x;
      const dz = path[i + 1].z - a.z;
      const l2 = dx * dx + dz * dz || 1;
      const u = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const d = Math.hypot(x - a.x - dx * u, z - a.z - dz * u);
      if (d < best) {
        best = d;
        bs = cum[i] + u * Math.sqrt(l2);
      }
    }
    return bs;
  };
  c.x = path[0].x;
  c.z = path[0].z;
  c.yaw = Math.atan2(p0.tx, p0.tz);
  c.y = w.driveHeightAt(c.x, c.z);
  c.vx = p0.tx * 14;
  c.vz = p0.tz * 14;
  c.yawRate = 0;
  rc.seg = -1;
  stepRace(r, NEUTRAL_INPUT);
  const d0 = rc.dist;
  const s0 = rc.rawS;
  const ev0 = r.events.length;
  const tYaw = Math.atan2(t.x, t.z);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  let sPath = 0;
  let air = false;
  let launch: { hd: number; v: number; y: number } | null = null;
  let land: { hd: number; lat: number; along: number; surface: string } | null = null;
  for (let i = 0; i < 60 * 40 && !(land && sPath > cum[cum.length - 1] - 20); i++) {
    sPath = Math.max(sPath, project(c.x, c.z));
    const speed = Math.hypot(c.vx, c.vz);
    const look = at(sPath + Math.max(6, speed * 0.55));
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    const dx = look.x - c.x;
    const dz = look.z - c.z;
    const u = dx * fx + dz * fz;
    const v = dx * fz - dz * fx;
    const steer = Math.max(-1, Math.min(1, -Math.atan(((2 * v) / Math.max(1, u * u + v * v)) * 2.7) / (30 / DEG)));
    const aligned = Math.abs(wrap(c.yaw - tYaw)) < 0.14 && Math.abs(wrap(Math.atan2(c.vx, c.vz) - tYaw)) < 0.14;
    let target = sPath < cum[1] - 4 ? 13 : sPath < cum[3] ? 9 : sPath < cum[4] - 25 ? 15 : sPath < cum[iMouth] - 4 || !aligned ? 13 : 99;
    if (land) target = 12;
    const contact = c.wheels.some((q) => q.contact);
    stepRace(r, { ...NEUTRAL_INPUT, throttle: speed < target ? 1 : 0, brake: speed > target + 1.5 ? 0.7 : 0, steer: contact ? steer : 0, nitrous: target > 50 });
    const hd = Math.atan2(c.vx, c.vz);
    if (!air && !contact && c.y - w.driveHeightAt(c.x, c.z) > 0.5 && sPath > cum[iMouth + 1] - 5) {
      air = true;
      launch = { hd: wrap(hd - tYaw) * DEG, v: speed, y: c.y - groundHeight(w)(c.x, c.z) };
    }
    if (air && contact && !land) land = { hd: wrap(hd - tYaw) * DEG, lat: (c.x - C.x) * -t.z + (c.z - C.z) * t.x, along: (c.x - C.x) * t.x + (c.z - C.z) * t.z, surface: w.surfaceAt(c.x, c.z) };
  }
  let ds = rc.rawS - s0;
  if (w.route.closed) ds = ((ds % w.route.length) + w.route.length) % w.route.length;
  return { r, g, half, launch, land, gained: rc.dist - d0, routeDist: ds, events: r.events.slice(ev0).map((e) => e.type) };
}

describe('car park shortcut', () => {
  it('plans car parks on a fair share of seeds, deterministically, chute on the landing street and its landing straight clear', () => {
    // Measured share over this sweep (README decisions log): about a quarter of the seeds before the
    // river channel ran the whole map, a tenth since (routes spend their corners on long dives).
    expect(WITH.length / SWEEP.length).toBeGreaterThan(0.07);
    // The straight-line launch bound the chute guarantees.
    expect(LAUNCH_BOUND * DEG).toBeLessThan(6.5);
    let worstAxis = 0;
    for (const seed of WITH) {
      const a = planRoads(seed);
      const b = planRoads(seed);
      const mine = (p: typeof a) => JSON.stringify(p.districts.areas.filter((x) => x.kind === 'carPark'));
      expect(mine(b)).toBe(mine(a));
      for (const area of a.districts.areas.filter((x) => x.kind === 'carPark')) {
        const g = carParkGeo(area);
        const kind = g.owner === ROUTE_INDEX.circuit ? 'circuit' : 'sprint';
        const R = a.routeNodes[kind];
        const n = R.length;
        const j = R.indexOf(g.node);
        expect(j, `${seed}`).toBeGreaterThanOrEqual(0);
        const e = a.graph.edges[g.landEdge];
        const next = R[(j + 1) % n];
        expect(e.a === g.node ? e.b : e.a).toBe(next);
        // The chute (launching along -u) lies on the landing street's tangent.
        const C = a.graph.nodes[g.node];
        const Q = a.graph.nodes[next];
        const l = Math.hypot(Q.x - C.x, Q.z - C.z);
        const axis = Math.acos(Math.min(1, -(g.ux * (Q.x - C.x) + g.uz * (Q.z - C.z)) / l)) * DEG;
        worstAxis = Math.max(worstAxis, axis);
        // The landing zone runs straight down the route from C with no junction in it (nor in reach of its end).
        let along = 0;
        for (let k = 1; along < g.landZone && k < 8; k++) {
          const A = a.graph.nodes[R[(j + k - 1) % n]];
          const B = a.graph.nodes[R[(j + k) % n]];
          along += Math.hypot(B.x - A.x, B.z - A.z);
          const dot = ((B.x - A.x) * (Q.x - C.x) + (B.z - A.z) * (Q.z - C.z)) / (Math.hypot(B.x - A.x, B.z - A.z) * l);
          expect(dot, `${seed} straight`).toBeGreaterThan(Math.cos(3.5 / DEG));
          const corridor = Math.max(...B.edges.map((id) => a.graph.edges[id].width / 2 + a.graph.edges[id].sidewalk));
          if (B.edges.length > 2) expect(along - corridor, `${seed} junction in the landing zone`).toBeGreaterThan(g.landZone);
        }
        // Flights reach no further than the zone allows, rollout included.
        expect(g.landZone).toBeGreaterThan(g.landMax - g.lipBack + CFG.rollout - 1e-6);
        // The entry street is upstream of C on the same route.
        expect(R.some((id, i) => (i + 1 < n || kind === 'circuit') && a.graph.edges[g.entryEdge] && [a.graph.edges[g.entryEdge].a, a.graph.edges[g.entryEdge].b].includes(id))).toBe(true);
      }
      // Alley shortcuts are still guaranteed on both routes.
      for (const kind of ['circuit', 'sprint'] as const) expect(buildRoute(a.graph, kind, a.routeNodes[kind]).shortcuts.length, `${seed} ${kind}`).toBeGreaterThanOrEqual(1);
    }
    expect(worstAxis).toBeLessThan(1e-4);
  });

  it('stands on exact heights: the roof the deck height over the ground, the ramp eased from the curb to it, hills kept off', () => {
    let checked = 0;
    for (const seed of WITH.slice(0, 4)) {
      const city = createCity(seed);
      const base = createTerrain(seed);
      const ground = groundHeight({ areas: city.districts.areas, heightAt: city.terrain.heightAt });
      for (const g of carParks(city.districts.areas)) {
        const rng = new Rng(seed);
        // Roof: exactly H over the ground away from the kicker, and the ground is the bare terrain (no hill under it).
        for (let k = 0; k < 200; k++) {
          const v = rng.range(g.v0 + 0.5, g.v1 - 0.5);
          const u = rng.range(frontU(g, v) + 0.5, g.u1 - 0.5);
          if (u < g.kl + 0.5 && Math.abs(v) < g.hc + 0.5) continue;
          const p = W(g, u, v);
          expect(city.terrain.heightAt(p.x, p.z) - ground(p.x, p.z)).toBeCloseTo(g.H, 9);
          expect(Math.abs(ground(p.x, p.z) - base.heightAt(p.x, p.z)), `${seed} ground under the roof`).toBeLessThan(1e-6);
        }
        // Ramp: curb height across the apron, H where the deck takes over, continuous into the deck.
        const lift = (a: number) => {
          const p = rampPoint(g, a, 0);
          return carParkHeight(g, p.x, p.z).h;
        };
        expect(lift(g.apron0 + 1)).toBeCloseTo(CITY.curbHeight, 9);
        expect(lift(g.rend - 0.01)).toBeCloseTo(g.H, 3);
        expect(Math.abs(lift(g.rend + 0.05) - lift(g.rend - 0.05))).toBeLessThan(1e-3);
        // Steepest climb (ramp plus the ground's rise) under maxClimb, sampled along the axis.
        let worst = 0;
        for (let a = g.apron1; a + 2 <= g.rend; a += 2) {
          const p = rampPoint(g, a, 0);
          const q = rampPoint(g, a + 2, 0);
          worst = Math.max(worst, (city.terrain.heightAt(q.x, q.z) - city.terrain.heightAt(p.x, p.z)) / 2);
        }
        expect(worst, `${seed} climb`).toBeLessThan(CFG.maxClimb + 0.03);
        // Exact gradients on the ramp and the kicker (finite differences away from their edges).
        const e = 0.002;
        for (let k = 0; k < 300; k++) {
          const onRamp = k % 2 === 0;
          const p = onRamp ? rampPoint(g, rng.range(g.apron0 + 0.5, g.rend - 0.5), rng.range(-g.rhw + 0.3, g.rhw - 0.3)) : W(g, rng.range(frontU(g, 0) + 0.2, g.kl + 2), rng.range(-g.hc + 0.3, g.hc - 0.3));
          const s = carParkHeight(g, p.x, p.z);
          const gx = (carParkHeight(g, p.x + e, p.z).h - carParkHeight(g, p.x - e, p.z).h) / (2 * e);
          const gz = (carParkHeight(g, p.x, p.z + e).h - carParkHeight(g, p.x, p.z - e).h) / (2 * e);
          expect(Math.abs(s.gx - gx) + Math.abs(s.gz - gz), `${seed} gradient`).toBeLessThan(1e-4);
          const ws = city.terrain.slopeAt(p.x, p.z);
          const wgx = (city.terrain.heightAt(p.x + e, p.z) - city.terrain.heightAt(p.x - e, p.z)) / (2 * e);
          expect(Math.abs(ws.gx - wgx)).toBeLessThan(1e-3);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('is walled where it is drawn: parapets off the roads, a low face under the lip, the flight clear of rails, closures and props', () => {
    let checked = 0;
    for (const seed of WITH.slice(0, 5)) {
      const city = createCity(seed);
      for (const g of carParks(city.districts.areas)) {
        const own = g.owner === ROUTE_INDEX.circuit ? 'circuit' : 'sprint';
        const other = own === 'circuit' ? 'sprint' : 'circuit';
        const w = createWorld(seed, own, city);
        const mine = w.walls.filter((x) => x.area === g.area);
        expect(mine.length).toBeGreaterThan(20);
        for (const wall of mine) {
          expect(wall.look).toBe('carPark');
          for (const tt of [0.1, 0.5, 0.9]) {
            const x = wall.ax + (wall.bx - wall.ax) * tt;
            const z = wall.az + (wall.bz - wall.az) * tt;
            for (const e of w.graph.edges) {
              const a = w.graph.nodes[e.a];
              const b = w.graph.nodes[e.b];
              const s = segmentT(x, z, a.x, a.z, b.x, b.z);
              if (s * e.length < 1.5 || (1 - s) * e.length < 1.5) continue;
              expect(distToSegment(x, z, a.x, a.z, b.x, b.z), `${seed} car park wall on a road`).toBeGreaterThan(e.width / 2 - 0.05);
            }
          }
        }
        // The face under the lip: low (a launching car is far above it), every other wall full height.
        const low = mine.filter((x) => x.top !== undefined);
        expect(low.length).toBeGreaterThanOrEqual(1);
        const front = W(g, -1.2, 0);
        for (const x of low) expect(x.top! - w.heightAt(front.x, front.z)).toBeCloseTo(g.H - 1.6, 6);
        // Nothing stands in the flight: from a meter past the lip to the furthest landing, every body a launch
        // can put there (the chute holds the car within hc of its line, the cone widens at the launch bound).
        const reach = g.landMax;
        const spread = Math.tan(LAUNCH_BOUND);
        const cone = [W(g, -1, -(g.hc + spread)), W(g, -reach, -(g.hc + reach * spread)), W(g, -reach, g.hc + reach * spread), W(g, -1, g.hc + spread)];
        for (const wall of w.walls) expect(touches(wall.ax, wall.az, wall.bx, wall.bz, cone), `${seed} ${wall.kind} ${wall.look} in the flight`).toBe(false);
        for (const p of w.props) expect(pointInPolygon(p.x, p.z, cone) && !w.coveredProps.includes(p.id), `${seed} ${p.kind} in the flight`).toBe(false);
        // The landing street's road takes the whole launch cone up to a typical landing (40 m out).
        const { C, t, half } = landing(city, g);
        for (const s of [0.5, 1]) {
          for (const side of [-1, 1]) {
            const d = 40 * s;
            const p = W(g, -d, side * (g.hc - CAR_HALF + d * spread));
            const lat = (p.x - C.x) * -t.z + (p.z - C.z) * t.x;
            const along = (p.x - C.x) * t.x + (p.z - C.z) * t.z;
            if (along > 0) expect(Math.abs(lat), `${seed} landing on the road`).toBeLessThan(half);
          }
        }
        // Its own route drives in; the other route finds a shutter across the ramp (free roam: open).
        const axis = (ww: World) => ww.walls.some((x) => x.area === g.area && touches(x.ax, x.az, x.bx, x.bz, [rampPoint(g, g.apron1 - 1, -0.2), rampPoint(g, g.apron1 + 1, -0.2), rampPoint(g, g.apron1 + 1, 0.2), rampPoint(g, g.apron1 - 1, 0.2)]));
        expect(axis(w)).toBe(false);
        expect(axis(createWorld(seed, other, city))).toBe(true);
        expect(axis(createWorld(seed, other, city, { openWorld: true }))).toBe(false);
        // Height-aware collision: the lip face stops a car at street level, not one at the roof's height.
        const contacts: Parameters<World['collideCircle']>[3] = [];
        const at = W(g, -0.6, 0);
        const hitLow = w.collideCircle(at.x, at.z, 0.9, contacts, w.heightAt(at.x, at.z) + 0.3);
        expect(contacts.slice(0, hitLow).some((x) => x.kind === 'wall')).toBe(true);
        expect(w.collideCircle(at.x, at.z, 0.9, contacts, low[0].top! + 1)).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it('a car climbs the ramp, crosses the roof and lands down the street in line, credited the stretch it skips', () => {
    let worstLaunch = 0;
    let worstLand = 0;
    let worstLat = 0;
    for (const seed of WITH.slice(0, 3)) {
      for (const bias of [0, 1.6, -1.6]) {
        const d = driveThrough(seed, bias);
        expect(d.launch, `${seed} ${bias} launched`).not.toBeNull();
        expect(d.land, `${seed} ${bias} landed`).not.toBeNull();
        // Off the roof: well above the street when it leaves the lip.
        expect(d.launch!.y).toBeGreaterThan(CFG.deckHeight);
        worstLaunch = Math.max(worstLaunch, Math.abs(d.launch!.hd));
        worstLand = Math.max(worstLand, Math.abs(d.land!.hd));
        worstLat = Math.max(worstLat, Math.abs(d.land!.lat) / d.half);
        // Down the street, on the road, in line with it.
        expect(d.land!.along).toBeGreaterThan(0);
        expect(Math.abs(d.land!.lat), `${seed} ${bias} lateral`).toBeLessThan(d.half);
        expect(d.land!.surface).toBe('road');
        // Progress is the route distance covered: the skipped stretch is credited in full, never lost.
        expect(Math.abs(d.gained - d.routeDist), `${seed} ${bias} progress`).toBeLessThan(1);
        expect(d.events.filter((e) => e === 'reset' || e === 'wrongWay')).toEqual([]);
      }
    }
    expect(worstLaunch).toBeLessThan(8);
    expect(worstLand).toBeLessThan(8);
    expect(worstLat).toBeLessThan(1);
  });

  it('is deterministic: the same drive twice gives the same race, bit for bit', () => {
    const seed = WITH[0];
    const a = driveThrough(seed, 0.8);
    const b = driveThrough(seed, 0.8);
    expect(carSnapshot(b.r)).toBe(carSnapshot(a.r));
  });

  it('stops street cars at the lip face: nobody drives up the cliff onto the roof', () => {
    const seed = WITH[1];
    const city = createCity(seed);
    const g = carParks(city.districts.areas)[0];
    const r = createRace(raceConfig(seed, g.owner === ROUTE_INDEX.circuit ? 'circuit' : 'sprint', 0));
    while (r.tick < r.countdownTicks) stepRace(r, NEUTRAL_INPUT);
    const c = r.cars[0].state;
    // On the far side of the street at the lip, heading straight at the face under it.
    const start = W(g, -g.lipBack - 6, 0);
    c.x = start.x;
    c.z = start.z;
    c.yaw = Math.atan2(g.ux, g.uz);
    c.y = r.world.driveHeightAt(c.x, c.z);
    c.vx = g.ux * 16;
    c.vz = g.uz * 16;
    c.yawRate = 0;
    r.cars[0].seg = -1;
    let maxUp = 0;
    for (let i = 0; i < 120; i++) {
      stepRace(r, { ...NEUTRAL_INPUT, throttle: 1 });
      maxUp = Math.max(maxUp, c.y - groundHeight(r.world)(c.x, c.z));
    }
    expect(maxUp).toBeLessThan(1);
    // Still in front of the building line.
    expect((c.x - g.ox) * g.ux + (c.z - g.oz) * g.uz).toBeLessThan(0);
  });
});
