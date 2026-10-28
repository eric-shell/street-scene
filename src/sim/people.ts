/**
 * Pedestrians as bodies a car hits. The city plans the people (src/city/people: gate stands, idlers, walkers,
 * `peopleOf(world)`, independent of graphics quality); this module is what the race does with them. Each person
 * is a circle of PEOPLE.radius at their place at the sim clock (`personAt` at tick × DT s) plus the stateless
 * dodge every car asks of the people in its path (`sidestep`), against each car's oriented box like a prop
 * (props.ts). A person the car touches while closing below `breakSpeed` holds like a short wall; faster, the car
 * loses speed by perfectly inelastic momentum exchange with the person's mass (anchor 1), gets the same small
 * yaw nudge from an off center hit, and the person goes down for the rest of the race: `PeopleState.down`, the
 * tick and the fling velocity for the renderer's ragdoll, and a 'person' event. No nitrous (nobody pays for
 * hitting a person), a light impact for the camera. Idle people anchored to a prop (a bench's sitters, a bus
 * stop's riders) go down in the same tick the prop breaks, flung with the car that is being processed.
 *
 * Walkers are a function of time, not state: the sim evaluates them at `r.tick * DT` s (walkPaths.walkerAt, the
 * twin of the shader), so the renderer must drive the walkers' clock from the sim tick in a race for the two to
 * agree (the menu city runs on the render clock; nobody is hit there). `sidestep` has a GLSL twin in the people
 * shaders: change both together. Deterministic: cars in order, people in ascending id, no allocation per tick.
 * The plan is built once per World on first use (`peopleOf`).
 */
import type { World } from '../city/world';
import { peopleOf, personAt } from '../city/people/people';
import type { RaceCar, RaceState } from './race';
import { abs, clamp, cos, sin, smoothstep, sqrt } from './math';
import { yawInertia } from './car';
import { DT, LEVEL_GAP } from './constants';
import { IMPACT_PER_DV, YAW_NUDGE } from './props';
import { PEOPLE_PARAMS } from './tuning';
import type { PeopleParams } from './tuning';

/** The pedestrian numbers (drivingParams.json `people`). */
export const PEOPLE: PeopleParams = PEOPLE_PARAMS;

/** Who is down this race, indexed by `WorldPerson.id` (`peopleOf(world).people`). Fresh per race; all empty when the config has people off. */
export interface PeopleState {
  /** 1 = knocked down. */
  down: Uint8Array;
  /** Tick of the hit, -1 = standing. */
  hitTick: Int32Array;
  /** Velocity the person is flung at (m/s, x and z). */
  hitVx: Float32Array;
  hitVz: Float32Array;
  /** Where the person was at the hit (m, x and z): their dodged place for a car hit, their home or walk position for a sitter taken by a prop; the renderer starts the fall here. */
  hitX: Float32Array;
  hitZ: Float32Array;
  /** People knocked down so far. */
  hits: number;
}

/** The people of a new race: one slot per planned person when `on`, else an empty state (old replays, free of cost). */
export function createPeopleState(world: World, on: boolean): PeopleState {
  const n = on ? peopleOf(world).people.length : 0;
  return { down: new Uint8Array(n), hitTick: new Int32Array(n).fill(-1), hitVx: new Float32Array(n), hitVz: new Float32Array(n), hitX: new Float32Array(n), hitZ: new Float32Array(n), hits: 0 };
}

/** A car as the dodge sees it: the sim passes its tick state, the renderer its interpolated pose. */
export interface DodgeCar {
  x: number;
  z: number;
  /** Heading (three.js yaw, rad): forward is (sin, cos). */
  yaw: number;
  /** Speed (m/s). */
  speed: number;
}

