/**
 * Floodlit stone for the monument's landmarks (monument.ts). The landmark
 * draws into the district kit's unlit glow builder so it blooms across the
 * city without a real light, but an unlit face reads the same from every
 * side, which flattened every shape into a bright cut-out. This painter
 * bakes the light into the vertex colours instead: an uplight wash falling
 * off with height from the floods at the foot, and each face shaded by where
 * it points (soffits and the undersides of cornices face the floods and
 * catch the most, tops the least, one key side a little more than the
 * others), so mouldings, flutes, coffers and courses read at night. Every
 * face gets its own vertices (flat shading). Shapes are built in a
 * landmark's frame (u along its yaw, v across, y up); a whole landmark is a
 * few thousand triangles merged into the kit, no extra draw call.
 */
import * as THREE from 'three';
import { clamp01 } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import type { GeoBuilder } from '../geoBuilder';

/** A point in world space (m). */
export interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A surface finish: base colour and brightness on the wash; `glow` ones (flames, beacons, gilding) ignore the wash's falloff. */
export interface Paint {
  color: THREE.Color;
  mul: number;
  glow?: boolean;
}

/** The uplight wash: brightness g0 at y0 (the floods) falling to g1 at y1 (m; HDR before the glow material's x1.6). */
export interface Wash {
  y0: number;
  y1: number;
  g0: number;
  g1: number;
}

/** A landmark's frame: origin (x, z) on its axis, u along `yaw` (sin, cos), v across (-uz, ux). */
export interface Frame {
  x: number;
  z: number;
  yaw: number;
  ux: number;
  uz: number;
}

export const frameAt = (x: number, z: number, yaw: number): Frame => ({ x, z, yaw, ux: Math.sin(yaw), uz: Math.cos(yaw) });

/** The frame moved to (u, v) and turned by `turn` (rad): turn = -PI/2 makes the new u the old v. */
export function subFrame(f: Frame, u: number, v: number, turn = 0): Frame {
  const p = fp(f, u, 0, v);
  return frameAt(p.x, p.z, f.yaw + turn);
}

/** World point at (u, y, v) in frame f. */
export function fp(f: Frame, u: number, y: number, v: number): P3 {
  return { x: f.x + f.ux * u - f.uz * v, y, z: f.z + f.uz * u + f.ux * v };
}

const SHADE = {
  /** Light lost by a face pointing straight up (an uplight only grazes it). */
  top: 0.55,
  /** Light gained by a face pointing straight down (soffits face the floods). */
  soffit: 0.3,
  /** Vertical faces toward the key side are this much brighter, away from it this much darker. */
  key: 0.28,
  /** Wash falloff exponent: above 1 the glow stays near the floods. */
  falloff: 1.5,
} as const;

/** Box faces by letter: U +u, u -u, V +v, v -v, T top, B bottom. */
const BOX_DEFAULT = 'UuVvT';

export class Floodlit {
  private readonly kx: number;
  private readonly kz: number;
  private readonly c = new THREE.Color();

  constructor(
    private readonly gb: GeoBuilder,
    keyYaw: number,
    public wash: Wash,
  ) {
    this.kx = Math.sin(keyYaw);
    this.kz = Math.cos(keyYaw);
  }

  private tone(p: Paint, y: number, nx: number, ny: number, nz: number): THREE.Color {
    let g = p.mul;
    if (!p.glow) {
      const w = this.wash;
      const t = clamp01((y - w.y0) / (w.y1 - w.y0));
      g *= w.g1 + (w.g0 - w.g1) * (1 - t) ** SHADE.falloff;
    }
    g *= ny >= 0 ? 1 - SHADE.top * ny : 1 - SHADE.soffit * ny;
    g *= 1 + SHADE.key * (nx * this.kx + nz * this.kz);
    return this.c.copy(p.color).multiplyScalar(g);
  }

