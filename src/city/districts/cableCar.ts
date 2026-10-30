/**
 * The San Francisco cable car's line (sf home seeds only, city/regions.ts homeOf): one street between two
 * junctions gets a single track down its middle, a terminal at each end, and a car shuttling between them on a
 * timetable (sim/cableCar.ts) that shares the road with everyone else.
 *
 * Which street: a street (a chain of pieces through bend nodes) whose ends are both junctions, whose every piece is
 * a plain street or avenue that no district holds, that touches no node of either route (so the route, its closed
 * side streets and the meets behind their barriers are all elsewhere, in a race and in free roam alike, both of
 * which drive the route's streets) and that is long enough to be a ride. Of those, one that climbs a hills district
 * (an end or its middle on a hill) by at least `hillRise` wins, the one that climbs most; else the steepest plain
 * one. Heights come from the hills planned so far built into a terrain of their own (the same pure builds and
 * terrain the world folds them into later), since the graph phase has no terrain yet.
 *
 * What it builds: the track runs down the centreline from just short of where the traffic lanes end at one
 * junction (terminalGap before them, so the car never stands in a junction box) to the same point at the other; it
 * is the area's `path`, resampled every couple of metres and eased through the bend nodes so the car's heading
 * turns smoothly. The car's stops are its ends (sim/cableCar.ts puts the car's end at the path's end). The road
 * surface is unchanged: rails and the cable slot are paint and a thin mesh (render/districts/cableCar.ts). At each
 * terminal a small waiting shelter stands on the sidewalk beside the stop (a convex solid, wall look 'cableCar',
 * with a reserved circle so streetlights and furniture keep off it), and a turntable is set flush in the road
 * under the stop (drawn only: the car is double ended, as the California Street cars are, and reverses rather than
 * turning, which keeps its swept body inside the track's strip, clear of the lanes).
 *
 * The lanes keep clear by construction: the track's strip (stripHalf either side of the centreline) leaves a full
 * lane each side on a street or an avenue, the traffic network moves a lane out if one ever would not
 * (sim/traffic/net.ts), kerb parking keeps off the line's street (PARKING.offAreas reads the area's polygon, the
 * carriageway), and neither sidewalk trees nor power poles stand on a street a district holds.
 */
import { CITY } from '../config';
import type { RoadGraph } from '../roadGraph';
import { chains, isBendNode, isChannelEdge } from '../roadGraph';
import { computeMouths } from '../blocks';
import { createTerrain } from '../terrain';
import { homeOf } from '../regions';
import { atan2, sqrt, type Vec2 } from '../../sim/math';
import { pointInPolygon, rectPolygon, solidWalls } from './geom';
import { hillsModule } from './hills';
import type { Area, AreaBuild, BuildContext, DistrictModule, HeightMod, PlanContext } from './types';
import { emptyBuild } from './types';

const CFG = CITY.districts.cableCar;
/** Path sample spacing (m) and the easing passes through the bend nodes. */
const STEP = 2;
const EASE = 3;
/** The traffic lanes end this far past a junction's curb corner, and at least LANE_MIN from its node (sim/traffic TRAFFIC_LAYOUT setbackMargin, setbackMin). */
const LANE_MARGIN = 1.2;
const LANE_MIN = 4;

/** Where the traffic lanes of an edge end at node `n`, measured along the street from it (m). */
function laneEnd(g: RoadGraph, mouths: ReturnType<typeof computeMouths>, eid: number, n: number): number {
  const e = g.edges[eid];
  const N = g.nodes[n];
  const O = g.nodes[e.a === n ? e.b : e.a];
  const len = sqrt((O.x - N.x) ** 2 + (O.z - N.z) ** 2) || 1;
  const sx = (O.x - N.x) / len;
  const sz = (O.z - N.z) / len;
  const m = mouths[eid];
  const pts = e.a === n ? [m.aP.curb, m.aN.curb] : [m.bP.curb, m.bN.curb];
  let t = 0;
  for (const p of pts) t = Math.max(t, (p.x - N.x) * sx + (p.z - N.z) * sz);
  if (N.ring) t = Math.max(t, N.ring.outer);
  return Math.max(LANE_MIN, t + LANE_MARGIN);
}

