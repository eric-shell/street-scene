/**
 * Procedural road network, laid out from the seed's CityPlan (cityPlan: grid
 * size and spacing, where downtown sits, how many boulevards, avenues and
 * diagonals, a superblock, how many streets go): a jittered grid with some
 * edges removed, diagonal avenues and wide boulevards, the whole grid then warped by a
 * smooth field (CITY.warp) so streets sweep and junction angles vary, and every
 * grid street cut into CITY.bendSegments straight pieces through degree-2 bend
 * nodes that lie on the warped line (so a street is a chain of short edges
 * that reads as a curve, the way the channel chains its nodes). Pure and
 * deterministic. Intersections join at most CITY.maxNodeDegree roads. District
 * planning (districts/index.ts) edits the graph afterwards: narrow alleys, back
 * alley shortcuts (splitEdge + addEdge), bridges and roundabout nodes.
 *
 * Consumers see a plain straight-edged planar graph. Those that reason about a
 * street between two junctions (its length, a structure along it, a route's
 * start straight) walk the chain through its bend nodes with chainFrom /
 * chainOf / gridChain / chains below; a bend node (RoadNode.bend) is never a
 * junction: no corner, closure, crosswalk or junction reach belongs there.
 */
import { CITY } from './config';
import { Rng, deriveSeed } from '../sim/prng';
import { atan2, cos, DEG, exp, sin, sqrt, TAU } from '../sim/math';

/**
 * 'alley': narrow raceway street. 'backAlley': skinny shortcut through a block
 * (edge.shortcut). 'channel': the floor of the channel between the feet
 * of its entrances; 'ramp': an entrance, from a street down to a channel node
 * (districts/channel.ts). Channel and ramp edges have no sidewalks, curbs,
 * frontage or buildings: blocks.ts treats them as open ground the channel draws.
 * 'mouth': where an expressway loop meets the street beneath the deck
 * (districts/highway/): a stub from a junction on that street out to the
 * loop's foot on the building line, a dead end the loop carries on from. As
 * wide as the loop, no sidewalks (the junction's corners cut the street's),
 * no frontage or buildings; never routed, nor closed off by the route (the
 * loop's own gates shut it in a race).
 * 'feature': a weekend special's spine and lines (districts/weekendRegion.ts): a road through a carved region
 * that the routes drive end to end, sized by its module (no sidewalks, frontage, buildings, furniture,
 * crown or humps beside or on it), never driven by traffic, never closed off by the route, and never under
 * a start grid, a finish line or the drag strip. Drawn as asphalt like a street; the module draws the rest.
 */
export type RoadKind = 'street' | 'avenue' | 'diagonal' | 'boulevard' | 'alley' | 'backAlley' | 'channel' | 'ramp' | 'mouth' | 'feature';

/** Curb to curb width, lanes and sidewalk of a kind made from the CITY tables (channel and ramp edges are sized by the channel, feature edges by their module). */
export interface RoadDims {
  width: number;
  lanes: 2 | 4;
  sidewalk: number;
}

/** Kinds the CITY tables size: every street kind the grid generator and the alley planner make. */
export type StreetKind = keyof typeof CITY.width;

export function roadDims(kind: RoadKind): RoadDims {
  if (kind === 'channel' || kind === 'ramp' || kind === 'mouth') throw new Error(`${kind} edges are sized by their district`);
  // A weekend module passes its own width to addEdge; this default keeps every caller that asks by kind alone working.
  if (kind === 'feature') return { width: CITY.districts.weekend.spineWidth, lanes: 2, sidewalk: 0 };
  const k = kind as StreetKind;
  return { width: CITY.width[k], lanes: CITY.lanes[k], sidewalk: CITY.sidewalkWidth[k] };
}

/** An edge the channel owns: the channel floor or an entrance ramp. */
export const isChannelEdge = (e: { kind: RoadKind }): boolean => e.kind === 'channel' || e.kind === 'ramp';

/** A weekend region's spine or line (see RoadKind): open ground beside it, the module's to draw. */
export const isFeatureEdge = (e: { kind: RoadKind }): boolean => e.kind === 'feature';

/** An expressway loop's mouth stub (see RoadKind). */
export const isMouthEdge = (e: { kind: RoadKind }): boolean => e.kind === 'mouth';

