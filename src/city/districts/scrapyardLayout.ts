/**
 * The inside of a scrapyard: a pure function of the area (its block polygon and the numbers planned into `params`,
 * see scrapyardPlan.ts), so the sim (heights, walls, drift zone, gates), the district build, the renderer and the
 * tests all read one yard.
 *
 * The yard has a frame of its own: a rectangle of `L` x `D` m inside the block, `u` along its length, `w` across it,
 * origin at the corner (fitted by the planner, perimeter m clear of the fence all round: the safe line round the yard).
 * Along w, from the front:
 *  - the bowls: two banked rings (banking.ts) of crest radius R, rims tangent at the neck u = 2 rimR, centres at
 *    (rimR, rimR) and (3 rimR, rimR), so they fill w in [0, S], S = 2 rimR. Each has a ring of stacks in its middle
 *    (the island), so a bowl is a ring road and not a plate;
 *  - the pit lane across the bowls' back edge, with the crusher's body beside the pit and the magnet crane's base
 *    further along: the pit is a shallow dip at u = canyon, w in [S, S + pit.length], and past it (w = S + kicker.lipFrom)
 *    the kicker's lip;
 *  - the back canyon, along w from the lip to the back lane: two walls of stacks (each two deep) with an aisle between,
 *    the kicker at its front end, the timed press across it (sim/gates.ts, world.ts) and tyre stacks and drums in it. It
 *    stands `canyon.offset` rims off the neck, so the jump from its kicker over the pit lands on the far bowl's bank;
 *  - open fill rows of double stacks (aisles between) either side of the canyon, and the floodlight towers at the corners.
 * The fence follows the block polygon with a gap at each curb cut (the street's own curb frame, busBays.ts mouthBay), a
 * solid post each side of the gap.
 */
import { CITY } from '../config';
import { type Vec2, atan2, cos, sin, sqrt } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { DistrictPropSpec } from '../props';
import { type BankedRing, tangentRings } from './banking';
import type { Area } from './types';

const C = CITY.districts.scrapyard;

/** A yard's frame: origin at the rectangle's corner, `u` along its length, `w` across. */
export interface YardFrame {
  o: Vec2;
  u: Vec2;
  w: Vec2;
}

/** A curb cut of the yard (the lot's form): which polygon edge and where, and the street's own curb frame for it. */
export interface YardCut {
  /** Index of the polygon edge (polygon[i] -> polygon[i + 1]) and the cut's middle along it (m from polygon[i]). */
  edge: number;
  t: number;
  /** Half the width at full depth (m): the fence has a gap this wide. */
  hw: number;
  /** The road edge, its block side (1: P side) and the cut along that side's curb (s0..s1, flared over `taper`; busBays.ts). */
  road: number;
  side: 1 | -1;
  s0: number;
  s1: number;
  taper: number;
}

/** A stack of crushed cars: an oriented box, its footprint and how many cars high. */
export interface ScrapStack {
  x: number;
  z: number;
  /** Unit axis along its length. */
  ax: number;
  az: number;
  length: number;
  depth: number;
  /** Cars high (1-3). */
  tiers: number;
  kind: 'island' | 'canyon' | 'row';
  /** The four corners (world). */
  poly: Vec2[];
}

/** A piece of fence: a segment of a polygon edge and its inward unit normal; the solid is `thickness` deep inward. */
export interface YardFencePiece {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
  edge: number;
}

/** A solid machine or post: an oriented box footprint (world corners) and its centre. */
export interface YardSolid {
  x: number;
  z: number;
  poly: Vec2[];
}

export interface ScrapLayout {
  frame: YardFrame;
  /** Rectangle size (m) and the bowls' crest radius (m). */
  L: number;
  D: number;
  R: number;
  rimR: number;
  /** The two banked bowls, then the figure eight's middle (the neck). */
  rings: [BankedRing, BankedRing];
  neck: Vec2;
  /** The canyon: its centre line's u, the lip's w, the far end's w, the press's w, and its stack count. */
  canyon: { u: number; lip: number; end: number; press: number; stacks: number };
  stacks: ScrapStack[];
  fences: YardFencePiece[];
  /** Solid gate posts either side of every cut. */
  posts: YardSolid[];
  /** The crusher body, the crane's base and the four tower bases. */
  crusher: YardSolid & { yaw: number };
  crane: YardSolid & { boom: Vec2 };
  /** The conveyor's two legs (solids): it runs from the crusher's far end out along -u on them, 2 m or more over the ground. */
  conveyor: YardSolid[];
  towers: YardSolid[];
  /** The kicker, pit and press in the world: kicker centre line from its foot to the lip, pit centre, the press gate's line (a to b, normal toward the canyon's entrance). */
  kicker: { foot: Vec2; lip: Vec2; dir: Vec2 };
  pit: Vec2;
  press: { a: Vec2; b: Vec2; nx: number; nz: number };
  /** Clutter (render spawns the props; the district build asks the city for them). */
  clutter: DistrictPropSpec[];
}

