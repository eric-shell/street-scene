/**
 * Tunnel renderer (src/city/districts/tunnel.ts): the bore and what stands
 * over it.
 *
 * Inside, both variants share one bore: tiled walls with a dark kick plate
 * and a yellow kerb stripe on the sim's tunnel walls, a flat ceiling under a
 * building or a segmental vault through a ridge, two rows of sodium strip
 * fixtures that streak past at speed, jet fans in pairs and green exit signs.
 * The walls and ceiling carry baked sodium light (structureFx: emissive by
 * vertex, nothing per frame) and an additive wash lays the light on the
 * asphalt, spilling a few meters out of each portal.
 *
 *  - 'building': an air rights office block straddles the street, one mass
 *    over the bore and the funnels between its legs, with ribbon windows
 *    (some lit), a concrete surround and an LED line framing each portal, a
 *    backlit name board and a clearance plate. The funnels' wingwalls (the
 *    sim's) are faced like the bore.
 *  - 'ridge': faceted rock draped over the ridge (the terrain, with the cut
 *    corridor filled back in over the bore), trees on its gentler slopes,
 *    a concrete headwall at each portal with the vault's opening, tapering
 *    retaining walls along the cutting (the wingwalls) and a low stone wall
 *    at the foot of the rock face ('rock' walls).
 *
 * Draw calls: the baked interior, the road wash (Medium and up) and the sign
 * boards are one mesh each for every tunnel in the city; everything else
 * goes into the kit's merged builders. Quality trims the fixture spacing,
 * the fans and signs and the rock's resolution.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area } from '../../city/districts/types';
import { toWorld } from '../../city/districts/structures';
import { smooth01 } from '../../city/districts/geom';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, wallBox } from './kit';
import { BakedBuilder, CLEARANCE_CELL, bakedMaterial, frameBox, frameCylinderU, frameWall, makeStructureSigns, nameCell, signPanel } from './structureFx';
import { washMaterial } from '../materialFx';
import { ridgeRawAt } from '../../city/districts/tunnel';
import { FACADE_OUT, FLOOR_H, RidgeShape, TunnelShape, boreRoad, bridgeTop, ceilingAbove, coverOf, ridgeShape, rockAt, tunnelShape, vaultProfile } from './structureShapes';

const TCFG = CITY.districts.tunnel;

const TUN = {
  /** Strip fixtures: spacing along the bore by quality (m), length (m), width (m). */
  lampEvery: { low: 6.4, medium: 3.2, high: 3.2 },
  lampLen: 2.2,
  lampW: 0.28,
  /** Fixture rows over the lanes: this share of the curb's half width from the centerline, at least lampRowMin (m). */
  lampRow: 0.55,
  lampRowMin: 2.8,
  /** Wall bands above the walkway (m): kick plate, kerb stripe, tiles. */
  kick: 0.35,
  stripe: 0.5,
  tiles: 3.3,
  /** Jet fans: a pair about every this far (m), radius, length (m). */
  fanEvery: 26,
  fanR: 0.52,
  fanLen: 3.4,
  /** Exit signs every this far (m), alternating sides. */
  exitEvery: 24,
  /** Wash: spill past the portals (m) and brightness under the fixtures (additive, linear). */
  spill: 7,
  wash: 0.3,
  /** Rock drape grid (m) by quality, and trees per 100 m^2 of gentle rock. */
  rockStep: { low: 4.5, medium: 3, high: 2.4 },
  treeDensity: { low: 0.25, medium: 0.5, high: 0.6 },
} as const;

/** Baked light levels (0..1) per surface. */
const BAKE = { kick: 0.25, stripe: 0.55, tiles: 0.6, upper: 0.42, ceiling: 0.32, ceilingLit: 0.75, funnel: 0.4 } as const;

const C = {
  tile: col(0xd8d1bd),
  kick: col(0x2a2a2d),
  stripe: col(0xd9a520),
  upper: col(0x5a5856),
  ceiling: col(0x3c3c42),
  housing: col(0x1d1e22),
  fan: col(0x65686d),
  concrete: col(0x6a6863),
  concreteDark: col(0x4b4a47),
  spandrel: col(0x6e6a63),
  glass: col(0x1a2129),
  roof: col(0x3a3a3d),
  rock: col(0x4c4640),
  moss: col(0x34402c),
  stone: col(0x57524b),
} as const;

const LIGHT = {
  sodium: col(0xffa040, 0.95),
  exit: col(0x2aff7a, 0.8),
  led: col(0xd8f0ff, 0.9),
  amber: col(0xffb020, 1.2),
  red: col(0xff2a1a, 1.4),
  warm: col(0xffd9a0, 0.5),
  cool: col(0xc8e0ff, 0.38),
  lobby: col(0xfff0d0, 0.6),
} as const;

