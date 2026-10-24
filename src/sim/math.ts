/**
 * Math used by the simulation. Every transcendental call in sim/city code goes
 * through here so it can later be swapped for a portable implementation if
 * cross-engine bit exactness is ever needed (e.g. server side verification on
 * a different runtime). Basic arithmetic and sqrt are IEEE exact already.
 */

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const sin = (x: number): number => Math.sin(x);
export const cos = (x: number): number => Math.cos(x);
export const tan = (x: number): number => Math.tan(x);
export const atan2 = (y: number, x: number): number => Math.atan2(y, x);
export const sqrt = (x: number): number => Math.sqrt(x);
export const abs = (x: number): number => (x < 0 ? -x : x);
export const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
export const exp = (x: number): number => Math.exp(x);
export const pow = (x: number, y: number): number => Math.pow(x, y);

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** An index on a polyline of n points: wrapped on a closed one, held at the ends of an open one. */
export function wrapIndex(i: number, n: number, closed: boolean): number {
  return closed ? ((i % n) + n) % n : clamp(i, 0, n - 1);
}

/** Move `x` toward `target` by at most `maxDelta`. */
export function approach(x: number, target: number, maxDelta: number): number {
  if (x < target) return Math.min(x + maxDelta, target);
  return Math.max(x - maxDelta, target);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > PI) r -= TAU;
  else if (r <= -PI) r += TAU;
  return r;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export interface Vec2 {
  x: number;
  z: number;
}

const v2len = (x: number, z: number): number => sqrt(x * x + z * z);

/** Closest point parameter t in [0,1] of point p on segment ab. */
export function segmentT(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-12) return 0;
  return clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1);
}

export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const t = segmentT(px, pz, ax, az, bx, bz);
  const cx = ax + (bx - ax) * t;
  const cz = az + (bz - az) * t;
  return v2len(px - cx, pz - cz);
}

/** Intersect lines p + t*d and q + s*e. Returns t, or null when parallel. */
export function lineIntersectT(p: Vec2, d: Vec2, q: Vec2, e: Vec2): number | null {
  const den = d.x * e.z - d.z * e.x;
  if (abs(den) < 1e-9) return null;
  return ((q.x - p.x) * e.z - (q.z - p.z) * e.x) / den;
}

/** The yaw of heading (dx, dz). Heading convention: yaw 0 faces +Z, positive yaw turns toward +X (left), forward is (sin yaw, cos yaw). */
export function yawOf(dx: number, dz: number): number {
  return atan2(dx, dz);
}
