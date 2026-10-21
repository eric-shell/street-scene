import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { planRoads } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import { createTerrain } from '../src/city/terrain';
import { isRiverEdge } from '../src/city/roadGraph';
import { EVENT_FLAVOURS, EVENTS, type EventFlavourId, eventOffer, eventRating, hillClimbAlong, pickEventFlavour, routeEdges } from '../src/city/events';

const FLAVOURS = Object.keys(EVENT_FLAVOURS) as EventFlavourId[];
type Plan = ReturnType<typeof planRoads>;
const routesOf = (p: Plan) => [
  { nodes: p.routeNodes.circuit, closed: true },
  { nodes: p.routeNodes.sprint, closed: false },
];
const seedsFrom = (stream: number, n: number) => {
  const rng = new Rng(stream);
  return Array.from({ length: n }, () => rng.int(0, 0x7fffffff));
};
/** Route metres on edges `on` likes, both routes. */
const metres = (p: Plan, on: (e: number) => boolean) =>
  routesOf(p).map((r) => routeEdges(p.graph, r.nodes, r.closed).reduce((m, e) => m + (on(e) ? p.graph.edges[e].length : 0), 0));
/** Sum of every rise along a route on the real terrain (base roll plus every district's height), sampled every 5 m. */
function climb(p: Plan, seed: number): number[] {
  const terrain = createTerrain(seed, p.districts.heightMods);
  return routesOf(p).map((r) => {
    let up = 0;
    const m = r.closed ? r.nodes.length : r.nodes.length - 1;
    for (let i = 0; i < m; i++) {
      const a = p.graph.nodes[r.nodes[i]];
      const b = p.graph.nodes[r.nodes[(i + 1) % r.nodes.length]];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5));
      let prev = terrain.heightAt(a.x, a.z);
      for (let k = 1; k <= steps; k++) {
        const h = terrain.heightAt(a.x + ((b.x - a.x) * k) / steps, a.z + ((b.z - a.z) * k) / steps);
        if (h > prev) up += h - prev;
        prev = h;
      }
    }
    return up;
  });
}
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);

