/**
 * Park variants beyond the woods (park.ts): the formal garden and the lakeside pond, as pure
 * helpers park.ts calls while planning (which variant a park is, and where its pond lies) and
 * building (what each variant adds).
 *
 * Variants are drawn per park from the park's own seed, weighted by CFG.variants and divided by
 * CFG.variantRepeat for every park of the city that already has the variant, so a city usually
 * mixes two. A park that cannot hold its variant (too narrow for a garden, no level spot for a
 * pond, a race pass through the fountain's plaza) is a woodland park.
 *
 * Formal garden (`formalGarden`): gravel axes on a cross (square to the block's longest side) or on
 * its diagonals meet at a plaza with a fountain basin (look 'fountain', a solid ring); the footpath
 * loop (park.ts) closes them at the park's edge. A low hedge of bushes (destructible, a car ploughs
 * through) flanks each axis. In each quadrant a parterre lies off the axes: a flower bed with a
 * ring of planter pots, closed on its two outer sides by tall hedges (solids, look 'hedge', each
 * side split by a door so a car has a way through). A parterre a race pass would touch is left as
 * lawn, and the garden's pieces keep off the passes (the caller's `onPath`). Lanterns stand at the
 * axes' ends and round the plaza.
 *
 * Lakeside pond (`pickPond`, `pondHeightMod`): an ellipse levelled into the terrain by one height
 * modifier with exact gradient. Out from its middle (rho, metres of the major axis): a flat bed, a
 * bowl rising over CFG.bowl to the bank's crest (level, `level` m high), then a blend back into the
 * terrain over CFG.blend, where the park's hills fade in. The water is a 'water' surface patch
 * (drivable, offroad grip, water drag: the sim has no deeper water) standing CFG.freeboard under
 * the crest, flat whatever the relief; the bowl is shallow and gentle (about 6% at the steepest) so
 * nothing about it launches a car (README, the terrain launch rule). A jetty (solid, look
 * 'jetty') reaches into the water, with a lantern on the bank, benches facing the water and a
 * gravel ring path round the bank; the renderer adds the water, reeds and the shimmer.
 */
import { CITY } from '../config';
import { createTerrain } from '../terrain';
import { type Vec2, atan2, cos, sin, sqrt } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import type { PropKind } from '../props';
import type { AreaBuild, HeightMod, HeightSample } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polygonBounds, polygonCentroid, smooth01, type Smooth, solidWalls } from './geom';

const CFG = CITY.districts.park;
const FORMAL = CFG.formal;
const POND = CFG.lakeside;

export type ParkVariant = 'woodland' | 'formal' | 'lakeside';

/** Scratch for the pond's smoothsteps and the hill under it (the terrain is queried per wheel per substep, so nothing allocates). */
const S_BED: Smooth = { v: 0, d: 0 };
const S_BLEND: Smooth = { v: 0, d: 0 };
const S_HILL: Smooth = { v: 0, d: 0 };
const HILL: HeightSample = { h: 0, gx: 0, gz: 0 };

/** The variant of a park from its own stream, given the variants the city's earlier parks have. */
export function pickVariant(rng: Rng, taken: readonly string[]): ParkVariant {
  const names = Object.keys(CFG.variants) as ParkVariant[];
  const w = names.map((n) => CFG.variants[n] / CFG.variantRepeat ** taken.filter((t) => t === n).length);
  let r = rng.next() * w.reduce((s, x) => s + x, 0);
  for (let i = 0; i < names.length; i++) {
    r -= w[i];
    if (r < 0) return names[i];
  }
  return names[0];
}

// ---------------------------------------------------------------------------------------------
// Formal garden

/** Direction (rad, from +x toward +z) of the ring's longest side: the garden's axes follow it, or its diagonals. */
export function longestSideAngle(ring: readonly Vec2[]): number {
  let best = -1;
  let ang = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const l = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
    if (l > best) {
      best = l;
      ang = atan2(q.z - p.z, q.x - p.x);
    }
  }
  return ang;
}

