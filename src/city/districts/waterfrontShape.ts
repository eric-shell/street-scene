/**
 * The harbor's shape as the waterfront area's params store it (waterfront.ts plans it), read by its build,
 * its renderer (render/districts/waterfront.ts) and the maps: the side's frame (u along the coast, v out to
 * sea, both in m), the coast line (the sea wall's edge as v of u: samples c0..c{cn-1} every cdx m from cx0,
 * read through the channel's centerline interpolation, channel/centerline.ts, since it is the same uniform
 * Catmull-Rom), the water level (tilted gently along the coast, w0 + wt * u, over the stretch it was fitted
 * to, level beyond), the ground lowered
 * past the sea wall under it (harborLowering: a height modifier with an exact gradient) and the open
 * water's outline for the maps and the 'water' surface (harborWater).
 *
 * Params: side (0 north +Z, 1 south, 2 west +X, 3 east), ux uz vx vz (the frame), cx0 cdx cn c0.. (the
 * coast), pa pb (the quay's ends along u), openA openB (1 where the water runs on past the city's corner, 0
 * where a breakwater closes it), eA0 eA1 eB0 eB1 (u where the lowering fades in and out), vf0 vf1 (v where it
 * fades out far from the coast), w0 wt wu0 wu1 (water level), depth (water depth past the wall), fall (the wall
 * face's width), nBack (the quay outline's back chain length: Area.polygon is that chain, then the coast back),
 * seed (the dressing's stream).
 */
import { CITY } from '../config';
import type { Terrain } from '../terrain';
import { type Vec2, sqrt } from '../../sim/math';
import type { Area, HeightMod, HeightSample } from './types';
import { smooth01, type Smooth } from './geom';
import { channelCenter, channelSlope } from './channel/centerline';

/** A side's frame: unit U along the coast and V out to sea (U = (Vz, -Vx), so V is always U's left). */
export interface HarborFrame {
  ux: number;
  uz: number;
  vx: number;
  vz: number;
}

/** The four sides by params.side: north (+Z), south, west (+X: world +X is west on the maps) and east. */
export const HARBOR_SIDES: readonly HarborFrame[] = [
  { vx: 0, vz: 1 },
  { vx: 0, vz: -1 },
  { vx: 1, vz: 0 },
  { vx: -1, vz: 0 },
].map((s) => ({ ux: s.vz, uz: -s.vx, vx: s.vx, vz: s.vz }));

export const frameU = (f: HarborFrame, x: number, z: number): number => x * f.ux + z * f.uz;
export const frameV = (f: HarborFrame, x: number, z: number): number => x * f.vx + z * f.vz;
/** The world point at (u, v) of a frame. */
export const framePoint = (f: HarborFrame, u: number, v: number): Vec2 => ({ x: u * f.ux + v * f.vx, z: u * f.uz + v * f.vz });

/** An area's frame (its params carry it). */
export function harborFrame(a: Area): HarborFrame {
  const p = a.params;
  return { ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz };
}

/** The sea wall's edge (v, m) at u: the coast line, flat beyond its samples. */
export function coastV(p: Record<string, number>, u: number): number {
  return channelCenter(p, u);
}

/** dv/du of the coast line at u. */
export function coastSlope(p: Record<string, number>, u: number): number {
  return channelSlope(p, u);
}

/** The unit normal out to sea at u, square to the coast line (the frame's v turned by the coast's slope). */
export function coastNormal(p: Record<string, number>, u: number): { nx: number; nz: number } {
  const s = coastSlope(p, u);
  const l = sqrt(1 + s * s);
  return { nx: (p.vx - s * p.ux) / l, nz: (p.vz - s * p.uz) / l };
}

/** The world point `dv` m out to sea from the coast line at u (negative: in on the quay). */
export function coastPoint(a: Area, u: number, dv = 0): Vec2 {
  return framePoint(harborFrame(a), u, coastV(a.params, u) + dv);
}

/**
 * The water's surface height (m) at u along the coast: tilted along u by at most CITY.districts.waterfront.maxTilt
 * over the furnished stretch it was fitted to (wu0..wu1), level beyond it, so the far water never climbs.
 */
export function waterLevel(p: Record<string, number>, u: number): number {
  return p.w0 + p.wt * (u < p.wu0 ? p.wu0 : u > p.wu1 ? p.wu1 : u);
}

/** The water's lateral extent (u) at full depth: from the breakwater's far edge (a closed end) or where the run on fades (an open one). */
export function waterSpan(p: Record<string, number>): [number, number] {
  return [p.eA1, p.eB0];
}

/** Scratch for the lowering's smoothsteps: the terrain asks per wheel per substep, so nothing allocates. */
const S_WALL: Smooth = { v: 0, d: 0 };
const S_A: Smooth = { v: 0, d: 0 };
const S_B: Smooth = { v: 0, d: 0 };
const S_FAR: Smooth = { v: 0, d: 0 };

