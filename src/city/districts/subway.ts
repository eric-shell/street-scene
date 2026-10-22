/**
 * Subway: an elevated railway ("the El") crossing the whole map south to
 * north as one continuous line. It follows a north-south street column over
 * the curb lane on one side (the pillar side), runs straight over a block
 * where that street is missing, and once or twice per seed swings to the
 * neighbouring column through the blocks: an S curve (a cubic) that leaves
 * its street just past a junction, tangent to it, crosses the row streets
 * between the two columns mid block at a skew (about 40 degrees off square
 * over two rows, 25 over three) and joins the next street tangent to it. The
 * deck carries two tracks; trains run both ways on a timetable, render only
 * (railTimetable.ts, render/trains.ts), so nothing here moves.
 *
 * The path (area.path) is the planned polyline, south run-off to north
 * run-off: one anchor where the line crosses every grid row's street line
 * (params.at<row> is its index), the curb lane point of every bend node
 * along a street it follows, and the S curves' samples. params.col<row> is
 * the column the line's street is on at that row, -1 inside a swing. Streets
 * are walked by geometry (streetChain), through the bend and split nodes
 * other passes put on them (gi -1), never by grid neighbours; railCurve.ts
 * resamples and smooths the path into the track curve every consumer rides
 * (elCurve is the one place it is built).
 *
 * What the sim sees (the build, which walks the streets again on the final
 * graph, back alley splits and all):
 *  - support columns, each a wall with look 'pillar' on a concrete footing
 *    (street furniture keeps clear of them): on the pillar side sidewalk
 *    along every street the deck follows; on the deck line through the
 *    blocks (a swing, a missing street, a bluff's detour), with a pier on
 *    each sidewalk of every street the deck crosses. Never on a road, never
 *    where two streets' corridors merge, clear of every junction's closure
 *    reach and of the river channel;
 *  - stations: one or two street blocks on straight stretches (the platform
 *    and the track's swing-outs on street the deck follows, never on a swing
 *    or a bluff's detour) get a station house under the deck with a stair
 *    down to each side on the pillar side sidewalk; the stairs are solid to
 *    the ground (walls with look 'pillar'), the house and platforms overhead
 *    never collide;
 *  - exclusions: buildings and infill keep off the deck's right of way
 *    wherever it is off its street (the frontage there closes with the
 *    city's low boundary wall, so a block stays a block).
 * The planner claims the nodes and edges of the streets it follows (no
 * roundabouts, alleys or markets there) and, apart from area.edges (the
 * streets under the deck, which the event flavours read), the row streets
 * a swing crosses: no monument plaza in a swing's blocks, no roundabout at
 * their ends, no market pens where the piers stand.
 *
 * A bluff (districts/bluff.ts, planned later) may move a straight stretch of
 * the line off its street onto a right of way through the blocks and hold it
 * level there: it asks elColumnAt for a stretch on one column, moves the row
 * anchors with applyElDetour (params.bluff, dj0..dj1), and the build gives
 * the detour deck line columns where the deck stands high enough above the
 * bluff's ground and a 'level' hint carrying the track level to the curve.
 */
import { CITY, ROUTE } from '../config';
import { otherNode } from '../roadGraph';
import type { RoadGraph, RoadNode } from '../roadGraph';
import { Vec2, atan2, distToSegment, sqrt, yawOf } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { Area, AreaBuild, BuildContext, DistrictModule, PlanContext } from './types';
import { emptyBuild } from './types';
import { circlePolygon, solidWalls } from './geom';
import { riverCenter } from './river';
import { bluffGround, bluffOf, bluffShape } from './bluff';
import { createTerrain } from '../terrain';
import { RAIL, RailCurve, buildRailCurve, curvePoint, projectOnCurve, sampleCurve } from '../railCurve';

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
/** A swing crosses a row street at least this far from the junctions at both its ends (m). */
const CROSS_NODE_CLEAR = 30;
/** A swing keeps this far from a diagonal avenue (m): its junctions with the grid lie inside the swing's blocks. */
const DIAGONAL_CLEAR = 40;
/** A swing keeps this far beyond a river channel's top edge (m): the line crosses the river straight, on its street. */
const RIVER_CLEAR = 25;
/** The deck's exclusion strip starts this far into an off-street run (m, still inside the junction it leaves). */
const STRIP_IN = 6;
/** A crossed street's piers are looked for up to this far along the deck from the crossing (m). */
const PIER_SEARCH = 60;
/** Deck line columns closer than this along the deck are one column (m). */
const SPOT_MERGE = 3;
/** At most this many street blocks of the line may have no street under the deck (it runs straight through). */
const MAX_MISSING = 2;
/** Run-off straight on past each end node, so the portals' ramps start outside the map (m). */
const RUN_OFF = 70;
/** Straight deck a train has between a swing's end and the junction: the lead less the curve's last easing (m). */
const SWING_STRAIGHT = CFG.swingLead - 10;
/** A station's platform sits on straight deck with this much to spare at each end (m); the track's swing-outs beyond may run into a curve's easing. */
const PLATFORM_CLEAR = 10;

/** A station on one street block under the deck (render reads it from the 'station' hint). */
export interface StationPlan {
  /** Row interval (j, j + 1) of the block. */
  j: number;
  /** Platform center along the block's street (m from its south node) and the street edge under it. */
  s: number;
  edge: number;
  /** Distance of the platform center along the track curve (m). */
  deckS: number;
  /** Block midpoint on the street centerline. */
  mid: Vec2;
}

/** A swing: the line leaves column `from` at row j0 and joins column `to` at row j1. */
interface Swing {
  j0: number;
  j1: number;
  from: number;
  to: number;
}

/** A street anchor: the deck's point over the curb lane at a node, the street's direction there and its width. */
interface Anchor {
  p: Vec2;
  t: Vec2;
  w: number;
}

/** A street walked node to node: its nodes, the edges between them and the distance along it at each node. */
interface Chain {
  nodes: number[];
  edges: number[];
  cum: number[];
  length: number;
}

