/**
 * Weekend special: The Underground (src/city/weekend.ts, docs/weekend.md).
 *
 * A route street sunk into a lit concrete trench for two blocks, its old street level kept alive on both sides as
 * service roads: two packs race side by side five metres apart, one above the other, and can drop or jump between
 * them. Boston's Big Dig half finished at night: sodium lamps on the retaining walls, jet fans on gantries, plywood
 * hoarding, a stalled bus. Planned only on the seeds whose weekend pick is `underground`; every other seed returns
 * at once (before drawing anything), so weekday cities stay bit-identical.
 *
 * Planning, in three steps (districts/index.ts):
 *  - carve (before anything plans; deleting streets renumbers every id, as the lake's carve does): pick a plain
 *    interior run of three grid junctions A - M - B along a row or a column, a street each side, both end junctions
 *    with a cross street, and delete the cross street at M (its pieces, both sides). M is left with the two run
 *    pieces: it moves onto the chord of A and B, the two halves are straightened (roadGraph.ts mergeChains) and M
 *    becomes a pass-through bend node, so the run is one straight street the trench's frame stands on exactly
 *    (the walls never need to follow a warp). Its two pieces carry `RoadEdge.trench` (no start grid or finish line
 *    on them) and the area claims A, M, B and both pieces so nothing later touches them. Each candidate is tried on a
 *    copy first: the channel's plan on the edited copy (lake.ts channelWithout) must keep clear of the run's band.
 *  - routes (world.ts planRoads): `undergroundPreference` rates a route that drives the run above any other and
 *    pulls the finders through its two end nodes with a weight bias on its pieces, the way Channel Run pulls them
 *    to the channel; `undergroundKeepOut` holds the two blocks against the route shortcuts.
 *  - plan (its registry slot, right after the topology hook: the night market's width edit tolerates the claim, index.ts graphChanged): claim the two merged blocks either side and set the area's
 *    polygon and layout from the finished streets (the ramps start past each junction's reach). Whether each route
 *    drives the run is recorded in the params (`driven0`, `driven1`; the test counts them).
 *
 * Cross section, from the street's axis (v): the floor, concrete, as wide as the street (`road`, the curb line) and
 * `depth` under grade; the retaining wall at its edge, which is the floor face of a solid plinth (`plinth` wide,
 * a kerb `kerb` over grade; one convex body per 12 m so each takes its own height); then the service road, `service`
 * wide, asphalt at grade, on the old sidewalk and the frontage beyond (buildings kept out, the frontage opened).
 * The plinth is the one wall: its floor face stops the cars below, its service face and kerb the cars above, and a
 * car flying more than `kerb` over grade (the construction kicker's throw) passes over it (Wall.top, set by
 * settleUnderground once the terrain exists). The walls stand on the curb line, so the street's road is the floor:
 * no wall is on a road the test's check would not have allowed.
 *
 * Three lines: the floor, fast, a stalled articulated bus in one lane ringed by barrels, cones and sawhorses; the
 * service roads, the safe line, narrower, works vehicles parked along the hoarding; and the two moves between the
 * levels. The demolished section: 30 m of plinth gone and the wall's climb widened to a steep rubble bevel (a 5 m
 * drop), plywood hoarding (destructible fence panels) along its lip with a gap in it. The construction kicker: a
 * spoil heap under steel plates in the floor, angled toward the service road across the street, whose lip throws
 * a car at 40 m/s about 12 m/s up (a 7 m apex) onto that road; its flanks are solid barriers, and the landing
 * stretch of the service road is kept clear of vehicles. Both are read by light and by the gap in the hoarding, never
 * a sign. Elevation: the ramps and the trench. Bank: none here. Drift zone: none.
 */
import { CITY, ROUTE } from '../config';
import type { RoadGraph, Renumber } from '../roadGraph';
import { chainFrom, edgeBetween, graphIsConnected, gridChain, isBendNode, mergeChains, removeEdges, sortNodeEdges } from '../roadGraph';
import type { BlockFace } from '../blocks';
import { computeMouths, computeSectors, makeWall } from '../blocks';
import type { DistrictPropSpec } from '../props';
import type { RoutePreference } from '../routeSearch';
import type { Terrain } from '../terrain';
import { Rng, deriveSeed } from '../../sim/prng';
import { type Vec2, atan2, cos, sin, sqrt } from '../../sim/math';
import type { Area, AreaBuild, BuildContext, DistrictModule, PlanContext } from './types';
import { emptyBuild } from './types';
import { pointInPolygon, solidWalls } from './geom';
import { edgeFaces, junctionReach, routeTraffic, siteClear, siteHazards, toWorld, TRAFFIC_FLOOR, weightedOrder } from './structures';
import type { Frame } from './structures';
import { highwayRolled, highwayRows } from './highway/line';
import { channelL } from './channel';
import { channelWithout } from './lake';
import { undergroundBox, undergroundHeight, undergroundLayout, undergroundShape, kickerFlight } from './undergroundShape';
import type { UndergroundLayout, UndergroundShape } from './undergroundShape';

