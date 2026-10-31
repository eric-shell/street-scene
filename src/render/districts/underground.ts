/**
 * Weekend special renderer: The Underground (city/districts/underground.ts, undergroundShape.ts).
 *
 * A half-built cut-and-cover expressway at night, drawn from the site (undergroundShape.ts, the geometry the sim's
 * terrain and decks use) and the area's hints, all in the race's travel frame:
 *  - the ground: the trench floor (concrete, lane paint), the service roads' asphalt, the gravel verges, the plaza's
 *    concrete out to the ring, the works yards behind the hoardings (gravel and mud, spoil heaps, pipe stacks, parked
 *    plant: render only, fenced off), the rubble under the demolished windows, the kickers' steel plates, and the slick
 *    patches (the burst main's wet stretch, the mud at the spoil heap, the gallery's wet floor), each a darker sheen;
 *  - one baked mesh (structureFx BakedBuilder: sodium light baked on the vertices, nothing per frame) for the concrete:
 *    the retaining walls (every plinth piece's floor face, kerb and service face), the roof's slab (its deck, underside
 *    and edges), the portals' headwalls, the gallery's walls, the bridges' decks;
 *  - lights: sodium lamps on the retaining walls every `lamps.spacing` m with a wash on the floor (Medium and up), strip
 *    lights under the roof, work lights in the gallery, lamps on the hoarding posts over the service roads, the plaza's
 *    light towers;
 *  - the plant: the stalled bus, the trucks, excavators and light towers on the verges, the plaza's portakabins, tower
 *    crane, material stacks and crane mats, the gallery's pipes and cable trays, the footbridges, the jet fans under
 *    the roof, the Bailey bridges' trusses, the kickers' steel flanks, the hoardings with works boards from the sign
 *    atlas (no arrows: the lines read by light and surface).
 * Draw calls: the baked mesh, the wash (Medium and up) and the sign boards, one each for the whole district; everything
 * else is appended to the kit's merged builders. Quality trims the lamp spacing, the washes and the yards' dressing.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area, HeightSample } from '../../city/districts/types';
import { UG_SOLID, UNDERGROUND_HINT, footbridges, ringEnd, ringReach, yardHoardings } from '../../city/districts/underground';
import { regionFence, regionOf } from '../../city/districts/weekendRegion';
import {
  DECK_RIGHT,
  F,
  P_OUT,
  ROAD_OUT,
  VERGE_OUT,
  type Rect,
  type UgSite,
  bridgeDeck,
  bridgeLineS,
  climbWidth,
  toWorld as siteWorld,
  undergroundHeight,
  undergroundSite,
} from '../../city/districts/undergroundShape';
import type { Frame } from '../../city/districts/structures';
import { toWorld } from '../../city/districts/structures';
import { Rng, deriveSeed } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, groundVertex } from './kit';
import { BakedBuilder, CLOSED_CELL, bakedMaterial, boardCell, frameBox, frameCylinderU, frameWall, makeStructureSigns, signPanel } from './structureFx';
import { washMaterial } from '../materialFx';

const CFG = CITY.districts.underground;

const C = {
  floor: col(0x77756f),
  centre: col(0xd9d6c8),
  edge: col(0xd9a520),
  asphalt: col(0x2b2c30),
  serviceLine: col(0xb9b6aa),
  gravel: col(0x5d5850),
  gravelB: col(0x4c4741),
  mud: col(0x3a2f25),
  mudWet: col(0x1d1914),
  wet: col(0x2a3036),
  plaza: col(0x6c6b66),
  plazaB: col(0x5f5e5a),
  rubble: col(0x6a6157),
  rubbleDark: col(0x4a443d),
  wallA: col(0x7a7872),
  wallB: col(0x6a6863),
  kick: col(0x2a2a2d),
  kerb: col(0x8b8982),
  slab: col(0x5c5b57),
  soffit: col(0x45443f),
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
  cabin: col(0xdedad0),
  cabinB: col(0x9fb5c4),
  crane: col(0xe0b21e),
  timber: col(0x6e5434),
  pipe: col(0x8a6f58),
  pipeGrey: col(0x6d7177),
  hazard: col(0xd9a520),
  bailey: col(0x4f6b5a),
} as const;

const LIGHT = {
  sodium: col(0xffa040, 0.95),
  lamp: col(0xffb865, 1.5),
  strip: col(0xfff0d0, 1.4),
  interior: col(0xffe6b0, 0.7),
  tail: col(0xff2a1a, 1.4),
  work: col(0xfff2d8, 1.5),
  amber: col(0xffb020, 1.2),
  window: col(0xffd890, 0.9),
} as const;
const SODIUM_WASH = new THREE.Color(0xffa040);
const WHITE_WASH = new THREE.Color(0xfff0d8);

/** Baked light levels (0..1). */
const BAKE = { wall: 0.55, kick: 0.25, kerb: 0.4, service: 0.3, end: 0.2, soffit: 0.32, slab: 0.22, gallery: 0.4, deck: 0.18 } as const;

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

/** The scene's view of a site: frame, heights. */
interface View {
  kit: DistrictKit;
  a: Area;
  s: UgSite;
  /** The travel frame as a structures.ts Frame (frameBox and frameWall work in it directly). */
  f: Frame;
  rng: Rng;
  /** Terrain (the lower level), grade (the terrain less the site's profile) and the top level (a deck where there is one). */
  floor(s: number, w: number): number;
  grade(s: number, w: number): number;
  top(s: number, w: number): number;
  /** The underside of whatever deck covers the trench band at s: the roof's slab, a bridge's deck (m). */
  soffit(s: number, w: number): number;
}

function viewOf(kit: DistrictKit, a: Area): View {
  const s = undergroundSite(a);
  const f: Frame = { cx: s.cx, cz: s.cz, ux: s.dir * s.ux, uz: s.dir * s.uz };
  const own: HeightSample = { h: 0, gx: 0, gz: 0 };
  return {
    kit,
    a,
    s,
    f,
    rng: new Rng(deriveSeed(a.params.seed, 'underground:render')),
    floor: (u, w) => {
      const p = siteWorld(s, u, w);
      return kit.h(p.x, p.z);
    },
    grade: (u, w) => {
      const p = siteWorld(s, u, w);
      own.h = 0;
      own.gx = 0;
      own.gz = 0;
      undergroundHeight(s, p.x, p.z, own);
      return kit.h(p.x, p.z) - own.h;
    },
    top: (u, w) => {
      const p = siteWorld(s, u, w);
      return kit.world.heightAt(p.x, p.z, 1e4);
    },
    soffit(u, w) {
      return Math.abs(u) <= s.R + 0.5 ? this.grade(u, w) - CFG.roof.slab : this.grade(u, w) + CFG.bridge.rise - 0.7;
    },
  };
}

