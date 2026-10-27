/**
 * The night's weather over time, as pure functions of the seed and the scene clock (render only; the sim never
 * knows, so replays stay valid and a replay turns the same way). weather.ts picks one mood per seed; this
 * module says whether and when that mood turns during the first minutes:
 *  - the turn: about a third of seeds get exactly one step to a neighbouring mood (clear to hazy, hazy to
 *    drizzle, misty to drizzle, drizzle to rain, rain easing off to drizzle), starting a minute or more in
 *    and taking 40 to 90 s, eased with a smoothstep so the slope stays gentle at both ends. Never two steps,
 *    never a jump across moods;
 *  - the gusts: a few seconds of 1.5 to 2 times the wind, one candidate per fixed slot of the clock, more
 *    likely and stronger the wetter the night, shaped as a smooth bump;
 *  - the moon's veil: slow cloud noise drifting across the moon (dimming it and its halo), deeper as the sky
 *    clouds over, so even a clear seed's moon breathes;
 *  - `CumulativeIntegral`: the running integral of a rate that changes with the clock (the rain's wind and
 *    fall speed), tabulated at a fixed step so the same time always gives the same answer whatever the frame
 *    rate or the order the frames arrive in. Streaks displaced by the integral never jump when the rate does.
 * Every function here depends on its arguments only: no state that frame rate could reach.
 */
import { Rng, deriveSeed } from '../../sim/prng';
import { clamp01, smoothstep } from '../../sim/math';
import type { MoodId } from './weather';

/** Where the weather goes and how it gusts. */
export const WEATHER_TURN = {
  /** Share of seeds whose mood turns once during the first `window` seconds. */
  chance: 0.35,
  /** The turn has finished by this scene time at the latest (s): start + duration never exceeds it. */
  window: 360,
  /** When the turn starts (s) and how long it takes (s), [min, max]. */
  start: [60, 240] as [number, number],
  duration: [40, 90] as [number, number],
  /** The one step each mood can take. */
  next: { clear: 'hazy', hazy: 'drizzle', misty: 'drizzle', drizzle: 'rain', rain: 'drizzle' } as Record<MoodId, MoodId>,
  /** Per mood: how far the trees lean in the wind (1 = the calm-night sway they always had) and how gusty the air is 0..1. */
  wind: {
    clear: { sway: 1, gusty: 0.15 },
    hazy: { sway: 1.1, gusty: 0.3 },
    misty: { sway: 0.9, gusty: 0.2 },
    drizzle: { sway: 1.3, gusty: 0.7 },
    rain: { sway: 1.7, gusty: 1 },
  } as Record<MoodId, { sway: number; gusty: number }>,
  /** Gusts: the slot length (s, one candidate gust per slot), how long one lasts (s), [min, max]. */
  gustSlot: 25,
  gustLength: [3, 6] as [number, number],
  /** Chance a slot holds a gust at gustiness 0 and 1 (about 50 s apart calm, 25 s apart in the rain), and the peak extra wind at each end (1 = double). */
  gustChance: [0.5, 1] as [number, number],
  gustPeak: [0.5, 1] as [number, number],
  /** The moon's veil: cloud noise cells per second of the slow and the fast octave, and the veil's depth (0..1) at overcast 0 and 1. */
  veilRate: [0.03, 0.085] as [number, number],
  veilDepth: [0.3, 0.95] as [number, number],
  /** Step (s) of the integrated tables. */
  tableStep: 0.25,
} as const;

/** The mood the night is in at a moment: a blend `t` (0..1) of the way from `from` to `to`. */
export interface MoodBlend {
  from: MoodId;
  to: MoodId;
  t: number;
}

/** One transition: `from` to `to`, starting at `at` (s) and lasting `duration` (s). */
export interface WeatherTurn {
  from: MoodId;
  to: MoodId;
  at: number;
  duration: number;
}

export interface WeatherTimeline {
  /** The seed's mood: where the night starts. */
  readonly start: MoodId;
  /** The one transition, or null when the night stays as it is. */
  readonly turn: WeatherTurn | null;
  /** The blend at scene time `time` (s); written into `out` when given. Before the turn it is `{ start, start, 0 }`, after it `{ start, to, 1 }`. */
  moodAt(time: number, out?: MoodBlend): MoodBlend;
}

