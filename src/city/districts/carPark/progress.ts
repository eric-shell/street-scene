/**
 * Race progress on a car park. The ramp and the deck are a shortcut the route skips, so progress up there
 * follows the car park's own line, mapped onto the route stretch it skips: it runs on smoothly and is credited
 * in full, and a car up there is never counted lost. carParkProgress answers race.ts for a car on the car
 * park (null elsewhere); onCarPark says whether a point is on one of the route's car parks at all.
 */
import type { Route } from '../../route';
import type { RouteProgress } from '../../world';
import { Vec2, segmentT } from '../../../sim/math';
import { pointInPolygon, segmentAt } from '../geom';
import type { Area } from '../types';
import { ROUTE_INDEX, carParks, unit } from './geometry';

/** What race progress needs of a world (race.ts passes its World). */
interface ProgressWorld {
  areas: readonly Area[];
  openWorld?: boolean;
  route: Route;
}

/** A route's car park as race progress sees it. */
interface ParkTrack {
  /** The footprint: a car inside it is on the car park (the ramp climbs inside it); its bounds. */
  zones: Vec2[][];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** The racing line from the ramp's foot to the lip, with cumulative lengths (m). */
  path: Vec2[];
  cum: number[];
  /** Route position the foot maps onto, and the route distance from there to the lip's (m). */
  sIn: number;
  span: number;
}
const tracks = new WeakMap<object, ParkTrack[]>();

/** Nearest point of a polyline: segment index and parameter. */
function nearestOnPath(path: Vec2[], x: number, z: number): { i: number; t: number; d2: number } {
  let best = { i: 0, t: 0, d2: Infinity };
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const t = segmentT(x, z, a.x, a.z, b.x, b.z);
    const px = a.x + (b.x - a.x) * t;
    const pz = a.z + (b.z - a.z) * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best.d2) best = { i, t, d2 };
  }
  return best;
}

/** Route position (polyline m) nearest a point, over the whole route. */
function routeS(route: Route, x: number, z: number): number {
  const q = nearestOnPath(route.points, x, z);
  return route.cum[q.i] + q.t * (route.cum[q.i + 1] - route.cum[q.i]);
}

/** The route's own car parks (the others are shuttered), built once per route. */
function tracksFor(world: ProgressWorld): ParkTrack[] {
  // Hand built test worlds have no districts.
  if (!world.areas || !world.route) return [];
  let list = tracks.get(world.route);
  if (list) return list;
  const route = world.route;
  const ri = ROUTE_INDEX[route.kind];
  list = world.openWorld
    ? []
    : carParks(world.areas)
        .filter((g) => g.owner === ri)
        .map((g) => {
          const path = g.path;
          const cum = [0];
          for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + unit(path[i - 1], path[i]).len);
          const sIn = routeS(route, path[0].x, path[0].z);
          let span = routeS(route, path[path.length - 1].x, path[path.length - 1].z) - sIn;
          if (route.closed) span = ((span % route.length) + route.length) % route.length;
          return { zones: [g.deck], ...g.box, path, cum, sIn, span };
        });
  tracks.set(world.route, list);
  return list;
}

function trackAt(world: ProgressWorld, x: number, z: number): ParkTrack | null {
  for (const t of tracksFor(world)) {
    if (x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ) continue;
    if (t.zones.some((p) => pointInPolygon(x, z, p))) return t;
  }
  return null;
}

/** Whether a point is on one of the route's car parks (anywhere on its floor or ramp): race.ts does not count a car up there as lost. */
export function onCarPark(world: ProgressWorld, x: number, z: number): boolean {
  return trackAt(world, x, z) !== null;
}

/**
 * Race progress for a car on one of the route's car parks, or null off them.
 * Up on the ramp and the roof the nearest street can be any of the block's
 * (an earlier stretch of the route included), so the car is placed along the
 * car park's own racing line instead, mapped linearly onto the route stretch
 * from its entry to the lip's junction: progress runs on smoothly while it
 * climbs, turns and launches, the direction for the wrong way check is the
 * line's, and once it is in the air over the junction the plain projection
 * (World.routeProgress) takes over where this one ends.
 */
export function carParkProgress(world: ProgressWorld, x: number, z: number): RouteProgress | null {
  const t = trackAt(world, x, z);
  if (!t) return null;
  const route = world.route;
  const q = nearestOnPath(t.path, x, z);
  const a = t.path[q.i];
  const b = t.path[q.i + 1];
  const len = t.cum[q.i + 1] - t.cum[q.i] || 1;
  const tx = (b.x - a.x) / len;
  const tz = (b.z - a.z) / len;
  let s = t.sIn + ((t.cum[q.i] + q.t * len) / t.cum[t.cum.length - 1]) * t.span;
  if (route.closed) s = ((s % route.length) + route.length) % route.length;
  else s = Math.min(s, route.length);
  // Polyline segment holding s: the hint the plain projection resumes from.
  const lo = segmentAt(route.cum, s);
  const px = a.x + (b.x - a.x) * q.t;
  const pz = a.z + (b.z - a.z) * q.t;
  return { s, lateral: (x - px) * tz - (z - pz) * tx, seg: lo, tx, tz };
}
