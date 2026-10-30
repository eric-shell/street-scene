/**
 * Weekend special renderer: The Underground (city/districts/underground.ts).
 *
 * A lit concrete trench, drawn from the area's params and hints (the geometry is undergroundShape.ts, which the
 * sim's terrain uses too):
 *  - the retaining walls (the floor face of every plinth segment, banded and joined with a kerb on top) and
 *    the kerb's service face go into one baked mesh (structureFx BakedBuilder: sodium light baked on the vertices,
 *    nothing per frame) with the demolished window's end faces;
 *  - the floor (concrete, with a dashed centre line and edge lines), the service roads' asphalt (their inner edge
 *    follows the plinth, and the rubble's lip across the window) and the rubble itself drape on the terrain in
 *    the kit's ground and paint builders; the kicker is a steel-plated heap drawn over its terrain;
 *  - sodium wall lamps on the retaining walls every `lamps.spacing` m with an additive light wash on the floor under
 *    them, and lamp posts with an arm over each service road on the plinth tops (their light as a fainter wash);
 *  - overhead, render only and beyond any camera's reach in a race (no ceiling is registered: the lowest part,
 *    the footbridges' decks, stands 5.2 m over the service roads): two jet fan gantries, two footbridges on abutments
 *    (the sim's solids stand under them);
 *  - the hoarding along each service road's outer edge (the sim's one sided walls), plywood with posts, a
 *    cap, and works boards from the sign atlas (structureFx: ROAD CLOSED and DRIVE SAFE plates);
 *  - the stalled articulated bus (two bodies and a bellows, lit interior, dark glass, tail lamps) and the works
 *    vehicles parked along the hoarding (a truck, an excavator, a light tower), each the box of its solid.
 * Draw calls: the baked mesh, the wash (Medium and up) and the sign boards are one mesh each for the whole district;
 * everything else is appended to the kit's merged builders. Quality trims the lamp spacing, the washes and the clutter.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area } from '../../city/districts/types';
import { UNDERGROUND_HINT } from '../../city/districts/underground';
import { plinthWidthAt, undergroundLayout, undergroundShape } from '../../city/districts/undergroundShape';
import type { UndergroundLayout, UndergroundShape } from '../../city/districts/undergroundShape';
import type { Frame } from '../../city/districts/structures';
import { toWorld } from '../../city/districts/structures';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, groundVertex } from './kit';
import { BakedBuilder, CLOSED_CELL, bakedMaterial, boardCell, frameBox, frameCylinderU, frameWall, makeStructureSigns, signPanel } from './structureFx';
import { washMaterial } from '../materialFx';

const CFG = CITY.districts.underground;

const C = {
  floor: col(0x6f6e6a),
  centre: col(0xd9d6c8),
  edge: col(0xd9a520),
  asphalt: col(0x2b2c30),
  serviceLine: col(0xb9b6aa),
  rubble: col(0x6a6157),
  rubbleDark: col(0x4a443d),
  wallA: col(0x7a7872),
  wallB: col(0x6a6863),
  kick: col(0x2a2a2d),
  kerb: col(0x8b8982),
  kerbStripe: col(0xd9a520),
  steel: col(0x7d8186),
  steelDark: col(0x4b4f55),
  plate: col(0x8f9499),
  housing: col(0x1d1e22),
  ply: col(0xb59a68),
  plyDark: col(0x8f7849),
  busBody: col(0xe3a21c),
  busDark: col(0x1a232b),
  busBellows: col(0x151618),
  truck: col(0xe8e4dc),
  truckCab: col(0x2f5d9e),
  digger: col(0xe5b923),
  tower: col(0x3a3d42),
} as const;

const LIGHT = {
  sodium: col(0xffa040, 0.95),
  lamp: col(0xffb865, 1.5),
  interior: col(0xffe6b0, 0.7),
  tail: col(0xff2a1a, 1.4),
  work: col(0xfff2d8, 1.5),
  amber: col(0xffb020, 1.2),
} as const;
const SODIUM_WASH = new THREE.Color(0xffa040);

/** Baked light levels (0..1): the retaining wall under its lamps, the kerb, the plinth's service face. */
const BAKE = { wall: 0.55, kick: 0.25, kerb: 0.4, service: 0.3, end: 0.2 } as const;

