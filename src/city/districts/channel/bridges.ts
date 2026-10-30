/**
 * The channel's bridges: one street through the band, followed through its bend nodes into a deck polyline
 * (bridgesOf, in crossing x order), with the frame at the crossing, the pier bents beneath the deck
 * (pierReach, pierOffsets) and the deck's offset lines and boxes clipped to the channel (bridgePoint, deckLine,
 * deckBox). The planner finds the chains (chainOf, crossingT, crosses) before the graph is rebuilt around them.
 */
import { CITY } from '../../config';
import type { RoadGraph, RoadEdge } from '../../roadGraph';
import { isChannelEdge, otherNode } from '../../roadGraph';
import { Vec2, sqrt } from '../../../sim/math';
import { distToPath } from '../geom';
import type { Area } from '../types';
import { channelL } from './centerline';

const CFG = CITY.districts.channel;

/** Street kinds that may cross the channel (alleys and shortcuts are planned later and never do). */
export const STREET_KINDS = new Set<RoadEdge['kind']>(['street', 'avenue', 'boulevard', 'diagonal']);
/** A deck polyline is followed through bend nodes until this far beyond the band's top edge (m). */
const DECK_REACH = 8;

/** A bridge: one street through the band, its deck polyline and frame at the crossing. */
export interface Bridge {
  /** Its edges, the one whose segment crosses the centerline first (hints name a bridge by it). */
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
export function crossingT(p: Record<string, number>, a: Vec2, b: Vec2, target: number): number {
  const lAt = (t: number) => channelL(p, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) - target;
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
export const crosses = (p: Record<string, number>, a: Vec2, b: Vec2): boolean => channelL(p, a.x, a.z) * channelL(p, b.x, b.z) < 0;

/**
 * The street through the band that edge `e` (crossing the centerline) is part
 * of: followed through degree-2 nodes on both sides until the node lies
 * DECK_REACH beyond the band or is a junction. `allowed` limits the walk to
 * some edges (an area's). Null when a bend leads onto a road of another kind.
 */
export function chainOf(g: RoadGraph, p: Record<string, number>, e: RoadEdge, allowed?: Set<number>): { edges: RoadEdge[]; nodes: number[] } | null {
  const T = p.top;
  const edges: RoadEdge[] = [e];
  const nodes: number[] = [e.a, e.b];
  for (const end of [0, 1]) {
    let cur = e;
    let node = end === 0 ? e.a : e.b;
    for (let guard = 0; guard < 8; guard++) {
      const n = g.nodes[node];
      if (n.edges.length !== 2 || Math.abs(channelL(p, n.x, n.z)) >= T + DECK_REACH) break;
      const nextId = n.edges[0] === cur.id ? n.edges[1] : n.edges[0];
      if (allowed && !allowed.has(nextId)) break;
      const next = g.edges[nextId];
      if (!STREET_KINDS.has(next.kind) || next.shortcut || isChannelEdge(next)) return null;
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
  if (channelL(p, pts[0].x, pts[0].z) > 0) pts = pts.reverse();
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const t = crossingT(p, a, b, 0);
  const cx = a.x + (b.x - a.x) * t;
  const cz = a.z + (b.z - a.z) * t;
  const len = e.length || 1;
  let dx = (b.x - a.x) / len;
  let dz = (b.z - a.z) / len;
  if (channelL(p, b.x, b.z) < 0) {
    dx = -dx;
    dz = -dz;
  }
  return { edge: e.id, edges: chain.edges.map((x) => x.id), pts, dk: e.width / 2 + e.sidewalk, cx, cz, dx, dz, nx: -dz, nz: dx };
}

/** The bridges of a channel area, in crossing x order. */
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

/** The outer pier columns of a bent stand this far inside the parapet lines (m). */
const PIER_EDGE = 1.2;

/** Half the spread of a bent's columns across the deck (m): the outer columns stand at +-pierReach. */
export function pierReach(br: Bridge): number {
  return br.dk - PIER_EDGE;
}

/**
 * Offsets across the deck (w, m) of the pier columns of one bent: the outer
 * ones at +-pierReach, the rest evenly between about pierSpacing apart (one
 * on the axis when only one fits). The renderer's girders follow them
 * (render/districts/channel.ts).
 */
export function pierOffsets(br: Bridge): number[] {
  const reach = pierReach(br);
  const n = Math.max(1, Math.floor((2 * reach) / CFG.pierSpacing));
  const out: number[] = [];
  for (let k = 0; k < n; k++) out.push(n === 1 ? 0 : -reach + ((2 * reach) * k) / (n - 1));
  return out;
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
    const l0 = channelL(p, q0.x, q0.z) - lTarget;
    const l1 = channelL(p, q1.x, q1.z) - lTarget;
    if (l0 * l1 > 0 && i < m - 1) continue;
    const sLo = l0 < 0;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      const q = at(i, mid);
      if (channelL(p, q.x, q.z) - lTarget < 0 === sLo) lo = mid;
      else hi = mid;
    }
    return at(i, (lo + hi) / 2);
  }
  return at(m - 1, 1);
}

/** The four corners of a bridge's box between |w| <= half and l in [l0, l1] (in that w, l order). */
export function deckBox(p: Record<string, number>, br: Bridge, half: number, l0: number, l1: number): Vec2[] {
  return [bridgePoint(p, br, -half, l0), bridgePoint(p, br, half, l0), bridgePoint(p, br, half, l1), bridgePoint(p, br, -half, l1)];
}

/** The deck polyline offset `off`, clipped to l in [l0, l1]: the end points by bisection, the bends between kept. */
export function deckLine(p: Record<string, number>, br: Bridge, off: number, l0: number, l1: number): Vec2[] {
  const out: Vec2[] = [bridgePoint(p, br, off, l0)];
  for (let i = 1; i + 1 < br.pts.length; i++) {
    const q = br.pts[i];
    const l = channelL(p, q.x, q.z);
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
