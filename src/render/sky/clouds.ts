/**
 * Lit low cloud: one drifting layer a few hundred metres over the city, lit from below by the city's own glow.
 * The sky dome (skyTextures.ts) paints a few painted blobs at infinity; this is the cloud you can drift under.
 *
 * One draw call: a flat disc of rings that follows the camera horizontally and hangs at a seeded altitude
 * (`CLOUDS.altitude`), drawn after the star and moon sprites so it covers them. The fragment shader works in
 * world metres, so the cloud stays where it is as the camera moves and parallax is free:
 *  - density: three octaves of one tiling noise texture (R, G, B hold 4, 8 and 16 cell value noise), sampled at
 *    three scales = three fetches per pixel. Coverage is a smoothstep on the sum whose threshold falls with the
 *    mood's `overcast`: clear nights get thin broken wisps (the stars show between and through them), hazy a soft
 *    sheet, drizzle and rain a low lid. The moon's veil (weatherTimeline.ts `moonVeil`, the same value that dims
 *    the moon sprite) lowers the threshold, so the sky thickens as the moon goes behind cloud;
 *  - drift: the noise scrolls along the wind heading by the integral of the speed times the gust factor
 *    (`CumulativeIntegral`, a pure function of the scene clock, so replays and the gust agree and nothing jumps);
 *  - light: the underside takes the horizon colour, lit by the home's sky glow tint (cityIdentity `tint`)
 *    falling off from downtown, brighter where the cloud is thin; a lightning flash lights it from inside;
 *  - edges: the disc fades out toward its rim (so the mountain ring silhouette still reads against open sky
 *    above the ridges) and is fogged per vertex with the height fog at a fraction of the street's density.
 * Medium and High; Low keeps the sky dome alone. No allocation after the build.
 *
 * Cost: a disc of ~1.5k triangles, and per covered pixel three texture fetches, one exp, a few smoothsteps and a
 * mix (about 60 ALU ops); the layer overlaps most of the upper half of the frame, so it is a full-sky overdraw
 * (roughly one extra fullscreen pass on the upper 60% of the screen), the price of the layer at Medium and High.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../sim/prng';
import { lerp } from '../../sim/math';
import type { Quality } from '../../ui/settings';
import { cityIdentity } from '../cityIdentity';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';
import { LIGHTNING } from './lightning';
import type { Weather } from './weather';
import { CumulativeIntegral, gustAt, WEATHER_TURN } from './weatherTimeline';
import type { MoodBlend } from './weatherTimeline';

export const CLOUDS = {
  /** Cloud base altitude over the street (m): a seeded pick in this band. */
  altitude: [300, 600] as [number, number],
  /** Disc radius (m): inside the sky sprites' dome (2050) and every camera's far plane. */
  radius: 1900,
  /** Disc rings and segments. */
  rings: 20,
  segments: 72,
  /** Drift speed (m/s) in steady air; gusts multiply it. */
  speed: 9,
  /** Noise texture size (texels per side; the three octave lattices are 4, 8 and 16 cells). */
  texture: 128,
  /** Tile sizes (m) of the three octaves, and their weights. */
  tile: [2600, 1100, 460] as [number, number, number],
  weight: [0.45, 0.33, 0.22] as [number, number, number],
  /** Coverage threshold by overcast (0 clear to 1 solid), the edge softness, and the sheet's opacity at each end. */
  threshold: [0.68, 0.34] as [number, number],
  soft: 0.4,
  /** Stretch of the octave sum around its mean (about 0.5) before the threshold. */
  contrast: 2.4,
  opacity: [0.34, 0.92] as [number, number],
  /** How far the moon's veil lowers the threshold at a fully veiled moon. */
  veil: 0.2,
  /** Underside colour: the horizon colour times this, and the glow tint's linear brightness (scaled by the mood's glow strength). */
  base: 0.7,
  glow: 0.13,
  /** Downtown's reach: the glow's e-fold distance as a share of the city's half extent, and the share of the radius where the disc starts fading. */
  glowReach: 0.9,
  fadeFrom: 0.5,
  /** Share of the street's fog density the layer is fogged with (it is hundreds of metres to kilometres away). */
  fog: 0.06,
  /** Lightning lights the cloud from inside: colour (linear) at a full flash. */
  flash: [0.7, 0.8, 1.2] as [number, number, number],
  /** The disc hides when the camera climbs within this many metres of it. */
  hideWithin: 20,
} as const;

