/**
 * Procedural canvas textures: asphalt, building facades and windows, neon
 * sign atlas, glow sprites, barrier stripes, and the night environment map.
 * Render-side only, so plain Math.random is fine here, but we use a seeded
 * generator anyway so the city looks the same for the same seed.
 */
import * as THREE from 'three';
import { Rng } from '../sim/prng';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Asphalt color map and a roughness map with puddles (dark = glossy). */
export function makeAsphalt(seed: number): { map: THREE.Texture; roughness: THREE.Texture } {
  const rng = new Rng(seed ^ 0xa5f);
  const S = 512;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#1c1d22';
  ctx.fillRect(0, 0, S, S);
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng.next() - 0.5) * 26;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n + 2;
  }
  ctx.putImageData(img, 0, 0);
  // tar seams and patches
  for (let i = 0; i < 18; i++) {
    ctx.strokeStyle = `rgba(10,10,12,${rng.range(0.2, 0.5)})`;
    ctx.lineWidth = rng.range(1, 3);
    ctx.beginPath();
    ctx.moveTo(rng.range(0, S), rng.range(0, S));
    ctx.bezierCurveTo(rng.range(0, S), rng.range(0, S), rng.range(0, S), rng.range(0, S), rng.range(0, S), rng.range(0, S));
    ctx.stroke();
  }

  const [rc, rctx] = canvas(S, S);
  rctx.fillStyle = 'rgb(105,105,105)';
  rctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, S);
    const y = rng.range(0, S);
    const r = rng.range(60, 160);
    const g = rctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(40,40,40,0.8)');
    g.addColorStop(0.6, 'rgba(60,60,60,0.45)');
    g.addColorStop(1, 'rgba(105,105,105,0)');
    rctx.fillStyle = g;
    for (const ox of [-S, 0, S]) {
      for (const oy of [-S, 0, S]) {
        rctx.save();
        rctx.translate(ox, oy);
        rctx.beginPath();
        rctx.ellipse(x, y, r, r * rng.range(0.4, 1), rng.range(0, Math.PI), 0, Math.PI * 2);
        rctx.fill();
        rctx.restore();
      }
    }
  }
  return { map: tex(c), roughness: tex(rc, false) };
}

export function makeSidewalk(): THREE.Texture {
  const S = 256;
  const [c, ctx] = canvas(S, S);
  ctx.fillStyle = '#3a3b42';
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = '#25262b';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo((i * S) / 4, 0);
    ctx.lineTo((i * S) / 4, S);
    ctx.moveTo(0, (i * S) / 4);
    ctx.lineTo(S, (i * S) / 4);
    ctx.stroke();
  }
  return tex(c);
}

/** Window grid layout shared by the facade color map and the lit window emissive map. */
export const WINDOW_COLS = 32;
export const WINDOW_ROWS = 64;

export function makeFacade(seed: number): { map: THREE.Texture; emissive: THREE.Texture } {
  const rng = new Rng(seed ^ 0x51de);
  const cw = 16;
  const ch = 16;
  const W = WINDOW_COLS * cw;
  const H = WINDOW_ROWS * ch;
  const [c, ctx] = canvas(W, H);
  const [e, ectx] = canvas(W, H);
  ctx.fillStyle = '#3a3e4a';
  ctx.fillRect(0, 0, W, H);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, W, H);
  const warm = ['#ffd9a0', '#ffc46b', '#ffe8c2', '#ffb25a'];
  const cool = ['#bfe3ff', '#9fd0ff', '#d8f0ff', '#a6fff1'];
  const odd = ['#ff7ad9', '#7affd4', '#ffe066'];
  for (let row = 0; row < WINDOW_ROWS; row++) {
    // whole floors tend to be lit or dark together
    const floorLit = rng.next();
    for (let col = 0; col < WINDOW_COLS; col++) {
      const x = col * cw;
      const y = row * ch;
      ctx.fillStyle = '#10141f';
      ctx.fillRect(x + 4, y + 4, cw - 8, ch - 7);
      const lit = rng.next() < 0.08 + floorLit * floorLit * 0.5;
      if (lit) {
        const r = rng.next();
        const pal = r < 0.6 ? warm : r < 0.95 ? cool : odd;
        ectx.fillStyle = pal[Math.floor(rng.next() * pal.length)];
        ectx.globalAlpha = rng.range(0.35, 1);
        ectx.fillRect(x + 4, y + 4, cw - 8, ch - 7);
        // blinds
        if (rng.next() < 0.3) {
          ectx.fillStyle = '#000';
          ectx.globalAlpha = 0.5;
          ectx.fillRect(x + 4, y + 4, cw - 8, rng.range(2, ch - 8));
        }
        ectx.globalAlpha = 1;
      }
    }
  }
  const map = tex(c);
  const emissive = tex(e);
  map.magFilter = THREE.LinearFilter;
  return { map, emissive };
}

