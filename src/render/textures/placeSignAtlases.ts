/**
 * The atlases behind the signs that name places in the world (street/placeSigns.ts): the street name
 * blades on the junction poles (white on reflective green or blue, by the seed's home region) and the
 * neighbourhood gateway banners (a cloth with the name large and a rule above and below). Both are 2
 * columns of 512 x 128 cells (4:1, the shape of every sign here) filled in the order of the names the
 * caller passes, so a cell index is a name index. Render only (canvas).
 */
import type * as THREE from 'three';
import { canvas, canvasTex, fitFont } from './canvasKit';

export const PLACE_ATLAS = {
  cols: 2,
  cellW: 512,
  cellH: 128,
} as const;

/** Rows of an atlas holding `n` names (at least one). */
export function placeAtlasRows(n: number): number {
  return Math.max(1, Math.ceil(n / PLACE_ATLAS.cols));
}

/** Texture rectangle of cell `i` in an atlas of `n` names, drawn in canvas (y down) order, pulled in by 1.5 px so mip levels never bleed a neighbour's colour in. */
export function placeCellUV(i: number, n: number): { u0: number; u1: number; v0: number; v1: number } {
  const rows = placeAtlasRows(n);
  const iu = 1.5 / (PLACE_ATLAS.cols * PLACE_ATLAS.cellW);
  const iv = 1.5 / (rows * PLACE_ATLAS.cellH);
  const u0 = (i % PLACE_ATLAS.cols) / PLACE_ATLAS.cols;
  const v1 = 1 - Math.floor(i / PLACE_ATLAS.cols) / rows;
  return { u0: u0 + iu, u1: u0 + 1 / PLACE_ATLAS.cols - iu, v1: v1 - iv, v0: v1 - 1 / rows + iv };
}

/** The two reflective sheeting colours a city's street blades come in. */
export type BladeTone = 'green' | 'blue';

const BLADE_COLORS: Record<BladeTone, { bg: string; edge: string }> = {
  green: { bg: '#0d6a3e', edge: '#0a4a2b' },
  blue: { bg: '#0f4fa8', edge: '#0a3672' },
};

const BLADE_FONT = (px: number) => `bold ${px}px "Arial Black", Arial, sans-serif`;

/** Street name blades: white lettering and a white rule on reflective sheeting, one cell per name (upper case). */
export function makeStreetBladeAtlas(names: readonly string[], tone: BladeTone): THREE.Texture {
  const { cols, cellW, cellH } = PLACE_ATLAS;
  const [c, g] = canvas(cols * cellW, placeAtlasRows(names.length) * cellH);
  const col = BLADE_COLORS[tone];
  names.forEach((name, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    g.fillStyle = col.edge;
    g.fillRect(x, y, cellW, cellH);
    g.fillStyle = col.bg;
    g.fillRect(x + 5, y + 5, cellW - 10, cellH - 10);
    g.strokeStyle = '#f4f7f2';
    g.lineWidth = 4;
    g.strokeRect(x + 11, y + 11, cellW - 22, cellH - 22);
    const text = name.toUpperCase();
    g.fillStyle = '#f4f7f2';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, text, cellW - 70, 62, BLADE_FONT, 18, 2);
    g.fillText(text, x + cellW / 2, y + cellH / 2 + 3);
  });
  return canvasTex(c, { repeat: false });
}

/** Cloth and rule colours of the gateway banners, handed out by index. */
const BANNER_COLORS: readonly { cloth: string; rule: string; ink: string }[] = [
  { cloth: '#10243f', rule: '#f2b84b', ink: '#fff6df' },
  { cloth: '#3a0f1c', rule: '#ff7a59', ink: '#fff1e6' },
  { cloth: '#0d3a37', rule: '#7be0c3', ink: '#f2fff9' },
  { cloth: '#2a1747', rule: '#e08cff', ink: '#fbf3ff' },
  { cloth: '#1d1d22', rule: '#ffd23f', ink: '#ffffff' },
];

/**
 * Neighbourhood gateway banners: the name big on cloth, a rule above and below that runs the whole cell so the
 * plain cloth either side of the panel (which samples the cell's left edge) carries them too.
 */
export function makeGatewayAtlas(names: readonly string[]): THREE.Texture {
  const { cols, cellW, cellH } = PLACE_ATLAS;
  const [c, g] = canvas(cols * cellW, placeAtlasRows(names.length) * cellH);
  names.forEach((name, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    const k = BANNER_COLORS[i % BANNER_COLORS.length];
    g.fillStyle = k.cloth;
    g.fillRect(x, y, cellW, cellH);
    g.fillStyle = k.rule;
    g.fillRect(x, y + 8, cellW, 7);
    g.fillRect(x, y + cellH - 15, cellW, 7);
    const text = name.toUpperCase();
    g.fillStyle = k.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitFont(g, text, cellW - 60, 66, (px) => `900 ${px}px Impact, "Arial Black", sans-serif`, 20, 3);
    g.fillText(text, x + cellW / 2, y + cellH / 2 + 3);
  });
  return canvasTex(c, { repeat: false });
}
