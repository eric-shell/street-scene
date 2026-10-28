/**
 * The San Francisco cable car (sf home seeds; the line is city/districts/cableCar.ts): one car shuttling up and down
 * its street, sharing the road with the race cars and the traffic.
 *
 * Where it is is a pure function of the tick, like the El's trains (city/railTimetable.ts): a timetable of a dwell
 * at the first terminal, the run to the second, a dwell there and the run back, phased by an offset drawn once on
 * its own stream (deriveSeed(seed, 'cableCar')). Nothing pushes it off that: it is on the cable, so a replay sees it
 * exactly where the race did and the renderer poses it at the interpolated tick from the same function, no
 * snapshot needed. Each run grips the cable up to speed and lets go into the stop at drivingParams.json
 * cableCar.accel; the car is double ended (the California Street cars are) and simply reverses at a terminal.
 *
 * Contact: the car is a body on RaceState (`cableCar.body`, posed every tick before the race cars meet it) of the
 * cable car's mass, met through the same contact as traffic (collision.ts collideCars): seven tonnes against a car's
 * one and a half, so the race car is shoved and stopped and the cable car would barely give; it is held to the cable,
 * so whatever little it gave is put back at once (holdCableCar). Hits raise 'crash' events (car set, no other), cost
 * nitrous like a hard wall hit and are rate limited per car like the racers' crashes. Traffic drivers brake for it
 * as for any foreign body ahead (sim/traffic.ts), struck traffic sliding into it meets it the same way, and a lane
 * never reaches its strip (sim/traffic/net.ts). Racers dodge it as they dodge traffic (trafficAhead).
 *
 * The bell: the gripman rings at every departure (bellLead s before the car pulls away, a pure function of the tick)
 * and whenever a race car is within bellAhead m ahead of the moving car's leading end and within bellSide of its
 * track, at most once every bellGap s. RaceState.cableCar.bell is the tick of the last ring (both kinds), which the
 * renderer swings the bell from and the scene's bell voice strikes on (audio/sceneVoices.ts CableBell).
 *
 * Per tick: a timetable lookup and a polyline sample (binary search), one box test per race car, and nothing more
 * when no car is near. Pure and deterministic.
 */
import type { World } from '../city/world';
import type { Area } from '../city/districts/types';
import { CarState, createCar, crashNitrous } from './car';
import { CABLE_CAR_BODY, CarTuning, DEFAULT_CAR_ID, getBaseTuning } from './tuning';
import { collideCars } from './collision';
import { CRASH_EVENT, DT, TICK_HZ } from './constants';
import { abs, cos, sin, sqrt, yawOf } from './math';
import { Rng, deriveSeed } from './prng';
import type { RaceState } from './race';

/** The timetable and the bell (the body and its motion are drivingParams.json cableCar). */
export const CABLE_CAR = {
  /** Dwell at each terminal (s). */
  dwell: 20,
  /** The departure bell rings this long before the car pulls away (s). */
  bellLead: 1,
  /** A race car this far ahead of the leading end (m) and this close to the track (m, centre to centre) gets the bell. */
  bellAhead: 25,
  bellSide: 3,
  /** At most one proximity bell this often (s). */
  bellGap: 3,
} as const;

const B = CABLE_CAR_BODY;

/** The line as the sim reads it: the track polyline, its arc lengths and the timetable's numbers. */
export interface CableLine {
  area: number;
  x: Float64Array;
  z: Float64Array;
  /** Arc length at each point (m). */
  cum: Float64Array;
  /** Track length (m). */
  length: number;
  /** The car's centre at the first and the last terminal (m along the track): its end at the track's end. */
  s0: number;
  s1: number;
  /** One run's time (s), the whole cycle's (s) and the timetable's phase (s). */
  run: number;
  period: number;
  offset: number;
}

const lines = new WeakMap<World, CableLine | null>();

/** The world's cable car line (null on every seed that is not an sf home), built once per World. */
export function cableLine(w: World): CableLine | null {
  let l = lines.get(w);
  if (l === undefined) {
    const a = w.areas.find((x) => x.kind === 'cableCar');
    l = a ? buildLine(w.seed, a) : null;
    lines.set(w, l);
  }
  return l;
}

function buildLine(seed: number, a: Area): CableLine {
  const n = a.path.length;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = a.path[i].x;
    z[i] = a.path[i].z;
    if (i > 0) cum[i] = cum[i - 1] + sqrt((x[i] - x[i - 1]) ** 2 + (z[i] - z[i - 1]) ** 2);
  }
  const length = cum[n - 1];
  const s0 = B.halfLength;
  const s1 = Math.max(s0, length - B.halfLength);
  const run = runTime(s1 - s0);
  const period = 2 * (CABLE_CAR.dwell + run);
  const offset = new Rng(deriveSeed(seed, 'cableCar')).next() * period;
  return { area: a.id, x, z, cum, length, s0, s1, run, period, offset };
}

