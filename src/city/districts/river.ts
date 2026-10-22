/**
 * River: an LA River style concrete flood channel running east-west across
 * the whole map between two street rows, with a gently meandering
 * centerline z = zMid + amp * sin(k x + phase), and a race venue: its floor
 * is part of the road graph and routes dive in and out of it.
 *
 * Cross section (l = z - centerline): flat floor |l| <= floorHalf at -depth,
 * smooth sloped concrete banks up to |l| = top, a fence on top facing the
 * channel. Streets crossing it are bridges at street level (edge.bridge:
 * the terrain stays flat under the deck, its frontage walls become parapets,
 * and a solid bridge body `bridgeBody` m wide on each side, walls 'culvert'
 * facing the channel, keeps channel and deck apart since walls push back
 * cars up to 3 m behind them) except the fords: one or two crossing streets
 * dip through the channel instead, so the floor runs on under them.
 *
 * Entrances (4-6 per seed): a ford is two ramps meeting at a foot node on
 * the centerline, a side ramp is a trench cut from a parallel bank street
 * (a T node split into it) down to its own foot. Every ramp is an edge of
 * kind 'ramp' between its street node and its foot; the feet inside one
 * bridge gap are chained by 'channel' edges along the meander (plus a stub
 * toward each bridge, so a route leaving the channel has something to close
 * off), with intermediate nodes so the chords stay near the true centerline.
 * Ramp trenches have 'trench' retaining walls and a solid plinth either side
 * (its outer faces are walls too) so nobody drives off the edge; the ramp
 * profile has a rounded lip at the top (a crest you launch over) and a hard
 * kink at the floor edge (a landing that bottoms the suspension out).
 *
 * The floor is drivable concrete; a wet 'water' trickle (offroad grip) runs
 * to one side of the racing line; barrels, crates and bags litter the floor
 * edges; the channel ends in tunnel walls ('channelEnd') well outside the
 * city. The renderer (render/districts/river.ts) draws all of it.
 */
