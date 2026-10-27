/**
 * Weather and mood, one per seed and render only (the sim never knows, so
 * replays stay valid): a weighted pick among clear, hazy, misty, drizzle and
 * rain nights. The mood sets the fog (colour and density, also pushed into
 * every material that fogs itself in a shader), the sky dome, the hemisphere
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
 * Clear stays the most common mood: the neon night is the default look. The
 * seed's home neighbourhood (cityIdentity.ts) multiplies the weights (misty
 * San Francisco, wet Philadelphia) and leans the fog and the sky's horizon
 * glow toward its light pollution hue at the mood's own luminance, so the
 * moods still differ and the city still reads as its home.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Quality } from '../../ui/settings';
import type { NightLighting } from '../lighting';
import { makeMoodSky, makeNoiseTexture, MoodSkyParams } from './skyTextures';
import { LIGHTNING, Lightning, buildLightning } from './lightning';
import { cityIdentity } from '../cityIdentity';

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
  uniform float uTime;
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
    vec3 p = aSeed * uBox + uVel * uTime;
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

export interface Weather {
  readonly mood: MoodId;
  /** The mood as this seed shows it (fog colour and sky glow tinted by the city identity). */
  readonly def: MoodDef;
  /** Moon phase 0..1 and wind heading (rad), shared with the backdrop and the air traffic. */
  readonly moonPhase: number;
  readonly windHeading: number;
  readonly sky: THREE.Texture;
  readonly fog: THREE.FogExp2;
  /** Rain, splash and mist layers (and the lightning on rain nights); add to the scene. */
  readonly group: THREE.Group;
  /** Rain nights only: the strikes, their flashes and thunder. */
  readonly lightning: Lightning | null;
  /** Fog, background, environment intensity and the lights. */
  apply(scene: THREE.Scene, lighting: NightLighting): void;
  /** Materials that fog themselves (shader uniforms fogDensity / fogColor) get the mood's fog; call once the scene is built. */
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
  const { moonPhase, windHeading } = skyParams(seed);
  const sky = makeMoodSky(def.sky, seed);
  const fog = new THREE.FogExp2(def.fogColor, def.fogDensity);
  const group = new THREE.Group();
  group.name = 'weather';
  const disposables: { dispose(): void }[] = [sky];
  const rng = new Rng(deriveSeed(seed, 'rain'));

  // ----- Rain
  let rainMat: THREE.ShaderMaterial | null = null;
  const pool = Math.round(WEATHER.pool[opts.quality] * (def.rain?.share ?? 0));
  if (def.rain && pool > 0) {
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
    geo.instanceCount = pool;
    const wind = def.rain.wind;
    rainMat = new THREE.ShaderMaterial({
      vertexShader: rainVert,
      fragmentShader: rainFrag,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(WEATHER.box.x, WEATHER.box.y, WEATHER.box.z) },
        uHalf: { value: new THREE.Vector3(WEATHER.box.x / 2, WEATHER.below, WEATHER.box.z / 2) },
        uVel: { value: new THREE.Vector3(Math.cos(windHeading) * wind, -def.rain.fall, Math.sin(windHeading) * wind) },
        uCamVel: { value: new THREE.Vector3() },
        uCamFwd: { value: new THREE.Vector3(0, 0, 1) },
        uShutter: { value: WEATHER.shutter },
        uWidth: { value: WEATHER.streakWidth },
        uPixel: { value: 0.002 },
        uHeadlight: { value: def.rain.headlight },
        uColor: { value: new THREE.Color(0.5, 0.56, 0.72) },
        uAlpha: { value: def.rain.alpha },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const rain = new THREE.Mesh(geo, rainMat);
    rain.name = 'rain';
    rain.frustumCulled = false;
    rain.renderOrder = 10;
    group.add(rain);
    disposables.push(geo, rainMat);
  }

  // ----- Splashes: rings on the road around the camera, each respawned where it died.
  let splashMat: THREE.ShaderMaterial | null = null;
  let splashPos: THREE.InstancedBufferAttribute | null = null;
  let splashBirth: THREE.InstancedBufferAttribute | null = null;
  const splashes = Math.round(WEATHER.splashPool[opts.quality] * (def.rain?.splash ?? 0));
  if (def.rain && splashes > 0) {
    const geo = quadGeometry([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    splashPos = new THREE.InstancedBufferAttribute(new Float32Array(splashes * 3), 3);
    splashBirth = new THREE.InstancedBufferAttribute(new Float32Array(splashes * 2), 2);
    for (let i = 0; i < splashes; i++) splashBirth.setXY(i, -1e6 + i, rng.next());
    splashPos.setUsage(THREE.DynamicDrawUsage);
    splashBirth.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', splashPos);
    geo.setAttribute('aBirth', splashBirth);
    geo.instanceCount = splashes;
    splashMat = new THREE.ShaderMaterial({
      vertexShader: splashVert,
      fragmentShader: splashFrag,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: WEATHER.splashLife },
        uSize: { value: WEATHER.splashSize },
        uColor: { value: new THREE.Color(0.6, 0.66, 0.8) },
        uAlpha: { value: def.rain.alpha * 2.2 },
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const mesh = new THREE.Mesh(geo, splashMat);
    mesh.name = 'splashes';
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    group.add(mesh);
    disposables.push(geo, splashMat);
  }

  // ----- Mist (High only): a terrain hugging layer re-centred on the camera as it moves.
  let mist: THREE.Mesh | null = null;
  let mistMat: THREE.ShaderMaterial | null = null;
  let mistPos: THREE.BufferAttribute | null = null;
  const mistCentre = new THREE.Vector2(Infinity, Infinity);
  if (opts.quality === 'high' && def.mist > 0.15) {
    const n = WEATHER.mistGrid;
    const geo = new THREE.PlaneGeometry(WEATHER.mistSize, WEATHER.mistSize, n, n);
    geo.rotateX(-Math.PI / 2);
    mistPos = geo.attributes.position as THREE.BufferAttribute;
    mistPos.setUsage(THREE.DynamicDrawUsage);
    const noise = makeNoiseTexture(256, seed);
    const c = new THREE.Color(def.fogColor);
    mistMat = new THREE.ShaderMaterial({
      vertexShader: mistVert,
      fragmentShader: mistFrag,
      uniforms: {
        uNoise: { value: noise },
        uTime: { value: 0 },
        // Added light, so the layer lifts the dark road without dimming the lit patches.
        uColor: { value: new THREE.Color(c.r * 1.6 + 0.09, c.g * 1.6 + 0.1, c.b * 1.5 + 0.14) },
        uStrength: { value: 0.9 * def.mist },
        uWind: { value: new THREE.Vector2(Math.cos(windHeading), Math.sin(windHeading)) },
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
    group.add(mist);
    disposables.push(geo, mistMat, noise);
  }

  // ----- Lightning (rain nights): the flash lifts the sky, the lights and the streaks below.
  const lightning = mood === 'rain' ? buildLightning(seed, { quality: opts.quality, flashes: opts.flashes }) : null;
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
    if (!splashPos || !splashBirth) return;
    const n = splashPos.count;
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

  return {
    mood,
    def,
    moonPhase,
    windHeading,
    sky,
    fog,
    group,
    lightning,
    apply(scene, lighting) {
      scene.fog = fog;
      scene.background = sky;
      scene.environmentIntensity = WEATHER.envDry + WEATHER.envWet * def.wet;
      lighting.setMood({ hemi: def.hemi, hemiIntensity: def.hemiIntensity, moonLight: def.moonLight });
      lightning?.attach(scene, lighting);
    },
    retuneFog(scene) {
      scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) {
          const u = (mat as THREE.ShaderMaterial).uniforms as Record<string, { value: unknown }> | undefined;
          if (!u) continue;
          if (u.fogDensity && typeof u.fogDensity.value === 'number') u.fogDensity.value = def.fogDensity;
          if (u.fogColor && u.fogColor.value instanceof THREE.Color) u.fogColor.value.setHex(def.fogColor);
        }
      });
    },
    view(camera, viewportHeight) {
      lightning?.view(camera);
      camera.getWorldPosition(camPos);
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
      if (mist && (camPos.x - mistCentre.x) ** 2 + (camPos.z - mistCentre.y) ** 2 > WEATHER.mistRecentre ** 2) recentreMist(camPos.x, camPos.z);
    },
    update(t) {
      time = t;
      const flash = lightning ? lightning.update(t) : 0;
      if (rainMat) {
        rainMat.uniforms.uTime.value = t;
        // The streaks catch a lightning flash.
        rainMat.uniforms.uAlpha.value = (def.rain?.alpha ?? 0) * (1 + LIGHTNING.rain * flash);
      }
      if (splashMat) splashMat.uniforms.uTime.value = t;
      if (mistMat) mistMat.uniforms.uTime.value = t;
    },
    dispose() {
      lightning?.dispose();
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}
