/**
 * Full city map: a modal over the paused free roam session (Tab, or a click on
 * the HUD minimap) or over the live menu city. A map to explore rather than a
 * picture: the wheel, a drag, a pinch, a double click and the keys pan and
 * zoom it (1x fits the whole city, up to 8x), the place under the pointer
 * lights up with a card naming it (how far and which way from you, drift zone,
 * shortcut), the legend lights a kind of place up or hides it, the Places tab
 * lists the notable places by distance and flies to them, and in free roam a
 * click drops a waypoint the HUD then points to (the chip and the minimap).
 *
 * Drawing. The city itself (the cityMap.ts layers, the same inks as every
 * other map) is rasterized into two cached bitmaps: the fitted whole city, and
 * the current view with a margin. A moving view blits them scaled; the view's
 * bitmap is redrawn when the view settles, or while it moves once it no longer
 * covers the view or has drifted too far in zoom (at most every rasterGap s),
 * so a drag or a zoom never redraws the city per frame. Each frame the visible
 * canvas gets the blits, the grid, highlights, the route with dashes marching
 * in its driving direction, name tags (laid out per frame, more of them as you
 * zoom in), the start line, the waypoint pin, the player's arrow with its ping,
 * the grid's edge labels and the scale bar: a few hundred canvas calls, well
 * under a millisecond. The loop runs only while the map is open, and only
 * draws when something changed or moves (decoration alone redraws at 60 Hz at
 * most). Reduced motion: no reveal, marching, pings, drops or glides, and view
 * changes are instant.
 *
 * Orientation matches the minimap and the drone: north (+Z) is up, world +X on
 * the left, as the city looks from above. Render only: the waypoint lives on
 * whoever opened the map (RaceSession keeps it), never in RaceState.
 *
 * API: `new FullMap(world, player, opts)` builds it (opts: FullMapOptions);
 * append `root`, then call `draw()` once it is in the document (it sizes
 * itself to its box, from then on through a ResizeObserver, and starts the
 * loop); `dispose()` stops it and removes it (after a short fade). While open
 * it takes the keys it uses and swallows the others (music and dev keys pass),
 * so nothing drives, pauses or navigates behind it; Tab and Escape call
 * onClose, as do its close button and a click on the backdrop.
 */
import type { World } from '../city/world';
import type { Area, AreaKind } from '../city/districts/types';
import { polygonBounds } from '../city/districts/geom';
import { routeSample, type Route as RaceRoute, type RouteSample } from '../city/route';
import { driftZones } from '../sim/driftZones';
import type { Vec2 } from '../sim/math';
import { CityLayers, KINDS, MAP_INK, MAP_PAD, fitCity, layersOf, mapHeading, mapToWorld, mapX, mapY, nearestOnArea, shownOnMap, tagAnchor, tagWeight, type CityDrawOptions, type MapView } from './cityMap';
import { btn, h, iconBtn } from './dom';
import { Disc3, Eye, EyeOff, Flag, FlagTriangleRight, Hash, Landmark, Layers, LocateFixed, MapIcon, MapPin, MapPinOff, MapPinned, Maximize2, Navigation, Navigation2, Route, X, ZoomIn, ZoomOut, drawIcon, icon, type IconNode } from './icons';
import type { MapCar } from './minimap';
import { PALETTE, rgba, type PaletteColor } from './palette';
import { CITY_NAME, bearingDeg, compassPoint, distanceLabel, placeName } from './places';
import { M_PER_FT, M_PER_MI } from './units';

/** Where a waypoint is kept: by whoever owns the map's city (main.ts keeps one per event city, so one set on the menu carries into free roam). */
export interface WaypointStore {
  get(): Vec2 | null;
  set(p: Vec2 | null): void;
}

export interface FullMapOptions {
  /** Close request: the close button, the backdrop, Tab or Escape. The owner then calls dispose(). */
  onClose(): void;
  /** The player's pose now, read every frame (the menu's cruising car); without it the marker stays where `player` put it. */
  livePlayer?: () => MapCar;
  /**
   * Where the waypoint is kept: a click on the map or a place's pin button
   * sets it, a click on the pin or Clear removes it. Free roam and the menu
   * share one per event city; without it the map sets none.
   */
  waypoint?: WaypointStore;
  /** Header chips: the event's name and the seed. */
  event?: string;
  seed?: string;
  /**
   * The course to draw: a route in its race type's color under that type's
   * name, with the drift zones lit for drift (the menu's race step), or none
   * (free roam picked on the menu: the whole city is the course). Without it
   * the world's own route shows in orange, as free roam shows it to find your
   * way.
   */
  course?: { route: RaceRoute | null; ink: PaletteColor; label: string; zones?: boolean };
}

/** Motion, interaction and drawing tuning. Lengths in CSS px, times in s, rates in 1/s. */
const UI = {
  /** Deepest zoom, in multiples of the fitted city. */
  maxZoom: 8,
  /** Ease rates: the scale toward a wheel or key zoom, the center toward a key pan or a spring back, a fling's glide. */
  zoomRate: 14,
  panRate: 12,
  flingRate: 4.5,
  /** A fly-to (find me, fit, a place) lasts flyTime, plus up to flyExtra on a long trip, pulling back up to bump (log zoom). */
  flyTime: 0.55,
  flyExtra: 0.4,
  bump: 0.8,
  /** Wheel zoom per pixel of scroll; a trackpad pinch (ctrl + wheel) reports much smaller steps. */
  wheel: 0.0022,
  pinchWheel: 0.012,
  /** Zoom step of the buttons and the + and - keys, and of a double click. */
  step: 1.6,
  dblStep: 2,
  /** Find me zooms in to at least this; a place is framed between these zooms. */
  findZoom: 3,
  placeMin: 1.4,
  placeMax: 5,
  /** Key pan speed. */
  keyPan: 760,
  /** A press that travels this far is a drag, not a click (a finger gets more room). */
  dragSlop: 5,
  touchSlop: 10,
  /** Two clicks this close in time and space are a double click. */
  dblTime: 0.26,
  dblDist: 22,
  /** A drag released faster than this flings on; past the city's edge a drag moves the view this share of the way. */
  minFling: 160,
  rubber: 0.3,
  /** The open: the panel lands, then the map is revealed outwards from the player. */
  revealDelay: 0.14,
  revealTime: 0.7,
  /** Route dashes: their march speed and pattern. */
  march: 16,
  dash: 3,
  gap: 11,
  /** The player's two pings, a beat apart (the menu maps' map-ping). */
  ping: 2.4,
  /** The waypoint pin drops in, then a ripple spreads from it; a place picked from the list pulses. */
  drop: 0.45,
  ripple: 0.6,
  pulse: 1.8,
  /** Hit radii: the waypoint pin's head, the start and finish discs. */
  pinHit: 15,
  markHit: 12,
  /** The view's bitmap margin (share of the canvas), the least time between redraws while moving, the zoom it may drift. */
  margin: 0.15,
  rasterGap: 0.09,
  rasterDrift: 1.3,
  /** Highlight and tag fades. */
  fade: 12,
  tagFade: 10,
  /** Minor places (roundabouts, lots, shortcuts...) get tags from this zoom. */
  minorZoom: 2.4,
  /** The grid's cell (m), labelled A, B, C... across and 1, 2, 3... down; 100 m lines show in between from minorGrid px per cell. */
  grid: 200,
  minorGrid: 64,
  /** How often live readouts (where you are, distances) refresh. */
  live: 0.5,
  /** Decoration alone (dashes, pings) redraws at most this often. */
  idleHz: 60,
} as const;

/** Inks of the overlays (the city's own are MAP_INK and KINDS in cityMap.ts). */
const INK = {
  veil: PALETTE.bg0,
  grid: 'rgba(252, 252, 250, 0.075)',
  gridMinor: 'rgba(252, 252, 250, 0.035)',
  band: 'rgba(25, 24, 26, 0.82)',
  label: PALETTE.muted,
  routeDash: 'rgba(255, 238, 220, 0.95)',
  ping: PALETTE.orange,
  pin: PALETTE.yellow,
  outline: PALETTE.bg0,
  player: PALETTE.text,
  plate: rgba('bg0', 0.8),
  scaleLight: PALETTE.soft,
  scaleDark: PALETTE.bg3,
  font: MAP_INK.font,
} as const;

/** Legend order; kinds missing from the city are left out. */
const LEGEND_ORDER: AreaKind[] = ['park', 'river', 'lake', 'waterfront', 'subway', 'alley', 'backAlley', 'roundabout', 'hills', 'monument', 'tunnel', 'overpass', 'carPark', 'market', 'infill', 'roadworks', 'bluff'];

/** What a legend row stands for: a district kind, or one of the map's own layers. */
type LegendKey = AreaKind | 'you' | 'route' | 'shortcut' | 'waypoint';

const isShortcut = (a: Area) => a.kind === 'backAlley' && a.variant === 'routeShortcut';
/** Small places tagged only once zoomed in. */
const isMinor = (a: Area) => a.kind === 'roundabout' || a.kind === 'overpass' || a.kind === 'roadworks' || isShortcut(a) || (a.kind === 'infill' && shownOnMap(a));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** A drop that lands, bounces once and settles. */
const bounceOut = (t: number) => (t < 0.62 ? (t / 0.62) ** 2 : 1 - 0.22 * Math.sin(((t - 0.62) / 0.38) * Math.PI) * (1 - (t - 0.62) / 0.38));

/** A kind's legend label as a note under a place's name, unless it only says the name again ("Park" is in "Parks"). */
function kindNote(name: string, label: string): string {
  const n = name.toLowerCase();
  const l = label.toLowerCase();
  return label && !l.startsWith(n) && !n.startsWith(l) ? label : '';
}

/** Grid column name: A..Z, then AA, AB... */
const colName = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26)));

/** Append a closed polygon or an open polyline (world m) to a path. */
function trace(p: Path2D, pts: readonly Vec2[], closed: boolean): void {
  for (let i = 0; i < pts.length; i++) (i ? p.lineTo(pts[i].x, pts[i].z) : p.moveTo(pts[i].x, pts[i].z));
  if (closed) p.closePath();
}

const TMP: Vec2 = { x: 0, z: 0 };

