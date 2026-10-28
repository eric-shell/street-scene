/**
 * Race progress on a harbor's quay cut (route.ts: the lane across a quay recess, a shortcut of the routes
 * that go round the recess by the streets, harborShore.ts quayCuts). The lane skips a stretch of the route,
 * and the plain projection (World.routeProgress) cannot follow a car across it: it looks only a couple of
 * route segments either way from where the car was, and the far end of a lap-long detour is further than that,
 * so the skipped stretch would never be credited. Like the car park's ramp (carPark/progress.ts), a car on the
 * lane is placed along the lane itself, mapped linearly onto the route stretch it skips: progress runs on
 * smoothly, is credited in full and a car there is never counted lost. quayCutProgress answers race.ts for a
 * car on a lane (null elsewhere); onQuayCut says whether a point is on one.
 */
import type { Route } from '../route';
import type { RouteProgress } from '../world';
import { type Vec2, segmentT } from '../../sim/math';
import { segmentAt } from './geom';

/** How far from the lane's middle a car still counts as on the cut (m): the lane is 8 m wide, with the yard's clutter and skid pad either side. */
export const QUAY_CUT_REACH = 10;

/** A cut as progress sees it: the lane run (the way in and out are the streets' own) and the route stretch it maps onto. */
interface CutTrack {
  path: Vec2[];
  cum: number[];
  sIn: number;
  span: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}
const tracks = new WeakMap<Route, CutTrack[]>();

function tracksFor(route: Route): CutTrack[] {
  let list = tracks.get(route);
  if (list) return list;
  list = [];
  for (const sc of route.quayCuts) {
    // Its first and last points are the junctions, the rest the lane from mouth to mouth.
    if (sc.points.length < 4) continue;
    const path = sc.points.slice(1, -1);
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
    let span = sc.sOut - sc.sIn;
    if (route.closed) span = ((span % route.length) + route.length) % route.length;
    const xs = path.map((p) => p.x);
    const zs = path.map((p) => p.z);
    list.push({ path, cum, sIn: sc.sIn, span, minX: Math.min(...xs) - QUAY_CUT_REACH, maxX: Math.max(...xs) + QUAY_CUT_REACH, minZ: Math.min(...zs) - QUAY_CUT_REACH, maxZ: Math.max(...zs) + QUAY_CUT_REACH });
  }
  tracks.set(route, list);
  return list;
}

/** Nearest point of the track's lane to (x, z): segment, parameter, squared distance; null when none is within reach. */
function nearest(t: CutTrack, x: number, z: number): { i: number; u: number; d2: number } | null {
  if (x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ) return null;
  let best: { i: number; u: number; d2: number } | null = null;
  for (let i = 0; i + 1 < t.path.length; i++) {
    const a = t.path[i];
    const b = t.path[i + 1];
    const u = segmentT(x, z, a.x, a.z, b.x, b.z);
    const d2 = (x - (a.x + (b.x - a.x) * u)) ** 2 + (z - (a.z + (b.z - a.z) * u)) ** 2;
    if (d2 <= QUAY_CUT_REACH ** 2 && (!best || d2 < best.d2)) best = { i, u, d2 };
  }
  return best;
}

/** Whether a point is on one of the route's quay cuts (anywhere within reach of its lane): race.ts does not count a car there as lost. */
export function onQuayCut(route: Route, x: number, z: number): boolean {
  for (const t of tracksFor(route)) if (nearest(t, x, z)) return true;
  return false;
}

/** Race progress for a car on one of the route's quay cuts, or null off them (see the header). */
export function quayCutProgress(route: Route, x: number, z: number): RouteProgress | null {
  for (const t of tracksFor(route)) {
    const q = nearest(t, x, z);
    if (!q) continue;
    const a = t.path[q.i];
    const b = t.path[q.i + 1];
    const len = t.cum[q.i + 1] - t.cum[q.i] || 1;
    const tx = (b.x - a.x) / len;
    const tz = (b.z - a.z) / len;
    let s = t.sIn + ((t.cum[q.i] + q.u * len) / (t.cum[t.cum.length - 1] || 1)) * t.span;
    if (route.closed) s = ((s % route.length) + route.length) % route.length;
    else s = Math.min(s, route.length);
    const px = a.x + (b.x - a.x) * q.u;
    const pz = a.z + (b.z - a.z) * q.u;
    return { s, lateral: (x - px) * tz - (z - pz) * tx, seg: segmentAt(route.cum, s), tx, tz };
  }
  return null;
}
