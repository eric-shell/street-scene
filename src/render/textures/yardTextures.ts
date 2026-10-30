/**
 * The rail yard's freight car sides, drawn once per scene (a few milliseconds) into one atlas, so all
 * the yard's cars are a single textured mesh: five kinds (box car, tank car, hopper, flat car, caboose)
 * by four liveries each, a tile 256 x 96 px standing for a side about 15 m by 3.7 m. Every tile is
 * weathered the same way a night yard looks: corrugation, a door, reporting marks and a load limit in
 * stencil, rust streaks running down from the seams and, on some, a spray-painted tag or throw-up in
 * neon over the lower half. A plain strip along the bottom is the white swatch ends, roofs and
 * undercarriage sample, tinted by their vertex colors. Deterministic, so every scene draws the same cars.
 */
import * as THREE from 'three';
import { canvas, canvasTex } from './canvasKit';

export const YARD_ATLAS = { w: 1024, h: 512, tileW: 256, tileH: 96, cols: 4 } as const;
export const YARD_KINDS = ['boxcar', 'tank', 'hopper', 'flatcar', 'caboose'] as const;

/** UV rectangle (u0, v0, u1, v1; v up) of a car side tile, a pixel in from the edge against bleeding. */
export function carTile(kind: number, tex: number): { u0: number; v0: number; u1: number; v1: number } {
  const A = YARD_ATLAS;
  const col = ((tex % A.cols) + A.cols) % A.cols;
  const x = col * A.tileW;
  const y = kind * A.tileH;
  return { u0: (x + 1) / A.w, u1: (x + A.tileW - 1) / A.w, v0: 1 - (y + A.tileH - 1) / A.h, v1: 1 - (y + 1) / A.h };
}

/** A point of the white swatch (for ends, roofs, frames). */
export const PLAIN_UV = { u: 0.5, v: 1 - (YARD_ATLAS.tileH * 5 + 16) / YARD_ATLAS.h };

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const BODY: Record<string, string[]> = {
  boxcar: ['#7b3a28', '#5c3b29', '#3f5648', '#59606a'],
  tank: ['#26282c', '#8c8f94', '#2b3a4f', '#6b2f2a'],
  hopper: ['#4b4f55', '#5d4a3a', '#6a3b2f', '#3d4a44'],
  flatcar: ['#4a4036', '#5a4a38', '#3e3a34', '#524536'],
  caboose: ['#8d2f24', '#a1472b', '#7a2a2a', '#9a3a20'],
};
const NEON = ['#ff3fb4', '#35f0ff', '#b6ff3a', '#ffd23a', '#9a5bff', '#ff6a2a'];
const MARKS = ['NRX', 'SSW', 'UTLX', 'CNW', 'DRGW', 'BNSF', 'KCS', 'GATX'];

function tag(g: CanvasRenderingContext2D, r: () => number, w: number, h: number): void {
  const c = NEON[Math.floor(r() * NEON.length)];
  const c2 = NEON[Math.floor(r() * NEON.length)];
  const text = ['KRAZE', 'DUSK', 'SORE', 'VEX', 'ZONE', 'MUSE', 'RAIL', 'OZ'][Math.floor(r() * 8)];
  g.save();
  g.translate(w * (0.12 + r() * 0.4), h * (0.6 + r() * 0.12));
  g.rotate((r() - 0.5) * 0.14);
  g.font = `900 ${Math.round(h * 0.42)}px Impact, "Arial Black", sans-serif`;
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = '#0a0a0d';
  g.strokeText(text, 0, 0);
  g.fillStyle = c;
  g.fillText(text, 0, 0);
  g.lineWidth = 1.5;
  g.strokeStyle = c2;
  g.strokeText(text, -1, -1);
  g.restore();
}

