/**
 * Auto graphics quality.
 *
 * A ladder of quality levels finer than the three presets (render scale and
 * pixel ratio first, then bloom resolution, then point lights and MSAA), an
 * initial guess from device heuristics, and a controller that watches frame
 * times during gameplay and steps the level up or down with hysteresis,
 * cooldowns and probe backoff. The last good level is remembered per device.
 *
 * The controller itself is pure (time comes from the frame deltas it is fed)
 * so it can be unit tested; the DOM bits are the device probe and storage.
 *
 * Frame-rate policy (FRAME_BUDGET): aim for 120 fps, hold 60 fps, never sit
 * below 30 fps. Quality is bought only with headroom at the aim (or at the
 * display's refresh rate when that is lower), sold as soon as 60 slips, and
 * dumped two levels at a time below 30. Between 60 and the aim the controller
 * holds what it has: frames above 60 are nice, more quality is nicer.
 */
import { QUALITY, Quality, QualityProfile } from '../ui/settings';

/**
 * Frame-rate targets in seconds per frame. Every per-frame cost in the game
 * is budgeted against these three lines (CLAUDE.md says what they mean for
 * new work); the controller, the FPS meter and the docs all read them here.
 */
export const FRAME_BUDGET = {
  /** 120 fps (8.3 ms): the goal on capable hardware and a fast display. The controller probes for more quality only when frames sit here (or at the display's refresh when that is slower). */
  aim: 1 / 120,
  /** 60 fps (16.7 ms): what every supported device should hold. Below it the controller steps down. */
  hold: 1 / 60,
  /** 30 fps (33.3 ms): never acceptable. At it the controller drops two levels on the first bad evaluation. */
  floor: 1 / 30,
} as const;

export interface QualityLevel extends QualityProfile {
  /** Preset tier this level belongs to: drives labels and scene density. */
  tier: Quality;
}

/**
 * Lowest to highest. Levels 1, 4 and 7 are exactly the Low / Medium / High
 * presets. Point light counts only change at tier boundaries, because a new
 * light count recompiles every lit shader.
 */
export const QUALITY_LEVELS: QualityLevel[] = [
  { tier: 'low', pixelRatioCap: 1, renderScale: 0.55, bloom: true, bloomScale: 0.25, bloomStrength: 0.75, pointLights: 0, antialias: false },
  { tier: 'low', ...QUALITY.low },
  { tier: 'low', pixelRatioCap: 1.25, renderScale: 0.8, bloom: true, bloomScale: 0.35, bloomStrength: 0.8, pointLights: 0, antialias: false },
  { tier: 'medium', pixelRatioCap: 1.25, renderScale: 0.85, bloom: true, bloomScale: 0.45, bloomStrength: 0.85, pointLights: 4, antialias: false },
  { tier: 'medium', ...QUALITY.medium },
  { tier: 'medium', pixelRatioCap: 1.75, renderScale: 0.95, bloom: true, bloomScale: 0.6, bloomStrength: 0.95, pointLights: 4, antialias: false },
  { tier: 'high', pixelRatioCap: 2, renderScale: 0.9, bloom: true, bloomScale: 0.6, bloomStrength: 1.0, pointLights: 8, antialias: true },
  { tier: 'high', ...QUALITY.high },
];

export const MAX_LEVEL = QUALITY_LEVELS.length - 1;
export const PRESET_LEVEL: Record<Quality, number> = { low: 1, medium: 4, high: 7 };
export const TIER_LABEL: Record<Quality, string> = { low: 'Low', medium: 'Medium', high: 'High' };

// ---------------------------------------------------------------------------
// Device heuristics
// ---------------------------------------------------------------------------
export interface DeviceInfo {
  touch: boolean;
  coarsePointer: boolean;
  dpr: number;
  cores: number;
  /** navigator.deviceMemory in GB (Chromium only, capped at 8). */
  memoryGb: number | null;
  /** Unmasked GPU renderer string when the browser exposes it. */
  gpu: string;
  /** Screen size in CSS pixels. */
  screenW: number;
  screenH: number;
}

export function readDeviceInfo(gl?: WebGLRenderingContext | WebGL2RenderingContext | null): DeviceInfo {
  let gpu = '';
  try {
    if (gl) {
      gpu = String(gl.getParameter(gl.RENDERER) ?? '');
      // Chromium masks RENDERER as "WebKit WebGL"; the debug extension has the real name.
      if (!gpu || /^webkit/i.test(gpu)) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? gpu);
      }
    }
  } catch {
    /* some privacy modes throw */
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  let coarse = false;
  try {
    coarse = matchMedia('(pointer: coarse)').matches;
  } catch {
    /* old browsers */
  }
  return {
    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    coarsePointer: coarse,
    dpr: window.devicePixelRatio || 1,
    cores: navigator.hardwareConcurrency || 0,
    memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    gpu,
    screenW: screen.width || window.innerWidth,
    screenH: screen.height || window.innerHeight,
  };
}

