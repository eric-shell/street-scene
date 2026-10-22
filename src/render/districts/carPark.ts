/**
 * Car park renderer: the multi-storey garage the shortcut drives through (sim
 * in city/districts/carPark.ts). One rectangular concrete box over the deck's
 * footprint: a tall street level podium (lit shopfronts along the front, open
 * bays round the other sides), the drivable first parking floor at the deck's
 * height, two more parking levels above it and an open roof deck with lamp
 * posts and the stair core's head house. Every level is open sided, the
 * classic multi-storey look: spandrel bands, columns on the facade's bay
 * grid, stalls with parked cars, fluorescent strips under every ceiling.
 *
 * On the drivable floor the fittings are the sim's own (carParkFloor: the
 * stalls, and the parked cars, columns and stair core it makes solid), drawn
 * at every quality. The exit lane runs between concrete barriers (the chute
 * walls) to a gap in the front spandrel, the kicker in hazard stripes with a
 * row of lamps along the lip; a string of the shortcut bulbs (hot pink and
 * amber, as the alley shortcuts: lights, not signs, tell racers it is a way
 * through) hangs under the ceiling along the racing line. The ramp from the
 * street is the garage's covered access ramp: solid side walls with the bulbs
 * along their tops, columns, a roof slab following its grade with strip
 * lights under it, a pay booth and a raised barrier arm at its open apron,
 * or a closed shutter on the route it is not a shortcut of. Everything drawn
 * where the sim has a wall stands on that wall's line; the rest is out of
 * reach above or behind them.
 *
 * Light: the interior is lit by its own fluorescents, baked per vertex
 * (structureFx's BakedBuilder, emissive): one mesh for every car park in the
 * city; the rest merges into the kit's builders, nothing per frame. From the
 * street the garage reads as lit before a racer turns in: the strips of the
 * levels seen from outside burn brighter than the one the chase camera rides
 * under, a lamp post on every facade column rims the roof, the pay booth is
 * a lit glass kiosk, and lamp posts behind the apron's flared walls and a
 * pair of bulkhead lamps on the portal beam light the way in; their pools on
 * the asphalt and the apron's wash are render/street/areaLights.ts (one mesh with
 * the park lamps' pools), none of it a real light. Low quality drops the
 * render only detail (parked cars off the drivable floor, the upper levels'
 * stall lines). The chase camera keeps under the ceilings drawn here
 * (garageSpan, render/camera/ceilings.ts); nothing new hangs below them.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { ROUTE_INDEX, carParkFloor, carParkGeo, carParkHeight, frontU, funnelFlare, rampHalf, rampPoint } from '../../city/districts/carPark';
import type { CarParkGeo, Stall } from '../../city/districts/carPark';
import { pointInPolygon } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundVertex, orientedBox } from './kit';
import { BakedBuilder, bakedMaterial } from './structureFx';

const CFG = CITY.districts.carPark;

/** The garage's storeys, shared with the camera's ceiling clamp (garageSpan). */
export const GARAGE = {
  /** Floor to floor above the drivable floor and slab thickness (m): 2.85 m clear over the deck. */
  storey: 3.2,
  slab: 0.35,
  /** Parking levels drawn above the drivable floor; the roof deck tops the last of them. */
  levelsAbove: 2,
  /** Roof parapet height (m). */
  parapet: 1.1,
  /** The ramp's roof starts this far up the ramp past the apron (m). */
  rampRoofFrom: 1,
} as const;

const LOOK = {
  /** Spandrel band height above each floor (m). */
  band: 1.05,
  /** Facade column spacing (m) and size along the facade (m); they are a wall thick into the building. */
  bay: 8,
  column: 0.6,
  /** Podium: shopfront glass from sill to head above the street (m), the open bays' head height (m). */
  sill: 0.55,
  head: 3.45,
  openHead: 3.3,
  /** Chute (exit lane) barriers stand this high above the deck (m). */
  chuteWall: 1.2,
  /** Strip lights: spacing across the ceiling (m), length of each tube (m). */
  stripStep: 6,
  stripLen: 2.4,
  /** Shortcut bulbs: spacing along the ramp walls and along the racing line under the ceiling (m). */
  bulbStep: 1.6,
  lineBulbStep: 2.4,
  /** Columns along the ramp's walls (m), the portal beam's depth below the ramp roof (m). */
  rampColumns: 6,
  header: 0.45,
  /** Lamp posts (roof parapet and the apron): height (m); a roof post every this many facade columns. */
  lampHeight: 4.2,
  lampEvery: 1,
  /** Pay booth: footprint along and across the ramp (m), its sill (dark base) and head heights (m). */
  booth: [2.4, 2],
  boothSill: 1,
  boothHead: 2.3,
  /** Bulkhead lamps on the portal beam over the ramp's mouth: width, height and depth (m). */
  bulkhead: [0.5, 0.22, 0.2],
  /** The stair core rises this far over the roof (m). */
  coreHead: 3,
} as const;

/** Baked light level (0..1) of each surface: the fluorescents' light, added as emissive. */
const BAKE = { floor: 0.32, ceiling: 0.55, column: 0.24, band: 0.2, outer: 0.08, podium: 0.24, ramp: 0.3, car: 0.3 } as const;

