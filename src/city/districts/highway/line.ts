/**
 * The elevated highway's line (highway.ts plans with it): the El's planner
 * (subway.ts) turned on its side. A line follows one grid row's streets from
 * the map's west edge to its east, centered over them, and swings to the next
 * row on a diagonal street of its own laid across one block corner to corner
 * (like the city's diagonal avenues), the deck turning onto and off it on an
 * arc through each junction (fillet); where a row's street is missing it is
 * laid again; run-offs carry the line on past both map edges. So every
 * stretch of the deck in the city stands over a street, widened (highway.ts
 * commit) for cars to drive beneath the whole way. planLine walks the streets on the graph as it is (bend nodes and all)
 * and says no where the line cannot go: a claimed street or junction (the
 * El's and a roundabout's ring excepted: the deck passes over them; where
 * an alley ends, the street keeps its width so the alley's mouth stays as
 * it was), too many missing streets, a swing
 * whose diagonal would squeeze a junction's sectors, cross another street or
 * come near the El, a diagonal or the river, the deck near the river channel
 * or a bluff, or a second crossing of the El. Pure.
 */
import { CITY } from '../../config';
import type { RoadGraph, RoadNode } from '../../roadGraph';
import { edgeAngleFrom, edgeBetween } from '../../roadGraph';
import { DEG, Vec2, atan2, cos, distToSegment, sin, sqrt, tan } from '../../../sim/math';
import { Rng, deriveSeed } from '../../../sim/prng';
import type { Area, PlanContext } from '../types';
import { distToPolygonEdge, pointInPolygon } from '../geom';
import { riverCenter } from '../river';
import { bluffFootprint } from '../bluff';
import { gridNode, streetChain } from '../subway';
import { HALF, PLAIN, elCrossings, segmentHit } from './shape';

const CFG = CITY.districts.highway;

/** A swing's diagonal keeps this far from a diagonal avenue (m). */
const DIAGONAL_CLEAR = 45;

/** A street the line lays keeps this far from every junction and bend it does not join (m). */
const NODE_GAP = 22;

/** The deck keeps this far beyond the river channel's top edge (m, past its own half width). */
const RIVER_CLEAR = 14;

/** At most this many blocks of the line may have no street under the deck (laid again). */
const MAX_MISSING = 2;

/** Run-off straight on past each end node (m), at least, and on until past the map's edge. */
const RUN_OFF = 70;

/** Fillet arcs are sampled about this often (m). */
const ARC_STEP = 4;

/** Half corridor of a plain street (m): what the line lays where an alley ends. */
const PLAIN_HALF = CITY.width.street / 2 + CITY.sidewalk;

/** Whether a seed gets a highway: the first draw of the module's own stream (index.ts makeContext's). */
export function highwayRolled(seed: number): boolean {
  return CFG.enabled && new Rng(deriveSeed(seed, 'district:highway')).chance(CFG.chance);
}

/**
 * The rows the plan tries a line on, in its order: the middle rows shuffled by `rng` (the module's own
 * stream, right after its roll), then the two next to the map's edges. Shared with the lake, which keeps
 * its shore off the first of them on a seed that rolls a highway (lake.ts).
 */
export function highwayRows(rng: Rng, H: number): number[] {
  const rows: number[] = [];
  for (let j = 2; j <= H - 3; j++) rows.push(j);
  rng.shuffle(rows);
  // Rows next to the edges come last: a highway along the map's rim is seen by few races.
  rows.push(1, H - 2);
  return rows;
}

/** A swing: the line leaves row `from` at column i0 and joins row `to` at column i1 = i0 + 1, on a diagonal across the block between. */
export interface Swing {
  i0: number;
  i1: number;
  from: number;
  to: number;
}

/** A street walked node to node. */
export interface Chain {
  nodes: number[];
  edges: number[];
  cum: number[];
  length: number;
}

interface Anchor {
  p: Vec2;
  t: Vec2;
}

