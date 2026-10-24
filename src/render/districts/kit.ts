/**
 * Shared geometry kit for district renderers. Every renderer appends into a
 * handful of merged builders (one draw call per material for all districts,
 * which keeps phones happy) and may add its own objects to `group`. Moving
 * parts (the elevated railway's trains) register per build animation and
 * camera hooks on the kit rather than keeping state in the renderer module,
 * so the menu backdrop and a race scene never share or steal each other's
 * trains.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Wall } from '../../city/blocks';
import type { Area, AreaBuild, WallLook } from '../../city/districts/types';
import type { Vec2 } from '../../sim/math';
import type { Quality } from '../../ui/settings';
import { GeoBuilder } from '../geoBuilder';

export interface DistrictKit {
  world: World;
  /** Terrain height (includes district height modifiers). */
  h(x: number, z: number): number;
  /** Lit, vertex colored: concrete, steel, trunks, basins. */
  solid: GeoBuilder;
  /** Lit, vertex colored, draped on the terrain: grass, lots, plazas, channel. */
  ground: GeoBuilder;
  /** Paint and decals just above the ground (polygon offset), vertex colored. */
  paint: GeoBuilder;
  /** Unlit, vertex colored, bright: lamps, water shimmer (blooms). */
  glow: GeoBuilder;
  /** Lit, vertex colored foliage. */
  foliage: GeoBuilder;
  /** The trees (trees.ts): lit, vertex colored, uv = sway weight and phase for the wind. */
  trees: GeoBuilder;
  /** Extra objects (instanced meshes, animated parts). */
  group: THREE.Group;
  /** City walls (kind 'wall') by look. */
  walls: Map<WallLook, Wall[]>;
  /** Builds by area id. */
  builds: AreaBuild[];
  /** Graphics preset the scene is built for: detail knobs (ties, sparks, light wash). */
  quality: Quality;
  track<T extends { dispose(): void }>(x: T): T;
  /** Run `fn(time)` every frame for this build (time in s, the scene's clock). */
  animate(fn: (time: number) => void): void;
  /** Run `fn(camera)` before every render of the scene, with the camera rendering it (audio, culling). */
  view(fn: (camera: THREE.Camera) => void): void;
  /**
   * The sim tick to pose sim-timed parts at (the El's trains, level crossing gates): the session's
   * interpolated tick once it syncs (DistrictMeshes.sync), else the scene clock `time` (s) in ticks,
   * so the menu backdrop's trains run on as before.
   */
  simTick(time: number): number;
  /** False unless a live, unpaused session syncs this scene (bells stay quiet otherwise). */
  audible(): boolean;
  /** Has a car snapped off level crossing arm `i` (RaceState.brokenArms: gate * 2 + half)? False outside a race. */
  armBroken(i: number): boolean;
}

/** What each district renderer module exports. */
export interface DistrictRenderer {
  /** Area kinds whose areas this renderer receives. */
  kinds: Area['kind'][];
  build(kit: DistrictKit, areas: Area[]): void;
  /** Optional per frame animation. */
  update?(time: number): void;
}

const tmp = new THREE.Color();
export const col = (hex: number, mul = 1): THREE.Color => new THREE.Color(hex).multiplyScalar(mul);

function normalAt(world: World, x: number, z: number): [number, number, number] {
  const s = world.slopeAt(x, z);
  const l = Math.hypot(s.gx, 1, s.gz);
  return [-s.gx / l, 1 / l, -s.gz / l];
}

/** Ground vertex on the terrain at (x, z), lifted. */
export function groundVertex(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, lift: number, color: THREE.Color, uvScale = 4): number {
  const [nx, ny, nz] = normalAt(kit.world, x, z);
  return gb.vertex(x, kit.h(x, z) + lift, z, nx, ny, nz, x / uvScale, z / uvScale, color);
}

/**
 * Drape a convex polygon on the terrain: a fan from its centroid, each
 * triangle subdivided until its edges are under maxEdge so it follows hills.
 */
export function drapeConvex(kit: DistrictKit, gb: GeoBuilder, poly: Vec2[], lift: number, color: THREE.Color, maxEdge = 6): void {
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x;
    cz += p.z;
  }
  const c = { x: cx / poly.length, z: cz / poly.length };
  for (let i = 0; i < poly.length; i++) drapeTri(kit, gb, c, poly[i], poly[(i + 1) % poly.length], lift, color, maxEdge, 0);
}

