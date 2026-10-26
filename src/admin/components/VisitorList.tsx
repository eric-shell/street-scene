/**
 * The visitor rows: the folding table from 721 px, cards below it (a sideways-scrolling table on a phone means
 * never seeing a whole row), 25 to a page, sortable, each opening its detail in a drawer under the row. Only one
 * layout renders (useMediaQuery), so an open row's detail mounts once.
 *
 * Paging (goToPage) does two things a bare setPage did not, and both matter:
 *  - It scrolls back to the Visitors section (heading, search and filters, so you see which set you page), in a
 *    useLayoutEffect AFTER the new rows are in the DOM. Scrolling inline in the click looks the same and is not:
 *    a part-filled last page makes the document shorter, the browser clamps the scroll aimed at the old height,
 *    and you land mid-table with the animation killed. Gated by pendingScrollRef so sorting and filtering (which
 *    also reset to page 1) never yank the viewport. A full second page hides the bug; test a part-filled one.
 *  - It asks before discarding unsaved Notes: a page turn unmounts the drawer, so it is a close path like the X,
 *    Escape or another row, and every close path goes through confirmDiscard.
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleUser, Pencil, StickyNote } from 'lucide';
import type { VisitorSummary } from '../../../api/_lib/adminTypes';
import { FpsBadge } from '../charts/FrameRate';
import type { VisitorEdits } from '../hooks/useVisitorDetail';
import { classifyVisitor, type BurstMap } from '../lib/classify';
import { formatDuration, formatLastSeen } from '../lib/dateFormat';
import { detailStamp } from '../lib/detailCache';
import { TIER_LABEL } from '../lib/gameVocab';
import { isNewSince } from '../lib/lastVisit';
import { resolveLocation, type ResolvedLocation } from '../lib/location';
import { DEFAULT_SORT, SORT_LABEL, nextSort, sortVisitors, type SortKey, type SortState } from '../lib/sortVisitors';
import { VISITOR_COLUMNS, columnStyle, visibleColumns, type ColumnBreakpoint } from '../lib/visitorColumns';
import { Button } from './Controls';
import { Icon } from './Icon';
import { VisitorDetail } from './VisitorDetail';
import { VisitorTags } from './VisitorTags';

const PAGE_SIZE = 25;
/** How long a closing drawer stays mounted to animate shut (ms); _visitor-list.scss times the collapse to it. */
const COLLAPSE_MS = 260;

/** The drawer's open and close: grid rows 0fr to 1fr, since the height is unknown until the fetch lands. */
function DetailCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={open ? 'detail-collapse' : 'detail-collapse is-closing'}>
      <div className="detail-collapse__inner">{children}</div>
    </div>
  );
}

/**
 * Truncate from the middle, in CSS: the whole id stays in the DOM (selecting it copies all 36 characters for a
 * SQL `where`), the head shrinks with an ellipsis, the tail never does. Mono, so the ellipsis lands in the same
 * column on every row and the ids read as one block. Screen readers get it whole.
 */
function MiddleTruncate({ text, tail = 4 }: { text: string; tail?: number }) {
  return (
    <span className="middle-truncate" title={text}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" className="middle-truncate__head">
        {text.slice(0, -tail)}
      </span>
      <span aria-hidden="true" className="middle-truncate__tail">
        {text.slice(-tail)}
      </span>
    </span>
  );
}

/** Muted "no data", on most rows, so it stays quiet but legible. */
function Dash() {
  return <span className="visitor-table__dash">—</span>;
}

/** The label truncates and the pencil (a human typed this, not "verified") survives; nearly every location is IP-derived, so the exception is marked. */
function LocationValue({ location }: { location: ResolvedLocation }) {
  if (!location.label) return <Dash />;
  return (
    <span className="location-value" title={location.approximate ? 'Approximate: from IP geolocation' : 'Corrected by hand'}>
      <span className="location-value__label">{location.label}</span>
      {!location.approximate ? <Icon node={Pencil} size={11} label="corrected by hand" /> : null}
    </span>
  );
}

