/**
 * Full city map for free roam. Clicking the HUD minimap (or Tab) opens it as a
 * modal over the paused session: the whole city at the size of the window,
 * with building footprints, every street at its real width, each district
 * filled or outlined in its own color (the minimap's hues, so a player learns
 * one set), name tags on the notable places, a legend of what this city has
 * with counts, north, a scale bar, the player's position and heading, and a
 * readout of the place under the pointer. One canvas, drawn once per open and
 * per resize; render only.
 *
 * Orientation matches the minimap and the drone: north (+Z) is up, which puts
 * world +X on the left, as the city looks from above.
 */
import type { World } from '../city/world';
import type { Area, AreaKind } from '../city/districts/types';
import { isRiverEdge } from '../city/roadGraph';
import type { Vec2 } from '../sim/math';
import { h, iconBtn } from './dom';
import { Compass, Navigation, X, icon } from './icons';
import type { MapCar } from './minimap';
import { PALETTE, rgba } from './palette';
import { placeName } from './places';

/** How a district kind reads on the map and in the legend. */
interface KindStyle {
  /** Legend entry (plural). */
  label: string;
  /** Tag text, legend swatch and outline ink. */
  ink: string;
  /** Area fill; kinds without one are drawn as lines along their streets or path. */
  fill?: string;
  /** Line width (px) and dash (px) of a line kind, or of a filled kind's outline. */
  width?: number;
  dash?: number[];
  /** Every area of the kind gets a name tag. */
  tag: boolean;
}

const KINDS: Partial<Record<AreaKind, KindStyle>> = {
  park: { label: 'Parks', ink: PALETTE.green, fill: rgba('green', 0.3), width: 1.5, tag: true },
  river: { label: 'River channel', ink: PALETTE.cyan, fill: rgba('cyan', 0.26), width: 1.5, tag: true },
  lake: { label: 'Lake', ink: PALETTE.cyan, fill: rgba('cyan', 0.3), width: 1.5, tag: true },
  waterfront: { label: 'Waterfront', ink: PALETTE.cyan, fill: rgba('cyan', 0.22), width: 1.5, tag: true },
  monument: { label: 'Monument plaza', ink: PALETTE.yellow, fill: rgba('yellow', 0.3), width: 1.5, tag: true },
  market: { label: 'Night market', ink: PALETTE.red, fill: rgba('red', 0.34), width: 1.5, tag: true },
  carPark: { label: 'Car parks', ink: rgba('red', 0.6), fill: rgba('soft', 0.24), width: 1.5, tag: true },
  hills: { label: 'The hills', ink: PALETTE.soft, fill: rgba('soft', 0.07), width: 1.5, dash: [6, 5], tag: true },
  subway: { label: 'Under the El', ink: PALETTE.cyan, width: 4, dash: [9, 6], tag: true },
  alley: { label: 'Raceway alleys', ink: PALETTE.purple, tag: true },
  backAlley: { label: 'Back alleys', ink: rgba('soft', 0.55), tag: false },
  roundabout: { label: 'Roundabouts', ink: PALETTE.soft, tag: false },
  infill: { label: 'Plazas and lots', ink: PALETTE.soft, fill: rgba('soft', 0.2), tag: false },
  tunnel: { label: 'Tunnels', ink: PALETTE.soft, fill: rgba('muted', 0.22), width: 1.5, dash: [4, 3], tag: true },
  overpass: { label: 'Overpasses', ink: PALETTE.muted, width: 3, dash: [3, 3], tag: false },
  roadworks: { label: 'Roadworks', ink: PALETTE.red, fill: rgba('red', 0.55), width: 1, tag: false },
};

/** Infill drawn and counted as places; verges and planters are frontage dressing, too small to read on the map. */
const PLACES = new Set(['lot', 'plaza', 'cornerPlaza']);
const shown = (a: Area) => a.kind !== 'infill' || PLACES.has(a.variant);

/** Map inks outside the district kinds. */
const INK = {
  ground: '#141315',
  block: '#232125',
  building: '#322f35',
  road: '#57545a',
  channel: rgba('cyan', 0.42),
  shortcut: rgba('red', 0.75),
  route: rgba('orange', 0.75),
  fountain: rgba('cyan', 0.55),
  planter: rgba('green', 0.45),
  player: PALETTE.text,
  tagBg: rgba('bg0', 0.86),
  font: '"Google Sans Flex", system-ui, sans-serif',
} as const;