import { CITY } from '../config';
import type { RoadGraph, RoadEdge, RoadNode } from '../roadGraph';
import { addEdge, addNode, chains, isBendNode, isRiverEdge, mergeChains, otherNode, splitEdge, warpTerms, warpZ } from '../roadGraph';
import type { WarpTerm } from '../roadGraph';
import { Vec2, cos, distToSegment, segmentT, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { Wall } from '../blocks';
import type { PropKind } from '../props';
import type { Area, DistrictModule, HeightSample } from './types';
import { emptyBuild } from './types';
import { polyWalls, smooth01 } from './geom';

const CFG = CITY.districts.river;

/** Centerline helpers from an area's params. */
/** Param keys of the warp terms a river carries (warpParams), one set per CITY.warp term, so riverCenter builds no strings. */
const WARP_KEYS = CITY.warp.map((_, i) => ({ amp: `warpAmp${i}`, k: `warpK${i}`, phase: `warpPhase${i}` }));

/** The seed's warp terms as river params: the channel runs between two rows of the grid, which sweep with the warp (roadGraph.ts warpZ), so the channel sweeps with them. */
function warpParams(terms: readonly WarpTerm[]): Record<string, number> {
  const out: Record<string, number> = { warpTerms: terms.length };
  terms.forEach((t, i) => {
    out[WARP_KEYS[i].amp] = t.amp;
    out[WARP_KEYS[i].k] = t.k;
    out[WARP_KEYS[i].phase] = t.pz;
  });
  return out;
}

export function riverCenter(p: Record<string, number>, x: number): number {
  let z = p.zMid + p.amp * sin(p.k * x + p.phase);
  const n = p.warpTerms ?? 0;
  for (let i = 0; i < n; i++) z += p[WARP_KEYS[i].amp] * sin(x * p[WARP_KEYS[i].k] + p[WARP_KEYS[i].phase]);
  return z;
}

/** Slope of the centerline, dz/dx at x (the meander's and the warp terms'): what the channel's height field needs for its x gradient. */
export function riverSlope(p: Record<string, number>, x: number): number {
  let s = p.amp * p.k * cos(p.k * x + p.phase);
  const n = p.warpTerms ?? 0;
  for (let i = 0; i < n; i++) s += p[WARP_KEYS[i].amp] * p[WARP_KEYS[i].k] * cos(x * p[WARP_KEYS[i].k] + p[WARP_KEYS[i].phase]);
  return s;
}

/** Width of the channel edges as the route sees them (the floor less the chord margin on each side). */
export function channelWidth(floorHalf = CFG.floorHalf): number {
  return 2 * (floorHalf - CFG.channelMargin);
}

/** An entrance ramp as stored in the area params (see rampsOf). */
export interface Ramp {
  /** Foot: the channel node on the centerline. */
  ax: number;
  az: number;
  /** Unit axis from the foot toward the top (up the bank). */
  ux: number;
  uz: number;
  /** Which bank it climbs: sign of l at the top. */
  side: number;
  /** Trench half width (m) and the plinth width beside it (m). */
  hw: number;
  body: number;
  /** |l| of the top (ground level) and of the street curb line the ramp strip starts at (fords: the top). */
  topL: number;
  curbL: number;
  /** 1 for one half of a ford (a crossing street dipping through), 0 for a side ramp. */
  ford: number;
  /** Graph ids: the ramp edge, its street end node and the foot node. */
  edge: number;
  node: number;
  foot: number;
}

export function rampsOf(area: Area): Ramp[] {
  const p = area.params;
  const out: Ramp[] = [];
  for (let i = 0; i < p.ramps; i++) {
    const r = (k: string) => p[`r${i}${k}`];
    out.push({ ax: r('ax'), az: r('az'), ux: r('ux'), uz: r('uz'), side: r('side'), hw: r('hw'), body: r('body'), topL: r('topL'), curbL: r('curbL'), ford: r('ford'), edge: r('edge'), node: r('node'), foot: r('foot') });
  }
  return out;
}

/**
 * Ramp depth profile: u = 0 at the top, 1 at the floor edge; returns the
 * share of the depth and its derivative. Quadratic ease over the lip, then a
 * constant grade: the top is a rounded crest, the foot a hard kink.
 */
export function rampProfile(u: number): { f: number; df: number } {
  const a = CFG.rampLip;
  const s = 1 / (1 - a / 2);
  if (u <= 0) return { f: 0, df: 0 };
  if (u >= 1) return { f: 1, df: s };
  if (u < a) return { f: (s * u * u) / (2 * a), df: (s * u) / a };
  return { f: s * (u - a / 2), df: s };
}

interface Bridge {
  edge: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  len: number;
  /** Half width to the outer sidewalk line. */
  dk: number;
  /** The deck's half extent along the river's x axis (m): dk over the sine of the crossing angle, wider for an oblique bridge (a diagonal). */
  dkx: number;
  /** x where the edge crosses the centerline. */
  cx: number;
}

/** Parameter along a -> b where the edge crosses l = target, by bisection on l(t). */
function crossingT(p: Record<string, number>, a: Vec2, b: Vec2, target: number): number {
  const lAt = (t: number) => a.z + (b.z - a.z) * t - riverCenter(p, a.x + (b.x - a.x) * t) - target;
  let lo = 0;
  let hi = 1;
  const sLo = lAt(0) < 0;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (lAt(mid) < 0 === sLo) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function bridgesOf(g: RoadGraph, area: Area): Bridge[] {
  const p = area.params;
  return area.edges
    .filter((eid) => g.edges[eid].bridge)
    .map((eid) => {
      const e = g.edges[eid];
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      const t = crossingT(p, a, b, 0);
      const dk = e.width / 2 + e.sidewalk;
      return { edge: eid, ax: a.x, az: a.z, bx: b.x, bz: b.z, dx, dz, nx: -dz, nz: dx, len, dk, dkx: dk / Math.max(0.5, Math.abs(dz)), cx: a.x + (b.x - a.x) * t };
    });
}

/** Point on the bridge's line offset by `off` (along its normal) where l = lTarget. */
function bridgePoint(p: Record<string, number>, br: Bridge, off: number, lTarget: number): Vec2 {
  const ox = br.ax + br.nx * off;
  const oz = br.az + br.nz * off;
  const f = (t: number) => oz + br.dz * t - riverCenter(p, ox + br.dx * t) - lTarget;
  let lo = -40;
  let hi = br.len + 40;
  const sLo = f(lo) < 0;
  for (let i = 0; i < 56; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0 === sLo) lo = mid;
    else hi = mid;
  }
  return { x: ox + br.dx * lo, z: oz + br.dz * lo };
}

/**
 * Distance along a ramp's axis from its foot where |l| reaches `al`, on the
 * line `lat` to the left of the axis (the axis is nearly perpendicular to the
 * channel, so this is close to `al` itself).
 */
export function rampAlong(p: Record<string, number>, r: Ramp, al: number, lat = 0): number {
  const f = (t: number) => {
    const q = rampPoint(r, t, lat);
    return Math.abs(q.z - riverCenter(p, q.x)) - al;
  };
  let lo = 0;
  let hi = al * 1.5 + 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Point of a ramp at distance `along` from its foot, `lat` to the left of the axis. */
export function rampPoint(r: Ramp, along: number, lat: number): Vec2 {
  return { x: r.ax + r.ux * along - r.uz * lat, z: r.az + r.uz * along + r.ux * lat };
}

/** A planned ramp before the graph has nodes for it. */
interface RampPlan {
  ford: boolean;
  /** Centerline crossing x of the foot. */
  x: number;
  side: number;
  hw: number;
  body: number;
  topL: number;
  curbL: number;
  /** Side ramps: the parallel street edge to split and where. Fords: the crossing edge. */
  edge: number;
  t?: number;
  /** Side ramps: the bend node of that street the T takes instead of a split, when one lies within RAMP_SNAP (m). */
  node?: number;
}

/** A side ramp's T node due within this far (m) of a bend node of its street lands on the bend node: a piece a few meters long has no room for the ramp's corners. */
const RAMP_SNAP = 10;

export const riverModule: DistrictModule = {
  kind: 'river',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const g = ctx.graph;
    const F = CFG.floorHalf;
    const T = F + CFG.bankWidth;
    const H = CITY.gridH;
    // The rows sweep with the city's warp (roadGraph.ts): their flat z (the warp's z displacement
    // taken out) places the channel, and riverCenter puts the sweep back in, so the channel keeps
    // its distance from both rows everywhere.
    const warp = warpTerms(ctx.seed);
    const rowZ: number[] = [];
    for (let j = 0; j < H; j++) {
      const ns = g.nodes.filter((n) => n.gj === j);
      rowZ.push(ns.reduce((s, n) => s + n.z - warpZ(warp, n.x), 0) / Math.max(1, ns.length));
    }
    const rows: number[] = [];
    for (let j = 2; j <= H - 4; j++) rows.push(j);
    rng.shuffle(rows);
    const k = (Math.PI * 2) / CFG.wavelength;
    const phase = rng.range(0, Math.PI * 2);
    let params: Record<string, number> | null = null;
    for (const j of rows) {
      for (const amp of [CFG.meander, 0]) {
        const p = { zMid: (rowZ[j] + rowZ[j + 1]) / 2, amp, k, phase, ...warpParams(warp) };
        // Junctions keep clear of the channel; the crossing streets' bend nodes are straightened away below.
        if (g.nodes.every((n) => isBendNode(g, n.id) || Math.abs(n.z - riverCenter(p, n.x)) >= T + 20)) {
          params = p;
          break;
        }
      }
      if (params) break;
    }
    if (!params) return;
    const x0 = g.bounds.minX - 160;
    const x1 = g.bounds.maxX + 160;
    const footprint = (g.bounds.maxX - g.bounds.minX) * 2 * T;
    if (ctx.budget.used + footprint > ctx.budget.total) return;
    // Every street crossing the channel is straightened back into one edge from junction to junction
    // (roadGraph.ts mergeChains): a ford splits it at ramp tops up to rampMaxRun from the channel,
    // past its first bend node. Safe here: the river plans first, so no id is held yet.
    {
      const pc = params;
      const bank = (id: number) => g.nodes[id].z - riverCenter(pc, g.nodes[id].x);
      mergeChains(
        g,
        chains(g).filter((c) => bank(c.nodes[0]) * bank(c.nodes[c.nodes.length - 1]) < 0),
      );
      ctx.graphChanged();
    }
    const p: Record<string, number> = { ...params, floor: F, top: T, depth: CFG.depth, x0, x1, ramps: 0, seed: rng.int(1, 0x7ffffffe) };
    const lOf = (x: number, z: number) => z - riverCenter(p, x);
    const crossing = g.edges.filter((e) => lOf(g.nodes[e.a].x, g.nodes[e.a].z) * lOf(g.nodes[e.b].x, g.nodes[e.b].z) < 0);

    // The racing section: a run of consecutive crossing streets that dip through the channel (fords)
    // between two bridges, so the floor runs on through several blocks; a ford needs a plain, nearly
    // perpendicular street with room on both banks for its ramp run and a stretch of flat street before
    // the junction. Side ramps then fill the gaps of that section until the seed has its entrances.
    const plans: RampPlan[] = [];
    const fordBody = (e: RoadEdge, hw: number) => e.width / 2 + e.sidewalk - hw;
    const crossX = (e: RoadEdge) => {
      const a = g.nodes[e.a];
      return a.x + (g.nodes[e.b].x - a.x) * crossingT(p, a, g.nodes[e.b], 0);
    };
    const sorted = crossing.map((e) => ({ e, cx: crossX(e) })).sort((u, v) => u.cx - v.cx);
    const fordWidth = (e: RoadEdge) => (e.kind === 'avenue' ? CFG.fordHalfWidth + 1 : CFG.fordHalfWidth);
    // Flat street kept before a ford's ramp top at junction n: past the junction's far sidewalk corner
    // (a neighbouring road at angle phi puts it (H + w cos phi) / sin phi along the street, w this
    // street's half corridor, H the neighbour's) plus the room its mouth closure needs.
    const setbackOf = (n: RoadNode, e: RoadEdge): number => {
      const far = g.nodes[otherNode(e, n.id)];
      const len = sqrt((far.x - n.x) ** 2 + (far.z - n.z) ** 2) || 1;
      const ux = (far.x - n.x) / len;
      const uz = (far.z - n.z) / len;
      const w = e.width / 2 + e.sidewalk;
      let corner = 0;
      for (const oid of n.edges) {
        const o = g.edges[oid];
        if (o === e) continue;
        const q = g.nodes[otherNode(o, n.id)];
        const ol = sqrt((q.x - n.x) ** 2 + (q.z - n.z) ** 2) || 1;
        const c = ((q.x - n.x) * ux + (q.z - n.z) * uz) / ol;
        const s = Math.abs((q.x - n.x) * uz - (q.z - n.z) * ux) / ol;
        // A road carrying straight on makes no corner with this one.
        if (s < 0.35) continue;
        corner = Math.max(corner, (o.width / 2 + o.sidewalk + w * c) / s);
      }
      return corner + CFG.fordSetback;
    };
    const fordOk = (e: RoadEdge) => {
      if ((e.kind !== 'street' && e.kind !== 'avenue') || e.shortcut) return false;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      // Nearly square to the channel: the columns sweep with the warp (roadGraph.ts), up to about 20 degrees off.
      if (Math.abs(b.x - a.x) > 0.35 * e.length) return false;
      if (![a, b].every((n) => Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, e) >= CFG.rampMinRun)) return false;
      // No other road (a diagonal leaving the same junction, say) runs through the dip's trench or
      // plinths: no point of another road's corridor inside the ramp's rectangle on either bank.
      const reach = fordWidth(e) + fordBody(e, fordWidth(e)) + CFG.fordClear;
      const len = e.length || 1;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      const tf = crossingT(p, a, b, 0);
      const fx = a.x + (b.x - a.x) * tf;
      const fz = a.z + (b.z - a.z) * tf;
      const runs = [a, b].map((n) => Math.min(CFG.rampMaxRun, Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, e)));
      for (const o of g.edges) {
        if (o === e) continue;
        const oa = g.nodes[o.a];
        const ob = g.nodes[o.b];
        const half = o.width / 2 + o.sidewalk;
        const steps = Math.max(2, Math.ceil(o.length / 3));
        for (let k = 0; k <= steps; k++) {
          const x = oa.x + ((ob.x - oa.x) * k) / steps;
          const z = oa.z + ((ob.z - oa.z) * k) / steps;
          const along = (x - fx) * ux + (z - fz) * uz;
          const lat = -(x - fx) * uz + (z - fz) * ux;
          // Which bank this point is on decides which half's run bounds it.
          const run = along >= 0 ? runs[1] : runs[0];
          if (Math.abs(along) < F + run + half && Math.abs(lat) < reach + half) return false;
        }
      }
      return true;
    };
    let fords: RoadEdge[] = [];
    for (let count = rng.int(CFG.fords[0], CFG.fords[1]); count >= 1 && !fords.length; count--) {
      const windows: number[] = [];
      for (let i = 1; i + count < sorted.length; i++) {
        let ok = true;
        for (let k = 0; k < count && ok; k++) ok = fordOk(sorted[i + k].e);
        if (ok) windows.push(i);
      }
      if (!windows.length) continue;
      const i = windows[rng.int(0, windows.length - 1)];
      fords = sorted.slice(i, i + count).map((c) => c.e);
    }
    for (const e of crossing) if (!fords.includes(e)) e.bridge = true;
    for (const e of fords) {
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const cx = crossX(e);
      const hw = fordWidth(e);
      for (const n of [a, b]) {
        const side = lOf(n.x, n.z) > 0 ? 1 : -1;
        const run = Math.min(CFG.rampMaxRun, Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, e));
        plans.push({ ford: true, x: cx, side, hw, body: fordBody(e, hw), topL: F + run, curbL: F + run, edge: e.id });
      }
    }

    // Side ramps in the gaps of the section (every gap between its crossings, bridges at both ends),
    // alternating banks, down from the nearest parallel street. Without fords any gap will do.
    const hw = CFG.rampHalfWidth;
    const body = CFG.rampBody;
    const minGap = 2 * (CFG.footClear + hw + body + 8);
    let lo = 0;
    let hi = sorted.length - 1;
    if (fords.length) {
      lo = sorted.findIndex((c) => c.e === fords[0]) - 1;
      hi = sorted.findIndex((c) => c.e === fords[fords.length - 1]) + 1;
    }
    // Slots: the middle of every gap wide enough, two slots in gaps wide enough for a stretch between.
    const slotsOf = (i: number): number[] => {
      const w = sorted[i + 1].cx - sorted[i].cx;
      if (w <= minGap) return [];
      if (w > CFG.twoSlotGap) return [sorted[i].cx + w / 3, sorted[i].cx + (2 * w) / 3];
      return [(sorted[i].cx + sorted[i + 1].cx) / 2];
    };
    // Gaps in a random order, every slot of a gap in turn: two ramps in one gap make a stretch of
    // floor between their feet even where no ford joins the gaps up.
    const gaps: number[][] = [];
    for (let i = Math.max(0, lo); i < Math.min(sorted.length - 1, hi); i++) if (slotsOf(i).length) gaps.push(slotsOf(i));
    // Gaps outside the section only when the section cannot seat enough entrances.
    const spare: number[][] = [];
    for (let i = 0; i + 1 < sorted.length; i++) if ((i < lo || i >= hi) && slotsOf(i).length) spare.push(slotsOf(i));
    rng.shuffle(gaps);
    rng.shuffle(spare);
    let side = rng.chance(0.5) ? 1 : -1;
    const want = rng.int(CFG.entrances[0], CFG.entrances[1]);
    const sideRamp = (xr: number, side: number): RampPlan | null => {
      // Street on this bank, parallel to the river, covering the ramp, with its curb far enough from
      // the floor for a legal grade and near enough that the trench fits.
      let best: RoadEdge | null = null;
      let bestL = Infinity;
      let bestFront = 0;
      let bestT = 0;
      for (const e of g.edges) {
        if (e.kind === 'backAlley' || e.bridge || isRiverEdge(e)) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        if (Math.abs(b.x - a.x) < 0.9 * e.length) continue;
        const t = (xr - a.x) / (b.x - a.x);
        if (t < 0 || t > 1) continue;
        // The T node keeps clear of the street's own junctions; a bend node (the street going on
        // through its kink, roadGraph.ts) is none, and a T due within RAMP_SNAP of one takes it.
        if ((!isBendNode(g, e.a) && t * e.length < 18) || (!isBendNode(g, e.b) && (1 - t) * e.length < 18)) continue;
        const la = lOf(a.x, a.z);
        const lb = lOf(b.x, b.z);
        if (la * side <= 0 || lb * side <= 0) continue;
        const zc = a.z + (b.z - a.z) * t;
        const l = Math.abs(zc - riverCenter(p, xr));
        if (l < bestL) {
          bestL = l;
          best = e;
          bestFront = l - (e.width / 2 + e.sidewalk);
          bestT = t;
        }
      }
      if (!best) return null;
      const run = bestFront - 0.5 - F;
      if (run < CFG.rampMinRun || run > CFG.rampMaxRun) return null;
      // Nothing else may cross the trench (a missing row street would make it run on to the next row).
      const z0 = riverCenter(p, xr) + side * F;
      const z1 = riverCenter(p, xr) + side * bestFront;
      const reach = hw + body + 4;
      const crosses = g.edges.some((e) => {
        if (e === best) return false;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        for (let q = 0; q <= 10; q++) {
          const z = z0 + ((z1 - z0) * q) / 10;
          if (distToSegment(xr, z, a.x, a.z, b.x, b.z) < e.width / 2 + e.sidewalk + reach) return true;
        }
        return false;
      });
      if (crosses) return null;
      const along = bestT * best.length;
      const node = isBendNode(g, best.a) && along < RAMP_SNAP ? best.a : isBendNode(g, best.b) && best.length - along < RAMP_SNAP ? best.b : undefined;
      return { ford: false, x: xr, side, hw, body, topL: bestFront - 0.5, curbL: bestFront + best.sidewalk, edge: best.id, t: bestT, node };
    };
    for (const xr of gaps.concat(spare).flat()) {
      if (plans.length >= want) break;
      // The bank it is due on first, the other one if that fails; a facing pair on both banks (one
      // foot, a crossing of its own) where the seed still wants entrances and the river has no ford.
      const plan = sideRamp(xr, side) ?? sideRamp(xr, -side);
      if (!plan) continue;
      plans.push(plan);
      side = -plan.side;
      if (plans.length < want && (!fords.length || rng.chance(0.5))) {
        const facing = sideRamp(xr, -plan.side);
        if (facing) plans.push(facing);
      }
    }
    if (!plans.length) {
      // No entrance fits: keep the channel as scenery (every crossing a bridge).
      for (const e of fords) e.bridge = true;
    }

    // Graph: feet, T nodes, ramp edges; then the channel chains between the feet of each bridge gap.
    const tmp: Area = { id: -1, kind: 'river', variant: '', polygon: [], path: [], nodes: [], edges: [], faces: [], params: p };
    const channelDims = { width: channelWidth(F), lanes: 2 as const, sidewalk: 0 };
    const nodes: number[] = [];
    const edges: number[] = crossing.map((e) => e.id);
    const feet = new Map<number, number>();
    const footAt = (x: number): number => {
      const key = Math.round(x * 100);
      let id = feet.get(key);
      if (id === undefined) {
        id = addNode(g, x, riverCenter(p, x));
        feet.set(key, id);
        nodes.push(id);
      }
      return id;
    };
    // Fords first: split the crossing street at both tops, then the piece between at the foot.
    for (const e of fords) {
      const halves = plans.filter((q) => q.ford && q.edge === e.id);
      if (halves.length !== 2) continue;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const topOf = (q: RampPlan) => crossingT(p, a, b, q.side * q.topL);
      let t1 = topOf(halves[0]);
      let t2 = topOf(halves[1]);
      let first = halves[0];
      let second = halves[1];
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
        [first, second] = [second, first];
      }
      const tf = crossingT(p, a, b, 0);
      const n2 = splitEdge(g, e.id, t2);
      const n1 = splitEdge(g, e.id, t1 / t2);
      const mid = g.edges[g.edges.length - 1];
      const foot = splitEdge(g, mid.id, (tf - t1) / (t2 - t1));
      const dip = [mid, g.edges[g.edges.length - 1]];
      const hwF = first.hw;
      for (const d of dip) {
        d.kind = 'ramp';
        d.width = 2 * hwF;
        d.sidewalk = 0;
        d.lanes = 2;
        delete d.bridge;
      }
      feet.set(Math.round(g.nodes[foot].x * 100), foot);
      nodes.push(foot, n1, n2);
      edges.push(dip[0].id, dip[1].id);
      const F0 = g.nodes[foot];
      for (const [q, node, d] of [
        [first, n1, dip[0]],
        [second, n2, dip[1]],
      ] as [RampPlan, number, RoadEdge][]) {
        const N = g.nodes[node];
        const len = sqrt((N.x - F0.x) ** 2 + (N.z - F0.z) ** 2) || 1;
        pushRamp(p, { ...q, x: F0.x }, F0, { x: (N.x - F0.x) / len, z: (N.z - F0.z) / len }, d.id, node, foot);
      }
    }
    const pieces = new Map<number, number[]>();
    for (const q of plans) {
      if (q.ford) continue;
      const foot = footAt(q.x);
      // The street may already carry another ramp's T node: split whichever piece spans this x.
      const list = pieces.get(q.edge) ?? [q.edge];
      const piece = list.find((eid) => {
        const e = g.edges[eid];
        const xa = g.nodes[e.a].x;
        const xb = g.nodes[e.b].x;
        return q.x >= Math.min(xa, xb) && q.x <= Math.max(xa, xb);
      });
      if (piece === undefined) continue;
      const pe = g.edges[piece];
      const t = (q.x - g.nodes[pe.a].x) / (g.nodes[pe.b].x - g.nodes[pe.a].x);
      // A T due by a bend node of its street takes the bend node (sideRamp); the ramp tilts a little toward it.
      let node: number;
      if (q.node !== undefined && (pe.a === q.node || pe.b === q.node)) node = q.node;
      else {
        node = splitEdge(g, piece, t);
        list.push(g.edges.length - 1);
      }
      pieces.set(q.edge, list);
      const N = g.nodes[node];
      const dims = { width: 2 * q.hw, lanes: 2 as const, sidewalk: 0 };
      const edge = addEdge(g, node, foot, 'ramp', dims);
      nodes.push(node);
      edges.push(edge);
      const Fp = g.nodes[foot];
      const len = sqrt((N.x - Fp.x) ** 2 + (N.z - Fp.z) ** 2) || 1;
      pushRamp(p, q, Fp, { x: (N.x - Fp.x) / len, z: (N.z - Fp.z) / len }, edge, node, foot);
    }
    // Channel chains: feet sorted by x, grouped by the bridge gap they sit in.
    const bridgeXs = bridgesOf(g, { ...tmp, edges }).map((b) => ({ x: b.cx, half: b.dkx + CFG.bridgeBody + 2 }));
    const footList = [...feet.values()].sort((u, v) => g.nodes[u].x - g.nodes[v].x);
    const gapOf = (x: number) => bridgeXs.filter((b) => b.x < x).length;
    const chain = (a: number, b: number) => {
      const A = g.nodes[a];
      const B = g.nodes[b];
      const n = Math.max(1, Math.ceil(Math.abs(B.x - A.x) / CFG.nodeSpacing));
      let prev = a;
      for (let i = 1; i <= n; i++) {
        const x = A.x + ((B.x - A.x) * i) / n;
        const id = i === n ? b : addNode(g, x, riverCenter(p, x));
        if (i < n) nodes.push(id);
        edges.push(addEdge(g, prev, id, 'channel', channelDims));
        prev = id;
      }
    };
    for (let i = 0; i < footList.length; i++) {
      const id = footList[i];
      const x = g.nodes[id].x;
      const gap = gapOf(x);
      const prevFoot = i > 0 && gapOf(g.nodes[footList[i - 1]].x) === gap ? footList[i - 1] : -1;
      const nextFoot = i + 1 < footList.length && gapOf(g.nodes[footList[i + 1]].x) === gap ? footList[i + 1] : -1;
      if (nextFoot >= 0) chain(id, nextFoot);
      // Stubs toward the bridges at both ends of the gap.
      for (const dir of [-1, 1]) {
        if ((dir < 0 && prevFoot >= 0) || (dir > 0 && nextFoot >= 0)) continue;
        const wall = dir < 0 ? bridgeXs.filter((b) => b.x < x).map((b) => b.x + b.half).reduce((m, v) => Math.max(m, v), x0) : bridgeXs.filter((b) => b.x > x).map((b) => b.x - b.half).reduce((m, v) => Math.min(m, v), x1);
        const room = Math.abs(wall - x) - 6;
        // A short stub still gives a closure somewhere to stand; a lone foot always gets at least one.
        if (room < CFG.stubMin) continue;
        const sx = x + dir * Math.min(CFG.stubLength, room);
        const end = addNode(g, sx, riverCenter(p, sx));
        nodes.push(end);
        edges.push(addEdge(g, id, end, 'channel', channelDims));
      }
    }
    if (plans.length) ctx.graphChanged();

    // Footprint: the channel band, bulging out over the ramp trenches (a simple comb polygon).
    const ramps = rampsOf({ id: -1, kind: 'river', variant: '', polygon: [], path: [], nodes, edges, faces: [], params: p });
    const path: Vec2[] = [];
    const up: Vec2[] = [];
    const down: Vec2[] = [];
    const bulge = (x: number, s: number): number => {
      let l = T + 0.5;
      for (const r of ramps) {
        if (r.side !== s) continue;
        const reach = r.hw + r.body + CITY.districts.infill.gap;
        const xTop = r.ax + r.ux * rampAlong(p, r, r.topL);
        if (x >= Math.min(r.ax, xTop) - reach && x <= Math.max(r.ax, xTop) + reach) l = Math.max(l, r.topL + 2);
      }
      return l;
    };
    const xs: number[] = [];
    for (let x = x0; x <= x1 + 1e-6; x += 16) xs.push(x);
    for (const r of ramps) {
      const reach = r.hw + r.body + CITY.districts.infill.gap;
      const xTop = r.ax + r.ux * rampAlong(p, r, r.topL);
      const lo = Math.min(r.ax, xTop) - reach;
      const hi = Math.max(r.ax, xTop) + reach;
      xs.push(lo - 0.01, lo + 0.01, hi - 0.01, hi + 0.01);
    }
    xs.sort((a, b) => a - b);
    for (const x of xs) {
      const z = riverCenter(p, x);
      path.push({ x, z });
      up.push({ x, z: z + bulge(x, 1) });
      down.push({ x, z: z - bulge(x, -1) });
    }
    ctx.addArea({ kind: 'river', variant: 'channel', polygon: up.concat(down.reverse()), path, nodes, edges, faces: [], params: p }, footprint);
  },

  build(ctx, area) {
    const b = emptyBuild();
    const p = area.params;
    const id = area.id;
    const F = p.floor;
    const T = p.top;
    const D = p.depth;
    const body = CFG.bridgeBody;
    const fenceL = T + 0.5;
    const bridges = bridgesOf(ctx.graph, area);
    const ramps = rampsOf(area);
    const zc = (x: number) => riverCenter(p, x);
    const at = (x: number, l: number): Vec2 => ({ x, z: zc(x) + l });
    const band = (xa: number, xb: number, la: number, lb: number, step = 16): Vec2[] => {
      const top: Vec2[] = [];
      const bot: Vec2[] = [];
      const n = Math.max(1, Math.ceil((xb - xa) / step));
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n;
        top.push(at(x, lb));
        bot.push(at(x, la));
      }
      return bot.concat(top.reverse());
    };
    /** Ramp frame: distance along its axis from the foot and lateral offset (left of the axis). */
    const frame = (r: Ramp, x: number, z: number) => ({ along: (x - r.ax) * r.ux + (z - r.az) * r.uz, lat: -(x - r.ax) * r.uz + (z - r.az) * r.ux });

    // Height: channel profile, ramp trenches (the lower of the two wins), flattened under bridge decks.
    let lMax = T + 1;
    for (const r of ramps) lMax = Math.max(lMax, r.topL + 1);
    // The channel sweeps with the rows (riverCenter's warp terms): the box takes in that reach too.
    let sweep = 0;
    for (let i = 0; i < (p.warpTerms ?? 0); i++) sweep += Math.abs(p[WARP_KEYS[i].amp]);
    b.heightMods.push({
      minX: p.x0 - 2,
      maxX: p.x1 + 2,
      minZ: p.zMid - p.amp - sweep - lMax,
      maxZ: p.zMid + p.amp + sweep + lMax,
      add(x, z, out: HeightSample) {
        // The centerline and its slope, meander and warp terms alike (riverCenter / riverSlope).
        const l = z - riverCenter(p, x);
        const sg = l >= 0 ? 1 : -1;
        const al = l * sg;
        let h = 0;
        let gl = 0;
        if (al < T) {
          const st = smooth01(F, T, al);
          h = -D * (1 - st.v);
          gl = D * st.d * sg;
        }
        for (const r of ramps) {
          if (r.side !== sg || al <= F || al >= r.topL) continue;
          const fr = frame(r, x, z);
          if (Math.abs(fr.lat) > r.hw) continue;
          const u = (r.topL - al) / (r.topL - F);
          const pr = rampProfile(u);
          const hr = -D * pr.f;
          if (hr < h) {
            h = hr;
            gl = ((D * pr.df) / (r.topL - F)) * sg;
          }
        }
        if (h === 0) return;
        let gx = -gl * riverSlope(p, x);
        let gz = gl;
        for (const br of bridges) {
          if (Math.abs(x - br.cx) > 90) continue;
          const lim = br.dk + body;
          const d = distToSegment(x, z, br.ax, br.az, br.bx, br.bz);
          if (d >= lim) continue;
          const m = smooth01(br.dk, lim, d);
          const t = segmentT(x, z, br.ax, br.az, br.bx, br.bz);
          const ddx = d > 1e-6 ? (x - (br.ax + (br.bx - br.ax) * t)) / d : 0;
          const ddz = d > 1e-6 ? (z - (br.az + (br.bz - br.az) * t)) / d : 0;
          gx = gx * m.v + h * m.d * ddx;
          gz = gz * m.v + h * m.d * ddz;
          h *= m.v;
        }
        out.h += h;
        out.gx += gx;
        out.gz += gz;
      },
    });

    // No buildings or infill near the channel.
    const clear = T + CFG.clearance;
    for (let x = p.x0; x < p.x1; x += 24) b.exclusions.push(band(x, Math.min(p.x1, x + 24), -clear, clear, 24));
    b.surfaces.push({ surface: 'concrete', polygon: area.polygon, priority: 1, area: id });
    // The trickle outranks the road classification of the channel edges, so it stays slippery; it
    // stops at every bridge body, where the deck road runs over it at street level.
    {
      // Gaps along x where the decks are (an oblique bridge covers more of the strip: dkx).
      const cuts = bridges.map((br) => [br.cx - (br.dkx + body + 2), br.cx + (br.dkx + body + 2)]).sort((u, v) => u[0] - v[0]);
      let x = p.x0;
      for (const [c0, c1] of cuts) {
        if (c0 > x + 2) b.surfaces.push({ surface: 'water', polygon: band(x, c0, CFG.waterOffset - CFG.waterHalf, CFG.waterOffset + CFG.waterHalf), priority: 6, area: id });
        x = Math.max(x, c1);
      }
      if (x < p.x1 - 2) b.surfaces.push({ surface: 'water', polygon: band(x, p.x1, CFG.waterOffset - CFG.waterHalf, CFG.waterOffset + CFG.waterHalf), priority: 6, area: id });
    }

    // Bridges: culvert faces of the solid bridge body, parapet looks on the deck sides.
    const gapsBySide: Record<number, [number, number][]> = { 1: [], [-1]: [] };
    for (const br of bridges) {
      const qs: Record<number, Vec2[]> = {};
      for (const s of [-1, 1]) {
        const off = s * (br.dk + body);
        const q0 = bridgePoint(p, br, off, -fenceL);
        const q1 = bridgePoint(p, br, off, fenceL);
        qs[s] = [q0, q1];
        const w: Wall = { ax: q0.x, az: q0.z, bx: q1.x, bz: q1.z, nx: br.nx * s, nz: br.nz * s, kind: 'wall', look: 'culvert', area: id };
        b.walls.push(w);
      }
      for (const fs of [-1, 1]) {
        const xa = qs[-1][fs > 0 ? 1 : 0].x;
        const xb = qs[1][fs > 0 ? 1 : 0].x;
        gapsBySide[fs].push([Math.min(xa, xb), Math.max(xa, xb)]);
      }
      const o = br.dk + body + 0.5;
      b.frontLooks.push({
        polygon: [bridgePoint(p, br, -o, -fenceL - 1), bridgePoint(p, br, o, -fenceL - 1), bridgePoint(p, br, o, fenceL + 1), bridgePoint(p, br, -o, fenceL + 1)],
        look: 'parapet',
        area: id,
      });
      b.hints.push({ kind: 'bridge', points: [qs[-1][0], qs[1][0], qs[1][1], qs[-1][1]], values: [br.edge, br.dk] });
    }

    // Ramps: trench walls, a solid plinth either side (outer face, foot and top caps), a drivable
    // concrete surface, buildings kept out, the street frontage opened at a side ramp's mouth.
    for (const r of ramps) {
      const s = r.side;
      const aF = rampAlong(p, r, F);
      const aTop = rampAlong(p, r, r.topL);
      const aFence = rampAlong(p, r, fenceL);
      const P = (along: number, lat: number) => rampPoint(r, along, lat);
      const wall = (a: Vec2, c: Vec2, nx: number, nz: number) => b.walls.push({ ax: a.x, az: a.z, bx: c.x, bz: c.z, nx, nz, kind: 'wall', look: 'trench', area: id });
      // Left of the axis is (-uz, ux).
      const lx = -r.uz;
      const lz = r.ux;
      for (const sd of [1, -1]) {
        const inner = sd * r.hw;
        const outer = sd * (r.hw + r.body);
        // Each face starts where its own line reaches the floor edge (a skewed axis puts them at
        // different distances along it), so no wall pokes into the channel edge's corridor.
        const fIn = rampAlong(p, r, F, inner);
        const fOut = rampAlong(p, r, F, outer);
        // Inner trench face, normal into the trench; plinth outer face, normal away from it.
        wall(P(fIn, inner), P(aTop, inner), -sd * lx, -sd * lz);
        wall(P(fOut, outer), P(aTop, outer), sd * lx, sd * lz);
        // Plinth caps: at the floor edge facing the floor, at the top facing the street.
        wall(P(fIn, inner), P(fOut, outer), -r.ux, -r.uz);
        wall(P(aTop, inner), P(aTop, outer), r.ux, r.uz);
      }
      const gx = r.ax + r.ux * aFence;
      gapsBySide[s].push([gx - (r.hw + r.body) - 0.3, gx + (r.hw + r.body) + 0.3]);
      const trench = [P(aF - 0.5, -r.hw), P(aF - 0.5, r.hw), P(r.ford ? aTop : rampAlong(p, r, r.curbL), r.hw), P(r.ford ? aTop : rampAlong(p, r, r.curbL), -r.hw)];
      b.surfaces.push({ surface: 'concrete', polygon: trench, priority: 2, area: id });
      const m = CITY.districts.infill.gap;
      const reach = r.hw + r.body + m;
      b.exclusions.push([P(aF - 2, -reach), P(aF - 2, reach), P(aTop + 2, reach), P(aTop + 2, -reach)]);
      if (!r.ford) {
        // The bank street's frontage line crosses the trench mouth and the plinth tops: no wall there.
        const w = r.hw + r.body + 0.1;
        b.openings.push([P(aTop - 2, -w), P(aTop - 2, w), P(aTop + 1.5, w), P(aTop + 1.5, -w)]);
      }
      b.hints.push({ kind: 'ramp', points: [P(0, 0), P(aTop, 0)], values: [s, r.hw, r.body, aF, aTop, r.ford, aFence, r.ford ? aTop : rampAlong(p, r, r.curbL)] });
    }

    // Bank top fences between bridges and ramps, normals toward the channel.
    for (const s of [-1, 1]) {
      const gaps = gapsBySide[s].sort((u, v) => u[0] - v[0]);
      let x = p.x0;
      const pieces: [number, number][] = [];
      for (const [g0, g1] of gaps) {
        if (g0 > x) pieces.push([x, g0]);
        x = Math.max(x, g1);
      }
      if (x < p.x1) pieces.push([x, p.x1]);
      for (const [u0, u1] of pieces) {
        const pts: Vec2[] = [];
        const n = Math.max(1, Math.ceil((u1 - u0) / 8));
        for (let i = 0; i <= n; i++) pts.push(at(u0 + ((u1 - u0) * i) / n, s * fenceL));
        // Travelling +x: the channel is on the right for the north (+l) fence.
        b.walls.push(...polyWalls(pts, s > 0, 'fence', id, false));
        b.hints.push({ kind: 'fence', points: pts, values: [s] });
      }
    }
    // Tunnel walls at both ends of the channel.
    b.walls.push({ ax: p.x0, az: zc(p.x0) - fenceL, bx: p.x0, bz: zc(p.x0) + fenceL, nx: 1, nz: 0, kind: 'wall', look: 'channelEnd', area: id });
    b.walls.push({ ax: p.x1, az: zc(p.x1) - fenceL, bx: p.x1, bz: zc(p.x1) + fenceL, nx: -1, nz: 0, kind: 'wall', look: 'channelEnd', area: id });

    // Clutter along the floor edges, clear of feet (closures and meets stand there) and bridge bodies.
    const rng = new Rng(p.seed >>> 0 || 1);
    const busy = (x: number) => ramps.some((r) => Math.abs(x - r.ax) < r.hw + r.body + 14) || bridges.some((br) => Math.abs(x - br.cx) < br.dkx + body + 8);
    const kinds: PropKind[] = ['barrel', 'barrel', 'crate', 'trashBags', 'trashBags'];
    for (let x = p.x0 + 40; x < p.x1 - 40; x += CFG.clutterSpacing * rng.range(0.6, 1.4)) {
      if (busy(x)) continue;
      const s = rng.chance(0.5) ? 1 : -1;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const px = x + rng.range(-2.5, 2.5);
        // Right at the floor edge: an obstacle for a car hugging the bank, like back alley clutter.
        const l = s * (F - 0.75 - rng.range(0, 0.6));
        b.destructibles.push({ kind: kinds[rng.int(0, kinds.length - 1)], x: px, z: zc(px) + l, yaw: rng.range(0, Math.PI * 2), lift: 0, area: id });
      }
    }
    return b;
  },
};

/** Record a ramp in the area params (see rampsOf). */
function pushRamp(p: Record<string, number>, q: RampPlan, foot: Vec2, u: Vec2, edge: number, node: number, footId: number): void {
  const i = p.ramps++;
  const set = (k: string, v: number) => (p[`r${i}${k}`] = v);
  set('ax', foot.x);
  set('az', foot.z);
  set('ux', u.x);
  set('uz', u.z);
  set('side', q.side);
  set('hw', q.hw);
  set('body', q.body);
  set('topL', q.topL);
  set('curbL', q.curbL);
  set('ford', q.ford ? 1 : 0);
  set('edge', edge);
  set('node', node);
  set('foot', footId);
}

/** True for a node of the channel floor (a ramp foot or a point along the chain). */
export function isChannelNode(g: RoadGraph, id: number): boolean {
  return g.nodes[id].edges.some((eid) => g.edges[eid].kind === 'channel');
}

/** True for a node touching the channel floor or a ramp (its sectors are open ground the river draws). */
export function isRiverNode(g: RoadGraph, id: number): boolean {
  return g.nodes[id].edges.some((eid) => isRiverEdge(g.edges[eid]));
}
