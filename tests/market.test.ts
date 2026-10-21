import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createWorld, planRoads } from '../src/city/world';
import type { World } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import type { Route, RouteKind } from '../src/city/route';
import { edgeBetween } from '../src/city/roadGraph';
import type { RoadGraph } from '../src/city/roadGraph';
import { CITY } from '../src/city/config';
import { PROP_DEFS, isStreetProp } from '../src/city/props';
import type { PropKind } from '../src/city/props';
import { distToSegment, segmentT } from '../src/sim/math';
import { MARKET_HINT } from '../src/city/districts/market';
import type { Area } from '../src/city/districts/types';
import { pointInPolygon } from '../src/city/districts/geom';
import { marketEdges, marketLightPoints, planMarketCrowd } from '../src/render/marketPlan';
import { createRace, stepRace } from '../src/sim/race';
import { NEUTRAL_INPUT } from '../src/sim/input';
import { getBaseTuning } from '../src/sim/tuning';
import { carSnapshot, raceConfig, replayLog, runAutopilot } from './helpers';

const CFG = CITY.districts.market;
const MARKET_KINDS: readonly PropKind[] = ['marketStall', 'fruitCrates', 'foodCart'];

function routeEdgeSet(g: RoadGraph, nodes: number[], closed: boolean): Set<number> {
  const out = new Set<number>();
  const m = closed ? nodes.length : nodes.length - 1;
  for (let k = 0; k < m; k++) out.add(edgeBetween(g, nodes[k], nodes[(k + 1) % nodes.length]));
  return out;
}

/** The first `count` seeds of a seeded stream whose `mode` route drives a market. */
function marketSeeds(stream: number, count: number, mode: RouteKind): number[] {
  const rng = new Rng(stream);
  const out: number[] = [];
  for (let i = 0; i < 80 && out.length < count; i++) {
    const seed = rng.int(0, 0x7fffffff);
    const { graph, districts, routeNodes } = planRoads(seed);
    const edges = routeEdgeSet(graph, routeNodes[mode], mode === 'circuit');
    if (districts.areas.some((a) => a.kind === 'market' && a.edges.some((e) => edges.has(e)))) out.push(seed);
  }
  return out;
}

/** Route position (m) of a plain route node: its polyline point. */
function nodeS(route: Route, g: RoadGraph, node: number): number {
  const n = g.nodes[node];
  const k = route.points.findIndex((p) => p.x === n.x && p.z === n.z);
  return k >= 0 ? route.cum[k] : NaN;
}

/** Lateral offset (m) of a point from a market's nearest edge centerline, and that edge. */
function marketLateral(w: World, area: Area, x: number, z: number): { d: number; edge: number } {
  let best = { d: Infinity, edge: -1 };
  for (const eid of area.edges) {
    const e = w.graph.edges[eid];
    const a = w.graph.nodes[e.a];
    const b = w.graph.nodes[e.b];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
    if (d < best.d) best = { d, edge: eid };
  }
  return best;
}

