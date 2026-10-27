/**
 * Bluff: an escarpment across the El. A few blocks of the city stand on a
 * terrace several meters up: a steep rock face along one side (between two
 * street rows, through the middle of the blocks), gentle slopes on the other
 * three. The streets that cross the face climb it on ramps cut into it, at
 * the hills' grade cap, between retaining walls; the face between them is a
 * rock wall nobody drives on (it stands inside the blocks, behind the street
 * frontage, and the frontage along every ramp is a 'bluff' retaining wall).
 *
 * The El does not follow the ground. Where it reaches the bluff it leaves its
 * street on an easy S curve for a right of way through the blocks
 * (CFG.rowOffset beside the street, buildings kept out) and holds one
 * absolute level across the whole terrace (city/railCurve.ts RailLevel): tall
 * columns over the low ground, short ones toward the face, then the high
 * ground comes up to the track and it runs at grade along the top, in a
 * shallow cutting or on a low bank where the ground rolls, fenced off, before
 * the back slope falls away and the columns grow again. The street along the
 * crest crosses the tracks there at grade: a level crossing with gates timed
 * to the trains (sim/levelCrossing.ts, rendered by render/districts/bluff.ts).
 * Its ground is flattened to the rail level (a small exact pad) so the road
 * and the rails meet flush. Where the El crosses a street on the low side or
 * the back slope with less than CFG.clearance under the deck, the street dips
 * under it (a short sag between retaining walls) so it stays clear overhead.
 *
 * Why the detour: the El hangs over its street's curb lane. Kept there, the
 * level track would meet the climbing street, so the ramp under it could not
 * exist and a level crossing would sit in the middle of an intersection. On
 * its own right of way the street keeps both lanes and climbs like the
 * others, and the crossing lands mid-block on a plain straight street, far
 * from any junction, where gates, signals and waiting cars have room.
 *
 * Planned after the subway, the roundabouts and the alleys and before the
 * back alleys and the routes (districts/index.ts): it edits the subway area's
 * path and polygon and tells its build where the detour runs (params.bluff),
 * keeps clear of roundabouts, the river and the lake, and claims the streets it
 * reshapes (ramps, dips, the crest) and the nodes on it, so back alleys,
 * route shortcuts, parks and the monument keep off; the hills keep off its
 * whole footprint (hills.ts). Height: one modifier with an exact analytic
 * gradient (terrace x envelope x face/ramp step, the pad, the sags), 0 at its
 * box.
 */
import { CITY } from '../config';
import { chainCum, chainOf, gridChain } from '../roadGraph';
import type { Chain, RoadEdge, RoadGraph } from '../roadGraph';
import { Vec2, distToSegment, segmentT, sqrt } from '../../sim/math';
import { createTerrain } from '../terrain';
import type { Terrain } from '../terrain';
import { RAIL, buildRailCurve } from '../railCurve';
import type { Area, DistrictModule, HeightSample, PlanContext } from './types';
import { emptyBuild } from './types';
import { distToPolygonEdge, pointInPolygon, smooth01v } from './geom';
import { riverCenter } from './river';
import { applyElDetour, elColumnAt, elDetourPath, elStreetEdges, gridNode } from './subway';

const CFG = CITY.districts.bluff;
/** The deck (tie) top sits this far under the crossing's road, so the rail heads come up flush with it (m). */
const RAIL_SINK = 0.14;
const SUB = CITY.districts.subway;

/** A street crossing the face: its centerline (through the face point R, unit direction D toward the high side) and corridor half width. */
interface BluffRamp {
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** Curb to the outer sidewalk line (m). */
  hw: number;
  /** Length across the face (m): the step it climbs there over the grade cap, plus the lip. */
  L: number;
  edge: number;
}

/** A dip of a street under the El (center on the street, unit direction along it). */
interface BluffSag {
  x: number;
  z: number;
  dx: number;
  dz: number;
  hw: number;
  /** Depth (m), the flat bottom's half length under the deck (m) and the slope length beyond it (m). */
  depth: number;
  flat: number;
  w: number;
  edge: number;
}

/**
 * Everything the profile needs, read back from the area params. Frame: u
 * along the face (U), v across it toward the high side (V), origin O on the
 * face line where the El's street crosses it.
 */
export interface BluffShape {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  /** Full height between uA and uB, easing to 0 over `we` beyond each (m). */
  uA: number;
  uB: number;
  we: number;
  /** Step height (m). */
  H: number;
  /** Rock face span across (m), plateau far edge v (m) and back slope width (m). */
  fw: number;
  vp: number;
  wd: number;
  /** Longest ramp across the face (m, at full height) and every ramp's lip (m). */
  L: number;
  lip: number;
  ramps: BluffRamp[];
  sags: BluffSag[];
  /** Level crossing: center, and the flat ground level of its pad (m, absolute; the plateau plus a hump). */
  cx: number;
  cz: number;
  top: number;
  /** Track level (deck top) across the bluff (m, absolute). */
  y: number;
}

export function bluffShape(area: Area): BluffShape {
  const p = area.params;
  const ramps: BluffRamp[] = [];
  for (let k = 0; k < p.ramps; k++) ramps.push({ x: p[`r${k}x`], z: p[`r${k}z`], dx: p[`r${k}dx`], dz: p[`r${k}dz`], hw: p[`r${k}hw`], L: p[`r${k}L`], edge: p[`r${k}e`] });
  const sags: BluffSag[] = [];
  for (let k = 0; k < p.sags; k++) sags.push({ x: p[`s${k}x`], z: p[`s${k}z`], dx: p[`s${k}dx`], dz: p[`s${k}dz`], hw: p[`s${k}hw`], depth: p[`s${k}d`], flat: p[`s${k}f`], w: p[`s${k}w`], edge: p[`s${k}e`] });
  return { ox: p.ox, oz: p.oz, ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz, uA: p.uA, uB: p.uB, we: p.we, H: p.H, fw: p.fw, vp: p.vp, wd: p.wd, L: p.L, lip: p.lip, ramps, sags, cx: p.cx, cz: p.cz, top: p.top, y: p.y };
}

/**
 * Smoothstep from e0 to e1 at x and its derivative, into SV / SD: the terrain
 * is queried per wheel per substep, so the profile allocates nothing.
 */
