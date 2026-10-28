/**
 * Weather and mood, one per seed and render only (the sim never knows, so
 * replays stay valid): a weighted pick among clear, hazy, misty, drizzle and
 * rain nights. The mood sets the fog (colour and density, also pushed into
 * every material that fogs itself in a shader, plus the height fog's gain: render/heightFog.ts), the sky dome, the hemisphere
 * and moon light, how wet the streets read (environment reflections), how many
 * stars show and how the moon looks, plus three particle layers:
 *  - rain: one instanced mesh of short streaks wrapped in a box around the
 *    camera, animated entirely in the vertex shader from the clock (the drops
 *    stay fixed in world space as the camera moves, so driving through them
 *    reads right). Each streak is a drop's motion blur: its length follows the
 *    drop's speed relative to the camera, so rain streaks longer the faster
 *    the car goes, leaning with the wind. Drizzle is the same layer, sparse
 *    and nearly invisible except where the headlights would catch it;
 *  - splashes: a few short lived rings on the road right around the camera;
 *  - mist (High only): a low layer draped over the terrain around the camera,
 *    two scrolling noise octaves for the wisps, faded close to the lens;
 *  - lightning on rain nights (lightning.ts): soft flashes of the sky, the
 *    lights and the rain, a bolt beyond the skyline and thunder after it.
 * The night turns (weatherTimeline.ts): about a third of seeds step once to a neighbouring mood during the
 * first minutes, and every parameter above is blended between the two moods as a pure function of the seed and
 * the scene clock, so a replay turns the same way. The blend is pushed in two rates: what costs more than a
 * uniform write (the fog colour and density into every self-fogging shader, the lights, the sky crossfade, the
 * height fog) when the blend has moved a step, and the per-frame bits (rain drift and lean, gusts, the clouds
 * crossing the moon) every frame. The rain pool is allocated for the wetter of the two moods and thinned by
 * the live share. Lightning waits until the night is mostly rain.
 * Clear stays the most common mood: the neon night is the default look. The
 * seed's home neighbourhood (cityIdentity.ts) multiplies the weights (misty
 * San Francisco, wet Philadelphia) and leans the fog and the sky's horizon
 * glow toward its light pollution hue at the mood's own luminance, so the
 * moods still differ and the city still reads as its home.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { Rng, deriveSeed } from '../../sim/prng';
import { lerp } from '../../sim/math';
import type { Quality } from '../../ui/settings';
import type { NightLighting } from '../lighting';
import { FOG_HEIGHT, lowestGround, setHeightFog } from '../heightFog';
import { makeMoodSky, makeNoiseTexture, MoodSkyParams } from './skyTextures';
import { LIGHTNING, Lightning, buildLightning } from './lightning';
import { cityIdentity } from '../cityIdentity';
import { CumulativeIntegral, MoodBlend, WEATHER_TURN, WeatherTimeline, gustAt, moonVeil, weatherTimeline } from './weatherTimeline';
import { WIND } from './wind';

export type MoodId = 'clear' | 'hazy' | 'misty' | 'drizzle' | 'rain';

export interface RainDef {
  /** Share of the quality tier's streak pool in the air. */
  share: number;
  /** Fall speed (m/s), wind (m/s), streak opacity, extra brightness where the headlights would catch the drops. */
  fall: number;
  wind: number;
  alpha: number;
  headlight: number;
  /** Share of the splash pool on the road. */
  splash: number;
}

export interface MoodDef {
  /** Relative chance per seed. */
  weight: number;
  fogColor: number;
  fogDensity: number;
  /** Height fog pool: how many times the fog exponent at the world's lowest ground is the street's (heightFog.ts setHeightFog); omitted = `FOG_HEIGHT.pool`. Deeper on damp nights. */
  heightPool?: number;
  sky: MoodSkyParams;
  /** Star field 0..1, moon disc 0..1 and the haze halo around it 0..1. */
  stars: number;
  moon: number;
  halo: number;
  /** How wet the streets read 0..1 (lifts the environment reflections). */
  wet: number;
  rain: RainDef | null;
  /** Ground mist strength 0..1 (drawn at High). */
  mist: number;
  /** Hemisphere sky colour and intensity, moon light intensity. */
  hemi: number;
  hemiIntensity: number;
  moonLight: number;
}

