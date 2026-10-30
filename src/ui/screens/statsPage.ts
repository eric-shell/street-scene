/**
 * The settings panel's Stats page, its first: everything the game has counted for the player (shared/stats.ts)
 * and the points ledger (shared/points.ts), so the economy's two numbers, what there is to spend and what
 * unlocks the next parts, are always one tap from any menu. Read when the page opens; nothing here writes.
 * Styled by _stats.scss.
 */
import { h } from '../kit/dom';
import { formatPoints, ordinal } from '../kit/format';
import { roadDistance } from '../kit/units';
import { loadPoints, balanceOf } from '../../shared/points';
import { STAT_MODES, loadStats } from '../../shared/stats';
import { loadPurchases, ownedCount } from '../../shared/purchases';
import { ECONOMY } from '../../shared/economy';
import { SLOT_LABELS, type PartSlot } from '../../shared/parts';
import { FEATURES } from '../../shared/features';

const MODE_LABELS: Record<(typeof STAT_MODES)[number], string> = { circuit: 'Circuit', sprint: 'Sprint', drift: 'Drift', drag: 'Drag', waypoint: 'Waypoint' };

/** Time on the clock the way a stat says it: "2 h 05 min", "12 min 40 s", "35 s". */
function duration(s: number): string {
  const t = Math.round(s);
  const hr = Math.floor(t / 3600);
  const min = Math.floor((t % 3600) / 60);
  if (hr > 0) return `${hr} h ${String(min).padStart(2, '0')} min`;
  if (min > 0) return `${min} min ${String(t % 60).padStart(2, '0')} s`;
  return `${t} s`;
}

const whole = (n: number) => Math.round(n).toLocaleString();

/** One stat: its name over its value (`--big` for the headline numbers). */
const stat = (label: string, value: string, big = false) => h('div', { class: `stats__item${big ? ' stats__item--big' : ''}` }, h('span', { class: 'stats__label' }, label), h('b', { class: 'stats__value' }, value));

/** A headed group of stats. */
const group = (title: string, ...items: HTMLElement[]) => h('section', { class: 'stats__group' }, h('h3', { class: 'section-title stats__title' }, title), h('div', { class: 'stats__grid' }, ...items));

/** The next unlock tier past the races finished: the slots it opens and the races still to go, or null when every tier is open. */
function nextUnlock(races: number): { slots: PartSlot[]; left: number } | null {
  const tiers = (Object.entries(ECONOMY.slots) as [PartSlot, { unlock: number }][]).filter(([, t]) => t.unlock > races);
  if (!tiers.length) return null;
  const at = Math.min(...tiers.map(([, t]) => t.unlock));
  return { slots: tiers.filter(([, t]) => t.unlock === at).map(([s]) => s), left: at - races };
}

export function statsPage(): HTMLElement[] {
  const s = loadStats();
  const p = loadPoints();
  const next = FEATURES.economy ? nextUnlock(s.races) : null;
  return [
    h(
      'div',
      { class: 'stats' },
      group(
        'Points',
        ...(FEATURES.economy ? [stat('To spend', formatPoints(balanceOf(p)), true)] : []),
        stat('Earned', formatPoints(p.total), !FEATURES.economy),
        ...(FEATURES.economy ? [stat('Spent', formatPoints(p.spent)), stat('Parts owned', whole(ownedCount(loadPurchases())))] : []),
        stat('Best run', formatPoints(Math.max(p.best, s.bestRun))),
      ),
      next && h('p', { class: 'stats__note' }, `Next unlock: ${next.slots.map((x) => SLOT_LABELS[x].toLowerCase()).join(', ')} in ${next.left} more ${next.left === 1 ? 'race' : 'races'}.`),
      group(
        'Racing',
        stat('Races finished', whole(s.races), true),
        stat('Wins', whole(s.wins)),
        stat('Podiums', whole(s.podiums)),
        stat('Best finish', s.bestFinish > 0 ? ordinal(s.bestFinish) : '–'),
        stat('Time racing', duration(s.raceTime)),
        stat('Distance', roadDistance(s.distance)),
        stat('Drift score', formatPoints(s.driftScore)),
        stat('Lost to crashes', formatPoints(s.crashPoints)),
        stat('Free roam drives', whole(s.freeRoams)),
      ),
      group('Finished by mode', ...STAT_MODES.map((m) => stat(MODE_LABELS[m], whole(s.byMode[m])))),
      h('p', { class: 'stats__note' }, 'Live races only: replays and debug-tuned runs count nothing. Wins and podiums count races with rivals.'),
    ),
  ];
}