/** The chain's centreline from `s0` m after its first node to `s1` m before its last, resampled and eased. */
function trackPath(g: RoadGraph, nodes: number[], s0: number, s1: number): Vec2[] {
  const pts = nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
  const total = cum[cum.length - 1];
  const at = (s: number): Vec2 => {
    let i = 0;
    while (i < pts.length - 2 && s > cum[i + 1]) i++;
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t };
  };
  const a = s0;
  const b = total - s1;
  const n = Math.max(2, Math.ceil((b - a) / STEP));
  let out: Vec2[] = [];
  for (let k = 0; k <= n; k++) out.push(at(a + ((b - a) * k) / n));
  // Ease the kinks at the bend nodes (a few degrees each): neighbour averaging, ends held.
  for (let pass = 0; pass < EASE; pass++) out = out.map((p, k) => (k === 0 || k === out.length - 1 ? p : { x: (out[k - 1].x + 2 * p.x + out[k + 1].x) / 4, z: (out[k - 1].z + 2 * p.z + out[k + 1].z) / 4 }));
  return out;
}

/** A strip `half` m either side of a polyline, as one closed polygon (left side out, right side back). */
function stripPolygon(path: Vec2[], half: number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let k = 0; k < path.length; k++) {
    const p = path[Math.max(0, k - 1)];
    const q = path[Math.min(path.length - 1, k + 1)];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
    const nx = -(q.z - p.z) / l;
    const nz = (q.x - p.x) / l;
    left.push({ x: path[k].x + nx * half, z: path[k].z + nz * half });
    right.push({ x: path[k].x - nx * half, z: path[k].z - nz * half });
  }
  return [...left, ...right.reverse()];
}

function plan(ctx: PlanContext): void {
  if (!CFG.enabled || homeOf(ctx.seed) !== 'sf') return;
  const g = ctx.graph;
  const kinds = new Set<string>(CFG.kinds);
  const routeNodes = new Set<number>((ctx.event?.routes ?? []).flatMap((r) => r.nodes));
  // The ground so far: the hills planned before this module, built as the world will build them.
  const hills = ctx.areas.filter((a) => a.kind === 'hills');
  const sectors = ctx.sectors();
  const mouths = computeMouths(g, sectors);
  const bctx: BuildContext = { seed: ctx.seed, graph: g, areas: ctx.areas, faces: ctx.faces(), sectors, mouths };
  const mods: HeightMod[] = hills.flatMap((a) => hillsModule.build(bctx, a).heightMods);
  const terrain = createTerrain(ctx.seed, mods);
  type Pick = { nodes: number[]; edges: number[]; length: number; rise: number; grade: number; hill: boolean };
  let best: Pick | null = null;
  const better = (c: Pick, b: Pick | null): boolean => {
    if (!b) return true;
    if (c.hill !== b.hill) return c.hill;
    return c.hill ? c.rise > b.rise : c.grade > b.grade;
  };
  for (const c of chains(g)) {
    const first = c.nodes[0];
    const last = c.nodes[c.nodes.length - 1];
    if (first === last || g.nodes[first].edges.length < 3 || g.nodes[last].edges.length < 3 || isBendNode(g, last)) continue;
    if (c.length < CFG.length[0] || c.length > CFG.length[1]) continue;
    if (c.nodes.some((n) => routeNodes.has(n) || ctx.claims.node.has(n) || !!g.nodes[n].ring)) continue;
    const ok = c.edges.every((id) => {
      const e = g.edges[id];
      return kinds.has(e.kind) && !e.shortcut && !e.bridge && !isChannelEdge(e) && !ctx.claims.edge.has(id) && e.sidewalk >= CFG.minSidewalk && e.width / 2 >= CFG.stripHalf + CFG.laneRoom;
    });
    if (!ok) continue;
    const A = g.nodes[first];
    const B = g.nodes[last];
    const mid = g.nodes[c.nodes[c.nodes.length >> 1]];
    const rise = Math.abs(terrain.heightAt(B.x, B.z) - terrain.heightAt(A.x, A.z));
    const onHill = (x: number, z: number) => hills.some((a) => pointInPolygon(x, z, a.polygon));
    const pick: Pick = { nodes: c.nodes, edges: c.edges, length: c.length, rise, grade: rise / c.length, hill: rise >= CFG.hillRise && (onHill(A.x, A.z) || onHill(B.x, B.z) || onHill(mid.x, mid.z)) };
    if (better(pick, best)) best = pick;
  }
  if (!best) return;
  const e0 = best.edges[0];
  const e1 = best.edges[best.edges.length - 1];
  const s0 = laneEnd(g, mouths, e0, best.nodes[0]) + CFG.terminalGap;
  const s1 = laneEnd(g, mouths, e1, best.nodes[best.nodes.length - 1]) + CFG.terminalGap;
  const path = trackPath(g, best.nodes, s0, s1);
  const half = Math.min(...best.edges.map((id) => g.edges[id].width)) / 2;
  // Each terminal's shelter goes on a seeded side (1: left of the walk from the first terminal to the second).
  const sideA = ctx.rng.next() < 0.5 ? 1 : -1;
  const sideB = ctx.rng.next() < 0.5 ? 1 : -1;
  ctx.addArea({
    kind: 'cableCar',
    variant: 'line',
    polygon: stripPolygon(path, half),
    path,
    nodes: [],
    edges: best.edges,
    faces: [],
    params: { rise: best.rise, hill: best.hill ? 1 : 0, sideA, sideB, first: best.nodes[0], last: best.nodes[best.nodes.length - 1] },
  });
}

