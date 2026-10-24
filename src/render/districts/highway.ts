/**
 * Elevated highway renderer (city/districts/highway/), built on the deck's
 * settled curve (highwayDeck: the same samples the sim's spans and walls
 * were cut from) so what is drawn is what is driven:
 *  - the deck: a concrete box girder (fascia, soffit), its asphalt top with
 *    lane lines (three lanes each way, the shoulders' edge lines: yellow by
 *    the median, white outside), parapets along both edges (open where a ramp
 *    merges, the deck widened there out to the ramp's lane and its taper), the
 *    median barrier, broken at its crossovers with a crash cushion at each
 *    end, and past both closures the deck running on into the fog;
 *  - columns: the sim's bents (a square column on each sidewalk and a cap
 *    beam across the street under the deck), a column under each ramp
 *    merge's widened deck; render-only hammerheads past the city at both ends;
 *  - light, so the expressway reads as the brightest road in the city: tall
 *    twin headed lamp posts down the median every few tens of meters, amber
 *    delineators along the parapets, two rows of sodium lamps under the
 *    soffit lighting the street beneath; on Medium and up their pools on the
 *    deck and the street below (one additive mesh, as the El's and the
 *    viaducts'), and the median lamps and the ramps' join the real light pool
 *    (highwayLamps, scene.ts) so a car up there is lit as on the streets;
 *  - sign gantries across both carriageways (structureFx.ts signGantry, the
 *    direction signs once on city streets), the closures at both ends (a
 *    barrier row, crash cushions, END EXPRESSWAY and red lamps);
 *  - on-ramps: the asphalt on the ramp's exact surface, an embankment between
 *    retaining walls up to where it leaves the ground for its last stretch
 *    (a short bridge on a column onto the deck), the wall under its top and
 *    the merge along the building line, lamp posts, a double yellow line and
 *    lane arrows each way, an EXPRESSWAY ON RAMP sign at the mouth and, in a
 *    race (the ramps are closed), a cyan barrier across the mouth.
 * Everything merges into the kit's solid, paint and glow builders; signs and
 * the light pools are one mesh each for the whole city. Low draws coarser
 * deck pieces, no gantry diagonals, no lane dashes on the ramps, no
 * delineators and no pools.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area } from '../../city/districts/types';
import type { Frame } from '../../city/districts/structures';
import { HIGHWAY_HALF, HighwayDeck, HighwayRamp, LANES_IN, barrierOpen, deckTopAt, deckUnderAt, highwayDeck, inMedianGap, laneCenter, medianGaps, mergeRange, rampFront, rampInnerSign, rampOuterAt } from '../../city/districts/highway/shape';
import type { World } from '../../city/world';
import { axisAt, axisPoint, projectAxis, rampHeight } from '../../city/districts/highway/rampAxis';
import { RAIL, RailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../city/railCurve';
import { GANTRY_SIGNS, END_CELL, CLOSED_CELL, RAMP_CELL, gantryCell, makeStructureSigns, signGantry, signPanel } from './structureFx';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, orientedBox } from './kit';
import { washMaterial } from '../materialFx';
import type { Vec2 } from '../../sim/math';

const CFG = CITY.districts.highway;
const HALF = HIGHWAY_HALF;

const HW = {
  /** Deck piece length (m), Medium and up / Low. */
  piece: 6,
  pieceLow: 10,
  /** Jersey barrier: width and height (m); the median's height. */
  barrierW: 0.45,
  barrierH: 1.0,
  medianH: 0.9,
  /** Lane lines: width (m), the dashes' length and period (m). */
  line: 0.15,
  dash: 3,
  period: 9,
  /** Median lamp posts: spacing (m), height over the deck (m), arm reach (m: the heads over the middle lanes). */
  postEvery: 32,
  postH: 12,
  arm: 6.2,
  /** Amber delineators along the parapets every this far (m, Medium and up). */
  delineatorEvery: 12,
  /** Sodium lamps under the soffit every this far (m), in two rows each side this far out (m). */
  soffitEvery: 26,
  soffitRows: [5, 11],
  /** A crash cushion's length at each end of the median by a crossover (m). */
  cushion: 2.4,
  /** Cap beams under the deck: depth (m) and width along the deck (m). */
  capH: 1.3,
  capW: 1.6,
  /** Render-only hammerheads past the closures: every this far (m), starting this far out (m). */
  runOffEvery: 40,
  runOffFrom: 90,
  /** Pools: deck lamps and soffit lamps (radius m, additive color at the middle). */
  deckPool: { r: 13, color: col(0xffc070, 0.3) },
  streetPool: { r: 9, color: col(0xff9a40, 0.3) },
  /** Ramp lamp posts every this far along the outer wall (m), their height (m). */
  rampPostEvery: 18,
  rampPostH: 9,
  /** Sign gantries keep this far from a ramp's merge and from the El crossing (m). */
  gantryClear: 70,
} as const;