export function drapeTri(kit: DistrictKit, gb: GeoBuilder, a: Vec2, b: Vec2, c: Vec2, lift: number, color: THREE.Color, maxEdge: number, depth: number): void {
  const lab = Math.hypot(b.x - a.x, b.z - a.z);
  const lbc = Math.hypot(c.x - b.x, c.z - b.z);
  const lca = Math.hypot(a.x - c.x, a.z - c.z);
  if (Math.max(lab, lbc, lca) > maxEdge && depth < 7) {
    const ab = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const bc = { x: (b.x + c.x) / 2, z: (b.z + c.z) / 2 };
    const ca = { x: (c.x + a.x) / 2, z: (c.z + a.z) / 2 };
    drapeTri(kit, gb, a, ab, ca, lift, color, maxEdge, depth + 1);
    drapeTri(kit, gb, ab, b, bc, lift, color, maxEdge, depth + 1);
    drapeTri(kit, gb, ca, bc, c, lift, color, maxEdge, depth + 1);
    drapeTri(kit, gb, ab, bc, ca, lift, color, maxEdge, depth + 1);
    return;
  }
  const va = groundVertex(kit, gb, a.x, a.z, lift, color);
  const vb = groundVertex(kit, gb, b.x, b.z, lift, color);
  const vc = groundVertex(kit, gb, c.x, c.z, lift, color);
  gb.triFacing(va, vb, vc, 0, 1, 0);
}

/**
 * A box standing behind a wall segment (on the side opposite its normal):
 * `thick` deep, from `y0` above the lower ground at its ends up to `height`.
 * Pass y0 < 0 to sink it. Absolute top when `absTop` is given.
 */
export function wallBox(kit: DistrictKit, gb: GeoBuilder, w: Wall, thick: number, height: number, color: THREE.Color, y0 = -0.3, absTop?: number): void {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  if (len < 0.05) return;
  const steps = Math.max(1, Math.ceil(len / 8));
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const ax = w.ax + (w.bx - w.ax) * t0;
    const az = w.az + (w.bz - w.az) * t0;
    const bx = w.ax + (w.bx - w.ax) * t1;
    const bz = w.az + (w.bz - w.az) * t1;
    const base = Math.min(kit.h(ax, az), kit.h(bx, bz));
    const top = absTop ?? Math.max(kit.h(ax, az), kit.h(bx, bz)) + height;
    orientedBox(gb, ax, az, bx, bz, -w.nx * thick, -w.nz * thick, base + y0, top, color);
  }
}

/** Box with one long face on segment a-b and depth along (ox, oz). */
export function orientedBox(gb: GeoBuilder, ax: number, az: number, bx: number, bz: number, ox: number, oz: number, y0: number, y1: number, color: THREE.Color): void {
  const pts = [
    [ax, az],
    [bx, bz],
    [bx + ox, bz + oz],
    [ax + ox, az + oz],
  ];
  const mx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const mz = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    let nx = q[1] - p[1];
    let nz = -(q[0] - p[0]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((p[0] + q[0]) / 2 - mx) * nx + ((p[1] + q[1]) / 2 - mz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const sl = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const a = gb.vertex(p[0], y0, p[1], nx, 0, nz, 0, 0, color);
    const b = gb.vertex(q[0], y0, q[1], nx, 0, nz, sl / 4, 0, color);
    const c = gb.vertex(q[0], y1, q[1], nx, 0, nz, sl / 4, (y1 - y0) / 4, color);
    const d = gb.vertex(p[0], y1, p[1], nx, 0, nz, 0, (y1 - y0) / 4, color);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  }
  tmp.copy(color).multiplyScalar(1.15);
  const t = pts.map(([x, z]) => gb.vertex(x, y1, z, 0, 1, 0, x / 4, z / 4, tmp));
  gb.quadFacing(t[0], t[1], t[2], t[3], 0, 1, 0);
}

/** Vertical prism over a polygon (sides + top) from the ground up to `height`. */
export function prism(kit: DistrictKit, gb: GeoBuilder, poly: Vec2[], height: number, side: THREE.Color, top: THREE.Color, sink = 0.3): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of poly) {
    const y = kit.h(p.x, p.z);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  const y0 = lo - sink;
  const y1 = hi + height;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / poly.length;
    cz += p.z / poly.length;
  }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    let nx = q.z - p.z;
    let nz = -(q.x - p.x);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((p.x + q.x) / 2 - cx) * nx + ((p.z + q.z) / 2 - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const a = gb.vertex(p.x, y0, p.z, nx, 0, nz, 0, 0, side);
    const b = gb.vertex(q.x, y0, q.z, nx, 0, nz, 1, 0, side);
    const c = gb.vertex(q.x, y1, q.z, nx, 0, nz, 1, 1, side);
    const d = gb.vertex(p.x, y1, p.z, nx, 0, nz, 0, 1, side);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  }
  const center = gb.vertex(cx, y1, cz, 0, 1, 0, 0, 0, top);
  const ring = poly.map((p) => gb.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, top));
  for (let i = 0; i < ring.length; i++) gb.triFacing(center, ring[i], ring[(i + 1) % ring.length], 0, 1, 0);
}