/** A street block the deck follows: row interval (j, j + 1) and its chain. */
interface StreetRun extends Chain {
  j: number;
}

/** A planned line before it is an area. */
interface LinePlan {
  path: Vec2[];
  /** Path index of every row's anchor. */
  at: number[];
  cols: number[];
  nodes: number[];
  edges: number[];
  /** Row streets the swings cross. */
  crossed: number[];
  length: number;
  swings: number;
}

/** The grid node at column i, row j. */
export function gridNode(g: RoadGraph, i: number, j: number): RoadNode {
  const guess = g.nodes[j * CITY.gridW + i];
  if (guess && guess.gi === i && guess.gj === j) return guess;
  for (const n of g.nodes) if (n.gi === i && n.gj === j) return n;
  throw new Error(`no grid node at column ${i}, row ${j}`);
}

/** The street edge joining two adjacent nodes (never a shortcut), or -1. */
function edgeJoining(g: RoadGraph, a: number, b: number): number {
  for (const eid of g.nodes[a].edges) {
    const e = g.edges[eid];
    if (e.shortcut) continue;
    if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return eid;
  }
  return -1;
}

/**
 * The nodes from grid node `from` to grid node `to` along one street, through
 * the off-grid bend and split nodes between them (gi -1), or null when no
 * street joins them. At each node the street goes on along the edge whose far
 * node makes progress along the chord and lies nearest it: a back alley or a
 * route shortcut leaves for the block (and is a shortcut edge, never taken),
 * a crossing street's far end is another grid node, a diagonal's first bend
 * sits well off the chord. Channel and ramp edges never count.
 */
export function streetChain(g: RoadGraph, from: number, to: number): number[] | null {
  const A = g.nodes[from];
  const B = g.nodes[to];
  const L = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
  const ux = (B.x - A.x) / L;
  const uz = (B.z - A.z) / L;
  const along = (n: RoadNode) => (n.x - A.x) * ux + (n.z - A.z) * uz;
  const across = (n: RoadNode) => Math.abs(-(n.x - A.x) * uz + (n.z - A.z) * ux);
  const out = [from];
  let cur = from;
  let prev = -1;
  for (let guard = 0; guard < 64 && cur !== to; guard++) {
    let best = -1;
    let bestAcross = Infinity;
    const here = along(g.nodes[cur]);
    for (const eid of g.nodes[cur].edges) {
      const e = g.edges[eid];
      if (e.shortcut || e.kind === 'channel' || e.kind === 'ramp') continue;
      const far = otherNode(e, cur);
      if (far === prev) continue;
      const F = g.nodes[far];
      if (far !== to && F.gi >= 0) continue;
      if (along(F) <= here + 0.5) continue;
      const d = across(F);
      if (d < bestAcross && d < L / 2) {
        bestAcross = d;
        best = far;
      }
    }
    if (best < 0) return null;
    prev = cur;
    cur = best;
    out.push(cur);
  }
  return cur === to ? out : null;
}

function chainOf(g: RoadGraph, nodes: number[]): Chain {
  const edges: number[] = [];
  const cum = [0];
  for (let k = 0; k + 1 < nodes.length; k++) {
    edges.push(edgeJoining(g, nodes[k], nodes[k + 1]));
    const a = g.nodes[nodes[k]];
    const b = g.nodes[nodes[k + 1]];
    cum.push(cum[k] + sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2));
  }
  return { nodes, edges, cum, length: cum[cum.length - 1] };
}

/** The point `s` along a chain, the street's unit direction there, its width and edge. */
function alongChain(g: RoadGraph, ch: Chain, s: number): { x: number; z: number; dx: number; dz: number; w: number; edge: number } {
  let k = 0;
  while (k + 2 < ch.cum.length && ch.cum[k + 1] < s) k++;
  const a = g.nodes[ch.nodes[k]];
  const b = g.nodes[ch.nodes[k + 1]];
  const len = ch.cum[k + 1] - ch.cum[k] || 1;
  const dx = (b.x - a.x) / len;
  const dz = (b.z - a.z) / len;
  const t = s - ch.cum[k];
  const e = ch.edges[k];
  return { x: a.x + dx * t, z: a.z + dz * t, dx, dz, w: e >= 0 ? g.edges[e].width : CITY.width.street, edge: e };
}

/** Deck outline polygon around a path (half width hw). */
export function deckOutline(path: readonly Vec2[], hw: number): Vec2[] {
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  path.forEach((p, j) => {
    const a = path[Math.max(0, j - 1)];
    const b = path[Math.min(path.length - 1, j + 1)];
    const l = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    const nx = -(b.z - a.z) / l;
    const nz = (b.x - a.x) / l;
    left.push({ x: p.x + nx * hw, z: p.z + nz * hw });
    right.push({ x: p.x - nx * hw, z: p.z - nz * hw });
  });
  return left.concat(right.reverse());
}

/** Proper intersection point of segments a-b and c-d, or null. */
function segmentHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  const sx = d.x - c.x;
  const sz = d.z - c.z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
  const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + rx * t, z: a.z + rz * t };
}

/**
 * A cubic from A (leaving along unit tA) to B (arriving along unit tB), its
 * control arms 0.4 of the chord long, sampled every `step` m (A and B
 * included): the S curve of a swing and of a bluff detour's legs. Between two
 * parallel lines D apart with a chord C that arm length gives the gentlest
 * worst radius, about C² / (5 D) (shorter arms bend hard at the ends, longer
 * ones in the middle); a two row swing comes out near 100 m, a bluff leg
 * near 75 at its worst node jitter.
 */
