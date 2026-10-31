/**
 * The region every weekend special is built in (weekend.ts, docs/weekend.md): a rectangle of 6 to 12 grid cells
 * carved out of the city, its inner streets deleted, with a spine of 'feature' edges (roadGraph.ts) running from an
 * entry junction on its ring to an exit junction on the opposite side. The circuit and the sprint must drive the
 * spine end to end, so the race goes through the set piece instead of past it: progress, the AI's line, the lost
 * check and the route's closures all follow it for free, the way they follow the channel's floor. The module's
 * own ways through (its lines: open ground, decks, a trench) lie around the spine inside the region's polygon.
 *
 * Lifecycle (districts/index.ts), in the module's slots:
 *  - carve (carveRegion, before anything plans: deleting streets renumbers every id, as the lake's carve does):
 *    pick a rectangle from the module's shapes (interior, off the expressway's first rows, off the channel's band
 *    as the channel would plan on the edited streets, out of downtown's core when it can be, in the budget), an
 *    entry and an exit junction where a street arrives square from outside, and lay the spine: the first piece
 *    carries straight on along the approach street for CFG.flare m at the street's width (the flare), then the
 *    module's width on to the last piece, which flares back to the exit street. The rectangle's inner junctions
 *    become the spine's bend nodes (moved, kept at their grid ids so gridNode still answers), every inner street
 *    piece is deleted, and the area claims the spine, the ring, both approach streets and their junctions, so the
 *    El, the expressway, the bluff, roundabouts, alleys, shortcuts, the market and the lake keep off. Each
 *    candidate is tried on a copy first (connectivity, the merged block, the spine's clearance, the channel).
 *  - routes (world.ts planRoads): weekendPreference merges into both finders' preference (anchors at the entry
 *    and the exit, the spine weighed down, the ring weighed up, a rating that puts spine-driving routes first),
 *    weekendKeepOut holds the region against shortcuts and car parks, and planRoads re-picks variants until both
 *    routes drive the spine (weekendDriven).
 *  - plan (planRegion, the module's registry slot right after the topology hook): claim every block face inside
 *    the region and record which routes drive the spine and which way (`driven0`/`driven1`, `dir0`/`dir1`);
 *    `special` is 1 only when both do, and resolveEvent promises the special only then.
 *  - build: the module's own, with the shared pieces here: regionGround (exclusions, openings, the firm base
 *    surface), regionFence (a fence on the ring with the entry's and exit's mouths open) and spineLine.
 *  - race (sim/race.ts): regionProgress places a car anywhere in the polygon along the spine, so progress runs on
 *    monotonically on any line and the lost check (CORRIDOR_AREAS) never resets it.
 *
 * How the area stores the region (ids in params are not renumbered, so ids live in the lists; districts/index.ts
 * carries the lists through every later renumbering edit in order): `nodes` = the spine's nodes entry to exit
 * (params.spineNodes of them), then the two approach streets' first nodes (entry side, exit side), then the ring's
 * other junctions, then the module's line nodes; `edges` = the spine's pieces in order (spineNodes - 1), then the
 * module's own feature edges (params.lineEdges), then the ring's pieces, then both approach streets' pieces
 * (params.approachEdges). `polygon` is the merged block's ring (the
 * outer sidewalk line of the ring streets), `path` the spine's points entry to exit.
 */
import { CITY, ROUTE } from '../config';
import { type RoadGraph, type RoadNode, type Renumber, addEdge, chainFrom, edgeBetween, gridChain, graphIsConnected, removeEdges, sortNodeEdges } from '../roadGraph';
import { type BlockFace, computeFaces, computeSectors } from '../blocks';
import { Rng, deriveSeed } from '../../sim/prng';
import { type Vec2, atan2, segmentT, sqrt } from '../../sim/math';
import type { RoutePreference } from '../routeSearch';
import type { Route } from '../route';
import type { RouteProgress } from '../world';
import type { Area, AreaBuild, AreaKind, FeatureLine, PlanContext, Surface, WallLook } from './types';
import { CORRIDOR_AREAS } from './types';
import { distToPolygonEdge, pointInPolygon, polygonArea, polygonBounds, segmentAt, solidWalls } from './geom';
import { highwayRolled, highwayRows } from './highway/line';
import { channelL } from './channel';
import { channelPlanOn } from './lake';

const CFG = CITY.districts.weekend;

/** A region's size in grid cells: `along` the spine (entry side to exit side) and `across` it. */
export interface WeekendShape {
  along: number;
  across: number;
}

/** What a weekend module asks of the framework at carve time. */
export interface RegionSpec {
  kind: AreaKind;
  /** Shapes in order of preference; each is tried with the spine along the grid's rows and along its columns. */
  shapes: readonly WeekendShape[];
  /** The spine's width past the flares (m): the module's road through its set piece. */
  spineWidth: number;
  /** The spine runs dead straight from the entry to the exit (the Underground's trench, the rail yard's tracks). */
  straight?: boolean;
  /**
   * The module's own feature edges, added once the spine exists on the real graph: call addNode / addEdge (kind
   * 'feature', sidewalk 0) between spine nodes or new nodes, every one inside `polygon`; the framework sorts the
   * node edges and records the new edges and nodes. A branch or a loop off the spine; no street outside may join.
   */
  lines?(g: RoadGraph, spine: readonly number[], polygon: readonly Vec2[]): void;
}

