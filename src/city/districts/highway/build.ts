/**
 * The elevated highway's builds (highway.ts dispatches by variant): what the
 * sim stands on and runs into.
 *  - The deck: its two level spans (a chunk every few curve samples, widened
 *    onto a ramp's merge; DeckSpan `upper`), parapets along both edges (open
 *    over a merge), the median (open at its crossovers) and the closures at
 *    both ends, all walls only cars up on the deck meet (Wall.bottom, set once
 *    settled); its columns: a bent on the sidewalks of every street under it
 *    (the rows, the swings' diagonals), an extra one under a merge, walls only
 *    cars below meet (Wall.under); no buildings near a swing's turns, where
 *    the deck cuts the junction's corner on its arc.
 *  - A ramp: one solid level up its embankment, two levels over its bridge
 *    stretch (from where it leaves its block, over the cross street onto the
 *    deck), walls both sides (only the bridge stretch's let cars below pass),
 *    the merge's outer wall and taper, columns under the bridge stretch off
 *    the streets, the frontage under its top as one Wall.under wall, the curb
 *    cut at its mouth, no buildings on its way or beside its merge.
 * The heights the walls need are filled in by settle.ts (pending, rampPending).
 */
import { CITY, ROUTE } from '../../config';
import type { Wall } from '../../blocks';
import { MOUTH_REACH, bayHi, bayInset, bayLo, bayPoint, mouthBay } from '../../busBays';
import { Vec2, distToSegment, sqrt, yawOf } from '../../../sim/math';
import type { Area, AreaBuild, BuildContext, DeckSpan, HeightSample } from '../types';
import { emptyBuild } from '../types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, solidWalls } from '../geom';
import { riverCenter } from '../river';
import { gridNode, streetChain } from '../subway';
import { RAIL, projectOnCurve } from '../../railCurve';
import { axisAt, axisPoint, projectAxis, rampHeight } from './rampAxis';
import { BARRIER_IN, CLOSURE_GAP, GORE, HALF, HighwayDeck, MOUTH_TAPER, barrierOpen, deckExtent, deckPoint, highwayDeck, highwayRamp, medianGaps, mergeRange, mouthCut, rampFront, rampInnerSign, rampOuterAt, rampOutline } from './shape';
import { alongChain, chainOfNodes } from './line';

const CFG = CITY.districts.highway;

/** Columns keep this far from intersections at least (m). */
const NODE_CLEAR = 18;

/** Columns keep this far beyond other streets' sidewalks (m). */
const SIDEWALK_GAP = 0.6;

/** Deck chunks (spans) are this many curve samples long (RAIL.step m each). */
const CHUNK = 3;

/** Walls whose heights the settle step fills: [wall, s along the deck, 'bottom' (barrier) or 'under' (column)]. */
interface Pending {
  walls: Wall[];
  s: number;
  kind: 'bottom' | 'under';
}

export const pending = new WeakMap<AreaBuild, Pending[]>();

/** Ramp walls whose heights settle fills: [walls, u along the ramp (or s along the deck for the merge's)]. */
export const rampPending = new WeakMap<AreaBuild, { walls: Wall[]; u: number; s: number; kind: 'side' | 'merge' | 'front' | 'column' }[]>();