/** Roundabout geometry at a node (districts/roundabout.ts). */
export interface RoundaboutRing {
  /** Outer curb radius of the ring road. */
  outer: number;
  /** Island radius (curb of the center island, always drivable: see districts/roundabout.ts). */
  island: number;
}

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  /** Grid column and row of a grid junction; -1 for every node added later (bends, splits, free nodes). */
  gi: number;
  gj: number;
  /** Incident edge ids sorted by outgoing angle (ascending atan2(dz, dx)). */
  edges: number[];
  /** Set when the intersection is a roundabout. */
  ring?: RoundaboutRing;
  /**
   * Interior node of a subdivided grid street (subdivideEdges): degree 2, the street bends a few
   * degrees here to follow the warp. Not a junction: nothing that belongs to one (corners, mouths,
   * closures, crosswalks, junction reach) is made at it. Stays set if a later split or shortcut
   * joins here (then it is a junction after all, and the walk helpers stop at it).
   */
  bend?: true;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  kind: RoadKind;
  lanes: 2 | 4;
  /** Curb to curb width. */
  width: number;
  /** Sidewalk width on each side (curb to the outer sidewalk / wall line). */
  sidewalk: number;
  length: number;
  /**
   * The grid street this edge is a piece of (subdivideEdges numbers the streets in grid order);
   * pieces split later keep it. Missing on edges districts add (shortcuts, channels, ramps).
   */
  chain?: number;
  /** Back alley shortcut: drivable, never part of a route, never closed off by barriers. */
  shortcut?: boolean;
  /** The last edge of a shortcut chain with a jump exit (districts/alleyDressing.ts): its b node is the lip's mouth, and the chain is only a shortcut driven toward it. */
  jumpExit?: boolean;
  /** Crosses the channel at street level. */
  bridge?: boolean;
  /** Crosses the El's tracks at grade (a bluff's level crossing, districts/bluff.ts) this far from node a (m). */
  crossing?: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** The plan the grid was laid out from (cityPlan): its size, spacing and downtown. Never edited after. */
  plan: CityPlan;
}

/** One superblock band (CityPlan.superblock): the streets of a grid row or column dropped across a few blocks. */
export interface Superblock {
  /** 'row': the row j = line loses its streets from column `from` to `from + cells`; 'col': column i = line from row `from`. */
  axis: 'row' | 'col';
  line: number;
  from: number;
  /** Blocks the band spans (each a street removed). */
  cells: number;
}

/**
 * The bones of one seed's city (CITY.plan): drawn from its own 'plan' stream before any street is
 * laid, so every seed is its own city while each knob stays within what the planners and the camera
 * expect. Grid junction ids stay j * gridW + i.
 */
export interface CityPlan {
  /** Grid junctions along x (columns, gi 0..gridW - 1) and along z (rows, gj 0..gridH - 1). */
  gridW: number;
  gridH: number;
  /** Distance between neighbouring grid junctions before jitter and warp (m). */
  spacing: number;
  /** Downtown's centre (m, world, through the warp): the tower core, the 'nyc' region and the street furniture's core gather round it. */
  downtown: { x: number; z: number };
  /** Rows (gj) laid as boulevards and columns (gi) laid as avenues, ascending. */
  boulevardRows: number[];
  avenueCols: number[];
  /** Diagonal avenues the generator tries to lay. */
  diagonals: number;
  superblock: Superblock | null;
  /** Share of ordinary grid streets the generator tries to remove. */
  removeFraction: number;
}

/** Index drawn with the given weights (they need not sum to 1). */
function weighted(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let u = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    u -= weights[i];
    if (u < 0) return i;
  }
  return weights.length - 1;
}

/** `count` distinct values of [lo, hi] at least `gap` apart, ascending, drawn from `rng` (fewer when they cannot fit). */
function spread(rng: Rng, lo: number, hi: number, count: number, gap: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const free: number[] = [];
    for (let v = lo; v <= hi; v++) if (out.every((o) => Math.abs(o - v) >= gap)) free.push(v);
    if (!free.length) break;
    out.push(free[rng.int(0, free.length - 1)]);
  }
  return out.sort((a, b) => a - b);
}

