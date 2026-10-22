/**
 * The city drawn as a map, shared by every view of the whole city: the full
 * map (ui/fullMap.ts) and the main menu's overview and course maps
 * (ui/menu.ts), so a player learns one set of colors everywhere (the
 * minimap's hues). The layers are built once per world as Path2D in world
 * meters (blocks, district fills and outlines per kind, building footprints,
 * streets grouped by ink and width, roundabouts, the bluff's face, the El,
 * tunnels and overpasses, the race route), so drawing the whole city at any
 * center and zoom is a few dozen fills and strokes; layersOf() shares one set
 * per world between the maps. A view says where the map looks: the world
 * point at the canvas center, device pixels per meter and the canvas size.
 *
 * Orientation matches the minimap and the drone: north (+Z) is up, which puts
 * world +X on the left, as the city looks from above. Render only.
 */
import type { World } from '../city/world';
import type { Area, AreaKind } from '../city/districts/types';
import { isRiverEdge } from '../city/roadGraph';
import { pointInPolygon } from '../city/districts/geom';
import type { Vec2 } from '../sim/math';
import { PALETTE, rgba } from './palette';

/** How a district kind reads on the map and in the legend. */
export interface KindStyle {
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

export const KINDS: Partial<Record<AreaKind, KindStyle>> = {
  park: { label: 'Parks', ink: PALETTE.green, fill: rgba('green', 0.3), width: 1.5, tag: true },
  river: { label: 'River channel', ink: PALETTE.cyan, fill: rgba('cyan', 0.26), width: 1.5, tag: true },
  lake: { label: 'Lake', ink: PALETTE.cyan, fill: rgba('cyan', 0.3), width: 1.5, tag: true },
  waterfront: { label: 'Waterfront', ink: PALETTE.cyan, fill: rgba('cyan', 0.22), width: 1.5, tag: true },
  monument: { label: 'Monument plaza', ink: PALETTE.yellow, fill: rgba('yellow', 0.3), width: 1.5, tag: true },
  market: { label: 'Night market', ink: PALETTE.red, fill: rgba('red', 0.34), width: 1.5, tag: true },
  carPark: { label: 'Car parks', ink: rgba('red', 0.6), fill: rgba('soft', 0.24), width: 1.5, tag: true },
  hills: { label: 'The hills', ink: PALETTE.soft, fill: rgba('soft', 0.07), width: 1.5, dash: [6, 5], tag: true },
  subway: { label: 'Under the El', ink: PALETTE.cyan, width: 4, dash: [9, 6], tag: true },
  bluff: { label: 'The bluff', ink: PALETTE.orange, fill: rgba('orange', 0.08), width: 1.5, dash: [4, 4], tag: true },
  alley: { label: 'Raceway alleys', ink: PALETTE.purple, tag: true },
  backAlley: { label: 'Back alleys', ink: rgba('soft', 0.55), tag: false },
  roundabout: { label: 'Roundabouts', ink: PALETTE.soft, tag: false },
  infill: { label: 'Plazas and lots', ink: PALETTE.soft, fill: rgba('soft', 0.2), tag: false },
  tunnel: { label: 'Tunnels', ink: PALETTE.soft, fill: rgba('muted', 0.22), width: 1.5, dash: [4, 3], tag: true },
  overpass: { label: 'Overpasses', ink: PALETTE.muted, width: 3, dash: [3, 3], tag: false },
  roadworks: { label: 'Roadworks', ink: PALETTE.yellow, fill: rgba('yellow', 0.55), width: 1, tag: false },
};

/** Infill drawn and counted as places; verges and planters are frontage dressing, too small to read on the map. */
const PLACES = new Set(['lot', 'plaza', 'cornerPlaza']);
export const shownOnMap = (a: Area): boolean => a.kind !== 'infill' || PLACES.has(a.variant);

/** Map inks outside the district kinds. */
export const MAP_INK = {
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
};
export type MapInk = typeof MAP_INK;

/** Where a map looks: the world point at the canvas center, device pixels per meter, and the canvas size (device px). */
export interface MapView {
  cx: number;
  cz: number;
  scale: number;
  w: number;
  h: number;
}

/** Margin kept around the city when it is fitted to a canvas (m). */
export const MAP_PAD = 40;

/** The view that fits the whole city (plus `pad` m) into a w x h canvas, centered. */
export function fitCity(world: Pick<World, 'graph'>, w: number, h: number, pad = MAP_PAD): MapView {
  const b = world.graph.bounds;
  const spanX = b.maxX - b.minX + 2 * pad;
  const spanZ = b.maxZ - b.minZ + 2 * pad;
  return { cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, scale: Math.min(w / spanX, h / spanZ), w, h };
}

/** World x to canvas x (world +X runs to the left). */
export function mapX(v: MapView, x: number): number {
  return v.w / 2 - (x - v.cx) * v.scale;
}

/** World z to canvas y (north, +Z, is up). */
export function mapY(v: MapView, z: number): number {
  return v.h / 2 - (z - v.cz) * v.scale;
}

/** Canvas point to world (x, z); writes into `out`. */
export function mapToWorld(v: MapView, px: number, py: number, out: Vec2 = { x: 0, z: 0 }): Vec2 {
  out.x = v.cx - (px - v.w / 2) / v.scale;
  out.z = v.cz - (py - v.h / 2) / v.scale;
  return out;
}

/** A heading (yaw, forward = (sin, cos)) as the clockwise screen angle from up (rad), for rotating a marker drawn pointing up. */
export function mapHeading(yaw: number): number {
  return -yaw;
}

export interface CityDrawOptions {
  /** Device pixels per CSS pixel: line widths and dashes are given in CSS px. */
  dpr: number;
  /** Fill the canvas with the ground ink first (default true). */
  ground?: boolean;
  /** Block faces, building footprints, district areas, the race route (each default true). */
  blocks?: boolean;
  buildings?: boolean;
  districts?: boolean;
  route?: boolean;
  /** District kinds to leave out. */
  hidden?: ReadonlySet<AreaKind>;
  /** The race shortcuts in their own ink (default: shown with the back alleys, hidden with them). */
  shortcuts?: boolean;
  /** Thinnest a street is drawn (CSS px; default 2.2). */
  minStreet?: number;
  /** Ink overrides, for a quieter or brighter map. */
  ink?: Partial<MapInk>;
}

/** Streets that share an ink and (rounded) width, as one path. */
interface StreetGroup {
  ink: keyof MapInk | 'alley' | 'backAlley';
  width: number;
  path: Path2D;
}

/** The world's map layers as Path2D in world meters, built once. */
export class CityLayers {
  readonly blocks = new Path2D();
  readonly buildings = new Path2D();
  /** One path per district kind with a fill, in legend order of first appearance. */
  readonly fills: { kind: AreaKind; path: Path2D }[] = [];
  readonly streets: StreetGroup[] = [];
  readonly ringRoads = new Path2D();
  readonly pavedIslands = new Path2D();
  readonly plantedIslands = new Path2D();
  readonly bluff = new Path2D();
  readonly el = new Path2D();
  /** Tunnel bores by street width, then the tunnels' and overpasses' dashed outlines. */
  readonly bores: { width: number; path: Path2D }[] = [];
  readonly tunnels = new Path2D();
  readonly overpasses = new Path2D();
  readonly route = new Path2D();
  /** Total street length (m), for the menu's "miles of streets". */
  readonly streetLength: number;
  private readonly areaPaths = new Map<number, Path2D>();