export const undergroundRenderer: DistrictRenderer = {
  kinds: ['underground'],
  build(kit, areas) {
    const baked = new BakedBuilder();
    const wash = new GeoBuilder(true);
    const signs = new GeoBuilder(true);
    for (const a of areas) {
      if (!a.params.planned || !regionOf(a)) continue;
      const v = viewOf(kit, a);
      ground(v);
      yards(v, wash);
      walls(v, baked);
      roof(v, baked);
      gallery(v, baked, wash);
      bridges(v, baked);
      kickers(v);
      lamps(v, wash);
      hoardings(v, signs, wash);
      plant(v, wash);
      overhead(v);
      regionHoarding(kit, a);
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

/** A ribbon on the terrain (or `height`): at every s, nv + 1 vertices from lo(s) to hi(s), quads between consecutive stations. */
function ribbon(v: View, gb: GeoBuilder, us: number[], lo: (s: number) => number, hi: (s: number) => number, nv: number, lift: number, color: THREE.Color | ((s: number, w: number) => THREE.Color), height?: (s: number, w: number) => number): void {
  const rows: number[][] = [];
  const kit = v.kit;
  for (const u of us) {
    const a = lo(u);
    const b = hi(u);
    const row: number[] = [];
    for (let j = 0; j <= nv; j++) {
      const w = a + ((b - a) * j) / nv;
      const p = siteWorld(v.s, u, w);
      const c = typeof color === 'function' ? color(u, w) : color;
      row.push(height ? gb.vertex(p.x, height(u, w) + lift, p.z, 0, 1, 0, p.x / 4, p.z / 4, c) : groundVertex(kit, gb, p.x, p.z, lift, c));
    }
    rows.push(row);
  }
  for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < nv; j++) gb.quadFacing(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1], 0, 1, 0);
}

/** A flat strip on the ground from (s0, w0) to (s1, w1) (paint), lifted. */
function strip(v: View, s0: number, w0: number, s1: number, w1: number, width: number, lift: number, color: THREE.Color): void {
  const p = siteWorld(v.s, s0, w0);
  const q = siteWorld(v.s, s1, w1);
  const len = Math.hypot(q.x - p.x, q.z - p.z);
  if (len < 0.05) return;
  const nx = (-(q.z - p.z) / len) * (width / 2);
  const nz = ((q.x - p.x) / len) * (width / 2);
  const gb = v.kit.paint;
  const k = v.kit;
  const ids = [groundVertex(k, gb, p.x + nx, p.z + nz, lift, color), groundVertex(k, gb, q.x + nx, q.z + nz, lift, color), groundVertex(k, gb, q.x - nx, q.z - nz, lift, color), groundVertex(k, gb, p.x - nx, p.z - nz, lift, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
}

/** A patch of paint over a rectangle (travel frame), subdivided to follow the ground. */
function patch(v: View, r: Rect, lift: number, color: THREE.Color): void {
  ribbon(v, v.kit.paint, stations(r.s0, r.s1, 1.5), () => r.w0, () => r.w1, Math.max(1, Math.ceil((r.w1 - r.w0) / 1.5)), lift, color);
}

/** Ground and paint: floor, roads, verges, funnels, plaza, rubble, slick patches. */
function ground(v: View): void {
  const { s, kit } = v;
  const { top, R } = s;
  const near = (u: number) => s.kickers.some((k) => u > Math.min(k.footS, k.lipS) - 3 && u < k.lipS + CFG.kicker.drop + 3) || s.bridges.some((b) => Math.abs(u - b.s) < 26);
  const fine = (u: number) => (near(u) ? 0.75 : 3);
  // The floor, concrete, and its paint: a dashed centre line, yellow edge lines.
  ribbon(v, kit.ground, stations(-top, top, 3, fine), () => -F, () => F, 4, 0.06, C.floor);
  for (let u = -top + 4; u < top - 6; u += 9) {
    if (near(u) || near(u + 3)) continue;
    strip(v, u, 0, u + 3, 0, 0.18, 0.1, C.centre);
  }
  for (const side of [1, -1]) {
    const us = stations(-top, top, 5, fine);
    for (let i = 0; i + 1 < us.length; i++) if (!(kit.quality === 'low' && i % 2)) strip(v, us[i], side * (F - 0.8), us[i + 1], side * (F - 0.8), 0.2, 0.1, C.edge);
  }
  // The service roads (asphalt) in the open and the left one under the roof, the verges, and their kerb line; the right road under
  // the roof is the deck's (roof()).
  const D = CFG.demolished;
  for (const side of [1, -1]) {
    const spans: [number, number][] = side > 0 ? [[-top, -R], [R, top]] : [[-top, top]];
    for (const [lo, hi] of spans) {
      const us = stations(lo, hi, 5, (u) => (fine(u) < 3 || (side > 0 && s.windows.some((c) => Math.abs(u - c) < D.half + 2)) ? 1 : 5));
      const inner = (u: number) => side * (F + Math.max(CFG.plinth, climbWidth(s, side, u)));
      ribbon(v, kit.ground, us, inner, () => side * ROAD_OUT, 3, 0.08, C.asphalt);
      for (let i = 0; i + 1 < us.length; i += 2) strip(v, us[i], side * (ROAD_OUT - 0.5), us[Math.min(us.length - 1, i + 2)], side * (ROAD_OUT - 0.5), 0.15, 0.12, C.serviceLine);
    }
    ribbon(v, kit.ground, stations(-top, top, 6), () => side * ROAD_OUT, () => side * VERGE_OUT, 1, 0.07, (u, w) => ((Math.floor(u / 6) + Math.floor(w)) & 1 ? C.gravel : C.gravelB));
  }
  // The funnels between the ring's mouths and the ramp tops: the approach street's asphalt fanning out onto both roads.
  const poly = regionOf(v.a)!.polygon;
  for (const end of [-1, 1]) {
    for (const side of [1, -1]) {
      const ring = ringEnd(s, poly, end, side * (F + 1));
      const a = end < 0 ? ring + 0.5 : end * top;
      const b = end < 0 ? -top : ring - 0.5;
      if (b - a < 1) continue;
      ribbon(v, kit.ground, stations(a, b, 2), () => side * F, () => side * ROAD_OUT, 3, 0.07, C.asphalt);
    }
  }
  // The rubble under the windows.
  for (const c of s.windows) {
    const us = stations(c - D.half, c + D.half, 1.5);
    ribbon(v, kit.ground, us, () => F, (u) => F + climbWidth(s, 1, u), 8, 0.12, C.rubble);
    ribbon(v, kit.ground, us, (u) => F + 0.4 * climbWidth(s, 1, u), (u) => F + 0.7 * climbWidth(s, 1, u), 2, 0.14, C.rubbleDark);
  }
  // The slick patches: the burst main's wet stretch, the mud at the spoil heap; the gallery's wet floor is drawn with the gallery.
  patch(v, s.burst, 0.11, C.wet);
  patch(v, s.mud, 0.11, C.mud);
  patch(v, { ...s.mud, s0: s.mud.s0 + 2, s1: s.mud.s1 - 3, w0: s.mud.w0 + 1, w1: s.mud.w1 - 1.5 }, 0.13, C.mudWet);
}

/** The plaza's concrete and the works yards out to the ring, with the yards' render-only dressing. */
function yards(v: View, wash: GeoBuilder): void {
  const { s, kit, rng } = v;
  const poly = regionOf(v.a)!.polygon;
  const R = s.R;
  const reach = (u: number, side: number) => side * (VERGE_OUT + Math.max(0, ringReach(s, poly, u, side * VERGE_OUT, 0, side) - 0.2));
  // The plaza: concrete slabs from the verge (left) and the deck's edge (right) out to the ring.
  for (const side of [1, -1]) {
    const inner = side > 0 ? DECK_RIGHT : VERGE_OUT;
    ribbon(v, kit.ground, stations(-R, R, 6), () => side * (side > 0 ? DECK_RIGHT : VERGE_OUT), (u) => reach(u, side), 10, 0.06, (u, w) => ((Math.floor((u + 400) / 6) + Math.floor((w + 400) / 6)) & 1 ? C.plaza : C.plazaB));
    void inner;
    // Left verge under the roof is the plaza's too (the right one is past the deck's edge: [DECK_RIGHT, VERGE_OUT] is drawn above).
    if (side > 0) ribbon(v, kit.ground, stations(-R, R, 6), () => DECK_RIGHT, () => VERGE_OUT, 1, 0.065, C.plazaB);
  }
  // The yards: gravel and mud from the hoarding out to the ring, both open sections and the ends; render only (fenced off).
  for (const side of [1, -1]) {
    for (const end of [-1, 1]) {
      const sR = end * R;
      const sE = ringEnd(s, poly, end, side * (VERGE_OUT + 2));
      const lo = Math.min(sR, sE);
      const hi = Math.max(sR, sE);
      const us = stations(lo + 0.3, hi - 0.3, 8);
      ribbon(v, kit.ground, us, () => side * (VERGE_OUT + 0.3), (u) => reach(u, side), 8, 0.05, (u, w) => {
        const n = Math.sin(u * 0.13 + w * 0.21) + Math.sin(u * 0.047 - w * 0.09);
        return n > 0.9 ? C.mud : n > 0 ? C.gravel : C.gravelB;
      });
      // Light masts down the yard behind the hoarding (render only: fenced off), a pool of white under each.
      for (let u = lo + 14; u < hi - 8; u += 42) {
        const outer = Math.abs(reach(u, side));
        if (outer - VERGE_OUT < 10) continue;
        // A row near the hoarding and, where the yard is deep, a second row out toward the ring.
        const offs = [Math.min(14, (outer - VERGE_OUT) / 2)];
        if (outer - VERGE_OUT > 48) offs.push((outer - VERGE_OUT) * 0.68);
        for (const off of offs) {
          const uu = off > 20 ? u + 21 : u;
          if (uu > hi - 8) continue;
          const w = side * (VERGE_OUT + off);
          mast(kit, localFrame(v, uu, w, 0), v.floor(uu, w), 1.2, 13);
          if (kit.quality !== 'low') pool(v, wash, uu, w, 16, 0.2, WHITE_WASH);
        }
      }
      // Dressing: spoil heaps, pipe stacks, cabins and parked plant, scattered over the yard.
      const count = kit.quality === 'low' ? 6 : kit.quality === 'medium' ? 14 : 22;
      for (let k = 0; k < count; k++) {
        const u = rng.range(lo + 6, hi - 6);
        const outer = Math.abs(reach(u, side));
        if (outer - VERGE_OUT < 12) continue;
        const w = side * rng.range(VERGE_OUT + 5, outer - 5);
        const y = v.floor(u, w);
        const kind = rng.int(0, 3);
        const yaw = rng.chance(0.5) ? 0 : Math.PI / 2;
        const fr = localFrame(v, u, w, yaw);
        if (kind === 0) mound(kit, fr, y, rng.range(5, 9), rng.range(3, 6), rng.range(1.5, 3.2));
        else if (kind === 1) pipeStack(kit, fr, y, rng.int(3, 5));
        else if (kind === 2) cabin(kit, fr, y, 6, 2.5, 2.6, rng.chance(0.6));
        else truck(kit, fr, y, 6.2, 2.4, 2.8);
      }
    }
  }
}

/** A frame turned `yaw` rad from the travel +s toward +w, centred at (s, w). */
function localFrame(v: View, s: number, w: number, yaw: number): Frame {
  const c = siteWorld(v.s, s, w);
  const ax = Math.cos(yaw) * v.f.ux + Math.sin(yaw) * -v.f.uz;
  const az = Math.cos(yaw) * v.f.uz + Math.sin(yaw) * v.f.ux;
  return { cx: c.x, cz: c.z, ux: ax, uz: az };
}

/** A quad of four (s, w, y) points in the baked builder, facing (nx, nz) in the travel frame (0, 0 for up). */
function quad3(v: View, gb: GeoBuilder, pts: [number, number, number][], color: THREE.Color, ns: number, nw: number, ny = 0): void {
  const n = { x: v.f.ux * ns - v.f.uz * nw, z: v.f.uz * ns + v.f.ux * nw };
  const ids = pts.map(([u, w, y]) => {
    const p = toWorld(v.f, u, w);
    return gb.vertex(p.x, y, p.z, n.x, ny, n.z, 0, 0, color);
  });
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], n.x, ny, n.z);
}

/** The retaining walls: each plinth piece's floor face (kick plate and panels), kerb cap and service face; the roof's walls to the soffit. */
function walls(v: View, bb: BakedBuilder): void {
  const { s, kit } = v;
  for (const h of kit.builds[v.a.id].hints) {
    if (h.kind !== UNDERGROUND_HINT.plinth) continue;
    const [kind, side, i0, o0, i1, o1, width] = h.values;
    const n = Math.max(1, Math.ceil(Math.abs(i1 - i0) / 3));
    for (let k = 0; k < n; k++) {
      const ia = i0 + ((i1 - i0) * k) / n;
      const ib = i0 + ((i1 - i0) * (k + 1)) / n;
      const oa = o0 + ((o1 - o0) * k) / n;
      const ob = o0 + ((o1 - o0) * (k + 1)) / n;
      const wi = side * F;
      const wo = side * (F + width);
      const fa = v.floor(ia, side * (F - 0.3));
      const fb = v.floor(ib, side * (F - 0.3));
      // The top: the kerb over grade in the open, the soffit under a deck.
      const topAt = (u: number) => (kind ? v.soffit(u, side * (F + width / 2)) : v.grade(u, side * (F + width + 1)) + CFG.kerb);
      const ta = topAt(ia);
      const tb = topAt(ib);
      const tone = (Math.floor((ia + 400) / 3) & 1) === 0 ? C.wallA : C.wallB;
      bb.light = BAKE.kick;
      quad3(v, bb, [[ia, wi, fa - 0.1], [ib, wi, fb - 0.1], [ib, wi, fb + 0.45], [ia, wi, fa + 0.45]], C.kick, 0, -side);
      bb.light = kind ? BAKE.soffit : BAKE.wall;
      quad3(v, bb, [[ia, wi, fa + 0.45], [ib, wi, fb + 0.45], [ib, wi, tb], [ia, wi, ta]], tone, 0, -side);
      if (!kind) {
        bb.light = BAKE.kerb;
        quad3(v, bb, [[ia, wi, ta], [ib, wi, tb], [ob, wo, tb], [oa, wo, ta]], C.kerb, 0, 0, 1);
        bb.light = BAKE.service;
        quad3(v, bb, [[oa, wo, ta - CFG.kerb - 0.1], [ob, wo, tb - CFG.kerb - 0.1], [ob, wo, tb], [oa, wo, ta]], C.kerb, 0, side);
        // Hazard stripes along the kerb's lip over the floor.
        if (k % 2 === 0) quad3(v, kit.paint, [[ia, wi + side * 0.05, ta + 0.01], [ib, wi + side * 0.05, tb + 0.01], [ib, wi + side * 0.3, tb + 0.01], [ia, wi + side * 0.3, ta + 0.01]], C.hazard, 0, 0, 1);
      } else if (width > CFG.plinth + 0.1) {
        // The wall's gallery face, from the gallery's floor to the soffit.
        const ga = v.floor(oa, side * (F + width + 0.4));
        const gbb = v.floor(ob, side * (F + width + 0.4));
        bb.light = BAKE.gallery;
        quad3(v, bb, [[oa, wo, ga - 0.1], [ob, wo, gbb - 0.1], [ob, wo, tb], [oa, wo, ta]], C.wallB, 0, side);
      }
    }
    // The cut ends facing a window's gap or a passage: bare concrete.
    for (const [u, w0, w1, dn] of [
      [i0, o0, 0, -1],
      [i1, o1, 0, 1],
    ]) {
      void w1;
      const gapNear = s.windows.some((c) => Math.abs(Math.abs(u - c) - CFG.demolished.half) < 0.01) || (kind && width > CFG.plinth + 0.1 && Math.abs(u) < s.R - 0.5);
      if (!gapNear) continue;
      const fl = v.floor(u, side * (F - 0.3));
      const tp = kind ? v.soffit(u, side * F) : v.grade(u, side * (F + width + 1)) + CFG.kerb;
      bb.light = BAKE.end;
      quad3(v, bb, [[u, side * F, fl - 0.1], [w0, side * (F + width), fl - 0.1], [w0, side * (F + width), tp], [u, side * F, tp]], C.wallB, dn, 0);
    }
  }
}

/** The roof: the deck's top (plaza concrete, the right road's asphalt over the gallery), its soffit, its edges at the openings and portals; the headwalls; the openings' hoardings. */
function roof(v: View, bb: BakedBuilder): void {
  const { s, kit } = v;
  const slab = CFG.roof.slab;
  for (const d of s.decks) {
    const us = stations(d.s0, d.s1, 4);
    const nv = Math.max(1, Math.ceil((d.w1 - d.w0) / 3));
    // The top, draped on the deck's own height, the right road's asphalt where it crosses.
    ribbon(v, kit.ground, us, () => d.w0, () => d.w1, nv, 0.04, (_u, w) => (w > P_OUT - 0.01 && w < ROAD_OUT + 0.01 ? C.asphalt : C.slab), v.grade);
    // The soffit, baked: dark concrete lit from the wall lamps below.
    bb.light = BAKE.soffit;
    const rows: number[][] = [];
    for (const u of us) {
      const row: number[] = [];
      for (let j = 0; j <= nv; j++) {
        const w = d.w0 + ((d.w1 - d.w0) * j) / nv;
        const p = siteWorld(s, u, w);
        row.push(bb.vertex(p.x, v.grade(u, w) - slab, p.z, 0, -1, 0, 0, 0, C.soffit));
      }
      rows.push(row);
    }
    for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < nv; j++) bb.quadFacing(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1], 0, -1, 0);
  }
  // The slab's edges round the openings and at the portals.
  bb.light = BAKE.slab;
  const edge = (u0: number, w0: number, u1: number, w1: number, ns: number, nw: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(u1 - u0, w1 - w0) / 4));
    for (let k = 0; k < n; k++) {
      const ua = u0 + ((u1 - u0) * k) / n;
      const ub = u0 + ((u1 - u0) * (k + 1)) / n;
      const wa = w0 + ((w1 - w0) * k) / n;
      const wb = w0 + ((w1 - w0) * (k + 1)) / n;
      const ta = v.grade(ua, wa);
      const tb = v.grade(ub, wb);
      quad3(v, bb, [[ua, wa, ta - slab], [ub, wb, tb - slab], [ub, wb, tb], [ua, wa, ta]], C.slab, ns, nw);
    }
  };
  for (const o of s.openings) {
    edge(o.s0, o.w0, o.s0, o.w1, 1, 0);
    edge(o.s1, o.w0, o.s1, o.w1, -1, 0);
    edge(o.s0, o.w0, o.s1, o.w0, 0, 1);
    edge(o.s0, o.w1, o.s1, o.w1, 0, -1);
    // Plywood hoarding on three sides, a hazard rail on the open end's slab edge.
    const H = CFG.roof.hoarding;
    const sides: [number, number, number, number, boolean][] = [
      [o.s0 - 0.15, o.w0 - 0.15, o.s0 - 0.15, o.w1 + 0.15, o.open === -1],
      [o.s1 + 0.15, o.w0 - 0.15, o.s1 + 0.15, o.w1 + 0.15, o.open === 1],
      [o.s0, o.w0 - 0.15, o.s1, o.w0 - 0.15, false],
      [o.s0, o.w1 + 0.15, o.s1, o.w1 + 0.15, false],
    ];
    for (const [u0, w0, u1, w1, open] of sides) {
      const len = Math.hypot(u1 - u0, w1 - w0);
      const n = Math.max(1, Math.round(len / 2.4));
      for (let k = 0; k < n; k++) {
        const ua = u0 + ((u1 - u0) * k) / n;
        const ub = u0 + ((u1 - u0) * (k + 1)) / n;
        const wa = w0 + ((w1 - w0) * k) / n;
        const wb = w0 + ((w1 - w0) * (k + 1)) / n;
        const ya = v.grade(ua, wa);
        const yb = v.grade(ub, wb);
        if (open) {
          if (k % 2 === 0) frameBox(kit.solid, v.f, Math.min(ua, ub) - 0.06, Math.max(ua, ub) + 0.06, Math.min(wa, wb) - 0.06, Math.max(wa, wb) + 0.06, ya, yb, ya + 0.08, yb + 0.08, C.hazard);
          continue;
        }
        const nn = u0 === u1 ? [1, 0] : [0, 1];
        quad3(v, kit.solid, [[ua, wa, ya], [ub, wb, yb], [ub, wb, yb + H], [ua, wa, ya + H]], k % 2 ? C.ply : C.plyDark, nn[0], nn[1]);
        quad3(v, kit.solid, [[ua, wa, ya], [ub, wb, yb], [ub, wb, yb + H], [ua, wa, ya + H]], k % 2 ? C.ply : C.plyDark, -nn[0], -nn[1]);
        frameBox(kit.solid, v.f, ua - 0.06, ua + 0.06, wa - 0.06, wa + 0.06, ya, ya, ya + H + 0.15, ya + H + 0.15, C.steelDark);
      }
    }
  }
  // The portals: the slab's end face over the trench and the headwall parapet on the deck, hazard chevrons along its face.
  for (const end of [-1, 1]) {
    const u = end * s.R;
    const n = 8;
    for (let k = 0; k < n; k++) {
      const wa = -P_OUT + (2 * P_OUT * k) / n;
      const wb = -P_OUT + (2 * P_OUT * (k + 1)) / n;
      const ya = v.grade(u, wa);
      const yb = v.grade(u, wb);
      bb.light = BAKE.slab;
      quad3(v, bb, [[u, wa, ya - slab - 0.4], [u, wb, yb - slab - 0.4], [u, wb, yb + CFG.roof.parapet], [u, wa, ya + CFG.roof.parapet]], C.slab, end, 0);
      frameBox(kit.solid, v.f, end < 0 ? u : u - 0.4, end < 0 ? u + 0.4 : u, wa, wb, ya, yb, ya + CFG.roof.parapet, yb + CFG.roof.parapet, C.kerb, { bottom: false });
      if (k % 2 === 0) quad3(v, kit.paint, [[u - end * 0.02, wa, ya - slab - 0.35], [u - end * 0.02, wb, yb - slab - 0.35], [u - end * 0.02, wb, yb - slab + 0.05], [u - end * 0.02, wa, ya - slab + 0.05]], C.hazard, end, 0);
    }
  }
}

