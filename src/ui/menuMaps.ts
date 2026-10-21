/**
 * The main menu's maps of the event city, both drawn from the shared city
 * layers (ui/cityMap.ts) so they read like the full map and the minimap, and
 * both the same model: the whole city tilted like a model on a table, turning
 * slowly, with the cruising car's live position on it (a heading arrow over a
 * radar ping) and the event's signature district breathing (the river for
 * River Run, the roundabouts for Ring Rush ...). Going from home to the race
 * step keeps the same city at the same angle; only the course arrives.
 *  - CityOverview: the home card's map, the table on its own. It says where
 *    tonight's event is without saying which race. A click opens the full map.
 *  - CourseMap: the race step's map, the same table zoomed in on the picked
 *    race type's course, drawn on the plane in its color: the circuit's lap
 *    from the start line, the sprint from A to B, the drift lap with its
 *    zones; free roam zooms back out to the whole city and lights every
 *    street outward from the car. The signature district breathes quieter
 *    there so the course is the brightest thing. Switching types fades the
 *    old course out, zooms to the new one and draws it on; a pulse of light
 *    then runs the course in its driving direction.
 * The city is rasterized once per map (again when the box resizes, and at
 * both ends of a zoom); the markers and courses are DOM and SVG over it, so
 * CSS does the tilt, the turn, the drawing on, the fades and the pulses. Per
 * frame only the car marker moves (one transform), and the city raster while
 * a zoom runs (one more). Render only.
 */
import type { World } from '../city/world';
import type { AreaKind } from '../city/districts/types';
import type { EventFlavourId } from '../city/events';
import { routeSample, type Route } from '../city/route';
import { driftZones } from '../sim/driftZones';
import type { Vec2 } from '../sim/math';
import { fitCity, layersOf, mapHeading, mapX, mapY, type CityLayers, type MapView } from './cityMap';
import { h, sheen } from './dom';
import { Flag, FlagTriangleRight, MapIcon, icon } from './icons';
import { PALETTE } from './palette';
import type { RaceType } from './settings';

/** The car the maps follow: position (m) and heading (rad, forward = (sin, cos)). */
export interface MapPose {
  x: number;
  z: number;
  yaw: number;
}

/** The event's signature districts, which breathe on the overview. */
const SIGNATURE: Record<EventFlavourId, AreaKind | null> = {
  hillClimb: 'hills',
  riverRun: 'river',
  alleySprint: 'alley',
  underTheEl: 'subway',
  ringRush: 'roundabout',
  grandTour: 'monument',
  downtownDash: null,
};

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const dprOf = () => Math.min(2, window.devicePixelRatio || 1);

/**
 * A car marker: a heading arrow over a ping, moved with one transform per frame
 * and only when it has moved enough to show.
 */
class CarMarker {
  readonly el = h('span', { class: 'map-car', 'aria-hidden': 'true' }, h('i', { class: 'map-ping' }), h('i', { class: 'map-ping late' }), h('i', { class: 'map-arrow' }));
  private x = NaN;
  private y = NaN;
  private a = NaN;

