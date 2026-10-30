/**
 * The city's home and its neighbourhood regions, sim side. Each seed has a home city (nyc, la, sf, philly or
 * miami; render/cityIdentity.ts sets its lamps, neon, weather lean and grade from it), and the map is a jittered
 * Voronoi grid of neighbourhood cells, each with a primary and a secondary region weighted by place: New York
 * toward downtown, San Francisco up the hills, Miami along the water, Los Angeles toward the sprawl at the edges,
 * Philadelphia in the ring between, the home weighing most in every cell.
 *
 * This used to live render side (buildings/architecture.ts), where only the facades and the lamps read it. It moved
 * here because the city now builds things by region that a car can hit: the San Francisco cable car
 * (districts/cableCar.ts) runs only on sf homes, and the power poles of the furniture pass (props.ts) stand in la
 * neighbourhoods. One function serves both sides, so a pole always stands in a neighbourhood the facades draw as
 * Los Angeles. Pure: the home is its own stream (deriveSeed(seed, 'identity'), the pick cityIdentity always made),
 * the cells the stream architecture.ts has always drawn them from, and nothing here reads more than the graph,
 * the district areas and the terrain, all of which exist before the street furniture is placed.
 */
import type { RoadGraph } from './roadGraph';
import { downtownFactor } from './roadGraph';
import type { Area } from './districts/types';
import { pointInPolygon } from './districts/geom';
import { Rng, deriveSeed } from '../sim/prng';
import { pow, sqrt } from '../sim/math';

export type Region = 'nyc' | 'la' | 'sf' | 'philly' | 'miami';

/** Every region, in the order the home pick and the cells' weights use. */
export const REGIONS: readonly Region[] = ['nyc', 'la', 'sf', 'philly', 'miami'];

export const REGION_CELLS = {
  /** Neighbourhood cell size (m) and center jitter (fraction of a cell). */
  cell: 210,
  jitter: 0.75,
  /** Water within this distance of a cell center favors Miami (m). */
  waterReach: 260,
  /** Cell weight multipliers for the seed's home region and for the other four. */
  home: 2.5,
  away: 0.6,
  /** Base weight of each region before place and home. */
  base: { nyc: 1, la: 0.9, sf: 0.85, philly: 0.9, miami: 0.8 },
} as const;

const homes = new Map<number, Region>();

/** The seed's home city: an even pick of the five on deriveSeed(seed, 'identity'). */
export function homeOf(seed: number): Region {
  let home = homes.get(seed);
  if (!home) {
    home = new Rng(deriveSeed(seed, 'identity')).pick(REGIONS);
    if (homes.size > 16) homes.clear();
    homes.set(seed, home);
  }
  return home;
}

/** One neighbourhood cell: its jittered center (m), its two regions and the weights they were drawn from. */
export interface RegionCell {
  x: number;
  z: number;
  primary: Region;
  secondary: Region;
  w: number[];
}

/** The two nearest cells to a point and how far the second is beyond the first (m). */
export interface CellHit {
  a: RegionCell;
  b: RegionCell;
  gap: number;
}

export interface RegionMap {
  cells: RegionCell[];
  /** The nearest two cells at a point. */
  cellAt(x: number, z: number): CellHit;
  /** The region of the cell a point is in (the primary of the nearest cell). */
  regionAt(x: number, z: number): Region;
}