/** The gallery: outer and end walls to the soffit, the pipes and cable trays, work lights and their pools, the wet floor. */
function gallery(v: View, bb: BakedBuilder, wash: GeoBuilder): void {
  const { s, kit } = v;
  const G = CFG.gallery;
  const g = s.gallery;
  const slab = CFG.roof.slab;
  // Floor: concrete ribbon on the terrain (the gallery's own floor), the wet patch on it.
  ribbon(v, kit.ground, stations(g.s0, g.s1, 3), () => G.inner, () => G.outer, 3, 0.06, C.floor);
  patch(v, s.wet, 0.1, C.wet);
  for (const p of g.passages) {
    const us = stations(0, p.len, 2);
    const rows: number[][] = [];
    for (const a of us) {
      const row: number[] = [];
      for (const q of [-G.passageHalf, 0, G.passageHalf]) {
        const pt = siteWorld(s, p.ps + a * p.ds - q * p.dw, p.pw + a * p.dw + q * p.ds);
        row.push(groundVertex(kit, kit.ground, pt.x, pt.z, 0.065, C.floor));
      }
      rows.push(row);
    }
    for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < 2; j++) kit.ground.quadFacing(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1], 0, 1, 0);
  }
  bb.light = BAKE.gallery;
  for (const u of stations(g.s0 - G.wall, g.s1 + G.wall, 4).slice(0, -1)) {
    const ub = Math.min(g.s1 + G.wall, u + 4);
    const fa = v.floor(u, G.outer - 0.4);
    const fb = v.floor(ub, G.outer - 0.4);
    quad3(v, bb, [[u, G.outer, fa - 0.1], [ub, G.outer, fb - 0.1], [ub, G.outer, v.grade(ub, G.outer) - slab], [u, G.outer, v.grade(u, G.outer) - slab]], C.wallA, 0, -1);
  }
  for (const [u, dn] of [
    [g.s0, 1],
    [g.s1, -1],
  ]) {
    const n = 3;
    for (let k = 0; k < n; k++) {
      const wa = G.inner + ((G.outer - G.inner) * k) / n;
      const wb = G.inner + ((G.outer - G.inner) * (k + 1)) / n;
      quad3(v, bb, [[u, wa, v.floor(u + dn * 0.4, wa) - 0.1], [u, wb, v.floor(u + dn * 0.4, wb) - 0.1], [u, wb, v.grade(u, wb) - slab], [u, wa, v.grade(u, wa) - slab]], C.wallB, dn, 0);
    }
  }
  // Caged work lights hung from the soffit down the gallery's middle every 8 m, a pool of light under each (Medium and up).
  const step = kit.quality === 'low' ? 14 : 8;
  const mid = (G.inner + G.outer) / 2;
  for (let u = g.s0 + 3; u < g.s1 - 2; u += step) {
    const y = v.grade(u, mid) - slab - 0.35;
    frameBox(kit.solid, v.f, u - 0.03, u + 0.03, mid - 0.03, mid + 0.03, y + 0.2, y + 0.2, y + 0.35, y + 0.35, C.steelDark);
    frameBox(kit.glow, v.f, u - 0.3, u + 0.3, mid - 0.12, mid + 0.12, y, y, y + 0.2, y + 0.2, LIGHT.work);
    if (kit.quality !== 'low') pool(v, wash, u, (G.inner + G.outer) / 2, 3.2, 0.18, WHITE_WASH, true);
  }
}

