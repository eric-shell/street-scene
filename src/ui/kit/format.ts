/** How the UI writes times, places and scores, so every screen says them the same way. */

/** m:ss.cc */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--.--';
  const cs = Math.floor(seconds * 100 + 1e-6);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** m:ss, for a track's position and length. */
export function formatClock(seconds: number): string {
  return formatTime(seconds).slice(0, -3);
}

/** A drift score: "12,345 pts". */
export function formatPoints(points: number): string {
  return `${Math.round(points).toLocaleString()} pts`;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
