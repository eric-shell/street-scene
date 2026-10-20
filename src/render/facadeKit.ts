/**
 * Facade kit: procedural street level architecture for building podiums.
 * The bottom 2-4 floors of every building get a different treatment from the
 * office/apartment grid above: storefronts, lobbies, arched entries, shutters
 * and restaurants on the ground floor; offices, karaoke bars and arched
 * windows on the mezzanine floors; plus 3D trim (cornice, pilasters, awnings,
 * canopies) and light spill on the sidewalk. Render only.
 */
import * as THREE from 'three';
import { Rng } from '../sim/prng';
import { GeoBuilder } from './geoBuilder';
import { kelvin } from './textures';

/** Ground floor bay variants (atlas row 0). */
export const GROUND_BAYS = ['shopWarm', 'shopCool', 'arch', 'lobby', 'shutter', 'restaurant', 'masonry', 'neonShop'] as const;
/** Upper podium floor variants (atlas row 1). */
export const PODIUM_FLOORS = ['office', 'archWindows', 'karaoke', 'brick'] as const;

export const GROUND_H = 4.4;
export const PODIUM_FLOOR_H = 3.3;
const BAY_W = 5;

const CELL = 256;
const ATLAS_W = CELL * 8;
const ATLAS_H = CELL * 2;
/** Cell heights in pixels: ground cells are 5m x 4.4m, podium floor cells 5m x 3.3m. */
const GROUND_PX = Math.round((CELL * GROUND_H) / BAY_W);
const FLOOR_PX = Math.round((CELL * PODIUM_FLOOR_H) / BAY_W);

export interface FacadeKitTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

