/**
 * The city's neighbourhoods: its blocks grouped into a handful of named parts
 * (placeNames.ts names them), so the plain streets between the districts are
 * somewhere ("Ironside", not "Downtown") on the full map, its card and the
 * free roam chip. Decided render side from the finished world (seeded by the
 * world's seed, never touching it), so no replay notices.
 *
 * Seeds are spread over the blocks (farthest point, then a few Lloyd steps
 * toward their parts' middles) and grow out across the block adjacency
 * graph, nearest first. Crossing a street costs the distance between the
 * blocks' middles, more over a big street and much more over the channel, less
 * through an alley, so borders settle on the avenues and the channel the way
 * real neighbourhood lines do and a part never splits in two. A border is
 * then the street centerlines between blocks of different parts.
 */
import type { World } from '../world';
import type { BlockFace } from '../blocks';
import type { Area } from '../districts/types';
import { isChannelEdge, type RoadEdge } from '../roadGraph';
import { pointInPolygon, polygonArea, polygonCentroid } from '../districts/geom';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Vec2 } from '../../sim/math';

/** Sizing and border costs. Areas in m^2, lengths in m. */
const HOOD = {
  /** About one neighbourhood per this much block area, within count. */
  area: 190_000,
  count: [5, 9],
  /** Lloyd steps after the farthest point spread. */
  relax: 3,
  /** Extra cost of growing over a street by kind: borders like big streets and the channel, not alleys. */
  boulevard: 260,
  avenue: 140,
  diagonal: 140,
  channel: 900,
  /** Alleys and back alleys run inside what reads as one block: crossing one costs this share of the distance. */
  alleyShare: 0.35,
} as const;

/** What a neighbourhood is like, which picks the pool its name comes from: the middle, by the channel, the lake or the harbor, up high, or none of those. */
export type HoodCharacter = 'core' | 'channel' | 'lake' | 'harbor' | 'heights' | 'town';

export interface Neighbourhood {
  id: number;
  /** Its name (placeNames.ts fills it in). */
  name: string;
  character: HoodCharacter;
  /** Its blocks (CityBlocks.faces ids). */
  faces: number[];
  /** Where its name goes first (m): its block nearest its middle; then the next nearest, for a view that cuts it off. */
  anchors: Vec2[];
  /** Its bounds (m), framed by a fly-to. */
  span: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** The streets around it (graph edge ids): between its blocks and anyone else's, or the city's edge. */
  rim: number[];
}

export interface HoodPlan {
  hoods: Neighbourhood[];
  /** Neighbourhood of each block face by face id (-1 for the outer face). */
  faceHood: Int16Array;
  /** Streets between two neighbourhoods (graph edge ids): the borders drawn on the map. */
  borders: number[];
  /** Neighbourhood a street belongs to (the lower id on a border, so a street never flips along its length). */
  edgeHood: Int16Array;
}

const plans = new WeakMap<World, HoodPlan>();

/** The world's neighbourhoods, planned on first use (a few ms) and shared by everything that names a place. */
export function hoodPlan(world: World): HoodPlan {
  let p = plans.get(world);
  if (!p) plans.set(world, (p = plan(world)));
  return p;
}

/** Trailing words a neighbourhood's stem drops ("Summit Heights" is Summit), as a shop or a street says where it is without the whole name. */
const STEM_TAILS = new Set(['Heights', 'Row', 'Ward', 'Flats', 'Yards', 'Point', 'Quarter', 'Mile', 'Terrace', 'Center', 'City', 'Hollow', 'Landing', 'District']);

/** The word a neighbourhood goes by on shop signs and billboards: its name without a leading The or Little and a generic tail ("Riverside", "Summit", "Lisbon"). */
export function hoodStem(name: string): string {
  let w = name.split(' ').filter(Boolean);
  if (w.length > 1 && (w[0] === 'The' || w[0] === 'Little')) w = w.slice(1);
  if (w.length > 1 && STEM_TAILS.has(w[w.length - 1])) w = w.slice(0, -1);
  return w.join(' ');
}

/** The neighbourhood at a world point: the block's under it, else the nearest street's. */
export function hoodAt(world: World, x: number, z: number, area: Area | null = world.areaAt(x, z)): Neighbourhood {
  const p = hoodPlan(world);
  if (area && area.faces.length) {
    const h = p.faceHood[area.faces[0]];
    if (h >= 0) return p.hoods[h];
  }
  const g = world.graph;
  let best = -1;
  let bestD = Infinity;
  for (const e of g.edges) {
    if (p.edgeHood[e.id] < 0) continue;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const dx = B.x - A.x;
    const dz = B.z - A.z;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / l2));
    const d = (A.x + dx * t - x) ** 2 + (A.z + dz * t - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = e.id;
    }
  }
  return p.hoods[best >= 0 ? p.edgeHood[best] : 0];
}

