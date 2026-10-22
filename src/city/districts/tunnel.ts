/**
 * Tunnels: a street runs for part of one block through a lit bore, either
 * under an "air rights" building that straddles it (variant 'building') or
 * under a rocky ridge raised across it (variant 'ridge').
 *
 * The sim is 2.5D (one height per point), so a tunnel is a street with walls
 * and something overhead that only the renderer and the camera know about:
 *  - Inside the bore a raised walkway (CFG.walkway) runs from each curb to the
 *    tunnel wall, a one sided wall with look 'tunnel' facing the road. At each
 *    portal a wingwall flares from the walkway back out to the building line
 *    over CFG.wing m, so a car running up the sidewalk is turned into the
 *    bore instead of stopped dead. Behind the walls the rest of the sidewalk
 *    is shut in: the building line there takes the 'tunnel' look too (no void
 *    for the infill, no shop front) and street furniture keeps off it.
 *  - 'building': two legs stand behind the building lines either side,
 *    reaching from one wing end to the other (buildings kept out), and the
 *    renderer joins them over the road above the ceiling.
 *  - 'ridge': the hills profile (hills.ts: a rounded rectangle plateau with a
 *    smoothstep flank, exact gradient) raised across the street, multiplied
 *    by a mask that is 0 across the street's corridor (road plus sidewalks)
 *    and rises to 1 just behind its building line, so the street stays at
 *    road level the whole way through and the ridge climbs behind a rock
 *    face ('rock' walls on the building line). Its size is chosen so the rock
 *    over each portal is CFG.portalCover thick; between the portals the
 *    renderer drapes the unmasked surface over the bore. The ridge's flanks
 *    keep CFG.ridgeClear clear of every other street, so no street but the
 *    tunnel's crosses the ridge; it claims both blocks it stands in.
 *
 * Both keep their ends clear of the junctions' reach (closures, corner rails;
 * structures.ts), and both keep away from the river channel, the El, hill
 * slopes, roundabouts and the other structures. The race routes' streets
 * are tried first (PlanContext.event; never where a race starts or
 * finishes), then the ones races are likely to use (routeTraffic: busy,
 * fast, central).
 */
import { CITY } from '../config';
import type { RoadEdge, RoadGraph } from '../roadGraph';
import { computeMouths, makeWall } from '../blocks';
import type { EdgeMouths } from '../blocks';
import { Vec2, distToSegment, sqrt } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import type { Area, DistrictModule, HeightSample, PlanContext } from './types';
import { emptyBuild } from './types';
import { HillShape, hillAt, hillOutline, plateauDistance } from './hills';
import { smooth01 } from './geom';
import { Frame, ON_ROUTE, SiteHazards, StreetRun, TRAFFIC_FLOOR, chordFrame, corridorGap, raceStreets, edgeFaces, junctionReach, routeTraffic, runPiece, siteClear, siteHazards, streetRun, toWorld, weightedOrder } from './structures';
import { chains } from '../roadGraph';

const CFG = CITY.districts.tunnel;

/** Street kinds a tunnel can carry (two or four lanes with sidewalks). */
const KINDS = new Set<RoadEdge['kind']>(['street', 'avenue', 'diagonal', 'boulevard']);

/** A tunnel's bore in its street frame (u along the street from node a to node b, v across it), from the area params. */
export interface TunnelShape extends Frame {
  /** Portals at u = -half and u = +half (m). */
  half: number;
  /** Half widths from the centerline (m): curb, tunnel wall (curb plus walkway), building line. */
  road: number;
  wall: number;
  front: number;
  /** Wingwall run beyond each portal (m). */
  wing: number;
  /** Ceiling above the road (m). */
  clearance: number;
}

export function tunnelShape(a: Area): TunnelShape {
  const p = a.params;
  return { cx: p.cx, cz: p.cz, ux: p.ux, uz: p.uz, half: p.half, road: p.road, wall: p.wall, front: p.front, wing: p.wing, clearance: p.clearance };
}

/** A ridge: the hills profile in the street frame, its corridor cut out by a mask rising from |v| = m0 to m1 (m). */
export interface RidgeShape extends HillShape {
  m0: number;
  m1: number;
}

