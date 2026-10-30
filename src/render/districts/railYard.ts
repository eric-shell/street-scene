/**
 * Weekend special renderer: the rail yard (city/districts/railYard.ts).
 *
 * Everything is read from the area's hints and the walls of its looks, appended into the shared kit's
 * merged builders (ground, solid, paint, glow, hazard), so the whole yard costs one draw call of its own
 * for the freight cars (the side atlas, railYardCars.ts), one for the light pools (Medium and up), and
 * nothing per frame but the switcher's pose:
 *  - the ground: gravel with a dusty concrete apron behind the gates, laid as a grid draped on the
 *    terrain with breakpoints where the shapes bend (the dock's bevel and ramps, the ridge's slopes, the
 *    bank), concrete on the dock, asphalt on the bank, cobbles across each gate mouth;
 *  - the tracks: ballast beds, ties (Medium and up) and rails, all paint a few cm up;
 *  - the freight: one textured mesh of cars on the consists the sim has as solids (look railcar);
 *  - the walls of look yardFence, by what each solid is: the corrugated steel fence round the back and
 *    ends, steel gate posts with a lantern (and, Medium and up, a pool of its light on the sidewalk), the
 *    sliding gate leaves stood open, dwarf signal posts with their lamps, the dock face's bumper rail,
 *    the concrete crash barrier along the bank's crest;
 *  - light: four floodlight towers behind the back fence whose floods light pools on the yard (they
 *    are what makes it read from the street), a yard tower with a lit cab, amber lamps flush on the
 *    ridge's crest (the hazard blink the city's jump lips use).
 * No sign and no arrow: the cobbles, the lanterns and the gap in the fence are the way in.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { AreaHint } from '../../city/districts/types';
import type { Wall } from '../../city/blocks';
import type { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import { makeRadialGlow } from '../textures/textures';
import { makeYardAtlas } from '../textures/yardTextures';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundVertex, prism } from './kit';
import { addCar, carMaterial } from './railYardCars';

const C = CITY.districts.railYard;

/** One block's rectangle and zones, unpacked from its 'yard' hint. */
interface Yard {
  o: Vec2;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  L: number;
  D: number;
  apron: number;
  n: number;
  pitch: number;
  vFirst: number;
  dockFace: number;
  dockU0: number;
  dockU1: number;
  ramp: number;
  humpUc: number;
  humpRun: number;
  humpV0: number;
  humpV1: number;
  loopCu: number;
  loopR: number;
  loopVmid: number;
  trackU1: number;
  i: number;
}

function unpack(h: AreaHint): Yard {
  const v = h.values;
  return { o: h.points[0], ux: v[0], uz: v[1], vx: v[2], vz: v[3], L: v[4], D: v[5], apron: v[6], n: v[7], pitch: v[8], vFirst: v[9], dockFace: v[10], dockU0: v[11], dockU1: v[12], ramp: v[13], humpUc: v[14], humpRun: v[15], humpV0: v[16], humpV1: v[17], loopCu: v[18], loopR: v[19], loopVmid: v[20], trackU1: v[21], i: v[22] };
}

const pt = (Y: Yard, u: number, v: number): Vec2 => ({ x: Y.o.x + Y.ux * u + Y.vx * v, z: Y.o.z + Y.uz * u + Y.vz * v });

