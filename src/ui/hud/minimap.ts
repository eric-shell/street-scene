/**
 * Minimap: a round, heading-up map canvas centred on a viewpoint, drawing the
 * district layers (AREA_MAP_STYLE), the street network, the route (none in a
 * waypoint race, where the player picks the streets) with its shortcuts (dim pink dashes; a one-way shortcut, a jump exit or a car park,
 * carries the city map's chevrons the drivable way, ui/map/cityMap.ts), the
 * bluff's crest as the same cliff symbol, closures and car markers. The race HUD centres it on the player's car; the drone
 * centres it on itself with a view cone and a north mark, and zooms out as it
 * climbs, so the same map serves both. In free roam it also shows the waypoint
 * set on the full map (in a waypoint race, the player's target): a pin where it is, or an arrow on the rim pointing to
 * it while it is off the map. The Path2D layers are built once per
 * world, so a frame is a handful of strokes. Render only.
 */
import type { World } from '../../city/world';
import { AREA_MAP_STYLE, type Area, AreaKind, AreaMapStyle } from '../../city/districts/types';
import { ROUTE_INDEX, carParks } from '../../city/districts/carPark';
import { shortcutArea } from '../../city/districts/alleyDressing';
import { CHEVRON, CLIFF, MAP_WATER_REACH, chevronPath, cliffPath, highwayLine, terracePaths, type OneWay } from '../map/cityMap';
import { harborWater } from '../../city/districts/waterfrontShape';
import { PALETTE, rgba } from '../kit/palette';

/** Map inks (Monokai Pro, ui/kit/palette.ts), built once: orange is the route, yellow the closures. */
const INK = {
  face: rgba('bg0', 0.78),
  road: rgba('muted', 0.24),
  /** A harbor's quay, between the face and the roads. */
  quay: rgba('muted', 0.13),
  route: PALETTE.orange,
  /** Route shortcuts: the back alleys the route opens, a dim pink that is there when looked for, not a second route. */
  shortcut: rgba('red', 0.42),
  closure: PALETTE.yellow,
  rival: PALETTE.red,
  ghost: rgba('purple', 0.85),
  /** Ambient traffic (free roam): small quiet dots that never read as rivals. */
  traffic: rgba('muted', 0.75),
  player: PALETTE.text,
  rim: rgba('orange', 0.55),
  /** The drone's view cone and its north mark. */
  cone: rgba('cyan', 0.42),
  coneEnd: rgba('cyan', 0),
  north: PALETTE.yellow,
  /** The free roam waypoint (ui/fullMap/): a yellow pin, outlined dark. */
  waypoint: PALETTE.yellow,
  waypointEdge: PALETTE.bg0,
  font: '700 13px "Google Sans Flex", system-ui, sans-serif',
} as const;

export interface MapCar {
  x: number;
  z: number;
  /** Heading (rad): forward is (sin yaw, cos yaw). */
  yaw: number;
  isPlayer: boolean;
  isGhost?: boolean;
  /** Ambient traffic car: drawn as a small dot. */
  isTraffic?: boolean;
}

export interface MapView {
  x: number;
  z: number;
  /** Heading (rad) that points up on the map: forward is (sin yaw, cos yaw). */
  yaw: number;
  /** Canvas pixels per meter (the canvas is 200 px across). */
  scale?: number;
  /** What sits at the centre: the player's car arrow, or the drone with its view cone. */
  marker?: 'car' | 'drone';
  /** Drone horizontal field of view (rad) for the cone. */
  fov?: number;
}

