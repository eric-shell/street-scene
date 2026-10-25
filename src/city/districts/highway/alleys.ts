/**
 * The alleys under the elevated highway's ramp lanes (highway.ts plans them
 * once the line's streets are widened, so the blocks' building lines are
 * final; each is an area of its own, variant 'alley'): along every block
 * whose frontage on the deck's street runs under a ramp's lane (the deck
 * widened out over it), the strip of the block from the building line
 * CFG.alleyDepth deep is paved and open, to the street beneath the deck
 * across its sidewalk between the bents' columns and to the cross streets at
 * both ends. So the space under a lane, once a void walled off the street, is
 * a back way along the deck to dive into and cut through. Its back is a low
 * wall (look 'boundary', drawn with the city's) from cross street to cross
 * street, the lane's outer columns stand just behind it, and no buildings or
 * infill stand on it.
 *
 * In a race a closure across the street beneath is carried on across the
 * alley to its back wall (world.ts sealBarriers), and a mouth onto a cross
 * street the route does not take is shut (settle.ts highwayGates), so it is
 * never a way round a closure. Pure and deterministic.
 */
import { CITY } from '../../config';
import type { Wall } from '../../blocks';
import { Vec2, distToSegment, sqrt } from '../../../sim/math';
import type { Area, AreaBuild, BuildContext, PlanContext } from '../types';
import { emptyBuild } from '../types';
import { clipConvex, pointInPolygon } from '../geom';
import { RailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { HALF, deckCurve, deckPoint } from './shape';

const CFG = CITY.districts.highway;

/** Lanes shorter than this along a block's frontage leave it as it is (m), unless they cover this share of it. */
const MIN_OVERLAP = 45;
const MIN_SHARE = 0.4;

/** Paving pieces are about this long along the deck (m). */
const SLICE = 6;

/** No buildings this far behind the back wall (m). */
const BACK_CLEAR = 2.5;

/** A stretch of the deck on one side (s along the curve, low to high). */
export interface Stretch {
  side: 1 | -1;
  range: [number, number];
}

/** A planned alley: the area's polygon, its back wall and its mouths onto the cross streets. */
export interface AlleyPlan {
  side: 1 | -1;
  /** Its stretch along the deck at the back wall (s, m, low to high). */
  s0: number;
  s1: number;
  polygon: Vec2[];
  /** The back wall, from the cross street at s0 to the one at s1. */
  back: Vec2[];
  /** The mouths: the cross street piece at each end (-1 when none) and the opening along its building line, the back wall's end (b) to the street beneath's building line (a). */
  mouths: { edge: number; a: Vec2; b: Vec2 }[];
}

/** A polygon in the deck's frame (x: s along the curve, z: v out on `side`), its edges no longer than `step`. */
function toFrame(curve: RailCurve, ring: readonly Vec2[], side: 1 | -1, step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / step));
    for (let k = 0; k < n; k++) {
      const pr = projectOnCurve(curve, p.x + ((q.x - p.x) * k) / n, p.z + ((q.z - p.z) * k) / n);
      out.push({ x: pr.s, z: pr.lateral * side });
    }
  }
  return out;
}

/** Back from the deck's frame to the world, edges densified to `step` first so curved ones stay true. */
function fromFrame(curve: RailCurve, poly: readonly Vec2[], side: 1 | -1, step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / step));
    for (let k = 0; k < n; k++) out.push(deckPoint(curve, p.x + ((q.x - p.x) * k) / n, (p.z + ((q.z - p.z) * k) / n) * side));
  }
  return out;
}

/** The part of a frame polygon at most `v` out from the deck's centerline. */
const within = (poly: Vec2[], v: number): Vec2[] => clipConvex(poly, { x: 0, z: v }, { x: 1, z: v }, -1);

/** The part of a frame polygon between s0 and s1. */
const between = (poly: Vec2[], s0: number, s1: number): Vec2[] => clipConvex(clipConvex(poly, { x: s0, z: 0 }, { x: s0, z: 1 }, -1), { x: s1, z: 0 }, { x: s1, z: 1 }, 1);

/**
 * The alleys of a committed line (its streets widened: ctx.faces() are the final blocks): one per block
 * whose frontage something elevated (a lane, a slip ramp's bridge) runs over for MIN_OVERLAP m or
 * MIN_SHARE of it, and nothing on the ground (a slip ramp's embankment or its run along the street, an
 * end loop's leg) takes. `elevated` and `solid`: those stretches of the deck on each side (s, low to
 * high); `avoid`: the end loops' footprints.
 */
