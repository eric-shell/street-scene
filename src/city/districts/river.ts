/**
 * River: an LA River style concrete flood channel running east-west across
 * the whole map between two street rows, and a race venue end to end: its
 * floor is one chain of 'channel' edges in the road graph from one tunnel
 * portal to the other, routes dive in anywhere along it and run its length,
 * under every bridge.
 *
 * Centerline: the midline between the two bank rows, sampled column by
 * column from the grid nodes (so it follows a warped grid) and smoothed, plus
 * a slow meander whose amplitude swells and fades along the length; stored
 * as samples in the area params (riverCenter / riverSlope interpolate them),
 * the swing scaled down until every junction clears the band. Nothing here
 * assumes rows are straight or that one edge joins two grid nodes: a
 * crossing street is any edge whose segment crosses the centerline, followed
 * through degree-2 bend nodes into a deck polyline.
 *
 * Cross section (l = z - centerline): flat floor |l| <= floorHalf at -depth,
 * smooth sloped concrete banks up to |l| = top, a fence on top facing the
 * channel. Crossing streets are bridges (edge.bridge) except the fords, which
 * dip through. A bridge is two drivable levels: the terrain under the deck
 * stays at street level (the deck, what the road mesh drapes on and what
 * every height query without a car height returns) and the channel profile
 * runs on beneath it as a DeckSpan the world's height queries return for a
 * car body nearer the floor than the deck. The deck's parapets carry a
 * `bottom` (channel cars pass under them); the piers on the channel floor
 * edges and the abutment boxes on the banks are solids with a `top` (deck
 * cars pass over them), set by settleRiver once the terrain exists.
 *
 * Entrances (6-8 per seed, at least one in every quarter of the length, the
 * outer quarters served first, banks alternating): a ford is two ramps
 * meeting at a foot node on the centerline, a side ramp a trench cut from a
 * bank street (a T node split into it) down to its own foot. Every ramp is an
 * edge of kind 'ramp' between its street node and its foot, every foot a node
 * of the channel chain. Ramp trenches have 'trench' retaining walls and a
 * solid plinth either side; the profile has a rounded lip at the top (a crest
 * you launch over) and a hard kink at the floor edge. A ford dips the whole
 * road, its plinths on the sidewalks. Every trench opens into a bell at its
 * foot (the plinth corners chamfered for a car swinging in off the floor) and
 * a side ramp's into a bell mouth over the last stretch of its run as well
 * (rampHalf), as wide as the room to the next street on each side allows, so
 * the plinths meet the street with angled faces instead of square caps. Every ramp top
 * gets the shortcut treatment: fences and clutter funnelling into the mouth
 * (a side ramp's on the sidewalk, the bank street's lanes left clear, its
 * street furniture kept out) and string lights across it, never a sign.
 *
 * The floor is drivable concrete; a wet 'water' trickle (offroad grip) runs
 * to one side of the racing line; barrels, crates and bags litter the floor
 * edges; the channel ends in tunnel walls ('channelEnd') well outside the
 * city. The renderer (render/districts/river.ts) draws all of it.
 */
import { CITY } from '../config';
import type { RoadGraph, RoadEdge, RoadNode } from '../roadGraph';
import { addEdge, addNode, chainOf as streetChain, chains as streetChains, isRiverEdge, mergeChains, otherNode, splitEdge } from '../roadGraph';
import { Vec2, distToSegment, segmentT, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { PropKind } from '../props';
import type { Area, AreaBuild, DistrictModule, HeightSample } from './types';
import { emptyBuild } from './types';
import { distToPath, polyWalls, smooth01, type Smooth, solidWalls } from './geom';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

const CFG = CITY.districts.river;

/** Street kinds that may cross the channel (alleys and shortcuts are planned later and never do). */
const STREET_KINDS = new Set<RoadEdge['kind']>(['street', 'avenue', 'boulevard', 'diagonal']);
/** A deck polyline is followed through bend nodes until this far beyond the band's top edge (m). */
const DECK_REACH = 8;
/** The parapets, deck openings and span footprints reach this far beyond the band's top edge (m). */
const DECK_END = 2.5;
/** Straight pieces of a side ramp's bell mouth and of every trench's foot bell, each side. */
const MOUTH_STEPS = 8;
const FOOT_STEPS = 5;
/** A bell mouth's plinth keeps this far (m) inside the room to the next corridor; the room is capped at MOUTH_ROOM (m). */
const MOUTH_MARGIN = 2;
const MOUTH_ROOM = 40;

/** Where a side ramp's bell mouth is sampled along its axis (m from the foot), up to the top; none for a ford. */
export function mouthAlongs(r: Ramp, aTop: number): number[] {
  if (!r.flareL && !r.flareR) return [aTop];
  const out: number[] = [];
  for (let k = 0; k <= MOUTH_STEPS; k++) out.push(aTop - CFG.mouthLength + (CFG.mouthLength * k) / MOUTH_STEPS);
  return out;
}

/** Where a trench's foot bell is sampled along its axis (m from the foot): from just above the floor edge to where the straight trench begins. */
export function footAlongs(r: Ramp): number[] {
  const out: number[] = [];
  for (let k = 1; k <= FOOT_STEPS; k++) out.push(r.aFloor + (CFG.footLength * k) / FOOT_STEPS);
  return out;
}

// ---------------------------------------------------------------------------
// Centerline

const samplesCache = new WeakMap<Record<string, number>, Float64Array>();

/** The centerline samples of an area's params (c0..c{cn-1}, every cdx m from cx0), cached per params object. */
function samplesOf(p: Record<string, number>): Float64Array {
  let s = samplesCache.get(p);
  if (!s) {
    const n = p.cn;
    s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = p[`c${i}`];
    samplesCache.set(p, s);
  }
  return s;
}

/** Centerline z at x: uniform Catmull-Rom through the samples (C1), flat beyond the ends. */
export function riverCenter(p: Record<string, number>, x: number): number {
  const s = samplesOf(p);
  const n = s.length;
  const u = (x - p.cx0) / p.cdx;
  if (u <= 0) return s[0];
  if (u >= n - 1) return s[n - 1];
  const k = Math.floor(u);
  const t = u - k;
  const y0 = s[Math.max(0, k - 1)];
  const y1 = s[k];
  const y2 = s[Math.min(n - 1, k + 1)];
  const y3 = s[Math.min(n - 1, k + 2)];
  return 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t * t + (-y0 + 3 * y1 - 3 * y2 + y3) * t * t * t);
}

/** dz/dx of the centerline at x. */
export function riverSlope(p: Record<string, number>, x: number): number {
  const s = samplesOf(p);
  const n = s.length;
  const u = (x - p.cx0) / p.cdx;
  if (u <= 0 || u >= n - 1) return 0;
  const k = Math.floor(u);
  const t = u - k;
  const y0 = s[Math.max(0, k - 1)];
  const y1 = s[k];
  const y2 = s[Math.min(n - 1, k + 1)];
  const y3 = s[Math.min(n - 1, k + 2)];
  return (0.5 * (-y0 + y2 + 2 * (2 * y0 - 5 * y1 + 4 * y2 - y3) * t + 3 * (-y0 + 3 * y1 - 3 * y2 + y3) * t * t)) / p.cdx;
}

/** Signed distance across the channel (z above the centerline at the point's x; the meander is gentle, so this is close to the true normal distance). */
export function riverL(p: Record<string, number>, x: number, z: number): number {
  return z - riverCenter(p, x);
}

/** Unit tangent (toward +x) and normal (toward +l) of the centerline at x. */
export function riverFrame(p: Record<string, number>, x: number): { tx: number; tz: number; mx: number; mz: number } {
  const s = riverSlope(p, x);
  const tl = sqrt(1 + s * s);
  const tx = 1 / tl;
  const tz = s / tl;
  return { tx, tz, mx: -tz, mz: tx };
}

