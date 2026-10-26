/**
 * A ranked horizontal bar list (top cars, repeat seeds, sources). One series in the accent, shaded by magnitude
 * (chartTheme magnitudeStep, scaled to the largest row so the tail keeps its shape when one row dominates).
 * The rows are nominal, so the shade carries no identity: it is a second reading of the length. Every value is
 * also in a screen-reader list; the visible rows are aria-hidden so nothing is read twice.
 */
import type { ReactNode } from 'react';
import { ChartEmpty } from '../components/ChartFrame';
import { magnitudeStep } from '../lib/chartTheme';

export interface BarListItem {
  /** Display label: truncated visually, whole in the title and the screen-reader list. */
  label: string;
  /** An optional mark before the label (a mode's icon). */
  lead?: ReactNode;
  value: number;
  /** Extra context for the title and the screen-reader list only, never competing with the value in the row. */
  detail?: string;
}

export function BarList({ items, empty, unit }: { items: BarListItem[]; empty: string; unit: string }) {
  if (items.length === 0) return <ChartEmpty>{empty}</ChartEmpty>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <>
      {/* Keyed by rank: labels are not unique across callers (two seeds can share a typed name). */}
      <ul className="bar-list" aria-hidden="true">
        {items.map((item, i) => (
          <li key={i} className="bar-list__row" title={`${item.label}: ${item.value} ${unit}${item.detail ? `, ${item.detail}` : ''}`}>
            <span className="bar-list__label">
              {item.lead}
              <span className="bar-list__text">{item.label}</span>
            </span>
            <span className="bar-list__track">
              <span className="bar-list__fill" style={{ width: `${(item.value / max) * 100}%`, background: magnitudeStep(item.value, max) }} />
            </span>
            <span className="bar-list__value">{item.value}</span>
          </li>
        ))}
      </ul>
      <ul className="sr-only">
        {items.map((item, i) => (
          <li key={i}>
            {item.label}: {item.value} {unit}
            {item.detail ? `, ${item.detail}` : ''}.
          </li>
        ))}
      </ul>
    </>
  );
}
