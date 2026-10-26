/**
 * The game's analytics client (docs/analytics.md), ported from the portfolio CRM's telemetry: a visitor id, a
 * session that rolls over after 30 idle minutes, one page view per document load, heartbeats that carry the
 * visit's cumulative engaged and race time, and typed game events (`track`). It runs in the player's browser and
 * must never be noticed: every path is wrapped, nothing throws, nothing is shown, and a server that is down or
 * absent just means the beacons are dropped.
 *
 * Cost rules kept from the original: the page view is a real `fetch` (only a fetch carries the edge geo headers
 * and the session cookie); heartbeats are `sendBeacon`s on a backing-off schedule (15 s, 30 s, 60 s, 120 s, then
 * every 5 minutes), skipped while the tab is hidden and when nothing changed; hiding the tab and `pagehide` flush
 * once more. Engaged time counts only while the tab is visible; race time only while a race or free roam is being
 * driven (`addRaceMs`, fed by the frame loop). Both ride the session record so a reload keeps adding to the
 * same visit, and the server keeps the greater of old and new, so every value on the wire is cumulative.
 *
 * Both also stop `IDLE_MS` after the player's last input (keys, pointer, wheel, touch, or a gamepad held or
 * moved). That is what keeps the free database asleep: Neon scales to zero after 5 idle minutes and the free
 * plan's compute is a monthly allowance shared with accounts, so a game left open on the menu's showreel must
 * stop beating. With nothing new to report a beat is skipped, so an idle tab sends nothing until someone plays.
 *
 * Nothing is sent at all when `offReason()` says so: Global Privacy Control / Do Not Track, `npm run dev` (its
 * `.env.local` is the live database, so local play would land in the dashboard; `?analytics` turns it on there
 * to test this client), automated browsers (Playwright runs against that same dev server), the dashboard page,
 * and the owner's own opt-out (`?noanalytics` on any URL sets a flag on this device; `?noanalytics=0` clears it).
 */
import type { AnalyticsBeacon, DeviceBeacon, EventMetaMap, EventType } from '../shared/analytics';
import { SESSION_TIMEOUT_MS } from '../shared/analytics';
import { loadJson, loadText, saveJson, saveText } from '../shared/store';

declare const __BUILD_HASH__: string;

const ENDPOINT = '/api/analytics';
/** Store keys (under `nightrun.`). */
const VISITOR_KEY = 'analytics.vid';
const SESSION_KEY = 'analytics.sess';
const OFF_KEY = 'analytics.off';

/**
 * Gap since the last beat, in ms: dense early when a visitor is most likely to leave, then sparse. Periodic beats
 * only bound data loss where `pagehide` never fires (mobile Safari); an hour-long visit costs about 15 of them.
 */
const HEARTBEAT_SCHEDULE_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
/** The longest wall-clock gap credited as reading: more is a slept laptop or a frozen timer, not play. */
const MAX_SEGMENT_MS = Math.max(...HEARTBEAT_SCHEDULE_MS) + 30_000;
/** Time after the last input still counted as playing, in ms: a long straight with the throttle held is input. */
const IDLE_MS = 3 * 60_000;
/** How often a connected gamepad is checked for held buttons or moved sticks, in ms (gamepads fire no events). */
const PAD_SAMPLE_MS = 5_000;

interface StoredSession {
  id: string;
  /** Last activity, ms since the epoch. */
  last: number;
  /** Cumulative engaged ms already reported for this visit by any document in it. */
  engaged?: number;
  /** Cumulative race ms, the same. */
  race?: number;
}

/** Why analytics is off on this device, or null when it is on. Evaluated once per document. */
function offReason(): string | null {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
    const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? (window as { doNotTrack?: string }).doNotTrack;
    if (nav.globalPrivacyControl === true || dnt === '1' || dnt === 'yes') return 'privacy signal';
    if (import.meta.env.DEV && !new URLSearchParams(location.search).has('analytics')) return 'dev build';
    if (nav.webdriver) return 'automated browser';
    if (location.pathname.startsWith('/dashboard')) return 'dashboard';
    const q = new URLSearchParams(location.search).get('noanalytics');
    if (q !== null) {
      // `?noanalytics` turns analytics off on this device for good; `?noanalytics=0` turns it back on.
      if (q === '0' || q === 'off' || q === 'false') saveText(OFF_KEY, '0');
      else saveText(OFF_KEY, '1');
    }
    if (loadText(OFF_KEY) === '1') return 'owner opt-out';
  } catch {
    /* a browser that throws on these gets the benefit of the doubt: off */
    return 'unreadable';
  }
  return null;
}

