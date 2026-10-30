/**
 * Yards: where trees and parked cars may stand without being ghosts.
 *
 * Invariant 5 (CLAUDE.md): every sim wall is drawn, and nothing drawn stops a
 * car without a wall. A tree or a parked car on ground a car can reach would
 * be drawn but drive-through; making them solids would be a sim change that
 * rewrites every replay. So this pass plants only where no car can go: in the
 * yard behind the low walls that close the street frontage, the 'boundary'
 * walls of every gap the infill left (and of the alley bays) and the 'lotEdge'
 * curbs on the back of its drivable pockets. Those pockets themselves are
 * drivable (their clutter is destructible), so nothing stands inside them:
 * the yard is the strip of block interior behind their back wall, which
 * render/buildings/backlots.ts keeps open (BACKLOT.back) and which until now
 * showed bare ground over the wall.
 *
 * Reachability is decided from the sim's own wall data, never assumed. A
 * footprint is accepted only when every probe over it (a grid over a car, a
 * ring round a trunk) is:
 *  - behind the source wall's line by more than the wall's body and its piers
 *    (the wall's normal points to the drivable side), with a wall standing
 *    right in front of it along that normal, so the wall continues past the
 *    footprint's ends instead of stopping short of them;
 *  - closer to no other wall than to that one (a corner, a building, another
 *    run behind would make the geometry something other than a plain strip);
 *  - on block ground: World.areaAt says downtown or hills (no lot, plaza,
 *    alley, ramp or right of way of any district), outside every district
 *    exclusion and opening, and clear of every building's footprint.
 * tests/yards.test.ts floods the drivable space from the roads and proves the
 * result on a few seeds: no tree trunk and no parked car is touched by a car.
 *
 * Plan only, memoized per city (World.blocks): the menu city, a race and the
 * backlots all read the same answer. Backlots keep clear of it (planBacklots
 * asks `blocked`), so a parked car never stands inside a backlot building.
 * Cars draw in render/traffic/parkedCars.ts, trees in districts/index.ts
 * (the district tree layers, so they cost no draw call).
 */
import type { World } from '../../city/world';
import type { CityBlocks, Wall } from '../../city/blocks';
import { insideBuilding } from '../../city/blocks';
import { PolygonIndex } from '../../city/districts/geom';
import { SpatialGrid } from '../../city/spatial';
import { Rng, deriveSeed } from '../../sim/prng';
import { regionAt } from '../buildings/architecture';
import type { DistrictKit } from './kit';
import { palm, tree } from './trees';
import { cityWallClearance } from './hillLookout';
import { TRAFFIC } from '../../sim/tuning';
import { TRAFFIC_MODELS } from '../traffic/traffic';

export const YARD = {
  /** Wall looks with a yard behind them. */
  looks: ['boundary', 'lotEdge'],
  /** Depth (m) behind a wall's line that its body, piers and lantern caps fill: nothing stands nearer. */
  wallBody: 0.7,
  /** Gap kept between a footprint and the wall body (m). */
  gap: 0.15,
  /** A wall must stand within this far (m) in front of every probe along the wall's normal. */
  frontReach: 0.3,
  /** Another wall may come no nearer to a probe than the source wall's line less this (m). */
  nearest: 0.12,
  /** A wall whose ground climbs this steeply along it (rise per m, boundaryWalls.ts HILL.grade less a margin) has stairs or a retaining bank behind it: nothing stands there. */
  grade: 0.04,
  /** Clear of an infill pocket's footprint by this (m): its own back wall is the source wall, so the yard starts just behind it. */
  pocketGap: 0.6,
  /** Clear of every other area's footprint (parks, alleys, ramps, the El, the highway, the channel) by this (m): the ground under or beside them is open. */
  areaGap: 2.5,
  /** Clear of every building's footprint by this (m). */
  buildingGap: 0.8,
  /** Tree trunk circle (m): the flare at the ground. */
  trunk: 0.4,
  /** Spots tried per metre of wall (a random spot along it, a random model), before the footprint tests and the spacing. */
  carTries: 0.6,
  treeTries: 0.5,
  /** Share of the spots that pass the tests and are taken: the density of a yard. */
  carTake: 0.4,
  treeTake: 0.4,
  /** Centre to centre spacing of trees (m), and the room a tree keeps off a car's footprint (m). */
  treeSpacing: 4.6,
  treeToCar: 1.2,
  /** Room kept between two parked cars, end to end and side to side (m). */
  carGap: 0.9,
  /** Crown radius and height of a yard tree (m): small, they stand a metre off a wall. */
  size: [1.25, 1.9],
  height: [5.2, 8.4],
  /** Share of the trees that are conifers; of a palm region's trees that are palms (la, miami). */
  conifer: 0.1,
  palm: { la: 0.6, miami: 0.85 },
  /** Share of the cars with one parking light on. */
  lit: 0.12,
} as const;

