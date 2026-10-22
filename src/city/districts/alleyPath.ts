/**
 * Path and chain helpers shared by the alley modules (alley.ts) and their
 * dressing and shortcut planning: hump and ramp profiles, positions along an
 * alley's path, the back alley chains a route touches (walked entry first),
 * corridor outlines, and a few constants and vectors the planners agree on.
 */
import { CITY } from '../config';
import { otherNode, type RoadGraph } from '../roadGraph';
import type { Vec2 } from '../../sim/math';
import { segmentAt } from './geom';

/** Hump height and its slope along the alley at distance s from the start (0 outside the hump). */
export function jumpProfile(s: number, center: number, ramp: number, top: number, height: number): { h: number; dh: number } {
  const s0 = center - top / 2 - ramp;
  const s1 = center - top / 2;
  const s2 = center + top / 2;
  const s3 = center + top / 2 + ramp;
  if (s <= s0 || s >= s3) return { h: 0, dh: 0 };
  if (s < s1) return { h: ((s - s0) / ramp) * height, dh: height / ramp };
  if (s <= s2) return { h: height, dh: 0 };
  return { h: ((s3 - s) / ramp) * height, dh: -height / ramp };
}

/** Clutter along one side of a straight edge: s from the start (m), lateral offset from the centerline (+ = left of travel). */
export function sideSpot(a: Vec2, b: Vec2, s: number, lateral: number): { x: number; z: number; yaw: number } {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  // Left of travel is (-uz, ux); props face the alley center (local +Z toward it).
  const nx = -uz;
  const nz = ux;
  return { x: a.x + ux * s + nx * lateral, z: a.z + uz * s + nz * lateral, yaw: Math.atan2(-nx * Math.sign(lateral), -nz * Math.sign(lateral)) };
}

/**
 * A jump exit's ramp: height and slope `s` m past its toe, a parabola `length`
 * m long rising `rise` m, flat at the toe (no kink to unsettle the car) and
 * steepest at the lip (2 rise / length); 0 past the lip, where the alley
 * drops back to street level under the face.
 */
export function jumpRampProfile(s: number, length: number, rise: number): { h: number; dh: number } {
  if (s <= 0 || s > length) return { h: 0, dh: 0 };
  const t = s / length;
  return { h: rise * t * t, dh: (2 * rise * t) / length };
}

/** Ballistic reach (m from the lip, landing at street level `rise` m below it) of a launch at v m/s off a jump exit's lip. */
export function alleyFlightReach(v: number): number {
  const J = CITY.districts.backAlley.route.jump;
  const a = Math.atan((2 * J.rise) / J.length);
  const vy = v * Math.sin(a);
  const vx = v * Math.cos(a);
  const g = 9.81;
  return (vx * (vy + Math.sqrt(vy * vy + 2 * g * J.rise))) / g;
}

/** Cumulative length (m) at each point of a polyline. */
export function pathCum(path: readonly Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  return cum;
}

/** sideSpot along a polyline: s from its start (m), lateral off the centerline (+ = left of travel). */
export function pathSpot(path: readonly Vec2[], cum: readonly number[], s: number, lateral: number): { x: number; z: number; yaw: number } {
  const i = segmentAt(cum, s);
  return sideSpot(path[i], path[i + 1], s - cum[i], lateral);
}

/** A chain of shortcut edges between two junctions: its edges and nodes in walking order, its points and length (m). */
export interface ShortcutChain {
  edges: number[];
  nodes: number[];
  points: Vec2[];
  length: number;
  /** The node at the chain's jump exit lip, if it has one: only a shortcut driven toward it (a wall faces the street under the lip). */
  jumpEnd: number | null;
}

/**
 * Follow shortcut edges from node `from` along edge `eid` through free bend
 * nodes (gi -1, two shortcut edges) to the junction at the far end. A plain
 * back alley is a chain of one edge.
 */
function shortcutChain(g: RoadGraph, eid: number, from: number): ShortcutChain {
  const edges = [eid];
  const nodes = [from];
  let e = g.edges[eid];
  let n = from;
  let length = e.length;
  let jumpEnd: number | null = e.jumpExit ? e.b : null;
  for (let guard = 0; guard < 8; guard++) {
    n = otherNode(e, n);
    nodes.push(n);
    const node = g.nodes[n];
    if (node.gi >= 0 || node.edges.length !== 2) break;
    const next = g.edges[node.edges[0] === e.id ? node.edges[1] : node.edges[0]];
    if (!next.shortcut) break;
    edges.push(next.id);
    length += next.length;
    if (next.jumpExit) jumpEnd = next.b;
    e = next;
  }
  return { edges, nodes, points: nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z })), length, jumpEnd };
}

/** Whether a chain driven from its first node to its last would arrive at a jump exit backwards (over the face under its lip). */
export function chainBackwards(c: ShortcutChain, aFirst: boolean): boolean {
  return c.jumpEnd !== null && (aFirst ? c.nodes[c.nodes.length - 1] : c.nodes[0]) !== c.jumpEnd;
}

/** Every shortcut chain leaving one of the given nodes, each listed once, walked from the first of its ends in the list. */
export function routeChains(g: RoadGraph, nodes: readonly number[]): ShortcutChain[] {
  const seen = new Set<number>();
  const out: ShortcutChain[] = [];
  for (const nid of nodes) {
    for (const eid of g.nodes[nid].edges) {
      if (!g.edges[eid].shortcut || seen.has(eid)) continue;
      const c = shortcutChain(g, eid, nid);
      for (const id of c.edges) seen.add(id);
      out.push(c);
    }
  }
  return out;
}

/** The nodes of an area's shortcut chain in the order of its edges (edge i runs from node i to node i + 1). */
export function chainNodes(g: RoadGraph, edges: readonly number[]): number[] {
  const first = g.edges[edges[0]];
  if (edges.length === 1) return [first.a, first.b];
  const second = g.edges[edges[1]];
  let n = first.a === second.a || first.a === second.b ? first.b : first.a;
  const out = [n];
  for (const eid of edges) {
    n = otherNode(g.edges[eid], n);
    out.push(n);
  }
  return out;
}

/** Corridor polygon around a polyline (half width hw). */
export function corridor(path: Vec2[], hw: number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  path.forEach((p, j) => {
    const a = path[Math.max(0, j - 1)];
    const b = path[Math.min(path.length - 1, j + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    left.push({ x: p.x + nx * hw, z: p.z + nz * hw });
    right.push({ x: p.x - nx * hw, z: p.z - nz * hw });
  });
  return left.concat(right.reverse());
}

export function gridIndex(g: RoadGraph): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of g.nodes) if (n.gi >= 0) m.set(n.gj * 1000 + n.gi, n.id);
  return m;
}


/**
 * A back alley mouth due within BEND_CLEAR (m) of a bend node of its street lands on the bend node
 * (roadGraph.ts chainSnap), which becomes its junction: a mouth whose corners reach past a bend
 * node's own would fold the block's ring back over the alley.
 */
export const BEND_CLEAR = 22;
export const RAD = Math.PI / 180;

export function unit(from: Vec2, to: Vec2): { x: number; z: number; len: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len, len };
}