/** Time (s) to cover d m from rest to rest: up to speed at accel, on at speed, down at accel (a triangle when short). */
function runTime(d: number): number {
  const ramp = (B.speed * B.speed) / B.accel;
  return d >= ramp ? d / B.speed + B.speed / B.accel : 2 * sqrt(d / B.accel);
}

/** Distance covered (m) and speed (m/s) t s into a run of d m. */
function runAt(d: number, t: number, out: { d: number; v: number }): void {
  const T = runTime(d);
  const a = B.accel;
  const vp = Math.min(B.speed, sqrt(a * d));
  const ta = vp / a;
  if (t <= ta) {
    out.d = 0.5 * a * t * t;
    out.v = a * t;
  } else if (t >= T - ta) {
    const r = Math.max(0, T - t);
    out.d = d - 0.5 * a * r * r;
    out.v = a * r;
  } else {
    out.d = 0.5 * a * ta * ta + vp * (t - ta);
    out.v = vp;
  }
}

/** Where the car is at a moment. */
export interface CableCarPose {
  /** Centre along the track (m). */
  s: number;
  /** Speed along the track (m/s, + toward the last terminal). */
  v: number;
  /** The leading end: +1 toward the last terminal, -1 back toward the first (the end it will leave by while it dwells). */
  dir: 1 | -1;
  x: number;
  z: number;
  /** Heading of the track toward the last terminal (rad): the body's yaw, whichever way it runs. */
  yaw: number;
  /** Seconds until it next pulls away (0 while running). */
  departIn: number;
}

const prof = { d: 0, v: 0 };

/** The car at `tick` (fractional ticks are fine: the renderer poses it between two). Writes and returns `out`. */
export function cableCarAt(l: CableLine, tick: number, out: CableCarPose): CableCarPose {
  const D = CABLE_CAR.dwell;
  const t = tick * DT + l.offset;
  let u = t - Math.floor(t / l.period) * l.period;
  const d = l.s1 - l.s0;
  out.departIn = 0;
  if (u < D) {
    out.s = l.s0;
    out.v = 0;
    out.dir = 1;
    out.departIn = D - u;
  } else if (u < D + l.run) {
    runAt(d, u - D, prof);
    out.s = l.s0 + prof.d;
    out.v = prof.v;
    out.dir = 1;
  } else if (u < 2 * D + l.run) {
    out.s = l.s1;
    out.v = 0;
    out.dir = -1;
    out.departIn = 2 * D + l.run - u;
  } else {
    u -= 2 * D + l.run;
    runAt(d, u, prof);
    out.s = l.s1 - prof.d;
    out.v = -prof.v;
    out.dir = -1;
  }
  trackPoint(l, out.s, out);
  return out;
}

/** Position and heading (toward the last terminal) on the track at s m. */
export function trackPoint(l: CableLine, s: number, out: { x: number; z: number; yaw: number }): void {
  const n = l.cum.length;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (l.cum[m] <= s) lo = m;
    else hi = m;
  }
  const seg = l.cum[hi] - l.cum[lo] || 1;
  const t = Math.min(1, Math.max(0, (s - l.cum[lo]) / seg));
  out.x = l.x[lo] + (l.x[hi] - l.x[lo]) * t;
  out.z = l.z[lo] + (l.z[hi] - l.z[lo]) * t;
  out.yaw = yawOf(l.x[hi] - l.x[lo], l.z[hi] - l.z[lo]);
}

/** Whether a departure bell rings during tick `tick` (pure: the timetable alone). */
export function departureBell(l: CableLine, tick: number): boolean {
  const D = CABLE_CAR.dwell;
  const t0 = tick * DT + l.offset;
  const t1 = t0 + DT;
  for (const b of [D - CABLE_CAR.bellLead, 2 * D + l.run - CABLE_CAR.bellLead]) {
    if (Math.floor((t1 - b) / l.period) !== Math.floor((t0 - b) / l.period)) return true;
  }
  return false;
}

/** The cable car's race state: its body (posed every tick) and the bell. */
export interface CableCarState {
  body: CarState;
  /** Tick of the last bell (departure or a car ahead); -Infinity before the first. */
  bell: number;
  /** Bells rung this race. */
  bells: number;
  /** Last tick each race car's hit raised a 'crash' event (rate limit, CRASH_EVENT.gap). */
  hitTicks: number[];
}

let tuning: CarTuning | null = null;

/** The car's collision tuning: the base car's with the cable car's mass and box (like traffic's, sim/traffic/fleet.ts). */
export function cableTuning(): CarTuning {
  if (!tuning) {
    const base = getBaseTuning(DEFAULT_CAR_ID);
    tuning = { ...base, carId: 'cableCar', mass: B.mass, yawInertiaScale: B.yawInertiaScale, geometry: { ...base.geometry, halfLength: B.halfLength, halfWidth: B.halfWidth } };
  }
  return tuning;
}