  /** Quad a b c d (a loop), front face on the side of (rx, ry, rz). */
  quad(a: P3, b: P3, c: P3, d: P3, paint: Paint, rx: number, ry: number, rz: number): void {
    // Normal from the diagonals, so a quad with one edge collapsed to a point still works.
    const ex = c.x - a.x;
    const ey = c.y - a.y;
    const ez = c.z - a.z;
    const fx = d.x - b.x;
    const fy = d.y - b.y;
    const fz = d.z - b.z;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    const s = nx * rx + ny * ry + nz * rz < 0 ? -1 / l : 1 / l;
    nx *= s;
    ny *= s;
    nz *= s;
    const gb = this.gb;
    const ia = gb.vertex(a.x, a.y, a.z, nx, ny, nz, 0, 0, this.tone(paint, a.y, nx, ny, nz));
    const ib = gb.vertex(b.x, b.y, b.z, nx, ny, nz, 1, 0, this.tone(paint, b.y, nx, ny, nz));
    const ic = gb.vertex(c.x, c.y, c.z, nx, ny, nz, 1, 1, this.tone(paint, c.y, nx, ny, nz));
    const id = gb.vertex(d.x, d.y, d.z, nx, ny, nz, 0, 1, this.tone(paint, d.y, nx, ny, nz));
    gb.quadFacing(ia, ib, ic, id, nx, ny, nz);
  }

