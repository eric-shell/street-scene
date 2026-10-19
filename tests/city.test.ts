import { describe, expect, it } from 'vitest';
import { Rng, hashString, seedFromString } from '../src/sim/prng';
import { generateRoadGraph, graphIsConnected, edgeBetween } from '../src/city/roadGraph';
import { buildRoute, findCircuitNodes, findSprintNodes } from '../src/city/route';
import { createCity, createWorld } from '../src/city/world';
import { ROUTE } from '../src/city/config';

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
    expect(Math.abs(h)).toBeLessThan(6);
    // every side street off the route is closed with a barrier
    expect(w.walls.filter((x) => x.kind === 'barrier').length).toBe(w.route.closedStreets.length);
  });
});