const C = {
  top: col(0x2a2a2e),
  fascia: col(0x8f8b84),
  soffit: col(0x4a4845),
  barrier: col(0xa29e96),
  concrete: col(0x7a776f),
  wall: col(0x6d6a63),
  steel: col(0x6f757c),
  white: col(0xd8d8d0, 0.85),
  yellow: col(0xe0b030, 0.9),
  cushion: col(0xe8c020, 0.9),
  post: col(0x2a2d31),
} as const;

const LAMP = {
  head: col(0xffe2b0, 1.8),
  sodium: col(0xffa040, 1.3),
  red: col(0xff2a1a, 1.6),
  amber: col(0xffb020, 1.5),
  cyan: col(0x40f0ff, 1.6),
} as const;

/** A point at s along the deck, v to the right of travel toward +s. */
function at(c: RailCurve, s: number, v: number, P = curvePoint()): Vec2 {
  sampleCurve(c, s, P);
  return { x: P.x - P.tz * v, z: P.z + P.tx * v };
}

/** Horizontal quad over [s0, s1] x [v0, v1] at heights y0 (at s0) and y1 (at s1), facing up (or down). */
function band(gb: GeoBuilder, c: RailCurve, s0: number, s1: number, v0: number, v1: number, y0: number, y1: number, color: THREE.Color, up = true): void {
  const a = at(c, s0, v0);
  const b = at(c, s1, v0);
  const d = at(c, s1, v1);
  const e = at(c, s0, v1);
  const n = up ? 1 : -1;
  const ids = [gb.vertex(a.x, y0, a.z, 0, n, 0, 0, 0, color), gb.vertex(b.x, y1, b.z, 0, n, 0, 1, 0, color), gb.vertex(d.x, y1, d.z, 0, n, 0, 1, 1, color), gb.vertex(e.x, y0, e.z, 0, n, 0, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, n, 0);
}

/** Vertical quad along the deck at lateral v from s0 to s1, bottom/top heights at each end, facing `out` (+1: to the right). */
function side(gb: GeoBuilder, c: RailCurve, s0: number, s1: number, v: number, yb0: number, yt0: number, yb1: number, yt1: number, out: number, color: THREE.Color): void {
  const P = curvePoint();
  const a = at(c, s0, v, P);
  const nx = -P.tz * out;
  const nz = P.tx * out;
  const b = at(c, s1, v);
  const ids = [gb.vertex(a.x, yb0, a.z, nx, 0, nz, 0, 0, color), gb.vertex(b.x, yb1, b.z, nx, 0, nz, 1, 0, color), gb.vertex(b.x, yt1, b.z, nx, 0, nz, 1, 1, color), gb.vertex(a.x, yt0, a.z, nx, 0, nz, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
}

/** A bar along the deck between laterals v0 < v1, from the deck's height up by h: its top and both long faces. */
function bar(gb: GeoBuilder, c: RailCurve, s0: number, s1: number, v0: number, v1: number, y0: number, y1: number, h: number, color: THREE.Color): void {
  band(gb, c, s0, s1, v0, v1, y0 + h, y1 + h, color);
  side(gb, c, s0, s1, v0, y0, y0 + h, y1, y1 + h, -1, color);
  side(gb, c, s0, s1, v1, y0, y0 + h, y1, y1 + h, 1, color);
}

/** An additive light pool, draped on `y` (rings of a disc fading out). */
function pool(gb: GeoBuilder, x: number, z: number, y: (x: number, z: number) => number, r: number, color: THREE.Color): void {
  const tint = new THREE.Color();
  const rings = 3;
  const segs = 12;
  const vertex = (px: number, pz: number, t: number) => gb.vertex(px, y(px, pz) + 0.06, pz, 0, 1, 0, 0, 0, tint.copy(color).multiplyScalar((1 - t * t) ** 2));
  const mid = vertex(x, z, 0);
  let prev: number[] = [];
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    const ring: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      ring.push(vertex(x + Math.cos(a) * r * t, z + Math.sin(a) * r * t, t));
    }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      if (k === 1) gb.triFacing(mid, ring[i], ring[j], 0, 1, 0);
      else gb.quadFacing(prev[i], prev[j], ring[j], ring[i], 0, 1, 0);
    }
    prev = ring;
  }
}

export const highwayRenderer: DistrictRenderer = {
  kinds: ['highway'],
  build(kit, areas) {
    const decks = areas.filter((a) => a.variant === 'deck');
    if (!decks.length) return;
    const signs = new GeoBuilder(true);
    const wash = kit.quality !== 'low' ? new GeoBuilder(true) : null;
    for (const a of decks) {
      const d = highwayDeck(a, kit.world.areas);
      if (!d.settled) continue;
      deck(kit, a, d, signs, wash);
      for (const r of d.ramps) ramp(kit, d, r, signs, wash);
    }
    if (signs.vertexCount) {
      const map = kit.track(makeStructureSigns());
      const m = new THREE.Mesh(kit.track(signs.build()), kit.track(new THREE.MeshBasicMaterial({ map, vertexColors: true })));
      m.name = 'highwaySigns';
      kit.group.add(m);
    }
    if (wash?.vertexCount) {
      const m = new THREE.Mesh(kit.track(wash.build()), kit.track(washMaterial()));
      m.name = 'highwayPools';
      m.renderOrder = 1;
      kit.group.add(m);
    }
  },
};