/** Station positions from lo to hi about every `step` m, always both ends; finer where `fine(u)` says so. */
function stations(lo: number, hi: number, step: number, fine?: (u: number) => number): number[] {
  const out = [lo];
  let u = lo;
  while (u < hi - 1e-6) {
    u = Math.min(hi, u + (fine ? fine(u) : step));
    out.push(u);
  }
  return out;
}

/** A ribbon on the terrain: at every u, nv + 1 vertices from vLo(u) to vHi(u), quads between consecutive stations. */
function ribbon(kit: DistrictKit, gb: GeoBuilder, s: Frame, us: number[], vLo: (u: number) => number, vHi: (u: number) => number, nv: number, lift: number, color: THREE.Color): void {
  const rows: number[][] = [];
  for (const u of us) {
    const a = vLo(u);
    const b = vHi(u);
    const row: number[] = [];
    for (let j = 0; j <= nv; j++) {
      const p = toWorld(s, u, a + ((b - a) * j) / nv);
      row.push(groundVertex(kit, gb, p.x, p.z, lift, color));
    }
    rows.push(row);
  }
  for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < nv; j++) gb.quadFacing(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1], 0, 1, 0);
}

/** A frame turned `yaw` rad from the street's +u toward +v, centred at (u, v): for the boxes of the bus, the vehicles. */
function localFrame(s: UndergroundShape, u: number, v: number, yaw: number): Frame {
  const c = toWorld(s, u, v);
  const ax = Math.cos(yaw) * s.ux + Math.sin(yaw) * -s.uz;
  const az = Math.cos(yaw) * s.uz + Math.sin(yaw) * s.ux;
  return { cx: c.x, cz: c.z, ux: ax, uz: az };
}

export const undergroundRenderer: DistrictRenderer = {
  kinds: ['underground'],
  build(kit, areas) {
    const baked = new BakedBuilder();
    const wash = new GeoBuilder(true);
    const signs = new GeoBuilder(true);
    for (const a of areas) {
      if (!a.params.planned) continue;
      const s = undergroundShape(a);
      const lay = undergroundLayout(s);
      walls(kit, baked, a, s, lay);
      ground(kit, a, s, lay);
      lamps(kit, wash, s, lay);
      overhead(kit, s, lay);
      hoarding(kit, signs, s);
      vehicles(kit, a, s);
      kicker(kit, s, lay);
    }
    const add = (gb: GeoBuilder, name: string, mat: THREE.Material, order = 0) => {
      if (!gb.vertexCount) return;
      const m = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
      m.name = name;
      m.renderOrder = order;
      kit.group.add(m);
    };
    add(baked, 'undergroundWalls', bakedMaterial(LIGHT.sodium.clone().multiplyScalar(0.9)));
    add(wash, 'undergroundWash', washMaterial(), 1);
    if (signs.vertexCount) {
      const map = kit.track(makeStructureSigns(kit.world.seed));
      add(signs, 'undergroundSigns', new THREE.MeshBasicMaterial({ map, vertexColors: true }));
    }
  },
};

/** Terrain height at local (u, v). */
const heightAt = (kit: DistrictKit, s: Frame, u: number, v: number): number => {
  const p = toWorld(s, u, v);
  return kit.h(p.x, p.z);
};

