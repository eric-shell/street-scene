/**
 * Car collisions. Each car is approximated by three circles along its length.
 * Walls and barriers: positional correction plus an impulse at the contact
 * point; glancing hits mostly keep their speed and slide along, head on hits
 * lose almost all of it. Corner rails bounce and spin little, but scraping
 * along them drags speed off for as long as the car stays in contact.
 * When the race's RailState is passed, rails are the heavy modular pieces of
 * src/sim/rails.ts at their displaced positions instead of the static rail
 * walls: hits shove pieces back a little and cost speed for the dent, and the
 * steps between dented and straight pieces catch cars scraping along.
 * Timed gates (sim/gates.ts: the drawbridge's arms) join the static walls
 * while they block, for cars coming at them.
 * Car vs car: equal-ish impulses. Fixed iteration order.
 */
import { CarState } from './car';
import { CarTuning } from './tuning';
import { DT } from './constants';
import { abs, cos, sign, sin, sqrt } from './math';
import type { Contact, World } from '../city/world';
import { RailState, collideRails, pushRailPiece, railStepAhead } from './rails';
import { collideGates } from './gates';

/** Hardest static hit of a tick: normal impact speed (m/s) and what was hit. */
export interface WorldHit {
  speed: number;
  kind: Contact['kind'];
}

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
/** Rail piece of each contact (-1 for static walls), parallel to `contacts`. */
const contactPiece: number[] = [];

/**
 * World contacts for a circle; with rail bodies, static rail walls are replaced by the displaced pieces.
 * Timed gates blocking at `tick` are added for the car whose center is (carX, carZ). A car body at
 * height y passes over low walls (Wall.top: a car park's lip face).
 */
function gatherContacts(world: World, rails: RailState | undefined, x: number, z: number, r: number, tick = 0, carX = x, carZ = z, y = -Infinity): number {
  const n = world.collideCircle(x, z, r, contacts, y);
  contactPiece.length = 0;
  if (!rails || !rails.layout.subCount) {
    for (let i = 0; i < n; i++) contactPiece.push(-1);
    return world.timedGates ? n + collideGates(world.timedGates, tick, carX, carZ, x, z, r, contacts, contactPiece) : n;
  }
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (contacts[i].kind === 'rail') continue;
    contacts[w++] = contacts[i];
    contactPiece.push(-1);
  }
  contacts.length = w;
  const nr = w + collideRails(rails, x, z, r, contacts, contactPiece);
  return world.timedGates ? nr + collideGates(world.timedGates, tick, carX, carZ, x, z, r, contacts, contactPiece) : nr;
}

/**
 * Resolve a car against static walls (and the race's rail pieces, when given).
 * Returns the impact speed (m/s) of the hardest hit; `hit`, when given, also
 * receives the kind of wall it was.
 */
export function collideCarWithWorld(c: CarState, t: CarTuning, world: World, hit?: WorldHit, rails?: RailState, tick = 0): number {
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const m = t.mass;
  const I = yawInertia(t);
  const ang = t.collision.angularScale;
  let impact = 0;
  let kind: Contact['kind'] = 'wall';
  // Rail tangent of the deepest rail contact this tick, for sliding friction.
  let railTx = 0;
  let railTz = 0;
  let railDepth = 0;
  // Spark telemetry: the deepest contact of the tick and the speed sliding along it.
  let scrapeDepth = 0;
  c.scrape = 0;
  c.scrapeNx = 0;
  c.scrapeNz = 0;
  for (const circ of circleOffsets(t)) {
    // Two passes handle corners where two walls meet.
    for (let pass = 0; pass < 2; pass++) {
      const cx = c.x + fx * circ.u;
      const cz = c.z + fz * circ.u;
      const n = gatherContacts(world, rails, cx, cz, circ.r, tick, c.x, c.z, c.y);
      if (n === 0) break;
      let bi = 0;
      for (let i = 1; i < n; i++) if (contacts[i].depth > contacts[bi].depth) bi = i;
      const best = contacts[bi];
      const { nx, nz, depth } = best;
      const rail = best.kind === 'rail';
      const angK = rail ? t.collision.railAngularScale : ang;
      c.x += nx * depth;
      c.z += nz * depth;
      if (rail && depth > railDepth) {
        railDepth = depth;
        railTx = -nz;
        railTz = nx;
      }
      if (rails && contactPiece[bi] >= 0) {
        // Scraping into a step where a dented piece meets one that was not shoved back.
        const step = railStepAhead(rails, contactPiece[bi], c.vx, c.vz, cx, cz, DT);
        if (step > 0) {
          const keep = 1 - Math.min(0.5, step * t.collision.railStepLoss);
          c.vx *= keep;
          c.vz *= keep;
        }
      }
      const rx = cx - nx * circ.r - c.x;
      const rz = cz - nz * circ.r - c.z;
      const vpx = c.vx + c.yawRate * rz;
      const vpz = c.vz - c.yawRate * rx;
      const vn = vpx * nx + vpz * nz;
      if (depth > scrapeDepth) {
        scrapeDepth = depth;
        c.scrape = abs(vpz * nx - vpx * nz);
        c.scrapeX = best.px;
        c.scrapeZ = best.pz;
        c.scrapeNx = nx;
        c.scrapeNz = nz;
      }
      if (vn >= 0) continue;
      const rn = rz * nx - rx * nz;
      const invM = 1 / m + ((rn * rn) / I) * angK;
      const j = (-(1 + (rail ? t.collision.railRestitution : t.collision.wallRestitution)) * vn) / invM;
      c.vx += (j * nx) / m;
      c.vz += (j * nz) / m;
      c.yawRate += ((rn * j) / I) * angK;
      // Friction against the wall scrubs some tangential speed.
      const tx = -nz;
      const tz = nx;
      const vt = c.vx * tx + c.vz * tz;
      const dv = Math.min(abs(vt), ((rail ? t.collision.railScrub : t.collision.wallScrub) * j) / m);
      c.vx -= sign(vt) * dv * tx;
      c.vz -= sign(vt) * dv * tz;
      if (rails && contactPiece[bi] >= 0) {
        // Shoving a heavy rail piece back soaks up speed along it.
        const moved = pushRailPiece(rails, contactPiece[bi], nx, nz, j, best.px, best.pz, tick);
        if (moved > 0) {
          const loss = Math.min(0.5, moved * t.collision.railDentLoss);
          const vt2 = c.vx * tx + c.vz * tz;
          c.vx -= vt2 * loss * tx;
          c.vz -= vt2 * loss * tz;
        }
      }
      if (-vn > impact) {
        impact = -vn;
        kind = best.kind;
      }
    }
  }
  if (railDepth > 0) {
    // Scraping a rail: sliding friction for every tick of contact, applied at the center of
    // mass so it costs speed without spinning the car.
    const vt = c.vx * railTx + c.vz * railTz;
    const dv = Math.min(abs(vt), (t.collision.railDrag + t.collision.railSpeedLoss * abs(vt)) * DT);
    c.vx -= sign(vt) * dv * railTx;
    c.vz -= sign(vt) * dv * railTz;
  }
  if (hit) {
    hit.speed = impact;
    hit.kind = kind;
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