function drawTile(g: CanvasRenderingContext2D, kind: number, tex: number): void {
  const W = YARD_ATLAS.tileW;
  const H = YARD_ATLAS.tileH;
  const r = rng(kind * 977 + tex * 131 + 17);
  const name = YARD_KINDS[kind];
  const body = BODY[name][tex % 4];
  g.fillStyle = body;
  g.fillRect(0, 0, W, H);
  if (name === 'tank') {
    // A cylinder's own shading: lighter along the top, dark belly.
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,255,255,0.22)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    // The band and the placard.
    g.fillStyle = tex % 2 ? '#e8e0c8' : '#d7a21c';
    g.fillRect(0, H * 0.46, W, 5);
    g.save();
    g.translate(W * 0.5, H * 0.5);
    g.rotate(Math.PI / 4);
    g.fillStyle = '#e8e8e0';
    g.fillRect(-9, -9, 18, 18);
    g.strokeStyle = '#a00';
    g.lineWidth = 2;
    g.strokeRect(-9, -9, 18, 18);
    g.restore();
  } else if (name === 'flatcar') {
    // Deck planks seen from the side: dark steel sill with wood above.
    g.fillStyle = '#2d2b29';
    g.fillRect(0, H * 0.45, W, H * 0.55);
    g.fillStyle = body;
    for (let x = 0; x < W; x += 14) g.fillRect(x, 0, 12, H * 0.45);
  } else {
    // Corrugation and seams.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 4; x < W; x += 8) g.fillRect(x, 0, 2, H);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    for (let x = 6; x < W; x += 8) g.fillRect(x, 0, 1, H);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, W, 3);
    g.fillRect(0, H - 4, W, 4);
    if (name === 'boxcar') {
      // The sliding door.
      const dx = W * (0.38 + r() * 0.08);
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.fillRect(dx, 8, W * 0.2, H - 14);
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.strokeRect(dx + 0.5, 8.5, W * 0.2, H - 15);
      g.fillStyle = '#9a9a98';
      g.fillRect(dx + 3, H * 0.55, W * 0.2 - 6, 2);
    }
    if (name === 'caboose') {
      g.fillStyle = '#ffd88a';
      for (const x of [0.2, 0.42, 0.66, 0.84]) g.fillRect(W * x, H * 0.22, W * 0.07, H * 0.26);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, H * 0.7, W, 2);
    }
  }
  // Rust streaks down from the seams.
  for (let i = 0; i < 26; i++) {
    const x = r() * W;
    const y = r() * H * 0.6;
    const len = H * (0.2 + r() * 0.5);
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, `rgba(${110 + r() * 40},${48 + r() * 20},18,${0.28 + r() * 0.2})`);
    gr.addColorStop(1, 'rgba(110,48,18,0)');
    g.fillStyle = gr;
    g.fillRect(x, y, 1 + r() * 3, len);
  }
  // Reporting marks and the load limit in stencil.
  const mark = MARKS[Math.floor(r() * MARKS.length)];
  const num = String(10000 + Math.floor(r() * 89999));
  g.fillStyle = 'rgba(232,230,220,0.85)';
  g.font = `bold ${Math.round(H * 0.17)}px "Arial Narrow", Arial, sans-serif`;
  g.fillText(mark, W * 0.04, H * 0.86);
  g.fillText(num, W * 0.04 + 40, H * 0.86);
  g.font = `${Math.round(H * 0.1)}px Arial, sans-serif`;
  g.fillText('CAPY 100000  LD LMT 195800', W * 0.62, H * 0.9);
  // Graffiti on some.
  if (r() < 0.55) tag(g, r, W, H);
  if (r() < 0.25) {
    g.strokeStyle = NEON[Math.floor(r() * NEON.length)];
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(W * r() * 0.5, H * 0.3 + r() * H * 0.3);
    g.bezierCurveTo(W * 0.4, H * r(), W * 0.6, H * r(), W * (0.6 + r() * 0.4), H * (0.3 + r() * 0.4));
    g.stroke();
  }
  // Grime along the bottom.
  const gm = g.createLinearGradient(0, H * 0.7, 0, H);
  gm.addColorStop(0, 'rgba(10,8,6,0)');
  gm.addColorStop(1, 'rgba(10,8,6,0.45)');
  g.fillStyle = gm;
  g.fillRect(0, H * 0.7, W, H * 0.3);
}

/** The atlas texture: 5 kinds x 4 liveries and a white swatch row. */
export function makeYardAtlas(): THREE.Texture {
  const A = YARD_ATLAS;
  const [c, g] = canvas(A.w, A.h);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, A.w, A.h);
  for (let kind = 0; kind < YARD_KINDS.length; kind++) {
    for (let tex = 0; tex < A.cols; tex++) {
      g.save();
      g.translate(tex * A.tileW, kind * A.tileH);
      g.beginPath();
      g.rect(0, 0, A.tileW, A.tileH);
      g.clip();
      drawTile(g, kind, tex);
      g.restore();
    }
  }
  const t = canvasTex(c, { repeat: false, anisotropy: 4 });
  return t;
}
