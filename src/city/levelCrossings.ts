/**
 * Level crossings: where a street crosses the El's tracks at grade (the crest
 * street of a bluff, districts/bluff.ts), two timed gates (sim/gates.ts) come
 * down while a train goes over. Static data built with the world
 * (createWorld), appended to World.timedGates after the drawbridge's, so the
 * shared machinery does the rest: ambient traffic stopping, the lost timer
 * leaving held cars alone, the HUD warning and the bell. Unlike the
 * drawbridge's, these gates are no wall: their arms snap off when a car
 * drives through them (sim/levelCrossing.ts), and the only hard thing on the
 * crossing is the train itself. Racers time their run over the tracks by the
 * trains, not the arms (TimedGate.train, a second cycle that blocks only
 * while a train is there, padded by CROSSING.aiLead and aiAfter).
 *
 * The schedule comes from the trains themselves. The track curve and both
 * services are built exactly as the renderer builds them (subway.ts elCurve,
 * railTimetable.ts lineServices), and for each running trip the run profile is
 * inverted for when the head reaches the crossing's corridor and when the
 * tail has cleared it. Only a few trip slots of each direction's pattern run
 * (TRAIN.runs of TRAIN.pattern, picked from the seed), so the crossing is one
 * gate cycle of the pattern's period with a handful of irregular closures
 * (GateCycle.more), merged when two trains come close together: the arms are down from
 * CROSSING.downBefore s before a head arrives until CROSSING.upAfter s after
 * the last tail has gone, with the lights and bell starting CROSSING.warn s
 * before they start down. Nothing about the trains is guessed: a train is on
 * the crossing exactly when the timetable puts it there.
 *
 * A car that sits on the tracks when a train arrives is towed off behind the
 * nearer gate, like a car left on the drawbridge (sim/levelCrossing.ts, from
 * sim/hazards.ts), and a car that comes at the train stops against it:
 * `trains` lists when each track's strip is occupied.
 */
import type { City } from './world';
import type { GateCycle, GateSet } from '../sim/gates';
import { makeGate } from '../sim/gates';
import { TICK_HZ } from '../sim/constants';
import { sqrt } from '../sim/math';
import { elCurve } from './districts/subway';
import { projectOnCurve, sampleCurve, curvePoint, trackLateral } from './railCurve';
import { TRAIN, lineServices, runAt, trainLength, tripRuns } from './railTimetable';
import type { RunProfile } from './railTimetable';

/** Crossing timing (s) and layout (m). */
export const CROSSING = {
  /** Lights and bell with the arms still up, arms coming down, arms going up. */
  warn: 3,
  lower: 3.5,
  raise: 3,
  /** Arms are down this long before a train's head reaches the street, and stay down this long after its tail clears it. */
  downBefore: 2.5,
  upAfter: 1,
  /** Two closures closer than this (s, raise end to next warning) merge: the arms stay down for the second train. */
  mergeGap: 2,
  /** Train body half width across its track (m), and the gate lines' clearance beyond it (m). */
  trainHalf: 1.6,
  gateClear: 2.4,
  /** The corridor a train occupies along the track runs this far past the street's frontage lines (m). */
  margin: 1,
  /** Racers count a train as there this long before its head reaches the street and after its tail has left (s): time to get over both tracks. */
  aiLead: 2.5,
  aiAfter: 0.5,
  /** A gate arm's mass (kg): a car through it loses the momentum it takes to snap it. */
  armMass: 30,
} as const;

/** One level crossing: geometry for the renderer and the tow, its gates and when trains are on it. */
export interface LevelCrossing {
  /** The bluff area it belongs to and its street edge. */
  area: number;
  edge: number;
  /** Center: the track centerline on the street centerline. */
  x: number;
  z: number;
  /** Unit direction along the street (node a to b) and along the track (growing curve s). */
  rx: number;
  rz: number;
  tx: number;
  tz: number;
  /** Street corridor half width: curb plus sidewalk (m). The gates span it. */
  half: number;
  /** Gate lines this far along the street either side of the center (m). */
  gate: number;
  /** Where each track's centerline crosses the street centerline, along the street from the center (m), tracks 0 and 1. */
  tracks: [number, number];
  /** Track (deck top) level at the crossing (m). */
  y: number;
  /** Curve s of the crossing (m). */
  s: number;
  /** Its cycle in World.timedGates and its two gates there (the -street-direction side first). */
  cycle: number;
  gates: number[];
  /** The cycle racers time their crossing by (World.timedGates): blocking only while a train is on the street, give or take CROSSING.aiLead and aiAfter. */
  trainCycle: number;
  /** Ticks a train is on the street, per closure of the cycle: start (ticks after the cycle start, mod its period), length and track. */
  trains: { at: number; len: number; track: 0 | 1 }[];
}

