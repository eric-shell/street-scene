/**
 * Event of the day seed (browser side; the sim never reads the clock).
 * The seed is the UTC date as YYYYMMDD. A ?seed= URL parameter overrides it.
 */
export function dailySeed(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export function initialSeed(): string {
  const param = new URLSearchParams(window.location.search).get('seed');
  return param && param.trim() ? param.trim().slice(0, 32) : dailySeed();
}
