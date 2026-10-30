/**
 * Hills: sections of the city with real elevation. One or two clusters of
 * two to four adjacent blocks are lifted on a smooth dome or ridge (a basin
 * now and then) 10-16 m high with a flat top, so the streets up its flanks
 * climb at grades up to about 11%, crest where they reach the plateau and
 * drop away again: downhill braking, crests to get light over at speed, and
 * side streets running along the slope with a camber. The blocks keep their
 * buildings (they are downtown blocks on a hill; the architecture planner
 * puts its San Francisco styles up here), and sidewalks, props, rails and
 * the El all follow the terrain already.
 *
 * Profile: the plateau is a rounded rectangle aligned with the cluster's
 * longest street side (a long thin one for a ridge); the height falls off
 * with a smoothstep of the distance to that rectangle over a slope width
 * derived from the height and the grade cap (a smoothstep is steepest at
 * 1.5 / width), so the modifier is C1 everywhere and exactly 0 at its
 * bounding box. Slopes keep clear of the channel (its floor must stay
 * flat), the El (trains cannot climb), roundabouts (their islands are built
 * level), the monument plaza and each other; they may run on past the city
 * edge. The area polygon covers the plateau and most of the slope, so
 * areaAt and the minimap report the whole rise, not just the claimed blocks.
 *
 * Hill Climb events (src/city/events.ts): the routes are picked before the
 * hills exist, so the hills come to them. Blocks the routes run along are
 * tried first (most frontage on a route still without a hill first, so both
 * routes get one), the most hills asked for, clusters grow across route
 * streets so a route runs up onto the plateau rather than past a corner,
 * a cluster that does not fit is tried again as its route block alone
 * (a smaller plateau whose slopes reach less far), and each starts from the
 * tallest height before lowering to fit.
 *
 * San Francisco (variant 'terraced', CFG.terraced): on a few seeds, one of
 * the hills is a stepped pyramid instead, centred on a summit junction. The
 * junction stands on a level table at the top; the four streets out of it
 * drop a step to the ring of junctions one block out, which stand level on
 * a terrace of their own, the streets along it level too; the streets on out
 * drop another step to the ring two blocks out, back at the ground. Every
 * junction sits on a table and every street between climbs on a ramp eased
 * at both ends, steeper than a plain hill (12-15%): a fast car leaves the
 * ground cresting onto each table, the San Francisco chase. The contours are
 * a rounded square (a p-norm, C1 with an exact gradient) so the rings'
 * corner junctions are level too. Planned first, from its own stream so a
 * seed without one keeps its hills; the other hills keep off it, and so does
 * everything that keeps off a slope (it presents itself to them as a disc
 * holding all of it: plateauDistance with no plateau). Never on the route's
 * start, and on a route where it fits: the jumps are the point.
 */
import { CITY } from '../config';
import type { BlockFace } from '../blocks';
import { type WarpTerm, warpTerms } from '../roadGraph';
import { Vec2, atan2, cos, pow, sin, sqrt } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Area, DistrictModule, HeightSample, PlanContext } from './types';
import { emptyBuild } from './types';
import { pointInPolygon, polygonCentroid, smooth01, type Smooth } from './geom';
import { rampAlong, rampPoint, rampsOf, channelCenter } from './channel';
import { bluffFootprint } from './bluff';
import { quayGuard } from './harborShore';

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const SMOOTH: Smooth = { v: 0, d: 0 };

const CFG = CITY.districts.hills;
const TER = CFG.terraced;

/** A hill's plateau rectangle (local frame: u along, v across) and its profile. */
export interface HillShape {
  cx: number;
  cz: number;
  /** Unit axis along the plateau. */
  ux: number;
  uz: number;
  /** Plateau half extents along u and v (m). */
  a: number;
  b: number;
  /** Summit height (m, negative for a basin) and slope width (m). */
  h: number;
  w: number;
  /** A terraced hill's steps (the plateau is then its summit junction alone, distances are its rounded square's, and w its reach). */
  terrace?: Terrace;
}

/**
 * A terraced hill's steps (CFG.terraced): `tiers` drops of `step` m, one a block out from the summit. They
 * are laid out on the city's grid before its warp (roadGraph.ts warpField: the streets were laid on a
 * square grid of the plan's spacing and then bent by it), where the rings of junctions really are square: a
 * point is taken back there (unwarp), measured from the summit, and its gradient carried forward through
 * the warp's Jacobian.
 */
