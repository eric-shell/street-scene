/**
 * Building meshes from the architecture plan (architecture.ts): every
 * building's massing, crown, roof, rooftop clutter and facade details, merged
 * into a handful of meshes for the whole city.
 *
 * A building is a facade kit podium (facadeKit.ts: storefronts, stoops,
 * arcades...) under a shaft of facade walls (facadeMaterial.ts: one texture
 * array, procedural window light). The shaft is one or more masses: tiers
 * stepping back up a deco tower, narrow terrace houses along a rowhouse
 * block, a rounded-corner Miami block. Floors line up across tiers, and the
 * top is floor aligned so no window is cut by the roofline. Crowns and roofs
 * follow the style: stepped deco crowns with floodlights and spires, glass
 * tower LED bands, slants and pyramids, mansards, Spanish tile hips,
 * Victorian gables, heavy cornices and mid-century roof slabs. Roofs carry
 * water towers, bulkheads, AC units, masts with aviation lights and lit
 * billboards; facades carry fire escapes, bay windows, eyebrows, balconies,
 * fins and neon bands.
 *
 * Draw calls: shells, roofs, neon and the podium trim (which also takes the
 * cornices, slabs and balconies) as before, plus fire escapes, billboards and
 * aviation lights. Detail scales with the graphics tier (fire escapes, bay
 * brackets, balcony rails, clutter density, animated windows). Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { Building } from '../city/blocks';
import { corridorClearance } from '../city/blocks';
import { Vec2 } from '../sim/math';
import { Rng } from '../sim/prng';
import { GeoBuilder } from './geoBuilder';
import { GROUND_BAYS, GROUND_H, PODIUM_FLOOR_H, PodiumOutput, addPodiumFace, podiumExtrusions, podiumHeight } from './facadeKit';
import { BILLBOARD_COLS, BILLBOARD_ROWS, LAYER, MODULE, facadeAtlas } from './facadeAtlas';
import { createFacadeMaterials, TRIM_COLORS } from './facadeMaterial';
import { BuildingPlan, STYLES, StyleDef, planArchitecture } from './architecture';
import { NEON_COLORS } from './textures';

export type Detail = 'low' | 'medium' | 'high';

export interface BuildingMeshes {
  meshes: THREE.Object3D[];
  /** Advance animated windows and aviation lights (s). */
  update(time: number): void;
  dispose(): void;
}

/** Tunables of the mesher. Probabilities are per building unless noted. */
const BLD = {
  /** Fire escape column every this many meters of a walk-up's street face (max 2). */
  escapeEvery: 9,
  /** Bay window width and depth (m). */
  bayW: 2.9,
  bayD: 0.85,
  /** Deco setbacks: fractions of the floor count where tiers step back. */
  decoSteps: [0.56, 0.72, 0.85, 0.93],
  /** Billboard panel aspect (width / height) matches the 4:1 atlas cells. */
  billboardAspect: 4,
  /** Aviation lights above this roof height (m above street). */
  aviationAbove: 78,
} as const;

/** Clutter density and optional details per graphics tier. */
const DETAIL: Record<Detail, { escapes: number; brackets: boolean; rails: boolean; clutter: number; live: boolean }> = {
  low: { escapes: 0, brackets: false, rails: false, clutter: 0.45, live: false },
  medium: { escapes: 0.75, brackets: false, rails: true, clutter: 0.8, live: true },
  high: { escapes: 1, brackets: true, rails: true, clutter: 1, live: true },
};

const FLOOD = [0xfff1d6, 0xffd9a0, 0xffc870, 0x9fe8ff, 0xff9ad8, 0xc8b0ff].map((c) => new THREE.Color(c));
const PASTEL_NEON = [0xff5fc8, 0x3ff0ff, 0xb070ff, 0x50ffb0, 0xfff060, 0xff8a5c].map((c) => new THREE.Color(c));
// LED crowns and corner lines are long and close to the camera: dimmer than neon so bloom stays a halo.
const LED = [0xffffff, 0x9feaff, 0xff6fd8, 0xffcf70, 0x70ffd0].map((c) => new THREE.Color(c).multiplyScalar(0.45));

type RGB = readonly [number, number, number];
const ZERO: RGB = [0, 0, 0];
const WHITE = new THREE.Color(1, 1, 1);

/** Facade wash along a wall: color at a height, plus heights where the gradient bends. */
interface Glow {
  at(y: number): RGB;
  breaks: readonly number[];
}
const NO_GLOW: Glow = { at: () => ZERO, breaks: [] };

/** A linear wash from (ya, ka) to (yb, kb), flat outside. */
function wash(color: THREE.Color, ya: number, ka: number, yb: number, kb: number): Glow {
  return {
    at(y) {
      const t = Math.max(0, Math.min(1, (y - ya) / Math.max(0.01, yb - ya)));
      const k = ka + (kb - ka) * t;
      return [color.r * k, color.g * k, color.b * k];
    },
    breaks: [ya, yb],
  };
}

/** Per building (or terrace house) facade parameters, as the shader reads them. */
interface Skin {
  layer: number;
  seed: number;
  lit: number;
  flags: number;
  tint: THREE.Color;
  bay: number;
  floor: number;
}

/** Shell geometry with the facade attributes (see facadeMaterial.ts). */
class ShellGeo {
  pos: number[] = [];
  nrm: number[] = [];
  mod: number[] = [];
  fac: number[] = [];
  glow: number[] = [];
  tint: number[] = [];
  idx: number[] = [];
  get count(): number {
    return this.pos.length / 3;
  }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, s: Skin, g: RGB, hAbove: number): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.mod.push(u, v);
    this.fac.push(s.layer, s.seed, s.lit, s.flags);
    this.glow.push(g[0], g[1], g[2], hAbove);
    this.tint.push(s.tint.r, s.tint.g, s.tint.b);
    return this.count - 1;
  }
  triFacing(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  quadFacing(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number): void {
    this.triFacing(a, b, c, nx, ny, nz);
    this.triFacing(a, c, d, nx, ny, nz);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aMod', new THREE.Float32BufferAttribute(this.mod, 2));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.fac, 4));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 4));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Building frame: local +x along the street, +z away from it; the front face is z = -d/2. */
class Frame {
  readonly ux: number;
  readonly uz: number;
  readonly wx: number;
  readonly wz: number;
  constructor(
    readonly cx: number,
    readonly cz: number,
    yaw: number,
  ) {
    this.ux = Math.cos(yaw);
    this.uz = -Math.sin(yaw);
    this.wx = Math.sin(yaw);
    this.wz = Math.cos(yaw);
  }
  X(lx: number, lz: number): number {
    return this.cx + this.ux * lx + this.wx * lz;
  }
  Z(lx: number, lz: number): number {
    return this.cz + this.uz * lx + this.wz * lz;
  }
  NX(nx: number, nz: number): number {
    return this.ux * nx + this.wx * nz;
  }
  NZ(nx: number, nz: number): number {
    return this.uz * nx + this.wz * nz;
  }
}

/** Outward normal (local) of outline edge p -> q (outlines run with the front face toward +x). */
function edgeNormal(p: Vec2, q: Vec2): Vec2 {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dz / l, z: -dx / l };
}

function boxOutline(x0: number, x1: number, z0: number, z1: number): Vec2[] {
  return [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 },
  ];
}

