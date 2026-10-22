import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createWorld, planRoads } from '../src/city/world';
import type { World } from '../src/city/world';
import { buildRoute, routeSample } from '../src/city/route';
import { DRAWBRIDGE, buildTimedGates, leafAngle, onSpan, spanCoords } from '../src/city/drawbridge';
import { blockTicks, gateBlocking, gatePhase, gateSide, waitingAtGate } from '../src/sim/gates';
import { WALL_LOOKS } from '../src/city/districts/types';
import { isRiverEdge } from '../src/city/roadGraph';
import { createRace, stepRace } from '../src/sim/race';
import type { RaceState } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { autopilotInput, createAi } from '../src/sim/ai';
import { TICK_HZ } from '../src/sim/constants';
import { distToSegment, yawOf } from '../src/sim/math';
import { carSnapshot, input, raceConfig, replayLog, runAutopilot } from './helpers';

/**
 * The first seed of a stream whose circuit crosses its drawbridge on top, coming to it along plain
 * streets (no ramp out of the river channel within two edges of it, which the AI crawls through:
 * the gate tests want it at the line early in the block). planRoads only: cheap.
 */
function drawbridgeCircuitSeed(stream: number): number {
  const rng = new Rng(stream);
  for (let i = 0; i < 80; i++) {
    const seed = rng.int(0, 0x7fffffff);
    const plan = planRoads(seed);
    const river = plan.districts.areas.find((a) => a.kind === 'river');
    if (river?.params.drawbridge === undefined) continue;
    const g = plan.graph;
    const route = buildRoute(g, 'circuit', plan.routeNodes.circuit);
    const i0 = route.edges.indexOf(river.params.drawbridge);
    if (i0 < 0) continue;
    const n = route.edges.length;
    const plain = [-2, -1, 1, 2].every((k) => !isRiverEdge(g.edges[route.edges[(i0 + k + n) % n]]));
    if (plain) return seed;
  }
  throw new Error('no seed with a circuit over its drawbridge');
}

/** First tick the gates block in the cycle after `after`. */
function nextBlock(w: World, after: number): number {
  const c = w.timedGates!.cycles[0];
  const p = gatePhase(c, after);
  return after + p.untilBlock;
}

/** An open world race on a seed (no opponents, no route resets) with the clock moved to `tick`. */
function freeRoam(seed: number, tick: number): RaceState {
  const r = createRace({ ...raceConfig(seed, 'circuit', 0), openWorld: true });
  r.tick = tick;
  r.phase = 'racing';
  return r;
}

