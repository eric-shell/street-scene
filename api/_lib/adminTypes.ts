/**
 * What `api/admin.ts` returns to the dashboard (src/admin/), one interface per op. Ported from the eric-shell
 * CRM's types.ts and insights-types.ts, with its chat and contact form replaced by the game's own funnel: races
 * started, finished and quit, garage saves, sign-ins, and frame rate per device. Timestamps are ISO strings;
 * every count is a number (cast sums to `::float8` in SQL, since the Neon driver returns int8 as a string).
 */
import type { EventMetaMap, EventType } from '../../src/shared/analytics.js';

/** Campaign tag our own synthetic traffic carries (`utm_campaign`); the dashboard's `Test` tag keys off it. */
export const SYNTHETIC_CAMPAIGN = 'synthetic-test';

/** `GET op=session`: the signed-in admin. 401 when signed out, 403 when the email is not in ADMIN_EMAILS. */
export interface AdminSessionPayload {
  email: string;
  name: string;
}

/** The player a visitor is linked to (players row), when they ever signed in on that browser. */
export interface LinkedPlayer {
  sub: string;
  email: string;
  name: string;
  created_at: string;
  /** Last sign-in or boot. */
  seen_at: string;
}

export interface Visitor {
  id: string;
  first_seen_at: string;
  last_seen_at: string;
  user_agent: string | null;
  /** IP-derived and approximate. Prefer `location_override` for display. */
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
  /** Hand-entered correction. Always wins over the IP-derived fields. */
  location_override: string | null;
  /** Browser-reported, so more reliable than the IP-derived fields above. */
  client_timezone: string | null;
  language: string | null;
  referrer: string | null;
  /** Unmasked GPU renderer string, when the browser exposed it. */
  gpu: string | null;
  dpr: number | null;
  cores: number | null;
  memory_gb: number | null;
  touch: boolean | null;
  notes: string | null;
}

export interface VisitorSession {
  id: string;
  started_at: string;
  last_beat_at: string;
  /** Tab visible, in ms. */
  engaged_ms: number;
  /** Driving (a race or free roam running), in ms. */
  race_ms: number;
  entry_path: string | null;
  referrer: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  screen_w: number | null;
  screen_h: number | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  /** The game's build hash for this visit. */
  build: string | null;
  page_view_count: number;
}

export interface PageView {
  id: number;
  session_id: string | null;
  path: string;
  referrer: string | null;
  created_at: string;
}

/** One stored event, its metadata typed by its type. */
export type VisitorEvent = {
  [K in EventType]: { id: number; session_id: string | null; type: K; metadata: EventMetaMap[K]; created_at: string };
}[EventType];

/** `GET op=visitor&id=`. Events newest first, at most 500; page views at most 500. */
export interface VisitorDetailPayload {
  visitor: Visitor;
  player: LinkedPlayer | null;
  sessions: VisitorSession[];
  pageViews: PageView[];
  events: VisitorEvent[];
}

/** `PATCH op=visitor&id=` body: only the keys present are written, so a partial PATCH never wipes a sibling. */
export interface VisitorPatch {
  notes?: string | null;
  location_override?: string | null;
}

/** One row of `GET op=visitors` (at most 500, most recent activity first). */
export interface VisitorSummary {
  id: string;
  first_seen_at: string;
  last_seen_at: string;
  user_agent: string | null;
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
  location_override: string | null;
  client_timezone: string | null;
  language: string | null;
  referrer: string | null;
  gpu: string | null;
  touch: boolean | null;
  /** The private note, on the row so the list can mark and search it. */
  notes: string | null;
  /** The linked player's email and name, null when this browser never signed in. */
  player_email: string | null;
  player_name: string | null;
  page_view_count: number;
  session_count: number;
  /** Distinct calendar days with any recorded activity (sessions, page views or events). */
  active_days: number;
  /** Summed engaged time across every session, in ms. */
  total_engaged_ms: number;
  /** Summed driving time across every session, in ms. */
  total_race_ms: number;
  race_start_count: number;
  race_finish_count: number;
  race_quit_count: number;
  build_save_count: number;
  /** Median of the visitor's `perf` events' medianFps, null with none. */
  median_fps: number | null;
  /** The latest `perf` event's tier, null with none. */
  last_tier: 'low' | 'medium' | 'high' | null;
  /** Any session tagged SYNTHETIC_CAMPAIGN: traffic our own tooling made. */
  synthetic: boolean;
  /** greatest() over last seen, last page view, last heartbeat and last event: the detail cache's stamp. */
  last_activity_at: string;
}

