/**
 * Replays are just (race config, player input log). Because the sim is
 * deterministic, re-running the log reproduces the race exactly. The same
 * data is what a future leaderboard would upload for server verification.
 */
import type { RaceConfig, RaceMode } from '../sim/race';
import type { VisualBuild } from '../shared/carBuild';

export interface ReplayData {
  v: 1;
  config: RaceConfig;
  /** Packed input frames, base64 of little-endian uint32s. */
  log: string;
  /** Visuals per car index, for rendering only. */
  visuals: VisualBuild[];
  result: { time: number; position: number; score?: number };
  date: string;
}

export function encodeLog(log: number[]): string {
  const bytes = new Uint8Array(new Uint32Array(log).buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeLog(b64: string): number[] {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return Array.from(new Uint32Array(bytes.buffer, 0, Math.floor(bytes.length / 4)));
}

const PREFIX = 'nightrun.';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

export interface BestRecord {
  time: number;
  score?: number;
  carId: string;
  date: string;
}

const bestKey = (seed: number, mode: RaceMode) => `best.${seed}.${mode}`;
const ghostKey = (seed: number, mode: RaceMode) => `ghost.${seed}.${mode}`;

export function loadBest(seed: number, mode: RaceMode): BestRecord | null {
  const raw = safeGet(bestKey(seed, mode));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BestRecord;
  } catch {
    return null;
  }
}

/** Save if better. Returns true when it is a new best. */
export function submitBest(seed: number, mode: RaceMode, rec: BestRecord): boolean {
  const cur = loadBest(seed, mode);
  const better = mode === 'drift' ? !cur || (rec.score ?? 0) > (cur.score ?? 0) : !cur || rec.time < cur.time;
  if (better) safeSet(bestKey(seed, mode), JSON.stringify(rec));
  return better;
}

const styleKey = (seed: number, mode: RaceMode) => `style.${seed}.${mode}`;

/** The best style score (the nitrous callouts' points, boostCallouts.ts styleTotal) on this event, 0 when none. */
export function loadStyleBest(seed: number, mode: RaceMode): number {
  const n = Number(safeGet(styleKey(seed, mode)));
  return Number.isFinite(n) ? n : 0;
}

/** Save a style score if it beats the best. Returns true when it is a new best. */
export function submitStyleBest(seed: number, mode: RaceMode, score: number): boolean {
  if (score <= 0 || score <= loadStyleBest(seed, mode)) return false;
  safeSet(styleKey(seed, mode), String(Math.round(score)));
  return true;
}

export function loadGhost(seed: number, mode: RaceMode): ReplayData | null {
  const raw = safeGet(ghostKey(seed, mode));
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as ReplayData;
    return r.v === 1 ? r : null;
  } catch {
    return null;
  }
}

export function saveGhost(seed: number, mode: RaceMode, replay: ReplayData): void {
  safeSet(ghostKey(seed, mode), JSON.stringify(replay));
}

export function saveLastReplay(replay: ReplayData): void {
  try {
    sessionStorage.setItem(PREFIX + 'lastReplay', JSON.stringify(replay));
  } catch {
    /* ignore */
  }
}

export function loadLastReplay(): ReplayData | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + 'lastReplay');
    return raw ? (JSON.parse(raw) as ReplayData) : null;
  } catch {
    return null;
  }
}
