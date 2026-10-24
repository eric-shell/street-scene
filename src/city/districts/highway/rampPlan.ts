/**
 * The elevated highway's on-ramps, planned (highway.ts asks for them per
 * candidate line, and drops a line that cannot have two): for every street
 * block the deck follows, on each side, the block between the deck's street
 * and the parallel one is the ramp's right of way. Its top (E) sits beside
 * the deck's edge just past the cross street at the block's far end (the ramp
 * bridges it), heading the way traffic on that side runs, and its lane merges
 * on along the next block's frontage; its foot is found along the parallel
 * street's building line, joined to E by the tangent to a turn's circle
 * (rampAxis.ts rampAxisFrom), and the gentlest layout is kept whose grade
 * stays under the cap (from the plain terrain and the deck's planned height
 * with its hump over the El), whose mouth is a cut clear of the foot street's junctions, whose
 * embankment stays in its block (the inner edge clear of the widened street's
 * building line) and whose bridge stretch keeps to its block, the cross
 * street, the deck's edge and the next block, clear of the El, the river, a
 * bluff and the roundabouts. Then `want` of them, one per block and spaced
 * along the deck, away from the El crossing.
 */
import { CITY, ROUTE } from '../../config';
import { computeMouths } from '../../blocks';
import type { BlockFace } from '../../blocks';
import type { Terrain } from '../../terrain';
import { createTerrain } from '../../terrain';
import { DEG, Vec2, distToSegment } from '../../../sim/math';
import type { Rng } from '../../../sim/prng';
import type { PlanContext } from '../types';
import { distToPolygonEdge, pointInPolygon } from '../geom';
import { gridNode, streetChain } from '../subway';
import { RailCurve, buildRailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { RampAxis, RampProfile, axisAt, axisPoint, projectAxis, rampAxisFrom, rampHeightAlong, solveGrade } from './rampAxis';
import { CLOSURE_GAP, HALF, MERGE, MOUTH_TAPER, PLAIN, TAPER, deckPoint, elCrossings, mouthCut, rampOutline, rightOf } from './shape';
import { Hazards, LinePlan, chainOfNodes, clearAt, elDistance } from './line';

const CFG = CITY.districts.highway;

/** The ramp's straight leg is at least this long (m): a square mouth. */
const MIN_LEG = 4;

/** The ramp's outline keeps this far inside its block (m). */
const BLOCK_IN = 1;

/** The embankment ends this far before the ramp leaves its block (m): the bridge stretch starts over the yard. */
const SOLID_BACK = 4;

/** The ramp's bridge stretch clears the cross street it passes over by this much (m). */
const BRIDGE_CLEAR = 6;

/** A planned ramp: everything its area's params hold. */
export interface RampPlan {
  axis: RampAxis;
  /** Merge side (+1: right of the deck's +s direction, merging toward +s; -1: left, toward -s). */
  side: 1 | -1;
  /** Gore nose and taper end along the deck curve (m). */
  sa: number;
  sb: number;
  /** The foot street's piece the mouth is cut in, and the cut (busBays.ts mouthBay). */
  edge: number;
  mouthSide: 1 | -1;
  m0: number;
  m1: number;
  /** The block the ramp climbs through, the one its top and merge reach over, and the foot street's edges. */
  face: number;
  next: number;
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

/**
 * About how much the deck rises over the El at s (m): settleHighway's hump from the El's deck height,
 * for a ramp's top planned near the crossing (the settled profile meets the deck as it is).
 */
function humpNear(crossS: readonly number[], s: number): number {
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

/** A ramp layout tried: its axis, mouth, where its top meets the deck and its profile as planned. */
interface Layout {
  ax: RampAxis;
  edge: number;
  cut: { side: 1 | -1; s0: number; s1: number };
  sinA: number;
  sa: number;
  sb: number;
  y0: number;
  y1: number;
  grade: number;
  score: number;
}

/** Max of the plain ground across the deck around s (m): what its top is planned from. */
function groundNear(curve: RailCurve, terrain: Terrain, s: number): number {
  const P = curvePoint();
  let g = -Infinity;
  for (let d = -30; d <= 30; d += 10) {
    sampleCurve(curve, s + d, P);
    const r = rightOf(P.tx, P.tz);
    for (const v of [-HALF, 0, HALF]) g = Math.max(g, terrain.heightAt(P.x + r.x * v, P.z + r.z * v));
  }
  return g;
}

/**
 * Ramp candidates of a line, in a seeded order: for every street block the deck follows, on each
 * side, the gentlest layout (curve radius, foot) that fits the block between the deck's street and
 * the parallel one, with its top past the cross street and its merge along the next block, its mouth
 * clear of the foot street's junctions and the rise within the grade cap; then `want` of them kept,
 * spaced along the deck and away from the El crossing.
 */
export function planRamps(ctx: PlanContext, hz: Hazards, line: LinePlan, want: number, rng: Rng, cap: number): RampPlan[] | null {
  const g = ctx.graph;
  const W = CITY.gridW;
  const H = CITY.gridH;
  const curve = buildRailCurve(line.path, 1, 0, () => 0);
  const terrain = createTerrain(ctx.seed);
  const faces = ctx.faces();
  const mouths = computeMouths(g, ctx.sectors());
  const crossS = elCrossings(line.path, ctx.areas).map((p) => projectOnCurve(curve, p.x, p.z).s);
  const P = curvePoint();
  const rowChain = (i: number, j: number) => {
    if (i < 0 || i + 1 >= W || line.rows[i] !== j || line.rows[i + 1] !== j) return null;
    const nodes = streetChain(g, gridNode(g, i, j).id, gridNode(g, i + 1, j).id);
    return nodes ? chainOfNodes(g, nodes) : null;
  };
  /**
   * The free block with these four grid corners, or null: no shortcut through it and (unless `loose`: the
   * merge only overhangs its frontage) no street round it the ramp may not bridge: a river bridge, or a
   * claimed one but the El's, the river's or an alley's (the outline keeps clear of the El's deck and the
   * channel itself).
   */
  const blockOf = (corners: { x: number; z: number }[], loose = false): BlockFace | null => {
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
  };
  const reachOf = (node: number) => {
    let m = 0;
    for (const eid of g.nodes[node].edges) m = Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk);
    return m;
  };
  const mouthReach = (node: number) => reachOf(node) + Math.max(ROUTE.barrierSetbackHeadOn + CLOSURE_GAP, ROUTE.railReach + 3) + CFG.rampMouthClear;
  const cands: RampPlan[] = [];
  for (let i = 0; i + 1 < W; i++) {
    const j = line.rows[i];
    const row = rowChain(i, j);
    if (!row) continue;
    const A = gridNode(g, i, j);
    const B = gridNode(g, i + 1, j);
    const sA = projectOnCurve(curve, A.x, A.z).s;
    const sB = projectOnCurve(curve, B.x, B.z).s;
    if (sB - sA < 90) continue;
    sampleCurve(curve, (sA + sB) / 2, P);
    const right = rightOf(P.tx, P.tz);
    for (const side of [1, -1] as const) {
      const away = { x: right.x * side, z: right.z * side };
      // The foot street: the parallel row on this side.
      let jf = -1;
      for (const dj of [-1, 1]) {
        const jj = j + dj;
        if (jj < 0 || jj >= H) continue;
        const m = gridNode(g, i, jj);
        if ((m.x - A.x) * away.x + (m.z - A.z) * away.z > 40) jf = jj;
      }
      if (jf < 0 || line.rows.some((r, k) => r === jf && k >= i - 1 && k <= i + 2)) continue;
      const footNodes = streetChain(g, gridNode(g, i, jf).id, gridNode(g, i + 1, jf).id);
      if (!footNodes) continue;
      const foot = chainOfNodes(g, footNodes);
      if (foot.edges.some((e) => e < 0 || !PLAIN.has(g.edges[e].kind) || g.edges[e].bridge || g.edges[e].shortcut || ctx.claims.edge.has(e))) continue;
      // The block between them, and the next one along the deck the merge runs on beside: the deck
      // follows its street there too.
      const face = blockOf([A, B, gridNode(g, i, jf), gridNode(g, i + 1, jf)]);
      if (!face) continue;
      const ni = side > 0 ? i + 1 : i - 1;
      if (!rowChain(ni, j)) continue;
      const next = blockOf([gridNode(g, ni, j), gridNode(g, ni + 1, j), gridNode(g, ni, jf), gridNode(g, ni + 1, jf)], true);
      if (!next || next.id === face.id) continue;
      // The ramp's top bridges the cross street at the block's far end and reaches the deck's edge just
      // past the next block's corner (the gore nose there, CFG.rampPast on: the gentlest layout wins);
      // its lane merges on along that block, ending clear of the block's far junction.
      const endNode = side > 0 ? B : A;
      // Never over a roundabout: the ramp bridges the junction at the block's far end.
      if (endNode.ring) continue;
      const farNode = side > 0 ? gridNode(g, i + 2, j) : gridNode(g, i - 1, j);
      const corner = Math.max(reachOf(endNode.id), HALF - CITY.sidewalk);
      const sFar = projectOnCurve(curve, farNode.x, farNode.z).s;
      // The building line of the row street once widened: under the deck's edge.
      const building = HALF;
      const cross = endNode.edges.filter((e) => {
        const o = g.nodes[g.edges[e].a === endNode.id ? g.edges[e].b : g.edges[e].a];
        return (o.x - endNode.x) * away.x + (o.z - endNode.z) * away.z > 0;
      });
      // The block's far corner along that building line: where it meets the cross street's (a skewed
      // junction moves it along the deck), a meter short of it.
      const inCross = (q: Vec2) => cross.some((e) => {
        const a = g.nodes[g.edges[e].a];
        const b = g.nodes[g.edges[e].b];
        return distToSegment(q.x, q.z, a.x, a.z, b.x, b.z) < g.edges[e].width / 2 + g.edges[e].sidewalk;
      });
      const sEnd = side > 0 ? sB : sA;
      let sBlock = sEnd - side * corner;
      for (let s = sEnd - side * 60; (sEnd - s) * side > -corner; s += side) {
        if (!inCross(deckPoint(curve, s, side * (building + 0.5)))) continue;
        sBlock = s - side;
        break;
      }
      // Feet along the foot street's building line (the face's ring along its pieces), every few meters;
      // each joined to E by the tangent from it to the turn's circle (rampAxis.ts rampAxisFrom).
      const feet: { p: Vec2; edge: number }[] = [];
      for (let k = 0; k < face.ring.length; k++) {
        const e = face.segEdge[k];
        if (e < 0 || !foot.edges.includes(e)) continue;
        const p = face.ring[k];
        const q = face.ring[(k + 1) % face.ring.length];
        const m = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 5));
        for (let t = 0; t <= m; t++) feet.push({ p: { x: p.x + ((q.x - p.x) * t) / m, z: p.z + ((q.z - p.z) * t) / m }, edge: e });
      }
      /**
       * Where the embankment ends and whether the ramp's outline fits: the embankment inside its block
       * (clear of the widened street's building line), the bridge stretch over its block, the deck's edge,
       * the cross street (high enough over it) and the next block; all of it clear of the El and the hazards.
       */
      const fitRamp = (lay: Layout): { poly: Vec2[]; uSolid: number } | null => {
        const ax = lay.ax;
        const L = ax.length;
        const profile: RampProfile = { y0: lay.y0, g0: 0, y1: lay.y1, g1: 0, grade: lay.grade, e0: CFG.rampFootEase, e1: CFG.rampTopEase, blend: 14, ready: true };
        const inBlock = (f: BlockFace, x: number, z: number) => pointInPolygon(x, z, f.ring) && distToPolygonEdge(x, z, f.ring) >= BLOCK_IN && Math.abs(projectOnCurve(curve, x, z).lateral) >= HALF + BLOCK_IN;
        // The embankment runs while both edges stay in the block, from where an oblique leg's edges clear the mouth.
        const w = CFG.rampHalf + 0.6;
        const u0 = 3 + (w * Math.sqrt(Math.max(0, 1 - lay.sinA * lay.sinA))) / lay.sinA;
        let uExit = L;
        for (let u = u0; u <= L; u += 1) {
          const q = axisAt(ax, u);
          if (inBlock(face, q.x - q.tz * w, q.z + q.tx * w) && inBlock(face, q.x + q.tz * w, q.z - q.tx * w)) continue;
          uExit = u;
          break;
        }
        const uSolid = uExit - SOLID_BACK;
        if (uSolid < 0.3 * L) return null;
        const poly = rampOutline(ax, curve, side, lay.sa, lay.sb, 0.6);
        const ap = axisPoint();
        for (const p of poly) {
          projectAxis(ax, p.x, p.z, ap);
          if (!clearAt(hz, p.x, p.z, 6) || elDistance(hz, p.x, p.z) < CITY.districts.subway.deckWidth / 2 + 4) return null;
          if (ap.u < u0) continue;
          if (ap.u <= uSolid) {
            if (!inBlock(face, p.x, p.z)) return null;
            continue;
          }
          if (pointInPolygon(p.x, p.z, face.ring) || pointInPolygon(p.x, p.z, next.ring)) continue;
          const lat = Math.abs(projectOnCurve(curve, p.x, p.z).lateral);
          if (lat >= HALF - 1.5 && lat <= HALF + 1.2) continue;
          const overCross = cross.some((e) => {
            const a = g.nodes[g.edges[e].a];
            const b = g.nodes[g.edges[e].b];
            return distToSegment(p.x, p.z, a.x, a.z, b.x, b.z) <= g.edges[e].width / 2 + g.edges[e].sidewalk + BLOCK_IN + 0.5;
          });
          if (!overCross) return null;
          if (ap.u <= L && rampHeightAlong(ax, profile, ap.u).y - terrain.heightAt(p.x, p.z) < BRIDGE_CLEAR) return null;
        }
        return { poly, uSolid };
      };
      const layouts: Layout[] = [];
      for (const past of CFG.rampPast) {
        const sa = (side > 0 ? sB + corner : sA - corner) + side * past;
        const sb = sa + side * (MERGE + TAPER);
        if ((sFar - sb) * side < reachOf(farNode.id) + 12) continue;
        if (crossS.some((s) => Math.abs(s - sa) < CFG.rampElClear)) continue;
        sampleCurve(curve, sa, P);
        const tm = { x: P.tx * side, z: P.tz * side };
        const rs = rightOf(P.tx, P.tz);
        const E = { x: P.x + rs.x * side * (HALF + CFG.rampHalf), z: P.z + rs.z * side * (HALF + CFG.rampHalf) };
        const aw = { x: rs.x * side, z: rs.z * side };
        const y1 = groundNear(curve, terrain, sa) + CFG.clearance + CFG.depth + 0.4 + humpNear(crossS, sa);
        for (const r of CFG.rampRadius) {
          for (const f of feet) {
            const ax = rampAxisFrom(f.p, E, tm, aw, r);
            if (!ax || ax.a < MIN_LEG) continue;
            // Into the block toward the deck, turning onto it at most a little past square.
            const sweep = Math.abs(ax.sweep);
            if (sweep > 150 * DEG || ax.dx * aw.x + ax.dz * aw.z > -0.4) continue;
            const L = ax.length;
            if (L < CFG.rampFootEase + CFG.rampTopEase + 15) continue;
            const y0 = terrain.heightAt(ax.fx, ax.fz);
            const grade = solveGrade(L, y0, 0, y1, 0, CFG.rampFootEase, CFG.rampTopEase);
            if (grade > cap - 0.008 || grade < 0.02) continue;
            const fe = g.edges[f.edge];
            const sinA = Math.abs(ax.dx * (g.nodes[fe.b].z - g.nodes[fe.a].z) - ax.dz * (g.nodes[fe.b].x - g.nodes[fe.a].x)) / (fe.length || 1);
            if (sinA < 0.6) continue;
            // The mouth: clear of the foot street's junctions, inside its piece, cut in the piece's curb frame.
            const fk = foot.edges.indexOf(f.edge);
            const halfMouth = (CFG.rampHalf + 1) / sinA;
            const fa = g.nodes[fe.a];
            const fb = g.nodes[fe.b];
            const along = ((ax.fx - fa.x) * (fb.x - fa.x) + (ax.fz - fa.z) * (fb.z - fa.z)) / (fe.length || 1);
            const sFoot = foot.cum[fk] + (fe.a === foot.nodes[fk] ? along : fe.length - along);
            if (sFoot - halfMouth - MOUTH_TAPER < mouthReach(foot.nodes[0]) || foot.length - sFoot - halfMouth - MOUTH_TAPER < mouthReach(foot.nodes[foot.nodes.length - 1])) continue;
            const cut = mouthCut(g, mouths, f.edge, ax);
            if (!cut) continue;
            // Gentle: the lowest grade and the widest turn, with a mouth near square.
            layouts.push({ ax, edge: f.edge, cut, sinA, sa, sb, y0, y1, grade, score: -grade * 100 + r / 400 - (1 - sinA) });
          }
        }
      }
      layouts.sort((p, q) => q.score - p.score);
      let found: RampPlan | null = null;
      for (const lay of layouts.slice(0, 12)) {
        const plan = fitRamp(lay);
        if (!plan) continue;
        const cut = lay.cut;
        found = { axis: lay.ax, side, sa: lay.sa, sb: lay.sb, edge: lay.edge, mouthSide: cut.side, m0: cut.s0, m1: cut.s1, face: face.id, next: next.id, footEdges: foot.edges.slice(), polygon: plan.poly, building, sBlock, uSolid: plan.uSolid, rise: lay.y1 - lay.y0, grade: lay.grade };
        break;
      }
      if (found) cands.push(found);
    }
  }
  // In a seeded order, the gentlest first.
  rng.shuffle(cands);
  cands.sort((p, q) => p.grade - q.grade);
  const out: RampPlan[] = [];
  for (const c of cands) {
    if (out.length >= want) break;
    if (out.some((o) => o.face === c.face || o.next === c.next || o.face === c.next || o.next === c.face || Math.abs((o.sa + o.sb) / 2 - (c.sa + c.sb) / 2) < CFG.rampGap)) continue;
    out.push(c);
  }
  return out.length >= CFG.ramps[0] ? out : null;
}
