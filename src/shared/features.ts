/** Feature switches for things that exist in code but are hidden for now. */
export const FEATURES = {
  /** Vinyl decals in the garage (tab hidden and decals not rendered while false). */
  vinyls: false,
  /** Rear license plates with the player's name (render/car/plate.ts): parked until the seat and size are right. */
  plates: false,
} as const;
