import { describe, expect, it } from 'vitest';
import { createCity, createWorld } from '../src/city/world';
import { isRiverEdge } from '../src/city/roadGraph';
import { createRace, stepRace, RaceConfig, RaceState } from '../src/sim/race';
import { TrafficCar, trafficNet, trafficTuning } from '../src/sim/traffic';
import { TRAFFIC } from '../src/sim/tuning';
import { placeCar } from '../src/sim/car';
import { createAi, autopilotInput } from '../src/sim/ai';
import { cos, distToSegment, sin } from '../src/sim/math';
import { buildKit } from '../src/render/traffic';
import { gateBlocking, gateSide } from '../src/sim/gates';
import { leafAngle, onSpan } from '../src/city/drawbridge';
import { carSnapshot, input, raceConfig, replayLog } from './helpers';

/** Traffic state that must replay bit for bit: every car's plan, speed and body. */
const trafficSnapshot = (r: RaceState) => JSON.stringify({ cars: r.traffic?.cars, rng: r.traffic?.rng });

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
    for (const seed of [20261019, 7]) {
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
      expect(works.some((a) => open.paths.filter((p) => p.lane && p.edge === a.params.edge && p.x.length > 2).length > 0)).toBe(true);
      // A night market's street stays closed to traffic.
      const market = new Set(ow.areas.filter((a) => a.kind === 'market').flatMap((a) => a.edges));
      expect(open.paths.some((p) => p.lane && market.has(p.edge))).toBe(false);
    }
  });
});

describe('ambient traffic', () => {
  it('is deterministic and never disturbs a race on the route', () => {
    const cfg = raceConfig(20261019, 'circuit', 3);
    const run = (c: RaceConfig) => {
      const r = createRace(c);
      const pilot = createAi(7, 0.97);
      for (let i = 0; i < 60 * 35; i++) stepRace(r, autopilotInput(r, r.cars[0], pilot));
      return r;
    };
    const a = run(withTraffic(cfg));
    const b = run(withTraffic(cfg));
    expect(a.traffic!.cars.length).toBeGreaterThan(10);
    expect(a.traffic!.cars.filter((c) => c.mode === 'drive').length).toBeGreaterThan(10);
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
      const pilot = createAi(7, 0.97);
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
      for (let i = 0; i < 120; i++) stepRace(r, input({}));
      // Ram a car well inside a long lane from behind, a little off its center line.
      const target = t.cars.find((c) => c.mode === 'drive' && t.net.paths[c.path].lane && t.net.paths[c.path].length - c.s > 70 && c.s > 30)!;
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

  it('waits at the drawbridge gates and is never on the span when the leaves go up', () => {
    let waitedSomewhere = false;
    for (const seed of [1, 7]) {
      const r = createRace({ ...withTraffic(raceConfig(seed, 'circuit', 0)), openWorld: true });
      const db = r.world.drawbridge!;
      const set = r.world.timedGates!;
      expect(db).toBeTruthy();
      const t = r.traffic!;
      expect(t.net.paths.some((p) => p.gates.length > 0)).toBe(true);
      // Park the player on the approach's sidewalk so the bubble of traffic is around the bridge.
      const along = db.gate + 40;
      placeCar(r.cars[0].state, db.cx + db.dx * along + db.nx * (db.half + 2.5), db.cz + db.dz * along + db.nz * (db.half + 2.5), 0, r.world);
      const side = t.cars.map(() => set.gates.map(() => 0));
      let crossings = 0;
      let blockedCrossings = 0;
      let waiting = 0;
      for (let i = 0; i < 60 * 160; i++) {
        const lifting = leafAngle(db, set, r.tick) > 0;
        stepRace(r, input({}));
        const tick = r.tick - 1;
        t.cars.forEach((c, k) => {
          if (c.mode === 'gone') {
            side[k].fill(0);
            return;
          }
          if (lifting) expect(onSpan(db, c.body.x, c.body.z)).toBe(false);
          set.gates.forEach((g, gi) => {
            const sd = gateSide(g, c.body.x, c.body.z);
            const u = ((c.body.x - g.ax) * (g.bx - g.ax) + (c.body.z - g.az) * (g.bz - g.az)) / ((g.bx - g.ax) ** 2 + (g.bz - g.az) ** 2);
            const within = u > -0.1 && u < 1.1;
            // (A car recycled and respawned within one tick jumps; only a car at the line crosses it.)
            if (within && side[k][gi] > 0 && sd <= 0 && sd > -10) {
              crossings++;
              if (gateBlocking(set.cycles[g.cycle], tick)) blockedCrossings++;
            }
            side[k][gi] = within ? (sd > 0 ? 1 : -1) : 0;
            if (within && sd > 0 && sd < 40 && c.v < 0.5 && gateBlocking(set.cycles[g.cycle], tick)) waiting++;
          });
        });
      }
      // Traffic uses the bridge, never crosses a blocking gate, and queues at it while the leaves are up.
      expect(crossings).toBeGreaterThan(3);
      expect(blockedCrossings).toBe(0);
      if (waiting > 0) waitedSomewhere = true;
    }
    expect(waitedSomewhere).toBe(true);
  });

  it('old replays (no traffic flag) run without traffic, exactly as with it off', () => {
    const cfg = raceConfig(7, 'sprint', 2);
    expect(cfg.traffic).toBeUndefined();
    const r = createRace(cfg);
    expect(r.traffic).toBeNull();
    const pilot = createAi(7, 0.97);
    for (let i = 0; i < 60 * 10; i++) stepRace(r, autopilotInput(r, r.cars[0], pilot));
    expect(carSnapshot(replayLog({ ...cfg, traffic: false }, r.inputLog))).toBe(carSnapshot(r));
  });

  it('draws every kind about the size it collides with', () => {
    TRAFFIC.kinds.forEach((k, i) => {
      const kit = buildKit(i);
      kit.paint.computeBoundingBox();
      const bb = kit.paint.boundingBox!;
      expect(Math.abs(bb.max.z - k.halfLength)).toBeLessThan(0.15);
      expect(Math.abs(bb.min.z + k.halfLength)).toBeLessThan(0.15);
      expect(Math.abs(bb.max.x - k.halfWidth)).toBeLessThan(0.15);
      expect(bb.min.y).toBeGreaterThan(0.1);
      expect(kit.lamps.filter((l) => l.role === 'head').length).toBe(2);
      expect(kit.lamps.filter((l) => l.role === 'tail').length).toBe(2);
    });
  });
});