/** A disc of additive light on the top level at (s, w) (a deck where there is one), or on the terrain beneath (`lower`). */
function pool(v: View, wash: GeoBuilder, u: number, w: number, r: number, level: number, color: THREE.Color, lower = false): void {
  const c = color.clone().multiplyScalar(level);
  const dark = new THREE.Color(0, 0, 0);
  const h = (uu: number, ww: number) => (lower ? v.floor(uu, ww) : v.top(uu, ww)) + 0.08;
  const p = siteWorld(v.s, u, w);
  const centre = wash.vertex(p.x, h(u, w), p.z, 0, 1, 0, 0, 0, c);
  const n = 10;
  const ring: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const uu = u + Math.cos(a) * r;
    const ww = w + Math.sin(a) * r;
    const q = siteWorld(v.s, uu, ww);
    ring.push(wash.vertex(q.x, h(uu, ww), q.z, 0, 1, 0, 0, 0, dark));
  }
  for (let k = 0; k < n; k++) wash.triFacing(centre, ring[k], ring[(k + 1) % n], 0, 1, 0);
}

/** The Bailey bridges: deck plates over the trench (baked), the side trusses and the parapet rails, a lamp under each. */
function bridges(v: View, bb: BakedBuilder): void {
  const { s, kit } = v;
  const B = CFG.bridge;
  for (const br of s.bridges) {
    const pts = bridgeDeck(br);
    // The deck: plates on its own height, its underside a little below.
    const n = 8;
    for (let k = 0; k < n; k++) {
      const t0 = k / n;
      const t1 = (k + 1) / n;
      const lerp = (a: { s: number; w: number }, b: { s: number; w: number }, t: number): [number, number] => [a.s + (b.s - a.s) * t, a.w + (b.w - a.w) * t];
      const [a0, a1] = [lerp(pts[0], pts[1], t0), lerp(pts[0], pts[1], t1)];
      const [b0, b1] = [lerp(pts[3], pts[2], t0), lerp(pts[3], pts[2], t1)];
      const y = (p: [number, number]) => v.grade(p[0], p[1]) + B.rise;
      quad3(v, kit.solid, [[a0[0], a0[1], y(a0) + 0.02], [a1[0], a1[1], y(a1) + 0.02], [b1[0], b1[1], y(b1) + 0.02], [b0[0], b0[1], y(b0) + 0.02]], k % 2 ? C.plate : C.steel, 0, 0, 1);
      bb.light = BAKE.deck;
      quad3(v, bb, [[a0[0], a0[1], y(a0) - 0.7], [a1[0], a1[1], y(a1) - 0.7], [b1[0], b1[1], y(b1) - 0.7], [b0[0], b0[1], y(b0) - 0.7]], C.steelDark, 0, 0, -1);
    }
    // The side trusses: a bottom and a top chord with diagonals, along each parapet line.
    for (const q of [B.half + 0.15, -B.half - 0.15]) {
      const pa = { s: bridgeLineS(br, q, -P_OUT), w: -P_OUT };
      const pb = { s: bridgeLineS(br, q, P_OUT), w: P_OUT };
      const at = (t: number): { x: number; y: number; z: number } => {
        const u = pa.s + (pb.s - pa.s) * t;
        const w = pa.w + (pb.w - pa.w) * t;
        const p = siteWorld(s, u, w);
        return { x: p.x, y: v.grade(u, w) + B.rise, z: p.z };
      };
      const bays = 8;
      for (let k = 0; k < bays; k++) {
        const p0 = at(k / bays);
        const p1 = at((k + 1) / bays);
        frameBeam(kit.solid, p0, p1, 0, 0.1, C.bailey);
        frameBeam(kit.solid, p0, p1, B.parapet, 0.08, C.bailey);
        frameBeam(kit.solid, k % 2 ? p0 : p1, k % 2 ? p1 : p0, 0, 0.05, C.bailey, B.parapet);
        frameBeam(kit.solid, p0, p0, 0, 0.06, C.bailey, B.parapet);
      }
      const end = at(1);
      frameBeam(kit.solid, end, end, 0, 0.06, C.bailey, B.parapet);
    }
    // A lamp under the deck's middle, so it reads from the floor.
    const mid = { s: br.s, w: 0 };
    const y = v.grade(mid.s, mid.w) + B.rise - 0.72;
    frameBox(kit.glow, v.f, mid.s - 0.6, mid.s + 0.6, -0.25, 0.25, y - 0.05, y - 0.05, y, y, LIGHT.sodium);
  }
}

