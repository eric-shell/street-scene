/**
 * The low poly meshes of the destructible props (props.ts): one builder per
 * part, in the prop's local space with vertex colors, merged through
 * `GeoBuilder`. Street furniture (streetlight, stump, traffic signal pole,
 * mast arm, head and lens, garbage can, bench, bus shelter and its lit
 * poster), then the district clutter (bushes, planters, cafe tables, barrels,
 * crates, dumpsters, news boxes, bollards, the construction pieces, market
 * stalls and food carts) with the `CLUTTER` table that says which material
 * slot, tint list and spin each kind takes, merged with the neighbourhood
 * furniture of streetFurniture.ts into `PARTS`. Also the shared heights the
 * renderer places and breaks the poles by. Render only.
 */
import * as THREE from 'three';
import type { DistrictPropKind, FurnitureKind, Prop } from '../../city/props';
import { FURNITURE_KINDS } from '../../city/props';
import { GeoBuilder } from '../geoBuilder';
import { FURNITURE_PARTS, PropPartsDef } from './streetFurniture';

/** Streetlight pole height and arm reach (lamp heads sit at the arm end). Matches cityMeshes lampPositions. */
export const STREETLIGHT_POLE_H = 8.2;
export const STREETLIGHT_ARM = 2.4;
/** Park lamp (lantern post) height and the height of its lantern's middle (m). */
export const PARK_LAMP_H = 4.4;
export const PARK_LANTERN_Y = 3.95;
export const STUMP_H = 0.55;
export const TRAFFIC_POLE_H = 5.6;
export const TRAFFIC_ARM_Y = 5.25;

// ---------------------------------------------------------------------------
// Low poly part builders (local space, vertex colored)
// ---------------------------------------------------------------------------

function box(gb: GeoBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color, skipBottom = true): void {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const face = (n: [number, number, number], pts: [number, number, number][]) => {
    const v = pts.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], 0, 0, color));
    gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
  };
  face([1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]);
  face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  face([0, 0, -1], [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]);
  face([0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
  if (!skipBottom) face([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
}

/** Vertical tapered cylinder from y0 to y1 with a top cap. */
function cyl(gb: GeoBuilder, cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, seg: number, color: THREE.Color): void {
  const ring: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    ring.push(gb.vertex(cx + nx * r0, y0, cz + nz * r0, nx, 0, nz, 0, 0, color), gb.vertex(cx + nx * r1, y1, cz + nz * r1, nx, 0, nz, 0, 0, color));
  }
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2 + Math.PI / seg;
    gb.quadFacing(ring[k * 2], ring[k * 2 + 2], ring[k * 2 + 3], ring[k * 2 + 1], Math.cos(a), 0, Math.sin(a));
  }
  const c = gb.vertex(cx, y1, cz, 0, 1, 0, 0, 0, color);
  const top: number[] = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    top.push(gb.vertex(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, 0, 1, 0, 0, 0, color));
  }
  for (let k = 0; k < seg; k++) gb.triFacing(c, top[k], top[(k + 1) % seg], 0, 1, 0);
}

export const col = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);

// ---------- District clutter ----------

/** Rounded shrub from two stacked tapered rings (open bottom). */
function shrub(gb: GeoBuilder, cx: number, cz: number, y0: number, h: number, r: number, color: THREE.Color, seg = 7): void {
  cyl(gb, cx, cz, y0, y0 + h * 0.45, r * 0.62, r, seg, color);
  cyl(gb, cx, cz, y0 + h * 0.45, y0 + h, r, r * 0.3, seg, color);
}

function bushGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  shrub(s, 0, 0, 0, 1.1, 0.78, col(0x3d7436));
  shrub(s, 0.32, -0.22, 0, 0.8, 0.5, col(0x335f2e));
  shrub(s, -0.3, 0.25, 0, 0.7, 0.42, col(0x47823d));
  return s.build();
}

function planterPotGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, 0, 0.62, 0.42, 0.53, 10, col(0x8a8c94));
  cyl(s, 0, 0, 0.62, 0.635, 0.47, 0.47, 10, col(0x2a1d14));
  shrub(s, 0, 0, 0.6, 0.9, 0.5, col(0x3a6e34));
  return s.build();
}