/** Width of the channel edges as the route sees them (the floor less the chord margin on each side). */
export function channelWidth(floorHalf = CFG.floorHalf): number {
  return 2 * (floorHalf - CFG.channelMargin);
}

// ---------------------------------------------------------------------------
// Ramps

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
  /** Distance along the axis from the foot to the top (m), and to the floor edge (m). */
  aTop: number;
  aFloor: number;
  /** How far the trench widens at the top on its left (+lat) and right side (m): a side ramp's bell mouth, 0 for a ford. */
  flareL: number;
  flareR: number;
  /** Room along the bank street from the axis to the next corridor, left and right (m; 0 for a ford). */
  roomL: number;
  roomR: number;
}

export function rampsOf(area: Area): Ramp[] {
  const p = area.params;
  const out: Ramp[] = [];
  for (let i = 0; i < p.ramps; i++) {
    const r = (k: string) => p[`r${i}${k}`];
    const ramp: Ramp = { ax: r('ax'), az: r('az'), ux: r('ux'), uz: r('uz'), side: r('side'), hw: r('hw'), body: r('body'), topL: r('topL'), curbL: r('curbL'), ford: r('ford'), edge: r('edge'), node: r('node'), foot: r('foot'), aTop: 0, aFloor: 0, flareL: r('flL'), flareR: r('flR'), roomL: r('rmL'), roomR: r('rmR') };
    ramp.aTop = rampAlong(p, ramp, ramp.topL);
    ramp.aFloor = rampAlong(p, ramp, p.floor);
    out.push(ramp);
  }
  return out;
}

/**
 * Trench half width (m) on side `sd` (1 left of the axis, -1 right) at
 * `along` from the foot: the foot bell (footFlare at the floor edge, easing
 * back quadratically over footLength so it is tangent to the straight trench
 * above), hw up the run, then a side ramp's bell mouth over the last
 * CFG.mouthLength before the top, easing out (quadratic again) by that
 * side's flare. Held at the mouth's width past the top, across the sidewalk.
 */
export function rampHalf(r: Ramp, along: number, sd: number): number {
  const f = 1 - Math.min(1, Math.max(0, (along - r.aFloor) / CFG.footLength));
  let w = r.hw + CFG.footFlare * f * f;
  const flare = sd > 0 ? r.flareL : r.flareR;
  if (flare) {
    const t = Math.min(1, Math.max(0, (along - (r.aTop - CFG.mouthLength)) / CFG.mouthLength));
    w += flare * t * t;
  }
  return w;
}

/** The plinth's outer face on side `sd` at `along` (m from the axis): body wide, thinning to CFG.mouthBody where the bell mouth eats into it, pushed out with it beyond. */
export function rampOuter(r: Ramp, along: number, sd: number): number {
  return Math.max(r.hw + r.body, rampHalf(r, along, sd) + CFG.mouthBody);
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
  /** Side ramps: the bank street edge to split (where the ramp's axis meets it). Fords: the crossing edge. */
  edge: number;
  hit?: Vec2;
}

// ---------------------------------------------------------------------------
// Bridges

/** A bridge: one street through the band, its deck polyline and frame at the crossing. */
export interface Bridge {
  /** Its edges, the one whose segment crosses the centerline first (the drawbridge and hints name a bridge by it). */
  edge: number;
  edges: number[];
  /** Deck polyline, node to node, running toward +l, reaching DECK_REACH beyond the band on both banks (or the next junction). */
  pts: Vec2[];
  /** Half width to the outer sidewalk line (m). */
  dk: number;
  /** Where the polyline crosses the centerline, the unit axis along it there (toward +l) and its left normal. */
  cx: number;
  cz: number;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
}

/** Parameter along a -> b where the segment crosses l = target, by bisection on l(t). */
function crossingT(p: Record<string, number>, a: Vec2, b: Vec2, target: number): number {
  const lAt = (t: number) => riverL(p, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) - target;
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

/** True when the segment a -> b crosses the centerline. */
const crosses = (p: Record<string, number>, a: Vec2, b: Vec2): boolean => riverL(p, a.x, a.z) * riverL(p, b.x, b.z) < 0;

/**
 * The street through the band that edge `e` (crossing the centerline) is part
 * of: followed through degree-2 nodes on both sides until the node lies
 * DECK_REACH beyond the band or is a junction. `allowed` limits the walk to
 * some edges (an area's). Null when a bend leads onto a road of another kind.
 */
function chainOf(g: RoadGraph, p: Record<string, number>, e: RoadEdge, allowed?: Set<number>): { edges: RoadEdge[]; nodes: number[] } | null {
  const T = p.top;
  const edges: RoadEdge[] = [e];
  const nodes: number[] = [e.a, e.b];
  for (const end of [0, 1]) {
    let cur = e;
    let node = end === 0 ? e.a : e.b;
    for (let guard = 0; guard < 8; guard++) {
      const n = g.nodes[node];
      if (n.edges.length !== 2 || Math.abs(riverL(p, n.x, n.z)) >= T + DECK_REACH) break;
      const nextId = n.edges[0] === cur.id ? n.edges[1] : n.edges[0];
      if (allowed && !allowed.has(nextId)) break;
      const next = g.edges[nextId];
      if (!STREET_KINDS.has(next.kind) || next.shortcut || isRiverEdge(next)) return null;
      const far = otherNode(next, node);
      if (end === 0) {
        edges.unshift(next);
        nodes.unshift(far);
      } else {
        edges.push(next);
        nodes.push(far);
      }
      cur = next;
      node = far;
    }
  }
  return { edges, nodes };
}

function makeBridge(g: RoadGraph, p: Record<string, number>, e: RoadEdge, chain: { edges: RoadEdge[]; nodes: number[] }): Bridge {
  let pts = chain.nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
  // Toward +l.
  if (riverL(p, pts[0].x, pts[0].z) > 0) pts = pts.reverse();
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const t = crossingT(p, a, b, 0);
  const cx = a.x + (b.x - a.x) * t;
  const cz = a.z + (b.z - a.z) * t;
  const len = e.length || 1;
  let dx = (b.x - a.x) / len;
  let dz = (b.z - a.z) / len;
  if (riverL(p, b.x, b.z) < 0) {
    dx = -dx;
    dz = -dz;
  }
  return { edge: e.id, edges: chain.edges.map((x) => x.id), pts, dk: e.width / 2 + e.sidewalk, cx, cz, dx, dz, nx: -dz, nz: dx };
}

/** The bridges of a river area, in crossing x order. */
export function bridgesOf(g: RoadGraph, area: Area): Bridge[] {
  const p = area.params;
  const allowed = new Set(area.edges);
  const out: Bridge[] = [];
  for (const eid of area.edges) {
    const e = g.edges[eid];
    if (!e.bridge || !crosses(p, g.nodes[e.a], g.nodes[e.b])) continue;
    const chain = chainOf(g, p, e, allowed) ?? { edges: [e], nodes: [e.a, e.b] };
    out.push(makeBridge(g, p, e, chain));
  }
  return out.sort((u, v) => u.cx - v.cx);
}

/** Distance from a point to a bridge's deck polyline (m). */
export function distToBridge(br: Bridge, x: number, z: number): number {
  return distToPath(br.pts, x, z);
}

/**
 * Point on the deck polyline offset `off` to its left (toward +w) where
 * l = lTarget, by bisection along the offset segments (extended 60 m past
 * both ends, so targets beyond the bank nodes resolve along the end streets).
 */
export function bridgePoint(p: Record<string, number>, br: Bridge, off: number, lTarget: number): Vec2 {
  const pts = br.pts;
  const m = pts.length - 1;
  const at = (i: number, t: number): Vec2 => {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = sqrt(dx * dx + dz * dz) || 1;
    return { x: a.x + dx * t - (dz / len) * off, z: a.z + dz * t + (dx / len) * off };
  };
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    let lo = i === 0 ? -60 / len : 0;
    let hi = i === m - 1 ? 1 + 60 / len : 1;
    const q0 = at(i, lo);
    const q1 = at(i, hi);
    const l0 = riverL(p, q0.x, q0.z) - lTarget;
    const l1 = riverL(p, q1.x, q1.z) - lTarget;
    if (l0 * l1 > 0 && i < m - 1) continue;
    const sLo = l0 < 0;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      const q = at(i, mid);
      if (riverL(p, q.x, q.z) - lTarget < 0 === sLo) lo = mid;
      else hi = mid;
    }
    return at(i, (lo + hi) / 2);
  }
  return at(m - 1, 1);
}

