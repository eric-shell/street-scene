/**
 * The elevated highway as everything downstream reads it (highway.ts plans
 * it): the deck's smoothed line (deckCurve, railCurve.ts's resampling of the
 * planned path) and the deck once settled on the terrain (HighwayDeck: its
 * underside and top per curve sample, its drivable stretch between the end
 * loops, the El crossing, its ramps), a ramp's axis and profile (HighwayRamp:
 * an on- or off-ramp beside the deck, or one of the loops at its ends), and
 * the shared measures: where the deck is widened onto a ramp's lane and its
 * barrier opens, the ramp's outline, its lane's outer wall, the frontage
 * under its top, the curb cut at its mouth, the V where the median ends
 * between an end's loops, the deck's cross section (lanes and shoulders) and
 * the gaps in its median. The build, the settle step, the renderer, the
 * cameras and the resets all read these, so they agree. One object per area
 * (WeakMaps keyed by the area), pure and deterministic.
 */
import { CITY } from '../../config';
import { isBendNode } from '../../roadGraph';
import type { RoadGraph } from '../../roadGraph';
import type { EdgeMouths } from '../../blocks';
import { edgeSides } from '../../props';
import type { Terrain } from '../../terrain';
import { Vec2, sqrt } from '../../../sim/math';
import type { Area } from '../types';
import { RAIL, RailCurve, buildRailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { RampAxis, RampProfile, axisAt, polyAxis } from './rampAxis';

const CFG = CITY.districts.highway;

export const HALF = CFG.deckWidth / 2;

/** Cross section, from the deck's centerline out (m): the first lane's inner edge, and the outer shoulder (what is left of the half width). */
export const LANES_IN = CFG.median / 2 + CFG.innerShoulder;

export const PARAPET = 0.45;

export const OUTER_SHOULDER = HALF - LANES_IN - CFG.lanes * CFG.lane - PARAPET;

/** Center of lane k (0 by the median) from the deck's centerline (m). */
export const laneCenter = (k: number): number => LANES_IN + (k + 0.5) * CFG.lane;

/**
 * Curb to curb width of every street under the deck (m): widened so its building lines stand under
 * the deck's edges (a plain street's sidewalk each side), and cars drive under the deck wherever it goes.
 */
export const UNDER_WIDTH = 2 * (HALF - CITY.sidewalk);

/** Beyond a closure's reach columns keep this margin (m), as the El's (subway.ts CLOSURE_GAP). */
export const CLOSURE_GAP = 3.5;

/** Barrier walls stand this far inside the deck's edge (m): a car's wheels never sample past the span. */
export const BARRIER_IN = 0.45;

/** A ramp's walls: thin two sided slabs this thick (m), just outside its half width. */
export const RAMP_WALL = 0.35;

/** An on-ramp's lane: full width alongside the deck over `merge` m, then a taper back to its edge over `taper` m; an off-ramp's the same way round. */
export const MERGE = CFG.rampMerge;

export const DIVERGE = CFG.rampDiverge;

export const TAPER = CFG.rampTaper;

/**
 * The gore: the ramp's inner wall runs on this far past E along the deck's edge (m), and the deck is
 * widened onto the lane from there to the taper's end; the barrier opens only where a whole chunk lies
 * in that stretch, so there is never a hole between the barrier's end and the ramp's walls.
 */
export const GORE = CFG.rampGore;

/**
 * An end loop's E, across the deck from its centerline (m): its inner wall (the side its turn bends to)
 * runs on from the deck's outer barrier, so the outgoing carriageway's outer edge carries straight on
 * into the loop and the incoming one's straight out of it; the median's barriers fan out over the V to
 * its outer wall.
 */
export const LOOP_AT = HALF - BARRIER_IN - RAMP_WALL / 2 - CFG.loopHalf;

/** The mouth's curb cut flares this much at each end (m). */
export const MOUTH_TAPER = 9;

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

/**
 * railCurve.ts projectOnCurve over only the samples within `reach` m of s0 along the curve: the planners
 * ask it of thousands of points that all lie by one stretch of the deck.
 */
export function projectNear(c: RailCurve, x: number, z: number, s0: number, reach: number): { s: number; lateral: number } {
  const i0 = Math.max(0, Math.floor((s0 - reach) / RAIL.step));
  const i1 = Math.min(c.n - 1, Math.ceil((s0 + reach) / RAIL.step));
  let best = i0;
  let bestD = Infinity;
  for (let i = i0; i <= i1; i++) {
    const d = (c.x[i] - x) ** 2 + (c.z[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const along = (x - c.x[best]) * c.tx[best] + (z - c.z[best]) * c.tz[best];
  return { s: Math.max(0, Math.min(c.length, best * RAIL.step + along)), lateral: ((x - c.x[best]) * -c.tz[best] + (z - c.z[best]) * c.tx[best]) * c.pillarRight };
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
  /** The drivable stretch, between the end loops' E at either end (s along the curve, m). */
  sW: number;
  sE: number;
  /** Where the deck crosses the El (s, m; NaN without), and the hump's half reach there (m). */
  sEl: number;
  /** This deck's ramps: the interchanges' on- and off-ramps and the end loops. */
  ramps: HighwayRamp[];
  settled: boolean;
}

/** A ramp as everything downstream sees it. */
export interface HighwayRamp {
  area: Area;
  axis: RampAxis;
  profile: RampProfile;
  /** The side of the deck it stands on (+1: right of the deck's +s direction). */
  side: 1 | -1;
  /**
   * Which way along the deck (+1: toward +s) its axis runs at E, foot to E, and its lane on from there:
   * the way traffic on its side runs for an on-ramp, the other way for an off-ramp (its traffic runs E
   * to foot), and inward from the deck's end for an end loop.
   */
  along: 1 | -1;
  /** An on-ramp (traffic foot to E: up) or an off-ramp (E to foot: down). */
  on: boolean;
  /** One of the loops at the deck's ends: E in the carriageway where the deck ends, no lane beside it. */
  loop: boolean;
  /** Half width between its walls (m). */
  half: number;
  /** A slip ramp's run along the street at its level, foot first (m; 0 for a loop): its walls start past it. */
  flat: number;
  /** E along the deck (the gore nose, or the deck's end for a loop) and the far end of its lane (s, m; sb = sa for a loop). */
  sa: number;
  sb: number;
  /** The row street's building line from the deck's centerline (m), and where the ramp's block ends along the deck (s, m). */
  building: number;
  sBlock: number;
  /** The embankment (one solid level) ends this far along the axis (m), before the ramp leaves its block; a bridge on from there. */
  uSolid: number;
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
  // A slip ramp's axis is the polyline its area's path holds; a loop's the leg and arc in its params.
  const axis: RampAxis = p.loop === 1 ? { fx: p.fx, fz: p.fz, dx: p.dx, dz: p.dz, a: p.a, cx: p.cx, cz: p.cz, r: p.r, sweep: p.sweep, phi0: p.phi0, ex: p.ex, ez: p.ez, tx: p.tx, tz: p.tz, length: p.length } : polyAxis(area.path);
  const ease = p.loop === 1 ? [CFG.loopEase, CFG.loopEase] : [CFG.slipFootEase, CFG.rampTopEase];
  const profile: RampProfile = { y0: 0, g0: 0, y1: 0, g1: 0, grade: 0, e0: ease[0], e1: ease[1], blend: p.flat + 14, flat: p.flat, ready: false };
  r = {
    area,
    axis,
    profile,
    side: p.side > 0 ? 1 : -1,
    along: p.along > 0 ? 1 : -1,
    on: p.on === 1,
    loop: p.loop === 1,
    half: p.half,
    flat: p.flat,
    sa: p.sa,
    sb: p.sb,
    building: p.building,
    sBlock: p.sBlock,
    uSolid: p.uSolid,
    terrain: null,
  };
  rampShapes.set(area, r);
  return r;
}

/** The deck of a highway area (variant 'deck'), with its ramps (from `areas`), one object per area. */
export function highwayDeck(area: Area, areas: readonly Area[]): HighwayDeck {
  let d = decks.get(area);
  if (d) return d;
  const curve = deckCurve(area);
  const n = curve.n;
  const cross = elCrossings(area.path, areas);
  d = {
    area,
    curve,
    under: new Float64Array(n),
    top: new Float64Array(n),
    sW: area.params.sW,
    sE: area.params.sE,
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

/** A side ramp's lane at full width alongside the deck before its taper (m). */
export const laneLength = (r: { on: boolean }): number => (r.on ? MERGE : DIVERGE);

/** The stretch of the deck widened onto a side ramp's lane: from the gore's end to the taper's (s, low to high); null for a loop. */
export function laneRange(r: HighwayRamp): [number, number] | null {
  if (r.loop) return null;
  const g = r.sa + r.along * GORE;
  return [Math.min(g, r.sb), Math.max(g, r.sb)];
}

/** Lateral extent of the deck's surface on side `side` (+1 right of +s) at s: its half width, widened over a ramp's lane. */
export function deckExtent(d: HighwayDeck, s: number, side: 1 | -1): number {
  for (const r of d.ramps) {
    if (r.side !== side) continue;
    const lane = laneRange(r);
    if (lane && s >= lane[0] && s <= lane[1]) return HALF + 2 * r.half + 1;
  }
  return HALF;
}

/** Whether the deck's barrier on `side` opens over [s0, s1]: the whole chunk lies in a ramp's lane. */
export function barrierOpen(d: HighwayDeck, s0: number, s1: number, side: 1 | -1): boolean {
  for (const r of d.ramps) {
    if (r.side !== side) continue;
    const lane = laneRange(r);
    if (lane && s0 >= lane[0] && s1 <= lane[1]) return true;
  }
  return false;
}

/** Point at s along the deck, `v` m to the right of travel toward +s. */
export function deckPoint(curve: RailCurve, s: number, v: number, P = curvePoint()): Vec2 {
  sampleCurve(curve, s, P);
  return { x: P.x - P.tz * v, z: P.z + P.tx * v };
}

/**
 * The ramp outline grown by `grow` (m) past its walls: the axis's two edges, and for a side ramp its lane
 * along the deck and the taper (`along`: the way the lane runs on from E; sa, sb: E and the lane's end).
 */
export function rampOutline(ax: RampAxis, curve: RailCurve, side: number, along: number, sa: number, sb: number, grow: number, half: number, loop: boolean): Vec2[] {
  const P = curvePoint();
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const hw = half + grow;
  const nU = Math.max(2, Math.ceil(ax.length / 4));
  for (let k = 0; k <= nU; k++) {
    const q = axisAt(ax, (ax.length * k) / nU);
    left.push({ x: q.x - q.tz * hw, z: q.z + q.tx * hw });
    right.push({ x: q.x + q.tz * hw, z: q.z - q.tx * hw });
  }
  if (loop) return [...left, ...right.reverse()];
  // The inner side (toward the deck): the left of travel when the deck lies to the left at E.
  sampleCurve(curve, sa, P);
  const innerSign = (P.x - ax.ex) * -ax.tz + (P.z - ax.ez) * ax.tx > 0 ? 1 : -1;
  const inner = innerSign > 0 ? left : right;
  const outer = innerSign > 0 ? right : left;
  // Along the lane: the deck's edge to the taper's end, back along the lane's outer edge.
  const off = (s: number, v: number): Vec2 => deckPoint(curve, s, v * side, P);
  const laneEdge: Vec2[] = [];
  const laneOuter: Vec2[] = [];
  const n = Math.max(2, Math.ceil(Math.abs(sb - sa) / 6));
  const taperFrom = sb - along * TAPER;
  const full = 2 * half + grow;
  for (let k = 0; k <= n; k++) {
    const s = sa + ((sb - sa) * k) / n;
    laneEdge.push(off(s, HALF - grow));
    const t = (along * (s - taperFrom)) / TAPER;
    laneOuter.push(off(s, HALF + (t <= 0 ? full : full * (1 - Math.min(1, t))) + grow * Math.min(1, Math.max(0, t))));
  }
  return [...inner, ...laneEdge.slice(1), ...laneOuter.reverse().slice(0, -1), ...outer.reverse()];
}

/**
 * An end loop's whole footprint grown by `grow` (m): its band, and the infield it wraps closed off by the
 * chord from E back to where the arc starts, so nothing is planned or built inside the loop either.
 */
export function loopFootprint(ax: RampAxis, half: number, grow: number): Vec2[] {
  const w = half + grow;
  // projectAxis's v: the arc's center lies on the side of the sweep's sign.
  const cs = ax.sweep > 0 ? 1 : -1;
  const at = (u: number, v: number): Vec2 => {
    const q = axisAt(ax, u);
    return { x: q.x - q.tz * v, z: q.z + q.tx * v };
  };
  const out: Vec2[] = [];
  const nU = Math.max(2, Math.ceil(ax.length / 4));
  for (let k = 0; k <= nU; k++) out.push(at((ax.length * k) / nU, -cs * w));
  out.push(at(ax.length, cs * w));
  const nLeg = Math.max(1, Math.ceil(ax.a / 4));
  for (let k = nLeg; k >= 0; k--) out.push(at((ax.a * k) / nLeg, cs * w));
  return out;
}

/** Which sign of v (left of travel, foot to E) the deck's centerline lies on at a ramp's top. */
export function rampInnerSign(ramp: HighwayRamp, curve: RailCurve): 1 | -1 {
  const ax = ramp.axis;
  const P = curvePoint();
  sampleCurve(curve, ramp.sa, P);
  return (P.x - ax.ex) * -ax.tz + (P.z - ax.ez) * ax.tx > 0 ? 1 : -1;
}

/** The lane's outer wall from the deck's centerline at s (m): full width alongside, the taper back, then the deck's edge. */
export function rampOuterAt(ramp: HighwayRamp, s: number): number {
  const taperFrom = ramp.sb - ramp.along * TAPER;
  const t = (ramp.along * (s - taperFrom)) / TAPER;
  const w = 2 * ramp.half + RAMP_WALL / 2;
  return HALF + (t <= 0 ? w : t >= 1 ? -BARRIER_IN : w - (w + BARRIER_IN) * t);
}

/**
 * The stretch of the row street's frontage under a side ramp's bridge stretch in its own block, to the
 * block's corner (s along the deck, low to high), or null when the ramp's inner edge keeps off the
 * building line there (it reaches the deck's edge past the cross street) or for a loop.
 */
export function rampFront(ramp: HighwayRamp, curve: RailCurve): [number, number] | null {
  if (ramp.loop || ramp.flat > 0) return null;
  const sx = frontStart(ramp, curve, rampInnerSign(ramp, curve));
  if (Number.isNaN(sx) || (sx - ramp.sBlock) * ramp.along > -2) return null;
  return [Math.min(sx, ramp.sBlock), Math.max(sx, ramp.sBlock)];
}

/** Where along the deck the ramp's inner edge reaches the street's building line on its bridge stretch (s, m; NaN if it never does). */
function frontStart(ramp: HighwayRamp, curve: RailCurve, innerSign: number): number {
  const ax = ramp.axis;
  for (let u = Math.max(0, ramp.uSolid - 10); u <= ax.length; u += 1) {
    const q = axisAt(ax, u);
    const v = innerSign * (ramp.half + 0.5);
    const p = { x: q.x - q.tz * v, z: q.z + q.tx * v };
    const pr = projectOnCurve(curve, p.x, p.z);
    if (Math.abs(pr.lateral) <= ramp.building + 1.5) return pr.s;
  }
  return NaN;
}

/**
 * Where the median ends at either end of the deck (s, m): the V between the end's loops starts
 * CFG.loopGore before the deck's end, its barriers fanning out to the loops' outer walls.
 */
export const vStart = (d: HighwayDeck, end: -1 | 1): number => (end < 0 ? d.sW + CFG.loopGore : d.sE - CFG.loopGore);

/**
 * The V's barrier on each side at s (m from the centerline, 0 where there is none): from the median's
 * edge where the V starts to the loop's outer wall at the deck's end, eased so it leaves the median's
 * line tangent to it.
 */
export function vGoreAt(d: HighwayDeck, s: number): number {
  const to = LOOP_AT - CFG.loopHalf - RAMP_WALL / 2;
  for (const end of [-1, 1] as const) {
    const t = (end * (s - vStart(d, end))) / CFG.loopGore;
    if (t < -1e-9 || t > 1 + 1e-9) continue;
    const k = Math.min(1, Math.max(0, t));
    return CFG.median / 2 + (to - CFG.median / 2) * k * k;
  }
  return 0;
}

const gaps = new WeakMap<HighwayDeck, [number, number][]>();

/**
 * The median's crossovers (s ranges along the deck, low to high): a gap about every
 * CFG.crossoverEvery m between the end loops' V, nudged along (or left out) to keep crossoverClear from
 * every side ramp's top and lane, so a car can swing round to the other carriageway at speed.
 */
export function medianGaps(d: HighwayDeck): [number, number][] {
  let out = gaps.get(d);
  if (out) return out;
  out = [];
  const half = CFG.crossoverLength / 2;
  const clear = CFG.crossoverClear;
  const lo = vStart(d, -1) + clear;
  const hi = vStart(d, 1) - clear;
  const blocked = (s: number) =>
    s - half < lo ||
    s + half > hi ||
    d.ramps.some((r) => {
      if (r.loop) return false;
      const a = Math.min(r.sa, r.sb) - clear;
      const b = Math.max(r.sa, r.sb) + clear;
      return s + half > a && s - half < b;
    });
  for (let s = lo + CFG.crossoverEvery / 2; s < hi; s += CFG.crossoverEvery) {
    let at = NaN;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const t = s + k * 25;
      if (blocked(t) || out.some(([a, b]) => t - half < b + CFG.crossoverEvery / 2 && t + half > a - CFG.crossoverEvery / 2)) continue;
      at = t;
      break;
    }
    if (!Number.isNaN(at)) out.push([at - half, at + half]);
  }
  gaps.set(d, out);
  return out;
}

/** Whether s lies in one of the median's crossovers (widened by `pad` m each end). */
export function inMedianGap(d: HighwayDeck, s: number, pad = 0): boolean {
  for (const [a, b] of medianGaps(d)) if (s > a - pad && s < b + pad) return true;
  return false;
}

/** A curb cut on one piece of a street: the block side it opens on (1: the P side) and its stretch along that side's curb (m). */
export interface CurbCut {
  edge: number;
  side: 1 | -1;
  s0: number;
  s1: number;
}

/**
 * A curb cut laid from street piece `edge` on through its bend nodes. `span` gives the cut on one piece (and the
 * length of that side's curb); wherever it runs past a piece's end that is a bend node, the next piece gets its
 * part too, each part running past the shared node (busBays.ts PIECE_OVERLAP joins them), as a park path's mouth
 * does. A ramp is longer than most pieces of its street, so its cut usually lies across a bend. Empty when it
 * would run into a junction: no cut, and a car rolls over the curb.
 */
function cutThroughBends(g: RoadGraph, edge: number, span: (ei: number) => CurbCut & { len: number }): CurbCut[] {
  const out: CurbCut[] = [];
  const seen = new Set<number>();
  const visit = (ei: number): boolean => {
    if (seen.has(ei)) return true;
    seen.add(ei);
    const { len, ...cut } = span(ei);
    out.push(cut);
    // A side runs from the curb at the piece's a end to its b end (props.ts edgeSides).
    const e = g.edges[ei];
    for (const [over, node] of [
      [cut.s0 < 1, e.a],
      [cut.s1 > len - 1, e.b],
    ] as const) {
      if (!over) continue;
      if (!isBendNode(g, node)) return false;
      const next = g.nodes[node].edges.find((x) => x !== ei);
      if (next === undefined || !visit(next)) return false;
    }
    return true;
  };
  return visit(edge) ? out : [];
}

/** A side's curb frame: its length and the distance along it (m) of a point's foot. */
function curbFrame(sd: { from: Vec2; to: Vec2 }): { len: number; at: (p: Vec2) => number } {
  const ux = sd.to.x - sd.from.x;
  const uz = sd.to.z - sd.from.z;
  const len = sqrt(ux * ux + uz * uz) || 1;
  return { len, at: (p) => ((p.x - sd.from.x) * ux + (p.z - sd.from.z) * uz) / len };
}

/**
 * The curb cut beside a slip ramp's run along the street (from a to b on the street's building line, the
 * nose's tip to the run's end), from the street's piece `edge` on through its bend nodes, with `taper` m
 * flares (busBays.ts mouthBay).
 */
export function slipCut(g: RoadGraph, mouths: EdgeMouths[], edge: number, a: Vec2, b: Vec2, taper: number): CurbCut[] {
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  return cutThroughBends(g, edge, (ei) => {
    const sides = edgeSides(g, mouths, ei);
    // Which side of the street the run is on, from its centerline: a side's `inward` points from its curb toward
    // the road (bayPoint), so the P side's points across the street to the N side.
    const c = g.nodes[g.edges[ei].a];
    const side: 1 | -1 = sides[0].inward.x * (mid.x - c.x) + sides[0].inward.z * (mid.z - c.z) > 0 ? -1 : 1;
    const { len, at } = curbFrame(sides[side === 1 ? 0 : 1]);
    return { edge: ei, side, s0: Math.min(at(a), at(b)) - taper, s1: Math.max(at(a), at(b)) + taper, len };
  });
}

/** The curb cut of a ramp's mouth (a loop's foot), from its foot street's piece `edge` on through its bend nodes. */
export function mouthCut(g: RoadGraph, mouths: EdgeMouths[], edge: number, ax: RampAxis, half: number): CurbCut[] {
  return cutThroughBends(g, edge, (ei) => {
    const fe = g.edges[ei];
    const sinA = Math.abs(ax.dx * (g.nodes[fe.b].z - g.nodes[fe.a].z) - ax.dz * (g.nodes[fe.b].x - g.nodes[fe.a].x)) / (fe.length || 1);
    const halfMouth = (half + 1) / Math.max(0.3, sinA);
    const sides = edgeSides(g, mouths, ei);
    const side: 1 | -1 = sides[0].inward.x * ax.dx + sides[0].inward.z * ax.dz > 0 ? 1 : -1;
    const { len, at } = curbFrame(sides[side === 1 ? 0 : 1]);
    const sc = at({ x: ax.fx, z: ax.fz });
    return { edge: ei, side, s0: sc - halfMouth - MOUTH_TAPER, s1: sc + halfMouth + MOUTH_TAPER, len };
  });
}

export { HALF as HIGHWAY_HALF };
