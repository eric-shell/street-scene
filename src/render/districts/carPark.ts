/**
 * Car park renderer: the multi-storey garage the shortcut drives through (sim
 * in city/districts/carPark.ts). One concrete structure over the garage's
 * footprint, the whole block: a tall street level podium (lit shopfronts
 * between columns along every street it fronts), the drivable first parking
 * floor at the deck's height, two more parking levels above it and an open
 * roof deck with lamp posts and the stair core's head house, a lit "P" on
 * each of its faces. Every level is open sided, the classic multi-storey
 * look: spandrel bands, columns on the facade's bay grid, stalls with parked
 * cars in rows down the floor, fluorescent strips under every ceiling. The
 * floors are cut out of the footprint's outline cell by cell (any block
 * shape, an L included), so nothing is drawn over the sidewalk.
 *
 * On the drivable floor the fittings are the sim's own (carParkFloor: the
 * stalls, and the parked cars, columns and stair core it makes solid), drawn
 * at every quality; the other levels park right across the racing line too.
 * The exit lane runs between concrete barriers (the chute walls) to a gap in
 * the front spandrel, the kicker in hazard stripes with a row of lamps along
 * the lip; a string of the shortcut bulbs (hot pink and amber, as the alley
 * shortcuts: lights, not signs, tell racers it is a way through) hangs under
 * the ceiling along the racing line. The ramp from the street climbs inside
 * the garage, up through a hole in the drivable floor: solid side walls with
 * the bulbs along them at a car's height, the deck's slab for a ceiling, a
 * pay booth and a raised barrier arm at its apron just inside the portal, or
 * a closed shutter on the route it is not a shortcut of; on the sidewalk the
 * planner's funnel (fences and cones are props) with strings of the bulbs
 * across the mouth and the curb, and one across the lip. Everything drawn
 * where the sim has a wall stands on that wall's line; the rest is out of
 * reach above or behind them.
 *
 * Light: the interior is lit by its own fluorescents, baked per vertex
 * (structureFx's BakedBuilder, emissive): one mesh for every car park in the
 * city; the rest merges into the kit's builders, nothing per frame (the "P"
 * signs are one textured mesh more). From the street the garage reads as lit
 * before a racer turns in: the strips of the levels seen from outside burn
 * brighter than the one the chase camera rides under, a lamp post on every
 * other facade column rims the roof, the pay booth is a lit glass kiosk, and
 * lamp posts beside the apron and a pair of bulkhead lamps under the portal's
 * head light the way in; their pools on the asphalt and the apron's wash are
 * render/street/areaLights.ts (one mesh with the park lamps' pools), none of
 * it a real light. Low quality drops the render only detail (parked cars off
 * the drivable floor, the upper levels' stall lines). The chase camera keeps
 * under the ceilings drawn here (garageSpan, render/camera/ceilings.ts);
 * nothing new hangs below them.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { ROUTE_INDEX, carParkFloor, carParkGeo, carParkHeight, deckEdges, frontU, funnelFlare, rampHalf, rampPoint } from '../../city/districts/carPark';
import type { CarParkGeo, DeckEdgeKind, Stall } from '../../city/districts/carPark';
import { insetRing, intersectConvex, pointInPolygon, polygonArea, subtractConvex, triangulate } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundVertex, orientedBox, stringLights } from './kit';
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
  /** The ramp's walls and bulbs begin this far up the ramp past the apron (m). */
  rampRoofFrom: 1,
} as const;

