/**
 * The visitor table's column set: one source of truth for the header row, the loading skeleton and the colSpan
 * the open-detail row needs. They used to state it three times in the CRM and the skeleton drifted furthest.
 * Adding a column is an edit to this array (and its cell in VisitorList), nothing else: widths, fold points and
 * skeleton shapes all live here.
 *
 * The table folds rather than drops. Below `lg` the Flags ride under the visitor id; below `xl` Engagement,
 * Races, Driving and Frame rate merge into one Activity column. The phone (narrow) gets cards instead, and the
 * sort select keeps every folded key reachable.
 */
import type { SortKey } from './sortVisitors';

/** The table's fold points in px; components/_visitor-table.scss names the same two widths. Keep them in step. */
export const BREAKPOINTS = { lg: 1024, xl: 1280 } as const;
/** Below this the list is cards (ui/styles/abstracts/_media.scss $narrow). */
export const CARD_BELOW = 721;

export type ColumnVisibility = 'always' | 'lg' | 'xl' | 'below-xl';
export type ColumnBreakpoint = 'md' | 'lg' | 'xl';

export interface SkeletonBar {
  /** Bar width (any CSS length). */
  w: string;
  /** The line box it sits in, px: the table's 14 px text is a 20 px line, its 12 px subtext a 16 px one. */
  h?: number;
  /** A tag badge rather than a line of text. */
  pill?: boolean;
}

export interface VisitorColumn {
  /** Stable key, not the sort key: Activity and Engagement share one. */
  id: string;
  sortKey: SortKey;
  label: string;
  visible: ColumnVisibility;
  /** Widths per breakpoint (each falls back to the one below); none means the column takes the spare width. */
  width?: { md: string; lg?: string; xl?: string };
  align?: 'left' | 'right';
  title?: string;
  /** Placeholder lines top to bottom, at the line boxes the real cell stacks, so a skeleton row is a real row's height. */
  skeleton: SkeletonBar[];
}

export const VISITOR_COLUMNS: VisitorColumn[] = [
  // The id is 12 px mono, a 16 px line; below lg a 19 px tag row rides under it (drawn by the skeleton's pill row there).
  { id: 'visitor', sortKey: 'visitor', label: 'Visitor', visible: 'always', width: { md: '9rem', lg: '8.5rem' }, skeleton: [{ w: '6rem', h: 16 }] },
  // 13rem holds the commonest pair, `Finished` + `Returning`, on one line (188 px of the 192 the cell has); three tags wrap by design.
  { id: 'flags', sortKey: 'flags', label: 'Flags', visible: 'lg', width: { md: '13rem' }, title: 'Heuristic traffic flags. Sorts by severity: automated first, then the proxy evidence, then players.', skeleton: [{ w: '4.5rem', h: 19, pill: true }] },
  // "May 28, 10:01 AM" is the widest realistic value.
  { id: 'lastSeen', sortKey: 'lastSeen', label: 'Last seen', visible: 'always', width: { md: '8.5rem', xl: '9rem' }, skeleton: [{ w: '6rem' }] },
  // Location takes the spare width: a corrected location can be a long hand-typed string.
  { id: 'location', sortKey: 'location', label: 'Location', visible: 'always', skeleton: [{ w: '7rem' }] },
  // Name over email.
  { id: 'player', sortKey: 'player', label: 'Player', visible: 'always', width: { md: '10rem', lg: '11rem', xl: '12rem' }, title: 'The account this browser signed in with', skeleton: [{ w: '6rem' }, { w: '8rem', h: 16 }] },
  {
    id: 'activity',
    sortKey: 'engagement',
    label: 'Activity',
    visible: 'below-xl',
    width: { md: '9.5rem' },
    align: 'right',
    title: 'Page views and engaged time, then races started and finished, then frame rate and driving time. Sorts by views, then engaged time.',
    skeleton: [{ w: '6rem' }, { w: '5rem', h: 16 }, { w: '6rem', h: 16 }],
  },
  { id: 'engagement', sortKey: 'engagement', label: 'Engagement', visible: 'xl', width: { md: '7.5rem' }, align: 'right', title: 'Page views and engaged time (tab visible) across every session.', skeleton: [{ w: '4rem' }, { w: '2.5rem', h: 16 }] },
  { id: 'races', sortKey: 'races', label: 'Races', visible: 'xl', width: { md: '6rem' }, align: 'right', title: 'Races and free roams started, and races finished. Sorts by starts, then finishes.', skeleton: [{ w: '2.5rem' }, { w: '3.5rem', h: 16 }] },
  { id: 'driving', sortKey: 'driving', label: 'Driving', visible: 'xl', width: { md: '6rem' }, align: 'right', title: 'Time spent driving (a race or free roam running) across every session', skeleton: [{ w: '3rem' }] },
  { id: 'fps', sortKey: 'fps', label: 'Frame rate', visible: 'xl', width: { md: '7.5rem' }, align: 'right', title: 'Median of the visitor’s driving frame rate, and the quality tier it last ran at. Sorts slowest first.', skeleton: [{ w: '3.5rem' }, { w: '3rem', h: 16 }] },
];

/** The columns rendered at one of the three table widths. */
export function visibleColumns(bp: ColumnBreakpoint): VisitorColumn[] {
  return VISITOR_COLUMNS.filter((c) => {
    switch (c.visible) {
      case 'always':
        return true;
      case 'lg':
        return bp !== 'md';
      case 'xl':
        return bp === 'xl';
      case 'below-xl':
        return bp !== 'xl';
    }
  });
}

/** The custom properties a column's cells read their width from (_visitor-table.scss). */
export function columnStyle(c: VisitorColumn): Record<string, string> | undefined {
  if (!c.width) return undefined;
  const lg = c.width.lg ?? c.width.md;
  return { '--col-md': c.width.md, '--col-lg': lg, '--col-xl': c.width.xl ?? lg };
}
