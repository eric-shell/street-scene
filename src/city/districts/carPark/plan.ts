/**
 * Where car parks go. A candidate is a block beside a route turn (a junction C with no street straight
 * behind it) whose street E lines up with a chute, found for each route (carParkCandidates), scored by the
 * route distance the shortcut saves to a landing point past C. planCarParks claims the best once the graph is
 * final; carParkSites holds each route's best sites while the alley shortcuts are carved (as PlanContext.keepOut,
 * so a corner cut does not take their block). The footprint is the block, its building line inset, or cut down
 * behind the drive, or the largest frame rectangle that fits (footprintFor); flightReach is the launch the
 * landing zone must hold.
 */
import { CITY, ROUTE } from '../../config';
import { edgeBetween, isBendNode, otherNode } from '../../roadGraph';
import type { RoadGraph } from '../../roadGraph';
import { circuitStart, routeRuns } from '../../route';
import { createTerrain } from '../../terrain';
import { DEG, Vec2, atan2, cos, sin, sqrt } from '../../../sim/math';
import { clipConvex, distToPath, distToPolygonEdge, insetRing, pointInPolygon, polygonArea } from '../geom';
import { convexRing } from '../park';
import type { PlanContext } from '../types';
import type { CarveRoute } from '../alleyShortcuts';
import { APRON, CAR_HALF, type CarParkGeo, type Frame, carParkGeo, flightCorridor, footprint, frontU, rampPoint, toU, toV, toWorld, unit } from './geometry';

const CFG = CITY.districts.carPark;

/** Building line straightness tolerance across the deck (m), outline sample step (m). */
const STRAIGHT_TOL = 0.35;
const SAMPLE = 2;
/** Upstream route edges that may hold the entry (2: the one before the street into C). */
const ENTRY_BACK = [2, 3, 4, 5, 6];
/** Sites held per route while the alleys are carved (carParkSites). */
const SITES_HELD = 3;
/** Landing point (m past C) both the route and the car park are measured to when scoring a site. */
const SCORE_LAND = 30;

interface Candidate {
  face: number;
  /** Streets it claims: the entry's, the one into C, every one at C and the landing straight's. */
  edges: number[];
  params: Record<string, number>;
  outline: Vec2[];
  path: Vec2[];
  footprint: number;
  /** Route distance saved to the scoring landing point (m). */
  score: number;
}

/** Route node positions along the node polyline (m), its length and the span cuts may use (alleyShortcuts.ts routeBounds and its sprint guards). */
function routeFrame(g: RoadGraph, r: CarveRoute): { cum: number[]; total: number; lo: number; hi: number } {
  const n = r.nodes.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + unit(g.nodes[r.nodes[i - 1]], g.nodes[r.nodes[i]]).len);
  const total = cum[n - 1] + (r.closed ? unit(g.nodes[r.nodes[n - 1]], g.nodes[r.nodes[0]]).len : 0);
  if (r.closed) return { cum, total, lo: 0, hi: total };
  let finish = total - ROUTE.sprintFinishOffset;
  for (let i = n - 2; i > 0; i--) if (Math.abs(finish - cum[i]) < ROUTE.sprintFinishNodeClear) finish = cum[i] - ROUTE.sprintFinishNodeClear;
  return { cum, total, lo: ROUTE.sprintStartOffset + 25, hi: Math.min(finish - ROUTE.sprintFinishNodeClear, total - ROUTE.sprintFinishOffset - ROUTE.sprintFinishNodeClear - 30) };
}

/** Signed turn (rad) at route index i (0 at a sprint's ends). */
function turnAt(g: RoadGraph, r: CarveRoute, i: number): number {
  const n = r.nodes.length;
  if (!r.closed && (i <= 0 || i >= n - 1)) return 0;
  const a = g.nodes[r.nodes[(i - 1 + n) % n]];
  const b = g.nodes[r.nodes[i]];
  const c = g.nodes[r.nodes[(i + 1) % n]];
  const d1x = b.x - a.x;
  const d1z = b.z - a.z;
  const d2x = c.x - b.x;
  const d2z = c.z - b.z;
  return atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
}

