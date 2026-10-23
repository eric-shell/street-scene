/**
 * Parks: one or two whole blocks become open grass with rolling hills. The
 * block's frontage is opened (no walls: you can cut straight across), the
 * surface is 'grass' (offroad grip and drag), buildings are kept out and the
 * terrain gets a bumpy hill that is flat at the park edge. Trees are solid
 * trunks (look 'tree') kept away from the edge so the shortcut stays open;
 * one small wood packs them tighter, with bushes underneath. Clusters of
 * bushes (destructible, a car ploughs straight through) dot the grass, and
 * a footpath loop inside the edge has benches and bins (destructible too)
 * and lantern posts (destructible, lighting the park: render/street/areaLights.ts).
 *
 * Race passes (parkPasses, route.ts RoutePass): parks are planned after the
 * routes and go first on the blocks a route turns round; at each such corner
 * the racing line leaves the street before the corner, runs through the park
 * on a cobbled path bowed in toward the park's middle (between the trees: the
 * path is laid first and trees, bushes and furniture keep off it) and rejoins
 * the next street after it. The streets a pass uses are claimed so nothing
 * planned later stands in its way; the path's edges are reserved so street
 * furniture keeps off its way over the sidewalk. The graph is untouched: only
 * the racing line cuts the corner, a car may still go round by the street.
 *
 * Content to add (render/districts/park.ts): hedges, a pond or playground,
 * better trees.
 */
import { CITY, ROUTE } from '../config';
import { DEG, type Vec2, atan2, cos, distToSegment, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { RoadGraph } from '../roadGraph';
import type { RoutePass } from '../route';
import type { Area, DistrictModule, PlanContext } from './types';
import type { BlockFace } from '../blocks';
import type { PropKind } from '../props';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polygonArea, polygonBounds, polygonCentroid, smooth01, type Smooth, solidWalls } from './geom';
import { type PassClear, type PassCorner, type PlannedRoute, alongStreet, blockCorners, leaving, routeCorners, sharpestBend, streetEdges } from './passes';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

const CFG = CITY.districts.park;
const CLEAR: PassClear = { junction: CFG.passJunctionClear, mouth: CFG.passMouthClear, turn: CFG.passTurnClear };
/** A straight stretch of path the start grid needs (m): the rows behind the line and a little past it. */
const GRID_RUN = ROUTE.gridFirstRow + 4 * ROUTE.gridRowSpacing + 15;
/** The path may bend this much (rad) over the grid's stretch and still carry the grid. */
const GRID_BEND = 8 * DEG;

/**
 * Ring turns against the block's way round may add up to this much in a row (rad) and the block
 * still counts as convex: the few degrees a street bends at its bend nodes (roadGraph.ts), never
 * a roundabout's arc (many such steps one after the other).
 */
const CONVEX_SLACK = (12 * Math.PI) / 180;

/** True when every ring turn goes the same way (the block is convex), gentle bends excepted. Shared with the monument plaza. */
export function convexRing(ring: { x: number; z: number }[]): boolean {
  const n = ring.length;
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a2 += p.x * q.z - q.x * p.z;
  }
  const way = a2 > 0 ? 1 : -1;
  let against = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const c = ring[(i + 2) % n];
    const l1 = Math.hypot(b.x - a.x, b.z - a.z);
    const l2 = Math.hypot(c.x - b.x, c.z - b.z);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    const dot = (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z);
    const turn = Math.atan2(cr, dot);
    if (turn * way >= 0) {
      against = 0;
      continue;
    }
    against += Math.abs(turn);
    if (against > CONVEX_SLACK) return false;
  }
  return true;
}

/** The ring moved inward by d (m), for a convex ring in block order (block on the right of travel); null when it collapses. */
function insetRing(ring: { x: number; z: number }[], d: number): { x: number; z: number }[] | null {
  const n = ring.length;
  const lines = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = (q.z - p.z) / l;
    const nz = -(q.x - p.x) / l;
    return { x: p.x + nx * d, z: p.z + nz * d, dx: (q.x - p.x) / l, dz: (q.z - p.z) / l, l };
  });
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n];
    const b = lines[i];
    if (a.l < 1 || b.l < 1) continue;
    const den = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / den;
    out.push({ x: a.x + a.dx * t, z: a.z + a.dz * t });
  }
  if (out.length < 3) return null;
  // Collapsed or flipped (the inset passed the middle): every point must sit d inside the original.
  for (const p of out) if (!pointInPolygon(p.x, p.z, ring) || distToPolygonEdge(p.x, p.z, ring) < d - 0.5) return null;
  return out;
}