/** The retaining walls: the floor face of each plinth segment banded, the kerb cap and its service face, the window's end faces. */
function walls(kit: DistrictKit, bb: BakedBuilder, a: Area, s: UndergroundShape, lay: UndergroundLayout): void {
  const F = s.road;
  const P = CFG.plinth;
  const kerb = CFG.kerb;
  const segs = kit.builds[a.id].hints.filter((h) => h.kind === UNDERGROUND_HINT.plinth);
  const V = { x: -s.uz, z: s.ux };
  for (const h of segs) {
    const [u0, u1, side] = h.values;
    const n = Math.max(1, Math.ceil((u1 - u0) / 3));
    for (let k = 0; k < n; k++) {
      const ua = u0 + ((u1 - u0) * k) / n;
      const ub = u0 + ((u1 - u0) * (k + 1)) / n;
      const fa = heightAt(kit, s, ua, side * (F - 0.3));
      const fb = heightAt(kit, s, ub, side * (F - 0.3));
      const ga = heightAt(kit, s, ua, side * (F + P + 1)) + kerb;
      const gb2 = heightAt(kit, s, ub, side * (F + P + 1)) + kerb;
      const tone = (Math.floor((ua + 400) / 3) & 1) === 0 ? C.wallA : C.wallB;
      // The floor face toward the street: a dark kick plate, then panels.
      bb.light = BAKE.kick;
      frameWall(bb, s, ua, side * F, ub, side * F, fa - 0.1, fa + 0.45, fb - 0.1, fb + 0.45, C.kick, -side * V.x, -side * V.z);
      bb.light = BAKE.wall;
      frameWall(bb, s, ua, side * F, ub, side * F, fa + 0.45, ga, fb + 0.45, gb2, tone, -side * V.x, -side * V.z);
      // The kerb cap, and the plinth's face to the service road.
      bb.light = BAKE.kerb;
      frameBox(bb, s, ua, ub, side * F, side * (F + P), ga, gb2, ga, gb2, C.kerb, { v0: false, v1: false, u0: false, u1: false, bottom: false });
      bb.light = BAKE.service;
      frameWall(bb, s, ua, side * (F + P), ub, side * (F + P), ga - kerb - 0.1, ga, gb2 - kerb - 0.1, gb2, C.kerb, side * V.x, side * V.z);
    }
    // The ends of a segment beside the window face the gap: the cut concrete.
    for (const u of [u0, u1]) {
      if (side !== s.sd || Math.abs(Math.abs(u - lay.window) - CFG.demolished.half) > 0.01) continue;
      const dn = u === u1 ? 1 : -1;
      const fl = heightAt(kit, s, u, side * (F - 0.3));
      const gr = heightAt(kit, s, u, side * (F + P + 1)) + kerb;
      bb.light = BAKE.end;
      frameWall(bb, s, u, side * F, u, side * (F + P), fl - 0.1, gr, fl - 0.1, gr, C.wallB, s.ux * dn, s.uz * dn);
    }
  }
}

/** The floor, the service roads, the rubble, their paint. */
function ground(kit: DistrictKit, a: Area, s: UndergroundShape, lay: UndergroundLayout): void {
  const F = s.road;
  const P = CFG.plinth;
  const T = s.top;
  const D = CFG.demolished;
  const kLo = Math.min(lay.foot.x, lay.lip.x) - 3;
  const kHi = Math.max(lay.foot.x, lay.lip.x) + 3;
  const floorUs = stations(-T, T, 3, (u) => (u > kLo && u < kHi ? 0.75 : 3));
  ribbon(kit, kit.ground, s, floorUs, () => -F, () => F, 4, 0.07, C.floor);
  // Lane paint: a dashed centre line, solid yellow edge lines a metre in from the walls.
  for (let u = -T + 2; u < T - 6; u += 9) {
    if (u > kLo - 3 && u < kHi + 3) continue;
    const dash = stations(u, u + 3, 1);
    for (let i = 0; i + 1 < dash.length; i++) {
      const p = toWorld(s, dash[i], 0);
      const q = toWorld(s, dash[i + 1], 0);
      groundSeg(kit, p, q, 0.18, 0.11, C.centre);
    }
  }
  for (const side of [1, -1]) {
    const us = stations(-T, T, 5);
    for (let i = 0; i + 1 < us.length; i++) {
      if (kit.quality === 'low' && i % 2) continue;
      groundSeg(kit, toWorld(s, us[i], side * (F - 1)), toWorld(s, us[i + 1], side * (F - 1)), 0.2, 0.11, C.edge);
    }
  }
  for (const side of [1, -1]) {
    const inner = (u: number) => side * (F + plinthWidthAt(s, lay.window, side, u));
    const outer = side * (F + P + CFG.service);
    const us = stations(-T, T, 5, (u) => (side === s.sd && Math.abs(u - lay.window) < D.half + 2 ? 1.5 : 5));
    ribbon(kit, kit.ground, s, us, inner, () => outer, 3, 0.13, C.asphalt);
    // Kerb line along the hoarding side.
    for (let i = 0; i + 1 < us.length; i += 2) groundSeg(kit, toWorld(s, us[i], side * (F + P + CFG.service - 0.6)), toWorld(s, us[Math.min(us.length - 1, i + 2)], side * (F + P + CFG.service - 0.6)), 0.16, 0.17, C.serviceLine);
  }
  // The rubble: the climb the plinth hid, widened across the window.
  const win = stations(lay.window - D.half, lay.window + D.half, 1.5);
  ribbon(kit, kit.ground, s, win, () => s.sd * F, (u) => s.sd * (F + plinthWidthAt(s, lay.window, s.sd, u)), 8, 0.14, C.rubble);
  ribbon(kit, kit.ground, s, win, (u) => s.sd * (F + 0.4 * plinthWidthAt(s, lay.window, s.sd, u)), (u) => s.sd * (F + 0.7 * plinthWidthAt(s, lay.window, s.sd, u)), 2, 0.16, C.rubbleDark);
  void a;
}