/** First crossing (distance along unit d from p, at most max) of a ray with a polygon's outline, or null. */
function rayHit(p: Vec2, d: Vec2, poly: Vec2[], max: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const den = d.x * sz - d.z * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - p.x) * sz - (a.z - p.z) * sx) / den;
    const s = ((a.x - p.x) * d.z - (a.z - p.z) * d.x) / den;
    if (t >= 0 && t <= max && s >= 0 && s <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Ballistic reach (m from the lip) of a launch at v m/s off the roof over the kicker (its lip slope 2 kh / kl). */
export function flightReach(v: number): number {
  const a = atan2((2 * CFG.kickHeight) / CFG.kickLength, 1);
  const vy = v * sin(a);
  const vx = v * cos(a);
  const g = 9.81;
  return (vx * (vy + sqrt(vy * vy + 2 * g * (CFG.deckHeight + CFG.kickHeight)))) / g;
}

/** The drive's box on the deck as a world polygon: its back corners at v0 and v1, then the front from v1 round to v0. */
function driveBox(g: CarParkGeo): Vec2[] {
  const W = (u: number, v: number) => toWorld(g, u, v);
  return [W(g.u1, g.v0), W(g.u1, g.v1), ...g.front.map((f) => W(f.u, f.v)).reverse()];
}

/** How many of a polygon's edges the infinite line a-b crosses. */
function lineCrossings(poly: Vec2[], a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let n = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    if (dx * (p.z - a.z) - dz * (p.x - a.x) > 0 !== dx * (q.z - a.z) - dz * (q.x - a.x) > 0) n++;
  }
  return n;
}

/** Whether a point is inside a polygon or within `tol` of its outline. */
function inOrOn(p: Vec2, poly: Vec2[], tol: number): boolean {
  return pointInPolygon(p.x, p.z, poly) || distToPolygonEdge(p.x, p.z, poly) <= tol;
}

/**
 * The garage's footprint for a planned drive (its box and ramp) in a block:
 * the block's building line inset (`base`) when its area is within
 * CFG.blockArea. A bigger convex block is cut down to the range's top along
 * a line behind the drive (u = ub), and beside it if that is not enough; a
 * bigger concave block (an L: a cut could split it) gets none. Null when
 * nothing fits or the drive does not fit the result (a cut would take the
 * ramp's foot).
 */
function footprintFor(ring: Vec2[], base: Vec2[] | null, g: CarParkGeo): Vec2[] | null {
  if (!base) return null;
  const [minA, maxA] = CFG.blockArea;
  const W = (u: number, v: number) => toWorld(g, u, v);
  const must = [...driveBox(g), ...g.ramp];
  const holds = (poly: Vec2[]) => poly.length >= 3 && must.every((p) => inOrOn(p, poly, 0.3));
  const area = (poly: Vec2[]) => Math.abs(polygonArea(poly));
  const a = area(base);
  if (a < minA) return null;
  if (a <= maxA) return holds(base) ? base : null;
  // A bigger concave block (an L) is cut the same way as long as each cut line crosses it just twice
  // (a clip leaves one piece then); one that would split it gets none.
  const convex = convexRing(ring);
  // What the floor has to reach round the drive, in the frame (a clearance that runs out past a building
  // line the drive stands on is harmless: the cut there takes nothing).
  let uNeed = -Infinity;
  let vLo = Infinity;
  let vHi = -Infinity;
  for (const p of must) {
    uNeed = Math.max(uNeed, toU(g, p) + CFG.clear);
    vLo = Math.min(vLo, toV(g, p) - CFG.clear);
    vHi = Math.max(vHi, toV(g, p) + CFG.clear);
  }
  // u <= ub keeps the drive's side of the cut: (b - a) x (p - a) along the v axis is -du; along u it is dv.
  let split = false;
  const clip = (poly: Vec2[], a: Vec2, b: Vec2, side: 1 | -1) => {
    if (!convex && lineCrossings(poly, a, b) > 2) split = true;
    return clipConvex(poly, a, b, side);
  };
  const cutU = (poly: Vec2[], ub: number) => clip(poly, W(ub, 0), W(ub, 1), 1);
  const cutV = (poly: Vec2[], dv: number) => {
    const vc = (vLo + vHi) / 2;
    return clip(clip(poly, W(0, vc - dv), W(1, vc - dv), 1), W(0, vc + dv), W(1, vc + dv), -1);
  };
  let uMax = -Infinity;
  for (const p of base) uMax = Math.max(uMax, toU(g, p));
  let poly: Vec2[];
  if (area(cutU(base, uNeed)) <= maxA) {
    // The furthest cut (bisection, to half a meter) that keeps the area under the top.
    let lo = uNeed;
    let hi = uMax;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (area(cutU(base, mid)) <= maxA) lo = mid;
      else hi = mid;
    }
    split = false;
    poly = cutU(base, lo);
  } else {
    poly = cutU(base, uNeed);
    if (split) return null;
    let lo = (vHi - vLo) / 2;
    if (area(cutV(poly, lo)) > maxA) return null;
    let hi = 400;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (area(cutV(poly, mid)) <= maxA) lo = mid;
      else hi = mid;
    }
    split = false;
    poly = cutV(poly, lo);
  }
  return !split && holds(poly) ? poly : null;
}

