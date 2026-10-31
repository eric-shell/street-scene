/**
 * Bus bays: some bus stops get a lay-by. For a stretch of one block side the
 * curb steps back into the sidewalk (an S shaped taper at each end, full
 * depth between), so the road widens locally; the shelter stands at the back
 * of the narrower sidewalk and BUS is painted in the bay (render/street/busBays.ts).
 * A bay is a place to dive into to pass a rival or to straighten a kink.
 *
 * A bay lives in its block side's curb frame (props.ts edgeSides): `s` along
 * the curb from the side's start, `v` behind the curb into the sidewalk. The
 * indented curb is v = bayInset(s). Everything that cares agrees through the
 * helpers here: World.surfaceAt (road inside the bay), the curb ramp of
 * World.driveHeightAt (eased across the indented curb like any curb),
 * generateProps (nothing stands in a bay; its shelter waits behind it) and
 * the asphalt, sidewalk, curb and paint meshes. A bay fills the gap between
 * two streetlight stations well away from the junctions, so crosswalks,
 * corners, traffic lights and alley or shortcut mouths (all at the ends of a
 * side) never meet one, and it keeps clear of the El's pillars and stairs
 * (reserved circles), district paving, bridges and lane closures. Pure and
 * deterministic, on its own random stream.
 *
 * The same curb frame cuts the mouths where a district's race path leaves
 * the street (mouthBay, districts/park.ts): kind 'mouth', the curb stepping
 * back the whole sidewalk so the path meets the road at road level, its ends
 * flared into curb returns like a shortcut's mouth (blocks.ts flaredCorner).
 * An edge may carry a bus bay and mouths, on either side.
 */
import type { RoadGraph } from './roadGraph';
import { chainOf, isChannelEdge, isFeatureEdge } from './roadGraph';
import type { EdgeMouths } from './blocks';
import { edgeSides, lightStations } from './props';
import { Rng, deriveSeed } from '../sim/prng';
import type { Vec2 } from '../sim/math';
import { sqrt } from '../sim/math';
import type { AreaBuild, Circle } from './districts/types';
import { pointInPolygon } from './districts/geom';

export const BUS_BAY = {
  /** Chance a long plain street gets a bay on one of its sides. */
  chance: 0.14,
  /** Shortest edge that gets one (m) and the room kept from each end of its block side (m). */
  minEdge: 100,
  endClear: 22,
  /** How far the curb steps back into the sidewalk (m): about a bus wide, leaving room for the shelter. */
  depth: [2.2, 2.5],
  /** Length of each S taper (m). */
  taper: [6.5, 8],
  /** Shortest stretch at full depth (m) and the margin kept inside the streetlight gap at each end (m). */
  minStraight: 12,
  margin: 0.6,
  /** Streetlights stand this far from the gap (m, props.ts POLE_CLEAR). */
  poleClear: 1.5,
  /** Half thickness of the shelter (m): its collision capsule's radius across (Prop.depth). */
  shelterDepth: 0.62,
  /**
   * The bay's road reaches this far out across the original curb line (m), past the curb ramp, so
   * the ramp never rises where the old curb used to be.
   */
  roadReach: 2,
} as const;

export interface BusBay {
  /** Index into CityBlocks.bays. */
  id: number;
  /** 'bus': a lay-by with its stop (S tapers); 'mouth': a district path's curb cut, the whole sidewalk deep (flared tapers, no stop or paint). */
  kind: 'bus' | 'mouth';
  /** Road edge whose curb steps back. */
  edge: number;
  /** 1: the P side of the edge (left of a -> b), -1: the N side. */
  side: 1 | -1;
  /** The side's original curb line: start point, unit direction along it, unit normal toward the road, length (m). */
  from: Vec2;
  u: Vec2;
  inward: Vec2;
  len: number;
  /**
   * Along the curb (m from `from`): the taper runs s0 .. s0 + taper, full depth to s1 - taper, back out to s1.
   * A mouth across a bend node is cut on both pieces of its street, each in its own frame, so s0 or s1
   * may lie past the piece's ends (0 and len): each piece's bay answers only within its piece (bayLo, bayHi).
   */
  s0: number;
  s1: number;
  taper: number;
  /** How far the curb steps back (m); a mouth's a little past the building line (MOUTH_REACH). */
  depth: number;
  /** Outline of the bay's asphalt (original curb, then the indented curb back), counterclockwise or not. */
  polygon: Vec2[];
}