/** Can the ring hold a garden: its middle well inside it, and no race pass through the plaza. */
export function formalFits(ring: Vec2[], passPoints: readonly (readonly Vec2[])[]): boolean {
  const c = polygonCentroid(ring);
  if (distToPolygonEdge(c.x, c.z, ring) < FORMAL.formalInradius || !pointInPolygon(c.x, c.z, ring)) return false;
  const clear = FORMAL.plazaRadius + CFG.pathWidth / 2 + CFG.passVerge + 3;
  return passPoints.every((pts) => pts.every((q, i) => i + 1 >= pts.length || distSeg(c, q, pts[i + 1]) > clear));
}

function distSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
  return sqrt((p.x - a.x - dx * t) ** 2 + (p.z - a.z - dz * t) ** 2);
}

/** What the garden's builders need of the park's build. */
export interface GardenEnv {
  b: AreaBuild;
  id: number;
  ring: Vec2[];
  /** Is a circle of radius r on a race pass's path (park.ts onPath)? */
  onPath(x: number, z: number, r: number): boolean;
  clutter(kind: PropKind, x: number, z: number, yaw: number): void;
}

/** An oriented rectangle: centre, unit axis u (w is square to it), half extents along u and w. */
interface Box {
  x: number;
  z: number;
  ux: number;
  uz: number;
  hu: number;
  hw: number;
}

/** Does a circle at (x, z) of radius r touch the box? */
function touches(bx: Box, x: number, z: number, r: number): boolean {
  const dx = x - bx.x;
  const dz = z - bx.z;
  const u = dx * bx.ux + dz * bx.uz;
  const w = -dx * bx.uz + dz * bx.ux;
  const qu = Math.max(0, Math.abs(u) - bx.hu);
  const qw = Math.max(0, Math.abs(w) - bx.hw);
  return qu * qu + qw * qw < r * r;
}

/**
 * The garden: walls, props and renderer hints into `env.b`. Returns the garden's keep-out (a circle
 * at (x, z) of radius r touches an axis, the plaza or a parterre) for the trees, bushes and the
 * footpath's furniture.
 */