/** The seed's city plan (see CityPlan). Pure: the same seed always gives the same plan. */
export function cityPlan(seed: number): CityPlan {
  const P = CITY.plan;
  const rng = new Rng(deriveSeed(seed, 'plan'));
  const spacing = Math.round(rng.range(P.spacing[0], P.spacing[1]));
  const span = rng.range(P.span[0], P.span[1]);
  const count = (r: readonly [number, number]) => Math.min(r[1], Math.max(r[0], Math.round(span / spacing) + 1));
  const W = count(P.gridW);
  const H = count(P.gridH);
  // Downtown: uniform over a disc of downtownOffset of the half size, through the warp like the junctions round it.
  const half = (Math.min(W, H) - 1) * spacing * 0.5;
  const ang = rng.range(0, TAU);
  const rad = P.downtownOffset * half * sqrt(rng.next());
  const downtown = warpField(seed)(rad * cos(ang), rad * sin(ang));
  // Boulevards on the rows 2..H-3 (the old city's range), three rows apart; avenues on a column near
  // each side and one through the middle, the side ones first (the old pair) and the middle the third.
  const boulevardRows = spread(rng, 2, H - 3, 1 + weighted(rng, P.boulevards), 3);
  // With three, the side ones keep a block clear of the middle one (two avenues side by side read as one wide street).
  const nAve = 1 + weighted(rng, P.avenues);
  const mid = rng.int(Math.floor((W - 1) / 2) - 1, Math.ceil((W - 1) / 2) + 1);
  const left = rng.int(1, nAve === 3 ? Math.min(3, mid - 2) : 3);
  const right = rng.int(nAve === 3 ? Math.max(W - 4, mid + 2) : W - 4, W - 2);
  const avenueCols = (nAve === 1 ? [[left, mid, right][rng.int(0, 2)]] : nAve === 2 ? [left, right] : [left, mid, right]).sort((a, b) => a - b);
  const diagonals = 1 + weighted(rng, P.diagonals);
  // A superblock on an interior line that is neither a boulevard nor an avenue, its band clear of the map's edge.
  let superblock: Superblock | null = null;
  if (rng.chance(P.superblockChance)) {
    const axis = rng.chance(0.5) ? 'row' : 'col';
    const cells = rng.int(P.superblockCells[0], P.superblockCells[1]);
    const lines: number[] = [];
    const n = axis === 'row' ? H : W;
    const keep = axis === 'row' ? boulevardRows : avenueCols;
    for (let l = 2; l <= n - 3; l++) if (!keep.includes(l)) lines.push(l);
    const along = axis === 'row' ? W : H;
    if (lines.length && along - 2 - cells >= 1) superblock = { axis, line: lines[rng.int(0, lines.length - 1)], from: rng.int(1, along - 2 - cells), cells };
  }
  const removeFraction = rng.range(P.removeFraction[0], P.removeFraction[1]);
  return { gridW: W, gridH: H, spacing, downtown, boulevardRows, avenueCols, diagonals, superblock, removeFraction };
}

/** How downtown a point is: 1 at the plan's downtown centre, falling off over CITY.downtownRadius (exp of minus the squared distance ratio). */
export function downtownFactor(plan: CityPlan, x: number, z: number): number {
  const R = CITY.downtownRadius;
  return exp(-((x - plan.downtown.x) ** 2 + (z - plan.downtown.z) ** 2) / (R * R));
}

export function otherNode(e: RoadEdge, n: number): number {
  return e.a === n ? e.b : e.a;
}

/** Angle of edge leaving node n, in atan2(dz, dx) convention. */
export function edgeAngleFrom(g: RoadGraph, e: RoadEdge, n: number): number {
  const p = g.nodes[n];
  const q = g.nodes[otherNode(e, n)];
  return atan2(q.z - p.z, q.x - p.x);
}

/**
 * The warp (CITY.warp): a smooth displacement of the plane, x by waves of z and z by waves of x,
 * phases from their own stream so the 'roads' draws keep their order. Applied to the jittered grid
 * before any edge is judged, so sectors and degrees are decided on the streets as they will be.
 */
export interface WarpTerm {
  /** Amplitude (m) and wave number (rad/m) of one sine of CITY.warp. */
  amp: number;
  k: number;
  /** Phases (rad) of the x displacement (a wave of z) and of the z displacement (a wave of x). */
  px: number;
  pz: number;
}

/** The seed's warp terms (phases from the 'warp' stream): what warpField sums, for anything that must follow the rows (the channel). */
export function warpTerms(seed: number): WarpTerm[] {
  const rng = new Rng(deriveSeed(seed, 'warp'));
  return CITY.warp.map((t) => ({ amp: t.amp, k: TAU / t.wavelength, px: rng.range(0, TAU), pz: rng.range(0, TAU) }));
}

export function warpField(seed: number): (x: number, z: number) => { x: number; z: number } {
  const terms = warpTerms(seed);
  return (x, z) => {
    let dx = 0;
    let dz = 0;
    for (const t of terms) {
      dx += t.amp * sin(z * t.k + t.px);
      dz += t.amp * sin(x * t.k + t.pz);
    }
    return { x: x + dx, z: z + dz };
  };
}