/** "New since you last looked": a small accent mark with a title and a spoken label, never color alone. */
function NewDot({ filled }: { filled: boolean }) {
  return (
    <span className={filled ? 'new-dot is-filled' : 'new-dot'} title={filled ? 'New activity since you last opened the dashboard' : undefined}>
      {filled ? <span className="sr-only">New since your last visit. </span> : null}
    </span>
  );
}

/**
 * The id and its two quiet marks. On the table the dot's width is held open on rows without one, so the left
 * edge of the id column (which is scanned) does not wobble; a first-ever visit reserves nothing, since no row can
 * be new. Cards show the dot by the timestamp instead.
 */
function VisitorIdValue({ v, isNew, reserveDot, showDot = true }: { v: VisitorSummary; isNew: boolean; reserveDot: boolean; showDot?: boolean }) {
  return (
    <span className="visitor-id">
      {showDot && (isNew || reserveDot) ? <NewDot filled={isNew} /> : null}
      <MiddleTruncate text={v.id} />
      {v.notes ? (
        <span className="visitor-id__note" title={v.notes}>
          <Icon node={StickyNote} size={12} label="Has notes" />
        </span>
      ) : null}
    </span>
  );
}

/** The signed-in player: a badge with the name over the email. */
function PlayerValue({ v }: { v: VisitorSummary }) {
  if (!v.player_email) return <Dash />;
  return (
    <span className="player-value" title={`${v.player_name ?? ''} ${v.player_email}`.trim()}>
      <span className="player-value__name">
        <Icon node={CircleUser} size={13} />
        <span className="player-value__text">{v.player_name || 'Player'}</span>
      </span>
      <span className="player-value__email">{v.player_email}</span>
    </span>
  );
}

function EngagementValue({ v }: { v: VisitorSummary }) {
  if (v.page_view_count === 0 && v.total_engaged_ms === 0) return <Dash />;
  return (
    <>
      <span className="visitor-table__line">
        {v.page_view_count} {v.page_view_count === 1 ? 'view' : 'views'}
      </span>
      {v.total_engaged_ms > 0 ? <span className="visitor-table__subline">{formatDuration(v.total_engaged_ms)}</span> : null}
    </>
  );
}

function RacesValue({ v }: { v: VisitorSummary }) {
  if (v.race_start_count === 0) return <Dash />;
  return (
    <>
      <span className="visitor-table__line" title={`${v.race_start_count} started, ${v.race_finish_count} finished, ${v.race_quit_count} quit`}>
        {v.race_start_count}
      </span>
      <span className={v.race_finish_count ? 'visitor-table__subline is-good' : 'visitor-table__subline'}>{v.race_finish_count} finished</span>
    </>
  );
}

function FpsValue({ v }: { v: VisitorSummary }) {
  if (v.median_fps === null) return <Dash />;
  return (
    <>
      <span className="visitor-table__line">
        <FpsBadge fps={v.median_fps} compact />
      </span>
      {v.last_tier ? <span className="visitor-table__subline">{TIER_LABEL[v.last_tier]}</span> : null}
    </>
  );
}

/**
 * Below xl the four count columns fold into one, three lines at most (views and engaged time; races; frame rate
 * and driving time), the line boxes the skeleton reserves. Zeroes drop out: a quiet row should read quiet.
 */
function ActivityValue({ v }: { v: VisitorSummary }) {
  if (v.page_view_count === 0 && v.total_engaged_ms === 0 && v.race_start_count === 0) return <Dash />;
  return (
    <>
      <span className="visitor-table__line">
        {v.page_view_count} {v.page_view_count === 1 ? 'view' : 'views'}
        {v.total_engaged_ms > 0 ? ` · ${formatDuration(v.total_engaged_ms)}` : ''}
      </span>
      {v.race_start_count > 0 ? (
        <span className={v.race_finish_count ? 'visitor-table__subline is-good' : 'visitor-table__subline'}>
          {v.race_start_count} races · {v.race_finish_count} finished
        </span>
      ) : null}
      {v.median_fps !== null || v.total_race_ms > 0 ? (
        <span className="visitor-table__subline">
          {v.median_fps !== null ? <FpsBadge fps={v.median_fps} compact /> : null}
          {v.total_race_ms > 0 ? ` ${formatDuration(v.total_race_ms)}` : ''}
        </span>
      ) : null}
    </>
  );
}

