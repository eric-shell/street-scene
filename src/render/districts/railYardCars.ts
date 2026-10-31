/**
 * The rail yard's freight cars (render only): box cars, tank cars, hoppers, flat cars, cabooses and autoracks built
 * from the area's 'car' hints into one textured mesh (the side atlas, textures/yardTextures.ts), a solid
 * the length of the sim's railcar wall under it. A car's body follows the ground along its length, so a
 * consist standing on the yard's gentle grade does not float or sink at one end. About 100 to 400 triangles a car;
 * the wheels are skipped on Low.
 */
import * as THREE from 'three';
import type { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import { PLAIN_UV, carTile } from '../textures/yardTextures';
import type { DistrictKit } from './kit';
import { col } from './kit';

/** A car's frame: its centre on the rails, the along (u) and across (v) unit vectors. */
interface CarFrame {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
}

const FRAME = col(0x24262a);
const STEEL = col(0x3a3d43);
const WHEEL = col(0x2c2e33);
const ROOF = col(0x3b3835);
const WOOD = [col(0x8a6a44), col(0x7a5c3a), col(0x9a7a50)];
const CONTAINER = [0x2e6aa0, 0xb04a2a, 0x3a7a4a, 0xc8a02a, 0x6a4a8a];

const at = (F: CarFrame, a: number, c: number): Vec2 => ({ x: F.cx + F.ux * a + F.vx * c, z: F.cz + F.uz * a + F.vz * c });

/** Rail head to the underside of a body (m): the trucks' height. */
const SILL = 0.95;

interface Ctx {
  g: GeoBuilder;
  F: CarFrame;
  /** Ground height under the car at along-offset a (linear between its two ends). */
  ground(a: number): number;
  tint: THREE.Color;
}

const v3 = (c: Ctx, a: number, cc: number, y: number, n: [number, number, number], u: number, v: number, color: THREE.Color): number => {
  const p = at(c.F, a, cc);
  return c.g.vertex(p.x, c.ground(a) + y, p.z, n[0], n[1], n[2], u, v, color);
};

/** A textured side: from a0 to a1 along the car at across-offset cc (normal along sign * v), body from y0 to y1. */
function side(c: Ctx, cc: number, a0: number, a1: number, y0: number, y1: number, tile: ReturnType<typeof carTile>, sign: number): void {
  const n: [number, number, number] = [c.F.vx * sign, 0, c.F.vz * sign];
  const A = v3(c, a0, cc, y0, n, sign > 0 ? tile.u0 : tile.u1, tile.v0, c.tint);
  const B = v3(c, a1, cc, y0, n, sign > 0 ? tile.u1 : tile.u0, tile.v0, c.tint);
  const C = v3(c, a1, cc, y1, n, sign > 0 ? tile.u1 : tile.u0, tile.v1, c.tint);
  const D = v3(c, a0, cc, y1, n, sign > 0 ? tile.u0 : tile.u1, tile.v1, c.tint);
  c.g.quadFacing(A, B, C, D, n[0], n[1], n[2]);
}

/** A plain quad between four (a, c, y) corners with a facing normal. */
function plain(c: Ctx, pts: [number, number, number][], n: [number, number, number], color: THREE.Color): void {
  const ids = pts.map((p) => v3(c, p[0], p[1], p[2], n, PLAIN_UV.u, PLAIN_UV.v, color));
  c.g.quadFacing(ids[0], ids[1], ids[2], ids[3], n[0], n[1], n[2]);
}

/** A plain box over [a0,a1] x [c0,c1] x [y0,y1] (no bottom). */
function box(c: Ctx, a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, color: THREE.Color): void {
  const F = c.F;
  const k = (n: [number, number, number], pts: [number, number, number][]) => plain(c, pts, n, color);
  k([F.vx, 0, F.vz], [[a0, c1, y0], [a1, c1, y0], [a1, c1, y1], [a0, c1, y1]]);
  k([-F.vx, 0, -F.vz], [[a1, c0, y0], [a0, c0, y0], [a0, c0, y1], [a1, c0, y1]]);
  k([F.ux, 0, F.uz], [[a1, c0, y0], [a1, c1, y0], [a1, c1, y1], [a1, c0, y1]]);
  k([-F.ux, 0, -F.uz], [[a0, c1, y0], [a0, c0, y0], [a0, c0, y1], [a0, c1, y1]]);
  k([0, 1, 0], [[a0, c0, y1], [a1, c0, y1], [a1, c1, y1], [a0, c1, y1]]);
}

/** A wheel disc facing out (sign * v) at across-offset cc. */
function disc(c: Ctx, a: number, cc: number, yc: number, r: number, sign: number): void {
  const n: [number, number, number] = [c.F.vx * sign, 0, c.F.vz * sign];
  const mid = v3(c, a, cc, yc, n, PLAIN_UV.u, PLAIN_UV.v, WHEEL);
  const N = 8;
  const ring: number[] = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const p = at(c.F, a + Math.cos(th) * r, cc);
    ring.push(c.g.vertex(p.x, c.ground(a) + yc + Math.sin(th) * r, p.z, n[0], n[1], n[2], PLAIN_UV.u, PLAIN_UV.v, WHEEL));
  }
  for (let i = 0; i < N; i++) c.g.triFacing(mid, ring[i], ring[(i + 1) % N], n[0], n[1], n[2]);
}

