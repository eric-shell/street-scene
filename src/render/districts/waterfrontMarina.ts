/**
 * The marina variant of the waterfront (city/districts/waterfront.ts marinaDocks), drawn from the area's
 * hints and props so the harbor renderer (waterfront.ts, which calls this once and shares the sea wall,
 * railing, water, breakwater and buoys) keeps one look per wall:
 *  - floating pontoons on guide piles, a gangway down from the quay, finger berths either side, dock lights;
 *  - moored sailboats (mast, furled sail, masthead light) and motor yachts (flybridge, lit saloon), hulls in a
 *    few colours, each a couple of hundred triangles, drawn into a `BoatFleet` (boats.ts) that rocks them on the swell;
 *  - the fuel dock (canopy, pumps, a lit sign), the yacht club on a deck over the water (lit windows, a terrace
 *    with tables and string lights, a flag) and the dinghies pulled up on its deck or tied off afloat;
 *  - the boardwalk, planking laid over the quay's edge (concrete underneath: it drives like the sidewalk it
 *    is, so this is paint, not a surface), and string lights on posts along the railing.
 * Everything out on the water stands behind the railing's closed gates; the boardwalk and the strings' posts
 * stand on the railing's line or inside the quay's own paving, and the bollards and lanterns on it are the
 * build's destructible props. Imports nothing from waterfront.ts: its helpers come in as `MarinaTools`.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area, AreaBuild, AreaHint, AreaProp } from '../../city/districts/types';
import { coastNormal, coastV, framePoint, frameU, harborFrame, waterLevel } from '../../city/districts/waterfrontShape';
import type { Vec2 } from '../../sim/math';
import type { GeoBuilder } from '../geoBuilder';
import type { DistrictKit } from './kit';
import { BoatFleet, mooringPhase } from './boats';
import { col, cylinder, groundLine, stringLights } from './kit';

const CFG = CITY.districts.waterfront;

/** The harbor renderer's primitives this module draws with (waterfront.ts owns them). */
export interface MarinaTools {
  boxAt(gb: GeoBuilder, x: number, y0: number, z: number, fx: number, fz: number, hl: number, hw: number, h: number, c: THREE.Color): void;
  solidBox(gb: GeoBuilder, a: Vec2, b: Vec2, ox: number, oz: number, y0: number, y1: number, c: THREE.Color): void;
  beam(gb: GeoBuilder, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, c: THREE.Color): void;
  lamp(gb: GeoBuilder, x: number, y: number, z: number, s: number, c: THREE.Color): void;
  /** A light out on the water for its reflection streak (colour, streak width in m). */
  light(x: number, y: number, z: number, c: THREE.Color, w: number): void;
  /** The quay's top (m) at u along the coast. */
  quayTop(u: number): number;
}

const M = {
  floatBody: col(0x34383c),
  decking: col(0x8a6e4c),
  deckingDark: col(0x6e5638),
  pile: col(0x2a2826),
  hullHigh: [0xe8e8e2, 0xe8e8e2, 0x1c2a4a, 0xd4c8a8, 0x15161a, 0x1f6f78, 0x8a2a24, 0x80848a].map((c) => col(c)),
  boot: col(0x16181c),
  white: col(0xe4e4dc),
  cabin: col(0xc9c6bc),
  spar: col(0xb8bcc2),
  stay: col(0x2a2c30),
  glass: col(0xffd890, 1.5),
  glassDim: col(0x20262c),
  masthead: col(0xffffff, 1.8),
  navRed: col(0xff2a1a, 2),
  navGreen: col(0x2aff6a, 2),
  dock: col(0xffd8a0, 1.5),
  fuelRed: col(0xb02a22),
  fuelSign: col(0x3ad6e8, 1.9),
  clubWall: col(0xcfc8b8),
  clubRoof: col(0x2c4a5a),
  trim: col(0x4a4038),
  tableTop: col(0xe8e4d8),
  candle: col(0xffb24a, 1.6),
  flag: col(0xb02a22),
  boardA: col(0x7a5c3a),
  boardB: col(0x6a4e30),
  boardC: col(0x86683f),
  dinghy: [col(0xd8d4c8), col(0x2f6aa8), col(0xc89a2a), col(0xb8402e)],
} as const;