/** A carved region as the area stores it (see the header). */
export interface Region {
  area: Area;
  /** Spine nodes, entry first, exit last. */
  spine: number[];
  /** Spine pieces in order (spine.length - 1). */
  spineEdges: number[];
  /** The module's own feature edges. */
  lineEdges: number[];
  /** The approach streets' first nodes off the entry and off the exit (where a route must come from and go to). */
  approachE: number;
  approachX: number;
  /** The ring's other junctions (then the module's line nodes), the ring's pieces and both approach streets' pieces. */
  ring: number[];
  ringEdges: number[];
  approachEdges: number[];
  /** The merged block's ring and the spine's points entry to exit. */
  polygon: Vec2[];
  path: Vec2[];
  /** Widths (m): the flares (the approach streets') and the spine. */
  widthE: number;
  widthX: number;
  spineWidth: number;
}

/** The region an area holds, or null for an area that is no region (a weekday area, a hand-built test area). */
export function regionOf(area: Area): Region | null {
  const p = area.params;
  if (p.region !== 1) return null;
  const k = p.spineNodes;
  const le = p.lineEdges ?? 0;
  const ap = p.approachEdges ?? 0;
  if (area.nodes.length < k + 2 || area.edges.length < k - 1 + le + ap) return null;
  return {
    area,
    spine: area.nodes.slice(0, k),
    spineEdges: area.edges.slice(0, k - 1),
    lineEdges: area.edges.slice(k - 1, k - 1 + le),
    approachE: area.nodes[k],
    approachX: area.nodes[k + 1],
    ring: area.nodes.slice(k + 2),
    ringEdges: area.edges.slice(k - 1 + le, area.edges.length - ap),
    approachEdges: area.edges.slice(area.edges.length - ap),
    polygon: area.polygon,
    path: area.path,
    widthE: p.widthE,
    widthX: p.widthX,
    spineWidth: p.spineWidth,
  };
}

/** The seed's weekend region (the area of the weekend's kind that carved one), or null. */
export function weekendRegion(ctx: { areas: readonly Area[]; weekend?: { kind: string } }): Region | null {
  if (!ctx.weekend) return null;
  const a = ctx.areas.find((x) => x.kind === ctx.weekend!.kind && x.params.region === 1);
  return a ? regionOf(a) : null;
}

// ---------------------------------------------------------------------------
// Carve

/** Street pieces a region may delete or keep as its ring: plain grid streets, no bridge, shortcut or level crossing. */
const PLAIN = new Set(['street', 'avenue', 'boulevard', 'diagonal']);
const plainEdge = (ctx: PlanContext, e: number): boolean => {
  const ed = ctx.graph.edges[e];
  return PLAIN.has(ed.kind) && !ed.bridge && !ed.shortcut && ed.crossing === undefined && !ctx.claims.edge.has(e);
};

const unit = (x: number, z: number): Vec2 => {
  const l = sqrt(x * x + z * z) || 1;
  return { x: x / l, z: z / l };
};
const angleBetween = (a: Vec2, b: Vec2): number => Math.abs(atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z));

/** An end of the spine: a ring junction a street arrives at square from outside. */
interface End {
  node: number;
  /** Unit heading into the region along the approach street's last piece. */
  dir: Vec2;
  /** The approach street's pieces, its first node off the junction, and its width (m). */
  edges: number[];
  next: number;
  width: number;
}

/** A rectangle that passed the cheap checks, with its spine planned. */
interface Candidate {
  shape: WeekendShape;
  i0: number;
  j0: number;
  wI: number;
  hJ: number;
  /** Ring junctions in ring order, the inner junctions (ascending ids) and the inner pieces to delete. */
  ring: number[];
  /** Ring sides the grid generator dropped, laid again as plain streets (junction pairs). */
  restore: [number, number][];
  inner: number[];
  dead: number[];
  entry: End;
  exit: End;
  /** The inner junctions' new positions, entry side first. */
  spine: Vec2[];
  /** Lower is better: the spine's bend and downtown's core. */
  score: number;
}

/** The ids after the real edit. */
interface Carved {
  spine: number[];
  spineEdges: number[];
  ring: number[];
  ringEdges: number[];
  approach: number[];
  next: [number, number];
}

function cloneGraph(g: RoadGraph): RoadGraph {
  return { nodes: g.nodes.map((n) => ({ ...n, edges: n.edges.slice() })), edges: g.edges.map((e) => ({ ...e })), bounds: { ...g.bounds }, plan: g.plan };
}

/** Points along a polyline every `step` m (both ends included). */
function samplePolyline(pts: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

/** `count` points evenly spaced by arc length on the cubic Bezier p0 c0 c1 p1 (ends included). */
function bezierPoints(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2, count: number): Vec2[] {
  const N = 96;
  const at = (t: number): Vec2 => {
    const s = 1 - t;
    return { x: s * s * s * p0.x + 3 * s * s * t * c0.x + 3 * s * t * t * c1.x + t * t * t * p1.x, z: s * s * s * p0.z + 3 * s * s * t * c0.z + 3 * s * t * t * c1.z + t * t * t * p1.z };
  };
  const pts: Vec2[] = [];
  const cum = [0];
  for (let i = 0; i <= N; i++) {
    pts.push(at(i / N));
    if (i) cum.push(cum[i - 1] + sqrt((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].z - pts[i - 1].z) ** 2));
  }
  const out: Vec2[] = [];
  for (let m = 0; m < count; m++) {
    const s = (cum[N] * m) / (count - 1);
    const i = Math.min(N - 1, segmentAt(cum, s));
    const t = (s - cum[i]) / (cum[i + 1] - cum[i] || 1);
    out.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t });
  }
  return out;
}