/** A truck (bogie): a frame under the body and its wheels on both sides. */
function truck(c: Ctx, a: number, wheels: boolean): void {
  box(c, a - 1.3, a + 1.3, -1.0, 1.0, SILL - 0.5, SILL - 0.08, FRAME);
  if (!wheels) return;
  for (const da of [-0.95, 0.95]) for (const s of [-1, 1]) disc(c, a + da, s * 1.02, 0.46, 0.46, s);
}

/** Add one car at `centre` along (ux, uz) with across (vx, vz), of `kind` (0 box car, 1 tank, 2 hopper, 3 flat car, 4 caboose, 5 autorack), `tex` livery, `len` m. */
export function addCar(kit: DistrictKit, g: GeoBuilder, glow: GeoBuilder, centre: Vec2, ux: number, uz: number, vx: number, vz: number, len: number, kind: number, tex: number, wheels: boolean): void {
  const F: CarFrame = { cx: centre.x, cz: centre.z, ux, uz, vx, vz };
  const pa = at(F, -len / 2, 0);
  const pb = at(F, len / 2, 0);
  const ha = kit.h(pa.x, pa.z);
  const hb = kit.h(pb.x, pb.z);
  // Along the car the ground is the line through its ends: the body rides straight on its trucks.
  const ground = (a: number) => ha + ((hb - ha) * (a + len / 2)) / len;
  const tint = new THREE.Color(1, 1, 1).multiplyScalar(0.85 + ((tex * 37 + kind * 11) % 7) * 0.035);
  const c: Ctx = { g, F, ground, tint };
  const w = 3.05 / 2;
  const tile = carTile(kind === 5 ? 0 : kind, tex);
  const hh = [3.7, 3.6, 3.5, 1.4, 3.9, 4.6][kind];
  const body = SILL;
  const top = hh + 0.05;
  const ends = len / 2;
  // Underframe, trucks and couplers.
  box(c, -ends, ends, -0.55, 0.55, SILL - 0.32, SILL, FRAME);
  truck(c, -(ends - 2.3), wheels);
  truck(c, ends - 2.3, wheels);
  if (wheels) for (const s of [-1, 1]) box(c, s * ends, s * (ends + 0.5), -0.14, 0.14, SILL + 0.12, SILL + 0.3, STEEL);
  const plainCol = (hex: number, m = 1) => col(hex, m);
  if (kind === 5) {
    // Autorack: a tall box, its lower sides the livery, the upper half the dark ventilated panels, a flat roof.
    const e = ends - 0.05;
    const mid = body + 1.7;
    side(c, w, -e, e, body, mid, tile, 1);
    side(c, -w, -e, e, body, mid, tile, -1);
    plain(c, [[-e, w, mid], [e, w, mid], [e, w, top], [-e, w, top]], [vx, 0, vz], plainCol(0x34383e));
    plain(c, [[e, -w, mid], [-e, -w, mid], [-e, -w, top], [e, -w, top]], [-vx, 0, -vz], plainCol(0x34383e));
    for (const s of [-1, 1]) plain(c, s > 0 ? [[e, -w, body], [e, w, body], [e, w, top], [e, -w, top]] : [[-e, w, body], [-e, -w, body], [-e, -w, top], [-e, w, top]], [s * ux, 0, s * uz], plainCol(0x2e3136));
    plain(c, [[-e, -w, top], [e, -w, top], [e, w, top], [-e, w, top]], [0, 1, 0], ROOF);
  } else if (kind === 0 || kind === 4) {
    // Box car and caboose: a textured box with a hip roof.
    const e = kind === 4 ? ends - 0.5 : ends - 0.05;
    side(c, w, -e, e, body, top, tile, 1);
    side(c, -w, -e, e, body, top, tile, -1);
    plain(c, [[e, -w, body], [e, w, body], [e, w, top], [e, -w, top]], [ux, 0, uz], plainCol(kind === 4 ? 0x7a2a22 : 0x4a3a30));
    plain(c, [[-e, w, body], [-e, -w, body], [-e, -w, top], [-e, w, top]], [-ux, 0, -uz], plainCol(kind === 4 ? 0x7a2a22 : 0x4a3a30));
    const ridge = top + 0.2;
    plain(c, [[-e, w, top], [e, w, top], [e, 0, ridge], [-e, 0, ridge]], [vx * 0.3, 0.95, vz * 0.3], ROOF);
    plain(c, [[e, -w, top], [-e, -w, top], [-e, 0, ridge], [e, 0, ridge]], [-vx * 0.3, 0.95, -vz * 0.3], ROOF);
    if (kind === 4) {
      // The cupola with its lamps, and the platforms at both ends.
      box(c, -0.9, 0.9, -0.95, 0.95, ridge - 0.05, ridge + 0.85, plainCol(0x7a2a22));
      for (const s of [-1, 1]) {
        const p0 = at(F, -0.6, s * 0.97);
        const p1 = at(F, 0.6, s * 0.97);
        const y0 = ground(0) + ridge + 0.25;
        const i0 = glow.vertex(p0.x, y0, p0.z, vx * s, 0, vz * s, 0, 0, col(0xffd890, 2.4));
        const i1 = glow.vertex(p1.x, y0, p1.z, vx * s, 0, vz * s, 0, 0, col(0xffd890, 2.4));
        const i2 = glow.vertex(p1.x, y0 + 0.4, p1.z, vx * s, 0, vz * s, 0, 0, col(0xffd890, 2.4));
        const i3 = glow.vertex(p0.x, y0 + 0.4, p0.z, vx * s, 0, vz * s, 0, 0, col(0xffd890, 2.4));
        glow.quadFacing(i0, i1, i2, i3, vx * s, 0, vz * s);
      }
      for (const s of [-1, 1]) box(c, s * (ends - 0.5), s * ends, -w, w, body - 0.1, body + 0.05, FRAME);
    }
  } else if (kind === 1) {
    // Tank car: a cylinder on a center sill, domed ends faked with a ring of the same radius shrunk, a walkway and a dome.
    const R = 1.5;
    const yc = body + 1.6;
    const e = ends - 0.6;
    const N = 14;
    const ring = (a: number, r: number) => Array.from({ length: N }, (_, i) => {
      const th = (i / N) * Math.PI * 2;
      return { a, cc: Math.cos(th) * r, y: yc + Math.sin(th) * r, th };
    });
    const r0 = ring(-e, R);
    const r1 = ring(e, R);
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const mid = (r0[i].th + r0[j].th) / 2;
      const n: [number, number, number] = [vx * Math.cos(mid), Math.sin(mid), vz * Math.cos(mid)];
      const sgn = Math.cos(mid) >= 0 ? 1 : -1;
      const vv = (th: number) => tile.v0 + ((tile.v1 - tile.v0) * (Math.sin(th) + 1)) / 2;
      const uA = sgn > 0 ? tile.u0 : tile.u1;
      const uB = sgn > 0 ? tile.u1 : tile.u0;
      const q = [
        v3(c, r0[i].a, r0[i].cc, r0[i].y, n, uA, vv(r0[i].th), tint),
        v3(c, r1[i].a, r1[i].cc, r1[i].y, n, uB, vv(r0[i].th), tint),
        v3(c, r1[j].a, r1[j].cc, r1[j].y, n, uB, vv(r0[j].th), tint),
        v3(c, r0[j].a, r0[j].cc, r0[j].y, n, uA, vv(r0[j].th), tint),
      ];
      c.g.quadFacing(q[0], q[1], q[2], q[3], n[0], n[1], n[2]);
    }
    for (const s of [-1, 1]) {
      const rr = ring(s * e, R);
      const apex = v3(c, s * (e + 0.55), 0, yc, [s * ux, 0, s * uz], PLAIN_UV.u, PLAIN_UV.v, STEEL);
      const ids = rr.map((p) => v3(c, p.a, p.cc, p.y, [s * ux, 0, s * uz], PLAIN_UV.u, PLAIN_UV.v, STEEL));
      for (let i = 0; i < N; i++) c.g.triFacing(apex, s > 0 ? ids[i] : ids[(i + 1) % N], s > 0 ? ids[(i + 1) % N] : ids[i], s * ux, 0, s * uz);
    }
    box(c, -e, e, -0.18, 0.18, yc + R, yc + R + 0.1, STEEL);
    box(c, -0.5, 0.5, -0.5, 0.5, yc + R, yc + R + 0.55, STEEL);
    box(c, -e + 1, e - 1, -0.9, 0.9, body - 0.1, body + 0.32, FRAME);
  } else if (kind === 2) {
    // Hopper: a ribbed box over two sloped hoppers.
    const e = ends - 0.2;
    const mid = body + 1.0;
    side(c, w, -e, e, mid, top, tile, 1);
    side(c, -w, -e, e, mid, top, tile, -1);
    plain(c, [[e, -w, mid], [e, w, mid], [e, w, top], [e, -w, top]], [ux, 0, uz], plainCol(0x44464a));
    plain(c, [[-e, w, mid], [-e, -w, mid], [-e, -w, top], [-e, w, top]], [-ux, 0, -uz], plainCol(0x44464a));
    plain(c, [[-e, -w, top], [e, -w, top], [e, w, top], [-e, w, top]], [0, 1, 0], ROOF);
    for (const s of [-1, 1]) {
      const a0 = s * 0.2;
      const a1 = s * (e - 0.5);
      const lo = Math.min(a0, a1);
      const hi = Math.max(a0, a1);
      plain(c, [[lo, w, mid], [hi, w, mid], [hi - 1.0, 0.45, body + 0.1], [lo + 1.0, 0.45, body + 0.1]], [vx * 0.5, -0.3, vz * 0.5], FRAME);
      plain(c, [[hi, -w, mid], [lo, -w, mid], [lo + 1.0, -0.45, body + 0.1], [hi - 1.0, -0.45, body + 0.1]], [-vx * 0.5, -0.3, -vz * 0.5], FRAME);
    }
  } else {
    // Flat car: a deck on its sill and, on three of four, a load.
    box(c, -ends + 0.05, ends - 0.05, -w, w, body - 0.05, body + 0.3, col(0x4a4136));
    const load = tex % 4;
    if (load === 1) {
      for (let k = 0; k < 3; k++) {
        const a0 = -ends + 1.2 + k * ((len - 2.4) / 3);
        box(c, a0, a0 + (len - 2.4) / 3 - 0.3, -1.2, 1.2, body + 0.3, body + 1.15, WOOD[k % 3]);
      }
    } else if (load === 2) {
      box(c, -ends + 1.5, ends - 1.5, -1.2, 1.2, body + 0.3, body + 1.6, col(CONTAINER[(tex >> 2) % CONTAINER.length]));
    } else if (load === 3) {
      for (let k = 0; k < 4; k++) box(c, -ends + 1.4 + k * 3.5, -ends + 1.4 + k * 3.5 + 3, -w + 0.3, w - 0.3, body + 0.3, body + 0.6 + (k % 2) * 0.6, col(0x5a5f66));
    }
    for (const s of [-1, 1]) for (const a of [-ends + 0.4, 0, ends - 0.4]) box(c, a - 0.06, a + 0.06, s * w - 0.06, s * w + 0.06, body + 0.3, body + 0.9, STEEL);
  }
}

/** The car mesh material: the side atlas tinted by vertex colors, a share of it emissive (the floods wash the cars' sides, which the scene's few real lights never reach). */
export function carMaterial(kit: DistrictKit, atlas: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: atlas, vertexColors: true, roughness: 0.78, metalness: 0.15, envMapIntensity: 0.4, emissive: 0xffe2c0, emissiveMap: atlas, emissiveIntensity: 0.22 });
  // The glow takes the vertex colours too, so the plain parts (frames, roofs, wheels on the atlas's white swatch) stay their dark selves.
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor.rgb;');
  };
  return kit.track(m);
}