export interface Terrace {
  tiers: number;
  step: number;
  /** Level table either side of each ring of junctions (m), and the vertical curve at each end of a ramp (m). */
  flat: number;
  ease: number;
  /** Exponent of the rounded square the contours follow (a power of two). */
  p: number;
  /** The city plan's grid spacing (m): a ring of junctions every L out from the summit. */
  L: number;
  /** The summit on the unwarped grid (m), and the seed's warp. */
  X: number;
  Z: number;
  warp: WarpTerm[];
}

/** How far out a terraced hill reaches (rounded square distance on the unwarped grid, m): its last ramp's foot. */
export const terraceReach = (t: { tiers: number; flat: number; L: number }): number => t.tiers * t.L - t.flat;

/** Scratch for unwarp: the point on the unwarped grid and the warp's two cross derivatives there. */
const UNWARP = { X: 0, Z: 0, a: 0, b: 0 };

/**
 * World (x, z) back to the unwarped grid: the warp moves x by waves of z and z by waves of x, bending by
 * at most about a quarter (CITY.warp), so each step of a fixed point iteration cuts the error to a
 * quarter: ten take its 40 m down to a twentieth of a millimetre. Leaves
 * a = dx/dZ and b = dz/dX there (the warp's Jacobian is [[1, a], [b, 1]]).
 */
function unwarp(terms: readonly WarpTerm[], x: number, z: number): typeof UNWARP {
  let X = x;
  let Z = z;
  for (let i = 0; i < 10; i++) {
    let dx = 0;
    let dz = 0;
    for (const t of terms) {
      dx += t.amp * sin(Z * t.k + t.px);
      dz += t.amp * sin(X * t.k + t.pz);
    }
    X = x - dx;
    Z = z - dz;
  }
  let a = 0;
  let b = 0;
  for (const t of terms) {
    a += t.amp * t.k * cos(Z * t.k + t.px);
    b += t.amp * t.k * cos(X * t.k + t.pz);
  }
  UNWARP.X = X;
  UNWARP.Z = Z;
  UNWARP.a = a;
  UNWARP.b = b;
  return UNWARP;
}

/** q^p for p a power of two, by squaring (q >= 0). */
function powP(q: number, p: number): number {
  for (let k = 1; k < p; k *= 2) q *= q;
  return q;
}

/** Rounded square distance on the unwarped grid from the summit, from offsets (m). */
function roundedSquare(t: Terrace, du: number, dv: number): number {
  const m = Math.max(Math.abs(du), Math.abs(dv));
  if (m < 1e-9) return 0;
  const s = powP(Math.abs(du) / m, t.p) + powP(Math.abs(dv) / m, t.p);
  return m * pow(s, 1 / t.p);
}

/**
 * Drop below a terraced hill's summit at rounded square distance d (m), and its derivative: level on the
 * summit's table and every ring's, a ramp between eased over t.ease at both ends (constant grade between).
 */
function terraceDrop(t: Terrace, d: number, out: Smooth): void {
  const L = t.L;
  const R = L - 2 * t.flat;
  const e = t.ease;
  const G = t.step / (R - e);
  const k = Math.floor((d + t.flat) / L);
  out.d = 0;
  if (k >= t.tiers) {
    out.v = t.tiers * t.step;
    return;
  }
  const r = d - (k * L + t.flat);
  out.v = k * t.step;
  if (r <= 0) return;
  if (r >= R) {
    out.v += t.step;
  } else if (r < e) {
    out.v += (G * r * r) / (2 * e);
    out.d = (G * r) / e;
  } else if (r <= R - e) {
    out.v += (G * e) / 2 + G * (r - e);
    out.d = G;
  } else {
    out.v += t.step - (G * (R - r) * (R - r)) / (2 * e);
    out.d = (G * (R - r)) / e;
  }
}

