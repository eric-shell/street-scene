import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { MOODS, MOOD_IDS, pickMood, skyParams } from '../src/render/weather';
import { AIR, blimpParams, blimpPoseAt, buildLoop, heliPoseAt, heliWaypoints, loopAt } from '../src/render/airTraffic';

describe('weather mood', () => {
  it('is a pure function of the seed, drawn roughly to the weights, with clear nights the most common', () => {
    const counts: Record<string, number> = {};
    const N = 4000;
    for (let seed = 1; seed <= N; seed++) {
      const m = pickMood(seed);
      expect(pickMood(seed)).toBe(m);
      counts[m] = (counts[m] ?? 0) + 1;
    }
    let total = 0;
    for (const id of MOOD_IDS) total += MOODS[id].weight;
    for (const id of MOOD_IDS) {
      const expected = (MOODS[id].weight / total) * N;
      expect(counts[id] ?? 0).toBeGreaterThan(expected * 0.7);
      expect(counts[id] ?? 0).toBeLessThan(expected * 1.3);
    }
    expect(counts.clear).toBeGreaterThan(Math.max(...MOOD_IDS.filter((m) => m !== 'clear').map((m) => counts[m] ?? 0)));
    const sky = skyParams(42);
    expect(skyParams(42)).toEqual(sky);
    expect(sky.moonPhase).toBeGreaterThan(0.1);
    expect(sky.moonPhase).toBeLessThan(0.9);
  });
});

describe('air traffic', () => {
  const world = createWorld(43405381, 'circuit');

  it('flies the helicopter round a closed loop that passes low over the route, as a pure function of time', () => {
    const points = heliWaypoints(world, world.seed);
    expect(heliWaypoints(world, world.seed)).toEqual(points);
    expect(points.length).toBe(AIR.heli.routePasses + AIR.heli.roamPoints);
    const loop = buildLoop(points);
    expect(loop.length).toBeGreaterThan(800);
    const period = loop.length / AIR.heli.speed;
    const pose = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 0 }, bank: 0 };
    const again = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 0 }, bank: 0 };
    let low = 0;
    for (let t = 0; t < period; t += period / 240) {
      heliPoseAt(loop, t, pose);
      heliPoseAt(loop, t + period, again);
      expect(Math.abs(pose.pos.x - again.pos.x)).toBeLessThan(0.05);
      expect(Math.abs(pose.pos.z - again.pos.z)).toBeLessThan(0.05);
      expect(Math.hypot(pose.fwd.x, pose.fwd.y, pose.fwd.z)).toBeCloseTo(1, 3);
      const alt = pose.pos.y - world.heightAt(pose.pos.x, pose.pos.z);
      expect(alt).toBeGreaterThan(30);
      const rp = world.routeProgress(pose.pos.x, pose.pos.z);
      if (Math.abs(rp.lateral) < 25 && alt < AIR.heli.lowAlt[1] + 10) low++;
      expect(Math.abs(pose.bank)).toBeLessThanOrEqual(0.45);
    }
    // It spends a real share of each lap low over the course.
    expect(low).toBeGreaterThan(10);
    // The loop is sampled evenly: neighbouring samples are equally spaced.
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    loopAt(loop, 100, a);
    loopAt(loop, 101, b);
    expect(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)).toBeCloseTo(1, 1);
  });

  it('drifts the blimp round downtown on a fixed circle', () => {
    const p = blimpParams(world, world.seed);
    expect(blimpParams(world, world.seed)).toEqual(p);
    const out = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
    const period = (2 * Math.PI * AIR.blimp.radius) / AIR.blimp.speed;
    blimpPoseAt(p, 10, out);
    const first = { ...out.pos };
    blimpPoseAt(p, 10 + period, out);
    expect(out.pos.x).toBeCloseTo(first.x, 3);
    expect(out.pos.z).toBeCloseTo(first.z, 3);
    expect(Math.hypot(out.pos.x - p.cx, out.pos.z - p.cz)).toBeCloseTo(AIR.blimp.radius, 3);
    expect(out.pos.y).toBeGreaterThanOrEqual(AIR.blimp.altitude[0] - 1e-6);
    expect(out.pos.y).toBeLessThanOrEqual(AIR.blimp.altitude[1] + 1e-6);
  });
});
