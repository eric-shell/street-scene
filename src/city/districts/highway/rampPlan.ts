/**
 * The elevated highway's on-ramps, planned (highway.ts asks for them per
 * candidate line, and drops a line that cannot have two): for every street
 * block the deck follows, on each side, the block between the deck's street
 * and the parallel one is the ramp's right of way. Its top (E) sits beside
 * the deck's edge at the block's far corner, heading the way traffic on that
 * side runs, and its lane merges on over the junction; its foot is found
 * along the parallel street's building line, joined to E by the tangent to a
 * turn's circle (rampAxis.ts rampAxisFrom), and the best layout is kept whose
 * grade stays under the cap (from the plain terrain and the deck's planned
 * height), whose mouth is a cut clear of the foot street's junctions and
 * whose outline stays in its block (over the sidewalk only near the top) and
 * clear of the El, the river, a bluff and the roundabouts. Then `want` of
 * them, one per block and spaced along the deck, away from the El crossing.
 */
import { CITY, ROUTE } from '../../config';
import { computeMouths } from '../../blocks';
import type { Terrain } from '../../terrain';
import { createTerrain } from '../../terrain';
import { DEG, Vec2, distToSegment } from '../../../sim/math';
import type { Rng } from '../../../sim/prng';
import type { PlanContext } from '../types';
import { distToPolygonEdge, pointInPolygon } from '../geom';
import { gridNode, streetChain } from '../subway';
import { RailCurve, buildRailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { RampAxis, axisPoint, projectAxis, rampAxisFrom, solveGrade } from './rampAxis';
import { CLOSURE_GAP, HALF, MERGE, MOUTH_TAPER, PLAIN, SOLID_TO_END, TAPER, elCrossings, mouthCut, rampOutline, rightOf } from './shape';
import { Hazards, LinePlan, alongChain, chainOfNodes, clearAt, elDistance } from './line';

const CFG = CITY.districts.highway;

/** The ramp's straight leg is at least this long (m): a square mouth. */
const MIN_LEG = 4;

/** The ramp's outline keeps this far inside its block (m). */
const BLOCK_IN = 1;

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
  /** The block the ramp climbs through and the foot street's edges. */
  face: number;
  footEdges: number[];
  polygon: Vec2[];
  /** The row street's building line offset from the deck's centerline on the ramp side (m), and where the ramp's block ends along the deck (s, m). */
  building: number;
  sBlock: number;
  /** Rise and grade as planned (m), from the plain terrain. */
  rise: number;
  grade: number;
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
 * side, the first layout (curve radius, leg angle) that fits the block between the deck's street and
 * the parallel one, with its mouth clear of the foot street's junctions and the rise within the grade
 * cap; then `want` of them kept, spaced along the deck and away from the El crossing.
 */
export function planRamps(ctx: PlanContext, hz: Hazards, line: LinePlan, want: number, rng: Rng): RampPlan[] | null {
  const g = ctx.graph;
  const W = CITY.gridW;
  const H = CITY.gridH;
  const curve = buildRailCurve(line.path, 1, 0, () => 0);
  const terrain = createTerrain(ctx.seed);
  const faces = ctx.faces();
  const mouths = computeMouths(g, ctx.sectors());
  const crossS = elCrossings(line.path, ctx.areas).map((p) => projectOnCurve(curve, p.x, p.z).s);
  const P = curvePoint();
  const cands: RampPlan[] = [];
  for (let i = 0; i + 1 < W; i++) {
    const j = line.rows[i];
    if (j < 0 || line.rows[i + 1] !== j) continue;
    const rowNodes = streetChain(g, gridNode(g, i, j).id, gridNode(g, i + 1, j).id);
    if (!rowNodes) continue;
    const row = chainOfNodes(g, rowNodes);
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
      if (jf < 0 || line.rows.some((r, k) => r === jf && (k === i || k === i + 1))) continue;
      const footNodes = streetChain(g, gridNode(g, i, jf).id, gridNode(g, i + 1, jf).id);
      if (!footNodes) continue;
      const foot = chainOfNodes(g, footNodes);
      if (foot.edges.some((e) => e < 0 || !PLAIN.has(g.edges[e].kind) || g.edges[e].bridge || g.edges[e].shortcut || ctx.claims.edge.has(e))) continue;
      // The block between them.
      const corners = [A, B, gridNode(g, i, jf), gridNode(g, i + 1, jf)];
      const mid = { x: corners.reduce((s, n) => s + n.x, 0) / 4, z: corners.reduce((s, n) => s + n.z, 0) / 4 };
      const face = faces.find((f) => !f.outer && pointInPolygon(mid.x, mid.z, f.ring));
      if (!face || ctx.claims.face.has(face.id)) continue;
      if (face.edges.some((e) => ctx.claims.edge.has(e) || !PLAIN.has(g.edges[e].kind) || g.edges[e].bridge || g.edges[e].shortcut)) continue;
      if (face.corners.some((c) => g.nodes[c.node].ring)) continue;
      // The ramp reaches the deck at the block's far corner (the gore nose there), and its lane merges on
      // over the junction the traffic on this side meets next: the widened deck is overhead there.
      const endNode = side > 0 ? B : A;
      let corner = 0;
      for (const eid of endNode.edges) corner = Math.max(corner, g.edges[eid].width / 2 + g.edges[eid].sidewalk);
      const sBlock = side > 0 ? sB - corner : sA + corner;
      const sa = sBlock - side * 3;
      const sb = sa + side * (MERGE + TAPER);
      if (crossS.some((s) => Math.abs(s - sa) < CFG.rampElClear || Math.abs(s - sb) < CFG.rampElClear)) continue;
      // The row street's building line on this side, from its piece at the merge.
      const rowAt = alongChain(g, row, Math.max(0, Math.min(row.length, (sa + sb) / 2 - sA)));
      const building = rowAt.w / 2 + rowAt.sw;
      sampleCurve(curve, sa, P);
      const tm = { x: P.tx * side, z: P.tz * side };
      const rs = rightOf(P.tx, P.tz);
      const E = { x: P.x + rs.x * side * (HALF + CFG.rampHalf), z: P.z + rs.z * side * (HALF + CFG.rampHalf) };
      const aw = { x: rs.x * side, z: rs.z * side };
      const y1 = groundNear(curve, terrain, sa) + CFG.clearance + CFG.depth + 0.4;
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
      const layouts: { ax: RampAxis; edge: number; grade: number; y0: number; score: number }[] = [];
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
          if (grade > CFG.rampGrade - 0.012 || grade < 0.02) continue;
          const fe = g.edges[f.edge];
          const sinA = Math.abs(ax.dx * (g.nodes[fe.b].z - g.nodes[fe.a].z) - ax.dz * (g.nodes[fe.b].x - g.nodes[fe.a].x)) / (fe.length || 1);
          if (sinA < 0.6) continue;
          // Gentle and square: a grade near a tenth, a turn near a right angle, a mouth near square.
          layouts.push({ ax, edge: f.edge, grade, y0, score: -Math.abs(grade - 0.1) * 20 - Math.abs(sweep - Math.PI / 2) - (1 - sinA) });
        }
      }
      layouts.sort((p, q) => q.score - p.score);
      let found: RampPlan | null = null;
      for (const lay of layouts.slice(0, 8)) {
        const ax = lay.ax;
        const L = ax.length;
        const footEdge = lay.edge;
        // The mouth: clear of the foot street's junctions, inside its piece.
        const fk = foot.edges.indexOf(footEdge);
        const fe = g.edges[footEdge];
        const sinA = Math.abs(ax.dx * (g.nodes[fe.b].z - g.nodes[fe.a].z) - ax.dz * (g.nodes[fe.b].x - g.nodes[fe.a].x)) / (fe.length || 1);
        const halfMouth = (CFG.rampHalf + 1) / sinA;
        const fa = g.nodes[fe.a];
        const fb = g.nodes[fe.b];
        const along = ((ax.fx - fa.x) * (fb.x - fa.x) + (ax.fz - fa.z) * (fb.z - fa.z)) / (fe.length || 1);
        const sFoot = foot.cum[fk] + (fe.a === foot.nodes[fk] ? along : fe.length - along);
        const reach = (node: number) => {
          let m = 0;
          for (const id of g.nodes[node].edges) m = Math.max(m, g.edges[id].width / 2 + g.edges[id].sidewalk);
          return m + Math.max(ROUTE.barrierSetbackHeadOn + CLOSURE_GAP, ROUTE.railReach + 3) + CFG.rampMouthClear;
        };
        if (sFoot - halfMouth - MOUTH_TAPER < reach(foot.nodes[0]) || foot.length - sFoot - halfMouth - MOUTH_TAPER < reach(foot.nodes[foot.nodes.length - 1])) continue;
        // The cut in the piece's curb frame (the block's side of it).
        const cut = mouthCut(g, mouths, footEdge, ax);
        if (!cut) continue;
        // The ramp's outline inside its block (past the foot's building line, and over the sidewalk only
        // near its top), the merge's outer edge too; clear of the El and the hazards.
        const poly = rampOutline(ax, curve, side, sa, sb, 0.6);
        let ok = true;
        const ap = axisPoint();
        for (const p of poly) {
          projectAxis(ax, p.x, p.z, ap);
          const nearDeck = ap.u > L - SOLID_TO_END;
          let lateral = Infinity;
          for (let k = 0; k + 1 < row.nodes.length; k++) {
            const n0 = g.nodes[row.nodes[k]];
            const n1 = g.nodes[row.nodes[k + 1]];
            lateral = Math.min(lateral, distToSegment(p.x, p.z, n0.x, n0.z, n1.x, n1.z));
          }
          const inBlock = pointInPolygon(p.x, p.z, face.ring) && distToPolygonEdge(p.x, p.z, face.ring) >= BLOCK_IN;
          const overStrip = nearDeck && lateral <= building + 1.2 && lateral >= HALF - 1.2;
          const atMouth = ap.u < 3;
          // The merge (past E) runs on over the junction and into the next block's corner, two levels.
          const merging = ap.u > L - 0.5 && Math.abs(ap.v) >= 0;
          if (!inBlock && !overStrip && !atMouth && !merging) ok = false;
          if (!clearAt(hz, p.x, p.z, 6) || elDistance(hz, p.x, p.z) < CITY.districts.subway.deckWidth / 2 + 4) ok = false;
          if (!ok) break;
        }
        if (!ok) continue;
        found = { axis: ax, side, sa, sb, edge: footEdge, mouthSide: cut.side, m0: cut.s0, m1: cut.s1, face: face.id, footEdges: foot.edges.slice(), polygon: poly, building, sBlock, rise: y1 - lay.y0, grade: lay.grade };
        break;
      }
      if (found) cands.push(found);
    }
  }
  rng.shuffle(cands);
  const out: RampPlan[] = [];
  for (const c of cands) {
    if (out.length >= want) break;
    if (out.some((o) => o.face === c.face || Math.abs((o.sa + o.sb) / 2 - (c.sa + c.sb) / 2) < CFG.rampGap)) continue;
    out.push(c);
  }
  return out.length >= CFG.ramps[0] ? out : null;
}
