/**
 * Closes the side streets off a route: a barrier across every closed street
 * mouth, set back past where its walls start, grouped per intersection and
 * clipped where neighbours cross (the street meets and the route signs are
 * placed from the groups). createWorld turns the barriers into cyan rails.
 */
import { CITY, ROUTE } from './config';
import { type RoadGraph, chainFrom, otherNode } from './roadGraph';
import { type EdgeMouths, type Wall, makeWall } from './blocks';
import { riverL } from './districts/river';
import { type Vec2, abs, lineIntersectT, sqrt } from '../sim/math';
import type { Route } from './route';

/**
 * Closed side street barriers, grouped for rendering.
 *
 * Every closed street mouth gets one straight barrier segment across the side
 * street (full road plus both sidewalks), just past where its walls start.
 * Mouths that sit next to each other at the same intersection (adjacent in
 * the node's angular edge order, no route edge between them) and whose
 * barrier ends touch or cross are merged into one group; crossing segments
 * are clipped at their intersection so no two barrier walls ever overlap.
 *
 * Shape: a BarrierGroup lists its wall segments in angular order around the
 * node (counterclockwise in atan2(z, x)); each segment runs a -> b in that
 * same order and its normal faces the track. Each barrier Wall carries
 * `group` = index into the group list. Render one row of parked cars behind
 * each segment of a group (behind = along -normal, up to `depth` meters) and
 * one in-air arrow per group at (x, z), facing (nx, nz).
 */
export interface BarrierGroup {
  id: number;
  /** Route node (intersection) the group faces. */
  node: number;
  /** Closed side street edges, one per segment, in the same order as walls. */
  edges: number[];
  /**
   * The closure: straight barrier segments while the world is being built,
   * then (createWorld) cyan modular rail pieces, the same RailWall objects as in
   * World.walls, all with one rail group id.
   */
  walls: Wall[];
  /** Some closed street of the group carries straight on from the incoming road (racers overshoot into it). */
  headOn: boolean;
  /** Some segment is a tie leaning on a corner rail (MouthBarrier.tie): that rail is most of the closure, and its meet stands behind it. */
  tied?: boolean;
  /** Arrow anchor: length weighted mean of the segment midpoints. */
  x: number;
  z: number;
  /** Unit normal toward the track (length weighted mean of the segment normals). */
  nx: number;
  nz: number;
  /** Total barrier length. */
  length: number;
  /**
   * Free depth behind the barrier (m) along its side streets before reaching
   * the far intersection or, for streets closed at both ends, half the gap to
   * the barrier at the other end. Minimum over the group's streets.
   */
  depth: number;
}

/** Gap (m) between barrier ends below which neighboring mouths merge into one group. */
const BARRIER_MERGE_GAP = 3;

interface MouthBarrier {
  edge: number;
  node: number;
  /** Index of the edge in the node's angular order. */
  k: number;
  a: Vec2;
  b: Vec2;
  /** Distance from the node along the side street. */
  d: number;
  /** A corner rail already runs right across this mouth: it is the closure, no barrier of its own. */
  railed: boolean;
  /** The barrier is a tie from the street's edge to a corner rail across the rest of the mouth (its b end, or its a end, at the rail). */
  tie?: 'a' | 'b';
  /** A tie's normal faces away from this point, inside its closed street (the node may lie on either side of an oblique tie). */
  inside?: Vec2;
  /** A rail crossing the middle of the mouth, past neither corner: the tie from the other corner (b side; this one is from the a side). */
  second?: MouthBarrier;
  headOn?: boolean;
}

/** Nearest point to p on any of the walls, and its distance. */
function nearestOn(walls: readonly Wall[], p: Vec2): { q: Vec2; d: number } {
  let best = { q: p, d: Infinity };
  for (const w of walls) {
    const vx = w.bx - w.ax;
    const vz = w.bz - w.az;
    const l2 = vx * vx + vz * vz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - w.ax) * vx + (p.z - w.az) * vz) / l2)) : 0;
    const q = { x: w.ax + vx * t, z: w.az + vz * t };
    const d = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (d < best.d) best = { q, d };
  }
  return best;
}

