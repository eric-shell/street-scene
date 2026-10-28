/**
 * The water material the harbor, the lake, the park ponds and the river's puddles share. It is the city's dark
 * mirror (a vertex tinted MeshStandardMaterial that the sky and the lamps reflect in) with a patched fragment stage,
 * so it stays one material, one draw call and no extra pass:
 *  - a scrolling pair of normal-map octaves (a small tileable noise normal map generated once, two layers at
 *    different scales and speeds that travel along the wind's heading) bend the reflection: glassy on still nights,
 *    textured in wind, with the amplitude following `WIND.sway` (gusts included) through `WATER_SKY.wind`. High adds a
 *    third, fine octave. Both fade to a flat mirror with distance, where the mip chain would only shimmer;
 *  - a Fresnel edge: the reflection's tint lifts toward the sky's at grazing angles, so far water reads brighter than
 *    the water at the quay's foot (the physical material's own Fresnel would only follow the dark vertex tint);
 *  - the moon's glint: a long streak toward the moon's side of the sky, built from the half vector against a moon
 *    hung low (the real moon is too high to glitter anywhere but at one's feet), a sharp core that only the ripples'
 *    facets catch (sparkle) under a broad lobe that widens with the wind; scaled by how much of the moon shows
 *    (phase, cloud veil, the mood) and added as emission. The lamp streaks (street/lightFx) are separate and stay;
 *  - rain rings on wet nights: one ring per cell of a world grid, each cell on its own cycle, switched on by the
 *    rain's share, fading with distance. A uniform branch skips them on dry nights.
 * Cost (Medium): two texture taps, about 60 ALU for the normal, Fresnel and glint, another 30 for the rings on a
 * rainy night; High adds one tap and a few ALU. Low draws the flat mirror it always did: no normals, no glint.
 * All numbers live in `WATER`; the sky's uniforms are `WATER_SKY` (sky/waterSky.ts), written once a frame by the scene.
 */
import * as THREE from 'three';
import { Rng } from '../../sim/prng';
import { WATER_SKY } from '../sky/waterSky';
import type { Quality } from '../../ui/settings';

/** Every number of the water, in one place. */
export const WATER = {
  /** The base look every tier keeps: vertex tinted dark mirror, rough 0.08, metal 0.95, reflecting hard; see-through where it is not opaque. */
  base: { roughness: 0.08, metalness: 0.95, envMapIntensity: 2.4, opacity: 0.86 },
  /** The normal map: texels per side, the plane waves summed into it, their seed, and the rms slope it stores (of the 0..1 a texel can hold). */
  map: { size: 128, waves: 18, seed: 0x7a7e5, rms: 0.4, maxK: 7 },
  /**
   * The octaves, coarse to fine: the repeat length (m), the speed along the wind (m/s), the heading's turn from the
   * wind (rad), the share of the slope it carries, and where it fades to a flat mirror (m, from..to).
   */
  octaves: [
    { tile: 23, speed: 0.55, turn: -0.3, weight: 1, fade: [150, 700] },
    { tile: 6.4, speed: 1.05, turn: 0.45, weight: 0.7, fade: [40, 220] },
    { tile: 1.9, speed: 1.7, turn: 0.1, weight: 0.4, fade: [12, 80] },
  ] as const,
  /** Octaves drawn per tier (Low draws none: the flat mirror). */
  octaveCount: { low: 0, medium: 2, high: 3 } as Record<Quality, number>,
  /** The slope the normals carry (rise over run): on a still night and at the crest of a gust. */
  slope: { glassy: 0.014, gale: 0.34 },
  /** The wind roughens the reflection: roughness added at a full gale. */
  roughWind: 0.12,
  /** The Fresnel edge: the reflection's tint at grazing angles, how far it mixes in, and the exponent of 1 - N.V. */
  fresnel: { tint: [0.34, 0.44, 0.62], gain: 0.7, power: 4 },
  /**
   * The moon's glint. `lower`: the moon's height is scaled by this for the glitter (the real moon is too high for it to
   * show anywhere but at the viewer's feet). `sharp`: the facet core's exponent (about the moon disc's size on a calm
   * night). `sigma`: the broad lobe's slope variance calm and in a gale (Cox and Munk). `core`/`broad`: radiance of the
   * two (linear, HDR: the bloom takes it). `slopeGain`: the facets tilt this much more for the glint than for the
   * reflection, so a gentle ripple still sparkles. `tint`: the moonlight's colour.
   */
  glint: { lower: 0.3, sharp: 2600, sigma: [0.004, 0.09], core: 7, broad: 0.9, slopeGain: 2.4, tint: [0.82, 0.88, 1] },
  /** Rain rings: the grid cell (m), a ring's cycle (s), its largest radius (m), its wave number (rad/m), the slope it carries, and where it fades out (m, from..to). */
  rain: { cell: 0.9, cycle: 0.9, radius: 0.36, k: 36, slope: 0.4, fade: [30, 110] },
  /** How much each user of the material calms or stirs the surface (a multiplier of the slope). */
  calm: { harbor: 1, lake: 0.6, pond: 0.5, puddle: 0.35 },
} as const;

