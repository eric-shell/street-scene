/**
 * Loading placeholders at the geometry of what they stand in for, so nothing moves when the data lands: each
 * bar sits inside the LINE BOX of the real text (a 14 px cell is a 20 px line, 12 px subtext a 16 px one), and
 * the visitor list's placeholder renders the same three layouts the list does (cards when narrow, the folding
 * table, the sort bar up to xl) from the same column list. A placeholder row that is not a real row's height
 * moves the whole page; one wider than the screen (a fixed table outside its scroller) zooms a phone out.
 */
import type { CSSProperties } from 'react';
import { RING_R, RING_STROKE } from '../lib/chartTheme';
import { VISITOR_COLUMNS, columnStyle, visibleColumns, type ColumnBreakpoint } from '../lib/visitorColumns';

export function Skeleton({ w = '100%', h = 10, className }: { w?: string | number; h?: number; className?: string }) {
  return <span className={className ? `skeleton ${className}` : 'skeleton'} style={{ width: w, height: h }} />;
}

/** A bar inside a line box of `line` px. */
export function Line({ w, line = 20, bar = 10, right, pill }: { w: string; line?: number; bar?: number; right?: boolean; pill?: boolean }) {
  return (
    <span className={right ? 'skeleton-line skeleton-line--right' : 'skeleton-line'} style={{ height: line }}>
      <Skeleton w={w} h={pill ? line : bar} className={pill ? 'skeleton--pill' : undefined} />
    </span>
  );
}

/** One stat tile: label, value, meter, sub line (StatTile's line boxes). */
export function StatTileSkeleton() {
  return (
    <div className="stat-tile is-loading" aria-hidden="true">
      <Line w="5rem" line={16} bar={8} />
      <Line w="3rem" line={30} bar={20} />
      <span className="stat-tile__meter" />
      <Line w="6rem" line={16} bar={8} />
    </div>
  );
}

export type InsightShape = 'bars' | 'rows' | 'ring' | 'hours' | 'pair';

/** Deterministic, not random: a placeholder that reshuffles between renders draws the eye to itself. */
const HOUR_STUBS = [18, 12, 10, 8, 8, 12, 22, 38, 55, 68, 74, 80, 86, 78, 72, 66, 70, 82, 90, 76, 58, 42, 30, 22];

/**
 * One insight card's body. `ring` is exact (a square ring over the four-row legend every ring card reserves);
 * `bars` and `rows` reserve a typical count, the one honest approximation here, since the row count is the data.
 */
export function InsightBodySkeleton({ shape, rows = 6, axis, legend }: { shape: InsightShape; rows?: number; axis?: boolean; legend?: boolean }) {
  if (shape === 'ring') {
    return (
      <div className="ring-card" aria-hidden="true">
        <div className="ring">
          <svg viewBox="0 0 100 100" className="ring__svg">
            <circle cx="50" cy="50" r={RING_R} fill="none" strokeWidth={RING_STROKE} className="skeleton-stroke" />
          </svg>
        </div>
        <ul className="chart-legend">
          {Array.from({ length: 4 }, (_, i) => (
            <li key={i} className="chart-legend__row">
              <Skeleton w={8} h={8} />
              <Skeleton w="45%" h={8} />
              <Skeleton w="3rem" h={8} className="skeleton--end" />
            </li>
          ))}
        </ul>
        <span className="ring-card__caption">
          <Skeleton w="100%" h={8} />
          <Skeleton w="60%" h={8} className="skeleton--centre" />
        </span>
      </div>
    );
  }
  if (shape === 'hours') {
    return (
      <div className="hour-strip" aria-hidden="true">
        <div className="hour-strip__columns">
          {HOUR_STUBS.map((h, i) => (
            <div key={i} className="hour-strip__column">
              <span className="skeleton hour-strip__bar" style={{ height: `${h}%` }} />
            </div>
          ))}
        </div>
        <div className="hour-strip__baseline" />
        <div className="hour-strip__axis">
          {[0, 1, 2, 3].map((i) => (
            <Line key={i} w="1.5rem" line={15} bar={8} />
          ))}
        </div>
      </div>
    );
  }
  if (shape === 'pair') {
    return (
      <div className="session-times" aria-hidden="true">
        {[0, 1].map((i) => (
          <div key={i} className="session-times__item">
            <Line w="5rem" line={16} bar={8} />
            <Line w="4rem" line={34} bar={22} />
            <Line w="7rem" line={16} bar={8} />
          </div>
        ))}
      </div>
    );
  }
  // `rows`: the two-line rows of the funnel, the modes and the frame-rate charts (a 16 px head, the 10 px bar, a
  // 14 px sub line, 4 px apart: 48 px, 12 px between), with the frame-rate axis above and the modes' legend below.
  const tall = shape === 'rows';
  return (
    <div className="skeleton-body" aria-hidden="true">
      {axis ? <Line w="40%" line={18} bar={7} /> : null}
      <ul className={tall ? 'skeleton-rows skeleton-rows--tall' : 'skeleton-rows'}>
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="skeleton-rows__row">
            <Skeleton w="34%" h={8} />
            <Skeleton w="auto" h={8} className="skeleton--grow" />
            <Skeleton w="2rem" h={8} />
          </li>
        ))}
      </ul>
      {legend ? <Line w="45%" line={14} bar={7} /> : null}
    </div>
  );
}