function cubicPath(A: Vec2, tA: Vec2, B: Vec2, tB: Vec2, step: number): Vec2[] {
  const chord = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
  const k = chord * 0.4;
  const C1 = { x: A.x + tA.x * k, z: A.z + tA.z * k };
  const C2 = { x: B.x - tB.x * k, z: B.z - tB.z * k };
  const N = Math.max(4, Math.ceil(chord / step));
  const pts: Vec2[] = [A];
  for (let i = 1; i < N; i++) {
    const t = i / N;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    pts.push({ x: w0 * A.x + w1 * C1.x + w2 * C2.x + w3 * B.x, z: w0 * A.z + w1 * C1.z + w2 * C2.z + w3 * B.z });
  }
  pts.push(B);
  return pts;
}

/** Unit direction from p to q (north when they coincide). */
function unitBetween(p: Vec2, q: Vec2): Vec2 {
  const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
  return l < 1e-6 ? { x: 0, z: 1 } : { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
}

/** First crossing of polyline `pts` with polyline `line`: the segment index of pts and the point. */
function polylineCrossing(pts: readonly Vec2[], line: readonly Vec2[]): { i: number; p: Vec2 } | null {
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let k = 0; k + 1 < line.length; k++) {
      const p = segmentHit(pts[i], pts[i + 1], line[k], line[k + 1]);
      if (p) return { i, p };
    }
  }
  return null;
}

/** The line's column at each row (params.col<j>). */
function rowColumns(area: Area): number[] {
  return Array.from({ length: CITY.gridH }, (_, j) => elColumnAt(area, j));
}

/** The line's anchor index at each row (params.at<j>). */
function rowIndices(area: Area): number[] {
  return Array.from({ length: CITY.gridH }, (_, j) => elRowIndex(area, j));
}

/** The column (grid i) the line's street is on at grid row `row`, or -1 where it is swinging between columns. */
export function elColumnAt(area: Area, row: number): number {
  const c = area.params[`col${row}`];
  return c === undefined ? -1 : c;
}

/** Path index of the point where the line crosses row `row`'s street line. */
export function elRowIndex(area: Area, row: number): number {
  const i = area.params[`at${row}`];
  if (i === undefined) throw new Error(`the El has no anchor at row ${row}`);
  return i;
}

/** The point where the line crosses row `row`'s street line. */
export function elRowPoint(area: Area, row: number): Vec2 {
  return area.path[elRowIndex(area, row)];
}

/**
 * The path with the rows strictly between leg rows dj0 and dj1 moved onto a
 * detour (a bluff's right of way): everything between the legs' anchors goes
 * (bend points included); in come an S curve off the street at dj0, `moved`
 * (row -> point) in row order, and an S curve back onto the street at dj1,
 * each tangent to the street at its anchor and to the detour's line. Pure;
 * applyElDetour commits it to the area.
 */
export function elDetourPath(area: Area, dj0: number, dj1: number, moved: ReadonlyMap<number, Vec2>): { path: Vec2[]; at: number[] } {
  const i0 = elRowIndex(area, dj0);
  const i1 = elRowIndex(area, dj1);
  const rows = [...moved.keys()].sort((a, b) => a - b);
  const mid = rows.map((r) => moved.get(r)!);
  const first = mid[0];
  const last = mid[mid.length - 1];
  const along = unitBetween(first, last);
  const legA = cubicPath(area.path[i0], unitBetween(area.path[i0 - 1], area.path[i0]), first, along, CFG.swingStep).slice(1, -1);
  const legB = cubicPath(last, along, area.path[i1], unitBetween(area.path[i1], area.path[i1 + 1]), CFG.swingStep).slice(1, -1);
  const path = area.path.slice(0, i0 + 1).concat(legA, mid, legB, area.path.slice(i1));
  const at: number[] = [];
  for (let j = 0; j < CITY.gridH; j++) {
    const old = elRowIndex(area, j);
    if (old <= i0) at[j] = old;
    else if (old >= i1) at[j] = old - i1 + i0 + 1 + legA.length + mid.length + legB.length;
    else {
      const k = rows.indexOf(j);
      if (k < 0) throw new Error(`row ${j} inside the detour has no moved point`);
      at[j] = i0 + 1 + legA.length + k;
    }
  }
  return { path, at };
}

/** The edges of the streets the line follows from row j0 to row j1 (none across a swing), walked on the graph as it is now. */
export function elStreetEdges(g: RoadGraph, area: Area, j0: number, j1: number): number[] {
  const out: number[] = [];
  for (let j = j0; j < j1; j++) {
    const c = elColumnAt(area, j);
    const nodes = c >= 0 && elColumnAt(area, j + 1) === c ? streetChain(g, gridNode(g, c, j).id, gridNode(g, c, j + 1).id) : null;
    if (nodes) for (const e of chainOf(g, nodes).edges) if (e >= 0) out.push(e);
  }
  return out;
}

/** Commit a detour (see elDetourPath): the path, its outline, the anchors, dj0..dj1, and the street along it is no longer under the deck (its claim stays: nobody else reshapes it). */
export function applyElDetour(area: Area, g: RoadGraph, dj0: number, dj1: number, moved: ReadonlyMap<number, Vec2>): void {
  const { path, at } = elDetourPath(area, dj0, dj1, moved);
  area.path = path;
  area.polygon = deckOutline(path, area.params.deckWidth / 2);
  at.forEach((i, j) => (area.params[`at${j}`] = i));
  area.params.dj0 = dj0;
  area.params.dj1 = dj1;
  const off = new Set(elStreetEdges(g, area, dj0, dj1));
  area.edges = area.edges.filter((e) => !off.has(e));
}