  /**
   * Surface of revolution about (cx, cz): `prof` is [radius, y] from the bottom up (a radius
   * of a regular n-gon's corners, the first corner at angle `phase`), capped on top when the
   * last radius is above 0. Steps in the profile become ledges (up) or soffits (down).
   */
  lathe(cx: number, cz: number, prof: readonly (readonly [number, number])[], n: number, phase: number, paint: Paint, cap = true): void {
    for (let k = 0; k + 1 < prof.length; k++) {
      const [r0, y0] = prof[k];
      const [r1, y1] = prof[k + 1];
      if ((r0 === 0 && r1 === 0) || (r0 === r1 && y0 === y1)) continue;
      // Outward normal of the profile edge in (radial, up): the solid is on the axis side.
      const pr = y1 - y0;
      const py = r0 - r1;
      for (let i = 0; i < n; i++) {
        const a0 = phase + (i / n) * Math.PI * 2;
        const a1 = phase + ((i + 1) / n) * Math.PI * 2;
        const am = (a0 + a1) / 2;
        const s0 = Math.sin(a0);
        const c0 = Math.cos(a0);
        const s1 = Math.sin(a1);
        const c1 = Math.cos(a1);
        this.quad(
          { x: cx + s0 * r0, y: y0, z: cz + c0 * r0 },
          { x: cx + s1 * r0, y: y0, z: cz + c1 * r0 },
          { x: cx + s1 * r1, y: y1, z: cz + c1 * r1 },
          { x: cx + s0 * r1, y: y1, z: cz + c0 * r1 },
          paint,
          Math.sin(am) * pr,
          py,
          Math.cos(am) * pr,
        );
      }
    }
    const [r, y] = prof[prof.length - 1];
    if (!cap || r <= 0) return;
    const gb = this.gb;
    const col = this.tone(paint, y, 0, 1, 0);
    const mid = gb.vertex(cx, y, cz, 0, 1, 0, 0, 0, col);
    const ring: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      ring.push(gb.vertex(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r, 0, 1, 0, 0, 0, col));
    }
    for (let i = 0; i < n; i++) gb.triFacing(mid, ring[i], ring[(i + 1) % n], 0, 1, 0);
  }

  /** Square lathe in frame f: `prof` is [half side, y], faces square to u and v. */
  square(f: Frame, u: number, v: number, prof: readonly (readonly [number, number])[], paint: Paint, cap = true): void {
    const c = fp(f, u, 0, v);
    this.lathe(c.x, c.z, prof.map(([h, y]) => [h * Math.SQRT2, y] as const), 4, f.yaw + Math.PI / 4, paint, cap);
  }

  /** Round lathe (n sides) at (u, v) in frame f. */
  round(f: Frame, u: number, v: number, prof: readonly (readonly [number, number])[], n: number, paint: Paint, cap = true): void {
    const c = fp(f, u, 0, v);
    this.lathe(c.x, c.z, prof, n, f.yaw, paint, cap);
  }

  /** Box u0..u1 x v0..v1 x y0..y1 in frame f with the faces named in `faces` (BOX_DEFAULT: no bottom). */
  box(f: Frame, u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, paint: Paint, faces = BOX_DEFAULT): void {
    const P = (u: number, y: number, v: number) => fp(f, u, y, v);
    const ux = f.ux;
    const uz = f.uz;
    if (faces.includes('U')) this.quad(P(u1, y0, v0), P(u1, y0, v1), P(u1, y1, v1), P(u1, y1, v0), paint, ux, 0, uz);
    if (faces.includes('u')) this.quad(P(u0, y0, v0), P(u0, y0, v1), P(u0, y1, v1), P(u0, y1, v0), paint, -ux, 0, -uz);
    if (faces.includes('V')) this.quad(P(u0, y0, v1), P(u1, y0, v1), P(u1, y1, v1), P(u0, y1, v1), paint, -uz, 0, ux);
    if (faces.includes('v')) this.quad(P(u0, y0, v0), P(u1, y0, v0), P(u1, y1, v0), P(u0, y1, v0), paint, uz, 0, -ux);
    if (faces.includes('T')) this.quad(P(u0, y1, v0), P(u1, y1, v0), P(u1, y1, v1), P(u0, y1, v1), paint, 0, 1, 0);
    if (faces.includes('B')) this.quad(P(u0, y0, v0), P(u1, y0, v0), P(u1, y0, v1), P(u0, y0, v1), paint, 0, -1, 0);
  }

  /** Flat panel on the plane u (facing +u when `sgn` is 1, -u when -1), v0..v1 x y0..y1: plaques, lettering, carving. */
  plate(f: Frame, u: number, sgn: number, v0: number, v1: number, y0: number, y1: number, paint: Paint): void {
    this.quad(fp(f, u, y0, v0), fp(f, u, y0, v1), fp(f, u, y1, v1), fp(f, u, y1, v0), paint, f.ux * sgn, 0, f.uz * sgn);
  }

  /**
   * A convex outline in the frame's v-y plane extruded from u0 to u1: both u faces and the
   * edges. Keystones, archivolt voussoirs, roundels.
   */
  slab(f: Frame, outline: readonly (readonly [number, number])[], u0: number, u1: number, paint: Paint): void {
    let mv = 0;
    let my = 0;
    for (const [v, y] of outline) {
      mv += v / outline.length;
      my += y / outline.length;
    }
    const gb = this.gb;
    for (const [u, sgn] of [[u1, 1], [u0, -1]] as const) {
      const pts = outline.map(([v, y]) => fp(f, u, y, v));
      const nx = f.ux * sgn;
      const nz = f.uz * sgn;
      const c = fp(f, u, my, mv);
      const mid = gb.vertex(c.x, c.y, c.z, nx, 0, nz, 0, 0, this.tone(paint, c.y, nx, 0, nz));
      const ring = pts.map((p) => gb.vertex(p.x, p.y, p.z, nx, 0, nz, 0, 0, this.tone(paint, p.y, nx, 0, nz)));
      for (let i = 0; i < ring.length; i++) gb.triFacing(mid, ring[i], ring[(i + 1) % ring.length], nx, 0, nz);
    }
    for (let i = 0; i < outline.length; i++) {
      const [va, ya] = outline[i];
      const [vb, yb] = outline[(i + 1) % outline.length];
      // Edge normal in (v, y), pointed away from the outline's middle.
      let ev = yb - ya;
      let ey = -(vb - va);
      if (ev * ((va + vb) / 2 - mv) + ey * ((ya + yb) / 2 - my) < 0) {
        ev = -ev;
        ey = -ey;
      }
      this.quad(fp(f, u0, ya, va), fp(f, u1, ya, va), fp(f, u1, yb, vb), fp(f, u0, yb, vb), paint, -f.uz * ev, ey, f.ux * ev);
    }
  }

  /** Square section bar of half width w from a to b (arms, torches). */
  beam(a: P3, b: P3, w: number, paint: Paint): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    // First side axis: horizontal and square to the bar (any horizontal one for a vertical bar).
    let px = -dz;
    let pz = dx;
    let pl = Math.hypot(px, pz);
    if (pl < 1e-6) {
      px = 1;
      pz = 0;
      pl = 1;
    }
    px /= pl;
    pz /= pl;
    // Second side axis: bar x first.
    const qx = (dy * pz) / l;
    const qy = (dz * px - dx * pz) / l;
    const qz = (-dy * px) / l;
    const corner = (o: P3, k: number): P3 => {
      const s = k === 0 || k === 3 ? -w : w;
      const t = k < 2 ? -w : w;
      return { x: o.x + px * s + qx * t, y: o.y + qy * t, z: o.z + pz * s + qz * t };
    };
    const A = [0, 1, 2, 3].map((k) => corner(a, k));
    const B = [0, 1, 2, 3].map((k) => corner(b, k));
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const cz = (a.z + b.z) / 2;
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4;
      const m = { x: (A[k].x + A[k1].x + B[k].x + B[k1].x) / 4 - cx, y: (A[k].y + A[k1].y + B[k].y + B[k1].y) / 4 - cy, z: (A[k].z + A[k1].z + B[k].z + B[k1].z) / 4 - cz };
      this.quad(A[k], A[k1], B[k1], B[k], paint, m.x, m.y, m.z);
    }
    this.quad(A[0], A[1], A[2], A[3], paint, -dx, -dy, -dz);
    this.quad(B[0], B[1], B[2], B[3], paint, dx, dy, dz);
  }

  /**
   * Fluted round shaft about (u, v): `flutes` concave channels (two faces each, so they read
   * as stripes of light), radius r(t) over t = 0..1 from y0 to y1 in `bands` rings (entasis).
   */
  fluted(f: Frame, u: number, v: number, y0: number, y1: number, r: (t: number) => number, flutes: number, bands: number, paint: Paint): void {
    const c = fp(f, u, 0, v);
    const n = flutes * 2;
    const ring = (t: number) => {
      const y = y0 + (y1 - y0) * t;
      const R = r(t);
      const out: P3[] = [];
      for (let i = 0; i < n; i++) {
        const a = f.yaw + (i / n) * Math.PI * 2;
        const rr = i % 2 ? R * 0.92 : R;
        out.push({ x: c.x + Math.sin(a) * rr, y, z: c.z + Math.cos(a) * rr });
      }
      return out;
    };
    let lo = ring(0);
    for (let b = 1; b <= bands; b++) {
      const hi = ring(b / bands);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const am = f.yaw + ((i + 0.5) / n) * Math.PI * 2;
        this.quad(lo[i], lo[j], hi[j], hi[i], paint, Math.sin(am), 0, Math.cos(am));
      }
      lo = hi;
    }
  }

  /**
   * Gilded lettering on a plate at u facing sgn: two lines of word-like runs of letter
   * blocks centred between v0 and v1, each line `h` tall (m). Reads as an inscription.
   */
  lettering(f: Frame, u: number, sgn: number, v0: number, v1: number, yMid: number, h: number, paint: Paint, rng: Rng): void {
    const lines = [yMid + h * 0.8, yMid - h * 0.8];
    const width = v1 - v0;
    for (const y of lines) {
      const letters: [number, number][] = [];
      let at = 0;
      for (;;) {
        const word = rng.int(2, 7);
        const run: [number, number][] = [];
        let w = at;
        for (let k = 0; k < word; k++) {
          const lw = h * rng.range(0.55, 0.8);
          run.push([w, w + lw]);
          w += lw + h * 0.2;
        }
        if (w > width * 0.94) break;
        letters.push(...run);
        at = w + h * 0.45;
      }
      if (!letters.length) continue;
      const used = letters[letters.length - 1][1];
      const off = v0 + (width - used) / 2;
      for (const [a, b] of letters) {
        // Ascend sgn's way along v so the text reads left to right from the side it faces.
        const va = sgn > 0 ? off + a : v1 - (off - v0) - b;
        const vb = sgn > 0 ? off + b : v1 - (off - v0) - a;
        this.plate(f, u, sgn, va, vb, y - h / 2, y + h / 2, paint);
      }
    }
  }

  /** Ring (annulus, n segments) in the frame's v-y plane at u facing sgn: a wreath or roundel. */
  wreath(f: Frame, u: number, sgn: number, v: number, y: number, r0: number, r1: number, n: number, paint: Paint): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      this.quad(
        fp(f, u, y + Math.sin(a0) * r0, v + Math.cos(a0) * r0),
        fp(f, u, y + Math.sin(a1) * r0, v + Math.cos(a1) * r0),
        fp(f, u, y + Math.sin(a1) * r1, v + Math.cos(a1) * r1),
        fp(f, u, y + Math.sin(a0) * r1, v + Math.cos(a0) * r1),
        paint,
        f.ux * sgn,
        0,
        f.uz * sgn,
      );
    }
  }
}

