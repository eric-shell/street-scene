/**
 * The river's entrance ramps: how one is stored in the area params (rampsOf), its width with the bell mouth
 * and foot bell (rampHalf, rampOuter), the eased profile it climbs (rampProfile), where along the channel its
 * axis stands and the points on it (rampAlong, rampPoint), and where the bell mouths and foot bells are sampled
 * (mouthAlongs, footAlongs). A ramp is a trench (down into the channel floor) or a ford (the road dips through)
 * or a side ramp (up the bank along the channel's normal).
 */
import { CITY } from '../../config';
import { Vec2 } from '../../../sim/math';
import type { Area } from '../types';
import { riverCenter } from './centerline';

const CFG = CITY.districts.river;

/** Straight pieces of a side ramp's bell mouth and of every trench's foot bell, each side. */
const MOUTH_STEPS = 8;
const FOOT_STEPS = 5;

/** Where a side ramp's bell mouth is sampled along its axis (m from the foot), up to the top; none for a ford. */
export function mouthAlongs(r: Ramp, aTop: number): number[] {
  if (!r.flareL && !r.flareR) return [aTop];
  const out: number[] = [];
  for (let k = 0; k <= MOUTH_STEPS; k++) out.push(aTop - CFG.mouthLength + (CFG.mouthLength * k) / MOUTH_STEPS);
  return out;
}

/** Where a trench's foot bell is sampled along its axis (m from the foot): from just above the floor edge to where the straight trench begins. */
export function footAlongs(r: Ramp): number[] {
  const out: number[] = [];
  for (let k = 1; k <= FOOT_STEPS; k++) out.push(r.aFloor + (CFG.footLength * k) / FOOT_STEPS);
  return out;
}

/** An entrance ramp as stored in the area params (see rampsOf). */
export interface Ramp {
  /** Foot: the channel node on the centerline. */
  ax: number;
  az: number;
  /** Unit axis from the foot toward the top (up the bank). */
  ux: number;
  uz: number;
  /** Which bank it climbs: sign of l at the top. */
  side: number;
  /** Trench half width (m) and the plinth width beside it (m). */
  hw: number;
  body: number;
  /** |l| of the top (ground level) and of the street curb line the ramp strip starts at (fords: the top). */
  topL: number;
  curbL: number;
  /** 1 for one half of a ford (a crossing street dipping through), 0 for a side ramp. */
  ford: number;
  /** Graph ids: the ramp edge, its street end node and the foot node. */
  edge: number;
  node: number;
  foot: number;
  /** Distance along the axis from the foot to the top (m), and to the floor edge (m). */
  aTop: number;
  aFloor: number;
  /** How far the trench widens at the top on its left (+lat) and right side (m): a side ramp's bell mouth, 0 for a ford. */
  flareL: number;
  flareR: number;
  /** Room along the bank street from the axis to the next corridor, left and right (m; 0 for a ford). */
  roomL: number;
  roomR: number;
}

export function rampsOf(area: Area): Ramp[] {
  const p = area.params;
  const out: Ramp[] = [];
  for (let i = 0; i < p.ramps; i++) {
    const r = (k: string) => p[`r${i}${k}`];
    const ramp: Ramp = { ax: r('ax'), az: r('az'), ux: r('ux'), uz: r('uz'), side: r('side'), hw: r('hw'), body: r('body'), topL: r('topL'), curbL: r('curbL'), ford: r('ford'), edge: r('edge'), node: r('node'), foot: r('foot'), aTop: 0, aFloor: 0, flareL: r('flL'), flareR: r('flR'), roomL: r('rmL'), roomR: r('rmR') };
    ramp.aTop = rampAlong(p, ramp, ramp.topL);
    ramp.aFloor = rampAlong(p, ramp, p.floor);
    out.push(ramp);
  }
  return out;
}

/**
 * Trench half width (m) on side `sd` (1 left of the axis, -1 right) at
 * `along` from the foot: the foot bell (footFlare at the floor edge, easing
 * back quadratically over footLength so it is tangent to the straight trench
 * above), hw up the run, then a side ramp's bell mouth over the last
 * CFG.mouthLength before the top, easing out (quadratic again) by that
 * side's flare. Held at the mouth's width past the top, across the sidewalk.
 */
export function rampHalf(r: Ramp, along: number, sd: number): number {
  const f = 1 - Math.min(1, Math.max(0, (along - r.aFloor) / CFG.footLength));
  let w = r.hw + CFG.footFlare * f * f;
  const flare = sd > 0 ? r.flareL : r.flareR;
  if (flare) {
    const t = Math.min(1, Math.max(0, (along - (r.aTop - CFG.mouthLength)) / CFG.mouthLength));
    w += flare * t * t;
  }
  return w;
}

/** The plinth's outer face on side `sd` at `along` (m from the axis): body wide, thinning to CFG.mouthBody where the bell mouth eats into it, pushed out with it beyond. */
export function rampOuter(r: Ramp, along: number, sd: number): number {
  return Math.max(r.hw + r.body, rampHalf(r, along, sd) + CFG.mouthBody);
}

/**
 * Ramp depth profile: u = 0 at the top, 1 at the floor edge; returns the
 * share of the depth and its derivative. Quadratic ease over the lip, then a
 * constant grade: the top is a rounded crest, the foot a hard kink.
 */
export function rampProfile(u: number): { f: number; df: number } {
  const a = CFG.rampLip;
  const s = 1 / (1 - a / 2);
  if (u <= 0) return { f: 0, df: 0 };
  if (u >= 1) return { f: 1, df: s };
  if (u < a) return { f: (s * u * u) / (2 * a), df: (s * u) / a };
  return { f: s * (u - a / 2), df: s };
}

/**
 * Distance along a ramp's axis from its foot where |l| reaches `al`, on the
 * line `lat` to the left of the axis (the axis is nearly perpendicular to the
 * channel, so this is close to `al` itself).
 */
export function rampAlong(p: Record<string, number>, r: Ramp, al: number, lat = 0): number {
  const f = (t: number) => {
    const q = rampPoint(r, t, lat);
    return Math.abs(q.z - riverCenter(p, q.x)) - al;
  };
  let lo = 0;
  let hi = al * 1.5 + 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Point of a ramp at distance `along` from its foot, `lat` to the left of the axis. */
export function rampPoint(r: Ramp, along: number, lat: number): Vec2 {
  return { x: r.ax + r.ux * along - r.uz * lat, z: r.az + r.uz * along + r.ux * lat };
}

/** A planned ramp before the graph has nodes for it. */
export interface RampPlan {
  ford: boolean;
  /** Centerline crossing x of the foot. */
  x: number;
  side: number;
  hw: number;
  body: number;
  topL: number;
  curbL: number;
  /** Side ramps: the bank street edge to split (where the ramp's axis meets it). Fords: the crossing edge. */
  edge: number;
  hit?: Vec2;
}
