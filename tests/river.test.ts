import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createWorld, planRoads } from '../src/city/world';
import type { World } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import { CITY } from '../src/city/config';
import { createTerrain } from '../src/city/terrain';
import { bridgePoint, bridgesOf, distToBridge, rampAlong, rampPoint, rampProfile, rampsOf, riverCenter, riverL, riverSlope } from '../src/city/districts/river';
import type { Bridge } from '../src/city/districts/river';
import { isRiverEdge } from '../src/city/roadGraph';
import type { RoadGraph } from '../src/city/roadGraph';
import { distToSegment, yawOf } from '../src/sim/math';
import { createRace, stepRace } from '../src/sim/race';
import type { RaceState } from '../src/sim/race';
import { placeCar } from '../src/sim/car';
import { autopilotInput, createAi } from '../src/sim/ai';
import { TICK_HZ } from '../src/sim/constants';
import { carSnapshot, input, raceConfig, replayLog, runAutopilot } from './helpers';

const CFG = CITY.districts.river;

/** planRoads for every seed of a stream that has a river with entrances, with the stats the tests share. */
function riverSeeds(count: number, stream: number) {
  const rng = new Rng(stream);
  const out: { seed: number; plan: ReturnType<typeof planRoads>; ramps: ReturnType<typeof rampsOf> }[] = [];
  let rivers = 0;
  let tried = 0;
  while (out.length < count && tried < count * 3) {
    tried++;
    const seed = rng.int(0, 0x7fffffff);
    const plan = planRoads(seed);
    const river = plan.districts.areas.find((a) => a.kind === 'river');
    if (!river) continue;
    rivers++;
    out.push({ seed, plan, ramps: rampsOf(river) });
  }
  return { seeds: out, rivers, tried };
}

const cross = (a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }) => {
  const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
  if (Math.abs(den) < 1e-9) return false;
  const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
};

