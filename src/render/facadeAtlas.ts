/**
 * Facade atlas: one texture array layer per architectural facade (brick
 * walk-up, deco piers, curtain wall, stucco, Victorian clapboard, Miami
 * deco...), plus the fire escape cutout and the rooftop billboard ads.
 *
 * A layer is 8 x 8 "modules", one module being one window bay by one floor.
 * The channels are not colors but weights, so a building's palette is applied
 * in the shader (facadeMaterial.ts) and stays correct at every mip level:
 *   R  wall luminance   (times the building's wall tint)
 *   G  trim luminance   (times its trim color: sills, lintels, frames, mullions)
 *   B  glass luminance  (times its glass color)
 *   A  glass coverage   (where interior light can show, and where it is glossy)
 * Window lighting is procedural per module (lit, color temperature, blinds,
 * TV flicker), so the texture holds only shapes and every building lights up
 * differently. Painting happens once per session (no seed in it) and the
 * result is shared by every city.
 */
import * as THREE from 'three';

/** Texture array layer per facade. */
export const LAYER = {
  brick: 0,
  blank: 1,
  deco: 2,
  glass: 3,
  stucco: 4,
  stuccoArch: 5,
  ribbon: 6,
  miami: 7,
  victorian: 8,
  stone: 9,
  condo: 10,
  mansard: 11,
} as const;
export type FacadeLayer = keyof typeof LAYER;
const LAYER_COUNT = 12;

/** Size of one module in meters (bay width x floor height) per layer, as the painter assumes. */
export const MODULE: Record<FacadeLayer, { bay: number; floor: number }> = {
  brick: { bay: 2.5, floor: 3.2 },
  blank: { bay: 3, floor: 3.2 },
  deco: { bay: 1.9, floor: 3.4 },
  glass: { bay: 1.6, floor: 3.8 },
  stucco: { bay: 3, floor: 3.2 },
  stuccoArch: { bay: 3, floor: 3.2 },
  ribbon: { bay: 3.6, floor: 3.3 },
  miami: { bay: 3.2, floor: 3.2 },
  victorian: { bay: 2.2, floor: 3.6 },
  stone: { bay: 2.8, floor: 3.9 },
  condo: { bay: 2.4, floor: 3.1 },
  mansard: { bay: 2.8, floor: 4 },
};

/** Modules per layer edge, and pixels per module. */
export const MODULES = 8;
const PX = 64;
const SIZE = MODULES * PX;

/** Tiny deterministic generator so the atlas looks the same every session. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'wall' | 'trim' | 'glass';

/**
 * Paints one layer: a color canvas (channel weights) and an alpha canvas
 * (glass coverage). Coordinates are meters inside a module, y down from the
 * ceiling line, so a window sill sits near y = floor.
 */