  place(x: number, y: number, a: number): void {
    if (Math.abs(x - this.x) < 0.25 && Math.abs(y - this.y) < 0.25 && Math.abs(a - this.a) < 0.01) return;
    this.x = x;
    this.y = y;
    this.a = a;
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${a.toFixed(3)}rad)`;
  }
}

/** The waypoint free roam will steer to: a pin, hidden while there is none. */
class PinMarker {
  readonly el = h('span', { class: 'map-pin', 'aria-hidden': 'true' }, h('i'));
  private key = '';

  place(x: number | null, y = 0): void {
    const key = x === null ? 'off' : `${x.toFixed(1)},${y.toFixed(1)}`;
    if (key === this.key) return;
    this.key = key;
    this.el.classList.toggle('on', x !== null);
    if (x !== null) this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

/** The turn's period (s): `ov-turn` in ui.css, 34 s each way. */
const TURN_S = 68;

/** A world rectangle (m) the table frames: a course and what it needs around it. */
export interface Frame {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Framing a course: the share of the plane it may fill (its corners stay in the
 * well through the whole turn, near edge magnified), and the most it may zoom
 * past the whole city, so a short sprint still shows the streets around it.
 */
const FOCUS = { fill: 0.62, maxZoom: 3.2, seconds: 0.75 } as const;

/** What the course map lays on the table: an overlay on the plane under the markers, redrawn with the city. */
interface TableLayer {
  el: Element;
  /** The table settled on this plane view (CSS px): first layout, a resize, or the end of a zoom; `animate` draws on. */
  drawn(view: MapView, animate: boolean): void;
}

/** The world rectangle a view shows (m). */
function visible(v: MapView): Frame {
  const hx = v.w / 2 / v.scale;
  const hz = v.h / 2 / v.scale;
  return { minX: v.cx - hx, maxX: v.cx + hx, minZ: v.cz - hz, maxZ: v.cz + hz };
}

/** The view of a w x h box that fits a world rectangle, `fill` of the box. */
function frameView(f: Frame, w: number, hgt: number, fill = 1): MapView {
  const scale = Math.min((w * fill) / Math.max(1, f.maxX - f.minX), (hgt * fill) / Math.max(1, f.maxZ - f.minZ));
  return { cx: (f.minX + f.maxX) / 2, cz: (f.minZ + f.maxZ) / 2, scale, w, h: hgt };
}

/** The views between two, at t in [0, 1]: the center glides, the scale moves in ratio, so a zoom feels even. */
function lerpView(a: MapView, b: MapView, t: number): MapView {
  return { cx: a.cx + (b.cx - a.cx) * t, cz: a.cz + (b.cz - a.cz) * t, scale: a.scale * Math.pow(b.scale / a.scale, t), w: b.w, h: b.h };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * The tilted city with the cruising car on it: the home card's map, and the
 * table the race step's course lies on. The table can frame part of the city
 * (focus): the zoom moves the city raster with one transform per frame, from a
 * raster wide enough to hold both ends, and redraws it crisp in the new view
 * when it lands; only then does the layer (the course) draw on.
 */
export class CityOverview {
  readonly el: HTMLElement;
  private readonly plane: HTMLElement;
  private readonly zoom: HTMLElement;
  private readonly base: HTMLCanvasElement;
  private readonly glow: HTMLCanvasElement;
  private readonly car = new CarMarker();
  private readonly pin = new PinMarker();
  private readonly layers: CityLayers;
  /** The plane's view in CSS px as shown right now, for the markers and any layer. */
  private view: MapView | null = null;
  /** The view the canvases were last drawn in (CSS px). */
  private raster: MapView | null = null;
  /** What the table frames; null is the whole city. */
  private frame: Frame | null = null;
  private zooming: { from: MapView; to: MapView; t0: number } | null = null;
  private readonly ro: ResizeObserver;

  constructor(
    private readonly world: World,
    private readonly layer?: TableLayer,
  ) {
    this.layers = layersOf(world);
    this.base = h('canvas', { class: 'ov-base' });
    this.glow = h('canvas', { class: 'ov-glow' });
    // The plane tilts (and flattens on hover); the map turns slowly on it, so each is one transform. The
    // city zooms inside a lens that fades it toward the table's edge; what lies on it stays sharp.
    // Spans: the overview sits inside the event card's map button, where only phrasing content belongs.
    this.zoom = h('span', { class: 'ov-zoom' }, this.base, this.glow);
    this.plane = h('span', { class: 'ov-spin' }, h('span', { class: 'ov-lens' }, this.zoom), ...(layer ? [layer.el] : []), this.pin.el, this.car.el);
    // Every table turns on one clock, so the race step's map picks up the home map's angle where it left off.
    this.plane.style.animationDelay = `${-((performance.now() / 1000) % TURN_S).toFixed(2)}s`;
    this.el = h('span', { class: 'city-overview', 'aria-hidden': 'true' }, h('span', { class: 'ov-stage' }, h('span', { class: 'ov-plane' }, this.plane)), h('i', { class: 'ov-scan' }));
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  /** The view that frames `f` (or the whole city) on a w x h plane. */
  private viewFor(f: Frame | null, w: number, hgt: number): MapView {
    const city = fitCity(this.world, w, hgt, 30);
    if (!f) return city;
    const v = frameView(f, w, hgt, FOCUS.fill);
    return { ...v, scale: Math.min(Math.max(v.scale, city.scale), city.scale * FOCUS.maxZoom) };
  }

  /**
   * Frame part of the city, or the whole city with null. `animate` zooms there
   * and draws the layer on when it lands; otherwise the table cuts to it.
   */
  focus(f: Frame | null, animate = true): void {
    this.frame = f;
    const from = this.view;
    if (!from) return; // The first layout frames it.
    const to = this.viewFor(f, from.w, from.h);
    const still = Math.abs(to.scale / from.scale - 1) < 0.01 && Math.hypot(to.cx - from.cx, to.cz - from.cz) * to.scale < 1;
    if (!animate || still || reducedMotion()) this.settle(to, animate);
    else this.zoomFrom(from, to);
  }

  /** Rasterize the city for the plane's current size (on first layout and resizes). */
  private draw(): void {
    const w = this.plane.clientWidth;
    const hgt = this.plane.clientHeight;
    if (w < 8 || hgt < 8) return;
    // Tilted, the near edge shows larger than laid out: render with headroom so it stays crisp.
    const k = dprOf() * 1.4;
    for (const c of [this.base, this.glow]) {
      c.width = Math.round(w * k);
      c.height = Math.round(hgt * k);
    }
    const first = !this.view;
    const to = this.viewFor(this.frame, w, hgt);
    // A first layout on a course zooms in from the whole city, the home card's view, so the race step opens on it.
    if (first && this.frame && !reducedMotion()) this.zoomFrom(this.viewFor(null, w, hgt), to);
    else this.settle(to, first);
  }

  /** Start a zoom: the canvases hold both ends, and update() moves them until it lands. */
  private zoomFrom(from: MapView, to: MapView): void {
    const a = visible(from);
    const b = visible(to);
    this.rasterize(frameView({ minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ) }, to.w, to.h));
    this.zooming = { from, to, t0: performance.now() };
    this.show(from);
  }

  /** Land on a view: the city drawn crisp in it, the layer laid over it. */
  private settle(v: MapView, animate: boolean): void {
    this.zooming = null;
    this.rasterize(v);
    this.show(v);
    this.layer?.drawn(v, animate);
  }

  /** Show the canvases' raster as the given view: one transform on the zoom layer. */
  private show(v: MapView): void {
    this.view = v;
    const r = this.raster!;
    const k = v.scale / r.scale;
    if (Math.abs(k - 1) < 1e-4 && r.cx === v.cx && r.cz === v.cz) {
      this.zoom.style.transform = '';
      return;
    }
    // mapX(v, x) = k * mapX(r, x) + tx, and the same down the page.
    const tx = (v.w / 2) * (1 - k) - (r.cx - v.cx) * v.scale;
    const ty = (v.h / 2) * (1 - k) - (r.cz - v.cz) * v.scale;
    this.zoom.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${k.toFixed(4)})`;
  }

  /** Draw the city and the signature district into the canvases in a view (CSS px). */
  private rasterize(v: MapView): void {
    this.raster = v;
    const k = this.base.width / v.w;
    const view = { ...v, scale: v.scale * k, w: this.base.width, h: this.base.height };
    const c = this.base.getContext('2d')!;
    c.clearRect(0, 0, this.base.width, this.base.height);
    this.layers.draw(c, view, { dpr: k, ground: false, route: false, minStreet: 1.1, ink: { block: 'rgba(64, 62, 65, 0.55)', building: 'rgba(96, 92, 100, 0.5)', road: 'rgba(147, 146, 150, 0.85)' } });
    this.drawSignature(this.glow.getContext('2d')!, view, k);
  }

  /** The event's own district, bright, on the layer that breathes. */
  private drawSignature(c: CanvasRenderingContext2D, view: MapView, dpr: number): void {
    c.clearRect(0, 0, this.glow.width, this.glow.height);
    const kind = this.world.event ? SIGNATURE[this.world.event.id] : null;
    if (!kind) return;
    const s = view.scale;
    const px = dpr / s;
    c.save();
    c.setTransform(-s, 0, 0, -s, view.w / 2 + view.cx * s, view.h / 2 + view.cz * s);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const g = this.world.graph;
    const ink = kind === 'river' || kind === 'subway' ? PALETTE.cyan : kind === 'alley' ? PALETTE.purple : kind === 'hills' ? PALETTE.soft : kind === 'monument' ? PALETTE.yellow : PALETTE.orange;
    c.strokeStyle = ink;
    c.fillStyle = ink;
    for (const a of this.world.areas) {
      if (a.kind !== kind) continue;
      if (kind === 'roundabout') {
        c.lineWidth = 3 * px;
        c.beginPath();
        c.arc(a.params.x, a.params.z, a.params.outer, 0, Math.PI * 2);
        c.stroke();
      } else if (kind === 'alley') {
        c.lineWidth = Math.max(4, 2.5 * px);
        c.beginPath();
        for (const id of a.edges) {
          const e = g.edges[id];
          if (!e) continue;
          c.moveTo(g.nodes[e.a].x, g.nodes[e.a].z);
          c.lineTo(g.nodes[e.b].x, g.nodes[e.b].z);
        }
        c.stroke();
      } else if (kind === 'subway') {
        c.lineWidth = 3.5 * px;
        c.stroke(this.layers.areaPath(a));
      } else {
        c.globalAlpha = 0.45;
        c.fill(this.layers.areaPath(a));
        c.globalAlpha = 1;
        c.lineWidth = 2 * px;
        c.stroke(this.layers.areaPath(a));
      }
    }
    c.restore();
  }

  /** Step a zoom, and move the car marker to the cruising car and the pin to the waypoint (every frame the menu shows). */
  update(p: MapPose, wp: Vec2 | null = null): void {
    const z = this.zooming;
    if (z) {
      const t = Math.min(1, (performance.now() - z.t0) / (FOCUS.seconds * 1000));
      if (t < 1) this.show(lerpView(z.from, z.to, easeInOut(t)));
      else this.settle(z.to, true);
    }
    const v = this.view;
    if (!v) return;
    const x = mapX(v, p.x);
    const y = mapY(v, p.z);
    this.car.place(x, y, mapHeading(p.yaw));
    // Zoomed in on a course, the car can be off the table: it fades rather than floating over the well.
    this.car.el.classList.toggle('off', x < 0 || y < 0 || x > v.w || y > v.h);
    this.pin.place(wp && mapX(v, wp.x), wp ? mapY(v, wp.z) : 0);
  }

  dispose(): void {
    this.ro.disconnect();
  }
}

