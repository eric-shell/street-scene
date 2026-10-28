/**
 * The harbor's ferry: a lit two deck passenger boat that shuttles across the water on a timetable, a pure function of
 * the scene clock and the seed (render only; the sim never knows, so replays are untouched and the same seed runs the
 * same timetable at any frame rate). Two kinds of run, picked per harbor when it is built:
 *  - a berth: where a stretch of sea wall has room for a clear lane out to sea, the ferry lies alongside the wall for
 *    `dwell` seconds, then pulls out in a quarter turn, runs `run` m out along one lane, turns round out of sight and
 *    comes back along the other lane (they are `2 * radius` apart), turning in to the wall as it slows. It starts and
 *    stops on a trapezoid of speed, so it eases away from the quay and eases in;
 *  - a lane: where the wall is taken (a marina's pontoons, a beach with no wall at all) it sails a stadium shaped lane
 *    beyond everything standing in the water, at a steady pace, crossing in front of the harbor and turning at the ends.
 * The first departure (or the first crossing of the harbor's middle) is a few seconds into the night, seeded, so a
 * race sees it. The horn blows at the departure and again as it comes in to the wall (the lane's: on each crossing),
 * the scene's `FerryHorn` (audio/sceneVoices.ts) from the camera, only while a session drives the scene.
 *
 * The model is built from primitives in its own space (origin at the waterline amidships, bow toward +z) and posed with
 * one group matrix per frame: yaw along the path, a lean into the turn, and the swell's roll and pitch (boats.ts). Its
 * wake is one additive strip trailing the stern (a foam shader on the distance sailed, so the foam stays put in the
 * water as the boat leaves it; High and Medium only), and its lights reflect on the water as streaks that ride the
 * group. Nothing per frame but the matrix and two uniforms.
 */
import * as THREE from 'three';
import type { Area, AreaBuild } from '../../city/districts/types';
import { coastV, framePoint, frameU, frameV, harborFrame, waterLevel } from '../../city/districts/waterfrontShape';
import { distToSegment } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { FerryHorn } from '../../audio/sceneVoices';
import { GeoBuilder } from '../geoBuilder';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';
import { fadeSubPixel } from '../materialFx';
import { WATER_SKY } from '../sky/waterSky';
import { streakFrag, streakVert } from '../street/lightFx';
import { BOATS } from './boats';
import type { DistrictKit } from './kit';
import { col } from './kit';

const F = BOATS.ferry;

/** The path is sampled about this far apart (m): the raw trace's step, then resampled to equal spacing. */
const STEP = 2;
/** The turn radii tried for a berth, widest first (m). */
const RADII = [F.radius, 70, 55] as const;

/** Something standing in the water that the lane must keep clear of: a capsule, a segment with a radius (m). */
interface Obstacle {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
}

/** The ferry's run: its closed path and its timetable. */
export interface FerryPlan {
  mode: 'berth' | 'lane';
  /** The path's samples every `ds` m (world x, z), closed (the last sample is the first). */
  x: Float32Array;
  z: Float32Array;
  /** Yaw (rad, +z is 0) of each segment from its sample to the next. */
  yaw: Float32Array;
  /** The path's length (m) and the spacing of its samples (m). */
  total: number;
  ds: number;
  /** The scene time (s) the cycle starts (a departure, or the lane's crossing of the middle) and its period (s). */
  start: number;
  period: number;
  /** Berth only: how long the ferry lies at the quay at the cycle's end (s). */
  dwell: number;
  /** Where the horn blows, as seconds into the cycle. */
  horns: number[];
  /** The turn radius of the path's bends (m). */
  radius: number;
}

/** Where the ferry is at a moment. */
export interface FerryPose {
  x: number;
  z: number;
  /** Heading (rad): the bow points at (sin yaw, cos yaw). */
  yaw: number;
  /** Speed along the path (m/s). */
  speed: number;
  /** Distance sailed along the path, mod its length (m). */
  arc: number;
  /** How fast the heading turns (rad/s, positive toward +yaw). */
  turn: number;
}

