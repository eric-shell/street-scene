/**
 * Where the parking lots go and what shape they take (districts/parkingLot.ts plans with this).
 *
 * Sites. A lot takes part of a block, so the candidates are blocks no module claimed: convex, of the
 * usual size (not a park-sized hole), on plain streets all round, with no claimed node (a roundabout, the
 * El's stairs) and no claimed edge, clear of every other district's outline and on mild ground (the lot is
 * flat asphalt laid on the terrain, so the grade and the spread of height across the block are bounded).
 * The rule that matters for the races is checked on the lot itself, not its block: no street it fronts is a
 * route edge and it keeps routeNodeClear from every route node and routeEdgeClear from the route's streets.
 * A route's closed side streets all start at route nodes and its barriers and street meets
 * (render/race/meetPlan.ts) stand in them, so a lot near a node could front a meet; the circuit and the
 * sprint are the planned routes (PlanContext.event), the drag strip stays off the streets the lots cut
 * (world.ts stripStreet), and the waypoint race is an open world with no barriers.
 * How many: one to three per seed by the weights in PARKING_LOT, picked among the sites by weight (the
 * edge of downtown, near a harbor, night market, monument or car park: the places people park to go to),
 * never two on blocks sharing a street.
 *
 * Shape. The lot fronts a street side (its frame: u along it, w into the block): a run of consecutive
 * pieces of one street that bend gently (streets are chains of pieces through bend nodes), the longest
 * runs tried first. A
 * strip lot runs from that side to a depth of 0.4 to 0.85 of the block's, the rest of the block staying
 * buildings (at least minRest m of it, else the lot takes the whole block); a whole-block lot is the
 * block's ring. Either way the lot polygon is the block ring clipped at that depth, so its street edges lie
 * exactly on the block ring (the frontage wall line, which the lot opens) and a strip has one back edge.
 *
 * Cuts. The front side gets an entrance and an exit with a ticket island between them (two curb cuts,
 * busBays.ts mouthBay, each the sidewalk deep with flared returns), and up to PARKING_LOT.cut.extra of the
 * other long street sides one cut each: that is what makes a corner lot a way through a corner. All the
 * numbers are written into the area's params (see layout.ts for the names), so nothing needs the graph
 * again later. The cut streets are claimed, so no lane closure is planned on them.
 */
import { PARKING_LOT as C } from '../../config';
import type { BlockFace } from '../../blocks';
import { computeMouths } from '../../blocks';
import { edgeSides } from '../../props';
import { isRiverEdge, downtownFactor } from '../../roadGraph';
import { type Terrain, createTerrain } from '../../terrain';
import { type Vec2, abs, distToSegment, exp, sqrt } from '../../../sim/math';
import { Rng, deriveSeed } from '../../../sim/prng';
import { clipConvex, distToPolygonEdge, pointInPolygon, polygonArea, polygonBounds, polygonCentroid } from '../geom';
import { convexRing } from '../park';
import type { Area, PlanContext } from '../types';
import { lotChord } from './layout';

/** A lot shaped on a block: its polygon, the numbers planned into the area's params, the streets its cuts are on. */
interface LotShape {
  polygon: Vec2[];
  params: Record<string, number>;
  roads: number[];
  strip: boolean;
}

/** The route as the planners see it: its nodes and edges, for the clearance checks. */
interface RouteSets {
  nodes: Set<number>;
  edges: Set<number>;
}

const dist = (a: Vec2, b: Vec2) => sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

/** Does any vertex of one polygon lie in the other (cheap overlap test for the outlines districts leave)? */
function overlaps(a: Vec2[], b: Vec2[]): boolean {
  const ba = polygonBounds(a);
  const bb = polygonBounds(b);
  if (ba.maxX < bb.minX || bb.maxX < ba.minX || ba.maxZ < bb.minZ || bb.maxZ < ba.minZ) return false;
  return a.some((p) => pointInPolygon(p.x, p.z, b)) || b.some((p) => pointInPolygon(p.x, p.z, a));
}