/** Every rectangle the spec's shapes allow on this grid that passes the cheap checks, with its best entry and exit. */
function candidates(ctx: PlanContext, spec: RegionSpec): Candidate[] {
  const g = ctx.graph;
  const W = g.plan.gridW;
  const H = g.plan.gridH;
  const e0 = CFG.edgeCells;
  const nodeAt = (i: number, j: number): RoadNode | null => {
    const n = g.nodes[j * W + i];
    return n && n.gi === i && n.gj === j ? n : null;
  };
  // The expressway runs along rows (highway/line.ts): keep off the rows its plan tries first, as the lake does.
  const keepRows = new Set<number>();
  if (highwayRolled(ctx.seed)) {
    const hw = new Rng(deriveSeed(ctx.seed, 'district:highway'));
    hw.chance(CITY.districts.highway.chance);
    for (const r of highwayRows(hw, H).slice(0, CITY.districts.lake.highwayRows)) keepRows.add(r);
  }
  const dt = g.plan.downtown;
  const out: Candidate[] = [];
  for (const shape of spec.shapes) {
    const cells = shape.along * shape.across;
    if (cells < CFG.cells[0] || cells > CFG.cells[1]) continue;
    for (const axis of ['i', 'j'] as const) {
      const wI = axis === 'i' ? shape.along : shape.across;
      const hJ = axis === 'i' ? shape.across : shape.along;
      for (let j0 = e0; j0 + hJ <= H - 1 - e0; j0++) {
        // Only the rows whose streets are deleted (strictly inside): the ring's rows keep their streets.
        let rowsOk = true;
        for (let j = j0 + 1; j < j0 + hJ; j++) if (keepRows.has(j)) rowsOk = false;
        if (!rowsOk) continue;
        for (let i0 = e0; i0 + wI <= W - 1 - e0; i0++) {
          const c = candidateAt(ctx, spec, shape, axis, i0, j0, wI, hJ, nodeAt);
          if (!c) continue;
          // Out of downtown's core where the city allows: the towers stay, the region goes where the streets are plainer.
          let cx = 0;
          let cz = 0;
          for (const id of c.ring) {
            cx += g.nodes[id].x / c.ring.length;
            cz += g.nodes[id].z / c.ring.length;
          }
          if (sqrt((cx - dt.x) ** 2 + (cz - dt.z) ** 2) < CFG.downtownCore) c.score += 10;
          out.push(c);
        }
      }
    }
  }
  return out;
}