function mouthBarrier(g: RoadGraph, mouths: EdgeMouths[], edge: number, node: number, rails: Wall[] = [], setback = 0, river?: Record<string, number>, ties = true): MouthBarrier {
  const e = g.edges[edge];
  const m = mouths[edge];
  const p = node === e.a ? m.aP.outer : m.bP.outer;
  const q = node === e.a ? m.aN.outer : m.bN.outer;
  const n = g.nodes[node];
  const far = g.nodes[otherNode(e, node)];
  const dl = sqrt((far.x - n.x) ** 2 + (far.z - n.z) ** 2) || 1;
  const dx = (far.x - n.x) / dl;
  const dz = (far.z - n.z) / dl;
  // Place the barrier straight across the side street, just past where its walls start,
  // so it never cuts into the route corridor at acute junctions.
  const along = (pt: Vec2) => (pt.x - n.x) * dx + (pt.z - n.z) * dz;
  let d = Math.max(along(p), along(q)) + 1.5;
  const dNat = d;
  // Further into the street, keeping room between this end and the far one (which may move in too).
  if (setback > 0) {
    const far0 = (() => {
      const fm = otherNode(e, node) === e.a ? [m.aP.outer, m.aN.outer] : [m.bP.outer, m.bN.outer];
      return Math.max(...fm.map((pt) => (pt.x - far.x) * -dx + (pt.z - far.z) * -dz)) + 1.5;
    })();
    const room = dl - d - far0;
    d += Math.max(0, Math.min(setback, (room - ROUTE.barrierMinRoom) / 2));
  }
  // Across a channel the closure runs fence to fence (the banks are drivable), a hair short of the
  // fence walls; across a ramp, a hair short of its trench walls.
  const half = e.kind === 'channel' ? e.width / 2 + CITY.districts.river.channelMargin + CITY.districts.river.bankWidth + 0.2 : e.kind === 'ramp' ? e.width / 2 - 0.3 : e.width / 2 + e.sidewalk;
  // Past the plinths of the ramps meeting at a foot, so the closure never cuts a plinth face: a ramp
  // tilted along the channel (one whose top took a bend node of its street, districts/river.ts)
  // carries its trench walls further along it than a square one.
  if (e.kind === 'channel') {
    for (const id of n.edges) {
      const r = g.edges[id];
      if (r.kind !== 'ramp') continue;
      const top = g.nodes[otherNode(r, node)];
      const rl = sqrt((top.x - n.x) ** 2 + (top.z - n.z) ** 2) || 1;
      const rdx = (top.x - n.x) / rl;
      const rdz = (top.z - n.z) / rl;
      const along = abs(rdx * dx + rdz * dz);
      const across = abs(rdx * dz - rdz * dx);
      const plinth = r.width / 2 + CITY.districts.river.rampBody;
      d = Math.max(d, CITY.districts.river.closureFootClear, rl * along + plinth * across + 3.5);
    }
  }
  const d0 = d;
  const k = n.edges.indexOf(edge);
  // A corner rail crossing this mouth (a side street leaving at the outside of a corner) closes it
  // where it passes both of the street's building corners closer than a car is wide. Past one only
  // (the fillet cuts inside the other corner, or the rail bends away down the next street), a tie
  // from the street's edge at the open corner to the rail closes the rest: one rail with a short
  // spur, where a full closure would stand as a second rail just behind the first.
  if (ties && e.kind !== 'channel' && e.kind !== 'ramp') {
    const reach = Math.min(60, Math.max(dl / 2, d0 + 0.5));
    // The rail pieces in this mouth: only they can close it (a rail across the route street is no closure of this one).
    const inMouth = rails.filter((w) => {
      const steps = Math.max(1, Math.ceil(sqrt((w.bx - w.ax) ** 2 + (w.bz - w.az) ** 2) / 0.25));
      for (let i = 0; i <= steps; i++) {
        const x = w.ax + ((w.bx - w.ax) * i) / steps;
        const z = w.az + ((w.bz - w.az) * i) / steps;
        const al = (x - n.x) * dx + (z - n.z) * dz;
        if (al > 0 && al < reach && abs((x - n.x) * -dz + (z - n.z) * dx) <= half + 0.5) return true;
      }
      return false;
    });
    if (inMouth.length) {
      // (-dz, dx) is the lateral direction: the a end of a barrier lies at -half, the b end at +half.
      const at = (dd: number, lat: number): Vec2 => ({ x: n.x + dx * dd - dz * lat, z: n.z + dz * dd + dx * lat });
      const latOf = (pt: Vec2) => (pt.x - n.x) * -dz + (pt.z - n.z) * dx;
      const [ca, cb] = latOf(p) < latOf(q) ? [p, q] : [q, p];
      const sealA = nearestOn(inMouth, ca).d < ROUTE.barrierTieSeal;
      const sealB = nearestOn(inMouth, cb).d < ROUTE.barrierTieSeal;
      // Railed only where a rail really runs across the mouth (railAcross): rails that each end at one of its
      // corners, or one that passes both and crosses the street beyond, leave it open between them.
      const closure = { edge, node, k, a: at(dNat, -half), b: at(dNat, half), d: dNat, railed: railAcross(n, dx, dz, reach, inMouth) };
      if (sealA && sealB) return closure;
      // A tie from the street's edge at the open corner on lateral side `lat` to the rail, or null where the rail is right there.
      const tie = (lat: number): { E: Vec2; R: Vec2 } | null => {
        const E = at(dNat, lat);
        const r = nearestOn(inMouth, E);
        if (r.d < ROUTE.barrierTieGap + 0.5) return null;
        const t = (r.d - ROUTE.barrierTieGap) / r.d;
        return { E, R: { x: E.x + (r.q.x - E.x) * t, z: E.z + (r.q.z - E.z) * t } };
      };
      const inside = at(dNat + 8, 0);
      // A hair inside the building line, so the tie never counts as crossing the wall it starts on.
      const tA = sealA ? null : tie(-half + 0.1);
      const tB = sealB ? null : tie(half - 0.1);
      const fromA = tA && { edge, node, k, a: tA.E, b: tA.R, d: dNat, railed: false, tie: 'b' as const, inside };
      const fromB = tB && { edge, node, k, a: tB.R, b: tB.E, d: dNat, railed: false, tie: 'a' as const, inside };
      if (fromA && fromB) return { ...fromA, second: fromB };
      return fromA ?? fromB ?? closure;
    }
  }
  // Past neither corner: stay behind any corner rail crossing the mouth, so the barrier never
  // pokes through it. A rail spanning the whole mouth closes the street by itself.
  const span = new Map<number, { lo: number; hi: number }>();
  for (const w of rails) {
    for (const [x, z] of [
      [w.ax, w.az],
      [w.bx, w.bz],
    ]) {
      const al = (x - n.x) * dx + (z - n.z) * dz;
      const lat = (x - n.x) * -dz + (z - n.z) * dx;
      // Rails in front of the barrier's own spot always count (the short street to a ford's ramp top
      // is railed right across by a corner rail), further ones only on this end's half of the street:
      // a piece between two ramp T nodes must not be closed at its far end because of the corner
      // rail standing at the other junction.
      if (al > 0 && al < Math.min(60, Math.max(dl / 2, d0 + 0.5)) && abs(lat) <= half + 0.5) {
        d = Math.max(d, al + 1);
        const g = span.get(w.group ?? -1) ?? { lo: Infinity, hi: -Infinity };
        g.lo = Math.min(g.lo, lat);
        g.hi = Math.max(g.hi, lat);
        span.set(w.group ?? -1, g);
      }
    }
  }
  let railed = false;
  for (const g of span.values()) if (g.lo <= -half + 1.5 && g.hi >= half - 1.5) railed = true;
  // A rail group with ends either side of the mouth may still cross the street out past it (a corner rail
  // round a swing's sharp junction): only one across it within reach closes it.
  railed &&= railAcross(n, dx, dz, Math.min(60, Math.max(dl / 2, d0 + 0.5)), rails);
  const cx = n.x + dx * d;
  const cz = n.z + dz * d;
  // (-dz, dx) points toward the next edge in the node's angular order, so a -> b runs counterclockwise.
  let ha = half;
  let hb = half;
  if (e.kind === 'channel' && river) {
    // The channel edge is a chord of the meander, up to a meter off the true centerline: each end
    // is found on the real bank, a hair inside the fence line, so the closure never pokes through it.
    const fence = river.top + 0.5 - 0.3;
    const reach = (sg: number): number => {
      let lo = half - 4;
      let hi = half + 4;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (abs(riverL(river, cx + sg * dz * mid, cz - sg * dx * mid)) < fence) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    };
    ha = reach(1);
    hb = reach(-1);
  }
  return { edge, node, k, a: { x: cx + dz * ha, z: cz - dx * ha }, b: { x: cx - dz * hb, z: cz + dx * hb }, d, railed };
}

