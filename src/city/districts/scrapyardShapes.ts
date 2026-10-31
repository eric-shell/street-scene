/**
 * The scrapyard's frame and its ground shapes (scrapyardLayout.ts places them, scrapyard.ts folds them into the terrain).
 *
 * The frame: the region's spine is a gentle sweep (at most a dozen metres off its chord), and the yard's lines run beside it,
 * so the yard is laid out in a sheared frame: `u` along the chord from the race's entry junction, `d` measured off the spine
 * along the chord's normal (positive toward the region's shallower side). P(u, d) = o + u U + (d + spineV(u)) N, where spineV
 * is the spine's own offset from the chord (piecewise linear through its points). A line at constant d follows the spine's
 * sweep, so a deck or a canyon wall keeps its gap to the haul road all the way along.
 *
 * The shapes, each a HeightMod with an exact gradient that fades to 0 at its box:
 *  - orientedMod: a rectangle along any unit axis, the shape written in its own (s, t) coordinates;
 *  - tableShape: the channel's `table` rise (channelFeatures.ts), one sided: a quadratic ease at the foot, constant grade to
 *    the lip, a gentle eased fall past it, bevelled at its sides. The crusher's kicker and the launch onto the deck;
 *  - pitShape: a smoothstep plateau below grade (the crusher's pit);
 *  - humpShape: the weighbridge, a low tabletop across the haul road (6% ramps, eased corners);
 *  - deckProfile: the Bale Deck's height along u (eased ramps of constant grade between), for its DeckSpan.
 * Pure: no state but scratch, nothing allocates per query.
 */
import type { Vec2 } from '../../sim/math';
import { sqrt } from '../../sim/math';
import { type Smooth, smooth01 } from './geom';
import type { HeightMod, HeightSample } from './types';

/** The yard's sheared frame (see the header). */
export interface YardFrame {
  /** The race's entry junction (the spine's first point in driving order). */
  o: Vec2;
  /** Unit axis along the chord toward the race's exit junction, and its normal toward the shallow side. */
  u: Vec2;
  n: Vec2;
  /** The chord's length (m). */
  len: number;
  /** The spine's points in the frame (u ascending, v its offset off the chord), for spineV. */
  su: number[];
  sv: number[];
}

/** Build the frame from the spine's points in driving order and the normal's sign (1: left of the chord). */
export function makeFrame(path: readonly Vec2[], side: 1 | -1): YardFrame {
  const o = path[0];
  const e = path[path.length - 1];
  const len = sqrt((e.x - o.x) ** 2 + (e.z - o.z) ** 2) || 1;
  const u = { x: (e.x - o.x) / len, z: (e.z - o.z) / len };
  const n = { x: -u.z * side, z: u.x * side };
  const su: number[] = [];
  const sv: number[] = [];
  for (const p of path) {
    const pu = (p.x - o.x) * u.x + (p.z - o.z) * u.z;
    const pv = (p.x - o.x) * n.x + (p.z - o.z) * n.z;
    // The spine runs on monotonically along its chord; a point that would fold back is skipped.
    if (su.length && pu <= su[su.length - 1] + 1e-6) continue;
    su.push(pu);
    sv.push(pv);
  }
  return { o, u, n, len, su, sv };
}

/** The spine's offset off the chord at u (m, toward n), held flat past its ends. */
export function spineV(f: YardFrame, u: number): number {
  const { su, sv } = f;
  if (u <= su[0]) return sv[0];
  const k = su.length - 1;
  if (u >= su[k]) return sv[k];
  let i = 0;
  while (i < k - 1 && su[i + 1] < u) i++;
  const t = (u - su[i]) / (su[i + 1] - su[i]);
  return sv[i] + (sv[i + 1] - sv[i]) * t;
}

/** The world point at (u, d) of the sheared frame. */
export function framePoint(f: YardFrame, u: number, d: number): Vec2 {
  const v = d + spineV(f, u);
  return { x: f.o.x + f.u.x * u + f.n.x * v, z: f.o.z + f.u.z * u + f.n.z * v };
}

/** A world point's (u, d) in the sheared frame. */
export function frameCoords(f: YardFrame, x: number, z: number): { u: number; d: number } {
  const u = (x - f.o.x) * f.u.x + (z - f.o.z) * f.u.z;
  const v = (x - f.o.x) * f.n.x + (z - f.o.z) * f.n.z;
  return { u, d: v - spineV(f, u) };
}

/** What an oriented shape writes at its local (s along, t across): the height and its two partials. */
export interface ShapeOut {
  h: number;
  hs: number;
  ht: number;
}

/**
 * A height mod over the rectangle s in [s0, s1], t in [t0, t1] of a local frame: origin `o`, unit axis `a` (s), its left normal
 * (t). `shape` must be 0 with zero slope on the rectangle's edges, so the mod fades to 0 at its box.
 */
export function orientedMod(o: Vec2, a: Vec2, s0: number, s1: number, t0: number, t1: number, shape: (s: number, t: number, out: ShapeOut) => void): HeightMod {
  const b = { x: -a.z, z: a.x };
  const corners = [
    [s0, t0],
    [s1, t0],
    [s1, t1],
    [s0, t1],
  ].map(([s, t]) => ({ x: o.x + a.x * s + b.x * t, z: o.z + a.z * s + b.z * t }));
  const out: ShapeOut = { h: 0, hs: 0, ht: 0 };
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minZ: Math.min(...corners.map((p) => p.z)),
    maxZ: Math.max(...corners.map((p) => p.z)),
    add(x: number, z: number, sm: HeightSample): void {
      const dx = x - o.x;
      const dz = z - o.z;
      const s = dx * a.x + dz * a.z;
      const t = dx * b.x + dz * b.z;
      if (s <= s0 || s >= s1 || t <= t0 || t >= t1) return;
      out.h = 0;
      out.hs = 0;
      out.ht = 0;
      shape(s, t, out);
      sm.h += out.h;
      sm.gx += out.hs * a.x + out.ht * b.x;
      sm.gz += out.hs * a.z + out.ht * b.z;
    },
  };
}