let SV = 0;
let SD = 0;
function ss(e0: number, e1: number, x: number): void {
  const w = e1 - e0;
  const t = (x - e0) / w;
  if (t <= 0) {
    SV = 0;
    SD = 0;
  } else if (t >= 1) {
    SV = 1;
    SD = 0;
  } else {
    SV = t * t * (3 - 2 * t);
    SD = (6 * t * (1 - t)) / w;
  }
}

/** Ramp step over t in [0, 1] (0 low, 1 high), into SV / SD (per unit t): quadratic lips of share `a` at both ends, a constant grade between. */
function step(t: number, a: number): void {
  const k = 1 / (1 - a);
  if (t <= 0) {
    SV = 0;
    SD = 0;
  } else if (t >= 1) {
    SV = 1;
    SD = 0;
  } else if (t < a) {
    SV = (k * t * t) / (2 * a);
    SD = (k * t) / a;
  } else if (t > 1 - a) {
    SV = 1 - (k * (1 - t) * (1 - t)) / (2 * a);
    SD = (k * (1 - t)) / a;
  } else {
    SV = k * (t - a / 2);
    SD = k;
  }
}

/** The envelope along the face at u: 1 across the core, easing to 0 over `we` beyond it. */
export function envelope(s: BluffShape, u: number): number {
  return smooth01v(s.uA - s.we, s.uA, u) * (1 - smooth01v(s.uB, s.uB + s.we, u));
}

/** Frame coordinates of a point. */
export function bluffUV(s: BluffShape, x: number, z: number): { u: number; v: number } {
  const rx = x - s.ox;
  const rz = z - s.oz;
  return { u: rx * s.ux + rz * s.uz, v: rx * s.vx + rz * s.vz };
}

/**
 * The terrace alone (no pad, no sags): height and exact gradient added into
 * `out`. H * E(u) * P(v) * C(u, v): E the envelope along the face, P the back
 * slope, C the step across the face (the rock face, or a ramp's profile in a
 * street's corridor, blended over CFG.blend behind its frontage).
 */
export function terraceAt(s: BluffShape, x: number, z: number, out: HeightSample): void {
  const rx = x - s.ox;
  const rz = z - s.oz;
  const u = rx * s.ux + rz * s.uz;
  const v = rx * s.vx + rz * s.vz;
  if (u <= s.uA - s.we || u >= s.uB + s.we || v <= -s.L / 2 || v >= s.vp + s.wd) return;
  ss(s.uA - s.we, s.uA, u);
  const e0 = SV;
  const e0d = SD;
  ss(s.uB, s.uB + s.we, u);
  const E = e0 * (1 - SV);
  const dE = e0d * (1 - SV) - e0 * SD;
  ss(s.vp, s.vp + s.wd, v);
  const P = 1 - SV;
  const dP = -SD;
  ss(-s.fw / 2, s.fw / 2, v);
  const c0 = SV;
  const c0d = SD;
  let C = c0;
  let cx = c0d * s.vx;
  let cz = c0d * s.vz;
  for (const r of s.ramps) {
    const nx = -r.dz;
    const nz = r.dx;
    const q = (x - r.x) * nx + (z - r.z) * nz;
    const aq = q < 0 ? -q : q;
    if (aq >= r.hw + CFG.blend) continue;
    ss(r.hw, r.hw + CFG.blend, aq);
    const W = 1 - SV;
    const dW = -SD * (q < 0 ? -1 : 1);
    step((v + r.L / 2) / r.L, s.lip / r.L);
    const R = SV;
    const dR = SD / r.L;
    // C += (R - C0) W, with C0 the face step (each ramp's window is its own; they never overlap).
    C += (R - c0) * W;
    cx += (dR - c0d) * s.vx * W + (R - c0) * dW * nx;
    cz += (dR - c0d) * s.vz * W + (R - c0) * dW * nz;
  }
  out.h += s.H * E * P * C;
  out.gx += s.H * (dE * s.ux * P * C + E * dP * s.vx * C + E * P * cx);
  out.gz += s.H * (dE * s.uz * P * C + E * dP * s.vz * C + E * P * cz);
}

/** The pad and the sags on top of `base` + terrace (th, tgx, tgz: the terrace here), added into `out`. */
function localAt(s: BluffShape, base: Terrain, x: number, z: number, out: HeightSample, th: number, tgx: number, tgz: number): void {
  const dx = x - s.cx;
  const dz = z - s.cz;
  const d2 = dx * dx + dz * dz;
  if (d2 < CFG.padOut * CFG.padOut) {
    // Flatten to the crossing's level: final = (1 - Wp) (base + terrace) + Wp top.
    const d = sqrt(d2);
    ss(CFG.padIn, CFG.padOut, d);
    const Wp = 1 - SV;
    const dW = d > 1e-9 ? -SD / d : 0;
    const g = base.slopeAt(x, z);
    const F = base.heightAt(x, z) + th - s.top;
    out.h -= F * Wp;
    out.gx -= (g.gx + tgx) * Wp + F * dW * dx;
    out.gz -= (g.gz + tgz) * Wp + F * dW * dz;
  }
  for (const g of s.sags) {
    const rx = x - g.x;
    const rz = z - g.z;
    const a = rx * g.dx + rz * g.dz;
    const q = -rx * g.dz + rz * g.dx;
    const aa = a < 0 ? -a : a;
    const aq = q < 0 ? -q : q;
    if (aa >= g.flat + g.w || aq >= g.hw + CFG.blend) continue;
    ss(g.flat, g.flat + g.w, aa);
    const B = 1 - SV;
    const dB = -SD * (a < 0 ? -1 : 1);
    ss(g.hw, g.hw + CFG.blend, aq);
    const W = 1 - SV;
    const dW = -SD * (q < 0 ? -1 : 1);
    out.h -= g.depth * B * W;
    // d/dx of a is dx, of q is -dz; d/dz of a is dz, of q is dx.
    out.gx -= g.depth * (dB * W * g.dx + B * dW * -g.dz);
    out.gz -= g.depth * (dB * W * g.dz + B * dW * g.dx);
  }
}

/** Scratch for the terrace part of bluffAt (never re-entered: terraceAt calls nothing back). */
const TERRACE: HeightSample = { h: 0, gx: 0, gz: 0 };

