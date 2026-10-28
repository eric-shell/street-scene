/**
 * The wardrobe every person in the game dresses from, so the crowds, the
 * street, the garage crew and the drivers read as one city: eight skin tones,
 * hair, and clothes per context, every list cut from one palette (`C`).
 *
 * Three contexts, so a glance tells them apart:
 * - `raceLook`, the race-goers: young, counter-culture, action sports and
 *   streetwear, with the first Fast and the Furious (2001) as the reference.
 *   Tanks, tight and oversized tees, crop tops, jerseys, hoodies, open
 *   bombers and track jackets; baggy cargos, wide-leg jeans, shorts; backwards
 *   caps, bucket hats, bandanas, headphones; bleached and dyed hair; loud
 *   sneakers, chains, backpacks. Dark bases with neon and team colors on top.
 * - `streetLook`, the pedestrians (and the drivers): everyday, muted and less
 *   edgy. Jackets and coats over a tee, sweaters, hoodies, jeans and chinos,
 *   the odd bright piece, a beanie or a hood, a bag.
 * - `shopLook`, the mechanics: an F&F garage. Coveralls rolled down and tied
 *   at the waist over a tank, work shirts with a name patch and rolled
 *   sleeves, a tank and a tool belt, full coveralls, black cargos and work
 *   boots, backwards caps, beanies, bandanas, gloves and a rag; dark,
 *   oil-stained shop blues, greys and reds, the hi-vis stripe rare.
 *
 * A look is picked with a `rnd` in 0..1 the caller owns (a seeded Rng for the
 * crowds, so a seed's crowd dresses the same every race). Every look draws a
 * fixed number of rolls whatever it picks, so one person's look never shifts
 * the next one's. What the right hand holds (phone, flag, glowstick) is the
 * caller's to add. Render only.
 */
import { WEAR } from './person';
import type { PersonLook } from './person';

/** Skin tones, light to dark. */
export const SKIN = [0xf0c8a8, 0xe0b394, 0xd8a37f, 0xc68e6a, 0xa8714e, 0x8a5a3c, 0x5e3a26, 0x3d2416] as const;
/** Hair: black, browns, a blond, a red, a grey. */
export const HAIR = [0x101012, 0x1f1612, 0x2a1e14, 0x5a3a1e, 0x8a5a2a, 0xb08a50, 0x7a2a16, 0x8d8d90] as const;
/** Bleached and dyed hair for the race-goers: bleach, platinum, pink, blue, green, fire red. */
const DYED: readonly number[] = [0xd8c890, 0xe0dcd0, 0xd04a8a, 0x2a5ad0, 0x2aa060, 0xb0201a];

/** The one palette (sRGB hex) every context's lists are cut from. */
const C = {
  // Darks and neutrals.
  black: 0x101012,
  ink: 0x121212,
  charcoal: 0x1b1d24,
  slate: 0x2a2f3a,
  gunmetal: 0x3a3d44,
  grey: 0x5a5e66,
  ash: 0x7a7f8a,
  silver: 0xa8acb4,
  white: 0xd8d8d8,
  bone: 0xf2efe8,
  cream: 0xe0d6bc,
  // Denim.
  rinse: 0x14182a,
  indigo: 0x1c2233,
  denim: 0x2b3a5c,
  stonewash: 0x5a7398,
  // Earth.
  coffee: 0x2a1e14,
  umber: 0x3a3426,
  khaki: 0x6b5a3e,
  camel: 0xa8804e,
  olive: 0x3a4a2a,
  forest: 0x3a5a2a,
  // Deep colors and the shop's.
  navy: 0x1c2a44,
  workBlue: 0x2f4f8a,
  rust: 0x6b2a1c,
  teal: 0x1f3f3a,
  ochre: 0x8a6a2a,
  burgundy: 0x8a1424,
  royal: 0x1f3f8a,
  plum: 0x5a1a4a,
  deepTeal: 0x0f3a3a,
  mustard: 0xc9a227,
  // Racing team colors.
  teamRed: 0xc8102e,
  teamBlue: 0x1d4f9a,
  teamOrange: 0xe0601c,
  teamYellow: 0xf2c418,
  teamGreen: 0x1f8a4a,
  // Neon.
  pink: 0xff2d7a,
  cyan: 0x2de2ff,
  lime: 0xa6ff2e,
  orange: 0xff6a00,
  purple: 0x6b2fc2,
  electric: 0x1e6bff,
} as const;

