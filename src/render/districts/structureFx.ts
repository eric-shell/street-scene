/**
 * Shared kit for the structure renderers (tunnel.ts, overpass.ts): geometry
 * in a street frame, a baked light material for surfaces lit by their own
 * lamps, an additive wash for the light those lamps throw on the road, and
 * one canvas atlas for every sign they carry (tunnel name boards, clearance
 * plates, gantry direction signs, message boards).
 *
 * Baked light: a tunnel at night is lit by its own fixtures, not the sky, so
 * its walls and ceiling carry a per vertex light level (`bake`, 0..1) that the
 * material adds as emissive, albedo times the lamp color. The surfaces still
 * take the scene's real lights on top (headlights, the light pool), and it
 * costs nothing per frame. The wash is the same idea on the asphalt the city
 * draws: an additive, vertex colored strip that fades out in fog instead of
 * glowing toward the fog color (as render/street/areaLights.ts does).
 */
import * as THREE from 'three';
import type { Frame } from '../../city/districts/structures';
import { toWorld } from '../../city/districts/structures';
import { TUNNEL_NAMES } from '../../city/districts/tunnel';
import { GeoBuilder } from '../geoBuilder';

/** A GeoBuilder whose vertices also carry the baked light level `light` (0..1) current when they were added. */
export class BakedBuilder extends GeoBuilder {
  /** Light level stamped on the vertices added from now on. */
  light = 0;
  private bakes: number[] = [];

  constructor() {
    super(true);
  }

  override vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, color?: THREE.Color): number {
    this.bakes.push(this.light);
    return super.vertex(x, y, z, nx, ny, nz, u, v, color);
  }

  override build(): THREE.BufferGeometry {
    const g = super.build();
    g.setAttribute('bake', new THREE.Float32BufferAttribute(this.bakes, 1));
    return g;
  }
}

/** Lit, vertex colored material that adds albedo x `lamp` x bake as emissive (the fixtures' light, baked). */
export function bakedMaterial(lamp: THREE.Color): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, envMapIntensity: 0.35 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.bakeLamp = { value: lamp };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float bake;\nvarying float vBake;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvBake = bake;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vBake;\nuniform vec3 bakeLamp;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * bakeLamp * vBake;');
  };
  m.customProgramCacheKey = () => 'structureBaked';
  return m;
}

/** Additive light on the road (vertex colors), fading to nothing in fog rather than toward the fog color. */
export function washMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        gl_FragColor.rgb *= 1.0 - fogFactor;
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'structureWash';
  return m;
}

/** Faces of a frame box to emit (all by default). */
export interface BoxFaces {
  u0?: boolean;
  u1?: boolean;
  v0?: boolean;
  v1?: boolean;
  top?: boolean;
  bottom?: boolean;
}

/**
 * Box in a street frame: u0..u1 along the street, v0..v1 across it, bottom
 * and top heights (absolute, m) given at u0 and at u1 so it can follow a
 * sloping road.
 */
export function frameBox(gb: GeoBuilder, f: Frame, u0: number, u1: number, v0: number, v1: number, yb0: number, yb1: number, yt0: number, yt1: number, color: THREE.Color, faces: BoxFaces = {}): void {
  const p00 = toWorld(f, u0, v0);
  const p10 = toWorld(f, u1, v0);
  const p11 = toWorld(f, u1, v1);
  const p01 = toWorld(f, u0, v1);
  const U = { x: f.ux, z: f.uz };
  const V = { x: -f.uz, z: f.ux };
  const q = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], nx: number, ny: number, nz: number) => {
    const ia = gb.vertex(a[0], a[1], a[2], nx, ny, nz, 0, 0, color);
    const ib = gb.vertex(b[0], b[1], b[2], nx, ny, nz, 1, 0, color);
    const ic = gb.vertex(c[0], c[1], c[2], nx, ny, nz, 1, 1, color);
    const id = gb.vertex(d[0], d[1], d[2], nx, ny, nz, 0, 1, color);
    gb.quadFacing(ia, ib, ic, id, nx, ny, nz);
  };
  if (faces.v0 !== false) q([p00.x, yb0, p00.z], [p10.x, yb1, p10.z], [p10.x, yt1, p10.z], [p00.x, yt0, p00.z], -V.x, 0, -V.z);
  if (faces.v1 !== false) q([p01.x, yb0, p01.z], [p11.x, yb1, p11.z], [p11.x, yt1, p11.z], [p01.x, yt0, p01.z], V.x, 0, V.z);
  if (faces.u0 !== false) q([p00.x, yb0, p00.z], [p01.x, yb0, p01.z], [p01.x, yt0, p01.z], [p00.x, yt0, p00.z], -U.x, 0, -U.z);
  if (faces.u1 !== false) q([p10.x, yb1, p10.z], [p11.x, yb1, p11.z], [p11.x, yt1, p11.z], [p10.x, yt1, p10.z], U.x, 0, U.z);
  if (faces.top !== false) q([p00.x, yt0, p00.z], [p10.x, yt1, p10.z], [p11.x, yt1, p11.z], [p01.x, yt0, p01.z], 0, 1, 0);
  if (faces.bottom !== false) q([p00.x, yb0, p00.z], [p10.x, yb1, p10.z], [p11.x, yb1, p11.z], [p01.x, yb0, p01.z], 0, -1, 0);
}

