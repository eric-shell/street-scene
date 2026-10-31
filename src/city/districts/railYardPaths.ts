/**
 * Path geometry for the rail yard's layout (railYardLayout.ts): rounded polylines for the lines and the overbridge,
 * mitred offsets for strips along them, and the clearance book that keeps every solid, car and prop off the lines'
 * paths (a line is a promise to the rivals that its centre line is drivable at its width, docs/weekend.md). Pure.
 */
import type { Vec2 } from '../../sim/math';
import { atan2, cos, distToSegment, sin, sqrt } from '../../sim/math';

/** A rounded polyline: each inner corner replaced by a circular arc of `radius` (shrunk to fit), sampled every `step` m of arc. */
export function fillet(pts: readonly Vec2[], radius: number, step = 3): Vec2[] {
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, z: p.z }));
  const out: Vec2[] = [{ x: pts[0].x, z: pts[0].z }];
  // The tangent length used at each corner, shrunk so neighbouring arcs never overlap on a short leg.
  const legs: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) legs.push(sqrt((pts[i + 1].x - pts[i].x) ** 2 + (pts[i + 1].z - pts[i].z) ** 2));
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l0 = legs[i - 1] || 1;
    const l1 = legs[i] || 1;
    const d0x = (b.x - a.x) / l0;
    const d0z = (b.z - a.z) / l0;
    const d1x = (c.x - b.x) / l1;
    const d1z = (c.z - b.z) / l1;
    const turn = atan2(d0x * d1z - d0z * d1x, d0x * d1x + d0z * d1z);
    const at = Math.abs(turn);
    if (at < 1e-4) {
      out.push({ x: b.x, z: b.z });
      continue;
    }
    // Each leg may give at most half of itself to a corner (the first and last legs all of it).
    const room = Math.min(i === 1 ? l0 : l0 / 2, i + 2 === pts.length ? l1 : l1 / 2);
    const r = Math.min(radius, room / Math.tan(at / 2));
    const tl = r * Math.tan(at / 2);
    const p0 = { x: b.x - d0x * tl, z: b.z - d0z * tl };
    // The arc's centre: left of the travel for a left turn (turn > 0), right for a right turn.
    const s = turn > 0 ? 1 : -1;
    const cx = p0.x - d0z * r * s;
    const cz = p0.z + d0x * r * s;
    const a0 = atan2(p0.z - cz, p0.x - cx);
    const n = Math.max(1, Math.ceil((r * at) / step));
    for (let k = 0; k <= n; k++) {
      const th = a0 + (turn * k) / n;
      out.push({ x: cx + cos(th) * r, z: cz + sin(th) * r });
    }
  }
  out.push({ x: pts[pts.length - 1].x, z: pts[pts.length - 1].z });
  // Drop points closer than a few cm (an arc ending on a vertex).
  return out.filter((p, i) => i === 0 || sqrt((p.x - out[i - 1].x) ** 2 + (p.z - out[i - 1].z) ** 2) > 0.05);
}

/** Cumulative lengths of a polyline (m). */
export function cumulative(pts: readonly Vec2[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
  return cum;
}

/** The polyline offset by `d` m to its left (atan2 convention), mitred at the joints (miter capped at 2 d). */
export function offset(pts: readonly Vec2[], d: number): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[Math.max(0, i - 1)];
    const q = pts[Math.min(n - 1, i + 1)];
    const a = i > 0 ? pts[i - 1] : pts[i];
    const b = pts[i];
    const c = i + 1 < n ? pts[i + 1] : pts[i];
    const l0 = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    const l1 = sqrt((c.x - b.x) ** 2 + (c.z - b.z) ** 2);
    let nx: number;
    let nz: number;
    if (l0 > 1e-9 && l1 > 1e-9) {
      const n0x = -(b.z - a.z) / l0;
      const n0z = (b.x - a.x) / l0;
      const n1x = -(c.z - b.z) / l1;
      const n1z = (c.x - b.x) / l1;
      const mx = n0x + n1x;
      const mz = n0z + n1z;
      const ml = sqrt(mx * mx + mz * mz) || 1;
      const k = Math.min(2, 1 / Math.max(0.5, (mx / ml) * n0x + (mz / ml) * n0z));
      nx = (mx / ml) * k;
      nz = (mz / ml) * k;
    } else {
      const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
      nx = -(q.z - p.z) / l;
      nz = (q.x - p.x) / l;
    }
    out.push({ x: b.x + nx * d, z: b.z + nz * d });
  }
  return out;
}