export function planAlleys(ctx: PlanContext, curve: RailCurve, elevated: readonly Stretch[], solid: readonly Stretch[], avoid: readonly Vec2[][]): AlleyPlan[] {
  const g = ctx.graph;
  const faces = ctx.faces();
  const vMax = HALF + CFG.alleyDepth;
  const out: AlleyPlan[] = [];
  const faceAt = (s: number, side: 1 | -1) => {
    const p = deckPoint(curve, s, side * (HALF + 3));
    return faces.find((x) => !x.outer && pointInPolygon(p.x, p.z, x.ring));
  };
  const done = new Set<number>();
  for (const { side, range } of solid) for (let s = range[0]; s <= range[1]; s += 3) done.add(faceAt(s, side)?.id ?? -1);
  for (const f of faces) if (!f.outer && avoid.some((poly) => poly.some((p) => pointInPolygon(p.x, p.z, f.ring)))) done.add(f.id);
  for (const { side, range } of elevated) {
    // The blocks beside the stretch, and how far it runs along each.
    const over = new Map<number, number>();
    for (let s = range[0]; s <= range[1]; s += 3) {
      const f = faceAt(s, side);
      if (f) over.set(f.id, (over.get(f.id) ?? 0) + 3);
    }
    for (const [fid, run] of over) {
      if (done.has(fid)) continue;
      const face = faces[fid];
      if (face.edges.some((e) => g.edges[e].shortcut || g.edges[e].bridge || g.edges[e].kind === 'channel' || g.edges[e].kind === 'ramp')) continue;
      const frame = toFrame(curve, face.ring, side, 3);
      const strip = within(frame, vMax);
      if (strip.length < 3) continue;
      // The back wall: where the clip line cuts the block, from one cross street to the other.
      const onBack = strip.filter((p) => Math.abs(p.z - vMax) < 1e-6);
      if (onBack.length !== 2) continue;
      const s0 = Math.min(onBack[0].x, onBack[1].x);
      const s1 = Math.max(onBack[0].x, onBack[1].x);
      if (s1 - s0 < 30 || (run < MIN_OVERLAP && run < MIN_SHARE * (s1 - s0))) continue;
      // Nothing but the deck's street in front: the strip's front lies along it, at the building line.
      if (strip.some((p) => p.z < HALF - 2.5)) continue;
      done.add(fid);
      const back: Vec2[] = [];
      const nb = Math.max(1, Math.ceil((s1 - s0) / 3));
      for (let k = 0; k <= nb; k++) back.push(deckPoint(curve, s0 + ((s1 - s0) * k) / nb, side * vMax));
      const mouths = [back[0], back[back.length - 1]].map((b) => mouthAt(ctx, curve, side, b));
      out.push({ side, s0, s1, polygon: fromFrame(curve, strip, side, 3), back, mouths });
    }
  }
  return out;
}

/**
 * An alley's mouth onto the cross street at its back wall's end b: the street's piece there, and the
 * opening along the street's building line from b in to the building line of the street beneath the deck.
 */
function mouthAt(ctx: PlanContext, curve: RailCurve, side: 1 | -1, b: Vec2): { edge: number; a: Vec2; b: Vec2 } {
  const g = ctx.graph;
  let edge = -1;
  let best = Infinity;
  for (const e of g.edges) {
    const p = g.nodes[e.a];
    const q = g.nodes[e.b];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
    const t = Math.max(0, Math.min(1, ((b.x - p.x) * (q.x - p.x) + (b.z - p.z) * (q.z - p.z)) / (l * l)));
    const d = Math.hypot(p.x + (q.x - p.x) * t - b.x, p.z + (q.z - p.z) * t - b.z) - e.width / 2 - e.sidewalk;
    if (d < best) {
      best = d;
      edge = e.id;
    }
  }
  if (best > 1.5) return { edge: -1, a: b, b };
  // Along the cross street's building line toward the deck, to the building line of the street beneath
  // (read off that street's own pieces, not the deck's smoothed line).
  const e = g.edges[edge];
  const p = g.nodes[e.a];
  const q = g.nodes[e.b];
  const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
  let ux = (q.x - p.x) / l;
  let uz = (q.z - p.z) / l;
  const lat0 = projectOnCurve(curve, b.x, b.z).lateral * side;
  if (projectOnCurve(curve, b.x + ux, b.z + uz).lateral * side > lat0) {
    ux = -ux;
    uz = -uz;
  }
  const P = curvePoint();
  sampleCurve(curve, projectOnCurve(curve, b.x, b.z).s, P);
  const beneath = g.edges.filter((f) => {
    if (f.id === edge) return false;
    const fa = g.nodes[f.a];
    const fb = g.nodes[f.b];
    const fl = Math.hypot(fb.x - fa.x, fb.z - fa.z) || 1;
    return Math.abs(((fb.x - fa.x) * P.tx + (fb.z - fa.z) * P.tz) / fl) > 0.8 && distToSegment(b.x, b.z, fa.x, fa.z, fb.x, fb.z) < 60;
  });
  const inStreet = (x: number, z: number) => beneath.some((f) => distToSegment(x, z, g.nodes[f.a].x, g.nodes[f.a].z, g.nodes[f.b].x, g.nodes[f.b].z) < f.width / 2 + f.sidewalk);
  let a = b;
  for (let d = 0.25; d < 24; d += 0.25) {
    const n = { x: b.x + ux * d, z: b.z + uz * d };
    if (inStreet(n.x, n.z)) break;
    a = n;
  }
  return { edge, a, b };
}