/** Vertical quad in a frame from (u0, v0) to (u1, v1), bottom and top heights at each end, facing (nx, nz) in world space. */
export function frameWall(gb: GeoBuilder, f: Frame, u0: number, v0: number, u1: number, v1: number, yb0: number, yt0: number, yb1: number, yt1: number, color: THREE.Color, nx: number, nz: number): void {
  const a = toWorld(f, u0, v0);
  const b = toWorld(f, u1, v1);
  const ia = gb.vertex(a.x, yb0, a.z, nx, 0, nz, 0, 0, color);
  const ib = gb.vertex(b.x, yb1, b.z, nx, 0, nz, 1, 0, color);
  const ic = gb.vertex(b.x, yt1, b.z, nx, 0, nz, 1, 1, color);
  const id = gb.vertex(a.x, yt0, a.z, nx, 0, nz, 0, 1, color);
  gb.quadFacing(ia, ib, ic, id, nx, 0, nz);
}

/** Horizontal cylinder along the frame's u axis from u0 to u1 at (v, y), radius r, n sides, capped. */
export function frameCylinderU(gb: GeoBuilder, f: Frame, u0: number, u1: number, v: number, y: number, r: number, n: number, color: THREE.Color): void {
  const V = { x: -f.uz, z: f.ux };
  const ring = (u: number) => {
    const out: number[] = [];
    const c = toWorld(f, u, v);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const cs = Math.cos(a);
      const sn = Math.sin(a);
      out.push(gb.vertex(c.x + V.x * cs * r, y + sn * r, c.z + V.z * cs * r, V.x * cs, sn, V.z * cs, i / n, 0, color));
    }
    return out;
  };
  const r0 = ring(u0);
  const r1 = ring(u1);
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    gb.quadFacing(r0[i], r0[i + 1], r1[i + 1], r1[i], V.x * Math.cos(a), Math.sin(a), V.z * Math.cos(a));
  }
  for (const [u, s] of [
    [u0, -1],
    [u1, 1],
  ] as const) {
    const c = toWorld(f, u, v);
    const center = gb.vertex(c.x, y, c.z, f.ux * s, 0, f.uz * s, 0, 0, color);
    const rim: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      rim.push(gb.vertex(c.x + V.x * Math.cos(a) * r, y + Math.sin(a) * r, c.z + V.z * Math.cos(a) * r, f.ux * s, 0, f.uz * s, 0, 0, color));
    }
    for (let i = 0; i < n; i++) gb.triFacing(center, rim[i], rim[(i + 1) % n], f.ux * s, 0, f.uz * s);
  }
}

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Cuboid from a to b (end face centers), hw wide (horizontal, across) and hh tall (perpendicular), all six faces. */
export function beam(gb: GeoBuilder, a: P3, b: P3, hw: number, hh: number, color: THREE.Color): void {
  let fx = b.x - a.x;
  let fy = b.y - a.y;
  let fz = b.z - a.z;
  const len = Math.hypot(fx, fy, fz);
  if (len < 1e-4) return;
  fx /= len;
  fy /= len;
  fz /= len;
  let sx = -fz;
  let sz = fx;
  let sl = Math.hypot(sx, sz);
  if (sl < 0.05) {
    sx = 1;
    sz = 0;
    sl = 1;
  }
  sx /= sl;
  sz /= sl;
  const ux = -sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy;
  const c = (p: P3, s: number, u: number): [number, number, number] => [p.x + sx * hw * s + ux * hh * u, p.y + uy * hh * u, p.z + sz * hw * s + uz * hh * u];
  const face = (p: [number, number, number][], nx: number, ny: number, nz: number) => {
    const ids = p.map((q, i) => gb.vertex(q[0], q[1], q[2], nx, ny, nz, i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0, color));
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
  };
  face([c(a, 1, -1), c(b, 1, -1), c(b, 1, 1), c(a, 1, 1)], sx, 0, sz);
  face([c(b, -1, -1), c(a, -1, -1), c(a, -1, 1), c(b, -1, 1)], -sx, 0, -sz);
  face([c(a, -1, 1), c(a, 1, 1), c(b, 1, 1), c(b, -1, 1)], ux, uy, uz);
  face([c(a, 1, -1), c(a, -1, -1), c(b, -1, -1), c(b, 1, -1)], -ux, -uy, -uz);
  face([c(a, -1, -1), c(a, 1, -1), c(a, 1, 1), c(a, -1, 1)], -fx, -fy, -fz);
  face([c(b, 1, -1), c(b, -1, -1), c(b, -1, 1), c(b, 1, 1)], fx, fy, fz);
}

