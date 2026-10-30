/**
 * Event of the day seed (browser side; the sim never reads the clock).
 *
 * The seed is the race day's date as YYYYMMDD, and the race day is the calendar date in the Pacific
 * zone (America/Los_Angeles, DST handled by Intl). A new event lands at midnight Pacific, 3 am Eastern,
 * so both US coasts get a whole evening on one city (README, decisions log). The seed text stays
 * YYYYMMDD whatever the zone: city/weekend.ts reads the weekday back out of its digits, and saved
 * bests and ghosts are keyed by it.
 *
 * Date seeds (exactly eight digits that read as a real date) after today's race day are locked: the
 * menu and deep links fall back to today until the day comes. Past dates stay open for good, and every
 * other seed (a shuffled number, a typed word) is never locked. A ?seed= URL parameter overrides today.
 * Everything here is DOM free apart from initialSeed.
 */

/** The zone the race day is counted in. */
export const RACE_ZONE = 'America/Los_Angeles';

/** One race day of the week: its seed, its labels and where it stands against today. */
export interface RaceDay {
  seed: string;
  /** "Mon". */
  weekday: string;
  /** "Fri, Oct 30". */
  label: string;
  state: 'past' | 'today' | 'upcoming';
}

let zoneFormat: Intl.DateTimeFormat | null = null;

/** The Pacific calendar date of an instant. */
function raceDate(now: Date): { y: number; m: number; d: number } {
  zoneFormat ??= new Intl.DateTimeFormat('en-US', { timeZone: RACE_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const part = (type: string) => Number(zoneFormat!.formatToParts(now).find((p) => p.type === type)?.value);
  return { y: part('year'), m: part('month'), d: part('day') };
}

/** A calendar date as YYYYMMDD. */
function seedOf(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  return `${y}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** Today's race day as a UTC-midnight Date (its UTC fields are the Pacific calendar date). */
function raceDay(now: Date): Date {
  const { y, m, d } = raceDate(now);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Today's race day: the Pacific date as YYYYMMDD. */
export function dailySeed(now: Date = new Date()): string {
  return seedOf(raceDay(now));
}

/** The calendar day a seed names (a UTC-midnight Date), or null unless it is exactly eight digits reading as a real date. */
export function seedDate(seed: string): Date | null {
  const s = seed.trim();
  if (!/^\d{8}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

/** Whether a seed is a date strictly after today's race day (anything else is open). */
export function seedLocked(seed: string, now: Date = new Date()): boolean {
  return seedDate(seed) !== null && seed.trim() > dailySeed(now);
}

/** A seed's date as "Fri, Oct 30" (null for a seed that is not a date). */
export function dayLabel(seed: string, locale?: string): string | null {
  const date = seedDate(seed);
  return date && date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The race days of the current week, Monday to Sunday, as seeds with labels and where each stands against today. */
export function weekOf(now: Date = new Date(), locale?: string): RaceDay[] {
  const today = raceDay(now);
  const todaySeed = seedOf(today);
  const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000;
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(monday + i * 86400000);
    const seed = seedOf(date);
    return {
      seed,
      weekday: date.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }),
      label: date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
      state: seed === todaySeed ? 'today' : seed < todaySeed ? 'past' : 'upcoming',
    };
  });
}

/** When a locked seed opens, for a lock's caption: "Tomorrow" for the next race day, else "Unlocks Mon" (the weekday, within a week) or the full date past that. */
export function unlockLabel(seed: string, now: Date = new Date(), locale?: string): string {
  const date = seedDate(seed);
  if (!date) return '';
  const days = Math.round((date.getTime() - raceDay(now).getTime()) / 86400000);
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `Unlocks ${date.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })}`;
  return `Unlocks ${dayLabel(seed, locale)}`;
}

export function initialSeed(): string {
  const param = new URLSearchParams(window.location.search).get('seed');
  return param && param.trim() ? param.trim().slice(0, 32) : dailySeed();
}