/** Rectangle with rounded corners (3 segment arcs) where `round[k]` (corner k of boxOutline order). */
function roundedOutline(x0: number, x1: number, z0: number, z1: number, r: number, round: readonly boolean[]): { pts: Vec2[]; smooth: boolean[] } {
  const corners = boxOutline(x0, x1, z0, z1);
  const pts: Vec2[] = [];
  const smooth: boolean[] = [];
  for (let k = 0; k < 4; k++) {
    const c = corners[k];
    const prev = corners[(k + 3) % 4];
    const next = corners[(k + 1) % 4];
    if (!round[k]) {
      pts.push(c);
      smooth.push(false);
      continue;
    }
    const din = { x: Math.sign(c.x - prev.x), z: Math.sign(c.z - prev.z) };
    const dout = { x: Math.sign(next.x - c.x), z: Math.sign(next.z - c.z) };
    const a = { x: c.x - din.x * r, z: c.z - din.z * r };
    const ctr = { x: a.x + dout.x * r, z: a.z + dout.z * r };
    const a0 = Math.atan2(a.z - ctr.z, a.x - ctr.x);
    const e = { x: c.x + dout.x * r, z: c.z + dout.z * r };
    let a1 = Math.atan2(e.z - ctr.z, e.x - ctr.x);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    a1 = a0 + da;
    for (let s = 0; s <= 3; s++) {
      const t = a0 + (da * s) / 3;
      pts.push({ x: ctr.x + Math.cos(t) * r, z: ctr.z + Math.sin(t) * r });
      smooth.push(true);
    }
  }
  return { pts, smooth };
}

interface Out {
  shell: ShellGeo;
  roofs: GeoBuilder;
  trim: GeoBuilder;
  neon: GeoBuilder;
  escapes: GeoBuilder;
  boards: GeoBuilder;
  lights: { x: number; y: number; z: number; phase: number; steady: number }[];
  podium: PodiumOutput;
}

/** Axis aligned box in a building's local frame (y absolute). */
function lbox(gb: GeoBuilder, F: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, color: THREE.Color, bottom = true): void {
  const o = boxOutline(x0, x1, z0, z1);
  const wx = o.map((p) => F.X(p.x, p.z));
  const wz = o.map((p) => F.Z(p.x, p.z));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const n = edgeNormal(o[i], o[j]);
    const nx = F.NX(n.x, n.z);
    const nz = F.NZ(n.x, n.z);
    const a = gb.vertex(wx[i], y0, wz[i], nx, 0, nz, 0, 0, color);
    const b = gb.vertex(wx[j], y0, wz[j], nx, 0, nz, 0, 0, color);
    const c = gb.vertex(wx[j], y1, wz[j], nx, 0, nz, 0, 0, color);
    const d = gb.vertex(wx[i], y1, wz[i], nx, 0, nz, 0, 0, color);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  }
  const top = o.map((_, i) => gb.vertex(wx[i], y1, wz[i], 0, 1, 0, 0, 0, color));
  gb.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
  if (bottom) {
    const bt = o.map((_, i) => gb.vertex(wx[i], y0, wz[i], 0, -1, 0, 0, 0, color));
    gb.quadFacing(bt[0], bt[1], bt[2], bt[3], 0, -1, 0);
  }
}

/** Flat cap over a convex local outline. */
function cap(gb: GeoBuilder, F: Frame, pts: Vec2[], y: number, color: THREE.Color, down = false): void {
  const ny = down ? -1 : 1;
  const ids = pts.map((p) => gb.vertex(F.X(p.x, p.z), y, F.Z(p.x, p.z), 0, ny, 0, 0, 0, color));
  for (let i = 1; i + 1 < ids.length; i++) gb.triFacing(ids[0], ids[i], ids[i + 1], 0, ny, 0);
}

type P3 = [number, number, number];
const UP: P3 = [0, 1, 0];

/** Unit normal of a planar polygon, turned to agree with `hint` (the side it should face). */
function planeNormal(pts: P3[], hint: P3): P3 {
  const [a, b, c] = pts;
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) return [-nx, -ny, -nz];
  return [nx, ny, nz];
}

/** Planar polygon (world points) facing `hint`, into a vertex colored builder. */
function facet(gb: GeoBuilder, pts: P3[], color: THREE.Color, hint: P3 = UP): void {
  const [nx, ny, nz] = planeNormal(pts, hint);
  const ids = pts.map((p) => gb.vertex(p[0], p[1], p[2], nx, ny, nz, 0, 0, color));
  for (let i = 1; i + 1 < ids.length; i++) gb.triFacing(ids[0], ids[i], ids[i + 1], nx, ny, nz);
}

/** Outward-and-up hint for a sloped face over local edge p -> q. */
function slopeHint(F: Frame, p: Vec2, q: Vec2): P3 {
  const n = edgeNormal(p, q);
  return [F.NX(n.x, n.z), 0.6, F.NZ(n.x, n.z)];
}

/**
 * Facade walls around a local outline between ybot and ytop. 'face' fits a
 * whole number of modules to every face (box buildings); 'perimeter' runs one
 * continuous module grid around (rounded corners). `faceRange` can shorten or
 * drop faces (terrace party walls), `faceSkin` swap a face's facade.
 */
