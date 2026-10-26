/**
 * The visitor table and its toolbar: the per-row view, beside the server-side aggregates in InsightsPanel.
 * Rows arrive already narrowed by the dashboard's timeframe and filters (they define the working set the totals
 * read too); search is the one narrowing that lives here, since it is a lookup and narrows only this table.
 *
 * The toolbar: search inside the panel it filters (a free-floating field read as another section), then the
 * timeframe on the left (it sets the window) and the filters on the right (they subtract from within it), in
 * reading order of that dependency. On a phone the timeframe is a native select (the OS picker beats four
 * 24 px segments) and the groups stack, each under its label. The filter row shows whenever there are any
 * visitors, even when a filter matches nothing: a disabled toggle reading zero says so honestly, and a
 * timeframe that empties the table never takes away the control that widens it again.
 */
import { useRef, useState } from 'react';
import { Cpu, Gauge, Search, X, type IconNode } from 'lucide';
import type { VisitorSummary } from '../../../api/_lib/adminTypes';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { BurstMap } from '../lib/classify';
import { resolveLocation } from '../lib/location';
import { TIMEFRAMES, type Timeframe } from '../lib/timeframe';
import { BREAKPOINTS, CARD_BELOW } from '../lib/visitorColumns';
import { Segmented } from './Controls';
import { Icon } from './Icon';
import { VisitorListSkeleton } from './Skeleton';
import { VisitorList } from './VisitorList';

/**
 * A filter toggle: `aria-pressed`, since it changes the view rather than submitting a value. On is the accent
 * fill, the way the game marks a selected segment; every state keeps its border so the row never shifts.
 */
function FilterToggle({ active, onClick, icon, title, disabled, children }: { active: boolean; onClick: () => void; icon: IconNode; title: string; disabled?: boolean; children: string }) {
  return (
    <button type="button" className={active ? 'filter-toggle is-pressed' : 'filter-toggle'} onClick={onClick} aria-pressed={active} disabled={disabled} title={title}>
      <Icon node={icon} size={14} />
      {children}
    </button>
  );
}

