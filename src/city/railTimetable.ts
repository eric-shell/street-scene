/**
 * Elevated railway timetable: where every train is at a given time, as a pure
 * function of that time. No state, no frame steps and no randomness beyond
 * the integer hash below, so the same clock always shows the same trains
 * (replays, the menu backdrop and a race all agree) and the renderer can ask
 * about any moment (sparks look back at where a car was when they flew off).
 *
 * Each direction runs one fixed motion profile per trip along its track:
 * enter from the portal at one end at cruising speed, brake into every
 * station, dwell, pull away, leave through the portal at the far end.
 * Trips start every `headway` seconds from a per direction phase. Distances
 * are along the track ("travel s", 0 at the entry portal); a train's head is
 * its front, and the rest of the train trails behind it.
 *
 * Lives in the city with the track curve (railCurve.ts) because the sim reads
 * it too: a race's clock is its tick (tick * DT), the renderer shows the trains
 * at that clock, and the level crossings (sim/levelCrossing.ts) close their
 * gates for exactly these trains. Integer hashing and IEEE exact arithmetic
 * only, so the schedule is the same bit for bit everywhere.
 */
import type { RailCurve } from './railCurve';
import { trackFor } from './railCurve';
import { sqrt } from '../sim/math';

/** Train make-up and running (m, s, m/s, m/s²). */
export const TRAIN = {
  cars: 5,
  carLength: 15.4,
  /** Coupler gap between cars (m). */
  gap: 0.9,
  cruise: 17,
  accel: 1.0,
  decel: 1.15,
  dwell: 14,
  headway: 78,
} as const;

/** Length of a whole train, head to tail (m). */
export function trainLength(cars: number = TRAIN.cars): number {
  return cars * TRAIN.carLength + (cars - 1) * TRAIN.gap;
}

/** One piece of a run: constant acceleration from (t0, s0, v0) for dur seconds. */
interface Segment {
  t0: number;
  s0: number;
  v0: number;
  a: number;
  dur: number;
}

/** A trip's motion along its track: head position over time since the trip started. */
export interface RunProfile {
  segments: Segment[];
  /** Trip duration until the tail has left the far portal (s). */
  duration: number;
}

export interface RunOptions {
  cruise: number;
  accel: number;
  decel: number;
  dwell: number;
}

/**
 * The run of one trip over a track `length` long, stopping with the head at
 * each of `stops` (travel s, any order). Ends when the head is a train length
 * past the end, so the whole train has gone into the far portal.
 */
export function buildRun(length: number, stops: readonly number[], train: number, o: RunOptions = TRAIN): RunProfile {
  const segments: Segment[] = [];
  let t = 0;
  let s = 0;
  let v = o.cruise;
  const push = (a: number, dur: number) => {
    if (dur <= 1e-6) return;
    segments.push({ t0: t, s0: s, v0: v, a, dur });
    s += v * dur + 0.5 * a * dur * dur;
    v = Math.max(0, v + a * dur);
    t += dur;
  };
  /** Accelerate, cruise and brake from (s, v) to `target`, arriving at `vEnd`. */
  const leg = (target: number, vEnd: number) => {
    const d = target - s;
    if (d <= 0) return;
    const vc = o.cruise;
    const da = Math.max(0, (vc * vc - v * v) / (2 * o.accel));
    const dd = Math.max(0, (vc * vc - vEnd * vEnd) / (2 * o.decel));
    if (da + dd <= d) {
      if (v < vc) push(o.accel, (vc - v) / o.accel);
      push(0, (d - da - dd) / vc);
      if (vEnd < vc) push(-o.decel, (vc - vEnd) / o.decel);
    } else {
      // Too short to reach cruising speed: accelerate to the peak, then brake.
      const vp = sqrt(Math.max(v * v, (2 * d * o.accel * o.decel + v * v * o.decel + vEnd * vEnd * o.accel) / (o.accel + o.decel)));
      if (vp > v) push(o.accel, (vp - v) / o.accel);
      push(-o.decel, Math.max(0, (vp - vEnd) / o.decel));
    }
    s = target;
    v = vEnd;
  };
  for (const stop of [...stops].sort((a, b) => a - b)) {
    if (stop <= s + 1 || stop >= length) continue;
    leg(stop, 0);
    push(0, o.dwell);
  }
  leg(length + train, o.cruise);
  return { segments, duration: t };
}

