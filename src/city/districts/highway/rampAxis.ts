/**
 * The elevated highway's ramps as geometry (rampPlan.ts and loopPlan.ts plan
 * them, build.ts builds them): a two lane road from a mouth on a street up
 * onto the deck. An on-ramp and an off-ramp are the same shape (an off-ramp's
 * traffic just runs the other way, foot to E reversed).
 *
 * An end loop's centerline (the axis) is a straight leg from the foot (on the
 * street's building line, heading into the block) and one circular arc of
 * about three quarters of a circle that turns it onto the deck's line, ending
 * at E in the carriageway where the deck ends. Straight plus arc, so the
 * distance along the axis (u) and across it (v) of any point are exact,
 * gradients included. An interchange's slip ramp runs alongside the deck
 * instead, curves and all, so its axis is a polyline (AxisPoly) along the
 * deck's edge from its foot beside the street beneath to E, where its lane
 * runs on as the deck widened (the lane at full width, then a taper back to
 * the deck's edge).
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
  /** A slip ramp's axis as a polyline (in place of the leg and arc, which it leaves at zero). */
  poly?: AxisPoly;
}

/** A polyline axis, foot to E: its points, unit tangents and the distance along it from the foot (m), every few meters. */
export interface AxisPoly {
  x: number[];
  z: number[];
  tx: number[];
  tz: number[];
  u: number[];
}

/** A slip ramp's axis through these points, foot first (a few meters apart, smooth). */
export function polyAxis(pts: readonly Vec2[]): RampAxis {
  const n = pts.length;
  const p: AxisPoly = { x: [], z: [], tx: [], tz: [], u: [] };
  let u = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0) u += sqrt((pts[k].x - pts[k - 1].x) ** 2 + (pts[k].z - pts[k - 1].z) ** 2);
    const a = pts[Math.max(0, k - 1)];
    const b = pts[Math.min(n - 1, k + 1)];
    const l = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    p.x.push(pts[k].x);
    p.z.push(pts[k].z);
    p.tx.push((b.x - a.x) / l);
    p.tz.push((b.z - a.z) / l);
    p.u.push(u);
  }
  return { fx: p.x[0], fz: p.z[0], dx: p.tx[0], dz: p.tz[0], a: u, cx: 0, cz: 0, r: 0, sweep: 0, phi0: 0, ex: p.x[n - 1], ez: p.z[n - 1], tx: p.tx[n - 1], tz: p.tz[n - 1], length: u, poly: p };
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
  /** A slip ramp runs this far along the street at its level first (m): the profile's foot is this far up the axis. */
  flat: number;
  /** Set once the terrain exists (settle); a ramp read before that is flat at 0. */
  ready: boolean;
}

/**
 * The axis from a foot F to E (tangent t there, the arc's center `away` * r beyond E): the straight leg
 * is the tangent from F to that circle that runs on into the arc the way it turns. Null when F lies
 * inside the circle. The arc turns as far as it has to: a little past square for a side ramp, about
 * three quarters of a circle for an end loop whose foot lies back beside the circle.
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

/**
 * Project (x, z) onto the axis: the arc where the point lies within its turn (the angle read the whole
 * way round from the arc's start, so a loop's three quarter turn reads as one), else the nearer of the
 * straight leg (on back before the foot) and the line on past E along its tangent. A polyline axis is
 * read off its nearest piece (only the pieces within 16 m of u = `near` when that is given: a span knows
 * where along the ramp it lies), on along its end tangents past either end.
 */