/** The pieces of [s0, s1] outside the median's crossovers (low to high). */
function medianRuns(s0: number, s1: number, gaps: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let from = s0;
  for (const [g0, g1] of gaps) {
    if (g1 <= from || g0 >= s1) continue;
    if (g0 > from) out.push([from, g0]);
    from = Math.max(from, g1);
  }
  if (from < s1) out.push([from, s1]);
  return out;
}

/** Where the median lamp posts stand along the deck (s, m): every HW.postEvery, none in a crossover. */
function medianPosts(d: HighwayDeck): number[] {
  const out: number[] = [];
  for (let s = RAIL.step + HW.postEvery / 2; s < d.curve.length - RAIL.step; s += HW.postEvery) if (!inMedianGap(d, s, 3)) out.push(s);
  return out;
}

/** A ramp's surface at lateral v (left of travel), u along it: what the sim drives. */
function rampSurface(r: HighwayRamp): (u: number, v: number) => { x: number; y: number; z: number } {
  const ax = r.axis;
  const ap = axisPoint();
  const sample = { h: 0, gx: 0, gz: 0 };
  return (u, v) => {
    const q = axisAt(ax, u);
    const x = q.x - q.tz * v;
    const z = q.z + q.tx * v;
    projectAxis(ax, x, z, ap);
    rampHeight(ax, r.profile, r.terrain, x, z, ap, sample);
    return { x, y: sample.h, z };
  };
}

/**
 * The expressway's lamps for the real light pool (scene.ts NightLighting): one per median post between
 * the closures, at its heads (it lights both carriageways), and every ramp lamp head.
 */
export function highwayLamps(world: World): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const P = curvePoint();
  for (const a of world.areas) {
    if (a.kind !== 'highway' || a.variant !== 'deck') continue;
    const d = highwayDeck(a, world.areas);
    if (!d.settled) continue;
    for (const s of medianPosts(d)) {
      if (s < d.sW || s > d.sE) continue;
      sampleCurve(d.curve, s, P);
      out.push(new THREE.Vector3(P.x, deckTopAt(d, s) + HW.postH - 0.3, P.z));
    }
    for (const r of d.ramps) {
      const surf = rampSurface(r);
      const inner = rampInnerSign(r, d.curve);
      for (let u = 12; u < r.axis.length; u += HW.rampPostEvery) {
        const p = surf(u, -inner * (CFG.rampHalf + 0.175));
        const h = surf(u, -inner * (CFG.rampHalf - 1.6));
        out.push(new THREE.Vector3(h.x, p.y + 1 + HW.rampPostH - 0.2, h.z));
      }
    }
  }
  return out;
}

/** The deck's surface extent on `side` at s (m): its half width, out to a merging ramp's outer wall. */
function extent(d: HighwayDeck, s: number, sd: 1 | -1): number {
  let e = HALF;
  for (const r of d.ramps) {
    if (r.side !== sd) continue;
    const sEnd = r.sb + r.side * 7;
    if (s < Math.min(r.sa, sEnd) || s > Math.max(r.sa, sEnd)) continue;
    e = Math.max(e, rampOuterAt(r, s) + 0.25);
  }
  return e;
}