class LayerPainter {
  readonly c: CanvasRenderingContext2D;
  readonly a: CanvasRenderingContext2D;
  /** Module origin in px and px per meter. */
  ox = 0;
  oy = 0;
  sx = 1;
  sy = 1;
  constructor(
    readonly color: HTMLCanvasElement,
    readonly alpha: HTMLCanvasElement,
    readonly m: { bay: number; floor: number },
  ) {
    // CPU backed: thousands of small fills, then one readback each.
    this.c = color.getContext('2d', { willReadFrequently: true })!;
    this.a = alpha.getContext('2d', { willReadFrequently: true })!;
    this.c.fillStyle = '#000';
    this.c.fillRect(0, 0, SIZE, SIZE);
    this.a.fillStyle = '#000';
    this.a.fillRect(0, 0, SIZE, SIZE);
  }
  module(i: number, j: number): void {
    this.ox = i * PX;
    this.oy = j * PX;
    this.sx = PX / this.m.bay;
    this.sy = PX / this.m.floor;
  }
  private style(kind: Kind, lum: number): void {
    const v = Math.round(Math.max(0, Math.min(1, lum)) * 255);
    this.c.fillStyle = kind === 'wall' ? `rgb(${v},0,0)` : kind === 'trim' ? `rgb(0,${v},0)` : `rgb(0,0,${v})`;
    this.c.strokeStyle = this.c.fillStyle;
    this.a.fillStyle = kind === 'glass' ? '#fff' : '#000';
    this.a.strokeStyle = this.a.fillStyle;
  }
  /** Rectangle in module meters. Glass rectangles also set the coverage. */
  rect(kind: Kind, lum: number, x: number, y: number, w: number, h: number): void {
    this.style(kind, lum);
    const X = this.ox + x * this.sx;
    const Y = this.oy + y * this.sy;
    this.c.fillRect(X, Y, w * this.sx, h * this.sy);
    this.a.fillRect(X, Y, w * this.sx, h * this.sy);
  }
  /** Glass that is opaque (spandrel glass): glass color but no light behind it. */
  darkGlass(lum: number, x: number, y: number, w: number, h: number): void {
    this.rect('glass', lum, x, y, w, h);
    this.a.fillStyle = '#000';
    this.a.fillRect(this.ox + x * this.sx, this.oy + y * this.sy, w * this.sx, h * this.sy);
  }
  /** Round-topped window (arch radius w/2) whose bottom is at y + h. */
  arch(kind: Kind, lum: number, x: number, y: number, w: number, h: number): void {
    this.style(kind, lum);
    const r = w / 2;
    for (const ctx of [this.c, this.a]) {
      ctx.beginPath();
      // Ellipse in px space: meters scale differently on the two axes.
      ctx.moveTo(this.ox + x * this.sx, this.oy + (y + h) * this.sy);
      ctx.lineTo(this.ox + x * this.sx, this.oy + (y + r) * this.sy);
      ctx.ellipse(this.ox + (x + r) * this.sx, this.oy + (y + r) * this.sy, r * this.sx, r * this.sy, 0, Math.PI, 0);
      ctx.lineTo(this.ox + (x + w) * this.sx, this.oy + (y + h) * this.sy);
      ctx.closePath();
      ctx.fill();
    }
  }
  circle(kind: Kind, lum: number, cx: number, cy: number, r: number): void {
    this.style(kind, lum);
    for (const ctx of [this.c, this.a]) {
      ctx.beginPath();
      ctx.ellipse(this.ox + cx * this.sx, this.oy + cy * this.sy, r * this.sx, r * this.sy, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  /** Closed polygon in module meters. */
  poly(kind: Kind, lum: number, pts: [number, number][]): void {
    this.style(kind, lum);
    for (const ctx of [this.c, this.a]) {
      ctx.beginPath();
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(this.ox + x * this.sx, this.oy + y * this.sy) : ctx.moveTo(this.ox + x * this.sx, this.oy + y * this.sy)));
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** A window with frame, sash bars and an optional head (lintel / hood) and sill, all in trim. */
function sash(p: LayerPainter, x: number, y: number, w: number, h: number, opts: { frame?: number; bars?: number; vbar?: boolean; head?: number; sill?: number; glass?: number; trim?: number }): void {
  const f = opts.frame ?? 0.07;
  const trim = opts.trim ?? 0.9;
  if (opts.head) p.rect('trim', trim * 0.92, x - 0.12, y - opts.head, w + 0.24, opts.head);
  p.rect('trim', trim, x - f, y - f, w + 2 * f, h + 2 * f);
  p.rect('glass', opts.glass ?? 0.1, x, y, w, h);
  const bars = opts.bars ?? 1;
  for (let k = 1; k <= bars; k++) p.rect('trim', trim, x, y + (h * k) / (bars + 1) - 0.025, w, 0.05);
  if (opts.vbar) p.rect('trim', trim, x + w / 2 - 0.025, y, 0.05, h);
  if (opts.sill) p.rect('trim', trim * 0.95, x - 0.1, y + h + f, w + 0.2, opts.sill);
}

/** Brick: courses every `course` m, bricks with a little luminance jitter. */
function brickWall(p: LayerPainter, rnd: () => number, lum: number, course = 0.24): void {
  const { bay, floor } = p.m;
  for (let y = 0; y < floor - 1e-6; y += course) {
    const off = Math.round(y / course) % 2 ? 0.25 : 0;
    for (let x = -off; x < bay; x += 0.5) p.rect('wall', lum * (0.86 + rnd() * 0.22), Math.max(0, x), y, Math.min(0.48, bay - Math.max(0, x)), course - 0.035);
  }
}

function stuccoWall(p: LayerPainter, rnd: () => number, lum: number): void {
  const { bay, floor } = p.m;
  p.rect('wall', lum, 0, 0, bay, floor);
  // Blotches: hand-troweled plaster reads as soft variation, never as pattern.
  for (let k = 0; k < 6; k++) p.rect('wall', lum * (0.9 + rnd() * 0.16), rnd() * bay, rnd() * floor, 0.3 + rnd() * 0.8, 0.2 + rnd() * 0.5);
}

const PAINTERS: Record<FacadeLayer, (p: LayerPainter, i: number, j: number, rnd: () => number) => void> = {
  // NYC / Philly walk-up: double-hung windows with stone lintels and sills.
  brick(p, i, _j, rnd) {
    brickWall(p, rnd, 0.62);
    const w = i % 4 === 3 ? 0.95 : 1.1;
    sash(p, (2.5 - w) / 2, 0.75, w, 1.75, { head: 0.2, sill: 0.09, bars: 1, trim: 0.85 });
  },
  // Party wall: bare brick, a rare small window, and one faded ghost sign per layer.
  blank(p, i, j, rnd) {
    brickWall(p, rnd, 0.58, 0.26);
    if ((i * 7 + j * 3) % 9 === 0) sash(p, 1, 0.9, 0.8, 1.2, { sill: 0.08, trim: 0.7 });
    if (j >= 2 && j <= 3 && i >= 1 && i <= 5) {
      // Ghost sign band (painted later as text across modules); darken the plaster under it.
      p.rect('wall', 0.4, 0, 0.2, 3, 2.8);
    }
  },
  // Art deco: limestone piers, recessed window strips, dark spandrels with chevrons.
  deco(p, _i, j, rnd) {
    const { bay, floor } = p.m;
    p.rect('wall', 0.78, 0, 0, bay, floor);
    const pier = 0.32;
    p.rect('wall', 0.5, pier, 0, bay - 2 * pier, floor);
    sash(p, pier + 0.08, 0.3, bay - 2 * pier - 0.16, 2.15, { frame: 0.04, bars: 1, trim: 0.55, glass: 0.09 });
    // Spandrel panel with a chevron relief.
    p.rect('wall', 0.36, pier, 2.55, bay - 2 * pier, floor - 2.55);
    const cx = bay / 2;
    p.poly('trim', 0.55 + (j % 2) * 0.1, [
      [cx - 0.45, 3.25],
      [cx, 2.7],
      [cx + 0.45, 3.25],
      [cx + 0.3, 3.25],
      [cx, 2.92],
      [cx - 0.3, 3.25],
    ]);
    p.rect('wall', 0.9 * (0.95 + rnd() * 0.08), 0, 0, pier * 0.55, floor);
  },
  // Curtain wall: vision glass, spandrel glass at the slab, slim mullions.
  glass(p, i, _j) {
    const { bay, floor } = p.m;
    p.rect('glass', 0.16 + (i % 3 === 0 ? 0.02 : 0), 0, 0, bay, floor);
    p.darkGlass(0.24, 0, floor - 0.95, bay, 0.95);
    p.rect('trim', 0.55, 0, 0, 0.06, floor);
    p.rect('trim', 0.4, 0, floor - 0.97, bay, 0.05);
    if (i % 2 === 0) p.rect('trim', 0.3, bay / 2 - 0.02, 0, 0.04, floor - 0.95);
  },
  // Stucco walk-up: deep-set casements with a shadowed reveal and a tile sill.
  stucco(p, i, _j, rnd) {
    stuccoWall(p, rnd, 0.82);
    const w = i % 3 === 1 ? 1.5 : 1.2;
    const x = (3 - w) / 2;
    p.rect('wall', 0.42, x - 0.1, 0.65, w + 0.2, 1.65);
    sash(p, x, 0.72, w, 1.5, { frame: 0.05, bars: 0, vbar: true, sill: 0.1, trim: 0.75 });
  },
  // Spanish revival: arched windows with a surround and a little wrought iron.
  stuccoArch(p, i, _j, rnd) {
    stuccoWall(p, rnd, 0.84);
    const w = 1.1;
    const x = (3 - w) / 2;
    p.arch('trim', 0.8, x - 0.12, 0.42, w + 0.24, 2.1);
    p.arch('glass', 0.1, x, 0.54, w, 1.98);
    p.rect('trim', 0.8, x + w / 2 - 0.025, 1.1, 0.05, 1.42);
    if (i % 2 === 0) {
      // Juliet balcony rail.
      p.rect('trim', 0.25, x - 0.2, 2.0, w + 0.4, 0.06);
      for (let k = 0; k <= 5; k++) p.rect('trim', 0.25, x - 0.2 + ((w + 0.4) * k) / 5, 2.0, 0.035, 0.5);
    }
  },
  // Mid-century: a continuous ribbon of glass per floor over a smooth spandrel band.
  ribbon(p, i, _j, rnd) {
    const { bay, floor } = p.m;
    stuccoWall(p, rnd, 0.8);
    p.rect('glass', 0.12, 0, 0.35, bay, 1.75);
    p.rect('trim', 0.7, 0, 0.32, bay, 0.05);
    p.rect('trim', 0.7, 0, 2.1, bay, 0.06);
    p.rect('trim', 0.6, 0, 0.35, 0.05, 1.75);
    if (i % 2) p.rect('trim', 0.6, bay / 2, 0.35, 0.04, 1.75);
    p.rect('wall', 0.62, 0, floor - 0.2, bay, 0.2);
  },
  // Miami deco: paired square windows, speed lines, a porthole now and then.
  miami(p, i, j, rnd) {
    const { bay } = p.m;
    stuccoWall(p, rnd, 0.9);
    for (let k = 0; k < 3; k++) p.rect('trim', 0.98, 0, 2.55 + k * 0.17, bay, 0.06);
    if ((i + j * 3) % 7 === 0) {
      p.circle('trim', 0.95, bay / 2, 1.35, 0.5);
      p.circle('glass', 0.1, bay / 2, 1.35, 0.4);
    } else {
      for (const x of [0.45, 1.85]) sash(p, x, 0.75, 0.9, 1.3, { frame: 0.06, bars: 0, vbar: true, trim: 0.95, glass: 0.11 });
    }
    // Vertical pilaster stripe at the module edge: deco's vertical accent.
    if (i % 4 === 0) p.rect('trim', 0.92, 0, 0, 0.18, p.m.floor);
  },
  // SF Victorian: clapboard siding, tall narrow windows with hoods and brackets.
  victorian(p, i, _j) {
    const { bay, floor } = p.m;
    for (let y = 0; y < floor; y += 0.2) p.rect('wall', Math.round(y / 0.2) % 2 ? 0.72 : 0.62, 0, y, bay, 0.2);
    const w = 0.85;
    const x = (bay - w) / 2;
    sash(p, x, 0.95, w, 2.05, { frame: 0.11, bars: 1, head: 0.28, sill: 0.12, trim: 0.95 });
    // Hood pediment.
    p.poly('trim', 0.92, [
      [x - 0.2, 0.62],
      [x + w / 2, 0.38],
      [x + w + 0.2, 0.62],
    ]);
    // Corner board and frieze band.
    if (i % 3 === 0) p.rect('trim', 0.95, 0, 0, 0.14, floor);
    p.rect('trim', 0.85, 0, 0, bay, 0.12);
  },
  // Second Empire / civic stone: rusticated courses, tall windows, alternating pediments.
  stone(p, i, _j, rnd) {
    const { bay, floor } = p.m;
    for (let y = 0; y < floor; y += 0.55) {
      const off = Math.round(y / 0.55) % 2 ? 0.7 : 0;
      for (let x = -off; x < bay; x += 1.4) p.rect('wall', 0.72 * (0.92 + rnd() * 0.12), Math.max(0, x), y, Math.min(1.36, bay - Math.max(0, x)), 0.51);
    }
    const w = 1.15;
    const x = (bay - w) / 2;
    sash(p, x, 1.0, w, 2.35, { frame: 0.08, bars: 2, vbar: true, sill: 0.14, trim: 0.92 });
    if (i % 2) p.poly('trim', 0.9, [
      [x - 0.25, 0.9],
      [x + w / 2, 0.45],
      [x + w + 0.25, 0.9],
    ]);
    else p.rect('trim', 0.9, x - 0.22, 0.62, w + 0.44, 0.28);
  },
  // Condo: floor to ceiling glass behind a bright slab edge.
  condo(p, i, _j) {
    const { bay, floor } = p.m;
    p.rect('glass', 0.13, 0, 0, bay, floor);
    p.rect('wall', 0.95, 0, floor - 0.45, bay, 0.45);
    p.rect('trim', 0.5, 0, 0, 0.05, floor - 0.45);
    if (i % 3 === 1) p.darkGlass(0.2, 0.05, 0, bay * 0.3, floor - 0.45);
  },
  // Mansard: slate scallops with one dormer window per module.
  mansard(p, i, _j) {
    const { bay, floor } = p.m;
    for (let y = 0; y < floor; y += 0.18) {
      const off = Math.round(y / 0.18) % 2 ? 0.15 : 0;
      for (let x = -off; x < bay; x += 0.3) p.rect('wall', (Math.round(y / 0.18) % 3 ? 0.42 : 0.36) + (x % 0.9) * 0.02, Math.max(0, x), y, 0.27, 0.15);
    }
    if (i % 4 !== 3) {
      const w = 0.85;
      const x = (bay - w) / 2;
      p.rect('wall', 0.55, x - 0.2, 0.7, w + 0.4, 2.4);
      sash(p, x, 1.1, w, 1.6, { frame: 0.09, bars: 1, trim: 0.9 });
      p.poly('trim', 0.88, [
        [x - 0.3, 0.95],
        [x + w / 2, 0.5],
        [x + w + 0.3, 0.95],
      ]);
    }
  },
};

/** Ghost signs on the party wall layer: faded painted ads from another century. */
const GHOST_SIGNS = ['HOTEL', 'CIGARS', 'BAKERY', 'FURNITURE', 'GARAGE', 'DRY GOODS'];

function paintGhostSign(p: LayerPainter, text: string): void {
  // Spans modules 1..5 of rows 2..3 (the darkened plaster band).
  const x0 = 1 * PX + 6;
  const y0 = 2 * PX + 14;
  const w = 5 * PX - 12;
  const h = 2 * PX - 28;
  for (const ctx of [p.c]) {
    ctx.save();
    ctx.fillStyle = 'rgb(0,150,0)';
    let size = 70;
    ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    while (ctx.measureText(text).width > w && size > 20) {
      size -= 4;
      ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + w / 2, y0 + h / 2);
    ctx.fillRect(x0, y0, w, 3);
    ctx.fillRect(x0, y0 + h - 3, w, 3);
    ctx.restore();
  }
}

export interface FacadeAtlas {
  /** RGBA weights per layer (see the module header); linear, mipmapped, repeating. */
  layers: THREE.DataArrayTexture;
  /** Black iron fire escape grating and rails (alpha cutout). */
  fireEscape: THREE.CanvasTexture;
  /** Rooftop billboard ads, BILLBOARD_COLS x BILLBOARD_ROWS cells. */
  billboards: THREE.CanvasTexture;
}

export const BILLBOARD_COLS = 2;
export const BILLBOARD_ROWS = 5;

let cached: FacadeAtlas | null = null;

/**
 * The shared atlas. Built on first use (about 20-40 ms of canvas work) and
 * kept for the session: it does not depend on the seed, so later cities
 * reuse it, and nobody disposes it.
 */
export function facadeAtlas(): FacadeAtlas {
  if (cached) return cached;
  const data = new Uint8Array(SIZE * SIZE * 4 * LAYER_COUNT);
  const color = document.createElement('canvas');
  const alpha = document.createElement('canvas');
  color.width = alpha.width = SIZE;
  color.height = alpha.height = SIZE;
  (Object.keys(LAYER) as FacadeLayer[]).forEach((name) => {
    const layer = LAYER[name];
    const rnd = mulberry(0xfa5ade + layer * 977);
    const p = new LayerPainter(color, alpha, MODULE[name]);
    for (let j = 0; j < MODULES; j++) {
      for (let i = 0; i < MODULES; i++) {
        p.module(i, j);
        PAINTERS[name](p, i, j, rnd);
      }
    }
    if (name === 'blank') paintGhostSign(p, GHOST_SIGNS[Math.floor(rnd() * GHOST_SIGNS.length)]);
    const rgb = p.c.getImageData(0, 0, SIZE, SIZE).data;
    const cov = p.a.getImageData(0, 0, SIZE, SIZE).data;
    const base = layer * SIZE * SIZE * 4;
    // Canvas rows run top down; texture rows bottom up (v up the facade).
    for (let y = 0; y < SIZE; y++) {
      const src = y * SIZE * 4;
      const dst = base + (SIZE - 1 - y) * SIZE * 4;
      for (let x = 0; x < SIZE * 4; x += 4) {
        data[dst + x] = rgb[src + x];
        data[dst + x + 1] = rgb[src + x + 1];
        data[dst + x + 2] = rgb[src + x + 2];
        data[dst + x + 3] = cov[src + x];
      }
    }
  });
  const layers = new THREE.DataArrayTexture(data, SIZE, SIZE, LAYER_COUNT);
  layers.format = THREE.RGBAFormat;
  layers.type = THREE.UnsignedByteType;
  layers.colorSpace = THREE.NoColorSpace;
  layers.wrapS = layers.wrapT = THREE.RepeatWrapping;
  layers.magFilter = THREE.LinearFilter;
  layers.minFilter = THREE.LinearMipmapLinearFilter;
  layers.generateMipmaps = true;
  layers.anisotropy = 4;
  layers.needsUpdate = true;
  cached = { layers, fireEscape: makeFireEscape(), billboards: makeBillboards() };
  return cached;
}

/**
 * Fire escape cutout, 256 x 256: top half is the railing (bars and a top
 * rail), bottom half the platform grating and the stair stringer with treads.
 */
function makeFireEscape(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#16171b';
  // Railing (v 0.5..1): top rail, mid rail, balusters.
  g.fillRect(0, 2, 256, 9);
  g.fillRect(0, 64, 256, 5);
  g.fillRect(0, 118, 256, 8);
  for (let x = 0; x < 256; x += 16) g.fillRect(x, 2, 4, 124);
  // Grating / stair (v 0..0.5): stringers and treads.
  g.fillRect(0, 128, 256, 8);
  g.fillRect(0, 246, 256, 10);
  for (let y = 140; y < 246; y += 13) g.fillRect(0, y, 256, 6);
  g.fillRect(0, 128, 8, 128);
  g.fillRect(248, 128, 8, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

const ADS: { text: string; sub: string; bg: [string, string]; fg: string; accent: string }[] = [
  { text: 'NITRO COLA', sub: 'TASTE THE BOOST', bg: ['#b3001b', '#ff3d3d'], fg: '#fff', accent: '#ffe14d' },
  { text: 'MIDNIGHT FM', sub: '104.7  ALL NIGHT', bg: ['#1a0b3d', '#5a1fa8'], fg: '#ff4fd8', accent: '#22e6ff' },
  { text: 'HYPERION', sub: 'PERFORMANCE TIRES', bg: ['#0b0b0f', '#30323c'], fg: '#ffd400', accent: '#ffffff' },
  { text: 'VOLT', sub: 'ENERGY DRINK', bg: ['#003b2f', '#00b894'], fg: '#eaff00', accent: '#ffffff' },
  { text: 'SUNSET MOTEL', sub: 'VACANCY  POOL  TV', bg: ['#ff7a18', '#af002d'], fg: '#fff3d6', accent: '#ffe14d' },
  { text: 'APEX', sub: 'TUNING  DYNO  WRAPS', bg: ['#04243f', '#0a6bd6'], fg: '#ffffff', accent: '#19e6ff' },
  { text: 'CHROME DINER', sub: 'OPEN 24 HOURS', bg: ['#e8e8ee', '#9aa0ad'], fg: '#c4002b', accent: '#111' },
  { text: 'PALM BEACH', sub: 'FLY TONIGHT', bg: ['#00c6cf', '#ff6fb5'], fg: '#ffffff', accent: '#fff6a8' },
  { text: 'LUCKY STAR', sub: 'CASINO & LOUNGE', bg: ['#2a0000', '#7a0010'], fg: '#ffcf3d', accent: '#ff3b6b' },
  { text: 'ORBIT', sub: 'THE NEW PHONE', bg: ['#000000', '#1b1b2a'], fg: '#ffffff', accent: '#a66bff' },
];

/** Rooftop billboard ads (fake brands from this game's world), 4:1 cells. */
function makeBillboards(): THREE.CanvasTexture {
  const cw = 512;
  const ch = 128;
  const c = document.createElement('canvas');
  c.width = cw * BILLBOARD_COLS;
  c.height = ch * BILLBOARD_ROWS;
  const g = c.getContext('2d')!;
  ADS.forEach((ad, k) => {
    const x = (k % BILLBOARD_COLS) * cw;
    const y = Math.floor(k / BILLBOARD_COLS) * ch;
    const grd = g.createLinearGradient(x, y, x + cw, y + ch);
    grd.addColorStop(0, ad.bg[0]);
    grd.addColorStop(1, ad.bg[1]);
    g.fillStyle = grd;
    g.fillRect(x, y, cw, ch);
    // A bold shape for the eye at distance: a sweep, a disc or a stripe.
    g.save();
    g.beginPath();
    g.rect(x, y, cw, ch);
    g.clip();
    g.fillStyle = ad.accent;
    g.globalAlpha = 0.85;
    if (k % 3 === 0) {
      g.beginPath();
      g.arc(x + cw - 70, y + ch / 2, 48, 0, Math.PI * 2);
      g.fill();
    } else if (k % 3 === 1) {
      g.beginPath();
      g.moveTo(x + cw - 170, y + ch);
      g.lineTo(x + cw - 90, y);
      g.lineTo(x + cw - 60, y);
      g.lineTo(x + cw - 140, y + ch);
      g.fill();
    } else {
      g.fillRect(x, y + ch - 18, cw, 8);
    }
    g.restore();
    g.globalAlpha = 1;
    g.fillStyle = ad.fg;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    let size = 64;
    g.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    while (g.measureText(ad.text).width > cw - 150 && size > 24) {
      size -= 3;
      g.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    }
    g.fillText(ad.text, x + 22, y + 78);
    g.font = `700 22px "Arial Black", sans-serif`;
    g.globalAlpha = 0.9;
    g.fillText(ad.sub, x + 24, y + 108);
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 6;
    g.strokeRect(x + 3, y + 3, cw - 6, ch - 6);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
