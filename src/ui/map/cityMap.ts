/**
 * The city drawn as a map, shared by every view of the whole city: the full
 * map (ui/map/fullMap.ts) and the main menu's overview and course maps
 * (ui/menu.ts), so a player learns one set of colors everywhere (the
 * minimap's hues). The layers are built once per world as Path2D in world
 * meters (blocks, district fills and outlines per kind, building footprints,
 * streets grouped by ink and width, roundabouts, the bluff's terrace, the El,
 * the expressway (highwayLine), tunnels and overpasses, the race route, the
 * neighbourhood borders down the streets between them), so
 * drawing the whole city at any center and zoom is a few dozen fills and
 * strokes; layersOf() shares one set per world between the maps. A view
 * says where the map looks: the world point at the canvas center, device
 * pixels per meter and the canvas size.
 *
 * Two symbols are sized in screen pixels and so traced per draw (cheap, a few
 * hundred segments): the chevrons that mark a one-way shortcut, and the cliff
 * ticks along the bluff's crest. Shortcut direction comes from the data: a
 * back alley with a jump exit is driven toward its lip only (its path ends
 * there, districts/alleyShortcuts.ts), a car park goes up its ramp and out of
 * its chute only (its path, districts/carPark.ts); a chain without a jump
 * exit runs both ways and gets the plain shortcut ink. The minimap
 * (ui/hud/minimap.ts) draws the same marks with chevronPath and cliffPath.
 *
 * A harbor (districts/waterfront.ts) is its open water, filled out past the
 * map's edge on its side (harborWater with MAP_WATER_REACH), and its quay,
 * jetties and breakwater as paving; its warehouses are buildings.
 *
 * Orientation matches the minimap and the drone: north (+Z) is up, which puts
 * world +X on the left, as the city looks from above. Render only.
 */
import type { World } from '../../city/world';
import type { Area, AreaKind } from '../../city/districts/types';
import { isRiverEdge } from '../../city/roadGraph';
import { HIGHWAY_HALF, deckCurve, deckPoint, highwayRamp } from '../../city/districts/highway/shape';
import { axisAt } from '../../city/districts/highway/rampAxis';
import { pointInPolygon } from '../../city/districts/geom';
import { bluffShape, bluffUV, envelope, type BluffShape } from '../../city/districts/bluff';
import { carParkGeo } from '../../city/districts/carPark';
import { coastPoint, harborWater } from '../../city/districts/waterfrontShape';
import { CITY } from '../../city/config';
import type { Vec2 } from '../../sim/math';
import { PALETTE, rgba } from '../kit/palette';
import { hoodPlan, type Neighbourhood } from '../../city/names/neighbourhoods';

/** How a district kind reads on the map and in the legend. */
export interface KindStyle {
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
  park: { ink: PALETTE.green, fill: rgba('green', 0.3), width: 1.5, tag: true },
  river: { ink: PALETTE.cyan, fill: rgba('cyan', 0.26), width: 1.5, tag: true },
  lake: { ink: PALETTE.cyan, fill: rgba('cyan', 0.3), width: 1.5, tag: true },
  waterfront: { ink: PALETTE.cyan, fill: rgba('cyan', 0.22), width: 1.5, tag: true },
  monument: { ink: PALETTE.yellow, fill: rgba('yellow', 0.3), width: 1.5, tag: true },
  market: { ink: PALETTE.red, fill: rgba('red', 0.34), width: 1.5, tag: true },
  carPark: { ink: rgba('red', 0.6), fill: rgba('soft', 0.24), width: 1.5, tag: true },
  hills: { ink: PALETTE.soft, fill: rgba('soft', 0.07), width: 1.5, dash: [6, 5], tag: true },
  subway: { ink: PALETTE.cyan, width: 4, dash: [9, 6], tag: true },
  // The elevated highway: a wide pale band along its deck line and up its ramps (solid where the El is dashed).
  highway: { ink: rgba('text', 0.55), width: 6, tag: true },
  // The terrace: its high ground filled, the foot of its slopes dashed; the crest is the cliff symbol (cliffPath).
  bluff: { ink: PALETTE.orange, fill: rgba('orange', 0.1), width: 1.2, dash: [3, 4], tag: true },
  // The alleys wear the two hues no course and no road does: blue for the raceway alleys, a dim pink for the back alleys
  // (purple is the drag strip, cyan the waypoint race, grey the streets; the race shortcuts keep their stronger red).
  alley: { ink: PALETTE.blue, tag: true },
  backAlley: { ink: rgba('pink', 0.5), tag: false },
  roundabout: { ink: PALETTE.soft, tag: false },
  infill: { ink: PALETTE.soft, fill: rgba('soft', 0.2), tag: false },
  // The big open-air lots are places of their own (named, tagged), in the infill lots' grey.
  parkingLot: { ink: PALETTE.soft, fill: rgba('soft', 0.26), width: 1.2, tag: true },
  tunnel: { ink: PALETTE.soft, fill: rgba('muted', 0.22), width: 1.5, dash: [4, 3], tag: true },
  overpass: { ink: PALETTE.muted, width: 3, dash: [3, 3], tag: false },
  roadworks: { ink: PALETTE.yellow, fill: rgba('yellow', 0.55), width: 1, tag: false },
};