/** A flat strip on the ground from p to q (paint), lifted. */
function groundSeg(kit: DistrictKit, p: { x: number; z: number }, q: { x: number; z: number }, width: number, lift: number, color: THREE.Color): void {
  const len = Math.hypot(q.x - p.x, q.z - p.z);
  if (len < 0.05) return;
  const nx = (-(q.z - p.z) / len) * (width / 2);
  const nz = ((q.x - p.x) / len) * (width / 2);
  const gb = kit.paint;
  const v = [groundVertex(kit, gb, p.x + nx, p.z + nz, lift, color), groundVertex(kit, gb, q.x + nx, q.z + nz, lift, color), groundVertex(kit, gb, q.x - nx, q.z - nz, lift, color), groundVertex(kit, gb, p.x - nx, p.z - nz, lift, color)];
  gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
}

/** The kicker: steel road plates over the spoil heap, drawn on its terrain, with the lip's amber edge and the flanks' barriers. */
function kicker(kit: DistrictKit, s: UndergroundShape, lay: UndergroundLayout): void {
  const K = CFG.kicker;
  const hx = lay.heading.x;
  const hz = lay.heading.z;
  const at = (aa: number, bb: number) => toWorld(s, lay.foot.x + hx * aa - hz * bb, lay.foot.z + hz * aa + hx * bb);
  const half = K.width / 2;
  const R = lay.kickLength;
  // Plates: 1 m cells over the grade and the drop, alternating tone.
  const gb = kit.paint;
  const nA = Math.ceil(R + K.drop);
  const nB = Math.ceil(K.width / 1.1);
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      const a0 = (i * (R + K.drop)) / nA;
      const a1 = ((i + 1) * (R + K.drop)) / nA;
      const b0 = -half + (K.width * j) / nB;
      const b1 = -half + (K.width * (j + 1)) / nB;
      const color = (i + j) % 2 ? C.plate : C.steel;
      const ids = [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)].map((p) => groundVertex(kit, gb, p.x, p.z, 0.12, color));
      gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    }
  }
  // The lip's amber edge, and the flank barriers with a hazard lamp on each.
  groundSeg(kit, at(R, -half), at(R, half), 0.3, 0.16, col(0xffb020, 1.2));
  for (const side of [1, -1]) flank(kit, s, lay, side);
}

