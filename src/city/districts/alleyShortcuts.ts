/**
 * Route shortcuts (carveRouteShortcuts): once both routes are picked, every
 * circuit and sprint gets its own back alley cut through a block, a corner
 * cut across the inside of a sharp turn or a U cut across a block the route
 * wraps, kept clear of other streets and the corner rails, bent into a
 * dogleg or an arc where the block has room, and often ending in a jump
 * exit. alley.ts builds the area like any back alley.
 */
import { CITY, ROUTE } from '../config';
import { addEdge, addNode, chainCum, chainFrom, edgeBetween, isBendNode, otherNode, splitEdge, type Chain, type RoadGraph } from '../roadGraph';
import { circuitStart } from '../route';
import { type Vec2, atan2, distToSegment, lineIntersectT } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { pointInPolygon } from './geom';
import type { Area, PlanContext } from './types';
import { alleyFlightReach, pathCum, distToPath, chainBackwards, routeChains, chainNodes, corridor, RAD, unit } from './alleyPath';

/** A route shortcut's mouth due within MOUTH_SNAP (m) of a bend node of its street lands on the bend node. */
const MOUTH_SNAP = 10;
/** Corner rails go on route turns at least this sharp (rad). */
const ROUTE_RAIL_MIN_TURN = (ROUTE.railMinTurnDeg * Math.PI) / 180;
/** Spacing of the entry and exit points the fallback chord search tries along each route edge (m). */
const CHORD_STEP = 6;
/** Room (m) a fallback chord keeps from other streets' sidewalks (cfg.clear for the regular cuts). */
const CHORD_CLEAR = 1.5;
/** Splits on a sprint stay this far past its start (grid rows and the start line) and before its end (finish line and runout), m. */
const START_CLEAR = ROUTE.sprintStartOffset + 25;
const FINISH_CLEAR = ROUTE.sprintFinishOffset + ROUTE.sprintFinishNodeClear + 30;

/** Position (m along the node polyline) of a point lying on one of the route's edges, or null. */
function projectOnRoute(g: RoadGraph, r: CarveRoute, cum: number[], p: Vec2): number | null {
  const n = r.nodes.length;
  const m = r.closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = g.nodes[r.nodes[i]];
    const b = g.nodes[r.nodes[(i + 1) % n]];
    if (distToSegment(p.x, p.z, a.x, a.z, b.x, b.z) < 0.01) return cum[i] + Math.hypot(p.x - a.x, p.z - a.z);
  }
  return null;
}

/** A route as the shortcut carver sees it: its nodes in driving order (edited in place when an edge it uses is split). */
export interface CarveRoute {
  nodes: number[];
  closed: boolean;
}

interface Cut {
  /** Route edges the entry and exit are on, the route node each is measured from and how far from it (m). */
  eA: number;
  fromA: number;
  dA: number;
  eB: number;
  fromB: number;
  dB: number;
  /** The alley's path, entry first: the straight chord, bent by the planner's bend() when carved, or a jump cut's planned chain. */
  path: Vec2[];
  /** Length of the path (m). */
  length: number;
  /** Route distance the cut skips (m). */
  skip: number;
  /** Route position of the entry along the node polyline (m). */
  at: number;
  score: number;
  /** The route streets' directions at the entry and the exit (unit) and the least angle (rad) each mouth may make with its street. */
  uIn: Vec2;
  uOut: Vec2;
  minMouth: number;
  /** Route edges the path may run beside (the ones it splits), and the room it keeps from every other street (m). */
  skipEdges: number[];
  clear: number;
  /** Inside corners the path keeps clear of (the junctions it cuts). */
  corners: Corner[];
  /** Unit normal to the chord on the side the path bends toward (away from the corners). */
  away: Vec2;
  /** A jump exit planned for this cut (jump cuts only). */
  jump?: JumpPlan;
}

/** A route junction the cut goes round: its node and the two route roads leaving it (unit directions, half widths to the building line). */
interface Corner {
  C: Vec2;
  u1: Vec2;
  h1: number;
  u2: Vec2;
  h2: number;
}

interface JumpPlan {
  /** The lip stands this far before the exit node along the last leg (m). */
  lipS: number;
  /** Furthest landing from the lip the run-up allows (m), and how far past the exit node the landing zone ends along the street (m). */
  landMax: number;
  zone: number;
}

/** Length of a polyline (m). */
function pathLength(path: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return l;
}

/** Route node positions along the node polyline (m) and its length. Roundabout arcs are ignored: cuts never touch them. */
function nodeCum(g: RoadGraph, r: CarveRoute): { cum: number[]; total: number } {
  const n = r.nodes.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(g.nodes[r.nodes[i]].x - g.nodes[r.nodes[i - 1]].x, g.nodes[r.nodes[i]].z - g.nodes[r.nodes[i - 1]].z));
  const close = r.closed ? Math.hypot(g.nodes[r.nodes[0]].x - g.nodes[r.nodes[n - 1]].x, g.nodes[r.nodes[0]].z - g.nodes[r.nodes[n - 1]].z) : 0;
  return { cum, total: cum[n - 1] + close };
}

/**
 * Where a route's shortcuts may start and end (node cum, m). A sprint's finish line stands
 * sprintFinishOffset before the end, moved earlier by route.ts to keep sprintFinishNodeClear from
 * any intersection; the same rule is applied here on the node polyline with the clearance again as
 * slack, so nothing carved ends up past the finish the builder places.
 */
function routeBounds(g: RoadGraph, r: CarveRoute): { cum: number[]; total: number; lo: number; hi: number } {
  const { cum, total } = nodeCum(g, r);
  if (r.closed) return { cum, total, lo: 0, hi: total };
  let finish = total - ROUTE.sprintFinishOffset;
  for (let i = r.nodes.length - 2; i > 0; i--) if (Math.abs(finish - cum[i]) < ROUTE.sprintFinishNodeClear) finish = cum[i] - ROUTE.sprintFinishNodeClear;
  return { cum, total, lo: ROUTE.sprintStartOffset, hi: finish - ROUTE.sprintFinishNodeClear };
}

/** Signed turn (rad) at route index i; 0 at the ends of a sprint. */
function turnAt(g: RoadGraph, r: CarveRoute, i: number): number {
  const n = r.nodes.length;
  if (!r.closed && (i <= 0 || i >= n - 1)) return 0;
  const a = g.nodes[r.nodes[(i - 1 + n) % n]];
  const b = g.nodes[r.nodes[i]];
  const c = g.nodes[r.nodes[(i + 1) % n]];
  const d1x = b.x - a.x;
  const d1z = b.z - a.z;
  const d2x = c.x - b.x;
  const d2z = c.z - b.z;
  return atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
}

/**
 * The circuit's longest edge: buildRoute puts the start line and grid in its
 * middle, and splitting any other edge only shortens that one. (A sprint's
 * start and finish are guarded by position instead, see the carver.)
 */
