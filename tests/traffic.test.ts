import { describe, expect, it } from 'vitest';
import { createCity, createWorld } from '../src/city/world';
import { isRiverEdge } from '../src/city/roadGraph';
import { createRace, stepRace, RaceConfig, RaceState } from '../src/sim/race';
import { TrafficCar, trafficNet, trafficTuning } from '../src/sim/traffic';
import { TRAFFIC } from '../src/sim/tuning';
import { placeCar } from '../src/sim/car';
import { createAi, autopilotInput } from '../src/sim/ai';
import { cos, distToSegment, sin } from '../src/sim/math';
import { TRAFFIC_MODELS } from '../src/render/traffic/traffic';
import { PARKING } from '../src/city/config';
import { kerbStrip, planParking } from '../src/city/parking';
import { carSnapshot, input, raceConfig, replayLog } from './helpers';

/** Traffic state that must replay bit for bit: every car's plan, speed and body. */
const trafficSnapshot = (r: RaceState) => JSON.stringify({ cars: r.traffic?.cars, rng: r.traffic?.rng, unparked: r.traffic?.unparked });

/** Closest approach of two traffic cars' collision circles (three per car, as collision.ts), negative when they overlap. */
function circleGap(a: TrafficCar, b: TrafficCar): number {
  let best = Infinity;
  const ga = trafficTuning(a.kind).geometry;
  const gb = trafficTuning(b.kind).geometry;
  const ra = ga.halfWidth * 0.95;
  const rb = gb.halfWidth * 0.95;
  const sa = Math.max(0, ga.halfLength - ra);
  const sb = Math.max(0, gb.halfLength - rb);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const ua = -sa + sa * i;
      const ub = -sb + sb * j;
      const dx = a.body.x + sin(a.body.yaw) * ua - b.body.x - sin(b.body.yaw) * ub;
      const dz = a.body.z + cos(a.body.yaw) * ua - b.body.z - cos(b.body.yaw) * ub;
      best = Math.min(best, Math.hypot(dx, dz) - ra - rb);
    }
  }
  return best;
}

const withTraffic = (cfg: RaceConfig): RaceConfig => ({ ...cfg, traffic: true });

describe('traffic network', () => {
  it('keeps off the route, its shortcuts, closed side streets, alleys and the river in a race, and has no dead ends', () => {
    // Two cities, and the first whose roadworks have a lane bending round the plant (a closure can sit
    // clear of every lane, and on most cities every one does).
    const merges = (seed: number) => {
      const ow = createWorld(seed, 'circuit', undefined, { openWorld: true });
      const open = trafficNet(ow);
      return ow.areas.some((a) => a.kind === 'roadworks' && open.paths.some((p) => p.lane && p.edge === a.params.edge && p.x.length > 2));
    };
    let mergeSeed = 1;
    while (!merges(mergeSeed)) mergeSeed++;
    let merged = 0;
    for (const seed of [20261019, 7, mergeSeed]) {
      const city = createCity(seed);
      for (const kind of ['circuit', 'sprint'] as const) {
        const w = createWorld(seed, kind, city);
        const net = trafficNet(w);
        const routeNodes = new Set(w.route.nodes);
        const routeEdges = new Set(w.route.edges);
        const closed = new Set(w.route.closedStreets.map((c) => c.edge));
        expect(net.lanes.length).toBeGreaterThan(100);
        for (const p of net.paths) {
          expect(routeNodes.has(p.from) || routeNodes.has(p.to)).toBe(false);
          if (!p.lane) continue;
          const e = w.graph.edges[p.edge];
          expect(routeEdges.has(e.id) || closed.has(e.id) || !!e.shortcut || isRiverEdge(e) || e.kind === 'alley' || e.kind === 'backAlley').toBe(false);
          // Every lane has a way in and a way on.
          expect(p.in.length).toBeGreaterThan(0);
          expect(p.out.length).toBeGreaterThan(0);
        }
        // Lanes stay clear of every closure.
        for (const g of w.barrierGroups) {
          for (const wall of g.walls) {
            for (const id of net.lanes) {
              const p = net.paths[id];
              for (let i = 0; i + 1 < p.x.length; i++) expect(distToSegment(wall.ax, wall.az, p.x[i], p.z[i], p.x[i + 1], p.z[i + 1])).toBeGreaterThan(5);
            }
          }
        }
      }
      // An open world opens every street, the route's included.
      const ow = createWorld(seed, 'circuit', city, { openWorld: true });
      const open = trafficNet(ow);
      const routeEdges = new Set(createWorld(seed, 'circuit', city).route.edges);
      expect(open.paths.some((p) => p.lane && routeEdges.has(p.edge))).toBe(true);
      // Roadworks: the lane on the closed side merges out round the plant and stays clear of every cone and barrier.
      const works = ow.areas.filter((a) => a.kind === 'roadworks');
      const props = ow.props.filter((p) => works.some((a) => a.id === p.area));
      expect(props.length).toBeGreaterThan(10);
      const hw = Math.max(...TRAFFIC.kinds.map((k) => k.halfWidth));
      for (const p of open.paths) {
        for (const pr of props) {
          for (let i = 0; i + 1 < p.x.length; i++) expect(distToSegment(pr.x, pr.z, p.x[i], p.z[i], p.x[i + 1], p.z[i + 1]) - pr.radius - hw).toBeGreaterThan(0.2);
        }
      }
      if (works.some((a) => open.paths.filter((p) => p.lane && p.edge === a.params.edge && p.x.length > 2).length > 0)) merged++;
      // A night market's street stays closed to traffic.
      const market = new Set(ow.areas.filter((a) => a.kind === 'market').flatMap((a) => a.edges));
      expect(open.paths.some((p) => p.lane && market.has(p.edge))).toBe(false);
    }
    expect(merged).toBeGreaterThan(0);
  });
});

