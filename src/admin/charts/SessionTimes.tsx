/**
 * Time per session as two stat figures, not a chart: medians are single headline numbers, and a bar for each
 * would invent an axis for two values that are not even the same population (engaged time covers every
 * session; driving time only the sessions that drove at all).
 */
import type { InsightsPayload } from '../../../api/_lib/adminTypes';
import { formatDuration } from '../lib/dateFormat';

export function SessionTimes({ sessions }: { sessions: InsightsPayload['sessions'] }) {
  return (
    <div className="session-times">
      <div className="session-times__item">
        <span className="session-times__label">Engaged</span>
        <span className="session-times__value">{formatDuration(sessions.medianEngagedMs)}</span>
        <span className="session-times__sub">median, tab visible</span>
      </div>
      <div className="session-times__item">
        <span className="session-times__label">Driving</span>
        <span className="session-times__value">{formatDuration(sessions.medianRaceMs)}</span>
        <span className="session-times__sub">median of sessions that drove</span>
      </div>
    </div>
  );
}