function protectedEdges(g: RoadGraph, r: CarveRoute): number[] {
  if (!r.closed) return [];
  // The start straight as route.ts circuitStart picks it: a run of pieces through bend nodes.
  return circuitStart(g, r.nodes).run.edges;
}

/** Insert node m between u and v wherever a route drives the edge u-v (either way, wrapping for circuits). */
function insertSplit(routes: CarveRoute[], u: number, v: number, m: number): void {
  for (const r of routes) {
    const n = r.nodes.length;
    const pairs = r.closed ? n : n - 1;
    for (let k = 0; k < pairs; k++) {
      const a = r.nodes[k];
      const b = r.nodes[(k + 1) % n];
      if ((a === u && b === v) || (a === v && b === u)) {
        r.nodes.splice(k + 1, 0, m);
        break;
      }
    }
  }
}

/**
 * How good a cut is: the distance it saves, minus a steep penalty outside the
 * ideal length range (short alleys are over too soon, very long ones skip half
 * the scenery). U cuts get a small handicap at the call site: they swap the
 * route's corners for two square turns in a narrow alley, a corner cut flows.
 */
function cutScore(skip: number, length: number): number {
  const [lo, hi] = CITY.districts.backAlley.route.idealLength;
  return skip - length - 1.5 * Math.max(0, lo - length) - 1.5 * Math.max(0, length - hi);
}

/** Unit vector perpendicular to u, on the side of v. */
function unitPerp(u: Vec2, v: Vec2): Vec2 {
  let px = -u.z;
  let pz = u.x;
  if (px * v.x + pz * v.z < 0) {
    px = -px;
    pz = -pz;
  }
  return { x: px, z: pz };
}

/** No other street leaves node c inside the wedge between the two route roads (the inside of the turn is one block). */
function wedgeFree(g: RoadGraph, c: number, own: number[], u1: Vec2, u2: Vec2): boolean {
  const C = g.nodes[c];
  const cross = (a: Vec2, b: Vec2) => a.x * b.z - a.z * b.x;
  const w = Math.sign(cross(u1, u2));
  for (const eid of C.edges) {
    if (own.includes(eid)) continue;
    const e = g.edges[eid];
    const d = unit(C, g.nodes[e.a === c ? e.b : e.a]);
    if (Math.sign(cross(u1, d)) === w && Math.sign(cross(d, u2)) === w) return false;
  }
  return true;
}

/**
 * Where a shortcut joining route positions sa and sb (m) enters and leaves in
 * driving order, and the route distance it skips; null unless it is a real
 * shortcut: it saves at least minSave of what it skips, skips at most maxSkip
 * of the lap (or of the sprint from lo to hi) and, on a sprint, stays between
 * lo and hi. Shared by the carver and by buildRoute (Route.shortcuts).
 */
export function shortcutSpan(sa: number, sb: number, length: number, total: number, closed: boolean, lo: number, hi: number): { sIn: number; sOut: number; skip: number; aFirst: boolean } | null {
  const cfg = CITY.districts.backAlley.route;
  let aFirst: boolean;
  let skip: number;
  if (closed) {
    const f = (((sb - sa) % total) + total) % total;
    aFirst = f <= total - f;
    skip = aFirst ? f : total - f;
  } else {
    aFirst = sa <= sb;
    skip = Math.abs(sb - sa);
  }
  const sIn = aFirst ? sa : sb;
  const sOut = aFirst ? sb : sa;
  if (length > skip * (1 - cfg.minSave) || skip > cfg.maxSkip * (closed ? total : hi - lo)) return null;
  if (!closed && (sIn < lo || sOut > hi)) return null;
  return { sIn, sOut, skip, aFirst };
}

/** How many shortcut chains joining two points of the route save distance (carved or adopted): the route's real shortcuts. */
export function qualifiedCount(g: RoadGraph, r: CarveRoute): number {
  const { cum, total, lo, hi } = routeBounds(g, r);
  const pos = new Map<number, number>();
  r.nodes.forEach((id, i) => pos.set(id, cum[i]));
  let count = 0;
  for (const c of routeChains(g, r.nodes)) {
    const sa = pos.get(c.nodes[0]);
    const sb = pos.get(c.nodes[c.nodes.length - 1]);
    if (sa === undefined || sb === undefined) continue;
    const span = shortcutSpan(sa, sb, c.length, total, r.closed, lo, hi);
    if (span && !chainBackwards(c, span.aFirst)) count++;
  }
  return count;
}

/**
 * Guarantee shortcuts on the routes (see the header). Runs once both routes
 * are picked and before blocks exist: it splits route edges, adds the alley
 * edge (flagged shortcut, wider than a plain back alley), registers its area
 * and inserts the split nodes into every route node list that drives a split
 * edge, so the routes stay on the same streets. Deterministic (ctx.rng).
 */
export function carveRouteShortcuts(ctx: PlanContext, routes: CarveRoute[]): void {
  if (!CITY.districts.backAlley.enabled) return;
  const cfg = CITY.districts.backAlley.route;
  const g = ctx.graph;
  const planner = shortcutPlanner(ctx, routes);
  const madeAt: number[][] = routes.map(() => []);
  // The route with the fewest spots cuts first: routes share streets, and one route's cut can take
  // the block another route's only candidate needed.
  const order = routes.map((r, ri) => ({ r, ri, n: planner.candidates(r).length })).sort((a, b) => a.n - b.n);
  for (let pass = 0; pass < cfg.perRoute; pass++) {
    order.forEach(({ r, ri }) => {
      if (qualifiedCount(g, r) > pass) return;
      const { total, lo, hi } = routeBounds(g, r);
      const pick = (jumps: boolean) =>
        planner.candidates(r, jumps).filter(
          (c) =>
            (jumps ? c.jump !== undefined : c.jump === undefined) &&
            c.skip <= cfg.maxSkip * (r.closed ? total : hi - lo) &&
            madeAt[ri].every((at) => {
              const d = Math.abs(c.at - at);
              return (r.closed ? Math.min(d, total - d) : d) >= cfg.spacing;
            }),
        );
      // A jump exit where the roll says so and its landing fits, else a plain cut.
      let list = ctx.rng.chance(cfg.jump.chance) ? pick(true) : [];
      if (!list.length) list = pick(false);
      // A route with no other spot may cut on a circuit's longest edge (the start line then moves to
      // the longest edge left, still far longer than the grid needs), then try any chord.
      if (!list.length && pass === 0) {
        planner.allowProtected(true);
        list = pick(false);
        if (!list.length) list = planner.chordCuts(r);
        planner.allowProtected(false);
      }
      if (!list.length) return;
      // Highest score first; ties keep route order (stable sort), so the pick is deterministic.
      list.sort((a, b) => b.score - a.score);
      const cut = list[0];
      if (!cut.jump) planner.bend(cut, ctx.rng);
      carve(ctx, routes, cut, ctx.rng);
      madeAt[ri].push(cut.at);
    });
  }
  // A random back alley (backAlleyModule) that happens to join two points of a route and save distance
  // is a route shortcut too: it gets the construction site treatment, so every shortcut reads the same.
  for (const r of routes) {
    const { cum, total, lo, hi } = routeBounds(g, r);
    const pos = new Map<number, number>();
    r.nodes.forEach((id, i) => pos.set(id, cum[i]));
    for (const a of ctx.areas) {
      if (a.kind !== 'backAlley' || a.variant === 'routeShortcut') continue;
      const e = g.edges[a.edges[0]];
      const sa = pos.get(e.a);
      const sb = pos.get(e.b);
      if (sa !== undefined && sb !== undefined && shortcutSpan(sa, sb, e.length, total, r.closed, lo, hi)) a.variant = 'routeShortcut';
    }
  }
  // Every back alley's area takes in its flared mouths, now that no more edges will be split.
  for (const a of ctx.areas) if (a.kind === 'backAlley') a.polygon = alleyOutline(ctx, a);
}

