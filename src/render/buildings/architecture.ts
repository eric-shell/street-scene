/**
 * Architecture plan: which style every building is built in, decided render
 * side from the city (positions, heights, terrain, water, signs) so replays
 * never notice.
 *
 * The city reads as a blend of five American cities. A jittered Voronoi grid
 * of neighbourhoods (cells about 210 m across) gives each cell a primary and
 * a secondary region, weighted by place: New York toward downtown, San
 * Francisco up the hills, Miami along the water, Los Angeles toward the
 * sprawl at the edges, Philadelphia in the ring between. The seed's home
 * (cityIdentity.ts) weighs most in every cell, so it covers most of the city
 * and the other four read as pockets. The cells are the city's own
 * (city/regions.ts), since the power poles and the cable car are placed by them. Buildings take their
 * cell's region (the neighbour's near a border, the secondary now and then, a
 * rare outlier anywhere), then a style from the region and their height:
 * brownstones and deco towers, Spanish revival and mid-century strips,
 * painted ladies, red brick rowhouses and mansards, pastel deco and white
 * condos, and glass towers everywhere downtown. Low rise terrace styles line
 * up along a block side at a shared cornice height and split into narrow
 * houses. Heights may move only where no neon sign would be left floating.
 */
import type { World } from '../../city/world';
import type { Building } from '../../city/blocks';
import { Rng } from '../../sim/prng';
import { REGIONS, regionMap, type Region } from '../../city/regions';
import type { FacadeLayer } from './facadeAtlas';
import { MODULE } from './facadeAtlas';
import type { GroundBay } from './facadeKit';
import { GROUND_H } from './facadeKit';

export type { Region };
export type StyleId = 'brownstone' | 'prewar' | 'deco' | 'glass' | 'spanish' | 'midcentury' | 'victorian' | 'rowhouse' | 'empire' | 'miamiDeco' | 'condo';

export interface StyleDef {
  /** Facade on the shaft; `side` on non-street faces of low rise (party walls). */
  layer: FacadeLayer;
  side?: FacadeLayer;
  /** Wall tints, sRGB hex. */
  palette: readonly number[];
  /** Indices into TRIM_COLORS / GLASS_COLORS (facadeMaterial.ts). */
  trims: readonly number[];
  glass: readonly number[];
  /** Window lit density range (fraction of windows, or of floors for offices). */
  lit: readonly [number, number];
  /** Chance the building lights by whole floors (offices). */
  office: number;
  /** Upper floors from the facade kit above its ground floor (0 = ground floor only). */
  kitFloors: readonly [number, number];
  /** Ground floor variants on street faces. */
  ground: readonly GroundBay[];
  /** Terrace houses: a building splits into houses of this width range (m). */
  units?: readonly [number, number];
}