  constructor(readonly world: World) {
    const g = world.graph;
    for (const f of world.blocks.faces) if (!f.outer) ring(this.blocks, f.ring);
    const fills = new Map<AreaKind, Path2D>();
    for (const a of world.areas) {
      const st = KINDS[a.kind];
      if (!st?.fill || a.polygon.length < 3 || a.kind === 'roundabout' || !shownOnMap(a)) continue;
      let p = fills.get(a.kind);
      if (!p) fills.set(a.kind, (p = new Path2D()));
      ring(p, a.polygon);
    }
    for (const [kind, path] of fills) this.fills.push({ kind, path });
    for (const b of world.blocks.buildings) {
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      const hw = b.w / 2;
      const hd = b.d / 2;
      const p = this.buildings;
      p.moveTo(b.x + ux * hw - uz * hd, b.z + uz * hw + ux * hd);
      p.lineTo(b.x - ux * hw - uz * hd, b.z - uz * hw + ux * hd);
      p.lineTo(b.x - ux * hw + uz * hd, b.z - uz * hw - ux * hd);
      p.lineTo(b.x + ux * hw + uz * hd, b.z + uz * hw - ux * hd);
      p.closePath();
    }
    // Streets at their real widths: the channel floor in the river's color, shortcuts and alleys in theirs.
    const shortcutEdges = new Set<number>();
    for (const a of world.areas) if (a.kind === 'backAlley' && a.variant === 'routeShortcut') a.edges.forEach((e) => shortcutEdges.add(e));
    const groups = new Map<string, StreetGroup>();
    let length = 0;
    for (const e of g.edges) {
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const ink: StreetGroup['ink'] = isRiverEdge(e) ? 'channel' : shortcutEdges.has(e.id) ? 'shortcut' : e.kind === 'alley' ? 'alley' : e.kind === 'backAlley' ? 'backAlley' : 'road';
      const width = Math.round(e.width * 2) / 2;
      const key = `${ink}:${width}`;
      let grp = groups.get(key);
      if (!grp) groups.set(key, (grp = { ink, width, path: new Path2D() }));
      grp.path.moveTo(A.x, A.z);
      grp.path.lineTo(B.x, B.z);
      length += e.length;
    }
    this.streetLength = length;
    // Plain roads first, so the colored streets read on top where they meet.
    this.streets.push(...[...groups.values()].sort((a, b) => Number(a.ink !== 'road') - Number(b.ink !== 'road')));
    for (const a of world.areas) {
      if (a.kind === 'roundabout') {
        const { x, z, outer, island } = a.params;
        this.ringRoads.moveTo(x + outer, z);
        this.ringRoads.arc(x, z, outer, 0, Math.PI * 2);
        const isl = a.params.paved ? this.pavedIslands : this.plantedIslands;
        isl.moveTo(x + island, z);
        isl.arc(x, z, island, 0, Math.PI * 2);
      } else if (a.kind === 'bluff' && a.path.length > 1) line(this.bluff, a.path);
      else if (a.kind === 'subway' && a.path.length > 1) line(this.el, a.path);
      else if (a.kind === 'tunnel' && a.path.length > 1) {
        const e = g.edges[a.params.edge];
        const width = e ? e.width : 10;
        let bore = this.bores.find((b) => b.width === width);
        if (!bore) this.bores.push((bore = { width, path: new Path2D() }));
        line(bore.path, a.path);
        line(this.tunnels, a.path);
      } else if (a.kind === 'overpass' && a.path.length > 1) line(this.overpasses, a.path);
    }
    const pts = world.route.points;
    if (pts.length > 1) {
      line(this.route, pts);
      if (world.route.closed) this.route.closePath();
    }
  }