/**
 * Where a person steps to get out of the way of the cars: the offset (m, x and z) from their place, a pure
 * function of the person's place, the cars and the room behind them, with no state. Written into `out`.
 * Implemented literally from this spec (S = PEOPLE.sidestep) so a GLSL twin matches it:
 * - For each car k, in order, with speed >= S.minSpeed: F = (sin yaw, cos yaw), R = (F.z, -F.x), d = P - C,
 *   ahead = d.F, lat = d.R, lane = S.carHalfWidth + PEOPLE.radius + S.margin. |lat| >= lane: no contribution.
 * - along: smoothstep over ahead, 0 at ahead >= S.carHalfLength + S.lookAhead, 1 for -carHalfLength <= ahead <=
 *   carHalfLength + 4, 0 at ahead <= -carHalfLength - S.behind.
 * - tAvail = (S.lookAhead - clamp(ahead - carHalfLength, 0, S.lookAhead)) / speed: the time the person has had
 *   since the car was lookAhead away; canStep = min(S.max, S.speed * tAvail). A slow car is dodged, a fast one
 *   hits people (at 30 m/s they manage about a metre).
 * - s = clamp(lat / S.softSign, -1, 1); sgn = s + (1 - |s|) * prefer, where prefer is the person's own
 *   WorldPerson.prefer (+1 or -1, (lookSeed & 1) ? 1 : -1): continuous in lat, sign(lat) from |lat| >= softSign
 *   and `prefer` at lat 0, so a person dead in line picks their side instead of staying put.
 *   want = (lane - |lat|) * sgn; step_k = R * sign(want) * min(|want|, canStep) * along.
 * - offset = sum of step_k, its length clamped to S.max * 1.2; then the wall: with back the unit vector toward
 *   the wall behind, if offset.back > backRoom then offset -= back * (offset.back - backRoom).
 */
export function sidestep(px: number, pz: number, cars: readonly DodgeCar[], backX: number, backZ: number, backRoom: number, prefer: number, out: { x: number; z: number }): void {
  const S = PEOPLE.sidestep;
  const hl = S.carHalfLength;
  const lane = S.carHalfWidth + PEOPLE.radius + S.margin;
  let ox = 0;
  let oz = 0;
  for (let k = 0; k < cars.length; k++) {
    const car = cars[k];
    if (car.speed < S.minSpeed) continue;
    const fx = sin(car.yaw);
    const fz = cos(car.yaw);
    const rx = fz;
    const rz = -fx;
    const dx = px - car.x;
    const dz = pz - car.z;
    const ahead = dx * fx + dz * fz;
    const lat = dx * rx + dz * rz;
    if (abs(lat) >= lane) continue;
    const along = ahead >= hl + 4 ? 1 - smoothstep(hl + 4, hl + S.lookAhead, ahead) : ahead >= -hl ? 1 : smoothstep(-hl - S.behind, -hl, ahead);
    if (along <= 0) continue;
    const tAvail = (S.lookAhead - clamp(ahead - hl, 0, S.lookAhead)) / car.speed;
    const canStep = Math.min(S.max, S.speed * tAvail);
    const s = clamp(lat / S.softSign, -1, 1);
    const want = (lane - abs(lat)) * (s + (1 - abs(s)) * prefer);
    const mag = Math.min(abs(want), canStep) * along * (want < 0 ? -1 : 1);
    ox += rx * mag;
    oz += rz * mag;
  }
  const len = sqrt(ox * ox + oz * oz);
  const maxLen = S.max * 1.2;
  if (len > maxLen) {
    ox *= maxLen / len;
    oz *= maxLen / len;
  }
  const along = ox * backX + oz * backZ;
  if (along > backRoom) {
    ox -= backX * (along - backRoom);
    oz -= backZ * (along - backRoom);
  }
  out.x = ox;
  out.z = oz;
}

/** Speed a knocked down person is thrown away from the car along the contact normal, on top of the car's share (m/s). */
const FLING_AWAY = 1.5;

const scratch: number[] = [];
const place = { x: 0, z: 0, yaw: 0 };
const off = { x: 0, z: 0 };
/** The cars' tick states as the dodge's cars, refilled each tick (RaceCar.state has the DodgeCar fields). */
const dodgeCars: DodgeCar[] = [];