export function buildDeck(ctx: BuildContext, area: Area): AreaBuild {
  const b = emptyBuild();
  const g = ctx.graph;
  const W = CITY.gridW;
  const deck = highwayDeck(area, ctx.areas);
  const curve = deck.curve;
  const todo: Pending[] = [];
  pending.set(b, todo);
  const rows = Array.from({ length: W }, (_, i) => area.params[`row${i}`]);
  // The El's deck, for the columns to keep off (its pillars and stairs stand under it).
  const el: Vec2[] = [];
  for (const a of ctx.areas) {
    if (a.kind !== 'subway') continue;
    for (let i = 0; i + 1 < a.path.length; i++) {
      const p = a.path[i];
      const q = a.path[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 3));
      for (let k = 0; k < n; k++) el.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
    }
  }
  const elReach = CITY.districts.subway.deckWidth / 2 + 2.5;
  const rivers = ctx.areas.filter((a) => a.kind === 'river');
  const inChannel = (x: number, z: number) => rivers.some((rv) => Math.abs(z - riverCenter(rv.params, x)) < rv.params.top + CITY.districts.river.bridgeBody + 2);
  const rampPolys = deck.ramps.map((r) => r.area.polygon);
  const clearOf = g.nodes.map((n) => {
    if (n.gi < 0 && n.edges.length <= 2 && !n.ring) return 0;
    let m = 0;
    for (const eid of n.edges) m = Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk);
    let c = Math.max(NODE_CLEAR, m + Math.max(ROUTE.barrierSetbackHeadOn + CLOSURE_GAP, ROUTE.railReach + 3));
    if (n.ring) c = Math.max(c, n.ring.outer + CITY.sidewalk + 2);
    return c;
  });
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
  const hits: number[] = [];
  /** A column of radius r may stand here: off every road and the channel, clear of junctions and the El, inside one street's corridor at most, off the ramps (by `rampGap` m). */
  const columnOk = (x: number, z: number, r: number, rampGap = r + 0.8) => {
    if (inChannel(x, z)) return false;
    for (const n of g.nodes) if (clearOf[n.id] > 0 && (n.x - x) ** 2 + (n.z - z) ** 2 < clearOf[n.id] ** 2) return false;
    for (const p of el) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (elReach + r) ** 2) return false;
    for (const poly of rampPolys) if (pointInPolygon(x, z, poly) || distToPolygonEdge(x, z, poly) < rampGap) return false;
    hits.length = 0;
    for (const e of g.edges) {
      const a = g.nodes[e.a];
      const c = g.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, c.x, c.z);
      if (d < e.width / 2 + r + 0.5) return false;
      if (d < e.width / 2 + e.sidewalk + r + 0.5 + SIDEWALK_GAP) hits.push(e.id);
    }
    let streets = hits.length;
    for (let i = 0; i < hits.length; i++) for (let k = i + 1; k < hits.length; k++) if (joinedAtBend(hits[i], hits[k])) streets--;
    return streets <= 1;
  };
  const column = (poly: Vec2[], x: number, z: number, s: number, r: number) => {
    const walls = solidWalls(poly, 'highway', area.id);
    b.walls.push(...walls);
    todo.push({ walls, s, kind: 'under' });
    b.reserved.push({ x, z, r: r + 0.5 });
  };
  const square = (x: number, z: number, ux: number, uz: number, half: number): Vec2[] => [
    { x: x - ux * half + uz * half, z: z - uz * half - ux * half },
    { x: x + ux * half + uz * half, z: z + uz * half - ux * half },
    { x: x + ux * half - uz * half, z: z + uz * half + ux * half },
    { x: x - ux * half - uz * half, z: z - uz * half + ux * half },
  ];

  // ----- Along every street under it (rows, the swings' diagonals): bents of two square columns, one
  // on each sidewalk, where both stand under the deck (near a swing's turn the deck cuts the corner).
  const spread = (len: number, m0: number, m1: number): number[] => {
    const usable = len - m0 - m1;
    if (usable <= 0) return [];
    const n = Math.max(1, Math.round(usable / CFG.bentSpacing) + 1);
    return Array.from({ length: n }, (_, k) => m0 + (n === 1 ? usable / 2 : (usable * k) / (n - 1)));
  };
  const underDeck = (x: number, z: number) => {
    const pr = projectOnCurve(curve, x, z);
    return Math.abs(pr.lateral) < HALF - CFG.columnSize;
  };
  for (let i = 0; i + 1 < W; i++) {
    const nodes = streetChain(g, gridNode(g, i, rows[i]).id, gridNode(g, i + 1, rows[i + 1]).id);
    if (!nodes) continue;
    const st = chainOfNodes(g, nodes);
    for (const s of spread(st.length, clearOf[st.nodes[0]] + 3, clearOf[st.nodes[st.nodes.length - 1]] + 3)) {
      const p = alongChain(g, st, s);
      const lat = p.w / 2 + CFG.columnSetback;
      const pts = [1, -1].map((k) => ({ x: p.x + p.dz * lat * k, z: p.z - p.dx * lat * k }));
      const hr = CFG.columnSize / 2;
      if (!pts.every((q) => underDeck(q.x, q.z) && columnOk(q.x, q.z, hr * 1.42, 0))) continue;
      const sd = projectOnCurve(curve, p.x, p.z).s;
      for (const q of pts) column(square(q.x, q.z, p.dx, p.dz, hr), q.x, q.z, sd, hr);
      b.props.push({ kind: 'bent', x: p.x, z: p.z, yaw: yawOf(p.dx, p.dz), size: lat, height: CFG.columnSize, area: area.id });
      // Under a ramp's merge the widened deck takes a third column in the block.
      for (const r of deck.ramps) {
        const [lo, hi] = mergeRange(r);
        if (sd < lo || sd > hi) continue;
        const q = deckPoint(curve, sd, r.side * (HALF + CFG.rampHalf));
        column(square(q.x, q.z, p.dx, p.dz, hr), q.x, q.z, sd, hr);
        b.props.push({ kind: 'outrigger', x: q.x, z: q.z, yaw: yawOf(p.dx, p.dz), size: hr, height: r.side, area: area.id });
      }
    }
  }

  // ----- Near a swing's turns the deck's arc cuts the junction's corners, and beside a block of street
  // left at its width the deck overhangs the frontage: no buildings there.
  const half = HALF + CFG.blockMargin;
  const keepOut = (s0: number, s1: number) => {
    for (let s = s0; s < s1 - 1e-6; s += 8) {
      const e = Math.min(s1, s + 8);
      b.exclusions.push([deckPoint(curve, s, -half), deckPoint(curve, e, -half), deckPoint(curve, e, half), deckPoint(curve, s, half)]);
    }
  };
  const reach = CFG.swingTangent + 24;
  for (let k = 0; k < (area.params.turns ?? 0); k++) {
    const st = projectOnCurve(curve, area.params[`turn${k}x`], area.params[`turn${k}z`]).s;
    keepOut(st - reach, st + reach);
  }
  for (let k = 0; k < (area.params.narrow ?? 0); k++) {
    const sa = projectOnCurve(curve, area.params[`narrow${k}ax`], area.params[`narrow${k}az`]).s;
    const sb = projectOnCurve(curve, area.params[`narrow${k}bx`], area.params[`narrow${k}bz`]).s;
    keepOut(Math.min(sa, sb), Math.max(sa, sb));
  }

  // ----- The deck: two levels between the closures, its barriers, median and end closures.
  const sW = deck.sW;
  const sE = deck.sE;
  const k0 = Math.floor(sW / RAIL.step);
  const k1 = Math.ceil(sE / RAIL.step);
  const H = HALF;
  const IN = BARRIER_IN;
  for (let k = k0; k < k1; k += CHUNK) {
    const ka = k;
    const kb = Math.min(k1, k + CHUNK);
    const s0 = ka * RAIL.step;
    const s1 = kb * RAIL.step;
    const sm = (s0 + s1) / 2;
    const right = deckExtent(deck, sm, 1);
    const left = deckExtent(deck, sm, -1);
    const c0 = deckPoint(curve, s0, 0);
    const c1 = deckPoint(curve, s1, 0);
    const poly = [deckPoint(curve, s0, -left), deckPoint(curve, s1, -left), deckPoint(curve, s1, right), deckPoint(curve, s0, right)];
    b.decks.push(deckSpan(deck, poly, c0, c1, ka, kb, area.id));
    // Barriers along both edges, open where a ramp merges.
    for (const side of [1, -1] as const) {
      if (barrierOpen(deck, s0, s1, side)) continue;
      const a = deckPoint(curve, s0, side * (H - IN));
      const c = deckPoint(curve, s1, side * (H - IN));
      const len = sqrt((c.x - a.x) ** 2 + (c.z - a.z) ** 2) || 1;
      // Normal toward the deck's middle.
      let nx = -(c.z - a.z) / len;
      let nz = (c.x - a.x) / len;
      if ((c0.x - a.x) * nx + (c0.z - a.z) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const w: Wall = { ax: a.x, az: a.z, bx: c.x, bz: c.z, nx, nz, kind: 'wall', look: 'highway', area: area.id };
      b.walls.push(w);
      todo.push({ walls: [w], s: sm, kind: 'bottom' });
    }
  }
  // The median: a thin solid down the middle, in pieces between its crossovers (medianGaps), where a car
  // swings round to the other carriageway.
  const mh = CFG.median / 2;
  const runs: [number, number][] = [];
  let from = sW;
  for (const [g0, g1] of medianGaps(deck)) {
    runs.push([from, g0]);
    from = g1;
  }
  runs.push([from, sE]);
  for (const [r0, r1] of runs) {
    const n = Math.max(1, Math.ceil((r1 - r0) / (CHUNK * RAIL.step)));
    for (let k = 0; k < n; k++) {
      const s0 = r0 + ((r1 - r0) * k) / n;
      const s1 = r0 + ((r1 - r0) * (k + 1)) / n;
      const med = [deckPoint(curve, s0, -mh), deckPoint(curve, s1, -mh), deckPoint(curve, s1, mh), deckPoint(curve, s0, mh)];
      const mw = solidWalls(med, 'highway', area.id);
      b.walls.push(...mw);
      todo.push({ walls: mw, s: (s0 + s1) / 2, kind: 'bottom' });
    }
  }
  for (const [s, dir] of [
    [sW, -1],
    [sE, 1],
  ] as const) {
    // A closure across the deck: jersey barriers on a crash cushion, ROAD CLOSED beyond (render).
    const inner = s - dir * 1.4;
    const slab = [deckPoint(curve, inner, -H), deckPoint(curve, s, -H), deckPoint(curve, s, H), deckPoint(curve, inner, H)];
    const sw = solidWalls(slab, 'highway', area.id);
    b.walls.push(...sw);
    todo.push({ walls: sw, s, kind: 'bottom' });
  }
  return b;
}

