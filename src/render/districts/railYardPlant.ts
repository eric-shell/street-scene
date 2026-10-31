/**
 * The rail yard's built pieces (render only; city/districts/railYardLayout.ts places them): the overbridge (ramps
 * between retaining walls, the deck slab on its piers, concrete parapets with the missing bay, lamps), the buildings
 * (the freight house with its awning over the dock, the diesel shop, the sand tower, the yard tower), the gantry crane
 * over the transfer pad, the container stacks, the signal gantries over the throat road, the floodlight towers, and the
 * small steel (retarders, switch stands, the water column, fence posts, the bank's barrier, the dock's bumper rail).
 * Everything goes into the kit's shared builders (solid, glow, hazard), so the yard's plant costs no draw call of its own;
 * the floods' pools of light go into the renderer's pool builder (Medium and up).
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Vec2 } from '../../sim/math';
import type { YardLayout, YardSolid } from '../../city/districts/railYardLayout';
import { bridgeLevel, bridgePoint } from '../../city/districts/railYardBridge';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit } from './kit';
import { col, cylinder, prism } from './kit';

const C = CITY.districts.railYard;
const B = C.bridge;

const CONCRETE = col(0x8d8a84);
const CONCRETE_DARK = col(0x5f5d59);
const ASPHALT = col(0x2c2e33);
const STEEL = col(0x5a5f68);
const STEEL_DARK = col(0x2a2d32);
const RUST = col(0x7a4a2c);
const YELLOW = col(0xd8a820);

/** A box over a convex polygon between absolute heights y0 and y1: sides and top (and the underside when `under`). */
export function slab(gb: GeoBuilder, poly: readonly Vec2[], y0: number, y1: number, side: THREE.Color, top: THREE.Color, under = false): void {
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
  const t = poly.map((p) => gb.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, top));
  for (let i = 1; i + 1 < t.length; i++) gb.triFacing(t[0], t[i], t[i + 1], 0, 1, 0);
  if (under) {
    const u = poly.map((p) => gb.vertex(p.x, y0, p.z, 0, -1, 0, 0, 0, side));
    for (let i = 1; i + 1 < u.length; i++) gb.triFacing(u[0], u[i + 1], u[i], 0, -1, 0);
  }
}

/** A quad strip between two polylines at per-point heights (the bridge's road and its walls). */
function ribbon(gb: GeoBuilder, a: readonly Vec2[], b: readonly Vec2[], ya: readonly number[], yb: readonly number[], color: THREE.Color, ny = 1): void {
  for (let i = 0; i + 1 < a.length; i++) {
    const nx = 0;
    const p = [gb.vertex(a[i].x, ya[i], a[i].z, nx, ny, 0, 0, 0, color), gb.vertex(a[i + 1].x, ya[i + 1], a[i + 1].z, nx, ny, 0, 0, 0, color), gb.vertex(b[i + 1].x, yb[i + 1], b[i + 1].z, nx, ny, 0, 0, 0, color), gb.vertex(b[i].x, yb[i], b[i].z, nx, ny, 0, 0, 0, color)];
    // Facing: up for a road, sideways for a wall (its normal from the cross product).
    const ux = a[i + 1].x - a[i].x;
    const uy = ya[i + 1] - ya[i];
    const uz = a[i + 1].z - a[i].z;
    const vx = b[i].x - a[i].x;
    const vy = yb[i] - ya[i];
    const vz = b[i].z - a[i].z;
    let fx = uy * vz - uz * vy;
    let fy = uz * vx - ux * vz;
    let fz = ux * vy - uy * vx;
    const l = Math.hypot(fx, fy, fz) || 1;
    fx /= l;
    fy /= l;
    fz /= l;
    if (ny > 0 ? fy < 0 : ny < 0 ? fy > 0 : false) {
      fx = -fx;
      fy = -fy;
      fz = -fz;
    }
    gb.quadFacing(p[0], p[1], p[2], p[3], fx, fy, fz);
    if (ny === 0) gb.quadFacing(p[3], p[2], p[1], p[0], -fx, -fy, -fz);
  }
}

