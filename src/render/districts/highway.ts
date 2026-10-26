/**
 * Elevated highway renderer (city/districts/highway/), built on the deck's
 * settled curve (highwayDeck: the same samples the sim's spans and walls
 * were cut from) so what is drawn is what is driven:
 *  - the deck over its drivable stretch, between the end loops: a concrete
 *    box girder (fascia, soffit, an end face at both ends under the loops'
 *    tops), its asphalt top with lane lines (three lanes each way, the
 *    shoulders' edge lines: yellow by the median, white outside), parapets
 *    along both edges in the sim's own pieces (open along an interchange
 *    ramp's lane: the deck widened there to the sim's width, the lane's wall
 *    and its taper standing on it, the edge line dashed and a solid one
 *    inside the lane's wall), and the median barrier, broken at its
 *    crossovers, a crash cushion at each of its ends;
 *  - the V at both ends: the median stops short of the deck's end and its
 *    two barriers fan out to the end loops' outer walls, white chevrons in
 *    the gore between them and a low parapet closing it at the deck's end,
 *    the lane lines easing into the loops' (the lane by the median dropped);
 *  - columns: the sim's bents (a square column on each sidewalk and a cap
 *    beam across the street under the deck) and, under a lane's widened
 *    deck, an outer column behind its alley with a cap beam out to it;
 *  - light, so the expressway reads as the brightest road in the city: tall
 *    twin headed lamp posts down the median (none in the V), amber
 *    delineators along the parapets, two rows of sodium lamps under the
 *    soffit lighting the street beneath and a row under each lane lighting
 *    its alley; on Medium and up their pools on the deck and the ground
 *    below (one additive mesh, as the El's and the viaducts'), and the median
 *    lamps, every other lane lamp and the ramps' join the real light pool
 *    (highwayLamps, scene.ts) so a car up there is lit as on the streets;
 *  - signs: gantries across both carriageways (structureFx.ts signGantry,
 *    the direction signs once on city streets) and, on a cantilever over one
 *    carriageway, EXIT before every off-ramp's lane and END EXPRESSWAY before
 *    each end, where all traffic leaves on the loops;
 *  - the ramps, all one way: an interchange's slip ramps alongside the deck
 *    (the off-ramp comes down beside it to run along the street beneath at
 *    its level just short of a junction, the on-ramp peels off the street
 *    just past it and climbs to its lane), and the end loops, three quarters
 *    of a circle each down to (or up from) the street beneath. Each: the
 *    asphalt on the ramp's exact surface, an embankment between retaining
 *    walls up to where it leaves its block, a bridge from there on (its
 *    columns under a loop's axis, beside a slip ramp's outer edge under a cap
 *    beam), walls from where the sim's start (a slip ramp's open to the street
 *    along its run, its nose closed by a slanted low wall), a slip ramp's
 *    lane wall and sodium lamps under its bridge, lamp posts, a dashed lane
 *    divider and arrows the way its traffic runs, EXPRESSWAY ON RAMP or WRONG
 *    WAY facing the street's traffic where it turns in; inside a loop a grass
 *    infield with a few trees;
 *  - the alleys under the lanes and the slip ramps' bridges: the sim's
 *    paving pieces in asphalt with an edge line along the back wall (the
 *    wall is the city's boundary wall, infill.ts draws it);
 *  - in a race (settle.ts highwayGates: an alley where it opens onto a
 *    street off the route) a cyan barrier across every gate; the ramps and
 *    loops stay open.
 * Everything merges into the kit's solid, ground, paint, glow and tree
 * builders; signs and the light pools are one mesh each for the whole city.
 * Built once per scene: nothing here runs per frame. Low draws coarser deck
 * pieces, no gantry or cantilever diagonals, no lane dashes on the ramps, no
 * delineators and no pools.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area } from '../../city/districts/types';
import type { Frame } from '../../city/districts/structures';
import { toWorld } from '../../city/districts/structures';
import { GORE, HIGHWAY_HALF, HighwayDeck, HighwayRamp, LANES_IN, LOOP_AT, RAMP_WALL, TAPER, barrierOpen, deckCurve, deckExtent, deckTopAt, deckUnderAt, highwayDeck, inMedianGap, laneCenter, laneRange, medianGaps, projectNear, rampFront, rampInnerSign, rampOuterAt, vGoreAt, vStart } from '../../city/districts/highway/shape';
import { alleyMouths } from '../../city/districts/highway/alleys';
import { SLIP_NOSE } from '../../city/districts/highway/rampPlan';
import type { World } from '../../city/world';
import type { RampAxis } from '../../city/districts/highway/rampAxis';
import { axisAt, axisPoint, rampHeight } from '../../city/districts/highway/rampAxis';
import { clipConvex } from '../../city/districts/geom';
import { RAIL, RailCurve, curvePoint, projectOnCurve, sampleCurve } from '../../city/railCurve';
import { Rng } from '../../sim/prng';
import type { Vec2 } from '../../sim/math';
import type { Cell } from './structureFx';
import { CLOSED_CELL, END_CELL, EXIT_CELL, GANTRY_SIGNS, RAMP_CELL, WRONG_WAY_CELL, beam, frameBox, gantryCell, makeStructureSigns, signGantry, signPanel } from './structureFx';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, orientedBox } from './kit';
import { tree } from './trees';
import { washMaterial } from '../materialFx';

const CFG = CITY.districts.highway;
const HALF = HIGHWAY_HALF;

const HW = {
  /** Deck piece length (m), Medium and up / Low. */
  piece: 6,
  pieceLow: 10,
  /** Parapets in the sim's own pieces, this many curve samples each (build.ts CHUNK): the one drawn opens where the one driven does. */
  chunk: 3,
  /** Jersey barrier: width and height (m); the median's height; the V's barriers' width (m, build.ts's slabs). */
  barrierW: 0.45,
  barrierH: 1.0,
  medianH: 0.9,
  vBarrierW: 0.5,
  /** Lane lines: width (m), the dashes' length and period (m). */
  line: 0.15,
  dash: 3,
  period: 9,
  /** A lane's solid edge line stands this far inside its wall (m); over the V a divider ends where its lane narrows under this (m). */
  laneEdge: 0.6,
  laneDrop: 2.2,
  /** The V's chevrons: one every this far (m), from this far past the V's start (m), each arm this long along the deck and this wide (m). */
  chevronEvery: 5,
  chevronFrom: 6,
  chevronArm: 3,
  chevronW: 0.3,
  /** Median lamp posts: spacing (m), height over the deck (m), arm reach (m: the heads over the middle lanes). */
  postEvery: 32,
  postH: 12,
  arm: 6.2,
  /** Amber delineators along the parapets every this far (m, Medium and up). */
  delineatorEvery: 12,
  /** Sodium lamps under the soffit every this far (m), in two rows each side this far out (m); under a lane's widened deck and a slip ramp's bridge every this far (m), over the alley there. */
  soffitEvery: 26,
  soffitRows: [5, 11],
  laneLampEvery: 20,
  /** A crash cushion's length at each end of a median run (m: a crossover's mouth, the V's apex). */
  cushion: 2.4,
  /** Cap beams under the deck: depth (m) and width along the deck (m). */
  capH: 1.3,
  capW: 1.6,
  /** Pools: deck lamps, soffit lamps over the street and the lamps over an alley (smaller: they keep to it) (radius m, additive color at the middle). */
  deckPool: { r: 13, color: col(0xffc070, 0.3) },
  streetPool: { r: 9, color: col(0xff9a40, 0.3) },
  alleyPool: { r: 6.5, color: col(0xff9a40, 0.3) },
  /** Ramp lamp posts every this far along the outer wall (m), their height (m). */
  rampPostEvery: 18,
  rampPostH: 9,
  /** Sign gantries keep this far from a ramp's top and lane and the El crossing (m), this far inside the V's starts (m) and from a cantilever sign (m). */
  gantryClear: 70,
  gantryEnds: 60,
  signClear: 80,
  /**
   * Cantilever signs: the truss's underside over the deck and its depth along it (m, as the gantries'), the
   * panel (m, the atlas cell's 4:1), and how far before an off-ramp's lane its EXIT sign stands and before the
   * deck's end its END sign (m, the first of these where the post finds a parapet clear of the ramps: a lane
   * starting just past an end's V takes the short ones, an on-ramp's lane near an end the far ones).
   */
  signY: 6.3,
  truss: 1.1,
  sign: { w: 8, h: 2 },
  exitAhead: [150, 130, 170, 110, 190, 90, 70, 50, 35],
  endAhead: [200, 180, 220, 160, 240, 140, 260, 280, 300, 120, 100, 80],
  /** Trees in a loop's infield, per quality. */
  infieldTrees: { low: 2, medium: 4, high: 6 },
  /** An alley's edge line this far off its back wall (m). */
  alleyEdge: 0.6,
} as const;