// The race-goers: dark bases, neon and team colors on top, loud shoes.
const RACE_DARK: readonly number[] = [C.black, C.ink, C.charcoal, C.slate, C.white, C.bone, C.gunmetal];
const NEON: readonly number[] = [C.pink, C.cyan, C.lime, C.orange, C.purple, C.electric, C.teamYellow];
const TEAM: readonly number[] = [C.teamRed, C.teamBlue, C.teamOrange, C.teamYellow, C.teamGreen, C.white];
/** Bombers and track jackets: black, olive, burgundy, satin team colors, a neon track top. */
const RACE_JACKETS: readonly number[] = [C.black, C.charcoal, C.olive, C.burgundy, C.teamBlue, C.teamRed, C.royal, C.cyan, C.purple, C.silver];
const RACE_CARGO: readonly number[] = [C.black, C.khaki, C.olive, C.charcoal, C.forest, C.slate, C.camel];
const DENIM: readonly number[] = [C.rinse, C.indigo, C.denim, C.stonewash, C.black];
const RACE_SHORTS: readonly number[] = [C.khaki, C.black, C.denim, C.olive, C.charcoal, C.white];
const TRACK_PANTS: readonly number[] = [C.black, C.charcoal, C.royal, C.teamRed, C.slate];
const LOUD_SHOES: readonly number[] = [C.white, C.bone, C.black, C.teamRed, C.cyan, C.lime, C.orange, C.electric, C.pink, C.teamYellow];
const RACE_CAPS: readonly number[] = [C.black, C.white, C.teamRed, C.teamBlue, C.pink, C.cyan, C.lime, C.orange, C.olive, C.khaki, C.purple];

// The street: muted, the odd bright piece.
const STREET_OUTER: readonly number[] = [C.charcoal, C.slate, C.navy, C.olive, C.camel, C.coffee, C.black, C.burgundy, C.khaki, C.gunmetal];
const STREET_INNER: readonly number[] = [C.white, C.bone, C.grey, C.charcoal, C.navy, C.cream, C.slate];
const STREET_TOPS: readonly number[] = [C.charcoal, C.slate, C.navy, C.grey, C.olive, C.burgundy, C.black, C.ash, C.deepTeal, C.plum, C.bone, C.umber];
const STREET_BRIGHT: readonly number[] = [C.teamRed, C.mustard, C.royal, C.teamOrange, C.cyan, C.pink];
const CHINOS: readonly number[] = [C.khaki, C.olive, C.camel, C.cream, C.umber];
const TROUSERS: readonly number[] = [C.charcoal, C.black, C.slate, C.gunmetal, C.indigo];
const STREET_SHOES: readonly number[] = [C.black, C.coffee, C.white, C.bone, C.grey, C.navy, C.umber];
const STREET_CAPS: readonly number[] = [C.charcoal, C.navy, C.black, C.burgundy, C.olive, C.mustard, C.grey, C.teamRed];

// The shop: dark work colors, oil and grime.
const COVERALL: readonly number[] = [C.navy, C.workBlue, C.gunmetal, C.grey, C.khaki, C.charcoal];
const WORK_SHIRT: readonly number[] = [C.navy, C.workBlue, C.gunmetal, C.grey, C.rust, C.teal, C.ochre, C.charcoal, C.burgundy];
const TANK: readonly number[] = [C.white, C.bone, C.silver, C.black, C.charcoal];
const SHOP_PANTS: readonly number[] = [C.black, C.charcoal, C.indigo, C.khaki, C.navy, C.gunmetal];
const SHOP_TEES: readonly number[] = [C.black, C.white, C.grey, C.charcoal, C.teamRed];
const SHOP_HOODIES: readonly number[] = [C.charcoal, C.black, C.grey, C.navy, C.burgundy];
const BOOTS: readonly number[] = [C.coffee, C.black, C.umber, C.camel];
const SHOP_SNEAKERS: readonly number[] = [C.black, C.white, C.grey];
const SHOP_CAPS: readonly number[] = [C.black, C.teamRed, C.teamBlue, C.navy, C.charcoal, C.grey, C.burgundy];
/** What grime drifts the shop's clothes toward. */
const OIL = 0x1a1410;