/** The obstacles standing in the water: jetties and moles and the rest as segments, ships, boats and buoys as capsules. */
function obstacles(b: AreaBuild): Obstacle[] {
  const out: Obstacle[] = [];
  for (const h of b.hints) {
    if (!['jetty', 'mole', 'pier', 'pontoon', 'fuel', 'clubhouse'].includes(h.kind)) continue;
    const p0 = h.points[0];
    const p1 = h.points[h.points.length - 1];
    const w = h.kind === 'jetty' ? h.values[0] / 2 + 6 : h.kind === 'mole' ? h.values[0] / 2 + 8 : h.kind === 'clubhouse' ? 32 : 14;
    out.push({ ax: p0.x, az: p0.z, bx: p1.x, bz: p1.z, r: w });
  }
  for (const pr of b.props) {
    if (pr.kind === 'ship') {
      const fx = Math.sin(pr.yaw);
      const fz = Math.cos(pr.yaw);
      out.push({ ax: pr.x - fx * pr.size, az: pr.z - fz * pr.size, bx: pr.x + fx * pr.size, bz: pr.z + fz * pr.size, r: pr.height / 2 + 6 });
    } else if (pr.kind === 'buoy') out.push({ ax: pr.x, az: pr.z, bx: pr.x, bz: pr.z, r: 6 });
    else if (pr.kind === 'sailboat' || pr.kind === 'yacht' || pr.kind === 'dinghy') out.push({ ax: pr.x, az: pr.z, bx: pr.x, bz: pr.z, r: pr.size / 2 + 5 });
  }
  return out;
}

/** The least room (m) the points leave beyond the obstacles' edges and the clearance the lane needs; negative is a collision. */
function room(xs: readonly number[], zs: readonly number[], obs: readonly Obstacle[]): number {
  let least = Infinity;
  for (let i = 0; i < xs.length; i++) for (const o of obs) least = Math.min(least, distToSegment(xs[i], zs[i], o.ax, o.az, o.bx, o.bz) - o.r);
  return least;
}