/** The four corners of a bridge's box between |w| <= half and l in [l0, l1] (in that w, l order). */
function deckBox(p: Record<string, number>, br: Bridge, half: number, l0: number, l1: number): Vec2[] {
  return [bridgePoint(p, br, -half, l0), bridgePoint(p, br, half, l0), bridgePoint(p, br, half, l1), bridgePoint(p, br, -half, l1)];
}

/** The deck polyline offset `off`, clipped to l in [l0, l1]: the end points by bisection, the bends between kept. */
function deckLine(p: Record<string, number>, br: Bridge, off: number, l0: number, l1: number): Vec2[] {
  const out: Vec2[] = [bridgePoint(p, br, off, l0)];
  for (let i = 1; i + 1 < br.pts.length; i++) {
    const q = br.pts[i];
    const l = riverL(p, q.x, q.z);
    if (l <= l0 || l >= l1) continue;
    // Offset along the bisector of the two segments at the bend.
    const a = br.pts[i - 1];
    const b = br.pts[i + 1];
    const d0 = { x: q.x - a.x, z: q.z - a.z };
    const d1 = { x: b.x - q.x, z: b.z - q.z };
    const l0n = sqrt(d0.x * d0.x + d0.z * d0.z) || 1;
    const l1n = sqrt(d1.x * d1.x + d1.z * d1.z) || 1;
    const nx = -d0.z / l0n - d1.z / l1n;
    const nz = d0.x / l0n + d1.x / l1n;
    const nl = sqrt(nx * nx + nz * nz) || 1;
    out.push({ x: q.x + (nx / nl) * off, z: q.z + (nz / nl) * off });
  }
  out.push(bridgePoint(p, br, off, l1));
  return out;
}