/** The passenger kinds (TRAFFIC.kinds order, the first nine): a parked row is never a bus or a fire truck. */
export const PARKED_KINDS = 9;

export interface YardTree {
  x: number;
  z: number;
  /** Crown radius and total height (m). */
  size: number;
  height: number;
  palm: boolean;
  conifer: boolean;
  /** Wall look it stands behind. */
  look: 'boundary' | 'lotEdge';
}

export interface YardCar {
  x: number;
  z: number;
  /** Heading (rad, atan2(forward x, forward z) as the traffic's yaw): along the wall. */
  yaw: number;
  /** Index into TRAFFIC.kinds, one of the PARKED_KINDS passenger cars. */
  kind: number;
  /** 0..1 pick of the street palette and its brightness jitter. */
  tint: number;
  /** Index of the one lamp lit in the model's lamp list, or -1. */
  light: number;
  look: 'boundary' | 'lotEdge';
}

export interface Yards {
  trees: YardTree[];
  cars: YardCar[];
  /** Whether (x, z) is within `margin` m of a planted tree's trunk or a parked car's body (the backlots keep off). */
  blocked(x: number, z: number, margin: number): boolean;
}

const plans = new WeakMap<CityBlocks, Yards>();

/** The yards of a city (memoized per World.blocks). */
export function planYards(world: World): Yards {
  let y = plans.get(world.blocks);
  if (!y) plans.set(world.blocks, (y = plan(world)));
  return y;
}

/** Share of the yard trees planted per tier (the plan is the same at every tier; Low plants a thinner row). */
const TREE_SHARE = { low: 0.6, medium: 1, high: 1 } as const;

/** Plant the yard trees into the district tree layer (so they cost no draw call and cull with the other trees). */
export function plantYardTrees(kit: DistrictKit): void {
  const share = TREE_SHARE[kit.quality];
  planYards(kit.world).trees.forEach((t, i) => {
    if ((i * 0.618034) % 1 >= share) return;
    if (t.palm) palm(kit, t.x, t.z, t.height);
    else tree(kit, t.x, t.z, t.size, t.height, { conifer: t.conifer ? 1 : 0 });
  });
}

/** A footprint on the ground: an oriented box (cars) or a circle (half = 0). */
interface Footprint {
  x: number;
  z: number;
  /** Unit axis along the length. */
  ux: number;
  uz: number;
  hl: number;
  hw: number;
  /** Bounding radius (m). */
  r: number;
}

/** Distance (m) from a point to a footprint's outline, zero inside it. */
function distTo(f: Footprint, x: number, z: number): number {
  const dx = x - f.x;
  const dz = z - f.z;
  if (f.hw === 0) return Math.max(0, Math.hypot(dx, dz) - f.hl);
  const lu = Math.abs(dx * f.ux + dz * f.uz) - f.hl;
  const lw = Math.abs(-dx * f.uz + dz * f.ux) - f.hw;
  return Math.hypot(Math.max(lu, 0), Math.max(lw, 0));
}

/** Whether two footprints come closer than `gap` (m): sampled along the longer one's axis, exact for the circle and box cases used. */
function closer(a: Footprint, b: Footprint, gap: number): boolean {
  if (Math.hypot(a.x - b.x, a.z - b.z) > a.r + b.r + gap) return false;
  const [box, other] = a.hw >= b.hw ? [a, b] : [b, a];
  if (other.hw === 0) return distTo(box, other.x, other.z) < other.hl + gap;
  // Box against box: the corners and edge midpoints of each against the other, then the centres.
  for (const [p, q] of [[box, other], [other, box]] as const) {
    for (const su of [-1, -0.5, 0, 0.5, 1]) {
      for (const sw of [-1, 0, 1]) {
        if (distTo(q, p.x + p.ux * su * p.hl - p.uz * sw * p.hw, p.z + p.uz * su * p.hl + p.ux * sw * p.hw) < gap) return true;
      }
    }
  }
  return false;
}