/** Smoothstep, the shape of a bus bay's taper (tangent to the curb at both ends). */
const ease = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * A mouth's curb return: the quadratic from the curb line round to square into the sidewalk (the
 * shortcut mouths' flaredCorner, blocks.ts), with the turn's corner as its control point.
 */
const flare = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const r = 1 - sqrt(1 - t);
  return r * r;
};

/** A bay reaches this far (m) past its piece's ends, so the two halves of a mouth across a bend node cover the wedge between the pieces on the outside of the bend. */
const PIECE_OVERLAP = 1.5;

/** The stretch of the side (m along the curb) a bay answers for: its own, within its piece. */
export const bayLo = (b: BusBay): number => Math.max(b.s0, -PIECE_OVERLAP);
export const bayHi = (b: BusBay): number => Math.min(b.s1, b.len + PIECE_OVERLAP);

/** How far the curb is set back (m) at `s` along the side: 0 outside the bay. */
export function bayInset(b: BusBay, s: number): number {
  if (s <= b.s0 || s >= b.s1) return 0;
  const t = Math.min(s - b.s0, b.s1 - s) / b.taper;
  return b.depth * (b.kind === 'mouth' ? flare(t) : ease(t));
}

/** Curb frame of a point: s along the side's curb, v behind it (into the sidewalk). */
export function bayFrame(b: BusBay, x: number, z: number): { s: number; v: number } {
  const dx = x - b.from.x;
  const dz = z - b.from.z;
  return { s: dx * b.u.x + dz * b.u.z, v: -(dx * b.inward.x + dz * b.inward.z) };
}

/** World point at (s, v) of the bay's curb frame. */
export function bayPoint(b: BusBay, s: number, v: number): Vec2 {
  return { x: b.from.x + b.u.x * s - b.inward.x * v, z: b.from.z + b.u.z * s - b.inward.z * v };
}

/**
 * Distance (m) from (x, z) to the bay's indented curb, measured behind it
 * (negative inside the bay), like the road distance the curb ramp eases on;
 * Infinity off the bay's stretch or on the far side of the road. Within the
 * stretch the road reaches BUS_BAY.roadReach out across the old curb line.
 */
export function bayRoadDistance(b: BusBay, x: number, z: number): number {
  const dx = x - b.from.x;
  const dz = z - b.from.z;
  const s = dx * b.u.x + dz * b.u.z;
  if (s <= bayLo(b) || s >= bayHi(b)) return Infinity;
  const v = -(dx * b.inward.x + dz * b.inward.z);
  if (v < -BUS_BAY.roadReach) return Infinity;
  return v - bayInset(b, s);
}

/** Does a circle (r, plus `margin`) reach into the bay's asphalt? Conservative across the tapers. */
export function bayHitsCircle(b: BusBay, x: number, z: number, r: number, margin = 0.1): boolean {
  const { s, v } = bayFrame(b, x, z);
  if (s <= bayLo(b) - r || s >= bayHi(b) + r || v < -BUS_BAY.roadReach - r) return false;
  const inset = Math.max(bayInset(b, s - r), bayInset(b, s), bayInset(b, s + r));
  return v < inset + r + margin;
}

/** Bays by edge id (a bus bay and any mouths), for the per point lookups. */
export function baysByEdge(bays: readonly BusBay[], edgeCount: number): BusBay[][] {
  const out: BusBay[][] = Array.from({ length: edgeCount }, () => []);
  for (const b of bays) out[b.edge].push(b);
  return out;
}

/** The bays of one edge on one block side (1: the P side), in order along the curb. */
export function sideBays(bays: readonly BusBay[], side: 1 | -1): BusBay[] {
  return bays.filter((b) => b.side === side).sort((p, q) => p.s0 - q.s0);
}

