/**
 * Overpasses: structures you drive under. Nothing here carries cars; what
 * overhangs the street is render only and what stands on the ground is solid
 * and drawn. (Sign gantries belong to the elevated highway's deck, highway.ts,
 * not to the city streets.)
 *
 *  - 'viaduct': a short freeway viaduct crossing one to three streets
 *    mid-block, along the middle of a row or column of blocks between two
 *    block centers. At every street it crosses (steeply, clear of both
 *    junctions' reach) a hammerhead pier stands on each sidewalk behind the
 *    curb (solid, look 'pier'); inside the blocks round columns carry it
 *    every CFG.pierSpacing m, and at each end it lands on a solid abutment.
 *    Buildings are kept out from under the deck, and the building line where
 *    it passes takes the look 'pier' too (a fenced retaining wall between
 *    the piers, drawn by the renderer) instead of a void the infill would
 *    fill. It only crosses plain streets (no alleys, ramps or bridges) and
 *    only unclaimed blocks, and keeps away from the river, the El, hill
 *    slopes, roundabouts and the other structures (structures.ts).
 *
 * The renderer (render/districts/overpass.ts) draws decks, girders, lamps
 * and signs from the area params, path and props.
 */
import { CITY } from '../config';
import type { RoadEdge, RoadGraph } from '../roadGraph';
import { computeMouths } from '../blocks';
import type { EdgeMouths } from '../blocks';
import { DEG, Vec2, abs, distToSegment, sin, yawOf } from '../../sim/math';
import type { Area, AreaBuild, DistrictModule, PlanContext } from './types';
import { emptyBuild } from './types';
import { circlePolygon, pointInPolygon, polygonBounds, solidWalls } from './geom';
import { ON_ROUTE, SiteHazards, TRAFFIC_FLOOR, corridorGap, raceStreets, junctionReach, routeTraffic, siteClear, siteHazards, streetEdges, takePath } from './structures';
import { chainCum, chainOf } from '../roadGraph';

const CFG = CITY.districts.overpass;

/** Street kinds a viaduct crosses. */
const KINDS = new Set<RoadEdge['kind']>(['street', 'avenue', 'diagonal', 'boulevard']);
/** Round column radius inside the blocks (m). */
const COLUMN_R = 0.9;
/** Candidate viaduct lines tried per city. */
const VIADUCT_TRIES = 80;

/** A viaduct deck from (x0, z0) to (x1, z1), from the area params. */
export interface ViaductShape {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Unit direction from end 0 to end 1, and the length (m). */
  ux: number;
  uz: number;
  length: number;
  /** Deck half width (m), underside above the highest road it crosses (m), girder depth (m). */
  half: number;
  clearance: number;
  depth: number;
}

export function viaductShape(a: Area): ViaductShape {
  const p = a.params;
  const length = Math.hypot(p.x1 - p.x0, p.z1 - p.z0) || 1;
  return { x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, ux: (p.x1 - p.x0) / length, uz: (p.z1 - p.z0) / length, length, half: p.half, clearance: p.clearance, depth: p.depth };
}

/** Where a viaduct crosses a street: the edge, the crossing point and the sine of the crossing angle. */
interface Crossing {
  edge: number;
  x: number;
  z: number;
  /** Distance of the crossing along the deck from end 0 (m). */
  s: number;
  sin: number;
}

/** Proper intersection of segments p0p1 and ab: t along p0p1 and s along ab (both 0..1), or null. */
function crossT(p0: Vec2, p1: Vec2, a: Vec2, b: Vec2): { t: number; s: number } | null {
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const ex = b.x - a.x;
  const ez = b.z - a.z;
  const den = dx * ez - dz * ex;
  if (abs(den) < 1e-9) return null;
  const t = ((a.x - p0.x) * ez - (a.z - p0.z) * ex) / den;
  const s = ((a.x - p0.x) * dz - (a.z - p0.z) * dx) / den;
  return t > 0 && t < 1 && s > 0 && s < 1 ? { t, s } : null;
}

