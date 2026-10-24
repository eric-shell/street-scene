/**
 * The elevated highway as everything downstream reads it (highway.ts plans
 * it): the deck's smoothed line (deckCurve, railCurve.ts's resampling of the
 * planned path) and the deck once settled on the terrain (HighwayDeck: its
 * underside and top per curve sample, the closures, the El crossing, its
 * ramps), a ramp's axis and profile (HighwayRamp), and the shared measures:
 * where the deck is widened onto a ramp's merge and its barrier opens, the
 * ramp's outline, its lane's outer wall along the merge, the frontage under
 * its top, the curb cut at its mouth. The build, the settle step, the
 * renderer, the cameras and the resets all read these, so they agree. One
 * object per area (WeakMaps keyed by the area), pure and deterministic.
 */
import { CITY } from '../../config';
import type { RoadGraph } from '../../roadGraph';
import type { EdgeMouths } from '../../blocks';
import { edgeSides } from '../../props';
import type { Terrain } from '../../terrain';
import { Vec2, sqrt } from '../../../sim/math';
import type { Area } from '../types';
import { RAIL, RailCurve, buildRailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { RampAxis, RampProfile, axisAt } from './rampAxis';

const CFG = CITY.districts.highway;

export const HALF = CFG.deckWidth / 2;

/** Beyond a closure's reach columns keep this margin (m), as the El's (subway.ts CLOSURE_GAP). */
export const CLOSURE_GAP = 3.5;

/** Barrier walls stand this far inside the deck's edge (m): a car's wheels never sample past the span. */
export const BARRIER_IN = 0.45;

/** The closure at each end stands this far past the end row's boundary junction, outward (m). */
const END_PAST = 12;

/** A ramp's lane: full width alongside the deck over `merge` m, then a taper back to its edge over `taper` m. */
export const MERGE = 12;

export const TAPER = 20;

/**
 * The gore: the ramp's inner wall runs on this far past E along the deck's edge (m), and the deck is
 * widened onto the lane from there to the taper's end; the barrier opens only where a whole chunk lies
 * in that stretch, so there is never a hole between the barrier's end and the ramp's walls.
 */
export const GORE = 8;

/** The ramp is a solid single level up to this far before its end (m); past it, two levels (it passes over the sidewalk). */
export const SOLID_TO_END = 40;

/** The mouth's curb cut flares this much at each end (m). */
export const MOUTH_TAPER = 6;

/** Streets the deck follows or a ramp leaves from. */
export const PLAIN = new Set(['street', 'avenue', 'boulevard', 'diagonal']);

export function segmentHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { p: Vec2; t: number } | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { p: { x: a.x + rx * t, z: a.z + rz * t }, t };
}

/** The deck's line through the blocks and its streets, resampled and smoothed (railCurve.ts), heights left at 0. */
const curves = new WeakMap<Area, RailCurve>();

export function deckCurve(area: Area): RailCurve {
  let c = curves.get(area);
  if (!c) curves.set(area, (c = buildRailCurve(area.path, 1, 0, () => 0)));
  return c;
}

/** Right of travel along a unit direction (sim/math yaw convention, structures.ts Frame). */
export const rightOf = (tx: number, tz: number): Vec2 => ({ x: -tz, z: tx });

/** Where a path crosses the El's: the crossing points (normally one, or none without an El). */
export function elCrossings(path: readonly Vec2[], areas: readonly Area[]): Vec2[] {
  const out: Vec2[] = [];
  for (const a of areas) {
    if (a.kind !== 'subway') continue;
    for (let i = 0; i + 1 < path.length; i++) {
      for (let k = 0; k + 1 < a.path.length; k++) {
        const h = segmentHit(path[i], path[i + 1], a.path[k], a.path[k + 1]);
        if (h) out.push(h.p);
      }
    }
  }
  return out;
}

/** The deck as it is settled on the terrain: the curve's samples with the deck's underside and top. */
export interface HighwayDeck {
  area: Area;
  curve: RailCurve;
  /** Underside and top (road surface) of the deck per curve sample (m, absolute; 0 until settled). */
  under: Float64Array;
  top: Float64Array;
  /** The drivable stretch between the end closures (s along the curve, m). */
  sW: number;
  sE: number;
  /** Where the deck crosses the El (s, m; NaN without), and the hump's half reach there (m). */
  sEl: number;
  /** This deck's ramps. */
  ramps: HighwayRamp[];
  settled: boolean;
}

/** A ramp as everything downstream sees it. */
export interface HighwayRamp {
  area: Area;
  axis: RampAxis;
  profile: RampProfile;
  side: 1 | -1;
  sa: number;
  sb: number;
  /** The row street's building line from the deck's centerline (m), and where the ramp's block ends along the deck (s, m). */
  building: number;
  sBlock: number;
  /** The terrain the mouth blends into (set when settled). */
  terrain: Terrain | null;
}

const decks = new WeakMap<Area, HighwayDeck>();

const rampShapes = new WeakMap<Area, HighwayRamp>();