/** First guess at a level before any frame has been measured. */
export function guessLevel(d: DeviceInfo): number {
  const g = d.gpu.toLowerCase();
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) return 0;
  const mobile = d.touch && d.coarsePointer && Math.min(d.screenW, d.screenH) <= 1100;
  let level: number;
  if (mobile) {
    level = 1;
    if (/apple gpu|apple a1[5-9]|apple m\d|adreno[^0-9]*(7[3-9]\d|8\d\d)|immortalis|mali-g7[1-9]\d|xclipse/.test(g)) level = 3;
    else if (/adreno[^0-9]*(6[4-9]\d|7\d\d)|mali-g[67]\d/.test(g)) level = 2;
    if ((d.memoryGb !== null && d.memoryGb <= 2) || (d.cores > 0 && d.cores <= 4)) level -= 1;
  } else {
    level = 4;
    if (/nvidia|geforce|quadro|rtx|gtx|radeon\s*(\(tm\)\s*)?(rx|pro)|apple m\d (pro|max|ultra)|arc\(tm\) a\d|arc a\d/.test(g)) level = 7;
    else if (/apple m\d|radeon|iris xe/.test(g)) level = 5;
    else if (/intel.*(hd|uhd) graphics|mali|adreno|powervr|vivante/.test(g)) level = 2;
    if (d.cores > 0 && d.cores <= 4) level -= 1;
    if (d.memoryGb !== null && d.memoryGb <= 4) level -= 1;
  }
  // Very high physical resolutions cost a lot of fill rate at the top levels.
  if (d.screenW * d.screenH * d.dpr * d.dpr > 7e6) level -= 1;
  return Math.max(0, Math.min(MAX_LEVEL, level));
}