/** A planned line before it is an area. */
export interface LinePlan {
  path: Vec2[];
  /** Path index of every column's anchor (a swing's junction: its fillet's middle), and the row the line's street is on there. */
  at: number[];
  rows: number[];
  /** Unclaimed junctions and street pieces under the deck (the deck's area claims them). */
  nodes: number[];
  edges: number[];
  /** Every street piece under the deck, claimed or not: widened when the line is committed. */
  widen: number[];
  /** Streets under the deck at a plain street's width (an alley ends at one of their junctions: blocks kept as they were, fills and diagonals laid so), junction to junction. */
  narrow: [number, number][];
  /** Missing row streets laid again (grid node pairs) and swing diagonals (grid node pairs). */
  fills: [number, number][];
  diagonals: [number, number][];
  /** The swings' junctions, where the deck cuts the corner on its fillet. */
  turns: Vec2[];
  length: number;
  swings: number;
  /** Length of the streets the line lays (m). */
  offStreet: number;
}

function edgeJoining(g: RoadGraph, a: number, b: number): number {
  for (const eid of g.nodes[a].edges) {
    const e = g.edges[eid];
    if (e.shortcut) continue;
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return eid;
  }
  return -1;
}

export function chainOfNodes(g: RoadGraph, nodes: number[]): Chain {
  const edges: number[] = [];
  const cum = [0];
  for (let k = 0; k + 1 < nodes.length; k++) {
    edges.push(edgeJoining(g, nodes[k], nodes[k + 1]));
    const a = g.nodes[nodes[k]];
    const b = g.nodes[nodes[k + 1]];
    cum.push(cum[k] + sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2));
  }
  return { nodes, edges, cum, length: cum[cum.length - 1] };
}

/** Point s along a chain, the street's unit direction there, its width, sidewalk and edge. */
export function alongChain(g: RoadGraph, ch: Chain, s: number): { x: number; z: number; dx: number; dz: number; w: number; sw: number; edge: number } {
  let k = 0;
  while (k + 2 < ch.cum.length && ch.cum[k + 1] < s) k++;
  const a = g.nodes[ch.nodes[k]];
  const b = g.nodes[ch.nodes[k + 1]];
  const len = ch.cum[k + 1] - ch.cum[k] || 1;
  const dx = (b.x - a.x) / len;
  const dz = (b.z - a.z) / len;
  const t = s - ch.cum[k];
  const e = ch.edges[k];
  return { x: a.x + dx * t, z: a.z + dz * t, dx, dz, w: e >= 0 ? g.edges[e].width : CITY.width.street, sw: e >= 0 ? g.edges[e].sidewalk : CITY.sidewalk, edge: e };
}

/** Deck outline polygon around a path. */
export function outline(path: readonly Vec2[], hw: number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  path.forEach((p, j) => {
    const a = path[Math.max(0, j - 1)];
    const b = path[Math.min(path.length - 1, j + 1)];
    const l = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    left.push({ x: p.x + nx * hw, z: p.z + nz * hw });
    right.push({ x: p.x - nx * hw, z: p.z - nz * hw });
  });
  return left.concat(right.reverse());
}

/**
 * The deck's arc through a corner C between an incoming direction u and an outgoing one v (units): from
 * T before C to T past it, the tangent arc of radius T / tan(turn / 2), sampled every ARC_STEP m.
 */
export function fillet(C: Vec2, u: Vec2, v: Vec2, T: number): { pts: Vec2[]; r: number } {
  const phi = atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z);
  const turn = Math.abs(phi);
  if (turn < 1e-3) return { pts: [{ x: C.x, z: C.z }], r: Infinity };
  const r = T / tan(turn / 2);
  const A = { x: C.x - u.x * T, z: C.z - u.z * T };
  // The center lies to the side the path turns to: u turned +90 degrees (x, z) -> (-z, x) for a positive turn.
  const sg = phi > 0 ? 1 : -1;
  const cx = A.x - u.z * r * sg;
  const cz = A.z + u.x * r * sg;
  const a0 = atan2(A.z - cz, A.x - cx);
  const n = Math.max(2, Math.ceil((r * turn) / ARC_STEP));
  const pts: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (phi * k) / n;
    pts.push({ x: cx + r * cos(a), z: cz + r * sin(a) });
  }
  return { pts, r };
}