const CFG = CITY.districts.underground;

/** Hint kinds the renderer reads (AreaHint.kind). */
export const UNDERGROUND_HINT = {
  /** Per plinth segment: values [u0, u1, side]. */
  plinth: 'ugPlinth',
  /** The bus: points [centre], values [yaw (rad, from +u), length, width, height]. */
  bus: 'ugBus',
  /** A works vehicle: points [centre], values [yaw, length, width, height, type (0 truck, 1 excavator, 2 light tower)]. */
  vehicle: 'ugVehicle',
  /** A footbridge abutment: points [centre], values [side, size]. */
  abutment: 'ugAbutment',
  /** How the walls array splits: values [plinth walls, kicker flank walls]; the rest is the bus, the vehicles and the abutments. */
  groups: 'ugGroups',
} as const;

/** A frame of the run's straight chord from two end positions: origin at the middle, u from a to b. */
function chordFrame(a: Vec2, b: Vec2): Frame & { length: number } {
  const length = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
  return { cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, ux: (b.x - a.x) / length, uz: (b.z - a.z) / length, length };
}

/** Rectangle u0..u1 x v0..v1 in a frame as a polygon. */
function frameRect(f: Frame, u0: number, u1: number, v0: number, v1: number): Vec2[] {
  return [toWorld(f, u0, v0), toWorld(f, u1, v0), toWorld(f, u1, v1), toWorld(f, u0, v1)];
}

/** A rectangle of the given length (along its axis) and width, centred at (u, v) in a frame, its axis turned `yaw` rad from +u toward +v. */
function orientedRect(f: Frame, u: number, v: number, yaw: number, length: number, width: number): Vec2[] {
  const c = cos(yaw);
  const s = sin(yaw);
  const pts: [number, number][] = [
    [-length / 2, -width / 2],
    [length / 2, -width / 2],
    [length / 2, width / 2],
    [-length / 2, width / 2],
  ];
  return pts.map(([a, b]) => toWorld(f, u + a * c - b * s, v + a * s + b * c));
}

// ---------------------------------------------------------------------------
// Carve

function cloneGraph(g: RoadGraph): RoadGraph {
  return { nodes: g.nodes.map((n) => ({ ...n, edges: n.edges.slice() })), edges: g.edges.map((e) => ({ ...e })), bounds: { ...g.bounds }, plan: g.plan };
}

/** A run found on the grid, before the edit. */
interface Candidate {
  a: number;
  m: number;
  b: number;
  /** The cross street's pieces at m, to delete. */
  dead: number[];
  /** The other junctions on the four blocks' rings, claimed too so no roundabout takes a corner of them. */
  corners: number[];
  /** Ordering weight: the traffic the run's pieces carry. */
  weight: number;
}

/** The run's ids after the edit. */
interface Carved {
  a: number;
  m: number;
  b: number;
  edges: [number, number];
  corners: number[];
}

/** A plain street piece: no bridge, shortcut or level crossing; `kinds` names the street kinds that count as plain. */
const STREET_ONLY = (g: RoadGraph, e: number, kinds: readonly string[] = RUN_KINDS): boolean => {
  const ed = g.edges[e];
  return kinds.includes(ed.kind) && !ed.bridge && !ed.shortcut && ed.crossing === undefined;
};
/** Streets a run and its cross street may be, and the kinds the blocks beside it may be bounded by. */
const RUN_KINDS = ['street', 'avenue'] as const;
const BLOCK_KINDS = ['street', 'avenue', 'boulevard'] as const;

/**
 * Delete the cross street, move m onto the chord of a and b, straighten both halves and make m a pass-through
 * bend node; `renumbered` is called after every edit that compacts the ids (PlanContext.graphChanged for the real graph).
 */
function carveEdit(g: RoadGraph, c: Candidate, renumbered: (r: Renumber) => void): Carved {
  const r1 = removeEdges(g, c.dead);
  renumbered(r1);
  let corners = c.corners.map((n) => r1.node[n]).filter((n) => n >= 0);
  let a = r1.node[c.a];
  let m = r1.node[c.m];
  let b = r1.node[c.b];
  const cAM = gridChain(g, a, m)!;
  const cMB = gridChain(g, m, b)!;
  const A = g.nodes[a];
  const B = g.nodes[b];
  const t = cAM.length / (cAM.length + cMB.length);
  g.nodes[m].x = A.x + (B.x - A.x) * t;
  g.nodes[m].z = A.z + (B.z - A.z) * t;
  const r2 = mergeChains(g, [cAM, cMB]);
  renumbered(r2);
  corners = corners.map((n) => r2.node[n]).filter((n) => n >= 0);
  a = r2.node[a];
  m = r2.node[m];
  b = r2.node[b];
  g.nodes[m].bend = true;
  const e1 = edgeBetween(g, a, m);
  const e2 = edgeBetween(g, m, b);
  g.edges[e1].trench = true;
  g.edges[e2].trench = true;
  return { a, m, b, edges: [e1, e2], corners };
}

