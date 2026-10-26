/**
 * The results screen: a rail beside the finish shots (ui/rail/rail.ts) in the
 * pause screen's language: the card of how it went (the headline, place or
 * score, a new best, the standings) with Retry on it, the style score (the
 * nitrous callouts' points, counted up from 0 with what paid them and what
 * crashes cost, beside the event's best) on a card of its own, and what next
 * as rows. Styled by _results-screen.scss and _results-card.scss.
 */
import { btn, h, prefersReducedMotion } from '../kit/dom';
import { ChevronsRight, MapPinned, Medal, RotateCcw, Route, Share2, Sparkles, Trophy, Video, Wind, Wrench, X, icon, type IconNode } from '../kit/icons';
import { formatTime, ordinal } from '../kit/format';
import { navRow, railScreen } from '../rail/rail';
import { Help } from '../panels/help';
import { openSignInDialog, signInRow } from './signIn';
import type { RaceMode } from '../../sim/race';
import { styleTotal, type StyleSource, type StyleTally } from '../hud/boostCallouts';

export interface ResultRow {
  name: string;
  car: string;
  time: number;
  estimated: boolean;
  me: boolean;
  bestLap: number | null;
}

const MODE_LABEL: Record<RaceMode, string> = { circuit: 'Circuit', sprint: 'Sprint', drag: 'Drag', waypoint: 'Waypoint', drift: 'Drift' };
/** The race type's icon, as the pause card and the menu's type tiles show it. */
const TYPE_ICON: Record<RaceMode, IconNode> = { circuit: RotateCcw, sprint: Route, drag: ChevronsRight, waypoint: MapPinned, drift: Wind };

/** The style score's lines, in this order (zero lines are left out); crashes count against it. */
const STYLE_LINES: [StyleSource, string][] = [
  ['drift', 'Drifts'],
  ['nearMiss', 'Near misses'],
  ['draft', 'Slipstream'],
  ['wreck', 'Wrecks'],
  ['crash', 'Crashes'],
];
/** How long the style total counts up (s), after the screen's own entrance. */
const STYLE_COUNT = { delay: 0.45, time: 1.2 } as const;

const pts = (n: number) => Math.round(n).toLocaleString('en-US');

