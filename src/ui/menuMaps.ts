/**
 * The main menu's maps of the event city, both drawn from the shared city
 * layers (ui/cityMap.ts) so they read like the full map and the minimap:
 *  - CityOverview: the home card's map. The whole city tilted like a model on
 *    a table, with the cruising car's live position on it (a heading arrow
 *    over a radar ping) and the event's signature district breathing (the
 *    river for River Run, the roundabouts for Ring Rush ...). It says where
 *    tonight's event is without saying which race; the race step shows the
 *    courses. A click opens the full map.
 *  - CourseMap: the race step's map, flat, with the picked race type's course
 *    drawn on in its color: the circuit's lap from the start line, the sprint
 *    from A to B, the drift lap with its zones, or every street for free roam,
 *    lit outward from the car. Switching types fades the old course out and
 *    draws the new one in; a pulse of light then runs the course in its
 *    driving direction.
 * The city is rasterized once per map (and again when the box resizes); the
 * markers and courses are DOM and SVG over it, so CSS does the drawing on, the
 * fades and the pulses on the compositor. Per frame only the car marker moves
 * (one transform). Render only.
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

/** The home card's tilted city with the cruising car on it. */
export class CityOverview {
  readonly el: HTMLElement;
  private readonly plane: HTMLElement;
  private readonly base: HTMLCanvasElement;
  private readonly glow: HTMLCanvasElement;
  private readonly car = new CarMarker();
  private readonly pin = new PinMarker();
  private readonly layers: CityLayers;
  /** The plane's view in CSS px, for the marker. */
  private view: MapView | null = null;
  private readonly ro: ResizeObserver;

  constructor(private readonly world: World) {
    this.layers = layersOf(world);
    this.base = h('canvas', { class: 'ov-base' });
    this.glow = h('canvas', { class: 'ov-glow' });
    // The plane tilts (and flattens on hover); the map turns slowly on it, so each is one transform.
    // Spans: the overview sits inside the event card's map button, where only phrasing content belongs.
    this.plane = h('span', { class: 'ov-spin' }, this.base, this.glow, this.pin.el, this.car.el);
    this.el = h('span', { class: 'city-overview', 'aria-hidden': 'true' }, h('span', { class: 'ov-stage' }, h('span', { class: 'ov-plane' }, this.plane)), h('i', { class: 'ov-scan' }));
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
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
    const view = fitCity(this.world, this.base.width, this.base.height, 30);
    this.view = fitCity(this.world, w, hgt, 30);
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

  /** Move the car marker to the cruising car and the pin to the waypoint (every frame the menu shows). */
  update(p: MapPose, wp: Vec2 | null = null): void {
    const v = this.view;
    if (!v) return;
    this.car.place(mapX(v, p.x), mapY(v, p.z), mapHeading(p.yaw));
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

/** The race step's flat city with the picked type's course drawn on. */
export class CourseMap {
  readonly el: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly overlay: SVGSVGElement;
  private readonly car = new CarMarker();
  private readonly pin = new PinMarker();
  private readonly layers: CityLayers;
  private view: MapView | null = null;
  private type: RaceType | null = null;
  private course: SVGGElement | null = null;
  private readonly ro: ResizeObserver;
  private lastPose: MapPose | null = null;

  /** `onOpen`: the map is a button that opens the full city map on this course. */
  constructor(
    private readonly world: World,
    private readonly routes: CourseRoutes,
    onOpen?: () => void,
  ) {
    this.layers = layersOf(world);
    this.canvas = h('canvas', { class: 'course-city' });
    this.overlay = svg('svg', { class: 'course-svg', 'aria-hidden': 'true' });
    this.el = h('div', { class: 'course-map' }, this.canvas, this.overlay, this.pin.el, this.car.el);
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
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.el);
  }

  /** Show a race type's course; `animate` draws it on (a type change), otherwise it simply appears. */
  show(type: RaceType, animate = true): void {
    if (type === this.type && this.course) return;
    this.type = type;
    this.el.dataset.mode = type;
    const old = this.course;
    if (old) {
      if (animate) {
        old.classList.add('leave');
        setTimeout(() => old.remove(), LEAVE_MS);
      } else old.remove();
    }
    this.course = this.view ? this.build(type, animate) : null;
    if (this.course) this.overlay.append(this.course);
  }

  /**
   * Where the racing is: the box around both courses and the drift zones, so
   * every type's course shows as large as the card allows while the city
   * behind stays put when the type changes (free roam's streets run on past
   * the edges, as the city does).
   */
  private frame(w: number, hgt: number): MapView {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const add = (p: Vec2) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    };
    coursePoints(this.routes.circuit).forEach(add);
    coursePoints(this.routes.sprint).forEach(add);
    for (const z of driftZones(this.world)) z.polygon.forEach(add);
    if (!Number.isFinite(minX)) return fitCity(this.world, w, hgt, 24);
    // The margin is in pixels, so the start and finish discs (8.5 px) never sit on the edge whatever the scale.
    const pad = 20;
    const scale = Math.min((w - 2 * pad) / Math.max(1, maxX - minX), (hgt - 2 * pad) / Math.max(1, maxZ - minZ));
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, scale, w, h: hgt };
  }

  /** Rasterize the city and rebuild the course for the box's current size. */
  private draw(): void {
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    if (w < 8 || hgt < 8) return;
    const dpr = dprOf();
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hgt * dpr);
    const first = !this.view;
    const view = (this.view = this.frame(w, hgt));
    this.overlay.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.layers.draw(c, { ...view, scale: view.scale * dpr, w: this.canvas.width, h: this.canvas.height }, {
      dpr,
      ground: false,
      route: false,
      minStreet: 1,
      ink: { block: 'rgba(58, 56, 60, 0.5)', building: 'rgba(80, 77, 84, 0.45)', road: 'rgba(120, 118, 124, 0.7)', channel: 'rgba(120, 220, 232, 0.3)' },
    });
    // A veil over the city, so the course in its color is the brightest thing on the card.
    c.fillStyle = 'rgba(18, 17, 19, 0.38)';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // The course goes on top in the type's color; the city stays a quiet backdrop for it.
    if (this.type) {
      this.course?.remove();
      this.course = this.build(this.type, first);
      this.overlay.append(this.course);
    }
    if (this.lastPose) this.update(this.lastPose);
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
    const v = this.view;
    if (!v) return;
    this.car.place(mapX(v, p.x), mapY(v, p.z), mapHeading(p.yaw));
    this.pin.place(wp && mapX(v, wp.x), wp ? mapY(v, wp.z) : 0);
  }

  dispose(): void {
    this.ro.disconnect();
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