/** A cheap stable hash of a prop's position, for its colour and which lights are on. */
const hash = (x: number, z: number): number => Math.abs(Math.round(x * 31 + z * 17)) >>> 0;

/** Everything of a marina, once per area. */
export function drawMarina(kit: DistrictKit, a: Area, b: AreaBuild, t: MarinaTools, low: boolean): void {
  boardwalk(kit, a);
  stringsAlongRail(kit, a, b, low);
  for (const h of b.hints) {
    if (h.kind === 'pontoon') pontoon(kit, a, h, t);
    else if (h.kind === 'fuel') fuelDock(kit, a, h, t);
    else if (h.kind === 'clubhouse') clubhouse(kit, a, h, t);
  }
  // The boats afloat go into their own fleet, which rocks on the swell (boats.ts); the dinghies on the club's deck stay in the kit.
  const fleet = new BoatFleet();
  for (const pr of b.props) {
    if (pr.kind === 'sailboat') sailboat(fleet, a, pr, t);
    else if (pr.kind === 'yacht') yacht(fleet, a, pr, t);
    else if (pr.kind === 'dinghy') dinghy(kit, fleet, a, pr, t);
  }
  fleet.mount(kit, 'marinaBoats');
}

/** Planking along the quay's edge inside the railing: three bands of boards, in a darker and a lighter wood. */
function boardwalk(kit: DistrictKit, a: Area): void {
  const p = a.params;
  const f = harborFrame(a);
  const w = CFG.boardwalk;
  const lift = CITY.curbHeight + 0.014;
  const band = w / 3;
  for (let u = p.pa; u < p.pb - 1e-6; u += 4) {
    const u1 = Math.min(p.pb, u + 4);
    const tone = [Math.floor(u / 4) % 2 ? M.boardA : M.boardB, M.boardC, Math.floor(u / 4) % 3 ? M.boardB : M.boardA];
    for (let k = 0; k < 3; k++) {
      const v0 = -CFG.boardwalkInset - band * (k + 0.5);
      groundLine(kit, kit.paint, framePoint(f, u, coastV(p, u) + v0), framePoint(f, u1, coastV(p, u1) + v0), band - 0.04, lift, tone[k]);
    }
  }
}

/** String lights from post to post along the railing's line (the posts stand on the rail), skipping the gates' gaps. */
function stringsAlongRail(kit: DistrictKit, a: Area, b: AreaBuild, low: boolean): void {
  const p = a.params;
  const f = harborFrame(a);
  const gates = b.hints.filter((h) => h.kind === 'pontoon' || h.kind === 'fuel' || h.kind === 'clubhouse').map((h) => ({ u: frameU(f, h.points[0].x, h.points[0].z), w: h.values[0] }));
  const post = 3.3;
  const us: number[] = [];
  for (let u = p.pa + CFG.stringStep / 2; u < p.pb - 4; u += CFG.stringStep) if (!gates.some((g) => Math.abs(g.u - u) < g.w / 2 + 1.2)) us.push(u);
  for (let i = 0; i + 1 < us.length; i++) {
    const span = us[i + 1] - us[i];
    const q0 = framePoint(f, us[i], coastV(p, us[i]) - CFG.railInset);
    const q1 = framePoint(f, us[i + 1], coastV(p, us[i + 1]) - CFG.railInset);
    stringLights(kit, q0, q1, { post, sag: Math.min(1.4, span * 0.04), step: low ? 4 : 3.4 });
  }
}

/** Waterline of a point (m): the sea at its u. */
function sea(a: Area, x: number, z: number): number {
  return waterLevel(a.params, frameU(harborFrame(a), x, z));
}