/** The weather timeline of a seed whose mood (pickMood) is `start`. A pure function of both. */
export function weatherTimeline(seed: number, start: MoodId): WeatherTimeline {
  const rng = new Rng(deriveSeed(seed, 'weatherTurn'));
  // Every draw happens whether or not the seed turns, so the odds never shift the timing.
  const turns = rng.next() < WEATHER_TURN.chance;
  const at = rng.range(WEATHER_TURN.start[0], WEATHER_TURN.start[1]);
  const duration = rng.range(WEATHER_TURN.duration[0], WEATHER_TURN.duration[1]);
  const turn: WeatherTurn | null = turns ? { from: start, to: WEATHER_TURN.next[start], at, duration } : null;
  return {
    start,
    turn,
    moodAt(time, out = { from: start, to: start, t: 0 }) {
      out.from = start;
      out.to = turn ? turn.to : start;
      out.t = turn ? smoothstep(turn.at, turn.at + turn.duration, time) : 0;
      return out;
    },
  };
}

/** A hash of a seed and a slot to 0..1, stable across platforms (integer maths only). */
function hash01(seed: number, k: number, salt: number): number {
  let h = Math.imul(k + 1, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1) ^ Math.imul(salt + 1, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * The gust factor at `time`: 1 in steady air, up to 1.5 to 2 at the crest of a gust. `gusty` (0..1) is how
 * often and how hard the air gusts. The clock is cut into slots; each holds at most one gust at a seeded
 * moment, wholly inside the slot, so gusts never overlap and the factor is a pure function of (seed, time).
 */
export function gustAt(seed: number, time: number, gusty: number): number {
  const g = clamp01(gusty);
  const slot = Math.floor(time / WEATHER_TURN.gustSlot);
  if (slot < 0) return 1;
  if (hash01(seed, slot, 0) >= WEATHER_TURN.gustChance[0] + (WEATHER_TURN.gustChance[1] - WEATHER_TURN.gustChance[0]) * g) return 1;
  const len = WEATHER_TURN.gustLength[0] + hash01(seed, slot, 1) * (WEATHER_TURN.gustLength[1] - WEATHER_TURN.gustLength[0]);
  const from = slot * WEATHER_TURN.gustSlot + hash01(seed, slot, 2) * (WEATHER_TURN.gustSlot - len);
  const x = (time - from) / len;
  if (x <= 0 || x >= 1) return 1;
  const peak = WEATHER_TURN.gustPeak[0] + (WEATHER_TURN.gustPeak[1] - WEATHER_TURN.gustPeak[0]) * g * (0.7 + 0.3 * hash01(seed, slot, 3));
  const s = Math.sin(Math.PI * x);
  return 1 + peak * s * s;
}

/** Smooth value noise on the integers of x, 0..1. */
function valueNoise(seed: number, salt: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed, i, salt);
  const b = hash01(seed, i + 1, salt);
  return a + (b - a) * u;
}

/**
 * How much of the moon shows through the clouds drifting over it, 1 clear to 0 hidden: two octaves of slow noise
 * on the clock, thresholded into banks, as deep as the sky's `overcast` (0..1) allows. At overcast 0 a thin
 * veil still passes now and then, so a clear night's moon breathes.
 */
export function moonVeil(seed: number, time: number, overcast: number): number {
  const n = 0.65 * valueNoise(seed, 11, time * WEATHER_TURN.veilRate[0]) + 0.35 * valueNoise(seed, 12, time * WEATHER_TURN.veilRate[1]);
  const depth = WEATHER_TURN.veilDepth[0] + (WEATHER_TURN.veilDepth[1] - WEATHER_TURN.veilDepth[0]) * clamp01(overcast);
  return 1 - depth * smoothstep(0.4, 0.75, n);
}

/**
 * The running integral of `rate(t)` from 0, tabulated every `WEATHER_TURN.tableStep` seconds (trapezoid) and
 * interpolated between entries. The table grows on demand and never depends on which times were asked for,
 * so `at(t)` is a pure function of t; it is continuous wherever `rate` is, whatever the frame rate.
 */
export class CumulativeIntegral {
  private table = new Float64Array(256);
  private filled = 1;
  private last: number;
  constructor(private readonly rate: (t: number) => number) {
    this.last = rate(0);
  }

  at(t: number): number {
    if (t <= 0) return t * this.rate(0);
    const step = WEATHER_TURN.tableStep;
    const k = Math.floor(t / step);
    while (this.filled <= k + 1) {
      if (this.filled >= this.table.length) {
        const bigger = new Float64Array(this.table.length * 2);
        bigger.set(this.table);
        this.table = bigger;
      }
      const r = this.rate(this.filled * step);
      this.table[this.filled] = this.table[this.filled - 1] + 0.5 * (this.last + r) * step;
      this.last = r;
      this.filled++;
    }
    const f = t / step - k;
    return this.table[k] + (this.table[k + 1] - this.table[k]) * f;
  }
}
