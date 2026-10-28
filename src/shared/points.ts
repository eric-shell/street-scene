/**
 * The player's points, kept across races: a lifetime total and the best single run. This is the source for
 * future unlocks (cars and parts gated on `totalPoints()`), so every race's points go through `addRunPoints`
 * and nowhere else. One small store key, `points.v1`, which an account syncs (account/cloudSave.ts) like the
 * garage; the sync keeps the larger of each field so a device that was offline never loses or double counts.
 */
import { loadJson, saveJson } from './store';

/** The store key (without the `nightrun.` prefix). */
export const POINTS_KEY = 'points.v1';

/** The saved document. */
export interface PointsSave {
  /** Every run's points added up (points). */
  total: number;
  /** The best single run (points). */
  best: number;
}

const clean = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** The saved points, 0s when nothing is stored or it is unreadable. */
export function loadPoints(): PointsSave {
  const v = loadJson<Partial<PointsSave> | null>(POINTS_KEY, null);
  return { total: clean(v?.total), best: clean(v?.best) };
}

/** The lifetime total, the number future unlocks read. */
export const totalPoints = (): number => loadPoints().total;

/** Adds a finished run's points to the total (and the best when it tops it). Returns the totals after. */
export function addRunPoints(points: number): PointsSave {
  const run = clean(points);
  const p = loadPoints();
  if (run <= 0) return p;
  const next = { total: p.total + run, best: Math.max(p.best, run) };
  saveJson(POINTS_KEY, next);
  return next;
}

/** Two saves merged: the larger of each field, since a total only grows. */
export function mergePoints(a: unknown, b: unknown): PointsSave {
  const x = (a ?? {}) as Partial<PointsSave>;
  const y = (b ?? {}) as Partial<PointsSave>;
  return { total: Math.max(clean(x.total), clean(y.total)), best: Math.max(clean(x.best), clean(y.best)) };
}