/**
 * Infill drawn and counted as places; verges and planters are frontage dressing, too small to read on the map.
 * The expressway is its deck: its ramps and the alleys under its lanes and ramps are no places of their own.
 */
const PLACES = new Set(['lot', 'plaza', 'cornerPlaza']);
export const shownOnMap = (a: Area): boolean => (a.kind !== 'infill' || PLACES.has(a.variant)) && !(a.kind === 'highway' && (a.variant === 'ramp' || a.variant === 'alley'));

/** A harbor's water reaches this far out past its coast on every map (m): past any view's edge. */
export const MAP_WATER_REACH = 4000;

/** Map inks outside the district kinds. */
export const MAP_INK = {
  ground: '#141315',
  block: '#232125',
  building: '#322f35',
  road: '#57545a',
  /** A harbor's quay, jetties and breakwaters: paving between the blocks and the roads. */
  quay: 'rgba(147, 146, 147, 0.26)',
  channel: rgba('cyan', 0.42),
  shortcut: rgba('red', 0.75),
  route: rgba('orange', 0.75),
  fountain: rgba('cyan', 0.55),
  planter: rgba('green', 0.45),
  player: PALETTE.text,
  tagBg: rgba('bg0', 0.86),
  /** Neighbourhood borders: dots down the middle of the street over a faint band, and the names. */
  border: rgba('text', 0.82),
  borderBand: rgba('text', 0.1),
  hoodName: rgba('text', 0.62),
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

/**
 * The one-way mark: open chevrons along the line, pointing the drivable way,
 * one every `step` CSS px, `size` px from wing to tip (never smaller than
 * most of the line's width, so they still read as road arrows zoomed right
 * in), kept `inset` px off both ends where the line meets the streets, drawn
 * `stroke` px wide over a `halo` px dark edge so they stand off the line.
 */
export const CHEVRON = { step: 18, size: 4, inset: 7, stroke: 1.6, halo: 1.4, ofWidth: 0.8 } as const;

/**
 * The cliff symbol along the bluff's crest: the crest line with ticks down
 * the face every `step` CSS px, `len` px long at the full step height,
 * shorter as the terrace eases out at its ends, none where a street ramps
 * through the face.
 */
export const CLIFF = { step: 7, len: 5, min: 0.15 } as const;

/** A one-way shortcut on the map: its line in driving order (the exit last) and the lane's width (m). */
export interface OneWay {
  pts: readonly Vec2[];
  width: number;
}

/** A point `s` m along a polyline and the unit direction there (writes into `out`). */
function alongAt(pts: readonly Vec2[], s: number, out: { x: number; z: number; ux: number; uz: number }): void {
  let left = s;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    if (l <= 0) continue;
    if (left <= l || i === pts.length - 1) {
      const t = Math.max(0, Math.min(1, left / l));
      out.x = p.x + (q.x - p.x) * t;
      out.z = p.z + (q.z - p.z) * t;
      out.ux = (q.x - p.x) / l;
      out.uz = (q.z - p.z) / l;
      return;
    }
    left -= l;
  }
}

