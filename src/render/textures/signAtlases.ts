/**
 * Sign atlases: the podiums' neon name signs (cityMeshes) and the hanging blade signs (wallDressing), white
 * glyphs on dark panels so each sign tints its own with vertex colors.
 */
import type * as THREE from 'three';
import { canvas, canvasTex, fitFont } from './canvasKit';

/** The neon signs on the podiums (cityMeshes), a name per cell of the sign atlas. */
export const SIGN_NAMES = [
  'NEON NOODLE', 'KAIJU KARAOKE', 'MIDNIGHT TUNE', 'ZERO AUTO', 'LUCKY 7', 'SAKURA BAR',
  'TURBO TACO', 'CYBER CAFE', 'VOLT MOTORS', 'NIGHT OWL', 'RAMEN 24H', 'HOTEL ORBIT',
  'STARLITE', 'DRIFT CLUB', 'PIXEL ARCADE', 'BLUE LOTUS', 'GOLDEN DRAGON', 'APEX GARAGE',
  'CHROME DINER', 'OKAMI SUSHI', 'HYPER MART', 'LASER BOWL', 'ROXY', 'MOTEL 99',
];
export const SIGN_ATLAS_COLS = 4;
export const SIGN_ATLAS_ROWS = 6;
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
    fitFont(ctx, name, cw - 60, 70, (px) => `bold ${px}px "Arial Black", Impact, sans-serif`, 20, 4);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 22;
    ctx.fillText(name, x + cw / 2, y + chh / 2 + 4);
    ctx.shadowBlur = 0;
  });
  return canvasTex(c, { repeat: false });
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
    fitFont(ctx, text, cw - 36, 56, (px) => `900 ${px}px Impact, "Arial Black", sans-serif`, 18, 3);
    ctx.shadowColor = '#fff';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + cw / 2, y + ch / 2 + 2);
    ctx.shadowBlur = 0;
  });
  return canvasTex(c, { repeat: false });
}
