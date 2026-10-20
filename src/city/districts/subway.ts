/**
 * Subway: an elevated railway running the full height of the map above one
 * north-south street column, over the curb lane on one side, continuing
 * straight over the block where the column's street is missing. Support
 * pillars stand on the sidewalk (walls with look 'pillar', street furniture
 * keeps clear of them) and inside blocks where there is no street. The
 * planner claims the column's nodes and edges (no roundabouts there).
 *
 * Content to add (render/districts/subway.ts): steel deck girders, rails,
 * catenary, stations on long blocks, a train running on a fixed timetable
 * (render only, or a deterministic sim actor), pillar lights.
 */
import { CITY } from '../config';
import { edgeBetween } from '../roadGraph';
import { Vec2, distToSegment, sqrt } from '../../sim/math';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';
import { circlePolygon, polyWalls } from './geom';
import { riverCenter } from './river';

const CFG = CITY.districts.subway;
/** Pillars keep this far from intersections (m). */
const NODE_CLEAR = 18;

export const subwayModule: DistrictModule = {
  kind: 'subway',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const g = ctx.graph;
    const cols: number[] = [];
    for (let i = 1; i <= CITY.gridW - 2; i++) cols.push(i);
    rng.shuffle(cols);
    const side = rng.chance(0.5) ? 1 : -1;
    for (const i of cols) {
      const nodes = g.nodes.filter((n) => n.gi === i).sort((a, b) => a.gj - b.gj);
      if (nodes.some((n) => ctx.claims.node.has(n.id))) continue;
      const edges: number[] = [];
      for (let j = 0; j + 1 < nodes.length; j++) {
        const e = edgeBetween(g, nodes[j].id, nodes[j + 1].id);
        if (e >= 0) edges.push(e);
      }
      if (edges.length < nodes.length - 3) continue;
      // Deck over the curb lane on the pillar side.
      const offs = nodes.map((n) => {
        let half = 0;
        for (const eid of n.edges) {
          const e = g.edges[eid];
          if (edges.includes(eid)) half = Math.max(half, e.width / 2);
        }
        return side * Math.max(2, (half || CITY.width.street / 2) - CFG.deckInset);
      });
      const path: Vec2[] = nodes.map((n, j) => ({ x: n.x + offs[j], z: n.z }));
      path.unshift({ x: path[0].x, z: path[0].z - 70 });
      path.push({ x: path[path.length - 1].x, z: path[path.length - 1].z + 70 });
      let length = 0;
      for (let j = 1; j < path.length; j++) length += Math.hypot(path[j].x - path[j - 1].x, path[j].z - path[j - 1].z);
      const footprint = length * CFG.deckWidth;
      if (ctx.budget.used + footprint > ctx.budget.total) return;
      const hw = CFG.deckWidth / 2;
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
      ctx.addArea(
        {
          kind: 'subway',
          variant: 'elevated',
          polygon: left.concat(right.reverse()),
          path,
          nodes: nodes.map((n) => n.id),
          edges,
          faces: [],
          params: { side, column: i, deckHeight: CFG.deckHeight, deckWidth: CFG.deckWidth },
        },
        footprint,
      );
      return;
    }
  },

  build(ctx, area) {
    const b = emptyBuild();
    const g = ctx.graph;
    const side = area.params.side;
    const r = CFG.pillarRadius;
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const inChannel = (x: number, z: number) => rivers.some((rv) => Math.abs(z - riverCenter(rv.params, x)) < rv.params.top + CITY.districts.river.bridgeBody + 2);
    const pillar = (x: number, z: number) => {
      if (inChannel(x, z)) return;
      for (const n of g.nodes) if ((n.x - x) ** 2 + (n.z - z) ** 2 < NODE_CLEAR * NODE_CLEAR) return;
      // Never on a road (a diagonal or a back alley crossing under the deck).
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const c = g.nodes[e.b];
        if (distToSegment(x, z, a.x, a.z, c.x, c.z) < e.width / 2 + r + 0.5) return;
      }
      b.walls.push(...polyWalls(circlePolygon(x, z, r, 8), false, 'pillar', area.id));
      b.reserved.push({ x, z, r: r + 0.4 });
      b.props.push({ kind: 'pillar', x, z, yaw: 0, size: r, height: area.params.deckHeight, area: area.id });
    };
    const spread = (len: number, margin: number): number[] => {
      const usable = len - 2 * margin;
      if (usable <= 0) return [];
      const n = Math.max(1, Math.round(usable / CFG.pillarSpacing) + 1);
      return Array.from({ length: n }, (_, k) => margin + (n === 1 ? usable / 2 : (usable * k) / (n - 1)));
    };
    // Pillars on the sidewalk of every street the deck follows.
    for (const eid of area.edges) {
      const e = g.edges[eid];
      const a = g.nodes[e.a];
      const c = g.nodes[e.b];
      const len = sqrt((c.x - a.x) ** 2 + (c.z - a.z) ** 2) || 1;
      const dx = (c.x - a.x) / len;
      const dz = (c.z - a.z) / len;
      let nx = -dz;
      let nz = dx;
      if (nx * side < 0) {
        nx = -nx;
        nz = -nz;
      }
      const lat = e.width / 2 + CFG.pillarSetback;
      for (const s of spread(len, NODE_CLEAR + 2)) pillar(a.x + dx * s + nx * lat, a.z + dz * s + nz * lat);
    }
    // Over blocks without a street below: pillars on the deck line, buildings kept out.
    const nodes = area.nodes.map((id) => g.nodes[id]);
    const path = area.path;
    for (let j = 0; j + 1 < nodes.length; j++) {
      if (edgeBetween(g, nodes[j].id, nodes[j + 1].id) >= 0) continue;
      const p = path[j + 1];
      const q = path[j + 2];
      const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const ux = (q.x - p.x) / len;
      const uz = (q.z - p.z) / len;
      const w = CFG.deckWidth / 2 + 2;
      b.exclusions.push([
        { x: p.x - uz * w, z: p.z + ux * w },
        { x: q.x - uz * w, z: q.z + ux * w },
        { x: q.x + uz * w, z: q.z - ux * w },
        { x: p.x + uz * w, z: p.z - ux * w },
      ]);
      for (const s of spread(len, NODE_CLEAR + 4)) pillar(p.x + ux * s, p.z + uz * s);
    }
    b.hints.push({ kind: 'deck', points: area.path, values: [area.params.deckHeight, area.params.deckWidth] });
    return b;
  },
};
