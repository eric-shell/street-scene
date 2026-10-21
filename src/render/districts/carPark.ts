/**
 * Car park renderer: the multi-storey car park the shortcut climbs (sim in
 * city/districts/carPark.ts). A concrete box of two open storeys under a
 * roof deck: columns on a grid, spandrel bands at every floor (the ground
 * floor's is the kerb wall street cars hit, the roof's the parapet), floor
 * slabs and ceilings with fluorescent strip lights, parked cars on the lower
 * levels. On the roof: bay markings in the pockets either side, the walled
 * launch chute with its funnel, the kicker in hazard stripes with a row of
 * lamps along the lip. The ramp is a solid concrete ramp from the street,
 * its parapets strung with the shortcut bulbs (hot pink and amber, as the
 * alley shortcuts: lights, not signs, tell racers it is a way through), a
 * pay booth and a raised barrier arm at its foot, or a closed shutter on the
 * route it is not a shortcut of. Everything drawn where the sim has a wall
 * (parapets, facades, chute and ramp walls, the face under the lip) stands
 * on that wall's line; the rest is out of reach above or behind them.
 * Everything merges into the district kit's builders: no extra draw calls,
 * nothing per frame. Interior detail (parked cars, the column grid) is off
 * at Low quality.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { ROUTE_INDEX, carParkGeo, carParkHeight, frontU, rampHalf, rampPoint } from '../../city/districts/carPark';
import type { CarParkGeo } from '../../city/districts/carPark';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundVertex, orientedBox } from './kit';

const CFG = CITY.districts.carPark;

const LOOK = {
  /** Slab thickness (m), spandrel band heights above each floor (m), roof parapet height (m). */
  slab: 0.35,
  band: 1.05,
  parapet: 1.1,
  /** Column spacing along the facade and through the interior (m), column half size (m). */
  bay: 8,
  column: 0.3,
  /** Chute walls stand this high above the deck (m). */
  chuteWall: 1.2,
  /** Strip lights: spacing across the ceiling (m), length of each tube (m), brightness. */
  stripStep: 6,
  stripLen: 2.4,
  /** Shortcut bulbs along the ramp parapets: spacing (m). */
  bulbStep: 1.6,
} as const;

const CONCRETE = col(0x6b6d73);
const CONCRETE_DARK = col(0x4a4c52);
const DECK = col(0x55575d);
const RAMP = col(0x5c5e64);
const INTERIOR = col(0x2e3036);
const STRIPE_WHITE = col(0xd9dade, 0.9);
const STRIPE_YELLOW = col(0xf2b81c, 0.9);
const HAZARD_DARK = col(0x15161a);
const STRIP = col(0xe8f0ff, 1.5);
const LIP_LAMP = col(0xffb35c, 2.4);
const SHORTCUT_BULBS = [col(0xff4fd8, 2.2), col(0xffb35c, 2.3), col(0xff2bd6, 2), col(0xffd08a, 2.1)];
const CAR_PAINT = [0x8a1c1c, 0x1c3a8a, 0xb0b3b8, 0x202226, 0x6a6e2a, 0xd9d9d9, 0x2a6a5a, 0x7a4a1a].map((c) => col(c, 0.85));

/** Quad grid over rows of points (all rows the same length), each vertex at height y(p) + lift, facing up or down. */
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
  if (len < 0.05) return;
  let nx = -dz / len;
  let nz = dx / len;
  if ((toward.x - a.x) * nx + (toward.z - a.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  orientedBox(gb, a.x, a.z, b.x, b.z, nx * thick, nz * thick, y0, y1, color);
}

/** A wall along a segment, cut every few meters so its foot and top follow the ground and the deck. */
function wallRun(kit: DistrictKit, a: Vec2, b: Vec2, toward: Vec2, thick: number, y0: (p: Vec2) => number, y1: (p: Vec2) => number, color: THREE.Color, step = 4): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 0; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
    const q = { x: a.x + ((b.x - a.x) * (i + 1)) / n, z: a.z + ((b.z - a.z) * (i + 1)) / n };
    wallSeg(kit.solid, p, q, toward, thick, Math.min(y0(p), y0(q)), Math.max(y1(p), y1(q)), color);
  }
}