/** A beam between two world points `a` and `b`, lifted `lift` at both ends (or `lift` to `lift2` from a to b: a diagonal or a post), half size h. */
function frameBeam(gb: GeoBuilder, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, lift: number, h: number, color: THREE.Color, lift2 = lift): void {
  const ax = a.x;
  const az = a.z;
  let bx = b.x;
  let bz = b.z;
  if (Math.hypot(bx - ax, bz - az) < 0.01) {
    // A post: a short box straight up.
    bx = ax + 0.001;
    bz = az;
  }
  const len = Math.hypot(bx - ax, bz - az);
  const f: Frame = { cx: ax, cz: az, ux: (bx - ax) / len, uz: (bz - az) / len };
  if (len < 0.01) {
    frameBox(gb, f, -h, h, -h, h, a.y + lift, a.y + lift, a.y + lift2 + h, a.y + lift2 + h, color);
    return;
  }
  if (Math.abs(lift2 - lift) > 1e-6 && len < 0.05) {
    frameBox(gb, f, -h, h, -h, h, a.y + Math.min(lift, lift2), a.y + Math.min(lift, lift2), a.y + Math.max(lift, lift2), a.y + Math.max(lift, lift2), color);
    return;
  }
  // A sloped box: bottom and top at each end follow a.y + lift to b.y + lift2.
  frameBox(gb, f, 0, len, -h, h, a.y + lift - h, b.y + lift2 - h, a.y + lift + h, b.y + lift2 + h, color);
}

/** The kickers: steel plates over the heaps, the lip's amber edge, the steel flanks over the bevels. */
function kickers(v: View): void {
  const { s, kit } = v;
  const K = CFG.kicker;
  for (const k of s.kickers) {
    const at = (a: number, b: number): [number, number] => [k.footS + k.hs * a - k.hw * b, k.footW + k.hw * a + k.hs * b];
    const half = K.width / 2;
    const L = k.length + K.drop;
    const nA = Math.ceil(L);
    const nB = Math.ceil(K.width / 1.2);
    for (let i = 0; i < nA; i++) {
      for (let j = 0; j < nB; j++) {
        const a0 = (i * L) / nA;
        const a1 = ((i + 1) * L) / nA;
        const b0 = -half + (K.width * j) / nB;
        const b1 = -half + (K.width * (j + 1)) / nB;
        const color = (i + j) % 2 ? C.plate : C.steel;
        const ids = [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)].map(([u, w]) => {
          const p = siteWorld(s, u, w);
          return groundVertex(kit, kit.paint, p.x, p.z, 0.1, color);
        });
        kit.paint.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
      }
    }
    const [l0s, l0w] = at(k.length, -half);
    const [l1s, l1w] = at(k.length, half);
    strip(v, l0s, l0w, l1s, l1w, 0.3, 0.16, col(0xffb020, 1.2));
    // The flanks: three steel pieces each side, each as high as the heap at its far end plus the lip rail.
    const b0 = half - 0.1;
    const b1 = half + K.edge + 0.2;
    for (const sg of [1, -1]) {
      for (let j = 0; j < 3; j++) {
        const a0 = 0.5 + ((L - 0.5) * j) / 3;
        const a1 = 0.5 + ((L - 0.5) * (j + 1)) / 3;
        const [cs, cw] = at(Math.min(a1, k.length), 0);
        const crest = v.floor(cs, cw) + 0.4;
        const pts = [at(a0, sg * b0), at(a1, sg * b0), at(a1, sg * b1), at(a0, sg * b1)];
        const base = Math.min(...pts.map(([u, w]) => v.floor(u, w))) - 0.2;
        const fr = localFrame(v, (pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2, Math.atan2(k.hw, k.hs));
        frameBox(kit.solid, fr, -(a1 - a0) / 2, (a1 - a0) / 2, -(b1 - b0) / 2, (b1 - b0) / 2, base, base, crest, crest, j % 2 ? C.steel : C.steelDark);
        if (j === 2) {
          const [hs, hw] = at(k.length - 0.3, sg * (b0 + b1) / 2);
          const y = v.floor(hs, hw) + 0.42;
          frameBox(kit.hazard, localFrame(v, hs, hw, 0), -0.12, 0.12, -0.12, 0.12, y, y, y + 0.2, y + 0.2, LIGHT.amber);
        }
      }
    }
  }
}