/** Cheap deterministic hash in [0, 1) for colour noise. */
function hash(a: number, b: number): number {
  let h = Math.imul(Math.round(a * 8) | 0, 374761393) ^ Math.imul(Math.round(b * 8) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const GRAVEL = col(0x3b372f);
const GRAVEL_LIGHT = col(0x4a453c);
const APRON = col(0x4b4a48);
const DOCK_TOP = col(0x77777a);
const DOCK_FACE = col(0x57585c);
const ASPHALT = col(0x2f3135);
const COBBLE = col(0x5a5d66);

const tmp = new THREE.Color();

/** Sorted, de-duplicated breakpoints over [0, len]: every `step` m and the extras that fall inside. */
function breaks(len: number, step: number, extras: number[]): number[] {
  const set = new Set<number>([0, len]);
  const n = Math.ceil(len / step);
  for (let k = 1; k < n; k++) set.add((len * k) / n);
  for (const e of extras) if (e > 0.01 && e < len - 0.01) set.add(Math.round(e * 100) / 100);
  return [...set].sort((a, b) => a - b);
}

/** The ground of one block: a grid over the rectangle, draped, coloured by what the spot is. */
function ground(kit: DistrictKit, Y: Yard): void {
  const uex: number[] = [];
  const vex: number[] = [Y.apron, Y.vFirst - 1.5, Y.vFirst + 1.5];
  if (Y.dockFace >= 0) {
    uex.push(Y.dockU0, Y.dockU0 + Y.ramp * 0.3, Y.dockU0 + Y.ramp * 0.7, Y.dockU0 + Y.ramp, Y.dockU1 - Y.ramp, Y.dockU1 - Y.ramp * 0.7, Y.dockU1 - Y.ramp * 0.3, Y.dockU1);
    vex.push(Y.dockFace, Y.dockFace + C.dock.ease * 0.33, Y.dockFace + C.dock.ease * 0.66, Y.dockFace + C.dock.ease, Y.D, Y.D + 0.0);
  }
  if (Y.humpUc >= 0) {
    const ext = C.hump.top / 2 + Y.humpRun;
    for (let k = 0; k <= 8; k++) {
      uex.push(Y.humpUc - ext + (Y.humpRun * k) / 8, Y.humpUc + ext - (Y.humpRun * k) / 8);
    }
    uex.push(Y.humpUc - C.hump.top / 2, Y.humpUc + C.hump.top / 2);
    vex.push(Y.humpV0, Y.humpV0 + C.hump.edge / 2, Y.humpV0 + C.hump.edge, Y.humpV1 - C.hump.edge, Y.humpV1 - C.hump.edge / 2, Y.humpV1);
  }
  if (Y.loopCu >= 0) uex.push(Y.loopCu, Y.loopCu + Y.loopR * 0.5);
  const us = breaks(Y.L, 3.2, uex);
  const vs = breaks(Y.D, 3.2, vex);
  const ids: number[] = [];
  const g = kit.ground;
  const colorAt = (u: number, v: number): THREE.Color => {
    const noise = 0.82 + hash(u, v) * 0.36;
    let base = GRAVEL;
    if (Y.loopCu >= 0 && u >= Y.loopCu - 0.01) {
      const d = Math.hypot(u - Y.loopCu, v - Y.loopVmid);
      if (d <= Y.loopR + 0.5 && d >= Y.loopR - 0.6 - C.bank.rise - 0.5) base = ASPHALT;
    }
    if (Y.dockFace >= 0 && u >= Y.dockU0 && u <= Y.dockU1 && v >= Y.dockFace) base = v < Y.dockFace + C.dock.ease * 1.05 ? DOCK_FACE : DOCK_TOP;
    else if (v < Y.apron) base = APRON;
    else if (hash(Math.floor(u / 6), Math.floor(v / 6)) > 0.7) base = GRAVEL_LIGHT;
    return tmp.copy(base).multiplyScalar(noise);
  };
  for (const v of vs) {
    for (const u of us) {
      const p = pt(Y, u, v);
      ids.push(groundVertex(kit, g, p.x, p.z, 0.02, colorAt(u, v), 4));
    }
  }
  const W = us.length;
  for (let j = 0; j + 1 < vs.length; j++) {
    for (let i = 0; i + 1 < us.length; i++) g.quadFacing(ids[j * W + i], ids[j * W + i + 1], ids[(j + 1) * W + i + 1], ids[(j + 1) * W + i], 0, 1, 0);
  }
}

/** A strip along u at across-offset v (width w), from u0 to u1, draped at `lift`. */
function strip(kit: DistrictKit, gb: GeoBuilder, Y: Yard, v: number, w: number, u0: number, u1: number, lift: number, color: THREE.Color, step = 3): void {
  const n = Math.max(1, Math.ceil((u1 - u0) / step));
  let prevA = -1;
  let prevB = -1;
  for (let k = 0; k <= n; k++) {
    const u = u0 + ((u1 - u0) * k) / n;
    const a = pt(Y, u, v - w / 2);
    const b = pt(Y, u, v + w / 2);
    const ia = groundVertex(kit, gb, a.x, a.z, lift, color);
    const ib = groundVertex(kit, gb, b.x, b.z, lift, color);
    if (prevA >= 0) gb.quadFacing(prevA, prevB, ib, ia, 0, 1, 0);
    prevA = ia;
    prevB = ib;
  }
}

/** Ballast bed, ties (Medium and up) and rails of every track of a block. */
function tracks(kit: DistrictKit, Y: Yard): void {
  const R = C.rail;
  const bed = col(0x4a443b);
  const tie = col(0x2c241e);
  const steel = col(0x8e9299);
  const u1 = Y.trackU1;
  for (let t = 0; t < Y.n; t++) {
    const v = Y.vFirst + t * Y.pitch;
    strip(kit, kit.paint, Y, v, R.ballast, 2, u1, 0.012, bed, 4);
    if (kit.quality !== 'low') {
      for (let u = 2.2; u < u1 - 0.3; u += R.tiePitch) {
        const a = pt(Y, u, v - R.tie[0] / 2);
        const b = pt(Y, u, v + R.tie[0] / 2);
        const c = pt(Y, u + R.tie[1], v + R.tie[0] / 2);
        const d = pt(Y, u + R.tie[1], v - R.tie[0] / 2);
        const q = [a, b, c, d].map((p) => groundVertex(kit, kit.paint, p.x, p.z, 0.026, tie));
        kit.paint.quadFacing(q[0], q[1], q[2], q[3], 0, 1, 0);
      }
    }
    for (const s of [-1, 1]) strip(kit, kit.paint, Y, v + (s * R.gauge) / 2, R.head, 2, u1, 0.045, steel, 2.5);
  }
}

/** Pool of light on the ground: a draped grid textured with the radial glow (as the roadworks' light towers). */
function pool(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, r: number, color: THREE.Color): void {
  const N = 6;
  const ids: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const px = x + (i / N - 0.5) * 2 * r;
      const pz = z + (j / N - 0.5) * 2 * r;
      ids.push(gb.vertex(px, kit.h(px, pz) + 0.09, pz, 0, 1, 0, i / N, j / N, color));
    }
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) gb.quadFacing(ids[j * (N + 1) + i], ids[j * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i], 0, 1, 0);
}