/** One flank barrier: a concrete box along the heap on the floor, with a blinking amber lamp at the lip end. */
function flank(kit: DistrictKit, s: UndergroundShape, lay: UndergroundLayout, side: number): void {
  const K = CFG.kicker;
  const b0 = K.width / 2 + K.flankGap;
  const b1 = b0 + K.flankWidth;
  const origin = toWorld(s, lay.foot.x, lay.foot.z);
  // The heading in the street's frame, as a world vector: the kicker's own frame (u along the heap, v across it).
  const ax = lay.heading.x * s.ux - lay.heading.z * s.uz;
  const az = lay.heading.x * s.uz + lay.heading.z * s.ux;
  const fr: Frame = { cx: origin.x, cz: origin.z, ux: ax, uz: az };
  const mid = toWorld(fr, lay.kickLength / 2, side * (b0 + K.flankWidth / 2));
  const y = kit.h(mid.x, mid.z);
  const lo = Math.min(side * b0, side * b1);
  const hi = Math.max(side * b0, side * b1);
  frameBox(kit.solid, fr, 2 + 3.5, lay.kickLength + 1 - 3.5, lo, hi, y - 0.3, y - 0.3, y + K.flankHeight, y + K.flankHeight, C.kerb);
  const lipEnd = toWorld(fr, lay.kickLength, side * (b0 + K.flankWidth / 2));
  const yl = kit.h(lipEnd.x, lipEnd.z);
  const lv = side * (b0 + K.flankWidth / 2);
  frameBox(kit.hazard, fr, lay.kickLength - 2.65, lay.kickLength - 2.35, lv - 0.12, lv + 0.12, yl + K.flankHeight, yl + K.flankHeight, yl + K.flankHeight + 0.22, yl + K.flankHeight + 0.22, LIGHT.amber);
}

/** Wall lamps on the retaining walls with their wash on the floor; service lamp posts on the plinth tops with a fainter wash. */
function lamps(kit: DistrictKit, wash: GeoBuilder, s: UndergroundShape, lay: UndergroundLayout): void {
  const L = CFG.lamps;
  const F = s.road;
  const P = CFG.plinth;
  const T = s.top;
  const step = kit.quality === 'low' ? L.spacing * 1.6 : L.spacing;
  const c = new THREE.Color();
  for (const side of [1, -1]) {
    const n = Math.floor((2 * T - 8) / step);
    for (let i = 0; i <= n; i++) {
      const u = -T + 4 + i * step + (side > 0 ? 0 : step / 2);
      if (u > T - 4) continue;
      if (side === s.sd && Math.abs(u - lay.window) < CFG.demolished.half + 1) continue;
      const y = heightAt(kit, s, u, side * (F - 0.3)) + L.wallHeight;
      const depth = Math.max(0, heightAt(kit, s, u, side * (F + P + 1)) - heightAt(kit, s, u, side * (F - 0.3)));
      // Only down in the trench: on the ramps' upper part the wall is too low to carry one.
      if (depth < L.wallHeight + 0.6) continue;
      const v = side * F;
      frameBox(kit.glow, s, u - 0.9, u + 0.9, v - side * 0.16, v - side * 0.02, y - 0.1, y - 0.1, y + 0.1, y + 0.1, LIGHT.lamp);
      frameBox(kit.solid, s, u - 1.05, u + 1.05, v - side * 0.2, v, y - 0.16, y - 0.16, y + 0.16, y + 0.16, C.housing, { bottom: false });
    }
  }
  if (kit.quality !== 'low') {
    // Floor wash: along both walls, brightest under each lamp, fading toward the lane centre.
    for (const side of [1, -1]) {
      const us = stations(-T, T, 1.5);
      const rows: number[][] = [];
      for (const u of us) {
        const row: number[] = [];
        const d0 = (((u + T - 4 - (side > 0 ? 0 : step / 2)) % step) + step) % step;
        const near = Math.max(0, 1 - Math.min(d0, step - d0) / (step * 0.45));
        for (const d of [0, 2.5, 6, 2 * F * 0.5 + 1]) {
          const p = toWorld(s, u, side * (F - Math.min(d, F * 1.6)));
          const level = (0.1 + 0.2 * near) * Math.max(0, 1 - d / (F * 1.7));
          c.copy(SODIUM_WASH).multiplyScalar(level);
          row.push(wash.vertex(p.x, kit.h(p.x, p.z) + 0.07, p.z, 0, 1, 0, 0, 0, c));
        }
        rows.push(row);
      }
      for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < 3; j++) wash.quadFacing(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1], 0, 1, 0);
    }
  }
  // Service lamp posts on the plinth tops, an arm over the road, a glowing head and a wash on the asphalt under it.
  for (const side of [1, -1]) {
    for (let u = -T + 8; u < T - 6; u += L.spacing * 2) {
      if (side === s.sd && Math.abs(u - lay.window) < CFG.demolished.half + 2) continue;
      const g = heightAt(kit, s, u, side * (F + P / 2)) + CFG.kerb;
      const v = side * (F + P / 2);
      frameBox(kit.solid, s, u - 0.12, u + 0.12, v - 0.12, v + 0.12, g, g, g + L.post, g + L.post, C.steelDark);
      const reach = side * (F + P / 2 + L.arm);
      frameBox(kit.solid, s, u - 0.07, u + 0.07, Math.min(v, reach), Math.max(v, reach), g + L.post - 0.1, g + L.post - 0.1, g + L.post + 0.04, g + L.post + 0.04, C.steelDark);
      frameBox(kit.glow, s, u - 0.35, u + 0.35, reach - 0.18, reach + 0.18, g + L.post - 0.2, g + L.post - 0.2, g + L.post - 0.1, g + L.post - 0.1, LIGHT.lamp);
      if (kit.quality !== 'low') {
        const mid = side * (F + P + CFG.service / 2);
        const q = toWorld(s, u, mid);
        c.copy(SODIUM_WASH).multiplyScalar(0.16);
        const dark = new THREE.Color(0, 0, 0);
        const ids = [toWorld(s, u - 4, mid - 3), toWorld(s, u + 4, mid - 3), toWorld(s, u + 4, mid + 3), toWorld(s, u - 4, mid + 3)].map((p) => wash.vertex(p.x, kit.h(p.x, p.z) + 0.07, p.z, 0, 1, 0, 0, 0, dark));
        const centre = wash.vertex(q.x, kit.h(q.x, q.z) + 0.07, q.z, 0, 1, 0, 0, 0, c);
        for (let k = 0; k < 4; k++) wash.triFacing(centre, ids[k], ids[(k + 1) % 4], 0, 1, 0);
      }
    }
  }
}