/**
 * The ground past the sea wall, lowered to the seabed: within the wall's face (fall m past the coast line)
 * it drops from the quay to `depth` m below the water, fading in at each end of the harbor along u and
 * out again far from the coast, so the modifier is 0 at its box's edges. Exact gradient (the base terrain's
 * own, the coast's slope and every fade). The base terrain is the landscape (terrain.ts) without the
 * districts: nothing else is planned on the water side of the frontage (the planner keeps clear of it).
 */
export function harborLowering(p: Record<string, number>, base: Terrain): HeightMod {
  const f: HarborFrame = { ux: p.ux, uz: p.uz, vx: p.vx, vz: p.vz };
  // The box: every u the lowering reaches, from the lowest the coast gets to the far fade.
  let vLo = Infinity;
  for (let u = p.eA0; u <= p.eB1 + p.cdx; u += p.cdx) vLo = Math.min(vLo, coastV(p, Math.min(u, p.eB1)));
  const corners = [framePoint(f, p.eA0, vLo - 1), framePoint(f, p.eB1, vLo - 1), framePoint(f, p.eA0, p.vf1), framePoint(f, p.eB1, p.vf1)];
  const box = {
    minX: Math.min(...corners.map((c) => c.x)) - 1,
    minZ: Math.min(...corners.map((c) => c.z)) - 1,
    maxX: Math.max(...corners.map((c) => c.x)) + 1,
    maxZ: Math.max(...corners.map((c) => c.z)) + 1,
  };
  return {
    ...box,
    add(x: number, z: number, out: HeightSample): void {
      const u = x * f.ux + z * f.uz;
      if (u <= p.eA0 || u >= p.eB1) return;
      const v = x * f.vx + z * f.vz;
      if (v >= p.vf1) return;
      const c = coastV(p, u);
      const vp = v - c;
      if (vp <= 0) return;
      smooth01(0, p.fall, vp, S_WALL);
      smooth01(p.eA0, p.eA1, u, S_A);
      smooth01(p.eB0, p.eB1, u, S_B);
      smooth01(p.vf0, p.vf1, v, S_FAR);
      const e = S_A.v * (1 - S_B.v);
      const de = S_A.d * (1 - S_B.v) - S_A.v * S_B.d;
      const o = 1 - S_FAR.v;
      const dO = -S_FAR.d;
      const L = S_WALL.v * e * o;
      if (L <= 0) return;
      const cs = coastSlope(p, u);
      // dL/dx, dL/dz: the wall's step across v' = v - coast(u), the fades along u and out along v.
      const dvp = S_WALL.d * e * o;
      const du = S_WALL.v * de * o;
      const dv = S_WALL.v * e * dO;
      const lx = dvp * (f.vx - cs * f.ux) + du * f.ux + dv * f.vx;
      const lz = dvp * (f.vz - cs * f.uz) + du * f.uz + dv * f.vz;
      const h0 = base.heightAt(x, z);
      const g0 = base.slopeAt(x, z);
      // The seabed: depth below the water, which tilts along u over its fitted stretch.
      const F = waterLevel(p, u) - p.depth;
      const dF = u > p.wu0 && u < p.wu1 ? p.wt : 0;
      const diff = F - h0;
      out.h += L * diff;
      out.gx += lx * diff + L * (dF * f.ux - g0.gx);
      out.gz += lz * diff + L * (dF * f.uz - g0.gz);
    },
  };
}

/**
 * The open water as a polygon: from the coast line between the water's lateral ends out `reach` m past
 * the coast's furthest point, sampled every `step` m along u. The sim's 'water' surface (a short reach) and
 * the maps' fill (one far past the map's edge) are both this.
 */
export function harborWater(a: Area, reach: number, step = 8, ends: [number, number] = waterSpan(a.params)): Vec2[] {
  const p = a.params;
  const f = harborFrame(a);
  const [u0, u1] = ends;
  const n = Math.max(1, Math.ceil((u1 - u0) / step));
  const coast: Vec2[] = [];
  let vMax = -Infinity;
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const v = coastV(p, u);
    vMax = Math.max(vMax, v);
    coast.push(framePoint(f, u, v));
  }
  return [...coast, framePoint(f, u1, vMax + reach), framePoint(f, u0, vMax + reach)];
}

/**
 * The harbor's water surface under (x, z) (m): past the sea wall, between the breakwaters (or on past an
 * open end), else -Infinity. For cameras that must stay out of the water (the drone); a city without a
 * harbor has none.
 */
export function harborSurfaceAt(areas: readonly Area[], x: number, z: number): number {
  for (const a of areas) {
    if (a.kind !== 'waterfront') continue;
    const p = a.params;
    const u = x * p.ux + z * p.uz;
    if ((!p.openA && u < p.pa - CITY.districts.waterfront.mole / 2) || (!p.openB && u > p.pb + CITY.districts.waterfront.mole / 2)) continue;
    if (x * p.vx + z * p.vz > coastV(p, u)) return waterLevel(p, u);
  }
  return -Infinity;
}

/** The quay's lanterns, jetties and the rest of the dressing are the build's props, hints and destructibles; this is how far in from the quay's edge the railing stands (m). */
export const RAIL_INSET = CITY.districts.waterfront.railInset;