export function formalGarden(env: GardenEnv, plan: number, ang: number, rnd: () => number): (x: number, z: number, r: number) => boolean {
  const { b, id, ring } = env;
  const c = polygonCentroid(ring);
  const a0 = ang + (plan ? Math.PI / 4 : 0);
  const A1 = { x: cos(a0), z: sin(a0) };
  const A2 = { x: -A1.z, z: A1.x };
  const R = FORMAL.plazaRadius;
  const half = FORMAL.axisWidth / 2;
  const boxes: Box[] = [];
  const at = (u: number, v: number): Vec2 => ({ x: c.x + A1.x * u + A2.x * v, z: c.z + A1.z * u + A2.z * v });
  const onLawn = (p: Vec2, edge: number) => pointInPolygon(p.x, p.z, ring) && distToPolygonEdge(p.x, p.z, ring) >= edge;

  // The plaza: a gravel disc with the fountain's basin, a lantern on each diagonal.
  b.hints.push({ kind: 'plaza', points: [{ x: c.x, z: c.z }], values: [R] });
  b.walls.push(...solidWalls(circlePolygon(c.x, c.z, FORMAL.basinRadius, 16), 'fountain', id));
  b.hints.push({ kind: 'basin', points: [{ x: c.x, z: c.z }], values: [FORMAL.basinRadius, FORMAL.basinHeight] });
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const p = at((su * (R + 1.1)) / Math.SQRT2, (sv * (R + 1.1)) / Math.SQRT2);
    env.clutter('parkLamp', p.x, p.z, atan2(c.x - p.x, c.z - p.z));
  }

  // The four axes, each out to the footpath loop, with a low hedge down both sides.
  for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const d = { x: A1.x * du + A2.x * dv, z: A1.z * du + A2.z * dv };
    let end = R;
    while (end < 400 && onLawn({ x: c.x + d.x * (end + 1), z: c.z + d.z * (end + 1) }, CFG.pathInset)) end++;
    if (end < R + 8) continue;
    b.hints.push({ kind: 'walk', points: [{ x: c.x + d.x * (R - 1), z: c.z + d.z * (R - 1) }, { x: c.x + d.x * end, z: c.z + d.z * end }], values: [FORMAL.axisWidth] });
    boxes.push({ x: c.x + (d.x * (end + R)) / 2, z: c.z + (d.z * (end + R)) / 2, ux: d.x, uz: d.z, hu: (end - R) / 2, hw: half + FORMAL.hedgeOff + 1 });
    const off = half + FORMAL.hedgeOff;
    for (const sg of [-1, 1]) {
      const nx = -d.z * sg;
      const nz = d.x * sg;
      for (let t = R + 3; t < end - 5; t += FORMAL.hedgeStep) {
        const x = c.x + d.x * t + nx * off;
        const z = c.z + d.z * t + nz * off;
        if (!onLawn({ x, z }, 3) || env.onPath(x, z, 0.75)) continue;
        env.clutter('bush', x, z, rnd() * 6.28);
      }
      // A lantern where the axis meets the loop, beside the path.
      const lx = c.x + d.x * (end - 1.5) + nx * (half + 0.9);
      const lz = c.z + d.z * (end - 1.5) + nz * (half + 0.9);
      if (onLawn({ x: lx, z: lz }, 2) && !env.onPath(lx, lz, 0.4)) env.clutter('parkLamp', lx, lz, atan2(-nx, -nz));
    }
  }

  // The parterres: one per quadrant, the largest square that fits inside the park edge.
  const g = half + FORMAL.hedgeOff + FORMAL.hedgeGap;
  for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    let L = FORMAL.bedMax;
    const fits = (l: number) => [[g, g], [g + l, g], [g, g + l], [g + l, g + l], [g + l / 2, g + l]].every(([u, v]) => onLawn(at(su * u, sv * v), FORMAL.bedEdge));
    while (L >= FORMAL.bedMin && !fits(L)) L -= 1;
    if (L < FORMAL.bedMin) continue;
    // A pass near the bed leaves it as lawn.
    let hit = false;
    for (let u = g - 2; u <= g + L + FORMAL.bedPassClear && !hit; u += 3) {
      for (let v = g - 2; v <= g + L + FORMAL.bedPassClear && !hit; v += 3) {
        const p = at(su * u, sv * v);
        hit = env.onPath(p.x, p.z, FORMAL.bedPassClear);
      }
    }
    if (hit) continue;
    const mid = at(su * (g + L / 2), sv * (g + L / 2));
    boxes.push({ x: mid.x, z: mid.z, ux: A1.x, uz: A1.z, hu: L / 2 + FORMAL.hedgeThick, hw: L / 2 + FORMAL.hedgeThick });
    b.hints.push({ kind: 'bed', points: [at(su * g, sv * g), at(su * (g + L), sv * g), at(su * (g + L), sv * (g + L)), at(su * g, sv * (g + L))], values: [Math.floor(rnd() * 4)] });
    // A ring of planter pots round a middle one.
    env.clutter('planterPot', mid.x, mid.z, 0);
    const pots = 6;
    for (let k = 0; k < pots; k++) {
      const a = (k / pots) * Math.PI * 2 + rnd();
      env.clutter('planterPot', mid.x + cos(a) * FORMAL.potRing, mid.z + sin(a) * FORMAL.potRing, a);
    }
    // The outer sides: tall hedge in two pieces each with a door between them. The side along v (at
    // u = g + L) runs the bed's full depth, the one along u stops a hedge's thickness short of it.
    const t = FORMAL.hedgeThick;
    const door = FORMAL.hedgeDoor;
    const sides: { u0: number; u1: number; v0: number; v1: number; along: 'u' | 'v' }[] = [
      { u0: g + L - t / 2, u1: g + L + t / 2, v0: g, v1: g + L + t / 2, along: 'v' },
      { u0: g, u1: g + L - t / 2, v0: g + L - t / 2, v1: g + L + t / 2, along: 'u' },
    ];
    for (const s of sides) {
      const [lo, hi] = s.along === 'v' ? [s.v0, s.v1] : [s.u0, s.u1];
      const m = (lo + hi) / 2;
      const pieces = [[lo, m - door / 2], [m + door / 2, hi]];
      for (const [p0, p1] of pieces) {
        const rect = s.along === 'v' ? [[s.u0, p0], [s.u1, p0], [s.u1, p1], [s.u0, p1]] : [[p0, s.v0], [p1, s.v0], [p1, s.v1], [p0, s.v1]];
        const poly = rect.map(([u, v]) => at(su * u, sv * v));
        b.walls.push(...solidWalls(poly, 'hedge', id));
        b.hints.push({ kind: 'hedge', points: poly, values: [FORMAL.hedgeHeight] });
      }
    }
  }
  return (x, z, r) => (x - c.x) ** 2 + (z - c.z) ** 2 < (R + r) ** 2 || boxes.some((bx) => touches(bx, x, z, r));
}