export function ridgeShape(a: Area): RidgeShape {
  const p = a.params;
  return { cx: p.cx, cz: p.cz, ux: p.ux, uz: p.uz, a: p.ra, b: p.rb, h: p.rh, w: p.rw, m0: p.m0, m1: p.m1 };
}

/**
 * Tunnel names, on the portal boards (render/districts/tunnel.ts) and the HUD
 * and map (ui/map/places.ts). Each tunnel in a city gets its own (params.name).
 */
export const TUNNEL_NAMES = ['Chrome Tunnel', 'Midnight Tunnel', 'Harbor Tunnel', 'Meridian Tunnel', 'Nova Bore', 'Irongate Tunnel'] as const;

export function tunnelName(a: Area): string {
  return TUNNEL_NAMES[(a.params.name ?? 0) % TUNNEL_NAMES.length];
}

const raw: HeightSample = { h: 0, gx: 0, gz: 0 };

/** The ridge as the terrain has it (street corridor cut out): adds height and exact gradient into `out`. */
export function ridgeAt(s: RidgeShape, x: number, z: number, out: HeightSample): void {
  raw.h = 0;
  raw.gx = 0;
  raw.gz = 0;
  hillAt(s, x, z, raw);
  if (raw.h === 0) return;
  const v = -(x - s.cx) * s.uz + (z - s.cz) * s.ux;
  const m = smooth01(s.m0, s.m1, Math.abs(v));
  if (m.v === 0) return;
  out.h += raw.h * m.v;
  // d|v|/dx = sign(v) * -uz, d|v|/dz = sign(v) * ux.
  const k = raw.h * m.d * (v < 0 ? -1 : 1);
  out.gx += raw.gx * m.v - k * s.uz;
  out.gz += raw.gz * m.v + k * s.ux;
}

/** The ridge's full surface with nothing cut out (m above the base terrain): the rock the renderer drapes over the bore. */
export function ridgeRawAt(s: RidgeShape, x: number, z: number): number {
  raw.h = 0;
  raw.gx = 0;
  raw.gz = 0;
  hillAt(s, x, z, raw);
  return raw.h;
}