/** A pass picked for a corner: how far out it leaves and rejoins the street (m), its middle's pull and its sharpest bend (rad). */
interface PassPick extends PassCorner {
  a: number;
  b: number;
  pull: number;
  turn: number;
}

/** A park's race pass: the route's RoutePass plus where on it a start grid fits (route distance from its first point, m), when it does. */
export interface ParkPass extends RoutePass {
  start?: { s: number };
}

/**
 * The path round corner `k`: from the street point `a` m before the corner, a quadratic bow whose
 * middle lies `pull` of the way from the chord's midpoint to the park's middle, to the street point
 * `b` m after it; sampled every few metres. Null where the streets are too short.
 */
function pathLine(g: RoadGraph, ring: Vec2[], k: Pick<PassCorner, 'node' | 'eA' | 'eB'>, a: number, b: number, pull: number): Vec2[] | null {
  const A = alongStreet(g, k.node, k.eA, a);
  const B = alongStreet(g, k.node, k.eB, b);
  if (!A || !B) return null;
  const c = polygonCentroid(ring);
  const mx = (A.p.x + B.p.x) / 2;
  const mz = (A.p.z + B.p.z) / 2;
  // Control point of the quadratic through T at t = 0.5: P1 = 2T - (A + B) / 2.
  const tx = mx + (c.x - mx) * pull;
  const tz = mz + (c.z - mz) * pull;
  const px = 2 * tx - mx;
  const pz = 2 * tz - mz;
  const chord = sqrt((B.p.x - A.p.x) ** 2 + (B.p.z - A.p.z) ** 2);
  const n = Math.max(4, Math.ceil(chord / 5));
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w0 = (1 - t) * (1 - t);
    const w1 = 2 * (1 - t) * t;
    const w2 = t * t;
    pts.push({ x: w0 * A.p.x + w1 * px + w2 * B.p.x, z: w0 * A.p.z + w1 * pz + w2 * B.p.z });
  }
  return pts;
}

/**
 * A path's sharpest bend (rad), or null when it will not do: its samples on the park crowd the
 * edge, it leaves the park and comes back (it must cross the ring once in and once out: the first
 * and last samples are on the street and the sidewalk), it hardly touches the park at all, or it
 * bends past CFG.passMaxTurn.
 */
function pathTurn(g: RoadGraph, ring: Vec2[], k: Pick<PassCorner, 'node' | 'eA' | 'eB'>, pts: Vec2[]): number | null {
  const room = CFG.pathWidth / 2 + CFG.passMargin;
  const on = pts.map((p) => pointInPolygon(p.x, p.z, ring));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
  // Where the line crosses the ring (path distance, the crossing between two samples taken at their middle).
  const crossings: number[] = [];
  for (let i = 1; i < pts.length; i++) if (on[i] !== on[i - 1]) crossings.push((cum[i - 1] + cum[i]) / 2);
  if (crossings.length !== 2 || on.filter(Boolean).length < 3) return null;
  for (let i = 0; i < pts.length; i++) {
    if (!on[i]) continue;
    // Coming in at an angle the path is near the edge for a while: the room it must have grows
    // with its distance from the crossing (sin 45 degrees of it) up to the full margin.
    const from = Math.min(Math.abs(cum[i] - crossings[0]), Math.abs(cum[i] - crossings[1]));
    if (distToPolygonEdge(pts[i].x, pts[i].z, ring) < Math.min(room, from * CFG.passEntry)) return null;
  }
  const uA = leaving(g, k.node, k.eA);
  const worst = sharpestBend(pts, { x: -uA.x, z: -uA.z }, leaving(g, k.node, k.eB));
  return worst > CFG.passMaxTurn * DEG ? null : worst;
}