function pickWeighted(rng: Rng, weights: number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * The neighbourhood cells of a city. `heightAt` is the terrain (district height mods folded in) and `areas` the
 * district areas (the hills and the water are read). Same inputs, same cells: architecture.ts and props.ts each
 * call it and agree.
 */
export function regionMap(seed: number, g: RoadGraph, areas: readonly Area[], heightAt: (x: number, z: number) => number): RegionMap {
  const R = REGION_CELLS;
  const rng = new Rng((seed ^ 0xa4c417) >>> 0 || 1);
  const bx = g.bounds;
  const home = homeOf(seed);

  // Terrain range over the city, for "up the hill".
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let x = bx.minX; x <= bx.maxX; x += 70) {
    for (let z = bx.minZ; z <= bx.maxZ; z += 70) {
      const h = heightAt(x, z);
      hMin = Math.min(hMin, h);
      hMax = Math.max(hMax, h);
    }
  }
  const hSpan = Math.max(1, hMax - hMin);
  const water: { x: number; z: number }[] = [];
  for (const a of areas) {
    if (a.kind !== 'channel' && a.kind !== 'lake' && a.kind !== 'waterfront') continue;
    const pts = a.path.length ? a.path : a.polygon;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 40))) water.push(pts[i]);
  }
  const nearWater = (x: number, z: number) => {
    let best = Infinity;
    for (const p of water) best = Math.min(best, sqrt((p.x - x) ** 2 + (p.z - z) ** 2));
    return best < R.waterReach ? 1 - best / R.waterReach : 0;
  };
  const hills = areas.filter((a) => a.kind === 'hills' && a.params.h > 0);

  // Jittered Voronoi neighbourhoods.
  const C = R.cell;
  const ox = bx.minX - C;
  const oz = bx.minZ - C;
  const nx = Math.ceil((bx.maxX - bx.minX) / C) + 3;
  const nz = Math.ceil((bx.maxZ - bx.minZ) / C) + 3;
  const cells: RegionCell[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = ox + (i + 0.5 + (rng.next() - 0.5) * R.jitter) * C;
      const z = oz + (j + 0.5 + (rng.next() - 0.5) * R.jitter) * C;
      const f = downtownFactor(g.plan, x, z);
      // "Up the hill": the city's own rolling ground counts for a little, a hills district's dome or ridge for everything.
      const onHill = hills.some((a) => pointInPolygon(x, z, a.polygon));
      const hill = onHill ? 1 : Math.max(0, Math.min(1, (heightAt(x, z) - hMin) / hSpan)) * 0.6;
      const wet = nearWater(x, z);
      const edge = 1 - f;
      const w = REGIONS.map((r) => {
        const b = R.base[r] * (r === home ? R.home : R.away);
        switch (r) {
          case 'nyc':
            return b * (0.55 + 2.2 * f);
          case 'la':
            return b * (0.35 + 1.3 * edge * edge);
          case 'sf':
            return b * (0.3 + 2.6 * pow(hill, 1.5)) * (onHill ? 1.8 : 1);
          case 'philly':
            return b * (0.55 + 1.0 * Math.max(0, 1 - Math.abs(f - 0.35) * 2.6));
          case 'miami':
            return b * (0.35 + 2.6 * wet + 0.35 * edge);
        }
      });
      const p = pickWeighted(rng, w);
      const w2 = w.slice();
      w2[p] = 0;
      const s = pickWeighted(rng, w2);
      cells.push({ x, z, primary: REGIONS[p], secondary: REGIONS[s], w });
    }
  }
  // Every region shows up somewhere: give a missing one to its strongest cell among repeated regions.
  for (let ri = 0; ri < REGIONS.length; ri++) {
    const r = REGIONS[ri];
    const inside = cells.filter((c) => c.x > bx.minX && c.x < bx.maxX && c.z > bx.minZ && c.z < bx.maxZ);
    if (inside.some((c) => c.primary === r)) continue;
    const counts = new Map<Region, number>();
    for (const c of inside) counts.set(c.primary, (counts.get(c.primary) ?? 0) + 1);
    let best: RegionCell | null = null;
    for (const c of inside) if ((counts.get(c.primary) ?? 0) > 1 && (!best || c.w[ri] > best.w[ri])) best = c;
    if (best) best.primary = r;
  }
  const cellAt = (x: number, z: number): CellHit => {
    const ci = Math.floor((x - ox) / C);
    const cj = Math.floor((z - oz) / C);
    let d1 = Infinity;
    let d2 = Infinity;
    let c1 = 0;
    let c2 = 0;
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
        const k = j * nx + i;
        const d = sqrt((cells[k].x - x) ** 2 + (cells[k].z - z) ** 2);
        if (d < d1) {
          d2 = d1;
          c2 = c1;
          d1 = d;
          c1 = k;
        } else if (d < d2) {
          d2 = d;
          c2 = k;
        }
      }
    }
    return { a: cells[c1], b: cells[c2], gap: d2 - d1 };
  };
  return { cells, cellAt, regionAt: (x, z) => cellAt(x, z).a.primary };
}
