/**
 * Player facing names for the city's places, shared by the free roam area
 * chip and callouts (game/session.ts), the pause ticket (main.ts) and the
 * full map's tags and readouts (ui/map/), so a place is called the same
 * thing everywhere: a named district area by its own name (placeNames.ts),
 * anywhere else by its neighbourhood (neighbourhoods.ts); what kind of place
 * it is, as the cards say under the name; and how far and which way a place
 * is ("0.4 mi · NE"), as the full map, its places list and the HUD's
 * waypoint chip say it.
 */
import type { World } from '../../city/world';
import type { Area } from '../../city/districts/types';
import { roadDistance } from '../kit/units';
import { hoodAt, hoodOf, type Neighbourhood } from './neighbourhoods';
import { areaNames, isNamedPlace } from './placeNames';

/** The city every seed is a night in (working title), as the full map's header names it. */
export const CITY_NAME = 'New San Delphia';

/** What kind of place each district kind is, one of them (the cards' line under a name). */
const KIND_NOUNS: Partial<Record<Area['kind'], string>> = {
  alley: 'Raceway alley',
  backAlley: 'Back alley',
  park: 'Park',
  subway: 'Under the El',
  highway: 'Expressway',
  bluff: 'Bluff',
  river: 'River channel',
  roundabout: 'Roundabout',
  hills: 'Hills',
  monument: 'Monument',
  tunnel: 'Tunnel',
  overpass: 'Under the freeway',
  market: 'Night market',
  roadworks: 'Roadworks',
  carPark: 'Parking garage',
  waterfront: 'Harbor',
  lake: 'Lake',
};
const INFILL_NOUNS: Record<string, string> = { lot: 'Parking lot', plaza: 'Plaza' };

/** A named area's name; any other area goes by the neighbourhood it lies in. */
export function placeName(world: World, a: Area): string {
  return areaNames(world).get(a.id) ?? hoodOf(world, a).name;
}

/** What kind of place an area is ("Park", "One-way shortcut"), or a neighbourhood for none. */
export function placeKind(a: Area | null): string {
  if (!a || !isNamedPlace(a)) return 'Neighbourhood';
  if (a.kind === 'backAlley' && a.variant === 'routeShortcut') return a.params.jumpExit ? 'One-way shortcut' : 'Race shortcut';
  if (a.kind === 'infill') return INFILL_NOUNS[a.variant] ?? 'Plaza';
  return KIND_NOUNS[a.kind] ?? '';
}

/** The El, the river and the expressway cross many neighbourhoods: they belong to none, and their line on a card says only what they are. */
export const crossesTown = (a: Area): boolean => a.kind === 'subway' || a.kind === 'river' || a.kind === 'highway';

/** The line under a place's name on the cards: what it is and which neighbourhood ("Park · Ironside"); `what` stands in for the kind (a drift zone). */
export function placeLine(world: World, a: Area, what = placeKind(a)): string {
  return crossesTown(a) ? what : `${what} · ${hoodOf(world, a).name}`;
}

/** A place at a world point: the named area there (none on a plain street or block), its name, and the neighbourhood around it. */
export interface PlaceAt {
  name: string;
  area: Area | null;
  hood: Neighbourhood;
}

/** The place at a world point; `area` is what is there when the caller already knows (the map's harbor water, say). */
export function placeAt(world: World, x: number, z: number, area: Area | null = world.areaAt(x, z)): PlaceAt {
  const named = area && isNamedPlace(area) ? area : null;
  const hood = named ? hoodOf(world, named) : hoodAt(world, x, z, area);
  return { name: named ? placeName(world, named) : hood.name, area: named, hood };
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
