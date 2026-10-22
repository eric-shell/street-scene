/** Small pure 2D geometry helpers shared by the district modules. */
import { Vec2, cos, distToSegment, sin, sqrt } from '../../sim/math';
import { SpatialGrid } from '../spatial';
import type { Solid, Wall } from '../blocks';
import type { WallLook } from './types';

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p.x;
    z += p.z;
  }
  return { x: x / poly.length, z: z / poly.length };
}

export function polygonBounds(poly: Vec2[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** Even-odd point in polygon test. */
export function pointInPolygon(x: number, z: number, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a polygon's boundary. */
/**
 * Distance from a point to a polyline's segments (m), closing it from the last point back to the first when
 * `closed`. The point on each segment is found and subtracted inline (unlike distToPath), so the two round
 * differently in the last bit: each planner keeps the one its layouts were made with.
 */
function distToSegments(x: number, z: number, pts: Vec2[], closed: boolean): number {
  let best = Infinity;
  const n = pts.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-12 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = sqrt((x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2);
    if (d < best) best = d;
  }
  return best;
}

/** Distance from a point to a polygon's outline (m). */
export function distToPolygonEdge(x: number, z: number, poly: Vec2[]): number {
  return distToSegments(x, z, poly, true);
}

/** Distance from a point to an open polyline (m), by distToPolygonEdge's formula. */
export function distToPolyline(x: number, z: number, pts: Vec2[]): number {
  return distToSegments(x, z, pts, false);
}

/** Distance from a point to an open polyline (m), through sim/math distToSegment (alleys, car parks, the river's decks). */
export function distToPath(path: readonly Vec2[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) best = Math.min(best, distToSegment(x, z, path[i].x, path[i].z, path[i + 1].x, path[i + 1].z));
  return best;
}

export function circlePolygon(cx: number, cz: number, r: number, n: number, phase = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    out.push({ x: cx + cos(a) * r, z: cz + sin(a) * r });
  }
  return out;
}

/** Oriented rectangle from an origin corner, an along axis u (unit) and a depth axis w (unit). */
export function rectPolygon(o: Vec2, u: Vec2, w: Vec2, len: number, depth: number): Vec2[] {
  return [
    { x: o.x, z: o.z },
    { x: o.x + u.x * len, z: o.z + u.z * len },
    { x: o.x + u.x * len + w.x * depth, z: o.z + u.z * len + w.z * depth },
    { x: o.x + w.x * depth, z: o.z + w.z * depth },
  ];
}

/**
 * One wall per polygon side (or per open polyline segment when `closed` is
 * false). `inward` true: normals face the polygon interior (a drivable lot);
 * false: they face outward (a solid object). For open polylines `inward`
 * means "to the right of travel".
 */
export function polyWalls(poly: Vec2[], inward: boolean, look: WallLook, area: number, closed = true): Wall[] {
  const out: Wall[] = [];
  const ccw = polygonArea(poly) > 0;
  const m = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < m; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = sqrt(dx * dx + dz * dz);
    if (len < 0.05) continue;
    // Left normal (-dz, dx) points inside a CCW (positive area) polygon.
    const wantLeft = closed ? inward === ccw : !inward;
    const nx = wantLeft ? -dz / len : dz / len;
    const nz = wantLeft ? dx / len : -dx / len;
    out.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, nx, nz, kind: 'wall', look, area });
  }
  return out;
}

/** Walls of a small convex solid (a closed convex polygon, normals outward) that the sim collides with as one body (Wall.solid). */
export function solidWalls(poly: Vec2[], look: WallLook, area: number): Wall[] {
  const walls = polyWalls(poly, false, look, area);
  const solid: Solid = { faces: walls.map((w) => ({ ax: w.ax, az: w.az, bx: w.bx, bz: w.bz, nx: w.nx, nz: w.nz })) };
  for (const w of walls) w.solid = solid;
  return walls;
}

/** Point-in-polygon index over many polygons (bounding box broadphase). */
export class PolygonIndex<T extends { polygon: Vec2[] }> {
  private grid: SpatialGrid;
  private scratch: number[] = [];
  readonly items: T[] = [];

  constructor(minX: number, minZ: number, maxX: number, maxZ: number, cell = 24) {
    this.grid = SpatialGrid.forBounds(minX, minZ, maxX, maxZ, cell);
  }

  add(item: T): void {
    const b = polygonBounds(item.polygon);
    this.grid.insertBox(this.items.length, b.minX, b.minZ, b.maxX, b.maxZ);
    this.items.push(item);
  }

  /** Every item containing the point, in insertion order. */
  at(x: number, z: number, out: T[]): T[] {
    out.length = 0;
    this.grid.query(x, z, x, z, this.scratch);
    for (const id of this.scratch) if (pointInPolygon(x, z, this.items[id].polygon)) out.push(this.items[id]);
    return out;
  }

  /** First item containing the point, or null. */
  first(x: number, z: number): T | null {
    this.grid.query(x, z, x, z, this.scratch);
    for (const id of this.scratch) if (pointInPolygon(x, z, this.items[id].polygon)) return this.items[id];
    return null;
  }

  /** Any item whose polygon comes within r of the point (inside or near its edge). */
  near(x: number, z: number, r: number): boolean {
    this.grid.query(x - r, z - r, x + r, z + r, this.scratch);
    for (const id of this.scratch) {
      const p = this.items[id].polygon;
      if (pointInPolygon(x, z, p) || distToPolygonEdge(x, z, p) < r) return true;
    }
    return false;
  }
}

/** A smoothstep's value and its derivative. */
export interface Smooth {
  v: number;
  d: number;
}

/**
 * Smoothstep from e0 to e1 at x and its derivative (for analytic terrain gradients), written into `out`.
 * The terrain is queried per wheel per substep, so callers on that path pass a scratch of their own.
 */
export function smooth01(e0: number, e1: number, x: number, out: Smooth = { v: 0, d: 0 }): Smooth {
  const w = e1 - e0;
  const t = (x - e0) / w;
  if (t <= 0) {
    out.v = 0;
    out.d = 0;
  } else if (t >= 1) {
    out.v = 1;
    out.d = 0;
  } else {
    out.v = t * t * (3 - 2 * t);
    out.d = (6 * t * (1 - t)) / w;
  }
  return out;
}

/** Smoothstep's value alone (allocates nothing). */
export function smooth01v(e0: number, e1: number, x: number): number {
  const t = (x - e0) / (e1 - e0);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/**
 * The segment of a polyline holding distance s along it (binary search on its cumulative lengths `cum`,
 * cum[0] = 0): the largest i in 0..n-2 with cum[i] <= s, so s past either end gets the end segment.
 */
export function segmentAt(cum: readonly number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}
