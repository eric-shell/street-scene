/**
 * Frame-time sampling for the `perf` event: how the game actually runs on this device while the player drives.
 * Frames go into a preallocated histogram (0.25 ms bins up to 100 ms, one overflow bin), so a frame costs a
 * couple of integer operations and nothing is allocated; the median and 95th percentile are read from it once,
 * when the stretch ends. Only driving frames are fed in (drive.ts): menus, pauses, loading and a hidden tab
 * would drag the numbers toward what the player is not doing. The quality fields come from the auto quality
 * controller (render/autoQuality.ts), which is what decides whether those numbers are acceptable.
 */
import { FRAME_BUDGET, QUALITY_LEVELS } from '../render/autoQuality';
import type { PerfMeta } from '../shared/analytics';

const BIN_MS = 0.25;
const BINS = 400;
/** Frames longer than this are a stall (a tab frozen, a debugger), not performance, and are not counted. */
const STALL_S = 5;
/** Fewer frames than this (about two seconds) say nothing, and no summary is sent. */
export const MIN_FRAMES = 120;

const hist = new Uint32Array(BINS + 1);
let frames = 0;
let slow = 0;

export function resetPerf(): void {
  hist.fill(0);
  frames = 0;
  slow = 0;
}

/** One driving frame of `dt` seconds. O(1), no allocation. */
export function samplePerf(dt: number): void {
  if (!(dt > 0) || dt > STALL_S) return;
  const bin = (dt * 1000) / BIN_MS;
  hist[bin >= BINS ? BINS : bin | 0]++;
  frames++;
  if (dt > FRAME_BUDGET.floor) slow++;
}

/** The ms at quantile `q` (0-1), the upper edge of the bin it falls in. */
function quantileMs(q: number): number {
  const target = Math.ceil(frames * q);
  let seen = 0;
  for (let i = 0; i <= BINS; i++) {
    seen += hist[i];
    if (seen >= target) return (i + 1) * BIN_MS;
  }
  return BINS * BIN_MS;
}

/** The frame-time summary so far, or null when there are too few frames to mean anything. */
export function perfSummary(reason: PerfMeta['reason'], mode: PerfMeta['mode'], q: { level: number; auto: boolean; aim: number }): PerfMeta | null {
  if (frames < MIN_FRAMES) return null;
  const level = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, q.level));
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    reason,
    mode,
    level,
    tier: QUALITY_LEVELS[level].tier,
    auto: q.auto,
    aimFps: Math.round(1 / q.aim),
    medianFps: round1(1000 / quantileMs(0.5)),
    p95FrameMs: round1(quantileMs(0.95)),
    slowShare: Math.round((slow / frames) * 1000) / 1000,
    frames,
  };
}
