/**
 * River channel features: one to three small set pieces per seed somewhere
 * along the floor, so a run down the channel is never only a straight. Each
 * is a shape added to the terrain's channel profile (no walls, so nothing here
 * can pin a car and the AI simply drives over them), with analytic gradients
 * like the rest of the terrain (the tests check slopes against heights):
 *
 * - hump: a speed hump straight across the floor, a bump at speed.
 * - bar: a water bar, the same hump skewed across the floor, which kicks the
 *   car a little sideways and unsettles a drift.
 * - table: a tabletop jump on one half of the floor, a rounded foot and a hard
 *   crest at both ends (the ramp lip profile), so it launches either way and
 *   the other half stays flat as the slow line.
 * - ledge: one half of the floor raised a step for a stretch, its edge a short
 *   steep bevel: drive along it, drop off it, or climb it.
 * - median: a low rounded ridge down the centerline with water barriers and
 *   sandbags standing on it (districts/river.ts build places them), splitting
 *   the floor into two lanes: pick one, or go through.
 *
 * Features stay clear of the entrance feet and the bridge decks (the closures
 * and meets stand at the feet; nothing changes under a deck) and of each other.
 * The one sided ones sit on the side away from the low flow trickle. Stored in
 * the area params like the ramps (featuresOf) so the sim's profile and the
 * renderer (render/districts/river.ts) agree. Pure.
 */
import { CITY } from '../config';
import { Rng } from '../../sim/prng';
import { smooth01, type Smooth } from './geom';

const CFG = CITY.districts.river;
const FEAT = CFG.features;

export const FEATURE_KINDS = ['hump', 'bar', 'table', 'ledge', 'median'] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

/** A channel feature as stored in the area params (f{i}k, f{i}x, f{i}s, f{i}a). */
export interface Feature {
  kind: FeatureKind;
  /** Centerline x of its middle (m). */
  x: number;
  /** Which floor half a one sided feature (table, ledge) sits on: the sign of l. */
  side: number;
  /** A bar's skew across the floor (rad, 0 square). */
  skew: number;
}

/** A feature's height (m) at a point and its partial derivatives along x (at fixed l) and along l. */
export interface FeatureSample {
  h: number;
  hx: number;
  hl: number;
}

export function featuresOf(p: Record<string, number>): Feature[] {
  const out: Feature[] = [];
  for (let i = 0; i < (p.feats ?? 0); i++) out.push({ kind: FEATURE_KINDS[p[`f${i}k`]], x: p[`f${i}x`], side: p[`f${i}s`], skew: p[`f${i}a`] });
  return out;
}

/** Half extent of a feature along the channel (m): outside |x - f.x| of it the feature adds nothing. */
export function featureSpan(f: Feature, floor: number): number {
  switch (f.kind) {
    case 'hump':
      return FEAT.hump.length / 2 + 0.5;
    case 'bar':
      return FEAT.bar.length / 2 + floor * Math.tan(Math.abs(f.skew)) + 0.5;
    case 'table':
      return FEAT.table.top / 2 + FEAT.table.rise + 0.5;
    case 'ledge':
      return FEAT.ledge.length / 2 + 0.5;
    case 'median':
      return FEAT.median.length / 2 + 0.5;
  }
}

/**
 * Plan the seed's features along the channel between x0 and x1, writing them
 * into `p`: the kinds in a shuffled order (so the long ones, which fit in
 * fewer places, come up as often as the short), each given a few tries at
 * random spots and kept only when it clears every foot and deck by FEAT.clear
 * beyond its own span and the others by FEAT.gap. Its own rng stream, so the
 * rest of the city's draws stay where they were.
 */
export function planFeatures(p: Record<string, number>, seed: number, x0: number, x1: number, feetX: readonly number[], decks: readonly { cx: number; half: number }[]): void {
  const rng = new Rng(seed);
  const want = rng.int(FEAT.count[0], FEAT.count[1]);
  const side = -Math.sign(CFG.waterOffset) || 1;
  const kinds = [...FEATURE_KINDS];
  rng.shuffle(kinds);
  const placed: Feature[] = [];
  p.feats = 0;
  for (let k = 0; k < want; k++) {
    const kind = kinds[k % kinds.length];
    for (let tries = 0; tries < 15; tries++) {
      const x = rng.range(x0, x1);
      const skew = kind === 'bar' ? (rng.chance(0.5) ? 1 : -1) * FEAT.bar.skewDeg * (Math.PI / 180) : 0;
      const f: Feature = { kind, x, side, skew };
      const span = featureSpan(f, p.floor);
      if (x - span < x0 || x + span > x1) continue;
      if (feetX.some((fx) => Math.abs(fx - x) < span + FEAT.clear)) continue;
      if (decks.some((d) => Math.abs(d.cx - x) < d.half + span + FEAT.clear)) continue;
      if (placed.some((o) => Math.abs(o.x - x) < featureSpan(o, p.floor) + span + FEAT.gap)) continue;
      placed.push(f);
      break;
    }
  }
  placed.sort((a, b) => a.x - b.x);
  for (const f of placed) {
    const i = p.feats++;
    p[`f${i}k`] = FEATURE_KINDS.indexOf(f.kind);
    p[`f${i}x`] = f.x;
    p[`f${i}s`] = f.side;
    p[`f${i}a`] = f.skew;
  }
}

/** Scratch smoothsteps: the profile is queried per wheel per substep, so nothing allocates. */
const S1: Smooth = { v: 0, d: 0 };
const S2: Smooth = { v: 0, d: 0 };