export const SIGN_NAMES = [
  'NEON NOODLE', 'KAIJU KARAOKE', 'MIDNIGHT TUNE', 'ZERO AUTO', 'LUCKY 7', 'SAKURA BAR',
  'TURBO TACO', 'CYBER CAFE', 'VOLT MOTORS', 'NIGHT OWL', 'RAMEN 24H', 'HOTEL ORBIT',
  'STARLITE', 'DRIFT CLUB', 'PIXEL ARCADE', 'BLUE LOTUS', 'GOLDEN DRAGON', 'APEX GARAGE',
  'CHROME DINER', 'OKAMI SUSHI', 'HYPER MART', 'LASER BOWL', 'ROXY', 'MOTEL 99',
];
export const SIGN_ATLAS_COLS = 4;
export const SIGN_ATLAS_ROWS = 6;
export const NEON_COLORS = [0xff2bd6, 0x22e6ff, 0xffe14d, 0x7cff4f, 0xff5a36, 0xa66bff, 0xff3b6b, 0x3bffb4];

/** White neon text on dark panels; tinted per sign with vertex colors. */
export function makeSignAtlas(): THREE.Texture {
  const cw = 512;
  const chh = 128;
  const [c, ctx] = canvas(cw * SIGN_ATLAS_COLS, chh * SIGN_ATLAS_ROWS);
  SIGN_NAMES.forEach((name, i) => {
    const x = (i % SIGN_ATLAS_COLS) * cw;
    const y = Math.floor(i / SIGN_ATLAS_COLS) * chh;
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(x, y, cw, chh);
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 14;
    ctx.lineWidth = 5;
    ctx.strokeRect(x + 10, y + 10, cw - 20, chh - 20);
    let size = 70;
    ctx.font = `bold ${size}px "Arial Black", Impact, sans-serif`;
    while (ctx.measureText(name).width > cw - 60 && size > 20) {
      size -= 4;
      ctx.font = `bold ${size}px "Arial Black", Impact, sans-serif`;
    }
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 22;
    ctx.fillText(name, x + cw / 2, y + chh / 2 + 4);
    ctx.shadowBlur = 0;
  });
  const t = tex(c, true, false);
  return t;
}

export function makeRadialGlow(): THREE.Texture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return tex(c, false, false);
}

export function makeBarrierTexture(): THREE.Texture {
  const W = 256;
  const H = 64;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffcc00';
  for (let i = -2; i < 10; i++) {
    ctx.beginPath();
    const x = i * 32;
    ctx.moveTo(x, H);
    ctx.lineTo(x + 16, H);
    ctx.lineTo(x + 16 + H / 2, 0);
    ctx.lineTo(x + H / 2, 0);
    ctx.fill();
  }
  return tex(c);
}

export function makeCheckerTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 32);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#111' : '#eee';
      ctx.fillRect(i * 8, j * 8, 8, 8);
    }
  }
  const t = tex(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Equirectangular night city panorama used for reflections (and the sky). */
export function makeNightEnvironment(seed: number): HTMLCanvasElement {
  const rng = new Rng(seed ^ 0xe7);
  const W = 1024;
  const H = 512;
  const [c, ctx] = canvas(W, H);
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#02030a');
  sky.addColorStop(0.36, '#0b0d26');
  sky.addColorStop(0.5, '#2a1840');
  sky.addColorStop(0.52, '#0a0a14');
  sky.addColorStop(1, '#040408');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // skyline silhouettes with lit windows
  for (let i = 0; i < 160; i++) {
    const bw = rng.range(10, 40);
    const bh = rng.range(20, 150);
    const x = rng.range(0, W);
    const y = H * 0.5 - bh;
    ctx.fillStyle = '#07070f';
    ctx.fillRect(x, y, bw, bh + 4);
    for (let k = 0; k < bh / 4; k++) {
      if (rng.next() < 0.5) continue;
      ctx.fillStyle = rng.next() < 0.7 ? '#ffcf8a' : '#9fd6ff';
      ctx.globalAlpha = rng.range(0.3, 0.9);
      ctx.fillRect(x + rng.range(1, bw - 3), y + rng.range(2, bh), 2, 2);
    }
    ctx.globalAlpha = 1;
  }
  // neon blobs
  for (let i = 0; i < 24; i++) {
    const col = NEON_COLORS[Math.floor(rng.next() * NEON_COLORS.length)];
    const x = rng.range(0, W);
    const y = rng.range(H * 0.3, H * 0.5);
    const r = rng.range(8, 30);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const css = '#' + col.toString(16).padStart(6, '0');
    g.addColorStop(0, css);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // streetlight sodium glow strips near the horizon
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = '#ffb36b';
    ctx.globalAlpha = rng.range(0.4, 1);
    ctx.fillRect(rng.range(0, W), rng.range(H * 0.49, H * 0.53), 3, 2);
  }
  ctx.globalAlpha = 1;
  return c;
}

export function makeSkyTexture(): THREE.Texture {
  const [c, ctx] = canvas(16, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#010208');
  g.addColorStop(0.35, '#080a1f');
  g.addColorStop(0.49, '#24143a');
  g.addColorStop(0.5, '#120c1e');
  g.addColorStop(1, '#05050a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 512);
  const t = tex(c, true, false);
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}