/**
 * A back alley's outline with both flared mouths (blocks.ts computeSectors):
 * along its building lines (round the mitred and rounded corners of every
 * bend), round each mouth's curved corners and across its opening on the
 * street's curb line, so the area takes in its funnels and the cones that
 * line them (and the HUD names the funnel the alley's). A jump exit's outline
 * runs on past its mouth along the landing side's sidewalk to the end of the
 * landing zone, for the clutter that marks the landing.
 */
function alleyOutline(ctx: PlanContext, area: Area): Vec2[] {
  const g = ctx.graph;
  const sectors = ctx.sectors();
  const edges = area.edges;
  const nodes = chainNodes(g, edges);
  const last = nodes.length - 1;
  const funnel = (nid: number, eid: number, tongue: Vec2[] = []): Vec2[] => {
    const n = g.nodes[nid];
    const m = n.edges.length;
    const k = n.edges.indexOf(eid);
    // The corner before the alley ends on its clockwise side, the one after starts on its counterclockwise side.
    const cw = sectors[nid][(k - 1 + m) % m];
    const ccw = sectors[nid][k];
    // The landing tongue (two points, curb end first) follows the forward street: the clockwise corner's
    // street or the counterclockwise one's.
    const forward = tongue.length ? n.edges[(k + 1) % m] : -1;
    const cwT = tongue.length && forward !== g.edges[tongueEdge].id ? [tongue[1], tongue[0]] : [];
    const ccwT = tongue.length && forward === g.edges[tongueEdge].id ? tongue : [];
    return [...cw.outer.slice().reverse(), ...cwT, cw.curb[0], ccw.curb[ccw.curb.length - 1], ...ccwT, ...ccw.outer.slice().reverse()];
  };
  let tongueEdge = -1;
  let tongue: Vec2[] = [];
  if (area.params.jumpExit) {
    const O = area.path[area.path.length - 2];
    const Bn = g.nodes[nodes[last]];
    const u = unit(O, Bn);
    for (const eid of Bn.edges) {
      const e = g.edges[eid];
      if (e.shortcut) continue;
      const d = unit(Bn, g.nodes[otherNode(e, Bn.id)]);
      if (d.x * u.x + d.z * u.z <= 0) continue;
      tongueEdge = eid;
      const nb = unitPerp(d, { x: O.x - Bn.x, z: O.z - Bn.z });
      const aEnd = area.params.zone + 4;
      const at = (a: number, l: number): Vec2 => ({ x: Bn.x + d.x * a + nb.x * l, z: Bn.z + d.z * a + nb.z * l });
      tongue = [at(aEnd, e.width / 2 + 0.3), at(aEnd, e.width / 2 + e.sidewalk - 0.05)];
    }
  }
  // At a bend the sector from the outgoing edge round to the incoming one is the left wall (seen along the
  // chain), the other the right wall. Their points are ordered along the chain's direction at the node (a
  // near straight bend's two points sit side by side, so the sector's own order could run either way).
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  const wall = (i: number, eid: number, forward: boolean): Vec2[] => {
    const n = g.nodes[nodes[i]];
    const t = unit(g.nodes[nodes[i - 1]], g.nodes[nodes[i + 1]]);
    const along = (p: Vec2) => (p.x - n.x) * t.x + (p.z - n.z) * t.z;
    return sectors[nodes[i]][n.edges.indexOf(eid)].outer.slice().sort((a, b) => (forward ? along(a) - along(b) : along(b) - along(a)));
  };
  for (let i = 1; i < last; i++) left.push(...wall(i, edges[i], true));
  for (let i = last - 1; i >= 1; i--) right.push(...wall(i, edges[i - 1], false));
  return [...funnel(nodes[0], edges[0]), ...left, ...funnel(nodes[last], edges[edges.length - 1], tongue), ...right];
}

/** Whether a route has room for at least one shortcut, the other routes' start, grid and finish kept clear (dry run: nothing is carved). */
export function hasShortcutSpot(ctx: PlanContext, r: CarveRoute, others: CarveRoute[] = []): boolean {
  const planner = shortcutPlanner(ctx, [r, ...others]);
  // The same skip limit the carve applies, or a route can pass here and then carve nothing.
  const b = routeBounds(ctx.graph, r);
  const maxSkip = CITY.districts.backAlley.route.maxSkip * (r.closed ? b.total : b.hi - b.lo);
  const fits = () => planner.candidates(r).some((c) => c.skip <= maxSkip);
  if (fits()) return true;
  planner.allowProtected(true);
  return fits() || planner.chordCuts(r).length > 0;
}