/** Steel bollard: collar, post and a domed cap; the reflective band is a separate glow part. */
function bollardGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const steel = col(0x3c4048);
  cyl(s, 0, 0, 0, 0.1, 0.2, 0.2, 10, col(0x2a2c32));
  cyl(s, 0, 0, 0.1, 0.9, 0.14, 0.14, 10, steel);
  cyl(s, 0, 0, 0.9, 1.0, 0.14, 0.09, 10, steel);
  return s.build();
}

function bollardBandGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, 0.7, 0.8, 0.145, 0.145, 10, col(0xfff0c0));
  return s.build();
}

function cafeFrameGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const alu = col(0xb4b8c0);
  const dark = col(0x2a2c32);
  cyl(s, 0, 0, 0, 0.04, 0.25, 0.25, 8, dark);
  cyl(s, 0, 0, 0, 0.72, 0.035, 0.035, 6, alu);
  cyl(s, 0, 0, 0.72, 0.76, 0.38, 0.38, 10, col(0xe6e6e2));
  cyl(s, 0, 0, 0.76, 2.25, 0.025, 0.025, 6, alu);
  // Bistro chairs: seat, back and two sled frames (one box each side instead of four legs).
  for (const side of [-1, 1]) {
    const x = side * 0.62;
    box(s, x, 0.45, 0, 0.42, 0.04, 0.42, alu, false);
    for (const lz of [-0.19, 0.19]) box(s, x, 0.22, lz, 0.38, 0.44, 0.025, alu);
    box(s, x + side * 0.2, 0.72, 0, 0.03, 0.5, 0.4, alu, false);
  }
  return s.build();
}

function cafeCanopyGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, 1.86, 2.3, 1.15, 0.06, 8, col(0xffffff));
  return s.build();
}

function barrelGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const orange = col(0xff6a1a);
  const white = col(0xe8e8e8);
  const bands: [number, number, THREE.Color][] = [
    [0, 0.22, orange],
    [0.22, 0.34, white],
    [0.34, 0.58, orange],
    [0.58, 0.7, white],
    [0.7, 0.93, orange],
  ];
  for (const [y0, y1, c] of bands) cyl(s, 0, 0, y0, y1, 0.4 - y0 * 0.04, 0.4 - y1 * 0.04, 10, c);
  cyl(s, 0, 0, 0.93, 0.98, 0.3, 0.28, 10, col(0x1c1d20));
  return s.build();
}

function crateGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const wood = col(0x9a7444);
  const dark = col(0x6a4c2a);
  box(s, 0, 0.4, 0, 0.85, 0.8, 0.85, wood);
  for (const y of [0.12, 0.68]) box(s, 0, y, 0, 0.87, 0.08, 0.87, dark);
  box(s, 0.08, 1.0, -0.06, 0.62, 0.4, 0.62, col(0xa88250));
  box(s, -0.32, 0.9, 0.36, 0.3, 0.2, 0.22, dark);
  return s.build();
}

function dumpsterGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const body = col(0x2f6a46);
  const dark = col(0x1c2a22);
  box(s, 0, 0.72, 0, 1.9, 1.08, 1.15, body);
  box(s, 0, 1.3, -0.04, 1.96, 0.08, 1.22, dark);
  for (const x of [-0.7, 0.7]) box(s, x, 0.72, 0.6, 0.1, 0.9, 0.06, dark);
  for (const x of [-0.8, 0.8]) for (const z of [-0.45, 0.45]) cyl(s, x, z, 0, 0.18, 0.09, 0.09, 6, col(0x111214));
  return s.build();
}

function newsBoxGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.62, 0, 0.5, 0.92, 0.45, col(0xd8d8d8));
  box(s, 0, 0.8, 0.23, 0.4, 0.32, 0.02, col(0x9fb4c8));
  box(s, 0, 0.08, 0, 0.42, 0.16, 0.38, col(0x2a2c32));
  return s.build();
}

function trashBagsGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const bag = col(0x17191c);
  shrub(s, 0, 0, 0, 0.62, 0.36, bag, 6);
  shrub(s, 0.42, -0.12, 0, 0.5, 0.3, bag, 6);
  shrub(s, -0.2, 0.36, 0, 0.45, 0.28, col(0x1f2a1f), 6);
  return s.build();
}