/** t in [0, 1] with smoothstep(t) = y (bisection: plain arithmetic, the same everywhere). */
function invSmooth(y: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const t = (lo + hi) / 2;
    if (t * t * (3 - 2 * t) < y) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

/** Rectangle u0..u1 x v0..v1 in a frame, as a polygon. */
export function frameRect(f: Frame, u0: number, u1: number, v0: number, v1: number): Vec2[] {
  return [toWorld(f, u0, v0), toWorld(f, u1, v0), toWorld(f, u1, v1), toWorld(f, u0, v1)];
}

/**
 * The most a street may stray from the bore's straight line across its span (m): a street is a
 * chain of pieces through bend nodes (roadGraph.ts) and the bore stands on the chord of its span,
 * so the walkway (CFG.walkway) keeps at least this much of its width where the curb comes closest.
 */
const BORE_STRAY = 0.35;
/** The most a street may stray from a ridge's line over the ridge's whole length along it (m): its corridor mask widens by that much. */
const RIDGE_STRAY = 2;

interface Site {
  /** The piece under the bore's middle (params.edge: the renderer reads its width). */
  e: RoadEdge;
  /** Every piece the bore and its wings reach over: all claimed. */
  edges: number[];
  /** The street and where along it the bore's middle sits (m). */
  run: StreetRun;
  s: number;
  f: Frame;
  half: number;
  road: number;
  wall: number;
  front: number;
}

/**
 * Where along a street (a run of pieces between two junctions) a bore of this half length (plus
 * wings) can sit, as a straight frame on the street's chord there, or null when the block is too
 * short or the street bends more than BORE_STRAY across the span.
 */
function placeBore(g: RoadGraph, mouths: EdgeMouths[], run: StreetRun, half: number, rng: Rng): Site | null {
  const c = run.chain;
  const first = g.edges[c.edges[0]];
  const last = g.edges[c.edges[c.edges.length - 1]];
  const ends = CFG.nodeGap + CFG.wing + half;
  const lo = junctionReach(g, mouths, first, c.nodes[0]) + ends;
  const hi = run.length - (junctionReach(g, mouths, last, c.nodes[c.nodes.length - 1]) + ends);
  if (lo > hi) return null;
  const s = lo + (hi - lo) * rng.next();
  const reach = half + CFG.wing;
  const { f, stray } = chordFrame(run, s - reach, s + reach);
  if (stray > BORE_STRAY) return null;
  const e = g.edges[c.edges[runPiece(run, s)]];
  const edges = c.edges.filter((_, i) => run.cum[i + 1] > s - reach - CFG.nodeGap && run.cum[i] < s + reach + CFG.nodeGap);
  const road = e.width / 2;
  return { e, edges, run, s, f, half, road, wall: road + CFG.walkway, front: road + e.sidewalk };
}

/** The bore and its wings are clear of the river, the El, hills, roundabouts and the other structures. */
function boreClear(hz: SiteHazards, s: Site): boolean {
  const reach = s.half + CFG.wing;
  for (let u = -reach; u <= reach + 1e-9; u += 4) {
    for (const v of [-s.front, 0, s.front]) {
      const p = toWorld(s.f, u, v);
      if (!siteClear(hz, p.x, p.z, CFG.siteClear)) return false;
    }
  }
  return true;
}

export const tunnelModule: DistrictModule = {
  kind: 'tunnel',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const faces = ctx.faces();
    const sides = edgeFaces(faces);
    const mouths = computeMouths(g, ctx.sectors());
    const hz = siteHazards(ctx);
    /** Both blocks beside the street unclaimed (no park, plaza or hill opening its frontage). */
    const race = raceStreets(ctx);
    const eligible = (e: RoadEdge): boolean => {
      if (!KINDS.has(e.kind) || e.bridge || e.shortcut || ctx.claims.edge.has(e.id) || race.ends.has(e.id)) return false;
      if (g.nodes[e.a].ring || g.nodes[e.b].ring) return false;
      const fs = sides.get(e.id);
      return !!fs && fs.length === 2 && fs[0] !== fs[1] && fs.every((f) => !ctx.claims.face.has(f));
    };
    // Streets (chains of pieces between junctions, roadGraph.ts) whose every piece is eligible; the
    // race's own streets first, then busy ones: a tunnel only matters when races run through it.
    const traffic = routeTraffic(g, ctx.seed);
    const runs = chains(g)
      .filter((c) => c.edges.every((id) => eligible(g.edges[id])))
      .map((c) => streetRun(g, c));
    const weight = (i: number) => {
      const ids = runs[i].chain.edges;
      let t = 0;
      for (const id of ids) t += traffic[id];
      return (TRAFFIC_FLOOR + t / ids.length) ** 2 + (ids.some((id) => race.route.has(id)) ? ON_ROUTE : 0);
    };
    const order = weightedOrder(
      runs.map((_, i) => i),
      weight,
      rng,
    );
    const stillFree = (i: number) => runs[i].chain.edges.every((id) => eligible(g.edges[id]));
    const ridge = rng.chance(CFG.ridgeChance);
    const want = rng.int(CFG.buildings[0], CFG.buildings[1]);
    // Names go round the list from a seeded start, so no two tunnels in a city share one.
    names.next = rng.int(0, TUNNEL_NAMES.length - 1);
    // The ridge first: it needs a long block with deep blocks either side.
    if (ridge) for (const i of order) if (stillFree(i) && planRidge(ctx, hz, mouths, sides.get(runs[i].chain.edges[0])!, runs[i])) break;
    let made = 0;
    for (const i of order) {
      if (made >= want) break;
      if (stillFree(i) && planBuilding(ctx, hz, mouths, runs[i])) made++;
    }
  },

  build(_ctx, area) {
    const b = emptyBuild();
    const t = tunnelShape(area);
    const reach = t.half + t.wing;
    for (const side of [1, -1]) {
      // Tunnel wall along the walkway's back edge, a wingwall at each portal flaring out to the building line.
      const pts = [toWorld(t, -reach, side * t.front), toWorld(t, -t.half, side * t.wall), toWorld(t, t.half, side * t.wall), toWorld(t, reach, side * t.front)];
      const us = [-reach, -t.half, t.half, reach];
      for (let i = 0; i + 1 < pts.length; i++) {
        // The drivable side: the centerline beside the segment's middle.
        const w = makeWall(pts[i], pts[i + 1], toWorld(t, (us[i] + us[i + 1]) / 2, 0), 'wall');
        if (!w) continue;
        w.look = 'tunnel';
        w.area = area.id;
        b.walls.push(w);
      }
      // The building line behind them is shut in: the tunnel's look (drawn inside its walls), never a void or a shop front.
      b.frontLooks.push({ polygon: frameRect(t, -reach - 0.5, reach + 0.5, side * (t.front - 0.6), side * (t.front + 2.5)), look: 'tunnel', area: area.id });
      // No streetlights, bins or bus stops on the shut in sidewalk.
      const mid = (t.road + t.front) / 2;
      for (let u = -reach - 1; u <= reach + 1 + 1e-9; u += 3) {
        const c = toWorld(t, u, side * mid);
        b.reserved.push({ x: c.x, z: c.z, r: (t.front - t.road) / 2 + 0.6 });
      }
    }
    if (area.variant === 'building') {
      // The legs: no other building inside them.
      const depth = area.params.legDepth;
      for (const side of [1, -1]) b.exclusions.push(frameRect(t, -reach - 0.5, reach + 0.5, side * (t.front - 0.5), side * (t.front + depth + 0.5)));
    } else {
      const s = ridgeShape(area);
      const e = s.a + s.w + 1;
      const f = s.b + s.w + 1;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const p of frameRect(s, -e, e, -f, f)) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      b.heightMods.push({ minX, minZ, maxX, maxZ, add: (x, z, out) => ridgeAt(s, x, z, out) });
      b.exclusions.push(hillOutline(s, s.w + 1.5));
      // Rock faces along the building line where the ridge rises behind it (after the tunnel's own, which win).
      const span = s.a + s.w + 2;
      for (const side of [1, -1]) b.frontLooks.push({ polygon: frameRect(t, -span, span, side * (t.front - 0.6), side * (t.front + 2.5)), look: 'rock', area: area.id });
    }
    return b;
  },
};

