/**
 * The elevated highway's end loops, planned (highway.ts asks for them first
 * per candidate line, and drops a line that cannot end in them): at each end
 * the deck stops inside one of the last blocks along its line (the last one
 * where they fit, else the one before), and both carriageways leave it on a
 * cloverleaf loop of about three quarters of a circle through the block on
 * their side of the row street. The outgoing one curls off to its right and
 * down to a mouth on the row street's building line beneath the deck; the
 * incoming one comes up from a mouth across the street on its mirror image.
 * So a car leaving the deck lands on the street it has just driven over, and
 * one on that street turns off it to climb on, and nobody meets a wall.
 *
 * E (where a loop meets the deck) lies in the carriageway at the deck's end
 * (shape.ts LOOP_AT), heading inward along the deck; the foot is found along
 * the row street's building line once widened, joined to E by the tangent to
 * the loop's circle (rampAxis.ts rampAxisFrom). The widest loop is kept, the
 * deck reaching as far out as it can, whose grade stays under the cap, whose
 * mouth is a cut clear of the row street's junctions, whose embankment and
 * infield stay in its block and whose last stretch (out over the row street,
 * onto the deck's end) clears the street beneath, all of it clear of the El,
 * the river, a bluff and the roundabouts.
 */
import { CITY } from '../../config';
import type { BlockFace } from '../../blocks';
import { DEG, Vec2, sqrt } from '../../../sim/math';
import { distToPolygonEdge, pointInPolygon } from '../geom';
import { gridNode } from '../subway';
import { curvePoint, projectOnCurve, sampleCurve } from '../../railCurve';
import { RampProfile, axisAt, axisPoint, projectAxis, rampAxisFrom, rampHeightAlong, solveGrade } from './rampAxis';
import { HALF, LOOP_AT, loopFootprint, mouthCut, projectNear, rightOf } from './shape';
import { BLOCK_IN, BRIDGE_CLEAR, RampPlan, RampSite, SOLID_BACK, blockOf, plannedTop } from './rampPlan';
import { clearAt, elDistance } from './line';

const CFG = CITY.districts.highway;

/** One end of the deck: where it stops (both loops' E) and its two loops, the outgoing (down) one first. */
export interface EndPlan {
  /** -1: the deck's low s end (its west), +1: its high s end. */
  end: -1 | 1;
  /** The deck's end along the curve (s, m). */
  s: number;
  loops: RampPlan[];
}

/** How far a loop may turn (rad): about three quarters of a circle, its leg square to the street or leaning a little either way. */
const SWEEP: [number, number] = [228 * DEG, 300 * DEG];

/** The loop's straight leg is at least this long (m). */
const MIN_LEG = 6;

/** The deck between its end loops is at least this long (m): an end with no room for them near the map's edge moves in, no further. */
const MIN_DECK = 700;

/** Both ends of a line's deck with their loops, or null where an end has no room for them. */
export function planEnds(site: RampSite, cap: number): EndPlan[] | null {
  const W = CITY.gridW;
  const out: EndPlan[] = [];
  for (const end of [-1, 1] as const) {
    let found: EndPlan | null = null;
    for (const i of end < 0 ? [0, 1, 2, 3] : [W - 2, W - 3, W - 4, W - 5]) {
      found = endIn(site, i, end, cap);
      if (found) break;
    }
    if (!found) return null;
    out.push(found);
  }
  return out[1].s - out[0].s >= MIN_DECK ? out : null;
}

/** The deck's end in block i (columns i, i + 1), both loops fitting at the same s: the widest, the farthest out. */
function endIn(site: RampSite, i: number, end: -1 | 1, cap: number): EndPlan | null {
  const { ctx, line, curve } = site;
  const g = ctx.graph;
  const H = CITY.gridH;
  const j = line.rows[i];
  if (!site.rowChain(i, j)) return null;
  const A = gridNode(g, i, j);
  const B = gridNode(g, i + 1, j);
  const sA = projectOnCurve(curve, A.x, A.z).s;
  const sB = projectOnCurve(curve, B.x, B.z).s;
  const P = curvePoint();
  sampleCurve(curve, (sA + sB) / 2, P);
  const right = rightOf(P.tx, P.tz);
  // The block on each side of the row street there, between it and the next row over.
  const faceOn = (side: 1 | -1): BlockFace | null => {
    for (const dj of [-1, 1]) {
      const jj = j + dj;
      if (jj < 0 || jj >= H) continue;
      const m = gridNode(g, i, jj);
      if ((m.x - A.x) * right.x * side + (m.z - A.z) * right.z * side > 40) return blockOf(site, [A, B, m, gridNode(g, i + 1, jj)]);
    }
    return null;
  };
  const faces = { out: faceOn(end), in: faceOn(end > 0 ? -1 : 1) };
  if (!faces.out || !faces.in) return null;
  const h = CFG.loopHalf + 1;
  for (const R of CFG.loopRadius) {
    // From as far out as the loop's disc allows, inward: the deck reaching as far as it can.
    const sOut = end > 0 ? sB - R - h - 10 : sA + R + h + 10;
    const sIn = end > 0 ? sA + R + 20 : sB - R - 20;
    for (let s = sOut; (s - sIn) * end >= 0; s -= end * 3) {
      const out = fitLoop(site, i, end, end, s, R, faces.out, cap);
      if (!out) continue;
      const inn = fitLoop(site, i, end, end > 0 ? -1 : 1, s, R, faces.in, cap);
      if (!inn) continue;
      return { end, s, loops: [out, inn] };
    }
  }
  return null;
}