/** A solid's outline: its faces' first points. */
const outline = (w: Wall): Vec2[] => w.solid!.faces.map((f) => ({ x: f.ax, z: f.az }));

/** Split a thin rectangle into pieces no longer than `step` along its long axis, as polygons. */
function pieces(poly: Vec2[], step: number): Vec2[][] {
  const l01 = Math.hypot(poly[1].x - poly[0].x, poly[1].z - poly[0].z);
  const l12 = Math.hypot(poly[2].x - poly[1].x, poly[2].z - poly[1].z);
  const [a, b, c, d] = l01 >= l12 ? [poly[0], poly[1], poly[2], poly[3]] : [poly[1], poly[2], poly[3], poly[0]];
  const len = Math.max(l01, l12);
  const n = Math.max(1, Math.ceil(len / step));
  const out: Vec2[][] = [];
  const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => ({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
  for (let k = 0; k < n; k++) out.push([lerp(a, b, k / n), lerp(a, b, (k + 1) / n), lerp(d, c, (k + 1) / n), lerp(d, c, k / n)]);
  return out;
}

const dims = (poly: Vec2[]): { len: number; thick: number } => {
  const l01 = Math.hypot(poly[1].x - poly[0].x, poly[1].z - poly[0].z);
  const l12 = Math.hypot(poly[2].x - poly[1].x, poly[2].z - poly[1].z);
  return { len: Math.max(l01, l12), thick: Math.min(l01, l12) };
};

/** Every yardFence solid, by what it is (see the header). */
function fences(kit: DistrictKit, banks: { c: Vec2; R: number }[], lamps: Vec2[]): void {
  const walls = kit.walls.get('yardFence') ?? [];
  const seen = new Set<object>();
  const g = kit.solid;
  const fenceSide = col(0x39434d);
  const fenceTop = col(0x1f252b);
  const post = col(0x23282e);
  for (const w of walls) {
    if (!w.solid || seen.has(w.solid)) continue;
    seen.add(w.solid);
    const poly = outline(w);
    if (poly.length !== 4) continue;
    const { len, thick } = dims(poly);
    const mx = poly.reduce((s, p) => s + p.x, 0) / 4;
    const mz = poly.reduce((s, p) => s + p.z, 0) / 4;
    if (w.top !== undefined) {
      // The dock face: a low concrete bumper rail along its foot, a yellow top.
      for (const piece of pieces(poly, 5)) prism(kit, g, piece, 0.55, col(0x6c6e72), col(0xe2b520), 0.25);
    } else if (len <= 1.2 && thick <= 1.2) {
      if (len >= 0.8) {
        // A steel gate post and its lantern.
        prism(kit, g, poly, 3.4, col(0x4b505a), col(0x30343a), 0.3);
        const y = kit.h(mx, mz) + 3.4;
        cylinder(kit.glow, mx, mz, 0.26, y + 0.02, y + 0.42, 8, col(0xffe2b0, 3.4));
        lamps.push({ x: mx, z: mz });
      } else {
        prism(kit, g, poly, 1.1, col(0x2a2d32), col(0x1a1b1e), 0.2);
      }
    } else if (len <= 5.4 && thick <= 0.35) {
      // A sliding gate stood open: a galvanized frame, a top rail.
      for (const piece of pieces(poly, 5)) prism(kit, g, piece, 2.2, col(0x5d646e), col(0x3b4047), 0.2);
    } else if (banks.some((b) => Math.abs(Math.hypot(mx - b.c.x, mz - b.c.z) - b.R) < 1.2)) {
      // The bank's crash barrier: concrete, a pale cap.
      prism(kit, g, poly, 1.25, col(0xa6a49c), col(0x85837c), 0.4);
    } else {
      for (const piece of pieces(poly, 6)) prism(kit, g, piece, 2.4, fenceSide, fenceTop, 0.25);
      // Posts every few metres.
      const n = Math.max(1, Math.floor(len / 3));
      const l01 = Math.hypot(poly[1].x - poly[0].x, poly[1].z - poly[0].z);
      const longEdge = l01 >= Math.hypot(poly[2].x - poly[1].x, poly[2].z - poly[1].z);
      const a = longEdge ? poly[0] : poly[1];
      const b = longEdge ? poly[1] : poly[2];
      const d = longEdge ? poly[3] : poly[0];
      const nx = (d.x - a.x) * 0.5;
      const nz = (d.z - a.z) * 0.5;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t + nx;
        const z = a.z + (b.z - a.z) * t + nz;
        prism(kit, g, [{ x: x - 0.14, z: z - 0.14 }, { x: x + 0.14, z: z - 0.14 }, { x: x + 0.14, z: z + 0.14 }, { x: x - 0.14, z: z + 0.14 }], 2.75, post, post, 0.2);
      }
    }
  }
}

/** A floodlight tower: a tapering mast, a head bar with six floods aimed along `f`. */
function floodTower(kit: DistrictKit, pools: GeoBuilder | null, p: Vec2, mast: number, f: Vec2, across: Vec2): void {
  const y = kit.h(p.x, p.z);
  const steel = col(0x6a6e76);
  const dark = col(0x1c1e22);
  cylinder(kit.solid, p.x, p.z, 0.42, y - 0.3, y + mast, 8, steel, true, 0.2);
  cylinder(kit.solid, p.x, p.z, 0.7, y - 0.3, y + 0.5, 8, col(0x5a5a58), true);
  const top = y + mast;
  const head = (a: number, h: number) => ({ x: p.x + across.x * a + f.x * 0.6, z: p.z + across.z * a + f.z * 0.6, y: top + h });
  // The bar and the floods.
  for (const a of [-1.6, 0, 1.6]) {
    const q = head(a, -0.2);
    cylinder(kit.solid, q.x, q.z, 0.3, q.y - 0.5, q.y + 0.4, 6, dark);
  }
  for (const a of [-2.0, -1.2, -0.4, 0.4, 1.2, 2.0]) {
    for (const row of [0, 1]) {
      const q = head(a, row * 0.7 - 0.1);
      const gx = q.x + f.x * 0.32;
      const gz = q.z + f.z * 0.32;
      cylinder(kit.glow, gx, gz, 0.2, q.y - 0.2, q.y + 0.2, 6, col(0xfff3dc, 3.6));
    }
  }
  if (pools) {
    pool(kit, pools, p.x + f.x * 26, p.z + f.z * 26, C.lights.pool, col(0xfff0d8, 0.34));
    pool(kit, pools, p.x + f.x * 52, p.z + f.z * 52, C.lights.pool * 0.8, col(0xfff0d8, 0.22));
  }
}

/** The yard tower: four legs, a cab with a lit window wall facing the yard, a roof and a stair. */
function yardTower(kit: DistrictKit, p: Vec2, h: number, f: Vec2, across: Vec2): void {
  const y = kit.h(p.x, p.z);
  const steel = col(0x555a63);
  const cab = col(0x6b6d72);
  const legs = [-1.5, 1.5];
  for (const a of legs) for (const b of legs) cylinder(kit.solid, p.x + across.x * a + f.x * b, p.z + across.z * a + f.z * b, 0.17, y - 0.2, y + h - 0.2, 6, steel);
  // Braces: a ring of rails at two heights.
  for (const hy of [h * 0.35, h * 0.7]) {
    for (const a of legs) {
      cylinder(kit.solid, p.x + across.x * a, p.z + across.z * a, 0.07, y + hy, y + hy + 0.1, 5, steel);
    }
  }
  const quad = (a0: number, a1: number, b0: number, b1: number): Vec2[] => [
    { x: p.x + across.x * a0 + f.x * b0, z: p.z + across.z * a0 + f.z * b0 },
    { x: p.x + across.x * a1 + f.x * b0, z: p.z + across.z * a1 + f.z * b0 },
    { x: p.x + across.x * a1 + f.x * b1, z: p.z + across.z * a1 + f.z * b1 },
    { x: p.x + across.x * a0 + f.x * b1, z: p.z + across.z * a0 + f.z * b1 },
  ];
  // The cab: a box (prism from the ground would reach the legs: it stands on a deck at height h).
  const cabY = y + h;
  const deck = quad(-2.4, 2.4, -2.1, 2.1);
  const poly = deck;
  const baseY = cabY;
  // Build the cab's walls by hand at absolute heights.
  const g = kit.solid;
  const wall = (a: Vec2, b: Vec2, y0: number, y1: number, color: THREE.Color) => {
    const nx = -(b.z - a.z);
    const nz = b.x - a.x;
    const l = Math.hypot(nx, nz) || 1;
    const va = g.vertex(a.x, y0, a.z, nx / l, 0, nz / l, 0, 0, color);
    const vb = g.vertex(b.x, y0, b.z, nx / l, 0, nz / l, 1, 0, color);
    const vc = g.vertex(b.x, y1, b.z, nx / l, 0, nz / l, 1, 1, color);
    const vd = g.vertex(a.x, y1, a.z, nx / l, 0, nz / l, 0, 1, color);
    g.quadFacing(va, vb, vc, vd, nx / l, 0, nz / l);
    g.quadFacing(vb, va, vd, vc, -nx / l, 0, -nz / l);
  };
  const cabPoly = quad(-2.1, 2.1, -1.7, 1.7);
  for (let i = 0; i < 4; i++) wall(cabPoly[i], cabPoly[(i + 1) % 4], baseY + 0.05, baseY + 2.5, cab);
  // The deck and the roof.
  for (const [yy, pp, color] of [[baseY - 0.05, poly, steel], [baseY + 2.5, quad(-2.5, 2.5, -2.1, 2.1), col(0x3a3d43)]] as const) {
    const ids = pp.map((q) => g.vertex(q.x, yy + 0.05, q.z, 0, 1, 0, 0, 0, color));
    g.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    const ids2 = pp.map((q) => g.vertex(q.x, yy, q.z, 0, -1, 0, 0, 0, color));
    g.quadFacing(ids2[3], ids2[2], ids2[1], ids2[0], 0, -1, 0);
  }
  // The window wall: warm glow bands facing the yard.
  for (const a of [-1.5, -0.45, 0.6]) {
    const win = quad(a, a + 0.85, 1.74, 1.74);
    const ids = win.map((q, k) => kit.glow.vertex(q.x, baseY + (k < 2 ? 1.1 : 2.1), q.z, f.x, 0, f.z, 0, 0, col(0xffd596, 2.3)));
    kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], f.x, 0, f.z);
  }
  // A stair up the side: a slanted strip of steel.
  const s0 = quad(2.55, 3.15, -1.0, 1.0);
  const sa = s0.map((q, k) => g.vertex(q.x, k < 2 ? y : cabY, q.z, 0, 1, 0, 0, 0, steel));
  g.quadFacing(sa[0], sa[1], sa[2], sa[3], 0, 1, 0);
  g.quadFacing(sa[3], sa[2], sa[1], sa[0], 0, -1, 0);
}