// ---------- Construction site pieces (route shortcuts) ----------

/** Temporary fence panel, local +X along the fence: feet, galvanized frame and a chain link grid (banner separate). */
function fenceFrameGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const steel = col(0x9aa0a8);
  const wire = col(0x6c727a);
  const foot = col(0x7e8086);
  for (const x of [-1.15, 1.15]) {
    box(s, x, 0.07, 0, 0.26, 0.14, 0.62, foot);
    box(s, x, 1.08, 0, 0.05, 1.96, 0.05, steel);
  }
  for (const y of [0.16, 2.04]) box(s, 0, y, 0, 2.36, 0.05, 0.05, steel);
  for (let k = 1; k < 8; k++) box(s, -1.15 + (2.3 * k) / 8, 1.1, 0, 0.012, 1.86, 0.012, wire);
  for (let k = 1; k < 7; k++) box(s, 0, 0.16 + (1.88 * k) / 7, 0, 2.3, 0.012, 0.012, wire);
  // Contractor's livery on the banner (white bands and a dark logo block, both faces), not tinted.
  for (const z of [0.04, -0.04]) {
    box(s, 0, 1.36, z, 2.24, 0.1, 0.012, col(0xf2f2ee), false);
    box(s, 0, 0.62, z, 2.24, 0.06, 0.012, col(0xf2f2ee), false);
    box(s, -0.55, 0.98, z, 0.62, 0.42, 0.012, col(0x1a1c22), false);
    box(s, 0.38, 0.98, z, 0.9, 0.12, 0.012, col(0xf2f2ee), false);
  }
  return s.build();
}

/** The fence banner (hoarding wrap), tinted per instance in a contractor's colour. */
function fenceBannerGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.98, 0, 2.3, 0.96, 0.06, col(0xffffff), false);
  return s.build();
}

function trafficConeGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const orange = col(0xff5a14);
  box(s, 0, 0.02, 0, 0.44, 0.04, 0.44, col(0x1c1d22));
  cyl(s, 0, 0, 0.04, 0.36, 0.17, 0.115, 8, orange);
  cyl(s, 0, 0, 0.36, 0.48, 0.118, 0.092, 8, col(0xf4f4f0));
  cyl(s, 0, 0, 0.48, 0.74, 0.09, 0.03, 8, orange);
  return s.build();
}

/** Striped sawhorse barricade: two planks of orange and white on splayed legs (lamp separate). */
function sawhorseGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const leg = col(0x3a3c42);
  for (const x of [-0.62, 0.62]) for (const z of [-0.22, 0.22]) box(s, x, 0.48, z, 0.05, 0.96, 0.05, leg);
  for (const x of [-0.62, 0.62]) box(s, x, 0.08, 0, 0.06, 0.05, 0.5, leg);
  for (const y of [0.6, 0.92]) {
    for (let k = 0; k < 7; k++) box(s, -0.7 + 0.2 * k + 0.1, y, 0, 0.2, 0.22, 0.035, col(k % 2 ? 0xf4f4f0 : 0xff6a1a));
  }
  return s.build();
}

function sawhorseLampGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0.55, 1.1, 0, 0.11, 0.13, 0.08, col(0xffa21a, 2.4), false);
  return s.build();
}

/** Water filled plastic barrier, about 1.8 m long (tinted per instance). */
function waterBarrierGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const body = col(0xf4f4f0);
  box(s, 0, 0.17, 0, 1.8, 0.34, 0.6, body);
  box(s, 0, 0.52, 0, 1.76, 0.36, 0.44, body);
  box(s, 0, 0.78, 0, 1.72, 0.16, 0.3, body);
  for (const x of [-0.55, 0.55]) cyl(s, x, 0, 0.86, 0.9, 0.08, 0.08, 6, col(0x2a2c32));
  return s.build();
}

function sandbagsGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const rows: [number, number[]][] = [
    [0.08, [-0.6, -0.2, 0.2, 0.6]],
    [0.24, [-0.4, 0, 0.4]],
    [0.4, [-0.2, 0.2]],
  ];
  rows.forEach(([y, xs], r) => xs.forEach((x, k) => box(s, x, y, ((r + k) % 2) * 0.05 - 0.025, 0.4, 0.16, 0.3, col(0xb09a6a, 0.85 + 0.15 * ((k + r) % 3)))));
  return s.build();
}

