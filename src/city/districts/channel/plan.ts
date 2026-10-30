/**
 * Planning the channel (planChannel, the district's plan). It tries row pairs of the city's grid for the first
 * meander (midline) whose band clears every junction and seats an entrance in every quarter (bandClear, the
 * candidate entrances), merges the crossing streets into straight edges, then builds into the graph the ramp
 * feet, T nodes and ramp edges, sizes the bell mouths to the room beside them (sizeMouths) and runs the channel
 * chain from portal to portal with the set pieces between (planFeatures). The area it registers carries the
 * centerline samples, ramps and features in its params, which every other module reads back.
 */
import { CITY } from '../../config';
import type { RoadGraph, RoadEdge, RoadNode } from '../../roadGraph';
import { addEdge, addNode, chainOf as streetChain, chains as streetChains, isChannelEdge, mergeChains, otherNode, splitEdge } from '../../roadGraph';
import { Vec2, distToSegment, segmentT, sin, sqrt } from '../../../sim/math';
import { deriveSeed } from '../../../sim/prng';
import type { Area, PlanContext } from '../types';
import { planFeatures } from '../channelFeatures';
import { channelWidth, channelCenter, channelFrame, channelL } from './centerline';
import { type Ramp, type RampPlan, rampAlong, rampsOf } from './ramps';
import { STREET_KINDS, bridgesOf, chainOf, crosses, crossingT } from './bridges';

const CFG = CITY.districts.channel;
const LAKE = CITY.districts.lake;

/** A bell mouth's plinth keeps this far (m) inside the room to the next corridor; the room is capped at MOUTH_ROOM (m). */
const MOUTH_MARGIN = 2;
const MOUTH_ROOM = 40;

