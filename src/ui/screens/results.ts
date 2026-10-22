/**
 * The results screen: a rail beside the finish shots (ui/rail/rail.ts) with
 * the headline (place or score), a new best, the standings and what next.
 * Styled by _results-screen.scss.
 */
import { btn, h } from '../kit/dom';
import { Flag, Medal, RotateCcw, Sparkles, Trophy, Video, Wrench, X, icon } from '../kit/icons';
import { formatTime, ordinal } from '../kit/format';
import { railScreen } from '../rail/rail';
import { Help } from '../panels/help';
import type { RaceMode } from '../../sim/race';

export interface ResultRow {
  name: string;
  car: string;
  time: number;
  estimated: boolean;
  me: boolean;
  bestLap: number | null;
}

const MODE_LABEL: Record<RaceMode, string> = { circuit: 'Circuit', sprint: 'Sprint', drag: 'Drag', waypoint: 'Waypoint', drift: 'Drift' };

/** Results: a rail beside the finish shots with the headline (place or score), a new best, the standings and what next. */
export function resultsScreen(o: {
  mode: RaceMode;
  /** The seed's event name (Hill Climb, River Run, ...), over the headline. */
  event?: string;
  rows: ResultRow[];
  position: number;
  driftScore?: number;
  newBest: boolean;
  tuned: boolean;
  onRetry(): void;
  onReplay(): void;
  onGarage(): void;
  onMenu(): void;
}): HTMLElement {
  const table = h('table', { class: 'results-table' });
  o.rows.forEach((r, i) =>
    table.append(
      h(
        'tr',
        { class: r.me ? 'results-table__row results-table__row--player' : 'results-table__row' },
        h('td', { class: 'results-table__cell results-table__pos' }, String(i + 1)),
        h('td', { class: 'results-table__cell' }, r.name, h('span', { class: 'results-table__car' }, r.car + (r.bestLap ? ` · best lap ${formatTime(r.bestLap)}` : ''))),
        h('td', { class: 'results-table__cell results-table__time' }, (r.estimated ? '~' : '') + formatTime(r.time)),
      ),
    ),
  );
  const drift = o.mode === 'drift';
  const headline = drift ? `${Math.round(o.driftScore ?? 0).toLocaleString()} pts` : o.position === 1 ? 'You win!' : `${ordinal(o.position)} place`;
  const retry = btn(RotateCcw, 'Retry', o.onRetry, '--large --primary');
  const col = h(
    'div',
    { class: 'rail__col is-entering' },
    h(
      'div',
      { class: 'results-screen__head' },
      h('div', { class: 'label' }, icon(Flag, { size: 14 }), o.event ? `${o.event} · ${MODE_LABEL[o.mode]}` : MODE_LABEL[o.mode]),
      h('h2', { class: 'results-screen__title' }, icon(o.position === 1 || drift ? Trophy : Medal, { size: 34 }), h('span', { class: 'results-screen__score' }, headline)),
      o.newBest && h('div', {}, h('span', { class: 'results-screen__badge' }, icon(Sparkles, { size: 14 }), 'New best')),
      o.tuned && h('p', { class: 'results-screen__note' }, 'Dev tuning was changed during this run, so it was not saved.'),
    ),
    !drift && h('div', { class: 'section-title' }, 'Standings'),
    !drift && table,
    h('div', { class: 'results-screen__actions' }, retry, btn(Video, 'Replay', o.onReplay), btn(Wrench, 'Garage', o.onGarage), btn(X, 'Menu', o.onMenu)),
  );
  const help = new Help({
    title: 'Results',
    sections: () => [
      { title: 'Keys', keys: [{ keys: ['Enter'], label: 'Retry' }] },
      { title: 'Tips', tips: ['Replay watches the run again; C changes the camera.', 'Racing solo, your best on this event drives beside you as a ghost.'] },
    ],
  });
  const root = railScreen('results-screen', col, help.el);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Results');
  requestAnimationFrame(() => retry.focus({ preventScroll: true }));
  return root;
}