export const subwayModule: DistrictModule = {
  kind: 'subway',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const cols: number[] = [];
    for (let i = 1; i <= CITY.gridW - 2; i++) cols.push(i);
    rng.shuffle(cols);
    const side = rng.chance(0.5) ? 1 : -1;
    const want = rng.int(CFG.swings[0], CFG.swings[1]);
    for (const c0 of cols) {
      const line = planSwings(ctx, rng, c0, side, want);
      if (!line) continue;
      const footprint = line.length * CFG.deckWidth;
      if (ctx.budget.used + footprint > ctx.budget.total) return;
      const params: Record<string, number> = {
        side,
        column: c0,
        deckHeight: CFG.deckHeight,
        deckWidth: CFG.deckWidth,
        stations: rng.int(CFG.stations[0], CFG.stations[1]),
        seed: rng.int(1, 0x7ffffffe),
        swings: line.swings,
      };
      line.cols.forEach((c, j) => (params[`col${j}`] = c));
      line.at.forEach((i, j) => (params[`at${j}`] = i));
      const area = ctx.addArea(
        {
          kind: 'subway',
          variant: 'elevated',
          polygon: deckOutline(line.path, CFG.deckWidth / 2),
          path: line.path,
          nodes: line.nodes,
          edges: line.edges,
          faces: [],
          params,
        },
        footprint,
      );
      // The row streets a swing crosses are the El's too (see the header), without counting as streets under the deck.
      for (const e of line.crossed) ctx.claims.edge.set(e, area.id);
      return;
    }
  },

  build(ctx, area) {
    const b = emptyBuild();
    const g = ctx.graph;
    const side = area.params.side;
    const r = CFG.pillarRadius;
    const H = CITY.gridH;
    const cols = rowColumns(area);
    const at = rowIndices(area);
    const dj0 = area.params.dj0 ?? Infinity;
    const dj1 = area.params.dj1 ?? -Infinity;
    /** Row interval (j, j + 1) lies on a bluff's detour. */
    const detoured = (j: number) => j >= dj0 && j + 1 <= dj1;
    // The line's geometry, flat: the terrain is built from the district builds and is not known yet;
    // only x, z and s matter here.
    const curve = buildRailCurve(area.path, side, area.params.deckHeight, () => 0);
    // Street blocks the deck follows (walked on the final graph) and the runs between them where it is off its street.
    const streets: StreetRun[] = [];
    const offRuns: { ja: number; jb: number }[] = [];
    for (let j = 0; j + 1 < H; j++) {
      const c = cols[j];
      const nodes = c >= 0 && cols[j + 1] === c && !detoured(j) ? streetChain(g, gridNode(g, c, j).id, gridNode(g, c, j + 1).id) : null;
      if (nodes) {
        streets.push({ j, ...chainOf(g, nodes) });
        continue;
      }
      const last = offRuns[offRuns.length - 1];
      if (last && last.jb === j) last.jb = j + 1;
      else offRuns.push({ ja: j, jb: j + 1 });
    }
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const inChannel = (x: number, z: number) => rivers.some((rv) => Math.abs(z - riverCenter(rv.params, x)) < rv.params.top + CITY.districts.river.bridgeBody + 2);
    /**
     * Clear of every road surface by `margin` beyond its curb, and out of the sidewalks of every
     * street but `own`'s edges (the ones it stands beside): where a diagonal meets the line at a
     * sharp angle their sidewalks merge, and a stair there would sit on another street's rail line.
     */
    const offRoads = (x: number, z: number, margin: number, own: readonly number[]) => {
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        const a = g.nodes[e.a];
        const c = g.nodes[e.b];
        const d = distToSegment(x, z, a.x, a.z, c.x, c.z);
        if (d < e.width / 2 + margin) return false;
        if (!own.includes(i) && d < e.width / 2 + e.sidewalk + margin + SIDEWALK_GAP) return false;
      }
      return true;
    };
    // Per intersection: how far its closures can reach into the streets that meet there (a roundabout's
    // ring further still). A bend node is no junction: nothing stands across the street there.
    const clearOf = g.nodes.map((n) => {
      if (n.gi < 0 && n.edges.length <= 2 && !n.ring) return 0;
      let m = 0;
      for (const eid of n.edges) m = Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk);
      let c = Math.max(NODE_CLEAR, m + ROUTE.barrierSetbackHeadOn + CLOSURE_GAP);
      if (n.ring) c = Math.max(c, n.ring.outer + CITY.sidewalk + 2);
      return c;
    });
    /** Two edges are pieces of one bent street when they meet at a bend node. */
    const joinedAtBend = (p: number, q: number) => {
      const e = g.edges[p];
      const f = g.edges[q];
      for (const id of [e.a, e.b]) {
        if (id !== f.a && id !== f.b) continue;
        const n = g.nodes[id];
        if (n.gi < 0 && n.edges.length <= 2 && !n.ring) return true;
      }
      return false;
    };
    /** A column may stand here: off the channel, clear of every junction, off every road, inside at most one street's corridor. */
    const hits: number[] = [];
    const pillarOk = (x: number, z: number) => {
      if (inChannel(x, z)) return false;
      for (const n of g.nodes) if (clearOf[n.id] > 0 && (n.x - x) ** 2 + (n.z - z) ** 2 < clearOf[n.id] ** 2) return false;
      hits.length = 0;
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const c = g.nodes[e.b];
        const d = distToSegment(x, z, a.x, a.z, c.x, c.z);
        if (d < e.width / 2 + r + 0.5) return false;
        if (d < e.width / 2 + e.sidewalk + r + 0.5 + SIDEWALK_GAP) hits.push(e.id);
      }
      let streetsHere = hits.length;
      for (let i = 0; i < hits.length; i++) for (let k = i + 1; k < hits.length; k++) if (joinedAtBend(hits[i], hits[k])) streetsHere--;
      return streetsHere <= 1;
    };
    const pillar = (x: number, z: number): boolean => {
      if (!pillarOk(x, z)) return false;
      b.walls.push(...solidWalls(circlePolygon(x, z, r, 8), 'pillar', area.id));
      b.reserved.push({ x, z, r: r + 0.4 });
      b.props.push({ kind: 'pillar', x, z, yaw: 0, size: r, height: area.params.deckHeight, area: area.id });
      return true;
    };
    const stations = planStations(ctx, area, b, streets, cols, at, curve, inChannel, offRoads);

    // ----- Along the streets: columns on the pillar side sidewalk, evenly between the junctions' clearances;
    // a station's stairs take the middle of its block, so the columns there step out to just beyond them.
    const spread = (len: number, m0: number, m1: number): number[] => {
      const usable = len - m0 - m1;
      if (usable <= 0) return [];
      const n = Math.max(1, Math.round(usable / CFG.pillarSpacing) + 1);
      return Array.from({ length: n }, (_, k) => m0 + (n === 1 ? usable / 2 : (usable * k) / (n - 1)));
    };
    const zone = CFG.mezzanine / 2 + CFG.stairRun + 1.5;
    for (const st of streets) {
      const station = stations.find((s) => s.j === st.j);
      const put = (s: number) => {
        const p = alongChain(g, st, s);
        const lat = p.w / 2 + CFG.pillarSetback;
        pillar(p.x + side * p.dz * lat, p.z - side * p.dx * lat);
      };
      for (const s of spread(st.length, clearOf[st.nodes[0]] + 2, clearOf[st.nodes[st.nodes.length - 1]] + 2)) if (!station || Math.abs(s - station.s) > zone) put(s);
      if (station) for (const k of [-1, 1]) put(station.s + k * (zone + 1.2));
    }

    // ----- Off its street (a swing, a missing street, a bluff's detour): columns on the deck line.
    const bluff = bluffOf(ctx.areas, area);
    let level: { sA: number; sB: number; y: number; ground: (x: number, z: number) => number } | null = null;
    if (bluff) {
      // On the level stretch the deck is at the bluff's track level, lower toward the top where the ground
      // comes up to it (bank or at grade, no columns); the S curves either side never drop below the street
      // height over the low ground, so they get columns everywhere.
      const bs = bluffShape(bluff);
      const A = { x: bluff.params.rowAx, z: bluff.params.rowAz };
      const B = { x: bluff.params.rowBx, z: bluff.params.rowBz };
      const sa = projectOnCurve(curve, A.x, A.z).s;
      const sb = projectOnCurve(curve, B.x, B.z).s;
      level = { sA: Math.min(sa, sb), sB: Math.max(sa, sb), y: bs.y, ground: bluffGround(bs, createTerrain(ctx.seed)) };
      b.hints.push({ kind: 'level', points: [A, B], values: [bs.y, CITY.districts.bluff.levelBlend] });
    }
    const P = curvePoint();
    const P1 = curvePoint();
    const sOf = (j: number) => projectOnCurve(curve, area.path[at[j]].x, area.path[at[j]].z).s;
    const okAt = (s: number) => {
      sampleCurve(curve, s, P);
      return pillarOk(P.x, P.z);
    };
    const deckPillar = (s: number) => {
      sampleCurve(curve, s, P);
      if (level && s >= level.sA && s <= level.sB && level.y - level.ground(P.x, P.z) < CITY.districts.bluff.pillarMin) return;
      pillar(P.x, P.z);
    };
    const half = CFG.deckWidth / 2 + CFG.blockMargin;
    for (const run of offRuns) {
      const sA = sOf(run.ja);
      const sB = sOf(run.jb);
      // Fixed columns: past the junction the run leaves and before the one it joins, then every row between:
      // either side of a junction of its own street the deck passes (the street missing beyond it), or a
      // pier on each sidewalk of a street it crosses (the first spot off the road either way; none where
      // there is no street, and the level rule drops them at a bluff's crossing). Even spacing between.
      const fixed: number[] = [sA + clearOf[gridNode(g, cols[run.ja], run.ja).id] + 2, sB - clearOf[gridNode(g, cols[run.jb], run.jb).id] - 2];
      for (let jj = run.ja + 1; jj < run.jb; jj++) {
        const sX = sOf(jj);
        if (cols[jj] >= 0 && !(jj > dj0 && jj < dj1)) {
          const cl = clearOf[gridNode(g, cols[jj], jj).id] + 2;
          fixed.push(sX - cl, sX + cl);
        } else if (!okAt(sX)) {
          for (const dir of [-1, 1]) {
            for (let d = 1; d <= PIER_SEARCH; d++) {
              if (!okAt(sX + dir * d)) continue;
              fixed.push(sX + dir * d);
              break;
            }
          }
        }
      }
      fixed.sort((p, q) => p - q);
      const spots: number[] = [];
      for (let i = 0; i + 1 < fixed.length; i++) {
        const f0 = fixed[i];
        const f1 = fixed[i + 1];
        const n = Math.max(1, Math.round((f1 - f0) / CFG.pillarSpacing));
        for (let k = 0; k <= n; k++) spots.push(f0 + ((f1 - f0) * k) / n);
      }
      spots.sort((p, q) => p - q);
      let last = -Infinity;
      for (const s of spots) {
        if (s - last < SPOT_MERGE) continue;
        last = s;
        deckPillar(s);
      }
      // Buildings keep out from under the deck through the blocks.
      const s1 = sB - STRIP_IN;
      for (let s = sA + STRIP_IN; s < s1; s += 12) {
        const e = Math.min(s1, s + 12);
        sampleCurve(curve, s, P);
        sampleCurve(curve, e, P1);
        b.exclusions.push([
          { x: P.x - P.px * half, z: P.z - P.pz * half },
          { x: P1.x - P1.px * half, z: P1.z - P1.pz * half },
          { x: P1.x + P1.px * half, z: P1.z + P1.pz * half },
          { x: P.x + P.px * half, z: P.z + P.pz * half },
        ]);
      }
    }
    b.hints.push({ kind: 'deck', points: area.path, values: [area.params.deckHeight, area.params.deckWidth] });
    for (const s of stations) b.hints.push({ kind: 'station', points: [s.mid], values: [s.deckS, s.edge] });
    return b;
  },
};

