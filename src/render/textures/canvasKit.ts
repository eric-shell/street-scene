/**
 * The recipe every texture drawn on a canvas shares (street, signs, facades, the garage's room, the sky):
 * a canvas of a size, a CanvasTexture over it in sRGB (or linear for data such as roughness), repeating,
 * anisotropy 4, and the loop that shrinks a font until a label fits. Render only (needs a DOM canvas).
 */
import * as THREE from 'three';

export interface CanvasTexOptions {
  /** Color data (true) or linear data such as roughness and masks (false). */
  srgb?: boolean;
  /** Repeat wrapping on both axes (false: clamp to edge). */
  repeat?: boolean;
  anisotropy?: number;
}

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** A texture over a drawn canvas. */
export function canvasTex(c: HTMLCanvasElement, { srgb = true, repeat = true, anisotropy = 4 }: CanvasTexOptions = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  return t;
}

/** Draw a w x h canvas and wrap it in a texture. */
export function drawTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, c: HTMLCanvasElement) => void, opts?: CanvasTexOptions): THREE.CanvasTexture {
  const [c, g] = canvas(w, h);
  draw(g, c);
  return canvasTex(c, opts);
}

/**
 * Shrink a font until `text` fits `maxWidth` (px): sets g.font to `font(size)` for the largest size from
 * `size` down, in `step` px, that fits, stopping once the size is no longer above `min`; returns that size.
 */
export function fitFont(g: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, font: (px: number) => string, min = 1, step = 1): number {
  let px = size;
  g.font = font(px);
  while (px > min && g.measureText(text).width > maxWidth) {
    px -= step;
    g.font = font(px);
  }
  return px;
}

/** Pixel rectangle of one atlas cell (canvas y down). */
export interface AtlasCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Draw into one atlas cell: clipped to it, with its top left corner as the origin. */
export function drawInCell(g: CanvasRenderingContext2D, cell: AtlasCell, draw: (w: number, h: number) => void): void {
  g.save();
  g.beginPath();
  g.rect(cell.x, cell.y, cell.w, cell.h);
  g.clip();
  g.translate(cell.x, cell.y);
  draw(cell.w, cell.h);
  g.restore();
}
