/**
 * Night market: a straight run of route street closed to traffic for race
 * night and turned into a market, lantern lit stalls along both curbs and a
 * crowd packed behind a rail.
 *
 * Planned on the routes: a market off the route is scenery nobody races
 * through. The module is registered right after back alleys, so it plans
 * just after the topology hook (world.ts planRoads) has picked both routes
 * and carved their shortcuts, and reads them from PlanContext.event. It takes
 * a straight chain of 1-3 street edges a route drives: one both routes drive
 * when there is one, else a second market for the route the first one
 * misses. It keeps clear of the grid, the start / finish gantries and their
 * crowds, roundabouts, bridges, the El, every alley or shortcut mouth, and on
 * a Grand Tour the block the monument is coming to (events.ts).
 *
 * The street's corridor stays as it was (building lines unchanged), but its
 * carriageway narrows to CFG.width and the sidewalks widen into the market
 * floor; the route's segWidth, so the racing line and the AI, follow. Across
 * the street, from the middle out:
 *  - a clear lane, |lateral| < CFG.clearHalf, that nothing of the market
 *    reaches into: a car on the AI's line never touches a thing;
 *  - fruit crates spilling off the curb onto the road edge;
 *  - stalls (awning, a table of goods, paper lanterns) and food carts along
 *    the curb, on the sidewalk, in rows with aisles between;
 *  - a crowd rail (look 'marketRail') CFG.railSetback behind the curb, with
 *    end caps back to the building line: a closed pen the crowd stands in,
 *    unreachable by car (render/districts/market.ts plans the people,
 *    render/crowds.ts draws them). The frontage behind a pen takes look
 *    'marketFront': a front look wins over a void, so the late infill never
 *    opens a lot or plaza behind a pen (nothing drivable reaches the crowd
 *    from behind), and the renderer draws a shuttered market wall wherever no
 *    building stands there.
 * Every stall, crate and cart is a soft destructible (city/props.ts): it
 * bursts apart and costs a car a few percent of its speed, so smashing down a
 * row of stalls is a choice, never forced. Street furniture (streetlights,
 * benches, cans, bus stops) keeps off the market floor (reserved circles); the
 * lanterns light it instead.
 */