/** Plan the seed's lots: add an area for each. */
export function planParkingLots(ctx: PlanContext): void {
  if (!C.enabled) return;
  const g = ctx.graph;
  const rng = ctx.rng;
  const route: RouteSets = { nodes: new Set(), edges: new Set() };
  for (const r of ctx.event?.routes ?? []) {
    for (const n of r.nodes) route.nodes.add(n);
    for (const e of r.edges) route.edges.add(e);
  }
  const terrain = createTerrain(ctx.seed);
  const near = ctx.areas.filter((a) => (C.nearKinds as readonly string[]).includes(a.kind) && a.polygon.length >= 3);
  const others = ctx.areas.filter((a) => a.kind !== 'downtown' && a.polygon.length >= 3);

  // Draws first, whatever the sites turn out to be: the stream does not depend on the city's other districts.
  let r0 = rng.next() * (C.countWeights[0] + C.countWeights[1] + C.countWeights[2]);
  let want = C.countWeights.length;
  for (let i = 0; i < C.countWeights.length; i++) {
    r0 -= C.countWeights[i];
    if (r0 < 0) {
      want = i + 1;
      break;
    }
  }
  const picks = Array.from({ length: 12 }, () => rng.next());

  const sites: { f: BlockFace; weight: number }[] = [];
  for (const f of ctx.faces()) {
    if (f.outer || ctx.claims.face.has(f.id) || f.area < C.faceArea[0] || f.area > C.faceArea[1] || !convexRing(f.ring)) continue;
    const c = polygonCentroid(f.ring);
    const df = downtownFactor(g.plan, c.x, c.z);
    let weight = C.baseWeight + C.edgeBoost * exp(-(((df - C.edgeAt) / C.edgeWidth) ** 2));
    if (near.some((a) => pointInPolygon(c.x, c.z, a.polygon) || distToPolygonEdge(c.x, c.z, a.polygon) < C.nearReach)) weight += C.nearBoost;
    sites.push({ f, weight });
  }
  if (!sites.length) return;

  const mouths = computeMouths(g, ctx.sectors());
  let made = 0;
  for (let attempt = 0; attempt < picks.length && made < want && sites.length; attempt++) {
    let total = 0;
    for (const s of sites) total += s.weight;
    let r = picks[attempt] * total;
    let k = 0;
    for (; k < sites.length - 1; k++) {
      r -= sites[k].weight;
      if (r < 0) break;
    }
    const f = sites[k].f;
    sites.splice(k, 1);
    const shape = shapeLot(ctx, f, mouths, route, terrain, others);
    if (!shape) continue;
    const a = ctx.addArea({ kind: 'parkingLot', variant: shape.strip ? 'strip' : 'block', polygon: shape.polygon, path: [], nodes: [], edges: [], faces: [], params: { ...shape.params, face: f.id } }, 0);
    for (const e of shape.roads) ctx.claims.edge.set(e, a.id);
    made++;
    // Never two lots on blocks that share a street.
    for (let i = sites.length - 1; i >= 0; i--) if (sites[i].f.edges.some((e) => f.edges.includes(e))) sites.splice(i, 1);
  }
}

/** A run of consecutive straight street pieces of a block ring: segments `i0` .. `i1` - 1, from ring[i0] to ring[i1]. */
interface Run {
  i0: number;
  i1: number;
  len: number;
}

/** The street sides of a ring: maximal runs of street pieces that bend gently, longest first (ties by position). */
function frontRuns(f: BlockFace): Run[] {
  const ring = f.ring;
  const n = ring.length;
  const runs: Run[] = [];
  const turn = (i: number) => {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const r = ring[(i + 2) % n];
    return abs(Math.atan2((q.x - p.x) * (r.z - q.z) - (q.z - p.z) * (r.x - q.x), (q.x - p.x) * (r.x - q.x) + (q.z - p.z) * (r.z - q.z)));
  };
  for (let i = 0; i < n; i++) {
    if (f.segEdge[i] < 0) continue;
    // Start only where the run cannot be extended backwards.
    const prev = (i - 1 + n) % n;
    if (f.segEdge[prev] >= 0 && turn(prev) <= C.frontBend) continue;
    let j = i + 1;
    while (j - i < n && f.segEdge[j % n] >= 0 && turn((j - 1) % n) <= C.frontBend) j++;
    // Trim the end until the run is a gentle bow.
    let end = j;
    for (; end > i + 1; end--) {
      const a = ring[i];
      const b = ring[end % n];
      const l = dist(a, b) || 1;
      let bow = 0;
      for (let k = i + 1; k < end; k++) bow = Math.max(bow, abs(((ring[k % n].x - a.x) * (b.z - a.z) - (ring[k % n].z - a.z) * (b.x - a.x)) / l));
      if (bow <= C.frontBow) break;
    }
    const len = dist(ring[i], ring[end % n]);
    if (len >= C.minSide) runs.push({ i0: i, i1: end % n, len });
  }
  return runs.sort((p, q) => q.len - p.len || p.i0 - q.i0);
}

