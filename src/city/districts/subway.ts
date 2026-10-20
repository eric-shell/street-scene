/**
 * Subway: an elevated railway ("the El") running the full height of the map
 * above one north-south street column, over the curb lane on one side,
 * continuing straight over the block where the column's street is missing.
 * The deck carries two tracks; trains run both ways on a timetable, render
 * only (render/railTimetable.ts, render/trains.ts), so nothing here moves.
 *
 * What the sim sees:
 *  - support columns on the sidewalk on concrete footings (walls with look
 *    'pillar', street furniture keeps clear of them), plus columns on the
 *    deck line inside blocks where there is no street;
 *  - stations: one or two long street blocks get a station house hung under
 *    the deck with a stair down to each side of it on the pillar side
 *    sidewalk, in line with the columns. The stairs are solid down to the
 *    ground (walls with look 'pillar' too), so what stops a car is what is
 *    drawn; the station house and platforms are overhead and never collide.
 * The planner claims the column's nodes and edges (no roundabouts there).
 * The deck, stations and stairs reach the renderer as hints and props
 * ('deck', 'station', 'stair'); render/districts/subway.ts draws the steel.
 */
import { CITY, ROUTE } from '../config';
import { edgeBetween } from '../roadGraph';
import { Vec2, distToSegment, sqrt, yawOf } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { AreaBuild, BuildContext, DistrictModule } from './types';
import type { Area } from './types';
import { emptyBuild } from './types';
import { circlePolygon, polyWalls } from './geom';
import { riverCenter } from './river';

const CFG = CITY.districts.subway;
/** Pillars keep at least this far from intersections (m). */
const NODE_CLEAR = 18;
/**
 * Beyond the crossing streets' curbs and sidewalks, pillars also keep clear of where a route
 * closure can stand across this street (ROUTE.barrierSetbackHeadOn past the mouth) plus this
 * margin, so a closure's rail never runs through a column whichever route the race picks.
 */
const CLOSURE_GAP = 3.5;
/** Pillars and stairs keep this far beyond other streets' sidewalks (m). */
const SIDEWALK_GAP = 0.6;
/** Stairs keep this far from the crossing streets at the block ends (m, beyond their curbs). */
const STAIR_NODE_CLEAR = 22;

/** A station on one street block under the deck (render reads it from the 'station' hint). */
export interface StationPlan {
  /** Street edge under the station. */
  edge: number;
  /** Distance of the platform center along the area path (m). */
  deckS: number;
  /** Block midpoint on the street centerline. */
  mid: Vec2;
}

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
          params: {
            side,
            column: i,
            deckHeight: CFG.deckHeight,
            deckWidth: CFG.deckWidth,
            stations: rng.int(CFG.stations[0], CFG.stations[1]),
            seed: rng.int(1, 0x7ffffffe),
          },
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
    /**
     * Clear of every road surface by `margin` beyond its curb, and out of the sidewalks of every
     * street but `own` (the one it stands beside): where a diagonal meets the line at a sharp angle
     * their sidewalks merge, and a column there would sit on another street's rail line.
     */
    const offRoads = (x: number, z: number, margin: number, own = -1) => {
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        const a = g.nodes[e.a];
        const c = g.nodes[e.b];
        const d = distToSegment(x, z, a.x, a.z, c.x, c.z);
        if (d < e.width / 2 + margin) return false;
        if (i !== own && d < e.width / 2 + e.sidewalk + margin + SIDEWALK_GAP) return false;
      }
      return true;
    };
    const stations = planStations(ctx, area, b, inChannel, offRoads);
    // Per intersection: how far its closures can reach into the streets that meet there.
    const clearOf = g.nodes.map((n) => {
      let m = 0;
      for (const eid of n.edges) m = Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk);
      return Math.max(NODE_CLEAR, m + ROUTE.barrierSetbackHeadOn + CLOSURE_GAP);
    });
    const pillar = (x: number, z: number, own = -1) => {
      if (inChannel(x, z)) return;
      for (const n of g.nodes) if ((n.x - x) ** 2 + (n.z - z) ** 2 < clearOf[n.id] ** 2) return;
      // Never on a road (a diagonal or a back alley crossing under the deck), nor another street's sidewalk.
      if (!offRoads(x, z, r + 0.5, own)) return;
      b.walls.push(...polyWalls(circlePolygon(x, z, r, 8), false, 'pillar', area.id));
      b.reserved.push({ x, z, r: r + 0.4 });
      b.props.push({ kind: 'pillar', x, z, yaw: 0, size: r, height: area.params.deckHeight, area: area.id });
    };
    const spread = (len: number, m0: number, m1 = m0): number[] => {
      const usable = len - m0 - m1;
      if (usable <= 0) return [];
      const n = Math.max(1, Math.round(usable / CFG.pillarSpacing) + 1);
      return Array.from({ length: n }, (_, k) => m0 + (n === 1 ? usable / 2 : (usable * k) / (n - 1)));
    };
    // Pillars on the sidewalk of every street the deck follows; a station's stairs take the
    // middle of its block, so the columns there step out to just beyond the stairs.
    const zone = CFG.mezzanine / 2 + CFG.stairRun + 1.5;
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
      const st = stations.find((s) => s.edge === eid);
      const at = (s: number) => pillar(a.x + dx * s + nx * lat, a.z + dz * s + nz * lat, eid);
      for (const s of spread(len, clearOf[e.a] + 2, clearOf[e.b] + 2)) if (!st || Math.abs(s - len / 2) > zone) at(s);
      if (st) for (const k of [-1, 1]) at(len / 2 + k * (zone + 1.2));
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
    for (const s of stations) b.hints.push({ kind: 'station', points: [s.mid], values: [s.deckS, s.edge] });
    return b;
  },
};

