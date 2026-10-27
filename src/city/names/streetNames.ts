/**
 * Street names, so the blades at the junctions (render/street/placeSigns.ts) call every street the
 * same thing along its whole length. A "street" here is what a driver would call one: a grid row or
 * column, or a diagonal, through every block it crosses (the graph breaks it into one chain per block
 * and many edges per chain, `RoadEdge.chain`, so the grid junctions it passes are what tie the pieces
 * together). Boulevards, avenues and diagonals get names of their own ("Kessler Boulevard", "Vance
 * Parkway"); the ordinary streets running north to south are numbered ("3rd St") and the ones running
 * east to west take a stem ("Pike St"), the way a real grid is.
 *
 * The stems are drawn from the area names' pool (placeNames.ts STEMS) minus every word a place or a
 * neighbourhood already carries, so no street shares a name with a park, an alley or a district, from
 * its own stream (`deriveSeed(seed, 'streetNames')`). Pure: it reads the graph and the area names and
 * writes nothing, so no replay notices.
 */
import type { World } from '../world';
import { isBendNode, type RoadEdge, type RoadKind } from '../roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import { STEMS, areaNames } from './placeNames';
import { hoodPlan } from './neighbourhoods';

/** The kinds that make up the named grid. */
type StreetKind = Extract<RoadKind, 'boulevard' | 'avenue' | 'diagonal' | 'street'>;

export interface Street {
  /** Index in StreetNames.streets. */
  id: number;
  kind: StreetKind;
  /** Full name ("Kessler Boulevard", "3rd St"). */
  name: string;
  /** The name as a blade prints it, abbreviated ("Kessler Blvd"). */
  blade: string;
  /** Its graph edges. */
  edges: number[];
}

export interface StreetNames {
  streets: Street[];
  /** Street of each graph edge by edge id (-1: alleys, ramps, the river and anything the district modules added). */
  ofEdge: Int32Array;
  /** The streets through a junction, the biggest first (empty for a bend or a node no street runs through). */
  at(node: number): Street[];
}

/** How a street kind is written in full and on a blade, and how many forms a seed may draw from. */
const FORMS: Record<Exclude<StreetKind, 'street'>, readonly (readonly [string, string])[]> = {
  boulevard: [['Boulevard', 'Blvd']],
  avenue: [['Avenue', 'Ave']],
  diagonal: [['Parkway', 'Pkwy'], ['Diagonal', 'Diag'], ['Way', 'Way']],
};

/** Class rank for sorting the streets at a junction: the biggest on top of the pole. */
const RANK: Record<StreetKind, number> = { boulevard: 0, avenue: 1, diagonal: 2, street: 3 };