/**
 * The line on column c0 with the swings it can have: `want` of them, each
 * tried in a seeded order (layouts that leave a bluff a straight stretch of
 * five rows first, so the escarpment still fits most seeds) and kept when its
 * geometry fits; a second swing follows the first. Straight when none fits.
 */
function planSwings(ctx: PlanContext, rng: Rng, c0: number, side: number, want: number): LinePlan | null {
  const H = CITY.gridH;
  const W = CITY.gridW;
  const colsWith = (swings: readonly Swing[]): number[] => {
    const cols = new Array<number>(H).fill(c0);
    for (const s of swings) {
      for (let j = s.j0 + 1; j < s.j1; j++) cols[j] = -1;
      for (let j = s.j1; j < H; j++) cols[j] = s.to;
    }
    return cols;
  };
  /** Swings off column `from` starting at row jMin or later, in a seeded order. */
  const candidates = (from: number, jMin: number): Swing[] => {
    const out: Swing[] = [];
    for (let j0 = jMin; j0 + CFG.swingRows[0] <= H - 2; j0++) {
      for (let L = CFG.swingRows[0]; L <= CFG.swingRows[1]; L++) {
        for (const d of [1, -1]) {
          const to = from + d;
          if (j0 + L > H - 2 || to < 1 || to > W - 2) continue;
          out.push({ j0, j1: j0 + L, from, to });
        }
      }
    }
    rng.shuffle(out);
    return out;
  };
  /**
   * Crest rows a bluff could use: the line on one column across five rows around a row 2..H-3 (bluff.ts).
   * Layouts leaving it three or more come first (the shuffle decides among them), so the escarpment still
   * fits most seeds; a lone swing anywhere leaves at least one.
   */
  const crestRows = (cols: readonly number[]) => {
    let n = 0;
    for (let r = 2; r <= H - 3; r++) {
      const c = cols[r];
      if (c >= 0 && [r - 2, r - 1, r + 1, r + 2].every((j) => cols[j] === c)) n++;
    }
    return n;
  };
  const room = (cols: readonly number[]) => crestRows(cols) > 0;
  const ordered = (cands: Swing[], before: readonly Swing[]) =>
    cands
      .map((s, i) => ({ s, i, r: Math.min(3, crestRows(colsWith([...before, s]))) }))
      .sort((p, q) => q.r - p.r || p.i - q.i)
      .map((x) => x.s);
  let best: LinePlan | null = null;
  let first: Swing | null = null;
  if (want >= 1) {
    for (const s of ordered(candidates(c0, 1), [])) {
      const plan = planLine(ctx, side, colsWith([s]), [s]);
      if (!plan) continue;
      best = plan;
      first = s;
      break;
    }
  }
  // A second swing only where the bluff keeps its room: two swings and a bluff do not fit eleven rows otherwise.
  if (want >= 2 && first) {
    for (const s of ordered(candidates(first.to, first.j1 + 1), [first])) {
      if (!room(colsWith([first, s]))) break;
      const plan = planLine(ctx, side, colsWith([first, s]), [first, s]);
      if (!plan) continue;
      best = plan;
      break;
    }
  }
  return best ?? planLine(ctx, side, colsWith([]), []);
}

