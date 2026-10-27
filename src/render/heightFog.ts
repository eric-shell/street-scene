/**
 * Height fog: the scene's exponential fog thickens near the ground and thins with altitude, so the river
 * channel and the low parks fill with haze while the highway deck and the bluff look out over it. One
 * implementation for every fog in the game, at zero per-frame cost: three shared uniforms written when a
 * scene is built or a mood is applied, and a few extra ALU ops per fogged fragment (or vertex).
 *
 * The model. The base fog stays three.js's FogExp2, `fog = 1 - exp(-(density * L)^2)` over the ray's length
 * L, because that curve is the existing look. Height fog multiplies the exponent by `hfMul`, the average over
 * the camera -> fragment ray of
 *
 *     m(y) = max(HF_MIN, (1 + gain * exp(-(y - floor) / falloff)) / (1 + gain * exp(-(street - floor) / falloff)))
 *
 * i.e. density rising toward `floor` and decaying with altitude, normalised so m(street level) = 1: the
 * street looks exactly as it did before height fog on every mood, the river channel below it thickens, and
 * decks, the bluff and the highway above it thin out (never below HF_MIN, so high ground is never fogless).
 * The average along a straight ray has a closed form (the exponential's integral over the segment, divided by
 * the height change; the level-ray case falls back to the midpoint value), so it needs only the heights of the
 * two ends, not a march. With gain 0 the multiplier is exactly 1 (plain FogExp2). Because m can be below 1,
 * the fog is thinner than the base up high, so culling by `fogCutoff` must use the density at the thinnest
 * point (see FOG_HEIGHT.min and render/scene.ts).
 *
 * Three ways in, by who owns the fog:
 *  - Built-in materials (`MeshStandard`, `MeshBasic`, points, sprites) use three's `fog_fragment` chunk.
 *    `applyHeightFog(root)` wraps each one's `onBeforeCompile` (the earlier one runs first) to swap in the
 *    height version, and makes the program cache key differ from the unpatched one.
 *  - Additive light on the road (washes, glints, pools) fades to black in fog rather than to the fog
 *    colour; those materials call `heightFogShader(shader, true)` from their own `onBeforeCompile`.
 *  - Hand-written `ShaderMaterial`s compute their own fog; they splice `HEIGHT_FOG_GLSL` in, spread
 *    `HEIGHT_FOG_UNIFORMS` into their uniforms and multiply their exponent by `hfMulView(viewPosition)`
 *    (or `hfMul(worldPosition)`).
 */
import * as THREE from 'three';
import { CITY } from '../city/config';

/** Height fog defaults. The mood (render/sky/weather.ts `MoodDef.heightGain`) overrides `gain`. */
export const FOG_HEIGHT = {
  /** World height (m) where the haze is deepest: the river channel's floor, the lowest ground in a city. */
  floor: -CITY.districts.river.depth,
  /** Altitude (m) over which the extra density falls to 1/e. */
  falloff: 18,
  /** Contrast: the extra density at `floor` over the base, before normalising to street level. Applies to the exponent (density squared). */
  gain: 1.2,
  /** World height (m) where the multiplier is exactly 1: street level, so the city looks as it did without height fog. */
  street: 0,
  /**
   * The lowest multiplier high ground gets (decks, the bluff): thinner than the street, never fogless. The
   * chunk and prop culling in render/scene.ts runs on `density * sqrt(min)`, the effective density at that
   * thinnest point, so a fogged layer is still fully fogged (inside `CHUNKS.fogEps`) before it is cut off.
   */
  min: 0.7,
} as const;

/**
 * The shared uniform values. Every program's uniform table points at these SAME `{ value }` objects, so one
 * write in `setHeightFog` reaches every material and nothing is copied or pushed per frame. Starts at gain 0
 * (plain FogExp2) until a scene applies its mood.
 */
export const HEIGHT_FOG = {
  /** World height (m) of the deepest haze. */
  floor: { value: FOG_HEIGHT.floor as number },
  /** Altitude (m) over which the haze falls to 1/e. */
  falloff: { value: FOG_HEIGHT.falloff as number },
  /** Contrast of the haze; 0 is no height fog. */
  gain: { value: 0 },
  /** 1 / (1 + gain * exp(-(street - floor) / falloff)): scales the raw multiplier to 1 at street level. */
  norm: { value: 1 },
  /** Lowest multiplier (FOG_HEIGHT.min). */
  min: { value: FOG_HEIGHT.min as number },
};

/** The same objects under the uniform names the GLSL declares; spread into a ShaderMaterial's `uniforms`. */
export const HEIGHT_FOG_UNIFORMS = {
  hfFloor: HEIGHT_FOG.floor,
  hfFalloff: HEIGHT_FOG.falloff,
  hfGain: HEIGHT_FOG.gain,
  hfNorm: HEIGHT_FOG.norm,
  hfMin: HEIGHT_FOG.min,
};

/** Set the haze for the scene about to render (on build and on a mood apply, never per frame). Metres. */
export function setHeightFog(floor: number, falloff: number, gain: number): void {
  HEIGHT_FOG.floor.value = floor;
  HEIGHT_FOG.falloff.value = Math.max(0.5, falloff);
  HEIGHT_FOG.gain.value = Math.max(0, gain);
  HEIGHT_FOG.norm.value = 1 / (1 + HEIGHT_FOG.gain.value * Math.exp(-Math.max(FOG_HEIGHT.street - floor, 0) / HEIGHT_FOG.falloff.value));
}