/** A view: the world point at the canvas center (m) and device px per meter. */
interface Pose {
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
class MapCamera {
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

/** A cached bitmap of the city drawn through one view. */
interface Raster {
  readonly cv: HTMLCanvasElement;
  readonly c: CanvasRenderingContext2D;
  readonly view: MapView;
  ok: boolean;
  /** Map time it was drawn at (s). */
  at: number;
}

function newRaster(): Raster {
  const cv = document.createElement('canvas');
  return { cv, c: cv.getContext('2d', { alpha: false })!, view: { cx: 0, cz: 0, scale: 1, w: 1, h: 1 }, ok: false, at: -1 };
}

/** A place's name tag, laid out again every frame. */
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

/** A row of the Places tab. */
interface PlaceRow {
  area: Area;
  /** Where a waypoint set from the list goes, and where the map flies (the area's middle). */
  at: Vec2;
  /** The area's bounds (m), framed by a fly-to. */
  span: { minX: number; maxX: number; minZ: number; maxZ: number };
  li: HTMLLIElement;
  far: HTMLElement;
  d: number;
}

/** What the pointer is over. */
type Hover = { kind: 'area'; area: Area | null } | { kind: 'me' } | { kind: 'pin' } | { kind: 'mark'; finish: boolean };

/**
 * Open the city map over `parent`: the one way every screen opens it (free
 * roam's minimap and Tab, the menu's event card and its race step's course
 * map), so it looks and works the same everywhere and an enrichment lands in
 * all of them at once. The caller disposes it when onClose fires.
 */
export function openFullMap(parent: HTMLElement, world: World, player: MapCar, opts: FullMapOptions): FullMap {
  const map = new FullMap(world, player, opts);
  parent.append(map.root);
  map.draw();
  return map;
}

export class FullMap {
  readonly root: HTMLDivElement;
  private readonly layers: CityLayers;
  private readonly cam: MapCamera;
  private readonly reduced: boolean;
  private readonly me: MapCar;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stage: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly hereEl: HTMLElement;
  private readonly zoomEl: HTMLElement;
  private readonly zoomInBtn: HTMLButtonElement;
  private readonly zoomOutBtn: HTMLButtonElement;
  private readonly findBtn: HTMLButtonElement;
  private readonly rose: HTMLElement;
  private readonly tools: HTMLElement;
  private readonly ro: ResizeObserver;
  private readonly focusBack: Element | null;
  // Tooltip card.
  private readonly tip: HTMLDivElement;
  private readonly tipName: HTMLElement;
  private readonly tipCell: HTMLElement;
  private readonly tipKind: HTMLElement;
  private readonly tipFar: HTMLElement;
  private readonly tipArrow: HTMLElement;
  private readonly tipDrift: HTMLElement;
  private readonly tipShort: HTMLElement;
  private readonly tipHere: HTMLElement;
  private readonly tipAct: HTMLElement;
  private readonly tipBtn: HTMLButtonElement;
  private tipKey = '';
  private tipW = 0;
  private tipH = 0;
  /** A tap's card stays put (touch); it can set the waypoint from its button. */
  private pinned: { x: number; y: number; wx: number; wz: number; hover: Hover } | null = null;
  // Side panel.
  private readonly legendTab: HTMLButtonElement;
  private readonly placesTab: HTMLButtonElement;
  private readonly legendPane: HTMLElement;
  private readonly placesPane: HTMLElement;
  private readonly placesList: HTMLUListElement;
  private readonly rows = new Map<LegendKey, HTMLLIElement>();
  private readonly wpCard: HTMLElement;
  private readonly wpFar: HTMLElement;
  private places: PlaceRow[] | null = null;
  private placesOpen = false;
  // Map state.
  private readonly hidden = new Set<AreaKind>();
  private showRoute = true;
  private readonly drawOpts: CityDrawOptions = { dpr: 1, route: false, shortcuts: true };
  private readonly overview = newRaster();
  private readonly detail = newRaster();
  private readonly tags: Tag[] = [];
  /** Placed rectangles this frame (x0, y0, x1, y1 in device px), tags and what they keep clear of. */
  private placed = new Float32Array(64);
  private placedN = 0;
  private readonly kindPaths = new Map<AreaKind | 'shortcut', Path2D>();
  private readonly driftAreas: Set<number>;
  /** The course drawn (none for free roam's whole city), its color and its name in the legend and cards. */
  private readonly route: RaceRoute | null;
  private readonly routeInk: PaletteColor;
  private readonly routeLabel: string;
  private readonly zonePaths: Path2D | null;
  private readonly start: RouteSample | null;
  private readonly finish: RouteSample | null;
  private sprites: { dpr: number; start: HTMLCanvasElement; finish: HTMLCanvasElement | null; pin: HTMLCanvasElement } | null = null;
  private bandTop: CanvasGradient | null = null;
  private bandLeft: CanvasGradient | null = null;
  private readonly dashes: number[] = [UI.dash, UI.gap];
  /** Canvas fonts at the pixel ratio, and the furniture over the canvas tags keep clear of (device px), set on resize. */
  private readonly font = { tag: '', minor: '', you: '', grid: '', scale: '' };
  private readonly furniture = new Float32Array(8);
  private wp: Vec2 | null;
  private dpr = 1;
  private time = 0;
  private lastT = 0;
  private raf = 0;
  private disposed = false;
  private dirty = true;
  private lastDraw = -1;
  private revealT: number;
  /** The pin's drop (0..1) and then its ripple (to DROP_END); at rest when no pin has just landed. */
  private dropT: number = DROP_END;
  private follow = false;
  private camMoving = false;
  private tagTime = 0;
  private liveAt = 0;
  private hereName = '';
  // Pointer and keys.
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** The press in progress: where it started and is (CSS px), whether it became a drag, whether it may still be a tap, its speed (CSS px/s). */
  private press: { id: number; x0: number; y0: number; x: number; y: number; moved: boolean; tap: boolean; touch: boolean; vx: number; vy: number; t: number } | null = null;
  private pinchD0 = 1;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private tapTimer = 0;
  private readonly ptr = { x: 0, y: 0, in: false };
  private hoverDirty = false;
  private hover: Hover = { kind: 'area', area: null };
  /** The area under the pointer, and the one lit (it stays lit while fading out). */
  private hoverTarget: Area | null = null;
  private hoverArea: Area | null = null;
  private hoverAmt = 0;
  private legendKey: LegendKey | null = null;
  private legendShown: LegendKey | null = null;
  private legendAmt = 0;
  private placeHover: Area | null = null;
  private pulse: { area: Area; t: number } | null = null;
  private readonly held = new Set<string>();
  private cursor = '';

  constructor(
    private readonly world: World,
    player: MapCar,
    private readonly opts: FullMapOptions,
  ) {
    this.layers = layersOf(world);
    this.cam = new MapCamera(world);
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.revealT = this.reduced ? 1 : -UI.revealDelay / UI.revealTime;
    this.me = { ...player };
    this.wp = opts.waypoint?.get() ?? null;
    this.driftAreas = new Set(driftZones(world).map((z) => z.area));
    const course = opts.course ?? { route: world.route, ink: 'orange' as const, label: world.route.closed ? 'Race circuit' : 'Race route' };
    const route = (this.route = course.route && course.route.points.length > 1 ? course.route : null);
    this.routeInk = course.ink;
    this.routeLabel = course.label;
    this.start = route ? routeSample(route, route.startS) : null;
    this.finish = route && !route.closed ? routeSample(route, route.finishS) : null;
    // Drift: the zones where a slide pays, lit in the course's color (world meters, drawn through the view).
    let zones: Path2D | null = null;
    if (course.zones) {
      zones = new Path2D();
      for (const z of driftZones(world)) z.polygon.forEach((q, i) => (i ? zones!.lineTo(q.x, q.z) : zones!.moveTo(q.x, q.z)));
    }
    this.zonePaths = zones;
    this.buildTags();

    this.canvas = h('canvas', { class: 'fullmap-cv', role: 'img', 'aria-label': 'City map' });
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.rose = h('div', { class: 'fullmap-rose', 'aria-hidden': 'true', html: ROSE_SVG });
    this.zoomInBtn = iconBtn(ZoomIn, 'Zoom in (+)', () => this.zoomBy(UI.step));
    this.zoomOutBtn = iconBtn(ZoomOut, 'Zoom out (-)', () => this.zoomBy(1 / UI.step));
    this.findBtn = iconBtn(LocateFixed, 'Find me (C)', () => this.findMe());
    this.zoomEl = h('span', { class: 'fullmap-zoom', 'aria-hidden': 'true' }, '1×');
    this.tools = h('div', { class: 'fullmap-tools' }, this.zoomInBtn, this.zoomEl, this.zoomOutBtn, h('i', { class: 'fullmap-tools-gap' }), this.findBtn, iconBtn(Maximize2, 'Whole city (F)', () => this.fitAll()));
    // The card that follows the pointer.
    this.tipName = h('b', { class: 'fullmap-tip-name' });
    this.tipCell = h('span', { class: 'fullmap-tip-cell' });
    this.tipKind = h('div', { class: 'fullmap-tip-kind' });
    this.tipArrow = h('span', { class: 'fullmap-tip-arrow' }, icon(Navigation2, { size: 12 }));
    this.tipFar = h('span', {});
    this.tipDrift = h('span', { class: 'chip fullmap-badge drift' }, icon(Disc3, { size: 12 }), h('span', {}, 'Drift zone'));
    this.tipShort = h('span', { class: 'chip fullmap-badge short' }, icon(Route, { size: 12 }), h('span', {}, 'Shortcut'));
    this.tipHere = h('span', { class: 'chip fullmap-badge here' }, icon(Navigation, { size: 12 }), h('span', {}, 'You are here'));
    this.tipAct = h('div', { class: 'fullmap-tip-act' });
    this.tipBtn = btn(MapPin, 'Set waypoint', () => this.tipAction(), 'small primary fullmap-tip-btn');
    this.tip = h(
      'div',
      { class: 'fullmap-tip', 'aria-hidden': 'true' },
      h('div', { class: 'fullmap-tip-head' }, h('i', { class: 'fullmap-dot' }), this.tipName, this.tipCell),
      this.tipKind,
      h('div', { class: 'fullmap-tip-far' }, this.tipArrow, this.tipFar),
      h('div', { class: 'fullmap-tip-badges' }, this.tipDrift, this.tipShort, this.tipHere),
      this.tipAct,
      this.tipBtn,
    );
    this.stage = h(
      'div',
      { class: 'fullmap-stage', tabindex: '-1' },
      this.canvas,
      h('i', { class: 'fullmap-vignette' }),
      h('i', { class: 'fullmap-corner tl' }),
      h('i', { class: 'fullmap-corner br' }),
      this.rose,
      this.tools,
      this.tip,
    );
    // Side panel: the legend and the places, under tabs.
    this.legendPane = h('div', { class: 'fullmap-pane', role: 'tabpanel' }, this.buildLegend());
    this.placesList = h('ul', { class: 'fullmap-places' });
    this.placesPane = h('div', { class: 'fullmap-pane', role: 'tabpanel', hidden: true }, this.placesList);
    this.legendTab = h('button', { class: 'tab on', type: 'button', role: 'tab', 'aria-selected': 'true' }, icon(Layers, { size: 15 }), 'Legend');
    this.placesTab = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, icon(Landmark, { size: 15 }), 'Places');
    this.legendTab.addEventListener('click', () => this.showTab(false));
    this.placesTab.addEventListener('click', () => this.showTab(true));
    this.wpFar = h('span', { class: 'fullmap-wp-far' });
    this.wpCard = h(
      'div',
      { class: 'fullmap-wp', hidden: true },
      h('span', { class: 'fullmap-wp-ic' }, icon(MapPinned, { size: 18 })),
      h('span', { class: 'fullmap-wp-text' }, h('b', {}, 'Waypoint'), this.wpFar),
      btn(MapPinOff, 'Clear', () => this.setWaypoint(null), 'small fullmap-wp-clear'),
    );
    const side = h('aside', { class: 'fullmap-side' }, h('div', { class: 'tabs', role: 'tablist' }, this.legendTab, this.placesTab), this.legendPane, this.placesPane, this.wpCard);
    // Header and footer.
    this.hereEl = h('b', {});
    const chips: HTMLElement[] = [];
    if (opts.event) chips.push(h('span', { class: 'chip accent fullmap-chip' }, icon(Flag, { size: 13 }), h('span', {}, opts.event)));
    if (opts.seed) chips.push(h('span', { class: 'chip fullmap-chip seed' }, icon(Hash, { size: 13 }), h('span', {}, opts.seed)));
    // The course shown, in its race type's color (the race step opens the map on the type it has picked).
    if (opts.course) chips.push(h('span', { class: 'chip fullmap-chip course', style: `--ink:${PALETTE[opts.course.ink]}` }, icon(Route, { size: 13 }), h('span', {}, opts.course.label)));
    const head = h(
      'header',
      { class: 'fullmap-top' },
      h('h2', { class: 'title fullmap-title' }, icon(MapIcon, { size: 22 }), h('span', {}, CITY_NAME)),
      ...chips,
      h('span', { class: 'fullmap-where' }, h('span', { class: 'fullmap-where-pre' }, 'You are in '), this.hereEl),
      iconBtn(X, 'Close map (Esc)', () => opts.onClose(), 'fullmap-close'),
    );
    const key = (caps: string[], label: string) => h('span', { class: 'fullmap-key' }, ...caps.map((k) => h('kbd', {}, k)), h('span', {}, label));
    const foot = h(
      'footer',
      { class: 'fullmap-bottom' },
      h(
        'div',
        { class: 'fullmap-hints' },
        key(['Scroll'], 'Zoom'),
        key(['Drag'], 'Pan'),
        opts.waypoint ? key(['Click'], 'Waypoint') : key(['Dbl click'], 'Zoom in'),
        key(['F'], 'Whole city'),
        key(['C'], 'Find me'),
        key(['Tab', 'Esc'], 'Close'),
      ),
      h('div', { class: 'fullmap-hints touch' }, key(['Pinch'], 'Zoom'), key(['Drag'], 'Pan'), key(['Tap'], opts.waypoint ? 'A place or a waypoint' : 'A place')),
    );
    this.panel = h('div', { class: 'panel fullmap-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'City map' }, head, h('div', { class: 'fullmap-main' }, this.stage, side), foot);
    this.root = h('div', { class: 'screen center dim fullmap-modal' }, this.panel);
    // A click on the dimmed backdrop (not the panel) closes it too.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) opts.onClose();
    });
    this.updateHere();
    this.syncWaypoint();