const SODIUM_WASH = new THREE.Color(0xffa040);

export const tunnelRenderer: DistrictRenderer = {
  kinds: ['tunnel'],
  build(kit, areas) {
    const baked = new BakedBuilder();
    const wash = new GeoBuilder(true);
    const signs = new GeoBuilder(true);
    for (const a of areas) {
      const t = tunnelShape(a);
      const ridge = a.variant === 'ridge';
      const rng = new Rng((a.params.seed >>> 0) || 1);
      bore(kit, baked, t, ridge, rng);
      if (kit.quality !== 'low') roadWash(kit, wash, t, ridge);
      if (ridge) ridgeRock(kit, baked, signs, a, t, rng);
      else airRights(kit, signs, a, t, rng);
    }
    // The rock face along each ridge's cutting: a low stone wall at the foot of the cliff.
    for (const w of kit.walls.get('rock') ?? []) wallBox(kit, kit.solid, w, 0.7, 1.3, C.stone);
    const add = (gb: GeoBuilder, name: string, mat: THREE.Material, order = 0) => {
      if (!gb.vertexCount) return;
      const m = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
      m.name = name;
      m.renderOrder = order;
      kit.group.add(m);
    };
    add(baked, 'tunnelBore', bakedMaterial(LIGHT.sodium.clone().multiplyScalar(0.9)));
    add(wash, 'tunnelWash', washMaterial(), 1);
    if (signs.vertexCount) {
      const map = kit.track(makeStructureSigns());
      add(signs, 'tunnelSigns', new THREE.MeshBasicMaterial({ map, vertexColors: true }));
    }
  },
};

/** Distance of the fixture rows from the centerline (m). */
const rowOf = (t: TunnelShape) => Math.max(TUN.lampRowMin, t.road * TUN.lampRow);

/** Positions from -L to L about every `step` (m), always including both ends. */
function stations(L: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((2 * L) / step));
  return Array.from({ length: n + 1 }, (_, i) => -L + (2 * L * i) / n);
}

/**
 * Banded wall face (kick, stripe, tiles, upper concrete) from (u0, v0) to (u1, v1), from the road up to
 * top0 / top1 above it, facing (nx, nz). Plain: bare concrete (a ridge's retaining walls, outside).
 */
function bandedFace(kit: DistrictKit, bb: BakedBuilder, t: TunnelShape, u0: number, v0: number, u1: number, v1: number, top0: number, top1: number, nx: number, nz: number, plain = false): void {
  const y0 = boreRoad(kit.world, t, u0);
  const y1 = boreRoad(kit.world, t, u1);
  if (plain) {
    bb.light = 0.12;
    frameWall(bb, t, u0, v0, u1, v1, y0 - 0.3, y0 + top0, y1 - 0.3, y1 + top1, C.concrete, nx, nz);
    return;
  }
  const bands: [number, number, THREE.Color, number][] = [
    [-0.3, TUN.kick, C.kick, BAKE.kick],
    [TUN.kick, TUN.stripe, C.stripe, BAKE.stripe],
    [TUN.stripe, TUN.tiles, C.tile, BAKE.tiles],
  ];
  for (const [b0, b1, color, bake] of bands) {
    bb.light = bake;
    frameWall(bb, t, u0, v0, u1, v1, y0 + b0, y0 + Math.min(b1, top0), y1 + b0, y1 + Math.min(b1, top1), color, nx, nz);
  }
  bb.light = BAKE.upper;
  if (top0 > TUN.tiles || top1 > TUN.tiles) frameWall(bb, t, u0, v0, u1, v1, y0 + TUN.tiles, y0 + Math.max(TUN.tiles, top0), y1 + TUN.tiles, y1 + Math.max(TUN.tiles, top1), C.upper, nx, nz);
}