/** Height and exact gradient of a terraced hill at (x, z). */
function terraceAt(s: HillShape, t: Terrace, x: number, z: number, out: HeightSample): void {
  // Queried per wheel per substep over a wide box: one step of the inversion (within the warp's bend times
  // its reach of the truth, CITY.warp) settles most points outside before the full one runs.
  let dx = 0;
  let dz = 0;
  for (const k of t.warp) {
    dx += k.amp * sin(z * k.k + k.px);
    dz += k.amp * sin(x * k.k + k.pz);
  }
  const far = terraceReach(t) + 12;
  if (Math.abs(x - dx - t.X) >= far || Math.abs(z - dz - t.Z) >= far) return;
  const w = unwarp(t.warp, x, z);
  const du = w.X - t.X;
  const dv = w.Z - t.Z;
  const reach = terraceReach(t);
  if (Math.abs(du) >= reach || Math.abs(dv) >= reach) return;
  const d = roundedSquare(t, du, dv);
  if (d >= reach) return;
  terraceDrop(t, d, SMOOTH);
  out.h += s.h - SMOOTH.v;
  if (SMOOTH.d === 0 || d < 1e-9) return;
  // On the unwarped grid: d(d)/d(du) = sign(du) (|du| / d)^(p - 1), the same along v; then through the
  // inverse of the warp's Jacobian, transposed.
  const hX = -SMOOTH.d * (du < 0 ? -1 : 1) * pow(Math.abs(du) / d, t.p - 1);
  const hZ = -SMOOTH.d * (dv < 0 ? -1 : 1) * pow(Math.abs(dv) / d, t.p - 1);
  const det = 1 - w.a * w.b;
  out.gx += (hX - w.b * hZ) / det;
  out.gz += (hZ - w.a * hX) / det;
}

/** A terraced hill's outline: its rounded square contour `dist` m out from the summit, bent by the warp. */
function terraceOutline(t: Terrace, dist: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < 64; i++) {
    const ang = (i / 64) * 2 * Math.PI;
    const c = cos(ang);
    const sn = sin(ang);
    const r = dist / roundedSquare(t, c, sn);
    const X = t.X + c * r;
    const Z = t.Z + sn * r;
    let dx = 0;
    let dz = 0;
    for (const w of t.warp) {
      dx += w.amp * sin(Z * w.k + w.px);
      dz += w.amp * sin(X * w.k + w.pz);
    }
    pts.push({ x: X + dx, z: Z + dz });
  }
  return pts;
}

/**
 * Distance from (x, z) to the plateau rectangle (0 inside, with `inner` the distance to its edge), plus local
 * coordinates; for a terraced hill, its rounded square distance from the summit, so `d < w` is on its slopes
 * for every keep-out alike.
 */
export function plateauDistance(s: HillShape, x: number, z: number): { d: number; inner: number; pu: number; pv: number; dx: number; dz: number } {
  const rx = x - s.cx;
  const rz = z - s.cz;
  const pu = rx * s.ux + rz * s.uz;
  const pv = -rx * s.uz + rz * s.ux;
  if (s.terrace) {
    const t = s.terrace;
    const w = unwarp(t.warp, x, z);
    const du = w.X - t.X;
    const dv = w.Z - t.Z;
    const d = roundedSquare(t, du, dv);
    return { d, inner: -d, pu: du, pv: dv, dx: Math.abs(du), dz: Math.abs(dv) };
  }
  const dx = Math.max(0, Math.abs(pu) - s.a);
  const dz = Math.max(0, Math.abs(pv) - s.b);
  return { d: sqrt(dx * dx + dz * dz), inner: Math.min(s.a - Math.abs(pu), s.b - Math.abs(pv)), pu, pv, dx, dz };
}

/** Height and exact gradient of the hill at (x, z). */
export function hillAt(s: HillShape, x: number, z: number, out: HeightSample): void {
  if (s.terrace) return terraceAt(s, s.terrace, x, z, out);
  const q = plateauDistance(s, x, z);
  if (q.d >= s.w) return;
  const m = smooth01(0, s.w, q.d, SMOOTH);
  out.h += s.h * (1 - m.v);
  if (q.d <= 0 || m.d === 0) return;
  // d(h)/d(d) along the direction the rectangle distance grows in (local), rotated to world.
  const k = -s.h * m.d;
  const lu = (q.pu < 0 ? -1 : 1) * (q.dx / q.d);
  const lv = (q.pv < 0 ? -1 : 1) * (q.dz / q.d);
  out.gx += k * (lu * s.ux - lv * s.uz);
  out.gz += k * (lu * s.uz + lv * s.ux);
}