/** Bake every bay variant into a color atlas and a matching emissive atlas. */
export function makeFacadeKitTextures(seed: number): FacadeKitTextures {
  const rng = new Rng(seed ^ 0xfacade);
  const color = document.createElement('canvas');
  const emit = document.createElement('canvas');
  color.width = emit.width = ATLAS_W;
  color.height = emit.height = ATLAS_H;
  const c = color.getContext('2d')!;
  const e = emit.getContext('2d')!;
  e.fillStyle = '#000';
  e.fillRect(0, 0, ATLAS_W, ATLAS_H);
  c.fillStyle = '#2a2c34';
  c.fillRect(0, 0, ATLAS_W, ATLAS_H);

  const glass = (x: number, y: number, w: number, h: number, lit: string | null, alpha = 1) => {
    c.fillStyle = '#0d121c';
    c.fillRect(x, y, w, h);
    if (lit) {
      const g = e.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, lit);
      g.addColorStop(1, 'rgba(0,0,0,0.2)');
      e.globalAlpha = alpha;
      e.fillStyle = g;
      e.fillRect(x, y, w, h);
      e.globalAlpha = 1;
    }
  };
  const mullions = (x: number, y: number, w: number, h: number, n: number, col = '#55596a') => {
    c.fillStyle = col;
    e.fillStyle = '#000';
    for (let i = 0; i <= n; i++) {
      const xx = x + (w * i) / n - 2;
      c.fillRect(xx, y, 4, h);
      e.fillRect(xx, y, 4, h);
    }
    c.fillRect(x, y - 2, w, 4);
    e.fillRect(x, y - 2, w, 4);
  };
  const masonry = (x: number, y: number, w: number, h: number, base: string, joint: string, brick: boolean) => {
    c.fillStyle = base;
    c.fillRect(x, y, w, h);
    c.strokeStyle = joint;
    c.lineWidth = 1;
    const rowH = brick ? 8 : 22;
    for (let yy = y; yy < y + h; yy += rowH) {
      c.beginPath();
      c.moveTo(x, yy);
      c.lineTo(x + w, yy);
      c.stroke();
      const off = ((yy - y) / rowH) % 2 ? (brick ? 10 : 30) : 0;
      for (let xx = x + off; xx < x + w; xx += brick ? 20 : 60) {
        c.beginPath();
        c.moveTo(xx, yy);
        c.lineTo(xx, yy + rowH);
        c.stroke();
      }
    }
  };
  const archPath = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => {
    const r = w / 2;
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arc(x + r, y + r, r, Math.PI, 0);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  };

  // ----- Row 0: ground floor bays -----
  GROUND_BAYS.forEach((variant, i) => {
    const x = i * CELL;
    const y = 0;
    const H = GROUND_PX;
    const W = CELL;
    // Base wall and plinth
    masonry(x, y, W, H, variant === 'masonry' ? '#3b3532' : '#34363f', 'rgba(0,0,0,0.35)', variant === 'masonry');
    c.fillStyle = '#1d1e24';
    c.fillRect(x, y + H - 14, W, 14);
    // Sign band (shop sign area above windows)
    const band = (col: string, glow: boolean) => {
      c.fillStyle = '#121318';
      c.fillRect(x + 10, y + 12, W - 20, 30);
      if (glow) {
        e.fillStyle = col;
        e.globalAlpha = 0.9;
        e.fillRect(x + 18, y + 18, W - 36, 18);
        e.globalAlpha = 1;
      }
    };
    switch (variant) {
      case 'shopWarm':
      case 'shopCool': {
        band(variant === 'shopWarm' ? '#ffb347' : '#e8f6ff', true);
        const lit = variant === 'shopWarm' ? kelvin(3000) : kelvin(5600);
        glass(x + 14, y + 52, W - 90, H - 70, lit, 0.95);
        mullions(x + 14, y + 52, W - 90, H - 70, 3);
        // door
        glass(x + W - 66, y + 52, 50, H - 66, lit, 0.8);
        c.fillStyle = '#777';
        c.fillRect(x + W - 26, y + 52 + (H - 66) / 2, 4, 14);
        // display shelves silhouettes
        e.fillStyle = 'rgba(0,0,0,0.45)';
        for (let k = 0; k < 3; k++) e.fillRect(x + 20, y + 100 + k * 30, W - 104, 5);
        break;
      }
      case 'arch': {
        c.fillStyle = '#4a4440';
        c.fillRect(x + 20, y + 10, W - 40, H - 24);
        archPath(c, x + 46, y + 30, W - 92, H - 44);
        c.fillStyle = '#0d1018';
        c.fill();
        archPath(e, x + 50, y + 34, W - 100, H - 48);
        const g = e.createRadialGradient(x + W / 2, y + H - 20, 10, x + W / 2, y + H - 20, H);
        g.addColorStop(0, kelvin(2700));
        g.addColorStop(1, '#3a1d05');
        e.fillStyle = g;
        e.fill();
        // keystone and voussoir ring
        c.strokeStyle = '#6b625a';
        c.lineWidth = 8;
        archPath(c, x + 42, y + 26, W - 84, H - 36);
        c.stroke();
        c.fillStyle = '#7d736a';
        c.fillRect(x + W / 2 - 10, y + 18, 20, 22);
        break;
      }
      case 'lobby': {
        c.fillStyle = '#23252c';
        c.fillRect(x, y, W, H - 14);
        glass(x + 30, y + 40, W - 60, H - 54, kelvin(4600), 0.85);
        mullions(x + 30, y + 40, W - 60, H - 54, 4, '#8a8f99');
        e.fillStyle = kelvin(6200);
        e.fillRect(x + 22, y + 26, W - 44, 6);
        // revolving door hint
        c.strokeStyle = '#9aa';
        c.lineWidth = 3;
        c.beginPath();
        c.arc(x + W / 2, y + H - 40, 24, Math.PI, 0);
        c.stroke();
        break;
      }
      case 'shutter': {
        c.fillStyle = '#5b5f68';
        c.fillRect(x + 14, y + 40, W - 28, H - 54);
        c.fillStyle = 'rgba(0,0,0,0.35)';
        for (let yy = y + 44; yy < y + H - 14; yy += 7) c.fillRect(x + 14, yy, W - 28, 2);
        // graffiti tag
        const hue = rng.int(0, 360);
        c.strokeStyle = `hsl(${hue},90%,60%)`;
        c.lineWidth = 6;
        c.beginPath();
        c.moveTo(x + 40, y + 140);
        c.bezierCurveTo(x + 90, y + 90, x + 120, y + 190, x + 200, y + 120);
        c.stroke();
        e.fillStyle = kelvin(2200);
        e.globalAlpha = 0.6;
        e.fillRect(x + W / 2 - 10, y + 24, 20, 8);
        e.globalAlpha = 1;
        break;
      }
      case 'restaurant': {
        band('#ff3b3b', true);
        glass(x + 20, y + 56, W - 40, H - 76, kelvin(2700), 0.85);
        mullions(x + 20, y + 56, W - 40, H - 76, 2);
        // paper lanterns
        for (let k = 0; k < 3; k++) {
          const lx = x + 50 + k * 75;
          e.fillStyle = '#ff4030';
          e.beginPath();
          e.ellipse(lx, y + 64, 12, 16, 0, 0, Math.PI * 2);
          e.fill();
        }
        // noren curtain
        c.fillStyle = '#7a1414';
        for (let k = 0; k < 5; k++) c.fillRect(x + W / 2 - 50 + k * 21, y + 56, 18, 46);
        break;
      }
      case 'masonry': {
        for (let k = 0; k < 2; k++) {
          const wx = x + 40 + k * 110;
          c.fillStyle = '#5a504a';
          c.fillRect(wx - 6, y + 56, 72, 92);
          glass(wx, y + 62, 60, 80, rng.chance(0.5) ? kelvin(rng.range(2400, 3400)) : null, 0.6);
          c.fillStyle = '#222';
          for (let b = 1; b < 4; b++) c.fillRect(wx + b * 15, y + 62, 3, 80);
        }
        break;
      }
      case 'neonShop': {
        band('#ff3df2', true);
        glass(x + 14, y + 52, W - 28, H - 70, kelvin(4000), 0.75);
        mullions(x + 14, y + 52, W - 28, H - 70, 2);
        e.strokeStyle = '#22e6ff';
        e.lineWidth = 5;
        e.strokeRect(x + 24, y + 62, W - 48, H - 90);
        break;
      }
    }
  });

  // ----- Row 1: upper podium floors -----
  PODIUM_FLOORS.forEach((variant, i) => {
    const x = i * CELL;
    const y = CELL;
    const H = FLOOR_PX;
    const W = CELL;
    switch (variant) {
      case 'office': {
        c.fillStyle = '#3a3e48';
        c.fillRect(x, y, W, H);
        const lit = rng.chance(0.6);
        glass(x + 8, y + 24, W - 16, H - 52, lit ? kelvin(rng.range(4500, 6500)) : null, 0.55);
        mullions(x + 8, y + 24, W - 16, H - 52, 6, '#6d7380');
        break;
      }
      case 'archWindows': {
        masonry(x, y, W, H, '#4b433d', 'rgba(0,0,0,0.3)', false);
        for (let k = 0; k < 3; k++) {
          const wx = x + 22 + k * 76;
          archPath(c, wx, y + 22, 56, H - 40);
          c.fillStyle = '#0d1018';
          c.fill();
          if (rng.chance(0.55)) {
            archPath(e, wx + 4, y + 26, 48, H - 48);
            e.fillStyle = kelvin(rng.range(2400, 3200));
            e.globalAlpha = 0.75;
            e.fill();
            e.globalAlpha = 1;
          }
        }
        break;
      }
      case 'karaoke': {
        c.fillStyle = '#2b2233';
        c.fillRect(x, y, W, H);
        glass(x + 10, y + 26, W - 20, H - 50, kelvin(3400), 0.7);
        mullions(x + 10, y + 26, W - 20, H - 50, 4, '#3a2a40');
        e.fillStyle = '#7cf2ff';
        e.fillRect(x + 10, y + 14, W - 20, 5);
        break;
      }
      case 'brick': {
        masonry(x, y, W, H, '#5a3a30', 'rgba(0,0,0,0.35)', true);
        for (let k = 0; k < 2; k++) {
          const wx = x + 36 + k * 112;
          c.fillStyle = '#c9c2b8';
          c.fillRect(wx - 4, y + 30, 80, 6);
          glass(wx, y + 36, 72, H - 64, rng.chance(0.5) ? kelvin(rng.range(2700, 4200)) : null, 0.65);
          mullions(wx, y + 36, 72, H - 64, 2, '#c9c2b8');
        }
        break;
      }
    }
  });

  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const emissive = new THREE.CanvasTexture(emit);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.anisotropy = 4;
  return { map, emissive };
}