import { CITY, ROUTE } from '../config';
import type { RoadGraph } from '../roadGraph';
import { chainOf, edgeBetween, isBendNode } from '../roadGraph';
import { circuitStart } from '../route';
import { DEG, Vec2, abs, atan2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { PropKind } from '../props';
import { PROP_DEFS } from '../props';
import type { DistrictModule, PlanContext } from './types';
import { emptyBuild } from './types';
import { corridor } from './alley';
import type { CarveRoute } from './alley';
import { TOUR_REACH, monumentSites } from './monument';

const CFG = CITY.districts.market;

/**
 * Render hints (AreaHint.kind) a market build leaves for render/districts/market.ts:
 * pen: points [rail start, rail end, frontage end, frontage start], values [edge, side (+1 left
 *   of the edge's a to b), road normal x, z];
 * edge: points [a, b] (the edge's nodes), values [edge, curb, rail, frontage (lateral m), stalls
 *   from, to (m along a to b, both sides), pens from, to (where both sides have one; to <= from: none),
 *   then stalls from, to on the left and on the right (to <= from: none on that side)].
 */
export const MARKET_HINT = { pen: 'marketPen', edge: 'marketEdge' } as const;

/** Spacing (m) and radius (m) of the reserved circles that keep street furniture off the market floor. */
const RESERVE_STEP = 3.5;
const RESERVE_R = 2.3;
/** Reserved circles stand this far behind the curb (m): over the streetlight, can and bench lines. */
const RESERVE_LAT = 1.6;
/** Rails and caps of a pen, and the frontage strip whose look the pen takes over, reach this far (m). */
const FRONT_MARGIN = 1;

/** A route as the market planner sees it: its edges in driving order, their positions and the edges it keeps for itself. */
interface RouteView {
  /** Edge from nodes[i] to nodes[i + 1] (wrapping for a circuit). */
  edges: number[];
  onRoute: Set<number>;
  /** Edges a market may not take: a circuit's start edge and its neighbours, a sprint's first and last stretches. */
  banned: Set<number>;
}

interface Chain {
  /** Nodes in driving order of the route that found it, and the edges between them. */
  nodes: number[];
  edges: number[];
  length: number;
  /** Bit ri set when route ri drives at least one of the edges. */
  mask: number;
  score: number;
}

function routeView(g: RoadGraph, r: CarveRoute): RouteView {
  const n = r.nodes.length;
  const m = r.closed ? n : n - 1;
  const edges: number[] = [];
  const cum = [0];
  for (let i = 0; i < m; i++) {
    edges.push(edgeBetween(g, r.nodes[i], r.nodes[(i + 1) % n]));
    cum.push(cum[i] + g.edges[edges[i]].length);
  }
  const banned = new Set<number>();
  if (r.closed) {
    // buildRoute puts the start line in the middle of the longest street (route.ts circuitStart: a run
    // of pieces through bend nodes); that run and the edges either side of it are out.
    const start = circuitStart(g, r.nodes);
    for (let k = -1; k <= start.run.edges.length; k++) banned.add(edges[(start.run.from + k + m) % m]);
  } else {
    // The finish line as buildRoute places it (on the node polyline, close enough with the margins).
    const total = cum[m];
    let finish = total - ROUTE.sprintFinishOffset;
    for (let i = n - 2; i > 0; i--) if (abs(finish - cum[i]) < ROUTE.sprintFinishNodeClear) finish = cum[i] - ROUTE.sprintFinishNodeClear;
    for (let i = 0; i < m; i++) if (cum[i] < ROUTE.sprintStartOffset + CFG.startClear || cum[i + 1] > finish - CFG.finishClear) banned.add(edges[i]);
  }
  return { edges, onRoute: new Set(edges), banned };
}

/**
 * The block a Grand Tour's monument is coming to (monument.ts picks the block
 * nearest the center on the most routes, among the sites that can hold it):
 * its streets stay unclaimed, or the market would push the landmark off the
 * route and the event would fall back to Downtown Dash.
 */
function tourBlockEdges(ctx: PlanContext): Set<number> {
  const out = new Set<number>();
  if (ctx.event?.flavour !== 'grandTour') return out;
  const tour = ctx.event.routes.map((r) => new Set(r.edges));
  const sites = monumentSites(ctx, TOUR_REACH);
  const on = (edges: number[]) => tour.filter((r) => edges.some((e) => r.has(e))).length;
  const best = sites.map((p) => ({ f: p.f, n: on(p.f.edges) })).sort((p, q) => q.n - p.n)[0];
  if (best && best.n > 0) for (const e of best.f.edges) out.add(e);
  return out;
}

/**
 * Put the city's night markets on its routes (marketModule.plan, from the
 * routes in PlanContext.event). Narrows the chosen edges' carriageways
 * (widths only, no topology change) and adds one 'market' area per market.
 */
export function planMarkets(ctx: PlanContext, routes: readonly CarveRoute[]): void {
  if (!CFG.enabled || !routes.length) return;
  const g = ctx.graph;
  const rng = ctx.rng;
  if (!rng.chance(CFG.chance)) return;
  const views = routes.map((r) => routeView(g, r));
  const tourBlock = tourBlockEdges(ctx);
  const edgeOk = (eid: number) => {
    const e = g.edges[eid];
    // A street is a chain of pieces through bend nodes (roadGraph.ts): its whole length qualifies it.
    return e.kind === 'street' && !e.bridge && !e.shortcut && !ctx.claims.edge.has(eid) && !tourBlock.has(eid) && chainOf(g, eid).length >= CFG.minEdge;
  };
  // No roundabout, and no node another area claimed (alley and shortcut mouths, the El's column).
  const nodeOk = (nid: number) => !g.nodes[nid].ring && !ctx.claims.node.has(nid);
  const bend = (a: number, b: number, c: number) => {
    const A = g.nodes[a];
    const B = g.nodes[b];
    const C = g.nodes[c];
    const d1x = B.x - A.x;
    const d1z = B.z - A.z;
    const d2x = C.x - B.x;
    const d2z = C.z - B.z;
    return abs(atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z));
  };

  // Every straight run of good streets along either route, junction to junction (a street's pieces
  // through its bend nodes count as one, CFG.chain counts streets), each edge set once.
  const chains: Chain[] = [];
  const seen = new Set<string>();
  routes.forEach((r, ri) => {
    const v = views[ri];
    const n = r.nodes.length;
    const m = v.edges.length;
    for (let i = 0; i < m; i++) {
      const nodes = [r.nodes[i]];
      const edges: number[] = [];
      let length = 0;
      let streets = 0;
      if (!nodeOk(nodes[0]) || isBendNode(g, nodes[0])) continue;
      for (let k = 0; streets < CFG.chain[1] && k < m; k++) {
        const idx = i + k;
        if (!r.closed && idx >= m) break;
        const eid = v.edges[idx % m];
        const next = r.nodes[(idx + 1) % n];
        if (!edgeOk(eid) || v.banned.has(eid) || !nodeOk(next)) break;
        if (k > 0 && bend(nodes[nodes.length - 2], nodes[nodes.length - 1], next) > CFG.maxBendDeg * DEG) break;
        nodes.push(next);
        edges.push(eid);
        length += g.edges[eid].length;
        if (length > CFG.maxLength) break;
        if (isBendNode(g, next)) continue;
        streets++;
        if (streets < CFG.chain[0] || length < CFG.minLength) continue;
        const key = edges.slice().sort((a, b) => a - b).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        chains.push({ nodes: nodes.slice(), edges: edges.slice(), length, mask: 0, score: 0 });
      }
    }
  });
  // Which routes drive each run; a run another route needs for its grid or gantries is out.
  const valid: Chain[] = [];
  for (const c of chains) {
    let ok = true;
    views.forEach((v, ri) => {
      if (!c.edges.some((e) => v.onRoute.has(e))) return;
      c.mask |= 1 << ri;
      if (c.edges.some((e) => v.banned.has(e))) ok = false;
    });
    // Runs both routes drive first, then longer ones (to a point), jittered so seeds differ.
    let routesOn = 0;
    for (let m = c.mask; m; m &= m - 1) routesOn++;
    c.score = routesOn * 1000 + Math.min(c.length, 260) + rng.range(0, 80);
    if (ok) valid.push(c);
  }

  const want = CFG.max;
  const all = (1 << routes.length) - 1;
  const used = new Set<number>();
  let covered = 0;
  let made = 0;
  while (made < want && covered !== all) {
    let best: Chain | null = null;
    for (const c of valid) {
      // A second market only for a route the first one misses, never touching it.
      if (made && !(c.mask & ~covered)) continue;
      if (c.nodes.some((id) => used.has(id))) continue;
      if (!best || c.score > best.score) best = c;
    }
    if (!best) break;
    const first = g.edges[best.edges[0]];
    const half = first.width / 2 + first.sidewalk;
    // A market is street space dressed for the night: it claims no block, so it takes nothing from
    // the special area budget the parks, hills and monument share (planned after it).
    for (const eid of best.edges) {
      const e = g.edges[eid];
      const corridorHalf = e.width / 2 + e.sidewalk;
      e.width = CFG.width;
      e.sidewalk = corridorHalf - CFG.width / 2;
    }
    const path = best.nodes.map((id) => ({ x: g.nodes[id].x, z: g.nodes[id].z }));
    ctx.addArea(
      { kind: 'market', variant: 'street', polygon: corridor(path, half), path, nodes: best.nodes.slice(1, -1), edges: best.edges, faces: [], params: { length: best.length, routes: best.mask, seed: rng.int(1, 0x7ffffffe) } },
      0,
    );
    for (const id of best.nodes) used.add(id);
    covered |= best.mask;
    made++;
  }
  // Widths only: the junction corners (sectors) follow the narrower carriageway.
  if (made) ctx.graphChanged();
}

