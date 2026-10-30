/**
 * Starting off the grid (RaceConfig.start): free roam taken over from the
 * menu puts the player where the menu's car was, rolling, on the tick the
 * menu city showed. The menu's cruise (game/streetStage.ts Cruise) then
 * drives the sim car along its lane until the player takes over.
 */
import { describe, expect, it } from 'vitest';
import { createCity, createWorld } from '../src/city/world';
import { createRace, raceTime, stepRace, type RaceConfig } from '../src/sim/race';
import { wheelRpm } from '../src/sim/car';
import { NEUTRAL_INPUT, type InputFrame } from '../src/sim/input';
import { DT, TICK_HZ } from '../src/sim/constants';
import { DEG } from '../src/sim/math';
import { Cruise, CRUISE } from '../src/game/cruise';
import { carSnapshot, input, raceConfig } from './helpers';

const roam = (seed: number, start?: RaceConfig['start']): RaceConfig => ({ ...raceConfig(seed, 'circuit', 0), openWorld: true, traffic: true, start });

/**
 * Where the stage car would be: a point on the cruise path, with its heading and the ground height
 * it is on, followed along the path from its start as the stage does (under a channel bridge the route
 * may run on the channel floor beneath the deck).
 */
function onPath(cruise: Cruise, s: number) {
  const probe = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
  let y: number | undefined;
  for (let u = 0; u < s; u += 1) {
    const q = cruise.path.sample(u, probe);
    y = cruise.world.heightAt(q.x, q.z, y);
  }
  const c = cruise.path.sample(s, probe);
  return { x: c.x, z: c.z, y: cruise.world.heightAt(c.x, c.z, y), yaw: c.yaw };
}

describe('start pose', () => {
  const seed = 20261021;
  const city = createCity(seed);
  const world = createWorld(seed, 'circuit', city, { openWorld: true });
  const cruise = new Cruise(world);

  it('puts the player there, rolling, on the given tick, with the gear and revs to match', () => {
    const at = onPath(cruise, 120);
    const start = { ...at, speed: 15, tick: 4980 };
    const r = createRace(roam(seed, start), world);
    const c = r.cars[0].state;
    expect(c.x).toBe(at.x);
    expect(c.z).toBe(at.z);
    expect(c.yaw).toBe(at.yaw);
    expect(Math.hypot(c.vx, c.vz)).toBeCloseTo(15, 6);
    expect(c.speed).toBe(15);
    expect(c.wheelSpeedRear).toBe(15);
    // The lowest gear that keeps the revs under the automatic's shift point, and the revs that gear gives at this speed.
    const t = r.cars[0].tuning;
    const up = t.gearbox.upshiftRpmFrac * t.engine.redline;
    expect(wheelRpm(t, c.gear, 15)).toBeLessThanOrEqual(up);
    expect(c.gear === 1 || wheelRpm(t, c.gear - 1, 15) > up).toBe(true);
    expect(c.rpm).toBeCloseTo(Math.max(t.engine.idleRpm, wheelRpm(t, c.gear, 15)), 9);
    expect(c.rpm).toBeLessThan(t.engine.redline);
    expect(r.tick).toBe(4980);
    expect(r.phase).toBe('countdown');
    expect(r.countdownTicks).toBe(0);
    expect(raceTime(r)).toBe(0);
    // Already rolling: the first ticks neither lock the wheels nor shift about.
    const gear = c.gear;
    for (let i = 0; i < 30; i++) stepRace(r, input({ throttle: 0.2 }));
    expect(c.gear).toBe(gear);
    expect(c.speed).toBeGreaterThan(13);
    expect(r.events.filter((e) => e.type === 'wall' || e.type === 'reset')).toEqual([]);
    expect(raceTime(r)).toBeCloseTo(30 / TICK_HZ, 9);
  });

  it('is deterministic and the same for a replayed config', () => {
    const start = { ...onPath(cruise, 400), speed: 12, tick: 777 };
    const run = () => {
      const r = createRace(roam(seed, start), world);
      for (let i = 0; i < 120; i++) stepRace(r, input({ throttle: i < 60 ? 0.6 : 0, steer: i > 30 ? 0.3 : 0 }));
      return carSnapshot(r) + JSON.stringify(r.traffic?.cars.map((c) => [c.body.x, c.body.z, c.mode]));
    };
    expect(run()).toBe(run());
  });

  it('changes nothing about a grid start, and is ignored outside the open world', () => {
    const grid = () => {
      const r = createRace(raceConfig(seed, 'circuit', 2));
      for (let i = 0; i < 90; i++) stepRace(r, input({ throttle: 1 }));
      return carSnapshot(r) + r.tick;
    };
    const before = grid();
    const r = createRace({ ...raceConfig(seed, 'circuit', 2), start: { ...onPath(cruise, 200), speed: 20, tick: 500 } });
    expect(r.tick).toBe(0);
    expect(r.cars[0].state.speed).toBe(0);
    for (let i = 0; i < 90; i++) stepRace(r, input({ throttle: 1 }));
    expect(carSnapshot(r) + r.tick).toBe(before);
  });

  it('spawns its traffic out of sight, as respawns are', () => {
    const start = { ...onPath(cruise, 120), speed: 15, tick: 60 };
    const r = createRace(roam(seed, start), world);
    const p = r.cars[0].state;
    // The moving fleet (the kerb's parked cars stand where they are parked).
    const near = r.traffic!.cars.filter((c) => c.home < 0 && c.mode !== 'gone' && Math.hypot(c.body.x - p.x, c.body.z - p.z) < 150);
    expect(near).toEqual([]);
    expect(r.traffic!.cars.some((c) => c.mode !== 'gone')).toBe(true);
  });
});