/** Options of one water material. */
export interface WaterOptions {
  /** Opaque (the harbor: nothing to see under it but the seabed) rather than see-through. */
  opaque?: boolean;
  /** Multiplier of the slope: 1 the open water, less for a sheltered pond or a puddle. */
  calm?: number;
  /** Override of the base roughness. */
  roughness?: number;
  /** The tier: Low draws the flat mirror. */
  quality: Quality;
  /** Take the flat mirror whatever the tier (the river's low trickle keeps its own look at the floor). */
  flat?: boolean;
}

/** What a build lends the material: tracked resources and the tier. A `DistrictKit` has both. */
interface WaterKit {
  track<T extends { dispose(): void }>(x: T): T;
}

/** The normal map's textures, one per scene build (a kit's `track` owns their disposal). */
const maps = new WeakMap<object, THREE.DataTexture>();

/**
 * The tileable noise normal map: plane waves with whole numbers of periods across the tile, so it wraps, with a
 * 1 / |k| spectrum (the bigger the swell, the smaller the slope it carries per unit of height, as on a sea).
 * RG hold the slope (x, z) as 0.5 + 0.5 * s, normalised to `WATER.map.rms` so the shader's amplitudes mean what they say.
 */
export function waterNormalMap(): THREE.DataTexture {
  const M = WATER.map;
  const N = M.size;
  const rng = new Rng(M.seed);
  const waves: { kx: number; ky: number; a: number; p: number }[] = [];
  for (let i = 0; i < M.waves; i++) {
    const kx = rng.int(-M.maxK, M.maxK);
    const ky = rng.int(0, M.maxK);
    if (!kx && !ky) {
      i--;
      continue;
    }
    waves.push({ kx, ky, a: 1 / Math.hypot(kx, ky), p: rng.range(0, Math.PI * 2) });
  }
  const sx = new Float32Array(N * N);
  const sz = new Float32Array(N * N);
  let sum = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let gx = 0;
      let gz = 0;
      for (const w of waves) {
        const c = w.a * Math.cos(((w.kx * x + w.ky * y) / N) * Math.PI * 2 + w.p);
        gx += c * w.kx;
        gz += c * w.ky;
      }
      sx[y * N + x] = gx;
      sz[y * N + x] = gz;
      sum += gx * gx + gz * gz;
    }
  }
  const scale = M.rms / Math.sqrt(sum / (2 * N * N));
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, sx[i] * scale)));
    data[i * 4 + 1] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, sz[i] * scale)));
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const f = (n: number): string => n.toFixed(5);
const v3 = (a: readonly number[]): string => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

/** The GLSL of the fragment stage for `octaves` normal-map octaves (0 is never asked: that is the flat mirror). */
function fragmentChunk(octaves: number): string {
  const O = WATER.octaves;
  const G = WATER.glint;
  const taps = O.slice(0, octaves)
    .map((o, i) => `slope += wOctave(p, ${f(o.tile)}, ${f(o.speed)}, ${f(o.turn)}) * ${f(o.weight)} * (1.0 - smoothstep(${f(o.fade[0])}, ${f(o.fade[1])}, dist)); // octave ${i}`)
    .join('\n    ');
  return /* glsl */ `
    {
      vec3 wToP = vWaterPos - cameraPosition;
      float dist = length(wToP);
      vec3 wIn = wToP / max(dist, 1e-3);
      vec2 p = vWaterPos.xz;
      float wind = uWaterWind;
      vec2 slope = vec2(0.0);
      ${taps}
      slope *= mix(${f(WATER.slope.glassy)}, ${f(WATER.slope.gale)}, wind) * uWaterAmp;
      if (uWaterRain > 0.01) slope += wRings(p, dist) * uWaterRain * uWaterAmp;
      vec3 nW = normalize(vec3(-slope.x, 1.0, -slope.y));
      normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
      roughnessFactor = clamp(roughnessFactor + ${f(WATER.roughWind)} * wind, 0.0, 1.0);
      // The Fresnel edge: the reflection's tint lifts toward the sky's as the view turns grazing.
      float nv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(WATER.fresnel.tint)}, pow(1.0 - nv, ${f(WATER.fresnel.power)}) * ${f(WATER.fresnel.gain)});
      // The moon's glint, against the moon hung low; the facets tilt more for it than for the reflection.
      if (uMoon > 0.002) {
        vec3 Lg = normalize(vec3(uMoonDir.x, uMoonDir.y * ${f(G.lower)}, uMoonDir.z));
        vec3 H = normalize(Lg - wIn);
        float hy = max(H.y, 0.05);
        float t2 = (1.0 - hy * hy) / (hy * hy);
        float broad = exp(-t2 / mix(${f(G.sigma[0])}, ${f(G.sigma[1])}, wind));
        vec3 nG = normalize(vec3(-slope.x * ${f(G.slopeGain)}, 1.0, -slope.y * ${f(G.slopeGain)}));
        float core = pow(max(dot(nG, H), 0.0), ${f(G.sharp)});
        // Only a surface seen from above reflects it; the glint dies at the horizon's far edge with the fog.
        float up = smoothstep(0.0, 0.03, -wIn.y);
        totalEmissiveRadiance += ${v3(G.tint)} * (uMoon * up * (core * ${f(G.core)} + broad * ${f(G.broad)}));
      }
    }
  `;
}

