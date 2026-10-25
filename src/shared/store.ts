/**
 * The game's saved state in localStorage: every key lives under `nightrun.` (pass it without the prefix,
 * `loadJson('settings.v1', ...)`). Storage can be missing, blocked or full (private windows, quota), so no
 * call throws: a read falls back, a write reports whether it stuck. Writes are announced (`onSaved`) so the
 * account sync (account/cloudSave.ts) can upload the keys it carries.
 */
const PREFIX = 'nightrun.';

const listeners: ((key: string) => void)[] = [];

/** Calls `fn` with the key (without the prefix) after every write that stuck. */
export function onSaved(fn: (key: string) => void): void {
  listeners.push(fn);
}

export function loadText(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

export function saveText(key: string, value: string): boolean {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    return false;
  }
  for (const fn of listeners) fn(key);
  return true;
}

/** The parsed value under `key`, or `fallback` when it is missing, unreadable or not JSON. */
export function loadJson<T>(key: string, fallback: T): T {
  const raw = loadText(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): boolean {
  return saveText(key, JSON.stringify(value));
}
