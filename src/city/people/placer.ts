/**
 * Where a person may stand, shared by everyone who plans people in the city
 * (the gate stands, the idle people, the walkers): `makePlacer` checks a
 * spot against the route corridor, the walls, the props and everyone placed
 * so far; `groundY` is the floor under a spot; `thin` keeps a stand under its
 * cap; `wallBehind` probes how far a person can step toward the wall at
 * their back. Pure (reads World), no three.js: the people plan feeds the sim
 * (src/sim/people.ts), so it must stay deterministic.
 */
import type { Contact, World } from '../world';
import { CITY } from '../config';
import { sin, cos } from '../../sim/math';

/** Crowd extent around a gate along the route (m): mostly on the approach. */
export const BACK = 58;
export const FWD = 38;

/** Shared placement state for every stand: spacing between everyone placed so far, plus the world checks. */
export function makePlacer(world: World) {
  const cell = 0.5;
  const taken = new Map<number, number[]>();
  const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);
  const contacts: Contact[] = [];
  const near: number[] = [];
  const route = world.route;
  return {
    /** A free standing spot: off the route corridor, not inside a block, not on a prop (except `ignorePropId`, an idler's own bench), clear of everyone else. */
    ok(x: number, z: number, ignorePropId = -1): boolean {
      const rp = world.routeProgress(x, z);
      const half = route.segWidth[rp.seg] / 2;
      const beyondEnds = !route.closed && (rp.s < 0.5 || rp.s > route.length - 0.5);
      if (Math.abs(rp.lateral) < half + 0.5 && !beyondEnds) return false;
      const n = world.collideCircle(x, z, 0.3, contacts);
      for (let i = 0; i < n; i++) {
        const c = contacts[i];
        if (c.kind === 'wall' && (x - c.px) * c.nx + (z - c.pz) * c.nz < -0.15) return false;
      }
      if (world.propGrid && world.props) {
        world.propGrid.query(x - 2, z - 2, x + 2, z + 2, near);
        for (const id of near) {
          if (id === ignorePropId) continue;
          const p = world.props[id];
          if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < (p.radius * 1.15 + 0.4) ** 2) return false;
        }
      }
      const ix = Math.floor(x / cell);
      const iz = Math.floor(z / cell);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const list = taken.get(key(ix + a, iz + b));
          if (!list) continue;
          for (let k = 0; k < list.length; k += 2) if ((list[k] - x) ** 2 + (list[k + 1] - z) ** 2 < 0.42 * 0.42) return false;
        }
      }
      return true;
    },
    take(x: number, z: number): void {
      const k = key(Math.floor(x / cell), Math.floor(z / cell));
      let list = taken.get(k);
      if (!list) taken.set(k, (list = []));
      list.push(x, z);
    },
  };
}
export type Placer = ReturnType<typeof makePlacer>;

/** The floor under a spot: terrain height, plus the curb on a sidewalk. */
export const groundY = (world: World, x: number, z: number) => world.heightAt(x, z) + (world.surfaceAt(x, z) === 'road' ? 0 : CITY.curbHeight);

/** Keep every step-th person so a stand stays under its cap. */
export function thin<T>(out: T[], cap: number): T[] {
  if (out.length <= cap) return out;
  const keep: T[] = [];
  const step = out.length / cap;
  for (let i = 0; i < cap; i++) keep.push(out[Math.floor(i * step)]);
  return keep;
}

/** How far a wall probe looks behind a person (m), and its step (m). */
const PROBE_MAX = 2;
const PROBE_STEP = 0.25;

const probeContacts: Contact[] = [];

/**
 * How far a circle can step from (x, z) along the unit vector (dx, dz) before `world.collideCircle` reports a wall
 * (m, 0 to `max`): the same test `makePlacer().ok` applies to a spot, repeated every 0.25 m.
 */
export function wallRoom(world: World, x: number, z: number, dx: number, dz: number, max = PROBE_MAX): number {
  for (let d = PROBE_STEP; d <= max + 1e-6; d += PROBE_STEP) {
    const px = x + dx * d;
    const pz = z + dz * d;
    const n = world.collideCircle(px, pz, 0.3, probeContacts);
    for (let i = 0; i < n; i++) {
      const c = probeContacts[i];
      if (c.kind === 'wall' && (px - c.px) * c.nx + (pz - c.pz) * c.nz < -0.15) return d - PROBE_STEP;
    }
  }
  return max;
}

/**
 * The direction a person cannot sidestep far in and how far they get: the unit vector opposite their facing and
 * the room (m, 0 to 2) a short walk that way has before a wall. Writes (backX, backZ, backRoom) into `out`.
 */
export function wallBehind(world: World, x: number, z: number, yaw: number, out: { backX: number; backZ: number; backRoom: number }): void {
  const bx = -sin(yaw);
  const bz = -cos(yaw);
  out.backX = bx;
  out.backZ = bz;
  out.backRoom = wallRoom(world, x, z, bx, bz);
}