/** What the planner keeps the deck and its ramps clear of. */
export interface Hazards {
  rivers: Area[];
  bluffs: Vec2[][];
  rings: RoadNode[];
  /** The El's path sampled every few meters. */
  el: Vec2[];
}

export function hazards(ctx: PlanContext): Hazards {
  const el: Vec2[] = [];
  for (const a of ctx.areas) {
    if (a.kind !== 'subway') continue;
    const p = a.path;
    for (let i = 0; i + 1 < p.length; i++) {
      const n = Math.max(1, Math.ceil(Math.hypot(p[i + 1].x - p[i].x, p[i + 1].z - p[i].z) / 5));
      for (let k = 0; k < n; k++) el.push({ x: p[i].x + ((p[i + 1].x - p[i].x) * k) / n, z: p[i].z + ((p[i + 1].z - p[i].z) * k) / n });
    }
  }
  return { rivers: ctx.areas.filter((a) => a.kind === 'river'), bluffs: ctx.areas.filter((a) => a.kind === 'bluff').map((a) => bluffFootprint(a)), rings: ctx.graph.nodes.filter((n) => n.ring), el };
}

/** Clear of the river channel, a bluff and (unless `rings` is false: the deck spans over one) every roundabout by `margin` (m). */
export function clearAt(hz: Hazards, x: number, z: number, margin: number, rings = true): boolean {
  for (const r of hz.rivers) {
    if (x < r.params.x0 - margin || x > r.params.x1 + margin) continue;
    if (Math.abs(z - riverCenter(r.params, x)) < r.params.top + margin) return false;
  }
  for (const p of hz.bluffs) if (pointInPolygon(x, z, p) || distToPolygonEdge(x, z, p) < margin) return false;
  if (rings) for (const n of hz.rings) if ((n.x - x) ** 2 + (n.z - z) ** 2 < (n.ring!.outer + CITY.sidewalk + margin) ** 2) return false;
  return true;
}

/** Distance to the El's path (m), Infinity without one. */
export function elDistance(hz: Hazards, x: number, z: number): number {
  let d2 = Infinity;
  for (const p of hz.el) d2 = Math.min(d2, (p.x - x) ** 2 + (p.z - z) ** 2);
  return sqrt(d2);
}

/** Claimed by nobody, or by the El (its column node where the lines cross, the row streets its swings cross). */
function freeOrEl(ctx: PlanContext, claim: number | undefined): boolean {
  return claim === undefined || ctx.areas[claim].kind === 'subway';
}

/**
 * Whether a street the line lays from node a to node b (half corridor `half`) fits: no node past degree
 * maxNodeDegree (counting the streets the line already lays there, `added`), sectors at both ends at least swingSectorDeg and their corners short of the street
 * pieces beside them, no other street crossed or junction or bend within NODE_GAP, no diagonal avenue
 * near (a swing's), clear of the El by both decks' half widths.
 */
