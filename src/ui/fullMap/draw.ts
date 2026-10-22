/**
 * The full map's stateless painters: the cached city bitmaps (rasters) and
 * how they are blitted into a moving view, the grid, its edge labels and the
 * scale bar, lit outlines, the reveal ring, the player's marker, off-view
 * arrows, and the sprites drawn once per pixel ratio (the start and finish
 * discs, the waypoint pin). Everything takes the canvas, the view and what it
 * needs; FullMap owns the state and the order.
 */
import { MAP_PAD, mapHeading, mapX, mapY, type MapView } from '../cityMap';
import { Flag, FlagTriangleRight, drawIcon, type IconNode } from '../icons';
import { PALETTE } from '../palette';
import { INK, PIN, PINGS, SCALE_STEPS, UI, colName } from './tuning';

/** The city's road bounds (m), which the grid and its labels are laid over. */
type Bounds = { minX: number; maxX: number; minZ: number; maxZ: number };

/** A cached bitmap of the city drawn through one view. */
export interface Raster {
  readonly cv: HTMLCanvasElement;
  readonly c: CanvasRenderingContext2D;
  readonly view: MapView;
  ok: boolean;
  /** Map time it was drawn at (s). */
  at: number;
}

export function newRaster(): Raster {
  const cv = document.createElement('canvas');
  return { cv, c: cv.getContext('2d', { alpha: false })!, view: { cx: 0, cz: 0, scale: 1, w: 1, h: 1 }, ok: false, at: -1 };
}

const RECT = { x: 0, y: 0, w: 0, h: 0 };

/** The bitmap's rectangle in the current view (device px; a shared scratch rectangle). */
function rasterRect(r: Raster, v: MapView): { x: number; y: number; w: number; h: number } {
  const k = v.scale / r.view.scale;
  RECT.x = v.w / 2 - (r.view.cx - v.cx) * v.scale - (r.view.w / 2) * k;
  RECT.y = v.h / 2 - (r.view.cz - v.cz) * v.scale - (r.view.h / 2) * k;
  RECT.w = r.view.w * k;
  RECT.h = r.view.h * k;
  return RECT;
}

/** Whether the bitmap covers the whole view. */
export function covers(r: Raster, v: MapView): boolean {
  if (!r.ok) return false;
  const q = rasterRect(r, v);
  return q.x <= 0.5 && q.y <= 0.5 && q.x + q.w >= v.w - 0.5 && q.y + q.h >= v.h - 0.5;
}

export function blit(c: CanvasRenderingContext2D, r: Raster, v: MapView): void {
  if (!r.ok) return;
  const q = rasterRect(r, v);
  c.drawImage(r.cv, q.x, q.y, q.w, q.h);
}

/** The world's transform (m to device px), with round joins for outlines. */
export function worldTransform(c: CanvasRenderingContext2D, v: MapView): void {
  const s = v.scale;
  c.setTransform(-s, 0, 0, -s, v.w / 2 + v.cx * s, v.h / 2 + v.cz * s);
  c.lineCap = 'round';
  c.lineJoin = 'round';
}

/** A lit outline: its fill again (brighter), a soft wide stroke and a crisp one in its ink. */
export function lightPath(c: CanvasRenderingContext2D, path: Path2D, ink: string, fill: string | undefined, amt: number, px: number, filled: boolean): void {
  c.globalAlpha = amt;
  if (filled) {
    c.fillStyle = fill ?? ink;
    if (!fill) c.globalAlpha = amt * 0.3;
    c.fill(path);
    c.globalAlpha = amt;
  }
  c.strokeStyle = ink;
  c.lineWidth = (filled ? 7 : 10) * px;
  c.globalAlpha = amt * 0.22;
  c.stroke(path);
  c.globalAlpha = amt;
  c.lineWidth = (filled ? 2 : 4) * px;
  c.stroke(path);
  c.globalAlpha = 1;
}

