/**
 * Canvas textures for the elevated railway and its trains, drawn once per
 * scene (a few milliseconds):
 *  - the structure atlas: riveted plate girder, plain steel, concrete, the
 *    station house wall with its lit windows, corrugated canopy roof and the
 *    station name boards, stacked in bands that each repeat along U, with a
 *    matching emissive atlas (only windows and sign lettering glow);
 *  - the tie strip: open deck ties with transparent gaps (alpha tested), so
 *    from the street the deck reads as slats with the night sky between;
 *  - the train atlas: stainless car side with doors, windows, a neon stripe
 *    and passengers silhouetted against the fluorescent interior, the car end
 *    with its destination sign, roof and underframe, plus emissive;
 *  - the light wash a passing train throws through the slats onto the street.
 * Band layouts are exported so geometry can address them by name.
 */
import * as THREE from 'three';

/** A band of an atlas: V range (bottom, top) and the world length one repeat of U covers (m). */
export interface Band {
  v0: number;
  v1: number;
  tile: number;
}

const STEEL_W = 512;
const STEEL_H = 1024;
/** Canvas rows (top, height) and repeat length per band of the structure atlas. */
const STEEL_ROWS = {
  girder: [0, 192, 6],
  steel: [192, 128, 3],
  concrete: [320, 128, 4],
  house: [448, 128, 6],
  roof: [576, 64, 3],
  /** Platform floor under the canopy lights: concrete with a soft glow in the emissive atlas. */
  lit: [640, 64, 4],
  signs: [704, 320, 1],
} as const;
export type SteelBandName = keyof typeof STEEL_ROWS;

/** Station names on the boards (the last board is the street entrance's SUBWAY sign). */
export const STATION_NAMES = ['NEON AV', 'CHROME ST', 'MIDNIGHT SQ', 'BAYSIDE JCT'] as const;
const SIGN_TEXTS = [...STATION_NAMES, 'SUBWAY'];
const SIGN_ROWS = 64;

/** UV band (with a 2 px gutter against mip bleeding) of a structure atlas band. */
export function steelBand(name: SteelBandName): Band {
  const [top, h, tile] = STEEL_ROWS[name];
  return { v0: 1 - (top + h - 2) / STEEL_H, v1: 1 - (top + 2) / STEEL_H, tile };
}

/** UV band of sign board k (0..3 station names, 4 the SUBWAY entrance sign). */
export function signBand(k: number): Band {
  const top = STEEL_ROWS.signs[0] + k * SIGN_ROWS;
  return { v0: 1 - (top + SIGN_ROWS - 3) / STEEL_H, v1: 1 - (top + 3) / STEEL_H, tile: 1 };
}