/** A stack of pallets with a strapped load on top. */
function palletsGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const wood = col(0xa8875a);
  const dark = col(0x7a5e3a);
  for (const y0 of [0, 0.14, 0.28]) {
    for (const z of [-0.45, 0, 0.45]) box(s, 0, y0 + 0.045, z, 1.1, 0.09, 0.1, dark);
    for (let k = 0; k < 6; k++) box(s, -0.5 + 0.2 * k, y0 + 0.11, 0, 0.13, 0.025, 1.0, wood);
  }
  box(s, 0.05, 0.6, 0, 0.9, 0.36, 0.8, col(0x8a6a44));
  box(s, 0.05, 0.6, 0, 0.92, 0.04, 0.82, col(0x1c1d20));
  return s.build();
}

/** Cast iron lantern post: plinth, fluted shaft, collar and a hipped cap over the lantern. */
function parkLampGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const iron = col(0x22252b);
  const Y = PARK_LANTERN_Y;
  cyl(s, 0, 0, 0, 0.55, 0.2, 0.15, 8, iron);
  cyl(s, 0, 0, 0.55, Y - 0.42, 0.075, 0.055, 6, iron);
  cyl(s, 0, 0, Y - 0.42, Y - 0.3, 0.13, 0.16, 8, iron);
  // Corner bars of the lantern and the cap.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    box(s, Math.cos(a) * 0.2, Y, Math.sin(a) * 0.2, 0.03, 0.62, 0.03, iron);
  }
  cyl(s, 0, 0, Y + 0.31, Y + 0.36, 0.3, 0.3, 8, iron);
  cyl(s, 0, 0, Y + 0.36, PARK_LAMP_H, 0.3, 0.04, 8, iron);
  return s.build();
}

/** The lantern's glass: a warm bright cylinder between the collar and the cap (blooms). */
function parkLanternGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, PARK_LANTERN_Y - 0.3, PARK_LANTERN_Y + 0.31, 0.17, 0.2, 8, col(0xffd6a0, 4));
  return s.build();
}

// ---------- Night market (districts/market.ts) ----------

/** A flat quad from its four corners (perimeter order), facing along n. */
function quad4(gb: GeoBuilder, p: [number, number, number][], n: [number, number, number], color: THREE.Color): void {
  const v = p.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], 0, 0, color));
  gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
}

/** Market stall frame, local +Z toward the road (m): pole half spacing, front and back pole lines and heights, lantern middle. */
export const STALL = { halfW: 0.95, front: 0.62, back: -0.75, frontH: 2.1, backH: 2.45, lanternY: 1.72 } as const;

/** Four bamboo poles and their cross bars (the awning, goods and lanterns are separate parts). */
function stallFrameGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const pole = col(0x6a4a2c);
  for (const x of [-STALL.halfW, STALL.halfW]) {
    box(s, x, STALL.frontH / 2, STALL.front, 0.06, STALL.frontH, 0.06, pole);
    box(s, x, STALL.backH / 2, STALL.back, 0.06, STALL.backH, 0.06, pole);
  }
  box(s, 0, STALL.frontH, STALL.front, 2 * STALL.halfW + 0.06, 0.05, 0.05, pole);
  box(s, 0, STALL.backH, STALL.back, 2 * STALL.halfW + 0.06, 0.05, 0.05, pole);
  return s.build();
}

