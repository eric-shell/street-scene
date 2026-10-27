/**
 * Backlots: low buildings filling the middle of every city block.
 *
 * The city lines its streets with buildings (city/blocks.ts) and leaves the
 * rest of each 140 m block empty: under half of a downtown block is built.
 * From the street that emptiness shows through every gap in the frontage as a
 * black hole between the towers (the gap's low boundary wall in front of
 * nothing), and from the expressway, the hills, the car park roofs and the
 * drone as bare ground. Backlots fill it with two to eight storey buildings
 * (warehouses, walk-ups, garages behind the street) in the neighbourhood's
 * styles, built by the same mesher, so their windows light up like the rest
 * of the city and their roofs carry the same clutter.
 *
 * Render only, and nowhere a car can reach: a backlot stands only where the
 * block is plain downtown (or a hill's) ground by World.areaAt (no lot,
 * plaza, alley, ramp, deck or right of way of any district), outside every
 * district exclusion and opening, BACK m behind the block's frontage (the
 * wall line every car meets first), CLEAR m from any wall the sim has and
 * GAP m from every street building (and off the hilltop lookout's terrace,
 * hillLookout.ts). The block is packed greedily with
 * rectangles on a grid in its own frame (along its longest side), every
 * choice from a seeded stream, so the menu city and the race draw the same
 * backlots.
 */
import type { World } from '../../city/world';
import type { Building } from '../../city/blocks';
import { insideBuilding } from '../../city/blocks';
import { PolygonIndex, distToPolygonEdge, pointInPolygon } from '../../city/districts/geom';
import { downtownFactor } from '../../city/roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Vec2 } from '../../sim/math';
import type { BuildingPlan, Region } from './architecture';
import { styleFor } from './architecture';
import { cityWallClearance, lookoutSite } from '../districts/hillLookout';

const BACKLOT = {
  /** Grid cell of the packing (m). */
  cell: 3,
  /** Distance kept from the block's frontage line (m): the yard behind a boundary wall stays open. */
  back: 3.5,
  /** Distance kept from any sim wall (m) and from every street building's footprint (m). */
  clear: 2,
  gap: 1.2,
  /** Footprint sides (m): the smallest worth a building, the largest one may grow to. */
  min: 9,
  max: [18, 34],
  /** Floors (3.2 m each) at the city's edge and extra at its center (downtown factor 1). */
  floors: [2, 4],
  floorsCenter: 4,
} as const;

const FLOOR = 3.2;

export interface Backlots {
  buildings: Building[];
  plans: BuildingPlan[];
}