// ---------------------------------------------------------------------------------------------
// Lakeside pond

/** A pond's place: centre, semi-axes (m), turn of its major axis (rad), crest level (m, absolute). */
export interface Pond {
  cx: number;
  cz: number;
  a: number;
  b: number;
  phi: number;
  level: number;
  /** rho of the bed's flat (bed), the bank's crest (crest) and the end of the blend (end); the water's height (water, absolute). */
  bed: number;
  crest: number;
  end: number;
  water: number;
}

/** Where on the bowl's smoothstep the waterline lies (0..1): the depth at the waterline is `freeboard`. */
function waterT(): number {
  const want = 1 - POND.freeboard / POND.depth;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    if (t * t * (3 - 2 * t) < want) lo = t;
    else hi = t;
  }
  return (lo + hi) / 2;
}

/** The pond with its profile worked out from where its waterline is. */
export function makePond(cx: number, cz: number, a: number, b: number, phi: number, level: number): Pond {
  const bed = a - waterT() * POND.bowl;
  const crest = bed + POND.bowl;
  return { cx, cz, a, b, phi, level, bed, crest, end: crest + POND.blend, water: level - POND.freeboard };
}

/** The pond a park's params hold (plan wrote them), or null for other variants. */
export function pondOf(p: Readonly<Record<string, number>>): Pond | null {
  return p.pa ? makePond(p.pcx, p.pcz, p.pa, p.pb, p.pphi, p.pL) : null;
}

/** Distance from the pond's middle in the major axis' metres (an ellipse is a level set of it). */
export function pondRho(p: Pond, x: number, z: number): number {
  const dx = x - p.cx;
  const dz = z - p.cz;
  const u = dx * cos(p.phi) + dz * sin(p.phi);
  const v = -dx * sin(p.phi) + dz * cos(p.phi);
  const k = p.a / p.b;
  return sqrt(u * u + k * k * v * v);
}

/** The point at angle `th` round the pond's ellipse of rho `rho`. */
export function pondPoint(p: Pond, rho: number, th: number): Vec2 {
  const u = rho * cos(th);
  const v = (rho * sin(th)) / (p.a / p.b);
  return { x: p.cx + u * cos(p.phi) - v * sin(p.phi), z: p.cz + u * sin(p.phi) + v * cos(p.phi) };
}

/** The ellipse of rho `rho` as a polygon of n points. */
export function pondRing(p: Pond, rho: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) out.push(pondPoint(p, rho, (i / n) * Math.PI * 2));
  return out;
}

/**
 * The pond for a park, or null: the shape from `rng`, then the flattest spot on a grid inside the
 * ring, margin short of its edge and the race passes (the blend must stay inside the park), by the
 * spread of the base terrain over the pond's ring and blend; the crest level is its middle. `clear` says
 * whether the terrain at a point is the base alone (no other district's slope on it): the pond levels the
 * base, so every sample over the pond and its blend must be clear.
 */