/** The courses the race step can show. */
export interface CourseRoutes {
  circuit: Route;
  sprint: Route;
}

/** How long the outgoing course takes to fade (ms; matches `.course.leave` in ui.css). */
const LEAVE_MS = 260;

let maskIds = 0;

/** The race step's map: the home card's table with the picked type's course drawn on the plane. */
export class CourseMap {
  readonly el: HTMLElement;
  private readonly table: CityOverview;
  private readonly overlay: SVGSVGElement;
  /** The plane's view in CSS px (the table's), once it has been laid out. */
  private view: MapView | null = null;
  private type: RaceType | null = null;
  private course: SVGGElement | null = null;
  private lastPose: MapPose | null = null;

  /** `onOpen`: the map is a button that opens the full city map on this course. */
  constructor(
    private readonly world: World,
    private readonly routes: CourseRoutes,
    onOpen?: () => void,
  ) {
    this.overlay = svg('svg', { class: 'course-svg', 'aria-hidden': 'true' });
    this.table = new CityOverview(world, { el: this.overlay, drawn: (view, animate) => this.drawn(view, animate) });
    // The arrow on the table is the car on screen, as on the home card.
    this.el = h('div', { class: 'course-map' }, this.table.el, h('span', { class: 'event-map-live' }, h('i'), 'Live'));
    if (onOpen) {
      this.el.classList.add('opens');
      this.el.setAttribute('role', 'button');
      this.el.setAttribute('tabindex', '0');
      this.el.setAttribute('aria-label', 'Open the city map on this course');
      this.el.title = 'Open the city map on this course';
      this.el.append(h('span', { class: 'event-map-hint' }, icon(MapIcon, { size: 13 }), 'City map'), sheen());
      this.el.addEventListener('click', onOpen);
      this.el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      });
    }
  }

  /**
   * Show a race type's course; `animate` fades the old one out, zooms to the
   * new one and draws it on (a type change), otherwise the map cuts to it.
   */
  show(type: RaceType, animate = true): void {
    if (type === this.type) return;
    this.type = type;
    this.el.dataset.mode = type;
    const old = this.course;
    this.course = null;
    if (old) {
      if (animate) {
        old.classList.add('leave');
        setTimeout(() => old.remove(), LEAVE_MS);
      } else old.remove();
    }
    // The table calls drawn() when it lands on the frame, at once without a zoom.
    this.table.focus(this.frameOf(type), animate);
  }

  /** What a type frames: its course with the start and finish discs clear of it, the zones too for drift; free roam the whole city. */
  private frameOf(type: RaceType): Frame | null {
    if (type === 'roam') return null;
    const pts: Vec2[] = coursePoints(type === 'sprint' ? this.routes.sprint : this.routes.circuit);
    if (type === 'drift') for (const z of driftZones(this.world)) pts.push(...z.polygon);
    const f: Frame = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const p of pts) {
      f.minX = Math.min(f.minX, p.x);
      f.maxX = Math.max(f.maxX, p.x);
      f.minZ = Math.min(f.minZ, p.z);
      f.maxZ = Math.max(f.maxZ, p.z);
    }
    return f;
  }

  /** The table landed on a view (first layout, a resize, the end of a zoom): lay the course over it. */
  private drawn(view: MapView, animate: boolean): void {
    this.view = view;
    this.overlay.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
    if (this.type) {
      this.course?.remove();
      this.course = this.build(this.type, animate);
      this.overlay.append(this.course);
    }
  }

  /** The SVG of one type's course in the current view. */
  private build(type: RaceType, animate: boolean): SVGGElement {
    const v = this.view!;
    const g = svg('g', { class: `course mode-${type}${animate ? ' enter' : ''}` });
    const pt = (p: Vec2) => `${mapX(v, p.x).toFixed(1)} ${mapY(v, p.z).toFixed(1)}`;
    const d = (pts: readonly Vec2[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${pt(p)}`).join('');
    if (type === 'roam') {
      // Every street, lit outward from the car like a city waking up.
      const gr = this.world.graph;
      let streets = '';
      for (const e of gr.edges) streets += `M${pt(gr.nodes[e.a])}L${pt(gr.nodes[e.b])}`;
      const id = `course-reveal-${++maskIds}`;
      const from = this.lastPose ?? routeSample(this.routes.circuit, this.routes.circuit.startS);
      // The mask's circle reaches every corner from the car; CSS grows it from nothing.
      const r = Math.hypot(v.w, v.h);
      const mask = svg('mask', { id });
      mask.append(svg('circle', { class: 'reveal', cx: mapX(v, from.x).toFixed(1), cy: mapY(v, from.z).toFixed(1), r: r.toFixed(0), fill: '#fff' }));
      const defs = svg('defs');
      defs.append(mask);
      g.append(defs, svg('path', { class: 'c-streets', d: streets, mask: `url(#${id})` }));
      return g;
    }
    const route = type === 'sprint' ? this.routes.sprint : this.routes.circuit;
    if (type === 'drift') {
      // The zones where a slide pays: the plaza and the bigger lots.
      let zones = '';
      for (const z of driftZones(this.world)) zones += d(z.polygon) + 'Z';
      if (zones) g.append(svg('path', { class: 'c-zones', d: zones }));
    }
    const line = d(coursePoints(route));
    g.append(
      svg('path', { class: 'c-road', d: line }),
      svg('path', { class: 'c-line', d: line, pathLength: 1 }),
      svg('path', { class: 'c-trail', d: line, pathLength: 1 }),
      svg('path', { class: 'c-pulse', d: line, pathLength: 1 }),
    );
    const start = routeSample(route, route.startS);
    g.append(marker(mapX(v, start.x), mapY(v, start.z), route.closed ? Flag : FlagTriangleRight, 'c-start'));
    if (!route.closed) {
      const end = routeSample(route, route.finishS);
      g.append(marker(mapX(v, end.x), mapY(v, end.z), Flag, 'c-finish'));
    }
    return g;
  }

  /** Follow the cruising car and the waypoint (free roam shows where you are and where you are headed). */
  update(p: MapPose, wp: Vec2 | null = null): void {
    this.lastPose = p;
    this.table.update(p, wp);
  }

  dispose(): void {
    this.table.dispose();
  }
}

/** A start or finish marker: a flag in a disc, popping in once the line has been drawn to it. */
function marker(x: number, y: number, ico: typeof Flag, cls: string): SVGGElement {
  const g = svg('g', { class: `c-mark ${cls}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` });
  const inner = svg('g', { class: 'c-mark-in' });
  inner.append(svg('circle', { r: 8.5 }));
  const fl = icon(ico, { size: 11, strokeWidth: 2.6 });
  fl.setAttribute('x', '-5.5');
  fl.setAttribute('y', '-5.5');
  inner.append(fl);
  g.append(inner);
  return g;
}

/** A car marked on a course drawing: where it is (m), and whether it is the player's. */
export interface ArtCar {
  x: number;
  z: number;
  me?: boolean;
}

/**
 * A course on its own as a line drawing fitted to a w x h box (north up, as
 * on the maps), for the race wipe's title card, the setup step's ticket and
 * the pause screen: a soft road under the line, which CSS draws on from the
 * start, the start as a dot, and the cars where they are (the player's with a
 * ping, last so it sits on top).
 */
export function courseArt(route: Route, type: RaceType, w = 300, hgt = 130, cars: readonly ArtCar[] = []): SVGSVGElement {
  const pts = coursePoints(route);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const pad = 8;
  const view: MapView = { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, scale: Math.min((w - 2 * pad) / Math.max(1, maxX - minX), (hgt - 2 * pad) / Math.max(1, maxZ - minZ)), w, h: hgt };
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${mapX(view, p.x).toFixed(1)} ${mapY(view, p.z).toFixed(1)}`).join('');
  const art = svg('svg', { class: `course-art mode-${type}`, viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, 'aria-hidden': 'true' });
  art.append(svg('path', { class: 'a-road', d }), svg('path', { class: 'a-line', d, pathLength: 1 }));
  art.append(svg('circle', { class: 'a-start', cx: mapX(view, pts[0].x).toFixed(1), cy: mapY(view, pts[0].z).toFixed(1), r: 4 }));
  for (const c of [...cars].sort((a, b) => Number(!!a.me) - Number(!!b.me))) {
    const cx = mapX(view, c.x).toFixed(1);
    const cy = mapY(view, c.z).toFixed(1);
    if (c.me) art.append(svg('circle', { class: 'a-ping', cx, cy, r: 9 }));
    art.append(svg('circle', { class: c.me ? 'a-car me' : 'a-car', cx, cy, r: c.me ? 4.5 : 3 }));
  }
  return art;
}

/**
 * A route as driven, for drawing: from the start line once round a circuit
 * (so the line draws on from the start and the pulse runs the right way), or
 * from the start to the finish of a sprint.
 */
export function coursePoints(r: Route): Vec2[] {
  const from = r.startS;
  const to = r.closed ? r.startS + r.length : r.finishS;
  const out: Vec2[] = [routeSample(r, from)];
  for (let lap = 0; lap < (r.closed ? 2 : 1); lap++)
    for (let i = 0; i < r.points.length; i++) {
      const s = r.cum[i] + lap * r.length;
      if (s > from + 0.5 && s < to - 0.5) out.push(r.points[i]);
    }
  out.push(routeSample(r, to));
  return out;
}