    const cv = this.canvas;
    cv.addEventListener('pointerdown', this.onDown);
    cv.addEventListener('pointermove', this.onMove);
    cv.addEventListener('pointerup', this.onUp);
    cv.addEventListener('pointercancel', this.onUp);
    cv.addEventListener('pointerleave', this.onLeave);
    this.stage.addEventListener('wheel', this.onWheel, { passive: false });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    this.ro = new ResizeObserver(() => this.resize());
    this.focusBack = document.activeElement;
  }

  /** Call once the root is in the document: sizes the map to its box and starts the loop. */
  draw(): void {
    if (this.disposed) return;
    this.ro.observe(this.stage);
    this.resize();
    this.stage.focus({ preventScroll: true });
    document.body.classList.add('fullmap-open');
    if (!this.raf) {
      this.lastT = 0;
      this.raf = requestAnimationFrame(this.frame);
    }
    this.compose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.tapTimer);
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    document.body.classList.remove('fullmap-open');
    if (this.focusBack instanceof HTMLElement && this.focusBack.isConnected) this.focusBack.focus({ preventScroll: true });
    // A short fade out (the owner has already moved on, so it takes no input).
    if (this.reduced) this.root.remove();
    else {
      this.root.classList.add('out');
      setTimeout(() => this.root.remove(), 170);
    }
  }

  // ---------- layout ----------