// ---------------------------------------------------------------------------
// The module

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
    const x0 = g.bounds.minX - 160;
    const x1 = g.bounds.maxX + 160;
    const step = CFG.centerStep;
    const cx0 = x0 - 2 * step;
    const cn = Math.ceil((x1 + 2 * step - cx0) / step) + 1;
    const kM = (Math.PI * 2) / CFG.wavelength;
    const kE = (Math.PI * 2) / CFG.envelope;
    const phase = rng.range(0, Math.PI * 2);
    const phaseE = rng.range(0, Math.PI * 2);
    const rows: number[] = [];
    for (let j = 2; j <= H - 4; j++) rows.push(j);
    rng.shuffle(rows);

    /** The midline between grid rows j and j + 1 as a function of x: column samples, linear between, flat beyond, box smoothed. */
    const midline = (j: number): ((x: number) => number) | null => {
      const byCol = new Map<number, RoadNode[]>();
      for (const n of g.nodes) if (n.gj === j || n.gj === j + 1) (byCol.get(n.gi) ?? byCol.set(n.gi, []).get(n.gi)!).push(n);
      const cols: Vec2[] = [];
      for (const ns of byCol.values()) {
        const a = ns.find((n) => n.gj === j);
        const b = ns.find((n) => n.gj === j + 1);
        if (a && b) cols.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      }
      if (cols.length < 3) return null;
      cols.sort((u, v) => u.x - v.x);
      const raw = (x: number): number => {
        if (x <= cols[0].x) return cols[0].z;
        for (let i = 0; i + 1 < cols.length; i++) {
          if (x <= cols[i + 1].x) {
            const t = (x - cols[i].x) / (cols[i + 1].x - cols[i].x || 1);
            return cols[i].z + (cols[i + 1].z - cols[i].z) * t;
          }
        }
        return cols[cols.length - 1].z;
      };
      const half = CFG.smoothSpan / 2;
      return (x) => {
        let sum = 0;
        let n = 0;
        for (let u = -half; u <= half + 1e-6; u += 8) {
          sum += raw(x + u);
          n++;
        }
        return sum / n;
      };
    };
    /** Junctions clear of the band, every street either crossing it squarely or well away from it. */
    const bandClear = (p: Record<string, number>): boolean => {
      for (const n of g.nodes) if (n.edges.length !== 2 && Math.abs(riverL(p, n.x, n.z)) < T + CFG.junctionClear) return false;
      // The other pieces of a crossing street (cut through bend nodes, roadGraph.ts) run on into the
      // crossing: they are its approach, not a street alongside the band.
      const approach = new Set<number>();
      for (const e of g.edges) if (crosses(p, g.nodes[e.a], g.nodes[e.b])) for (const id of streetChain(g, e.id).edges) approach.add(id);
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        if (crosses(p, a, b)) {
          if (!STREET_KINDS.has(e.kind) || e.shortcut) return false;
          const t = crossingT(p, a, b, 0);
          const fr = riverFrame(p, a.x + (b.x - a.x) * t);
          const len = e.length || 1;
          if (Math.abs(((b.x - a.x) / len) * fr.tx + ((b.z - a.z) / len) * fr.tz) > CFG.maxSkew) return false;
          if (!chainOf(g, p, e)) return false;
        } else if (!approach.has(e.id)) {
          const steps = Math.max(1, Math.ceil(e.length / 8));
          for (let k = 0; k <= steps; k++) {
            const x = a.x + ((b.x - a.x) * k) / steps;
            const z = a.z + ((b.z - a.z) * k) / steps;
            if (Math.abs(riverL(p, x, z)) < T + CFG.streetClear) return false;
          }
        }
      }
      return true;
    };
    const qx0 = g.bounds.minX;
    const qx1 = g.bounds.maxX;
    const quarterOf = (x: number) => Math.max(0, Math.min(3, Math.floor((4 * (x - qx0)) / (qx1 - qx0))));
    /** The entrances a candidate centerline can seat. Pure: the graph is only read; rng is drawn in a fixed order. */
    interface Entrances {
      plans: RampPlan[];
      fords: RoadEdge[];
      chains: Map<number, { edges: RoadEdge[]; nodes: number[] }>;
      crossing: RoadEdge[];
      /** Quarters of the channel's length with an entrance, and the count (a ford is two). */
      quarters: number;
      count: number;
    }
    const planEntrances = (p: Record<string, number>): Entrances => {
      const lOf = (x: number, z: number) => riverL(p, x, z);
      // Crossing streets, each followed through its bends into a deck polyline; all bridges unless a ford.
      const crossing = g.edges.filter((e) => crosses(p, g.nodes[e.a], g.nodes[e.b]));
      const chains = new Map<number, { edges: RoadEdge[]; nodes: number[] }>();
      for (const e of crossing) chains.set(e.id, chainOf(g, p, e)!);
      const crossX = (e: RoadEdge) => {
        const a = g.nodes[e.a];
        return a.x + (g.nodes[e.b].x - a.x) * crossingT(p, a, g.nodes[e.b], 0);
      };
      const sorted = crossing.map((e) => ({ e, cx: crossX(e), dk: e.width / 2 + e.sidewalk })).sort((u, v) => u.cx - v.cx);
      // ----- Fords: a plain, nearly square crossing street in one piece, with room on both banks for its
      // ramp run and a stretch of flat street before each junction, nothing else through its trench.
      const plans: RampPlan[] = [];
      const fordBody = (e: RoadEdge, hw: number) => e.width / 2 + e.sidewalk - hw;
      const fordWidth = (e: RoadEdge) => e.width / 2;
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
        if (chains.get(e.id)!.edges.length !== 1) return false;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        const len = e.length || 1;
        const ux = (b.x - a.x) / len;
        const uz = (b.z - a.z) / len;
        const tf = crossingT(p, a, b, 0);
        const fx = a.x + (b.x - a.x) * tf;
        const fz = a.z + (b.z - a.z) * tf;
        const fr = riverFrame(p, fx);
        if (Math.abs(ux * fr.tx + uz * fr.tz) > 0.25) return false;
        if (![a, b].every((n) => Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, e) >= CFG.rampMinRun)) return false;
        // No other road (a diagonal leaving the same junction, say) runs through the dip's trench or
        // plinths: no point of another road's corridor inside the ramp's rectangle on either bank.
        const reach = fordWidth(e) + fordBody(e, fordWidth(e)) + CFG.fordClear;
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

      // ----- Side ramps: from the foot at channel x, straight up bank `side` along the channel's normal to
      // the first street roughly parallel to the river, with the curb far enough from the floor for a
      // legal grade and near enough that the trench fits, nothing else across the trench.
      const hw = CFG.rampHalfWidth;
      const body = CFG.rampBody;
      const sideRamp = (xr: number, side: number): RampPlan | null => {
        const fr = riverFrame(p, xr);
        const P = { x: xr, z: riverCenter(p, xr) };
        const dx = side * fr.mx;
        const dz = side * fr.mz;
        let best: RoadEdge | null = null;
        let bestU = Infinity;
        let bestHit: Vec2 | null = null;
        for (const e of g.edges) {
          // Never a diagonal: the warp (roadGraph.ts) swings some within the parallel test below, and a
          // trench meeting one obliquely pokes its end into the street.
          if (!STREET_KINDS.has(e.kind) || e.kind === 'diagonal' || e.bridge || e.shortcut || isRiverEdge(e)) continue;
          const a = g.nodes[e.a];
          const b = g.nodes[e.b];
          const sx = b.x - a.x;
          const sz = b.z - a.z;
          const den = dx * sz - dz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const u = ((a.x - P.x) * sz - (a.z - P.z) * sx) / den;
          const v = ((a.x - P.x) * dz - (a.z - P.z) * dx) / den;
          if (u <= 0 || v < 0 || v > 1) continue;
          const len = e.length || 1;
          // The T node keeps clear of the street's own ends, and the street runs along the river.
          if (v * len < 18 || (1 - v) * len < 18) continue;
          if (Math.abs((sx / len) * fr.tx + (sz / len) * fr.tz) < 0.8) continue;
          if (u < bestU) {
            bestU = u;
            best = e;
            bestHit = { x: a.x + sx * v, z: a.z + sz * v };
          }
        }
        if (!best || !bestHit) return null;
        const bestFront = bestU - (best.width / 2 + best.sidewalk);
        const run = bestFront - 0.5 - F;
        if (run < CFG.rampMinRun || run > CFG.rampMaxRun) return null;
        // Nothing else may cross the trench (a missing row street would make it run on to the next row),
        // and no deck box either side of it.
        const reach = hw + body + CFG.rampClear;
        for (let q = 0; q <= 10; q++) {
          const u = F + ((bestFront + best.sidewalk - F) * q) / 10;
          const x = P.x + dx * u;
          const z = P.z + dz * u;
          for (const e of g.edges) {
            if (e === best) continue;
            const a = g.nodes[e.a];
            const b = g.nodes[e.b];
            if (distToSegment(x, z, a.x, a.z, b.x, b.z) < e.width / 2 + e.sidewalk + reach) return null;
          }
        }
        return { ford: false, x: xr, side, hw, body, topL: bestFront - 0.5, curbL: bestFront + best.sidewalk, edge: best.id, hit: bestHit };
      };

      // ----- Entrances by quarter of the channel's length: fords first (each fills its quarter on both
      // banks), then one side ramp in every quarter still empty, the outer quarters first, banks
      // alternating, then more in random quarters up to the seed's count.
      const feetX: number[] = [];
      const spaced = (x: number) => feetX.every((fx) => Math.abs(x - fx) >= CFG.entranceGap) && sorted.every((c) => Math.abs(x - c.cx) >= c.dk + CFG.footClear);
      const want = rng.int(CFG.entrances[0], CFG.entrances[1]);
      const fordCands = sorted.filter((c) => fordOk(c.e));
      rng.shuffle(fordCands);
      const fords: RoadEdge[] = [];
      const fordQuarters = new Set<number>();
      for (let count = rng.int(CFG.fords[0], CFG.fords[1]); count > 0 && fordCands.length; count--) {
        const i = fordCands.findIndex((c) => !fordQuarters.has(quarterOf(c.cx)) && feetX.every((fx) => Math.abs(c.cx - fx) >= CFG.entranceGap));
        if (i < 0) break;
        const c = fordCands.splice(i, 1)[0];
        fords.push(c.e);
        fordQuarters.add(quarterOf(c.cx));
        feetX.push(c.cx);
        const a = g.nodes[c.e.a];
        const b = g.nodes[c.e.b];
        const hwF = fordWidth(c.e);
        for (const n of [a, b]) {
          const side = lOf(n.x, n.z) > 0 ? 1 : -1;
          const run = Math.min(CFG.rampMaxRun, Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, c.e));
          plans.push({ ford: true, x: c.cx, side, hw: hwF, body: fordBody(c.e, hwF), topL: F + run, curbL: F + run, edge: c.e.id });
        }
      }
      const entrances = () => plans.filter((q) => !q.ford).length + fords.length * 2;
      /** Slots of a quarter: channel x positions every 6 m inside it, shuffled. */
      const slotsOf = (q: number): number[] => {
        const qa = qx0 + ((qx1 - qx0) * q) / 4;
        const qb = qa + (qx1 - qx0) / 4;
        const xs: number[] = [];
        for (let x = qa + 12; x <= qb - 12; x += 6) xs.push(x);
        rng.shuffle(xs);
        return xs;
      };
      /** The bank the next entrance is due on: opposite the nearest one along the channel. */
      const dueSide = (x: number): number => {
        let best: RampPlan | null = null;
        for (const q of plans) if (!best || Math.abs(q.x - x) < Math.abs(best.x - x)) best = q;
        return best ? -best.side : rng.chance(0.5) ? 1 : -1;
      };
      const fill = (q: number): boolean => {
        for (const x of slotsOf(q)) {
          if (!spaced(x)) continue;
          const side = dueSide(x);
          const plan = sideRamp(x, side) ?? sideRamp(x, -side);
          if (!plan) continue;
          plans.push(plan);
          feetX.push(x);
          return true;
        }
        return false;
      };
      const filled = new Set<number>(fordQuarters);
      for (const q of [0, 3, 1, 2]) if (!filled.has(q) && fill(q)) filled.add(q);
      const order = [0, 1, 2, 3];
      rng.shuffle(order);
      for (let round = 0; round < 3 && entrances() < want; round++) {
        let any = false;
        for (const q of order) {
          if (entrances() >= want) break;
          if (fill(q)) any = true;
        }
        if (!any) break;
      }

      return { plans, fords, chains, crossing, quarters: new Set(feetX.map(quarterOf)).size, count: entrances() };
    };

    // The first row pair (and meander swing) whose band clears every junction and seats an entrance in
    // every quarter; failing that, the one that comes closest.
    let best: { p: Record<string, number>; ent: Entrances; score: number; row: number } | null = null;
    rowLoop: for (const j of rows) {
      const mid = midline(j);
      if (!mid) continue;
      for (let s = CFG.meanderSteps; s >= 0; s--) {
        const A = (CFG.meander * s) / CFG.meanderSteps;
        const p: Record<string, number> = { cn, cx0, cdx: step, floor: F, top: T, depth: CFG.depth, x0, x1, meander: A, ramps: 0 };
        for (let i = 0; i < cn; i++) {
          const x = cx0 + i * step;
          p[`c${i}`] = mid(x) + A * (0.6 + 0.4 * sin(kE * x + phaseE)) * sin(kM * x + phase);
        }
        if (!bandClear(p)) continue;
        const ent = planEntrances(p);
        const score = ent.quarters * 100 + ent.count;
        if (!best || score > best.score) best = { p, ent, score, row: j };
        if (ent.quarters === 4 && ent.count >= CFG.entrances[0]) break rowLoop;
      }
    }
    if (!best) return;
    const footprint = (g.bounds.maxX - g.bounds.minX) * 2 * T;
    if (ctx.budget.used + footprint > ctx.budget.total) return;
    // Every street over the channel runs straight from bank junction to bank junction, and so does
    // every street of the two bank rows: their pieces through bend nodes (roadGraph.ts) merge back
    // into one edge, so a bridge deck, a ford's ramps, a side ramp's T and the drawbridge each sit on
    // one straight edge. The river plans first, so no district holds an id yet; the entrances are
    // planned again on the merged streets.
    {
      const bp = best.p;
      const row = best.row;
      const bank = (c: { nodes: number[] }) => {
        const A = g.nodes[c.nodes[0]];
        const B = g.nodes[c.nodes[c.nodes.length - 1]];
        return A.gj >= 0 && A.gj === B.gj && (A.gj === row || A.gj === row + 1);
      };
      const over = streetChains(g).filter((c) => c.edges.length > 1 && (bank(c) || c.edges.some((id) => crosses(bp, g.nodes[g.edges[id].a], g.nodes[g.edges[id].b]))));
      if (over.length) {
        mergeChains(g, over);
        ctx.graphChanged();
        best.ent = planEntrances(bp);
      }
    }
    const p = best.p;
    p.seed = rng.int(1, 0x7ffffffe);
    const { plans, chains, crossing } = best.ent;
    let fords = best.ent.fords;
    // No entrance fits: keep the channel as scenery (every crossing a bridge).
    if (!plans.length) fords = [];
    for (const e of crossing) if (!fords.includes(e)) for (const ce of chains.get(e.id)!.edges) ce.bridge = true;

    // ----- Graph: feet, T nodes, ramp edges; then the channel chain from portal to portal through every foot.
    const channelDims = { width: channelWidth(F), lanes: 2 as const, sidewalk: 0 };
    const nodes: number[] = [];
    const edges: number[] = [];
    for (const e of crossing) for (const ce of chains.get(e.id)!.edges) if (ce.bridge) edges.push(ce.id);
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
    for (const q of plans) {
      if (q.ford || !q.hit) continue;
      const foot = footAt(q.x);
      // The street may already carry another ramp's T node: split whichever piece holds the hit point.
      let piece = -1;
      let pieceD = 0.5;
      for (const e of g.edges) {
        if (e.kind !== g.edges[q.edge].kind || isRiverEdge(e)) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        const d = distToSegment(q.hit.x, q.hit.z, a.x, a.z, b.x, b.z);
        if (d < pieceD) {
          pieceD = d;
          piece = e.id;
        }
      }
      if (piece < 0) continue;
      const pe = g.edges[piece];
      const A = g.nodes[pe.a];
      const B = g.nodes[pe.b];
      const node = splitEdge(g, piece, segmentT(q.hit.x, q.hit.z, A.x, A.z, B.x, B.z));
      const N = g.nodes[node];
      const dims = { width: 2 * q.hw, lanes: 2 as const, sidewalk: 0 };
      const edge = addEdge(g, node, foot, 'ramp', dims);
      nodes.push(node);
      edges.push(edge);
      const Fp = g.nodes[foot];
      const len = sqrt((N.x - Fp.x) ** 2 + (N.z - Fp.z) ** 2) || 1;
      pushRamp(p, q, Fp, { x: (N.x - Fp.x) / len, z: (N.z - Fp.z) / len }, edge, node, foot);
    }
    sizeMouths(g, p);
    // The chain: portal to portal through every foot, a node at least every nodeSpacing, none under a deck.
    {
      const tmp: Area = { id: -1, kind: 'river', variant: '', polygon: [], path: [], nodes, edges, faces: [], params: p };
      const bridges = bridgesOf(g, tmp);
      const stations: number[] = [x0 + CFG.endStub, ...[...feet.values()].map((id) => g.nodes[id].x), x1 - CFG.endStub].sort((a, b) => a - b);
      const ends: number[] = [];
      let prev = -1;
      for (let i = 0; i < stations.length; i++) {
        const x = stations[i];
        let id = feet.get(Math.round(x * 100));
        if (id === undefined) {
          id = addNode(g, x, riverCenter(p, x));
          nodes.push(id);
          if (i === 0 || i === stations.length - 1) ends.push(id);
        }
        if (prev >= 0) {
          const xa = g.nodes[prev].x;
          const n = Math.max(1, Math.ceil((x - xa) / CFG.nodeSpacing));
          let last = prev;
          for (let k = 1; k < n; k++) {
            let mx = xa + ((x - xa) * k) / n;
            for (const br of bridges) {
              const keep = br.dk + CFG.bridgeBody + 8;
              if (Math.abs(mx - br.cx) < keep) mx = br.cx + (mx >= br.cx ? keep : -keep);
            }
            if (mx - g.nodes[last].x < 12 || x - mx < 12) continue;
            const mid = addNode(g, mx, riverCenter(p, mx));
            nodes.push(mid);
            edges.push(addEdge(g, last, mid, 'channel', channelDims));
            last = mid;
          }
          edges.push(addEdge(g, last, id, 'channel', channelDims));
        }
        prev = id;
      }
    }
    ctx.graphChanged();

    // Footprint: the channel band, bulging out over the ramp trenches (a simple comb polygon).
    const ramps = rampsOf({ id: -1, kind: 'river', variant: '', polygon: [], path: [], nodes, edges, faces: [], params: p });
    const path: Vec2[] = [];
    const up: Vec2[] = [];
    const down: Vec2[] = [];
    // A ramp's bulge covers its trench, plinths and the funnel at its top (the funnel's props must stand
    // inside the area's polygon).
    // (12 m past the funnel: a long ford on a skewed street carries its end props a little further out.)
    const funnelL = (r: Ramp) => (r.ford ? r.topL : r.curbL) + CFG.funnelReach + 12;
    const bulge = (x: number, s: number): number => {
      let l = T + 0.5;
      for (const r of ramps) {
        if (r.side !== s) continue;
        const reach = r.hw + r.body + CFG.funnelFlare + 4 + CITY.districts.infill.gap;
        // Out to the funnel's street end (a skewed street carries it sideways past the ramp top).
        const xTop = r.ax + r.ux * rampAlong(p, r, funnelL(r));
        if (x >= Math.min(r.ax, xTop) - reach && x <= Math.max(r.ax, xTop) + reach) l = Math.max(l, funnelL(r));
      }
      return l;
    };
    const xs: number[] = [];
    for (let x = x0; x <= x1 + 1e-6; x += 16) xs.push(x);
    for (const r of ramps) {
      const reach = r.hw + r.body + CFG.funnelFlare + 4 + CITY.districts.infill.gap;
      const xTop = r.ax + r.ux * rampAlong(p, r, funnelL(r));
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

    /**
     * The channel profile at (x, z): height below ground and gradient, ramp trenches included (the
     * lower of the two wins); `flat` also flattens it under the bridge decks (the terrain: the deck).
     */
    const profile = (x: number, z: number, out: HeightSample, flat: boolean): void => {
      const s = riverSlope(p, x);
      const l = z - zc(x);
      const sg = l >= 0 ? 1 : -1;
      const al = l * sg;
      let h = 0;
      let gl = 0;
      if (al < T) {
        const st = smooth01(F, T, al, SMOOTH);
        h = -D * (1 - st.v);
        gl = D * st.d * sg;
      }
      for (const r of ramps) {
        if (r.side !== sg || al <= F || al >= r.topL) continue;
        const fr = frame(r, x, z);
        if (Math.abs(fr.lat) > rampHalf(r, fr.along, fr.lat >= 0 ? 1 : -1)) continue;
        const u = (r.topL - al) / (r.topL - F);
        const pr = rampProfile(u);
        const hr = -D * pr.f;
        if (hr < h) {
          h = hr;
          gl = ((D * pr.df) / (r.topL - F)) * sg;
        }
      }
      if (h === 0) return;
      let gx = -gl * s;
      let gz = gl;
      if (flat) {
        for (const br of bridges) {
          if (Math.abs(x - br.cx) > 90) continue;
          const lim = br.dk + body;
          const d = distToBridge(br, x, z);
          if (d >= lim) continue;
          // Flat across the deck and half a meter past its parapets (the wheels of a car against one).
          const m = smooth01(br.dk + 0.5, lim, d, SMOOTH);
          // Gradient of the distance to the nearest deck segment.
          let ddx = 0;
          let ddz = 0;
          let best = Infinity;
          for (let i = 0; i + 1 < br.pts.length; i++) {
            const a = br.pts[i];
            const c = br.pts[i + 1];
            const t = segmentT(x, z, a.x, a.z, c.x, c.z);
            const qx = a.x + (c.x - a.x) * t;
            const qz = a.z + (c.z - a.z) * t;
            const dd = sqrt((x - qx) ** 2 + (z - qz) ** 2);
            if (dd < best) {
              best = dd;
              ddx = dd > 1e-6 ? (x - qx) / dd : 0;
              ddz = dd > 1e-6 ? (z - qz) / dd : 0;
            }
          }
          gx = gx * m.v + h * m.d * ddx;
          gz = gz * m.v + h * m.d * ddz;
          h *= m.v;
        }
      }
      out.h += h;
      out.gx += gx;
      out.gz += gz;
    };
    let lMax = T + 1;
    for (const r of ramps) lMax = Math.max(lMax, r.topL + 1);
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let x = p.x0; x <= p.x1 + 1e-6; x += 8) {
      zMin = Math.min(zMin, zc(x));
      zMax = Math.max(zMax, zc(x));
    }
    b.heightMods.push({
      minX: p.x0 - 2,
      maxX: p.x1 + 2,
      minZ: zMin - lMax,
      maxZ: zMax + lMax,
      add(x, z, out: HeightSample) {
        profile(x, z, out, true);
      },
    });
    // Two levels under every deck: the lower is the unflattened profile.
    const scratch: HeightSample = { h: 0, gx: 0, gz: 0 };
    for (const br of bridges) {
      b.decks.push({
        polygon: deckBox(p, br, br.dk + body + 0.3, -(T + DECK_END + 0.5), T + DECK_END + 0.5),
        area: id,
        depth: D,
        lower(x, z, out) {
          scratch.h = 0;
          scratch.gx = 0;
          scratch.gz = 0;
          profile(x, z, scratch, false);
          out.h += scratch.h;
          out.gx += scratch.gx;
          out.gz += scratch.gz;
          scratch.h = 0;
          scratch.gx = 0;
          scratch.gz = 0;
          profile(x, z, scratch, true);
          out.h -= scratch.h;
          out.gx -= scratch.gx;
          out.gz -= scratch.gz;
          // The terrain is the deck less what the flattening left of the profile (nothing on the deck proper).
          return -scratch.h;
        },
      });
    }

    // No buildings or infill near the channel.
    const clear = T + CFG.clearance;
    for (let x = p.x0; x < p.x1; x += 24) b.exclusions.push(band(x, Math.min(p.x1, x + 24), -clear, clear, 24));
    b.surfaces.push({ surface: 'concrete', polygon: area.polygon, priority: 1, area: id });
    // The trickle outranks the road classification of the channel edges, so it stays slippery; it runs
    // on under the decks (World.surfaceAt keeps the river's patches off the deck level).
    for (let x = p.x0; x < p.x1 - 2; x += 48) b.surfaces.push({ surface: 'water', polygon: band(x, Math.min(p.x1, x + 48), CFG.waterOffset - CFG.waterHalf, CFG.waterOffset + CFG.waterHalf), priority: 6, area: id });

    // Bridges: parapets along the deck edges (channel cars pass under them), the deck's frontage opened
    // over the band so the city draws no wall there, an abutment box on each bank and pier rows along
    // the floor edges under the deck (deck cars pass over them, their tops set by settleRiver).
    const gapsBySide: Record<number, [number, number][]> = { 1: [], [-1]: [] };
    for (const br of bridges) {
      const W = br.dk + body;
      for (const s of [-1, 1]) {
        const line = deckLine(p, br, s * br.dk, -(T + DECK_END), T + DECK_END);
        b.walls.push(...polyWalls(line, s > 0, 'parapet', id, false));
        const box = deckBox(p, br, W, s * (F + CFG.abutment), s * (T + 1.5));
        b.walls.push(...solidWalls(box, 'culvert', id));
        const lo = s * (T + 0.5);
        const xa = bridgePoint(p, br, -W - 0.3, lo).x;
        const xb = bridgePoint(p, br, W + 0.3, lo).x;
        gapsBySide[s].push([Math.min(xa, xb) - 0.3, Math.max(xa, xb) + 0.3]);
        // Piers at the floor edge, square to the deck, from one parapet to the other.
        const lp = s * (F - CFG.pierInset);
        const n = Math.max(1, Math.floor((2 * (br.dk - 1.2)) / CFG.pierSpacing));
        for (let k = 0; k < n; k++) {
          const w = n === 1 ? 0 : -(br.dk - 1.2) + ((2 * (br.dk - 1.2)) * k) / (n - 1);
          const c = bridgePoint(p, br, w, lp);
          const h = CFG.pier / 2;
          const square = [
            { x: c.x - br.dx * h - br.nx * h, z: c.z - br.dz * h - br.nz * h },
            { x: c.x + br.dx * h - br.nx * h, z: c.z + br.dz * h - br.nz * h },
            { x: c.x + br.dx * h + br.nx * h, z: c.z + br.dz * h + br.nz * h },
            { x: c.x - br.dx * h + br.nx * h, z: c.z - br.dz * h + br.nz * h },
          ];
          b.walls.push(...solidWalls(square, 'pier', id));
        }
      }
      b.openings.push(deckBox(p, br, br.dk + 1.2, -(T + DECK_END - 0.3), T + DECK_END - 0.3));
      const corners = deckBox(p, br, W, -(T + DECK_END), T + DECK_END);
      b.hints.push({ kind: 'bridge', points: corners, values: [br.edge, br.dk] });
    }

    // Ramps: trench walls, a solid plinth either side (outer face, foot and top caps), a drivable
    // concrete surface, buildings kept out, the street frontage opened at a side ramp's mouth, and
    // the funnel at the top.
    const rng = new Rng(p.seed >>> 0 || 1);
    for (const r of ramps) {
      const s = r.side;
      const aF = rampAlong(p, r, F);
      const aTop = rampAlong(p, r, r.topL);
      const aFence = rampAlong(p, r, fenceL);
      const aCurb = r.ford ? aTop : rampAlong(p, r, r.curbL);
      const P = (along: number, lat: number) => rampPoint(r, along, lat);
      const wall = (a: Vec2, c: Vec2, nx: number, nz: number) => b.walls.push({ ax: a.x, az: a.z, bx: c.x, bz: c.z, nx, nz, kind: 'wall', look: 'trench', area: id });
      // Left of the axis is (-uz, ux).
      const lx = -r.uz;
      const lz = r.ux;
      for (const sd of [1, -1]) {
        // At the floor edge the trench is at its foot bell's full width.
        const inner = sd * rampHalf(r, 0, sd);
        const outer = sd * rampOuter(r, 0, sd);
        // Each face starts where its own line reaches the floor edge (a skewed axis puts them at
        // different distances along it), so no wall pokes into the channel edge's corridor.
        const fIn = rampAlong(p, r, F, inner);
        const fOut = rampAlong(p, r, F, outer);
        // Inner trench face, normal into the trench: in along the foot bell, straight up the run,
        // then out along the bell mouth (rampHalf). Plinth outer face, normal away from it: straight,
        // pushed out with either bell where it would leave less than mouthBody of plinth (rampOuter).
        const inFace = [P(fIn, inner)];
        const outFace = [P(fOut, outer)];
        for (const a of [...footAlongs(r), ...mouthAlongs(r, aTop)]) {
          if (a > fIn + 0.5) inFace.push(P(a, sd * rampHalf(r, a, sd)));
          if (a > fOut + 0.5) outFace.push(P(a, sd * rampOuter(r, a, sd)));
        }
        // Each piece's normal is its perpendicular on the side `toward` points to.
        const face = (pts: Vec2[], tx: number, tz: number) => {
          for (let k = 0; k + 1 < pts.length; k++) {
            const q0 = pts[k];
            const q1 = pts[k + 1];
            const len = sqrt((q1.x - q0.x) ** 2 + (q1.z - q0.z) ** 2) || 1;
            const nx = (q1.z - q0.z) / len;
            const nz = -(q1.x - q0.x) / len;
            const k1 = nx * tx + nz * tz >= 0 ? 1 : -1;
            wall(q0, q1, k1 * nx, k1 * nz);
          }
        };
        face(inFace, -sd * lx, -sd * lz);
        face(outFace, sd * lx, sd * lz);
        // Plinth caps: at the floor edge facing the floor, at the top facing the street.
        wall(P(fIn, inner), P(fOut, outer), -r.ux, -r.uz);
        wall(P(aTop, sd * rampHalf(r, aTop, sd)), P(aTop, sd * rampOuter(r, aTop, sd)), r.ux, r.uz);
      }
      const gx = r.ax + r.ux * aFence;
      gapsBySide[s].push([gx - (r.hw + r.body) - 0.3, gx + (r.hw + r.body) + 0.3]);
      // Up the left edge (both bells included) to the curb and back down the right.
      const edgeAt = [aF - 0.5, ...footAlongs(r), ...mouthAlongs(r, aTop), aCurb];
      const trench = [...edgeAt.map((a) => P(a, rampHalf(r, a, 1))), ...edgeAt.reverse().map((a) => P(a, -rampHalf(r, a, -1)))];
      b.surfaces.push({ surface: 'concrete', polygon: trench, priority: 2, area: id });
      const m = CITY.districts.infill.gap;
      const oL = rampOuter(r, aTop, 1);
      const oR = rampOuter(r, aTop, -1);
      b.exclusions.push([P(aF - 2, -oR - m), P(aF - 2, oL + m), P(aTop + 2, oL + m), P(aTop + 2, -oR - m)]);
      if (!r.ford) {
        // The bank street's frontage line crosses the trench mouth and the plinth tops: no wall there.
        b.openings.push([P(aTop - 2, -oR - 0.1), P(aTop - 2, oL + 0.1), P(aTop + 1.5, oL + 0.1), P(aTop + 1.5, -oR - 0.1)]);
        // The sidewalk across the mouth and its funnel belongs to the funnel: no streetlight, hydrant
        // or bench in the way of a car turning in.
        const mid = (aTop + aCurb) / 2;
        const rad = (aCurb - aTop) / 2 + 0.5;
        const lo = -Math.min(oR + CFG.funnelFlare + 2, r.roomR - 1);
        const hi = Math.min(oL + CFG.funnelFlare + 2, r.roomL - 1);
        for (let lat = lo; lat <= hi + 1e-6; lat += rad) {
          const q = P(mid, lat);
          b.reserved.push({ x: q.x, z: q.z, r: rad });
        }
      }
      b.hints.push({ kind: 'ramp', points: [P(0, 0), P(aTop, 0)], values: [s, r.hw, r.body, aF, aTop, r.ford, aFence, aCurb] });
      funnel(ctx.graph, b, rng, r, aTop, aCurb, id);
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

    // Clutter along the floor edges, clear of feet (closures and meets stand there) and decks.
    const busy = (x: number) => ramps.some((r) => Math.abs(x - r.ax) < r.hw + r.body + 14) || bridges.some((br) => Math.abs(x - br.cx) < br.dk + body + 8);
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

/**
 * The funnel at a ramp top, in the shortcut language (see districts/alleyDressing.ts
 * constructionSite): two lines of fence panels splaying from the plinths out
 * toward the street, a sawhorse and a water barrier at each line's street
 * end, cones scattered along, and two strings of lights across the mouth and
 * across the street edge in front of it. Everything breaks before it can
 * stop a car. A ford's lines narrow its own road into the dip (cones where
 * they stand on the road); a side ramp's stay on the sidewalk, from the
 * plinths' tips out to the curb, so the bank street's lanes stay clear and a
 * car turning in has the whole flare leading into the bell mouth.
 */
function funnel(g: RoadGraph, b: AreaBuild, rng: Rng, r: Ramp, aTop: number, aCurb: number, area: number): void {
  // Side ramps: the bank street's pieces at the T. It runs along the river, not always square to the
  // ramp's axis, so a point is pulled back toward the mouth until it stands behind the curb.
  const street: { a: Vec2; b: Vec2; half: number }[] = [];
  if (!r.ford)
    for (const eid of g.nodes[r.node].edges) {
      const e = g.edges[eid];
      if (eid !== r.edge) street.push({ a: g.nodes[e.a], b: g.nodes[e.b], half: e.width / 2 + 0.6 });
    }
  const offStreet = (q: Vec2): Vec2 => {
    for (let k = 0; k < 40 && street.some((s) => distToSegment(q.x, q.z, s.a.x, s.a.z, s.b.x, s.b.z) < s.half); k++) q = { x: q.x - r.ux * 0.25, z: q.z - r.uz * 0.25 };
    return q;
  };
  const P = (along: number, lat: number): Vec2 => offStreet(rampPoint(r, along, lat));
  const push = (kind: PropKind, q: Vec2, yaw: number, lift = 0) => b.destructibles.push({ kind, x: q.x, z: q.z, yaw, lift, area });
  // A ford's plinths cover the street's sidewalks and the outer road edge: the road ends inside them.
  const roadHalf = r.ford ? r.hw + r.body - CITY.sidewalk : g.edges[r.edge].width / 2;
  // Fords: the street's own road continues into the dip; the funnel narrows it from the sidewalk corners
  // to the trench. Side ramps, per side: from the plinth's tip out to the curb, short of the next corridor.
  const latInOf = (sd: number) => (r.ford ? r.hw + 0.3 : rampOuter(r, aTop, sd));
  const latOutOf = (sd: number) => (r.ford ? r.hw + r.body - 0.6 : Math.max(latInOf(sd), Math.min(latInOf(sd) + CFG.funnelFlare, (sd > 0 ? r.roomL : r.roomR) - 2.5)));
  const aStart = r.ford ? aTop + 1.5 : aTop + 1.2;
  const aEnd = r.ford ? aTop + 1.5 + CFG.funnelReach + 3 : aCurb - 0.6;
  const onRoad = (along: number, lat: number) => (r.ford ? Math.abs(lat) < roadHalf - 0.2 : along > aCurb - 0.3);
  for (const sd of [1, -1]) {
    const latIn = latInOf(sd);
    const latOut = latOutOf(sd);
    const A = P(aStart, sd * latIn);
    const B = P(aEnd, sd * latOut);
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const yaw = Math.atan2(-uz, ux);
    const n = Math.max(2, Math.round(len / 2.1));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const q = { x: A.x + (B.x - A.x) * t, z: A.z + (B.z - A.z) * t };
      const along = aStart + (aEnd - aStart) * t;
      const lat = latIn + (latOut - latIn) * t;
      push(onRoad(along, lat) ? 'trafficCone' : 'fencePanel', q, yaw + rng.range(-0.1, 0.1));
    }
    // Cones scattered inside the line (clear of the panels: generateProps drops overlaps; light enough
    // that a car through them barely notices).
    // Square off the line toward the axis (a side ramp's line runs steeply across the short sidewalk).
    const inX = sd * r.uz;
    const inZ = -sd * r.ux;
    const k0 = uz * inX - ux * inZ >= 0 ? 1 : -1;
    for (let k = 0; k < 3; k++) {
      const t = 0.2 + k * 0.28 + rng.range(0, 0.1);
      const off = rng.range(1.6, 2.4);
      const q = offStreet({ x: A.x + (B.x - A.x) * t + k0 * uz * off, z: A.z + (B.z - A.z) * t - k0 * ux * off });
      push('trafficCone', q, rng.range(0, Math.PI * 2));
    }
    if (r.ford) {
      // A sawhorse across the line's street end and a water barrier or sandbags beyond it.
      push('sawhorse', P(aEnd + 2.4, sd * (latOut + 0.4)), yaw + Math.PI / 2 + rng.range(-0.15, 0.15));
      push(rng.chance(0.5) ? 'waterBarrier' : 'sandbags', P(aEnd + 2.2, sd * (latOut + 3.2)), yaw);
    } else {
      // A sawhorse along the curb past the line's end; nothing heavy where a car running wide lands.
      push('sawhorse', P(aEnd - 0.4, sd * (latOut + 2.2)), Math.atan2(-r.ux, -r.uz) + rng.range(-0.15, 0.15));
    }
  }
  // String lights: across the mouth between the plinths' tops, and across the street edge in front.
  const mouthA = r.ford ? aTop + 1.2 : aTop + 1.0;
  const mouthAt = (sd: number) => (r.ford ? r.hw + r.body - 0.4 : latInOf(sd) + 0.6);
  b.hints.push({ kind: 'stringLights', points: [P(mouthA, -mouthAt(-1)), P(mouthA, mouthAt(1))], values: [] });
  const frontA = r.ford ? aTop + 8 : aCurb - 0.6;
  const frontAt = (sd: number) => (r.ford ? r.hw + r.body - 0.4 : latOutOf(sd));
  b.hints.push({ kind: 'stringLights', points: [P(frontA, -frontAt(-1)), P(frontA, frontAt(1))], values: [] });
}

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
  set('flL', 0);
  set('flR', 0);
  set('rmL', 0);
  set('rmR', 0);
}

