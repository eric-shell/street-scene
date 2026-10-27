/**
 * A seed's city identity: the one choice the rest of the look hangs on, so a seed reads as "a Miami night" or
 * "a Philly night" from a single frame instead of as five independent coin flips. Before this, the building
 * regions, the lamp colours, the neon palette, the weather and the sky glow each rolled their own stream and a
 * city was whatever the dice summed to; now `cityIdentity(seed)` names a home neighbourhood and every one of
 * those reads it:
 *  - architecture.ts weights the home region up and the others down, so the home is most of the city and the
 *    other four are pockets (every region still shows up somewhere);
 *  - lampStyle.ts keeps the home's post design and lamp colour fixed and lets the per-seed twist reach only
 *    the other regions, and only a home that allows it goes city-wide (all-sodium New York, an LED San Francisco);
 *  - cityMood.ts picks the seed's neon family among the home's favoured ones;
 *  - weather.ts multiplies the mood weights (misty San Francisco, wet Philadelphia, clear Los Angeles), with the
 *    multipliers balanced so the five homes together still draw roughly the base weights;
 *  - the fog and the sky's horizon glow lean toward the home's light pollution hue (luminance kept, so a mood's
 *    darkness is its own and moods still differ);
 *  - post.ts grades the frame with the home's lift, gamma, gain, split toning, saturation and grain;
 *  - routeNearness.ts sets how hard the race route stands out as the main drag (denser, brighter dressing on it).
 * Art direction is "sodium and neon": the city warm, grimy and lived in, the race layer (cyan barriers, amber
 * hazards, neon) cold and electric. The grade protects saturated colour, so it falls on the city, not on them.
 *
 * Pure and seed-only (no World), so the menu city and the race of one seed agree, and render only: nothing
 * here reaches the sim, replays never notice.
 */
import { Rng, deriveSeed } from '../sim/prng';
import type { Region } from './buildings/architecture';
import type { LampTone } from './street/lampStyle';
import type { LampDesign } from './street/propGeometry';
import type { NeonFamily } from './textures/cityMood';
import type { MoodId } from './sky/weather';
import type { GradeParams } from './post';

/** Everything one home neighbourhood sets for the city around it. */
export interface HomeProfile {
  /** The home's streetlights: lamp colour and post design (the region defaults every seed starts from). */
  lamps: {
    tone: LampTone;
    design: LampDesign;
    /** The lamp twist may take the home's tone city-wide (every region burns it). */
    citywide: boolean;
  };
  /** Neon hue families the seed picks among (cityMood.ts), in no particular order. */
  neon: readonly NeonFamily[];
  /** Multipliers on each weather mood's base weight (1 = unchanged). */
  weather: Readonly<Record<MoodId, number>>;
  /** The home's light pollution hue (sRGB hex) and how far the fog colour and the sky's horizon glow lean to it (0..1, luminance kept). */
  tint: { hue: number; fog: number; glow: number };
  /** The colour grade (post.ts FxShader). */
  grade: GradeParams;
  /**
   * How loud the main drag reads against the side streets (street/routeNearness.ts): 1 applies the DRAG knobs as
   * written, 0 would make every street alike. Miami and New York shout, San Francisco and Philadelphia only lean.
   */
  drag: number;
}

/**
 * The five homes. Weather multipliers average to about 1 per mood across the five (the aggregate stays within
 * 10% of the base weights, tests/weather.test.ts), and clear stays the most common mood in every home but San
 * Francisco, where it ties with mist. Grades are small on purpose: lift is a few ten-thousandths of linear light
 * (black stays black), tints are luminance neutral and pull 8-30%, saturation only reaches dull colours. Gamma
 * sits a little above 1 and gain a little below it in every home: a night frame is mostly lamp pools, the road's
 * sodium glow and bloom stacked on lifted shadows, and a lift alone (the first pass) made the shadows a haze.
 * The contrast curve deepens the mid-shadows instead (frames measured A/B against no grade: mean luma -5% to
 * -10%, black pixels up, lit windows and neon untouched), and the tints carry each home's colour in those
 * mid-shadows. Miami, the most hazy, takes the most (gamma about 1.1, gain 0.93-0.96).
 */
