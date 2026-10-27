/**
 * Fitting light to ground that is not flat. The street's fake light (the
 * lamp pools and reflection streaks of lightFx.ts, the expressway's and the
 * El's pools) is additive geometry a few centimetres over the asphalt, so on
 * a grade it only works if it follows the grade: a flat 19 m pool on a 4 %
 * street is 0.4 m under the road at its uphill edge (clipped away) and 0.4 m
 * over it at the downhill one (floating), and a streak running 20 m up a ramp
 * cuts into it. Hills, the highway's ramps, the bluff and the river's
 * entrances are all grades of several percent.
 *
 * Two tools, both render only and build-time (nothing runs per frame):
 *  - fitGroundPlane: a least squares plane through the ground height sampled
 *    in rings around a point. The instanced layers of lightFx cannot give each
 *    instance its own vertex heights, but a plane is exactly a shear in the
 *    instance matrix (pools) or one gradient attribute (streaks), so a rolling
 *    street costs no triangles at all. The plane's residual says how well it
 *    fits: the caller lifts the plane by what the ground overshoots it (never
 *    clipped) and shrinks the light when the ground curves too hard for one
 *    plane (a crest, a bridge end), which is cheaper than tessellating it.
 *  - drapedDisc / planeAlong: the district pools are merged vertex meshes
 *    (highway, elevated), so they follow the ground vertex by vertex; this is
 *    the one disc they share, and planeAlong gives it the surface of a deck
 *    or ramp where the terrain sampler would return the street below.
 */
import * as THREE from 'three';
import type { GeoBuilder } from '../geoBuilder';

/** Heights are queried with the lamp's own level (m) so a deck, a bridge and the street under it stay apart (World.heightAt). */
export type HeightSampler = (x: number, z: number, y?: number) => number;

/** A plane over the ground near a point, as the height at the point and the slope (m per m) along x and z. */
export interface GroundPlane {
  /** Plane height at the point (m). */
  y: number;
  gx: number;
  gz: number;
  /** Most the ground rises above the plane over the samples (m): the lift that keeps the light from being clipped. */
  over: number;
  /** Most the ground falls under the plane (m): how far the light floats in a dip. */
  under: number;
}

/**
 * Sampling of a fit: `rings` are the radii as fractions of the fit radius, `angles` the samples per ring. A sample whose
 * height differs from the point's by more than `cliff` (m) is another level (the channel floor beside a bridge deck,
 * a wall of the bluff) and does not count.
 */
export const GROUND_FIT = {
  rings: [0.35, 0.7, 1],
  angles: 8,
  /** Largest height difference (m) from the point that still counts as the same ground. */
  cliff: 3,
} as const;

/** Least squares plane through the ground within `radius` (m) of (x, z); `y` is the level asked of the sampler (the lamp's ground). */
export function fitGroundPlane(sample: HeightSampler, x: number, z: number, y: number, radius: number): GroundPlane {
  const h0 = sample(x, z, y);
  // Offsets from the point (dx, dz) and heights over h0; the normal equations of h = c + gx dx + gz dz.
  const dxs: number[] = [0];
  const dzs: number[] = [0];
  const dhs: number[] = [0];
  for (const f of GROUND_FIT.rings) {
    for (let k = 0; k < GROUND_FIT.angles; k++) {
      const a = (k / GROUND_FIT.angles) * Math.PI * 2;
      const dx = Math.cos(a) * radius * f;
      const dz = Math.sin(a) * radius * f;
      const dh = sample(x + dx, z + dz, y) - h0;
      if (Math.abs(dh) > GROUND_FIT.cliff) continue;
      dxs.push(dx);
      dzs.push(dz);
      dhs.push(dh);
    }
  }
  const n = dhs.length;
  let sx = 0, sz = 0, sh = 0, sxx = 0, sxz = 0, szz = 0, sxh = 0, szh = 0;
  for (let i = 0; i < n; i++) {
    sx += dxs[i];
    sz += dzs[i];
    sh += dhs[i];
    sxx += dxs[i] * dxs[i];
    sxz += dxs[i] * dzs[i];
    szz += dzs[i] * dzs[i];
    sxh += dxs[i] * dhs[i];
    szh += dzs[i] * dhs[i];
  }
  // 3x3 solve by Cramer's rule over [c, gx, gz]; singular (every sample dropped) means flat.
  const det = n * (sxx * szz - sxz * sxz) - sx * (sx * szz - sxz * sz) + sz * (sx * sxz - sxx * sz);
  let c = 0, gx = 0, gz = 0;
  if (n >= 4 && Math.abs(det) > 1e-9) {
    c = (sh * (sxx * szz - sxz * sxz) - sx * (sxh * szz - sxz * szh) + sz * (sxh * sxz - sxx * szh)) / det;
    gx = (n * (sxh * szz - sxz * szh) - sh * (sx * szz - sxz * sz) + sz * (sx * szh - sxh * sz)) / det;
    gz = (n * (sxx * szh - sxh * sxz) - sx * (sx * szh - sxh * sz) + sh * (sx * sxz - sxx * sz)) / det;
  }
  let over = 0;
  let under = 0;
  for (let i = 0; i < n; i++) {
    const r = dhs[i] - (c + gx * dxs[i] + gz * dzs[i]);
    if (r > over) over = r;
    else if (-r > under) under = -r;
  }
  return { y: h0 + c, gx, gz, over, under };
}

/** Height function of the plane through `at` that rises along `from` to `to` (the surface a little behind and ahead of it) and is level across. */
export function planeAlong(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, at: { x: number; y: number; z: number }): (x: number, z: number) => number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const run2 = dx * dx + dz * dz;
  const k = run2 > 1e-9 ? (to.y - from.y) / run2 : 0;
  const { x: ox, y: oy, z: oz } = at;
  return (x, z) => oy + k * ((x - ox) * dx + (z - oz) * dz);
}

/** What a disc of light is made of: radius (m), rings and segments of the fan, additive colour at its middle. */
export interface DiscLook {
  r: number;
  rings: number;
  segs: number;
  color: THREE.Color;
}

/**
 * An additive pool (vertex colours fading as (1 - t^2)^2 toward the rim) draped on `y` ring by ring, `lift` metres over
 * it. `gb` must be a coloured builder.
 */
export function drapedDisc(gb: GeoBuilder, x: number, z: number, y: (x: number, z: number) => number, look: DiscLook, lift: number): void {
  const tint = new THREE.Color();
  const vertex = (px: number, pz: number, t: number) => gb.vertex(px, y(px, pz) + lift, pz, 0, 1, 0, 0, 0, tint.copy(look.color).multiplyScalar((1 - t * t) ** 2));
  const mid = vertex(x, z, 0);
  let prev: number[] = [];
  for (let k = 1; k <= look.rings; k++) {
    const t = k / look.rings;
    const ring: number[] = [];
    for (let i = 0; i < look.segs; i++) {
      const a = (i / look.segs) * Math.PI * 2;
      ring.push(vertex(x + Math.cos(a) * look.r * t, z + Math.sin(a) * look.r * t, t));
    }
    for (let i = 0; i < look.segs; i++) {
      const j = (i + 1) % look.segs;
      if (k === 1) gb.triFacing(mid, ring[i], ring[j], 0, 1, 0);
      else gb.quadFacing(prev[i], prev[j], ring[j], ring[i], 0, 1, 0);
    }
    prev = ring;
  }
}
