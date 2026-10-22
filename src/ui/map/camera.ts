/**
 * The full map's camera: where the map looks (a MapView in device px) and
 * how it eases there from wheels, keys, drags, pinches, flings and fly-tos,
 * kept so the city never leaves the view.
 */
import type { World } from '../../city/world';
import type { Vec2 } from '../../sim/math';
import { MAP_PAD, fitCity, mapToWorld, type MapView } from './cityMap';
import { UI, easeInOut, lerp } from './tuning';

const TMP: Vec2 = { x: 0, z: 0 };


/** A view: the world point at the canvas center (m) and device px per meter. */
export interface Pose {
  cx: number;
  cz: number;
  scale: number;
}

/**
 * Where the map looks, easing toward where it was sent. Wheel and key zooms
 * ease the scale (in log space) about an anchor that stays under the pointer;
 * key pans, flings and spring backs ease the center; a drag or a pinch moves
 * the view directly (a drag stretches past the city's edge and springs back);
 * a fly-to is a timed ease that pulls back on long trips. The center is kept
 * so the city never leaves the view; an axis the whole city fits along stays
 * centered, so at 1x nothing pans.
 */
export class MapCamera {
  /** The current view (device px). */
  readonly view: MapView = { cx: 0, cz: 0, scale: 1, w: 0, h: 0 };
  /** The fitted city (1x) at this canvas size. */
  readonly fit: Pose = { cx: 0, cz: 0, scale: 1 };
  private readonly goal: Pose = { cx: 0, cz: 0, scale: 1 };
  private readonly anchor = { on: false, sx: 0, sy: 0, wx: 0, wz: 0 };
  private fly: { from: Pose; to: Pose; t: number; dur: number; bump: number } | null = null;
  /** Dragging: the unstretched center the pointer has pulled the view to. */
  private readonly drag = { on: false, cx: 0, cz: 0 };
  /** Pinching: the world point under the fingers' midpoint and the scale it started at. */
  private readonly pinch = { on: false, wx: 0, wz: 0, s0: 1 };
  private rate: number = UI.panRate;
  private readonly tmp: Pose = { cx: 0, cz: 0, scale: 1 };
  /** The city's bounds plus the map's margin (m). */
  private readonly b: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(private readonly world: World) {
    const g = world.graph.bounds;
    this.b = { minX: g.minX - MAP_PAD, maxX: g.maxX + MAP_PAD, minZ: g.minZ - MAP_PAD, maxZ: g.maxZ + MAP_PAD };
  }

  get zoom(): number {
    return this.view.scale / this.fit.scale;
  }
  get goalZoom(): number {
    return this.goal.scale / this.fit.scale;
  }
  /** A pointer holds the view (drag or pinch). */
  get held(): boolean {
    return this.drag.on || this.pinch.on;
  }

  /** A new canvas size: keep the zoom and the center, refit the 1x scale. */
  resize(w: number, h: number): void {
    const v = this.view;
    const first = !v.w;
    const zoom = first ? 1 : this.zoom;
    const goalZoom = first ? 1 : this.goalZoom;
    const f = fitCity(this.world, w, h);
    this.fit.cx = f.cx;
    this.fit.cz = f.cz;
    this.fit.scale = f.scale;
    v.w = w;
    v.h = h;
    if (first) {
      v.cx = this.goal.cx = f.cx;
      v.cz = this.goal.cz = f.cz;
    }
    v.scale = f.scale * zoom;
    this.goal.scale = f.scale * goalZoom;
    this.anchor.on = false;
    this.fly = null;
    this.clamp(v.scale, v);
    this.clamp(this.goal.scale, this.goal);
  }

  /** Keep a center for a scale so the city never leaves the view. */
  clamp(scale: number, p: { cx: number; cz: number }): void {
    const { b, view } = this;
    const hw = view.w / 2 / scale;
    const hh = view.h / 2 / scale;
    p.cx = b.maxX - b.minX <= 2 * hw + 1e-6 ? (b.minX + b.maxX) / 2 : Math.max(b.minX + hw, Math.min(b.maxX - hw, p.cx));
    p.cz = b.maxZ - b.minZ <= 2 * hh + 1e-6 ? (b.minZ + b.maxZ) / 2 : Math.max(b.minZ + hh, Math.min(b.maxZ - hh, p.cz));
  }

