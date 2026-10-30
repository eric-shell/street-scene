/**
 * Banked terrain: bowls and bends whose outer edge rises, as terrain height modifiers with exact analytic
 * gradients. Two shapes share this module because every area that wants banking wants one of them, and the
 * speedway and the pit to come will want both:
 *
 *  - a banked ring (`BankedRing`, `bankedRingMod`): a bowl you drive round, the scrapyard's figure eight;
 *  - a banked arc (`BankedArc`, `bankMod`): a turn whose outside rises along part of a circle, the rail yard's
 *    turnaround.
 *
 * Both are pure functions of the radius from a centre (the arc also of the angle), both are C1 and exactly 0 at
 * their box, so they add to the terrain like any HeightMod and the tests compare numeric slopes with the gradients.
 *
 * Ring profile, as a height above grade (m) at radius r:
 *   r <= floorR            -dip                               the floor, flat, dug `dip` below grade
 *   floorR..crestR         -dip + rise * S(t), t = (r - floorR) / (crestR - floorR)   the bank: climbing outward
 *   crestR..rimR           (rise - dip) * (1 - S(u)), u = (r - crestR) / (rimR - crestR)   the rim: falling back to grade
 *   r >= rimR              0
 * with S the smoothstep 3t^2 - 2t^3. The joins are flat, so the height is C1 for every r; the bank's cross slope
 * peaks at 1.5 * rise / bankWidth (41% for 1.5 m over 5.5 m, about 22 degrees: a car at speed rides it), the rim's
 * at 1.5 * crest / rimWidth. The gradient is the profile's slope times the unit vector away from the centre
 * (P' is 0 for r < floorR, so the centre needs no special case). Composing rings: a figure eight is two rings
 * whose rim circles touch (centres 2 * rimR apart, `tangentRings`); each fades to 0 at its own rim, so the ground
 * between the bowls is a flat neck at grade. Overlapping rings add their heights (exact, but a ridge), so keep rim
 * circles apart or tangent. A bowl's ring road is the annulus from the island in its middle out to the crest.
 *
 * Arc cross-section, outward from the centre (q is the radius less `rOut - rise`):
 *  - q <= 0: flat, the road (zero);
 *  - 0..rise: up to `height` along a smoothstep, so the turn-in is eased and the slope at its steepest is
 *    1.5 height / rise (about 36% for 1.2 m over 5 m: a car leans into it rather than being thrown, and a car that
 *    climbs it at speed is stopped by the wall);
 *  - rise..rise + hold: the flat crest, where the wall stands (`wallRadius`);
 *  - the next `fall` m: back down to zero along a smoothstep, behind that wall.
 * Along the arc the whole profile tapers to nothing over `taper` rad at each end of the span (a smoothstep of the
 * angle), so the banking grows out of the straight instead of starting at a step. With r the distance from the
 * centre and phi the angle from the span's middle:
 *   h(x, z)  = height * P(r - r0) * A(phi)
 *   dh/dx    = height * (P' * dx / r * A + P * A' * (-dz / r^2))
 *   dh/dz    = height * (P' * dz / r * A + P * A' * ( dx / r^2))
 * where P' and A' come from the smoothsteps' own derivatives. Past `reachOf` the arc is zero. Pure.
 */
import type { Vec2 } from '../../sim/math';
import { atan2, cos, sin, sqrt, wrapAngle } from '../../sim/math';
import type { HeightMod, HeightSample } from './types';
import { smooth01, type Smooth } from './geom';

// ---------------------------------------------------------------------------
// Banked rings (bowls)
// ---------------------------------------------------------------------------


/** A banked bowl: centre, the radii of its floor edge, crest and rim (m, floorR < crestR < rimR), and its depth below grade and bank rise above the floor (m). */
export interface BankedRing {
  cx: number;
  cz: number;
  /** Radius (m) of the flat floor's edge, where the bank starts to climb. */
  floorR: number;
  /** Radius (m) of the bank's crest, its highest point. */
  crestR: number;
  /** Radius (m) where the rim has fallen back to grade: the ring's whole reach. */
  rimR: number;
  /** How far the floor is dug below grade (m). */
  dip: number;
  /** Bank height above the floor at the crest (m). */
  rise: number;
}

/** A ring's whole shape from its crest radius and the cross-section numbers (CITY.districts.scrapyard.bank). */
export function bankedRing(cx: number, cz: number, crestR: number, bank: { dip: number; rise: number; bankWidth: number; rimWidth: number }): BankedRing {
  return { cx, cz, floorR: crestR - bank.bankWidth, crestR, rimR: crestR + bank.rimWidth, dip: bank.dip, rise: bank.rise };
}

/** Height of the crest above grade (m). */
export const crestHeight = (r: BankedRing): number => r.rise - r.dip;

/** The profile's height above grade and its slope in r (m, m per m) at radius r. */
export function ringProfile(ring: BankedRing, r: number, out: { h: number; d: number }): { h: number; d: number } {
  if (r <= ring.floorR) {
    out.h = -ring.dip;
    out.d = 0;
  } else if (r < ring.crestR) {
    const w = ring.crestR - ring.floorR;
    const t = (r - ring.floorR) / w;
    out.h = -ring.dip + ring.rise * t * t * (3 - 2 * t);
    out.d = (ring.rise * 6 * t * (1 - t)) / w;
  } else if (r < ring.rimR) {
    const w = ring.rimR - ring.crestR;
    const u = (r - ring.crestR) / w;
    const c = crestHeight(ring);
    out.h = c * (1 - u * u * (3 - 2 * u));
    out.d = (-c * 6 * u * (1 - u)) / w;
  } else {
    out.h = 0;
    out.d = 0;
  }
  return out;
}

