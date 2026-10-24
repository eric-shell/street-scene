/**
 * What sits on top of a building: the crowns and roofs the styles pick from
 * (deco spires, glass tower pyramids and slants, mansards, Spanish tile hips,
 * chimneys) and the rooftop clutter on them (water towers, AC units and
 * bulkheads, masts, aviation lights, lit billboards). Crown surfaces are shell
 * facets so the floodlights and facade glow light them; the clutter goes into
 * the merged roof builders. Every random choice draws from the building's own
 * `Rng`, so splitting the mesher across modules never reorders a stream.
 * Render only.
 */
import * as THREE from 'three';
import { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { BILLBOARD_COLS, BILLBOARD_ROWS } from './facadeAtlas';
import { BLD, DETAIL, NO_GLOW, wash, Frame, boxOutline, lbox, cap, facet, slopeHint, shellFacet, cornice, colorOf } from './buildingKit';
import type { Detail, Skin, Out, P3 } from './buildingKit';

// ---------------------------------------------------------------------------
// Rooftop clutter
// ---------------------------------------------------------------------------

export function waterTower(o: Out, x: number, z: number, y: number, rng: Rng): void {
  const r = rng.range(1.5, 2.2);
  const legH = rng.range(2.4, 3.4);
  const tankH = rng.range(3, 4);
  const wood = colorOf(0x5a3f2c, rng.range(0.75, 1.15));
  const steel = colorOf(0x1d1e22);
  const seg = 10;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const lx = x + Math.cos(a) * r * 0.75;
    const lz = z + Math.sin(a) * r * 0.75;
    boxW(o.roofs, lx, lz, 0.1, y, y + legH, steel);
  }
  const y0 = y + legH;
  const y1 = y0 + tankH;
  const ring: number[] = [];
  for (let s = 0; s <= seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    ring.push(o.roofs.vertex(x + c * r, y0, z + sn * r, c, 0, sn, 0, 0, wood), o.roofs.vertex(x + c * r, y1, z + sn * r, c, 0, sn, 0, 0, wood));
  }
  for (let s = 0; s < seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    o.roofs.quadFacing(ring[s * 2], ring[s * 2 + 2], ring[s * 2 + 3], ring[s * 2 + 1], Math.cos(a), 0, Math.sin(a));
  }
  // Conical roof.
  const apex = o.roofs.vertex(x, y1 + r * 0.55, z, 0, 1, 0, 0, 0, steel);
  for (let s = 0; s < seg; s++) {
    const a0 = (s / seg) * Math.PI * 2;
    const a1 = ((s + 1) / seg) * Math.PI * 2;
    const p = o.roofs.vertex(x + Math.cos(a0) * (r + 0.1), y1, z + Math.sin(a0) * (r + 0.1), Math.cos(a0) * 0.6, 0.8, Math.sin(a0) * 0.6, 0, 0, steel);
    const q = o.roofs.vertex(x + Math.cos(a1) * (r + 0.1), y1, z + Math.sin(a1) * (r + 0.1), Math.cos(a1) * 0.6, 0.8, Math.sin(a1) * 0.6, 0, 0, steel);
    o.roofs.triFacing(p, q, apex, Math.cos((a0 + a1) / 2), 0.8, Math.sin((a0 + a1) / 2));
  }
}

/** World axis box (posts, masts). */
function boxW(gb: GeoBuilder, x: number, z: number, r: number, y0: number, y1: number, color: THREE.Color): void {
  const F = new Frame(x, z, 0);
  lbox(gb, F, -r, r, -r, r, y0, y1, color, false);
}

export function chimney(o: Out, F: Frame, x: number, z: number, y: number, color: THREE.Color): void {
  lbox(o.roofs, F, x - 0.35, x + 0.35, z - 0.35, z + 0.35, y - 0.2, y + 1.4, color, false);
}

/** Thin pointed spire over a deco crown (shell facets so the floods light it). */
export function spire(o: Out, F: Frame, cx: number, cz: number, r: number, y0: number, y1: number, skin: Skin, street: number, flood: THREE.Color | null): void {
  const s: Skin = { ...skin, lit: 0 };
  const glow = flood ? wash(flood, y0, 1.6, y1, 0.6) : NO_GLOW;
  const base = boxOutline(cx - r, cx + r, cz - r, cz + r);
  const apex: [number, number, number] = [F.X(cx, cz), y1, F.Z(cx, cz)];
  for (let i = 0; i < 4; i++) {
    const p = base[i];
    const q = base[(i + 1) % 4];
    shellFacet(o, s, [[F.X(p.x, p.z), y0, F.Z(p.x, p.z)], [F.X(q.x, q.z), y0, F.Z(q.x, q.z)], apex], [[0, 0.3], [1, 0.3], [0.5, 0.35]], street, glow, slopeHint(F, p, q));
  }
}