const LV = { h: 0, d: 0 };

/** The overbridge: road, deck slab, ramps' retaining walls, parapets, piers, lamps. */
export function drawBridge(kit: DistrictKit, lay: YardLayout): void {
  const b = lay.bridge;
  const g = kit.solid;
  const n = b.pts.length;
  const level = b.cum.map((s) => bridgeLevel(b, s, LV).h);
  const ground = (p: Vec2) => kit.h(p.x, p.z) - 0.4;
  const onRamp = (i: number) => b.cum[i] <= b.R + 1e-6 || b.cum[i] >= b.S - b.R - 1e-6;
  // The road and the slab under it: asphalt on top, a concrete underside B.deck below (the ramps go down to the ground).
  ribbon(g, b.right, b.left, level.map((h) => h + 0.02), level.map((h) => h + 0.02), ASPHALT, 1);
  const under = level.map((h, i) => (onRamp(i) ? Math.min(h, ground(b.pts[i])) : h - B.deck));
  ribbon(g, b.leftOut, b.rightOut, under, under, CONCRETE_DARK, -1);
  // Edge lines on the road (paint just above it).
  const edge = (d: number) => b.pts.map((_, i) => {
    const q = bridgePoint(b, b.cum[i], d);
    return { x: q.x, z: q.z };
  });
  for (const s of [1, -1]) {
    const e0 = edge(s * (B.width / 2 - 0.5));
    const e1 = edge(s * (B.width / 2 - 0.65));
    ribbon(kit.paint, e0, e1, level.map((h) => h + 0.05), level.map((h) => h + 0.05), col(0xd8d4c6), 1);
  }
  // Parapets (concrete, a pale cap) and the slab's fascia below them; the missing bay is a gap with a torn rail end.
  for (const side of [1, -1] as const) {
    const inner = side > 0 ? b.left : b.right;
    const outer = side > 0 ? b.leftOut : b.rightOut;
    let run: number[] = [];
    const flush = () => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const ia = run.map((i) => inner[i]);
      const oa = run.map((i) => outer[i]);
      const top = run.map((i) => level[i] + B.parapet);
      const bot = run.map((i) => under[i]);
      ribbon(g, oa, oa, bot, top, CONCRETE, 0);
      ribbon(g, ia, ia, run.map((i) => level[i]), top, CONCRETE, 0);
      ribbon(g, ia, oa, top, top, col(0xb4b0a6), 1);
      run = [];
    };
    for (let i = 0; i < n; i++) {
      const s = b.cum[i];
      const gap = b.missing && side === b.missing.side && s > b.missing.s0 && s < b.missing.s1;
      if (gap) {
        flush();
        continue;
      }
      run.push(i);
    }
    flush();
    if (b.missing && side === b.missing.side) {
      // The fascia under the gap still closes the slab's edge.
      const ids: number[] = [];
      for (let i = 0; i < n; i++) if (b.cum[i] >= b.missing.s0 - 1 && b.cum[i] <= b.missing.s1 + 1) ids.push(i);
      if (ids.length > 1) ribbon(g, ids.map((i) => outer[i]), ids.map((i) => outer[i]), ids.map((i) => under[i]), ids.map((i) => level[i]), CONCRETE_DARK, 0);
      // Hazard stripes on the slab's lip in the gap.
      for (let s = b.missing.s0 + 0.5; s < b.missing.s1 - 0.5; s += 1.6) {
        const p = bridgePoint(b, s, side * (B.width / 2 + 0.1));
        const y = bridgeLevel(b, s, LV).h;
        cylinder(kit.hazard, p.x, p.z, 0.12, y + 0.02, y + 0.08, 6, col(0xffa020));
      }
    }
  }
  // Ramp retaining walls: the ramp's body down to the ground under its parapets (already the parapet's outer face down to `under`).
  // Piers: a column under the deck and a cap across it.
  for (const s of b.piers) {
    const p = bridgePoint(b, s);
    const h = bridgeLevel(b, s, LV).h - B.deck;
    const y0 = kit.h(p.x, p.z) - 0.3;
    const ax = p.tx;
    const az = p.tz;
    const box = (len: number, wid: number): Vec2[] => [
      { x: p.x - ax * len / 2 + az * wid / 2, z: p.z - az * len / 2 - ax * wid / 2 },
      { x: p.x + ax * len / 2 + az * wid / 2, z: p.z + az * len / 2 - ax * wid / 2 },
      { x: p.x + ax * len / 2 - az * wid / 2, z: p.z + az * len / 2 + ax * wid / 2 },
      { x: p.x - ax * len / 2 - az * wid / 2, z: p.z - az * len / 2 + ax * wid / 2 },
    ];
    slab(g, box(B.pier, B.pier * 1.5), y0, h, CONCRETE, CONCRETE);
    slab(g, box(B.pier + 0.6, B.width + 0.6), h - 0.9, h, CONCRETE_DARK, CONCRETE_DARK, true);
  }
  // Lamps on the parapet every 24 m, alternating sides: a post and a warm head.
  let k = 0;
  for (let s = 12; s < b.S - 6; s += 24, k++) {
    const side = k % 2 ? 1 : -1;
    if (b.missing && side === b.missing.side && s > b.missing.s0 - 3 && s < b.missing.s1 + 3) continue;
    const p = bridgePoint(b, s, side * (B.width / 2 + B.thick / 2));
    const y = bridgeLevel(b, s, LV).h + B.parapet;
    cylinder(g, p.x, p.z, 0.08, y, y + 4.2, 5, STEEL_DARK);
    const hx = p.x - (-p.tz) * side * 1.2;
    const hz = p.z - p.tx * side * 1.2;
    cylinder(kit.glow, hx, hz, 0.22, y + 4, y + 4.25, 6, col(0xffd8a0, 3));
  }
}