describe('ambient traffic', () => {
  it('is deterministic and never disturbs a race on the route', () => {
    const cfg = raceConfig(20261019, 'circuit', 3);
    let peak = 0;
    const run = (c: RaceConfig) => {
      const r = createRace(c);
      const pilot = createAi(0.97);
      for (let i = 0; i < 60 * 35; i++) {
        stepRace(r, autopilotInput(r, r.cars[0], pilot));
        peak = Math.max(peak, r.traffic?.cars.filter((t) => t.mode === 'drive').length ?? 0);
      }
      return r;
    };
    const a = run(withTraffic(cfg));
    const b = run(withTraffic(cfg));
    expect(a.traffic!.cars.length).toBeGreaterThan(10);
    // Plenty of it driving while the race is in town (the seed is a Harbor Run: along the sea wall no street lies
    // in the spawn ring, so the fleet thins out there until the route turns back in).
    expect(peak).toBeGreaterThan(10);
    expect(trafficSnapshot(a)).toBe(trafficSnapshot(b));
    expect(carSnapshot(a)).toBe(carSnapshot(b));
    // The racers never meet it: the race is bit for bit the race without traffic.
    const plain = run(cfg);
    expect(plain.traffic).toBeNull();
    expect(carSnapshot(a)).toBe(carSnapshot(plain));
    // And replaying the recorded input reproduces the traffic too.
    expect(trafficSnapshot(replayLog(withTraffic(cfg), a.inputLog))).toBe(trafficSnapshot(a));
  });

  it('stays on the off-route streets in a race, well clear of every closure', () => {
    for (const [seed, mode] of [
      [11, 'circuit'],
      [42, 'sprint'],
    ] as const) {
      const r = createRace(withTraffic(raceConfig(seed, mode, 1)));
      const t = r.traffic!;
      const routeNodes = new Set(r.world.route.nodes);
      const closures = r.world.barrierGroups.flatMap((g) => g.walls);
      const pilot = createAi(0.97);
      let samples = 0;
      for (let i = 0; i < 60 * 40; i++) {
        stepRace(r, autopilotInput(r, r.cars[0], pilot));
        if (i % 10) continue;
        for (const c of t.cars) {
          if (c.mode !== 'drive') continue;
          samples++;
          for (const id of [c.path, c.next, c.after]) {
            const p = t.net.paths[id];
            expect(routeNodes.has(p.from) || routeNodes.has(p.to)).toBe(false);
          }
          for (const w of closures) expect(distToSegment(c.body.x, c.body.z, w.ax, w.az, w.bx, w.bz)).toBeGreaterThan(6);
        }
      }
      expect(samples).toBeGreaterThan(1000);
      expect(r.events.some((e) => e.traffic !== undefined)).toBe(false);
    }
  });

  it('keeps its distance: driving cars never overlap, queue at junctions and keep moving', () => {
    // Free roam with the player parked: three minutes of city traffic left to itself.
    const r = createRace({ ...withTraffic(raceConfig(20261019, 'circuit', 0)), openWorld: true });
    const t = r.traffic!;
    let minGap = Infinity;
    let stopped = 0;
    let samples = 0;
    let wentLoose = false;
    for (let i = 0; i < 60 * 180; i++) {
      stepRace(r, input({}));
      if (t.cars.some((c) => c.mode === 'loose')) wentLoose = true;
      if (i % 5) continue;
      const drive = t.cars.filter((c) => c.mode === 'drive');
      for (let a = 0; a < drive.length; a++) {
        samples++;
        if (drive[a].v < 0.5) stopped++;
        for (let b = a + 1; b < drive.length; b++) minGap = Math.min(minGap, circleGap(drive[a], drive[b]));
      }
    }
    expect(wentLoose).toBe(false);
    expect(r.events.some((e) => e.traffic !== undefined)).toBe(false);
    expect(minGap).toBeGreaterThan(1);
    // Waiting at junctions and in queues is part of it, a jammed city is not.
    expect(stopped / samples).toBeLessThan(0.2);
    // Plenty of it around the player.
    const p = r.cars[0].state;
    expect(t.cars.filter((c) => c.mode !== 'gone' && Math.hypot(c.body.x - p.x, c.body.z - p.z) < 250).length).toBeGreaterThan(6);
  });

  it('a struck car is shoved, slides to a stop as a loose body and drives on, and replays identically', () => {
    const scenario = () => {
      const r = createRace({ ...withTraffic(raceConfig(20261019, 'circuit', 0)), openWorld: true });
      const t = r.traffic!;
      // Ram a car well inside a long lane from behind, a little off its center line. The streets round the grid are
      // short (the seed is a Harbor Run, starting by the docks), so the player first waits on a lane about 200 m from
      // the nearest long one, inside the ring where the fleet respawns, until a car is well into it.
      const start = r.cars[0].state;
      const lanes = t.net.lanes.map((id) => t.net.paths[id]);
      const mid = (p: (typeof lanes)[number]) => ({ x: (p.x[0] + p.x[p.x.length - 1]) / 2, z: (p.z[0] + p.z[p.z.length - 1]) / 2 });
      const long = lanes.filter((p) => p.length > 100).sort((p, q) => Math.hypot(mid(p).x - start.x, mid(p).z - start.z) - Math.hypot(mid(q).x - start.x, mid(q).z - start.z))[0];
      const m = mid(long);
      const wait = lanes.find((p) => Math.abs(Math.hypot(p.x[0] - m.x, p.z[0] - m.z) - 200) < 30 && p.length > 40)!;
      placeCar(start, (wait.x[0] + wait.x[1]) / 2, (wait.z[0] + wait.z[1]) / 2, wait.yaw[0], r.world);
      const ready = (c: TrafficCar) => c.mode === 'drive' && t.net.paths[c.path].lane && t.net.paths[c.path].length - c.s > 70 && c.s > 30;
      for (let i = 0; i < 120 || (!t.cars.some(ready) && i < 60 * 60); i++) stepRace(r, input({}));
      const target = t.cars.find(ready)!;
      const b = target.body;
      const fx = sin(b.yaw);
      const fz = cos(b.yaw);
      const pc = r.cars[0].state;
      placeCar(pc, b.x - fx * 22 + fz * 1.1, b.z - fz * 22 - fx * 1.1, b.yaw, r.world);
      pc.vx = fx * 28;
      pc.vz = fz * 28;
      const modes: string[] = [];
      let moved = false;
      for (let i = 0; i < 60 * 16; i++) {
        stepRace(r, i < 40 ? input({ throttle: 1 }) : input({ brake: 0.4 }));
        if (modes[modes.length - 1] !== target.mode) modes.push(target.mode);
        // Once the struck car is at rest the player moves on: stopped in the lane, it would hold the street up.
        if (!moved && target.mode === 'loose' && target.still > 0) {
          const far = t.net.lanes.map((id) => t.net.paths[id]).find((p) => Math.abs(Math.hypot(p.x[0] - b.x, p.z[0] - b.z) - 220) < 30 && p.length > 40)!;
          placeCar(pc, (far.x[0] + far.x[1]) / 2, (far.z[0] + far.z[1]) / 2, far.yaw[0], r.world);
          moved = true;
        }
      }
      return { r, target, modes };
    };
    const a = scenario();
    const hits = a.r.events.filter((e) => e.type === 'crash' && e.traffic === a.target.id && e.car === 0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].value!).toBeGreaterThan(5);
    // Shoved loose, then back to driving (or recycled out of sight).
    expect(a.modes[0]).toBe('drive');
    expect(a.modes[1]).toBe('loose');
    expect(a.modes[a.modes.length - 1]).toBe('drive');
    const b = scenario();
    expect(trafficSnapshot(b.r)).toBe(trafficSnapshot(a.r));
    expect(carSnapshot(b.r)).toBe(carSnapshot(a.r));
  });

  it('old replays (no traffic flag) run without traffic, exactly as with it off', () => {
    const cfg = raceConfig(7, 'sprint', 2);
    expect(cfg.traffic).toBeUndefined();
    const r = createRace(cfg);
    expect(r.traffic).toBeNull();
    const pilot = createAi(0.97);
    for (let i = 0; i < 60 * 10; i++) stepRace(r, autopilotInput(r, r.cars[0], pilot));
    expect(carSnapshot(replayLog({ ...cfg, traffic: false }, r.inputLog))).toBe(carSnapshot(r));
  });

  it('parks cars along the kerbs off the route, clear of every lane, and a struck one slides and replays identically', () => {
    // The kinds parked fit the plan's strip and pitch.
    for (const pk of PARKING.kinds) {
      const k = TRAFFIC.kinds.find((kd) => kd.name === pk.name)!;
      expect(k).toBeDefined();
      expect(k.halfWidth).toBeLessThanOrEqual(PARKING.bodyHalfWidth);
      expect(2 * k.halfLength + 0.4).toBeLessThanOrEqual(PARKING.pitch);
    }
    const maxHW = Math.max(...TRAFFIC.kinds.map((k) => k.halfWidth));
    for (const seed of [20261019, 7]) {
      const city = createCity(seed);
      const w = createWorld(seed, 'circuit', city);
      const plan = planParking(w);
      expect(plan.cars.length).toBeGreaterThan(300);
      expect(planParking(createWorld(seed, 'circuit', city))).toEqual(plan);
      const routeNodes = new Set(w.route.nodes);
      const net = trafficNet(w);
      // (The parking lots' cars are in the plan too, after the kerb's: tests/parkingLots.test.ts holds them.)
      for (const c of plan.cars.filter((p) => p.lot === undefined)) {
        const e = w.graph.edges[c.edge];
        // Off the route, its closed side streets and their meets.
        expect(routeNodes.has(e.a) || routeNodes.has(e.b)).toBe(false);
        expect(kerbStrip(e)).toBeGreaterThan(0);
        for (let i = 0; i + 1 < w.route.points.length; i++) {
          const a = w.route.points[i];
          const b = w.route.points[i + 1];
          expect(distToSegment(c.x, c.z, a.x, a.z, b.x, b.z)).toBeGreaterThan(PARKING.routeClear);
        }
        // Clear of every lane's swept width (the widest car on it), the body's corners and sides.
        const k = TRAFFIC.kinds.find((kd) => kd.name === c.kind)!;
        const fx = sin(c.yaw);
        const fz = cos(c.yaw);
        const pts = [-1, 0, 1].flatMap((u) => [-1, 1].map((v) => [c.x + fx * u * k.halfLength + fz * v * k.halfWidth, c.z + fz * u * k.halfLength - fx * v * k.halfWidth]));
        for (const id of net.lanes) {
          const p = net.paths[id];
          if (p.edge !== c.edge) continue;
          for (let i = 0; i + 1 < p.x.length; i++) for (const [x, z] of pts) expect(distToSegment(x, z, p.x[i], p.z[i], p.x[i + 1], p.z[i + 1])).toBeGreaterThan(maxHW + 0.3);
        }
      }
      // Every occupied slot is a parked body in a race with traffic, after the moving fleet.
      const r = createRace(withTraffic(raceConfig(seed, 'circuit', 0)));
      expect(r.traffic!.cars.filter((c) => c.mode === 'parked').length).toBe(plan.cars.length);
      expect(r.traffic!.cars.filter((c) => c.home < 0).length).toBe(r.traffic!.fleet);
    }
    // Drive into a parked car: it is shoved loose and slides, the hit is a crash, and it all replays.
    const scenario = () => {
      const r = createRace({ ...withTraffic(raceConfig(20261019, 'circuit', 0)), openWorld: true });
      const t = r.traffic!;
      const target = t.cars.find((c) => c.mode === 'parked')!;
      const b = target.body;
      const x0 = b.x;
      const z0 = b.z;
      const fx = sin(b.yaw);
      const fz = cos(b.yaw);
      const pc = r.cars[0].state;
      // From behind along the kerb, a little out from it: cutting in as a corner would.
      const side = 0.6;
      placeCar(pc, b.x - fx * 18 - fz * side, b.z - fz * 18 + fx * side, b.yaw, r.world);
      pc.vx = fx * 20;
      pc.vz = fz * 20;
      // Coast into it, then brake once it is hit; the speed just before and just after the hit.
      let before = 0;
      let after = 0;
      let hit = -1;
      for (let i = 0; i < 60 * 6; i++) {
        const v = Math.hypot(pc.vx, pc.vz);
        stepRace(r, hit < 0 ? input({}) : input({ brake: 0.6 }));
        if (hit < 0 && target.mode === 'loose') {
          hit = i;
          before = v;
        }
        if (hit >= 0 && i === hit + 3) after = Math.hypot(pc.vx, pc.vz);
      }
      return { r, target, moved: Math.hypot(target.body.x - x0, target.body.z - z0), before, after };
    };
    const a = scenario();
    expect(a.r.events.some((e) => e.type === 'crash' && e.traffic === a.target.id && e.car === 0)).toBe(true);
    expect(a.target.mode).toBe('loose');
    expect(a.r.traffic!.unparked).toContain(a.target.id);
    expect(a.moved).toBeGreaterThan(0.5);
    // A real stop: the hit takes a good share of the speed off the car (a body of its own mass, not a cone).
    expect(a.before).toBeGreaterThan(15);
    expect(a.after).toBeLessThan(a.before * 0.8);
    const b = scenario();
    expect(trafficSnapshot(b.r)).toBe(trafficSnapshot(a.r));
    expect(carSnapshot(b.r)).toBe(carSnapshot(a.r));
  });

  it('collides every kind at the size of its model', () => {
    // trafficModels.json is what `npm run traffic` measured; nothing stale on either side.
    expect(Object.keys(TRAFFIC_MODELS.kinds).sort()).toEqual(TRAFFIC.kinds.map((k) => k.name).sort());
    for (const k of TRAFFIC.kinds) {
      const m = TRAFFIC_MODELS.kinds[k.name];
      expect(Math.abs(m.halfLength - k.halfLength)).toBeLessThan(0.02);
      expect(Math.abs(m.halfWidth - k.halfWidth)).toBeLessThan(0.02);
      expect(m.lamps.filter((l) => l.role === 'head').length).toBeGreaterThanOrEqual(2);
      expect(m.lamps.filter((l) => l.role === 'tail').length).toBeGreaterThanOrEqual(2);
      for (const l of m.lamps) {
        expect(Math.abs(l.p[2])).toBeLessThan(m.halfLength + 0.1);
        expect(l.p[1]).toBeLessThan(m.height + 0.1);
      }
    }
    expect(TRAFFIC_MODELS.credits.flatMap((c) => c.kinds).sort()).toEqual(TRAFFIC.kinds.map((k) => k.name).sort());
  });
});
