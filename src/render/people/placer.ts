/**
 * Where a person may stand, shared by everyone who places people in the city
 * (the race crowds, the idle people on the sidewalks): `makePlacer` checks a
 * spot against the route corridor, the walls, the props and everyone placed
 * so far; `groundY` is the floor under a spot; `thin` keeps a stand under its
 * cap; `nearestCars` picks the few cars a people shader reacts to. Pure
 * apart from the structural vector type, no three.js. Render only.
 */
import type { Contact, World } from '../../city/world';
import { CITY } from '../../city/config';

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

/** Anything with a vec4 setter (a THREE.Vector4) so this file stays free of three.js. */
export interface Vec4Like {
  set(x: number, y: number, z: number, w: number): unknown;
}

/**
 * The n cars nearest (lx, lz) by repeated selection (ten cars at most, no allocation), written into out[0..n) as
 * (x, z, speed, 0); missing ones as a far-away car.
 */
export function nearestCars(cars: readonly { x: number; z: number; speed: number }[], lx: number, lz: number, n: number, out: readonly Vec4Like[]): void {
  let taken = 0;
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < cars.length && k < 31; k++) {
      if (taken & (1 << k)) continue;
      const d = (cars[k].x - lx) ** 2 + (cars[k].z - lz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      taken |= 1 << best;
      const c = cars[best];
      out[i].set(c.x, c.z, c.speed, 0);
    } else out[i].set(1e6, 1e6, 0, 0);
  }
}
