/**
 * Overpass renderer (src/city/districts/overpass.ts).
 *
 *  - Freeway viaducts: a concrete box girder deck on a straight grade
 *    (structureShapes.deckLine), its fascia banded with a darker drip edge,
 *    jersey barriers and tall lamp posts with sodium heads along the top, a
 *    row of sodium lamps under the soffit over every street it crosses with
 *    their wash on the road below, hammerhead piers on the sim's pier
 *    rectangles (the cap spreads across the deck's width), round columns
 *    inside the blocks, abutments at the ends with a ROAD CLOSED plate and a
 *    red lamp, and a fenced retaining wall along the building lines under the
 *    deck (the frontage walls with look 'pier').
 * Everything is merged into the kit's builders, plus one sign mesh and one
 * road wash mesh (Medium and up) for the whole city. Low drops the deck lamp
 * posts and the wash. (The sign gantry is structureFx.ts signGantry, over the
 * elevated highway's carriageways: render/districts/highway.ts.)
 */
import * as THREE from 'three';
import type { Area } from '../../city/districts/types';
import type { Frame } from '../../city/districts/structures';
import { toWorld } from '../../city/districts/structures';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, orientedBox, wallBox } from './kit';
import { CLOSED_CELL, beam, frameBox, makeStructureSigns, signPanel } from './structureFx';
import { washMaterial } from '../materialFx';
import { ViaductShape, deckLine, viaductShape } from './structureShapes';

const OV = {
  /** Viaduct: barrier height and width (m), lamp post spacing and height (m), soffit lamps per crossing. */
  barrierH: 1.05,
  barrierW: 0.45,
  postEvery: 32,
  postH: 9,
  soffitLamps: 3,
  /** Hammerhead cap depth under the soffit (m) and its thickness along the deck (m). */
  capH: 1.5,
  capT: 1.8,
  /** Wash under the deck: brightness (additive, linear) and reach beyond the deck edges (m). */
  wash: 0.26,
  washReach: 6,
} as const;

const C = {
  steel: col(0x6f757c),
  concrete: col(0x77746e),
  fascia: col(0x8a867f),
  drip: col(0x3f3d3a),
  soffit: col(0x4a4845),
  deckTop: col(0x2b2b2e),
  barrier: col(0x9a978f),
  fence: col(0x3a3d41),
  housing: col(0x1d1e22),
} as const;

const LIGHT = {
  sodium: col(0xffa040, 1.1),
  red: col(0xff2a1a, 1.4),
} as const;

const SODIUM_WASH = new THREE.Color(0xffa040);

export const overpassRenderer: DistrictRenderer = {
  kinds: ['overpass'],
  build(kit, areas) {
    const signs = new GeoBuilder(true);
    const wash = new GeoBuilder(true);
    for (const a of areas) viaduct(kit, signs, wash, a);
    // Building lines under a deck: a concrete retaining wall with a chain link fence on top (solid pier
    // walls are the piers, columns and abutments drawn above).
    for (const w of kit.walls.get('pier') ?? []) {
      if (w.solid) continue;
      wallBox(kit, kit.solid, w, 0.35, 1.2, C.concrete);
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const n = Math.max(1, Math.round(len / 2.5));
      for (let i = 0; i <= n; i++) {
        const x = w.ax + ((w.bx - w.ax) * i) / n - w.nx * 0.15;
        const z = w.az + ((w.bz - w.az) * i) / n - w.nz * 0.15;
        const y = kit.h(x, z);
        cylinder(kit.solid, x, z, 0.04, y + 1.1, y + 3.2, 4, C.fence, false);
      }
      const ya = kit.h(w.ax, w.az);
      const yb = kit.h(w.bx, w.bz);
      beam(kit.solid, { x: w.ax - w.nx * 0.15, y: ya + 3.15, z: w.az - w.nz * 0.15 }, { x: w.bx - w.nx * 0.15, y: yb + 3.15, z: w.bz - w.nz * 0.15 }, 0.03, 0.03, C.fence);
      beam(kit.solid, { x: w.ax - w.nx * 0.15, y: ya + 2.2, z: w.az - w.nz * 0.15 }, { x: w.bx - w.nx * 0.15, y: yb + 2.2, z: w.bz - w.nz * 0.15 }, 0.02, 0.02, C.fence);
    }
    const add = (gb: GeoBuilder, name: string, mat: THREE.Material, order = 0) => {
      if (!gb.vertexCount) return;
      const m = new THREE.Mesh(kit.track(gb.build()), kit.track(mat));
      m.name = name;
      m.renderOrder = order;
      kit.group.add(m);
    };
    add(wash, 'overpassWash', washMaterial(), 1);
    if (signs.vertexCount) {
      const map = kit.track(makeStructureSigns());
      add(signs, 'overpassSigns', new THREE.MeshBasicMaterial({ map, vertexColors: true }));
    }
  },
};