/** A sortable header: the button carries the interaction, aria-sort what a screen reader announces; the arrow shows on the active column only. */
function SortHeader({ col, sort, onSort }: { col: (typeof VISITOR_COLUMNS)[number]; sort: SortState; onSort: (key: SortKey) => void }) {
  const active = sort.key === col.sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={col.align === 'right' ? 'visitor-table__head visitor-table__head--right' : 'visitor-table__head'} style={columnStyle(col) as CSSProperties}>
      <button type="button" className={active ? 'visitor-table__sort is-active' : 'visitor-table__sort'} onClick={() => onSort(col.sortKey)} title={col.title ?? `Sort by ${SORT_LABEL[col.sortKey]}`}>
        {col.label}
        <Icon node={active && sort.dir === 'asc' ? ChevronUp : ChevronDown} size={12} />
      </button>
    </th>
  );
}

/**
 * The sort control wherever the headers cannot carry every key: the phone has none, and below xl the table
 * folds four away. A native select, on purpose: on Android it opens the OS picker. The direction toggle uses
 * arrows, never a chevron (the select draws its own beside it, and two read as two dropdowns), and says Asc or
 * Desc in words.
 */
function SortBar({ sort, onSort }: { sort: SortState; onSort: (key: SortKey) => void }) {
  const dir = sort.dir === 'asc' ? 'ascending' : 'descending';
  return (
    <div className="visitor-list__sort">
      <label htmlFor="visitor-sort" className="label">
        Sort by
      </label>
      <div className="visitor-list__sort-row">
        <select id="visitor-sort" className="visitor-list__select" value={sort.key} onChange={(e) => onSort(e.target.value as SortKey)}>
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {SORT_LABEL[k]}
            </option>
          ))}
        </select>
        <Button icon={sort.dir === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow} cls="--small" onClick={() => onSort(sort.key)} title={`Sorted ${dir}: tap to reverse`} label={`Sorted ${dir}. Activate to reverse.`}>
          {sort.dir === 'asc' ? 'Asc' : 'Desc'}
        </Button>
      </div>
    </div>
  );
}

interface VisitorListProps {
  visitors: VisitorSummary[];
  /** Arrival clusters across the whole list; without them the cross-row rules do not fire, the safe direction. */
  bursts?: BurstMap;
  newSince: number | null;
  cards: boolean;
  breakpoint: ColumnBreakpoint;
  onVisitorDeleted: (id: string) => void;
  onUnauthorized: () => void;
  scrollTargetRef: RefObject<HTMLElement | null>;
}

