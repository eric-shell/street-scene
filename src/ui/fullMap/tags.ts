/**
 * The full map's name tags: one per notable place (the minor ones join once
 * zoomed in), laid out again every frame. Bigger places go first, each
 * dropped where it would cover one already placed or a rectangle reserved
 * for the markers and the map's furniture, so zooming in (the places spread
 * out) fits more of them; tags fade in and out as they fit or not.
 */
import type { Area, AreaKind } from '../../city/districts/types';
import type { World } from '../../city/world';
import { KINDS, MAP_INK, mapX, mapY, shownOnMap, tagAnchor, tagWeight, type MapView } from '../cityMap';
import { placeName } from '../places';
import { UI, inkOf, isMinor, isShortcut, type LegendKey } from './tuning';

/** A place's name tag. */
interface Tag {
  area: Area;
  text: string;
  ink: string;
  /** Anchor (world m). */
  x: number;
  z: number;
  minor: boolean;
  /** Text width at the tag's font (device px; 0 until measured). */
  w: number;
  /** Shown amount (fades in and out as it fits or not) and where it was last drawn (device px). */
  alpha: number;
  sx: number;
  sy: number;
}

/** What a frame of tags depends on besides the view. */
export interface TagFrame {
  dpr: number;
  /** Zoom in multiples of the fitted city. */
  zoom: number;
  /** Canvas fonts at the pixel ratio. */
  font: { tag: string; minor: string };
  /** Kinds hidden in the legend, and whether the race shortcuts show. */
  hidden: ReadonlySet<AreaKind>;
  shortcuts: boolean;
  /** The legend row lit, and how much (0..1): the other tags dim. */
  lit: LegendKey | null;
  litAmt: number;
  /** This frame's step toward a tag's goal (0..1, 1 with reduced motion). */
  fade: number;
}

export class NameTags {
  private readonly tags: Tag[] = [];
  /** Placed rectangles this frame (x0, y0, x1, y1 in device px), tags and what they keep clear of. */
  private readonly placed: Float32Array;
  private placedN = 0;

  constructor(world: World) {
    const major = world.areas.filter((a) => KINDS[a.kind]?.tag && shownOnMap(a)).sort((a, b) => tagWeight(b) - tagWeight(a));
    const minor = world.areas.filter((a) => isMinor(a) && !KINDS[a.kind]?.tag).sort((a, b) => tagWeight(b) - tagWeight(a));
    for (const [list, small] of [
      [major, false],
      [minor, true],
    ] as const) {
      for (const a of list) {
        const p = tagAnchor(world, a);
        if (p) this.tags.push({ area: a, text: isShortcut(a) ? 'Shortcut' : placeName(a), ink: inkOf(a), x: p.x, z: p.z, minor: small, w: 0, alpha: 0, sx: 0, sy: 0 });
      }
    }
    this.placed = new Float32Array(4 * (this.tags.length + 12));
  }

  /** The fonts changed (a new pixel ratio): measure every tag again. */
  remeasure(): void {
    for (const t of this.tags) t.w = 0;
  }

  /** Start a frame's layout: nothing placed yet. */
  clear(): void {
    this.placedN = 0;
  }

  /** Keep a rectangle (device px) clear of tags this frame. */
  reserve(x0: number, y0: number, x1: number, y1: number): void {
    const P = this.placed;
    P[this.placedN++] = x0;
    P[this.placedN++] = y0;
    P[this.placedN++] = x1;
    P[this.placedN++] = y1;
  }

  private free(x0: number, y0: number, x1: number, y1: number, pad: number): boolean {
    const P = this.placed;
    for (let i = 0; i < this.placedN; i += 4) if (x0 < P[i + 2] + pad && x1 > P[i] - pad && y0 < P[i + 3] + pad && y1 > P[i + 1] - pad) return false;
    return true;
  }

  /** Lay out and draw the tags, after the frame's reservations. */
  draw(c: CanvasRenderingContext2D, v: MapView, f: TagFrame): void {
    const { dpr, lit } = f;
    const H = 18 * dpr;
    const hm = 15 * dpr;
    for (const t of this.tags) {
      let goal = 0;
      const font = t.minor ? f.font.minor : f.font.tag;
      if ((!t.minor || f.zoom >= UI.minorZoom) && !f.hidden.has(t.area.kind) && !(isShortcut(t.area) && !f.shortcuts)) {
        if (!t.w) {
          c.font = font;
          t.w = c.measureText(t.text).width;
        }
        const sx = mapX(v, t.x);
        const sy = mapY(v, t.z);
        const w = t.w + 12 * dpr;
        const th = t.minor ? hm : H;
        const x0 = sx - w / 2;
        const y0 = sy - th / 2;
        if (x0 > 24 * dpr && y0 > 24 * dpr && x0 + w < v.w - 4 * dpr && y0 + th < v.h - 4 * dpr && this.free(x0, y0, x0 + w, y0 + th, 3 * dpr)) {
          this.reserve(x0, y0, x0 + w, y0 + th);
          goal = 1;
          t.sx = sx;
          t.sy = sy;
        }
      }
      t.alpha = Math.abs(goal - t.alpha) < 0.01 ? goal : t.alpha + (goal - t.alpha) * f.fade;
      if (t.alpha < 0.01) continue;
      if (goal === 0) {
        // Fading out where it was, following the view.
        t.sx = mapX(v, t.x);
        t.sy = mapY(v, t.z);
      }
      const dim = lit && lit !== 'you' && lit !== 'route' && lit !== 'waypoint' ? (t.area.kind === lit || (lit === 'shortcut' && isShortcut(t.area)) ? 1 : 1 - 0.75 * f.litAmt) : lit ? 1 - 0.6 * f.litAmt : 1;
      drawTag(c, t, font, dim * t.alpha, dpr);
    }
  }
}

/** One tag: a chamfered dark plate with a hairline and the name in the place's ink. */
function drawTag(c: CanvasRenderingContext2D, t: Tag, font: string, alpha: number, dpr: number): void {
  const w = t.w + 12 * dpr;
  const hgt = (t.minor ? 15 : 18) * dpr;
  const x0 = t.sx - w / 2;
  const y0 = t.sy - hgt / 2;
  const cut = 4 * dpr;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = alpha;
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x0 + w - cut, y0);
  c.lineTo(x0 + w, y0 + cut);
  c.lineTo(x0 + w, y0 + hgt);
  c.lineTo(x0 + cut, y0 + hgt);
  c.lineTo(x0, y0 + hgt - cut);
  c.closePath();
  c.fillStyle = MAP_INK.tagBg;
  c.fill();
  c.strokeStyle = t.ink;
  c.lineWidth = dpr;
  if (t.minor) c.globalAlpha = alpha * 0.55;
  c.stroke();
  c.globalAlpha = alpha * (t.minor ? 0.9 : 1);
  c.font = font;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = t.ink;
  c.fillText(t.text, t.sx, t.sy + 0.5 * dpr);
  c.globalAlpha = 1;
}
