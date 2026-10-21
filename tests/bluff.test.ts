import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { CITY } from '../src/city/config';
import { createCity, createWorld, planRoads } from '../src/city/world';
import type { World } from '../src/city/world';
import { buildRoute, routeSample } from '../src/city/route';
import { bluffShape, bluffUV, envelope, terraceAt } from '../src/city/districts/bluff';
import { elCurve } from '../src/city/districts/subway';
import { WALL_LOOKS } from '../src/city/districts/types';
import { pointInPolygon } from '../src/city/districts/geom';
import { RAIL, curvePoint, sampleCurve } from '../src/city/railCurve';
import { TRAIN, lineServices, trackS, trainLength, tripsAt } from '../src/city/railTimetable';
import type { TripState } from '../src/city/railTimetable';
import { CROSSING, crossingTrain } from '../src/city/levelCrossings';
import { blockTicks, gateBlocking, gatePhase, gateSide, waitingAtGate } from '../src/sim/gates';
import type { GateCycle } from '../src/sim/gates';
import { createRace, stepRace } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { autopilotInput, createAi } from '../src/sim/ai';
import { TICK_HZ } from '../src/sim/constants';
import { distToSegment, yawOf } from '../src/sim/math';
import { carSnapshot, input, raceConfig, replayLog, runAutopilot } from './helpers';

const CFG = CITY.districts.bluff;

/** Seeds (from a stream) whose city has a bluff, planRoads only (cheap). */
function bluffSeeds(stream: number, want: number): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 200 && out.length < want; i++) {
    const seed = rng.int(0, 0x7fffffff);
    if (planRoads(seed).districts.areas.some((a) => a.kind === 'bluff')) out.push(seed);
  }
  return out;
}

/** The first seed of a stream whose route of `kind` runs over its level crossing. */
function crossingSeed(stream: number, kind: 'circuit' | 'sprint'): number {
  const rng = new Rng(stream);
  for (let i = 0; i < 200; i++) {
    const seed = rng.int(0, 0x7fffffff);
    const plan = planRoads(seed);
    const b = plan.districts.areas.find((a) => a.kind === 'bluff');
    if (!b) continue;
    if (buildRoute(plan.graph, kind, plan.routeNodes[kind]).edges.includes(b.params.crestEdge)) return seed;
  }
  throw new Error('no seed whose route crosses its level crossing');
}

/**
 * First tick at or after `after` a block of the crossing's gates starts. Mid-block at `after`
 * (untilBlock is 0 then) it skips to the next block, so a scenario timed from it gets a whole block.
 */
function nextBlock(c: GateCycle, after: number): number {
  const p = gatePhase(c, after);
  const t = p.blocking ? after + p.untilClear : after;
  return t + gatePhase(c, t).untilBlock;
}