export function generateRoadGraph(seed: number): RoadGraph {
  const plan = cityPlan(seed);
  const rng = new Rng(deriveSeed(seed, 'roads'));
  const W = plan.gridW;
  const H = plan.gridH;
  const S = plan.spacing;

  const boulevard = new Set(plan.boulevardRows);
  const avenueCols = new Set(plan.avenueCols);
  /** Streets the superblock drops: the row street from (i, j) east, or the column street from (i, j) north. */
  const sb = plan.superblock;
  const dropped = (i: number, j: number, row: boolean): boolean => {
    if (!sb || (sb.axis === 'row') !== row) return false;
    const [line, at] = row ? [j, i] : [i, j];
    return line === sb.line && at >= sb.from && at < sb.from + sb.cells;
  };

  const nodes: RoadNode[] = [];
  const nodeAt = (i: number, j: number) => j * W + i;
  const warp = warpField(seed);
  /** Jittered grid position of every grid node, before the warp: bend nodes are laid out on the straight line between these. */
  const flat: { x: number; z: number }[] = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let jx = rng.range(-CITY.jitter, CITY.jitter);
      let jz = rng.range(-CITY.jitter, CITY.jitter);
      if (boulevard.has(j)) jz = 0; // the boulevards and the avenues only sweep with the warp
      if (avenueCols.has(i)) jx = 0;
      const p = { x: (i - (W - 1) / 2) * S + jx, z: (j - (H - 1) / 2) * S + jz };
      flat.push(p);
      const w = warp(p.x, p.z);
      nodes.push({
        id: nodes.length,
        x: w.x,
        z: w.z,
        gi: i,
        gj: j,
        edges: [],
      });
    }
  }

  interface ProtoEdge {
    a: number;
    b: number;
    kind: RoadKind;
  }
  const proto: ProtoEdge[] = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (i < W - 1 && !dropped(i, j, true)) proto.push({ a: nodeAt(i, j), b: nodeAt(i + 1, j), kind: boulevard.has(j) ? 'boulevard' : 'street' });
      if (j < H - 1 && !dropped(i, j, false)) proto.push({ a: nodeAt(i, j), b: nodeAt(i, j + 1), kind: avenueCols.has(i) ? 'avenue' : 'street' });
    }
  }

  // Diagonal avenues cut through cells corner to corner. One diagonal per cell max. They run between
  // interior junctions: on the map's outer ring a diagonal would meet the edge street at 45 degrees
  // right where the city's boundary wall wraps the corner (and the alleys narrow the edge streets),
  // and that wall would stand on its carriageway.
  const usedCells = new Set<number>();
  for (let d = 0; d < plan.diagonals; d++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const len = rng.int(CITY.diagonalMinCells, CITY.diagonalMaxCells);
      const dir = rng.chance(0.5) ? 1 : -1;
      const i0 = rng.int(1, W - 2 - len);
      const j0 = dir > 0 ? rng.int(1, H - 2 - len) : rng.int(len + 1, H - 2);
      const cells: number[] = [];
      for (let k = 0; k < len; k++) {
        const ci = i0 + k;
        const cj = dir > 0 ? j0 + k : j0 - k - 1;
        cells.push(cj * W + ci);
      }
      if (cells.some((c) => usedCells.has(c))) continue;
      cells.forEach((c) => usedCells.add(c));
      for (let k = 0; k < len; k++) {
        const a = nodeAt(i0 + k, j0 + dir * k);
        const b = nodeAt(i0 + k + 1, j0 + dir * (k + 1));
        proto.push({ a, b, kind: 'diagonal' });
      }
      break;
    }
  }

  // Materialize every candidate edge, then drop diagonals that squeeze a sector.
  const edges: RoadEdge[] = proto.map((pe, i) => {
    const a = nodes[pe.a];
    const b = nodes[pe.b];
    const dims = roadDims(pe.kind);
    return {
      id: i,
      a: pe.a,
      b: pe.b,
      kind: pe.kind,
      lanes: dims.lanes,
      width: dims.width,
      sidewalk: dims.sidewalk,
      length: sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2),
    };
  });
  const graph: RoadGraph = { nodes, edges, bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, plan };
  sortNodeEdges(graph);
  pruneNarrowSectors(graph);

  // Remove random ordinary edges while keeping the graph connected and every
  // node at degree >= 2 (no dead ends).
  const alive = graph.edges.map(() => true);
  const degree = graph.nodes.map((n) => n.edges.length);
  capNodeDegree(graph, alive, degree);
  const candidates = graph.edges.filter((e) => e.kind === 'street').map((e) => e.id);
  rng.shuffle(candidates);
  const target = Math.floor(candidates.length * plan.removeFraction);
  let removed = 0;
  for (const ei of candidates) {
    if (removed >= target) break;
    if (!alive[ei]) continue;
    const e = graph.edges[ei];
    if (degree[e.a] <= 2 || degree[e.b] <= 2) continue;
    alive[ei] = false;
    if (!isConnected(nodes.length, graph.edges, alive)) {
      alive[ei] = true;
      continue;
    }
    degree[e.a]--;
    degree[e.b]--;
    removed++;
  }
  graph.edges = graph.edges.filter((e) => alive[e.id]);
  graph.edges.forEach((e, i) => (e.id = i));
  subdivideEdges(graph, flat, warp, CITY.bendSegments);
  sortNodeEdges(graph);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z);
    maxZ = Math.max(maxZ, n.z);
  }
  graph.bounds = { minX, maxX, minZ, maxZ };
  return graph;
}