  private clampScale(s: number): number {
    return Math.max(this.fit.scale, Math.min(this.fit.scale * UI.maxZoom, s));
  }

  /** Zoom by f about canvas point (sx, sy), eased: the world point under it stays there. */
  zoomAt(f: number, sx: number, sy: number): void {
    this.fly = null;
    const s = this.clampScale(this.goal.scale * f);
    const w = mapToWorld(this.view, sx, sy, TMP);
    Object.assign(this.anchor, { on: true, sx, sy, wx: w.x, wz: w.z });
    this.goal.scale = s;
    this.goal.cx = w.x + (sx - this.view.w / 2) / s;
    this.goal.cz = w.z + (sy - this.view.h / 2) / s;
    this.clamp(s, this.goal);
  }

  /** Move the content by (dx, dy) device px, eased (the arrow keys). */
  nudge(dx: number, dy: number): void {
    this.fly = null;
    this.anchor.on = false;
    this.rate = UI.panRate;
    this.goal.cx += dx / this.goal.scale;
    this.goal.cz += dy / this.goal.scale;
    this.clamp(this.goal.scale, this.goal);
  }

  /** Ease the center toward a moving point (find me while the menu's car drives). */
  follow(x: number, z: number): void {
    if (this.fly || this.held) return;
    this.anchor.on = false;
    this.rate = UI.panRate;
    this.goal.cx = x;
    this.goal.cz = z;
    this.clamp(this.goal.scale, this.goal);
  }

  /** Fly to a center and scale: a timed ease that pulls back on a long trip (instant with reduced motion). */
  flyTo(cx: number, cz: number, scale: number, instant: boolean): void {
    const to: Pose = { cx, cz, scale: this.clampScale(scale) };
    this.clamp(to.scale, to);
    this.anchor.on = this.drag.on = this.pinch.on = false;
    Object.assign(this.goal, to);
    const v = this.view;
    if (instant) {
      Object.assign(v, to);
      this.fly = null;
      return;
    }
    // Trip length in view widths at the nearer of the two zooms.
    const trip = (Math.hypot(to.cx - v.cx, to.cz - v.cz) * Math.min(v.scale, to.scale)) / Math.max(v.w, v.h);
    this.fly = { from: { cx: v.cx, cz: v.cz, scale: v.scale }, to, t: 0, dur: UI.flyTime + UI.flyExtra * Math.min(1, trip), bump: Math.min(UI.bump, trip * 0.7) };
  }

  /** Halt any ease or flight where the view is (a stretched view still springs back); true if it was on its way. */
  stop(): boolean {
    const v = this.view;
    const g = this.goal;
    const was = !!this.fly || this.anchor.on || Math.abs(g.cx - v.cx) * v.scale > 0.5 || Math.abs(g.cz - v.cz) * v.scale > 0.5 || Math.abs(g.scale / v.scale - 1) > 1e-3;
    this.fly = null;
    this.anchor.on = false;
    g.cx = v.cx;
    g.cz = v.cz;
    g.scale = v.scale;
    this.clamp(v.scale, g);
    return was;
  }

  beginDrag(): void {
    this.fly = null;
    this.anchor.on = this.pinch.on = false;
    Object.assign(this.drag, { on: true, cx: this.view.cx, cz: this.view.cz });
    this.goal.scale = this.view.scale;
  }

  /** Drag the content by (dx, dy) device px; past the edge it stretches. */
  dragBy(dx: number, dy: number): void {
    const d = this.drag;
    if (!d.on) return;
    const v = this.view;
    d.cx += dx / v.scale;
    d.cz += dy / v.scale;
    const t = this.tmp;
    t.cx = d.cx;
    t.cz = d.cz;
    this.clamp(v.scale, t);
    v.cx = this.goal.cx = t.cx + (d.cx - t.cx) * UI.rubber;
    v.cz = this.goal.cz = t.cz + (d.cz - t.cz) * UI.rubber;
  }