/**
 * The path of a line with the given column per row and swings, or null when
 * it does not fit: a claimed node on its way, too many missing streets, a
 * swing whose curve is too tight, crosses a row street near a junction or a
 * bridge, runs near a diagonal avenue or the river.
 */
function planLine(ctx: PlanContext, side: number, cols: readonly number[], swings: readonly Swing[]): LinePlan | null {
  const g = ctx.graph;
  const H = CITY.gridH;
  const rivers = ctx.areas.filter((a) => a.kind === 'river');
  const chains = new Map<number, Chain | null>();
  /** The street from (c, j) to (c, j + 1), walked once. */
  const streetAt = (c: number, j: number): Chain | null => {
    if (c < 0 || j < 0 || j + 1 >= H) return null;
    const key = c * 64 + j;
    let ch = chains.get(key);
    if (ch === undefined) {
      const nodes = streetChain(g, gridNode(g, c, j).id, gridNode(g, c, j + 1).id);
      ch = nodes ? chainOf(g, nodes) : null;
      chains.set(key, ch);
    }
    return ch;
  };
  const curb = (n: RoadNode, tx: number, tz: number, w: number): Vec2 => {
    // The pillar side is +x for side 1: the right of travel toward +z, (tz, -tx).
    const off = side * Math.max(2, w / 2 - CFG.deckInset);
    return { x: n.x + tz * off, z: n.z - tx * off };
  };
  /** The deck's anchor at the grid node (c, j): over the curb lane, along the street's direction there. */
  const anchorAt = (c: number, j: number): Anchor => {
    const n = gridNode(g, c, j);
    let tx = 0;
    let tz = 0;
    let w = 0;
    const before = cols[j - 1] === c ? streetAt(c, j - 1) : null;
    const after = cols[j + 1] === c ? streetAt(c, j) : null;
    if (before) {
      const p = g.nodes[before.nodes[before.nodes.length - 2]];
      const l = sqrt((n.x - p.x) ** 2 + (n.z - p.z) ** 2) || 1;
      tx += (n.x - p.x) / l;
      tz += (n.z - p.z) / l;
      w = Math.max(w, g.edges[before.edges[before.edges.length - 1]].width);
    }
    if (after) {
      const q = g.nodes[after.nodes[1]];
      const l = sqrt((q.x - n.x) ** 2 + (q.z - n.z) ** 2) || 1;
      tx += (q.x - n.x) / l;
      tz += (q.z - n.z) / l;
      w = Math.max(w, g.edges[after.edges[0]].width);
    }
    const l = sqrt(tx * tx + tz * tz);
    if (l < 1e-6) {
      tx = 0;
      tz = 1;
    } else {
      tx /= l;
      tz /= l;
    }
    if (!w) w = CITY.width.street;
    return { p: curb(n, tx, tz, w), t: { x: tx, z: tz }, w };
  };
  /** The deck's point at a bend node k of a chain (between its neighbours' directions). */
  const bendPoint = (ch: Chain, k: number): Vec2 => {
    const n = g.nodes[ch.nodes[k]];
    const p = g.nodes[ch.nodes[k - 1]];
    const q = g.nodes[ch.nodes[k + 1]];
    const l1 = sqrt((n.x - p.x) ** 2 + (n.z - p.z) ** 2) || 1;
    const l2 = sqrt((q.x - n.x) ** 2 + (q.z - n.z) ** 2) || 1;
    let tx = (n.x - p.x) / l1 + (q.x - n.x) / l2;
    let tz = (n.z - p.z) / l1 + (q.z - n.z) / l2;
    const l = sqrt(tx * tx + tz * tz);
    if (l < 1e-6) {
      tx = 0;
      tz = 1;
    } else {
      tx /= l;
      tz /= l;
    }
    const w = Math.max(g.edges[ch.edges[k - 1]].width, g.edges[ch.edges[k]].width);
    return curb(n, tx, tz, w);
  };
  /**
   * The S curve of a swing: a cubic from the lead past the junction it leaves to the lead before the one
   * it joins, tangent to both streets, sampled every swingStep; with a point exactly where it crosses
   * each row street between (and that row's anchor index into the samples).
   */
  const swingPath = (a0: Anchor, a1: Anchor, sw: Swing): { pts: Vec2[]; at: Map<number, number>; crossed: number[] } | null => {
    const lead = CFG.swingLead;
    const A = { x: a0.p.x + a0.t.x * lead, z: a0.p.z + a0.t.z * lead };
    const B = { x: a1.p.x - a1.t.x * lead, z: a1.p.z - a1.t.z * lead };
    const chord = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    if (chord < 4 * lead) return null;
    const pts = cubicPath(A, a0.t, B, a1.t, CFG.swingStep);
    // Gentle enough for the trains: the turn between successive pieces over their length.
    let minR = Infinity;
    for (let i = 1; i + 1 < pts.length; i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const az = pts[i].z - pts[i - 1].z;
      const bx = pts[i + 1].x - pts[i].x;
      const bz = pts[i + 1].z - pts[i].z;
      const turn = Math.abs(atan2(ax * bz - az * bx, ax * bx + az * bz));
      const len = (sqrt(ax * ax + az * az) + sqrt(bx * bx + bz * bz)) / 2;
      if (turn > 1e-9) minR = Math.min(minR, len / turn);
    }
    if (minR < CFG.swingRadius) return null;
    // Where it crosses the row streets between the columns, well away from their junctions, never a bridge.
    const at = new Map<number, number>();
    const crossed: number[] = [];
    for (let j = sw.j0 + 1; j < sw.j1; j++) {
      const Pn = gridNode(g, sw.from, j);
      const Qn = gridNode(g, sw.to, j);
      const nodes = streetChain(g, Pn.id, Qn.id);
      const line: Vec2[] = nodes ? nodes.map((id) => g.nodes[id]) : [Pn, Qn];
      const hit = polylineCrossing(pts, line);
      if (!hit) return null;
      if (sqrt((hit.p.x - Pn.x) ** 2 + (hit.p.z - Pn.z) ** 2) < CROSS_NODE_CLEAR || sqrt((hit.p.x - Qn.x) ** 2 + (hit.p.z - Qn.z) ** 2) < CROSS_NODE_CLEAR) return null;
      pts.splice(hit.i + 1, 0, hit.p);
      at.set(j, hit.i + 1);
      if (nodes) {
        for (const e of chainOf(g, nodes).edges) {
          if (e < 0 || g.edges[e].bridge) return null;
          crossed.push(e);
        }
      }
    }
    // Off every diagonal avenue and clear of the river.
    for (const e of g.edges) {
      if (e.kind !== 'diagonal') continue;
      const a = g.nodes[e.a];
      const c = g.nodes[e.b];
      for (const p of pts) if (distToSegment(p.x, p.z, a.x, a.z, c.x, c.z) < DIAGONAL_CLEAR) return null;
    }
    for (const rv of rivers) for (const p of pts) if (Math.abs(p.z - riverCenter(rv.params, p.x)) < rv.params.top + RIVER_CLEAR) return null;
    return { pts, at, crossed };
  };

  const path: Vec2[] = [];
  const at = new Array<number>(H).fill(-1);
  const nodes: number[] = [];
  const edges: number[] = [];
  const crossed: number[] = [];
  let missing = 0;
  for (let j = 0; j < H; ) {
    const c = cols[j];
    if (c < 0) return null;
    const n = gridNode(g, c, j);
    if (ctx.claims.node.has(n.id)) return null;
    const a = anchorAt(c, j);
    at[j] = path.length;
    path.push(a.p);
    nodes.push(n.id);
    const sw = swings.find((s) => s.j0 === j);
    if (sw) {
      const S = swingPath(a, anchorAt(sw.to, sw.j1), sw);
      if (!S) return null;
      for (const [row, idx] of S.at) at[row] = path.length + idx;
      for (const p of S.pts) path.push(p);
      for (const e of S.crossed) crossed.push(e);
      j = sw.j1;
      continue;
    }
    if (j + 1 < H) {
      const ch = streetAt(c, j);
      if (!ch) missing++;
      else {
        for (let k = 1; k + 1 < ch.nodes.length; k++) {
          if (ctx.claims.node.has(ch.nodes[k])) return null;
          path.push(bendPoint(ch, k));
          nodes.push(ch.nodes[k]);
        }
        for (const e of ch.edges) edges.push(e);
      }
    }
    j++;
  }
  if (missing > MAX_MISSING) return null;
  // Run-offs straight on along the end streets.
  const t0 = anchorAt(cols[0], 0).t;
  const tN = anchorAt(cols[H - 1], H - 1).t;
  const last = path[path.length - 1];
  path.unshift({ x: path[0].x - t0.x * RUN_OFF, z: path[0].z - t0.z * RUN_OFF });
  path.push({ x: last.x + tN.x * RUN_OFF, z: last.z + tN.z * RUN_OFF });
  for (let j = 0; j < H; j++) at[j]++;
  let length = 0;
  for (let i = 1; i < path.length; i++) length += sqrt((path[i].x - path[i - 1].x) ** 2 + (path[i].z - path[i - 1].z) ** 2);
  return { path, at, cols: cols.slice(), nodes, edges, crossed, length, swings: swings.length };
}