/** Rounded rectangle `dist` m outside the plateau, as a polygon. */
export function hillOutline(s: HillShape, dist: number): Vec2[] {
  const pts: Vec2[] = [];
  const corner = (su: number, sv: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const ang = a0 + (i / 6) * (Math.PI / 2);
      const lu = su * s.a + cos(ang) * dist;
      const lv = sv * s.b + sin(ang) * dist;
      pts.push({ x: s.cx + lu * s.ux - lv * s.uz, z: s.cz + lu * s.uz + lv * s.ux });
    }
  };
  corner(1, 1, 0);
  corner(-1, 1, Math.PI / 2);
  corner(-1, -1, Math.PI);
  corner(1, -1, 1.5 * Math.PI);
  return pts;
}

/** The frame a hill on `blocks` takes: along `seed`'s longest street side, centred on the blocks, with their half extents (m) and total area (m2). */
function blockFrame(blocks: readonly BlockFace[], seed: BlockFace): { u: Vec2; cx: number; cz: number; eu: number; ev: number; total: number } {
  const u = longestSide(seed);
  let cx = 0;
  let cz = 0;
  let total = 0;
  for (const f of blocks) {
    const c = polygonCentroid(f.ring);
    cx += c.x * f.area;
    cz += c.z * f.area;
    total += f.area;
  }
  cx /= total;
  cz /= total;
  let eu = 0;
  let ev = 0;
  for (const f of blocks) {
    for (const p of f.ring) {
      eu = Math.max(eu, Math.abs((p.x - cx) * u.x + (p.z - cz) * u.z));
      ev = Math.max(ev, Math.abs(-(p.x - cx) * u.z + (p.z - cz) * u.x));
    }
  }
  return { u, cx, cz, eu, ev, total };
}

/**
 * Streets a Hill Climb's route can run along for a hill: every edge of a free block where the lowest, plainest hill
 * (a dome at the minimum height on that block alone, the planner's own fallback) clears everything built level.
 * The route finders (events.ts) ask before any hill exists, so the routes choose streets the hills can come to.
 */
export function hillSiteEdges(ctx: Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>): Set<number> {
  const g = ctx.graph;
  const fits = hillFitter(ctx);
  const out = new Set<number>();
  for (const f of ctx.faces()) {
    if (f.outer || ctx.claims.face.has(f.id) || f.edges.some((e) => g.edges[e].bridge) || f.corners.some((c) => g.nodes[c.node].ring)) continue;
    const { u, cx, cz, eu, ev } = blockFrame([f], f);
    const h = CFG.height[0];
    const s: HillShape = { cx, cz, ux: u.x, uz: u.z, a: Math.max(25, eu - CFG.inset), b: Math.max(25, ev - CFG.inset), h, w: (1.5 * h) / CFG.maxGrade };
    if (fits(s, [])) for (const e of f.edges) out.add(e);
  }
  return out;
}

/** Unit direction of the longest ring side that runs along a street. */
function longestSide(f: BlockFace): Vec2 {
  let best = 0;
  let dir: Vec2 = { x: 1, z: 0 };
  for (let i = 0; i < f.ring.length; i++) {
    if (f.segEdge[i] < 0) continue;
    const p = f.ring[i];
    const q = f.ring[(i + 1) % f.ring.length];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (l > best) {
      best = l;
      dir = { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
    }
  }
  return dir;
}

function samplePath(path: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i];
    const q = path[i + 1];
    const n = Math.max(1, Math.ceil(sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) / step));
    for (let k = 0; k < n; k++) out.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
  }
  if (path.length) out.push(path[path.length - 1]);
  return out;
}

export function shapeOf(area: Area): HillShape {
  const p = area.params;
  const s: HillShape = { cx: p.cx, cz: p.cz, ux: p.ux, uz: p.uz, a: p.a, b: p.b, h: p.h, w: p.w };
  if (area.variant === 'terraced') s.terrace = { tiers: p.tiers, step: p.step, flat: p.flat, ease: p.ease, p: p.p, L: p.L, X: p.X, Z: p.Z, warp: warpTerms(p.seed) };
  return s;
}


/**
 * Whether a hill's slopes keep clear of everything built level on this plan (channel, El, highway, bluff, roundabouts,
 * monument, car parks, lakes, alley jump runs) and of the hills already `made` (grades would add up). Shared by the
 * planner and by the Hill Climb route preference (events.ts), so the routes favour streets a hill can really stand on.
 */
