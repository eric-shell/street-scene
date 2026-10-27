/** Player settings persisted in localStorage. */
import { clamp, clamp01 } from '../sim/math';
import { MAX_OPPONENTS, type RaceMode } from '../sim/race';
import { loadJson, saveJson } from '../shared/store';

export type Quality = 'low' | 'medium' | 'high';
export type Difficulty = 'easy' | 'medium' | 'hard';
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
/** What the menu's race step starts: a race mode, or free roam. */
export type RaceType = RaceMode | 'roam';
/** In the race step's grid order (two rows of three, read left to right); the number keys pick them in this order. */
export const RACE_TYPES: readonly RaceType[] = ['circuit', 'sprint', 'waypoint', 'drift', 'drag', 'roam'];

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
  /** Sound levels 0..1 (gain is the square): the master over everything, then the engine voices, the drive's effects (impacts, nitrous, horn), the world's ambience (crowds, trains, weather) and the menu sounds. Music has its own slider in the player. */
  masterVolume: number;
  engineVolume: number;
  effectsVolume: number;
  ambienceVolume: number;
  interfaceVolume: number;
  /** Driver aid: cuts drive torque when the rear wheels spin. Off lets the rear step out. */
  tractionControl: boolean;
  /** Flash effects: lightning flashes and the police light bar's strobes. Off keeps the sky still and the light bar a soft glow. */
  flashEffects: boolean;
  /** Gamepad rumble for the player's car (pads and browsers that support it). */
  rumble: boolean;
  /** Debug mode: the live physics (` / F2) and camera (F3) tuning panels in races and free roam, and free roam drives on the saved physics tuning. */
  debugMode: boolean;
  /** The player's name as a license plate can carry it (plateText: A–Z, 0–9, spaces and hyphens, PLATE_MAX long); the plates will show it. Empty: none chosen. Set on Settings › Account and synced with the account. */
  username: string;
}

const KEY = 'settings.v1';
/** The sound levels, each 0..1. */
const VOLUMES = ['masterVolume', 'engineVolume', 'effectsVolume', 'ambienceVolume', 'interfaceVolume'] as const;

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
  masterVolume: 0.7,
  engineVolume: 1,
  effectsVolume: 1,
  ambienceVolume: 1,
  interfaceVolume: 1,
  tractionControl: false,
  flashEffects: true,
  rumble: true,
  debugMode: false,
  username: '',
};

/** The longest plate name (characters), what a US plate holds. */
export const PLATE_MAX = 8;

/** Text as a plate can carry it: upper case A–Z, 0–9, single spaces and hyphens, at most PLATE_MAX long (not trimmed, so typing a space works). */
export function plateText(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, '')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +/, '')
    .slice(0, PLATE_MAX);
}

export function loadSettings(): Settings {
  const parsed = loadJson<Partial<Settings> | null>(KEY, null);
  if (!parsed || typeof parsed !== 'object') return defaultForDevice();
  const s = { ...DEFAULT_SETTINGS, ...parsed };
  if (!QUALITIES.includes(s.quality)) s.quality = 'medium';
  // Players from before Auto existed made an explicit choice (or got the old default): keep it.
  if (typeof parsed.autoQuality !== 'boolean') s.autoQuality = false;
  if (!DIFFICULTIES.includes(s.difficulty)) s.difficulty = 'medium';
  s.opponents = clamp(Math.round(Number(s.opponents) || 0), 0, MAX_OPPONENTS);
  if (!RACE_TYPES.includes(s.raceType)) s.raceType = 'circuit';
  // Before the mixer one "engine volume" slider scaled every sound: it becomes the master, the engine itself stays full.
  if (typeof parsed.masterVolume !== 'number' && typeof parsed.engineVolume === 'number') {
    s.masterVolume = parsed.engineVolume;
    s.engineVolume = DEFAULT_SETTINGS.engineVolume;
  }
  // Before debug mode each tuning panel had its own setting: either one on turns debug mode on.
  const legacy = parsed as { debugTuningPanel?: boolean; debugCameraPanel?: boolean };
  if (typeof parsed.debugMode !== 'boolean') s.debugMode = !!(legacy.debugTuningPanel || legacy.debugCameraPanel);
  delete (s as Partial<typeof legacy>).debugTuningPanel;
  delete (s as Partial<typeof legacy>).debugCameraPanel;
  s.username = typeof s.username === 'string' ? plateText(s.username).trim() : '';
  for (const k of VOLUMES) {
    s[k] = clamp01(Number(s[k]));
    if (!Number.isFinite(s[k])) s[k] = DEFAULT_SETTINGS[k];
  }
  return s;
}

export function saveSettings(s: Settings): void {
  saveJson(KEY, s);
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
  /** View depth past which the city's detail layers (paint, trim, small dressing) stop drawing (m; render/cityChunks.ts). */
  detailDistance: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatioCap: 1, renderScale: 0.7, bloom: true, bloomScale: 0.25, bloomStrength: 0.75, pointLights: 0, antialias: false, detailDistance: 180 },
  medium: { pixelRatioCap: 1.5, renderScale: 0.9, bloom: true, bloomScale: 0.5, bloomStrength: 0.9, pointLights: 4, antialias: false, detailDistance: 260 },
  high: { pixelRatioCap: 2, renderScale: 1, bloom: true, bloomScale: 0.75, bloomStrength: 1.0, pointLights: 8, antialias: true, detailDistance: 380 },
};