/** The sodium lamps under a lane hang over the middle of its alley (m from the deck's centerline). */
const LANE_LAMP_V = HALF + CFG.alleyDepth / 2;

/** A cantilever's sign hangs centered over the line between the two outer lanes (m from the centerline). */
const SIGN_V = LANES_IN + (CFG.lanes - 1) * CFG.lane;

/** A hair inside a piece's ends: where the deck's widening jumps (a ramp's top), each piece reads its own side. */
const EPS = 1e-3;

const C = {
  top: col(0x2a2a2e),
  fascia: col(0x8f8b84),
  soffit: col(0x4a4845),
  barrier: col(0xa29e96),
  concrete: col(0x7a776f),
  wall: col(0x6d6a63),
  steel: col(0x6f757c),
  steelDark: col(0x464a50),
  white: col(0xd8d8d0, 0.85),
  yellow: col(0xe0b030, 0.9),
  cushion: col(0xe8c020, 0.9),
  post: col(0x2a2d31),
  /** A loop's infield (the parks' grass), an alley's worn asphalt and its paint. */
  grass: col(0x1d3a22),
  alley: col(0x2e2e33),
  alleyLine: col(0xd8dce6, 0.7),
} as const;

const LAMP = {
  head: col(0xffe2b0, 1.8),
  sodium: col(0xffa040, 1.3),
  amber: col(0xffb020, 1.5),
  cyan: col(0x40f0ff, 1.6),
  sign: col(0xfff2d8, 0.9),
} as const;

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** A point at s along the deck, v to the right of travel toward +s. */
function at(c: RailCurve, s: number, v: number, P = curvePoint()): Vec2 {
  sampleCurve(c, s, P);
  return { x: P.x - P.tz * v, z: P.z + P.tx * v };
}

/**
 * Horizontal quad over [s0, s1] between laterals v0..v1 at s0 and w0..w1 at s1 (the same by default),
 * at heights y0 (at s0) and y1 (at s1), facing up (or down).
 */