/** The coordinate grid over the city: 200 m cells, 100 m lines between them once there is room. */
export function drawGrid(c: CanvasRenderingContext2D, v: MapView, g: Bounds, dpr: number): void {
  const x0 = g.maxX + MAP_PAD;
  const z0 = g.maxZ + MAP_PAD;
  const x1 = g.minX - MAP_PAD;
  const z1 = g.minZ - MAP_PAD;
  const cell = UI.grid * v.scale;
  const minor = cell >= UI.minorGrid * dpr;
  const step = minor ? UI.grid / 2 : UI.grid;
  const top = Math.max(0, mapY(v, z0));
  const bottom = Math.min(v.h, mapY(v, z1));
  const left = Math.max(0, mapX(v, x0));
  const right = Math.min(v.w, mapX(v, x1));
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.lineWidth = 1;
  for (let pass = 0; pass < (minor ? 2 : 1); pass++) {
    c.beginPath();
    for (let i = 0, x = x0; x >= x1 - 1e-6; i++, x = x0 - i * step) {
      if (minor && (i % 2 === 0) !== (pass === 0)) continue;
      const sx = Math.round(mapX(v, x)) + 0.5;
      if (sx < left - 1 || sx > right + 1) continue;
      c.moveTo(sx, top);
      c.lineTo(sx, bottom);
    }
    for (let i = 0, z = z0; z >= z1 - 1e-6; i++, z = z0 - i * step) {
      if (minor && (i % 2 === 0) !== (pass === 0)) continue;
      const sy = Math.round(mapY(v, z)) + 0.5;
      if (sy < top - 1 || sy > bottom + 1) continue;
      c.moveTo(left, sy);
      c.lineTo(right, sy);
    }
    c.strokeStyle = pass === 0 ? INK.grid : INK.gridMinor;
    c.stroke();
  }
}

/** The grid cell a point lies in ("C4"), or '' outside the grid. */
export function cellName(g: Bounds, x: number, z: number): string {
  const col = Math.floor((g.maxX + MAP_PAD - x) / UI.grid);
  const row = Math.floor((g.maxZ + MAP_PAD - z) / UI.grid);
  const cols = Math.ceil((g.maxX - g.minX + 2 * MAP_PAD) / UI.grid);
  const rows = Math.ceil((g.maxZ - g.minZ + 2 * MAP_PAD) / UI.grid);
  return col >= 0 && row >= 0 && col < cols && row < rows ? `${colName(col)}${row + 1}` : '';
}

/** The grid's column and row names along the top and left edges (over fading bands), and the scale bar. */
export function drawEdges(c: CanvasRenderingContext2D, v: MapView, g: Bounds, dpr: number, font: { grid: string; scale: string }, bands: { top: CanvasGradient; left: CanvasGradient } | null): void {
  c.setTransform(1, 0, 0, 1, 0, 0);
  if (bands) {
    c.fillStyle = bands.top;
    c.fillRect(0, 0, v.w, 24 * dpr);
    c.fillStyle = bands.left;
    c.fillRect(0, 0, 24 * dpr, v.h);
  }
  const x0 = g.maxX + MAP_PAD;
  const z0 = g.maxZ + MAP_PAD;
  const cols = Math.ceil((x0 - (g.minX - MAP_PAD)) / UI.grid);
  const rows = Math.ceil((z0 - (g.minZ - MAP_PAD)) / UI.grid);
  c.font = font.grid;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = INK.label;
  const edge = 22 * dpr;
  for (let i = 0; i < cols; i++) {
    const a = Math.max(edge, mapX(v, x0 - i * UI.grid));
    const b = Math.min(v.w - 4 * dpr, mapX(v, x0 - (i + 1) * UI.grid));
    if (b - a < 14 * dpr) continue;
    c.fillText(colName(i), (a + b) / 2, 11 * dpr);
  }
  for (let i = 0; i < rows; i++) {
    const a = Math.max(edge, mapY(v, z0 - i * UI.grid));
    const b = Math.min(v.h - 4 * dpr, mapY(v, z0 - (i + 1) * UI.grid));
    if (b - a < 14 * dpr) continue;
    c.fillText(String(i + 1), 11 * dpr, (a + b) / 2);
  }
  // Scale bar, bottom left: the longest step under 110 px, in two tones like a surveyor's bar.
  const cssScale = v.scale / dpr;
  let step: (typeof SCALE_STEPS)[number] = SCALE_STEPS[0];
  for (const s of SCALE_STEPS) if (s.m * cssScale <= 110) step = s;
  const len = step.m * v.scale;
  const m = 14 * dpr;
  const y = v.h - m;
  const label = step.label;
  c.font = font.scale;
  const tw = c.measureText(label).width;
  c.fillStyle = INK.plate;
  c.fillRect(m - 6 * dpr, y - 21 * dpr, Math.max(len, tw) + 12 * dpr, 27 * dpr);
  c.fillStyle = INK.scaleDark;
  c.fillRect(m, y - 4 * dpr, len, 4 * dpr);
  c.fillStyle = INK.scaleLight;
  c.fillRect(m, y - 4 * dpr, len / 2, 4 * dpr);
  c.fillRect(m, y - 7 * dpr, 1.5 * dpr, 7 * dpr);
  c.fillRect(m + len - 1.5 * dpr, y - 7 * dpr, 1.5 * dpr, 7 * dpr);
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillText(label, m, y - 10 * dpr);
}