export interface VisitorListPayload {
  visitors: VisitorSummary[];
}

/** One day of the visitors chart. */
export interface StatDay {
  /** YYYY-MM-DD, UTC. */
  date: string;
  visitors: number;
}

/** Session counts by viewport width: ordered buckets, not device identities. */
export interface ViewportMix {
  /** Sessions that reported a viewport at all: the denominator. */
  known: number;
  /** < 640 px */
  phone: number;
  /** 640-1023 px */
  tablet: number;
  /** >= 1024 px */
  desktop: number;
}

export interface SourceRow {
  /** The session's utm_source when tagged, otherwise the referrer host (lowercased, www. stripped); '' is direct. */
  host: string;
  /** This bar came from a campaign tag rather than a referrer header. */
  tagged: boolean;
  sessions: number;
}

/**
 * The play funnel over the window, as distinct visitors at each step. Each step is a subset of the one before
 * by construction (the SQL intersects them), so the funnel can never widen.
 */
export interface PlayFunnel {
  /** Visitors with any recorded activity. */
  visited: number;
  /** Started at least one race or free roam. */
  started: number;
  /** Finished at least one race. */
  finished: number;
  /** Saved a build in the garage. */
  savedBuild: number;
  /** Signed in (sign_in event, or a linked player active in the window). */
  signedIn: number;
}

/** One race mode's starts, finishes and quits (live drives; replays excluded). */
export interface ModeRow {
  mode: string;
  starts: number;
  finishes: number;
  quits: number;
  /** Distinct visitors who started this mode. */
  visitors: number;
  /** Median finish time, in ms, null with no finishes. */
  medianTimeMs: number | null;
}

/** A car's popularity on the grid: race_start events by carId. */
export interface CarRow {
  carId: string;
  starts: number;
  visitors: number;
}

/** A city seed raced more than once is a course people come back to. */
export interface SeedRow {
  seed: number;
  /** The seed's typed name when one was ever sent. */
  seedText: string | null;
  starts: number;
  visitors: number;
}

/** Frame rate by preset tier, over `perf` events. */
export interface TierRow {
  tier: 'low' | 'medium' | 'high';
  /** perf events landing on this tier. */
  samples: number;
  visitors: number;
  /** Median of medianFps. */
  medianFps: number;
  /** Median of p95FrameMs. */
  p95FrameMs: number;
  /** Mean slowShare, 0-1. */
  slowShare: number;
}

/** Frame rate by GPU family (the visitor's gpu, folded to a short family name server side, e.g. "Apple M2"). */
export interface GpuRow {
  gpu: string;
  visitors: number;
  medianFps: number;
  /** The most common tier its perf events landed on. */
  tier: 'low' | 'medium' | 'high';
}

export interface HourRow {
  /** Hour of day in UTC, 0-23. The client shifts it for display. */
  hour: number;
  /** Sessions started in that hour. */
  sessions: number;
}

/** `GET op=insights&days=` (7, 30 or 90; default 30). Server-side aggregates, unfiltered by the client's toggles. */
export interface InsightsPayload {
  /** Size of the aggregate window, in days. */
  windowDays: number;
  sessions: {
    total: number;
    viewport: ViewportMix;
    /** Median engaged time per session, in ms. */
    medianEngagedMs: number;
    /** Median driving time per session that drove at all, in ms. */
    medianRaceMs: number;
  };
  funnel: PlayFunnel;
  modes: ModeRow[];
  cars: CarRow[];
  seeds: SeedRow[];
  tiers: TierRow[];
  gpus: GpuRow[];
  sources: SourceRow[];
  /** Always 24 rows, 0-23, zero-filled. */
  hourly: HourRow[];
  /** New visitors per day, zero-filled across the window. */
  days: StatDay[];
}