/** One floodlight tower: a tapering mast, a head bar with floods aimed along f, and their pools. */
export function floodTower(kit: DistrictKit, pools: GeoBuilder | null, p: Vec2, mast: number, fx: number, fz: number, pool: (gb: GeoBuilder, x: number, z: number, r: number, c: THREE.Color) => void): void {
  const y = kit.h(p.x, p.z);
  const ax = -fz;
  const az = fx;
  cylinder(kit.solid, p.x, p.z, 0.42, y - 0.3, y + mast, 7, STEEL, true, 0.24);
  cylinder(kit.solid, p.x, p.z, 0.75, y - 0.3, y + 0.6, 7, CONCRETE_DARK, true);
  const top = y + mast;
  slab(kit.solid, [
    { x: p.x + ax * 2.3 + fx * 0.3, z: p.z + az * 2.3 + fz * 0.3 },
    { x: p.x - ax * 2.3 + fx * 0.3, z: p.z - az * 2.3 + fz * 0.3 },
    { x: p.x - ax * 2.3 + fx * 0.9, z: p.z - az * 2.3 + fz * 0.9 },
    { x: p.x + ax * 2.3 + fx * 0.9, z: p.z + az * 2.3 + fz * 0.9 },
  ], top - 0.6, top + 0.9, STEEL_DARK, STEEL_DARK);
  for (const a of [-1.7, -0.6, 0.6, 1.7]) {
    for (const row of [0, 1]) {
      const gx = p.x + ax * a + fx * 1.0;
      const gz = p.z + az * a + fz * 1.0;
      cylinder(kit.glow, gx, gz, 0.24, top - 0.4 + row * 0.75, top - 0.05 + row * 0.75, 6, col(0xfff1d6, 3.6));
    }
  }
  if (pools) {
    pool(pools, p.x + fx * 22, p.z + fz * 22, C.lights.pool, col(0xffe6c4, 0.24));
    pool(pools, p.x + fx * 46, p.z + fz * 46, C.lights.pool * 0.85, col(0xffe6c4, 0.14));
  }
}

