/**
 * The scrapyard's fill: scrap mountains over every piece of the region the lines and the set pieces leave (scrapyardLayout.ts),
 * so the yard reads full from any camera and nothing a car can reach is bare ground.
 *
 * A raster of CFG.cell over the region in the yard's chord frame (u along the chord, v off it, unsheared so the rectangles stay
 * rectangles): a cell is taken when it lies outside the ring (or within CFG.fence of it), on a line's corridor (its half width
 * plus CFG.clear), or under a set piece's footprint (the bowls, the deck, the canyon's walls, a machine). The free cells are
 * then cut greedily into rectangles, row by row: each grows along u up to a share of CFG.maxLength drawn per heap, then along v
 * while its whole row is free, up to a share of CFG.maxDepth; one smaller than CFG.minSide across is left as open ground. Each rectangle is a heap: a solid of
 * look `carStack` (drawn as heaped wrecks and crushed cubes, render/districts/scrapyard.ts), its height rising from CFG.low
 * beside a line to CFG.high deep in the yard. Pure and deterministic (the area's own stream for the heights' jitter).
 */
import { CITY } from '../config';
import type { Vec2 } from '../../sim/math';
import { sqrt } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import { distToPolygonEdge, pointInPolygon } from './geom';

const CFG = CITY.districts.scrapyard.fill;

/** A scrap mountain: an oriented box footprint (world corners, counter-clockwise or not), its centre and height (m). */
export interface ScrapHeap {
  x: number;
  z: number;
  /** Unit axis along its length and its two sizes (m). */
  ax: number;
  az: number;
  length: number;
  depth: number;
  height: number;
  poly: Vec2[];
}

/** The raster the yard marks its set pieces into before the heaps fill the rest. */
export class FillRaster {
  readonly cell = CFG.cell;
  readonly cols: number;
  readonly rows: number;
  /** 0 free, 1 taken. */
  readonly taken: Uint8Array;
  private readonly u0: number;
  private readonly v0: number;