/** Pyramid crown (or a whole pyramid landmark) with the facade running up its faces. */
export function pyramid(o: Out, F: Frame, outline: Vec2[], y0: number, y1: number, skin: Skin, street: number): void {
  const cx = (outline[0].x + outline[2].x) / 2;
  const cz = (outline[0].z + outline[2].z) / 2;
  const apex: [number, number, number] = [F.X(cx, cz), y1, F.Z(cx, cz)];
  const v0 = 0;
  const v1 = (y1 - y0) / skin.floor;
  for (let i = 0; i < 4; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % 4];
    const mods = Math.max(1, Math.round(Math.hypot(q.x - p.x, q.z - p.z) / skin.bay));
    shellFacet(o, { ...skin, lit: skin.lit * 0.6 }, [[F.X(p.x, p.z), y0, F.Z(p.x, p.z)], [F.X(q.x, q.z), y0, F.Z(q.x, q.z)], apex], [[0, v0], [mods, v0], [mods / 2, v1]], street, NO_GLOW, slopeHint(F, p, q));
  }
}

/** Slanted top: back wall and triangular sides rise from the front edge to height h at the back. */
export function wedge(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, skin: Skin, vRef: number, street: number, rng: Rng): void {
  const v = (yy: number) => (yy - vRef) / skin.floor;
  const mods = (a: number) => Math.max(1, Math.round(a / skin.bay));
  const u0 = rng.int(0, 7);
  const out = (nx: number, nz: number): P3 => [F.NX(nx, nz), 0, F.NZ(nx, nz)];
  // Back wall.
  shellFacet(o, skin, [[F.X(x1, z1), y, F.Z(x1, z1)], [F.X(x0, z1), y, F.Z(x0, z1)], [F.X(x0, z1), y + h, F.Z(x0, z1)], [F.X(x1, z1), y + h, F.Z(x1, z1)]], [[u0, v(y)], [u0 + mods(x1 - x0), v(y)], [u0 + mods(x1 - x0), v(y + h)], [u0, v(y + h)]], street, NO_GLOW, out(0, 1));
  const md = mods(z1 - z0);
  shellFacet(o, skin, [[F.X(x1, z0), y, F.Z(x1, z0)], [F.X(x1, z1), y, F.Z(x1, z1)], [F.X(x1, z1), y + h, F.Z(x1, z1)]], [[0, v(y)], [md, v(y)], [md, v(y + h)]], street, NO_GLOW, out(1, 0));
  shellFacet(o, skin, [[F.X(x0, z1), y, F.Z(x0, z1)], [F.X(x0, z0), y, F.Z(x0, z0)], [F.X(x0, z1), y + h, F.Z(x0, z1)]], [[0, v(y)], [md, v(y)], [0, v(y + h)]], street, NO_GLOW, out(-1, 0));
  facet(o.roofs, [[F.X(x0, z0), y, F.Z(x0, z0)], [F.X(x1, z0), y, F.Z(x1, z0)], [F.X(x1, z1), y + h, F.Z(x1, z1)], [F.X(x0, z1), y + h, F.Z(x0, z1)]], colorOf(0x30343a));
}

/** Second Empire mansard: four sloped faces with dormers, flat top. */
export function mansard(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, skin: Skin, street: number, rng: Rng): void {
  const inset = Math.min(1.5, Math.min(x1 - x0, z1 - z0) * 0.15);
  const lo = boxOutline(x0, x1, z0, z1);
  const hi = boxOutline(x0 + inset, x1 - inset, z0 + inset, z1 - inset);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mods = Math.max(1, Math.round(Math.hypot(lo[j].x - lo[i].x, lo[j].z - lo[i].z) / skin.bay));
    const u0 = rng.int(0, 7);
    shellFacet(
      o,
      skin,
      [
        [F.X(lo[i].x, lo[i].z), y, F.Z(lo[i].x, lo[i].z)],
        [F.X(lo[j].x, lo[j].z), y, F.Z(lo[j].x, lo[j].z)],
        [F.X(hi[j].x, hi[j].z), y + h, F.Z(hi[j].x, hi[j].z)],
        [F.X(hi[i].x, hi[i].z), y + h, F.Z(hi[i].x, hi[i].z)],
      ],
      [
        [u0, 0],
        [u0 + mods, 0],
        [u0 + mods, 1],
        [u0, 1],
      ],
      street,
      NO_GLOW,
      slopeHint(F, lo[i], lo[j]),
    );
  }
  cap(o.roofs, F, hi, y + h, colorOf(0x2a2c32));
  // Iron cresting line along the top edge.
  cornice(o, F, x0 + inset, x1 - inset, z0 + inset, z1 - inset, y + h + 0.25, 0.25, 0.08, colorOf(0x1c1d22), [true, true, true, true]);
}

