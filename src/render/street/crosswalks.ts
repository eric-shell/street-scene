/**
 * Where each street's crosswalks and the paint around them go: the one plan `cityMeshes` (stripes, lane
 * lines) and `streetDecals` (worn paint, cobbled bands, arrows, drains) both read, so they stay in step.
 *
 * A junction's mouth is the line between the two curb corners where the street's straight curbs end and the
 * curb returns begin. At a right-angle junction that line crosses the street square, but at a skewed one
 * (a Y, an acute T, a corner) the two corners sit at different distances along the street, up to ten meters
 * apart, and the straight road only starts at the later of them. A band laid 1.2 m in from the mouth's
 * midpoint then ran onto the curb return and, at a corner, lay across the other street's band. Every band is
 * measured from the later corner instead (`off`), which is the midpoint at a square junction.
 *
 * Crosswalks are for junctions: a node that only turns the road (two streets meeting at a corner, a width
 * change) has none, since there is nothing to cross to, and a street too short for both ends' bands keeps the
 * end with the squarer mouth. Pure geometry, no three.js.
 */
import { type RoadGraph, isBendNode, isChannelEdge } from '../../city/roadGraph';
import type { EdgeMouths } from '../../city/blocks';

/** Crosswalk and clear zone sizes (m). */
export const CROSSWALK = {
  /** The stripes run from this far to this far in from the straight road's start (the mouth's later corner). */
  from: 1.2,
  to: 4.2,
  /** Stripe width across the lane direction and spacing between stripe centers. */
  stripe: 0.55,
  pitch: 1.1,
  /** Lane lines start this far past a crosswalk's far end... */
  clearAfter: 0.8,
  /** ...and this far in from the straight road's start where the node has no crosswalk (a corner). */
  bareClear: 1.5,
  /** Two crosswalks on one street keep at least this much road between them. */
  gap: 1.5,
  /** Edges shorter than this (mouth midpoint to midpoint) are no street: no paint at all. */
  minLength: 8,
} as const;

/** One street's paint frame and where its two ends' crosswalks sit. */
export interface EdgePaint {
  /** Mouth midpoints (the curb corners' means), A and B end. */
  a: { x: number; z: number };
  b: { x: number; z: number };
  /** Midpoint to midpoint (m) and the unit direction a -> b. */
  len: number;
  dx: number;
  dz: number;
  /** How far past each mouth midpoint the straight road starts (m): half the corners' stagger along the street. */
  offA: number;
  offB: number;
  /** Whether each end carries a crosswalk, and (if so) how far in from the mouth midpoint its stripes start and end (m). */
  crossA: boolean;
  crossB: boolean;
  /** Where lane lines and edge lines start and stop, in m from each mouth midpoint (0 at a bend node, which is no corner). */
  clearA: number;
  clearB: number;
}

/** Half the distance along the street between a mouth's two curb corners (m): the straight road starts this far past the midpoint. */
function stagger(p: { x: number; z: number }, n: { x: number; z: number }, dx: number, dz: number): number {
  return Math.abs((p.x - n.x) * dx + (p.z - n.z) * dz) / 2;
}

/** Whether a node's streets cross each other: not a bend, and more than a corner. */
function isJunction(g: RoadGraph, node: number): boolean {
  return !isBendNode(g, node) && g.nodes[node].edges.length !== 2;
}

/** The paint plan of edge `ei`, or null for a channel or a street too short for any. */
export function edgePaint(g: RoadGraph, mouths: EdgeMouths[], ei: number): EdgePaint | null {
  const e = g.edges[ei];
  const m = mouths[ei];
  if (!m || isChannelEdge(e)) return null;
  const a = { x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 };
  const b = { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 };
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < CROSSWALK.minLength) return null;
  const dx = (b.x - a.x) / len;
  const dz = (b.z - a.z) / len;
  const bendA = isBendNode(g, e.a);
  const bendB = isBendNode(g, e.b);
  const offA = bendA ? 0 : stagger(m.aP.curb, m.aN.curb, dx, dz);
  const offB = bendB ? 0 : stagger(m.bP.curb, m.bN.curb, dx, dz);
  let crossA = isJunction(g, e.a);
  let crossB = isJunction(g, e.b);
  // Each band must fit on the road: its far end a meter short of the other end's straight road, and
  // two bands keep a gap between them. Where they do not both fit, the squarer mouth keeps its crosswalk.
  const fits = (off: number, other: number) => off + CROSSWALK.to + 1 <= len - other;
  if (crossA && !fits(offA, offB)) crossA = false;
  if (crossB && !fits(offB, offA)) crossB = false;
  if (crossA && crossB && len - offB - CROSSWALK.to - (offA + CROSSWALK.to) < CROSSWALK.gap) {
    if (offA > offB) crossA = false;
    else crossB = false;
  }
  const clear = (bend: boolean, cross: boolean, off: number) => (bend ? 0 : cross ? off + CROSSWALK.to + CROSSWALK.clearAfter : off + CROSSWALK.bareClear);
  return { a, b, len, dx, dz, offA, offB, crossA, crossB, clearA: clear(bendA, crossA, offA), clearB: clear(bendB, crossB, offB) };
}
