/**
 * Alleys, two variants (two modules, one file):
 *
 * 'alley': a narrow raceway street. A chain of 2-3 straight grid street
 * edges away from the center becomes kind 'alley' (CITY.width.alley, thin
 * sidewalks). Routes may use it like any street; the racing line and AI
 * follow the narrower route.segWidth automatically.
 *
 * 'backAlley': a skinny shortcut through a block. Two opposite sides of a
 * four sided block are split at their middles (new T junction nodes) and
 * joined by a 'backAlley' edge flagged `shortcut: true`. Routes never use
 * shortcut edges and never barrier them off, so racers can take them; the
 * race progress logic keeps big shortcuts from paying off (see race.ts).
 *
 * Content to add (render/districts/alley.ts): dumpsters, fire escapes,
 * graffiti, steam vents, string lights; puddles and grime on back alleys.
 */
import { CITY } from '../config';
import { addEdge, edgeBetween, splitEdge } from '../roadGraph';
import type { RoadGraph } from '../roadGraph';
import { Vec2 } from '../../sim/math';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';

/** Corridor polygon around a polyline (half width hw). */
export function corridor(path: Vec2[], hw: number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  path.forEach((p, j) => {
    const a = path[Math.max(0, j - 1)];
    const b = path[Math.min(path.length - 1, j + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    left.push({ x: p.x + nx * hw, z: p.z + nz * hw });
    right.push({ x: p.x - nx * hw, z: p.z - nz * hw });
  });
  return left.concat(right.reverse());
}

function gridIndex(g: RoadGraph): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of g.nodes) if (n.gi >= 0) m.set(n.gj * 1000 + n.gi, n.id);
  return m;
}

export const alleyModule: DistrictModule = {
  kind: 'alley',
  phase: 'graph',
  plan(ctx) {
    const cfg = CITY.districts.alley;
    if (!cfg.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    const at = gridIndex(g);
    const cx = (g.bounds.minX + g.bounds.maxX) / 2;
    const cz = (g.bounds.minZ + g.bounds.maxZ) / 2;
    const chains: { nodes: number[]; edges: number[] }[] = [];
    for (const n of g.nodes) {
      if (n.gi < 0) continue;
      for (const [di, dj] of [
        [1, 0],
        [0, 1],
      ]) {
        const L = rng.int(cfg.chain[0], cfg.chain[1]);
        const nodes = [n.id];
        const edges: number[] = [];
        let ok = true;
        for (let k = 1; k <= L && ok; k++) {
          const next = at.get((n.gj + dj * k) * 1000 + n.gi + di * k);
          if (next === undefined) {
            ok = false;
            break;
          }
          const e = edgeBetween(g, nodes[nodes.length - 1], next);
          if (e < 0 || g.edges[e].kind !== 'street' || g.edges[e].bridge || ctx.claims.edge.has(e)) ok = false;
          nodes.push(next);
          edges.push(e);
        }
        if (!ok) continue;
        if (nodes.some((id) => ctx.claims.node.has(id) || g.nodes[id].ring)) continue;
        const mid = g.nodes[nodes[nodes.length >> 1]];
        if (Math.hypot(mid.x - cx, mid.z - cz) < 280) continue;
        chains.push({ nodes, edges });
      }
    }
    rng.shuffle(chains);
    const used = new Set<number>();
    let made = 0;
    for (const c of chains) {
      if (made >= count) break;
      if (c.nodes.some((id) => used.has(id))) continue;
      let length = 0;
      for (const e of c.edges) length += g.edges[e].length;
      const footprint = length * (CITY.width.alley + 2 * CITY.sidewalkWidth.alley);
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      for (const e of c.edges) {
        const edge = g.edges[e];
        edge.kind = 'alley';
        edge.width = CITY.width.alley;
        edge.sidewalk = CITY.sidewalkWidth.alley;
        edge.lanes = CITY.lanes.alley;
      }
      c.nodes.forEach((id) => used.add(id));
      const path = c.nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
      ctx.addArea(
        { kind: 'alley', variant: 'raceway', polygon: corridor(path, CITY.width.alley / 2 + CITY.sidewalkWidth.alley), path, nodes: c.nodes.slice(1, -1), edges: c.edges, faces: [], params: { length } },
        footprint,
      );
      made++;
    }
    if (made) ctx.graphChanged();
  },
  build() {
    return emptyBuild();
  },
};

export const backAlleyModule: DistrictModule = {
  kind: 'backAlley',
  phase: 'graph',
  plan(ctx) {
    const cfg = CITY.districts.backAlley;
    if (!cfg.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    const faces = ctx.faces().filter((f) => {
      if (f.outer || f.corners.length !== 4 || f.edges.length !== 4 || f.area < 9000 || f.area > 26000) return false;
      if (f.corners.some((c) => g.nodes[c.node].ring)) return false;
      return f.edges.every((e) => {
        const k = g.edges[e].kind;
        return (k === 'street' || k === 'avenue' || k === 'boulevard') && !g.edges[e].bridge && !ctx.claims.edge.has(e);
      });
    });
    rng.shuffle(faces);
    const touched = new Set<number>();
    let made = 0;
    for (const f of faces) {
      if (made >= count) break;
      if (f.edges.some((e) => touched.has(e))) continue;
      const pairs = [
        [f.edges[0], f.edges[2]],
        [f.edges[1], f.edges[3]],
      ].filter(([a, b]) => g.edges[a].length >= cfg.minSide && g.edges[b].length >= cfg.minSide);
      if (!pairs.length) continue;
      const [ea, eb] = pairs[rng.int(0, pairs.length - 1)];
      const ta = 0.5 + rng.range(-0.1, 0.1);
      const tb = 0.5 + rng.range(-0.1, 0.1);
      const pa = g.edges[ea];
      const pb = g.edges[eb];
      const A = { x: g.nodes[pa.a].x + (g.nodes[pa.b].x - g.nodes[pa.a].x) * ta, z: g.nodes[pa.a].z + (g.nodes[pa.b].z - g.nodes[pa.a].z) * ta };
      const B = { x: g.nodes[pb.a].x + (g.nodes[pb.b].x - g.nodes[pb.a].x) * tb, z: g.nodes[pb.a].z + (g.nodes[pb.b].z - g.nodes[pb.a].z) * tb };
      const length = Math.hypot(B.x - A.x, B.z - A.z);
      if (length < 50) continue;
      const footprint = length * (CITY.width.backAlley + 2 * CITY.sidewalkWidth.backAlley);
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      const na = splitEdge(g, ea, ta);
      const nb = splitEdge(g, eb, tb);
      const id = addEdge(g, na, nb, 'backAlley');
      g.edges[id].shortcut = true;
      f.edges.forEach((e) => touched.add(e));
      touched.add(g.edges.length - 2).add(g.edges.length - 3);
      const path = [A, B];
      ctx.addArea({ kind: 'backAlley', variant: 'shortcut', polygon: corridor(path, CITY.width.backAlley / 2 + CITY.sidewalkWidth.backAlley), path, nodes: [na, nb], edges: [id], faces: [], params: { length } }, footprint);
      made++;
    }
    if (made) ctx.graphChanged();
  },
  build() {
    return emptyBuild();
  },
};
