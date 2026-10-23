/**
 * Small shared sprites and the night environment: the radial glow every lamp and pool blooms with, the start
 * line's checker, the steam puff, the neon palette, and the equirectangular night panorama the cars reflect.
 * The street's surfaces, sign atlases, road decals and wall paper have modules of their own beside this one;
 * building facades live in render/buildings. Render only; seeded anyway, so a seed looks the same each time.
 */
import * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { canvas, canvasTex } from './canvasKit';

// The street and building builders still import these from here (render/street, render/buildings); they
// belong to the modules named, so new code imports them from there.
export { kelvin } from '../color';
export { COBBLE_TILE, makeAsphalt, makeCobble, makeSidewalk } from './streetTextures';
export { BLADE_SIGN_COLS, BLADE_SIGN_ROWS, BLADE_SIGN_TEXTS, SIGN_ATLAS_COLS, SIGN_ATLAS_ROWS, SIGN_NAMES, makeBladeSignAtlas, makeSignAtlas } from './signAtlases';
export { DECAL_ATLAS_SIZE, DECAL_CELLS, makeStreetDecalAtlas, type DecalKind } from './streetDecalAtlas';
export { WALL_ATLAS, makeWallAtlas, wallCell, type WallKind } from './wallAtlas';
export type { AtlasCell } from './canvasKit';

/** Neon sign colors: the podium signs and roof neon (buildings), blade signs and the panorama's blobs. */
export const NEON_COLORS = [0xff2bd6, 0x22e6ff, 0xffe14d, 0x7cff4f, 0xff5a36, 0xa66bff, 0xff3b6b, 0x3bffb4];

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
  return canvasTex(c, { srgb: false, repeat: false });
}

export function makeCheckerTexture(): THREE.Texture {
  const [c, ctx] = canvas(128, 32);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#111' : '#eee';
      ctx.fillRect(i * 8, j * 8, 8, 8);
    }
  }
  const t = canvasTex(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Equirectangular night city panorama used for reflections. */
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

/** Soft, slightly ragged puff for steam and vent haze (alpha only). */
export function makeSteamPuff(): THREE.Texture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // A few holes so overlapping puffs do not read as one disc.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const r = S * 0.3;
    const hx = S / 2 + Math.cos(a) * r;
    const hy = S / 2 + Math.sin(a) * r;
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, S * 0.16);
    hg.addColorStop(0, 'rgba(0,0,0,0.5)');
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, 0, S, S);
  }
  return canvasTex(c, { srgb: false, repeat: false });
}