/** Legend order; kinds missing from the city are left out. */
const LEGEND_ORDER: AreaKind[] = ['park', 'river', 'lake', 'waterfront', 'subway', 'alley', 'backAlley', 'roundabout', 'hills', 'monument', 'tunnel', 'overpass', 'carPark', 'infill', 'roadworks'];

/** Margin around the city (m), and the scale bar lengths it picks from (m). */
const PAD = 40;
const SCALE_STEPS = [50, 100, 200, 250, 500, 1000];

export interface FullMapOptions {
  onClose(): void;
}

export class FullMap {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly box: HTMLDivElement;
  private readonly pointerEl: HTMLElement;
  private readonly cx: number;
  private readonly cz: number;
  private readonly span: number;
  /** Device pixels per meter and the canvas size (device px) of the last draw. */
  private s = 1;
  private size = 1;
  private readonly onResize = () => this.draw();

  constructor(
    private readonly world: World,
    private readonly player: MapCar,
    opts: FullMapOptions,
  ) {
    const b = world.graph.bounds;
    this.cx = (b.minX + b.maxX) / 2;
    this.cz = (b.minZ + b.maxZ) / 2;
    this.span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 2 * PAD;
    this.canvas = h('canvas', { class: 'fullmap-canvas', 'aria-label': 'City map' });
    this.box = h('div', { class: 'fullmap-map' }, this.canvas);
    this.pointerEl = h('span', { class: 'fullmap-pointer' }, 'Point at the map to name a place');
    const here = placeName(world.areaAt(player.x, player.z));
    const panel = h(
      'div',
      { class: 'fullmap panel', role: 'dialog', 'aria-label': 'City map' },
      h(
        'header',
        { class: 'fullmap-head' },
        h('h2', { class: 'title' }, icon(Compass, { size: 20 }), 'City map'),
        h('span', { class: 'fullmap-here' }, 'You are in ', h('b', {}, here)),
        iconBtn(X, 'Close map', () => opts.onClose(), 'fullmap-close'),
      ),
      h('div', { class: 'fullmap-body' }, this.box, this.legend()),
      h('footer', { class: 'fullmap-foot' }, this.pointerEl, h('span', { class: 'fullmap-keys' }, 'Tab or Esc to close')),
    );
    this.root = h('div', { class: 'screen center dim fullmap-screen' }, panel);
    // A click on the dimmed backdrop (not the panel) closes it too.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) opts.onClose();
    });
    this.canvas.addEventListener('pointermove', (e) => this.point(e));
    this.canvas.addEventListener('pointerleave', () => (this.pointerEl.textContent = 'Point at the map to name a place'));
    window.addEventListener('resize', this.onResize);
  }

  /** Call once the root is in the document (the canvas sizes itself to its box). */
  draw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = Math.max(120, Math.floor(Math.min(this.box.clientWidth, this.box.clientHeight)));
    this.canvas.style.width = this.canvas.style.height = `${css}px`;
    this.size = Math.round(css * dpr);
    this.canvas.width = this.canvas.height = this.size;
    this.s = this.size / this.span;
    const c = this.canvas.getContext('2d')!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = INK.ground;
    c.fillRect(0, 0, this.size, this.size);
    this.drawWorld(c, dpr);
    c.setTransform(1, 0, 0, 1, 0, 0);
    this.drawTags(c, dpr);
    this.drawFurniture(c, dpr);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  /** World (x, z) to canvas device pixels. */
  private sx(x: number): number {
    return this.size / 2 - (x - this.cx) * this.s;
  }
  private sy(z: number): number {
    return this.size / 2 - (z - this.cz) * this.s;
  }

  /** Everything drawn in world meters: ground, blocks, districts, streets, the route and the player. */
  private drawWorld(c: CanvasRenderingContext2D, dpr: number): void {
    const { world } = this;
    const g = world.graph;
    const s = this.s;
    c.setTransform(-s, 0, 0, -s, this.size / 2 + this.cx * s, this.size / 2 + this.cz * s);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    /** Screen pixels as map meters (line widths, dashes). */
    const px = dpr / s;
    const poly = (pts: Vec2[]) => {
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.closePath();
    };
    // Blocks (bounded by their outer sidewalk lines, so streets and sidewalks stay ground colored).
    c.fillStyle = INK.block;
    for (const f of world.blocks.faces) {
      if (f.outer) continue;
      poly(f.ring);
      c.fill();
    }
    // District fills and outlines.
    for (const a of world.areas) {
      const st = KINDS[a.kind];
      if (!st?.fill || a.polygon.length < 3 || a.kind === 'roundabout' || !shown(a)) continue;
      poly(a.polygon);
      c.fillStyle = st.fill;
      c.fill();
      if (st.width) {
        c.strokeStyle = st.ink;
        c.globalAlpha = a.kind === 'infill' ? 0.35 : 0.7;
        c.lineWidth = st.width * px;
        c.setLineDash((st.dash ?? []).map((d) => d * px));
        c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 1;
      }
    }
    // Building footprints.
    c.fillStyle = INK.building;
    for (const b of world.blocks.buildings) {
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      const hw = b.w / 2;
      const hd = b.d / 2;
      c.beginPath();
      c.moveTo(b.x + ux * hw - uz * hd, b.z + uz * hw + ux * hd);
      c.lineTo(b.x - ux * hw - uz * hd, b.z - uz * hw + ux * hd);
      c.lineTo(b.x - ux * hw + uz * hd, b.z - uz * hw - ux * hd);
      c.lineTo(b.x + ux * hw + uz * hd, b.z + uz * hw - ux * hd);
      c.closePath();
      c.fill();
    }
    // Streets at their real widths, the channel floor in the river's color, alleys in theirs.
    const shortcutEdges = new Set<number>();
    for (const a of world.areas) if (a.kind === 'backAlley' && a.variant === 'routeShortcut') a.edges.forEach((e) => shortcutEdges.add(e));
    for (const e of g.edges) {
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      c.strokeStyle = isRiverEdge(e) ? INK.channel : shortcutEdges.has(e.id) ? INK.shortcut : e.kind === 'alley' ? PALETTE.purple : e.kind === 'backAlley' ? KINDS.backAlley!.ink : INK.road;
      c.lineWidth = Math.max(e.width, 2.2 * px);
      c.beginPath();
      c.moveTo(A.x, A.z);
      c.lineTo(B.x, B.z);
      c.stroke();
    }
    // Roundabouts: the ring road and its island (a fountain basin or a grassy planter).
    for (const a of world.areas) {
      if (a.kind !== 'roundabout') continue;
      const { x, z, outer, island } = a.params;
      c.fillStyle = INK.road;
      c.beginPath();
      c.arc(x, z, outer, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = a.params.solid ? INK.fountain : INK.planter;
      c.beginPath();
      c.arc(x, z, island, 0, Math.PI * 2);
      c.fill();
    }
    // The El: a dashed line over its street.
    const el = KINDS.subway!;
    c.strokeStyle = el.ink;
    c.lineWidth = el.width! * px;
    c.setLineDash(el.dash!.map((d) => d * px));
    for (const a of world.areas) {
      if (a.kind !== 'subway' || a.path.length < 2) continue;
      c.beginPath();
      a.path.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.stroke();
    }
    c.setLineDash([]);
    // Tunnels: the bore darkened over its street, its outline dashed; overpasses dashed across what they span.
    for (const a of world.areas) {
      if ((a.kind !== 'tunnel' && a.kind !== 'overpass') || a.path.length < 2) continue;
      const st = KINDS[a.kind]!;
      if (a.kind === 'tunnel') {
        const e = g.edges[a.params.edge];
        c.strokeStyle = INK.tagBg;
        c.lineWidth = Math.max(e ? e.width : 10, 2.2 * px);
        c.beginPath();
        a.path.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
        c.stroke();
      }
      c.strokeStyle = st.ink;
      c.lineWidth = st.width! * px;
      c.setLineDash(st.dash!.map((d) => d * px));
      c.beginPath();
      a.path.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      c.stroke();
      c.setLineDash([]);
    }
    // The seed's race circuit, thin, for orientation.
    const pts = world.route.points;
    if (pts.length > 1) {
      c.strokeStyle = INK.route;
      c.lineWidth = 2.2 * px;
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.z) : c.moveTo(p.x, p.z)));
      if (world.route.closed) c.closePath();
      c.stroke();
    }
  }

  /** Name tags on the notable places (screen space), dropped where they would overlap one already placed. */
  private drawTags(c: CanvasRenderingContext2D, dpr: number): void {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    // The player's own tag is reserved first so places never cover it.
    const me = { x: this.sx(this.player.x), y: this.sy(this.player.z) };
    placed.push({ x0: me.x - 16 * dpr, y0: me.y - 16 * dpr, x1: me.x + 16 * dpr, y1: me.y + 16 * dpr });
    c.font = `700 ${11 * dpr}px ${INK.font}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const tag = (text: string, x: number, y: number, ink: string): void => {
      const w = c.measureText(text).width + 12 * dpr;
      const hgt = 18 * dpr;
      const r = { x0: x - w / 2, y0: y - hgt / 2, x1: x + w / 2, y1: y + hgt / 2 };
      if (r.x0 < 2 || r.y0 < 2 || r.x1 > this.size - 2 || r.y1 > this.size - 2) return;
      if (placed.some((q) => r.x0 < q.x1 + 3 && r.x1 > q.x0 - 3 && r.y0 < q.y1 + 3 && r.y1 > q.y0 - 3)) return;
      placed.push(r);
      c.fillStyle = INK.tagBg;
      c.strokeStyle = ink;
      c.lineWidth = dpr;
      c.beginPath();
      c.roundRect(r.x0, r.y0, w, hgt, 3 * dpr);
      c.fill();
      c.stroke();
      c.fillStyle = ink;
      c.fillText(text, x, y + 0.5 * dpr);
    };
    // Bigger places first, so a small one never crowds out a park or the river.
    const tagged = this.world.areas.filter((a) => KINDS[a.kind]?.tag).sort((a, b) => tagWeight(b) - tagWeight(a));
    for (const a of tagged) {
      const p = anchor(this.world, a);
      if (p) tag(placeName(a), this.sx(p.x), this.sy(p.z), KINDS[a.kind]!.ink);
    }
    // The player: a white arrow pointing along the car's heading (screen x mirrors world x).
    const fx = -Math.sin(this.player.yaw);
    const fy = -Math.cos(this.player.yaw);
    const L = 11 * dpr;
    const B = 6.5 * dpr;
    c.fillStyle = INK.player;
    c.strokeStyle = PALETTE.bg0;
    c.lineWidth = 2 * dpr;
    c.beginPath();
    c.moveTo(me.x + fx * L, me.y + fy * L);
    c.lineTo(me.x - fx * L * 0.7 - fy * B, me.y - fy * L * 0.7 + fx * B);
    c.lineTo(me.x - fx * L * 0.35, me.y - fy * L * 0.35);
    c.lineTo(me.x - fx * L * 0.7 + fy * B, me.y - fy * L * 0.7 - fx * B);
    c.closePath();
    c.stroke();
    c.fill();
    c.font = `800 ${11 * dpr}px ${INK.font}`;
    c.fillStyle = INK.player;
    c.strokeStyle = PALETTE.bg0;
    c.lineWidth = 3 * dpr;
    c.strokeText('YOU', me.x, me.y + 20 * dpr);
    c.fillText('YOU', me.x, me.y + 20 * dpr);
  }

  /** North arrow and scale bar. */
  private drawFurniture(c: CanvasRenderingContext2D, dpr: number): void {
    const m = 14 * dpr;
    // North, top right.
    const nx = this.size - m - 10 * dpr;
    const ny = m + 14 * dpr;
    c.fillStyle = PALETTE.yellow;
    c.beginPath();
    c.moveTo(nx, ny - 12 * dpr);
    c.lineTo(nx + 7 * dpr, ny + 6 * dpr);
    c.lineTo(nx, ny + 2 * dpr);
    c.lineTo(nx - 7 * dpr, ny + 6 * dpr);
    c.closePath();
    c.fill();
    c.font = `800 ${12 * dpr}px ${INK.font}`;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    c.fillText('N', nx, ny + 9 * dpr);
    // Scale bar, bottom left: the longest step that stays under a fifth of the map.
    const step = SCALE_STEPS.filter((d) => d * this.s <= this.size / 5).pop() ?? SCALE_STEPS[0];
    const len = step * this.s;
    const y = this.size - m;
    c.strokeStyle = PALETTE.soft;
    c.lineWidth = 2 * dpr;
    c.beginPath();
    c.moveTo(m, y - 5 * dpr);
    c.lineTo(m, y);
    c.lineTo(m + len, y);
    c.lineTo(m + len, y - 5 * dpr);
    c.stroke();
    c.fillStyle = PALETTE.soft;
    c.font = `700 ${11 * dpr}px ${INK.font}`;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    c.fillText(step >= 1000 ? `${step / 1000} km` : `${step} m`, m, y - 7 * dpr);
  }

  /** The legend: only what this city has, with counts. */
  private legend(): HTMLElement {
    const counts = new Map<AreaKind, number>();
    for (const a of this.world.areas) if (shown(a)) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
    const row = (sw: HTMLElement, label: string, count?: number) => h('li', {}, sw, h('span', { class: 'grow' }, label), count && count > 1 ? h('span', { class: 'fullmap-count' }, String(count)) : null);
    const swatch = (kind: 'fill' | 'line' | 'dash' | 'ring', ink: string, fill?: string) =>
      h('span', { class: `fullmap-swatch ${kind}`, style: kind === 'fill' ? `background:${fill};border-color:${ink}` : `border-color:${ink}` });
    const items: HTMLElement[] = [
      row(h('span', { class: 'fullmap-swatch icon' }, icon(Navigation, { size: 14 })), 'You'),
      row(swatch('line', INK.route), 'Race circuit'),
    ];
    if (this.world.areas.some((a) => a.kind === 'backAlley' && a.variant === 'routeShortcut')) {
      items.push(row(swatch('line', INK.shortcut), 'Race shortcuts', this.world.areas.filter((a) => a.kind === 'backAlley' && a.variant === 'routeShortcut').length));
    }
    for (const k of LEGEND_ORDER) {
      let n = counts.get(k) ?? 0;
      if (k === 'backAlley') n = this.world.areas.filter((a) => a.kind === k && a.variant !== 'routeShortcut').length;
      const st = KINDS[k];
      if (!n || !st) continue;
      const sw = k === 'roundabout' ? swatch('ring', st.ink) : st.fill ? swatch('fill', st.ink, st.fill) : swatch(st.dash ? 'dash' : 'line', st.ink);
      // Infill is frontage filler: a count of it says nothing.
      items.push(row(sw, st.label, k === 'infill' ? undefined : n));
    }
    return h('div', { class: 'fullmap-legend' }, h('h3', {}, 'Legend'), h('ul', {}, ...items));
  }

  /** Name the place under the pointer, with its distance from the player. */
  private point(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    const k = this.size / r.width;
    const x = this.cx - ((e.clientX - r.left) * k - this.size / 2) / this.s;
    const z = this.cz - ((e.clientY - r.top) * k - this.size / 2) / this.s;
    const d = Math.hypot(x - this.player.x, z - this.player.z);
    const far = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`;
    this.pointerEl.textContent = `${placeName(this.world.areaAt(x, z))} · ${far} away`;
  }
}