/** The bluff's whole modifier (terrace, crossing pad, sags) at (x, z), added into `out`. `base` is the seed's base terrain. */
function bluffAt(s: BluffShape, base: Terrain, x: number, z: number, out: HeightSample): void {
  TERRACE.h = TERRACE.gx = TERRACE.gz = 0;
  terraceAt(s, x, z, TERRACE);
  const th = TERRACE.h;
  const tgx = TERRACE.gx;
  const tgz = TERRACE.gz;
  out.h += th;
  out.gx += tgx;
  out.gz += tgz;
  localAt(s, base, x, z, out, th, tgx, tgz);
}

/** World box of the modifier (terrace rectangle, pad, sags). */
function shapeBounds(s: BluffShape): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const add = (x: number, z: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  for (const u of [s.uA - s.we, s.uB + s.we]) for (const v of [-s.L / 2, s.vp + s.wd]) add(s.ox + s.ux * u + s.vx * v, s.oz + s.uz * u + s.vz * v);
  add(s.cx - CFG.padOut, s.cz - CFG.padOut);
  add(s.cx + CFG.padOut, s.cz + CFG.padOut);
  for (const g of s.sags) {
    const r = g.flat + g.w + g.hw + CFG.blend;
    add(g.x - r, g.z - r);
    add(g.x + r, g.z + r);
  }
  return { minX: minX - 2, minZ: minZ - 2, maxX: maxX + 2, maxZ: maxZ + 2 };
}

/** Terrain estimate at plan time: the base plus this bluff (nothing else is allowed near it). */
export function bluffGround(s: BluffShape, base: Terrain): (x: number, z: number) => number {
  const out: HeightSample = { h: 0, gx: 0, gz: 0 };
  return (x, z) => {
    out.h = out.gx = out.gz = 0;
    bluffAt(s, base, x, z, out);
    return base.heightAt(x, z) + out.h;
  };
}

/** Footprint: the whole modifier's rectangle (in the face frame) from the low ramp ends to the foot of the back slope. */
function footprint(s: BluffShape, grow = 0): Vec2[] {
  const at = (u: number, v: number): Vec2 => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
  const u0 = s.uA - s.we - grow;
  const u1 = s.uB + s.we + grow;
  const v0 = -s.L / 2 - 2 - grow;
  const v1 = s.vp + s.wd + grow;
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}

/** The whole footprint of a bluff area, `grow` m bigger (the hills keep their slopes off it). */
export function bluffFootprint(area: Area, grow = 0): Vec2[] {
  return footprint(bluffShape(area), grow);
}

/**
 * The area's outline (areaAt, the maps, place names): the terrace proper, from
 * the low ends of the ramps to most of the way down the back slope (where
 * the El is still low over its right of way), half way out along the tapers;
 * the gentle rest is plain city on a slope.
 */