/** The channel district's plan: claim the channel, its bridges and ramps (DistrictModule.plan). */
export function planChannel(ctx: PlanContext): void {
  if (!CFG.enabled) return;
  const rng = ctx.rng;
  if (!rng.chance(CFG.chance)) return;
  const g = ctx.graph;
  const lakes = ctx.areas.filter((a) => a.kind === 'lake');
  const F = CFG.floorHalf;
  const T = F + CFG.bankWidth;
  const H = g.plan.gridH;
  const x0 = g.bounds.minX - 160;
  const x1 = g.bounds.maxX + 160;
  const step = CFG.centerStep;
  const cx0 = x0 - 2 * step;
  const cn = Math.ceil((x1 + 2 * step - cx0) / step) + 1;
  const kM = (Math.PI * 2) / CFG.wavelength;
  const kE = (Math.PI * 2) / CFG.envelope;
  const phase = rng.range(0, Math.PI * 2);
  const phaseE = rng.range(0, Math.PI * 2);
  const rows: number[] = [];
  for (let j = 2; j <= H - 4; j++) rows.push(j);
  rng.shuffle(rows);

  /** The midline between grid rows j and j + 1 as a function of x: column samples, linear between, flat beyond, box smoothed. */
  const midline = (j: number): ((x: number) => number) | null => {
    const byCol = new Map<number, RoadNode[]>();
    for (const n of g.nodes) if (n.gj === j || n.gj === j + 1) (byCol.get(n.gi) ?? byCol.set(n.gi, []).get(n.gi)!).push(n);
    const cols: Vec2[] = [];
    for (const ns of byCol.values()) {
      const a = ns.find((n) => n.gj === j);
      const b = ns.find((n) => n.gj === j + 1);
      if (a && b) cols.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
    }
    if (cols.length < 3) return null;
    cols.sort((u, v) => u.x - v.x);
    const raw = (x: number): number => {
      if (x <= cols[0].x) return cols[0].z;
      for (let i = 0; i + 1 < cols.length; i++) {
        if (x <= cols[i + 1].x) {
          const t = (x - cols[i].x) / (cols[i + 1].x - cols[i].x || 1);
          return cols[i].z + (cols[i + 1].z - cols[i].z) * t;
        }
      }
      return cols[cols.length - 1].z;
    };
    const half = CFG.smoothSpan / 2;
    return (x) => {
      let sum = 0;
      let n = 0;
      for (let u = -half; u <= half + 1e-6; u += 8) {
        sum += raw(x + u);
        n++;
      }
      return sum / n;
    };
  };
  /**
   * The lake (carved before the channel) all on one side of the band, its shore well off it, so no bank
   * street is a shore street. The lake was put where the channel would run without it (lake.ts), so this
   * only turns away rows that ran through its blocks.
   */
  const lakeClear = (p: Record<string, number>): boolean => {
    for (const lk of lakes) {
      const s0 = channelL(p, lk.polygon[0].x, lk.polygon[0].z) > 0;
      for (const q of lk.polygon) {
        const l = channelL(p, q.x, q.z);
        if (l > 0 !== s0 || Math.abs(l) < T + LAKE.channelClear) return false;
      }
    }
    return true;
  };
  /** Junctions clear of the band, every street either crossing it squarely or well away from it. */
  const bandClear = (p: Record<string, number>): boolean => {
    for (const n of g.nodes) if (n.edges.length !== 2 && Math.abs(channelL(p, n.x, n.z)) < T + CFG.junctionClear) return false;
    // The other pieces of a crossing street (cut through bend nodes, roadGraph.ts) run on into the
    // crossing: they are its approach, not a street alongside the band.
    const approach = new Set<number>();
    for (const e of g.edges) if (crosses(p, g.nodes[e.a], g.nodes[e.b])) for (const id of streetChain(g, e.id).edges) approach.add(id);
    for (const e of g.edges) {
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      if (crosses(p, a, b)) {
        if (!STREET_KINDS.has(e.kind) || e.shortcut) return false;
        const t = crossingT(p, a, b, 0);
        const fr = channelFrame(p, a.x + (b.x - a.x) * t);
        const len = e.length || 1;
        if (Math.abs(((b.x - a.x) / len) * fr.tx + ((b.z - a.z) / len) * fr.tz) > CFG.maxSkew) return false;
        if (!chainOf(g, p, e)) return false;
      } else if (!approach.has(e.id)) {
        const steps = Math.max(1, Math.ceil(e.length / 8));
        for (let k = 0; k <= steps; k++) {
          const x = a.x + ((b.x - a.x) * k) / steps;
          const z = a.z + ((b.z - a.z) * k) / steps;
          if (Math.abs(channelL(p, x, z)) < T + CFG.streetClear) return false;
        }
      }
    }
    return true;
  };
  const qx0 = g.bounds.minX;
  const qx1 = g.bounds.maxX;
  const quarterOf = (x: number) => Math.max(0, Math.min(3, Math.floor((4 * (x - qx0)) / (qx1 - qx0))));
  /** The entrances a candidate centerline can seat. Pure: the graph is only read; rng is drawn in a fixed order. */
  interface Entrances {
    plans: RampPlan[];
    fords: RoadEdge[];
    chains: Map<number, { edges: RoadEdge[]; nodes: number[] }>;
    crossing: RoadEdge[];
    /** Quarters of the channel's length with an entrance, and the count (a ford is two). */
    quarters: number;
    count: number;
  }
  const planEntrances = (p: Record<string, number>): Entrances => {
    const lOf = (x: number, z: number) => channelL(p, x, z);
    // Crossing streets, each followed through its bends into a deck polyline; all bridges unless a ford.
    const crossing = g.edges.filter((e) => crosses(p, g.nodes[e.a], g.nodes[e.b]));
    const chains = new Map<number, { edges: RoadEdge[]; nodes: number[] }>();
    for (const e of crossing) chains.set(e.id, chainOf(g, p, e)!);
    const crossX = (e: RoadEdge) => {
      const a = g.nodes[e.a];
      return a.x + (g.nodes[e.b].x - a.x) * crossingT(p, a, g.nodes[e.b], 0);
    };
    const sorted = crossing.map((e) => ({ e, cx: crossX(e), dk: e.width / 2 + e.sidewalk })).sort((u, v) => u.cx - v.cx);
    // ----- Fords: a plain, nearly square crossing street in one piece, with room on both banks for its
    // ramp run and a stretch of flat street before each junction, nothing else through its trench.
    const plans: RampPlan[] = [];
    const fordBody = (e: RoadEdge, hw: number) => e.width / 2 + e.sidewalk - hw;
    const fordWidth = (e: RoadEdge) => e.width / 2;
    // Flat street kept before a ford's ramp top at junction n: past the junction's far sidewalk corner
    // (a neighbouring road at angle phi puts it (H + w cos phi) / sin phi along the street, w this
    // street's half corridor, H the neighbour's) plus the room its mouth closure needs.
    const setbackOf = (n: RoadNode, e: RoadEdge): number => {
      const far = g.nodes[otherNode(e, n.id)];
      const len = sqrt((far.x - n.x) ** 2 + (far.z - n.z) ** 2) || 1;
      const ux = (far.x - n.x) / len;
      const uz = (far.z - n.z) / len;
      const w = e.width / 2 + e.sidewalk;
      let corner = 0;
      for (const oid of n.edges) {
        const o = g.edges[oid];
        if (o === e) continue;
        const q = g.nodes[otherNode(o, n.id)];
        const ol = sqrt((q.x - n.x) ** 2 + (q.z - n.z) ** 2) || 1;
        const c = ((q.x - n.x) * ux + (q.z - n.z) * uz) / ol;
        const s = Math.abs((q.x - n.x) * uz - (q.z - n.z) * ux) / ol;
        // A road carrying straight on makes no corner with this one.
        if (s < 0.35) continue;
        corner = Math.max(corner, (o.width / 2 + o.sidewalk + w * c) / s);
      }
      return corner + CFG.fordSetback;
    };
    const fordOk = (e: RoadEdge) => {
      if ((e.kind !== 'street' && e.kind !== 'avenue') || e.shortcut) return false;
      if (chains.get(e.id)!.edges.length !== 1) return false;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const len = e.length || 1;
      const ux = (b.x - a.x) / len;
      const uz = (b.z - a.z) / len;
      const tf = crossingT(p, a, b, 0);
      const fx = a.x + (b.x - a.x) * tf;
      const fz = a.z + (b.z - a.z) * tf;
      const fr = channelFrame(p, fx);
      if (Math.abs(ux * fr.tx + uz * fr.tz) > 0.25) return false;
      if (![a, b].every((n) => Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, e) >= CFG.rampMinRun)) return false;
      // No other road (a diagonal leaving the same junction, say) runs through the dip's trench or
      // plinths: no point of another road's corridor inside the ramp's rectangle on either bank.
      const reach = fordWidth(e) + fordBody(e, fordWidth(e)) + CFG.fordClear;
      const runs = [a, b].map((n) => Math.min(CFG.rampMaxRun, Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, e)));
      for (const o of g.edges) {
        if (o === e) continue;
        const oa = g.nodes[o.a];
        const ob = g.nodes[o.b];
        const half = o.width / 2 + o.sidewalk;
        const steps = Math.max(2, Math.ceil(o.length / 3));
        for (let k = 0; k <= steps; k++) {
          const x = oa.x + ((ob.x - oa.x) * k) / steps;
          const z = oa.z + ((ob.z - oa.z) * k) / steps;
          const along = (x - fx) * ux + (z - fz) * uz;
          const lat = -(x - fx) * uz + (z - fz) * ux;
          // Which bank this point is on decides which half's run bounds it.
          const run = along >= 0 ? runs[1] : runs[0];
          if (Math.abs(along) < F + run + half && Math.abs(lat) < reach + half) return false;
        }
      }
      return true;
    };

    // ----- Side ramps: from the foot at channel x, straight up bank `side` along the channel's normal to
    // the first street roughly parallel to the channel, with the curb far enough from the floor for a
    // legal grade and near enough that the trench fits, nothing else across the trench.
    const hw = CFG.rampHalfWidth;
    const body = CFG.rampBody;
    const sideRamp = (xr: number, side: number): RampPlan | null => {
      const fr = channelFrame(p, xr);
      const P = { x: xr, z: channelCenter(p, xr) };
      const dx = side * fr.mx;
      const dz = side * fr.mz;
      let best: RoadEdge | null = null;
      let bestU = Infinity;
      let bestHit: Vec2 | null = null;
      for (const e of g.edges) {
        // Never a diagonal: the warp (roadGraph.ts) swings some within the parallel test below, and a
        // trench meeting one obliquely pokes its end into the street.
        if (!STREET_KINDS.has(e.kind) || e.kind === 'diagonal' || e.bridge || e.shortcut || isChannelEdge(e)) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        const sx = b.x - a.x;
        const sz = b.z - a.z;
        const den = dx * sz - dz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const u = ((a.x - P.x) * sz - (a.z - P.z) * sx) / den;
        const v = ((a.x - P.x) * dz - (a.z - P.z) * dx) / den;
        if (u <= 0 || v < 0 || v > 1) continue;
        const len = e.length || 1;
        // The T node keeps clear of the street's own ends, and the street runs along the channel.
        if (v * len < 18 || (1 - v) * len < 18) continue;
        if (Math.abs((sx / len) * fr.tx + (sz / len) * fr.tz) < 0.8) continue;
        if (u < bestU) {
          bestU = u;
          best = e;
          bestHit = { x: a.x + sx * v, z: a.z + sz * v };
        }
      }
      if (!best || !bestHit) return null;
      const bestFront = bestU - (best.width / 2 + best.sidewalk);
      const run = bestFront - 0.5 - F;
      if (run < CFG.rampMinRun || run > CFG.rampMaxRun) return null;
      // Nothing else may cross the trench (a missing row street would make it run on to the next row),
      // and no deck box either side of it.
      const reach = hw + body + CFG.rampClear;
      for (let q = 0; q <= 10; q++) {
        const u = F + ((bestFront + best.sidewalk - F) * q) / 10;
        const x = P.x + dx * u;
        const z = P.z + dz * u;
        for (const e of g.edges) {
          if (e === best) continue;
          const a = g.nodes[e.a];
          const b = g.nodes[e.b];
          const near = e.width / 2 + e.sidewalk + reach;
          // A point farther than `near` from the segment's bounds is farther than that from the segment.
          if (x < Math.min(a.x, b.x) - near - 1e-6 || x > Math.max(a.x, b.x) + near + 1e-6 || z < Math.min(a.z, b.z) - near - 1e-6 || z > Math.max(a.z, b.z) + near + 1e-6) continue;
          if (distToSegment(x, z, a.x, a.z, b.x, b.z) < near) return null;
        }
      }
      return { ford: false, x: xr, side, hw, body, topL: bestFront - 0.5, curbL: bestFront + best.sidewalk, edge: best.id, hit: bestHit };
    };

    // ----- Entrances by quarter of the channel's length: fords first (each fills its quarter on both
    // banks), then one side ramp in every quarter still empty, the outer quarters first, banks
    // alternating, then more in random quarters up to the seed's count.
    const feetX: number[] = [];
    const spaced = (x: number) => feetX.every((fx) => Math.abs(x - fx) >= CFG.entranceGap) && sorted.every((c) => Math.abs(x - c.cx) >= c.dk + CFG.footClear);
    const want = rng.int(CFG.entrances[0], CFG.entrances[1]);
    const fordCands = sorted.filter((c) => fordOk(c.e));
    rng.shuffle(fordCands);
    const fords: RoadEdge[] = [];
    const fordQuarters = new Set<number>();
    for (let count = rng.int(CFG.fords[0], CFG.fords[1]); count > 0 && fordCands.length; count--) {
      const i = fordCands.findIndex((c) => !fordQuarters.has(quarterOf(c.cx)) && feetX.every((fx) => Math.abs(c.cx - fx) >= CFG.entranceGap));
      if (i < 0) break;
      const c = fordCands.splice(i, 1)[0];
      fords.push(c.e);
      fordQuarters.add(quarterOf(c.cx));
      feetX.push(c.cx);
      const a = g.nodes[c.e.a];
      const b = g.nodes[c.e.b];
      const hwF = fordWidth(c.e);
      for (const n of [a, b]) {
        const side = lOf(n.x, n.z) > 0 ? 1 : -1;
        const run = Math.min(CFG.rampMaxRun, Math.abs(lOf(n.x, n.z)) - F - setbackOf(n, c.e));
        plans.push({ ford: true, x: c.cx, side, hw: hwF, body: fordBody(c.e, hwF), topL: F + run, curbL: F + run, edge: c.e.id });
      }
    }
    const entrances = () => plans.filter((q) => !q.ford).length + fords.length * 2;
    /** Slots of a quarter: channel x positions every 6 m inside it, shuffled. */
    const slotsOf = (q: number): number[] => {
      const qa = qx0 + ((qx1 - qx0) * q) / 4;
      const qb = qa + (qx1 - qx0) / 4;
      const xs: number[] = [];
      for (let x = qa + 12; x <= qb - 12; x += 6) xs.push(x);
      rng.shuffle(xs);
      return xs;
    };
    /** The bank the next entrance is due on: opposite the nearest one along the channel. */
    const dueSide = (x: number): number => {
      let best: RampPlan | null = null;
      for (const q of plans) if (!best || Math.abs(q.x - x) < Math.abs(best.x - x)) best = q;
      return best ? -best.side : rng.chance(0.5) ? 1 : -1;
    };
    const fill = (q: number): boolean => {
      for (const x of slotsOf(q)) {
        if (!spaced(x)) continue;
        const side = dueSide(x);
        const plan = sideRamp(x, side) ?? sideRamp(x, -side);
        if (!plan) continue;
        plans.push(plan);
        feetX.push(x);
        return true;
      }
      return false;
    };
    const filled = new Set<number>(fordQuarters);
    for (const q of [0, 3, 1, 2]) if (!filled.has(q) && fill(q)) filled.add(q);
    const order = [0, 1, 2, 3];
    rng.shuffle(order);
    for (let round = 0; round < 3 && entrances() < want; round++) {
      let any = false;
      for (const q of order) {
        if (entrances() >= want) break;
        if (fill(q)) any = true;
      }
      if (!any) break;
    }

    return { plans, fords, chains, crossing, quarters: new Set(feetX.map(quarterOf)).size, count: entrances() };
  };

  // The first row pair (and meander swing) whose band clears every junction and seats an entrance in
  // every quarter; failing that, the one that comes closest.
  let best: { p: Record<string, number>; ent: Entrances; score: number; row: number } | null = null;
  rowLoop: for (const j of rows) {
    const mid = midline(j);
    if (!mid) continue;
    for (let s = CFG.meanderSteps; s >= 0; s--) {
      const A = (CFG.meander * s) / CFG.meanderSteps;
      const p: Record<string, number> = { cn, cx0, cdx: step, floor: F, top: T, depth: CFG.depth, x0, x1, meander: A, ramps: 0 };
      for (let i = 0; i < cn; i++) {
        const x = cx0 + i * step;
        p[`c${i}`] = mid(x) + A * (0.6 + 0.4 * sin(kE * x + phaseE)) * sin(kM * x + phase);
      }
      if (!bandClear(p)) continue;
      const ent = planEntrances(p);
      // After the entrances' draws: the stream runs on as it would with no lake.
      if (!lakeClear(p)) continue;
      const score = ent.quarters * 100 + ent.count;
      if (!best || score > best.score) best = { p, ent, score, row: j };
      if (ent.quarters === 4 && ent.count >= CFG.entrances[0]) break rowLoop;
    }
  }
  if (!best) return;
  const footprint = (g.bounds.maxX - g.bounds.minX) * 2 * T;
  if (ctx.budget.used + footprint > ctx.budget.total) return;
  // Every street over the channel runs straight from bank junction to bank junction, and so does
  // every street of the two bank rows: their pieces through bend nodes (roadGraph.ts) merge back
  // into one edge, so a bridge deck, a ford's ramps and a side ramp's T each sit on
  // one straight edge. The channel plans first, so only the lake's claims hold ids yet (graphChanged
  // carries them through the renumbering); the entrances are planned again on the merged streets.
  {
    const bp = best.p;
    const row = best.row;
    const bank = (c: { nodes: number[] }) => {
      const A = g.nodes[c.nodes[0]];
      const B = g.nodes[c.nodes[c.nodes.length - 1]];
      return A.gj >= 0 && A.gj === B.gj && (A.gj === row || A.gj === row + 1);
    };
    const over = streetChains(g).filter((c) => c.edges.length > 1 && (bank(c) || c.edges.some((id) => crosses(bp, g.nodes[g.edges[id].a], g.nodes[g.edges[id].b]))));
    if (over.length) {
      // The lake carved before the channel (districts/index.ts): its claims follow the renumbering.
      ctx.graphChanged(mergeChains(g, over));
      best.ent = planEntrances(bp);
    }
  }
  const p = best.p;
  p.seed = rng.int(1, 0x7ffffffe);
  const { plans, chains, crossing } = best.ent;
  let fords = best.ent.fords;
  // No entrance fits: keep the channel as scenery (every crossing a bridge).
  if (!plans.length) fords = [];
  for (const e of crossing) if (!fords.includes(e)) for (const ce of chains.get(e.id)!.edges) ce.bridge = true;

  // ----- Graph: feet, T nodes, ramp edges; then the channel chain from portal to portal through every foot.
  const channelDims = { width: channelWidth(F), lanes: 2 as const, sidewalk: 0 };
  const nodes: number[] = [];
  const edges: number[] = [];
  for (const e of crossing) for (const ce of chains.get(e.id)!.edges) if (ce.bridge) edges.push(ce.id);
  const feet = new Map<number, number>();
  const footAt = (x: number): number => {
    const key = Math.round(x * 100);
    let id = feet.get(key);
    if (id === undefined) {
      id = addNode(g, x, channelCenter(p, x));
      feet.set(key, id);
      nodes.push(id);
    }
    return id;
  };
  // Fords first: split the crossing street at both tops, then the piece between at the foot.
  for (const e of fords) {
    const halves = plans.filter((q) => q.ford && q.edge === e.id);
    if (halves.length !== 2) continue;
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const topOf = (q: RampPlan) => crossingT(p, a, b, q.side * q.topL);
    let t1 = topOf(halves[0]);
    let t2 = topOf(halves[1]);
    let first = halves[0];
    let second = halves[1];
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [first, second] = [second, first];
    }
    const tf = crossingT(p, a, b, 0);
    const n2 = splitEdge(g, e.id, t2);
    const n1 = splitEdge(g, e.id, t1 / t2);
    const mid = g.edges[g.edges.length - 1];
    const foot = splitEdge(g, mid.id, (tf - t1) / (t2 - t1));
    const dip = [mid, g.edges[g.edges.length - 1]];
    const hwF = first.hw;
    for (const d of dip) {
      d.kind = 'ramp';
      d.width = 2 * hwF;
      d.sidewalk = 0;
      d.lanes = 2;
      delete d.bridge;
    }
    feet.set(Math.round(g.nodes[foot].x * 100), foot);
    nodes.push(foot, n1, n2);
    edges.push(dip[0].id, dip[1].id);
    const F0 = g.nodes[foot];
    for (const [q, node, d] of [
      [first, n1, dip[0]],
      [second, n2, dip[1]],
    ] as [RampPlan, number, RoadEdge][]) {
      const N = g.nodes[node];
      const len = sqrt((N.x - F0.x) ** 2 + (N.z - F0.z) ** 2) || 1;
      pushRamp(p, { ...q, x: F0.x }, F0, { x: (N.x - F0.x) / len, z: (N.z - F0.z) / len }, d.id, node, foot);
    }
  }
  for (const q of plans) {
    if (q.ford || !q.hit) continue;
    const foot = footAt(q.x);
    // The street may already carry another ramp's T node: split whichever piece holds the hit point.
    let piece = -1;
    let pieceD = 0.5;
    for (const e of g.edges) {
      if (e.kind !== g.edges[q.edge].kind || isChannelEdge(e)) continue;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const d = distToSegment(q.hit.x, q.hit.z, a.x, a.z, b.x, b.z);
      if (d < pieceD) {
        pieceD = d;
        piece = e.id;
      }
    }
    if (piece < 0) continue;
    const pe = g.edges[piece];
    const A = g.nodes[pe.a];
    const B = g.nodes[pe.b];
    const node = splitEdge(g, piece, segmentT(q.hit.x, q.hit.z, A.x, A.z, B.x, B.z));
    const N = g.nodes[node];
    const dims = { width: 2 * q.hw, lanes: 2 as const, sidewalk: 0 };
    const edge = addEdge(g, node, foot, 'ramp', dims);
    nodes.push(node);
    edges.push(edge);
    const Fp = g.nodes[foot];
    const len = sqrt((N.x - Fp.x) ** 2 + (N.z - Fp.z) ** 2) || 1;
    pushRamp(p, q, Fp, { x: (N.x - Fp.x) / len, z: (N.z - Fp.z) / len }, edge, node, foot);
  }
  sizeMouths(g, p);
  // The chain: portal to portal through every foot, a node at least every nodeSpacing, none under a deck.
  {
    const tmp: Area = { id: -1, kind: 'channel', variant: '', polygon: [], path: [], nodes, edges, faces: [], params: p };
    const bridges = bridgesOf(g, tmp);
    const stations: number[] = [x0 + CFG.endStub, ...[...feet.values()].map((id) => g.nodes[id].x), x1 - CFG.endStub].sort((a, b) => a - b);
    const ends: number[] = [];
    let prev = -1;
    for (let i = 0; i < stations.length; i++) {
      const x = stations[i];
      let id = feet.get(Math.round(x * 100));
      if (id === undefined) {
        id = addNode(g, x, channelCenter(p, x));
        nodes.push(id);
        if (i === 0 || i === stations.length - 1) ends.push(id);
      }
      if (prev >= 0) {
        const xa = g.nodes[prev].x;
        const n = Math.max(1, Math.ceil((x - xa) / CFG.nodeSpacing));
        let last = prev;
        for (let k = 1; k < n; k++) {
          let mx = xa + ((x - xa) * k) / n;
          for (const br of bridges) {
            const keep = br.dk + CFG.bridgeBody + 8;
            if (Math.abs(mx - br.cx) < keep) mx = br.cx + (mx >= br.cx ? keep : -keep);
          }
          if (mx - g.nodes[last].x < 12 || x - mx < 12) continue;
          const mid = addNode(g, mx, channelCenter(p, mx));
          nodes.push(mid);
          edges.push(addEdge(g, last, mid, 'channel', channelDims));
          last = mid;
        }
        edges.push(addEdge(g, last, id, 'channel', channelDims));
      }
      prev = id;
    }
    // The set pieces along the floor, between the end stubs, clear of every foot and deck.
    planFeatures(
      p,
      // 'river:features' keeps the channel's old name: the label feeds deriveSeed, so renaming it would change every seed's set pieces.
      deriveSeed(p.seed, 'river:features'),
      x0 + CFG.endStub + 30,
      x1 - CFG.endStub - 30,
      [...feet.values()].map((id) => g.nodes[id].x),
      bridges.map((br) => ({ cx: br.cx, half: br.dk + CFG.bridgeBody })),
    );
  }
  ctx.graphChanged();

  // Footprint: the channel band, bulging out over the ramp trenches (a simple comb polygon).
  const ramps = rampsOf({ id: -1, kind: 'channel', variant: '', polygon: [], path: [], nodes, edges, faces: [], params: p });
  const path: Vec2[] = [];
  const up: Vec2[] = [];
  const down: Vec2[] = [];
  // A ramp's bulge covers its trench, plinths and the funnel at its top (the funnel's props must stand
  // inside the area's polygon).
  // (12 m past the funnel: a long ford on a skewed street carries its end props a little further out.)
  const funnelL = (r: Ramp) => (r.ford ? r.topL : r.curbL) + CFG.funnelReach + 12;
  const bulge = (x: number, s: number): number => {
    let l = T + 0.5;
    for (const r of ramps) {
      if (r.side !== s) continue;
      const reach = r.hw + r.body + CFG.funnelFlare + 4 + CITY.districts.infill.gap;
      // Out to the funnel's street end (a skewed street carries it sideways past the ramp top).
      const xTop = r.ax + r.ux * rampAlong(p, r, funnelL(r));
      if (x >= Math.min(r.ax, xTop) - reach && x <= Math.max(r.ax, xTop) + reach) l = Math.max(l, funnelL(r));
    }
    return l;
  };
  const xs: number[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += 16) xs.push(x);
  for (const r of ramps) {
    const reach = r.hw + r.body + CFG.funnelFlare + 4 + CITY.districts.infill.gap;
    const xTop = r.ax + r.ux * rampAlong(p, r, funnelL(r));
    const lo = Math.min(r.ax, xTop) - reach;
    const hi = Math.max(r.ax, xTop) + reach;
    xs.push(lo - 0.01, lo + 0.01, hi - 0.01, hi + 0.01);
  }
  xs.sort((a, b) => a - b);
  for (const x of xs) {
    const z = channelCenter(p, x);
    path.push({ x, z });
    up.push({ x, z: z + bulge(x, 1) });
    down.push({ x, z: z - bulge(x, -1) });
  }
  ctx.addArea({ kind: 'channel', variant: 'channel', polygon: up.concat(down.reverse()), path, nodes, edges, faces: [], params: p }, footprint);
}

