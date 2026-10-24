/**
 * The elevated highway's on-ramps as geometry (rampPlan.ts plans them,
 * build.ts builds them): a two lane road from a mouth on the street parallel to the
 * deck's, up through the block between the two, onto the deck.
 *
 * The centerline (the axis) is a straight leg from the foot (on the foot
 * street's building line, heading into the block) and one circular arc that
 * turns it onto the deck's line: it ends at E, beside the deck's edge, heading
 * the way the traffic on that side of the deck runs (right hand traffic), and
 * from there the ramp's lane is the deck widened (the merge, then a taper back
 * to the deck's edge). Straight plus arc, so the distance along the axis (u)
 * and across it (v) of any point are exact, gradients included.
 *
 * The surface (rampHeight) is an absolute height along u, flat across: from
 * the ground at the foot (eased in over a vertical curve, `footEase`) at a
 * constant grade to the deck's top at E, meeting the deck's height and grade
 * there (eased over `topEase`), so a car neither bottoms out at the foot nor
 * leaves the ground over the crest. Near the foot it blends into the
 * terrain across the mouth, so the ramp meets a street that slopes across
 * it flush. Pure and deterministic; everything is plain numbers so the
 * per wheel queries allocate only what the terrain's slope does.
 */
import type { Vec2 } from '../../../sim/math';
import { atan2, sqrt } from '../../../sim/math';
import type { HeightSample } from '../types';
import type { Terrain } from '../../terrain';

/** A ramp's axis and its height profile (the profile is filled once the terrain exists: settle). */
export interface RampAxis {
  /** Foot (on the foot street's building line) and the straight leg's unit direction into the block. */
  fx: number;
  fz: number;
  dx: number;
  dz: number;
  /** Straight leg length (m). */
  a: number;
  /** Arc: center, radius (m), signed sweep (rad, + counterclockwise in atan2(z, x)) and the angle of its start. */
  cx: number;
  cz: number;
  r: number;
  sweep: number;
  phi0: number;
  /** End E (beside the deck's edge) and the unit tangent there (the merge's direction of travel). */
  ex: number;
  ez: number;
  tx: number;
  tz: number;
  /** Axis length, foot to E (m). */
  length: number;
}

/** The ramp's surface profile along the axis (absolute heights, m). */
export interface RampProfile {
  /** Ground height and grade along the axis at the foot. */
  y0: number;
  g0: number;
  /** Deck top and its grade (along the merge's travel) at E. */
  y1: number;
  g1: number;
  /** Constant grade between the vertical curves. */
  grade: number;
  /** Vertical curve lengths at the foot and at the top (m). */
  e0: number;
  e1: number;
  /** The blend into the terrain across the mouth reaches this far along the axis (m). */
  blend: number;
  /** Set once the terrain exists (settle); a ramp read before that is flat at 0. */
  ready: boolean;
}

