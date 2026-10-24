/**
 * The elevated highway's line (highway.ts plans with it): the El's planner
 * (subway.ts) turned on its side. A line follows one grid row's streets from
 * the map's west edge to its east, centered over them, runs straight over a
 * block where the street is missing, and swings to the next row through the
 * blocks on a tangent S curve (the El's cubic) past a junction; run-offs carry
 * it on past both map edges. planLine walks the streets on the graph as it is
 * (bend nodes and all) and says no where the line cannot go: a claimed street
 * or junction (the El's, an alley's end and a roundabout's ring excepted: the
 * deck passes over them), an alley, too many missing streets, a swing too
 * tight or too near a junction, a diagonal or the river, the deck near the
 * river channel or a bluff, or a second crossing of the El. Pure.
 */
import { CITY } from '../../config';
import type { RoadGraph, RoadNode } from '../../roadGraph';
import { Vec2, atan2, distToSegment, sqrt } from '../../../sim/math';
import { Rng, deriveSeed } from '../../../sim/prng';
import type { Area, PlanContext } from '../types';
import { distToPolygonEdge, pointInPolygon } from '../geom';
import { riverCenter } from '../river';
import { bluffFootprint } from '../bluff';
import { gridNode, streetChain } from '../subway';
import { HALF, PLAIN, elCrossings, segmentHit } from './shape';

const CFG = CITY.districts.highway;

/** A swing crosses a column street at least this far from its junctions (m): the deck is wide. */
const CROSS_NODE_CLEAR = 38;

/** A swing keeps this far from a diagonal avenue (m). */
const DIAGONAL_CLEAR = 45;

/** The deck keeps this far beyond the river channel's top edge (m, past its own half width). */
const RIVER_CLEAR = 14;

/** At most this many blocks of the line may have no street under the deck. */
const MAX_MISSING = 2;

/** Run-off straight on past each end node (m), at least, and on until past the map's edge. */
const RUN_OFF = 70;

/** Whether a seed gets a highway: the first draw of the module's own stream (index.ts makeContext's). */
export function highwayRolled(seed: number): boolean {
  return CFG.enabled && new Rng(deriveSeed(seed, 'district:highway')).chance(CFG.chance);
}

/** A swing: the line leaves row `from` at column i0 and joins row `to` at column i1. */
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
  /** Path index of every column's anchor, and the row the line's street is on there (-1 inside a swing). */
  at: number[];
  rows: number[];
  nodes: number[];
  edges: number[];
  /** Column streets the swings cross. */
  crossed: number[];
  length: number;
  swings: number;
  /** Length of the line off its streets (m): through blocks. */
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

function polylineCrossing(pts: readonly Vec2[], line: readonly Vec2[]): { i: number; p: Vec2 } | null {
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let k = 0; k + 1 < line.length; k++) {
      const h = segmentHit(pts[i], pts[i + 1], line[k], line[k + 1]);
      if (h) return { i, p: h.p };
    }
  }
  return null;
}