/** The fluorescents' color (the baked light's lamp). */
const LAMP = col(0xd6e8ff, 0.85);
const CONCRETE = col(0x6b6d73);
const CONCRETE_DARK = col(0x4a4c52);
const DECK = col(0x55575d);
const RAMP = col(0x5c5e64);
const ROOF = col(0x4f5157);
const INTERIOR = col(0x2e3036);
const SHUTTER = col(0x3b3d42);
const STRIPE_WHITE = col(0xd9dade, 0.9);
const STRIPE_YELLOW = col(0xf2b81c, 0.9);
const HAZARD_DARK = col(0x15161a);
/** Strip lights under the drivable floor's ceiling: bright enough to read as tubes, no brighter (the chase camera rides just under them). */
const STRIP = col(0xe8f0ff, 1.05);
/** The strips of the other levels, seen from the street through the open sides: these sell the garage as lit. */
const STRIP_OUTER = col(0xe8f0ff, 1.9);
const LIP_LAMP = col(0xffb35c, 2.4);
const ROOF_LAMP = col(0xffe2b0, 2);
/** The booth's glass: lit from inside, dim enough that bloom leaves it a kiosk and not a lightbox. */
const BOOTH_GLASS = col(0xffd9a0, 0.5);
const BULKHEAD = col(0xffe2b0, 2.6);
const CORE_GLASS = col(0xbfe0ff, 0.55);
const SHOP_GLASS = [col(0xffd9a0, 0.6), col(0xffe7c4, 0.45), col(0xbfe0ff, 0.42), col(0xffc27a, 0.55)];
const SHORTCUT_BULBS = [col(0xff4fd8, 2.2), col(0xffb35c, 2.3), col(0xff2bd6, 2), col(0xffd08a, 2.1)];
/** The same string under the deck's ceiling, dimmer: the chase camera rides just under it. */
const LINE_BULBS = SHORTCUT_BULBS.map((c) => c.clone().multiplyScalar(0.45));
const CAR_PAINT = [0x8a1c1c, 0x1c3a8a, 0xb0b3b8, 0x202226, 0x6a6e2a, 0xd9d9d9, 0x2a6a5a, 0x7a4a1a].map((c) => col(c, 0.85));

/** Quad grid over rows of points (all rows the same length), each vertex at height y(p), facing up or down. */
function grid(gb: GeoBuilder, rows: Vec2[][], y: (p: Vec2) => number, color: THREE.Color, down = false): void {
  const ids = rows.map((row) => row.map((p) => gb.vertex(p.x, y(p), p.z, 0, down ? -1 : 1, 0, p.x / 4, p.z / 4, color)));
  for (let i = 0; i + 1 < ids.length; i++) {
    for (let j = 0; j + 1 < ids[i].length; j++) gb.quadFacing(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j], 0, down ? -1 : 1, 0);
  }
}

/** Steps from a to b, every `step` m at most (ends included), and any extra cut points between. */
function steps(a: number, b: number, step: number, cuts: number[] = []): number[] {
  const n = Math.max(1, Math.ceil(Math.abs(b - a) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(a + ((b - a) * i) / n);
  for (const c of cuts) if (c > Math.min(a, b) + 0.05 && c < Math.max(a, b) - 0.05) out.push(c);
  return out.sort((x, y) => (a < b ? x - y : y - x));
}

/** A vertical box along segment a-b, `thick` deep toward `toward`, from y0 to y1 (absolute). */
function wallSeg(gb: GeoBuilder, a: Vec2, b: Vec2, toward: Vec2, thick: number, y0: number, y1: number, color: THREE.Color): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.05 || y1 <= y0) return;
  let nx = -dz / len;
  let nz = dx / len;
  if ((toward.x - a.x) * nx + (toward.z - a.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  orientedBox(gb, a.x, a.z, b.x, b.z, nx * thick, nz * thick, y0, y1, color);
}

/** A wall along a segment, cut every few meters so its foot and top follow the ground and the floors. */
function wallRun(gb: GeoBuilder, a: Vec2, b: Vec2, toward: Vec2, thick: number, y0: (p: Vec2) => number, y1: (p: Vec2) => number, color: THREE.Color, step = 4): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 0; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
    const q = { x: a.x + ((b.x - a.x) * (i + 1)) / n, z: a.z + ((b.z - a.z) * (i + 1)) / n };
    wallSeg(gb, p, q, toward, thick, Math.min(y0(p), y0(q)), Math.max(y1(p), y1(q)), color);
  }
}

/** A flat horizontal strip at height y along a-b, facing down (a fluorescent tube) or up (a floor line). */
function strip(gb: GeoBuilder, a: Vec2, b: Vec2, y: number, w: number, color: THREE.Color, up = false): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = (-(b.z - a.z) / len) * (w / 2);
  const nz = ((b.x - a.x) / len) * (w / 2);
  const ny = up ? 1 : -1;
  const v = [gb.vertex(a.x + nx, y, a.z + nz, 0, ny, 0, 0, 0, color), gb.vertex(b.x + nx, y, b.z + nz, 0, ny, 0, 1, 0, color), gb.vertex(b.x - nx, y, b.z - nz, 0, ny, 0, 1, 1, color), gb.vertex(a.x - nx, y, a.z - nz, 0, ny, 0, 0, 1, color)];
  gb.quadFacing(v[0], v[1], v[2], v[3], 0, ny, 0);
}

/** A vertical quad from a to b between heights y0 and y1, facing (nx, nz): glass, a shutter, a window strip. */
function pane(gb: GeoBuilder, a: Vec2, b: Vec2, y0: number, y1: number, nx: number, nz: number, color: THREE.Color): void {
  const v = [gb.vertex(a.x, y0, a.z, nx, 0, nz, 0, 0, color), gb.vertex(b.x, y0, b.z, nx, 0, nz, 1, 0, color), gb.vertex(b.x, y1, b.z, nx, 0, nz, 1, 1, color), gb.vertex(a.x, y1, a.z, nx, 0, nz, 0, 1, color)];
  gb.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
}

/** A paint line on the deck (just above it, following its height). */
function deckLine(kit: DistrictKit, a: Vec2, b: Vec2, width: number, color: THREE.Color): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 0.05) return;
  const n = Math.max(1, Math.ceil(len / 2));
  const nx = (-(b.z - a.z) / len) * (width / 2);
  const nz = ((b.x - a.x) / len) * (width / 2);
  let prev: number[] | null = null;
  for (let i = 0; i <= n; i++) {
    const x = a.x + ((b.x - a.x) * i) / n;
    const z = a.z + ((b.z - a.z) * i) / n;
    const row = [groundVertex(kit, kit.paint, x + nx, z + nz, 0.03, color), groundVertex(kit, kit.paint, x - nx, z - nz, 0.03, color)];
    if (prev) kit.paint.quadFacing(prev[0], prev[1], row[1], row[0], 0, 1, 0);
    prev = row;
  }
}

