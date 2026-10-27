/**
 * Where each neighbourhood announces itself: one gateway per named neighbourhood, on the street a
 * driver first comes into it by. For a hood the route runs through that is the first entry along
 * the route (the street the route turns into from another hood's, so a lap meets every name it
 * passes); for one the route never enters (a free roam city has no race to follow) it is the
 * biggest street that crosses its border from outside, the boulevard before the avenue before the
 * plain street. The gateway stands a little way past the border junction, clear of its crosswalks
 * and mouths, and looks back at the traffic coming in.
 *
 * Pure: it reads the graph, the route and the neighbourhood plan and writes nothing, so no replay
 * notices. The sign itself is render/street/placeSigns.ts.
 */
import type { World } from '../world';
import { chainFrom, chainPoint, isBendNode, type RoadKind } from '../roadGraph';
import { hoodPlan, type Neighbourhood } from './neighbourhoods';
import { hoodsOf } from './places';

/** Where a gateway stands along its street. */
const GATEWAY = {
  /** Distance past the border junction (m): clear of the junction's mouths and crosswalks. */
  setback: 24,
  /** The shortest street (m) that takes one: the sign needs a clear stretch past the setback. */
  minChain: 50,
} as const;

/** How well a street suits a gateway: the grand streets first. */
const CLASS: Partial<Record<RoadKind, number>> = { boulevard: 4, avenue: 3, diagonal: 2, street: 1 };

export interface Gateway {
  hood: Neighbourhood;
  /** The graph edge it enters along, and the junction (graph node) it enters from. */
  edge: number;
  node: number;
  /** Where the sign stands on the street's centerline (m). */
  x: number;
  z: number;
  /** Unit direction of travel into the neighbourhood. */
  dx: number;
  dz: number;
  /** Curb to curb width of the street (m). */
  width: number;
  /** Sidewalk width either side (m). */
  sidewalk: number;
  /** How far the street runs back toward its border junction behind the sign, and on to the next junction ahead of it (m). */
  behind: number;
  ahead: number;
  /** Whether the route enters the neighbourhood here. */
  onRoute: boolean;
}

const books = new WeakMap<World, Gateway[]>();

/** The world's gateways, one per neighbourhood that has a street to stand on, in neighbourhood order. */
export function hoodGateways(world: World): Gateway[] {
  let b = books.get(world);
  if (!b) books.set(world, (b = plan(world)));
  return b;
}

function plan(world: World): Gateway[] {
  const g = world.graph;
  const hoods = hoodsOf(world);
  const edgeHood = hoodPlan(world).edgeHood;
  /** Whether a street edge (not an alley, a ramp or the channel) can carry a gateway. */
  const eligible = (eid: number): boolean => edgeHood[eid] >= 0 && (CLASS[g.edges[eid].kind] ?? 0) > 0 && !g.edges[eid].shortcut;
  /** Every way into a hood; the best that has room for the sign wins. */
  const offers: { hood: number; score: number; edge: number; node: number; onRoute: boolean }[] = [];

  // The route's own entries, the earliest along the route first. A hood entered by a river ramp or the channel is met
  // at the first street after it.
  const r = world.route;
  const n = r.edges.length;
  let pending = -1;
  for (let i = 0; i < n; i++) {
    const e = r.edges[i];
    const h = edgeHood[e];
    const prev = edgeHood[r.edges[(i + n - 1) % n]];
    if (h >= 0 && h !== prev && (r.closed || i > 0)) pending = h;
    if (pending >= 0 && h === pending && eligible(e)) {
      offers.push({ hood: h, score: 1000 - i, edge: e, node: r.nodes[i], onRoute: true });
      pending = -1;
    }
  }
  // Every other way in: an edge of the hood that starts at a junction another hood's street also meets.
  for (const e of g.edges) {
    if (!eligible(e.id)) continue;
    const h = edgeHood[e.id];
    for (const node of [e.a, e.b]) {
      if (isBendNode(g, node)) continue;
      if (!g.nodes[node].edges.some((o) => edgeHood[o] >= 0 && edgeHood[o] !== h)) continue;
      offers.push({ hood: h, score: (CLASS[e.kind] ?? 0) * 10 - e.id * 1e-6, edge: e.id, node, onRoute: false });
    }
  }
  offers.sort((p, q) => q.score - p.score);

  const out: Gateway[] = [];
  for (const hood of hoods) {
    for (const pick of offers) {
      if (pick.hood !== hood.id) continue;
      // The street out of the border junction, to the next junction.
      const chain = chainFrom(g, pick.node, pick.edge);
      if (chain.length < GATEWAY.minChain) continue;
      const s = Math.min(GATEWAY.setback, chain.length * 0.4);
      const at = chainPoint(g, chain, s);
      const ahead = chainPoint(g, chain, s + 2);
      const behind = chainPoint(g, chain, Math.max(0, s - 2));
      const dx = ahead.x - behind.x;
      const dz = ahead.z - behind.z;
      const l = Math.hypot(dx, dz) || 1;
      out.push({ hood, edge: pick.edge, node: pick.node, x: at.x, z: at.z, dx: dx / l, dz: dz / l, width: g.edges[pick.edge].width, sidewalk: g.edges[pick.edge].sidewalk, behind: s, ahead: chain.length - s, onRoute: pick.onRoute });
      break;
    }
  }
  return out;
}