const SPOT = { x: 0, z: 0, ux: 0, uz: 0 };

/**
 * Append the chevrons of a one-way line to `p` (world m): every `step` m
 * along it, `size` m wing to tip, pointing toward its last point, spread
 * evenly about the middle and `inset` m off both ends; a line too short for
 * the spacing still gets one at its middle.
 */
export function chevronPath(p: Path2D, pts: readonly Vec2[], step: number, size: number, inset: number): void {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  if (total <= 0) return;
  const n = Math.max(1, Math.floor((total - 2 * inset) / step));
  const s0 = total / 2 - ((n - 1) * step) / 2;
  const half = size / 2;
  for (let k = 0; k < n; k++) {
    alongAt(pts, s0 + k * step, SPOT);
    const { x, z, ux, uz } = SPOT;
    // Wings half a size back and out to each side (left of travel is (-uz, ux)), the tip half a size ahead.
    p.moveTo(x - ux * half - uz * half, z - uz * half + ux * half);
    p.lineTo(x + ux * half, z + uz * half);
    p.lineTo(x - ux * half + uz * half, z - uz * half - ux * half);
  }
}

/** The u span of each street corridor cut through a bluff's face (frame u, m), as the sim cuts the rock face (districts/bluff.ts build). */
function faceCuts(s: BluffShape): [number, number][] {
  return s.ramps.map((r) => {
    const { u } = bluffUV(s, r.x, r.z);
    const cosU = Math.max(0.3, Math.abs(r.dx * s.vx + r.dz * s.vz));
    const half = (r.hw + CITY.districts.bluff.blend) / cosU;
    return [u - half, u + half];
  });
}

/**
 * Append a bluff's cliff symbol to `p` (world m): the crest line along the
 * top of the rock face where the step still stands (envelope over CLIFF.min),
 * broken where streets ramp through it, with a tick down the face every
 * `step` m, `len` m long at full height and shorter toward the ends.
 */
export function cliffPath(p: Path2D, area: Area, step: number, len: number): void {
  const s = bluffShape(area);
  const cuts = faceCuts(s);
  const cut = (u: number) => cuts.some(([a, b]) => u > a && u < b);
  const v0 = s.fw / 2;
  const at = (u: number, v: number): Vec2 => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
  const u0 = s.uA - s.we;
  const u1 = s.uB + s.we;
  // The crest, piecewise at 2 m: the ends and the ramp cuts break it.
  let on = false;
  for (let u = u0; u <= u1 + 1e-6; u += 2) {
    const uu = Math.min(u, u1);
    const here = envelope(s, uu) >= CLIFF.min && !cut(uu);
    if (here) {
      const q = at(uu, v0);
      if (on) p.lineTo(q.x, q.z);
      else p.moveTo(q.x, q.z);
    }
    on = here;
  }
  for (let u = u0 + step / 2; u < u1; u += step) {
    const e = envelope(s, u);
    if (e < CLIFF.min || cut(u)) continue;
    const a = at(u, v0);
    const b = at(u, v0 - len * e);
    p.moveTo(a.x, a.z);
    p.lineTo(b.x, b.z);
  }
}

/**
 * A bluff's terrace on the map: its high ground, from the crest back over
 * the plateau to the foot of the back slope and out to the foot of each end's
 * easing (where the terrain is level again), the soft corners rounded. The
 * foot (every side but the crest) is the dashed contour; the crest gets the
 * cliff symbol.
 */