/** The style score's card: the total counting up, its best or a new one, and a line per source that paid. */
function styleBlock(tally: StyleTally, best: number, newBest: boolean): HTMLElement {
  const total = styleTotal(tally);
  const value = h('b', { class: 'results-style__total' }, pts(prefersReducedMotion() ? total : 0));
  const list = h('ul', { class: 'results-style__list' });
  for (const [k, label] of STYLE_LINES) {
    if (Math.round(tally[k]) <= 0) continue;
    list.append(h('li', { class: k === 'crash' ? 'results-style__item results-style__item--crash' : 'results-style__item' }, h('span', {}, label), h('b', {}, `${k === 'crash' ? '−' : '+'}${pts(tally[k])}`)));
  }
  if (!prefersReducedMotion() && total > 0) {
    const start = performance.now() + STYLE_COUNT.delay * 1000;
    const step = (now: number) => {
      if (!value.isConnected && now > start) return;
      const k = Math.max(0, Math.min(1, (now - start) / (STYLE_COUNT.time * 1000)));
      value.textContent = pts(total * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return h(
    'section',
    { class: 'results-style', 'aria-label': 'Style' },
    h('div', { class: 'results-style__head' }, h('span', { class: 'label label--kicker' }, icon(Sparkles, { size: 14 }), 'Style'), value, newBest ? h('span', { class: 'results-screen__badge' }, icon(Sparkles, { size: 14 }), 'Style best') : best > 0 && h('span', { class: 'results-style__best' }, `Best ${pts(best)}`)),
    list,
  );
}

/**
 * Results: a rail beside the finish shots in the pause screen's language (the menu's and the garage's): a
 * scrim, no column, the parts plates of their own, and no screen title (the card says it all). A card shaped
 * like the pause card says how it went (the race type as its kicker, the event's name, the place or score
 * with a new best on it, the standings) and ends in Retry, the screen's main action, which glints; the style
 * score is a card of its own under it, and the way on is rows in their hues like the pause screen's (replay
 * cyan, the garage orange as on the menu, the menu red like quit), after Sign in (yellow, signed out only:
 * the sign-in dialog over the results) while a good run is fresh.
 */
export function resultsScreen(o: {
  mode: RaceMode;
  /** The seed's event name (Hill Climb, River Run, ...), the card's name. */
  event?: string;
  rows: ResultRow[];
  position: number;
  driftScore?: number;
  newBest: boolean;
  /** The player's style score by source (points), the event's best before this run, and whether this run beat it. */
  style: StyleTally;
  styleBest: number;
  newStyleBest: boolean;
  tuned: boolean;
  /** Send this result as a challenge link; no row without it (replays, tuned runs, a city off the event). */
  onChallenge?: () => void;
  onRetry(): void;
  onReplay(): void;
  onGarage(): void;
  onMenu(): void;
}): HTMLElement {
  const table = h('table', { class: 'results-table' });
  // A column of best laps when any racer has one (circuits).
  const laps = o.rows.some((r) => r.bestLap);
  o.rows.forEach((r, i) =>
    table.append(
      h(
        'tr',
        { class: r.me ? 'results-table__row results-table__row--player' : 'results-table__row' },
        h('td', { class: 'results-table__cell results-table__pos' }, String(i + 1)),
        h('td', { class: 'results-table__cell results-table__name' }, r.name, h('span', { class: 'results-table__car' }, r.car)),
        laps && h('td', { class: 'results-table__cell results-table__lap', title: 'Best lap' }, r.bestLap ? formatTime(r.bestLap) : ''),
        h('td', { class: 'results-table__cell results-table__time' }, (r.estimated ? '~' : '') + formatTime(r.time)),
      ),
    ),
  );
  const drift = o.mode === 'drift';
  const headline = drift ? `${Math.round(o.driftScore ?? 0).toLocaleString()} pts` : o.position === 1 ? 'You win!' : `${ordinal(o.position)} place`;
  const retry = btn(RotateCcw, 'Retry', o.onRetry, '--large --primary --cta results-card__go');
  const card = h(
    'section',
    { class: `results-card mode-${o.mode}`, 'aria-label': 'How it went' },
    h('span', { class: 'label label--kicker' }, icon(TYPE_ICON[o.mode], { size: 14 }), MODE_LABEL[o.mode]),
    h('h3', { class: 'results-card__name' }, o.event ?? MODE_LABEL[o.mode]),
    h(
      'div',
      { class: 'results-card__place' },
      icon(o.position === 1 || drift ? Trophy : Medal, { size: 30 }),
      h('span', { class: 'results-card__score' }, headline),
      o.newBest && h('span', { class: 'results-screen__badge' }, icon(Sparkles, { size: 14 }), 'New best'),
    ),
    o.tuned && h('p', { class: 'results-card__note' }, 'Dev tuning was changed during this run, so it was not saved.'),
    !drift && h('div', { class: 'results-card__standings' }, table),
    retry,
  );
  const col = h(
    'div',
    { class: 'rail__col' },
    h(
      'div',
      { class: 'rail__step' },
      card,
      styleBlock(o.style, o.styleBest, o.newStyleBest),
      h(
        'nav',
        { class: 'nav-list', 'aria-label': 'What next' },
        signInRow(() => openSignInDialog(root)),
        o.onChallenge && navRow(Share2, 'Challenge a friend', 'Send a link to beat this', 'green', o.onChallenge),
        navRow(Video, 'Replay', 'Watch the run again', 'cyan', o.onReplay),
        navRow(Wrench, 'Garage', 'Tune or change the car', 'orange', o.onGarage),
        navRow(X, 'Menu', 'Back to the event', 'red', o.onMenu),
      ),
    ),
  );
  const help = new Help({
    title: 'Results',
    sections: () => [
      { title: 'Keys', keys: [{ keys: ['Enter'], label: 'Retry' }] },
      { title: 'Tips', tips: ['Replay watches the run again; C changes the camera.', 'Racing solo, your best on this event drives beside you as a ghost.'] },
    ],
  });
  const root = railScreen('results-screen --scrim', col, help.el);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Results');
  requestAnimationFrame(() => retry.focus({ preventScroll: true }));
  return root;
}