/** The neighbourhood an area lies in: its first block's, else the one under its middle. */
export function hoodOf(world: World, a: Area): Neighbourhood {
  const pts = a.polygon.length >= 3 ? a.polygon : a.path;
  const c = a.polygon.length >= 3 ? polygonCentroid(a.polygon) : (pts[pts.length >> 1] ?? { x: 0, z: 0 });
  return hoodAt(world, c.x, c.z, a.faces.length ? a : null);
}

function plan(world: World): HoodPlan {
  const g = world.graph;
  const all = world.blocks.faces;
  const inner = all.filter((f) => !f.outer);
  const faceHood = new Int16Array(all.length).fill(-1);
  const edgeHood = new Int16Array(g.edges.length).fill(-1);
  if (!inner.length) return { hoods: [], faceHood, borders: [], edgeHood };
  const mid = inner.map((f) => (f.ring.length >= 3 ? polygonCentroid(f.ring) : f.ring[0]));
  const size = inner.map((f) => f.area || Math.abs(polygonArea(f.ring)));
  const index = new Map<number, number>(inner.map((f, i) => [f.id, i]));

  // The block adjacency graph: two blocks either side of a street.
  const sides = new Map<number, number[]>();
  for (const f of all) for (const e of f.edges) (sides.get(e) ?? sides.set(e, []).get(e)!).push(f.id);
  const links: { to: number; cost: number }[][] = inner.map(() => []);
  for (const [e, fs] of sides) {
    const ins = fs.map((f) => index.get(f)).filter((i): i is number => i !== undefined);
    if (ins.length < 2 || ins[0] === ins[1]) continue;
    const [i, j] = ins;
    const cost = Math.hypot(mid[i].x - mid[j].x, mid[i].z - mid[j].z) * (isAlley(g.edges[e]) ? HOOD.alleyShare : 1) + streetCost(g.edges[e]);
    links[i].push({ to: j, cost });
    links[j].push({ to: i, cost });
  }

  // Seeds: spread farthest first from a seeded start, with a little jitter so two seeds of a size differ.
  const rng = new Rng(deriveSeed(world.seed, 'neighbourhoods'));
  const total = size.reduce((s, a) => s + a, 0);
  const k = Math.max(HOOD.count[0], Math.min(HOOD.count[1], Math.round(total / HOOD.area), inner.length));
  const seeds = [rng.int(0, inner.length - 1)];
  while (seeds.length < k) {
    let best = 0;
    let bestD = -1;
    for (let i = 0; i < inner.length; i++) {
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, Math.hypot(mid[i].x - mid[s].x, mid[i].z - mid[s].z));
      d *= 0.85 + 0.3 * rng.next();
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    seeds.push(best);
  }
  let owner = grow(links, seeds);
  for (let step = 0; step < HOOD.relax; step++) {
    // Each seed moves to the block nearest its part's middle.
    for (let h = 0; h < seeds.length; h++) {
      const c = middle(mid, size, owner.reduce<number[]>((ids, o, i) => (o === h ? (ids.push(i), ids) : ids), []));
      if (!c) continue;
      let best = seeds[h];
      let bestD = Infinity;
      for (let i = 0; i < inner.length; i++) {
        if (owner[i] !== h) continue;
        const d = Math.hypot(mid[i].x - c.x, mid[i].z - c.z);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      seeds[h] = best;
    }
    owner = grow(links, seeds);
  }
  // Islands no street reaches (rare): the nearest seed's.
  for (let i = 0; i < inner.length; i++) {
    if (owner[i] >= 0) continue;
    let bestD = Infinity;
    for (let h = 0; h < seeds.length; h++) {
      const d = Math.hypot(mid[i].x - mid[seeds[h]].x, mid[i].z - mid[seeds[h]].z);
      if (d < bestD) {
        bestD = d;
        owner[i] = h;
      }
    }
  }
  // Parts numbered north to south, then east to west, so ids read like the map.
  const order = seeds.map((_, h) => h).sort((a, b) => mid[seeds[b]].z - mid[seeds[a]].z || mid[seeds[b]].x - mid[seeds[a]].x);
  const renumber = new Int16Array(seeds.length);
  order.forEach((h, n) => (renumber[h] = n));
  for (let i = 0; i < inner.length; i++) faceHood[inner[i].id] = renumber[owner[i]];

  const hoods: Neighbourhood[] = order.map((_, id) => ({ id, name: '', character: 'town', faces: [], anchors: [], span: { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }, rim: [] }));
  for (const f of inner) {
    const hd = hoods[faceHood[f.id]];
    hd.faces.push(f.id);
    for (const q of f.ring) {
      hd.span.minX = Math.min(hd.span.minX, q.x);
      hd.span.maxX = Math.max(hd.span.maxX, q.x);
      hd.span.minZ = Math.min(hd.span.minZ, q.z);
      hd.span.maxZ = Math.max(hd.span.maxZ, q.z);
    }
  }
  for (const hd of hoods) {
    const ids = hd.faces.map((f) => index.get(f)!);
    const c = middle(mid, size, ids) ?? mid[ids[0]];
    // Name spots: blocks big enough to hold a name, nearest the middle first.
    const big = ids.filter((i) => size[i] > 6000);
    hd.anchors = (big.length ? big : ids).sort((a, b) => Math.hypot(mid[a].x - c.x, mid[a].z - c.z) - Math.hypot(mid[b].x - c.x, mid[b].z - c.z)).map((i) => mid[i]);
  }

  // Borders and rims: a street between blocks of two parts, or between a part and the city's outside.
  const borders: number[] = [];
  for (const [e, fs] of sides) {
    const hs = [...new Set(fs.map((f) => faceHood[f]))];
    const own = hs.filter((h) => h >= 0);
    if (!own.length) continue;
    edgeHood[e] = Math.min(...own);
    if (hs.length > 1) for (const h of own) hoods[h].rim.push(e);
    if (own.length > 1) borders.push(e);
  }
  // Streets no block touches (district links, bridges' ramps): the nearer end's.
  for (const e of g.edges) {
    if (edgeHood[e.id] >= 0) continue;
    for (const n of [e.a, e.b]) for (const o of g.edges) if (edgeHood[o.id] >= 0 && (o.a === n || o.b === n)) edgeHood[e.id] = edgeHood[o.id];
  }

  characterize(world, hoods, inner, mid, faceHood, sides);
  return { hoods, faceHood, borders, edgeHood };
}

const isAlley = (e: RoadEdge) => e.kind === 'alley' || e.kind === 'backAlley';

function streetCost(e: RoadEdge): number {
  if (isChannelEdge(e) || e.bridge) return HOOD.channel;
  return e.kind === 'boulevard' ? HOOD.boulevard : e.kind === 'avenue' ? HOOD.avenue : e.kind === 'diagonal' ? HOOD.diagonal : 0;
}

/** Multi-source Dijkstra over the blocks: each block's nearest seed (by index), -1 where none reaches. */
function grow(links: { to: number; cost: number }[][], seeds: number[]): Int16Array {
  const n = links.length;
  const dist = new Float64Array(n).fill(Infinity);
  const owner = new Int16Array(n).fill(-1);
  const done = new Uint8Array(n);
  seeds.forEach((s, h) => {
    dist[s] = 0;
    owner[s] = h;
  });
  // A few dozen blocks: a linear scan beats a heap's bookkeeping.
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) break;
    done[u] = 1;
    for (const l of links[u]) {
      const d = dist[u] + l.cost;
      if (d < dist[l.to]) {
        dist[l.to] = d;
        owner[l.to] = owner[u];
      }
    }
  }
  return owner;
}