/** Proper intersection parameter of segments p0p1 and q0q1 on the first, or null. */
function segCross(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): number | null {
  const d = { x: p1.x - p0.x, z: p1.z - p0.z };
  const e = { x: q1.x - q0.x, z: q1.z - q0.z };
  const t = lineIntersectT(p0, d, q0, e);
  if (t === null || t <= 0 || t >= 1) return null;
  const s = lineIntersectT(q0, e, p0, d);
  if (s === null || s <= 0 || s >= 1) return null;
  return t;
}

/** Whether a rail piece crosses the side street's centerline from node n out to `reach` along (dx, dz). */
function railAcross(n: Vec2, dx: number, dz: number, reach: number, rails: readonly Wall[]): boolean {
  const far = { x: n.x + dx * reach, z: n.z + dz * reach };
  return rails.some((w) => segCross(n, far, { x: w.ax, z: w.az }, { x: w.bx, z: w.bz }) !== null);
}

/**
 * Barrier groups for every closed side street of the route, in route node
 * order. Pass the route's corner rails so barriers stay behind them, and the
 * river area's params so closures across its channel end at the bank fences.
 */
export function routeBarrierGroups(g: RoadGraph, mouths: EdgeMouths[], route: Route, rails: Wall[] = [], river?: Record<string, number>, cityWalls: readonly Wall[] = []): BarrierGroup[] {
  const byNode = new Map<number, MouthBarrier[]>();
  const order = route.nodes;
  /** A barrier line crossing a city wall (a bridge body's culvert face right where a wide junction's corners end). */
  const crossesRoute = (mb: MouthBarrier) => {
    const P = route.points;
    for (let i = 0; i + 1 < P.length; i++) if (segCross(mb.a, mb.b, P[i], P[i + 1]) !== null) return true;
    return false;
  };
  const crossesWall = (mb: MouthBarrier) => cityWalls.some((w) => abs(w.ax - mb.a.x) < 60 && abs(w.az - mb.a.z) < 60 && segCross(mb.a, mb.b, { x: w.ax, z: w.az }, { x: w.bx, z: w.bz }) !== null);
  for (const cs of route.closedStreets) {
    let list = byNode.get(cs.node);
    if (!list) byNode.set(cs.node, (list = []));
    const n = g.nodes[cs.node];
    const near = rails.filter((w) => abs(w.ax - n.x) < 60 && abs(w.az - n.z) < 60);
    // Head on: the closed street carries straight on from the incoming road (same test as the renderer's).
    const i = order.indexOf(cs.node);
    const prev = route.closed ? order[(i - 1 + order.length) % order.length] : i > 0 ? order[i - 1] : -1;
    const next = i + 1 < order.length ? order[i + 1] : route.closed ? order[0] : -1;
    const from = prev >= 0 ? g.nodes[prev] : null;
    const to = from ? n : next >= 0 ? g.nodes[next] : null;
    const base = from ?? n;
    const il = to ? sqrt((to.x - base.x) ** 2 + (to.z - base.z) ** 2) || 1 : 1;
    const far = g.nodes[otherNode(g.edges[cs.edge], cs.node)];
    const fl = sqrt((far.x - n.x) ** 2 + (far.z - n.z) ** 2) || 1;
    const headOn = !!to && ((to.x - base.x) * (far.x - n.x) + (to.z - base.z) * (far.z - n.z)) / (il * fl) > 0.55;
    const setback = headOn ? ROUTE.barrierSetbackHeadOn : ROUTE.barrierSetbackSide;
    let mb = mouthBarrier(g, mouths, cs.edge, cs.node, near, setback, river);
    // A tie to a corner rail that would cut through a building corner or across the course: a full closure behind the rail instead.
    const tieOff = (t: MouthBarrier) => crossesWall(t) || crossesRoute(t);
    if (mb.tie && (tieOff(mb) || (mb.second && tieOff(mb.second)))) mb = mouthBarrier(g, mouths, cs.edge, cs.node, near, setback, river, false);
    // Set back into a wall (a bridge body starting where the corners end): stand at the mouth instead.
    if (!mb.railed && !mb.tie && crossesWall(mb)) mb = mouthBarrier(g, mouths, cs.edge, cs.node, near, 0, river, false);
    // Still into one (a river side ramp's trench opening beside the mouth): end half a metre short of it.
    for (const w of cityWalls) {
      if (abs(w.ax - mb.a.x) > 60 || abs(w.az - mb.a.z) > 60) continue;
      const t = segCross(mb.a, mb.b, { x: w.ax, z: w.az }, { x: w.bx, z: w.bz });
      if (t === null) continue;
      const len = sqrt((mb.b.x - mb.a.x) ** 2 + (mb.b.z - mb.a.z) ** 2) || 1;
      const m = 0.5 / len;
      const at = (u: number): Vec2 => ({ x: mb.a.x + (mb.b.x - mb.a.x) * u, z: mb.a.z + (mb.b.z - mb.a.z) * u });
      if (t > 0.5) mb.b = at(Math.max(0.5, t - m));
      else mb.a = at(Math.min(0.5, t + m));
    }
    mb.headOn = headOn;
    if (!mb.railed) list.push(mb);
    if (mb.second) list.push({ ...mb.second, headOn });
  }
  const all = [...byNode.values()].flat();
  const barrierAt = (edge: number, node: number) => all.find((b) => b.edge === edge && b.node === node);
  const onRoute = new Set(route.edges);
  const groups: BarrierGroup[] = [];
  for (const [nid, list] of byNode) {
    const n = g.nodes[nid];
    const m = n.edges.length;
    const byK = new Map<number, MouthBarrier[]>();
    for (const b of list) byK.set(b.k, [...(byK.get(b.k) ?? []), b]);
    // Walk the edges counterclockwise starting just after a route edge, so runs never wrap.
    let start = 0;
    while (start < m && !onRoute.has(n.edges[start])) start++;
    let run: MouthBarrier[] = [];
    const runs: MouthBarrier[][] = [];
    for (let i = 1; i <= m; i++) {
      const here = byK.get((start + i) % m);
      for (const b of here ?? []) {
        const prev = run[run.length - 1];
        if (prev) {
          const t = segCross(prev.a, prev.b, b.a, b.b);
          if (t !== null) {
            // Crossing walls: clip both at the crossing point so they meet in a V.
            const x = { x: prev.a.x + (prev.b.x - prev.a.x) * t, z: prev.a.z + (prev.b.z - prev.a.z) * t };
            prev.b = x;
            b.a = { x: x.x, z: x.z };
          } else if (sqrt((prev.b.x - b.a.x) ** 2 + (prev.b.z - b.a.z) ** 2) > BARRIER_MERGE_GAP) {
            runs.push(run);
            run = [];
          }
        }
        run.push(b);
      }
      if (!here && run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);

    for (const r of runs) {
      const walls: Wall[] = [];
      const edges: number[] = [];
      let sx = 0;
      let sz = 0;
      let snx = 0;
      let snz = 0;
      let length = 0;
      let depth = Infinity;
      let headOn = false;
      let tied = false;
      for (const b of r) {
        if (b.headOn) headOn = true;
        if (b.tie) tied = true;
        const facing = b.inside ? { x: b.a.x + b.b.x - b.inside.x, z: b.a.z + b.b.z - b.inside.z } : { x: n.x, z: n.z };
        const w = makeWall(b.a, b.b, facing, 'barrier');
        if (!w) continue;
        w.group = groups.length;
        const len = sqrt((b.b.x - b.a.x) ** 2 + (b.b.z - b.a.z) ** 2);
        walls.push(w);
        edges.push(b.edge);
        sx += ((b.a.x + b.b.x) / 2) * len;
        sz += ((b.a.z + b.b.z) / 2) * len;
        snx += w.nx * len;
        snz += w.nz * len;
        length += len;
        // Room behind this barrier before the far end of the side street: the whole street through
        // its bend nodes to the next junction. A ford's street piece carries straight on down its
        // ramp (a two-way node): the room runs onto the ramp's eased lip, where a crowd can still stand.
        const chain = chainFrom(g, b.node, b.edge);
        const lastEdge = chain.edges[chain.edges.length - 1];
        const farId = chain.nodes[chain.nodes.length - 1];
        const far = g.nodes[farId];
        const onto = far.edges.length === 2 ? g.edges[far.edges[0] === lastEdge ? far.edges[1] : far.edges[0]] : undefined;
        let room: number;
        if (onto?.kind === 'ramp') {
          room = chain.length - b.d + onto.length * CITY.districts.river.rampLip;
        } else {
          const other = barrierAt(lastEdge, farId);
          const farMouth = other ? other.d : mouthBarrier(g, mouths, lastEdge, farId).d - 1.5;
          room = chain.length - b.d - farMouth;
          if (other) room /= 2;
        }
        depth = Math.min(depth, room);
      }
      if (!walls.length) continue;
      const nl = sqrt(snx * snx + snz * snz) || 1;
      groups.push({ id: groups.length, node: nid, edges, walls, x: sx / length, z: sz / length, nx: snx / nl, nz: snz / nl, length, depth: Math.max(0, depth), headOn, ...(tied ? { tied } : {}) });
    }
  }
  return groups;
}