/** Wall lamps with their floor wash, strip lights under the roof, lamps on the hoarding posts over the service roads. */
function lamps(v: View, wash: GeoBuilder): void {
  const { s, kit } = v;
  const L = CFG.lamps;
  const step = kit.quality === 'low' ? L.spacing * 1.6 : L.spacing;
  const c = new THREE.Color();
  const gapAt = (side: number, u: number) => (side > 0 && s.windows.some((w) => Math.abs(u - w) < CFG.demolished.half + 1)) || (side > 0 && s.gallery.passages.some((p) => Math.abs(u - (p.ps + p.qs) / 2) < 14));
  for (const side of [1, -1]) {
    for (let u = -s.top + 6 + (side > 0 ? 0 : step / 2); u < s.top - 6; u += step) {
      if (gapAt(side, u)) continue;
      const fl = v.floor(u, side * (F - 0.3));
      const depth = v.grade(u, side * (F + 2)) - fl;
      if (depth < L.wallHeight + 0.6) continue;
      const y = fl + L.wallHeight;
      const w = side * F;
      // The housing on the wall, its lens standing proud of it toward the floor (a lens inside the housing never shows).
      const wh = w - side * 0.12;
      const wl = w - side * 0.18;
      frameBox(kit.solid, v.f, u - 1.05, u + 1.05, Math.min(w, wh), Math.max(w, wh), y - 0.16, y - 0.16, y + 0.16, y + 0.16, C.housing);
      frameBox(kit.glow, v.f, u - 0.95, u + 0.95, Math.min(wh, wl), Math.max(wh, wl), y - 0.12, y - 0.12, y + 0.08, y + 0.08, LIGHT.lamp);
    }
  }
  if (kit.quality !== 'low') {
    // Floor wash: along both walls, brightest under each lamp, fading toward the middle.
    for (const side of [1, -1]) {
      const us = stations(-s.top + 6, s.top - 6, 1.5);
      const rows: number[][] = [];
      for (const u of us) {
        const d0 = (((u + s.top - 6 - (side > 0 ? 0 : step / 2)) % step) + step) % step;
        const near = Math.max(0, 1 - Math.min(d0, step - d0) / (step * 0.45));
        const deep = Math.max(0, Math.min(1, (v.grade(u, 0) - v.floor(u, 0) - 2) / 2));
        const row: number[] = [];
        for (const d of [0, 2.5, 5, 7.5]) {
          const p = siteWorld(s, u, side * (F - d));
          const level = (0.1 + 0.2 * near) * Math.max(0, 1 - d / 8) * deep;
          c.copy(SODIUM_WASH).multiplyScalar(level);
          row.push(wash.vertex(p.x, kit.h(p.x, p.z) + 0.08, p.z, 0, 1, 0, 0, 0, c));
        }
        rows.push(row);
      }
      for (let i = 0; i + 1 < rows.length; i++) for (let j = 0; j < 3; j++) wash.quadFacing(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1], 0, 1, 0);
    }
  }
  // Strip lights under the roof, along the middle of the tunnel.
  for (let u = -s.R + 5; u < s.R - 4; u += L.ceiling) {
    if (s.openings.some((o) => u > o.s0 - 1 && u < o.s1 + 1)) continue;
    const y = v.grade(u, 0) - CFG.roof.slab - 0.04;
    frameBox(kit.glow, v.f, u - 1.4, u + 1.4, -0.12, 0.12, y - 0.04, y - 0.04, y, y, LIGHT.strip);
  }
  // The hoarding posts' lamps over the service roads (on the yard hoarding: no loose post stands on a road).
  const poly = regionOf(v.a)!.polygon;
  for (const side of [1, -1]) {
    for (const [lo, hi] of [
      [-s.top + 6, -s.R - 4],
      [s.R + 4, s.top - 6],
    ]) {
      for (let u = lo; u < hi; u += step * 2) {
        const w = side * (VERGE_OUT + 0.15);
        const g = v.floor(u, w);
        const reach = side * (VERGE_OUT - 2.6);
        frameBox(kit.solid, v.f, u - 0.1, u + 0.1, w - 0.1, w + 0.1, g, g, g + 6, g + 6, C.steelDark);
        frameBox(kit.solid, v.f, u - 0.06, u + 0.06, Math.min(w, reach), Math.max(w, reach), g + 5.9, g + 5.9, g + 6.02, g + 6.02, C.steelDark);
        frameBox(kit.glow, v.f, u - 0.3, u + 0.3, reach - 0.18, reach + 0.18, g + 5.75, g + 5.75, g + 5.85, g + 5.85, LIGHT.lamp);
        if (kit.quality !== 'low') pool(v, wash, u, side * (ROAD_OUT - 2), 5, 0.17, SODIUM_WASH);
      }
    }
  }
  void poly;
}

/** The yards' hoardings and the openings' boards: plywood both faces with posts, works boards from the sign atlas. */
function hoardings(v: View, signs: GeoBuilder, wash: GeoBuilder): void {
  const { s, kit } = v;
  const poly = regionOf(v.a)!.polygon;
  const white = col(0xffffff);
  let i = 0;
  for (const run of yardHoardings(s, poly)) {
    for (let j = 0; j + 1 < run.length; j++) {
      const [a0, a1] = run[j];
      const [b0, b1] = run[j + 1];
      const len = Math.hypot(b0 - a0, b1 - a1);
      const n = Math.max(1, Math.round(len / 2.4));
      const ns = -(b1 - a1) / len;
      const nw = (b0 - a0) / len;
      for (let k = 0; k < n; k++) {
        const ua = a0 + ((b0 - a0) * k) / n;
        const ub = a0 + ((b0 - a0) * (k + 1)) / n;
        const wa = a1 + ((b1 - a1) * k) / n;
        const wb = a1 + ((b1 - a1) * (k + 1)) / n;
        const ya = v.floor(ua, wa);
        const yb = v.floor(ub, wb);
        const color = i++ % 2 ? C.ply : C.plyDark;
        const T = CFG.hoardingThick;
        quad3(v, kit.solid, [[ua, wa, ya - 0.2], [ub, wb, yb - 0.2], [ub, wb, yb + 2.4], [ua, wa, ya + 2.4]], color, -ns, -nw);
        quad3(v, kit.solid, [[ua + ns * T, wa + nw * T, ya - 0.2], [ub + ns * T, wb + nw * T, yb - 0.2], [ub + ns * T, wb + nw * T, yb + 2.4], [ua + ns * T, wa + nw * T, ya + 2.4]], color, ns, nw);
        frameBox(kit.solid, v.f, ua - 0.06, ua + 0.06, wa - 0.06, wa + 0.06 + nw * T, ya - 0.2, ya - 0.2, ya + 2.55, ya + 2.55, C.steelDark);
        // A works board every so often on the face toward the roads (no arrows, nothing that points a line).
        if (i % 11 === 5 && len > 6) {
          const p = siteWorld(s, (ua + ub) / 2 - ns * 0.03, (wa + wb) / 2 - nw * 0.03);
          const n2 = { x: v.f.ux * -ns - v.f.uz * -nw, z: v.f.uz * -ns + v.f.ux * -nw };
          signPanel(signs, p.x, (ya + yb) / 2 + 1.5, p.z, n2.x, n2.z, 2.2, 0.55, i % 22 === 5 ? CLOSED_CELL : boardCell(i % 2), white);
        }
      }
    }
  }
  void wash;
}

/**
 * The playwood hoarding on the weekend region's ring (weekendRegion.ts regionFence, the solid trenchWall bodies the sim
 * stands there), panels both faces with posts: the works site's boundary, open at the entry and the exit.
 */