/** Off every road by `margin` beyond its curb, and off every sidewalk but those of the `own` edges (a street's pieces, roadGraph.ts), as the El's columns (subway.ts). */
function offRoads(g: RoadGraph, x: number, z: number, margin: number, own: ReadonlySet<number> = new Set()): boolean {
  for (const e of g.edges) {
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
    if (d < e.width / 2 + margin) return false;
    if (!own.has(e.id) && d < e.width / 2 + e.sidewalk + margin + 0.6) return false;
  }
  return true;
}

/** Oriented rectangle centered at c: `len` along (ux, uz), `wid` across. */
function centeredRect(c: Vec2, ux: number, uz: number, len: number, wid: number): Vec2[] {
  const hl = len / 2;
  const hw = wid / 2;
  return [
    { x: c.x - ux * hl + uz * hw, z: c.z - uz * hl - ux * hw },
    { x: c.x + ux * hl + uz * hw, z: c.z + uz * hl - ux * hw },
    { x: c.x + ux * hl - uz * hw, z: c.z + uz * hl + ux * hw },
    { x: c.x - ux * hl - uz * hw, z: c.z - uz * hl + ux * hw },
  ];
}

export const overpassModule: DistrictModule = {
  kind: 'overpass',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const mouths = computeMouths(g, ctx.sectors());
    const hz = siteHazards(ctx);
    // The race's own streets first, then busy ones: an overpass only matters when races run under it.
    const traffic = routeTraffic(g, ctx.seed);
    const race = raceStreets(ctx);
    if (rng.chance(CFG.viaductChance)) planViaduct(ctx, hz, mouths, traffic, race);
  },

  build(ctx, area) {
    return buildViaduct(ctx.graph, area);
  },
};