/**
 * A standing bronze figure on (u, v, y) in frame f, facing +u, about 4.8 m tall at scale s:
 * a long coat, a cape behind, a laurel crown, the right arm raising a gilded torch whose flame
 * glows, the left holding a tablet. Reads as a statue silhouette against the sky and up close.
 */
export function statue(L: Floodlit, f: Frame, u: number, v: number, y: number, s: number, bronze: Paint, gold: Paint, flame: Paint): void {
  const g = subFrame(f, u, v);
  const P = (pu: number, py: number, pv: number) => fp(g, pu * s, y + py * s, pv * s);
  const R = (prof: readonly (readonly [number, number])[]) => prof.map(([r, py]) => [r * s, y + py * s] as const);
  // Legs (the feet show under the hem), the coat, the torso and shoulders, neck and head.
  for (const sv of [-1, 1]) L.beam(P(0.08, 0, 0.24 * sv), P(0, 1.6, 0.19 * sv), 0.15 * s, bronze);
  L.round(g, -0.04 * s, 0, R([[0.6, 0.7], [0.66, 0.85], [0.52, 1.9], [0.42, 2.45]]), 10, bronze, false);
  L.round(g, -0.02 * s, 0, R([[0.42, 2.45], [0.5, 3.05], [0.58, 3.42], [0.32, 3.68], [0.14, 3.7]]), 8, bronze, false);
  L.round(g, 0, 0, R([[0.13, 3.66], [0.13, 3.8], [0.24, 3.9], [0.27, 4.1], [0.22, 4.3], [0, 4.42]]), 8, bronze);
  L.round(g, 0, 0, R([[0.27, 4.08], [0.31, 4.16], [0.28, 4.24]]), 10, gold, false);
  // Cape from the shoulders to the calves, drawn both ways (it is a sheet).
  const cape = [P(-0.3, 3.45, -0.52), P(-0.3, 3.45, 0.52), P(-0.72, 0.85, 0.78), P(-0.72, 0.85, -0.78)] as const;
  L.quad(cape[0], cape[1], cape[2], cape[3], bronze, -g.ux, 0, -g.uz);
  L.quad(cape[0], cape[1], cape[2], cape[3], bronze, g.ux, 0, g.uz);
  // Right arm up with the torch; left arm down holding a tablet against the hip.
  L.beam(P(0, 3.42, 0.56), P(0.1, 4.15, 0.74), 0.12 * s, bronze);
  L.beam(P(0.1, 4.15, 0.74), P(0.12, 4.95, 0.8), 0.1 * s, bronze);
  L.beam(P(0.12, 4.8, 0.8), P(0.14, 5.45, 0.82), 0.06 * s, gold);
  L.round(g, 0.14 * s, 0.82 * s, R([[0.05, 5.4], [0.24, 5.62], [0.24, 5.68]]), 8, gold, false);
  L.round(g, 0.14 * s, 0.82 * s, R([[0.2, 5.64], [0.13, 5.95], [0, 6.3]]), 6, flame);
  L.beam(P(0, 3.42, -0.56), P(0.14, 2.75, -0.64), 0.12 * s, bronze);
  L.beam(P(0.14, 2.75, -0.64), P(0.36, 2.35, -0.5), 0.1 * s, bronze);
  L.box(g, 0.3 * s, 0.42 * s, -0.84 * s, -0.2 * s, y + 1.9 * s, y + 2.7 * s, bronze, 'UuVvTB');
}