/** Whether the browser sends Global Privacy Control or Do Not Track (the Privacy page shows the switch off and locked). */
export function privacySignal(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
    const dnt = nav.doNotTrack ?? nav.msDoNotTrack ?? (window as { doNotTrack?: string }).doNotTrack;
    return nav.globalPrivacyControl === true || dnt === '1' || dnt === 'yes';
  } catch {
    return false;
  }
}

/** Whether this device shares play data: no opt-out flag and no privacy signal. */
export function analyticsAllowed(): boolean {
  return !privacySignal() && loadText(OFF_KEY) !== '1';
}

/**
 * The Privacy page's switch: `off` sets the device's opt-out flag and stops sending for the rest of this page's
 * life (no heartbeats, no events, no pagehide flush); turning it back on clears the flag and takes effect at the next load.
 */
export function setAnalyticsOptOut(off: boolean): void {
  saveText(OFF_KEY, off ? '1' : '0');
  if (off) {
    stopped = true;
    active = false;
  }
}

let active = false;
/** Set when the player opts out mid-page: `send` drops everything from then on. */
let stopped = false;
let visitorId = '';
let sessionId = '';
let engagedBaseMs = 0;
let raceBaseMs = 0;
let engagedMs = 0;
let raceMs = 0;
let lastTick = 0;
let visible = true;
/** The player's last input, ms since the epoch. */
let lastInput = 0;

/** Whether analytics is running on this document (init succeeded and nothing opted out). */
export function analyticsActive(): boolean {
  return active;
}

function getVisitorId(): string {
  const saved = loadText(VISITOR_KEY);
  if (saved && saved.length >= 8 && saved.length <= 64) return saved;
  const fresh = crypto.randomUUID();
  saveText(VISITOR_KEY, fresh);
  return fresh;
}

/** Read the visit, minting a fresh one past the inactivity timeout. Local storage, so tabs share one visit. */
function startSession(): void {
  const now = Date.now();
  const s = loadJson<Partial<StoredSession> | null>(SESSION_KEY, null);
  if (s && typeof s.id === 'string' && typeof s.last === 'number' && now - s.last < SESSION_TIMEOUT_MS) {
    sessionId = s.id;
    engagedBaseMs = Math.max(0, Math.round(s.engaged ?? 0));
    raceBaseMs = Math.max(0, Math.round(s.race ?? 0));
  } else {
    sessionId = crypto.randomUUID();
    engagedBaseMs = 0;
    raceBaseMs = 0;
  }
  commit(engagedBaseMs, raceBaseMs);
}

/** Record this document's totals on the shared ledger; monotonic, and never onto a session another tab replaced. */
function commit(engaged: number, race: number): void {
  const s = loadJson<Partial<StoredSession> | null>(SESSION_KEY, null);
  if (s && s.id && s.id !== sessionId && typeof s.last === 'number' && Date.now() - s.last < SESSION_TIMEOUT_MS) return;
  const sameVisit = s?.id === sessionId;
  saveJson(SESSION_KEY, {
    id: sessionId,
    last: Date.now(),
    engaged: Math.max(sameVisit ? s?.engaged ?? 0 : 0, engaged),
    race: Math.max(sameVisit ? s?.race ?? 0 : 0, race),
  } satisfies StoredSession);
}

function send(body: AnalyticsBeacon, mode: 'fetch' | 'beacon'): void {
  if (stopped) return;
  try {
    const json = JSON.stringify(body);
    if (mode === 'beacon' && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon(ENDPOINT, new Blob([json], { type: 'application/json' }))) return;
    }
    // keepalive lets the request outlive a navigation; the page view needs the real fetch for geo and the cookie.
    void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }).catch(() => undefined);
  } catch {
    /* never surfaced */
  }
}

/** Bring the engaged clock up to now, crediting only up to `IDLE_MS` past the last input; a stepped-back clock and a slept machine are clamped. */
function accrue(): void {
  const now = Date.now();
  const until = Math.min(now, lastInput + IDLE_MS);
  if (visible) engagedMs += Math.min(Math.max(0, until - lastTick), MAX_SEGMENT_MS);
  lastTick = now;
}

/** Adds driven time (a race or free roam running, not paused) to the visit; called once per frame while driving. */
export function addRaceMs(dtMs: number): void {
  if (active && visible && Date.now() - lastInput < IDLE_MS) raceMs += dtMs;
}

function noteInput(): void {
  const now = Date.now();
  // Waking from idle: close the credited stretch at its idle edge, so the gap since is never counted.
  if (now - lastInput >= IDLE_MS) accrue();
  lastInput = now;
}

/** Any button held or stick off centre on a connected pad. */
function padActive(): boolean {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p?.connected) continue;
    if (p.buttons.some((b) => b.pressed || b.value > 0.1) || p.axes.some((a) => Math.abs(a) > 0.2)) return true;
  }
  return false;
}

let lastSentEngaged = 0;
let lastSentRace = 0;