export function hillFitter(ctx: Pick<PlanContext, 'graph' | 'areas' | 'event'>): (s: HillShape, made: readonly HillShape[]) => boolean {
  const g = ctx.graph;
  const channels = ctx.areas.filter((a) => a.kind === 'channel');
  const subways = ctx.areas.filter((a) => a.kind === 'subway').map((a) => samplePath(a.path, 10));
  // The elevated highway: its deck holds a smoothed level over the ground and its ramps climb a fixed
  // height to it, so no slope under either (districts/highway/); outlines sampled, the deck's line too.
  const highways = ctx.areas.filter((a) => a.kind === 'highway' && a.polygon.length >= 3).map((a) => samplePath([...a.polygon, a.polygon[0]], 10));
  const monuments = ctx.areas.filter((a) => a.kind === 'monument');
  // A bluff (bluff.ts) shapes its own ground: slopes keep off its outline and out of it.
  const bluffs = ctx.areas
    .filter((a) => a.kind === 'bluff')
    .map((a) => {
      const poly = bluffFootprint(a);
      return { poly, rim: samplePath([...poly, poly[0]], 10) };
    });
  const carParks = ctx.areas.filter((a) => a.kind === 'carPark');
  // The Underground's trench (underground.ts) is dug to a set profile: no slope under its blocks.
  const trenches = ctx.areas.filter((a) => a.kind === 'underground' && a.polygon.length >= 3).map((a) => ({ poly: a.polygon, rim: samplePath([...a.polygon, a.polygon[0]], 10) }));
  // A lake (lake.ts) stands level whatever the ground does: slopes keep off its block, promenade and all.
  const lakes = ctx.areas.filter((a) => a.kind === 'lake').map((a) => samplePath([...a.polygon, a.polygon[0]], 10));
  // A back alley's jump exit (alleyShortcuts.ts) is sized for level ground (its run-up speed and flight
  // reach): its last leg and the landing past its mouth keep off the slopes, or a terrace's ramp under the
  // run-up stalls the car short of the lip.
  const jumpRuns = ctx.areas
    .filter((a) => a.kind === 'backAlley' && a.params.jumpExit && a.path.length >= 2)
    .map((a) => {
      const P = a.path[a.path.length - 2];
      const B = a.path[a.path.length - 1];
      const len = sqrt((B.x - P.x) ** 2 + (B.z - P.z) ** 2) || 1;
      const reach = a.params.landMax ?? 0;
      return samplePath([P, { x: B.x + ((B.x - P.x) / len) * reach, z: B.z + ((B.z - P.z) / len) * reach }], 6);
    });
  // The channel's ramps climb a set profile out to a level lip at the street: a slope under one tilts the
  // lip and the climb (sampled from the foot to past the top; the channel check covers only the bank).
  const ramps = channels.flatMap((r) => rampsOf(r).map((m) => samplePath([rampPoint(m, 0, 0), rampPoint(m, rampAlong(r.params, m, m.topL) + 6, 0)], 6)));
  const rings = g.nodes.filter((n) => n.ring);
  // A Harbor Run's routes were picked for the quay that is planned after the hills (harborShore.ts): a slope
  // over its frontage would take the stretch from it (waterfront.ts), so the slopes keep off the frontage too.
  const quay = ctx.event?.harbor ? [quayGuard(ctx.event.harbor)] : [];

  return (s, made) => {
    const reach = s.w + CFG.clearance;
    for (const r of channels) {
      for (let x = r.params.x0; x <= r.params.x1; x += 12) if (plateauDistance(s, x, channelCenter(r.params, x)).d < reach + r.params.top) return false;
    }
    for (const path of ramps) for (const p of path) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    for (const path of subways) for (const p of path) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    for (const path of highways) for (const p of path) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    for (const bl of bluffs) {
      if (pointInPolygon(s.cx, s.cz, bl.poly)) return false;
      for (const p of bl.rim) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    }
    for (const n of rings) {
      const q = plateauDistance(s, n.x, n.z);
      const R = n.ring!.outer + CITY.sidewalk;
      if (q.d > 0 ? q.d < reach + R : q.inner < R + CFG.clearance) return false;
    }
    for (const m of monuments) {
      const q = plateauDistance(s, m.params.cx, m.params.cz);
      if (q.d > 0 ? q.d < reach + 30 : q.inner < 40) return false;
    }
    // A car park's ramp climbs a fixed height to a roof at a fixed height over the ground: no slope under it.
    for (const c of carParks) for (const p of c.polygon) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    for (const t of trenches) {
      if (pointInPolygon(s.cx, s.cz, t.poly)) return false;
      for (const p of t.rim) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    }
    for (const rim of lakes) for (const p of rim) if (plateauDistance(s, p.x, p.z).d < s.w + CITY.districts.lake.clearance) return false;
    for (const path of jumpRuns) for (const p of path) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    for (const path of quay) for (const p of path) if (plateauDistance(s, p.x, p.z).d < reach) return false;
    for (const o of made) {
      const apart = (1 - CFG.overlap) * (s.w + o.w);
      for (const p of hillOutline(o, 0)) if (plateauDistance(s, p.x, p.z).d < apart) return false;
      for (const p of hillOutline(s, 0)) if (plateauDistance(o, p.x, p.z).d < apart) return false;
    }
    return true;
  };
}