/** The yard's curb cuts (params c<i>e ... c<i>f, ncut). */
export function yardCuts(a: Area): YardCut[] {
  const P = a.params;
  const out: YardCut[] = [];
  for (let i = 0; i < P.cuts; i++) out.push({ edge: P[`c${i}e`], t: P[`c${i}t`], hw: P[`c${i}h`], road: P[`c${i}r`], side: P[`c${i}d`] > 0 ? 1 : -1, s0: P[`c${i}a`], s1: P[`c${i}b`], taper: P[`c${i}f`] });
  return out;
}

export function yardFrame(a: Area): YardFrame {
  const P = a.params;
  return { o: { x: P.ox, z: P.oz }, u: { x: P.ux, z: P.uz }, w: { x: P.wx, z: P.wz } };
}

/** Point of the yard frame in the world. */
export function yardPoint(f: YardFrame, u: number, w: number): Vec2 {
  return { x: f.o.x + f.u.x * u + f.w.x * w, z: f.o.z + f.u.z * u + f.w.z * w };
}

/** Rim radius, the bowls' span S = 2 rimR, the rectangle's length L = 4 rimR and the canyon's u for a crest radius. */
export function yardDims(R: number): { rimR: number; S: number; L: number; canyonU: number } {
  const rimR = R + C.bank.rimWidth;
  return { rimR, S: 2 * rimR, L: 4 * rimR, canyonU: 2 * rimR + C.canyon.offset * rimR };
}

/** The rectangle's depth D (m) for a crest radius and a canyon stack count: from the bowls' span to the canyon's far end. */
export function yardDepth(R: number, stacks: number): number {
  return yardDims(R).S + C.kicker.lipFrom + stacks * (C.stack.length + C.stack.gap);
}

/** The canyon's stack count the plan picked for each crest radius (CITY.districts.scrapyard.canyon.stacks, same order as crestRadii). */
export function canyonStacks(R: number): number {
  const i = C.crestRadii.indexOf(R as never);
  return C.canyon.stacks[Math.max(0, i)];
}

/** The drift zone's outline: a stadium round both bowls (crest radius), the neck between. */
export function yardZone(a: Area): Vec2[] | null {
  if (!(a.params.R > 0)) return null;
  const f = yardFrame(a);
  const d = yardDims(a.params.R);
  const out: Vec2[] = [];
  const n = 14;
  // Left half circle round bowl A from the front (w = rimR - R) round to the back, then B's right half back.
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 - (i / n) * Math.PI;
    out.push(yardPoint(f, d.rimR + cos(t) * a.params.R, d.rimR + sin(t) * a.params.R));
  }
  for (let i = 0; i <= n; i++) {
    const t = Math.PI / 2 - (i / n) * Math.PI;
    out.push(yardPoint(f, 3 * d.rimR + cos(t) * a.params.R, d.rimR + sin(t) * a.params.R));
  }
  return out;
}

const cache = new WeakMap<Area, ScrapLayout>();

/** The yard's layout (cached per area). */
export function scrapLayout(a: Area): ScrapLayout {
  let l = cache.get(a);
  if (!l) cache.set(a, (l = buildLayout(a)));
  return l;
}

function box(cx: number, cz: number, ax: number, az: number, length: number, depth: number): Vec2[] {
  const hx = length / 2;
  const hz = depth / 2;
  const bx = -az;
  const bz = ax;
  return [
    { x: cx - ax * hx - bx * hz, z: cz - az * hx - bz * hz },
    { x: cx + ax * hx - bx * hz, z: cz + az * hx - bz * hz },
    { x: cx + ax * hx + bx * hz, z: cz + az * hx + bz * hz },
    { x: cx - ax * hx + bx * hz, z: cz - az * hx + bz * hz },
  ];
}