/** Candidate cuts for the given routes (their start, grid and finish kept clear), scored by the distance they save. */
function shortcutPlanner(ctx: PlanContext, routes: CarveRoute[]) {
  const cfg = CITY.districts.backAlley.route;
  const BEND = cfg.bend;
  const JUMP = cfg.jump;
  const g = ctx.graph;
  const hwAll = cfg.width / 2 + CITY.sidewalkWidth.backAlley;
  const protect = new Set<number>();
  for (const r of routes) for (const e of protectedEdges(g, r)) protect.add(e);
  // Sprints: splits keep clear of the grid and start line, and of the finish line and its runout.
  // Positions are checked on every sprint whose edges a cut splits (routes share streets).
  const sprintGuard = (A: Vec2, B: Vec2): boolean => {
    for (const r of routes) {
      if (r.closed) continue;
      const { cum, total, hi } = routeBounds(g, r);
      for (const p of [A, B]) {
        const s = projectOnRoute(g, r, cum, p);
        if (s === null) continue;
        if (s < START_CLEAR || s > Math.min(total - FINISH_CLEAR, hi - 30)) return false;
      }
    }
    return true;
  };
  /** A jump exit's landing zone (zone m of street past the exit B) stays before every sprint's finish. */
  const landingGuard = (B: Vec2, zone: number): boolean => {
    for (const r of routes) {
      if (r.closed) continue;
      const { cum, total, hi } = routeBounds(g, r);
      const s = projectOnRoute(g, r, cum, B);
      if (s !== null && s + zone > Math.min(total - FINISH_CLEAR, hi - 30)) return false;
    }
    return true;
  };
  const [turnMin, turnMax] = cfg.turnDeg;
  // Areas a cut may not pass through. Hills are terrain, not an obstacle: a back alley climbing a
  // hill block is fine (and the hills claim two to four blocks each, which would starve routes
  // through them of cuts).
  const blocked = ctx.areas.filter((a) => a.kind !== 'subway' && a.kind !== 'downtown' && a.kind !== 'hills' && a.polygon.length >= 3);

  let allowProtected = false;
  const edgeOk = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    return (allowProtected || !protect.has(eid)) && !e.shortcut && !e.bridge && !ctx.claims.edge.has(eid) && (e.kind === 'street' || e.kind === 'avenue' || e.kind === 'boulevard' || e.kind === 'diagonal');
  };
  // The corner itself must be a plain junction (subway column nodes are fine: pillars keep off every
  // road and junction); the far ends of the cut's edges may be anything, roundabouts kept at a distance.
  const cornerOk = (id: number) => !g.nodes[id].ring && (!ctx.claims.node.has(id) || ['subway', 'hills', 'bluff'].includes(ctx.areas[ctx.claims.node.get(id)!].kind));
  /** Other streets' corridors, rivers, roundabouts and other alleys stay clear of the cut's sidewalks. */
  const chordClear = (A: Vec2, B: Vec2, skip: number[], clear: number = cfg.clear): boolean => {
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const minX = Math.min(A.x, B.x) - 45;
    const maxX = Math.max(A.x, B.x) + 45;
    const minZ = Math.min(A.z, B.z) - 45;
    const maxZ = Math.max(A.z, B.z) + 45;
    const steps = Math.max(2, Math.ceil(len / 2));
    for (const f of g.edges) {
      if (skip.includes(f.id)) continue;
      const p = g.nodes[f.a];
      const q = g.nodes[f.b];
      if (Math.max(p.x, q.x) < minX || Math.min(p.x, q.x) > maxX || Math.max(p.z, q.z) < minZ || Math.min(p.z, q.z) > maxZ) continue;
      const need = f.width / 2 + f.sidewalk + hwAll + clear;
      for (let k = 0; k <= steps; k++) {
        const x = A.x + ((B.x - A.x) * k) / steps;
        const z = A.z + ((B.z - A.z) * k) / steps;
        if (distToSegment(x, z, p.x, p.z, q.x, q.z) < need) return false;
      }
    }
    for (const a of blocked) {
      for (let k = 0; k <= steps; k++) if (pointInPolygon(A.x + ((B.x - A.x) * k) / steps, A.z + ((B.z - A.z) * k) / steps, a.polygon)) return false;
    }
    // Sites held for a car park (its block, frontage, driveway and flight).
    for (const poly of ctx.keepOut ?? []) {
      for (let k = 0; k <= steps; k++) if (pointInPolygon(A.x + ((B.x - A.x) * k) / steps, A.z + ((B.z - A.z) * k) / steps, poly)) return false;
    }
    return true;
  };
  /** chordClear along every leg of a path. */
  const pathClear = (path: Vec2[], skip: number[], clear: number = cfg.clear): boolean => {
    for (let i = 0; i + 1 < path.length; i++) if (!chordClear(path[i], path[i + 1], skip, clear)) return false;
    return true;
  };
  /** The inside sidewalk corner at C between the roads leaving along u1 and u2 stays clear of the path, on C's side of its chord. */
  const cornerClear = (c: Corner, path: Vec2[]): boolean => {
    const n1 = unitPerp(c.u1, c.u2);
    const n2 = unitPerp(c.u2, c.u1);
    const p1 = { x: c.C.x + n1.x * c.h1, z: c.C.z + n1.z * c.h1 };
    const p2 = { x: c.C.x + n2.x * c.h2, z: c.C.z + n2.z * c.h2 };
    const t = lineIntersectT(p1, c.u1, p2, c.u2);
    if (t === null) return false;
    const K = { x: p1.x + c.u1.x * t, z: p1.z + c.u1.z * t };
    const A = path[0];
    const ab = unit(A, path[path.length - 1]);
    const side = (P: Vec2) => (P.x - A.x) * ab.z - (P.z - A.z) * ab.x;
    return side(K) * side(c.C) > 0 && distToPath(path, K.x, K.z) >= hwAll + cfg.clear;
  };
  /** Legs long enough to settle on and bends no sharper than a car can take; the first and last legs meet their streets at least minIn / minOut. */
  /**
   * The path leaves the route and rejoins it heading on along it (uIn, uOut: the route's forward
   * direction at the entry and the exit), never doubling back into a hairpin: on a curved street a
   * mouth angle alone allows a leg that meets the street a little backwards.
   */
  const onward = (path: Vec2[], uIn: Vec2, uOut: Vec2): boolean => {
    const n = path.length;
    const a = unit(path[0], path[1]);
    const b = unit(path[n - 2], path[n - 1]);
    return a.x * uIn.x + a.z * uIn.z > 0 && b.x * uOut.x + b.z * uOut.z > 0;
  };
  const pathOk = (path: Vec2[], uIn: Vec2, minIn: number, uOut: Vec2, minOut: number): boolean => {
    for (let i = 0; i + 1 < path.length; i++) if (unit(path[i], path[i + 1]).len < BEND.minLeg) return false;
    for (let i = 1; i + 1 < path.length; i++) {
      const u = unit(path[i - 1], path[i]);
      const v = unit(path[i], path[i + 1]);
      if (Math.abs(Math.atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z)) > BEND.maxDeg * RAD) return false;
    }
    const n = path.length;
    return mouthAngle(unit(path[0], path[1]), uIn) >= minIn && mouthAngle(unit(path[n - 2], path[n - 1]), uOut) >= minOut && onward(path, uIn, uOut);
  };
  /** Clearance an entry keeps from the route junction at the far end of its edge. */
  const endClear = (r: CarveRoute, j: number, cutTurn: number): number => {
    const ring = g.nodes[r.nodes[j]].ring;
    if (ring) return ring.outer + cfg.railClear * 0.6;
    const t = turnAt(g, r, j);
    // A junction turning the other way has its corner rail on the cut's side of the shared edge.
    return Math.abs(t) >= ROUTE_RAIL_MIN_TURN && Math.sign(t) !== Math.sign(cutTurn) ? cfg.railClear : cfg.nodeClear;
  };
  /**
   * Street past route node j (reached `base` m before it from the exit) that a landing car may roll
   * on: through free bend nodes the route barely turns at, up to the first real junction.
   */
  const runPast = (r: CarveRoute, j: number, base: number): number => {
    const n = r.nodes.length;
    let run = base;
    for (let guard = 0; guard < 4; guard++) {
      const node = g.nodes[r.nodes[j]];
      if (node.gi >= 0 || node.edges.length !== 2 || Math.abs(turnAt(g, r, j)) > 8 * RAD) break;
      const next = (j + 1) % n;
      if (!r.closed && next === 0) break;
      run += unit(node, g.nodes[r.nodes[next]]).len;
      j = next;
    }
    return run;
  };
  const mouthAngle = (ab: Vec2, u: Vec2) => Math.acos(Math.min(1, Math.abs(ab.x * u.x + ab.z * u.z)));
  /** Unit normal to the chord A-B on the far side from P. */
  const awayFrom = (A: Vec2, B: Vec2, P: Vec2): Vec2 => {
    const n = unitPerp(unit(A, B), { x: P.x - A.x, z: P.z - A.z });
    return { x: -n.x, z: -n.z };
  };

  /**
   * A jump exit's path from A to B: the last leg meets the exit street
   * (forward direction uE, half width hE to its building line) at exitDeg
   * heading down it, long enough for the lip (just inside where both alley
   * walls still stand), the ramp and a lead-in straight; one bend joins it to
   * A. Null when a leg is too short, the bend too sharp, the entry mouth too
   * oblique or the landing zone does not fit in `run` m of street past B.
   */
  const jumpPath = (A: Vec2, B: Vec2, uIn: Vec2, uE: Vec2, hE: number, run: number, minMouth: number): { path: Vec2[]; jump: JumpPlan } | null => {
    const th = JUMP.exitDeg * RAD;
    const nb = unitPerp(uE, { x: A.x - B.x, z: A.z - B.z });
    const d = { x: uE.x * Math.cos(th) - nb.x * Math.sin(th), z: uE.z * Math.cos(th) - nb.z * Math.sin(th) };
    const lipS = (hE + hwAll * Math.cos(th)) / Math.sin(th) + JUMP.lipBack;
    const L = lipS + JUMP.length + JUMP.lead;
    const P = { x: B.x - d.x * L, z: B.z - d.z * L };
    const path = [A, P, B];
    // The exit mouth is shallow by design: only the entry keeps the plain cut's minimum.
    if (!pathOk(path, uIn, minMouth, uE, th - 1 * RAD)) return null;
    const vMax = Math.sqrt(JUMP.bendSpeed * JUMP.bendSpeed + 2 * JUMP.launchAccel * (JUMP.length + JUMP.lead));
    const landMax = alleyFlightReach(vMax);
    const zone = (landMax - lipS) * Math.cos(th) + JUMP.rollout;
    if (zone + JUMP.landingClear > run || !landingGuard(B, zone)) return null;
    return { path, jump: { lipS, landMax, zone } };
  };

  /**
   * A mouth `d` m along a street chain from its first node, moved onto a bend node within MOUTH_SNAP
   * the way carve() splits: its distance, point and the street's direction there (away from the
   * chain's first node, the next piece's at a bend node).
   */
  const mouthOn = (c: Chain, d: number): { d: number; p: Vec2; u: Vec2 } => {
    const cum = chainCum(g, c);
    let s = d;
    for (let i = 1; i + 1 < c.nodes.length; i++) {
      if (Math.abs(cum[i] - d) <= MOUTH_SNAP) {
        s = cum[i];
        break;
      }
    }
    let k = 0;
    while (k + 1 < c.edges.length && s >= cum[k + 1]) k++;
    const a = g.nodes[c.nodes[k]];
    const b = g.nodes[c.nodes[k + 1]];
    const u = unit(a, b);
    const t = Math.max(0, Math.min(1, (s - cum[k]) / (cum[k + 1] - cum[k] || 1)));
    return { d: s, p: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, u: { x: u.x, z: u.z } };
  };

  /**
   * A mouth's acute corner (where the alley's wall line meets the street's building line, far along
   * the street at a shallow angle) stays on the mouth's own piece of street: no bend node of the chain
   * within its reach on that side, or the block's ring would fold back over the alley. `away` is the
   * alley's direction leaving the mouth, hS the street's half width to its building line.
   */
  const bcfgMouth = CITY.districts.backAlley.mouth;
  const acuteClear = (c: Chain, d: number, away: Vec2, hS: number, flare: number): boolean => {
    const u = mouthOn(c, d).u;
    const cos = away.x * u.x + away.z * u.z;
    // The corner where the building lines cross, then the flare rounding it off along the street (blocks.ts).
    const reach = (hS + hwAll) / Math.sqrt(Math.max(1e-4, 1 - cos * cos)) + flare + 2;
    const cum = chainCum(g, c);
    for (let i = 1; i + 1 < c.nodes.length; i++) {
      const s = cum[i] - d;
      if (Math.abs(s) < 0.5) continue;
      if (cos > 0 ? s > 0 && s < reach : s < 0 && -s < reach) return false;
    }
    return true;
  };

  /**
   * Both mouths of a cut along `path` keep their acute corners, flare included, on their own piece of
   * street (acuteClear); a jump exit's shallow corner gets no flare on a curved street, so only its corner counts.
   */
  const mouthsClear = (cut: Pick<Cut, 'eA' | 'fromA' | 'dA' | 'eB' | 'fromB' | 'dB' | 'jump'>, path: Vec2[]): boolean => {
    const n = path.length;
    const EA = g.edges[cut.eA];
    const EB = g.edges[cut.eB];
    return acuteClear(chainFrom(g, cut.fromA, cut.eA), cut.dA, unit(path[0], path[1]), EA.width / 2 + EA.sidewalk, bcfgMouth.street) && acuteClear(chainFrom(g, cut.fromB, cut.eB), cut.dB, unit(path[n - 1], path[n - 2]), EB.width / 2 + EB.sidewalk, cut.jump ? 0 : bcfgMouth.street);
  };
  /** The reverse of a direction (a mouth's street direction measured from the corner, back along the route). */
  const back = (u: Vec2): Vec2 => ({ x: -u.x, z: -u.z });
  const candidates = (route: CarveRoute, jumps = false): Cut[] => {
    // The route as junctions: its streets are chains of pieces through bend nodes (roadGraph.ts), and
    // a corner cut reaches along a whole street, so the cuts are planned on the junction view (a
    // sprint keeps its ends) and every leg is the run of pieces between two junctions.
    const full = route.nodes;
    const fn = full.length;
    const keep: number[] = [];
    for (let i = 0; i < fn; i++) if (!isBendNode(g, full[i]) || (!route.closed && (i === 0 || i === fn - 1))) keep.push(i);
    const r: CarveRoute = { nodes: keep.map((i) => full[i]), closed: route.closed };
    /** The route pieces from junction k of the view to junction k + 1 (wrapping on a circuit). */
    const leg = (k: number): number[] => {
      const a = keep[k];
      const b = k + 1 < keep.length ? keep[k + 1] : keep[0] + fn;
      const out: number[] = [];
      for (let i = a; i < b; i++) out.push(edgeBetween(g, full[i % fn], full[(i + 1) % fn]));
      return out;
    };
    const legOk = (pieces: number[]) => pieces.length > 0 && pieces.every(edgeOk);
    const R = r.nodes;
    const n = R.length;
    const { cum } = nodeCum(g, r);
    const out: Cut[] = [];
    const idx = (i: number) => (i + n) % n;
    // Sprint corners need a road on both sides; U cuts need two more.
    const inner = (i: number) => r.closed || (i >= 1 && i <= n - 2);
    for (let i = 0; i < n; i++) {
      if (!inner(i)) continue;
      const turn = turnAt(g, r, i);
      const deg = Math.abs(turn) / RAD;
      if (deg < turnMin || deg > turnMax) continue;
      const P = R[idx(i - 1)];
      const C = R[i];
      const Q = R[idx(i + 1)];
      if (!cornerOk(C)) continue;
      const leg1 = leg(idx(i - 1));
      const leg2 = leg(i);
      if (!legOk(leg1) || !legOk(leg2)) continue;
      // The pieces at the corner (the cut's distances are measured from C along the whole leg).
      const e1 = leg1[leg1.length - 1];
      const e2 = leg2[0];
      const skip12 = [...leg1, ...leg2];
      const Cn = g.nodes[C];
      const uBack = unit(Cn, g.nodes[P]);
      const uOut = unit(Cn, g.nodes[Q]);
      if (!wedgeFree(g, C, [e1, e2], uBack, uOut)) continue;
      const E1 = g.edges[e1];
      const E2 = g.edges[e2];
      const clrP = endClear(r, idx(i - 1), turn);
      const clrQ = endClear(r, idx(i + 1), turn);
      const h1 = E1.width / 2 + E1.sidewalk;
      const h2 = E2.width / 2 + E2.sidewalk;
      const cornerC: Corner = { C: Cn, u1: uBack, h1, u2: uOut, h2 };
      // The mouths lie on the streets themselves (chains through bend nodes), snapped as carve() splits.
      const backChain = chainFrom(g, C, e1);
      const outChain = chainFrom(g, C, e2);

      // Corner cut across the inside block: the longest that fits.
      corner: for (const dA of cfg.cornerReach) {
        if (uBack.len - dA < clrP) continue;
        for (const dB of cfg.cornerReach) {
          if (Math.abs(dA - dB) > 10 || uOut.len - dB < clrQ) continue;
          const mA = mouthOn(backChain, dA);
          const mB = mouthOn(outChain, dB);
          if (backChain.length - mA.d < clrP || outChain.length - mB.d < clrQ) continue;
          const A = mA.p;
          const B = mB.p;
          const length = Math.hypot(B.x - A.x, B.z - A.z);
          const skip = mA.d + mB.d;
          if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
          const ab = unit(A, B);
          if (Math.min(mouthAngle(ab, mA.u), mouthAngle(ab, mB.u)) < 34 * RAD || !onward([A, B], back(mA.u), mB.u)) continue;
          if (!sprintGuard(A, B) || !cornerClear(cornerC, [A, B]) || !chordClear(A, B, skip12)) continue;
          const cut: Cut = { eA: e1, fromA: C, dA: mA.d, eB: e2, fromB: C, dB: mB.d, path: [A, B], length, skip, at: cum[i] - mA.d, score: cutScore(skip, length), uIn: back(mA.u), uOut: mB.u, minMouth: 34 * RAD, skipEdges: skip12, clear: cfg.clear, corners: [cornerC], away: awayFrom(A, B, Cn) };
          if (!mouthsClear(cut, cut.path)) continue;
          out.push(cut);
          break corner;
        }
      }
      // A jump exit off the outgoing street: the exit nearer the corner than a plain cut's (the landing
      // needs the street past it), the longest skip that fits first.
      if (jumps) {
        jump: for (const dB of cfg.cornerReach) {
          if (uOut.len - dB < clrQ) continue;
          const mB = mouthOn(outChain, dB);
          if (outChain.length - mB.d < clrQ) continue;
          const B = mB.p;
          const run = runPast(r, idx(i + 1), outChain.length - mB.d);
          for (const dA of cfg.cornerReach) {
            if (uBack.len - dA < clrP) continue;
            const mA = mouthOn(backChain, dA);
            if (backChain.length - mA.d < clrP) continue;
            const A = mA.p;
            const skip = mA.d + mB.d;
            const jp = jumpPath(A, B, back(mA.u), mB.u, h2, run, 34 * RAD);
            if (!jp) continue;
            const length = pathLength(jp.path);
            if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
            if (!sprintGuard(A, B) || !cornerClear(cornerC, jp.path) || !pathClear(jp.path, skip12)) continue;
            const cut: Cut = { eA: e1, fromA: C, dA: mA.d, eB: e2, fromB: C, dB: mB.d, path: jp.path, length, skip, at: cum[i] - mA.d, score: cutScore(skip, length), uIn: back(mA.u), uOut: mB.u, minMouth: 34 * RAD, skipEdges: skip12, clear: cfg.clear, corners: [cornerC], away: awayFrom(A, B, Cn), jump: jp.jump };
            if (!mouthsClear(cut, cut.path)) continue;
            out.push(cut);
            break jump;
          }
        }
      }

      // U cut: this corner and the next turn the same way around one block.
      if (!inner(idx(i + 1)) || (!r.closed && i + 2 > n - 1)) continue;
      const turn2 = turnAt(g, r, idx(i + 1));
      const deg2 = Math.abs(turn2) / RAD;
      if (deg2 < turnMin || deg2 > turnMax || Math.sign(turn2) !== Math.sign(turn)) continue;
      const Q2 = R[idx(i + 2)];
      if (!cornerOk(Q)) continue;
      const leg3 = leg(idx(i + 1));
      if (!legOk(leg3)) continue;
      const e3 = leg3[0];
      const skip13 = [...leg1, ...leg2, ...leg3];
      const Qn = g.nodes[Q];
      const uBack2 = unit(Qn, Cn);
      const uOut2 = unit(Qn, g.nodes[Q2]);
      if (!wedgeFree(g, Q, [e2, e3], uBack2, uOut2)) continue;
      const E3 = g.edges[e3];
      const L1 = uOut.len;
      if (L1 < 50 || L1 > 180) continue;
      const clrQ2 = endClear(r, idx(i + 2), turn);
      const h3 = E3.width / 2 + E3.sidewalk;
      const cornerQ: Corner = { C: Qn, u1: uBack2, h1: h2, u2: uOut2, h2: h3 };
      const outChain2 = chainFrom(g, Q, e3);
      for (const d of cfg.uReach) {
        if (uBack.len - d < clrP || uOut2.len - d < clrQ2) continue;
        const mA = mouthOn(backChain, d);
        const mB = mouthOn(outChain2, d);
        if (backChain.length - mA.d < clrP || outChain2.length - mB.d < clrQ2) continue;
        const A = mA.p;
        const B = mB.p;
        const length = Math.hypot(B.x - A.x, B.z - A.z);
        const skip = mA.d + L1 + mB.d;
        if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
        const ab = unit(A, B);
        if (Math.min(mouthAngle(ab, mA.u), mouthAngle(ab, mB.u)) < 55 * RAD || !onward([A, B], back(mA.u), mB.u)) continue;
        if (!cornerClear(cornerC, [A, B]) || !cornerClear(cornerQ, [A, B])) continue;
        if (!sprintGuard(A, B) || !chordClear(A, B, skip13)) continue;
        const cut: Cut = { eA: e1, fromA: C, dA: mA.d, eB: e3, fromB: Q, dB: mB.d, path: [A, B], length, skip, at: cum[i] - mA.d, score: cutScore(skip, length) - 4, uIn: back(mA.u), uOut: mB.u, minMouth: 55 * RAD, skipEdges: skip13, clear: cfg.clear, corners: [cornerC, cornerQ], away: awayFrom(A, B, Cn) };
        if (!mouthsClear(cut, cut.path)) continue;
        out.push(cut);
        break;
      }
      if (jumps) {
        jumpU: for (const dB of cfg.uReach) {
          if (uOut2.len - dB < clrQ2) continue;
          const mB = mouthOn(outChain2, dB);
          if (outChain2.length - mB.d < clrQ2) continue;
          const B = mB.p;
          const run = runPast(r, idx(i + 2), outChain2.length - mB.d);
          for (const dA of cfg.uReach) {
            if (uBack.len - dA < clrP) continue;
            const mA = mouthOn(backChain, dA);
            if (backChain.length - mA.d < clrP) continue;
            const A = mA.p;
            const skip = mA.d + L1 + mB.d;
            const jp = jumpPath(A, B, back(mA.u), mB.u, h3, run, 55 * RAD);
            if (!jp) continue;
            const length = pathLength(jp.path);
            if (length < cfg.minLength || length > skip * (1 - cfg.minSave)) continue;
            if (!cornerClear(cornerC, jp.path) || !cornerClear(cornerQ, jp.path)) continue;
            if (!sprintGuard(A, B) || !pathClear(jp.path, skip13)) continue;
            const cut: Cut = { eA: e1, fromA: C, dA: mA.d, eB: e3, fromB: Q, dB: mB.d, path: jp.path, length, skip, at: cum[i] - mA.d, score: cutScore(skip, length) - 4, uIn: back(mA.u), uOut: mB.u, minMouth: 55 * RAD, skipEdges: skip13, clear: cfg.clear, corners: [cornerC, cornerQ], away: awayFrom(A, B, Cn), jump: jp.jump };
            if (!mouthsClear(cut, cut.path)) continue;
            out.push(cut);
            break jumpU;
          }
        }
      }
    }
    return out;
  };

  /**
   * Fallback for routes with no corner or U cut (corners on bridges or on the
   * subway's streets): a straight chord between any two splittable route
   * edges up to four apart, sampled every CHORD_STEP m, through one block.
   */
  const chordCuts = (route: CarveRoute): Cut[] => {
    // On the junction view, as candidates() plans: a leg is the run of pieces between two junctions
    // (through bend nodes), its spots on the street itself.
    const full = route.nodes;
    const fn = full.length;
    const keep: number[] = [];
    for (let i = 0; i < fn; i++) if (!isBendNode(g, full[i]) || (!route.closed && (i === 0 || i === fn - 1))) keep.push(i);
    const r: CarveRoute = { nodes: keep.map((i) => full[i]), closed: route.closed };
    const R = r.nodes;
    const n = R.length;
    const { cum, total } = nodeCum(g, r);
    const m = r.closed ? n : n - 1;
    const spots: { k: number; d: number; p: Vec2; u: { x: number; z: number; len: number }; e: number; leg: number[] }[] = [];
    for (let k = 0; k < m; k++) {
      const a0 = keep[k];
      const b0 = k + 1 < keep.length ? keep[k + 1] : keep[0] + fn;
      const pieces: number[] = [];
      for (let i = a0; i < b0; i++) pieces.push(edgeBetween(g, full[i % fn], full[(i + 1) % fn]));
      if (!pieces.length || !pieces.every(edgeOk)) continue;
      const ch = chainFrom(g, R[k], pieces[0]);
      for (let d = cfg.nodeClear; d <= ch.length - cfg.nodeClear; d += CHORD_STEP) {
        const mo = mouthOn(ch, d);
        spots.push({ k, d: mo.d, p: mo.p, u: { x: mo.u.x, z: mo.u.z, len: ch.length }, e: pieces[0], leg: pieces });
      }
    }
    const out: Cut[] = [];
    // A mouth on the outside of a turning junction's corner rail keeps railClear from it.
    const clearOk = (k: number, d: number, len: number, side: number) => {
      const t0 = turnAt(g, r, k);
      const t1 = turnAt(g, r, (k + 1) % n);
      const need0 = g.nodes[R[k]].ring ? g.nodes[R[k]].ring!.outer + cfg.railClear * 0.6 : Math.abs(t0) >= ROUTE_RAIL_MIN_TURN && Math.sign(t0) === -side ? cfg.railClear : cfg.nodeClear;
      const need1 = g.nodes[R[(k + 1) % n]].ring ? g.nodes[R[(k + 1) % n]].ring!.outer + cfg.railClear * 0.6 : Math.abs(t1) >= ROUTE_RAIL_MIN_TURN && Math.sign(t1) === -side ? cfg.railClear : cfg.nodeClear;
      return d >= need0 && len - d >= need1;
    };
    for (const a of spots) {
      for (const b of spots) {
        let gap = b.k - a.k;
        if (r.closed) gap = (gap + n) % n;
        if (gap < 1 || gap > 4) continue;
        let skip = cum[b.k] + b.d - (cum[a.k] + a.d);
        if (r.closed && skip < 0) skip += total;
        if (skip <= 0 || skip > cfg.maxSkip * total) continue;
        const ab = unit(a.p, b.p);
        if (ab.len < cfg.minLength || ab.len > skip * (1 - cfg.minSave)) continue;
        if (Math.min(mouthAngle(ab, a.u), mouthAngle(ab, b.u)) < 34 * RAD || !onward([a.p, b.p], a.u, b.u)) continue;
        // Side of each mouth seen along the route (+1 left).
        const sideA = Math.sign(a.u.x * ab.z - a.u.z * ab.x);
        const sideB = Math.sign(b.u.x * -ab.z - b.u.z * -ab.x);
        if (!clearOk(a.k, a.d, a.u.len, sideA) || !clearOk(b.k, b.d, b.u.len, sideB)) continue;
        if (!sprintGuard(a.p, b.p)) continue;
        const corners: Corner[] = [];
        if (gap === 1) {
          const C = g.nodes[R[(a.k + 1) % n]];
          const E1 = g.edges[a.e];
          const E2 = g.edges[b.e];
          corners.push({ C, u1: { x: -a.u.x, z: -a.u.z }, h1: E1.width / 2 + E1.sidewalk, u2: b.u, h2: E2.width / 2 + E2.sidewalk });
          if (!cornerClear(corners[0], [a.p, b.p])) continue;
        }
        // Tight cities (diagonals, the river) leave narrow blocks: a fallback chord may pass closer.
        if (!chordClear(a.p, b.p, [...a.leg, ...b.leg], CHORD_CLEAR)) continue;
        // Bends away from the corner it cuts, or from the route node ahead of its entry.
        const far = corners.length ? corners[0].C : g.nodes[R[(a.k + 1) % n]];
        const cut: Cut = { eA: a.e, fromA: R[a.k], dA: a.d, eB: b.e, fromB: R[b.k], dB: b.d, path: [a.p, b.p], length: ab.len, skip, at: cum[a.k] + a.d, score: cutScore(skip, ab.len), uIn: a.u, uOut: b.u, minMouth: 34 * RAD, skipEdges: [...a.leg, ...b.leg], clear: CHORD_CLEAR, corners, away: awayFrom(a.p, b.p, far) };
        if (!mouthsClear(cut, cut.path)) continue;
        out.push(cut);
      }
    }
    return out;
  };

  /**
   * Bend a plain cut's path through its block (in place): a dogleg (one bend)
   * on short cuts, an arc (two) where three legs fit, bent away from the
   * corners it cuts, the first bend that fits in a seeded order and the
   * straight chord where none does. The bent path is checked like the chord (streets, areas,
   * corners, mouths) and must still save minSave of what it skips.
   */
  const bend = (cut: Cut, rng: Rng): void => {
    const [A, B] = cut.path;
    const ab = unit(A, B);
    // Which bend and shape to try first is the seed's call, so cuts do not all bend alike.
    const shapes: (1 | 2)[] = ab.len >= 3 * BEND.minLeg + 12 ? rng.shuffle([2, 1]) : [1];
    const degs = rng.shuffle(BEND.tryDeg.slice());
    const sides = cut.corners.length ? [cut.away] : [cut.away, { x: -cut.away.x, z: -cut.away.z }];
    for (const deg of degs) {
      for (const nodes of shapes) {
        for (const away of sides) {
          // Dogleg: the node at the chord's middle, each leg turning half the bend; arc: nodes at the thirds, the middle leg parallel.
          const t = Math.tan((deg * RAD) / (nodes === 1 ? 2 : 1));
          const o = (ab.len / (nodes === 1 ? 2 : 3)) * t;
          const at = (f: number): Vec2 => ({ x: A.x + ab.x * ab.len * f + away.x * o, z: A.z + ab.z * ab.len * f + away.z * o });
          const path = nodes === 1 ? [A, at(0.5), B] : [A, at(1 / 3), at(2 / 3), B];
          const length = pathLength(path);
          if (length > cut.skip * (1 - cfg.minSave)) continue;
          if (!pathOk(path, cut.uIn, cut.minMouth, cut.uOut, cut.minMouth)) continue;
          if (!cut.corners.every((c) => cornerClear(c, path)) || !pathClear(path, cut.skipEdges, cut.clear) || !mouthsClear(cut, path)) continue;
          cut.path = path;
          cut.length = length;
          return;
        }
      }
    }
  };

  return {
    candidates,
    chordCuts,
    bend,
    allowProtected(v: boolean) {
      allowProtected = v;
    },
  };
}

