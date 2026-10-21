/**
 * Roadworks: short lane closures on ordinary streets. The curb lane of one
 * side is shut for 30 to 60 m: a taper of cones at each end, a line of water
 * filled barriers (a striped sawhorse with its lamp every few) along the
 * closure, and behind them the plant: a flashing arrow board facing the
 * oncoming traffic, a mini excavator over a row of steel road plates, a skip,
 * a light tower lighting the lot, pallets and sandbags against the curb.
 *
 * Collision rule: the plant is solid (convex 'roadworks' solids, drawn from
 * this build's hints by render/districts/roadworks.ts); everything along and
 * across the closure is a destructible that a car smashes through. A closure
 * never takes more than the curb lane and a bit: the rest of the street stays
 * open, and the racing line (sim/ai.ts, laneClosures below) keeps
 * ROADWORKS.aiMargin clear of the barriers' reach, so the AI swings round it
 * while the player may dive through the cones and take the barriers with them.
 *
 * Planned once the routes are known (world.ts calls planRoadworks from the
 * topology hook): one closure on each route's own streets where it fits,
 * away from the start, the grid and the finish, plus a few elsewhere. Never
 * on a route's closed side street (the street meets stand there), never near
 * a junction (crosswalks, traffic lights, shortcut mouths and closures all sit
 * at the ends of a street), never on an alley, a bridge, the El's street or
 * the river; bus bays (busBays.ts) keep off closed streets. Own random
 * streams. Pure and deterministic.
 */
import type { RoadGraph, RoadKind } from '../roadGraph';
import { buildRoute, Route } from '../route';
import { computeMouths } from '../blocks';
import type { CarveRoute } from './alley';
import { PROP_DEFS } from '../props';
import type { PropKind } from '../props';
import { Rng, deriveSeed } from '../../sim/prng';
import { Vec2, atan2, segmentT, sqrt } from '../../sim/math';
import type { Area, AreaBuild, BuildContext, DistrictModule, PlanContext } from './types';
import { emptyBuild } from './types';
import { rectPolygon, solidWalls } from './geom';

export const ROADWORKS = {
  enabled: true,
  /** Closures on each route's own streets, then this many [min, max] more anywhere. */
  perRoute: 1,
  extra: [2, 3],
  /** Shortest street (m) that gets one, and the room a closure (tapers included) keeps from either junction's curb corners (m). */
  minEdge: 110,
  mouthClear: 20,
  /** Stretch at full closure (m) and each cone taper (m): 30 to 60 m in all. */
  work: [18, 40],
  taper: [6, 10],
  /** Closure reach from the curb (m) by street kind: the parking lane and a little of the next. */
  close: { street: [3.6, 4.2], avenue: [4, 4.6], diagonal: [4, 4.6], boulevard: [4.6, 5.4] } as Partial<Record<RoadKind, readonly [number, number]>>,
  /** The barriers stand with their road side face at the closure line; their collision circles reach this much further out (m). */
  barrierReach: 0.6,
  /** Route closures keep this far (m along the route) from the start and the finish lines (grid, gantries, crowds). */
  lineClear: 150,
  /** Closure centers keep this far apart (m). */
  spacing: 240,
  /** Attempts per closure. */
  tries: 40,
  /** The racing line's car center keeps this far (m) from the barriers' reach, from this far (m) before the taper to as far past. */
  aiMargin: 2.3,
  aiLead: 10,
  /** Plant keeps this far (m) from the curb and from the backs of the barriers. */
  plantClear: 0.35,
  /** Taper cones every ~this far (m); barriers this far apart (m, their radii plus the district prop gap); a sawhorse every this many. */
  coneStep: 2.2,
  barrierPitch: 2.1,
  sawhorseEvery: 4,
} as const;

/** Footprints of the plant (m): along the lane, across it; the excavator's arm reaches `arm` further along. */
const PLANT = {
  arrowBoard: { along: 2.4, across: 1.6 },
  skip: { along: 3.4, across: 1.7 },
  excavator: { along: 3.3, across: 2, arm: 2.8 },
  lightTower: { along: 2.2, across: 1.3 },
} as const;

