/**
 * Crash reporting through the analytics beacon: uncaught errors and unhandled rejections become `error` events
 * (shared/analytics.ts ErrorMeta), so a launch-day crash on a device nobody here owns shows up on the dashboard.
 * Noise is dropped before it costs a row: cross-origin "Script error." (no detail to act on), browser extensions'
 * own errors, and the harmless ResizeObserver loop warning. Each message is sent once and a page sends a few at
 * most, so an error thrown every frame is one row, not thousands. Off whenever analytics is off (track is a no-op).
 */
import type { ErrorMeta } from '../shared/analytics';
import { track } from './telemetry';

/** Reports per page: past this a broken page has said enough. */
const MAX_REPORTS = 5;
/** Messages that say nothing about the game. */
const NOISE = [/^Script error\.?$/, /ResizeObserver loop/];
/** Errors thrown from a browser extension's code, not the game's. */
const EXTENSION = /(chrome|moz|safari(-web)?)-extension:\/\//;

const seen = new Set<string>();
let screen: () => string | undefined = () => undefined;

function stackOf(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.stack) return undefined;
  return err.stack.split('\n').slice(0, 6).join('\n').replaceAll(location.origin, '').slice(0, 600);
}

/** Send one error event, unless it is noise, already sent, or the page is over its quota. */
export function reportError(kind: ErrorMeta['kind'], err: unknown): void {
  try {
    const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 300);
    const stack = stackOf(err);
    if (seen.size >= MAX_REPORTS || seen.has(message) || NOISE.some((r) => r.test(message)) || (stack && EXTENSION.test(stack))) return;
    seen.add(message);
    track('error', { kind, message, ...(stack ? { stack } : {}), ...(screen() ? { screen: screen() } : {}) });
  } catch {
    /* reporting never throws */
  }
}

/** Listen for uncaught errors and rejections; `currentScreen` names what was on screen when one happened. */
export function installErrorReporting(currentScreen: () => string): void {
  screen = currentScreen;
  window.addEventListener('error', (e) => {
    // Script errors only: a failed image or audio load is an Event, not an ErrorEvent, and its owner handles it.
    if (!(e instanceof ErrorEvent)) return;
    if (e.filename && EXTENSION.test(e.filename)) return;
    reportError('error', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => reportError('rejection', e.reason));
}