function cellUv(row: 0 | 1, variant: number): { u0: number; u1: number; v0: number; v1: number } {
  const u0 = (variant * CELL) / ATLAS_W;
  const u1 = ((variant + 1) * CELL) / ATLAS_W;
  const topPx = row * CELL;
  const hPx = row === 0 ? GROUND_PX : FLOOR_PX;
  // canvas y down -> uv v up (flipY)
  return { u0, u1, v1: 1 - topPx / ATLAS_H, v0: 1 - (topPx + hPx) / ATLAS_H };
}

export interface PodiumFace {
  /** Face corners along the wall (bottom), outward normal, ground height. */
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
  y0: number;
  /** Bottom of the building box (below street level); the ground floor extends down to it. */
  yBase: number;
  /** Faces toward a street get the full storefront treatment. */
  front: boolean;
}

export interface PodiumOutput {
  /** Atlas mapped podium surfaces. */
  walls: GeoBuilder;
  /** Dark stone trim: cornices, pilasters, canopies. */
  trim: GeoBuilder;
  /** Colored awnings (vertex colors). */
  awnings: GeoBuilder;
  /** Additive light spill quads on the sidewalk (vertex colors). */
  spill: GeoBuilder;
}

export function createPodiumOutput(): PodiumOutput {
  return { walls: new GeoBuilder(), trim: new GeoBuilder(true), awnings: new GeoBuilder(true), spill: new GeoBuilder(true) };
}