const vert = /* glsl */ `
  uniform float uFog;
  varying vec3 vWorld;
  varying float vFog;
  ${HEIGHT_FOG_GLSL}
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    float d = length(wp.xyz - cameraPosition);
    vFog = 1.0 - exp(-uFog * uFog * d * d * hfMul(wp.xyz));
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const frag = /* glsl */ `
  uniform sampler2D uNoise;
  uniform vec3 uScale;
  uniform vec3 uWeight;
  uniform vec2 uOff;
  uniform float uThr;
  uniform float uSoft;
  uniform float uContrast;
  uniform float uOpacity;
  uniform vec3 uBase;
  uniform vec3 uGlow;
  uniform vec3 uFogColor;
  uniform vec3 uFlashColor;
  uniform float uFlash;
  uniform vec3 uCenter;
  uniform float uRadius;
  uniform float uFadeFrom;
  varying vec3 vWorld;
  varying float vFog;
  void main() {
    vec2 p = vWorld.xz - uOff;
    float fine = texture2D(uNoise, p * uScale.z + 0.71).b;
    float n = texture2D(uNoise, p * uScale.x).r * uWeight.x
            + texture2D(uNoise, p * uScale.y + 0.37).g * uWeight.y
            + fine * uWeight.z;
    // The octave sum clusters around 0.5; stretch it so the threshold sweeps real cloud shapes.
    n = clamp((n - 0.5) * uContrast + 0.5, 0.0, 1.0);
    float cover = smoothstep(uThr, uThr + uSoft, n);
    // Fade toward the rim, so the ridges read against open sky and no edge shows.
    float rim = 1.0 - smoothstep(uFadeFrom, 1.0, distance(vWorld.xz, cameraPosition.xz) / uRadius);
    float a = cover * uOpacity * rim;
    if (a < 0.004) discard;
    // The underside: thin cloud lets more of the city's light through, thick cloud is darker; the glow falls off from downtown.
    float thin = 1.0 - smoothstep(uThr, uThr + 0.3, n);
    float shade = (0.5 + 0.9 * thin) * (0.75 + 0.5 * fine);
    float dc = distance(vWorld.xz, uCenter.xy) * uCenter.z;
    float radial = exp(-dc * dc);
    vec3 col = uBase * (0.7 + 0.3 * shade) + uGlow * (radial * shade + 0.12 * shade);
    col += uFlashColor * (uFlash * (0.35 + 0.65 * shade));
    col = mix(col, uFogColor, vFog);
    gl_FragColor = vec4(col, a * (1.0 - 0.6 * vFog));
  }