/** The goods: a table in a cloth skirt piled with baskets of fruit, crates and a shelf of jars behind. */
function stallGoodsGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.8, 0.42, 1.96, 0.06, 0.66, col(0x6a4a30));
  box(s, 0, 0.42, 0.76, 1.96, 0.74, 0.02, col(0x8a1f22), false);
  for (const x of [-0.97, 0.97]) box(s, x, 0.4, 0.42, 0.02, 0.72, 0.64, col(0x7a1a1e), false);
  const fruit = [0xff7a1a, 0xd8202a, 0x6ab82a, 0xf2c81c, 0x8a2a6a];
  for (let k = 0; k < 5; k++) {
    const x = -0.74 + k * 0.37;
    const z = 0.42 + (k % 2 ? 0.14 : -0.12);
    cyl(s, x, z, 0.83, 0.93, 0.15, 0.18, 6, col(0x8a6436));
    cyl(s, x, z, 0.93, 1.03, 0.16, 0.05, 6, col(fruit[k]));
  }
  box(s, -0.6, 0.25, -0.5, 0.55, 0.5, 0.45, col(0x9a7444));
  box(s, -0.55, 0.7, -0.52, 0.5, 0.4, 0.4, col(0xa88250));
  box(s, 0.5, 0.55, -0.6, 0.9, 1.1, 0.3, col(0x4a3424));
  for (let k = 0; k < 4; k++) box(s, 0.2 + k * 0.2, 1.18, -0.6, 0.12, 0.16, 0.12, col([0xd8a040, 0xb83a2a, 0x6a8a3a, 0xe0c080][k]));
  return s.build();
}

/** The awning sloping down toward the road with a valance along its front edge (tinted: stripes in two shades of it). */
function stallAwningGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const z0 = STALL.back - 0.18;
  const z1 = STALL.front + 0.38;
  const y0 = STALL.backH + 0.05;
  const y1 = STALL.frontH - 0.02;
  const l = Math.hypot(z1 - z0, y0 - y1);
  const ny = (z1 - z0) / l;
  const nz = (y0 - y1) / l;
  const N = 6;
  const w = STALL.halfW + 0.22;
  for (let k = 0; k < N; k++) {
    const xa = -w + (2 * w * k) / N;
    const xb = -w + (2 * w * (k + 1)) / N;
    const c = col(0xffffff, k % 2 ? 0.55 : 1);
    quad4(s, [[xa, y0, z0], [xb, y0, z0], [xb, y1, z1], [xa, y1, z1]], [0, ny, nz], c);
    quad4(s, [[xa, y1, z1], [xb, y1, z1], [xb, y1 - 0.26, z1], [xa, y1 - 0.26, z1]], [0, 0, 1], c);
  }
  return s.build();
}

/** Paper lanterns hung under the awning's front edge: warm and bright, so they bloom. */
function stallLanternGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const Y = STALL.lanternY;
  [-0.7, 0, 0.7].forEach((x, k) => {
    const c = col(k === 1 ? 0xffa040 : 0xff4a2a, k === 1 ? 3 : 3.4);
    cyl(s, x, STALL.front + 0.22, Y - 0.16, Y, 0.09, 0.16, 6, c);
    cyl(s, x, STALL.front + 0.22, Y, Y + 0.16, 0.16, 0.08, 6, c);
  });
  return s.build();
}

/** Two crates of fruit side by side and one stacked on them (tinted: wood and fruit shift a little per stack). */
function fruitCratesGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const wood = col(0xa07a48);
  const slat = col(0x6a4c2a);
  const crates: [number, number, number, number][] = [
    [-0.27, 0, 0.02, 0xff7a1a],
    [0.29, 0, -0.04, 0x6ab82a],
    [0.02, 0.33, 0, 0xd8202a],
  ];
  for (const [x, y, z, fruit] of crates) {
    box(s, x, y + 0.15, z, 0.54, 0.3, 0.42, wood);
    box(s, x, y + 0.08, z, 0.56, 0.05, 0.44, slat);
    box(s, x, y + 0.31, z, 0.48, 0.05, 0.36, col(fruit));
  }
  return s.build();
}

/** Food cart, long side to the road: body and roof (tinted enamel). */
function foodCartBodyGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.8, 0, 1.5, 0.9, 0.8, col(0xffffff));
  box(s, 0, 2.18, 0.05, 1.8, 0.06, 1.15, col(0xffffff));
  box(s, 0, 2.1, 0.62, 1.8, 0.16, 0.03, col(0xd8d8d8), false);
  return s.build();
}