export const SUBWAY_SIGN = SIGN_TEXTS.length - 1;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** Tiny repeatable noise so every scene draws the same textures. */
function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function finish(c: HTMLCanvasElement, color: boolean, wrapT = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  if (wrapT) t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function rivets(c: CanvasRenderingContext2D, x0: number, x1: number, y: number, step: number, r: number): void {
  for (let x = x0; x < x1; x += step) {
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.beginPath();
    c.arc(x + 0.8, y + 0.8, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(150,165,158,0.55)';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
}

export interface SteelAtlas {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

/** The structure atlas: girder, steel, concrete, station house, roof and sign boards. */
export function makeSteelAtlas(): SteelAtlas {
  const rnd = rand(0x51ee1);
  const [cc, c] = canvas(STEEL_W, STEEL_H);
  const [ec, e] = canvas(STEEL_W, STEEL_H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, STEEL_W, STEEL_H);
  const W = STEEL_W;

  // ----- Plate girder: painted green-grey web, flanges, stiffeners every 1.5 m, rivets, rust runs.
  {
    const [top, h] = STEEL_ROWS.girder;
    c.fillStyle = '#3b4843';
    c.fillRect(0, top, W, h);
    for (let i = 0; i < 900; i++) {
      c.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.035)';
      c.fillRect(rnd() * W, top + rnd() * h, 2 + rnd() * 6, 1 + rnd() * 3);
    }
    // Flanges (angle legs riveted to the web) top and bottom.
    for (const [y, fh] of [
      [top, 20],
      [top + h - 22, 22],
    ]) {
      c.fillStyle = '#4c5a54';
      c.fillRect(0, y, W, fh);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(0, y + fh - 2, W, 2);
      c.fillStyle = 'rgba(190,205,198,0.18)';
      c.fillRect(0, y, W, 2);
      rivets(c, 4, W, y + fh / 2, 14, 2.2);
    }
    // Stiffeners.
    for (let x = 32; x < W; x += 128) {
      c.fillStyle = '#46534e';
      c.fillRect(x - 7, top + 20, 14, h - 42);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.fillRect(x + 7, top + 20, 2, h - 42);
      for (let y = top + 34; y < top + h - 26; y += 16) rivets(c, x - 3, x - 2, y, 10, 1.8);
    }
    // Rust and soot running down from the flange and the stiffener tops.
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W;
      const len = 30 + rnd() * (h - 40);
      const g = c.createLinearGradient(0, top + 18, 0, top + 18 + len);
      const rust = rnd() < 0.55;
      g.addColorStop(0, rust ? 'rgba(120,64,34,0.32)' : 'rgba(10,10,10,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(x, top + 18, 2 + rnd() * 5, len);
    }
  }

  // ----- Plain steel members: columns, beams, braces, canopy posts.
  {
    const [top, h] = STEEL_ROWS.steel;
    c.fillStyle = '#353d3b';
    c.fillRect(0, top, W, h);
    for (let i = 0; i < 500; i++) {
      c.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.04)';
      c.fillRect(rnd() * W, top + rnd() * h, 2 + rnd() * 8, 1 + rnd() * 2);
    }
    c.fillStyle = 'rgba(200,210,205,0.16)';
    c.fillRect(0, top + 2, W, 3);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(0, top + h - 6, W, 4);
    rivets(c, 6, W, top + 16, 22, 1.8);
    rivets(c, 17, W, top + h - 16, 22, 1.8);
  }

  // ----- Concrete: footings, stair stringers, platforms, portals.
  {
    const [top, h] = STEEL_ROWS.concrete;
    c.fillStyle = '#6b6d70';
    c.fillRect(0, top, W, h);
    for (let i = 0; i < 1400; i++) {
      const v = rnd();
      c.fillStyle = v < 0.5 ? `rgba(0,0,0,${0.05 + rnd() * 0.08})` : `rgba(255,255,255,${0.03 + rnd() * 0.05})`;
      c.fillRect(rnd() * W, top + rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    // Form lines every 1.2 m and a few water stains.
    for (let x = 0; x < W; x += Math.round((W / 4) * 1.2)) {
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.fillRect(x, top, 2, h);
    }
    for (let i = 0; i < 9; i++) {
      const x = rnd() * W;
      const g = c.createLinearGradient(0, top, 0, top + h);
      g.addColorStop(0, 'rgba(20,22,24,0.35)');
      g.addColorStop(1, 'rgba(20,22,24,0)');
      c.fillStyle = g;
      c.fillRect(x, top, 6 + rnd() * 18, h * (0.4 + rnd() * 0.6));
    }
  }

  // ----- Station house: sheet metal panels with a band of lit windows.
  {
    const [top, h] = STEEL_ROWS.house;
    c.fillStyle = '#48504c';
    c.fillRect(0, top, W, h);
    for (let x = 0; x < W; x += 32) {
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(x, top, 2, h);
    }
    c.fillStyle = '#5a635e';
    c.fillRect(0, top + 8, W, 8);
    const wy = top + 40;
    const wh = 44;
    for (let i = 0; i < 6; i++) {
      const x = 10 + i * 84;
      c.fillStyle = '#20262a';
      c.fillRect(x - 4, wy - 4, 72, wh + 8);
      c.fillStyle = '#0d1216';
      c.fillRect(x, wy, 64, wh);
      const lit = rnd() < 0.85;
      if (lit) {
        e.fillStyle = rnd() < 0.5 ? '#ffd9a4' : '#e9f2ff';
        e.globalAlpha = 0.65 + rnd() * 0.35;
        e.fillRect(x, wy, 64, wh);
        e.globalAlpha = 1;
        e.fillStyle = '#000';
        e.fillRect(x + 31, wy, 3, wh);
      }
    }
  }

  // ----- Lit platform floor: worn concrete, glowing faintly where the canopy tubes light it.
  {
    const [top, h] = STEEL_ROWS.lit;
    c.fillStyle = '#7a7c80';
    c.fillRect(0, top, W, h);
    for (let i = 0; i < 700; i++) {
      c.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.05)';
      c.fillRect(rnd() * W, top + rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3);
    }
    for (let i = 0; i < 40; i++) {
      c.fillStyle = 'rgba(10,10,12,0.5)';
      c.beginPath();
      c.arc(rnd() * W, top + rnd() * h, 1 + rnd() * 2, 0, Math.PI * 2);
      c.fill();
    }
    const g = e.createLinearGradient(0, top, 0, top + h);
    g.addColorStop(0, 'rgba(120,128,140,0.35)');
    g.addColorStop(0.5, 'rgba(150,158,170,0.6)');
    g.addColorStop(1, 'rgba(120,128,140,0.35)');
    e.fillStyle = g;
    e.fillRect(0, top, W, h);
  }

  // ----- Canopy roof: corrugated sheet.
  {
    const [top, h] = STEEL_ROWS.roof;
    for (let x = 0; x < W; x += 8) {
      c.fillStyle = (x / 8) % 2 ? '#3e4548' : '#545b5e';
      c.fillRect(x, top, 8, h);
    }
    for (let i = 0; i < 300; i++) {
      c.fillStyle = 'rgba(0,0,0,0.12)';
      c.fillRect(rnd() * W, top + rnd() * h, 2 + rnd() * 10, 1 + rnd() * 4);
    }
  }

  // ----- Sign boards: white lettering on black, lit.
  SIGN_TEXTS.forEach((text, k) => {
    const top = STEEL_ROWS.signs[0] + k * SIGN_ROWS;
    const subway = k === SUBWAY_SIGN;
    c.fillStyle = subway ? '#0d3b1f' : '#0a0a0c';
    c.fillRect(0, top, W, SIGN_ROWS);
    for (const ctx of [c, e]) {
      ctx.strokeStyle = subway ? '#d8ffe4' : '#f4f4f4';
      ctx.lineWidth = 3;
      ctx.strokeRect(6, top + 6, W - 12, SIGN_ROWS - 12);
      ctx.fillStyle = subway ? '#e8fff0' : '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 40;
      ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
      while (ctx.measureText(text).width > W - 60 && size > 18) {
        size -= 2;
        ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
      }
      ctx.fillText(text, W / 2, top + SIGN_ROWS / 2 + 2);
    }
  });

  return { map: finish(cc, true), emissive: finish(ec, true) };
}

/** Open deck ties across one track (U: 2.6 m across, V: 5 m along), transparent between ties. */
export function makeTieTexture(): THREE.CanvasTexture {
  const rnd = rand(0x7e5);
  const [cv, c] = canvas(128, 256);
  c.clearRect(0, 0, 128, 256);
  for (let k = 0; k < 8; k++) {
    const y = k * 32 + 10;
    const shade = 34 + Math.floor(rnd() * 16);
    c.fillStyle = `rgb(${shade + 6},${shade},${shade - 6})`;
    c.fillRect(1 + rnd() * 3, y, 124 - rnd() * 4, 13);
    for (let i = 0; i < 10; i++) {
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(rnd() * 128, y + 1 + rnd() * 11, 10 + rnd() * 30, 1);
    }
    // Tie plates under the running rails (0.72 m either side of the middle).
    c.fillStyle = '#5a5f63';
    for (const u of [64 - 35, 64 + 35]) c.fillRect(u - 7, y + 1, 14, 11);
  }
  const t = finish(cv, true, true);
  t.anisotropy = 8;
  return t;
}

export interface TrainAtlas {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

const TRAIN_W = 1024;
const TRAIN_H = 512;
/** Train atlas bands: side (U along the car), end (U 0..0.25 across the end), roof, underframe. */
export const TRAIN_BANDS = {
  side: { v0: 1 - 254 / TRAIN_H, v1: 1 - 2 / TRAIN_H, tile: 1 },
  end: { v0: 1 - 382 / TRAIN_H, v1: 1 - 258 / TRAIN_H, tile: 1 },
  roof: { v0: 1 - 446 / TRAIN_H, v1: 1 - 386 / TRAIN_H, tile: 1 },
  under: { v0: 1 - 510 / TRAIN_H, v1: 1 - 450 / TRAIN_H, tile: 1 },
} as const;

/**
 * Car side layout along its 15.4 m: three double doors, windows between, end
 * windows; heights within the 2.3 m tall side band (floor at the bottom).
 */
export const CAR_SIDE = { doors: [2.9, 7.7, 12.5], doorWidth: 1.3, length: 15.4, height: 2.3 } as const;

/** Stainless subway car: side, end, roof and underframe, with lit windows and riders. */
export function makeTrainAtlas(): TrainAtlas {
  const rnd = rand(0x7a1);
  const [cc, c] = canvas(TRAIN_W, TRAIN_H);
  const [ec, e] = canvas(TRAIN_W, TRAIN_H);
  e.fillStyle = '#000';
  e.fillRect(0, 0, TRAIN_W, TRAIN_H);
  const pxm = TRAIN_W / CAR_SIDE.length;
  const pym = 256 / CAR_SIDE.height;
  const X = (m: number) => m * pxm;
  // Side heights are from the top of the band down: roof edge at 0, floor at 2.3 m.
  const Y = (mFromFloor: number) => 256 - mFromFloor * pym;

  // ----- Side: brushed stainless with vertical fluting below the windows.
  {
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#9aa1a8');
    g.addColorStop(0.5, '#c4cad0');
    g.addColorStop(1, '#868c93');
    c.fillStyle = g;
    c.fillRect(0, 0, TRAIN_W, 256);
    for (let x = 0; x < TRAIN_W; x += 6) {
      c.fillStyle = 'rgba(0,0,0,0.08)';
      c.fillRect(x, Y(0.85), 2, Y(0) - Y(0.85));
    }
    // Neon stripe under the windows.
    c.fillStyle = '#c42a8f';
    c.fillRect(0, Y(0.95), TRAIN_W, 6);
    e.fillStyle = 'rgba(255,60,190,0.55)';
    e.fillRect(0, Y(0.95), TRAIN_W, 6);
    // Windows between doors and at the ends, lit with riders.
    const windowAt = (m0: number, m1: number) => {
      const x0 = X(m0);
      const x1 = X(m1);
      const y0 = Y(1.95);
      const y1 = Y(1.05);
      c.fillStyle = '#1b2228';
      c.fillRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
      c.fillStyle = '#0c1116';
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
      e.fillStyle = rnd() < 0.5 ? '#e4eeff' : '#f2f6ea';
      e.fillRect(x0, y0, x1 - x0, y1 - y0);
      // Riders: heads and shoulders against the light, some standing.
      for (let x = x0 + 6; x < x1 - 14; x += 16 + rnd() * 26) {
        if (rnd() < 0.35) continue;
        const standing = rnd() < 0.3;
        const hy = standing ? y0 + 8 : y0 + 20 + rnd() * 6;
        e.fillStyle = `rgba(0,0,0,${0.5 + rnd() * 0.3})`;
        // Head on a neck on rounded shoulders, cut off by the window's bottom edge.
        e.beginPath();
        e.arc(x + 7, hy + 6, 6.5, 0, Math.PI * 2);
        e.fill();
        e.fillRect(x + 4, hy + 10, 6, 6);
        e.beginPath();
        e.moveTo(x - 3, y1);
        e.lineTo(x - 3, hy + 20);
        e.quadraticCurveTo(x - 3, hy + 14, x + 7, hy + 14);
        e.quadraticCurveTo(x + 17, hy + 14, x + 17, hy + 20);
        e.lineTo(x + 17, y1);
        e.closePath();
        e.fill();
      }
    };
    const d = CAR_SIDE.doors;
    const hw = CAR_SIDE.doorWidth / 2;
    const bays = [0.35, d[0] - hw, d[0] + hw, d[1] - hw, d[1] + hw, d[2] - hw, d[2] + hw, CAR_SIDE.length - 0.35];
    for (let i = 0; i < bays.length; i += 2) {
      const a = bays[i] + 0.25;
      const b = bays[i + 1] - 0.25;
      if (b - a > 2) {
        const mid = (a + b) / 2;
        windowAt(a, mid - 0.08);
        windowAt(mid + 0.08, b);
      } else windowAt(a, b);
    }
    // Double doors with tall windows.
    for (const m of d) {
      const x0 = X(m - hw);
      const x1 = X(m + hw);
      c.fillStyle = '#8d939a';
      c.fillRect(x0, Y(2.05), x1 - x0, Y(0) - Y(2.05));
      c.fillStyle = '#2a3036';
      c.fillRect((x0 + x1) / 2 - 1, Y(2.05), 2, Y(0) - Y(2.05));
      for (const [a, b] of [
        [x0 + 8, (x0 + x1) / 2 - 8],
        [(x0 + x1) / 2 + 8, x1 - 8],
      ]) {
        c.fillStyle = '#0c1116';
        c.fillRect(a, Y(1.9), b - a, Y(1.0) - Y(1.9));
        e.fillStyle = '#dfe9ff';
        e.fillRect(a, Y(1.9), b - a, Y(1.0) - Y(1.9));
      }
    }
    // Amber LED route sign over the middle door.
    c.fillStyle = '#111';
    c.fillRect(X(d[1]) - 46, Y(2.22), 92, 12);
    e.fillStyle = '#ffae2a';
    e.font = 'bold 11px monospace';
    e.textAlign = 'center';
    e.textBaseline = 'middle';
    e.fillText('7 EXPRESS', X(d[1]), Y(2.22) + 6);
  }

  // ----- End: storm door window, side windows, destination sign, route bullet.
  {
    const top = 256;
    c.fillStyle = '#a7adb3';
    c.fillRect(0, top, 256, 128);
    c.fillStyle = '#1a1f24';
    c.fillRect(96, top + 22, 64, 70);
    c.fillRect(20, top + 30, 56, 44);
    c.fillRect(180, top + 30, 56, 44);
    e.fillStyle = '#d9e5ff';
    e.fillRect(100, top + 26, 56, 62);
    e.fillRect(24, top + 34, 48, 36);
    e.fillRect(184, top + 34, 48, 36);
    c.fillStyle = '#000';
    c.fillRect(64, top + 4, 128, 14);
    e.fillStyle = '#ffb02e';
    e.font = 'bold 12px monospace';
    e.textAlign = 'center';
    e.textBaseline = 'middle';
    e.fillText('FLUSHING', 128, top + 11);
    c.fillStyle = '#b5179e';
    c.beginPath();
    c.arc(40, top + 100, 12, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#fff';
    c.font = 'bold 16px Helvetica, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('7', 40, top + 101);
  }

  // ----- Roof: grey with vents and grime.
  {
    const top = 384;
    c.fillStyle = '#6c7177';
    c.fillRect(0, top, TRAIN_W, 64);
    for (let x = 40; x < TRAIN_W; x += 170) {
      c.fillStyle = '#4d5257';
      c.fillRect(x, top + 16, 90, 32);
      c.fillStyle = 'rgba(0,0,0,0.3)';
      for (let k = 0; k < 6; k++) c.fillRect(x + 6 + k * 14, top + 20, 6, 24);
    }
    for (let i = 0; i < 200; i++) {
      c.fillStyle = 'rgba(0,0,0,0.1)';
      c.fillRect(rnd() * TRAIN_W, top + rnd() * 64, 4 + rnd() * 20, 2 + rnd() * 6);
    }
  }

  // ----- Underframe: dark equipment boxes.
  {
    const top = 448;
    c.fillStyle = '#1c1e21';
    c.fillRect(0, top, TRAIN_W, 64);
    for (let x = 30; x < TRAIN_W; x += 110 + rnd() * 60) {
      c.fillStyle = '#2b2e32';
      c.fillRect(x, top + 8, 50 + rnd() * 40, 40);
    }
  }

  const map = finish(cc, true);
  const emissive = finish(ec, true);
  map.wrapS = emissive.wrapS = THREE.ClampToEdgeWrapping;
  return { map, emissive };
}

/** Soft oblong pool cut into slats: the light a train's windows throw through the ties. */
export function makeWashTexture(): THREE.CanvasTexture {
  const [cv, c] = canvas(64, 128);
  const img = c.createImageData(64, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 64; x++) {
      const u = (x + 0.5) / 32 - 1;
      const v = (y + 0.5) / 64 - 1;
      const r = Math.min(1, Math.sqrt(u * u * 1.0 + v * v * 1.0));
      const fall = Math.pow(1 - r, 1.6);
      const slat = 0.55 + 0.45 * Math.max(0, Math.sin((y / 128) * Math.PI * 2 * 9));
      const a = Math.max(0, fall * slat);
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * a);
      img.data[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
