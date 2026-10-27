/**
 * The wardrobe every person in the game dresses from, so the crowds, the
 * garage crew and the driver read as one city: eight skin tones, hair, and
 * clothes per context (the shop's work shirts, the street's hoodies, jackets
 * and tees, a team's colors for the driver). A look is picked with a `rnd`
 * in 0..1 the caller owns (a seeded Rng for the crowds, so a seed's crowd
 * dresses the same every race). Render only.
 */
import { WEAR } from './person';
import type { PersonLook } from './person';

/** Skin tones, light to dark. */
export const SKIN = [0xf0c8a8, 0xe0b394, 0xd8a37f, 0xc68e6a, 0xa8714e, 0x8a5a3c, 0x5e3a26, 0x3d2416] as const;
/** Hair: black, browns, a blond, a red, a grey. */
export const HAIR = [0x101012, 0x1f1612, 0x2a1e14, 0x5a3a1e, 0x8a5a2a, 0xb08a50, 0x7a2a16, 0x8d8d90] as const;

/** Street clothes: [shirt, sleeves] pairs (a hoodie's body and hood, a jacket over a tee, or one color), trousers, shoes. */
const STREET_TOPS: [number, number][] = [
  [0x1b1d24, 0x1b1d24],
  [0x2a2f3a, 0x2a2f3a],
  [0x8a1424, 0x8a1424],
  [0x1f3f8a, 0x1f3f8a],
  [0xd8d8d8, 0xd8d8d8],
  [0x121212, 0x121212],
  [0x3a5a2a, 0x3a5a2a],
  [0xc9a227, 0x121212],
  [0x6b2fc2, 0x6b2fc2],
  [0xff2d7a, 0x1b1d24],
  [0x2de2ff, 0x1b1d24],
  [0xff6a00, 0x121212],
  [0x7a7f8a, 0x2a2f3a],
  [0x0f3a3a, 0x0f3a3a],
  [0x5a1a4a, 0x5a1a4a],
  [0x1b1d24, 0xd8d8d8],
  [0x121212, 0xff6a00],
  [0x2a2f3a, 0x2de2ff],
];
const STREET_PANTS = [0x0c0e14, 0x14182a, 0x1c2233, 0x22252b, 0x2b3a5c, 0x3a3426, 0x101012, 0x44474f] as const;
const STREET_SHOES = [0xd8d8d4, 0x101012, 0x2a1e14, 0xf2efe8, 0x1c2a44, 0xb3121e, 0x3a3d44] as const;

/** Shop clothes: dark work shirts, with the stripe most of the time. */
const SHOP_SHIRTS = [0x1c2a44, 0x2f4f8a, 0x3a3d44, 0x5a5e66, 0x6b2a1c, 0x1f3f3a, 0x8a6a2a] as const;
const SHOP_PANTS = [0x22252b, 0x1c2233, 0x3a3426, 0x6b5a3e, 0x2b3a5c] as const;
const SHOP_SHOES = [0x1a1410, 0x101012, 0x2a1e14, 0xd8d8d4] as const;
const CAPS = [0x9a1b25, 0x1d4f9a, 0x101012, 0xc8541c, 0x2a2f3a, 0x3a5a2a] as const;

const pick = <T,>(list: readonly T[], r: number): T => list[Math.min(list.length - 1, Math.floor(r * list.length))];

/** What the head wears, by one roll: hair most of the time, then caps, beanies and hoods in the shares given. */
function head(r: number, cap: number, beanie: number, hood: number): number {
  return r < cap ? WEAR.cap : r < cap + beanie ? WEAR.beanie : r < cap + beanie + hood ? WEAR.hood : WEAR.hair;
}

/** Someone on the street at night: a hoodie or a jacket, a few in bright colors, some with a cap or the hood up. */
export function streetLook(rnd: () => number): PersonLook {
  const [shirt, sleeves] = pick(STREET_TOPS, rnd());
  return {
    skin: pick(SKIN, rnd() ** 1.2),
    hair: pick(HAIR, rnd()),
    shirt,
    sleeves,
    pants: pick(STREET_PANTS, rnd()),
    shoes: pick(STREET_SHOES, rnd()),
    cap: pick(CAPS, rnd()),
    wear: head(rnd(), 0.18, 0.12, 0.14),
  };
}

/** Someone on the shop floor: a work shirt and trousers, the hi-vis stripe, gloves, a cap or a beanie on most. */
export function shopLook(rnd: () => number): PersonLook {
  const shirt = pick(SHOP_SHIRTS, rnd());
  return {
    skin: pick(SKIN, rnd() ** 1.2),
    hair: pick(HAIR, rnd()),
    shirt,
    sleeves: rnd() < 0.3 ? pick(SHOP_SHIRTS, rnd()) : shirt,
    pants: pick(SHOP_PANTS, rnd()),
    shoes: pick(SHOP_SHOES, rnd()),
    cap: pick(CAPS, rnd()),
    wear: head(rnd(), 0.4, 0.2, 0) | (rnd() < 0.75 ? WEAR.stripe : 0) | (rnd() < 0.5 ? WEAR.gloves : 0),
  };
}

/** Warm and cool tints the idle people's tops drift toward on a warm or cool seed. */
const WARM_TOP = 0xc8641c;
const COOL_TOP = 0x2a5fa8;

/** Halfway from a hex color to another (sRGB channels, as the wardrobe is written). */
function tint(from: number, to: number, t: number): number {
  const ch = (shift: number) => Math.round(((from >> shift) & 255) * (1 - t) + ((to >> shift) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/**
 * Someone idling in the street: the street wardrobe with about 15% of tops shifted toward the seed's mood
 * (`warmth` -1 cool .. 1 warm), so a seed's sidewalks read a touch warmer or cooler than the next. Always
 * draws the same number of rolls.
 */
export function idleLook(rnd: () => number, warmth: number): PersonLook {
  const look = streetLook(rnd);
  const roll = rnd();
  if (roll < 0.15) {
    const to = warmth >= 0 ? WARM_TOP : COOL_TOP;
    const t = 0.35 + 0.4 * Math.abs(warmth);
    const same = look.sleeves === look.shirt;
    look.shirt = tint(look.shirt, to, t);
    look.sleeves = same ? look.shirt : tint(look.sleeves, to, t);
  }
  return look;
}