/** Whether a canvas point (device px) lies off the view, past a small margin. */
export function offView(v: MapView, x: number, y: number, dpr: number): boolean {
  const m = 6 * dpr;
  return x < -m || y < -m || x > v.w + m || y > v.h + m;
}

/** An arrow just inside the map's edge, on the line from the center to a point off the view, pointing at it. */
export function drawEdgeArrow(c: CanvasRenderingContext2D, v: MapView, x: number, y: number, ink: string, dpr: number): void {
  const inset = 30 * dpr;
  const dx = x - v.w / 2;
  const dy = y - v.h / 2;
  const t = Math.min((v.w / 2 - inset) / Math.max(1e-6, Math.abs(dx)), (v.h / 2 - inset) / Math.max(1e-6, Math.abs(dy)));
  const a = Math.atan2(dy, dx);
  const cs = Math.cos(a) * dpr;
  const sn = Math.sin(a) * dpr;
  c.setTransform(cs, sn, -sn, cs, v.w / 2 + dx * t, v.h / 2 + dy * t);
  c.beginPath();
  c.moveTo(10, 0);
  c.lineTo(-6, 7.5);
  c.lineTo(-2.5, 0);
  c.lineTo(-6, -7.5);
  c.closePath();
  c.lineJoin = 'round';
  c.strokeStyle = INK.outline;
  c.lineWidth = 3;
  c.stroke();
  c.fillStyle = ink;
  c.fill();
  c.setTransform(1, 0, 0, 1, 0, 0);
}

/** The reveal's edge: a ring running out from the player as the map boots. */
export function drawRevealRing(c: CanvasRenderingContext2D, x: number, y: number, r: number, u: number, dpr: number): void {
  if (r <= 0) return;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.strokeStyle = INK.ping;
  c.globalAlpha = 0.18 * (1 - u);
  c.lineWidth = 14 * dpr;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.stroke();
  c.globalAlpha = 0.85 * (1 - u);
  c.lineWidth = 2 * dpr;
  c.stroke();
  c.globalAlpha = 1;
}

/** How the player's marker is drawn this frame. */
export interface PlayerMarker {
  /** Heading (rad, sim yaw). */
  yaw: number;
  dpr: number;
  /** Map time (s), for the pings. */
  time: number;
  /** How lit it is by the legend's You row (0..1). */
  lit: number;
  reduced: boolean;
  /** The YOU label's canvas font. */
  font: string;
}