/**
 * How far (m) into a market edge the other streets at node nid reach on one
 * side (+1 left of the edge's direction t leaving nid): their road and
 * sidewalk plus a margin, deeper on a skew junction's acute corner. A street
 * leaving ahead of the node (along t) is the alley module's rule (alley.ts
 * mouthReach); one leaving behind it (an obtuse angle, or the route carrying
 * on nearly straight onto a street that is not the market) recedes from the
 * market: its corridor reaches no further along this side's building line
 * than hw * tan(angle) from the node, nor than its half width over the sine.
 */
function mouthReach(g: RoadGraph, nid: number, own: readonly number[], tx: number, tz: number, hw: number, side: number): number {
  let depth = 12;
  const n = g.nodes[nid];
  for (const eid of n.edges) {
    if (own.includes(eid)) continue;
    const e = g.edges[eid];
    const o = g.nodes[e.a === nid ? e.b : e.a];
    const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
    const dx = (o.x - n.x) / l;
    const dz = (o.z - n.z) / l;
    const sin = abs(dx * tz - dz * tx);
    const sinA = Math.max(0.35, sin);
    const dot = dx * tx + dz * tz;
    const cosA = abs(dot);
    const W = e.width / 2 + e.sidewalk;
    if (dot < 0) {
      depth = Math.max(depth, Math.min((hw * sin) / Math.max(cosA, 1e-3), W / sinA) + 3.5);
      continue;
    }
    // Left of travel (tx, tz) is (-tz, tx): a side toward the street's direction sits closer to it.
    const toward = side * (-tz * dx + tx * dz) > 0 ? 1 : -1;
    depth = Math.max(depth, (W + 2.5 + toward * hw * cosA) / sinA + 1);
  }
  return depth;
}