/** What the racing line must keep clear of: one closure in its street's frame. */
export interface LaneClosure {
  /** The street's centerline start (node a) and unit direction a -> b. */
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** Unit normal from the centerline toward the closed curb. */
  nx: number;
  nz: number;
  /** Along the street (m from node a): the stretch the line keeps clear on, tapers and lead ins included. */
  s0: number;
  s1: number;
  /** Largest offset (m, from the centerline toward the closed curb) a car's center may take there. */
  keep: number;
  /** Half the street's width (m). */
  half: number;
}

/** The closures of every roadworks area, in area order (sim/ai.ts builds its racing line with them). */
export function laneClosures(areas: readonly Area[], g: RoadGraph): LaneClosure[] {
  const out: LaneClosure[] = [];
  for (const a of areas) {
    if (a.kind !== 'roadworks') continue;
    const P = a.params;
    const e = g.edges[P.edge];
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const half = e.width / 2;
    out.push({
      ax: A.x,
      az: A.z,
      dx,
      dz,
      nx: -dz * P.side,
      nz: dx * P.side,
      s0: P.sA - P.taper - ROADWORKS.aiLead,
      s1: P.sB + P.taper + ROADWORKS.aiLead,
      keep: half - P.close - ROADWORKS.barrierReach - ROADWORKS.aiMargin,
      half,
    });
  }
  return out;
}

/** Street frame of a closure: point at `s` along the edge from node a, `v` in from the closed curb. */
function frame(g: RoadGraph, edge: number, side: number) {
  const e = g.edges[edge];
  const A = g.nodes[e.a];
  const B = g.nodes[e.b];
  const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
  const d = { x: (B.x - A.x) / len, z: (B.z - A.z) / len };
  // Toward the closed curb from the centerline: the P side normal (-dz, dx) for side 1.
  const n = { x: -d.z * side, z: d.x * side };
  const half = e.width / 2;
  return {
    len,
    d,
    n,
    at: (s: number, v: number): Vec2 => ({ x: A.x + d.x * s + n.x * (half - v), z: A.z + d.z * s + n.z * (half - v) }),
  };
}

/** Route s of a point on its polyline (closest point). */
function routeS(route: Route, p: Vec2): number {
  let best = Infinity;
  let s = 0;
  for (let i = 0; i + 1 < route.points.length; i++) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const t = segmentT(p.x, p.z, a.x, a.z, b.x, b.z);
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d2 < best) {
      best = d2;
      s = route.cum[i] + (route.cum[i + 1] - route.cum[i]) * t;
    }
  }
  return s;
}

/**
 * Plan the closures (graph phase, from world.ts's topology hook, once both
 * routes are picked and carved) and register one 'roadworks' area each.
 */
