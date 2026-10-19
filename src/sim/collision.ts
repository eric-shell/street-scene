/**
 * Car collisions. Each car is approximated by three circles along its length.
 * Walls and barriers: positional correction plus an impulse at the contact
 * point; glancing hits mostly keep their speed and slide along, head on hits
 * lose almost all of it. Car vs car: equal-ish impulses. Fixed iteration order.
 */
import { CarState } from './car';
import { CarTuning } from './tuning';
import { abs, cos, sign, sin, sqrt } from './math';
import type { Contact, World } from '../city/world';

const CIRCLES = 3;

function circleOffsets(t: CarTuning): { u: number; r: number }[] {
  const r = t.geometry.halfWidth * 0.95;
  const span = Math.max(0, t.geometry.halfLength - r);
  const out: { u: number; r: number }[] = [];
  for (let i = 0; i < CIRCLES; i++) out.push({ u: -span + (2 * span * i) / (CIRCLES - 1), r });
  return out;
}

function yawInertia(t: CarTuning): number {
  const L = t.geometry.halfLength * 2;
  const W = t.geometry.halfWidth * 2;
  return ((t.mass * (L * L + W * W)) / 12) * t.yawInertiaScale;
}

const contacts: Contact[] = [];

/** Resolve a car against static walls. Returns the impact speed (m/s) of the hardest hit. */
export function collideCarWithWorld(c: CarState, t: CarTuning, world: World): number {
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const m = t.mass;
  const I = yawInertia(t);
  const ang = t.collision.angularScale;
  let impact = 0;
  for (const circ of circleOffsets(t)) {
    // Two passes handle corners where two walls meet.
    for (let pass = 0; pass < 2; pass++) {
      const cx = c.x + fx * circ.u;
      const cz = c.z + fz * circ.u;
      const n = world.collideCircle(cx, cz, circ.r, contacts);
      if (n === 0) break;
      let best = contacts[0];
      for (let i = 1; i < n; i++) if (contacts[i].depth > best.depth) best = contacts[i];
      const { nx, nz, depth } = best;
      c.x += nx * depth;
      c.z += nz * depth;
      const rx = cx - nx * circ.r - c.x;
      const rz = cz - nz * circ.r - c.z;
      const vpx = c.vx + c.yawRate * rz;
      const vpz = c.vz - c.yawRate * rx;
      const vn = vpx * nx + vpz * nz;
      if (vn >= 0) continue;
      const rn = rz * nx - rx * nz;
      const invM = 1 / m + ((rn * rn) / I) * ang;
      const j = (-(1 + t.collision.wallRestitution) * vn) / invM;
      c.vx += (j * nx) / m;
      c.vz += (j * nz) / m;
      c.yawRate += ((rn * j) / I) * ang;
      // Friction against the wall scrubs some tangential speed.
      const tx = -nz;
      const tz = nx;
      const vt = c.vx * tx + c.vz * tz;
      const dv = Math.min(abs(vt), (t.collision.wallScrub * j) / m);
      c.vx -= sign(vt) * dv * tx;
      c.vz -= sign(vt) * dv * tz;
      impact = Math.max(impact, -vn);
    }
  }
  return impact;
}

/** Resolve contact between two cars. Returns impact speed. */
export function collideCars(a: CarState, ta: CarTuning, b: CarState, tb: CarTuning): number {
  const dx0 = b.x - a.x;
  const dz0 = b.z - a.z;
  const reach = ta.geometry.halfLength + tb.geometry.halfLength + 0.5;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return 0;
  const ca = circleOffsets(ta);
  const cb = circleOffsets(tb);
  const afx = sin(a.yaw);
  const afz = cos(a.yaw);
  const bfx = sin(b.yaw);
  const bfz = cos(b.yaw);
  const Ia = yawInertia(ta);
  const Ib = yawInertia(tb);
  const ang = ta.collision.angularScale;
  let impact = 0;
  for (const p of ca) {
    for (const q of cb) {
      const pax = a.x + afx * p.u;
      const paz = a.z + afz * p.u;
      const pbx = b.x + bfx * q.u;
      const pbz = b.z + bfz * q.u;
      let dx = pax - pbx;
      let dz = paz - pbz;
      const d = sqrt(dx * dx + dz * dz);
      const minD = p.r + q.r;
      if (d >= minD) continue;
      if (d < 1e-6) {
        dx = 1;
        dz = 0;
      } else {
        dx /= d;
        dz /= d;
      }
      // normal points from b to a
      const depth = minD - d;
      const wa = tb.mass / (ta.mass + tb.mass);
      a.x += dx * depth * wa;
      a.z += dz * depth * wa;
      b.x -= dx * depth * (1 - wa);
      b.z -= dz * depth * (1 - wa);
      const cxp = pbx + dx * q.r;
      const czp = pbz + dz * q.r;
      const rax = cxp - a.x;
      const raz = czp - a.z;
      const rbx = cxp - b.x;
      const rbz = czp - b.z;
      const vax = a.vx + a.yawRate * raz;
      const vaz = a.vz - a.yawRate * rax;
      const vbx = b.vx + b.yawRate * rbz;
      const vbz = b.vz - b.yawRate * rbx;
      const vn = (vax - vbx) * dx + (vaz - vbz) * dz;
      if (vn >= 0) continue;
      const rna = raz * dx - rax * dz;
      const rnb = rbz * dx - rbx * dz;
      const invM = 1 / ta.mass + 1 / tb.mass + ((rna * rna) / Ia + (rnb * rnb) / Ib) * ang;
      const j = (-(1 + ta.collision.carRestitution) * vn) / invM;
      a.vx += (j * dx) / ta.mass;
      a.vz += (j * dz) / ta.mass;
      b.vx -= (j * dx) / tb.mass;
      b.vz -= (j * dz) / tb.mass;
      a.yawRate += ((rna * j) / Ia) * ang;
      b.yawRate -= ((rnb * j) / Ib) * ang;
      impact = Math.max(impact, -vn);
    }
  }
  return impact;
}

/** True when the car skims a wall at speed without touching it. */
export function detectNearMiss(c: CarState, t: CarTuning, world: World): boolean {
  if (c.speed < 25 || c.impact > 0) return false;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  for (const circ of circleOffsets(t)) {
    const clear = world.wallClearance(c.x + fx * circ.u, c.z + fz * circ.u, circ.r + 1.5) - circ.r;
    if (clear < 0.9) return true;
  }
  return false;
}