export function VisitorList({ visitors, bursts, newSince, cards, breakpoint, onVisitorDeleted, onUnauthorized, scrollTargetRef }: VisitorListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('v'));
  const [closingId, setClosingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  // Edits saved from an open drawer, folded in once here so the location resolver, the sort, the table and the
  // cards all agree about what a row says before the next poll.
  const [savedEdits, setSavedEdits] = useState<Record<string, VisitorEdits>>({});
  const didRestore = useRef(false);
  const pendingScrollRef = useRef(false);
  // A ref, not state: written on every keystroke in Notes, and as state it would re-render every row.
  const dirtyRef = useRef(false);

  const rows = useMemo(() => (Object.keys(savedEdits).length === 0 ? visitors : visitors.map((v) => (v.id in savedEdits ? { ...v, ...savedEdits[v.id] } : v))), [visitors, savedEdits]);
  const labelFor = useCallback((v: VisitorSummary) => resolveLocation(v).label, []);
  const sorted = useMemo(() => sortVisitors(rows, sort, labelFor, bursts), [rows, sort, labelFor, bursts]);
  const sortedRef = useRef(sorted);
  useEffect(() => void (sortedRef.current = sorted), [sorted]);
  const columns = useMemo(() => visibleColumns(breakpoint), [breakpoint]);
  const shown = useMemo(() => new Set(columns.map((c) => c.id)), [columns]);

  const handleSaved = useCallback((id: string, edits: VisitorEdits) => setSavedEdits((prev) => ({ ...prev, [id]: edits })), []);
  const setDirty = useCallback((d: boolean) => void (dirtyRef.current = d), []);
  const isNew = useCallback((v: VisitorSummary) => isNewSince(v, newSince), [newSince]);

  /** Safe to throw away what is in Notes: nothing unsaved, or you said so. Shared by every close path. */
  const confirmDiscard = useCallback(() => !dirtyRef.current || confirm('You have unsaved changes to this visitor. Discard them?'), []);

  const handleSelect = useCallback(
    (id: string | null) => {
      const leaving = selectedId !== null && selectedId !== id;
      if (leaving && !confirmDiscard()) return;
      setClosingId(leaving ? selectedId : null);
      setSelectedId(id);
    },
    [selectedId, confirmDiscard],
  );

  // Escape closes the drawer, through handleSelect so it keeps the unsaved-edits guard.
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && handleSelect(null);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId, handleSelect]);

  const handleDeleted = useCallback(
    (id: string) => {
      // The row is gone, so what was typed is no longer an unsaved edit; without this the delete's own close would ask.
      dirtyRef.current = false;
      onVisitorDeleted(id);
    },
    [onVisitorDeleted],
  );

  // A timer, not transitionend: under reduced motion there is no transition, so no event would ever fire.
  useEffect(() => {
    if (!closingId) return;
    const timer = setTimeout(() => setClosingId(null), COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [closingId]);

  const handleSort = useCallback((key: SortKey) => {
    setSort((current) => nextSort(current, key));
    setPage(1);
  }, []);

  // First load: open the page holding the row in the URL (?v=). Later list changes (a poll, a search): back to
  // page 1, closing the detail if its row is gone. Keyed on `visitors` alone, or every sort would reset paging.
  useEffect(() => {
    if (!didRestore.current) {
      didRestore.current = true;
      setSelectedId((current) => {
        if (!current) return current;
        const idx = sortedRef.current.findIndex((v) => v.id === current);
        if (idx === -1) return null;
        setPage(Math.floor(idx / PAGE_SIZE) + 1);
        return current;
      });
      return;
    }
    setPage(1);
    setSelectedId((current) => (current && !visitors.some((v) => v.id === current) ? null : current));
  }, [visitors]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedId) params.set('v', selectedId);
    else params.delete('v');
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [selectedId]);

  const goToPage = useCallback(
    (next: number) => {
      if (selectedId !== null && !confirmDiscard()) return;
      dirtyRef.current = false;
      pendingScrollRef.current = true;
      setPage(next);
    },
    [selectedId, confirmDiscard],
  );

  useLayoutEffect(() => {
    if (!pendingScrollRef.current) return;
    pendingScrollRef.current = false;
    // No `behavior`: html's scroll-behavior (smooth, auto under reduced motion) decides.
    scrollTargetRef.current?.scrollIntoView({ block: 'start' });
  }, [page, scrollTargetRef]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const detail = (v: VisitorSummary) =>
    selectedId === v.id || closingId === v.id ? (
      <DetailCollapse open={selectedId === v.id}>
        <VisitorDetail id={v.id} stamp={detailStamp(v)} onClose={() => handleSelect(null)} onDeleted={handleDeleted} onSaved={handleSaved} onDirtyChange={setDirty} onUnauthorized={onUnauthorized} />
      </DetailCollapse>
    ) : null;

  const cell = (v: VisitorSummary, id: string, location: ResolvedLocation, tags: ReturnType<typeof classifyVisitor>): ReactNode => {
    switch (id) {
      case 'visitor':
        return (
          <>
            <VisitorIdValue v={v} isNew={isNew(v)} reserveDot={newSince !== null} />
            {breakpoint === 'md' ? <VisitorTags tags={tags} under /> : null}
          </>
        );
      case 'flags':
        return <VisitorTags tags={tags} />;
      case 'lastSeen':
        return formatLastSeen(v.last_activity_at);
      case 'location':
        return <LocationValue location={location} />;
      case 'player':
        return <PlayerValue v={v} />;
      case 'activity':
        return <ActivityValue v={v} />;
      case 'engagement':
        return <EngagementValue v={v} />;
      case 'races':
        return <RacesValue v={v} />;
      case 'driving':
        return v.total_race_ms > 0 ? formatDuration(v.total_race_ms) : <Dash />;
      case 'fps':
        return <FpsValue v={v} />;
      default:
        return null;
    }
  };

  return (
    <div className="visitor-list">
      {breakpoint !== 'xl' || cards ? <SortBar sort={sort} onSort={handleSort} /> : null}

      {cards ? (
        <ul className="visitor-list__cards">
          {pageRows.map((v) => {
            const open = selectedId === v.id;
            const tags = classifyVisitor(v, bursts);
            return (
              <li key={v.id}>
                <button type="button" className={open ? 'visitor-card is-open' : 'visitor-card'} onClick={() => handleSelect(open ? null : v.id)} aria-expanded={open}>
                  <span className="visitor-card__head">
                    <VisitorIdValue v={v} isNew={false} reserveDot={false} showDot={false} />
                    <span className="visitor-card__seen">
                      {isNew(v) ? <NewDot filled /> : null}
                      {formatLastSeen(v.last_activity_at)}
                    </span>
                  </span>
                  <span className="visitor-card__body">
                    <span className="visitor-card__identity">
                      <span className="visitor-card__location">
                        <LocationValue location={resolveLocation(v)} />
                      </span>
                      {v.player_email ? <PlayerValue v={v} /> : null}
                    </span>
                    <VisitorTags tags={tags} />
                  </span>
                  <span className="visitor-card__foot">
                    <span>
                      {v.page_view_count} {v.page_view_count === 1 ? 'view' : 'views'} · {formatDuration(v.total_engaged_ms)}
                    </span>
                    <span className="visitor-card__races">
                      {v.race_start_count > 0 ? `${v.race_start_count} races · ${v.race_finish_count} done` : 'no races'}
                      {v.median_fps !== null ? <FpsBadge fps={v.median_fps} compact /> : null}
                    </span>
                  </span>
                </button>
                {detail(v)}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="visitor-list__scroller">
          <table className={`visitor-table visitor-table--${breakpoint}`}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <SortHeader key={col.id} col={col} sort={sort} onSort={handleSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((v) => {
                const open = selectedId === v.id;
                const location = resolveLocation(v);
                const tags = classifyVisitor(v, bursts);
                return (
                  <Fragment key={v.id}>
                    <tr
                      className={open ? 'visitor-table__row is-open' : 'visitor-table__row'}
                      onClick={() => handleSelect(open ? null : v.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                        e.preventDefault();
                        handleSelect(open ? null : v.id);
                      }}
                      tabIndex={0}
                      aria-expanded={open}
                    >
                      {VISITOR_COLUMNS.filter((c) => shown.has(c.id)).map((c) => (
                        <td key={c.id} className={`visitor-table__cell visitor-table__cell--${c.id}${c.align === 'right' ? ' visitor-table__cell--right' : ''}`}>
                          {cell(v, c.id, location, tags)}
                        </td>
                      ))}
                    </tr>
                    {open || closingId === v.id ? (
                      <tr className="visitor-table__drawer">
                        {/* Exactly the columns on screen: a wider span invents phantom columns that take a share of the free width. */}
                        <td colSpan={columns.length}>{detail(v)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 ? (
        <div className="visitor-list__pager">
          <p className="visitor-list__range">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length}
          </p>
          <div className="visitor-list__pages">
            <Button icon={ChevronLeft} cls="--small" onClick={() => goToPage(page - 1)} disabled={page === 1}>
              Prev
            </Button>
            <Button icon={ChevronRight} cls="--small" onClick={() => goToPage(page + 1)} disabled={page === totalPages}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