/** Open or capped cylinder (n sides) standing at (x, z) from y0 to y1 (absolute). */
export function cylinder(gb: GeoBuilder, x: number, z: number, r: number, y0: number, y1: number, n: number, color: THREE.Color, cap = true, r1 = r): void {
  const ring0: number[] = [];
  const ring1: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ring0.push(gb.vertex(x + c * r, y0, z + s * r, c, 0, s, i / n, 0, color));
    ring1.push(gb.vertex(x + c * r1, y1, z + s * r1, c, 0, s, i / n, 1, color));
  }
  for (let i = 0; i < n; i++) {
    const a = (((i + 0.5) / n) * Math.PI * 2);
    gb.quadFacing(ring0[i], ring0[i + 1], ring1[i + 1], ring1[i], Math.cos(a), 0, Math.sin(a));
  }
  if (!cap) return;
  const c = gb.vertex(x, y1, z, 0, 1, 0, 0, 0, color);
  const top: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    top.push(gb.vertex(x + Math.cos(a) * r1, y1, z + Math.sin(a) * r1, 0, 1, 0, 0, 0, color));
  }
  for (let i = 0; i < n; i++) gb.triFacing(c, top[i], top[(i + 1) % n], 0, 1, 0);
}

/** Flat strip on the ground from a to b (paint lines). */
export function groundLine(kit: DistrictKit, gb: GeoBuilder, a: Vec2, b: Vec2, width: number, lift: number, color: THREE.Color): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 0.05) return;
  const nx = (-(b.z - a.z) / len) * (width / 2);
  const nz = ((b.x - a.x) / len) * (width / 2);
  const v = [
    groundVertex(kit, gb, a.x + nx, a.z + nz, lift, color),
    groundVertex(kit, gb, b.x + nx, b.z + nz, lift, color),
    groundVertex(kit, gb, b.x - nx, b.z - nz, lift, color),
    groundVertex(kit, gb, a.x - nx, a.z - nz, lift, color),
  ];
  gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
}

/** Route shortcut bulbs: hot pink with amber, the shortcut sign's colours (the alleys, the river's ramp mouths, the car parks' entries). */
export const SHORTCUT_BULBS = [col(0xff4fd8, 2.2), col(0xffb35c, 2.3), col(0xff2bd6, 2), col(0xffd08a, 2.1)];
const STRING_POOL = col(0xff7ab8, 1);

/** How a string of lights hangs: on two posts of `post` m standing on the ground, or between the heights `ya` and `yb` (hung from a structure). */
export interface StringLightsOpts {
  post?: number;
  ya?: number;
  yb?: number;
  /** Sag of the wire in the middle (m) and bulb spacing (m). */
  sag?: number;
  step?: number;
  /** An additive builder for a pool of the bulbs' light on the ground under the wire (none without). */
  pools?: GeoBuilder;
}

/**
 * A string of the shortcut bulbs from a to b: posts (or the given heights), a sagging wire, bulbs in
 * the shared glow builder, and a pool of their light on the ground when `pools` is given.
 */
export function stringLights(kit: DistrictKit, a: Vec2, b: Vec2, opts: StringLightsOpts = {}): void {
  const post = opts.post ?? 5.4;
  const sag = opts.sag ?? 0.7;
  const step = opts.step ?? 0.55;
  const pole = col(0x6a6e76);
  const wire = col(0x101114);
  const y0 = opts.ya ?? kit.h(a.x, a.z) + post;
  const y1 = opts.yb ?? kit.h(b.x, b.z) + post;
  if (opts.ya === undefined) cylinder(kit.solid, a.x, a.z, 0.07, y0 - post - 0.3, y0 + 0.1, 6, pole, true);
  if (opts.yb === undefined) cylinder(kit.solid, b.x, b.z, 0.07, y1 - post - 0.3, y1 + 0.1, 6, pole, true);
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(2, Math.round(span / step));
  let px = a.x;
  let pz = a.z;
  let py = y0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    const y = y0 + (y1 - y0) * t - sag * 4 * t * (1 - t);
    if (i > 0) cylinder(kit.solid, (x + px) / 2, (z + pz) / 2, 0.012, Math.min(y, py) - 0.012, Math.max(y, py) + 0.012, 3, wire, false);
    if (i > 0 && i < n) cylinder(kit.glow, x, z, 0.07, y - 0.13, y, 5, SHORTCUT_BULBS[(i * 7) % SHORTCUT_BULBS.length]);
    px = x;
    pz = z;
    py = y;
  }
  if (!opts.pools) return;
  // The pool: an additive strip under the wire, brightest in the middle.
  const pools = opts.pools;
  const ux = (b.x - a.x) / span;
  const uz = (b.z - a.z) / span;
  const half = 3.2;
  const N = 6;
  const ids: number[] = [];
  for (let j = 0; j <= 2; j++) {
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const c = (j - 1) * half;
      const x = a.x + (b.x - a.x) * t - uz * c;
      const z = a.z + (b.z - a.z) * t + ux * c;
      const bright = j === 1 ? 0.5 * Math.sin(Math.PI * t) : 0;
      ids.push(pools.vertex(x, kit.h(x, z) + 0.06, z, 0, 1, 0, 0, 0, STRING_POOL.clone().multiplyScalar(bright)));
    }
  }
  for (let j = 0; j < 2; j++) for (let i = 0; i < N; i++) pools.quadFacing(ids[j * (N + 1) + i], ids[j * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i], 0, 1, 0);
}