/** The best pass round corner `k`: the most pulled in toward the middle that fits, the gentlest at that pull, or null. */
function bestPass(g: RoadGraph, ring: Vec2[], k: PassCorner): PassPick | null {
  for (const pull of CFG.passPulls) {
    let best: PassPick | null = null;
    for (let a = CFG.passReach[0]; a <= Math.min(CFG.passReach[1], k.maxA); a += CFG.passStep) {
      for (let b = CFG.passReach[0]; b <= Math.min(CFG.passReach[1], k.maxB); b += CFG.passStep) {
        const pts = pathLine(g, ring, k, a, b, pull);
        const turn = pts && pathTurn(g, ring, k, pts);
        if (turn === null || turn === undefined) continue;
        // Gentlest first; between near equals, the longer way through the park.
        if (!best || turn - (a + b) * 0.001 < best.turn - (best.a + best.b) * 0.001) best = { ...k, a, b, pull, turn };
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * The passes block f can give the routes: one per route at most (two routes turning round the
 * same corner share it), and how many routes get one.
 */
function parkSite(g: RoadGraph, f: BlockFace, routes: readonly PlannedRoute[]): { passes: PassPick[]; served: number } {
  const passes: PassPick[] = [];
  let served = 0;
  for (const r of routes) {
    let pick: PassPick | null = null;
    for (const k of routeCorners(g, f, r, CLEAR)) {
      const shared = passes.find((p) => p.node === k.node);
      if (shared) {
        // Another route's pass round the same corner, if this route runs as far along both streets (either way round).
        const [ma, mb] = k.eA === shared.eA ? [k.maxA, k.maxB] : [k.maxB, k.maxA];
        if (shared.a <= ma && shared.b <= mb) pick = shared;
        break;
      }
      const p = bestPass(g, f.ring, k);
      if (p && (!pick || p.turn < pick.turn)) pick = p;
    }
    if (!pick) continue;
    served++;
    if (!passes.includes(pick)) passes.push(pick);
  }
  return { passes, served };
}

/**
 * Where a start grid fits on a path: the end (route distance from the path's first point, m) of the
 * straightest stretch GRID_RUN long that bends less than GRID_BEND, with the line a little inside the
 * stretch's end so the grid stands behind it; null when the path bends too much everywhere.
 */
function gridSpot(pts: Vec2[]): { s: number } | null {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
  const heading = (i: number) => atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
  let best: { s: number; bend: number } | null = null;
  // Stretches between the path's inner points only: the first and last segments are on the street.
  for (let i = 1; i + 1 < pts.length; i++) {
    let j = i;
    while (j + 2 < pts.length && cum[j + 1] - cum[i] < GRID_RUN) j++;
    if (cum[j + 1] - cum[i] < GRID_RUN || j + 2 >= pts.length) continue;
    let bend = 0;
    for (let q = i; q < j; q++) {
      let d = heading(q + 1) - heading(q);
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      bend += Math.abs(d);
    }
    if (bend < GRID_BEND && (!best || bend < best.bend)) best = { s: cum[i] + GRID_RUN - 5, bend };
  }
  return best && { s: best.s };
}

/** The race passes a park area carries (its params p<i>...), as the routes take them (route.ts RoutePass). */
export function parkPasses(g: RoadGraph, area: Area): ParkPass[] {
  const P = area.params;
  const out: ParkPass[] = [];
  for (let i = 0; i < (P.passes ?? 0); i++) {
    const k = { node: P[`p${i}node`], eA: P[`p${i}eA`], eB: P[`p${i}eB`] };
    const a = P[`p${i}a`];
    const b = P[`p${i}b`];
    const points = pathLine(g, area.polygon, k, a, b, P[`p${i}pull`]);
    if (!points) continue;
    const pass: ParkPass = { node: k.node, edgeA: k.eA, edgeB: k.eB, a, b, points, width: CFG.pathWidth };
    const start = gridSpot(points);
    if (start) pass.start = start;
    out.push(pass);
  }
  return out;
}

/** Blocks that can hold a park: unclaimed, sized for it, no bridge or shortcut on their ring, clear of the linear areas, convex. */
function parkFaces(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>): BlockFace[] {
  const g = ctx.graph;
  const others = ctx.areas.filter((a) => a.kind === 'river' || a.kind === 'subway' || a.kind === 'backAlley' || a.kind === 'alley');
  return ctx.faces().filter((f) => {
    if (f.outer || f.area < CFG.minArea || f.area > CFG.maxArea || ctx.claims.face.has(f.id)) return false;
    if (f.edges.some((e) => g.edges[e].shortcut || g.edges[e].bridge || ctx.claims.edge.has(e))) return false;
    // Clear of linear areas (river channel, subway deck, alleys).
    for (const a of others) {
      if (a.polygon.some((p) => pointInPolygon(p.x, p.z, f.ring))) return false;
      if (f.ring.some((p) => pointInPolygon(p.x, p.z, a.polygon))) return false;
    }
    return convexRing(f.ring);
  });
}

/**
 * The corners a park pass could turn round (route planning, before the parks exist): every junction
 * at a corner of a block that can hold a park, with the block's two sides there when they make a
 * real turn. A route turning between them may get a pass (events.ts).
 */
export function parkCorners(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>): { node: number; eA: number; eB: number }[] {
  return parkFaces(ctx).flatMap((f) => blockCorners(ctx.graph, f));
}

export const parkModule: DistrictModule = {
  kind: 'park',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(CFG.count[0], CFG.count[1]);
    const faces = parkFaces(ctx);
    rng.shuffle(faces);
    // The blocks the routes turn round first (the most routes first, stable among equals): their
    // parks carry the race across on a path. The rest fill up to the count in shuffled order.
    const routes = ctx.event?.routes ?? [];
    const sites = faces.map((f) => ({ f, ...parkSite(g, f, routes) }));
    sites.sort((p, q) => q.served - p.served);
    let made = 0;
    for (const { f, passes } of sites) {
      if (made >= count) break;
      if (ctx.budget.used + f.area > ctx.budget.total) continue;
      // Not right next to another park.
      if (ctx.areas.some((a) => a.kind === 'park' && a.polygon.some((p) => f.ring.some((q) => (p.x - q.x) ** 2 + (p.z - q.z) ** 2 < 60 * 60)))) continue;
      const params: Record<string, number> = { hill: CFG.hill * rng.range(0.6, 1), kx: rng.range(0.05, 0.09), kz: rng.range(0.05, 0.09), px: rng.range(0, 6.28), pz: rng.range(0, 6.28), seed: rng.int(0, 0x7fffffff), passes: passes.length };
      passes.forEach((p, i) => {
        params[`p${i}node`] = p.node;
        params[`p${i}eA`] = p.eA;
        params[`p${i}eB`] = p.eB;
        params[`p${i}a`] = p.a;
        params[`p${i}b`] = p.b;
        params[`p${i}pull`] = p.pull;
      });
      const area = ctx.addArea({ kind: 'park', variant: 'hills', polygon: f.ring, path: [], nodes: [], edges: [], faces: [f.id], params }, f.area);
      // The streets the passes leave and rejoin are held so nothing planned later (an overpass's piers, a
      // tunnel, a lane closure) stands in their way. Held in the claims only: the area's own edges stay empty.
      for (const p of passes) for (const e of [...streetEdges(g, p.node, p.eA, p.a + CFG.passMouthClear), ...streetEdges(g, p.node, p.eB, p.b + CFG.passMouthClear)]) ctx.claims.edge.set(e, area.id);
      made++;
    }
  },

  build(ctx, area) {
    const b = emptyBuild();
    const ring = area.polygon;
    const id = area.id;
    b.exclusions.push(ring);
    b.openings.push(ring);
    b.surfaces.push({ surface: 'grass', polygon: ring, priority: 2, area: id });
    // Race passes (parkPasses): the path's cobbles over the grass, a hint for the renderer, the
    // sidewalk crossing reserved against street furniture, and nothing of the park on the path.
    const passes = parkPasses(ctx.graph, area);
    const half = CFG.pathWidth / 2;
    const onPath = (x: number, z: number, r: number) =>
      passes.some((ps) => ps.points.some((q, i) => i + 1 < ps.points.length && distToSegment(x, z, q.x, q.z, ps.points[i + 1].x, ps.points[i + 1].z) < half + r + CFG.passVerge));
    for (const ps of passes) {
      b.hints.push({ kind: 'pass', points: ps.points, values: [ps.width] });
      for (let i = 0; i + 1 < ps.points.length; i++) {
        const q = ps.points[i];
        const r = ps.points[i + 1];
        const len = sqrt((r.x - q.x) ** 2 + (r.z - q.z) ** 2);
        if (len < 0.05) continue;
        const nx = ((r.z - q.z) / len) * half;
        const nz = (-(r.x - q.x) / len) * half;
        // A little long at both ends so the quads overlap at the joints.
        const ex = ((r.x - q.x) / len) * 0.3;
        const ez = ((r.z - q.z) / len) * 0.3;
        b.surfaces.push({ surface: 'cobble', polygon: [{ x: q.x - ex + nx, z: q.z - ez + nz }, { x: r.x + ex + nx, z: r.z + ez + nz }, { x: r.x + ex - nx, z: r.z + ez - nz }, { x: q.x - ex - nx, z: q.z - ez - nz }], priority: 3, area: id });
        const n = Math.max(1, Math.ceil(len / 3));
        for (let k = 0; k <= n; k++) b.reserved.push({ x: q.x + ((r.x - q.x) * k) / n, z: q.z + ((r.z - q.z) * k) / n, r: half });
      }
    }
    // Hill: H * bump(x, z) * prod_i smooth(0, edge, inside distance to side i).
    const { hill, kx, kz, px, pz } = area.params;
    const sides = ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      // The block is on the right of travel: inward normal (dz, -dx).
      return { x: p.x, z: p.z, nx: (q.z - p.z) / l, nz: -(q.x - p.x) / l, len: l };
    });
    const bb = polygonBounds(ring);
    b.heightMods.push({
      ...bb,
      add(x, z, out) {
        let P = 1;
        let sx = 0;
        let sz = 0;
        for (const s of sides) {
          if (s.len < 0.5) continue;
          const d = (x - s.x) * s.nx + (z - s.z) * s.nz;
          const m = smooth01(0, CFG.hillEdge, d, SMOOTH);
          if (m.v <= 0) return;
          P *= m.v;
          sx += (m.d / m.v) * s.nx;
          sz += (m.d / m.v) * s.nz;
        }
        const bump = 0.55 + 0.45 * sin(x * kx + px) * cos(z * kz + pz);
        const dbx = 0.45 * kx * cos(x * kx + px) * cos(z * kz + pz);
        const dbz = -0.45 * kz * sin(x * kx + px) * sin(z * kz + pz);
        out.h += hill * P * bump;
        out.gx += hill * (P * sx * bump + P * dbx);
        out.gz += hill * (P * sz * bump + P * dbz);
      },
    });
    // Trees on a jittered grid, clear of the edge; one small wood packs them tighter.
    const rng = new Rng(area.params.seed);
    const rnd = () => rng.next();
    const trees: { x: number; z: number }[] = [];
    const addTree = (tx: number, tz: number) => {
      trees.push({ x: tx, z: tz });
      b.walls.push(...solidWalls(circlePolygon(tx, tz, CFG.treeRadius, 6), 'tree', id));
      b.props.push({ kind: 'tree', x: tx, z: tz, yaw: rnd() * 6.28, size: 2.2 + rnd() * 1.6, height: 5 + rnd() * 4, area: id });
    };
    // The wood: a random spot at least its radius inside the edge (none in a park too small for it).
    let grove: { x: number; z: number; r: number } | null = null;
    const gr = CFG.groveRadius[0] + rnd() * (CFG.groveRadius[1] - CFG.groveRadius[0]);
    for (let k = 0; k < 24 && !grove; k++) {
      const gx = bb.minX + rnd() * (bb.maxX - bb.minX);
      const gz = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
      if (pointInPolygon(gx, gz, ring) && distToPolygonEdge(gx, gz, ring) > gr + 6) grove = { x: gx, z: gz, r: gr };
    }
    const inGrove = (x: number, z: number) => !!grove && (x - grove.x) ** 2 + (z - grove.z) ** 2 < grove.r * grove.r;
    const step = CFG.treeSpacing;
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
      for (let z = bb.minZ + step / 2; z < bb.maxZ; z += step) {
        if (rnd() < 0.35) continue;
        const tx = x + (rnd() - 0.5) * step * 0.7;
        const tz = z + (rnd() - 0.5) * step * 0.7;
        if (!pointInPolygon(tx, tz, ring) || distToPolygonEdge(tx, tz, ring) < 9 || inGrove(tx, tz) || onPath(tx, tz, CFG.treeRadius)) continue;
        addTree(tx, tz);
      }
    }
    const clutter = (kind: PropKind, x: number, z: number, yaw: number) => b.destructibles.push({ kind, x, z, yaw, lift: 0, area: id });
    /** Clear of tree trunks, of the park edge and of the race passes' path. */
    const open = (x: number, z: number, r: number, edge: number) =>
      pointInPolygon(x, z, ring) && distToPolygonEdge(x, z, ring) > edge && !onPath(x, z, r) && trees.every((t) => (t.x - x) ** 2 + (t.z - z) ** 2 > (CFG.treeRadius + r + 0.6) ** 2);
    if (grove) {
      const gs = CFG.groveSpacing;
      for (let x = grove.x - grove.r; x < grove.x + grove.r; x += gs) {
        for (let z = grove.z - grove.r; z < grove.z + grove.r; z += gs) {
          if (rnd() < 0.2) continue;
          const tx = x + (rnd() - 0.5) * gs * 0.8;
          const tz = z + (rnd() - 0.5) * gs * 0.8;
          if (inGrove(tx, tz) && open(tx, tz, CFG.treeRadius, 9)) addTree(tx, tz);
        }
      }
      // Undergrowth.
      for (let k = 0; k < grove.r * 1.6; k++) {
        const a = rnd() * 6.28;
        const d = Math.sqrt(rnd()) * grove.r;
        const x = grove.x + Math.cos(a) * d;
        const z = grove.z + Math.sin(a) * d;
        if (open(x, z, 0.75, 4)) clutter('bush', x, z, rnd() * 6.28);
      }
    }
    // Bush clusters on the open grass; a park whose path took too many spots tries a few more.
    const clusters = Math.round(polygonArea(ring) / CFG.bushClusterArea);
    let bushes = b.destructibles.filter((d) => d.kind === 'bush').length;
    const cluster = () => {
      const cx = bb.minX + rnd() * (bb.maxX - bb.minX);
      const cz = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
      if (!pointInPolygon(cx, cz, ring) || inGrove(cx, cz)) return;
      const n = 2 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const x = cx + (rnd() - 0.5) * 5;
        const z = cz + (rnd() - 0.5) * 5;
        if (!open(x, z, 0.75, 2.5)) continue;
        clutter('bush', x, z, rnd() * 6.28);
        bushes++;
      }
    };
    for (let c = 0; c < clusters; c++) cluster();
    for (let extra = 0; passes.length && bushes < CFG.minBushes && extra < 24; extra++) cluster();
    // Footpath loop with benches facing in and a bin beside some of them.
    const path = insetRing(ring, CFG.pathInset);
    if (path) {
      b.hints.push({ kind: 'path', points: path, values: [] });
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const q = path[(i + 1) % path.length];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        if (len < 8) continue;
        const ux = (q.x - p.x) / len;
        const uz = (q.z - p.z) / len;
        // Inward: right of travel along the ring (the block is on the right).
        const nx = uz;
        const nz = -ux;
        for (let s = CFG.benchSpacing * (0.3 + 0.4 * rnd()); s < len - 4; s += CFG.benchSpacing) {
          const x = p.x + ux * s + nx * 1.8;
          const z = p.z + uz * s + nz * 1.8;
          if (!open(x, z, 0.9, 3)) continue;
          // Benches face the path (local +Z toward it, i.e. away from the park middle).
          clutter('bench', x, z, Math.atan2(-nx, -nz));
          if (rnd() < 0.5) {
            const cx = x + ux * 1.6;
            const cz = z + uz * 1.6;
            if (open(cx, cz, 0.4, 3)) clutter('garbageCan', cx, cz, 0);
          }
        }
      }
      // Lantern posts just off the path's outer side (benches sit on the inner one): one at every
      // corner, the rest spread evenly along each side. No rng draws, so the lamps never shift the
      // benches and bins.
      const off = 1.7;
      for (let i = 0; i < path.length; i++) {
        const o = path[(i - 1 + path.length) % path.length];
        const p = path[i];
        const q = path[(i + 1) % path.length];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        const lenIn = Math.hypot(p.x - o.x, p.z - o.z);
        if (len < 1 || lenIn < 1) continue;
        const ux = (q.x - p.x) / len;
        const uz = (q.z - p.z) / len;
        // Outward (toward the street): left of travel.
        const ox = -uz;
        const oz = ux;
        const n = Math.max(1, Math.round(len / CFG.lampSpacing));
        for (let k = 0; k < n; k++) {
          let x = p.x + ux * (len * k) / n + ox * off;
          let z = p.z + uz * (len * k) / n + oz * off;
          if (k === 0) {
            // The corner: off the path on the bisector of both sides' outward normals.
            const bx = ox - (p.z - o.z) / lenIn;
            const bz = oz + (p.x - o.x) / lenIn;
            const bl = Math.hypot(bx, bz);
            if (bl > 1e-6) {
              const k2 = off / Math.max(0.5, (bx * ox + bz * oz) / bl);
              x = p.x + (bx / bl) * k2;
              z = p.z + (bz / bl) * k2;
            }
          }
          if (open(x, z, 0.4, 2)) clutter('parkLamp', x, z, Math.atan2(-ox, -oz));
        }
      }
    }
    return b;
  },
};