/**
 * Pick the station blocks and add their stairs. Long street blocks the deck
 * follows, with straight deck under the whole platform (never a swing or a
 * bluff's detour; the track's swing-outs may reach into a curve's easing),
 * away from the map ends, the river and a bluff's crossing, spaced apart, in
 * a seeded order.
 */
function planStations(
  ctx: BuildContext,
  area: Area,
  b: AreaBuild,
  streets: readonly StreetRun[],
  cols: readonly number[],
  at: readonly number[],
  curve: RailCurve,
  inChannel: (x: number, z: number) => boolean,
  offRoads: (x: number, z: number, margin: number, own: readonly number[]) => boolean,
): StationPlan[] {
  const g = ctx.graph;
  const want = area.params.stations ?? 0;
  if (!want) return [];
  const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
  const side = area.params.side;
  const H = CITY.gridH;
  const dj0 = area.params.dj0 ?? Infinity;
  const dj1 = area.params.dj1 ?? -Infinity;
  const bluff = bluffOf(ctx.areas, area);
  const need = RAIL.platform / 2 + PLATFORM_CLEAR;
  /**
   * Straight deck beyond node row j (dir -1 south, +1 north): the street blocks the deck follows there
   * and the blocks it runs straight through where the street is missing, up to a swing (its lead is
   * straight) or a bluff's detour (not), out to the run-off at the map ends.
   */
  const straightBeyond = (j: number, dir: -1 | 1): number => {
    let d = 0;
    for (let jj = j; d < 400; jj += dir) {
      const k = dir < 0 ? jj - 1 : jj;
      if (k < 0 || k + 1 >= H) return d + RUN_OFF;
      const st = streets.find((s) => s.j === k);
      if (st) d += st.length;
      else if (cols[k] >= 0 && cols[k] === cols[k + 1] && !(k >= dj0 && k + 1 <= dj1)) {
        const p = area.path[at[k]];
        const q = area.path[at[k + 1]];
        d += sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      } else return d + (cols[k] < 0 || cols[k + 1] < 0 ? SWING_STRAIGHT : 0);
    }
    return d;
  };
  const cands: StreetRun[] = [];
  for (const st of streets) {
    const j = st.j;
    if (j < 1 || j + 1 > H - 2 || st.length < CFG.stationMinEdge) continue;
    if (st.edges.some((e) => e < 0 || g.edges[e].bridge)) continue;
    const half = st.length / 2;
    if (half + straightBeyond(j, -1) < need || half + straightBeyond(j + 1, 1) < need) continue;
    // A bluff's detour has no stations, and the trains pass its level crossing at speed: platforms keep
    // STATION_CROSSING_CLEAR from it.
    if (bluff) {
      const m = alongChain(g, st, half);
      if (sqrt((m.x - bluff.params.cx) ** 2 + (m.z - bluff.params.cz) ** 2) < STATION_CROSSING_CLEAR) continue;
    }
    cands.push(st);
  }
  rng.shuffle(cands);
  const out: StationPlan[] = [];
  const used: number[] = [];
  const mezz = CFG.mezzanine / 2;
  for (const st of cands) {
    if (out.length >= want) break;
    if (used.some((j) => Math.abs(j - st.j) < 3)) continue;
    const half = st.length / 2;
    const m = alongChain(g, st, half);
    const { dx, dz } = m;
    // The pillar side normal: the right of travel toward +z for side 1.
    const nx = side * dz;
    const nz = -side * dx;
    const mid = { x: m.x, z: m.z };
    // The platform (and its approach) stays clear of the river channel.
    let wet = false;
    for (let s = -70; s <= 70 && !wet; s += 10) wet = inChannel(mid.x + dx * s, mid.z + dz * s);
    if (wet) continue;
    const lat = m.w / 2 + CFG.pillarSetback;
    const hw = CFG.stairWidth / 2;
    const stairs: { poly: Vec2[]; bottom: Vec2; up: Vec2 }[] = [];
    let ok = half - mezz - CFG.stairRun > STAIR_NODE_CLEAR;
    for (const k of [-1, 1]) {
      if (!ok) break;
      const top = { x: mid.x + dx * k * mezz + nx * lat, z: mid.z + dz * k * mezz + nz * lat };
      const bottom = { x: top.x + dx * k * CFG.stairRun, z: top.z + dz * k * CFG.stairRun };
      const poly = [
        { x: top.x - nx * hw, z: top.z - nz * hw },
        { x: bottom.x - nx * hw, z: bottom.z - nz * hw },
        { x: bottom.x + nx * hw, z: bottom.z + nz * hw },
        { x: top.x + nx * hw, z: top.z + nz * hw },
      ];
      if (poly.some((p) => !offRoads(p.x, p.z, 0.4, st.edges) || inChannel(p.x, p.z))) ok = false;
      stairs.push({ poly, bottom, up: { x: -dx * k, z: -dz * k } });
    }
    if (!ok) continue;
    const rise = CFG.deckHeight - CFG.mezzanineDrop;
    for (const s of stairs) {
      b.walls.push(...solidWalls(s.poly, 'pillar', area.id));
      b.props.push({ kind: 'stair', x: s.bottom.x, z: s.bottom.z, yaw: yawOf(s.up.x, s.up.z), size: CFG.stairRun, height: rise, area: area.id });
      for (let t = 0; t <= CFG.stairRun; t += 2) b.reserved.push({ x: s.bottom.x + s.up.x * t, z: s.bottom.z + s.up.z * t, r: hw + 0.4 });
    }
    out.push({ j: st.j, s: half, edge: m.edge, deckS: projectOnCurve(curve, mid.x, mid.z).s, mid });
    used.push(st.j);
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