/**
 * GLSL for either stage (a vertex or a fragment shader that fogs itself): the uniforms and
 *  - `hfMul(wp)`: the density multiplier averaged over the ray from the camera to world position `wp`;
 *  - `hfMulView(mv)`: the same from a view-space position (a vertex shader's `mv.xyz`; the view matrix is
 *    rigid, so its inverse is its transpose);
 *  - `heightFogFactor(wp, density)`: the finished fog amount 0..1 over the straight-line distance.
 * Heights below the floor count as the floor, which keeps the exponential bounded; the result is 1 at street level and never below hfMin.
 */
export const HEIGHT_FOG_GLSL = /* glsl */ `
uniform float hfFloor;
uniform float hfFalloff;
uniform float hfGain;
uniform float hfNorm;
uniform float hfMin;
float hfMul(vec3 wp) {
  float y0 = max(cameraPosition.y - hfFloor, 0.0) / hfFalloff;
  float y1 = max(wp.y - hfFloor, 0.0) / hfFalloff;
  float dy = y1 - y0;
  // Mean of exp(-s) for s in [y0, y1]: (e^-y0 - e^-y1) / dy, its midpoint value when the ray is level.
  float mean = abs(dy) < 0.01 ? exp(-0.5 * (y0 + y1)) : (exp(-y0) - exp(-y1)) / dy;
  return max((1.0 + hfGain * mean) * hfNorm, hfMin);
}
float hfMulView(vec3 mv) {
  return hfMul(cameraPosition + transpose(mat3(viewMatrix)) * mv);
}
float heightFogFactor(vec3 wp, float density) {
  float L = length(wp - cameraPosition);
  return 1.0 - exp(-density * density * L * L * hfMul(wp));
}
`;

/** The slice of three's shader object that `onBeforeCompile` receives. */
interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
}

/**
 * Give a built-in material's program the height fog: reconstruct the world position in the vertex shader
 * from `fog_vertex`'s `mvPosition` (no extra uniform, so instanced, batched and skinned meshes work as they
 * are), declare the shared uniforms, and replace `fog_fragment` with the same chunk whose exponent carries
 * `hfMul`. `additive` fades the colour to black instead of mixing it toward the fog colour (light added on
 * top must not make a far district glow). Idempotent, and a no-op for a shader that lacks one of the four
 * fog chunks (a custom shader that dropped them).
 */
export function heightFogShader(shader: ShaderSource, additive = false): boolean {
  if (shader.fragmentShader.includes('vHfWorld')) return true;
  const needs = (src: string, chunk: string) => src.includes(`#include <${chunk}>`);
  if (!needs(shader.vertexShader, 'fog_pars_vertex') || !needs(shader.vertexShader, 'fog_vertex')) return false;
  if (!needs(shader.fragmentShader, 'fog_pars_fragment') || !needs(shader.fragmentShader, 'fog_fragment')) return false;
  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\n#ifdef USE_FOG\nvarying vec3 vHfWorld;\n#endif')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\n#ifdef USE_FOG\nvHfWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif');
  const blend = additive ? 'gl_FragColor.rgb *= 1.0 - fogFactor;' : 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>\n#ifdef USE_FOG\nvarying vec3 vHfWorld;\n${HEIGHT_FOG_GLSL}\n#endif`)
    .replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * hfMul( vHfWorld ) );
        #else
          float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        ${blend}
      #endif`,
    );
  Object.assign(shader.uniforms, HEIGHT_FOG_UNIFORMS);
  return true;
}

const patched = new WeakSet<THREE.Material>();
const defaultKey = THREE.Material.prototype.customProgramCacheKey;

/**
 * Patch one built-in material's fog (see the module note). Chains whatever `onBeforeCompile` it already has
 * (it runs first and may replace the fog chunk itself, in which case it calls `heightFogShader`), and
 * extends the program cache key: three keys a program by `customProgramCacheKey()`, which defaults to the
 * `onBeforeCompile` source text, so without the suffix a patched and an unpatched material with the same
 * source would share (and fight over) one program. Shader materials, materials that do not fog and ones
 * already patched are left alone.
 */
export function heightFogMaterial(m: THREE.Material): void {
  if (patched.has(m) || (m as THREE.ShaderMaterial).isShaderMaterial || (m as { fog?: boolean }).fog !== true) return;
  patched.add(m);
  const prevCompile = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prevCompile.call(this, shader, renderer);
    heightFogShader(shader as unknown as ShaderSource);
  };
  m.customProgramCacheKey = function (this: THREE.Material) {
    return `${prevKey === defaultKey ? prevCompile.toString() : prevKey.call(this)}|hfog`;
  };
  m.needsUpdate = true;
}

/**
 * Height fog for every fogging built-in material under `root`: call once after a scene is built, and again
 * on a subtree that is added later (traffic, rival cars). Cheap to repeat: patched materials are skipped.
 */
export function applyHeightFog(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(heightFogMaterial);
    else heightFogMaterial(m);
  });
}
