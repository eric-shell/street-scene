import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { MOODS, MOOD_IDS, pickMood, skyParams } from '../src/render/sky/weather';
import { CumulativeIntegral, MoodBlend, WEATHER_TURN, gustAt, moonVeil, weatherTimeline } from '../src/render/sky/weatherTimeline';
import { AIR, blimpParams, blimpPoseAt, buildLoop, heliPoseAt, heliWaypoints, loopAt } from '../src/render/traffic/airTraffic';

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

describe('weather timeline', () => {
  const N = 3000;
  const timelineOf = (seed: number) => weatherTimeline(seed, pickMood(seed));

  it('is a pure function of the seed, and about a third of seeds turn', () => {
    let turning = 0;
    for (let seed = 1; seed <= N; seed++) {
      const a = timelineOf(seed);
      expect(JSON.stringify(a.turn)).toBe(JSON.stringify(timelineOf(seed).turn));
      if (a.turn) turning++;
    }
    expect(turning).toBeGreaterThan(N * 0.3);
    expect(turning).toBeLessThan(N * 0.4);
  });

  it('takes one allowed step, 60 to 240 s in over 40 to 90 s, and is done within the window', () => {
    const allowed = new Set(['clear>hazy', 'hazy>drizzle', 'misty>drizzle', 'drizzle>rain', 'rain>drizzle']);
    const seen = new Set<string>();
    for (let seed = 1; seed <= N; seed++) {
      const { turn, start } = timelineOf(seed);
      if (!turn) continue;
      expect(turn.from).toBe(start);
      expect(allowed.has(`${turn.from}>${turn.to}`)).toBe(true);
      seen.add(`${turn.from}>${turn.to}`);
      expect(turn.at).toBeGreaterThanOrEqual(WEATHER_TURN.start[0]);
      expect(turn.at).toBeLessThanOrEqual(WEATHER_TURN.start[1]);
      expect(turn.duration).toBeGreaterThanOrEqual(WEATHER_TURN.duration[0]);
      expect(turn.duration).toBeLessThanOrEqual(WEATHER_TURN.duration[1]);
      expect(turn.at + turn.duration).toBeLessThanOrEqual(WEATHER_TURN.window);
    }
    // Every step shows up over enough seeds.
    expect(seen.size).toBe(allowed.size);
  });

  it('blends continuously: no jump larger than the step\'s own slope allows, and no blend without a turn', () => {
    const blend: MoodBlend = { from: 'clear', to: 'clear', t: 0 };
    const dt = 0.1;
    for (let seed = 1; seed <= 400; seed++) {
      const tl = timelineOf(seed);
      let prev = tl.moodAt(0, blend).t;
      expect(prev).toBe(0);
      // A smoothstep over `duration` seconds climbs at most 1.5 / duration per second.
      const maxStep = tl.turn ? (1.5 / tl.turn.duration) * dt + 1e-9 : 0;
      for (let t = dt; t <= 400; t += dt) {
        tl.moodAt(t, blend);
        expect(blend.from).toBe(tl.start);
        expect(Math.abs(blend.t - prev)).toBeLessThanOrEqual(maxStep);
        expect(blend.t).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = blend.t;
      }
      expect(prev).toBe(tl.turn ? 1 : 0);
    }
  });

  it('gusts are pure, bounded to 1..2, and more frequent in rain than in clear air', () => {
    let calm = 0;
    let wet = 0;
    for (let t = 0; t < 3000; t += 0.5) {
      const a = gustAt(77, t, 0);
      const b = gustAt(77, t, 1);
      expect(gustAt(77, t, 1)).toBe(b);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(2);
      if (a > 1.05) calm++;
      if (b > 1.05) wet++;
    }
    expect(wet).toBeGreaterThan(calm);
    // Continuous: a 0.1 s step never moves the factor much.
    let prev = gustAt(5, 0, 1);
    for (let t = 0.1; t < 600; t += 0.1) {
      const g = gustAt(5, t, 1);
      expect(Math.abs(g - prev)).toBeLessThan(0.2);
      prev = g;
    }
  });

  it('veils the moon on the clock, deeper with overcast, and integrates a changing rate without jumps', () => {
    let min0 = 1;
    let min1 = 1;
    for (let t = 0; t < 1200; t += 1) {
      const a = moonVeil(9, t, 0);
      const b = moonVeil(9, t, 1);
      expect(moonVeil(9, t, 1)).toBe(b);
      min0 = Math.min(min0, a);
      min1 = Math.min(min1, b);
      expect(a).toBeGreaterThan(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    expect(min0).toBeLessThan(0.9);
    expect(min1).toBeLessThan(min0);
    const ramp = new CumulativeIntegral((t) => 2 + Math.min(1, t / 100));
    // Asked in any order, the integral is the same: it is a function of t.
    const late = ramp.at(500);
    const early = ramp.at(30);
    expect(new CumulativeIntegral((t) => 2 + Math.min(1, t / 100)).at(30)).toBeCloseTo(early, 9);
    expect(ramp.at(500)).toBe(late);
    expect(late).toBeCloseTo(2 * 500 + 50 + 400, 0);
    let prev = ramp.at(0);
    for (let t = 0.03; t < 600; t += 0.03) {
      const v = ramp.at(t);
      expect(v - prev).toBeGreaterThan(0);
      expect(v - prev).toBeLessThan(0.03 * 3.01);
      prev = v;
    }
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
