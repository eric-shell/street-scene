/**
 * Everything the game counts about a player across races, for Settings › Stats and the economy's unlocks
 * (shared/economy.ts gates parts on races finished). Recorded once per finished live race at main.ts's finish
 * handler, and once per free roam drive; replays and debug-tuned runs record nothing, as with points, so a
 * number here is always one the player drove. One store key, `stats.v1`, synced by an account
 * (account/cloudSave.ts). Every field is a counter that only grows, or a best that only improves, so two
 * devices merge field by field without a server: the larger counter wins, and the better best (the lower
 * finishing place). Counters taken as a max can miss a race driven on each of two offline devices; that
 * undercount is the price of never double counting, and it only ever errs toward fewer races.
 */
import { loadJson, saveJson } from './store';
import type { RaceMode } from '../sim/race';

/** The store key (without the `nightrun.` prefix). */
export const STATS_KEY = 'stats.v1';

/** The race modes counted apart, in the order Settings › Stats lists them. */
export const STAT_MODES = ['circuit', 'sprint', 'drift', 'drag', 'waypoint'] as const satisfies readonly RaceMode[];

/** The saved document. */
export interface StatsSave {
  /** Races finished, every mode. */
  races: number;
  /** Races finished per mode. */
  byMode: Record<RaceMode, number>;
  /** Races won against rivals (1st with at least one rival on the grid; a solo run is not a win). */
  wins: number;
  /** Races finished in the top three against rivals. */
  podiums: number;
  /** The best place finished against rivals (1 is first; 0 before any race with rivals). */
  bestFinish: number;
  /** Time spent racing, start line to finish, every race added up (s). */
  raceTime: number;
  /** Distance driven in races, along the route (m). */
  distance: number;
  /** Every drift race's score added up (points). */
  driftScore: number;
  /** The best single run's points (points; the ledger keeps the same best, this one is for the stats page). */
  bestRun: number;
  /** Points lost to crashes, every race added up (points, the callouts tally's crash line). */
  crashPoints: number;
  /** Free roam drives started. */
  freeRoams: number;
}

/** One finished race, as the finish handler hands it in. */
export interface RaceRecord {
  mode: RaceMode;
  /** The player's place (1 first). */
  place: number;
  /** Cars on the grid, the player included. */
  entrants: number;
  /** Start to finish (s). */
  time: number;
  /** Route distance covered (m). */
  distance: number;
  /** The drift score (drift races; 0 otherwise). */
  driftScore: number;
  /** The run's points. */
  points: number;
  /** Points the run's crashes cost. */
  crashPoints: number;
}

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);
const whole = (n: unknown) => Math.round(count(n));

function emptyModes(): Record<RaceMode, number> {
  return Object.fromEntries(STAT_MODES.map((m) => [m, 0])) as Record<RaceMode, number>;
}

/** A save from storage or another device, cleaned: anything missing or wrong reads 0. */
export function cleanStats(v: unknown): StatsSave {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<Record<keyof StatsSave, unknown>>;
  const modes = (o.byMode && typeof o.byMode === 'object' ? o.byMode : {}) as Record<string, unknown>;
  const byMode = emptyModes();
  for (const m of STAT_MODES) byMode[m] = whole(modes[m]);
  return {
    races: whole(o.races),
    byMode,
    wins: whole(o.wins),
    podiums: whole(o.podiums),
    bestFinish: whole(o.bestFinish),
    raceTime: count(o.raceTime),
    distance: count(o.distance),
    driftScore: whole(o.driftScore),
    bestRun: whole(o.bestRun),
    crashPoints: whole(o.crashPoints),
    freeRoams: whole(o.freeRoams),
  };
}

/** The saved stats, 0s when nothing is stored. */
export function loadStats(): StatsSave {
  return cleanStats(loadJson<unknown>(STATS_KEY, null));
}

/** Races finished, the number the economy's unlocks read. */
export const racesForUnlocks = (s: StatsSave = loadStats()): number => s.races;

/** Adds one finished race. Returns the stats after. */
export function recordRace(r: RaceRecord): StatsSave {
  const s = loadStats();
  const rivals = r.entrants > 1;
  const place = Math.max(1, Math.round(r.place));
  s.races++;
  s.byMode[r.mode] = (s.byMode[r.mode] ?? 0) + 1;
  if (rivals) {
    if (place === 1) s.wins++;
    if (place <= 3) s.podiums++;
    s.bestFinish = s.bestFinish > 0 ? Math.min(s.bestFinish, place) : place;
  }
  s.raceTime += count(r.time);
  s.distance += count(r.distance);
  s.driftScore += whole(r.driftScore);
  s.bestRun = Math.max(s.bestRun, whole(r.points));
  s.crashPoints += whole(r.crashPoints);
  saveJson(STATS_KEY, s);
  return s;
}

/** Counts one free roam drive. */
export function recordFreeRoam(): void {
  const s = loadStats();
  s.freeRoams++;
  saveJson(STATS_KEY, s);
}

/** Two saves merged: the larger of each counter, the better (lower, set) best finish. */
export function mergeStats(a: unknown, b: unknown): StatsSave {
  const x = cleanStats(a);
  const y = cleanStats(b);
  const byMode = emptyModes();
  for (const m of STAT_MODES) byMode[m] = Math.max(x.byMode[m], y.byMode[m]);
  const best = [x.bestFinish, y.bestFinish].filter((n) => n > 0);
  return {
    races: Math.max(x.races, y.races),
    byMode,
    wins: Math.max(x.wins, y.wins),
    podiums: Math.max(x.podiums, y.podiums),
    bestFinish: best.length ? Math.min(...best) : 0,
    raceTime: Math.max(x.raceTime, y.raceTime),
    distance: Math.max(x.distance, y.distance),
    driftScore: Math.max(x.driftScore, y.driftScore),
    bestRun: Math.max(x.bestRun, y.bestRun),
    crashPoints: Math.max(x.crashPoints, y.crashPoints),
    freeRoams: Math.max(x.freeRoams, y.freeRoams),
  };
}