  /** An area's outline as a path (world meters), built on first use. */
  areaPath(a: Area): Path2D {
    let p = this.areaPaths.get(a.id);
    if (!p) {
      p = new Path2D();
      if (a.polygon.length >= 3) ring(p, a.polygon);
      else if (a.path.length > 1) line(p, a.path);
      this.areaPaths.set(a.id, p);
    }
    return p;
  }

  /**
   * Draw the city through `view`. Leaves the context's transform as it found
   * it; callers draw screen space overlays (tags, markers) after.
   */
  draw(c: CanvasRenderingContext2D, view: MapView, o: CityDrawOptions): void {
    const ink: MapInk = o.ink ? { ...MAP_INK, ...o.ink } : MAP_INK;
    const s = view.scale;
    /** One CSS pixel in map meters (line widths, dashes). */
    const px = o.dpr / s;
    c.save();
    if (o.ground !== false) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.fillStyle = ink.ground;
      c.fillRect(0, 0, view.w, view.h);
    }
    c.setTransform(-s, 0, 0, -s, view.w / 2 + view.cx * s, view.h / 2 + view.cz * s);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (o.blocks !== false) {
      c.fillStyle = ink.block;
      c.fill(this.blocks);
    }
    if (o.districts !== false) {
      for (const f of this.fills) {
        if (o.hidden?.has(f.kind)) continue;
        const st = KINDS[f.kind]!;
        c.fillStyle = st.fill!;
        c.fill(f.path);
        if (st.width) {
          c.strokeStyle = st.ink;
          c.globalAlpha = f.kind === 'infill' ? 0.35 : 0.7;
          c.lineWidth = st.width * px;
          c.setLineDash((st.dash ?? []).map((d) => d * px));
          c.stroke(f.path);
          c.setLineDash([]);
          c.globalAlpha = 1;
        }
      }
    }
    if (o.buildings !== false) {
      c.fillStyle = ink.building;
      c.fill(this.buildings);
    }
    const minStreet = (o.minStreet ?? 2.2) * px;
    const hideAlleys = o.districts === false || o.hidden?.has('alley');
    const hideBack = o.districts === false || o.hidden?.has('backAlley');
    const hideShortcuts = o.shortcuts === undefined ? hideBack : !o.shortcuts;
    for (const grp of this.streets) {
      c.strokeStyle =
        grp.ink === 'alley' ? (hideAlleys ? ink.road : PALETTE.purple) : grp.ink === 'backAlley' ? (hideBack ? ink.road : KINDS.backAlley!.ink) : grp.ink === 'shortcut' && hideShortcuts ? ink.road : ink[grp.ink];
      c.lineWidth = Math.max(grp.width, minStreet);
      c.stroke(grp.path);
    }
    if (o.districts !== false && !o.hidden?.has('roundabout')) {
      c.fillStyle = ink.road;
      c.fill(this.ringRoads);
      c.fillStyle = ink.fountain;
      c.fill(this.pavedIslands);
      c.fillStyle = ink.planter;
      c.fill(this.plantedIslands);
    }
    if (o.districts !== false) {
      if (!o.hidden?.has('bluff')) {
        c.strokeStyle = PALETTE.orange;
        c.lineWidth = 3 * px;
        c.stroke(this.bluff);
      }
      if (!o.hidden?.has('subway')) {
        const el = KINDS.subway!;
        c.strokeStyle = el.ink;
        c.lineWidth = el.width! * px;
        c.setLineDash(el.dash!.map((d) => d * px));
        c.stroke(this.el);
        c.setLineDash([]);
      }
      if (!o.hidden?.has('tunnel')) {
        c.strokeStyle = ink.tagBg;
        for (const b of this.bores) {
          c.lineWidth = Math.max(b.width, minStreet);
          c.stroke(b.path);
        }
        const st = KINDS.tunnel!;
        c.strokeStyle = st.ink;
        c.lineWidth = st.width! * px;
        c.setLineDash(st.dash!.map((d) => d * px));
        c.stroke(this.tunnels);
      }
      if (!o.hidden?.has('overpass')) {
        const st = KINDS.overpass!;
        c.strokeStyle = st.ink;
        c.lineWidth = st.width! * px;
        c.setLineDash(st.dash!.map((d) => d * px));
        c.stroke(this.overpasses);
      }
      c.setLineDash([]);
    }
    if (o.route !== false) {
      c.strokeStyle = ink.route;
      c.lineWidth = 2.2 * px;
      c.stroke(this.route);
    }
    c.restore();
  }
}

