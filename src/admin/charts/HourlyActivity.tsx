/**
 * Sessions by hour of day: when do players actually turn up? One series in the accent, each hour shaded by its
 * share of the peak. The aggregate buckets in UTC (Postgres does not know the reader's clock); the shift to
 * local hours happens here, only for a whole-hour offset (chartTheme localHourOffset), otherwise the axis says
 * UTC. Each column's full height is the hit target, not its few-pixel bar, and the readout is centred over its
 * own bar (clamped at the two ends), never trailing the pointer. Pointer MOVE drives it, not enter: crossing the
 * gaps between 24 columns fires leave and enter unreliably, and hiding happens once, on leaving the strip.
 */
import { useCallback, useMemo } from 'react';
import { useTooltip, useTooltipInPortal } from '@visx/tooltip';
import type { HourRow } from '../../../api/_lib/adminTypes';
import { ChartEmpty } from '../components/ChartFrame';
import { formatHour, localHourOffset, magnitudeStep } from '../lib/chartTheme';

interface Column {
  displayHour: number;
  sessions: number;
}

/** Half the widest readout ("15 sessions · 11pm UTC" at 12 px), to keep a centred readout inside the card. */
const TIP_HALF = 70;

export function HourlyActivity({ hourly }: { hourly: HourRow[] }) {
  const offset = localHourOffset();
  const columns = useMemo<Column[]>(() => {
    const byHour = new Map(hourly.map((h) => [h.hour, h.sessions]));
    return Array.from({ length: 24 }, (_, displayHour) => ({ displayHour, sessions: byHour.get((((displayHour - (offset ?? 0)) % 24) + 24) % 24) ?? 0 }));
  }, [hourly, offset]);
  const { showTooltip, hideTooltip, tooltipData, tooltipLeft = 0, tooltipTop = 0 } = useTooltip<Column>();
  const { containerRef, containerBounds, TooltipInPortal } = useTooltipInPortal({ detectBounds: false, scroll: true });

  const handleMove = useCallback(
    (col: Column) => (e: React.PointerEvent<HTMLDivElement>) => {
      if (tooltipData?.displayHour === col.displayHour) return;
      const bar = e.currentTarget.firstElementChild;
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      const centre = r.left - containerBounds.left + r.width / 2;
      showTooltip({ tooltipData: col, tooltipLeft: Math.min(Math.max(centre, TIP_HALF), Math.max(TIP_HALF, containerBounds.width - TIP_HALF)), tooltipTop: r.top - containerBounds.top });
    },
    [containerBounds.left, containerBounds.top, containerBounds.width, showTooltip, tooltipData],
  );

  const max = Math.max(...columns.map((c) => c.sessions), 0);
  if (max === 0) return <ChartEmpty>No sessions in this window.</ChartEmpty>;
  const peak = columns.reduce((a, b) => (b.sessions > a.sessions ? b : a));
  return (
    <>
      <div ref={containerRef} className="hour-strip">
        <div className="hour-strip__columns" aria-hidden="true" onPointerLeave={hideTooltip}>
          {columns.map((col) => (
            <div key={col.displayHour} className={tooltipData?.displayHour === col.displayHour ? 'hour-strip__column is-hovered' : 'hour-strip__column'} onPointerMove={handleMove(col)} onPointerEnter={handleMove(col)}>
              <span
                className={col.sessions === 0 ? 'hour-strip__bar is-empty' : 'hour-strip__bar'}
                // An empty hour keeps a 2 px stub: the hour exists and was quiet, not missing.
                style={{ height: col.sessions === 0 ? 2 : `${Math.max(6, (col.sessions / max) * 100)}%`, background: magnitudeStep(col.sessions, max) }}
              />
            </div>
          ))}
        </div>
        <div className="hour-strip__baseline" />
        {/* Four equal cells of six hours, so each tick starts at the column it names. */}
        <div className="hour-strip__axis" aria-hidden="true">
          {[0, 6, 12, 18].map((h) => (
            <span key={h}>{formatHour(h)}</span>
          ))}
        </div>
        {tooltipData ? (
          <TooltipInPortal unstyled applyPositionStyle top={tooltipTop} left={tooltipLeft} offsetLeft={0} offsetTop={0} className="chart-tooltip chart-tooltip--above">
            <strong>
              {tooltipData.sessions} {tooltipData.sessions === 1 ? 'session' : 'sessions'}
            </strong>
            <span className="chart-tooltip__dim">
              {' · '}
              {formatHour(tooltipData.displayHour)}
              {offset === null ? ' UTC' : ''}
            </span>
          </TooltipInPortal>
        ) : null}
      </div>
      <ul className="sr-only">
        <li>
          Hours in {offset === null ? 'UTC' : 'local time'}. Busiest hour {formatHour(peak.displayHour)} with {peak.sessions} sessions.
        </li>
        {columns.map((c) => (
          <li key={c.displayHour}>
            {formatHour(c.displayHour)}: {c.sessions} sessions.
          </li>
        ))}
      </ul>
    </>
  );
}