/** The player: a white heading arrow over two orange pings a beat apart (the menu maps' car marker). */
export function drawPlayer(c: CanvasRenderingContext2D, x: number, y: number, p: PlayerMarker): void {
  const { dpr, lit } = p;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.strokeStyle = INK.ping;
  c.lineWidth = 2 * dpr;
  if (p.reduced) {
    c.globalAlpha = 0.6;
    c.beginPath();
    c.arc(x, y, 15 * dpr, 0, Math.PI * 2);
    c.stroke();
  } else
    for (const off of PINGS) {
      const q = ((p.time + off) % UI.ping) / UI.ping;
      const e = 1 - (1 - q) ** 2.2;
      c.globalAlpha = 1 - e;
      c.beginPath();
      c.arc(x, y, 13 * (0.15 + 1.35 * e) * (1 + 0.5 * lit) * dpr, 0, Math.PI * 2);
      c.stroke();
    }
  c.globalAlpha = 1;
  // The arrow, turned to the heading: polygon(50% 0, 100% 100%, 50% 72%, 0 100%) on 12 x 15 px, a little larger here.
  const a = mapHeading(p.yaw);
  const k = dpr * (1.25 + 0.25 * lit);
  const cs = Math.cos(a) * k;
  const sn = Math.sin(a) * k;
  c.setTransform(cs, sn, -sn, cs, x, y);
  c.beginPath();
  c.moveTo(0, -7.5);
  c.lineTo(6, 7.5);
  c.lineTo(0, 3.3);
  c.lineTo(-6, 7.5);
  c.closePath();
  c.lineJoin = 'round';
  c.strokeStyle = INK.outline;
  c.lineWidth = 2.6;
  c.stroke();
  c.fillStyle = INK.player;
  c.fill();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.font = p.font;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.strokeStyle = INK.outline;
  c.lineWidth = 3 * dpr;
  c.strokeText('YOU', x, y + 22 * dpr);
  c.fillStyle = INK.player;
  c.fillText('YOU', x, y + 22 * dpr);
}

/** A map pin: a round head over a point at (x, tip), traced for filling and stroking. */
function pinPath(c: CanvasRenderingContext2D, x: number, tip: number, head: number, r: number): void {
  // The tangents from the tip to the head's circle meet it at pi/2 +- acos(r / head) from straight down.
  const a = Math.acos(r / head);
  c.beginPath();
  c.moveTo(x, tip);
  c.arc(x, tip - head, r, Math.PI / 2 + a, Math.PI / 2 - a + Math.PI * 2);
  c.closePath();
}

/** The sprites drawn once per pixel ratio. */
export interface Sprites {
  dpr: number;
  start: HTMLCanvasElement;
  finish: HTMLCanvasElement | null;
  pin: HTMLCanvasElement;
}

/**
 * The start and finish discs (the menu course map's flag in a disc, in the
 * course's ink; a sprint starts under a pennant) and the waypoint pin.
 */
export function makeSprites(dpr: number, ink: string, sprint: boolean, finish: boolean): Sprites {
  const disc = (ico: IconNode): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    const r = 8.5 * dpr;
    cv.width = cv.height = Math.ceil(2 * r + 4 * dpr);
    const c = cv.getContext('2d')!;
    const m = cv.width / 2;
    c.fillStyle = PALETTE.bg0;
    c.strokeStyle = ink;
    c.lineWidth = 2 * dpr;
    c.beginPath();
    c.arc(m, m, r, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    drawIcon(c, ico, m - 5.5 * dpr, m - 5.5 * dpr, 11 * dpr, ink, 2.6);
    return cv;
  };
  const pin = document.createElement('canvas');
  pin.width = Math.ceil(PIN.w * dpr);
  pin.height = Math.ceil(PIN.h * dpr);
  const c = pin.getContext('2d')!;
  c.scale(dpr, dpr);
  pinPath(c, PIN.w / 2, PIN.tip, PIN.head, PIN.r);
  c.fillStyle = INK.pin;
  c.strokeStyle = INK.outline;
  c.lineWidth = 2;
  c.lineJoin = 'round';
  c.stroke();
  c.fill();
  c.fillStyle = INK.outline;
  c.beginPath();
  c.arc(PIN.w / 2, PIN.tip - PIN.head, 2.8, 0, Math.PI * 2);
  c.fill();
  return { dpr, start: disc(sprint ? FlagTriangleRight : Flag), finish: finish ? disc(Flag) : null, pin };
}