function outline(s: BluffShape): Vec2[] {
  const at = (u: number, v: number): Vec2 => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
  const u0 = s.uA - s.we / 2;
  const u1 = s.uB + s.we / 2;
  const v0 = -s.L / 2 - 2;
  const v1 = s.vp + s.wd * 0.8;
  return [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
}

/** Grid junction (i, j), looked up by gi/gj (subway.ts gridNode): node ids are not j * gridW + i once districts edit the graph. */
const nodeAt = (g: RoadGraph, i: number, j: number) => gridNode(g, i, j);
/**
 * The level crossing keeps this far (m) along the crest street from its bend nodes (roadGraph.ts): its
 * gates are laid out in its piece's frame, and past a bend node of a few degrees a gate line that
 * overhangs onto the next piece is off by a few tenths of a metre at most.
 */
const CROSSING_BEND_CLEAR = 8;
/** The right of way's second try sits this much further from the El's street than rowOffset (m): past the crest street's first bend node. */
const ROW_OFFSET_STEP = 16;

/** Point where segment a-b crosses the line through p with unit direction d (t along a-b), or null. */
function crossLine(ax: number, az: number, bx: number, bz: number, px: number, pz: number, dx: number, dz: number): { t: number; x: number; z: number } | null {
  const ex = bx - ax;
  const ez = bz - az;
  const den = ex * dz - ez * dx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((px - ax) * dz - (pz - az) * dx) / den;
  if (t < 0 || t > 1) return null;
  return { t, x: ax + ex * t, z: az + ez * t };
}

/** The plan of one candidate placement, everything the area params and the subway edit need. */
interface Placement {
  /** The right of way's distance from the El's street (m): rowOffset, or one ROW_OFFSET_STEP further. */
  rowOffset: number;
  shape: BluffShape;
  /** Subway path points that move (node row -> point). */
  moved: Map<number, Vec2>;
  rowA: Vec2;
  rowB: Vec2;
  crestEdge: number;
  rows: { leg0: number; low: number; crest: number; dip: number; leg1: number };
  nodes: number[];
  edges: number[];
  poly: Vec2[];
  area: number;
}

export const bluffModule: DistrictModule = {
  kind: 'bluff',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const sub = ctx.areas.find((a) => a.kind === 'subway');
    if (!sub) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const base = createTerrain(ctx.seed);
    // Crest rows with two rows of the El on either side; the legs may sit on the map's edge rows, where the
    // El's run-off carries straight on (the El swings columns elsewhere, so the straight stretches are shorter).
    const cands: { r: number; o: 1 | -1 }[] = [];
    for (let r = 2; r <= CITY.gridH - 3; r++) for (const o of [1, -1] as const) cands.push({ r, o });
    rng.shuffle(cands);
    for (const c of cands) {
      // The right of way at rowOffset, or a little further out where that puts the crossing on a bend
      // node of the crest street (a street's bend nodes stand near its thirds, roadGraph.ts).
      // On the side the El swings toward, else (CFG.mirror) across its street: a river, a lake or a diagonal
      // on one side leaves the other free, which doubles the placements.
      let pl: Placement | null = null;
      for (const dir of CFG.mirror ? ([1, -1] as const) : ([1] as const)) {
        pl = tryPlace(ctx, sub, base, c.r, c.o, CFG.rowOffset, dir) ?? tryPlace(ctx, sub, base, c.r, c.o, CFG.rowOffset + ROW_OFFSET_STEP, dir);
        if (pl) break;
      }
      if (!pl) continue;
      if (ctx.budget.used + pl.area > ctx.budget.total) continue;
      commit(ctx, sub, pl, c.r, c.o);
      return;
    }
  },

  build(ctx, area) {
    const b = emptyBuild();
    const s = bluffShape(area);
    const base = createTerrain(ctx.seed);
    const g = ctx.graph;
    const bb = shapeBounds(s);
    b.heightMods.push({ ...bb, add: (x, z, out) => bluffAt(s, base, x, z, out) });
    const at = (u: number, v: number): Vec2 => ({ x: s.ox + s.ux * u + s.vx * v, z: s.oz + s.uz * u + s.vz * v });
    // Buildings and infill keep off the rock face (and their lots off its foot).
    const fu0 = s.uA - s.we;
    const fu1 = s.uB + s.we;
    const band = s.fw / 2 + 6;
    for (let u = fu0; u < fu1; u += 40) {
      const u1 = Math.min(fu1, u + 40);
      b.exclusions.push([at(u, -band), at(u1, -band), at(u1, band), at(u, band)]);
    }
    /** Rectangles along a street line (point p, unit d) from a0 to a1 along it, lateral q0..q1, one each side of it. */
    const strip = (px: number, pz: number, dx: number, dz: number, a0: number, a1: number, q0: number, q1: number): Vec2[][] => {
      const nx = -dz;
      const nz = dx;
      const out: Vec2[][] = [];
      for (const sd of [1, -1]) {
        const P = (a: number, q: number): Vec2 => ({ x: px + dx * a + nx * q * sd, z: pz + dz * a + nz * q * sd });
        out.push([P(a0, q0), P(a1, q0), P(a1, q1), P(a0, q1)]);
      }
      return out;
    };
    // Ramps: retaining walls along both frontages (the city's frontage walls take the 'bluff' look),
    // no buildings beside them. A ramp's v span maps to distance along its street through D . V.
    for (const r of s.ramps) {
      const cosA = Math.max(0.5, r.dx * s.vx + r.dz * s.vz);
      const a = r.L / 2 / cosA + 2;
      for (const p of strip(r.x, r.z, r.dx, r.dz, -a, a, r.hw - 1.5, r.hw + 1.5)) b.frontLooks.push({ polygon: p, look: 'bluff', area: area.id });
      for (const p of strip(r.x, r.z, r.dx, r.dz, -a - 2, a + 2, r.hw - 1, r.hw + 26)) b.exclusions.push(p);
      b.hints.push({ kind: 'ramp', points: [{ x: r.x, z: r.z }, { x: r.dx, z: r.dz }], values: [r.hw, a, r.edge] });
    }
    for (const sg of s.sags) {
      const a = sg.flat + sg.w + 1;
      for (const p of strip(sg.x, sg.z, sg.dx, sg.dz, -a, a, sg.hw - 1.5, sg.hw + 1.5)) b.frontLooks.push({ polygon: p, look: 'bluff', area: area.id });
      for (const p of strip(sg.x, sg.z, sg.dx, sg.dz, -a - 2, a + 2, sg.hw - 1, sg.hw + 24)) b.exclusions.push(p);
      b.hints.push({ kind: 'sag', points: [{ x: sg.x, z: sg.z }, { x: sg.dx, z: sg.dz }], values: [sg.hw, sg.flat + sg.w, sg.depth, sg.edge] });
    }
    // The crossing: the right of way's mouths on both frontages are the El's fence, the pad stays clear.
    const ce = g.edges[area.params.crestEdge];
    const A = g.nodes[ce.a];
    const B = g.nodes[ce.b];
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
    const rdx = (B.x - A.x) / len;
    const rdz = (B.z - A.z) / len;
    const hw = ce.width / 2 + ce.sidewalk;
    // Along the street, the right of way (deck width + 2 m each side) is this wide where it crosses.
    const tdx = area.params.rowBx - area.params.rowAx;
    const tdz = area.params.rowBz - area.params.rowAz;
    const tl = sqrt(tdx * tdx + tdz * tdz) || 1;
    const sinX = Math.max(0.5, Math.abs((tdx / tl) * -rdz + (tdz / tl) * rdx));
    const mouth = (SUB.deckWidth / 2 + 2) / sinX;
    for (const p of strip(s.cx, s.cz, rdx, rdz, -mouth, mouth, hw - 1.5, hw + 1.5)) b.frontLooks.push({ polygon: p, look: 'railFence', area: area.id });
    for (let a = -12; a <= 12; a += 3) for (const sd of [1, -1]) b.reserved.push({ x: s.cx + rdx * a - rdz * (hw - 1.5) * sd, z: s.cz + rdz * a + rdx * (hw - 1.5) * sd, r: 2.6 });
    b.hints.push({ kind: 'crossing', points: [{ x: s.cx, z: s.cz }, { x: rdx, z: rdz }, { x: tdx / tl, z: tdz / tl }], values: [hw, area.params.crestEdge, s.y, mouth] });
    // The face line pieces between the street corridors, for the renderer's rock wall.
    const cuts = s.ramps
      .map((r) => {
        const { u } = bluffUV(s, r.x, r.z);
        const cosU = Math.max(0.3, Math.abs(r.dx * s.vx + r.dz * s.vz));
        const half = (r.hw + CFG.blend) / cosU;
        return [u - half, u + half];
      })
      .sort((p, q) => p[0] - q[0]);
    let u = fu0;
    for (const [c0, c1] of cuts) {
      if (c0 > u + 1) b.hints.push({ kind: 'face', points: [at(u, 0), at(c0, 0)], values: [u, c0] });
      u = Math.max(u, c1);
    }
    if (fu1 > u + 1) b.hints.push({ kind: 'face', points: [at(u, 0), at(fu1, 0)], values: [u, fu1] });
    return b;
  },
};

/**
 * Try one placement: crest street row `r`, the high side toward rows r + o.
 * Rows: low r - o (the foot), crest r, dip r + o (the back slope's foot), the
 * El's S curves over the blocks to rows r -/+ 2o. Returns null when anything
 * does not fit (a missing street, a diagonal through it, the river, a ramp
 * or a dip too close to a junction, the El too low somewhere).
 */