/**
 * The loop on `side` of the deck's end at sEnd in block i, radius R, or null: outgoing (down) on the
 * end's own side (traffic there runs out toward the end), incoming (up) on the other.
 */
function fitLoop(site: RampSite, i: number, end: -1 | 1, side: 1 | -1, sEnd: number, R: number, face: BlockFace, cap: number): RampPlan | null {
  const { ctx, hz, line, curve, terrain, mouths } = site;
  const g = ctx.graph;
  const on = side !== end;
  const along: 1 | -1 = end > 0 ? -1 : 1;
  const half = CFG.loopHalf;
  const row = site.rowChain(i, line.rows[i])!;
  const P = curvePoint();
  sampleCurve(curve, sEnd, P);
  const rs = rightOf(P.tx, P.tz);
  const E = { x: P.x + rs.x * side * LOOP_AT, z: P.z + rs.z * side * LOOP_AT };
  const t = { x: P.tx * along, z: P.tz * along };
  const away = { x: rs.x * side, z: rs.z * side };
  // How far along the row street its junctions reach: the cross streets' half corridors there.
  const crossReach = (node: number) => {
    let m = CITY.width.street / 2 + CITY.sidewalk;
    for (const eid of g.nodes[node].edges) {
      const e = g.edges[eid];
      const o = g.nodes[e.a === node ? e.b : e.a];
      const n = g.nodes[node];
      const l = sqrt((o.x - n.x) ** 2 + (o.z - n.z) ** 2) || 1;
      if (Math.abs(((o.x - n.x) * P.tx + (o.z - n.z) * P.tz) / l) < 0.75) m = Math.max(m, e.width / 2 + e.sidewalk);
    }
    return m;
  };
  const ends = [row.nodes[0], row.nodes[row.nodes.length - 1]].map((n) => ({ s: projectOnCurve(curve, g.nodes[n].x, g.nodes[n].z).s, reach: crossReach(n) + CFG.loopMouthClear }));
  // Feet along the row street's building line once it is widened (HALF out from each piece's line), in
  // the stretch where the loop's leg meets it, the ones nearest a square leg first.
  const feet: { p: Vec2; edge: number; s: number }[] = [];
  for (const eid of row.edges) {
    const e = g.edges[eid];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    // The piece's normal on the loop's side.
    const k = -uz * away.x + ux * away.z > 0 ? 1 : -1;
    const nx = -uz * k;
    const nz = ux * k;
    for (let d = 1; d < len - 1; d += 2) {
      const p = { x: a.x + ux * d + nx * HALF, z: a.z + uz * d + nz * HALF };
      const s = projectNear(curve, p.x, p.z, sEnd, 200).s;
      const back = (sEnd - s) * end;
      if (back > R - 16 && back < R + 34) feet.push({ p, edge: eid, s });
    }
  }
  feet.sort((p, q) => Math.abs((sEnd - p.s) * end - R) - Math.abs((sEnd - q.s) * end - R));
  // The loop's circle in the block (but where it turns out over the street beneath near E) and clear of
  // the hazards, before any foot is tried: most layouts fail here, cheaply.
  const inFace = (x: number, z: number) => pointInPolygon(x, z, face.ring) && distToPolygonEdge(x, z, face.ring) >= BLOCK_IN;
  const cx = E.x + away.x * R;
  const cz = E.z + away.z * R;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * 2 * Math.PI;
    const x = cx + Math.cos(a) * (R + half + 0.6);
    const z = cz + Math.sin(a) * (R + half + 0.6);
    if (!clearAt(hz, x, z, 6) || elDistance(hz, x, z) < CITY.districts.subway.deckWidth / 2 + 4) return null;
    if (Math.abs(projectNear(curve, x, z, sEnd, 160).lateral) <= HALF + 1.2) continue;
    if (!inFace(x, z)) return null;
  }
  const y1 = plannedTop(site, sEnd);
  const ap = axisPoint();
  for (const f of feet) {
    const ax = rampAxisFrom(f.p, E, t, away, R);
    if (!ax || ax.a < MIN_LEG) continue;
    const sweep = Math.abs(ax.sweep);
    // Three quarters round, the leg heading into the block away from the street beneath.
    if (sweep < SWEEP[0] || sweep > SWEEP[1] || ax.dx * away.x + ax.dz * away.z < 0.5) continue;
    const L = ax.length;
    const y0 = terrain.heightAt(ax.fx, ax.fz);
    const grade = solveGrade(L, y0, 0, y1, 0, CFG.loopEase, CFG.loopEase);
    if (grade > cap - 0.008 || grade < 0.02) continue;
    const fe = g.edges[f.edge];
    const sinA = Math.abs(ax.dx * (g.nodes[fe.b].z - g.nodes[fe.a].z) - ax.dz * (g.nodes[fe.b].x - g.nodes[fe.a].x)) / (fe.length || 1);
    if (sinA < 0.6) continue;
    // The mouth clear of the row street's junctions at both ends of the block (its curb cut is made where
    // it fits in one piece of the street; else a car rolls over the low curb).
    const halfMouth = (half + 1) / sinA;
    if (ends.some((n) => Math.abs(f.s - n.s) - halfMouth < n.reach)) continue;
    const cut = mouthCut(g, mouths, f.edge, ax, half) ?? { side: 1 as const, s0: 0, s1: 0 };
    const profile: RampProfile = { y0, g0: 0, y1, g1: 0, grade, e0: CFG.loopEase, e1: CFG.loopEase, blend: 14, flat: 0, ready: true };
    // Where the embankment ends: both edges in the block from where the leg's edges clear the mouth on,
    // up to where the loop turns out over the street beneath near its top.
    const inBlock = (x: number, z: number) => pointInPolygon(x, z, face.ring) && distToPolygonEdge(x, z, face.ring) >= BLOCK_IN && Math.abs(projectNear(curve, x, z, sEnd, 160).lateral) >= HALF + BLOCK_IN;
    const w = half + 0.6;
    const u0 = 3 + (w * Math.sqrt(Math.max(0, 1 - sinA * sinA))) / sinA;
    let uExit = L;
    for (let u = u0; u <= L; u += 2) {
      const q = axisAt(ax, u);
      if (inBlock(q.x - q.tz * w, q.z + q.tx * w) && inBlock(q.x + q.tz * w, q.z - q.tx * w)) continue;
      uExit = u;
      break;
    }
    const uSolid = uExit - SOLID_BACK;
    if (uSolid < 0.55 * L) continue;
    // All of it clear of the hazards; the embankment and the infield in the block; the last stretch over
    // the row street high enough over it.
    const poly = loopFootprint(ax, half, 0.6);
    let ok = true;
    for (const p of poly) {
      if (!clearAt(hz, p.x, p.z, 6) || elDistance(hz, p.x, p.z) < CITY.districts.subway.deckWidth / 2 + 4) {
        ok = false;
        break;
      }
      projectAxis(ax, p.x, p.z, ap);
      if (ap.u < u0) continue;
      const lat = Math.abs(projectNear(curve, p.x, p.z, sEnd, 160).lateral);
      if (ap.u > uSolid && lat <= HALF + 1.2) {
        if (rampHeightAlong(ax, profile, Math.min(L, ap.u)).y - terrain.heightAt(p.x, p.z) < BRIDGE_CLEAR) ok = false;
      } else if (!inBlock(p.x, p.z)) ok = false;
      if (!ok) break;
    }
    if (!ok) continue;
    return {
      axis: ax,
      side,
      on,
      loop: true,
      along,
      half,
      flat: 0,
      sa: sEnd,
      sb: sEnd,
      edge: f.edge,
      mouthSide: cut.side,
      m0: cut.s0,
      m1: cut.s1,
      face: face.id,
      footEdges: [],
      polygon: poly,
      building: HALF,
      sBlock: sEnd,
      uSolid,
      rise: y1 - y0,
      grade,
    };
  }
  return null;
}
