/**
 * Interior atlas: the rooms behind the glass of the ground floor shop bays (interior mapping).
 *
 * Eight rooms (bodega, diner, lobby, karaoke, garage, clothes shop, laundromat, bar) are painted as the five
 * inner faces of a box (back, left, right, floor, ceiling), one layer of a texture array each: 8 x 5 = 40
 * layers, 128 px square at Medium and 256 px at High (the 1024 and 2048 px atlases of a 5 x 8 cell grid, but
 * as an array so the mip chain never bleeds one face into the next). Faces are painted in metres on a canvas
 * with y up, so every painter thinks in the room's real size (`ROOM`); the shader (podiumMaterial.ts) walks a
 * view ray through the unit box and reads the face it hits. Each room has a light scheme matching the colour
 * temperature of the bays that can hold it (facadeKit's shopWarm 3000 K against shopCool 5600 K), and the
 * seed re-draws the details (product colours, garments, bottles, where the stools stand) from its own streams.
 *
 * `roomFor` is how a bay picks its room: a hash of where it stands, never the facade stream, so the podium
 * geometry of every seed is exactly what it was before the rooms. Render only (needs a DOM canvas).
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import { hexRgba, kelvin } from '../color';
import { pickSubset } from '../textures/cityMood';
import type { Detail } from './buildingKit';
import type { GroundBay } from './facadeKit';

/** The room box behind the glass, in metres (the painters' frame) and as fractions of the bay cell (the shader's frame). */
export const ROOM = {
  /** Width along the facade (the bay is 5 m). */
  w: 5,
  /** Height, floor to ceiling. */
  h: 3.2,
  /** Depth behind the glass plane. */
  d: 5,
  /** Floor level as a fraction of the cell's height (just above the plinth). */
  floor: 0.07,
  /** Ceiling level as a fraction of the cell's height (under the sign band). */
  ceiling: 0.79,
} as const;

/** How a bay's lights are rolled: the shares of closed shops and of closed ones that leave a night light on, and the light scales. */
export const ROOM_LIGHT = {
  /** Share of bays that are closed (dark inside). */
  closed: 0.12,
  /** Share of bays with a night light on (inside the closed ones). */
  nightLight: 0.05,
  /** Radiance scale of a closed bay. */
  closedGain: 0.06,
  /** Radiance scale of a closed bay with a night light on. */
  nightGain: 0.2,
  /** Radiance scale range of an open bay (a few rooms burn brighter than others). */
  openGain: [0.75, 1.25],
} as const;

/** Face names in layer order within a room (the shader indexes `room * 5 + face`). */
export const ROOM_FACES = ['back', 'left', 'right', 'floor', 'ceiling'] as const;
type Face = (typeof ROOM_FACES)[number];

/** Pixel size of one face per tier; Low has no rooms. */
export const FACE_PX: Record<Exclude<Detail, 'low'>, number> = { medium: 128, high: 256 };

export interface InteriorDef {
  /** Name of the room. */
  id: string;
  /** Colour temperature of its lamps (K): what it matches in the bay's own glow. */
  lamp: number;
  /** Ground bays that can hold it. */
  bays: readonly GroundBay[];
}

/** The rooms, in layer order. */
export const INTERIORS = [
  { id: 'bodega', lamp: 5200, bays: ['bodega', 'shopCool'] },
  { id: 'diner', lamp: 2700, bays: ['restaurant', 'shopWarm'] },
  { id: 'lobby', lamp: 4600, bays: ['lobby'] },
  { id: 'karaoke', lamp: 4000, bays: ['neonShop', 'decoShop'] },
  { id: 'garage', lamp: 5600, bays: ['shopCool'] },
  { id: 'clothes', lamp: 3000, bays: ['shopWarm', 'decoShop', 'neonShop'] },
  { id: 'laundromat', lamp: 6200, bays: ['shopCool', 'bodega'] },
  { id: 'bar', lamp: 2400, bays: ['shopWarm', 'restaurant', 'neonShop', 'decoShop'] },
] as const satisfies readonly InteriorDef[];

/** Rooms per bay kind, as indices into INTERIORS. */
const BAY_ROOMS: Partial<Record<GroundBay, number[]>> = {};
INTERIORS.forEach((def, i) => {
  for (const b of def.bays) (BAY_ROOMS[b] ??= []).push(i);
});

/** Bays that show a room behind their glass. */
export function hasRoom(bay: GroundBay): boolean {
  return BAY_ROOMS[bay] !== undefined;
}