/** Record a ramp in the area params (see rampsOf). */
function pushRamp(p: Record<string, number>, q: RampPlan, foot: Vec2, u: Vec2, edge: number, node: number, footId: number): void {
  const i = p.ramps++;
  const set = (k: string, v: number) => (p[`r${i}${k}`] = v);
  set('ax', foot.x);
  set('az', foot.z);
  set('ux', u.x);
  set('uz', u.z);
  set('side', q.side);
  set('hw', q.hw);
  set('body', q.body);
  set('topL', q.topL);
  set('curbL', q.curbL);
  set('ford', q.ford ? 1 : 0);
  set('edge', edge);
  set('node', node);
  set('foot', footId);
  set('flL', 0);
  set('flR', 0);
  set('rmL', 0);
  set('rmR', 0);
}

/**
 * A side ramp's bell mouth, each side: the room along the bank street from
 * the ramp's axis to the next corridor on that side (a cross street's curb
 * and sidewalk at the next junction, or half way to another ramp's T), and
 * the flare that leaves the plinth and a margin inside it.
 */
function sizeMouths(g: RoadGraph, p: Record<string, number>): void {
  const ts = new Set<number>();
  for (let i = 0; i < p.ramps; i++) if (!p[`r${i}ford`]) ts.add(p[`r${i}node`]);
  for (let i = 0; i < p.ramps; i++) {
    if (p[`r${i}ford`]) continue;
    const ax = p[`r${i}ax`];
    const az = p[`r${i}az`];
    const ux = p[`r${i}ux`];
    const uz = p[`r${i}uz`];
    const T = g.nodes[p[`r${i}node`]];
    const room: Record<number, number> = { 1: MOUTH_ROOM, [-1]: MOUTH_ROOM };
    for (const eid of T.edges) {
      const e = g.edges[eid];
      if (isChannelEdge(e)) continue;
      const n = g.nodes[otherNode(e, T.id)];
      const lat = -(n.x - ax) * uz + (n.z - az) * ux;
      const sd = lat >= 0 ? 1 : -1;
      const len = sqrt((n.x - T.x) ** 2 + (n.z - T.z) ** 2) || 1;
      let corridor = 0;
      if (ts.has(n.id)) corridor = Math.abs(lat) / 2;
      else
        for (const oid of n.edges) {
          if (oid === eid) continue;
          const o = g.edges[oid];
          const m = g.nodes[otherNode(o, n.id)];
          const ol = sqrt((m.x - n.x) ** 2 + (m.z - n.z) ** 2) || 1;
          // A street across the bank street (not its continuation) takes its half width and sidewalk.
          if (Math.abs(((m.x - n.x) * (n.x - T.x) + (m.z - n.z) * (n.z - T.z)) / (ol * len)) < 0.7) corridor = Math.max(corridor, o.width / 2 + o.sidewalk);
        }
      room[sd] = Math.min(room[sd], Math.abs(lat) - corridor);
    }
    const hw = p[`r${i}hw`];
    p[`r${i}rmL`] = room[1];
    p[`r${i}rmR`] = room[-1];
    p[`r${i}flL`] = Math.min(CFG.mouthFlare, Math.max(0, room[1] - hw - CFG.mouthBody - MOUTH_MARGIN));
    p[`r${i}flR`] = Math.min(CFG.mouthFlare, Math.max(0, room[-1] - hw - CFG.mouthBody - MOUTH_MARGIN));
  }
}