function regionHoarding(kit: DistrictKit, a: Area): void {
  const r = regionOf(a);
  if (!r) return;
  const T = CFG.hoardingThick;
  for (const p of regionFence(r)) {
    const len = Math.hypot(p.bx - p.ax, p.bz - p.az);
    if (len < 0.1) continue;
    const f: Frame = { cx: p.ax, cz: p.az, ux: (p.bx - p.ax) / len, uz: (p.bz - p.az) / len };
    const sv = -f.uz * p.nx + f.ux * p.nz > 0 ? 1 : -1;
    const steps = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i < steps; i++) {
      const ua = (len * i) / steps;
      const ub = (len * (i + 1)) / steps;
      const pa = toWorld(f, ua, 0);
      const pb = toWorld(f, ub, 0);
      const ya = kit.h(pa.x, pa.z);
      const yb = kit.h(pb.x, pb.z);
      const color = i % 2 ? C.ply : C.plyDark;
      frameWall(kit.solid, f, ua, 0, ub, 0, ya - 0.2, ya + 2.3, yb - 0.2, yb + 2.3, color, -p.nx, -p.nz);
      frameWall(kit.solid, f, ub, sv * T, ua, sv * T, yb - 0.2, yb + 2.3, ya - 0.2, ya + 2.3, color, p.nx, p.nz);
      frameBox(kit.solid, f, ua - 0.06, ua + 0.06, Math.min(0, sv * T), Math.max(0, sv * T), ya - 0.2, ya - 0.2, ya + 2.45, ya + 2.45, C.steelDark);
    }
  }
}

/** Every box solid the sim stands (the hints): the bus, the plant, the plaza's pieces, the gallery's pipes and trays, the footbridges' abutments. */
function plant(v: View, wash: GeoBuilder): void {
  const { kit } = v;
  for (const h of kit.builds[v.a.id].hints) {
    if (h.kind !== UNDERGROUND_HINT.solid) continue;
    const [type, u, w, yaw, len, wid, height] = h.values;
    const fr = localFrame(v, u, w, yaw);
    const y = v.floor(u, w);
    switch (type) {
      case UG_SOLID.bus:
        bus(kit, fr, y, len, wid, height);
        break;
      case UG_SOLID.truck:
        truck(kit, fr, y, len, wid, height);
        break;
      case UG_SOLID.digger:
        digger(kit, fr, y, len, wid, height);
        break;
      case UG_SOLID.lightTower:
        lightTower(kit, fr, y, len, wid);
        if (kit.quality !== 'low') pool(v, wash, u, w - Math.sign(w) * 5, 7, 0.2, WHITE_WASH);
        break;
      case UG_SOLID.mast:
        mast(kit, fr, y, len, height);
        if (kit.quality !== 'low') pool(v, wash, u, w, 17, 0.26, WHITE_WASH);
        break;
      case UG_SOLID.cabin:
        cabin(kit, fr, y, len, wid, height, (Math.floor(u) & 1) === 0);
        break;
      case UG_SOLID.crane:
        crane(kit, fr, y, len, wid, height);
        if (kit.quality !== 'low') pool(v, wash, u, w, 9, 0.16, WHITE_WASH);
        break;
      case UG_SOLID.stack:
        if ((Math.floor(u * 3) & 1) === 0) pipeStack(kit, fr, y, 4, len, wid);
        else rebar(kit, fr, y, len, wid, height);
        break;
      case UG_SOLID.mat:
        for (let k = 0; k < 4; k++) frameBox(kit.solid, fr, -len / 2, len / 2, -wid / 2, wid / 2, y + k * (height / 4), y + k * (height / 4), y + (k + 1) * (height / 4) - 0.02, y + (k + 1) * (height / 4) - 0.02, k % 2 ? C.timber : C.timber.clone().multiplyScalar(0.8));
        break;
      case UG_SOLID.heap:
        mound(kit, fr, y, len, wid, height);
        break;
      case UG_SOLID.abutment:
        frameBox(kit.solid, fr, -len / 2, len / 2, -wid / 2, wid / 2, y - 0.3, y - 0.3, y + height + 0.55, y + height + 0.55, C.wallA);
        break;
      case UG_SOLID.pipes: {
        const top = v.grade(u, w) - CFG.roof.slab;
        for (const [dy, r, c] of [
          [0.7, 0.32, C.pipe],
          [1.5, 0.25, C.pipeGrey],
          [2.2, 0.2, C.pipe],
        ] as const) frameCylinderU(kit.solid, fr, -len / 2, len / 2, 0, y + dy, r, 8, c);
        for (let k = -len / 2; k <= len / 2; k += 3) frameBox(kit.solid, fr, k - 0.05, k + 0.05, -wid / 2, wid / 2, y, y, top, top, C.steelDark);
        break;
      }
      case UG_SOLID.trays: {
        for (const dy of [1.2, 2.0, 2.8]) frameBox(kit.solid, fr, -len / 2, len / 2, -wid / 2, wid / 2, y + dy, y + dy, y + dy + 0.12, y + dy + 0.12, C.steelDark);
        break;
      }
    }
  }
}

/** The jet fans under the roof, and the footbridges over the open trench: render only, over every level a car drives. */
function overhead(v: View): void {
  const { s, kit } = v;
  for (let u = -s.R + 16; u < s.R - 10; u += 36) {
    if (s.openings.some((o) => u > o.s0 - 4 && u < o.s1 + 4)) continue;
    for (const w of [-F * 0.45, F * 0.45]) {
      const top = v.grade(u, w) - CFG.roof.slab;
      const y = top - 0.75;
      frameCylinderU(kit.solid, v.f, u - 1.8, u + 1.8, w, y, 0.55, 12, C.steel);
      frameBox(kit.solid, v.f, u - 0.1, u + 0.1, w - 0.07, w + 0.07, y + 0.45, y + 0.45, top, top, C.housing);
      frameBox(kit.glow, v.f, u + 1.7, u + 1.82, w - 0.3, w + 0.3, y - 0.18, y - 0.18, y + 0.18, y + 0.18, LIGHT.amber);
    }
  }
  const FB = CFG.footbridge;
  for (const u of footbridges(s)) {
    const reach = VERGE_OUT + 1.5;
    const gl = Math.max(v.grade(u, reach), v.grade(u, -reach));
    const y = gl + FB.clear;
    frameBox(kit.solid, v.f, u - FB.width / 2, u + FB.width / 2, -reach, reach, y, y, y + 0.5, y + 0.5, C.kerb);
    for (const sg of [-1, 1]) {
      const ue = u + (sg * FB.width) / 2;
      frameBox(kit.solid, v.f, Math.min(ue, ue - sg * 0.1), Math.max(ue, ue - sg * 0.1), -reach, reach, y + 0.5, y + 0.5, y + 1.5, y + 1.5, C.steelDark);
    }
    frameBox(kit.glow, v.f, u - 0.5, u + 0.5, -0.3, 0.3, y - 0.06, y - 0.06, y - 0.02, y - 0.02, LIGHT.sodium);
  }
}

function bus(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  const hw = wid / 2;
  const bellows = 1.2;
  const body = (len - bellows) / 2;
  for (const sign of [-1, 1]) {
    const u0 = sign < 0 ? -len / 2 : bellows / 2;
    const u1 = u0 + body;
    frameBox(kit.solid, f, u0, u1, -hw, hw, y + 0.35, y + 0.35, y + height, y + height, C.busBody, { bottom: false });
    frameBox(kit.solid, f, u0 + 0.2, u1 - 0.2, -hw - 0.02, hw + 0.02, y + 1.35, y + 1.35, y + 2.45, y + 2.45, C.busDark, { top: false, bottom: false, u0: false, u1: false });
    frameBox(kit.glow, f, u0 + 0.4, u1 - 0.4, -hw + 0.1, hw - 0.1, y + 2.38, y + 2.38, y + 2.42, y + 2.42, LIGHT.interior);
    frameBox(kit.solid, f, u0 + 0.5, u1 - 0.5, -hw + 0.05, hw - 0.05, y + 0.15, y + 0.15, y + 0.4, y + 0.4, C.busBellows);
  }
  frameBox(kit.solid, f, -bellows / 2, bellows / 2, -hw + 0.1, hw - 0.1, y + 0.4, y + 0.4, y + height - 0.3, y + height - 0.3, C.busBellows);
  frameBox(kit.glow, f, -len / 2 - 0.03, -len / 2 + 0.02, -hw + 0.2, -hw + 0.45, y + 0.9, y + 0.9, y + 1.1, y + 1.1, LIGHT.tail);
  frameBox(kit.glow, f, -len / 2 - 0.03, -len / 2 + 0.02, hw - 0.45, hw - 0.2, y + 0.9, y + 0.9, y + 1.1, y + 1.1, LIGHT.tail);
  frameBox(kit.hazard, f, -len / 2 - 0.03, -len / 2 + 0.02, -0.3, 0.3, y + height - 0.4, y + height - 0.4, y + height - 0.2, y + height - 0.2, LIGHT.amber);
}