export const MOODS: Record<MoodId, MoodDef> = {
  clear: {
    weight: 42,
    fogColor: 0x0a0b1c,
    fogDensity: 0.0042,
    sky: { zenith: '#010208', mid: '#080a1f', horizon: '#24143a', below: '#120c1e', glow: '#6a3a2e', glowStrength: 0.45, overcast: 0 },
    stars: 1,
    moon: 1,
    halo: 0,
    wet: 0,
    rain: null,
    mist: 0,
    hemi: 0x3a4a9a,
    hemiIntensity: 0.4,
    moonLight: 0.35,
  },
  hazy: {
    weight: 22,
    fogColor: 0x12101f,
    fogDensity: 0.0052,
    heightPool: 2.8,
    sky: { zenith: '#03030c', mid: '#0d0b22', horizon: '#2c1b3e', below: '#17111f', glow: '#7c4634', glowStrength: 0.75, overcast: 0.25 },
    stars: 0.45,
    moon: 0.85,
    halo: 0.6,
    wet: 0.15,
    rain: null,
    mist: 0.2,
    hemi: 0x3f4690,
    hemiIntensity: 0.42,
    moonLight: 0.28,
  },
  misty: {
    weight: 14,
    fogColor: 0x0e1020,
    fogDensity: 0.0066,
    heightPool: 3,
    sky: { zenith: '#04050e', mid: '#0b0d20', horizon: '#1e1830', below: '#111020', glow: '#5c3a36', glowStrength: 0.6, overcast: 0.5 },
    stars: 0.12,
    moon: 0.4,
    halo: 1,
    wet: 0.35,
    rain: null,
    mist: 1,
    hemi: 0x3a4890,
    hemiIntensity: 0.45,
    moonLight: 0.2,
  },
  drizzle: {
    weight: 12,
    fogColor: 0x0b0d1a,
    fogDensity: 0.0058,
    heightPool: 2.9,
    sky: { zenith: '#030309', mid: '#090b1c', horizon: '#121020', below: '#0d0b16', glow: '#5a3630', glowStrength: 0.6, overcast: 0.8 },
    stars: 0,
    moon: 0.15,
    halo: 0.8,
    wet: 0.7,
    rain: { share: 0.55, fall: 5.5, wind: 1.4, alpha: 0.055, headlight: 2.2, splash: 0.25 },
    mist: 0.3,
    hemi: 0x36408a,
    hemiIntensity: 0.4,
    moonLight: 0.15,
  },
  rain: {
    weight: 10,
    fogColor: 0x090b16,
    fogDensity: 0.0068,
    sky: { zenith: '#020208', mid: '#07091a', horizon: '#110f1e', below: '#0a0915', glow: '#5e3a2e', glowStrength: 0.7, overcast: 1 },
    stars: 0,
    moon: 0,
    halo: 0,
    wet: 1,
    rain: { share: 1, fall: 9.5, wind: 2.5, alpha: 0.14, headlight: 0.8, splash: 1 },
    mist: 0,
    hemi: 0x323c86,
    hemiIntensity: 0.38,
    moonLight: 0.08,
  },
};

export const MOOD_IDS = Object.keys(MOODS) as MoodId[];

/** Rain pools per quality tier (Low draws none) and the wrap box around the camera (m). */
export const WEATHER = {
  pool: { low: 0, medium: 2600, high: 4000 } as Record<Quality, number>,
  splashPool: { low: 0, medium: 40, high: 80 } as Record<Quality, number>,
  box: { x: 26, y: 15, z: 26 },
  /** The box reaches this far below the camera (the rest is above, where drops come from). */
  below: 4,
  /** Streak width (m) and the "shutter" (s) a drop's motion blurs over: length = relative speed x shutter. */
  streakWidth: 0.012,
  shutter: 0.013,
  /** Splashes: spawn radius around the camera (m), life (s), final ring radius (m). */
  splashRadius: 11,
  splashLife: 0.22,
  splashSize: 0.32,
  /** Mist layer: size (m), grid, height above the ground (m), re-centred after the camera moves this far (m). */
  mistSize: 220,
  mistGrid: 24,
  mistLift: 0.6,
  mistRecentre: 12,
  /** Environment reflection intensity for dry streets and the extra when soaked. */
  envDry: 0.55,
  envWet: 0.3,
} as const;

/** The mood of a seed: a draw from its own random stream, the base weights times its home's multipliers. */
export function pickMood(seed: number): MoodId {
  const rng = new Rng(deriveSeed(seed, 'weather'));
  const k = cityIdentity(seed).weather;
  let total = 0;
  for (const id of MOOD_IDS) total += MOODS[id].weight * k[id];
  let r = rng.next() * total;
  for (const id of MOOD_IDS) {
    r -= MOODS[id].weight * k[id];
    if (r < 0) return id;
  }
  return 'clear';
}

/** `base` (sRGB hex) leaned toward `hue` by `k` (0..1) with base's own luminance kept, so a tint moves the colour, never how dark it is. */
function leanToward(base: THREE.ColorRepresentation, hue: number, k: number): THREE.Color {
  const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const b = new THREE.Color(base);
  const h = new THREE.Color(hue);
  h.multiplyScalar(lum(b) / Math.max(1e-6, lum(h)));
  return b.lerp(h, k);
}

/** A mood as the seed shows it: the fog colour and the sky's horizon glow leaned toward the home's tint (built once per scene). */
function seedMood(seed: number, mood: MoodId): MoodDef {
  const base = MOODS[mood];
  const { tint } = cityIdentity(seed);
  return {
    ...base,
    fogColor: leanToward(base.fogColor, tint.hue, tint.fog).getHex(),
    sky: { ...base.sky, glow: `#${leanToward(base.sky.glow, tint.hue, tint.glow).getHexString()}` },
  };
}

