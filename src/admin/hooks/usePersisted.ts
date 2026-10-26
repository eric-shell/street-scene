/**
 * A dashboard preference kept in the game's store (shared/store, under `nightrun.dashboard.*`, keys the account
 * sync never carries): a filter you want on today you want on tomorrow. Storage that is missing or blocked
 * just means the default every time.
 */
import { useEffect, useState } from 'react';
import { loadJson, saveJson } from '../../shared/store';

export function usePersisted<T>(key: string, fallback: T, valid: (v: unknown) => v is T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = loadJson<unknown>(`dashboard.${key}`, fallback);
    return valid(saved) ? saved : fallback;
  });
  useEffect(() => void saveJson(`dashboard.${key}`, value), [key, value]);
  return [value, setValue];
}

export const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