  /** Size the canvas to the stage (device px), refit, and redraw everything once. */
  private resize(): void {
    if (this.disposed) return;
    const r = this.stage.getBoundingClientRect();
    const cssW = Math.max(120, Math.floor(r.width));
    const cssH = Math.max(120, Math.floor(r.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(cssW * dpr);
    const hgt = Math.round(cssH * dpr);
    if (w === this.cam.view.w && hgt === this.cam.view.h && dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = hgt;
    this.cam.resize(w, hgt);
    this.drawOpts.dpr = dpr;
    this.overview.ok = this.detail.ok = false;
    this.dashes[0] = UI.dash * dpr;
    this.dashes[1] = UI.gap * dpr;
    for (const t of this.tags) t.w = 0;
    const f = this.font;
    f.tag = `700 ${11 * dpr}px ${INK.font}`;
    f.minor = `600 ${10 * dpr}px ${INK.font}`;
    f.you = `800 ${10 * dpr}px ${INK.font}`;
    f.grid = `700 ${10 * dpr}px ${INK.font}`;
    f.scale = `700 ${11 * dpr}px ${INK.font}`;
    [this.rose, this.tools].forEach((el, i) => this.furniture.set([el.offsetLeft * dpr, el.offsetTop * dpr, (el.offsetLeft + el.offsetWidth) * dpr, (el.offsetTop + el.offsetHeight) * dpr], i * 4));
    const c = this.ctx;
    this.bandTop = c.createLinearGradient(0, 0, 0, 24 * dpr);
    this.bandLeft = c.createLinearGradient(0, 0, 24 * dpr, 0);
    for (const g of [this.bandTop, this.bandLeft]) {
      g.addColorStop(0, INK.band);
      g.addColorStop(1, 'rgba(25, 24, 26, 0)');
    }
    if (!this.sprites || this.sprites.dpr !== dpr) this.sprites = this.makeSprites(dpr);
    this.tipW = 0;
    this.updateZoomUi();
    this.dirty = true;
  }

  /** The start and finish discs (the menu course map's flag in a disc) and the waypoint pin, drawn once per pixel ratio. */
  private makeSprites(dpr: number): { dpr: number; start: HTMLCanvasElement; finish: HTMLCanvasElement | null; pin: HTMLCanvasElement } {
    const disc = (ico: IconNode): HTMLCanvasElement => {
      const cv = document.createElement('canvas');
      const r = 8.5 * dpr;
      cv.width = cv.height = Math.ceil(2 * r + 4 * dpr);
      const c = cv.getContext('2d')!;
      const m = cv.width / 2;
      c.fillStyle = PALETTE.bg0;
      c.strokeStyle = PALETTE[this.routeInk];
      c.lineWidth = 2 * dpr;
      c.beginPath();
      c.arc(m, m, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      drawIcon(c, ico, m - 5.5 * dpr, m - 5.5 * dpr, 11 * dpr, PALETTE[this.routeInk], 2.6);
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
    return { dpr, start: disc(this.route?.closed === false ? FlagTriangleRight : Flag), finish: this.finish ? disc(Flag) : null, pin };
  }

  // ---------- the loop ----------

  private readonly frame = (t: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 1 / 60;
    this.lastT = t;
    this.time += dt;
    const moving = this.update(dt);
    // Decoration alone (dashes marching, pings) is drawn at idleHz; anything that moved, every frame.
    const decor = !this.reduced;
    if (this.dirty || moving || (decor && this.time - this.lastDraw >= 1 / UI.idleHz - 0.002)) this.compose();
  };

  /** Advance everything by dt; true while something is in motion this frame. */
  private update(dt: number): boolean {
    const instant = this.reduced;
    let moving = false;
    // The live player (the menu's car keeps driving behind the map).
    const live = this.opts.livePlayer?.();
    if (live) {
      const v = this.cam.view;
      if (Math.abs(live.x - this.me.x) * v.scale > 0.3 || Math.abs(live.z - this.me.z) * v.scale > 0.3 || Math.abs(live.yaw - this.me.yaw) > 0.005) {
        this.me.x = live.x;
        this.me.z = live.z;
        this.me.yaw = live.yaw;
        moving = true;
      }
      if (this.follow) this.cam.follow(live.x, live.z);
    }
    // Held keys pan.
    if (this.held.size) {
      const k = (c1: string, c2: string) => (this.held.has(c1) || this.held.has(c2) ? 1 : 0);
      const sx = k('ArrowLeft', 'KeyA') - k('ArrowRight', 'KeyD');
      const sy = k('ArrowUp', 'KeyW') - k('ArrowDown', 'KeyS');
      if (sx || sy) {
        const d = UI.keyPan * this.dpr * dt;
        this.cam.nudge(sx * d, sy * d);
        this.setFollow(false);
      }
    }
    const camMoved = this.cam.step(dt, instant);
    if (camMoved) {
      this.hoverDirty = true;
      this.updateZoomUi();
    }
    // The frame the view comes to rest draws once more, so the city is redrawn sharp for it.
    const camMoving = camMoved || this.cam.held;
    if (this.camMoving && !camMoving) this.dirty = true;
    this.camMoving = camMoving;
    if (camMoving) moving = true;
    if (this.revealT < 1) {
      this.revealT = Math.min(1, this.revealT + dt / UI.revealTime);
      moving = true;
    }
    if (this.dropT < DROP_END) {
      this.dropT += dt / UI.drop;
      moving = true;
    }
    if (this.pulse) {
      this.pulse.t += dt;
      if (this.pulse.t > UI.pulse) this.pulse = null;
      moving = true;
    }
    if (this.hoverDirty) this.updateHover();
    // Highlights fade in and out.
    const kf = instant ? 1 : 1 - Math.exp(-UI.fade * dt);
    const target = this.hoverTarget;
    // A new area lights at once (from nothing it fades in); leaving one fades it out before letting go.
    if (target && target !== this.hoverArea) {
      if (this.hoverArea) this.hoverAmt = 1;
      this.hoverArea = target;
    }
    const hoverGoal = target ? 1 : 0;
    if (Math.abs(this.hoverAmt - hoverGoal) > 0.004) {
      this.hoverAmt += (hoverGoal - this.hoverAmt) * kf;
      moving = true;
    } else {
      this.hoverAmt = hoverGoal;
      if (!target) this.hoverArea = null;
    }
    if (this.legendKey) this.legendShown = this.legendKey;
    const legendGoal = this.legendKey ? 1 : 0;
    if (Math.abs(this.legendAmt - legendGoal) > 0.004) {
      this.legendAmt += (legendGoal - this.legendAmt) * kf;
      moving = true;
    } else {
      this.legendAmt = legendGoal;
      if (!legendGoal) this.legendShown = null;
    }
    // Live readouts.
    if (this.time - this.liveAt > UI.live) {
      this.liveAt = this.time;
      if (this.opts.livePlayer) {
        this.updateHere();
        if (this.placesOpen) this.refreshPlaces(false);
        this.syncWaypointText();
      }
    }
    return moving;
  }

  // ---------- drawing ----------

  /** Draw a frame of the visible canvas. */
  private compose(): void {
    this.dirty = false;
    this.lastDraw = this.time;
    const c = this.ctx;
    const v = this.cam.view;
    if (!v.w) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = MAP_INK.ground;
    c.fillRect(0, 0, v.w, v.h);
    const mx = mapX(v, this.me.x);
    const my = mapY(v, this.me.z);
    const u = clamp01(this.revealT);
    const revealing = u < 1;
    let radius = 0;
    if (revealing) {
      radius = easeOut(u) * (Math.max(Math.hypot(mx, my), Math.hypot(v.w - mx, my), Math.hypot(mx, v.h - my), Math.hypot(v.w - mx, v.h - my)) + 30 * this.dpr);
      c.save();
      c.beginPath();
      c.arc(mx, my, Math.max(0.1, radius), 0, Math.PI * 2);
      c.clip();
    }
    this.drawCity(c, v);
    this.drawGrid(c, v);
    this.drawHighlights(c, v);
    if (this.showRoute) this.drawRoute(c, v);
    this.drawTags(c, v, mx, my);
    if (this.showRoute) this.drawMarks(c, v);
    this.drawWaypoint(c, v);
    if (revealing) {
      c.restore();
      this.drawRevealRing(c, mx, my, radius, u);
    }
    // Zoomed in, what is off the view still shows where it is: an arrow on the edge.
    if (this.offView(v, mx, my)) this.drawEdgeArrow(c, v, mx, my, INK.player);
    else this.drawPlayer(c, mx, my);
    if (this.wp) {
      const wx = mapX(v, this.wp.x);
      const wy = mapY(v, this.wp.z);
      if (this.offView(v, wx, wy)) this.drawEdgeArrow(c, v, wx, wy, INK.pin);
    }
    this.drawEdges(c, v);
  }

  private offView(v: MapView, x: number, y: number): boolean {
    const m = 6 * this.dpr;
    return x < -m || y < -m || x > v.w + m || y > v.h + m;
  }

  /** An arrow just inside the map's edge, on the line from the center to a point off the view, pointing at it. */
  private drawEdgeArrow(c: CanvasRenderingContext2D, v: MapView, x: number, y: number, ink: string): void {
    const dpr = this.dpr;
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

  /** The city from the cached bitmaps: the view's own when it covers, the fitted city under it (or alone at 1x). */
  private drawCity(c: CanvasRenderingContext2D, v: MapView): void {
    const fit = this.cam.fit;
    const ov = this.overview;
    if (!ov.ok) this.rasterize(ov, fit.cx, fit.cz, fit.scale, v.w, v.h);
    const atFit = Math.abs(v.scale / fit.scale - 1) < 1e-4 && Math.abs(v.cx - fit.cx) * v.scale < 0.25 && Math.abs(v.cz - fit.cz) * v.scale < 0.25;
    if (atFit) {
      c.drawImage(ov.cv, 0, 0);
      return;
    }
    const d = this.detail;
    const k = d.ok ? v.scale / d.view.scale : 0;
    const exact = d.ok && Math.abs(k - 1) < 1e-4 && Math.abs(v.cx - d.view.cx) * v.scale < 0.25 && Math.abs(v.cz - d.view.cz) * v.scale < 0.25;
    const stale = !d.ok || !this.covers(d, v) || k > UI.rasterDrift || k < 1 / UI.rasterDrift;
    // While moving: redraw when the bitmap falls short, at most every rasterGap; once settled, redraw for the exact view.
    if ((stale && this.time - d.at >= UI.rasterGap) || (!this.camMoving && !exact)) {
      const m = Math.round(Math.max(v.w, v.h) * UI.margin);
      this.rasterize(d, v.cx, v.cz, v.scale, v.w + 2 * m, v.h + 2 * m);
    }
    if (!this.covers(d, v)) this.blit(c, ov, v);
    this.blit(c, d, v);
  }

  private rasterize(r: Raster, cx: number, cz: number, scale: number, w: number, hgt: number): void {
    if (r.cv.width !== w || r.cv.height !== hgt) {
      r.cv.width = w;
      r.cv.height = hgt;
    }
    Object.assign(r.view, { cx, cz, scale, w, h: hgt });
    this.drawOpts.hidden = this.hidden;
    this.layers.draw(r.c, r.view, this.drawOpts);
    r.ok = true;
    r.at = this.time;
  }

  /** The bitmap's rectangle in the current view (device px). */
  private rect(r: Raster, v: MapView): { x: number; y: number; w: number; h: number } {
    const k = v.scale / r.view.scale;
    RECT.x = v.w / 2 - (r.view.cx - v.cx) * v.scale - (r.view.w / 2) * k;
    RECT.y = v.h / 2 - (r.view.cz - v.cz) * v.scale - (r.view.h / 2) * k;
    RECT.w = r.view.w * k;
    RECT.h = r.view.h * k;
    return RECT;
  }

  private covers(r: Raster, v: MapView): boolean {
    if (!r.ok) return false;
    const q = this.rect(r, v);
    return q.x <= 0.5 && q.y <= 0.5 && q.x + q.w >= v.w - 0.5 && q.y + q.h >= v.h - 0.5;
  }

  private blit(c: CanvasRenderingContext2D, r: Raster, v: MapView): void {
    if (!r.ok) return;
    const q = this.rect(r, v);
    c.drawImage(r.cv, q.x, q.y, q.w, q.h);
  }

  /** The coordinate grid over the city: 200 m cells, 100 m lines between them once there is room. */
  private drawGrid(c: CanvasRenderingContext2D, v: MapView): void {
    const g = this.world.graph.bounds;
    const x0 = g.maxX + MAP_PAD;
    const z0 = g.maxZ + MAP_PAD;
    const x1 = g.minX - MAP_PAD;
    const z1 = g.minZ - MAP_PAD;
    const cell = UI.grid * v.scale;
    const minor = cell >= UI.minorGrid * this.dpr;
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

  /** Legend hover (a veil, the kind lit), the area under the pointer or a hovered place, a picked place's pulse. */
  private drawHighlights(c: CanvasRenderingContext2D, v: MapView): void {
    const s = v.scale;
    const px = this.dpr / s;
    const key = this.legendShown;
    if (key && this.legendAmt > 0.003) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 0.62 * this.legendAmt;
      c.fillStyle = INK.veil;
      c.fillRect(0, 0, v.w, v.h);
      c.globalAlpha = 1;
      if (key !== 'you' && key !== 'route' && key !== 'waypoint') {
        const ink = key === 'shortcut' ? MAP_INK.shortcut : (KINDS[key]?.ink ?? PALETTE.soft);
        this.worldTransform(c, v);
        this.lightPath(c, this.kindPath(key), ink, key === 'shortcut' ? undefined : KINDS[key]?.fill, this.legendAmt, px, true);
      }
    }
    const lit = this.placeHover ?? this.hoverArea;
    if (lit && (this.placeHover || this.hoverAmt > 0.003) && !this.hidden.has(lit.kind)) {
      this.worldTransform(c, v);
      this.lightPath(c, this.layers.areaPath(lit), this.inkOf(lit), KINDS[lit.kind]?.fill, this.placeHover ? 1 : this.hoverAmt, px, lit.polygon.length >= 3);
    }
    const p = this.pulse;
    if (p) {
      const path = this.layers.areaPath(p.area);
      const ink = this.inkOf(p.area);
      this.worldTransform(c, v);
      const fadeOut = 1 - clamp01((p.t - (UI.pulse - 0.4)) / 0.4);
      this.lightPath(c, path, ink, KINDS[p.area.kind]?.fill, fadeOut, px, p.area.polygon.length >= 3);
      if (!this.reduced) {
        // Two rings of light running out from the outline.
        for (const off of PULSE_RINGS) {
          const q = (p.t - off) / 0.9;
          if (q < 0 || q > 1) continue;
          c.globalAlpha = (1 - q) * 0.8;
          c.strokeStyle = ink;
          c.lineWidth = (2 + 14 * easeOut(q)) * px;
          c.stroke(path);
        }
        c.globalAlpha = 1;
      }
    }
  }

  private worldTransform(c: CanvasRenderingContext2D, v: MapView): void {
    const s = v.scale;
    c.setTransform(-s, 0, 0, -s, v.w / 2 + v.cx * s, v.h / 2 + v.cz * s);
    c.lineCap = 'round';
    c.lineJoin = 'round';
  }

  /** A lit outline: its fill again (brighter), a soft wide stroke and a crisp one in its ink. */
  private lightPath(c: CanvasRenderingContext2D, path: Path2D, ink: string, fill: string | undefined, amt: number, px: number, filled: boolean): void {
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

  /** Every shown area of a legend kind as one path (the race shortcuts are their own). */
  private kindPath(key: AreaKind | 'shortcut'): Path2D {
    let p = this.kindPaths.get(key);
    if (!p) {
      p = new Path2D();
      for (const a of this.world.areas) {
        if (!shownOnMap(a) || (key === 'shortcut' ? !isShortcut(a) : a.kind !== key || (key === 'backAlley' && isShortcut(a)))) continue;
        if (a.polygon.length >= 3) trace(p, a.polygon, true);
        else if (a.path.length > 1) trace(p, a.path, false);
      }
      this.kindPaths.set(key, p);
    }
    return p;
  }

  private inkOf(a: Area | null): string {
    if (!a) return PALETTE.soft;
    if (isShortcut(a)) return MAP_INK.shortcut;
    return KINDS[a.kind]?.ink ?? PALETTE.soft;
  }

  /** The race route: a soft road, the line, and dashes marching in its driving direction. */
  private drawRoute(c: CanvasRenderingContext2D, v: MapView): void {
    const route = this.route;
    if (!route) return;
    const pts = route.points;
    const dpr = this.dpr;
    const lit = this.legendShown === 'route' ? this.legendAmt : 0;
    c.globalAlpha = this.legendShown && !lit ? 1 - 0.7 * this.legendAmt : 1;
    if (this.zonePaths) {
      // Drift zones under the lap, in its color.
      c.setTransform(-v.scale, 0, 0, -v.scale, v.w / 2 + v.cx * v.scale, v.h / 2 + v.cz * v.scale);
      c.fillStyle = rgba(this.routeInk, 0.22 + 0.15 * lit);
      c.fill(this.zonePaths);
      c.strokeStyle = PALETTE[this.routeInk];
      c.lineWidth = (1.2 * dpr) / v.scale;
      c.stroke(this.zonePaths);
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    for (let i = 0; i < pts.length; i++) (i ? c.lineTo(mapX(v, pts[i].x), mapY(v, pts[i].z)) : c.moveTo(mapX(v, pts[i].x), mapY(v, pts[i].z)));
    if (route.closed) c.closePath();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = rgba(this.routeInk, 0.18);
    c.lineWidth = (7 + 5 * lit) * dpr;
    c.stroke();
    c.strokeStyle = lit > 0 ? PALETTE[this.routeInk] : rgba(this.routeInk, 0.75);
    c.lineWidth = (2.2 + 0.8 * lit) * dpr;
    c.stroke();
    if (!this.reduced) {
      c.setLineDash(this.dashes);
      c.lineDashOffset = -this.time * UI.march * dpr;
      c.strokeStyle = INK.routeDash;
      c.lineWidth = 1.6 * dpr;
      c.stroke();
      c.setLineDash(NO_DASH);
    }
    c.globalAlpha = 1;
  }

  /** The start line (and a sprint's finish): the menu course map's flag in a disc. */
  private drawMarks(c: CanvasRenderingContext2D, v: MapView): void {
    const sp = this.sprites;
    if (!sp || !this.start) return;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = this.legendShown && this.legendShown !== 'route' ? 1 - 0.7 * this.legendAmt : 1;
    const hm = this.hover.kind === 'mark' ? (this.hover.finish ? 1 : 0) : -1;
    this.putMark(c, v, sp.start, this.start, hm === 0);
    if (sp.finish && this.finish) this.putMark(c, v, sp.finish, this.finish, hm === 1);
    c.globalAlpha = 1;
  }

  private putMark(c: CanvasRenderingContext2D, v: MapView, cv: HTMLCanvasElement, p: RouteSample, hot: boolean): void {
    const w = cv.width * (hot ? 1.15 : 1);
    c.drawImage(cv, mapX(v, p.x) - w / 2, mapY(v, p.z) - w / 2, w, w);
  }

  /** The waypoint: a pin that drops in and lands with a ripple; larger while hovered. */
  private drawWaypoint(c: CanvasRenderingContext2D, v: MapView): void {
    const w = this.wp;
    const sp = this.sprites;
    if (!w || !sp) return;
    const dpr = this.dpr;
    const x = mapX(v, w.x);
    const y = mapY(v, w.z);
    const t = clamp01(this.dropT);
    const fall = this.reduced ? 0 : (1 - bounceOut(t)) * 30 * dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    // Its shadow on the street, growing as it lands, then the landing ripple.
    c.globalAlpha = 0.5 * (this.reduced ? 1 : t);
    c.fillStyle = INK.outline;
    c.beginPath();
    c.ellipse(x, y, 5.5 * dpr, 2.4 * dpr, 0, 0, Math.PI * 2);
    c.fill();
    const rip = (this.dropT - 1) * (UI.drop / UI.ripple);
    if (!this.reduced && rip > 0 && rip < 1) {
      c.globalAlpha = (1 - rip) * 0.9;
      c.strokeStyle = INK.pin;
      c.lineWidth = 2 * dpr;
      c.beginPath();
      c.ellipse(x, y, (5 + 22 * easeOut(rip)) * dpr, (2.4 + 10 * easeOut(rip)) * dpr, 0, 0, Math.PI * 2);
      c.stroke();
    }
    c.globalAlpha = 1;
    const hot = this.hover.kind === 'pin' || this.legendShown === 'waypoint' ? 1.18 : 1;
    const pw = sp.pin.width * hot;
    const ph = sp.pin.height * hot;
    c.drawImage(sp.pin, x - pw / 2, y - fall - (PIN.tip / PIN.h) * ph, pw, ph);
  }

  /** The reveal's edge: a ring running out from the player as the map boots. */
  private drawRevealRing(c: CanvasRenderingContext2D, x: number, y: number, r: number, u: number): void {
    if (r <= 0) return;
    const dpr = this.dpr;
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

  /** The player: a white heading arrow over two orange pings a beat apart (the menu maps' car marker). */
  private drawPlayer(c: CanvasRenderingContext2D, x: number, y: number): void {
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    const lit = this.legendShown === 'you' ? this.legendAmt : 0;
    c.strokeStyle = INK.ping;
    c.lineWidth = 2 * dpr;
    if (this.reduced) {
      c.globalAlpha = 0.6;
      c.beginPath();
      c.arc(x, y, 15 * dpr, 0, Math.PI * 2);
      c.stroke();
    } else
      for (const off of PINGS) {
        const q = ((this.time + off) % UI.ping) / UI.ping;
        const e = 1 - (1 - q) ** 2.2;
        c.globalAlpha = 1 - e;
        c.beginPath();
        c.arc(x, y, 13 * (0.15 + 1.35 * e) * (1 + 0.5 * lit) * dpr, 0, Math.PI * 2);
        c.stroke();
      }
    c.globalAlpha = 1;
    // The arrow, turned to the heading: polygon(50% 0, 100% 100%, 50% 72%, 0 100%) on 12 x 15 px, a little larger here.
    const a = mapHeading(this.me.yaw);
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
    c.font = this.font.you;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.strokeStyle = INK.outline;
    c.lineWidth = 3 * dpr;
    c.strokeText('YOU', x, y + 22 * dpr);
    c.fillStyle = INK.player;
    c.fillText('YOU', x, y + 22 * dpr);
  }

  /** The grid's column and row names along the top and left edges, and the scale bar. */
  private drawEdges(c: CanvasRenderingContext2D, v: MapView): void {
    const dpr = this.dpr;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bandTop && this.bandLeft) {
      c.fillStyle = this.bandTop;
      c.fillRect(0, 0, v.w, 24 * dpr);
      c.fillStyle = this.bandLeft;
      c.fillRect(0, 0, 24 * dpr, v.h);
    }
    const g = this.world.graph.bounds;
    const x0 = g.maxX + MAP_PAD;
    const z0 = g.maxZ + MAP_PAD;
    const cols = Math.ceil((x0 - (g.minX - MAP_PAD)) / UI.grid);
    const rows = Math.ceil((z0 - (g.minZ - MAP_PAD)) / UI.grid);
    c.font = this.font.grid;
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
    c.font = this.font.scale;
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

  // ---------- name tags ----------

  private buildTags(): void {
    const w = this.world;
    const major = w.areas.filter((a) => KINDS[a.kind]?.tag && shownOnMap(a)).sort((a, b) => tagWeight(b) - tagWeight(a));
    const minor = w.areas.filter((a) => isMinor(a) && !KINDS[a.kind]?.tag).sort((a, b) => tagWeight(b) - tagWeight(a));
    for (const [list, small] of [
      [major, false],
      [minor, true],
    ] as const) {
      for (const a of list) {
        const p = tagAnchor(w, a);
        if (p) this.tags.push({ area: a, text: isShortcut(a) ? 'Shortcut' : placeName(a), ink: this.inkOf(a), x: p.x, z: p.z, minor: small, w: 0, alpha: 0, sx: 0, sy: 0 });
      }
    }
    this.placed = new Float32Array(4 * (this.tags.length + 12));
  }

  private reserveMark(v: MapView, p: RouteSample): void {
    const r = 11 * this.dpr;
    const x = mapX(v, p.x);
    const y = mapY(v, p.z);
    this.reserve(x - r, y - r, x + r, y + r);
  }

  private reserve(x0: number, y0: number, x1: number, y1: number): void {
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

  /**
   * Name tags: bigger places first, each dropped where it would cover one
   * already placed, a marker or the map's furniture, so zooming in (the places
   * spread out) fits more of them, and the minor places join from minorZoom.
   * Tags fade in and out as they fit or not.
   */
  private drawTags(c: CanvasRenderingContext2D, v: MapView, mx: number, my: number): void {
    const dpr = this.dpr;
    const zoom = this.cam.zoom;
    this.placedN = 0;
    // Keep clear of the player and its label, the markers, and the furniture over the canvas.
    this.reserve(mx - 18 * dpr, my - 18 * dpr, mx + 18 * dpr, my + 30 * dpr);
    if (this.wp) {
      const px = mapX(v, this.wp.x);
      const py = mapY(v, this.wp.z);
      this.reserve(px - 12 * dpr, py - 30 * dpr, px + 12 * dpr, py + 4 * dpr);
    }
    if (this.showRoute && this.start) {
      this.reserveMark(v, this.start);
      if (this.finish) this.reserveMark(v, this.finish);
    }
    const F = this.furniture;
    this.reserve(F[0], F[1], F[2], F[3]);
    this.reserve(F[4], F[5], F[6], F[7]);
    this.reserve(0, v.h - 44 * dpr, 150 * dpr, v.h);
    const kf = this.reduced ? 1 : 1 - Math.exp(-UI.tagFade * (this.time - this.tagTime));
    this.tagTime = this.time;
    const lit = this.legendShown;
    const H = 18 * dpr;
    const hm = 15 * dpr;
    for (const t of this.tags) {
      let goal = 0;
      const font = t.minor ? this.font.minor : this.font.tag;
      if ((!t.minor || zoom >= UI.minorZoom) && !this.hidden.has(t.area.kind) && !(isShortcut(t.area) && !this.drawOpts.shortcuts)) {
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
      t.alpha = Math.abs(goal - t.alpha) < 0.01 ? goal : t.alpha + (goal - t.alpha) * kf;
      if (t.alpha < 0.01) continue;
      if (goal === 0) {
        // Fading out where it was, following the view.
        t.sx = mapX(v, t.x);
        t.sy = mapY(v, t.z);
      }
      const dim = lit && lit !== 'you' && lit !== 'route' && lit !== 'waypoint' ? (t.area.kind === lit || (lit === 'shortcut' && isShortcut(t.area)) ? 1 : 1 - 0.75 * this.legendAmt) : lit ? 1 - 0.6 * this.legendAmt : 1;
      this.drawTag(c, t, font, dim * t.alpha);
    }
  }

  /** One tag: a chamfered dark plate with a hairline and the name in the place's ink. */
  private drawTag(c: CanvasRenderingContext2D, t: Tag, font: string, alpha: number): void {
    const dpr = this.dpr;
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

  // ---------- hover and the card ----------

  /** What is under the pointer (or the pinned tap), the area to light, and the card. */
  private updateHover(): void {
    this.hoverDirty = false;
    const show = this.pinned ?? (this.ptr.in && !this.press?.moved && !this.cam.held ? this.ptr : null);
    if (!show) {
      this.setHover({ kind: 'area', area: null }, null);
      this.hideTip();
      return;
    }
    const v = this.cam.view;
    const dpr = this.dpr;
    const sx = show.x * dpr;
    const sy = show.y * dpr;
    let hv: Hover;
    let wx: number;
    let wz: number;
    if (this.pinned) {
      hv = this.pinned.hover;
      wx = this.pinned.wx;
      wz = this.pinned.wz;
    } else {
      const w = mapToWorld(v, sx, sy, TMP);
      wx = w.x;
      wz = w.z;
      hv = this.hitTest(sx, sy, wx, wz);
    }
    const area = hv.kind === 'area' && hv.area && !this.hidden.has(hv.area.kind) && KINDS[hv.area.kind] && shownOnMap(hv.area) ? hv.area : null;
    this.setHover(hv, area);
    this.fillTip(hv, wx, wz);
    this.placeTip(show.x, show.y);
  }

  private setHover(hv: Hover, area: Area | null): void {
    const was = this.hover;
    const same = was.kind === hv.kind && (hv.kind !== 'area' || (was.kind === 'area' && was.area === hv.area)) && (hv.kind !== 'mark' || (was.kind === 'mark' && was.finish === hv.finish));
    this.hover = hv;
    if (area !== this.hoverTarget) this.dirty = true;
    this.hoverTarget = area;
    if (!same) this.dirty = true;
    this.setCursor(this.cam.held ? 'grabbing' : hv.kind === 'area' ? (this.opts.waypoint ? 'crosshair' : 'grab') : 'pointer');
  }

  /** The player's marker, the pin, a start or finish disc, else the area at the world point. */
  private hitTest(sx: number, sy: number, wx: number, wz: number): Hover {
    const v = this.cam.view;
    const dpr = this.dpr;
    if (Math.hypot(sx - mapX(v, this.me.x), sy - mapY(v, this.me.z)) < UI.markHit * dpr) return { kind: 'me' };
    if (this.wp) {
      const px = mapX(v, this.wp.x);
      const py = mapY(v, this.wp.z) - (PIN.head - 1) * dpr;
      if (Math.hypot(sx - px, sy - py) < UI.pinHit * dpr) return { kind: 'pin' };
    }
    if (this.showRoute && this.start) {
      if (Math.hypot(sx - mapX(v, this.start.x), sy - mapY(v, this.start.z)) < UI.markHit * dpr) return { kind: 'mark', finish: false };
      if (this.finish && Math.hypot(sx - mapX(v, this.finish.x), sy - mapY(v, this.finish.z)) < UI.markHit * dpr) return { kind: 'mark', finish: true };
    }
    return { kind: 'area', area: this.world.areaAt(wx, wz) };
  }

  /** The card's contents for what is under the pointer; only touches the DOM when they change. */
  private fillTip(hv: Hover, wx: number, wz: number): void {
    let name: string;
    let ink: string;
    let kind = '';
    let area: Area | null = null;
    let at: Vec2 = { x: wx, z: wz };
    let far = '';
    let bearing = 0;
    if (hv.kind === 'me') {
      // You: where you are and which way the car faces.
      name = 'You';
      ink = PALETTE.orange;
      kind = `In ${placeName(this.world.areaAt(this.me.x, this.me.z))}`;
      at = this.me;
      bearing = bearingDeg(Math.sin(this.me.yaw), Math.cos(this.me.yaw));
      far = `Heading ${compassPoint(Math.sin(this.me.yaw), Math.cos(this.me.yaw))}`;
    } else if (hv.kind === 'pin' && this.wp) {
      name = 'Waypoint';
      ink = INK.pin;
      at = this.wp;
    } else if (hv.kind === 'mark') {
      const p = hv.finish ? this.finish! : this.start!;
      name = this.route?.closed ? 'Start / finish line' : hv.finish ? 'Finish line' : 'Start line';
      ink = PALETTE[this.routeInk];
      kind = this.routeLabel;
      at = p;
    } else {
      area = hv.kind === 'area' ? hv.area : null;
      name = area && isShortcut(area) ? 'Race shortcut' : placeName(area);
      ink = this.inkOf(area);
      kind = area ? kindNote(name, isShortcut(area) ? 'Race shortcuts' : (KINDS[area.kind]?.label ?? '')) : '';
    }
    const dx = at.x - this.me.x;
    const dz = at.z - this.me.z;
    if (!far) {
      far = distanceLabel(dx, dz);
      bearing = bearingDeg(dx, dz);
    }
    const cell = this.cellName(at.x, at.z);
    const drift = !!area && this.driftAreas.has(area.id);
    const short = !!area && isShortcut(area);
    const here = !!area && hv.kind === 'area' && this.world.areaAt(this.me.x, this.me.z) === area;
    const pinned = !!this.pinned;
    const canSet = !!this.opts.waypoint;
    const act = pinned ? '' : hv.kind === 'me' ? 'Click to center the map on you' : !canSet ? '' : hv.kind === 'pin' ? 'Click to clear the waypoint' : 'Click to drop a waypoint here';
    const btnLabel = !canSet || !pinned || hv.kind === 'me' ? '' : hv.kind === 'pin' ? 'Clear waypoint' : 'Set waypoint';
    const key = `${name}|${ink}|${kind}|${far}|${cell}|${drift}|${short}|${here}|${act}|${btnLabel}`;
    if (key === this.tipKey) return;
    this.tipKey = key;
    this.tip.style.setProperty('--ink', ink);
    this.tipName.textContent = name;
    this.tipCell.textContent = cell;
    this.tipKind.textContent = kind;
    this.tipKind.hidden = !kind;
    this.tipFar.textContent = far;
    this.tipArrow.hidden = far === 'Here';
    this.tipArrow.style.transform = `rotate(${Math.round(bearing)}deg)`;
    this.tipDrift.hidden = !drift;
    this.tipShort.hidden = !short;
    this.tipHere.hidden = !here;
    this.tipAct.textContent = act;
    this.tipAct.hidden = !act;
    this.tipBtn.hidden = !btnLabel;
    if (btnLabel) (this.tipBtn.querySelector('.grow') as HTMLElement).textContent = btnLabel;
    this.tip.classList.add('on');
    this.tip.classList.toggle('pinned', pinned);
    this.tipW = 0;
  }

  /** Put the card by the pointer, flipped to stay inside the map. */
  private placeTip(x: number, y: number): void {
    if (!this.tipW) {
      this.tipW = this.tip.offsetWidth;
      this.tipH = this.tip.offsetHeight;
    }
    const W = this.cam.view.w / this.dpr;
    const H = this.cam.view.h / this.dpr;
    const off = 16;
    let left = x + off;
    let top = y + off;
    if (left + this.tipW > W - 8) left = x - off - this.tipW;
    if (top + this.tipH > H - 8) top = y - off - this.tipH;
    left = Math.max(8, Math.min(W - 8 - this.tipW, left));
    top = Math.max(28, Math.min(H - 8 - this.tipH, top));
    this.tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  private hideTip(): void {
    if (!this.tip.classList.contains('on')) return;
    this.tip.classList.remove('on', 'pinned');
    this.tipKey = '';
  }

  /** The card's button (touch): set the waypoint where the tap was, or clear it. */
  private tipAction(): void {
    const p = this.pinned;
    if (!p) return;
    this.pinned = null;
    if (p.hover.kind === 'pin') this.setWaypoint(null);
    else this.setWaypoint({ x: p.wx, z: p.wz });
    this.hideTip();
    this.hoverDirty = true;
  }

  /** The grid cell a point lies in ("C4"), or '' outside the grid. */
  private cellName(x: number, z: number): string {
    const g = this.world.graph.bounds;
    const col = Math.floor((g.maxX + MAP_PAD - x) / UI.grid);
    const row = Math.floor((g.maxZ + MAP_PAD - z) / UI.grid);
    const cols = Math.ceil((g.maxX - g.minX + 2 * MAP_PAD) / UI.grid);
    const rows = Math.ceil((g.maxZ - g.minZ + 2 * MAP_PAD) / UI.grid);
    return col >= 0 && row >= 0 && col < cols && row < rows ? `${colName(col)}${row + 1}` : '';
  }

  private setCursor(cur: string): void {
    if (cur === this.cursor) return;
    this.cursor = cur;
    this.canvas.style.cursor = cur;
  }

  // ---------- pointer input ----------

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = this.local(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone (or a synthetic one) cannot be captured; the drag still works inside the map.
    }
    this.pointers.set(e.pointerId, p);
    this.setFollow(false);
    if (this.pinned) {
      this.pinned = null;
      this.hideTip();
    }
    if (this.pointers.size === 1) {
      // A press on a gliding or flying map stops it there, and is no tap.
      const stopped = this.cam.stop();
      this.press = { id: e.pointerId, x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false, tap: !stopped, touch: e.pointerType !== 'mouse', vx: 0, vy: 0, t: performance.now() };
    } else if (this.pointers.size === 2) {
      // A second finger: a pinch, never a tap.
      if (this.press) this.press.moved = true;
      this.cam.endDrag(0, 0, false);
      const [a, b] = [...this.pointers.values()];
      this.pinchD0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      this.cam.beginPinch(((a.x + b.x) / 2) * this.dpr, ((a.y + b.y) / 2) * this.dpr);
    }
    this.hoverDirty = true;
  };

  private readonly onMove = (e: PointerEvent): void => {
    const p = this.local(e);
    if (e.pointerType === 'mouse') {
      this.ptr.x = p.x;
      this.ptr.y = p.y;
      this.ptr.in = true;
      this.hoverDirty = true;
    }
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) return;
    tracked.x = p.x;
    tracked.y = p.y;
    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this.cam.pinchTo(((a.x + b.x) / 2) * this.dpr, ((a.y + b.y) / 2) * this.dpr, Math.hypot(a.x - b.x, a.y - b.y) / this.pinchD0);
      this.dirty = true;
      return;
    }
    const pr = this.press;
    if (!pr || pr.id !== e.pointerId) return;
    const now = performance.now();
    if (!pr.moved) {
      if (Math.hypot(p.x - pr.x0, p.y - pr.y0) <= (pr.touch ? UI.touchSlop : UI.dragSlop)) return;
      // Past the slop it is a drag: the map catches up with the pointer from where the press began.
      pr.moved = true;
      pr.x = pr.x0;
      pr.y = pr.y0;
      pr.t = now;
      this.cam.beginDrag();
      this.hideTip();
      this.setCursor('grabbing');
    }
    const dx = p.x - pr.x;
    const dy = p.y - pr.y;
    pr.x = p.x;
    pr.y = p.y;
    this.cam.dragBy(dx * this.dpr, dy * this.dpr);
    // Release speed: an ease over the last moves (CSS px/s).
    const dtm = Math.max(1, now - pr.t) / 1000;
    pr.t = now;
    const k = 1 - Math.exp(-dtm / 0.05);
    pr.vx += (dx / dtm - pr.vx) * k;
    pr.vy += (dy / dtm - pr.vy) * k;
    this.dirty = true;
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const pr = this.press;
    if (this.pointers.size === 1) {
      // One finger of a pinch lifted: the other carries on as a drag (never a tap).
      this.cam.endPinch();
      const [id, q] = [...this.pointers.entries()][0];
      this.press = { id, x0: q.x, y0: q.y, x: q.x, y: q.y, moved: true, tap: false, touch: true, vx: 0, vy: 0, t: performance.now() };
      this.cam.beginDrag();
      return;
    }
    if (this.pointers.size > 1) return;
    this.cam.endPinch();
    this.press = null;
    if (!pr || pr.id !== e.pointerId) return;
    if (pr.moved) {
      // A pause before letting go is a stop, not a fling.
      const still = performance.now() - pr.t > 80;
      const speed = Math.hypot(pr.vx, pr.vy);
      this.cam.endDrag(pr.vx * this.dpr, pr.vy * this.dpr, !this.reduced && !still && speed > UI.minFling);
      this.setCursor(this.opts.waypoint ? 'crosshair' : 'grab');
      this.hoverDirty = true;
      return;
    }
    // A cancelled press (the browser took the gesture) is never a tap.
    if (pr.tap && e.type === 'pointerup') this.tap(pr.x0, pr.y0, pr.touch, e.shiftKey);
    this.hoverDirty = true;
  };

  private readonly onLeave = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    this.ptr.in = false;
    this.hoverDirty = true;
  };

  /** A click or tap: a second one soon after zooms in there; a single one acts once that window has passed. */
  private tap(x: number, y: number, touch: boolean, shift: boolean): void {
    const now = performance.now() / 1000;
    const last = this.lastTap;
    if (last && now - last.t < UI.dblTime && Math.hypot(x - last.x, y - last.y) < UI.dblDist) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.cam.zoomAt(shift ? 1 / UI.dblStep : UI.dblStep, x * this.dpr, y * this.dpr);
      this.dirty = true;
      return;
    }
    this.lastTap = { t: now, x, y };
    clearTimeout(this.tapTimer);
    this.tapTimer = window.setTimeout(() => this.singleTap(x, y, touch), UI.dblTime * 1000);
  }

  private singleTap(x: number, y: number, touch: boolean): void {
    if (this.disposed) return;
    this.lastTap = null;
    const v = this.cam.view;
    const sx = x * this.dpr;
    const sy = y * this.dpr;
    const w = mapToWorld(v, sx, sy, { x: 0, z: 0 });
    const hv = this.hitTest(sx, sy, w.x, w.z);
    if (hv.kind === 'me') {
      this.findMe();
      return;
    }
    if (touch) {
      // No hover on a touch screen: a tap pins the card there, with its waypoint button.
      this.pinned = { x, y, wx: w.x, wz: w.z, hover: hv };
      this.hoverDirty = true;
      return;
    }
    if (!this.opts.waypoint) return;
    if (hv.kind === 'pin') this.setWaypoint(null);
    else this.setWaypoint({ x: w.x, z: w.z });
    this.hoverDirty = true;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    const f = Math.max(0.5, Math.min(2, Math.exp(-dy * (e.ctrlKey ? UI.pinchWheel : UI.wheel))));
    const p = this.local(e);
    this.setFollow(false);
    this.cam.zoomAt(f, p.x * this.dpr, p.y * this.dpr);
    this.dirty = true;
  };

  // ---------- keys ----------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || PASS_KEYS.test(e.code)) return;
    // Everything else stops here, so nothing drives, pauses or navigates behind the map.
    e.stopImmediatePropagation();
    switch (e.code) {
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        if (!e.repeat) this.opts.onClose();
        return;
      case 'Equal':
      case 'NumpadAdd':
        e.preventDefault();
        this.zoomBy(UI.step);
        return;
      case 'Minus':
      case 'NumpadSubtract':
        e.preventDefault();
        this.zoomBy(1 / UI.step);
        return;
      case 'KeyF':
        if (!e.repeat) this.fitAll();
        return;
      case 'KeyC':
        if (!e.repeat) this.findMe();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'KeyA':
      case 'KeyD':
      case 'KeyW':
      case 'KeyS':
        e.preventDefault();
        this.held.add(e.code);
        return;
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };

  // ---------- actions ----------

  private zoomBy(f: number): void {
    const v = this.cam.view;
    this.cam.zoomAt(f, v.w / 2, v.h / 2);
    this.dirty = true;
  }

  private fitAll(): void {
    this.setFollow(false);
    const f = this.cam.fit;
    this.cam.flyTo(f.cx, f.cz, f.scale, this.reduced);
    this.dirty = true;
  }

  /** Fly to the player; in the menu the map then follows the car until it is moved. */
  private findMe(): void {
    this.cam.flyTo(this.me.x, this.me.z, Math.max(this.cam.goalZoom, UI.findZoom) * this.cam.fit.scale, this.reduced);
    this.setFollow(!!this.opts.livePlayer);
    this.dirty = true;
  }

  /** Following the live player (find me in the menu) until the map is moved; the find button stays lit meanwhile. */
  private setFollow(on: boolean): void {
    if (on === this.follow) return;
    this.follow = on;
    this.findBtn.classList.toggle('on', on);
  }

  /** Fly to a place, framing it, and pulse its outline. */
  private flyToPlace(p: PlaceRow): void {
    this.setFollow(false);
    const v = this.cam.view;
    const fit = this.cam.fit.scale;
    const bw = Math.max(40, p.span.maxX - p.span.minX);
    const bh = Math.max(40, p.span.maxZ - p.span.minZ);
    const s = Math.max(UI.placeMin * fit, Math.min(UI.placeMax * fit, Math.min((v.w * 0.5) / bw, (v.h * 0.5) / bh)));
    this.cam.flyTo((p.span.minX + p.span.maxX) / 2, (p.span.minZ + p.span.maxZ) / 2, s, this.reduced);
    this.pulse = { area: p.area, t: 0 };
    this.dirty = true;
  }

  private setWaypoint(p: Vec2 | null): void {
    if (!this.opts.waypoint) return;
    this.wp = p ? { x: p.x, z: p.z } : null;
    this.opts.waypoint.set(this.wp);
    if (p) this.dropT = this.reduced ? DROP_END : 0;
    this.syncWaypoint();
    this.tipKey = '';
    this.hoverDirty = true;
    this.dirty = true;
  }

  /** The waypoint's legend row and card follow it. */
  private syncWaypoint(): void {
    const on = !!this.wp;
    const row = this.rows.get('waypoint');
    if (row) row.hidden = !on;
    this.wpCard.hidden = !on;
    this.syncWaypointText();
  }

  private syncWaypointText(): void {
    const w = this.wp;
    if (!w) return;
    const text = distanceLabel(w.x - this.me.x, w.z - this.me.z);
    if (this.wpFar.textContent !== text) this.wpFar.textContent = text;
    const num = this.rows.get('waypoint')?.querySelector('.fullmap-num');
    if (num && num.textContent !== text) num.textContent = text;
  }

  private updateHere(): void {
    const name = placeName(this.world.areaAt(this.me.x, this.me.z));
    if (name === this.hereName) return;
    this.hereName = name;
    this.hereEl.textContent = name;
  }

  private updateZoomUi(): void {
    const z = this.cam.zoom;
    const text = z < 1.05 ? '1×' : `${z.toFixed(1)}×`;
    if (this.zoomEl.textContent !== text) this.zoomEl.textContent = text;
    this.zoomInBtn.disabled = this.cam.goalZoom >= UI.maxZoom - 1e-3;
    this.zoomOutBtn.disabled = this.cam.goalZoom <= 1 + 1e-3;
  }

  // ---------- the side panel ----------

  private showTab(places: boolean): void {
    if (places === this.placesOpen) return;
    this.placesOpen = places;
    this.legendTab.classList.toggle('on', !places);
    this.placesTab.classList.toggle('on', places);
    this.legendTab.setAttribute('aria-selected', String(!places));
    this.placesTab.setAttribute('aria-selected', String(places));
    this.legendPane.hidden = places;
    this.placesPane.hidden = !places;
    this.legendKey = null;
    if (places) {
      if (!this.places) this.buildPlaces();
      this.refreshPlaces(true);
    }
  }

  /** The legend: what this city has, with counts; a row lights its kind up on the map, a click hides or shows it. */
  private buildLegend(): HTMLElement {
    const counts = new Map<AreaKind, number>();
    let shortcuts = 0;
    for (const a of this.world.areas) {
      if (!shownOnMap(a)) continue;
      if (isShortcut(a)) shortcuts++;
      else counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    }
    const swatch = (kind: 'fill' | 'line' | 'dash' | 'ring' | 'icon', ink: string, fill?: string, ico?: IconNode) =>
      h('span', { class: `fullmap-sw ${kind}`, style: kind === 'fill' ? `background:${fill};border-color:${ink}` : kind === 'icon' ? `color:${ink}` : `border-color:${ink}` }, ico ? icon(ico, { size: 14 }) : null);
    const list = h('ul', { class: 'fullmap-rows' });
    let i = 0;
    const row = (key: LegendKey, sw: HTMLElement, label: string, count: string, action: 'toggle' | 'find' | 'fly'): void => {
      const state = action === 'toggle' ? h('span', { class: 'fullmap-state' }, icon(Eye, { size: 15, className: 'on' }), icon(EyeOff, { size: 15, className: 'off' })) : h('span', { class: 'fullmap-state' }, icon(action === 'find' ? LocateFixed : MapPinned, { size: 15, className: 'on' }));
      const b = h(
        'button',
        { class: 'fullmap-row-btn', type: 'button', title: action === 'toggle' ? `Show or hide ${label.toLowerCase()}` : action === 'find' ? 'Find me' : 'Show the waypoint', 'aria-pressed': action === 'toggle' ? 'true' : null },
        sw,
        h('span', { class: 'fullmap-label' }, label),
        h('span', { class: 'fullmap-num' }, count),
        state,
      );
      const li = h('li', { class: 'fullmap-row', 'data-key': key, style: `--i:${i++}` }, b);
      b.addEventListener('click', () => {
        if (action === 'find') this.findMe();
        else if (action === 'fly') this.flyToWaypoint();
        else this.toggleLayer(key, li, b);
      });
      b.addEventListener('pointerenter', () => (this.legendKey = key));
      b.addEventListener('pointerleave', () => this.legendKey === key && (this.legendKey = null));
      b.addEventListener('focus', () => (this.legendKey = key));
      b.addEventListener('blur', () => this.legendKey === key && (this.legendKey = null));
      this.rows.set(key, li);
      list.append(li);
    };
    row('you', swatch('icon', PALETTE.text, undefined, Navigation), 'You', '', 'find');
    row('waypoint', swatch('icon', INK.pin, undefined, MapPin), 'Waypoint', '', 'fly');
    if (this.route) row('route', swatch('line', PALETTE[this.routeInk]), this.routeLabel, '', 'toggle');
    if (shortcuts) row('shortcut', swatch('line', MAP_INK.shortcut), 'Race shortcuts', shortcuts > 1 ? String(shortcuts) : '', 'toggle');
    for (const k of LEGEND_ORDER) {
      const n = counts.get(k) ?? 0;
      const st = KINDS[k];
      if (!n || !st) continue;
      const sw = k === 'roundabout' ? swatch('ring', st.ink) : st.fill ? swatch('fill', st.ink, st.fill) : swatch(st.dash ? 'dash' : 'line', st.ink);
      // Infill is frontage filler: a count of it says nothing.
      row(k, sw, st.label, k === 'infill' || n < 2 ? '' : String(n), 'toggle');
    }
    return list;
  }

  private toggleLayer(key: LegendKey, li: HTMLElement, b: HTMLButtonElement): void {
    let on: boolean;
    if (key === 'route') on = this.showRoute = !this.showRoute;
    else if (key === 'shortcut') on = this.drawOpts.shortcuts = !this.drawOpts.shortcuts;
    else if (key === 'you' || key === 'waypoint') return;
    else {
      on = this.hidden.has(key);
      if (on) this.hidden.delete(key);
      else this.hidden.add(key);
    }
    li.classList.toggle('off', !on);
    b.setAttribute('aria-pressed', String(on));
    if (key !== 'route') this.overview.ok = this.detail.ok = false;
    this.hoverDirty = true;
    this.dirty = true;
  }

  private flyToWaypoint(): void {
    if (!this.wp) return;
    this.setFollow(false);
    this.cam.flyTo(this.wp.x, this.wp.z, Math.max(this.cam.goalZoom, UI.findZoom) * this.cam.fit.scale, this.reduced);
    this.dirty = true;
  }

  /** The Places tab: the notable places (and the drift zones), nearest first. */
  private buildPlaces(): void {
    const rows: PlaceRow[] = [];
    for (const a of this.world.areas) {
      if (!shownOnMap(a) || !(KINDS[a.kind]?.tag || this.driftAreas.has(a.id))) continue;
      const pts = a.polygon.length >= 3 ? a.polygon : a.path;
      if (!pts.length) continue;
      const span = polygonBounds(pts);
      const at = tagAnchor(this.world, a) ?? { x: (span.minX + span.maxX) / 2, z: (span.minZ + span.maxZ) / 2 };
      const ink = this.inkOf(a);
      const far = h('span', { class: 'fullmap-place-far' });
      const name = placeName(a);
      const drift = this.driftAreas.has(a.id);
      const note = drift ? 'Drift zone' : kindNote(name, KINDS[a.kind]?.label ?? '');
      const go = h(
        'button',
        { class: 'fullmap-place-btn', type: 'button', title: 'Show on the map' },
        h('i', { class: 'fullmap-dot', style: `--ink:${ink}` }),
        h('span', { class: 'fullmap-place-name' }, name, note ? h('small', { class: drift ? 'drift' : '' }, note) : null),
        far,
      );
      const li = h('li', { class: 'fullmap-place' }, go);
      const row: PlaceRow = { area: a, at, span, li, far, d: 0 };
      go.addEventListener('click', () => this.flyToPlace(row));
      go.addEventListener('pointerenter', () => this.hoverPlace(a));
      go.addEventListener('pointerleave', () => this.hoverPlace(null));
      if (this.opts.waypoint) {
        li.append(
          iconBtn(
            MapPin,
            'Set waypoint here',
            () => {
              this.setWaypoint(at);
              this.flyToPlace(row);
            },
            'small ghost fullmap-place-pin',
          ),
        );
      }
      rows.push(row);
    }
    this.places = rows;
    if (!rows.length) this.placesList.append(h('li', { class: 'fullmap-empty' }, 'No named places in this city.'));
  }

  private hoverPlace(a: Area | null): void {
    this.placeHover = a;
    this.dirty = true;
  }

  /** Distances from the player, and (on opening the tab) nearest first. */
  private refreshPlaces(sort: boolean): void {
    const rows = this.places;
    if (!rows) return;
    for (const r of rows) {
      const n = nearestOnArea(r.area, this.me.x, this.me.z, NEAR);
      r.d = n.d;
      const text = n.d < 10 ? 'You are here' : distanceLabel(n.x - this.me.x, n.z - this.me.z);
      if (r.far.textContent !== text) {
        r.far.textContent = text;
        r.far.classList.toggle('here', n.d < 10);
      }
    }
    if (!sort) return;
    rows.sort((a, b) => a.d - b.d);
    this.placesList.append(...rows.map((r) => r.li));
  }
}

const NEAR = { x: 0, z: 0, d: 0 };
/** Where the pin's drop (0..1) and landing ripple end, in drop lengths. */
const DROP_END = 1 + UI.ripple / UI.drop;
/** The player's two pings start this far apart (s), and a picked place's two rings. */
const PINGS = [0, UI.ping / 2] as const;
const PULSE_RINGS = [0, 0.45] as const;
const RECT = { x: 0, y: 0, w: 0, h: 0 };
const NO_DASH: number[] = [];
/** Scale bar lengths (m) it picks from. */
/** Scale bar lengths in round US units (ui/units.ts), shortest first. */
const SCALE_STEPS = [
  ...[50, 100, 250, 500, 1000].map((ft) => ({ m: ft * M_PER_FT, label: `${ft} ft` })),
  ...[0.25, 0.5, 1].map((mi) => ({ m: mi * M_PER_MI, label: `${mi} mi` })),
] as const;
/** Keys that pass through while the map is open: music (M, [ and ]), the dev panels and the function keys. */
const PASS_KEYS = /^(KeyM|BracketLeft|BracketRight|Backquote|F\d+)$/;
/** The waypoint pin (CSS px): its canvas, the tip's height in it, the head's center above the tip and its radius. */
const PIN = { w: 22, h: 30, tip: 27, head: 15, r: 7.5 } as const;

/** A map pin: a round head over a point at (x, tip), traced for filling and stroking. */
function pinPath(c: CanvasRenderingContext2D, x: number, tip: number, head: number, r: number): void {
  // The tangents from the tip to the head's circle meet it at pi/2 +- acos(r / head) from straight down.
  const a = Math.acos(r / head);
  c.beginPath();
  c.moveTo(x, tip);
  c.arc(x, tip - head, r, Math.PI / 2 + a, Math.PI / 2 - a + Math.PI * 2);
  c.closePath();
}

/** The compass rose in the map's corner: north in yellow (the map never turns, so it is static markup). */
const ROSE_SVG = `<svg viewBox="-26 -30 52 56" width="52" height="56">
<circle r="17" fill="rgba(25,24,26,0.8)" stroke="rgba(252,252,250,0.22)"/>
<circle r="12.5" fill="none" stroke="rgba(252,252,250,0.08)"/>
<path d="M0 -15 L4 0 L-4 0Z" fill="#ffd866"/><path d="M0 15 L4 0 L-4 0Z" fill="#727072"/>
<path d="M-13 0 L0 -2.6 L0 2.6Z M13 0 L0 -2.6 L0 2.6Z" fill="#5b595c"/>
<circle r="1.8" fill="#19181a"/>
<text y="-20.5" text-anchor="middle" font-size="10" font-weight="900" fill="#ffd866">N</text>
</svg>`;
