/**
 * Finds the drawn facade behind a collision wall. The sim's frontage walls
 * run along the outer sidewalk line, but the building podiums stand up to
 * 1.3 m behind it (BUILDING_SETBACK) minus whatever each level and shopfront
 * bay protrudes (facadeKit extrusions, decided by the mesher's own random
 * stream). Anything pasted on a wall (posters, grime, pipes) has
 * to sit on the surface that is actually drawn, so this indexes the vertical
 * triangles of the podium geometry as 2D segments on a coarse grid and
 * answers "how far behind this point, along this normal, is the facade, and
 * how long is that flat stretch". Render only; a lookup is a handful of
 * segment tests.
 */
import type * as THREE from 'three';

export interface ProbeHit {
  /** Distance from the probe point to the facade along the probe direction (m, may be slightly negative). */
  d: number;
  /** Flat stretch available left and right of the hit point along the facade (m). */
  left: number;
  right: number;
  /** Facade tangent (unit, "right" as seen from the probe side) and outward normal. */
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  /** Vertical extent of the stretch (m). */
  y0: number;
  y1: number;
}

const CELL = 6;
const VERTICAL = 0.35;

export class FacadeProbe {
  /** Segment records: ax, az, bx, bz, nx, nz, y0, y1. */
  private seg: Float32Array;
  private count = 0;
  private cells = new Map<number, number[]>();
  private minX = 0;
  private minZ = 0;
  readonly hit: ProbeHit = { d: 0, left: 0, right: 0, tx: 1, tz: 0, nx: 0, nz: 1, y0: 0, y1: 0 };

  constructor(geometry: THREE.BufferGeometry | null | undefined) {
    const pos = geometry?.getAttribute('position');
    const nor = geometry?.getAttribute('normal');
    const idx = geometry?.getIndex();
    if (!pos || !nor || !idx) {
      this.seg = new Float32Array(0);
      return;
    }
    const tris = idx.count / 3;
    const seg = new Float32Array(tris * 8);
    let n = 0;
    geometry!.computeBoundingBox();
    const bb = geometry!.boundingBox!;
    this.minX = bb.min.x;
    this.minZ = bb.min.z;
    const P = pos.array as ArrayLike<number>;
    const N = nor.array as ArrayLike<number>;
    const I = idx.array as ArrayLike<number>;
    for (let t = 0; t < tris; t++) {
      const i0 = I[t * 3];
      const i1 = I[t * 3 + 1];
      const i2 = I[t * 3 + 2];
      const ny = N[i0 * 3 + 1];
      if (ny > VERTICAL || ny < -VERTICAL) continue;
      // A vertical rectangle's triangle has two vertices on one vertical edge: its footprint is a segment.
      const xs = [P[i0 * 3], P[i1 * 3], P[i2 * 3]];
      const zs = [P[i0 * 3 + 2], P[i1 * 3 + 2], P[i2 * 3 + 2]];
      const ys = [P[i0 * 3 + 1], P[i1 * 3 + 1], P[i2 * 3 + 1]];
      let a = 0;
      let b = 1;
      let best = -1;
      for (let u = 0; u < 3; u++) {
        for (let v = u + 1; v < 3; v++) {
          const d = (xs[u] - xs[v]) ** 2 + (zs[u] - zs[v]) ** 2;
          if (d > best) {
            best = d;
            a = u;
            b = v;
          }
        }
      }
      if (best < 0.04) continue;
      const o = n * 8;
      seg[o] = xs[a];
      seg[o + 1] = zs[a];
      seg[o + 2] = xs[b];
      seg[o + 3] = zs[b];
      seg[o + 4] = N[i0 * 3];
      seg[o + 5] = N[i0 * 3 + 2];
      seg[o + 6] = Math.min(ys[0], ys[1], ys[2]);
      seg[o + 7] = Math.max(ys[0], ys[1], ys[2]);
      const cx0 = Math.floor((Math.min(xs[a], xs[b]) - this.minX) / CELL);
      const cx1 = Math.floor((Math.max(xs[a], xs[b]) - this.minX) / CELL);
      const cz0 = Math.floor((Math.min(zs[a], zs[b]) - this.minZ) / CELL);
      const cz1 = Math.floor((Math.max(zs[a], zs[b]) - this.minZ) / CELL);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cx * 100003 + cz;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(n);
        }
      }
      n++;
    }
    this.seg = seg;
    this.count = n;
  }

  get empty(): boolean {
    return this.count === 0;
  }

  /**
   * From (x, z) at height y, look along (dx, dz) (unit, into the block) for a
   * facade whose outward normal faces back toward the probe. Returns the hit
   * (shared object, copy what you keep) or null within `maxDist` m. The probe
   * starts 0.4 m in front of the point so a facade flush with the wall line
   * still counts.
   */
  probe(x: number, z: number, y: number, dx: number, dz: number, maxDist: number): ProbeHit | null {
    if (!this.count) return null;
    const ox = x - dx * 0.4;
    const oz = z - dz * 0.4;
    const reach = maxDist + 0.4;
    const ex = ox + dx * reach;
    const ez = oz + dz * reach;
    const cx0 = Math.floor((Math.min(ox, ex) - this.minX) / CELL);
    const cx1 = Math.floor((Math.max(ox, ex) - this.minX) / CELL);
    const cz0 = Math.floor((Math.min(oz, ez) - this.minZ) / CELL);
    const cz1 = Math.floor((Math.max(oz, ez) - this.minZ) / CELL);
    const S = this.seg;
    let bestT = Infinity;
    let bestI = -1;
    let bestU = 0;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(cx * 100003 + cz);
        if (!list) continue;
        for (const i of list) {
          const o = i * 8;
          // Facing the probe, and covering its height.
          if (S[o + 4] * dx + S[o + 5] * dz > -0.75) continue;
          if (y < S[o + 6] - 0.05 || y > S[o + 7] + 0.05) continue;
          const ax = S[o];
          const az = S[o + 1];
          const sx = S[o + 2] - ax;
          const sz = S[o + 3] - az;
          const den = dx * sz - dz * sx;
          if (Math.abs(den) < 1e-6) continue;
          const wx = ax - ox;
          const wz = az - oz;
          const t = (wx * sz - wz * sx) / den;
          const u = (wx * dz - wz * dx) / den;
          if (t < 0 || t > reach || u < 0 || u > 1 || t >= bestT) continue;
          bestT = t;
          bestI = i;
          bestU = u;
        }
      }
    }
    if (bestI < 0) return null;
    const o = bestI * 8;
    const sx = S[o + 2] - S[o];
    const sz = S[o + 3] - S[o + 1];
    const len = Math.hypot(sx, sz) || 1;
    const h = this.hit;
    h.d = bestT - 0.4;
    h.nx = S[o + 4];
    h.nz = S[o + 5];
    // "Right" as seen from the probe side is the tangent that makes (t, n) a right handed pair seen from above.
    let tx = sx / len;
    let tz = sz / len;
    if (tx * h.nz - tz * h.nx < 0) {
      tx = -tx;
      tz = -tz;
      bestU = 1 - bestU;
    }
    h.tx = tx;
    h.tz = tz;
    h.left = bestU * len;
    h.right = (1 - bestU) * len;
    h.y0 = S[o + 6];
    h.y1 = S[o + 7];
    return h;
  }
}
