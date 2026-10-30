/**
 * Height fog: the scene's exponential fog thickens near the ground and thins with altitude, so the channel
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
 * i.e. density rising toward `floor` and decaying with altitude, normalised so m(street level) = 1 (the world's
 * floor is its lowest drivable ground, `lowestGround`, and `falloff` and `gain` follow from it and the mood's
 * `pool` ratio, see `setHeightFog`): the
 * street looks exactly as it did before height fog on every mood, the channel below it thickens, and
 * decks, the bluff and the highway above it thin out (never below HF_MIN, so high ground is never fogless).
 * The average along a straight ray has a closed form (the exponential's integral over the segment, divided by
 * the height change; the level-ray case falls back to the midpoint value), so it needs only the heights of the
 * two ends, not a march. With gain 0 the multiplier is exactly 1 (plain FogExp2). Because m can be below 1,
 * the fog is thinner than the base up high, so culling by `fogCutoff` must use the density at the thinnest
 * point (see FOG_HEIGHT.min and render/scene.ts).
 *
 * The haze also takes colour. Dark fog is invisible against an unlit night, so where the multiplier rises
 * above 1 the fog colour lifts toward the home's light pollution tint (`hfGlow`), by `FOG_HEIGHT.glow.amount`
 * of the way at the floor and not at all at street level or above: a pool of lit haze in the channel, the
 * street's colour unchanged. The lift reads the same ray average as the density (`hfFogColor`), so it lives in
 * the shared GLSL; the built-in materials' fog chunk calls it, and so do the hand-written shaders that mix to
 * the fog colour (they use the camera's height, `hfFogColorCam`: they are small effects close to it).
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
import type { World } from '../city/world';

/** Height fog defaults. The mood (render/sky/weather.ts `MoodDef.heightPool`) overrides `pool`. */
export const FOG_HEIGHT = {
  /** World height (m) of the deepest haze when a world has no low ground of its own (the channel's depth); `lowestGround` replaces it per world. */
  floor: -CITY.districts.channel.depth,
  /** Falloffs between street level and the floor: the haze is e^-spans (about a sixth) of its floor strength at the street, before normalising. */
  spans: 1.8,
  /** The falloff (m) stays between these, so a shallow world still gets a pool and a very deep one a gradient. */
  falloff: [6, 18],
  /** The fog exponent's multiplier at the floor over the street's (about 2.6x): applies to the exponent (density squared). Set per world and mood by `setHeightFog`, which turns it into the gain. */
  pool: 2.6,
  /** The pool ratio is capped at this share of its ceiling (street / floor haze, reached only by an endless gain), so a clamped falloff keeps the gain finite. */
  poolCap: 0.85,
  /** The floor stays between these (m): a world's lowest ground clamps to it. */
  floorRange: [-20, -2],
  /**
   * The haze's colour: the fog lifts toward the home's tint (identity `tint.hue`, set per scene) scaled to this
   * linear luminance, by `amount` of the way at the floor (scaling with the pool's depth, 0 at street level).
   */
  glow: { level: 0.28, amount: 1 },
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
  falloff: { value: FOG_HEIGHT.falloff[1] as number },
  /** Contrast of the haze; 0 is no height fog. */
  gain: { value: 0 },
  /** 1 / (pool - 1): scales (m - 1) to 0..1 over the pool's depth, for the colour lift. */
  poolK: { value: 0 },
  /** The haze's colour (linear): the fog colour lifts toward it. */
  glow: { value: new THREE.Color(0x000000) },
  /** How far the colour lifts at the floor (0..1); 0 leaves the fog colour alone. */
  lift: { value: 0 },
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
  hfPoolK: HEIGHT_FOG.poolK,
  hfGlow: HEIGHT_FOG.glow,
  hfLift: HEIGHT_FOG.lift,
  hfNorm: HEIGHT_FOG.norm,
  hfMin: HEIGHT_FOG.min,
};

/**
 * The lowest ground a car can be on in `world` (m): the least height over the road graph's nodes, the channel
 * channel's centreline and the lake's shore, kept inside FOG_HEIGHT.floorRange. A world with none of them
 * deeper than the range's top gets the default floor. Called once per scene build.
 */