/** Tag priority: area for the filled kinds, length for the linear ones. */
function tagWeight(a: Area): number {
  if (a.kind === 'river' || a.kind === 'subway') return 1e9;
  if (a.polygon.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < a.polygon.length; i++) {
    const p = a.polygon[i];
    const q = a.polygon[(i + 1) % a.polygon.length];
    s += p.x * q.z - q.x * p.z;
  }
  return Math.abs(s / 2);
}

/** Where an area's tag goes: along a linear area's path, the middle of an alley, the centroid of anything else. */
function anchor(world: World, a: Area): Vec2 | null {
  if (a.kind === 'river' || a.kind === 'subway') return along(a.path, a.kind === 'river' ? 0.3 : 0.7);
  if (a.kind === 'alley') {
    const g = world.graph;
    const e = g.edges[a.edges[a.edges.length >> 1]];
    if (!e) return null;
    return { x: (g.nodes[e.a].x + g.nodes[e.b].x) / 2, z: (g.nodes[e.a].z + g.nodes[e.b].z) / 2 };
  }
  return centroid(a.polygon);
}

/** Point at fraction t of a polyline's length. */
function along(path: Vec2[], t: number): Vec2 | null {
  if (path.length < 2) return path[0] ?? null;
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  let left = total * t;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1];
    const q = path[i];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    if (left <= l && l > 0) return { x: p.x + ((q.x - p.x) * left) / l, z: p.z + ((q.z - p.z) * left) / l };
    left -= l;
  }
  return path[path.length - 1];
}

/** Area centroid of a polygon (its vertex average when degenerate). */
function centroid(poly: Vec2[]): Vec2 | null {
  if (poly.length < 3) return null;
  let a = 0;
  let x = 0;
  let z = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const k = p.x * q.z - q.x * p.z;
    a += k;
    x += (p.x + q.x) * k;
    z += (p.z + q.z) * k;
  }
  if (Math.abs(a) < 1e-6) return { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, z: poly.reduce((s, p) => s + p.z, 0) / poly.length };
  return { x: x / (3 * a), z: z / (3 * a) };
}
