/**
 * The analytics vocabulary the game, the server and the dashboard share (docs/analytics.md): the wire format of
 * a beacon to `/api/analytics` and every event type with its metadata. The server validates against these
 * (`isEventType`, the size caps) and stores the metadata as JSONB; the dashboard reads it back typed. Adding an
 * event means a type here, its metadata interface, and the `visitor_events` check constraint in db/schema.sql.
 */
import type { RaceType } from '../ui/settings';
import type { Difficulty } from '../sim/race';

/** A race was started from the menu, a replay began, or free roam opened (`mode: 'roam'`). */
export interface RaceStartMeta {
  mode: RaceType;
  /** The numeric seed the city was built from. */
  seed: number;
  /** The seed as typed, when the player picked one by name. */
  seedText?: string;
  carId: string;
  /** AI rivals on the grid (0 for drift, free roam and time trials). */
  opponents: number;
  difficulty: Difficulty;
  /** A recorded replay playing back rather than a live drive. */
  replay: boolean;
  /** A ghost of the player's best was on the course. */
  ghost: boolean;
}

/** The player crossed the line (live drives only, never replays). */
export interface RaceFinishMeta {
  mode: RaceType;
  seed: number;
  carId: string;
  /** The player's race time, in ms. */
  timeMs: number;
  /** Finishing place, 1-based. */
  place: number;
  /** Cars on the grid, the player included. */
  entrants: number;
  /** This time beat the stored best for the seed and mode. */
  personalBest: boolean;
  /** The run's points (nitrous callouts' tally, never below 0), absent before it was tracked; what the lifetime total adds up. */
  points?: number;
  /** Drift score, drift mode only. */
  score?: number;
}

/** A live race (or free roam) left before the finish: quit from pause, restarted, or the page closed. */
export interface RaceQuitMeta {
  mode: RaceType;
  seed: number;
  carId: string;
  /** Time driven before leaving, in ms. */
  elapsedMs: number;
  /** Route progress at the moment of leaving, 0-1 (absent for free roam). */
  progress?: number;
  reason: 'quit' | 'restart' | 'pagehide';
}

/** The garage was entered. */
export interface GarageOpenMeta {
  /** Through the roller door from the menu, or directly (deep link, back from a race). */
  viaDoor: boolean;
}

/** A garage slot was saved. */
export interface BuildSaveMeta {
  carId: string;
  /** Slot index, 0-based. */
  slot: number;
}

/** A share code or link was made for a build. */
export interface BuildShareMeta {
  carId: string;
}

/** A shared build was imported into the garage. */
export interface BuildImportMeta {
  carId: string;
}

/** A Google sign-in succeeded on this device. The server links the visitor to the player from the session cookie. */
export interface SignInMeta {
  /** The account was created by this sign-in. */
  newAccount: boolean;
}

/** The player signed out. */
export type SignOutMeta = Record<string, never>;

/**
 * Frame-time summary of one stretch of driving, sent when a race or free roam ends (or the page hides mid
 * race). Measured over driving frames only, so menus and loading screens never pull the numbers down.
 */
export interface PerfMeta {
  reason: 'race_end' | 'pagehide';
  mode: RaceType;
  /** Auto quality ladder level at the end (render/autoQuality.ts QUALITY_LEVELS index). */
  level: number;
  /** The preset tier that level belongs to. */
  tier: 'low' | 'medium' | 'high';
  /** Auto graphics on; off means the player pinned a preset. */
  auto: boolean;
  /** The controller's aim, in fps (120 capped at the display's refresh). */
  aimFps: number;
  /** Median frames per second over the stretch. */
  medianFps: number;
  /** 95th percentile frame time, in ms: the stutter the median hides. */
  p95FrameMs: number;
  /** Share of frames slower than 33.3 ms (FRAME_BUDGET's failure line), 0-1. */
  slowShare: number;
  /** Frames measured. */
  frames: number;
}

/** A race result was sent as a challenge link (results screen): `?seed=&race=&beat=` tagged `utm_source=challenge`. */
export interface RaceShareMeta {
  mode: RaceType;
  seed: number;
  /** The native share sheet (touch screens) or the clipboard. */
  via: 'share' | 'copy';
}

/**
 * Something broke in the player's browser: an uncaught error or rejection (analytics/errors.ts), no WebGL at boot,
 * the GPU dropping the context mid game, or a frame the GPU spoiled (NaN pixels, see-through; render/frameWatch.ts).
 * A handful per page at most, each message once.
 */
export interface ErrorMeta {
  kind: 'error' | 'rejection' | 'webgl' | 'context_lost' | 'bad_frame';
  /** The error's message, cut to 300 characters. */
  message: string;
  /** The top few stack frames with the page's origin stripped, cut to 600 characters. */
  stack?: string;
  /** The screen it happened on (main.ts's state: menu, race, garage, drone, freefly). */
  screen?: string;
}

/** Every event type and its metadata. */
export interface EventMetaMap {
  race_start: RaceStartMeta;
  race_finish: RaceFinishMeta;
  race_quit: RaceQuitMeta;
  garage_open: GarageOpenMeta;
  build_save: BuildSaveMeta;
  build_share: BuildShareMeta;
  build_import: BuildImportMeta;
  sign_in: SignInMeta;
  sign_out: SignOutMeta;
  perf: PerfMeta;
  race_share: RaceShareMeta;
  error: ErrorMeta;
}

export type EventType = keyof EventMetaMap;

/** In the order of db/schema.sql's check constraint; keep the two in step. */
export const EVENT_TYPES: readonly EventType[] = ['race_start', 'race_finish', 'race_quit', 'garage_open', 'build_save', 'build_share', 'build_import', 'sign_in', 'sign_out', 'perf', 'race_share', 'error'];

export function isEventType(v: unknown): v is EventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v);
}

/** Device facts from the renderer's probe, sent once with the page view (render/autoQuality.ts DeviceInfo). */
export interface DeviceBeacon {
  gpu: string;
  dpr: number;
  cores: number;
  /** navigator.deviceMemory in GB, null outside Chromium. */
  memoryGb: number | null;
  touch: boolean;
}

/**
 * One POST to `/api/analytics`. Ids ride in the body, not headers, because `navigator.sendBeacon` (heartbeats
 * and the pagehide flush) cannot set headers. The page view is a real `fetch`, so it alone carries the edge's
 * geo headers and the session cookie: enrichment happens there and only there.
 */
export type AnalyticsBeacon =
  | {
      op: 'pageview';
      visitorId: string;
      sessionId: string;
      /** location.pathname + search. */
      path: string;
      referrer: string | null;
      viewport: { w: number; h: number };
      screen: { w: number; h: number };
      /** Intl's resolved time zone and navigator.language: browser-reported, more trustworthy than IP geo. */
      clientTimezone: string | null;
      language: string | null;
      utm: { source: string | null; medium: string | null; campaign: string | null };
      /** __BUILD_HASH__. */
      build: string;
      device: DeviceBeacon | null;
    }
  | {
      op: 'heartbeat';
      visitorId: string;
      sessionId: string;
      /** Cumulative for the whole visit, in ms (monotonic on the server). */
      engagedMs: number;
      raceMs: number;
    }
  | {
      [K in EventType]: {
        op: 'event';
        visitorId: string;
        sessionId: string;
        type: K;
        metadata: EventMetaMap[K];
      };
    }[EventType];

/** The largest beacon body the server reads, in bytes. */
export const MAX_BEACON_BYTES = 4 * 1024;

/** A visit ends after this long without activity, in ms. */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