/** A freeway viaduct: deck, barriers, lamps, piers, columns, abutments and the light under it. */
function viaduct(kit: DistrictKit, signs: GeoBuilder, wash: GeoBuilder, a: Area): void {
  const v: ViaductShape = viaductShape(a);
  const line = deckLine(kit.world, v);
  const soffit = (s: number) => line.a + line.b * s;
  const f: Frame = { cx: v.x0, cz: v.z0, ux: v.ux, uz: v.uz };
  const step = 6;
  const n = Math.max(1, Math.ceil(v.length / step));
  // The deck in segments along its grade: soffit, fascia with a drip edge, top, barriers.
  for (let i = 0; i < n; i++) {
    const s0 = (v.length * i) / n;
    const s1 = (v.length * (i + 1)) / n;
    const b0 = soffit(s0);
    const b1 = soffit(s1);
    const t0 = b0 + v.depth;
    const t1 = b1 + v.depth;
    // A dark drip band along the fascia's foot, the soffit under the whole width.
    frameBox(kit.solid, f, s0, s1, -v.half, v.half, b0, b1, b0 + 0.35, b1 + 0.35, C.drip, { u0: i === 0, u1: i === n - 1, top: false, bottom: false });
    frameBox(kit.solid, f, s0, s1, -v.half, v.half, b0, b1, b0, b1, C.soffit, { u0: false, u1: false, v0: false, v1: false, top: false });
    frameBox(kit.solid, f, s0, s1, -v.half, v.half, b0 + 0.35, b1 + 0.35, t0, t1, C.fascia, { u0: i === 0, u1: i === n - 1, bottom: false });
    for (const side of [-1, 1]) {
      const vb0 = side > 0 ? v.half - OV.barrierW : -v.half;
      frameBox(kit.solid, f, s0, s1, vb0, vb0 + OV.barrierW, t0, t1, t0 + OV.barrierH, t1 + OV.barrierH, C.barrier, { u0: i === 0, u1: i === n - 1, bottom: false });
    }
  }
  // Lamp posts along the top, alternating sides, their sodium heads seen from the street below.
  if (kit.quality !== 'low') {
    const posts = Math.max(1, Math.floor(v.length / OV.postEvery));
    for (let i = 0; i < posts; i++) {
      const s = (v.length * (i + 0.5)) / posts;
      const side = i % 2 ? 1 : -1;
      const top = soffit(s) + v.depth;
      const p = toWorld(f, s, side * (v.half - OV.barrierW / 2));
      cylinder(kit.solid, p.x, p.z, 0.11, top + OV.barrierH, top + OV.postH, 6, C.steel, false, 0.07);
      const arm = toWorld(f, s, side * (v.half - OV.barrierW / 2 - 2));
      beam(kit.solid, { x: p.x, y: top + OV.postH, z: p.z }, { x: arm.x, y: top + OV.postH, z: arm.z }, 0.05, 0.05, C.steel);
      frameBox(kit.glow, f, s - 0.35, s + 0.35, side * (v.half - OV.barrierW / 2 - 2.4) - 0.2, side * (v.half - OV.barrierW / 2 - 2.4) + 0.2, top + OV.postH - 0.18, top + OV.postH - 0.18, top + OV.postH - 0.05, top + OV.postH - 0.05, LIGHT.sodium);
    }
  }
  // Under the deck over each street it crosses: a row of soffit lamps and their wash on the road.
  const b = kit.builds[a.id];
  const piers = b.props.filter((p) => p.kind === 'pier');
  const crossings: { s: number; half: number }[] = [];
  for (const eid of a.edges) {
    const e = kit.world.graph.edges[eid];
    const A = kit.world.graph.nodes[e.a];
    const B = kit.world.graph.nodes[e.b];
    const den = v.ux * (B.z - A.z) - v.uz * (B.x - A.x);
    if (Math.abs(den) < 1e-9) continue;
    const s = ((A.x - v.x0) * (B.z - A.z) - (A.z - v.z0) * (B.x - A.x)) / den;
    if (s > 0 && s < v.length) crossings.push({ s, half: e.width / 2 + e.sidewalk });
  }
  for (const { s, half } of crossings) {
    for (let k = 0; k < OV.soffitLamps; k++) {
      const lat = -v.half + 1.5 + ((2 * v.half - 3) * k) / (OV.soffitLamps - 1);
      const y = soffit(s) - 0.02;
      frameBox(kit.glow, f, s - 1.6, s + 1.6, lat - 0.18, lat + 0.18, y - 0.12, y - 0.12, y, y, LIGHT.sodium);
    }
    if (kit.quality !== 'low') deckWash(kit, wash, f, s, v.half, half + 1);
  }
  // Hammerhead piers: a column on the sim's rectangle, a cap spreading across the deck's width.
  for (const p of piers) {
    const ex = Math.sin(p.yaw);
    const ez = Math.cos(p.yaw);
    const len = p.size * 2;
    const thick = p.height * 2;
    const base = Math.min(kit.h(p.x - ex * p.size, p.z - ez * p.size), kit.h(p.x + ex * p.size, p.z + ez * p.size));
    // Where the pier stands along the deck.
    const s = (p.x - v.x0) * v.ux + (p.z - v.z0) * v.uz;
    const top = soffit(s);
    const ax = p.x - ex * (len / 2);
    const az = p.z - ez * (len / 2);
    const bx = p.x + ex * (len / 2);
    const bz = p.z + ez * (len / 2);
    // Across the street: the pier rectangle's short axis.
    const nx = -ez;
    const nz = ex;
    orientedBox(kit.solid, ax - nx * (thick / 2), az - nz * (thick / 2), bx - nx * (thick / 2), bz - nz * (thick / 2), nx * thick, nz * thick, base - 0.3, top - OV.capH, C.concrete);
    // The cap: along the street (the deck's width) and as thick as the column is long across.
    const capHalf = v.half / Math.max(0.5, Math.abs(ex * v.uz * -1 + ez * v.ux)) + 0.4;
    const cx0 = p.x - ex * capHalf;
    const cz0 = p.z - ez * capHalf;
    const cx1 = p.x + ex * capHalf;
    const cz1 = p.z + ez * capHalf;
    orientedBox(kit.solid, cx0 - nx * (OV.capT / 2), cz0 - nz * (OV.capT / 2), cx1 - nx * (OV.capT / 2), cz1 - nz * (OV.capT / 2), nx * OV.capT, nz * OV.capT, top - OV.capH, top, C.concrete);
  }
  // Round columns inside the blocks, with a square cap.
  for (const p of b.props.filter((q) => q.kind === 'column')) {
    const s = (p.x - v.x0) * v.ux + (p.z - v.z0) * v.uz;
    const top = soffit(s);
    cylinder(kit.solid, p.x, p.z, p.size, kit.h(p.x, p.z) - 0.3, top - 1, 10, C.concrete, false);
    frameBox(kit.solid, f, s - 1, s + 1, -v.half + 1, v.half - 1, top - 1, top - 1, top, top, C.concrete);
  }
  // Abutments: concrete blocks up to the deck at each end, the deck's end shut with a plate and a red lamp.
  for (const p of b.props.filter((q) => q.kind === 'abutment')) {
    const s = (p.x - v.x0) * v.ux + (p.z - v.z0) * v.uz;
    const s0 = s - p.size;
    const s1 = s + p.size;
    let lo = Infinity;
    for (const ss of [s0, s1]) for (const lat of [-v.half, v.half]) {
      const q = toWorld(f, ss, lat);
      lo = Math.min(lo, kit.h(q.x, q.z));
    }
    frameBox(kit.solid, f, s0, s1, -v.half - 0.4, v.half + 0.4, lo - 0.4, lo - 0.4, soffit(s0), soffit(s1), C.concrete);
    const end = s < v.length / 2 ? 0 : v.length;
    const dir = end === 0 ? -1 : 1;
    const top = soffit(end) + v.depth;
    const q = toWorld(f, end - dir * 1.2, 0);
    // Facing back along the deck, toward anyone who got up there.
    signPanel(signs, q.x, top + 1.2, q.z, -dir * v.ux, -dir * v.uz, Math.min(8, 2 * v.half - 2), 1.6, CLOSED_CELL, col(0xffffff, 0.8));
    for (const lat of [-2, 2]) frameBox(kit.glow, f, end - dir * 1.25 - 0.1, end - dir * 1.25 + 0.1, lat - 0.12, lat + 0.12, top + 2.1, top + 2.1, top + 2.35, top + 2.35, LIGHT.red);
  }
}