/** A flat glow strip (a fluorescent tube) under a ceiling at height y, along a-b. */
function strip(gb: GeoBuilder, a: Vec2, b: Vec2, y: number, w: number, color: THREE.Color): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const nx = (-(b.z - a.z) / len) * (w / 2);
  const nz = ((b.x - a.x) / len) * (w / 2);
  const v = [gb.vertex(a.x + nx, y, a.z + nz, 0, -1, 0, 0, 0, color), gb.vertex(b.x + nx, y, b.z + nz, 0, -1, 0, 1, 0, color), gb.vertex(b.x - nx, y, b.z - nz, 0, -1, 0, 1, 1, color), gb.vertex(a.x - nx, y, a.z - nz, 0, -1, 0, 0, 1, color)];
  gb.quadFacing(v[0], v[1], v[2], v[3], 0, -1, 0);
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

/** A simple parked car: body and cabin boxes, yaw along (dx, dz). */
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

function buildOne(kit: DistrictKit, g: CarParkGeo, open: boolean): void {
  const W = (u: number, v: number): Vec2 => ({ x: g.ox + g.ux * u + g.vx * v, z: g.oz + g.uz * u + g.vz * v });
  const ground = (x: number, z: number) => kit.h(x, z) - carParkHeight(g, x, z).h;
  const detail = kit.quality !== 'low';
  const rng = new Rng(((kit.world.areas[g.area].params.seed ?? 1) >>> 0) || 1);
  const H = g.H;
  const center = W((frontU(g, 0) + g.u1) / 2, (g.v0 + g.v1) / 2);
  const deckY = (p: Vec2) => kit.h(p.x, p.z);
  const groundY = (p: Vec2) => ground(p.x, p.z);

  // ---------- Roof deck: a grid conforming to the front, fine over the kicker ----------
  const vs = steps(g.v0, g.v1, 2, [-g.hc, g.hc, ...g.front.map((q) => q.v)]);
  const us = (v: number) => {
    const u0 = frontU(g, v);
    const fine = Math.abs(v) <= g.hc + 0.01 ? steps(u0, g.kl + 0.5, 0.5) : [u0];
    return [...fine, ...steps(Math.max(u0, fine[fine.length - 1]), g.u1, 3).slice(1)];
  };
  // Columns of the deck grid share their u stations per column; rows are built per v column (a strip grid).
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
    const ida = rowsA.map((p) => groundVertex(kit, kit.ground, p.x, p.z, 0.02, color));
    const idb = rowsB.map((p) => groundVertex(kit, kit.ground, p.x, p.z, 0.02, color));
    for (let i = 0; i + 1 < n; i++) kit.ground.quadFacing(ida[i], ida[i + 1], idb[i + 1], idb[i], 0, 1, 0);
  }

  // ---------- Lower storeys: ground floor and level 1 slabs, ceilings, columns, strip lights, cars ----------
  const cols = steps(g.v0 + 0.5, g.v1 - 0.5, LOOK.bay);
  const rowsU = (v: number) => steps(frontU(g, v) + 0.5, g.u1 - 0.5, LOOK.bay);
  const slabRows: Vec2[][] = steps(g.v0, g.v1, 4).map((v) => steps(0, 1, 0.25).map((t) => W(frontU(g, v) + t * (g.u1 - frontU(g, v)), v)));
  const level1 = (p: Vec2) => ground(p.x, p.z) + H / 2;
  grid(kit.solid, slabRows, (p) => ground(p.x, p.z) + 0.03, INTERIOR);
  grid(kit.solid, slabRows, level1, INTERIOR);
  grid(kit.solid, slabRows, (p) => level1(p) - LOOK.slab, CONCRETE_DARK, true);
  grid(kit.solid, slabRows, (p) => kit.h(p.x, p.z) - LOOK.slab, CONCRETE_DARK, true);
  for (const v of cols) {
    for (const u of rowsU(v)) {
      const p = W(u, v);
      const interior = u > frontU(g, v) + 1 && u < g.u1 - 1 && v > g.v0 + 1 && v < g.v1 - 1;
      if (interior && !detail) continue;
      const c = LOOK.column;
      const a = W(u - c, v - c);
      orientedBox(kit.solid, a.x, a.z, a.x + g.ux * 2 * c, a.z + g.uz * 2 * c, g.vx * 2 * c, g.vz * 2 * c, ground(p.x, p.z) - 0.2, kit.h(p.x, p.z) - LOOK.slab, CONCRETE);
    }
  }
  for (let v = g.v0 + LOOK.stripStep / 2; v < g.v1; v += LOOK.stripStep) {
    for (let u = frontU(g, v) + 3; u + LOOK.stripLen < g.u1 - 2; u += LOOK.stripLen * 2.5) {
      const a = W(u, v);
      const b = W(u + LOOK.stripLen, v);
      strip(kit.glow, a, b, level1(a) - LOOK.slab - 0.04, 0.16, STRIP);
      strip(kit.glow, a, b, kit.h(a.x, a.z) - LOOK.slab - 0.04, 0.16, STRIP);
    }
  }
  if (detail) {
    // Parked cars nose in along the long sides of both lower levels, a gap here and there.
    for (const level of [0, 1]) {
      for (const [v, dir] of [
        [g.v0 + 3.2, 1],
        [g.v1 - 3.2, -1],
      ] as const) {
        for (let u = frontU(g, v) + 2.2; u < g.u1 - 2; u += 2.6) {
          if (!rng.chance(0.7)) continue;
          const p = W(u, v);
          const y = level === 0 ? ground(p.x, p.z) + 0.03 : level1(p);
          parkedCar(kit.solid, p.x, p.z, g.vx * dir, g.vz * dir, y, CAR_PAINT[rng.int(0, CAR_PAINT.length - 1)]);
        }
      }
    }
  }

  // ---------- Facade: spandrel bands at every floor (the ground floor's is the kerb wall), on the parapet line ----------
  const outline: [Vec2, Vec2, boolean][] = [];
  const top = rampPoint(g, g.rend, 0);
  const ur = (top.x - g.ox) * g.ux + (top.z - g.oz) * g.uz;
  const vr = (top.x - g.ox) * g.vx + (top.z - g.oz) * g.vz;
  const lipOpen = (v: number) => Math.abs(v) < g.hc;
  // Front polyline (cut at the lip: no roof parapet there), back, sides (open where the ramp joins).
  const fv = steps(g.v0, g.v1, 50, [-g.hc, g.hc, ...g.front.map((q) => q.v)]);
  for (let i = 0; i + 1 < fv.length; i++) outline.push([W(frontU(g, fv[i]), fv[i]), W(frontU(g, fv[i + 1]), fv[i + 1]), lipOpen((fv[i] + fv[i + 1]) / 2)]);
  const backCuts = g.side === 0 ? [vr - g.rhw, vr + g.rhw] : [];
  const bv = steps(g.v0, g.v1, 50, backCuts);
  for (let i = 0; i + 1 < bv.length; i++) outline.push([W(g.u1, bv[i]), W(g.u1, bv[i + 1]), g.side === 0 && Math.abs((bv[i] + bv[i + 1]) / 2 - vr) < g.rhw]);
  for (const [sv, sgn] of [
    [g.v0, -1],
    [g.v1, 1],
  ] as const) {
    const cuts = g.side === sgn ? [ur - g.rhw, ur + g.rhw] : [];
    const su = steps(frontU(g, sv), g.u1, 50, cuts);
    for (let i = 0; i + 1 < su.length; i++) outline.push([W(su[i], sv), W(su[i + 1], sv), g.side === sgn && Math.abs((su[i] + su[i + 1]) / 2 - ur) < g.rhw]);
  }
  for (const [a, b, gap] of outline) {
    // Ground floor kerb and level 1 band all round; the roof parapet except across the lip and the ramp's mouth.
    wallRun(kit, a, b, center, CFG.wall, (p) => groundY(p) - 0.3, (p) => groundY(p) + LOOK.band, CONCRETE);
    wallRun(kit, a, b, center, CFG.wall, (p) => groundY(p) + H / 2 - LOOK.slab, (p) => groundY(p) + H / 2 + LOOK.band, CONCRETE);
    if (!gap) wallRun(kit, a, b, center, CFG.wall, (p) => deckY(p) - LOOK.slab, (p) => deckY(p) + LOOK.parapet, CONCRETE);
    else wallRun(kit, a, b, center, CFG.wall, (p) => deckY(p) - LOOK.slab - 0.4, (p) => deckY(p), CONCRETE_DARK);
  }

  // ---------- Chute: walls and funnel, the kicker's stripes and the lamps along the lip ----------
  for (const s of [-1, 1]) {
    const a = W(frontU(g, g.hc * s), g.hc * s);
    const b = W(g.lc, g.hc * s);
    const c = W(g.lc + g.cf, (g.hc + g.cw) * s);
    const out = W(g.lc / 2, g.hc * s * 3);
    wallRun(kit, a, b, out, CFG.wall, (p) => deckY(p) - 0.2, (p) => deckY(p) + LOOK.chuteWall, CONCRETE, 2);
    wallRun(kit, b, c, W(g.lc + g.cf / 2, (g.hc + g.cw) * s * 3), CFG.wall, (p) => deckY(p) - 0.2, (p) => deckY(p) + LOOK.chuteWall, CONCRETE, 2);
    // A yellow edge line inside each wall, all the way out to the lip.
    deckLine(kit, W(frontU(g, (g.hc - 0.25) * s) + 0.1, (g.hc - 0.25) * s), W(g.lc + g.cf, (g.hc + g.cw - 0.25) * s), 0.14, STRIPE_YELLOW);
  }
  // Kicker: hazard chevrons across its last meters and a row of amber lamps along the lip.
  for (let u = 0.3; u < 2.6; u += 0.5) deckLine(kit, W(frontU(g, -g.hc) + u, -g.hc + 0.1), W(frontU(g, g.hc) + u, g.hc - 0.1), 0.24, Math.round(u * 2) % 2 ? STRIPE_YELLOW : HAZARD_DARK);
  for (let v = -g.hc + 0.4; v <= g.hc - 0.3; v += 0.6) {
    const p = W(frontU(g, v) + 0.12, v);
    const y = kit.h(p.x, p.z);
    cylinder(kit.glow, p.x, p.z, 0.09, y - 0.05, y + 0.06, 5, LIP_LAMP);
  }

  // ---------- Roof markings: bay lines in the pockets beside the chute and along the back ----------
  for (const s of [-1, 1]) {
    const v0 = s < 0 ? g.v0 + 0.6 : g.hc + 0.8;
    const v1 = s < 0 ? -g.hc - 0.8 : g.v1 - 0.6;
    if (v1 - v0 < 4.8) continue;
    const edge = s < 0 ? v0 + 5 : v1 - 5;
    for (let u = frontU(g, edge) + 1.5; u < g.lc - 1; u += 2.6) deckLine(kit, W(u, s < 0 ? v0 : v1), W(u, edge), 0.1, STRIPE_WHITE);
  }
  for (let v = g.v0 + 1; v < g.v1 - 1; v += 2.6) {
    if ((g.side === 0 && Math.abs(v - vr) < g.rhw + 1) || Math.abs(v) < g.hc + g.cw + 1.5) continue;
    deckLine(kit, W(g.u1 - 0.6, v), W(g.u1 - 5.4, v), 0.1, STRIPE_WHITE);
  }

  // ---------- Ramp: surface from the building line, solid sides with parapets, shortcut bulbs ----------
  const an = g.rax * g.fnx + g.raz * g.fnz;
  const ln = -g.raz * g.fnx + g.rax * g.fnz;
  const footA = (l: number) => -(l * ln) / an;
  const aStations = steps(g.apron0, g.rend, 3, [g.apron1, g.apron1 + CFG.rampEase, g.rend - CFG.rampEase]);
  const lStations = [-1, -0.5, 0, 0.5, 1];
  // The first row runs along the building line itself (the apron's foot is cut by it, at curb height).
  const rampRows = [lStations.map((k) => rampPoint(g, footA(k * (g.rhw + (k < 0 ? g.fl : g.fr))), k * (g.rhw + (k < 0 ? g.fl : g.fr))))].concat(
    aStations.map((a) => lStations.map((k) => rampPoint(g, a, k * rampHalf(g, a, k)))),
  );
  {
    const ids = rampRows.map((row) => row.map((p) => groundVertex(kit, kit.ground, p.x, p.z, 0.02, RAMP)));
    for (let i = 0; i + 1 < ids.length; i++) for (let j = 0; j + 1 < ids[i].length; j++) kit.ground.quadFacing(ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j], 0, 1, 0);
  }
  const r = g.ramp;
  const mid = rampPoint(g, (g.apron1 + g.rend) / 2, 0);
  const away = (p: Vec2) => ({ x: 2 * p.x - mid.x, z: 2 * p.z - mid.z });
  wallRun(kit, r[0], r[1], away(r[0]), CFG.wall, (p) => groundY(p) - 0.3, (p) => deckY(p) + 0.9, CONCRETE);
  wallRun(kit, r[5], r[4], away(r[5]), CFG.wall, (p) => groundY(p) - 0.3, (p) => deckY(p) + 0.9, CONCRETE);
  for (const s of [-1, 1]) {
    const a = rampPoint(g, g.apron1, s * g.rhw);
    const b = rampPoint(g, g.rend, s * g.rhw);
    wallRun(kit, a, b, rampPoint(g, g.apron1, s * g.rhw * 3), CFG.wall, (p) => groundY(p) - 0.3, (p) => deckY(p) + LOOK.parapet, CONCRETE, 3);
    // Shortcut bulbs along the parapet top, and a strip light washing the ramp every few meters.
    const len = g.rend - g.apron1;
    for (let k = 0, at = 0.8; at < len; at += LOOK.bulbStep, k++) {
      const p = rampPoint(g, g.apron1 + at, s * (g.rhw + CFG.wall / 2));
      const inner = rampPoint(g, g.apron1 + at, s * (g.rhw - 0.3));
      const y = kit.h(inner.x, inner.z) + LOOK.parapet + 0.08;
      cylinder(kit.glow, p.x, p.z, 0.07, y - 0.12, y, 5, SHORTCUT_BULBS[(k + (s > 0 ? 2 : 0)) % SHORTCUT_BULBS.length]);
    }
  }
  // Pay booth beside the apron on its narrow side, its barrier arm raised (or a shutter down when closed).
  const narrow = g.fl < g.fr ? -1 : 1;
  const boothAt = rampPoint(g, g.apron1 + 2.5, narrow * (g.rhw + CFG.wall + 1.6));
  const by = ground(boothAt.x, boothAt.z);
  orientedBox(kit.solid, boothAt.x - g.rax * 1.2 + g.raz * 1, boothAt.z - g.raz * 1.2 - g.rax * 1, boothAt.x + g.rax * 1.2 + g.raz * 1, boothAt.z + g.raz * 1.2 - g.rax * 1, -g.raz * 2, g.rax * 2, by, by + 2.5, CONCRETE_DARK);
  strip(kit.glow, rampPoint(g, g.apron1 + 1.6, narrow * (g.rhw + CFG.wall + 0.55)), rampPoint(g, g.apron1 + 3.4, narrow * (g.rhw + CFG.wall + 0.55)), by + 2.6, 0.3, col(0xffd9a0, 1.6));
  const armBase = rampPoint(g, g.apron1 - 0.3, narrow * (g.rhw + 0.1));
  const ay = kit.h(armBase.x, armBase.z);
  for (let k = 0; k < 6; k++) cylinder(kit.solid, armBase.x, armBase.z, 0.06, ay + 1 + k * 0.6, ay + 1.6 + k * 0.6, 4, k % 2 ? col(0xd92b2b) : col(0xeeeeee), false);
  if (!open) {
    // Closed: a roller shutter across the ramp where the sim's gate stands.
    const a = rampPoint(g, g.apron1 - 0.4, -g.rhw - CFG.wall);
    const b = rampPoint(g, g.apron1 - 0.4, g.rhw + CFG.wall);
    wallRun(kit, a, b, rampPoint(g, g.apron1 + 2, 0), CFG.wall, (p) => deckY(p) - 0.2, (p) => deckY(p) + 3, col(0x8a8d94), 2);
  }
}

export const carParkRenderer: DistrictRenderer = {
  kinds: ['carPark'],
  build(kit, areas) {
    const w = kit.world;
    for (const a of areas) {
      const g = carParkGeo(a);
      // Open on the route it is a shortcut of, and everywhere in free roam (carParkGates).
      const open = w.openWorld === true || g.owner === ROUTE_INDEX[w.route.kind];
      buildOne(kit, g, open);
    }
  },
};