/** One chunk of the deck between curve samples ka and kb: two levels, the deck's top linear along the chord. */
function deckSpan(deck: HighwayDeck, polygon: Vec2[], c0: Vec2, c1: Vec2, ka: number, kb: number, area: number): DeckSpan {
  const lx = c1.x - c0.x;
  const lz = c1.z - c0.z;
  const len = sqrt(lx * lx + lz * lz) || 1;
  const ux = lx / len;
  const uz = lz / len;
  const top = deck.top;
  return {
    polygon,
    area,
    depth: CFG.clearance + CFG.depth,
    upper(x, z, out) {
      const y0 = top[ka];
      const y1 = top[kb];
      const t = ((x - c0.x) * ux + (z - c0.z) * uz) / len;
      const gr = (y1 - y0) / len;
      out.h = y0 + (y1 - y0) * t;
      out.gx = gr * ux;
      out.gz = gr * uz;
    },
  };
}

export function buildRamp(ctx: BuildContext, area: Area): AreaBuild {
  const b = emptyBuild();
  const g = ctx.graph;
  const deckArea = ctx.areas[area.params.deck];
  const deck = highwayDeck(deckArea, ctx.areas);
  const ramp = highwayRamp(area);
  const ax = ramp.axis;
  const L = ax.length;
  const curve = deck.curve;
  const todo: { walls: Wall[]; u: number; s: number; kind: 'side' | 'merge' | 'front' | 'column' }[] = [];
  rampPending.set(b, todo);
  const hw = CFG.rampHalf;
  const ap = axisPoint();
  const upper = (x: number, z: number, out: HeightSample) => {
    projectAxis(ax, x, z, ap);
    rampHeight(ax, ramp.profile, ramp.terrain, x, z, ap, out);
  };
  const innerSign = rampInnerSign(ramp, curve);
  const edgePt = (u: number, v: number): Vec2 => {
    const q = axisAt(ax, u);
    return { x: q.x - q.tz * v, z: q.z + q.tx * v };
  };
  const strip = (u0: number, u1: number, wide: number): Vec2[] => {
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    const n = Math.max(1, Math.ceil((u1 - u0) / 3));
    for (let k = 0; k <= n; k++) {
      const u = u0 + ((u1 - u0) * k) / n;
      left.push(edgePt(u, wide));
      right.push(edgePt(u, -wide));
    }
    return left.concat(right.reverse());
  };
  // Spans, a few meters each: one solid level up the embankment, two levels from where it leaves its
  // block on, over the cross street and onto the deck (overlapping the deck's widened chunks by the gore).
  const uc = Math.max(4, ramp.uSolid);
  const wide = hw + 0.5;
  const pieces = (u0: number, u1: number, solid: boolean) => {
    for (let u = u0; u < u1 - 1e-6; u += 6) {
      const e = Math.min(u1, u + 6);
      b.decks.push({ polygon: strip(u, e + 0.2, wide), area: area.id, depth: 0, upper, solid });
    }
  };
  pieces(-0.4, uc, true);
  pieces(uc, L + GORE + 2, false);
  // Side walls, thin two sided solids from the foot to the top; the inner one runs on past E along the
  // deck's edge (the gore), where the barrier opens.
  const wt = 0.35;
  for (const k of [-1, 1]) {
    const end = k === innerSign ? L + GORE : L;
    for (let u = 0; u < end - 1e-6; u += 4) {
      const e = Math.min(end, u + 4);
      const v = k * (hw + wt / 2);
      const slab = [edgePt(u, v - wt / 2), edgePt(e, v - wt / 2), edgePt(e, v + wt / 2), edgePt(u, v + wt / 2)];
      const walls = solidWalls(slab, 'highway', area.id);
      b.walls.push(...walls);
      todo.push({ walls, u: (u + e) / 2, s: NaN, kind: 'side' });
    }
  }
  // Columns under the bridge stretch, every few tens of meters where they stand off every street and its
  // sidewalks and clear of the junctions: solid to cars beneath, nothing to cars up on the ramp (the
  // prop's height is its u along the ramp: the renderer reads the top off the profile).
  {
    const R = 0.9;
    const clearOf = (n: { edges: number[] }) => {
      let m = 0;
      for (const eid of n.edges) m = Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk);
      return m + Math.max(ROUTE.barrierSetbackHeadOn + CLOSURE_GAP, ROUTE.railReach + 3);
    };
    const spotOk = (x: number, z: number) => {
      for (const n of g.nodes) if ((n.gi >= 0 || n.edges.length > 2) && (n.x - x) ** 2 + (n.z - z) ** 2 < clearOf(n) ** 2) return false;
      for (const e of g.edges) {
        const a = g.nodes[e.a];
        const c = g.nodes[e.b];
        if (distToSegment(x, z, a.x, a.z, c.x, c.z) < e.width / 2 + e.sidewalk + R + 0.6) return false;
      }
      return Math.abs(projectOnCurve(curve, x, z).lateral) > ramp.building + R + 2;
    };
    let last = -Infinity;
    for (let u = uc + 6; u <= L - 4; u += 2) {
      if (u - last < 20) continue;
      const q = axisAt(ax, u);
      if (!spotOk(q.x, q.z)) continue;
      last = u;
      const walls = solidWalls(circlePolygon(q.x, q.z, R, 10), 'highway', area.id);
      b.walls.push(...walls);
      todo.push({ walls, u, s: NaN, kind: 'column' });
      b.reserved.push({ x: q.x, z: q.z, r: R + 0.5 });
      b.props.push({ kind: 'rampColumn', x: q.x, z: q.z, yaw: 0, size: R, height: u, area: area.id });
    }
  }
  // The merge: the lane's outer wall alongside the deck, the taper back to its edge and on along it past
  // the taper's end, where the barrier closes again (two levels: cars under pass beneath).
  const side = ramp.side;
  const sEnd = ramp.sb + side * 7;
  const n = Math.max(2, Math.ceil(Math.abs(sEnd - ramp.sa) / 4));
  for (let k = 0; k < n; k++) {
    const s0 = ramp.sa + ((sEnd - ramp.sa) * k) / n;
    const s1 = ramp.sa + ((sEnd - ramp.sa) * (k + 1)) / n;
    const a = deckPoint(curve, s0, side * rampOuterAt(ramp, s0));
    const c = deckPoint(curve, s1, side * rampOuterAt(ramp, s1));
    const slab = thinSlab(a, c, wt);
    if (!slab) continue;
    const walls = solidWalls(slab, 'highway', area.id);
    b.walls.push(...walls);
    todo.push({ walls, u: NaN, s: (s0 + s1) / 2, kind: 'merge' });
  }
  // The frontage under the ramp's top and the merge: one wall along the building line that only street
  // cars meet (Wall.under), where the city's frontage walls are taken out.
  const front = rampFront(ramp, curve);
  const [fs0, fs1] = front ?? [0, 0];
  const bl = ramp.building;
  const nf = front ? Math.max(1, Math.ceil((fs1 - fs0) / 4)) : 0;
  for (let k = 0; k < nf; k++) {
    const s0 = fs0 + ((fs1 - fs0) * k) / nf;
    const s1 = fs0 + ((fs1 - fs0) * (k + 1)) / nf;
    const a = deckPoint(curve, s0, side * bl);
    const c = deckPoint(curve, s1, side * bl);
    const toward = deckPoint(curve, (s0 + s1) / 2, 0);
    const len = sqrt((c.x - a.x) ** 2 + (c.z - a.z) ** 2) || 1;
    let nx = -(c.z - a.z) / len;
    let nz = (c.x - a.x) / len;
    if ((toward.x - a.x) * nx + (toward.z - a.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const w: Wall = { ax: a.x, az: a.z, bx: c.x, bz: c.z, nx, nz, kind: 'wall', look: 'highway', area: area.id };
    b.walls.push(w);
    todo.push({ walls: [w], u: NaN, s: (s0 + s1) / 2, kind: 'front' });
  }
  if (front) b.openings.push([deckPoint(curve, fs0 - 1, side * (bl - 2)), deckPoint(curve, fs1 + 1, side * (bl - 2)), deckPoint(curve, fs1 + 1, side * (bl + 2.5)), deckPoint(curve, fs0 - 1, side * (bl + 2.5))]);
  // The mouth: the frontage across it goes, the curb is cut the sidewalk deep (busBays.ts mouthBay) in
  // the final graph's curb frame, and street furniture keeps off it.
  b.openings.push(strip(-2.5, 2.5, hw + 1));
  const cut = mouthCut(g, ctx.mouths, area.params.edge, ax);
  if (cut) {
    b.hints.push({ kind: 'mouth', points: [], values: [area.params.edge, cut.side, cut.s0, cut.s1, MOUTH_TAPER] });
    // Nothing of the street furniture's on the cut (it is road now): circles over it, as a park path's mouth.
    const bay = mouthBay(g, ctx.mouths, -1, area.params.edge, cut.side, cut.s0, cut.s1, MOUTH_TAPER);
    const depth = bay.depth - MOUTH_REACH;
    for (let s = bayLo(bay); s <= bayHi(bay) + 1e-6; s += 2) for (const v of [0.6, depth / 2, depth - 0.6]) if (v < bayInset(bay, s) + 0.6) b.reserved.push({ ...bayPoint(bay, s, v), r: 1.2 });
  }
  for (let v = -hw; v <= hw + 1e-6; v += 2) {
    const p = edgePt(-2.5, v);
    b.reserved.push({ x: p.x, z: p.z, r: 1.8 });
  }
  // No buildings or infill on its right of way, nor beside the merge.
  b.exclusions.push(rampOutline(ax, curve, side, ramp.sa, ramp.sb, 2.5));
  return b;
}

/** A thin slab (two sided solid) of thickness t centered on a-c. */
function thinSlab(a: Vec2, c: Vec2, t: number): Vec2[] | null {
  const len = sqrt((c.x - a.x) ** 2 + (c.z - a.z) ** 2);
  if (len < 0.05) return null;
  const nx = (-(c.z - a.z) / len) * (t / 2);
  const nz = ((c.x - a.x) / len) * (t / 2);
  return [
    { x: a.x - nx, z: a.z - nz },
    { x: c.x - nx, z: c.z - nz },
    { x: c.x + nx, z: c.z + nz },
    { x: a.x + nx, z: a.z + nz },
  ];
}