/** One phone card, at VisitorCard's geometry. */
function VisitorCardSkeleton() {
  return (
    <li className="visitor-card">
      <div className="visitor-card__head">
        <Line w="8rem" line={16} />
        <Line w="5rem" line={16} />
      </div>
      <div className="visitor-card__body">
        <div className="visitor-card__identity">
          <Line w="7rem" />
        </div>
        {/* Most cards carry two tags, which stack in the card's right half. */}
        <span className="visitor-tags">
          <Line w="6rem" line={19} pill />
          <Line w="6rem" line={19} pill />
        </span>
      </div>
      <div className="visitor-card__foot">
        <Line w="4rem" line={16} />
        <Line w="6rem" line={16} />
      </div>
    </li>
  );
}

/** The visitor list at rest: the first thing /dashboard paints, while the session probe is still in flight. */
export function VisitorListSkeleton({ cards, breakpoint, rows = 6 }: { cards: boolean; breakpoint: ColumnBreakpoint; rows?: number }) {
  const cols = new Set(visibleColumns(breakpoint).map((c) => c.id));
  return (
    <div className="visitor-list is-loading" aria-hidden="true">
      {breakpoint !== 'xl' || cards ? (
        <div className="visitor-list__sort">
          <Line w="3.5rem" line={16} bar={8} />
          <div className="visitor-list__sort-row">
            <Skeleton w="auto" h={36} className="skeleton--grow" />
            <Skeleton w="5rem" h={36} />
          </div>
        </div>
      ) : null}
      {cards ? (
        <ul className="visitor-list__cards">
          {Array.from({ length: rows }, (_, i) => (
            <VisitorCardSkeleton key={i} />
          ))}
        </ul>
      ) : (
        <div className="visitor-list__scroller">
          <table className="visitor-table">
            <thead>
              <tr>
                {VISITOR_COLUMNS.filter((c) => cols.has(c.id)).map((c) => (
                  <th key={c.id} scope="col" className={`visitor-table__head${c.align === 'right' ? ' visitor-table__head--right' : ''}`} style={columnStyle(c) as CSSProperties}>
                    <span className="visitor-table__sort">{c.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => (
                <tr key={i} className="visitor-table__row">
                  {VISITOR_COLUMNS.filter((c) => cols.has(c.id)).map((c) => (
                    <td key={c.id} className="visitor-table__cell">
                      {c.skeleton.map((bar, j) => (
                        <Line key={j} w={bar.w} line={bar.h ?? 20} pill={bar.pill} right={c.align === 'right'} />
                      ))}
                      {/* Below lg the flags ride under the id, two tags wrapping to two rows in its width. */}
                      {c.id === 'visitor' && breakpoint === 'md' ? (
                        <span className="visitor-tags visitor-tags--under">
                          <Line w="4.5rem" line={19} pill />
                          <Line w="5rem" line={19} pill />
                        </span>
                      ) : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The drawer's body while its fetch is in flight: the tabs, a few timeline entries, then the always-present edit footer. */
export function DetailSkeleton() {
  return (
    <div className="visitor-detail__loading" aria-hidden="true">
      <div className="tabs">
        {['5rem', '4.5rem', '6rem'].map((w, i) => (
          <span key={i} className="tabs__tab">
            <Skeleton w={w} h={10} />
          </span>
        ))}
      </div>
      <div className="timeline">
        {[0, 1].map((s) => (
          <div key={s} className="timeline-session">
            <Line w="10rem" line={18} />
            {[0, 1, 2].map((i) => (
              <Line key={i} w={`${60 - i * 12}%`} line={22} />
            ))}
          </div>
        ))}
      </div>
      <div className="visitor-detail__edit">
        <Line w="4rem" line={16} bar={8} />
        <Skeleton h={38} />
        <Line w="80%" line={16} bar={8} />
        <Line w="3rem" line={16} bar={8} />
        <Skeleton h={78} />
        <div className="visitor-detail__actions">
          <Skeleton w="6rem" h={32} />
          <Skeleton w="5rem" h={32} />
        </div>
      </div>
    </div>
  );
}

export function MetaFieldSkeletons({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="meta-field" aria-hidden="true">
          <span className="meta-field__icon" />
          <span className="meta-field__text">
            <Line w="3rem" line={14} bar={7} />
            <Line w="7rem" line={16} bar={9} />
          </span>
        </div>
      ))}
    </>
  );
}