/** Plain interior runs of three grid junctions along a row or a column that a trench can take, with their cross streets. */
function candidatesOf(ctx: PlanContext): Candidate[] {
  const g = ctx.graph;
  const W = g.plan.gridW;
  const H = g.plan.gridH;
  const e0 = CFG.edgeCells;
  const out: Candidate[] = [];
  const faces = ctx.faces();
  const sides = edgeFaces(faces);
  const faceOf = new Map<number, BlockFace>(faces.map((f) => [f.id, f]));
  const traffic = routeTraffic(g, ctx.seed);
  // The expressway runs along rows (highway/line.ts): keep off the rows its plan tries first, as the lake does.
  const keepRows = new Set<number>();
  if (highwayRolled(ctx.seed)) {
    const hw = new Rng(deriveSeed(ctx.seed, 'district:highway'));
    hw.chance(CITY.districts.highway.chance);
    for (const r of highwayRows(hw, H).slice(0, CITY.districts.lake.highwayRows)) keepRows.add(r);
  }
  const plainFace = (f: BlockFace | undefined): boolean => {
    if (!f || f.outer || ctx.claims.face.has(f.id)) return false;
    if (f.edges.some((e) => !STREET_ONLY(g, e, BLOCK_KINDS) || ctx.claims.edge.has(e))) return false;
    if (f.corners.some((k) => g.nodes[k.node].ring || ctx.claims.node.has(k.node))) return false;
    return true;
  };
  for (const vertical of [false, true]) {
    for (let j = vertical ? e0 : e0; j <= (vertical ? H - 3 - e0 : H - 1 - e0); j++) {
      for (let i = e0; i <= (vertical ? W - 1 - e0 : W - 3 - e0); i++) {
        const id = (di: number) => (vertical ? (j + di) * W + i : j * W + i + di);
        const [a, m, b] = [id(0), id(1), id(2)];
        const nodes = [a, m, b].map((n) => g.nodes[n]);
        if (nodes.some((n, k) => !n || n.gi !== (vertical ? i : i + k) || n.gj !== (vertical ? j + k : j) || n.ring || ctx.claims.node.has(n.id))) continue;
        const rows = vertical ? [j, j + 1, j + 2] : [j - 1, j, j + 1];
        if (!vertical && rows.some((r) => keepRows.has(r))) continue;
        if (vertical && [j, j + 1, j + 2].some((r) => keepRows.has(r))) continue;
        if (nodes[0].edges.length < 3 || nodes[0].edges.length > 5 || nodes[2].edges.length < 3 || nodes[2].edges.length > 5 || nodes[1].edges.length < 3 || nodes[1].edges.length > 4) continue;
        const cAM = gridChain(g, a, m);
        const cMB = gridChain(g, m, b);
        if (!cAM || !cMB) continue;
        const run = [...cAM.edges, ...cMB.edges];
        if (run.some((e) => !STREET_ONLY(g, e) || ctx.claims.edge.has(e)) || cAM.length + cMB.length < CFG.minLength) continue;
        // Straight enough: m moves onto the chord of a and b.
        const t = cAM.length / (cAM.length + cMB.length);
        const stray = Math.hypot(nodes[1].x - (nodes[0].x + (nodes[2].x - nodes[0].x) * t), nodes[1].z - (nodes[0].z + (nodes[2].z - nodes[0].z) * t));
        if (stray > CFG.maxStray) continue;
        // The cross street(s) at m: every other piece, each to a grid junction that keeps two streets.
        const dead: number[] = [];
        let ok = true;
        const own = new Set([cAM.edges[cAM.edges.length - 1], cMB.edges[0]]);
        for (const eid of nodes[1].edges) {
          if (own.has(eid)) continue;
          const c = chainFrom(g, m, eid);
          const end = g.nodes[c.nodes[c.nodes.length - 1]];
          if (end.gi < 0 || end.edges.length < 3 || end.ring || ctx.claims.node.has(end.id) || c.edges.some((e) => !STREET_ONLY(g, e) || ctx.claims.edge.has(e))) {
            ok = false;
            break;
          }
          dead.push(...c.edges);
        }
        if (!ok || !dead.length) continue;
        // The four blocks beside the run: each plain, four sided, distinct.
        const fs = [...(sides.get(cAM.edges[0]) ?? []), ...(sides.get(cMB.edges[cMB.edges.length - 1]) ?? [])];
        if (fs.length !== 4 || new Set(fs).size !== 4 || fs.some((f) => !plainFace(faceOf.get(f)))) continue;
        let use = 0;
        for (const e of run) use += traffic[e];
        const corners = [...new Set(fs.flatMap((f) => faceOf.get(f)!.corners.map((k) => k.node)))].filter((n) => n !== a && n !== m && n !== b && !isBendNode(g, n)).sort((p, q) => p - q);
        out.push({ a, m, b, dead, corners, weight: TRAFFIC_FLOOR + use / run.length });
      }
    }
  }
  return out;
}

