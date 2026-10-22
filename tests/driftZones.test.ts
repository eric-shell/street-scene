import { describe, expect, it } from 'vitest';
import { createRace, RaceState, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { DT, TICK_HZ } from '../src/sim/constants';
import { DEG } from '../src/sim/math';
import { DRIFT_ZONES } from '../src/sim/tuning';
import { driftZoneAt, driftZoneKind, driftZones, stepDriftZones } from '../src/sim/driftZones';
import { createCity } from '../src/city/world';
import type { World } from '../src/city/world';
import { distToPolygonEdge, pointInPolygon, polygonCentroid } from '../src/city/districts/geom';
import { carSnapshot, input, raceConfig } from './helpers';

/**
 * Seeds whose city has a monument plaza, and the first of them (city generation may move it between seeds).
 * Seed 6 joined when the curved grid (roadGraph.ts CITY.warp) moved seed 1234's plaza off its runways.
 */
const PLAZA_SEEDS = [99, 7, 123, 31337, 42, 1234, 2024, 5, 6].filter((s) => createCity(s).districts.areas.some((a) => a.kind === 'monument'));
const PLAZA_SEED = PLAZA_SEEDS[0];

function driftRace(seed: number): RaceState {
  const r = createRace({ ...raceConfig(seed, 'drift', 0), laps: 1 });
  while (r.tick < r.countdownTicks) stepRace(r, input({}));
  return r;
}

/** A point well inside a zone (its centroid when that is inside, else a point stepped in from a corner). */
function insidePoint(poly: { x: number; z: number }[]): { x: number; z: number } {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c.x, c.z, poly)) return c;
  const p = poly[0];
  return { x: p.x + (c.x - p.x) * 0.2, z: p.z + (c.z - p.z) * 0.2 };
}

/**
 * Straight runs across the plaza for the scripted drift, nearest the route first (a car far off
 * the course for long counts as lost): 90 m of paving ahead clear of walls, props and the plaza
 * edge, heading the route's way so the drift is not wrong way, one per start cell. Searched, so
 * the scenario holds wherever city generation puts the plaza and the routes.
 */
function plazaRunways(world: World): { x: number; z: number; yaw: number; off: number }[] {
  const plaza = driftZones(world).find((z) => z.kind === 'plaza')!;
  const poly = plaza.polygon;
  const props = world.props.filter((p) => p.x > plaza.minX - 5 && p.x < plaza.maxX + 5 && p.z > plaza.minZ - 5 && p.z < plaza.maxZ + 5);
  const clear = 8;
  const out: { x: number; z: number; yaw: number; off: number }[] = [];
  for (let x = plaza.minX; x <= plaza.maxX; x += 6) {
    for (let z = plaza.minZ; z <= plaza.maxZ; z += 6) {
      const p = world.routeProgress(x, z);
      if (Math.abs(p.lateral) > 55) continue;
      for (let k = 0; k < 16; k++) {
        const yaw = (k / 16) * Math.PI * 2;
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        if (p.tx * fx + p.tz * fz < 0.6) continue;
        let ok = true;
        for (let d = 0; d <= 90 && ok; d += 3) {
          const px = x + fx * d;
          const pz = z + fz * d;
          ok = pointInPolygon(px, pz, poly) && distToPolygonEdge(px, pz, poly) >= clear && world.wallClearance(px, pz, clear) >= clear && props.every((q) => Math.hypot(q.x - px, q.z - pz) > clear);
        }
        if (ok) {
          out.push({ x, z, yaw, off: Math.abs(p.lateral) });
          break;
        }
      }
    }
  }
  return out.sort((u, v) => u.off - v.off || u.x - v.x || u.z - v.z);
}

