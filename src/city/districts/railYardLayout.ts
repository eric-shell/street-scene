/**
 * The rail yard's layout: everything inside a block's rectangle (railYardFrame.ts), as pure
 * functions of the area's params and a seeded stream, so the sim's walls, the terrain, the
 * renderer's hints and the tests all read one plan.
 *
 * Across a block, in the local frame (u along the street, v into the block):
 *  - the apron, the open gravel behind the gates (the drift zone), v 0..apron;
 *  - the lead track, then 5 to 7 more tracks `pitch` apart. Stopped freight stands on the later ones
 *    as runs of two to five cars with 8 to 14 m between runs; each run is one solid body (look
 *    railcar), so the aisles between tracks are the lines and the gaps between runs let a racer switch
 *    aisles. The lead track stays clear: the switcher works it (sim/switcher.ts);
 *  - the back aisle, between the last consist and the dock face, strewn with soft clutter;
 *  - the loading dock along the back, 1.1 m up, a ramp at each end, a hard edge on its face;
 *  - at one end of the yard a ridge across every track (the jump) with a clear landing either side,
 *    at the far end of the yard's other block a banked turnaround (a half circle round the end of the tracks).
 * Which end carries what is `humpEnd` / `loopEnd` (+1 the high-u end, -1 the low-u end, 0 none).
 *
 * Block i's numbers live in the area's params under `b{i}` (the rectangle, the ends, the front street edge),
 * the gate mouths under `m{k}u` / `m{k}b`; everything else is derived here.
 */
import { CITY } from '../config';
import type { Rng } from '../../sim/prng';
import type { Area } from './types';
import type { YardRect } from './railYardFrame';

const C = CITY.districts.railYard;

export const CAR_KINDS = ['boxcar', 'tank', 'hopper', 'flatcar', 'caboose'] as const;
export type CarKind = (typeof CAR_KINDS)[number];

/** The ridge across the tracks. Lengths along u (m). */
export interface HumpSpec {
  /** Middle of the flat top. */
  uc: number;
  /** Length of each slope: the eased foot and the straight run up. */
  run: number;
  /** Across the tracks: the ridge spans v0..v1 (tapering over C.hump.edge inside them). */
  v0: number;
  v1: number;
  /** The whole zone kept clear of cars, landing included (u0..u1). */
  u0: number;
  u1: number;
}

/** The turnaround at the end of the tracks: a half circle bulging toward +u from its centre. */
export interface LoopSpec {
  cu: number;
  vmid: number;
  /** Radius of the wall (m). */
  R: number;
}

export interface YardBlock {
  i: number;
  rect: YardRect;
  humpEnd: number;
  loopEnd: number;
  /** Tracks, their spacing (m) and the apron's depth (m). */
  n: number;
  pitch: number;
  apron: number;
  /** v of each track's centre; index 0 is the lead track. */
  trackV: number[];
  /** v of the dock's face. */
  dockFace: number;
  /** The dock's strip along u (ramps included), its ramp length and whether it exists. */
  dock: { u0: number; u1: number; ramp: number } | null;
  hump: HumpSpec | null;
  loop: LoopSpec | null;
  /** Where freight may stand along u. */
  consistLo: number;
  consistHi: number;
  /** The rails run from u = 2 to here. */
  trackU1: number;
  /** The graph edge the frontage runs along. */
  edge: number;
  /** Gate mouth centres along u (m). */
  mouths: number[];
}

/** Track count, spacing and apron for a rectangle `D` deep, or null when it cannot hold the least tracks. */
export function trackPlan(D: number): { n: number; pitch: number; apron: number } | null {
  const half = C.cars.width / 2;
  for (const apron of [C.apron, C.apron - 2, C.apron - 3]) {
    const vFirst = apron + C.lead;
    for (let pitch: number = C.pitch; pitch >= C.minPitch - 1e-9; pitch -= 0.2) {
      const n = Math.min(C.tracks[1], Math.floor((D - C.dock.depth - C.backAisle - half - vFirst) / pitch) + 1);
      if (n >= C.tracks[0]) return { n, pitch, apron };
    }
  }
  return null;
}

/** The share of the ridge's height a slope's eased foot takes (its quadratic lead-in), and the straight run's multiplier. */
export const RAMP_EASE = 0.3;
const rampStretch = (ease: number): number => 1 / (1 - ease / 2);