export function terracePaths(area: Area): { ground: Path2D; foot: Path2D } {
  const s = bluffShape(area);
  const at = (u: number, v: number): Vec2 => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
  const u0 = s.uA - s.we;
  const u1 = s.uB + s.we;
  const v0 = s.fw / 2;
  const v1 = s.vp + s.wd;
  const r = Math.min(s.we, s.wd) * 0.5;
  const ground = new Path2D();
  const foot = new Path2D();
  const trace = (p: Path2D, close: boolean) => {
    const a = at(u0, v0);
    p.moveTo(a.x, a.z);
    const c0 = at(u0, v1 - r);
    p.lineTo(c0.x, c0.z);
    const k0 = at(u0, v1);
    const c1 = at(u0 + r, v1);
    p.quadraticCurveTo(k0.x, k0.z, c1.x, c1.z);
    const c2 = at(u1 - r, v1);
    p.lineTo(c2.x, c2.z);
    const k1 = at(u1, v1);
    const c3 = at(u1, v1 - r);
    p.quadraticCurveTo(k1.x, k1.z, c3.x, c3.z);
    const b = at(u1, v0);
    p.lineTo(b.x, b.z);
    if (close) p.closePath();
  };
  trace(ground, true);
  trace(foot, false);
  return { ground, foot };
}

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
  /** The neighbourhood borders (default false: the menu's small maps leave them out). */
  neighbourhoods?: boolean;
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
  /** Harbor quays, jetties and breakwaters (their water is the waterfront's fill). */
  readonly quays = new Path2D();
  readonly ringRoads = new Path2D();
  readonly pavedIslands = new Path2D();
  readonly plantedIslands = new Path2D();
  /** The bluffs' terraces (filled) and the feet of their slopes (dashed); their crests are traced per draw (cliffPath). */
  readonly terraces = new Path2D();
  readonly terraceFeet = new Path2D();
  readonly bluffs: Area[] = [];
  /** The one-way shortcuts (jump exits, car parks), for the chevrons traced per draw. */
  readonly oneWay: OneWay[] = [];
  readonly el = new Path2D();
  /** The elevated highway's deck line and its ramps' center lines. */
  readonly highway = new Path2D();
  /** Tunnel bores by street width, then the tunnels' and overpasses' dashed outlines. */
  readonly bores: { width: number; path: Path2D }[] = [];
  readonly tunnels = new Path2D();
  readonly overpasses = new Path2D();
  readonly route = new Path2D();
  /** The streets between two neighbourhoods, along their centerlines. */
  readonly borders = new Path2D();
  /** Total street length (m), for the menu's "miles of streets". */
  readonly streetLength: number;
  private readonly areaPaths = new Map<number, Path2D>();
  private readonly hoodPaths = new Map<number, { blocks: Path2D; rim: Path2D }>();

  constructor(readonly world: World) {
    const g = world.graph;
    for (const f of world.blocks.faces) if (!f.outer) ring(this.blocks, f.ring);
    const fills = new Map<AreaKind, Path2D>();
    for (const a of world.areas) {
      const st = KINDS[a.kind];
      if (!st?.fill || a.polygon.length < 3 || a.kind === 'roundabout' || a.kind === 'bluff' || !shownOnMap(a)) continue;
      let p = fills.get(a.kind);
      if (!p) fills.set(a.kind, (p = new Path2D()));
      if (a.kind === 'waterfront') {
        // The water out past the map's edge; the quay and what stands out on the water as paving, the sheds as buildings.
        ring(p, harborWater(a, MAP_WATER_REACH));
        ring(this.quays, a.polygon);
        for (const h of world.districts.builds[a.id]?.hints ?? []) {
          if (h.kind === 'jetty' || h.kind === 'mole') ring(this.quays, strip(h.points[0], h.points[1], h.values[0] * (h.kind === 'mole' ? 0.5 : 1)));
          else if (h.kind === 'warehouse') ring(this.buildings, h.points);
        }
        continue;
      }
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
    for (const a of world.areas) {
      if (a.kind !== 'backAlley' || a.variant !== 'routeShortcut') continue;
      a.edges.forEach((e) => shortcutEdges.add(e));
      if (a.params.jumpExit) this.oneWay.push({ pts: a.path, width: a.params.width ?? CITY.width.backAlley });
    }
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
    // A car park's racing line (up the ramp, over the roof, down the chute) is a shortcut too, one way.
    for (const a of world.areas) {
      if (a.kind !== 'carPark') continue;
      const cp = carParkGeo(a);
      const width = Math.round(cp.rhw * 4) / 2;
      const key = `shortcut:${width}`;
      let grp = groups.get(key);
      if (!grp) groups.set(key, (grp = { ink: 'shortcut', width, path: new Path2D() }));
      line(grp.path, cp.path);
      this.oneWay.push({ pts: cp.path, width });
    }
    // A harbor's quay lane: the open way along the water, end to end, in the shortcut ink (both ways).
    for (const a of world.areas) {
      if (a.kind !== 'waterfront') continue;
      const lane = world.districts.builds[a.id]?.hints.find((h) => h.kind === 'quayLane');
      if (!lane) continue;
      const width = Math.round(CITY.districts.waterfront.yard.lane[1] - CITY.districts.waterfront.yard.lane[0]);
      const key = `shortcut:${width}`;
      let grp = groups.get(key);
      if (!grp) groups.set(key, (grp = { ink: 'shortcut', width, path: new Path2D() }));
      line(grp.path, lane.points);
    }
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
      } else if (a.kind === 'bluff') {
        const t = terracePaths(a);
        this.terraces.addPath(t.ground);
        this.terraceFeet.addPath(t.foot);
        this.areaPaths.set(a.id, t.ground);
        this.bluffs.push(a);
      } else if (a.kind === 'subway' && a.path.length > 1) line(this.el, a.path);
      else if (a.kind === 'highway') line(this.highway, highwayLine(a));
      else if (a.kind === 'tunnel' && a.path.length > 1) {
        const e = g.edges[a.params.edge];
        const width = e ? e.width : 10;
        let bore = this.bores.find((b) => b.width === width);
        if (!bore) this.bores.push((bore = { width, path: new Path2D() }));
        line(bore.path, a.path);
        line(this.tunnels, a.path);
      } else if (a.kind === 'overpass' && a.path.length > 1) line(this.overpasses, a.path);
    }
    for (const e of hoodPlan(world).borders) {
      const ed = g.edges[e];
      this.borders.moveTo(g.nodes[ed.a].x, g.nodes[ed.a].z);
      this.borders.lineTo(g.nodes[ed.b].x, g.nodes[ed.b].z);
    }
    const pts = world.route.points;
    if (pts.length > 1) {
      line(this.route, pts);
      if (world.route.closed) this.route.closePath();
    }
  }

  /** An area's outline as a path (world meters), built on first use (a bluff's is its terrace, not its claim; the expressway's its drivable deck). */
  areaPath(a: Area): Path2D {
    let p = this.areaPaths.get(a.id);
    if (!p) {
      p = new Path2D();
      if (a.kind === 'highway' && a.variant === 'deck') ring(p, deckOutline(a));
      else if (a.kind === 'waterfront') {
        ring(p, harborWater(a, MAP_WATER_REACH));
        ring(p, a.polygon);
      } else if (a.polygon.length >= 3) ring(p, a.polygon);
      else if (a.path.length > 1) line(p, a.path);
      this.areaPaths.set(a.id, p);
    }
    return p;
  }

  /** A neighbourhood as paths (world meters), built on first use: its blocks, and the streets around it. */
  hoodPath(hd: Neighbourhood): { blocks: Path2D; rim: Path2D } {
    let p = this.hoodPaths.get(hd.id);
    if (!p) {
      const g = this.world.graph;
      p = { blocks: new Path2D(), rim: new Path2D() };
      for (const f of hd.faces) ring(p.blocks, this.world.blocks.faces[f].ring);
      for (const e of hd.rim) {
        const ed = g.edges[e];
        p.rim.moveTo(g.nodes[ed.a].x, g.nodes[ed.a].z);
        p.rim.lineTo(g.nodes[ed.b].x, g.nodes[ed.b].z);
      }
      this.hoodPaths.set(hd.id, p);
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
    if (o.districts !== false && !o.hidden?.has('waterfront')) {
      c.fillStyle = ink.quay;
      c.fill(this.quays);
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
        grp.ink === 'alley' ? (hideAlleys ? ink.road : KINDS.alley!.ink) : grp.ink === 'backAlley' ? (hideBack ? ink.road : KINDS.backAlley!.ink) : grp.ink === 'shortcut' && hideShortcuts ? ink.road : ink[grp.ink];
      c.lineWidth = Math.max(grp.width, minStreet);
      c.stroke(grp.path);
    }
    if (!hideShortcuts && this.oneWay.length) {
      // One-way shortcuts: chevrons the drivable way, in the shortcut ink over a dark edge.
      const p = new Path2D();
      for (const w of this.oneWay) chevronPath(p, w.pts, CHEVRON.step * px, Math.max(CHEVRON.size * px, CHEVRON.ofWidth * Math.max(w.width, minStreet)), CHEVRON.inset * px);
      c.strokeStyle = ink.tagBg;
      c.lineWidth = (CHEVRON.stroke + 2 * CHEVRON.halo) * px;
      c.stroke(p);
      c.strokeStyle = ink.shortcut;
      c.lineWidth = CHEVRON.stroke * px;
      c.stroke(p);
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
      if (!o.hidden?.has('bluff') && this.bluffs.length) {
        // The terrace over the streets (it is high ground), its foot dashed, the crest as a cliff line with ticks down the face.
        const st = KINDS.bluff!;
        c.fillStyle = st.fill!;
        c.fill(this.terraces);
        c.strokeStyle = st.ink;
        c.globalAlpha = 0.7;
        c.lineWidth = st.width! * px;
        c.setLineDash(st.dash!.map((d) => d * px));
        c.stroke(this.terraceFeet);
        c.setLineDash([]);
        c.globalAlpha = 1;
        const crest = new Path2D();
        for (const a of this.bluffs) cliffPath(crest, a, CLIFF.step * px, CLIFF.len * px);
        c.lineWidth = 1.5 * px;
        c.stroke(crest);
      }
      if (!o.hidden?.has('subway')) {
        const el = KINDS.subway!;
        c.strokeStyle = el.ink;
        c.lineWidth = el.width! * px;
        c.setLineDash(el.dash!.map((d) => d * px));
        c.stroke(this.el);
        c.setLineDash([]);
      }
      if (!o.hidden?.has('highway')) {
        const st = KINDS.highway!;
        c.strokeStyle = st.ink;
        c.lineWidth = st.width! * px;
        c.stroke(this.highway);
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
    if (o.neighbourhoods) {
      // Over the streets they run down: a faint band, then round dots.
      c.strokeStyle = ink.borderBand;
      c.lineWidth = 10 * px;
      c.stroke(this.borders);
      c.strokeStyle = ink.border;
      c.lineWidth = 2.8 * px;
      c.setLineDash([0, 6 * px]);
      c.stroke(this.borders);
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

/** A highway deck's drivable stretch, between its end loops (HighwayDeck sW, sE: the deck area's params), every `step` m or less (s, m). */
function deckStations(a: Area, step: number): number[] {
  const s0 = a.params.sW;
  const s1 = a.params.sE;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  return Array.from({ length: n + 1 }, (_, k) => s0 + ((s1 - s0) * k) / n);
}

/**
 * A highway area's line on the maps (this one's and the minimap's): a deck's centerline over its drivable
 * stretch (its smoothed curve between the end loops, not the planned path, which runs on past them), a
 * ramp's or an end loop's axis; none for an alley (paving under a lane or a ramp, not the road on them).
 */
export function highwayLine(a: Area): Vec2[] {
  if (a.variant === 'ramp') return rampLine(a);
  if (a.variant !== 'deck') return [];
  const c = deckCurve(a);
  return deckStations(a, 8).map((s) => deckPoint(c, s, 0));
}

const outlines = new WeakMap<Area, Vec2[]>();

/** A highway deck's outline over its drivable stretch, its half width each side: its highlight and how far it is. */
export function deckOutline(a: Area): Vec2[] {
  let o = outlines.get(a);
  if (!o) {
    const c = deckCurve(a);
    const st = deckStations(a, 8);
    o = [...st.map((s) => deckPoint(c, s, -HIGHWAY_HALF)), ...st.reverse().map((s) => deckPoint(c, s, HIGHWAY_HALF))];
    outlines.set(a, o);
  }
  return o;
}

/** A highway ramp's center line, foot to deck (districts/highway/rampAxis.ts axis), every few meters. */
function rampLine(a: Area): Vec2[] {
  const ax = highwayRamp(a).axis;
  const pts: Vec2[] = [];
  for (let u = 0; u <= ax.length; u += 8) pts.push(axisAt(ax, u));
  pts.push(axisAt(ax, ax.length));
  return pts;
}

/** A rectangle from a to b, `width` m across (a jetty, a breakwater). */
function strip(a: Vec2, b: Vec2, width: number): Vec2[] {
  const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = (-(b.z - a.z) / l) * (width / 2);
  const nz = ((b.x - a.x) / l) * (width / 2);
  return [
    { x: a.x + nx, z: a.z + nz },
    { x: b.x + nx, z: b.z + nz },
    { x: b.x - nx, z: b.z - nz },
    { x: a.x - nx, z: a.z - nz },
  ];
}

/**
 * The area under a point as the maps name it: World.areaAt (what the sim's raster says), else a harbor whose
 * open water it is (out past the raster, where areaAt has nothing).
 */
export function areaUnder(world: World, x: number, z: number): Area | null {
  const a = world.areaAt(x, z);
  if (a) return a;
  for (const h of world.areas) {
    if (h.kind !== 'waterfront') continue;
    let water = waters.get(h);
    if (!water) waters.set(h, (water = harborWater(h, MAP_WATER_REACH, 24)));
    if (pointInPolygon(x, z, water)) return h;
  }
  return null;
}

const waters = new WeakMap<Area, Vec2[]>();

/** Append an open polyline to a path. */
function line(p: Path2D, pts: readonly Vec2[]): void {
  pts.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
}

/** Tag priority: area for the filled kinds, length for the linear ones (the river, the El and the harbor always first). */
export function tagWeight(a: Area): number {
  if (a.kind === 'river' || a.kind === 'subway' || a.kind === 'highway' || a.kind === 'waterfront') return 1e9;
  if (a.polygon.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < a.polygon.length; i++) {
    const p = a.polygon[i];
    const q = a.polygon[(i + 1) % a.polygon.length];
    s += p.x * q.z - q.x * p.z;
  }
  return Math.abs(s / 2);
}

/** Where an area's tag goes: along a linear area's path, the middle of an alley, out on a harbor's water off the middle of its quay, the centroid of anything else. */
export function tagAnchor(world: World, a: Area): Vec2 | null {
  if (a.kind === 'waterfront') return coastPoint(a, (a.params.pa + a.params.pb) / 2, 70);
  if (a.kind === 'river' || a.kind === 'subway' || a.kind === 'highway') return along(a.kind === 'highway' ? highwayLine(a) : a.path, a.kind === 'river' ? 0.3 : a.kind === 'highway' ? 0.4 : 0.7);
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
 * point itself inside the area's footprint (the expressway's: its drivable
 * deck, deckOutline), else the closest point of its outline, or of its
 * centerline when it has no footprint. Infinitely far for an area with
 * neither. Writes into `out`.
 */
export function nearestOnArea(a: Area, x: number, z: number, out: NearPoint = { x: 0, z: 0, d: 0 }): NearPoint {
  const own = a.kind === 'highway' && a.variant === 'deck' ? deckOutline(a) : a.polygon;
  const poly = own.length >= 3 ? own : null;
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

/**
 * The road node (a junction, a bend or a roundabout, World.graph) nearest
 * (x, z): where the full map locks a waypoint, so a pin dropped on a roof or
 * in the river still marks a place on the streets a car can drive to. (x, z)
 * itself on a city without streets.
 */
export function nearestRoadNode(world: World, x: number, z: number): Vec2 {
  let best = Infinity;
  const out = { x, z };
  for (const n of world.graph.nodes) {
    if (!n.edges.length) continue;
    const d2 = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d2 < best) {
      best = d2;
      out.x = n.x;
      out.z = n.z;
    }
  }
  return out;
}
