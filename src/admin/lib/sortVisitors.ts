/**
 * Sorting the visitor table. Every column sorts by what its cell shows: the Location column by the resolved
 * label (override included), Flags by the loudest tag's tone, counts with zero as blank. Blanks sink in BOTH
 * directions (a descending sort that opens on a screen of dashes is never what anyone wanted), and equal rows
 * fall back to newest first, then id, so nothing shuffles between renders.
 */
import type { VisitorSummary } from '../../../api/_lib/adminTypes';
import { classifyVisitor, type BurstMap } from './classify';

export type SortKey = 'visitor' | 'flags' | 'lastSeen' | 'location' | 'player' | 'engagement' | 'races' | 'driving' | 'fps';
export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** The order the API already returns, so the first paint does not jump. */
export const DEFAULT_SORT: SortState = { key: 'lastSeen', dir: 'desc' };

/** Text starts A to Z; counts, times and dates start at the largest and newest. */
export const INITIAL_DIR: Record<SortKey, SortDir> = {
  visitor: 'asc',
  flags: 'desc',
  lastSeen: 'desc',
  location: 'asc',
  player: 'asc',
  engagement: 'desc',
  races: 'desc',
  driving: 'desc',
  // Slowest first: the devices worth looking at are the ones under the lines.
  fps: 'asc',
};

/** The column names, short enough for the phone's sort select. */
export const SORT_LABEL: Record<SortKey, string> = {
  visitor: 'Visitor ID',
  flags: 'Flags',
  lastSeen: 'Last seen',
  location: 'Location',
  player: 'Player',
  engagement: 'Engagement',
  races: 'Races',
  driving: 'Driving',
  fps: 'Frame rate',
};

type Cell = { s: string | null } | { n: number | null };

/** Machine strings (a UUID, an ISO timestamp) compare byte-wise: locale collation with numeric runs jumbles UUIDs. */
const RAW_KEYS = new Set<SortKey>(['visitor', 'lastSeen']);

/**
 * Ranked by how much a row wants attention, so a descending Flags sort surfaces the exceptions: crawlers, then
 * expected machines, then the proxy evidence, then people who did something. `neutral` is 0, which the blank
 * rule sinks, since every row carries a tag now. Moves with TagTone (classify.ts).
 */
const TONE_RANK = { reject: 4, muted: 3, warn: 2, good: 1, neutral: 0 } as const;

function flagRank(v: VisitorSummary, bursts?: BurstMap): number {
  return classifyVisitor(v, bursts).reduce((max, t) => Math.max(max, TONE_RANK[t.tone]), 0);
}

function cellFor(v: VisitorSummary, key: SortKey, locationLabel: string | null, bursts?: BurstMap): Cell {
  switch (key) {
    case 'visitor':
      return { s: v.id };
    case 'flags':
      return { n: flagRank(v, bursts) || null };
    case 'lastSeen':
      return { s: v.last_activity_at };
    case 'location':
      return { s: locationLabel };
    case 'player':
      return { s: v.player_name ?? v.player_email ?? null };
    // Zero is blank, not 0, wherever the cell renders a dash at zero: what the cell shows and how it sorts agree.
    case 'engagement':
      return { n: v.page_view_count === 0 && v.total_engaged_ms === 0 ? null : v.page_view_count };
    case 'races':
      return { n: v.race_start_count || null };
    case 'driving':
      return { n: v.total_race_ms || null };
    case 'fps':
      return { n: v.median_fps };
  }
}

const isBlank = (c: Cell) => ('n' in c ? c.n === null : c.s === null || c.s === '');

export function sortVisitors(rows: VisitorSummary[], { key, dir }: SortState, locationLabelFor: (v: VisitorSummary) => string | null, bursts?: BurstMap): VisitorSummary[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const ca = cellFor(a, key, locationLabelFor(a), bursts);
    const cb = cellFor(b, key, locationLabelFor(b), bursts);
    const ba = isBlank(ca);
    const bb = isBlank(cb);
    if (ba !== bb) return ba ? 1 : -1;
    let d = 0;
    if (!ba) {
      if ('n' in ca && 'n' in cb) {
        d = (ca.n as number) - (cb.n as number);
        // Engaged time breaks ties on views; finishes break ties on starts.
        if (d === 0 && key === 'engagement') d = a.total_engaged_ms - b.total_engaged_ms;
        if (d === 0 && key === 'races') d = a.race_finish_count - b.race_finish_count;
      } else if ('s' in ca && 's' in cb) {
        const x = ca.s as string;
        const y = cb.s as string;
        // Human text: case- and accent-insensitive, so "zurich" files next to "Zürich".
        d = RAW_KEYS.has(key) ? (x < y ? -1 : x > y ? 1 : 0) : x.localeCompare(y, undefined, { sensitivity: 'base' });
      }
    }
    if (d !== 0) return d * sign;
    // A stabiliser, not part of the requested order, so not multiplied by `sign`.
    return b.last_activity_at.localeCompare(a.last_activity_at) || a.id.localeCompare(b.id);
  });
}

/** Clicking the active column flips it; a new column starts at its natural direction. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: INITIAL_DIR[key] };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}
