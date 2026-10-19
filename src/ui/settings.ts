/** Player settings persisted in localStorage. */
export type Quality = 'low' | 'medium' | 'high';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Settings {
  quality: Quality;
  retro: boolean;
  radialBlur: boolean;
  manualGearbox: boolean;
  difficulty: Difficulty;
  opponents: number;
  showFps: boolean;
}

const KEY = 'nightrun.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  retro: false,
  radialBlur: true,
  manualGearbox: false,
  difficulty: 'medium',
  opponents: 3,
  showFps: false,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultForDevice();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const s = { ...DEFAULT_SETTINGS, ...parsed };
    if (!['low', 'medium', 'high'].includes(s.quality)) s.quality = 'medium';
    if (!['easy', 'medium', 'hard'].includes(s.difficulty)) s.difficulty = 'medium';
    s.opponents = Math.max(0, Math.min(3, Math.round(Number(s.opponents) || 0)));
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
  const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  return { ...DEFAULT_SETTINGS, quality: touch ? 'low' : 'medium' };
}

export interface QualityProfile {
  pixelRatioCap: number;
  renderScale: number;
  bloom: boolean;
  bloomScale: number;
  bloomStrength: number;
  pointLights: number;
  antialias: boolean;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatioCap: 1, renderScale: 0.7, bloom: true, bloomScale: 0.25, bloomStrength: 0.75, pointLights: 0, antialias: false },
  medium: { pixelRatioCap: 1.5, renderScale: 0.9, bloom: true, bloomScale: 0.5, bloomStrength: 0.9, pointLights: 4, antialias: false },
  high: { pixelRatioCap: 2, renderScale: 1, bloom: true, bloomScale: 0.75, bloomStrength: 1.0, pointLights: 8, antialias: true },
};
