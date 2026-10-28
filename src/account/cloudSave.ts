/**
 * What an account carries between devices, read from and written to the local store: the garage, its prefs
 * and the settings, as one small document (the `players.save` column). Replays, ghosts, bests, the music
 * player and the debug panels' tuning stay on the device; they are larger, or only make sense on it.
 */
import { mergePoints, POINTS_KEY } from '../shared/points';
import { loadText, onSaved, saveText } from '../shared/store';

/** The store keys an account syncs. */
const SYNCED: readonly string[] = ['garage.v1', 'garage.prefs.v1', 'settings.v1', POINTS_KEY];
/** Settings that describe this device rather than the player: kept when another device's settings arrive. */
const DEVICE_SETTINGS = ['quality', 'autoQuality', 'showFps'] as const;

/** The synced document: each key's parsed value. */
export interface SaveBlob {
  v: 1;
  keys: Record<string, unknown>;
}

/** Set while applySave writes, so its own writes do not count as the player's edits. */
let applying = false;

function parse(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** This device's synced keys, as they stand. */
export function collectSave(): SaveBlob {
  const keys: Record<string, unknown> = {};
  for (const k of SYNCED) {
    const v = parse(loadText(k));
    if (v !== undefined) keys[k] = v;
  }
  return { v: 1, keys };
}

/**
 * Writes a downloaded save over this device's keys (keeping this device's graphics settings); keys the save
 * lacks are left alone. True when anything changed, so a running game knows to reload what it read.
 */
export function applySave(blob: SaveBlob): boolean {
  let changed = false;
  applying = true;
  try {
    for (const k of SYNCED) {
      let v = blob.keys?.[k];
      if (!v || typeof v !== 'object') continue;
      if (k === 'settings.v1') {
        const local = parse(loadText(k)) as Record<string, unknown> | undefined;
        v = { ...v, ...Object.fromEntries(DEVICE_SETTINGS.filter((d) => local && d in local).map((d) => [d, local![d]])) };
      }
      const text = JSON.stringify(v);
      if (loadText(k) !== text && saveText(k, text)) changed = true;
    }
  } finally {
    applying = false;
  }
  return changed;
}

/** The garage's key, and its slot cap (garage/storage.ts MAX_SLOTS, not imported: that module pulls in the car assets). */
const GARAGE_KEY = 'garage.v1';
const MAX_SLOTS = 6;

/**
 * Adds this device's garage builds the downloaded save lacks to it (after the account's own, up to the slot
 * cap), so signing in on a device whose garage belonged to no account moves its cars into the account
 * instead of writing over them. Returns how many builds joined; the caller uploads the result.
 */
export function joinLocalBuilds(blob: SaveBlob): number {
  const local = parse(loadText(GARAGE_KEY)) as { slots?: unknown } | undefined;
  const mine = Array.isArray(local?.slots) ? local.slots : [];
  if (!mine.length) return 0;
  const cloud = blob.keys?.[GARAGE_KEY] as { slots?: unknown } | undefined;
  // The account has no garage yet: this device's goes up whole.
  if (!cloud || !Array.isArray(cloud.slots)) {
    blob.keys = { ...blob.keys, [GARAGE_KEY]: local };
    return mine.length;
  }
  const have = new Set(cloud.slots.map((b) => JSON.stringify(b)));
  const joining = mine.filter((b) => !have.has(JSON.stringify(b))).slice(0, Math.max(0, MAX_SLOTS - cloud.slots.length));
  cloud.slots = [...cloud.slots, ...joining];
  return joining.length;
}

/**
 * Folds this device's points into the downloaded save, keeping the larger of the total and the best (points
 * only grow, so max never double counts). True when this device was ahead, so the caller uploads the result.
 */
export function mergeLocalPoints(blob: SaveBlob): boolean {
  const local = parse(loadText(POINTS_KEY));
  if (!local) return false;
  const cloud = blob.keys?.[POINTS_KEY];
  const merged = mergePoints(local, cloud);
  const was = mergePoints(cloud, undefined);
  blob.keys = { ...blob.keys, [POINTS_KEY]: merged };
  return merged.total !== was.total || merged.best !== was.best;
}

/** Calls `fn` whenever the game writes one of the synced keys. */
export function watchSynced(fn: () => void): void {
  onSaved((key) => !applying && SYNCED.includes(key) && fn());
}