/** The yard tower: four legs, a cab with a lit window wall toward the hump, a roof and a stair. */
function yardTower(kit: DistrictKit, p: Vec2, fx: number, fz: number): void {
  const y = kit.h(p.x, p.z);
  const h = 9;
  const ax = -fz;
  const az = fx;
  const g = kit.solid;
  for (const a of [-1.6, 1.6]) for (const c of [-1.6, 1.6]) cylinder(g, p.x + ax * a + fx * c, p.z + az * a + fz * c, 0.17, y - 0.2, y + h, 6, STEEL);
  const quad = (a0: number, a1: number, b0: number, b1: number): Vec2[] => [
    { x: p.x + ax * a0 + fx * b0, z: p.z + az * a0 + fz * b0 },
    { x: p.x + ax * a1 + fx * b0, z: p.z + az * a1 + fz * b0 },
    { x: p.x + ax * a1 + fx * b1, z: p.z + az * a1 + fz * b1 },
    { x: p.x + ax * a0 + fx * b1, z: p.z + az * a0 + fz * b1 },
  ];
  slab(g, quad(-2.4, 2.4, -2.1, 2.1), y + h - 0.2, y + h, STEEL, STEEL, true);
  slab(g, quad(-2.1, 2.1, -1.8, 1.8), y + h, y + h + 2.6, col(0x6b6d72), col(0x3a3d43));
  slab(g, quad(-2.5, 2.5, -2.2, 2.2), y + h + 2.6, y + h + 2.8, col(0x3a3d43), col(0x3a3d43));
  for (const a of [-1.6, -0.5, 0.6]) {
    const win = quad(a, a + 0.9, 1.84, 1.84);
    const ids = win.map((q, k) => kit.glow.vertex(q.x, y + h + (k < 2 ? 1.0 : 2.2), q.z, fx, 0, fz, 0, 0, col(0xffd596, 2.4)));
    kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], fx, 0, fz);
  }
  const st = quad(2.6, 3.2, -1.2, 1.2);
  const sa = st.map((q, k) => g.vertex(q.x, k < 2 ? y : y + h, q.z, 0, 1, 0, 0, 0, STEEL));
  g.quadFacing(sa[0], sa[1], sa[2], sa[3], 0, 1, 0);
  g.quadFacing(sa[3], sa[2], sa[1], sa[0], 0, -1, 0);
}

/** The poly's long axis: centre, unit along, length, width. */
function axisOf(poly: readonly Vec2[]): { c: Vec2; ux: number; uz: number; len: number; wid: number } {
  const l01 = Math.hypot(poly[1].x - poly[0].x, poly[1].z - poly[0].z);
  const l12 = Math.hypot(poly[2].x - poly[1].x, poly[2].z - poly[1].z);
  const c = { x: (poly[0].x + poly[2].x) / 2, z: (poly[0].z + poly[2].z) / 2 };
  if (l01 >= l12) return { c, ux: (poly[1].x - poly[0].x) / l01, uz: (poly[1].z - poly[0].z) / l01, len: l01, wid: l12 };
  return { c, ux: (poly[2].x - poly[1].x) / l12, uz: (poly[2].z - poly[1].z) / l12, len: l12, wid: l01 };
}

const CONTAINER = [0x2e6aa0, 0xb04a2a, 0x3a7a4a, 0xc8a02a, 0x6a4a8a, 0x8a8f96, 0xa33a3a];

