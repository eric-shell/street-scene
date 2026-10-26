/**
 * Which viewport widths the game is played at, as one partitioned ring. Viewport, not device: only the CSS
 * width is recorded, so a half-screen desktop window lands in the narrow band, and the labels name width bands
 * and the caption says so. Shade is magnitude (the biggest band is the brightest), never band identity; the
 * legend carries identity in words.
 */
import type { ViewportMix as Viewport } from '../../../api/_lib/adminTypes';
import { ChartEmpty } from '../components/ChartFrame';
import { magnitudeRamp } from '../lib/chartTheme';
import { share } from '../lib/dateFormat';
import { ChartLegend, Ring, RingCentre } from './Ring';

const BANDS: readonly { key: 'phone' | 'tablet' | 'desktop'; label: string; hint: string }[] = [
  { key: 'phone', label: 'Narrow', hint: 'under 640 px: phones' },
  { key: 'tablet', label: 'Medium', hint: '640 to 1023 px: tablets, split windows' },
  { key: 'desktop', label: 'Wide', hint: '1024 px and up: laptops, desktops' },
];

export function ViewportMix({ viewport }: { viewport: Viewport }) {
  const total = viewport.known;
  if (total === 0) return <ChartEmpty>No session reported a viewport in this window.</ChartEmpty>;
  const colors = magnitudeRamp(BANDS.map((b) => viewport[b.key]));
  const rows = BANDS.map((b, i) => ({ ...b, value: viewport[b.key], pct: share(viewport[b.key], total), color: colors[i] }));
  return (
    <>
      <div className="ring-card">
        <Ring segments={rows} total={total} label={rows.map((r) => `${r.label}: ${r.pct}%`).join(', ')}>
          <RingCentre value={total} sub={total === 1 ? 'session' : 'sessions'} />
        </Ring>
        <ChartLegend
          rows={rows.map((r) => ({
            key: r.key,
            label: r.label,
            color: r.color,
            dim: r.value === 0,
            value: (
              <>
                {r.pct}% <span className="chart-legend__dim">· {r.value}</span>
              </>
            ),
          }))}
        />
      </div>
      <p className="ring-card__caption">Browser viewport width, not device: a half-screen desktop window counts as narrow.</p>
      <ul className="sr-only">
        {rows.map((r) => (
          <li key={r.key}>
            {r.label} viewport ({r.hint}): {r.value} of {total} sessions ({r.pct}%).
          </li>
        ))}
      </ul>
    </>
  );
}
