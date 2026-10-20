/**
 * Procedural canvas textures: asphalt, cobblestones, sidewalks, the neon sign
 * atlas, glow sprites, and the night environment map. Building facades live
 * in facadeAtlas.ts.
 * Render-side only, so plain Math.random is fine here, but we use a seeded
 * generator anyway so the city looks the same for the same seed.
 */
import * as THREE from 'three';
import { Rng } from '../sim/prng';

/**
 * Blackbody color for a color temperature in Kelvin (Tanner Helland's fit),
 * as CSS hex. Used for every interior light so windows, doors and arches read
 * as real lamps between 2000 K (sodium warm) and 8000 K (cold daylight).
 */
export function kelvin(k: number): string {
  const t = Math.max(1000, Math.min(40000, k)) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

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

// ---------------------------------------------------------------------------
// Street polish atlases (render/streetDecals.ts, graffiti.ts, dressing.ts,
// steam.ts). Procedural and seeded like everything above; each is drawn once
// per seed and cached by the polish builder, so a race after the menu pays
// nothing for them.
// ---------------------------------------------------------------------------

/** Pixel rectangle of one atlas cell (canvas y down). */
export interface AtlasCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DECAL_ATLAS_SIZE = 1024;

/**
 * Road decal atlas cells (px). Sizes in metres are decided by the placer;
 * the cells only fix the aspect. The roughness atlas shares this layout.
 */
export const DECAL_CELLS = {
  manholeA: { x: 0, y: 0, w: 128, h: 128 },
  manholeB: { x: 128, y: 0, w: 128, h: 128 },
  drain: { x: 256, y: 0, w: 128, h: 128 },
  tarA: { x: 384, y: 0, w: 256, h: 128 },
  tarB: { x: 640, y: 0, w: 256, h: 128 },
  oil: { x: 896, y: 0, w: 128, h: 128 },
  cracksA: { x: 0, y: 128, w: 256, h: 256 },
  cracksB: { x: 256, y: 128, w: 256, h: 256 },
  skid: { x: 512, y: 128, w: 128, h: 256 },
  rubber: { x: 640, y: 128, w: 128, h: 256 },
  wear: { x: 768, y: 128, w: 128, h: 256 },
  arrowStraight: { x: 896, y: 128, w: 128, h: 256 },
  arrowLeft: { x: 0, y: 384, w: 128, h: 256 },
  arrowRight: { x: 128, y: 384, w: 128, h: 256 },
  arrowStraightLeft: { x: 256, y: 384, w: 128, h: 256 },
  arrowStraightRight: { x: 384, y: 384, w: 128, h: 256 },
  bike: { x: 512, y: 384, w: 128, h: 128 },
  paint: { x: 640, y: 384, w: 128, h: 128 },
  rust: { x: 768, y: 384, w: 128, h: 128 },
  puddle: { x: 896, y: 384, w: 128, h: 128 },
  patch: { x: 512, y: 512, w: 256, h: 128 },
  gutter: { x: 768, y: 512, w: 256, h: 128 },
  noParking: { x: 0, y: 640, w: 384, h: 128 },
  loading: { x: 384, y: 640, w: 384, h: 128 },
  busStop: { x: 768, y: 640, w: 256, h: 128 },
  towAway: { x: 0, y: 768, w: 384, h: 128 },
  keepClear: { x: 384, y: 768, w: 384, h: 128 },
  fireLane: { x: 768, y: 768, w: 256, h: 128 },
  // The bottom 128 px row is spare.
} as const satisfies Record<string, AtlasCell>;
export type DecalKind = keyof typeof DECAL_CELLS;

/**
 * Colour atlas (RGBA) and a half size roughness atlas for every road decal:
 * iron covers, grates, tar and oil (glossy), cracks, rubber, paint stencils
 * and a soft puddle blob. White cells (paint, arrows, stencils, puddle) are
 * tinted per decal with vertex colours.
 */
export function makeStreetDecalAtlas(seed: number): { map: THREE.Texture; roughness: THREE.Texture } {
  const rng = new Rng(seed ^ 0xdeca1);
  const S = DECAL_ATLAS_SIZE;
  const [c, ctx] = canvas(S, S);
  const R = S / 2;
  const [rc, rctx] = canvas(R, R);
  ctx.clearRect(0, 0, S, S);
  // Roughness default: matte (unused cells are never sampled anyway).
  rctx.fillStyle = '#e6e6e6';
  rctx.fillRect(0, 0, R, R);
  const rough = (cell: AtlasCell, v: number) => {
    const g = Math.round(v * 255);
    rctx.fillStyle = `rgb(${g},${g},${g})`;
    rctx.fillRect(cell.x / 2, cell.y / 2, cell.w / 2, cell.h / 2);
  };
  /** Clip drawing to a cell and translate to its origin. */
  const inCell = (cell: AtlasCell, draw: (w: number, h: number) => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.w, cell.h);
    ctx.clip();
    ctx.translate(cell.x, cell.y);
    draw(cell.w, cell.h);
    ctx.restore();
  };
  /** Speckle noise over a cell (dirt, wear). */
  const speckle = (cell: AtlasCell, n: number, alpha: number, color = '0,0,0') => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = `rgba(${color},${rng.range(alpha * 0.3, alpha).toFixed(2)})`;
      ctx.fillRect(cell.x + rng.range(0, cell.w), cell.y + rng.range(0, cell.h), rng.range(1, 3), rng.range(1, 3));
    }
  };
  const blob = (w: number, h: number, cx: number, cy: number, r: number, wobble: number) => {
    ctx.beginPath();
    const n = 24;
    const p1 = rng.range(0, 1);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + wobble * Math.sin(a * 3 + p1) * 0.5 + wobble * Math.sin(a * 7 + 1.3) * 0.3);
      const x = cx + Math.cos(a) * rr * (w / h >= 1 ? w / h : 1);
      const y = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };

  // Manhole covers: cast iron disc with a raised rim and a pattern.
  for (const [cell, pattern] of [
    [DECAL_CELLS.manholeA, 'rings'],
    [DECAL_CELLS.manholeB, 'grid'],
  ] as const) {
    inCell(cell, (w, h) => {
      const cx = w / 2;
      const cy = h / 2;
      const r = w * 0.46;
      ctx.fillStyle = '#4a4c53';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#787b85';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#1a1b1e';
      ctx.lineWidth = 2;
      if (pattern === 'rings') {
        for (let k = 1; k <= 4; k++) {
          ctx.beginPath();
          ctx.arc(cx, cy, (r - 10) * (k / 4.6), 0, Math.PI * 2);
          ctx.stroke();
        }
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8);
          ctx.lineTo(cx + Math.cos(a) * (r - 10), cy + Math.sin(a) * (r - 10));
          ctx.stroke();
        }
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r - 8, 0, Math.PI * 2);
        ctx.clip();
        for (let x = -w; x < w * 2; x += 9) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + h, h);
          ctx.moveTo(x, h);
          ctx.lineTo(x + h, 0);
          ctx.stroke();
        }
        ctx.restore();
      }
      // A dull highlight across the top edge, as if lit by the streetlights.
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0.14)');
      g.addColorStop(0.5, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    });
    rough(cell, 0.5);
  }
  // Storm drain: a slotted grate in a frame.
  inCell(DECAL_CELLS.drain, (w, h) => {
    ctx.fillStyle = '#2e3037';
    ctx.fillRect(4, 22, w - 8, h - 44);
    ctx.fillStyle = '#5e616b';
    ctx.fillRect(4, 22, w - 8, 5);
    ctx.fillRect(4, h - 27, w - 8, 5);
    ctx.fillStyle = '#0a0a0c';
    for (let x = 12; x < w - 12; x += 12) ctx.fillRect(x, 30, 6, h - 60);
  });
  rough(DECAL_CELLS.drain, 0.6);
  // Tar patches: near black, glossy, ragged edges, a few seams.
  for (const cell of [DECAL_CELLS.tarA, DECAL_CELLS.tarB]) {
    inCell(cell, (w, h) => {
      ctx.fillStyle = 'rgba(16,16,20,0.92)';
      blob(w, h, w / 2, h / 2, h * 0.42, 0.5);
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,40,46,0.6)';
      ctx.lineWidth = 2;
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(rng.range(0, w), rng.range(0, h));
        ctx.lineTo(rng.range(0, w), rng.range(0, h));
        ctx.stroke();
      }
    });
    speckle(cell, 160, 0.4, '70,70,80');
    rough(cell, 0.28);
  }
  // Oil stain: soft dark blob with a faint sheen ring.
  inCell(DECAL_CELLS.oil, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w * 0.48);
    g.addColorStop(0, 'rgba(8,8,12,0.85)');
    g.addColorStop(0.6, 'rgba(14,12,18,0.55)');
    g.addColorStop(0.82, 'rgba(60,40,70,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    blob(w, h, w / 2, h / 2, w * 0.46, 0.35);
    ctx.fill();
  });
  rough(DECAL_CELLS.oil, 0.12);
  // Cracks: a few random walks with branches, alpha only on the lines.
  for (const cell of [DECAL_CELLS.cracksA, DECAL_CELLS.cracksB]) {
    inCell(cell, (w, h) => {
      ctx.strokeStyle = 'rgba(6,6,8,0.75)';
      ctx.lineCap = 'round';
      const walk = (x: number, y: number, a: number, len: number, width: number, depth: number) => {
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let i = 0; i < len; i++) {
          a += rng.range(-0.6, 0.6);
          x += Math.cos(a) * 6;
          y += Math.sin(a) * 6;
          ctx.lineTo(x, y);
          if (depth < 2 && rng.chance(0.08)) walk(x, y, a + rng.pick([-1.2, 1.2]), Math.floor(len * 0.4), width * 0.6, depth + 1);
        }
        ctx.stroke();
      };
      walk(rng.range(10, w - 10), 4, Math.PI / 2 + rng.range(-0.5, 0.5), 38, 3, 0);
      walk(4, rng.range(10, h - 10), rng.range(-0.5, 0.5), 30, 2.2, 0);
    });
    rough(cell, 0.85);
  }
  // Skid: two soft rubber streaks a track width apart; rubber: one wide smear (corner rubbering).
  inCell(DECAL_CELLS.skid, (w, h) => {
    for (const x of [w * 0.28, w * 0.72]) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.2, 'rgba(0,0,0,0.88)');
      g.addColorStop(0.8, 'rgba(0,0,0,0.88)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      for (let y = 0; y < h; y += 3) ctx.fillRect(x - 9 + rng.range(-1.5, 1.5), y, 18 + rng.range(-3, 3), 3);
    }
  });
  speckle(DECAL_CELLS.skid, 200, 0.35, '20,20,24');
  rough(DECAL_CELLS.skid, 0.45);
  inCell(DECAL_CELLS.rubber, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.save();
    ctx.scale(1, h / w);
    ctx.fillRect(0, 0, w, w);
    ctx.restore();
  });
  speckle(DECAL_CELLS.rubber, 120, 0.3, '10,10,12');
  rough(DECAL_CELLS.rubber, 0.5);
  // Wear band: a soft vertical band (tinted asphalt by the placer) that dulls paint under wheel tracks.
  inCell(DECAL_CELLS.wear, (w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    for (let y = 0; y < h; y += 2) {
      ctx.globalAlpha = rng.range(0.5, 1);
      ctx.fillRect(0, y, w, 2);
    }
    ctx.globalAlpha = 1;
  });
  rough(DECAL_CELLS.wear, 0.9);
  // Lane arrows: white, slightly worn.
  const arrow = (cell: AtlasCell, kinds: ('s' | 'l' | 'r')[]) => {
    inCell(cell, (w, h) => {
      ctx.fillStyle = 'rgba(235,236,240,0.95)';
      const shaft = w * 0.18;
      ctx.fillRect(w / 2 - shaft / 2, h * 0.3, shaft, h * 0.62);
      if (kinds.includes('s')) {
        ctx.beginPath();
        ctx.moveTo(w / 2, h * 0.06);
        ctx.lineTo(w / 2 + w * 0.3, h * 0.36);
        ctx.lineTo(w / 2 - w * 0.3, h * 0.36);
        ctx.closePath();
        ctx.fill();
      } else ctx.fillRect(w / 2 - shaft / 2, h * 0.26, shaft, h * 0.1);
      for (const side of kinds.filter((k) => k !== 's')) {
        const dir = side === 'l' ? -1 : 1;
        const y = kinds.includes('s') ? h * 0.52 : h * 0.3;
        ctx.fillRect(dir > 0 ? w / 2 : w / 2 - w * 0.3, y, w * 0.3, shaft);
        ctx.beginPath();
        ctx.moveTo(w / 2 + dir * w * 0.46, y + shaft / 2);
        ctx.lineTo(w / 2 + dir * w * 0.26, y - h * 0.06);
        ctx.lineTo(w / 2 + dir * w * 0.26, y + shaft + h * 0.06);
        ctx.closePath();
        ctx.fill();
      }
    });
    speckle(cell, 90, 0.45, '30,30,34');
    rough(cell, 0.6);
  };
  arrow(DECAL_CELLS.arrowStraight, ['s']);
  arrow(DECAL_CELLS.arrowLeft, ['l']);
  arrow(DECAL_CELLS.arrowRight, ['r']);
  arrow(DECAL_CELLS.arrowStraightLeft, ['s', 'l']);
  arrow(DECAL_CELLS.arrowStraightRight, ['s', 'r']);
  // Bicycle stencil.
  inCell(DECAL_CELLS.bike, (w, h) => {
    ctx.strokeStyle = 'rgba(240,240,244,0.95)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (const cx of [w * 0.27, w * 0.73]) {
      ctx.beginPath();
      ctx.arc(cx, h * 0.68, w * 0.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(w * 0.27, h * 0.68);
    ctx.lineTo(w * 0.45, h * 0.35);
    ctx.lineTo(w * 0.73, h * 0.68);
    ctx.lineTo(w * 0.6, h * 0.35);
    ctx.lineTo(w * 0.45, h * 0.35);
    ctx.moveTo(w * 0.6, h * 0.35);
    ctx.lineTo(w * 0.55, h * 0.2);
    ctx.lineTo(w * 0.68, h * 0.2);
    ctx.stroke();
  });
  rough(DECAL_CELLS.bike, 0.6);
  // Paint: mottled white, used tinted for curb zones, bike lanes and green boxes.
  inCell(DECAL_CELLS.paint, (w, h) => {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(0, 0, w, h);
  });
  speckle(DECAL_CELLS.paint, 400, 0.5, '40,40,44');
  rough(DECAL_CELLS.paint, 0.65);
  // Rust ring (around manholes) and the puddle blob.
  inCell(DECAL_CELLS.rust, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.3, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(90,50,20,0)');
    g.addColorStop(0.3, 'rgba(90,50,20,0.4)');
    g.addColorStop(1, 'rgba(60,30,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
  rough(DECAL_CELLS.rust, 0.95);
  inCell(DECAL_CELLS.puddle, (w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    blob(w, h, w / 2, h / 2, w * 0.48, 0.3);
    ctx.fill();
  });
  rough(DECAL_CELLS.puddle, 0.02);
  // Fresh patch: a lighter rectangle of new asphalt with a tar seam.
  inCell(DECAL_CELLS.patch, (w, h) => {
    ctx.fillStyle = 'rgba(44,46,54,0.85)';
    ctx.fillRect(6, 6, w - 12, h - 12);
    ctx.strokeStyle = 'rgba(10,10,12,0.9)';
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, w - 12, h - 12);
  });
  speckle(DECAL_CELLS.patch, 300, 0.35, '80,82,90');
  rough(DECAL_CELLS.patch, 0.75);
  // Gutter grime: a dark streak that fades across (laid along the curb).
  inCell(DECAL_CELLS.gutter, (w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(10,9,8,0.55)');
    g.addColorStop(0.5, 'rgba(10,9,8,0.2)');
    g.addColorStop(1, 'rgba(10,9,8,0)');
    ctx.fillStyle = g;
    for (let x = 0; x < w; x += 4) {
      ctx.globalAlpha = rng.range(0.4, 1);
      ctx.fillRect(x, 0, 4, h);
    }
    ctx.globalAlpha = 1;
  });
  speckle(DECAL_CELLS.gutter, 200, 0.4, '70,60,40');
  rough(DECAL_CELLS.gutter, 0.9);
  // Stencils: worn white block letters.
  const stencil = (cell: AtlasCell, text: string) => {
    inCell(cell, (w, h) => {
      ctx.fillStyle = 'rgba(232,232,236,0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = h * 0.62;
      ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
      while (ctx.measureText(text).width > w - 24 && size > 20) {
        size -= 4;
        ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
      }
      ctx.fillText(text, w / 2, h / 2 + 2);
    });
    speckle(cell, 140, 0.5, '30,30,34');
    rough(cell, 0.6);
  };
  stencil(DECAL_CELLS.noParking, 'NO PARKING');
  stencil(DECAL_CELLS.loading, 'LOADING ZONE');
  stencil(DECAL_CELLS.busStop, 'BUS STOP');
  stencil(DECAL_CELLS.towAway, 'TOW AWAY ZONE');
  stencil(DECAL_CELLS.keepClear, 'KEEP CLEAR');
  stencil(DECAL_CELLS.fireLane, 'FIRE LANE');
  const map = tex(c, true, false);
  map.anisotropy = 8;
  const roughness = tex(rc, false, false);
  return { map, roughness };
}

export const GRAFFITI_ATLAS = { w: 1024, h: 896 } as const;

/** Graffiti atlas cells by kind; `n` copies of each kind sit side by side from (x, y). */
export const GRAFFITI_CELLS = {
  mural: { x: 0, y: 0, w: 512, h: 256, n: 2 },
  throwup: { x: 0, y: 256, w: 256, h: 128, n: 4 },
  tag: { x: 0, y: 384, w: 128, h: 64, n: 8 },
  stencil: { x: 0, y: 448, w: 128, h: 128, n: 6 },
  flyers: { x: 768, y: 448, w: 128, h: 128, n: 2 },
  poster: { x: 0, y: 576, w: 256, h: 192, n: 4 },
  banner: { x: 0, y: 768, w: 384, h: 128, n: 2 },
  grime: { x: 768, y: 768, w: 256, h: 128, n: 1 },
} as const;
export type GraffitiKind = keyof typeof GRAFFITI_CELLS;

export function graffitiCell(kind: GraffitiKind, i: number): AtlasCell {
  const c = GRAFFITI_CELLS[kind];
  return { x: c.x + (i % c.n) * c.w, y: c.y, w: c.w, h: c.h };
}

const GRAFFITI_WORDS = ['NIGHT', 'RUN', 'DRIFT', 'VOLT', 'KAIJU', 'ZERO', 'APEX', 'SONIC', 'NEON', 'LUCKY', 'ORBIT', 'ROXY', 'HYPER', 'OKAMI', 'TURBO', 'SAKURA', 'NOIR', 'FLUX'];
const GRAFFITI_INKS = ['#ff2bd6', '#22e6ff', '#ffe14d', '#7cff4f', '#ff5a36', '#a66bff', '#ff3b6b', '#3bffb4', '#ffffff', '#ff9d1a'];
const POSTER_LINES = [
  ['DRIFT NIGHT', 'SAT 11PM', 'PIER 9'],
  ['LIVE', 'KAIJU KARAOKE', 'EVERY FRI'],
  ['STREET SCENE', 'AFTER DARK', 'ROUND 3'],
  ['LOST CAT', 'ANSWERS TO', 'NITRO'],
  ['TATTOO', 'WALK INS', 'OPEN LATE'],
  ['DJ ORBIT', 'ROXY', 'DOORS 10'],
  ['BUY SELL', 'TRADE', 'VOLT MOTORS'],
  ['NO SLEEP', 'TIL', 'SUNRISE'],
];

/**
 * Graffiti, posters, flyers, banners and a grime gradient for walls: murals
 * and throw-ups in bubble letters with outlines and drips, quick tags,
 * stencils, pasted posters and flyer clusters. RGBA, alpha outside the art.
 */
export function makeGraffitiAtlas(seed: number): THREE.Texture {
  const rng = new Rng(seed ^ 0x6ff1);
  const [c, ctx] = canvas(GRAFFITI_ATLAS.w, GRAFFITI_ATLAS.h);
  ctx.clearRect(0, 0, GRAFFITI_ATLAS.w, GRAFFITI_ATLAS.h);
  const inCell = (cell: AtlasCell, draw: (w: number, h: number) => void) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.w, cell.h);
    ctx.clip();
    ctx.translate(cell.x, cell.y);
    draw(cell.w, cell.h);
    ctx.restore();
  };
  const pickInk = () => GRAFFITI_INKS[rng.int(0, GRAFFITI_INKS.length - 1)];
  const drips = (x: number, y: number, w: number, color: string, n: number) => {
    ctx.fillStyle = color;
    for (let i = 0; i < n; i++) {
      const dx = x + rng.range(0, w);
      const len = rng.range(6, 30);
      ctx.fillRect(dx, y, 3, len);
      ctx.beginPath();
      ctx.arc(dx + 1.5, y + len, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  /** Chunky outlined word, the throw-up / piece look. */
  const bubbleWord = (w: number, h: number, word: string, fill: string, outline: string, size: number, wobble: boolean) => {
    ctx.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const x = w / 2;
    const y = h / 2;
    ctx.save();
    if (wobble) ctx.transform(1, rng.range(-0.08, 0.08), rng.range(-0.25, 0.25), 1, 0, 0);
    // Shadow, fat outline, fill, highlight.
    ctx.lineWidth = size * 0.32;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(word, x + size * 0.08, y + size * 0.08);
    ctx.lineWidth = size * 0.26;
    ctx.strokeStyle = outline;
    ctx.strokeText(word, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(word, x, y);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(word, x - size * 0.03, y - size * 0.05);
    ctx.restore();
  };
  for (let i = 0; i < GRAFFITI_CELLS.mural.n; i++) {
    inCell(graffitiCell('mural', i), (w, h) => {
      // Background wash of colour blocks, then one big word.
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = pickInk();
        ctx.globalAlpha = rng.range(0.25, 0.6);
        const bw = rng.range(w * 0.2, w * 0.6);
        const bh = rng.range(h * 0.3, h * 0.9);
        ctx.fillRect(rng.range(-20, w - bw + 20), rng.range(-10, h - bh + 10), bw, bh);
      }
      ctx.globalAlpha = 1;
      const word = GRAFFITI_WORDS[rng.int(0, GRAFFITI_WORDS.length - 1)];
      bubbleWord(w, h * 0.9, word, pickInk(), '#111', Math.min(h * 0.62, (w * 1.6) / Math.max(4, word.length)), true);
      drips(w * 0.2, h * 0.68, w * 0.6, 'rgba(20,20,20,0.7)', 7);
      // Character: a crude face in a corner.
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(w * 0.86, h * 0.72, h * 0.16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = pickInk();
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.fillRect(w * 0.82, h * 0.67, 8, 8);
      ctx.fillRect(w * 0.88, h * 0.67, 8, 8);
      ctx.beginPath();
      ctx.arc(w * 0.86, h * 0.76, h * 0.07, 0, Math.PI);
      ctx.stroke();
    });
  }
  for (let i = 0; i < GRAFFITI_CELLS.throwup.n; i++) {
    inCell(graffitiCell('throwup', i), (w, h) => {
      const word = GRAFFITI_WORDS[rng.int(0, GRAFFITI_WORDS.length - 1)];
      const ink = pickInk();
      bubbleWord(w, h, word, ink, rng.chance(0.5) ? '#101010' : '#f4f4f4', Math.min(h * 0.72, (w * 1.5) / Math.max(4, word.length)), true);
      drips(w * 0.25, h * 0.7, w * 0.5, ink, 4);
    });
  }
  for (let i = 0; i < GRAFFITI_CELLS.tag.n; i++) {
    inCell(graffitiCell('tag', i), (w, h) => {
      const word = GRAFFITI_WORDS[rng.int(0, GRAFFITI_WORDS.length - 1)].toLowerCase();
      ctx.strokeStyle = pickInk();
      ctx.lineWidth = rng.range(3, 5);
      ctx.lineCap = 'round';
      ctx.font = `italic 700 ${h * 0.7}px "Brush Script MT", "Comic Sans MS", cursive`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.transform(1, rng.range(-0.15, 0.15), rng.range(-0.4, 0.1), 1, 0, 0);
      ctx.strokeText(word, w / 2, h / 2);
      ctx.restore();
      // Underline flourish.
      ctx.beginPath();
      ctx.moveTo(w * 0.15, h * 0.82);
      ctx.quadraticCurveTo(w * 0.6, h * 0.95, w * 0.9, h * 0.75);
      ctx.stroke();
    });
  }
  const stencilShapes: ((w: number, h: number) => void)[] = [
    (w, h) => {
      // star
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? w * 0.18 : w * 0.42;
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        ctx.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // crown
      ctx.beginPath();
      ctx.moveTo(w * 0.15, h * 0.75);
      ctx.lineTo(w * 0.15, h * 0.3);
      ctx.lineTo(w * 0.35, h * 0.5);
      ctx.lineTo(w * 0.5, h * 0.2);
      ctx.lineTo(w * 0.65, h * 0.5);
      ctx.lineTo(w * 0.85, h * 0.3);
      ctx.lineTo(w * 0.85, h * 0.75);
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // arrow up
      ctx.beginPath();
      ctx.moveTo(w / 2, h * 0.15);
      ctx.lineTo(w * 0.85, h * 0.5);
      ctx.lineTo(w * 0.62, h * 0.5);
      ctx.lineTo(w * 0.62, h * 0.85);
      ctx.lineTo(w * 0.38, h * 0.85);
      ctx.lineTo(w * 0.38, h * 0.5);
      ctx.lineTo(w * 0.15, h * 0.5);
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // skull: round head, jaw, eye holes cut out
      ctx.beginPath();
      ctx.arc(w / 2, h * 0.42, w * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(w * 0.32, h * 0.55, w * 0.36, h * 0.25);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(w * 0.4, h * 0.42, w * 0.08, 0, Math.PI * 2);
      ctx.arc(w * 0.6, h * 0.42, w * 0.08, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 3; k++) ctx.fillRect(w * 0.38 + k * w * 0.1, h * 0.66, w * 0.04, h * 0.12);
      ctx.restore();
    },
    (w, h) => {
      // lightning bolt
      ctx.beginPath();
      ctx.moveTo(w * 0.6, h * 0.1);
      ctx.lineTo(w * 0.3, h * 0.55);
      ctx.lineTo(w * 0.5, h * 0.55);
      ctx.lineTo(w * 0.4, h * 0.9);
      ctx.lineTo(w * 0.72, h * 0.42);
      ctx.lineTo(w * 0.52, h * 0.42);
      ctx.closePath();
      ctx.fill();
    },
    (w, h) => {
      // eye
      ctx.beginPath();
      ctx.moveTo(w * 0.1, h / 2);
      ctx.quadraticCurveTo(w / 2, h * 0.1, w * 0.9, h / 2);
      ctx.quadraticCurveTo(w / 2, h * 0.9, w * 0.1, h / 2);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  ];
  for (let i = 0; i < GRAFFITI_CELLS.stencil.n; i++) {
    inCell(graffitiCell('stencil', i), (w, h) => {
      ctx.fillStyle = rng.chance(0.5) ? '#101010' : pickInk();
      ctx.globalAlpha = 0.9;
      stencilShapes[i % stencilShapes.length](w, h);
      ctx.globalAlpha = 1;
    });
  }
  const paper = (x: number, y: number, w: number, h: number, lines: string[], tone: string) => {
    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(rng.range(-0.08, 0.08));
    ctx.fillStyle = tone;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(-w / 2, h / 2 - 4, w, 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, k) => {
      const big = k === 0;
      let size = big ? h * 0.26 : h * 0.14;
      const font = () => `${big ? 900 : 700} ${size}px ${big ? 'Impact, "Arial Black"' : 'Arial'}, sans-serif`;
      ctx.font = font();
      while (ctx.measureText(line).width > w - 10 && size > 6) {
        size -= 1;
        ctx.font = font();
      }
      ctx.fillStyle = big ? (tone === '#ffffff' ? '#16161a' : pickInk()) : '#1a1a1e';
      ctx.fillText(line, 0, -h * 0.28 + k * h * 0.28);
    });
    ctx.restore();
  };
  for (let i = 0; i < GRAFFITI_CELLS.flyers.n; i++) {
    inCell(graffitiCell('flyers', i), (w, h) => {
      for (let k = 0; k < 5; k++) {
        const lines = POSTER_LINES[rng.int(0, POSTER_LINES.length - 1)];
        paper(rng.range(0, w * 0.5), rng.range(0, h * 0.5), w * 0.48, h * 0.48, lines, rng.pick(['#ffffff', '#ffe14d', '#f4c7ff', '#bfefff']));
      }
    });
  }
  for (let i = 0; i < GRAFFITI_CELLS.poster.n; i++) {
    inCell(graffitiCell('poster', i), (w, h) => {
      const lines = POSTER_LINES[(i * 2 + rng.int(0, 1)) % POSTER_LINES.length];
      const dark = rng.chance(0.5);
      ctx.fillStyle = dark ? '#15131a' : '#f2efe8';
      ctx.fillRect(6, 6, w - 12, h - 12);
      // A colour block and a halftone band for a gig poster feel.
      ctx.fillStyle = pickInk();
      ctx.globalAlpha = 0.85;
      ctx.fillRect(6, h * 0.55, w - 12, h * 0.22);
      ctx.globalAlpha = 1;
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
      for (let yy = 12; yy < h * 0.5; yy += 8) for (let xx = 12; xx < w - 12; xx += 8) ctx.fillRect(xx, yy, 3, 3);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dark ? '#ffffff' : '#111';
      ctx.font = `900 ${h * 0.2}px Impact, "Arial Black", sans-serif`;
      ctx.fillText(lines[0], w / 2, h * 0.3, w - 24);
      ctx.font = `700 ${h * 0.11}px Arial, sans-serif`;
      ctx.fillStyle = dark ? '#111' : '#fff';
      ctx.fillText(lines[1], w / 2, h * 0.66, w - 24);
      ctx.fillStyle = dark ? '#dddddd' : '#222';
      ctx.font = `700 ${h * 0.09}px Arial, sans-serif`;
      ctx.fillText(lines[2], w / 2, h * 0.86, w - 24);
      // Torn corner.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(w - 6, h - 40);
      ctx.lineTo(w - 6, h - 6);
      ctx.lineTo(w - 40, h - 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  }
  const BANNER_TEXT = ['STREET SCENE · AFTER DARK', 'ROUND 3 · NIGHT SERIES'];
  for (let i = 0; i < GRAFFITI_CELLS.banner.n; i++) {
    inCell(graffitiCell('banner', i), (w, h) => {
      ctx.fillStyle = i ? '#1a1030' : '#2a0e1c';
      ctx.fillRect(0, 8, w, h - 16);
      ctx.fillStyle = i ? '#22e6ff' : '#ff2bd6';
      ctx.fillRect(0, 8, w, 6);
      ctx.fillRect(0, h - 14, w, 6);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${h * 0.42}px Impact, "Arial Black", sans-serif`;
      ctx.fillText(BANNER_TEXT[i], w / 2, h / 2, w - 30);
    });
  }
  inCell(graffitiCell('grime', 0), (w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(12,10,8,0)');
    g.addColorStop(0.55, 'rgba(12,10,8,0.35)');
    g.addColorStop(1, 'rgba(10,8,6,0.8)');
    ctx.fillStyle = g;
    for (let x = 0; x < w; x += 3) {
      ctx.globalAlpha = rng.range(0.5, 1);
      ctx.fillRect(x, rng.range(-8, 8), 3, h);
    }
    ctx.globalAlpha = 1;
  });
  const t = tex(c, true, false);
  t.anisotropy = 8;
  return t;
}

export const BLADE_SIGN_TEXTS = ['BAR', 'HOTEL', 'PIZZA', 'TATTOO', '24H', 'LIQUOR', 'RAMEN', 'LIVE', 'DINER', 'LAUNDRY', 'PAWN', 'TEA'] as const;
export const BLADE_SIGN_COLS = 6;
export const BLADE_SIGN_ROWS = 2;

/** Hanging blade signs: white glyphs on a dark panel, tinted per sign by vertex colours. */
export function makeBladeSignAtlas(): THREE.Texture {
  const cw = 170;
  const ch = 128;
  const [c, ctx] = canvas(cw * BLADE_SIGN_COLS, ch * BLADE_SIGN_ROWS);
  BLADE_SIGN_TEXTS.forEach((text, i) => {
    const x = (i % BLADE_SIGN_COLS) * cw;
    const y = Math.floor(i / BLADE_SIGN_COLS) * ch;
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(x + 4, y + 4, cw - 8, ch - 8);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 10, y + 10, cw - 20, ch - 20);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 56;
    ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    while (ctx.measureText(text).width > cw - 36 && size > 18) {
      size -= 3;
      ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    }
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + cw / 2, y + ch / 2 + 2);
    ctx.shadowBlur = 0;
  });
  const t = tex(c, true, false);
  t.anisotropy = 4;
  return t;
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
  return tex(c, false, false);
}
