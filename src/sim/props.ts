/**
 * Car vs destructible props (streetlights, traffic lights, cans, benches, bus
 * stops). Each car is its oriented box; each intact prop a circle, or for a
 * long one (a bus shelter, Prop.depth) a capsule: the circle of radius depth
 * at the point of its core nearest the car. A hit above
 * the prop's break speed knocks it down: the car loses speed along the impact
 * normal by momentum exchange with the prop's anchored mass, gets a small yaw
 * nudge from an off center hit, and the prop is marked broken for the rest of
 * the race (RaceState.brokenProps) with a 'prop' event. Below the break speed
 * the prop holds like a short wall. Knocking one down pays a little
 * nitrous (nitrous.wreckBonus, scaled by the prop's effective mass so a trash bag
 * is worth a fraction of a light pole), the wreck telemetry the HUD calls out.
 * Deterministic: fixed car order, props
 * visited in ascending id order.
 */
import { PROP_DEFS } from '../city/props';
import type { RaceCar, RaceState } from './race';
import { abs, sin, cos, sqrt } from './math';
import { fillNitrous, yawInertia } from './car';
import { LEVEL_GAP } from './constants';

/** Fraction of the off center angular impulse applied as yaw (a nudge, not a spin). */
export const YAW_NUDGE = 0.35;
/** Car impact (m/s, for camera shake and drift chains) per m/s of speed lost. */
export const IMPACT_PER_DV = 1.25;
/** Points sampled along a capsule prop's core (odd, so the middle is one): closer than its radius apart. */
const CORE_SAMPLES = 5;

const scratch: number[] = [];

/** Collide one car with the props around it. Returns the impact speed (0 when nothing was hit). */
export function collideCarWithProps(r: RaceState, rc: RaceCar): number {
  const world = r.world;
  const grid = world.propGrid;
  if (!grid) return 0;
  const c = rc.state;
  const t = rc.tuning;
  const hl = t.geometry.halfLength;
  const hw = t.geometry.halfWidth;
  const reach = hl + 2;
  grid.query(c.x - reach, c.z - reach, c.x + reach, c.z + reach, scratch);
  if (!scratch.length) return 0;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  // Car right vector (local +X).
  const lx = fz;
  const lz = -fx;
  let impact = 0;
  for (const id of scratch) {
    if (r.brokenProps[id]) continue;
    const p = world.props[id];
    if (abs(p.y - c.y) > LEVEL_GAP) continue;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    let u = dx * fx + dz * fz;
    let v = dx * lx + dz * lz;
    // Closest point of the box to the prop center, in car space.
    let cu = u < -hl ? -hl : u > hl ? hl : u;
    let cv = v < -hw ? -hw : v > hw ? hw : v;
    let qu = u - cu;
    let qv = v - cv;
    let d2 = qu * qu + qv * qv;
    let radius = p.radius;
    if (p.depth !== undefined) {
      // Capsule: the core runs along the prop's local X (cos yaw, -sin yaw), `radius - depth` each way.
      // Keep the core sample nearest the box; the hit is then a circle of radius `depth` there.
      radius = p.depth;
      const half = p.radius - p.depth;
      const ax = cos(p.yaw);
      const az = -sin(p.yaw);
      for (let k = 0; k < CORE_SAMPLES; k++) {
        const o = half * ((2 * k) / (CORE_SAMPLES - 1) - 1);
        const sx = p.x + ax * o - c.x;
        const sz = p.z + az * o - c.z;
        const su = sx * fx + sz * fz;
        const sv = sx * lx + sz * lz;
        const scu = su < -hl ? -hl : su > hl ? hl : su;
        const scv = sv < -hw ? -hw : sv > hw ? hw : sv;
        const e2 = (su - scu) * (su - scu) + (sv - scv) * (sv - scv);
        if (k === 0 || e2 < d2) {
          u = su;
          v = sv;
          cu = scu;
          cv = scv;
          qu = su - scu;
          qv = sv - scv;
          d2 = e2;
        }
      }
    }
    if (d2 >= radius * radius) continue;
    // Contact normal from the prop toward the car, and penetration depth.
    let nx: number;
    let nz: number;
    let depth: number;
    if (d2 > 1e-8) {
      const d = sqrt(d2);
      nx = -(qu * fx + qv * lx) / d;
      nz = -(qu * fz + qv * lz) / d;
      depth = radius - d;
    } else {
      // Prop center inside the box: push out through the nearest face.
      const pu = hl - (u < 0 ? -u : u);
      const pv = hw - (v < 0 ? -v : v);
      if (pu < pv) {
        const s = u < 0 ? 1 : -1;
        nx = fx * s;
        nz = fz * s;
        depth = pu + radius;
      } else {
        const s = v < 0 ? 1 : -1;
        nx = lx * s;
        nz = lz * s;
        depth = pv + radius;
      }
    }
    // Contact point (on the box surface) relative to the car center.
    const rx = cu * fx + cv * lx;
    const rz = cu * fz + cv * lz;
    const vpx = c.vx + c.yawRate * rz;
    const vpz = c.vz - c.yawRate * rx;
    const vn = vpx * nx + vpz * nz;
    const def = PROP_DEFS[p.kind];
    const m = t.mass;
    if (vn >= 0) continue;
    if (-vn < def.breakSpeed) {
      // Holds: stop against it like a short wall.
      c.x += nx * depth;
      c.z += nz * depth;
      c.vx -= vn * nx;
      c.vz -= vn * nz;
      impact = Math.max(impact, -vn);
      continue;
    }
    // Knocked down: perfectly inelastic exchange along the normal with the
    // anchored prop mass, v_n' = v_n * m / (m + anchor * m_prop).
    const mp = p.mass * def.anchor;
    const dv = -vn * (mp / (m + mp));
    c.vx += dv * nx;
    c.vz += dv * nz;
    // Off center hits turn the car a little (impulse J = m * dv along n at r).
    const rn = rx * nz - rz * nx;
    c.yawRate -= ((rn * m * dv) / yawInertia(rc.tuning)) * YAW_NUDGE;
    r.brokenProps[id] = 1;
    r.events.push({ tick: r.tick, type: 'prop', car: rc.index, value: id });
    // The wreck pays nitrous: the whole bonus for anything as heavy as wreckFullMass, sqrt scaled below it.
    const bonus = t.nitrous.wreckBonus * Math.min(1, sqrt(mp / t.nitrous.wreckFullMass));
    c.nitroGain.wreck += fillNitrous(c, t, bonus);
    impact = Math.max(impact, dv * IMPACT_PER_DV);
  }
  return impact;
}

/** Prop collisions for every car, in car order. Raises each car's impact for this tick and resets its wreck telemetry (refillNitrous runs after this and leaves it alone). */
export function stepProps(r: RaceState): void {
  for (const rc of r.cars) {
    rc.state.nitroGain.wreck = 0;
    const imp = collideCarWithProps(r, rc);
    if (imp > rc.state.impact) rc.state.impact = imp;
  }
}