const AWNING_COLORS = [0x8a1c2b, 0x1c4a8a, 0x1f6b3a, 0x7a5a12, 0x5a1f7a, 0x222222].map((c) => new THREE.Color(c));
const SPILL: Record<string, string> = { shopWarm: kelvin(3000), shopCool: kelvin(5600), arch: kelvin(2700), lobby: kelvin(4600), restaurant: kelvin(2700), neonShop: kelvin(4000) };

/** Pick how many podium floors a building gets (ground + 1..3). */
export function podiumFloors(rng: Rng, height: number): number {
  const maxFloors = Math.floor((height - GROUND_H) / PODIUM_FLOOR_H) - 1;
  return Math.max(0, Math.min(maxFloors, rng.int(1, 3)));
}

/** Total podium height for a floor count. */
export function podiumHeight(floors: number): number {
  return GROUND_H + floors * PODIUM_FLOOR_H;
}

function box(gb: GeoBuilder, cx: number, cy: number, cz: number, ux: number, uz: number, hw: number, hh: number, hd: number, color: THREE.Color): void {
  // oriented box: u along (ux, uz), w = outward normal (-uz, ux) * sign handled by caller
  const wx = -uz;
  const wz = ux;
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  const pts = corners.map(([a, b]) => ({ x: cx + ux * a + wx * b, z: cz + uz * a + wz * b }));
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    const mx = (p.x + q.x) / 2 - cx;
    const mz = (p.z + q.z) / 2 - cz;
    const ml = Math.hypot(mx, mz) || 1;
    const nx = mx / ml;
    const nz = mz / ml;
    const v0 = gb.vertex(p.x, cy - hh, p.z, nx, 0, nz, 0, 0, color);
    const v1 = gb.vertex(q.x, cy - hh, q.z, nx, 0, nz, 0, 0, color);
    const v2 = gb.vertex(q.x, cy + hh, q.z, nx, 0, nz, 0, 0, color);
    const v3 = gb.vertex(p.x, cy + hh, p.z, nx, 0, nz, 0, 0, color);
    gb.quadFacing(v0, v1, v2, v3, nx, 0, nz);
  }
  for (const [y, ny] of [
    [cy + hh, 1],
    [cy - hh, -1],
  ] as [number, number][]) {
    const v = pts.map((p) => gb.vertex(p.x, y, p.z, 0, ny, 0, 0, 0, color));
    gb.quadFacing(v[0], v[1], v[2], v[3], 0, ny, 0);
  }
}

