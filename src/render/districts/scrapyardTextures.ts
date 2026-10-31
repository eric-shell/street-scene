/**
 * The scrapyard's three canvas textures (render/districts/scrapyard.ts): the corrugated sheet the fence is made of, the
 * atlas of crushed car sides the stacks and bales are built from, and the tiling jumble of wrecks the scrap mountains wear.
 * Drawn once per scene build, small (a 256 px tile, a 1024 x 512 sheet and a 512 px tile), so the whole yard's metal is three
 * draw calls.
 *
 * The atlas has ATLAS.cols x ATLAS.rows cells, each a strip of one flattened car's flank (the stacks' tiers are 5 m long and
 * 0.8 m thick, so a cell is six times wider than tall): the paint in one of the city's street colours (the traffic
 * palette, render/traffic/traffic.ts PAINTS), a dark glass line where the windows were, the door seams, a crumple of
 * lighter and darker patches, rust, a black half tyre at an end. Hash noise only, so the sheet is the same every build.
 */
import * as THREE from 'three';
import { drawTexture } from '../textures/canvasKit';
import { PAINTS } from '../traffic/traffic';

/** The atlas's grid: cells across and down. */
export const ATLAS = { cols: 2, rows: 6, width: 1024, height: 512 } as const;

/** A tiny deterministic hash to [0, 1). */
function hash(n: number): number {
  let h = Math.imul(n + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(n * 31 + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** The fence's corrugated steel: vertical ribs lit from one side, painted panels with rust running down from the top and the edges, tiling in both directions. */
export function corrugatedTexture(): THREE.CanvasTexture {
  return drawTexture(256, 256, (g) => {
    const tones = ['#7c8590', '#6d7680', '#8a8f94', '#76706a'];
    const panel = 128;
    for (let p = 0; p < 2; p++) {
      const tone = tones[Math.floor(hash(p + 3) * tones.length)];
      g.fillStyle = tone;
      g.fillRect(p * panel, 0, panel, 256);
      // The ribs: a lit side and a shaded side per 16 px ridge.
      for (let x = 0; x < panel; x += 16) {
        const grad = g.createLinearGradient(p * panel + x, 0, p * panel + x + 16, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.22)');
        grad.addColorStop(0.5, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,0.32)');
        g.fillStyle = grad;
        g.fillRect(p * panel + x, 0, 16, 256);
      }
    }
    // Rust streaks running down from the top edge and the seam between the two sheets, and a few dents.
    for (let i = 0; i < 46; i++) {
      const x = hash(i * 7 + 1) * 256;
      const len = 16 + hash(i * 7 + 2) * 120;
      const w = 2 + hash(i * 7 + 3) * 7;
      const grad = g.createLinearGradient(0, 0, 0, len);
      grad.addColorStop(0, `rgba(120,58,26,${0.35 + hash(i) * 0.3})`);
      grad.addColorStop(1, 'rgba(120,58,26,0)');
      g.fillStyle = grad;
      g.fillRect(x, 0, w, len);
    }
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(90,44,22,${0.12 + hash(i + 90) * 0.2})`;
      g.beginPath();
      g.ellipse(hash(i * 3 + 100) * 256, 140 + hash(i * 3 + 101) * 116, 4 + hash(i * 3 + 102) * 16, 3 + hash(i * 3 + 103) * 9, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 252, 256, 4);
  });
}

/** One cell of the crushed car atlas: a flattened flank in the paint `paint`, seeded by `seed`. */
function drawFlank(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, paint: THREE.Color, seed: number): void {
  const css = (c: THREE.Color, k = 1) => `rgb(${Math.min(255, Math.round(c.r * 255 * k))},${Math.min(255, Math.round(c.g * 255 * k))},${Math.min(255, Math.round(c.b * 255 * k))})`;
  g.save();
  g.beginPath();
  g.rect(x0, y0, w, h);
  g.clip();
  g.translate(x0, y0);
  g.fillStyle = css(paint);
  g.fillRect(0, 0, w, h);
  // Shading: a lighter shoulder line high up, a dark sill below.
  const shade = g.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, 'rgba(255,255,255,0.16)');
  shade.addColorStop(0.45, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  // Where the windows were: a glass strip over the middle half, cracked, with the pillars between.
  const gl0 = w * (0.18 + hash(seed) * 0.06);
  const gl1 = w * (0.78 + hash(seed + 1) * 0.08);
  g.fillStyle = 'rgba(16,24,34,0.92)';
  g.fillRect(gl0, h * 0.16, gl1 - gl0, h * 0.32);
  g.strokeStyle = css(paint, 0.55);
  g.lineWidth = 3;
  for (const f of [0.34, 0.52, 0.68]) {
    g.beginPath();
    g.moveTo(w * f, h * 0.16);
    g.lineTo(w * f, h * 0.48);
    g.stroke();
  }
  // Door seams and handles.
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 1.5;
  for (const f of [0.28, 0.5, 0.74]) {
    g.beginPath();
    g.moveTo(w * f, h * 0.5);
    g.lineTo(w * f, h * 0.95);
    g.stroke();
  }
  g.fillStyle = 'rgba(210,214,220,0.7)';
  for (const f of [0.31, 0.53]) g.fillRect(w * f, h * 0.58, 9, 3);
  // The crumple: patches of lighter and darker metal, torn edges, rust.
  for (let i = 0; i < 26; i++) {
    const px = hash(seed * 13 + i * 5) * w;
    const py = hash(seed * 13 + i * 5 + 1) * h;
    const pw = 8 + hash(seed * 13 + i * 5 + 2) * 46;
    const ph = 4 + hash(seed * 13 + i * 5 + 3) * 16;
    const k = hash(seed * 13 + i * 5 + 4);
    g.fillStyle = k < 0.4 ? 'rgba(0,0,0,0.22)' : k < 0.7 ? 'rgba(255,255,255,0.1)' : 'rgba(112,52,24,0.34)';
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(px + pw, py + ph * 0.3);
    g.lineTo(px + pw * 0.8, py + ph);
    g.lineTo(px - pw * 0.1, py + ph * 0.7);
    g.closePath();
    g.fill();
  }
  // A black half tyre where a wheel arch was, at one end.
  const end = hash(seed + 7) < 0.5 ? 0 : w;
  g.fillStyle = 'rgba(10,10,12,0.95)';
  g.beginPath();
  g.ellipse(end === 0 ? w * 0.14 : w * 0.86, h, w * 0.06, h * 0.55, 0, Math.PI, Math.PI * 2);
  g.fill();
  g.restore();
}

/** The atlas of crushed car flanks; cell k is column k % cols, row floor(k / cols), rows from the top. */
export function stackAtlas(): THREE.CanvasTexture {
  const cw = ATLAS.width / ATLAS.cols;
  const ch = ATLAS.height / ATLAS.rows;
  return drawTexture(
    ATLAS.width,
    ATLAS.height,
    (g) => {
      for (let k = 0; k < ATLAS.cols * ATLAS.rows; k++) {
        const c = PAINTS[(k * 5 + 2) % PAINTS.length];
        drawFlank(g, (k % ATLAS.cols) * cw, Math.floor(k / ATLAS.cols) * ch, cw, ch, c, k + 1);
      }
    },
    { repeat: false },
  );
}

/** UV rectangle (u0, v0, u1, v1; v up as three.js reads a canvas texture) of atlas cell `k`, inset a texel so neighbours do not bleed. */
export function cellUv(k: number): [number, number, number, number] {
  const col = k % ATLAS.cols;
  const row = Math.floor(k / ATLAS.cols);
  const e = 1.5;
  return [(col * (ATLAS.width / ATLAS.cols) + e) / ATLAS.width, 1 - ((row + 1) * (ATLAS.height / ATLAS.rows) - e) / ATLAS.height, ((col + 1) * (ATLAS.width / ATLAS.cols) - e) / ATLAS.width, 1 - (row * (ATLAS.height / ATLAS.rows) + e) / ATLAS.height];
}

/** Metres of heap one repeat of heapTexture covers. */
export const HEAP_TILE = 9;

/**
 * The scrap mountains' skin: a tile of wrecks heaped every which way (flattened bodies in the traffic palette at random
 * angles, their glass lines and dark seams, loose tyres, rust and shadow between), drawn wrapped so it repeats seamlessly in
 * both directions. The heaps map it in world metres (HEAP_TILE m a repeat), so every pile reads at the same scale.
 */
export function heapTexture(): THREE.CanvasTexture {
  const S = 512;
  return drawTexture(S, S, (g) => {
    g.fillStyle = '#2a221c';
    g.fillRect(0, 0, S, S);
    const css = (c: THREE.Color, k: number) => `rgb(${Math.min(255, Math.round(c.r * 255 * k))},${Math.min(255, Math.round(c.g * 255 * k))},${Math.min(255, Math.round(c.b * 255 * k))})`;
    // Each piece is drawn at the eight wrapped offsets too, so the tile has no seam.
    const wrapped = (draw: () => void, x: number, y: number) => {
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) {
          g.save();
          g.translate(x + ox, y + oy);
          draw();
          g.restore();
        }
      }
    };
    for (let i = 0; i < 150; i++) {
      const ang = (hash(i * 11 + 3) - 0.5) * Math.PI * 0.9;
      const w = 70 + hash(i * 11 + 4) * 70;
      const h = 18 + hash(i * 11 + 5) * 18;
      const paint = PAINTS[Math.floor(hash(i * 11 + 6) * PAINTS.length)];
      const k = 0.45 + hash(i * 11 + 7) * 0.5;
      const rust = hash(i * 11 + 8);
      wrapped(
        () => {
          g.rotate(ang);
          g.fillStyle = 'rgba(0,0,0,0.55)';
          g.fillRect(-w / 2 + 3, -h / 2 + 4, w, h);
          g.fillStyle = css(paint, k);
          g.fillRect(-w / 2, -h / 2, w, h);
          g.fillStyle = 'rgba(14,20,28,0.85)';
          g.fillRect(-w * 0.3, -h * 0.35, w * 0.55, h * 0.3);
          g.fillStyle = 'rgba(110,50,22,0.4)';
          g.fillRect(-w / 2, h * 0.15, w * rust, h * 0.35);
          g.strokeStyle = 'rgba(0,0,0,0.6)';
          g.lineWidth = 2;
          g.strokeRect(-w / 2, -h / 2, w, h);
        },
        hash(i * 11 + 1) * S,
        hash(i * 11 + 2) * S,
      );
    }
    for (let i = 0; i < 40; i++) {
      const r = 7 + hash(i * 7 + 502) * 7;
      const squash = 0.5 + hash(i) * 0.5;
      const tilt = hash(i + 9) * 3;
      wrapped(
        () => {
          g.fillStyle = '#0d0d0f';
          g.beginPath();
          g.ellipse(0, 0, r, r * squash, tilt, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#3a3c40';
          g.beginPath();
          g.ellipse(0, 0, r * 0.4, r * 0.25, tilt, 0, Math.PI * 2);
          g.fill();
        },
        hash(i * 7 + 500) * S,
        hash(i * 7 + 501) * S,
      );
    }
  });
}