export function planRoadworks(ctx: PlanContext, routes: CarveRoute[]): void {
  const C = ROADWORKS;
  if (!C.enabled) return;
  const g = ctx.graph;
  const rng = new Rng(deriveSeed(ctx.seed, 'roadworks'));
  const mouths = computeMouths(g, ctx.sectors());
  const built = routes.map((r) => {
    const route = buildRoute(g, r.closed ? 'circuit' : 'sprint', r.nodes);
    return { route, nodes: new Set(r.nodes), edges: new Set(route.edges) };
  });
  const onRoute = (i: number, e: number) => built[i].edges.has(e);
  // Plain streets nobody claimed, long enough, never a closed side street of either route.
  const candidates: number[] = [];
  for (const e of g.edges) {
    if (!C.close[e.kind] || e.shortcut || e.bridge || e.length < C.minEdge || ctx.claims.edge.has(e.id)) continue;
    if (built.some((b, i) => !onRoute(i, e.id) && (b.nodes.has(e.a) || b.nodes.has(e.b)))) continue;
    candidates.push(e.id);
  }
  const placed: { x: number; z: number; edge: number }[] = [];

  /** Try to fit one closure on edge `ei`; registers its area and returns true when it does. */
  const tryEdge = (ei: number): boolean => {
    const e = g.edges[ei];
    if (placed.some((p) => p.edge === ei)) return false;
    const side = rng.chance(0.5) ? 1 : -1;
    const range = C.close[e.kind]!;
    const close = rng.range(range[0], range[1]);
    const taper = rng.range(C.taper[0], C.taper[1]);
    let work = rng.range(C.work[0], C.work[1]);
    const f = frame(g, ei, side);
    // Room between the two junctions' curb corners (the mouth points, measured along the street).
    const m = mouths[ei];
    const along = (p: Vec2) => (p.x - g.nodes[e.a].x) * f.d.x + (p.z - g.nodes[e.a].z) * f.d.z;
    const lo = Math.max(along(m.aP.curb), along(m.aN.curb)) + C.mouthClear;
    const hi = Math.min(along(m.bP.curb), along(m.bN.curb)) - C.mouthClear;
    const room = hi - lo - 2 * taper;
    if (room < C.work[0]) return false;
    work = Math.min(work, room);
    const sA = lo + taper + rng.range(0, room - work);
    const sB = sA + work;
    const mid = f.at((sA + sB) / 2, close / 2);
    if (placed.some((p) => (p.x - mid.x) ** 2 + (p.z - mid.z) ** 2 < C.spacing * C.spacing)) return false;
    // Clear of every route's start, grid and finish.
    for (let i = 0; i < built.length; i++) {
      if (!onRoute(i, ei)) continue;
      const r = built[i].route;
      const s = routeS(r, mid);
      if (r.closed ? Math.min(s, r.length - s) < C.lineClear : s < r.startS + C.lineClear || s > r.finishS - C.lineClear) return false;
    }
    const pad = 1.5;
    const polygon = [f.at(sA - taper - pad, -0.3), f.at(sB + taper + pad, -0.3), f.at(sB + taper + pad, 1), f.at(sB, close + 0.2), f.at(sA, close + 0.2), f.at(sA - taper - pad, 1)];
    // Right hand traffic: the N side (side -1) carries a -> b, so its oncoming end is at sA.
    const up = side === -1 ? 1 : -1;
    ctx.addArea(
      { kind: 'roadworks', variant: 'lane', polygon, path: [f.at(sA - taper, 0), f.at(sB + taper, 0)], nodes: [], edges: [], faces: [], params: { edge: ei, side, sA, sB, taper, close, up } },
      0,
    );
    placed.push({ x: mid.x, z: mid.z, edge: ei });
    return true;
  };

  const pickFrom = (list: number[]): boolean => {
    for (let t = 0; t < C.tries && list.length; t++) if (tryEdge(list[rng.int(0, list.length - 1)])) return true;
    return false;
  };
  for (let i = 0; i < built.length; i++) {
    const mine = candidates.filter((e) => onRoute(i, e));
    for (let k = 0; k < C.perRoute; k++) pickFrom(mine);
  }
  const extra = rng.int(C.extra[0], C.extra[1]);
  for (let k = 0; k < extra; k++) pickFrom(candidates);
}

