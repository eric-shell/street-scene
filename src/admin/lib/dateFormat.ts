/**
 * Dates and durations as the dashboard prints them. Same-day is decided from local calendar fields, in the
 * reader's own time zone (the zone the rest of the string is rendered in): comparing ISO date prefixes would use
 * UTC and call a visit "Today" hours early or late. A tab left open across midnight keeps saying "Today" until
 * the next 120 s poll re-renders it.
 */

/** `Today, 4:20 AM`, otherwise `Aug 3, 4:20 AM`: the time stays in both, since "when today" is what gets scanned. */
export function formatLastSeen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatLong(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatMonthDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** Compact engaged or driving time: `0s`, `45s`, `3m 20s`, `1h 04m`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return `${mins}m ${String(secs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** A race time the way the game's results show it: `1:23.45`, `58.20`. */
export function formatRaceTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const frac = String(cs % 100).padStart(2, '0');
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${frac}` : `${s}.${frac}`;
}

/** `1st`, `2nd`, `3rd`, `11th`. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** `12` → `12%`, with an empty denominator reading 0 rather than NaN. */
export function share(value: number, total: number): number {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}