function tryPlace(ctx: PlanContext, sub: Area, base: Terrain, r: number, o: 1 | -1, rowOffset: number, dir: 1 | -1): Placement | null {
  const g = ctx.graph;
  // The El must run straight on one column across the whole detour (it may swing to another column elsewhere).
  const c0 = elColumnAt(sub, r);
  const side = sub.params.side;
  // The right of way's side of the El's street: the way it swings (dir 1) or the other.
  const rowSide = side * dir;
  const c1 = c0 + rowSide;
  if (c0 < 0 || c1 < 0 || c1 >= CITY.gridW) return null;
  const rows = { leg0: r - 2 * o, low: r - o, crest: r, dip: r + o, leg1: r + 2 * o };
  for (const j of [rows.leg0, rows.low, rows.dip, rows.leg1]) if (elColumnAt(sub, j) !== c0) return null;
  // The crest street between the El's column and the next must exist, plain and straight across:
  // every piece of it (a street is a chain of pieces through bend nodes, roadGraph.ts).
  const crestA = nodeAt(g, c0, r);
  const crestB = nodeAt(g, c1, r);
  const crestChain = gridChain(g, crestA.id, crestB.id);
  if (!crestChain) return null;
  const crestPieces = new Set(crestChain.edges);
  for (const id of crestChain.edges) {
    const ce = g.edges[id];
    if (ce.kind !== 'street' && ce.kind !== 'avenue' && ce.kind !== 'boulevard') return null;
    if (ce.bridge || ctx.claims.edge.has(id)) return null;
  }
  /** Distance (m) along a street (chain) of a point on one of its pieces. */
  const alongStreet = (street: Chain, piece: number, p: Vec2): number => {
    const k = street.edges.indexOf(piece);
    const e = g.edges[piece];
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const local = segmentT(p.x, p.z, A.x, A.z, B.x, B.z) * e.length;
    return chainCum(g, street)[k] + (e.a === street.nodes[k] ? local : e.length - local);
  };
  // Face line: through the middles of the two column streets' blocks between the low row and the crest.
  const mid = (c: number) => {
    const a = nodeAt(g, c, rows.low);
    const b = nodeAt(g, c, r);
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  };
  const M0 = mid(c0);
  const M1 = mid(c1);
  const ml = sqrt((M1.x - M0.x) ** 2 + (M1.z - M0.z) ** 2) || 1;
  const ux = (M1.x - M0.x) / ml;
  const uz = (M1.z - M0.z) / ml;
  let vx = -uz;
  let vz = ux;
  if ((crestA.x - M0.x) * vx + (crestA.z - M0.z) * vz < 0) {
    vx = -vx;
    vz = -vz;
  }
  const uv = (x: number, z: number) => ({ u: (x - M0.x) * ux + (z - M0.z) * uz, v: (x - M0.x) * vx + (z - M0.z) * vz });
  // Right of way: beside the El's street, from the low row to the dip row.
  const elNode = (j: number) => nodeAt(g, c0, j);
  const rowPoint = (j: number): Vec2 => {
    const n = elNode(j);
    const px = n.x + rowSide * rowOffset;
    return { x: px, z: n.z };
  };
  const ra = rowPoint(rows.low);
  const rb = rowPoint(rows.dip);
  const rl = sqrt((rb.x - ra.x) ** 2 + (rb.z - ra.z) ** 2) || 1;
  const rdx = (rb.x - ra.x) / rl;
  const rdz = (rb.z - ra.z) / rl;
  // Where the right of way line crosses a row street (or the row's mean z when the street is missing there).
  // (The piece of the street it crosses, and every piece of that street.)
  const onRow = (j: number): { p: Vec2; edge: number; pieces: number[] } => {
    const a = nodeAt(g, c0, j);
    const b = nodeAt(g, c1, j);
    const street = gridChain(g, a.id, b.id);
    for (const id of street?.edges ?? []) {
      const e = g.edges[id];
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const hit = crossLine(A.x, A.z, B.x, B.z, ra.x, ra.z, rdx, rdz);
      if (hit) return { p: { x: hit.x, z: hit.z }, edge: id, pieces: street!.edges };
    }
    const zm = (a.z + b.z) / 2;
    const t = (zm - ra.z) / (rdz || 1e-9);
    return { p: { x: ra.x + rdx * t, z: ra.z + rdz * t }, edge: -1, pieces: [] };
  };
  const low = onRow(rows.low);
  const crest = onRow(r);
  const dip = onRow(rows.dip);
  if (!crestPieces.has(crest.edge)) return null;
  const crestEdge = crest.edge;
  const C = crest.p;
  // The crossing keeps well clear of both junctions of its street, and off its bend nodes (its
  // gates and pad are built in its piece's frame).
  const ta = alongStreet(crestChain, crestEdge, C);
  if (ta < 36 || crestChain.length - ta < 36) return null;
  const crestCum = chainCum(g, crestChain);
  for (let i = 1; i + 1 < crestChain.nodes.length; i++) if (Math.abs(crestCum[i] - ta) < CROSSING_BEND_CLEAR) return null;
  const vC = uv(C.x, C.z).v;
  if (vC < 40) return null;
  // The plateau runs on past the crossing's pad before the back slope falls away.
  const vp = vC + CFG.plateauPast;
  // Envelope: full height across both column streets' corridors, easing out beyond.
  const uC1 = uv(M1.x, M1.z).u;
  const uA = -24;
  const uB = uC1 + 24;
  // The El's nodes along the detour (no roundabout may sit on one).
  const detourNodes = [rows.leg0, rows.low, r, rows.dip, rows.leg1].map((j) => elNode(j));
  for (let H = CFG.height[1]; H >= CFG.height[0] - 1e-9; H -= 0.5) {
    const L = H / CFG.rampGrade + CFG.rampLip;
    const we = (1.5 * H) / CFG.sideGrade;
    const wd = (1.5 * H) / CFG.sideGrade;
    const shape: BluffShape = { ox: M0.x, oz: M0.z, ux, uz, vx, vz, uA, uB, we, H, fw: CFG.face, vp, wd, L, lip: CFG.rampLip, ramps: [], sags: [], cx: C.x, cz: C.z, top: base.heightAt(C.x, C.z) + H, y: 0 };
    shape.y = shape.top - RAIL_SINK;
    const poly = footprint(shape);
    // Streets in the footprint: every one crossing the face (where it has any height) climbs it on a
    // ramp, crossing it square enough (CFG.rampSkew), with room before both its junctions.
    let ok = true;
    const ramps: BluffRamp[] = [];
    for (const e of g.edges) {
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const inA = pointInPolygon(a.x, a.z, poly);
      const inB = pointInPolygon(b.x, b.z, poly);
      const hitFace = crossLine(a.x, a.z, b.x, b.z, M0.x, M0.z, ux, uz);
      const fu = hitFace ? uv(hitFace.x, hitFace.z).u : NaN;
      const onFace = hitFace !== null && fu > uA - we - 8 && fu < uB + we + 8;
      if (!inA && !inB && !onFace && !segmentCrossesPolygon(a, b, poly)) continue;
      // Anything of the river's in there is ruled out; any street may run over the gentle slopes (like
      // a hill's flank).
      if (e.kind === 'channel' || e.kind === 'ramp' || e.bridge || e.shortcut) {
        ok = false;
        break;
      }
      if (!onFace) continue;
      // Oriented toward the high side.
      let dx = (b.x - a.x) / (e.length || 1);
      let dz = (b.z - a.z) / (e.length || 1);
      if (dx * vx + dz * vz < 0) {
        dx = -dx;
        dz = -dz;
      }
      const cosA = dx * vx + dz * vz;
      // The step it climbs here (the envelope's most across its corridor) sets its length; room
      // before both junctions: the ramp's ends (along the street) clear of the crossing corridors.
      const reachU = (e.width / 2 + e.sidewalk + CFG.blend) / Math.max(0.3, cosA);
      const Ek = Math.max(envelope(shape, fu - reachU), envelope(shape, fu), envelope(shape, fu + reachU));
      if (Ek < 0.005) continue;
      if (cosA < CFG.rampSkew) {
        ok = false;
        break;
      }
      const Lk = (H * Ek) / CFG.rampGrade + CFG.rampLip;
      const half = Lk / 2 / cosA;
      // Room before both junctions of the whole street (its pieces through bend nodes).
      const street = chainOf(g, e.id);
      const tf = alongStreet(street, e.id, hitFace!);
      if (tf < half + CFG.nodeClear || street.length - tf < half + CFG.nodeClear) {
        ok = false;
        break;
      }
      ramps.push({ x: hitFace!.x, z: hitFace!.z, dx, dz, hw: e.width / 2 + e.sidewalk, L: Lk, edge: e.id });
    }
    if (!ok) continue;
    // The crossing's flattened pad stays off every ramp corridor.
    for (const rp of ramps) if (Math.abs((C.x - rp.x) * -rp.dz + (C.z - rp.z) * rp.dx) < CFG.padOut + rp.hw + CFG.blend) ok = false;
    if (!ok) continue;
    shape.ramps = ramps;
    // Every street over the bluff stays within the grade cap along it, wherever the slopes add up (a
    // diagonal crossing a taper climbs its side as well as the ramp).
    const gs: HeightSample = { h: 0, gx: 0, gz: 0 };
    for (const rp of ramps) {
      const e = g.edges[rp.edge];
      const reach = (rp.L / 2 + 2) / Math.max(0.5, rp.dx * vx + rp.dz * vz);
      for (let t = -reach; t <= reach && ok; t += 1) {
        for (const q of [-e.width / 2, 0, e.width / 2]) {
          gs.h = gs.gx = gs.gz = 0;
          terraceAt(shape, rp.x + rp.dx * t - rp.dz * q, rp.z + rp.dz * t + rp.dx * q, gs);
          if (Math.abs(gs.gx * rp.dx + gs.gz * rp.dz) > CFG.rampGrade + 1e-6) ok = false;
        }
      }
    }
    if (!ok) continue;
    // Sags where the El crosses the low and the dip rows with too little room; when they would have
    // to be deeper than sagMax the crossing humps (up to CFG.hump) and the whole level rises with it.
    const sags: BluffSag[] = [];
    const ground = bluffGround(shape, base);
    let short = 0;
    /** Lowest clearance under the deck line across a street's road and sidewalks. */
    const under = (pt: { p: Vec2; edge: number }) => {
      const e = g.edges[pt.edge];
      const hw = e.width / 2 + e.sidewalk;
      const sinX = Math.max(0.5, Math.abs(rdx * -(g.nodes[e.b].z - g.nodes[e.a].z) + rdz * (g.nodes[e.b].x - g.nodes[e.a].x)) / (e.length || 1));
      let m = Infinity;
      for (let q = -hw; q <= hw + 1e-6; q += hw / 4) m = Math.min(m, shape.y - ground(pt.p.x + (rdx * q) / sinX, pt.p.z + (rdz * q) / sinX));
      return m;
    };
    for (const pt of [low, dip]) if (pt.edge >= 0) short = Math.max(short, CFG.clearance - under(pt));
    const hump = Math.min(CFG.hump, Math.max(0, short - CFG.sagMax * 0.9 + 0.05));
    shape.top += hump;
    shape.y += hump;
    for (const pt of [low, dip]) {
      if (pt.edge < 0) continue;
      const e = g.edges[pt.edge];
      const clear = under(pt);
      if (clear >= CFG.clearance) continue;
      const depth = CFG.clearance - clear + 0.05;
      if (depth > CFG.sagMax) {
        ok = false;
        break;
      }
      const w = (1.5 * depth) / CFG.rampGrade;
      // Flat under the whole deck width (the right of way crosses square, or near enough).
      const flat = SUB.deckWidth / 2 + 2;
      const A2 = g.nodes[e.a];
      const B2 = g.nodes[e.b];
      const street = chainOf(g, e.id);
      const t = alongStreet(street, e.id, pt.p);
      if (t < flat + w + CFG.nodeClear || street.length - t < flat + w + CFG.nodeClear) {
        ok = false;
        break;
      }
      sags.push({ x: pt.p.x, z: pt.p.z, dx: (B2.x - A2.x) / e.length, dz: (B2.z - A2.z) / e.length, hw: e.width / 2 + e.sidewalk, depth, flat, w, edge: e.id });
    }
    if (!ok) continue;
    shape.sags = sags;
    // The El's new path: the right of way points replace the low, crest and dip rows' points.
    const moved = new Map<number, Vec2>([
      [rows.low, low.p],
      [r, C],
      [rows.dip, dip.p],
    ]);
    const djA = Math.min(rows.leg0, rows.leg1);
    const djB = Math.max(rows.leg0, rows.leg1);
    const det = elDetourPath(sub, djA, djB, moved);
    const path = det.path;
    // Nothing else crosses the right of way or its S curves (a diagonal, a stray street): the detour's
    // points from leg to leg, with the right of way the stretch between the low and dip rows' points.
    const legs: Vec2[] = det.path.slice(det.at[djA], det.at[djB] + 1);
    const rowK0 = Math.min(det.at[rows.low], det.at[rows.dip]) - det.at[djA];
    const rowK1 = Math.max(det.at[rows.low], det.at[rows.dip]) - det.at[djA];
    const allowed = new Set<number>([...crestChain.edges, ...low.pieces, ...dip.pieces, ...elStreetEdges(g, sub, djA, djB)]);
    for (const n of detourNodes) for (const eid of n.edges) allowed.add(eid);
    for (const e of g.edges) {
      if (allowed.has(e.id) || e.kind === 'channel' || e.kind === 'ramp') continue;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      for (let k = 0; k + 1 < legs.length; k++) {
        if (segmentsIntersect(a, b, legs[k], legs[k + 1])) ok = false;
        // A street running close beside the right of way would have the deck over its sidewalk.
        else if (k >= rowK0 && k < rowK1 && segDist(a, b, legs[k], legs[k + 1]) < e.width / 2 + e.sidewalk + SUB.deckWidth / 2 + 3) ok = false;
      }
      if (!ok) break;
    }
    if (!ok) continue;
    // Clear of the river channel, every part.
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const rim = footprint(shape, 10);
    const probes: Vec2[] = [];
    for (let i = 0; i < rim.length; i++) {
      const p = rim[i];
      const q = rim[(i + 1) % rim.length];
      for (let t = 0; t <= 1; t += 0.05) probes.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t });
    }
    for (let k = rowK0; k < rowK1; k++) for (let t = 0; t <= 1; t += 0.1) probes.push({ x: legs[k].x + (legs[k + 1].x - legs[k].x) * t, z: legs[k].z + (legs[k + 1].z - legs[k].z) * t });
    for (const rv of rivers) {
      const sgn = (p: Vec2) => (p.z - riverCenter(rv.params, p.x) > 0 ? 1 : -1);
      const s0 = sgn(probes[0]);
      for (const p of probes) if (sgn(p) !== s0 || Math.abs(p.z - riverCenter(rv.params, p.x)) < rv.params.top + 20) ok = false;
    }
    // Clear of the lake, which stands level (lake.ts): nothing of the terrace or the right of way near its block.
    for (const lk of ctx.areas) {
      if (lk.kind !== 'lake') continue;
      for (const p of probes) if (pointInPolygon(p.x, p.z, lk.polygon) || distToPolygonEdge(p.x, p.z, lk.polygon) < CITY.districts.lake.clearance) ok = false;
      for (const q of lk.polygon) if (pointInPolygon(q.x, q.z, rim)) ok = false;
    }
    if (!ok) continue;
    // Nodes in the footprint: unclaimed (the El's own column is the subway's).
    const grown = footprint(shape, 25);
    const nodes: number[] = [];
    for (const n of g.nodes) {
      if (!pointInPolygon(n.x, n.z, grown)) continue;
      // A roundabout's ring and island are built level: none on the bluff.
      if (n.ring) ok = false;
      if (!ctx.claims.node.has(n.id)) nodes.push(n.id);
    }
    for (const n of detourNodes) if (n.ring) ok = false;
    if (!ok) continue;
    // The El stays clear over every street it crosses but the crest one (a curve on the planned ground).
    const curve = buildRailCurve(path, side, sub.params.deckHeight, ground, [], { a: low.p, b: dip.p, y: shape.y, blend: CFG.levelBlend });
    const s0 = curve.levelA - curve.blendA - 10;
    const s1 = curve.levelB + curve.blendB + 10;
    // Curves the trains can take: the S curves onto the right of way (sharper the further out it runs,
    // ROW_OFFSET_STEP) keep RAIL.minRadius and turn under 2 degrees per sample (a margin kept for the
    // track's own easing).
    const maxTurn = Math.min(RAIL.step / RAIL.minRadius, (2 * Math.PI) / 180) * 0.95;
    for (let i = Math.max(1, Math.ceil(curve.cityA / RAIL.step) + 1); i * RAIL.step < curve.cityB && ok; i++) {
      const dot = curve.tx[i] * curve.tx[i - 1] + curve.tz[i] * curve.tz[i - 1];
      const cross = curve.tx[i - 1] * curve.tz[i] - curve.tz[i - 1] * curve.tx[i];
      if (Math.abs(Math.atan2(cross, dot)) > maxTurn) ok = false;
    }
    if (!ok) continue;
    for (let i = Math.max(0, Math.floor(s0 / 2)); i < curve.n && i * 2 <= s1 && ok; i++) {
      const x = curve.x[i];
      const z = curve.z[i];
      for (const e of g.edges) {
        if (crestPieces.has(e.id)) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        if (distToSegment(x, z, a.x, a.z, b.x, b.z) > e.width / 2 + e.sidewalk) continue;
        if (curve.deck[i] - ground(x, z) < CFG.clearance - 0.4) ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Blocks it reshapes: those the rock face runs through (where it has any height) and those the
    // El's right of way runs through low or at grade (its S curves are high: plain El). They count
    // against the special area budget but are not claimed (the graph is still being edited:
    // roundabouts, alleys, shortcuts). Every one of them has a claimed street (a ramp, the crest, the
    // El's own), which keeps parks, the monument and back alleys out; the outline keeps route
    // shortcuts off the face and the low track; infill keeps off the exclusions. The gentle slopes
    // beyond stay plain city, like a hill's (the hills keep off the whole footprint).
    let area = 0;
    const faceCuts = (f: { ring: Vec2[] }) => {
      for (let u = s0u; u <= s1u; u += 6) {
        if (envelope(shape, u) < 0.005) continue;
        if (pointInPolygon(M0.x + ux * u, M0.z + uz * u, f.ring)) return true;
      }
      return false;
    };
    const s0u = uA - we;
    const s1u = uB + we;
    for (const f of ctx.faces()) {
      if (f.outer || ctx.claims.face.has(f.id)) continue;
      let mine = faceCuts(f);
      for (let k = rowK0; k < rowK1 && !mine; k++) {
        for (let t = 0.05; t < 1; t += 0.1) {
          if (pointInPolygon(legs[k].x + (legs[k + 1].x - legs[k].x) * t, legs[k].z + (legs[k + 1].z - legs[k].z) * t, f.ring)) mine = true;
        }
      }
      if (!mine) continue;
      area += f.area;
    }
    // Edges it reshapes: the ramps, the dipped streets and the crest street (their width and line must stay).
    const edges = new Set<number>();
    // Every piece of each (a ramp or a dip reaches past its piece's bend nodes).
    for (const rp of ramps) for (const id of chainOf(g, rp.edge).edges) edges.add(id);
    for (const sg of sags) for (const id of chainOf(g, sg.edge).edges) edges.add(id);
    for (const id of crestChain.edges) edges.add(id);
    // Streets another district claimed first (the El's own, a bridge) stay theirs.
    const free = [...edges].filter((id) => !ctx.claims.edge.has(id)).sort((p, q) => p - q);
    return { rowOffset, shape, moved, rowA: low.p, rowB: dip.p, crestEdge, rows, nodes, edges: free, poly: outline(shape), area };
  }
  return null;
}