/**
 * Stations (s, ascending) that trace the indented curb: every ~0.8 m along
 * both tapers (a mouth's bunched where its return turns square), which also
 * gives the two ends of the full depth stretch. Within the bay's piece (with
 * its own ends when the bay runs past them) when the piece's length is known.
 */
export function bayCurbStations(b: Pick<BusBay, 's0' | 's1' | 'taper'> & { kind?: BusBay['kind']; len?: number }): number[] {
  const mouth = b.kind === 'mouth';
  const n = Math.max(mouth ? 8 : 2, Math.ceil(b.taper / 0.8));
  // The return's quadratic runs evenly in its own parameter u: s = 2u - u^2 of the taper.
  const at = (i: number) => (mouth ? (i / n) * (2 - i / n) : i / n);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(b.s0 + b.taper * at(i));
  for (let i = 0; i <= n; i++) out.push(b.s1 - b.taper * at(n - i));
  if (b.len === undefined) return out;
  const lo = bayLo(b as BusBay);
  const hi = bayHi(b as BusBay);
  return [...(lo > b.s0 ? [lo] : []), ...out.filter((s) => s >= lo && s <= hi), ...(hi < b.s1 ? [hi] : [])];
}

/** The asphalt outline: the original curb from s0 to s1 (within the piece), then the indented curb back. */
function outline(b: BusBay): Vec2[] {
  const pts: Vec2[] = [bayPoint(b, bayLo(b), 0), bayPoint(b, bayHi(b), 0)];
  const ss = bayCurbStations(b);
  for (let i = ss.length - 2; i >= 1; i--) pts.push(bayPoint(b, ss[i], bayInset(b, ss[i])));
  return pts;
}

/** Edge kinds that can have a bay: the plain streets (no alleys, channel edges or shortcuts). */
const BAY_KINDS = new Set(['street', 'avenue', 'diagonal', 'boulevard']);

/**
 * Pick the bays: at most one per long plain street, on one side, in the
 * streetlight gap nearest the middle of that side. `reserved` are the
 * district structures on sidewalks; `builds` the district builds so far, for
 * their paving (surfaces at sidewalk level or above) and the lane closures
 * (hints of kind 'roadworks', districts/roadworks.ts), whose streets get none.
 */
