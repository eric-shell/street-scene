/**
 * The solid pieces of a car park. Every edge of the floor is a thin two sided solid (Wall.solid): one body
 * stops cars on the deck at the parapet and cars in the street at the facade under it, and the ramp's side
 * walls part it from the deck beside it the same way; the lip's face is a low wall (Wall.top). deckEdges is the
 * outline the walls and the renderer both follow, carParkWalls adds the parked cars and columns. Also what
 * other routes' pieces do around a car park: the route's corner rails cut where the flight crosses them
 * (carParkRails), and the shutters across the ramps of the car parks that are not this route's shortcut.
 */
import { CITY } from '../../config';
import type { Wall } from '../../blocks';
import type { RouteKind } from '../../route';
import { Vec2, sqrt } from '../../../sim/math';
import { pointInPolygon, polygonArea, segmentInConvex, solidWalls } from '../geom';
import type { Area } from '../types';
import { CAR_HALF, type CarParkGeo, ROUTE_INDEX, carParks, flightCorridor, frontU, funnelFlare, rampPoint, toWorld } from './geometry';
import { carParkFloor, columnBox, parkedCarBox } from './floor';

const CFG = CITY.districts.carPark;

/** Thin two sided solid along a-b, t thick toward `toward` (any point on that side). */
function slab(a: Vec2, b: Vec2, toward: Vec2, t: number, area: number): Wall[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = sqrt(dx * dx + dz * dz);
  if (len < 0.3) return [];
  let nx = -dz / len;
  let nz = dx / len;
  if ((toward.x - a.x) * nx + (toward.z - a.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  return solidWalls([a, b, { x: b.x + nx * t, z: b.z + nz * t }, { x: a.x + nx * t, z: a.z + nz * t }], 'carPark', area);
}

/** What a piece of the footprint's outline is: parapet and facade, the lip's opening, or the ramp's mouth. */
export type DeckEdgeKind = 'wall' | 'lip' | 'ramp';

/**
 * The two openings in the footprint's outline as convex world polygons: the
 * lip (the exit lane's width across the front, reaching out past the
 * building line) and the ramp's mouth (the apron between its flared walls'
 * outer faces, reaching out across the sidewalk).
 */
export function deckOpenings(g: CarParkGeo): { lip: Vec2[]; ramp: Vec2[] } {
  const W = (u: number, v: number) => toWorld(g, u, v);
  const fMin = Math.min(...g.front.map((f) => f.u));
  const t = CFG.wall;
  const l0 = -(g.rhw + g.fl + t);
  const l1 = g.rhw + g.fr + t;
  return {
    lip: [W(fMin - 3, -g.hc), W(g.lc, -g.hc), W(g.lc, g.hc), W(fMin - 3, g.hc)],
    ramp: [rampPoint(g, -6, l0), rampPoint(g, g.apron0 + 1, l0), rampPoint(g, g.apron0 + 1, l1), rampPoint(g, -6, l1)],
  };
}

/**
 * The footprint's outline in ring order, each edge cut where an opening
 * crosses it: the pieces that are parapet (and facade under it), the lip's
 * span and the ramp's mouth. The sim walls the first kind (carParkWalls);
 * the renderer dresses all three (render/districts/carPark.ts).
 */
export function deckEdges(g: CarParkGeo): { a: Vec2; b: Vec2; kind: DeckEdgeKind }[] {
  const open = deckOpenings(g);
  const holes: [Vec2[], DeckEdgeKind][] = [
    [open.lip, 'lip'],
    [open.ramp, 'ramp'],
  ];
  const out: { a: Vec2; b: Vec2; kind: DeckEdgeKind }[] = [];
  const n = g.deck.length;
  for (let i = 0; i < n; i++) {
    const a = g.deck[i];
    const b = g.deck[(i + 1) % n];
    const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    const spans: { t0: number; t1: number; kind: DeckEdgeKind }[] = [];
    for (const [poly, kind] of holes) {
      const span = segmentInConvex(a, b, poly);
      if (span && span[1] - span[0] > 1e-6) spans.push({ t0: span[0], t1: span[1], kind });
    }
    spans.sort((p, q) => p.t0 - q.t0);
    let t = 0;
    for (const sp of spans) {
      if (sp.t0 > t + 1e-6) out.push({ a: at(t), b: at(sp.t0), kind: 'wall' });
      out.push({ a: at(sp.t0), b: at(sp.t1), kind: sp.kind });
      t = sp.t1;
    }
    if (t < 1 - 1e-6) out.push({ a: at(t), b: at(1), kind: 'wall' });
  }
  return out;
}

/**
 * Every wall of a car park: thin solids (look 'carPark') along the
 * footprint's outline (open across the lip and the ramp's mouth), both chute
 * walls, the apron's flared sides and the ramp's sides; the drivable floor's
 * parked cars, columns and stair core (carParkFloor); then the one sided low
 * face under the lip (Wall.top, settled later).
 */
export function carParkWalls(g: CarParkGeo, seed: number): Wall[] {
  const out: Wall[] = [];
  const t = CFG.wall;
  const W = (u: number, v: number) => toWorld(g, u, v);
  // Parapets sit inside the footprint (thickened inward by its way round: an L's centroid may lie
  // outside it), chute and ramp walls outside the lane they line.
  const inward = polygonArea(g.deck) < 0 ? 1 : -1;
  for (const e of deckEdges(g)) {
    if (e.kind !== 'wall') continue;
    const n = { x: (e.b.z - e.a.z) * inward, z: -(e.b.x - e.a.x) * inward };
    out.push(...slab(e.a, e.b, { x: e.a.x + n.x, z: e.a.z + n.z }, t, g.area));
  }
  // Chute walls: parallel from the front line, then splaying out into the mouth's funnel.
  for (const s of [-1, 1]) {
    const cw = funnelFlare(g, s);
    out.push(...slab(W(frontU(g, g.hc * s), g.hc * s), W(g.lc, g.hc * s), W(g.lc / 2, g.hc * s * 3), t, g.area));
    out.push(...slab(W(g.lc, g.hc * s), W(g.lc + g.cf, (g.hc + cw) * s), W(g.lc + g.cf / 2, (g.hc + cw) * s * 3), t, g.area));
  }
  // The drivable floor's parked cars, columns and stair core.
  const floor = carParkFloor(g, seed);
  for (const s of floor.stalls) if (s.car >= 0) out.push(...solidWalls(parkedCarBox(s), 'carPark', g.area));
  for (const c of floor.columns) out.push(...solidWalls(columnBox(g, c), 'carPark', g.area));
  if (floor.core) out.push(...solidWalls(floor.core, 'carPark', g.area));
  const r = g.ramp;
  const mid = rampPoint(g, (g.apron1 + g.rend) / 2, 0);
  const away = (p: Vec2) => ({ x: 2 * p.x - mid.x, z: 2 * p.z - mid.z });
  out.push(...slab(r[0], r[1], away(r[0]), t, g.area));
  out.push(...slab(r[5], r[4], away(r[5]), t, g.area));
  for (const s of [-1, 1]) out.push(...slab(rampPoint(g, g.apron1, s * g.rhw), rampPoint(g, g.rend, s * g.rhw), rampPoint(g, g.apron1, s * g.rhw * 3), t, g.area));
  // The face under the lip: the front polyline across it, one sided toward the street.
  const lipV = [-g.hc, ...g.front.map((f) => f.v).filter((v) => v > -g.hc && v < g.hc), g.hc];
  for (let i = 1; i < lipV.length; i++) {
    const a = W(frontU(g, lipV[i - 1]), lipV[i - 1]);
    const b = W(frontU(g, lipV[i]), lipV[i]);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = sqrt(dx * dx + dz * dz);
    if (len < 0.05) continue;
    // Normal out of the deck (toward -u).
    let nx = -dz / len;
    let nz = dx / len;
    if (nx * g.ux + nz * g.uz > 0) {
      nx = -nx;
      nz = -nz;
    }
    out.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, nx, nz, kind: 'wall', look: 'carPark', area: g.area, top: Infinity });
  }
  return out;
}

