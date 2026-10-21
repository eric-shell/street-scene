/**
 * Player facing names for the district areas, shared by the free roam area
 * chip and callouts (game/session.ts) and the full map's tags and readouts
 * (ui/fullMap.ts), so a place is called the same thing everywhere.
 */
import type { Area } from '../city/districts/types';
import { tunnelName } from '../city/districts/tunnel';

export const AREA_NAMES: Partial<Record<Area['kind'], string>> = {
  alley: 'Raceway alley',
  backAlley: 'Back alley',
  park: 'Park',
  subway: 'Under the El',
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
