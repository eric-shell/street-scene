/**
 * Where the city's hilltop lookout stands (drawn by render/districts/hills.ts,
 * kept free by render/buildings/backlots.ts): on the tallest hill, the highest
 * spot near its summit with room for the tower's terrace, inside a block where
 * no car reaches (plain block ground by World.areaAt, out of every district
 * exclusion and opening, clear of every wall, road and building). Render only
 * and computed from the world alone, once per world, so the two that read it
 * agree and the menu city and the race draw the same tower.
 */
import type { World } from '../../city/world';
import { corridorClearance, insideBuilding } from '../../city/blocks';
import { PolygonIndex } from '../../city/districts/geom';
import { SpatialGrid } from '../../city/spatial';
import { type Vec2, distToSegment } from '../../sim/math';

/** Per city (World.blocks, shared by the menu's world and every race's on it). */
const clearances = new WeakMap<object, (x: number, z: number, max: number) => number>();

/**
 * Distance from (x, z) to the nearest of the city's own walls (World.blocks.walls), capped at `max`: the
 * same for the menu city and every race on it, where World.wallClearance also counts that race's barriers
 * and rails. What render only planners that must agree between them measure against.
 */
export function cityWallClearance(world: World): (x: number, z: number, max: number) => number {
  let f = clearances.get(world.blocks);
  if (f) return f;
  const walls = world.blocks.walls;
  const b = world.graph.bounds;
  const grid = SpatialGrid.forBounds(b.minX - 250, b.minZ - 250, b.maxX + 250, b.maxZ + 250, 16);
  walls.forEach((w, i) => grid.insertSegment(i, w.ax, w.az, w.bx, w.bz));
  const scratch: number[] = [];
  f = (x, z, max) => {
    grid.query(x - max, z - max, x + max, z + max, scratch);
    let best = max;
    for (const id of scratch) {
      const w = walls[id];
      best = Math.min(best, distToSegment(x, z, w.ax, w.az, w.bx, w.bz));
    }
    return best;
  };
  clearances.set(world.blocks, f);
  return f;
}

export interface LookoutSite {
  x: number;
  z: number;
  /** Radius of the terrace it stands on (m): nothing else is built within it. */
  r: number;
}

const LOOKOUT = {
  /** The terrace's radius (m) and the extra room kept round it from walls and roads (m). */
  r: 8,
  room: 2,
  /** Searched on a grid this fine (m) this far round the summit (m); higher ground wins, a little nearer the summit breaks ties. */
  step: 6,
  reach: 96,
  near: 0.04,
  /** Only a hill at least this tall gets one (m). */
  minHeight: 8,
} as const;

/** Per city (World.blocks): the menu's world and every race's on it share the answer. */
const sites = new WeakMap<object, LookoutSite | null>();

export function lookoutSite(world: World): LookoutSite | null {
  if (sites.has(world.blocks)) return sites.get(world.blocks)!;
  const site = findSite(world);
  sites.set(world.blocks, site);
  return site;
}

function findSite(world: World): LookoutSite | null {
  let hill = null;
  for (const a of world.areas) if (a.kind === 'hills' && a.params.h >= LOOKOUT.minHeight && (!hill || a.params.h > hill.params.h)) hill = a;
  if (!hill) return null;
  const cx = hill.params.cx;
  const cz = hill.params.cz;
  const g = world.graph;
  const pad = 200;
  const keepOut = new PolygonIndex<{ polygon: Vec2[] }>(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad);
  for (const b of world.districts.builds) {
    for (const p of b.exclusions) if (p.length >= 3) keepOut.add({ polygon: p });
    for (const p of b.openings) if (p.length >= 3) keepOut.add({ polygon: p });
  }
  const R = LOOKOUT.r;
  const scratch: number[] = [];
  const clearance = cityWallClearance(world);
  const near = world.blocks.buildings.filter((b) => Math.abs(b.x - cx) < LOOKOUT.reach + 60 && Math.abs(b.z - cz) < LOOKOUT.reach + 60);
  // The terrace's rim, sampled, must stand on plain block ground too.
  const rim = Array.from({ length: 8 }, (_, k) => ({ x: Math.cos((k / 8) * 2 * Math.PI) * R, z: Math.sin((k / 8) * 2 * Math.PI) * R }));
  const free = (x: number, z: number): boolean => {
    for (const p of [{ x: 0, z: 0 }, ...rim]) {
      const a = world.areaAt(x + p.x, z + p.z);
      if (!a || (a.kind !== 'downtown' && a.kind !== 'hills')) return false;
      if (keepOut.first(x + p.x, z + p.z)) return false;
    }
    if (corridorClearance(g, world.blocks.edgeGrid, x, z, scratch) < R + LOOKOUT.room) return false;
    if (clearance(x, z, R + LOOKOUT.room + 1) < R + LOOKOUT.room) return false;
    return !near.some((b) => insideBuilding(b, x, z, R + 1));
  };
  let best: LookoutSite | null = null;
  let score = -Infinity;
  for (let dx = -LOOKOUT.reach; dx <= LOOKOUT.reach; dx += LOOKOUT.step) {
    for (let dz = -LOOKOUT.reach; dz <= LOOKOUT.reach; dz += LOOKOUT.step) {
      const d = Math.hypot(dx, dz);
      if (d > LOOKOUT.reach) continue;
      const x = cx + dx;
      const z = cz + dz;
      const s = world.heightAt(x, z) - LOOKOUT.near * d;
      if (s <= score || !free(x, z)) continue;
      score = s;
      best = { x, z, r: R };
    }
  }
  return best;
}
