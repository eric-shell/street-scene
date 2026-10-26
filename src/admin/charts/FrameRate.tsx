/**
 * Frame rate against the game's own lines (render/autoQuality.ts FRAME_BUDGET): every device should hold 60 fps
 * and never sit under 30. Rows are a label, a status in words, and a bar of median fps on a shared 0-to-120
 * scale (more when a row runs faster) with the hold and floor lines drawn through every track. The bar is the
 * one accent series; the status is NOT a fill color (green and yellow collapse under protanopia, chartTheme.ts)
 * but an icon and a word, inked green, yellow or red. Used for the quality tiers and the GPU families.
 */
import { CircleCheck, OctagonAlert, TriangleAlert, type IconNode } from 'lucide';
import { ChartEmpty } from '../components/ChartFrame';
import { Icon } from '../components/Icon';
import { ACCENT } from '../lib/chartTheme';
import { AIM_FPS, FLOOR_FPS, FPS_STATUS_LABEL, HOLD_FPS, fpsStatus, type FpsStatus } from '../lib/gameVocab';

const STATUS_ICON: Record<FpsStatus, IconNode> = { holds: CircleCheck, 'under-hold': TriangleAlert, 'under-floor': OctagonAlert };

/** A median frame rate's status as a word with its icon (also the visitor table's frame-rate cell). */
export function FpsBadge({ fps, compact }: { fps: number; compact?: boolean }) {
  const status = fpsStatus(fps);
  return (
    <span className={`fps-status fps-status--${status}`} title={`${Math.round(fps)} fps median: ${FPS_STATUS_LABEL[status].toLowerCase()} (the game holds ${HOLD_FPS}, never under ${FLOOR_FPS})`}>
      <Icon node={STATUS_ICON[status]} size={compact ? 11 : 12} strokeWidth={2.5} />
      {compact ? `${Math.round(fps)} fps` : FPS_STATUS_LABEL[status]}
    </span>
  );
}

export interface FrameRateRow {
  key: string;
  label: string;
  fps: number;
  /** The supporting numbers under the bar (p95, slow share, samples). */
  sub: string;
}

export function FrameRateChart({ rows, empty }: { rows: FrameRateRow[]; empty: string }) {
  if (rows.length === 0) return <ChartEmpty>{empty}</ChartEmpty>;
  const scale = Math.max(AIM_FPS, ...rows.map((r) => r.fps));
  const at = (fps: number) => `${(fps / scale) * 100}%`;
  return (
    <>
      <div className="fps-chart" aria-hidden="true">
        <div className="fps-chart__axis">
          <span className="fps-chart__tick" style={{ left: at(FLOOR_FPS) }}>
            {FLOOR_FPS} floor
          </span>
          <span className="fps-chart__tick" style={{ left: at(HOLD_FPS) }}>
            {HOLD_FPS} hold
          </span>
        </div>
        <ul className="fps-chart__rows">
          {rows.map((r) => (
            <li key={r.key} className="fps-chart__row" title={`${r.label}: ${Math.round(r.fps)} fps median · ${r.sub}`}>
              <span className="fps-chart__head">
                <span className="fps-chart__label">{r.label}</span>
                <span className="fps-chart__value">
                  {Math.round(r.fps)} fps <FpsBadge fps={r.fps} />
                </span>
              </span>
              <span className="fps-chart__track">
                <span className="fps-chart__fill" style={{ width: at(r.fps), background: ACCENT }} />
                <span className="fps-chart__line" style={{ left: at(FLOOR_FPS) }} />
                <span className="fps-chart__line" style={{ left: at(HOLD_FPS) }} />
              </span>
              <span className="fps-chart__sub">{r.sub}</span>
            </li>
          ))}
        </ul>
      </div>
      <ul className="sr-only">
        {rows.map((r) => (
          <li key={r.key}>
            {r.label}: {Math.round(r.fps)} fps median, {FPS_STATUS_LABEL[fpsStatus(r.fps)].toLowerCase()}; {r.sub}.
          </li>
        ))}
      </ul>
    </>
  );
}
