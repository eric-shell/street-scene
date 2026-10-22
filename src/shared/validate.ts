/**
 * Clamping readers for data from outside (saves, share codes, imported JSON): each returns a usable value of
 * the right type whatever comes in, falling back where the input is missing or wrong.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

/** A #rrggbb color (lower case), or the fallback. */
export const hexColor = (v: unknown, fallback: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fallback);

/** A finite number clamped to [lo, hi], or the fallback (clamped too). */
export const num = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return n < lo ? lo : n > hi ? hi : n;
};

/** One of the options, or the fallback. */
export const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** A plain object to read fields from ({} for anything else). */
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
