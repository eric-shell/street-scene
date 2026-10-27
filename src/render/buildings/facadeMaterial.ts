/**
 * Materials for the building shells (buildings.ts):
 *
 * Facade: a MeshStandardMaterial patched to read the facade atlas
 * (facadeAtlas.ts) as channel weights and compose the albedo from three
 * per-building colors (wall tint per vertex, trim and glass from small
 * palettes), so one texture array dresses every style in every palette.
 * Window light is procedural per module: whether it is lit (office floors
 * light together, homes window by window), its color temperature,
 * brightness, blinds or curtains, a few restless windows switching on and off
 * over minutes and blue TV flicker. Each building hashes its own seed, so no
 * two light up alike. Far away, where a pixel covers several windows, the
 * dice fade to their average so distant towers never sparkle. On top come
 * per-vertex facade washes (deco crown floods, Miami pastel uplights) and a
 * warm bounce from the street that fades with height, which is what makes
 * the architecture readable at night without real lights.
 *
 * Aviation lights: camera-facing additive dots on tall roofs and masts that
 * blink red on a slow cycle (a few burn steady), never smaller than a few
 * pixels so they do not shimmer.
 */
import * as THREE from 'three';
import { FacadeAtlas } from './facadeAtlas';
import { FOG_COLOR, FOG_DENSITY } from '../lighting';
import { kelvin } from '../textures/textures';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';

/** Trim colors (sills, lintels, frames, mullions, cornices) by index, sRGB hex. */
export const TRIM_COLORS = [0xf2eee6, 0xe6d8bc, 0xcfc6b4, 0x5a4a3a, 0x1c1d22, 0x9aa0a8, 0xf4c9d6, 0xc8f0e4, 0xd8c8f0, 0x2f5a4a, 0x7a2a22, 0xfff3c4, 0x3a4250, 0xb08850, 0x8fb8d8, 0xffffff] as const;
/** Glass colors by index, sRGB hex. */
export const GLASS_COLORS = [0x1a2230, 0x2a4a6a, 0x2a5a52, 0x5a4630, 0x6a7480, 0x101216, 0x2a6a78, 0x3a3050, 0x22303a, 0x6a5a40, 0x3a5a7a, 0x445566, 0x1e3a5a, 0x50606a, 0x2a3a2a, 0x4a4a52] as const;

/** Interior light temperatures (K): homes, warm offices, cool offices, sodium, cold screens. */
const LAMPS_K = [2700, 3400, 5200, 2150, 7200] as const;

export interface FacadeOptions {
  /** Restless windows and TV flicker (animated); off on Low. */
  live: boolean;
}

export interface FacadeMaterials {
  facade: THREE.MeshStandardMaterial;
  aviation: THREE.ShaderMaterial;
  /** Advance the animated parts (s). */
  update(time: number): void;
  dispose(): void;
}

const linear = (hex: number) => new THREE.Color(hex);

