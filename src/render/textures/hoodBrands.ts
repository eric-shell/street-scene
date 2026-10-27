/**
 * Shops and billboards that say where they are: a share of a city's podium neon names and rooftop ads is
 * built from the stem of the neighbourhood they stand in ("RIVERSIDE NOODLE", "SUMMIT TIRES"), so a
 * district's signs and its gateway banner (street/placeSigns.ts) name the same place the map does
 * (city/names). The rest of the name pools stay as they are. Each neighbourhood gets a few trades of its
 * own, drawn from its own stream, appended to the sign and billboard atlases as extra cells. Pure of
 * three.js (strings only), seeded by the world, so the menu city and a race of one seed agree.
 */
import type { World } from '../../city/world';
import { hoodStem } from '../../city/names/neighbourhoods';
import { hoodsOf } from '../../city/names/places';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Brand } from './billboardAtlas';

/** Neon sign trades a neighbourhood's stem is put in front of, with the tag line a billboard prints under it. */
const TRADES: readonly (readonly [string, string])[] = [
  ['NOODLE', 'SLURP RESPONSIBLY'], ['TIRES', 'FOUR FOR THREE'], ['GARAGE', 'DYNO  WRAPS  TUNING'], ['DINER', 'OPEN 24 HOURS'],
  ['MOTEL', 'VACANCY  POOL  TV'], ['LIQUOR', 'LOTTO  ICE  SMOKES'], ['TACOS', 'AL PASTOR TILL DAWN'], ['PIZZA', 'BY THE SLICE'],
  ['KARAOKE', 'PRIVATE ROOMS'], ['PAWN', 'WE BUY ANYTHING'], ['LAUNDRY', 'WASH  FOLD  24H'], ['ARCADE', 'TOKENS  PINBALL'],
  ['AUTO', 'PARTS  SERVICE'], ['BAR', 'LAST CALL 4AM'], ['CAFE', 'COFFEE  PIE'], ['DONUTS', 'FRESH AT 3 AM'],
  ['SUSHI', 'TILL LATE'], ['PHARMACY', 'NEVER SLEEPS'], ['BARBER', 'WALK INS'], ['RECORDS', 'BUY  SELL  SPIN'],
];

/** Neon sign names per neighbourhood. */
export const STEM_SHOPS_PER_HOOD = 3;

/** One neighbourhood's shops and its billboard ad. */
export interface HoodBrands {
  /** The neighbourhood's id (Neighbourhood.id). */
  hood: number;
  /** Neon sign names, upper case, STEM_SHOPS_PER_HOOD of them. */
  shops: string[];
  /** The billboard ad. */
  ad: Brand;
}

const books = new WeakMap<World, HoodBrands[]>();

/** The world's neighbourhood brands, by neighbourhood id (hoods without a usable stem have none). */
export function hoodBrands(world: World): HoodBrands[] {
  let b = books.get(world);
  if (!b) {
    b = hoodsOf(world).map((hood) => {
      const stem = hoodStem(hood.name).toUpperCase();
      const rng = new Rng(deriveSeed(world.seed, `hoodBrands${hood.id}`));
      const trades = rng.shuffle(TRADES.slice());
      return { hood: hood.id, shops: trades.slice(0, STEM_SHOPS_PER_HOOD).map(([t]) => `${stem} ${t}`), ad: { text: `${stem} ${trades[0][0]}`, sub: trades[0][1] } };
    });
    books.set(world, b);
  }
  return b;
}