export function planBusBays(seed: number, g: RoadGraph, mouths: EdgeMouths[], reserved: readonly Circle[], builds: readonly AreaBuild[]): BusBay[] {
  const rng = new Rng(deriveSeed(seed, 'busBays'));
  const C = BUS_BAY;
  const closed = new Set<number>();
  for (const b of builds) for (const h of b.hints) if (h.kind === 'roadworks') closed.add(h.values[0]);
  const paving = builds.flatMap((b) => b.surfaces.filter((s) => s.priority >= 3));
  const bays: BusBay[] = [];
  g.edges.forEach((e, ei) => {
    // A street is a chain of pieces through bend nodes (roadGraph.ts): the length that qualifies it is the street's.
    if (!BAY_KINDS.has(e.kind) || e.shortcut || e.bridge || isChannelEdge(e) || isFeatureEdge(e) || chainOf(g, ei).length < C.minEdge) return;
    // Draw first so the stream does not depend on which edges qualify further down.
    const want = rng.chance(C.chance);
    const first = rng.int(0, 1);
    const depth = rng.range(C.depth[0], C.depth[1]);
    const taper = rng.range(C.taper[0], C.taper[1]);
    if (!want || closed.has(ei)) return;
    const sides = edgeSides(g, mouths, ei);
    for (let k = 0; k < 2; k++) {
      const si = (first + k) % 2;
      const side = sides[si];
      const ax = side.to.x - side.from.x;
      const az = side.to.z - side.from.z;
      const len = sqrt(ax * ax + az * az);
      // The end room belongs to the street's junction ends; at a bend node the piece's end is a free
      // cut (the bay has to lie within one straight piece, as its curb frame is straight).
      const bendStart = side.span.before > 1e-6;
      const bendEnd = side.span.before + len < side.span.total - 1e-6;
      const loEnd = bendStart ? 0 : C.endClear;
      const hiEnd = bendEnd ? len : len - C.endClear;
      if (hiEnd - loEnd < 2 * taper + C.minStraight) continue;
      const u = { x: ax / len, z: az / len };
      // Streetlight gaps away from both ends, the one nearest the middle of the street first.
      const st = lightStations(len, side.phase, side.span);
      const starts = [...(bendStart ? [0] : []), ...st.map((s) => s + C.poleClear + C.margin)];
      const ends = [...st.slice(bendStart ? 0 : 1).map((s) => s - C.poleClear - C.margin), ...(bendEnd ? [len] : [])];
      const middle = side.span.total / 2 - side.span.before;
      let best: { s0: number; s1: number } | null = null;
      let score = Infinity;
      for (let j = 0; j < starts.length && j < ends.length; j++) {
        const s0 = starts[j];
        const s1 = ends[j];
        if (s0 < loEnd || s1 > hiEnd || s1 - s0 < 2 * taper + C.minStraight) continue;
        const sc = Math.abs((s0 + s1) / 2 - middle);
        if (sc < score) {
          score = sc;
          best = { s0, s1 };
        }
      }
      if (!best) continue;
      const bay: BusBay = { id: bays.length, kind: 'bus', edge: ei, side: si === 0 ? 1 : -1, from: { x: side.from.x, z: side.from.z }, u, inward: { x: side.inward.x, z: side.inward.z }, len, s0: best.s0, s1: best.s1, taper, depth, polygon: [] };
      bay.polygon = outline(bay);
      // Nothing of a district's on this stretch of sidewalk: pillars and stairs, paving.
      const clearOfReserved = reserved.every((c) => {
        const f = bayFrame(bay, c.x, c.z);
        return f.s < bay.s0 - c.r - 1 || f.s > bay.s1 + c.r + 1 || f.v > e.sidewalk + c.r + 0.5 || f.v < -c.r - 0.5;
      });
      if (!clearOfReserved) continue;
      const probes: Vec2[] = [];
      for (let s = bay.s0; s <= bay.s1 + 1e-6; s += 3) for (const v of [0.3, depth * 0.6, depth + 0.4, e.sidewalk - 0.3]) probes.push(bayPoint(bay, Math.min(s, bay.s1), v));
      if (probes.some((p) => paving.some((s) => pointInPolygon(p.x, p.z, s.polygon)))) continue;
      bays.push(bay);
      return;
    }
  });
  return bays;
}

/**
 * A mouth's cut reaches this far (m) past the building line, so no sliver of curb is left where the
 * building line kinks at a bend node, nor a curb ramp along the back of the cut.
 */
export const MOUTH_REACH = 0.5;

/**
 * A district path's curb cut (kind 'mouth') on block side `side` (1: the P side) of `edge`: the curb
 * steps back the whole sidewalk between s0 + taper and s1 - taper (m along the side's curb), flaring
 * out over `taper` at each end. The planner (districts/park.ts) keeps it inside the side's straight
 * piece and clear of its junction corners.
 */
export function mouthBay(g: RoadGraph, mouths: EdgeMouths[], id: number, edge: number, side: 1 | -1, s0: number, s1: number, taper: number): BusBay {
  const sd = edgeSides(g, mouths, edge)[side === 1 ? 0 : 1];
  const ax = sd.to.x - sd.from.x;
  const az = sd.to.z - sd.from.z;
  const len = sqrt(ax * ax + az * az) || 1;
  const bay: BusBay = { id, kind: 'mouth', edge, side, from: { x: sd.from.x, z: sd.from.z }, u: { x: ax / len, z: az / len }, inward: { x: sd.inward.x, z: sd.inward.z }, len, s0, s1, taper, depth: g.edges[edge].sidewalk + MOUTH_REACH, polygon: [] };
  bay.polygon = outline(bay);
  return bay;
}