/** A unit-interval hash of a position (no stream is consumed). */
function hash2(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 4) ^ 0x9e3779b1, 0x85ebca6b) ^ Math.imul(Math.round(z * 4) + salt, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/**
 * The room and light roll of the bay of kind `bay` centred at (x, z): the room index into INTERIORS and a
 * roll in [0, 1) the shader turns into the bay's light state (closed, night light, open and how bright), or
 * null for a bay without glass to look through.
 */
export function roomFor(bay: GroundBay, x: number, z: number): { room: number; roll: number } | null {
  const rooms = BAY_ROOMS[bay];
  if (!rooms) return null;
  return { room: rooms[Math.floor(hash2(x, z, 1) * rooms.length)], roll: hash2(x, z, 2) };
}

type G = CanvasRenderingContext2D;

/** What a painter gets: a canvas in metres (y up), the face's size in metres, a stream and the seed's palettes. */
interface Paint {
  g: G;
  r: Rng;
  w: number;
  h: number;
  pal: Palettes;
}

/** Colour pools one seed narrows to a subset (cityMood.pickSubset), so two cities stock their rooms differently. */
interface Palettes {
  goods: string[];
  garments: string[];
  bottles: string[];
  machines: string[];
}

const GOODS = ['#d94b3a', '#f2c230', '#3b7fd1', '#4cae5c', '#e8e4d8', '#c05ac8', '#ff8a3d', '#2fc5c0', '#8a5a3a'];
const GARMENTS = ['#c8372f', '#2f5fa8', '#e8e0d0', '#2f7a58', '#d8a22a', '#7a3a8a', '#1e1e24', '#d86a8a', '#8a8f98', '#e8742a'];
const BOTTLES = ['#a8651c', '#1f6a3a', '#2a58a8', '#d8d8c8', '#8a1f2a', '#c88a1c', '#3a7a8a', '#e8d070'];
const MACHINES = ['#e8eef2', '#d6dde2', '#f2f2ee', '#c8d0d8'];

function palettes(seed: number): Palettes {
  return {
    goods: pickSubset(GOODS, 6, seed, 'roomGoods'),
    garments: pickSubset(GARMENTS, 6, seed, 'roomGarments'),
    bottles: pickSubset(BOTTLES, 6, seed, 'roomBottles'),
    machines: pickSubset(MACHINES, 3, seed, 'roomMachines'),
  };
}

// ----- Canvas toolkit (metres, y up) -----

const rect = (g: G, x: number, y: number, w: number, h: number, fill: string) => {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
};
/** Vertical gradient from `bottom` at y to `top` at y + h. */
const vgrad = (g: G, x: number, y: number, w: number, h: number, bottom: string, top: string) => {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, bottom);
  gr.addColorStop(1, top);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
};
/** Soft light: an additive radial pool of `col` (a #rrggbb) with radius `rad` centred on (x, y). */
const glow = (g: G, x: number, y: number, rad: number, col: string, a = 1) => {
  g.save();
  g.globalCompositeOperation = 'lighter';
  const gr = g.createRadialGradient(x, y, 0, x, y, rad);
  gr.addColorStop(0, hexRgba(col, a));
  gr.addColorStop(1, hexRgba(col, 0));
  g.fillStyle = gr;
  g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  g.restore();
};
const disc = (g: G, x: number, y: number, rad: number, fill: string) => {
  g.fillStyle = fill;
  g.beginPath();
  g.arc(x, y, rad, 0, Math.PI * 2);
  g.fill();
};
const ellipse = (g: G, x: number, y: number, rx: number, ry: number, fill: string) => {
  g.fillStyle = fill;
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
};
const line = (g: G, x0: number, y0: number, x1: number, y1: number, col: string, wd: number) => {
  g.strokeStyle = col;
  g.lineWidth = wd;
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
};
/** Checker floor of `s` m squares. */
const checker = (g: G, w: number, h: number, s: number, a: string, b: string) => {
  for (let i = 0; i * s < w; i++) {
    for (let j = 0; j * s < h; j++) rect(g, i * s, j * s, s, s, (i + j) % 2 ? a : b);
  }
};
/** Darken the edges of a face by `a` over `reach` m: the corners of a real room are the dimmest part of it. */
const vignette = (g: G, w: number, h: number, a: number, reach = 0.7) => {
  const edges: [number, number, number, number, number, number, number, number][] = [
    [0, 0, reach, 0, 0, 0, reach, h],
    [w, 0, w - reach, 0, w - reach, 0, reach, h],
    [0, 0, 0, reach, 0, 0, w, reach],
    [0, h, 0, h - reach, 0, h - reach, w, reach],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, `rgba(0,0,0,${a})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(rx, ry, rw, rh);
  }
};
/** Rows of small goods on shelves: `rows` boards between y0 and y1, items from `x0` to `x1`. */
function shelving(p: Paint, x0: number, x1: number, y0: number, y1: number, rows: number, colors: readonly string[], board: string) {
  const { g, r } = p;
  const step = (y1 - y0) / rows;
  for (let k = 0; k < rows; k++) {
    const base = y0 + k * step;
    let x = x0;
    while (x < x1 - 0.1) {
      const iw = Math.min(r.range(0.1, 0.26), x1 - x);
      const ih = r.range(step * 0.5, step * 0.85);
      if (r.chance(0.9)) {
        const col = r.pick(colors);
        rect(g, x, base + 0.04, iw * 0.9, ih, col);
        rect(g, x, base + 0.04 + ih * 0.7, iw * 0.9, ih * 0.1, 'rgba(255,255,255,0.35)');
      }
      x += iw;
    }
    rect(g, x0 - 0.04, base, x1 - x0 + 0.08, 0.05, board);
  }
}
/** Bottles in rows lit from below: tall and short, colours from the palette, a bright glint on each. */
function bottleRows(p: Paint, x0: number, x1: number, y0: number, rows: number, gap: number) {
  const { g, r, pal } = p;
  for (let k = 0; k < rows; k++) {
    const base = y0 + k * gap;
    rect(g, x0 - 0.05, base - 0.04, x1 - x0 + 0.1, 0.05, '#caa56a');
    glow(g, (x0 + x1) / 2, base, (x1 - x0) * 0.45, '#ffcf8a', 0.35);
    for (let x = x0; x < x1; x += r.range(0.1, 0.16)) {
      const bh = r.range(gap * 0.5, gap * 0.8);
      const col = r.pick(pal.bottles);
      rect(g, x, base, 0.07, bh, col);
      rect(g, x + 0.02, base + bh, 0.03, 0.08, col);
      rect(g, x + 0.012, base + 0.03, 0.012, bh * 0.8, 'rgba(255,255,255,0.55)');
    }
  }
}
/** A downlight on a ceiling or its pool on a floor. */
const lamp = (g: G, x: number, y: number, rad: number, col: string, a: number) => {
  glow(g, x, y, rad, col, a);
  disc(g, x, y, rad * 0.14, '#fffbe8');
};
/** A fluorescent tube: a bright bar and its halo. */
const tube = (g: G, x: number, y: number, len: number, col: string, vertical = false) => {
  const w = vertical ? 0.1 : len;
  const h = vertical ? len : 0.1;
  glow(g, x + w / 2, y + h / 2, len * 0.5 + 0.4, col, 0.35);
  rect(g, x, y, w, h, '#ffffff');
};
const mul = (hex: string, k: number): string => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.round(Math.min(255, v * k));
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
};

// ----- Rooms. Every painter works on a face of its own size in metres; back is ROOM.w x ROOM.h, the sides ROOM.d x ROOM.h
// (x runs from the window to the back wall), floor and ceiling ROOM.w x ROOM.d (y runs from the window to the back wall).

type Painters = Record<Face, (p: Paint) => void>;

/** Side walls share a painter that gets which side it is. */
const sides = (fn: (p: Paint, left: boolean) => void): Pick<Painters, 'left' | 'right'> => ({ left: (p) => fn(p, true), right: (p) => fn(p, false) });

const BODEGA: Painters = {
  back(p) {
    const { g, r, w, h, pal } = p;
    vgrad(g, 0, 0, w, h, '#aab6bd', '#e6edf0');
    shelving(p, 0.25, w - 0.25, 0.3, 2.5, 4, pal.goods, '#6d747a');
    rect(g, 0.6, 2.62, w - 1.2, 0.4, '#f2c230');
    for (let k = 0; k < 5; k++) rect(g, 0.8 + k * 0.8, 2.7, 0.5, 0.24, r.pick(pal.goods));
    glow(g, w / 2, h, 3, kelvin(5200), 0.3);
    vignette(g, w, h, 0.4);
  },
  ...sides((p, left) => {
    const { g, r, w, h, pal } = p;
    vgrad(g, 0, 0, w, h, '#9aa6ad', '#dfe7ea');
    if (left) {
      // Drinks fridges: lit cases with glass doors, rows of cans and bottles.
      for (let x = 0.5; x < w - 0.5; x += 0.85) {
        rect(g, x, 0.25, 0.8, 2.3, '#2a2f35');
        vgrad(g, x + 0.05, 0.3, 0.7, 2.2, '#c8e2f2', '#f2fbff');
        for (let k = 0; k < 5; k++) {
          for (let c = 0; c < 6; c++) rect(g, x + 0.08 + c * 0.11, 0.38 + k * 0.42, 0.08, r.range(0.2, 0.34), r.pick(pal.goods));
          rect(g, x + 0.05, 0.34 + k * 0.42, 0.7, 0.03, 'rgba(60,70,80,0.7)');
        }
      }
    } else {
      // Counter with the register, the cigarette wall behind it.
      rect(g, 0.4, 0, 2.6, 1.05, '#7a5a3a');
      rect(g, 0.4, 1.02, 2.6, 0.08, '#d8d0c0');
      rect(g, 1.2, 1.1, 0.5, 0.32, '#2a2d33');
      shelving(p, 0.5, 2.9, 1.5, 2.5, 3, pal.goods, '#5a6068');
      rect(g, 3.6, 0.2, 0.8, 1.1, '#d8dee2');
      rect(g, 3.7, 1.35, 0.6, 0.4, '#ffd23a');
    }
    vignette(g, w, h, 0.4);
  }),
  floor(p) {
    const { g, w, h } = p;
    checker(g, w, h, 0.5, '#c9ced1', '#aeb4b8');
    // Gondola bases between the aisles.
    rect(g, 1.2, 0.6, 0.35, h - 1.2, 'rgba(40,46,52,0.55)');
    rect(g, 3.4, 0.6, 0.35, h - 1.2, 'rgba(40,46,52,0.55)');
    glow(g, w / 2, h * 0.4, 2.5, kelvin(5200), 0.25);
    vignette(g, w, h, 0.4);
  },
  ceiling(p) {
    const { g, w, h } = p;
    checker(g, w, h, 0.6, '#d8dfe2', '#c9d1d5');
    tube(g, 0.8, 1.2, 3.4, kelvin(5200));
    tube(g, 0.8, 3.5, 3.4, kelvin(5200));
    vignette(g, w, h, 0.35);
  },
};

const DINER: Painters = {
  back(p) {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, 1.2, '#4f9a94', '#6aa7a0');
    vgrad(g, 0, 1.2, w, h - 1.2, '#efe2c4', '#f6ecd2');
    // Pass-through window: stainless, bright, order tickets hanging in it.
    rect(g, 1.0, 1.05, 3.0, 1.45, '#9aa0a6');
    vgrad(g, 1.1, 1.15, 2.8, 1.25, '#ffd9a0', '#fff0cc');
    for (let k = 0; k < 7; k++) rect(g, 1.3 + k * 0.36, 1.9 + r.range(0, 0.15), 0.18, 0.4, '#f6f2e6');
    rect(g, 1.0, 1.05, 3.0, 0.1, '#6a7076');
    // Menu board and the pie case.
    rect(g, 0.25, 2.2, 0.6, 0.7, '#2a2a2e');
    for (let k = 0; k < 4; k++) rect(g, 0.33, 2.3 + k * 0.15, 0.4, 0.06, '#f2e6b8');
    rect(g, 4.15, 0.3, 0.7, 0.8, '#c8d8e0');
    for (let k = 0; k < 3; k++) rect(g, 4.22, 0.4 + k * 0.25, 0.56, 0.16, r.pick(['#d8a050', '#c85a3a', '#e8c878']));
    glow(g, 2.5, 1.8, 2.4, kelvin(2700), 0.3);
    vignette(g, w, h, 0.4);
  },
  ...sides((p, left) => {
    const { g, w, h } = p;
    vgrad(g, 0, 0, w, 1.1, '#4f9a94', '#6aa7a0');
    vgrad(g, 0, 1.1, w, h - 1.1, '#efe2c4', '#f6ecd2');
    if (left) {
      // Booths: red vinyl backs with the table between, a pendant lamp over each.
      for (let x = 0.4; x < w - 1; x += 1.6) {
        rect(g, x, 0.2, 1.3, 0.95, '#a8282c');
        rect(g, x, 0.7, 1.3, 0.08, '#c8484c');
        rect(g, x + 0.15, 1.0, 1.0, 0.05, '#e8e4dc');
        glow(g, x + 0.65, 2.1, 0.9, kelvin(2700), 0.5);
        line(g, x + 0.65, 2.3, x + 0.65, h, '#2a2a2a', 0.02);
        disc(g, x + 0.65, 2.15, 0.14, '#fff4d0');
      }
    } else {
      // Counter along the wall: the front panel, chrome rail and round stools.
      rect(g, 0.3, 0, w - 0.6, 1.0, '#b82a30');
      rect(g, 0.3, 0.96, w - 0.6, 0.1, '#d8d4cc');
      rect(g, 0.3, 0.2, w - 0.6, 0.04, '#b8bcc0');
      for (let x = 0.7; x < w - 0.5; x += 0.8) {
        rect(g, x, 0.25, 0.06, 0.55, '#b8bcc0');
        ellipse(g, x + 0.03, 0.85, 0.2, 0.07, '#d8383c');
      }
      glow(g, w / 2, 1.6, 2.6, kelvin(2700), 0.3);
    }
    vignette(g, w, h, 0.4);
  }),
  floor(p) {
    const { g, w, h } = p;
    checker(g, w, h, 0.45, '#efe6d0', '#b8383c');
    for (const x of [1.2, 3.2]) glow(g, x, h * 0.45, 1.6, kelvin(2700), 0.3);
    vignette(g, w, h, 0.4);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#efe6d2');
    rect(g, 0.3, h * 0.45, w - 0.6, 0.08, '#ff6a5a');
    for (const [x, y] of [[1.0, 1.5], [2.5, 1.5], [4.0, 1.5], [1.0, 3.5], [2.5, 3.5], [4.0, 3.5]]) lamp(g, x, y, 0.9, kelvin(2700), 0.55);
    vignette(g, w, h, 0.35);
  },
};

const LOBBY: Painters = {
  back(p) {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#7d8087', '#a8aab0');
    for (let k = 0; k < 14; k++) line(g, r.range(0, w), 0, r.range(0, w), h, 'rgba(255,255,255,0.12)', r.range(0.01, 0.03));
    // Reception desk under a lit logo panel.
    rect(g, 1.0, 0, 3.0, 1.1, '#2c2622');
    rect(g, 1.0, 1.06, 3.0, 0.1, '#d8d2c6');
    rect(g, 1.0, 0.3, 3.0, 0.03, '#ffd9a0');
    rect(g, 1.7, 1.8, 1.6, 0.7, '#f4f6fa');
    rect(g, 1.85, 2.1, 1.3, 0.1, '#3a6ab0');
    rect(g, 1.85, 1.95, 0.6, 0.06, '#3a6ab0');
    glow(g, 2.5, 2.15, 1.8, kelvin(5600), 0.4);
    // Potted plants either side.
    for (const x of [0.55, 4.45]) {
      rect(g, x - 0.2, 0, 0.4, 0.55, '#d8d2c6');
      for (let k = 0; k < 9; k++) ellipse(g, x + r.range(-0.3, 0.3), r.range(0.7, 1.7), 0.14, 0.32, r.pick(['#2f7a3a', '#3f9a4a', '#1f5a2a']));
    }
    vignette(g, w, h, 0.45);
  },
  ...sides((p, left) => {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#74777e', '#9fa1a8');
    if (left) {
      // Two lift doors with indicator lights.
      for (const x of [1.4, 2.6]) {
        rect(g, x, 0, 1.0, 2.3, '#b8bcc2');
        rect(g, x + 0.49, 0, 0.02, 2.3, '#585c62');
        rect(g, x + 0.3, 2.4, 0.4, 0.1, r.chance(0.5) ? '#ff7a4a' : '#7aff9a');
      }
    } else {
      // Framed art on the long wall and a bench under it.
      for (let x = 0.7; x < w - 1; x += 1.4) {
        rect(g, x, 1.2, 0.9, 0.8, '#1c1c1e');
        rect(g, x + 0.06, 1.26, 0.78, 0.68, r.pick(['#d8603a', '#3a78c8', '#e8c040']));
      }
      rect(g, 0.6, 0, w - 1.2, 0.5, '#2c2622');
    }
    for (let k = 0; k < 3; k++) glow(g, 1.0 + k * 1.5, h - 0.1, 1.2, kelvin(4600), 0.4);
    vignette(g, w, h, 0.45);
  }),
  floor(p) {
    const { g, w, h } = p;
    checker(g, w, h, 0.8, '#cfcbc4', '#8e8c88');
    for (const [x, y] of [[1.2, 1.4], [3.8, 1.4], [1.2, 3.6], [3.8, 3.6]]) glow(g, x, y, 1.3, kelvin(4600), 0.55);
    rect(g, 1.0, 0.5, 3.0, 0.9, 'rgba(0,0,0,0.25)');
    vignette(g, w, h, 0.35);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#3a3c42');
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) lamp(g, 0.9 + i * 1.6, 0.9 + j * 1.6, 0.7, kelvin(4600), 0.7);
    vignette(g, w, h, 0.3);
  },
};

const KARAOKE: Painters = {
  back(p) {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#150c26', '#2a1646');
    // The screen: a pink-to-cyan wash, lyric lines in white, a glow into the room.
    const gr = g.createLinearGradient(0.8, 0, 4.2, 0);
    gr.addColorStop(0, '#ff3fb0');
    gr.addColorStop(1, '#2fd8ff');
    g.fillStyle = gr;
    g.fillRect(0.8, 0.9, 3.4, 1.8);
    for (let k = 0; k < 4; k++) rect(g, 1.2 + r.range(0, 0.5), 1.1 + k * 0.38, r.range(1.4, 2.4), 0.14, 'rgba(255,255,255,0.9)');
    rect(g, 1.2, 2.4, 2.6, 0.08, '#ffe14d');
    glow(g, 2.5, 1.8, 3.2, '#d070ff', 0.45);
    // Speakers either side of it.
    for (const x of [0.15, 4.35]) {
      rect(g, x, 0.2, 0.5, 1.5, '#16131c');
      disc(g, x + 0.25, 0.6, 0.15, '#2e2a38');
      disc(g, x + 0.25, 1.2, 0.1, '#2e2a38');
    }
    vignette(g, w, h, 0.4);
  },
  ...sides((p, left) => {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#150c26', '#2a1646');
    if (left) {
      // A curved sofa along the wall, a table lamp.
      rect(g, 0.4, 0.15, w - 0.8, 0.85, '#6a2f9a');
      rect(g, 0.4, 0.15, w - 0.8, 0.3, '#52247a');
      for (let x = 1.0; x < w - 0.6; x += 1.1) rect(g, x, 0.5, 0.04, 0.45, '#3a1858');
    } else {
      rect(g, 0.8, 0.5, 2.6, 1.8, '#2a2438');
      glow(g, 2.1, 1.4, 1.6, '#7ae8ff', 0.4);
      for (let k = 0; k < 5; k++) line(g, 0.8, 0.7 + k * 0.35, 3.4, 0.5 + r.range(0.7, 1.2), 'rgba(160,240,255,0.5)', 0.02);
    }
    for (let k = 0; k < 3; k++) line(g, 0.2, 2.6 - k * 0.2, w - 0.2, 2.6 - k * 0.2, k % 2 ? '#2fd8ff' : '#ff3fb0', 0.06);
    glow(g, w * 0.5, 2.6, 2.4, '#b050ff', 0.25);
    vignette(g, w, h, 0.4);
  }),
  floor(p) {
    const { g, r, w, h } = p;
    rect(g, 0, 0, w, h, '#150e22');
    // Mirror ball spots wandering over the floor.
    for (let k = 0; k < 16; k++) glow(g, r.range(0.3, w - 0.3), r.range(0.3, h - 0.3), r.range(0.2, 0.45), r.pick(['#ff3fb0', '#2fd8ff', '#ffe14d', '#b050ff']), 0.7);
    rect(g, 1.2, 0.8, 2.6, 0.9, '#2a1a3e');
    vignette(g, w, h, 0.35);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#0e0818');
    for (let k = 0; k < 4; k++) line(g, 0.4, 0.8 + k * 1.1, w - 0.4, 0.8 + k * 1.1, k % 2 ? '#2fd8ff' : '#ff3fb0', 0.08);
    glow(g, w / 2, h / 2, 2.2, '#ffffff', 0.55);
    disc(g, w / 2, h / 2, 0.25, '#f4f0ff');
    vignette(g, w, h, 0.3);
  },
};

const GARAGE: Painters = {
  back(p) {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#8a9096', '#c4c9cd');
    // Pegboard of tools over a row of red tool chests.
    rect(g, 2.8, 1.5, 2.0, 1.4, '#a8aeb2');
    for (let k = 0; k < 9; k++) rect(g, 2.9 + k * 0.2, 1.7 + r.range(0, 0.6), 0.05, r.range(0.3, 0.7), '#2a2d33');
    for (let x = 2.9; x < 4.7; x += 0.62) {
      rect(g, x, 0, 0.58, 1.2, '#c8302a');
      for (let k = 0; k < 4; k++) rect(g, x + 0.04, 0.1 + k * 0.26, 0.5, 0.02, '#6a1814');
      rect(g, x + 0.2, 0.2, 0.18, 0.03, '#d8d8d8');
    }
    // The roller door, ribbed, a strip of night light under it.
    rect(g, 0.3, 0, 2.2, 2.7, '#7a8086');
    for (let y = 0.1; y < 2.7; y += 0.12) rect(g, 0.3, y, 2.2, 0.025, 'rgba(0,0,0,0.3)');
    rect(g, 0.3, 0, 2.2, 0.06, '#1c2a44');
    vignette(g, w, h, 0.45);
  },
  ...sides((p, left) => {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#868c92', '#c0c5c9');
    if (left) {
      // Workbench with a vise under a rack of hanging tools.
      rect(g, 0.4, 0.8, 2.6, 0.12, '#4a3a2a');
      rect(g, 0.4, 0, 0.1, 0.8, '#2a2d33');
      rect(g, 2.9, 0, 0.1, 0.8, '#2a2d33');
      rect(g, 0.4, 1.4, 2.6, 1.0, '#9aa0a4');
      for (let k = 0; k < 14; k++) rect(g, 0.5 + k * 0.18, 1.5 + r.range(0, 0.4), 0.04, r.range(0.3, 0.55), '#2a2d33');
    } else {
      // The two-post lift: a yellow column with an arm, a stack of tyres beside it.
      rect(g, 1.3, 0, 0.3, 2.9, '#e8b82a');
      rect(g, 1.3, 1.0, 1.6, 0.12, '#e8b82a');
      for (let k = 0; k < 4; k++) ellipse(g, 3.8, 0.12 + k * 0.22, 0.42, 0.11, '#1c1d20');
      rect(g, 3.4, 0, 0.8, 0.9, 'rgba(0,0,0,0.0)');
    }
    vignette(g, w, h, 0.45);
  }),
  floor(p) {
    const { g, r, w, h } = p;
    rect(g, 0, 0, w, h, '#7d8185');
    for (let k = 0; k < 8; k++) ellipse(g, r.range(0.5, w - 0.5), r.range(0.5, h - 0.5), r.range(0.2, 0.5), r.range(0.1, 0.3), 'rgba(20,22,26,0.35)');
    rect(g, 0.15, 0, 0.07, h, '#e8c62a');
    rect(g, w - 0.22, 0, 0.07, h, '#e8c62a');
    // The car on the lift, seen from above: body, glass and lamps.
    g.fillStyle = '#2c4a7a';
    g.beginPath();
    g.roundRect(1.3, 0.9, 2.4, 3.5, 0.35);
    g.fill();
    rect(g, 1.5, 1.7, 2.0, 1.2, '#10161e');
    rect(g, 1.45, 1.0, 0.4, 0.1, '#fff4c0');
    rect(g, 3.15, 1.0, 0.4, 0.1, '#fff4c0');
    rect(g, 1.3, 1.0, 0.1, 3.3, '#e8b82a');
    vignette(g, w, h, 0.4);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#9aa0a4');
    for (let k = 0; k < 3; k++) tube(g, 0.8, 0.8 + k * 1.6, 3.4, kelvin(5600));
    vignette(g, w, h, 0.35);
  },
};

const CLOTHES: Painters = {
  back(p) {
    const { g, r, w, h, pal } = p;
    vgrad(g, 0, 0, w, h, '#b8a68e', '#e8dcc6');
    // Folded stacks on shelves.
    for (let k = 0; k < 3; k++) {
      const y = 0.4 + k * 0.7;
      rect(g, 0.3, y - 0.04, 2.4, 0.05, '#7a5a3a');
      for (let x = 0.35; x < 2.6; x += 0.5) {
        const col = r.pick(pal.garments);
        for (let s = 0; s < 3; s++) rect(g, x, y + s * 0.07, 0.42, 0.06, mul(col, 1 - s * 0.08));
      }
    }
    // Mannequins: head, torso in a garment colour, legs.
    for (const x of [3.2, 4.2]) {
      const col = r.pick(pal.garments);
      ellipse(g, x, 2.0, 0.09, 0.12, '#e8d8c0');
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x - 0.22, 1.85);
      g.lineTo(x + 0.22, 1.85);
      g.lineTo(x + 0.17, 1.1);
      g.lineTo(x - 0.17, 1.1);
      g.fill();
      rect(g, x - 0.14, 0.1, 0.12, 1.0, r.pick(pal.garments));
      rect(g, x + 0.02, 0.1, 0.12, 1.0, r.pick(pal.garments));
    }
    // The shop's logo bar, lit.
    rect(g, 1.2, 2.7, 2.6, 0.18, '#fff4dc');
    glow(g, 2.5, 2.8, 1.8, kelvin(3000), 0.5);
    for (const x of [1.0, 2.5, 4.0]) glow(g, x, 2.0, 1.1, kelvin(3000), 0.45);
    vignette(g, w, h, 0.4);
  },
  ...sides((p) => {
    const { g, r, w, h, pal } = p;
    vgrad(g, 0, 0, w, h, '#b0a086', '#e0d4bc');
    // A rail of hangers: the bar, then garments side by side in rows of one colour.
    for (const y of [1.0, 2.0]) {
      line(g, 0.3, y + 0.8, w - 0.3, y + 0.8, '#b8bcc0', 0.04);
      for (let x = 0.4; x < w - 0.4; x += 0.13) {
        const col = x % 0.65 < 0.13 ? r.pick(pal.garments) : '';
        rect(g, x, y, 0.12, r.range(0.55, 0.78), col || r.pick(pal.garments));
      }
    }
    rect(g, 0, 0, w, 0.18, '#5a432c');
    glow(g, w * 0.3, 2.9, 1.5, kelvin(3000), 0.35);
    glow(g, w * 0.7, 2.9, 1.5, kelvin(3000), 0.35);
    vignette(g, w, h, 0.4);
  }),
  floor(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#8a6240');
    for (let x = 0; x < w; x += 0.22) rect(g, x, 0, 0.012, h, 'rgba(0,0,0,0.3)');
    for (let y = 0.9; y < h; y += 1.3) for (let x = 0.5 + ((y * 7) % 0.6); x < w; x += 1.2) rect(g, x, y, 0.5, 0.012, 'rgba(0,0,0,0.25)');
    ellipse(g, 2.5, 2.4, 0.7, 0.7, '#d8c8a8');
    for (const [x, y] of [[1.0, 2.0], [4.0, 2.0], [2.5, 3.8]]) glow(g, x, y, 1.2, kelvin(3000), 0.4);
    vignette(g, w, h, 0.4);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#e4dccc');
    for (const y of [1.2, 2.6, 4.0]) {
      rect(g, 0.3, y, w - 0.6, 0.05, '#3a3a3e');
      for (let x = 0.8; x < w - 0.5; x += 1.0) lamp(g, x, y, 0.5, kelvin(3000), 0.6);
    }
    vignette(g, w, h, 0.3);
  },
};

const LAUNDROMAT: Painters = {
  back(p) {
    const { g, r, w, h, pal } = p;
    vgrad(g, 0, 0, w, h, '#8fb4c0', '#e0f0f4');
    // Two rows of front loaders: a white box, a porthole with a blue glow and a few tumbling colours.
    for (const y of [0.25, 1.35]) {
      for (let x = 0.2; x < w - 0.5; x += 0.95) {
        const body = r.pick(pal.machines);
        rect(g, x, y, 0.88, 1.0, body);
        rect(g, x, y + 0.88, 0.88, 0.12, '#7a828a');
        disc(g, x + 0.44, y + 0.46, 0.3, '#8a929a');
        disc(g, x + 0.44, y + 0.46, 0.25, '#bfe6ff');
        if (r.chance(0.6)) {
          ellipse(g, x + 0.4, y + 0.4, 0.16, 0.1, r.pick(['#d8302a', '#2f5fa8', '#e8c030', '#2f9a58']));
          ellipse(g, x + 0.5, y + 0.5, 0.12, 0.09, r.pick(['#e8e0d0', '#d86a8a']));
        }
        rect(g, x + 0.1, y + 0.82, 0.3, 0.05, '#2a2d33');
      }
    }
    rect(g, 0.2, 2.5, w - 0.4, 0.5, '#2f7ac8');
    glow(g, w / 2, 2.7, 2.5, kelvin(6200), 0.35);
    vignette(g, w, h, 0.4);
  },
  ...sides((p, left) => {
    const { g, r, w, h, pal } = p;
    vgrad(g, 0, 0, w, h, '#8fb4c0', '#e0f0f4');
    if (left) {
      // Dryers in two stacked rows.
      for (const y of [0.2, 1.3]) {
        for (let x = 0.4; x < w - 0.5; x += 0.95) {
          rect(g, x, y, 0.88, 1.0, r.pick(pal.machines));
          disc(g, x + 0.44, y + 0.5, 0.3, '#6a727a');
          disc(g, x + 0.44, y + 0.5, 0.24, r.chance(0.35) ? '#ffe9b0' : '#2a323a');
        }
      }
    } else {
      // A folding table with a basket, and a row of orange chairs under the window.
      rect(g, 0.6, 0.85, 2.4, 0.08, '#d8dde0');
      rect(g, 0.7, 0, 0.06, 0.85, '#8a929a');
      rect(g, 2.8, 0, 0.06, 0.85, '#8a929a');
      rect(g, 1.2, 0.95, 0.7, 0.35, r.pick(['#d8302a', '#2f5fa8', '#e8c030']));
      for (let x = 3.2; x < 4.7; x += 0.55) {
        rect(g, x, 0.4, 0.4, 0.05, '#e8742a');
        rect(g, x + 0.02, 0.45, 0.36, 0.45, '#e8742a');
        rect(g, x + 0.03, 0, 0.03, 0.4, '#3a3d44');
        rect(g, x + 0.34, 0, 0.03, 0.4, '#3a3d44');
      }
    }
    vignette(g, w, h, 0.4);
  }),
  floor(p) {
    const { g, w, h } = p;
    checker(g, w, h, 0.5, '#b8cdd6', '#9fb6c2');
    rect(g, 0, h - 0.7, w, 0.7, 'rgba(20,30,40,0.35)');
    for (const x of [1.0, 2.5, 4.0]) glow(g, x, h * 0.5, 1.6, kelvin(6200), 0.3);
    vignette(g, w, h, 0.4);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#e4eaee');
    for (let k = 0; k < 4; k++) tube(g, 0.6, 0.6 + k * 1.1, 3.8, kelvin(6200));
    vignette(g, w, h, 0.3);
  },
};

const BAR: Painters = {
  back(p) {
    const { g, w, h } = p;
    vgrad(g, 0, 0, w, h, '#2a1a10', '#4a2e1a');
    // The back bar: a mirror warmed by the bottle shelves, three rows of bottles, a neon script above.
    vgrad(g, 0.5, 0.4, 4.0, 2.2, '#5a4430', '#8a7050');
    bottleRows(p, 0.7, 4.3, 0.55, 3, 0.7);
    glow(g, w / 2, 1.5, 2.6, '#ff9a4a', 0.35);
    g.strokeStyle = '#ff4fa0';
    g.lineWidth = 0.07;
    g.beginPath();
    g.moveTo(1.2, 2.85);
    g.bezierCurveTo(1.8, 3.2, 2.2, 2.5, 2.6, 2.85);
    g.bezierCurveTo(3.0, 3.2, 3.4, 2.6, 3.8, 2.9);
    g.stroke();
    glow(g, w / 2, 2.9, 1.8, '#ff4fa0', 0.45);
    vignette(g, w, h, 0.45);
  },
  ...sides((p, left) => {
    const { g, r, w, h } = p;
    vgrad(g, 0, 0, w, h, '#2a1a10', '#46301c');
    if (left) {
      // Booths with candles, framed pictures above.
      for (let x = 0.5; x < w - 1; x += 1.7) {
        rect(g, x, 0.15, 1.3, 0.9, '#4a2a22');
        rect(g, x + 0.2, 0.7, 0.9, 0.06, '#1c1410');
        glow(g, x + 0.65, 0.78, 0.5, '#ffb050', 0.8);
        rect(g, x + 0.15, 1.7, 1.0, 0.7, '#1c1410');
        rect(g, x + 0.2, 1.75, 0.9, 0.6, r.pick(['#8a5a3a', '#3a5a6a', '#6a3a3a']));
      }
    } else {
      // The bar counter: dark wood front, brass rail, stool seats, a pour of light on top.
      rect(g, 0.3, 0, w - 0.6, 1.05, '#3a2216');
      rect(g, 0.3, 1.02, w - 0.6, 0.1, '#7a5030');
      rect(g, 0.3, 0.25, w - 0.6, 0.05, '#c8a040');
      for (let x = 0.7; x < w - 0.5; x += 0.8) {
        rect(g, x, 0.3, 0.05, 0.45, '#1c1410');
        ellipse(g, x + 0.03, 0.8, 0.2, 0.06, '#7a2a22');
      }
      glow(g, w / 2, 1.2, 2.4, '#ffa050', 0.3);
    }
    vignette(g, w, h, 0.45);
  }),
  floor(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#3a2416');
    for (let x = 0; x < w; x += 0.2) rect(g, x, 0, 0.012, h, 'rgba(0,0,0,0.4)');
    for (const [x, y] of [[1.0, 1.2], [2.5, 1.2], [4.0, 1.2], [1.8, 3.4], [3.4, 3.4]]) glow(g, x, y, 1.0, kelvin(2400), 0.4);
    vignette(g, w, h, 0.4);
  },
  ceiling(p) {
    const { g, w, h } = p;
    rect(g, 0, 0, w, h, '#1c1208');
    for (const [x, y] of [[1.0, 1.0], [2.5, 1.0], [4.0, 1.0], [1.8, 2.8], [3.4, 2.8], [2.5, 4.4]]) {
      glow(g, x, y, 0.85, kelvin(2400), 0.6);
      disc(g, x, y, 0.07, '#fff0c8');
    }
    vignette(g, w, h, 0.3);
  },
};

/** The painters, in INTERIORS order. */
const PAINTERS: readonly Painters[] = [BODEGA, DINER, LOBBY, KARAOKE, GARAGE, CLOTHES, LAUNDROMAT, BAR];

/** How much each face is darkened after painting (black alpha): the floor and ceiling carry the lamps' glare, which blooms at a slant. */
const FACE_DIM: Record<Face, number> = { back: 0, left: 0.05, right: 0.05, floor: 0.38, ceiling: 0.45 };

/** Face sizes in metres (width, height of the painted canvas) by face. */
function faceSize(face: Face): [number, number] {
  if (face === 'back') return [ROOM.w, ROOM.h];
  if (face === 'left' || face === 'right') return [ROOM.d, ROOM.h];
  return [ROOM.w, ROOM.d];
}

/**
 * Paint one face of one room onto `g` (a `px` x `px` canvas context): y up in metres, the transform set here.
 * `seed` draws the details; a face has its own stream, so the paint order never matters.
 */
export function paintFace(g: G, room: number, face: Face, seed: number, px: number): void {
  const [w, h] = faceSize(face);
  const pal = palettes(seed);
  g.save();
  g.setTransform(px / w, 0, 0, -px / h, 0, px);
  g.clearRect(0, 0, w, h);
  PAINTERS[room][face]({ g, r: new Rng(deriveSeed(seed, `room${room}.${face}`)), w, h, pal });
  // Floors and ceilings sit under the walls' brightness: lit from the side and above, and seen at a slant they would bloom white at the sill.
  const dim = FACE_DIM[face];
  if (dim > 0) rect(g, 0, 0, w, h, `rgba(0,0,0,${dim})`);
  g.restore();
}

/** The rooms as a 40 layer texture array (INTERIORS x ROOM_FACES), sRGB, mipmapped, clamped per face. */
export function makeInteriorAtlas(seed: number, detail: Exclude<Detail, 'low'>): THREE.DataArrayTexture {
  const px = FACE_PX[detail];
  const count = INTERIORS.length * ROOM_FACES.length;
  const data = new Uint8Array(px * px * 4 * count);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  for (let room = 0; room < INTERIORS.length; room++) {
    ROOM_FACES.forEach((face, f) => {
      paintFace(g, room, face, seed, px);
      const rgba = g.getImageData(0, 0, px, px).data;
      const base = (room * ROOM_FACES.length + f) * px * px * 4;
      // Canvas rows run top down; texture rows bottom up (v up the wall).
      for (let y = 0; y < px; y++) {
        const src = y * px * 4;
        data.set(rgba.subarray(src, src + px * 4), base + (px - 1 - y) * px * 4);
      }
    });
  }
  const tex = new THREE.DataArrayTexture(data, px, px, count);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
