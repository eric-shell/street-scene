/**
 * The rail yard's footprint in a block: a rectangle with one long side on the block's frontage
 * line (the street both routes drive), found by growing it from the end of the frontage nearest
 * the neighbouring block, and the little frame algebra (world <-> local) everything else is
 * placed with. Pure and deterministic; reads only the block ring.
 *
 * Local coordinates: `u` along the street away from the cross street the yard's two blocks share
 * (or from the frontage's start, for a single block), `v` into the block from the frontage line.
 * The rectangle keeps `margin` m from the block ring on every side but the frontage, where the
 * fence stands `fence.inset` inside the line, so the buildings round it and the sidewalk are
 * never touched.
 */
import { CITY } from '../config';
import type { BlockFace } from '../blocks';
import type { Vec2 } from '../../sim/math';
import { distToSegment } from '../../sim/math';
import { distToPolygonEdge, pointInPolygon } from './geom';

const C = CITY.districts.railYard;

/** An oriented rectangle: origin corner on the frontage line, unit u along it, unit v into the block. */
export interface YardRect {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  /** Length along the street and depth into the block (m). */
  L: number;
  D: number;
}

export const rectPoint = (r: YardRect, u: number, v: number): Vec2 => ({ x: r.ox + r.ux * u + r.vx * v, z: r.oz + r.uz * u + r.vz * v });

export const rectU = (r: YardRect, x: number, z: number): number => (x - r.ox) * r.ux + (z - r.oz) * r.uz;
export const rectV = (r: YardRect, x: number, z: number): number => (x - r.ox) * r.vx + (z - r.oz) * r.vz;

/** The rectangle `[u0, u1] x [v0, v1]` of the frame as a polygon (the same winding for every call). */
export function rectPoly(r: YardRect, u0: number, u1: number, v0: number, v1: number): Vec2[] {
  return [rectPoint(r, u0, v0), rectPoint(r, u1, v0), rectPoint(r, u1, v1), rectPoint(r, u0, v1)];
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in x/z. */
export function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.z - b.z);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The longest straight run of the ring along graph edge `edge`, as its two ends in ring order; null when the ring has none. */
export function frontSegment(face: BlockFace, edge: number): { a: Vec2; b: Vec2 } | null {
  let best: { a: Vec2; b: Vec2 } | null = null;
  let len = 0;
  for (let i = 0; i < face.ring.length; i++) {
    if (face.segEdge[i] !== edge) continue;
    const a = face.ring[i];
    const b = face.ring[(i + 1) % face.ring.length];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    if (l > len) {
      len = l;
      best = { a, b };
    }
  }
  return best;
}

/** What a fit is worth: its length (capped) and a little more than its depth, so a block that runs long beats a deeper but shorter fit (freight needs the length). */
const score = (r: YardRect): number => Math.min(r.L, C.rect.length[1]) + 1.2 * r.D;

/** Scan step (m) of the fit. */
const STEP = 2;

/**
 * Fit the yard's rectangle into `face` along its frontage segments on `edges` (the pieces of the route street, which the
 * city splits at every bend; the largest fit wins). `away`, when given, is a point (the
 * neighbouring block's centroid) the rectangle grows away from, starting at the frontage's nearer end; without it
 * both directions are tried. Every depth in the configured range is tried, each as long as it runs clear (up to the
 * range's length), and the best `score` wins. Null when no rectangle reaches the
 * minimum depth and length.
 */
export function fitRect(face: BlockFace, edges: readonly number[], away: Vec2 | null): YardRect | null {
  let best: YardRect | null = null;
  for (const e of edges) {
    const r = fitRectOn(face, e, away);
    if (r && (!best || score(r) > score(best))) best = r;
  }
  return best;
}

/** `fitRect` along one edge's straight run. */
function fitRectOn(face: BlockFace, edge: number, away: Vec2 | null): YardRect | null {
  const seg = frontSegment(face, edge);
  if (!seg) return null;
  const ring = face.ring;
  const dx = seg.b.x - seg.a.x;
  const dz = seg.b.z - seg.a.z;
  const sl = Math.hypot(dx, dz);
  const tx = dx / sl;
  const tz = dz / sl;
  // Inward: the side of the segment the ring's inside lies on.
  const mid = { x: (seg.a.x + seg.b.x) / 2, z: (seg.a.z + seg.b.z) / 2 };
  let nx = tz;
  let nz = -tx;
  if (!pointInPolygon(mid.x + nx * 3, mid.z + nz * 3, ring)) {
    nx = -nx;
    nz = -nz;
  }
  const dirs: { ux: number; uz: number; start: Vec2 }[] = [];
  const fwd = { ux: tx, uz: tz, start: seg.a };
  const back = { ux: -tx, uz: -tz, start: seg.b };
  if (away) {
    // Away from the neighbour: u points the way the centroid is not.
    const toward = (away.x - mid.x) * tx + (away.z - mid.z) * tz;
    dirs.push(toward > 0 ? back : fwd);
  } else dirs.push(fwd, back);
  const R = C.rect;
  let best: YardRect | null = null;
  for (const d of dirs) {
    const base = { x: d.start.x + d.ux * C.rect.endClear, z: d.start.z + d.uz * C.rect.endClear };
    const columnOk = (u: number, depth: number): boolean => {
      for (let v = 0.8; v <= depth + 1e-6; v += STEP) {
        const x = base.x + d.ux * u + nx * v;
        const z = base.z + d.uz * u + nz * v;
        if (!pointInPolygon(x, z, ring) || distToPolygonEdge(x, z, ring) < Math.min(R.margin, v - 0.3)) return false;
      }
      // The back corner points on the column's far end exactly.
      const x = base.x + d.ux * u + nx * depth;
      const z = base.z + d.uz * u + nz * depth;
      return pointInPolygon(x, z, ring) && distToPolygonEdge(x, z, ring) >= R.margin;
    };
    for (let depth = R.depth[1]; depth >= R.depth[0] - 1e-6; depth -= STEP) {
      // The first clear column (the ring rounds the corner), then the run of clear columns after it.
      let u0 = -1;
      let u1 = -1;
      for (let u = 0; u <= 16; u += STEP) {
        if (columnOk(u, depth)) {
          u0 = u;
          break;
        }
      }
      if (u0 < 0) continue;
      u1 = u0;
      while (u1 + STEP <= u0 + R.length[1] && columnOk(u1 + STEP, depth)) u1 += STEP;
      const len = u1 - u0;
      if (len < R.length[0]) continue;
      const cand: YardRect = {
        ox: base.x + d.ux * u0,
        oz: base.z + d.uz * u0,
        ux: d.ux,
        uz: d.uz,
        vx: nx,
        vz: nz,
        L: len,
        D: depth,
      };
      if (!best || score(cand) > score(best)) best = cand;
    }
  }
  return best;
}

/** Distance (m) from a point to the rectangle's outline (0 on it), for the tests and clearances. */
export function distToRect(r: YardRect, x: number, z: number): number {
  const p = rectPoly(r, 0, r.L, 0, r.D);
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    best = Math.min(best, distToSegment(x, z, a.x, a.z, b.x, b.z));
  }
  return best;
}