/** Moon phase 0..1 (0 new, 0.5 full) and the wind heading (rad) of a seed. */
export function skyParams(seed: number): { moonPhase: number; windHeading: number } {
  const rng = new Rng(deriveSeed(seed, 'sky'));
  // Mostly a visible moon: thin crescents and new moons are rare.
  const moonPhase = 0.18 + rng.next() * 0.64;
  return { moonPhase, windHeading: rng.range(0, Math.PI * 2) };
}

const rainVert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 aSeed;
  attribute float aVar;
  uniform vec3 uDrift;
  uniform vec3 uBox;
  uniform vec3 uHalf;
  uniform vec3 uVel;
  uniform vec3 uCamVel;
  uniform vec3 uCamFwd;
  uniform float uShutter;
  uniform float uWidth;
  uniform float uPixel;
  uniform float uHeadlight;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    // Drops fall through world space; wrapping them into the box around the camera keeps the
    // nearby ones in view without ever moving them with the camera.
    // The wind and the fall speed change with the weather, so the drops sit where the integral of their velocity
    // puts them (uDrift) rather than at velocity x time, which would jump whenever the velocity moved.
    vec3 p = aSeed * uBox + uDrift;
    vec3 origin = cameraPosition - uHalf;
    vec3 rel = p - origin;
    rel -= floor(rel / uBox) * uBox;
    vec3 head = origin + rel;
    // The streak is the drop's motion blur relative to the camera: fast driving stretches it.
    vec3 relVel = uVel - uCamVel;
    float speed = max(length(relVel), 0.01);
    vec3 d = relVel / speed;
    float len = speed * uShutter * (0.7 + 0.6 * aVar);
    vec3 toCam = head - cameraPosition;
    float dist = max(length(toCam), 0.01);
    vec3 view = toCam / dist;
    vec3 side = normalize(cross(view, d) + vec3(1e-4, 0.0, 0.0));
    // Never thinner than about a pixel, so distant drops do not flicker in and out.
    float width = max(uWidth * (0.7 + 0.6 * aVar), uPixel * dist * 1.1);
    vec3 pos = head + d * (corner.y - 1.0) * len + side * corner.x * width;
    float fade = smoothstep(0.25, 1.0, dist) * (1.0 - smoothstep(uBox.x * 0.28, uBox.x * 0.5, dist));
    // Drops ahead and below the camera, where the headlights would catch them, light up.
    float ahead = max(0.0, dot(view, uCamFwd));
    float low = 1.0 - smoothstep(-0.5, 1.5, head.y - cameraPosition.y);
    vFade = fade * (1.0 + uHeadlight * pow(ahead, 6.0) * low);
    vUv = corner;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const rainFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    float across = 1.0 - 4.0 * vUv.x * vUv.x;
    float along = smoothstep(0.0, 0.35, vUv.y);
    gl_FragColor = vec4(uColor, uAlpha * vFade * across * along);
  }
`;

const splashVert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 aPos;
  attribute vec2 aBirth; // birth time (s), seed
  uniform float uTime;
  uniform float uLife;
  uniform float uSize;
  varying vec2 vUv;
  varying float vAge;
  void main() {
    float age = (uTime - aBirth.x) / uLife;
    vAge = age;
    float r = (age < 0.0 || age > 1.0) ? 0.0 : uSize * (0.15 + 0.85 * age) * (0.7 + 0.6 * aBirth.y);
    vec3 pos = aPos + vec3(corner.x * r, 0.0, corner.y * r);
    vUv = corner;
    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
  }
`;

const splashFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vAge;
  void main() {
    float r = length(vUv) * 2.0;
    // A thin ring that opens out and fades, with a dot in the middle at first.
    float ring = smoothstep(0.55, 0.85, r) * (1.0 - smoothstep(0.85, 1.0, r));
    float dot_ = (1.0 - smoothstep(0.0, 0.3, r)) * (1.0 - vAge);
    float a = (ring + dot_) * (1.0 - vAge) * uAlpha;
    gl_FragColor = vec4(uColor, a);
  }
`;

const mistVert = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = position;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const mistFrag = /* glsl */ `
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uStrength;
  uniform vec2 uWind;
  varying vec3 vWorld;
  void main() {
    // Wisps stretched along the wind, drifting with it, in two sizes.
    vec2 along = vec2(uWind.x, uWind.y);
    vec2 across = vec2(-uWind.y, uWind.x);
    vec2 q = vec2(dot(vWorld.xz, along) * 0.014, dot(vWorld.xz, across) * 0.04) + vec2(uTime * 0.02, 0.0);
    float n1 = texture2D(uNoise, q).r;
    float n2 = texture2D(uNoise, vWorld.xz * 0.075 + vec2(uTime * 0.03, -uTime * 0.012)).r;
    float wisp = smoothstep(0.32, 0.95, n1 * 0.7 + n2 * 0.45);
    float d = distance(vWorld, cameraPosition);
    // Nothing on the lens, full between the near street corners and the next block, gone with distance.
    float fade = smoothstep(4.0, 20.0, d) * (1.0 - smoothstep(80.0, 130.0, d));
    gl_FragColor = vec4(uColor * (uStrength * wisp * fade), 1.0);
  }
