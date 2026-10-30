/**
 * Plans the This Week step's days (week.ts) without stalling the menu. Each day's event name, tagline and
 * map come only from planning its roads, about 300 ms a seed, so the work runs in a module worker
 * (weekWorker.ts) and every answer is kept for the session: the step opens full, and a day is never
 * planned twice. Order of work is what the player cares about first: today, then the past days from
 * yesterday back, then the days to come from tomorrow. `prefetch` starts the whole week a moment after the
 * menu is up; `request` is the step asking, which also starts it if nothing has. Where workers or
 * OffscreenCanvas are missing (or the worker dies) the same work runs on the main thread one day per idle
 * callback, and only once the step asks, since a prefetch would hitch the menu for nothing anyone looked at.
 */
import type { RaceDay } from '../../seed';
import { THUMB_H, THUMB_W, planDay, type DaySummary } from './weekThumb';
import type { WeekReply, WeekRequest } from './weekWorker';

/** How long after the menu is up the prefetch starts (ms), so the opening cascade has the frames. */
const PREFETCH_DELAY_MS = 2000;

/** The order a week is planned in: today, then the past days nearest first, then the upcoming days nearest first. */
export function planOrder(week: readonly RaceDay[]): string[] {
  const today = week.filter((d) => d.state === 'today');
  const past = week.filter((d) => d.state === 'past').reverse();
  const upcoming = week.filter((d) => d.state === 'upcoming');
  return [...today, ...past, ...upcoming].map((d) => d.seed);
}

export class WeekPlanner {
  private readonly done = new Map<string, DaySummary>();
  private readonly waiting = new Map<string, Set<(s: DaySummary) => void>>();
  /** Seeds asked of the worker or queued for the main thread. */
  private readonly pending = new Set<string>();
  private worker: Worker | null | undefined;
  private idle: number | null = null;
  private readonly local: string[] = [];
  private prefetchTimer = 0;

  /** The day if it has been planned already. */
  get(seed: string): DaySummary | undefined {
    return this.done.get(seed);
  }

  /** Start planning the week in order once the menu has settled (no-op where it would run on the main thread). */
  prefetch(week: readonly RaceDay[]): void {
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = window.setTimeout(() => {
      if (this.spawn()) this.enqueue(planOrder(week));
    }, PREFETCH_DELAY_MS);
  }

  /** Ask for a week's days: `onDay` gets each one as it is ready (at once for the ones already planned). Returns the way to stop listening. */
  request(week: readonly RaceDay[], onDay: (s: DaySummary) => void): () => void {
    const order = planOrder(week);
    const mine: [string, (s: DaySummary) => void][] = [];
    for (const seed of order) {
      const have = this.done.get(seed);
      if (have) {
        onDay(have);
        continue;
      }
      let set = this.waiting.get(seed);
      if (!set) this.waiting.set(seed, (set = new Set()));
      set.add(onDay);
      mine.push([seed, onDay]);
    }
    this.enqueue(order);
    return () => mine.forEach(([seed, cb]) => this.waiting.get(seed)?.delete(cb));
  }

  dispose(): void {
    clearTimeout(this.prefetchTimer);
    if (this.idle !== null) cancelIdle(this.idle);
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
    this.pending.clear();
    this.local.length = 0;
    for (const s of this.done.values()) if ('close' in s.thumb) s.thumb.close();
    this.done.clear();
  }

  private enqueue(seeds: readonly string[]): void {
    const fresh = seeds.filter((s) => !this.done.has(s) && !this.pending.has(s));
    if (!fresh.length) return;
    fresh.forEach((s) => this.pending.add(s));
    if (this.spawn()) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (const seed of fresh) this.worker!.postMessage({ seed, dpr } satisfies WeekRequest);
    } else {
      this.local.push(...fresh);
      this.scheduleLocal();
    }
  }

  /** The worker, started on first use; false where there is none (the main thread plans instead). */
  private spawn(): boolean {
    if (this.worker !== undefined) return this.worker !== null;
    this.worker = null;
    if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return false;
    try {
      const worker = new Worker(new URL('./weekWorker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (e: MessageEvent<WeekReply>) => {
        if (e.data.ok) this.finish(e.data.summary);
        else this.fallBack(e.data.seed);
      });
      // A worker that cannot load hands its outstanding days to the main thread.
      worker.addEventListener('error', () => {
        worker.terminate();
        this.worker = null;
        const lost = [...this.pending].filter((s) => !this.local.includes(s));
        this.local.push(...lost);
        if (this.waiting.size) this.scheduleLocal();
      });
      this.worker = worker;
      return true;
    } catch {
      return false;
    }
  }

  private fallBack(seed: string): void {
    if (!this.local.includes(seed)) this.local.push(seed);
    this.scheduleLocal();
  }

  private finish(summary: DaySummary): void {
    this.pending.delete(summary.seed);
    this.done.set(summary.seed, summary);
    const set = this.waiting.get(summary.seed);
    this.waiting.delete(summary.seed);
    set?.forEach((cb) => cb(summary));
  }

  /** The main-thread route: one day per idle callback, and only for days someone is waiting on. */
  private scheduleLocal(): void {
    if (this.idle !== null) return;
    this.idle = onIdle(() => {
      this.idle = null;
      const seed = this.local.find((s) => this.waiting.has(s)) ?? this.local[0];
      if (seed === undefined) return;
      this.local.splice(this.local.indexOf(seed), 1);
      if (!this.waiting.has(seed)) {
        // Nobody is looking any more: forget it rather than spend 300 ms.
        this.pending.delete(seed);
      } else {
        const day = planDay(seed);
        const canvas = document.createElement('canvas');
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = Math.round(THUMB_W * dpr);
        canvas.height = Math.round(THUMB_H * dpr);
        day.draw(canvas.getContext('2d')!, dpr);
        this.finish({ ...day.summary, thumb: canvas, dpr });
      }
      if (this.local.length) this.scheduleLocal();
    });
  }
}

const onIdle = (fn: () => void): number => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 400 }) : window.setTimeout(fn, 60));
const cancelIdle = (id: number): void => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(id) : clearTimeout(id));