/** Head position, speed and acceleration `tau` seconds into a trip (clamped to the run). */
export function runAt(p: RunProfile, tau: number, out: { s: number; v: number; a: number }): { s: number; v: number; a: number } {
  const segs = p.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].t0 <= tau) lo = mid;
    else hi = mid - 1;
  }
  const g = segs[lo];
  const dt = Math.max(0, Math.min(g.dur, tau - g.t0));
  out.s = g.s0 + g.v0 * dt + 0.5 * g.a * dt * dt;
  out.v = g.v0 + g.a * dt;
  out.a = dt < g.dur || lo === segs.length - 1 ? g.a : 0;
  return out;
}

/** One direction of service on one track. */
export interface Service {
  /** +1: travel s grows with track s; -1: it runs the other way. */
  dir: 1 | -1;
  /** Track length (m), portal to portal. */
  length: number;
  run: RunProfile;
  headway: number;
  /** Time of trip 0's departure from its entry portal (s). */
  phase: number;
}

/** Make a service: station centers are track s (platform middles); trains stop centered on them. */
export function makeService(dir: 1 | -1, length: number, stationCenters: readonly number[], phase: number, cars: number = TRAIN.cars): Service {
  const L = trainLength(cars);
  const stops = stationCenters.map((c) => (dir === 1 ? c : length - c) + L / 2);
  return { dir, length, run: buildRun(length, stops, L), headway: TRAIN.headway, phase };
}

/** A train on the line right now. */
export interface TripState {
  /** Trip number (any integer, stable for a given departure). */
  trip: number;
  /** Head position in travel s (m), its speed (m/s) and acceleration (m/s²). */
  s: number;
  v: number;
  a: number;
  /** Seconds since this trip left its entry portal. */
  tau: number;
}

/**
 * Trains of a service in motion at `time`, written into `out` (reused, no
 * allocation once it has grown). Returns how many there are.
 */
export function tripsAt(sv: Service, time: number, out: TripState[]): number {
  const rel = time - sv.phase;
  const kMax = Math.floor(rel / sv.headway);
  const kMin = Math.ceil((rel - sv.run.duration) / sv.headway);
  let n = 0;
  const tmp = { s: 0, v: 0, a: 0 };
  for (let k = kMin; k <= kMax; k++) {
    const tau = rel - k * sv.headway;
    if (tau < 0 || tau > sv.run.duration) continue;
    runAt(sv.run, tau, tmp);
    let t = out[n];
    if (!t) out[n] = t = { trip: 0, s: 0, v: 0, a: 0, tau: 0 };
    t.trip = k;
    t.s = tmp.s;
    t.v = tmp.v;
    t.a = tmp.a;
    t.tau = tau;
    n++;
  }
  return n;
}

/** Track s (along the curve) of a travel s of this service. */
export function trackS(sv: Service, travelS: number): number {
  return sv.dir === 1 ? travelS : sv.length - travelS;
}

/** Small integer hash to 0..1 for cosmetic, repeatable choices (sparks, tints). */
export function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** One direction of service on the line and the track it runs on. */
export interface LineService {
  sv: Service;
  track: 0 | 1;
}

/**
 * The line's two services, both ways, as the trains run them: trip phases from
 * the area's seed (a per city offset, the second direction about half a headway
 * later), right hand running. render/trains.ts draws these and the sim's level
 * crossings time their gates from them, so both must come from here.
 */
export function lineServices(curve: RailCurve, seed: number): LineService[] {
  const stations = curve.stations.map((s) => s.s);
  const phase0 = hash01(seed, 11, 3) * TRAIN.headway;
  return ([1, -1] as const).map((dir, k) => ({ sv: makeService(dir, curve.length, stations, phase0 + k * TRAIN.headway * 0.47), track: trackFor(curve, dir) }));
}