/** The ramp tops of a run on this graph: half the chord minus the widest junction reach and the gap (m). */
function rampTop(g: RoadGraph, run: { a: number; b: number; edges: readonly number[] }): number {
  const f = chordFrame(g.nodes[run.a], g.nodes[run.b]);
  const mouths = computeMouths(g, computeSectors(g));
  const reach = Math.max(junctionReach(g, mouths, g.edges[run.edges[0]], run.a), junctionReach(g, mouths, g.edges[run.edges[1]], run.b));
  return f.length / 2 - reach - CFG.junctionGap;
}

/** Does the flat floor fit, with a little room for the streets at the ends to change before the plan? */
const fits = (g: RoadGraph, run: Carved): boolean => rampTop(g, run) - CFG.rampRun >= CFG.minFloorHalf + 2;

/** Is the channel (as it would plan on this graph) clear of the run's area by its band and a margin? */
function channelKeepsOff(g: RoadGraph, run: Carved, channel: Record<string, number> | null): boolean {
  if (!channel) return true;
  const f = chordFrame(g.nodes[run.a], g.nodes[run.b]);
  const reach = channel.top + 8;
  // The channel straightens the streets of its two bank rows (its plan's mergeChains), which would take the run's pieces: the run stays a block clear of them.
  for (let u = -f.length / 2; u <= f.length / 2 + 1e-6; u += 12) {
    const p = toWorld(f, u, 0);
    if (Math.abs(channelL(channel, p.x, p.z)) < CFG.channelRowClear) return false;
  }
  for (let u = -f.length / 2; u <= f.length / 2 + 1e-6; u += 12) {
    for (let v = -CFG.areaHalf; v <= CFG.areaHalf + 1e-6; v += 16) {
      const p = toWorld(f, u, v);
      if (Math.abs(channelL(channel, p.x, p.z)) < reach) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Routes

/** The underground area, if this seed planned one. */
function undergroundArea(ctx: { areas: readonly Area[] }): Area | undefined {
  return ctx.areas.find((a) => a.kind === 'underground');
}

/**
 * How a route drives the run: through A, M, B in either order. On a sprint the run must also keep off the start
 * grid (the first street) and the finish (config sprintTailClear of road after it), so the grid and the
 * finish line never stand in the trench; a circuit's start goes to its longest street that is not a trench piece
 * (route.ts circuitStart).
 */
export function drivesRun(g: RoadGraph, nodes: readonly number[], closed: boolean, a: number, m: number, b: number): boolean {
  const n = nodes.length;
  const at = (i: number) => nodes[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const fwd = at(i) === a && at(i + 1) === m && at(i + 2) === b;
    const back = at(i) === b && at(i + 1) === m && at(i + 2) === a;
    if (!fwd && !back) continue;
    if (closed) return true;
    if (i < 1 || i + 2 > n - 2) return false;
    let after = 0;
    for (let k = i + 2; k + 1 < n; k++) after += Math.hypot(g.nodes[nodes[k + 1]].x - g.nodes[nodes[k]].x, g.nodes[nodes[k + 1]].z - g.nodes[nodes[k]].z);
    return after >= CFG.sprintTailClear + ROUTE.sprintFinishNodeClear;
  }
  return false;
}

/**
 * The route finders' wish with the Underground's added (world.ts planRoads): a route that drives the run is rated
 * above every other, an anchor at each end of the run, and its pieces weigh `routeBias` of their length. `base` is
 * the flavour's own preference; the result keeps its wish as the lesser rating (a route with both wins). A seed
 * with no run returns `base` untouched.
 */
export function undergroundPreference(ctx: PlanContext, base: RoutePreference, closed: boolean): RoutePreference {
  const area = ctx.weekend?.kind === 'underground' ? undergroundArea(ctx) : undefined;
  if (!area || area.nodes.length < 3) return base;
  const [a, m, b] = area.nodes;
  const g = ctx.graph;
  const pieces = new Set(area.edges);
  const baseRate = base.rate ?? ((nodes: number[]) => (base.prefer(nodes) ? 1 : 0));
  const goal = base.goal ?? 1;
  const rate = (nodes: number[]) => baseRate(nodes) + (drivesRun(g, nodes, closed, a, m, b) ? goal + 1 : 0);
  const baseBias = base.bias;
  return {
    prefer: (nodes) => rate(nodes) > 0,
    rate,
    goal: 2 * goal + 1,
    anchors: [a, b, ...base.anchors],
    via: [b, a, ...(base.via ?? [])],
    bias: (e) => (baseBias ? baseBias(e) : 1) * (pieces.has(e) ? CFG.routeBias : 1),
  };
}

/** The two blocks either side of the run, as rings: held against the route shortcuts while they are carved (PlanContext.keepOut). */
export function undergroundKeepOut(ctx: PlanContext): Vec2[][] {
  const area = ctx.weekend?.kind === 'underground' ? undergroundArea(ctx) : undefined;
  if (!area || area.nodes.length < 3) return [];
  return blocksBeside(ctx, area).map((f) => f.ring);
}

/** The faces (N then S side by v) beside the run's middle. */
function blocksBeside(ctx: PlanContext, area: Area): BlockFace[] {
  const g = ctx.graph;
  const A = g.nodes[area.nodes[0]];
  const B = g.nodes[area.nodes[2]];
  const f = chordFrame(A, B);
  const w = g.edges[area.edges[0]];
  const out: BlockFace[] = [];
  for (const side of [1, -1]) {
    const p = toWorld(f, 0, side * (w.width / 2 + w.sidewalk + 12));
    const face = ctx.faces().find((q) => !q.outer && pointInPolygon(p.x, p.z, q.ring));
    if (face) out.push(face);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module

export const undergroundModule: DistrictModule = {
  kind: 'underground',
  phase: 'graph',

  carve(ctx) {
    if (!CFG.enabled || ctx.weekend?.kind !== 'underground') return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const cands = candidatesOf(ctx);
    const order = weightedOrder(
      cands.map((_, i) => i),
      (i) => cands[i].weight,
      rng,
    );
    for (let t = 0; t < Math.min(CFG.tries, order.length); t++) {
      const c = cands[order[t]];
      const trial = cloneGraph(g);
      let run: Carved;
      try {
        run = carveEdit(trial, c, () => {});
      } catch {
        continue;
      }
      if (!graphIsConnected(trial)) continue;
      if (!fits(trial, run)) continue;
      const channel = channelWithout({ ...ctx, graph: trial } as PlanContext);
      if (!channelKeepsOff(trial, run, channel)) continue;
      const real = carveEdit(g, c, (r) => ctx.graphChanged(r));
      sortNodeEdges(g);
      const A = g.nodes[real.a];
      const B = g.nodes[real.b];
      ctx.addArea({
        kind: 'underground',
        variant: 'trench',
        polygon: [],
        path: [
          { x: A.x, z: A.z },
          { x: B.x, z: B.z },
        ],
        nodes: [real.a, real.m, real.b, ...real.corners],
        edges: real.edges,
        faces: [],
        params: { planned: 0, seed: rng.int(1, 0x7ffffffe) },
      });
      return;
    }
  },

  // The carve has already deleted its street when this runs: a plan that finds the site spoiled (a bluff planned since the carve stands on the blocks) leaves the area unplanned (`params.planned` 0, no polygon, no build); resolveEvent then names no special.
  plan: planArea,

  build: (ctx, area) => buildArea(ctx, area),
};

/** Claim the blocks and lay the area out from the finished streets (the module's plan, right after the routes are picked). */
function planArea(ctx: PlanContext): void {
    if (!CFG.enabled || ctx.weekend?.kind !== 'underground') return;
    const area = undergroundArea(ctx);
    if (!area || area.params.planned || area.nodes.length < 3 || area.edges.length !== 2) return;
    const g = ctx.graph;
    const [a, , b] = area.nodes;
    const A = g.nodes[a];
    const B = g.nodes[b];
    const f = chordFrame(A, B);
    const e1 = g.edges[area.edges[0]];
    const e2 = g.edges[area.edges[1]];
    const road = e1.width / 2;
    const front = road + e1.sidewalk;
    const mouths = computeMouths(g, ctx.sectors());
    const reach = Math.max(junctionReach(g, mouths, e1, a), junctionReach(g, mouths, e2, b));
    const top = f.length / 2 - reach - CFG.junctionGap;
    if (top - CFG.rampRun < CFG.minFloorHalf) return;
    // Both blocks beside the run: unclaimed and still plain, holding the whole frontage the service roads and the abutments take.
    const blocks = blocksBeside(ctx, area);
    if (blocks.length !== 2 || blocks[0].id === blocks[1].id) return;
    const edgeBad = (e: number) => {
      const ed = g.edges[e];
      return !!ed.shortcut || !!ed.bridge || ed.crossing !== undefined;
    };
    const back = front + CFG.frontBack;
    for (const [k, blk] of blocks.entries()) {
      if (ctx.claims.face.has(blk.id) || blk.edges.some(edgeBad) || blk.corners.some((c) => g.nodes[c.node].ring)) return;
      const sg = k === 0 ? 1 : -1;
      for (const u of [-top, 0, top]) {
        for (const v of [front + 0.8, back]) {
          const p = toWorld(f, u, sg * v);
          if (!pointInPolygon(p.x, p.z, blk.ring)) return;
        }
      }
    }
    const hz = siteHazards(ctx);
    // What is built stands between the ramp tops (plus the abutments' margin): the junctions at the ends are the streets' own ground.
    for (let u = -top - 6; u <= top + 6 + 1e-6; u += 15) {
      for (let v = -(back + 3); v <= back + 3 + 1e-6; v += 16) {
        const p = toWorld(f, u, v);
        if (!siteClear(hz, p.x, p.z, 2)) return;
      }
    }
    // Which way the circuit drives the run (the kicker is built for it); the sprint's, then +u, when the circuit does not.
    let dir = 0;
    const drives = (ctx.event?.routes ?? []).map((r) => {
      const n = r.nodes.length;
      for (let i = 0; i < n; i++) {
        const at = (k: number) => r.nodes[(i + k) % n];
        if (at(0) === a && at(2) === b && at(1) === area.nodes[1]) return 1;
        if (at(0) === b && at(2) === a && at(1) === area.nodes[1]) return -1;
      }
      return 0;
    });
    for (const d of drives) if (!dir && d) dir = d;
    const rng = ctx.rng;
    const sd = rng.chance(0.5) ? 1 : -1;
    const foot = blocks.reduce((s, q) => s + q.area, 0);
    area.polygon = frameRect(f, -f.length / 2, f.length / 2, -CFG.areaHalf, CFG.areaHalf);
    area.faces = blocks.map((q) => q.id);
    for (const q of blocks) ctx.claims.face.set(q.id, area.id);
    ctx.budget.used += foot;
    Object.assign(area.params, {
      planned: 1,
      cx: f.cx,
      cz: f.cz,
      ux: f.ux,
      uz: f.uz,
      half: f.length / 2,
      road,
      front,
      top,
      dir: dir || 1,
      sd,
      driven0: drives[0] ? 1 : 0,
      driven1: drives[1] ? 1 : 0,
    });
}

/** The area's walls, surfaces, height modifier, exclusions, props and the hints its renderer reads. */
function buildArea(_ctx: BuildContext, area: Area): AreaBuild {
    const b = emptyBuild();
    if (!area.params.planned) return b;
    const s = undergroundShape(area);
    const lay = undergroundLayout(s);
    const { road: F, top: T } = s;
    const front = area.params.front;
    const P = CFG.plinth;
    const Sw = CFG.service;
    const id = area.id;
    const rng = new Rng(deriveSeed(area.params.seed, 'underground:build'));

    // Heights: the trench and the kicker in one modifier.
    b.heightMods.push({ ...undergroundBox(s), add: (x, z, out) => undergroundHeight(s, lay, x, z, out) });

    // Surfaces: the concrete floor over the street's road, the service roads' asphalt over the old sidewalk and frontage, the rubble.
    b.surfaces.push({ surface: 'concrete', polygon: frameRect(s, -T, T, -F, F), priority: 6, area: id });
    for (const side of [1, -1]) b.surfaces.push({ surface: 'road', polygon: frameRect(s, -T, T, side * (F + P), side * (F + P + Sw)), priority: 6, area: id });
    const D = CFG.demolished;
    b.surfaces.push({ surface: 'offroad', polygon: frameRect(s, lay.window - D.half, lay.window + D.half, s.sd * F, s.sd * (F + D.run)), priority: 7, area: id });

    // Buildings keep back from the service roads and the frontage there is opened; the old sidewalk's furniture goes.
    for (const side of [1, -1]) {
      const strip = frameRect(s, -T, T, side * (front - 0.6), side * (front + CFG.frontBack));
      b.exclusions.push(strip);
      b.openings.push(strip);
      for (let u = -T - 2; u <= T + 2 + 1e-6; u += 3) {
        const c = toWorld(s, u, side * (F + front) / 2);
        b.reserved.push({ x: c.x, z: c.z, r: (front - F) / 2 + 0.8 });
      }
    }

    // Walls. The plinth first, one convex body per segment so each takes its own height; the window's side has none inside it.
    const solids: { u: number; v: number; yaw: number; length: number; width: number }[] = [];
    const plinthStart = b.walls.length;
    for (const side of [1, -1]) {
      const spans: [number, number][] = side === s.sd ? [[-T, lay.window - D.half], [lay.window + D.half, T]] : [[-T, T]];
      for (const [lo, hi] of spans) {
        if (hi - lo < 0.5) continue;
        const n = Math.max(1, Math.ceil((hi - lo) / 12));
        for (let k = 0; k < n; k++) {
          const u0 = lo + ((hi - lo) * k) / n;
          const u1 = lo + ((hi - lo) * (k + 1)) / n;
          for (const w of solidWalls(frameRect(s, u0, u1, side * F, side * (F + P)), 'trenchWall', id)) b.walls.push(w);
          b.hints.push({ kind: UNDERGROUND_HINT.plinth, points: [], values: [u0, u1, side] });
        }
      }
    }
    const plinthEnd = b.walls.length;
    // The kicker's flank barriers.
    const K = CFG.kicker;
    const hx = lay.heading.x;
    const hz = lay.heading.z;
    const kp = (aa: number, bb: number) => toWorld(s, lay.foot.x + hx * aa - hz * bb, lay.foot.z + hz * aa + hx * bb);
    for (const side of [1, -1]) {
      const b0 = K.width / 2 + K.flankGap;
      const b1 = b0 + K.flankWidth;
      // Pointed at both ends (a convex hexagon): a car meeting an end head-on glances off it instead of stopping dead.
      const a0 = 2;
      const a1 = lay.kickLength + 1;
      const tip = 3.5;
      const bm = (b0 + b1) / 2;
      const poly = [kp(a0, side * bm), kp(a0 + tip, side * b0), kp(a1 - tip, side * b0), kp(a1, side * bm), kp(a1 - tip, side * b1), kp(a0 + tip, side * b1)];
      for (const w of solidWalls(poly, 'trenchWall', id)) b.walls.push(w);
    }
    const flankEnd = b.walls.length;
    b.hints.push({ kind: UNDERGROUND_HINT.groups, points: [], values: [plinthStart, plinthEnd, flankEnd] });
    // The stalled bus, a solid in its lane, and its hint.
    const yawBus = (CFG.bus.yawDeg * Math.PI) / 180 * -s.sd;
    for (const w of solidWalls(orientedRect(s, lay.bus.x, lay.bus.z, yawBus, CFG.bus.length, CFG.bus.width), 'trenchWall', id)) b.walls.push(w);
    solids.push({ u: lay.bus.x, v: lay.bus.z, yaw: yawBus, length: CFG.bus.length, width: CFG.bus.width });
    b.hints.push({ kind: UNDERGROUND_HINT.bus, points: [toWorld(s, lay.bus.x, lay.bus.z)], values: [yawBus, CFG.bus.length, CFG.bus.width, CFG.bus.height] });

    // Works vehicles along the hoarding of each service road, off the window's stretch and the kicker's landing stretch.
    const W = CFG.works;
    const lands = [36, 40, 50].map((v) => kickerFlight(lay, v).land.x);
    const landLo = Math.min(...lands) - 8;
    const landHi = Math.max(...lands) + 8;
    for (const side of [1, -1]) {
      const v = side * (F + P + W.inset);
      const step = W.length + W.gap;
      for (let u = -T + 14 + rng.range(0, 6); u <= T - 14; u += step + rng.range(-4, 6)) {
        if (side === s.sd && Math.abs(u - lay.window) < D.half + W.length) continue;
        if (side === -s.sd && u > landLo && u < landHi) continue;
        if (Math.abs(u - lay.bridges[0]) < 6 || Math.abs(u - lay.bridges[1]) < 6) continue;
        const yaw = rng.range(-0.03, 0.03);
        const type = rng.int(0, 2);
        for (const w of solidWalls(orientedRect(s, u, v, yaw, W.length, W.width), 'trenchWall', id)) b.walls.push(w);
        solids.push({ u, v, yaw, length: W.length, width: W.width });
        b.hints.push({ kind: UNDERGROUND_HINT.vehicle, points: [toWorld(s, u, v)], values: [yaw, W.length, W.width, W.height, type] });
      }
    }
    // The footbridges' abutments, beside each service road's outer edge.
    const B = CFG.bridge;
    for (const u of lay.bridges) {
      for (const side of [1, -1]) {
        const v0 = F + P + Sw + B.abutOut;
        for (const w of solidWalls(frameRect(s, u - B.abut / 2, u + B.abut / 2, side * v0, side * (v0 + B.abut)), 'trenchWall', id)) b.walls.push(w);
        b.hints.push({ kind: UNDERGROUND_HINT.abutment, points: [toWorld(s, u, side * (v0 + B.abut / 2))], values: [side, B.abut] });
      }
    }

    // The hoarding along each service road's outer edge, the plywood fence the works stand behind: one sided, in 16 m pieces.
    const hoard = F + P + Sw + 0.3;
    for (const side of [1, -1]) {
      const n = Math.ceil((2 * T) / 16);
      for (let k = 0; k < n; k++) {
        const u0 = -T + (2 * T * k) / n;
        const u1 = -T + (2 * T * (k + 1)) / n;
        const w = makeWall(toWorld(s, u0, side * hoard), toWorld(s, u1, side * hoard), toWorld(s, (u0 + u1) / 2, side * (hoard - 3)), 'wall');
        if (!w) continue;
        w.look = 'trenchWall';
        w.area = id;
        b.walls.push(w);
      }
    }
    // Destructibles: a ring round the bus, the window's hoarding, clusters of works clutter along both service roads.
    const out: DistrictPropSpec[] = [];
    const at = (u: number, v: number): Vec2 => toWorld(s, u, v);
    const clear = (u: number, v: number, r: number) => !solids.some((q) => Math.abs((u - q.u) * cos(q.yaw) + (v - q.v) * sin(q.yaw)) < q.length / 2 + r && Math.abs(-(u - q.u) * sin(q.yaw) + (v - q.v) * cos(q.yaw)) < q.width / 2 + r);
    const put = (kind: DistrictPropSpec['kind'], u: number, v: number, yaw: number) => {
      if (!clear(u, v, 0.4)) return;
      const p = at(u, v);
      out.push({ kind, x: p.x, z: p.z, yaw, lift: 0, area: id });
    };
    /** Facing across the street toward -side (a hoarding facing the floor) or along it. */
    const faceAcross = (side: number) => atan2(-side * -s.uz, -side * s.ux);
    const faceAlong = atan2(s.ux, s.uz);
    const dirU = s.dir;
    // The bus: barrels at both ends, cones tapering out ahead of it, sawhorses across the lane before them, a water barrier and sandbags at its flank.
    const busU = lay.bus.x;
    const lane = lay.bus.z;
    const halfB = CFG.bus.length / 2;
    for (const end of [-1, 1]) {
      const e = busU + end * (halfB + 1.8);
      put('barrel', e, lane - 0.9, rng.range(-3, 3));
      put('barrel', e + end * 0.2, lane + 0.8, rng.range(-3, 3));
    }
    const upstream = busU - dirU * (halfB + 3.5);
    // Cones taper out of the free lane toward the bus's, six of them over fifteen metres.
    for (let k = 0; k < 6; k++) put('trafficCone', upstream - dirU * 3 * (5 - k), lane * (0.15 + (0.85 * k) / 5), 0);
    put('sawhorse', upstream - dirU * 1.2, lane + Math.sign(lane) * 0.2, faceAcross(1));
    put('sawhorse', upstream - dirU * 1.2, lane - Math.sign(lane) * 1.9, faceAcross(1));
    put('waterBarrier', busU + dirU * (halfB + 5), lane + Math.sign(lane) * 1.2, faceAlong);
    put('sandbags', busU + dirU * (halfB + 6.6), lane - Math.sign(lane) * 1.0, 0);
    // The window's hoarding: plywood panels along the rubble's lip with a gap, sandbags at the gap's jambs.
    const lip = s.sd * (F + D.run + D.panelBack);
    const gapAt = lay.window + rng.range(-6, 6);
    for (let u = lay.window - D.half + 1; u <= lay.window + D.half - 1 + 1e-6; u += D.panelStep) {
      if (Math.abs(u - gapAt) < D.gap / 2) continue;
      put('fencePanel', u, lip, faceAcross(s.sd));
    }
    put('sandbags', gapAt - D.gap / 2 - 0.2, lip + s.sd * 0.2, 0);
    put('sandbags', gapAt + D.gap / 2 + 0.2, lip + s.sd * 0.2, 0);
    put('sawhorse', lay.window - D.half - 1.5, lip + s.sd * 1.2, faceAcross(s.sd));
    put('sawhorse', lay.window + D.half + 1.5, lip + s.sd * 1.2, faceAcross(s.sd));
    // Clutter along the service roads' outer edges, away from the landing stretch.
    for (const side of [1, -1]) {
      const v = side * (F + P + Sw - 0.8);
      for (let k = 0; k < 7; k++) {
        const u = rng.range(-T + 12, T - 12);
        if (side === -s.sd && u > landLo && u < landHi) continue;
        if (side === s.sd && Math.abs(u - lay.window) < D.half + 3) continue;
        const kind = (['pallets', 'sandbags', 'barrel', 'waterBarrier', 'trafficCone', 'sawhorse'] as const)[rng.int(0, 5)];
        put(kind, u, v, rng.range(-3, 3));
        put(kind === 'barrel' ? 'barrel' : 'trafficCone', u + 1.2, v - 0.5, 0);
      }
    }
    b.destructibles.push(...out);
    return b;
}

/**
 * Heights of the walls that cars fly over, once the terrain exists (world.ts createCity): a plinth segment's top is
 * the grade beside it plus the kerb (a car above that passes over it, a car on either level stops), a kicker flank's
 * the floor under it plus its barrier height. The other solids (the bus, the vehicles, the abutments) stand at all
 * heights.
 */
export function settleUnderground(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  for (const area of areas) {
    if (area.kind !== 'underground' || !area.params.planned) continue;
    const bd = builds[area.id];
    const s = undergroundShape(area);
    const groups = bd.hints.find((h) => h.kind === UNDERGROUND_HINT.groups);
    if (!groups) continue;
    const [p0, p1, p2] = groups.values;
    const grade = (u: number, v: number) => {
      const p = toWorld(s, u, v);
      return terrain.heightAt(p.x, p.z);
    };
    const segs = bd.hints.filter((h) => h.kind === UNDERGROUND_HINT.plinth);
    // Each plinth segment is four consecutive walls.
    segs.forEach((h, i) => {
      const [u0, u1, side] = h.values;
      const v = side * (s.road + CFG.plinth + 1.2);
      const top = Math.max(grade(u0, v), grade((u0 + u1) / 2, v), grade(u1, v)) + CFG.kerb;
      for (let k = 0; k < 4; k++) {
        const w = bd.walls[p0 + i * 4 + k];
        if (w && p0 + i * 4 + k < p1) w.top = top;
      }
    });
    for (let i = p1; i < p2; i++) {
      const w = bd.walls[i];
      // The floor under the flank, taken at this face (the four faces of one flank share the lowest, below).
      w.top = terrain.heightAt((w.ax + w.bx) / 2, (w.az + w.bz) / 2) + CFG.kicker.flankHeight;
    }
    // A solid is collided whole at the first face a car does not clear: its faces share one top, the lowest of them.
    const tops = new Map<object, number>();
    for (const w of bd.walls) if (w.solid && w.top !== undefined) tops.set(w.solid, Math.min(tops.get(w.solid) ?? Infinity, w.top));
    for (const w of bd.walls) if (w.solid && w.top !== undefined) w.top = tops.get(w.solid)!;
  }
}

export type { UndergroundLayout, UndergroundShape };