export const marketModule: DistrictModule = {
  kind: 'market',
  phase: 'graph',
  // Right after the topology hook: the routes are picked and their shortcuts carved.
  plan(ctx) {
    if (ctx.event) planMarkets(ctx, ctx.event.routes);
  },
  build(ctx, area) {
    const b = emptyBuild();
    const g = ctx.graph;
    const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
    const crateR = PROP_DEFS.fruitCrates.radius;
    for (const eid of area.edges) {
      const e = g.edges[eid];
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z) || 1;
      const ux = (B.x - A.x) / len;
      const uz = (B.z - A.z) / len;
      // Left of travel a to b; lateral offsets are + to the left.
      const nx = -uz;
      const nz = ux;
      const curb = e.width / 2;
      const outer = curb + e.sidewalk;
      const rail = curb + CFG.railSetback;
      const at = (s: number, lat: number): Vec2 => ({ x: A.x + ux * s + nx * lat, z: A.z + uz * s + nz * lat });
      let lo = Infinity;
      let hi = -Infinity;
      let penLo = -Infinity;
      let penHi = Infinity;
      const sides: number[] = [];
      // Where the building lines start at each end (the junction's corners), as a closure measures it.
      const m = ctx.mouths[eid];
      const wallA = Math.max((m.aP.outer.x - A.x) * ux + (m.aP.outer.z - A.z) * uz, (m.aN.outer.x - A.x) * ux + (m.aN.outer.z - A.z) * uz);
      const wallB = Math.max((B.x - m.bP.outer.x) * ux + (B.z - m.bP.outer.z) * uz, (B.x - m.bN.outer.x) * ux + (B.z - m.bN.outer.z) * uz);
      // A bend node between two of the market's pieces is no junction: stalls and pens run through it.
      const bendA = isBendNode(g, e.a);
      const bendB = isBendNode(g, e.b);
      for (const side of [1, -1]) {
        const reachA = bendA ? 0 : mouthReach(g, e.a, area.edges, ux, uz, outer, side);
        // Seen from b the edge runs backwards, so its left is our right.
        const reachB = bendB ? 0 : mouthReach(g, e.b, area.edges, -ux, -uz, outer, -side);
        const s0 = bendA ? 0 : reachA + CFG.stallClear;
        const s1 = len - (bendB ? 0 : reachB + CFG.stallClear);
        const p0 = bendA ? 0 : Math.max(reachA + CFG.penClear, wallA + CFG.closureClear);
        const p1 = len - (bendB ? 0 : Math.max(reachB + CFG.penClear, wallB + CFG.closureClear));
        if (p1 - p0 >= CFG.penMin) {
          penLo = Math.max(penLo, p0);
          penHi = Math.min(penHi, p1);
        } else penHi = -Infinity;
        if (s1 - s0 < CFG.stallPitch[1]) {
          sides.push(0, 0);
          continue;
        }
        sides.push(s0, s1);
        lo = Math.min(lo, s0);
        hi = Math.max(hi, s1);
        // Facing the road: local +Z toward the middle of the street.
        const face = atan2(-side * nx, -side * nz);
        const push = (kind: PropKind, s: number, lat: number, lift: number, jitter: number) => {
          const p = at(s, lat);
          b.destructibles.push({ kind, x: p.x, z: p.z, yaw: face + rng.range(-jitter, jitter), lift, area: area.id });
        };
        // Rows of stalls (a food cart here and there) along the curb, an aisle between rows.
        let s = s0 + rng.range(0, 1.2);
        let run = 0;
        let rowLen = rng.int(CFG.row[0], CFG.row[1]);
        for (;;) {
          const pitch = rng.range(CFG.stallPitch[0], CFG.stallPitch[1]);
          if (s + pitch > s1) break;
          if (run >= rowLen) {
            const w = rng.range(CFG.aisle[0], CFG.aisle[1]);
            // Crates stacked at the curb end of the aisle.
            if (rng.chance(0.5)) push('fruitCrates', s + w / 2, side * (curb + rng.range(0.7, 1.3)), CITY.curbHeight, 0.5);
            s += w;
            run = 0;
            rowLen = rng.int(CFG.row[0], CFG.row[1]);
            continue;
          }
          const mid = s + pitch / 2;
          if (rng.chance(CFG.cartChance)) push('foodCart', mid, side * (curb + CFG.cartSetback + rng.range(-0.08, 0.08)), CITY.curbHeight, 0.1);
          else {
            push('marketStall', mid, side * (curb + CFG.stallSetback + rng.range(-0.08, 0.08)), CITY.curbHeight, 0.04);
            // Fruit crates spilling off the curb onto the road edge, never into the clear lane.
            if (rng.chance(CFG.spillChance)) push('fruitCrates', mid + rng.range(-0.7, 0.7), side * (CFG.clearHalf + crateR + rng.range(0.02, 0.3)), 0, 0.5);
          }
          s += pitch;
          run++;
        }
        // No streetlights, cans, benches or bus stops on the market floor.
        for (let t = s0 - 3; t <= s1 + 3; t += RESERVE_STEP) {
          const p = at(t, side * (curb + RESERVE_LAT));
          b.reserved.push({ x: p.x, z: p.z, r: RESERVE_R });
        }
        if (p1 - p0 < CFG.penMin) continue;
        // The pen: rail along the sidewalk, caps back to the building line, the frontage behind taken over.
        const r0 = at(p0, side * rail);
        const r1 = at(p1, side * rail);
        const o0 = at(p0, side * outer);
        const o1 = at(p1, side * outer);
        const rnx = -side * nx;
        const rnz = -side * nz;
        const wall = (a: Vec2, c: Vec2, wx: number, wz: number) => b.walls.push({ ax: a.x, az: a.z, bx: c.x, bz: c.z, nx: wx, nz: wz, kind: 'wall', look: 'marketRail', area: area.id });
        wall(r0, r1, rnx, rnz);
        // (At a bend node the next piece's pen starts with a cap of its own beside this one: both
        // stand on the sidewalk behind the rail, where no car goes.)
        wall(r0, o0, -ux, -uz);
        wall(r1, o1, ux, uz);
        b.frontLooks.push({
          polygon: [at(p0 - FRONT_MARGIN, side * (outer + 0.1)), at(p1 + FRONT_MARGIN, side * (outer + 0.1)), at(p1 + FRONT_MARGIN, side * (outer + 1.2)), at(p0 - FRONT_MARGIN, side * (outer + 1.2))],
          look: 'marketFront',
          area: area.id,
        });
        b.hints.push({ kind: MARKET_HINT.pen, points: [r0, r1, o1, o0], values: [eid, side, rnx, rnz] });
      }
      if (lo > hi) {
        lo = 0;
        hi = 0;
      }
      if (!(penHi > penLo)) {
        penLo = 0;
        penHi = 0;
      }
      b.hints.push({ kind: MARKET_HINT.edge, points: [{ x: A.x, z: A.z }, { x: B.x, z: B.z }], values: [eid, curb, rail, outer, lo, hi, penLo, penHi, ...sides] });
    }
    return b;
  },
};