export const MAP = {
  /** Canvas resolution (px); CSS sizes it on screen. */
  size: 200,
  /** Default zoom (px per m). */
  scale: 0.38,
  /** The viewpoint sits this far below the centre (px), so more of the map lies ahead. */
  ahead: 26,
  /** Drone view cone length (px). */
  cone: 74,
  /** The waypoint shows as a pin while this far inside the rim (px), else as an arrow on the rim. */
  pinInset: 14,
} as const;

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private roads: Path2D;
  private routePath: Path2D;
  /** The route's own shortcuts (back alleys it opens), entry to exit. */
  private shortcuts: Path2D;
  /** The one-way ones among them, for the chevrons; the bluffs, for their crests. Both are sized on screen, so traced again when the zoom changes. */
  private readonly oneWay: OneWay[] = [];
  private readonly bluffs: Area[] = [];
  private marks: { scale: number; chevrons: Path2D; crests: Path2D } | null = null;
  private closed: { x: number; z: number }[];
  /** District layers: polygon fills and line strokes, in draw order. */
  private areaFills: { path: Path2D; style: AreaMapStyle }[] = [];
  private areaLines: { path: Path2D; style: AreaMapStyle }[] = [];

  constructor(world: World, className = 'hud__minimap') {
    this.canvas = document.createElement('canvas');
    this.canvas.className = className;
    this.canvas.width = this.canvas.height = MAP.size;
    const g = world.graph;
    this.roads = new Path2D();
    for (const e of g.edges) {
      // Alleys and shortcuts are drawn by their district layers (narrow, dimmed).
      if (e.shortcut || e.kind === 'alley') continue;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      this.roads.moveTo(a.x, a.z);
      this.roads.lineTo(b.x, b.z);
    }
    this.buildAreaLayers(world);
    // A waypoint race draws no route: its route is only the AI's suggestion, and the player picks the streets
    // (and the order), with the HUD's arrow and the target's pin to go by.
    const suggestion = world.route.kind === 'waypoint';
    this.routePath = new Path2D();
    if (!suggestion) world.route.points.forEach((p, i) => (i ? this.routePath.lineTo(p.x, p.z) : this.routePath.moveTo(p.x, p.z)));
    this.shortcuts = new Path2D();
    for (const sc of suggestion ? [] : world.route.shortcuts) {
      sc.points.forEach((p, i) => (i ? this.shortcuts.lineTo(p.x, p.z) : this.shortcuts.moveTo(p.x, p.z)));
      // A jump exit runs on past its mouth: the flight down onto the street. It is driven toward its lip only.
      const a = shortcutArea(world.areas, sc);
      if (a?.params.jumpExit) {
        const n = sc.points.length;
        const o = sc.points[n - 2];
        const b = sc.points[n - 1];
        const len = Math.hypot(b.x - o.x, b.z - o.z) || 1;
        const reach = a.params.landMax * 0.6 - a.params.lipS;
        this.shortcuts.lineTo(b.x + ((b.x - o.x) / len) * reach, b.z + ((b.z - o.z) / len) * reach);
        this.oneWay.push({ pts: sc.points, width: g.edges[sc.edges[0]].width });
      }
    }
    // Car park shortcuts: up the ramp, across the roof and the jump down onto the route (the route's own only); one way.
    for (const cp of carParks(world.areas)) {
      if (!world.openWorld && cp.owner !== ROUTE_INDEX[world.route.kind]) continue;
      cp.path.forEach((p, i) => (i ? this.shortcuts.lineTo(p.x, p.z) : this.shortcuts.moveTo(p.x, p.z)));
      this.shortcuts.lineTo(cp.ox - cp.ux * (cp.lipBack + cp.landMax * 0.6), cp.oz - cp.uz * (cp.lipBack + cp.landMax * 0.6));
      this.oneWay.push({ pts: cp.path, width: cp.rhw * 2 });
    }
    // Closures: one marker per closure group (they are cyan rail pieces, like the corner rails).
    this.closed = (world.barrierGroups ?? []).map((gr) => ({ x: gr.x, z: gr.z }));
  }

  /** Minimap layers per district kind (styles from AREA_MAP_STYLE). */
  private buildAreaLayers(world: World): void {
    const g = world.graph;
    const fills = new Map<AreaKind, Path2D>();
    const lines = new Map<AreaKind, Path2D>();
    const get = (m: Map<AreaKind, Path2D>, k: AreaKind) => {
      let p = m.get(k);
      if (!p) m.set(k, (p = new Path2D()));
      return p;
    };
    let quays: Path2D | null = null;
    for (const a of world.areas) {
      const st = AREA_MAP_STYLE[a.kind];
      if (a.kind === 'waterfront') {
        // The water out past the rim (the city map's reach), the quay as paving beside it.
        const water = harborWater(a, MAP_WATER_REACH);
        if (st.fill) {
          const p = get(fills, a.kind);
          water.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
          p.closePath();
        }
        quays ??= new Path2D();
        const q = quays;
        a.polygon.forEach((pt, i) => (i ? q.lineTo(pt.x, pt.z) : q.moveTo(pt.x, pt.z)));
        q.closePath();
        continue;
      }
      if (a.kind === 'bluff') {
        // The terrace's high ground, not its claim; the crest is traced per zoom (draw).
        if (st.fill) get(fills, a.kind).addPath(terracePaths(a).ground);
        this.bluffs.push(a);
        continue;
      }
      if (st.fill && a.polygon.length > 2 && a.kind !== 'roundabout') {
        const p = get(fills, a.kind);
        a.polygon.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
        p.closePath();
      }
      if (!st.stroke) continue;
      const p = get(lines, a.kind);
      if (a.kind === 'roundabout') {
        p.moveTo(a.params.x + a.params.outer, a.params.z);
        p.arc(a.params.x, a.params.z, a.params.outer, 0, Math.PI * 2);
        p.moveTo(a.params.x + a.params.island, a.params.z);
        p.arc(a.params.x, a.params.z, a.params.island, 0, Math.PI * 2);
      } else if (a.kind === 'subway' || a.kind === 'highway' || a.kind === 'tunnel' || a.kind === 'overpass') {
        // The expressway as the city map draws it: its deck between the end loops and its ramps' axes, none of its alleys.
        (a.kind === 'highway' ? highwayLine(a) : a.path).forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
      } else if (a.kind === 'hills') {
        // A contour around the rise.
        a.polygon.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
        p.closePath();
      } else {
        for (const eid of a.edges) {
          const e = g.edges[eid];
          p.moveTo(g.nodes[e.a].x, g.nodes[e.a].z);
          p.lineTo(g.nodes[e.b].x, g.nodes[e.b].z);
        }
      }
    }
    for (const [k, path] of fills) this.areaFills.push({ path, style: AREA_MAP_STYLE[k] });
    if (quays) this.areaFills.push({ path: quays, style: { fill: INK.quay } });
    // Order: alleys and shortcuts under the subway and roundabout outlines.
    const order: AreaKind[] = ['hills', 'backAlley', 'alley', 'roundabout', 'subway', 'highway', 'overpass', 'tunnel'];
    for (const k of order) {
      const path = lines.get(k);
      if (path) this.areaLines.push({ path, style: AREA_MAP_STYLE[k] });
    }
  }

  draw(view: MapView, cars: readonly MapCar[], waypoint?: { x: number; z: number } | null): void {
    const c = this.canvas.getContext('2d')!;
    const W = MAP.size;
    const scale = view.scale ?? MAP.scale;
    const drone = view.marker === 'drone';
    const cx = W / 2;
    const cy = W / 2 + MAP.ahead;
    c.clearRect(0, 0, W, W);
    c.save();
    c.beginPath();
    c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2);
    c.fillStyle = INK.face;
    c.fill();
    c.clip();
    c.save();
    c.translate(cx, cy);
    // Heading up: forward (sin yaw, cos yaw) maps to screen up.
    c.rotate(view.yaw - Math.PI);
    c.scale(scale, scale);
    c.translate(-view.x, -view.z);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    // Markers and strokes keep their on-screen size at any zoom: sizes are px / scale in map meters.
    const px = 1 / scale;
    for (const f of this.areaFills) {
      c.fillStyle = f.style.fill!;
      c.fill(f.path);
    }
    c.strokeStyle = INK.road;
    c.lineWidth = Math.max(9, 1.2 * px);
    c.stroke(this.roads);
    for (const l of this.areaLines) {
      c.strokeStyle = l.style.stroke!;
      c.lineWidth = l.style.width ?? 4;
      c.setLineDash(l.style.dash ?? []);
      c.stroke(l.path);
    }
    const scWidth = Math.max(4, 2.2 * px);
    const marks = this.marksAt(scale, scWidth);
    if (this.bluffs.length) {
      const st = AREA_MAP_STYLE.bluff;
      c.strokeStyle = st.stroke!;
      c.lineWidth = (st.width ?? 2) * px;
      c.setLineDash([]);
      c.stroke(marks.crests);
    }
    // Shortcuts under the route line, so their dashes start where the alley leaves it; no glow.
    c.strokeStyle = INK.shortcut;
    c.lineWidth = scWidth;
    c.setLineDash([4 * px, 3 * px]);
    c.stroke(this.shortcuts);
    c.setLineDash([]);
    if (this.oneWay.length) {
      // One way: the city map's chevrons, in the shortcut ink over the face's dark edge.
      c.strokeStyle = INK.face;
      c.lineWidth = (CHEVRON.stroke + 2 * CHEVRON.halo) * px;
      c.stroke(marks.chevrons);
      c.strokeStyle = INK.shortcut;
      c.lineWidth = CHEVRON.stroke * px;
      c.stroke(marks.chevrons);
    }
    c.strokeStyle = INK.route;
    c.shadowColor = INK.route;
    c.shadowBlur = 4;
    // Keep the route a readable width when the drone zooms far out.
    c.lineWidth = Math.max(7, 2.6 / scale);
    c.stroke(this.routePath);
    c.shadowBlur = 0;
    c.fillStyle = INK.closure;
    const box = 1.5 * px;
    for (const p of this.closed) c.fillRect(p.x - box, p.z - box, box * 2, box * 2);
    for (const car of cars) {
      if (car.isPlayer && !drone) continue;
      if (car.isPlayer) {
        // Seen from the drone the player's car is a small white arrow where it is.
        const sx = Math.sin(car.yaw);
        const sz = Math.cos(car.yaw);
        const L = 9 * px;
        const B = 5 * px;
        c.fillStyle = INK.player;
        c.beginPath();
        c.moveTo(car.x + sx * L, car.z + sz * L);
        c.lineTo(car.x - sx * L * 0.7 + sz * B, car.z - sz * L * 0.7 - sx * B);
        c.lineTo(car.x - sx * L * 0.7 - sz * B, car.z - sz * L * 0.7 + sx * B);
        c.closePath();
        c.fill();
        continue;
      }
      c.fillStyle = car.isGhost ? INK.ghost : car.isTraffic ? INK.traffic : INK.rival;
      c.beginPath();
      c.arc(car.x, car.z, (car.isTraffic ? 2.2 : 3.4) * px, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
    // The waypoint in screen space (the pin stays upright as the map turns): (dx, dz) turned by yaw - pi, as the map is.
    let wpIn = false;
    let wpAngle = 0;
    if (waypoint) {
      const dx = (waypoint.x - view.x) * scale;
      const dz = (waypoint.z - view.z) * scale;
      const cs = Math.cos(view.yaw - Math.PI);
      const sn = Math.sin(view.yaw - Math.PI);
      const sx = cx + dx * cs - dz * sn;
      const sy = cy + dx * sn + dz * cs;
      const ox = sx - W / 2;
      const oy = sy - W / 2;
      wpIn = ox * ox + oy * oy < (W / 2 - MAP.pinInset) ** 2;
      wpAngle = Math.atan2(oy, ox);
      if (wpIn) this.drawPin(c, sx, sy);
    }
    if (drone) this.drawDrone(c, cx, cy, view.fov ?? 1.2, view.yaw);
    else {
      c.fillStyle = INK.player;
      c.beginPath();
      c.moveTo(cx, cy - 12);
      c.lineTo(cx - 8, cy + 8);
      c.lineTo(cx + 8, cy + 8);
      c.closePath();
      c.fill();
    }
    c.restore();
    c.strokeStyle = INK.rim;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(W / 2, W / 2, W / 2 - 2, 0, Math.PI * 2);
    c.stroke();
    if (waypoint && !wpIn) this.drawRimArrow(c, wpAngle);
  }

  /** The screen sized marks (chevrons, crest ticks) traced for this zoom (px per m), kept until it changes (the drone's climb). */
  private marksAt(scale: number, lineWidth: number): { chevrons: Path2D; crests: Path2D } {
    if (this.marks && this.marks.scale === scale) return this.marks;
    const px = 1 / scale;
    const chevrons = new Path2D();
    for (const w of this.oneWay) chevronPath(chevrons, w.pts, CHEVRON.step * px, Math.max(CHEVRON.size * px, CHEVRON.ofWidth * Math.max(w.width, lineWidth)), CHEVRON.inset * px);
    const crests = new Path2D();
    for (const a of this.bluffs) cliffPath(crests, a, CLIFF.step * px, CLIFF.len * px);
    this.marks = { scale, chevrons, crests };
    return this.marks;
  }

  /** The waypoint's pin, its point at (x, y): a round head over a point, like the full map's. */
  private drawPin(c: CanvasRenderingContext2D, x: number, y: number): void {
    const head = 10;
    const r = 5.5;
    const a = Math.acos(r / head);
    c.beginPath();
    c.moveTo(x, y);
    c.arc(x, y - head, r, Math.PI / 2 + a, Math.PI / 2 - a + Math.PI * 2);
    c.closePath();
    c.fillStyle = INK.waypoint;
    c.strokeStyle = INK.waypointEdge;
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.stroke();
    c.fill();
    c.fillStyle = INK.waypointEdge;
    c.beginPath();
    c.arc(x, y - head, 2, 0, Math.PI * 2);
    c.fill();
  }

  /** The waypoint off the map: a yellow arrow on the rim, pointing out toward it. */
  private drawRimArrow(c: CanvasRenderingContext2D, angle: number): void {
    const R = MAP.size / 2;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const tip = R - 3;
    const base = R - 15;
    c.beginPath();
    c.moveTo(R + ux * tip, R + uy * tip);
    c.lineTo(R + ux * base - uy * 7, R + uy * base + ux * 7);
    c.lineTo(R + ux * (base + 4), R + uy * (base + 4));
    c.lineTo(R + ux * base + uy * 7, R + uy * base - ux * 7);
    c.closePath();
    c.fillStyle = INK.waypoint;
    c.strokeStyle = INK.waypointEdge;
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.stroke();
    c.fill();
  }

  /** The drone at the viewpoint: a view cone up the screen, a quad glyph, and north on the rim. */
  private drawDrone(c: CanvasRenderingContext2D, cx: number, cy: number, fov: number, yaw: number): void {
    const half = Math.min(1.3, fov / 2);
    const cone = c.createRadialGradient(cx, cy, 4, cx, cy, MAP.cone);
    cone.addColorStop(0, INK.cone);
    cone.addColorStop(1, INK.coneEnd);
    c.fillStyle = cone;
    c.beginPath();
    c.moveTo(cx, cy);
    c.arc(cx, cy, MAP.cone, -Math.PI / 2 - half, -Math.PI / 2 + half);
    c.closePath();
    c.fill();
    c.strokeStyle = INK.player;
    c.lineWidth = 2;
    c.beginPath();
    for (const [dx, dy] of [
      [-1, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
    ]) {
      c.moveTo(cx, cy);
      c.lineTo(cx + dx * 6, cy + dy * 6);
    }
    c.stroke();
    c.fillStyle = INK.player;
    for (const [dx, dy] of [
      [-1, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
    ]) {
      c.beginPath();
      c.arc(cx + dx * 7, cy + dy * 7, 2.6, 0, Math.PI * 2);
      c.fill();
    }
    // North on the rim. The drone's heading readout calls yaw 0 (facing +Z) north, and the map
    // turns world +Z to the screen direction (sin yaw, -cos yaw).
    const W = MAP.size;
    const r = W / 2 - 13;
    const nx = W / 2 + Math.sin(yaw) * r;
    const ny = W / 2 - Math.cos(yaw) * r;
    c.font = INK.font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = INK.north;
    c.fillText('N', nx, ny);
  }
}
