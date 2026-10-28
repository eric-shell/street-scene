/**
 * Player facing names for the city's places, shared by the free roam area
 * chip and callouts (game/session.ts), the pause ticket (main.ts), the full
 * map's tags and readouts (ui/map/) and the signs in the world, so a place
 * is called the same thing everywhere: a named district area by its own name
 * (placeNames.ts), anywhere else by its neighbourhood (neighbourhoods.ts);
 * what kind of place it is, as the cards say under the name. Pure functions
 * of the World (the distance labels are UI formatting, ui/map/places.ts).
 */
import type { World } from '../world';
import type { Area } from '../districts/types';
import { hoodAt, hoodOf, hoodPlan, type Neighbourhood } from './neighbourhoods';
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
  parkingLot: 'Parking lot',
  waterfront: 'Harbor',
  lake: 'Lake',
};
const INFILL_NOUNS: Record<string, string> = { lot: 'Parking lot', plaza: 'Plaza' };

/** The neighbourhoods with their names drawn (the names come with the area names, so this asks for those first): what the signs in the world read. */
export function hoodsOf(world: World): Neighbourhood[] {
  areaNames(world);
  return hoodPlan(world).hoods;
}

/** A named area's name; any other area goes by the neighbourhood it lies in. */
export function placeName(world: World, a: Area): string {
  return areaNames(world).get(a.id) ?? hoodOf(world, a).name;
}

/** What kind of place an area is ("Park", "One-way shortcut"), or a neighbourhood for none. */
export function placeKind(a: Area | null): string {
  if (!a || !isNamedPlace(a)) return 'Neighbourhood';
  if (a.kind === 'backAlley' && a.variant === 'routeShortcut') return a.params.jumpExit ? 'One-way shortcut' : 'Race shortcut';
  if (a.kind === 'infill') return INFILL_NOUNS[a.variant] ?? 'Plaza';
  if (a.kind === 'waterfront' && a.variant === 'beach') return 'Beach';
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