`;

/** A unit quad as an instanced geometry: corner (-0.5..0.5 across, 0..1 along for rain). */
function quadGeometry(corners: number[]): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('corner', new THREE.Float32BufferAttribute(corners, 2));
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
}

/** The weather as it is right now (blended between the two moods of the turn), read by the scene each frame. */
export interface LiveWeather {
  /** How far the night has turned, 0 (the opening mood) to 1 (the turn's mood); 0 on a seed that never turns. */
  turn: number;
  /** Base fog density: what exposure.ts scales for tunnels (the scene's fog density is that times the zone's multiplier). */
  density: number;
  fogColor: THREE.Color;
  /** Star field, moon disc and halo 0..1, and how much of the moon shows through drifting cloud (1 clear). */
  stars: number;
  moon: number;
  halo: number;
  veil: number;
  /** How wet the streets read 0..1, and the sky's overcast 0..1. */
  wet: number;
  overcast: number;
  /** The current gust factor (1 steady, up to about 2) and the trees' lean multiplier (WIND.sway). */
  gust: number;
  sway: number;
  /** The rain's share 0..1 of the blended mood (0 on a dry night), for the rings on standing water. */
  rain: number;
}

/** The turn's second sky as a dome around the camera: the same equirectangular lookup as the background, faded in over it. */
const skyOverlayVert = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyOverlayFrag = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uAlpha;
  uniform float uIntensity;
  varying vec3 vDir;
  void main() {
    // The equirectangular lookup three.js's own background uses.
    vec3 d = normalize(vDir);
    vec2 uv = vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5);
    gl_FragColor = vec4(texture2D(uMap, uv).rgb * uIntensity, uAlpha);
    #include <colorspace_fragment>
  }
`;

/** The overlay dome's radius (m): beyond the ridges (1950), inside every camera's far plane like the sprites. */
const SKY_OVERLAY_RADIUS = 2040;
/** The blend moves in steps of 1/this when the costlier pushes run (fog into every shader, lights, sky); smaller than any visible step. */
const BLEND_STEPS = 512;

/** How a mood blends into the rain layer: absent rain counts as zero share and borrows the other mood's fall and wind. */
function blendRain(a: RainDef | null, b: RainDef | null, t: number, out: RainDef): void {
  const ra = a ?? b;
  const rb = b ?? a;
  if (!ra || !rb) {
    out.share = out.alpha = out.splash = 0;
    return;
  }
  out.share = lerp(a ? a.share : 0, b ? b.share : 0, t);
  out.alpha = lerp(a ? a.alpha : 0, b ? b.alpha : 0, t);
  out.splash = lerp(a ? a.splash : 0, b ? b.splash : 0, t);
  out.fall = lerp(ra.fall, rb.fall, t);
  out.wind = lerp(ra.wind, rb.wind, t);
  out.headlight = lerp(ra.headlight, rb.headlight, t);
}

export interface Weather {
  /** The seed's mood: where the night starts (the ambience bed, the exposure and the opening look follow it). */
  readonly mood: MoodId;
  /** The opening mood as this seed shows it (fog colour and sky glow tinted by the city identity). */
  readonly def: MoodDef;
  /** When and where the night turns (weatherTimeline.ts). */
  readonly timeline: WeatherTimeline;
  /** The blended weather as of the last `update`. */
  readonly live: LiveWeather;
  /** Moon phase 0..1 and wind heading (rad), shared with the backdrop and the air traffic. */
  readonly moonPhase: number;
  readonly windHeading: number;
  readonly sky: THREE.Texture;
  readonly fog: THREE.FogExp2;
  /** Rain, splash and mist layers (and the lightning on rain nights); add to the scene. */
  readonly group: THREE.Group;
  /** Nights that can be rain (the opening mood or the turn's): the strikes, their flashes and thunder. */
  readonly lightning: Lightning | null;
  /** The blend at scene time `time` (s): `from` and `to` moods and how far across. For anything that listens to the weather (the ambience bed). */
  moodAt(time: number, out?: MoodBlend): MoodBlend;
  /** Fog, background, environment intensity and the lights. */
  apply(scene: THREE.Scene, lighting: NightLighting): void;
  /** Materials that fog themselves (shader uniforms fogDensity / fogColor) get the mood's fog, and follow it as it turns; call once the scene is built. */
  retuneFog(scene: THREE.Scene): void;
  /** Per render: the layers follow the camera, the streaks follow its speed and the pixel size. */
  view(camera: THREE.Camera, viewportHeight: number): void;
  update(time: number): void;
  dispose(): void;
}

