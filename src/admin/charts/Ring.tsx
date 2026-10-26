/**
 * A full ring divided proportionally, with its legend: ONLY for a real partition (mutually exclusive parts that
 * sum to `total`), since that is exactly what the picture asserts. Kept to a handful of segments: angle reads
 * less accurately than length, so a ring earns its place where the shape of a split is the point. The gaps are
 * bare surface (a lighter stroke would be ink that is not data) and come out of the circle before the shares
 * are laid out; a non-zero part always sweeps at least 3 degrees, so "one session" never renders as "none".
 * Butt caps, because a round cap overhangs its end by half the stroke and would bleed across every seam.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ACCENT, PREFERS_REDUCED_MOTION, RING_R, RING_STROKE } from '../lib/chartTheme';

export interface RingSegment {
  key: string;
  value: number;
  color: string;
}

const GAP = 2;
const MIN_SWEEP = 3;

function polar(deg: number): readonly [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [50 + RING_R * Math.cos(rad), 50 + RING_R * Math.sin(rad)];
}

function arc(from: number, to: number): string {
  const [x1, y1] = polar(from);
  const [x2, y2] = polar(to);
  return `M ${x1} ${y1} A ${RING_R} ${RING_R} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

export function Ring({ segments, total, label, children }: { segments: RingSegment[]; total: number; label: string; children?: ReactNode }) {
  // Draws in on mount, clockwise in legend order; skipped outright under reduced motion (no one-frame jump).
  const [drawn, setDrawn] = useState(PREFERS_REDUCED_MOTION);
  useEffect(() => {
    if (PREFERS_REDUCED_MOTION) return;
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (total <= 0) return null;
  const drawable = segments.filter((s) => s.value > 0);
  const usable = 360 - GAP * drawable.length;
  const laid = drawable.map((seg, i) => {
    const before = drawable.slice(0, i).reduce((sum, s) => sum + s.value, 0);
    return { ...seg, from: (before / total) * usable + GAP * i, sweep: Math.max(MIN_SWEEP, (seg.value / total) * usable) };
  });
  return (
    <div className="ring">
      <svg viewBox="0 0 100 100" className="ring__svg" role="img" aria-label={label}>
        <circle cx="50" cy="50" r={RING_R} fill="none" stroke={ACCENT} strokeOpacity={0.12} strokeWidth={RING_STROKE} />
        {laid.map((seg, i) => (
          <path
            key={seg.key}
            d={arc(seg.from, seg.from + seg.sweep)}
            pathLength={100}
            fill="none"
            stroke={seg.color}
            strokeWidth={RING_STROKE}
            strokeLinecap="butt"
            strokeDasharray={100}
            strokeDashoffset={drawn ? 0 : 100}
            style={PREFERS_REDUCED_MOTION ? undefined : { transition: 'stroke-dashoffset 900ms cubic-bezier(0.2, 0.8, 0.2, 1)', transitionDelay: `${i * 90}ms` }}
          />
        ))}
      </svg>
      {children ? <div className="ring__centre">{children}</div> : null}
    </div>
  );
}

/** The number in the middle of a ring and its qualifier: one size on every ring, so a row of them reads as peers. */
export function RingCentre({ value, sub }: { value: ReactNode; sub: ReactNode }) {
  return (
    <>
      <span className="ring__value">{value}</span>
      <span className="ring__sub">{sub}</span>
    </>
  );
}

export interface LegendRow {
  key: string;
  label: string;
  value: ReactNode;
  color?: string;
  /** A real zero: the swatch dims. Never for a small value. */
  dim?: boolean;
}

/**
 * Swatch, name, value. Reserves four rows (min-height in _ring.scss), the tallest any ring card shows, so the
 * rings in one row line up at the top and their captions at the bottom whatever their row counts.
 */
export function ChartLegend({ rows }: { rows: LegendRow[] }) {
  return (
    <ul className="chart-legend" aria-hidden="true">
      {rows.map((row) => (
        <li key={row.key} className="chart-legend__row">
          <span className={row.dim ? 'chart-legend__swatch is-dim' : 'chart-legend__swatch'} style={{ background: row.color ?? 'transparent' }} />
          <span className="chart-legend__label">{row.label}</span>
          <span className="chart-legend__value">{row.value}</span>
        </li>
      ))}
    </ul>
  );
}