export const HOME_PROFILES = {
  /** Sodium cobra heads, amber-red or magenta-cyan neon, haze and drizzle; warm shadows, faintly teal highlights. */
  nyc: {
    lamps: { tone: 'sodium', design: 'cobra', citywide: true },
    neon: ['amber-red', 'magenta-cyan'],
    weather: { clear: 0.85, hazy: 1.35, misty: 0.8, drizzle: 1.5, rain: 0.9 },
    tint: { hue: 0xff9a4a, fog: 0.3, glow: 0.5 },
    grade: {
      lift: [0.0006, 0.0004, 0.0002],
      gamma: [1.04, 1.06, 1.08],
      gain: [1, 0.98, 0.96],
      shadow: 0xff9a5a,
      shadowAmount: 0.26,
      highlight: 0x7fd6d0,
      highlightAmount: 0.1,
      saturation: 0.94,
      grain: 0.06,
    },
    drag: 1.2,
  },
  /** Warm white modern lamps, pastel magenta-cyan neon, clear or hazy; lifted violet shadows, warm highlights. */
  la: {
    lamps: { tone: 'warm', design: 'modern', citywide: false },
    neon: ['magenta-cyan', 'green-violet'],
    weather: { clear: 1.3, hazy: 1.3, misty: 0.6, drizzle: 0.5, rain: 0.4 },
    tint: { hue: 0xb07ad8, fog: 0.3, glow: 0.4 },
    grade: {
      lift: [0.0007, 0.0003, 0.001],
      gamma: [1.04, 1.06, 1.03],
      gain: [1.02, 0.98, 0.95],
      shadow: 0xa070ff,
      shadowAmount: 0.24,
      highlight: 0xffc080,
      highlightAmount: 0.12,
      saturation: 0.98,
      grain: 0.04,
    },
    drag: 1,
  },
  /** Cool white historic lamps (an LED city when the twist goes city-wide), white-blue neon, mist; a cool grade. */
  sf: {
    lamps: { tone: 'cool', design: 'historic', citywide: true },
    neon: ['white-blue', 'green-violet'],
    weather: { clear: 0.8, hazy: 0.85, misty: 2.4, drizzle: 1, rain: 0.7 },
    tint: { hue: 0x8aa6d0, fog: 0.35, glow: 0.5 },
    grade: {
      lift: [0.0002, 0.0004, 0.0008],
      gamma: [1.08, 1.06, 1.03],
      gain: [0.95, 0.98, 1.02],
      shadow: 0x6f9cff,
      shadowAmount: 0.24,
      highlight: 0xd8ecff,
      highlightAmount: 0.08,
      saturation: 0.92,
      grain: 0.05,
    },
    drag: 0.7,
  },
  /** Sodium historic lamps, amber-red neon, drizzle and rain; green-amber grit, the grainiest and least saturated. */
  philly: {
    lamps: { tone: 'sodium', design: 'historic', citywide: true },
    neon: ['amber-red', 'all-night'],
    weather: { clear: 0.8, hazy: 0.75, misty: 0.8, drizzle: 1.6, rain: 1.9 },
    tint: { hue: 0xc8a050, fog: 0.3, glow: 0.45 },
    grade: {
      lift: [0.0004, 0.0006, 0.0002],
      gamma: [1.06, 1.04, 1.09],
      gain: [1.01, 0.99, 0.93],
      shadow: 0x7fa070,
      shadowAmount: 0.26,
      highlight: 0xffb050,
      highlightAmount: 0.16,
      saturation: 0.88,
      grain: 0.09,
    },
    drag: 0.75,
  },
  /** Warm white modern lamps, pastel magenta-cyan neon, haze or clear; pink in the mid-shadows only (almost no lift), teal highlights, a touch more colour. */
  miami: {
    lamps: { tone: 'warm', design: 'modern', citywide: false },
    neon: ['magenta-cyan', 'white-blue'],
    weather: { clear: 1.2, hazy: 1.35, misty: 0.4, drizzle: 0.5, rain: 1 },
    tint: { hue: 0xff6aa8, fog: 0.25, glow: 0.5 },
    grade: {
      lift: [0.0005, 0.0002, 0.0005],
      gamma: [1.1, 1.12, 1.1],
      gain: [0.95, 0.93, 0.96],
      shadow: 0xff70b0,
      shadowAmount: 0.28,
      highlight: 0x60e0d8,
      highlightAmount: 0.14,
      saturation: 1.06,
      grain: 0.03,
    },
    drag: 1.3,
  },
} as const satisfies Record<Region, HomeProfile>;

const HOMES: readonly Region[] = ['nyc', 'la', 'sf', 'philly', 'miami'];

export interface CityIdentity extends HomeProfile {
  /** The dominant neighbourhood: most of the buildings, the lamps everywhere it reaches, the neon, weather and grade. */
  home: Region;
}

const identities = new Map<number, CityIdentity>();

/** The seed's identity, from `deriveSeed(seed, 'identity')`: the home is an even pick of the five. */
export function cityIdentity(seed: number): CityIdentity {
  let id = identities.get(seed);
  if (!id) {
    const home = new Rng(deriveSeed(seed, 'identity')).pick(HOMES);
    id = { home, ...HOME_PROFILES[home] };
    if (identities.size > 8) identities.clear();
    identities.set(seed, id);
  }
  return id;
}