/** A pontoon (hint: root, tip; values gate width, spine width, slip length, slip pitch): gangway, floating spine, fingers, piles, lights. */
function pontoon(kit: DistrictKit, a: Area, h: AreaHint, t: MarinaTools): void {
  const [r, tip] = h.points;
  const [, spineW, slipLen, pitch] = h.values;
  const len = Math.hypot(tip.x - r.x, tip.z - r.z);
  const fx = (tip.x - r.x) / len;
  const fz = (tip.z - r.z) / len;
  const rx = fz;
  const rz = -fx;
  const u = frameU(harborFrame(a), r.x, r.z);
  const W = waterLevel(a.params, u);
  const top = W + 0.45;
  const start = 5.5;
  const at = (s: number, o: number): Vec2 => ({ x: r.x + fx * s + rx * o, z: r.z + fz * s + rz * o });
  // The gangway: a sloped plank from the quay's top down to the float, with a handrail either side.
  const quayY = t.quayTop(u);
  const gw = 0.9;
  const gv = [at(-0.4, -gw), at(-0.4, gw), at(start, gw), at(start, -gw)];
  const gy = [quayY, quayY, top, top];
  const ids = gv.map((q, i) => kit.solid.vertex(q.x, gy[i], q.z, 0, 1, 0, 0, 0, M.deckingDark));
  kit.solid.quadFacing(ids[0], ids[3], ids[2], ids[1], 0, 1, 0);
  for (const o of [-gw, gw]) {
    const q0 = at(-0.4, o);
    const q1 = at(start, o);
    t.beam(kit.solid, q0.x, quayY + 0.95, q0.z, q1.x, top + 0.95, q1.z, 0.03, M.spar);
  }
  // The float: a dark body with decking on top.
  const mid = at((start + len) / 2, 0);
  t.boxAt(kit.solid, mid.x, W - 0.15, mid.z, fx, fz, (len - start) / 2, spineW / 2, 0.45, M.floatBody);
  t.boxAt(kit.solid, mid.x, W + 0.3, mid.z, fx, fz, (len - start) / 2 - 0.05, spineW / 2 - 0.05, 0.15, M.decking);
  // Fingers either side at every slip boundary, and a guide pile at the tip of every other one.
  const slips = Math.floor((len - 7) / pitch);
  const fl = slipLen - 1.5;
  for (let k = 0; k <= slips; k++) {
    const s = 7 + k * pitch;
    for (const side of [-1, 1]) {
      const c = at(s, side * (spineW / 2 + fl / 2));
      t.boxAt(kit.solid, c.x, W - 0.05, c.z, rx, rz, fl / 2, 0.33, 0.4, M.decking);
      if ((k + (side > 0 ? 1 : 0)) % 2 === 0) {
        const q = at(s, side * (spineW / 2 + fl + 0.2));
        cylinder(kit.solid, q.x, q.z, 0.17, W - 3, W + 1.6, 6, M.pile, false);
      }
    }
  }
  // Dock lights: a low post every 11 m on alternating sides, and the spine's end.
  for (let s = 9, i = 0; s < len; s += 11, i++) {
    const q = at(s, (i % 2 ? 1 : -1) * (spineW / 2 - 0.25));
    cylinder(kit.solid, q.x, q.z, 0.05, top, top + 0.85, 4, M.stay, false);
    t.lamp(kit.glow, q.x, top + 0.92, q.z, 0.2, M.dock);
    if (i % 2 === 0) t.light(q.x, top + 0.92, q.z, M.dock.clone().multiplyScalar(0.18), 0.9);
  }
}