/**
 * Cut every street into `segments` pieces through bend nodes on the warped image of the straight
 * line between its junctions' flat (pre-warp) positions, so the chain follows the warp as the
 * junctions do and the pieces meet at a few degrees. Pieces of a street get consecutive ids
 * (street i becomes edges i * segments .. i * segments + segments - 1) and carry the street's id as
 * `chain`; bend nodes are appended after the grid nodes, so grid node ids stay j * W + i.
 */
function subdivideEdges(g: RoadGraph, flat: { x: number; z: number }[], warp: (x: number, z: number) => { x: number; z: number }, segments: number): void {
  if (segments < 2) {
    g.edges.forEach((e) => (e.chain = e.id));
    return;
  }
  const pieces: RoadEdge[] = [];
  for (const e of g.edges) {
    const fa = flat[e.a];
    const fb = flat[e.b];
    let prev = e.a;
    for (let k = 1; k <= segments; k++) {
      let next = e.b;
      if (k < segments) {
        const t = k / segments;
        const w = warp(fa.x + (fb.x - fa.x) * t, fa.z + (fb.z - fa.z) * t);
        next = g.nodes.length;
        g.nodes.push({ id: next, x: w.x, z: w.z, gi: -1, gj: -1, edges: [], bend: true });
      }
      const A = g.nodes[prev];
      const B = g.nodes[next];
      pieces.push({ ...e, id: pieces.length, a: prev, b: next, chain: e.id, length: sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2) });
      prev = next;
    }
  }
  g.edges = pieces;
}

/**
 * Busy junctions (a diagonal crossing a grid node gives 6 roads) lose grid
 * streets until no node joins more than CITY.maxNodeDegree roads. Picks, in id
 * order, the street whose far end has the most roads, keeping every node at
 * degree >= 2 and the graph connected. Deterministic, no randomness.
 */
function capNodeDegree(g: RoadGraph, alive: boolean[], degree: number[]): void {
  for (const n of g.nodes) {
    while (degree[n.id] > CITY.maxNodeDegree) {
      let pick = -1;
      for (const kinds of [['street'], ['avenue', 'diagonal']]) {
        let bestDeg = -1;
        for (const eid of n.edges) {
          const e = g.edges[eid];
          if (!alive[eid] || !kinds.includes(e.kind)) continue;
          const far = otherNode(e, n.id);
          if (degree[far] <= 2 || degree[far] <= bestDeg) continue;
          alive[eid] = false;
          const ok = isConnected(g.nodes.length, g.edges, alive);
          alive[eid] = true;
          if (!ok) continue;
          bestDeg = degree[far];
          pick = eid;
        }
        if (pick >= 0) break;
      }
      if (pick < 0) break;
      const e = g.edges[pick];
      alive[pick] = false;
      degree[e.a]--;
      degree[e.b]--;
    }
  }
}

/** Re-sort every node's incident edge list (call after editing g.edges). */
export function sortNodeEdges(g: RoadGraph): void {
  for (const n of g.nodes) n.edges = [];
  for (const e of g.edges) {
    g.nodes[e.a].edges.push(e.id);
    g.nodes[e.b].edges.push(e.id);
  }
  for (const n of g.nodes) {
    n.edges.sort((x, y) => edgeAngleFrom(g, g.edges[x], n.id) - edgeAngleFrom(g, g.edges[y], n.id));
  }
}

/** Sector angle between consecutive edges k and k+1 at a node, in (0, TAU]. */
export function sectorAngle(g: RoadGraph, node: RoadNode, k: number): number {
  const m = node.edges.length;
  const a0 = edgeAngleFrom(g, g.edges[node.edges[k]], node.id);
  const a1 = edgeAngleFrom(g, g.edges[node.edges[(k + 1) % m]], node.id);
  let d = a1 - a0;
  while (d <= 0) d += TAU;
  if (m === 1) return TAU;
  return d;
}

/**
 * Jitter can squeeze a diagonal too close to a grid edge. Drop the diagonal
 * edge in that case (re-indexing ids) so intersection geometry stays clean.
 */
