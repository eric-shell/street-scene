/**
 * The inside of an open-air parking lot: a pure function of the lot's area (its convex polygon and the
 * numbers planned into `params`, see plan.ts), so the sim (parked cars, the drift zone), the district
 * build (walls, props), the renderer (paint, fence, furniture) and the tests all read one lot.
 *
 * The lot has a frame of its own: `u` along the street side it fronts (the longest straight one, the
 * origin at its start), `w` into the block (the block is on the right of travel of the block ring, so
 * w = (u.z, -u.x)). Along w, from the street:
 *  - the forecourt (PARKING_LOT.forecourt deep): open asphalt behind the entrance and exit cuts, with
 *    the booth island between them; where the apron is wide enough to slide on (the drift zone);
 *  - bay rows: a double row (two bays deep, back to back, a tree island every islandEvery bays), then a
 *    drive aisle, then the next, the cars nosing in from the aisle they face; the last row is single
 *    against the back when only that much is left;
 *  - the back: a strip lot ends on the fence its buildings stand behind (a service strip with the
 *    dumpsters and cart corrals along it), a whole-block lot keeps a lane on every side of the bays.
 * Bays stand PARKING_LOT.lane + the fence in from every fence, so the field is ringed by a drivable
 * lane that every aisle opens into: there is no dead end for a racer to be trapped in. The fence round the
 * street edges has a gap at each curb cut (the cuts are planned with the street's own curb frame,
 * busBays.ts mouthBay) and none elsewhere: the fence is solid on both sides (Wall.solid), so a car never
 * leaves the lot except through a cut.
 *
 * Parked cars are the bays at the lot's occupancy, in their own random stream: kinds from the lot mix,
 * nose in (most) or backed in, a little yaw and sideways jitter, each held to its bay by its true body
 * length against the back line. They become sim bodies through city/parking.ts (planParking), which is why
 * the layout lives in the city and not in the renderer.
 */
import { PARKING_LOT as C } from '../../config';
import { type Vec2, atan2, sqrt, yawOf } from '../../../sim/math';
import { Rng, deriveSeed } from '../../../sim/prng';
import type { Area } from '../types';

/** A lot's frame: origin on its front street side, `u` along it, `w` into the block. */
export interface LotFrame {
  o: Vec2;
  u: Vec2;
  w: Vec2;
}

/** A curb cut of a lot: where on which polygon edge, and the street's own curb frame for it (mouthBay). */
export interface LotCut {
  /** Index of the polygon edge it is in (polygon[i] -> polygon[i + 1]) and its middle along that edge (m from polygon[i]). */
  edge: number;
  t: number;
  /** Half the width at full depth (m): the fence has a gap this wide. */
  hw: number;
  /** The road edge, its block side (1: P side) and the curb cut along that side's curb (s0..s1, flared over `taper`; busBays.ts). */
  road: number;
  side: 1 | -1;
  s0: number;
  s1: number;
  taper: number;
}

/** An axis aligned rectangle in the lot's frame (m). */
export interface LotRect {
  u0: number;
  u1: number;
  w0: number;
  w1: number;
}

/** One row of bays: bays side by side along u over [w0, w1], their open side toward `open` (-1: toward smaller w). */
export interface LotRow extends LotRect {
  open: 1 | -1;
  /** Bay count (islands included) and the first bay's start along u. */
  n: number;
  ub: number;
  /** Row of the pair (a double row's two rows share one number) and whether this is a single row. */
  pair: number;
}

export interface LotBay {
  x: number;
  z: number;
  /** Heading a car nosing in has (rad, three.js yaw: forward is (sin, cos)). */
  yaw: number;
  /** Centre in the lot frame (m). */
  u: number;
  w: number;
  row: number;
  /** The bay holds a parked car; false: free, or an island. */
  taken: boolean;
}

export interface LotCar {
  x: number;
  z: number;
  yaw: number;
  /** drivingParams.json traffic.kinds name. */
  kind: string;
  /** Index into LotLayout.bays. */
  bay: number;
}

/** A piece of fence: a segment of a polygon edge and its inward unit normal; the solid is `thickness` deep inward. */
export interface LotFencePiece {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
  edge: number;
}