export const hillsModule: DistrictModule = {
  kind: 'hills',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const drawn = rng.int(CFG.count[0], CFG.count[1]);
    // A Hill Climb asks for the most hills (see the header).
    const count = ctx.event?.flavour === 'hillClimb' ? CFG.count[1] : drawn;
    const faces = ctx.faces();
    const byEdge = new Map<number, number[]>();
    for (const f of faces) {
      if (f.outer) continue;
      for (const e of f.edges) {
        let list = byEdge.get(e);
        if (!list) byEdge.set(e, (list = []));
        list.push(f.id);
      }
    }
    const taken = new Set<number>();
    const eligible = (f: BlockFace) => !f.outer && !ctx.claims.face.has(f.id) && !taken.has(f.id) && f.edges.every((e) => !g.edges[e].bridge) && f.corners.every((c) => !g.nodes[c.node].ring);
    const made: HillShape[] = [];
    const fitsMade = hillFitter(ctx);
    const fits = (s: HillShape): boolean => fitsMade(s, made);

    // San Francisco now and then (see the header), first, so the others keep off it.
    const terraced = planTerraced(ctx, faces, eligible, fits);
    if (terraced) {
      for (const f of terraced.faces) taken.add(f);
      made.push(shapeOf(terraced));
    }

    const order = faces.filter(eligible).map((f) => f.id);
    rng.shuffle(order);
    // Hill Climb: each block's frontage on each route (m). The next block tried is the one with the
    // most frontage on routes that have no hill yet (then on any route), so both routes get one.
    const routes = ctx.event?.flavour === 'hillClimb' ? ctx.event.routes.map((r) => new Set(r.edges)) : null;
    const routeEdges = routes ? new Set(routes.flatMap((r) => [...r])) : null;
    const front = new Map<number, number[]>();
    if (routes) for (const id of order) front.set(id, routes.map((r) => faces[id].edges.reduce((m, e) => m + (r.has(e) ? g.edges[e].length : 0), 0)));
    const served = routes ? routes.map(() => false) : [];
    const want = (id: number) => front.get(id)!.reduce((k, m, r) => k + m * (served[r] ? 1 : 1000), 0);
    for (let oi = 0; oi < order.length; oi++) {
      if (routes) {
        let bi = oi;
        for (let j = oi + 1; j < order.length; j++) if (want(order[j]) > want(order[bi])) bi = j;
        [order[oi], order[bi]] = [order[bi], order[oi]];
      }
      const seedId = order[oi];
      if (made.length >= count) break;
      const seed = faces[seedId];
      if (!eligible(seed)) continue;
      // Grow a cluster of adjacent blocks from the seed.
      const target = rng.int(CFG.blocks[0], CFG.blocks[1]);
      const cluster = [seed];
      const inCluster = new Set([seed.id]);
      while (cluster.length < target) {
        const nb: BlockFace[] = [];
        for (const f of cluster) {
          for (const e of f.edges) {
            for (const id of byEdge.get(e) ?? []) {
              const n = faces[id];
              if (!inCluster.has(id) && eligible(n) && !nb.includes(n)) nb.push(n);
            }
          }
        }
        if (!nb.length) break;
        // Hill Climb grows across route streets first: the route then climbs onto the plateau.
        const k = rng.int(0, nb.length - 1);
        const across = routeEdges ? nb.filter((n) => n.edges.some((e) => routeEdges.has(e) && cluster.some((f) => f.edges.includes(e)))) : [];
        const pick = across.length ? across[k % across.length] : nb[k];
        cluster.push(pick);
        inCluster.add(pick.id);
      }
      if (cluster.length < CFG.blocks[0]) continue;
      // A Hill Climb hill that does not fit as a cluster is tried again on its route block alone (a
      // smaller plateau whose slopes reach less far): every route gets its climb.
      for (const blocks of routeEdges && cluster.length > 1 ? [cluster, [seed]] : [cluster]) {
        // Frame along the seed block's longest street side, centred on the cluster.
        const { u, cx, cz, eu, ev, total } = blockFrame(blocks, seed);
        const ridge = rng.chance(CFG.ridgeChance);
        const basin = rng.chance(CFG.basinChance);
        const a = Math.max(25, eu - CFG.inset);
        const b = ridge ? CFG.ridgeHalfWidth : Math.max(25, ev - CFG.inset);
        // Tallest hill that fits, from a random height down to the minimum.
        let shape: HillShape | null = null;
        const h0 = rng.range(CFG.height[0], CFG.height[1]);
        for (let h = routeEdges ? CFG.height[1] : h0; h >= CFG.height[0] - 1e-9; h -= 1) {
          const s: HillShape = { cx, cz, ux: u.x, uz: u.z, a, b, h: basin ? -h : h, w: (1.5 * h) / CFG.maxGrade };
          if (fits(s)) {
            shape = s;
            break;
          }
        }
        if (!shape) continue;
        if (ctx.budget.used + total > ctx.budget.total) break;
        for (const f of blocks) taken.add(f.id);
        made.push(shape);
        routes?.forEach((r, i) => (served[i] ||= blocks.some((f) => f.edges.some((e) => r.has(e)))));
        ctx.addArea(
          {
            kind: 'hills',
            variant: basin ? 'basin' : ridge ? 'ridge' : 'dome',
            polygon: hillOutline(shape, shape.w * CFG.reach),
            path: [],
            nodes: [],
            edges: [],
            faces: blocks.map((f) => f.id),
            params: { cx, cz, ux: u.x, uz: u.z, a, b, h: shape.h, w: shape.w, yaw: atan2(u.x, u.z), blocks: blocks.length },
          },
          total,
        );
        break;
      }
    }
  },

  build(_ctx, area) {
    const b = emptyBuild();
    const s = shapeOf(area);
    if (s.terrace) {
      // The rounded square's corners stand 1.39 times its reach out on the unwarped grid, and the warp moves
      // a point there from the summit by its waves' difference, at most about a quarter again (CITY.warp).
      const t = s.terrace;
      const r = 1.8 * terraceReach(t) + 2;
      b.heightMods.push({ minX: s.cx - r, minZ: s.cz - r, maxX: s.cx + r, maxZ: s.cz + r, add: (x, z, out) => terraceAt(s, t, x, z, out) });
      b.hints.push({ kind: 'hill', points: [{ x: s.cx, z: s.cz }, { x: s.ux, z: s.uz }], values: [s.a, s.b, s.h, s.w] });
      return b;
    }
    // Bounding box of the rectangle grown by the slope width (the rounded corners stay inside it).
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const lu = su * (s.a + s.w + 1);
        const lv = sv * (s.b + s.w + 1);
        const x = s.cx + lu * s.ux - lv * s.uz;
        const z = s.cz + lu * s.uz + lv * s.ux;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    b.heightMods.push({ minX, minZ, maxX, maxZ, add: (x, z, out) => hillAt(s, x, z, out) });
    b.hints.push({ kind: 'hill', points: [{ x: s.cx, z: s.cz }, { x: s.ux, z: s.uz }], values: [s.a, s.b, s.h, s.w] });
    return b;
  },
};