function pruneNarrowSectors(g: RoadGraph): void {
  const minRad = CITY.minSectorDeg * DEG;
  for (let pass = 0; pass < 4; pass++) {
    const bad = new Set<number>();
    for (const n of g.nodes) {
      if (n.edges.length < 2) continue;
      for (let k = 0; k < n.edges.length; k++) {
        if (sectorAngle(g, n, k) < minRad) {
          const e0 = g.edges[n.edges[k]];
          const e1 = g.edges[n.edges[(k + 1) % n.edges.length]];
          const victim = e0.kind === 'diagonal' ? e0 : e1.kind === 'diagonal' ? e1 : e0.kind === 'street' ? e0 : e1;
          bad.add(victim.id);
        }
      }
    }
    if (bad.size === 0) return;
    const kept = g.edges.filter((e) => !bad.has(e.id));
    kept.forEach((e, i) => (e.id = i));
    g.edges = kept;
    sortNodeEdges(g);
  }
}

function isConnected(n: number, edges: { a: number; b: number }[], alive: boolean[]): boolean {
  const adj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, i) => {
    if (!alive[i]) return;
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  });
  const seen = new Uint8Array(n);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of adj[v]) {
      if (!seen[w]) {
        seen[w] = 1;
        count++;
        stack.push(w);
      }
    }
  }
  return count === n;
}

export function graphIsConnected(g: RoadGraph): boolean {
  return isConnected(
    g.nodes.length,
    g.edges,
    g.edges.map(() => true),
  );
}

/**
 * Split edge `eid` at parameter t (0..1 from a to b): the edge keeps its id and
 * now ends at the new node, and a new edge of the same kind runs on to the old
 * end. Returns the new node id. Call sortNodeEdges when done editing.
 */
export function splitEdge(g: RoadGraph, eid: number, t: number): number {
  const e = g.edges[eid];
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const id = g.nodes.length;
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  g.nodes.push({ id, x, z, gi: -1, gj: -1, edges: [] });
  const oldB = e.b;
  e.b = id;
  e.length = sqrt((x - a.x) ** 2 + (z - a.z) ** 2);
  g.edges.push({ ...e, id: g.edges.length, a: id, b: oldB, length: sqrt((b.x - x) ** 2 + (b.z - z) ** 2) });
  return id;
}

/** Append an edge of the given kind between two nodes. Returns its id. Call sortNodeEdges when done. */
export function addEdge(g: RoadGraph, a: number, b: number, kind: RoadKind, dims: RoadDims = roadDims(kind)): number {
  const A = g.nodes[a];
  const B = g.nodes[b];
  const id = g.edges.length;
  g.edges.push({ id, a, b, kind, lanes: dims.lanes, width: dims.width, sidewalk: dims.sidewalk, length: sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2) });
  return id;
}

/** Append a free node (not on the grid). Returns its id. Call sortNodeEdges when done. */
export function addNode(g: RoadGraph, x: number, z: number): number {
  const id = g.nodes.length;
  g.nodes.push({ id, x, z, gi: -1, gj: -1, edges: [] });
  return id;
}

/** Find the edge joining two nodes, or -1. */
export function edgeBetween(g: RoadGraph, a: number, b: number): number {
  for (const eid of g.nodes[a].edges) {
    const e = g.edges[eid];
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return eid;
  }
  return -1;
}

/** A bend node (RoadNode.bend) that still only joins its two pieces: the walks below pass through it. */
export function isBendNode(g: RoadGraph, id: number): boolean {
  const n = g.nodes[id];
  return n.bend === true && n.edges.length === 2;
}

/**
 * A street between two junctions as the walks below return it: its nodes from one junction to
 * the other through the bend nodes between them, the pieces joining them (edges[i] joins nodes[i]
 * and nodes[i + 1]) and its length along them (m). A street with no bends is one node pair and one
 * edge.
 */
export interface Chain {
  nodes: number[];
  edges: number[];
  length: number;
}

/**
 * Walk from `node` along its edge `eid` through bend nodes to the next junction (any node that is
 * not a pass-through bend: a grid junction, a shortcut mouth, a ramp top, a free node). Returns the
 * chain from `node` to that junction.
 */
export function chainFrom(g: RoadGraph, node: number, eid: number): Chain {
  const nodes = [node];
  const edges = [eid];
  let length = g.edges[eid].length;
  let cur = otherNode(g.edges[eid], node);
  let e = eid;
  nodes.push(cur);
  for (let guard = 0; guard < g.nodes.length && isBendNode(g, cur) && cur !== node; guard++) {
    const n = g.nodes[cur];
    e = n.edges[0] === e ? n.edges[1] : n.edges[0];
    cur = otherNode(g.edges[e], cur);
    edges.push(e);
    nodes.push(cur);
    length += g.edges[e].length;
  }
  return { nodes, edges, length };
}

