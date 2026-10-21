/**
 * Minimap: a round, heading-up map canvas centred on a viewpoint, drawing the
 * district layers (AREA_MAP_STYLE), the street network, the route with its
 * shortcuts (dim pink dashes), closures and car markers. The race HUD centres it on the player's car; the drone
 * centres it on itself with a view cone and a north mark, and zooms out as it
 * climbs, so the same map serves both. The Path2D layers are built once per
 * world, so a frame is a handful of strokes. Render only.
 */
import type { World } from '../city/world';
import { AREA_MAP_STYLE, AreaKind, AreaMapStyle } from '../city/districts/types';
import { PALETTE, rgba } from './palette';

/** Map inks (Monokai Pro, ui/palette.ts), built once: orange is the route, yellow the closures. */
const INK = {
  face: rgba('bg0', 0.78),
  road: rgba('muted', 0.24),
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
} as const;

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private roads: Path2D;
  private routePath: Path2D;
  /** The route's own shortcuts (back alleys it opens), entry to exit. */
  private shortcuts: Path2D;
  private closed: { x: number; z: number }[];
  /** District layers: polygon fills and line strokes, in draw order. */
  private areaFills: { path: Path2D; style: AreaMapStyle }[] = [];
  private areaLines: { path: Path2D; style: AreaMapStyle }[] = [];

  constructor(world: World, className = 'hud-map') {
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
    this.routePath = new Path2D();
    world.route.points.forEach((p, i) => (i ? this.routePath.lineTo(p.x, p.z) : this.routePath.moveTo(p.x, p.z)));
    this.shortcuts = new Path2D();
    for (const sc of world.route.shortcuts) {
      this.shortcuts.moveTo(sc.ax, sc.az);
      this.shortcuts.lineTo(sc.bx, sc.bz);
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
    for (const a of world.areas) {
      const st = AREA_MAP_STYLE[a.kind];
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
      } else if (a.kind === 'subway' || a.kind === 'tunnel' || a.kind === 'overpass') {
        a.path.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
      } else if (a.kind === 'bluff') {
        // The escarpment's face line.
        a.path.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
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
    // Order: alleys and shortcuts under the subway and roundabout outlines.
    const order: AreaKind[] = ['hills', 'bluff', 'backAlley', 'alley', 'roundabout', 'subway', 'overpass', 'tunnel'];
    for (const k of order) {
      const path = lines.get(k);
      if (path) this.areaLines.push({ path, style: AREA_MAP_STYLE[k] });
    }
  }

  draw(view: MapView, cars: readonly MapCar[]): void {
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
    // Shortcuts under the route line, so their dashes start where the alley leaves it; no glow.
    c.strokeStyle = INK.shortcut;
    c.lineWidth = Math.max(4, 2.2 * px);
    c.setLineDash([4 * px, 3 * px]);
    c.stroke(this.shortcuts);
    c.setLineDash([]);
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
