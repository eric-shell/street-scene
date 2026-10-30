/** Fixed simulation rate. Never derive anything in the sim from wall clock time. */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
/** Physics substeps per tick (suspension and tire stability). */
export const SUBSTEPS = 2;
/**
 * Crash events (sounds, shake), race cars and traffic alike: the least impact speed that makes one (m/s) and
 * the least gap between two for the same car or pair (ticks), so a scrape is not a burst of crashes.
 */
export const CRASH_EVENT = { speed: 2, gap: Math.round(0.25 * TICK_HZ) } as const;
/** Two bodies further apart than this in height (m) are on different levels (a bridge deck over the channel) and never touch. */
export const LEVEL_GAP = 3;