/** The chain between junctions a and b (a street with a and b as its ends), or null when no street joins them. */
export function gridChain(g: RoadGraph, a: number, b: number): Chain | null {
  for (const eid of g.nodes[a].edges) {
    const c = chainFrom(g, a, eid);
    if (c.nodes[c.nodes.length - 1] === b) return c;
  }
  return null;
}

/** The chain the edge `eid` is a piece of, walked from its junction on the a side (so the pieces run a to b). */
export function chainOf(g: RoadGraph, eid: number): Chain {
  let e = eid;
  let start = g.edges[e].a;
  for (let guard = 0; guard < g.nodes.length && isBendNode(g, start); guard++) {
    const n = g.nodes[start];
    e = n.edges[0] === e ? n.edges[1] : n.edges[0];
    start = otherNode(g.edges[e], start);
    if (start === g.edges[eid].a) break; // a ring of bends with no junction: start anywhere
  }
  return chainFrom(g, start, e);
}

/**
 * Every chain of the graph once, in order of its first junction's id and the edge order there,
 * so each edge is in exactly one chain. Districts that pick a street by its length or want a
 * structure along it iterate these instead of g.edges.
 */
export function chains(g: RoadGraph): Chain[] {
  const seen = new Uint8Array(g.edges.length);
  const out: Chain[] = [];
  for (const n of g.nodes) {
    if (isBendNode(g, n.id)) continue;
    for (const eid of n.edges) {
      if (seen[eid]) continue;
      const c = chainFrom(g, n.id, eid);
      for (const e of c.edges) seen[e] = 1;
      out.push(c);
    }
  }
  return out;
}

