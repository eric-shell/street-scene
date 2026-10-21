import { describe, expect, it } from 'vitest';
import { createCity, createRoute, createWorld } from '../src/city/world';
import { DRAG_DISTANCE, routeSample } from '../src/city/route';
import { ROUTE } from '../src/city/config';
import { createRace, roadDistance, stepRace } from '../src/sim/race';
import { NEUTRAL_INPUT } from '../src/sim/input';
import { DEG, abs, atan2 } from '../src/sim/math';
import { carSnapshot, raceConfig, replayLog, runAutopilot } from './helpers';

const SEEDS = [11, 404, 20261019];

describe('drag strip', () => {
  it('runs seven blocks down a straight from a two wide grid, the same strip every time', () => {
    for (const seed of SEEDS) {
      const city = createCity(seed);
      const route = createRoute(city, 'drag');
      expect(JSON.stringify(createRoute(city, 'drag').nodes)).toBe(JSON.stringify(route.nodes));
      expect(route.closed).toBe(false);
      // Seven blocks, or on a city with no straight that long (seed 404's longest is about 1.1 km) its longest one.
      expect(DRAG_DISTANCE).toBe(7 * 140);
      expect(route.finishS - route.startS).toBeCloseTo(Math.min(DRAG_DISTANCE, route.length - route.startS - ROUTE.dragRunout), 3);
      if (seed !== 404) expect(route.finishS - route.startS).toBeCloseTo(DRAG_DISTANCE, 3);
      expect(route.length - route.finishS).toBeGreaterThanOrEqual(ROUTE.dragRunout);
      const g = city.graph;
      // Seed 404 has no 7 block run at the strictest bend, so it is checked at the gentler fallback.
      const bend = seed === 404 ? ROUTE.dragBendDeg[ROUTE.dragBendDeg.length - 1] : ROUTE.dragBendDeg[0];
      for (let i = 1; i + 1 < route.nodes.length; i++) {
        const [a, b, c] = [g.nodes[route.nodes[i - 1]], g.nodes[route.nodes[i]], g.nodes[route.nodes[i + 1]]];
        const turn = atan2((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z));
        expect(abs(turn) / DEG, `seed ${seed} node ${i}`).toBeLessThanOrEqual(bend + 1e-9);
      }
      for (const n of route.nodes) expect(g.nodes[n].ring).toBeUndefined();
      for (const e of route.edges) {
        // Street bridges over the river are fine, the drawbridge never.
        expect(city.districts.areas.some((a) => a.kind === 'river' && a.params.drawbridge === e)).toBe(false);
        expect(g.edges[e].crossing).toBeUndefined();
      }
      // Two cars side by side on the line, the player's (slot 1) in the right hand lane.
      const [rival, me] = route.grid;
      expect(me.s).toBe(rival.s);
      const p = routeSample(route, me.s);
      const side = (s: { x: number; z: number }) => (s.x - p.x) * p.tz - (s.z - p.z) * p.tx;
      expect(side(me)).toBeLessThan(-1);
      expect(side(rival)).toBeGreaterThan(1);
    }
  });

  it('is head to head: one rival whatever the config asks, both finish, and it replays bit for bit', () => {
    const cfg = raceConfig(SEEDS[0], 'drag', 3);
    const r = runAutopilot(cfg, 60, true);
    expect(r.cars.length).toBe(2);
    expect(r.cars.every((c) => c.finished)).toBe(true);
    expect(r.events.filter((e) => e.type === 'reset').length).toBe(0);
    const t = (r.cars[0].finishTick - r.countdownTicks) / 60;
    expect(t).toBeGreaterThan(15);
    expect(t).toBeLessThan(45);
    expect(carSnapshot(replayLog(cfg, r.inputLog))).toBe(carSnapshot(r));
  });

  it('a finished rival brakes to a stop in the runout, short of the end of the strip', () => {
    const r = runAutopilot(raceConfig(SEEDS[1], 'drag', 1), 60, true);
    const route = r.world.route;
    // Both cars are past the line: the runout drives them, the player's input no longer counts.
    for (let i = 0; i < 15 * 60; i++) stepRace(r, NEUTRAL_INPUT);
    for (const c of r.cars) {
      expect(c.state.speed).toBeLessThan(1);
      expect(c.rawS).toBeLessThan(route.length);
      expect(c.rawS).toBeGreaterThan(route.finishS);
    }
  });
});

describe('waypoint race', () => {
  it('strings its waypoints along the suggested route, the finish line last, with fields of distance by road', () => {
    for (const seed of SEEDS) {
      const city = createCity(seed);
      const route = createRoute(city, 'waypoint');
      const wps = route.waypoints!;
      expect(wps.length).toBe(ROUTE.waypointCount + 1);
      expect(route.checkpoints).toEqual(wps.map((w) => w.s));
      for (let i = 1; i < wps.length; i++) expect(wps[i].s).toBeGreaterThan(wps[i - 1].s);
      expect(wps[wps.length - 1].s).toBe(route.finishS);
      expect(route.finishS - route.startS).toBeGreaterThan(1500);
      // The suggestion never visits a node twice.
      expect(new Set(route.nodes).size).toBe(route.nodes.length);
      // Distance by road shrinks as a car comes down the suggested route to each target.
      const world = createWorld(seed, 'waypoint', city, { openWorld: true });
      for (const w of wps) {
        let last = Infinity;
        for (let s = w.s - 300; s <= w.s; s += 25) {
          const p = routeSample(route, s);
          const d = roadDistance(world, w, p.x, p.z);
          expect(d, `seed ${seed} s ${s}`).toBeLessThanOrEqual(last + 1);
          last = d;
        }
        expect(last).toBeLessThan(w.radius);
      }
    }
  });

  it('runs in the open city but as a race: no barriers, a countdown, rivals', () => {
    const r = createRace(raceConfig(SEEDS[0], 'waypoint', 3));
    expect(r.world.openWorld).toBe(true);
    expect(r.world.barrierGroups.length).toBe(0);
    expect(r.config.openWorld).toBeFalsy();
    expect(r.countdownTicks).toBeGreaterThan(0);
    expect(r.cars.length).toBe(4);
  });

  it('the field reaches every waypoint in order and finishes, and the race replays bit for bit', () => {
    const cfg = raceConfig(SEEDS[1], 'waypoint', 3);
    const r = runAutopilot(cfg, 400, true);
    const n = r.world.route.waypoints!.length;
    for (const c of r.cars) {
      expect(c.finished, c.name).toBe(true);
      const reached = r.events.filter((e) => e.type === 'checkpoint' && e.car === c.index).map((e) => e.value);
      expect(reached).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(r.events.filter((e) => e.type === 'reset' && e.car === c.index).length, c.name).toBeLessThanOrEqual(3);
    }
    const a = replayLog(cfg, r.inputLog);
    expect(carSnapshot(a)).toBe(carSnapshot(r));
    expect(carSnapshot(replayLog(cfg, r.inputLog))).toBe(carSnapshot(a));
  });
});