/** A ramp area's shape (axis, profile), one object per area. */
export function highwayRamp(area: Area): HighwayRamp {
  let r = rampShapes.get(area);
  if (r) return r;
  const p = area.params;
  const axis: RampAxis = { fx: p.fx, fz: p.fz, dx: p.dx, dz: p.dz, a: p.a, cx: p.cx, cz: p.cz, r: p.r, sweep: p.sweep, phi0: p.phi0, ex: p.ex, ez: p.ez, tx: p.tx, tz: p.tz, length: p.length };
  const profile: RampProfile = { y0: 0, g0: 0, y1: 0, g1: 0, grade: 0, e0: CFG.rampFootEase, e1: CFG.rampTopEase, blend: 14, ready: false };
  r = { area, axis, profile, side: p.side > 0 ? 1 : -1, sa: p.sa, sb: p.sb, building: p.building, sBlock: p.sBlock, terrain: null };
  rampShapes.set(area, r);
  return r;
}

/** The deck of a highway area (variant 'deck'), with its ramps (from `areas`), one object per area. */
export function highwayDeck(area: Area, areas: readonly Area[]): HighwayDeck {
  let d = decks.get(area);
  if (d) return d;
  const curve = deckCurve(area);
  const n = curve.n;
  const W = CITY.gridW;
  // The closures stand END_PAST beyond the end columns' junctions (path[at0], path[at(W-1)]), outward.
  const p0 = area.path[area.params.at0];
  const p1 = area.path[area.params[`at${W - 1}`]];
  const s0 = projectOnCurve(curve, p0.x, p0.z).s - END_PAST;
  const s1 = projectOnCurve(curve, p1.x, p1.z).s + END_PAST;
  const cross = elCrossings(area.path, areas);
  d = {
    area,
    curve,
    under: new Float64Array(n),
    top: new Float64Array(n),
    sW: Math.max(RAIL.step, s0),
    sE: Math.min(curve.length - RAIL.step, s1),
    sEl: cross.length ? projectOnCurve(curve, cross[0].x, cross[0].z).s : NaN,
    ramps: areas.filter((a) => a.kind === 'highway' && a.variant === 'ramp' && a.params.deck === area.id).map(highwayRamp),
    settled: false,
  };
  decks.set(area, d);
  return d;
}

/** Deck top (m) at s along the curve, linear between samples. */
export function deckTopAt(d: HighwayDeck, s: number): number {
  const f = Math.max(0, Math.min(d.curve.n - 1.000001, s / RAIL.step));
  const i = Math.floor(f);
  return d.top[i] + (d.top[i + 1] - d.top[i]) * (f - i);
}

/** Deck underside (m) at s. */
export function deckUnderAt(d: HighwayDeck, s: number): number {
  const f = Math.max(0, Math.min(d.curve.n - 1.000001, s / RAIL.step));
  const i = Math.floor(f);
  return d.under[i] + (d.under[i + 1] - d.under[i]) * (f - i);
}

/** The stretch of the deck widened onto a ramp's lane: from the gore's end to the taper's (s, low to high). */
export function mergeRange(r: HighwayRamp): [number, number] {
  const g = r.sa + r.side * GORE;
  return [Math.min(g, r.sb), Math.max(g, r.sb)];
}

/** Lateral extent of the deck's surface on side `side` (+1 right of +s) at s: its half width, widened over a ramp's merge. */
export function deckExtent(d: HighwayDeck, s: number, side: 1 | -1): number {
  for (const r of d.ramps) {
    if (r.side !== side) continue;
    const [lo, hi] = mergeRange(r);
    if (s >= lo && s <= hi) return HALF + 2 * CFG.rampHalf + 1;
  }
  return HALF;
}

/** Whether the deck's barrier on `side` opens over [s0, s1]: the whole chunk lies in a ramp's merge. */
export function barrierOpen(d: HighwayDeck, s0: number, s1: number, side: 1 | -1): boolean {
  for (const r of d.ramps) {
    if (r.side !== side) continue;
    const [lo, hi] = mergeRange(r);
    if (s0 >= lo && s1 <= hi) return true;
  }
  return false;
}

/** Point at s along the deck, `v` m to the right of travel toward +s. */
export function deckPoint(curve: RailCurve, s: number, v: number, P = curvePoint()): Vec2 {
  sampleCurve(curve, s, P);
  return { x: P.x - P.tz * v, z: P.z + P.tx * v };
}