/** Jet fan gantries over the trench, and the two footbridges: render only, over every drivable level. */
function overhead(kit: DistrictKit, s: UndergroundShape, lay: UndergroundLayout): void {
  const F = s.road;
  const P = CFG.plinth;
  const Sw = CFG.service;
  for (const u of lay.gantries) {
    const gl = Math.max(heightAt(kit, s, u, F + P + 1), heightAt(kit, s, u, -(F + P + 1)));
    const top = gl + CFG.gantryHeight;
    const vL = F + P / 2;
    for (const side of [1, -1]) {
      const g = heightAt(kit, s, u, side * (F + P + 1)) + CFG.kerb;
      frameBox(kit.solid, s, u - 0.3, u + 0.3, side * vL - 0.3, side * vL + 0.3, g, g, top, top, C.steelDark);
    }
    frameBox(kit.solid, s, u - 0.4, u + 0.4, -vL - 0.3, vL + 0.3, top, top, top + 0.7, top + 0.7, C.steel);
    // Jet fans hung under the beam over each lane: a cylinder with an intake ring.
    for (const v of [-F * 0.5, F * 0.5]) {
      const y = top - 0.85;
      frameCylinderU(kit.solid, s, u - 1.8, u + 1.8, v, y, 0.6, 12, C.steel);
      frameBox(kit.solid, s, u - 0.1, u + 0.1, v - 0.07, v + 0.07, y + 0.5, y + 0.5, top, top, C.housing);
      frameBox(kit.glow, s, u + 1.7, u + 1.82, v - 0.35, v + 0.35, y - 0.2, y - 0.2, y + 0.2, y + 0.2, LIGHT.amber);
    }
  }
  const B = CFG.bridge;
  for (const u of lay.bridges) {
    const reach = F + P + Sw + B.abutOut + B.abut / 2;
    const gl = Math.max(heightAt(kit, s, u, reach), heightAt(kit, s, u, -reach));
    const y = gl + B.clear;
    // Deck, parapets, and the abutment towers (the sim's solids stand beneath each end).
    frameBox(kit.solid, s, u - B.width / 2, u + B.width / 2, -reach, reach, y, y, y + 0.55, y + 0.55, C.kerb);
    for (const sg of [-1, 1]) {
      const ue = u + (sg * B.width) / 2;
      frameBox(kit.solid, s, Math.min(ue, ue - sg * 0.1), Math.max(ue, ue - sg * 0.1), -reach, reach, y + 0.55, y + 0.55, y + 1.5, y + 1.5, C.steelDark);
    }
    for (const side of [1, -1]) {
      const g = heightAt(kit, s, u, side * reach);
      frameBox(kit.solid, s, u - B.abut / 2, u + B.abut / 2, side * (reach - B.abut / 2), side * (reach + B.abut / 2), g - 0.3, g - 0.3, y + 0.55, y + 0.55, C.wallA);
    }
    // Underside lamp, so the deck reads at night over the service roads.
    frameBox(kit.glow, s, u - 0.5, u + 0.5, -0.3, 0.3, y - 0.06, y - 0.06, y - 0.02, y - 0.02, LIGHT.sodium);
  }
}