/**
 * Plan car parks for the routes (see the header): at most CFG.perRoute per
 * route, the biggest saving first. Runs at the very end of the topology hook,
 * after every graph edit (it claims a block face). Deterministic.
 */
export function planCarParks(ctx: PlanContext, routes: CarveRoute[]): void {
  if (!CFG.enabled) return;
  routes.forEach((_, ri) => {
    for (let k = 0; k < CFG.perRoute; k++) {
      const list = carParkCandidates(ctx, routes, ri);
      // Biggest saving first; ties keep route order (stable sort), so the pick is deterministic.
      list.sort((a, b) => b.score - a.score);
      const c = list.find((x) => ctx.budget.used + x.footprint <= ctx.budget.total);
      if (!c) return;
      c.params.seed = ctx.rng.int(1, 0x7ffffffe);
      // Its streets and junction now (markets, roadworks, tunnels and overpasses keep off them), its block
      // once the night market's graph edit is done (carParkModule.plan).
      ctx.addArea({ kind: 'carPark', variant: c.params.side === 0 ? 'back' : 'side', polygon: c.outline, path: c.path, nodes: [c.params.node], edges: c.edges, faces: [], params: c.params }, c.footprint);
    }
  });
}

/**
 * The best car park site of each route on the graph as it is now, as the
 * polygons the alley carver keeps out of (PlanContext.keepOut): the block it
 * stands in, the frontage and the street in front of its lip and driveway,
 * and the flight down E. Planned again for real once the alleys are carved.
 */
export function carParkSites(ctx: PlanContext, routes: CarveRoute[]): Vec2[][][] {
  if (!CFG.enabled) return [];
  const sites: Vec2[][][] = [];
  const faces = new Set<number>();
  routes.forEach((_, ri) => {
    const list = carParkCandidates(ctx, routes, ri);
    list.sort((a, b) => b.score - a.score);
    // The best layout in each of the route's best few blocks: an alley's mouth may still spoil one.
    let held = 0;
    for (const c of list) {
      if (held >= SITES_HELD || faces.has(c.face)) continue;
      held++;
      faces.add(c.face);
      const g = carParkGeo({ id: -1, kind: 'carPark', variant: '', polygon: [], path: [], nodes: [], edges: [], faces: [], params: c.params });
      const W = (u: number, v: number) => toWorld(g, u, v);
      const out = -(g.lipBack + 3);
      // The driveway: from the foot out across the entry street, its flare and a mouth's reach either side.
      const wide = g.rhw + Math.max(g.fl, g.fr) + 10;
      const across = { x: -g.raz, z: g.rax };
      const foot = rampPoint(g, 0, 0);
      const street = (k: number, l: number) => ({ x: foot.x - g.fnx * k + across.x * l, z: foot.z - g.fnz * k + across.z * l });
      sites.push([
        ...footprint(g, 6),
        [W(frontU(g, g.v0) + 2, g.v0 - 10), W(out, g.v0 - 10), W(out, g.v1 + 10), W(frontU(g, g.v1) + 2, g.v1 + 10)],
        [street(-3, -wide), street(14, -wide), street(14, wide), street(-3, wide)],
        flightCorridor(g, g.lipBack + g.landZone, 6),
      ]);
    }
  });
  return sites;
}

