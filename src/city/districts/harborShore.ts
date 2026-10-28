/**
 * The harbor as a Harbor Run sees it (events.ts): which streets run along the quay, which block ring
 * stands behind it and which junctions have a mouth onto it. All read from the graph and the
 * waterfront area's frontage line (the quay polygon's back edge), never from ids the route shortcuts
 * renumber, so the same answer holds for the pre-route preview and the finished city.
 *
 * The waterfront is planned after the routes (it scores a side higher for the races that run along
 * it), but a Harbor Run's routes have to be picked for a coast that does not exist yet. previewHarbor
 * runs the waterfront's own plan on a scratch context at route-picking time (same stream, same graph,
 * no routes yet): the side it picks is the side the finished plan picks again once the routes hug it,
 * since their race bonus only widens its lead. Where the finished plan differs (a hill or a park took
 * the frontage in between, the area budget ran out) the routes miss the quay and resolveEvent falls
 * back to Downtown Dash, as for every flavour.
 *
 * Mouths follow waterfrontYard.ts: a junction (or a street's end) whose centre is within its half
 * width, sidewalk and CFG.yard.mouthReach of the frontage, at least 12 m inside the quay's ends.
 * Pure and deterministic.
 */
import { CITY } from '../config';
import { type RoadGraph, isBendNode } from '../roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import { type Vec2, distToSegment, sqrt } from '../../sim/math';
import type { Area, PlanContext } from './types';
import { waterfrontModule, waterfrontRolled } from './waterfront';
import { coastV, frameU, framePoint, harborFrame } from './waterfrontShape';

const CFG = CITY.districts.waterfront;

/** Reach of a Harbor Run's wish, m. */
export const HARBOR_RUN = {
  /** A node counts as on the outer street when its centre is this much (m) further than the street's half width and sidewalk from the frontage (the yard's mouth reach, plus a bend's slack). */
  streetSlack: 5,
  /** The block ring behind the quay: streets whose both ends are within this far of the frontage (m), the outer row, the one behind it and the cross streets between. */
  ringDepth: 175,
  /** How far inland of the frontage a hill's outline blocks the quay (m): waterfront.ts SLOPE_REACH, which is private to it. */
  slopeReach: 40,
  /** A recess between two mouths counts when they are at least this far apart along the quay (m). */
  recessMin: 60,
  /** Mouth corners are only counted this far (m) in from the quay's ends, as the yard lays its mouths. */
  endInset: 12,
} as const;

/** The streets a Harbor Run wants, by edge id, and the junctions with a mouth onto the quay, by node id. */
export interface HarborShore {
  /** Streets along the quay itself: both ends on the outer street, between the quay's ends. */
  shore: ReadonlySet<number>;
  /** The block ring behind the quay (the shore streets included). */
  ring: ReadonlySet<number>;
  /** Junctions with a mouth: where a route turning onto the quay's street may take the lane instead. */
  mouths: ReadonlySet<number>;
  /**
   * Pairs of mouths, in order along the quay, with no street between them along the frontage (the
   * outer street is missing: a warehouse stands in the recess). The lane crosses straight from one
   * mouth to the other, while the streets go round the block behind: the quay's real cut-through.
   */
  recesses: readonly (readonly [number, number])[];
}

/**
 * Run the waterfront's plan on a scratch context to see which side becomes the harbor, before the
 * routes are picked. Null where the seed rolls no harbor or the plan finds no side free enough.
 */
export function previewHarbor(ctx: Pick<PlanContext, 'seed' | 'graph' | 'areas' | 'claims' | 'faces' | 'sectors' | 'budget'>): Area | null {
  if (!waterfrontRolled(ctx.seed)) return null;
  let found: Area | null = null;
  const scratch = {
    ...ctx,
    rng: new Rng(deriveSeed(ctx.seed, 'district:waterfront')),
    budget: { ...ctx.budget },
    addArea(a: Omit<Area, 'id'>) {
      found = { id: -1, ...a };
      return found;
    },
  } as unknown as PlanContext;
  waterfrontModule.plan(scratch);
  return found;
}

/**
 * The line a hill's slopes must keep off for the quay to stay as previewed: waterfront.ts shortens the
 * quay (or moves the harbor to another side) wherever a hill's outline comes within its sloped-ground
 * reach of the coast, past the quay's ends too. Sampled every 10 m along the coast's whole span,
 * quayWidth + HARBOR_RUN.slopeReach m in from the sea wall.
 */
export function quayGuard(area: Area): Vec2[] {
  const p = area.params;
  const f = harborFrame(area);
  const out: Vec2[] = [];
  for (let u = p.cx0; u <= p.cx0 + (p.cn - 1) * p.cdx; u += 10) out.push(framePoint(f, u, coastV(p, u) - CFG.quayWidth - HARBOR_RUN.slopeReach));
  return out;
}

/** A cut across a quay recess: the lane from one mouth to the next, a route shortcut where the route goes round the recess by the streets. */
export interface QuayCut {
  /** The mouths either side of the recess (graph nodes, a at the lower u). */
  a: number;
  b: number;
  /** From a's junction through the quay's lane to b's junction (world metres). */
  points: Vec2[];
  /** Length along the points (m). */
  length: number;
}

/**
 * The cuts across the quay's recesses (HarborShore.recesses): the street route round a warehouse's
 * block is the long way, the lane the short one. `lane` is the quay's 'quayLane' hint (the lane's
 * middle end to end). Each runs from one junction straight across the frontage to the lane, along it
 * and back to the other junction, through the mouths the yard puts at both.
 */
