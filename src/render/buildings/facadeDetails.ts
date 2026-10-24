/**
 * Details bolted to a building's walls: Victorian bay windows, fire escapes,
 * balconies, window eyebrows and the deco fin over a front parapet. Each takes
 * the building's local frame (`Frame`) and appends to the merged builders in
 * `Out`; fire escapes and balconies read the outline face by index
 * (`faceFrame`), so they follow rounded and stepped footprints. Fire escapes
 * are the only dressing with their own draw call (alpha tested atlas
 * texture); the rest merge into the trim and neon builders. Render only.
 */
import * as THREE from 'three';
import { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { BLD, ZERO, Frame, edgeNormal, boxOutline, lbox, cap } from './buildingKit';
import type { Skin, Out } from './buildingKit';

/** Victorian bay window: three facade faces stepping out of the wall, capped top and bottom. */
export function bayWindow(o: Out, F: Frame, s: Skin, cx: number, z: number, w: number, d: number, yb: number, yt: number, vRef: number, street: number, trim: THREE.Color): void {
  const pts: Vec2[] = [
    { x: cx - w / 2, z },
    { x: cx - w / 2 + d, z: z - d },
    { x: cx + w / 2 - d, z: z - d },
    { x: cx + w / 2, z },
  ];
  for (let i = 0; i < 3; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const n = edgeNormal(p, q);
    const nx = F.NX(n.x, n.z);
    const nz = F.NZ(n.x, n.z);
    const u0 = i;
    const v0 = (yb - vRef) / s.floor;
    const v1 = (yt - vRef) / s.floor;
    const a = o.shell.v(F.X(p.x, p.z), yb, F.Z(p.x, p.z), nx, 0, nz, u0, v0, s, ZERO, yb - street);
    const bb = o.shell.v(F.X(q.x, q.z), yb, F.Z(q.x, q.z), nx, 0, nz, u0 + 1, v0, s, ZERO, yb - street);
    const c = o.shell.v(F.X(q.x, q.z), yt, F.Z(q.x, q.z), nx, 0, nz, u0 + 1, v1, s, ZERO, yt - street);
    const dd = o.shell.v(F.X(p.x, p.z), yt, F.Z(p.x, p.z), nx, 0, nz, u0, v1, s, ZERO, yt - street);
    o.shell.quadFacing(a, bb, c, dd, nx, 0, nz);
  }
  cap(o.trim, F, pts, yt + 0.25, trim);
  cap(o.trim, F, pts, yb, trim, true);
  // Skirt band so the top cap reads as a thick ledge.
  for (let i = 0; i < 3; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const n = edgeNormal(p, q);
    const nx = F.NX(n.x, n.z);
    const nz = F.NZ(n.x, n.z);
    const a = o.trim.vertex(F.X(p.x, p.z), yt, F.Z(p.x, p.z), nx, 0, nz, 0, 0, trim);
    const bb = o.trim.vertex(F.X(q.x, q.z), yt, F.Z(q.x, q.z), nx, 0, nz, 0, 0, trim);
    const c = o.trim.vertex(F.X(q.x, q.z), yt + 0.25, F.Z(q.x, q.z), nx, 0, nz, 0, 0, trim);
    const dd = o.trim.vertex(F.X(p.x, p.z), yt + 0.25, F.Z(p.x, p.z), nx, 0, nz, 0, 0, trim);
    o.trim.quadFacing(a, bb, c, dd, nx, 0, nz);
  }
}

/** Local frame of a base face: start point, direction along it, outward normal, length. */
function faceFrame(i: number, hw: number, hd: number): { p: Vec2; u: Vec2; n: Vec2; len: number } {
  const o = boxOutline(-hw, hw, -hd, hd);
  const p = o[i];
  const q = o[(i + 1) % 4];
  const len = Math.hypot(q.x - p.x, q.z - p.z);
  return { p, u: { x: (q.x - p.x) / len, z: (q.z - p.z) / len }, n: edgeNormal(p, q), len };
}

/** NYC fire escapes on a face: platforms with railings at every floor, stairs between, a drop ladder. */
export function fireEscapes(o: Out, F: Frame, face: number, hw: number, hd: number, y0: number, floors: number, fh: number, bay: number, rng: Rng, at?: number): void {
  const ff = faceFrame(face, hw, hd);
  const cols = at !== undefined ? 1 : Math.min(2, Math.max(1, Math.floor(ff.len / BLD.escapeEvery)));
  const W = Math.max(2.2, Math.min(2.9, bay * 1.1));
  const D = 1.05;
  const P = (s: number, out: number): [number, number] => {
    const lx = ff.p.x + ff.u.x * s + ff.n.x * out;
    const lz = ff.p.z + ff.u.z * s + ff.n.z * out;
    return [F.X(lx, lz), F.Z(lx, lz)];
  };
  const nx = F.NX(ff.n.x, ff.n.z);
  const nz = F.NZ(ff.n.x, ff.n.z);
  const ux = F.NX(ff.u.x, ff.u.z);
  const uz = F.NZ(ff.u.x, ff.u.z);
  const quad = (pts: [number, number, number][], uv: [number, number][], n: [number, number, number]) => {
    const ids = pts.map((p, k) => o.escapes.vertex(p[0], p[1], p[2], n[0], n[1], n[2], uv[k][0], uv[k][1]));
    o.escapes.quadFacing(ids[0], ids[1], ids[2], ids[3], n[0], n[1], n[2]);
  };
  for (let c = 0; c < cols; c++) {
    let s0: number;
    if (at !== undefined) {
      // `at` is a local x; the front face runs along +x from -hw.
      s0 = at + hw - W / 2;
    } else {
      const slot = ff.len / cols;
      s0 = slot * c + (slot - W) / 2 + rng.range(-0.6, 0.6);
    }
    s0 = Math.max(0.3, Math.min(ff.len - W - 0.3, s0));
    const s1 = s0 + W;
    for (let k = 0; k < floors; k++) {
      const y = y0 + k * fh;
      const [ax, az] = P(s0, 0.02);
      const [bx, bz] = P(s1, 0.02);
      const [cx, cz] = P(s1, D);
      const [dx, dz] = P(s0, D);
      const uw = W / 2;
      // Platform grating (texture bottom half).
      quad([[ax, y, az], [bx, y, bz], [cx, y, cz], [dx, y, dz]], [[0, 0], [uw, 0], [uw, 0.5], [0, 0.5]], [0, 1, 0]);
      // Front and side railings (texture top half).
      quad([[dx, y, dz], [cx, y, cz], [cx, y + 0.95, cz], [dx, y + 0.95, dz]], [[0, 0.5], [uw, 0.5], [uw, 1], [0, 1]], [nx, 0, nz]);
      quad([[ax, y, az], [dx, y, dz], [dx, y + 0.95, dz], [ax, y + 0.95, az]], [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]], [-ux, 0, -uz]);
      quad([[bx, y, bz], [cx, y, cz], [cx, y + 0.95, cz], [bx, y + 0.95, bz]], [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]], [ux, 0, uz]);
      // Stair up to the next platform.
      if (k < floors - 1) {
        const flip = k % 2 === 0;
        const sa = flip ? s0 + 0.25 : s1 - 0.25;
        const sb = flip ? s1 - 0.6 : s0 + 0.6;
        const [p0x, p0z] = P(sa, 0.45);
        const [p1x, p1z] = P(sb, 0.45);
        const [p2x, p2z] = P(sb, D - 0.05);
        const [p3x, p3z] = P(sa, D - 0.05);
        const len = Math.hypot(sb - sa, fh);
        quad([[p0x, y, p0z], [p1x, y + fh, p1z], [p2x, y + fh, p2z], [p3x, y, p3z]], [[0, 0], [len / 2, 0], [len / 2, 0.5], [0, 0.5]], [0, 0.7, 0]);
      }
    }
    // Drop ladder below the lowest platform.
    const [lx0, lz0] = P(s0 + 0.3, D - 0.1);
    const [lx1, lz1] = P(s0 + 0.8, D - 0.1);
    quad([[lx0, y0 - 2.2, lz0], [lx1, y0 - 2.2, lz1], [lx1, y0, lz1], [lx0, y0, lz0]], [[0, 0.5], [0.25, 0.5], [0.25, 1], [0, 1]], [nx, 0, nz]);
  }
}