/**
 * A side ramp's bell mouth, each side: the room along the bank street from
 * the ramp's axis to the next corridor on that side (a cross street's curb
 * and sidewalk at the next junction, or half way to another ramp's T), and
 * the flare that leaves the plinth and a margin inside it.
 */
function sizeMouths(g: RoadGraph, p: Record<string, number>): void {
  const ts = new Set<number>();
  for (let i = 0; i < p.ramps; i++) if (!p[`r${i}ford`]) ts.add(p[`r${i}node`]);
  for (let i = 0; i < p.ramps; i++) {
    if (p[`r${i}ford`]) continue;
    const ax = p[`r${i}ax`];
    const az = p[`r${i}az`];
    const ux = p[`r${i}ux`];
    const uz = p[`r${i}uz`];
    const T = g.nodes[p[`r${i}node`]];
    const room: Record<number, number> = { 1: MOUTH_ROOM, [-1]: MOUTH_ROOM };
    for (const eid of T.edges) {
      const e = g.edges[eid];
      if (isRiverEdge(e)) continue;
      const n = g.nodes[otherNode(e, T.id)];
      const lat = -(n.x - ax) * uz + (n.z - az) * ux;
      const sd = lat >= 0 ? 1 : -1;
      const len = sqrt((n.x - T.x) ** 2 + (n.z - T.z) ** 2) || 1;
      let corridor = 0;
      if (ts.has(n.id)) corridor = Math.abs(lat) / 2;
      else
        for (const oid of n.edges) {
          if (oid === eid) continue;
          const o = g.edges[oid];
          const m = g.nodes[otherNode(o, n.id)];
          const ol = sqrt((m.x - n.x) ** 2 + (m.z - n.z) ** 2) || 1;
          // A street across the bank street (not its continuation) takes its half width and sidewalk.
          if (Math.abs(((m.x - n.x) * (n.x - T.x) + (m.z - n.z) * (n.z - T.z)) / (ol * len)) < 0.7) corridor = Math.max(corridor, o.width / 2 + o.sidewalk);
        }
      room[sd] = Math.min(room[sd], Math.abs(lat) - corridor);
    }
    const hw = p[`r${i}hw`];
    p[`r${i}rmL`] = room[1];
    p[`r${i}rmR`] = room[-1];
    p[`r${i}flL`] = Math.min(CFG.mouthFlare, Math.max(0, room[1] - hw - CFG.mouthBody - MOUTH_MARGIN));
    p[`r${i}flR`] = Math.min(CFG.mouthFlare, Math.max(0, room[-1] - hw - CFG.mouthBody - MOUTH_MARGIN));
  }
}

