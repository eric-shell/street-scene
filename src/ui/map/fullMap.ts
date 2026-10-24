/**
 * Full city map: a modal over a paused race or free roam session (Tab, or a
 * click on the HUD minimap) or over the live menu city. A map to explore rather than a
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
 *
 * This class owns the state, the loop, the input and the order of drawing;
 * the parts beside it are course.ts (the options a caller passes and each race
 * type's course look), camera.ts (where the map looks and how it eases),
 * draw.ts (stateless painters and the cached city bitmaps), tags.ts (name tag
 * layout), tip.ts (the card's DOM), sidePanel.ts (the legend and the places)
 * and tuning.ts (numbers, inks and shared helpers).
 */
import type { World } from '../../city/world';
import type { Area, AreaKind } from '../../city/districts/types';
import { routeSample, type Route as RaceRoute, type RouteSample } from '../../city/route';
import { driftZones } from '../../sim/driftZones';
import type { Vec2 } from '../../sim/math';
import { CityLayers, KINDS, MAP_INK, layersOf, mapToWorld, mapX, mapY, nearestOnArea, shownOnMap, type CityDrawOptions, type MapView } from './cityMap';
import { btn, chip, h, iconBtn } from '../kit/dom';
import { Flag, Hash, Landmark, Layers, LocateFixed, MapIcon, MapPinOff, MapPinned, Maximize2, Route, X, ZoomIn, ZoomOut, icon } from '../kit/icons';
import type { MapCar } from '../hud/minimap';
import { PALETTE, rgba, type PaletteColor } from '../kit/palette';
import { CITY_NAME, bearingDeg, compassPoint, distanceLabel, placeName } from './places';
import { MapCamera } from './camera';
import { blit, cellName, covers, drawEdgeArrow, drawEdges, drawGrid, drawPlayer, drawRevealRing, lightPath, makeSprites, newRaster, offView, worldTransform, type Raster, type Sprites } from './draw';
import { buildLegend, buildPlaces, type PlaceRow } from './sidePanel';
import { NameTags } from './tags';
import { MapTip } from './tip';
import type { FullMapOptions } from './course';
import { DROP_END, INK, NO_DASH, PASS_KEYS, PIN, PULSE_RINGS, ROSE_SVG, UI, bounceOut, clamp01, easeOut, inkOf, isShortcut, kindNote, type LegendKey } from './tuning';

export { courseFor } from './course';
export type { FullMapOptions, WaypointStore } from './course';

const TMP: Vec2 = { x: 0, z: 0 };

/** What the pointer is over. */
type Hover = { kind: 'area'; area: Area | null } | { kind: 'me' } | { kind: 'pin' } | { kind: 'mark'; finish: boolean };