export const railYardRenderer: DistrictRenderer = {
  kinds: ['railYard'],
  build(kit, areas) {
    const low = kit.quality === 'low';
    const pools = low ? null : new GeoBuilder(true);
    const cars = new GeoBuilder(true);
    const banks: { c: Vec2; R: number }[] = [];
    const lamps: Vec2[] = [];
    for (const a of areas) {
      const hints = kit.builds[a.id]?.hints ?? [];
      const yards = hints.filter((h) => h.kind === 'yard').map(unpack);
      for (const Y of yards) {
        ground(kit, Y);
        tracks(kit, Y);
        // Cobbles across each gate mouth: a checker of two greys from the sidewalk onto the apron.
      }
      for (const h of hints) {
        if (h.kind === 'gate') {
          const [mu, w, , , , , , walk] = h.values;
          const Y = yardAt(yards, h.points[0]);
          const cols = Math.max(2, Math.round(w / 1.2));
          const rows = Math.round((C.mouth.depth + walk) / 1.2);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const u0 = mu - w / 2 + (w * c) / cols;
              const u1 = mu - w / 2 + (w * (c + 1)) / cols;
              const v0 = -walk + 0.2 + ((C.mouth.depth + walk - 0.2) * r) / rows;
              const v1 = -walk + 0.2 + ((C.mouth.depth + walk - 0.2) * (r + 1)) / rows;
              const color = tmp.copy(COBBLE).multiplyScalar(0.8 + hash(c * 3 + 1, r * 7 + 2) * 0.4);
              const q = [pt(Y, u0, v0), pt(Y, u1, v0), pt(Y, u1, v1), pt(Y, u0, v1)].map((p) => groundVertex(kit, kit.paint, p.x, p.z, 0.02, color));
              kit.paint.quadFacing(q[0], q[1], q[2], q[3], 0, 1, 0);
            }
          }
        } else if (h.kind === 'car') {
          const [ux, uz, len, kind, tex] = h.values;
          addCar(kit, cars, kit.glow, h.points[0], ux, uz, -uz, ux, len, kind, tex, !low);
        } else if (h.kind === 'bank') {
          const [rOut, , hold] = h.values;
          banks.push({ c: h.points[0], R: rOut + hold / 2 });
        } else if (h.kind === 'tower') {
          const [kind, height, fx, fz, ax, az] = h.values;
          if (kind === 0) floodTower(kit, pools, h.points[0], height, { x: fx, z: fz }, { x: ax, z: az });
          else yardTower(kit, h.points[0], height, { x: fx, z: fz }, { x: ax, z: az });
        } else if (h.kind === 'signal') {
          const p = h.points[0];
          const y = kit.h(p.x, p.z) + 1.1;
          const colors = [col(0xff2a1a, 3.2), col(0xffb020, 3), col(0x30ff70, 2.8)];
          cylinder(kit.glow, p.x, p.z, 0.1, y, y + 0.16, 8, colors[h.values[0] % 3]);
        } else if (h.kind === 'hump') {
          // Flush amber studs along both crest edges, the hazard blink the city's jump lips use.
          const [top, , , , , , , v0, v1] = h.values;
          const Y = yardAt(yards, h.points[0]);
          const uc = Y.humpUc;
          for (const s of [-1, 1]) {
            for (let v = v0 + C.hump.edge + 1; v <= v1 - C.hump.edge - 1; v += 3.5) {
              const p = pt(Y, uc + (s * top) / 2, v);
              const y = kit.h(p.x, p.z);
              cylinder(kit.hazard, p.x, p.z, 0.17, y + 0.02, y + 0.07, 8, col(0xffa020));
            }
          }
        }
      }
    }
    fences(kit, banks, lamps);
    if (pools) for (const p of lamps) pool(kit, pools, p.x, p.z, 8, col(0xffd8a0, 0.2));
    if (cars.vertexCount) {
      const mesh = new THREE.Mesh(kit.track(cars.build()), carMaterial(kit, kit.track(makeYardAtlas())));
      mesh.name = 'railYardCars';
      kit.group.add(mesh);
    }
    if (pools?.vertexCount) {
      const mat = kit.track(new THREE.MeshBasicMaterial({ map: kit.track(makeRadialGlow()), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      const mesh = new THREE.Mesh(kit.track(pools.build()), mat);
      mesh.name = 'railYardLightPools';
      mesh.renderOrder = 1;
      kit.group.add(mesh);
    }
  },
};

/** The yard (block) whose rectangle holds p, else the first. */
function yardAt(yards: Yard[], p: Vec2): Yard {
  for (const Y of yards) {
    const u = (p.x - Y.o.x) * Y.ux + (p.z - Y.o.z) * Y.uz;
    const v = (p.x - Y.o.x) * Y.vx + (p.z - Y.o.z) * Y.vz;
    if (u >= -1 && u <= Y.L + 1 && v >= -4 && v <= Y.D + 1) return Y;
  }
  return yards[0];
}