/** The bore: walls, funnels, ceiling or vault, fixtures, fans and exit signs. */
function bore(kit: DistrictKit, bb: BakedBuilder, t: TunnelShape, ridge: boolean, rng: Rng): void {
  const cover = coverOf(t, ridge);
  const V = { x: -t.uz, z: t.ux };
  const us = stations(t.half, 4);
  const top = (v: number) => ceilingAbove(t, ridge, v);
  for (const side of [1, -1]) {
    // Bore walls on the walkway's back edge: banded inner face, solid back to the building line.
    for (let i = 0; i + 1 < us.length; i++) {
      const u0 = us[i];
      const u1 = us[i + 1];
      bandedFace(kit, bb, t, u0, side * t.wall, u1, side * t.wall, top(t.wall), top(t.wall), -side * V.x, -side * V.z);
      const y0 = boreRoad(kit.world, t, u0);
      const y1 = boreRoad(kit.world, t, u1);
      bb.light = BAKE.upper;
      frameBox(bb, t, u0, u1, side > 0 ? t.wall : -(t.front + 0.3), side > 0 ? t.front + 0.3 : -t.wall, y0 - 0.3, y1 - 0.3, y0 + top(t.wall), y1 + top(t.wall), C.concreteDark, { v0: side < 0, v1: side > 0, u0: false, u1: false, bottom: false });
    }
    // Funnels: the wingwalls from the walkway out to the building line, faced like the bore under a building,
    // tapering retaining walls down a ridge's cutting.
    for (const end of [-1, 1]) {
      const ua = end * t.half;
      const ub = end * (t.half + t.wing);
      const va = side * t.wall;
      const vb = side * t.front;
      // Normal of the wing face toward the road and the approach.
      const du = ub - ua;
      const dv = vb - va;
      const l = Math.hypot(du, dv) || 1;
      let nu = dv / l;
      let nv = -du / l;
      if (nv * side > 0) {
        nu = -nu;
        nv = -nv;
      }
      const nx = t.ux * nu - t.uz * nv;
      const nz = t.uz * nu + t.ux * nv;
      const hA = ridge ? top(t.wall) : TCFG.clearance;
      const hB = ridge ? 1.6 : TCFG.clearance;
      bandedFace(kit, bb, t, ua, va, ub, vb, hA, hB, nx, nz, ridge);
      // Fill between the wing and the building line, and its cap.
      const ya = boreRoad(kit.world, t, ua);
      const yb = boreRoad(kit.world, t, ub);
      const pa = toWorld(t, ua, va);
      const pb = toWorld(t, ub, vb);
      const pc = toWorld(t, ua, side * (t.front + 0.3));
      const pd = toWorld(t, ub, side * (t.front + 0.3));
      bb.light = BAKE.funnel;
      const cap = [bb.vertex(pa.x, ya + hA, pa.z, 0, 1, 0, 0, 0, C.concreteDark), bb.vertex(pb.x, yb + hB, pb.z, 0, 1, 0, 0, 0, C.concreteDark), bb.vertex(pd.x, yb + hB, pd.z, 0, 1, 0, 0, 0, C.concreteDark), bb.vertex(pc.x, ya + hA, pc.z, 0, 1, 0, 0, 0, C.concreteDark)];
      bb.quadFacing(cap[0], cap[1], cap[2], cap[3], 0, 1, 0);
      // Outer end of the wing: faces along the street, away from the portal.
      frameWall(bb, t, ub, vb, ub, side * (t.front + 0.3), yb - 0.3, yb + hB, yb - 0.3, yb + hB, C.concreteDark, t.ux * end, t.uz * end);
    }
  }
  // Ceiling: flat under a building (bore and funnels), the vault through a ridge; brighter over the fixture rows.
  const cs = stations(cover, 4);
  const row = rowOf(t);
  const prof = ridge ? vaultProfile(t, true, 12) : [-t.front - 0.3, -row - 1.2, -row + 1.2, row - 1.2, row + 1.2, t.front + 0.3].map((v) => ({ v, y: TCFG.clearance }));
  const lit = (v: number) => (Math.abs(Math.abs(v) - row) < 1.3 ? BAKE.ceilingLit : BAKE.ceiling);
  for (let i = 0; i + 1 < cs.length; i++) {
    const u0 = cs[i];
    const u1 = cs[i + 1];
    const y0 = boreRoad(kit.world, t, u0);
    const y1 = boreRoad(kit.world, t, u1);
    for (let k = 0; k + 1 < prof.length; k++) {
      const p = prof[k];
      const q = prof[k + 1];
      // Down and toward the bore's middle.
      const dv = q.v - p.v;
      const dy = q.y - p.y;
      const l = Math.hypot(dv, dy) || 1;
      let nv = -dy / l;
      let ny = dv / l;
      if (ny > 0) {
        nv = -nv;
        ny = -ny;
      }
      const ids: number[] = [];
      for (const [u, y, pt] of [
        [u0, y0, p],
        [u1, y1, p],
        [u1, y1, q],
        [u0, y0, q],
      ] as const) {
        bb.light = lit(pt.v);
        const w = toWorld(t, u, pt.v);
        ids.push(bb.vertex(w.x, y + pt.y, w.z, -t.uz * nv, ny, t.ux * nv, 0, 0, C.ceiling));
      }
      bb.quadFacing(ids[0], ids[1], ids[2], ids[3], -t.uz * nv, ny, t.ux * nv);
    }
  }
  // Sodium strip fixtures in two rows, hung just under the ceiling, and their dark housings.
  const every = TUN.lampEvery[kit.quality];
  const n = Math.max(1, Math.floor((2 * cover - 1) / every));
  for (let i = 0; i < n; i++) {
    const u = -cover + 0.5 + every * (i + 0.5);
    const y = boreRoad(kit.world, t, u);
    for (const side of [1, -1]) {
      const v = side * row;
      const yc = y + top(v);
      frameBox(kit.glow, t, u - TUN.lampLen / 2, u + TUN.lampLen / 2, v - TUN.lampW / 2, v + TUN.lampW / 2, yc - 0.16, yc - 0.16, yc - 0.06, yc - 0.06, LIGHT.sodium, { top: false });
      frameBox(kit.solid, t, u - TUN.lampLen / 2 - 0.1, u + TUN.lampLen / 2 + 0.1, v - TUN.lampW / 2 - 0.08, v + TUN.lampW / 2 + 0.08, yc - 0.06, yc - 0.06, yc + 0.05, yc + 0.05, C.housing, { bottom: false });
    }
  }
  if (kit.quality === 'low') return;
  // Jet fans in pairs over the lanes, and green exit signs on alternate walls.
  const fans = Math.max(1, Math.round((2 * t.half) / TUN.fanEvery));
  for (let i = 0; i < fans; i++) {
    const u = -t.half + (2 * t.half * (i + 0.5)) / fans;
    const y = boreRoad(kit.world, t, u);
    for (const side of [1, -1]) {
      const v = side * 1.9;
      const yc = y + top(v) - TUN.fanR - 0.35;
      frameCylinderU(kit.solid, t, u - TUN.fanLen / 2, u + TUN.fanLen / 2, v, yc, TUN.fanR, 10, C.fan);
      frameBox(kit.solid, t, u - 0.6, u + 0.6, v - 0.08, v + 0.08, yc + TUN.fanR - 0.05, yc + TUN.fanR - 0.05, y + top(v) + 0.05, y + top(v) + 0.05, C.housing);
    }
  }
  const exits = Math.max(1, Math.floor((2 * t.half) / TUN.exitEvery));
  for (let i = 0; i < exits; i++) {
    const u = -t.half + (2 * t.half * (i + 0.5)) / exits;
    const side = (i + rng.int(0, 1)) % 2 ? 1 : -1;
    const y = boreRoad(kit.world, t, u);
    const v = side * (t.wall - 0.04);
    frameBox(kit.glow, t, u - 0.45, u + 0.45, v - 0.03, v + 0.03, y + 2.3, y + 2.3, y + 2.7, y + 2.7, LIGHT.exit);
  }
}