export function quayCuts(g: RoadGraph, area: Area, lane: readonly Vec2[]): QuayCut[] {
  if (lane.length < 2) return [];
  const f = harborFrame(area);
  const out: QuayCut[] = [];
  // The lane's middle at u: its points are evenly spaced along u, so interpolate between the two beside it.
  const laneAt = (u: number): Vec2 => {
    let i = 0;
    while (i + 2 < lane.length && frameU(f, lane[i + 1].x, lane[i + 1].z) < u) i++;
    const u0 = frameU(f, lane[i].x, lane[i].z);
    const u1 = frameU(f, lane[i + 1].x, lane[i + 1].z);
    const t = Math.max(0, Math.min(1, (u - u0) / (u1 - u0 || 1)));
    return { x: lane[i].x + (lane[i + 1].x - lane[i].x) * t, z: lane[i].z + (lane[i + 1].z - lane[i].z) * t };
  };
  for (const [a, b] of harborShore(g, area).recesses) {
    const A = g.nodes[a];
    const B = g.nodes[b];
    const ua = frameU(f, A.x, A.z);
    const ub = frameU(f, B.x, B.z);
    const points: Vec2[] = [{ x: A.x, z: A.z }, laneAt(ua)];
    for (const q of lane) {
      const u = frameU(f, q.x, q.z);
      if (u > ua + 1 && u < ub - 1) points.push({ x: q.x, z: q.z });
    }
    points.push(laneAt(ub), { x: B.x, z: B.z });
    let length = 0;
    for (let i = 1; i < points.length; i++) length += sqrt((points[i].x - points[i - 1].x) ** 2 + (points[i].z - points[i - 1].z) ** 2);
    out.push({ a, b, points, length });
  }
  return out;
}

const cache = new WeakMap<Area, { g: RoadGraph; nodes: number; edges: number; shore: HarborShore }>();

/** The shore of a waterfront area on a graph (cached per area and graph). */
export function harborShore(g: RoadGraph, area: Area): HarborShore {
  const hit = cache.get(area);
  if (hit && hit.g === g && hit.nodes === g.nodes.length && hit.edges === g.edges.length) return hit.shore;
  const p = area.params;
  const f = harborFrame(area);
  const back = area.polygon.slice(0, p.nBack);
  const lo = p.pa;
  const hi = p.pb;
  const shore = new Set<number>();
  const ring = new Set<number>();
  const mouths = new Set<number>();
  // Per node: distance to the frontage (m) within the quay's span of u, else Infinity.
  const depth = new Float64Array(g.nodes.length).fill(Infinity);
  const near = new Uint8Array(g.nodes.length);
  const mouth = new Uint8Array(g.nodes.length);
  for (const n of g.nodes) {
    if (!n.edges.length) continue;
    const u = frameU(f, n.x, n.z);
    if (u < lo - 2 || u > hi + 2) continue;
    let d = Infinity;
    for (let k = 0; k + 1 < back.length; k++) d = Math.min(d, distToSegment(n.x, n.z, back[k].x, back[k].z, back[k + 1].x, back[k + 1].z));
    depth[n.id] = d;
    if (d > HARBOR_RUN.ringDepth) continue;
    let half = 0;
    let walk = 0;
    for (const e of n.edges) {
      half = Math.max(half, g.edges[e].width / 2);
      walk = Math.max(walk, g.edges[e].sidewalk);
    }
    if (d <= half + walk + CFG.yard.mouthReach + HARBOR_RUN.streetSlack) {
      near[n.id] = 1;
      if (u >= lo + HARBOR_RUN.endInset && u <= hi - HARBOR_RUN.endInset && !isBendNode(g, n.id) && d >= half - 1 && d <= half + walk + CFG.yard.mouthReach) mouth[n.id] = 1;
    }
  }
  for (const e of g.edges) {
    if (e.kind === 'channel' || e.kind === 'ramp' || e.shortcut) continue;
    if (depth[e.a] <= HARBOR_RUN.ringDepth && depth[e.b] <= HARBOR_RUN.ringDepth) {
      ring.add(e.id);
      if (near[e.a] && near[e.b]) shore.add(e.id);
    }
  }
  for (const n of g.nodes) if (mouth[n.id] && n.edges.some((e) => shore.has(e))) mouths.add(n.id);
  // Mouths side by side along the quay that the quay's street does not join: a recess between them.
  const comp = new Int32Array(g.nodes.length).fill(-1);
  let comps = 0;
  for (const n of g.nodes) {
    if (!near[n.id] || comp[n.id] >= 0) continue;
    const stack = [n.id];
    comp[n.id] = comps;
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of g.nodes[id].edges) {
        if (!shore.has(e)) continue;
        const o = g.edges[e].a === id ? g.edges[e].b : g.edges[e].a;
        if (comp[o] < 0) {
          comp[o] = comps;
          stack.push(o);
        }
      }
    }
    comps++;
  }
  const along = g.nodes.filter((n) => near[n.id] && !isBendNode(g, n.id)).sort((x, y) => frameU(f, x.x, x.z) - frameU(f, y.x, y.z) || x.id - y.id);
  const recesses: [number, number][] = [];
  for (let i = 0; i + 1 < along.length; i++) {
    const a = along[i];
    const b = along[i + 1];
    if (mouths.has(a.id) && mouths.has(b.id) && comp[a.id] !== comp[b.id] && frameU(f, b.x, b.z) - frameU(f, a.x, a.z) >= HARBOR_RUN.recessMin) recesses.push([a.id, b.id]);
  }
  const out: HarborShore = { shore, ring, mouths, recesses };
  cache.set(area, { g, nodes: g.nodes.length, edges: g.edges.length, shore: out });
  return out;
}