  constructor(
    private readonly o: Vec2,
    private readonly U: Vec2,
    private readonly N: Vec2,
    readonly polygon: Vec2[],
  ) {
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of polygon) {
      const u = (p.x - o.x) * U.x + (p.z - o.z) * U.z;
      const v = (p.x - o.x) * N.x + (p.z - o.z) * N.z;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    this.u0 = u0;
    this.v0 = v0;
    this.cols = Math.ceil((u1 - u0) / this.cell) + 1;
    this.rows = Math.ceil((v1 - v0) / this.cell) + 1;
    this.taken = new Uint8Array(this.cols * this.rows);
    // Outside the ring, or too near its fence.
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const p = this.center(i, j);
        if (!pointInPolygon(p.x, p.z, polygon) || distToPolygonEdge(p.x, p.z, polygon) < CFG.fence + this.cell * 0.5) this.taken[j * this.cols + i] = 1;
      }
    }
  }

  /** World point at chord coordinates (u, v). */
  world(u: number, v: number): Vec2 {
    return { x: this.o.x + this.U.x * u + this.N.x * v, z: this.o.z + this.U.z * u + this.N.z * v };
  }

  center(i: number, j: number): Vec2 {
    return this.world(this.u0 + (i + 0.5) * this.cell, this.v0 + (j + 0.5) * this.cell);
  }

  private uv(x: number, z: number): [number, number] {
    return [(x - this.o.x) * this.U.x + (z - this.o.z) * this.U.z, (x - this.o.x) * this.N.x + (z - this.o.z) * this.N.z];
  }

  /** Take every cell whose centre lies within `r` of the segment a-b. */
  segment(a: Vec2, b: Vec2, r: number): void {
    const [au, av] = this.uv(a.x, a.z);
    const [bu, bv] = this.uv(b.x, b.z);
    const i0 = Math.max(0, Math.floor((Math.min(au, bu) - r - this.u0) / this.cell) - 1);
    const i1 = Math.min(this.cols - 1, Math.ceil((Math.max(au, bu) + r - this.u0) / this.cell) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(av, bv) - r - this.v0) / this.cell) - 1);
    const j1 = Math.min(this.rows - 1, Math.ceil((Math.max(av, bv) + r - this.v0) / this.cell) + 1);
    const du = bu - au;
    const dv = bv - av;
    const l2 = du * du + dv * dv;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cu = this.u0 + (i + 0.5) * this.cell;
        const cv = this.v0 + (j + 0.5) * this.cell;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((cu - au) * du + (cv - av) * dv) / l2)) : 0;
        const eu = cu - au - du * t;
        const ev = cv - av - dv * t;
        if (eu * eu + ev * ev <= r * r) this.taken[j * this.cols + i] = 1;
      }
    }
  }

  /** Take every cell along a polyline within `r`. */
  polyline(pts: readonly Vec2[], r: number): void {
    for (let k = 0; k + 1 < pts.length; k++) this.segment(pts[k], pts[k + 1], r);
  }

  /** Take every cell whose centre lies inside the polygon grown by `pad` (m). */
  polygonArea(poly: readonly Vec2[], pad = 0): void {
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of poly) {
      const [u, v] = this.uv(p.x, p.z);
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const ring = poly as Vec2[];
    const i0 = Math.max(0, Math.floor((u0 - pad - this.u0) / this.cell));
    const i1 = Math.min(this.cols - 1, Math.ceil((u1 + pad - this.u0) / this.cell));
    const j0 = Math.max(0, Math.floor((v0 - pad - this.v0) / this.cell));
    const j1 = Math.min(this.rows - 1, Math.ceil((v1 + pad - this.v0) / this.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = this.center(i, j);
        if (pointInPolygon(c.x, c.z, ring) || (pad > 0 && distToPolygonEdge(c.x, c.z, ring) <= pad)) this.taken[j * this.cols + i] = 1;
      }
    }
  }

  /** Take every cell within `r` of a point. */
  circle(c: Vec2, r: number): void {
    this.segment(c, c, r);
  }

  /** Whether the cell under a world point is free. */
  freeAt(x: number, z: number): boolean {
    const [u, v] = this.uv(x, z);
    const i = Math.floor((u - this.u0) / this.cell);
    const j = Math.floor((v - this.v0) / this.cell);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return false;
    return this.taken[j * this.cols + i] === 0;
  }

  /**
   * Cut the free cells into heaps (see the header). `near(x, z)` is the distance (m) from a point to the nearest line, which
   * sets a heap's height; `rng` jitters it.
   */
  heaps(near: (x: number, z: number) => number, rng: Rng): ScrapHeap[] {
    const out: ScrapHeap[] = [];
    const C = this.cell;
    const minK = Math.max(1, Math.ceil(CFG.minSide / C));
    const used = this.taken.slice();
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        if (used[j * this.cols + i]) continue;
        // Grow along u, then along v while the whole row stays free, each heap to a size of its own so the piles read uneven.
        const maxI = Math.max(1, Math.round((CFG.maxLength * (0.4 + 0.6 * rng.next())) / C));
        const maxJ = Math.max(1, Math.round((CFG.maxDepth * (0.45 + 0.55 * rng.next())) / C));
        let w = 0;
        while (w < maxI && i + w < this.cols && !used[j * this.cols + i + w]) w++;
        let h = 1;
        while (h < maxJ && j + h < this.rows) {
          let ok = true;
          for (let k = 0; k < w && ok; k++) ok = !used[(j + h) * this.cols + i + k];
          if (!ok) break;
          h++;
        }
        for (let jj = j; jj < j + h; jj++) for (let ii = i; ii < i + w; ii++) used[jj * this.cols + ii] = 1;
        if (w < minK || h < minK) continue;
        // The rectangle, a little inside its cells so neighbours read as separate piles.
        const inset = 0.35;
        const ua = this.u0 + i * C + inset;
        const ub = this.u0 + (i + w) * C - inset;
        const va = this.v0 + j * C + inset;
        const vb = this.v0 + (j + h) * C - inset;
        const poly = [this.world(ua, va), this.world(ub, va), this.world(ub, vb), this.world(ua, vb)];
        const c = this.world((ua + ub) / 2, (va + vb) / 2);
        const lu = ub - ua;
        const lv = vb - va;
        const along = lu >= lv;
        const dist = near(c.x, c.z);
        const k = Math.max(0, Math.min(1, (dist - 6) / 40));
        const small = Math.min(lu, lv);
        const height = Math.max(CFG.low, Math.min(CFG.low + (CFG.high - CFG.low) * k * k * (3 - 2 * k), 0.55 * small + 1.2)) * (0.85 + 0.3 * rng.next());
        out.push({ x: c.x, z: c.z, ax: along ? this.U.x : this.N.x, az: along ? this.U.z : this.N.z, length: along ? lu : lv, depth: along ? lv : lu, height, poly });
      }
    }
    return out;
  }
}

/** Length of a polyline (m). */
export function polylineLength(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2);
  return s;
}