/** The rectangle at (i0, j0) of wI x hJ cells, or null when its streets will not make a region. */
function candidateAt(ctx: PlanContext, spec: RegionSpec, shape: WeekendShape, axis: 'i' | 'j', i0: number, j0: number, wI: number, hJ: number, nodeAt: (i: number, j: number) => RoadNode | null): Candidate | null {
  const g = ctx.graph;
  const inRect = (i: number, j: number) => i >= i0 && i <= i0 + wI && j >= j0 && j <= j0 + hJ;
  const onRing = (i: number, j: number) => inRect(i, j) && (i === i0 || i === i0 + wI || j === j0 || j === j0 + hJ);
  // The ring in order: along j0, up i0 + wI, back along j0 + hJ, down i0.
  const ringIJ: [number, number][] = [];
  for (let i = i0; i < i0 + wI; i++) ringIJ.push([i, j0]);
  for (let j = j0; j < j0 + hJ; j++) ringIJ.push([i0 + wI, j]);
  for (let i = i0 + wI; i > i0; i--) ringIJ.push([i, j0 + hJ]);
  for (let j = j0 + hJ; j > j0; j--) ringIJ.push([i0, j]);
  const ring: number[] = [];
  for (const [i, j] of ringIJ) {
    const n = nodeAt(i, j);
    if (!n || n.ring || ctx.claims.node.has(n.id)) return null;
    ring.push(n.id);
  }
  // Every side of the ring a plain street. A side the grid generator dropped is laid again (a straight street between its two
  // junctions, CFG.maxRestore at most): the ring must close round the region, and the block beside it is whole again.
  const restore: [number, number][] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const c = gridChain(g, a, b);
    if (c && c.edges.some((e) => !plainEdge(ctx, e))) return null;
    if (!c) restore.push([a, b]);
  }
  if (restore.length > CFG.maxRestore) return null;
  const inner: number[] = [];
  for (let j = j0 + 1; j < j0 + hJ; j++) {
    for (let i = i0 + 1; i < i0 + wI; i++) {
      const n = nodeAt(i, j);
      if (!n || n.ring || ctx.claims.node.has(n.id)) return null;
      inner.push(n.id);
    }
  }
  if (inner.length < 2) return null;
  inner.sort((a, b) => a - b);
  // Classify every street leaving a junction of the rectangle: a ring side (kept), an inner street (deleted) or an approach (kept, a candidate end).
  const dead = new Set<number>();
  const outward = new Map<number, number[]>();
  for (const id of [...ring, ...inner]) {
    const n = g.nodes[id];
    for (const eid of n.edges) {
      const c = chainFrom(g, id, eid);
      const far = g.nodes[c.nodes[c.nodes.length - 1]];
      if (far.gi < 0) return null;
      const side = onRing(n.gi, n.gj) && onRing(far.gi, far.gj) && Math.abs(far.gi - n.gi) + Math.abs(far.gj - n.gj) === 1 && ((far.gi === n.gi && (n.gi === i0 || n.gi === i0 + wI)) || (far.gj === n.gj && (n.gj === j0 || n.gj === j0 + hJ)));
      if (side) continue;
      if (inRect(far.gi, far.gj)) {
        if (c.edges.some((e) => !plainEdge(ctx, e))) return null;
        for (const e of c.edges) dead.add(e);
      } else {
        outward.set(id, [...(outward.get(id) ?? []), eid]);
      }
    }
  }
  // A laid side must not push its junctions past the degree cap once the inner streets are gone (and the spine is on).
  for (const [a, b] of restore) {
    for (const id of [a, b]) {
      const left = g.nodes[id].edges.filter((e) => !dead.has(e)).length + restore.filter((q) => q.includes(id)).length + 1;
      if (left > CITY.maxNodeDegree) return null;
    }
  }
  // Ends: side junctions (no corner) of the two sides across the spine's axis, where a plain street arrives square from outside.
  const ends = (low: boolean): End[] => {
    const out: End[] = [];
    const span = axis === 'i' ? hJ : wI;
    for (let t = 1; t < span; t++) {
      const [i, j] = axis === 'i' ? [low ? i0 : i0 + wI, j0 + t] : [i0 + t, low ? j0 : j0 + hJ];
      const [oi, oj] = axis === 'i' ? [low ? i0 + wI : i0, j0 + t] : [i0 + t, low ? j0 + hJ : j0];
      const n = nodeAt(i, j)!;
      const o = nodeAt(oi, oj)!;
      const across = unit(o.x - n.x, o.z - n.z);
      for (const eid of outward.get(n.id) ?? []) {
        const c = chainFrom(g, n.id, eid);
        const far = g.nodes[c.nodes[c.nodes.length - 1]];
        // Straight out from the side: the far junction is the next one along the spine's axis, outside.
        const fi = axis === 'i' ? (low ? i - 1 : i + 1) : i;
        const fj = axis === 'i' ? j : low ? j - 1 : j + 1;
        if (far.gi !== fi || far.gj !== fj) continue;
        if (c.length < CFG.minApproach || c.edges.some((e) => !plainEdge(ctx, e)) || ctx.claims.node.has(c.nodes[1])) continue;
        const prev = g.nodes[c.nodes[1]];
        const dir = unit(n.x - prev.x, n.z - prev.z);
        if (angleBetween(dir, across) > (CFG.maxApproachDeg * Math.PI) / 180) continue;
        out.push({ node: n.id, dir, edges: c.edges.slice(), next: c.nodes[1], width: g.edges[c.edges[0]].width });
      }
    }
    return out;
  };
  const lows = ends(true);
  const highs = ends(false);
  let best: Candidate | null = null;
  for (const a of lows) {
    for (const b of highs) {
      const A = g.nodes[a.node];
      const B = g.nodes[b.node];
      const chord = unit(B.x - A.x, B.z - A.z);
      const bendA = angleBetween(a.dir, chord);
      const bendB = angleBetween(b.dir, { x: -chord.x, z: -chord.z });
      if (spec.straight && Math.max(bendA, bendB) > (CFG.maxStraightDeg * Math.PI) / 180) continue;
      const score = bendA + bendB;
      if (best && score >= best.score) continue;
      const P1 = spec.straight ? { x: A.x + chord.x * CFG.flare, z: A.z + chord.z * CFG.flare } : { x: A.x + a.dir.x * CFG.flare, z: A.z + a.dir.z * CFG.flare };
      const Pk = spec.straight ? { x: B.x - chord.x * CFG.flare, z: B.z - chord.z * CFG.flare } : { x: B.x + b.dir.x * CFG.flare, z: B.z + b.dir.z * CFG.flare };
      let spine: Vec2[];
      if (spec.straight) {
        spine = inner.map((_, m) => ({ x: P1.x + ((Pk.x - P1.x) * m) / (inner.length - 1), z: P1.z + ((Pk.z - P1.z) * m) / (inner.length - 1) }));
      } else {
        const L = sqrt((Pk.x - P1.x) ** 2 + (Pk.z - P1.z) ** 2) / 3;
        spine = bezierPoints(P1, { x: P1.x + a.dir.x * L, z: P1.z + a.dir.z * L }, { x: Pk.x + b.dir.x * L, z: Pk.z + b.dir.z * L }, Pk, inner.length);
      }
      best = { shape, i0, j0, wI, hJ, ring, restore, inner, dead: [...dead].sort((p, q) => p - q), entry: a, exit: b, spine, score };
    }
  }
  return best;
}

/** Ring edges (each side's pieces) of a ring of junctions on this graph. */
function ringEdgesOf(g: RoadGraph, ring: readonly number[]): number[] {
  const out: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const c = gridChain(g, ring[k], ring[(k + 1) % ring.length]);
    if (c) out.push(...c.edges);
  }
  return out;
}

/**
 * Lay the spine and delete the inner streets on `g`: move the inner junctions onto the spine (bend nodes, kept at their
 * grid ids), add the spine's pieces, delete the inner pieces (one renumbering, reported to `renumbered`).
 */