/** Register the bluff and move the El onto its right of way. */
function commit(ctx: PlanContext, sub: Area, pl: Placement, r: number, o: number): void {
  const s = pl.shape;
  const params: Record<string, number> = {
    ox: s.ox,
    oz: s.oz,
    ux: s.ux,
    uz: s.uz,
    vx: s.vx,
    vz: s.vz,
    uA: s.uA,
    uB: s.uB,
    we: s.we,
    H: s.H,
    fw: s.fw,
    vp: s.vp,
    wd: s.wd,
    L: s.L,
    lip: s.lip,
    cx: s.cx,
    cz: s.cz,
    top: s.top,
    y: s.y,
    crestEdge: pl.crestEdge,
    rowOffset: pl.rowOffset,
    rowAx: pl.rowA.x,
    rowAz: pl.rowA.z,
    rowBx: pl.rowB.x,
    rowBz: pl.rowB.z,
    subway: sub.id,
    crest: r,
    dir: o,
    ramps: s.ramps.length,
    sags: s.sags.length,
  };
  s.ramps.forEach((rp, k) => {
    params[`r${k}x`] = rp.x;
    params[`r${k}z`] = rp.z;
    params[`r${k}dx`] = rp.dx;
    params[`r${k}dz`] = rp.dz;
    params[`r${k}hw`] = rp.hw;
    params[`r${k}L`] = rp.L;
    params[`r${k}e`] = rp.edge;
  });
  s.sags.forEach((sg, k) => {
    params[`s${k}x`] = sg.x;
    params[`s${k}z`] = sg.z;
    params[`s${k}dx`] = sg.dx;
    params[`s${k}dz`] = sg.dz;
    params[`s${k}hw`] = sg.hw;
    params[`s${k}d`] = sg.depth;
    params[`s${k}w`] = sg.w;
    params[`s${k}f`] = sg.flat;
    params[`s${k}e`] = sg.edge;
  });
  // The face line across the bluff's width, for the minimap and the area's tag.
  const at = (u: number): Vec2 => ({ x: s.ox + s.ux * u, z: s.oz + s.uz * u });
  const area = ctx.addArea({ kind: 'bluff', variant: 'scarp', polygon: pl.poly, path: [at(s.uA - s.we * 0.6), at(s.uB + s.we * 0.6)], nodes: pl.nodes, edges: pl.edges, faces: [], params }, pl.area);
  // The El: its path through the right of way, the deck outline after it, where the detour runs (dj0..dj1)
  // and its street along it no longer under the deck (subway.ts applyElDetour).
  applyElDetour(sub, ctx.graph, Math.min(pl.rows.leg0, pl.rows.leg1), Math.max(pl.rows.leg0, pl.rows.leg1), pl.moved);
  // The crest street knows where its level crossing is (routes keep their grids and finish off it).
  const ce = ctx.graph.edges[pl.crestEdge];
  const ca = ctx.graph.nodes[ce.a];
  ce.crossing = sqrt((s.cx - ca.x) ** 2 + (s.cz - ca.z) ** 2);
  sub.params.bluff = area.id;
}

