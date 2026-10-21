/** Player settings persisted in localStorage. */
import type { RaceMode } from '../sim/race';
import { MAX_OPPONENTS } from '../sim/race';

export type Quality = 'low' | 'medium' | 'high';
export type Difficulty = 'easy' | 'medium' | 'hard';
/** What the menu's race step starts: a race mode, or free roam. */
export type RaceType = RaceMode | 'roam';
export const RACE_TYPES: readonly RaceType[] = ['circuit', 'sprint', 'drift', 'roam'];

export interface Settings {
  /**
   * Graphics preset. With autoQuality on, this follows the tier the auto
   * controller picked (scene density reads it) and the renderer uses the
   * finer auto level instead of the preset.
   */
  quality: Quality;
  /** Auto graphics: pick and adapt the quality level from measured frame times. */
  autoQuality: boolean;
  retro: boolean;
  radialBlur: boolean;
  manualGearbox: boolean;
  difficulty: Difficulty;
  /** AI rivals in a circuit or sprint, 0 (race your ghost) to MAX_OPPONENTS. */
  opponents: number;
  /** The race type last picked on the menu's race step. */
  raceType: RaceType;
  showFps: boolean;
  /** Engine sound volume 0..1 */
  engineVolume: number;
  /** Driver aid: cuts drive torque when the rear wheels spin. Off lets the rear step out. */
  tractionControl: boolean;
  /** Flash effects: lightning flashes and the police light bar's strobes. Off keeps the sky still and the light bar a soft glow. */
  flashEffects: boolean;
  /** Debug: show the live physics tuning panel (also toggled with ` / F2). */
  debugTuningPanel: boolean;
  /** Debug: show the live camera tuning panel (also toggled with F3). */
  debugCameraPanel: boolean;
}

const KEY = 'nightrun.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  autoQuality: true,
  retro: false,
  radialBlur: true,
  manualGearbox: false,
  difficulty: 'medium',
  opponents: 3,
  raceType: 'circuit',
  showFps: false,
  engineVolume: 0.7,
  tractionControl: false,
  flashEffects: true,
  debugTuningPanel: false,
  debugCameraPanel: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultForDevice();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS, ...parsed };
    if (!['low', 'medium', 'high'].includes(s.quality)) s.quality = 'medium';
    // Players from before Auto existed made an explicit choice (or got the old default): keep it.
    if (typeof parsed.autoQuality !== 'boolean') s.autoQuality = false;
    if (!['easy', 'medium', 'hard'].includes(s.difficulty)) s.difficulty = 'medium';
    s.opponents = Math.max(0, Math.min(MAX_OPPONENTS, Math.round(Number(s.opponents) || 0)));
    if (!RACE_TYPES.includes(s.raceType)) s.raceType = 'circuit';
    s.engineVolume = Math.max(0, Math.min(1, Number(s.engineVolume)));
    if (!Number.isFinite(s.engineVolume)) s.engineVolume = DEFAULT_SETTINGS.engineVolume;
    return s;
  } catch {
    return defaultForDevice();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

function defaultForDevice(): Settings {
  // New players get Auto; the tier here is only a placeholder until the auto
  // controller makes its device guess at boot.
  const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  return { ...DEFAULT_SETTINGS, quality: touch ? 'low' : 'medium', autoQuality: true };
}

export interface QualityProfile {
  pixelRatioCap: number;
  renderScale: number;
  bloom: boolean;
  bloomScale: number;
  bloomStrength: number;
  pointLights: number;
  /** 4x MSAA on the scene pass (no renderer recreation needed). */
  antialias: boolean;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatioCap: 1, renderScale: 0.7, bloom: true, bloomScale: 0.25, bloomStrength: 0.75, pointLights: 0, antialias: false },
  medium: { pixelRatioCap: 1.5, renderScale: 0.9, bloom: true, bloomScale: 0.5, bloomStrength: 0.9, pointLights: 4, antialias: false },
  high: { pixelRatioCap: 2, renderScale: 1, bloom: true, bloomScale: 0.75, bloomStrength: 1.0, pointLights: 8, antialias: true },
};