describe('bluff (city)', () => {
  it('reshapes most cities with an El, the same way every time, and routes cross its tracks on most of them', () => {
    const rng = new Rng(17);
    let el = 0;
    let bluffs = 0;
    let crossed = 0;
    for (let i = 0; i < 40; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const plan = planRoads(seed);
      const sub = plan.districts.areas.find((a) => a.kind === 'subway');
      const b = plan.districts.areas.find((a) => a.kind === 'bluff');
      if (sub) el++;
      if (!b) continue;
      bluffs++;
      expect(sub).toBeTruthy();
      expect(sub!.params.bluff).toBe(b.id);
      expect(b.params.H).toBeGreaterThanOrEqual(CFG.height[0] - 1e-9);
      expect(b.params.H).toBeLessThanOrEqual(CFG.height[1] + 1e-9);
      // The crest street knows where its crossing is, and the El's detour is off its street.
      const e = plan.graph.edges[b.params.crestEdge];
      expect(e.crossing).toBeGreaterThan(30);
      expect(e.length - e.crossing!).toBeGreaterThan(30);
      for (const eid of sub!.edges) {
        const g = plan.graph;
        const gj = [g.nodes[g.edges[eid].a].gj, g.nodes[g.edges[eid].b].gj];
        expect(gj.every((j) => j >= sub!.params.dj0 && j <= sub!.params.dj1)).toBe(false);
      }
      if ((['circuit', 'sprint'] as const).some((k) => buildRoute(plan.graph, k, plan.routeNodes[k]).edges.includes(b.params.crestEdge))) crossed++;
      if (i < 6) {
        const again = planRoads(seed).districts.areas.find((a) => a.kind === 'bluff');
        expect(JSON.stringify(again)).toBe(JSON.stringify(b));
      }
    }
    // The El exists on about three seeds in four; the bluff fits on about half of them (it needs the line
    // straight on one column across five rows, and the line swings columns once or twice per seed), and a
    // route runs over its level crossing on most of those (see README: the share is measured here).
    expect(bluffs / el).toBeGreaterThan(0.42);
    expect(crossed / bluffs).toBeGreaterThan(0.6);
  });

  it('has exact gradients everywhere: the face, the ramps, the crossing pad and the dips', () => {
    for (const seed of bluffSeeds(5, 3)) {
      const w = createWorld(seed, 'circuit');
      const b = w.areas.find((a) => a.kind === 'bluff')!;
      const s = bluffShape(b);
      const rng = new Rng(seed);
      const probes: { x: number; z: number }[] = [];
      const xs = b.polygon.map((p) => p.x);
      const zs = b.polygon.map((p) => p.z);
      for (let k = 0; k < 300; k++) probes.push({ x: rng.range(Math.min(...xs), Math.max(...xs)), z: rng.range(Math.min(...zs), Math.max(...zs)) });
      // Along every ramp, across its corridor and its blend; around the pad and the dips.
      for (const r of s.ramps) for (let t = -s.L / 2 - 2; t <= s.L / 2 + 2; t += 3) for (const q of [0, r.hw * 0.8, r.hw + 1, r.hw + 2.5]) probes.push({ x: r.x + r.dx * t - r.dz * q, z: r.z + r.dz * t + r.dx * q });
      for (let a = 0; a < 6.28; a += 0.3) for (const d of [CFG.padIn - 1, (CFG.padIn + CFG.padOut) / 2, CFG.padOut - 1]) probes.push({ x: s.cx + Math.cos(a) * d, z: s.cz + Math.sin(a) * d });
      for (const g of s.sags) for (let t = -g.flat - g.w; t <= g.flat + g.w; t += 2) for (const q of [0, g.hw + 1.5]) probes.push({ x: g.x + g.dx * t - g.dz * q, z: g.z + g.dz * t + g.dx * q });
      const e = 0.005;
      for (const p of probes) {
        const sl = w.slopeAt(p.x, p.z);
        const gx = (w.heightAt(p.x + e, p.z) - w.heightAt(p.x - e, p.z)) / (2 * e);
        const gz = (w.heightAt(p.x, p.z + e) - w.heightAt(p.x, p.z - e)) / (2 * e);
        expect(Math.abs(sl.gx - gx), `gx at ${p.x}, ${p.z}`).toBeLessThan(2e-3);
        expect(Math.abs(sl.gz - gz), `gz at ${p.x}, ${p.z}`).toBeLessThan(2e-3);
      }
    }
  });

  it('lets streets climb the face at the grade cap, keeps buildings off the face, and draws every wall it adds', () => {
    const out = { h: 0, gx: 0, gz: 0 };
    let ramps = 0;
    let full = 0;
    for (const seed of bluffSeeds(9, 4)) {
      const w = createWorld(seed, 'sprint');
      const b = w.areas.find((a) => a.kind === 'bluff')!;
      const s = bluffShape(b);
      // The bluff alone: never steeper than the cap along a ramp's street, across its whole roadway.
      for (const r of s.ramps) {
        ramps++;
        const e = w.graph.edges[r.edge];
        for (let t = -s.L; t <= s.L; t += 1) {
          for (const q of [-e.width / 2, 0, e.width / 2]) {
            out.h = out.gx = out.gz = 0;
            terraceAt(s, r.x + r.dx * t - r.dz * q, r.z + r.dz * t + r.dx * q, out);
            expect(Math.abs(out.gx * r.dx + out.gz * r.dz)).toBeLessThanOrEqual(CFG.rampGrade + 1e-6);
          }
        }
        // The street really climbs the whole step there (full height between the column streets, less out on the tapers).
        const reach = (r.L / 2 + 1) / (r.dx * s.vx + r.dz * s.vz);
        const lo = { x: r.x - r.dx * reach, z: r.z - r.dz * reach };
        const hi = { x: r.x + r.dx * reach, z: r.z + r.dz * reach };
        out.h = 0;
        terraceAt(s, lo.x, lo.z, out);
        const h0 = out.h;
        out.h = 0;
        terraceAt(s, hi.x, hi.z, out);
        // (Out on a taper the step shrinks along the street too; between the column streets it is all there.)
        if ([lo, hi, r].every((p) => envelope(s, bluffUV(s, p.x, p.z).u) > 1 - 1e-9)) {
          expect(out.h - h0).toBeCloseTo(s.H, 6);
          full++;
        }
      }
      // No building stands on the face (its band across the bluff).
      for (const bd of w.blocks.buildings) {
        const v = (bd.x - s.ox) * s.vx + (bd.z - s.oz) * s.vz;
        const u = (bd.x - s.ox) * s.ux + (bd.z - s.oz) * s.uz;
        if (u > s.uA - s.we && u < s.uB + s.we) expect(Math.abs(v) - Math.hypot(bd.w, bd.d) / 2).toBeGreaterThan(-s.fw / 2);
      }
      // Its walls: retaining walls along ramps and dips, the El's fence at the crossing; all drawn, none on a road.
      const mine = w.walls.filter((x) => x.look === 'bluff' || x.look === 'railFence');
      expect(mine.some((x) => x.look === 'bluff')).toBe(true);
      expect(mine.some((x) => x.look === 'railFence')).toBe(true);
      for (const x of mine) {
        expect(WALL_LOOKS).toContain(x.look);
        const mx = (x.ax + x.bx) / 2;
        const mz = (x.az + x.bz) / 2;
        if (x.look === 'railFence') expect(Math.hypot(mx - s.cx, mz - s.cz)).toBeLessThan(40);
        else {
          const nearRamp = s.ramps.some((r) => distToSegment(mx, mz, r.x - r.dx * s.L, r.z - r.dz * s.L, r.x + r.dx * s.L, r.z + r.dz * s.L) < r.hw + 2);
          const nearSag = s.sags.some((g) => distToSegment(mx, mz, g.x - g.dx * (g.flat + g.w + 2), g.z - g.dz * (g.flat + g.w + 2), g.x + g.dx * (g.flat + g.w + 2), g.z + g.dz * (g.flat + g.w + 2)) < g.hw + 2);
          expect(nearRamp || nearSag).toBe(true);
        }
      }
      expect(pointInPolygon(s.cx, s.cz, b.polygon)).toBe(true);
    }
    expect(ramps).toBeGreaterThan(4);
    // The column streets either side of the El's right of way (where the grid has them) climb the full step.
    expect(full).toBeGreaterThanOrEqual(4);
  });

  it('holds the El level across the bluff: at grade over the crossing, clear over every other street it passes', () => {
    for (const seed of bluffSeeds(23, 4)) {
      const c = createCity(seed);
      const sub = c.districts.areas.find((a) => a.kind === 'subway')!;
      const b = c.districts.areas.find((a) => a.kind === 'bluff')!;
      const curve = elCurve(sub, c.districts.builds[sub.id], c.terrain.heightAt);
      expect(Number.isFinite(curve.levelA)).toBe(true);
      expect(curve.levelB - curve.levelA).toBeGreaterThan(200);
      // Constant track elevation across the bluff.
      const i0 = Math.ceil(curve.levelA / 2);
      const i1 = Math.floor(curve.levelB / 2);
      for (let i = i0; i <= i1; i++) expect(curve.deck[i]).toBeCloseTo(b.params.y, 9);
      // At the crossing the ties sit just under the road (the rail heads flush with it).
      const g = c.graph;
      const e = g.edges[b.params.crestEdge];
      const P = curvePoint();
      for (let s = curve.levelA - CFG.levelBlend; s <= curve.levelB + CFG.levelBlend; s += 1) {
        sampleCurve(curve, s, P);
        const ground = c.terrain.heightAt(P.x, P.z);
        for (const ed of g.edges) {
          const A = g.nodes[ed.a];
          const B = g.nodes[ed.b];
          if (distToSegment(P.x, P.z, A.x, A.z, B.x, B.z) > ed.width / 2 + ed.sidewalk) continue;
          if (ed === e) expect(P.y - ground).toBeCloseTo(-0.14, 2);
          else expect(P.y - ground, `deck over edge ${ed.id} at s ${s}`).toBeGreaterThan(CFG.clearance - 0.5);
        }
      }
      // Grades the trains ride over the city stay gentle, the blends back from the level included: each grows
      // (RailCurve.blendA/B, from CFG.levelBlend) until its grade is under RAIL.levelGrade, however far the
      // level sits from the deck's normal height.
      expect(curve.blendA).toBeGreaterThanOrEqual(CFG.levelBlend);
      expect(curve.blendB).toBeGreaterThanOrEqual(CFG.levelBlend);
      for (let i = Math.ceil(curve.cityA / 2) + 1; i < curve.cityB / 2; i++) expect(Math.abs(curve.deck[i] - curve.deck[i - 1]) / 2).toBeLessThan(RAIL.levelGrade + 0.005);
    }
  });
});