const LOOK = {
  /** Spandrel band height above each floor (m). */
  band: 1.05,
  /** Facade column spacing (m) and size along the facade (m); they are a wall thick into the building. */
  bay: 8,
  column: 0.6,
  /** Podium: shopfront glass from sill to head above the street (m). */
  sill: 0.55,
  head: 3.45,
  /** Chute (exit lane) barriers stand this high above the deck (m). */
  chuteWall: 1.2,
  /** Strip lights: spacing across the ceiling (m), length of each tube (m). */
  stripStep: 6,
  stripLen: 2.4,
  /** Shortcut bulbs: spacing along the ramp walls and along the racing line under the ceiling (m); their height over the ramp (m). */
  bulbStep: 1.6,
  lineBulbStep: 2.4,
  rampBulbHeight: 1,
  /** The portal's head beam over the ramp's mouth, below the deck slab (m). */
  header: 0.45,
  /** Lamp posts (roof parapet and the apron): height (m); a roof post every this many facade columns. */
  lampHeight: 4.2,
  lampEvery: 2,
  /** The entry's strings of bulbs: post height on the sidewalk (m); the lip's string hangs this far over the kicker (m), under the ceiling. */
  stringPost: 5.4,
  lipString: 1.9,
  /** Pay booth: footprint along and across the ramp (m), its sill (dark base) and head heights (m). */
  booth: [2.4, 2],
  boothSill: 1,
  boothHead: 2.3,
  /** Bulkhead lamps under the portal's head over the ramp's mouth: width, height and depth (m). */
  bulkhead: [0.5, 0.22, 0.2],
  /** The stair core rises this far over the roof (m); its "P" signs' height (m). */
  coreHead: 3,
  sign: 2.2,
  /** Floor grids: cell size of the drivable floor and of the other slabs (m), of the kicker's fine patch (m). */
  floorCell: 3,
  slabCell: 4,
  kickerCell: 0.5,
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
const SIGN_TINT = new THREE.Color(1.6, 1.6, 1.6);
const SHOP_GLASS = [col(0xffd9a0, 0.6), col(0xffe7c4, 0.45), col(0xbfe0ff, 0.42), col(0xffc27a, 0.55)];
const SHORTCUT_BULBS = [col(0xff4fd8, 2.2), col(0xffb35c, 2.3), col(0xff2bd6, 2), col(0xffd08a, 2.1)];
/** The same string under the deck's ceiling, dimmer: the chase camera rides just under it. */
const LINE_BULBS = SHORTCUT_BULBS.map((c) => c.clone().multiplyScalar(0.45));
const CAR_PAINT = [0x8a1c1c, 0x1c3a8a, 0xb0b3b8, 0x202226, 0x6a6e2a, 0xd9d9d9, 0x2a6a5a, 0x7a4a1a].map((c) => col(c, 0.85));

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

/** A vertical quad from a to b between heights y0 and y1, facing (nx, nz): glass, a shutter, a window strip, a sign (uv 0..1). */
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

/** Whether (x, z) is on the ramp's strip (the apron included) within `pad` m of its walls. */
function onRamp(g: CarParkGeo, x: number, z: number, pad: number): boolean {
  const rx = x - g.rcx;
  const rz = z - g.rcz;
  const a = rx * g.rax + rz * g.raz;
  const l = -rx * g.raz + rz * g.rax;
  return a <= g.rend && rx * g.fnx + rz * g.fnz >= 0 && Math.abs(l) <= rampHalf(g, a, l) + pad;
}

/**
 * The garage's mass over (x, z) for the camera (render/camera/ceilings.ts): over
 * the footprint from the drivable floor's ceiling up to the roof's parapet,
 * over the ramp inside it from the deck's slab (its ceiling). False off it.
 */
export function garageSpan(g: CarParkGeo, heightAt: (x: number, z: number) => number, x: number, z: number, span: { bottom: number; top: number }): boolean {
  const { storey, slab } = GARAGE;
  if (x < g.box.minX || x > g.box.maxX || z < g.box.minZ || z > g.box.maxZ || !pointInPolygon(x, z, g.deck)) return false;
  const flat = heightAt(x, z) - carParkHeight(g, x, z).h + g.H;
  span.bottom = onRamp(g, x, z, CFG.wall) ? flat - slab : flat + storey - slab;
  span.top = flat + (GARAGE.levelsAbove + 1) * storey + GARAGE.parapet;
  return true;
}

/** A lamp at the way in: a post standing on the podium's floor, the pay booth (its lamp and glass), a bulkhead under the portal's head. */
export interface CarParkLamp extends Vec2 {
  kind: 'post' | 'booth' | 'bulkhead';
  /** Ramp frame position (m up the axis from the foot center, m to the left of it). */
  a: number;
  l: number;
}

/**
 * The lamps that light the way in from the street, drawn by buildOne and
 * pooled on the asphalt by render/street/areaLights.ts (which also offers them to
 * the car-following light): a post beside each of the apron's flared walls a
 * third of the way in from the building line (outside the drive, on the
 * podium's floor), the pay booth beside the apron's narrow side, and a pair
 * of bulkhead lamps under the portal's head over the ramp's mouth. Render
 * only: nothing here collides, so nothing is ever switched off.
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
  // Just inside the building line (where the apron's foot is cut by it), over each lane of the mouth.
  const an = g.rax * g.fnx + g.raz * g.fnz;
  const ln = -g.raz * g.fnx + g.rax * g.fnz;
  for (const s of [-1, 1]) {
    const l = s * (g.rhw - 0.9);
    const a = -(l * ln) / an + 1.2;
    out.push({ kind: 'bulkhead', ...rampPoint(g, a, l), a, l });
  }
  return out;
}

/** The "P" sign's face: white on garage blue, lit, drawn once for every car park's stair tower. */
function parkSignTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0b2f7a';
  ctx.fillRect(0, 0, S, S);
  ctx.strokeStyle = '#e8f0ff';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, S - 28, S - 28);
  ctx.font = '800 170px "Google Sans Flex", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#9cc4ff';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#f4f8ff';
  ctx.fillText('P', S / 2, S / 2 + 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A facade column's place: on the outline, with the piece's direction and inward normal. */
interface Post {
  p: Vec2;
  dx: number;
  dz: number;
  nx: number;
  nz: number;
  kind: DeckEdgeKind;
  piece: number;
}

function buildOne(kit: DistrictKit, bb: BakedBuilder, signs: GeoBuilder, g: CarParkGeo, open: boolean): void {
  const W = (u: number, v: number): Vec2 => ({ x: g.ox + g.ux * u + g.vx * v, z: g.oz + g.uz * u + g.vz * v });
  const U = (p: Vec2) => (p.x - g.ox) * g.ux + (p.z - g.oz) * g.uz;
  const V = (p: Vec2) => (p.x - g.ox) * g.vx + (p.z - g.oz) * g.vz;
  const ground = (x: number, z: number) => kit.h(x, z) - carParkHeight(g, x, z).h;
  const detail = kit.quality !== 'low';
  const seed = kit.world.areas[g.area].params.seed ?? 1;
  const rng = new Rng((seed >>> 0) || 1);
  const floor = carParkFloor(g, seed);
  const upper = detail ? carParkFloor(g, seed, true) : floor;
  const { storey, slab, levelsAbove } = GARAGE;
  const roofK = levelsAbove + 1;
  const t = CFG.wall;
  const deckY = (p: Vec2) => kit.h(p.x, p.z);
  const groundY = (p: Vec2) => ground(p.x, p.z);
  /** Floor k's height (m): 0 the drivable floor (flat, without its kicker), roofK the roof deck. */
  const levelY = (p: Vec2, k: number) => ground(p.x, p.z) + g.H + k * storey;
  const paint = (c: number) => CAR_PAINT[Math.min(CAR_PAINT.length - 1, Math.floor(c * CAR_PAINT.length))];
  const inward = polygonArea(g.deck) < 0 ? 1 : -1;
  const fMin = Math.min(...g.front.map((f) => f.u));

  // ---------- Floors: the footprint cut into a frame grid, cell by cell, holes for the ramp and the kicker ----------
  const tris = triangulate(g.deck);
  const deckUV = g.deck.map((p) => ({ u: U(p), v: V(p) }));
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const q of deckUV) {
    uMin = Math.min(uMin, q.u);
    uMax = Math.max(uMax, q.u);
    vMin = Math.min(vMin, q.v);
    vMax = Math.max(vMax, q.v);
  }
  /** The ramp's strip and walls as a hole; the kicker's patch (drawn fine) as another. */
  const rampHole = insetRing(g.ramp, -t) ?? g.ramp;
  const kicker = [W(fMin - 1, -g.hc), W(g.kl + 0.5, -g.hc), W(g.kl + 0.5, g.hc), W(fMin - 1, g.hc)];
  /** A cell clipped to the footprint: whole when well inside, else its pieces inside each triangle. */
  const clipToDeck = (cell: Vec2[], u0: number, u1: number, v0: number, v1: number): Vec2[][] => {
    if (cell.every((p) => pointInPolygon(p.x, p.z, g.deck)) && !deckUV.some((q) => q.u > u0 && q.u < u1 && q.v > v0 && q.v < v1)) return [cell];
    const out: Vec2[][] = [];
    for (const tri of tris) {
      const piece = intersectConvex(cell, tri);
      if (piece.length >= 3 && Math.abs(polygonArea(piece)) > 1e-3) out.push(piece);
    }
    return out;
  };
  /**
   * A sheet over the frame box [u0, u1] x [v0, v1] (the whole footprint by default), `cell` m cells
   * clipped to the footprint less the holes, each piece fanned from vertices `vert` makes, facing up or down.
   */
  const sheet = (gb: GeoBuilder, cell: number, holes: Vec2[][], vert: (p: Vec2) => number, up: boolean, box = { u0: uMin, u1: uMax, v0: vMin, v1: vMax }) => {
    const ny = up ? 1 : -1;
    const us = steps(box.u0, box.u1, cell);
    const vs = steps(box.v0, box.v1, cell);
    for (let i = 0; i + 1 < us.length; i++) {
      for (let j = 0; j + 1 < vs.length; j++) {
        const rect = [W(us[i], vs[j]), W(us[i + 1], vs[j]), W(us[i + 1], vs[j + 1]), W(us[i], vs[j + 1])];
        let pieces = clipToDeck(rect, us[i], us[i + 1], vs[j], vs[j + 1]);
        for (const hole of holes) pieces = pieces.flatMap((p) => subtractConvex(p, hole));
        for (const piece of pieces) {
          const ids = piece.map(vert);
          for (let k = 1; k + 1 < ids.length; k++) gb.triFacing(ids[0], ids[k], ids[k + 1], 0, ny, 0);
        }
      }
    }
  };
  const flat = (gb: GeoBuilder, y: (p: Vec2) => number, up: boolean, color: THREE.Color) => (p: Vec2) => gb.vertex(p.x, y(p), p.z, 0, up ? 1 : -1, 0, p.x / 4, p.z / 4, color);
  // The drivable floor on the terrain (its kicker patch fine, in the exit lane's color), a hole where the ramp comes up.
  bb.light = BAKE.floor;
  sheet(bb, LOOK.floorCell, [rampHole, kicker], (p) => groundVertex(kit, bb, p.x, p.z, 0.02, DECK), true);
  sheet(bb, LOOK.kickerCell, [], (p) => groundVertex(kit, bb, p.x, p.z, 0.02, RAMP), true, { u0: fMin - 1, u1: g.kl + 0.5, v0: -g.hc, v1: g.hc });
  // The podium's floor and its ceiling (the deck's slab), both open over the ramp.
  bb.light = BAKE.podium;
  sheet(bb, LOOK.slabCell, [rampHole], flat(bb, (p) => groundY(p) + 0.03, true, INTERIOR), true);
  sheet(bb, LOOK.slabCell, [rampHole], flat(bb, (p) => levelY(p, 0) - slab, false, CONCRETE_DARK), false);
  // Every ceiling over the parking levels, the upper floors, the roof deck.
  for (let k = 0; k <= levelsAbove; k++) {
    bb.light = BAKE.ceiling;
    sheet(bb, LOOK.slabCell, [], flat(bb, (p) => levelY(p, k + 1) - slab, false, CONCRETE_DARK), false);
    if (k === 0) continue;
    bb.light = BAKE.floor;
    sheet(bb, LOOK.slabCell, [], flat(bb, (p) => levelY(p, k) + 0.02, true, DECK), true);
  }
  sheet(kit.solid, LOOK.slabCell, [], flat(kit.solid, (p) => levelY(p, roofK), true, ROOF), true);

  // ---------- Facade: the footprint's outline, piece by piece ----------
  const pieces = deckEdges(g);
  const posts: Post[] = [];
  pieces.forEach((f, pi) => {
    const { a, b } = f;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.1) return;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    const nx = dz * inward;
    const nz = -dx * inward;
    const toward = { x: a.x + nx, z: a.z + nz };
    // Podium: the plinth under the shopfronts and the fascia over them (the lip's face is a wall street
    // cars hit, shuttered; the ramp's mouth is an open portal up to the slab).
    bb.light = BAKE.outer;
    if (f.kind !== 'ramp') {
      wallRun(bb, a, b, toward, t, (p) => groundY(p) - 0.3, (p) => groundY(p) + LOOK.sill, CONCRETE);
      wallRun(bb, a, b, toward, t, (p) => groundY(p) + LOOK.head, (p) => levelY(p, 0) - slab, CONCRETE);
    }
    if (f.kind === 'lip') {
      const a1 = { x: a.x + nx * 0.15, z: a.z + nz * 0.15 };
      const b1 = { x: b.x + nx * 0.15, z: b.z + nz * 0.15 };
      pane(kit.solid, a1, b1, Math.max(groundY(a), groundY(b)) + LOOK.sill, Math.min(groundY(a), groundY(b)) + LOOK.head, -nx, -nz, SHUTTER);
    }
    // Spandrels: the drivable floor's (its parapet; across the lip only the slab's edge, across the
    // ramp's mouth the portal's head beam), the upper levels', the roof parapet.
    bb.light = BAKE.band;
    if (f.kind === 'wall') wallRun(bb, a, b, toward, t, (p) => levelY(p, 0) - slab, (p) => levelY(p, 0) + LOOK.band, CONCRETE);
    else if (f.kind === 'lip') wallRun(bb, a, b, toward, t, (p) => levelY(p, 0) - slab - 0.4, (p) => deckY(p), CONCRETE_DARK);
    else wallRun(bb, a, b, toward, t, (p) => levelY(p, 0) - slab - LOOK.header, (p) => levelY(p, 0) + LOOK.band, CONCRETE);
    for (let k = 1; k <= levelsAbove; k++) wallRun(bb, a, b, toward, t, (p) => levelY(p, k) - slab, (p) => levelY(p, k) + LOOK.band, CONCRETE);
    wallRun(kit.solid, a, b, toward, t, (p) => levelY(p, roofK) - slab, (p) => levelY(p, roofK) + GARAGE.parapet, CONCRETE);
    // Columns every bay, a wall thick into the building: a walled piece's end columns step in off its
    // ends, the lip's opening keeps only its inner ones, the ramp's mouth none (it is a drive).
    if (f.kind === 'ramp') return;
    const n = Math.max(1, Math.round(len / LOOK.bay));
    for (let i = f.kind === 'lip' ? 1 : 0; i <= (f.kind === 'lip' ? n - 1 : n); i++) {
      const s = Math.min(len - LOOK.column / 2, Math.max(LOOK.column / 2, (len * i) / n));
      const p = { x: a.x + dx * s, z: a.z + dz * s };
      if (posts.some((q) => (q.p.x - p.x) ** 2 + (q.p.z - p.z) ** 2 < 1)) continue;
      posts.push({ p, dx, dz, nx, nz, kind: f.kind, piece: pi });
    }
  });
  const h = LOOK.column / 2;
  for (const c of posts) {
    const ax = c.p.x - c.dx * h;
    const az = c.p.z - c.dz * h;
    const box = (y0: number, y1: number, gb: GeoBuilder) => orientedBox(gb, ax, az, ax + c.dx * LOOK.column, az + c.dz * LOOK.column, c.nx * t, c.nz * t, y0, y1, CONCRETE);
    bb.light = BAKE.column;
    if (c.kind === 'lip') {
      box(groundY(c.p) - 0.2, levelY(c.p, 0) - slab - 0.4, bb);
      box(levelY(c.p, 1) - slab, levelY(c.p, roofK), bb);
    } else box(groundY(c.p) - 0.2, levelY(c.p, roofK), bb);
    box(levelY(c.p, roofK), levelY(c.p, roofK) + GARAGE.parapet, kit.solid);
  }
  // Shopfronts between a piece's columns, recessed behind them: lit glass, now and then a shutter down.
  for (let i = 0; i + 1 < posts.length; i++) {
    const p = posts[i];
    const q = posts[i + 1];
    if (p.piece !== q.piece || p.kind !== 'wall') continue;
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
    // A tall stairwell window up the middle of each face, and the lit "P" on the head house.
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
      pane(kit.glow, { x: m.x - ex, z: m.z - ez }, { x: m.x + ex, z: m.z + ez }, groundY(cc) + 1, levelY(cc, roofK) - 0.4, nx * out, nz * out, CORE_GLASS);
      const sx = ((q.x - p.x) / len) * (LOOK.sign / 2);
      const sz = ((q.z - p.z) / len) * (LOOK.sign / 2);
      // Wound so the glyph reads the right way round from outside (a to b runs left to right for the viewer).
      const sa = { x: m.x + sx, z: m.z + sz };
      const sb = { x: m.x - sx, z: m.z - sz };
      const y0 = coreTop - 0.4 - LOOK.sign;
      pane(signs, out * nx * sz - out * nz * sx > 0 ? sa : sb, out * nx * sz - out * nz * sx > 0 ? sb : sa, y0, y0 + LOOK.sign, nx * out, nz * out, SIGN_TINT);
    }
  }
  // Drivable floor: every stall's lines, its parked cars always (they are solid).
  bb.light = BAKE.car;
  for (const s of floor.stalls) {
    for (const [a, b] of stallEdges(s)) deckLine(kit, a, b, 0.1, STRIPE_WHITE);
    if (s.car >= 0) parkedCar(bb, s.x, s.z, s.dx, s.dz, deckY(s), paint(s.car));
  }
  if (detail) {
    // The other levels park right across the racing line: fuller upstairs, a few on the roof.
    for (const [k, share] of [
      [-1, 0.35],
      [1, 0.75],
      [2, 0.65],
      [roofK, 0.25],
    ] as const) {
      for (const s of upper.stalls) {
        const y = k < 0 ? groundY(s) + 0.03 : levelY(s, k);
        if (k > 0) for (const [a, b] of stallEdges(s)) strip(bb, a, b, y + 0.025, 0.1, STRIPE_WHITE, true);
        if (rng.chance(share)) parkedCar(bb, s.x, s.z, s.dx, s.dz, y, CAR_PAINT[rng.int(0, CAR_PAINT.length - 1)]);
      }
    }
  }

  // ---------- Strip lights under every ceiling: the podium's and each parking level's ----------
  const lit = insetRing(g.deck, 2) ?? g.deck;
  for (let v = vMin + LOOK.stripStep / 2; v < vMax; v += LOOK.stripStep) {
    for (let u = uMin + 3; u + LOOK.stripLen < uMax - 2; u += LOOK.stripLen * 2.5) {
      const a = W(u, v);
      const b = W(u + LOOK.stripLen, v);
      if (!pointInPolygon(a.x, a.z, lit) || !pointInPolygon(b.x, b.z, lit)) continue;
      if (core && (pointInPolygon(a.x, a.z, core) || pointInPolygon(b.x, b.z, core))) continue;
      const overRamp = onRamp(g, (a.x + b.x) / 2, (a.z + b.z) / 2, t + 0.5);
      for (let k = overRamp ? 1 : 0; k <= roofK; k++) strip(kit.glow, a, b, levelY(a, k) - slab - 0.04, 0.16, k === 1 ? STRIP : STRIP_OUTER);
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

  // ---------- Lamp posts: inside every other facade column on the roof, the apron's on the podium floor ----------
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
  // Strings of the shortcut bulbs (the planner's hints): across the apron mouth and the curb line on
  // posts, and across the lip opening hung under the drivable floor's ceiling.
  for (const hint of kit.builds[g.area].hints) {
    if (hint.kind !== 'stringLights') continue;
    const [a, b] = hint.points;
    if (hint.values[0] === 1) stringLights(kit, a, b, { ya: deckY(a) + LOOK.lipString, yb: deckY(b) + LOOK.lipString, sag: 0.3 });
    else stringLights(kit, a, b, { post: LOOK.stringPost });
  }

  // ---------- The ramp inside: its surface from the building line and its underside, solid side walls up to the deck ----------
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
    // The underside, a slab below the surface, once the ramp has risen clear of the podium's floor.
    bb.light = BAKE.ceiling;
    const under = rampRows.filter((row) => kit.h(row[2].x, row[2].z) - slab > ground(row[2].x, row[2].z) + 0.3);
    const uids = under.map((row) => row.map((p) => bb.vertex(p.x, kit.h(p.x, p.z) - slab, p.z, 0, -1, 0, p.x / 4, p.z / 4, CONCRETE_DARK)));
    for (let i = 0; i + 1 < uids.length; i++) for (let j = 0; j + 1 < uids[i].length; j++) bb.quadFacing(uids[i][j], uids[i][j + 1], uids[i + 1][j + 1], uids[i + 1][j], 0, -1, 0);
  }
  const r = g.ramp;
  const mid = rampPoint(g, (g.apron1 + g.rend) / 2, 0);
  const away = (p: Vec2) => ({ x: 2 * p.x - mid.x, z: 2 * p.z - mid.z });
  // The apron's flared walls part it from the deck floor beside it: ground to the deck's parapet height.
  bb.light = BAKE.band;
  wallRun(bb, r[0], r[1], away(r[0]), t, (p) => groundY(p) - 0.3, (p) => levelY(p, 0) + LOOK.band, CONCRETE);
  wallRun(bb, r[5], r[4], away(r[5]), t, (p) => groundY(p) - 0.3, (p) => levelY(p, 0) + LOOK.band, CONCRETE);
  for (const s of [-1, 1]) {
    const a = rampPoint(g, g.apron1, s * g.rhw);
    const b = rampPoint(g, g.rend, s * g.rhw);
    const out = rampPoint(g, g.apron1, s * g.rhw * 3);
    // The side walls follow the grade below and the deck's parapet above.
    bb.light = BAKE.band;
    wallRun(bb, a, b, out, t, (p) => deckY(p) - 0.3, (p) => levelY(p, 0) + LOOK.band, CONCRETE, 3);
    // Shortcut bulbs along the wall at a car's height, climbing with the ramp.
    const len = g.rend - g.apron1;
    for (let k = 0, at = GARAGE.rampRoofFrom; at < len; at += LOOK.bulbStep, k++) {
      const inner = rampPoint(g, g.apron1 + at, s * (g.rhw - 0.08));
      const y = kit.h(inner.x, inner.z) + LOOK.rampBulbHeight;
      cylinder(kit.glow, inner.x, inner.z, 0.07, y - 0.12, y, 5, SHORTCUT_BULBS[(k + (s > 0 ? 2 : 0)) % SHORTCUT_BULBS.length]);
    }
  }
  // Bulkhead lamps under the portal's head over each lane of the mouth.
  {
    const [bw, bh, bd] = LOOK.bulkhead;
    for (const l of streetLamps) {
      if (l.kind !== 'bulkhead') continue;
      const a = { x: l.x + g.raz * (bw / 2), z: l.z - g.rax * (bw / 2) };
      const b = { x: l.x - g.raz * (bw / 2), z: l.z + g.rax * (bw / 2) };
      const y1 = levelY(l, 0) - slab - LOOK.header - 0.02;
      orientedBox(kit.glow, a.x, a.z, b.x, b.z, -g.rax * bd, -g.raz * bd, y1 - bh, y1, BULKHEAD);
    }
  }
  // Pay booth beside the apron on its narrow side (beside the apron's narrow flared wall, on the podium's
  // floor): a lit glass kiosk, dark below the sill, glowing above it on every side under a flat roof with
  // a lamp on it, so the way in is marked from down the street. Its barrier arm stands raised (or a
  // shutter is down when closed).
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
    const signs = new GeoBuilder(true);
    for (const a of areas) {
      const g = carParkGeo(a);
      // Open on the route it is a shortcut of, and everywhere in free roam (carParkGates).
      const open = w.openWorld === true || g.owner === ROUTE_INDEX[w.route.kind];
      buildOne(kit, baked, signs, g, open);
    }
    if (!baked.vertexCount) return;
    const mesh = new THREE.Mesh(kit.track(baked.build()), kit.track(bakedMaterial(LAMP)));
    mesh.name = 'carParkInterior';
    kit.group.add(mesh);
    if (signs.vertexCount) {
      const mat = kit.track(new THREE.MeshBasicMaterial({ map: kit.track(parkSignTexture()), vertexColors: true }));
      const sign = new THREE.Mesh(kit.track(signs.build()), mat);
      sign.name = 'carParkSigns';
      kit.group.add(sign);
    }
  },
};
