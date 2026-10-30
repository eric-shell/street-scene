/**
 * The This Week step of the main menu (menu.ts): the seven race days, Monday to Sunday, one row each with
 * its weekday and date, the event's name and tagline, a chip for its flavour (in its signature district's
 * map ink) and for a weekend's special, a thumbnail of the city, and where the day stands. Tonight is
 * highlighted and picking it goes back to today's city; a past day shows your best time on it (or Not raced)
 * and picking it plays that day's city again; a day to come shows its event dimmed, with a lock and when
 * it opens (Tomorrow, Unlocks Mon), and cannot be picked. The days' names, taglines and maps come from
 * planning their roads, which costs about 300 ms each, so weekPlanner.ts does it off the main thread: the
 * rows stand as skeletons and fill as the answers arrive, today first. A pick calls `onPick` (menu.ts
 * switches the city and returns home); the arrow keys walk the rows you can pick, Enter picks.
 */
import { chip, h, sheen } from '../kit/dom';
import { Calendar, Lock, Moon, Sparkles, Trophy, icon } from '../kit/icons';
import { formatTime } from '../kit/format';
import { KINDS } from '../map/cityMap';
import { EVENT_FLAVOURS } from '../../city/events';
import { seedFromString } from '../../sim/prng';
import { loadBest } from '../../replay/replay';
import type { RaceMode } from '../../sim/race';
import { unlockLabel, type RaceDay } from '../../seed';
import { screenHead } from '../rail/rail';
import { SIGNATURE } from './menuMaps';
import { THUMB_H, THUMB_W, type DaySummary } from './weekThumb';
import type { WeekPlanner } from './weekPlanner';

export interface WeekOptions {
  planner: WeekPlanner;
  /** The week's days (seed.ts weekOf). */
  days: readonly RaceDay[];
  /** The city on screen now: its row is marked, and picking it just goes home. */
  seed: string;
  /** Play a day's city again (null: today's). The menu shows the city and returns to its home. */
  onPick(seed: string | null): void;
  back(): void;
}

export interface WeekStep {
  parts: HTMLElement[];
  /** Arrow keys walk the rows; true when the key was used. */
  key(e: KeyboardEvent): boolean;
  dispose(): void;
}

/** The modes whose time a row can show, in the order one is chosen. Drift keeps a score, shown as points. */
const BEST_MODES: { mode: RaceMode; label: string }[] = [
  { mode: 'circuit', label: 'Circuit' },
  { mode: 'sprint', label: 'Sprint' },
  { mode: 'drag', label: 'Drag' },
  { mode: 'waypoint', label: 'Waypoint' },
  { mode: 'drift', label: 'Drift' },
];

/** Your best on a day in the first mode you have raced it in, as "1:42.30 · Circuit"; null when you have not raced it. */
function bestOn(seed: string): string | null {
  const n = seedFromString(seed);
  for (const { mode, label } of BEST_MODES) {
    const b = loadBest(n, mode);
    if (b) return `${mode === 'drift' ? `${Math.round(b.score ?? 0).toLocaleString()} pts` : formatTime(b.time)} · ${label}`;
  }
  return null;
}

/** A day's status, top right of its row. */
function status(day: RaceDay): HTMLElement {
  if (day.state === 'today') return h('span', { class: 'week-row__status' }, icon(Moon, { size: 14 }), 'Tonight');
  if (day.state === 'upcoming') return h('span', { class: 'week-row__status' }, icon(Lock, { size: 14 }), unlockLabel(day.seed));
  const best = bestOn(day.seed);
  return best ? h('span', { class: 'week-row__status week-row__status--raced' }, icon(Trophy, { size: 14 }), best) : h('span', { class: 'week-row__status' }, 'Not raced');
}

/** The text of a row once its day is planned: the event, its chips. */
function details(s: DaySummary): HTMLElement[] {
  const kind = SIGNATURE[s.flavour];
  const flavour = chip(EVENT_FLAVOURS[s.flavour].name, undefined, '--ink');
  flavour.style.setProperty('--ink', (kind && KINDS[kind]?.ink) || 'var(--soft)');
  const special = s.special && chip(s.special.name, Sparkles, '--ink week-row__special');
  return [h('span', { class: 'week-row__name' }, s.name), h('span', { class: 'week-row__tagline' }, s.special?.tagline ?? s.tagline), h('span', { class: 'week-row__chips' }, flavour, special || null)];
}

/** Paint the planned map into a row's canvas (the bitmap stays the planner's for the session). */
function paint(canvas: HTMLCanvasElement, s: DaySummary): void {
  canvas.width = Math.round(THUMB_W * s.dpr);
  canvas.height = Math.round(THUMB_H * s.dpr);
  canvas.getContext('2d')?.drawImage(s.thumb, 0, 0);
}

export function weekStep(o: WeekOptions): WeekStep {
  const hueOf = { today: 'orange', past: 'yellow', upcoming: 'purple' } as const;
  const rows = o.days.map((day) => {
    const canvas = h('canvas', { class: 'week-row__thumb', width: THUMB_W, height: THUMB_H, 'aria-hidden': 'true' }) as HTMLCanvasElement;
    const [weekday, date] = [day.weekday, day.label.replace(/^[^,]*,\s*/, '')];
    const text = h('span', { class: 'week-row__text' }, h('span', { class: 'week-row__skeleton week-row__skeleton--name' }), h('span', { class: 'week-row__skeleton' }), h('span', { class: 'week-row__skeleton week-row__skeleton--short' }));
    const row = h(
      'button',
      {
        class: `week-row week-row--${day.state} hue-${hueOf[day.state]} is-loading${day.seed === o.seed ? ' is-current' : ''}`,
        type: 'button',
        'aria-label': `${day.label}, ${day.state === 'today' ? 'tonight' : day.state === 'past' ? 'past' : 'upcoming'}`,
        ...(day.state === 'upcoming' ? { disabled: '' } : { onclick: () => (day.seed === o.seed ? o.back() : o.onPick(day.state === 'today' ? null : day.seed)) }),
        ...(day.seed === o.seed ? { 'aria-current': 'true' } : {}),
      },
      h('span', { class: 'week-row__map' }, canvas),
      h('span', { class: 'week-row__body' }, h('span', { class: 'week-row__head' }, h('span', { class: 'week-row__date' }, h('b', {}, weekday), ` ${date}`), status(day)), text),
      sheen(),
    );
    return { day, row, canvas, text };
  });
  const stop = o.planner.request(o.days, (s) => {
    const r = rows.find((x) => x.day.seed === s.seed);
    if (!r) return;
    paint(r.canvas, s);
    r.text.replaceChildren(...details(s));
    r.row.classList.remove('is-loading');
    r.row.title = s.name;
  });
  const list = h('div', { class: 'week-list', 'aria-label': 'Race days this week' }, ...rows.map((r) => r.row));
  const pickable = () => rows.map((r) => r.row).filter((el) => !el.disabled);
  return {
    parts: [screenHead({ icon: Calendar, title: 'This Week', back: o.back }), list],
    key(e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return false;
      const items = pickable();
      if (!items.length) return false;
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[next].focus();
      items[next].scrollIntoView({ block: 'nearest' });
      return true;
    },
    dispose: stop,
  };
}