describe('level crossing', () => {
  it('closes its gates exactly while the timetable has a train on the street, and not for long', () => {
    for (const seed of bluffSeeds(31, 4)) {
      const w = createWorld(seed, 'circuit');
      const lc = w.levelCrossings![0];
      const set = w.timedGates!;
      const c = set.cycles[lc.cycle];
      expect(c.period).toBe(TRAIN.headway * TICK_HZ);
      // The timetable itself (the same curve and services the renderer draws): a train's body over the street.
      const sub = w.areas.find((a) => a.kind === 'subway')!;
      const curve = elCurve(sub, w.districts.builds[sub.id], w.heightAt);
      const services = lineServices(curve, sub.params.seed ?? 1);
      const trips: TripState[] = [];
      const pitch = trainLength();
      const reach = lc.half + 0.5;
      let blocked = 0;
      let onStreet = 0;
      for (let t = 0; t < 2 * c.period; t += 3) {
        let train = false;
        for (const { sv } of services) {
          const n = tripsAt(sv, t / TICK_HZ, trips);
          for (let k = 0; k < n; k++) {
            const head = trackS(sv, trips[k].s);
            const tail = trackS(sv, trips[k].s - pitch);
            if (Math.max(head, tail) > lc.s - reach && Math.min(head, tail) < lc.s + reach) train = true;
          }
        }
        const blocking = gateBlocking(c, t);
        if (train) {
          onStreet++;
          expect(blocking, `train on the street at tick ${t} with the gates up`).toBe(true);
          expect(crossingTrain(lc, c, t)).toBeGreaterThanOrEqual(0);
        }
        if (blocking) blocked++;
        expect(gatePhase(c, t).blocking).toBe(blocking);
      }
      expect(onStreet).toBeGreaterThan(0);
      const share = blocked / ((2 * c.period) / 3);
      expect(share).toBeGreaterThan(0.12);
      expect(share).toBeLessThan(0.5);
      // Down a moment before the head arrives, never more than a train's passage plus the margins at a time.
      expect(blockTicks(c)).toBeLessThan(Math.round((CROSSING.downBefore + CROSSING.upAfter + CROSSING.raise + 20) * TICK_HZ) * 2);
      // Two gates across the street, from frontage to frontage, holding traffic back on both sides.
      const gates = lc.gates.map((k) => set.gates[k]);
      expect(gates.length).toBe(2);
      expect(gates[0].nx * gates[1].nx + gates[0].nz * gates[1].nz).toBeCloseTo(-1, 6);
      for (const g of gates) expect(2 * g.half).toBeCloseTo(2 * lc.half, 6);
    }
  });

  it('an AI racer stops for the gates, waits without being reset, then crosses', () => {
    const seed = crossingSeed(41, 'circuit');
    const r = createRace(raceConfig(seed, 'circuit', 0));
    const w = r.world;
    const lc = w.levelCrossings![0];
    const set = w.timedGates!;
    const c = set.cycles[lc.cycle];
    const mid = routeSample(w.route, w.routeProgress(lc.x, lc.z).s);
    const gi = lc.gates.find((k) => set.gates[k].nx * mid.tx + set.gates[k].nz * mid.tz < 0)!;
    const gate = set.gates[gi];
    const sGate = w.routeProgress(gate.cx, gate.cz).s;
    const start = routeSample(w.route, sGate - 70);
    const block = nextBlock(c, 20 * TICK_HZ);
    r.tick = block - TICK_HZ;
    r.phase = 'racing';
    const rc = r.cars[0];
    placeCar(rc.state, start.x, start.z, yawOf(start.tx, start.tz), w);
    rc.rawS = w.routeProgress(start.x, start.z).s;
    rc.seg = start.seg;
    const pilot = createAi(3, 0.95);
    let crossedAt = -1;
    let waiting = 0;
    for (let i = 0; i < 45 * TICK_HZ && crossedAt < 0; i++) {
      const tick = r.tick;
      stepRace(r, autopilotInput(r, rc, pilot));
      const sd = gateSide(gate, rc.state.x, rc.state.z);
      if (sd <= 0 && distToSegment(rc.state.x, rc.state.z, gate.ax, gate.az, gate.bx, gate.bz) < 5) {
        expect(gateBlocking(c, tick), `crossed while blocking at tick ${tick}`).toBe(false);
        crossedAt = tick;
      }
      if (waitingAtGate(set, tick, rc.state.x, rc.state.z, rc.state.speed)) waiting++;
    }
    expect(r.events.filter((e) => e.type === 'reset')).toEqual([]);
    expect(waiting).toBeGreaterThan(3 * TICK_HZ);
    expect(crossedAt).toBeGreaterThan(block);
    expect(crossedAt - (block + gatePhase(c, block).untilClear)).toBeLessThan(6 * TICK_HZ);
  });

  it('tows a car left on the tracks off them when the train comes, behind the nearer gate', () => {
    const seed = crossingSeed(41, 'circuit');
    const r = createRace({ ...raceConfig(seed, 'circuit', 0), openWorld: true });
    const w = r.world;
    const lc = w.levelCrossings![0];
    const set = w.timedGates!;
    const c = set.cycles[lc.cycle];
    // A tick shortly before a train reaches the street, the car parked across the track it comes on.
    let t = nextBlock(c, 20 * TICK_HZ);
    while (crossingTrain(lc, c, t) < 0) t++;
    const track = crossingTrain(lc, c, t) === 1 ? 1 : 0;
    r.tick = t - 30;
    r.phase = 'racing';
    const rc = r.cars[0];
    const x = lc.x + lc.rx * lc.tracks[track];
    const z = lc.z + lc.rz * lc.tracks[track];
    placeCar(rc.state, x, z, yawOf(lc.rx, lc.rz), w);
    let towed = -1;
    for (let i = 0; i < 90; i++) {
      stepRace(r, input({ brake: 0.4 }));
      if (towed < 0 && r.events.some((e) => e.type === 'reset')) towed = r.tick - 1;
    }
    expect(towed).toBeGreaterThanOrEqual(t);
    expect(crossingTrain(lc, c, towed)).toBeGreaterThanOrEqual(0);
    // Now behind a gate, on its holding side, at a standstill.
    expect(lc.gates.some((k) => gateSide(set.gates[k], rc.state.x, rc.state.z) > 1)).toBe(true);
    expect(rc.state.speed).toBeLessThan(1);
  });

  it('races over a level crossing replay bit for bit', () => {
    const seed = crossingSeed(57, 'circuit');
    const cfg = raceConfig(seed, 'circuit', 3);
    const a = runAutopilot(cfg, 80);
    const b = runAutopilot(cfg, 80);
    expect(carSnapshot(a)).toBe(carSnapshot(b));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(carSnapshot(replayLog(cfg, a.inputLog))).toBe(carSnapshot(a));
    const w: World = a.world;
    expect(w.route.edges).toContain(w.levelCrossings![0].edge);
  });
});
