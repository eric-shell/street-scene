import { describe, expect, it } from 'vitest';
import { Rng, hashString, seedFromString } from '../src/sim/prng';
import { generateRoadGraph, graphIsConnected, edgeBetween } from '../src/city/roadGraph';
import { buildRoute, findCircuitNodes, findSprintNodes } from '../src/city/route';
import { createCity, createWorld } from '../src/city/world';
import { CITY, ROUTE } from '../src/city/config';
import { createTerrain } from '../src/city/terrain';
import { distToSegment, segmentT } from '../src/sim/math';

describe('prng', () => {
  it('is deterministic and roughly uniform', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const xs = Array.from({ length: 1000 }, () => a.next());
    const ys = Array.from({ length: 1000 }, () => b.next());
    expect(xs).toEqual(ys);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });

  it('hashes strings stably', () => {
    expect(hashString('night run')).toBe(hashString('night run'));
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(seedFromString('20261019')).toBe(20261019);
  });
});

describe('city generation', () => {
  it('produces identical cities and routes for the same seed', () => {
    const w1 = createWorld(20261019, 'circuit');
    const w2 = createWorld(20261019, 'circuit');
    expect(JSON.stringify(w1.graph)).toBe(JSON.stringify(w2.graph));
    expect(JSON.stringify(w1.blocks.buildings)).toBe(JSON.stringify(w2.blocks.buildings));
    expect(JSON.stringify(w1.walls)).toBe(JSON.stringify(w2.walls));
    expect(JSON.stringify(w1.route)).toBe(JSON.stringify(w2.route));
    const s1 = createWorld(20261019, 'sprint');
    const s2 = createWorld(20261019, 'sprint');
    expect(JSON.stringify(s1.route)).toBe(JSON.stringify(s2.route));
  });

  it('differs between seeds', () => {
    const a = createCity(1);
    const b = createCity(2);
    expect(JSON.stringify(a.graph.nodes)).not.toBe(JSON.stringify(b.graph.nodes));
  });

  it('generates sensible city content', () => {
    const c = createCity(42);
    expect(graphIsConnected(c.graph)).toBe(true);
    expect(c.graph.edges.some((e) => e.kind === 'boulevard')).toBe(true);
    expect(c.blocks.buildings.length).toBeGreaterThan(300);
    expect(c.blocks.walls.length).toBeGreaterThan(400);
    expect(c.blocks.streetlights.length).toBeGreaterThan(200);
    for (const n of c.graph.nodes) expect(n.edges.length).toBeGreaterThanOrEqual(2);
  });

  it('routes are connected, closed and edge-unique across 200 seeds', () => {
    const rng = new Rng(99);
    let meetsTargets = 0;
    for (let i = 0; i < 200; i++) {
      const seed = rng.int(0, 0x7fffffff);
      const g = generateRoadGraph(seed);
      expect(graphIsConnected(g)).toBe(true);

      const circuit = buildRoute(g, 'circuit', findCircuitNodes(g, seed));
      expect(circuit.closed).toBe(true);
      // consecutive nodes joined by an edge, including the wrap-around
      for (let k = 0; k < circuit.nodes.length; k++) {
        const a = circuit.nodes[k];
        const b = circuit.nodes[(k + 1) % circuit.nodes.length];
        expect(edgeBetween(g, a, b)).toBeGreaterThanOrEqual(0);
      }
      expect(new Set(circuit.edges).size).toBe(circuit.edges.length);
      expect(new Set(circuit.nodes).size).toBe(circuit.nodes.length);
      const first = circuit.points[0];
      const last = circuit.points[circuit.points.length - 1];
      expect(first.x).toBe(last.x);
      expect(first.z).toBe(last.z);
      expect(circuit.length).toBeGreaterThan(600);

      const sprint = buildRoute(g, 'sprint', findSprintNodes(g, seed));
      expect(sprint.closed).toBe(false);
      for (let k = 0; k + 1 < sprint.nodes.length; k++) {
        expect(edgeBetween(g, sprint.nodes[k], sprint.nodes[k + 1])).toBeGreaterThanOrEqual(0);
      }
      expect(new Set(sprint.edges).size).toBe(sprint.edges.length);
      expect(sprint.length).toBeGreaterThan(1000);
      // Long runout past the finish, and the finish line clear of intersections.
      expect(sprint.length - sprint.finishS).toBeGreaterThanOrEqual(ROUTE.sprintFinishOffset);
      expect(sprint.finishS - sprint.startS).toBeGreaterThan(1000);
      for (let k = 1; k + 1 < sprint.cum.length; k++) expect(Math.abs(sprint.finishS - sprint.cum[k])).toBeGreaterThanOrEqual(ROUTE.sprintFinishNodeClear - 1e-9);

      if (
        circuit.length >= ROUTE.circuitMinLength &&
        circuit.tightCorners >= ROUTE.minTightCorners &&
        sprint.length >= ROUTE.sprintMinLength
      )
        meetsTargets++;
    }
    // Almost every seed should hit the full design targets.
    expect(meetsTargets).toBeGreaterThan(190);
  });

  it('answers world queries', () => {
    const w = createWorld(7, 'circuit');
    const g0 = w.route.grid[0];
    expect(w.surfaceAt(g0.x, g0.z)).toBe('road');
    const contacts: never[] = [];
    expect(w.collideCircle(g0.x, g0.z, 1, contacts)).toBe(0);
    const p = w.routeProgress(g0.x, g0.z);
    expect(Math.abs(p.lateral)).toBeLessThan(4);
    expect(p.s).toBeGreaterThan(w.route.length - 40);
    const h = w.heightAt(0, 0);
    expect(Math.abs(h)).toBeLessThan(11);
    // every side street off the route is closed by exactly one barrier group
    const closedBy = w.route.closedStreets.map((cs) => w.barrierGroups.filter((g) => g.node === cs.node && g.edges.includes(cs.edge)).length);
    expect(closedBy.every((k) => k === 1)).toBe(true);
    expect(w.walls.filter((x) => x.kind === 'barrier').length).toBe(w.route.closedStreets.length);
  });

  it('corner rails and barriers never cross the route across 100 seeds', () => {
    const rng = new Rng(77);
    const cross = (a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }) => {
      const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
      if (Math.abs(den) < 1e-9) return false;
      const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
      const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
      return t > 0 && t < 1 && u > 0 && u < 1;
    };
    let rails = 0;
    for (let i = 0; i < 100; i++) {
      const w = createWorld(rng.int(0, 0x7fffffff), i % 2 ? 'sprint' : 'circuit');
      const P = w.route.points;
      for (const wall of w.walls) {
        if (wall.kind === 'wall') continue;
        if (wall.kind === 'rail') rails++;
        for (let k = 0; k + 1 < P.length; k++) {
          expect(cross(P[k], P[k + 1], { x: wall.ax, z: wall.az }, { x: wall.bx, z: wall.bz })).toBe(false);
        }
      }
    }
    expect(rails).toBeGreaterThan(500);
  });

  it('barrier groups never overlap and cover every barrier wall', () => {
    const rng = new Rng(31);
    const cross = (a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }) => {
      const den = (b.x - a.x) * (d.z - c.z) - (b.z - a.z) * (d.x - c.x);
      if (Math.abs(den) < 1e-9) return false;
      const t = ((c.x - a.x) * (d.z - c.z) - (c.z - a.z) * (d.x - c.x)) / den;
      const u = ((c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x)) / den;
      return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
    };
    let merged = 0;
    for (let i = 0; i < 40; i++) {
      const w = createWorld(rng.int(0, 0x7fffffff), i % 2 ? 'sprint' : 'circuit');
      const bars = w.walls.filter((x) => x.kind === 'barrier');
      const rails = w.walls.filter((x) => x.kind === 'rail');
      for (const b of bars) {
        expect(w.barrierGroups[b.group!].walls).toContain(b);
        for (const o of bars.concat(rails)) {
          if (o === b) continue;
          expect(cross({ x: b.ax, z: b.az }, { x: b.bx, z: b.bz }, { x: o.ax, z: o.az }, { x: o.bx, z: o.bz })).toBe(false);
          // Ends of different groups never nearly touch: those would have been merged.
          if (o.kind === 'barrier' && o.group !== b.group) {
            for (const [x, z] of [[b.ax, b.az], [b.bx, b.bz]]) {
              expect(Math.min(Math.hypot(x - o.ax, z - o.az), Math.hypot(x - o.bx, z - o.bz))).toBeGreaterThan(2.9);
            }
          }
        }
      }
      for (const g of w.barrierGroups) {
        expect(g.walls.length).toBe(g.edges.length);
        expect(Math.hypot(g.nx, g.nz)).toBeCloseTo(1, 6);
        expect(g.depth).toBeGreaterThanOrEqual(0);
        if (g.walls.length > 1) merged++;
      }
    }
    expect(merged).toBeGreaterThan(20);
  });

  it('corner rails run along the outer curb and leave the road drivable', () => {
    const rng = new Rng(12);
    for (let i = 0; i < 30; i++) {
      const w = createWorld(rng.int(0, 0x7fffffff), i % 2 ? 'sprint' : 'circuit');
      const rails = w.walls.filter((x) => x.kind === 'rail');
      rails.forEach((r, k) => {
        // One connected chain per rail.
        const next = rails[k + 1];
        if (next && next.group === r.group) expect(Math.hypot(next.ax - r.bx, next.az - r.bz)).toBeLessThan(1e-9);
        for (const [x, z] of [[r.ax, r.az], [r.bx, r.bz]]) {
          for (const eid of w.route.edges) {
            const e = w.graph.edges[eid];
            const a = w.graph.nodes[e.a];
            const b = w.graph.nodes[e.b];
            // Away from the corner itself, where the fillet may cut ROUTE.railCornerCut inside the curb corner.
            const t = segmentT(x, z, a.x, a.z, b.x, b.z);
            if (t * e.length < 15 || (1 - t) * e.length < 15) continue;
            // Never on the route's lanes (beside the edge, not past its ends).
            const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - e.width / 2;
            if (d < 3) expect(d).toBeGreaterThan(ROUTE.railInset - 0.05);
          }
        }
      });
    }
  });

  it('places street furniture on sidewalks without overlaps', () => {
    for (const seed of [42, 20261019, 777]) {
      const w = createWorld(seed, 'circuit');
      const props = w.blocks.props;
      expect(props).toBe(w.props);
      // Streetlights come first and match blocks.streetlights.
      w.blocks.streetlights.forEach((l, i) => {
        expect(props[i].kind).toBe('streetlight');
        expect(props[i].x).toBe(l.x);
        expect(props[i].light).toBe(i);
      });
      const count = (k: string) => props.filter((p) => p.kind === k).length;
      expect(count('trafficLight')).toBeGreaterThan(100);
      expect(count('garbageCan')).toBeGreaterThan(300);
      expect(count('bench')).toBeGreaterThan(80);
      expect(count('busStop')).toBeGreaterThan(15);
      expect(count('busStop')).toBeLessThan(count('bench'));
      props.forEach((p, i) => {
        expect(p.id).toBe(i);
        expect(w.surfaceAt(p.x, p.z)).toBe('sidewalk');
        if (p.kind === 'trafficLight') expect(w.graph.nodes[p.node!].edges.length).toBeGreaterThanOrEqual(3);
      });
      // Nothing but streetlights (kept as generated) overlaps anything else.
      const scratch: number[] = [];
      for (const p of props) {
        if (p.kind === 'streetlight') continue;
        w.propGrid.query(p.x - 3, p.z - 3, p.x + 3, p.z + 3, scratch);
        for (const id of scratch) {
          const q = props[id];
          if (q !== p) expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeGreaterThan(p.radius + q.radius);
        }
      }
      // Off the drivable road with room for the prop's radius.
      for (const p of props) {
        for (const e of w.graph.edges) {
          const a = w.graph.nodes[e.a];
          const b = w.graph.nodes[e.b];
          expect(distToSegment(p.x, p.z, a.x, a.z, b.x, b.z) - e.width / 2).toBeGreaterThan(p.radius);
        }
      }
      // Clear of route barriers.
      for (const b of w.walls.filter((x) => x.kind === 'barrier')) {
        for (const p of props) if (p.kind !== 'streetlight') expect(distToSegment(p.x, p.z, b.ax, b.az, b.bx, b.bz)).toBeGreaterThan(p.radius);
      }
      expect(JSON.stringify(createWorld(seed, 'circuit').props)).toBe(JSON.stringify(props));
    }
  });

  it('terrain rolls noticeably with gentle grades and an exact slope', () => {
    const t = createTerrain(20261019);
    let lo = Infinity;
    let hi = -Infinity;
    let maxGrade = 0;
    const span = (CITY.gridW - 1) * CITY.spacing * 0.5;
    for (let x = -span; x <= span; x += 20) {
      for (let z = -span; z <= span; z += 20) {
        const h = t.heightAt(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        const s = t.slopeAt(x, z);
        maxGrade = Math.max(maxGrade, Math.hypot(s.gx, s.gz));
        const e = 0.01;
        expect(s.gx).toBeCloseTo((t.heightAt(x + e, z) - t.heightAt(x - e, z)) / (2 * e), 5);
        expect(s.gz).toBeCloseTo((t.heightAt(x, z + e) - t.heightAt(x, z - e)) / (2 * e), 5);
      }
    }
    expect(hi - lo).toBeGreaterThan(8);
    expect(maxGrade).toBeLessThan(0.056);
  });
});