/** Length (m) of one slope of the ridge for the configured grade. */
export const humpRun = (): number => (C.hump.rise * rampStretch(C.hump.lip)) / C.hump.grade;

/** Length (m) of the dock's ramp for the configured grade. */
export const dockRamp = (): number => (C.dock.height * rampStretch(RAMP_EASE)) / C.dock.grade;

/** Block `i`'s parameters out of an area's params. */
function blockOf(p: Record<string, number>, i: number): YardBlock | null {
  const k = (s: string) => p[`b${i}${s}`];
  if (k('L') === undefined) return null;
  const rect: YardRect = { ox: k('ox'), oz: k('oz'), ux: k('ux'), uz: k('uz'), vx: k('vx'), vz: k('vz'), L: k('L'), D: k('D') };
  const plan = trackPlan(rect.D);
  if (!plan) return null;
  const { n, pitch, apron } = plan;
  const vFirst = apron + C.lead;
  const trackV = Array.from({ length: n }, (_, t) => vFirst + t * pitch);
  const dockFace = rect.D - C.dock.depth;
  const humpEnd = k('h');
  const loopEnd = k('l');
  const run = humpRun();
  const zone = C.hump.top + 2 * run + C.hump.land + C.hump.near;
  let hump: HumpSpec | null = null;
  if (humpEnd !== 0) {
    const u0 = humpEnd > 0 ? rect.L - zone : 0;
    // The far side (the end fence) keeps `land`, the side toward the freight `near`.
    const lead = humpEnd > 0 ? C.hump.near : C.hump.land;
    hump = { uc: u0 + lead + run + C.hump.top / 2, run, v0: trackV[0] - 2.5, v1: dockFace - 1.7, u0, u1: u0 + zone };
  }
  let loop: LoopSpec | null = null;
  if (loopEnd > 0) {
    const R = Math.min(humpEnd !== 0 ? C.bank.radius - 8 : C.bank.radius, rect.D / 2 - 0.5);
    loop = { cu: rect.L - R, vmid: rect.D / 2, R };
  }
  let consistLo = 4;
  let consistHi = rect.L - 4;
  if (hump && humpEnd < 0) consistLo = hump.u1;
  if (hump && humpEnd > 0) consistHi = hump.u0;
  if (loop) consistHi = Math.min(consistHi, loop.cu - 8);
  const trackU1 = loop ? loop.cu - 4 : rect.L - 2;
  const ramp = dockRamp();
  const du0 = 7;
  const du1 = loop ? loop.cu - 8 : rect.L - 7;
  const dock = du1 - du0 >= 2 * ramp + 12 ? { u0: du0, u1: du1, ramp } : null;
  const mouths: number[] = [];
  for (let m = 0; p[`m${m}u`] !== undefined; m++) if (p[`m${m}b`] === i) mouths.push(p[`m${m}u`]);
  return { i, rect, humpEnd, loopEnd, n, pitch, apron, trackV, dockFace, dock, hump, loop, consistLo, consistHi, trackU1, edge: k('e'), mouths };
}

/** Every block of an area (one or two). */
export function yardBlocks(area: Area): YardBlock[] {
  const out: YardBlock[] = [];
  for (let i = 0; i < 2; i++) {
    const b = blockOf(area.params, i);
    if (b) out.push(b);
  }
  return out;
}

/** A single car in a consist. */
export interface YardCar {
  /** Centre along u (m). */
  u: number;
  len: number;
  kind: CarKind;
  /** Livery / graffiti variant for the car side atlas. */
  tex: number;
}

/** A consist: cars coupled on one track, one solid body. */
export interface Consist {
  track: number;
  u0: number;
  u1: number;
  cars: YardCar[];
}

function pickKind(rng: Rng): CarKind {
  const w = C.cars.weights;
  let total = 0;
  for (const k of CAR_KINDS) total += w[k];
  let r = rng.next() * total;
  for (const k of CAR_KINDS) {
    r -= w[k];
    if (r < 0) return k;
  }
  return 'boxcar';
}

