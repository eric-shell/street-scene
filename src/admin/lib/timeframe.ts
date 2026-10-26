/**
 * The window the visitor table and the totals describe. A row is in the window by `last_activity_at` (when the
 * visitor last did something), not `first_seen_at`: "who has been here this week" is the question asked, and a
 * visitor first seen in March who came back yesterday belongs in the last 24 hours. Rolling, not calendar days,
 * so a set left open does not shrink at midnight.
 */
import type { VisitorSummary } from '../../../api/_lib/adminTypes';

export type Timeframe = '24h' | '7d' | '30d' | 'all';

/** `label` for the segmented control where four share a row; `full` for the phone's native select. */
export const TIMEFRAMES: readonly { value: Timeframe; label: string; full: string; title: string }[] = [
  { value: '24h', label: '24h', full: 'Past 24 hours', title: 'Visitors last active in the past 24 hours' },
  { value: '7d', label: '7d', full: 'Past 7 days', title: 'Visitors last active in the past 7 days' },
  { value: '30d', label: '30d', full: 'Past 30 days', title: 'Visitors last active in the past 30 days' },
  { value: 'all', label: 'All', full: 'All time', title: 'Every recorded visitor, with no time limit' },
];

/** `all`, so a fresh session never quietly hides history. */
export const DEFAULT_TIMEFRAME: Timeframe = 'all';

/** Guard for the persisted value, which is untrusted storage text. */
export function isTimeframe(v: unknown): v is Timeframe {
  return TIMEFRAMES.some((t) => t.value === v);
}

const DAYS: Record<Exclude<Timeframe, 'all'>, number> = { '24h': 1, '7d': 7, '30d': 30 };

export function withinTimeframe(rows: VisitorSummary[], tf: Timeframe): VisitorSummary[] {
  if (tf === 'all') return rows;
  const cutoff = Date.now() - DAYS[tf] * 86_400_000;
  return rows.filter((v) => new Date(v.last_activity_at).getTime() >= cutoff);
}