// ---------------------------------------------------------------------------
// Sign atlas

/** Direction signs on the gantries: text and arrow (deg, 0 = up, 90 = right; null for none). */
export const GANTRY_SIGNS: readonly { text: string; sub: string; arrow: number }[] = [
  { text: 'DOWNTOWN', sub: 'CITY CENTER', arrow: 0 },
  { text: 'HARBOR', sub: 'DOCKS  BAYSIDE', arrow: -90 },
  { text: 'RIVERSIDE', sub: 'FLOOD CHANNEL', arrow: 90 },
  { text: 'AIRPORT', sub: 'EXPRESSWAY 9', arrow: 0 },
  { text: 'NEON AV', sub: 'MIDNIGHT SQ', arrow: -45 },
  { text: 'CHROME ST', sub: 'MARKET', arrow: 45 },
];
/** Message board texts (amber dot matrix). */
export const BOARD_TEXTS = ['NO RACING', 'DRIVE SAFE'] as const;

const SIGN_W = 1024;
const SIGN_H = 1024;
/** Atlas cells, two per row: name boards (rows 0-2), clearance and road closed plates (3), gantry signs (4-6), boards (7). */
const CELL_W = 512;
const CELL_H = 128;

/** UV rectangle of an atlas cell: [u0, v0, u1, v1]. */
export type Cell = [number, number, number, number];

function cellAt(col: number, row: number, wCells = 1, hCells = 1): Cell {
  const x0 = col * CELL_W + 3;
  const y0 = row * CELL_H + 3;
  const x1 = (col + wCells) * CELL_W - 3;
  const y1 = (row + hCells) * CELL_H - 3;
  return [x0 / SIGN_W, 1 - y1 / SIGN_H, x1 / SIGN_W, 1 - y0 / SIGN_H];
}

/** Name board of tunnel name i. */
export const nameCell = (i: number): Cell => cellAt(i % 2, Math.floor(i / 2));
/** The CLEARANCE plate. */
export const CLEARANCE_CELL: Cell = cellAt(0, 3);
/** The ROAD CLOSED plate on a viaduct's end. */
export const CLOSED_CELL: Cell = cellAt(1, 3);
/** Gantry direction sign i. */
export const gantryCell = (i: number): Cell => cellAt(i % 2, 4 + Math.floor(i / 2));
/** Message board i. */
export const boardCell = (i: number): Cell => cellAt(i % 2, 7);