/** Shape a lot on block `f`, or null when no layout of it works. */
function shapeLot(ctx: PlanContext, f: BlockFace, mouths: ReturnType<typeof computeMouths>, route: RouteSets, terrain: Terrain, others: Area[]): LotShape | null {
  const rng = new Rng(deriveSeed(ctx.seed, `parkingLot:${f.id}`));
  // Every draw up front, so a rejected front does not shift the next one's.
  const draws = Array.from({ length: 6 }, () => ({ shape: rng.next(), share: rng.next(), cut: rng.next(), extra: [rng.next(), rng.next()], seed: rng.int(1, 0x7ffffffe), occ: rng.range(C.occupancy[0], C.occupancy[1]) }));
  const runs = frontRuns(f);
  for (let k = 0; k < Math.min(runs.length, draws.length); k++) {
    const shape = shapeOn(ctx, f, runs[k], draws[k], mouths, route, terrain, others);
    if (shape) return shape;
  }
  return null;
}

function shapeOn(ctx: PlanContext, f: BlockFace, run: Run, d: { shape: number; share: number; cut: number; extra: number[]; seed: number; occ: number }, mouths: ReturnType<typeof computeMouths>, route: RouteSets, terrain: Terrain, others: Area[]): LotShape | null {
  const g = ctx.graph;
  const ring = f.ring;
  const n = ring.length;
  const o = ring[run.i0];
  const q = ring[run.i1];
  const u = { x: (q.x - o.x) / run.len, z: (q.z - o.z) / run.len };
  const w = { x: u.z, z: -u.x };
  const wOf = (p: Vec2) => (p.x - o.x) * w.x + (p.z - o.z) * w.z;
  const blockDepth = Math.max(...ring.map(wOf));
  if (blockDepth < C.minDepth) return null;
  let strip = d.shape >= C.fullChance;
  let depth = blockDepth;
  if (strip) {
    depth = Math.max(C.minDepth, blockDepth * (C.depthShare[0] + (C.depthShare[1] - C.depthShare[0]) * d.share));
    if (blockDepth - depth < C.minRest) strip = false;
  }
  let poly = ring.slice();
  if (strip) {
    const a = { x: o.x + w.x * depth, z: o.z + w.z * depth };
    poly = clipConvex(ring, a, { x: a.x + u.x, z: a.z + u.z }, 1);
    if (poly.length < 3) return null;
  } else depth = blockDepth;
  if (abs(polygonArea(poly)) < C.minArea) return null;
  const m = poly.length;
  const uv = poly.map((p): Vec2 => ({ x: (p.x - o.x) * u.x + (p.z - o.z) * u.z, z: wOf(p) }));

  // The ground under it: mild, and nobody else's (a hill's slope, the river's bank, a highway's footprint).
  {
    const bb = polygonBounds(poly);
    let lo = Infinity;
    let hi = -Infinity;
    let steep = 0;
    for (let x = bb.minX; x <= bb.maxX; x += 10) {
      for (let z = bb.minZ; z <= bb.maxZ; z += 10) {
        if (!pointInPolygon(x, z, poly)) continue;
        const h = terrain.heightAt(x, z);
        const sl = terrain.slopeAt(x, z);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
        steep = Math.max(steep, sqrt(sl.gx * sl.gx + sl.gz * sl.gz));
      }
    }
    if (steep > C.maxGrade || hi - lo > C.maxRise) return null;
  }
  for (const a of others) if (overlaps(poly, a.polygon) || poly.some((p) => distToPolygonEdge(p.x, p.z, a.polygon) < C.districtClear)) return null;
  // The streets round the block that are not plain (an alley, the El's, a highway's) and the junctions other districts hold are kept clear of.
  for (const e of f.edges) {
    const E = g.edges[e];
    const plain = (C.edgeKinds as readonly string[]).includes(E.kind) && !E.shortcut && !E.bridge && E.crossing === undefined && !isRiverEdge(E) && !ctx.claims.edge.has(e);
    if (plain) continue;
    const A = g.nodes[E.a];
    const B = g.nodes[E.b];
    if (poly.some((p) => distToSegment(p.x, p.z, A.x, A.z, B.x, B.z) < C.badStreetClear)) return null;
  }
  for (const c of f.corners) {
    if (!g.nodes[c.node].ring && !ctx.claims.node.has(c.node)) continue;
    const N = g.nodes[c.node];
    if (pointInPolygon(N.x, N.z, poly) || distToPolygonEdge(N.x, N.z, poly) < C.alleyMouthClear) return null;
  }

  // Races: off the route's streets and well away from its nodes (and so its closures and meets).
  const samples: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const p = poly[i];
    const pn = poly[(i + 1) % m];
    const steps = Math.max(1, Math.ceil(dist(p, pn) / 10));
    for (let s = 0; s < steps; s++) samples.push({ x: p.x + ((pn.x - p.x) * s) / steps, z: p.z + ((pn.z - p.z) * s) / steps });
  }
  for (const nid of route.nodes) {
    const N = g.nodes[nid];
    if (pointInPolygon(N.x, N.z, poly) || distToPolygonEdge(N.x, N.z, poly) < C.routeNodeClear) return null;
  }
  for (const eid of route.edges) {
    const E = g.edges[eid];
    const A = g.nodes[E.a];
    const B = g.nodes[E.b];
    for (const s of samples) if (distToSegment(s.x, s.z, A.x, A.z, B.x, B.z) < C.routeEdgeClear) return null;
  }

  // Polygon edges: the front ones, the strip's back edge, the street sides.
  let back = -1;
  for (let i = 0; i < m; i++) if (strip && uv[i].z > depth - 1e-6 && uv[(i + 1) % m].z > depth - 1e-6) back = i;
  /** Front pieces: polygon edges lying along the run (both ends near the frame's front line). */
  const frontEdges: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = uv[i];
    const b = uv[(i + 1) % m];
    if (i !== back && a.z < C.frontBow + 1 && b.z < C.frontBow + 1 && b.x > a.x + 1) frontEdges.push(i);
  }
  if (!frontEdges.length) return null;
  const lenOf = (i: number) => dist(poly[i], poly[(i + 1) % m]);
  frontEdges.sort((p, r) => lenOf(r) - lenOf(p) || p - r);
  const aEdge = frontEdges[0];

  const params: Record<string, number> = {
    seed: d.seed,
    strip: strip ? 1 : 0,
    depth,
    fox: o.x,
    foz: o.z,
    fux: u.x,
    fuz: u.z,
    fwx: w.x,
    fwz: w.z,
    front: run.len,
    aEdge,
    back,
    occ: d.occ,
    pair: 0,
    cuts: 0,
  };
  const roads: number[] = [];
  const cutList: Record<string, number>[] = [];
  const Kc = C.cut;

  /** The curb cut of half width `hw` centred `t` m along polygon edge `i`, or null when the edge is no straight piece of a street side. */
  const cutAt = (i: number, t: number, hw: number): Record<string, number> | null => {
    const p = poly[i];
    const pn = poly[(i + 1) % m];
    const len = dist(p, pn);
    const dd = { x: (pn.x - p.x) / len, z: (pn.z - p.z) / len };
    const mid = { x: (p.x + pn.x) / 2, z: (p.z + pn.z) / 2 };
    let seg = -1;
    for (let r = 0; r < n; r++) {
      if (f.segEdge[r] < 0) continue;
      const s0 = ring[r];
      const s1 = ring[(r + 1) % n];
      const sl = dist(s0, s1);
      if (sl < 1e-6) continue;
      const par = ((s1.x - s0.x) * dd.x + (s1.z - s0.z) * dd.z) / sl;
      const off = abs((mid.x - s0.x) * (-(s1.z - s0.z) / sl) + (mid.z - s0.z) * ((s1.x - s0.x) / sl));
      const along = ((mid.x - s0.x) * (s1.x - s0.x) + (mid.z - s0.z) * (s1.z - s0.z)) / sl;
      if (par > 0.999 && off < 0.2 && along > -0.2 && along < sl + 0.2) {
        seg = r;
        break;
      }
    }
    if (seg < 0) return null;
    const road = f.segEdge[seg];
    if (route.edges.has(road) || route.nodes.has(g.edges[road].a) || route.nodes.has(g.edges[road].b)) return null;
    const sd = edgeSides(g, mouths, road);
    const off2 = sd.map((s) => {
      const l = dist(s.from, s.to) || 1;
      return abs((mid.x - s.from.x) * (-(s.to.z - s.from.z) / l) + (mid.z - s.from.z) * ((s.to.x - s.from.x) / l));
    });
    const side = off2[0] <= off2[1] ? 0 : 1;
    const S = sd[side];
    const sl = dist(S.from, S.to) || 1;
    const su = { x: (S.to.x - S.from.x) / sl, z: (S.to.z - S.from.z) / sl };
    const dirSign = dd.x * su.x + dd.z * su.z > 0 ? 1 : -1;
    const sc = (p.x - S.from.x) * su.x + (p.z - S.from.z) * su.z + dirSign * t;
    const s0 = sc - hw - Kc.flare;
    const s1 = sc + hw + Kc.flare;
    // Inside the street side's own curb, a few metres from its ends.
    if (s0 < 3 || s1 > sl - 3) return null;
    return { e: i, t, h: hw, r: road, d: side === 0 ? 1 : -1, a: s0, b: s1, f: Kc.flare };
  };

  // The entrance and exit on the longest front piece with the ticket island between them, else one wide cut.
  const hw = Kc.width / 2;
  const tMin = Kc.endClear + hw + Kc.flare;
  const L = lenOf(aEdge);
  const half = (Kc.width + Kc.pairGap) / 2;
  if (L - tMin >= tMin + 2 * half) {
    const c = tMin + half + (L - 2 * tMin - 2 * half) * d.cut;
    const first = cutAt(aEdge, c - half, hw);
    const second = cutAt(aEdge, c + half, hw);
    if (!first || !second) return null;
    cutList.push(first, second);
    params.pair = 1;
  } else {
    const hs = Kc.single / 2;
    const lo = Kc.endClear + hs + Kc.flare;
    if (L < 2 * lo) return null;
    const one = cutAt(aEdge, lo + (L - 2 * lo) * d.cut, hs);
    if (!one) return null;
    cutList.push(one);
  }
  // One cut on each of the next longest street sides (a corner lot is a way through the corner).
  const extra: { i: number; len: number }[] = [];
  for (let i = 0; i < m; i++) {
    if (i === aEdge || i === back) continue;
    const len = lenOf(i);
    if (len >= Kc.extraMinSide) extra.push({ i, len });
  }
  extra.sort((p, r) => r.len - p.len || p.i - r.i);
  const minLen = 2 * tMin;
  const base = cutList.length;
  for (let k = 0; k < extra.length && cutList.length < base + Kc.extra; k++) {
    const { i, len } = extra[k];
    if (len < minLen) continue;
    const cut = cutAt(i, tMin + (len - 2 * tMin) * (0.2 + 0.6 * d.extra[k % 2]), hw);
    if (cut) cutList.push(cut);
  }
  params.cuts = cutList.length;
  cutList.forEach((c, i) => {
    for (const key of Object.keys(c)) params[`c${i}${key}`] = c[key];
    if (!roads.includes(c.r)) roads.push(c.r);
  });

  // The drift zone: the forecourt behind the entrance, past the booth island, in from the fences.
  const w0 = C.zoneFrom;
  const w1 = C.forecourt - 0.5;
  const c0 = lotChord(uv, w0);
  const c1 = lotChord(uv, w1);
  const inset = C.fence.thickness + C.zoneInset;
  const z0 = Math.max(c0[0], c1[0]) + inset;
  const z1 = Math.min(c0[1], c1[1]) - inset;
  if (z1 - z0 >= 24) {
    params.ox = o.x + u.x * z0 + w.x * w0;
    params.oz = o.z + u.z * z0 + w.z * w0;
    params.ux = u.x;
    params.uz = u.z;
    params.wx = w.x;
    params.wz = w.z;
    params.lu = z1 - z0;
    params.lw = w1 - w0;
  }
  return { polygon: poly, params, roads, strip };
}
