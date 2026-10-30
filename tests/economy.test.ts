/**
 * The parts economy (docs/economy.md): the points ledger and its merge, the stats merge, prices and unlock
 * tiers, grandfathering the garage into the purchases ledger, and enforceOwnership stripping what a car does
 * not own. All pure but for the local store, which a Map stands in for here (the tests run in node).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addRunPoints, balanceOf, loadPoints, mergePoints, pointsBalance, spendPoints, POINTS_KEY } from '../src/shared/points';
import { cleanStats, mergeStats, recordRace, STATS_KEY } from '../src/shared/stats';
import { ECONOMY, catalogPart, isUnlocked, priceOf, stockWheel } from '../src/shared/economy';
import { buy, enforceOwnership, hasLedger, loadPurchases, mergePurchases, owns, startLedger, PURCHASES_KEY } from '../src/shared/purchases';
import { defaultBuild } from '../src/shared/carBuild';
import catalog from '../src/assets/partsCatalog.json';
import type { PartEntry } from '../src/shared/parts';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

const wheels = (catalog as unknown as { parts: PartEntry[] }).parts.filter((p) => p.slot === 'wheels');
/** A wheel that is not the car's stock wheel (so it has a price on that car). */
const otherWheel = (carId: string) => wheels.find((w) => w.id !== stockWheel(carId))!;

beforeEach(() => store.clear());

describe('points ledger', () => {
  it('reads old saves without spent, spends only what the balance covers', () => {
    store.set(`nightrun.${POINTS_KEY}`, JSON.stringify({ total: 5000, best: 3000 }));
    expect(loadPoints()).toEqual({ total: 5000, spent: 0, best: 3000 });
    expect(spendPoints(6000)).toBe(false);
    expect(spendPoints(2000)).toBe(true);
    expect(pointsBalance()).toBe(3000);
    addRunPoints(1000);
    expect(loadPoints()).toEqual({ total: 6000, spent: 2000, best: 3000 });
  });

  it('merges the larger of each field, never a negative balance', () => {
    const a = { total: 9000, spent: 1000, best: 4000 };
    const b = { total: 7000, spent: 6000, best: 5000 };
    const m = mergePoints(a, b);
    expect(m).toEqual({ total: 9000, spent: 6000, best: 5000 });
    expect(mergePoints(b, a)).toEqual(m);
    expect(balanceOf({ total: 100, spent: 500, best: 0 })).toBe(0);
    expect(mergePoints({ total: 'x', spent: -5 }, null)).toEqual({ total: 0, spent: 0, best: 0 });
  });
});

describe('stats', () => {
  it('counts races, wins against rivals only, and merges counters by max and the best finish by min', () => {
    recordRace({ mode: 'drift', place: 1, entrants: 1, time: 60, distance: 2000, driftScore: 5000, points: 5000, crashPoints: 0 });
    const s = recordRace({ mode: 'circuit', place: 2, entrants: 4, time: 120, distance: 6000, driftScore: 0, points: 3000, crashPoints: 400 });
    expect(s.races).toBe(2);
    expect(s.wins).toBe(0);
    expect(s.podiums).toBe(1);
    expect(s.bestFinish).toBe(2);
    expect(s.byMode.drift).toBe(1);
    const other = cleanStats({ races: 5, wins: 1, bestFinish: 1, byMode: { sprint: 3 } });
    const m = mergeStats(s, other);
    expect(m.races).toBe(5);
    expect(m.bestFinish).toBe(1);
    expect(m.byMode).toMatchObject({ circuit: 1, drift: 1, sprint: 3 });
    expect(mergeStats(other, s)).toEqual(m);
    expect(mergeStats({ bestFinish: 0 }, { bestFinish: 3 }).bestFinish).toBe(3);
  });
});

describe('prices and unlocks', () => {
  it('prices every wheel in its band, rounded, with the stock wheel free on its car', () => {
    for (const w of wheels) {
      const p = priceOf(w);
      expect(p % ECONOMY.round).toBe(0);
      expect(p).toBeGreaterThanOrEqual(ECONOMY.slots.wheels.base);
      expect(p).toBeLessThanOrEqual(ECONOMY.slots.wheels.base * (1 + ECONOMY.slots.wheels.spread) * ECONOMY.multiPiece);
    }
    const stock = catalogPart(stockWheel('wendtStrom')!)!;
    expect(priceOf(stock, 'wendtStrom')).toBe(0);
    expect(owns('wendtStrom', stock.id)).toBe(true);
  });

  it('locks parts until the slot tier is reached', () => {
    const w = otherWheel('wendtStrom');
    expect(isUnlocked(w, cleanStats({ races: 0 }))).toBe(false);
    expect(isUnlocked(w, cleanStats({ races: ECONOMY.slots.wheels.unlock }))).toBe(true);
  });
});

describe('purchases', () => {
  it('grandfathers the garage once, per car, and merges by union', () => {
    const w = otherWheel('wendtStrom');
    const b = defaultBuild('wendtStrom');
    b.visual.parts.wheels = w.id;
    expect(hasLedger()).toBe(false);
    expect(startLedger([b])).toBe(true);
    expect(owns('wendtStrom', w.id)).toBe(true);
    // Bought per car: the same wheel on another model is not owned.
    expect(owns('kazamaRotor', w.id)).toBe(w.id === stockWheel('kazamaRotor'));
    // Once started, a second run grandfathers nothing new.
    const b2 = defaultBuild('kazamaRotor');
    b2.visual.parts.wheels = otherWheel('kazamaRotor').id;
    expect(startLedger([b2])).toBe(false);
    expect(loadPurchases()).toEqual({ wendtStrom: [w.id] });
    expect(mergePurchases({ a: ['x', 'y'] }, { a: ['y', 'z'], b: ['q'] })).toEqual({ a: ['x', 'y', 'z'], b: ['q'] });
  });

  it('strips unowned parts back to stock and reports them', () => {
    startLedger([]);
    const b = defaultBuild('wendtStrom');
    const w = otherWheel('wendtStrom');
    b.visual.parts.wheels = w.id;
    b.visual.wheels.rearPart = wheels.find((x) => x.id !== w.id && x.id !== stockWheel('wendtStrom'))!.id;
    b.visual.parts.spoiler = 'not_a_part';
    const gone = enforceOwnership(b);
    expect(gone.map((g) => g.slot).sort()).toEqual(['spoiler', 'wheels', 'wheels']);
    expect(b.visual.parts.wheels).toBeUndefined();
    expect(b.visual.parts.spoiler).toBeUndefined();
    expect(b.visual.wheels.rearPart).toBeNull();
    expect(enforceOwnership(b)).toEqual([]);
  });

  it('buys only unlocked, affordable parts, spending the price', () => {
    startLedger([]);
    const w = otherWheel('wendtStrom');
    const price = priceOf(w, 'wendtStrom');
    expect(buy('wendtStrom', w, cleanStats({ races: 0 }))).toBe('locked');
    const unlocked = cleanStats({ races: 1 });
    expect(buy('wendtStrom', w, unlocked)).toBe('short');
    addRunPoints(price + 100);
    expect(buy('wendtStrom', w, unlocked)).toBe('bought');
    expect(pointsBalance()).toBe(100);
    expect(owns('wendtStrom', w.id)).toBe(true);
    expect(buy('wendtStrom', w, unlocked)).toBe('owned');
    expect(store.has(`nightrun.${PURCHASES_KEY}`)).toBe(true);
    expect(store.has(`nightrun.${STATS_KEY}`)).toBe(false);
  });
});