/** Signed angle a - b wrapped to (-pi, pi]. */
function wrap(a: number): number {
  let d = a;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

/**
 * The axis from E (the end beside the deck, tangent t), radius r, the straight leg's direction d (into
 * the block, toward the deck) and its length a. The arc's center is on the far side of E from the deck
 * (`away`: unit, from the deck toward the foot street), so it bends from d onto t.
 */
export function rampAxis(E: Vec2, t: Vec2, away: Vec2, r: number, d: Vec2, a: number): RampAxis {
  const cx = E.x + away.x * r;
  const cz = E.z + away.z * r;
  // The radius at E is -away; the tangent there is t. The start of the arc has tangent d, its radius
  // turned the same way from d as -away is from t.
  const sense = (-away.x) * t.z - (-away.z) * t.x;
  // rot(radius) = tangent with rot = (x, z) -> (-z, x) when sense > 0, else (z, -x); its inverse on d.
  const rx = sense > 0 ? d.z : -d.z;
  const rz = sense > 0 ? -d.x : d.x;
  const sx = cx + rx * r;
  const sz = cz + rz * r;
  const phi0 = atan2(rz, rx);
  const phi1 = atan2(-away.z, -away.x);
  // Counterclockwise (the tangent is the radius turned +90 degrees) the angle grows from phi0 to phi1.
  const sweep = sense > 0 ? wrapPositive(phi1 - phi0) : -wrapPositive(phi0 - phi1);
  return { fx: sx - d.x * a, fz: sz - d.z * a, dx: d.x, dz: d.z, a, cx, cz, r, sweep, phi0, ex: E.x, ez: E.z, tx: t.x, tz: t.z, length: a + r * Math.abs(sweep) };
}

/**
 * The axis from a foot F to E (tangent t there, the arc's center `away` * r beyond E): the straight leg
 * is the tangent from F to that circle that runs on into the arc the way it turns. Null when F lies
 * inside the circle.
 */
export function rampAxisFrom(F: Vec2, E: Vec2, t: Vec2, away: Vec2, r: number): RampAxis | null {
  const cx = E.x + away.x * r;
  const cz = E.z + away.z * r;
  const vx = F.x - cx;
  const vz = F.z - cz;
  const D = sqrt(vx * vx + vz * vz);
  if (D <= r + 0.5) return null;
  const ccw = -away.x * t.z + away.z * t.x > 0;
  const al = Math.acos(r / D);
  const ux = vx / D;
  const uz = vz / D;
  for (const sg of [1, -1]) {
    const c = Math.cos(sg * al);
    const s = Math.sin(sg * al);
    const rx = ux * c - uz * s;
    const rz = ux * s + uz * c;
    const sx = cx + rx * r;
    const sz = cz + rz * r;
    const lx = sx - F.x;
    const lz = sz - F.z;
    const a = sqrt(lx * lx + lz * lz);
    if (a < 1e-6) continue;
    // The motion's tangent at S: the radius turned +90 degrees counterclockwise, -90 clockwise.
    const tx = ccw ? -rz : rz;
    const tz = ccw ? rx : -rx;
    if ((lx * tx + lz * tz) / a < 0.99) continue;
    const phi0 = atan2(rz, rx);
    const phi1 = atan2(-away.z, -away.x);
    const sweep = ccw ? wrapPositive(phi1 - phi0) : -wrapPositive(phi0 - phi1);
    return { fx: F.x, fz: F.z, dx: lx / a, dz: lz / a, a, cx, cz, r, sweep, phi0, ex: E.x, ez: E.z, tx: t.x, tz: t.z, length: a + r * Math.abs(sweep) };
  }
  return null;
}

/** An angle wrapped to [0, 2pi). */
function wrapPositive(a: number): number {
  let d = a % (2 * Math.PI);
  if (d < 0) d += 2 * Math.PI;
  return d;
}

/** Where along and across the axis a point is: u (m from the foot), v (m, left of travel), and their gradients. */
export interface AxisPoint {
  u: number;
  v: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
}

export function axisPoint(): AxisPoint {
  return { u: 0, v: 0, ux: 0, uz: 0, vx: 0, vz: 0 };
}

/** Project (x, z) onto the axis: the straight leg (and on before the foot), the arc, or on past E along its tangent. */
export function projectAxis(ax: RampAxis, x: number, z: number, out: AxisPoint): AxisPoint {
  const px = x - ax.cx;
  const pz = z - ax.cz;
  const rho = sqrt(px * px + pz * pz) || 1e-9;
  const s = ax.sweep > 0 ? 1 : -1;
  const psi = s * wrap(atan2(pz, px) - ax.phi0);
  const turn = Math.abs(ax.sweep);
  if (psi >= 0 && psi <= turn && rho < 2 * ax.r) {
    out.u = ax.a + ax.r * psi;
    // Counterclockwise: the center is on the left, so nearer it is left (v > 0).
    out.v = s * (ax.r - rho);
    out.ux = (s * ax.r * -pz) / (rho * rho);
    out.uz = (s * ax.r * px) / (rho * rho);
    out.vx = (-s * px) / rho;
    out.vz = (-s * pz) / rho;
    return out;
  }
  // Left normal of a direction (x, z): (-z, x).
  if (psi > turn && psi < turn + Math.PI / 2) {
    const qx = x - ax.ex;
    const qz = z - ax.ez;
    out.u = ax.length + qx * ax.tx + qz * ax.tz;
    out.v = -qx * ax.tz + qz * ax.tx;
    out.ux = ax.tx;
    out.uz = ax.tz;
    out.vx = -ax.tz;
    out.vz = ax.tx;
    return out;
  }
  const qx = x - ax.fx;
  const qz = z - ax.fz;
  out.u = qx * ax.dx + qz * ax.dz;
  out.v = -qx * ax.dz + qz * ax.dx;
  out.ux = ax.dx;
  out.uz = ax.dz;
  out.vx = -ax.dz;
  out.vz = ax.dx;
  return out;
}

/** The axis point and unit tangent at distance u along it (clamped to the foot; on past E along its tangent). */
export function axisAt(ax: RampAxis, u: number): { x: number; z: number; tx: number; tz: number } {
  if (u <= ax.a) return { x: ax.fx + ax.dx * u, z: ax.fz + ax.dz * u, tx: ax.dx, tz: ax.dz };
  if (u >= ax.length) return { x: ax.ex + ax.tx * (u - ax.length), z: ax.ez + ax.tz * (u - ax.length), tx: ax.tx, tz: ax.tz };
  const s = ax.sweep > 0 ? 1 : -1;
  const phi = ax.phi0 + (s * (u - ax.a)) / ax.r;
  const c = Math.cos(phi);
  const n = Math.sin(phi);
  // Tangent of a counterclockwise arc: the radius turned +90 degrees.
  return { x: ax.cx + c * ax.r, z: ax.cz + n * ax.r, tx: -n * s, tz: c * s };
}

/** Height along the axis without the mouth's blend (m) and its slope d/du. */
function along(p: RampProfile, L: number, u: number, out: { y: number; g: number }): void {
  const { y0, g0, grade: G, e0, e1, y1, g1 } = p;
  if (u <= 0) {
    out.y = y0 + g0 * u;
    out.g = g0;
  } else if (u < e0) {
    out.g = g0 + ((G - g0) * u) / e0;
    out.y = y0 + g0 * u + ((G - g0) * u * u) / (2 * e0);
  } else if (u <= L - e1) {
    out.g = G;
    out.y = y0 + ((g0 + G) * e0) / 2 + G * (u - e0);
  } else if (u < L) {
    // Measured back from the top: the curve meets y1 with slope g1 at L.
    const w = L - u;
    out.g = g1 + ((G - g1) * w) / e1;
    out.y = y1 - g1 * w - ((G - g1) * w * w) / (2 * e1);
  } else {
    out.y = y1 + g1 * (u - L);
    out.g = g1;
  }
}

/** The constant grade that carries a profile from (y0, g0) at the foot to (y1, g1) at length L over its vertical curves. */
export function solveGrade(L: number, y0: number, g0: number, y1: number, g1: number, e0: number, e1: number): number {
  return (y1 - y0 - (g0 * e0) / 2 - (g1 * e1) / 2) / (L - e0 / 2 - e1 / 2);
}

const ALONG = { y: 0, g: 0 };
const ALONG2 = { y: 0, g: 0 };

/**
 * The ramp's surface at (x, z) whose axis position is `ap`: absolute height and gradient into `out`.
 * Over the first `blend` m it follows the terrain across the mouth: the profile plus the terrain's
 * offset from its value on the axis, faded out along u.
 */
export function rampHeight(ax: RampAxis, p: RampProfile, terrain: Terrain | null, x: number, z: number, ap: AxisPoint, out: HeightSample): void {
  if (!p.ready) {
    out.h = 0;
    out.gx = 0;
    out.gz = 0;
    return;
  }
  along(p, ax.length, ap.u, ALONG);
  let h = ALONG.y;
  let du = ALONG.g;
  let gx = 0;
  let gz = 0;
  if (terrain && ap.u < p.blend) {
    // gamma = 1 - smoothstep(0, blend, u): 1 at the foot, 0 from `blend` on.
    const t = Math.max(0, ap.u / p.blend);
    const gamma = 1 - t * t * (3 - 2 * t);
    const dGamma = ap.u > 0 ? (-6 * t * (1 - t)) / p.blend : 0;
    const q = axisAt(ax, ap.u);
    const hp = terrain.heightAt(x, z);
    const hq = terrain.heightAt(q.x, q.z);
    const sp = terrain.slopeAt(x, z);
    const sq = terrain.slopeAt(q.x, q.z);
    const dq = sq.gx * q.tx + sq.gz * q.tz;
    h += gamma * (hp - hq);
    du += dGamma * (hp - hq) - gamma * dq;
    gx += gamma * sp.gx;
    gz += gamma * sp.gz;
  }
  out.h = h;
  out.gx = gx + du * ap.ux;
  out.gz = gz + du * ap.uz;
}

/** The profile's height and grade at u along the axis (no mouth blend): for walls, the renderer and tests. */
export function rampHeightAlong(ax: RampAxis, p: RampProfile, u: number): { y: number; g: number } {
  along(p, ax.length, u, ALONG2);
  return { y: ALONG2.y, g: ALONG2.g };
}