/** Do segments ab and cd cross (proper or touching)? */
function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

/** Distance (m) between segment ab and a closed polygon (0 when they touch or the segment is inside). */
export function segmentPolygonDist(a: Vec2, b: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i];
    const q = poly[j];
    if (segmentsCross(a, b, p, q)) return 0;
    best = Math.min(best, distToSegment(p.x, p.z, a.x, a.z, b.x, b.z), distToSegment(a.x, a.z, p.x, p.z, q.x, q.z), distToSegment(b.x, b.z, p.x, p.z, q.x, q.z));
    if (p.z > a.z !== q.z > a.z && a.x < ((q.x - p.x) * (a.z - p.z)) / (q.z - p.z) + p.x) inside = !inside;
  }
  return inside ? 0 : best;
}

/** A corridor: a polyline everything keeps `half` m off (a line's path, the deck's footprint, a landing). */
export interface Corridor {
  id: string;
  pts: Vec2[];
  half: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** The clearance book: corridors, and the footprints placed so far (convex polygons) that later ones keep off. */
export class Clearance {
  corridors: Corridor[] = [];
  taken: { poly: Vec2[]; minX: number; minZ: number; maxX: number; maxZ: number }[] = [];

  corridor(id: string, pts: Vec2[], half: number): void {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    this.corridors.push({ id, pts, half, minX: minX - half, minZ: minZ - half, maxX: maxX + half, maxZ: maxZ + half });
  }

  /** Is the polygon clear of every corridor (by its half width plus `pad`), skipping the ids in `skip`? */
  clearOfLines(poly: readonly Vec2[], pad = 0, skip?: ReadonlySet<string>): boolean {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    for (const c of this.corridors) {
      if (skip?.has(c.id)) continue;
      const r = c.half + pad;
      if (maxX < c.minX - pad || minX > c.maxX + pad || maxZ < c.minZ - pad || minZ > c.maxZ + pad) continue;
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i];
        const b = c.pts[i + 1];
        if (Math.max(a.x, b.x) + r < minX || Math.min(a.x, b.x) - r > maxX || Math.max(a.z, b.z) + r < minZ || Math.min(a.z, b.z) - r > maxZ) continue;
        if (segmentPolygonDist(a, b, poly) < r) return false;
      }
    }
    return true;
  }

  /** Is the convex polygon clear of every footprint taken so far by `pad` m? */
  clearOfTaken(poly: readonly Vec2[], pad = 0): boolean {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    for (const t of this.taken) {
      if (maxX + pad < t.minX || minX - pad > t.maxX || maxZ + pad < t.minZ || minZ - pad > t.maxZ) continue;
      for (let i = 0; i < poly.length; i++) if (segmentPolygonDist(poly[i], poly[(i + 1) % poly.length], t.poly) < pad + 1e-9) return false;
      // A footprint wholly inside the new one touches none of its edges.
      if (segmentPolygonDist(t.poly[0], t.poly[0], poly) === 0) return false;
    }
    return true;
  }

  take(poly: Vec2[]): void {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x);
      minZ = Math.min(minZ, p.z);
      maxX = Math.max(maxX, p.x);
      maxZ = Math.max(maxZ, p.z);
    }
    this.taken.push({ poly, minX, minZ, maxX, maxZ });
  }

  /** Clear of the lines and of what is taken: then take it. */
  place(poly: Vec2[], linePad = 0, takenPad = 0.3, skip?: ReadonlySet<string>): boolean {
    if (!this.clearOfLines(poly, linePad, skip) || !this.clearOfTaken(poly, takenPad)) return false;
    this.take(poly);
    return true;
  }
}