/** Sodium light on the asphalt and walkways: brightest under the fixture rows, spilling out of the portals. */
function roadWash(kit: DistrictKit, gb: GeoBuilder, t: TunnelShape, ridge: boolean): void {
  const cover = coverOf(t, ridge);
  const L = cover + TUN.spill;
  const us = stations(L, 2);
  const row = rowOf(t);
  const vs = [-t.wall, -t.road - 0.15, -t.road, -row - 2, -row, -row + 2, 0, row - 2, row, row + 2, t.road, t.road + 0.15, t.wall];
  const c = new THREE.Color();
  const level = (u: number, v: number) => {
    const along = 1 - smooth01(cover - 2, L, Math.abs(u)).v;
    const across = 0.45 + 0.55 * Math.max(0, 1 - Math.abs(Math.abs(v) - row) / 3.2);
    return TUN.wash * along * across;
  };
  const vert = (u: number, v: number) => {
    const p = toWorld(t, u, v);
    const walk = Math.abs(v) > t.road + 0.1 ? CITY.curbHeight : 0;
    c.copy(SODIUM_WASH).multiplyScalar(level(u, v));
    return gb.vertex(p.x, kit.h(p.x, p.z) + walk + 0.05, p.z, 0, 1, 0, 0, 0, c);
  };
  for (let i = 0; i + 1 < us.length; i++) {
    for (let k = 0; k + 1 < vs.length; k++) {
      // Inside the walls only (the funnels widen beyond the bore).
      const um = Math.abs((us[i] + us[i + 1]) / 2);
      const vm = Math.abs((vs[k] + vs[k + 1]) / 2);
      if (um <= t.half && vm > t.wall) continue;
      const a = vert(us[i], vs[k]);
      const b = vert(us[i + 1], vs[k]);
      const d = vert(us[i + 1], vs[k + 1]);
      const e = vert(us[i], vs[k + 1]);
      gb.quadFacing(a, b, d, e, 0, 1, 0);
    }
  }
}