/** Lay out one closure: cones, barriers and soft pieces as destructibles, the plant as solids, hints for the renderer. */
function buildRoadworks(ctx: BuildContext, area: Area): AreaBuild {
  const b = emptyBuild();
  const C = ROADWORKS;
  const P = area.params;
  const rng = new Rng(deriveSeed(ctx.seed, `roadworks:${area.id}`));
  const f = frame(ctx.graph, P.edge, P.side);
  const { sA, sB, taper: T, close, up } = P;
  const W = sB - sA;
  /** Along the edge for `t` metres into the work stretch from its oncoming end (negative: in the taper before it). */
  const S = (t: number) => (up === 1 ? sA + t : sB - t);
  // Downstream along the lane, and in toward the open road (v grows away from the curb).
  const fwd = { x: f.d.x * up, z: f.d.z * up };
  const toRoad = { x: -f.n.x, z: -f.n.z };
  // Barriers and sawhorses lie along their local X: the lane.
  const alongYaw = atan2(-fwd.z, fwd.x);
  const prop = (kind: PropKind, t: number, v: number, yaw: number) => {
    const p = f.at(S(t), v);
    b.destructibles.push({ kind, x: p.x, z: p.z, yaw, lift: 0, area: area.id });
  };

  // Tapers: cones on a diagonal from near the curb out to the closure line, at both ends.
  const nc = Math.max(3, Math.round(T / C.coneStep));
  for (let k = 0; k <= nc; k++) {
    const v = 0.5 + (close - 0.75) * (k / nc);
    prop('trafficCone', -T + (T * k) / nc, v, rng.range(0, 6.28));
    prop('trafficCone', W + T - (T * k) / nc, v, rng.range(0, 6.28));
  }
  // The closure line: water filled barriers end to end (lying along the lane), a sawhorse with its lamp every few.
  let slot = 0;
  for (let t = 1.4; t <= W - 1.4 + 1e-6; t += C.barrierPitch, slot++) {
    if (slot % C.sawhorseEvery === C.sawhorseEvery - 1) prop('sawhorse', t, close - 0.35, alongYaw + rng.range(-0.05, 0.05));
    else prop('waterBarrier', t, close - 0.3, alongYaw + rng.range(-0.03, 0.03));
  }

  // The plant, from the oncoming end: the arrow board first, the rest in a random order while it fits.
  const v0 = C.plantClear;
  const vMax = close - 0.6 - C.plantClear;
  const solid = (kind: keyof typeof PLANT, t0: number, along: number, across: number, extra: number) => {
    const o = f.at(S(t0), v0);
    const poly = rectPolygon(o, fwd, toRoad, along, Math.min(across, vMax - v0));
    for (const w of solidWalls(poly, 'roadworks', area.id)) b.walls.push(w);
    const c = f.at(S(t0 + along / 2), v0 + Math.min(across, vMax - v0) / 2);
    b.hints.push({ kind, points: [c, fwd, toRoad], values: [along, Math.min(across, vMax - v0), extra] });
  };
  let t = 0.6;
  solid('arrowBoard', t, PLANT.arrowBoard.along, PLANT.arrowBoard.across, 0);
  t += PLANT.arrowBoard.along + rng.range(1, 1.8);
  const order: (keyof typeof PLANT)[] = ['skip', 'excavator', 'lightTower'];
  rng.shuffle(order);
  /** Free stretches left along the curb (t ranges), for the soft pieces. */
  const free: [number, number][] = [];
  for (const kind of order) {
    const p = PLANT[kind];
    const arm = kind === 'excavator' ? PLANT.excavator.arm : 0;
    const len = p.along + arm;
    if (t + len > W - 0.6) continue;
    // The excavator digs on its downstream side: arm and plates there, body first.
    solid(kind, t, p.along, p.across, kind === 'excavator' ? rng.range(-0.25, 0.25) : 0);
    if (kind === 'excavator') {
      const plates = 2;
      for (let k = 0; k < plates; k++) {
        const c = f.at(S(t + p.along + 0.2 + (arm / plates) * (k + 0.5)), v0 + 0.85);
        b.hints.push({ kind: 'plate', points: [c, fwd, toRoad], values: [arm / plates - 0.05, 1.6, rng.range(-0.04, 0.04)] });
      }
    }
    const gap = rng.range(1, 2);
    free.push([t + len, t + len + gap]);
    t += len + gap;
  }
  free.push([t, W - 0.6]);
  // Soft pieces in what is left: pallets, sandbags and barrels against the curb.
  const soft: PropKind[] = ['pallets', 'sandbags', 'barrel'];
  for (const [a, z] of free) {
    let s = a + 0.2;
    while (true) {
      const kind = soft[rng.int(0, soft.length - 1)];
      const r = PROP_DEFS[kind].radius;
      if (s + 2 * r > z) break;
      prop(kind, s + r, v0 + r + 0.05, rng.range(0, 6.28));
      s += 2 * r + rng.range(0.4, 1.2);
    }
  }
  // The closure for the renderer (light pools, paint) and for the bus bay planner (busBays.ts keeps off this street).
  b.hints.push({ kind: 'roadworks', points: [f.at(sA, 0), f.at(sB, 0)], values: [P.edge, P.side, sA, sB, T, close, up] });
  return b;
}

/** Areas come from planRoadworks (the routes must be known), so the module's own plan does nothing. */
export const roadworksModule: DistrictModule = {
  kind: 'roadworks',
  phase: 'graph',
  plan() {},
  build: buildRoadworks,
};