/** Stable-ish identity for "this device": GPU, screen and CPU shape. */
export function deviceKey(d: DeviceInfo): string {
  const s = `${d.gpu}|${d.screenW}x${d.screenH}@${d.dpr}|${d.cores}|${d.touch ? 't' : 'm'}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

const STORE_KEY = 'nightrun.autoQuality.v1';

export function loadRememberedLevel(key: string): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, { level: number; t: number }>;
    const e = all[key];
    if (!e || !Number.isFinite(e.level)) return null;
    return Math.max(0, Math.min(MAX_LEVEL, Math.round(e.level)));
  } catch {
    return null;
  }
}

export function saveRememberedLevel(key: string, level: number): void {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, { level: number; t: number }>;
    all[key] = { level, t: Date.now() };
    // Keep a handful of devices (external monitors, browsers) and drop the oldest.
    const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
    for (const k of keys.slice(6)) delete all[k];
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
export type AutoReason = 'slow' | 'headroom' | 'probe-failed' | 'no-gain';

export interface AutoQualityOptions {
  /** Highest level the controller may probe up to. */
  ceiling?: number;
  onChange?: (level: number, reason: AutoReason) => void;
  /** Called when a level has proven itself; persist it. */
  onStable?: (level: number) => void;
}

const WINDOW = 180; // frames kept: 1.5 s at the aim, 3 s at 60 fps, 6 s at the floor
const EVAL_EVERY = 1; // seconds of active play between evaluations
const SETTLE_CHANGE = 2.5; // ignore frames after a level change (allocations, shader compiles)
const SETTLE_RESUME = 1.5; // ignore frames after loading / unpausing / tab switches
const GOOD_TO_PROBE = 12; // seconds of clean frames before trying a higher level
const COOLDOWN = 15; // minimum seconds between upward steps
const PROBE_WINDOW = 20; // a higher level must survive this long to stick
const PROBE_MISSES = 2; // consecutive evaluations off the aim that fail a probe
const STABLE_SAVE = 8; // seconds of acceptable frames before a level is remembered
const BACKOFF_START = 45;
const BACKOFF_MAX = 600;
const NO_GAIN_FREEZE = 120;

/**
 * Feed it every rendered frame with `frame(dt, active)`. Only active frames
 * (gameplay, not paused or loading) count, and its clock only advances on
 * them. Decisions, measured against FRAME_BUDGET:
 *  - down one level after ~3 s below the hold line (median > 1.2x 16.7 ms, or
 *    more than 25% of frames over 1.3x), two levels on the first evaluation
 *    that finds the median at the floor;
 *  - if dropping three levels did not speed anything up (CPU bound, or the
 *    browser throttles rAF), go back up and stop dropping for two minutes:
 *    quality settings cannot buy frames the GPU is not spending, so the
 *    floor is only enforceable when rendering is the bottleneck;
 *  - up one level after 12 s of clean frames at the aim and a 15 s cooldown,
 *    as a probe: it reverts as soon as it slips below the hold line, or after
 *    two evaluations off the aim, and that level is blocked with exponential
 *    backoff (45 s, 90 s, ... 10 min).
 * The aim is 120 fps capped at the display. rAF never runs faster than the
 * refresh rate, so the fastest frames seen (p10 of a window, kept as a running
 * best within 60..120 Hz) are the display: a 60 Hz screen aims at 60, and a
 * 120 Hz screen counts as 60 Hz until the game has actually run at 120 on it.
 * Between the aim and the hold line it holds, which is the hysteresis.
 */
export class AutoQualityController {
  private _level: number;
  /** Display-capped aim in Hz: starts at the hold line, rises when faster frames are seen. */
  private aimHz = 1 / FRAME_BUDGET.hold;
  private readonly ceiling: number;
  private readonly samples = new Float32Array(WINDOW);
  private count = 0;
  private head = 0;
  private t = 0;
  private settleUntil = 0;
  private nextEval = 0;
  private wasActive = false;
  private badStreak = 0;
  private goodSince = -1;
  private okSince = -1;
  private lastUp = -Infinity;
  private savedLevel = -1;
  private probe: { from: number; at: number; misses: number } | null = null;
  /** Consecutive steps down and the mean frame time before the first one. */
  private downChain: { from: number; mean: number; at: number } | null = null;
  private downFreezeUntil = 0;
  private noGainFreeze = NO_GAIN_FREEZE;
  private readonly rejectUntil: number[] = QUALITY_LEVELS.map(() => 0);
  private readonly backoff: number[] = QUALITY_LEVELS.map(() => BACKOFF_START);
  /** Last evaluated stats, for overlays and tests. */
  stats = { median: 0, p90: 0, slow: 0 };

  constructor(start: number, private readonly opts: AutoQualityOptions = {}) {
    this.ceiling = Math.max(0, Math.min(MAX_LEVEL, opts.ceiling ?? MAX_LEVEL));
    this._level = Math.max(0, Math.min(MAX_LEVEL, Math.round(start)));
    this.savedLevel = this._level;
  }

  get level(): number {
    return this._level;
  }

  get profile(): QualityLevel {
    return QUALITY_LEVELS[this._level];
  }

  /** Seconds of active play seen so far (the controller's clock). */
  get time(): number {
    return this.t;
  }

  /** Frame time it is aiming at: the 120 fps aim, capped at the display's measured refresh rate. */
  get aim(): number {
    return 1 / this.aimHz;
  }

  /** Jump to a level from outside (e.g. the player re-enabling Auto). */
  reset(level: number): void {
    this._level = Math.max(0, Math.min(MAX_LEVEL, Math.round(level)));
    this.probe = null;
    this.downChain = null;
    this.restart(SETTLE_CHANGE);
  }

  frame(dt: number, active: boolean): void {
    if (!active) {
      this.wasActive = false;
      return;
    }
    // Tab switches, debugger pauses and loading stalls: not a measurement.
    if (!(dt > 0) || dt > 0.25) {
      this.restart(SETTLE_RESUME);
      return;
    }
    if (!this.wasActive) {
      this.wasActive = true;
      this.restart(SETTLE_RESUME);
    }
    this.t += dt;
    if (this.t < this.settleUntil) return;
    this.samples[this.head] = dt;
    this.head = (this.head + 1) % WINDOW;
    this.count = Math.min(WINDOW, this.count + 1);
    if (this.t >= this.nextEval) {
      this.nextEval = this.t + EVAL_EVERY;
      if (this.count >= 45) this.evaluate();
    }
  }

  private restart(settle: number): void {
    this.count = 0;
    this.head = 0;
    this.badStreak = 0;
    this.goodSince = -1;
    this.okSince = -1;
    this.settleUntil = this.t + settle;
    this.nextEval = this.settleUntil + EVAL_EVERY;
  }

  private setLevel(level: number, reason: AutoReason): void {
    level = Math.max(0, Math.min(MAX_LEVEL, level));
    if (level === this._level) return;
    this._level = level;
    this.restart(SETTLE_CHANGE);
    this.opts.onChange?.(level, reason);
  }

  private evaluate(): void {
    const n = this.count;
    const xs = Array.from(this.samples.subarray(0, n)).sort((a, b) => a - b);
    const rawMedian = xs[n >> 1];
    const { hold, floor } = FRAME_BUDGET;
    // Drop isolated hitches (GC, asset uploads): far slower than the typical frame.
    const kept = xs.filter((x) => x <= Math.max(rawMedian * 3, floor * 1.5));
    const m = kept.length;
    const median = kept[m >> 1];
    const p90 = kept[Math.min(m - 1, Math.floor(m * 0.9))];
    // The fastest frames this device has produced are its refresh rate (rAF never
    // runs faster): p10 of the window, kept as a running best between 60 and 120 Hz.
    this.aimHz = Math.max(this.aimHz, Math.min(1 / FRAME_BUDGET.aim, Math.round(1 / kept[Math.floor(m * 0.1)])));
    const aim = 1 / this.aimHz;
    let slowN = 0;
    let offAimN = 0;
    let sum = 0;
    for (const x of kept) {
      if (x > hold * 1.3) slowN++;
      if (x > aim * 1.3) offAimN++;
      sum += x;
    }
    const slow = slowN / m;
    // The mean still moves when vsync quantizes frames to 8.3 / 16.7 / 33.3 ms.
    const mean = sum / m;
    this.stats = { median, p90, slow };
    const t = this.t;
    const bad = median > hold * 1.2 || slow > 0.25;
    const severe = median > floor * 0.95;
    const good = median <= aim * 1.05 && p90 <= aim * 1.3 && offAimN / m < 0.04;

    // A probe that slipped below the hold line, or sits off the aim for two
    // evaluations, backs down and blocks that level for a while.
    if (this.probe) {
      this.probe.misses = good ? 0 : this.probe.misses + 1;
      if (bad || this.probe.misses >= PROBE_MISSES) {
        const failed = this._level;
        this.rejectUntil[failed] = t + this.backoff[failed];
        this.backoff[failed] = Math.min(BACKOFF_MAX, this.backoff[failed] * 2);
        const from = this.probe.from;
        this.probe = null;
        this.setLevel(from, 'probe-failed');
        return;
      }
      if (t - this.probe.at >= PROBE_WINDOW) this.probe = null;
    }

    // Did stepping down help? If three levels lower frames are just as slow,
    // our settings are not the bottleneck (CPU bound, or the browser throttles
    // rAF): go back to where we started and stop dropping for a while (2 min,
    // doubling each time it happens again).
    if (this.downChain && t - this.downChain.at >= SETTLE_CHANGE + 2) {
      const dc = this.downChain;
      if (mean < dc.mean * 0.93) this.downChain = null;
      else if (bad && dc.from - this._level >= 3) {
        this.downChain = null;
        this.downFreezeUntil = t + this.noGainFreeze;
        this.noGainFreeze = Math.min(BACKOFF_MAX * 1.5, this.noGainFreeze * 2);
        this.setLevel(dc.from, 'no-gain');
        return;
      }
    }

    if (bad) {
      this.badStreak++;
      this.goodSince = -1;
      this.okSince = -1;
      // At the floor every evaluation counts; above it three in a row, so a busy corner does not cost a level.
      if (this._level > 0 && t >= this.downFreezeUntil && this.badStreak >= (severe ? 1 : 3)) {
        if (!this.downChain) this.downChain = { from: this._level, mean, at: t };
        else this.downChain.at = t;
        this.setLevel(this._level - (severe ? 2 : 1), 'slow');
      }
      return;
    }
    this.badStreak = 0;

    // Remember levels that hold up (not mid-probe).
    if (this.okSince < 0) this.okSince = t;
    if (!this.probe && t - this.okSince >= STABLE_SAVE && this.savedLevel !== this._level) {
      this.savedLevel = this._level;
      this.opts.onStable?.(this._level);
    }

    if (!good) {
      this.goodSince = -1;
      return;
    }
    if (this.goodSince < 0) this.goodSince = t;
    const up = this._level + 1;
    if (
      !this.probe &&
      up <= this.ceiling &&
      t - this.goodSince >= GOOD_TO_PROBE &&
      t - this.lastUp >= COOLDOWN &&
      t >= this.rejectUntil[up]
    ) {
      this.lastUp = t;
      this.probe = { from: this._level, at: t, misses: 0 };
      this.setLevel(up, 'headroom');
    }
  }
}

/** "Auto (High)" style label for a level. */
export function autoLabel(level: number): string {
  return `Auto (${TIER_LABEL[QUALITY_LEVELS[Math.max(0, Math.min(MAX_LEVEL, level))].tier]})`;
}
