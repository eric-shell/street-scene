/**
 * The police helicopter's brief, pure and render side: its tuning (POLICE),
 * when it chases and whom (policeChaseCall, a read of RaceState that never
 * writes it), and its patrol loop's waypoints. The helicopter itself (body,
 * light bar, searchlight, the follow) is drawn by airTraffic.ts; the session
 * asks for the call every tick and hands the leader's interpolated pose over.
 *
 * Patrol until the leader starts the last lap of a circuit of two laps or
 * more (on a sprint or a one lap circuit, the last stretch of the race), then
 * chase the leader, through the finish and for a few seconds after it, then
 * leave. Free roam and the countdown are always patrol.
 */
import type { World } from '../city/world';
import { routeSample } from '../city/route';
import type { RaceCar, RaceState } from '../sim/race';
import { TICK_HZ } from '../sim/constants';
import { Rng, deriveSeed } from '../sim/prng';
import type { P3 } from './airTraffic';

export const POLICE = {
  /** Patrol: cruise speed (m/s), altitude band over the course (m) and how many points along it the loop passes. */
  patrolSpeed: 30,
  patrolAlt: [135, 170] as [number, number],
  patrolPoints: 5,
  /**
   * When the chase starts: the leader's last lap on a circuit of two laps or more, otherwise the
   * last `stretchShare` of the race distance (at least `stretchMin` m). It lingers over the
   * winner this long after the finish (s), then leaves.
   */
  stretchShare: 0.35,
  stretchMin: 500,
  linger: 6,
  /** Chase station: behind the leader along its travel (m), off to one side (m), above the ground (m). */
  behind: 24,
  side: 9,
  alt: 36,
  /** Follow: natural frequency (rad/s, critically damped), sideways acceleration cap (m/s^2), speed cap (m/s); height on its own spring (rad/s) and cap (m/s^2). */
  omega: 0.85,
  accel: 26,
  omegaY: 1.4,
  climb: 30,
  vMax: 92,
  /** Back on the patrol loop once this close to it (m) and this close to its speed (m/s). */
  rejoin: 6,
  /** Smoothing of heading, bank and pitch (s), bank per g of sideways pull, the most bank (rad) and nose down pitch (rad). */
  turnLag: 0.35,
  bankGain: 0.8,
  maxBank: 0.42,
  maxPitch: 0.32,
  /**
   * Rooftops: a raster of the tallest roof per cell (m) with spires and crowns allowed for (x of the
   * building height), the clearance kept over it (m), and the times ahead along its velocity it looks (s).
   */
  roofCell: 12,
  roofSpire: 1.25,
  roofClear: 10,
  roofLook: [0.6, 1.4, 2.6],
  /** Searchlight: cone radius at the target (m), ground pool radius (m), brightness, reach (m), aim lag (s). */
  beamRadius: 4.2,
  spotR: 7.8,
  intensity: 1.9,
  reach: 240,
  aimLag: 0.12,
  /** Lights and beam fade on and off over about this long (s). */
  fade: 0.5,
  /** Rotor voice (sfx HeliRotor): a faster, harder chop than the news helicopter's. */
  rotor: { bladeHz: 12.8, bodyHz: 250, whineHz: 2100, level: 0.4 },
  /** Rotor sound: silent beyond `hear` m, full within `near` m. */
  hear: 360,
  near: 60,
} as const;

export type ChasePhase = 'patrol' | 'chase' | 'leave';

/** What the police helicopter should be doing this tick, read from the race. */
export interface ChaseCall {
  phase: ChasePhase;
  /** Car the searchlight follows (RaceState.cars index), -1 on patrol. */
  car: number;
}

const PATROL: ChaseCall = { phase: 'patrol', car: -1 };

/** Race order as standings() sorts it: finished cars by finish tick, then by distance, ties by index. */
function ahead(a: RaceCar, b: RaceCar): boolean {
  if (a.finished && b.finished) return a.finishTick < b.finishTick || (a.finishTick === b.finishTick && a.index < b.index);
  if (a.finished !== b.finished) return a.finished;
  return a.dist > b.dist || (a.dist === b.dist && a.index < b.index);
}

/** The race leader (standings() first place) without sorting or allocating. */
export function raceLeader(r: RaceState): RaceCar {
  let best = r.cars[0];
  for (const c of r.cars) if (ahead(c, best)) best = c;
  return best;
}

/**
 * Pure: patrol until the leader starts the last lap (or the last stretch),
 * then chase the leader, until `linger` s after the leader finished, then
 * leave. Free roam and the countdown are always patrol.
 */
export function policeChaseCall(r: RaceState): ChaseCall {
  if (r.config.openWorld || r.tick < r.countdownTicks || !r.cars.length) return PATROL;
  const lead = raceLeader(r);
  if (lead.finished) return { phase: r.tick - lead.finishTick <= POLICE.linger * TICK_HZ ? 'chase' : 'leave', car: lead.index };
  const lapped = r.world.route.closed && r.config.laps > 1;
  const last = lapped ? lead.lap >= r.config.laps : r.distance - lead.dist <= Math.max(POLICE.stretchMin, r.distance * POLICE.stretchShare);
  return last ? { phase: 'chase', car: lead.index } : PATROL;
}

/** Where the chase target is this frame (the leader's interpolated pose). */
export interface ChaseTarget {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
}

/** The patrol loop: high passes over seeded points along the course. */
export function policeWaypoints(world: World, seed: number): P3[] {
  const rng = new Rng(deriveSeed(seed, 'policeHeli'));
  const route = world.route;
  const out: P3[] = [];
  const n = POLICE.patrolPoints;
  for (let k = 0; k < n; k++) {
    const p = routeSample(route, ((k + rng.range(0.2, 0.8)) / n) * route.length);
    // Off to either side of the course, so the loop does not shadow the route exactly.
    const off = rng.range(-90, 90);
    const x = p.x + p.tz * off;
    const z = p.z - p.tx * off;
    out.push({ x, y: world.heightAt(x, z) + rng.range(POLICE.patrolAlt[0], POLICE.patrolAlt[1]), z });
  }
  return out;
}