/** Collide one car with the people near it; returns the impact speed (0 when nothing was hit). */
function collideCarWithPeople(r: RaceState, rc: RaceCar, t: number): number {
  const st = r.people;
  const plan = peopleOf(r.world);
  const c = rc.state;
  const tu = rc.tuning;
  const hl = tu.geometry.halfLength;
  const hw = tu.geometry.halfWidth;
  const rad = PEOPLE.radius;
  const reach = hl + rad + PEOPLE.sidestep.max * 1.2 + 0.5;
  plan.grid.query(c.x - reach, c.z - reach, c.x + reach, c.z + reach, scratch);
  if (!scratch.length) return 0;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  // Car right vector (local +X).
  const lx = fz;
  const lz = -fx;
  let impact = 0;
  for (const id of scratch) {
    if (st.down[id]) continue;
    const p = plan.people[id];
    if (abs(p.y - c.y) > LEVEL_GAP) continue;
    // Sitters and leaners go down with their prop: stepProps ran first this tick, so a bench that just broke takes
    // its sitters in the same tick. The prop took the momentum already, so no exchange and no normal term.
    if (p.idle && p.idle.anchorProp >= 0 && r.brokenProps[p.idle.anchorProp] === 1) {
      personAt(p, t, place);
      st.down[id] = 1;
      st.hitTick[id] = r.tick;
      st.hitX[id] = place.x;
      st.hitZ[id] = place.z;
      st.hitVx[id] = PEOPLE.flingShare * c.vx;
      st.hitVz[id] = PEOPLE.flingShare * c.vz;
      st.hits++;
      r.events.push({ tick: r.tick, type: 'person', car: rc.index, value: id });
      continue;
    }
    personAt(p, t, place);
    sidestep(place.x, place.z, dodgeCars, p.backX, p.backZ, p.backRoom, p.prefer, off);
    const dx = place.x + off.x - c.x;
    const dz = place.z + off.z - c.z;
    const u = dx * fx + dz * fz;
    const v = dx * lx + dz * lz;
    // Closest point of the box to the person, in car space.
    const cu = u < -hl ? -hl : u > hl ? hl : u;
    const cv = v < -hw ? -hw : v > hw ? hw : v;
    const qu = u - cu;
    const qv = v - cv;
    const d2 = qu * qu + qv * qv;
    if (d2 >= rad * rad) continue;
    // Contact normal from the person toward the car, and penetration depth.
    let nx: number;
    let nz: number;
    let depth: number;
    if (d2 > 1e-8) {
      const d = sqrt(d2);
      nx = -(qu * fx + qv * lx) / d;
      nz = -(qu * fz + qv * lz) / d;
      depth = rad - d;
    } else {
      // Person inside the box: push out through the nearest face.
      const pu = hl - (u < 0 ? -u : u);
      const pv = hw - (v < 0 ? -v : v);
      if (pu < pv) {
        const s = u < 0 ? 1 : -1;
        nx = fx * s;
        nz = fz * s;
        depth = pu + rad;
      } else {
        const s = v < 0 ? 1 : -1;
        nx = lx * s;
        nz = lz * s;
        depth = pv + rad;
      }
    }
    // Contact point (on the box surface) relative to the car center.
    const rx = cu * fx + cv * lx;
    const rz = cu * fz + cv * lz;
    const vpx = c.vx + c.yawRate * rz;
    const vpz = c.vz - c.yawRate * rx;
    const vn = vpx * nx + vpz * nz;
    if (vn >= 0) continue;
    if (-vn < PEOPLE.breakSpeed) {
      // Holds: stop against them like a short wall.
      c.x += nx * depth;
      c.z += nz * depth;
      c.vx -= vn * nx;
      c.vz -= vn * nz;
      impact = Math.max(impact, -vn);
      continue;
    }
    // Knocked down: perfectly inelastic exchange along the normal with the person's mass.
    const m = tu.mass;
    const mp = PEOPLE.mass;
    const dv = -vn * (mp / (m + mp));
    c.vx += dv * nx;
    c.vz += dv * nz;
    // Off center hits turn the car a little (impulse J = m * dv along n at r).
    const rn = rx * nz - rz * nx;
    c.yawRate -= ((rn * m * dv) / yawInertia(tu)) * YAW_NUDGE;
    st.down[id] = 1;
    st.hitTick[id] = r.tick;
    st.hitX[id] = place.x + off.x;
    st.hitZ[id] = place.z + off.z;
    // Flung along the car's velocity at the contact, and a little away from it.
    st.hitVx[id] = PEOPLE.flingShare * vpx - nx * FLING_AWAY;
    st.hitVz[id] = PEOPLE.flingShare * vpz - nz * FLING_AWAY;
    st.hits++;
    r.events.push({ tick: r.tick, type: 'person', car: rc.index, value: id });
    impact = Math.max(impact, dv * IMPACT_PER_DV);
  }
  return impact;
}

/** People collisions for every car, in car order. Raises each car's impact for this tick. Nothing when the race has people off. */
export function stepPeople(r: RaceState): void {
  if (!r.people.down.length) return;
  const t = r.tick * DT;
  dodgeCars.length = 0;
  for (const rc of r.cars) dodgeCars.push(rc.state);
  for (const rc of r.cars) {
    const imp = collideCarWithPeople(r, rc, t);
    if (imp > rc.state.impact) rc.state.impact = imp;
  }
}