describe('drift zones', () => {
  it('are the monument plaza and the lots big enough to drift in, the same list every time', () => {
    expect(PLAZA_SEED).toBeDefined();
    const r = driftRace(PLAZA_SEED);
    const zones = driftZones(r.world);
    expect(driftZones(r.world)).toBe(zones);
    expect(zones.filter((z) => z.kind === 'plaza').length).toBe(1);
    for (const z of zones) {
      const a = r.world.areas[z.area];
      expect(driftZoneKind(a)).toBe(z.kind);
      if (z.kind === 'lot') {
        expect(a.params.depth).toBeGreaterThanOrEqual(DRIFT_ZONES.minLotDepth);
        expect(a.params.length * a.params.depth).toBeGreaterThanOrEqual(DRIFT_ZONES.minLotArea);
      }
      const p = insidePoint(z.polygon);
      expect(driftZoneAt(zones, p.x, p.z)).toBe(z.index);
    }
    // Small lots and every other area are not zones.
    for (const a of r.world.areas) if (a.kind === 'infill' && a.variant === 'lot' && a.params.depth < DRIFT_ZONES.minLotDepth) expect(driftZoneKind(a)).toBeNull();
    expect(driftZoneAt(zones, 1e6, 1e6)).toBe(-1);
  });

  it('multiply the score and the drift refill only inside a zone, bounded per visit, then rest', () => {
    const r = driftRace(PLAZA_SEED);
    const zones = driftZones(r.world);
    const plaza = zones.find((z) => z.kind === 'plaza')!;
    const rc = r.cars[0];
    const c = rc.state;
    const v = r.driftZones.cars[0];
    const drift = () => {
      c.drifting = true;
      c.slipAngle = 40 * DEG;
      c.speed = 18;
    };
    // Outside every zone: no multiplier, no extra nitrous.
    c.x = 1e6;
    c.z = 1e6;
    c.nitro = 0;
    drift();
    stepDriftZones(r);
    expect(v.zone).toBe(-1);
    expect(v.scoreMul).toBe(1);
    expect(c.nitro).toBe(0);
    // Inside: double points and (refillMul - 1) x the drift refill on top of the regular one.
    const p = insidePoint(plaza.polygon);
    c.x = p.x;
    c.z = p.z;
    drift();
    stepDriftZones(r);
    expect(v.zone).toBe(plaza.index);
    expect(v.scoreMul).toBe(DRIFT_ZONES.scoreMul);
    expect(c.nitro).toBeCloseTo(rc.tuning.nitrous.refillDrift * (DRIFT_ZONES.refillMul - 1) * DT, 9);
    // Not drifting: in the zone, but nothing paid.
    c.drifting = false;
    const before = c.nitro;
    stepDriftZones(r);
    expect(v.scoreMul).toBe(1);
    expect(c.nitro).toBe(before);
    // The visit pays for bonusTime of drifting and refillCap of a tank at most.
    let ticks = 0;
    for (let i = 0; i < DRIFT_ZONES.bonusTime * TICK_HZ * 2; i++) {
      drift();
      stepDriftZones(r);
      if (v.scoreMul > 1) ticks++;
      r.tick++;
    }
    expect(ticks).toBeLessThanOrEqual(Math.ceil(DRIFT_ZONES.bonusTime * TICK_HZ));
    expect(ticks).toBeGreaterThan(DRIFT_ZONES.bonusTime * TICK_HZ - 3);
    expect(c.nitro).toBeLessThanOrEqual(DRIFT_ZONES.refillCap + 1e-9);
    expect(c.nitro).toBeGreaterThan(DRIFT_ZONES.refillCap - 1e-6);
    expect(v.scoreMul).toBe(1);
    // A brief exit keeps the visit; a long one ends it and rests the zone.
    c.x = 1e6;
    stepDriftZones(r);
    expect(v.zone).toBe(plaza.index);
    for (let i = 0; i < DRIFT_ZONES.exitGrace * TICK_HZ + 2; i++) {
      stepDriftZones(r);
      r.tick++;
    }
    expect(v.zone).toBe(-1);
    // Straight back in: the zone is resting, so a cold visit pays nothing.
    c.x = p.x;
    c.nitro = 0;
    drift();
    stepDriftZones(r);
    expect(v.zone).toBe(plaza.index);
    expect(v.fresh).toBe(false);
    expect(v.scoreMul).toBe(1);
    expect(c.nitro).toBe(0);
    // After the cooldown a new visit pays again.
    c.x = 1e6;
    for (let i = 0; i < DRIFT_ZONES.exitGrace * TICK_HZ + 2; i++) stepDriftZones(r);
    r.tick += Math.round(DRIFT_ZONES.cooldown * TICK_HZ) + 1;
    c.x = p.x;
    drift();
    stepDriftZones(r);
    expect(v.fresh).toBe(true);
    expect(v.scoreMul).toBe(DRIFT_ZONES.scoreMul);
  });

  it('a visit without drifting does not rest the zone', () => {
    const r = driftRace(PLAZA_SEED);
    const plaza = driftZones(r.world).find((z) => z.kind === 'plaza')!;
    const c = r.cars[0].state;
    const v = r.driftZones.cars[0];
    const p = insidePoint(plaza.polygon);
    c.x = p.x;
    c.z = p.z;
    c.drifting = false;
    stepDriftZones(r);
    c.x = 1e6;
    for (let i = 0; i < DRIFT_ZONES.exitGrace * TICK_HZ + 2; i++) stepDriftZones(r);
    c.x = p.x;
    stepDriftZones(r);
    expect(v.fresh).toBe(true);
  });

  it('a drift banked on the plaza carries the zone bonus, deterministically', () => {
    /** Accelerate down the run, flick it sideways, hold the slide, brake; the race as it stands after. */
    const run = (world: World, at: { x: number; z: number; yaw: number }) => {
      const r = createRace({ ...raceConfig(world.seed, 'drift', 0), laps: 1 }, world);
      while (r.tick < r.countdownTicks) stepRace(r, input({}));
      const rc = r.cars[0];
      placeCar(rc.state, at.x, at.z, at.yaw, r.world);
      rc.state.nitro = 0;
      for (let i = 0; i < 60 * 6; i++) {
        const c = rc.state;
        if (i < 170) stepRace(r, input({ throttle: 1 }));
        else if (i < 192) stepRace(r, input({ throttle: 0.7, steer: -1, handbrake: true }));
        else if (i < 260) stepRace(r, input({ throttle: 0.9, steer: Math.max(-1, Math.min(1, -c.slipAngle / (25 * DEG))) * 0.6 }));
        else stepRace(r, input({ brake: 1 }));
      }
      return r;
    };
    // The slide wanders off the straight line, so try the runs nearest the drift circuit until one banks
    // clean, on the first plaza seed whose circuit passes close enough (a car far off it is put back).
    const zonedBanks = (r: ReturnType<typeof run>) => r.events.filter((e) => e.type === 'driftBank' && (e.other ?? 0) > 0);
    let found: { world: World; at: { x: number; z: number; yaw: number } } | null = null;
    for (const seed of PLAZA_SEEDS) {
      const world = driftRace(seed).world;
      const at = plazaRunways(world).slice(0, 12).find((c) => zonedBanks(run(world, c)).length > 0);
      if (at) {
        found = { world, at };
        break;
      }
    }
    expect(found).not.toBeNull();
    const a = run(found!.world, found!.at);
    const b = run(found!.world, found!.at);
    expect(carSnapshot(a)).toBe(carSnapshot(b));
    expect(JSON.stringify(a.drift)).toBe(JSON.stringify(b.drift));
    expect(JSON.stringify(a.driftZones)).toBe(JSON.stringify(b.driftZones));
    const zoned = zonedBanks(a);
    expect(zoned.length).toBeGreaterThan(0);
    // The bonus is the zone's share of the banked points: at most (scoreMul - 1) / scoreMul of them.
    for (const e of zoned) expect(e.other!).toBeLessThanOrEqual(Math.ceil(((e.value ?? 0) * (DRIFT_ZONES.scoreMul - 1)) / DRIFT_ZONES.scoreMul) + 1);
  });
});