function buildLayout(a: Area): ScrapLayout {
  const P = a.params;
  const frame = yardFrame(a);
  const rng = new Rng(deriveSeed(P.seed, 'scrapyard:layout'));
  const W = (u: number, w: number) => yardPoint(frame, u, w);
  const R = P.R;
  const { rimR, S, L, canyonU } = yardDims(R);
  const D = P.D;
  const n = P.n;
  const K = C.kicker;
  const St = C.stack;
  const pitch = St.length + St.gap;
  const lipW = S + K.lipFrom;
  const endW = lipW + n * pitch;
  const pressW = lipW + K.run + C.press.pressFrom;
  const neck = W(2 * rimR, rimR);
  const rings = tangentRings(neck.x, neck.z, frame.u.x, frame.u.z, R, C.bank);
  const stacks: ScrapStack[] = [];
  const addStack = (u: number, w: number, alongU: boolean, tiers: number, kind: ScrapStack['kind']) => {
    const c = W(u, w);
    const ax = alongU ? frame.u.x : frame.w.x;
    const az = alongU ? frame.u.z : frame.w.z;
    stacks.push({ x: c.x, z: c.z, ax, az, length: St.length, depth: St.depth, tiers, kind, poly: box(c.x, c.z, ax, az, St.length, St.depth) });
  };
  const tiers = () => (rng.chance(0.18) ? 1 : rng.chance(0.5) ? 2 : 3);

  // The bowls' islands: stacks standing tangent round a ring, so the middle of a bowl is a block and the way round it a ring road.
  const I = C.island;
  for (const ctr of [{ u: rimR, w: rimR }, { u: 3 * rimR, w: rimR }]) {
    const phase = rng.next() * Math.PI * 2;
    for (let k = 0; k < I.count; k++) {
      const ang = phase + (k / I.count) * Math.PI * 2;
      const c = W(ctr.u + cos(ang) * I.radius, ctr.w + sin(ang) * I.radius);
      // Tangent axis: perpendicular to the radius, in the world through the frame.
      const rx = frame.u.x * cos(ang) + frame.w.x * sin(ang);
      const rz = frame.u.z * cos(ang) + frame.w.z * sin(ang);
      stacks.push({ x: c.x, z: c.z, ax: -rz, az: rx, length: St.length, depth: St.depth, tiers: 3 - (k % 2), kind: 'island', poly: box(c.x, c.z, -rz, rx, St.length, St.depth) });
    }
  }

  // The canyon: two walls each two stacks deep, the aisle between, from the kicker's lip back to the back lane.
  const half = C.canyon.aisle / 2;
  for (let k = 0; k < n; k++) {
    const w = lipW + (k + 0.5) * pitch;
    for (const side of [-1, 1]) for (let j = 0; j < 2; j++) addStack(canyonU + side * (half + St.depth * (j + 0.5)), w, false, tiers(), 'canyon');
  }

  // Open fill rows: double rows of stacks along u with aisles between, either side of the canyon.
  const wallOut = half + 2 * St.depth;
  const zones: [number, number][] = [
    [0.5, canyonU - wallOut - C.rows.aisle],
    [canyonU + wallOut + C.rows.aisle, L - 0.5],
  ];
  for (let row = 0; ; row++) {
    const w0 = S + C.rows.startFrom + row * (2 * St.depth + C.rows.aisle);
    if (w0 + 2 * St.depth > endW + 0.01) break;
    for (const [z0, z1] of zones) {
      const count = Math.floor((z1 - z0 + St.gap) / pitch);
      if (count < 1) continue;
      const lead = (z1 - z0 - (count * pitch - St.gap)) / 2;
      for (let k = 0; k < count; k++) {
        const u = z0 + lead + St.length / 2 + k * pitch;
        for (let j = 0; j < 2; j++) if (!rng.chance(C.rows.skip)) addStack(u, w0 + St.depth * (j + 0.5), true, tiers(), 'row');
      }
    }
  }

  // Solids: the crusher beside the pit, the crane's base up the lane from it, the floodlight towers.
  const solid = (u: number, w: number, len: number, dep: number): YardSolid => {
    const c = W(u, w);
    return { x: c.x, z: c.z, poly: box(c.x, c.z, frame.u.x, frame.u.z, len, dep) };
  };
  const Cr = C.crusher;
  const crusherU = canyonU - C.pit.halfWidth - 1.5 - Cr.length / 2;
  const crusherW = S + 1.5 + Cr.depth / 2;
  const crusher = { ...solid(crusherU, crusherW, Cr.length, Cr.depth), yaw: atan2(frame.u.x, frame.u.z) };
  const conveyor = [0.35, 0.95].map((t) => solid(crusherU - Cr.length / 2 - 0.2 - t * 11, crusherW, 0.7, 0.7));
  const craneU = Math.max(6, crusherU - 22);
  const craneBase = solid(craneU, S + 8, 3, 3);
  const boom = W(craneU + 20, S + 8);
  const crane = { ...craneBase, boom };
  const T = C.tower;
  const towers = [
    solid(T.inset, T.inset, T.base, T.base),
    solid(L - T.inset, T.inset, T.base, T.base),
    solid(T.inset, D - T.inset, T.base, T.base),
    solid(L - T.inset, D - T.inset, T.base, T.base),
  ];

  // Clutter. Everything keeps off the stacks and the solids, and out of the gate and the kicker.
  const keepOff = (x: number, z: number, r: number): boolean => {
    for (const s of stacks) {
      const dx = x - s.x;
      const dz = z - s.z;
      const along = dx * s.ax + dz * s.az;
      const across = -dx * s.az + dz * s.ax;
      if (Math.abs(along) < s.length / 2 + r + 0.4 && Math.abs(across) < s.depth / 2 + r + 0.4) return false;
    }
    for (const s of [crusher, crane, ...conveyor, ...towers]) {
      if (Math.hypot(x - s.x, z - s.z) < 4 + r) return false;
    }
    return true;
  };
  const clutter: DistrictPropSpec[] = [];
  const put = (kind: DistrictPropSpec['kind'], u: number, w: number, yaw = rng.next() * 6.28, r = 0.6): void => {
    const p = W(u, w);
    if (keepOff(p.x, p.z, r)) clutter.push({ kind, x: p.x, z: p.z, yaw, lift: 0, area: a.id });
  };
  // The risky line: tyre stacks, drums and crates staggered down the canyon past the press, a clear gap always (the aisle is 5 m).
  const mix = ['tyreStack', 'drum', 'tyreStack', 'crate', 'drum', 'tyreStack'] as const;
  for (let i = 0, w = pressW + 2.2; w < endW - 1; i++, w += 3.1) {
    const side = i % 2 ? 1 : -1;
    put(mix[i % mix.length], canyonU + side * rng.range(0.8, 1.3), w);
    if (rng.chance(0.5)) put('tyreStack', canyonU - side * 1.6, w + 1.4);
  }
  // Tyre walls: a row of stacks along the front of each bowl's outer rim, guarding the yard's front from the perimeter aisle.
  for (const ctr of [rimR, 3 * rimR]) {
    for (let k = -4; k <= 4; k++) {
      const ang = (k / 4) * 0.55;
      put('tyreStack', ctr + sin(ang) * (rimR + 1), rimR - cos(ang) * (rimR + 1), 0, 0.5);
    }
  }
  // Pit lane: pallets and a cable spool by the crusher, drums and bags by the crane and along the fill rows' ends.
  put('cableSpool', crusherU + Cr.length / 2 + 3.5, S + 2.2);
  put('pallets', crusherU - Cr.length / 2 - 3, S + 3);
  put('pallets', craneU + 6, S + 4.5);
  put('crate', craneU - 5, S + 5);
  for (let k = 0; k < 7; k++) put(rng.pick(['drum', 'trashBags', 'crate', 'drum'] as const), rng.range(3, L - 3), rng.range(S + 1, S + 11));
  for (let k = 0; k < 6; k++) put(rng.pick(['drum', 'trashBags', 'tyreStack'] as const), canyonU + rng.range(-1.6, 1.6), endW + rng.range(1, 3));

  // The fence: every polygon edge less the cuts' gaps, with a post each side.
  const poly = a.polygon;
  const m = poly.length;
  const cuts = yardCuts(a);
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / m;
    cz += p.z / m;
  }
  const fences: YardFencePiece[] = [];
  const posts: YardSolid[] = [];
  for (let i = 0; i < m; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % m];
    const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (len < 0.3) continue;
    const d = { x: (q.x - p.x) / len, z: (q.z - p.z) / len };
    let nx = d.z;
    let nz = -d.x;
    if ((cx - p.x) * nx + (cz - p.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
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
    for (const c of cuts) {
      if (c.edge !== i) continue;
      for (const sg of [-1, 1]) {
        const t = c.t + sg * (c.hw + 0.35);
        const px = p.x + d.x * t + nx * 0.4;
        const pz = p.z + d.z * t + nz * 0.4;
        posts.push({ x: px, z: pz, poly: box(px, pz, d.x, d.z, 0.7, 0.7) });
      }
    }
  }

  return {
    frame,
    L,
    D,
    R,
    rimR,
    rings,
    neck,
    canyon: { u: canyonU, lip: lipW, end: endW, press: pressW, stacks: n },
    stacks,
    fences,
    posts,
    crusher,
    crane,
    conveyor,
    towers,
    kicker: { foot: W(canyonU, lipW + K.run), lip: W(canyonU, lipW), dir: { x: -frame.w.x, z: -frame.w.z } },
    pit: W(canyonU, S + C.pit.length / 2),
    press: { a: W(canyonU - half, pressW), b: W(canyonU + half, pressW), nx: frame.w.x, nz: frame.w.z },
    clutter,
  };
}