function deck(kit: DistrictKit, area: Area, d: HighwayDeck, signs: GeoBuilder, wash: GeoBuilder | null): void {
  const c = d.curve;
  const low = kit.quality === 'low';
  const step = low ? HW.pieceLow : HW.piece;
  const s0 = RAIL.step;
  const s1 = c.length - RAIL.step;
  const solid = kit.solid;
  const paint = kit.paint;
  const mh = CFG.median / 2;
  // Lines across each carriageway: the inner edge (yellow, the inner shoulder inside it), the dashed lane
  // dividers, the outer edge (the wide outer shoulder beyond it).
  const innerLine = LANES_IN;
  const dividers = Array.from({ length: CFG.lanes - 1 }, (_, k) => LANES_IN + (k + 1) * CFG.lane);
  const outerLine = LANES_IN + CFG.lanes * CFG.lane;
  const gaps = medianGaps(d);
  // ----- The deck, piece by piece.
  for (let s = s0; s < s1 - 1e-6; s += step) {
    const e = Math.min(s1, s + step);
    const t0 = deckTopAt(d, s);
    const t1 = deckTopAt(d, e);
    const u0 = deckUnderAt(d, s);
    const u1 = deckUnderAt(d, e);
    const eR0 = extent(d, s, 1);
    const eR1 = extent(d, e, 1);
    const eL0 = extent(d, s, -1);
    const eL1 = extent(d, e, -1);
    const eR = Math.max(eR0, eR1);
    const eL = Math.max(eL0, eL1);
    band(solid, c, s, e, -eL, eR, t0, t1, C.top);
    band(solid, c, s, e, -eL, eR, u0, u1, C.soffit, false);
    side(solid, c, s, e, eR, u0, t0 + 0.05, u1, t1 + 0.05, 1, C.fascia);
    side(solid, c, s, e, -eL, u0, t0 + 0.05, u1, t1 + 0.05, -1, C.fascia);
    for (const sd of [1, -1] as const) {
      if (barrierOpen(d, s, e, sd) || extent(d, (s + e) / 2, sd) > HALF + 0.5) continue;
      const v0 = sd > 0 ? HALF - HW.barrierW : -HALF;
      bar(solid, c, s, e, v0, v0 + HW.barrierW, t0, t1, HW.barrierH, C.barrier);
    }
    // The median, broken at its crossovers (as the sim's, build.ts), a crash cushion at each end there.
    for (const [m0, m1] of medianRuns(s, e, gaps)) {
      const y0 = deckTopAt(d, m0);
      const y1 = deckTopAt(d, m1);
      const atGap = (q: number) => gaps.some(([g0, g1]) => Math.abs(q - g0) < HW.cushion || Math.abs(q - g1) < HW.cushion);
      bar(solid, c, m0, m1, -mh, mh, y0, y1, HW.medianH, atGap(m0) || atGap(m1) ? C.cushion : C.barrier);
    }
    // Lane lines: the inner edge's yellow, the outer edge (dashed where a ramp merges).
    for (const sd of [1, -1]) {
      band(paint, c, s, e, sd * innerLine - HW.line / 2, sd * innerLine + HW.line / 2, t0 + 0.02, t1 + 0.02, C.yellow);
      const merging = extent(d, (s + e) / 2, sd > 0 ? 1 : -1) > HALF + 0.5;
      if (!merging) band(paint, c, s, e, sd * outerLine - HW.line / 2, sd * outerLine + HW.line / 2, t0 + 0.02, t1 + 0.02, C.white);
    }
  }
  for (let s = s0; s < s1 - HW.dash; s += HW.period) {
    const e = s + HW.dash;
    for (const sd of [1, -1] as const) {
      for (const v of dividers) band(paint, c, s, e, sd * v - HW.line / 2, sd * v + HW.line / 2, deckTopAt(d, s) + 0.02, deckTopAt(d, e) + 0.02, C.white);
      if (extent(d, s + HW.dash / 2, sd) > HALF + 0.5) band(paint, c, s, e, sd * outerLine - HW.line / 2, sd * outerLine + HW.line / 2, deckTopAt(d, s) + 0.02, deckTopAt(d, e) + 0.02, C.white);
    }
  }

  // ----- Columns: the sim's bents and outriggers; render-only hammerheads past the city.
  const b = kit.builds[area.id];
  const sOf = (x: number, z: number) => projectOnCurve(c, x, z).s;
  const hh = CFG.columnSize / 2;
  for (const p of b.props) {
    if (p.kind === 'bent') {
      const dx = Math.sin(p.yaw);
      const dz = Math.cos(p.yaw);
      const top = deckUnderAt(d, sOf(p.x, p.z));
      const nx = dz;
      const nz = -dx;
      const cols = [1, -1].map((k) => ({ x: p.x + nx * p.size * k, z: p.z + nz * p.size * k }));
      for (const q of cols) {
        const g = kit.h(q.x, q.z);
        orientedBox(solid, q.x - dx * hh - nx * hh, q.z - dz * hh - nz * hh, q.x + dx * hh - nx * hh, q.z + dz * hh - nz * hh, nx * 2 * hh, nz * 2 * hh, g - 0.3, top - HW.capH + 0.05, C.concrete);
      }
      const w = HW.capW / 2;
      const a = cols[0];
      const e = cols[1];
      orientedBox(solid, a.x - dx * w + nx * hh, a.z - dz * w + nz * hh, e.x - dx * w - nx * hh, e.z - dz * w - nz * hh, dx * 2 * w, dz * 2 * w, top - HW.capH, top, C.concrete);
    } else if (p.kind === 'outrigger') {
      const dx = Math.sin(p.yaw);
      const dz = Math.cos(p.yaw);
      const top = deckUnderAt(d, sOf(p.x, p.z));
      const g = kit.h(p.x, p.z);
      orientedBox(solid, p.x - dx * hh - dz * hh, p.z - dz * hh + dx * hh, p.x + dx * hh - dz * hh, p.z + dz * hh + dx * hh, dz * 2 * hh, -dx * 2 * hh, g - 0.3, top, C.concrete);
    }
  }
  for (let s = d.sW - HW.runOffFrom; s > 2 * RAIL.step; s -= HW.runOffEvery) {
    const q = at(c, s, 0);
    hammerhead(kit, d, s, q.x, q.z, CFG.pierRadius);
  }
  for (let s = d.sE + HW.runOffFrom; s < c.length - 2 * RAIL.step; s += HW.runOffEvery) {
    const q = at(c, s, 0);
    hammerhead(kit, d, s, q.x, q.z, CFG.pierRadius);
  }
  // ----- Light: tall median lamp posts with two heads (none in a crossover), amber delineators on the
  // parapets, two rows of sodium lamps under the soffit each side.
  const P = curvePoint();
  for (const s of medianPosts(d)) {
    sampleCurve(c, s, P);
    const top = deckTopAt(d, s);
    const y = top + HW.postH;
    cylinder(solid, P.x, P.z, 0.13, top + HW.medianH, y + 0.2, 6, C.steel, false, 0.09);
    for (const sd of [1, -1]) {
      const h = at(c, s, sd * HW.arm);
      orientedBox(solid, P.x, P.z, h.x, h.z, P.tx * 0.12, P.tz * 0.12, y, y + 0.12, C.steel);
      const q = at(c, s, sd * (HW.arm + 0.3));
      orientedBox(kit.glow, q.x - P.tx * 0.5, q.z - P.tz * 0.5, q.x + P.tx * 0.5, q.z + P.tz * 0.5, -P.tz * 0.3 * sd, P.tx * 0.3 * sd, y - 0.22, y - 0.02, LAMP.head);
      if (wash && s > d.sW && s < d.sE) {
        const p = at(c, s, sd * laneCenter(1));
        pool(wash, p.x, p.z, () => top, HW.deckPool.r, HW.deckPool.color);
      }
    }
  }
  if (!low) {
    for (let s = d.sW + 2; s < d.sE; s += HW.delineatorEvery) {
      const top = deckTopAt(d, s);
      for (const sd of [1, -1] as const) {
        if (barrierOpen(d, s - 1, s + 1, sd) || extent(d, s, sd) > HALF + 0.5) continue;
        const q = at(c, s, sd * (HALF - HW.barrierW - 0.02));
        cylinder(kit.glow, q.x, q.z, 0.07, top + HW.barrierH - 0.25, top + HW.barrierH - 0.1, 4, LAMP.amber, true);
      }
    }
  }
  for (let s = d.sW + HW.soffitEvery / 2; s < d.sE; s += HW.soffitEvery) {
    const u = deckUnderAt(d, s);
    for (const sd of [1, -1]) {
      for (const v of HW.soffitRows) {
        const q = at(c, s, sd * v);
        cylinder(kit.glow, q.x, q.z, 0.3, u - 0.12, u - 0.02, 6, LAMP.sodium, true);
        if (wash) pool(wash, q.x, q.z, (x, z) => kit.world.driveHeightAt(x, z), HW.streetPool.r, HW.streetPool.color);
      }
    }
  }

  // ----- Sign gantries across both carriageways, clear of the ramps' merges and the El's hump.
  const near = (s: number) => d.ramps.some((r) => {
    const [lo, hi] = mergeRange(r);
    return s > Math.min(lo, r.sa) - HW.gantryClear && s < Math.max(hi, r.sa) + HW.gantryClear;
  }) || (Number.isFinite(d.sEl) && Math.abs(s - d.sEl) < 120);
  let k = (area.params.seed ?? 0) % GANTRY_SIGNS.length;
  for (let s = d.sW + 180; s < d.sE - 150; s += CFG.signEvery) {
    let sg = s;
    for (let tries = 0; tries < 6 && near(sg); tries++) sg += 30;
    if (near(sg) || sg > d.sE - 120) continue;
    sampleCurve(c, sg, P);
    const top = deckTopAt(d, sg);
    const f: Frame = { cx: P.x, cz: P.z, ux: P.tx, uz: P.tz };
    const kk = k;
    signGantry(solid, kit.glow, signs, f, {
      legV: HALF - HW.barrierW / 2,
      road: HALF - 1,
      legBase: () => top + HW.barrierH,
      y0: top + 6.3,
      cell: (end, i) => gantryCell((kk + (end > 0 ? 0 : 3) + i) % GANTRY_SIGNS.length),
      count: 2,
      board: false,
    }, low);
    k += 1;
  }

  // ----- The closures at both ends: a barrier row, crash cushions, END EXPRESSWAY and red lamps.
  for (const [s, dir] of [
    [d.sW, -1],
    [d.sE, 1],
  ] as const) {
    const top = deckTopAt(d, s);
    const sIn = s - dir * 1.4;
    const a = Math.min(s, sIn);
    const e = Math.max(s, sIn);
    for (let v = -HALF; v < HALF - 1e-6; v += 2) bar(solid, c, a, e, v, Math.min(HALF, v + 2), top, top, 1.1, C.barrier);
    for (const v of Array.from({ length: CFG.lanes }, (_, k) => laneCenter(k)).flatMap((l) => [-l, l])) {
      const q0 = at(c, sIn - dir * 0.2, v - 0.7);
      const q1 = at(c, sIn - dir * 0.2, v + 0.7);
      sampleCurve(c, sIn, P);
      orientedBox(solid, q0.x, q0.z, q1.x, q1.z, -P.tx * dir * 2.4, -P.tz * dir * 2.4, top, top + 0.9, C.cushion);
    }
    sampleCurve(c, sIn, P);
    const sp = at(c, sIn - dir * 0.3, 0);
    // Facing back along the deck, toward the cars coming at it.
    signPanel(signs, sp.x, top + 3.1, sp.z, -P.tx * dir, -P.tz * dir, 10, 2.5, END_CELL, col(0xffffff, 0.85));
    for (const v of [-4, 4]) {
      const q = at(c, sIn, v);
      cylinder(solid, q.x, q.z, 0.08, top + 1.1, top + 4.2, 5, C.steel, false);
    }
    for (let v = -HALF + 0.8; v < HALF; v += 2.2) {
      const q = at(c, (a + e) / 2, v);
      cylinder(kit.glow, q.x, q.z, 0.12, top + 1.1, top + 1.3, 6, v === -HALF + 0.8 || v > HALF - 2.3 ? LAMP.amber : LAMP.red, true);
    }
  }
}