export const STYLES: Record<StyleId, StyleDef> = {
  brownstone: {
    layer: 'brick',
    side: 'blank',
    palette: [0x7a4a3a, 0x6b3f33, 0x8a5a44, 0x5e3a30, 0x9a6a50, 0x704838, 0x84503c],
    trims: [1, 2, 4, 0, 3],
    glass: [0, 5, 8],
    lit: [0.22, 0.45],
    office: 0,
    kitFloors: [0, 0],
    ground: ['bodega', 'shopWarm', 'shopCool', 'neonShop', 'shutter', 'restaurant', 'bodega', 'stoop'],
    units: [7, 11],
  },
  prewar: {
    layer: 'brick',
    side: 'blank',
    palette: [0xb8a080, 0xa88c6a, 0xc8b090, 0x9a7a5a, 0xd0b898, 0xb09070],
    trims: [1, 2, 0, 12],
    glass: [0, 5, 8, 11],
    lit: [0.25, 0.5],
    office: 0.35,
    kitFloors: [0, 1],
    ground: ['shopWarm', 'shopCool', 'lobby', 'arch', 'restaurant', 'bodega'],
  },
  deco: {
    layer: 'deco',
    palette: [0xd8ccb4, 0xc8b898, 0xe0d4bc, 0xb8a888, 0xcfc0a0, 0xd0c8c0],
    trims: [13, 1, 4, 3, 2],
    glass: [0, 1, 8, 12],
    lit: [0.2, 0.5],
    office: 0.6,
    kitFloors: [1, 2],
    ground: ['lobby', 'arch', 'shopCool', 'neonShop', 'lobby'],
  },
  glass: {
    layer: 'glass',
    palette: [0x3a4450, 0x2a3038, 0x5a6470, 0x202428, 0x484040],
    trims: [5, 4, 12, 13, 14],
    glass: [1, 2, 3, 4, 6, 10, 12, 13],
    lit: [0.16, 0.5],
    office: 0.85,
    kitFloors: [1, 3],
    ground: ['lobby', 'shopCool', 'neonShop', 'lobby'],
  },
  spanish: {
    layer: 'stuccoArch',
    palette: [0xf0e4cc, 0xe8cfa8, 0xf4ece0, 0xe0c090, 0xf0d8c0, 0xead6b8],
    trims: [3, 10, 1, 9],
    glass: [0, 5, 8],
    lit: [0.2, 0.42],
    office: 0,
    kitFloors: [0, 0],
    ground: ['arcade', 'shopWarm', 'restaurant', 'arcade'],
  },
  midcentury: {
    layer: 'ribbon',
    palette: [0xe8e4dc, 0xd8e0e0, 0xf0e0c8, 0xc8d8d0, 0xe8d0c8, 0xd0d8e8],
    trims: [0, 4, 12, 15],
    glass: [1, 6, 10, 11],
    lit: [0.22, 0.48],
    office: 0.3,
    kitFloors: [0, 0],
    ground: ['shopCool', 'neonShop', 'shopWarm', 'restaurant', 'decoShop'],
  },
  victorian: {
    layer: 'victorian',
    palette: [0xb8d8e8, 0xe8c8d8, 0xd8e8c0, 0xf0e0a8, 0xd0c0e8, 0xf0c8a0, 0x9ab8a8, 0xc8e0e0, 0xe8b8b0, 0xa8c0e0],
    trims: [0, 0, 15, 1, 9, 10],
    glass: [0, 5, 8],
    lit: [0.22, 0.45],
    office: 0,
    kitFloors: [0, 0],
    ground: ['garage', 'stoop', 'garage'],
    units: [6, 8.5],
  },
  rowhouse: {
    layer: 'brick',
    side: 'blank',
    palette: [0x9a3a2a, 0x8a3428, 0xa84a34, 0x7a3022, 0xb05a40, 0x94402e],
    trims: [0, 15, 1],
    glass: [0, 5, 8],
    lit: [0.2, 0.42],
    office: 0,
    kitFloors: [0, 0],
    ground: ['stoop', 'stoop', 'stoop', 'shopWarm', 'bodega'],
    units: [5.5, 7.5],
  },
  empire: {
    layer: 'stone',
    palette: [0xc8c0b0, 0xb0aaa0, 0xd8d0c0, 0xa8a090, 0xc0b8a8],
    trims: [0, 1, 2],
    glass: [0, 5, 8],
    lit: [0.24, 0.48],
    office: 0.4,
    kitFloors: [0, 1],
    ground: ['arch', 'masonry', 'lobby', 'shopWarm'],
  },
  miamiDeco: {
    layer: 'miami',
    palette: [0xffc8d8, 0xb8f0e0, 0xc0e0ff, 0xfff0a8, 0xe0c8ff, 0xffd8b0, 0xa8e8f0, 0xffffff, 0xf8d0f0],
    trims: [0, 6, 7, 8, 11, 15, 14],
    glass: [6, 2, 10, 0],
    lit: [0.25, 0.5],
    office: 0,
    kitFloors: [0, 0],
    ground: ['decoShop', 'restaurant', 'arcade', 'neonShop', 'decoShop'],
  },
  condo: {
    layer: 'condo',
    palette: [0xf0f0ec, 0xe8ecf0, 0xf4f0e8, 0xdde4e8, 0xece4dc],
    trims: [15, 5, 0],
    glass: [6, 1, 2, 10, 12],
    lit: [0.25, 0.5],
    office: 0.05,
    kitFloors: [1, 2],
    ground: ['lobby', 'shopCool', 'decoShop'],
  },
};