/** A polyline in (x, y) local coordinates: straight runs and arcs, sampled every `STEP` m. */
class Trace {
  pts: [number, number][] = [[0, 0]];
  get head(): [number, number] {
    return this.pts[this.pts.length - 1];
  }
  line(x: number, y: number): this {
    const [x0, y0] = this.head;
    const n = Math.max(1, Math.round(Math.hypot(x - x0, y - y0) / STEP));
    for (let i = 1; i <= n; i++) this.pts.push([x0 + ((x - x0) * i) / n, y0 + ((y - y0) * i) / n]);
    return this;
  }
  /** An arc about (cx, cy) from angle a0 to a1 (rad, a full circle is 2 PI), radius r. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number): this {
    const n = Math.max(2, Math.round((Math.abs(a1 - a0) * r) / STEP));
    for (let i = 1; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      this.pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return this;
  }
}

/**
 * Finish a plan from local points mapped to the world by `to`: resampled to equal spacing along the arc (so a distance
 * sailed maps straight to a sample), closed (the last sample is the first), with each segment's heading.
 */
function finish(mode: FerryPlan['mode'], tr: Trace, to: (x: number, y: number) => { x: number; z: number }, radius: number): FerryPlan {
  const raw = tr.pts.map(([a, b]) => to(a, b));
  raw[raw.length - 1] = raw[0];
  const cum = [0];
  for (let i = 1; i < raw.length; i++) cum.push(cum[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.round(total / STEP));
  const ds = total / n;
  const x = new Float32Array(n + 1);
  const z = new Float32Array(n + 1);
  let j = 1;
  for (let i = 0; i <= n; i++) {
    const s = i * ds;
    while (j < raw.length - 1 && cum[j] < s) j++;
    const k = cum[j] > cum[j - 1] ? (s - cum[j - 1]) / (cum[j] - cum[j - 1]) : 0;
    x[i] = raw[j - 1].x + (raw[j].x - raw[j - 1].x) * k;
    z[i] = raw[j - 1].z + (raw[j].z - raw[j - 1].z) * k;
  }
  x[n] = x[0];
  z[n] = z[0];
  const yaw = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const k = Math.min(i, n - 1);
    yaw[i] = Math.atan2(x[k + 1] - x[k], z[k + 1] - z[k]);
  }
  return { mode, x, z, yaw, ds, total, start: 0, period: 1, dwell: 0, horns: [], radius };
}

/** Seconds to travel arc length `s` from rest on the trapezoid of speed, `total` long (the inverse of `trapezoid`). */
function timeTo(total: number, s: number): number {
  const vmax = F.speed;
  const a = F.accel;
  const dRamp = (vmax * vmax) / (2 * a);
  if (s <= dRamp) return Math.sqrt((2 * s) / a);
  if (s <= total - dRamp) return vmax / a + (s - dRamp) / vmax;
  return (2 * vmax) / a + (total - 2 * dRamp) / vmax - Math.sqrt((2 * (total - s)) / a);
}

/** Distance and speed after `t` seconds from rest on the trapezoid of speed over `total` m (it stops at the end). */
function trapezoid(total: number, t: number): { s: number; v: number } {
  const vmax = F.speed;
  const a = F.accel;
  const ramp = vmax / a;
  const dRamp = (vmax * vmax) / (2 * a);
  const T = 2 * ramp + (total - 2 * dRamp) / vmax;
  if (t <= 0) return { s: 0, v: 0 };
  if (t >= T) return { s: total, v: 0 };
  if (t < ramp) return { s: (a * t * t) / 2, v: a * t };
  if (t < T - ramp) return { s: dRamp + vmax * (t - ramp), v: vmax };
  const r = T - t;
  return { s: total - (a * r * r) / 2, v: a * r };
}

/**
 * Plan the harbor's ferry: a berth where the wall has room (the stretch closest to a seeded spot in the quay), else a
 * lane beyond everything in the water. Null where the water is too narrow to sail (a closed basin under 300 m wide).
 */
export function planFerry(a: Area, b: AreaBuild): FerryPlan | null {
  const p = a.params;
  const f = harborFrame(a);
  const rng = new Rng((p.seed ^ 0xfe77e) >>> 0 || 1);
  const obs = obstacles(b);
  const dir = rng.chance(0.5) ? 1 : -1;
  const first = rng.range(F.firstDeparture[0], F.firstDeparture[1]);
  const pref = p.pa + (p.pb - p.pa) * rng.range(0.3, 0.7);
  // The water's reach along the coast: past an open end it runs on, a closed one stops at its breakwater.
  const uMin = p.openA ? p.pa - 900 : p.pa + 20;
  const uMax = p.openB ? p.pb + 900 : p.pb - 20;
  const hasWall = a.variant !== 'beach' && a.variant !== 'marina';

  if (hasWall) {
    const half = F.length / 2;
    for (const R of RADII) {
      let best: { u: number; plan: FerryPlan; d: number } | null = null;
      for (let u = Math.max(p.pa, uMin) + half + 20; u < Math.min(p.pb, uMax) - half - 20; u += 10) {
        // The berth: alongside the wall at its outermost bend under the hull.
        let vc = -Infinity;
        for (let s = -half; s <= half; s += 4) vc = Math.max(vc, coastV(p, u + s));
        const vb = vc + F.beam / 2 + 1.4;
        if (u - R < uMin || u + R > uMax) continue;
        const tr = new Trace();
        // Local x is along the wall away from the berth's heading side, y out to sea.
        tr.arc(0, R, R, -Math.PI / 2, 0).line(R, F.run).arc(0, F.run, R, 0, Math.PI).line(-R, R).arc(0, R, R, Math.PI, 1.5 * Math.PI);
        const plan = finish('berth', tr, (x, y) => framePoint(f, u + dir * x, vb + y), R);
        const d = Math.abs(u - pref);
        if ((!best || d < best.d) && room(Array.from(plan.x), Array.from(plan.z), obs) >= F.clearance) best = { u, plan, d };
      }
      if (best) {
        const plan = best.plan;
        plan.dwell = F.dwell;
        const move = timeTo(plan.total, plan.total);
        plan.period = move + plan.dwell;
        plan.start = first;
        plan.horns = [0, timeTo(plan.total, plan.total - BOATS.horn.approach)];
        return plan;
      }
    }
  }

  // A lane beyond everything standing in the water, along the coast.
  let vReach = -Infinity;
  for (const o of obs) for (const [x, z] of [[o.ax, o.az], [o.bx, o.bz]]) vReach = Math.max(vReach, frameV(f, x, z) + o.r);
  let vCoast = -Infinity;
  for (let u = uMin; u <= uMax; u += 20) vCoast = Math.max(vCoast, coastV(p, u));
  const R = 70;
  const vLane = Math.max(vReach + F.laneMargin, vCoast + 180);
  const mid = (p.pa + p.pb) / 2;
  const lo = Math.max(uMin, mid - 1300) + R;
  const hi = Math.min(uMax, mid + 1300) - R;
  if (hi - lo < 200) return null;
  // Mirrored along the coast by `dir`; local x is metres from the middle along the first lane.
  const x0 = dir > 0 ? lo - mid : mid - hi;
  const x1 = dir > 0 ? hi - mid : mid - lo;
  const tr = new Trace();
  tr.pts = [[x0, 0]];
  tr.line(x1, 0).arc(x1, R, R, -Math.PI / 2, Math.PI / 2).line(x0, 2 * R).arc(x0, R, R, Math.PI / 2, 1.5 * Math.PI);
  const plan = finish('lane', tr, (x, y) => framePoint(f, mid + dir * x, vLane + y), R);
  const toMid = -x0;
  plan.period = plan.total / F.laneSpeed;
  // The ferry is at the lane's middle at `first`: the cycle starts at the lane's start.
  plan.start = first - toMid / F.laneSpeed;
  plan.horns = [toMid / F.laneSpeed];
  return plan;
}

/** The ferry's pose at scene time `t` (s); pure. Written into `out`. */
export function ferryPose(plan: FerryPlan, t: number, out: FerryPose): FerryPose {
  let s: number;
  let v: number;
  const c = (((t - plan.start) % plan.period) + plan.period) % plan.period;
  if (plan.mode === 'lane') {
    s = c * F.laneSpeed;
    v = F.laneSpeed;
  } else {
    // The cycle begins at a departure and ends in the dwell.
    ({ s, v } = trapezoid(plan.total, c));
  }
  const n = plan.x.length - 1;
  const g = Math.min(n - 1e-6, (((s % plan.total) + plan.total) % plan.total) / plan.ds);
  const i = Math.floor(g);
  const k = g - i;
  out.x = plan.x[i] + (plan.x[i + 1] - plan.x[i]) * k;
  out.z = plan.z[i] + (plan.z[i + 1] - plan.z[i]) * k;
  // The heading eases between the segments' (shortest way round).
  const y0 = plan.yaw[i];
  const y1 = plan.yaw[Math.min(i + 1, n - 1)];
  const dy = Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0));
  out.yaw = y0 + dy * k;
  out.speed = v;
  out.arc = s;
  out.turn = (dy / plan.ds) * v;
  return out;
}