/** Plywood hoarding along the outer edge of each service road, with posts, a cap, and works boards. */
function hoarding(kit: DistrictKit, signs: GeoBuilder, s: UndergroundShape): void {
  const F = s.road;
  const T = s.top;
  const v0 = F + CFG.plinth + CFG.service + 0.3;
  const V = { x: -s.uz, z: s.ux };
  const step = 2.4;
  const n = Math.floor((2 * T) / step);
  const white = col(0xffffff);
  for (const side of [1, -1]) {
    for (let i = 0; i < n; i++) {
      const ua = -T + i * step;
      const ub = ua + step;
      const ya = heightAt(kit, s, ua, side * v0);
      const yb = heightAt(kit, s, ub, side * v0);
      const color = i % 2 ? C.ply : C.plyDark;
      frameWall(kit.solid, s, ua, side * (v0 + 0.1), ub, side * (v0 + 0.1), ya - 0.2, ya + 2.3, yb - 0.2, yb + 2.3, color, -side * V.x, -side * V.z);
      frameBox(kit.solid, s, ua - 0.06, ua + 0.06, side * (v0 + 0.02), side * (v0 + 0.22), ya - 0.2, ya - 0.2, ya + 2.45, ya + 2.45, C.steelDark);
      if (i % 9 === 4) {
        const um = (ua + ub) / 2;
        const p = toWorld(s, um, side * (v0 - 0.02));
        const y = (ya + yb) / 2 + 1.5;
        signPanel(signs, p.x, y, p.z, -side * V.x, -side * V.z, 2.2, 0.55, i % 18 === 4 ? CLOSED_CELL : boardCell(1), white);
      }
    }
  }
}

/** The bus and the works vehicles, as boxes in their solids' frames. */
function vehicles(kit: DistrictKit, a: Area, s: UndergroundShape): void {
  for (const h of kit.builds[a.id].hints) {
    if (h.kind === UNDERGROUND_HINT.bus) {
      const [yaw, len, wid, height] = h.values;
      // The hint's centre is a world point: recover (u, v) in the street frame.
      const dx = h.points[0].x - s.cx;
      const dz = h.points[0].z - s.cz;
      const u = dx * s.ux + dz * s.uz;
      const v = -dx * s.uz + dz * s.ux;
      bus(kit, localFrame(s, u, v, yaw), len, wid, height);
    } else if (h.kind === UNDERGROUND_HINT.vehicle) {
      const [yaw, len, wid, height, type] = h.values;
      const dx = h.points[0].x - s.cx;
      const dz = h.points[0].z - s.cz;
      const u = dx * s.ux + dz * s.uz;
      const v = -dx * s.uz + dz * s.ux;
      const f = localFrame(s, u, v, yaw);
      const y = kit.h(f.cx, f.cz);
      if (type === 0) truck(kit, f, y, len, wid, height);
      else if (type === 1) digger(kit, f, y, len, wid, height);
      else lightTower(kit, f, y, len, wid);
    }
  }
}