/** Draw the sign atlas (a few milliseconds, once per scene). */
export function makeStructureSigns(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = SIGN_W;
  c.height = SIGN_H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIGN_W, SIGN_H);
  const fit = (text: string, max: number, size: number, weight = 'bold') => {
    let s = size;
    g.font = `${weight} ${s}px "Arial Narrow", Arial, sans-serif`;
    while (g.measureText(text).width > max && s > 14) {
      s -= 2;
      g.font = `${weight} ${s}px "Arial Narrow", Arial, sans-serif`;
    }
  };
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Tunnel name boards: white on deep blue with a pale border (backlit).
  TUNNEL_NAMES.map((n) => n.toUpperCase()).forEach((name, i) => {
    const x = (i % 2) * CELL_W;
    const y = Math.floor(i / 2) * CELL_H;
    g.fillStyle = '#0d2a5c';
    g.fillRect(x, y, CELL_W, CELL_H);
    g.strokeStyle = '#d8e4ff';
    g.lineWidth = 6;
    g.strokeRect(x + 10, y + 10, CELL_W - 20, CELL_H - 20);
    g.fillStyle = '#f4f7ff';
    fit(name, CELL_W - 70, 68);
    g.fillText(name, x + CELL_W / 2, y + CELL_H / 2 + 3);
  });
  // Clearance plate: black on yellow with chevrons.
  {
    const x = 0;
    const y = 3 * CELL_H;
    g.fillStyle = '#f2c230';
    g.fillRect(x, y, CELL_W, CELL_H);
    g.fillStyle = '#111';
    for (let k = 0; k < 6; k++) {
      g.beginPath();
      g.moveTo(x + k * 22, y);
      g.lineTo(x + k * 22 + 11, y);
      g.lineTo(x + k * 22 + 11 - 40, y + CELL_H);
      g.lineTo(x + k * 22 - 40, y + CELL_H);
      g.fill();
    }
    fit(`CLEARANCE 20'-4"`, CELL_W - 170, 60);
    g.fillText(`CLEARANCE 20'-4"`, x + CELL_W / 2 + 40, y + CELL_H / 2 + 3);
  }
  // Road closed plate: red and white stripes with lettering.
  {
    const x = CELL_W;
    const y = 3 * CELL_H;
    for (let k = -4; k < 30; k++) {
      g.fillStyle = k % 2 ? '#e8e8e8' : '#c81e1e';
      g.beginPath();
      g.moveTo(x + k * 24, y);
      g.lineTo(x + k * 24 + 24, y);
      g.lineTo(x + k * 24 + 24 - 60, y + CELL_H);
      g.lineTo(x + k * 24 - 60, y + CELL_H);
      g.fill();
    }
    g.fillStyle = '#111';
    g.fillRect(x + 120, y + 30, CELL_W - 240, CELL_H - 60);
    g.fillStyle = '#fff';
    fit('ROAD CLOSED', CELL_W - 260, 50);
    g.fillText('ROAD CLOSED', x + CELL_W / 2, y + CELL_H / 2 + 2);
  }
  // Gantry direction signs: white on highway green, an arrow on the left.
  GANTRY_SIGNS.forEach((s, i) => {
    const x = (i % 2) * CELL_W;
    const y = (4 + Math.floor(i / 2)) * CELL_H;
    g.fillStyle = '#0b6b3a';
    g.fillRect(x, y, CELL_W, CELL_H);
    g.strokeStyle = '#f2f2f2';
    g.lineWidth = 5;
    g.strokeRect(x + 8, y + 8, CELL_W - 16, CELL_H - 16);
    g.fillStyle = '#f7f7f7';
    fit(s.text, CELL_W - 190, 56);
    g.fillText(s.text, x + CELL_W / 2 + 40, y + 50);
    fit(s.sub, CELL_W - 190, 30, 'normal');
    g.fillText(s.sub, x + CELL_W / 2 + 40, y + 96);
    // Arrow: shaft and head, rotated.
    g.save();
    g.translate(x + 70, y + CELL_H / 2);
    g.rotate((s.arrow * Math.PI) / 180);
    g.beginPath();
    g.moveTo(-9, 34);
    g.lineTo(9, 34);
    g.lineTo(9, -6);
    g.lineTo(24, -6);
    g.lineTo(0, -38);
    g.lineTo(-24, -6);
    g.lineTo(-9, -6);
    g.closePath();
    g.fill();
    g.restore();
  });
  // Message boards: amber dot matrix on black.
  BOARD_TEXTS.forEach((text, i) => {
    const x = i * CELL_W;
    const y = 7 * CELL_H;
    g.fillStyle = '#060606';
    g.fillRect(x, y, CELL_W, CELL_H);
    g.fillStyle = '#ffb020';
    fit(text, CELL_W - 80, 64);
    g.fillText(text, x + CELL_W / 2, y + CELL_H / 2 + 3);
    // Break the glyphs into dots.
    g.fillStyle = '#060606';
    for (let yy = y + 4; yy < y + CELL_H; yy += 7) g.fillRect(x, yy, CELL_W, 2);
    for (let xx = x + 4; xx < x + CELL_W; xx += 7) g.fillRect(xx, y, 2, CELL_H);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** A sign panel facing (nx, nz): centered at (x, y, z), w wide, h tall, its atlas cell, tinted by color. */
export function signPanel(gb: GeoBuilder, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, cell: Cell, color: THREE.Color): void {
  // The viewer's right as they face the sign (looking along -n).
  const rx = nz;
  const rz = -nx;
  const a = gb.vertex(x - rx * (w / 2), y - h / 2, z - rz * (w / 2), nx, 0, nz, cell[0], cell[1], color);
  const b = gb.vertex(x + rx * (w / 2), y - h / 2, z + rz * (w / 2), nx, 0, nz, cell[2], cell[1], color);
  const c = gb.vertex(x + rx * (w / 2), y + h / 2, z + rz * (w / 2), nx, 0, nz, cell[2], cell[3], color);
  const d = gb.vertex(x - rx * (w / 2), y + h / 2, z - rz * (w / 2), nx, 0, nz, cell[0], cell[3], color);
  gb.quadFacing(a, b, c, d, nx, 0, nz);
}
