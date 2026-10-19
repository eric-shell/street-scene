/**
 * Seeded pseudo random numbers. The only source of randomness allowed inside
 * src/sim and src/city. Pure integer math, so results are identical on every
 * JavaScript engine.
 */

/** FNV-1a 32 bit hash of a string, then avalanche mixed. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // murmur3 finalizer for better bit spread
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine a seed with a label so sub-systems get independent streams. */
export function deriveSeed(seed: number, label: string): number {
  return hashString(`${seed >>> 0}:${label}`);
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32. Returns a float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** In-place Fisher-Yates shuffle. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  getState(): number {
    return this.state;
  }

  setState(s: number): void {
    this.state = s >>> 0;
  }
}

/** Seeds are strings in the UI (e.g. "20261019"); the sim works with 32 bit ints. */
export function seedFromString(seed: string): number {
  const trimmed = seed.trim();
  if (/^\d{1,9}$/.test(trimmed)) return Number(trimmed) >>> 0;
  return hashString(trimmed);
}