/** The ramp outline grown by `grow` (m) past its walls: the axis's two edges, the merge along the deck and its taper. */
export function rampOutline(ax: RampAxis, curve: RailCurve, side: number, sa: number, sb: number, grow: number): Vec2[] {
  const P = curvePoint();
  const inner: Vec2[] = [];
  const outer: Vec2[] = [];
  const hw = CFG.rampHalf + grow;
  // The inner side (toward the deck): the left of travel when the deck lies to the left at E.
  sampleCurve(curve, sa, P);
  const innerSign = (P.x - ax.ex) * -ax.tz + (P.z - ax.ez) * ax.tx > 0 ? 1 : -1;
  const nU = Math.max(2, Math.ceil(ax.length / 4));
  for (let k = 0; k <= nU; k++) {
    const q = axisAt(ax, (ax.length * k) / nU);
    inner.push({ x: q.x - q.tz * hw * innerSign, z: q.z + q.tx * hw * innerSign });
    outer.push({ x: q.x + q.tz * hw * innerSign, z: q.z - q.tx * hw * innerSign });
  }
  // Along the merge: the deck's edge to the taper's end, back along the lane's outer edge.
  const off = (s: number, v: number): Vec2 => deckPoint(curve, s, v * side, P);
  const mergeEdge: Vec2[] = [];
  const mergeOuter: Vec2[] = [];
  const n = Math.max(2, Math.ceil(Math.abs(sb - sa) / 6));
  const taperFrom = sb - side * TAPER;
  const full = 2 * CFG.rampHalf + grow;
  for (let k = 0; k <= n; k++) {
    const s = sa + ((sb - sa) * k) / n;
    mergeEdge.push(off(s, HALF - grow));
    const t = side > 0 ? (s - taperFrom) / TAPER : (taperFrom - s) / TAPER;
    mergeOuter.push(off(s, HALF + (t <= 0 ? full : full * (1 - Math.min(1, t))) + grow * Math.min(1, Math.max(0, t))));
  }
  return [...inner, ...mergeEdge.slice(1), ...mergeOuter.reverse().slice(0, -1), ...outer.reverse()];
}

/** Which sign of v (left of travel) the deck lies on at a ramp's top. */
export function rampInnerSign(ramp: HighwayRamp, curve: RailCurve): 1 | -1 {
  const ax = ramp.axis;
  const P = curvePoint();
  sampleCurve(curve, ramp.sa, P);
  return (P.x - ax.ex) * -ax.tz + (P.z - ax.ez) * ax.tx > 0 ? 1 : -1;
}

/** The lane's outer wall from the deck's centerline at s (m): full width over the merge, the taper back, then the deck's edge. */
export function rampOuterAt(ramp: HighwayRamp, s: number): number {
  const taperFrom = ramp.sb - ramp.side * TAPER;
  const t = ramp.side > 0 ? (s - taperFrom) / TAPER : (taperFrom - s) / TAPER;
  const w = 2 * CFG.rampHalf + 0.175;
  return HALF + (t <= 0 ? w : t >= 1 ? -BARRIER_IN : w - (w + BARRIER_IN) * t);
}

/** The stretch of the row street's frontage under the ramp's top, to its block's corner (s along the deck, low to high). */
export function rampFront(ramp: HighwayRamp, curve: RailCurve): [number, number] {
  const sx = frontStart(ramp, curve, rampInnerSign(ramp, curve));
  return [Math.min(sx, ramp.sBlock), Math.max(sx, ramp.sBlock)];
}

/** Where along the deck the ramp's inner edge reaches the street's building line (s, m). */
function frontStart(ramp: HighwayRamp, curve: RailCurve, innerSign: number): number {
  const ax = ramp.axis;
  for (let u = Math.max(0, ax.length - SOLID_TO_END - 10); u <= ax.length; u += 1) {
    const q = axisAt(ax, u);
    const v = innerSign * (CFG.rampHalf + 0.5);
    const p = { x: q.x - q.tz * v, z: q.z + q.tx * v };
    const pr = projectOnCurve(curve, p.x, p.z);
    if (Math.abs(pr.lateral) <= ramp.building + 1.5) return pr.s;
  }
  return ramp.sa;
}

/** The curb cut of a ramp's mouth on its foot street's piece: the block side it opens on and the cut along its curb (busBays.ts mouthBay), or null if it would leave the piece. */
export function mouthCut(g: RoadGraph, mouths: EdgeMouths[], edge: number, ax: RampAxis): { side: 1 | -1; s0: number; s1: number } | null {
  const fe = g.edges[edge];
  const sinA = Math.abs(ax.dx * (g.nodes[fe.b].z - g.nodes[fe.a].z) - ax.dz * (g.nodes[fe.b].x - g.nodes[fe.a].x)) / (fe.length || 1);
  const halfMouth = (CFG.rampHalf + 1) / Math.max(0.3, sinA);
  const sides = edgeSides(g, mouths, edge);
  const side: 1 | -1 = sides[0].inward.x * ax.dx + sides[0].inward.z * ax.dz > 0 ? 1 : -1;
  const sd = sides[side === 1 ? 0 : 1];
  const ux = sd.to.x - sd.from.x;
  const uz = sd.to.z - sd.from.z;
  const ul = sqrt(ux * ux + uz * uz) || 1;
  const sc = ((ax.fx - sd.from.x) * ux + (ax.fz - sd.from.z) * uz) / ul;
  const s0 = sc - halfMouth - MOUTH_TAPER;
  const s1 = sc + halfMouth + MOUTH_TAPER;
  return s0 < 1 || s1 > ul - 1 ? null : { side, s0, s1 };
}

export { HALF as HIGHWAY_HALF, TAPER as RAMP_TAPER, SOLID_TO_END as RAMP_SOLID_TO_END, GORE as RAMP_GORE };