/**
 * The terraced hill, on a seed that rolls it (CFG.terraced.chance, its own stream): a summit junction a
 * couple of blocks in from the map's edge, a plain four way crossing not held by anything, whose hill
 * fits clear of everything level (the same keep-outs as any hill's, against the disc holding it) and
 * whose rings of junctions all land on their tables. Junctions the routes run through come first, so the
 * races take its jumps, but no route starts on its slopes (the grid stands level). Claims the free blocks
 * whose middles it lifts.
 */
function planTerraced(ctx: PlanContext, faces: readonly BlockFace[], eligible: (f: BlockFace) => boolean, fits: (s: HillShape) => boolean): Area | null {
  const rng = new Rng(deriveSeed(ctx.seed, 'district:hills:terraced'));
  if (!rng.chance(TER.chance)) return null;
  const g = ctx.graph;
  const W = g.plan.gridW;
  const H = g.plan.gridH;
  // A tighter grid than the house one keeps the ramps' grade: the step shrinks with the ramp's run.
  const L = g.plan.spacing;
  const step = rng.range(TER.step[0], TER.step[1]) * Math.min(1, (L - 2 * TER.flat - TER.ease) / (CITY.spacing - 2 * TER.flat - TER.ease));
  const routes = ctx.event?.routes ?? [];
  const onRoute = new Set(routes.flatMap((r) => r.nodes));
  const starts = routes.map((r) => g.nodes[r.nodes[0]]).filter(Boolean);
  const candidates = g.nodes.filter((n) => n.gi >= 2 && n.gi <= W - 3 && n.gj >= 2 && n.gj <= H - 3 && n.edges.length === 4 && !n.ring && !ctx.claims.node.has(n.id));
  rng.shuffle(candidates);
  candidates.sort((a, b) => (onRoute.has(b.id) ? 1 : 0) - (onRoute.has(a.id) ? 1 : 0));
  const warp = warpTerms(ctx.seed);
  const reach = terraceReach({ ...TER, L });
  for (const n of candidates) {
    const c = unwarp(warp, n.x, n.z);
    const t: Terrace = { tiers: TER.tiers, step, flat: TER.flat, ease: TER.ease, p: TER.p, L, X: c.X, Z: c.Z, warp };
    const shape: HillShape = { cx: n.x, cz: n.z, ux: 1, uz: 0, a: 0, b: 0, h: TER.tiers * step, w: reach, terrace: t };
    const local = (x: number, z: number) => plateauDistance(shape, x, z).d;
    // Every grid junction of the rings on its table (their jitter, CITY.jitter, and any planner's nudge
    // within it), and the next ring out on the ground, else not here.
    const table = TER.flat - 3;
    let level = true;
    for (const m of g.nodes) {
      if (m.gi < 0 || m.id === n.id) continue;
      const k = Math.max(Math.abs(m.gi - n.gi), Math.abs(m.gj - n.gj));
      if (k > TER.tiers + 1) continue;
      const d = local(m.x, m.z);
      if (k < TER.tiers ? Math.abs(d - k * L) > table : d < reach + 3) {
        level = false;
        break;
      }
    }
    if (!level) continue;
    // The grid stands level: no route starts on its slopes.
    if (starts.some((p) => local(p.x, p.z) < reach + 20)) continue;
    // Its blocks: those whose middles stand on the terraces, the summit's four at least (whatever holds one
    // keeps its own level ground off the slopes through `fits`).
    const blocks = faces.filter((f) => {
      if (f.outer) return false;
      const m = polygonCentroid(f.ring);
      return local(m.x, m.z) < reach - 20;
    });
    if (blocks.filter((f) => f.corners.some((k) => k.node === n.id)).length < 4) continue;
    const mine = blocks.filter(eligible);
    const total = mine.reduce((m, f) => m + f.area, 0);
    if (ctx.budget.used + total > ctx.budget.total) continue;
    if (!fits(shape)) continue;
    return ctx.addArea(
      {
        kind: 'hills',
        variant: 'terraced',
        polygon: terraceOutline(t, reach - 6),
        path: [],
        nodes: [n.id],
        edges: [],
        faces: mine.map((f) => f.id),
        params: { cx: n.x, cz: n.z, ux: 1, uz: 0, a: 0, b: 0, h: shape.h, w: reach, yaw: 0, blocks: mine.length, tiers: t.tiers, step, flat: t.flat, ease: t.ease, p: t.p, L: t.L, X: t.X, Z: t.Z, seed: ctx.seed },
      },
      total,
    );
  }
  return null;
}
