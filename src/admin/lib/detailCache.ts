/**
 * Visitor detail payloads held in memory for one page view, so reopening a row (comparing two visitors is the
 * obvious thing to do in this table) costs no request and flashes no skeleton. Never persisted: player emails
 * and notes have no reason to outlive the tab or survive a sign-out, and a reload is the escape hatch.
 *
 * Staleness is decided by data the list already polls: `detailStamp` is the row's `last_activity_at` (a
 * greatest() over last seen, page views, heartbeats and events) plus the counts the detail renders, so a
 * visitor who does anything new invalidates their own entry within one poll.
 */
import type { VisitorDetailPayload, VisitorSummary } from '../../../api/_lib/adminTypes';

/** Payloads held at once: covers any realistic session of clicking around a 500-row table; the oldest opened is evicted. */
const MAX_ENTRIES = 20;

interface Entry {
  stamp: string;
  payload: VisitorDetailPayload;
}

/** Insertion order doubles as LRU recency: reads re-insert. */
const cache = new Map<string, Entry>();

export function detailStamp(v: VisitorSummary): string {
  return [v.last_activity_at, v.page_view_count, v.session_count, v.race_start_count, v.race_finish_count, v.race_quit_count, v.build_save_count, v.player_email ?? ''].join('|');
}

/** The cached payload for `id`, or null when absent or superseded (a superseded entry is dropped at once). */
export function readDetail(id: string, stamp: string): VisitorDetailPayload | null {
  const hit = cache.get(id);
  if (!hit) return null;
  cache.delete(id);
  if (hit.stamp !== stamp) return null;
  cache.set(id, hit);
  return hit.payload;
}

export function writeDetail(id: string, stamp: string, payload: VisitorDetailPayload): void {
  cache.delete(id);
  cache.set(id, { stamp, payload });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Forget a visitor: after a delete there is nothing left to serve. */
export function dropDetail(id: string): void {
  cache.delete(id);
}