/** A hammerhead: a round column and a cap across the deck's width under it. */
function hammerhead(kit: DistrictKit, d: HighwayDeck, s: number, x: number, z: number, r: number): void {
  const c = d.curve;
  const u = deckUnderAt(d, s);
  cylinder(kit.solid, x, z, r, kit.h(x, z) - 0.3, u - HW.capH + 0.05, 10, C.concrete, false);
  const w = HW.capW / 2;
  band(kit.solid, c, s - w, s + w, -(HALF - 1.2), HALF - 1.2, u - HW.capH, u - HW.capH, C.concrete, false);
  for (const sd of [1, -1]) side(kit.solid, c, s - w, s + w, sd * (HALF - 1.2), u - HW.capH, u, u - HW.capH, u, sd, C.concrete);
  for (const e of [-w, w]) {
    const a = at(c, s + e, -(HALF - 1.2));
    const b = at(c, s + e, HALF - 1.2);
    const P = curvePoint();
    sampleCurve(c, s + e, P);
    const n = e > 0 ? 1 : -1;
    const ids = [kit.solid.vertex(a.x, u - HW.capH, a.z, P.tx * n, 0, P.tz * n, 0, 0, C.concrete), kit.solid.vertex(b.x, u - HW.capH, b.z, P.tx * n, 0, P.tz * n, 1, 0, C.concrete), kit.solid.vertex(b.x, u, b.z, P.tx * n, 0, P.tz * n, 1, 1, C.concrete), kit.solid.vertex(a.x, u, a.z, P.tx * n, 0, P.tz * n, 0, 1, C.concrete)];
    kit.solid.quadFacing(ids[0], ids[1], ids[2], ids[3], P.tx * n, 0, P.tz * n);
  }
}