export function createFacadeMaterials(atlas: FacadeAtlas, opts: FacadeOptions): FacadeMaterials {
  const uniforms = {
    uFacade: { value: atlas.layers },
    uTime: { value: 0 },
    uTrim: { value: TRIM_COLORS.map(linear) },
    uGlass: { value: GLASS_COLORS.map(linear) },
    uLamp: { value: LAMPS_K.map((k) => new THREE.Color(kelvin(k))) },
    // Sodium streetlight bounce on the lower floors (linear, times albedo).
    uStreetGlow: { value: new THREE.Color(0xffb46a).multiplyScalar(0.22) },
    // Night sky color reflected by glass at grazing angles (linear).
    uSkySheen: { value: new THREE.Color(0x3a3a7a).multiplyScalar(0.55) },
    uWindowGain: { value: 1.1 },
  };
  const facade = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0, envMapIntensity: 0.55 });
  facade.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (opts.live) shader.defines = { ...shader.defines, FACADE_LIVE: '' };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec2 aMod;
        attribute vec4 aFacade;
        attribute vec4 aGlow;
        attribute vec3 aTint;
        varying vec2 vMod;
        flat varying vec4 vFacade;
        varying vec4 vGlow;
        flat varying vec3 vTint;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vMod = aMod;
        vFacade = aFacade;
        vGlow = aGlow;
        vTint = aTint;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform highp sampler2DArray uFacade;
        uniform float uTime;
        uniform vec3 uTrim[16];
        uniform vec3 uGlass[16];
        uniform vec3 uLamp[5];
        uniform vec3 uStreetGlow;
        uniform vec3 uSkySheen;
        uniform float uWindowGain;
        // Per building constants are flat: interpolating them adds float noise that the window hash
        // would amplify into per pixel speckle.
        varying vec2 vMod;
        flat varying vec4 vFacade;
        varying vec4 vGlow;
        flat varying vec3 vTint;
        float fHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec4 facTex = texture(uFacade, vec3(vMod * 0.125, vFacade.x));
        float fFlags = floor(vFacade.w + 0.5);
        vec3 trimCol = uTrim[int(mod(floor(fFlags / 2.0), 16.0))];
        vec3 glassCol = uGlass[int(mod(floor(fFlags / 32.0), 16.0))];
        diffuseColor.rgb *= facTex.r * vTint + facTex.g * trimCol + facTex.b * glassCol;
        float glassCov = facTex.a;`,
      )
      // Glass is glossier than masonry but not a mirror: the night environment map is full of small
      // lights, and a sharp reflection of them reads as speckle in every window.
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.42, glassCov);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(metalness, 0.35, glassCov);')
      .replace(
        '#include <emissivemap_fragment>',
        `{
          vec2 cell = floor(vMod);
          vec2 lc = fract(vMod);
          float sd = floor(vFacade.y * 4093.0 + 0.5);
          float density = vFacade.z;
          float office = mod(fFlags, 2.0);
          // Offices light whole floors in runs of a few bays (one tenant's lights); homes window by window.
          vec2 unit = office > 0.5 ? vec2(floor(cell.x / 4.0), cell.y) : cell;
          float fh = fHash(vec2(cell.y * 1.31 + sd, sd * 0.71));
          float wh = fHash(unit + sd);
          float pLit = office > 0.5 ? (fh < density ? 0.8 : 0.04) : density * (0.3 + 1.4 * fh * fh);
          float r = wh;
          #ifdef FACADE_LIVE
            float restless = step(0.93, fHash(cell * 1.73 + sd));
            float period = 45.0 + 120.0 * fHash(cell.yx * 0.91 + sd);
            float epoch = floor(uTime / period + wh * 9.0);
            r = mix(wh, fHash(cell * 0.77 + epoch * 13.1 + sd), restless);
          #endif
          float lit = step(r, pLit);
          float kc = mix(fHash(cell * 2.31 + sd * 1.7), fHash(vec2(unit.x * 0.53 + cell.y * 0.37, sd)), office);
          vec3 lampCol = office > 0.5
            ? (kc < 0.45 ? uLamp[1] : kc < 0.94 ? uLamp[2] : uLamp[4])
            : (kc < 0.55 ? uLamp[0] : kc < 0.78 ? uLamp[1] : kc < 0.9 ? uLamp[3] : kc < 0.96 ? uLamp[2] : uLamp[4]);
          float bright = office > 0.5 ? 0.45 + 0.35 * fHash(unit * 3.17 + sd) : 0.5 + 0.7 * fHash(cell * 3.17 + sd);
          float px = max(fwidth(vMod.x), fwidth(vMod.y));
          float shade = fHash(cell * 4.71 + sd);
          float filt = 1.0;
          // Blinds: fine slats that fade to their average before they can alias into speckle.
          if (shade < 0.2) filt = mix(0.62 + 0.38 * step(0.5, fract(lc.y * 16.0)), 0.81, smoothstep(0.012, 0.035, px));
          else if (shade < 0.34) filt = 0.3 + 0.7 * smoothstep(0.06, 0.3, min(lc.x, 1.0 - lc.x));
          else if (shade < 0.42) filt = mix(0.35, 1.15, lc.y);
          #ifdef FACADE_LIVE
            float tv = (1.0 - office) * step(0.955, fHash(cell * 5.93 + sd));
            float flick = 0.55 + 0.25 * sin(uTime * (7.0 + 9.0 * wh) + wh * 40.0) + 0.2 * sin(uTime * 2.3 + wh * 17.0);
            lampCol = mix(lampCol, vec3(0.32, 0.5, 1.0), tv);
            bright *= mix(1.0, flick, tv);
            lit = max(lit, tv);
          #endif
          // A few apartments glow with colored LED strips: magenta through violet to cyan.
          float party = (1.0 - office) * lit * step(0.972, fHash(cell * 6.37 + sd));
          lampCol = mix(lampCol, mix(vec3(1.0, 0.18, 0.75), vec3(0.15, 0.8, 1.0), fHash(cell * 7.1 + sd)), party);
          // A pixel spanning several windows shows their average instead of flickering between them.
          float far = smoothstep(0.3, 1.0, px);
          vec3 avgCol = office > 0.5 ? (uLamp[2] * 0.55 + uLamp[1] * 0.45) * 0.62 : uLamp[0] * 0.65 + uLamp[1] * 0.35;
          float avgLit = office > 0.5 ? density * 0.77 + 0.04 : density * 0.77;
          vec3 win = mix(lampCol * bright * filt * lit, avgCol * 0.82 * avgLit, far);
          vec3 albedo = diffuseColor.rgb;
          // Dark glass catches the night sky at grazing angles, so unlit towers keep their shape.
          float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 4.0);
          totalEmissiveRadiance = win * glassCov * uWindowGain
            + glassCov * (1.0 - lit) * fres * uSkySheen * (0.4 + glassCol * 2.0)
            + albedo * vGlow.rgb
            + albedo * uStreetGlow * exp(-max(vGlow.a, 0.0) * 0.11) * (1.0 - glassCov * 0.6);
        }`,
      );
  };
  facade.customProgramCacheKey = () => `facade:${opts.live ? 1 : 0}`;

  const aviation = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, fogColor: { value: new THREE.Color(FOG_COLOR) }, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS },
    vertexShader: AVIATION_VERT,
    fragmentShader: AVIATION_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  return {
    facade,
    aviation,
    update(time) {
      uniforms.uTime.value = time;
    },
    dispose() {
      facade.dispose();
      aviation.dispose();
    },
  };
}

const AVIATION_VERT = /* glsl */ `
  attribute vec2 corner;
  attribute vec2 light;
  uniform float uTime;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vCorner;
  varying float vI;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = length(mv.xyz);
    // World size of about 3 px at 1080p, never below the lamp's own 0.45 m.
    float px = dist / (projectionMatrix[1][1] * 540.0);
    float size = max(0.45, px * 3.0);
    mv.xy += corner * size;
    gl_Position = projectionMatrix * mv;
    vCorner = corner;
    float t = fract(uTime * 0.52 + light.x);
    float blink = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.28, 0.42, t));
    float on = light.y > 0.5 ? 0.75 : blink;
    vI = on * exp(-fogDensity * fogDensity * dist * dist * 0.35 * hfMulView(mv.xyz));
  }
`;

const AVIATION_FRAG = /* glsl */ `
  uniform vec3 fogColor;
  varying vec2 vCorner;
  varying float vI;
  void main() {
    float d = length(vCorner);
    float core = smoothstep(0.55, 0.15, d);
    float halo = smoothstep(1.0, 0.2, d) * 0.35;
    gl_FragColor = vec4(vec3(1.0, 0.09, 0.04) * (core * 5.0 + halo) * vI, 1.0);
  }
`;