/** Case- and accent-insensitive search key: "zurich" finds "Zürich", the way the columns already sort. */
function fold(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

interface VisitorsPanelProps {
  /** Already narrowed by the timeframe and filters; null while loading. */
  visitors: VisitorSummary[] | null;
  /** The in-window count, for the "N of M" readout while searching. */
  totalCount: number;
  bursts?: BurstMap;
  newSince: number | null;
  newCount: number;
  /** A refetch in flight: the previous render dims rather than flashing a skeleton. */
  loading: boolean;
  hasAnyVisitors: boolean;
  timeframe: Timeframe;
  onTimeframeChange: (v: Timeframe) => void;
  hideAutomated: boolean;
  automatedCount: number;
  onToggleAutomated: () => void;
  driversOnly: boolean;
  quietCount: number;
  onToggleDrivers: () => void;
  onVisitorDeleted: (id: string) => void;
  onUnauthorized: () => void;
}

export function VisitorsPanel(p: VisitorsPanelProps) {
  const [query, setQuery] = useState('');
  // Where the pager scrolls back to: the heading, search and filters, so you can see which set you are paging.
  const sectionRef = useRef<HTMLElement>(null);
  const cards = !useMediaQuery(`(min-width: ${CARD_BELOW}px)`);
  const lg = useMediaQuery(`(min-width: ${BREAKPOINTS.lg}px)`);
  const xl = useMediaQuery(`(min-width: ${BREAKPOINTS.xl}px)`);
  const breakpoint = xl ? 'xl' : lg ? 'lg' : 'md';

  const q = fold(query.trim());
  const shown =
    !q || !p.visitors
      ? p.visitors
      : p.visitors.filter(
          (v) =>
            v.id.startsWith(q) ||
            fold(v.player_name).includes(q) ||
            fold(v.player_email).includes(q) ||
            fold(resolveLocation(v).label).includes(q) ||
            fold(v.gpu).includes(q) ||
            // The only text here you wrote yourself, so the thing you most likely come back looking for.
            fold(v.notes).includes(q),
        );

  return (
    <section ref={sectionRef} className="dashboard__section" aria-labelledby="visitors-heading">
      <div className="dashboard__section-head">
        <h2 id="visitors-heading" className="section-title">
          Visitors
        </h2>
        <div className="dashboard__section-tools">
          {/* Beside the heading, not in the toolbar: it is not a filter. A "show only new" would make leaving the tab open change which rows exist. */}
          {p.newCount > 0 ? (
            <span className="dashboard__new">
              <span className="new-dot is-filled" aria-hidden="true" />
              {p.newCount} new since your last visit
            </span>
          ) : null}
          <p className="dashboard__scope">One row per browser · the timeframe, filters and search narrow it</p>
        </div>
      </div>

      <div className={p.loading && p.visitors !== null ? 'visitors is-refreshing' : 'visitors'}>
        <div className="visitors__search">
          <Icon node={Search} size={16} />
          <input className="visitors__search-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={cards ? 'Search players, places, GPUs, notes, ids' : 'Search player, email, location, GPU, notes or visitor ID'} aria-label="Search visitors" />
          {q ? (
            <>
              {shown ? (
                <span className="visitors__count">
                  {shown.length} of {p.totalCount}
                </span>
              ) : null}
              <button type="button" className="visitors__clear" onClick={() => setQuery('')} aria-label="Clear search" title="Clear search">
                <Icon node={X} size={14} />
              </button>
            </>
          ) : null}
        </div>

        {p.hasAnyVisitors ? (
          <div className="visitors__filters">
            <div className="visitors__group">
              <span id="visitor-timeframe-label" className="label">
                Last seen
              </span>
              {cards ? (
                <select className="visitors__select" aria-labelledby="visitor-timeframe-label" value={p.timeframe} onChange={(e) => p.onTimeframeChange(e.target.value as Timeframe)}>
                  {TIMEFRAMES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.full}
                    </option>
                  ))}
                </select>
              ) : (
                <Segmented labelledBy="visitor-timeframe-label" options={TIMEFRAMES} value={p.timeframe} onChange={p.onTimeframeChange} />
              )}
            </div>
            <div className="visitors__group">
              <span className="label">Filters</span>
              <div className="visitors__toggles">
                {/* Cpu names the category, and collides with no tag's glyph; the label names the predicate (VisitorTag.automated), never a list of tags. */}
                <FilterToggle
                  active={p.hideAutomated}
                  disabled={p.automatedCount === 0}
                  onClick={p.onToggleAutomated}
                  icon={Cpu}
                  title={
                    p.automatedCount === 0
                      ? 'No automated traffic in this data, so there is nothing to hide.'
                      : `${p.hideAutomated ? 'Hiding' : 'Hides'} ${p.automatedCount} automated ${p.automatedCount === 1 ? 'visitor' : 'visitors'}: crawlers, AI agents, our own test runs, headless clients, rotating-proxy clusters and fetch-without-playing. Bounces always stay visible.`
                  }
                >
                  {p.hideAutomated && p.automatedCount > 0 ? `${p.automatedCount} hidden` : 'Hide automated'}
                </FilterToggle>
                {/* Gauge, not a person: this keeps visitors who drove, and a quiet five-minute menu browser is hidden by it. Nothing here asserts humanity. */}
                <FilterToggle
                  active={p.driversOnly}
                  disabled={p.quietCount === 0}
                  onClick={p.onToggleDrivers}
                  icon={Gauge}
                  title={p.quietCount === 0 ? 'Every visitor here started a drive, so there is nothing to hide.' : `Show only visitors who started a race or free roam. Hides ${p.quietCount} who never drove.`}
                >
                  {p.driversOnly && p.quietCount > 0 ? `${p.quietCount} non-drivers hidden` : 'Drivers only'}
                </FilterToggle>
              </div>
            </div>
          </div>
        ) : null}

        <div className="visitors__body">
          {shown === null ? (
            <VisitorListSkeleton cards={cards} breakpoint={breakpoint} />
          ) : shown.length === 0 ? (
            // An empty window is not an empty database, or narrowing to 24h on quiet data reads as data loss.
            <p className="visitors__empty">{q ? 'No visitors match your search.' : p.timeframe === 'all' ? 'No visitors yet.' : 'No visitors active in this timeframe.'}</p>
          ) : (
            <VisitorList visitors={shown} bursts={p.bursts} newSince={p.newSince} cards={cards} breakpoint={breakpoint} onVisitorDeleted={p.onVisitorDeleted} onUnauthorized={p.onUnauthorized} scrollTargetRef={sectionRef} />
          )}
        </div>
      </div>
    </section>
  );
}
