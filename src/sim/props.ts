/**
 * Car vs destructible props (streetlights, traffic lights, cans, benches, bus
 * stops). Each car is its oriented box; each intact prop a circle. A hit above
 * the prop's break speed knocks it down: the car loses speed along the impact
 * normal by momentum exchange with the prop's anchored mass, gets a small yaw
 * nudge from an off center hit, and the prop is marked broken for the rest of
 * the race (RaceState.brokenProps) with a 'prop' event. Below the break speed
 * the prop holds like a short wall. Deterministic: fixed car order, props
 * visited in ascending id order.
 */
import { PROP_DEFS } from '../city/props';
import type { RaceCar, RaceState } from './race';
import { sin, cos, sqrt } from './math';

/** Fraction of the off center angular impulse applied as yaw (a nudge, not a spin). */
const YAW_NUDGE = 0.35;
/** Car impact (m/s, for camera shake and drift chains) per m/s of speed lost. */
const IMPACT_PER_DV = 1.25;

const scratch: number[] = [];

function yawInertia(rc: RaceCar): number {
  const t = rc.tuning;
  const L = t.geometry.halfLength * 2;
  const W = t.geometry.halfWidth * 2;
  return ((t.mass * (L * L + W * W)) / 12) * t.yawInertiaScale;
}

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
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const u = dx * fx + dz * fz;
    const v = dx * lx + dz * lz;
    // Closest point of the box to the prop center, in car space.
    const cu = u < -hl ? -hl : u > hl ? hl : u;
    const cv = v < -hw ? -hw : v > hw ? hw : v;
    const qu = u - cu;
    const qv = v - cv;
    const d2 = qu * qu + qv * qv;
    if (d2 >= p.radius * p.radius) continue;
    // Contact normal from the prop toward the car, and penetration depth.
    let nx: number;
    let nz: number;
    let depth: number;
    if (d2 > 1e-8) {
      const d = sqrt(d2);
      nx = -(qu * fx + qv * lx) / d;
      nz = -(qu * fz + qv * lz) / d;
      depth = p.radius - d;
    } else {
      // Prop center inside the box: push out through the nearest face.
      const pu = hl - (u < 0 ? -u : u);
      const pv = hw - (v < 0 ? -v : v);
      if (pu < pv) {
        const s = u < 0 ? 1 : -1;
        nx = fx * s;
        nz = fz * s;
        depth = pu + p.radius;
      } else {
        const s = v < 0 ? 1 : -1;
        nx = lx * s;
        nz = lz * s;
        depth = pv + p.radius;
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
    c.yawRate -= ((rn * m * dv) / yawInertia(rc)) * YAW_NUDGE;
    r.brokenProps[id] = 1;
    r.events.push({ tick: r.tick, type: 'prop', car: rc.index, value: id });
    impact = Math.max(impact, dv * IMPACT_PER_DV);
  }
  return impact;
}

/** Prop collisions for every car, in car order. Raises each car's impact for this tick. */
export function stepProps(r: RaceState): void {
  if (!r.brokenProps) return;
  for (const rc of r.cars) {
    const imp = collideCarWithProps(r, rc);
    if (imp > rc.state.impact) rc.state.impact = imp;
  }
}
