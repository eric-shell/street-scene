/**
 * The building mesher's kit: what buildings.ts, facadeDetails.ts and roofs.ts
 * all draw with. The tunables (`BLD`, the per-tier `DETAIL` table, the flood,
 * neon and LED palettes), the facade shell geometry (`ShellGeo`: positions
 * plus the per-vertex facade, glow and tint attributes facadeMaterial.ts
 * reads), a building's local frame (`Frame`: +x along the street, +z away from
 * it), the outlines and the primitives built on them (boxes, caps, facets,
 * neon rings, cornices, the facade walls) and `Out`, the set of merged
 * builders one building appends into. Render only; no building logic here.
 */
import * as THREE from 'three';
import { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import { PodiumOutput } from './facadeKit';
import { neonMood } from '../textures/cityMood';
import { NEON_COLORS } from '../textures/textures';
import { FLICK, SIGNAGE } from '../street/signage';
import type { FlickList } from '../street/signage';

export type Detail = 'low' | 'medium' | 'high';

/** Tunables of the mesher. Probabilities are per building unless noted. */
export const BLD = {
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
  /** Walls of overlapping buildings closer than this (m) share a plane and would z-fight. */
  coplanarTol: 0.1,
  /** How far the lower building's shared wall steps back behind the taller one (m), several depth steps at 600 m. */
  recess: 0.3,
} as const;

/** Clutter density and optional details per graphics tier. */
export const DETAIL: Record<Detail, { escapes: number; brackets: boolean; rails: boolean; clutter: number; live: boolean; mullion: 'plate' | 'box' }> = {
  low: { escapes: 0, brackets: false, rails: false, clutter: 0.45, live: false, mullion: 'plate' },
  medium: { escapes: 0.75, brackets: false, rails: true, clutter: 0.8, live: true, mullion: 'box' },
  high: { escapes: 1, brackets: true, rails: true, clutter: 1, live: true, mullion: 'box' },
};

export const FLOOD = [0xfff1d6, 0xffd9a0, 0xffc870, 0x9fe8ff, 0xff9ad8, 0xc8b0ff].map((c) => new THREE.Color(c));
export const PASTEL_NEON = [0xff5fc8, 0x3ff0ff, 0xb070ff, 0x50ffb0, 0xfff060, 0xff8a5c].map((c) => new THREE.Color(c));

const NEON_PALETTE = NEON_COLORS.map((c) => new THREE.Color(c));
let mood = neonMood(0);
/** Set the city whose neon the buildings draw (buildBuildings calls it first; building is synchronous, one city at a time). */
export function setNeonMood(seed: number): void {
  mood = neonMood(seed);
}
/** A pastel neon colour for a uniform draw in [0, 1), leaning toward the city's mood (every colour stays possible). */
export const pastelNeon = (r: number): THREE.Color => PASTEL_NEON[mood.pastel(r)];
/** A full neon colour (textures.NEON_COLORS) for a uniform draw, leaning toward the city's mood. */
export const neonColor = (r: number): THREE.Color => NEON_PALETTE[mood.neon(r)];
// LED crowns and corner lines are long and close to the camera: dimmer than neon so bloom stays a halo.
export const LED = [0xffffff, 0x9feaff, 0xff6fd8, 0xffcf70, 0x70ffd0].map((c) => new THREE.Color(c).multiplyScalar(0.45));

type RGB = readonly [number, number, number];
export const ZERO: RGB = [0, 0, 0];
export const WHITE = new THREE.Color(1, 1, 1);

/** Facade wash along a wall: color at a height, plus heights where the gradient bends. */
interface Glow {
  at(y: number): RGB;
  breaks: readonly number[];
}
export const NO_GLOW: Glow = { at: () => ZERO, breaks: [] };

/** A linear wash from (ya, ka) to (yb, kb), flat outside. */
export function wash(color: THREE.Color, ya: number, ka: number, yb: number, kb: number): Glow {
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
export interface Skin {
  layer: number;
  seed: number;
  lit: number;
  flags: number;
  tint: THREE.Color;
  bay: number;
  floor: number;
}

/** Shell geometry with the facade attributes (see facadeMaterial.ts). */
export class ShellGeo {
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
export class Frame {
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
export function edgeNormal(p: Vec2, q: Vec2): Vec2 {
  const dx = q.x - p.x;
  const dz = q.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dz / l, z: -dx / l };
}

export function boxOutline(x0: number, x1: number, z0: number, z1: number): Vec2[] {
  return [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 },
  ];
}

/** Rectangle with rounded corners (3 segment arcs) where `round[k]` (corner k of boxOutline order). */
export function roundedOutline(x0: number, x1: number, z0: number, z1: number, r: number, round: readonly boolean[]): { pts: Vec2[]; smooth: boolean[] } {
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

export interface Out {
  shell: ShellGeo;
  roofs: GeoBuilder;
  trim: GeoBuilder;
  neon: GeoBuilder;
  /** Flicker program of every `neon` vertex (signage.ts), filled ring by ring. */
  flick: FlickList;
  escapes: GeoBuilder;
  boards: GeoBuilder;
  lights: { x: number; y: number; z: number; phase: number; steady: number }[];
  podium: PodiumOutput;
}

/**
 * Axis aligned box in a building's local frame (y absolute). `skip` is a bit
 * mask over the four sides in boxOutline order (1 << 0 front z0, 1 right x1,
 * 2 back z1, 3 left x0) for faces that sit against a wall or inside a
 * neighbouring box; the vertices and triangles are not emitted at all.
 */
export function lbox(gb: GeoBuilder, F: Frame, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, color: THREE.Color, bottom = true, skip = 0): void {
  const o = boxOutline(x0, x1, z0, z1);
  const wx = o.map((p) => F.X(p.x, p.z));
  const wz = o.map((p) => F.Z(p.x, p.z));
  for (let i = 0; i < 4; i++) {
    if (skip & (1 << i)) continue;
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
export function cap(gb: GeoBuilder, F: Frame, pts: Vec2[], y: number, color: THREE.Color, down = false): void {
  const ny = down ? -1 : 1;
  const ids = pts.map((p) => gb.vertex(F.X(p.x, p.z), y, F.Z(p.x, p.z), 0, ny, 0, 0, 0, color));
  for (let i = 1; i + 1 < ids.length; i++) gb.triFacing(ids[0], ids[i], ids[i + 1], 0, ny, 0);
}

export type P3 = [number, number, number];
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
export function facet(gb: GeoBuilder, pts: P3[], color: THREE.Color, hint: P3 = UP): void {
  const [nx, ny, nz] = planeNormal(pts, hint);
  const ids = pts.map((p) => gb.vertex(p[0], p[1], p[2], nx, ny, nz, 0, 0, color));
  for (let i = 1; i + 1 < ids.length; i++) gb.triFacing(ids[0], ids[i], ids[i + 1], nx, ny, nz);
}

/** Outward-and-up hint for a sloped face over local edge p -> q. */
export function slopeHint(F: Frame, p: Vec2, q: Vec2): P3 {
  const n = edgeNormal(p, q);
  return [F.NX(n.x, n.z), 0.6, F.NZ(n.x, n.z)];
}

/**
 * Facade walls around a local outline between ybot and ytop. 'face' fits a
 * whole number of modules to every face (box buildings); 'perimeter' runs one
 * continuous module grid around (rounded corners). `faceRange` can shorten or
 * drop faces (terrace party walls), `faceSkin` swap a face's facade.
 */
export function walls(
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
export function shellFacet(o: Out, skin: Skin, pts: P3[], uv: [number, number][], street: number, glow: Glow, hint: P3): void {
  const [nx, ny, nz] = planeNormal(pts, hint);
  const ids = pts.map((p, k) => o.shell.v(p[0], p[1], p[2], nx, ny, nz, uv[k][0], uv[k][1], skin, glow.at(p[1]), p[1] - street));
  for (let i = 1; i + 1 < ids.length; i++) o.shell.triFacing(ids[0], ids[i], ids[i + 1], nx, ny, nz);
}

/** Thin emissive band just outside a local outline (neon tubes, LED crowns). */
export function neonRing(o: Out, F: Frame, pts: Vec2[], y0: number, y1: number, color: THREE.Color, out = 0.07, faces?: (i: number) => boolean): void {
  const n = pts.length;
  o.flick.fill(o.neon.vertexCount, 0);
  const fl = o.flick.roll(SIGNAGE.flickerRoof);
  const dead = fl > 0 ? o.flick.deadQuad(n) : -1;
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
    o.flick.fill(o.neon.vertexCount, i === dead ? FLICK.dead : fl);
  }
}

/** Vertical neon tube (a thin box) at a local point. */
export function neonPost(o: Out, F: Frame, x: number, z: number, y0: number, y1: number, color: THREE.Color, r = 0.07): void {
  lbox(o.neon, F, x - r, x + r, z - r, z + r, y0, y1, color, false);
}

/** Cornice: a projecting band around the selected faces of a box (local x0..x1, z0..z1). */
export function cornice(o: Out, F: Frame, x0: number, x1: number, z0: number, z1: number, y: number, h: number, over: number, color: THREE.Color, faces: readonly boolean[]): void {
  // Faces in boxOutline order: 0 front (z0), 1 right (x1), 2 back (z1), 3 left (x0).
  // Each piece's inner side is 0.3 m inside the wall, and where two pieces meet at a corner
  // the side piece's end butts the long piece, so those faces are never seen.
  const bit = (i: number) => 1 << i;
  if (faces[0]) lbox(o.trim, F, x0 - (faces[3] ? over : 0), x1 + (faces[1] ? over : 0), z0 - over, z0 + 0.3, y - h, y, color, true, bit(2));
  if (faces[2]) lbox(o.trim, F, x0 - (faces[3] ? over : 0), x1 + (faces[1] ? over : 0), z1 - 0.3, z1 + over, y - h, y, color, true, bit(0));
  if (faces[1]) lbox(o.trim, F, x1 - 0.3, x1 + over, z0 + 0.3, z1 - 0.3, y - h, y, color, true, bit(3) | (faces[0] ? bit(0) : 0) | (faces[2] ? bit(2) : 0));
  if (faces[3]) lbox(o.trim, F, x0 - over, x0 + 0.3, z0 + 0.3, z1 - 0.3, y - h, y, color, true, bit(1) | (faces[0] ? bit(0) : 0) | (faces[2] ? bit(2) : 0));
}

export function colorOf(hex: number, mul = 1): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(mul);
}
