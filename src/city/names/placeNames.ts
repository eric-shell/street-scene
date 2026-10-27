/**
 * Every place in a city gets its own name: the neighbourhoods
 * (neighbourhoods.ts) and each notable district area ("Halsey Gardens",
 * "Marlowe Circle", "Works on Pike St"), so no two places on one map share
 * a name or go by their kind alone. Names come from the pools below, drawn
 * by the world's seed: the same city always has the same names, and the
 * pools come round again in other seeds. A name's stem (Halsey) is spent
 * once per city, so two places never sound alike either.
 *
 * Tunnels keep the names on their portal boards (city/districts/tunnel.ts,
 * drawn into the world), named first so nothing else takes their words.
 * Small frontage pieces (corner plazas, verges, planters) and plain blocks
 * are not places: they are wherever their neighbourhood is.
 */
import type { World } from '../world';
import type { Area } from '../districts/types';
import { tunnelName } from '../districts/tunnel';
import { Rng, deriveSeed } from '../../sim/prng';
import { hoodPlan, type HoodCharacter } from './neighbourhoods';

/** Neighbourhood names by character; a character's pool runs dry into the town pool. */
const HOODS: Record<HoodCharacter, readonly string[]> = {
  core: ['Midtown', 'Old Town', 'The Exchange', 'Civic Center', 'The Loop', 'Neon Row', 'Crossroads', 'Center City'],
  river: ['Riverside', 'Canal Ward', 'Millrace', 'Ferry Landing', 'Bridgeton', 'Lock District', 'Eastbank', 'Waterworks'],
  lake: ['Lakeview', 'Lakeshore', 'Shoreline', 'Mirror Flats', 'Boathouse Row', 'Stillwater'],
  harbor: ['Harborside', 'Lowtide', 'Saltmarsh', 'The Docklands', 'Bayview', 'Pier Row', 'Tidewater', 'Wharfside'],
  heights: ['Summit Heights', 'Crown Point', 'Ridgemont', 'Overlook', 'Highgate', 'Skyline Terrace', 'Belvedere', 'Windward'],
  town: [
    'Ironside',
    'Little Lisbon',
    'Fulton Yards',
    'Ashgrove',
    'Cinder Flats',
    'Redline',
    'Mill Quarter',
    'Chrome Hollow',
    'Lantern Ward',
    'Kingsbridge',
    'Paradise Row',
    'Velvet Ward',
    'Foundry Row',
    'Electric Mile',
    'Brickworks',
    'Greenpoint',
    'Sugar Flats',
    'Copper Ward',
    'Northgate',
    'Five Corners',
  ],
};

/** Stems for the area names: surnames, trees, birds and stones, any of which can name a park or an alley (the streets, streetNames.ts, draw from the ones left). */
export const STEMS = [
  'Halsey', 'Marlowe', 'Kessler', 'Thorne', 'Delancey', 'Ashby', 'Corbin', 'Vance', 'Pike', 'Mercer',
  'Hollis', 'Draper', 'Lowell', 'Fairbanks', 'Sutter', 'Kearny', 'Calloway', 'Brannan', 'Whitlock', 'Garrison',
  'Holloway', 'Prescott', 'Langley', 'Sterling', 'Bishop', 'Carver', 'Dalton', 'Ellery', 'Fenwick', 'Granger',
  'Harlow', 'Ingram', 'Jessup', 'Kimball', 'Larkin', 'Merritt', 'Norwood', 'Oakes', 'Pruitt', 'Radley',
  'Sayer', 'Tolliver', 'Underhill', 'Varick', 'Wexler', 'Yardley', 'Abbott', 'Beaumont', 'Dorsey', 'Everett',
  'Gideon', 'Hawthorne', 'Kingsley', 'Lennox', 'Monroe', 'Nash', 'Palmer', 'Quincy', 'Reyes', 'Santos',
  'Tanaka', 'Okafor', 'Moreno', 'Castillo', 'Novak', 'Ivers', 'Lockhart', 'Mayfair', 'Cobalt', 'Ember',
  'Garnet', 'Indigo', 'Jasper', 'Lambert', 'Magnolia', 'Onyx', 'Pewter', 'Quarry', 'Russet', 'Saffron',
  'Umber', 'Vesper', 'Willow', 'Cypress', 'Alder', 'Birch', 'Cedar', 'Elm', 'Hazel', 'Laurel',
  'Linden', 'Maple', 'Poplar', 'Rowan', 'Sycamore', 'Wren', 'Sparrow', 'Heron', 'Kestrel', 'Falcon',
  'Raven', 'Osprey', 'Bramble', 'Thistle', 'Marigold', 'Juniper', 'Aster', 'Calder', 'Dunmore', 'Easton',
  'Foley', 'Galloway', 'Hadley', 'Jarvis', 'Keller', 'Lowry', 'Mulberry', 'Nolan', 'Orson', 'Penrose',
] as const;

/** The El's lines go by a color. */
const LINES = ['Gold', 'Crimson', 'Cobalt', 'Violet', 'Jade', 'Amber', 'Silver', 'Copper'] as const;