/** The scene times in (t0, t1] at which the horn blows, in order. */
export function hornsBetween(plan: FerryPlan, t0: number, t1: number): number[] {
  const out: number[] = [];
  for (const o of plan.horns) {
    const kLo = Math.floor((t0 - plan.start - o) / plan.period) + 1;
    for (let k = kLo; plan.start + o + k * plan.period <= t1; k++) out.push(plan.start + o + k * plan.period);
  }
  return out.sort((a, b) => a - b);
}

/** The hull and the lights, in the ferry's own space. */
const LOOK = {
  hull: col(0x1b2a47),
  boot: col(0x4a1a18),
  topsides: col(0xe9e6dc),
  deck: col(0x6e6a62),
  house: col(0xeceae2),
  houseDark: col(0x3a3d44),
  roof: col(0xcfd2d4),
  funnel: col(0xd8541c),
  funnelBand: col(0x14161a),
  window: col(0xffd68a, 1.7),
  windowCool: col(0xcfe6ff, 1.5),
  flood: col(0xfff0d0, 1.9),
  navRed: col(0xff2a1a, 2.2),
  navGreen: col(0x2aff6a, 2.2),
  masthead: col(0xffffff, 2),
  rail: col(0xb8bcc2),
};

/** A box from corner to corner in the ferry's space, without a bottom. */
function lbox(gb: GeoBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: THREE.Color): void {
  const face = (pts: [number, number, number][], nx: number, ny: number, nz: number) => {
    const ids = pts.map(([x, y, z]) => gb.vertex(x, y, z, nx, ny, nz, 0, 0, c));
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
  };
  face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], -1, 0, 0);
  face([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], 1, 0, 0);
  face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], 0, 0, -1);
  face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], 0, 0, 1);
  face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], 0, 1, 0);
}