/** A simple parked car: body and cabin boxes, yaw along (dx, dz); the body is the sim's PARKED_CAR box. */
function parkedCar(gb: GeoBuilder, x: number, z: number, dx: number, dz: number, y: number, color: THREE.Color): void {
  const l = Math.hypot(dx, dz) || 1;
  const ux = dx / l;
  const uz = dz / l;
  const vx = -uz;
  const vz = ux;
  const body = (len: number, wid: number, y0: number, y1: number, c: THREE.Color, off = 0) => {
    const ax = x + ux * (off - len / 2) - vx * (wid / 2);
    const az = z + uz * (off - len / 2) - vz * (wid / 2);
    orientedBox(gb, ax, az, ax + ux * len, az + uz * len, vx * wid, vz * wid, y0, y1, c);
  };
  body(4.3, 1.8, y + 0.25, y + 0.85, color);
  body(2.3, 1.6, y + 0.85, y + 1.35, color.clone().multiplyScalar(0.55), -0.2);
}

/** The two long edges of a stall (aisle end to nose end), for its paint lines. */
function stallEdges(s: Stall): [Vec2, Vec2][] {
  const [P, D] = CFG.stall;
  const lx = -s.dz;
  const lz = s.dx;
  return [-1, 1].map((k) => {
    const ox = s.x + lx * k * (P / 2);
    const oz = s.z + lz * k * (P / 2);
    return [
      { x: ox - s.dx * (D / 2 - 0.2), z: oz - s.dz * (D / 2 - 0.2) },
      { x: ox + s.dx * (D / 2 - 0.35), z: oz + s.dz * (D / 2 - 0.35) },
    ];
  });
}

/**
 * The garage's mass over (x, z) for the camera (render/camera/ceilings.ts): over
 * the deck's footprint from the drivable floor's ceiling up to the roof's
 * parapet, over the covered ramp its roof slab. False off both.
 */
export function garageSpan(g: CarParkGeo, heightAt: (x: number, z: number) => number, x: number, z: number, span: { bottom: number; top: number }): boolean {
  const { storey, slab } = GARAGE;
  const u = (x - g.ox) * g.ux + (z - g.oz) * g.uz;
  const v = (x - g.ox) * g.vx + (z - g.oz) * g.vz;
  if (v >= g.v0 && v <= g.v1 && u <= g.u1 && u >= frontU(g, v)) {
    const flat = heightAt(x, z) - carParkHeight(g, x, z).h + g.H;
    span.bottom = flat + storey - slab;
    span.top = flat + (GARAGE.levelsAbove + 1) * storey + GARAGE.parapet;
    return true;
  }
  const rx = x - g.rcx;
  const rz = z - g.rcz;
  const a = rx * g.rax + rz * g.raz;
  const l = -rx * g.raz + rz * g.rax;
  if (a < g.apron1 + GARAGE.rampRoofFrom || a > g.rend || Math.abs(l) > g.rhw + CFG.wall) return false;
  const c = rampPoint(g, a, 0);
  span.bottom = heightAt(c.x, c.z) + storey - slab;
  span.top = span.bottom + slab + 0.3;
  return true;
}

/** A lamp outside the garage: a post standing on the ground, the pay booth (its lamp and glass), a bulkhead on the portal beam. */
export interface CarParkLamp extends Vec2 {
  kind: 'post' | 'booth' | 'bulkhead';
  /** Ramp frame position (m up the axis from the foot center, m to the left of it). */
  a: number;
  l: number;
}

/**
 * The lamps that light the way in from the street, drawn by buildOne and
 * pooled on the asphalt by render/street/areaLights.ts (which also offers them to
 * the car-following light): a post behind each of the apron's flared walls a
 * third of the way in from the building line (outside the drive, in the
 * plot the buildings keep off), the pay booth beside the apron's narrow
 * side, and a pair of bulkhead lamps on the portal beam over the ramp's
 * mouth. Render only: nothing here collides, so nothing is ever switched off.
 */
export function carParkStreetLamps(g: CarParkGeo): CarParkLamp[] {
  const t = CFG.wall;
  const out: CarParkLamp[] = [];
  const r = g.ramp;
  const apronMid = rampPoint(g, (g.apron0 + g.apron1) / 2, 0);
  const frame = (p: Vec2) => ({ a: (p.x - g.rcx) * g.rax + (p.z - g.rcz) * g.raz, l: -(p.x - g.rcx) * g.raz + (p.z - g.rcz) * g.rax });
  for (const [a, b] of [
    [r[0], r[1]],
    [r[5], r[4]],
  ] as const) {
    const m = { x: a.x + (b.x - a.x) * 0.35, z: a.z + (b.z - a.z) * 0.35 };
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    let nx = -(b.z - a.z) / len;
    let nz = (b.x - a.x) / len;
    if ((apronMid.x - m.x) * nx + (apronMid.z - m.z) * nz > 0) {
      nx = -nx;
      nz = -nz;
    }
    const p = { x: m.x + nx * (t / 2 + 0.8), z: m.z + nz * (t / 2 + 0.8) };
    out.push({ kind: 'post', ...p, ...frame(p) });
  }
  const narrow = g.fl < g.fr ? -1 : 1;
  const boothA = g.apron1 - 3;
  const boothL = narrow * (rampHalf(g, boothA, narrow) + t + 1.1);
  out.push({ kind: 'booth', ...rampPoint(g, boothA, boothL), a: boothA, l: boothL });
  const roofA = g.apron1 + GARAGE.rampRoofFrom;
  for (const s of [-1, 1]) {
    const l = s * (g.rhw - 0.9);
    out.push({ kind: 'bulkhead', ...rampPoint(g, roofA, l), a: roofA, l });
  }
  return out;
}