/** Name forms by kind (and variant where it shows): `{}` takes a stem. */
const FORMS: Partial<Record<Area['kind'], readonly string[]>> = {
  park: ['{} Park', '{} Gardens', '{} Green', '{} Commons'],
  river: ['{} River', '{} Canal', '{} Creek'],
  lake: ['Lake {}', '{} Reservoir', '{} Water'],
  waterfront: ['{} Harbor', 'Port {}', '{} Wharf', '{} Docks'],
  market: ['{} Night Market', '{} Bazaar', '{} Lantern Market', '{} Street Market'],
  carPark: ['{} Garage', '{} Parkade', '{} Deck'],
  bluff: ['{} Bluff', '{} Cliffs', '{} Scarp'],
  highway: ['{} Expressway', '{} Freeway', '{} Skyway'],
  alley: ['{} Run', '{} Cut', '{} Strip', '{} Chase'],
  backAlley: ['{} Alley', '{} Passage', '{} Mews', '{} Lane'],
  roundabout: ['{} Circle', '{} Circus', '{} Rotary'],
  overpass: ['{} Viaduct', '{} Overpass', '{} Flyover'],
  roadworks: ['Works on {} St', 'Works on {} Ave', '{} Street dig'],
};
const VARIANT_FORMS: Record<string, readonly string[]> = {
  'waterfront:marina': ['{} Marina', '{} Yacht Basin', '{} Boat Harbor'],
  'park:woodland': ['{} Park', '{} Green', '{} Commons', '{} Woods'],
  'park:formal': ['{} Gardens', '{} Court', '{} Parterre'],
  'park:lakeside': ['{} Pond', '{} Mere', '{} Lake Park'],
  'hills:ridge': ['{} Ridge', '{} Rise'],
  'hills:dome': ['{} Hill', 'Mount {}', '{} Knoll'],
  'hills:basin': ['{} Basin', '{} Hollow'],
  'hills:terraced': ['{} Terraces', '{} Steps'],
  'monument:arch': ['{} Arch', '{} Gate'],
  'monument:column': ['{} Column', '{} Pillar'],
  'monument:obelisk': ['{} Needle', '{} Obelisk'],
  'infill:lot': ['{} Lot', '{} Yard'],
  'infill:plaza': ['{} Plaza', '{} Square'],
  'backAlley:routeShortcut': ['{} Cut-through', '{} Alley', '{} Passage'],
};

/** Infill that is a place of its own; the rest (corner plazas, verges, planters, bays) is frontage. */
const NAMED_INFILL = new Set(['lot', 'plaza']);

/** Whether an area is a place with a name of its own (else it goes by its neighbourhood). */
export function isNamedPlace(a: Area): boolean {
  if (a.kind === 'infill') return NAMED_INFILL.has(a.variant);
  if (a.kind === 'highway') return a.variant === 'deck';
  return a.kind === 'tunnel' || a.kind === 'subway' || !!(VARIANT_FORMS[`${a.kind}:${a.variant}`] ?? FORMS[a.kind]);
}

const books = new WeakMap<World, Map<number, string>>();

/** Every named area's name by area id (the neighbourhoods' are on hoodPlan's hoods), drawn on first use. */
export function areaNames(world: World): Map<number, string> {
  let m = books.get(world);
  if (!m) books.set(world, (m = nameCity(world)));
  return m;
}

function nameCity(world: World): Map<number, string> {
  const rng = new Rng(deriveSeed(world.seed, 'placeNames'));
  const names = new Set<string>();
  const words = new Set<string>();
  const take = (name: string): string => {
    names.add(name);
    for (const w of name.split(/[\s-]+/)) words.add(w.toLowerCase());
    return name;
  };
  const out = new Map<number, string>();
  for (const a of world.areas) if (a.kind === 'tunnel') out.set(a.id, take(tunnelName(a)));
  for (const hd of hoodPlan(world).hoods) {
    const free = (pool: readonly string[]) => pool.filter((n) => !names.has(n) && !n.split(' ').some((w) => words.has(w.toLowerCase()) && !COMMON.has(w)));
    let pool = free(HOODS[hd.character]);
    if (!pool.length) pool = free(HOODS.town);
    hd.name = take(pool.length ? pool[rng.int(0, pool.length - 1)] : `District ${hd.id + 1}`);
  }
  const stems = shuffled(rng, STEMS);
  const lines = shuffled(rng, LINES);
  for (const a of world.areas) {
    if (out.has(a.id) || !isNamedPlace(a)) continue;
    if (a.kind === 'subway') {
      const c = lines.find((l) => !words.has(l.toLowerCase())) ?? 'Night';
      out.set(a.id, take(`${c} Line`));
      continue;
    }
    const forms = VARIANT_FORMS[`${a.kind}:${a.variant}`] ?? FORMS[a.kind]!;
    const form = forms[rng.int(0, forms.length - 1)];
    const stem = stems.find((s) => !words.has(s.toLowerCase()));
    // A city with more places than stems (none yet) numbers the spares.
    out.set(a.id, take(stem ? form.replace('{}', stem) : `${form.replace('{} ', '').replace(' {}', '')} ${out.size + 1}`));
  }
  return out;
}

/** Words a neighbourhood name may share with another (The, Row, Ward...): only the distinctive ones are spent. */
const COMMON = new Set(['The', 'Row', 'Ward', 'Heights', 'Point', 'Flats', 'Yards', 'Center', 'City', 'Little', 'Mile', 'Terrace', 'Quarter']);

function shuffled<T>(rng: Rng, list: readonly T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