/**
 * Pick the station blocks and add their stairs. Long, level street blocks
 * away from the map ends and the river, spaced apart, in a seeded order.
 */
function planStations(
  ctx: BuildContext,
  area: Area,
  b: AreaBuild,
  inChannel: (x: number, z: number) => boolean,
  offRoads: (x: number, z: number, margin: number, own?: number) => boolean,
): StationPlan[] {
  const g = ctx.graph;
  const want = area.params.stations ?? 0;
  if (!want) return [];
  const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
  const side = area.params.side;
  const path = area.path;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  const nodes = area.nodes;
  // Node pairs j (deck segment path[j + 1] -> path[j + 2]) with a street below.
  const cands: { j: number; edge: number }[] = [];
  for (let j = 1; j + 2 < nodes.length; j++) {
    const e = edgeBetween(g, nodes[j], nodes[j + 1]);
    if (e < 0 || g.edges[e].bridge || g.edges[e].length < CFG.stationMinEdge) continue;
    cands.push({ j, edge: e });
  }
  rng.shuffle(cands);
  const out: StationPlan[] = [];
  const used: number[] = [];
  const half = CFG.mezzanine / 2;
  for (const c of cands) {
    if (out.length >= want) break;
    if (used.some((j) => Math.abs(j - c.j) < 3)) continue;
    const e = g.edges[c.edge];
    const A = g.nodes[nodes[c.j]];
    const B = g.nodes[nodes[c.j + 1]];
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    let nx = -dz;
    let nz = dx;
    if (nx * side < 0) {
      nx = -nx;
      nz = -nz;
    }
    const mid = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 };
    // The platform (and its approach) stays clear of the river channel.
    let wet = false;
    for (let s = -70; s <= 70 && !wet; s += 10) wet = inChannel(mid.x + dx * s, mid.z + dz * s);
    if (wet) continue;
    const lat = e.width / 2 + CFG.pillarSetback;
    const hw = CFG.stairWidth / 2;
    const stairs: { poly: Vec2[]; bottom: Vec2; up: Vec2 }[] = [];
    let ok = len / 2 - half - CFG.stairRun > STAIR_NODE_CLEAR;
    for (const k of [-1, 1]) {
      if (!ok) break;
      const top = { x: mid.x + dx * k * half + nx * lat, z: mid.z + dz * k * half + nz * lat };
      const bottom = { x: top.x + dx * k * CFG.stairRun, z: top.z + dz * k * CFG.stairRun };
      const poly = [
        { x: top.x - nx * hw, z: top.z - nz * hw },
        { x: bottom.x - nx * hw, z: bottom.z - nz * hw },
        { x: bottom.x + nx * hw, z: bottom.z + nz * hw },
        { x: top.x + nx * hw, z: top.z + nz * hw },
      ];
      if (poly.some((p) => !offRoads(p.x, p.z, 0.4, c.edge) || inChannel(p.x, p.z))) ok = false;
      stairs.push({ poly, bottom, up: { x: -dx * k, z: -dz * k } });
    }
    if (!ok) continue;
    const rise = CFG.deckHeight - CFG.mezzanineDrop;
    for (const s of stairs) {
      b.walls.push(...polyWalls(s.poly, false, 'pillar', area.id));
      b.props.push({ kind: 'stair', x: s.bottom.x, z: s.bottom.z, yaw: yawOf(s.up.x, s.up.z), size: CFG.stairRun, height: rise, area: area.id });
      for (let t = 0; t <= CFG.stairRun; t += 2) b.reserved.push({ x: s.bottom.x + s.up.x * t, z: s.bottom.z + s.up.z * t, r: hw + 0.4 });
    }
    // Platform center: the block midpoint projected onto its deck segment.
    const p = path[c.j + 1];
    const q = path[c.j + 2];
    const segLen = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const t = Math.max(0, Math.min(1, ((mid.x - p.x) * (q.x - p.x) + (mid.z - p.z) * (q.z - p.z)) / (segLen * segLen)));
    out.push({ edge: c.edge, deckS: cum[c.j + 1] + t * segLen, mid });
    used.push(c.j);
  }
  return out;
}