/** Balcony slab (and glass rail) on base face i at height y. */
export function balcony(o: Out, F: Frame, face: number, hw: number, hd: number, y: number, depth: number, slab: THREE.Color, rail: THREE.Color | null): void {
  const ff = faceFrame(face, hw, hd);
  const s0 = 0.3;
  const s1 = ff.len - 0.3;
  // Express as a local box: corners from the face frame.
  const pts = [
    { x: ff.p.x + ff.u.x * s0, z: ff.p.z + ff.u.z * s0 },
    { x: ff.p.x + ff.u.x * s1 + ff.n.x * depth, z: ff.p.z + ff.u.z * s1 + ff.n.z * depth },
  ];
  const x0 = Math.min(pts[0].x, pts[1].x);
  const x1 = Math.max(pts[0].x, pts[1].x);
  const z0 = Math.min(pts[0].z, pts[1].z);
  const z1 = Math.max(pts[0].z, pts[1].z);
  lbox(o.trim, F, x0, x1, z0, z1, y - 0.1, y + 0.1, slab);
  if (rail) {
    const ox = ff.n.x * (depth - 0.05);
    const oz = ff.n.z * (depth - 0.05);
    const a = { x: ff.p.x + ff.u.x * s0 + ox, z: ff.p.z + ff.u.z * s0 + oz };
    const b = { x: ff.p.x + ff.u.x * s1 + ox, z: ff.p.z + ff.u.z * s1 + oz };
    lbox(o.trim, F, Math.min(a.x, b.x) - 0.03, Math.max(a.x, b.x) + 0.03, Math.min(a.z, b.z) - 0.03, Math.max(a.z, b.z) + 0.03, y + 0.1, y + 1.05, rail, false);
  }
}

/** Eyebrow sun shade over a floor's windows on base face i (skips rounded corner zones). */
export function eyebrow(o: Out, F: Frame, face: number, hw: number, hd: number, r: number, y: number, color: THREE.Color): void {
  const ff = faceFrame(face, hw, hd);
  const s0 = r + 0.2;
  const s1 = ff.len - r - 0.2;
  if (s1 - s0 < 1) return;
  const a = { x: ff.p.x + ff.u.x * s0, z: ff.p.z + ff.u.z * s0 };
  const b = { x: ff.p.x + ff.u.x * s1 + ff.n.x * 0.6, z: ff.p.z + ff.u.z * s1 + ff.n.z * 0.6 };
  lbox(o.trim, F, Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.z, b.z), Math.max(a.z, b.z), y, y + 0.1, color);
}

/** Deco fin: a vertical slab rising over the front parapet with a neon edge. */
export function fin(o: Out, F: Frame, hw: number, hd: number, y: number, h: number, color: THREE.Color, neon: THREE.Color): void {
  const x = 0;
  lbox(o.trim, F, x - 0.3, x + 0.3, -hd - 0.4, -hd + 2.2, y - 2, y + h, color);
  lbox(o.neon, F, x - 0.06, x + 0.06, -hd - 0.48, -hd - 0.36, y - 1.6, y + h - 0.2, neon, false);
  void hw;
}
