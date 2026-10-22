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
 *
 * A bluff (districts/bluff.ts, planned right after) may move a stretch of the
 * line off its street onto a right of way through the blocks and hold it
 * level there: params.bluff names it and dj0..dj1 the column's node rows the
 * detour spans. There the street keeps no columns; the deck line gets them
 * where the deck stands high enough above the bluff's ground (lower is bank
 * or at grade), stations keep away, and a 'level' hint carries the track
 * level to the curve (elCurve, the one place the line's curve is built).
 */
import { CITY, ROUTE } from '../config';
import { chainOf, edgeBetween, gridChain, isBendNode } from '../roadGraph';
import type { RoadGraph, RoadNode } from '../roadGraph';
import { Vec2, distToSegment, sqrt, yawOf } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { AreaBuild, BuildContext, DistrictModule } from './types';
import type { Area } from './types';
import { emptyBuild } from './types';
import { circlePolygon, solidWalls } from './geom';
import { riverCenter } from './river';
import { bluffGround, bluffOf, bluffShape } from './bluff';
import { createTerrain } from '../terrain';
import { RailCurve, buildRailCurve } from '../railCurve';

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
/** Station platforms keep this far from a bluff's level crossing, so trains cross it at speed (m). */
const STATION_CROSSING_CLEAR = 250;

/** A station on one street block under the deck (render reads it from the 'station' hint). */
export interface StationPlan {
  /** Street edge under the station. */
  edge: number;
  /** Distance of the platform center along the area path (m). */
  deckS: number;
  /** Block midpoint on the street centerline. */
  mid: Vec2;
}

/**
 * Grid row of a node on the El's column: a grid junction's gj, a bend node's place between its
 * street's two junctions as a fraction (so a bluff's detour rows dj0..dj1 take in the bend nodes of
 * the streets between them), -1 for a node of a street that ends at no grid junction.
 */
export function nodeRow(g: RoadGraph, id: number): number {
  const n = g.nodes[id];
  if (n.gi >= 0) return n.gj;
  if (!n.bend || !n.edges.length) return -1;
  const c = chainOf(g, n.edges[0]);
  const r0 = g.nodes[c.nodes[0]].gj;
  const r1 = g.nodes[c.nodes[c.nodes.length - 1]].gj;
  const k = c.nodes.indexOf(id);
  if (r0 < 0 || r1 < 0 || k < 0) return -1;
  return r0 + ((r1 - r0) * k) / (c.nodes.length - 1);
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
      const grid = g.nodes.filter((n) => n.gi === i).sort((a, b) => a.gj - b.gj);
      // The column's streets are chains of pieces through bend nodes (roadGraph.ts): the deck follows
      // every node of them, and the pillars every piece.
      const edges: number[] = [];
      const nodes: RoadNode[] = [grid[0]];
      let streets = 0;
      for (let j = 0; j + 1 < grid.length; j++) {
        const c = gridChain(g, grid[j].id, grid[j + 1].id);
        if (c) {
          streets++;
          edges.push(...c.edges);
          for (let k = 1; k + 1 < c.nodes.length; k++) nodes.push(g.nodes[c.nodes[k]]);
        }
        nodes.push(grid[j + 1]);
      }
      if (nodes.some((n) => ctx.claims.node.has(n.id))) continue;
      if (streets < grid.length - 3) continue;
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
      // The run-offs carry on in the line of the end pieces (a column sweeps with the warp, roadGraph.ts).
      const ext = (p: Vec2, q: Vec2): Vec2 => {
        const l = Math.hypot(p.x - q.x, p.z - q.z) || 1;
        return { x: p.x + ((p.x - q.x) / l) * 70, z: p.z + ((p.z - q.z) / l) * 70 };
      };
      path.unshift(ext(path[0], path[1]));
      path.push(ext(path[path.length - 1], path[path.length - 2]));
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
      b.walls.push(...solidWalls(circlePolygon(x, z, r, 8), 'pillar', area.id));
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
    const dj0 = area.params.dj0 ?? Infinity;
    const dj1 = area.params.dj1 ?? -Infinity;
    const detoured = (row: number) => row >= dj0 && row <= dj1;
    for (const eid of area.edges) {
      const e = g.edges[eid];
      const a = g.nodes[e.a];
      const c = g.nodes[e.b];
      // On a bluff's detour the deck is off this street.
      if (detoured(nodeRow(g, e.a)) && detoured(nodeRow(g, e.b))) continue;
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
      // At a bend node (no junction) the pillars of the two pieces keep half a spacing from it each.
      const m0 = isBendNode(g, e.a) ? CFG.pillarSpacing / 2 : clearOf[e.a] + 2;
      const m1 = isBendNode(g, e.b) ? CFG.pillarSpacing / 2 : clearOf[e.b] + 2;
      for (const s of spread(len, m0, m1)) if (!st || Math.abs(s - len / 2) > zone) at(s);
      if (st) for (const k of [-1, 1]) at(len / 2 + k * (zone + 1.2));
    }
    // Over blocks without a street below: pillars on the deck line, buildings kept out.
    const nodes = area.nodes.map((id) => g.nodes[id]);
    const path = area.path;
    for (let j = 0; j + 1 < nodes.length; j++) {
      if (edgeBetween(g, nodes[j].id, nodes[j + 1].id) >= 0 || (detoured(nodeRow(g, nodes[j].id)) && detoured(nodeRow(g, nodes[j + 1].id)))) continue;
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
    // A bluff's detour: deck line columns where the deck stands high enough, buildings out of the way.
    const bluff = bluffOf(ctx.areas, area);
    if (bluff) {
      const bs = bluffShape(bluff);
      const ground = bluffGround(bs, createTerrain(ctx.seed));
      const levelA = { x: bluff.params.rowAx, z: bluff.params.rowAz };
      const levelB = { x: bluff.params.rowBx, z: bluff.params.rowBz };
      for (let j = dj0; j < dj1; j++) {
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
        // On the level stretch the deck is at the bluff's track level; the S curves either side
        // run from the street's height down to it, never lower over the low ground.
        const level = (j === dj0 + 1 || j === dj0 + 2) as boolean;
        for (const s of spread(len, 12)) {
          const x = p.x + ux * s;
          const z = p.z + uz * s;
          if (level && bs.y - ground(x, z) < CITY.districts.bluff.pillarMin) continue;
          pillar(x, z);
        }
      }
      b.hints.push({ kind: 'level', points: [levelA, levelB], values: [bs.y, CITY.districts.bluff.levelBlend] });
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
  // Node pairs j (deck segment path[j + 1] -> path[j + 2]) with a street below: the middle piece of
  // a street long enough, its length (junction to junction) what the stairs keep clear within.
  const cands: { j: number; edge: number; streetLen: number }[] = [];
  // A bluff's detour has no stations (its S curves carry the deck off the street and down to the
  // level), and the trains pass its level crossing at speed: platforms keep STATION_CROSSING_CLEAR from it.
  const dj0 = area.params.dj0 ?? Infinity;
  const dj1 = area.params.dj1 ?? -Infinity;
  const bluff = bluffOf(ctx.areas, area);
  for (let j = 1; j + 2 < nodes.length; j++) {
    const e = edgeBetween(g, nodes[j], nodes[j + 1]);
    if (e < 0 || g.edges[e].bridge) continue;
    // A station takes the middle piece of a long enough street (its pieces through bend nodes, roadGraph.ts).
    const street = chainOf(g, e);
    if (street.length < CFG.stationMinEdge || street.edges[street.edges.length >> 1] !== e) continue;
    const r0 = nodeRow(g, nodes[j]);
    const r1 = nodeRow(g, nodes[j + 1]);
    if (r0 >= dj0 && r0 <= dj1 && r1 >= dj0 && r1 <= dj1) continue;
    // Away from the map ends: not the first or last row's street.
    if (Math.min(r0, r1) < 1 || Math.max(r0, r1) > CITY.gridH - 2) continue;
    if (bluff) {
      const A = g.nodes[nodes[j]];
      const B = g.nodes[nodes[j + 1]];
      if (Math.hypot((A.x + B.x) / 2 - bluff.params.cx, (A.z + B.z) / 2 - bluff.params.cz) < STATION_CROSSING_CLEAR) continue;
    }
    cands.push({ j, edge: e, streetLen: street.length });
  }
  rng.shuffle(cands);
  const out: StationPlan[] = [];
  const used: number[] = [];
  const half = CFG.mezzanine / 2;
  for (const c of cands) {
    if (out.length >= want) break;
    // Stations at least three rows apart.
    if (used.some((j) => Math.abs(nodeRow(g, nodes[j]) - nodeRow(g, nodes[c.j])) < 3)) continue;
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
    // The stairs keep clear of the street's junctions (the piece's own ends are its bend nodes).
    let ok = c.streetLen / 2 - half - CFG.stairRun > STAIR_NODE_CLEAR;
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
      b.walls.push(...solidWalls(s.poly, 'pillar', area.id));
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

/**
 * The line's track curve, built the one way every consumer needs it: the
 * renderer (steel, trains), the sim's level crossings (gate timing) and the
 * tests. Stations from the build's 'station' hints, a bluff's level stretch
 * from its 'level' hint.
 */
export function elCurve(area: Area, build: AreaBuild, heightAt: (x: number, z: number) => number): RailCurve {
  const stations = build.hints.filter((h) => h.kind === 'station').map((h) => h.points[0]);
  const lv = build.hints.find((h) => h.kind === 'level');
  const level = lv ? { a: lv.points[0], b: lv.points[1], y: lv.values[0], blend: lv.values[1] } : undefined;
  return buildRailCurve(area.path, area.params.side, area.params.deckHeight, heightAt, stations, level);
}