/** Every yard solid by its kind (the walls the sim has, drawn as what they are). */
export function drawSolids(kit: DistrictKit, lay: YardLayout, pools: GeoBuilder | null, pool: (gb: GeoBuilder, x: number, z: number, r: number, c: THREE.Color) => void): void {
  const g = kit.solid;
  let k = 0;
  for (const s of lay.solids) {
    k++;
    drawSolid(kit, g, s, k, lay, pools, pool);
  }
  // The fence's posts (its chain link panels are props).
  for (const p of lay.posts) cylinder(g, p.x, p.z, 0.09, kit.h(p.x, p.z) - 0.2, kit.h(p.x, p.z) + 2.5, 5, STEEL_DARK);
  // The signal gantries' beams and their signal heads over each track of the throat.
  for (const [a, b] of lay.gantries) {
    const ya = kit.h(a.x, a.z);
    const yb = kit.h(b.x, b.z);
    const y = Math.max(ya, yb) + C.lights.gantryHeight;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    slab(g, [
      { x: a.x - uz * 0.5, z: a.z + ux * 0.5 },
      { x: b.x - uz * 0.5, z: b.z + ux * 0.5 },
      { x: b.x + uz * 0.5, z: b.z - ux * 0.5 },
      { x: a.x + uz * 0.5, z: a.z - ux * 0.5 },
    ], y - 0.8, y, STEEL_DARK, STEEL_DARK, true);
    for (let d = 3; d < len - 2; d += 4.5) {
      const x = a.x + ux * d;
      const z = a.z + uz * d;
      slab(g, [{ x: x - 0.3, z: z - 0.3 }, { x: x + 0.3, z: z - 0.3 }, { x: x + 0.3, z: z + 0.3 }, { x: x - 0.3, z: z + 0.3 }], y - 2.2, y - 0.8, STEEL_DARK, STEEL_DARK);
      const lamp = [col(0xff2a1a, 3.2), col(0x30ff70, 2.8), col(0xffb020, 3)][Math.floor(d / 4.5) % 3];
      cylinder(kit.glow, x, z, 0.16, y - 1.7, y - 1.4, 6, lamp);
    }
  }
  // The gantry crane's girders and trolley over its legs.
  if (lay.crane) {
    const [a0, a1, b0, b1] = lay.crane;
    const G = C.pad.gantry;
    const y = Math.max(...lay.crane.map((p) => kit.h(p.x, p.z))) + G.height;
    for (const [p, q] of [[a0, b0], [a1, b1]] as const) {
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const ux = (q.x - p.x) / len;
      const uz = (q.z - p.z) / len;
      slab(g, [
        { x: p.x - uz * 0.7 - ux * 2, z: p.z + ux * 0.7 - uz * 2 },
        { x: q.x - uz * 0.7 + ux * 2, z: q.z + ux * 0.7 + uz * 2 },
        { x: q.x + uz * 0.7 + ux * 2, z: q.z - ux * 0.7 + uz * 2 },
        { x: p.x + uz * 0.7 - ux * 2, z: p.z - ux * 0.7 - uz * 2 },
      ], y - 1.6, y, YELLOW, YELLOW, true);
    }
    const m = { x: (a0.x + a1.x + b0.x * 0.6 + b1.x * 0.6) / 3.2, z: (a0.z + a1.z + b0.z * 0.6 + b1.z * 0.6) / 3.2 };
    slab(g, [{ x: m.x - 3, z: m.z - 3 }, { x: m.x + 3, z: m.z - 3 }, { x: m.x + 3, z: m.z + 3 }, { x: m.x - 3, z: m.z + 3 }], y, y + 2.4, col(0xb88a18), col(0x6a5010));
    cylinder(g, m.x, m.z, 0.06, y - 7, y, 4, STEEL_DARK);
    slab(g, [{ x: m.x - 1.4, z: m.z - 6 }, { x: m.x + 1.4, z: m.z - 6 }, { x: m.x + 1.4, z: m.z + 6 }, { x: m.x - 1.4, z: m.z + 6 }], y - 7.6, y - 7, YELLOW, YELLOW, true);
    for (const p of lay.crane) cylinder(kit.glow, p.x, p.z, 0.2, y + 0.1, y + 0.4, 6, col(0xff4020, 2.6));
  }
  if (lay.tower) yardTower(kit, lay.tower.p, lay.tower.fx, lay.tower.fz);
  for (const l of lay.lights) floodTower(kit, pools, l.p, C.lights.mast, l.fx, l.fz, pool);
}

