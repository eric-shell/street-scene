/**
 * The elevated highway's interchanges, planned (highway.ts asks for them per
 * candidate line once its end loops fit, loopPlan.ts, and drops a line that
 * cannot have one): slip ramps alongside the deck, the way an expressway
 * built over a street meets the street beneath. On one side of the deck, by
 * a junction of the street beneath, an off-ramp leaves the deck's edge on a
 * long deceleration lane and comes down alongside it over the frontage to
 * run along the street at its level just short of the junction, where its
 * traffic slips across the cut sidewalk into the street's lanes going the
 * same way; just past the junction its on-ramp peels off the street the same
 * way, climbs alongside and merges onto the deck along a long acceleration
 * lane. No turn anywhere on either: a car flows off and on at speed.
 *
 * A slip ramp's axis (rampAxis.ts polyAxis) follows the deck's edge out by
 * the ramp's half width, from its foot (the end of its run along the street,
 * toward the junction) to E, where the gore opens onto its lane and the
 * axis heads along the deck the way the lane runs on (the traffic's way for
 * an on-ramp, against it for an off-ramp, whose traffic runs E to foot). Its
 * length is what the gentlest grade that fits needs, from the plain terrain
 * at its foot to the deck's planned height at E (with its hump over the El);
 * it is an embankment until it leaves the block its foot is in, and a bridge
 * from there on, over the cross street (high enough over it) and the frontage
 * beyond. It keeps clear of a swing's turns, the El crossing, the river, a
 * bluff and the roundabouts; its lane runs on as long as the deck has room,
 * cut short to no less than CFG.rampLaneMin at full width. `want` of the
 * pairs are kept, spaced along each side of the deck, clear of the end loops.
 */
