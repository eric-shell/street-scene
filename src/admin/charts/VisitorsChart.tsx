/**
 * New visitors per day, the one time series on the page: a single series, so no legend (the caption names it).
 * The accent line at 2 px over a short accent-to-deep wash, a hairline ceiling with its value and a hairline
 * baseline (solid, never dashed), and a crosshair with the nearest day's readout: the whole plot is the hit
 * target, since a one-day-wide band is impossible to land on. The readout renders in a portal so a point near
 * the top of this short card is not clipped by it. Every value is also in a screen-reader list.
 */
import { useCallback, useMemo } from 'react';
import { curveMonotoneX } from '@visx/curve';
import { localPoint } from '@visx/event';
import { LinearGradient } from '@visx/gradient';
import { ParentSize } from '@visx/responsive';
import { scaleLinear, scaleTime } from '@visx/scale';
import { AreaClosed, Bar, LinePath } from '@visx/shape';
import { useTooltip, useTooltipInPortal } from '@visx/tooltip';
import type { StatDay } from '../../../api/_lib/adminTypes';
import { ACCENT, DEEP, HAIRLINE, SURFACE } from '../lib/chartTheme';
import { formatMonthDay } from '../lib/dateFormat';

interface Point {
  date: Date;
  visitors: number;
}

/** The ceiling label's band at the top, so the peak's marker (5 px and its 2 px ring) is never clipped. */
const TOP_PAD = 8;

function Plot({ days, width, height }: { days: StatDay[]; width: number; height: number }) {
  const { showTooltip, hideTooltip, tooltipData, tooltipLeft = 0, tooltipTop = 0 } = useTooltip<Point>();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({ detectBounds: true, scroll: true });
  const data = useMemo<Point[]>(() => days.map((d) => ({ date: new Date(`${d.date}T00:00:00`), visitors: d.visitors })), [days]);
  const x = useMemo(() => scaleTime({ range: [0, width], domain: [data[0]?.date ?? new Date(), data[data.length - 1]?.date ?? new Date()] }), [data, width]);
  const y = useMemo(() => scaleLinear({ range: [height, TOP_PAD], domain: [0, Math.max(...data.map((d) => d.visitors), 1)], nice: true }), [data, height]);

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGRectElement> | React.TouchEvent<SVGRectElement>) => {
      const point = localPoint(event);
      if (!point || data.length === 0) return;
      const x0 = x.invert(point.x).valueOf();
      let nearest = data[0];
      for (const d of data) if (Math.abs(d.date.valueOf() - x0) < Math.abs(nearest.date.valueOf() - x0)) nearest = d;
      showTooltip({ tooltipData: nearest, tooltipLeft: x(nearest.date), tooltipTop: y(nearest.visitors) });
    },
    [data, showTooltip, x, y],
  );

  if (width < 10 || height < 10 || data.length === 0) return null;
  const ceiling = y.domain()[1];
  return (
    <>
      <svg ref={containerRef} width={width} height={height} className="visitors-chart__svg">
        <LinearGradient id="visitors-wash" from={ACCENT} to={DEEP} fromOpacity={0.32} toOpacity={0.02} />
        <line x1={0} x2={width} y1={y(ceiling)} y2={y(ceiling)} stroke={HAIRLINE} strokeWidth={1} />
        <text x={0} y={y(ceiling) + 11} className="visitors-chart__ceiling">
          {ceiling}
        </text>
        <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={HAIRLINE} strokeWidth={1} />
        <AreaClosed<Point> data={data} x={(d) => x(d.date)} y={(d) => y(d.visitors)} yScale={y} curve={curveMonotoneX} fill="url(#visitors-wash)" />
        <LinePath<Point> data={data} x={(d) => x(d.date)} y={(d) => y(d.visitors)} curve={curveMonotoneX} stroke={ACCENT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {tooltipData ? (
          <g>
            <line x1={tooltipLeft} x2={tooltipLeft} y1={0} y2={height} stroke={HAIRLINE} strokeWidth={1} />
            <circle cx={tooltipLeft} cy={tooltipTop} r={5} fill={ACCENT} stroke={SURFACE} strokeWidth={2} />
          </g>
        ) : null}
        <Bar width={width} height={height} fill="transparent" onMouseMove={handleMove} onTouchMove={handleMove} onMouseLeave={hideTooltip} onTouchEnd={hideTooltip} />
      </svg>
      {tooltipData ? (
        <TooltipInPortal unstyled applyPositionStyle top={tooltipTop - 12} left={tooltipLeft} className="chart-tooltip">
          <strong>{tooltipData.visitors}</strong>
          <span className="chart-tooltip__dim"> · {formatMonthDay(tooltipData.date.toISOString())}</span>
        </TooltipInPortal>
      ) : null}
    </>
  );
}

export function VisitorsChart({ days }: { days: StatDay[] }) {
  const total = days.reduce((sum, d) => sum + d.visitors, 0);
  const peak = Math.max(0, ...days.map((d) => d.visitors));
  return (
    <figure className="visitors-chart">
      <figcaption className="chart-card__caption">
        <span className="chart-card__title">New visitors / day</span>
        <span className="chart-card__meta">
          {total} in {days.length}d
        </span>
      </figcaption>
      <div className="visitors-chart__plot">{days.length > 0 ? <ParentSize debounceTime={0}>{({ width, height }) => <Plot days={days} width={width} height={height} />}</ParentSize> : null}</div>
      <div className="visitors-chart__axis" aria-hidden="true">
        {days.length > 0 ? (
          <>
            <span>{formatMonthDay(`${days[0].date}T00:00:00`)}</span>
            <span>{formatMonthDay(`${days[days.length - 1].date}T00:00:00`)}</span>
          </>
        ) : null}
      </div>
      <ul className="sr-only">
        <li>Peak {peak} new visitors in a day.</li>
        {days.map((d) => (
          <li key={d.date}>
            {formatMonthDay(`${d.date}T00:00:00`)}: {d.visitors} new visitors
          </li>
        ))}
      </ul>
    </figure>
  );
}