export function lowestGround(world: World): number {
  const [deepest, shallowest] = FOG_HEIGHT.floorRange;
  let low = Infinity;
  for (const n of world.graph.nodes) low = Math.min(low, world.heightAt(n.x, n.z));
  for (const a of world.areas) {
    if (a.kind !== 'channel' && a.kind !== 'lake') continue;
    for (const p of a.path.length ? a.path : a.polygon) low = Math.min(low, world.heightAt(p.x, p.z));
  }
  if (!Number.isFinite(low) || low >= shallowest) return FOG_HEIGHT.floor;
  return Math.max(deepest, low);
}

/**
 * Set the haze for the scene about to render (on build and on a mood apply, never per frame). `floor` is the
 * world's lowest ground (m, `lowestGround`), `pool` the fog exponent's multiplier there over the street's
 * (FOG_HEIGHT.pool, the mood's), `glow` the haze's tint (sRGB hex, the home's light pollution hue; omitted
 * or 0 keeps the fog colour). The falloff puts `FOG_HEIGHT.spans` of them between the street and the floor
 * (kept inside FOG_HEIGHT.falloff), and the gain follows: with s = e^-(street - floor)/falloff,
 * pool = (1 + gain) / (1 + gain * s), so gain = (pool - 1) / (1 - pool * s).
 */
export function setHeightFog(floor: number, pool: number, glow = 0): void {
  const depth = Math.max(FOG_HEIGHT.street - floor, 1);
  const [fMin, fMax] = FOG_HEIGHT.falloff;
  const falloff = Math.min(fMax, Math.max(fMin, depth / FOG_HEIGHT.spans));
  const s = Math.exp(-depth / falloff);
  // The ceiling of the ratio is 1 / s: a shallow world cannot pool as hard as a canyon, whatever the mood asks.
  const ratio = Math.max(1, Math.min(pool, (FOG_HEIGHT.poolCap / s)));
  HEIGHT_FOG.floor.value = floor;
  HEIGHT_FOG.falloff.value = falloff;
  HEIGHT_FOG.gain.value = (ratio - 1) / (1 - ratio * s);
  HEIGHT_FOG.norm.value = 1 / (1 + HEIGHT_FOG.gain.value * s);
  HEIGHT_FOG.poolK.value = ratio > 1 ? 1 / (ratio - 1) : 0;
  // The tint at the glow's own linear luminance, so the lift moves how bright the haze is by `level`, whatever the hue.
  const c = HEIGHT_FOG.glow.value.setHex(glow);
  c.multiplyScalar(FOG_HEIGHT.glow.level / Math.max(1e-6, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b));
  HEIGHT_FOG.lift.value = glow ? FOG_HEIGHT.glow.amount : 0;
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
uniform float hfPoolK;
uniform vec3 hfGlow;
uniform float hfLift;
// The multiplier before the HF_MIN floor: 1 at street level, up to the pool's ratio at the floor.
float hfRaw(vec3 wp) {
  float y0 = max(cameraPosition.y - hfFloor, 0.0) / hfFalloff;
  float y1 = max(wp.y - hfFloor, 0.0) / hfFalloff;
  float dy = y1 - y0;
  // Mean of exp(-s) for s in [y0, y1]: (e^-y0 - e^-y1) / dy, its midpoint value when the ray is level.
  float mean = abs(dy) < 0.01 ? exp(-0.5 * (y0 + y1)) : (exp(-y0) - exp(-y1)) / dy;
  return (1.0 + hfGain * mean) * hfNorm;
}
float hfMul(vec3 wp) {
  return max(hfRaw(wp), hfMin);
}
// The fog colour lifted toward the haze's tint by how deep in the pool the ray sits (0 at street level and above).
vec3 hfFogColor(vec3 base, vec3 wp) {
  float pool = clamp((hfRaw(wp) - 1.0) * hfPoolK, 0.0, 1.0);
  return mix(base, hfGlow, pool * hfLift);
}
// The same at the camera's height, for small effects (smoke, steam, marks) that have no world position in the fragment.
vec3 hfFogColorCam(vec3 base) {
  return hfFogColor(base, cameraPosition);
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
  const blend = additive ? 'gl_FragColor.rgb *= 1.0 - fogFactor;' : 'gl_FragColor.rgb = mix( gl_FragColor.rgb, hfFogColor( fogColor, vHfWorld ), fogFactor );';
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
