/**
 * Weekend specials: every Saturday and Sunday seed carries one large drivable
 * set-piece district (the rail yard, the underground trench, the scrapyard)
 * on top of the city its seed already makes. The weekend is the busiest time
 * for the daily race, so the day's city gets one more reason to be looked at.
 *
 * Which weekend it is comes from the seed's own digits, never from the clock.
 * The daily seed is the UTC date as YYYYMMDD (src/seed.ts) and seedFromString
 * returns a 1-9 digit string as the number itself, so the sim reads the date
 * back out of the seed with a pure days-from-civil formula (no `Date`). That
 * keeps the city a function of the seed alone: a Saturday link opened on a
 * Tuesday rebuilds the Saturday city, and a replay, which carries only the
 * seed, rebuilds the same world it was recorded in on any day.
 *
 * The cost of that purity: a menu seed typed or rolled as a random 8-digit
 * number reads as a weekend date when it happens to be a valid Saturday or
 * Sunday between 2025 and 2099 (about 0.03% of them), and then it gets a
 * special too. That is accepted; it is a valid seed with a city to match.
 *
 * The kind rotates through WEEKEND_FEATURES one weekend day at a time from
 * Saturday 2026-01-03 (ordinal 0): a Saturday and its Sunday are consecutive
 * ordinals, so they get different specials, and three weekend days (a day and
 * a half) is the whole cycle. Seeds that are not weekend dates have none, and
 * their cities are unchanged bit for bit (nothing here feeds a random stream).
 */

export type WeekendKind = 'railYard' | 'underground' | 'scrapyard';

/** The specials in rotation order, with the name the menu card shows and its night-race tagline. */
export const WEEKEND_FEATURES: readonly { kind: WeekendKind; name: string; tagline: string }[] = [
  { kind: 'railYard', name: 'The Rail Yard', tagline: 'Threading the freight cars with the signal lamps burning red' },
  { kind: 'underground', name: 'The Underground', tagline: 'Down the trench where the street runs out of sky' },
  { kind: 'scrapyard', name: 'The Scrapyard', tagline: 'Wrecks stacked three high and a clear line if you dare it' },
];

/** A seed read as a weekend date. */
export interface WeekendPick {
  kind: WeekendKind;
  day: 'sat' | 'sun';
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  dayOfMonth: number;
  /** Weekend days since Saturday 2026-01-03 (that Saturday is 0, its Sunday 1, the next Saturday 2, ...); negative before it. */
  ordinal: number;
}

const FIRST_YEAR = 2025;
const LAST_YEAR = 2099;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil). */
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The civil date of a day count since 1970-01-01 (the inverse, civil_from_days). */
function civilFromDays(z0: number): { year: number; month: number; dayOfMonth: number } {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const dayOfMonth = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, dayOfMonth };
}

/** Day count of Saturday 2026-01-03, the rotation's ordinal 0. */
const ORDINAL_ZERO = daysFromCivil(2026, 1, 3);

/** The pick of a day count when it is a Saturday or Sunday, else null. 1970-01-01 was a Thursday. */
function pickOfDays(days: number): WeekendPick | null {
  const weekday = (((days + 4) % 7) + 7) % 7; // 0 Sunday ... 6 Saturday
  if (weekday !== 6 && weekday !== 0) return null;
  const delta = days - ORDINAL_ZERO;
  const ordinal = Math.floor(delta / 7) * 2 + (weekday === 0 ? 1 : 0);
  const n = WEEKEND_FEATURES.length;
  const { year, month, dayOfMonth } = civilFromDays(days);
  return { kind: WEEKEND_FEATURES[((ordinal % n) + n) % n].kind, day: weekday === 6 ? 'sat' : 'sun', year, month, dayOfMonth, ordinal };
}

/**
 * The weekend special a seed carries: null unless the seed is exactly eight digits reading as a valid
 * calendar date (YYYYMMDD, years 2025-2099) that falls on a Saturday or a Sunday.
 */
export function weekendOf(seed: number): WeekendPick | null {
  if (!Number.isInteger(seed) || seed < 10000000 || seed > 99999999) return null;
  const year = Math.floor(seed / 10000);
  const month = Math.floor(seed / 100) % 100;
  const dayOfMonth = seed % 100;
  if (year < FIRST_YEAR || year > LAST_YEAR || month < 1 || month > 12 || dayOfMonth < 1 || dayOfMonth > daysInMonth(year, month)) return null;
  return pickOfDays(daysFromCivil(year, month, dayOfMonth));
}

/** The next `count` weekend date seeds (YYYYMMDD as numbers) on or after a date, in order. Tests and docs use it. */
export function weekendSeeds(from: { year: number; month: number; dayOfMonth: number }, count: number): number[] {
  const out: number[] = [];
  for (let days = daysFromCivil(from.year, from.month, from.dayOfMonth); out.length < count; days++) {
    const p = pickOfDays(days);
    if (p) out.push(p.year * 10000 + p.month * 100 + p.dayOfMonth);
  }
  return out;
}