/** The point at distance s (m, clamped) along a chain from its first node. */
export function chainPoint(g: RoadGraph, c: Chain, s: number): { x: number; z: number } {
  let rest = s < 0 ? 0 : s;
  for (let i = 0; i < c.edges.length; i++) {
    const len = g.edges[c.edges[i]].length;
    if (rest <= len || i === c.edges.length - 1) {
      const a = g.nodes[c.nodes[i]];
      const b = g.nodes[c.nodes[i + 1]];
      const t = len > 0 ? Math.min(1, rest / len) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    rest -= len;
  }
  const n = g.nodes[c.nodes[0]];
  return { x: n.x, z: n.z };
}

/**
 * Distance s (m) along a chain, moved onto the nearest of its bend nodes when one lies within
 * `snap` (the chain's first node too, when it is a bend). Where a mouth due at s goes
 * (splitChainAt): a mouth right by a bend node would reach its corners past the node's own,
 * so it takes the node instead and turns the bend into a junction.
 */
export function chainSnap(g: RoadGraph, c: Chain, s: number, snap: number): number {
  if (snap <= 0) return s;
  const cum = chainCum(g, c);
  let best = s;
  let bestD = snap;
  for (let i = 0; i + 1 < c.nodes.length; i++) {
    if (i === 0 && !g.nodes[c.nodes[0]].bend) continue;
    const d = cum[i] - s < 0 ? s - cum[i] : cum[i] - s;
    if (d <= bestD) {
      bestD = d;
      best = cum[i];
    }
  }
  return best;
}

/**
 * Split a chain at distance s (m) along it from its first node (snapped onto a bend node within
 * `snap` m, chainSnap): the piece holding s is split there (splitEdge, so every id stays valid and
 * the new piece is appended), or the snapped-to node is returned as is. Returns the node id. Call
 * sortNodeEdges when done editing.
 */
export function splitChainAt(g: RoadGraph, c: Chain, s: number, snap = 0): number {
  const cum = chainCum(g, c);
  const at = chainSnap(g, c, s, snap);
  if (snap > 0) for (let i = 0; i + 1 < c.nodes.length; i++) if (cum[i] === at && (i > 0 || g.nodes[c.nodes[0]].bend)) return c.nodes[i];
  for (let i = 0; i < c.edges.length; i++) {
    const e = g.edges[c.edges[i]];
    if (at <= cum[i + 1] || i === c.edges.length - 1) {
      const t = e.length > 0 ? Math.max(0.01, Math.min(0.99, (at - cum[i]) / e.length)) : 0.5;
      return splitEdge(g, e.id, e.a === c.nodes[i] ? t : 1 - t);
    }
  }
  return splitEdge(g, c.edges[0], 0.5);
}

/** Distance (m) along a chain at each of its nodes: cum[i] is where nodes[i] is, cum[last] the chain's length. */
export function chainCum(g: RoadGraph, c: Chain): number[] {
  const cum = [0];
  for (let i = 0; i < c.edges.length; i++) cum.push(cum[i] + g.edges[c.edges[i]].length);
  return cum;
}

/**
 * Where every node and edge went when an edit compacted the graph's ids: old id to new id, -1 for one
 * removed. districts/index.ts carries the claims and the planned areas' node and edge lists through it
 * (PlanContext.graphChanged); ids kept anywhere else (an area's params) are not remapped.
 */
export interface Renumber {
  node: Int32Array;
  edge: Int32Array;
}

/** Drop the marked nodes and edges, renumber the rest in order and sort the node edges. */
function compactGraph(g: RoadGraph, deadNode: Uint8Array, deadEdge: Uint8Array): Renumber {
  const node = new Int32Array(g.nodes.length).fill(-1);
  const nodes: RoadNode[] = [];
  for (const n of g.nodes) {
    if (deadNode[n.id]) continue;
    node[n.id] = nodes.length;
    n.id = nodes.length;
    nodes.push(n);
  }
  const edge = new Int32Array(g.edges.length).fill(-1);
  const edges: RoadEdge[] = [];
  for (const e of g.edges) {
    if (deadEdge[e.id]) continue;
    edge[e.id] = edges.length;
    e.id = edges.length;
    e.a = node[e.a];
    e.b = node[e.b];
    edges.push(e);
  }
  g.nodes = nodes;
  g.edges = edges;
  sortNodeEdges(g);
  return { node, edge };
}

/**
 * Merge chains back into single straight edges from junction to junction: the first piece of each
 * keeps its kind and widths and now runs the whole way, the other pieces and the bend nodes between
 * go, and every id is compacted (edges and nodes renumbered in order). Only safe while no id is held
 * where the renumbering cannot reach it (the planned areas' node and edge lists are carried through
 * by PlanContext.graphChanged): the channel planner straightens its crossing streets this way so its
 * ford ramps can split them the way they always did. Sorts the node edges.
 */
export function mergeChains(g: RoadGraph, list: readonly Chain[]): Renumber {
  const deadEdge = new Uint8Array(g.edges.length);
  const deadNode = new Uint8Array(g.nodes.length);
  for (const c of list) {
    if (c.edges.length < 2) continue;
    const first = g.edges[c.edges[0]];
    const a = c.nodes[0];
    const b = c.nodes[c.nodes.length - 1];
    if (first.a !== a) {
      // The first piece runs against the chain: turn it round so the merged edge runs a to b.
      first.b = first.a;
      first.a = a;
    }
    first.b = b;
    const A = g.nodes[a];
    const B = g.nodes[b];
    first.length = sqrt((A.x - B.x) ** 2 + (A.z - B.z) ** 2);
    for (let i = 1; i < c.edges.length; i++) deadEdge[c.edges[i]] = 1;
    for (let i = 1; i + 1 < c.nodes.length; i++) deadNode[c.nodes[i]] = 1;
  }
  return compactGraph(g, deadNode, deadEdge);
}

/**
 * Delete streets: the given edges go, and with them every node they leave with no edge at all (the
 * bend nodes along a removed street); every id is compacted as mergeChains does. A grid junction is
 * never left alone (its id is j * plan.gridW + i, which other planners rely on): that throws. The lake
 * (districts/lake.ts) merges its blocks this way, before any other district plans.
 */
export function removeEdges(g: RoadGraph, ids: Iterable<number>): Renumber {
  const deadEdge = new Uint8Array(g.edges.length);
  for (const id of ids) deadEdge[id] = 1;
  const left = new Int32Array(g.nodes.length);
  for (const e of g.edges) {
    if (deadEdge[e.id]) continue;
    left[e.a]++;
    left[e.b]++;
  }
  const deadNode = new Uint8Array(g.nodes.length);
  for (const n of g.nodes) {
    if (left[n.id] || !n.edges.length) continue;
    if (n.gi >= 0) throw new Error(`removing streets would strand grid junction ${n.gi}, ${n.gj}`);
    deadNode[n.id] = 1;
  }
  return compactGraph(g, deadNode, deadEdge);
}

/** Heading change (rad, 0..pi) a route makes at `node` coming from `prev` and leaving for `next`; 0 when the three are collinear. */
export function turnAt(g: RoadGraph, prev: number, node: number, next: number): number {
  const P = g.nodes[prev];
  const N = g.nodes[node];
  const Q = g.nodes[next];
  const a0 = atan2(N.z - P.z, N.x - P.x);
  const a1 = atan2(Q.z - N.z, Q.x - N.x);
  let d = a1 - a0;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d < 0 ? -d : d;
}