/** Unit direction of the path at its end `end` (0: the first terminal, pointing into the line; 1: the last, pointing out of it). */
function endDir(path: Vec2[], end: 0 | 1): Vec2 {
  const [p, q] = end === 0 ? [path[0], path[Math.min(3, path.length - 1)]] : [path[Math.max(0, path.length - 4)], path[path.length - 1]];
  const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
  return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
}

/** A terminal's shelter footprint: beside the stop, on its side's sidewalk (convex, for solidWalls). */
export function shelterFootprint(g: RoadGraph, area: Area, end: 0 | 1): Vec2[] {
  const S = CFG.shelter;
  const path = area.path;
  const u = endDir(path, end);
  // From the track's end, into the line: the shelter's near edge half a metre in.
  const ux = end === 0 ? u.x : -u.x;
  const uz = end === 0 ? u.z : -u.z;
  const P = end === 0 ? path[0] : path[path.length - 1];
  const side = (end === 0 ? area.params.sideA : area.params.sideB) * (end === 0 ? 1 : -1);
  // Left of travel along (ux, uz) is (-uz, ux).
  const lx = -uz * side;
  const lz = ux * side;
  const e = g.edges[end === 0 ? area.edges[0] : area.edges[area.edges.length - 1]];
  const back = e.width / 2 + S.back;
  const o = { x: P.x + ux * 0.5 + lx * back, z: P.z + uz * 0.5 + lz * back };
  return rectPolygon(o, { x: ux, z: uz }, { x: lx, z: lz }, S.length, S.depth);
}

function build(ctx: BuildContext, area: Area): AreaBuild {
  const b = emptyBuild();
  const S = CFG.shelter;
  for (const end of [0, 1] as const) {
    const poly = shelterFootprint(ctx.graph, area, end);
    for (const w of solidWalls(poly, 'cableCar', area.id)) b.walls.push(w);
    let cx = 0;
    let cz = 0;
    for (const p of poly) {
      cx += p.x;
      cz += p.z;
    }
    b.reserved.push({ x: cx / poly.length, z: cz / poly.length, r: S.length / 2 + S.clear });
  }
  return b;
}

/** Heading (rad) of the track at its first terminal, into the line. */
export function lineHeading(area: Area): number {
  const u = endDir(area.path, 0);
  return atan2(u.x, u.z);
}

export const cableCarModule: DistrictModule = { kind: 'cableCar', phase: 'graph', plan, build };