/** Ribbon window facade on a vertical rectangle from (u0, v0) to (u1, v1) between heights y0 and y1, facing (nx, nz). */
function facade(kit: DistrictKit, t: TunnelShape, u0: number, v0: number, u1: number, v1: number, yb0: number, yb1: number, yTop: number, nx: number, nz: number, rng: Rng, lobby: boolean): void {
  const len = Math.hypot(u1 - u0, v1 - v0);
  const base = Math.max(yb0, yb1);
  // Plinth up to a level line, then floors of spandrel and glass.
  frameWall(kit.solid, t, u0, v0, u1, v1, Math.min(yb0, yb1) - 0.5, base + (lobby ? 0 : 0.6), Math.min(yb0, yb1) - 0.5, base + (lobby ? 0 : 0.6), C.concreteDark, nx, nz);
  const bays = Math.max(1, Math.round(len / 2.6));
  let y = base + (lobby ? 0 : 0.6);
  let floor = 0;
  while (y + FLOOR_H <= yTop - 0.4) {
    const glass0 = y + 1.0;
    const glass1 = y + FLOOR_H - 0.2;
    frameWall(kit.solid, t, u0, v0, u1, v1, y, glass0, y, glass0, C.spandrel, nx, nz);
    frameWall(kit.solid, t, u0, v0, u1, v1, glass0, glass1, glass0, glass1, C.glass, nx, nz);
    frameWall(kit.solid, t, u0, v0, u1, v1, glass1, y + FLOOR_H, glass1, y + FLOOR_H, C.spandrel, nx, nz);
    // Lit bays, a hair in front of the glass.
    const ground = lobby && floor === 0;
    for (let b = 0; b < bays; b++) {
      const lit = ground ? rng.next() < 0.8 : rng.next() < 0.45;
      if (!lit) continue;
      const s0 = (b + 0.08) / bays;
      const s1 = (b + 0.92) / bays;
      const color = ground ? LIGHT.lobby : rng.next() < 0.7 ? LIGHT.warm : LIGHT.cool;
      frameWall(kit.glow, t, u0 + (u1 - u0) * s0 + nxToU(t, nx, nz) * 0.03, v0 + (v1 - v0) * s0 + nxToV(t, nx, nz) * 0.03, u0 + (u1 - u0) * s1 + nxToU(t, nx, nz) * 0.03, v0 + (v1 - v0) * s1 + nxToV(t, nx, nz) * 0.03, glass0 + 0.1, glass1 - 0.1, glass0 + 0.1, glass1 - 0.1, color, nx, nz);
    }
    y += FLOOR_H;
    floor++;
  }
  frameWall(kit.solid, t, u0, v0, u1, v1, y, yTop, y, yTop, C.spandrel, nx, nz);
}

const nxToU = (t: TunnelShape, nx: number, nz: number) => nx * t.ux + nz * t.uz;
const nxToV = (t: TunnelShape, nx: number, nz: number) => -nx * t.uz + nz * t.ux;

