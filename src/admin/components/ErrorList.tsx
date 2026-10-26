/**
 * The insights' Errors card (op=insights `errors`): the most reported crash messages in the window, so a launch-day
 * break on a device nobody here owns shows at a glance instead of inside one visitor's timeline. Each row is the
 * kind, the message, how many reports from how many visitors, where it happened and when last; it opens to the
 * newest report's top stack frames.
 */
import type { ErrorRow } from '../../../api/_lib/adminTypes';
import { formatLastSeen } from '../lib/dateFormat';
import { ERROR_KIND } from '../lib/gameVocab';
import { ChartEmpty } from './ChartFrame';

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function ErrorList({ rows }: { rows: ErrorRow[] }) {
  if (rows.length === 0) return <ChartEmpty>No crashes reported in this window.</ChartEmpty>;
  return (
    <ul className="error-list">
      {rows.map((r) => (
        <li key={`${r.kind}:${r.message}`} className="error-list__item">
          <details className="error-list__details">
            <summary className="error-list__row">
              <span className={`error-list__kind error-list__kind--${r.kind}`}>{ERROR_KIND[r.kind]}</span>
              <span className="error-list__message" title={r.message}>
                {r.message || '(no message)'}
              </span>
              <span className="error-list__count">
                <strong>{r.count}</strong> <span className="error-list__dim">· {plural(r.visitors, 'visitor')}</span>
              </span>
              <span className="error-list__when">
                {r.screens.length ? `${r.screens.join(', ')} · ` : ''}
                {formatLastSeen(r.lastSeen)}
              </span>
            </summary>
            {r.stack ? <pre className="error-list__stack">{r.stack}</pre> : <p className="error-list__stack">No stack: {r.kind === 'webgl' || r.kind === 'context_lost' ? 'a browser report, not a thrown error' : 'the error carried none'}.</p>}
          </details>
        </li>
      ))}
    </ul>
  );
}