/**
 * Once the terrain exists (createCity, before the blocks read the walls):
 * the level walls under every bridge get their heights from the deck
 * there, deckClear below it: the parapets' `bottom` (so a car on the
 * channel floor passes under them) and the abutments' and piers' `top` (so a
 * car on the deck passes over them). The deck is the terrain over the wall,
 * pulled in onto the deck proper (|w| <= dk, flat across) for the abutment
 * faces beyond its edge, where the terrain is already down the channel's
 * profile; the base terrain rolls along and across a bridge, so each wall
 * takes the deck right above it.
 */
export function settleRiver(g: RoadGraph, areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  for (const area of areas) {
    if (area.kind !== 'river') continue;
    const p = area.params;
    const bridges = bridgesOf(g, area);
    if (!bridges.length) continue;
    for (const w of builds[area.id].walls) {
      if (!isDeckWall(w)) continue;
      const mx = (w.ax + w.bx) / 2;
      const mz = (w.az + w.bz) / 2;
      let br = bridges[0];
      let best = Infinity;
      for (const c of bridges) {
        const d = distToBridge(c, mx, mz);
        if (d < best) {
          best = d;
          br = c;
        }
      }
      // The deck under the wall, at its lowest along it: a long skewed abutment face (a diagonal over
      // the band) spans a deck that climbs with the ground, and a car on the deck must clear all of it.
      const deckAt = (x: number, z: number) => {
        const l = riverL(p, x, z);
        const c = bridgePoint(p, br, 0, l);
        const wv = Math.max(-br.dk, Math.min(br.dk, (x - c.x) * br.nx + (z - c.z) * br.nz));
        const q = bridgePoint(p, br, wv, l);
        return terrain.heightAt(q.x, q.z);
      };
      let deck = deckAt(mx, mz);
      if (w.look !== 'parapet') {
        const steps = Math.ceil(Math.hypot(w.bx - w.ax, w.bz - w.az) / 4);
        for (let k = 0; k <= steps; k++) deck = Math.min(deck, deckAt(w.ax + ((w.bx - w.ax) * k) / steps, w.az + ((w.bz - w.az) * k) / steps));
      }
      if (w.look === 'parapet') w.bottom = deck - p.depth / 2;
      else w.top = deck - CFG.deckClear;
    }
    // A solid is collided whole at the first face a car does not clear, so its faces share one top:
    // the lowest of them.
    const solidTop = new Map<object, number>();
    for (const w of builds[area.id].walls) if (w.solid && w.top !== undefined) solidTop.set(w.solid, Math.min(solidTop.get(w.solid) ?? Infinity, w.top));
    for (const w of builds[area.id].walls) if (w.solid && w.top !== undefined) w.top = solidTop.get(w.solid)!;
  }
}

/** True for a node of the channel floor (a ramp foot or a point along the chain). */
export function isChannelNode(g: RoadGraph, id: number): boolean {
  return g.nodes[id].edges.some((eid) => g.edges[eid].kind === 'channel');
}

/** A wall of a bridge: the deck's parapets and the abutments and piers beneath it. */
const isDeckWall = (w: Wall): boolean => w.look === 'parapet' || w.look === 'culvert' || w.look === 'pier';