const STREET_KINDS: ReadonlySet<RoadKind> = new Set(['boulevard', 'avenue', 'diagonal', 'street']);

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const t = n % 100;
  const s = t >= 11 && t <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${s}`;
}

const books = new WeakMap<World, StreetNames>();

/** The world's street names, drawn on first use. */
export function streetNames(world: World): StreetNames {
  let b = books.get(world);
  if (!b) books.set(world, (b = nameStreets(world)));
  return b;
}

/** One block-long piece of a grid street (all the edges sharing a `chain` id) and where it sits on the grid. */
interface Piece {
  kind: StreetKind;
  edges: number[];
  /** Grid junctions at its ends (RoadNode.gi / gj >= 0): the street's address. */
  grid: number[];
}

function nameStreets(world: World): StreetNames {
  const g = world.graph;
  // Pieces by chain id.
  const pieces = new Map<number, Piece>();
  for (const e of g.edges) {
    if (e.chain === undefined || e.shortcut || !STREET_KINDS.has(e.kind)) continue;
    let p = pieces.get(e.chain);
    if (!p) pieces.set(e.chain, (p = { kind: e.kind as StreetKind, edges: [], grid: [] }));
    p.edges.push(e.id);
    for (const n of [e.a, e.b]) if (g.nodes[n].gi >= 0 && !p.grid.includes(n)) p.grid.push(n);
  }
  // A street key per piece: row j, column i, or a diagonal (pieces sharing a grid junction on the same slope are one diagonal).
  const keyOf = new Map<Piece, string>();
  const diagonals: Piece[] = [];
  const slope = (p: Piece): number => {
    if (p.grid.length >= 2) return Math.sign((g.nodes[p.grid[1]].gi - g.nodes[p.grid[0]].gi) * (g.nodes[p.grid[1]].gj - g.nodes[p.grid[0]].gj)) || 1;
    const e = g.edges[p.edges[0]];
    return Math.sign((g.nodes[e.b].x - g.nodes[e.a].x) * (g.nodes[e.b].z - g.nodes[e.a].z)) || 1;
  };
  for (const p of pieces.values()) {
    if (!p.grid.length) continue;
    if (p.kind === 'diagonal') {
      diagonals.push(p);
      continue;
    }
    const e = g.edges[p.edges[0]];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const row = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
    const n = g.nodes[p.grid[0]];
    keyOf.set(p, row ? `r${n.gj}` : `c${n.gi}`);
  }
  const parent = diagonals.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < diagonals.length; i++) {
    for (let j = i + 1; j < diagonals.length; j++) {
      if (slope(diagonals[i]) === slope(diagonals[j]) && diagonals[i].grid.some((n) => diagonals[j].grid.includes(n))) parent[find(j)] = find(i);
    }
  }
  diagonals.forEach((p, i) => keyOf.set(p, `d${find(i)}`));

  // Group the pieces into streets, in a fixed order (boulevards, avenues, diagonals, then the rest by key).
  const groups = new Map<string, Piece[]>();
  for (const [p, key] of keyOf) (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
  const keys = [...groups.keys()].sort((a, b) => {
    const ka = groups.get(a)![0].kind;
    const kb = groups.get(b)![0].kind;
    return RANK[ka] - RANK[kb] || (a < b ? -1 : a > b ? 1 : 0);
  });

  // Stems no place or neighbourhood has taken.
  const words = new Set<string>();
  for (const n of areaNames(world).values()) for (const w of n.split(/[\s-]+/)) words.add(w.toLowerCase());
  for (const h of hoodPlan(world).hoods) for (const w of h.name.split(/[\s-]+/)) words.add(w.toLowerCase());
  const rng = new Rng(deriveSeed(world.seed, 'streetNames'));
  const stems = rng.shuffle(STEMS.slice()).filter((s) => !words.has(s.toLowerCase()));
  let next = 0;
  const stem = (): string => stems[next++] ?? `Route ${next}`;

  const streets: Street[] = [];
  const ofEdge = new Int32Array(g.edges.length).fill(-1);
  for (const key of keys) {
    const ps = groups.get(key)!;
    const kind = ps[0].kind;
    let name: string;
    let blade: string;
    if (kind === 'street') {
      if (key[0] === 'c') {
        name = `${ordinal(Number(key.slice(1)) + 1)} St`;
        blade = name;
      } else {
        name = blade = `${stem()} St`;
      }
    } else {
      const [full, short] = FORMS[kind][rng.int(0, FORMS[kind].length - 1)];
      const s = stem();
      name = `${s} ${full}`;
      blade = `${s} ${short}`;
    }
    const street: Street = { id: streets.length, kind, name, blade, edges: ps.flatMap((p) => p.edges) };
    for (const e of street.edges) ofEdge[e] = street.id;
    streets.push(street);
  }

  const byNode = new Map<number, Street[]>();
  const through = (node: number): Street[] => {
    let list = byNode.get(node);
    if (!list) {
      list = [];
      if (!isBendNode(g, node)) {
        for (const eid of g.nodes[node].edges) {
          const s = ofEdge[eid] >= 0 ? streets[ofEdge[eid]] : null;
          if (s && !list.includes(s)) list.push(s);
        }
        list.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.id - b.id);
      }
      byNode.set(node, list);
    }
    return list;
  };
  return { streets, ofEdge, at: through };
}

/** The edge's street name, or null for an unnamed way (an alley, a ramp, the channel). */
export function edgeStreet(names: StreetNames, e: RoadEdge): Street | null {
  return names.ofEdge[e.id] >= 0 ? names.streets[names.ofEdge[e.id]] : null;
}