/**
 * Open the city map over `parent`: the one way every screen opens it (a race's
 * or free roam's minimap and Tab, the menu's event card and its race step's
 * course map), so it looks and works the same everywhere and an enrichment lands in
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
  // The card by the pointer.
  private readonly tip: MapTip;
  /** A tap's card stays put (touch); it can set the waypoint from its button. */
  private pinned: { x: number; y: number; wx: number; wz: number; hover: Hover } | null = null;
  // Side panel.
  private readonly legendTab: HTMLButtonElement;
  private readonly placesTab: HTMLButtonElement;
  private readonly legendPane: HTMLElement;
  private readonly placesPane: HTMLElement;
  private readonly placesList: HTMLUListElement;
  private readonly rows: Map<LegendKey, HTMLLIElement>;
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
  private readonly names: NameTags;
  private readonly kindPaths = new Map<AreaKind | 'shortcut', Path2D>();
  private readonly driftAreas: Set<number>;
  /** The course drawn (none for free roam's whole city), its color and its name in the legend and cards. */
  private readonly route: RaceRoute | null;
  private readonly routeInk: PaletteColor;
  private readonly routeLabel: string;
  private readonly zonePaths: Path2D | null;
  private readonly start: RouteSample | null;
  private readonly finish: RouteSample | null;
  private sprites: Sprites | null = null;
  private bands: { top: CanvasGradient; left: CanvasGradient } | null = null;
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
    this.names = new NameTags(world);

    this.canvas = h('canvas', { class: 'full-map__canvas', role: 'img', 'aria-label': 'City map' });
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.rose = h('div', { class: 'full-map__rose', 'aria-hidden': 'true', html: ROSE_SVG });
    this.zoomInBtn = iconBtn(ZoomIn, 'Zoom in (+)', () => this.zoomBy(UI.step));
    this.zoomOutBtn = iconBtn(ZoomOut, 'Zoom out (-)', () => this.zoomBy(1 / UI.step));
    this.findBtn = iconBtn(LocateFixed, 'Find me (C)', () => this.findMe());
    this.zoomEl = h('span', { class: 'full-map__zoom', 'aria-hidden': 'true' }, '1×');
    this.tools = h('div', { class: 'full-map__tools' }, this.zoomInBtn, this.zoomEl, this.zoomOutBtn, h('i', { class: 'full-map__tools-gap' }), this.findBtn, iconBtn(Maximize2, 'Whole city (F)', () => this.fitAll()));
    this.tip = new MapTip(() => this.tipAction());
    this.stage = h(
      'div',
      { class: 'full-map__stage', tabindex: '-1' },
      this.canvas,
      h('i', { class: 'full-map__vignette' }),
      h('i', { class: 'full-map__corner full-map__corner--top-left' }),
      h('i', { class: 'full-map__corner full-map__corner--bottom-right' }),
      this.rose,
      this.tools,
      this.tip.el,
    );
    // Side panel: the legend and the places, under tabs.
    const legend = buildLegend(world, route ? { ink: PALETTE[this.routeInk], label: this.routeLabel } : null, {
      find: () => this.findMe(),
      flyToWaypoint: () => this.flyToWaypoint(),
      toggle: (key, li, b) => this.toggleLayer(key, li, b),
      hover: (key, on) => {
        if (on) this.legendKey = key;
        else if (this.legendKey === key) this.legendKey = null;
      },
    });
    this.rows = legend.rows;
    this.legendPane = h('div', { class: 'map-side__pane', role: 'tabpanel' }, legend.list);
    this.placesList = h('ul', { class: 'map-places' });
    this.placesPane = h('div', { class: 'map-side__pane', role: 'tabpanel', hidden: true }, this.placesList);
    this.legendTab = h('button', { class: 'tabs__tab is-selected', type: 'button', role: 'tab', 'aria-selected': 'true' }, icon(Layers, { size: 15 }), 'Legend');
    this.placesTab = h('button', { class: 'tabs__tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, icon(Landmark, { size: 15 }), 'Places');
    this.legendTab.addEventListener('click', () => this.showTab(false));
    this.placesTab.addEventListener('click', () => this.showTab(true));
    this.wpFar = h('span', { class: 'map-waypoint__distance' });
    this.wpCard = h(
      'div',
      { class: 'map-waypoint', hidden: true },
      h('span', { class: 'map-waypoint__icon' }, icon(MapPinned, { size: 18 })),
      h('span', { class: 'map-waypoint__text' }, h('b', { class: 'map-waypoint__title' }, 'Waypoint'), this.wpFar),
      btn(MapPinOff, 'Clear', () => this.setWaypoint(null), '--small map-waypoint__clear'),
    );
    const side = h('aside', { class: 'map-side' }, h('div', { class: 'tabs map-side__tabs', role: 'tablist' }, this.legendTab, this.placesTab), this.legendPane, this.placesPane, this.wpCard);
    // Header and footer.
    this.hereEl = h('b', { class: 'full-map__here' });
    const chips: HTMLElement[] = [];
    if (opts.event) chips.push(chip(opts.event, Flag, '--accent full-map__chip'));
    if (opts.seed) chips.push(chip(opts.seed, Hash, 'full-map__chip full-map__chip--seed'));
    // The course shown, in its race type's color (the race step opens the map on the type it has picked).
    if (opts.course) {
      const c = chip(opts.course.label, Route, '--ink full-map__chip full-map__chip--course');
      c.style.setProperty('--ink', PALETTE[opts.course.ink]);
      chips.push(c);
    }
    const head = h(
      'header',
      { class: 'full-map__top' },
      h('h2', { class: 'title full-map__title' }, icon(MapIcon, { size: 22 }), h('span', {}, CITY_NAME)),
      ...chips,
      h('span', { class: 'full-map__where' }, h('span', { class: 'full-map__where-prefix' }, 'You are in '), this.hereEl),
      iconBtn(X, 'Close map (Esc)', () => opts.onClose(), 'full-map__close'),
    );
    const key = (caps: string[], label: string) => h('span', { class: 'full-map__key' }, ...caps.map((k) => h('kbd', {}, k)), h('span', {}, label));
    const foot = h(
      'footer',
      { class: 'full-map__footer' },
      h(
        'div',
        { class: 'full-map__hints' },
        key(['Scroll'], 'Zoom'),
        key(['Drag'], 'Pan'),
        opts.waypoint ? key(['Click'], 'Waypoint') : key(['Dbl click'], 'Zoom in'),
        key(['F'], 'Whole city'),
        key(['C'], 'Find me'),
        key(['Tab', 'Esc'], 'Close'),
      ),
      h('div', { class: 'full-map__hints full-map__hints--touch' }, key(['Pinch'], 'Zoom'), key(['Drag'], 'Pan'), key(['Tap'], opts.waypoint ? 'A place or a waypoint' : 'A place')),
    );
    this.panel = h('div', { class: 'panel full-map__panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'City map' }, head, h('div', { class: 'full-map__main' }, this.stage, side), foot);
    this.root = h('div', { class: 'screen screen--center screen--dim full-map' }, this.panel);
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
    document.body.classList.add('is-map-open');
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
    document.body.classList.remove('is-map-open');
    if (this.focusBack instanceof HTMLElement && this.focusBack.isConnected) this.focusBack.focus({ preventScroll: true });
    // A short fade out (the owner has already moved on, so it takes no input).
    if (this.reduced) this.root.remove();
    else {
      this.root.classList.add('is-closing');
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
    this.names.remeasure();
    const f = this.font;
    f.tag = `700 ${11 * dpr}px ${INK.font}`;
    f.minor = `600 ${10 * dpr}px ${INK.font}`;
    f.you = `800 ${10 * dpr}px ${INK.font}`;
    f.grid = `700 ${10 * dpr}px ${INK.font}`;
    f.scale = `700 ${11 * dpr}px ${INK.font}`;
    [this.rose, this.tools].forEach((el, i) => this.furniture.set([el.offsetLeft * dpr, el.offsetTop * dpr, (el.offsetLeft + el.offsetWidth) * dpr, (el.offsetTop + el.offsetHeight) * dpr], i * 4));
    const c = this.ctx;
    const top = c.createLinearGradient(0, 0, 0, 24 * dpr);
    const left = c.createLinearGradient(0, 0, 24 * dpr, 0);
    for (const g of [top, left]) {
      g.addColorStop(0, INK.band);
      g.addColorStop(1, 'rgba(25, 24, 26, 0)');
    }
    this.bands = { top, left };
    if (!this.sprites || this.sprites.dpr !== dpr) this.sprites = makeSprites(dpr, PALETTE[this.routeInk], this.route?.closed === false, !!this.finish);
    this.tip.remeasure();
    this.updateZoomUi();
    this.dirty = true;
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
    drawGrid(c, v, this.world.graph.bounds, this.dpr);
    this.drawHighlights(c, v);
    if (this.showRoute) this.drawRoute(c, v);
    this.drawTags(c, v, mx, my);
    if (this.showRoute) this.drawMarks(c, v);
    this.drawWaypoint(c, v);
    if (revealing) {
      c.restore();
      drawRevealRing(c, mx, my, radius, u, this.dpr);
    }
    // Zoomed in, what is off the view still shows where it is: an arrow on the edge.
    if (offView(v, mx, my, this.dpr)) drawEdgeArrow(c, v, mx, my, INK.player, this.dpr);
    else drawPlayer(c, mx, my, { yaw: this.me.yaw, dpr: this.dpr, time: this.time, lit: this.legendShown === 'you' ? this.legendAmt : 0, reduced: this.reduced, font: this.font.you });
    if (this.wp) {
      const wx = mapX(v, this.wp.x);
      const wy = mapY(v, this.wp.z);
      if (offView(v, wx, wy, this.dpr)) drawEdgeArrow(c, v, wx, wy, INK.pin, this.dpr);
    }
    drawEdges(c, v, this.world.graph.bounds, this.dpr, this.font, this.bands);
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
    const stale = !d.ok || !covers(d, v) || k > UI.rasterDrift || k < 1 / UI.rasterDrift;
    // While moving: redraw when the bitmap falls short, at most every rasterGap; once settled, redraw for the exact view.
    if ((stale && this.time - d.at >= UI.rasterGap) || (!this.camMoving && !exact)) {
      const m = Math.round(Math.max(v.w, v.h) * UI.margin);
      this.rasterize(d, v.cx, v.cz, v.scale, v.w + 2 * m, v.h + 2 * m);
    }
    if (!covers(d, v)) blit(c, ov, v);
    blit(c, d, v);
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
        worldTransform(c, v);
        lightPath(c, this.kindPath(key), ink, key === 'shortcut' ? undefined : KINDS[key]?.fill, this.legendAmt, px, true);
      }
    }
    const lit = this.placeHover ?? this.hoverArea;
    if (lit && (this.placeHover || this.hoverAmt > 0.003) && !this.hidden.has(lit.kind)) {
      worldTransform(c, v);
      lightPath(c, this.layers.areaPath(lit), inkOf(lit), KINDS[lit.kind]?.fill, this.placeHover ? 1 : this.hoverAmt, px, lit.polygon.length >= 3);
    }
    const p = this.pulse;
    if (p) {
      const path = this.layers.areaPath(p.area);
      const ink = inkOf(p.area);
      worldTransform(c, v);
      const fadeOut = 1 - clamp01((p.t - (UI.pulse - 0.4)) / 0.4);
      lightPath(c, path, ink, KINDS[p.area.kind]?.fill, fadeOut, px, p.area.polygon.length >= 3);
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

  /** Every shown area of a legend kind as one path (the race shortcuts are their own). */
  private kindPath(key: AreaKind | 'shortcut'): Path2D {
    let p = this.kindPaths.get(key);
    if (!p) {
      p = new Path2D();
      for (const a of this.world.areas) {
        if (!shownOnMap(a) || (key === 'shortcut' ? !isShortcut(a) : a.kind !== key || (key === 'backAlley' && isShortcut(a)))) continue;
        p.addPath(this.layers.areaPath(a));
      }
      this.kindPaths.set(key, p);
    }
    return p;
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

  // ---------- name tags ----------

  /** The tags, kept clear of the player and its label, the markers and the furniture over the canvas. */
  private drawTags(c: CanvasRenderingContext2D, v: MapView, mx: number, my: number): void {
    const dpr = this.dpr;
    const t = this.names;
    t.clear();
    t.reserve(mx - 18 * dpr, my - 18 * dpr, mx + 18 * dpr, my + 30 * dpr);
    if (this.wp) {
      const px = mapX(v, this.wp.x);
      const py = mapY(v, this.wp.z);
      t.reserve(px - 12 * dpr, py - 30 * dpr, px + 12 * dpr, py + 4 * dpr);
    }
    if (this.showRoute && this.start) {
      const r = 11 * dpr;
      for (const p of this.finish ? [this.start, this.finish] : [this.start]) {
        const x = mapX(v, p.x);
        const y = mapY(v, p.z);
        t.reserve(x - r, y - r, x + r, y + r);
      }
    }
    const F = this.furniture;
    t.reserve(F[0], F[1], F[2], F[3]);
    t.reserve(F[4], F[5], F[6], F[7]);
    t.reserve(0, v.h - 44 * dpr, 150 * dpr, v.h);
    const fade = this.reduced ? 1 : 1 - Math.exp(-UI.tagFade * (this.time - this.tagTime));
    this.tagTime = this.time;
    t.draw(c, v, { dpr, zoom: this.cam.zoom, font: this.font, hidden: this.hidden, shortcuts: !!this.drawOpts.shortcuts, lit: this.legendShown, litAmt: this.legendAmt, fade });
  }

  // ---------- hover and the card ----------

  /** What is under the pointer (or the pinned tap), the area to light, and the card. */
  private updateHover(): void {
    this.hoverDirty = false;
    const show = this.pinned ?? (this.ptr.in && !this.press?.moved && !this.cam.held ? this.ptr : null);
    if (!show) {
      this.setHover({ kind: 'area', area: null }, null);
      this.tip.hide();
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
    this.tip.place(show.x, show.y, this.cam.view.w / this.dpr, this.cam.view.h / this.dpr);
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
      name = area && isShortcut(area) ? (area.params.jumpExit ? 'One-way shortcut' : 'Race shortcut') : placeName(area);
      ink = inkOf(area);
      kind = area ? kindNote(name, isShortcut(area) ? 'Race shortcuts' : (KINDS[area.kind]?.label ?? '')) : '';
    }
    const dx = at.x - this.me.x;
    const dz = at.z - this.me.z;
    if (!far) {
      far = distanceLabel(dx, dz);
      bearing = bearingDeg(dx, dz);
    }
    const cell = cellName(this.world.graph.bounds, at.x, at.z);
    const drift = !!area && this.driftAreas.has(area.id);
    const short = !!area && isShortcut(area);
    const here = !!area && hv.kind === 'area' && this.world.areaAt(this.me.x, this.me.z) === area;
    const pinned = !!this.pinned;
    const canSet = !!this.opts.waypoint;
    const act = pinned ? '' : hv.kind === 'me' ? 'Click to center the map on you' : !canSet ? '' : hv.kind === 'pin' ? 'Click to clear the waypoint' : 'Click to drop a waypoint here';
    const btnLabel = !canSet || !pinned || hv.kind === 'me' ? '' : hv.kind === 'pin' ? 'Clear waypoint' : 'Set waypoint';
    this.tip.show({ name, ink, kind, far, bearing, cell, drift, short, here, act, button: btnLabel, pinned });
  }

  /** The card's button (touch): set the waypoint where the tap was, or clear it. */
  private tipAction(): void {
    const p = this.pinned;
    if (!p) return;
    this.pinned = null;
    if (p.hover.kind === 'pin') this.setWaypoint(null);
    else this.setWaypoint({ x: p.wx, z: p.wz });
    this.tip.hide();
    this.hoverDirty = true;
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
      this.tip.hide();
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
      this.tip.hide();
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
    this.findBtn.classList.toggle('is-active', on);
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
    this.tip.invalidate();
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
    const num = this.rows.get('waypoint')?.querySelector('.map-legend__count');
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
    this.legendTab.classList.toggle('is-selected', !places);
    this.placesTab.classList.toggle('is-selected', places);
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
    li.classList.toggle('is-off', !on);
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

  /** The Places tab: the notable places (and the drift zones), sorted nearest first when it opens. */
  private buildPlaces(): void {
    const rows = (this.places = buildPlaces(this.world, this.driftAreas, {
      fly: (r) => this.flyToPlace(r),
      hover: (a) => this.hoverPlace(a),
      setWaypoint: this.opts.waypoint ? (at) => this.setWaypoint(at) : undefined,
    }));
    if (!rows.length) this.placesList.append(h('li', { class: 'map-places__empty' }, 'No named places in this city.'));
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
        r.far.classList.toggle('is-here', n.d < 10);
      }
    }
    if (!sort) return;
    rows.sort((a, b) => a.d - b.d);
    this.placesList.append(...rows.map((r) => r.li));
  }
}

const NEAR = { x: 0, z: 0, d: 0 };