function layable(g: RoadGraph, hz: Hazards, a: number, b: number, half: number, swing: boolean, added: Map<number, number>): boolean {
  const A = g.nodes[a];
  const B = g.nodes[b];
  if (edgeBetween(g, a, b) >= 0) return false;
  for (const [n, m] of [
    [A, B],
    [B, A],
  ]) {
    if (n.edges.length + (added.get(n.id) ?? 0) + 1 > CITY.maxNodeDegree || n.ring) return false;
    const ang = atan2(m.z - n.z, m.x - n.x);
    for (const eid of n.edges) {
      const e = g.edges[eid];
      let d = Math.abs(edgeAngleFrom(g, e, n.id) - ang);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d < CFG.swingSectorDeg * DEG) return false;
      // The corner between the two streets reaches (h1 + h2 cos d) / sin d along each from the node:
      // short of the piece beside it, so the corner never runs past that piece's far node.
      const other = e.width / 2 + e.sidewalk;
      if (d < Math.PI / 2 && (other + half * cos(d)) / sin(d) > e.length - 6) return false;
    }
  }
  const near = new Set<number>([a, b]);
  for (const id of [a, b]) {
    for (const eid of g.nodes[id].edges) {
      const e = g.edges[eid];
      near.add(e.a);
      near.add(e.b);
    }
  }
  for (const e of g.edges) {
    if (e.a === a || e.a === b || e.b === a || e.b === b) continue;
    const p = g.nodes[e.a];
    const q = g.nodes[e.b];
    if (segmentHit(A, B, p, q)) return false;
    if (swing && e.kind === 'diagonal' && Math.min(distToSegment(p.x, p.z, A.x, A.z, B.x, B.z), distToSegment(q.x, q.z, A.x, A.z, B.x, B.z)) < DIAGONAL_CLEAR) return false;
  }
  for (const n of g.nodes) {
    if (near.has(n.id)) continue;
    if (distToSegment(n.x, n.z, A.x, A.z, B.x, B.z) < NODE_GAP) return false;
  }
  if (swing) {
    const L = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    for (let s = 0; s <= L; s += 5) {
      const x = A.x + ((B.x - A.x) * s) / L;
      const z = A.z + ((B.z - A.z) * s) / L;
      if (elDistance(hz, x, z) < HALF + CITY.districts.subway.deckWidth / 2 + 6) return false;
    }
  }
  return true;
}

/**
 * The line along the rows per column (`rows`, the swings' rows as they leave and join) with the given
 * swings, or null where it does not fit: a claimed node or street on its way (the El's excepted), an
 * alley's end or a roundabout, too many missing streets, a swing or a missing street that cannot be
 * laid, a diagonal near a swing, the deck near the river channel, a bluff or a roundabout's ring, or
 * crossing the El more than once.
 */
