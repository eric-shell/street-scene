/**
 * Feature switches for things that exist in code but are hidden for now: the one place to turn any of them on.
 * Off means the feature leaves no button, saves nothing and costs nothing at run time.
 */
export const FEATURES = {
  /** Vinyl decals in the garage (tab hidden and decals not rendered while false). */
  vinyls: false,
  /** Rear license plates with the player's name (render/car/plate.ts): parked until the seat and size are right. */
  plates: false,
  /**
   * Watching a race again (the menu's Replay and the results' Replay row), and recording the last race for it
   * (session storage, on this device only). Ghosts in time trials are separate and stay on.
   */
  replays: false,
} as const;