/** A tunnel under an air rights building on a street, if one fits. */
function planBuilding(ctx: PlanContext, hz: SiteHazards, mouths: EdgeMouths[], run: StreetRun): boolean {
  const g = ctx.graph;
  const rng = ctx.rng;
  const half = rng.range(CFG.buildingLength[0], CFG.buildingLength[1]) / 2;
  const depth = rng.range(CFG.legDepth[0], CFG.legDepth[1]);
  const floors = rng.int(CFG.floors[0], CFG.floors[1]);
  const seed = rng.int(1, 0x7ffffffe);
  const site = placeBore(g, mouths, run, half, rng);
  if (!site || !boreClear(hz, site)) return false;
  // Both legs stand inside their blocks: clear of every other street's corridor (back alleys included).
  const own = new Set(run.chain.edges);
  const reach = half + CFG.wing;
  for (const side of [1, -1]) {
    for (const u of [-reach, -reach / 2, 0, reach / 2, reach]) {
      for (const dv of [0.6, depth / 2, depth + 0.5]) {
        const p = toWorld(site.f, u, side * (site.front + dv));
        if (corridorGap(g, p.x, p.z, own) < 1) return false;
      }
    }
  }
  addTunnel(ctx, hz, site, 'building', [], reach + depth, { legDepth: depth, floors, seed });
  return true;
}

