/**
 * What the sky and the weather tell the water, as uniforms written once per frame by the scene (scene.ts, after the
 * weather updated) and read by every water material and every moored boat (districts/water.ts, boats.ts, the ferry):
 * the scene clock, the moon's direction and how much of it shows, the wind's heading, the rain's share. The same
 * pattern as the wind's sway (wind.ts) and the height fog's uniforms (heightFog.ts): one `{ value }` object per channel
 * that the materials hold, so one write reaches all of them and the weather needs no list of who is listening. The
 * wind's strength itself is `WIND.sway` (gusts included); `windAmount` below maps it to 0..1 for the water.
 */
import * as THREE from 'three';
import { clamp01, smoothstep } from '../../sim/math';
import { WIND } from './wind';

/** The moon's glint on the water: how its phase scales the glint (a thin crescent still glints at `phaseFloor` of a full moon's). */
export const MOON_GLINT = {
  phaseFloor: 0.28,
} as const;

/** The shared uniforms. Everything is a pure function of the scene clock and the weather's blend, so it never depends on the frame rate. */
export const WATER_SKY = {
  /** The scene clock (s): the normal maps' scroll, the swell the boats ride, the ferry's wake. */
  time: { value: 0 as number },
  /** The unit direction toward the moon (the backdrop's `moonDirection()`). */
  moonDir: { value: new THREE.Vector3(0, 1, 0) },
  /** How much of the moon shows 0..1: the mood's moon, the cloud veil over it and its phase. 0 on rain nights. */
  moon: { value: 0 as number },
  /** The wind's heading as a unit vector on the ground (x, z): the way the ripples travel. */
  heading: { value: new THREE.Vector2(1, 0) },
  /** The wind, 0 (a still night) to 1 (the crest of a rain gust): `WIND.sway` mapped by `WATER.wind` in water.ts. */
  wind: { value: 0 as number },
  /** The rain's share 0..1 (RainDef.share of the blended mood): how many drops make rings. */
  rain: { value: 0 as number },
};

/** The wind sway range that maps to 0..1 of `WATER_SKY.wind`: calm night air (sway 1) is a glassy surface, a rain gust (about 3.4) is a chop. */
export const WIND_RANGE = { calm: 0.95, gale: 2.8 } as const;

/** The wind as the water feels it, 0..1, from the trees' sway multiplier. */
export function windAmount(sway: number): number {
  return smoothstep(WIND_RANGE.calm, WIND_RANGE.gale, sway);
}

/** The slice of the weather the water reads (weather.ts `Weather`). */
interface WaterWeather {
  live: { moon: number; veil: number; rain: number };
  moonPhase: number;
  windHeading: number;
}

/**
 * Write the shared uniforms for this frame. `moonDir` is the backdrop's moon direction, `time` the scene clock (s).
 * The moon's glint is the mood's moon times the cloud veil over it times its phase (a new moon throws almost none).
 */
export function driveWaterSky(w: WaterWeather, moonDir: readonly number[], time: number): void {
  WATER_SKY.time.value = time;
  WATER_SKY.moonDir.value.set(moonDir[0], moonDir[1], moonDir[2]);
  const illum = 0.5 - 0.5 * Math.cos(w.moonPhase * Math.PI * 2);
  WATER_SKY.moon.value = clamp01(w.live.moon) * clamp01(w.live.veil) * (MOON_GLINT.phaseFloor + (1 - MOON_GLINT.phaseFloor) * illum);
  WATER_SKY.heading.value.set(Math.cos(w.windHeading), Math.sin(w.windHeading));
  WATER_SKY.wind.value = windAmount(WIND.sway.value);
  WATER_SKY.rain.value = clamp01(w.live.rain);
}
