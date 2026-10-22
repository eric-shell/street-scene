/**
 * Tire shapes besides the house tire every wheel ships with (docs/carWheels.md):
 * a meaty race tire and two stretched ones, lathed at runtime in place of the
 * wheel's own tire so any wheel can wear any of them. Pure math on vertex
 * arrays in wheel space (center at the origin, axle along X), no three.js.
 *
 * A shape is a half profile in units of the tire it replaces: x is the distance
 * from the tire's center plane over the bead's (where the tire tucks under the
 * wheel's lip, so the bead never moves), v the height from the bead (0) to the
 * tread (1). The outer radius never changes, so the sim's wheel radius and the
 * wheel size slider (wheelFit.ts) work the same on every shape. For reference,
 * the house tire's sidewall bulges out to 1.24 and its tread is flat from 0.71.
 */
import type { TireShape } from '../../shared/carBuild';

type Profile = readonly (readonly [x: number, v: number])[];

/** Each shape's half profile, from the face side's bead up to the tread's center. */
const PROFILES: Record<Exclude<TireShape, 'standard'>, Profile> = {
  // A bulky square race tire: the sidewall bulges well past the lip and stays upright to a tight
  // shoulder, the tread flat almost to the edges.
  meaty: [[1, 0], [1.26, 0.14], [1.35, 0.4], [1.36, 0.8], [1.34, 0.93], [1.28, 0.985], [1.16, 1], [0, 1]],
  // Slightly narrower than the wheel: the sidewall leans in from the lip with a trace of bulge left.
  mildStretch: [[1, 0], [1.03, 0.12], [1, 0.42], [0.93, 0.75], [0.86, 0.93], [0.78, 0.99], [0.6, 1], [0, 1]],
  // Pulled tight over a wide wheel: a straight, steep sidewall and a narrow tread, the lip standing proud.
  aggressiveStretch: [[1, 0], [0.98, 0.07], [0.89, 0.37], [0.78, 0.71], [0.7, 0.92], [0.63, 0.99], [0.48, 1], [0, 1]],
};

/** Segments around the tire, as the house tire's (scripts/blender/carWheels.py TIRE_SEG). */
const SEGMENTS = 40;

/** The tire a shape replaces, measured from its vertices (wheel space units). */
export interface TireFit {
  /** Radius of the bead, the tire's innermost ring. */
  inner: number;
  /** Tread radius. */
  outer: number;
  /** Distance of the bead from the tire's center plane. */
  beadX: number;
}

/**
 * Measure a tire mesh (xyz positions). Null when it has no sidewall to shape
 * (the placeholder wheel's open cylinder).
 */
export function measureTire(pos: ArrayLike<number>): TireFit | null {
  let inner = Infinity;
  let outer = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const r = Math.hypot(pos[i + 1], pos[i + 2]);
    inner = Math.min(inner, r);
    outer = Math.max(outer, r);
  }
  if (!(outer > 0) || outer - inner < 0.1 * outer) return null;
  let beadX = 0;
  const near = inner + 0.05 * (outer - inner);
  for (let i = 0; i < pos.length; i += 3) if (Math.hypot(pos[i + 1], pos[i + 2]) <= near) beadX = Math.max(beadX, Math.abs(pos[i]));
  return beadX > 0 ? { inner, outer, beadX } : null;
}

/**
 * Lathe a tire of the given shape to fit where the old one sat: smooth normals
 * from the profile, faces wound outward. 40 x 15 vertices, 1,120 triangles
 * (the house tire has 960).
 */
export function latheTire(shape: Exclude<TireShape, 'standard'>, fit: TireFit): { position: Float32Array; normal: Float32Array; index: Uint16Array } {
  const half = PROFILES[shape];
  const h = fit.outer - fit.inner;
  // The full profile: face side bead to tread center, then mirrored to the back bead.
  const prof: [number, number][] = half.map(([x, v]) => [x * fit.beadX, fit.inner + v * h]);
  for (let k = half.length - 2; k >= 0; k--) prof.push([-prof[k][0], prof[k][1]]);
  const P = prof.length;
  // Each point's normal in the profile plane: its tangent (central difference) turned outward.
  const n2 = prof.map((_, k) => {
    const a = prof[Math.max(0, k - 1)];
    const b = prof[Math.min(P - 1, k + 1)];
    const tx = b[0] - a[0];
    const tr = b[1] - a[1];
    const len = Math.hypot(tx, tr) || 1;
    return [tr / len, -tx / len];
  });
  const position = new Float32Array(SEGMENTS * P * 3);
  const normal = new Float32Array(SEGMENTS * P * 3);
  for (let i = 0; i < SEGMENTS; i++) {
    const t = (2 * Math.PI * i) / SEGMENTS;
    const c = Math.cos(t);
    const s = Math.sin(t);
    for (let k = 0; k < P; k++) {
      const o = (i * P + k) * 3;
      position[o] = prof[k][0];
      position[o + 1] = prof[k][1] * c;
      position[o + 2] = prof[k][1] * s;
      normal[o] = n2[k][0];
      normal[o + 1] = n2[k][1] * c;
      normal[o + 2] = n2[k][1] * s;
    }
  }
  // Wound so every face points out of the tire (the tread's +r, the sidewalls' ±x).
  const index = new Uint16Array(SEGMENTS * (P - 1) * 6);
  let n = 0;
  for (let i = 0; i < SEGMENTS; i++) {
    const a0 = i * P;
    const b0 = ((i + 1) % SEGMENTS) * P;
    for (let k = 0; k < P - 1; k++) {
      const a = a0 + k;
      const b = a0 + k + 1;
      const c = b0 + k + 1;
      const d = b0 + k;
      index.set([a, b, c, a, c, d], n);
      n += 6;
    }
  }
  return { position, normal, index };
}