/** Every valid car park layout for route ri, scored (a dry run: nothing is claimed). */
export function carParkCandidates(ctx: PlanContext, routes: CarveRoute[], ri: number): Candidate[] {
  const g = ctx.graph;
  const r = routes[ri];
  const R = r.nodes;
  const n = R.length;
  const faces = ctx.faces();
  const { cum, total, lo, hi } = routeFrame(g, r);
  const out: Candidate[] = [];
  // The ground the car park will stand on (hills keep their slopes off car parks, see hills.ts).
  const ground = createTerrain(ctx.seed);
  /**
   * The shortest ramp length from `rl` up (to `Lmax`) whose climb, its own grade plus the ground's
   * rise along it, stays under maxClimb: steeper, a car's pitch sits at its clamp (car.ts) and the
   * front wheels leave the deck over the crest. Infinity when none does.
   */
  const climbable = (foot: Vec2, A: Vec2, apron1: number, rl: number, Lmax: number): number => {
    const c = CITY.curbHeight;
    const h0 = ground.heightAt(foot.x + A.x * apron1, foot.z + A.z * apron1);
    for (let L = rl; L <= Lmax + 1e-6; L += 4) {
      const rise = ground.heightAt(foot.x + A.x * (apron1 + L), foot.z + A.z * (apron1 + L)) - h0;
      if ((CFG.deckHeight - c) / (L - CFG.rampEase) + Math.max(0, rise / L) <= CFG.maxClimb) return L;
    }
    return Infinity;
  };
  // The circuit's start line and grid sit in the middle of its longest street (route.ts circuitStart:
  // a run of pieces through bend nodes, roadGraph.ts); none of that run hosts the chute or the entry.
  const startEdges = new Set<number>(r.closed ? circuitStart(g, R).run.edges : []);
  // The route's edges and their streets (runs): the entry street is a whole street back from C.
  const routeEdgeList: number[] = [];
  for (let i = 0; i + (r.closed ? 0 : 1) < n; i++) routeEdgeList.push(edgeBetween(g, R[i], R[(i + 1) % n]));
  const runs = routeRuns(g, R, routeEdgeList, r.closed);
  const runOf = new Int32Array(routeEdgeList.length).fill(-1);
  runs.forEach((run, ri) => run.edges.forEach((_, k) => (runOf[(run.from + k) % routeEdgeList.length] = ri)));
  // The route's alley shortcuts: a car park keeps its span clear of theirs.
  const pos = new Map<number, number>();
  R.forEach((id, i) => pos.set(id, cum[i]));
  const spans: [number, number][] = [];
  for (const e of g.edges) {
    if (!e.shortcut) continue;
    const a = pos.get(e.a);
    const b = pos.get(e.b);
    if (a !== undefined && b !== undefined) spans.push([Math.min(a, b), Math.max(a, b)]);
  }
  const blocked = ctx.areas.filter((a) => a.kind !== 'downtown' && a.kind !== 'hills');
  const okStreet = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    const claim = ctx.claims.edge.get(eid);
    return (e.kind === 'street' || e.kind === 'avenue' || e.kind === 'boulevard' || e.kind === 'diagonal') && !e.bridge && !e.shortcut && (claim === undefined || ctx.areas[claim].kind === 'hills');
  };
  for (let j = 0; j < n; j++) {
    if (!r.closed && (j < 2 || j > n - 2)) continue;
    const C = g.nodes[R[j]];
    if (C.ring || ctx.claims.node.has(C.id)) continue;
    const Q = g.nodes[R[(j + 1) % n]];
    const P = g.nodes[R[(j - 1 + n) % n]];
    const eE = edgeBetween(g, C.id, Q.id);
    const eIn = edgeBetween(g, P.id, C.id);
    if (!okStreet(eE) || !okStreet(eIn)) continue;
    const turn = turnAt(g, r, j);
    if (Math.abs(turn) < CFG.minTurnDeg * DEG || Math.abs(turn) > ROUTE.maxTurnDeg * DEG) continue;
    const t = unit(C, Q);
    let behind = false;
    for (const eid of C.edges) {
      const d = unit(C, g.nodes[otherNode(g.edges[eid], C.id)]);
      if (-(d.x * t.x + d.z * t.z) > cos(CFG.behindDeg * DEG)) behind = true;
    }
    if (behind) continue;
    // The landing straight: E and any straight continuation, up to the first junction or turn (its
    // corridor, where closures, crosswalks and rails start). E's own bend nodes are no such thing:
    // the street goes on through them a few degrees at a time, the landing with it.
    let run = 0;
    let end = Q;
    const runEdges: number[] = [];
    for (let k = 0; k < 6 * CITY.bendSegments; k++) {
      if (!r.closed && j + k + 1 > n - 1) break;
      const A = g.nodes[R[(j + k) % n]];
      const B = g.nodes[R[(j + k + 1) % n]];
      const d = unit(A, B);
      if (!isBendNode(g, A.id) && d.x * t.x + d.z * t.z < cos(3 * DEG)) break;
      run += d.len;
      end = B;
      runEdges.push(edgeBetween(g, A.id, B.id));
      if (B.edges.length > 2 || B.ring) break;
    }
    const endCorr = end.ring ? end.ring.outer + CITY.sidewalk : end.edges.reduce((m, eid) => Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk), 0);
    const clearRun = run - endCorr - 4;
    // The face behind C and where the launch line meets its building line.
    const back = { x: -t.x, z: -t.z };
    const corrIn = g.edges[eIn].width / 2 + g.edges[eIn].sidewalk;
    const probe = { x: C.x + back.x * (corrIn + 3), z: C.z + back.z * (corrIn + 3) };
    const fi = faces.findIndex((f) => !f.outer && pointInPolygon(probe.x, probe.z, f.ring));
    // A block claimed, or held by a car park planned earlier in this hook (it claims its block later).
    if (fi < 0 || ctx.claims.face.has(fi) || ctx.areas.some((a) => a.kind === 'carPark' && a.params.face === fi) || (ctx.keepOut ?? []).some((p) => pointInPolygon(probe.x, probe.z, p))) continue;
    const F = faces[fi];
    const sLip = rayHit(C, back, F.ring, corrIn + 6);
    if (sLip === null) continue;
    const lipBack = sLip + CFG.inset;
    const frame: Frame = { ox: C.x + back.x * lipBack, oz: C.z + back.z * lipBack, ux: back.x, uz: back.z, vx: -back.z, vz: back.x };
    // The footprint's base: the block's building line inset (footprintFor); the deck's front is read
    // off it so the two agree exactly.
    const baseRing = insetRing(F.ring, CFG.inset);
    if (!baseRing) continue;
    /** The deck's front line (the base ring) at lateral v, as frame u, or null. */
    const frontAt = (v: number): number | null => {
      const hit = rayHit(toWorld(frame, -30, v), back, baseRing, 60);
      return hit === null ? null : hit - 30;
    };
    // Entry streets: the route's streets ENTRY_BACK[0] - 1 .. ENTRY_BACK[last] - 1 streets before the
    // one arriving at C, each of their pieces that fronts the block in turn.
    const inRun = runOf[(j - 1 + n) % n];
    const entries: { ia: number; ib: number }[] = [];
    for (const k of ENTRY_BACK) {
      const back = k - 1;
      if (inRun < 0 || (r.closed ? back >= runs.length : inRun - back < 0)) break;
      const run = runs[(inRun - back + runs.length) % runs.length];
      for (let q = 0; q < run.edges.length; q++) {
        const idx = (run.from + q) % routeEdgeList.length;
        entries.push({ ia: idx, ib: (idx + 1) % n });
      }
    }
    for (const { ia, ib } of entries) {
      const eY = edgeBetween(g, R[ia], R[ib]);
      if (eY === eIn || !F.edges.includes(eY) || !okStreet(eY)) continue;
      const Ya = g.nodes[R[ia]];
      const Yb = g.nodes[R[ib]];
      const dY = unit(Ya, Yb);
      // The entry street's building line on F (its longest straight ring segment along it).
      let seg: [Vec2, Vec2] | null = null;
      for (let i = 0; i < F.ring.length; i++) {
        if (F.segEdge[i] !== eY) continue;
        const a = F.ring[i];
        const b = F.ring[(i + 1) % F.ring.length];
        if (!seg || unit(a, b).len > unit(seg[0], seg[1]).len) seg = [a, b];
      }
      if (!seg) continue;
      const fl = unit(seg[0], seg[1]);
      // Inward normal: the block is on the right of the ring's travel.
      const N = { x: fl.z, z: -fl.x };
      const base = { x: seg[0].x + N.x * CFG.inset, z: seg[0].z + N.z * CFG.inset };
      const dotU = dY.x * frame.ux + dY.z * frame.uz;
      // Side entry when the entry street runs along the chute (within about 40 degrees, the warp
      // tilting streets, roadGraph.ts), back entry when it runs across it; layout checks the skew
      // the ramp can take (an >= 0.85) either way.
      const side = Math.abs(dotU) > 0.75 ? (toV(frame, seg[0]) > 0 ? 1 : -1) : Math.abs(dotU) < 0.6 ? 0 : NaN;
      if (Number.isNaN(side)) continue;
      // Entry clearance from each end of its street: a turning junction's corner rail runs along the
      // outside of the turn, so where the block is on the outside the entry keeps railClear from it.
      const clearAt = (idx: number, other: Vec2) => {
        // A bend node is no junction: the street (and the block's front) goes on past it.
        if (isBendNode(g, R[idx])) return 0;
        if (Math.abs(turnAt(g, r, idx)) < ROUTE.railMinTurnDeg * DEG) return CFG.entryNodeClear;
        const o = g.nodes[R[idx]];
        return (other.x - o.x) * N.x + (other.z - o.z) * N.z > 0 ? CFG.entryNodeClear : CFG.railClear;
      };
      const clearA = clearAt(ia, g.nodes[R[(ia - 1 + n) % n]]);
      const clearB = clearAt(ib, g.nodes[R[(ib + 1) % n]]);
      const feet: Vec2[] = [];
      const along = side !== 0 ? { x: frame.ux, z: frame.uz } : { x: frame.vx, z: frame.vz };
      const den = fl.x * along.x + fl.z * along.z;
      if (Math.abs(den) < 1e-6) continue;
      const mouth = CFG.chuteLength + CFG.chuteFunnel[0];
      const targets = side !== 0 ? [0, 4, -2, CFG.turnRadius[0] - CFG.turnRadius[1], 8, 12, 18, 26, 36].map((du) => mouth + CFG.turnRadius[1] + du) : [0, 3, -3, 6, -6];
      for (const target of targets) {
        const s = (target - (side !== 0 ? toU(frame, base) : toV(frame, base))) / den;
        feet.push({ x: base.x + fl.x * s, z: base.z + fl.z * s });
      }
      const edgeRoom = CFG.rampWidth / 2 + APRON.flareIn + 2;
      // At a bend node the street goes straight on into the next piece (a few degrees off), so the apron may
      // overhang it: the foot only keeps its own half width and a margin from that end, and the next
      // piece joins the car park's claimed streets. The ring segment runs the piece's way (fwd) or against it.
      const bendRoom = CFG.rampWidth / 2 + 2;
      const fwd = fl.x * dY.x + fl.z * dY.z > 0;
      const nextA = ia > 0 || r.closed ? edgeBetween(g, R[(ia - 1 + n) % n], R[ia]) : -1;
      const nextB = ib + 1 < n || r.closed ? edgeBetween(g, R[ib], R[(ib + 1) % n]) : -1;
      const bendA = isBendNode(g, R[ia]) && okStreet(nextA) && nextA !== eY;
      const bendB = isBendNode(g, R[ib]) && okStreet(nextB) && nextB !== eY;
      const roomStart = (fwd ? bendA : bendB) ? bendRoom : edgeRoom;
      const roomEnd = (fwd ? bendB : bendA) ? bendRoom : edgeRoom;
      for (const foot of feet) {
        const s = (foot.x - base.x) * fl.x + (foot.z - base.z) * fl.z;
        if (s < roomStart || s > fl.len - roomEnd) continue;
        const at = (foot.x - Ya.x) * dY.x + (foot.z - Ya.z) * dY.z;
        if (at < clearA || at > dY.len - clearB) continue;
        const params = layout(side, foot, N);
        if (!params) continue;
        // The next pieces the apron reaches over.
        const over: number[] = [];
        if (bendA && (fwd ? s < edgeRoom : s > fl.len - edgeRoom)) over.push(nextA);
        if (bendB && (fwd ? s > fl.len - edgeRoom : s < edgeRoom)) over.push(nextB);
        const cand = validate(params, cum[ia] + at, over);
        if (cand) out.push(cand);
      }

      /** Ramp, deck and chute for a ramp foot on the entry line; params, or null when the site has no room. */
      function layout(side: number, foot: Vec2, N: Vec2): Record<string, number> | null {
        const A = side !== 0 ? { x: -side * frame.vx, z: -side * frame.vz } : { x: -frame.ux, z: -frame.uz };
        const an = A.x * N.x + A.z * N.z;
        if (an < 0.85) {
          return null;
        }
        const rhw = CFG.rampWidth / 2;
        // The apron starts at the deepest point of the building line across its flared width.
        // The wide flare on the side racers come from: they arrive along the entry street (dY).
        const L = { x: -A.z, z: A.x };
        const inLeft = -(L.x * dY.x + L.z * dY.z) > 0;
        const fl = inLeft ? APRON.flareOut : APRON.flareIn;
        const fr = inLeft ? APRON.flareIn : APRON.flareOut;
        const lnS = L.x * N.x + L.z * N.z;
        const apron0 = Math.max(((rhw + fl) * lnS) / an, (-(rhw + fr) * lnS) / an);
        const apron1 = apron0 + APRON.depth;
        const c = CITY.curbHeight;
        const H = CFG.deckHeight;
        const Lmin = (H - c) / CFG.rampGrade[1] + CFG.rampEase;
        const Lmax = (H - c) / CFG.rampGrade[0] + CFG.rampEase;
        const hc = CFG.chuteWidth / 2;
        const wing = hc + CFG.wall + CFG.deckMargin;
        let rl: number;
        let u1: number;
        let v0: number;
        let v1: number;
        let turnR = 0;
        if (side !== 0) {
          // From the apron's end to E's line along the ramp; the deck edge stands rTarget out (or less).
          const reach = Math.abs(toV(frame, foot)) - apron1;
          rl = climbable(foot, A, apron1, Math.min(Lmax, Math.max(Lmin, reach - CFG.turnRadius[1])), Lmax);
          const vd = reach - rl;
          const ur = toU(frame, foot);
          turnR = Math.min(ur - CFG.chuteLength - CFG.chuteFunnel[0], vd);
          if (turnR < CFG.turnRadius[0] || vd < wing || vd > CFG.turnRadius[1] + 30) return null;
          u1 = ur + rhw;
          v0 = side > 0 ? -wing : -vd;
          v1 = side > 0 ? vd : wing;
        } else {
          const reach = toU(frame, foot) - apron1;
          const mouth = CFG.chuteLength + CFG.chuteFunnel[0];
          rl = climbable(foot, A, apron1, Math.min(Lmax, Math.max(Lmin, reach - mouth - CFG.deckRun[1])), Lmax);
          u1 = reach - rl;
          if (u1 - mouth < CFG.deckRun[0]) return null;
          const vr = toV(frame, foot);
          if (Math.abs(vr) > (u1 - mouth) * 0.35) return null;
          v0 = Math.min(vr - rhw - CFG.wall, -wing);
          v1 = Math.max(vr + rhw + CFG.wall, wing);
        }
        // The deck's front follows the building line: its ends, and the block's corner points between
        // them (a junction kinks it), must trace it within STRAIGHT_TOL.
        const f0 = frontAt(0);
        const fa = frontAt(v0);
        const fb = frontAt(v1);
        if (f0 === null || fa === null || fb === null || Math.abs(f0) > 0.05) {
          return null;
        }
        const front = [{ u: fa, v: v0 }];
        const corners = F.ring.map((q) => ({ u: toU(frame, q) + CFG.inset, v: toV(frame, q) })).filter((q) => q.v > v0 + 0.5 && q.v < v1 - 0.5 && Math.abs(q.u) < 10);
        corners.sort((a, b) => a.v - b.v);
        for (const q of corners) front.push(q);
        front.push({ u: fb, v: v1 });
        if (front.length > 6) {
          return null;
        }
        const geoF = { front };
        for (let v = v0; v <= v1; v += SAMPLE / 2) {
          const f = frontAt(v);
          if (f === null || Math.abs(f - frontU(geoF, v)) > STRAIGHT_TOL) {
            return null;
          }
        }
        if (Math.abs(frontU(geoF, -hc) - frontU(geoF, hc)) > 1.2) {
          return null;
        }
        if (u1 - Math.max(...front.map((f) => f.u)) < CFG.chuteLength + CFG.chuteFunnel[0] + 4) {
          return null;
        }
        const fp: Record<string, number> = { fn: front.length };
        front.forEach((f, i) => {
          fp[`fu${i}`] = f.u;
          fp[`fv${i}`] = f.v;
        });
        return {
          owner: ri,
          ox: frame.ox,
          oz: frame.oz,
          ux: frame.ux,
          uz: frame.uz,
          H,
          ...fp,
          u1,
          v0,
          v1,
          hc,
          lc: CFG.chuteLength,
          cf: CFG.chuteFunnel[0],
          cw: CFG.chuteFunnel[1],
          kl: CFG.kickLength,
          kh: CFG.kickHeight,
          rcx: foot.x,
          rcz: foot.z,
          rax: A.x,
          raz: A.z,
          rhw,
          fl,
          fr,
          apron0,
          apron1,
          rl,
          rend: apron1 + rl,
          fnx: N.x,
          fnz: N.z,
          side,
          turn: turnR,
          node: C.id,
          face: fi,
          landEdge: eE,
          entryEdge: eY,
          lipBack,
          landMax: 0,
          landZone: 0,
          seed: 0,
          fpn: 0,
        };
      }

      /** Check a layout against the block, the city and the route: a scored candidate, or null. */
      function validate(params: Record<string, number>, sEntry: number, over: number[]): Candidate | null {
        const geo = carParkGeo({ id: -1, kind: 'carPark', variant: '', polygon: [], path: [], nodes: [], edges: [], faces: [], params });
        // Fastest launch: turn limited for side entries (then the chute), a straight run-up for back ones.
        const runUp = geo.side !== 0 ? geo.lc + geo.cf : geo.u1 + geo.rl;
        const vIn = geo.side !== 0 ? sqrt(CFG.turnGrip * 9.81 * (geo.turn + CFG.turnSlack)) : CFG.entrySpeed;
        const climb = geo.side !== 0 ? 0 : 2 * 9.81 * geo.H;
        const vMax = sqrt(Math.max(0, vIn * vIn - climb + 2 * CFG.launchAccel * runUp));
        const landMax = flightReach(vMax);
        const zone = landMax - lipBack + CFG.rollout;
        if (zone > clearRun) {
          return null;
        }
        params.landMax = landMax;
        params.landZone = zone;
        // Inside the block: every outline sample of the drive (its box and the ramp) in F, clear of F's
        // other building lines (the box's front and the ramp's foot stand on theirs).
        const nearFront = (p: Vec2) => toU(geo, p) - frontU(geo, toV(geo, p)) < CFG.clear + 0.5;
        const nearFoot = (p: Vec2) => (p.x - geo.rcx) * geo.fnx + (p.z - geo.rcz) * geo.fnz < CFG.clear + 0.5;
        for (const poly of [driveBox(geo), geo.ramp]) {
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const steps = Math.max(1, Math.ceil(unit(a, b).len / SAMPLE));
            for (let s = 0; s <= steps; s++) {
              const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps };
              if (!pointInPolygon(p.x, p.z, F.ring)) return null;
              if (!nearFront(p) && !nearFoot(p) && distToPolygonEdge(p.x, p.z, F.ring) < CFG.clear) return null;
              for (const ar of blocked) {
                if (ar.polygon.length >= 3 && pointInPolygon(p.x, p.z, ar.polygon)) return null;
                if (ar.kind !== 'subway') continue;
                if (distToPath(ar.path, p.x, p.z) < CITY.districts.subway.deckWidth / 2 + 3) return null;
              }
            }
          }
          // The block's outline and other areas never cut into it.
          for (const q of F.ring) if (pointInPolygon(q.x, q.z, poly) && distToPolygonEdge(q.x, q.z, poly) > 0.3) return null;
          for (const ar of blocked) for (const q of ar.polygon) if (pointInPolygon(q.x, q.z, poly)) return null;
        }
        // The flight: closures across C's side streets stay out of the corridor (car half width and a margin).
        const corridor = flightCorridor(geo, lipBack + 25, CAR_HALF + CFG.flightClear);
        for (const eid of C.edges) {
          if (eid === eIn || eid === eE) continue;
          const X = g.edges[eid];
          const d = unit(C, g.nodes[otherNode(X, C.id)]);
          const m = g.edges[eE].width / 2 + g.edges[eE].sidewalk + ROUTE.barrierSetbackSide - 1;
          const hw = X.width / 2 + X.sidewalk;
          for (let s = -1; s <= 1; s += 0.1) {
            const p = { x: C.x + d.x * m - d.z * hw * s, z: C.z + d.z * m + d.x * hw * s };
            if (pointInPolygon(p.x, p.z, corridor)) return null;
          }
        }
        // The footprint: the block, or what the drive needs of it; nothing else planned stands in it.
        const fp = footprintFor(F.ring, baseRing, geo);
        if (!fp) return null;
        for (let i = 0; i < fp.length; i++) {
          const a = fp[i];
          const b = fp[(i + 1) % fp.length];
          const steps = Math.max(1, Math.ceil(unit(a, b).len / SAMPLE));
          for (let k = 0; k <= steps; k++) {
            const p = { x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps };
            for (const ar of blocked) if (ar.polygon.length >= 3 && pointInPolygon(p.x, p.z, ar.polygon)) return null;
          }
        }
        for (const ar of blocked) for (const q of ar.polygon) if (pointInPolygon(q.x, q.z, fp)) return null;
        params.fpn = fp.length;
        fp.forEach((p, i) => {
          params[`fpx${i}`] = p.x;
          params[`fpz${i}`] = p.z;
        });
        // Route positions: the entry, C and the far end of the landing zone.
        let sC = cum[j];
        if (r.closed && sC < sEntry) sC += total;
        const sOut = sC + zone;
        if (!r.closed && (sEntry < lo || sOut > hi)) return null;
        if (r.closed && (startEdges.has(eE) || startEdges.has(eY))) return null;
        // The car park against the route, both from the entry to SCORE_LAND m down E.
        const skip = sC + SCORE_LAND - sEntry;
        let path = lipBack + SCORE_LAND;
        for (let i = 1; i < geo.path.length; i++) path += unit(geo.path[i - 1], geo.path[i]).len;
        if (path > skip * (1 - CFG.minSave)) return null;
        const edges = [...new Set([eY, ...over, eIn, ...C.edges, ...runEdges])];
        return { face: fi, edges, params, outline: fp, path: geo.path, footprint: Math.abs(polygonArea(fp)), score: skip - path };
      }
    }
  }
  return out;
}