/** Per building decisions; geometry details are diced in buildings.ts from `seed`. */
export interface BuildingPlan {
  style: StyleId;
  region: Region;
  /** Visual height above baseY (m), floor aligned later by the mesher. */
  h: number;
  /** The shaft keeps its full footprint up to here (m above baseY): neon signs hang there. */
  flush: number;
  /** A neon sign is mounted on this building (keep its front corners square). */
  signed: boolean;
  /** Tallest building of its style downtown: gets the landmark crown. */
  landmark: boolean;
  seed: number;
}

export const ARCH = {
  /** Near a cell border (difference of the two nearest center distances, m) buildings may take the neighbour's region. */
  blend: 46,
  /** Chance to take the cell's secondary region, or any region at all. */
  secondary: 0.13,
  outlier: 0.03,
} as const;

/** Style for a region and height (m). */
export function styleFor(region: Region, h: number, rng: Rng): StyleId {
  const r = rng.next();
  switch (region) {
    case 'nyc':
      return h <= 22 ? 'brownstone' : h <= 52 ? (r < 0.68 ? 'prewar' : 'deco') : r < 0.55 ? 'deco' : 'glass';
    case 'la':
      return h <= 12.5 ? (r < 0.6 ? 'spanish' : 'midcentury') : h <= 24 ? (r < 0.66 ? 'midcentury' : 'spanish') : h <= 40 ? (r < 0.4 ? 'midcentury' : 'glass') : 'glass';
    case 'sf':
      return h <= 18 ? 'victorian' : h <= 34 ? (r < 0.55 ? 'prewar' : 'glass') : r < 0.2 ? 'deco' : 'glass';
    case 'philly':
      return h <= 14 ? 'rowhouse' : h <= 30 ? (r < 0.5 ? 'empire' : 'brownstone') : h <= 60 ? (r < 0.6 ? 'prewar' : 'deco') : 'glass';
    case 'miami':
      return h <= 22 ? 'miamiDeco' : h <= 36 ? (r < 0.4 ? 'miamiDeco' : 'condo') : r < 0.72 ? 'condo' : 'glass';
  }
}

/** Low rise styles that may be pulled down to a terrace height (m above baseY, cap). */
const TERRACE_CAP: Partial<Record<StyleId, number>> = { rowhouse: 13.2, victorian: 18.6, brownstone: 22.2 };

/** One plan per world: the buildings, the boundary walls and the backlots all read it (callers never mutate it). */
const planned = new WeakMap<World, BuildingPlan[]>();

export function planArchitecture(world: World): BuildingPlan[] {
  let plans = planned.get(world);
  if (!plans) planned.set(world, (plans = planOnce(world)));
  return plans;
}

/** The neighbourhood lookup of each planned world (the Voronoi cell's own region, without the per building blend). */
const regionLookups = new WeakMap<World, (x: number, z: number) => Region>();

/** The region of the neighbourhood cell at a point: street furniture (lamp posts and their colour) follows it. */
export function regionAt(world: World): (x: number, z: number) => Region {
  planArchitecture(world);
  return regionLookups.get(world)!;
}