/** Spanish tile hip roof with a little overhang. */
export function hipRoof(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng): void {
  const ov = 0.5;
  const pitch = 0.36;
  const ax0 = x0 - ov;
  const ax1 = x1 + ov;
  const az0 = z0 - ov;
  const az1 = z1 + ov;
  const yb = y - ov * pitch;
  const wide = ax1 - ax0 >= az1 - az0;
  const half = (wide ? az1 - az0 : ax1 - ax0) / 2;
  const rise = half * pitch;
  const tile = colorOf(0x9a4a2a, rng.range(0.75, 1.1));
  const tile2 = tile.clone().multiplyScalar(0.85);
  const P = (x: number, yy: number, z: number): P3 => [F.X(x, z), yy, F.Z(x, z)];
  if (wide) {
    const zc = (az0 + az1) / 2;
    const r0 = P(ax0 + half, yb + rise, zc);
    const r1 = P(ax1 - half, yb + rise, zc);
    facet(o.roofs, [P(ax0, yb, az0), P(ax1, yb, az0), r1, r0], tile);
    facet(o.roofs, [P(ax1, yb, az1), P(ax0, yb, az1), r0, r1], tile2);
    facet(o.roofs, [P(ax0, yb, az1), P(ax0, yb, az0), r0], tile2);
    facet(o.roofs, [P(ax1, yb, az0), P(ax1, yb, az1), r1], tile);
  } else {
    const xc = (ax0 + ax1) / 2;
    const r0 = P(xc, yb + rise, az0 + half);
    const r1 = P(xc, yb + rise, az1 - half);
    facet(o.roofs, [P(ax0, yb, az0), P(ax1, yb, az0), r0], tile);
    facet(o.roofs, [P(ax1, yb, az1), P(ax0, yb, az1), r1], tile2);
    facet(o.roofs, [P(ax0, yb, az1), P(ax0, yb, az0), r0, r1], tile2);
    facet(o.roofs, [P(ax1, yb, az0), P(ax1, yb, az1), r1, r0], tile);
  }
  // Soffit under the overhang so the eaves are not see-through from below.
  cap(o.trim, F, boxOutline(ax0, ax1, az0, az1), yb, colorOf(0x3a2a20), true);
}

/** Antenna mast with an optional aviation light on top. */
export function mast(o: Out, F: Frame, x: number, z: number, y: number, h: number, rng: Rng, lit: boolean): void {
  const wx = F.X(x, z);
  const wz = F.Z(x, z);
  boxW(o.roofs, wx, wz, 0.09, y, y + h, colorOf(0x55585e));
  boxW(o.roofs, wx, wz, 0.5, y + h * 0.6, y + h * 0.6 + 0.08, colorOf(0x55585e));
  if (lit) light(o, wx, y + h + 0.25, wz, rng, false);
}

export function light(o: Out, x: number, y: number, z: number, rng: Rng, steady: boolean): void {
  o.lights.push({ x, y, z, phase: rng.next(), steady: steady ? 1 : 0 });
}

/** Red lights on the four roof corners of a tall building (some steady, most blinking together). */
export function roofLights(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng): void {
  const steady = rng.chance(0.3);
  const phase = rng.next();
  for (const p of boxOutline(x0 + 0.3, x1 - 0.3, z0 + 0.3, z1 - 0.3)) o.lights.push({ x: F.X(p.x, p.z), y, z: F.Z(p.x, p.z), phase, steady: steady ? 1 : 0 });
}

/** Mixed roof clutter: AC units, a bulkhead, the odd mast. */
export function clutter(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng, det: (typeof DETAIL)[Detail], kind: 'ac' | 'bulkhead', tint: THREE.Color): void {
  if (x1 - x0 < 3 || z1 - z0 < 3) return;
  if (kind === 'bulkhead' || rng.chance(0.5)) {
    const w = Math.min(3.6, (x1 - x0) * 0.4);
    const d = Math.min(3, (z1 - z0) * 0.4);
    const bx = rng.range(x0, x1 - w);
    const bz = rng.range(z0, z1 - d);
    lbox(o.roofs, F, bx, bx + w, bz, bz + d, y, y + rng.range(2.4, 3.2), tint.clone().multiplyScalar(0.55), false);
  }
  const n = Math.round(rng.range(1, 5) * det.clutter);
  const grey = colorOf(0x6a6e74);
  for (let k = 0; k < n; k++) {
    const ax = rng.range(x0, x1 - 1.4);
    const az = rng.range(z0, z1 - 1.1);
    lbox(o.roofs, F, ax, ax + 1.3, az, az + 1, y, y + 0.95, grey.clone().multiplyScalar(rng.range(0.7, 1.1)), false);
  }
  if (rng.chance(0.2 * det.clutter)) mast(o, F, rng.range(x0, x1), rng.range(z0, z1), y, rng.range(3, 8), rng, false);
}