const layerCache = new WeakMap<World, CityLayers>();

/** A world's layers, built on first use and shared by every map of it (a few thousand paths, about 10 ms to build). */
export function layersOf(world: World): CityLayers {
  let l = layerCache.get(world);
  if (!l) layerCache.set(world, (l = new CityLayers(world)));
  return l;
}

/** Append a closed polygon to a path. */
function ring(p: Path2D, pts: readonly Vec2[]): void {
  pts.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
  p.closePath();
}

/** Append an open polyline to a path. */
function line(p: Path2D, pts: readonly Vec2[]): void {
  pts.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
}

/** Tag priority: area for the filled kinds, length for the linear ones (the river and the El always first). */
export function tagWeight(a: Area): number {
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
export function tagAnchor(world: World, a: Area): Vec2 | null {
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
export function along(path: readonly Vec2[], t: number): Vec2 | null {
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
export function centroid(poly: readonly Vec2[]): Vec2 | null {
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

/** A point and its distance (m), as nearestOnArea returns them. */
export interface NearPoint {
  x: number;
  z: number;
  d: number;
}

/**
 * The point of an area nearest to (x, z), for "how far is the river": the
 * point itself inside the area's footprint, else the closest point of its
 * outline, or of its centerline when it has no footprint. Infinitely far for
 * an area with neither. Writes into `out`.
 */
export function nearestOnArea(a: Area, x: number, z: number, out: NearPoint = { x: 0, z: 0, d: 0 }): NearPoint {
  const poly = a.polygon.length >= 3 ? a.polygon : null;
  out.x = x;
  out.z = z;
  out.d = 0;
  if (poly && pointInPolygon(x, z, poly)) return out;
  const pts = poly ?? a.path;
  const n = pts.length;
  if (!n) {
    out.d = Infinity;
    return out;
  }
  let best = (x - pts[0].x) ** 2 + (z - pts[0].z) ** 2;
  out.x = pts[0].x;
  out.z = pts[0].z;
  for (let i = 0, segs = poly ? n : n - 1; i < segs; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const ex = q.x - p.x;
    const ez = q.z - p.z;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - p.x) * ex + (z - p.z) * ez) / len2)) : 0;
    const px = p.x + ex * t;
    const pz = p.z + ez * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best) {
      best = d2;
      out.x = px;
      out.z = pz;
    }
  }
  out.d = Math.sqrt(best);
  return out;
}