export function createWeather(world: World, opts: { quality: Quality; flashes?: () => boolean }): Weather {
  const seed = world.seed;
  const mood = pickMood(seed);
  const def = seedMood(seed, mood);
  const timeline = weatherTimeline(seed, mood);
  const toMood = timeline.turn?.to ?? mood;
  const defTo = toMood === mood ? def : seedMood(seed, toMood);
  const { tint } = cityIdentity(seed);
  // The haze pools in this world's lowest ground and takes the home's light pollution tint.
  const floor = lowestGround(world);
  const { moonPhase, windHeading } = skyParams(seed);
  const sky = makeMoodSky(def.sky, seed);
  // The turn's second sky, crossfaded over the first by a dome (below). It is only ever magnified, so no mipmaps:
  // the seam where the longitude wraps would otherwise pick the smallest mip along a line.
  const skyTo = defTo !== def ? makeMoodSky(defTo.sky, seed) : null;
  if (skyTo) {
    skyTo.generateMipmaps = false;
    skyTo.minFilter = THREE.LinearFilter;
  }
  const fog = new THREE.FogExp2(def.fogColor, def.fogDensity);
  const group = new THREE.Group();
  group.name = 'weather';
  const disposables: { dispose(): void }[] = skyTo ? [sky, skyTo] : [sky];
  const rng = new Rng(deriveSeed(seed, 'rain'));
  const dir = { x: Math.cos(windHeading), z: Math.sin(windHeading) };

  // The blend, and the mood colours it mixes (linear, like the fog's own).
  const blend: MoodBlend = { from: mood, to: toMood, t: 0 };
  const fogA = new THREE.Color(def.fogColor);
  const fogB = new THREE.Color(defTo.fogColor);
  const hemiA = new THREE.Color(def.hemi);
  const hemiB = new THREE.Color(defTo.hemi);
  const hemiNow = new THREE.Color();
  const live: LiveWeather = {
    turn: 0,
    density: def.fogDensity,
    fogColor: fogA.clone(),
    stars: def.stars,
    moon: def.moon,
    halo: def.halo,
    veil: 1,
    wet: def.wet,
    overcast: def.sky.overcast,
    gust: 1,
    sway: WEATHER_TURN.wind[mood].sway,
    rain: def.rain?.share ?? 0,
  };
  const rainNow: RainDef = { share: 0, fall: 0, wind: 0, alpha: 0, headlight: 0, splash: 0 };
  const rainRate: RainDef = { ...rainNow };
  const rateBlend: MoodBlend = { from: mood, to: toMood, t: 0 };
  const gustiness = (t: number): number => lerp(WEATHER_TURN.wind[mood].gusty, WEATHER_TURN.wind[toMood].gusty, t);
  // The rain's displacement is the integral of its velocity: wind (with its gusts) along the heading, fall straight down.
  const windPath = new CumulativeIntegral((t) => {
    timeline.moodAt(t, rateBlend);
    blendRain(def.rain, defTo.rain, rateBlend.t, rainRate);
    return rainRate.wind * gustAt(seed, t, gustiness(rateBlend.t));
  });
  const fallPath = new CumulativeIntegral((t) => {
    timeline.moodAt(t, rateBlend);
    blendRain(def.rain, defTo.rain, rateBlend.t, rainRate);
    return rainRate.fall;
  });

  // ----- Rain: the pool is the wetter of the two moods', the live share decides how much of it falls.
  let rainMat: THREE.ShaderMaterial | null = null;
  let rainGeo: THREE.InstancedBufferGeometry | null = null;
  let rainMesh: THREE.Mesh | null = null;
  const maxShare = Math.max(def.rain?.share ?? 0, defTo.rain?.share ?? 0);
  const pool = Math.round(WEATHER.pool[opts.quality] * maxShare);
  const startRain = def.rain ?? defTo.rain;
  if (startRain && pool > 0) {
    const geo = quadGeometry([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]);
    const seeds = new Float32Array(pool * 3);
    const vars = new Float32Array(pool);
    for (let i = 0; i < pool; i++) {
      seeds[i * 3] = rng.next();
      seeds[i * 3 + 1] = rng.next();
      seeds[i * 3 + 2] = rng.next();
      vars[i] = rng.next();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.setAttribute('aVar', new THREE.InstancedBufferAttribute(vars, 1));
    blendRain(def.rain, defTo.rain, 0, rainNow);
    geo.instanceCount = Math.round((pool * rainNow.share) / maxShare);
    rainGeo = geo;
    rainMat = new THREE.ShaderMaterial({
      vertexShader: rainVert,
      fragmentShader: rainFrag,
      uniforms: {
        uDrift: { value: new THREE.Vector3() },
        uBox: { value: new THREE.Vector3(WEATHER.box.x, WEATHER.box.y, WEATHER.box.z) },
        uHalf: { value: new THREE.Vector3(WEATHER.box.x / 2, WEATHER.below, WEATHER.box.z / 2) },
        uVel: { value: new THREE.Vector3(dir.x * rainNow.wind, -rainNow.fall, dir.z * rainNow.wind) },
        uCamVel: { value: new THREE.Vector3() },
        uCamFwd: { value: new THREE.Vector3(0, 0, 1) },
        uShutter: { value: WEATHER.shutter },
        uWidth: { value: WEATHER.streakWidth },
        uPixel: { value: 0.002 },
        uHeadlight: { value: rainNow.headlight },
        uColor: { value: new THREE.Color(0.5, 0.56, 0.72) },
        uAlpha: { value: rainNow.alpha },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const rain = new THREE.Mesh(geo, rainMat);
    rain.name = 'rain';
    rain.frustumCulled = false;
    rain.renderOrder = 10;
    rain.visible = geo.instanceCount > 0;
    rainMesh = rain;
    group.add(rain);
    disposables.push(geo, rainMat);
  }

  // ----- Splashes: rings on the road around the camera, each respawned where it died.
  let splashMat: THREE.ShaderMaterial | null = null;
  let splashGeo: THREE.InstancedBufferGeometry | null = null;
  let splashMesh: THREE.Mesh | null = null;
  let splashPos: THREE.InstancedBufferAttribute | null = null;
  let splashBirth: THREE.InstancedBufferAttribute | null = null;
  const maxSplash = Math.max(def.rain?.splash ?? 0, defTo.rain?.splash ?? 0);
  const splashes = Math.round(WEATHER.splashPool[opts.quality] * maxSplash);
  if (startRain && splashes > 0) {
    const geo = quadGeometry([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    splashPos = new THREE.InstancedBufferAttribute(new Float32Array(splashes * 3), 3);
    splashBirth = new THREE.InstancedBufferAttribute(new Float32Array(splashes * 2), 2);
    for (let i = 0; i < splashes; i++) splashBirth.setXY(i, -1e6 + i, rng.next());
    splashPos.setUsage(THREE.DynamicDrawUsage);
    splashBirth.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', splashPos);
    geo.setAttribute('aBirth', splashBirth);
    geo.instanceCount = Math.round((splashes * rainNow.splash) / maxSplash);
    splashGeo = geo;
    splashMat = new THREE.ShaderMaterial({
      vertexShader: splashVert,
      fragmentShader: splashFrag,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: WEATHER.splashLife },
        uSize: { value: WEATHER.splashSize },
        uColor: { value: new THREE.Color(0.6, 0.66, 0.8) },
        uAlpha: { value: rainNow.alpha * 2.2 },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, splashMat);
    mesh.name = 'splashes';
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    mesh.visible = geo.instanceCount > 0;
    splashMesh = mesh;
    group.add(mesh);
    disposables.push(geo, splashMat);
  }

  // ----- Mist (High only): a terrain hugging layer re-centred on the camera as it moves.
  let mist: THREE.Mesh | null = null;
  let mistMat: THREE.ShaderMaterial | null = null;
  let mistPos: THREE.BufferAttribute | null = null;
  const mistCentre = new THREE.Vector2(Infinity, Infinity);
  if (opts.quality === 'high' && Math.max(def.mist, defTo.mist) > 0.15) {
    const n = WEATHER.mistGrid;
    const geo = new THREE.PlaneGeometry(WEATHER.mistSize, WEATHER.mistSize, n, n);
    geo.rotateX(-Math.PI / 2);
    mistPos = geo.attributes.position as THREE.BufferAttribute;
    mistPos.setUsage(THREE.DynamicDrawUsage);
    const noise = makeNoiseTexture(256, seed);
    mistMat = new THREE.ShaderMaterial({
      vertexShader: mistVert,
      fragmentShader: mistFrag,
      uniforms: {
        uNoise: { value: noise },
        uTime: { value: 0 },
        // Added light, so the layer lifts the dark road without dimming the lit patches (set from the fog colour in `mistLight`).
        uColor: { value: new THREE.Color() },
        uStrength: { value: 0.9 * def.mist },
        uWind: { value: new THREE.Vector2(dir.x, dir.z) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    mist = new THREE.Mesh(geo, mistMat);
    mist.name = 'mist';
    mist.frustumCulled = false;
    mist.renderOrder = 9;
    mist.visible = def.mist > 0.005;
    group.add(mist);
    disposables.push(geo, mistMat, noise);
  }
  const mistLight = (c: THREE.Color): void => {
    (mistMat?.uniforms.uColor.value as THREE.Color | undefined)?.setRGB(c.r * 1.6 + 0.09, c.g * 1.6 + 0.1, c.b * 1.5 + 0.14);
  };
  mistLight(fogA);

  // ----- The turn's second sky: a dome over the first, faded in as the weather turns.
  let skyDome: THREE.Mesh | null = null;
  let skyDomeMat: THREE.ShaderMaterial | null = null;
  if (skyTo) {
    const geo = new THREE.SphereGeometry(SKY_OVERLAY_RADIUS, 32, 16);
    skyDomeMat = new THREE.ShaderMaterial({
      vertexShader: skyOverlayVert,
      fragmentShader: skyOverlayFrag,
      uniforms: { uMap: { value: skyTo }, uAlpha: { value: 0 }, uIntensity: { value: 1 } },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    skyDome = new THREE.Mesh(geo, skyDomeMat);
    skyDome.name = 'skyTurn';
    skyDome.frustumCulled = false;
    skyDome.renderOrder = -10;
    skyDome.visible = false;
    group.add(skyDome);
    disposables.push(geo, skyDomeMat);
  }

  // ----- Lightning (rain nights): the flash lifts the sky, the lights and the streaks below. Built when the night is
  // ever rain; strikes wait until it mostly is.
  const lightning = mood === 'rain' || toMood === 'rain' ? buildLightning(seed, { quality: opts.quality, flashes: opts.flashes }) : null;
  if (lightning) group.add(lightning.group);

  const recentreMist = (x: number, z: number): void => {
    if (!mistPos || !mist) return;
    mistCentre.set(x, z);
    const n = WEATHER.mistGrid;
    const size = WEATHER.mistSize;
    let k = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const px = x + (i / n - 0.5) * size;
        const pz = z + (j / n - 0.5) * size;
        mistPos.setXYZ(k++, px, world.heightAt(px, pz) + WEATHER.mistLift, pz);
      }
    }
    mistPos.needsUpdate = true;
  };

  // Camera speed for the streak stretch: from frame to frame positions, smoothed, reset on a jump.
  const camPos = new THREE.Vector3();
  const prevCam = new THREE.Vector3(Infinity, 0, 0);
  const camVel = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  let time = 0;
  let prevTime = -1;
  const respawnSplashes = (t: number): void => {
    if (!splashPos || !splashBirth || !splashGeo) return;
    const n = splashGeo.instanceCount;
    let dirty = false;
    for (let i = 0; i < n; i++) {
      if (t - splashBirth.getX(i) < WEATHER.splashLife) continue;
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * WEATHER.splashRadius;
      const x = camPos.x + Math.cos(a) * r;
      const z = camPos.z + Math.sin(a) * r;
      splashPos.setXYZ(i, x, world.heightAt(x, z) + 0.03, z);
      // Spread the births over the next life so they never pulse together.
      splashBirth.setXY(i, t + rng.next() * WEATHER.splashLife, rng.next());
      dirty = true;
    }
    if (dirty) {
      splashPos.needsUpdate = true;
      splashBirth.needsUpdate = true;
    }
  };

  // ----- Pushing the blend. The scene, the lights and the self-fogging uniforms are known once apply / retuneFog ran.
  let sceneRef: THREE.Scene | null = null;
  let lightingRef: NightLighting | null = null;
  let fogDensityUniforms: { value: unknown }[] = [];
  let fogColorUniforms: { value: unknown }[] = [];
  /** The blend step last pushed (-1: push again at the next update). */
  let pushed = -1;
  const pushBlend = (k: number): void => {
    live.turn = k;
    live.density = lerp(def.fogDensity, defTo.fogDensity, k);
    live.fogColor.lerpColors(fogA, fogB, k);
    live.stars = lerp(def.stars, defTo.stars, k);
    live.moon = lerp(def.moon, defTo.moon, k);
    live.halo = lerp(def.halo, defTo.halo, k);
    live.wet = lerp(def.wet, defTo.wet, k);
    live.overcast = lerp(def.sky.overcast, defTo.sky.overcast, k);
    fog.color.copy(live.fogColor);
    // Shaders that fog themselves: the uniform objects were collected once, so this is a few dozen writes.
    for (const u of fogDensityUniforms) u.value = live.density;
    for (const u of fogColorUniforms) (u.value as THREE.Color).copy(live.fogColor);
    mistLight(live.fogColor);
    if (mistMat) {
      mistMat.uniforms.uStrength.value = 0.9 * lerp(def.mist, defTo.mist, k);
      if (mist) mist.visible = mistMat.uniforms.uStrength.value > 0.005;
    }
    // The haze pool deepens or lifts with the turn; the floor and the home's tint are the world's and never move.
    setHeightFog(floor, lerp(def.heightPool ?? FOG_HEIGHT.pool, defTo.heightPool ?? FOG_HEIGHT.pool, k), tint.hue);
    const env = WEATHER.envDry + WEATHER.envWet * live.wet;
    if (sceneRef) {
      sceneRef.environmentIntensity = env;
      sceneRef.background = skyTo && k >= 1 ? skyTo : sky;
    }
    lightning?.setEnvBase(env);
    if (skyDome && skyDomeMat) {
      skyDomeMat.uniforms.uAlpha.value = k;
      skyDome.visible = k > 0 && k < 1;
    }
    hemiNow.lerpColors(hemiA, hemiB, k);
    lightingRef?.setMood({ hemi: hemiNow.getHex(), hemiIntensity: lerp(def.hemiIntensity, defTo.hemiIntensity, k), moonLight: lerp(def.moonLight, defTo.moonLight, k) });
  };

  return {
    mood,
    def,
    timeline,
    live,
    moonPhase,
    windHeading,
    sky,
    fog,
    group,
    lightning,
    moodAt: (t, out) => timeline.moodAt(t, out),
    apply(scene, lighting) {
      sceneRef = scene;
      lightingRef = lighting;
      scene.fog = fog;
      // The haze that pools in the river channel and the low parks (lit by the home's tint); shared uniforms, written here once per scene.
      setHeightFog(floor, def.heightPool ?? FOG_HEIGHT.pool, tint.hue);
      scene.background = sky;
      scene.environmentIntensity = WEATHER.envDry + WEATHER.envWet * def.wet;
      lighting.setMood({ hemi: def.hemi, hemiIntensity: def.hemiIntensity, moonLight: def.moonLight });
      lightning?.attach(scene, lighting);
      pushed = -1;
    },
    retuneFog(scene) {
      const densities = new Set<{ value: unknown }>();
      const colors = new Set<{ value: unknown }>();
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) {
          const u = (mat as THREE.ShaderMaterial).uniforms as Record<string, { value: unknown }> | undefined;
          if (!u) continue;
          if (u.fogDensity && typeof u.fogDensity.value === 'number') {
            u.fogDensity.value = def.fogDensity;
            densities.add(u.fogDensity);
          }
          if (u.fogColor && u.fogColor.value instanceof THREE.Color) {
            u.fogColor.value.setHex(def.fogColor);
            colors.add(u.fogColor);
          }
        }
      });
      fogDensityUniforms = [...densities];
      fogColorUniforms = [...colors];
      pushed = -1;
    },
    view(camera, viewportHeight) {
      lightning?.view(camera);
      camera.getWorldPosition(camPos);
      skyDome?.position.copy(camPos);
      if (rainMat) {
        const cam = camera as THREE.PerspectiveCamera;
        const fov = cam.isPerspectiveCamera ? cam.fov : 60;
        rainMat.uniforms.uPixel.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
        const dt = time - prevTime;
        if (prevTime >= 0 && dt > 0 && dt < 0.5 && Number.isFinite(prevCam.x) && prevCam.distanceToSquared(camPos) < 30 * 30) {
          // Exponential smoothing, in time, so the stretch looks the same at any frame rate.
          const k = 1 - Math.exp(-dt * 6);
          camVel.x += ((camPos.x - prevCam.x) / dt - camVel.x) * k;
          camVel.y += ((camPos.y - prevCam.y) / dt - camVel.y) * k;
          camVel.z += ((camPos.z - prevCam.z) / dt - camVel.z) * k;
        } else camVel.set(0, 0, 0);
        (rainMat.uniforms.uCamVel.value as THREE.Vector3).copy(camVel);
        camera.getWorldDirection(camFwd);
        (rainMat.uniforms.uCamFwd.value as THREE.Vector3).copy(camFwd);
        prevCam.copy(camPos);
        prevTime = time;
      }
      if (splashMat) respawnSplashes(time);
      if (mist && mist.visible && (camPos.x - mistCentre.x) ** 2 + (camPos.z - mistCentre.y) ** 2 > WEATHER.mistRecentre ** 2) recentreMist(camPos.x, camPos.z);
    },
    update(t) {
      time = t;
      timeline.moodAt(t, blend);
      const k = blend.t;
      const step = Math.round(k * BLEND_STEPS);
      if (step !== pushed) {
        pushed = step;
        pushBlend(k);
      }
      // The gust, the trees' lean and the clouds over the moon: functions of the clock, every frame.
      const gust = gustAt(seed, t, gustiness(k));
      live.gust = gust;
      live.sway = lerp(WEATHER_TURN.wind[mood].sway, WEATHER_TURN.wind[toMood].sway, k) * gust;
      WIND.sway.value = live.sway;
      live.veil = moonVeil(seed, t, live.overcast);
      blendRain(def.rain, defTo.rain, k, rainNow);
      live.rain = rainNow.share;
      // Lightning only once the night is mostly rain (to is rain and past half way, or rain easing off before half way).
      const rainWeight = (mood === 'rain' ? 1 - k : 0) + (toMood === 'rain' && mood !== 'rain' ? k : 0);
      const flash = lightning ? lightning.update(t, rainWeight > 0.5) : 0;
      if (rainMat && rainGeo && rainMesh) {
        blendRain(def.rain, defTo.rain, k, rainNow);
        const count = Math.round((pool * rainNow.share) / maxShare);
        rainGeo.instanceCount = count;
        rainMesh.visible = count > 0;
        const wind = rainNow.wind * gust;
        const u = rainMat.uniforms;
        (u.uVel.value as THREE.Vector3).set(dir.x * wind, -rainNow.fall, dir.z * wind);
        const w = windPath.at(t);
        (u.uDrift.value as THREE.Vector3).set(dir.x * w, -fallPath.at(t), dir.z * w);
        u.uHeadlight.value = rainNow.headlight;
        // The streaks catch a lightning flash.
        u.uAlpha.value = rainNow.alpha * (1 + LIGHTNING.rain * flash);
      }
      if (splashMat && splashGeo) {
        blendRain(def.rain, defTo.rain, k, rainNow);
        splashGeo.instanceCount = Math.round((splashes * rainNow.splash) / maxSplash);
        splashMat.uniforms.uTime.value = t;
        splashMat.uniforms.uAlpha.value = rainNow.alpha * 2.2;
        if (splashMesh) splashMesh.visible = splashGeo.instanceCount > 0;
      }
      if (mistMat) mistMat.uniforms.uTime.value = t;
      // The lightning flash brightens the sky dome (scene.backgroundIntensity); the second sky follows it.
      if (skyDomeMat && sceneRef) skyDomeMat.uniforms.uIntensity.value = sceneRef.backgroundIntensity;
    },
    dispose() {
      lightning?.dispose();
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}