function regionEdit(g: RoadGraph, c: Candidate, spec: RegionSpec, renumbered: (r: Renumber) => void): Carved {
  c.inner.forEach((id, m) => {
    const n = g.nodes[id];
    n.x = c.spine[m].x;
    n.z = c.spine[m].z;
    n.bend = true;
  });
  for (const [a, b] of c.restore) addEdge(g, a, b, 'street');
  const seq = [c.entry.node, ...c.inner, c.exit.node];
  const spineEdges: number[] = [];
  for (let m = 0; m + 1 < seq.length; m++) {
    const width = m === 0 ? c.entry.width : m === seq.length - 2 ? c.exit.width : spec.spineWidth;
    spineEdges.push(addEdge(g, seq[m], seq[m + 1], 'feature', { width, lanes: 2, sidewalk: 0 }));
  }
  sortNodeEdges(g);
  const ringEdges = ringEdgesOf(g, c.ring);
  const approach = [...c.entry.edges, ...c.exit.edges];
  const r = removeEdges(g, c.dead);
  renumbered(r);
  const n = (id: number) => r.node[id];
  const e = (id: number) => r.edge[id];
  return {
    spine: seq.map(n),
    spineEdges: spineEdges.map(e),
    ring: c.ring.filter((id) => id !== c.entry.node && id !== c.exit.node).map(n),
    ringEdges: ringEdges.map(e),
    approach: approach.map(e),
    next: [n(c.entry.next), n(c.exit.next)],
  };
}

/** The merged block (the region's polygon) on an edited copy: the spine's pieces taken out again, the face round the spine's middle. */
function mergedBlock(trial: RoadGraph, carved: Carved): BlockFace | null {
  const g = cloneGraph(trial);
  const mid = g.nodes[carved.spine[Math.floor(carved.spine.length / 2)]];
  const probe = { x: mid.x, z: mid.z };
  // The inner junctions go with their pieces here (only on this copy): they are no grid junctions for removeEdges.
  for (const id of carved.spine.slice(1, -1)) g.nodes[id].gi = -1;
  removeEdges(g, carved.spineEdges);
  const faces = computeFaces(g, computeSectors(g));
  return faces.find((f) => !f.outer && pointInPolygon(probe.x, probe.z, f.ring)) ?? null;
}

/** Does the spine keep inside the block, clear of its ring past the flares, and turn gently at every node? */
function spineFits(trial: RoadGraph, carved: Carved, poly: Vec2[], spec: RegionSpec): boolean {
  const pts = carved.spine.map((id) => ({ x: trial.nodes[id].x, z: trial.nodes[id].z }));
  for (let m = 1; m + 1 < pts.length; m++) {
    const a = unit(pts[m].x - pts[m - 1].x, pts[m].z - pts[m - 1].z);
    const b = unit(pts[m + 1].x - pts[m].x, pts[m + 1].z - pts[m].z);
    if (angleBetween(a, b) > (32 * Math.PI) / 180) return false;
  }
  for (const p of samplePolyline(pts.slice(1, -1), 6)) {
    if (!pointInPolygon(p.x, p.z, poly) || distToPolygonEdge(p.x, p.z, poly) < spec.spineWidth / 2 + 8) return false;
  }
  return true;
}

/**
 * Is the channel (as it would plan on these edited streets) clear of the region? Its band keeps off the polygon, and
 * nothing it does to the streets (straightening its bank rows, splitting streets for its ramps and bridges) touches
 * the ring or the spine: the channel plans on a copy and every ring side and spine piece must come through it with
 * the same pieces (grid junction ids survive the channel's renumbering; the ring and the spine are grid junctions).
 */
function channelKeepsOff(trial: RoadGraph, ctx: PlanContext, c: Candidate, poly: Vec2[]): boolean {
  const { params: channel, graph: after } = channelPlanOn({ ...ctx, graph: trial } as PlanContext);
  if (!channel) return true;
  const reach = channel.top + 8;
  for (const p of samplePolyline([...poly, poly[0]], 12)) if (Math.abs(channelL(channel, p.x, p.z)) < reach) return false;
  for (let k = 0; k < c.ring.length; k++) {
    const a = c.ring[k];
    const b = c.ring[(k + 1) % c.ring.length];
    const before = gridChain(trial, a, b);
    const now = gridChain(after, a, b);
    if (!before || !now || now.edges.length !== before.edges.length) return false;
  }
  const seq = [c.entry.node, ...c.inner, c.exit.node];
  for (let m = 0; m + 1 < seq.length; m++) if (edgeBetween(after, seq[m], seq[m + 1]) < 0) return false;
  return true;
}

/**
 * The carve step of a weekend module: pick the region, lay the spine, delete the inner streets and register the area
 * (claims on the spine, the ring, the approach streets and their junctions). Returns the area, or null when the city
 * has no rectangle the spec fits (the special is then not promised). Draws from the module's stream only.
 */
