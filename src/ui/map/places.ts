/**
 * How far and which way a place is ("0.4 mi · NE"), as the full map, its
 * places list, the drone's heading readout and the HUD's waypoint chip say
 * it. What places are called is city/names/places.ts; this is only the
 * formatting of an offset in the player's units.
 */
import { roadDistance } from '../kit/units';

/** The eight compass points, clockwise from north. */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Compass bearing (deg, clockwise from north) of a world offset. North is +Z
 * and east is -X, as on the maps and in the drone's heading readout.
 */
export function bearingDeg(dx: number, dz: number): number {
  return ((Math.atan2(-dx, dz) * 180) / Math.PI + 360) % 360;
}

/** The eight point compass direction of a world offset (dx, dz). */
export function compassPoint(dx: number, dz: number): string {
  return COMPASS[Math.round(bearingDeg(dx, dz) / 45) % 8];
}

/** A distance as the maps and the HUD say it: "Here" within a car length or two, then feet and miles (ui/units.ts). */
export function formatDistance(m: number): string {
  return m < 10 ? 'Here' : roadDistance(m);
}

/** How far and which way an offset from the player is: "0.4 mi · NE", or just "Here". */
export function distanceLabel(dx: number, dz: number): string {
  const d = Math.hypot(dx, dz);
  return d < 10 ? 'Here' : `${formatDistance(d)} · ${compassPoint(dx, dz)}`;
}
