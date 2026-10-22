/**
 * Player facing names for the district areas, shared by the free roam area
 * chip and callouts (game/session.ts) and the full map's tags and readouts
 * (ui/map/), so a place is called the same thing everywhere; and how
 * far and which way a place is ("0.4 mi · NE"), as the full map, its places
 * list and the HUD's waypoint chip say it.
 */
import type { Area } from '../../city/districts/types';
import { tunnelName } from '../../city/districts/tunnel';
import { roadDistance } from '../kit/units';

/** The city every seed is a night in (working title), as the full map's header names it. */
export const CITY_NAME = 'New San Delphia';

export const AREA_NAMES: Partial<Record<Area['kind'], string>> = {
  alley: 'Raceway alley',
  backAlley: 'Back alley',
  park: 'Park',
  subway: 'Under the El',
  bluff: 'The bluff',
  river: 'River channel',
  roundabout: 'Roundabout',
  hills: 'The hills',
  monument: 'Monument plaza',
  tunnel: 'Tunnel',
  overpass: 'Under the freeway',
  market: 'Night market',
  roadworks: 'Roadworks',
  carPark: 'Multi-storey car park',
  waterfront: 'Waterfront',
  lake: 'Lake',
};

export const INFILL_NAMES: Record<string, string> = { lot: 'Parking lot', plaza: 'Plaza', cornerPlaza: 'Corner plaza', verge: 'Downtown' };

/** Name of the place an area is; plain streets (no area) are Downtown. */
export function placeName(a: Area | null): string {
  if (!a) return 'Downtown';
  if (a.kind === 'infill') return INFILL_NAMES[a.variant] ?? 'Downtown';
  // Each tunnel goes by the name on its portal boards.
  if (a.kind === 'tunnel') return tunnelName(a);
  return AREA_NAMES[a.kind] ?? 'Downtown';
}

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