/** The fuel dock (hint: root, tip): a short float with two pumps, a canopy on posts and a lit sign. */
function fuelDock(kit: DistrictKit, a: Area, h: AreaHint, t: MarinaTools): void {
  const [r, tip] = h.points;
  const len = Math.hypot(tip.x - r.x, tip.z - r.z);
  const fx = (tip.x - r.x) / len;
  const fz = (tip.z - r.z) / len;
  const rx = fz;
  const rz = -fx;
  const u = frameU(harborFrame(a), r.x, r.z);
  const W = waterLevel(a.params, u);
  const top = W + 0.45;
  const at = (s: number, o: number): Vec2 => ({ x: r.x + fx * s + rx * o, z: r.z + fz * s + rz * o });
  const quayY = t.quayTop(u);
  const gv = [at(-0.4, -1), at(-0.4, 1), at(5, 1), at(5, -1)];
  const gy = [quayY, quayY, top, top];
  const ids = gv.map((q, i) => kit.solid.vertex(q.x, gy[i], q.z, 0, 1, 0, 0, 0, M.deckingDark));
  kit.solid.quadFacing(ids[0], ids[3], ids[2], ids[1], 0, 1, 0);
  const mid = at((5 + len) / 2, 0);
  t.boxAt(kit.solid, mid.x, W - 0.15, mid.z, fx, fz, (len - 5) / 2, 1.9, 0.45, M.floatBody);
  t.boxAt(kit.solid, mid.x, W + 0.3, mid.z, fx, fz, (len - 5) / 2 - 0.05, 1.85, 0.15, M.decking);
  // Pumps at the far end and the canopy over them.
  const px = len - 5;
  for (const o of [-0.9, 0.9]) {
    const q = at(px, o);
    t.boxAt(kit.solid, q.x, top, q.z, fx, fz, 0.3, 0.25, 1.3, M.fuelRed);
    t.lamp(kit.glow, q.x - rx * Math.sign(o) * 0, top + 1.0, q.z, 0.2, M.glass);
  }
  const roofY = top + 3.2;
  const c = at(px, 0);
  for (const [s, o] of [[-2.2, -1.5], [-2.2, 1.5], [2.2, -1.5], [2.2, 1.5]]) {
    const q = at(px + s, o);
    cylinder(kit.solid, q.x, q.z, 0.07, top, roofY, 5, M.spar, false);
  }
  t.boxAt(kit.solid, c.x, roofY, c.z, fx, fz, 2.8, 2.1, 0.22, M.fuelRed);
  const sign = at(px + 2.9, 0);
  t.lamp(kit.glow, sign.x, roofY + 0.12, sign.z, 0.4, M.fuelSign);
  t.solidBox(kit.glow, at(px - 2.7, -1.8), at(px - 2.7, 1.8), fx * 0.05, fz * 0.05, roofY - 0.1, roofY + 0.08, M.fuelSign);
  t.light(c.x, roofY, c.z, M.fuelSign.clone().multiplyScalar(0.2), 3);
}