const pose: CableCarPose = { s: 0, v: 0, dir: 1, x: 0, z: 0, yaw: 0, departIn: 0 };

/** A fresh cable car for a race starting at `tick`, or null when the world has no line. */
export function createCableCar(w: World, cars: number, tick: number): CableCarState | null {
  const l = cableLine(w);
  if (!l) return null;
  cableCarAt(l, tick, pose);
  const body = createCar(pose.x, pose.z, pose.yaw, w.heightAt(pose.x, pose.z));
  const st: CableCarState = { body, bell: -Infinity, bells: 0, hitTicks: new Array<number>(cars).fill(-CRASH_EVENT.gap) };
  place(w, l, st.body, tick);
  return st;
}

/** Pose the body on the cable at `tick`: position, heading, velocity, nothing spinning. */
function place(w: World, l: CableLine, b: CarState, tick: number): void {
  cableCarAt(l, tick, pose);
  b.x = pose.x;
  b.z = pose.z;
  b.y = w.heightAt(pose.x, pose.z);
  b.yaw = pose.yaw;
  b.vx = sin(pose.yaw) * pose.v;
  b.vz = cos(pose.yaw) * pose.v;
  b.vy = 0;
  b.yawRate = 0;
  b.speed = abs(pose.v);
}

/**
 * Put the car back on its cable after a contact shoved it, and the body it met (`other`) by as much the other way:
 * the contact split the overlap by mass, and the cable car's share would otherwise be left in the other body.
 */
export function holdCableCar(r: RaceState, other?: CarState): void {
  const c = r.cableCar;
  const l = cableLine(r.world);
  if (!c || !l) return;
  const b = c.body;
  const x = b.x;
  const z = b.z;
  place(r.world, l, b, r.tick);
  if (other) {
    other.x -= x - b.x;
    other.z -= z - b.z;
  }
}

/**
 * One tick of the cable car (stepRace, before the traffic so its drivers see where it is): pose it at r.tick, ring
 * the bell, and meet the race cars.
 */
export function stepCableCar(r: RaceState): void {
  const c = r.cableCar;
  const l = cableLine(r.world);
  if (!c || !l) return;
  const b = c.body;
  place(r.world, l, b, r.tick);
  // The bell: at departure, and for a race car in the way of the moving car.
  let ring = departureBell(l, r.tick);
  if (!ring && pose.v !== 0 && r.tick - c.bell >= CABLE_CAR.bellGap * TICK_HZ) {
    const fx = sin(b.yaw) * pose.dir;
    const fz = cos(b.yaw) * pose.dir;
    for (const rc of r.cars) {
      const dx = rc.state.x - b.x;
      const dz = rc.state.z - b.z;
      const ahead = dx * fx + dz * fz - B.halfLength;
      if (ahead > 0 && ahead < CABLE_CAR.bellAhead && abs(dx * fz - dz * fx) < CABLE_CAR.bellSide) {
        ring = true;
        break;
      }
    }
  }
  if (ring) {
    c.bell = r.tick;
    c.bells++;
  }
  // Contact: the race cars are shoved, the cable car is held to the cable.
  const t = cableTuning();
  const reach = B.halfLength + 4;
  for (const rc of r.cars) {
    if (rc.finished || rc.passThrough > 0) continue;
    const s = rc.state;
    if ((s.x - b.x) ** 2 + (s.z - b.z) ** 2 > (reach + rc.tuning.geometry.halfLength) ** 2) continue;
    const imp = collideCars(s, rc.tuning, b, t);
    holdCableCar(r, s);
    if (imp <= 0) continue;
    s.impact = Math.max(s.impact, imp);
    crashNitrous(s, rc.tuning, imp);
    if (imp > CRASH_EVENT.speed && r.tick - c.hitTicks[rc.index] >= CRASH_EVENT.gap) {
      c.hitTicks[rc.index] = r.tick;
      r.events.push({ tick: r.tick, type: 'crash', car: rc.index, value: imp });
    }
  }
}

/** The cable car ahead of a point within reach (m) and side (m) of the heading (fx, fz): -1 / 1 for the side it is on (left positive), 0 for none. */
export function cableCarAhead(r: RaceState, x: number, z: number, fx: number, fz: number, reach: number, side: number): number {
  const c = r.cableCar;
  if (!c) return 0;
  const dx = c.body.x - x;
  const dz = c.body.z - z;
  const ahead = dx * fx + dz * fz;
  if (ahead <= 0 || ahead > reach + B.halfLength) return 0;
  const lat = dx * fz - dz * fx;
  return abs(lat) < side + B.halfWidth ? (lat >= 0 ? 1 : -1) : 0;
}