function walls(
  o: Out,
  F: Frame,
  skin: Skin,
  pts: Vec2[],
  smooth: boolean[] | null,
  ybot: number,
  ytop: number,
  vRef: number,
  street: number,
  glow: Glow,
  rng: Rng,
  fit: 'face' | 'perimeter',
  faceRange?: (i: number) => [number, number] | null,
  faceSkin?: (i: number) => Skin,
): void {
  const n = pts.length;
  const normals = pts.map((p, i) => edgeNormal(p, pts[(i + 1) % n]));
  const vnorm = (i: number, edge: number): Vec2 => {
    if (!smooth || !smooth[i]) return normals[edge];
    const a = normals[(i + n - 1) % n];
    const b = normals[i % n];
    const l = Math.hypot(a.x + b.x, a.z + b.z) || 1;
    return { x: (a.x + b.x) / l, z: (a.z + b.z) / l };
  };
  let perim = 0;
  const lens = pts.map((p, i) => {
    const q = pts[(i + 1) % n];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    perim += l;
    return l;
  });
  const perimModules = Math.max(4, Math.round(perim / skin.bay));
  let acc = rng.int(0, 7);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = lens[i];
    if (len < 0.05) continue;
    const s = faceSkin ? faceSkin(i) : skin;
    // Seen from outside, the outline runs right to left, so u runs against it: ghost signs read forwards.
    let u0: number;
    let u1: number;
    if (fit === 'face') {
      const mods = Math.max(1, Math.round(len / s.bay));
      u1 = rng.int(0, 7);
      u0 = u1 + mods;
    } else {
      u0 = -acc;
      acc += (len / perim) * perimModules;
      u1 = -acc;
    }
    let yb = ybot;
    let yt = ytop;
    if (faceRange) {
      const r = faceRange(i);
      if (!r) continue;
      yb = Math.max(yb, r[0]);
      yt = Math.min(yt, r[1]);
    }
    if (yt - yb < 0.05) continue;
    const ys = [yb];
    for (const y of glow.breaks) if (y > yb + 0.05 && y < yt - 0.05) ys.push(y);
    ys.push(yt);
    ys.sort((a, b) => a - b);
    const na = vnorm(i, i);
    const nb = vnorm(j, i);
    const ax = F.X(pts[i].x, pts[i].z);
    const az = F.Z(pts[i].x, pts[i].z);
    const bx = F.X(pts[j].x, pts[j].z);
    const bz = F.Z(pts[j].x, pts[j].z);
    const nax = F.NX(na.x, na.z);
    const naz = F.NZ(na.x, na.z);
    const nbx = F.NX(nb.x, nb.z);
    const nbz = F.NZ(nb.x, nb.z);
    const fn = normals[i];
    const fnx = F.NX(fn.x, fn.z);
    const fnz = F.NZ(fn.x, fn.z);
    let prevA = -1;
    let prevB = -1;
    for (const y of ys) {
      const v = (y - vRef) / s.floor;
      const g = glow.at(y);
      const va = o.shell.v(ax, y, az, nax, 0, naz, u0, v, s, g, y - street);
      const vb = o.shell.v(bx, y, bz, nbx, 0, nbz, u1, v, s, g, y - street);
      if (prevA >= 0) o.shell.quadFacing(prevA, prevB, vb, va, fnx, 0, fnz);
      prevA = va;
      prevB = vb;
    }
  }
}

/** Facade facet (mansards, pyramids, slants, spires): world points, module UVs per point, facing `hint`. */
function shellFacet(o: Out, skin: Skin, pts: P3[], uv: [number, number][], street: number, glow: Glow, hint: P3): void {
  const [nx, ny, nz] = planeNormal(pts, hint);
  const ids = pts.map((p, k) => o.shell.v(p[0], p[1], p[2], nx, ny, nz, uv[k][0], uv[k][1], skin, glow.at(p[1]), p[1] - street));
  for (let i = 1; i + 1 < ids.length; i++) o.shell.triFacing(ids[0], ids[i], ids[i + 1], nx, ny, nz);
}

/** Thin emissive band just outside a local outline (neon tubes, LED crowns). */
function neonRing(o: Out, F: Frame, pts: Vec2[], y0: number, y1: number, color: THREE.Color, out = 0.07, faces?: (i: number) => boolean): void {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (faces && !faces(i)) continue;
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const nn = edgeNormal(p, q);
    const nx = F.NX(nn.x, nn.z);
    const nz = F.NZ(nn.x, nn.z);
    const ax = F.X(p.x + nn.x * out, p.z + nn.z * out);
    const az = F.Z(p.x + nn.x * out, p.z + nn.z * out);
    const bx = F.X(q.x + nn.x * out, q.z + nn.z * out);
    const bz = F.Z(q.x + nn.x * out, q.z + nn.z * out);
    const a = o.neon.vertex(ax, y0, az, nx, 0, nz, 0, 0, color);
    const b = o.neon.vertex(bx, y0, bz, nx, 0, nz, 0, 0, color);
    const c = o.neon.vertex(bx, y1, bz, nx, 0, nz, 0, 0, color);
    const d = o.neon.vertex(ax, y1, az, nx, 0, nz, 0, 0, color);
    o.neon.quadFacing(a, b, c, d, nx, 0, nz);
  }
}

/** Vertical neon tube (a thin box) at a local point. */
function neonPost(o: Out, F: Frame, x: number, z: number, y0: number, y1: number, color: THREE.Color, r = 0.07): void {
  lbox(o.neon, F, x - r, x + r, z - r, z + r, y0, y1, color, false);
}

/** Cornice: a projecting band around the selected faces of a box (local x0..x1, z0..z1). */
function cornice(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, over: number, color: THREE.Color, faces: readonly boolean[]): void {
  // Faces in boxOutline order: 0 front (z0), 1 right (x1), 2 back (z1), 3 left (x0).
  if (faces[0]) lbox(o.trim, F, x0 - (faces[3] ? over : 0), x1 + (faces[1] ? over : 0), z0 - over, z0 + 0.3, y - h, y, color);
  if (faces[2]) lbox(o.trim, F, x0 - (faces[3] ? over : 0), x1 + (faces[1] ? over : 0), z1 - 0.3, z1 + over, y - h, y, color);
  if (faces[1]) lbox(o.trim, F, x1 - 0.3, x1 + over, z0 + 0.3, z1 - 0.3, y - h, y, color);
  if (faces[3]) lbox(o.trim, F, x0 - over, x0 + 0.3, z0 + 0.3, z1 - 0.3, y - h, y, color);
}

function colorOf(hex: number, mul = 1): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(mul);
}

// ---------------------------------------------------------------------------
// Rooftop clutter
// ---------------------------------------------------------------------------