/** A flat quad on a side (nx = ±1) or an end (nz = ±1) of the ferry, for a lit window. */
function pane(gb: GeoBuilder, x: number, y0: number, y1: number, z0: number, z1: number, nx: number, nz: number, c: THREE.Color): void {
  const pts: [number, number, number][] = nx ? [[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]] : [[z0, y0, x], [z1, y0, x], [z1, y1, x], [z0, y1, x]];
  const ids = pts.map(([a, b, d]) => gb.vertex(a, b, d, nx, 0, nz, 0, 0, c));
  gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
}

/** The model: hull in two bands, the main deck, the lower house, the upper house, the wheelhouse, funnel, mast, lights. Returns the lights that reflect (local x, height, z, colour, width). */
function buildModel(solid: GeoBuilder, glow: GeoBuilder): { x: number; y: number; z: number; c: THREE.Color; w: number }[] {
  const L = F.length;
  const B = F.beam;
  const fb = F.freeboard;
  const hl = L / 2;
  const hb = B / 2;
  const reflects: { x: number; y: number; z: number; c: THREE.Color; w: number }[] = [];
  // Hull: a square stern, straight sides to the bow's shoulder, a pointed bow; a boot stripe, then the topsides.
  const outline: [number, number][] = [[-hl, -hb * 0.92], [hl * 0.2, -hb], [hl * 0.62, -hb * 0.55], [hl, 0], [hl * 0.62, hb * 0.55], [hl * 0.2, hb], [-hl, hb * 0.92]];
  const band = (y0: number, y1: number, k: number, c: THREE.Color) => {
    for (let i = 0; i < outline.length; i++) {
      const [z0, x0] = outline[i];
      const [z1, x1] = outline[(i + 1) % outline.length];
      let nx = x1 - x0;
      let nz = -(z1 - z0);
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      if ((x0 + x1) * nx + (z0 + z1) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const ids = [solid.vertex(x0 * k, y0, z0 * k, nx, 0, nz, 0, 0, c), solid.vertex(x1 * k, y0, z1 * k, nx, 0, nz, 0, 0, c), solid.vertex(x1, y1, z1, nx, 0, nz, 0, 0, c), solid.vertex(x0, y1, z0, nx, 0, nz, 0, 0, c)];
      solid.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, 0, nz);
    }
  };
  band(-F.draft, 0.2, 0.9, LOOK.boot);
  band(0.2, 1.0, 0.99, LOOK.hull);
  band(1.0, fb, 1, LOOK.topsides);
  const centre = solid.vertex(0, fb, 0, 0, 1, 0, 0, 0, LOOK.deck);
  const ring = outline.map(([z, x]) => solid.vertex(x, fb, z, 0, 1, 0, 0, 0, LOOK.deck));
  for (let i = 0; i < ring.length; i++) solid.triFacing(centre, ring[i], ring[(i + 1) % ring.length], 0, 1, 0);

  // The lower house: the length of the deck between the stern and the bow's shoulder, a lit window band round it.
  const hw1 = hb - 1.0;
  const z0 = -hl + 2.5;
  const z1 = hl * 0.52;
  const y1 = fb + 2.5;
  lbox(solid, -hw1, hw1, fb, y1, z0, z1, LOOK.house);
  lbox(solid, -hw1 - 0.1, hw1 + 0.1, y1, y1 + 0.18, z0 - 0.3, z1 + 0.3, LOOK.roof);
  const winRow = (zA: number, zB: number, hw: number, yA: number, yB: number, step: number) => {
    for (let z = zA; z + step * 0.6 <= zB; z += step) {
      for (const s of [-1, 1]) pane(glow, s * (hw + 0.03), yA, yB, z, z + step * 0.62, s, 0, ((Math.round(z * 3) % 5) === 0 ? LOOK.windowCool : LOOK.window));
    }
    for (const s of [-1, 1]) for (let x = -hw + 0.7; x + 1.2 <= hw; x += 1.9) pane(glow, s > 0 ? zB + 0.03 : zA - 0.03, yA, yB, x, x + 1.2, 0, s, LOOK.window);
  };
  winRow(z0 + 0.8, z1 - 0.8, hw1, fb + 0.7, fb + 1.9, 2.3);
  // The upper house, narrower and shorter, and the wheelhouse forward of it.
  const hw2 = hb - 2.6;
  const u0 = -hl + 8;
  const u1 = hl * 0.28;
  const y2 = y1 + 2.4;
  lbox(solid, -hw2, hw2, y1 + 0.18, y2, u0, u1, LOOK.house);
  lbox(solid, -hw2 - 0.1, hw2 + 0.1, y2, y2 + 0.16, u0 - 0.3, u1 + 0.3, LOOK.roof);
  winRow(u0 + 0.8, u1 - 0.8, hw2, y1 + 0.85, y1 + 1.95, 2.3);
  const w0 = u1 + 0.5;
  const w1 = w0 + 6.5;
  const hw3 = hb - 3.4;
  const y3 = y2 + 2.5;
  lbox(solid, -hw3, hw3, y2 + 0.16, y3, w0, w1, LOOK.houseDark);
  lbox(solid, -hw3 - 0.25, hw3 + 0.25, y3, y3 + 0.2, w0 - 0.3, w1 + 0.4, LOOK.roof);
  // The wheelhouse glazing: a bright band across the front and down both sides.
  pane(glow, w1 + 0.03, y2 + 0.8, y3 - 0.35, -hw3 + 0.35, hw3 - 0.35, 0, 1, LOOK.windowCool);
  for (const s of [-1, 1]) pane(glow, s * (hw3 + 0.03), y2 + 0.8, y3 - 0.35, w0 + 0.6, w1 - 0.6, s, 0, LOOK.windowCool);
  // The funnel aft, a black band round its crown; the mast over the wheelhouse.
  const fz = -hl + 14;
  lbox(solid, -1.6, 1.6, y2 + 0.16, y2 + 3.8, fz - 2.2, fz + 2.2, LOOK.funnel);
  lbox(solid, -1.62, 1.62, y2 + 3.2, y2 + 3.8, fz - 2.22, fz + 2.22, LOOK.funnelBand);
  const mz = (w0 + w1) / 2;
  lbox(solid, -0.12, 0.12, y3 + 0.2, y3 + 4.6, mz - 0.12, mz + 0.12, LOOK.rail);
  // Lights: masthead and the red and green on the wheelhouse wings, a stern light, floods along the main deck.
  const lamp = (x: number, y: number, z: number, s: number, c: THREE.Color) => lbox(glow, x - s, x + s, y - s, y + s, z - s, z + s, c);
  lamp(0, y3 + 4.8, mz, 0.28, LOOK.masthead);
  lamp(-hw3 - 0.3, y3 - 0.3, w1 - 0.5, 0.22, LOOK.navRed);
  lamp(hw3 + 0.3, y3 - 0.3, w1 - 0.5, 0.22, LOOK.navGreen);
  lamp(0, y2 + 1.0, -hl + 0.5, 0.2, LOOK.masthead);
  for (let z = z0 + 3; z < z1; z += 8) for (const s of [-1, 1]) lamp(s * (hb - 0.25), fb + 0.9, z, 0.16, LOOK.flood);
  reflects.push({ x: 0, y: y3, z: mz, c: LOOK.windowCool.clone().multiplyScalar(0.3), w: 4 });
  reflects.push({ x: -hw3 - 0.3, y: y3, z: w1 - 0.5, c: LOOK.navRed.clone().multiplyScalar(0.25), w: 1.4 });
  reflects.push({ x: hw3 + 0.3, y: y3, z: w1 - 0.5, c: LOOK.navGreen.clone().multiplyScalar(0.25), w: 1.4 });
  for (const z of [z0 + 6, (z0 + z1) / 2, z1 - 6]) for (const s of [-1, 1]) reflects.push({ x: s * hw1, y: fb + 1.8, z, c: LOOK.window.clone().multiplyScalar(0.2), w: 3.2 });
  return reflects;
}