  /** Let go at (vx, vy) device px/s: a fling glides on (an ease from the release speed covers speed / rate); a stretch springs back. */
  endDrag(vx: number, vy: number, glide: boolean): void {
    if (!this.drag.on) return;
    this.drag.on = false;
    const v = this.view;
    this.rate = glide ? UI.flingRate : UI.panRate;
    this.goal.cx = v.cx + (glide ? vx / UI.flingRate / v.scale : 0);
    this.goal.cz = v.cz + (glide ? vy / UI.flingRate / v.scale : 0);
    this.goal.scale = v.scale;
    this.clamp(v.scale, this.goal);
  }

  beginPinch(mx: number, my: number): void {
    this.fly = null;
    this.anchor.on = this.drag.on = false;
    const w = mapToWorld(this.view, mx, my, TMP);
    Object.assign(this.pinch, { on: true, wx: w.x, wz: w.z, s0: this.view.scale });
  }

  /** Two fingers at midpoint (mx, my), spread `ratio` times their first distance. */
  pinchTo(mx: number, my: number, ratio: number): void {
    if (!this.pinch.on) return;
    const v = this.view;
    v.scale = this.clampScale(this.pinch.s0 * ratio);
    v.cx = this.pinch.wx + (mx - v.w / 2) / v.scale;
    v.cz = this.pinch.wz + (my - v.h / 2) / v.scale;
    this.clamp(v.scale, v);
    Object.assign(this.goal, { cx: v.cx, cz: v.cz, scale: v.scale });
  }

  endPinch(): void {
    this.pinch.on = false;
  }

  /** Advance the eases by dt (s); `instant` settles at once. True if the view moved. */
  step(dt: number, instant: boolean): boolean {
    const v = this.view;
    const cx = v.cx;
    const cz = v.cz;
    const s = v.scale;
    const f = this.fly;
    if (f) {
      f.t += dt;
      const u = instant ? 1 : Math.min(1, f.t / f.dur);
      const e = easeInOut(u);
      v.scale = Math.max(this.fit.scale, Math.exp(lerp(Math.log(f.from.scale), Math.log(f.to.scale), e) - f.bump * Math.sin(Math.PI * u)));
      v.cx = lerp(f.from.cx, f.to.cx, e);
      v.cz = lerp(f.from.cz, f.to.cz, e);
      this.clamp(v.scale, v);
      if (u >= 1) {
        Object.assign(v, f.to);
        this.fly = null;
      }
    } else if (!this.held) {
      const g = this.goal;
      const ls = Math.log(v.scale);
      const lg = Math.log(g.scale);
      v.scale = instant || Math.abs(lg - ls) < 2e-4 ? g.scale : Math.exp(ls + (lg - ls) * (1 - Math.exp(-UI.zoomRate * dt)));
      if (this.anchor.on) {
        const a = this.anchor;
        v.cx = a.wx + (a.sx - v.w / 2) / v.scale;
        v.cz = a.wz + (a.sy - v.h / 2) / v.scale;
        this.clamp(v.scale, v);
        if (v.scale === g.scale) {
          this.anchor.on = false;
          v.cx = g.cx;
          v.cz = g.cz;
        }
      } else {
        // Unclamped on the way, so a stretched drag springs back; the goal is inside.
        const k = instant ? 1 : 1 - Math.exp(-this.rate * dt);
        const eps = 0.1 / v.scale;
        v.cx = Math.abs(g.cx - v.cx) < eps ? g.cx : v.cx + (g.cx - v.cx) * k;
        v.cz = Math.abs(g.cz - v.cz) < eps ? g.cz : v.cz + (g.cz - v.cz) * k;
      }
    }
    return v.cx !== cx || v.cz !== cz || v.scale !== s;
  }
}