export function carveRegion(ctx: PlanContext, spec: RegionSpec): Area | null {
  const g = ctx.graph;
  const rng = ctx.rng;
  const seed = rng.int(1, 0x7ffffffe);
  const cands = candidates(ctx, spec);
  // Best first, the seed's draw breaking near ties so neighbouring days differ.
  const keyed = cands.map((c) => ({ c, k: c.score + rng.range(0, 0.35) }));
  keyed.sort((p, q) => p.k - q.k);
  for (let t = 0; t < Math.min(CFG.tries, keyed.length); t++) {
    const c = keyed[t].c;
    const trial = cloneGraph(g);
    let carved: Carved;
    try {
      carved = regionEdit(trial, c, spec, () => {});
    } catch {
      continue;
    }
    if (!graphIsConnected(trial)) continue;
    const block = mergedBlock(trial, carved);
    if (!block) continue;
    const poly = block.ring.map((p) => ({ x: p.x, z: p.z }));
    const footprint = Math.abs(polygonArea(poly));
    if (ctx.budget.used + footprint > ctx.budget.total) continue;
    if (!spineFits(trial, carved, poly, spec)) continue;
    if (!channelKeepsOff(trial, ctx, c, poly)) continue;
    const real = regionEdit(g, c, spec, (r) => ctx.graphChanged(r));
    const lineStart = g.edges.length;
    const nodeStart = g.nodes.length;
    spec.lines?.(g, real.spine, poly);
    sortNodeEdges(g);
    const lineEdges: number[] = [];
    for (let e = lineStart; e < g.edges.length; e++) {
      const ed = g.edges[e];
      const a = g.nodes[ed.a];
      const b = g.nodes[ed.b];
      if (ed.kind !== 'feature' || !pointInPolygon((a.x + b.x) / 2, (a.z + b.z) / 2, poly)) throw new Error(`${spec.kind}: a line edge must be a feature edge inside the region`);
      lineEdges.push(e);
    }
    const lineNodes: number[] = [];
    for (let n = nodeStart; n < g.nodes.length; n++) lineNodes.push(n);
    const path = real.spine.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
    return ctx.addArea(
      {
        kind: spec.kind,
        variant: 'region',
        polygon: poly,
        path,
        nodes: [...real.spine, real.next[0], real.next[1], ...real.ring, ...lineNodes],
        edges: [...real.spineEdges, ...lineEdges, ...real.ringEdges, ...real.approach],
        faces: [],
        params: {
          region: 1,
          planned: 0,
          special: 0,
          seed,
          spineNodes: real.spine.length,
          lineEdges: lineEdges.length,
          approachEdges: real.approach.length,
          spineWidth: spec.spineWidth,
          widthE: c.entry.width,
          widthX: c.exit.width,
          along: c.shape.along,
          across: c.shape.across,
          i0: c.i0,
          j0: c.j0,
          cellsI: c.wI,
          cellsJ: c.hJ,
          straight: spec.straight ? 1 : 0,
          driven0: 0,
          driven1: 0,
          dir0: 0,
          dir1: 0,
        },
      },
      footprint,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes

/**
 * Which way a route drives the spine end to end: 1 entry to exit, -1 exit to entry, 0 not at all. `strict` (the
 * routes planRoads picks) also asks that the route arrives along one approach street and leaves along the other
 * (never turning in off the ring), and, on a sprint, that the spine keeps off the start and that its far end keeps
 * CFG.sprintTailClear of road from the finish, so the grid and the finish line stand outside the region.
 */
export function spineDirection(g: RoadGraph, nodes: readonly number[], closed: boolean, r: Pick<Region, 'spine' | 'approachE' | 'approachX'>, strict = true): 0 | 1 | -1 {
  const n = nodes.length;
  const k = r.spine.length;
  if (n < k) return 0;
  const at = (i: number) => nodes[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    for (const dir of [1, -1] as const) {
      let ok = true;
      for (let m = 0; m < k && ok; m++) ok = at(i + m) === r.spine[dir > 0 ? m : k - 1 - m];
      if (!ok) continue;
      if (!closed && (i < 1 || i + k > n - 1)) return 0;
      if (!strict) return dir;
      const before = dir > 0 ? r.approachE : r.approachX;
      const after = dir > 0 ? r.approachX : r.approachE;
      if (at(i - 1) !== before || at(i + k) !== after) return 0;
      if (!closed) {
        let tail = 0;
        for (let m = i + k - 1; m + 1 < n; m++) tail += sqrt((g.nodes[nodes[m + 1]].x - g.nodes[nodes[m]].x) ** 2 + (g.nodes[nodes[m + 1]].z - g.nodes[nodes[m]].z) ** 2);
        if (tail < CFG.sprintTailClear + ROUTE.sprintFinishNodeClear) return 0;
      }
      return dir;
    }
  }
  return 0;
}

/** Does this route drive the seed's region the way planRoads wants it (true on a seed with no region)? */
export function weekendDriven(ctx: PlanContext, nodes: readonly number[], closed: boolean): boolean {
  const r = weekendRegion(ctx);
  return !r || spineDirection(ctx.graph, nodes, closed, r) !== 0;
}

/**
 * The route finders' wish with the region's added (world.ts planRoads): a route that drives the spine is rated
 * above every other, the finders start at the entry and the exit, the spine's pieces weigh CFG.spineBias of their
 * length and the ring's CFG.ringBias times theirs. `base` is the flavour's own preference, kept as the lesser rating
 * (a route with both wins). A seed with no region returns `base` itself.
 */
export function weekendPreference(ctx: PlanContext, base: RoutePreference, closed: boolean): RoutePreference {
  const r = weekendRegion(ctx);
  if (!r) return base;
  const g = ctx.graph;
  const spine = new Set(r.spineEdges);
  const ring = new Set(r.ringEdges);
  const baseRate = base.rate ?? ((nodes: number[]) => (base.prefer(nodes) ? 1 : 0));
  const goal = base.goal ?? 1;
  const rate = (nodes: number[]) => baseRate(nodes) + (spineDirection(g, nodes, closed, r) !== 0 ? goal + 1 : 0);
  const baseBias = base.bias;
  const E = r.spine[0];
  const X = r.spine[r.spine.length - 1];
  return {
    prefer: (nodes) => rate(nodes) > 0,
    rate,
    goal: 2 * goal + 1,
    anchors: [E, X, ...base.anchors],
    via: [X, E, ...(base.via ?? [])],
    bias: (e) => (baseBias ? baseBias(e) : 1) * (spine.has(e) ? CFG.spineBias : ring.has(e) ? CFG.ringBias : 1),
  };
}

/** The region's polygon, held against the route shortcuts and the car parks (PlanContext.keepOut); [] without one. */
export function weekendKeepOut(ctx: PlanContext): Vec2[][] {
  const r = weekendRegion(ctx);
  return r ? [r.polygon] : [];
}

/**
 * The plan step of a weekend module (its registry slot, right after the topology hook): claim every block face
 * inside the region and record how the routes drive the spine. Returns the region, or null when this seed carved
 * none. Faces are claimed once, so calling it again is harmless.
 */
export function planRegion(ctx: PlanContext, kind: AreaKind): Region | null {
  if (ctx.weekend?.kind !== kind) return null;
  const r = weekendRegion(ctx);
  if (!r) return null;
  const area = r.area;
  if (area.params.planned) return r;
  const mine = new Set([...r.spineEdges, ...r.lineEdges, ...r.ringEdges]);
  const faces = ctx.faces().filter((f) => !f.outer && f.edges.every((e) => mine.has(e)));
  if (!faces.length || faces.some((f) => ctx.claims.face.has(f.id))) return r;
  area.faces = faces.map((f) => f.id).sort((p, q) => p - q);
  for (const f of area.faces) ctx.claims.face.set(f, area.id);
  const routes = ctx.event?.routes ?? [];
  routes.slice(0, 2).forEach((rt, i) => {
    const d = spineDirection(ctx.graph, rt.nodes, rt.closed, r);
    area.params[`driven${i}`] = d ? 1 : 0;
    area.params[`dir${i}`] = d;
  });
  area.params.planned = 1;
  area.params.special = area.params.driven0 && area.params.driven1 ? 1 : 0;
  return r;
}

/** The direction (1 entry to exit, -1 back) the race runs the spine: the circuit's, else the sprint's, else 1. */
export function raceDirection(area: Area): 1 | -1 {
  return (area.params.dir0 || area.params.dir1 || 1) > 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Build

/** The spine's points entry to exit with their widths: the flare pieces at the approach streets' widths. */
export function spineWidths(r: Region): number[] {
  return r.path.slice(0, -1).map((_, m) => (m === 0 ? r.widthE : m === r.path.length - 2 ? r.widthX : r.spineWidth));
}

/**
 * The region's shared ground: no building or infill inside the polygon, every frontage wall in it opened, and the
 * module's firm base surface over all of it (priority 4: over the sidewalks, under the street classification of the
 * spine's asphalt, 5). Modules add their own patches above it (slick, dirt, cobbles) at 6 and up.
 */
export function regionGround(b: AreaBuild, r: Region, surface: Surface): void {
  b.exclusions.push(r.polygon);
  b.openings.push(r.polygon);
  b.surfaces.push({ surface, polygon: r.polygon, priority: 4, area: r.area.id });
}

/** A piece of the region's fence: a segment on the ring and its inward unit normal. */
export interface RegionFencePiece {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
}

/**
 * The fence round the region: the polygon in pieces of at most `piece` m, open where the spine crosses it (the
 * entry's and the exit's mouths: the flare's half width plus CFG.mouthClear each side). Pure on the area, so the
 * build and the renderer agree. The module stands a solid of its look on each (regionFenceWalls) or opens more of it.
 */
export function regionFence(r: Region, piece = 8): RegionFencePiece[] {
  const poly = r.polygon;
  const n = poly.length;
  const ccw = polygonArea(poly) > 0;
  const ends = [
    { a: r.path[0], b: r.path[1], half: r.widthE / 2 + CFG.mouthClear },
    { a: r.path[r.path.length - 2], b: r.path[r.path.length - 1], half: r.widthX / 2 + CFG.mouthClear },
  ];
  const open = (x: number, z: number) =>
    ends.some((s) => {
      const t = segmentT(x, z, s.a.x, s.a.z, s.b.x, s.b.z);
      const px = s.a.x + (s.b.x - s.a.x) * t;
      const pz = s.a.z + (s.b.z - s.a.z) * t;
      return (x - px) ** 2 + (z - pz) ** 2 < s.half * s.half;
    });
  const out: RegionFencePiece[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (len < 0.2) continue;
    const dx = (q.x - p.x) / len;
    const dz = (q.z - p.z) / len;
    // Inward: left of travel on a counter-clockwise ring (atan2 convention: x right, z up), right on a clockwise one.
    const nx = ccw ? -dz : dz;
    const nz = ccw ? dx : -dx;
    const steps = Math.max(1, Math.ceil(len / 0.5));
    let start = -1;
    const flush = (s0: number, s1: number) => {
      const k = Math.max(1, Math.ceil((s1 - s0) / piece));
      for (let j = 0; j < k; j++) {
        const t0 = s0 + ((s1 - s0) * j) / k;
        const t1 = s0 + ((s1 - s0) * (j + 1)) / k;
        if (t1 - t0 > 0.05) out.push({ ax: p.x + dx * t0, az: p.z + dz * t0, bx: p.x + dx * t1, bz: p.z + dz * t1, nx, nz });
      }
    };
    for (let s = 0; s <= steps; s++) {
      const t = (len * s) / steps;
      const shut = !open(p.x + dx * t, p.z + dz * t);
      if (shut && start < 0) start = t;
      if ((!shut || s === steps) && start >= 0) {
        flush(start, shut ? t : Math.max(start, t - len / steps));
        start = -1;
      }
    }
  }
  return out;
}

/** Solid fence bodies of `look`, `thick` m deep inward from each piece (solid both sides: no car is ever shoved through). */
export function regionFenceWalls(b: AreaBuild, r: Region, look: WallLook, thick: number, piece = 8): RegionFencePiece[] {
  const pieces = regionFence(r, piece);
  for (const p of pieces) {
    const quad: Vec2[] = [
      { x: p.ax, z: p.az },
      { x: p.bx, z: p.bz },
      { x: p.bx + p.nx * thick, z: p.bz + p.nz * thick },
      { x: p.ax + p.nx * thick, z: p.az + p.nz * thick },
    ];
    b.walls.push(...solidWalls(quad, look, r.area.id));
  }
  return pieces;
}

/** The spine as a FeatureLine (entry to exit), for a module's lines(). */
export function spineLine(r: Region, name: string, surface: Surface, level: FeatureLine['level'] = 'ground', difficulty: FeatureLine['difficulty'] = 1): FeatureLine {
  return { id: 'spine', name, kind: 'spine', path: r.path.map((p) => ({ x: p.x, z: p.z })), width: r.spineWidth, level, surface, difficulty };
}

/** The lines contract (types.ts), re-exported beside the helpers that make it. */
export type { FeatureLine };

// ---------------------------------------------------------------------------
// Race progress

/** A route's region as race progress sees it. */
interface RegionTrack {
  poly: Vec2[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** The spine in driving order, with cumulative lengths (m). */
  path: Vec2[];
  cum: number[];
  /** Route position of the spine's first point (in driving order) and the route distance to its last (m). */
  sIn: number;
  span: number;
}
const tracks = new WeakMap<object, RegionTrack | null>();

/** What region progress needs of a world (race.ts passes its World). */
interface ProgressWorld {
  areas: readonly Area[];
  graph: RoadGraph;
  route: Route;
  openWorld?: boolean;
}

/** Route position (polyline m) nearest a point, over the whole route. */
function routeS(route: Route, x: number, z: number): number {
  let best = Infinity;
  let s = 0;
  const P = route.points;
  for (let i = 0; i + 1 < P.length; i++) {
    const t = segmentT(x, z, P[i].x, P[i].z, P[i + 1].x, P[i + 1].z);
    const px = P[i].x + (P[i + 1].x - P[i].x) * t;
    const pz = P[i].z + (P[i + 1].z - P[i].z) * t;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best) {
      best = d;
      s = route.cum[i] + t * (route.cum[i + 1] - route.cum[i]);
    }
  }
  return s;
}

function trackFor(world: ProgressWorld): RegionTrack | null {
  if (!world.areas || !world.route || !world.graph) return null;
  let t = tracks.get(world.route);
  if (t !== undefined) return t;
  t = null;
  const area = world.openWorld ? undefined : world.areas.find((a) => CORRIDOR_AREAS.has(a.kind) && a.params.region === 1 && a.params.planned === 1);
  const r = area ? regionOf(area) : null;
  const dir = r ? spineDirection(world.graph, world.route.nodes, world.route.closed, r, false) : 0;
  if (r && dir) {
    const path = dir > 0 ? r.path.slice() : r.path.slice().reverse();
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + sqrt((path[i].x - path[i - 1].x) ** 2 + (path[i].z - path[i - 1].z) ** 2));
    const route = world.route;
    const sIn = routeS(route, path[0].x, path[0].z);
    let span = routeS(route, path[path.length - 1].x, path[path.length - 1].z) - sIn;
    if (route.closed) span = ((span % route.length) + route.length) % route.length;
    if (span > 0) t = { poly: r.polygon, ...polygonBounds(r.polygon), path, cum, sIn, span };
  }
  tracks.set(world.route, t);
  return t;
}

/**
 * Race progress for a car inside the route's region, or null outside it (or with no region the route drives).
 * Anywhere in the region a car may be far from the spine (on a line along the far side, up on a deck, down a
 * trench), and the nearest route segment could be the approach street behind it: the car is placed along the
 * spine instead (the nearest point of the spine in driving order, mapped linearly onto the route stretch from
 * the entry to the exit), so progress runs on monotonically on every line, the wrong way check reads the spine's
 * direction, and once the car leaves the polygon the plain projection (World.routeProgress) takes over where
 * this one ends.
 */
export function regionProgress(world: ProgressWorld, x: number, z: number): RouteProgress | null {
  const t = trackFor(world);
  if (!t || x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ || !pointInPolygon(x, z, t.poly)) return null;
  const route = world.route;
  let bi = 0;
  let bt = 0;
  let best = Infinity;
  for (let i = 0; i + 1 < t.path.length; i++) {
    const a = t.path[i];
    const b = t.path[i + 1];
    const u = segmentT(x, z, a.x, a.z, b.x, b.z);
    const d = (x - a.x - (b.x - a.x) * u) ** 2 + (z - a.z - (b.z - a.z) * u) ** 2;
    if (d < best) {
      best = d;
      bi = i;
      bt = u;
    }
  }
  const a = t.path[bi];
  const b = t.path[bi + 1];
  const len = t.cum[bi + 1] - t.cum[bi] || 1;
  const tx = (b.x - a.x) / len;
  const tz = (b.z - a.z) / len;
  let s = t.sIn + ((t.cum[bi] + bt * len) / t.cum[t.cum.length - 1]) * t.span;
  if (route.closed) s = ((s % route.length) + route.length) % route.length;
  else s = Math.min(s, route.length);
  const px = a.x + (b.x - a.x) * bt;
  const pz = a.z + (b.z - a.z) * bt;
  return { s, lateral: (x - px) * tz - (z - pz) * tx, seg: segmentAt(route.cum, s), tx, tz };
}