export function pickPond(seed: number, ring: Vec2[], passPoints: readonly (readonly Vec2[])[], rng: Rng, clear: (x: number, z: number) => boolean = () => true): Pond | null {
  const a = rng.range(POND.radius[0], POND.radius[1]);
  const b = a * rng.range(POND.aspect[0], POND.aspect[1]);
  const phi = rng.range(0, Math.PI);
  const shape = makePond(0, 0, a, b, phi, 0);
  const base = createTerrain(seed);
  const bb = polygonBounds(ring);
  const mid = polygonCentroid(ring);
  const edge = shape.end + POND.margin;
  const passClear = shape.crest + POND.margin + CFG.pathWidth / 2 + CFG.passVerge;
  let best: Pond | null = null;
  let bestScore = Infinity;
  for (let x = bb.minX; x <= bb.maxX; x += POND.siteStep) {
    for (let z = bb.minZ; z <= bb.maxZ; z += POND.siteStep) {
      if (!pointInPolygon(x, z, ring) || distToPolygonEdge(x, z, ring) < edge) continue;
      if (passPoints.some((pts) => pts.some((q, i) => i + 1 < pts.length && distSeg({ x, z }, q, pts[i + 1]) < passClear))) continue;
      const spot = makePond(x, z, a, b, phi, 0);
      let lo = base.heightAt(x, z);
      let hi = lo;
      for (const rho of [shape.crest, shape.end]) {
        for (let k = 0; k < 12; k++) {
          const p = pondPoint(spot, rho, (k / 12) * Math.PI * 2);
          const h = base.heightAt(p.x, p.z);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
      }
      if ((hi - lo) / 2 > POND.maxRange) continue;
      if (!clear(x, z) || [shape.a, shape.crest, (shape.crest + shape.end) / 2, shape.end].some((rho) => Array.from({ length: 12 }, (_, k) => pondPoint(spot, rho, (k / 12) * Math.PI * 2)).some((q) => !clear(q.x, q.z)))) continue;
      const score = hi - lo + 0.002 * sqrt((x - mid.x) ** 2 + (z - mid.z) ** 2);
      if (score < bestScore) {
        bestScore = score;
        best = makePond(x, z, a, b, phi, (hi + lo) / 2);
      }
    }
  }
  return best;
}

/**
 * The pond's terrain: with H the park's hill (scaled and faded in past the blend), B the base terrain, w
 * the blend (0 inside the crest, 1 at the end) and Lb the bed (the level under the crest, a smoothstep bowl
 * inside it), the park's terrain is H + (1 - w) (Lb - B) on top of B, exact in its gradient. `hill` adds the
 * park's hill into the sample it is given (zero outside the park).
 */
export function pondHeightMod(seed: number, pond: Pond, ring: Vec2[], hill: (x: number, z: number, out: HeightSample) => void): HeightMod {
  const base = createTerrain(seed);
  const cph = cos(pond.phi);
  const sph = sin(pond.phi);
  const k2 = (pond.a / pond.b) ** 2;
  const D = POND.depth;
  const scale = POND.hillScale;
  return {
    ...polygonBounds(ring),
    add(x, z, out) {
      HILL.h = 0;
      HILL.gx = 0;
      HILL.gz = 0;
      hill(x, z, HILL);
      const dx = x - pond.cx;
      const dz = z - pond.cz;
      const u = dx * cph + dz * sph;
      const v = -dx * sph + dz * cph;
      const rho = sqrt(u * u + k2 * v * v);
      const f = smooth01(pond.end, pond.end + POND.hillFade, rho, S_HILL);
      const hs = HILL.h * scale;
      out.h += hs * f.v;
      out.gx += scale * f.v * HILL.gx;
      out.gz += scale * f.v * HILL.gz;
      if (rho < 1e-6) {
        // The middle: the bed is flat there, nothing of the gradient of rho to add.
        out.h += pond.level - D - base.heightAt(x, z);
        const s0 = base.slopeAt(x, z);
        out.gx -= s0.gx;
        out.gz -= s0.gz;
        return;
      }
      const rx = (u * cph - k2 * v * sph) / rho;
      const rz = (u * sph + k2 * v * cph) / rho;
      out.gx += hs * f.d * rx;
      out.gz += hs * f.d * rz;
      if (rho >= pond.end) return;
      const bed = smooth01(pond.bed, pond.crest, rho, S_BED);
      const w = smooth01(pond.crest, pond.end, rho, S_BLEND);
      const Lb = pond.level - D + D * bed.v;
      const B = base.heightAt(x, z);
      const gB = base.slopeAt(x, z);
      const diff = Lb - B;
      out.h += (1 - w.v) * diff;
      out.gx += (1 - w.v) * (D * bed.d * rx - gB.gx) - w.d * rx * diff;
      out.gz += (1 - w.v) * (D * bed.d * rz - gB.gz) - w.d * rz * diff;
    },
  };
}

/** What the pond's builders need of the park's build. */
export interface PondEnv extends GardenEnv {
  pond: Pond;
  /** The pond's jetty is aimed at this angle round it (rad). */
  jetty: number;
}

/**
 * The pond's water, jetty and bank: the water surface patch, the jetty's solid, a lantern on the bank,
 * benches facing the water and a gravel ring round it. Returns the pond's keep-out for trees and
 * clutter (the water, its bank and the jetty).
 */
export function pondFeatures(env: PondEnv, rnd: () => number): (x: number, z: number, r: number) => boolean {
  const { b, id, pond } = env;
  const water = pondRing(pond, pond.a, 32);
  b.surfaces.push({ surface: 'water', polygon: water, priority: 3, area: id });
  b.hints.push({ kind: 'pond', points: water, values: [pond.water, pond.cx, pond.cz, pond.a, pond.b, pond.phi, env.jetty] });

  // The jetty: a solid deck out from the bank along the ray from the middle.
  const th = env.jetty;
  const shore = pondPoint(pond, pond.a, th);
  const dl = sqrt((shore.x - pond.cx) ** 2 + (shore.z - pond.cz) ** 2) || 1;
  const ex = (shore.x - pond.cx) / dl;
  const ez = (shore.z - pond.cz) / dl;
  const root = { x: shore.x + ex * 3, z: shore.z + ez * 3 };
  const tip = { x: shore.x - ex * POND.jettyReach, z: shore.z - ez * POND.jettyReach };
  const hw = POND.jettyWidth / 2;
  const deck = [
    { x: root.x - ez * hw, z: root.z + ex * hw },
    { x: tip.x - ez * hw, z: tip.z + ex * hw },
    { x: tip.x + ez * hw, z: tip.z - ex * hw },
    { x: root.x + ez * hw, z: root.z - ex * hw },
  ];
  b.walls.push(...solidWalls(deck, 'jetty', id));
  b.hints.push({ kind: 'jetty', points: deck, values: [pond.water + POND.deckRise] });
  // The lantern on the bank beside the root, facing the water.
  const lamp = { x: root.x - ez * (hw + 1.4) + ex * 1, z: root.z + ex * (hw + 1.4) + ez * 1 };
  env.clutter('parkLamp', lamp.x, lamp.z, atan2(-ex, -ez));

  // Benches on the bank facing the water, clear of the jetty; the gravel ring behind them.
  const ringRho = pond.crest + POND.ring;
  b.hints.push({ kind: 'path', points: pondRing(pond, ringRho, 36), values: [] });
  const benchRho = pond.crest + 2.2;
  for (let i = 0; i < POND.benches; i++) {
    const a = th + Math.PI * 2 * ((i + 0.5 + 0.3 * (rnd() - 0.5)) / POND.benches);
    const p = pondPoint(pond, benchRho, a);
    env.clutter('bench', p.x, p.z, atan2(pond.cx - p.x, pond.cz - p.z));
    if (rnd() < 0.5) {
      const q = pondPoint(pond, benchRho, a + 0.13);
      env.clutter('garbageCan', q.x, q.z, 0);
    }
  }
  return (x, z, r) => pondRho(pond, x, z) < pond.crest + POND.ring + 1.5 + r || distSeg({ x, z }, root, tip) < hw + 1.5 + r;
}