export interface LotLayout {
  frame: LotFrame;
  /** Depth of the lot along w (m): to the back fence of a strip, to the far side of a whole block. */
  depth: number;
  /** The polygon in the frame (u, w as x, z). */
  uv: Vec2[];
  rows: LotRow[];
  bays: LotBay[];
  cars: LotCar[];
  /** Drive aisles between the rows, in the frame. */
  aisles: LotRect[];
  /** Planted tree islands (frame rect, tree trunk centre) and the lamp posts on them and along the fences (world). */
  islands: { rect: LotRect; x: number; z: number; lamp: Vec2 | null }[];
  lamps: Vec2[];
  /** Booth island: its world polygon and the booth's centre and yaw (rad); null without an entrance and exit pair. */
  booth: { island: Vec2[]; x: number; z: number; yaw: number } | null;
  fences: LotFencePiece[];
  /** The service edge's furniture: dumpsters and bags (world, with a yaw), cart corrals (world polygon, yaw along the edge). */
  dumpsters: { x: number; z: number; yaw: number }[];
  bags: { x: number; z: number; yaw: number }[];
  corrals: { poly: Vec2[]; x: number; z: number; yaw: number }[];
  /** The forecourt's drift zone (frame rect). */
  zone: LotRect | null;
}

const cache = new WeakMap<Area, LotLayout>();

export function lotFrame(a: Area): LotFrame {
  const P = a.params;
  return { o: { x: P.fox, z: P.foz }, u: { x: P.fux, z: P.fuz }, w: { x: P.fwx, z: P.fwz } };
}

/** The curb cuts of a lot, entrance and exit first when it has the pair (params.pair). */
export function lotCuts(a: Area): LotCut[] {
  const P = a.params;
  const out: LotCut[] = [];
  for (let i = 0; i < P.cuts; i++) {
    out.push({ edge: P[`c${i}e`], t: P[`c${i}t`], hw: P[`c${i}h`], road: P[`c${i}r`], side: P[`c${i}d`] > 0 ? 1 : -1, s0: P[`c${i}a`], s1: P[`c${i}b`], taper: P[`c${i}f`] });
  }
  return out;
}

/** The drift zone's outline, a rectangle on the forecourt (params ox.. lw, the frame the zone markings read), or null. */
export function lotZone(a: Area): Vec2[] | null {
  const P = a.params;
  if (!(P.lu > 0) || !(P.lw > 0)) return null;
  const o = { x: P.ox, z: P.oz };
  const u = { x: P.ux, z: P.uz };
  const w = { x: P.wx, z: P.wz };
  return [
    { x: o.x, z: o.z },
    { x: o.x + u.x * P.lu, z: o.z + u.z * P.lu },
    { x: o.x + u.x * P.lu + w.x * P.lw, z: o.z + u.z * P.lu + w.z * P.lw },
    { x: o.x + w.x * P.lw, z: o.z + w.z * P.lw },
  ];
}

/** Point of the lot frame in the world. */
export function lotPoint(f: LotFrame, u: number, w: number): Vec2 {
  return { x: f.o.x + f.u.x * u + f.w.x * w, z: f.o.z + f.u.z * u + f.w.z * w };
}

/** [lo, hi] of the polygon's chord along u at depth w (frame coordinates); lo > hi when the line misses it. */
export function lotChord(uv: readonly Vec2[], w: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < uv.length; i++) {
    const p = uv[i];
    const q = uv[(i + 1) % uv.length];
    if ((p.z - w) * (q.z - w) > 0 || p.z === q.z) continue;
    const u = p.x + ((q.x - p.x) * (w - p.z)) / (q.z - p.z);
    lo = Math.min(lo, u);
    hi = Math.max(hi, u);
  }
  return [lo, hi];
}

/** The lot's layout (cached per area). */
export function lotLayout(a: Area): LotLayout {
  let l = cache.get(a);
  if (!l) cache.set(a, (l = buildLayout(a)));
  return l;
}

function pick<T extends { share: number }>(rng: Rng, items: readonly T[], total: number): T {
  let r = rng.next() * total;
  for (const it of items) {
    r -= it.share;
    if (r < 0) return it;
  }
  return items[items.length - 1];
}