`;

/** A tiling noise texture whose R, G and B are 4, 8 and 16 cell value noise (smoothstep interpolated, wrapping). */
function makeCloudNoise(size: number, seed: number): THREE.DataTexture {
  const rng = new Rng(deriveSeed(seed, 'cloudNoise'));
  const data = new Uint8Array(size * size * 4);
  [4, 8, 16].forEach((cells, ch) => {
    const lattice = new Float32Array(cells * cells);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();
    const at = (i: number, j: number): number => lattice[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const fx = (x / size) * cells;
        const fy = (y / size) * cells;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
        const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
        data[(y * size + x) * 4 + ch] = Math.round((a + (b - a) * sy) * 255);
      }
    }
  });
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** A flat disc of concentric rings (y = 0), finer toward the middle where the camera looks through it. */
function discGeometry(radius: number, rings: number, segments: number): THREE.BufferGeometry {
  const pos: number[] = [0, 0, 0];
  for (let r = 1; r <= rings; r++) {
    const rr = radius * (r / rings) ** 1.4;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a = 1 + (r - 1) * segments;
    const b = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const n = (s + 1) % segments;
      idx.push(a + s, a + n, b + s, a + n, b + n, b + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

export interface Clouds {
  mesh: THREE.Mesh;
  /** Cloud base altitude over the street (m). */
  readonly altitude: number;
  /** Follow the camera, hide it from above (call per render). */
  view(camera: THREE.Camera): void;
  /** Per frame with the scene clock (s) and the scene (fog density and the lightning's sky lift). */
  update(time: number, scene: THREE.Scene): void;
  dispose(): void;
}

/**
 * Build the layer; null at Low. `center` and `reach` are the city's middle and half extent (m): the glow is
 * brightest over the middle.
 */
export function buildClouds(seed: number, opts: { quality: Quality; weather: Weather; center: { x: number; z: number }; reach: number }): Clouds | null {
  if (opts.quality === 'low') return null;
  const { weather } = opts;
  const rng = new Rng(deriveSeed(seed, 'clouds'));
  const altitude = Math.round(rng.range(CLOUDS.altitude[0], CLOUDS.altitude[1]));
  const { tint } = cityIdentity(seed);
  const noise = makeCloudNoise(CLOUDS.texture, seed);
  const geo = discGeometry(CLOUDS.radius, CLOUDS.rings, CLOUDS.segments);
  const base = new THREE.Color(weather.def.sky.horizon);
  base.multiplyScalar(CLOUDS.base);
  // The glow takes the home's tint, scaled to a fixed linear luminance so every hue reads as bright as another.
  const glow = new THREE.Color(tint.hue);
  glow.multiplyScalar(1 / Math.max(1e-6, 0.2126 * glow.r + 0.7152 * glow.g + 0.0722 * glow.b));
  glow.multiplyScalar(CLOUDS.glow * (0.5 + weather.def.sky.glowStrength));
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      ...HEIGHT_FOG_UNIFORMS,
      uNoise: { value: noise },
      uScale: { value: new THREE.Vector3(1 / CLOUDS.tile[0], 1 / CLOUDS.tile[1], 1 / CLOUDS.tile[2]) },
      uWeight: { value: new THREE.Vector3(...CLOUDS.weight) },
      uOff: { value: new THREE.Vector2() },
      uThr: { value: CLOUDS.threshold[0] },
      uSoft: { value: CLOUDS.soft },
      uContrast: { value: CLOUDS.contrast },
      uOpacity: { value: CLOUDS.opacity[0] },
      uBase: { value: base },
      uGlow: { value: glow },
      uFogColor: { value: new THREE.Color() },
      uFlashColor: { value: new THREE.Color(...CLOUDS.flash) },
      uFlash: { value: 0 },
      uCenter: { value: new THREE.Vector3(opts.center.x, opts.center.z, 1 / Math.max(200, opts.reach * CLOUDS.glowReach)) },
      uRadius: { value: CLOUDS.radius },
      uFadeFrom: { value: CLOUDS.fadeFrom },
      uFog: { value: 0.01 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'clouds';
  mesh.frustumCulled = false;
  // After the star and moon sprites (order 0), before the rain and mist (9, 10).
  mesh.renderOrder = 1;
  mesh.position.y = altitude;
  const u = mat.uniforms;
  // The drift: along the wind heading at `speed` times the gust, integrated so a gust speeds the cloud up without a jump.
  const heading = weather.windHeading;
  const dx = Math.cos(heading);
  const dz = Math.sin(heading);
  const blend: MoodBlend = { from: weather.mood, to: weather.mood, t: 0 };
  const path = new CumulativeIntegral((t) => {
    weather.timeline.moodAt(t, blend);
    return CLOUDS.speed * gustAt(seed, t, lerp(WEATHER_TURN.wind[blend.from].gusty, WEATHER_TURN.wind[blend.to].gusty, blend.t));
  });
  return {
    mesh,
    altitude,
    view(camera) {
      const p = camera.position;
      mesh.position.set(p.x, altitude, p.z);
      mesh.visible = p.y < altitude - CLOUDS.hideWithin;
    },
    update(time, scene) {
      const live = weather.live;
      const s = path.at(time);
      (u.uOff.value as THREE.Vector2).set(dx * s, dz * s);
      const oc = live.overcast;
      u.uThr.value = lerp(CLOUDS.threshold[0], CLOUDS.threshold[1], oc) - CLOUDS.veil * (1 - live.veil);
      u.uOpacity.value = lerp(CLOUDS.opacity[0], CLOUDS.opacity[1], oc);
      (u.uFogColor.value as THREE.Color).copy(live.fogColor);
      u.uFlash.value = Math.min(1, Math.max(0, (scene.backgroundIntensity - 1) / LIGHTNING.sky));
      const fog = scene.fog as THREE.FogExp2 | null;
      u.uFog.value = (fog ? fog.density : live.density) * CLOUDS.fog;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
      noise.dispose();
    },
  };
}