describe('night market', () => {
  it('goes on a straight run the routes drive on most seeds, clear of the grid and the gantries', () => {
    const rng = new Rng(6061);
    const N = 60;
    let cities = 0;
    let circuits = 0;
    let sprints = 0;
    for (let i = 0; i < N; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const { graph: g, districts, routeNodes } = planRoads(seed);
      const markets = districts.areas.filter((a) => a.kind === 'market');
      expect(markets.length).toBeLessThanOrEqual(CFG.max);
      if (!markets.length) continue;
      cities++;
      const circuit = buildRoute(g, 'circuit', routeNodes.circuit);
      const sprint = buildRoute(g, 'sprint', routeNodes.sprint);
      const onCircuit = new Set(circuit.edges);
      const onSprint = new Set(sprint.edges);
      if (markets.some((a) => a.edges.some((e) => onCircuit.has(e)))) circuits++;
      if (markets.some((a) => a.edges.some((e) => onSprint.has(e)))) sprints++;
      const nodes = new Set<number>();
      for (const a of markets) {
        // Every market is on a route, along streets narrowed inside their old corridor, straight and long enough.
        expect(a.edges.some((e) => onCircuit.has(e) || onSprint.has(e))).toBe(true);
        expect(a.params.length).toBeGreaterThanOrEqual(CFG.minLength);
        expect(a.params.length).toBeLessThanOrEqual(CFG.maxLength);
        for (const eid of a.edges) {
          const e = g.edges[eid];
          expect(e.kind).toBe('street');
          expect(e.width).toBe(CFG.width);
          expect(e.width / 2 + e.sidewalk).toBeCloseTo(CITY.width.street / 2 + CITY.sidewalkWidth.street, 9);
        }
        for (let k = 1; k + 1 < a.path.length; k++) {
          const [p, q, r] = [a.path[k - 1], a.path[k], a.path[k + 1]];
          const turn = Math.abs(Math.atan2((q.x - p.x) * (r.z - q.z) - (q.z - p.z) * (r.x - q.x), (q.x - p.x) * (r.x - q.x) + (q.z - p.z) * (r.z - q.z)));
          expect(turn).toBeLessThanOrEqual((CFG.maxBendDeg * Math.PI) / 180 + 1e-9);
        }
        // Two markets never share a junction.
        for (const p of a.path) {
          const id = g.nodes.findIndex((n) => n.x === p.x && n.z === p.z);
          expect(nodes.has(id)).toBe(false);
          nodes.add(id);
        }
        // Clear of the circuit's start line and of the sprint's grid and finish.
        for (const eid of a.edges) {
          const e = g.edges[eid];
          const A = g.nodes[e.a];
          const B = g.nodes[e.b];
          expect(distToSegment(circuit.points[0].x, circuit.points[0].z, A.x, A.z, B.x, B.z), `${seed} circuit start`).toBeGreaterThan(50);
          if (!onSprint.has(eid)) continue;
          for (const n of [e.a, e.b]) {
            const s = nodeS(sprint, g, n);
            if (Number.isNaN(s)) continue;
            expect(s, `${seed} sprint start`).toBeGreaterThanOrEqual(sprint.startS + CFG.startClear - 1);
            expect(s, `${seed} sprint finish`).toBeLessThanOrEqual(sprint.finishS - 40);
          }
        }
      }
    }
    // Measured over 200 seeds: 84% of cities have one; their circuit drives it on 95% of those, the sprint on 90%.
    expect(cities / N).toBeGreaterThan(0.7);
    expect(circuits / N).toBeGreaterThan(0.6);
    expect(sprints / N).toBeGreaterThan(0.55);
    // Same seed, same markets and the same narrowed graph.
    for (const seed of [20261019, 4242, 77]) {
      const a = planRoads(seed);
      const b = planRoads(seed);
      expect(JSON.stringify(a.districts.areas)).toBe(JSON.stringify(b.districts.areas));
      expect(JSON.stringify(a.graph.edges)).toBe(JSON.stringify(b.graph.edges));
    }
  });

  it('keeps a clear lane down the middle, stalls along both curbs, crates off the curb and street furniture out', () => {
    // A stall costs a fast car a few percent of its speed and never holds a car that is moving.
    const m = getBaseTuning('protoCompact').mass;
    for (const k of MARKET_KINDS) {
      expect(PROP_DEFS[k].breakSpeed).toBeLessThanOrEqual(0.5);
      expect(m / (m + PROP_DEFS[k].mass * PROP_DEFS[k].anchor)).toBeGreaterThan(0.94);
    }
    const seeds = [...marketSeeds(515, 3, 'circuit'), ...marketSeeds(616, 3, 'sprint')];
    expect(seeds.length).toBe(6);
    let length = 0;
    let stalls = 0;
    let spilled = 0;
    seeds.forEach((seed, i) => {
      const w = createWorld(seed, i < 3 ? 'circuit' : 'sprint');
      for (const area of w.areas.filter((a) => a.kind === 'market')) {
        length += area.params.length;
        const mine = w.props.filter((p) => p.area === area.id);
        for (const p of mine) {
          expect(MARKET_KINDS).toContain(p.kind);
          expect(pointInPolygon(p.x, p.z, area.polygon)).toBe(true);
          const { d, edge } = marketLateral(w, area, p.x, p.z);
          const e = w.graph.edges[edge];
          // Nothing reaches into the clear lane, and everything stands in front of the crowd rail.
          expect(d - p.radius, `${seed} ${p.kind}`).toBeGreaterThanOrEqual(CFG.clearHalf - 1e-9);
          expect(d + p.radius).toBeLessThan(e.width / 2 + CFG.railSetback);
          if (p.kind === 'fruitCrates' && d < e.width / 2) spilled++;
          else expect(w.surfaceAt(p.x, p.z)).toBe('sidewalk');
          if (p.kind !== 'fruitCrates') stalls++;
        }
        // No streetlights, cans, benches or bus stops on the market floor.
        for (const h of w.districts.builds[area.id].hints) {
          if (h.kind !== MARKET_HINT.edge) continue;
          const [A, B] = h.points;
          const [, , , outer] = h.values;
          const len = Math.hypot(B.x - A.x, B.z - A.z);
          for (const p of w.props) {
            if (!isStreetProp(p.kind)) continue;
            const t = segmentT(p.x, p.z, A.x, A.z, B.x, B.z) * len;
            // Left of a to b is +; each side's stall range is clear.
            const left = (B.x - A.x) * (p.z - A.z) - (B.z - A.z) * (p.x - A.x) > 0;
            const lo = h.values[left ? 8 : 10];
            const hi = h.values[left ? 9 : 11];
            if (t > lo && t < hi) expect(distToSegment(p.x, p.z, A.x, A.z, B.x, B.z), `${seed} ${p.kind}`).toBeGreaterThan(outer);
          }
        }
      }
    });
    // Packed: a stall or cart every few meters of market on each side, and crates spilling onto the road.
    expect(stalls / length).toBeGreaterThan(0.25);
    expect(spilled).toBeGreaterThan(20);
  });

  it('pens the crowd behind a closed rail, out of reach of any car', () => {
    const seeds = [...marketSeeds(717, 2, 'circuit'), ...marketSeeds(818, 2, 'sprint')];
    let pens = 0;
    let people = 0;
    seeds.forEach((seed, i) => {
      const w = createWorld(seed, i < 2 ? 'circuit' : 'sprint');
      const crowd = planMarketCrowd(w, 1);
      expect(JSON.stringify(planMarketCrowd(w, 1))).toBe(JSON.stringify(crowd));
      const pensOf: { poly: { x: number; z: number }[]; rail: number[] }[] = [];
      for (const area of w.areas.filter((a) => a.kind === 'market')) {
        for (const h of w.districts.builds[area.id].hints) {
          if (h.kind !== MARKET_HINT.pen) continue;
          pens++;
          const [r0, r1, o1, o0] = h.points;
          const [, , rnx, rnz] = h.values;
          const has = (a: { x: number; z: number }, b: { x: number; z: number }) =>
            w.walls.some((x) => x.kind === 'wall' && x.look === 'marketRail' && Math.hypot(x.ax - a.x, x.az - a.z) < 1e-9 && Math.hypot(x.bx - b.x, x.bz - b.z) < 1e-9);
          // The rail (facing the road) and both end caps back to the building line.
          expect(has(r0, r1)).toBe(true);
          expect(has(r0, o0)).toBe(true);
          expect(has(r1, o1)).toBe(true);
          const rail = w.walls.find((x) => x.look === 'marketRail' && Math.hypot(x.ax - r0.x, x.az - r0.z) < 1e-9 && Math.hypot(x.bx - r1.x, x.bz - r1.z) < 1e-9)!;
          expect(rail.nx * rnx + rail.nz * rnz).toBeCloseTo(1, 9);
          // The road lies in front of the rail.
          const e = w.graph.edges[h.values[0]];
          const mid = { x: (w.graph.nodes[e.a].x + w.graph.nodes[e.b].x) / 2, z: (w.graph.nodes[e.a].z + w.graph.nodes[e.b].z) / 2 };
          expect((mid.x - r0.x) * rnx + (mid.z - r0.z) * rnz).toBeGreaterThan(0);
          // The building line behind the pen is walled end to end (the infill never opens it): facades or the market's back wall.
          const len = Math.hypot(o1.x - o0.x, o1.z - o0.z);
          for (let s = 0.25; s < len; s += 0.5) {
            const x = o0.x + ((o1.x - o0.x) * s) / len;
            const z = o0.z + ((o1.z - o0.z) * s) / len;
            expect(w.walls.some((q) => q.kind === 'wall' && q.look === 'marketFront' && distToSegment(x, z, q.ax, q.az, q.bx, q.bz) < 0.05), `${seed} frontage at ${s}`).toBe(true);
          }
          pensOf.push({ poly: [r0, r1, o1, o0], rail: [r0.x, r0.z, rnx, rnz] });
        }
      }
      // Everybody stands inside a pen, behind its rail.
      for (const stand of crowd) {
        for (const p of stand) {
          people++;
          const pen = pensOf.find((q) => pointInPolygon(p.x, p.z, q.poly));
          expect(pen, `${seed} person at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`).toBeDefined();
          const [rx, rz, nx, nz] = pen!.rail;
          expect((p.x - rx) * nx + (p.z - rz) * nz).toBeLessThan(-0.3);
          expect(w.surfaceAt(p.x, p.z)).toBe('sidewalk');
        }
      }
      // Lantern masts stand on the rails, and the real lights sit over the street.
      for (const e of marketEdges(w)) for (const m of e.masts) expect(w.walls.some((q) => q.look === 'marketRail' && distToSegment(m.x, m.z, q.ax, q.az, q.bx, q.bz) < 0.2)).toBe(true);
      for (const l of marketLightPoints(w)) expect(w.areaAt(l.x, l.z)?.kind).toBe('market');
    });
    expect(pens).toBeGreaterThan(8);
    expect(people).toBeGreaterThan(pens * 60);
  });

  it('lets a car plough down a row of stalls and keep going', () => {
    const [seed] = marketSeeds(919, 1, 'circuit');
    const r = createRace(raceConfig(seed, 'circuit', 0));
    while (r.tick < r.countdownTicks) stepRace(r, NEUTRAL_INPUT);
    const w = r.world;
    const area = w.areas.find((a) => a.kind === 'market' && a.edges.some((e) => w.route.edges.includes(e)))!;
    // The longest run of stalls on one side of one edge: drive down the stall line from just before its first stall.
    const h = w.districts.builds[area.id].hints.find((x) => x.kind === MARKET_HINT.edge && x.values[5] - x.values[4] > 40)!;
    const [A, B] = h.points;
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const lat = h.values[1] + CFG.stallSetback;
    const stallsAhead = w.props.filter((p) => p.area === area.id && p.kind !== 'fruitCrates' && Math.abs((p.x - A.x) * -uz + (p.z - A.z) * ux - lat) < 0.2);
    expect(stallsAhead.length).toBeGreaterThan(6);
    const rc = r.cars[0];
    const c = rc.state;
    const s0 = h.values[4] - 4;
    c.x = A.x + ux * s0 - uz * lat;
    c.z = A.z + uz * s0 + ux * lat;
    c.y = w.driveHeightAt(c.x, c.z);
    c.yaw = Math.atan2(ux, uz);
    c.vx = ux * 22;
    c.vz = uz * 22;
    c.yawRate = 0;
    rc.seg = -1;
    const before = r.events.length;
    for (let k = 0; k < 150; k++) stepRace(r, { ...NEUTRAL_INPUT, throttle: 1 });
    const broken = r.events.slice(before).filter((e) => e.type === 'prop' && w.props[e.value!].area === area.id).length;
    const along = (c.x - A.x) * ux + (c.z - A.z) * uz - s0;
    // Through a whole row, still rolling, never reset.
    expect(broken).toBeGreaterThan(5);
    expect(along).toBeGreaterThan(30);
    expect(Math.hypot(c.vx, c.vz)).toBeGreaterThan(8);
    expect(r.events.slice(before).some((e) => e.type === 'reset')).toBe(false);
  });

  it('AI fields race through the market without getting stuck, and replay identically', () => {
    const runs: [number, RouteKind][] = [
      [marketSeeds(1212, 1, 'circuit')[0], 'circuit'],
      [marketSeeds(1313, 1, 'sprint')[0], 'sprint'],
    ];
    for (const [seed, mode] of runs) {
      const r = runAutopilot(raceConfig(seed, mode, 3, undefined, 1), 420, true);
      for (const car of r.cars) {
        expect(car.finished, `${seed} ${mode} ${car.name}`).toBe(true);
        expect(r.events.filter((e) => e.type === 'reset' && e.car === car.index).length, `${seed} ${mode} ${car.name}`).toBeLessThanOrEqual(1);
      }
    }
    // Stalls smashed on the way replay exactly.
    const cfg = raceConfig(runs[0][0], 'circuit', 3);
    const r = runAutopilot(cfg, 50);
    const again = replayLog(cfg, r.inputLog);
    expect(carSnapshot(again)).toBe(carSnapshot(r));
    expect(Array.from(again.brokenProps)).toEqual(Array.from(r.brokenProps));
  });
});
