/**
 * Procedural canvas textures for the river channel (render/districts/river.ts):
 * stained concrete with expansion joints and cracks, a decal atlas of
 * graffiti murals (big overlapping letters, outlines, drips and spray) plus
 * storm drain outlets and the arched culvert recesses under the bridges, and
 * a tiling chain-link fence (alpha tested). Seeded, so every scene of a seed
 * paints the same walls; cached per seed because the menu backdrop and the
 * race it starts draw the same city.
 */
import * as THREE from 'three';
import { Rng } from '../sim/prng';

/** Meters per repeat of the concrete texture, and the atlas layout (px). */
export const RIVER_TEX = {
  concreteSpan: 16,
  atlas: 1024,
  cell: 256,
  murals: 6,
  /** Chain-link repeat (m) and the share of the tile taken by the top rail. */
  fenceSpan: 2,
} as const;

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface RiverTextures {
  concrete: THREE.CanvasTexture;
  decals: THREE.CanvasTexture;
  chainlink: THREE.CanvasTexture;
  /** Atlas rectangle of a mural (0..murals-1), the drain outlet, the culvert arch or the portal. */
  mural(i: number): UvRect;
  drain: UvRect;
  arch: UvRect;
  portal: UvRect;
  dispose(): void;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, color: boolean, repeat: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A grey noise layer scaled up with bilinear filtering: cheap large scale mottling. */
function noiseLayer(ctx: CanvasRenderingContext2D, rng: Rng, size: number, cells: number, alpha: number, lo: number, hi: number): void {
  const [n, nc] = canvas(cells, cells);
  const img = nc.createImageData(cells, cells);
  for (let i = 0; i < cells * cells; i++) {
    const v = Math.round(lo + (hi - lo) * rng.next());
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  nc.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(n, 0, 0, size, size);
  ctx.restore();
}

function makeConcrete(rng: Rng): THREE.CanvasTexture {
  const S = 1024;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#8d8f93';
  ctx.fillRect(0, 0, S, S);
  noiseLayer(ctx, rng, S, 32, 0.35, 90, 190);
  noiseLayer(ctx, rng, S, 128, 0.22, 100, 180);
  noiseLayer(ctx, rng, S, 512, 0.1, 80, 200);
  // Stains: water runs and oil, soft edged.
  for (let i = 0; i < 70; i++) {
    const x = rng.range(0, S);
    const y = rng.range(0, S);
    const rx = rng.range(20, 110);
    const ry = rng.range(12, 60);
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
    const dark = rng.chance(0.7);
    g.addColorStop(0, dark ? `rgba(40,42,46,${rng.range(0.12, 0.3)})` : `rgba(150,140,120,${rng.range(0.08, 0.18)})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  // Cracks: thin wandering dark lines.
  ctx.strokeStyle = 'rgba(30,30,34,0.55)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 9; i++) {
    let x = rng.range(0, S);
    let y = rng.range(0, S);
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      x += rng.range(-40, 40);
      y += rng.range(-40, 40);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Expansion joints every quarter (4 m): a dark groove with a light edge.
  for (let k = 0; k < 4; k++) {
    const q = (k * S) / 4;
    ctx.fillStyle = 'rgba(25,26,30,0.8)';
    ctx.fillRect(q - 2, 0, 4, S);
    ctx.fillRect(0, q - 2, S, 4);
    ctx.fillStyle = 'rgba(200,200,205,0.35)';
    ctx.fillRect(q + 2, 0, 1.5, S);
    ctx.fillRect(0, q + 2, S, 1.5);
  }
  return finish(c, true, true);
}

const NEON = ['#ff2bd6', '#22e6ff', '#ffe14d', '#7cff4f', '#ff5a36', '#a66bff', '#ff3b6b', '#3bffb4', '#ffffff', '#ff9d1a'];
const WORDS = ['NEON', 'DRIFT', 'VOLT', 'APEX', 'KAIJU', 'RUSH', 'ZERO', 'BLAZE', 'NITRO', 'GHOST', 'HYPER', 'ORBIT', 'SONIC', 'FLUX', 'TURBO', 'VIBE'];

/** One graffiti piece into a cell: a dark wash, fat overlapping letters with outlines and drips, spray and sparkle. */
function mural(ctx: CanvasRenderingContext2D, rng: Rng, x0: number, y0: number, W: number, H: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, W, H);
  ctx.clip();
  const pal = rng.shuffle([...NEON]).slice(0, 4);
  if (rng.chance(0.6)) {
    ctx.fillStyle = rng.chance(0.5) ? 'rgba(20,22,34,0.75)' : `rgba(${rng.int(20, 80)},${rng.int(10, 40)},${rng.int(40, 90)},0.7)`;
    ctx.beginPath();
    ctx.ellipse(x0 + W / 2, y0 + H / 2, W * rng.range(0.42, 0.52), H * rng.range(0.4, 0.5), rng.range(-0.1, 0.1), 0, Math.PI * 2);
    ctx.fill();
  }
  const word = WORDS[rng.int(0, WORDS.length - 1)];
  const size = Math.min(H * 0.72, (W * 1.15) / word.length);
  ctx.font = `900 italic ${size}px "Arial Black", Impact, "Helvetica Neue", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const fill = pal[0];
  const edge = pal[1];
  const cx = x0 + W / 2;
  const cy = y0 + H * 0.5;
  const step = size * 0.82;
  const startX = cx - (step * (word.length - 1)) / 2;
  const tilt = rng.range(-0.12, 0.12);
  // Block shadow, then the letters with a thick outline and a highlight stroke.
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < word.length; i++) {
      const lx = startX + i * step;
      const ly = cy + Math.sin(i * 1.7 + rng.next() * 0.3) * size * 0.08;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(tilt + (i % 2 ? 0.05 : -0.05));
      ctx.scale(1, 1.12);
      if (pass === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillText(word[i], size * 0.09, size * 0.09);
      } else if (pass === 1) {
        ctx.lineWidth = size * 0.16;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = edge;
        ctx.strokeText(word[i], 0, 0);
        ctx.fillStyle = fill;
        ctx.fillText(word[i], 0, 0);
      } else {
        ctx.lineWidth = size * 0.035;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.strokeText(word[i], -size * 0.03, -size * 0.03);
      }
      ctx.restore();
    }
  }
  // Drips off the letters.
  ctx.strokeStyle = fill;
  ctx.lineCap = 'round';
  for (let i = 0; i < rng.int(5, 12); i++) {
    const dx = cx + rng.range(-W * 0.42, W * 0.42);
    const dy = cy + size * rng.range(0.2, 0.45);
    ctx.lineWidth = rng.range(3, 8);
    ctx.beginPath();
    ctx.moveTo(dx, dy);
    ctx.lineTo(dx + rng.range(-3, 3), dy + rng.range(12, H * 0.35));
    ctx.stroke();
  }
  // Spray haze, stars and arrows.
  for (let i = 0; i < 6; i++) {
    const g = ctx.createRadialGradient(x0 + rng.range(0, W), y0 + rng.range(0, H), 0, x0 + W / 2, y0 + H / 2, rng.range(40, 120));
    g.addColorStop(0, pal[2] + '66');
    g.addColorStop(1, pal[2] + '00');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, W, H);
  }
  ctx.fillStyle = pal[3];
  for (let i = 0; i < rng.int(2, 6); i++) {
    const sx = x0 + rng.range(W * 0.05, W * 0.95);
    const sy = y0 + rng.range(H * 0.08, H * 0.92);
    const r = rng.range(6, 16);
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      const rr = k % 2 ? r * 0.45 : r;
      ctx.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function makeDecals(rng: Rng): [THREE.CanvasTexture, (i: number) => UvRect, UvRect, UvRect, UvRect] {
  const S = RIVER_TEX.atlas;
  const C = RIVER_TEX.cell;
  const [c, ctx] = canvas(S, S);
  ctx.clearRect(0, 0, S, S);
  for (let i = 0; i < RIVER_TEX.murals; i++) mural(ctx, rng, (i % 2) * 2 * C, Math.floor(i / 2) * C, 2 * C, C);
  // Drain outlet: a dark pipe mouth in a concrete collar, rust and algae streaking down.
  {
    const x0 = 0;
    const y0 = 3 * C;
    const r = C * 0.22;
    const cx = x0 + C / 2;
    const cy = y0 + C * 0.26;
    for (let i = 0; i < 14; i++) {
      const sx = cx + rng.range(-r * 0.9, r * 0.9);
      const g = ctx.createLinearGradient(0, cy, 0, y0 + C);
      g.addColorStop(0, `rgba(${rng.int(110, 160)},${rng.int(60, 90)},${rng.int(20, 40)},0.55)`);
      g.addColorStop(0.5, 'rgba(60,70,50,0.35)');
      g.addColorStop(1, 'rgba(40,60,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx - rng.range(2, 7), cy, rng.range(4, 14), C - (cy - y0));
    }
    ctx.fillStyle = '#6a6c70';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.25, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#111214');
    g.addColorStop(0.75, '#060607');
    g.addColorStop(1, '#2a2c30');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Culvert arch: a recessed tunnel mouth painted on the solid bridge body, grime above.
  const arch = (x0: number, w: number, h: number, y0: number) => {
    const g = ctx.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, '#0a0c12');
    g.addColorStop(0.6, '#101420');
    g.addColorStop(1, '#1a2030');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0 + w * 0.06, y0 + h);
    ctx.lineTo(x0 + w * 0.06, y0 + h * 0.5);
    ctx.ellipse(x0 + w / 2, y0 + h * 0.5, w * 0.44, h * 0.42, 0, Math.PI, 0);
    ctx.lineTo(x0 + w * 0.94, y0 + h);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = w * 0.025;
    ctx.strokeStyle = 'rgba(190,192,198,0.9)';
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = w * 0.012;
    for (let i = 0; i < 12; i++) {
      const sx = x0 + w * rng.range(0.05, 0.95);
      ctx.beginPath();
      ctx.moveTo(sx, y0);
      ctx.lineTo(sx + rng.range(-4, 4), y0 + h * rng.range(0.15, 0.5));
      ctx.stroke();
    }
  };
  arch(C, 2 * C, C, 3 * C);
  arch(3 * C, C, C, 3 * C);
  const rect = (x: number, y: number, w: number, h: number): UvRect => ({ u0: x / S, v0: 1 - (y + h) / S, u1: (x + w) / S, v1: 1 - y / S });
  // Inset a hair so bilinear filtering never bleeds the neighbor cell in.
  const inset = (r: UvRect): UvRect => ({ u0: r.u0 + 2 / S, v0: r.v0 + 2 / S, u1: r.u1 - 2 / S, v1: r.v1 - 2 / S });
  const tex = finish(c, true, false);
  return [tex, (i) => inset(rect((i % 2) * 2 * C, Math.floor(i / 2) * C, 2 * C, C)), inset(rect(0, 3 * C, C, C)), inset(rect(C, 3 * C, 2 * C, C)), inset(rect(3 * C, 3 * C, C, C))];
}

function makeChainlink(): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = 'rgba(190,196,204,0.95)';
  ctx.lineWidth = 2.2;
  const d = 32;
  for (let x = -S; x < 2 * S; x += d) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + S, S);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + S, 0);
    ctx.lineTo(x, S);
    ctx.stroke();
  }
  // Top rail and a tension wire, opaque.
  ctx.fillStyle = '#9aa0a8';
  ctx.fillRect(0, 0, S, 9);
  ctx.fillStyle = '#5a5e66';
  ctx.fillRect(0, 9, S, 2);
  return finish(c, true, true);
}

let cache: { seed: number; tex: RiverTextures } | null = null;

/** The channel's textures for a seed, shared by every scene of that seed and replaced when the seed changes. */
export function riverTextures(seed: number): RiverTextures {
  if (cache && cache.seed === seed) return cache.tex;
  cache?.tex.dispose();
  const rng = new Rng((seed ^ 0x51a7e) >>> 0 || 1);
  const concrete = makeConcrete(rng);
  const [decals, mural, drain, arch, portal] = makeDecals(rng);
  const chainlink = makeChainlink();
  const tex: RiverTextures = {
    concrete,
    decals,
    chainlink,
    mural,
    drain,
    arch,
    portal,
    dispose() {
      concrete.dispose();
      decals.dispose();
      chainlink.dispose();
    },
  };
  cache = { seed, tex };
  return tex;
}
