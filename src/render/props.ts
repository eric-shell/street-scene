/**
 * Destructible props from CityBlocks.props: street furniture (streetlights,
 * traffic lights, garbage cans, benches, bus stops) and district clutter
 * (bushes, planter pots, cafe tables, barrels, crates, dumpsters, news boxes,
 * trash bags, the lantern posts of parks and plazas, and the construction
 * pieces in route shortcuts: fence panels
 * with contractors' banners, cones, sawhorse barricades with a lamp, water
 * filled barriers, sandbags, pallets), and the neighbourhood furniture of
 * streetFurniture.ts (hydrants that gush when broken, hydrantSpray.ts, meters,
 * mailboxes, phone booths, vending machines), instanced per kind and part,
 * tinted per instance. Traffic
 * signals cycle red / amber / green in a shader (per intersection offset,
 * crossing directions out of phase), so they cost nothing on the CPU.
 *
 * Destruction mirrors RaceState.brokenProps: a broken prop's intact instances
 * collapse to zero scale (poles leave a stump), its light goes out, and its
 * parts break apart as pooled debris pushed along by the car that hit it.
 * Because the state is read back every frame from the sim's flags, a new
 * session (restart, replay) always starts consistent. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { DistrictPropKind, FurnitureKind, Prop } from '../city/props';
import { FURNITURE_KINDS } from '../city/props';
import { GeoBuilder } from './geoBuilder';
import { FOG_DENSITY } from './lighting';
import { fadeSubPixel } from './lightFx';
import { D_BOX, D_CYL, D_GLASS, D_GLOW, Debris, DebrisType } from './debris';
import { FURNITURE_PARTS, PropPartsDef, shatterFurniture } from './streetFurniture';
import { buildHydrantSpray } from './hydrantSpray';

/** Streetlight pole height and arm reach (lamp heads sit at the arm end). Matches cityMeshes lampPositions. */
export const STREETLIGHT_POLE_H = 8.2;
export const STREETLIGHT_ARM = 2.4;
/** Park lamp (lantern post) height and the height of its lantern's middle (m). */
export const PARK_LAMP_H = 4.4;
export const PARK_LANTERN_Y = 3.95;
const STUMP_H = 0.55;
const TRAFFIC_POLE_H = 5.6;
const TRAFFIC_ARM_Y = 5.25;
/** Signal cycle in seconds: green 0-9, amber 9-11, red 11-24 (the crossing direction is offset by half). */
const CYCLE = 24;

export interface CarMotion {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface PropRenderer {
  group: THREE.Group;
  /**
   * Mirror the sim's broken flags. Props that broke since the last call come
   * apart, pushed by the nearest car. Cheap when nothing changed.
   */
  update(dt: number, time: number, broken: ArrayLike<number> | undefined, cars: readonly CarMotion[]): void;
  dispose(): void;
}

export interface PropRendererOptions {
  /**
   * A lamp switched off (broken) or back on: a streetlight's `light` index,
   * or streetlights.length + k for the k-th park lamp (parkLamps order).
   */
  onLamp?(light: number, on: boolean): void;
}

/** The lantern posts of parks and plazas in light order: their lights follow the streetlights'. */
export function parkLamps(world: World): Prop[] {
  return (world.blocks.props ?? []).filter((p) => p.kind === 'parkLamp');
}

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

const col = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);

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
  // Banners in contractors' colours: safety orange, navy, green, yellow, red, charcoal.
  fencePanel: { parts: [{ geo: fenceFrameGeo, mat: 'solid' }, { geo: fenceBannerGeo, mat: 'canopy', tint: true }], tints: [0xff6a1a, 0x1d3f8a, 0x2a8a4a, 0xf2b81c, 0xc0202a, 0x2a2c32], spin: false },
  trafficCone: { parts: [{ geo: trafficConeGeo, mat: 'matte' }], tints: [0xffffff], spin: true },
  sawhorse: { parts: [{ geo: sawhorseGeo, mat: 'matte' }, { geo: sawhorseLampGeo, mat: 'glow' }], tints: [0xffffff], spin: false },
  waterBarrier: { parts: [{ geo: waterBarrierGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xff6a1a, 0xe03030, 0xffffff, 0xff8a2a], spin: false },
  sandbags: { parts: [{ geo: sandbagsGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xe8dcc0, 0xc8b890], spin: false },
  pallets: { parts: [{ geo: palletsGeo, mat: 'matte', tint: true }], tints: [0xffffff, 0xd8c8b0, 0xb8a890], spin: true },
};
/** Every kind drawn from a parts table: district clutter and the neighbourhood furniture. */
const PARTS: Partial<Record<Prop['kind'], PropPartsDef>> = { ...CLUTTER, ...FURNITURE_PARTS };
const PART_KINDS = Object.keys(PARTS) as Prop['kind'][];
const isFurniture = (k: Prop['kind']): k is FurnitureKind => (FURNITURE_KINDS as readonly string[]).includes(k);

function streetlightGeo(): { solid: THREE.BufferGeometry; lens: THREE.BufferGeometry } {
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

function stumpGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.2, 0, 0.34, 0.4, 0.34, col(0x1c1d22));
  cyl(s, 0, 0, 0, STUMP_H, 0.14, 0.12, 6, col(0x2a2c33));
  // Torn top: a few bent shards.
  box(s, 0.05, STUMP_H + 0.06, 0.02, 0.05, 0.16, 0.08, col(0x3a3c44));
  box(s, -0.06, STUMP_H + 0.03, -0.04, 0.06, 0.1, 0.05, col(0x3a3c44));
  return s.build();
}

function trafficPoleGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const metal = col(0x3a3d44);
  box(s, 0, 0.2, 0, 0.4, 0.4, 0.4, col(0x1c1d22));
  cyl(s, 0, 0, 0, TRAFFIC_POLE_H, 0.15, 0.11, 7, metal);
  return s.build();
}

/** Unit mast arm along +X (scaled per instance to reach over the lanes). */
function trafficArmGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0.5, 0, 0, 1, 0.12, 0.12, col(0x3a3d44), false);
  return s.build();
}