/** A tunnel through a ridge raised across a street, if one fits. */
function planRidge(ctx: PlanContext, hz: SiteHazards, mouths: EdgeMouths[], faces: number[], run: StreetRun): boolean {
  const g = ctx.graph;
  const rng = ctx.rng;
  const H = rng.range(CFG.ridgeHeight[0], CFG.ridgeHeight[1]);
  const w = CFG.ridgeFlank;
  const length = rng.range(CFG.ridgeLength[0], CFG.ridgeLength[1]);
  const bWant = rng.range(CFG.ridgeHalfWidth[0], CFG.ridgeHalfWidth[1]);
  const seed = rng.int(1, 0x7ffffffe);
  // The portals stand where the flank has come down to the ceiling slab plus the rock cover.
  const top = CFG.clearance + CFG.slab + CFG.portalCover;
  if (top > H - 2) return false;
  const t = invSmooth(1 - top / H);
  let half = length / 2;
  let a = half - w * t;
  if (a < 4) {
    a = 4;
    half = a + w * t;
  }
  const site = placeBore(g, mouths, run, half, rng);
  if (!site || !boreClear(hz, site)) return false;
  const own = new Set(run.chain.edges);
  // The ridge's flanks run on along the street past the bore (a + w each way): the street's corridor
  // is masked out of them along the bore's straight frame, so where the street bends away from
  // that line the mask widens by the stray, and a street bending more than RIDGE_STRAY gets no ridge.
  const strayAlong = chordFrame(run, site.s - (a + w), site.s + (a + w)).stray;
  if (strayAlong > RIDGE_STRAY) return false;
  const m0 = site.front + 0.25 + strayAlong;
  const m1 = site.front + CFG.maskRamp + strayAlong;
  const b = Math.max(bWant, m1 + 6);
  const shape: RidgeShape = { ...site.f, a, b, h: H, w, m0, m1 };
  // Every other street keeps clear of the flanks: nothing else crosses the ridge.
  const R = sqrt((a + w) ** 2 + (b + w) ** 2);
  for (const o of g.edges) {
    if (own.has(o.id)) continue;
    const A = g.nodes[o.a];
    const B = g.nodes[o.b];
    const need = w + o.width / 2 + o.sidewalk + CFG.ridgeClear;
    if (distToSegment(shape.cx, shape.cz, A.x, A.z, B.x, B.z) > R + need) continue;
    const n = Math.max(1, Math.ceil(o.length / 2));
    for (let k = 0; k <= n; k++) {
      if (plateauDistance(shape, A.x + ((B.x - A.x) * k) / n, A.z + ((B.z - A.z) * k) / n).d < need) return false;
    }
  }
  for (const n of g.nodes) if (n.ring && plateauDistance(shape, n.x, n.z).d < w + n.ring.outer + CITY.sidewalk + CFG.ridgeClear) return false;
  // The whole footprint clear of the channel, the El, hills and the other structures.
  for (let u = -(a + w); u <= a + w + 1e-9; u += 6) {
    for (let v = -(b + w); v <= b + w + 1e-9; v += 6) {
      const p = toWorld(shape, u, v);
      if (plateauDistance(shape, p.x, p.z).d > w) continue;
      if (!siteClear(hz, p.x, p.z, CFG.siteClear * 0.5)) return false;
    }
  }
  const footprint = 4 * (a + w) * (b + w);
  if (ctx.budget.used + footprint > ctx.budget.total) return false;
  addTunnel(ctx, hz, site, 'ridge', faces, sqrt((a + w) ** 2 + (b + w) ** 2), { ra: a, rb: b, rh: H, rw: w, m0, m1, seed }, hillOutline(shape, w * 0.85), footprint);
  return true;
}

/** The next tunnel name index (reset per plan). */
const names = { next: 0 };

function addTunnel(ctx: PlanContext, hz: SiteHazards, s: Site, variant: 'building' | 'ridge', faces: number[], reach: number, extra: Record<string, number>, polygon?: Vec2[], footprint = 0): void {
  const f = s.f;
  const name = names.next++ % TUNNEL_NAMES.length;
  ctx.addArea(
    {
      kind: 'tunnel',
      variant,
      polygon: polygon ?? frameRect(f, -s.half, s.half, -s.front, s.front),
      path: [toWorld(f, -s.half, 0), toWorld(f, s.half, 0)],
      nodes: [],
      edges: s.edges,
      faces,
      params: { cx: f.cx, cz: f.cz, ux: f.ux, uz: f.uz, half: s.half, road: s.road, wall: s.wall, front: s.front, wing: CFG.wing, clearance: CFG.clearance, edge: s.e.id, reach, name, ...extra },
    },
    footprint,
  );
  hz.taken.push({ x: f.cx, z: f.cz, r: reach });
}