function band(gb: GeoBuilder, c: RailCurve, s0: number, s1: number, v0: number, v1: number, y0: number, y1: number, color: THREE.Color, up = true, w0 = v0, w1 = v1): void {
  const a = at(c, s0, v0);
  const b = at(c, s1, w0);
  const d = at(c, s1, w1);
  const e = at(c, s0, v1);
  const n = up ? 1 : -1;
  const ids = [gb.vertex(a.x, y0, a.z, 0, n, 0, 0, 0, color), gb.vertex(b.x, y1, b.z, 0, n, 0, 1, 0, color), gb.vertex(d.x, y1, d.z, 0, n, 0, 1, 1, color), gb.vertex(e.x, y0, e.z, 0, n, 0, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, n, 0);
}

/**
 * Vertical quad along the deck from lateral v0 at s0 to v1 at s1 (the same by default), bottom and top
 * heights at each end, facing `out` (+1: to the right of the deck's +s), square to its own run.
 */
function side(gb: GeoBuilder, c: RailCurve, s0: number, s1: number, v0: number, yb0: number, yt0: number, yb1: number, yt1: number, out: number, color: THREE.Color, v1 = v0): void {
  const P = curvePoint();
  const a = at(c, s0, v0, P);
  const b = at(c, s1, v1);
  let nx = -(b.z - a.z);
  let nz = b.x - a.x;
  const l = Math.hypot(nx, nz) || 1;
  nx /= l;
  nz /= l;
  if ((nx * -P.tz + nz * P.tx) * out < 0) {
    nx = -nx;
    nz = -nz;
  }
  const ids = [gb.vertex(a.x, yb0, a.z, nx, 0, nz, 0, 0, color), gb.vertex(b.x, yb1, b.z, nx, 0, nz, 1, 0, color), gb.vertex(b.x, yt1, b.z, nx, 0, nz, 1, 1, color), gb.vertex(a.x, yt0, a.z, nx, 0, nz, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
}

/** Vertical quad across the deck at s from lateral v0 to v1, heights yb to yt, facing along it (dir +1: toward +s). */
function across(gb: GeoBuilder, c: RailCurve, s: number, v0: number, v1: number, yb: number, yt: number, dir: number, color: THREE.Color): void {
  const P = curvePoint();
  const a = at(c, s, v0, P);
  const b = at(c, s, v1);
  const nx = P.tx * dir;
  const nz = P.tz * dir;
  const ids = [gb.vertex(a.x, yb, a.z, nx, 0, nz, 0, 0, color), gb.vertex(b.x, yb, b.z, nx, 0, nz, 1, 0, color), gb.vertex(b.x, yt, b.z, nx, 0, nz, 1, 1, color), gb.vertex(a.x, yt, a.z, nx, 0, nz, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
}

/** A bar along the deck between laterals v0 < v1 at s0 (w0 < w1 at s1), from the deck's height up by h: its top and both long faces. */
function bar(gb: GeoBuilder, c: RailCurve, s0: number, s1: number, v0: number, v1: number, y0: number, y1: number, h: number, color: THREE.Color, w0 = v0, w1 = v1): void {
  band(gb, c, s0, s1, v0, v1, y0 + h, y1 + h, color, true, w0, w1);
  side(gb, c, s0, s1, v0, y0, y0 + h, y1, y1 + h, -1, color, w0);
  side(gb, c, s0, s1, v1, y0, y0 + h, y1, y1 + h, 1, color, w1);
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
    const route = new Set(kit.world.route.edges);
    for (const a of areas) if (a.variant === 'alley') alley(kit, a, signs, route);
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

/** [s0, s1] in pieces at most `step` long, split at `breaks` (any order) so a piece never straddles one (low to high). */
function pieces(s0: number, s1: number, step: number, breaks: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  if (s1 - s0 < 0.05) return out;
  const cuts = breaks.filter((b) => b > s0 + 0.05 && b < s1 - 0.05).sort((a, b) => a - b);
  let from = s0;
  for (const to of [...cuts, s1]) {
    if (to - from < 1e-6) continue;
    const n = Math.max(1, Math.ceil((to - from) / step - 1e-6));
    for (let k = 0; k < n; k++) out.push([from + ((to - from) * k) / n, from + ((to - from) * (k + 1)) / n]);
    from = to;
  }
  return out;
}

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

/** Where the median lamp posts stand along the deck (s, m): every HW.postEvery between the V's starts, none in a crossover. */
function medianPosts(d: HighwayDeck): number[] {
  const out: number[] = [];
  const end = vStart(d, 1) - 3;
  for (let s = vStart(d, -1) + HW.postEvery / 2; s < end; s += HW.postEvery) if (!inMedianGap(d, s, 3)) out.push(s);
  return out;
}

/** Where the sodium lamps under the lanes hang (s, side): every about HW.laneLampEvery along each lane, where the deck drawn reaches past them. */
function laneLamps(d: HighwayDeck): { s: number; sd: 1 | -1 }[] {
  const out: { s: number; sd: 1 | -1 }[] = [];
  for (const r of d.ramps) {
    const lane = laneRange(r);
    if (!lane) continue;
    const n = Math.max(1, Math.round((lane[1] - lane[0]) / HW.laneLampEvery));
    for (let k = 0; k < n; k++) {
      const s = lane[0] + ((k + 0.5) * (lane[1] - lane[0])) / n;
      if (extent(d, s, r.side) >= LANE_LAMP_V + 1.5) out.push({ s, sd: r.side });
    }
  }
  return out;
}

/** How far into the V at either end s is: 0 at its start (and outside it), 1 at the deck's end. */
function vInto(d: HighwayDeck, s: number): number {
  for (const end of [-1, 1] as const) {
    const t = (end * (s - vStart(d, end))) / CFG.loopGore;
    if (t > 0 && t < 1 + 1e-9) return Math.min(1, t);
  }
  return 0;
}

/**
 * The V's barrier at s (shape.ts vGoreAt), read a hair inside the deck's ends: at the very end the V's
 * fraction can round past 1, where vGoreAt reads as outside it.
 */
const vGore = (d: HighwayDeck, s: number): number => vGoreAt(d, Math.min(d.sE - 1e-6, Math.max(d.sW + 1e-6, s)));

/**
 * A ramp's surface at lateral v (left of travel), u along it: what the sim drives. The point's place on
 * the axis is (u, v) itself, so it is never read back off the axis (projectAxis), which near a loop's foot
 * can pick the line on past E, which runs along the deck a few meters off the building line there.
 */
function rampSurface(r: HighwayRamp): (u: number, v: number) => P3 {
  const ax = r.axis;
  const ap = axisPoint();
  const sample = { h: 0, gx: 0, gz: 0 };
  return (u, v) => {
    const q = axisAt(ax, u);
    const x = q.x - q.tz * v;
    const z = q.z + q.tx * v;
    ap.u = u;
    ap.v = v;
    ap.ux = q.tx;
    ap.uz = q.tz;
    ap.vx = -q.tz;
    ap.vz = q.tx;
    rampHeight(ax, r.profile, r.terrain, x, z, ap, sample);
    return { x, y: sample.h, z };
  };
}

/**
 * The expressway's lamps for the real light pool (scene.ts NightLighting): one per median post between
 * the V's starts, at its heads (it lights both carriageways), every other lamp under the lanes (their
 * alleys) and every ramp and loop lamp head.
 */
export function highwayLamps(world: World): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const P = curvePoint();
  for (const a of world.areas) {
    if (a.kind !== 'highway' || a.variant !== 'deck') continue;
    const d = highwayDeck(a, world.areas);
    if (!d.settled) continue;
    for (const s of medianPosts(d)) {
      sampleCurve(d.curve, s, P);
      out.push(new THREE.Vector3(P.x, deckTopAt(d, s) + HW.postH - 0.3, P.z));
    }
    laneLamps(d).forEach((l, i) => {
      if (i % 2) return;
      const q = at(d.curve, l.s, l.sd * LANE_LAMP_V, P);
      out.push(new THREE.Vector3(q.x, deckUnderAt(d, l.s) - 0.3, q.z));
    });
    for (const r of d.ramps) {
      const surf = rampSurface(r);
      const inner = rampInnerSign(r, d.curve);
      for (let u = 12; u < r.axis.length; u += HW.rampPostEvery) {
        const p = surf(u, -inner * (r.half + RAMP_WALL / 2));
        const h = surf(u, -inner * (r.half - 1.6));
        out.push(new THREE.Vector3(h.x, p.y + 1 + HW.rampPostH - 0.2, h.z));
      }
    }
  }
  return out;
}

/**
 * The deck's drawn extent on side `sd` at s (m): its half width, widened to the sim's width over a slip
 * ramp's lane (shape.ts deckExtent) from the ramp's top on (the gore, where the ramp's own spans run on past
 * E, included), taper and all, so the lane's outer columns stand under it; the lane's wall and its taper
 * stand on it. Loops never widen it.
 */
function extent(d: HighwayDeck, s: number, sd: 1 | -1): number {
  let e = HALF;
  for (const r of d.ramps) {
    const lane = laneRange(r);
    if (r.side !== sd || !lane || s < Math.min(r.sa, r.sb) || s > Math.max(r.sa, r.sb)) continue;
    e = Math.max(e, deckExtent(d, (lane[0] + lane[1]) / 2, sd));
  }
  return e;
}

/** The parapet's sim piece (build.ts CHUNK) holding s: its ends (s, m), or null off the deck. */
function chunkAt(d: HighwayDeck, s: number): [number, number] | null {
  const k0 = Math.floor(d.sW / RAIL.step);
  const k1 = Math.ceil(d.sE / RAIL.step);
  const k = k0 + Math.floor((s / RAIL.step - k0) / HW.chunk) * HW.chunk;
  if (k < k0 || k >= k1) return null;
  return [k * RAIL.step, Math.min(k1, k + HW.chunk) * RAIL.step];
}

/** Whether the parapet on side `sd` stands at s (its piece there is not open onto a lane). */
function barrierAt(d: HighwayDeck, s: number, sd: 1 | -1): boolean {
  const k = chunkAt(d, s);
  return k !== null && !barrierOpen(d, k[0], k[1], sd);
}

function deck(kit: DistrictKit, area: Area, d: HighwayDeck, signs: GeoBuilder, wash: GeoBuilder | null): void {
  const c = d.curve;
  const low = kit.quality === 'low';
  const step = low ? HW.pieceLow : HW.piece;
  const solid = kit.solid;
  const paint = kit.paint;
  const mh = CFG.median / 2;
  const lw = HW.line / 2;
  const top = (s: number) => deckTopAt(d, s);
  // ----- The box girder over the drivable stretch, piece by piece, widened over the lanes: pieces split
  // where a widening starts and ends and at the V's starts, so each piece's edges run straight between
  // its ends.
  const breaks: number[] = [vStart(d, -1), vStart(d, 1)];
  for (const r of d.ramps) if (!r.loop) breaks.push(r.sa, r.sb);
  const pcs = pieces(d.sW, d.sE, step, breaks);
  for (const [s, e] of pcs) {
    const t0 = top(s);
    const t1 = top(e);
    const u0 = deckUnderAt(d, s);
    const u1 = deckUnderAt(d, e);
    const r0 = extent(d, s + EPS, 1);
    const r1 = extent(d, e - EPS, 1);
    const l0 = -extent(d, s + EPS, -1);
    const l1 = -extent(d, e - EPS, -1);
    band(solid, c, s, e, l0, r0, t0, t1, C.top, true, l1, r1);
    band(solid, c, s, e, l0, r0, u0, u1, C.soffit, false, l1, r1);
    side(solid, c, s, e, r0, u0, t0 + 0.05, u1, t1 + 0.05, 1, C.fascia, r1);
    side(solid, c, s, e, l0, u0, t0 + 0.05, u1, t1 + 0.05, -1, C.fascia, l1);
  }
  // Its ends, under the loops' tops, and both ends of a lane's widening (at its ramp's top and past its taper).
  across(solid, c, d.sW, -HALF, HALF, deckUnderAt(d, d.sW), top(d.sW) + 0.05, -1, C.fascia);
  across(solid, c, d.sE, -HALF, HALF, deckUnderAt(d, d.sE), top(d.sE) + 0.05, 1, C.fascia);
  for (const r of d.ramps) {
    if (r.loop) continue;
    const w = r.side * extent(d, (r.sa + r.sb) / 2, r.side);
    across(solid, c, r.sa, r.side * HALF, w, deckUnderAt(d, r.sa), top(r.sa) + 0.05, -r.along, C.fascia);
    across(solid, c, r.sb, r.side * HALF, w, deckUnderAt(d, r.sb), top(r.sb) + 0.05, r.along, C.fascia);
  }

  // ----- Parapets along both edges in the sim's own pieces (build.ts), open where a whole piece lies along
  // a lane; capped where a run of them ends.
  {
    const k0 = Math.floor(d.sW / RAIL.step);
    const k1 = Math.ceil(d.sE / RAIL.step);
    const open = (k: number, sd: 1 | -1) => k < k0 || k >= k1 || barrierOpen(d, k * RAIL.step, Math.min(k1, k + HW.chunk) * RAIL.step, sd);
    for (let k = k0; k < k1; k += HW.chunk) {
      const a = Math.max(d.sW, k * RAIL.step);
      const b = Math.min(d.sE, Math.min(k1, k + HW.chunk) * RAIL.step);
      if (b - a < 0.05) continue;
      for (const sd of [1, -1] as const) {
        if (open(k, sd)) continue;
        const v0 = sd > 0 ? HALF - HW.barrierW : -HALF;
        bar(solid, c, a, b, v0, v0 + HW.barrierW, top(a), top(b), HW.barrierH, C.barrier);
        if (open(k - HW.chunk, sd)) across(solid, c, a, v0, v0 + HW.barrierW, top(a), top(a) + HW.barrierH, -1, C.barrier);
        if (open(k + HW.chunk, sd)) across(solid, c, b, v0, v0 + HW.barrierW, top(b), top(b) + HW.barrierH, 1, C.barrier);
      }
    }
  }

  // ----- The median from one V to the other, broken at its crossovers (as the sim's, build.ts), a crash
  // cushion at both ends of every run: a crossover's mouth or the V's apex.
  const gaps = medianGaps(d);
  const median = (s: number, e: number, color: THREE.Color) => bar(solid, c, s, e, -mh, mh, top(s), top(e), HW.medianH, color);
  for (const [m0, m1] of medianRuns(vStart(d, -1), vStart(d, 1), gaps)) {
    const cu = Math.min(HW.cushion, (m1 - m0) / 2);
    median(m0, m0 + cu, C.cushion);
    median(m1 - cu, m1, C.cushion);
    for (const [s, e] of pieces(m0 + cu, m1 - cu, step, [])) median(s, e, C.barrier);
    across(solid, c, m0, -mh, mh, top(m0), top(m0) + HW.medianH, -1, C.cushion);
    across(solid, c, m1, -mh, mh, top(m1), top(m1) + HW.medianH, 1, C.cushion);
  }

  // ----- The V at each end: the median's barriers fan out to the loops' outer walls (in the sim's pieces),
  // white chevrons in the gore between them, a low parapet closing it at the deck's end.
  const hb = HW.vBarrierW / 2;
  const cw = HW.chevronW / 2;
  for (const end of [-1, 1] as const) {
    const s0 = vStart(d, end);
    const s1 = end < 0 ? d.sW : d.sE;
    const n = Math.max(2, Math.ceil(Math.abs(s1 - s0) / 4));
    for (const sd of [1, -1] as const) {
      for (let k = 0; k < n; k++) {
        const a0 = s0 + ((s1 - s0) * k) / n;
        const a1 = s0 + ((s1 - s0) * (k + 1)) / n;
        const va = sd * vGore(d, a0);
        const vb = sd * vGore(d, a1);
        bar(solid, c, a0, a1, va - hb, va + hb, top(a0), top(a1), HW.medianH, C.barrier, vb - hb, vb + hb);
      }
      const ve = sd * vGore(d, s1);
      across(solid, c, s1, ve - hb, ve + hb, top(s1), top(s1) + HW.medianH, end, C.barrier);
    }
    const g = vGore(d, s1) - hb;
    const sIn = s1 - end * HW.barrierW;
    band(solid, c, sIn, s1, -g, g, top(sIn) + HW.medianH, top(s1) + HW.medianH, C.barrier);
    across(solid, c, sIn, -g, g, top(sIn), top(sIn) + HW.medianH, -end, C.barrier);
    across(solid, c, s1, -g, g, top(s1), top(s1) + HW.medianH, end, C.barrier);
    // Chevrons: each a V like the gore's own, its point on the centerline toward the apex.
    for (let q = HW.chevronFrom; q + HW.chevronArm < CFG.loopGore - HW.barrierW - 0.5; q += HW.chevronEvery) {
      const sp = s0 + end * q;
      const sa = sp + end * HW.chevronArm;
      const w = vGore(d, sa) - hb - 0.35;
      if (w < 0.6) continue;
      for (const sd of [1, -1]) band(paint, c, sp, sa, -cw, cw, top(sp) + 0.02, top(sa) + 0.02, C.white, true, sd * w - cw, sd * w + cw);
    }
    // Hazard lamps (the scene's blink, kit.hazard): a pair on the V's nose facing the traffic that splits
    // round it, and a row along the parapet closing the gore at the deck's end.
    const nose = s0 + end * 0.4;
    for (const sd of [1, -1]) {
      const q = at(c, nose, sd * vGore(d, nose));
      cylinder(kit.hazard, q.x, q.z, 0.1, top(nose) + HW.medianH, top(nose) + HW.medianH + 0.16, 6, C.barrier);
    }
    for (let k = -2; k <= 2; k++) {
      const q = at(c, s1 - end * HW.barrierW * 0.5, (k / 2) * (g - 0.3));
      cylinder(kit.hazard, q.x, q.z, 0.1, top(s1) + HW.medianH, top(s1) + HW.medianH + 0.16, 6, C.barrier);
    }
  }

  // ----- Lane lines: the inner edge's yellow, the dashed dividers, the outer edge (dashed along a lane,
  // whose wall gets a solid one of its own). Over the V the inner edge follows its barrier, the last
  // divider and the outer edge ease into the loop's lanes, and the divider nearest the median ends where
  // its lane runs out (the loops have two).
  const dividers = Array.from({ length: CFG.lanes - 1 }, (_, k) => LANES_IN + (k + 1) * CFG.lane);
  const outerLine = LANES_IN + CFG.lanes * CFG.lane;
  const ease = (s: number) => {
    const t = vInto(d, s);
    return t * t * (3 - 2 * t);
  };
  const innerAt = (s: number) => Math.max(LANES_IN, vGore(d, s) + CFG.innerShoulder);
  const dividerAt = (k: number, s: number) => {
    const v = dividers[k];
    if (k === dividers.length - 1) return v + (LOOP_AT - v) * ease(s);
    return v - innerAt(s) < HW.laneDrop ? NaN : v;
  };
  const outerAt = (s: number) => outerLine + (LOOP_AT + CFG.loopHalf - HW.laneEdge - outerLine) * ease(s);
  const line = (s: number, e: number, va: number, vb: number, color: THREE.Color) => band(paint, c, s, e, va - lw, va + lw, top(s) + 0.02, top(e) + 0.02, color, true, vb - lw, vb + lw);
  for (const [s, e] of pcs) {
    for (const sd of [1, -1] as const) {
      line(s, e, sd * innerAt(s), sd * innerAt(e), C.yellow);
      if (extent(d, (s + e) / 2, sd) <= HALF + 0.5) line(s, e, sd * outerAt(s), sd * outerAt(e), C.white);
    }
  }
  for (let s = d.sW; s < d.sE - HW.dash; s += HW.period) {
    const e = s + HW.dash;
    for (const sd of [1, -1] as const) {
      for (let k = 0; k < dividers.length; k++) {
        const a = dividerAt(k, s);
        const b = dividerAt(k, e);
        if (!Number.isNaN(a) && !Number.isNaN(b)) line(s, e, sd * a, sd * b, C.white);
      }
      if (extent(d, s + HW.dash / 2, sd) > HALF + 0.5) line(s, e, sd * outerLine, sd * outerLine, C.white);
    }
  }
  // Along a slip ramp's lane, a solid edge line inside its wall: at full width from the ramp's top, then
  // easing in over the taper to meet the deck's outer edge line where the lane ends.
  for (const r of d.ramps) {
    if (r.loop) continue;
    const from = r.sb - r.along * TAPER;
    const full = rampOuterAt(r, r.sa) - HW.laneEdge;
    const vAt = (s: number) => full + (outerLine - full) * Math.min(1, Math.max(0, (r.along * (s - from)) / TAPER));
    for (const [a, b] of [
      [r.sa, from],
      [from, r.sb],
    ]) {
      const m = Math.max(1, Math.ceil(Math.abs(b - a) / 4));
      for (let k = 0; k < m; k++) {
        const s = a + ((b - a) * k) / m;
        const e = a + ((b - a) * (k + 1)) / m;
        line(s, e, r.side * vAt(s), r.side * vAt(e), C.white);
      }
    }
  }

  // ----- Columns: the sim's bents, and under a lane its outer columns, just behind the alley's back wall.
  const b = kit.builds[area.id];
  const sOf = (x: number, z: number) => projectOnCurve(c, x, z).s;
  const hh = CFG.columnSize / 2;
  const P = curvePoint();
  for (const p of b.props) {
    if (p.kind === 'bent') {
      const dx = Math.sin(p.yaw);
      const dz = Math.cos(p.yaw);
      const under = deckUnderAt(d, sOf(p.x, p.z));
      const nx = dz;
      const nz = -dx;
      const cols = [1, -1].map((k) => ({ x: p.x + nx * p.size * k, z: p.z + nz * p.size * k }));
      for (const q of cols) {
        const g = kit.h(q.x, q.z);
        orientedBox(solid, q.x - dx * hh - nx * hh, q.z - dz * hh - nz * hh, q.x + dx * hh - nx * hh, q.z + dz * hh - nz * hh, nx * 2 * hh, nz * 2 * hh, g - 0.3, under - HW.capH + 0.05, C.concrete);
      }
      const w = HW.capW / 2;
      const a = cols[0];
      const e = cols[1];
      orientedBox(solid, a.x - dx * w + nx * hh, a.z - dz * w + nz * hh, e.x - dx * w - nx * hh, e.z - dz * w - nz * hh, dx * 2 * w, dz * 2 * w, under - HW.capH, under, C.concrete);
    } else if (p.kind === 'laneColumn') {
      // A square column (the street's way, as the bents') up to a cap beam out from the bent's under the soffit.
      const dx = Math.sin(p.yaw);
      const dz = Math.cos(p.yaw);
      const nx = dz;
      const nz = -dx;
      const hs = p.size;
      const s = sOf(p.x, p.z);
      const under = deckUnderAt(d, s);
      orientedBox(solid, p.x - dx * hs - nx * hs, p.z - dz * hs - nz * hs, p.x + dx * hs - nx * hs, p.z + dz * hs - nz * hs, nx * 2 * hs, nz * 2 * hs, kit.h(p.x, p.z) - 0.3, under - HW.capH + 0.05, C.concrete);
      sampleCurve(c, s, P);
      const lat = (p.x - P.x) * -P.tz + (p.z - P.z) * P.tx;
      const sd = p.height > 0 ? 1 : -1;
      capBeam(solid, c, d, s, sd * (HALF - 2), lat + sd * hs);
    }
  }

  // ----- Light: tall median lamp posts with two heads (none in the V or a crossover), amber delineators on
  // the parapets, two rows of sodium lamps under the soffit each side and a row under each lane.
  for (const s of medianPosts(d)) {
    sampleCurve(c, s, P);
    const ty = top(s);
    const y = ty + HW.postH;
    cylinder(solid, P.x, P.z, 0.13, ty + HW.medianH, y + 0.2, 6, C.steel, false, 0.09);
    for (const sd of [1, -1]) {
      const h = at(c, s, sd * HW.arm);
      orientedBox(solid, P.x, P.z, h.x, h.z, P.tx * 0.12, P.tz * 0.12, y, y + 0.12, C.steel);
      const q = at(c, s, sd * (HW.arm + 0.3));
      orientedBox(kit.glow, q.x - P.tx * 0.5, q.z - P.tz * 0.5, q.x + P.tx * 0.5, q.z + P.tz * 0.5, -P.tz * 0.3 * sd, P.tx * 0.3 * sd, y - 0.22, y - 0.02, LAMP.head);
      if (wash) {
        const p = at(c, s, sd * laneCenter(1));
        pool(wash, p.x, p.z, () => ty, HW.deckPool.r, HW.deckPool.color);
      }
    }
  }
  if (!low) {
    for (let s = d.sW + 2; s < d.sE; s += HW.delineatorEvery) {
      const ty = top(s);
      for (const sd of [1, -1] as const) {
        if (!barrierAt(d, s, sd)) continue;
        const q = at(c, s, sd * (HALF - HW.barrierW - 0.02));
        cylinder(kit.glow, q.x, q.z, 0.07, ty + HW.barrierH - 0.25, ty + HW.barrierH - 0.1, 4, LAMP.amber, true);
      }
    }
  }
  const streetY = (x: number, z: number) => kit.world.driveHeightAt(x, z);
  for (let s = d.sW + HW.soffitEvery / 2; s < d.sE; s += HW.soffitEvery) {
    const u = deckUnderAt(d, s);
    for (const sd of [1, -1]) {
      for (const v of HW.soffitRows) {
        const q = at(c, s, sd * v);
        cylinder(kit.glow, q.x, q.z, 0.3, u - 0.12, u - 0.02, 6, LAMP.sodium, true);
        if (wash) pool(wash, q.x, q.z, streetY, HW.streetPool.r, HW.streetPool.color);
      }
    }
  }
  for (const l of laneLamps(d)) {
    const q = at(c, l.s, l.sd * LANE_LAMP_V);
    const u = deckUnderAt(d, l.s);
    cylinder(kit.glow, q.x, q.z, 0.3, u - 0.12, u - 0.02, 6, LAMP.sodium, true);
    if (wash) pool(wash, q.x, q.z, streetY, HW.alleyPool.r, HW.alleyPool.color);
  }

  // ----- Signs: on cantilevers over one carriageway EXIT before each off-ramp's lane and END before each
  // end; gantries across both, clear of those, of the ramps' tops and lanes, the V and the El's hump.
  const cants = cantilevers(d);
  for (const t of cants) cantilever(kit, signs, d, t.s, t.sd, t.cell, low);
  const near = (s: number) =>
    d.ramps.some((r) => {
      const lane = laneRange(r);
      return lane !== null && s > Math.min(lane[0], r.sa) - HW.gantryClear && s < Math.max(lane[1], r.sa) + HW.gantryClear;
    }) ||
    cants.some((t) => Math.abs(s - t.s) < HW.signClear) ||
    (Number.isFinite(d.sEl) && Math.abs(s - d.sEl) < 120);
  const lo = vStart(d, -1) + HW.gantryEnds;
  const hi = vStart(d, 1) - HW.gantryEnds;
  let next = (area.params.seed ?? 0) % GANTRY_SIGNS.length;
  for (let s = lo + 120; s < hi; s += CFG.signEvery) {
    let sg = s;
    for (let tries = 0; tries < 6 && near(sg); tries++) sg += 30;
    if (near(sg) || sg > hi) continue;
    sampleCurve(c, sg, P);
    const ty = top(sg);
    const f: Frame = { cx: P.x, cz: P.z, ux: P.tx, uz: P.tz };
    const first = next;
    signGantry(solid, kit.glow, signs, f, {
      legV: HALF - HW.barrierW / 2,
      road: HALF - 1,
      legBase: () => ty + HW.barrierH,
      y0: ty + HW.signY,
      cell: (end, i) => gantryCell((first + (end > 0 ? 0 : 3) + i) % GANTRY_SIGNS.length),
      count: 2,
      board: false,
    }, low);
    next += 1;
  }
}

/** A cap beam across under the deck at s from lateral v0 to v1 (m): its underside, both faces along the deck and its far end. */
function capBeam(gb: GeoBuilder, c: RailCurve, d: HighwayDeck, s: number, v0: number, v1: number): void {
  const w = HW.capW / 2;
  const ya = deckUnderAt(d, s - w);
  const yb = deckUnderAt(d, s + w);
  band(gb, c, s - w, s + w, v0, v1, ya - HW.capH, yb - HW.capH, C.concrete, false);
  across(gb, c, s - w, v0, v1, ya - HW.capH, ya, -1, C.concrete);
  across(gb, c, s + w, v0, v1, yb - HW.capH, yb, 1, C.concrete);
  side(gb, c, s - w, s + w, v1, ya - HW.capH, ya, yb - HW.capH, yb, Math.sign(v1 - v0), C.concrete);
}

/**
 * Where the cantilever signs stand (s, the carriageway's side, the sign): EXIT before every off-ramp's lane
 * (its traffic comes at the lane from beyond its far end, sb), END before each end on the carriageway out
 * to it. Each at the first distance its post finds the parapet (which runs on to the deck's ends, through
 * the V), clear of every ramp's top and lane on that side and of the other signs there.
 */
function cantilevers(d: HighwayDeck): { s: number; sd: 1 | -1; cell: Cell }[] {
  const out: { s: number; sd: 1 | -1; cell: Cell }[] = [];
  const lo = d.sW + 15;
  const hi = d.sE - 15;
  const clear = (s: number, sd: 1 | -1) =>
    s > lo &&
    s < hi &&
    barrierAt(d, s - 3, sd) &&
    barrierAt(d, s + 3, sd) &&
    !d.ramps.some((r) => !r.loop && r.side === sd && s > Math.min(r.sa, r.sb) - 25 && s < Math.max(r.sa, r.sb) + 25) &&
    !out.some((o) => o.sd === sd && Math.abs(o.s - s) < 60);
  for (const r of d.ramps) {
    if (r.loop || r.on) continue;
    const s = HW.exitAhead.map((a) => r.sb + r.along * a).find((q) => clear(q, r.side));
    if (s !== undefined) out.push({ s, sd: r.side, cell: EXIT_CELL });
  }
  for (const end of [-1, 1] as const) {
    const sEnd = end < 0 ? d.sW : d.sE;
    const s = HW.endAhead.map((a) => sEnd - end * a).find((q) => clear(q, end));
    if (s !== undefined) out.push({ s, sd: end, cell: END_CELL });
  }
  return out;
}

/**
 * A cantilever sign over the carriageway on side `sd` at s, facing the traffic coming at it (right hand
 * running: on side +1 it heads toward +s): a steel post on the parapet, a four chord truss out over the
 * outer lanes (diagonals on Medium and up), the sign hung in front of it on its backing plate and
 * brackets, lit by a lamp hood. Into the kit's solid and glow builders and the sign builder.
 */
function cantilever(kit: DistrictKit, signs: GeoBuilder, d: HighwayDeck, s: number, sd: 1 | -1, cell: Cell, low: boolean): void {
  const solid = kit.solid;
  const P = sampleCurve(d.curve, s, curvePoint());
  const f: Frame = { cx: P.x, cz: P.z, ux: P.tx, uz: P.tz };
  const ty = deckTopAt(d, s);
  const y0 = ty + HW.signY;
  const y1 = y0 + HW.truss;
  const base = ty + HW.barrierH;
  const legV = sd * (HALF - HW.barrierW / 2);
  const vc = sd * SIGN_V;
  const tip = sd * (SIGN_V - HW.sign.w / 2 - 0.4);
  frameBox(solid, f, -0.35, 0.35, legV - 0.35, legV + 0.35, base - 0.05, base - 0.05, base + 0.25, base + 0.25, C.concrete);
  frameBox(solid, f, -0.25, 0.25, legV - 0.25, legV + 0.25, base + 0.25, base + 0.25, y1 + 0.25, y1 + 0.25, C.steel);
  const hd = 0.5;
  const pt = (u: number, v: number, y: number): P3 => {
    const q = toWorld(f, u, v);
    return { x: q.x, y, z: q.z };
  };
  for (const u of [-hd, hd]) for (const y of [y0, y1]) beam(solid, pt(u, legV, y), pt(u, tip, y), 0.08, 0.08, C.steel);
  if (!low) {
    const n = Math.max(2, Math.round(Math.abs(legV - tip) / 1.6));
    for (let i = 0; i < n; i++) {
      const va = legV + ((tip - legV) * i) / n;
      const vb = legV + ((tip - legV) * (i + 1)) / n;
      for (const u of [-hd, hd]) {
        beam(solid, pt(u, va, i % 2 ? y0 : y1), pt(u, vb, i % 2 ? y1 : y0), 0.05, 0.05, C.steelDark);
        beam(solid, pt(u, vb, y0), pt(u, vb, y1), 0.05, 0.05, C.steelDark);
      }
    }
  }
  // The sign on the face the traffic sees (toward -u for side +1), in front of the chords.
  const { w, h } = HW.sign;
  const face = hd + 0.22;
  /** A stretch [a, b] out from the truss's middle toward that face, low to high in u. */
  const toward = (a: number, b: number): [number, number] => (sd > 0 ? [-b, -a] : [a, b]);
  const yc = y0 - 0.1 + h / 2;
  const yb = yc - h / 2;
  const yt = yc + h / 2;
  const p = toWorld(f, -sd * (face + 0.01), vc);
  signPanel(signs, p.x, yc, p.z, -sd * P.tx, -sd * P.tz, w, h, cell, col(0xffffff, 0.85));
  const [b0, b1] = toward(face - 0.06, face);
  frameBox(solid, f, b0, b1, vc - w / 2, vc + w / 2, yb, yb, yt, yt, C.steelDark);
  const [k0, k1] = toward(hd + 0.08, face - 0.06);
  for (const bv of [vc - w * 0.35, vc + w * 0.35]) for (const y of [y0, Math.min(y1, yt - 0.1)]) frameBox(solid, f, k0, k1, bv - 0.05, bv + 0.05, y - 0.05, y - 0.05, y + 0.05, y + 0.05, C.steelDark);
  const [l0, l1] = toward(face + 0.17, face + 0.37);
  frameBox(kit.glow, f, l0, l1, vc - 0.6, vc + 0.6, yt + 0.05, yt + 0.05, yt + 0.15, yt + 0.15, LAMP.sign);
}

/**
 * Where a ramp's wall on side k (the sign of v) starts along it (u, m), as the sim's (build.ts): a slip
 * ramp's inner one past its run along the street (open to the cut sidewalk), its outer one at the foot; a
 * loop's where it meets the street's building line (a leg leaning a little starts one wall a few meters on
 * and the other a few back, so neither stands on the sidewalk).
 */
function wallFrom(r: HighwayRamp, c: RailCurve, k: number, inner: number): number {
  if (!r.loop) return k === inner ? r.flat : 0;
  for (let u = -12; u < 12; u += 0.25) {
    const q = axisAt(r.axis, u);
    const v = k * (r.half + RAMP_WALL);
    if (Math.abs(projectNear(c, q.x - q.tz * v, q.z + q.tx * v, r.sa, 260).lateral) >= r.building - 0.05) return u;
  }
  return 0;
}

/** A cap beam across under a ramp at u, from v0 to v1 (left of travel), its top at `top`: its faces along the ramp, its ends and its underside. */
function rampCap(gb: GeoBuilder, ax: RampAxis, u: number, v0: number, v1: number, top: number): void {
  const w = HW.capW / 2;
  const q = axisAt(ax, u);
  const pt = (du: number, v: number): Vec2 => ({ x: q.x + q.tx * du - q.tz * v, z: q.z + q.tz * du + q.tx * v });
  const a = pt(-w, v0);
  const b = pt(-w, v1);
  orientedBox(gb, a.x, a.z, b.x, b.z, q.tx * 2 * w, q.tz * 2 * w, top - HW.capH, top, C.concrete);
  const y = top - HW.capH;
  const ids = [pt(-w, v0), pt(-w, v1), pt(w, v1), pt(w, v0)].map((p) => gb.vertex(p.x, y, p.z, 0, -1, 0, 0, 0, C.concrete));
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, -1, 0);
}

function ramp(kit: DistrictKit, d: HighwayDeck, r: HighwayRamp, signs: GeoBuilder, wash: GeoBuilder | null): void {
  const ax = r.axis;
  const L = ax.length;
  const hw = r.half;
  const c = d.curve;
  const solid = kit.solid;
  const paint = kit.paint;
  const low = kit.quality === 'low';
  const slip = !r.loop;
  const surf = rampSurface(r);
  const inner = rampInnerSign(r, c);
  const uc = Math.max(4, r.uSolid);
  const step = 3;
  const wt = RAMP_WALL;
  // The asphalt edge to edge between the walls, and the bridge stretch's soffit under it.
  for (let u = 0; u < L - 1e-6; u += step) {
    const e = Math.min(L, u + step);
    const a0 = surf(u, -hw);
    const a1 = surf(e, -hw);
    const b1 = surf(e, hw);
    const b0 = surf(u, hw);
    band3(solid, a0, a1, b1, b0, 0.01, C.top);
    if (u >= uc) band3(solid, a0, a1, b1, b0, -1.4, C.soffit, false);
  }
  // A slip ramp's nose, where its run along the street ends toward the junction: road over the triangle back
  // to the building line, and a low wall along its slant from the outer wall's foot (build.ts).
  if (slip) {
    const ids = [surf(-SLIP_NOSE, inner * hw), surf(0, -inner * hw), surf(0, inner * hw)].map((p) => solid.vertex(p.x, p.y + 0.01, p.z, 0, 1, 0, 0, 0, C.top));
    solid.triFacing(ids[0], ids[1], ids[2], 0, 1, 0);
    const a = surf(0, -inner * (hw + wt / 2));
    const b = surf(-SLIP_NOSE, inner * hw);
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = (-(b.z - a.z) / l) * (wt / 2);
    const nz = ((b.x - a.x) / l) * (wt / 2);
    orientedBox(solid, a.x - nx, a.z - nz, b.x - nx, b.z - nz, 2 * nx, 2 * nz, Math.min(kit.h(a.x, a.z), kit.h(b.x, b.z), a.y, b.y) - 0.3, Math.max(a.y, b.y) + 1, C.wall);
  }
  // The walls: retaining walls to the ground on the embankment, parapets on the bridge stretch at its top,
  // from where the sim's start (wallFrom); a slip ramp's inner one runs on past E along the deck's edge
  // (the gore), as the sim's (build.ts).
  const quad = (pa: Vec2, pb: Vec2, ya0: number, ya1: number, yb0: number, yb1: number, fx: number, fz: number) => {
    const ii = [solid.vertex(pa.x, ya0, pa.z, fx, 0, fz, 0, 0, C.wall), solid.vertex(pb.x, yb0, pb.z, fx, 0, fz, 1, 0, C.wall), solid.vertex(pb.x, yb1, pb.z, fx, 0, fz, 1, 1, C.wall), solid.vertex(pa.x, ya1, pa.z, fx, 0, fz, 0, 1, C.wall)];
    solid.quadFacing(ii[0], ii[1], ii[2], ii[3], fx, 0, fz);
  };
  // In the sim's 4 m pieces (build.ts), each a plain wall to the ground on the embankment and wherever its
  // stretch of bridge is under 4 m up (settle.ts: too low to drive under, so it stops street cars too); only
  // a higher bridge's is a parapet that cars beneath pass under.
  const SIM_PIECE = 4;
  for (const k of [-1, 1]) {
    const end = k === inner && slip ? L + GORE : L;
    const from = wallFrom(r, c, k, inner);
    for (let u = from; u < end - 1e-6; u += SIM_PIECE) {
      const e = Math.min(end, u + SIM_PIECE);
      const mid = (u + e) / 2;
      const foot = axisAt(ax, mid);
      const bridge = mid >= r.uSolid && surf(mid, 0).y - kit.h(foot.x, foot.z) >= 4;
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
      // Outer face (toward the outside) from its foot to the coping, the inner face from the surface, and the
      // coping; the wall's free start faces back down the ramp.
      quad(q0, q1, g0, p0.y + 1, g1, p1.y + 1, nx / nl, nz / nl);
      quad(p0, p1, p0.y, p0.y + 1, p1.y, p1.y + 1, -nx / nl, -nz / nl);
      band3(solid, p0, p1, q1, q0, 1, C.barrier);
      if (u === from) {
        const t = axisAt(ax, u);
        quad(p0, q0, g0, p0.y + 1, g0, q0.y + 1, -t.tx, -t.tz);
      }
    }
  }
  // The embankment's end where the bridge stretch begins (at E if it runs all the way), and the columns
  // under the bridge.
  {
    const ue = Math.min(uc, L);
    const a = surf(ue, -hw - wt);
    const b = surf(ue, hw + wt);
    const ga = kit.h(a.x, a.z);
    const gb = kit.h(b.x, b.z);
    const q = axisAt(ax, ue);
    const ids = [solid.vertex(a.x, ga - 0.3, a.z, q.tx, 0, q.tz, 0, 0, C.wall), solid.vertex(b.x, gb - 0.3, b.z, q.tx, 0, q.tz, 1, 0, C.wall), solid.vertex(b.x, b.y - 1.4, b.z, q.tx, 0, q.tz, 1, 1, C.wall), solid.vertex(a.x, a.y - 1.4, a.z, q.tx, 0, q.tz, 0, 1, C.wall)];
    solid.quadFacing(ids[0], ids[1], ids[2], ids[3], q.tx, 0, q.tz);
  }
  // A loop's columns stand under its axis; a slip ramp's just past its outer edge, behind the alley beneath
  // it, under a short cap beam across the ramp's band (the prop's height is its u along the ramp).
  for (const p of kit.builds[r.area.id].props) {
    if (p.kind !== 'rampColumn') continue;
    const soffit = surf(p.height, 0).y - 1.4;
    if (!slip) {
      cylinder(solid, p.x, p.z, p.size, kit.h(p.x, p.z) - 0.3, soffit, 10, C.concrete, false);
      continue;
    }
    cylinder(solid, p.x, p.z, p.size, kit.h(p.x, p.z) - 0.3, soffit - HW.capH + 0.05, 10, C.concrete, false);
    rampCap(solid, ax, p.height, inner * (hw + wt), -inner * (hw + wt + 2 * p.size + 0.4), soffit);
  }
  // Sodium lamps under a slip ramp's bridge stretch, over the cross street and the alley beneath it.
  if (slip) {
    for (let u = uc + 10; u < L - 5; u += HW.laneLampEvery) {
      const q = surf(u, 0);
      const y = q.y - 1.4;
      cylinder(kit.glow, q.x, q.z, 0.3, y - 0.12, y - 0.02, 6, LAMP.sodium, true);
      if (wash) pool(wash, q.x, q.z, (x, z) => kit.world.driveHeightAt(x, z), HW.alleyPool.r, HW.alleyPool.color);
    }
  }
  // A slip ramp's lane: its outer wall along the widened deck, the taper back to the deck's edge and on
  // past it (build.ts). A loop has none: E lies in the carriageway at the deck's end.
  if (slip) {
    const sEnd = r.sb + r.along * 7;
    const n = Math.max(2, Math.ceil(Math.abs(sEnd - r.sa) / 4));
    for (let k = 0; k < n; k++) {
      const sa = r.sa + ((sEnd - r.sa) * k) / n;
      const sb = r.sa + ((sEnd - r.sa) * (k + 1)) / n;
      const a = at(c, sa, r.side * rampOuterAt(r, sa));
      const e = at(c, sb, r.side * rampOuterAt(r, sb));
      const ta = deckTopAt(d, sa);
      const tb = deckTopAt(d, sb);
      const nx = e.z - a.z;
      const nz = -(e.x - a.x);
      const nl = Math.hypot(nx, nz) || 1;
      orientedBox(solid, a.x - (nx / nl) * 0.17, a.z - (nz / nl) * 0.17, e.x - (nx / nl) * 0.17, e.z - (nz / nl) * 0.17, (nx / nl) * 0.35, (nz / nl) * 0.35, Math.min(ta, tb) - 0.1, Math.max(ta, tb) + HW.barrierH, C.barrier);
    }
  }
  // The wall along the building line under a ramp's top where it has one (rampFront; none for a slip ramp
  // or a loop as they are planned now): from the sidewalk up to the soffit.
  const [f0, f1] = rampFront(r, c) ?? [0, 0];
  const P = curvePoint();
  for (let s = f0; s < f1 - 1e-6; s += 4) {
    const e = Math.min(f1, s + 4);
    const a = at(c, s, r.side * r.building, P);
    const b = at(c, e, r.side * r.building);
    const ya = deckUnderAt(d, s);
    const yb = deckUnderAt(d, e);
    const fx = P.tz * r.side;
    const fz = -P.tx * r.side;
    const ga = kit.h(a.x, a.z) - 0.3;
    const gb = kit.h(b.x, b.z) - 0.3;
    const ids = [solid.vertex(a.x, ga, a.z, fx, 0, fz, 0, 0, C.wall), solid.vertex(b.x, gb, b.z, fx, 0, fz, 1, 0, C.wall), solid.vertex(b.x, yb, b.z, fx, 0, fz, 1, 1, C.wall), solid.vertex(a.x, ya, a.z, fx, 0, fz, 0, 1, C.wall)];
    solid.quadFacing(ids[0], ids[1], ids[2], ids[3], fx, 0, fz);
  }
  // Lamp posts on the wall away from the deck (a loop's infield side), their pools on the asphalt (Medium and up).
  for (let u = Math.max(12, wallFrom(r, c, -inner, inner) + 2); u < L; u += HW.rampPostEvery) {
    const p = surf(u, -inner * (hw + wt / 2));
    const ty = p.y + 1 + HW.rampPostH;
    cylinder(solid, p.x, p.z, 0.09, p.y + 1, ty, 6, C.steel, false, 0.07);
    const h = surf(u, -inner * (hw - 1.6));
    orientedBox(solid, p.x, p.z, h.x, h.z, 0.08, 0.08, ty - 0.1, ty, C.steel);
    cylinder(kit.glow, h.x, h.z, 0.24, ty - 0.25, ty - 0.08, 6, LAMP.head, true);
    if (wash) {
      const g = surf(u, -inner * (hw - 2.4));
      const ground = g.y;
      pool(wash, g.x, g.z, () => ground, 7, HW.deckPool.color);
    }
  }
  // One way, two lanes: a dashed divider up the middle (Medium and up) and in both lanes the arrows the
  // way its traffic runs (up an on-ramp toward E, down an off-ramp toward its foot).
  const lw = HW.line / 2;
  if (!low) for (let u = 6; u + HW.dash < L - 2; u += HW.period) band3(paint, surf(u, -lw), surf(u + HW.dash, -lw), surf(u + HW.dash, lw), surf(u, lw), 0.03, C.white);
  const dir = r.on ? 1 : -1;
  for (let u = 14; u < L - 10; u += low ? 60 : 32) for (const v of [-hw / 2, hw / 2]) arrow(paint, surf, u, v, dir);
  // The mouth: EXPRESSWAY ON RAMP (WRONG WAY on a down ramp) on a mast, facing a car coming in from the street:
  // a slip ramp's beside its run on the outer wall, read from its nose's end, where both kinds' traffic
  // turns in off the street or out onto it by the junction; a loop's on the right hand wall of a car
  // driving in, just past where that wall starts.
  {
    const us = slip ? r.flat / 2 : Math.max(5, wallFrom(r, c, -1, inner) + 1);
    const vs = slip ? -inner : -1;
    const q = axisAt(ax, us);
    const p = surf(us, vs * (hw + wt / 2));
    const y = p.y + 1;
    cylinder(solid, p.x, p.z, 0.1, y, y + 4.2, 6, C.steel, false);
    const s = surf(us, vs * (hw - 1.6));
    signPanel(signs, s.x, y + 3.4, s.z, -q.tx, -q.tz, 4.4, 1.3, r.on ? RAMP_CELL : WRONG_WAY_CELL, col(0xffffff, 0.9));
    cylinder(kit.glow, s.x - q.tx * 0.3, s.z - q.tz * 0.3, 0.12, y + 4.15, y + 4.3, 6, LAMP.head, true);
  }
  if (r.loop) infield(kit, r);
}

/**
 * A loop's infield: grass on the ground inside its inner wall, cut off by the chord from E back to where
 * its arc starts (shape.ts loopFootprint: beyond it lies the block), and a few trees in it, render only:
 * the loop's walls and the street's frontage close it to cars.
 */
function infield(kit: DistrictKit, r: HighwayRamp): void {
  const ax = r.axis;
  const R = ax.r - r.half - 1.5;
  if (R < 6) return;
  // The arc's center lies on the side of travel its sweep's sign gives (projectAxis's v).
  const cs = ax.sweep > 0 ? 1 : -1;
  const edge = (u: number): Vec2 => {
    const q = axisAt(ax, u);
    const v = cs * (r.half + 1.5);
    return { x: q.x - q.tz * v, z: q.z + q.tx * v };
  };
  const a = edge(ax.a);
  const b = edge(ax.length);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dl = Math.hypot(dx, dz) || 1;
  const keep: 1 | -1 = dx * (ax.cz - a.z) - dz * (ax.cx - a.x) >= 0 ? 1 : -1;
  const ring: Vec2[] = [];
  for (let i = 0; i < 32; i++) {
    const t = (i / 32) * Math.PI * 2;
    ring.push({ x: ax.cx + Math.cos(t) * R, z: ax.cz + Math.sin(t) * R });
  }
  const poly = clipConvex(ring, a, b, keep);
  if (poly.length >= 3) drapeConvex(kit, kit.ground, poly, 0.04, C.grass, 6);
  const rng = new Rng((Math.imul(Math.round(ax.cx * 16), 73856093) ^ Math.imul(Math.round(ax.cz * 16), 19349663)) >>> 0);
  const want = HW.infieldTrees[kit.quality];
  const placed: Vec2[] = [];
  for (let tries = 0; tries < want * 10 && placed.length < want; tries++) {
    const ang = rng.range(0, Math.PI * 2);
    const rr = Math.sqrt(rng.range(0.04, 1)) * (R - 4);
    const x = ax.cx + Math.cos(ang) * rr;
    const z = ax.cz + Math.sin(ang) * rr;
    // Inside the chord too, and apart.
    if (((dx * (z - a.z) - dz * (x - a.x)) * keep) / dl < 4) continue;
    if (placed.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 49)) continue;
    placed.push({ x, z });
    tree(kit, x, z, rng.range(2.2, 3.2), rng.range(6, 9.5), { conifer: 0.25 });
  }
}

/**
 * An alley under a lane: its paving (the sim's road pieces, hints 'pave'), an edge line along its back
 * wall short of the mouths, and in a race a gate across every mouth onto a street the route does not
 * take (settle.ts highwayGates). The back wall is the city's boundary wall (infill.ts draws it).
 */
function alley(kit: DistrictKit, a: Area, signs: GeoBuilder, route: ReadonlySet<number>): void {
  for (const h of kit.builds[a.id].hints) if (h.kind === 'pave') drapeConvex(kit, kit.ground, h.points, 0.03, C.alley, 5);
  const c = deckCurve(kit.world.areas[a.params.deck]);
  const sd = a.params.side > 0 ? 1 : -1;
  const v = sd * (HALF + CFG.alleyDepth - HW.alleyEdge);
  const s0 = a.params.s0 + 3;
  const s1 = a.params.s1 - 3;
  for (let s = s0; s < s1 - 1e-6; s += 4) groundLine(kit, kit.paint, at(c, s, v), at(c, Math.min(s1, s + 4), v), 0.12, 0.05, C.alleyLine);
  if (kit.world.openWorld) return;
  const P = curvePoint();
  alleyMouths(a).forEach((m, k) => {
    if (m.edge < 0 || route.has(m.edge)) return;
    const len = Math.hypot(m.b.x - m.a.x, m.b.z - m.a.z);
    if (len < 0.5) return;
    // Facing out onto the cross street: along the deck away from the alley (mouth 0 at its low s end).
    sampleCurve(c, k === 0 ? a.params.s0 : a.params.s1, P);
    let nx = -(m.b.z - m.a.z) / len;
    let nz = (m.b.x - m.a.x) / len;
    if ((nx * P.tx + nz * P.tz) * (k === 0 ? -1 : 1) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const ya = kit.world.driveHeightAt(m.a.x, m.a.z);
    const yb = kit.world.driveHeightAt(m.b.x, m.b.z);
    gateBarrier(kit, signs, { x: m.a.x, y: ya, z: m.a.z }, { x: m.b.x, y: yb, z: m.b.z }, nx, nz);
  });
}

/**
 * A race gate's cyan barrier from a to b (heights included), where the sim's gate stands (settle.ts
 * highwayGates): two glowing rails on posts and a ROAD CLOSED plate in the middle facing (nx, nz), the
 * way a car comes at it.
 */
function gateBarrier(kit: DistrictKit, signs: GeoBuilder, a: P3, b: P3, nx: number, nz: number): void {
  for (const y of [0.45, 0.95]) {
    const ga = a.y + y;
    const gb = b.y + y;
    orientedBox(kit.glow, a.x, a.z, b.x, b.z, -nx * 0.18, -nz * 0.18, Math.min(ga, gb), Math.max(ga, gb) + 0.12, LAMP.cyan);
  }
  for (let t = 0; t <= 1.0001; t += 0.25) {
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    cylinder(kit.solid, x, z, 0.07, Math.min(a.y, b.y) - 0.1, Math.max(a.y, b.y) + 1.15, 5, C.post, false);
  }
  signPanel(signs, (a.x + b.x) / 2 + nx * 0.2, (a.y + b.y) / 2 + 1.75, (a.z + b.z) / 2 + nz * 0.2, nx, nz, 3.6, 0.9, CLOSED_CELL, col(0xffffff, 0.85));
}

/** A quad through four points with heights, lifted by `lift`, facing up (or down). */
function band3(gb: GeoBuilder, a: P3, b: P3, c: P3, d: P3, lift: number, color: THREE.Color, up = true): void {
  const n = up ? 1 : -1;
  const ids = [gb.vertex(a.x, a.y + lift, a.z, 0, n, 0, 0, 0, color), gb.vertex(b.x, b.y + lift, b.z, 0, n, 0, 1, 0, color), gb.vertex(c.x, c.y + lift, c.z, 0, n, 0, 1, 1, color), gb.vertex(d.x, d.y + lift, d.z, 0, n, 0, 0, 1, color)];
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, n, 0);
}

/** A lane arrow painted on the ramp at (u, v), pointing up the ramp (dir +1) or down it. */
function arrow(gb: GeoBuilder, surf: (u: number, v: number) => P3, u: number, v: number, dir: number): void {
  const len = 4.2;
  const head = 1.6;
  const tail = u - (dir * len) / 2;
  const tip = u + (dir * len) / 2;
  const neck = tip - dir * head;
  const q = (pts: P3[]) => {
    const ids = pts.map((p) => gb.vertex(p.x, p.y + 0.035, p.z, 0, 1, 0, 0, 0, C.white));
    if (ids.length === 4) gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    else gb.triFacing(ids[0], ids[1], ids[2], 0, 1, 0);
  };
  q([surf(tail, v - 0.15), surf(neck, v - 0.15), surf(neck, v + 0.15), surf(tail, v + 0.15)]);
  q([surf(neck, v - 0.65), surf(tip, v), surf(neck, v + 0.65)]);
}