const pick = <T,>(list: readonly T[], r: number): T => list[Math.min(list.length - 1, Math.floor(r * list.length))];
/** A value from [value, weight] pairs by one roll (weights need not sum to one). */
function weigh<T>(list: readonly (readonly [T, number])[], r: number): T {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let at = r * total;
  for (const [v, w] of list) if ((at -= w) < 0) return v;
  return list[list.length - 1][0];
}
/** `n` rolls drawn up front, so a look's roll count never depends on what it picks. */
const rolls = (rnd: () => number, n: number): number[] => Array.from({ length: n }, () => rnd());

/** Halfway from a hex color to another (sRGB channels, as the wardrobe is written). */
function tint(from: number, to: number, t: number): number {
  const ch = (shift: number) => Math.round(((from >> shift) & 255) * (1 - t) + ((to >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** The race-goers' heads (a hood comes with a hoodie instead). */
const RACE_HEADS = [
  [0, 0.36],
  [WEAR.backcap, 0.19],
  [WEAR.cap, 0.07],
  [WEAR.bucket, 0.13],
  [WEAR.bandana, 0.11],
  [WEAR.beanie, 0.05],
  [WEAR.headphones, 0.07],
] as const;
const RACE_HAIR = [
  [WEAR.hair, 0.42],
  [WEAR.long, 0.26],
  [WEAR.big, 0.14],
  [0, 0.18],
] as const;
type RaceTop = 'tee' | 'tank' | 'crop' | 'jersey' | 'hoodie' | 'jacket' | 'longsleeve';
const RACE_TOPS: readonly (readonly [RaceTop, number])[] = [
  ['tee', 0.24],
  ['tank', 0.17],
  ['crop', 0.1],
  ['jersey', 0.1],
  ['hoodie', 0.11],
  ['jacket', 0.21],
  ['longsleeve', 0.07],
];
type RaceBottom = 'cargo' | 'wide' | 'slim' | 'shorts' | 'track';
const RACE_BOTTOMS: readonly (readonly [RaceBottom, number])[] = [
  ['cargo', 0.28],
  ['wide', 0.26],
  ['slim', 0.13],
  ['shorts', 0.21],
  ['track', 0.12],
];

/**
 * Someone at the races: dark bases with a neon or team-colored piece, mostly bare arms on a warm night, baggy or
 * wide below, a cap worn backwards, a bucket hat or a bandana on many, dyed hair on some, loud shoes, a chain or a
 * backpack now and then. Fifteen rolls.
 */
export function raceLook(rnd: () => number): PersonLook {
  const r = rolls(rnd, 15);
  const skin: number = pick(SKIN, r[0] ** 1.2);
  const color = (x: number) => (x < 0.55 ? pick(RACE_DARK, x / 0.55) : x < 0.82 ? pick(NEON, (x - 0.55) / 0.27) : pick(TEAM, (x - 0.82) / 0.18));
  const top = weigh(RACE_TOPS, r[5]);
  let shirt = color(r[6]);
  let sleeves = skin;
  let wear = 0;
  if (top === 'tank') wear |= WEAR.tank;
  else if (top === 'crop') wear |= WEAR.crop | (r[7] < 0.5 ? WEAR.tank : 0);
  else if (top === 'jersey') {
    shirt = pick(TEAM, r[6]);
    wear |= r[7] < 0.5 ? WEAR.tank : 0;
  } else if (top === 'hoodie') sleeves = shirt;
  else if (top === 'jacket') {
    // An open bomber or track jacket over a tee, the tee often the bright one.
    wear |= WEAR.jacket;
    sleeves = pick(RACE_JACKETS, r[7]);
    shirt = r[6] < 0.5 ? pick(RACE_DARK, r[6] * 2) : pick(NEON, (r[6] - 0.5) * 2);
  } else if (top === 'longsleeve') sleeves = shirt;
  const head = top === 'hoodie' && r[4] < 0.45 ? WEAR.hood : weigh(RACE_HEADS, r[4]);
  const bottom = weigh(RACE_BOTTOMS, r[8]);
  const pants =
    bottom === 'cargo' ? pick(RACE_CARGO, r[9]) : bottom === 'shorts' ? pick(RACE_SHORTS, r[9]) : bottom === 'track' ? pick(TRACK_PANTS, r[9]) : pick(DENIM, r[9]);
  if (bottom === 'cargo') wear |= WEAR.cargo | WEAR.baggy;
  else if (bottom === 'wide') wear |= WEAR.baggy;
  else if (bottom === 'shorts') wear |= WEAR.shorts | (r[10] < 0.5 ? WEAR.cargo : 0);
  return {
    skin,
    hair: r[1] < 0.22 ? pick(DYED, r[2]) : pick(HAIR, r[2]),
    shirt,
    sleeves,
    pants,
    shoes: pick(LOUD_SHOES, r[11]),
    cap: pick(RACE_CAPS, r[12]),
    wear: wear | head | weigh(RACE_HAIR, r[3]) | (r[13] < 0.25 ? WEAR.chain : 0) | (r[14] < 0.15 ? WEAR.backpack : 0),
  };
}

const STREET_HEADS = [
  [0, 0.68],
  [WEAR.beanie, 0.1],
  [WEAR.cap, 0.09],
  [WEAR.headphones, 0.06],
  [WEAR.bucket, 0.03],
  [WEAR.backcap, 0.04],
] as const;
const STREET_HAIR = [
  [WEAR.hair, 0.55],
  [WEAR.long, 0.25],
  [WEAR.big, 0.05],
  [0, 0.15],
] as const;

/**
 * Someone on the street at night: a jacket or coat over a tee, a sweater, a hoodie or a tee, jeans, chinos or dark
 * trousers, muted with the odd bright piece; a beanie, a cap or the hood up on some, a bag on a few. Thirteen rolls.
 */
export function streetLook(rnd: () => number): PersonLook {
  const r = rolls(rnd, 13);
  const skin: number = pick(SKIN, r[0] ** 1.2);
  const bright = r[7] < 0.1;
  const main = bright ? pick(STREET_BRIGHT, r[5]) : pick(STREET_TOPS, r[5]);
  const top = weigh(
    [
      ['jacket', 0.36],
      ['hoodie', 0.16],
      ['sweater', 0.28],
      ['tee', 0.2],
    ] as const,
    r[4],
  );
  let shirt = main;
  let sleeves = main;
  let wear = 0;
  if (top === 'jacket') {
    wear |= WEAR.jacket;
    sleeves = bright ? main : pick(STREET_OUTER, r[5]);
    shirt = pick(STREET_INNER, r[6]);
  } else if (top === 'tee') sleeves = skin;
  const head = top === 'hoodie' && r[3] < 0.4 ? WEAR.hood : weigh(STREET_HEADS, r[3]);
  const legs = weigh(
    [
      [DENIM, 0.45],
      [CHINOS, 0.3],
      [TROUSERS, 0.25],
    ] as const,
    r[8],
  );
  return {
    skin,
    hair: pick(HAIR, r[1]),
    shirt,
    sleeves,
    pants: pick(legs, r[9]),
    shoes: pick(STREET_SHOES, r[10]),
    cap: pick(STREET_CAPS, r[11]),
    wear: wear | head | weigh(STREET_HAIR, r[2]) | (r[12] < 0.12 ? WEAR.backpack : 0),
  };
}

/** The shop floor's outfits (the crew asks for each by name; a roll picks one otherwise). */
export type ShopKind = 'coveralls' | 'workShirt' | 'toolBelt' | 'hoodie' | 'jumpsuit' | 'tee';
const SHOP_KINDS: readonly (readonly [ShopKind, number])[] = [
  ['coveralls', 0.22],
  ['workShirt', 0.26],
  ['toolBelt', 0.14],
  ['hoodie', 0.12],
  ['jumpsuit', 0.14],
  ['tee', 0.12],
];
const SHOP_HEADS = [
  [0, 0.25],
  [WEAR.backcap, 0.3],
  [WEAR.beanie, 0.18],
  [WEAR.bandana, 0.12],
  [WEAR.cap, 0.15],
] as const;
const SHOP_HAIR = [
  [0, 0.28],
  [WEAR.hair, 0.45],
  [WEAR.long, 0.15],
  [WEAR.big, 0.12],
] as const;

/**
 * Someone on the shop floor, as `kind` or by a roll: coveralls rolled down and tied at the waist over a tank (the
 * Vince look), a work shirt with a name patch and the sleeves rolled, a tank with a tool belt and black cargos (the
 * Dom look), a hoodie, full coveralls, a tee; boots on most, gloves and a rag on some, a backwards cap, a beanie or a
 * bandana, the stripe rare. Clothes drift toward oil by a grime roll. Fourteen rolls.
 */
export function shopLook(rnd: () => number, kind?: ShopKind): PersonLook {
  const r = rolls(rnd, 14);
  const skin: number = pick(SKIN, r[0] ** 1.2);
  const k = kind ?? weigh(SHOP_KINDS, r[4]);
  const grime = (c: number) => tint(c, OIL, r[13] * 0.3);
  let shirt: number;
  let sleeves: number;
  let pants = pick(SHOP_PANTS, r[7]);
  let wear = 0;
  let boots = r[10] < 0.5;
  if (k === 'coveralls') {
    shirt = pick(TANK, r[6]);
    pants = sleeves = pick(COVERALL, r[5]);
    wear |= WEAR.tank | WEAR.tied;
    boots = true;
  } else if (k === 'workShirt') {
    shirt = pick(WORK_SHIRT, r[5]);
    sleeves = r[6] < 0.6 ? skin : shirt;
    wear |= WEAR.patch | (r[7] < 0.4 ? WEAR.cargo : 0);
  } else if (k === 'toolBelt') {
    shirt = pick(TANK, r[6]);
    sleeves = skin;
    pants = r[7] < 0.6 ? C.black : C.charcoal;
    wear |= WEAR.tank | WEAR.toolbelt | WEAR.cargo;
    boots = true;
  } else if (k === 'hoodie') {
    shirt = sleeves = pick(SHOP_HOODIES, r[5]);
  } else if (k === 'jumpsuit') {
    shirt = sleeves = pants = pick(COVERALL, r[5]);
    wear |= (r[6] < 0.5 ? WEAR.patch : 0) | (r[12] < 0.25 ? WEAR.stripe : 0);
    boots = true;
  } else {
    shirt = pick(SHOP_TEES, r[5]);
    sleeves = skin;
  }
  if (k !== 'jumpsuit' && r[12] < 0.06) wear |= WEAR.stripe;
  return {
    skin,
    hair: pick(HAIR, r[1]),
    shirt: grime(shirt),
    sleeves: sleeves === skin ? skin : grime(sleeves),
    pants: grime(pants),
    shoes: boots ? pick(BOOTS, r[8]) : pick(SHOP_SNEAKERS, r[8]),
    cap: pick(SHOP_CAPS, r[9]),
    wear: wear | weigh(SHOP_HEADS, r[3]) | weigh(SHOP_HAIR, r[2]) | (boots ? WEAR.boots : 0) | (r[11] < 0.35 ? WEAR.gloves : 0) | (r[11] > 0.6 ? WEAR.rag : 0),
  };
}

/** Warm and cool tints the idle people's tops drift toward on a warm or cool seed. */
const WARM_TOP = 0xc8641c;
const COOL_TOP = 0x2a5fa8;

/**
 * Someone idling in the street: the street wardrobe with about 15% of tops shifted toward the seed's mood
 * (`warmth` -1 cool .. 1 warm), so a seed's sidewalks read a touch warmer or cooler than the next (bare arms stay
 * skin). Always draws the same number of rolls.
 */
export function idleLook(rnd: () => number, warmth: number): PersonLook {
  const look = streetLook(rnd);
  const roll = rnd();
  if (roll < 0.15) {
    const to = warmth >= 0 ? WARM_TOP : COOL_TOP;
    const t = 0.35 + 0.4 * Math.abs(warmth);
    const same = look.sleeves === look.shirt;
    look.shirt = tint(look.shirt, to, t);
    look.sleeves = same ? look.shirt : look.sleeves === look.skin ? look.skin : tint(look.sleeves, to, t);
  }
  return look;
}
