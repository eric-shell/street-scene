/**
 * The race ticket (_race-ticket.scss): what is about to start (the menu's setup
 * step) or what is paused (the pause screen) on one plate: the course drawn
 * small in its type's color (a compass for the open city), the type's name
 * over a few facts, and the best on this event. The race step's course card
 * (menu.ts) shows the same facts and best, built here too (`.course-facts`,
 * `.course-best` in _course-card.scss).
 */
import type { Route } from '../../city/route';
import { bem, h } from '../kit/dom';
import { Compass, Trophy, icon } from '../kit/icons';
import type { RaceType } from '../settings';
import { courseArt, type ArtCar } from './menuMaps';

/** A course's facts in a row: laps, length, turns, place. */
export function courseFacts(facts: readonly string[]): HTMLElement {
  return h('span', { class: 'course-facts' }, ...facts.map((f) => h('span', {}, f)));
}

/** The best on this event, a time or a score (null: none yet). `cls`: modifiers and states (`is-swapping`). */
export function courseBest(record: string | null, cls = ''): HTMLElement {
  if (record === null) return h('span', { class: bem('course-best', `--none ${cls}`) }, 'No time yet');
  return h('span', { class: bem('course-best', cls), title: 'Your best on this event' }, icon(Trophy, { size: 14 }), record);
}

export interface RaceTicketOptions {
  /** The race type: the course art's color. */
  mode: RaceType;
  /** The name on it (the race type's). */
  title: string;
  /** Its accessible name: what the ticket is ('Race', 'What is paused'). */
  label: string;
  facts: readonly string[];
  /** The course (null: the open city, a compass instead) and the cars on it. */
  route: Route | null;
  cars?: readonly ArtCar[];
  /** A line over the title (the event's name). */
  kicker?: string;
  /** The best on this event; omitted shows none. */
  best?: string | null;
  /** More classes on the ticket (`mode-*` where nothing around it wears the type). */
  cls?: string;
}

export function raceTicket(o: RaceTicketOptions): HTMLElement {
  return h(
    'section',
    { class: bem('race-ticket', o.cls), 'aria-label': o.label },
    h('span', { class: 'race-ticket__art' }, o.route ? courseArt(o.route, o.mode, 104, 52, o.cars) : icon(Compass, { size: 30 })),
    h('span', { class: 'race-ticket__text' }, o.kicker && h('span', { class: 'race-ticket__kicker' }, o.kicker), h('span', { class: 'course-name' }, o.title), courseFacts(o.facts)),
    o.best && courseBest(o.best),
  );
}
