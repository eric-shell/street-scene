/**
 * US customary units for everything the player reads: speeds in mph, short
 * distances and heights in feet, longer ones in miles. The sim, the city and
 * the tuning data stay metric (m, m/s, km/h, kg, Nm); only the display
 * converts, and only here, so every screen rounds the same way. The debug
 * tuning panels keep SI because they edit drivingParams.json as written.
 */

/** Meters in a foot. */
export const M_PER_FT = 0.3048;
/** Meters in a mile. */
export const M_PER_MI = 1609.344;
/** m/s in one mph. */
export const MS_PER_MPH = 0.44704;
/** km/h in one mph. */
export const KMH_PER_MPH = 1.609344;

/** A speed in m/s as mph. */
export const mph = (ms: number): number => ms / MS_PER_MPH;

/** A speed in m/s as "62 mph". */
export const speedLabel = (ms: number): string => `${Math.round(mph(ms))} mph`;

/** A height or short length in meters as whole feet: "120 ft". */
export const feetLabel = (m: number): string => `${Math.round(m / M_PER_FT)} ft`;

/**
 * A distance the way US road signs and maps say it: feet (to the nearest 10)
 * under a tenth of a mile, then miles to a tenth, whole miles from 10.
 */
export function roadDistance(m: number): string {
  if (m < M_PER_MI / 10) return `${Math.round(m / M_PER_FT / 10) * 10} ft`;
  const mi = m / M_PER_MI;
  return `${mi.toFixed(mi < 9.95 ? 1 : 0)} mi`;
}