/** The cubic S curve of a swing (the El's, subway.ts cubicPath). */
function cubicPath(A: Vec2, tA: Vec2, B: Vec2, tB: Vec2, step: number): Vec2[] {
  const chord = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
  const k = chord * 0.4;
  const C1 = { x: A.x + tA.x * k, z: A.z + tA.z * k };
  const C2 = { x: B.x - tB.x * k, z: B.z - tB.z * k };
  const N = Math.max(4, Math.ceil(chord / step));
  const pts: Vec2[] = [A];
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const u = 1 - t;
    pts.push({ x: u * u * u * A.x + 3 * u * u * t * C1.x + 3 * u * t * t * C2.x + t * t * t * B.x, z: u * u * u * A.z + 3 * u * u * t * C1.z + 3 * u * t * t * C2.z + t * t * t * B.z });
  }
  pts.push(B);
  return pts;
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
 * A junction the deck may pass over: unclaimed, the El's, an alley's end (the alley is a side street
 * there; the deck's own streets are checked by kind) or a roundabout's ring (a long span over it,
 * its columns clear of the ring).
 */
function nodeOk(ctx: PlanContext, n: RoadNode): boolean {
  const claim = ctx.claims.node.get(n.id);
  if (claim === undefined) return true;
  const kind = ctx.areas[claim].kind;
  return kind === 'subway' || kind === 'alley' || kind === 'roundabout';
}

/**
 * The line along the rows per column (`rows`, -1 inside a swing) with the given swings, or null where
 * it does not fit: a claimed node or street on its way (the El's excepted), an alley, a roundabout,
 * too many missing streets, a swing too tight or near a junction, a diagonal or the river, the deck
 * near the river channel, a bluff or a roundabout's ring, or crossing the El more than once.
 */
export function planLine(ctx: PlanContext, hz: Hazards, rows: readonly number[], swings: readonly Swing[]): LinePlan | null {
  const g = ctx.graph;
  const W = CITY.gridW;
  const H = CITY.gridH;
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
  const anchorAt = (i: number, j: number): Anchor => {
    const n = gridNode(g, i, j);
    let tx = 0;
    let tz = 0;
    const before = rows[i - 1] === j ? streetAt(i - 1, j) : null;
    const after = rows[i + 1] === j ? streetAt(i, j) : null;
    if (before) {
      const p = g.nodes[before.nodes[before.nodes.length - 2]];
      const l = sqrt((n.x - p.x) ** 2 + (n.z - p.z) ** 2) || 1;
      tx += (n.x - p.x) / l;
      tz += (n.z - p.z) / l;
    }
    if (after) {
      const q = g.nodes[after.nodes[1]];
      const l = sqrt((q.x - n.x) ** 2 + (q.z - n.z) ** 2) || 1;
      tx += (q.x - n.x) / l;
      tz += (q.z - n.z) / l;
    }
    if (!before && !after) {
      // No street either side (a missing street next to a swing): along the row's chord.
      const m = gridNode(g, Math.min(W - 1, i + 1), j);
      const o = gridNode(g, Math.max(0, i - 1), j);
      tx = m.x - o.x;
      tz = m.z - o.z;
    }
    const l = sqrt(tx * tx + tz * tz) || 1;
    return { p: { x: n.x, z: n.z }, t: { x: tx / l, z: tz / l } };
  };
  const plainEdge = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    return PLAIN.has(e.kind) && !e.bridge && !e.shortcut && freeOrEl(ctx, ctx.claims.edge.get(eid));
  };
  const swingPath = (a0: Anchor, a1: Anchor, sw: Swing): { pts: Vec2[]; at: Map<number, number>; crossed: number[] } | null => {
    const lead = CFG.swingLead;
    const A = { x: a0.p.x + a0.t.x * lead, z: a0.p.z + a0.t.z * lead };
    const B = { x: a1.p.x - a1.t.x * lead, z: a1.p.z - a1.t.z * lead };
    const chord = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    if (chord < 4 * lead) return null;
    const pts = cubicPath(A, a0.t, B, a1.t, CFG.swingStep);
    let minR = Infinity;
    for (let i = 1; i + 1 < pts.length; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const az = pts[i].z - pts[i - 1].z;
      const bx = pts[i + 1].x - pts[i].x;
      const bz = pts[i + 1].z - pts[i].z;
      const turn = Math.abs(atan2(ax * bz - az * bx, ax * bx + az * bz));
      const len = (sqrt(ax * ax + az * az) + sqrt(bx * bx + bz * bz)) / 2;
      if (turn > 1e-9) minR = Math.min(minR, len / turn);
    }
    if (minR < CFG.swingRadius) return null;
    const at = new Map<number, number>();
    const crossed: number[] = [];
    for (let i = sw.i0 + 1; i < sw.i1; i++) {
      const Pn = gridNode(g, i, sw.from);
      const Qn = gridNode(g, i, sw.to);
      const nodes = streetChain(g, Pn.id, Qn.id);
      const line: Vec2[] = nodes ? nodes.map((id) => g.nodes[id]) : [Pn, Qn];
      const hit = polylineCrossing(pts, line);
      if (!hit) return null;
      if (sqrt((hit.p.x - Pn.x) ** 2 + (hit.p.z - Pn.z) ** 2) < CROSS_NODE_CLEAR || sqrt((hit.p.x - Qn.x) ** 2 + (hit.p.z - Qn.z) ** 2) < CROSS_NODE_CLEAR) return null;
      pts.splice(hit.i + 1, 0, hit.p);
      at.set(i, hit.i + 1);
      if (nodes) {
        for (const e of chainOfNodes(g, nodes).edges) {
          // Never across the El's column street mid block (its deck is over the curb lane there), nor a bridge.
          if (e < 0 || g.edges[e].bridge || ctx.claims.edge.has(e)) return null;
          crossed.push(e);
        }
      }
    }
    for (const e of g.edges) {
      if (e.kind !== 'diagonal') continue;
      const a = g.nodes[e.a];
      const c = g.nodes[e.b];
      for (const p of pts) if (distToSegment(p.x, p.z, a.x, a.z, c.x, c.z) < DIAGONAL_CLEAR) return null;
    }
    return { pts, at, crossed };
  };

  const path: Vec2[] = [];
  const at = new Array<number>(W).fill(-1);
  const nodes: number[] = [];
  const edges: number[] = [];
  const crossed: number[] = [];
  let missing = 0;
  let offStreet = 0;
  for (let i = 0; i < W; ) {
    const j = rows[i];
    if (j < 0) return null;
    const n = gridNode(g, i, j);
    if (!nodeOk(ctx, n)) return null;
    const a = anchorAt(i, j);
    at[i] = path.length;
    path.push(a.p);
    if (!ctx.claims.node.has(n.id)) nodes.push(n.id);
    const sw = swings.find((s) => s.i0 === i);
    if (sw) {
      const S = swingPath(a, anchorAt(sw.i1, sw.to), sw);
      if (!S) return null;
      for (const [col, idx] of S.at) at[col] = path.length + idx;
      for (const p of S.pts) path.push(p);
      for (const e of S.crossed) crossed.push(e);
      for (let k = 1; k < S.pts.length; k++) offStreet += sqrt((S.pts[k].x - S.pts[k - 1].x) ** 2 + (S.pts[k].z - S.pts[k - 1].z) ** 2);
      i = sw.i1;
      continue;
    }
    if (i + 1 < W) {
      const ch = streetAt(i, j);
      if (!ch) {
        missing++;
        const m = gridNode(g, i + 1, j);
        offStreet += sqrt((m.x - n.x) ** 2 + (m.z - n.z) ** 2);
      } else {
        for (const e of ch.edges) if (!plainEdge(e)) return null;
        for (let k = 1; k + 1 < ch.nodes.length; k++) {
          const id = ch.nodes[k];
          if (!freeOrEl(ctx, ctx.claims.node.get(id))) return null;
          path.push({ x: g.nodes[id].x, z: g.nodes[id].z });
          if (!ctx.claims.node.has(id)) nodes.push(id);
        }
        for (const e of ch.edges) if (!ctx.claims.edge.has(e)) edges.push(e);
      }
    }
    i++;
  }
  if (missing > MAX_MISSING) return null;
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
  return { path, at, rows: rows.slice(), nodes, edges, crossed, length, swings: swings.length, offStreet };
}