/**
 * Random small protrusions for each podium level (ground floor first). The
 * same values must be used for all four faces of a building so the corners
 * close up. Kept under the 0.6 m setback from the sidewalk wall line.
 */
export function podiumExtrusions(rng: Rng, floors: number): number[] {
  const ground = rng.range(0.15, 0.8);
  const out = [ground];
  let prev = ground;
  for (let k = 0; k < floors; k++) {
    // Upper levels continue, step back toward the tower, or bulge out as a bay.
    const r = rng.next();
    const e = r < 0.3 ? prev : r < 0.7 ? Math.max(0.02, prev - rng.range(0.15, 0.6)) : Math.min(1.15, prev + rng.range(0.1, 0.45));
    out.push(e);
    prev = e;
  }
  return out;
}

/** Emit podium geometry for one building face. Writes into `out`. */
export function addPodiumFace(out: PodiumOutput, f: PodiumFace, floors: number, rng: Rng, ext: number[] = []): void {
  const baseLen = Math.hypot(f.bx - f.ax, f.bz - f.az);
  if (baseLen < 1) return;
  const ux = (f.bx - f.ax) / baseLen;
  const uz = (f.bz - f.az) / baseLen;
  const trimColor = new THREE.Color(0x24252c).multiplyScalar(rng.range(0.8, 1.3));
  const floorVariant = rng.int(0, PODIUM_FLOORS.length - 1);
  const bays = Math.max(1, Math.round(baseLen / BAY_W));
  // A building tends to repeat one storefront type with an occasional entrance.
  const mainBay = f.front ? rng.int(0, GROUND_BAYS.length - 1) : 6;
  const entranceBay = f.front ? rng.int(0, bays - 1) : -1;
  const entranceType = rng.pick([2, 3]);
  const variants: number[] = [];
  for (let b = 0; b < bays; b++) {
    let v = b === entranceBay ? entranceType : mainBay;
    if (f.front && v !== entranceType && rng.chance(0.18)) v = rng.int(0, GROUND_BAYS.length - 1);
    variants.push(v);
  }
  const extAt = (level: number) => ext[Math.min(level, ext.length - 1)] ?? 0;
  /** Face line for a level, pushed out by e and lengthened by e at both ends so corners meet. */
  const lineFor = (e: number) => ({
    ax: f.ax - ux * e + f.nx * e,
    az: f.az - uz * e + f.nz * e,
    bx: f.bx + ux * e + f.nx * e,
    bz: f.bz + uz * e + f.nz * e,
    len: baseLen + 2 * e,
  });
  const quad = (gb: GeoBuilder, l: ReturnType<typeof lineFor>, s0: number, s1: number, y0: number, y1: number, uv: ReturnType<typeof cellUv>) => {
    const p0 = { x: l.ax + ux * s0, z: l.az + uz * s0 };
    const p1 = { x: l.ax + ux * s1, z: l.az + uz * s1 };
    const a = gb.vertex(p0.x, y0, p0.z, f.nx, 0, f.nz, uv.u0, uv.v0);
    const b = gb.vertex(p1.x, y0, p1.z, f.nx, 0, f.nz, uv.u1, uv.v0);
    const c = gb.vertex(p1.x, y1, p1.z, f.nx, 0, f.nz, uv.u1, uv.v1);
    const d = gb.vertex(p0.x, y1, p0.z, f.nx, 0, f.nz, uv.u0, uv.v1);
    gb.quadFacing(a, b, c, d, f.nx, 0, f.nz);
  };
  /** Horizontal strip between offsets e0 and e1 at height y (a ledge or a soffit). */
  const ledge = (e0: number, e1: number, y: number, up: boolean) => {
    if (Math.abs(e1 - e0) < 0.01) return;
    const lo = lineFor(Math.min(e0, e1));
    const hi = lineFor(Math.max(e0, e1));
    const ny = up ? 1 : -1;
    const v = [
      [lo.ax, lo.az],
      [lo.bx, lo.bz],
      [hi.bx, hi.bz],
      [hi.ax, hi.az],
    ].map(([x, z]) => out.trim.vertex(x, y, z, 0, ny, 0, 0, 0, trimColor));
    out.trim.quadFacing(v[0], v[1], v[2], v[3], 0, ny, 0);
  };

  // Front faces get individually protruding ground floor bays (shopfront boxes, entries).
  const flat = !f.front || rng.chance(0.3);
  const bayExtra = variants.map(() => (flat ? 0 : rng.pick([0, 0, 0.18, 0.32, 0.5])));
  const trimSide = (x: number, z: number, nx: number, nz: number, w: number, y0: number, y1: number) => {
    // vertical strip w meters out from (x, z) along the face normal
    const v = [
      [x, y0, z],
      [x + f.nx * w, y0, z + f.nz * w],
      [x + f.nx * w, y1, z + f.nz * w],
      [x, y1, z],
    ].map(([px, py, pz]) => out.trim.vertex(px, py, pz, nx, 0, nz, 0, 0, trimColor));
    out.trim.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
  };
  for (let level = 0; level <= floors; level++) {
    const e = extAt(level);
    const l = lineFor(e);
    const bayLen = l.len / bays;
    const y0 = level === 0 ? f.yBase : f.y0 + GROUND_H + (level - 1) * PODIUM_FLOOR_H;
    const y1 = level === 0 ? f.y0 + GROUND_H : y0 + PODIUM_FLOOR_H;
    for (let b = 0; b < bays; b++) {
      const uv = level === 0 ? cellUv(0, variants[b]) : cellUv(1, floorVariant);
      if (level === 0 && bayExtra[b] > 0) {
        const x = bayExtra[b];
        const lb = { ...l, ax: l.ax + f.nx * x, az: l.az + f.nz * x, bx: l.bx + f.nx * x, bz: l.bz + f.nz * x };
        quad(out.walls, lb, b * bayLen + 0.01, (b + 1) * bayLen - 0.01, y0, y1, uv);
        // cap on top of the protruding bay
        const p0 = { x: l.ax + ux * b * bayLen, z: l.az + uz * b * bayLen };
        const p1 = { x: l.ax + ux * (b + 1) * bayLen, z: l.az + uz * (b + 1) * bayLen };
        const cap = [
          [p0.x, p0.z],
          [p1.x, p1.z],
          [p1.x + f.nx * x, p1.z + f.nz * x],
          [p0.x + f.nx * x, p0.z + f.nz * x],
        ].map(([px, pz]) => out.trim.vertex(px, y1, pz, 0, 1, 0, 0, 0, trimColor));
        out.trim.quadFacing(cap[0], cap[1], cap[2], cap[3], 0, 1, 0);
      } else {
        quad(out.walls, l, b * bayLen + 0.01, (b + 1) * bayLen - 0.01, y0, y1, uv);
      }
      if (level === 0) {
        // side walls where neighbouring bays protrude by different amounts
        const prev = b === 0 ? 0 : bayExtra[b - 1];
        const d = bayExtra[b] - prev;
        if (Math.abs(d) > 0.01) {
          const px = l.ax + ux * b * bayLen + f.nx * Math.min(prev, bayExtra[b]);
          const pz = l.az + uz * b * bayLen + f.nz * Math.min(prev, bayExtra[b]);
          trimSide(px, pz, d > 0 ? -ux : ux, d > 0 ? -uz : uz, Math.abs(d), y0, y1);
        }
        if (b === bays - 1 && bayExtra[b] > 0.01) trimSide(l.bx, l.bz, ux, uz, bayExtra[b], y0, y1);
      }
      if (f.front && b > 0) {
        const p = { x: l.ax + ux * b * bayLen, z: l.az + uz * b * bayLen };
        box(out.trim, p.x + f.nx * 0.12, (y0 + y1) / 2, p.z + f.nz * 0.12, ux, uz, 0.2, (y1 - y0) / 2, 0.14, trimColor);
      }
    }
    // Step between this level and the next (or the tower above the podium).
    const top = y1;
    const next = level < floors ? extAt(level + 1) : 0;
    if (next < e) ledge(next, e, top, true);
    else ledge(e, next, top, false);
    if (level === 0 && floors > 0) {
      const cx = (l.ax + l.bx) / 2;
      const cz = (l.az + l.bz) / 2;
      box(out.trim, cx + f.nx * 0.08, top + 0.06, cz + f.nz * 0.08, ux, uz, l.len / 2, 0.08, 0.1, trimColor);
    }
  }
  // Cornice at the top of the podium, at the top level's face line.
  {
    const e = extAt(floors);
    const l = lineFor(e);
    const top = f.y0 + podiumHeight(floors);
    box(out.trim, (l.ax + l.bx) / 2 + f.nx * 0.18, top + 0.2, (l.az + l.bz) / 2 + f.nz * 0.18, ux, uz, l.len / 2 + 0.2, 0.22, 0.2, trimColor);
  }
  if (!f.front) return;

  // Ground floor dressing: awnings, lobby canopies, light spill.
  const e0 = extAt(0);
  const l0 = lineFor(e0);
  const bayLen = l0.len / bays;
  for (let b = 0; b < bays; b++) {
    const name = GROUND_BAYS[variants[b]];
    const mx = l0.ax + ux * (b + 0.5) * bayLen + f.nx * (0.02 + bayExtra[b]);
    const mz = l0.az + uz * (b + 0.5) * bayLen + f.nz * (0.02 + bayExtra[b]);
    if ((name === 'shopWarm' || name === 'restaurant' || name === 'shopCool' || name === 'neonShop') && rng.chance(0.65)) {
      const col = AWNING_COLORS[rng.int(0, AWNING_COLORS.length - 1)];
      const depth = 1.3;
      const yTop = f.y0 + GROUND_H - 0.5;
      const yLow = yTop - 0.7;
      const hw = bayLen / 2 - 0.25;
      const q = [
        [mx - ux * hw, yTop, mz - uz * hw],
        [mx + ux * hw, yTop, mz + uz * hw],
        [mx + ux * hw + f.nx * depth, yLow, mz + uz * hw + f.nz * depth],
        [mx - ux * hw + f.nx * depth, yLow, mz - uz * hw + f.nz * depth],
      ];
      const ny = 0.88;
      const v = q.map(([x, y, z]) => out.awnings.vertex(x, y, z, f.nx * 0.47, ny, f.nz * 0.47, 0, 0, col));
      out.awnings.quadFacing(v[0], v[1], v[2], v[3], f.nx, ny, f.nz);
      out.awnings.quadFacing(v[0], v[3], v[2], v[1], -f.nx, -ny, -f.nz);
      const vl = [
        [q[3][0], yLow, q[3][2]],
        [q[2][0], yLow, q[2][2]],
        [q[2][0], yLow - 0.3, q[2][2]],
        [q[3][0], yLow - 0.3, q[3][2]],
      ].map(([x, y, z]) => out.awnings.vertex(x, y, z, f.nx, 0, f.nz, 0, 0, col.clone().multiplyScalar(0.8)));
      out.awnings.quadFacing(vl[0], vl[1], vl[2], vl[3], f.nx, 0, f.nz);
    }
    if (name === 'lobby') {
      box(out.trim, mx + f.nx * 1.2, f.y0 + GROUND_H - 0.6, mz + f.nz * 1.2, ux, uz, bayLen / 2 - 0.3, 0.12, 1.2, trimColor);
    }
    const spill = SPILL[name];
    if (spill !== undefined) {
      const col = new THREE.Color(spill).multiplyScalar(0.35);
      const hw = bayLen / 2;
      const d = 3.2;
      const y = f.y0 + 0.2;
      const q = [
        [mx - ux * hw + f.nx * 0.1, mz - uz * hw + f.nz * 0.1, 1],
        [mx + ux * hw + f.nx * 0.1, mz + uz * hw + f.nz * 0.1, 1],
        [mx + ux * hw * 1.2 + f.nx * d, mz + uz * hw * 1.2 + f.nz * d, 0],
        [mx - ux * hw * 1.2 + f.nx * d, mz - uz * hw * 1.2 + f.nz * d, 0],
      ];
      const v = q.map(([x, z, k]) => out.spill.vertex(x, y, z, 0, 1, 0, 0, 0, col.clone().multiplyScalar(k)));
      out.spill.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
  }
}