/**
 * Sodium light on the street under a deck crossing at s: across the deck (along the street) full under
 * it and fading out washReach m beyond its edges, along the deck over the street's corridor (`across`).
 */
function deckWash(kit: DistrictKit, gb: GeoBuilder, f: Frame, s: number, half: number, across: number): void {
  const reach = half + OV.washReach;
  const c = new THREE.Color();
  const lats = [-reach, -half, 0, half, reach];
  const dus: number[] = [];
  for (let k = 0; k <= 8; k++) dus.push(-across + (2 * across * k) / 8);
  const level = (du: number, lat: number) => OV.wash * (Math.abs(lat) <= half ? 1 : Math.max(0, 1 - (Math.abs(lat) - half) / OV.washReach)) * (1 - 0.6 * (Math.abs(du) / across));
  for (let i = 0; i + 1 < dus.length; i++) {
    for (let k = 0; k + 1 < lats.length; k++) {
      const ids = [
        [dus[i], lats[k]],
        [dus[i + 1], lats[k]],
        [dus[i + 1], lats[k + 1]],
        [dus[i], lats[k + 1]],
      ].map(([du, lat]) => {
        const p = toWorld(f, s + du, lat);
        c.copy(SODIUM_WASH).multiplyScalar(level(du, lat));
        // Over curbs and sidewalks too: they stand CITY.curbHeight proud of the road.
        return gb.vertex(p.x, kit.world.driveHeightAt(p.x, p.z) + 0.06, p.z, 0, 1, 0, 0, 0, c);
      });
      gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    }
  }
}
