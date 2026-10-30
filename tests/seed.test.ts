/** The race day (src/seed.ts): the Pacific calendar date, the lock on future date seeds, the Monday to Sunday week. */
import { describe, expect, it } from 'vitest';
import { dailySeed, dayLabel, seedDate, seedLocked, unlockLabel, weekOf } from '../src/seed';

const at = (iso: string) => new Date(iso);

describe('dailySeed', () => {
  it('turns over at midnight Pacific in daylight time (UTC-7)', () => {
    expect(dailySeed(at('2026-10-30T06:59:59Z'))).toBe('20261029');
    expect(dailySeed(at('2026-10-30T07:00:00Z'))).toBe('20261030');
  });
  it('turns over at midnight Pacific in standard time (UTC-8)', () => {
    expect(dailySeed(at('2026-11-30T07:59:59Z'))).toBe('20261129');
    expect(dailySeed(at('2026-11-30T08:00:00Z'))).toBe('20261130');
  });
  it('follows the clocks across the DST changes', () => {
    // Fall back on 2026-11-01 at 2 am: the 1st begins at 07:00Z (still PDT), the 2nd at 08:00Z (PST).
    expect(dailySeed(at('2026-11-01T06:59:59Z'))).toBe('20261031');
    expect(dailySeed(at('2026-11-01T07:00:00Z'))).toBe('20261101');
    expect(dailySeed(at('2026-11-02T07:59:59Z'))).toBe('20261101');
    expect(dailySeed(at('2026-11-02T08:00:00Z'))).toBe('20261102');
    // Spring forward on 2026-03-08.
    expect(dailySeed(at('2026-03-09T06:59:59Z'))).toBe('20260308');
    expect(dailySeed(at('2026-03-09T07:00:00Z'))).toBe('20260309');
  });
  it('is the Pacific evening date while UTC has already moved on', () => {
    expect(dailySeed(at('2026-10-30T03:00:00Z'))).toBe('20261029');
  });
  it('rolls month and year', () => {
    expect(dailySeed(at('2027-01-01T07:59:59Z'))).toBe('20261231');
    expect(dailySeed(at('2027-01-01T08:00:00Z'))).toBe('20270101');
  });
});

describe('seedDate', () => {
  it('reads real dates and nothing else', () => {
    expect(seedDate('20261030')?.toISOString()).toBe('2026-10-30T00:00:00.000Z');
    expect(seedDate('20240229')).not.toBeNull();
    expect(seedDate('20250229')).toBeNull();
    expect(seedDate('20261399')).toBeNull();
    expect(seedDate('20260431')).toBeNull();
    expect(seedDate('2026103')).toBeNull();
    expect(seedDate('202610300')).toBeNull();
    expect(seedDate('hello')).toBeNull();
    expect(seedDate('')).toBeNull();
  });
});

describe('seedLocked', () => {
  const now = at('2026-10-30T20:00:00Z');
  it('opens today and the past, locks the future', () => {
    expect(seedLocked('20261030', now)).toBe(false);
    expect(seedLocked('20261029', now)).toBe(false);
    expect(seedLocked('20261031', now)).toBe(true);
    expect(seedLocked('20270101', now)).toBe(true);
    expect(seedLocked('20200101', now)).toBe(false);
  });
  it('unlocks at midnight Pacific', () => {
    expect(seedLocked('20261031', at('2026-10-31T06:59:59Z'))).toBe(true);
    expect(seedLocked('20261031', at('2026-10-31T07:00:00Z'))).toBe(false);
  });
  it('never locks a seed that is not a date', () => {
    for (const s of ['99999999', '20261399', '12345678', '4821', '0', 'zzz', 'pacific-night', '99999999999', '2026103', '']) expect(seedLocked(s, now)).toBe(false);
  });
});

describe('weekOf', () => {
  it('runs Monday to Sunday around the race day', () => {
    const week = weekOf(at('2026-10-30T20:00:00Z'), 'en-US');
    expect(week.map((d) => d.seed)).toEqual(['20261026', '20261027', '20261028', '20261029', '20261030', '20261031', '20261101']);
    expect(week.map((d) => d.weekday)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(week.map((d) => d.state)).toEqual(['past', 'past', 'past', 'past', 'today', 'upcoming', 'upcoming']);
    expect(week[4].label).toBe('Fri, Oct 30');
  });
  it('starts on the Monday itself and ends on the Sunday itself', () => {
    expect(weekOf(at('2026-10-26T20:00:00Z')).map((d) => d.state)).toEqual(['today', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(weekOf(at('2026-11-01T20:00:00Z')).map((d) => d.state)).toEqual(['past', 'past', 'past', 'past', 'past', 'past', 'today']);
  });
  it('counts a Sunday evening Pacific as Sunday although UTC says Monday', () => {
    expect(weekOf(at('2026-11-02T03:00:00Z'))[0].seed).toBe('20261026');
  });
  it('crosses a year', () => {
    expect(weekOf(at('2026-12-31T20:00:00Z')).map((d) => d.seed)).toEqual(['20261228', '20261229', '20261230', '20261231', '20270101', '20270102', '20270103']);
  });
});

describe('labels', () => {
  const now = at('2026-10-30T20:00:00Z');
  it('names the date and what a locked day waits for', () => {
    expect(dayLabel('20261102', 'en-US')).toBe('Mon, Nov 2');
    expect(dayLabel('banana')).toBeNull();
    expect(unlockLabel('20261031', now, 'en-US')).toBe('Tomorrow');
    expect(unlockLabel('20261101', now, 'en-US')).toBe('Unlocks Sun');
    expect(unlockLabel('20261201', now, 'en-US')).toBe('Unlocks Tue, Dec 1');
  });
});