export function projectAxis(ax: RampAxis, x: number, z: number, out: AxisPoint, near = NaN): AxisPoint {
  if (ax.poly) return projectPoly(ax.poly, x, z, out, near);
  const px = x - ax.cx;
  const pz = z - ax.cz;
  const rho = sqrt(px * px + pz * pz) || 1e-9;
  const s = ax.sweep > 0 ? 1 : -1;
  const turn = Math.abs(ax.sweep);
  const psi = wrapPositive(s * (atan2(pz, px) - ax.phi0));
  if (psi <= turn && rho < 2 * ax.r) {
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
  const ex = x - ax.ex;
  const ez = z - ax.ez;
  const qx = x - ax.fx;
  const qz = z - ax.fz;
  const vE = -ex * ax.tz + ez * ax.tx;
  const vF = -qx * ax.dz + qz * ax.dx;
  // Past E only just ahead of it, as far as any span reaches (the leg's line runs on behind the foot), and
  // never for a span that lies back along the axis: a loop's foot lies beside the line past its E, nearer
  // it across than the leg's own line at the mouth's corners.
  const pastE = ex * ax.tx + ez * ax.tz;
  if (pastE > 0 && pastE < 25 && !(near < ax.length - 10) && Math.abs(vE) < Math.abs(vF)) {
    out.u = ax.length + ex * ax.tx + ez * ax.tz;
    out.v = vE;
    out.ux = ax.tx;
    out.uz = ax.tz;
    out.vx = -ax.tz;
    out.vz = ax.tx;
    return out;
  }
  out.u = qx * ax.dx + qz * ax.dz;
  out.v = vF;
  out.ux = ax.dx;
  out.uz = ax.dz;
  out.vx = -ax.dz;
  out.vz = ax.dx;
  return out;
}

function projectPoly(p: AxisPoly, x: number, z: number, out: AxisPoint, near: number): AxisPoint {
  const n = p.u.length;
  let best = Infinity;
  let bk = 0;
  let bt = 0;
  for (let k = 0; k + 1 < n; k++) {
    if (!Number.isNaN(near) && (p.u[k + 1] < near - 16 || p.u[k] > near + 16)) continue;
    const sx = p.x[k + 1] - p.x[k];
    const sz = p.z[k + 1] - p.z[k];
    const l2 = sx * sx + sz * sz || 1e-9;
    // Unclamped at the ends of the line: on before the foot and on past E.
    let t = ((x - p.x[k]) * sx + (z - p.z[k]) * sz) / l2;
    if (k > 0) t = Math.max(0, t);
    if (k + 2 < n) t = Math.min(1, t);
    const dx = p.x[k] + sx * t - x;
    const dz = p.z[k] + sz * t - z;
    const d = dx * dx + dz * dz;
    if (d < best) {
      best = d;
      bk = k;
      bt = t;
    }
  }
  const sx = p.x[bk + 1] - p.x[bk];
  const sz = p.z[bk + 1] - p.z[bk];
  const l = sqrt(sx * sx + sz * sz) || 1e-9;
  const ux = sx / l;
  const uz = sz / l;
  out.u = p.u[bk] + bt * l;
  out.v = -(x - p.x[bk]) * uz + (z - p.z[bk]) * ux;
  out.ux = ux;
  out.uz = uz;
  out.vx = -uz;
  out.vz = ux;
  return out;
}

/** The axis point and unit tangent at distance u along it (clamped to the foot; on past E along its tangent). */
export function axisAt(ax: RampAxis, u: number): { x: number; z: number; tx: number; tz: number } {
  if (ax.poly) return polyAt(ax.poly, ax.length, u);
  if (u <= ax.a) return { x: ax.fx + ax.dx * u, z: ax.fz + ax.dz * u, tx: ax.dx, tz: ax.dz };
  if (u >= ax.length) return { x: ax.ex + ax.tx * (u - ax.length), z: ax.ez + ax.tz * (u - ax.length), tx: ax.tx, tz: ax.tz };
  const s = ax.sweep > 0 ? 1 : -1;
  const phi = ax.phi0 + (s * (u - ax.a)) / ax.r;
  const c = Math.cos(phi);
  const n = Math.sin(phi);
  // Tangent of a counterclockwise arc: the radius turned +90 degrees.
  return { x: ax.cx + c * ax.r, z: ax.cz + n * ax.r, tx: -n * s, tz: c * s };
}

function polyAt(p: AxisPoly, L: number, u: number): { x: number; z: number; tx: number; tz: number } {
  const n = p.u.length;
  if (u <= 0) return { x: p.x[0] + p.tx[0] * u, z: p.z[0] + p.tz[0] * u, tx: p.tx[0], tz: p.tz[0] };
  if (u >= L) return { x: p.x[n - 1] + p.tx[n - 1] * (u - L), z: p.z[n - 1] + p.tz[n - 1] * (u - L), tx: p.tx[n - 1], tz: p.tz[n - 1] };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (p.u[m] <= u) lo = m;
    else hi = m;
  }
  const t = (u - p.u[lo]) / (p.u[hi] - p.u[lo] || 1e-9);
  const tx = p.tx[lo] + (p.tx[hi] - p.tx[lo]) * t;
  const tz = p.tz[lo] + (p.tz[hi] - p.tz[lo]) * t;
  const tl = sqrt(tx * tx + tz * tz) || 1;
  return { x: p.x[lo] + (p.x[hi] - p.x[lo]) * t, z: p.z[lo] + (p.z[hi] - p.z[lo]) * t, tx: tx / tl, tz: tz / tl };
}

/** Height along the axis without the mouth's blend (m) and its slope d/du; a slip ramp's run along the street first (`flat`). */
function along(p: RampProfile, L0: number, u0: number, out: { y: number; g: number }): void {
  const { y0, g0, grade: G, e0, e1, y1, g1 } = p;
  const L = L0 - p.flat;
  const u = u0 - p.flat;
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