/** Area-weighted middle of some blocks (by index). */
function middle(mid: Vec2[], size: number[], ids: number[]): Vec2 | null {
  let x = 0;
  let z = 0;
  let w = 0;
  for (const i of ids) {
    x += mid[i].x * size[i];
    z += mid[i].z * size[i];
    w += size[i];
  }
  return w ? { x: x / w, z: z / w } : null;
}

/**
 * Core (the part nearest the city's middle); else by the water it has most blocks on (channel, lake, harbor); else
 * heights (in the hills or on the bluff); else town.
 */
function characterize(world: World, hoods: Neighbourhood[], inner: BlockFace[], mid: Vec2[], faceHood: Int16Array, sides: Map<number, number[]>): void {
  const g = world.graph;
  // Blocks per neighbourhood on each kind of ground.
  const on = { channel: new Map<number, number>(), lake: new Map<number, number>(), harbor: new Map<number, number>(), heights: new Map<number, number>() };
  const add = (m: Map<number, number>, h: number) => m.set(h, (m.get(h) ?? 0) + 1);
  for (const a of world.areas) {
    const m = a.kind === 'channel' ? on.channel : a.kind === 'lake' ? on.lake : a.kind === 'waterfront' ? on.harbor : a.kind === 'hills' || a.kind === 'bluff' ? on.heights : null;
    if (!m) continue;
    for (let i = 0; i < inner.length; i++) {
      if (a.faces.includes(inner[i].id) || (a.polygon.length >= 3 && pointInPolygon(mid[i].x, mid[i].z, a.polygon))) add(m, faceHood[inner[i].id]);
    }
  }
  for (const [e, fs] of sides) if (isChannelEdge(g.edges[e])) for (const f of fs) if (faceHood[f] >= 0) add(on.channel, faceHood[f]);
  const b = g.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  let core = 0;
  let coreD = Infinity;
  for (let i = 0; i < inner.length; i++) {
    const d = Math.hypot(mid[i].x - cx, mid[i].z - cz);
    if (d < coreD) {
      coreD = d;
      core = faceHood[inner[i].id];
    }
  }
  for (const hd of hoods) {
    const wet = (['harbor', 'lake', 'channel'] as const).map((k) => ({ k, n: on[k].get(hd.id) ?? 0 })).sort((a, b) => b.n - a.n)[0];
    hd.character = hd.id === core ? 'core' : wet.n ? wet.k : on.heights.has(hd.id) ? 'heights' : 'town';
  }
}