import { CITY } from '../../config';
import { computeMouths } from '../../blocks';
import type { BlockFace, EdgeMouths } from '../../blocks';
import type { Terrain } from '../../terrain';
import { createTerrain } from '../../terrain';
import { Vec2, distToSegment } from '../../../sim/math';
import type { Rng } from '../../../sim/prng';
import type { PlanContext } from '../types';
import { distToPolygonEdge, pointInPolygon } from '../geom';
import { gridNode, streetChain } from '../subway';
import { RailCurve, buildRailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { RampAxis, RampProfile, axisAt, polyAxis, rampHeightAlong, solveGrade } from './rampAxis';
import { HALF, MOUTH_TAPER, PLAIN, TAPER, deckPoint, elCrossings, laneLength, rampOutline, rightOf } from './shape';
import { Chain, Hazards, LinePlan, chainOfNodes, clearAt, elDistance } from './line';

const CFG = CITY.districts.highway;

/** A ramp's outline keeps this far inside its block (m). */
export const BLOCK_IN = 1;

/** The embankment ends this far before the ramp leaves its block (m): the bridge stretch starts over the yard. */
export const SOLID_BACK = 4;

/** The ramp's bridge stretch clears the street it passes over by this much (m). */
export const BRIDGE_CLEAR = 6;

/** A slip ramp's axis points are about this far apart (m). */
const STEP = 3;

/** The tapered end of a slip ramp's run along the street, past its foot (m): it eases a car out onto the street or in off it. */
export const SLIP_NOSE = 10;

/** A slip ramp's bridge clears a cross street by this much (m): it runs low over it, alongside the deck. */
const SLIP_CLEAR = 4.8;

/** A planned ramp (an interchange's slip ramp, or an end loop): everything its area's params hold. */
export interface RampPlan {
  axis: RampAxis;
  /** The side of the deck it stands on (+1: right of the deck's +s direction). */
  side: 1 | -1;
  /** Up (traffic foot to E) or down (E to foot), an end loop, and the way its axis and lane run along the deck at E (shape.ts HighwayRamp). */
  on: boolean;
  loop: boolean;
  along: 1 | -1;
  /** Half width between its walls (m), and its run along the street at its level (m; 0 but for a slip ramp). */
  half: number;
  flat: number;
  /** Gore nose (E, or the deck's end for a loop) and lane end along the deck curve (m). */
  sa: number;
  sb: number;
  /** The street piece its mouth is cut in, and the cut (busBays.ts mouthBay; a slip ramp's is cut when built). */
  edge: number;
  mouthSide: 1 | -1;
  m0: number;
  m1: number;
  /** The block it climbs through from its foot, and the foot street's edges (claimed with it; none for a ramp off the deck's own street). */
  face: number;
  footEdges: number[];
  polygon: Vec2[];
  /** The row street's building line offset from the deck's centerline on the ramp side (m), and where the ramp's block ends along the deck (s, m). */
  building: number;
  sBlock: number;
  /** The embankment ends this far along the axis (m); a bridge from there on. */
  uSolid: number;
  /** Rise and grade as planned (m), from the plain terrain. */
  rise: number;
  grade: number;
}

/** What every ramp of one candidate line is planned against: the line, its smoothed curve, the plain terrain, the blocks. */
export interface RampSite {
  ctx: PlanContext;
  hz: Hazards;
  line: LinePlan;
  curve: RailCurve;
  terrain: Terrain;
  faces: BlockFace[];
  mouths: EdgeMouths[];
  /** Where the line crosses the El, and its swings' turns (s along the curve, m). */
  crossS: number[];
  turnS: number[];
  /** The line's street between columns i and i + 1 when both are on row j, or null. */
  rowChain(i: number, j: number): Chain | null;
}

/** The faces and curb mouths of the graph as it is (the same for every candidate line) and the plain terrain. */
export function siteBase(ctx: PlanContext): Pick<RampSite, 'terrain' | 'faces' | 'mouths'> {
  return { terrain: createTerrain(ctx.seed), faces: ctx.faces(), mouths: computeMouths(ctx.graph, ctx.sectors()) };
}

export function rampSite(ctx: PlanContext, hz: Hazards, line: LinePlan, base: Pick<RampSite, 'terrain' | 'faces' | 'mouths'>): RampSite {
  const g = ctx.graph;
  const W = CITY.gridW;
  const curve = buildRailCurve(line.path, 1, 0, () => 0);
  return {
    ctx,
    hz,
    line,
    curve,
    ...base,
    crossS: elCrossings(line.path, ctx.areas).map((p) => projectOnCurve(curve, p.x, p.z).s),
    turnS: line.turns.map((p) => projectOnCurve(curve, p.x, p.z).s),
    rowChain(i, j) {
      if (i < 0 || i + 1 >= W || line.rows[i] !== j || line.rows[i + 1] !== j) return null;
      const nodes = streetChain(g, gridNode(g, i, j).id, gridNode(g, i + 1, j).id);
      return nodes ? chainOfNodes(g, nodes) : null;
    },
  };
}

/**
 * About how much the deck rises over the El at s (m): settleHighway's hump from the El's deck height,
 * for a ramp's top planned near the crossing (the settled profile meets the deck as it is).
 */
export function humpNear(crossS: readonly number[], s: number): number {
  const need = CITY.districts.subway.deckHeight + CFG.elClear - CFG.clearance;
  if (need <= 0) return 0;
  const ease = Math.max(60, (1.6 * need) / CFG.humpGrade);
  let h = 0;
  for (const c of crossS) {
    const out = Math.max(0, Math.abs(s - c) - 25);
    if (out >= ease) continue;
    const t = 1 - out / ease;
    h = Math.max(h, need * t * t * (3 - 2 * t));
  }
  return h;
}

/** Max of the plain ground across the deck around s (m): what its top is planned from. */
export function groundNear(curve: RailCurve, terrain: Terrain, s: number): number {
  const P = curvePoint();
  let g = -Infinity;
  for (let d = -30; d <= 30; d += 10) {
    sampleCurve(curve, s + d, P);
    const r = rightOf(P.tx, P.tz);
    for (const v of [-HALF, 0, HALF]) g = Math.max(g, terrain.heightAt(P.x + r.x * v, P.z + r.z * v));
  }
  return g;
}

/** The deck's top as planned at s (m): the ground across it, the clearance and depth, a margin, the hump over the El. */
export function plannedTop(site: RampSite, s: number): number {
  return groundNear(site.curve, site.terrain, s) + CFG.clearance + CFG.depth + 0.4 + humpNear(site.crossS, s);
}

/**
 * The free block with these four grid corners, or null: no shortcut through it and (unless `loose`) no
 * street round it a ramp may not bridge: a river bridge, or a claimed one but the El's, the river's or
 * an alley's (the outline keeps clear of the El's deck and the channel itself).
 */
export function blockOf(site: RampSite, corners: { x: number; z: number }[], loose = false): BlockFace | null {
  const { ctx, faces } = site;
  const g = ctx.graph;
  const mid = { x: corners.reduce((s, n) => s + n.x, 0) / 4, z: corners.reduce((s, n) => s + n.z, 0) / 4 };
  const face = faces.find((f) => !f.outer && pointInPolygon(mid.x, mid.z, f.ring));
  if (!face || ctx.claims.face.has(face.id)) return null;
  if (face.edges.some((e) => g.edges[e].shortcut)) return null;
  const bridgeable = (e: number) => {
    const claim = ctx.claims.edge.get(e);
    return (PLAIN.has(g.edges[e].kind) || g.edges[e].kind === 'alley') && !g.edges[e].bridge && (claim === undefined || ['subway', 'river', 'alley'].includes(ctx.areas[claim].kind));
  };
  if (!loose && !face.edges.every(bridgeable)) return null;
  return face;
}

/** How far a cross street at a node reaches along the deck's street (m): its half corridor, the widest of the node's streets that are not along the deck. */
export function crossReach(site: RampSite, node: number): number {
  const g = site.ctx.graph;
  const n = g.nodes[node];
  const P = curvePoint();
  sampleCurve(site.curve, projectOnCurve(site.curve, n.x, n.z).s, P);
  let m = CITY.width.street / 2 + CITY.sidewalk;
  for (const eid of n.edges) {
    const e = g.edges[eid];
    const o = g.nodes[e.a === node ? e.b : e.a];
    const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
    if (Math.abs(((o.x - n.x) * P.tx + (o.z - n.z) * P.tz) / l) < 0.75) m = Math.max(m, e.width / 2 + e.sidewalk);
  }
  return m;
}

/** A junction of the deck's street a pair of slip ramps meets (a grid node on the line's row there). */
export interface SlipJunction {
  /** Its column, along the deck (s, m) and how far its cross street reaches along the deck's street (m). */
  i: number;
  s: number;
  corner: number;
}

/**
 * The slip ramp (`on`, or an off-ramp) on `side` of the deck at a junction, or null where it does not fit:
 * its foot just clear of the junction (the run along the street and its mouth's taper before the cross
 * street's corner), its axis along the deck's edge away from the junction for as long as its rise needs
 * at the gentlest grade that fits, E where it meets the deck and its lane on beyond, inside `limits`.
 */
export function slipRamp(site: RampSite, at: SlipJunction, side: 1 | -1, on: boolean, cap: number, limits: [number, number]): RampPlan | null {
  const { ctx, hz, line, curve, terrain, faces } = site;
  const g = ctx.graph;
  const along: 1 | -1 = on ? side : side > 0 ? -1 : 1;
  const half = CFG.rampHalf;
  const flat = CFG.slipFlat;
  const v = side * (HALF + half);
  const e0 = CFG.slipFootEase;
  const e1 = CFG.rampTopEase;
  // The foot: the run along the street, its nose and the mouth's taper short of the cross street's corner.
  const sf = at.s + along * (at.corner + CFG.loopMouthClear + SLIP_NOSE + MOUTH_TAPER);
  const P = curvePoint();
  const foot = deckPoint(curve, sf, v, P);
  const y0 = terrain.heightAt(foot.x, foot.z);
  // The block the foot is in: the embankment runs from there while both edges stay in it.
  const fp = deckPoint(curve, sf + along * flat, v, P);
  const face = faces.find((f) => !f.outer && pointInPolygon(fp.x, fp.z, f.ring));
  if (!face || ctx.claims.face.has(face.id) || face.edges.some((e) => g.edges[e].shortcut || g.edges[e].bridge)) return null;
  const w = half + 0.6;
  const inBlock = (x: number, z: number) => pointInPolygon(x, z, face.ring) && distToPolygonEdge(x, z, face.ring) >= BLOCK_IN * 0.5;
  // The streets across the deck's (not along it) near the junction: what a ramp's bridge clears.
  sampleCurve(curve, at.s, P);
  const tx = P.tx;
  const tz = P.tz;
  const across = g.edges.filter((e) => {
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return Math.hypot((a.x + b.x) / 2 - foot.x, (a.z + b.z) / 2 - foot.z) < 320 && Math.abs(((b.x - a.x) * tx + (b.z - a.z) * tz) / l) < 0.8;
  });
  const crossAt = (x: number, z: number) =>
    across.some((e) => {
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      return distToSegment(x, z, a.x, a.z, b.x, b.z) <= e.width / 2 + e.sidewalk + BLOCK_IN;
    });
  // Long enough to rise to the deck at the gentle grade where the deck has room for it, else steeper (as
  // it is where the cross street it bridges comes too soon for the gentle one).
  const room = (along > 0 ? limits[1] - sf : sf - limits[0]) - CFG.rampLaneMin - TAPER;
  for (const want of [CFG.slipGrade, 0.11, cap - 0.008]) {
    let L = 0;
    let y1 = 0;
    let grade = want;
    for (let it = 0; it < 3; it++) {
      y1 = plannedTop(site, sf + along * (L || 200));
      L = flat + (e0 + e1) / 2 + (y1 - y0) / want;
      grade = want;
      if (L > room) {
        L = room;
        grade = solveGrade(L - flat, y0, 0, y1, 0, e0, e1);
      }
    }
    if (grade > cap - 0.008 || grade < 0.02 || L < flat + e0 + e1) continue;
    const sE = sf + along * L;
    // Its foot and embankment clear of a swing's turns (the deck cuts the junction's corner on its arc;
    // its bridge may pass one, high over the corner), its top clear of the El crossing (the deck's hump).
    const sSolid = sf + along * (flat + 70);
    if (site.turnS.some((s) => s > Math.min(sf, sSolid) - CFG.swingTangent - 20 && s < Math.max(sf, sSolid) + CFG.swingTangent + 20)) return null;
    if (site.crossS.some((s) => Math.abs(s - sE) < CFG.rampElClear)) continue;
    // The lane on beyond E, as long as the deck has room for.
    const lane = Math.min(laneLength({ on }) + TAPER, along > 0 ? limits[1] - sE : sE - limits[0]);
    if (lane < CFG.rampLaneMin + TAPER) continue;
    const sb = sE + along * lane;
    // The axis: along the deck's edge, foot to E (the deck's own curve, so its arc length is the ramp's).
    const pts: Vec2[] = [];
    const n = Math.max(2, Math.ceil(L / STEP));
    for (let k = 0; k <= n; k++) pts.push(deckPoint(curve, sf + (along * L * k) / n, v, P));
    const ax = polyAxis(pts);
    const profile: RampProfile = { y0, g0: 0, y1, g1: 0, grade, e0, e1, blend: flat + 14, flat, ready: true };
    // Its edges in the block: the inner one (on the deck's side) just inside the building line of the
    // street beneath, which its inner wall stands on.
    const c0 = deckPoint(curve, sf, 0, P);
    const inner = (c0.x - ax.fx) * -ax.dz + (c0.z - ax.fz) * ax.dx > 0 ? 1 : -1;
    let uExit = ax.length;
    for (let u = flat; u <= ax.length; u += 1) {
      const q = axisAt(ax, u);
      const vi = inner * (half - 0.6);
      const vo = -inner * w;
      if (inBlock(q.x - q.tz * vi, q.z + q.tx * vi) && inBlock(q.x - q.tz * vo, q.z + q.tx * vo)) continue;
      uExit = u;
      break;
    }
    const uSolid = uExit - SOLID_BACK;
    if (uSolid < flat + 10) return null;
    // Its nose and run along the street in the block too (a diagonal leaving the junction cuts far along).
    for (let u = -SLIP_NOSE; u < flat; u += 2) {
      const q = axisAt(ax, u);
      const vo = -inner * w;
      if (!inBlock(q.x - q.tz * vo, q.z + q.tx * vo) || !inBlock(q.x, q.z)) return null;
    }
    // High enough where its bridge starts for a car to pass beneath (the alley there).
    const qs = axisAt(ax, uSolid);
    if (rampHeightAlong(ax, profile, uSolid).y - terrain.heightAt(qs.x, qs.z) < 4.5) continue;
    // Its band (and the street's run at its foot) clear of the hazards; where it bridges a cross street,
    // high enough over it.
    let ok = true;
    for (let u = -SLIP_NOSE; u <= ax.length && ok; u += 2) {
      const q = axisAt(ax, u);
      const y = rampHeightAlong(ax, profile, Math.max(0, u)).y;
      for (const o of [-w, 0, w]) {
        const x = q.x - q.tz * o;
        const z = q.z + q.tx * o;
        if (!clearAt(hz, x, z, 4) || elDistance(hz, x, z) < CITY.districts.subway.deckWidth / 2 + 4) return null;
        if (u > uSolid && crossAt(x, z) && y - terrain.heightAt(x, z) < SLIP_CLEAR) ok = false;
      }
    }
    if (!ok) continue;
    // Whose foot street it runs along: the row's piece at its foot (the deck's own street, claimed with it).
    const row = site.rowChain(at.i - (along > 0 ? 0 : 1), line.rows[at.i]);
    let edge = -1;
    let best = Infinity;
    for (const e of row?.edges ?? []) {
      const a = g.nodes[g.edges[e].a];
      const b = g.nodes[g.edges[e].b];
      const d = distToSegment(fp.x, fp.z, a.x, a.z, b.x, b.z);
      if (d < best) {
        best = d;
        edge = e;
      }
    }
    if (edge < 0) return null;
    const polygon = rampOutline(ax, curve, side, along, sE, sb, 0.6, half, false);
    return {
      axis: ax,
      side,
      on,
      loop: false,
      along,
      half,
      flat,
      sa: sE,
      sb,
      edge,
      mouthSide: 1,
      m0: 0,
      m1: 0,
      face: face.id,
      footEdges: [],
      polygon,
      building: HALF,
      sBlock: sf + along * uExit,
      uSolid,
      rise: y1 - y0,
      grade,
    };
  }
  return null;
}

/**
 * Interchanges of a line, in a seeded order: by each junction of the deck's street on its straight runs,
 * on each side, the off-ramp coming down to the street before it (the way that side's traffic runs) and
 * the on-ramp going up just past it, or past the next junction on where it has no room there, each as
 * gentle as fits; then `want` of them kept, the closest pairs and the gentlest first, their ramps and
 * lanes CFG.rampGap apart on each side, clear of the end loops. Null when fewer than `least` fit.
 */
export function planInterchanges(site: RampSite, want: number, least: number, rng: Rng, cap: number, limits: [number, number], loops: readonly RampPlan[]): RampPlan[][] | null {
  const W = CITY.gridW;
  const g = site.ctx.graph;
  const clearOf = (r: RampPlan, others: readonly RampPlan[]) => others.every((l) => r.polygon.every((p) => !pointInPolygon(p.x, p.z, l.polygon) && distToPolygonEdge(p.x, p.z, l.polygon) > 3));
  // The junctions with the deck's street running on straight both ways, and each side's ramp by each.
  const junctions = Array.from({ length: W }, (_, i): SlipJunction | null => {
    const j = site.line.rows[i];
    if (i < 1 || i + 1 >= W || !site.rowChain(i - 1, j) || !site.rowChain(i, j)) return null;
    const node = gridNode(g, i, j);
    return { i, s: projectOnCurve(site.curve, node.x, node.z).s, corner: crossReach(site, node.id) };
  });
  const cache = new Map<string, RampPlan | null>();
  const ramp = (i: number, side: 1 | -1, on: boolean): RampPlan | null => {
    const at = i >= 0 && i < W ? junctions[i] : null;
    if (!at) return null;
    const key = `${i}:${side}:${on}`;
    if (!cache.has(key)) {
      const r = slipRamp(site, at, side, on, cap, limits);
      cache.set(key, r && clearOf(r, loops) ? r : null);
    }
    return cache.get(key)!;
  };
  const cands: { pair: RampPlan[]; rank: number }[] = [];
  for (let i = 0; i < W; i++) {
    for (const side of [1, -1] as const) {
      const off = ramp(i, side, false);
      if (!off) continue;
      [i, i + side].forEach((k, rank) => {
        const on = ramp(k, side, true);
        if (on && clearOf(on, [off])) cands.push({ pair: [off, on], rank });
      });
    }
  }
  rng.shuffle(cands);
  cands.sort((p, q) => p.rank - q.rank || p.pair[0].grade + p.pair[1].grade - (q.pair[0].grade + q.pair[1].grade));
  const span = (c: RampPlan[]): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of c) {
      const f = projectOnCurve(site.curve, r.axis.fx, r.axis.fz).s;
      for (const s of [f - SLIP_NOSE, f + SLIP_NOSE, r.sa, r.sb]) {
        lo = Math.min(lo, s);
        hi = Math.max(hi, s);
      }
    }
    return [lo, hi];
  };
  const out: RampPlan[][] = [];
  for (const { pair } of cands) {
    if (out.length >= want) break;
    const [c0, c1] = span(pair);
    if (out.some((o) => o[0].side === pair[0].side && c0 < span(o)[1] + CFG.rampGap && span(o)[0] < c1 + CFG.rampGap)) continue;
    out.push(pair);
  }
  return out.length >= least ? out : null;
}