/** The cart's wheels, steel counter, roof posts and a pot and bowls on the counter. */
function foodCartDetailGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const dark = col(0x17181c);
  for (const x of [-0.5, 0.5]) for (const z of [-0.43, 0.43]) box(s, x, 0.24, z, 0.44, 0.44, 0.06, dark, false);
  box(s, 0, 1.27, 0.12, 1.56, 0.04, 1.0, col(0xb4b8c0));
  for (const x of [-0.82, 0.82]) box(s, x, 1.7, -0.42, 0.05, 0.95, 0.05, col(0x9a9ea6));
  cyl(s, -0.4, 0.05, 1.29, 1.5, 0.17, 0.17, 7, col(0x5a5c62));
  cyl(s, 0.35, 0.2, 1.29, 1.38, 0.11, 0.14, 7, col(0xe8e4dc));
  return s.build();
}

/** The cart's lit menu board and the bulbs along its roof edge. */
function foodCartGlowGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.98, 0.41, 1.1, 0.32, 0.02, col(0xffe0a0, 2.2), false);
  for (let k = 0; k < 6; k++) box(s, -0.75 + k * 0.3, 2.0, 0.64, 0.07, 0.07, 0.07, col(k % 2 ? 0xff7a3a : 0xffc070, 2.6), false);
  return s.build();
}

