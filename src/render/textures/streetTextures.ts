/**
 * The street's surfaces (cityMeshes): asphalt with puddle gloss, cobblestones and sidewalk slabs, each a
 * color map and, where the gloss varies, a roughness map. Seeded, so a city's streets look the same every
 * time.
 */
import type * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { canvas, canvasTex } from './canvasKit';

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
  return { map: canvasTex(c), roughness: canvasTex(rc, { srgb: false }) };
}

/** World size (m) of one repeat of the cobble texture: stones about 12 x 17 cm. */
export const COBBLE_TILE = 3;

/**
 * Cobblestones for the alleys: a running bond of rounded granite setts, each
 * its own grey with a lighter crown and a shaded foot, in dark mortar. The
 * roughness map keeps the joints dull and the crowns glossy, so the wet
 * street look picks the stones out one by one.
 */
export function makeCobble(seed: number): { map: THREE.Texture; roughness: THREE.Texture } {
  const rng = new Rng(seed ^ 0xc0bb1e);
  const S = 512;
  const cols = 24;
  const rows = 18;
  const [c, ctx] = canvas(S, S);
  const [rc, rctx] = canvas(S, S);
  ctx.fillStyle = '#17161a';
  ctx.fillRect(0, 0, S, S);
  rctx.fillStyle = 'rgb(235,235,235)';
  rctx.fillRect(0, 0, S, S);
  const rr = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  const sw = S / cols;
  const sh = S / rows;
  for (let j = 0; j < rows; j++) {
    const off = j % 2 ? sw / 2 : 0;
    for (let i = 0; i < cols; i++) {
      const x = i * sw + off + rng.range(-1.5, 1.5);
      const y = j * sh + rng.range(-1.5, 1.5);
      const w = sw - rng.range(2.5, 4.5);
      const h = sh - rng.range(2.5, 4.5);
      const k = rng.range(0.74, 1.2);
      const warm = rng.range(0.94, 1.06);
      const tone = `rgb(${Math.round(74 * k * warm)},${Math.round(72 * k)},${Math.round(70 * k / warm)})`;
      const gloss = Math.round(150 + rng.range(-30, 30));
      // Stones crossing the right edge are drawn again one tile to the left, so the texture wraps.
      for (const dx of x + w > S ? [0, -S] : [0]) {
        ctx.fillStyle = tone;
        rr(ctx, x + dx, y, w, h, 4);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.11)';
        rr(ctx, x + dx + 1, y + 1, w - 2, h * 0.45, 3);
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.24)';
        rr(ctx, x + dx + 1, y + h * 0.62, w - 2, h * 0.38 - 1, 3);
        ctx.fill();
        rctx.fillStyle = `rgb(${gloss},${gloss},${gloss})`;
        rr(rctx, x + dx, y, w, h, 4);
        rctx.fill();
        rctx.fillStyle = 'rgba(255,255,255,0.35)';
        rr(rctx, x + dx + 1, y + h * 0.62, w - 2, h * 0.38 - 1, 3);
        rctx.fill();
      }
    }
  }
  return { map: canvasTex(c), roughness: canvasTex(rc, { srgb: false }) };
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
  return canvasTex(c);
}
