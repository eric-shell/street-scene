/**
 * Procedural road network: a jittered grid with some edges removed, a couple
 * of diagonal avenues and one wide straight boulevard. Pure and deterministic.
 */
import { CITY } from './config';
import { Rng, deriveSeed } from '../sim/prng';
import { atan2, DEG, sqrt, TAU } from '../sim/math';

export type RoadKind = 'street' | 'avenue' | 'diagonal' | 'boulevard';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  gi: number;
  gj: number;
  /** Incident edge ids sorted by outgoing angle (ascending atan2(dz, dx)). */
  edges: number[];
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  kind: RoadKind;
  lanes: 2 | 4;
  /** Curb to curb width. */
  width: number;
  length: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
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

export function generateRoadGraph(seed: number): RoadGraph {
  const rng = new Rng(deriveSeed(seed, 'roads'));
  const W = CITY.gridW;
  const H = CITY.gridH;
  const S = CITY.spacing;

  const boulevardRow = rng.int(2, H - 3);
  const avenueCols = new Set<number>([rng.int(1, 3), rng.int(W - 4, W - 2)]);

  const nodes: RoadNode[] = [];
  const nodeAt = (i: number, j: number) => j * W + i;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let jx = rng.range(-CITY.jitter, CITY.jitter);
      let jz = rng.range(-CITY.jitter, CITY.jitter);
      if (j === boulevardRow) jz = 0; // the boulevard is dead straight
      if (avenueCols.has(i)) jx = 0;
      nodes.push({
        id: nodes.length,
        x: (i - (W - 1) / 2) * S + jx,
        z: (j - (H - 1) / 2) * S + jz,
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
      if (i < W - 1) {
        const boulevard = j === boulevardRow;
        proto.push({ a: nodeAt(i, j), b: nodeAt(i + 1, j), kind: boulevard ? 'boulevard' : 'street' });
      }
      if (j < H - 1) {
        const avenue = avenueCols.has(i);
        proto.push({ a: nodeAt(i, j), b: nodeAt(i, j + 1), kind: avenue ? 'avenue' : 'street' });
      }
    }
  }

  // Diagonal avenues cut through cells corner to corner. One diagonal per cell max.
  const usedCells = new Set<number>();
  for (let d = 0; d < CITY.diagonalCount; d++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const len = rng.int(CITY.diagonalMinCells, CITY.diagonalMaxCells);
      const dir = rng.chance(0.5) ? 1 : -1;
      const i0 = rng.int(0, W - 1 - len);
      const j0 = dir > 0 ? rng.int(0, H - 1 - len) : rng.int(len, H - 1);
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
    return {
      id: i,
      a: pe.a,
      b: pe.b,
      kind: pe.kind,
      lanes: CITY.lanes[pe.kind],
      width: CITY.width[pe.kind],
      length: sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2),
    };
  });
  const graph: RoadGraph = { nodes, edges, bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } };
  sortNodeEdges(graph);
  pruneNarrowSectors(graph);

  // Remove random ordinary edges while keeping the graph connected and every
  // node at degree >= 2 (no dead ends).
  const alive = graph.edges.map(() => true);
  const degree = graph.nodes.map((n) => n.edges.length);
  const candidates = graph.edges.filter((e) => e.kind === 'street').map((e) => e.id);
  rng.shuffle(candidates);
  const target = Math.floor(candidates.length * CITY.removeFraction);
  let removed = 0;
  for (const ei of candidates) {
    if (removed >= target) break;
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

function sortNodeEdges(g: RoadGraph): void {
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

/** Find the edge joining two nodes, or -1. */
export function edgeBetween(g: RoadGraph, a: number, b: number): number {
  for (const eid of g.nodes[a].edges) {
    const e = g.edges[eid];
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return eid;
  }
  return -1;
}

