import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createWorld, planRoads } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import { CITY } from '../src/city/config';
import { createTerrain } from '../src/city/terrain';
import { rampAlong, rampPoint, rampProfile, rampsOf, riverCenter } from '../src/city/districts/river';
import { isRiverEdge } from '../src/city/roadGraph';
import { distToSegment } from '../src/sim/math';

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

describe('river channel racing', () => {
  it('nearly every seed has a river with 4-6 entrances, fords and side ramps joined into the road graph', () => {
    const { seeds, rivers, tried } = riverSeeds(60, 4040);
    expect(rivers / tried).toBeGreaterThan(0.75);
    let fords = 0;
    for (const { plan, ramps } of seeds) {
      const g = plan.graph;
      expect(ramps.length).toBeGreaterThanOrEqual(CFG.entrances[0] - 1);
      expect(ramps.length).toBeLessThanOrEqual(CFG.entrances[1]);
      for (const r of ramps) {
        const e = g.edges[r.edge];
        expect(e.kind).toBe('ramp');
        expect(e.sidewalk).toBe(0);
        // From a street node (its other roads are streets) to a foot on the centerline with channel edges.
        expect(new Set([e.a, e.b])).toEqual(new Set([r.node, r.foot]));
        expect(g.nodes[r.node].edges.some((eid) => !isRiverEdge(g.edges[eid]))).toBe(true);
        expect(g.nodes[r.foot].edges.some((eid) => g.edges[eid].kind === 'channel')).toBe(true);
        const river = plan.districts.areas.find((a) => a.kind === 'river')!;
        expect(Math.abs(g.nodes[r.foot].z - riverCenter(river.params, g.nodes[r.foot].x))).toBeLessThan(0.05);
        if (r.ford) fords++;
      }
      // Channel edges join channel nodes only; no channel node joins more than two of them.
      for (const e of g.edges) {
        if (e.kind !== 'channel') continue;
        for (const id of [e.a, e.b]) {
          const n = g.nodes[id];
          expect(n.edges.every((eid) => isRiverEdge(g.edges[eid]))).toBe(true);
          expect(n.edges.filter((eid) => g.edges[eid].kind === 'channel').length).toBeLessThanOrEqual(2);
        }
      }
    }
    // Fords come in pairs of halves and most rivers have at least one.
    expect(fords % 2).toBe(0);
    expect(fords / 2).toBeGreaterThan(seeds.length * 0.8);
  });

  it('routes dive into the channel on most river seeds, never starting or finishing in it', () => {
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
        for (const e of route.edges.concat(route.closed ? [] : [])) {
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
    expect(circuits).toBeGreaterThan(seeds.length * 0.8);
    expect(sprints).toBeGreaterThan(seeds.length * 0.8);
    // Stretches run from a short hop between two side ramps in one gap to several blocks through fords.
    expect(stretch / Math.max(1, stretches)).toBeGreaterThan(60);
  });

  it('the floor, banks and ramps are drivable terrain: a smooth run with a rounded lip and a kink at the foot, no wall across', () => {
    const { seeds } = riverSeeds(6, 6262);
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
        // Nothing solid across a channel or ramp edge (closures are rails, not city walls).
        for (const wall of cityWalls) expect(cross(a, b, { x: wall.ax, z: wall.az }, { x: wall.bx, z: wall.bz })).toBe(false);
        if (e.kind !== 'channel') continue;
        // The floor runs the channel's full depth below the base terrain and drives like a road.
        for (const t of [0.25, 0.5, 0.75]) {
          const x = a.x + (b.x - a.x) * t;
          const z = a.z + (b.z - a.z) * t;
          expect(base.heightAt(x, z) - w.heightAt(x, z)).toBeGreaterThan(p.depth - 0.05);
          expect(['road', 'concrete']).toContain(w.surfaceAt(x, z));
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

  it('plans the same river every time', () => {
    const rng = new Rng(7373);
    for (let i = 0; i < 4; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const a = planRoads(seed);
      const b = planRoads(seed);
      const strip = (plan: typeof a) => JSON.stringify({ edges: plan.graph.edges, nodes: plan.graph.nodes, routes: plan.routeNodes, areas: plan.districts.areas.map((x) => ({ kind: x.kind, params: x.params, edges: x.edges, nodes: x.nodes })) });
      expect(strip(a)).toBe(strip(b));
    }
  });
});