/** Signal head facing +Z, centered on its middle lens. */
function trafficHeadGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0, -0.17, 0.62, 1.22, 0.03, col(0xb08a1a, 0.55), false); // backplate
  box(s, 0, 0, 0, 0.36, 1.0, 0.3, col(0x15161a), false);
  for (const y of [0.3, 0, -0.3]) box(s, 0, y + 0.13, 0.22, 0.3, 0.03, 0.16, col(0x101114), false); // visors
  box(s, 0, 0.56, 0, 0.06, 0.12, 0.06, col(0x2a2c33)); // hanger
  return s.build();
}

/** Three lens discs on the head's +Z face; aSlot 0 = red (top), 1 = amber, 2 = green. */
function trafficLensGeo(): THREE.BufferGeometry {
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

function canGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  cyl(s, 0, 0, 0, 0.9, 0.27, 0.31, 8, col(0xa8b0b0));
  cyl(s, 0, 0, 0.55, 0.62, 0.315, 0.315, 8, col(0x55595e));
  cyl(s, 0, 0, 0.9, 0.97, 0.335, 0.3, 8, col(0x30343a));
  return s.build();
}

function benchGeo(): THREE.BufferGeometry {
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

function busStopGeo(): { solid: THREE.BufferGeometry; glass: THREE.BufferGeometry; ad: THREE.BufferGeometry; glow: THREE.BufferGeometry } {
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

function adTexture(): THREE.CanvasTexture {
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

const lensVert = /* glsl */ `
  attribute float aSlot;
  attribute float aOffset;
  varying float vSlot;
  varying float vLit;
  varying float vFog;
  varying vec3 vView;
  uniform float time;
  uniform float fogDensity;
  void main() {
    vSlot = aSlot;
    float t = mod(time + aOffset, ${CYCLE.toFixed(1)});
    float state = t < 9.0 ? 2.0 : (t < 11.0 ? 1.0 : 0.0);
    vLit = 1.0 - step(0.5, abs(state - aSlot));
    vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5);
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const lensFrag = /* glsl */ `
  varying float vSlot;
  varying float vLit;
  varying float vFog;
  varying vec3 vView;
  void main() {
    // Fade sub pixel lenses instead of letting them pop (see fadeSubPixel in lightFx).
    float px = clamp(0.23 / (2.0 * max(length(fwidth(vView)), 1e-5)), 0.25, 1.0);
    vec3 c = vSlot < 0.5 ? vec3(1.0, 0.05, 0.03) : (vSlot < 1.5 ? vec3(1.0, 0.5, 0.04) : vec3(0.08, 1.0, 0.45));
    gl_FragColor = vec4(c * mix(0.045, 3.4 * px, vLit) * vFog, 1.0);
  }
`;

// ---------------------------------------------------------------------------

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpTint = new THREE.Color();
/** Debris spawner of one breaking prop: local offsets (prop frame), half extents, push along the hit, lift, spin. */
type SpawnFn = (
  type: DebrisType,
  lx: number,
  ly: number,
  lz: number,
  yaw: number,
  hx: number,
  hy: number,
  hz: number,
  push: number,
  lift: number,
  spin: number,
  color: THREE.Color,
  life?: number,
  sparky?: boolean,
) => void;
const CAN_TINTS = [0x2f6a46, 0x2f6a46, 0x5a6068, 0x34507a, 0x7a3a2a].map((c) => new THREE.Color(c));
const AD_TINTS = [0xff3df2, 0x19e6ff, 0xffb020, 0x7cff6a, 0xffffff, 0xff4060].map((c) => new THREE.Color(c).multiplyScalar(1.5));

interface PartRef {
  mesh: number;
  index: number;
}

interface TrafficFrame {
  /** Unit arm direction (over the served road) and its length. */
  ax: number;
  az: number;
  len: number;
  /** Head facings (unit): arm heads face fa, the pole head faces fb. */
  fax: number;
  faz: number;
  fbx: number;
  fbz: number;
}

/** Direction helpers: local +Z of yaw is (sin, cos), local +X is (cos, -sin). */
const yawOf = (x: number, z: number) => Math.atan2(x, z);

export function buildProps(world: World, opts: PropRendererOptions = {}): PropRenderer {
  const group = new THREE.Group();
  group.name = 'props';
  const props: Prop[] = world.blocks.props ?? [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const solidMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 }));
  const glowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const lampLensMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  fadeSubPixel(lampLensMat, 0.36, 0.25);
  fadeSubPixel(glowMat, 0.05, 0.3);
  const matteMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }));
  const canopyMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }));
  const glassMat = track(new THREE.MeshStandardMaterial({ color: 0x9fc6e0, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6 }));
  const adMat = track(new THREE.MeshBasicMaterial({ map: track(adTexture()) }));
  const lensMat = track(
    new THREE.ShaderMaterial({ vertexShader: lensVert, fragmentShader: lensFrag, uniforms: { time: { value: 0 }, fogDensity: { value: FOG_DENSITY } } }),
  );

  const byKind = (k: Prop['kind']) => props.filter((p) => p.kind === k);
  const lights = byKind('streetlight');
  const traffic = byKind('trafficLight');
  const cans = byKind('garbageCan');
  const benches = byKind('bench');
  const stops = byKind('busStop');
  const lanterns = parkLamps(world);
  // Light index of every lamp prop (-1 for the rest): streetlights by `light`, park lamps after them.
  const lightOf = new Int32Array(props.length).fill(-1);
  for (const p of lights) lightOf[p.id] = p.light ?? p.id;
  lanterns.forEach((p, k) => (lightOf[p.id] = lights.length + k));

  const meshes: THREE.InstancedMesh[] = [];
  const parts: PartRef[][] = props.map(() => []);
  const stumpOf = new Int32Array(props.length).fill(-1);
  const addMesh = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, count: number): number => {
    const m = new THREE.InstancedMesh(track(geo), mat, Math.max(1, count));
    m.count = count;
    m.name = name;
    meshes.push(m);
    if (count > 0) group.add(m);
    return meshes.length - 1;
  };
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const place = (mesh: number, index: number, p: Prop | null, x: number, y: number, z: number, yaw: number, sx = 1): void => {
    quat.setFromAxisAngle(up, yaw);
    pos.set(x, y, z);
    scl.set(sx, 1, 1);
    mat4.compose(pos, quat, scl);
    meshes[mesh].setMatrixAt(index, mat4);
    if (p) parts[p.id].push({ mesh, index });
  };

  // Streetlights.
  {
    const geo = streetlightGeo();
    const solid = addMesh('streetlightPoles', geo.solid, solidMat, lights.length);
    const lens = addMesh('streetlightLenses', geo.lens, lampLensMat, lights.length);
    lights.forEach((p, i) => {
      place(solid, i, p, p.x, p.y, p.z, p.yaw);
      place(lens, i, p, p.x, p.y, p.z, p.yaw);
    });
  }

  // Traffic lights: each serves the road on one side of its corner with a mast
  // arm and two hanging heads, plus a pole mounted head for the other road.
  const frames: TrafficFrame[] = traffic.map((p) => trafficFrame(world, p));
  const lensOffsets = new Float32Array(traffic.length * 3);
  {
    const pole = addMesh('trafficPoles', trafficPoleGeo(), solidMat, traffic.length);
    const arm = addMesh('trafficArms', trafficArmGeo(), solidMat, traffic.length);
    const head = addMesh('trafficHeads', trafficHeadGeo(), solidMat, traffic.length * 3);
    const lens = addMesh('trafficLenses', trafficLensGeo(), lensMat, traffic.length * 3);
    traffic.forEach((p, i) => {
      const f = frames[i];
      place(pole, i, p, p.x, p.y, p.z, p.yaw);
      place(arm, i, p, p.x, p.y + TRAFFIC_ARM_Y, p.z, Math.atan2(-f.az, f.ax), f.len);
      const ya = yawOf(f.fax, f.faz);
      const yb = yawOf(f.fbx, f.fbz);
      const heads: [number, number, number, number][] = [
        [p.x + f.ax * f.len * 0.55, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * 0.55, ya],
        [p.x + f.ax * f.len * 0.92, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * 0.92, ya],
        [p.x + f.fbx * 0.32, p.y + 3.1, p.z + f.fbz * 0.32, yb],
      ];
      // Per intersection offset; the direction crossing the reference axis runs half a cycle later.
      const node = p.node ?? -1;
      const base = node >= 0 ? hash01(node * 7919 + world.seed) * CYCLE : 0;
      const ref = node >= 0 ? nodeAxis(world, node) : 0;
      heads.forEach(([x, y, z, yaw], k) => {
        place(head, i * 3 + k, p, x, y, z, yaw);
        place(lens, i * 3 + k, p, x, y, z, yaw);
        const fx = k < 2 ? f.fax : f.fbx;
        const fz = k < 2 ? f.faz : f.fbz;
        let d = Math.abs(Math.atan2(fx, fz) - ref) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        lensOffsets[i * 3 + k] = base + (d > Math.PI / 4 ? CYCLE / 2 : 0);
      });
    });
    meshes[lens].geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(lensOffsets, 1));
    meshes[lens].frustumCulled = false;
  }

  // Stumps left behind by broken poles (hidden until needed).
  const poles = [...lights, ...traffic, ...lanterns];
  const stump = addMesh('propStumps', stumpGeo(), solidMat, poles.length);
  poles.forEach((p, i) => {
    stumpOf[p.id] = i;
    meshes[stump].setMatrixAt(i, ZERO);
  });

  // Garbage cans, tinted per instance.
  {
    const m = addMesh('garbageCans', canGeo(), solidMat, cans.length);
    cans.forEach((p, i) => {
      place(m, i, p, p.x, p.y, p.z, p.yaw + hash01(p.id) * 6.28);
      meshes[m].setColorAt(i, CAN_TINTS[(hash01(p.id * 31) * CAN_TINTS.length) | 0]);
    });
  }
  {
    const m = addMesh('benches', benchGeo(), solidMat, benches.length);
    benches.forEach((p, i) => place(m, i, p, p.x, p.y, p.z, p.yaw));
  }
  const adTint: THREE.Color[] = [];
  {
    const geo = busStopGeo();
    const solid = addMesh('busStops', geo.solid, solidMat, stops.length);
    const glass = addMesh('busStopGlass', geo.glass, glassMat, stops.length);
    const ad = addMesh('busStopAds', geo.ad, adMat, stops.length);
    const glow = addMesh('busStopLights', geo.glow, glowMat, stops.length);
    meshes[glass].renderOrder = 4;
    stops.forEach((p, i) => {
      for (const m of [solid, glass, ad, glow]) place(m, i, p, p.x, p.y, p.z, p.yaw);
      const tint = AD_TINTS[(hash01(p.id * 13) * AD_TINTS.length) | 0];
      meshes[ad].setColorAt(i, tint);
      adTint[p.id] = tint;
    });
  }

  // District clutter and neighbourhood furniture, tinted per instance; most clutter gets a random spin so rows never look stamped.
  const tintOf: THREE.Color[] = [];
  for (const kind of PART_KINDS) {
    const list = byKind(kind);
    if (!list.length) continue;
    const def = PARTS[kind]!;
    const matOf = { matte: matteMat, canopy: canopyMat, solid: solidMat, glow: glowMat, lamp: lampLensMat, glass: glassMat } as const;
    const ids = def.parts.map((part, k) => addMesh(`${kind}${k}`, part.geo(), matOf[part.mat], list.length));
    // Glass after the opaque pass, like the bus shelters'.
    def.parts.forEach((part, k) => part.mat === 'glass' && (meshes[ids[k]].renderOrder = 4));
    list.forEach((p, i) => {
      const yaw = p.yaw + (def.spin ? hash01(p.id * 7) * 6.28 : 0);
      const tint = tmpTint.setHex(def.tints[(hash01(p.id * 17) * def.tints.length) | 0]).multiplyScalar(0.85 + 0.3 * hash01(p.id * 23));
      tintOf[p.id] = tint.clone();
      def.parts.forEach((part, k) => {
        place(ids[k], i, p, p.x, p.y, p.z, yaw);
        if (part.tint) meshes[ids[k]].setColorAt(i, tint);
      });
    });
  }

  // Keep the intact matrices so a prop can be restored.
  const intact = meshes.map((m) => (m.instanceMatrix.array as Float32Array).slice());
  const stumpBase = new Float32Array(poles.length * 16);
  poles.forEach((p, i) => {
    quat.setFromAxisAngle(up, p.yaw);
    mat4.compose(pos.set(p.x, p.y, p.z), quat, scl.set(1, 1, 1));
    mat4.toArray(stumpBase, i * 16);
  });

  const debris = new Debris(world.heightAt);
  const clutterYaw = (p: Prop) => p.yaw + (PARTS[p.kind]?.spin ? hash01(p.id * 7) * 6.28 : 0);
  group.add(debris.group);
  // Broken hydrants gush for the rest of the race.
  const spray = buildHydrantSpray();
  group.add(spray.mesh);
  const shown = new Uint8Array(props.length);
  const tmpC = new THREE.Color();

  const setBroken = (p: Prop, broken: boolean) => {
    for (const r of parts[p.id]) {
      const m = meshes[r.mesh];
      if (broken) m.setMatrixAt(r.index, ZERO);
      else (m.instanceMatrix.array as Float32Array).set(intact[r.mesh].subarray(r.index * 16, r.index * 16 + 16), r.index * 16);
      m.instanceMatrix.needsUpdate = true;
    }
    const s = stumpOf[p.id];
    if (s >= 0) {
      const m = meshes[stump];
      if (broken) (m.instanceMatrix.array as Float32Array).set(stumpBase.subarray(s * 16, s * 16 + 16), s * 16);
      else m.setMatrixAt(s, ZERO);
      m.instanceMatrix.needsUpdate = true;
    }
    if (lightOf[p.id] >= 0) opts.onLamp?.(lightOf[p.id], !broken);
  };

  // ---------- Debris ----------
  /** World position of a local offset in a yaw frame. */
  const wx = (p: Prop, yaw: number, lx: number, lz: number) => p.x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
  const wz = (p: Prop, yaw: number, lx: number, lz: number) => p.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  const shatter = (p: Prop, hitVx: number, hitVz: number) => {
    let speed = Math.hypot(hitVx, hitVz);
    let dx: number;
    let dz: number;
    if (speed > 0.5) {
      dx = hitVx / speed;
      dz = hitVz / speed;
    } else {
      // No car nearby (or a slow nudge): fall away from the road.
      dx = -Math.sin(p.yaw);
      dz = -Math.cos(p.yaw);
      speed = 4;
    }
    speed = Math.min(speed, 38);
    const spawn = (
      type: DebrisType,
      lx: number,
      ly: number,
      lz: number,
      yaw: number,
      hx: number,
      hy: number,
      hz: number,
      push: number,
      lift: number,
      spin: number,
      color: THREE.Color,
      life = rnd(4, 5.5),
      sparky = false,
    ) =>
      debris.spawn({
        type,
        x: wx(p, p.yaw, lx, lz),
        y: p.y + ly,
        z: wz(p, p.yaw, lx, lz),
        yaw,
        hx,
        hy,
        hz,
        vx: dx * speed * push + rnd(-1, 1) * (1 + speed * 0.05),
        vy: lift,
        vz: dz * speed * push + rnd(-1, 1) * (1 + speed * 0.05),
        wx: rnd(-spin, spin),
        wy: rnd(-spin, spin),
        wz: rnd(-spin, spin),
        color,
        life,
        sparky,
        bounce: type === D_GLASS ? 0.12 : 0.25,
      });

    if (p.kind === 'streetlight' || p.kind === 'trafficLight' || p.kind === 'parkLamp') {
      const isLamp = p.kind === 'streetlight';
      const isLantern = p.kind === 'parkLamp';
      const H = isLamp ? STREETLIGHT_POLE_H : isLantern ? PARK_LAMP_H : TRAFFIC_POLE_H;
      const len = H - STUMP_H;
      // The pole topples about its broken base, top falling along the hit direction.
      const ox = p.x;
      const oz = p.z;
      const oy = p.y + STUMP_H + len / 2;
      const vx = dx * speed * 0.2;
      const vz = dz * speed * 0.2;
      const vy = 0.6 + speed * 0.04;
      const w = 0.3 + speed * 0.03;
      const twx = dz * w;
      const twz = -dx * w;
      const twy = rnd(-0.4, 0.4);
      const metal = col(isLamp ? 0x2a2c33 : isLantern ? 0x22252b : 0x3a3d44);
      const r = isLantern ? 0.07 : 0.12;
      debris.spawn({ type: D_CYL, x: ox, y: oy, z: oz, yaw: p.yaw, hx: r, hy: len / 2, hz: r, vx, vy, vz, wx: twx, wy: twy, wz: twz, color: metal, life: rnd(5.5, 6.5), sparky: true });
      // Parts at the top start with the pole's rigid velocity, then fly loose.
      const attached = (type: DebrisType, x: number, y: number, z: number, yaw: number, hx: number, hy: number, hz: number, color: THREE.Color, life: number, kick = 0) => {
        const rx = x - ox;
        const ry = y - oy;
        const rz = z - oz;
        debris.spawn({
          type,
          x,
          y,
          z,
          yaw,
          hx,
          hy,
          hz,
          vx: vx + (twy * rz - twz * ry) + rnd(-kick, kick),
          vy: vy + (twz * rx - twx * rz) + rnd(0, kick),
          vz: vz + (twx * ry - twy * rx) + rnd(-kick, kick),
          wx: rnd(-2, 2),
          wy: rnd(-2, 2),
          wz: rnd(-2, 2),
          color,
          life,
          sparky: type !== D_GLASS,
          bounce: type === D_GLASS ? 0.12 : 0.25,
        });
      };
      if (isLamp) {
        const A = STREETLIGHT_ARM;
        const fx = Math.sin(p.yaw);
        const fz = Math.cos(p.yaw);
        attached(D_BOX, p.x + fx * A * 0.5, p.y + H - 0.1, p.z + fz * A * 0.5, p.yaw, 0.05, 0.05, A / 2, metal, rnd(5, 6));
        attached(D_BOX, p.x + fx * A, p.y + H - 0.25, p.z + fz * A, p.yaw, 0.225, 0.08, 0.45, metal, rnd(5, 6), 0.5);
        attached(D_GLOW, p.x + fx * A, p.y + H - 0.36, p.z + fz * A, p.yaw, 0.17, 0.02, 0.33, col(0xffc27a, 3), rnd(4, 5), 1.5);
        for (let k = 0; k < 7; k++) attached(D_GLASS, p.x + fx * A + rnd(-0.2, 0.2), p.y + H - 0.36, p.z + fz * A + rnd(-0.3, 0.3), rnd(0, 6.28), rnd(0.04, 0.1), 0.008, rnd(0.04, 0.12), col(0xfff0d8), rnd(2.5, 4), 3);
        debris.burst(p.x + fx * A, p.y + H - 0.35, p.z + fz * A, dx, dz, 3, 14);
      } else if (isLantern) {
        const Y = PARK_LANTERN_Y;
        attached(D_CYL, p.x, p.y + Y + 0.4, p.z, p.yaw, 0.28, 0.06, 0.28, metal, rnd(5, 6), 0.8);
        attached(D_GLOW, p.x, p.y + Y, p.z, p.yaw, 0.15, 0.25, 0.15, col(0xffd6a0, 2.5), rnd(3.5, 4.5), 1.2);
        for (let k = 0; k < 8; k++) attached(D_GLASS, p.x + rnd(-0.2, 0.2), p.y + Y + rnd(-0.25, 0.25), p.z + rnd(-0.2, 0.2), rnd(0, 6.28), rnd(0.04, 0.1), 0.008, rnd(0.04, 0.12), col(0xfff0d8), rnd(2.5, 4), 3);
        debris.burst(p.x, p.y + Y, p.z, dx, dz, 2.5, 10);
      } else {
        const f = frames[traffic.indexOf(p)];
        if (f) {
          const ay = Math.atan2(-f.az, f.ax);
          attached(D_BOX, p.x + f.ax * f.len * 0.5, p.y + TRAFFIC_ARM_Y, p.z + f.az * f.len * 0.5, ay, f.len / 2, 0.06, 0.06, metal, rnd(5, 6));
          const ya = yawOf(f.fax, f.faz);
          for (const t of [0.55, 0.92]) attached(D_BOX, p.x + f.ax * f.len * t, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * t, ya, 0.18, 0.5, 0.15, col(0x15161a), rnd(5, 6), 1);
          attached(D_BOX, p.x + f.fbx * 0.32, p.y + 3.1, p.z + f.fbz * 0.32, yawOf(f.fbx, f.fbz), 0.18, 0.5, 0.15, col(0x15161a), rnd(5, 6), 1);
          const lensCols = [col(0xff1a10, 3), col(0xff8a10, 3), col(0x20ff80, 3)];
          for (let k = 0; k < 5; k++) {
            const t = rnd(0.5, 0.95);
            attached(D_GLOW, p.x + f.ax * f.len * t, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * t, rnd(0, 6.28), 0.06, 0.06, 0.012, lensCols[k % 3], rnd(2.5, 4), 3);
          }
          debris.burst(p.x + f.ax * f.len * 0.7, p.y + TRAFFIC_ARM_Y - 0.6, p.z + f.az * f.len * 0.7, dx, dz, 2, 10);
        }
      }
      // Sparks where the car sheared the pole off.
      debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.45 + 3, 26);
      return;
    }

    if (p.kind === 'garbageCan') {
      const tint = CAN_TINTS[(hash01(p.id * 31) * CAN_TINTS.length) | 0];
      spawn(D_CYL, 0, 0.46, 0, 0, 0.3, 0.45, 0.3, rnd(0.6, 0.8), 2 + speed * 0.12, 7, tmpC.copy(tint).multiplyScalar(0.7));
      spawn(D_CYL, 0, 0.95, 0, 0, 0.33, 0.035, 0.33, rnd(0.6, 0.9), 3.5 + speed * 0.16, 12, col(0x30343a));
      const trash = [0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a, 0xe8e0a0, 0x505a68];
      for (let k = 0; k < 9; k++) {
        const s = rnd(0.04, 0.11);
        spawn(D_BOX, rnd(-0.2, 0.2), rnd(0.3, 0.8), rnd(-0.2, 0.2), rnd(0, 6.28), s, s * rnd(0.3, 1), s * rnd(0.5, 1.4), rnd(0.35, 0.8), rnd(1.5, 4.5) + speed * 0.05, 10, col(trash[k % trash.length]), rnd(3, 4.5));
      }
      return;
    }

    if (p.kind === 'bench') {
      const wood = col(0x7a5434);
      const iron = col(0x1a1b1f);
      for (const z of [-0.14, 0, 0.14]) spawn(D_BOX, rnd(-0.1, 0.1), 0.46, z, p.yaw + rnd(-0.2, 0.2), 0.9, 0.02, 0.06, rnd(0.45, 0.7), rnd(1.5, 3.5) + speed * 0.06, 5, wood);
      for (const y of [0.64, 0.82]) spawn(D_BOX, rnd(-0.1, 0.1), y, -0.25, p.yaw + rnd(-0.2, 0.2), 0.9, 0.065, 0.02, rnd(0.45, 0.7), rnd(2, 4) + speed * 0.06, 5, wood);
      for (const x of [-0.75, 0.75]) spawn(D_BOX, x, 0.35, 0, p.yaw, 0.03, 0.33, 0.22, rnd(0.4, 0.6), rnd(1, 3), 6, iron, rnd(4, 5.5), true);
      debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.3 + 2, 8);
      return;
    }

    if (isFurniture(p.kind)) {
      shatterFurniture(p.kind, spawn, speed, p.yaw, tintOf[p.id] ?? col(0xffffff), (ly, sp, n) => debris.burst(p.x, p.y + ly, p.z, dx, dz, sp, n));
      return;
    }
    if (p.kind !== 'busStop') {
      shatterClutter(p, spawn, speed, dx, dz);
      return;
    }
    {
      const frame = col(0x2b2e36);
      spawn(D_BOX, 0, 2.52, 0.04, p.yaw + rnd(-0.1, 0.1), 1.75, 0.05, 0.86, rnd(0.2, 0.35), rnd(1.5, 3), 1.5, frame, rnd(5, 6), true);
      for (const x of [-1.55, 1.55]) for (const z of [-0.62, 0.6]) spawn(D_BOX, x, 1.24, z, p.yaw, 0.04, 1.22, 0.04, rnd(0.3, 0.6), rnd(1, 3), 4, frame, rnd(4.5, 6), true);
      spawn(D_GLOW, 1.55, 1.25, -0.02, p.yaw, 0.08, 0.95, 0.56, rnd(0.3, 0.5), rnd(1, 2.5), 3, (adTint[p.id] ?? AD_TINTS[0]).clone());
      spawn(D_BOX, -0.2, 0.46, -0.4, p.yaw + rnd(-0.2, 0.2), 1.2, 0.03, 0.19, rnd(0.4, 0.6), rnd(1, 3), 3, col(0x8a9099));
      const glass = col(0xbfe0ff);
      for (let k = 0; k < 28; k++) {
        const back = k < 20;
        const lx = back ? rnd(-1.5, 1.5) : -1.55;
        const lz = back ? -0.62 : rnd(-0.55, 0.3);
        spawn(D_GLASS, lx, rnd(0.3, 2.3), lz, rnd(0, 6.28), rnd(0.06, 0.2), rnd(0.06, 0.2), 0.008, rnd(0.25, 0.75), rnd(0.5, 3.5), 9, glass, rnd(2.5, 4));
      }
      debris.burst(p.x, p.y + 1.2, p.z, dx, dz, speed * 0.3 + 2, 12);
    }
  };

  /** District clutter coming apart; `spawn` takes local offsets in the prop's frame. */
  function shatterClutter(p: Prop, spawn: SpawnFn, speed: number, dx: number, dz: number): void {
    const tint = tintOf[p.id] ?? col(0xffffff);
    const yaw = clutterYaw(p);
    const leaves = (n: number, y0: number, y1: number, r: number, base: number) => {
      for (let k = 0; k < n; k++) {
        const s = rnd(0.05, 0.14);
        const c = col(base, rnd(0.75, 1.15)).multiply(tint);
        spawn(D_BOX, rnd(-r, r), rnd(y0, y1), rnd(-r, r), rnd(0, 6.28), s, s * 0.4, s, rnd(0.35, 0.8), rnd(1.5, 4) + speed * 0.06, 10, c, rnd(2.5, 4));
      }
    };
    switch (p.kind) {
      case 'bush':
        leaves(16, 0.2, 1.0, 0.6, 0x3d7436);
        for (let k = 0; k < 4; k++) spawn(D_CYL, rnd(-0.2, 0.2), 0.4, rnd(-0.2, 0.2), rnd(0, 6.28), 0.02, rnd(0.2, 0.35), 0.02, rnd(0.4, 0.7), rnd(1.5, 3), 8, col(0x4a3420), rnd(3, 4));
        return;
      case 'planterPot':
        for (let k = 0; k < 7; k++) {
          const s = rnd(0.1, 0.22);
          spawn(D_BOX, rnd(-0.35, 0.35), rnd(0.15, 0.55), rnd(-0.35, 0.35), rnd(0, 6.28), s, s * rnd(0.5, 1), s * rnd(0.6, 1.2), rnd(0.35, 0.7), rnd(1, 3) + speed * 0.05, 7, col(0x8a8c94, rnd(0.8, 1.1)).multiply(tint), rnd(4, 5.5));
        }
        for (let k = 0; k < 8; k++) spawn(D_BOX, rnd(-0.3, 0.3), 0.62, rnd(-0.3, 0.3), rnd(0, 6.28), 0.06, 0.04, 0.06, rnd(0.4, 0.8), rnd(1, 2.5), 6, col(0x2a1d14), rnd(2.5, 4));
        spawn(D_BOX, 0, 1.0, 0, rnd(0, 6.28), 0.32, 0.3, 0.32, rnd(0.5, 0.8), 2 + speed * 0.08, 6, col(0x3a6e34).multiply(tint));
        leaves(8, 0.8, 1.4, 0.4, 0x3a6e34);
        debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.2 + 1, 6);
        return;
      case 'cafeTable': {
        const alu = col(0xb4b8c0);
        spawn(D_CYL, 0, 0.74, 0, yaw, 0.38, 0.02, 0.38, rnd(0.5, 0.8), 2.5 + speed * 0.1, 9, col(0xe6e6e2), rnd(4, 5.5), true);
        spawn(D_CYL, 0, 0.4, 0, yaw, 0.035, 0.36, 0.035, rnd(0.4, 0.7), rnd(1.5, 3), 6, alu, rnd(4, 5.5), true);
        for (const side of [-0.62, 0.62]) spawn(D_BOX, side, 0.5, 0, yaw + rnd(-0.5, 0.5), 0.21, 0.3, 0.21, rnd(0.55, 0.95), rnd(2, 4) + speed * 0.08, 10, alu, rnd(4, 5.5), true);
        spawn(D_BOX, 0, 2.05, 0, yaw, 1.05, 0.03, 1.05, rnd(0.25, 0.45), rnd(3, 5) + speed * 0.1, 4, tint.clone(), rnd(4.5, 6));
        spawn(D_CYL, 0, 1.5, 0, yaw, 0.025, 0.75, 0.025, rnd(0.3, 0.5), rnd(1.5, 3), 5, alu, rnd(4, 5.5));
        return;
      }
      case 'barrel':
        spawn(D_CYL, 0, 0.48, 0, yaw, 0.38, 0.47, 0.38, rnd(0.6, 0.9), 2.5 + speed * 0.12, 8, col(0xff6a1a), rnd(4.5, 6));
        spawn(D_CYL, 0, 0.97, 0, yaw, 0.29, 0.025, 0.29, rnd(0.6, 0.9), 3.5 + speed * 0.15, 12, col(0x1c1d20));
        debris.burst(p.x, p.y + 0.4, p.z, dx, dz, speed * 0.15 + 1, 4);
        return;
      case 'crate': {
        const wood = col(0x9a7444).multiply(tint);
        for (let k = 0; k < 9; k++) spawn(D_BOX, rnd(-0.35, 0.35), rnd(0.1, 1.1), rnd(-0.35, 0.35), rnd(0, 6.28), rnd(0.25, 0.43), 0.03, rnd(0.05, 0.08), rnd(0.45, 0.85), rnd(1.5, 4) + speed * 0.07, 9, wood.clone().multiplyScalar(rnd(0.7, 1.1)));
        spawn(D_BOX, 0.08, 1.0, -0.06, yaw, 0.31, 0.2, 0.31, rnd(0.5, 0.8), 2.5 + speed * 0.1, 6, wood);
        return;
      }
      case 'dumpster': {
        const body = col(0x2f6a46).multiply(tint);
        spawn(D_BOX, 0, 0.72, 0, p.yaw, 0.95, 0.54, 0.58, rnd(0.3, 0.45), 1 + speed * 0.05, 2.5, body, rnd(6, 7), true);
        spawn(D_BOX, 0, 1.4, 0, p.yaw + rnd(-0.3, 0.3), 0.98, 0.04, 0.61, rnd(0.35, 0.55), 3 + speed * 0.1, 5, col(0x1c2a22), rnd(5, 6), true);
        const trash = [0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a, 0xe8e0a0, 0x17191c];
        for (let k = 0; k < 12; k++) {
          const s = rnd(0.05, 0.16);
          spawn(D_BOX, rnd(-0.8, 0.8), rnd(0.8, 1.3), rnd(-0.4, 0.4), rnd(0, 6.28), s, s * rnd(0.4, 1), s, rnd(0.4, 0.8), rnd(2, 4.5) + speed * 0.06, 10, col(trash[k % trash.length]), rnd(3, 4.5));
        }
        debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.35 + 3, 22);
        return;
      }
      case 'newsBox':
        spawn(D_BOX, 0, 0.6, 0, p.yaw, 0.25, 0.46, 0.22, rnd(0.55, 0.85), 2 + speed * 0.1, 7, col(0xd8d8d8).multiply(tint), rnd(4.5, 6), true);
        spawn(D_GLASS, 0, 0.8, 0.23, p.yaw, 0.2, 0.16, 0.01, rnd(0.5, 0.8), rnd(2, 3.5), 8, col(0xbfe0ff), rnd(2.5, 4));
        for (let k = 0; k < 10; k++) spawn(D_BOX, rnd(-0.2, 0.2), rnd(0.5, 1), rnd(-0.2, 0.2), rnd(0, 6.28), rnd(0.1, 0.16), 0.004, rnd(0.12, 0.2), rnd(0.25, 0.6), rnd(2.5, 5), 4, col(0xeeeae0), rnd(3.5, 5));
        return;
      case 'fencePanel': {
        // The panel folds over and skates off; its feet stay near the line, wire and banner tear loose.
        const steel = col(0x9aa0a8);
        spawn(D_BOX, 0, 1.1, 0, p.yaw + rnd(-0.4, 0.4), 1.18, 0.98, 0.03, rnd(0.55, 0.85), rnd(1.5, 3) + speed * 0.06, 4, col(0x7a8088), rnd(4.5, 6), true);
        spawn(D_BOX, rnd(-0.3, 0.3), 1.0, 0.05, p.yaw + rnd(-0.6, 0.6), 1.12, 0.46, 0.012, rnd(0.4, 0.7), rnd(2.5, 4.5) + speed * 0.08, 6, tint.clone(), rnd(4.5, 6));
        for (const x of [-1.15, 1.15]) spawn(D_BOX, x, 0.07, 0, p.yaw + rnd(-0.5, 0.5), 0.13, 0.07, 0.31, rnd(0.15, 0.3), rnd(0.5, 1.2), 4, col(0x7e8086), rnd(5, 6.5));
        for (let k = 0; k < 6; k++) spawn(D_CYL, rnd(-1, 1), rnd(0.3, 1.9), 0, rnd(0, 6.28), 0.012, rnd(0.2, 0.45), 0.012, rnd(0.4, 0.9), rnd(1.5, 4), 10, steel, rnd(3, 4.5), true);
        return;
      }
      case 'trafficCone':
        spawn(D_CYL, 0, 0.4, 0, yaw, 0.12, 0.36, 0.12, rnd(0.7, 1.1), rnd(2.5, 5) + speed * 0.12, 12, col(0xff5a14), rnd(4, 5.5));
        spawn(D_BOX, 0, 0.02, 0, yaw, 0.22, 0.02, 0.22, rnd(0.4, 0.8), rnd(1, 2.5), 8, col(0x1c1d22), rnd(4, 5.5));
        return;
      case 'sawhorse': {
        for (const y of [0.6, 0.92]) spawn(D_BOX, rnd(-0.1, 0.1), y, 0, p.yaw + rnd(-0.5, 0.5), 0.7, 0.11, 0.02, rnd(0.55, 0.95), rnd(2, 4) + speed * 0.09, 9, col(y > 0.8 ? 0xff6a1a : 0xf4f4f0), rnd(4.5, 6));
        for (let k = 0; k < 4; k++) spawn(D_BOX, k < 2 ? -0.62 : 0.62, 0.5, k % 2 ? 0.22 : -0.22, rnd(0, 6.28), 0.025, 0.48, 0.025, rnd(0.4, 0.8), rnd(1.5, 3), 9, col(0x3a3c42), rnd(4, 5.5));
        spawn(D_GLOW, 0.55, 1.1, 0, rnd(0, 6.28), 0.055, 0.065, 0.04, rnd(0.6, 1), rnd(2.5, 4.5), 12, col(0xffa21a, 2.4), rnd(2.5, 3.5));
        return;
      }
      case 'waterBarrier': {
        // The shell splits and the water goes everywhere.
        for (let k = 0; k < 3; k++) spawn(D_BOX, -0.6 + 0.6 * k, 0.45, 0, p.yaw + rnd(-0.6, 0.6), 0.32, rnd(0.25, 0.4), 0.26, rnd(0.35, 0.65), rnd(1.5, 3.5) + speed * 0.06, 6, col(0xf4f4f0).multiply(tint), rnd(5, 6.5));
        for (let k = 0; k < 18; k++) spawn(D_GLASS, rnd(-0.8, 0.8), rnd(0.3, 0.8), rnd(-0.25, 0.25), rnd(0, 6.28), rnd(0.05, 0.12), rnd(0.05, 0.12), 0.01, rnd(0.3, 0.8), rnd(2, 4.5), 8, col(0x9fc6e0), rnd(1.2, 2.2));
        debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.25 + 2, 10);
        return;
      }
      case 'sandbags':
        for (let k = 0; k < 6; k++) spawn(D_BOX, rnd(-0.6, 0.6), rnd(0.1, 0.45), rnd(-0.1, 0.1), rnd(0, 6.28), 0.2, 0.08, 0.15, rnd(0.25, 0.55), rnd(0.8, 2) + speed * 0.04, 5, col(0xb09a6a, rnd(0.8, 1.05)).multiply(tint), rnd(5, 6.5));
        for (let k = 0; k < 10; k++) {
          const s = rnd(0.03, 0.07);
          spawn(D_BOX, rnd(-0.5, 0.5), rnd(0.2, 0.5), rnd(-0.15, 0.15), rnd(0, 6.28), s, s, s, rnd(0.3, 0.7), rnd(1, 3), 8, col(0xc8b080), rnd(2, 3.5));
        }
        debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.15 + 1, 6);
        return;
      case 'pallets': {
        const wood = col(0xa8875a).multiply(tint);
        for (let k = 0; k < 10; k++) spawn(D_BOX, rnd(-0.5, 0.5), rnd(0.05, 0.4), rnd(-0.4, 0.4), rnd(0, 6.28), rnd(0.4, 0.55), 0.015, rnd(0.05, 0.07), rnd(0.45, 0.85), rnd(1.5, 3.5) + speed * 0.07, 9, wood.clone().multiplyScalar(rnd(0.75, 1.1)));
        spawn(D_BOX, 0.05, 0.6, 0, yaw + rnd(-0.4, 0.4), 0.45, 0.18, 0.4, rnd(0.45, 0.75), rnd(2, 3.5) + speed * 0.08, 6, col(0x8a6a44).multiply(tint), rnd(5, 6.5), true);
        return;
      }
      case 'trashBags':
        for (let k = 0; k < 3; k++) spawn(D_BOX, rnd(-0.3, 0.3), 0.3, rnd(-0.3, 0.3), rnd(0, 6.28), rnd(0.22, 0.3), rnd(0.18, 0.25), rnd(0.22, 0.3), rnd(0.5, 0.9), rnd(1.5, 3.5) + speed * 0.06, 6, col(0x17191c), rnd(4, 5.5));
        for (let k = 0; k < 10; k++) {
          const s = rnd(0.04, 0.1);
          spawn(D_BOX, rnd(-0.3, 0.3), rnd(0.2, 0.6), rnd(-0.3, 0.3), rnd(0, 6.28), s, s * rnd(0.3, 1), s, rnd(0.4, 0.9), rnd(1.5, 4) + speed * 0.05, 10, col([0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a][k % 4]), rnd(3, 4.5));
        }
        return;
    }
  }

  return {
    group,
    update(dt, time, broken, cars) {
      lensMat.uniforms.time.value = time;
      if (broken && broken.length === props.length) {
        let fresh = 0;
        for (let i = 0; i < props.length; i++) if (!shown[i] && broken[i]) fresh++;
        for (let i = 0; i < props.length; i++) {
          const b = broken[i] ? 1 : 0;
          if (b === shown[i]) continue;
          shown[i] = b;
          const p = props[i];
          setBroken(p, b === 1);
          if (p.kind === 'hydrant') {
            if (broken[i] === 1) spray.start(p.id, p.x, p.y, p.z, time);
            else spray.stop(p.id);
          }
          // A bulk change (e.g. a state jump) just hides; a few fresh hits come apart.
          // 2 = removed for this route (under a barrier/rail): just hidden.
          if (b && broken[i] === 1 && fresh <= 6) {
            let best = 144;
            let vx = 0;
            let vz = 0;
            for (const c of cars) {
              const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
              if (d < best) {
                best = d;
                vx = c.vx;
                vz = c.vz;
              }
            }
            shatter(p, vx, vz);
          }
        }
      }
      debris.update(dt);
      spray.update(time);
    },
    dispose() {
      debris.dispose();
      spray.dispose();
      for (const m of meshes) m.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}

/** Arm and head directions for a traffic light at a corner of its intersection. */
function trafficFrame(world: World, p: Prop): TrafficFrame {
  const g = world.graph;
  const fallback: TrafficFrame = { ax: Math.sin(p.yaw), az: Math.cos(p.yaw), len: 4, fax: Math.cos(p.yaw), faz: -Math.sin(p.yaw), fbx: -Math.cos(p.yaw), fbz: Math.sin(p.yaw) };
  if (p.node === undefined || p.node < 0 || !g.nodes[p.node]) return fallback;
  const n = g.nodes[p.node];
  const ul = Math.hypot(p.x - n.x, p.z - n.z) || 1;
  const ux = (p.x - n.x) / ul;
  const uz = (p.z - n.z) / ul;
  // The two roads bracketing this corner: nearest edge direction on either side of u.
  let bestA = Infinity;
  let bestB = -Infinity;
  let dA: { x: number; z: number } | null = null;
  let dB: { x: number; z: number } | null = null;
  let wA = 13;
  for (const eid of n.edges) {
    const e = g.edges[eid];
    const o = g.nodes[e.a === p.node ? e.b : e.a];
    const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
    const dx = (o.x - n.x) / l;
    const dz = (o.z - n.z) / l;
    const ang = Math.atan2(ux * dz - uz * dx, ux * dx + uz * dz);
    if (ang > 0 && ang < bestA) {
      bestA = ang;
      dA = { x: dx, z: dz };
      wA = e.width;
    }
    if (ang < 0 && ang > bestB) {
      bestB = ang;
      dB = { x: dx, z: dz };
    }
  }
  if (!dA || !dB) return fallback;
  // Arm: from the pole, perpendicular across road A toward its centerline.
  const tx = n.x - p.x;
  const tz = n.z - p.z;
  const along = tx * dA.x + tz * dA.z;
  let ax = tx - dA.x * along;
  let az = tz - dA.z * along;
  const reach = Math.hypot(ax, az) || 1;
  ax /= reach;
  az /= reach;
  const len = Math.max(3, Math.min(9, Math.min(reach, wA / 2 + 1) * 0.95));
  // Heads face traffic approaching the intersection along each road (+d, outward).
  return { ax, az, len, fax: dA.x, faz: dA.z, fbx: dB.x, fbz: dB.z };
}

/** Reference axis angle of a node (its first road) for grouping signal phases. */
function nodeAxis(world: World, node: number): number {
  const n = world.graph.nodes[node];
  const e = world.graph.edges[n.edges[0]];
  if (!e) return 0;
  const o = world.graph.nodes[e.a === node ? e.b : e.a];
  return Math.atan2(o.x - n.x, o.z - n.z);
}

function hash01(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
