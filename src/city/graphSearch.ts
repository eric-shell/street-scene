/**
 * Shortest paths on the road graph, shared by the route finders, the route
 * builder and the structure planners: a binary min heap and Dijkstra, between
 * two nodes (with blocked nodes and edges) or from seeds to every node.
 * Deterministic: same graph and inputs, same paths.
 */
import { type RoadGraph, otherNode } from './roadGraph';

/**
 * Binary min heap of (key, node) pairs for the path searches: with the bend nodes the graph has
 * about 500 nodes and the finders run hundreds of attempts, so a linear scan per step is too slow.
 * Stale entries are skipped by the caller (lazy deletion). Deterministic: same pushes, same pops.
 */
export class NodeHeap {
  private keys: number[] = [];
  private ids: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(key: number, id: number): void {
    const keys = this.keys;
    const ids = this.ids;
    let i = ids.length;
    keys.push(key);
    ids.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      ids[i] = ids[p];
      i = p;
    }
    keys[i] = key;
    ids[i] = id;
  }
  /** Removes and returns the node with the smallest key (and the key through `out`). */
  pop(out: { key: number }): number {
    const keys = this.keys;
    const ids = this.ids;
    const top = ids[0];
    out.key = keys[0];
    const lastKey = keys.pop()!;
    const lastId = ids.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c];
        ids[i] = ids[c];
        i = c;
      }
      keys[i] = lastKey;
      ids[i] = lastId;
    }
    return top;
  }
}

export function dijkstra(g: RoadGraph, from: number, to: number, weight: Float64Array, blockedNode: Uint8Array, blockedEdge: Uint8Array): number[] | null {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[from] = 0;
  const heap = new NodeHeap();
  const popped = { key: 0 };
  heap.push(0, from);
  for (;;) {
    let u = -1;
    while (heap.size) {
      const v = heap.pop(popped);
      if (!done[v] && popped.key <= dist[v]) {
        u = v;
        break;
      }
    }
    if (u < 0) return null;
    if (u === to) break;
    done[u] = 1;
    for (const eid of g.nodes[u].edges) {
      if (blockedEdge[eid]) continue;
      const v = otherNode(g.edges[eid], u);
      if (blockedNode[v] && v !== to) continue;
      const nd = dist[u] + weight[eid];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  const path: number[] = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  path.reverse();
  return path[0] === from ? path : null;
}

/** Distance by road (m) from every node to the nearest seed, each seed a node and its distance to go (Dijkstra on edge lengths). */
export function distanceField(g: RoadGraph, seeds: readonly [number, number][]): Float64Array {
  const n = g.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  for (const [id, d] of seeds) dist[id] = Math.min(dist[id], d);
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u < 0) return dist;
    done[u] = 1;
    for (const eid of g.nodes[u].edges) {
      const v = otherNode(g.edges[eid], u);
      const nd = dist[u] + g.edges[eid].length;
      if (nd < dist[v]) dist[v] = nd;
    }
  }
}
