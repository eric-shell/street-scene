/**
 * The river's centerline as the area params store it: samples c0..c{cn-1} of the channel's z every cdx m
 * from cx0, read back by a uniform Catmull-Rom through them (C1, flat beyond the ends). riverL is the signed
 * distance across the channel from it, riverFrame its tangent and normal, riverSlope its dz/dx. The meander
 * is gentle, so distances measured this way are close to the true normal distance. Everything in the river
 * (planner, ramps, bridges, features, terrain, renderer) reads the channel through these.
 */
import { CITY } from '../../config';
import { sqrt } from '../../../sim/math';

const CFG = CITY.districts.river;

const samplesCache = new WeakMap<Record<string, number>, Float64Array>();

/** The centerline samples of an area's params (c0..c{cn-1}, every cdx m from cx0), cached per params object. */
function samplesOf(p: Record<string, number>): Float64Array {
  let s = samplesCache.get(p);
  if (!s) {
    const n = p.cn;
    s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = p[`c${i}`];
    samplesCache.set(p, s);
  }
  return s;
}

/** Centerline z at x: uniform Catmull-Rom through the samples (C1), flat beyond the ends. */
export function riverCenter(p: Record<string, number>, x: number): number {
  const s = samplesOf(p);
  const n = s.length;
  const u = (x - p.cx0) / p.cdx;
  if (u <= 0) return s[0];
  if (u >= n - 1) return s[n - 1];
  const k = Math.floor(u);
  const t = u - k;
  const y0 = s[Math.max(0, k - 1)];
  const y1 = s[k];
  const y2 = s[Math.min(n - 1, k + 1)];
  const y3 = s[Math.min(n - 1, k + 2)];
  return 0.5 * (2 * y1 + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t * t + (-y0 + 3 * y1 - 3 * y2 + y3) * t * t * t);
}

/** dz/dx of the centerline at x. */
export function riverSlope(p: Record<string, number>, x: number): number {
  const s = samplesOf(p);
  const n = s.length;
  const u = (x - p.cx0) / p.cdx;
  if (u <= 0 || u >= n - 1) return 0;
  const k = Math.floor(u);
  const t = u - k;
  const y0 = s[Math.max(0, k - 1)];
  const y1 = s[k];
  const y2 = s[Math.min(n - 1, k + 1)];
  const y3 = s[Math.min(n - 1, k + 2)];
  return (0.5 * (-y0 + y2 + 2 * (2 * y0 - 5 * y1 + 4 * y2 - y3) * t + 3 * (-y0 + 3 * y1 - 3 * y2 + y3) * t * t)) / p.cdx;
}

/** Signed distance across the channel (z above the centerline at the point's x; the meander is gentle, so this is close to the true normal distance). */
export function riverL(p: Record<string, number>, x: number, z: number): number {
  return z - riverCenter(p, x);
}

/** Unit tangent (toward +x) and normal (toward +l) of the centerline at x. */
export function riverFrame(p: Record<string, number>, x: number): { tx: number; tz: number; mx: number; mz: number } {
  const s = riverSlope(p, x);
  const tl = sqrt(1 + s * s);
  const tx = 1 / tl;
  const tz = s / tl;
  return { tx, tz, mx: -tz, mz: tx };
}

/** Width of the channel edges as the route sees them (the floor less the chord margin on each side). */
export function channelWidth(floorHalf = CFG.floorHalf): number {
  return 2 * (floorHalf - CFG.channelMargin);
}