const S1: Smooth = { v: 0, d: 0 };
const S2: Smooth = { v: 0, d: 0 };

/** A table kicker's numbers (CITY.districts.scrapyard.kicker / launch). */
export interface TableSpec {
  rise: number;
  run: number;
  fall: number;
  edge: number;
  ease: number;
  width: number;
}

/**
 * The kicker as a mod: origin at its lip, `a` the direction of travel off it. s from -run (the foot) to 0 (the lip) climbs the
 * table's profile (a quadratic ease over the first `ease` of the run, then constant grade, rise / run / (1 - ease / 2) at the
 * lip), and from 0 to `fall` it falls back along the same profile stretched (a steep drop past a lip launches a car off at
 * twice its speed); across, it is bevelled to nothing over `edge` at each side of its `width`.
 */
export function tableMod(lip: Vec2, a: Vec2, K: TableSpec): HeightMod {
  const half = K.width / 2;
  const e = K.ease;
  const sc = 1 / (1 - e / 2);
  return orientedMod(lip, a, -K.run, K.fall, -half, half, (s, t, out) => {
    const wl = smooth01(half - K.edge, half, Math.abs(t), S1);
    const win = 1 - wl.v;
    const winT = -wl.d * (t >= 0 ? 1 : -1);
    const up = s <= 0;
    // k = 0 at the foot of either side, 1 at the lip.
    const k = up ? 1 + s / K.run : 1 - s / K.fall;
    let v: number;
    let dv: number;
    if (k < e) {
      v = (sc * k * k) / (2 * e);
      dv = (sc * k) / e;
    } else {
      v = sc * (k - e / 2);
      dv = sc;
    }
    out.h = K.rise * v * win;
    out.hs = (up ? (K.rise * dv) / K.run : (-K.rise * dv) / K.fall) * win;
    out.ht = K.rise * v * winT;
  });
}

/** The table's height above grade at its lip's centre (m). */
export const tableLip = (K: TableSpec): number => K.rise;

/** The crusher's pit: a plateau `depth` below grade over s in [s0, s1], |t| < half, eased over `ease` at every edge. */
export function pitMod(o: Vec2, a: Vec2, s0: number, s1: number, half: number, depth: number, ease: number): HeightMod {
  const mid = (s0 + s1) / 2;
  const hl = (s1 - s0) / 2;
  return orientedMod(o, a, s0, s1, -half, half, (s, t, out) => {
    const p = smooth01(half - ease, half, Math.abs(t), S1);
    const q = smooth01(hl - ease, hl, Math.abs(s - mid), S2);
    out.h = -depth * (1 - p.v) * (1 - q.v);
    out.ht = depth * p.d * (t >= 0 ? 1 : -1) * (1 - q.v);
    out.hs = depth * (1 - p.v) * q.d * (s >= mid ? 1 : -1);
  });
}

/** The weighbridge: a tabletop `rise` high along s (ramp, top, ramp from s = 0), corners eased over `ease`, across |t| < half fading over `edge`. */
export function humpMod(o: Vec2, a: Vec2, H: { rise: number; ramp: number; top: number; ease: number }, half: number, edge: number): HeightMod {
  const L = 2 * H.ramp + H.top;
  const along = rampProfile(H.rise, H.ramp, H.ease, L);
  const pr = { h: 0, d: 0 };
  return orientedMod(o, a, 0, L, -half, half, (s, t, out) => {
    along(s, pr);
    const w = smooth01(half - edge, half, Math.abs(t), S1);
    out.h = pr.h * (1 - w.v);
    out.hs = pr.d * (1 - w.v);
    out.ht = -pr.h * w.d * (t >= 0 ? 1 : -1);
  });
}

/**
 * A plateau profile along s in [0, L]: up `height` over `ramp` from 0, held, down over the last `ramp`; each ramp is a constant
 * grade with its two ends eased over `ease` (quadratic), so the profile is C1 and exactly 0 at 0 and L. Writes the height and
 * its slope into `out`.
 */
export function rampProfile(height: number, ramp: number, ease: number, L: number): (s: number, out: { h: number; d: number }) => void {
  // Grade between the eases: the two quadratic ends each lose ease / 2 of the run.
  const g = height / (ramp - ease);
  const up = (x: number, out: { h: number; d: number }) => {
    if (x <= 0) {
      out.h = 0;
      out.d = 0;
    } else if (x < ease) {
      out.h = (g * x * x) / (2 * ease);
      out.d = (g * x) / ease;
    } else if (x <= ramp - ease) {
      out.h = g * (x - ease / 2);
      out.d = g;
    } else if (x < ramp) {
      const y = ramp - x;
      out.h = height - (g * y * y) / (2 * ease);
      out.d = (g * y) / ease;
    } else {
      out.h = height;
      out.d = 0;
    }
  };
  return (s, out) => {
    if (s <= L / 2) up(s, out);
    else {
      up(L - s, out);
      out.d = -out.d;
    }
  };
}