function buildLayout(a: Area): LotLayout {
  const P = a.params;
  const frame = lotFrame(a);
  const rng = new Rng(deriveSeed(P.seed, 'lot'));
  const poly = a.polygon;
  const n = poly.length;
  const uv = poly.map((p) => ({ x: (p.x - frame.o.x) * frame.u.x + (p.z - frame.o.z) * frame.u.z, z: (p.x - frame.o.x) * frame.w.x + (p.z - frame.o.z) * frame.w.z }));
  const depth = P.depth;
  const strip = P.strip > 0;
  const cuts = lotCuts(a);
  const F = C.fence.thickness;
  const W = (u: number, w: number) => lotPoint(frame, u, w);

  // ---------- Fence pieces: every polygon edge less the curb cuts' gaps. ----------
  const fences: LotFencePiece[] = [];
  const edges: { p: Vec2; d: Vec2; len: number; n: Vec2 }[] = [];
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / n;
    cz += p.z / n;
  }
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    const d = len > 1e-9 ? { x: (q.x - p.x) / len, z: (q.z - p.z) / len } : { x: 1, z: 0 };
    // Inward: the side the lot's middle is on.
    let nx = d.z;
    let nz = -d.x;
    if ((cx - p.x) * nx + (cz - p.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    edges.push({ p, d, len, n: { x: nx, z: nz } });
    if (len < 0.3) continue;
    const gaps = cuts.filter((c) => c.edge === i).map((c) => [c.t - c.hw, c.t + c.hw] as [number, number]).sort((s, t) => s[0] - t[0]);
    const spans: [number, number][] = [];
    let at = 0;
    for (const g of gaps) {
      if (g[0] > at + 0.05) spans.push([at, g[0]]);
      at = Math.max(at, g[1]);
    }
    if (at < len - 0.05) spans.push([at, len]);
    for (const [s0, s1] of spans) {
      const k = Math.max(1, Math.ceil((s1 - s0) / C.fence.piece));
      for (let j = 0; j < k; j++) {
        const t0 = s0 + ((s1 - s0) * j) / k;
        const t1 = s0 + ((s1 - s0) * (j + 1)) / k;
        fences.push({ ax: p.x + d.x * t0, az: p.z + d.z * t0, bx: p.x + d.x * t1, bz: p.z + d.z * t1, nx, nz, edge: i });
      }
    }
  }

  // ---------- Rows of bays. ----------
  const inset = C.lane + F + 0.9;
  const wEnd = strip ? depth - F - C.serviceStrip : depth - F - C.lane - 0.4;
  const rows: LotRow[] = [];
  const aisles: LotRect[] = [];
  const bd = C.bayDepth;
  const addRow = (w0: number, w1: number, open: 1 | -1, pair: number, lo: number, hi: number): LotRow | null => {
    const k = Math.floor((hi - lo) / C.bayWidth);
    if (k < 3) return null;
    const row: LotRow = { u0: lo, u1: hi, w0, w1, open, n: k, ub: (lo + hi) / 2 - (k * C.bayWidth) / 2, pair };
    rows.push(row);
    return row;
  };
  const span = (w0: number, w1: number): [number, number] => {
    const c0 = lotChord(uv, w0);
    const c1 = lotChord(uv, w1);
    return [Math.max(c0[0], c1[0]) + inset, Math.min(c0[1], c1[1]) - inset];
  };
  let w: number = C.forecourt;
  let pairs = 0;
  for (let guard = 0; guard < 12; guard++) {
    const room = wEnd - w;
    if (room >= 2 * bd) {
      const [lo, hi] = span(w, w + 2 * bd);
      const r1 = addRow(w, w + bd, -1, pairs, lo, hi);
      const r2 = addRow(w + bd, w + 2 * bd, 1, pairs, lo, hi);
      if (r1 || r2) pairs++;
      const aisleEnd = w + 2 * bd + C.aisle;
      if (room >= 2 * bd + C.aisle) {
        aisles.push({ u0: lo - C.lane, u1: hi + C.lane, w0: w + 2 * bd, w1: aisleEnd });
        w = aisleEnd;
        continue;
      }
      break;
    }
    if (room >= bd) {
      const [lo, hi] = span(w, w + bd);
      addRow(w, w + bd, -1, pairs, lo, hi);
    }
    break;
  }

  // ---------- Bays, tree islands, lamps. ----------
  const bays: LotBay[] = [];
  const islands: LotLayout['islands'] = [];
  const lamps: Vec2[] = [];
  const islandCols = new Map<number, Set<number>>();
  rows.forEach((row, ri) => {
    const dbl = rows.some((o) => o !== row && o.pair === row.pair);
    let cols = islandCols.get(row.pair);
    if (!cols) {
      cols = new Set<number>();
      if (dbl) for (let k = C.islandEvery - 1; k < row.n - 2; k += C.islandEvery) cols.add(k);
      islandCols.set(row.pair, cols);
    }
    for (let k = 0; k < row.n; k++) {
      const u = row.ub + (k + 0.5) * C.bayWidth;
      const wc = (row.w0 + row.w1) / 2;
      const p = W(u, wc);
      // Nose in: the car heads toward the back line, away from the open side.
      const hw = frame.w;
      const sgn = -row.open;
      bays.push({ x: p.x, z: p.z, yaw: yawOf(hw.x * sgn, hw.z * sgn), u, w: wc, row: ri, taken: false });
    }
  });
  // Islands once per double row (on its first row): the strip across both rows.
  const doneIsland = new Set<number>();
  rows.forEach((row) => {
    const cols = islandCols.get(row.pair);
    if (!cols || doneIsland.has(row.pair)) return;
    doneIsland.add(row.pair);
    const mate = rows.find((o) => o !== row && o.pair === row.pair);
    if (!mate) return;
    const w0 = Math.min(row.w0, mate.w0);
    const w1 = Math.max(row.w1, mate.w1);
    let j = 0;
    for (const k of [...cols].sort((s, t) => s - t)) {
      const u = row.ub + (k + 0.5) * C.bayWidth;
      const rect = { u0: u - C.bayWidth / 2, u1: u + C.bayWidth / 2, w0, w1 };
      const tree = W(u, w0 + bd * 0.5);
      const lamp = j % 2 === 0 ? W(u, w0 + bd * 1.5) : null;
      islands.push({ rect, x: tree.x, z: tree.z, lamp });
      if (lamp) lamps.push(lamp);
      j++;
    }
  });
  const isIsland = (bay: LotBay, row: LotRow): boolean => {
    const cols = islandCols.get(row.pair);
    if (!cols) return false;
    const k = Math.round((bay.u - row.ub - C.bayWidth / 2) / C.bayWidth);
    return cols.has(k) && rows.some((o) => o !== row && o.pair === row.pair);
  };

  // ---------- Cars. ----------
  const cars: LotCar[] = [];
  const occ = P.occ;
  let total = 0;
  for (const k of C.kinds) total += k.share;
  const taken = new Set<number>();
  for (let bi = 0; bi < bays.length; bi++) {
    const bay = bays[bi];
    const row = rows[bay.row];
    // Every draw is made whether or not the bay is used, so a bay's car does not depend on its neighbours'.
    const roll = rng.next();
    const kind = pick(rng, C.kinds, total);
    const back = rng.next() < C.backIn;
    const dyaw = (rng.next() * 2 - 1) * C.yawJitter;
    const du = (rng.next() * 2 - 1) * C.sideJitter;
    if (isIsland(bay, row) || roll >= occ) continue;
    taken.add(bi);
    bay.taken = true;
    // Rear (or nose, backed in) against the back line, its true length from there.
    const backLine = row.open === -1 ? row.w1 : row.w0;
    const wc = backLine + row.open * (C.backGap + kind.halfLength);
    const yaw = bay.yaw + (back ? Math.PI : 0) + dyaw;
    const p = W(bay.u + du, wc);
    cars.push({ x: p.x, z: p.z, yaw, kind: kind.name, bay: bi });
  }

  // ---------- Booth island between the entrance and the exit. ----------
  let booth: LotLayout['booth'] = null;
  if (P.pair > 0 && cuts.length >= 2 && cuts[0].edge === cuts[1].edge) {
    const e = edges[cuts[0].edge];
    const mid = (cuts[0].t + cuts[1].t) / 2;
    // On the frame's front edge, t is u: the island lies along w from just inside the fence.
    const hwI = C.island.width / 2;
    const w0 = F + 0.1;
    const w1 = w0 + C.island.length;
    const o = { x: e.p.x + e.d.x * mid, z: e.p.z + e.d.z * mid };
    const nrm = e.n;
    const poly4: Vec2[] = [
      { x: o.x - e.d.x * hwI + nrm.x * w0, z: o.z - e.d.z * hwI + nrm.z * w0 },
      { x: o.x + e.d.x * hwI + nrm.x * w0, z: o.z + e.d.z * hwI + nrm.z * w0 },
      { x: o.x + e.d.x * hwI + nrm.x * w1, z: o.z + e.d.z * hwI + nrm.z * w1 },
      { x: o.x - e.d.x * hwI + nrm.x * w1, z: o.z - e.d.z * hwI + nrm.z * w1 },
    ];
    const mc = { x: o.x + nrm.x * (w0 + C.island.length * 0.45), z: o.z + nrm.z * (w0 + C.island.length * 0.45) };
    booth = { island: poly4, x: mc.x, z: mc.z, yaw: atan2(e.d.x, e.d.z) };
  }

  // ---------- Service edge: dumpsters, bags, cart corrals. ----------
  const dumpsters: LotLayout['dumpsters'] = [];
  const bags: LotLayout['bags'] = [];
  const corrals: LotLayout['corrals'] = [];
  const busy: { x: number; z: number; r: number }[] = [];
  let svc = -1;
  if (strip && P.back >= 0) svc = P.back;
  else {
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (i === P.aEdge || cuts.some((c) => c.edge === i)) continue;
      if (edges[i].len > best) {
        best = edges[i].len;
        svc = i;
      }
    }
  }
  if (svc >= 0 && edges[svc].len >= 24) {
    const e = edges[svc];
    const nd = 2 + rng.int(0, 1);
    const nc = 1 + rng.int(0, 1);
    const items: ('d' | 'c')[] = [];
    for (let i = 0; i < nd; i++) items.push('d');
    for (let i = 0; i < nc; i++) items.push('c');
    for (let i = items.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [items[i], items[j]] = [items[j], items[i]];
    }
    let t = 5 + rng.range(0, 6);
    const yawIn = yawOf(e.n.x, e.n.z);
    for (const it of items) {
      const half = it === 'c' ? C.corral.length / 2 : 1.3;
      if (t + half * 2 > e.len - 5) break;
      const tc = t + half;
      const off = F + (it === 'c' ? C.corral.width / 2 + 0.4 : 1.5);
      const x = e.p.x + e.d.x * tc + e.n.x * off;
      const z = e.p.z + e.d.z * tc + e.n.z * off;
      if (it === 'd') {
        dumpsters.push({ x, z, yaw: yawIn });
        busy.push({ x, z, r: 3 });
        const nb = rng.int(1, 2);
        for (let b = 0; b < nb; b++) {
          const bt = tc + (b === 0 ? 1.9 : -1.9) * (rng.next() < 0.5 ? 1 : -1);
          bags.push({ x: e.p.x + e.d.x * bt + e.n.x * (F + 0.6 + rng.range(0, 0.5)), z: e.p.z + e.d.z * bt + e.n.z * (F + 0.6 + rng.range(0, 0.5)), yaw: rng.range(0, 6.28) });
        }
      } else {
        const hl = C.corral.length / 2;
        const hwC = C.corral.width / 2;
        const poly4: Vec2[] = [
          { x: x - e.d.x * hl - e.n.x * hwC, z: z - e.d.z * hl - e.n.z * hwC },
          { x: x + e.d.x * hl - e.n.x * hwC, z: z + e.d.z * hl - e.n.z * hwC },
          { x: x + e.d.x * hl + e.n.x * hwC, z: z + e.d.z * hl + e.n.z * hwC },
          { x: x - e.d.x * hl + e.n.x * hwC, z: z - e.d.z * hl + e.n.z * hwC },
        ];
        corrals.push({ poly: poly4, x, z, yaw: atan2(e.d.x, e.d.z) });
        busy.push({ x, z, r: 4 });
      }
      t += half * 2 + rng.range(1.5, 6);
    }
  }

  // ---------- Lamps along the fences. ----------
  if (booth) busy.push({ x: booth.x, z: booth.z, r: 4 });
  for (let i = 0; i < n; i++) {
    const e = edges[i];
    if (e.len < 16) continue;
    const k = Math.floor((e.len - 12) / C.lampSpacing) + 1;
    for (let j = 0; j < k; j++) {
      const t = e.len / 2 + (j - (k - 1) / 2) * C.lampSpacing;
      if (t < 5 || t > e.len - 5) continue;
      if (cuts.some((c) => c.edge === i && Math.abs(c.t - t) < c.hw + C.lampCutClear)) continue;
      const x = e.p.x + e.d.x * t + e.n.x * (F + C.lampInset);
      const z = e.p.z + e.d.z * t + e.n.z * (F + C.lampInset);
      if (busy.some((b) => (b.x - x) ** 2 + (b.z - z) ** 2 < b.r * b.r)) continue;
      lamps.push({ x, z });
    }
  }

  // ---------- The forecourt's drift zone. ----------
  let zone: LotRect | null = null;
  if (P.lu > 0 && P.lw > 0) {
    const o = { x: P.ox, z: P.oz };
    const u0 = (o.x - frame.o.x) * frame.u.x + (o.z - frame.o.z) * frame.u.z;
    const w0 = (o.x - frame.o.x) * frame.w.x + (o.z - frame.o.z) * frame.w.z;
    zone = { u0, u1: u0 + P.lu, w0, w1: w0 + P.lw };
  }

  return { frame, depth, uv, rows, bays, cars, aisles, islands, lamps, booth, fences, dumpsters, bags, corrals, zone };
}