/** Per kind: mesh parts (geometry, material slot, tinted per instance?) and the tints. */
const CLUTTER: Record<DistrictPropKind, { parts: { geo: () => THREE.BufferGeometry; mat: 'matte' | 'solid' | 'canopy' | 'glow' | 'lamp'; tint?: boolean }[]; tints: number[]; spin: boolean }> = {
  bush: { parts: [{ geo: bushGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xd8e8c8, 0xf0ffd8, 0xc8d8b0], spin: true },
  planterPot: { parts: [{ geo: planterPotGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xe8dcd0, 0xd0d8e0], spin: true },
  cafeTable: { parts: [{ geo: cafeFrameGeo, mat: 'solid' }, { geo: cafeCanopyGeo, mat: 'canopy', tint: true }], tints: [0xc81e2e, 0x1d55c4, 0xe8e8ea, 0x2a9d5a, 0xf2b81c, 0x15161a], spin: true },
  barrel: { parts: [{ geo: barrelGeo, mat: 'matte' }], tints: [0xffffff], spin: true },
  crate: { parts: [{ geo: crateGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xd8c8b0, 0xb8a890], spin: true },
  dumpster: { parts: [{ geo: dumpsterGeo, mat: 'solid', tint: true }], tints: [0xffffff, 0x6080ff, 0x9a9a9a, 0xd06030], spin: false },
  newsBox: { parts: [{ geo: newsBoxGeo, mat: 'solid', tint: true }], tints: [0x2050c0, 0xc02020, 0xe0b020, 0x20a050, 0xe0e0e0], spin: false },
  trashBags: { parts: [{ geo: trashBagsGeo, mat: 'solid' }], tints: [0xffffff], spin: true },
  parkLamp: { parts: [{ geo: parkLampGeo, mat: 'solid' }, { geo: parkLanternGeo, mat: 'lamp' }], tints: [0xffffff], spin: false },
  bollard: { parts: [{ geo: bollardGeo, mat: 'solid' }, { geo: bollardBandGeo, mat: 'glow' }], tints: [0xffffff], spin: false },
  // Banners in contractors' colours: safety orange, navy, green, yellow, red, charcoal.
  fencePanel: { parts: [{ geo: fenceFrameGeo, mat: 'solid' }, { geo: fenceBannerGeo, mat: 'canopy', tint: true }], tints: [0xff6a1a, 0x1d3f8a, 0x2a8a4a, 0xf2b81c, 0xc0202a, 0x2a2c32], spin: false },
  trafficCone: { parts: [{ geo: trafficConeGeo, mat: 'matte' }], tints: [0xffffff], spin: true },
  sawhorse: { parts: [{ geo: sawhorseGeo, mat: 'matte' }, { geo: sawhorseLampGeo, mat: 'glow' }], tints: [0xffffff], spin: false },
  waterBarrier: { parts: [{ geo: waterBarrierGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xff6a1a, 0xe03030, 0xffffff, 0xff8a2a], spin: false },
  sandbags: { parts: [{ geo: sandbagsGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xe8dcc0, 0xc8b890], spin: false },
  pallets: { parts: [{ geo: palletsGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xd8c8b0, 0xb8a890], spin: true },
  // Market awnings in festival colours, food carts in enamel paint; stalls and carts square up with the curb.
  marketStall: {
    parts: [{ geo: stallFrameGeo, mat: 'solid' }, { geo: stallGoodsGeo, mat: 'matte' }, { geo: stallAwningGeo, mat: 'canopy', tint: true }, { geo: stallLanternGeo, mat: 'lamp' }],
    tints: [0xc8202a, 0xe86a1a, 0xf2b81c, 0x2a8a4a, 0x1d55c4, 0xe8e8ea, 0x8a2a9a, 0xd83a6a],
    spin: false,
  },
  fruitCrates: { parts: [{ geo: fruitCratesGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xf0e2cc, 0xe6eed8], spin: true },
  foodCart: {
    parts: [{ geo: foodCartBodyGeo, mat: 'solid', tint: true }, { geo: foodCartDetailGeo, mat: 'matte' }, { geo: foodCartGlowGeo, mat: 'glow' }],
    tints: [0xc8202a, 0x2a8a8a, 0xf2b81c, 0xe8e8ea, 0x1d3f8a],
    spin: false,
  },
};
/** Every kind drawn from a parts table: district clutter and the neighbourhood furniture. */
export const PARTS: Partial<Record<Prop['kind'], PropPartsDef>> = { ...CLUTTER, ...FURNITURE_PARTS };
export const PART_KINDS = Object.keys(PARTS) as Prop['kind'][];
export const isFurniture = (k: Prop['kind']): k is FurnitureKind => (FURNITURE_KINDS as readonly string[]).includes(k);

export function streetlightGeo(): { solid: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
  const s = new GeoBuilder(true);
  const metal = col(0x2a2c33);
  const H = STREETLIGHT_POLE_H;
  const A = STREETLIGHT_ARM;
  box(s, 0, 0.2, 0, 0.34, 0.4, 0.34, col(0x1c1d22));
  cyl(s, 0, 0, 0, H, 0.13, 0.09, 6, metal);
  box(s, 0, H - 0.1, A / 2, 0.1, 0.1, A, metal);
  box(s, 0, H - 0.25, A, 0.45, 0.16, 0.9, metal, false);
  const l = new GeoBuilder(true);
  box(l, 0, H - 0.34, A, 0.36, 0.04, 0.75, col(0xffc27a, 4), false);
  return { solid: s.build(), lens: l.build() };
}

export function stumpGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.2, 0, 0.34, 0.4, 0.34, col(0x1c1d22));
  cyl(s, 0, 0, 0, STUMP_H, 0.14, 0.12, 6, col(0x2a2c33));
  // Torn top: a few bent shards.
  box(s, 0.05, STUMP_H + 0.06, 0.02, 0.05, 0.16, 0.08, col(0x3a3c44));
  box(s, -0.06, STUMP_H + 0.03, -0.04, 0.06, 0.1, 0.05, col(0x3a3c44));
  return s.build();
}

export function trafficPoleGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const metal = col(0x3a3d44);
  box(s, 0, 0.2, 0, 0.4, 0.4, 0.4, col(0x1c1d22));
  cyl(s, 0, 0, 0, TRAFFIC_POLE_H, 0.15, 0.11, 7, metal);
  return s.build();
}

/** Unit mast arm along +X (scaled per instance to reach over the lanes). */
export function trafficArmGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0.5, 0, 0, 1, 0.12, 0.12, col(0x3a3d44), false);
  return s.build();
}

/** Signal head facing +Z, centered on its middle lens. */
export function trafficHeadGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0, -0.17, 0.62, 1.22, 0.03, col(0xb08a1a, 0.55), false); // backplate
  box(s, 0, 0, 0, 0.36, 1.0, 0.3, col(0x15161a), false);
  for (const y of [0.3, 0, -0.3]) box(s, 0, y + 0.13, 0.22, 0.3, 0.03, 0.16, col(0x101114), false); // visors
  box(s, 0, 0.56, 0, 0.06, 0.12, 0.06, col(0x2a2c33)); // hanger
  return s.build();
}