/** Segment a-b touches a convex polygon (an end inside or a crossing). */
function segmentTouches(ax: number, az: number, bx: number, bz: number, poly: Vec2[]): boolean {
  if (pointInPolygon(ax, az, poly) || pointInPolygon(bx, bz, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const d1 = (bx - ax) * (p.z - az) - (bz - az) * (p.x - ax);
    const d2 = (bx - ax) * (q.z - az) - (bz - az) * (q.x - ax);
    const d3 = (q.x - p.x) * (az - p.z) - (q.z - p.z) * (ax - p.x);
    const d4 = (q.x - p.x) * (bz - p.z) - (q.z - p.z) * (bx - p.x);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/**
 * A route's corner rails with every piece the flight off one of its car
 * parks would cross taken out (the rail at C runs along the building line in
 * front of the lip); the rest of each rail stays, its ends at the gap.
 */
export function carParkRails<T extends Wall>(areas: readonly Area[], route: number, rails: T[]): T[] {
  const zones = carParks(areas)
    .filter((g) => g.owner === route)
    .map((g) => flightCorridor(g, g.lipBack + 14, CAR_HALF + CFG.flightClear));
  return railsClearOf(zones, rails);
}

/**
 * `rails` with every piece touching one of the `zones` (convex polygons, a
 * flight corridor) taken out; the rest of each rail stays, its ends at the
 * gap. Shared with the alleys' jump exits (districts/alleyDressing.ts).
 */
export function railsClearOf<T extends Wall>(zones: readonly Vec2[][], rails: T[]): T[] {
  if (!zones.length) return rails;
  const cut = new Set<string>();
  const key = (w: Wall & { piece?: number }) => `${w.group ?? -1}:${w.piece ?? -1}`;
  for (const w of rails) if (zones.some((z) => segmentTouches(w.ax, w.az, w.bx, w.bz, z))) cut.add(key(w));
  if (!cut.size) return rails;
  // A rail cut in two is two rails: the run after the gap gets a group of its own (ids past the last).
  let next = 0;
  for (const w of rails) next = Math.max(next, (w.group ?? -1) + 1);
  const out: T[] = [];
  let group = -1;
  let gap = false;
  let renamed = -1;
  for (const w of rails) {
    if (w.group !== group) {
      group = w.group ?? -1;
      gap = false;
      renamed = -1;
    }
    if (cut.has(key(w))) {
      gap = true;
      renamed = -1;
      continue;
    }
    if (gap && renamed < 0) renamed = next++;
    out.push(renamed < 0 ? w : { ...w, group: renamed });
  }
  return out;
}

/** Whether a point is within `pad` m of a flight off one of the route's car parks (over the junction, render dressing keeps out). */
export function nearCarParkFlight(world: { areas: readonly Area[]; openWorld?: boolean; route: { kind: RouteKind } }, x: number, z: number, pad: number): boolean {
  for (const g of carParks(world.areas)) {
    if (!world.openWorld && g.owner !== ROUTE_INDEX[world.route.kind]) continue;
    if (pointInPolygon(x, z, flightCorridor(g, g.lipBack + 14, pad))) return true;
  }
  return false;
}

/** Shutters across the ramps of the car parks that are not this route's shortcut (thin solids, look 'carPark'). */
export function carParkGates(areas: readonly Area[], route: number): Wall[] {
  const out: Wall[] = [];
  for (const g of carParks(areas)) {
    if (g.owner === route) continue;
    const a = g.apron1 - 0.4;
    out.push(...slab(rampPoint(g, a, -g.rhw - CFG.wall), rampPoint(g, a, g.rhw + CFG.wall), rampPoint(g, a + 2, 0), CFG.wall, g.area));
  }
  return out;
}