describe('drawbridge', () => {
  it('runs a pure schedule: open at the start, blocked about a fifth of the time, leaves up only behind closed gates', () => {
    const rng = new Rng(2024);
    let bridges = 0;
    let rivers = 0;
    for (let i = 0; i < 24; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const plan = planRoads(seed);
      if (plan.districts.areas.some((a) => a.kind === 'river')) rivers++;
      const a = buildTimedGates(seed, plan.graph, plan.districts.areas);
      const b = buildTimedGates(seed, plan.graph, plan.districts.areas);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      if (!a.drawbridge) continue;
      bridges++;
      const db = a.drawbridge;
      const set = a.timedGates;
      const c = set.cycles[db.cycle];
      expect(db.gates.length).toBe(2);
      for (const gi of db.gates) expect(WALL_LOOKS).toContain(set.gates[gi].look);
      // Closed 15-25% of a 58-74 s cycle, never in the first 21 s (countdown and the opening sprint).
      expect(c.period / TICK_HZ).toBeGreaterThanOrEqual(DRAWBRIDGE.period[0] - 0.1);
      expect(c.period / TICK_HZ).toBeLessThanOrEqual(DRAWBRIDGE.period[1] + 0.1);
      const share = blockTicks(c) / c.period;
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.27);
      for (let t = 0; t < DRAWBRIDGE.firstAfter * TICK_HZ; t += 7) expect(gatePhase(c, t).name).toBe('open');
      let blocked = 0;
      for (let t = 0; t < c.start + 3 * c.period; t++) {
        const p = gatePhase(c, t);
        expect(p.blocking).toBe(gateBlocking(c, t));
        expect(p.arm).toBeGreaterThanOrEqual(0);
        expect(p.arm).toBeLessThanOrEqual(1);
        if (p.blocking) blocked++;
        else expect(p.untilBlock).toBeGreaterThan(0);
        const angle = leafAngle(db, set, t);
        expect(angle).toBeGreaterThanOrEqual(0);
        expect(angle).toBeLessThanOrEqual(db.maxAngle + 1e-9);
        if (angle > 0) {
          // The leaves only move behind gates that have been down for the whole clearing time.
          expect(p.blocking).toBe(true);
          expect(gateBlocking(c, t - db.clear)).toBe(true);
        }
      }
      expect(blocked).toBe(3 * blockTicks(c));
      // The same tick always gives the same state, fractional ticks included.
      expect(JSON.stringify(gatePhase(c, c.start + 1234.5))).toBe(JSON.stringify(gatePhase(c, c.start + 1234.5)));
    }
    expect(rivers).toBeGreaterThan(15);
    expect(bridges).toBeGreaterThan(rivers * 0.8);
  });

  it('stands on a fitting bridge, gates sealed from parapet to parapet, the span clear of street furniture', () => {
    const rng = new Rng(77);
    let checked = 0;
    for (let i = 0; i < 6 && checked < 3; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const w = createWorld(seed, i % 2 ? 'sprint' : 'circuit');
      const db = w.drawbridge;
      if (!db) continue;
      checked++;
      expect(w.graph.edges[db.edge].bridge).toBe(true);
      const set = w.timedGates!;
      for (const gi of db.gates) {
        const g = set.gates[gi];
        // Each end meets a city wall (parapet or frontage), so nobody slips round a closed gate.
        for (const [x, z] of [
          [g.ax, g.az],
          [g.bx, g.bz],
        ]) {
          const near = w.blocks.walls.some((wall) => distToSegment(x, z, wall.ax, wall.az, wall.bx, wall.bz) < 0.6);
          expect(near, `gate end (${x.toFixed(1)}, ${z.toFixed(1)}) seed ${seed}`).toBe(true);
        }
        // Holding traffic back on the approach, away from the span.
        expect(gateSide(g, db.cx, db.cz)).toBeLessThan(0);
      }
      // No streetlight, can, bench or bus stop on the deck between the gates.
      for (const p of w.props) {
        const s = spanCoords(db, p.x, p.z);
        if (Math.abs(s.w) < db.half + 0.5) expect(Math.abs(s.u) < db.gate + 1, `${p.kind} on the drawbridge, seed ${seed}`).toBe(false);
      }
      // Route start, finish and grid stay well clear of the stretch between the gates.
      const ga = set.gates[db.gates[0]];
      const gb = set.gates[db.gates[1]];
      for (const q of [routeSample(w.route, w.route.startS), routeSample(w.route, w.route.finishS), ...w.route.grid]) {
        expect(distToSegment(q.x, q.z, ga.cx, ga.cz, gb.cx, gb.cz)).toBeGreaterThan(DRAWBRIDGE.startClear - 0.5);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('holds back cars only while blocking, and lets a car caught on the span drive out', () => {
    const seed = drawbridgeCircuitSeed(31);
    const w0 = createWorld(seed, 'circuit', undefined, { openWorld: true });
    const db = w0.drawbridge!;
    const c = w0.timedGates!.cycles[db.cycle];
    const gate = w0.timedGates!.gates[db.gates[0]];
    const block = nextBlock(w0, 30 * TICK_HZ);
    /** Drive at a gate from `from` m on side `side` (+1 approach, -1 span), full throttle, for `ticks`; returns the final side. */
    const run = (tick: number, from: number, side: number, ticks: number) => {
      const r = freeRoam(seed, tick);
      const rc = r.cars[0];
      // Square to the gate, toward it (from the approach) or away from it (from the span).
      const x = gate.cx + gate.nx * from * side;
      const z = gate.cz + gate.nz * from * side;
      const dir = side > 0 ? -1 : 1;
      placeCar(rc.state, x, z, yawOf(gate.nx * dir, gate.nz * dir), r.world);
      rc.state.vx = gate.nx * dir * 18;
      rc.state.vz = gate.nz * dir * 18;
      let crossed = false;
      for (let i = 0; i < ticks; i++) {
        const blocking = gateBlocking(c, r.tick);
        stepRace(r, input({ throttle: 1 }));
        if (Math.sign(gateSide(gate, rc.state.x, rc.state.z)) !== side) {
          crossed = true;
          if (side > 0) expect(blocking, `crossed a closed gate at tick ${r.tick}`).toBe(false);
        }
      }
      return { crossed, r };
    };
    // Open: straight through. Blocking: stopped at the line, every time, at a run up of 30 m.
    expect(run(block - Math.round(15 * TICK_HZ), 30, 1, 150).crossed).toBe(true);
    const held = run(block + 10, 30, 1, 240);
    expect(held.crossed).toBe(false);
    expect(held.r.cars[0].state.speed).toBeLessThan(3);
    expect(held.r.events.some((e) => e.type === 'wall' && e.kind === 'barrier')).toBe(true);
    // From the span side the closed gate lets the car out (before the leaves start up).
    expect(leafAngle(db, w0.timedGates!, block + 10 + 60)).toBe(0);
    expect(run(block + 10, 14, -1, 60).crossed).toBe(true);
  });

  it('tows a car left on the span off it when the leaves start up', () => {
    const seed = drawbridgeCircuitSeed(31);
    const w0 = createWorld(seed, 'circuit', undefined, { openWorld: true });
    const db = w0.drawbridge!;
    const set = w0.timedGates!;
    const block = nextBlock(w0, 30 * TICK_HZ);
    const r = freeRoam(seed, block + 5);
    const rc = r.cars[0];
    placeCar(rc.state, db.cx + db.dx * 4, db.cz + db.dz * 4, yawOf(db.dx, db.dz), r.world);
    let towed = -1;
    for (let i = 0; i < db.clear + 30; i++) {
      stepRace(r, input({ brake: 0.4 }));
      if (towed < 0 && r.events.some((e) => e.type === 'reset')) towed = r.tick - 1;
    }
    expect(towed).toBeGreaterThan(0);
    expect(leafAngle(db, set, towed)).toBeGreaterThan(0);
    expect(leafAngle(db, set, towed - 1)).toBe(0);
    expect(onSpan(db, rc.state.x, rc.state.z, DRAWBRIDGE.towMargin)).toBe(false);
    // Behind the gate at its end of the bridge (it was on the +axis half), facing on along the axis.
    const end = set.gates[db.gates[1]];
    expect(gateSide(end, rc.state.x, rc.state.z)).toBeGreaterThan(0);
  });

  it('an AI racer brakes for the closed gate, waits without being reset, then crosses', () => {
    const seed = drawbridgeCircuitSeed(31);
    const cfg = raceConfig(seed, 'circuit', 0);
    const r = createRace(cfg);
    const w = r.world;
    const db = w.drawbridge!;
    const set = w.timedGates!;
    const c = set.cycles[db.cycle];
    // The gate the circuit meets first: the one holding back traffic along the route.
    const sMid = w.routeProgress(db.cx, db.cz).s;
    const mid = routeSample(w.route, sMid);
    const gi = db.gates.find((k) => set.gates[k].nx * mid.tx + set.gates[k].nz * mid.tz < 0)!;
    const gate = set.gates[gi];
    const sGate = w.routeProgress(gate.cx, gate.cz).s;
    const start = routeSample(w.route, sGate - 140);
    const block = nextBlock(w, 30 * TICK_HZ);
    r.tick = block - 2 * TICK_HZ;
    r.phase = 'racing';
    const rc = r.cars[0];
    placeCar(rc.state, start.x, start.z, yawOf(start.tx, start.tz), w);
    rc.rawS = w.routeProgress(start.x, start.z).s;
    rc.seg = start.seg;
    const pilot = createAi(3, 0.95);
    let stillFor = 0;
    let longestStill = 0;
    let crossedAt = -1;
    let waitingTicks = 0;
    for (let i = 0; i < 40 * TICK_HZ && crossedAt < 0; i++) {
      const tick = r.tick;
      stepRace(r, autopilotInput(r, rc, pilot));
      const sd = gateSide(gate, rc.state.x, rc.state.z);
      if (sd <= 0 && distToSegment(rc.state.x, rc.state.z, gate.ax, gate.az, gate.bx, gate.bz) < 5) {
        expect(gateBlocking(c, tick), `crossed while blocking at tick ${tick}`).toBe(false);
        crossedAt = tick;
      }
      if (rc.state.speed < 0.5 && sd > 0 && sd < 20) stillFor++;
      else stillFor = 0;
      longestStill = Math.max(longestStill, stillFor);
      if (waitingAtGate(set, tick, rc.state.x, rc.state.z, rc.state.speed)) waitingTicks++;
    }
    expect(r.events.filter((e) => e.type === 'reset')).toEqual([]);
    // It waited a good while at the line, and went once the gates stopped blocking.
    expect(longestStill).toBeGreaterThan(3 * TICK_HZ);
    expect(waitingTicks).toBeGreaterThan(3 * TICK_HZ);
    expect(crossedAt).toBeGreaterThan(block);
    expect(gateBlocking(c, crossedAt)).toBe(false);
    expect(crossedAt - (block + blockTicks(c))).toBeLessThan(6 * TICK_HZ);
  });

  it('races over a drawbridge replay bit for bit', () => {
    const seed = drawbridgeCircuitSeed(31);
    const cfg = raceConfig(seed, 'circuit', 3);
    const a = runAutopilot(cfg, 75);
    const b = runAutopilot(cfg, 75);
    expect(carSnapshot(a)).toBe(carSnapshot(b));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    const replay = replayLog(cfg, a.inputLog);
    expect(carSnapshot(replay)).toBe(carSnapshot(a));
    expect(a.world.drawbridge).toBeTruthy();
    expect(a.world.route.edges).toContain(a.world.drawbridge!.edge);
  });
});