export function planLine(ctx: PlanContext, hz: Hazards, rows: readonly number[], swings: readonly Swing[]): LinePlan | null {
  const g = ctx.graph;
  const W = g.plan.gridW;
  const H = g.plan.gridH;
  const chains = new Map<number, Chain | null>();
  const streetAt = (i: number, j: number): Chain | null => {
    if (i < 0 || i + 1 >= W || j < 0 || j >= H) return null;
    const key = j * 64 + i;
    let ch = chains.get(key);
    if (ch === undefined) {
      const nodes = streetChain(g, gridNode(g, i, j).id, gridNode(g, i + 1, j).id);
      ch = nodes ? chainOfNodes(g, nodes) : null;
      chains.set(key, ch);
    }
    return ch;
  };
  /** The row's direction at column i on row j: along its street before (`before`) or after the junction, else its chord. */
  const rowDir = (i: number, j: number, before: boolean): Vec2 => {
    const n = gridNode(g, i, j);
    const ch = before ? streetAt(i - 1, j) : streetAt(i, j);
    let tx: number;
    let tz: number;
    if (ch) {
      const o = before ? g.nodes[ch.nodes[ch.nodes.length - 2]] : g.nodes[ch.nodes[1]];
      tx = before ? n.x - o.x : o.x - n.x;
      tz = before ? n.z - o.z : o.z - n.z;
    } else {
      const m = gridNode(g, Math.min(W - 1, i + 1), j);
      const o = gridNode(g, Math.max(0, i - 1), j);
      tx = m.x - o.x;
      tz = m.z - o.z;
    }
    const l = sqrt(tx * tx + tz * tz) || 1;
    return { x: tx / l, z: tz / l };
  };
  const anchorAt = (i: number, j: number): Anchor => {
    const n = gridNode(g, i, j);
    const b = i > 0 && rows[i - 1] === j ? rowDir(i, j, true) : null;
    const a = i + 1 < W && rows[i + 1] === j ? rowDir(i, j, false) : null;
    let tx = (b?.x ?? 0) + (a?.x ?? 0);
    let tz = (b?.z ?? 0) + (a?.z ?? 0);
    if (!a && !b) {
      const d = rowDir(i, j, false);
      tx = d.x;
      tz = d.z;
    }
    const l = sqrt(tx * tx + tz * tz) || 1;
    return { p: { x: n.x, z: n.z }, t: { x: tx / l, z: tz / l } };
  };
  // A junction under the deck: unclaimed, the El's, an alley's or a roundabout's ring (a long span over it,
  // its columns clear). Where an alley ends, the row's street blocks either side keep their width (`narrow`).
  const nodeOk = (n: RoadNode) => {
    const claim = ctx.claims.node.get(n.id);
    return freeOrEl(ctx, claim) || ['alley', 'roundabout'].includes(ctx.areas[claim!].kind);
  };
  /** An alley ends here: the street pieces either side keep their width, so its mouth stays as it was. */
  const alleyAt = (n: RoadNode) => n.edges.some((e) => g.edges[e].kind === 'alley');
  const plainEdge = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    return PLAIN.has(e.kind) && !e.bridge && !e.shortcut && freeOrEl(ctx, ctx.claims.edge.get(eid));
  };
  const under = HALF;

  // The corner polyline first: the row streets node to node, a swing's diagonal straight between its
  // junctions, a missing street straight between its; then the swings' junctions filleted.
  const corner: Vec2[] = [];
  const at = new Array<number>(W).fill(-1);
  const turnAt: { k: number; i: number }[] = [];
  const nodes: number[] = [];
  const edges: number[] = [];
  const widen: number[] = [];
  const fills: [number, number][] = [];
  const diagonals: [number, number][] = [];
  const turns: Vec2[] = [];
  const narrow: [number, number][] = [];
  const added = new Map<number, number>();
  const lay = (a: number, b: number) => {
    added.set(a, (added.get(a) ?? 0) + 1);
    added.set(b, (added.get(b) ?? 0) + 1);
  };
  let missing = 0;
  let offStreet = 0;
  for (let i = 0; i < W; ) {
    const j = rows[i];
    if (j < 0) return null;
    const n = gridNode(g, i, j);
    if (!nodeOk(n)) return null;
    at[i] = corner.length;
    corner.push({ x: n.x, z: n.z });
    if (!ctx.claims.node.has(n.id)) nodes.push(n.id);
    const sw = swings.find((s) => s.i0 === i);
    if (sw) {
      const m = gridNode(g, sw.i1, sw.to);
      // A swing turns at plain junctions (never the El's or a roundabout); at an alley's end its diagonal
      // is laid at a plain street's width, so the alley's mouth stays as it was.
      if (ctx.claims.node.has(n.id) || ctx.claims.node.has(m.id)) return null;
      const keep = alleyAt(n) || alleyAt(m);
      if (!layable(g, hz, n.id, m.id, keep ? PLAIN_HALF : under, true, added)) return null;
      lay(n.id, m.id);
      diagonals.push([n.id, m.id]);
      if (keep) narrow.push([n.id, m.id]);
      turnAt.push({ k: corner.length - 1, i });
      turnAt.push({ k: corner.length, i: sw.i1 });
      turns.push({ x: n.x, z: n.z }, { x: m.x, z: m.z });
      offStreet += sqrt((m.x - n.x) ** 2 + (m.z - n.z) ** 2);
      i = sw.i1;
      continue;
    }
    if (i + 1 < W) {
      const ch = streetAt(i, j);
      if (!ch) {
        missing++;
        const m = gridNode(g, i + 1, j);
        const keep = alleyAt(n) || alleyAt(m);
        if (!layable(g, hz, n.id, m.id, keep ? PLAIN_HALF : under, false, added)) return null;
        lay(n.id, m.id);
        fills.push([n.id, m.id]);
        if (keep) narrow.push([n.id, m.id]);
        offStreet += sqrt((m.x - n.x) ** 2 + (m.z - n.z) ** 2);
      } else {
        for (const e of ch.edges) if (!plainEdge(e)) return null;
        for (let k = 1; k + 1 < ch.nodes.length; k++) {
          const id = ch.nodes[k];
          if (!nodeOk(g.nodes[id])) return null;
          corner.push({ x: g.nodes[id].x, z: g.nodes[id].z });
          if (!ctx.claims.node.has(id)) nodes.push(id);
        }
        const keep = alleyAt(n) || alleyAt(gridNode(g, i + 1, j));
        if (keep) narrow.push([n.id, gridNode(g, i + 1, j).id]);
        for (const e of ch.edges) {
          if (!keep) widen.push(e);
          if (!ctx.claims.edge.has(e)) edges.push(e);
        }
      }
    }
    i++;
  }
  if (missing > MAX_MISSING) return null;
  // Fillets at the swings' junctions: the corner points within the tangent length either side make way
  // for the arc (the row's bend nodes near the junction), and the arc must be round enough.
  const path: Vec2[] = [];
  const T = CFG.swingTangent;
  const dist = (p: Vec2, q: Vec2) => sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
  const unit = (p: Vec2, q: Vec2): Vec2 => {
    const l = dist(p, q) || 1;
    return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
  };
  const newAt = new Array<number>(corner.length).fill(-1);
  for (let k = 0; k < corner.length; k++) {
    const t = turnAt.find((q) => q.k === k);
    if (!t) {
      // Skip a corner point inside a neighbouring fillet's reach.
      if (turnAt.some((q) => q.k !== k && dist(corner[q.k], corner[k]) < T + 2)) continue;
      newAt[k] = path.length;
      path.push(corner[k]);
      continue;
    }
    const C = corner[k];
    // The row's direction on the way in or out; the diagonal's straight to the other junction.
    const isStart = turnAt.indexOf(t) % 2 === 0;
    const other = isStart ? corner[k + 1] : corner[k - 1];
    const u = isStart ? (t.i > 0 ? rowDir(t.i, rows[t.i], true) : unit(C, other)) : unit(other, C);
    const v = isStart ? unit(C, other) : t.i + 1 < W ? rowDir(t.i, rows[t.i], false) : unit(other, C);
    const f = fillet(C, u, v, T);
    if (f.r < CFG.swingRadius) return null;
    newAt[k] = path.length + Math.floor(f.pts.length / 2);
    for (const p of f.pts) path.push(p);
  }
  for (let i = 0; i < W; i++) at[i] = newAt[at[i]];
  if (at.some((k) => k < 0)) return null;
  // Run-offs straight on along the end streets, on until past the map's edge.
  const t0 = anchorAt(0, rows[0]).t;
  const tN = anchorAt(W - 1, rows[W - 1]).t;
  const exitDist = (p: Vec2, dx: number, dz: number) => {
    const b = g.bounds;
    let d = Infinity;
    if (dx > 1e-6) d = Math.min(d, (b.maxX - p.x) / dx);
    if (dx < -1e-6) d = Math.min(d, (b.minX - p.x) / dx);
    if (dz > 1e-6) d = Math.min(d, (b.maxZ - p.z) / dz);
    if (dz < -1e-6) d = Math.min(d, (b.minZ - p.z) / dz);
    return d;
  };
  const r0 = Math.min(200, Math.max(RUN_OFF, exitDist(path[0], -t0.x, -t0.z) + 10));
  const last = path[path.length - 1];
  const rN = Math.min(200, Math.max(RUN_OFF, exitDist(last, tN.x, tN.z) + 10));
  path.unshift({ x: path[0].x - t0.x * r0, z: path[0].z - t0.z * r0 });
  path.push({ x: last.x + tN.x * rN, z: last.z + tN.z * rN });
  for (let i = 0; i < W; i++) at[i]++;
  // The deck clear of the river, a bluff and every roundabout, across its whole width; the El crossed once at most.
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    length += len;
    const nx = -(q.z - p.z) / (len || 1);
    const nz = (q.x - p.x) / (len || 1);
    for (let s = 0; s < len; s += 5) {
      for (const v of [-HALF, 0, HALF]) {
        const x = p.x + ((q.x - p.x) * s) / len + nx * v;
        const z = p.z + ((q.z - p.z) * s) / len + nz * v;
        if (!clearAt(hz, x, z, RIVER_CLEAR, false)) return null;
      }
    }
  }
  if (elCrossings(path, ctx.areas).length > 1) return null;
  return { path, at, rows: rows.slice(), nodes, edges, widen, narrow, fills, diagonals, turns, length, swings: swings.length, offStreet };
}