/** The GLSL declarations the chunk uses: uniforms, the octave lookup and the rain rings. */
function fragmentPars(): string {
  const R = WATER.rain;
  return /* glsl */ `
    uniform sampler2D uWaterMap;
    uniform float uWaterTime;
    uniform vec2 uWaterHeading;
    uniform vec3 uMoonDir;
    uniform float uMoon;
    uniform float uWaterWind;
    uniform float uWaterRain;
    uniform float uWaterAmp;
    varying vec3 vWaterPos;
    float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // One normal-map octave: its slope (x, z) at ground position p, travelling along the wind turned by \`turn\`.
    vec2 wOctave(vec2 p, float tile, float speed, float turn) {
      float c = cos(turn);
      float s = sin(turn);
      vec2 h = vec2(c * uWaterHeading.x - s * uWaterHeading.y, s * uWaterHeading.x + c * uWaterHeading.y);
      vec2 uv = p / tile - fract(h * (uWaterTime * speed / tile));
      return texture2D(uWaterMap, uv).rg * 2.0 - 1.0;
    }
    // Rain rings: one drop per cell per cycle (on with the rain's share), a ring spreading and dying, as a slope.
    vec2 wRings(vec2 p, float dist) {
      float fade = 1.0 - smoothstep(${f(R.fade[0])}, ${f(R.fade[1])}, dist);
      if (fade <= 0.0) return vec2(0.0);
      vec2 g = p / ${f(R.cell)};
      vec2 cell = floor(g);
      float t = uWaterTime / ${f(R.cycle)} + wHash(cell);
      float n = floor(t);
      float life = t - n;
      vec2 id = cell + n * 7.31;
      if (wHash(id) > uWaterRain) return vec2(0.0);
      vec2 c = (vec2(wHash(id + 3.1), wHash(id + 7.7)) - 0.5) * 0.3;
      vec2 d = (g - cell - 0.5 - c) * ${f(R.cell)};
      float r = max(length(d), 1e-3);
      float x = r - life * ${f(R.radius)};
      float env = exp(-x * x / 0.0036) * (1.0 - life) * (1.0 - life);
      return d / r * (sin(x * ${f(R.k)}) * env * ${f(R.slope)} * fade);
    }
  `;
}

/**
 * The water material for one user. Low (and `flat`) draw the plain dark mirror; Medium and High patch the fragment
 * stage as the module note says. The program is the same for every material of a tier whatever its opacity or calm.
 */
export function waterMaterial(kit: WaterKit, o: WaterOptions): THREE.MeshStandardMaterial {
  const B = WATER.base;
  const opaque = o.opaque === true;
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: o.roughness ?? B.roughness,
    metalness: B.metalness,
    envMapIntensity: B.envMapIntensity,
    ...(opaque ? {} : { transparent: true, opacity: B.opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  });
  const octaves = o.flat ? 0 : WATER.octaveCount[o.quality];
  if (octaves === 0) return m;
  let tex = maps.get(kit);
  if (!tex) {
    tex = kit.track(waterNormalMap());
    maps.set(kit, tex);
  }
  const uniforms = {
    uWaterMap: { value: tex },
    uWaterAmp: { value: o.calm ?? 1 },
    uWaterTime: WATER_SKY.time,
    uWaterHeading: WATER_SKY.heading,
    uMoonDir: WATER_SKY.moonDir,
    uMoon: WATER_SKY.moon,
    uWaterWind: WATER_SKY.wind,
    uWaterRain: WATER_SKY.rain,
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentPars()}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragmentChunk(octaves)}`);
  };
  m.customProgramCacheKey = () => `water:${octaves}`;
  return m;
}
