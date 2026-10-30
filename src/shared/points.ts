/**
 * The player's points, kept across races: the game's currency for garage parts (shared/economy.ts prices them,
 * shared/purchases.ts spends them). A ledger rather than a balance: `total` is every run's points ever earned,
 * `spent` every purchase ever made, and the balance is their difference (never below 0). Both only grow, which is
 * what lets two devices merge without a server: the larger of each field wins (an offline device never loses a
 * run or a purchase, and nothing is counted twice), where a merged balance would have to guess. Every race's
 * points go through `addRunPoints` and every purchase through `spendPoints`, nowhere else. One small store key,
 * `points.v1`, which an account syncs (account/cloudSave.ts) like the garage.
 */
import { loadJson, saveJson } from './store';

/** The store key (without the `nightrun.` prefix). */
export const POINTS_KEY = 'points.v1';

/** The saved document. */
export interface PointsSave {
  /** Every run's points added up, lifetime earned (points). */
  total: number;
  /** Every purchase added up (points); saves from before the economy have none (0). */
  spent: number;
  /** The best single run (points). */
  best: number;
}

const clean = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** A save from storage or another device, cleaned (a missing `spent` from before the economy reads 0). */
const cleanSave = (v: unknown): PointsSave => {
  const o = (v ?? {}) as Partial<PointsSave>;
  return { total: clean(o.total), spent: clean(o.spent), best: clean(o.best) };
};

/** The saved points, 0s when nothing is stored or it is unreadable. */
export function loadPoints(): PointsSave {
  return cleanSave(loadJson<unknown>(POINTS_KEY, null));
}

/** What a ledger leaves to spend: earned less spent, never below 0 (a merge can briefly leave spent ahead). */
export const balanceOf = (p: PointsSave): number => Math.max(0, p.total - p.spent);

/** The lifetime total earned, whatever has been spent. */
export const totalPoints = (): number => loadPoints().total;

/** The points left to spend on parts. */
export const pointsBalance = (): number => balanceOf(loadPoints());

/** Adds a finished run's points to the total (and the best when it tops it). Returns the ledger after. */
export function addRunPoints(points: number): PointsSave {
  const run = clean(points);
  const p = loadPoints();
  if (run <= 0) return p;
  const next = { ...p, total: p.total + run, best: Math.max(p.best, run) };
  saveJson(POINTS_KEY, next);
  return next;
}

/** Spends `n` points: false (and nothing changed) when the balance is short or the write did not stick. */
export function spendPoints(n: number): boolean {
  const cost = clean(n);
  const p = loadPoints();
  if (balanceOf(p) < cost) return false;
  if (cost === 0) return true;
  return saveJson(POINTS_KEY, { ...p, spent: p.spent + cost });
}

/** Two saves merged: the larger of each field, since earned and spent only grow. */
export function mergePoints(a: unknown, b: unknown): PointsSave {
  const x = cleanSave(a);
  const y = cleanSave(b);
  return { total: Math.max(x.total, y.total), spent: Math.max(x.spent, y.spent), best: Math.max(x.best, y.best) };
}