function plan(world: World): Yards {
  const blocks = world.blocks;
  const clearance = cityWallClearance(world);
  const g = world.graph.bounds;
  const pad = 200;

  // The source walls: every low frontage wall and lot curb, as segments with their normals.
  const sources: Wall[] = blocks.walls.filter((w) => w.kind === 'wall' && (w.look === 'boundary' || w.look === 'lotEdge') && Math.hypot(w.bx - w.ax, w.bz - w.az) > 0.3);

  // Buildings in a coarse grid, and every district's exclusions and openings.
  const bGrid = SpatialGrid.forBounds(g.minX - pad, g.minZ - pad, g.maxX + pad, g.maxZ + pad, 40);
  blocks.buildings.forEach((b, i) => {
    const r = Math.hypot(b.w, b.d) / 2;
    bGrid.insertBox(i, b.x - r, b.z - r, b.x + r, b.z + r);
  });
  const near: number[] = [];
  const builtAt = (x: number, z: number, margin: number): boolean => {
    bGrid.query(x, z, x, z, near);
    for (const i of near) if (insideBuilding(blocks.buildings[i], x, z, margin)) return true;
    return false;
  };
  const keepOut = new PolygonIndex<{ polygon: { x: number; z: number }[] }>(g.minX - pad, g.minZ - pad, g.maxX + pad, g.maxZ + pad);
  for (const b of world.districts.builds) {
    for (const p of b.exclusions) if (p.length >= 3) keepOut.add({ polygon: p });
    for (const p of b.openings) if (p.length >= 3) keepOut.add({ polygon: p });
  }
  // Every special area's footprint: pockets are walled on their back (the source walls themselves), the rest (parks, alleys,
  // ramps, what stands under the El and the highway) is open space whose edge toward the block interior need not be.
  const pockets = new PolygonIndex<{ polygon: { x: number; z: number }[] }>(g.minX - pad, g.minZ - pad, g.maxX + pad, g.maxZ + pad);
  const special = new PolygonIndex<{ polygon: { x: number; z: number }[] }>(g.minX - pad, g.minZ - pad, g.maxX + pad, g.maxZ + pad);
  for (const a of world.areas) {
    if (a.kind === 'downtown' || a.kind === 'hills' || a.polygon.length < 3) continue;
    (a.kind === 'infill' ? pockets : special).add({ polygon: a.polygon });
  }
  /** Plain block ground a car cannot be driving on, clear of buildings. */
  const blockGround = (x: number, z: number): boolean => {
    const a = world.areaAt(x, z);
    if (!a || (a.kind !== 'downtown' && a.kind !== 'hills')) return false;
    if (keepOut.first(x, z) || special.near(x, z, YARD.areaGap) || pockets.near(x, z, YARD.pocketGap)) return false;
    return !builtAt(x, z, YARD.buildingGap);
  };
  /**
   * A probe at (x, z) belongs to a yard behind `w`: in front of the wall's line by `s` (m, behind it), a wall right
   * in front of it, no other wall nearer, and block ground.
   */
  const probeOk = (w: Wall, x: number, z: number, minS: number): boolean => {
    const s = -((x - w.ax) * w.nx + (z - w.az) * w.nz);
    if (s < minS) return false;
    if (clearance(x + w.nx * s, z + w.nz * s, YARD.frontReach + 0.05) > YARD.frontReach) return false;
    if (clearance(x, z, s + 1) < s - YARD.nearest) return false;
    return blockGround(x, z);
  };

  /** Whether the ground climbs at least YARD.grade along the wall at (x, z) (unit tangent tx, tz), 3 m each way. */
  const steep = (x: number, z: number, tx: number, tz: number): boolean => Math.abs(world.heightAt(x + tx * 3, z + tz * 3) - world.heightAt(x - tx * 3, z - tz * 3)) / 6 >= YARD.grade;

  const items: { f: Footprint; car: boolean }[] = [];
  const hash = new Map<string, number[]>();
  const CELL = 12;
  const cellsOf = (f: Footprint): string[] => {
    const out: string[] = [];
    for (let j = Math.floor((f.z - f.r) / CELL); j <= Math.floor((f.z + f.r) / CELL); j++) for (let i = Math.floor((f.x - f.r) / CELL); i <= Math.floor((f.x + f.r) / CELL); i++) out.push(`${i},${j}`);
    return out;
  };
  const clashes = (f: Footprint, car: boolean): boolean => {
    for (const k of cellsOf(f)) {
      for (const id of hash.get(k) ?? []) {
        const o = items[id];
        if (car && o.car) {
          if (closer(f, o.f, YARD.carGap)) return true;
        } else if (!car && !o.car) {
          if (Math.hypot(f.x - o.f.x, f.z - o.f.z) < YARD.treeSpacing) return true;
        } else if (closer(f, o.f, YARD.treeToCar)) return true;
      }
    }
    return false;
  };
  const add = (f: Footprint, car: boolean): void => {
    const id = items.push({ f, car }) - 1;
    for (const k of cellsOf(f)) {
      const list = hash.get(k);
      if (list) list.push(id);
      else hash.set(k, [id]);
    }
  };

  const cars: YardCar[] = [];
  const trees: YardTree[] = [];
  const region = regionAt(world);

  // Cars first, from their own stream: a footprint along the wall, nose either way, in the model's real size.
  const carRng = new Rng(deriveSeed(world.seed, 'parked'));
  for (const w of sources) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const tries = Math.floor(YARD.carTries * len + carRng.next());
    for (let attempt = 0; attempt < tries; attempt++) {
      const t = carRng.next();
      const kind = Math.min(PARKED_KINDS - 1, Math.floor(carRng.next() * PARKED_KINDS));
      const tint = carRng.next();
      const forward = carRng.chance(0.5) ? 1 : -1;
      const light = carRng.chance(YARD.lit) ? carRng.next() : -1;
      const m = TRAFFIC_MODELS.kinds[TRAFFIC.kinds[kind].name];
      // The body below the mirrors, widened for them; the wall's body plus a gap in front.
      const hl = m.halfLength;
      const hw = m.halfWidth + 0.12;
      const tx = (w.bx - w.ax) / len;
      const tz = (w.bz - w.az) / len;
      const d = YARD.wallBody + YARD.gap + hw;
      const x = w.ax + (w.bx - w.ax) * t - w.nx * d;
      const z = w.az + (w.bz - w.az) * t - w.nz * d;
      const f: Footprint = { x, z, ux: tx * forward, uz: tz * forward, hl, hw, r: Math.hypot(hl, hw) };
      if (steep(x, z, tx, tz)) continue;
      let ok = true;
      for (const su of [-1, -0.5, 0, 0.5, 1]) {
        for (const sw of [-1, 0, 1]) {
          const px = x + f.ux * su * hl - f.uz * sw * hw;
          const pz = z + f.uz * su * hl + f.ux * sw * hw;
          if (!probeOk(w, px, pz, YARD.wallBody)) ok = false;
        }
      }
      if (!ok || clashes(f, true) || !carRng.chance(YARD.carTake)) continue;
      add(f, true);
      // The model faces +z in car space: yaw = atan2(forward x, forward z).
      cars.push({ x, z, yaw: Math.atan2(f.ux, f.uz), kind, tint, light: light < 0 ? -1 : Math.min(m.lamps.length - 1, Math.floor(light * m.lamps.length)), look: w.look as 'boundary' | 'lotEdge' });
    }
  }

  // Trees from theirs, in what is left: the trunk a metre and a bit behind the wall.
  const treeRng = new Rng(deriveSeed(world.seed, 'yardTrees'));
  for (const w of sources) {
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const tries = Math.floor(YARD.treeTries * len + treeRng.next());
    for (let attempt = 0; attempt < tries; attempt++) {
      const t = treeRng.next();
      const size = treeRng.range(YARD.size[0], YARD.size[1]);
      const height = treeRng.range(YARD.height[0], YARD.height[1]) * (0.8 + 0.2 * size / YARD.size[1]);
      const pr = treeRng.next();
      const conifer = treeRng.chance(YARD.conifer);
      const d = YARD.wallBody + YARD.gap + YARD.trunk;
      const x = w.ax + (w.bx - w.ax) * t - w.nx * d;
      const z = w.az + (w.bz - w.az) * t - w.nz * d;
      const f: Footprint = { x, z, ux: 1, uz: 0, hl: YARD.trunk, hw: 0, r: size };
      if (steep(x, z, (w.bx - w.ax) / len, (w.bz - w.az) / len)) continue;
      let ok = true;
      for (let k = 0; k < 8 && ok; k++) {
        const a = (k / 8) * Math.PI * 2;
        // The trunk's ring, and the same ring a little wider (the root flare and the crown's foot).
        if (!probeOk(w, x + Math.cos(a) * YARD.trunk, z + Math.sin(a) * YARD.trunk, YARD.wallBody)) ok = false;
      }
      if (!ok || clashes(f, false) || !treeRng.chance(YARD.treeTake)) continue;
      add(f, false);
      const r = region(x, z);
      const palm = !conifer && (r === 'la' || r === 'miami') && pr < YARD.palm[r];
      trees.push({ x, z, size, height: palm ? height * 1.35 : height, palm, conifer: conifer && !palm, look: w.look as 'boundary' | 'lotEdge' });
    }
  }

  return {
    trees,
    cars,
    blocked(x, z, margin) {
      for (let j = Math.floor((z - margin) / CELL); j <= Math.floor((z + margin) / CELL); j++) {
        for (let i = Math.floor((x - margin) / CELL); i <= Math.floor((x + margin) / CELL); i++) {
          for (const id of hash.get(`${i},${j}`) ?? []) if (distTo(items[id].f, x, z) < margin) return true;
        }
      }
      return false;
    },
  };
}