/** The air rights building: legs either side, the span over the bore, portal surrounds, signs and lights. */
function airRights(kit: DistrictKit, signs: GeoBuilder, a: Area, t: TunnelShape, rng: Rng): void {
  const reach = coverOf(t, false);
  const depth = a.params.legDepth;
  const yA = boreRoad(kit.world, t, -reach);
  const yB = boreRoad(kit.world, t, reach);
  const roof = Math.max(yA, yB) + bridgeTop(a);
  const U = { x: t.ux, z: t.uz };
  const V = { x: -t.uz, z: t.ux };
  // Lowest ground under each leg: the facade starts there.
  const legBase = (side: number) => {
    let lo = Infinity;
    for (const u of [-reach, 0, reach]) for (const dv of [0, depth]) {
      const p = toWorld(t, u, side * (t.front + dv));
      lo = Math.min(lo, kit.h(p.x, p.z));
    }
    return lo;
  };
  for (const side of [1, -1]) {
    const v0 = side * t.front;
    const v1 = side * (t.front + depth);
    const yb = legBase(side);
    // Portal facades of the leg (along the street) and its back (into the block), then the roof.
    facade(kit, t, -reach, side > 0 ? v1 : v0, -reach, side > 0 ? v0 : v1, yb, yb, roof, -U.x, -U.z, rng, true);
    facade(kit, t, reach, side > 0 ? v0 : v1, reach, side > 0 ? v1 : v0, yb, yb, roof, U.x, U.z, rng, true);
    facade(kit, t, -reach, v1, reach, v1, yb, yb, roof, side * V.x, side * V.z, rng, false);
    frameBox(kit.solid, t, -reach, reach, Math.min(v0, v1), Math.max(v0, v1), roof - 0.4, roof - 0.4, roof, roof, C.roof, { v0: false, v1: false, u0: false, u1: false, bottom: false });
  }
  // The legs' street faces between the wingwalls' ends and the facade, under the span.
  for (const side of [1, -1]) {
    for (const end of [-1, 1]) {
      const u0 = end * (reach - FACADE_OUT);
      const ya = boreRoad(kit.world, t, u0);
      const yb = boreRoad(kit.world, t, end * reach);
      frameWall(kit.solid, t, u0, side * t.front, end * reach, side * t.front, ya - 0.3, ya + TCFG.clearance, yb - 0.3, yb + TCFG.clearance, C.concreteDark, -side * V.x, -side * V.z);
    }
  }
  // The span over the bore and funnels: portal facades above the openings, roof.
  const spanBase = (u: number) => boreRoad(kit.world, t, u) + TCFG.clearance;
  for (const end of [-1, 1]) {
    const u = end * reach;
    const yb = spanBase(u);
    facade(kit, t, u, end > 0 ? -t.front : t.front, u, end > 0 ? t.front : -t.front, yb, yb, roof, end * U.x, end * U.z, rng, false);
  }
  frameBox(kit.solid, t, -reach, reach, -t.front, t.front, roof - 0.4, roof - 0.4, roof, roof, C.roof, { v0: false, v1: false, u0: false, u1: false, bottom: false });
  // Parapet, rooftop plant and an aviation light.
  frameBox(kit.solid, t, -reach, reach, -(t.front + depth), -(t.front + depth) + 0.3, roof, roof, roof + 1, roof + 1, C.concreteDark);
  frameBox(kit.solid, t, -reach, reach, t.front + depth - 0.3, t.front + depth, roof, roof, roof + 1, roof + 1, C.concreteDark);
  for (let k = 0; k < 3; k++) {
    const u = rng.range(-reach + 3, reach - 3);
    const v = rng.range(-t.front - depth + 3, t.front + depth - 3);
    frameBox(kit.solid, t, u - 1.4, u + 1.4, v - 1, v + 1, roof, roof, roof + rng.range(1.2, 2.4), roof + rng.range(1.2, 2.4), C.fan);
  }
  frameBox(kit.solid, t, -0.06, 0.06, -0.06, 0.06, roof - 0.4, roof - 0.4, roof + 2.6, roof + 2.6, C.housing);
  frameBox(kit.glow, t, -0.15, 0.15, -0.15, 0.15, roof + 2.6, roof + 2.6, roof + 2.9, roof + 2.9, LIGHT.red);
  // Portal surrounds: lintel and jambs proud of the facade, an LED line along the opening, signs and lamps.
  const nameIdx = a.params.name ?? 0;
  for (const end of [-1, 1]) {
    const u = end * reach;
    const out = end * 0.35;
    const y = boreRoad(kit.world, t, u);
    const yc = y + TCFG.clearance;
    frameBox(kit.solid, t, Math.min(u, u + out), Math.max(u, u + out), -t.front - 0.9, t.front + 0.9, yc, yc, yc + 1.3, yc + 1.3, C.concrete);
    // The jambs stand on the building line, never over the sidewalk a car can use.
    for (const side of [1, -1]) frameBox(kit.solid, t, Math.min(u, u + out), Math.max(u, u + out), side > 0 ? t.front : -t.front - 0.9, side > 0 ? t.front + 0.9 : -t.front, y - 0.3, y - 0.3, yc, yc, C.concrete);
    if (kit.quality !== 'low') {
      const uL = u + out + end * 0.02;
      frameBox(kit.glow, t, Math.min(uL, uL + end * 0.06), Math.max(uL, uL + end * 0.06), -t.front + 0.3, t.front - 0.3, yc + 0.05, yc + 0.05, yc + 0.13, yc + 0.13, LIGHT.led);
      for (const side of [1, -1]) frameBox(kit.glow, t, Math.min(uL, uL + end * 0.06), Math.max(uL, uL + end * 0.06), side * (t.front - 0.3) - 0.04, side * (t.front - 0.3) + 0.04, y + 0.4, y + 0.4, yc + 0.05, yc + 0.05, LIGHT.led);
    }
    // Amber lamps on the jambs.
    for (const side of [1, -1]) frameBox(kit.glow, t, Math.min(u + out, u + out + end * 0.25), Math.max(u + out, u + out + end * 0.25), side * (t.front + 0.3) - 0.25, side * (t.front + 0.3) + 0.25, yc - 0.6, yc - 0.6, yc - 0.15, yc - 0.15, LIGHT.amber);
    const p = toWorld(t, u + out + end * 0.05, 0);
    signPanel(signs, p.x, yc + 0.65, p.z, end * U.x, end * U.z, 4.2, 1.05, CLEARANCE_CELL, col(0xffffff, 0.75));
    signPanel(signs, p.x, yc + 2.4, p.z, end * U.x, end * U.z, 9, 2.25, nameCell(nameIdx), col(0xffffff, 1.15));
  }
}