/** The yacht club (hint: root; values gate width, width, depth): a deck on piles, the clubhouse at the quay's side, the terrace out to sea. */
function clubhouse(kit: DistrictKit, a: Area, h: AreaHint, t: MarinaTools): void {
  const r = h.points[0];
  const [, cw, cd] = h.values;
  const u = frameU(harborFrame(a), r.x, r.z);
  const n = coastNormal(a.params, u);
  const fx = n.nx;
  const fz = n.nz;
  const rx = fz;
  const rz = -fx;
  const W = waterLevel(a.params, u);
  const top = t.quayTop(u);
  const at = (s: number, o: number): Vec2 => ({ x: r.x + fx * s + rx * o, z: r.z + fz * s + rz * o });
  // The deck: level with the quay, on piles.
  const mid = at(cd / 2, 0);
  t.boxAt(kit.solid, mid.x, top - 0.55, mid.z, fx, fz, cd / 2, cw / 2, 0.55, M.decking);
  for (let s = 2; s <= cd; s += 5.5) for (const o of [-cw / 2 + 0.6, 0, cw / 2 - 0.6]) {
    const q = at(s, o);
    cylinder(kit.solid, q.x, q.z, 0.25, W - 3, top - 0.55, 6, M.pile, false);
  }
  // The clubhouse: walls, a flat roof with an overhang, lit windows and a door lamp on the terrace side, a flagpole.
  const bw = cw / 2 - 3;
  const s0 = 1.4;
  const s1 = 7.6;
  const wallH = 4.2;
  const bm = at((s0 + s1) / 2, 0);
  t.boxAt(kit.solid, bm.x, top, bm.z, fx, fz, (s1 - s0) / 2, bw, wallH, M.clubWall);
  t.boxAt(kit.solid, bm.x, top + wallH, bm.z, fx, fz, (s1 - s0) / 2 + 0.9, bw + 0.9, 0.35, M.clubRoof);
  for (let o = -bw + 1.5; o <= bw - 1.4; o += 3) {
    if (Math.abs(o) < 1.1) continue;
    t.solidBox(kit.glow, at(s1 + 0.03, o - 0.8), at(s1 + 0.03, o + 0.8), fx * 0.03, fz * 0.03, top + 1.2, top + 3.0, M.glass);
  }
  t.solidBox(kit.solid, at(s1 + 0.04, -0.7), at(s1 + 0.04, 0.7), fx * 0.05, fz * 0.05, top, top + 2.4, M.trim);
  const door = at(s1 + 0.4, 0);
  t.lamp(kit.glow, door.x, top + 2.9, door.z, 0.3, M.dock);
  t.light(door.x, top + 2.9, door.z, M.glass.clone().multiplyScalar(0.3), 6);
  const flag = at(s0 + 1, bw - 1);
  cylinder(kit.solid, flag.x, flag.z, 0.05, top + wallH + 0.3, top + wallH + 5, 5, M.spar, false);
  t.boxAt(kit.solid, flag.x + rx * 0.6, top + wallH + 3.9, flag.z + rz * 0.6, rx, rz, 0.6, 0.015, 0.8, M.flag);
  // The terrace: a rail round its three open sides, tables with candles and a pair of string light lines over it.
  const post = 1.0;
  const rail: [number, number][] = [];
  for (let o = -cw / 2 + 0.3; o <= cw / 2 - 0.3 + 1e-6; o += 2.4) rail.push([cd - 0.25, o]);
  for (let s = s1 + 0.5; s < cd - 0.25; s += 2.4) rail.push([s, -cw / 2 + 0.25], [s, cw / 2 - 0.25]);
  for (const [s, o] of rail) {
    const q = at(s, o);
    cylinder(kit.solid, q.x, q.z, 0.04, top, top + post, 4, M.spar, false);
  }
  t.solidBox(kit.solid, at(cd - 0.25, -cw / 2 + 0.25), at(cd - 0.25, cw / 2 - 0.25), 0, 0, top + post, top + post + 0.05, M.spar);
  for (const o of [-cw / 2 + 0.25, cw / 2 - 0.25]) t.solidBox(kit.solid, at(s1 + 0.5, o), at(cd - 0.25, o), 0, 0, top + post, top + post + 0.05, M.spar);
  for (const [s, o] of [[s1 + 2.2, -6], [s1 + 2.2, 0], [s1 + 2.2, 6], [s1 + 4.4, -3], [s1 + 4.4, 3]]) {
    if (s > cd - 1.2 || Math.abs(o) > cw / 2 - 1.5) continue;
    const q = at(s, o);
    cylinder(kit.solid, q.x, q.z, 0.05, top, top + 0.72, 4, M.stay, false);
    cylinder(kit.solid, q.x, q.z, 0.45, top + 0.72, top + 0.76, 8, M.tableTop);
    t.lamp(kit.glow, q.x, top + 0.84, q.z, 0.1, M.candle);
  }
  const wallTop = top + wallH - 0.2;
  for (const o of [-bw + 1, bw - 1]) {
    stringLights(kit, at(s1 + 0.1, o), at(cd - 0.4, o * 1.35 > cw / 2 - 0.4 ? Math.sign(o) * (cw / 2 - 0.4) : o * 1.35), { ya: wallTop, yb: top + 3.2, sag: 0.8, step: 1.9 });
  }
  const c0 = at(cd - 0.4, -cw / 2 + 0.4);
  const c1 = at(cd - 0.4, cw / 2 - 0.4);
  stringLights(kit, c0, c1, { post: 3.2, sag: 1.0, step: 1.9 });
  t.light(mid.x + fx * 6, top + 3, mid.z + fz * 6, M.dock.clone().multiplyScalar(0.22), 5);
}

