/**
 * Feature switches for things that exist in code but are hidden for now: the one place to turn any of them on.
 * Off means the feature leaves no button, saves nothing and costs nothing at run time.
 *
 * The defaults ship to everyone. On one device they can be changed without a deploy: `?features=replays,vinyls`
 * turns those on and `?features=-challenges` turns one off, kept in `nightrun.features` from then on, and
 * `?features=` alone goes back to the defaults. `devTools` is not a switch: it is on in `npm run dev` and off in
 * every build Vercel serves, whatever the URL says.
 *
 * Each garage model has a switch of its own, named by its car id (`?features=kazamaRotor` shows the RX-7 on one
 * device). A model switched off is offered nowhere: not in the garage's Model tab, not as a new player's starter,
 * a rival, a showroom lift car or a car at the street meets, its model is not loaded at boot and a shared build
 * on it is refused; builds already saved on it are set aside untouched until it is back (garage/storage.ts).
 * A ghost or replay on it still draws it. A new model gets a switch here (one without stays in `npm run dev`).
 */
import { loadText, saveText } from './store';

const DEFAULTS = {
  /** Vinyl decals in the garage (tab hidden and decals not rendered while false). */
  vinyls: false,
  /** Rear license plates with the player's name (render/car/plate.ts): parked until the seat and size are right. */
  plates: false,
  /**
   * Watching a race again (the menu's Replay and the results' Replay row), and recording the last race for it
   * (session storage, on this device only). Ghosts in time trials are separate and stay on.
   */
  replays: false,
  /** The results' Challenge a friend row. Links already sent keep working with it off. */
  challenges: true,
  /**
   * Points buy garage parts (shared/economy.ts prices, shared/purchases.ts ownership per car). Off: every part is
   * free, unlocked and owned, the garage shows no prices, and nothing is spent or recorded.
   */
  economy: true,

  // The garage models, by car id: each on in `npm run dev` until it is ready to ship; the R32 and the S13 shipped.
  /** Wendt Strom R6 (Golf R32 Mk4): shipped. */
  wendtStrom: true,
  /** Nakaya Grove (Silvia S13): shipped. */
  nakayaGrove: true,
  /** Kazama Rotor (RX-7 FD3S). */
  kazamaRotor: import.meta.env.DEV,
  /** Albrecht Kombi S (Audi S2 Avant). */
  albrechtKombi: import.meta.env.DEV,
  /** Dalton Fiend (Challenger SRT Demon widebody). */
  daltonFiend: import.meta.env.DEV,
  /** Tachibana Zenith (Supra MK IV). */
  tachibanaZenith: import.meta.env.DEV,
  /** Tachibana Runabout (MR2 W20). */
  tachibanaRunabout: import.meta.env.DEV,
};

export type Feature = keyof typeof DEFAULTS;

/** This device's overrides: from `?features=` (and saved), else the saved ones. */
function overrides(): Partial<Record<Feature, boolean>> {
  try {
    const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('features');
    if (param !== null) saveText('features', param);
    const out: Partial<Record<Feature, boolean>> = {};
    for (const word of (param ?? loadText('features') ?? '').split(',')) {
      const name = word.trim().replace(/^-/, '');
      if (name in DEFAULTS) out[name as Feature] = !word.trim().startsWith('-');
    }
    if (Object.keys(out).length) console.info('Feature overrides on this device:', out);
    return out;
  } catch {
    return {};
  }
}

export const FEATURES: Readonly<Record<Feature, boolean> & { devTools: boolean }> = {
  ...DEFAULTS,
  ...overrides(),
  /** Settings › Developer (debug mode: the physics and camera tuning panels) and the garage's part drop (Ctrl+Shift+D). */
  devTools: import.meta.env.DEV,
};