function cross(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

/** Proper intersection of segments p-q and r-s (touching ends do not count). */
function segmentsIntersect(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
  const d1 = cross(q.x - p.x, q.z - p.z, r.x - p.x, r.z - p.z);
  const d2 = cross(q.x - p.x, q.z - p.z, s.x - p.x, s.z - p.z);
  const d3 = cross(s.x - r.x, s.z - r.z, p.x - r.x, p.z - r.z);
  const d4 = cross(s.x - r.x, s.z - r.z, q.x - r.x, q.z - r.z);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Distance between two segments (0 when they cross). */
function segDist(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(distToSegment(a.x, a.z, c.x, c.z, d.x, d.z), distToSegment(b.x, b.z, c.x, c.z, d.x, d.z), distToSegment(c.x, c.z, a.x, a.z, b.x, b.z), distToSegment(d.x, d.z, a.x, a.z, b.x, b.z));
}

function segmentCrossesPolygon(a: Vec2, b: Vec2, poly: Vec2[]): boolean {
  for (let i = 0; i < poly.length; i++) if (segmentsIntersect(a, b, poly[i], poly[(i + 1) % poly.length])) return true;
  return false;
}

/** The bluff area that reshapes this subway area, if any. */
export function bluffOf(areas: readonly Area[], sub: Area): Area | null {
  const id = sub.params.bluff;
  return id === undefined ? null : (areas[id] ?? null);
}

/** Corridor half width of an edge (curb to the outer sidewalk line). */
export function corridorHalf(e: RoadEdge): number {
  return e.width / 2 + e.sidewalk;
}