describe('event flavours', () => {
  it('draws the same deliverable flavour every time, only from what the city offers', () => {
    const rng = new Rng(61);
    for (let i = 0; i < 300; i++) {
      const offer = FLAVOURS.filter((id) => id === 'downtownDash' || rng.chance(0.6));
      const seed = rng.int(0, 0x7fffffff);
      const id = pickEventFlavour(seed, offer);
      expect(offer).toContain(id);
      expect(pickEventFlavour(seed, offer)).toBe(id);
    }
    // A flavour the city cannot deliver is never offered.
    for (const seed of seedsFrom(62, 30)) {
      const p = planRoads(seed);
      const g = p.graph;
      const offer = eventOffer(g, p.districts.areas);
      expect(offer).toContain(p.event.drawn);
      if (offer.includes('riverRun')) expect(g.edges.some((e) => e.kind === 'channel')).toBe(true);
      if (offer.includes('alleySprint')) expect(g.edges.some((e) => e.kind === 'alley')).toBe(true);
      if (offer.includes('underTheEl')) expect(p.districts.areas.some((a) => a.kind === 'subway')).toBe(true);
      if (offer.includes('ringRush')) expect(g.nodes.filter((n) => n.ring).length).toBeGreaterThanOrEqual(2);
      if (!g.edges.some((e) => e.kind === 'channel')) expect(offer).not.toContain('riverRun');
      if (!p.districts.areas.some((a) => a.kind === 'subway')) expect(offer).not.toContain('underTheEl');
    }
  });

  it('names a varied event on every seed, and the routes really deliver it, across 200 seeds', () => {
    const counts: Record<string, number> = {};
    let fallbacks = 0;
    for (const seed of seedsFrom(2026, 200)) {
      const p = planRoads(seed);
      const ev = p.event;
      counts[ev.id] = (counts[ev.id] ?? 0) + 1;
      expect(ev.name).toBe(EVENT_FLAVOURS[ev.id].name);
      expect(ev.tagline).toBe(EVENT_FLAVOURS[ev.id].tagline);
      // The drawn flavour, or Downtown Dash when its routes could not deliver it.
      if (ev.id !== ev.drawn) {
        expect(ev.id).toBe('downtownDash');
        fallbacks++;
      }
      for (const r of routesOf(p)) expect(eventRating(ev.id, p.graph, p.districts.areas, r), `${seed} ${ev.id}`).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(counts).length).toBe(FLAVOURS.length);
    for (const id of FLAVOURS) expect(counts[id] ?? 0, id).toBeLessThanOrEqual(80);
    expect(fallbacks).toBeLessThanOrEqual(12);
  });

  it('plans the same city, routes and event for every flavour, and keeps grids and finishes on streets', () => {
    for (const [i, seed] of seedsFrom(63, 7).entries()) {
      const id = FLAVOURS[i];
      const a = planRoads(seed, id);
      const b = planRoads(seed, id);
      const strip = (p: Plan) => JSON.stringify({ edges: p.graph.edges, nodes: p.graph.nodes, routes: p.routeNodes, event: p.event, areas: p.districts.areas });
      expect(strip(a)).toBe(strip(b));
      for (const kind of ['circuit', 'sprint'] as const) {
        const route = buildRoute(a.graph, kind, a.routeNodes[kind]);
        expect(route.shortcuts.length, `${id} ${kind} ${seed}`).toBeGreaterThanOrEqual(1);
        expect(isRiverEdge(a.graph.edges[route.edges[0]])).toBe(false);
        if (kind === 'sprint') expect(isRiverEdge(a.graph.edges[route.edges[route.edges.length - 1]])).toBe(false);
      }
    }
  });

  /**
   * The same seeds with the flavour and with another one whose wish has
   * nothing to do with it (Downtown Dash, or Hill Climb for Downtown Dash):
   * each flavour's routes have measurably more of what it is named for.
   */
  it('routes match their flavour: River Run dives longer, Alley Sprint uses the alleys, Hill Climb climbs...', () => {
    const seeds = seedsFrom(64, 12);
    const compare = (id: EventFlavourId, measure: (p: Plan, seed: number) => number[], offered: (p: Plan) => boolean = () => true) => {
      const base: EventFlavourId = id === 'downtownDash' ? 'hillClimb' : 'downtownDash';
      const own: number[] = [];
      const other: number[] = [];
      for (const seed of seeds) {
        const b = planRoads(seed, base);
        if (!offered(b)) continue;
        own.push(...measure(planRoads(seed, id), seed));
        other.push(...measure(b, seed));
      }
      expect(own.length, id).toBeGreaterThanOrEqual(12);
      return { own, other };
    };
    const kind = (p: Plan, k: string) => (e: number) => p.graph.edges[e].kind === k;

    const river = compare('riverRun', (p) => metres(p, kind(p, 'channel')), (p) => p.graph.edges.some((e) => e.kind === 'channel'));
    expect(Math.min(...river.own)).toBeGreaterThan(0);
    expect(mean(river.own)).toBeGreaterThan(mean(river.other) * 1.2);

    const alley = compare('alleySprint', (p) => metres(p, kind(p, 'alley')));
    expect(Math.min(...alley.own)).toBeGreaterThan(0);
    expect(mean(alley.own)).toBeGreaterThan(mean(alley.other) * 2);

    const el = compare(
      'underTheEl',
      (p) => {
        const deck = new Set(p.districts.areas.filter((a) => a.kind === 'subway').flatMap((a) => a.edges));
        return metres(p, (e) => deck.has(e));
      },
      (p) => p.districts.areas.some((a) => a.kind === 'subway'),
    );
    expect(Math.min(...el.own)).toBeGreaterThanOrEqual(EVENTS.underTheEl.some);
    expect(mean(el.own)).toBeGreaterThan(mean(el.other) * 2);

    const rings = compare('ringRush', (p) => routesOf(p).map((r) => r.nodes.filter((n) => p.graph.nodes[n].ring).length));
    expect(mean(rings.own)).toBeGreaterThan(1.5);
    expect(mean(rings.own)).toBeGreaterThan(mean(rings.other) + 1);

    // The monument comes to a Grand Tour: both routes pass the landmark close by.
    const pass = (p: Plan) => {
      const m = p.districts.areas.find((a) => a.kind === 'monument');
      return routesOf(p).map((r) => {
        if (!m) return Infinity;
        let best = Infinity;
        for (const n of r.nodes) best = Math.min(best, Math.hypot(p.graph.nodes[n].x - m.params.cx, p.graph.nodes[n].z - m.params.cz));
        return best;
      });
    };
    const tour = compare('grandTour', pass);
    const near = (xs: number[]) => xs.filter((d) => d <= EVENTS.grandTour.pass).length / xs.length;
    expect(near(tour.own)).toBeGreaterThan(0.8);
    expect(near(tour.own)).toBeGreaterThan(near(tour.other) + 0.3);

    const fast = compare('downtownDash', (p) => {
      const all = metres(p, () => true);
      return metres(p, (e) => ['boulevard', 'avenue', 'diagonal'].includes(p.graph.edges[e].kind)).map((m, i) => m / all[i]);
    });
    expect(mean(fast.own)).toBeGreaterThan(mean(fast.other) + 0.08);

    // Hills are planned after the routes, so they come to a Hill Climb's: the rise from the hills
    // alone, and on the real terrain (its base roll, river ramps, park mounds and humps included).
    const hills = compare('hillClimb', (p) => routesOf(p).map((r) => hillClimbAlong(p.graph, p.districts.areas, r.nodes, r.closed)));
    expect(mean(hills.own)).toBeGreaterThan(mean(hills.other) * 1.5);
    expect(mean(hills.own)).toBeGreaterThan(15);
    const ground = compare('hillClimb', climb);
    expect(mean(ground.own)).toBeGreaterThan(mean(ground.other) + 5);
  });
});
