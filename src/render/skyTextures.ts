/**
 * Procedural canvas textures for the sky and the weather: the mood sky dome
 * (gradient, distant city glow on the horizon, cloud mottling), the sky
 * sprite atlas (stars, the moon with its phase, halos, meteor streaks,
 * strobes), tileable noise for mist and clouds, and the blimp's LED text
 * band. Render side only; seeded so a seed always draws the same sky.
 * Separate from textures.ts so the sky work never touches the city atlases.
 */
import * as THREE from 'three';
import { Rng } from '../sim/prng';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

export interface MoodSkyParams {
  /** Gradient stops (CSS): straight up, mid sky, just above the horizon, and the ground side of the dome. */
  zenith: string;
  mid: string;
  horizon: string;
  below: string;
  /** Distant city glow along the horizon: colour and 0..1 strength (height and brightness of the band). */
  glow: string;
  glowStrength: number;
  /** 0 clear sky, 1 a solid cloud deck lit from below by the city; in between, broken cloud. */
  overcast: number;
}

/**
 * Equirectangular sky dome. The glow band sits above the horizon so it still
 * shows over the backdrop mountains, with a few brighter patches where other
 * towns would be; clouds are soft seeded blobs lit from below.
 */
export function makeMoodSky(p: MoodSkyParams, seed: number): THREE.Texture {
  const rng = new Rng((seed ^ 0x5c1e) >>> 0 || 1);
  const W = 512;
  const H = 512;
  const [c, ctx] = canvas(W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, p.zenith);
  g.addColorStop(0.3, p.mid);
  g.addColorStop(0.47, p.horizon);
  g.addColorStop(0.5, p.below);
  g.addColorStop(1, '#04040a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Clouds: soft horizontal blobs in the mid sky, more and lower with overcast, brighter near the horizon
  // where the city lights them from below.
  if (p.overcast > 0.05) {
    const n = Math.round(30 + 160 * p.overcast);
    for (let i = 0; i < n; i++) {
      const x = rng.range(0, W);
      const y = rng.range(H * (0.12 + 0.2 * (1 - p.overcast)), H * 0.49);
      const rx = rng.range(40, 120);
      const ry = rng.range(6, 16);
      const lit = (y / (H * 0.5)) ** 2;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, rx);
      const alpha = (0.05 + 0.1 * p.overcast) * (0.4 + 0.6 * lit);
      grad.addColorStop(0, `rgba(${Math.round(60 + 70 * lit)},${Math.round(50 + 45 * lit)},${Math.round(70 + 30 * lit)},${alpha.toFixed(3)})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, ry / rx);
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Wrap the ones that spill past the seam.
      if (x < rx || x > W - rx) {
        ctx.save();
        ctx.translate(x < rx ? x + W : x - W, y);
        ctx.scale(1, ry / rx);
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  // Distant city glow: a band rising from the horizon, lighter where other towns sit, blurred up into
  // the cloud deck when it is overcast.
  if (p.glowStrength > 0) {
    ctx.globalCompositeOperation = 'lighter';
    const top = H * (0.5 - 0.025 - 0.055 * p.glowStrength - 0.03 * p.overcast);
    const band = ctx.createLinearGradient(0, top, 0, H * 0.5);
    band.addColorStop(0, 'rgba(0,0,0,0)');
    band.addColorStop(0.55, p.glow);
    band.addColorStop(1, p.glow);
    ctx.globalAlpha = 0.18 + 0.3 * p.glowStrength;
    ctx.fillStyle = band;
    ctx.fillRect(0, top, W, H * 0.5 - top);
    // Towns and sprawl: brighter patches along the horizon.
    for (let i = 0; i < 7; i++) {
      const x = rng.range(0, W);
      const r = rng.range(30, 90);
      const grad = ctx.createRadialGradient(x, H * 0.5, 0, x, H * 0.5, r);
      grad.addColorStop(0, p.glow);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = rng.range(0.15, 0.4) * (0.4 + 0.6 * p.glowStrength);
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, H * 0.5 - r, r * 2, r);
      if (x < r) ctx.fillRect(x + W - r, H * 0.5 - r, r * 2, r);
      if (x > W - r) ctx.fillRect(x - W - r, H * 0.5 - r, r * 2, r);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  const t = tex(c, true, false);
  t.wrapS = THREE.RepeatWrapping;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

/** Sky sprite atlas tiles, left to right (each a square TILE px wide). */
export const SKY_TILES = { star: 0, moon: 1, halo: 2, meteor: 3, strobe: 4 } as const;
export const SKY_TILE_COUNT = 5;

/**
 * Atlas for the sky sprites: a crisp star, the moon at `phase` (0 new, 0.25
 * first quarter, 0.5 full, 0.75 last quarter) with maria and a dim earthshine
 * disc, a wide halo, a meteor streak with its head on the right, and a sharp
 * strobe dot. White on black; the sprites tint it.
 */
export function makeSkySpriteAtlas(phase: number, seed: number): THREE.Texture {
  const rng = new Rng((seed ^ 0x1a7a) >>> 0 || 1);
  const T = 128;
  const [c, ctx] = canvas(T * SKY_TILE_COUNT, T);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, T * SKY_TILE_COUNT, T);
  const radial = (x: number, y: number, r: number, stops: [number, string][]) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [o, col] of stops) g.addColorStop(o, col);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  // Star: a hard core with a short soft falloff, so it stays a point at any size.
  radial(T * 0.5, T * 0.5, T * 0.5, [
    [0, '#fff'],
    [0.12, '#fff'],
    [0.3, 'rgba(255,255,255,0.35)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  // Moon.
  {
    const cx = T * 1.5;
    const cy = T * 0.5;
    const r = T * 0.42;
    // Earthshine: the whole disc, very faint.
    ctx.fillStyle = '#1c1c22';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // The lit part is bounded by the limb on the sunlit side and the terminator, an ellipse of
    // x radius r cos(2 pi phase) that bulges toward the lit limb while the moon is a crescent and
    // away from it once it is gibbous. Waxing moons light the right limb (northern evening sky).
    const ph = ((phase % 1) + 1) % 1;
    const litRight = ph < 0.5;
    const k = Math.cos(ph * Math.PI * 2); // 1 new, -1 full
    const termRight = k > 0 ? litRight : !litRight;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, !litRight);
    if (termRight) ctx.ellipse(cx, cy, Math.max(0.5, Math.abs(k) * r), r, 0, Math.PI / 2, -Math.PI / 2, true);
    else ctx.ellipse(cx, cy, Math.max(0.5, Math.abs(k) * r), r, 0, Math.PI / 2, (3 * Math.PI) / 2, false);
    ctx.closePath();
    ctx.clip();
    radial(cx, cy, r, [
      [0, '#fdfbf2'],
      [0.75, '#efeadc'],
      [1, '#b9b4a8'],
    ]);
    ctx.fillStyle = 'rgba(120,118,112,0.55)';
    for (let i = 0; i < 9; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, r * 0.7);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(r * 0.08, r * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  // Halo: a wide soft glow (moon haze, planet glints).
  radial(T * 2.5, T * 0.5, T * 0.5, [
    [0, 'rgba(255,255,255,0.9)'],
    [0.2, 'rgba(255,255,255,0.35)'],
    [0.55, 'rgba(255,255,255,0.08)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  // Meteor: a tapered streak, bright head on the right, fading tail to the left.
  {
    const x0 = T * 3 + 6;
    const x1 = T * 4 - 10;
    const cy = T * 0.5;
    const g = ctx.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.92, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x0, cy);
    ctx.quadraticCurveTo((x0 + x1) / 2, cy - 7, x1 - 6, cy - 5);
    ctx.arc(x1 - 6, cy, 5, -Math.PI / 2, Math.PI / 2);
    ctx.quadraticCurveTo((x0 + x1) / 2, cy + 7, x0, cy);
    ctx.fill();
  }
  // Strobe: a sharp dot with a small glow.
  radial(T * 4.5, T * 0.5, T * 0.5, [
    [0, '#fff'],
    [0.18, '#fff'],
    [0.26, 'rgba(255,255,255,0.3)'],
    [0.6, 'rgba(255,255,255,0.04)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const t = tex(c, false, false);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Tileable value noise, two octaves, grayscale: mist, cloud mottling, rain variation. */
export function makeNoiseTexture(size: number, seed: number): THREE.Texture {
  const rng = new Rng((seed ^ 0x901e) >>> 0 || 1);
  const [c, ctx] = canvas(size, size);
  const img = ctx.createImageData(size, size);
  const lattice = (n: number) => {
    const v = new Float32Array(n * n);
    for (let i = 0; i < v.length; i++) v[i] = rng.next();
    return v;
  };
  const octave = (v: Float32Array, n: number, x: number, y: number) => {
    const fx = (x / size) * n;
    const fy = (y / size) * n;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => v[((j + n) % n) * n + ((i + n) % n)];
    const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
  const l1 = lattice(8);
  const l2 = lattice(23);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.65 * octave(l1, 8, x, y) + 0.35 * octave(l2, 23, x, y);
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(v * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = tex(c, false, true);
  t.anisotropy = 1;
  return t;
}

/**
 * The blimp's LED band: the words run end to end on a dark strip, drawn as a
 * dot matrix (a grid of dark lines over bold text) so it reads as LEDs when
 * it scrolls. Repeat wrap, so the shader only offsets u with time.
 */
export function makeLedTextTexture(words: string[], seed: number): THREE.Texture {
  const rng = new Rng((seed ^ 0x1ed) >>> 0 || 1);
  const W = 2048;
  const H = 64;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = '#050406';
  ctx.fillRect(0, 0, W, H);
  ctx.font = 'bold 44px "Arial Black", Impact, sans-serif';
  ctx.textBaseline = 'middle';
  const palette = ['#ffb020', '#ff3a2a', '#ffffff', '#ffd040', '#30d0ff'];
  let x = 24;
  for (const w of words) {
    const text = w.toUpperCase();
    const width = ctx.measureText(text).width;
    if (x + width > W - 24) break;
    ctx.fillStyle = palette[rng.int(0, palette.length - 1)];
    ctx.fillText(text, x, H / 2 + 1);
    x += width + 110;
  }
  // Dot matrix: knock out a grid so each lit cell is a round LED.
  ctx.fillStyle = '#050406';
  for (let gx = 0; gx < W; gx += 6) ctx.fillRect(gx, 0, 2, H);
  for (let gy = 0; gy < H; gy += 6) ctx.fillRect(0, gy, W, 2);
  const t = tex(c, true, true);
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