/** Three lens discs on the head's +Z face; aSlot 0 = red (top), 1 = amber, 2 = green. */
export function trafficLensGeo(): THREE.BufferGeometry {
  const pos: number[] = [];
  const slot: number[] = [];
  const idx: number[] = [];
  const seg = 10;
  const r = 0.115;
  [0.3, 0, -0.3].forEach((y, k) => {
    const c = pos.length / 3;
    pos.push(0, y, 0.152);
    slot.push(k);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y + Math.sin(a) * r, 0.152);
      slot.push(k);
    }
    for (let i = 0; i < seg; i++) idx.push(c, c + 1 + i, c + 1 + ((i + 1) % seg));
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSlot', new THREE.Float32BufferAttribute(slot, 1));
  g.setIndex(idx);
  return g;
}

export function canGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, 0, 0.9, 0.27, 0.31, 8, col(0xa8b0b0));
  cyl(s, 0, 0, 0.55, 0.62, 0.315, 0.315, 8, col(0x55595e));
  cyl(s, 0, 0, 0.9, 0.97, 0.335, 0.3, 8, col(0x30343a));
  return s.build();
}

export function benchGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const wood = col(0x7a5434);
  const iron = col(0x1a1b1f);
  for (const z of [-0.14, 0, 0.14]) box(s, 0, 0.46, z, 1.8, 0.04, 0.12, wood, false);
  for (const y of [0.64, 0.82]) box(s, 0, y, -0.25, 1.8, 0.13, 0.04, wood, false);
  for (const x of [-0.75, 0.75]) {
    box(s, x, 0.22, 0, 0.06, 0.44, 0.44, iron);
    box(s, x, 0.66, -0.28, 0.06, 0.5, 0.05, iron);
    box(s, x, 0.62, 0.05, 0.06, 0.04, 0.4, iron);
  }
  return s.build();
}

export function busStopGeo(): { solid: THREE.BufferGeometry; glass: THREE.BufferGeometry; ad: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
  const s = new GeoBuilder(true);
  const frame = col(0x2b2e36);
  for (const x of [-1.55, 1.55]) for (const z of [-0.62, 0.6]) box(s, x, 1.24, z, 0.08, 2.48, 0.08, frame);
  box(s, 0, 2.52, 0.04, 3.5, 0.1, 1.72, frame, false);
  box(s, 0, 2.38, -0.62, 3.1, 0.06, 0.06, frame);
  box(s, 0, 0.22, -0.62, 3.1, 0.06, 0.06, frame);
  // Ad box at the +X end and a bench along the back.
  box(s, 1.55, 1.25, -0.02, 0.16, 2.0, 1.16, col(0x1a1c22));
  box(s, -0.2, 0.46, -0.4, 2.4, 0.05, 0.38, col(0x8a9099));
  for (const x of [-1.2, 0.8]) box(s, x, 0.22, -0.4, 0.06, 0.44, 0.3, frame);
  const g = new GeoBuilder();
  box(g, 0, 1.3, -0.62, 3.02, 2.1, 0.025, col(0xffffff), false);
  box(g, -1.55, 1.3, -0.12, 0.025, 2.1, 0.92, col(0xffffff), false);
  // Lit poster on both faces of the ad box.
  const ad = new GeoBuilder();
  for (const side of [1, -1]) {
    const x = 1.55 + side * 0.082;
    const v = [
      [-0.5, 0.35, 0, 0],
      [0.46, 0.35, 1, 0],
      [0.46, 2.15, 1, 1],
      [-0.5, 2.15, 0, 1],
    ].map(([z, y, u, vv]) => ad.vertex(x, y, z * side, side, 0, 0, u, vv));
    ad.quadFacing(v[0], v[1], v[2], v[3], side, 0, 0);
  }
  // Cool light strip under the roof's front edge.
  const glow = new GeoBuilder(true);
  box(glow, 0, 2.455, 0.82, 3.2, 0.03, 0.05, col(0xcfe6ff, 2.4), false);
  return { solid: s.build(), glass: g.build(), ad: ad.build(), glow: glow.build() };
}

export function adTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  const gr = ctx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, '#ffffff');
  gr.addColorStop(0.55, '#8a8a96');
  gr.addColorStop(1, '#2a2a34');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.arc(W / 2, H * 0.36, W * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1a22';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('NIGHT', W / 2, H * 0.72);
  ctx.fillText('RUN', W / 2, H * 0.82);
  ctx.fillRect(14, H * 0.88, W - 28, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