/** Every backlot of a city, with its architecture: the region of the nearest street building, a style for its height. */
export function planBacklots(world: World, streetPlans: readonly BuildingPlan[]): Backlots {
  const out: Backlots = { buildings: [], plans: [] };
  const B = world.blocks.buildings;
  const g = world.graph;
  const { minX, minZ, maxX, maxZ } = g.bounds;
  const downtown = (x: number, z: number) => downtownFactor(g.plan, x, z);

  // Street buildings in a coarse grid, for the gap test and the nearest one's region.
  const CELL = 40;
  const grid = new Map<string, number[]>();
  B.forEach((b, i) => {
    const r = Math.hypot(b.w, b.d) / 2;
    for (let j = Math.floor((b.z - r) / CELL); j <= Math.floor((b.z + r) / CELL); j++) {
      for (let k = Math.floor((b.x - r) / CELL); k <= Math.floor((b.x + r) / CELL); k++) {
        const key = `${k},${j}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(i);
      }
    }
  });
  const near = (x: number, z: number) => grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? [];
  const built = (x: number, z: number, margin: number) => near(x, z).some((i) => insideBuilding(B[i], x, z, margin));
  const regionAt = (x: number, z: number): Region => {
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          for (const i of grid.get(`${Math.floor(x / CELL) + di},${Math.floor(z / CELL) + dj}`) ?? []) {
            const d = (B[i].x - x) ** 2 + (B[i].z - z) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
    }
    return best >= 0 ? streetPlans[best].region : 'nyc';
  };

  // Every district's exclusions and openings: where buildings may not stand or the frontage was opened.
  const pad = 200;
  const keepOut = new PolygonIndex<{ polygon: Vec2[] }>(minX - pad, minZ - pad, maxX + pad, maxZ + pad);
  for (const b of world.districts.builds) {
    for (const p of b.exclusions) if (p.length >= 3) keepOut.add({ polygon: p });
    for (const p of b.openings) if (p.length >= 3) keepOut.add({ polygon: p });
  }

  // The hilltop lookout's terrace (render/districts/hillLookout.ts) stays clear; walls are the city's own
  // (the menu city and every race on it get the same backlots).
  const lookout = lookoutSite(world);
  const clearance = cityWallClearance(world);
  /** Whether a point may carry a backlot: plain block ground, inside the block, away from everything a car meets. */
  const free = (ring: Vec2[], x: number, z: number): boolean => {
    if (!pointInPolygon(x, z, ring) || distToPolygonEdge(x, z, ring) < BACKLOT.back) return false;
    if (lookout && Math.hypot(x - lookout.x, z - lookout.z) < lookout.r + 3) return false;
    const a = world.areaAt(x, z);
    if (!a || (a.kind !== 'downtown' && a.kind !== 'hills')) return false;
    if (keepOut.first(x, z)) return false;
    if (built(x, z, BACKLOT.gap)) return false;
    return clearance(x, z, BACKLOT.clear + 0.5) >= BACKLOT.clear;
  };

  const faces = world.areas.filter((a) => a.kind === 'downtown' || a.kind === 'hills').flatMap((a) => a.faces);
  for (const fid of [...new Set(faces)].sort((p, q) => p - q)) {
    const ring = world.blocks.faces[fid]?.ring;
    if (!ring || ring.length < 3) continue;
    const rng = new Rng(deriveSeed(world.seed, `backlots:${fid}`));
    // The block's frame: along its longest side.
    let ux = 1;
    let uz = 0;
    let longest = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const l = Math.hypot(q.x - p.x, q.z - p.z);
      if (l > longest) {
        longest = l;
        ux = (q.x - p.x) / l;
        uz = (q.z - p.z) / l;
      }
    }
    const vx = -uz;
    const vz = ux;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of ring) {
      const u = p.x * ux + p.z * uz;
      const v = p.x * vx + p.z * vz;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const C = BACKLOT.cell;
    const nu = Math.max(0, Math.floor((u1 - u0) / C));
    const nv = Math.max(0, Math.floor((v1 - v0) / C));
    if (nu < 3 || nv < 3) continue;
    const at = (i: number, j: number) => {
      const u = u0 + (i + 0.5) * C;
      const v = v0 + (j + 0.5) * C;
      return { x: ux * u + vx * v, z: uz * u + vz * v };
    };
    const cells = new Uint8Array(nu * nv);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p = at(i, j);
        cells[j * nu + i] = free(ring, p.x, p.z) ? 1 : 0;
      }
    }
    const minCells = Math.ceil(BACKLOT.min / C);
    const rowFree = (j: number, i0: number, i1: number) => {
      for (let i = i0; i < i1; i++) if (!cells[j * nu + i]) return false;
      return true;
    };
    // Greedy: from each free cell in scan order, the widest run along u (capped), then as deep as it stays free.
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        if (!cells[j * nu + i]) continue;
        const capU = Math.round(rng.range(BACKLOT.max[0], BACKLOT.max[1]) / C);
        const capV = Math.round(rng.range(BACKLOT.max[0], BACKLOT.max[1]) / C);
        let i1 = i;
        while (i1 < nu && i1 - i < capU && cells[j * nu + i1]) i1++;
        let j1 = j + 1;
        while (j1 < nv && j1 - j < capV && rowFree(j1, i, i1)) j1++;
        const wCells = i1 - i;
        const dCells = j1 - j;
        if (wCells < minCells || dCells < minCells) {
          cells[j * nu + i] = 0;
          continue;
        }
        // The footprint reaches only a little past its outer cells' centers, and its corners must pass the
        // same test (a cell center can be free where the cell's corner is not).
        const w = (wCells - 1) * C + 1;
        const d = (dCells - 1) * C + 1;
        const cu = u0 + ((i + i1) / 2) * C;
        const cv = v0 + ((j + j1) / 2) * C;
        const x = ux * cu + vx * cv;
        const z = uz * cu + vz * cv;
        const corner = (a: number, b: number) => ({ x: x + (ux * a * w + vx * b * d) / 2, z: z + (uz * a * w + vz * b * d) / 2 });
        if (![corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].every((p) => free(ring, p.x, p.z))) {
          cells[j * nu + i] = 0;
          continue;
        }
        // Claim it, with a cell of yard around it so neighbours stand apart.
        for (let jj = Math.max(0, j - 1); jj < Math.min(nv, j1 + 1); jj++) for (let ii = Math.max(0, i - 1); ii < Math.min(nu, i1 + 1); ii++) cells[jj * nu + ii] = 0;
        // Lowest corner, as the street buildings sit.
        let baseY = Infinity;
        for (const [a, b] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]) {
          const p = corner(a, b);
          baseY = Math.min(baseY, world.heightAt(p.x, p.z));
        }
        const f = downtown(x, z);
        const floors = rng.int(BACKLOT.floors[0], BACKLOT.floors[1]) + Math.round(BACKLOT.floorsCenter * f * rng.next());
        const h = floors * FLOOR;
        const region = regionAt(x, z);
        const seed = rng.int(0, 0x7fffffff);
        out.buildings.push({ x, z, yaw: -Math.atan2(uz, ux), w, d, h, baseY: baseY - 0.6, style: 0, seed, edge: -1 });
        out.plans.push({ style: styleFor(region, h, rng), region, h, flush: 0, signed: false, landmark: false, seed });
      }
    }
  }
  return out;
}