function waterTower(o: Out, x: number, z: number, y: number, rng: Rng): void {
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

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

export function buildBuildings(world: World, podium: PodiumOutput, opts: { detail: Detail }): BuildingMeshes {
  const det = DETAIL[opts.detail];
  const atlas = facadeAtlas();
  const mats = createFacadeMaterials(atlas, { live: det.live });
  const plans = planArchitecture(world);
  const o: Out = {
    shell: new ShellGeo(),
    roofs: new GeoBuilder(true),
    trim: podium.trim,
    neon: new GeoBuilder(true),
    escapes: new GeoBuilder(),
    boards: new GeoBuilder(true),
    lights: [],
    podium,
  };
  const g = world.graph;
  const scratch: number[] = [];
  const B = world.blocks.buildings;
  for (let i = 0; i < B.length; i++) buildOne(o, B[i], plans[i], det, (x, z) => corridorClearance(g, world.blocks.edgeGrid, x, z, scratch) < 2);

  const disposables: { dispose(): void }[] = [mats];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const meshes: THREE.Object3D[] = [];
  const shell = new THREE.Mesh(track(o.shell.build()), mats.facade);
  shell.name = 'buildings';
  meshes.push(shell);
  const roofMesh = new THREE.Mesh(track(o.roofs.build()), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.05, envMapIntensity: 0.5 })));
  roofMesh.name = 'roofs';
  meshes.push(roofMesh);
  if (o.neon.vertexCount) {
    const neonMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
    neonMat.color.setScalar(1.5);
    const m = new THREE.Mesh(track(o.neon.build()), neonMat);
    m.name = 'roofNeon';
    meshes.push(m);
  }
  if (o.escapes.vertexCount) {
    const m = new THREE.Mesh(
      track(o.escapes.build()),
      track(new THREE.MeshStandardMaterial({ map: atlas.fireEscape, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.4, color: 0xffffff })),
    );
    m.name = 'fireEscapes';
    meshes.push(m);
  }
  if (o.boards.vertexCount) {
    const mat = track(new THREE.MeshBasicMaterial({ map: atlas.billboards, vertexColors: true }));
    const m = new THREE.Mesh(track(o.boards.build()), mat);
    m.name = 'billboards';
    meshes.push(m);
  }
  if (o.lights.length) {
    const n = o.lights.length;
    const pos = new Float32Array(n * 12);
    const corner = new Float32Array(n * 8);
    const light = new Float32Array(n * 8);
    const idx = new Uint32Array(n * 6);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    o.lights.forEach((l, k) => {
      for (let c = 0; c < 4; c++) {
        pos.set([l.x, l.y, l.z], k * 12 + c * 3);
        corner.set([C[c * 2], C[c * 2 + 1]], k * 8 + c * 2);
        light.set([l.phase, l.steady], k * 8 + c * 2);
      }
      idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('light', new THREE.BufferAttribute(light, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.Mesh(track(geo), mats.aviation);
    m.frustumCulled = false;
    m.renderOrder = 2;
    m.name = 'aviationLights';
    meshes.push(m);
  }
  return {
    meshes,
    update(time) {
      mats.update(time);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Everything for one building. */
function buildOne(o: Out, b: Building, plan: BuildingPlan, det: (typeof DETAIL)[Detail], streetAt: (x: number, z: number) => boolean): void {
  const S = STYLES[plan.style];
  const rng = new Rng((plan.seed ^ 0x6b1d5) >>> 0 || 1);
  const F = new Frame(b.x, b.z, b.yaw);
  const hw = b.w / 2;
  const hd = b.d / 2;
  const base = boxOutline(-hw, hw, -hd, hd);
  const front = base.map((p, i) => {
    const q = base[(i + 1) % 4];
    const n = edgeNormal(p, q);
    const mx = (p.x + q.x) / 2 + n.x * 1.5;
    const mz = (p.z + q.z) / 2 + n.z * 1.5;
    return streetAt(F.X(mx, mz), F.Z(mx, mz));
  });
  const street = b.baseY + 0.6;
  const m = MODULE[S.layer];
  const fh = m.floor;
  const maxKit = Math.max(0, Math.floor((plan.h - 0.6 - GROUND_H) / PODIUM_FLOOR_H) - 1);
  const kit = Math.min(maxKit, rng.int(S.kitFloors[0], S.kitFloors[1]));
  const y0 = street + podiumHeight(kit);
  const want = b.baseY + plan.h;
  let nF = Math.max(1, Math.round((want - y0) / fh));
  nF = Math.max(nF, Math.ceil((b.baseY + plan.flush - y0) / fh - 1e-6));
  const yTop = y0 + nF * fh;
  const flushFloor = Math.max(0, Math.ceil((b.baseY + plan.flush - y0) / fh - 1e-6));
  const vRef = y0 - rng.int(0, 7) * fh;
  const seed01 = ((plan.seed >>> 0) % 10007) / 10007;
  const makeSkin = (tintHex: number, layer = S.layer, litMul = 1): Skin => {
    const office = rng.chance(S.office) ? 1 : 0;
    const trim = rng.pick(S.trims);
    const glass = rng.pick(S.glass);
    const mm = MODULE[layer];
    return {
      layer: LAYER[layer],
      seed: (seed01 + rng.next() * 0.37) % 1,
      lit: rng.range(S.lit[0], S.lit[1]) * litMul,
      flags: office + 2 * trim + 32 * glass,
      tint: colorOf(tintHex, rng.range(0.88, 1.08)),
      bay: mm.bay,
      floor: mm.floor,
    };
  };
  const skin = makeSkin(rng.pick(S.palette));
  const trimColor = colorOf(TRIM_COLORS[(skin.flags >> 1) & 15], 0.85);
  const bays = S.ground.map((name) => GROUND_BAYS.indexOf(name));
  const podTint = new THREE.Color(1, 1, 1).lerp(skin.tint, 0.5);
  const sideSkin = S.side ? { ...makeSkin(rng.pick(S.palette), S.side, 0.4), tint: skin.tint } : null;

  // Terrace styles on a street split into narrow houses (half the brownstones stay one walk-up).
  const split = !!S.units && front[0] && (plan.style === 'brownstone' ? b.w >= 14 && rng.chance(0.5) : b.w >= S.units[0] * 1.6);
  if (split) {
    terrace(o, F, b, plan, S, rng, det, front, street, y0, nF, fh, vRef, flushFloor, makeSkin, bays);
    return;
  }

  // ----- Podium -----
  const ext = podiumExtrusions(rng, kit);
  for (let i = 0; i < 4; i++) {
    const p = base[i];
    const q = base[(i + 1) % 4];
    const n = edgeNormal(p, q);
    addPodiumFace(
      o.podium,
      { ax: F.X(p.x, p.z), az: F.Z(p.x, p.z), bx: F.X(q.x, q.z), bz: F.Z(q.x, q.z), nx: F.NX(n.x, n.z), nz: F.NZ(n.x, n.z), y0: street, yBase: b.baseY, front: front[i], bays, tint: podTint },
      kit,
      rng,
      ext,
    );
  }

  const faceSkin = sideSkin && (plan.style === 'brownstone' || plan.style === 'rowhouse') ? (i: number) => (front[i] || i === 2 ? skin : sideSkin) : undefined;
  const style = plan.style;
  const tall = yTop - street;

  // ----- Shaft and crown per style -----
  if (style === 'deco') {
    const lit = rng.chance(0.85);
    const flood = FLOOD[rng.chance(0.7) ? rng.int(0, 2) : rng.int(3, 5)];
    let x0 = -hw;
    let x1 = hw;
    let z0 = -hd;
    let z1 = hd;
    let yb = y0;
    const steps = nF >= 12 ? (plan.landmark ? 4 : rng.int(2, 3)) : nF >= 7 ? 1 : 0;
    const stepFloors = BLD.decoSteps.slice(0, steps).map((f) => Math.max(flushFloor + 1, Math.round(nF * f)));
    let prevFloor = 0;
    for (let k = 0; k <= steps; k++) {
      const topFloor = k < steps ? Math.min(nF - 1, stepFloors[k]) : nF;
      if (topFloor <= prevFloor) continue;
      const yt = y0 + topFloor * fh;
      const isTop = k === steps;
      const glow = lit && (isTop || k >= steps - 1) && steps > 0 ? wash(flood, yb, 1.15, yt, 0.25) : NO_GLOW;
      walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yb, yt, vRef, street, glow, rng, 'face');
      cap(o.roofs, F, boxOutline(x0, x1, z0, z1), yt, colorOf(0x1a1b20, rng.range(0.8, 1.2)));
      // Coping at every setback.
      cornice(o, F, x0, x1, z0, z1, yt + 0.35, 0.45, 0.12, trimColor, [true, true, true, true]);
      yb = yt;
      prevFloor = topFloor;
      const inset = Math.max(1.4, Math.min(x1 - x0, z1 - z0) * rng.range(0.08, 0.14));
      if (!isTop && x1 - x0 - 2 * inset > 6 && z1 - z0 - 2 * inset > 6) {
        x0 += inset;
        x1 -= inset;
        z0 += inset;
        z1 -= inset;
      }
    }
    // Stepped crown and spire, floodlit.
    let cy = yTop;
    const crownSteps = plan.landmark ? 3 : rng.int(1, 3);
    for (let k = 0; k < crownSteps; k++) {
      const inset = Math.min(x1 - x0, z1 - z0) * 0.17;
      if (x1 - x0 - 2 * inset < 2.5) break;
      x0 += inset;
      x1 -= inset;
      z0 += inset;
      z1 -= inset;
      const h = fh * rng.range(0.6, 1.1);
      walls(o, F, { ...skin, lit: skin.lit * 0.5 }, boxOutline(x0, x1, z0, z1), null, cy, cy + h, vRef, street, lit ? wash(flood, cy, 1.3, cy + h, 0.5) : NO_GLOW, rng, 'face');
      cap(o.roofs, F, boxOutline(x0, x1, z0, z1), cy + h, colorOf(0x1a1b20));
      cy += h;
    }
    if (plan.landmark || rng.chance(0.55)) {
      const sh = plan.landmark ? rng.range(22, 34) : rng.range(6, 15);
      const r = Math.min(x1 - x0, z1 - z0) * 0.32;
      spire(o, F, (x0 + x1) / 2, (z0 + z1) / 2, r, cy, cy + sh, skin, street, lit ? flood : null);
      light(o, F.X((x0 + x1) / 2, (z0 + z1) / 2), cy + sh + 0.4, F.Z((x0 + x1) / 2, (z0 + z1) / 2), rng, false);
    } else if (cy - street > BLD.aviationAbove) {
      roofLights(o, F, x0, x1, z0, z1, cy + 0.3, rng);
    }
    return;
  }

  if (style === 'glass') {
    let x0 = -hw;
    let x1 = hw;
    let z0 = -hd;
    let z1 = hd;
    let yb = y0;
    const setback = nF >= 10 && rng.chance(0.32) ? Math.max(flushFloor + 1, Math.round(nF * rng.range(0.62, 0.8))) : -1;
    if (setback > 0 && setback < nF) {
      const yt = y0 + setback * fh;
      walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yb, yt, vRef, street, NO_GLOW, rng, 'face');
      cap(o.roofs, F, boxOutline(x0, x1, z0, z1), yt, colorOf(0x2a2c30));
      const inset = rng.range(2, 4);
      if (x1 - x0 - 2 * inset > 8 && z1 - z0 - 2 * inset > 8) {
        x0 += inset;
        x1 -= inset;
        z0 += inset;
        z1 -= inset;
      }
      yb = yt;
    }
    const crown = plan.landmark ? 'pyramid' : plan.region === 'sf' && nF > 12 && rng.chance(0.12) ? 'pyramid' : rng.pick(['band', 'band', 'slant', 'penthouse', 'flat'] as const);
    const ledColor = LED[rng.int(0, LED.length - 1)];
    walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yb, yTop, vRef, street, NO_GLOW, rng, 'face');
    const outline = boxOutline(x0, x1, z0, z1);
    if (nF >= 8 && rng.chance(0.25)) {
      for (const p of outline) neonPost(o, F, p.x, p.z, yb + fh, yTop, ledColor, 0.06);
    }
    if (crown === 'pyramid') {
      const ph = Math.min(x1 - x0, z1 - z0) * (plan.landmark ? 1.6 : 0.8);
      pyramid(o, F, outline, yTop, yTop + ph, skin, street);
      light(o, F.X((x0 + x1) / 2, (z0 + z1) / 2), yTop + ph + 0.4, F.Z((x0 + x1) / 2, (z0 + z1) / 2), rng, false);
    } else if (crown === 'slant') {
      const sh = Math.min(x1 - x0, z1 - z0) * rng.range(0.3, 0.55);
      wedge(o, F, x0, x1, z0, z1, yTop, sh, skin, vRef, street, rng);
      neonRing(o, F, outline, yTop - 0.35, yTop - 0.1, ledColor);
      if (yTop + sh - street > BLD.aviationAbove) light(o, F.X((x0 + x1) / 2, z1), yTop + sh + 0.3, F.Z((x0 + x1) / 2, z1), rng, false);
    } else {
      cap(o.roofs, F, outline, yTop, colorOf(0x2a2c30, rng.range(0.8, 1.2)));
      cornice(o, F, x0, x1, z0, z1, yTop + 0.9, 0.9, 0.05, colorOf(0x30343a), [true, true, true, true]);
      if (crown === 'band') neonRing(o, F, outline, yTop + 0.25, yTop + 0.65, ledColor);
      if (crown === 'penthouse' || crown === 'band') {
        const ix = (x1 - x0) * 0.22;
        const iz = (z1 - z0) * 0.22;
        const ph = fh * rng.range(1, 1.6);
        walls(o, F, { ...skin, lit: 0.05 }, boxOutline(x0 + ix, x1 - ix, z0 + iz, z1 - iz), null, yTop, yTop + ph, vRef, street, NO_GLOW, rng, 'face');
        cap(o.roofs, F, boxOutline(x0 + ix, x1 - ix, z0 + iz, z1 - iz), yTop + ph, colorOf(0x24262a));
        mast(o, F, (x0 + x1) / 2 + ix * 0.6, (z0 + z1) / 2, yTop + ph, rng.range(5, 12), rng, tall > BLD.aviationAbove - 10);
      }
      if (tall > BLD.aviationAbove) roofLights(o, F, x0, x1, z0, z1, yTop + 1, rng);
      if (crown === 'flat') clutter(o, F, x0 + 1, x1 - 1, z0 + 1, z1 - 1, yTop, rng, det, 'ac', skin.tint);
    }
    return;
  }

  if (style === 'condo') {
    const glow = rng.chance(0.4) ? wash(PASTEL_NEON[rng.int(0, PASTEL_NEON.length - 1)], y0, 0.35, yTop, 0.05) : NO_GLOW;
    walls(o, F, skin, base, null, y0, yTop, vRef, street, glow, rng, 'face');
    cap(o.roofs, F, base, yTop, colorOf(0x3a3c40));
    // Balconies on the street faces, every floor above the podium.
    const slab = colorOf(0xf2f2ee, 0.9);
    const rail = colorOf(0x8fa8b8, 0.75);
    for (let i = 0; i < 4; i++) {
      if (!front[i]) continue;
      const depth = 1.5;
      for (let k = 1; k < nF; k++) {
        const y = y0 + k * fh;
        balcony(o, F, i, hw, hd, y, depth, slab, det.rails ? rail : null);
      }
    }
    cornice(o, F, -hw, hw, -hd, hd, yTop + 1, 1, 0.3, slab, [true, true, true, true]);
    if (rng.chance(0.6)) neonRing(o, F, base, yTop + 0.35, yTop + 0.7, LED[rng.int(0, LED.length - 1)]);
    if (rng.chance(0.35)) fin(o, F, hw, hd, yTop, rng.range(4, 9), slab, PASTEL_NEON[rng.int(0, PASTEL_NEON.length - 1)]);
    if (tall > BLD.aviationAbove) roofLights(o, F, -hw, hw, -hd, hd, yTop + 1.1, rng);
    else clutter(o, F, -hw + 1.5, hw - 1.5, -hd + 1.5, hd - 1.5, yTop, rng, det, 'ac', skin.tint);
    return;
  }

  if (style === 'miamiDeco') {
    const neon = PASTEL_NEON[rng.int(0, PASTEL_NEON.length - 1)];
    const round = !plan.signed && rng.chance(0.65);
    const corners = [front[3] && front[0], front[0] && front[1], front[1] && front[2], front[2] && front[3]].map((c) => c || (round && rng.chance(0.25)));
    const ol = round ? roundedOutline(-hw, hw, -hd, hd, Math.min(3, Math.min(hw, hd) * 0.45), corners.map((c) => c && round)) : { pts: base, smooth: null };
    // Colored uplight washing the facade, strongest at the shop fronts (mixed toward white so the
    // pastel underneath still shows).
    const glow = wash(neon.clone().lerp(WHITE, 0.45), y0, 0.3, yTop, 0.04);
    walls(o, F, skin, ol.pts, ol.smooth, y0, yTop, vRef, street, glow, rng, round ? 'perimeter' : 'face');
    cap(o.roofs, F, ol.pts, yTop + 0.5, colorOf(0x2c2c30));
    // Parapet band, neon tubes along the top and over the shop fronts.
    walls(o, F, { ...skin, lit: 0 }, ol.pts, ol.smooth, yTop, yTop + 0.5, vRef - 0.4, street, NO_GLOW, rng, round ? 'perimeter' : 'face');
    neonRing(o, F, ol.pts, yTop - 0.25, yTop - 0.05, neon);
    neonRing(o, F, ol.pts, street + GROUND_H - 0.05, street + GROUND_H + 0.12, PASTEL_NEON[rng.int(0, PASTEL_NEON.length - 1)], 0.62, (i) => {
      const p = ol.pts[i];
      const q = ol.pts[(i + 1) % ol.pts.length];
      const n = edgeNormal(p, q);
      return (n.z < -0.5 && front[0]) || (n.x > 0.5 && front[1]) || (n.z > 0.5 && front[2]) || (n.x < -0.5 && front[3]);
    });
    // Eyebrow sun shades over every floor's windows on the street faces.
    const brow = colorOf(TRIM_COLORS[(skin.flags >> 1) & 15], 0.9);
    for (let i = 0; i < 4; i++) {
      if (!front[i]) continue;
      for (let k = 0; k < nF; k++) eyebrow(o, F, i, hw, hd, round ? Math.min(3, Math.min(hw, hd) * 0.45) : 0, y0 + (k + 1) * fh - 0.62, brow);
    }
    if (rng.chance(0.45)) fin(o, F, hw, hd, yTop + 0.5, rng.range(3, 6.5), brow, neon);
    else if (rng.chance(0.4)) clutter(o, F, -hw + 1.5, hw - 1.5, -hd + 1.5, hd - 1.5, yTop + 0.5, rng, det, 'ac', skin.tint);
    return;
  }

  // Low and mid rise masonry and stucco: one mass, style specific top.
  let roofY = yTop;
  let x0 = -hw;
  let x1 = hw;
  let z0 = -hd;
  let z1 = hd;
  if (style === 'prewar' && nF >= 10 && rng.chance(0.5)) {
    const sf = Math.max(flushFloor + 1, Math.round(nF * rng.range(0.78, 0.88)));
    if (sf < nF) {
      const yt = y0 + sf * fh;
      walls(o, F, skin, base, null, y0, yt, vRef, street, NO_GLOW, rng, 'face', undefined, faceSkin);
      cap(o.roofs, F, base, yt, colorOf(0x1a1b20));
      cornice(o, F, x0, x1, z0, z1, yt + 0.6, 0.7, 0.45, trimColor, [true, true, true, true]);
      const inset = rng.range(2, 3.2);
      if (b.w - 2 * inset > 7 && b.d - 2 * inset > 7) {
        x0 += inset;
        x1 -= inset;
        z0 += inset;
        z1 -= inset;
      }
      walls(o, F, skin, boxOutline(x0, x1, z0, z1), null, yt, yTop, vRef, street, NO_GLOW, rng, 'face');
    } else walls(o, F, skin, base, null, y0, yTop, vRef, street, NO_GLOW, rng, 'face', undefined, faceSkin);
  } else {
    const glow = style === 'empire' && rng.chance(0.5) ? wash(FLOOD[1], y0, 0.45, y0 + fh * 2.2, 0) : NO_GLOW;
    walls(o, F, skin, base, null, y0, yTop, vRef, street, glow, rng, 'face', undefined, faceSkin);
  }
  const outline = boxOutline(x0, x1, z0, z1);

  if (style === 'empire') {
    cornice(o, F, x0, x1, z0, z1, yTop + 0.75, 0.75, 0.5, trimColor, [true, true, true, true]);
    mansard(o, F, x0, x1, z0, z1, yTop + 0.75, 4, { ...skin, layer: LAYER.mansard, bay: MODULE.mansard.bay, floor: MODULE.mansard.floor, tint: colorOf(0x9aa0a8) }, street, rng);
    roofY = yTop + 4.75;
    if (rng.chance(0.6)) for (let k = 0; k < 2; k++) chimney(o, F, rng.range(x0 + 2, x1 - 2), rng.chance(0.5) ? z0 + 1.8 : z1 - 1.8, roofY, colorOf(0x6a4a3a));
    return;
  }
  if (style === 'spanish') {
    if (rng.chance(0.72)) hipRoof(o, F, x0, x1, z0, z1, yTop, rng);
    else {
      cap(o.roofs, F, outline, yTop, colorOf(0x2a2622));
      cornice(o, F, x0, x1, z0, z1, yTop + 0.55, 0.55, 0.3, colorOf(0x8a3a24, rng.range(0.8, 1.1)), [true, true, true, true]);
      if (rng.chance(0.3)) billboard(o, F, x0, x1, z0, z1, yTop + 0.55, rng, front);
    }
    if (rng.chance(0.5)) chimney(o, F, rng.range(x0 + 1.5, x1 - 1.5), rng.range(z0 + 1.5, z1 - 1.5), yTop + 1.6, skin.tint.clone().multiplyScalar(0.8));
    return;
  }
  if (style === 'midcentury') {
    cap(o.roofs, F, outline, yTop, colorOf(0x26272b));
    // Thin roof slab cantilevered past the walls.
    lbox(o.trim, F, x0 - 0.9, x1 + 0.9, z0 - 0.9, z1 + 0.9, yTop, yTop + 0.3, colorOf(TRIM_COLORS[(skin.flags >> 1) & 15], 0.95));
    if (rng.chance(0.55)) billboard(o, F, x0, x1, z0, z1, yTop + 0.3, rng, front);
    else clutter(o, F, x0 + 1, x1 - 1, z0 + 1, z1 - 1, yTop + 0.3, rng, det, 'ac', skin.tint);
    if (rng.chance(0.25)) neonRing(o, F, outline, yTop - 0.5, yTop - 0.05, new THREE.Color(NEON_COLORS[rng.int(0, NEON_COLORS.length - 1)]), 0.95);
    return;
  }
  // brownstone, prewar, and terrace styles that did not split (victorian / rowhouse on side streets).
  cap(o.roofs, F, outline, roofY, colorOf(0x16171c, rng.range(0.8, 1.4)));
  const heavy = style === 'brownstone' || style === 'prewar' || style === 'rowhouse' || style === 'victorian';
  if (heavy) cornice(o, F, x0, x1, z0, z1, roofY + 0.7, 0.75, 0.55, trimColor, [true, true, true, true]);
  if ((style === 'brownstone' || style === 'prewar') && nF <= 9 && det.escapes > 0) {
    for (let i = 0; i < 4; i++) {
      if (!front[i] || (i !== 0 && det.escapes < 1)) continue;
      if (!rng.chance(det.escapes * (i === 0 ? 0.85 : 0.4))) continue;
      fireEscapes(o, F, i, hw, hd, y0, nF, fh, skin.bay, rng);
    }
  }
  const nycish = plan.region === 'nyc' || plan.region === 'philly';
  if ((style === 'brownstone' || style === 'prewar') && rng.chance(nycish ? 0.6 : 0.28)) {
    const r = 2.6;
    if (x1 - x0 > 2 * r + 2 && z1 - z0 > 2 * r + 2) {
      const lx = rng.range(x0 + r + 1, x1 - r - 1);
      const lz = rng.range(z0 + r + 1, z1 - r - 1);
      waterTower(o, F.X(lx, lz), F.Z(lx, lz), roofY + 0.7, rng);
    }
  }
  if (style === 'brownstone' || style === 'prewar') {
    if (rng.chance(0.15) && plan.region !== 'philly') billboard(o, F, x0, x1, z0, z1, roofY + 0.7, rng, front);
    clutter(o, F, x0 + 1, x1 - 1, z0 + 1, z1 - 1, roofY, rng, det, 'bulkhead', skin.tint);
  } else chimney(o, F, rng.range(x0 + 1.2, x1 - 1.2), z1 - 1.5, roofY, colorOf(0x6a3a2c));
  if (tall > BLD.aviationAbove) roofLights(o, F, x0, x1, z0, z1, roofY + 1, rng);
}

/** Terrace of narrow houses (rowhouses, painted ladies, brownstone rows). */
function terrace(
  o: Out,
  F: Frame,
  b: Building,
  plan: BuildingPlan,
  S: StyleDef,
  rng: Rng,
  det: (typeof DETAIL)[Detail],
  front: boolean[],
  street: number,
  y0: number,
  nF: number,
  fh: number,
  vRef: number,
  flushFloor: number,
  makeSkin: (tint: number, layer?: StyleDef['layer'], litMul?: number) => Skin,
  bays: number[],
): void {
  const hw = b.w / 2;
  const hd = b.d / 2;
  const n = Math.max(2, Math.round(b.w / rng.range(S.units![0], S.units![1])));
  const uw = b.w / n;
  const style = plan.style;
  const tops: number[] = [];
  const skins: Skin[] = [];
  let lastTint = -1;
  for (let k = 0; k < n; k++) {
    let ti = rng.int(0, S.palette.length - 1);
    if (ti === lastTint) ti = (ti + 1) % S.palette.length;
    lastTint = ti;
    skins.push(makeSkin(S.palette[ti]));
    const df = rng.chance(0.25) ? rng.pick([-1, 1]) : 0;
    tops.push(y0 + Math.max(flushFloor, Math.max(1, nF + df)) * fh);
  }
  const shingle = colorOf(0x2a2a30);
  for (let k = 0; k < n; k++) {
    const x0 = -hw + k * uw;
    const x1 = x0 + uw;
    const s = skins[k];
    const top = tops[k];
    const tint = new THREE.Color(1, 1, 1).lerp(s.tint, 0.55);
    const trim = colorOf(TRIM_COLORS[(s.flags >> 1) & 15], 0.9);
    // Podium: the house's ground floor on its exposed faces (no protrusions, so neighbours never overlap).
    const out = boxOutline(x0, x1, -hd, hd);
    for (let i = 0; i < 4; i++) {
      if ((i === 1 && k < n - 1) || (i === 3 && k > 0)) continue;
      const p = out[i];
      const q = out[(i + 1) % 4];
      const nn = edgeNormal(p, q);
      addPodiumFace(
        o.podium,
        { ax: F.X(p.x, p.z), az: F.Z(p.x, p.z), bx: F.X(q.x, q.z), bz: F.Z(q.x, q.z), nx: F.NX(nn.x, nn.z), nz: F.NZ(nn.x, nn.z), y0: street, yBase: b.baseY, front: front[i], bays, tint },
        0,
        rng,
        [0],
      );
    }
    const left = k > 0 ? tops[k - 1] : -Infinity;
    const right = k < n - 1 ? tops[k + 1] : -Infinity;
    walls(o, F, s, out, null, y0, top, vRef, street, NO_GLOW, rng, 'face', (i) => {
      if (i === 1) return k < n - 1 ? (top > right + 0.05 ? [right, top] : null) : [y0, top];
      if (i === 3) return k > 0 ? (top > left + 0.05 ? [left, top] : null) : [y0, top];
      return [y0, top];
    });
    const gable = style === 'victorian' && rng.chance(0.5) && uw <= 9;
    if (!gable) cap(o.roofs, F, out, top, colorOf(0x17181c, rng.range(0.8, 1.3)));
    // Cornice on the street face (and the back), brackets under it on high detail.
    cornice(o, F, x0, x1, -hd, hd, top + 0.6, 0.65, style === 'victorian' ? 0.6 : 0.45, trim, [true, k === n - 1, true, k === 0]);
    if (det.brackets && style === 'victorian') {
      for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.8) lbox(o.trim, F, x - 0.08, x + 0.08, -hd - 0.5, -hd, top - 0.35, top - 0.05, trim);
    }
    if (style === 'victorian' && uw >= 5) {
      const cx = x0 + uw * (k % 2 ? 0.62 : 0.38);
      bayWindow(o, F, s, cx, -hd, Math.min(BLD.bayW, uw - 1.6), BLD.bayD, y0, top - 0.05, vRef, street, trim);
    }
    if (gable) {
      const gh = uw * 0.45;
      const yb = top + 0.6;
      const tri: [number, number, number][] = [
        [F.X(x0, -hd - 0.3), yb, F.Z(x0, -hd - 0.3)],
        [F.X(x1, -hd - 0.3), yb, F.Z(x1, -hd - 0.3)],
        [F.X((x0 + x1) / 2, -hd - 0.3), yb + gh, F.Z((x0 + x1) / 2, -hd - 0.3)],
      ];
      facet(o.trim, tri, s.tint.clone().lerp(trim, 0.35), [F.NX(0, -1), 0, F.NZ(0, -1)]);
      const back: [number, number, number][] = [
        [F.X(x0, hd), yb, F.Z(x0, hd)],
        [F.X((x0 + x1) / 2, hd), yb + gh, F.Z((x0 + x1) / 2, hd)],
        [F.X(x1, hd), yb, F.Z(x1, hd)],
      ];
      facet(o.trim, back, s.tint.clone().multiplyScalar(0.7), [F.NX(0, 1), 0, F.NZ(0, 1)]);
      // Pitched roof behind the gable, ridge running back from the street.
      const ridgeF: [number, number, number] = [F.X((x0 + x1) / 2, -hd - 0.3), yb + gh, F.Z((x0 + x1) / 2, -hd - 0.3)];
      const ridgeB: [number, number, number] = [F.X((x0 + x1) / 2, hd + 0.2), yb + gh, F.Z((x0 + x1) / 2, hd + 0.2)];
      facet(o.roofs, [[F.X(x0 - 0.2, -hd - 0.3), yb - 0.1, F.Z(x0 - 0.2, -hd - 0.3)], ridgeF, ridgeB, [F.X(x0 - 0.2, hd + 0.2), yb - 0.1, F.Z(x0 - 0.2, hd + 0.2)]], shingle);
      facet(o.roofs, [[F.X(x1 + 0.2, -hd - 0.3), yb - 0.1, F.Z(x1 + 0.2, -hd - 0.3)], [F.X(x1 + 0.2, hd + 0.2), yb - 0.1, F.Z(x1 + 0.2, hd + 0.2)], ridgeB, ridgeF], shingle);
    } else if (style === 'rowhouse' || style === 'brownstone') {
      if (rng.chance(0.5)) chimney(o, F, rng.range(x0 + 0.8, x1 - 0.8), hd - 1.2, top, colorOf(0x6a3a2c));
    }
    if (style === 'brownstone') {
      if (det.escapes > 0 && rng.chance(0.35 * det.escapes)) fireEscapes(o, F, 0, hw, hd, y0, Math.round((top - y0) / fh), fh, s.bay, rng, (x0 + x1) / 2);
      if (rng.chance(0.25) && uw > 7) waterTower(o, F.X((x0 + x1) / 2, hd * 0.2), F.Z((x0 + x1) / 2, hd * 0.2), top + 0.6, rng);
    }
  }
}

/** Victorian bay window: three facade faces stepping out of the wall, capped top and bottom. */
function bayWindow(o: Out, F: Frame, s: Skin, cx: number, z: number, w: number, d: number, yb: number, yt: number, vRef: number, street: number, trim: THREE.Color): void {
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
function fireEscapes(o: Out, F: Frame, face: number, hw: number, hd: number, y0: number, floors: number, fh: number, bay: number, rng: Rng, at?: number): void {
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
function balcony(o: Out, F: Frame, face: number, hw: number, hd: number, y: number, depth: number, slab: THREE.Color, rail: THREE.Color | null): void {
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
function eyebrow(o: Out, F: Frame, face: number, hw: number, hd: number, r: number, y: number, color: THREE.Color): void {
  const ff = faceFrame(face, hw, hd);
  const s0 = r + 0.2;
  const s1 = ff.len - r - 0.2;
  if (s1 - s0 < 1) return;
  const a = { x: ff.p.x + ff.u.x * s0, z: ff.p.z + ff.u.z * s0 };
  const b = { x: ff.p.x + ff.u.x * s1 + ff.n.x * 0.6, z: ff.p.z + ff.u.z * s1 + ff.n.z * 0.6 };
  lbox(o.trim, F, Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(a.z, b.z), Math.max(a.z, b.z), y, y + 0.1, color);
}

/** Deco fin: a vertical slab rising over the front parapet with a neon edge. */
function fin(o: Out, F: Frame, hw: number, hd: number, y: number, h: number, color: THREE.Color, neon: THREE.Color): void {
  const x = 0;
  lbox(o.trim, F, x - 0.3, x + 0.3, -hd - 0.4, -hd + 2.2, y - 2, y + h, color);
  lbox(o.neon, F, x - 0.06, x + 0.06, -hd - 0.48, -hd - 0.36, y - 1.6, y + h - 0.2, neon, false);
  void hw;
}

function chimney(o: Out, F: Frame, x: number, z: number, y: number, color: THREE.Color): void {
  lbox(o.roofs, F, x - 0.35, x + 0.35, z - 0.35, z + 0.35, y - 0.2, y + 1.4, color, false);
}

/** Thin pointed spire over a deco crown (shell facets so the floods light it). */
function spire(o: Out, F: Frame, cx: number, cz: number, r: number, y0: number, y1: number, skin: Skin, street: number, flood: THREE.Color | null): void {
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
function pyramid(o: Out, F: Frame, outline: Vec2[], y0: number, y1: number, skin: Skin, street: number): void {
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
function wedge(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, skin: Skin, vRef: number, street: number, rng: Rng): void {
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
function mansard(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, skin: Skin, street: number, rng: Rng): void {
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
function hipRoof(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng): void {
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
function mast(o: Out, F: Frame, x: number, z: number, y: number, h: number, rng: Rng, lit: boolean): void {
  const wx = F.X(x, z);
  const wz = F.Z(x, z);
  boxW(o.roofs, wx, wz, 0.09, y, y + h, colorOf(0x55585e));
  boxW(o.roofs, wx, wz, 0.5, y + h * 0.6, y + h * 0.6 + 0.08, colorOf(0x55585e));
  if (lit) light(o, wx, y + h + 0.25, wz, rng, false);
}

function light(o: Out, x: number, y: number, z: number, rng: Rng, steady: boolean): void {
  o.lights.push({ x, y, z, phase: rng.next(), steady: steady ? 1 : 0 });
}

/** Red lights on the four roof corners of a tall building (some steady, most blinking together). */
function roofLights(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng): void {
  const steady = rng.chance(0.3);
  const phase = rng.next();
  for (const p of boxOutline(x0 + 0.3, x1 - 0.3, z0 + 0.3, z1 - 0.3)) o.lights.push({ x: F.X(p.x, p.z), y, z: F.Z(p.x, p.z), phase, steady: steady ? 1 : 0 });
}

/** Mixed roof clutter: AC units, a bulkhead, the odd mast. */
function clutter(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng, det: (typeof DETAIL)[Detail], kind: 'ac' | 'bulkhead', tint: THREE.Color): void {
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
function billboard(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, rng: Rng, front: boolean[]): void {
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
