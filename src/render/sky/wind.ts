/**
 * The wind the scene's swaying things share, as uniforms written once per frame by the weather (weather.ts) from
 * the seed's mood and the gust function of the scene clock (weatherTimeline.ts). One `{ value }` object per
 * channel, referenced by every material that moves in the wind, so a single write reaches all of them and the
 * weather needs no list of who is listening (the same pattern as the height fog's uniforms in heightFog.ts).
 * Starts at 1, the still-air sway the trees always had.
 */
export const WIND = {
  /** Multiplies how far trees lean and rustle: 1 the calm night, up to about 3.4 at the crest of a rain gust. */
  sway: { value: 1 as number },
};