/** First tau (s) at which a run's head is at or past travel s `target` (the run is monotonic). */
function tauAt(run: RunProfile, target: number): number {
  const st = { s: 0, v: 0, a: 0 };
  let lo = 0;
  let hi = run.duration;
  if (runAt(run, hi, st).s < target) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (runAt(run, mid, st).s >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Build the city's level crossings and append their cycles and gates to `set`
 * (createWorld, after the drawbridge's). Returns them in a fixed order.
 */
export function addLevelCrossings(city: City, set: GateSet): LevelCrossing[] {
  const out: LevelCrossing[] = [];
  const areas = city.districts.areas;
  const g = city.graph;
  for (const bl of areas) {
    if (bl.kind !== 'bluff') continue;
    const sub = areas[bl.params.subway];
    if (!sub || sub.kind !== 'subway') continue;
    const curve = elCurve(sub, city.districts.builds[sub.id], city.terrain.heightAt);
    const services = lineServices(curve, sub.params.seed ?? 1);
    const e = g.edges[bl.params.crestEdge];
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
    const rx = (B.x - A.x) / len;
    const rz = (B.z - A.z) / len;
    const cx = bl.params.cx;
    const cz = bl.params.cz;
    const half = e.width / 2 + e.sidewalk;
    const pr = projectOnCurve(curve, cx, cz);
    const P = sampleCurve(curve, pr.s, curvePoint());
    // Street against track: sin of the crossing angle, and where each track crosses the street line.
    const cross = rx * P.tz - rz * P.tx;
    const sinX = Math.max(0.3, Math.abs(cross));
    const cosX = Math.abs(rx * P.tx + rz * P.tz);
    const along = (lat: number) => {
      // Track line: P + p lat + t w; street line: C + r u. Solve for u.
      const ox = P.x + P.px * lat - cx;
      const oz = P.z + P.pz * lat - cz;
      return (ox * P.tz - oz * P.tx) / cross;
    };
    const tracks: [number, number] = [along(trackLateral(curve, 0, pr.s)), along(trackLateral(curve, 1, pr.s))];
    // Gate lines clear of the trains across the whole corridor, however skewed the crossing.
    const gate = Math.max(Math.abs(tracks[0]), Math.abs(tracks[1])) + (CROSSING.trainHalf + CROSSING.gateClear) / sinX + (half * cosX) / sinX;
    // The corridor a train fills along its track, and when each direction's trains are in it.
    const wT = half / sinX + CROSSING.margin;
    const L = trainLength();
    const period = Math.round(services[0].sv.headway * TRAIN.pattern * TICK_HZ);
    const T = (s: number) => Math.round(s * TICK_HZ);
    const wins: { start: number; closed: number; at: number; len: number; track: 0 | 1 }[] = [];
    for (const { sv, track } of services) {
      const st = sv.dir === 1 ? pr.s : sv.length - pr.s;
      const tA0 = tauAt(sv.run, st - wT);
      const tD0 = tauAt(sv.run, st + wT + L);
      // One closure per running trip of the pattern (the pattern repeats every period).
      for (let k = 0; k < TRAIN.pattern; k++) {
        if (!tripRuns(sv, k)) continue;
        const t0 = sv.phase + k * sv.headway;
        const down = t0 + tA0 - CROSSING.downBefore;
        const start = down - CROSSING.lower - CROSSING.warn;
        const closed = t0 + tD0 + CROSSING.upAfter - down;
        wins.push({ start: T(start), closed: T(closed), at: T(t0 + tA0), len: Math.max(1, T(tD0 - tA0)), track });
      }
    }
    // Order the closures around the period from the earliest, merge any that overlap or nearly do.
    const mod = (t: number) => ((t % period) + period) % period;
    for (const w of wins) {
      w.at = w.at - w.start;
      w.start = mod(w.start);
    }
    wins.sort((p, q) => p.start - q.start || p.track - q.track);
    const lenOf = (closed: number) => T(CROSSING.warn) + T(CROSSING.lower) + closed + T(CROSSING.raise);
    const merged: { start: number; closed: number }[] = [];
    for (const w of wins) {
      const last = merged[merged.length - 1];
      if (last && w.start < last.start + lenOf(last.closed) + T(CROSSING.mergeGap)) {
        last.closed = Math.max(last.closed, w.start + w.closed - last.start);
        continue;
      }
      merged.push({ start: w.start, closed: w.closed });
    }
    // The last closure wrapping into the first one's next occurrence joins it too.
    while (merged.length > 1) {
      const last = merged[merged.length - 1];
      const first = merged[0];
      if (last.start + lenOf(last.closed) + T(CROSSING.mergeGap) <= first.start + period) break;
      first.closed = Math.max(first.closed + first.start + period - last.start, last.closed);
      first.start = last.start;
      merged.pop();
    }
    // The cycle starts with its first closure, a period before tick 0 at the latest, so a train already
    // on its way at the green light finds the gates as the timetable has them.
    merged.sort((p, q) => p.start - q.start);
    const base = merged[0].start;
    const cycle: GateCycle = {
      period,
      start: base - period,
      warn: T(CROSSING.warn),
      lower: T(CROSSING.lower),
      closed: merged[0].closed,
      raise: T(CROSSING.raise),
    };
    if (merged.length > 1) cycle.more = merged.slice(1).map((m) => ({ at: mod(m.start - base), closed: m.closed }));
    const ci = set.cycles.length;
    set.cycles.push(cycle);
    const gates: number[] = [];
    const nx = -rz;
    const nz = rx;
    for (const s of [-1, 1]) {
      // Across the street from frontage to frontage, holding back the traffic coming from this side.
      const gx = cx + rx * s * gate;
      const gz = cz + rz * s * gate;
      gates.push(set.gates.length);
      set.gates.push(makeGate(gx - nx * half, gz - nz * half, gx + nx * half, gz + nz * half, rx * s, rz * s, 'gate', ci));
    }
    const trains = wins.map((w) => ({ at: mod(w.start + w.at - base), len: w.len, track: w.track }));
    const trainCycle = set.cycles.length;
    set.cycles.push(passCycle(trains, cycle, T(CROSSING.aiLead), T(CROSSING.aiAfter)));
    for (const k of gates) set.gates[k].train = trainCycle;
    out.push({ area: bl.id, edge: e.id, x: cx, z: cz, rx, rz, tx: P.tx, tz: P.tz, half, gate, tracks, y: bl.params.y, s: pr.s, cycle: ci, gates, trainCycle, trains });
  }
  return out;
}

/**
 * The cycle racers time a crossing by: no warning and no arms, blocking from
 * `lead` ticks before each train is on the street until `after` ticks after
 * it has gone, with trains that close up (or wrap round the period into the
 * first) merged, as GateCycle.more requires. Starts `lead` ticks before the
 * gate cycle, so each train's `at` is its window's start.
 */
function passCycle(trains: LevelCrossing['trains'], gate: GateCycle, lead: number, after: number): GateCycle {
  const period = gate.period;
  const wins = trains.map((t) => ({ at: t.at, end: t.at + lead + t.len + after })).sort((p, q) => p.at - q.at);
  const merged: { at: number; end: number }[] = [];
  for (const w of wins) {
    const last = merged[merged.length - 1];
    if (last && w.at <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  while (merged.length > 1 && merged[merged.length - 1].end >= merged[0].at + period) {
    const last = merged.pop()!;
    merged[0] = { at: last.at - period, end: Math.max(merged[0].end, last.end - period) };
  }
  const first = merged[0];
  const c: GateCycle = { period, start: gate.start - lead + first.at, warn: 0, lower: 0, closed: first.end - first.at, raise: 0 };
  if (merged.length > 1) c.more = merged.slice(1).map((m) => ({ at: m.at - first.at, closed: m.end - m.at }));
  return c;
}

/** The track (0 or 1) a train occupies the crossing on at `tick`, or -1 (2 when both are). */
export function crossingTrain(c: LevelCrossing, cycle: GateCycle, tick: number): number {
  const u0 = tick - cycle.start;
  const u = u0 - Math.floor(u0 / cycle.period) * cycle.period;
  let on = -1;
  for (const w of c.trains) {
    let d = u - w.at;
    if (d < 0) d += cycle.period;
    if (d < w.len) on = on < 0 ? w.track : on === w.track ? on : 2;
  }
  return on;
}