function ramp(kit: DistrictKit, d: HighwayDeck, r: HighwayRamp, signs: GeoBuilder, wash: GeoBuilder | null): void {
  const ax = r.axis;
  const L = ax.length;
  const hw = CFG.rampHalf;
  const c = d.curve;
  const solid = kit.solid;
  const low = kit.quality === 'low';
  const surf = rampSurface(r);
  const inner = rampInnerSign(r, c);
  const uc = Math.max(4, r.uSolid);
  const step = 3;
  const wt = 0.35;
  for (let u = 0; u < L - 1e-6; u += step) {
    const e = Math.min(L, u + step);
    // The asphalt, edge to edge between the walls.
    const a0 = surf(u, -hw);
    const a1 = surf(e, -hw);
    const b1 = surf(e, hw);
    const b0 = surf(u, hw);
    const ids = [solid.vertex(a0.x, a0.y + 0.01, a0.z, 0, 1, 0, 0, 0, C.top), solid.vertex(a1.x, a1.y + 0.01, a1.z, 0, 1, 0, 1, 0, C.top), solid.vertex(b1.x, b1.y + 0.01, b1.z, 0, 1, 0, 1, 1, C.top), solid.vertex(b0.x, b0.y + 0.01, b0.z, 0, 1, 0, 0, 1, C.top)];
    solid.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    const bridge = u >= uc;
    // The walls: retaining walls to the ground on the embankment, parapets on the bridge at its top.
    for (const k of [-1, 1]) {
      const v0 = k * hw;
      const v1 = k * (hw + wt);
      const p0 = surf(u, v0);
      const p1 = surf(e, v0);
      const q0 = surf(u, v1);
      const q1 = surf(e, v1);
      const g0 = bridge ? p0.y - 1.4 : Math.min(kit.h(q0.x, q0.z), p0.y) - 0.3;
      const g1 = bridge ? p1.y - 1.4 : Math.min(kit.h(q1.x, q1.z), p1.y) - 0.3;
      const nx = q0.x - p0.x;
      const nz = q0.z - p0.z;
      const nl = Math.hypot(nx, nz) || 1;
      // Outer face (toward the outside) from its foot to the coping, the inner face from the surface, and the coping.
      const quad = (pa: { x: number; z: number }, pb: { x: number; z: number }, ya0: number, ya1: number, yb0: number, yb1: number, fx: number, fz: number) => {
        const ii = [solid.vertex(pa.x, ya0, pa.z, fx, 0, fz, 0, 0, C.wall), solid.vertex(pb.x, yb0, pb.z, fx, 0, fz, 1, 0, C.wall), solid.vertex(pb.x, yb1, pb.z, fx, 0, fz, 1, 1, C.wall), solid.vertex(pa.x, ya1, pa.z, fx, 0, fz, 0, 1, C.wall)];
        solid.quadFacing(ii[0], ii[1], ii[2], ii[3], fx, 0, fz);
      };
      quad(q0, q1, g0, p0.y + 1, g1, p1.y + 1, nx / nl, nz / nl);
      quad(p0, p1, p0.y, p0.y + 1, p1.y, p1.y + 1, -nx / nl, -nz / nl);
      band3(solid, p0, p1, q1, q0, 1, C.barrier);
      if (bridge) {
        // The soffit of the bridge stretch, under the asphalt.
        const ii = [solid.vertex(a0.x, a0.y - 1.4, a0.z, 0, -1, 0, 0, 0, C.soffit), solid.vertex(a1.x, a1.y - 1.4, a1.z, 0, -1, 0, 1, 0, C.soffit), solid.vertex(b1.x, b1.y - 1.4, b1.z, 0, -1, 0, 1, 1, C.soffit), solid.vertex(b0.x, b0.y - 1.4, b0.z, 0, -1, 0, 0, 1, C.soffit)];
        if (k === 1) solid.quadFacing(ii[0], ii[1], ii[2], ii[3], 0, -1, 0);
      }
    }
  }
  // The embankment's end where the bridge stretch begins, and the column under the bridge.
  {
    const a = surf(uc, -hw - wt);
    const b = surf(uc, hw + wt);
    const ga = kit.h(a.x, a.z);
    const gb = kit.h(b.x, b.z);
    const q = axisAt(ax, uc);
    const ids = [solid.vertex(a.x, ga - 0.3, a.z, q.tx, 0, q.tz, 0, 0, C.wall), solid.vertex(b.x, gb - 0.3, b.z, q.tx, 0, q.tz, 1, 0, C.wall), solid.vertex(b.x, b.y - 1.4, b.z, q.tx, 0, q.tz, 1, 1, C.wall), solid.vertex(a.x, a.y - 1.4, a.z, q.tx, 0, q.tz, 0, 1, C.wall)];
    solid.quadFacing(ids[0], ids[1], ids[2], ids[3], q.tx, 0, q.tz);
  }
  for (const p of kit.builds[r.area.id].props) {
    if (p.kind !== 'rampColumn') continue;
    cylinder(solid, p.x, p.z, p.size, kit.h(p.x, p.z) - 0.3, surf(p.height, 0).y - 1.4, 10, C.concrete, false);
  }
  // The merge's outer wall along the widened deck, and the taper back to the deck's edge.
  const sEnd = r.sb + r.side * 7;
  const n = Math.max(2, Math.ceil(Math.abs(sEnd - r.sa) / 4));
  for (let k = 0; k < n; k++) {
    const sa = r.sa + ((sEnd - r.sa) * k) / n;
    const sb = r.sa + ((sEnd - r.sa) * (k + 1)) / n;
    const v0 = r.side * rampOuterAt(r, sa);
    const v1 = r.side * rampOuterAt(r, sb);
    const a = at(c, sa, v0);
    const e = at(c, sb, v1);
    const ta = deckTopAt(d, sa);
    const tb = deckTopAt(d, sb);
    const nx = e.z - a.z;
    const nz = -(e.x - a.x);
    const nl = Math.hypot(nx, nz) || 1;
    orientedBox(solid, a.x - (nx / nl) * 0.17, a.z - (nz / nl) * 0.17, e.x - (nx / nl) * 0.17, e.z - (nz / nl) * 0.17, (nx / nl) * 0.35, (nz / nl) * 0.35, Math.min(ta, tb) - 0.1, Math.max(ta, tb) + HW.barrierH, C.barrier);
  }
  // The wall along the building line under the ramp's top: from the sidewalk up to the soffit.
  const [f0, f1] = rampFront(r, c) ?? [0, 0];
  for (let s = f0; s < f1 - 1e-6; s += 4) {
    const e = Math.min(f1, s + 4);
    const a = at(c, s, r.side * r.building);
    const b = at(c, e, r.side * r.building);
    const ya = deckUnderAt(d, s);
    const yb = deckUnderAt(d, e);
    const P = curvePoint();
    sampleCurve(c, s, P);
    const fx = P.tz * r.side;
    const fz = -P.tx * r.side;
    const ga = kit.h(a.x, a.z) - 0.3;
    const gb = kit.h(b.x, b.z) - 0.3;
    const ids = [solid.vertex(a.x, ga, a.z, fx, 0, fz, 0, 0, C.wall), solid.vertex(b.x, gb, b.z, fx, 0, fz, 1, 0, C.wall), solid.vertex(b.x, yb, b.z, fx, 0, fz, 1, 1, C.wall), solid.vertex(a.x, ya, a.z, fx, 0, fz, 0, 1, C.wall)];
    solid.quadFacing(ids[0], ids[1], ids[2], ids[3], fx, 0, fz);
  }
  // Lamp posts on the outer wall, their pools on the asphalt (Medium and up).
  for (let u = 12; u < L; u += HW.rampPostEvery) {
    const v = -inner * (hw + wt / 2);
    const p = surf(u, v);
    const top = p.y + 1 + HW.rampPostH;
    cylinder(solid, p.x, p.z, 0.09, p.y + 1, top, 6, C.steel, false, 0.07);
    const h = surf(u, -inner * (hw - 1.6));
    orientedBox(solid, p.x, p.z, h.x, h.z, 0.08, 0.08, top - 0.1, top, C.steel);
    cylinder(kit.glow, h.x, h.z, 0.24, top - 0.25, top - 0.08, 6, LAMP.head, true);
    if (wash) {
      const g = surf(u, -inner * (hw - 2.4));
      const ground = g.y;
      pool(wash, g.x, g.z, () => ground, 7, HW.deckPool.color);
    }
  }
  // A double yellow line up the middle and the lanes' arrows (up on the right, down on the left).
  const paint = kit.paint;
  for (let u = 4; u < L - 1e-6; u += step) {
    const e = Math.min(L, u + step);
    for (const v of [-0.18, 0.18]) {
      const a0 = surf(u, v - 0.06);
      const a1 = surf(e, v - 0.06);
      const b1 = surf(e, v + 0.06);
      const b0 = surf(u, v + 0.06);
      const ids = [paint.vertex(a0.x, a0.y + 0.03, a0.z, 0, 1, 0, 0, 0, C.yellow), paint.vertex(a1.x, a1.y + 0.03, a1.z, 0, 1, 0, 1, 0, C.yellow), paint.vertex(b1.x, b1.y + 0.03, b1.z, 0, 1, 0, 1, 1, C.yellow), paint.vertex(b0.x, b0.y + 0.03, b0.z, 0, 1, 0, 0, 1, C.yellow)];
      paint.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    }
  }
  for (let u = 14; u < L - 10; u += low ? 60 : 32) {
    arrow(paint, surf, u, -hw / 2, 1);
    arrow(paint, surf, u + 6, hw / 2, -1);
  }
  // The mouth: EXPRESSWAY ON RAMP on a mast on the right hand wall, facing the street.
  {
    const p = surf(5, -(hw + wt / 2));
    const y = p.y + 1;
    cylinder(solid, p.x, p.z, 0.1, y, y + 4.2, 6, C.steel, false);
    const s = surf(5, -(hw - 1.6));
    signPanel(signs, s.x, y + 3.4, s.z, -ax.dx, -ax.dz, 4.4, 1.3, RAMP_CELL, col(0xffffff, 0.9));
    cylinder(kit.glow, s.x - ax.dx * 0.3, s.z - ax.dz * 0.3, 0.12, y + 4.15, y + 4.3, 6, LAMP.head, true);
  }
  // Closed in a race: a cyan barrier across the mouth where the sim's gate stands (highwayGates).
  if (!kit.world.openWorld) {
    const a = surf(1.7, -(hw + 0.4));
    const b = surf(1.7, hw + 0.4);
    for (const y of [0.45, 0.95]) {
      const ga = a.y + y;
      const gb = b.y + y;
      orientedBox(kit.glow, a.x, a.z, b.x, b.z, ax.dx * 0.18, ax.dz * 0.18, Math.min(ga, gb), Math.max(ga, gb) + 0.12, LAMP.cyan);
    }
    for (let t = 0; t <= 1.0001; t += 0.25) {
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      cylinder(solid, x, z, 0.07, Math.min(a.y, b.y) - 0.1, Math.max(a.y, b.y) + 1.15, 5, C.post, false);
    }
    const m = surf(1.6, 0);
    signPanel(signs, m.x - ax.dx * 0.2, m.y + 1.75, m.z - ax.dz * 0.2, -ax.dx, -ax.dz, 3.6, 0.9, CLOSED_CELL, col(0xffffff, 0.85));
  }
}

