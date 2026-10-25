/**
 * What an account carries between devices, read from and written to the local store: the garage, its prefs
 * and the settings, as one small document (the `players.save` column). Replays, ghosts, bests, the music
 * player and the debug panels' tuning stay on the device; they are larger, or only make sense on it.
 */
import { loadText, onSaved, saveText } from '../shared/store';

/** The store keys an account syncs. */
const SYNCED: readonly string[] = ['garage.v1', 'garage.prefs.v1', 'settings.v1'];
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

/** Calls `fn` whenever the game writes one of the synced keys. */
export function watchSynced(fn: () => void): void {
  onSaved((key) => !applying && SYNCED.includes(key) && fn());
}