describe('the cruise at the wheel', () => {
  /** Drive from path distance s0 for `seconds` with the cruise's own inputs; the worst lane error (m) and the lowest speed after the first second. */
  function cruiseFor(seed: number, s0: number, seconds: number) {
    const world = createWorld(seed, 'circuit', createCity(seed), { openWorld: true });
    const cruise = new Cruise(world);
    const r = createRace(roam(seed, { ...onPath(cruise, s0), speed: CRUISE.speed, tick: 0 }), world);
    const rc = r.cars[0];
    const st = rc.tuning.steering;
    const frame: InputFrame = { ...NEUTRAL_INPUT };
    const probe = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
    let s = s0;
    let worst = 0;
    let slowest = Infinity;
    for (let i = 0; i < seconds * TICK_HZ; i++) {
      const c = rc.state;
      const limit = (st.maxDeg + (st.highSpeedDeg - st.maxDeg) * Math.max(0, Math.min(1, c.speed / st.fadeSpeed))) * DEG;
      s = cruise.drive(s, c.x, c.z, c.yaw, c.speed, r.tick * DT, { wheelbase: rc.tuning.geometry.wheelbase, steerLimit: limit }, frame);
      stepRace(r, frame);
      const p = cruise.path.sample(s, probe);
      // Until a civilian car runs into it: the cruise keeps its lane, it does not dodge traffic (see the events below).
      if (!r.events.some((e) => e.type === 'crash' && (e as { traffic?: number }).traffic !== undefined)) worst = Math.max(worst, Math.hypot(c.x - p.x, c.z - p.z));
      if (i > TICK_HZ) slowest = Math.min(slowest, c.speed);
    }
    // Walls, resets and crashes into the city, up to a civilian car running into it: a civilian car in the lane is the
    // player's to dodge (the cruise follows its lane and never steers round traffic, as the menu car never had to), and
    // where one shoves the car off its lane the hits that follow are the crash's.
    const hit = r.events.find((e) => e.type === 'crash' && (e as { traffic?: number }).traffic !== undefined);
    const until = hit ? hit.tick : Infinity;
    return { worst, slowest, events: r.events.filter((e) => e.tick < until && (e.type === 'wall' || e.type === 'reset' || e.type === 'crash') && (e as { traffic?: number }).traffic === undefined), speed: rc.state.speed, r };
  }

  it('keeps the car on the lane at the cruise speed, clear of walls, from several points on several cities', () => {
    for (const seed of [20261021, 7, 42]) {
      for (const s0 of [60, 500, 1100]) {
        const d = cruiseFor(seed, s0, 12);
        // The lane line rounds a right angle in 3-5 m, which full lock cannot quite follow: the car runs up to
        // about 1.9 m wide there (still on the road), well under 1 m everywhere else. The curved grid's
        // sharper corners (a turn of up to about 115 degrees, roadGraph.ts CITY.warp) take it to about 2.7 m
        // (2.4 m before the grip pass, when the cars oversteered a little below the limit and so turned
        // tighter than the lock asked for).
        expect(d.worst, `seed ${seed} from ${s0}: lane error`).toBeLessThan(2.9);
        expect(d.events, `seed ${seed} from ${s0}: hits`).toEqual([]);
        // Held near the cruise speed, bar the corners and gates it slows for.
        expect(d.speed, `seed ${seed} from ${s0}: speed`).toBeGreaterThan(3);
      }
    }
  });

  it('holds the cruise speed on a straight within a couple of m/s', () => {
    const d = cruiseFor(20261021, 60, 8);
    expect(Math.abs(d.speed - CRUISE.speed)).toBeLessThan(2.5);
  });

  it('eases to a stop on its lane when asked to (nobody at the wheel after the handoff)', () => {
    const seed = 20261021;
    const world = createWorld(seed, 'circuit', createCity(seed), { openWorld: true });
    const cruise = new Cruise(world);
    const r = createRace(roam(seed, { ...onPath(cruise, 60), speed: CRUISE.speed, tick: 0 }), world);
    const rc = r.cars[0];
    const st = rc.tuning.steering;
    const frame: InputFrame = { ...NEUTRAL_INPUT };
    const probe = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
    let s = 60;
    let stoppedAt = -1;
    let decel = 0;
    for (let i = 0; i < 20 * TICK_HZ; i++) {
      const c = rc.state;
      const limit = (st.maxDeg + (st.highSpeedDeg - st.maxDeg) * Math.max(0, Math.min(1, c.speed / st.fadeSpeed))) * DEG;
      const letGo = i >= 3 * TICK_HZ;
      s = cruise.drive(s, c.x, c.z, c.yaw, c.speed, r.tick * DT, { wheelbase: rc.tuning.geometry.wheelbase, steerLimit: limit }, frame, letGo ? { target: 0, maxBrake: 0.12 } : {});
      stepRace(r, frame);
      if (letGo) decel = Math.max(decel, -c.aLong);
      if (letGo && c.speed < 0.3) {
        stoppedAt = i / TICK_HZ;
        break;
      }
    }
    // Stopped within a few seconds of letting go, gently (a road car's stop, not a race brake), still on the lane.
    expect(stoppedAt).toBeGreaterThan(3);
    expect(stoppedAt).toBeLessThan(12);
    expect(decel).toBeLessThan(5);
    const p = cruise.path.sample(s, probe);
    expect(Math.hypot(rc.state.x - p.x, rc.state.z - p.z)).toBeLessThan(2);
    expect(r.events.filter((e) => e.type === 'wall' || e.type === 'crash')).toEqual([]);
  });
});