function truck(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2, len / 2 - 1.9, -hw, hw, y + 0.5, y + 0.5, y + height, y + height, C.truck, { bottom: false });
  frameBox(kit.solid, f, len / 2 - 1.9, len / 2, -hw, hw, y + 0.5, y + 0.5, y + 2.1, y + 2.1, C.truckCab, { bottom: false });
  frameBox(kit.solid, f, -len / 2, len / 2, -hw + 0.1, hw - 0.1, y + 0.2, y + 0.2, y + 0.55, y + 0.55, C.housing);
  frameBox(kit.hazard, f, len / 2 - 1.2, len / 2 - 0.6, -0.12, 0.12, y + 2.1, y + 2.1, y + 2.28, y + 2.28, LIGHT.amber);
}

function digger(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2, len / 2, -hw, -hw + 0.7, y, y, y + 0.8, y + 0.8, C.housing);
  frameBox(kit.solid, f, -len / 2, len / 2, hw - 0.7, hw, y, y, y + 0.8, y + 0.8, C.housing);
  frameBox(kit.solid, f, -len / 2 + 0.5, len / 2 - 1.2, -hw + 0.2, hw - 0.2, y + 0.8, y + 0.8, y + 2.2, y + 2.2, C.digger);
  frameBox(kit.solid, f, len / 2 - 2.4, len / 2 - 1.2, -hw + 0.5, hw - 0.5, y + 2.2, y + 2.2, y + height, y + height, C.digger);
  frameBox(kit.solid, f, -len / 2 + 0.2, len / 2 - 0.4, -0.15, 0.15, y + height - 0.4, y + 2.0, y + height - 0.2, y + 2.2, C.steelDark);
}

function lightTower(kit: DistrictKit, f: Frame, y: number, len: number, wid: number): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2 + 0.5, len / 2 - 0.5, -hw + 0.3, hw - 0.3, y + 0.45, y + 0.45, y + 1.0, y + 1.0, C.tower);
  frameBox(kit.solid, f, -0.12, 0.12, -0.12, 0.12, y + 1.0, y + 1.0, y + 6.4, y + 6.4, C.steelDark);
  frameBox(kit.glow, f, -0.7, 0.7, -0.5, 0.5, y + 6.4, y + 6.4, y + 6.7, y + 6.7, LIGHT.work);
}

/** A site light mast: a ballasted base, a steel pole, a bar of four floodlights at `height`. */
function mast(kit: DistrictKit, f: Frame, y: number, size: number, height: number): void {
  frameBox(kit.solid, f, -size / 2, size / 2, -size / 2, size / 2, y - 0.1, y - 0.1, y + 0.7, y + 0.7, C.kerb);
  frameBox(kit.solid, f, -0.14, 0.14, -0.14, 0.14, y + 0.7, y + 0.7, y + height, y + height, C.steelDark);
  frameBox(kit.solid, f, -1.3, 1.3, -0.1, 0.1, y + height, y + height, y + height + 0.15, y + height + 0.15, C.steelDark);
  for (const u of [-1.1, -0.4, 0.4, 1.1]) frameBox(kit.glow, f, u - 0.28, u + 0.28, -0.25, 0.25, y + height - 0.35, y + height - 0.35, y + height, y + height, LIGHT.work);
}

function cabin(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number, lit: boolean): void {
  const hw = wid / 2;
  frameBox(kit.solid, f, -len / 2, len / 2, -hw, hw, y + 0.25, y + 0.25, y + height, y + height, lit ? C.cabin : C.cabinB, { bottom: false });
  frameBox(kit.solid, f, -len / 2 + 0.2, len / 2 - 0.2, -hw + 0.1, hw - 0.1, y, y, y + 0.25, y + 0.25, C.housing, { top: false, bottom: false });
  for (const u of [-len / 4, len / 4]) frameBox(lit ? kit.glow : kit.solid, f, u - 0.6, u + 0.6, -hw - 0.02, hw + 0.02, y + 1.3, y + 1.3, y + 2.0, y + 2.0, lit ? LIGHT.window : C.busDark, { top: false, bottom: false, u0: false, u1: false });
}

function crane(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  // The base block (the sim's solid), the lattice mast, the jib and counter-jib, a red lamp on top.
  frameBox(kit.solid, f, -len / 2, len / 2, -wid / 2, wid / 2, y, y, y + height, y + height, C.kerb);
  const mastTop = y + height + 34;
  for (const [a, b] of [
    [-0.9, -0.9],
    [0.9, -0.9],
    [0.9, 0.9],
    [-0.9, 0.9],
  ]) frameBox(kit.solid, f, a - 0.1, a + 0.1, b - 0.1, b + 0.1, y + height, y + height, mastTop, mastTop, C.crane);
  for (let h = y + height + 3; h < mastTop; h += 3) frameBox(kit.solid, f, -0.95, 0.95, -0.95, 0.95, h, h, h + 0.12, h + 0.12, C.crane, { top: false, bottom: false });
  frameBox(kit.solid, f, -12, 38, -0.6, 0.6, mastTop, mastTop, mastTop + 1.4, mastTop + 1.4, C.crane);
  frameBox(kit.solid, f, -12, -7, -1.2, 1.2, mastTop - 1.2, mastTop - 1.2, mastTop, mastTop, C.kerb);
  frameBox(kit.solid, f, -0.8, 0.8, -0.8, 0.8, mastTop + 1.4, mastTop + 1.4, mastTop + 4, mastTop + 4, C.crane);
  frameBox(kit.glow, f, 37, 38, -0.3, 0.3, mastTop + 1.4, mastTop + 1.4, mastTop + 1.7, mastTop + 1.7, LIGHT.tail);
  frameBox(kit.glow, f, -0.3, 0.3, -0.3, 0.3, mastTop + 4, mastTop + 4, mastTop + 4.3, mastTop + 4.3, LIGHT.tail);
}

function pipeStack(kit: DistrictKit, f: Frame, y: number, n: number, len = 6, wid = 2): void {
  const r = Math.min(0.4, wid / (2 * n));
  let row = 0;
  for (let count = n; count > 0; count--, row++) {
    for (let k = 0; k < count; k++) {
      const v = -((count - 1) * r) + k * 2 * r;
      frameCylinderU(kit.solid, f, -len / 2, len / 2, v, y + r + row * r * 1.7, r, 8, row % 2 ? C.pipeGrey : C.pipe);
    }
  }
}

function rebar(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  for (const u of [-len / 3, len / 3]) frameBox(kit.solid, f, u - 0.15, u + 0.15, -wid / 2, wid / 2, y, y, y + 0.2, y + 0.2, C.timber);
  frameBox(kit.solid, f, -len / 2, len / 2, -wid / 2 + 0.1, wid / 2 - 0.1, y + 0.2, y + 0.2, y + height, y + height, col(0x6b3d2a));
}

function mound(kit: DistrictKit, f: Frame, y: number, len: number, wid: number, height: number): void {
  // A heap: a stepped box pyramid of spoil, darker at its foot.
  for (let k = 0; k < 3; k++) {
    const t = k / 3;
    const l = (len / 2) * (1 - t * 0.6);
    const w = (wid / 2) * (1 - t * 0.6);
    frameBox(kit.solid, f, -l, l, -w, w, y - 0.2 + height * t, y - 0.2 + height * t, y + height * (t + 1 / 3), y + height * (t + 1 / 3), k % 2 ? C.rubble : C.rubbleDark, { bottom: false });
  }
}