/**
 * Split the two route edges, join the split points with the shortcut's chain
 * (free bend nodes at the path's interior points, every edge 'backAlley'
 * flagged shortcut) and register its area.
 */
function carve(ctx: PlanContext, routes: CarveRoute[], cut: Cut, rng: Rng): void {
  const cfg = CITY.districts.backAlley.route;
  const bcfg = CITY.districts.backAlley;
  const g = ctx.graph;
  // `d` m from `from` along the street that starts with piece eid: on through its bend nodes
  // (roadGraph.ts), onto a bend node within MOUTH_SNAP (it becomes the mouth's junction).
  const split = (eid: number, from: number, d: number): number => {
    const chain = chainFrom(g, from, eid);
    let rest = d;
    for (let k = 0; k < chain.edges.length; k++) {
      const id = chain.edges[k];
      const len = g.edges[id].length;
      if (k > 0 && Math.abs(rest) <= MOUTH_SNAP) return chain.nodes[k];
      if (rest < len - MOUTH_SNAP || k === chain.edges.length - 1 || !isBendNode(g, chain.nodes[k + 1])) {
        const e = g.edges[id];
        const u = e.a;
        const v = e.b;
        const t = Math.max(0.02, Math.min(0.98, rest / len));
        const m = splitEdge(g, id, u === chain.nodes[k] ? t : 1 - t);
        insertSplit(routes, u, v, m);
        return m;
      }
      rest -= len;
    }
    return chain.nodes[chain.nodes.length - 1];
  };
  const na = split(cut.eA, cut.fromA, cut.dA);
  const nb = split(cut.eB, cut.fromB, cut.dB);
  const ids = [na];
  for (let i = 1; i + 1 < cut.path.length; i++) ids.push(addNode(g, cut.path[i].x, cut.path[i].z));
  ids.push(nb);
  const edges: number[] = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const id = addEdge(g, ids[i], ids[i + 1], 'backAlley');
    g.edges[id].shortcut = true;
    g.edges[id].width = cfg.width;
    if (cut.jump && i + 2 === ids.length) g.edges[id].jumpExit = true;
    edges.push(id);
  }
  ctx.graphChanged();
  const path = ids.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
  const cum = pathCum(path);
  const length = cum[cum.length - 1];
  // A kicker hump on the longest leg with room for it, clear of both (flared) mouths and of the bends;
  // never on a jump exit's run-up.
  const half = bcfg.jumpRamp + bcfg.jumpTop / 2;
  const end = half + 15 + bcfg.mouth.alley;
  const legs = path.length - 1;
  let legI = -1;
  let room = 0;
  for (let i = 0; i < legs; i++) {
    if (cut.jump && i === legs - 1) continue;
    const r = cum[i + 1] - cum[i] - (i === 0 ? end : half + 6) - (i === legs - 1 ? end : half + 6);
    if (r > room) {
      room = r;
      legI = i;
    }
  }
  const jump = legI >= 0 && rng.chance(cfg.jumpChance) ? 1 : 0;
  const jumpS = legI >= 0 ? cum[legI] + (legI === 0 ? end : half + 6) + room * rng.pick([0.5, 0.42, 0.58]) : 0;
  const params: Record<string, number> = { length, jump, jumpS, seed: rng.int(1, 0x7ffffffe), width: cfg.width };
  if (cut.jump) {
    params.jumpExit = 1;
    params.lipS = cut.jump.lipS;
    params.landMax = cut.jump.landMax;
    params.zone = cut.jump.zone;
  }
  ctx.addArea(
    {
      kind: 'backAlley',
      variant: 'routeShortcut',
      polygon: corridor(path, cfg.width / 2 + CITY.sidewalkWidth.backAlley),
      path,
      nodes: ids,
      edges,
      faces: [],
      params,
    },
    length * (cfg.width + 2 * CITY.sidewalkWidth.backAlley),
  );
}