/** A hull outline for a boat of length L and beam B, bow at +s: square-ish transom, a pointed bow. */
function outline(L: number, B: number): [number, number][] {
  const H = B / 2;
  return [[-L / 2, -H * 0.82], [L * 0.2, -H], [L * 0.42, -H * 0.55], [L / 2, 0], [L * 0.42, H * 0.55], [L * 0.2, H], [-L / 2, H * 0.82]];
}

/**
 * Hull and deck of a boat (prop: centre, bow yaw, size length, height beam): the boot stripe under the
 * waterline, the topsides, the deck. Returns the placing function (s along the boat, o across), the
 * deck's height and the waterline.
 */
function hull(fl: BoatFleet, a: Area, pr: AreaProp, freeboard: number, c: THREE.Color): { pt: (s: number, o: number) => Vec2; deck: number; W: number; fx: number; fz: number } {
  const fx = Math.sin(pr.yaw);
  const fz = Math.cos(pr.yaw);
  const rx = fz;
  const rz = -fx;
  const W = sea(a, pr.x, pr.z);
  const deck = W + freeboard;
  const pt = (s: number, o: number): Vec2 => ({ x: pr.x + fx * s + rx * o, z: pr.z + fz * s + rz * o });
  const ring = outline(pr.size, pr.height);
  const band = (y0: number, k0: number, y1: number, k1: number, color: THREE.Color) => {
    for (let i = 0; i < ring.length; i++) {
      const [s0, o0] = ring[i];
      const [s1, o1] = ring[(i + 1) % ring.length];
      const p0 = pt(s0 * k0, o0 * k0);
      const p1 = pt(s1 * k0, o1 * k0);
      const q0 = pt(s0 * k1, o0 * k1);
      const q1 = pt(s1 * k1, o1 * k1);
      let nx = p1.z - p0.z;
      let nz = -(p1.x - p0.x);
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      if (((p0.x + p1.x) / 2 - pr.x) * nx + ((p0.z + p1.z) / 2 - pr.z) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const v = [fl.solid.vertex(p0.x, y0, p0.z, nx, 0, nz, 0, 0, color), fl.solid.vertex(p1.x, y0, p1.z, nx, 0, nz, 1, 0, color), fl.solid.vertex(q1.x, y1, q1.z, nx, 0, nz, 1, 1, color), fl.solid.vertex(q0.x, y1, q0.z, nx, 0, nz, 0, 1, color)];
      fl.solid.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
    }
  };
  band(W - 0.6, 0.78, W + 0.12, 0.96, M.boot);
  band(W + 0.12, 0.96, deck, 1, c);
  const centre = fl.solid.vertex(pr.x, deck, pr.z, 0, 1, 0, 0, 0, M.decking);
  const deckRing = ring.map(([s, o]) => {
    const q = pt(s, o);
    return fl.solid.vertex(q.x, deck, q.z, 0, 1, 0, 0, 0, M.decking);
  });
  for (let i = 0; i < deckRing.length; i++) fl.solid.triFacing(centre, deckRing[i], deckRing[(i + 1) % deckRing.length], 0, 1, 0);
  return { pt, deck, W, fx, fz };
}

/** A moored sailboat: hull, doghouse, a mast with a masthead light and furled sail on the boom, stays. */
function sailboat(fl: BoatFleet, a: Area, pr: AreaProp, t: MarinaTools): void {
  const k = hash(pr.x, pr.z);
  const L = pr.size;
  const B = pr.height;
  const mark = fl.begin();
  const { pt, deck, fx, fz, W } = hull(fl, a, pr, 0.95, M.hullHigh[k % M.hullHigh.length]);
  const cab = pt(-L * 0.08, 0);
  t.boxAt(fl.solid, cab.x, deck, cab.z, fx, fz, L * 0.17, B * 0.3, 0.55, M.cabin);
  const mast = pt(L * 0.12, 0);
  const H = L * 1.15;
  cylinder(fl.solid, mast.x, mast.z, 0.07, deck, deck + H, 5, M.spar, false);
  const aft = pt(-L * 0.42, 0);
  t.beam(fl.solid, mast.x, deck + 1.5, mast.z, aft.x, deck + 1.5, aft.z, 0.06, M.spar);
  t.beam(fl.solid, mast.x, deck + 1.62, mast.z, aft.x, deck + 1.62, aft.z, 0.13, M.white);
  const bow = pt(L * 0.48, 0);
  t.beam(fl.solid, mast.x, deck + H - 0.5, mast.z, bow.x, deck + 0.4, bow.z, 0.012, M.stay);
  t.beam(fl.solid, mast.x, deck + H - 0.5, mast.z, aft.x, deck + 0.4, aft.z, 0.012, M.stay);
  t.lamp(fl.glow, mast.x, deck + H + 0.15, mast.z, 0.2, M.masthead);
  if (k % 3 === 0) t.light(mast.x, deck + H, mast.z, M.masthead.clone().multiplyScalar(0.12), 0.8);
  // A lit cabin on about half of them, a stern light on most.
  if (k % 2) {
    for (const o of [-1, 1]) {
      const q = pt(-L * 0.08, o * B * 0.3);
      t.solidBox(fl.glow, pt(-L * 0.08 - L * 0.1, o * B * 0.3), pt(-L * 0.08 + L * 0.1, o * B * 0.3), fz * o * 0.03, -fx * o * 0.03, deck + 0.18, deck + 0.42, M.glass);
      void q;
    }
  }
  const stern = pt(-L * 0.5 + 0.1, 0);
  t.lamp(fl.glow, stern.x, deck + 0.9, stern.z, 0.14, M.masthead);
  fl.end(mark, { x: pr.x, z: pr.z, y: W, phase: mooringPhase(pr.x, pr.z), kind: 'sailboat' });
}

/** A moored motor yacht: a tall hull, saloon and flybridge with lit windows, a radar mast and running lights. */
function yacht(fl: BoatFleet, a: Area, pr: AreaProp, t: MarinaTools): void {
  const k = hash(pr.x, pr.z);
  const L = pr.size;
  const B = pr.height;
  const mark = fl.begin();
  const { pt, deck, fx, fz, W } = hull(fl, a, pr, 1.35, M.hullHigh[(k + 2) % M.hullHigh.length]);
  const sal = pt(-L * 0.08, 0);
  t.boxAt(fl.solid, sal.x, deck, sal.z, fx, fz, L * 0.3, B * 0.38, 1.4, M.white);
  t.boxAt(fl.solid, sal.x, deck + 1.4, sal.z, fx, fz, L * 0.32, B * 0.4, 0.12, M.cabin);
  const fly = pt(-L * 0.12, 0);
  t.boxAt(fl.solid, fly.x, deck + 1.52, fly.z, fx, fz, L * 0.15, B * 0.3, 1.0, M.white);
  t.boxAt(fl.solid, fly.x, deck + 2.52, fly.z, fx, fz, L * 0.17, B * 0.33, 0.1, M.cabin);
  const lit = k % 4 !== 0;
  for (const o of [-1, 1]) {
    t.solidBox(fl.glow, pt(-L * 0.08 - L * 0.24, o * B * 0.386), pt(-L * 0.08 + L * 0.2, o * B * 0.386), fz * o * 0.03, -fx * o * 0.03, deck + 0.4, deck + 1.1, lit ? M.glass : M.glassDim);
  }
  t.solidBox(fl.glow, pt(-L * 0.12 + L * 0.15 + 0.03, -B * 0.25), pt(-L * 0.12 + L * 0.15 + 0.03, B * 0.25), fx * 0.03, fz * 0.03, deck + 1.7, deck + 2.3, lit ? M.glass : M.glassDim);
  const mast = pt(-L * 0.12, 0);
  cylinder(fl.solid, mast.x, mast.z, 0.05, deck + 2.6, deck + 4.4, 5, M.spar, false);
  t.lamp(fl.glow, mast.x, deck + 4.5, mast.z, 0.2, M.masthead);
  const bow = pt(L * 0.34, 0);
  t.lamp(fl.glow, bow.x, deck + 0.5, bow.z, 0.14, M.masthead);
  for (const o of [-1, 1]) {
    const q = pt(L * 0.22, o * B * 0.48);
    t.lamp(fl.glow, q.x, deck + 0.35, q.z, 0.14, o < 0 ? M.navRed : M.navGreen);
  }
  if (k % 3 === 1) t.light(sal.x, deck + 1.2, sal.z, M.glass.clone().multiplyScalar(0.1), 2.4);
  fl.end(mark, { x: pr.x, z: pr.z, y: W, phase: mooringPhase(pr.x, pr.z), kind: 'yacht' });
}

/** A dinghy (prop: centre, yaw, size length; height 1 afloat tied off, 0 pulled up bottom up on the club's deck). */
function dinghy(kit: DistrictKit, fl: BoatFleet, a: Area, pr: AreaProp, t: MarinaTools): void {
  const fx = Math.sin(pr.yaw);
  const fz = Math.cos(pr.yaw);
  const rx = fz;
  const rz = -fx;
  const L = pr.size;
  const B = L * 0.42;
  const c = M.dinghy[hash(pr.x, pr.z) % M.dinghy.length];
  const afloat = pr.height > 0.5;
  // Afloat it rocks with the fleet; pulled up on the deck it stays in the kit's solid.
  const gb = afloat ? fl.solid : kit.solid;
  const mark = fl.begin();
  const base = afloat ? sea(a, pr.x, pr.z) - 0.15 : t.quayTop(frameU(harborFrame(a), pr.x, pr.z)) + 0.3;
  const pt = (s: number, o: number): Vec2 => ({ x: pr.x + fx * s + rx * o, z: pr.z + fz * s + rz * o });
  const ring: [number, number][] = [[-L / 2, -B * 0.45], [L * 0.1, -B / 2], [L / 2, 0], [L * 0.1, B / 2], [-L / 2, B * 0.45]];
  const h = 0.5;
  for (let i = 0; i < ring.length; i++) {
    const p0 = pt(...ring[i]);
    const p1 = pt(...ring[(i + 1) % ring.length]);
    let nx = p1.z - p0.z;
    let nz = -(p1.x - p0.x);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((p0.x + p1.x) / 2 - pr.x) * nx + ((p0.z + p1.z) / 2 - pr.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const v = [gb.vertex(p0.x, base, p0.z, nx, 0, nz, 0, 0, c), gb.vertex(p1.x, base, p1.z, nx, 0, nz, 1, 0, c), gb.vertex(p1.x, base + h, p1.z, nx, 0, nz, 1, 1, c), gb.vertex(p0.x, base + h, p0.z, nx, 0, nz, 0, 1, c)];
    gb.quadFacing(v[0], v[1], v[2], v[3], nx, 0, nz);
  }
  // Afloat it is open (a thwart across); pulled up it is closed over, on two rack beams.
  if (afloat) {
    t.boxAt(gb, pr.x, base + 0.25, pr.z, rx, rz, B * 0.45, 0.04, 0.05, M.decking);
  } else {
    const centre = gb.vertex(pr.x, base + h, pr.z, 0, 1, 0, 0, 0, c);
    const ids = ring.map(([s, o]) => {
      const q = pt(s, o);
      return gb.vertex(q.x, base + h, q.z, 0, 1, 0, 0, 0, c);
    });
    for (let i = 0; i < ids.length; i++) gb.triFacing(centre, ids[i], ids[(i + 1) % ids.length], 0, 1, 0);
    for (const s of [-L * 0.28, L * 0.22]) {
      const q = pt(s, 0);
      t.boxAt(gb, q.x, base - 0.3, q.z, rx, rz, B / 2, 0.06, 0.3, M.pile);
    }
  }
  if (afloat) fl.end(mark, { x: pr.x, z: pr.z, y: base + 0.15, phase: mooringPhase(pr.x, pr.z), kind: 'dinghy' });
}