/** The ridge: draped rock, the portal headwalls with their openings and signs, trees. */
function ridgeRock(kit: DistrictKit, bb: BakedBuilder, signs: GeoBuilder, a: Area, t: TunnelShape, rng: Rng): void {
  const r: RidgeShape = ridgeShape(a);
  const world = kit.world;
  const reachU = r.a + r.w;
  const reachV = r.b + r.w;
  const step = TUN.rockStep[kit.quality];
  // Sample lines: a regular grid, the portals, and fine steps up the cut faces of the cutting.
  const lines = (L: number, extra: number[]) => {
    const out = stations(L, step).concat(extra);
    out.sort((x, y) => x - y);
    return out.filter((x, i) => i === 0 || x - out[i - 1] > 0.25);
  };
  const fine: number[] = [];
  for (let k = 0; k <= 8; k++) for (const s of [1, -1]) fine.push(s * (t.front + 0.25 + k * 0.6));
  fine.push(t.front, -t.front);
  const us = lines(reachU, [t.half, -t.half]);
  const vs = lines(reachV, fine);
  /** Base terrain under the ridge (the ridge taken out), and how far the rock stands above it. */
  const rise = (x: number, z: number, over: boolean) => {
    const raw = ridgeRawAt(r, x, z);
    const filled = rockAt(world, r, x, z);
    return over ? raw : world.heightAt(x, z) - (filled - raw);
  };
  /** Rock surface: filled in over the bore, the terrain with its cut elsewhere, sunk at the outline to meet the ground plane. */
  const surface = (u: number, v: number): number => {
    const p = toWorld(r, u, v);
    const over = Math.abs(u) <= t.half + 1e-6;
    const y = over ? rockAt(world, r, p.x, p.z) : world.heightAt(p.x, p.z);
    return y - 0.4 * Math.max(0, 1 - rise(p.x, p.z, over) / 1.5);
  };
  const tint = new THREE.Color();
  const hash = (x: number, z: number) => {
    const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i + 1 < us.length; i++) {
    for (let k = 0; k + 1 < vs.length; k++) {
      const um = (us[i] + us[i + 1]) / 2;
      const vm = (vs[k] + vs[k + 1]) / 2;
      // The open corridor beyond the portals is the street.
      if (Math.abs(vm) < t.front && Math.abs(um) > t.half) continue;
      // Outside the footprint: no rock at any corner.
      let any = false;
      for (const [uu, vv] of [
        [us[i], vs[k]],
        [us[i + 1], vs[k]],
        [us[i], vs[k + 1]],
        [us[i + 1], vs[k + 1]],
      ]) {
        const p = toWorld(r, uu, vv);
        if (rise(p.x, p.z, Math.abs(um) <= t.half) > 0.02) any = true;
      }
      if (!any) continue;
      const corners = [
        [us[i], vs[k]],
        [us[i + 1], vs[k]],
        [us[i + 1], vs[k + 1]],
        [us[i], vs[k + 1]],
      ].map(([u, v]) => {
        const p = toWorld(r, u, v);
        return { x: p.x, y: surface(u, v), z: p.z };
      });
      for (const tri of [
        [0, 1, 2],
        [0, 2, 3],
      ]) {
        const A = corners[tri[0]];
        const B = corners[tri[1]];
        const Cc = corners[tri[2]];
        let nx = (B.y - A.y) * (Cc.z - A.z) - (B.z - A.z) * (Cc.y - A.y);
        let ny = (B.z - A.z) * (Cc.x - A.x) - (B.x - A.x) * (Cc.z - A.z);
        let nz = (B.x - A.x) * (Cc.y - A.y) - (B.y - A.y) * (Cc.x - A.x);
        if (ny < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
        const cx = (A.x + B.x + Cc.x) / 3;
        const cz = (A.z + B.z + Cc.z) / 3;
        const n = hash(cx, cz);
        // Moss on the gentler faces, bare rock on the steep ones.
        tint.copy(ny > 0.82 ? C.moss : C.rock).multiplyScalar(0.75 + 0.5 * n);
        const ids = [A, B, Cc].map((p) => kit.solid.vertex(p.x, p.y, p.z, nx, ny, nz, 0, 0, tint));
        kit.solid.triFacing(ids[0], ids[1], ids[2], nx, ny, nz);
      }
    }
  }
  // Headwalls: concrete faces at the portals from the vault (and the road beside it) up past the rock.
  const U = { x: t.ux, z: t.uz };
  for (const end of [-1, 1]) {
    const u = end * (t.half + 0.02);
    const y = boreRoad(world, t, u);
    const wallTop = TCFG.clearance + TCFG.slab + TCFG.portalCover + 0.7;
    const half = r.m1 + 1.5;
    const prof = vaultProfile(t, true, 12);
    const nx = U.x * end;
    const nz = U.z * end;
    bb.light = 0.18;
    // Over the opening: the vault edge up to the coping.
    for (let k = 0; k + 1 < prof.length; k++) {
      const p = prof[k];
      const q = prof[k + 1];
      frameWall(bb, t, u, p.v, u, q.v, y + p.y, y + wallTop, y + q.y, y + wallTop, C.concrete, nx, nz);
    }
    // Beside it: the walls' ends and the wing roots, road to coping.
    for (const side of [1, -1]) frameWall(bb, t, u, side * t.wall, u, side * half, y - 0.3, y + wallTop, y - 0.3, y + wallTop, C.concrete, nx, nz);
    // Coping band and the face's thickness.
    frameBox(kit.solid, t, Math.min(u, u + end * 0.6), Math.max(u, u + end * 0.6), -half, half, y + wallTop, y + wallTop, y + wallTop + 0.45, y + wallTop + 0.45, C.concreteDark);
    if (kit.quality !== 'low') {
      // LED line tracing the vault.
      for (let k = 0; k + 1 < prof.length; k++) {
        const p = prof[k];
        const q = prof[k + 1];
        const ue = u + end * 0.04;
        const pa = toWorld(t, ue, p.v);
        const qa = toWorld(t, ue, q.v);
        const ids = [kit.glow.vertex(pa.x, y + p.y - 0.12, pa.z, nx, 0, nz, 0, 0, LIGHT.led), kit.glow.vertex(qa.x, y + q.y - 0.12, qa.z, nx, 0, nz, 1, 0, LIGHT.led), kit.glow.vertex(qa.x, y + q.y, qa.z, nx, 0, nz, 1, 1, LIGHT.led), kit.glow.vertex(pa.x, y + p.y, pa.z, nx, 0, nz, 0, 1, LIGHT.led)];
        kit.glow.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
      }
    }
    for (const side of [1, -1]) frameBox(kit.glow, t, Math.min(u, u + end * 0.25), Math.max(u, u + end * 0.25), side * (t.wall + 0.9) - 0.25, side * (t.wall + 0.9) + 0.25, y + 3.6, y + 3.6, y + 4.05, y + 4.05, LIGHT.amber);
    const p = toWorld(t, u + end * 0.06, 0);
    signPanel(signs, p.x, y + TCFG.clearance + 1.75, p.z, nx, nz, 8, 2, nameCell(a.params.name ?? 0), col(0xffffff, 1.15));
  }
  // Trees on the gentler rock: anywhere over the bore, beside the cutting only back from its cliff.
  const area = 4 * reachU * reachV;
  const want = Math.round((area / 100) * TUN.treeDensity[kit.quality]);
  for (let k = 0; k < want; k++) {
    const u = rng.range(-reachU, reachU);
    const v = rng.range(-reachV, reachV);
    const over = Math.abs(u) < t.half - 3;
    if (!over && Math.abs(v) < r.m1 + 3) continue;
    const p = toWorld(r, u, v);
    const y = over ? rockAt(world, r, p.x, p.z) : world.heightAt(p.x, p.z);
    if (rise(p.x, p.z, over) < 2.5) continue;
    // Slope of the rock surface by finite differences (it is the terrain only off the bore).
    const e = 1;
    const q = toWorld(r, u + e, v);
    const o = toWorld(r, u, v + e);
    const gy = (over ? rockAt(world, r, q.x, q.z) : world.heightAt(q.x, q.z)) - y;
    const gv = (over ? rockAt(world, r, o.x, o.z) : world.heightAt(o.x, o.z)) - y;
    if (Math.hypot(gy, gv) / e > 0.75) continue;
    treeAt(kit, p.x, y, p.z, rng.range(1.6, 2.8), rng.range(6, 11), rng.next());
  }
}

/** A low poly tree standing at height y (kit.tree stands on the terrain, which is cut away over the bore). */
function treeAt(kit: DistrictKit, x: number, y: number, z: number, size: number, height: number, tint: number): void {
  cylinder(kit.solid, x, z, 0.28, y - 0.2, y + height * 0.45, 5, col(0x3a2c22), false);
  const leaf = col(0x1f4a2c, 0.8 + tint * 0.4);
  cylinder(kit.foliage, x, z, size, y + height * 0.35, y + height * 0.8, 6, leaf, true, size * 0.35);
  cylinder(kit.foliage, x, z, size * 0.7, y + height * 0.7, y + height, 6, leaf.clone().multiplyScalar(1.15), true, 0.05);
}