/** A rounded bump of unit height over |d| < half: 1 - smoothstep(|d| / half); writes value and d/dd into out. */
function bump(d: number, half: number, out: Smooth): Smooth {
  smooth01(0, half, Math.abs(d), out);
  out.v = 1 - out.v;
  out.d = d >= 0 ? -out.d : out.d;
  return out;
}

/** Fade to 0 over the last stretch before the floor edge, so a full width feature never climbs the bank. */
function floorFade(al: number, floor: number, out: Smooth): Smooth {
  smooth01(floor - FEAT.edgeFade, floor - 0.2, al, out);
  out.v = 1 - out.v;
  out.d = -out.d;
  return out;
}

/**
 * The tabletop's slope: w = 0 at the foot of the rise, 1 at the crest. A
 * quadratic ease over the first FEAT.table.lip of the run, then a constant
 * grade: rounded where the car meets it, a hard kink to launch off. Writes
 * the share of the height (v) and its derivative in w (d) into out.
 */
function crest(w: number, out: Smooth): Smooth {
  const a = FEAT.table.lip;
  const s = 1 / (1 - a / 2);
  if (w <= 0) {
    out.v = 0;
    out.d = 0;
  } else if (w >= 1) {
    out.v = 1;
    out.d = 0;
  } else if (w < a) {
    out.v = (s * w * w) / (2 * a);
    out.d = (s * w) / a;
  } else {
    out.v = s * (w - a / 2);
    out.d = s;
  }
  return out;
}

/**
 * Height of feature `f` at (x, l) on the floor (l the signed offset from the
 * centerline) and its partials, written into `out` (zeros outside it).
 * `floor` is the channel's flat half width.
 */
export function featureHeight(f: Feature, floor: number, x: number, l: number, out: FeatureSample): FeatureSample {
  out.h = 0;
  out.hx = 0;
  out.hl = 0;
  const dx = x - f.x;
  const al = Math.abs(l);
  const sl = l >= 0 ? 1 : -1;
  switch (f.kind) {
    case 'hump': {
      const H = FEAT.hump.height;
      const b = bump(dx, FEAT.hump.length / 2, S1);
      if (b.v <= 0) return out;
      const w = floorFade(al, floor, S2);
      out.h = H * b.v * w.v;
      out.hx = H * b.d * w.v;
      out.hl = H * b.v * w.d * sl;
      return out;
    }
    case 'bar': {
      const H = FEAT.bar.height;
      const c = Math.cos(f.skew);
      const s = Math.sin(f.skew);
      const b = bump(dx * c + l * s, FEAT.bar.length / 2, S1);
      if (b.v <= 0) return out;
      const w = floorFade(al, floor, S2);
      out.h = H * b.v * w.v;
      out.hx = H * b.d * c * w.v;
      out.hl = H * (b.d * s * w.v + b.v * w.d * sl);
      return out;
    }
    case 'table': {
      const T = FEAT.table;
      const ad = Math.abs(dx);
      if (ad >= T.top / 2 + T.rise) return out;
      const u = f.side * l;
      if (u <= T.inner) return out;
      // Lateral: a bevel in from the inner edge, a fade before the bank.
      const win = smooth01(T.inner, T.inner + T.edge, u, S1);
      const wv = win.v;
      const wd = win.d;
      const fade = floorFade(u, floor, S2);
      const W = wv * fade.v;
      const Wl = (wd * fade.v + wv * fade.d) * f.side;
      let fv = 1;
      let fx = 0;
      if (ad > T.top / 2) {
        const k = crest(1 - (ad - T.top / 2) / T.rise, S1);
        fv = k.v;
        fx = (-k.d / T.rise) * (dx >= 0 ? 1 : -1);
      }
      out.h = T.height * fv * W;
      out.hx = T.height * fx * W;
      out.hl = T.height * fv * Wl;
      return out;
    }
    case 'ledge': {
      const L = FEAT.ledge;
      const ad = Math.abs(dx);
      if (ad >= L.length / 2) return out;
      const u = f.side * l;
      if (u <= L.inner) return out;
      const e = smooth01(L.length / 2 - L.end, L.length / 2, ad, S1);
      const ev = 1 - e.v;
      const ed = dx >= 0 ? -e.d : e.d;
      // In from the inner edge over the bevel; up the bank it fades into the slope (no gutter at the foot).
      const win = smooth01(L.inner, L.inner + L.ease, u, S2);
      const wv = win.v;
      const wd = win.d;
      const up = smooth01(floor, floor + L.bankMerge, u, S1);
      const W = wv * (1 - up.v);
      const Wl = (wd * (1 - up.v) - wv * up.d) * f.side;
      out.h = L.height * ev * W;
      out.hx = L.height * ed * W;
      out.hl = L.height * ev * Wl;
      return out;
    }
    case 'median': {
      const M = FEAT.median;
      const ad = Math.abs(dx);
      if (ad >= M.length / 2 || al >= M.half) return out;
      const e = smooth01(M.length / 2 - M.end, M.length / 2, ad, S1);
      const ev = 1 - e.v;
      const ed = dx >= 0 ? -e.d : e.d;
      const b = bump(l, M.half, S2);
      out.h = M.height * ev * b.v;
      out.hx = M.height * ed * b.v;
      out.hl = M.height * ev * b.d;
      return out;
    }
  }
}

/** Where a median's barriers stand along it (x), from one tapered end to the other. */
export function medianBarrierXs(f: Feature): number[] {
  const M = FEAT.median;
  const out: number[] = [];
  const reach = M.length / 2 - M.end;
  for (let d = -reach; d <= reach + 1e-6; d += M.barrierStep) out.push(f.x + d);
  return out;
}