function drawSolid(kit: DistrictKit, g: GeoBuilder, s: YardSolid, k: number, lay: YardLayout, _pools: GeoBuilder | null, _pool: unknown): void {
  const poly = s.poly;
  switch (s.kind) {
    case 'retarder': {
      prism(kit, g, poly, s.height, STEEL_DARK, YELLOW, 0.2);
      break;
    }
    case 'switchStand': {
      const a = axisOf(poly);
      const y = kit.h(a.c.x, a.c.z);
      cylinder(g, a.c.x, a.c.z, 0.08, y, y + 1.2, 5, STEEL_DARK);
      cylinder(kit.glow, a.c.x, a.c.z, 0.2, y + 1.1, y + 1.35, 6, k % 2 ? col(0xff3020, 2.6) : col(0x30ff70, 2.4));
      break;
    }
    case 'water': {
      const a = axisOf(poly);
      const y = kit.h(a.c.x, a.c.z);
      cylinder(g, a.c.x, a.c.z, 0.35, y - 0.2, y + 4.2, 8, col(0x2a3a4a));
      const ex = a.c.x + lay.f.wx * -2.2;
      const ez = a.c.z + lay.f.wz * -2.2;
      slab(g, [{ x: a.c.x - 0.15, z: a.c.z - 0.15 }, { x: ex - 0.15, z: ez - 0.15 }, { x: ex + 0.15, z: ez + 0.15 }, { x: a.c.x + 0.15, z: a.c.z + 0.15 }], y + 3.8, y + 4.1, col(0x2a3a4a), col(0x2a3a4a), true);
      break;
    }
    case 'container': {
      const tiers = Math.round(s.height / C.pad.container.height);
      for (let t = 0; t < tiers; t++) {
        const c = col(CONTAINER[(k * 7 + t * 3) % CONTAINER.length]);
        const y0 = Math.min(...poly.map((p) => kit.h(p.x, p.z))) + t * C.pad.container.height - (t === 0 ? 0.2 : 0);
        slab(g, poly, y0, y0 + C.pad.container.height - 0.04 + (t === 0 ? 0.2 : 0), c, c.clone().multiplyScalar(0.8));
      }
      break;
    }
    case 'gantryLeg': {
      const a = axisOf(poly);
      const y = kit.h(a.c.x, a.c.z);
      slab(g, poly, y - 0.2, y + s.height, YELLOW, YELLOW);
      // The bogie at its foot, on the pad's rail.
      slab(g, poly.map((p) => ({ x: a.c.x + (p.x - a.c.x) * 1.6, z: a.c.z + (p.z - a.c.z) * 1.6 })), y - 0.2, y + 0.9, STEEL_DARK, STEEL_DARK);
      break;
    }
    case 'house': {
      // The freight house: corrugated walls, a low pitched roof, roller doors toward the dock, an awning over the platform.
      const y0 = Math.min(...poly.map((p) => kit.h(p.x, p.z))) - 0.3;
      const y1 = Math.max(...poly.map((p) => kit.h(p.x, p.z))) + s.height;
      slab(g, poly, y0, y1, col(0x6a5e52), col(0x3d3934));
      const a = axisOf(poly);
      const fx = lay.f.wx;
      const fz = lay.f.wz;
      // Awning: from the front wall (toward +w) 6 m out over the dock, at 4.6 m.
      const front = poly.reduce((m, p) => Math.max(m, (p.x - a.c.x) * fx + (p.z - a.c.z) * fz), -Infinity);
      const yA = kit.h(a.c.x + fx * (front + 3), a.c.z + fz * (front + 3)) + 4.6;
      const q = (u: number, w: number) => ({ x: a.c.x + a.ux * u + fx * w, z: a.c.z + a.uz * u + fz * w });
      slab(g, [q(-a.len / 2, front), q(a.len / 2, front), q(a.len / 2, front + 6), q(-a.len / 2, front + 6)], yA, yA + 0.25, col(0x4a4f56), col(0x4a4f56), true);
      for (let u = -a.len / 2 + 1.5; u < a.len / 2 - 1.5; u += 4) {
        if ((k + Math.round(u * 3)) % 4 === 0) continue;
        const w0 = q(u, front + 0.06);
        const w1 = q(u + 1.6, front + 0.06);
        const yw = yA + 0.9;
        const ids = [kit.glow.vertex(w0.x, yw, w0.z, fx, 0, fz, 0, 0, col(0xffd9a0, 1.4)), kit.glow.vertex(w1.x, yw, w1.z, fx, 0, fz, 0, 0, col(0xffd9a0, 1.4)), kit.glow.vertex(w1.x, yw + 0.9, w1.z, fx, 0, fz, 0, 0, col(0xffd9a0, 1.4)), kit.glow.vertex(w0.x, yw + 0.9, w0.z, fx, 0, fz, 0, 0, col(0xffd9a0, 1.4))];
        kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], fx, 0, fz);
      }
      for (let u = -a.len / 2 + 3; u < a.len / 2 - 2; u += 6) {
        // Roller doors: lit slits under the awning (two in three closed).
        const lit = (k + Math.round(u)) % 3 === 0;
        const p0 = q(u, front + 0.06);
        const p1 = q(u + 3.4, front + 0.06);
        const yb = yA - 4.4;
        const ids = [
          kit.glow.vertex(p0.x, yb, p0.z, fx, 0, fz, 0, 0, lit ? col(0xffc070, 1.6) : col(0x262626)),
          kit.glow.vertex(p1.x, yb, p1.z, fx, 0, fz, 0, 0, lit ? col(0xffc070, 1.6) : col(0x262626)),
          kit.glow.vertex(p1.x, yb + 3.4, p1.z, fx, 0, fz, 0, 0, lit ? col(0xffc070, 1.6) : col(0x262626)),
          kit.glow.vertex(p0.x, yb + 3.4, p0.z, fx, 0, fz, 0, 0, lit ? col(0xffc070, 1.6) : col(0x262626)),
        ];
        kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], fx, 0, fz);
      }
      break;
    }
    case 'shop': {
      // The diesel shop: a tall brick shed, a monitor roof, two lit bay doors at its ends and clerestory windows.
      const y0 = Math.min(...poly.map((p) => kit.h(p.x, p.z))) - 0.3;
      const y1 = Math.max(...poly.map((p) => kit.h(p.x, p.z))) + s.height;
      slab(g, poly, y0, y1, col(0x6e3a2a), col(0x3a302a));
      const a = axisOf(poly);
      const inner = poly.map((p) => ({ x: a.c.x + (p.x - a.c.x) * 0.45, z: a.c.z + (p.z - a.c.z) * 0.8 }));
      slab(g, inner, y1, y1 + 1.6, col(0x5a3428), col(0x2e2a26));
      for (const sd of [-1, 1]) {
        const vx = -a.uz * sd;
        const vz = a.ux * sd;
        const off = (a.wid / 2) * 0.8 + 0.05;
        const p0 = { x: a.c.x - a.ux * a.len * 0.42 + vx * off, z: a.c.z - a.uz * a.len * 0.42 + vz * off };
        const p1 = { x: a.c.x + a.ux * a.len * 0.42 + vx * off, z: a.c.z + a.uz * a.len * 0.42 + vz * off };
        const ids = [kit.glow.vertex(p0.x, y1 + 0.3, p0.z, vx, 0, vz, 0, 0, col(0xffc880, 1.3)), kit.glow.vertex(p1.x, y1 + 0.3, p1.z, vx, 0, vz, 0, 0, col(0xffc880, 1.3)), kit.glow.vertex(p1.x, y1 + 1.2, p1.z, vx, 0, vz, 0, 0, col(0xffc880, 1.1)), kit.glow.vertex(p0.x, y1 + 1.2, p0.z, vx, 0, vz, 0, 0, col(0xffc880, 1.1))];
        kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], vx, 0, vz);
      }
      for (const e of [-1, 1]) {
        const cx = a.c.x + a.ux * e * (a.len / 2 + 0.05);
        const cz = a.c.z + a.uz * e * (a.len / 2 + 0.05);
        const vx = -a.uz;
        const vz = a.ux;
        for (const off of [-a.wid / 4, a.wid / 4]) {
          const p0 = { x: cx + vx * (off - 2), z: cz + vz * (off - 2) };
          const p1 = { x: cx + vx * (off + 2), z: cz + vz * (off + 2) };
          const ids = [kit.glow.vertex(p0.x, y0 + 0.3, p0.z, a.ux * e, 0, a.uz * e, 0, 0, col(0xffb860, 1.5)), kit.glow.vertex(p1.x, y0 + 0.3, p1.z, a.ux * e, 0, a.uz * e, 0, 0, col(0xffb860, 1.5)), kit.glow.vertex(p1.x, y0 + 5.8, p1.z, a.ux * e, 0, a.uz * e, 0, 0, col(0xffb860, 1.2)), kit.glow.vertex(p0.x, y0 + 5.8, p0.z, a.ux * e, 0, a.uz * e, 0, 0, col(0xffb860, 1.2))];
          kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], a.ux * e, 0, a.uz * e);
        }
      }
      break;
    }
    case 'sand': {
      // The sand tower: a concrete bin on legs, its spouts reaching out over the track.
      const a = axisOf(poly);
      const y = kit.h(a.c.x, a.c.z);
      for (const p of poly) cylinder(g, a.c.x + (p.x - a.c.x) * 0.8, a.c.z + (p.z - a.c.z) * 0.8, 0.25, y - 0.2, y + 7, 6, CONCRETE_DARK);
      slab(g, poly, y + 7, y + s.height, CONCRETE, CONCRETE_DARK);
      cylinder(g, a.c.x, a.c.z, 0.5, y + 4, y + 7, 8, CONCRETE_DARK, false, 1.6);
      break;
    }
    case 'forklift': {
      // A yard forklift: an orange body and counterweight, an overhead guard on four posts, the mast and forks at its front, a beacon.
      const a = axisOf(poly);
      const y = Math.max(...poly.map((p) => kit.h(p.x, p.z)));
      const q = (u: number, v: number) => ({ x: a.c.x + a.ux * u - a.uz * v, z: a.c.z + a.uz * u + a.ux * v });
      const box = (u0: number, u1: number, v0: number, v1: number) => [q(u0, v0), q(u1, v0), q(u1, v1), q(u0, v1)];
      slab(g, box(-1.4, 0.8, -0.62, 0.62), y + 0.2, y + 1.15, col(0xe8901c), col(0xc87818));
      slab(g, box(-1.4, -0.9, -0.62, 0.62), y + 1.15, y + 1.5, col(0x3a3d42), col(0x3a3d42));
      for (const [u, v] of [[-1.2, -0.55], [-1.2, 0.55], [0.5, -0.55], [0.5, 0.55]]) cylinder(g, q(u, v).x, q(u, v).z, 0.04, y + 1.15, y + 2.2, 4, STEEL_DARK);
      slab(g, box(-1.25, 0.55, -0.6, 0.6), y + 2.2, y + 2.28, STEEL_DARK, STEEL_DARK, true);
      slab(g, box(0.85, 1.0, -0.45, 0.45), y + 0.1, y + 2.6, STEEL_DARK, STEEL_DARK);
      slab(g, box(1.0, 1.4, -0.4, 0.4), y + 0.1, y + 0.2, STEEL, STEEL);
      cylinder(kit.glow, q(-0.4, 0).x, q(-0.4, 0).z, 0.1, y + 2.28, y + 2.45, 6, col(0xffa020, 2.6));
      break;
    }
    case 'sheet': {
      // A corrugated steel sheet between two fence posts, rust streaked.
      prism(kit, g, poly, 2.4, k % 2 ? col(0x5a5450) : col(0x6a4a38), col(0x2a2a2a), 0.2);
      break;
    }
    case 'dockFace': {
      // A concrete bumper rail along the face's foot, a yellow top (the hard edge reads from the ground).
      prism(kit, g, poly, 0.5, col(0x6c6e72), col(0xe2b520), 0.25);
      break;
    }
    case 'bankWall': {
      prism(kit, g, poly, 1.1, col(0xa6a49c), col(0x85837c), 0.4);
      break;
    }
    case 'signalLeg': {
      const a = axisOf(poly);
      const y = kit.h(a.c.x, a.c.z);
      slab(g, poly, y - 0.2, y + s.height, STEEL_DARK, STEEL_DARK);
      break;
    }
    case 'tower':
    case 'flood':
      // Drawn whole by drawSolids (their legs and masts are these footprints).
      break;
    default:
      prism(kit, g, poly, Math.min(3, s.height), RUST, RUST, 0.2);
  }
}