function flush(mode: 'fetch' | 'beacon'): void {
  accrue();
  const engaged = Math.round(engagedBaseMs + engagedMs);
  const race = Math.round(raceBaseMs + raceMs);
  // A parked tab sends nothing.
  if (engaged === lastSentEngaged && race === lastSentRace) return;
  lastSentEngaged = engaged;
  lastSentRace = race;
  commit(engaged, race);
  send({ op: 'heartbeat', visitorId, sessionId, engagedMs: engaged, raceMs: race }, mode);
}

const pageHideHooks: (() => void)[] = [];
/** Runs `fn` on `pagehide`, before the final heartbeat (the drive sends its quit and perf summary here). */
export function onPageHide(fn: () => void): void {
  pageHideHooks.push(fn);
}

function campaign(): { source: string | null; medium: string | null; campaign: string | null } {
  const q = new URLSearchParams(location.search);
  const tag = (k: string) => q.get(k)?.trim().slice(0, 80) || null;
  return { source: tag('utm_source'), medium: tag('utm_medium'), campaign: tag('utm_campaign') };
}

/**
 * Start the client: the page view now, then heartbeats. Call once per document, early in boot; it does its work
 * asynchronously and returns at once. `device` is the renderer's probe (render/autoQuality.ts), not a second one.
 */
export function initAnalytics(device: DeviceBeacon | null): void {
  if (active) return;
  try {
    if (offReason() !== null) return;
    visitorId = getVisitorId();
    startSession();
    active = true;
    visible = document.visibilityState === 'visible';
    lastTick = Date.now();
    // Loading the page counts as input: a visitor who only looks is engaged for IDLE_MS, then idle.
    lastInput = lastTick;
    lastSentEngaged = engagedBaseMs;
    lastSentRace = raceBaseMs;

    send(
      {
        op: 'pageview',
        visitorId,
        sessionId,
        path: (location.pathname + location.search).slice(0, 300),
        referrer: document.referrer ? document.referrer.slice(0, 300) : null,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        screen: { w: window.screen?.width ?? 0, h: window.screen?.height ?? 0 },
        clientTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
        language: navigator.language ?? null,
        utm: campaign(),
        build: typeof __BUILD_HASH__ !== 'undefined' ? __BUILD_HASH__ : 'dev',
        device,
      },
      'fetch',
    );

    // Capture and passive, so no handler in the game can hide an input from this and this never delays one.
    for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart'] as const) {
      window.addEventListener(type, noteInput, { capture: true, passive: true });
    }
    // Pads fire no input events: sample one only while it is connected and the tab is visible.
    let padTimer: ReturnType<typeof setInterval> | undefined;
    const syncPadSampler = () => {
      const want = visible && (typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []).some((p) => p?.connected);
      if (want && padTimer === undefined) padTimer = setInterval(() => padActive() && noteInput(), PAD_SAMPLE_MS);
      else if (!want && padTimer !== undefined) {
        clearInterval(padTimer);
        padTimer = undefined;
      }
    };
    window.addEventListener('gamepadconnected', () => {
      noteInput();
      syncPadSampler();
    });
    window.addEventListener('gamepaddisconnected', syncPadSampler);
    syncPadSampler();

    document.addEventListener('visibilitychange', () => {
      accrue();
      visible = document.visibilityState === 'visible';
      syncPadSampler();
      // Hiding is the last reliable moment on mobile, where pagehide often never fires.
      if (!visible) flush('beacon');
    });

    // A setTimeout chain, not an interval, so the gap can grow; a hidden tab's beat would be a no-op anyway.
    let beat = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        beat++;
        if (visible) flush('fetch');
        schedule();
      }, HEARTBEAT_SCHEDULE_MS[Math.min(beat, HEARTBEAT_SCHEDULE_MS.length - 1)]);
    };
    schedule();

    window.addEventListener('pagehide', () => {
      clearTimeout(timer);
      for (const fn of pageHideHooks) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      flush('beacon');
    });
    // Back from the bfcache is a fresh stretch: restart the dense end of the schedule, and do not credit the frozen time.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      visible = document.visibilityState === 'visible';
      lastTick = Date.now();
      lastInput = lastTick;
      beat = 0;
      schedule();
    });
  } catch {
    active = false;
  }
}

/**
 * Record a game event. Fire and forget: a `fetch` with keepalive (so an event sent as the page navigates, like a
 * sign-in that reloads, survives), or a beacon from the pagehide hook. Does nothing when analytics is off.
 */
export function track<K extends EventType>(type: K, metadata: EventMetaMap[K], via: 'fetch' | 'beacon' = 'fetch'): void {
  if (!active) return;
  try {
    send({ op: 'event', visitorId, sessionId, type, metadata } as AnalyticsBeacon, via);
  } catch {
    /* never surfaced */
  }
}