function bus(kit: DistrictKit, f: Frame, len: number, wid: number, height: number): void {
  const y = kit.h(f.cx, f.cz);
  const hw = wid / 2;
  const bellows = 1.2;
  const body = (len - bellows) / 2;
  for (const sign of [-1, 1]) {
    const u0 = sign < 0 ? -len / 2 : bellows / 2;
    const u1 = u0 + body;
    frameBox(kit.solid, f, u0, u1, -hw, hw, y + 0.35, y + 0.35, y + height, y + height, C.busBody, { bottom: false });
    // Dark glass band, lit inside.
    frameBox(kit.solid, f, u0 + 0.2, u1 - 0.2, -hw - 0.02, hw + 0.02, y + 1.35, y + 1.35, y + 2.45, y + 2.45, C.busDark, { top: false, bottom: false, u0: false, u1: false });
    frameBox(kit.glow, f, u0 + 0.4, u1 - 0.4, -hw + 0.1, hw - 0.1, y + 2.38, y + 2.38, y + 2.42, y + 2.42, LIGHT.interior);
    frameBox(kit.solid, f, u0 + 0.5, u1 - 0.5, -hw + 0.05, hw - 0.05, y + 0.15, y + 0.15, y + 0.4, y + 0.4, C.busBellows);
  }
  frameBox(kit.solid, f, -bellows / 2, bellows / 2, -hw + 0.1, hw - 0.1, y + 0.4, y + 0.4, y + height - 0.3, y + height - 0.3, C.busBellows);
  // Tail lamps on the rear, a destination board on the front.
  frameBox(kit.glow, f, -len / 2 - 0.03, -len / 2 + 0.02, -hw + 0.2, -hw + 0.45, y + 0.9, y + 0.9, y + 1.1, y + 1.1, LIGHT.tail);
  frameBox(kit.glow, f, -len / 2 - 0.03, -len / 2 + 0.02, hw - 0.45, hw - 0.2, y + 0.9, y + 0.9, y + 1.1, y + 1.1, LIGHT.tail);
  frameBox(kit.glow, f, len / 2 - 0.02, len / 2 + 0.03, -hw + 0.5, hw - 0.5, y + height - 0.55, y + height - 0.55, y + height - 0.3, y + height - 0.3, LIGHT.amber);
}

function truck(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2, len / 2 - 1.9, -hw, hw, y + 0.5, y + 0.5, y + height, y + height, C.truck, { bottom: false });
  frameBox(kit.solid, f, len / 2 - 1.9, len / 2, -hw, hw, y + 0.5, y + 0.5, y + 2.1, y + 2.1, C.truckCab, { bottom: false });
  frameBox(kit.solid, f, -len / 2, len / 2, -hw + 0.1, hw - 0.1, y + 0.2, y + 0.2, y + 0.55, y + 0.55, C.housing);
  frameBox(kit.hazard, f, -0.3, 0.3, -0.12, 0.12, y + height, y + height, y + height + 0.18, y + height + 0.18, LIGHT.amber);
}

function digger(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2, len / 2, -hw, -hw + 0.7, y, y, y + 0.8, y + 0.8, C.housing);
  frameBox(kit.solid, f, -len / 2, len / 2, hw - 0.7, hw, y, y, y + 0.8, y + 0.8, C.housing);
  frameBox(kit.solid, f, -len / 2 + 0.5, len / 2 - 1.2, -hw + 0.2, hw - 0.2, y + 0.8, y + 0.8, y + 2.2, y + 2.2, C.digger);
  frameBox(kit.solid, f, len / 2 - 2.4, len / 2 - 1.2, -hw + 0.5, hw - 0.5, y + 2.2, y + 2.2, y + height, y + height, C.digger);
  // The boom folded back over the cab.
  frameBox(kit.solid, f, -len / 2 + 0.2, len / 2 - 0.4, -0.15, 0.15, y + height - 0.4, y + 2.0, y + height - 0.2, y + 2.2, C.steelDark);
}

function lightTower(kit: DistrictKit, f: Frame, y: number, len: number, wid: number): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2 + 0.5, len / 2 - 0.5, -hw + 0.3, hw - 0.3, y + 0.45, y + 0.45, y + 1.0, y + 1.0, C.tower);
  frameBox(kit.solid, f, -0.12, 0.12, -0.12, 0.12, y + 1.0, y + 1.0, y + 5.4, y + 5.4, C.steelDark);
  frameBox(kit.glow, f, -0.6, 0.6, -0.5, 0.5, y + 5.4, y + 5.4, y + 5.65, y + 5.65, LIGHT.work);
}