/** A quad through four points with heights, facing up (+1) or down. */
function band3(gb: GeoBuilder, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, c: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, lift: number, color: THREE.Color): void {
  const ids = [gb.vertex(a.x, a.y + lift, a.z, 0, 1, 0, 0, 0, color), gb.vertex(b.x, b.y + lift, b.z, 0, 1, 0, 1, 0, color), gb.vertex(c.x, c.y + lift, c.z, 0, 1, 0, 1, 1, color), gb.vertex(d.x, d.y + lift, d.z, 0, 1, 0, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
}

/** A lane arrow painted on the ramp at (u, v), pointing up the ramp (dir +1) or down it. */
function arrow(gb: GeoBuilder, surf: (u: number, v: number) => { x: number; y: number; z: number }, u: number, v: number, dir: number): void {
  const len = 4.2;
  const head = 1.6;
  const tail = u - (dir * len) / 2;
  const tip = u + (dir * len) / 2;
  const neck = tip - dir * head;
  const q = (pts: { x: number; y: number; z: number }[]) => {
    const ids = pts.map((p) => gb.vertex(p.x, p.y + 0.035, p.z, 0, 1, 0, 0, 0, C.white));
    if (ids.length === 4) gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    else gb.triFacing(ids[0], ids[1], ids[2], 0, 1, 0);
  };
  q([surf(tail, v - 0.15), surf(neck, v - 0.15), surf(neck, v + 0.15), surf(tail, v + 0.15)]);
  q([surf(neck, v - 0.65), surf(tip, v), surf(neck, v + 0.65)]);
}