/** A facade segment of the deck's outline: on the front (the street the lip faces), open on the drivable floor (lip, ramp mouth). */
interface Face {
  a: Vec2;
  b: Vec2;
  front: boolean;
  gap: boolean;
}

function buildOne(kit: DistrictKit, bb: BakedBuilder, g: CarParkGeo, open: boolean): void {
  const W = (u: number, v: number): Vec2 => ({ x: g.ox + g.ux * u + g.vx * v, z: g.oz + g.uz * u + g.vz * v });
  const ground = (x: number, z: number) => kit.h(x, z) - carParkHeight(g, x, z).h;
  const detail = kit.quality !== 'low';
  const seed = kit.world.areas[g.area].params.seed ?? 1;
  const rng = new Rng((seed >>> 0) || 1);
  const floor = carParkFloor(g, seed);
  const { storey, slab, levelsAbove } = GARAGE;
  const roofK = levelsAbove + 1;
  const center = W((frontU(g, 0) + g.u1) / 2, (g.v0 + g.v1) / 2);
  const deckY = (p: Vec2) => kit.h(p.x, p.z);
  const groundY = (p: Vec2) => ground(p.x, p.z);
  /** Floor k's height (m): 0 the drivable floor (flat, without its kicker), roofK the roof deck. */
  const levelY = (p: Vec2, k: number) => ground(p.x, p.z) + g.H + k * storey;
  const paint = (c: number) => CAR_PAINT[Math.min(CAR_PAINT.length - 1, Math.floor(c * CAR_PAINT.length))];

  // ---------- Drivable floor: a grid conforming to the front, fine over the kicker ----------
  bb.light = BAKE.floor;
  const vs = steps(g.v0, g.v1, 2, [-g.hc, g.hc, ...g.front.map((q) => q.v)]);
  const us = (v: number) => {
    const u0 = frontU(g, v);
    const fine = Math.abs(v) <= g.hc + 0.01 ? steps(u0, g.kl + 0.5, 0.5) : [u0];
    return [...fine, ...steps(Math.max(u0, fine[fine.length - 1]), g.u1, 3).slice(1)];
  };
  for (let j = 0; j + 1 < vs.length; j++) {
    const va = vs[j];
    const vb = vs[j + 1];
    const ua = us((va + vb) / 2 < 0 ? va : vb);
    const n = ua.length;
    const fa = frontU(g, va);
    const fb = frontU(g, vb);
    const rowsA: Vec2[] = [];
    const rowsB: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const t = (ua[i] - ua[0]) / (ua[n - 1] - ua[0] || 1);
      rowsA.push(W(fa + t * (g.u1 - fa), va));
      rowsB.push(W(fb + t * (g.u1 - fb), vb));
    }
    const color = Math.abs((va + vb) / 2) < g.hc ? RAMP : DECK;
    const ida = rowsA.map((p) => groundVertex(kit, bb, p.x, p.z, 0.02, color));
    const idb = rowsB.map((p) => groundVertex(kit, bb, p.x, p.z, 0.02, color));
    for (let i = 0; i + 1 < n; i++) bb.quadFacing(ida[i], ida[i + 1], idb[i + 1], idb[i], 0, 1, 0);
  }

  // ---------- Slabs: the podium's floor, every ceiling, the upper floors, the roof deck ----------
  const fMin = Math.min(...g.front.map((f) => f.u));
  const nU = Math.max(2, Math.ceil((g.u1 - fMin) / 6));
  const slabRows = steps(g.v0, g.v1, 4, g.front.map((q) => q.v)).map((v) => {
    const f = frontU(g, v);
    return Array.from({ length: nU + 1 }, (_, i) => W(f + ((g.u1 - f) * i) / nU, v));
  });
  bb.light = BAKE.podium;
  grid(bb, slabRows, (p) => groundY(p) + 0.03, INTERIOR);
  grid(bb, slabRows, (p) => levelY(p, 0) - slab, CONCRETE_DARK, true);
  for (let k = 0; k <= levelsAbove; k++) {
    bb.light = BAKE.ceiling;
    grid(bb, slabRows, (p) => levelY(p, k + 1) - slab, CONCRETE_DARK, true);
    if (k === 0) continue;
    bb.light = BAKE.floor;
    grid(bb, slabRows, (p) => levelY(p, k) + 0.02, DECK);
  }
  grid(kit.solid, slabRows, (p) => levelY(p, roofK), ROOF);

  // ---------- Facade: the deck's outline, front polyline first ----------
  const faces: Face[] = [];
  const top = rampPoint(g, g.rend, 0);
  const ur = (top.x - g.ox) * g.ux + (top.z - g.oz) * g.uz;
  const vr = (top.x - g.ox) * g.vx + (top.z - g.oz) * g.vz;
  const fv = steps(g.v0, g.v1, 50, [-g.hc, g.hc, ...g.front.map((q) => q.v)]);
  for (let i = 0; i + 1 < fv.length; i++) faces.push({ a: W(frontU(g, fv[i]), fv[i]), b: W(frontU(g, fv[i + 1]), fv[i + 1]), front: true, gap: Math.abs((fv[i] + fv[i + 1]) / 2) < g.hc });
  const bv = steps(g.v0, g.v1, 50, g.side === 0 ? [vr - g.rhw, vr + g.rhw] : []);
  for (let i = 0; i + 1 < bv.length; i++) faces.push({ a: W(g.u1, bv[i]), b: W(g.u1, bv[i + 1]), front: false, gap: g.side === 0 && Math.abs((bv[i] + bv[i + 1]) / 2 - vr) < g.rhw });
  for (const [sv, sgn] of [
    [g.v0, -1],
    [g.v1, 1],
  ] as const) {
    const su = steps(frontU(g, sv), g.u1, 50, g.side === sgn ? [ur - g.rhw, ur + g.rhw] : []);
    for (let i = 0; i + 1 < su.length; i++) faces.push({ a: W(su[i], sv), b: W(su[i + 1], sv), front: false, gap: g.side === sgn && Math.abs((su[i] + su[i + 1]) / 2 - ur) < g.rhw });
  }
  const t = CFG.wall;
  for (const f of faces) {
    const { a, b } = f;
    // Podium: a plinth under the shopfronts or the kerb wall street cars hit, a deep fascia over them.
    bb.light = BAKE.outer;
    wallRun(bb, a, b, center, t, (p) => groundY(p) - 0.3, (p) => groundY(p) + (f.front ? LOOK.sill : LOOK.band), CONCRETE);
    wallRun(bb, a, b, center, t, (p) => groundY(p) + (f.front ? LOOK.head : LOOK.openHead), (p) => levelY(p, 0) - slab, CONCRETE);
    // Spandrels: the drivable floor's (its parapet; across the lip and the ramp's mouth only the slab edge), the upper levels'.
    bb.light = BAKE.band;
    if (!f.gap) wallRun(bb, a, b, center, t, (p) => levelY(p, 0) - slab, (p) => levelY(p, 0) + LOOK.band, CONCRETE);
    else wallRun(bb, a, b, center, t, (p) => levelY(p, 0) - slab - 0.4, (p) => deckY(p), CONCRETE_DARK);
    for (let k = 1; k <= levelsAbove; k++) wallRun(bb, a, b, center, t, (p) => levelY(p, k) - slab, (p) => levelY(p, k) + LOOK.band, CONCRETE);
    wallRun(kit.solid, a, b, center, t, (p) => levelY(p, roofK) - slab, (p) => levelY(p, roofK) + GARAGE.parapet, CONCRETE);
  }

  // ---------- Facade columns every bay, a wall thick into the building; none across an opening of the drivable floor ----------
  const posts: { p: Vec2; dx: number; dz: number; nx: number; nz: number; gap: boolean; front: boolean }[] = [];
  for (const f of faces) {
    const len = Math.hypot(f.b.x - f.a.x, f.b.z - f.a.z);
    if (len < 0.1) continue;
    const dx = (f.b.x - f.a.x) / len;
    const dz = (f.b.z - f.a.z) / len;
    let nx = -dz;
    let nz = dx;
    if ((center.x - f.a.x) * nx + (center.z - f.a.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const n = Math.max(1, Math.round(len / LOOK.bay));
    // A walled face's end columns step in off its ends (never into an opening); an opening keeps only its inner ones.
    for (let i = f.gap ? 1 : 0; i <= (f.gap ? n - 1 : n); i++) {
      const s = Math.min(len - LOOK.column / 2, Math.max(LOOK.column / 2, (len * i) / n));
      const p = { x: f.a.x + dx * s, z: f.a.z + dz * s };
      if (posts.some((q) => (q.p.x - p.x) ** 2 + (q.p.z - p.z) ** 2 < 1)) continue;
      posts.push({ p, dx, dz, nx, nz, gap: f.gap, front: f.front });
    }
  }
  const h = LOOK.column / 2;
  for (const c of posts) {
    const ax = c.p.x - c.dx * h;
    const az = c.p.z - c.dz * h;
    const box = (y0: number, y1: number, gb: GeoBuilder) => orientedBox(gb, ax, az, ax + c.dx * LOOK.column, az + c.dz * LOOK.column, c.nx * t, c.nz * t, y0, y1, CONCRETE);
    bb.light = BAKE.column;
    if (c.gap) {
      box(groundY(c.p) - 0.2, levelY(c.p, 0) - slab - 0.4, bb);
      box(levelY(c.p, 1) - slab, levelY(c.p, roofK), bb);
    } else box(groundY(c.p) - 0.2, levelY(c.p, roofK), bb);
    box(levelY(c.p, roofK), levelY(c.p, roofK) + GARAGE.parapet, kit.solid);
  }
  // Shopfronts between the front's columns, recessed behind them: lit glass, now and then a shutter down.
  const shops = posts.filter((c) => c.front);
  for (let i = 0; i + 1 < shops.length; i++) {
    const p = shops[i];
    const q = shops[i + 1];
    if (Math.hypot(q.p.x - p.p.x, q.p.z - p.p.z) > LOOK.bay * 1.6) continue;
    const a = { x: p.p.x + p.dx * h + p.nx * 0.15, z: p.p.z + p.dz * h + p.nz * 0.15 };
    const b = { x: q.p.x - q.dx * h + q.nx * 0.15, z: q.p.z - q.dz * h + q.nz * 0.15 };
    const y0 = Math.max(groundY(a), groundY(b)) + LOOK.sill;
    const y1 = Math.min(groundY(a), groundY(b)) + LOOK.head;
    if (rng.chance(0.2)) pane(kit.solid, a, b, y0, y1, -p.nx, -p.nz, SHUTTER);
    else pane(kit.glow, a, b, y0, y1, -p.nx, -p.nz, SHOP_GLASS[rng.int(0, SHOP_GLASS.length - 1)]);
  }

  // ---------- The sim's fittings: columns and the stair core through every level, stalls and cars ----------
  bb.light = BAKE.column;
  for (const c of floor.columns) {
    const a = { x: c.x - (g.ux + g.vx) * h, z: c.z - (g.uz + g.vz) * h };
    orientedBox(bb, a.x, a.z, a.x + g.ux * LOOK.column, a.z + g.uz * LOOK.column, g.vx * LOOK.column, g.vz * LOOK.column, groundY(c) - 0.2, levelY(c, roofK) - slab, CONCRETE);
  }
  const core = floor.core;
  if (core) {
    const cc = { x: (core[0].x + core[2].x) / 2, z: (core[0].z + core[2].z) / 2 };
    const coreTop = levelY(cc, roofK) + LOOK.coreHead;
    orientedBox(bb, core[0].x, core[0].z, core[1].x, core[1].z, core[3].x - core[0].x, core[3].z - core[0].z, groundY(cc) - 0.2, coreTop, CONCRETE);
    // A tall stairwell window up the middle of each face, and a lit door onto the roof.
    for (let i = 0; i < 4; i++) {
      const p = core[i];
      const q = core[(i + 1) % 4];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const nx = (q.z - p.z) / len;
      const nz = -(q.x - p.x) / len;
      const out = (cc.x - p.x) * nx + (cc.z - p.z) * nz > 0 ? -1 : 1;
      const m = { x: (p.x + q.x) / 2 + nx * out * 0.03, z: (p.z + q.z) / 2 + nz * out * 0.03 };
      const ex = ((q.x - p.x) / len) * 0.4;
      const ez = ((q.z - p.z) / len) * 0.4;
      pane(kit.glow, { x: m.x - ex, z: m.z - ez }, { x: m.x + ex, z: m.z + ez }, groundY(cc) + 1, coreTop - 0.6, nx * out, nz * out, CORE_GLASS);
    }
  }
  // Drivable floor: every stall's lines, its parked cars always (they are solid).
  bb.light = BAKE.car;
  for (const s of floor.stalls) {
    for (const [a, b] of stallEdges(s)) deckLine(kit, a, b, 0.1, STRIPE_WHITE);
    if (s.car >= 0) parkedCar(bb, s.x, s.z, s.dx, s.dz, deckY(s), paint(s.car));
  }
  if (detail) {
    // The same stalls on the other levels, fuller upstairs; a double row down the middle of the upper levels.
    const lx = g.vx * (CFG.stall[1] / 2);
    const lz = g.vz * (CFG.stall[1] / 2);
    const middle: Stall[] = [];
    for (let u = fMin + CFG.stall[1] + 2; u < g.lc - 2; u += CFG.stall[0]) {
      const p = W(u, 0);
      middle.push({ x: p.x + lx, z: p.z + lz, dx: -g.vx, dz: -g.vz, car: 0 }, { x: p.x - lx, z: p.z - lz, dx: g.vx, dz: g.vz, car: 0 });
    }
    for (const [k, share] of [
      [-1, 0.35],
      [1, 0.75],
      [2, 0.65],
      [roofK, 0.25],
    ] as const) {
      for (const s of k > 0 && k < roofK ? [...floor.stalls, ...middle] : floor.stalls) {
        const y = k < 0 ? groundY(s) + 0.03 : levelY(s, k);
        if (k > 0) for (const [a, b] of stallEdges(s)) strip(bb, a, b, y + 0.025, 0.1, STRIPE_WHITE, true);
        if (rng.chance(share)) parkedCar(bb, s.x, s.z, s.dx, s.dz, y, CAR_PAINT[rng.int(0, CAR_PAINT.length - 1)]);
      }
    }
  }

  // ---------- Strip lights under every ceiling: the podium's and each parking level's ----------
  for (let v = g.v0 + LOOK.stripStep / 2; v < g.v1; v += LOOK.stripStep) {
    for (let u = frontU(g, v) + 3; u + LOOK.stripLen < g.u1 - 2; u += LOOK.stripLen * 2.5) {
      const a = W(u, v);
      const b = W(u + LOOK.stripLen, v);
      if (core && (pointInPolygon(a.x, a.z, core) || pointInPolygon(b.x, b.z, core))) continue;
      for (let k = 0; k <= roofK; k++) strip(kit.glow, a, b, levelY(a, k) - slab - 0.04, 0.16, k === 1 ? STRIP : STRIP_OUTER);
    }
  }
  // The shortcut bulbs strung under the drivable floor's ceiling along the racing line, ramp top to lip.
  {
    const path = g.path.slice(1);
    let k = 0;
    let carry = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      for (let s = carry; s < len; s += LOOK.lineBulbStep, k++) {
        const p = { x: a.x + ((b.x - a.x) * s) / len, z: a.z + ((b.z - a.z) * s) / len };
        const y = levelY(p, 1) - slab;
        cylinder(kit.glow, p.x, p.z, 0.06, y - 0.12, y - 0.02, 5, LINE_BULBS[k % LINE_BULBS.length]);
        carry = s + LOOK.lineBulbStep - len;
      }
    }
  }

  // ---------- Exit lane: barriers and funnel, the kicker's stripes and the lamps along the lip ----------
  bb.light = BAKE.band;
  for (const s of [-1, 1]) {
    const cw = funnelFlare(g, s);
    const a = W(frontU(g, g.hc * s), g.hc * s);
    const b = W(g.lc, g.hc * s);
    const c = W(g.lc + g.cf, (g.hc + cw) * s);
    wallRun(bb, a, b, W(g.lc / 2, g.hc * s * 3), t, (p) => deckY(p) - 0.2, (p) => deckY(p) + LOOK.chuteWall, CONCRETE, 2);
    wallRun(bb, b, c, W(g.lc + g.cf / 2, (g.hc + cw) * s * 3), t, (p) => deckY(p) - 0.2, (p) => deckY(p) + LOOK.chuteWall, CONCRETE, 2);
    // A yellow edge line inside each barrier, all the way out to the lip.
    deckLine(kit, W(frontU(g, (g.hc - 0.25) * s) + 0.1, (g.hc - 0.25) * s), W(g.lc, (g.hc - 0.25) * s), 0.14, STRIPE_YELLOW);
    deckLine(kit, W(g.lc, (g.hc - 0.25) * s), W(g.lc + g.cf, (g.hc + cw - 0.25) * s), 0.14, STRIPE_YELLOW);
  }
  for (let u = 0.3; u < 2.6; u += 0.5) deckLine(kit, W(frontU(g, -g.hc) + u, -g.hc + 0.1), W(frontU(g, g.hc) + u, g.hc - 0.1), 0.24, Math.round(u * 2) % 2 ? STRIPE_YELLOW : HAZARD_DARK);
  for (let v = -g.hc + 0.4; v <= g.hc - 0.3; v += 0.6) {
    const p = W(frontU(g, v) + 0.12, v);
    const y = kit.h(p.x, p.z);
    cylinder(kit.glow, p.x, p.z, 0.09, y - 0.05, y + 0.06, 5, LIP_LAMP);
  }

  // ---------- Lamp posts: one inside every facade column on the roof, the apron's at the street ----------
  const lampPost = (x: number, z: number, y: number) => {
    cylinder(kit.solid, x, z, 0.08, y, y + LOOK.lampHeight, 5, CONCRETE_DARK, false);
    cylinder(kit.glow, x, z, 0.2, y + LOOK.lampHeight - 0.25, y + LOOK.lampHeight, 6, ROOF_LAMP);
  };
  posts.forEach((c, i) => {
    if (i % LOOK.lampEvery !== 0) return;
    const p = { x: c.p.x + c.nx * 0.9, z: c.p.z + c.nz * 0.9 };
    lampPost(p.x, p.z, levelY(p, roofK));
  });
  const streetLamps = carParkStreetLamps(g);
  for (const l of streetLamps) if (l.kind === 'post') lampPost(l.x, l.z, ground(l.x, l.z));

  // ---------- Covered ramp: surface from the building line, solid side walls, columns, a roof following the grade ----------
  const an = g.rax * g.fnx + g.raz * g.fnz;
  const ln = -g.raz * g.fnx + g.rax * g.fnz;
  const footA = (l: number) => -(l * ln) / an;
  const aStations = steps(g.apron0, g.rend, 3, [g.apron1, g.apron1 + CFG.rampEase, g.rend - CFG.rampEase]);
  const lStations = [-1, -0.5, 0, 0.5, 1];
  // The first row runs along the building line itself (the apron's foot is cut by it, at curb height).
  const rampRows = [lStations.map((k) => rampPoint(g, footA(k * (g.rhw + (k < 0 ? g.fl : g.fr))), k * (g.rhw + (k < 0 ? g.fl : g.fr))))].concat(
    aStations.map((a) => lStations.map((k) => rampPoint(g, a, k * rampHalf(g, a, k)))),
  );
  bb.light = BAKE.ramp;
  {
    const ids = rampRows.map((row) => row.map((p) => groundVertex(kit, bb, p.x, p.z, 0.02, RAMP)));
    for (let i = 0; i + 1 < ids.length; i++) for (let j = 0; j + 1 < ids[i].length; j++) bb.quadFacing(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j], 0, 1, 0);
  }
  const r = g.ramp;
  const mid = rampPoint(g, (g.apron1 + g.rend) / 2, 0);
  const away = (p: Vec2) => ({ x: 2 * p.x - mid.x, z: 2 * p.z - mid.z });
  bb.light = BAKE.band;
  wallRun(bb, r[0], r[1], away(r[0]), t, (p) => groundY(p) - 0.3, (p) => deckY(p) + 0.9, CONCRETE);
  wallRun(bb, r[5], r[4], away(r[5]), t, (p) => groundY(p) - 0.3, (p) => deckY(p) + 0.9, CONCRETE);
  const roofA = g.apron1 + GARAGE.rampRoofFrom;
  const rampY = (a: number) => {
    const c = rampPoint(g, a, 0);
    return kit.h(c.x, c.z);
  };
  for (const s of [-1, 1]) {
    const a = rampPoint(g, g.apron1, s * g.rhw);
    const b = rampPoint(g, g.rend, s * g.rhw);
    const out = rampPoint(g, g.apron1, s * g.rhw * 3);
    bb.light = BAKE.band;
    wallRun(bb, a, b, out, t, (p) => groundY(p) - 0.3, (p) => deckY(p) + LOOK.band, CONCRETE, 3);
    // Columns standing on the wall up to the roof, every few meters from the portal to the garage.
    bb.light = BAKE.column;
    for (let at = roofA; at < g.rend - 1; at += LOOK.rampColumns) {
      const p = rampPoint(g, at, s * g.rhw);
      const q = rampPoint(g, at + 0.5, s * g.rhw);
      wallSeg(bb, p, q, out, t, rampY(at) + LOOK.band - 0.05, Math.min(rampY(at), rampY(at + 0.5)) + storey - slab, CONCRETE);
    }
    // Shortcut bulbs along the wall top.
    const len = g.rend - g.apron1;
    for (let k = 0, at = 0.8; at < len; at += LOOK.bulbStep, k++) {
      const p = rampPoint(g, g.apron1 + at, s * (g.rhw + t / 2));
      const inner = rampPoint(g, g.apron1 + at, s * (g.rhw - 0.3));
      const y = kit.h(inner.x, inner.z) + LOOK.band + 0.08;
      cylinder(kit.glow, p.x, p.z, 0.07, y - 0.12, y, 5, SHORTCUT_BULBS[(k + (s > 0 ? 2 : 0)) % SHORTCUT_BULBS.length]);
    }
  }
  {
    // The roof slab: top and ceiling across the walls, flat across at the centerline's height plus a storey.
    const as = steps(roofA, g.rend, 3, [g.apron1 + CFG.rampEase, g.rend - CFG.rampEase]);
    const half = g.rhw + t;
    const rows = as.map((a) => lStations.map((k) => rampPoint(g, a, k * half)));
    const ys = as.map((a) => rampY(a) + storey);
    const sheet = (gb: GeoBuilder, dy: number, color: THREE.Color, down: boolean) => {
      const ids = rows.map((row, i) => row.map((p) => gb.vertex(p.x, ys[i] + dy, p.z, 0, down ? -1 : 1, 0, p.x / 4, p.z / 4, color)));
      for (let i = 0; i + 1 < ids.length; i++) for (let j = 0; j + 1 < ids[i].length; j++) gb.quadFacing(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j], 0, down ? -1 : 1, 0);
    };
    sheet(kit.solid, 0, ROOF, false);
    bb.light = BAKE.ceiling;
    sheet(bb, -slab, CONCRETE_DARK, true);
    // The slab's edges along both walls, the portal beam over the way in.
    bb.light = BAKE.band;
    for (const s of [-1, 1]) {
      for (let i = 0; i + 1 < as.length; i++) {
        const p = rampPoint(g, as[i], s * half);
        const q = rampPoint(g, as[i + 1], s * half);
        wallSeg(bb, p, q, mid, t, Math.min(ys[i], ys[i + 1]) - slab - 0.3, Math.max(ys[i], ys[i + 1]), CONCRETE);
      }
    }
    wallSeg(bb, rampPoint(g, roofA, -half), rampPoint(g, roofA, half), rampPoint(g, roofA + 2, 0), 0.4, ys[0] - slab - LOOK.header, ys[0], CONCRETE);
    // Bulkhead lamps on the beam's street face, over each lane of the mouth.
    const [bw, bh, bd] = LOOK.bulkhead;
    for (const l of streetLamps) {
      if (l.kind !== 'bulkhead') continue;
      const a = { x: l.x + g.raz * (bw / 2), z: l.z - g.rax * (bw / 2) };
      const b = { x: l.x - g.raz * (bw / 2), z: l.z + g.rax * (bw / 2) };
      const y1 = ys[0] - slab - LOOK.header / 2 + bh / 2;
      orientedBox(kit.glow, a.x, a.z, b.x, b.z, -g.rax * bd, -g.raz * bd, y1 - bh, y1, BULKHEAD);
    }
    // Strip lights across the ceiling.
    for (let at = roofA + 2; at < g.rend - 1; at += 4.5) {
      const y = rampY(at) + storey - slab - 0.04;
      strip(kit.glow, rampPoint(g, at, -LOOK.stripLen / 2), rampPoint(g, at, LOOK.stripLen / 2), y, 0.16, STRIP);
    }
  }
  // Pay booth beside the apron on its narrow side (behind the apron's narrow flared wall, inside the
  // plot the buildings keep off): a lit glass kiosk, dark below the sill, glowing above it on every side
  // under a flat roof with a lamp on it, so the way in is marked from down the street. Its barrier arm
  // stands raised (or a shutter is down when closed).
  const narrow = g.fl < g.fr ? -1 : 1;
  const booth = streetLamps.find((l) => l.kind === 'booth')!;
  const by = ground(booth.x, booth.z);
  {
    const [bl, bwid] = LOOK.booth;
    // A box in the ramp frame: from a0 to a1 along the axis, l0 to l1 across, y0 to y1.
    const box = (gb: GeoBuilder, a0: number, a1: number, l0: number, l1: number, y0: number, y1: number, color: THREE.Color) => {
      const p = rampPoint(g, a0, l0);
      const q = rampPoint(g, a1, l0);
      orientedBox(gb, p.x, p.z, q.x, q.z, -g.raz * (l1 - l0), g.rax * (l1 - l0), y0, y1, color);
    };
    const [a0, a1] = [booth.a - bl / 2, booth.a + bl / 2];
    const [l0, l1] = [booth.l - bwid / 2, booth.l + bwid / 2];
    box(kit.solid, a0, a1, l0, l1, by, by + LOOK.boothSill, CONCRETE_DARK);
    // The glass band sits a hair inside the base's and the roof's edges, a dark transom bar across it.
    box(kit.glow, a0 + 0.03, a1 - 0.03, l0 + 0.03, l1 - 0.03, by + LOOK.boothSill, by + LOOK.boothHead, BOOTH_GLASS);
    box(kit.solid, a0, a1, l0, l1, by + LOOK.boothSill + 0.55, by + LOOK.boothSill + 0.62, CONCRETE_DARK);
    box(kit.solid, a0 - 0.1, a1 + 0.1, l0 - 0.1, l1 + 0.1, by + LOOK.boothHead, by + LOOK.boothHead + 0.2, CONCRETE_DARK);
    // Its lamp: a short post on the roof's corner nearest the apron and the street.
    const lp = rampPoint(g, a0 + 0.25, booth.l - narrow * (bwid / 2 - 0.25));
    cylinder(kit.solid, lp.x, lp.z, 0.05, by + LOOK.boothHead + 0.2, by + LOOK.boothHead + 1.1, 5, CONCRETE_DARK, false);
    cylinder(kit.glow, lp.x, lp.z, 0.16, by + LOOK.boothHead + 0.9, by + LOOK.boothHead + 1.1, 6, ROOF_LAMP);
  }
  const armBase = rampPoint(g, g.apron1 - 0.3, narrow * (g.rhw + 0.1));
  const ay = kit.h(armBase.x, armBase.z);
  for (let k = 0; k < 6; k++) cylinder(kit.solid, armBase.x, armBase.z, 0.06, ay + 1 + k * 0.6, ay + 1.6 + k * 0.6, 4, k % 2 ? col(0xd92b2b) : col(0xeeeeee), false);
  if (!open) {
    // Closed: a roller shutter across the ramp where the sim's gate stands.
    const a = rampPoint(g, g.apron1 - 0.4, -g.rhw - t);
    const b = rampPoint(g, g.apron1 - 0.4, g.rhw + t);
    wallRun(kit.solid, a, b, rampPoint(g, g.apron1 + 2, 0), t, (p) => deckY(p) - 0.2, (p) => deckY(p) + 3, col(0x8a8d94), 2);
  }
}

export const carParkRenderer: DistrictRenderer = {
  kinds: ['carPark'],
  build(kit, areas) {
    const w = kit.world;
    const baked = new BakedBuilder();
    for (const a of areas) {
      const g = carParkGeo(a);
      // Open on the route it is a shortcut of, and everywhere in free roam (carParkGates).
      const open = w.openWorld === true || g.owner === ROUTE_INDEX[w.route.kind];
      buildOne(kit, baked, g, open);
    }
    if (!baked.vertexCount) return;
    const mesh = new THREE.Mesh(kit.track(baked.build()), kit.track(bakedMaterial(LAMP)));
    mesh.name = 'carParkInterior';
    kit.group.add(mesh);
  },
};