function planOnce(world: World): BuildingPlan[] {
  const B = world.blocks.buildings;
  const g = world.graph;
  // The neighbourhood cells are the city's (city/regions.ts): the poles and the cable car are placed by the same map.
  const { cellAt, regionAt: lookup } = regionMap(world.seed, g, world.areas, (x, z) => world.heightAt(x, z));
  regionLookups.set(world, lookup);

  // Signs: the shaft stays flush up to their tops.
  const flush = new Float64Array(B.length);
  const signed = new Uint8Array(B.length);
  for (const s of world.blocks.signs) {
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (Math.abs(b.x - s.x) > 40 || Math.abs(b.z - s.z) > 40) continue;
      const ux = Math.cos(b.yaw);
      const uz = -Math.sin(b.yaw);
      const dx = s.x - b.x;
      const dz = s.z - b.z;
      const lx = dx * ux + dz * uz;
      const lz = dx * Math.sin(b.yaw) + dz * Math.cos(b.yaw);
      if (Math.abs(lx) > b.w / 2 + 0.6 || Math.abs(lz) > b.d / 2 + 0.8) continue;
      flush[i] = Math.max(flush[i], s.y + s.h / 2 - b.baseY + 1.2);
      signed[i] = 1;
    }
  }

  const plans: BuildingPlan[] = B.map((b, i) => {
    const br = new Rng((b.seed ^ 0x51ab1e) >>> 0 || 1);
    const cell = cellAt(b.x, b.z);
    let region = cell.a.primary;
    const u = br.next();
    if (cell.gap < ARCH.blend && u < 0.5 * (1 - cell.gap / ARCH.blend)) region = cell.b.primary;
    else if (br.chance(ARCH.secondary)) region = cell.a.secondary;
    else if (br.chance(ARCH.outlier)) region = REGIONS[br.int(0, REGIONS.length - 1)];
    let h = b.h;
    // Philly and SF neighbourhoods pull mid height buildings down into their terraces now and then.
    if (region === 'philly' && h <= 18 && br.chance(0.55)) h = Math.min(h, TERRACE_CAP.rowhouse!);
    if (region === 'sf' && h <= 24 && br.chance(0.5)) h = Math.min(h, TERRACE_CAP.victorian!);
    h = Math.max(h, flush[i]);
    return { style: styleFor(region, h, br), region, h, flush: flush[i], signed: signed[i] === 1, landmark: false, seed: b.seed };
  });

  // Terraces: consecutive low rise buildings on one block side share a style and a cornice line.
  const runs = new Map<string, number[]>();
  B.forEach((b, i) => {
    if (!STYLES[plans[i].style].units) return;
    const e = g.edges[b.edge];
    const a = g.nodes[e.a];
    const c = g.nodes[e.b];
    const side = (c.x - a.x) * (b.z - a.z) - (c.z - a.z) * (b.x - a.x) > 0 ? 1 : 0;
    const key = `${b.edge}:${side}`;
    const list = runs.get(key);
    if (list) list.push(i);
    else runs.set(key, [i]);
  });
  for (const list of runs.values()) {
    if (list.length < 2) continue;
    const e = g.edges[B[list[0]].edge];
    const a = g.nodes[e.a];
    const c = g.nodes[e.b];
    const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
    const along = (b: Building) => ((b.x - a.x) * (c.x - a.x) + (b.z - a.z) * (c.z - a.z)) / len;
    list.sort((p, q) => along(B[p]) - along(B[q]));
    let start = 0;
    for (let k = 1; k <= list.length; k++) {
      const prev = list[k - 1];
      const cur = list[k];
      const joined =
        k < list.length &&
        plans[cur].region === plans[prev].region &&
        along(B[cur]) - B[cur].w / 2 - (along(B[prev]) + B[prev].w / 2) < 3.5;
      if (joined) continue;
      if (k - start >= 2) {
        const members = list.slice(start, k);
        const style = plans[members[0]].style;
        const hs = members.map((m) => plans[m].h).sort((p, q) => p - q);
        const shared = Math.min(TERRACE_CAP[style] ?? Infinity, hs[hs.length >> 1]);
        for (const m of members) {
          plans[m].style = style;
          plans[m].h = Math.max(shared, plans[m].flush, GROUND_H + MODULE[STYLES[style].layer].floor);
        }
      }
      start = k;
    }
  }

  // Landmarks: the tallest deco and the tallest glass tower get the big crowns.
  for (const style of ['deco', 'glass'] as StyleId[]) {
    let best = -1;
    plans.forEach((p, i) => {
      if (p.style === style && (best < 0 || p.h > plans[best].h)) best = i;
    });
    if (best >= 0 && plans[best].h > 60) plans[best].landmark = true;
  }
  return plans;
}
