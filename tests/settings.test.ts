import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings } from '../src/ui/settings';

/** A localStorage for the node environment, one key is all the settings use. */
function storage(stored: unknown): void {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('nightrun.settings.v1', JSON.stringify(stored));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('sound settings', () => {
  it('default to the intended balance: master down, every bus full', () => {
    storage(undefined);
    const s = loadSettings();
    expect(s.masterVolume).toBe(0.7);
    expect([s.engineVolume, s.effectsVolume, s.ambienceVolume, s.interfaceVolume]).toEqual([1, 1, 1, 1]);
  });

  it('carry the old single engine slider into the master, so a chosen loudness does not jump', () => {
    storage({ engineVolume: 0.4 });
    const s = loadSettings();
    expect(s.masterVolume).toBe(0.4);
    expect(s.engineVolume).toBe(1);
    expect(s.effectsVolume).toBe(1);
  });

  it('keep saved levels and clamp bad ones', () => {
    storage({ masterVolume: 0.5, engineVolume: 0.8, effectsVolume: 1.7, ambienceVolume: -2, interfaceVolume: 'loud' });
    const s = loadSettings();
    expect(s.masterVolume).toBe(0.5);
    expect(s.engineVolume).toBe(0.8);
    expect(s.effectsVolume).toBe(1);
    expect(s.ambienceVolume).toBe(0);
    expect(s.interfaceVolume).toBe(DEFAULT_SETTINGS.interfaceVolume);
  });
});