/** The streak vertex shader of lightFx, with each light's position in the group's space (the group moves, the streak follows). */
const FERRY_STREAK_VERT = streakVert.replace('attribute vec3 iPos;', 'attribute vec3 iPosL;').replace('void main() {', 'void main() {\n    vec3 iPos = (modelMatrix * vec4(iPosL, 1.0)).xyz;');

/** The wake: a strip trailing the stern, foam keyed to the distance sailed so it lies still in the water. */
const WAKE_VERT = /* glsl */ `
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vUv;
  varying float vFog;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * hfMulView(mv.xyz));
    gl_Position = projectionMatrix * mv;
  }
`;

const WAKE_FRAG = /* glsl */ `
  uniform float uArc;
  uniform float uStrength;
  varying vec2 vUv;
  varying float vFog;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  void main() {
    // uv.x -1..1 across, uv.y 0 at the stern to 1 at the far end of the wake.
    float ax = abs(vUv.x);
    float along = vUv.y;
    float hw = mix(${(BOATS.wake.near / 2).toFixed(2)}, ${(BOATS.wake.far / 2).toFixed(2)}, along);
    vec2 q = vec2(vUv.x * hw, uArc - along * ${BOATS.wake.length.toFixed(1)});
    float n = 0.6 * vnoise(q * vec2(1.1, 0.5)) + 0.4 * vnoise(q * vec2(3.3, 1.5) + 9.0);
    // The prop wash down the middle, and the two bright arms of the wedge spreading from the stern.
    float core = exp(-(vUv.x * vUv.x) / 0.07) * pow(1.0 - along, 1.5);
    float arm = exp(-pow((ax - 0.8) / 0.13, 2.0)) * (1.0 - along) * 0.85;
    float foam = (core * 1.15 + arm) * smoothstep(0.22, 0.7, n + 0.18);
    float edge = smoothstep(1.0, 0.82, ax) * smoothstep(0.0, 0.03, along);
    float a = foam * edge * uStrength * ${BOATS.wake.strength.toFixed(2)};
    gl_FragColor = vec4(vec3(0.62, 0.78, 0.9) * a * vFog, 1.0);
  }
`;