/** An alley's area params and paths from its plan: the polygon is the area's, the back wall its path. */
export function alleyArea(deck: number, plan: AlleyPlan): Omit<Area, 'id'> {
  const params: Record<string, number> = { deck, side: plan.side, s0: plan.s0, s1: plan.s1 };
  plan.mouths.forEach((m, k) => {
    params[`m${k}e`] = m.edge;
    params[`m${k}ax`] = m.a.x;
    params[`m${k}az`] = m.a.z;
    params[`m${k}bx`] = m.b.x;
    params[`m${k}bz`] = m.b.z;
  });
  return { kind: 'highway', variant: 'alley', polygon: plan.polygon, path: plan.back, nodes: [], edges: [], faces: [], params };
}

/** An alley's mouths onto the cross streets (the cross street's piece, or -1, and the opening a to b along its building line). */
export function alleyMouths(area: Area): { edge: number; a: Vec2; b: Vec2 }[] {
  const p = area.params;
  return [0, 1].map((k) => ({ edge: p[`m${k}e`], a: { x: p[`m${k}ax`], z: p[`m${k}az`] }, b: { x: p[`m${k}bx`], z: p[`m${k}bz`] } }));
}

/**
 * An alley's build: its paving (road, in convex pieces about SLICE m long, which the renderer drapes too:
 * hints 'pave'), the frontage taken out across it, no buildings on it or just behind its back wall, and
 * the back wall itself (look 'boundary', facing the alley).
 */
export function buildAlley(ctx: BuildContext, area: Area): AreaBuild {
  const b = emptyBuild();
  const curve = deckCurve(ctx.areas[area.params.deck]);
  const side: 1 | -1 = area.params.side > 0 ? 1 : -1;
  const frame = toFrame(curve, area.polygon, side, 1e9);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of frame) {
    lo = Math.min(lo, p.x);
    hi = Math.max(hi, p.x);
  }
  const n = Math.max(1, Math.round((hi - lo) / SLICE));
  for (let k = 0; k < n; k++) {
    const piece = between(frame, lo + ((hi - lo) * k) / n, lo + ((hi - lo) * (k + 1)) / n);
    if (piece.length < 3) continue;
    const poly = fromFrame(curve, piece, side, 1e9);
    b.surfaces.push({ surface: 'road', polygon: poly, priority: 2, area: area.id });
    b.hints.push({ kind: 'pave', points: poly, values: [] });
  }
  b.openings.push(area.polygon);
  b.exclusions.push(area.polygon);
  const back = area.path;
  const vMax = HALF + CFG.alleyDepth;
  const s0 = area.params.s0;
  const s1 = area.params.s1;
  b.exclusions.push([deckPoint(curve, s0 - 1, side * (vMax - 0.5)), deckPoint(curve, s1 + 1, side * (vMax - 0.5)), deckPoint(curve, s1 + 1, side * (vMax + BACK_CLEAR)), deckPoint(curve, s0 - 1, side * (vMax + BACK_CLEAR))]);
  // The back wall, its faces toward the alley (the deck's side).
  for (let k = 0; k + 1 < back.length; k++) {
    const a = back[k];
    const c = back[k + 1];
    const len = sqrt((c.x - a.x) ** 2 + (c.z - a.z) ** 2);
    if (len < 0.05) continue;
    let nx = -(c.z - a.z) / len;
    let nz = (c.x - a.x) / len;
    const toward = deckPoint(curve, s0 + ((s1 - s0) * (k + 0.5)) / (back.length - 1), side * HALF);
    if ((toward.x - a.x) * nx + (toward.z - a.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const w: Wall = { ax: a.x, az: a.z, bx: c.x, bz: c.z, nx, nz, kind: 'wall', look: 'boundary', area: area.id };
    b.walls.push(w);
  }
  return b;
}