/** Lit billboard on the roof, facing the main street face. */
export function billboard(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng, front: boolean[]): void {
  const face = front[0] ? 0 : front[1] ? 1 : front[3] ? 3 : front[2] ? 2 : 0;
  const along = face === 0 || face === 2 ? x1 - x0 : z1 - z0;
  const w = Math.min(13, along - 1.5);
  if (w < 6) return;
  const h = w / BLD.billboardAspect;
  const yb = y + rng.range(1.8, 3.2);
  const frame = colorOf(0x1c1d22);
  // Panel plane in local coords: on the roof near that face, facing out.
  const n = [
    { x: 0, z: -1 },
    { x: 1, z: 0 },
    { x: 0, z: 1 },
    { x: -1, z: 0 },
  ][face];
  const t = { x: -n.z, z: n.x };
  const cxL = face === 1 ? x1 - 1.2 : face === 3 ? x0 + 1.2 : (x0 + x1) / 2;
  const czL = face === 0 ? z0 + 1.2 : face === 2 ? z1 - 1.2 : (z0 + z1) / 2;
  const P = (s: number, out: number): [number, number] => [F.X(cxL + t.x * s + n.x * out, czL + t.z * s + n.z * out), F.Z(cxL + t.x * s + n.x * out, czL + t.z * s + n.z * out)];
  // Posts and a catwalk.
  for (const s of [-w * 0.35, 0, w * 0.35]) {
    const [px, pz] = P(s, -0.3);
    boxW(o.roofs, px, pz, 0.14, y, yb + h, frame);
  }
  const back = (s0: number, s1: number, o0: number, o1: number, ya: number, yb2: number) => {
    const xs = [cxL + t.x * s0 + n.x * o0, cxL + t.x * s1 + n.x * o1];
    const zs = [czL + t.z * s0 + n.z * o0, czL + t.z * s1 + n.z * o1];
    lbox(o.roofs, F, Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1]), Math.min(zs[0], zs[1]), Math.max(zs[0], zs[1]), ya, yb2, frame);
  };
  back(-w / 2 - 0.15, w / 2 + 0.15, -0.25, 0, yb - 0.1, yb + h + 0.1);
  back(-w / 2, w / 2, 0, 0.8, yb - 0.25, yb - 0.15);
  // The ad, brighter toward the lamps along its top edge.
  const cell = rng.int(0, BILLBOARD_COLS * BILLBOARD_ROWS - 1);
  const cu = 1 / BILLBOARD_COLS;
  const cv = 1 / BILLBOARD_ROWS;
  const u0 = (cell % BILLBOARD_COLS) * cu;
  const v1 = 1 - Math.floor(cell / BILLBOARD_COLS) * cv;
  const v0 = v1 - cv;
  const nx = F.NX(n.x, n.z);
  const nz = F.NZ(n.x, n.z);
  const lowC = new THREE.Color(0.55, 0.52, 0.5);
  const highC = new THREE.Color(1.15, 1.08, 1.0);
  const [ax, az] = P(-w / 2, 0.03);
  const [bx, bz] = P(w / 2, 0.03);
  // Text reads left to right seen from the street (the panel normal points at the viewer).
  const a = o.boards.vertex(ax, yb, az, nx, 0, nz, u0 + cu, v0, lowC);
  const b = o.boards.vertex(bx, yb, bz, nx, 0, nz, u0, v0, lowC);
  const c = o.boards.vertex(bx, yb + h, bz, nx, 0, nz, u0, v1, highC);
  const d = o.boards.vertex(ax, yb + h, az, nx, 0, nz, u0 + cu, v1, highC);
  o.boards.quadFacing(a, b, c, d, nx, 0, nz);
  // Lamp heads on arms over the top edge.
  const lamp = new THREE.Color(1, 0.92, 0.75).multiplyScalar(1.6);
  for (let k = 0; k < 4; k++) {
    const s = -w / 2 + (w * (k + 0.5)) / 4;
    const lx = cxL + t.x * s + n.x * 0.9;
    const lz = czL + t.z * s + n.z * 0.9;
    lbox(o.neon, F, lx - 0.18, lx + 0.18, lz - 0.12, lz + 0.12, yb + h + 0.15, yb + h + 0.3, lamp, true);
  }
}