/** The channel chain's nodes in x order, asserting it is one path from end to end. */
function channelChain(g: RoadGraph): number[] {
  const degree = new Map<number, number>();
  for (const e of g.edges) {
    if (e.kind !== 'channel') continue;
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  const ends = [...degree.entries()].filter(([, d]) => d === 1).map(([id]) => id);
  expect(ends.length).toBe(2);
  for (const d of degree.values()) expect(d).toBeLessThanOrEqual(2);
  // Walk from the west end: every channel node is reached.
  const start = ends.sort((a, b) => g.nodes[a].x - g.nodes[b].x)[0];
  const order = [start];
  let prev = -1;
  let cur = start;
  for (let guard = 0; guard < degree.size + 2; guard++) {
    const next = g.nodes[cur].edges.map((eid) => g.edges[eid]).filter((e) => e.kind === 'channel').map((e) => (e.a === cur ? e.b : e.a)).find((id) => id !== prev);
    if (next === undefined) break;
    order.push(next);
    prev = cur;
    cur = next;
  }
  expect(order.length).toBe(degree.size);
  return order;
}

/** An open world race on a seed (no opponents, no barriers), racing from tick 0 (every timed gate open). */
function freeRoam(seed: number): RaceState {
  const r = createRace({ ...raceConfig(seed, 'circuit', 0), openWorld: true });
  r.phase = 'racing';
  return r;
}

/** Drive the player car with full throttle for `ticks`, calling `check` after every tick. */
function drive(r: RaceState, ticks: number, check: (tick: number) => void): void {
  for (let i = 0; i < ticks; i++) {
    stepRace(r, input({ throttle: 1 }));
    check(i);
  }
}

describe('river channel racing', () => {
  it('nearly every seed has a river: one channel chain end to end, 6-8 entrances with one in every quarter, banks alternating, fords and side ramps', () => {
    const { seeds, rivers, tried } = riverSeeds(60, 4040);
    expect(rivers / tried).toBeGreaterThan(0.75);
    let fords = 0;
    let seedsWithFords = 0;
    let threeQuarters = 0;
    let alternating = 0;
    let pairs = 0;
    for (const { plan, ramps } of seeds) {
      const g = plan.graph;
      const river = plan.districts.areas.find((a) => a.kind === 'river')!;
      const p = river.params;
      const entrances = ramps.filter((r) => !r.ford).length + ramps.filter((r) => r.ford).length;
      expect(entrances).toBeGreaterThanOrEqual(CFG.entrances[0]);
      expect(entrances).toBeLessThanOrEqual(CFG.entrances[1]);
      const chain = channelChain(g);
      // From one portal's stub to the other's.
      expect(g.nodes[chain[0]].x).toBeLessThan(p.x0 + CFG.endStub + 1);
      expect(g.nodes[chain[chain.length - 1]].x).toBeGreaterThan(p.x1 - CFG.endStub - 1);
      // Every node of the chain on the centerline, chords short enough to hug the meander.
      for (let i = 0; i < chain.length; i++) {
        const n = g.nodes[chain[i]];
        expect(Math.abs(riverL(p, n.x, n.z))).toBeLessThan(0.05);
        if (i) expect(g.nodes[chain[i]].x - g.nodes[chain[i - 1]].x).toBeLessThan(CFG.nodeSpacing + 2 * (CFG.bridgeBody + 20));
      }
      const feet = new Set<number>();
      for (const r of ramps) {
        const e = g.edges[r.edge];
        expect(e.kind).toBe('ramp');
        expect(e.sidewalk).toBe(0);
        // From a street node (its other roads are streets) to a foot on the chain.
        expect(new Set([e.a, e.b])).toEqual(new Set([r.node, r.foot]));
        expect(g.nodes[r.node].edges.some((eid) => !isRiverEdge(g.edges[eid]))).toBe(true);
        expect(chain).toContain(r.foot);
        feet.add(r.foot);
        if (r.ford) fords++;
      }
      if (ramps.some((r) => r.ford)) seedsWithFords++;
      // One entrance in every quarter of the channel's length, the feet entranceGap apart.
      const quarter = (x: number) => Math.max(0, Math.min(3, Math.floor((4 * (x - g.bounds.minX)) / (g.bounds.maxX - g.bounds.minX))));
      const footXs = [...feet].map((id) => g.nodes[id].x).sort((a, b) => a - b);
      // (On the curved grid one seed in sixty or so has no row pair seating all four: three then.)
      const quarters = new Set(footXs.map(quarter)).size;
      expect(quarters).toBeGreaterThanOrEqual(3);
      if (quarters < 4) threeQuarters++;
      for (let i = 1; i < footXs.length; i++) expect(footXs[i] - footXs[i - 1]).toBeGreaterThanOrEqual(CFG.entranceGap - 0.5);
      // Banks alternate along the channel where the planner could (a ford serves both).
      const sides = [...feet].sort((a, b) => g.nodes[a].x - g.nodes[b].x).map((id) => ramps.filter((r) => r.foot === id).map((r) => r.side));
      for (let i = 1; i < sides.length; i++) {
        if (sides[i].length > 1 || sides[i - 1].length > 1) continue;
        pairs++;
        if (sides[i][0] !== sides[i - 1][0]) alternating++;
      }
      // Channel edges join channel nodes only (ramps meet them at the feet).
      for (const e of g.edges) {
        if (e.kind !== 'channel') continue;
        for (const id of [e.a, e.b]) expect(g.nodes[id].edges.every((eid) => isRiverEdge(g.edges[eid]))).toBe(true);
      }
      // Every crossing street is a bridge chain or a ford, and the meander is a real swing on most seeds.
      const bridges = bridgesOf(g, river);
      expect(bridges.length).toBeGreaterThan(3);
      for (const br of bridges) for (const eid of br.edges) expect(g.edges[eid].bridge).toBe(true);
    }
    expect(fords % 2).toBe(0);
    expect(seedsWithFords).toBeGreaterThan(seeds.length * 0.6);
    // Where the swing leaves one bank no run the other bank serves, so not every pair can alternate
    // (a little more often on the curved grid, roadGraph.ts CITY.warp).
    expect(alternating).toBeGreaterThan(pairs * 0.55);
    const swings = seeds.filter(({ plan }) => plan.districts.areas.find((a) => a.kind === 'river')!.params.meander > 0).length;
    expect(swings).toBeGreaterThan(seeds.length * 0.6);
    expect(threeQuarters).toBeLessThanOrEqual(1);
  });

  it('the centerline follows the midline between the bank rows, smoothly, with an exact slope', () => {
    const { seeds } = riverSeeds(8, 8181);
    for (const { plan } of seeds) {
      const g = plan.graph;
      const river = plan.districts.areas.find((a) => a.kind === 'river')!;
      const p = river.params;
      // Between the two bank rows everywhere (the grid nodes nearest above and below), and the swing never larger than configured.
      for (let x = g.bounds.minX; x <= g.bounds.maxX; x += 25) {
        const z = riverCenter(p, x);
        const above = g.nodes.filter((n) => n.gj >= 0 && Math.abs(n.x - x) < CITY.spacing * 0.6 && n.z > z).map((n) => n.z);
        const below = g.nodes.filter((n) => n.gj >= 0 && Math.abs(n.x - x) < CITY.spacing * 0.6 && n.z < z).map((n) => n.z);
        expect(above.length).toBeGreaterThan(0);
        expect(below.length).toBeGreaterThan(0);
        const mid = (Math.min(...above) + Math.max(...below)) / 2;
        expect(Math.abs(z - mid)).toBeLessThan(CFG.meander + CITY.jitter + 4);
      }
      for (let x = p.x0; x <= p.x1; x += 7.3) {
        const e = 0.01;
        const num = (riverCenter(p, x + e) - riverCenter(p, x - e)) / (2 * e);
        expect(Math.abs(num - riverSlope(p, x))).toBeLessThan(1e-3);
        // Gentle: a car along the channel never turns hard (the warp tilts whole rows by up to about 0.26 plus the meander: a heading, not a turn).
        expect(Math.abs(riverSlope(p, x))).toBeLessThan(0.35);
      }
      // Every junction clears the band (the river's own nodes, feet and chain, are in it).
      for (const n of g.nodes) {
        if (n.edges.some((eid) => isRiverEdge(g.edges[eid]))) continue;
        if (n.edges.length !== 2 || n.gj >= 0) expect(Math.abs(riverL(p, n.x, n.z))).toBeGreaterThan(p.top + CFG.junctionClear - 0.01);
      }
    }
  });

  it('routes dive into the channel on most river seeds, run a good stretch, never start or finish in it', () => {
    const { seeds } = riverSeeds(60, 5151);
    let circuits = 0;
    let sprints = 0;
    let stretch = 0;
    let stretches = 0;
    for (const { plan } of seeds) {
      const g = plan.graph;
      for (const kind of ['circuit', 'sprint'] as const) {
        const route = buildRoute(g, kind, plan.routeNodes[kind]);
        const dives = route.edges.some((e) => g.edges[e].kind === 'channel');
        if (dives) kind === 'circuit' ? circuits++ : sprints++;
        // The grid and the finish stay on streets.
        expect(isRiverEdge(g.edges[route.edges[0]])).toBe(false);
        expect(isRiverEdge(g.edges[route.edges[route.edges.length - 1]])).toBe(false);
        let run = 0;
        for (const e of route.edges) {
          if (g.edges[e].kind === 'channel') run += g.edges[e].length;
          else if (run > 0) {
            stretch += run;
            stretches++;
            run = 0;
          }
        }
        if (run > 0) {
          stretch += run;
          stretches++;
        }
      }
    }
    expect(circuits).toBeGreaterThan(seeds.length * 0.7);
    expect(sprints).toBeGreaterThan(seeds.length * 0.7);
    expect(stretch / Math.max(1, stretches)).toBeGreaterThan(120);
  });

  it('the floor, banks and ramps are drivable terrain: a smooth run with a rounded lip and a kink at the foot, no wall across but a deck parapet overhead', () => {
    const { seeds } = riverSeeds(5, 6262);
    for (const [i, { seed }] of seeds.entries()) {
      const w = createWorld(seed, i % 2 ? 'sprint' : 'circuit');
      const base = createTerrain(seed);
      const river = w.areas.find((a) => a.kind === 'river')!;
      const p = river.params;
      const g = w.graph;
      const cityWalls = w.walls.filter((x) => x.kind === 'wall');
      for (const e of g.edges) {
        if (!isRiverEdge(e)) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        // Nothing solid across a channel or ramp edge (closures are rails, not city walls), except a
        // bridge deck's parapets, which a car on the floor passes under (Wall.bottom).
        for (const wall of cityWalls) {
          if (!cross(a, b, { x: wall.ax, z: wall.az }, { x: wall.bx, z: wall.bz })) continue;
          expect(wall.look, `${wall.look} across a ${e.kind} edge, seed ${seed}`).toBe('parapet');
          expect(wall.bottom).toBeDefined();
          expect(wall.bottom!).toBeLessThan(w.heightAt((wall.ax + wall.bx) / 2, (wall.az + wall.bz) / 2) - 1);
        }
        if (e.kind !== 'channel') continue;
        // The floor runs the channel's full depth below the base terrain and drives like a road, under
        // the decks included (asked with a body down on the floor).
        for (const t of [0.25, 0.5, 0.75]) {
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          expect(base.heightAt(x, z) - w.heightAt(x, z, -Infinity)).toBeGreaterThan(p.depth - 0.05);
          expect(['road', 'concrete', 'water']).toContain(w.surfaceAt(x, z, -Infinity));
        }
      }
      for (const r of rampsOf(river)) {
        const aF = rampAlong(p, r, p.floor);
        const aTop = rampAlong(p, r, r.topL);
        // Grade along the axis: gentle at the lip, under the design limit, and the foot a step of nothing.
        let maxGrade = 0;
        let prevH = w.heightAt(rampPoint(r, 0, 0).x, rampPoint(r, 0, 0).z);
        for (let s = 0.5; s <= aTop + 6; s += 0.5) {
          const q = rampPoint(r, s, 0);
          const hh = w.heightAt(q.x, q.z);
          const grade = Math.abs(hh - prevH) / 0.5;
          if (s > aF + 0.6) maxGrade = Math.max(maxGrade, grade);
          // No step anywhere along the run: the surface is continuous.
          expect(Math.abs(hh - prevH)).toBeLessThan(0.12);
          prevH = hh;
        }
        // The design grade (about 14%) plus whatever the rolling base terrain adds (up to about 5%).
        expect(maxGrade).toBeLessThan(0.2);
        const lipGrade = Math.abs(w.heightAt(rampPoint(r, aTop - 1, 0).x, rampPoint(r, aTop - 1, 0).z) - w.heightAt(rampPoint(r, aTop - 1.5, 0).x, rampPoint(r, aTop - 1.5, 0).z)) / 0.5;
        expect(lipGrade).toBeLessThan(maxGrade * 0.6);
        // The trench is as deep as the floor at its foot, and the surface there is the ramp's concrete.
        const foot = rampPoint(r, aF + 0.3, 0);
        expect(base.heightAt(foot.x, foot.z) - w.heightAt(foot.x, foot.z)).toBeGreaterThan(p.depth - 0.15);
        expect(['road', 'concrete']).toContain(w.surfaceAt(foot.x, foot.z));
        // Its walls stand just outside its drivable width, never in it.
        for (const wall of cityWalls) {
          if (wall.look !== 'trench') continue;
          for (const t of [0.1, 0.5, 0.9]) {
            const x = wall.ax + (wall.bx - wall.ax) * t;
            const z = wall.az + (wall.bz - wall.az) * t;
            const e = g.edges[r.edge];
            const a = g.nodes[e.a];
            const b = g.nodes[e.b];
            expect(distToSegment(x, z, a.x, a.z, b.x, b.z)).toBeGreaterThan(r.hw - 0.05);
          }
        }
      }
      // A route through the channel has every channel node's off-route edges closed, fence to fence.
      for (const grp of w.barrierGroups) {
        for (const eid of grp.edges) {
          if (g.edges[eid].kind !== 'channel') continue;
          expect(grp.length).toBeGreaterThan(2 * (p.top - 1));
        }
      }
    }
  });

  it('every bridge is two levels: the deck for anyone, the channel floor for a body down there, each with its own walls', () => {
    const { seeds } = riverSeeds(3, 9090);
    for (const { seed } of seeds) {
      const w = createWorld(seed, 'circuit');
      const river = w.areas.find((a) => a.kind === 'river')!;
      const p = river.params;
      const bridges = bridgesOf(w.graph, river);
      const base = createTerrain(seed);
      const contacts: never[] = [];
      for (const br of bridges) {
        const deckTop = w.heightAt(br.cx, br.cz);
        // On the axis over the centerline: the deck at street level without a body height or with one
        // up on the deck, the floor with one down in the channel; a body half way down goes to the floor.
        expect(Math.abs(deckTop - base.heightAt(br.cx, br.cz))).toBeLessThan(0.05);
        expect(w.heightAt(br.cx, br.cz, deckTop)).toBe(deckTop);
        expect(w.heightAt(br.cx, br.cz, deckTop + 3)).toBe(deckTop);
        const floor = w.heightAt(br.cx, br.cz, -Infinity);
        expect(deckTop - floor).toBeGreaterThan(p.depth - 0.05);
        expect(w.heightAt(br.cx, br.cz, floor)).toBe(floor);
        expect(w.heightAt(br.cx, br.cz, deckTop - p.depth / 2 - 0.3)).toBe(floor);
        expect(w.driveHeightAt(br.cx, br.cz, -Infinity)).toBe(floor);
        expect(w.twoLevels(br.cx, br.cz)).toBe(true);
        // Surfaces: the street on top, the channel's concrete (or its trickle) below; the deck's sidewalk
        // is a sidewalk up there and the floor beneath it.
        expect(['road']).toContain(w.surfaceAt(br.cx, br.cz));
        expect(['concrete', 'water']).toContain(w.surfaceAt(br.cx, br.cz, -Infinity));
        const walk = bridgePoint(p, br, br.dk - 1.5, 0);
        expect(w.surfaceAt(walk.x, walk.z)).toBe('sidewalk');
        expect(['concrete', 'water']).toContain(w.surfaceAt(walk.x, walk.z, -Infinity));
        // The lower level's slope is exact.
        for (const [dw, dl] of [
          [-4, -6],
          [3, 2],
          [5, 13],
        ]) {
          const q = bridgePoint(p, br, dw, dl);
          const s = w.slopeAt(q.x, q.z, -Infinity);
          const e = 0.002;
          const gx = (w.heightAt(q.x + e, q.z, -Infinity) - w.heightAt(q.x - e, q.z, -Infinity)) / (2 * e);
          const gz = (w.heightAt(q.x, q.z + e, -Infinity) - w.heightAt(q.x, q.z - e, -Infinity)) / (2 * e);
          expect(Math.abs(s.gx - gx)).toBeLessThan(2e-3);
          expect(Math.abs(s.gz - gz)).toBeLessThan(2e-3);
        }
        // Walls: parapets along both deck edges with a bottom a channel car clears, piers and abutments
        // beneath with a top a deck car clears; the parapet line is nothing to a body on the floor, the
        // piers nothing to a body on the deck.
        const own = w.walls.filter((x) => x.kind === 'wall' && x.area === river.id);
        const near = (look: string) => own.filter((x) => x.look === look && distToSegment(br.cx, br.cz, x.ax, x.az, x.bx, x.bz) < p.top + 8);
        expect(near('parapet').length).toBeGreaterThanOrEqual(2);
        // Each parapet's underside lies between the floor and the deck at the wall: a channel car passes
        // under it, a deck car never does.
        for (const x of near('parapet')) {
          const mx = (x.ax + x.bx) / 2;
          const mz = (x.az + x.bz) / 2;
          expect(x.bottom!).toBeLessThan(w.heightAt(mx, mz) - 0.5);
          expect(x.bottom!).toBeGreaterThan(w.heightAt(mx, mz, -Infinity) + 1);
        }
        expect(near('pier').length).toBeGreaterThanOrEqual(8);
        // Each pier's top sits just under the deck over it (the deck follows the rolling base terrain along the bridge).
        for (const x of near('pier')) {
          const mx = (x.ax + x.bx) / 2;
          const mz = (x.az + x.bz) / 2;
          expect(x.top!).toBeLessThan(w.heightAt(mx, mz) - 0.3);
          expect(x.top!).toBeGreaterThan(w.heightAt(mx, mz, -Infinity) + 1);
        }
        // The abutment boxes: four faces on each bank, along the deck's own polyline (skewed on a diagonal).
        const abutments = own.filter((x) => x.look === 'culvert' && distToBridge(br, (x.ax + x.bx) / 2, (x.az + x.bz) / 2) < br.dk + CFG.bridgeBody + 1 && Math.abs(riverL(p, (x.ax + x.bx) / 2, (x.az + x.bz) / 2)) < p.top + 2);
        expect(abutments.length).toBeGreaterThanOrEqual(8);
        const edge = bridgePoint(p, br, br.dk - 0.3, 1);
        expect(w.collideCircle(edge.x, edge.z, 1.2, contacts, floor)).toBe(0);
        expect(w.collideCircle(edge.x, edge.z, 1.2, contacts, deckTop)).toBeGreaterThan(0);
        // Probed from a pier's face toward the floor (its other faces look at the parapet line or the next pier).
        const pier = near('pier').reduce((best, x) => (Math.abs(riverL(p, (x.ax + x.bx) / 2, (x.az + x.bz) / 2)) < Math.abs(riverL(p, (best.ax + best.bx) / 2, (best.az + best.bz) / 2)) ? x : best));
        expect(w.collideCircle((pier.ax + pier.bx) / 2 + pier.nx * 0.8, (pier.az + pier.bz) / 2 + pier.nz * 0.8, 1, contacts, deckTop)).toBe(0);
        expect(w.collideCircle((pier.ax + pier.bx) / 2 + pier.nx * 0.8, (pier.az + pier.bz) / 2 + pier.nz * 0.8, 1, contacts, floor)).toBeGreaterThan(0);
      }
    }
  });

  it('a car drives the floor under every deck without stopping or climbing, and the deck over it without dropping', () => {
    const { seeds } = riverSeeds(3, 7070);
    let decks = 0;
    for (const { seed } of seeds) {
      const r = freeRoam(seed);
      const w = r.world;
      const river = w.areas.find((a) => a.kind === 'river')!;
      const p = river.params;
      const rc = r.cars[0];
      const c = rc.state;
      for (const br of bridgesOf(w.graph, river)) {
        decks++;
        // Along the floor, from 50 m before the crossing to well past it, hugging the centerline.
        r.tick = 0;
        r.events.length = 0;
        const x0 = br.cx - 50;
        placeCar(c, x0, riverCenter(p, x0), yawOf(1, riverSlope(p, x0)), w, -Infinity);
        let minSpeed = Infinity;
        drive(r, 6 * TICK_HZ, (tick) => {
          const deck = w.heightAt(c.x, c.z);
          const low = w.heightAt(c.x, c.z, -Infinity);
          // Wherever the deck is a full level above the floor, the car stays down on the floor.
          if (deck - low > p.depth * 0.8) expect(c.y, `climbed toward the deck under bridge ${br.edge} of seed ${seed}`).toBeLessThan(deck - p.depth / 2);
          expect(Math.abs(riverL(p, c.x, c.z))).toBeLessThan(p.floor);
          // From 3 s on, past the launch from rest (the bridge is 50 m ahead, reached at about 5 s).
          if (tick > 3 * TICK_HZ) minSpeed = Math.min(minSpeed, c.speed);
        });
        expect(c.x, `stopped short under bridge ${br.edge} of seed ${seed}`).toBeGreaterThan(br.cx + 25);
        expect(minSpeed, `slowed under bridge ${br.edge} of seed ${seed}`).toBeGreaterThan(10);
        expect(r.events.filter((e) => e.type === 'reset')).toEqual([]);
        // Over the deck, along the street from 30 m before the band to well past it (a diagonal crosses
        // the band slowly, so the run is long).
        r.tick = 0;
        r.events.length = 0;
        const from = bridgePoint(p, br, 0, -(p.top + 30));
        placeCar(c, from.x, from.z, yawOf(br.dx, br.dz), w);
        drive(r, 9 * TICK_HZ, () => {
          if (w.twoLevels(c.x, c.z)) expect(c.y, `dropped off the deck of bridge ${br.edge} of seed ${seed}`).toBeGreaterThan(w.heightAt(c.x, c.z) - 1);
        });
        expect(riverL(p, c.x, c.z), `stopped on the deck of bridge ${br.edge} of seed ${seed}`).toBeGreaterThan(p.top + 10);
        expect(r.events.filter((e) => e.type === 'reset')).toEqual([]);
      }
    }
    expect(decks).toBeGreaterThan(8);
  });

  it('every ramp top has a funnel of fences and clutter and string lights over its mouth, never a sign', () => {
    const { seeds } = riverSeeds(4, 3030);
    for (const { seed } of seeds) {
      const w = createWorld(seed, 'sprint');
      const river = w.areas.find((a) => a.kind === 'river')!;
      const p = river.params;
      const build = w.districts.builds[river.id];
      for (const r of rampsOf(river)) {
        const top = rampPoint(r, rampAlong(p, r, r.topL), 0);
        const near = w.props.filter((q) => (q.x - top.x) ** 2 + (q.z - top.z) ** 2 < 22 * 22);
        const count = (kind: string) => near.filter((q) => q.kind === kind).length;
        expect(count('fencePanel'), `fences at a ramp top of seed ${seed}`).toBeGreaterThanOrEqual(2);
        expect(count('trafficCone'), `cones at a ramp top of seed ${seed}`).toBeGreaterThanOrEqual(5);
        expect(count('sawhorse'), `sawhorses at a ramp top of seed ${seed}`).toBeGreaterThanOrEqual(1);
        expect(near.some((q) => q.kind === 'waterBarrier' || q.kind === 'sandbags')).toBe(true);
        // Everything in the funnel breaks before it stops a car.
        for (const q of near) if (q.area === river.id) expect(q.mass).toBeLessThan(130);
        const strings = build.hints.filter((h) => h.kind === 'stringLights' && Math.hypot(h.points[0].x - top.x, h.points[0].z - top.z) < 30);
        expect(strings.length).toBe(2);
      }
    }
  });

  it('the ramp profile is C1 at the lip and a hard kink at the foot', () => {
    expect(rampProfile(0).f).toBe(0);
    expect(rampProfile(0).df).toBe(0);
    expect(rampProfile(1).f).toBeCloseTo(1, 9);
    expect(rampProfile(1).df).toBeGreaterThan(1);
    for (let u = 0.01; u < 1; u += 0.01) {
      const d = (rampProfile(u + 1e-5).f - rampProfile(u - 1e-5).f) / 2e-5;
      expect(Math.abs(d - rampProfile(u).df)).toBeLessThan(1e-3);
    }
  });

  it('a route over a bridge and through the channel under it keeps its progress: no jump at the crossing', () => {
    // A seed whose circuit uses a bridge deck and the channel beneath it (its edges cross in plan).
    const rng = new Rng(1212);
    let found: { seed: number; br: Bridge } | null = null;
    for (let i = 0; i < 120 && !found; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const plan = planRoads(seed);
      const river = plan.districts.areas.find((a) => a.kind === 'river');
      if (!river) continue;
      const g = plan.graph;
      const route = buildRoute(g, 'circuit', plan.routeNodes.circuit);
      const onRoute = new Set(route.edges);
      for (const br of bridgesOf(g, river)) {
        if (!br.edges.some((e) => onRoute.has(e))) continue;
        const under = route.edges.some((e) => {
          const ed = g.edges[e];
          if (ed.kind !== 'channel') return false;
          const a = g.nodes[ed.a];
          const b = g.nodes[ed.b];
          return br.pts.some((q, k) => k + 1 < br.pts.length && cross(a, b, q, br.pts[k + 1]));
        });
        if (under) found = { seed, br };
      }
    }
    expect(found, 'a circuit over and under one bridge within 120 seeds').toBeTruthy();
    const { seed, br } = found!;
    const r = createRace(raceConfig(seed, 'circuit', 0));
    const rc = r.cars[0];
    const w = r.world;
    const ai = createAi(7, 0.97);
    let prevS = rc.rawS;
    let crossedOver = false;
    let crossedUnder = false;
    // (The deck comes late in this seed's lap on the curved grid: about 153 s in.)
    for (let i = 0; i < 200 * TICK_HZ && !(crossedOver && crossedUnder); i++) {
      stepRace(r, autopilotInput(r, rc, ai));
      const c = rc.state;
      let d = rc.rawS - prevS;
      if (d < -w.route.length / 2) d += w.route.length;
      if (d > w.route.length / 2) d -= w.route.length;
      // Progress follows the car: never a jump between the deck's and the channel's part of the route
      // (a corner cut elsewhere moves the projection by a few metres; at the crossing both are straight).
      const atCrossing = Math.hypot(c.x - br.cx, c.z - br.cz) < 25;
      expect(Math.abs(d), `progress jumped ${d.toFixed(1)} m at tick ${r.tick} (seed ${seed})`).toBeLessThan(atCrossing ? 4 : 14);
      prevS = rc.rawS;
      if (Math.hypot(c.x - br.cx, c.z - br.cz) < 8) {
        if (c.y > w.heightAt(c.x, c.z) - 1) crossedOver = true;
        else crossedUnder = true;
      }
    }
    expect(crossedOver && crossedUnder, `the car crossed the bridge on top (${crossedOver}) and beneath (${crossedUnder})`).toBe(true);
    expect(r.events.filter((e) => e.type === 'reset')).toEqual([]);
  });

  it('plans the same river every time, and a race through the channel replays bit for bit', () => {
    const rng = new Rng(7373);
    for (let i = 0; i < 4; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const a = planRoads(seed);
      const b = planRoads(seed);
      const strip = (plan: typeof a) => JSON.stringify({ edges: plan.graph.edges, nodes: plan.graph.nodes, routes: plan.routeNodes, areas: plan.districts.areas.map((x) => ({ kind: x.kind, params: x.params, edges: x.edges, nodes: x.nodes })) });
      expect(strip(a)).toBe(strip(b));
    }
    const { seeds } = riverSeeds(1, 7474);
    const cfg = raceConfig(seeds[0].seed, 'circuit', 2);
    const a = runAutopilot(cfg, 45);
    const b = runAutopilot(cfg, 45);
    expect(carSnapshot(a)).toBe(carSnapshot(b));
    const replay = replayLog(cfg, a.inputLog);
    expect(carSnapshot(replay)).toBe(carSnapshot(a));
    // The world's walls under the decks were settled the same way both times.
    const settled = (w: World) => JSON.stringify(w.walls.filter((x) => x.bottom !== undefined || x.top !== undefined).map((x) => [x.look, x.top, x.bottom]));
    expect(settled(a.world)).toBe(settled(b.world));
  });
});
