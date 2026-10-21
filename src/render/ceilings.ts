/**
 * What hangs over the streets, for the cameras: tunnel ceilings and the mass
 * above them (an air rights building, a ridge's rock), viaduct decks, gantry
 * trusses and a car park garage's levels over its drivable floor and ramp.
 * The chase camera rides 2-4 m over the car, but an orbit drag or a wall
 * pull-in (camera.ts wallLift) can lift it into a deck or a tunnel's roof,
 * and the intro fly-in can pass through one: keepOutOfWalls
 * calls clampCeiling, which moves a camera caught inside one of these solids
 * out through the nearer of its underside or its top.
 *
 * The shapes come from render/districts/structureShapes.ts, the same
 * functions their renderers draw with. Built once per world (cached), a few
 * boxes tested per frame: no allocation, cost negligible.
 */
import type * as THREE from 'three';
import type { World } from '../city/world';
import { toLocal } from '../city/districts/structures';
import { gantryShape } from '../city/districts/overpass';
import { CITY } from '../city/config';
import { boreRoad, bridgeTop, ceilingAbove, coverOf, deckLine, ridgeShape, rockAt, tunnelShape, viaductShape } from './districts/structureShapes';
import { carParkGeo } from '../city/districts/carPark';
import { garageSpan } from './districts/carPark';

/** Room kept between the camera and a ceiling or a deck (m): the near plane and a little air. */
export const CEILING_MARGIN = 0.45;

/** One overhead solid: a bounding box in XZ and its underside and top at a point (NaN outside it). */
interface Overhead {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Writes the underside and top (m) at (x, z) into span; returns false outside the solid's footprint. */
  at(x: number, z: number, span: { bottom: number; top: number }): boolean;
}

const cache = new WeakMap<World, Overhead[]>();
const span = { bottom: 0, top: 0 };

function bbox(pts: { x: number; z: number }[], pad: number): Pick<Overhead, 'minX' | 'minZ' | 'maxX' | 'maxZ'> {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

function build(world: World): Overhead[] {
  const out: Overhead[] = [];
  const T = CITY.districts.tunnel;
  for (const a of world.areas) {
    if (a.kind === 'tunnel') {
      const t = tunnelShape(a);
      const ridge = a.variant === 'ridge';
      const cover = coverOf(t, ridge);
      const r = ridge ? ridgeShape(a) : null;
      const roof = ridge ? 0 : bridgeTop(a);
      const corners = [-1, 1].flatMap((su) => [-1, 1].map((sv) => ({ x: t.cx + t.ux * su * cover - t.uz * sv * t.front, z: t.cz + t.uz * su * cover + t.ux * sv * t.front })));
      out.push({
        ...bbox(corners, 1),
        at(x, z, s) {
          const l = toLocal(t, x, z);
          if (Math.abs(l.u) > cover || Math.abs(l.v) > t.front) return false;
          const road = boreRoad(world, t, l.u);
          s.bottom = road + ceilingAbove(t, ridge, l.v);
          s.top = r ? Math.max(rockAt(world, r, x, z), road + T.clearance + T.slab) : road + roof;
          return true;
        },
      });
    } else if (a.kind === 'overpass' && a.variant === 'viaduct') {
      const v = viaductShape(a);
      const line = deckLine(world, v);
      out.push({
        ...bbox(a.polygon, 1),
        at(x, z, s) {
          const dx = x - v.x0;
          const dz = z - v.z0;
          const along = dx * v.ux + dz * v.uz;
          const lat = -dx * v.uz + dz * v.ux;
          if (along < 0 || along > v.length || Math.abs(lat) > v.half + 0.3) return false;
          s.bottom = line.a + line.b * along;
          s.top = s.bottom + v.depth + 1.1;
          return true;
        },
      });
    } else if (a.kind === 'carPark') {
      // The garage's levels over its drivable floor and the covered ramp's roof (render/districts/carPark.ts).
      const g = carParkGeo(a);
      out.push({ ...bbox([...g.deck, ...g.ramp], 1), at: (x, z, s) => garageSpan(g, world.heightAt, x, z, s) });
    } else if (a.kind === 'overpass' && a.variant === 'gantry') {
      const g = gantryShape(a);
      out.push({
        ...bbox(a.path, 2),
        at(x, z, s) {
          const l = toLocal(g, x, z);
          if (Math.abs(l.u) > 0.9 || Math.abs(l.v) > g.legV) return false;
          s.bottom = world.heightAt(g.cx, g.cz) + g.clearance - 0.2;
          s.top = world.heightAt(g.cx, g.cz) + g.clearance + 1.4;
          return true;
        },
      });
    }
  }
  return out;
}

/**
 * Move `pos` out of any overhead solid it is inside (with CEILING_MARGIN of
 * air): down under it when that is the nearer way out, else up over it.
 */
export function clampCeiling(world: World, pos: THREE.Vector3, margin = CEILING_MARGIN): void {
  let list = cache.get(world);
  if (!list) cache.set(world, (list = build(world)));
  for (const o of list) {
    if (pos.x < o.minX || pos.x > o.maxX || pos.z < o.minZ || pos.z > o.maxZ) continue;
    if (!o.at(pos.x, pos.z, span)) continue;
    const lo = span.bottom - margin;
    const hi = span.top + margin;
    if (pos.y <= lo || pos.y >= hi) continue;
    pos.y = pos.y - lo < hi - pos.y ? lo : hi;
  }
}