/** The consists of a block: runs of cars on tracks 1..n-1 (the lead track stays clear), gaps of 8 to 14 m between runs. */
export function layConsists(b: YardBlock, rng: Rng): Consist[] {
  const out: Consist[] = [];
  const co = C.cars;
  for (let t = 1; t < b.n; t++) {
    if (!rng.chance(co.fill)) continue;
    let cursor = b.consistLo + rng.range(0, 8);
    for (;;) {
      let want = rng.int(co.run[0], co.run[1]);
      const cars: YardCar[] = [];
      let len = 0;
      for (;;) {
        cars.length = 0;
        len = 0;
        for (let c = 0; c < want; c++) {
          // A caboose rides last, and at most once.
          const picked = pickKind(rng);
          const kind: CarKind = c === want - 1 && want >= 3 && rng.chance(0.18) ? 'caboose' : picked === 'caboose' ? 'boxcar' : picked;
          const l = co.kinds[kind][0] + rng.range(-0.4, 0.4);
          cars.push({ u: 0, len: l, kind, tex: rng.int(0, 7) });
          len += l + (c > 0 ? co.coupler : 0);
        }
        if (cursor + len <= b.consistHi || want <= 1) break;
        want--;
      }
      if (cursor + len > b.consistHi) break;
      let u = cursor;
      for (const car of cars) {
        car.u = u + car.len / 2;
        u += car.len + co.coupler;
      }
      out.push({ track: t, u0: cursor, u1: cursor + len, cars: cars.map((c) => ({ ...c })) });
      cursor += len + rng.range(co.gap[0], co.gap[1]);
    }
  }
  return out;
}

/** A piece of soft clutter in an aisle or on the dock. */
export interface Junk {
  kind: 'crate' | 'pallets' | 'drum' | 'cableSpool' | 'sandbags';
  u: number;
  v: number;
  yaw: number;
}

const JUNK_KINDS: Junk['kind'][] = ['crate', 'pallets', 'drum', 'cableSpool', 'sandbags', 'crate', 'drum'];
/** Soft clutter radius by kind (m), a little over PROP_DEFS so the pieces do not overlap. */
const JUNK_R: Record<Junk['kind'], number> = { crate: 0.7, pallets: 0.72, drum: 0.42, cableSpool: 0.9, sandbags: 0.65 };

/**
 * Clutter for a block: the back aisle (every `junk.step` m) and, thinner, the aisles between the consists,
 * then a few pieces on the dock. Pieces keep to the aisle's middle band so a clean line weaves past; a piece
 * never lands on a consist (they stand on the rails' sides, the aisles are clear of cars by construction).
 */
export function layJunk(b: YardBlock, rng: Rng, consists: readonly Consist[]): Junk[] {
  const out: Junk[] = [];
  const half = C.cars.width / 2;
  const pick = (): Junk['kind'] => JUNK_KINDS[rng.int(0, JUNK_KINDS.length - 1)];
  const lastV = b.trackV[b.n - 1];
  const place = (vLo: number, vHi: number, step: readonly [number, number], uLo: number, uHi: number) => {
    if (vHi - vLo < 1.4) return;
    for (let u = uLo + rng.range(0, step[1]); u < uHi; u += rng.range(step[0], step[1])) {
      const kind = pick();
      const r = JUNK_R[kind];
      const lo = vLo + r;
      const hi = vHi - r;
      if (hi <= lo) continue;
      out.push({ kind, u, v: rng.range(lo, hi), yaw: rng.range(0, 6.28) });
    }
  };
  // The back aisle, between the last consist and the dock face (0.9 m kept off both).
  place(lastV + half + 0.9, b.dockFace - 0.9, C.junk.step, b.consistLo, b.consistHi);
  // The aisles between consists: a few, in the middle of the aisle only.
  for (let t = 0; t + 1 < b.n; t++) {
    const mid = b.trackV[t] + b.pitch / 2;
    if (!consists.some((c) => c.track === t || c.track === t + 1)) continue;
    const reach = b.pitch / 2 - half - 1.1;
    if (reach < 0.7) continue;
    place(mid - reach, mid + reach, [C.junk.step[0] * 2.4, C.junk.step[1] * 2.8], b.consistLo, b.consistHi);
  }
  // On the dock: pallets and crates, well back from the edge and clear of the ramps.
  if (b.dock) {
    const u0 = b.dock.u0 + b.dock.ramp + 2;
    const u1 = b.dock.u1 - b.dock.ramp - 2;
    for (let u = u0 + rng.range(0, 6); u < u1; u += rng.range(7, 15)) {
      const kind = rng.chance(0.5) ? 'pallets' : 'crate';
      out.push({ kind, u, v: rng.range(b.dockFace + 2.4, b.rect.D - 1.8), yaw: rng.range(0, 6.28) });
    }
  }
  return out;
}