/** Scratch for the terrain's per wheel queries: nothing allocates. */
const P = { h: 0, d: 0 };

/** The ring as a terrain modifier (graph phase height mod): adds its height and exact gradient. */
export function bankedRingMod(ring: BankedRing): HeightMod {
  return {
    minX: ring.cx - ring.rimR,
    maxX: ring.cx + ring.rimR,
    minZ: ring.cz - ring.rimR,
    maxZ: ring.cz + ring.rimR,
    add(x: number, z: number, out: HeightSample): void {
      const dx = x - ring.cx;
      const dz = z - ring.cz;
      const r = sqrt(dx * dx + dz * dz);
      if (r >= ring.rimR) return;
      ringProfile(ring, r, P);
      out.h += P.h;
      if (r > 1e-9 && P.d !== 0) {
        out.gx += (P.d * dx) / r;
        out.gz += (P.d * dz) / r;
      }
    },
  };
}

/**
 * The two rings of a figure eight: centres `2 * rimR` apart along the unit axis (ax, az) through (cx, cz) (the middle, the flat
 * neck), rim circles tangent there.
 */
export function tangentRings(cx: number, cz: number, ax: number, az: number, crestR: number, bank: { dip: number; rise: number; bankWidth: number; rimWidth: number }): [BankedRing, BankedRing] {
  const rim = crestR + bank.rimWidth;
  return [bankedRing(cx - ax * rim, cz - az * rim, crestR, bank), bankedRing(cx + ax * rim, cz + az * rim, crestR, bank)];
}

// ---------------------------------------------------------------------------
// Banked arcs (bends)
// ---------------------------------------------------------------------------


/** One banked arc. */
export interface BankedArc {
  /** Centre of the turn (m). */
  cx: number;
  cz: number;
  /** Radius (m) where the rise reaches its full height: the outside of the banking proper. */
  rOut: number;
  /** Width (m) of the rising cross-section, measured inward from rOut. */
  rise: number;
  /** Flat crest (m) past rOut, and the drop (m) behind it. */
  hold: number;
  fall: number;
  /** Height (m) at the crest. */
  height: number;
  /** The span's middle direction and half width (rad, atan2(dz, dx) of the world's x/z). */
  mid: number;
  half: number;
  /** Angular taper (rad) at each end of the span. */
  taper: number;
}

/** Radius (m) of the wall that closes the banking's crest. */
export const wallRadius = (b: BankedArc): number => b.rOut + b.hold * 0.5;

/** Furthest radius (m) at which the banking adds anything. */
export const reachOf = (b: BankedArc): number => b.rOut + b.hold + b.fall;

const S1: Smooth = { v: 0, d: 0 };
const S2: Smooth = { v: 0, d: 0 };

/** The cross-section's share of the height at radius offset q = r - (rOut - rise) and its derivative in q. */
function profile(b: BankedArc, q: number, out: Smooth): Smooth {
  if (q <= 0 || q >= b.rise + b.hold + b.fall) {
    out.v = 0;
    out.d = 0;
  } else if (q < b.rise) {
    smooth01(0, b.rise, q, out);
  } else if (q <= b.rise + b.hold) {
    out.v = 1;
    out.d = 0;
  } else {
    smooth01(b.rise + b.hold, b.rise + b.hold + b.fall, q, out);
    out.v = 1 - out.v;
    out.d = -out.d;
  }
  return out;
}

/** Add the banking's height and gradient at (x, z) into `out`. */
export function bankAdd(b: BankedArc, x: number, z: number, out: HeightSample): void {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const r2 = dx * dx + dz * dz;
  if (r2 < 1e-9) return;
  const r = sqrt(r2);
  const P = profile(b, r - (b.rOut - b.rise), S1);
  if (P.v <= 0 && P.d === 0) return;
  const phi = wrapAngle(atan2(dz, dx) - b.mid);
  const ap = Math.abs(phi);
  if (ap >= b.half) return;
  // Angular window: 1 inside, falling to 0 over the last `taper` of the half span.
  const W = smooth01(b.half - b.taper, b.half, ap, S2);
  const A = 1 - W.v;
  const dA = -W.d * (phi >= 0 ? 1 : -1);
  const H = b.height;
  out.h += H * P.v * A;
  out.gx += H * (P.d * (dx / r) * A + P.v * dA * (-dz / r2));
  out.gz += H * (P.d * (dz / r) * A + P.v * dA * (dx / r2));
}

/** The height modifier of an arc (box: the circle of its reach). */
export function bankMod(b: BankedArc): HeightMod {
  const R = reachOf(b) + 0.5;
  return { minX: b.cx - R, minZ: b.cz - R, maxX: b.cx + R, maxZ: b.cz + R, add: (x, z, out) => bankAdd(b, x, z, out) };
}

/** The wall's centreline along the arc, `step` rad apart (an open polyline, end to end). */
export function bankWallLine(b: BankedArc, step: number): Vec2[] {
  const R = wallRadius(b);
  const n = Math.max(2, Math.ceil((2 * b.half) / step));
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = b.mid - b.half + (2 * b.half * i) / n;
    out.push({ x: b.cx + cos(a) * R, z: b.cz + sin(a) * R });
  }
  return out;
}
