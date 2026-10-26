/**
 * The life of one driving session for analytics (a race, a replay or free roam): `race_start` when it begins,
 * then either `race_finish` (main.ts sends it, then calls `endDrive` as finished) or `race_quit` when it is left
 * early, and a `perf` summary either way. The frame loop calls `driveFrame` every frame; frames count only while
 * the car is being driven (not paused, not finished), which is also what the visit's race time accrues from.
 * Pure bookkeeping beside the sim: it reads nothing from `RaceState` itself, main.ts hands it the numbers.
 */
import type { RaceStartMeta } from '../shared/analytics';
import { perfSummary, resetPerf, samplePerf } from './perf';
import { addRaceMs, onPageHide, track } from './telemetry';

/** What the auto quality controller says right now (main.ts's `autoQ` and the auto setting). */
export interface QualityReader {
  level: number;
  auto: boolean;
  /** Seconds per frame, as AutoQualityController.aim. */
  aim: number;
}

interface Drive {
  meta: RaceStartMeta;
  /** Time spent driving, in ms. */
  drivenMs: number;
  /** Route progress 0-1, or undefined for free roam. */
  progress: () => number | undefined;
}

let drive: Drive | null = null;
let readQuality: (() => QualityReader) | null = null;

/** Gives the drive the auto quality state to attach to its perf summary. Call once at boot. */
export function setQualityReader(fn: () => QualityReader): void {
  readQuality = fn;
}

/** A session began: sends `race_start` and starts a fresh frame histogram. */
export function beginDrive(meta: RaceStartMeta, progress: () => number | undefined): void {
  endDrive('restart');
  resetPerf();
  drive = { meta, drivenMs: 0, progress };
  track('race_start', meta);
}

/** One rendered frame. `driving` is true only while the player's car is being driven. */
export function driveFrame(dt: number, driving: boolean): void {
  if (!drive || !driving || dt > 1) return;
  drive.drivenMs += dt * 1000;
  addRaceMs(dt * 1000);
  samplePerf(dt);
}

function sendPerf(reason: 'race_end' | 'pagehide', via: 'fetch' | 'beacon'): void {
  if (!drive || !readQuality) return;
  const p = perfSummary(reason, drive.meta.mode, readQuality());
  if (p) track('perf', p, via);
}

function sendQuit(d: Drive, reason: 'quit' | 'restart' | 'pagehide', via: 'fetch' | 'beacon'): void {
  if (d.meta.replay || d.drivenMs <= 1000) return;
  const p = d.progress();
  track('race_quit', { mode: d.meta.mode, seed: d.meta.seed, carId: d.meta.carId, elapsedMs: Math.round(d.drivenMs), reason, ...(p !== undefined ? { progress: Math.round(p * 1000) / 1000 } : {}) }, via);
}

/**
 * The session ended: `finished` when the player crossed the line (main.ts has sent `race_finish`); otherwise a
 * live drive that lasted a moment is a `race_quit`. Replays send no quit. Safe to call with nothing running.
 */
export function endDrive(how: 'finished' | 'quit' | 'restart'): void {
  const d = drive;
  if (!d) return;
  if (how !== 'finished') sendQuit(d, how, 'fetch');
  sendPerf('race_end', 'fetch');
  drive = null;
}

// The page closing mid-drive: the same quit and summary by beacon, once.
onPageHide(() => {
  const d = drive;
  if (!d) return;
  sendQuit(d, 'pagehide', 'beacon');
  sendPerf('pagehide', 'beacon');
  drive = null;
});