/** Plan one viaduct along the middle of a row or column of blocks, if a line fits. */
function planViaduct(ctx: PlanContext, hz: SiteHazards, mouths: EdgeMouths[], traffic: Float64Array, race: { route: Set<number>; ends: Set<number> }): void {
  const g = ctx.graph;
  const rng = ctx.rng;
  const W = CITY.gridW;
  const H = CITY.gridH;
  const node = (i: number, j: number) => g.nodes[j * W + i];
  /** Center of the grid cell with corner (i, j). */
  const cell = (i: number, j: number): Vec2 => {
    const ps = [node(i, j), node(i + 1, j), node(i, j + 1), node(i + 1, j + 1)];
    return { x: (ps[0].x + ps[1].x + ps[2].x + ps[3].x) / 4, z: (ps[0].z + ps[1].z + ps[2].z + ps[3].z) / 4 };
  };
  const faces = ctx.faces().filter((f) => !f.outer);
  const faceBounds = faces.map((f) => polygonBounds(f.ring));
  const faceAt = (x: number, z: number): number => {
    for (let i = 0; i < faces.length; i++) {
      const bb = faceBounds[i];
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
      if (pointInPolygon(x, z, faces[i].ring)) return faces[i].id;
    }
    return -1;
  };
  const half = CFG.deckWidth / 2;
  const minSin = sin(CFG.minCrossDeg * DEG);
  let best: { p0: Vec2; p1: Vec2; crossings: Crossing[]; score: number; footprint: number } | null = null;
  for (let attempt = 0; attempt < VIADUCT_TRIES; attempt++) {
    const k = rng.int(CFG.crossings[0], CFG.crossings[1]);
    const rows = rng.chance(0.5);
    // A line between two cell centers k cells apart: across k streets of the other direction.
    const i0 = rng.int(0, (rows ? W : H) - 2 - k);
    const j = rng.int(0, (rows ? H : W) - 2);
    const p0 = rows ? cell(i0, j) : cell(j, i0);
    const p1 = rows ? cell(i0 + k, j) : cell(j, i0 + k);
    const length = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (length < 60) continue;
    const ux = (p1.x - p0.x) / length;
    const uz = (p1.z - p0.z) / length;
    const crossings: Crossing[] = [];
    let ok = true;
    // The streets it crosses: a street is a chain of pieces through bend nodes (roadGraph.ts), so
    // the junction reach is measured along the whole street, and the street's other pieces are not
    // "streets beside the deck".
    const crossed = new Set<number>();
    for (const e of g.edges) {
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const hit = crossT(p0, p1, A, B);
      if (!hit) continue;
      if (!KINDS.has(e.kind) || e.bridge || e.shortcut) ok = false;
      const sn = abs(ux * (B.z - A.z) - uz * (B.x - A.x)) / (e.length || 1);
      if (sn < minSin) ok = false;
      // The deck and the piers under it stay clear of both junctions' reach.
      const along = half / Math.max(sn, 1e-3) + CFG.pierLength / 2 + 2;
      const street = chainOf(g, e.id);
      const cum = chainCum(g, street);
      const k = street.edges.indexOf(e.id);
      const sAlong = cum[k] + (e.a === street.nodes[k] ? hit.s : 1 - hit.s) * e.length;
      if (sAlong < junctionReach(g, mouths, g.edges[street.edges[0]], street.nodes[0]) + along) ok = false;
      if (street.length - sAlong < junctionReach(g, mouths, g.edges[street.edges[street.edges.length - 1]], street.nodes[street.nodes.length - 1]) + along) ok = false;
      if (ctx.claims.edge.has(e.id) || race.ends.has(e.id)) ok = false;
      for (const id of street.edges) crossed.add(id);
      crossings.push({ edge: e.id, x: p0.x + (p1.x - p0.x) * hit.t, z: p0.z + (p1.z - p0.z) * hit.t, s: hit.t * length, sin: sn });
      if (!ok) break;
    }
    for (const e of ok ? g.edges : []) {
      if (crossed.has(e.id)) {
        // A crossed street's pieces pass under the deck, but never under an end abutment (a diagonal
        // crossed near one end runs its next piece on past it).
        const A = g.nodes[e.a];
        const B = g.nodes[e.b];
        const keep = e.width / 2 + e.sidewalk + Math.hypot(CFG.abutment, half) + 1;
        if (distToSegment(p0.x, p0.z, A.x, A.z, B.x, B.z) < keep || distToSegment(p1.x, p1.z, A.x, A.z, B.x, B.z) < keep) {
          ok = false;
          break;
        }
        continue;
      }
      // Not crossed: the deck and its abutments keep clear of this street's corridor.
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const d = Math.min(distToSegment(p0.x, p0.z, A.x, A.z, B.x, B.z), distToSegment(p1.x, p1.z, A.x, A.z, B.x, B.z), distToSegment(A.x, A.z, p0.x, p0.z, p1.x, p1.z), distToSegment(B.x, B.z, p0.x, p0.z, p1.x, p1.z));
      if (d < e.width / 2 + e.sidewalk + half + 4) {
        ok = false;
        break;
      }
    }
    if (!ok || !crossings.length) continue;
    // Clear of the river, the El, hills, roundabouts and the other structures; only unclaimed blocks.
    for (let s = 0; s <= length + 1e-9 && ok; s += 5) {
      for (const v of [-half, 0, half]) {
        const x = p0.x + ux * s - uz * v;
        const z = p0.z + uz * s + ux * v;
        if (!siteClear(hz, x, z, 12)) {
          ok = false;
          break;
        }
        if (v === 0 && corridorGap(g, x, z) > 0) {
          const f = faceAt(x, z);
          if (f < 0 || ctx.claims.face.has(f)) {
            ok = false;
            break;
          }
        }
      }
    }
    if (!ok) continue;
    const footprint = length * CFG.deckWidth;
    if (ctx.budget.used + footprint > ctx.budget.total) continue;
    // Score: the traffic of the streets it crosses, jittered so the best line is not always the same kind.
    let score = 0;
    for (const c of crossings) score += TRAFFIC_FLOOR + traffic[c.edge] + (race.route.has(c.edge) ? ON_ROUTE : 0);
    score *= 0.7 + 0.6 * rng.next();
    if (!best || score > best.score) best = { p0, p1, crossings, score, footprint };
  }
  if (!best) return;
  const { p0, p1, crossings, footprint } = best;
  const length = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  const ux = (p1.x - p0.x) / length;
  const uz = (p1.z - p0.z) / length;
  crossings.sort((a, b) => a.s - b.s);
  const left = [
    { x: p0.x + uz * half, z: p0.z - ux * half },
    { x: p1.x + uz * half, z: p1.z - ux * half },
  ];
  const right = [
    { x: p1.x - uz * half, z: p1.z + ux * half },
    { x: p0.x - uz * half, z: p0.z + ux * half },
  ];
  ctx.addArea(
    {
      kind: 'overpass',
      variant: 'viaduct',
      polygon: [...left, ...right],
      path: [p0, p1],
      nodes: [],
      edges: crossings.map((c) => c.edge),
      faces: [],
      params: { x0: p0.x, z0: p0.z, x1: p1.x, z1: p1.z, half, clearance: CFG.deckClearance, depth: CFG.deckDepth, crossings: crossings.length, reach: half + 3, seed: rng.int(1, 0x7ffffffe) },
    },
    footprint,
  );
  takePath(hz.taken, [p0, p1], half + 3);
}

