/**
 * A city's mood: the per-seed choices that make two cities read differently at night without changing what
 * is in them. Two tools: `pickSubset` draws a seed's share of a text pool (neon names, blade signs, blimp
 * words) from its own derived stream, and `neonMood` biases the neon palettes toward a hue family by
 * weighting the picks, never by dropping colours, so every colour still shows up and a city just leans.
 * The hazard amber and the route's cyan are not drawn from these tables and stay as they are. Pure; the
 * menu city and the race share a seed, so they draw the same subset and the same mood.
 */
import { Rng, deriveSeed } from '../../sim/prng';

/** `n` entries of `pool` in a seeded order (the whole pool, reordered, when it has no more than `n`). */
export function pickSubset<T>(pool: readonly T[], n: number, seed: number, label: string): T[] {
  const rng = new Rng(deriveSeed(seed, label));
  return rng.shuffle(pool.slice()).slice(0, n);
}

/** A hue family: the indices of NEON_COLORS and PASTEL_NEON it favours (see their orders below). */
interface MoodDef {
  name: string;
  neon: readonly number[];
  pastel: readonly number[];
}

/**
 * NEON_COLORS order: magenta, cyan, yellow, green, orange-red, violet, pink-red, mint.
 * PASTEL_NEON order: pink, cyan, violet, mint, yellow, coral.
 */
const MOODS: readonly MoodDef[] = [
  { name: 'magenta-cyan', neon: [0, 1, 5], pastel: [0, 1, 2] },
  { name: 'amber-red', neon: [2, 4, 6], pastel: [4, 5, 0] },
  { name: 'green-violet', neon: [3, 7, 5], pastel: [3, 2, 1] },
  { name: 'white-blue', neon: [1, 7, 5], pastel: [1, 3, 2] },
  { name: 'all-night', neon: [], pastel: [] },
];

/** How much more often a favoured colour is picked than the rest (1 = no bias). */
const FAVOUR = 3.2;

export interface NeonMood {
  name: string;
  /** Index into NEON_COLORS for a uniform draw in [0, 1). */
  neon(r: number): number;
  /** Index into PASTEL_NEON for a uniform draw in [0, 1). */
  pastel(r: number): number;
}

function weighted(count: number, favoured: readonly number[]): (r: number) => number {
  const cum: number[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) cum.push((sum += favoured.includes(i) ? FAVOUR : 1));
  return (r) => {
    const t = r * sum;
    for (let i = 0; i < count; i++) if (t < cum[i]) return i;
    return count - 1;
  };
}

const moods = new Map<number, NeonMood>();

/** The seed's neon mood, from `deriveSeed(seed, 'neon')`. */
export function neonMood(seed: number): NeonMood {
  let m = moods.get(seed);
  if (!m) {
    const def = MOODS[Math.floor(new Rng(deriveSeed(seed, 'neon')).next() * MOODS.length)];
    m = { name: def.name, neon: weighted(8, def.neon), pastel: weighted(6, def.pastel) };
    if (moods.size > 8) moods.clear();
    moods.set(seed, m);
  }
  return m;
}
