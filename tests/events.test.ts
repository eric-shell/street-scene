import { describe, expect, it } from 'vitest';
import { Rng } from '../src/sim/prng';
import { createCity, createWorld, planRoads } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import { createTerrain } from '../src/city/terrain';
import { isChannelEdge } from '../src/city/roadGraph';
import { harborShore } from '../src/city/districts/harborShore';
import { quayCutProgress } from '../src/city/districts/harborCut';
import { waterfrontRolled } from '../src/city/districts/waterfront';
import { carSnapshot, raceConfig, replayLog, runAutopilot } from './helpers';
import { EVENT_FLAVOURS, EVENTS, type EventFlavourId, eventOffer, eventRating, eventTitle, hillClimbAlong, pickEventFlavour, routeEdges } from '../src/city/events';

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
      // A Harbor Run is drawn for the quay's preview, which a finished plan may not have kept (the area budget).
      if (p.event.drawn !== 'harborRun') expect(offer).toContain(p.event.drawn);
      if (offer.includes('channelRun')) expect(g.edges.some((e) => e.kind === 'channel')).toBe(true);
      if (offer.includes('alleySprint')) expect(g.edges.some((e) => e.kind === 'alley')).toBe(true);
      if (offer.includes('underTheEl')) expect(p.districts.areas.some((a) => a.kind === 'subway')).toBe(true);
      if (offer.includes('ringRush')) expect(g.nodes.filter((n) => n.ring).length).toBeGreaterThanOrEqual(2);
      if (!g.edges.some((e) => e.kind === 'channel')) expect(offer).not.toContain('channelRun');
      if (!p.districts.areas.some((a) => a.kind === 'subway')) expect(offer).not.toContain('underTheEl');
      if (!p.districts.areas.some((a) => a.kind === 'waterfront')) expect(offer).not.toContain('harborRun');
    }
  });

  // 200 worlds with solid trees and kerb parking take about 65 s alone and over 120 s under the suite's parallel load.
  it('names a varied event on every seed, and the routes really deliver it, across 200 seeds', { timeout: 300000 }, () => {
    const counts: Record<string, number> = {};
    const titles = new Set<string>();
    let fallbacks = 0;
    let harbors = 0;
    let harborRuns = 0;
    for (const seed of seedsFrom(2026, 200)) {
      const p = planRoads(seed);
      const ev = p.event;
      // Harbor Run: only where a quay was planned, and the routes really run along it.
      const quay = p.districts.areas.find((a) => a.kind === 'waterfront');
      if (quay) harbors++;
      if (ev.id === 'harborRun') {
        harborRuns++;
        expect(quay, `${seed} harbor run without a quay`).toBeDefined();
        const shore = harborShore(p.graph, quay!);
        for (const r of routesOf(p)) expect(routeEdges(p.graph, r.nodes, r.closed).filter((e) => shore.shore.has(e)).length, `${seed} off the coast`).toBeGreaterThanOrEqual(2);
      }
      counts[ev.id] = (counts[ev.id] ?? 0) + 1;
      // The title ends in one of the flavour's nouns, so it still says what the race is.
      expect(EVENT_FLAVOURS[ev.id].nouns.some((n) => ev.name.endsWith(` ${n}`)), ev.name).toBe(true);
      expect(EVENT_FLAVOURS[ev.id].taglines).toContain(ev.tagline);
      expect(ev.name.length, ev.name).toBeLessThanOrEqual(30);
      expect(eventTitle(seed, ev.id)).toEqual({ name: ev.name, tagline: ev.tagline });
      titles.add(ev.name);
      // The drawn flavour, or Downtown Dash when its routes could not deliver it.
      if (ev.id !== ev.drawn) {
        expect(ev.id).toBe('downtownDash');
        fallbacks++;
      }
      for (const r of routesOf(p)) expect(eventRating(ev.id, p.graph, p.districts.areas, r), `${seed} ${ev.id}`).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(counts).length).toBe(FLAVOURS.length);
    // About half of the harbors run along their quay: the flavour is weighted for it (EVENT_FLAVOURS.harborRun).
    expect(harborRuns / harbors, `${harborRuns} of ${harbors} harbors`).toBeGreaterThanOrEqual(0.4);
    expect(harborRuns / harbors).toBeLessThanOrEqual(0.7);
    for (const id of FLAVOURS) expect(counts[id] ?? 0, id).toBeLessThanOrEqual(80);
    // (Lakes take blocks a Hill Climb's hills or a Grand Tour's sights would use: 10 of these 200 fall back without them, 13 with.)
    expect(fallbacks).toBeLessThanOrEqual(14);
    // Seeds rarely share a title.
    expect(titles.size).toBeGreaterThanOrEqual(190);
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
        expect(isChannelEdge(a.graph.edges[route.edges[0]])).toBe(false);
        if (kind === 'sprint') expect(isChannelEdge(a.graph.edges[route.edges[route.edges.length - 1]])).toBe(false);
      }
    }
  });

  /**
   * Harbor Run: harbor seeds only, the routes hug the streets along the quay far more than a Downtown Dash's on
   * the same seeds, and where a route goes round a recess of the quay (a warehouse where the outer street is
   * missing) the lane across is a shortcut of that route, credited in full: an AI race over it finishes and
   * replays bit for bit. 646790203 (a harbor with a recess either route goes round).
   */
  it('Harbor Run runs along the quay, and the lane across a recess is a credited shortcut', { timeout: 120000 }, () => {
    const harbors = seedsFrom(65, 60).filter((s) => waterfrontRolled(s)).slice(0, 8);
    const shoreMetres = (p: Plan) => {
      const quay = p.districts.areas.find((a) => a.kind === 'waterfront');
      const shore = quay ? harborShore(p.graph, quay) : null;
      return metres(p, (e) => !!shore?.shore.has(e));
    };
    const own: number[] = [];
    const other: number[] = [];
    for (const seed of harbors) {
      const a = planRoads(seed, 'harborRun');
      // The same city with another flavour, hills and all: the flavour is the only difference in the routes.
      own.push(...shoreMetres(a));
      other.push(...shoreMetres(planRoads(seed, 'downtownDash')));
    }
    expect(own.length).toBeGreaterThanOrEqual(12);
    expect(mean(own)).toBeGreaterThan(mean(other) * 1.8);
    expect(mean(own)).toBeGreaterThan(EVENTS.harborRun.some * 2);

    const seed = 646790203;
    const city = createCity(seed);
    expect(city.event.id).toBe('harborRun');
    for (const kind of ['circuit', 'sprint'] as const) {
      const world = createWorld(seed, kind, city);
      const cuts = world.route.quayCuts;
      // No corner rail stands across the middle of any mouth onto the quay, though Harbor Run's routes turn at them all the time.
      const quay = city.districts.areas.find((a) => a.kind === 'waterfront')!;
      for (const h of city.districts.builds[quay.id].hints.filter((x) => x.kind === 'quayMouth')) {
        const [pa, pb] = h.points;
        const span = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        for (let k = span * 0.25; k < span * 0.75; k += 1) {
          for (const dv of [-6, -3, 0, 3]) {
            const contacts: { kind: string }[] = [];
            world.collideCircle(pa.x + ((pb.x - pa.x) * k) / span + quay.params.vx * dv, pa.z + ((pb.z - pa.z) * k) / span + quay.params.vz * dv, 0.9, contacts as never[]);
            expect(contacts.some((c) => c.kind === 'rail'), `${kind} rail in a mouth`).toBe(false);
          }
        }
      }
      expect(cuts.length, kind).toBeGreaterThanOrEqual(1);
      for (const sc of cuts) {
        // Along the lane, progress runs smoothly from the cut's entry to its exit, a block or more of street skipped.
        let prev = sc.sIn;
        for (let i = 1; i < sc.points.length - 1; i++) {
          const q = quayCutProgress(world.route, sc.points[i].x, sc.points[i].z);
          expect(q, `${kind} lane point ${i}`).not.toBeNull();
          expect(q!.s).toBeGreaterThanOrEqual(prev - 1e-6);
          prev = q!.s;
        }
        expect(prev).toBeGreaterThan(sc.sOut - 12);
        expect(sc.sOut - sc.sIn).toBeGreaterThan(sc.length * 1.25);
        // The way into the lane is open: no corner rail stands across either mouth's first leg.
        for (const [a, b] of [[sc.points[0], sc.points[1]], [sc.points[sc.points.length - 1], sc.points[sc.points.length - 2]]]) {
          for (const w of world.walls) {
            if (w.kind !== 'rail') continue;
            const den = (b.x - a.x) * (w.bz - w.az) - (b.z - a.z) * (w.bx - w.ax);
            if (Math.abs(den) < 1e-9) continue;
            const t = ((w.ax - a.x) * (w.bz - w.az) - (w.az - a.z) * (w.bx - w.ax)) / den;
            const u = ((w.ax - a.x) * (b.z - a.z) - (w.az - a.z) * (b.x - a.x)) / den;
            expect(t > 0 && t < 1 && u > 0 && u < 1, `${kind} rail across a mouth`).toBe(false);
          }
        }
      }
    }
    const cfg = raceConfig(seed, 'circuit', 3);
    const r = runAutopilot(cfg, 400, true);
    for (const c of r.cars) expect(c.finished, c.name).toBe(true);
    expect(r.events.filter((e) => e.type === 'reset').length).toBeLessThanOrEqual(3);
    expect(carSnapshot(replayLog(cfg, r.inputLog))).toBe(carSnapshot(r));
  });

  /**
   * The same seeds with the flavour and with another one whose wish has
   * nothing to do with it (Downtown Dash, or Hill Climb for Downtown Dash):
   * each flavour's routes have measurably more of what it is named for.
   */
  it('routes match their flavour: Channel Run dives longer, Alley Sprint uses the alleys, Hill Climb climbs...', () => {
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

    const channel = compare('channelRun', (p) => metres(p, kind(p, 'channel')), (p) => p.graph.edges.some((e) => e.kind === 'channel'));
    expect(Math.min(...channel.own)).toBeGreaterThan(0);
    expect(mean(channel.own)).toBeGreaterThan(mean(channel.other) * 1.2);

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
    // alone, and on the real terrain (its base roll, channel ramps, park mounds and humps included).
    const hills = compare('hillClimb', (p) => routesOf(p).map((r) => hillClimbAlong(p.graph, p.districts.areas, r.nodes, r.closed)));
    expect(mean(hills.own)).toBeGreaterThan(mean(hills.other) * 1.5);
    expect(mean(hills.own)).toBeGreaterThan(14);
    const ground = compare('hillClimb', climb);
    expect(mean(ground.own)).toBeGreaterThan(mean(ground.other) + 5);
  });
});