/** The ferry of a harbor: the plan, the model, the wake and the horn. A harbor with no room to sail one has none. */
export function drawFerry(kit: DistrictKit, a: Area, b: AreaBuild): void {
  const plan = planFerry(a, b);
  if (!plan) return;
  const p = a.params;
  const f = harborFrame(a);
  const low = kit.quality === 'low';
  const group = new THREE.Group();
  group.name = 'harborFerry';
  group.rotation.order = 'YXZ';

  // ----- The model, in two meshes (lit and glowing), one draw call each.
  const solid = new GeoBuilder(true);
  const glow = new GeoBuilder(true);
  const reflects = buildModel(solid, glow);
  const hullMesh = new THREE.Mesh(kit.track(solid.build()), kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, envMapIntensity: 0.5 })));
  hullMesh.name = 'ferryHull';
  const lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  lampMat.color.setScalar(1.6);
  fadeSubPixel(lampMat, 0.3, 0.3);
  const lampMesh = new THREE.Mesh(kit.track(glow.build()), kit.track(lampMat));
  lampMesh.name = 'ferryLights';
  group.add(hullMesh, lampMesh);

  // ----- The lights' reflections: lightFx's streaks, riding the group.
  if (!low) {
    const base = new THREE.PlaneGeometry(1, 1.2);
    base.translate(0, 0.4, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    const iPosL = new Float32Array(reflects.length * 3);
    const iColor = new Float32Array(reflects.length * 3);
    const iSize = new Float32Array(reflects.length * 2);
    reflects.forEach((l, i) => {
      iPosL.set([l.x, 0.04, l.z], i * 3);
      iColor.set([l.c.r, l.c.g, l.c.b], i * 3);
      iSize.set([l.w, Math.max(2, l.y)], i * 2);
    });
    geo.setAttribute('iPosL', new THREE.InstancedBufferAttribute(iPosL, 3));
    geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(iColor, 3));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(iSize, 2));
    geo.instanceCount = reflects.length;
    kit.track(base);
    const mat = new THREE.ShaderMaterial({
      vertexShader: FERRY_STREAK_VERT,
      fragmentShader: streakFrag,
      uniforms: { strength: { value: 1 }, fogDensity: { value: 0.005 }, ...HEIGHT_FOG_UNIFORMS },
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const streaks = new THREE.Mesh(kit.track(geo), kit.track(mat));
    streaks.name = 'ferryStreaks';
    streaks.frustumCulled = false;
    streaks.renderOrder = 2;
    group.add(streaks);
  }

  // ----- The wake (Medium and High): one strip behind the stern.
  let wake: THREE.ShaderMaterial | null = null;
  if (!low) {
    const W = BOATS.wake;
    const gb = new GeoBuilder(true);
    const rows = 12;
    let prev: number[] | null = null;
    for (let i = 0; i <= rows; i++) {
      const k = i / rows;
      const hw = (W.near + (W.far - W.near) * k) / 2;
      const z = -F.length / 2 + 1 - W.length * k;
      const cur = [gb.vertex(-hw, 0.07, z, 0, 1, 0, -1, k), gb.vertex(0, 0.07, z, 0, 1, 0, 0, k), gb.vertex(hw, 0.07, z, 0, 1, 0, 1, k)];
      if (prev) {
        gb.quadFacing(prev[0], cur[0], cur[1], prev[1], 0, 1, 0);
        gb.quadFacing(prev[1], cur[1], cur[2], prev[2], 0, 1, 0);
      }
      prev = cur;
    }
    wake = new THREE.ShaderMaterial({
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
      uniforms: { uArc: { value: 0 }, uStrength: { value: 0 }, fogDensity: { value: 0.005 }, ...HEIGHT_FOG_UNIFORMS },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(kit.track(gb.build()), kit.track(wake));
    mesh.name = 'ferryWake';
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  kit.group.add(group);

  // ----- Posing, on the scene clock: the path's pose, a lean into the turn, the swell's roll and pitch.
  const pose: FerryPose = { x: 0, z: 0, yaw: 0, speed: 0, arc: 0, turn: 0 };
  const phase = (p.seed % 628) / 100;
  let now = 0;
  kit.animate((time) => {
    now = time;
    ferryPose(plan, time, pose);
    const u = frameU(f, pose.x, pose.z);
    const R = BOATS.rock;
    const sw = (R.floor + (1 - R.floor) * WATER_SKY.wind.value) * F.rock;
    const roll = Math.sin(time * R.hz[1] * Math.PI * 2 + phase) * R.roll * sw - pose.turn * pose.speed * 0.012;
    const pitch = Math.sin(time * R.hz[0] * Math.PI * 2 + phase * 1.7) * R.pitch * sw;
    const heave = Math.sin(time * R.hz[2] * Math.PI * 2 + phase * 2.9) * R.heave * sw;
    group.position.set(pose.x, waterLevel(p, u) + heave, pose.z);
    group.rotation.set(pitch, pose.yaw, roll);
    if (wake) {
      wake.uniforms.uArc.value = pose.arc;
      wake.uniforms.uStrength.value = Math.min(1, pose.speed / BOATS.wake.fullSpeed);
    }
  });

  // ----- The horn: heard from the camera while a session drives the scene, dropped beyond its range; hidden beyond the fog.
  let voice: FerryHorn | null = null;
  let tried = false;
  let last = NaN;
  const cam = new THREE.Vector3();
  const right = new THREE.Vector3();
  kit.view((camera) => {
    camera.getWorldPosition(cam);
    const dx = group.position.x - cam.x;
    const dz = group.position.z - cam.z;
    const d = Math.hypot(dx, dz);
    group.visible = d < BOATS.horn.range + 400;
    // Blasts that fell in the time since the last view; a long gap (a pause, a scene picked up late) blows none.
    const t0 = Number.isNaN(last) || now - last > 1 || now < last ? now : last;
    last = now;
    if (!kit.audible() || d > BOATS.horn.range) return;
    if (!hornsBetween(plan, t0, now).length) return;
    if (!voice && !tried) {
      voice = FerryHorn.create();
      tried = voice !== null || !FerryHorn.blocked();
    }
    if (!voice) return;
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const l = d || 1;
    voice.blast(1 / (1 + (d / BOATS.horn.half) ** 2), (dx * right.x + dz * right.z) / l, d);
  });
  kit.track({ dispose: () => voice?.dispose() });
}