function buildViaduct(g: RoadGraph, area: Area): AreaBuild {
  const b = emptyBuild();
  const v = viaductShape(area);
  const at = (s: number, lat = 0): Vec2 => ({ x: v.x0 + v.ux * s - v.uz * lat, z: v.z0 + v.uz * s + v.ux * lat });
  const yaw = yawOf(v.ux, v.uz);
  const placed: Vec2[] = [];
  // Hammerhead piers on the sidewalks of every street it crosses, square to the street.
  for (const eid of area.edges) {
    const e = g.edges[eid];
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const hit = crossT(at(0), at(v.length), A, B);
    if (!hit) continue;
    const ex = (B.x - A.x) / (e.length || 1);
    const ez = (B.z - A.z) / (e.length || 1);
    const sn = abs(v.ux * ez - v.uz * ex);
    const off = (e.width / 2 + CFG.pierSetback) / Math.max(sn, 1e-3);
    for (const k of [-1, 1]) {
      const c = at(hit.t * v.length + k * off);
      if (!offRoads(g, c.x, c.z, CFG.pierThick / 2 + 0.3, streetEdges(g, eid))) continue;
      b.walls.push(...solidWalls(centeredRect(c, ex, ez, CFG.pierLength, CFG.pierThick), 'pier', area.id));
      b.reserved.push({ x: c.x, z: c.z, r: CFG.pierLength / 2 + 0.6 });
      b.props.push({ kind: 'pier', x: c.x, z: c.z, yaw: yawOf(ex, ez), size: CFG.pierLength / 2, height: CFG.pierThick / 2, area: area.id });
      placed.push(c);
    }
  }
  // Abutments at both ends, inside the blocks.
  for (const s0 of [0, v.length - CFG.abutment]) {
    const c = at(s0 + CFG.abutment / 2);
    b.walls.push(...solidWalls(centeredRect(c, v.ux, v.uz, CFG.abutment, v.half * 2), 'pier', area.id));
    b.props.push({ kind: 'abutment', x: c.x, z: c.z, yaw, size: CFG.abutment / 2, height: v.half, area: area.id });
    placed.push(c);
  }
  // Round columns inside the blocks, clear of every corridor and of the other supports.
  const n = Math.max(1, Math.round(v.length / CFG.pierSpacing));
  for (let i = 1; i < n; i++) {
    const c = at((v.length * i) / n);
    if (corridorGap(g, c.x, c.z) < COLUMN_R + 2.5) continue;
    if (placed.some((p) => (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < 12 * 12)) continue;
    b.walls.push(...solidWalls(circlePolygon(c.x, c.z, COLUMN_R, 8), 'pier', area.id));
    b.props.push({ kind: 'column', x: c.x, z: c.z, yaw, size: COLUMN_R, height: 0, area: area.id });
    placed.push(c);
  }
  // No buildings under the deck, and where it passes over a building line that line is the viaduct's.
  const strip = [at(-1, -(v.half + 2)), at(v.length + 1, -(v.half + 2)), at(v.length + 1, v.half + 2), at(-1, v.half + 2)];
  b.exclusions.push(strip);
  b.frontLooks.push({ polygon: strip, look: 'pier', area: area.id });
  return b;
}
