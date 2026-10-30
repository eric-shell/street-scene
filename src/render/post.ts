/**
 * Post processing chain: scene (optional MSAA) -> bloom (neon) -> vignette +
 * speed radial blur + nitrous warp + colour grade -> tone mapping/sRGB output
 * -> optional retro PS2 quantize + dither.
 *
 * Colour grade (setGrade): the seed's city identity (cityIdentity.ts) gives
 * each city its night: lift, gamma and gain per channel, split toning (a
 * shadow tint and a highlight tint, keyed on luminance), saturation and, at
 * High only, film grain. It rides in the FxShader pass that already runs, so
 * it costs a few dozen ALU per pixel and no extra pass. It runs before the
 * OutputPass, on linear HDR: lift and gain are then true offsets and scales of
 * light (an offset after ACES would grey the blacks and shift with exposure),
 * and the split toning keys on a luminance curve that never saturates, so a
 * neon tube at 30x and a lamp pool at 2x still sort as highlights. Tints are
 * luminance neutral and both they and the saturation fade out on strongly
 * saturated pixels: the grade lands on the warm, grimy city and leaves the
 * neon, the route's cyan and the hazard amber electric.
 *
 * Nitrous warp (setNitroFx): outside the middle 50% of the screen the frame
 * turns fluid. It stretches outward (samples pulled toward the vanishing point,
 * more the further out), flows like liquid streaming past (a moving domain
 * warp), blurs harder toward the edges, gains contrast and saturation there
 * and splits into colour fringes; the bloom strengthens overall. Inside the
 * middle 50% nothing changes, so the road ahead stays readable. Each nitrous
 * stage runs it harder and turns the edge glow from cold blue through violet
 * to hot pink, the HUD bar's stage colors. NITRO_FX holds the numbers.
 *
 * Heat haze (setHaze, `uHaze`): up to six screen space blobs behind the nearest hot exhausts and over hot brakes bend the picture
 * with two sines drifting up the blob, so the air reads as rising. exhaustFx.ts projects the tips and fills
 * `hazeBlobs` (x, y screen UV, radius in screen heights, strength); with no blob (`uHazeN` 0) the pass skips it.
 *
 * Bloom stability: the stock UnrealBloomPass extracts bright pixels with one
 * bilinear tap per texel of a buffer 2x-8x smaller than the scene, with a hard
 * threshold. Sub-pixel emitters (distant lamp lenses, window lights, neon
 * edges) then land on a sampled texel one frame and between texels the next,
 * so their glow pops on and off as the camera moves. StableBloomPass replaces
 * that extraction with a prefilter that covers the whole footprint, weights
 * taps with a Karis average, clamps fireflies, drops NaN/Inf and uses a soft
 * knee, and keeps the bloom mip chain at exact halvings.
 *
 * NaN containment (FINITE_GLSL): one NaN pixel from any scene shader used to
 * reach the bloom on Macs, because ANGLE's Metal backend may compile isnan()
 * and isinf() with fast math and fold them to false. The blur spread it to
 * every mip, the composite made the whole frame NaN, and the canvas (three.js
 * always asks for an alpha channel) went see-through to the page behind it. The
 * prefilter and every FX tap now test the bits, which no optimiser can fold, so
 * a bad pixel stays a black pixel; the FX pass writes alpha 1 so the canvas is
 * opaque whatever reaches it. frameWatch.ts finds where a NaN came from.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import type { Quality } from '../ui/settings';

/**
 * Nitrous warp at full strength, all ramping from the edge of the middle 50% of
 * the screen (`inner`, as a fraction of the half screen) to the frame edge:
 * stretch (fraction of the distance to the vanishing point), fluid flow (uv
 * offset of the moving domain warp), extra zoom blur at the edge (multiplier),
 * colour fringe (uv split), saturation and contrast at the edge (1 = none),
 * the edge glow, and the bloom strength multiplier (whole frame). Per nitrous
 * stage (1..3): the warp's strength (1 = the numbers above) and the edge
 * glow's color (linear RGB).
 */
export const NITRO_FX = {
  inner: 0.5,
  stretch: 0.34,
  flow: 0.012,
  blurEdge: 2.2,
  fringe: 0.012,
  saturation: 1.5,
  contrast: 1.35,
  edgeTint: 0.05,
  bloom: 1.45,
  stageWarp: [1, 1.2, 1.4],
  stageTint: [
    [0.25, 0.55, 1],
    [0.62, 0.42, 1],
    [1, 0.36, 0.68],
  ],
} as const;

/** Zoom blur taps per tier (the shader loop runs up to 11): the streak is fewer, coarser samples on weaker devices, jittered per pixel either way. */
export const POST_TAPS: Record<Quality, number> = { low: 4, medium: 7, high: 11 };

/**
 * Speed streaks (radial speed lines at the frame edge, FxShader `streak`): the tier's strength, 0 on Low (no streaks at all, the uniform
 * stays 0 and the shader's branch is skipped), a little softer on Medium. Cost where on: no texture taps, one atan, two hashes and a
 * few smoothsteps (~35 ALU) only for pixels outside the middle ~55% of the frame; one uniform branch (free) when off.
 */
export const POST_STREAKS: Record<Quality, number> = { low: 0, medium: 0.8, high: 1 };

/** Speed streak look: the ellipse radius (0 centre, 1 frame edge) they fade in over, lines around the screen, share of lines drawn, additive brightness (linear light) at full strength, line width (share of a cell) and how fast they fly outward (cycles/s). */
const STREAKS = { inner: 0.55, outer: 0.95, lines: 84, share: 0.4, gain: 0.3, width: 0.12, rate: 1.7 } as const;

/** Film grain per tier (a share of the grade's own grain): High only, it is a per pixel hash every frame for a look, not legibility. */
export const POST_GRAIN: Record<Quality, number> = { low: 0, medium: 0, high: 1 };

/**
 * Rain on the lens per tier (lensRain in FxShader, bumper and hood cameras on wet nights): how many droplet grids
 * (scales) the pixel evaluates, and the share of the drops that show (their density). Low runs one coarse grid, sparser; Medium and High run two. Every layer is a hash grid cell lookup, no extra texture sample.
 */
export const POST_LENS: Record<Quality, { layers: number; strength: number }> = {
  low: { layers: 1, strength: 0.7 },
  medium: { layers: 2, strength: 1 },
  high: { layers: 2, strength: 1 },
};

/**
 * NaN or Inf by the float's bits (exponent all ones): the test fast math cannot drop (see the header). `scrubRgb`
 * turns a bad colour black. GLSL ES 3.00, which three.js compiles every shader as on WebGL2.
 */
export const FINITE_GLSL = /* glsl */ `
  bool badRgb(vec3 c) { return any(greaterThanEqual(floatBitsToUint(c) & uvec3(0x7fffffffu), uvec3(0x7f800000u))); }
  bool badRgba(vec4 c) { return any(greaterThanEqual(floatBitsToUint(c) & uvec4(0x7fffffffu), uvec4(0x7f800000u))); }
  vec3 scrubRgb(vec3 c) { return badRgb(c) ? vec3(0.0) : c; }
`;

/** Lens droplet look: grid cells across the screen per layer, UV refraction scale (about 0.01 of the frame at the biggest drop's rim) and rim brightness. */
const LENS = {
  cells: [3.5, 7],
  refract: 0.09,
  rim: 0.5,
  /** Drop lifetime clock speed (cycles per second) at rest, and added per m/s of car speed. */
  rate: 0.12,
  rateSpeed: 0.006,
} as const;

/** A colour grade (cityIdentity.ts per home). Tints are sRGB hex; everything else works on linear light. */
export interface GradeParams {
  /** Linear light added to the shadows per channel, fading out up the luminance key (a few thousandths: black stays black). */
  lift: readonly [number, number, number];
  /** Power on each linear channel (1 = none; under 1 lifts that channel's mids). */
  gamma: readonly [number, number, number];
  /** Scale on each linear channel (1 = none). */
  gain: readonly [number, number, number];
  /** Shadow tint (sRGB hex) and how far it pulls (0..1), luminance neutral. */
  shadow: number;
  shadowAmount: number;
  /** Highlight tint (sRGB hex) and how far it pulls (0..1), luminance neutral. */
  highlight: number;
  highlightAmount: number;
  /** Saturation of dull colours (1 = none); saturated colours keep theirs. */
  saturation: number;
  /** Film grain: the noise's share of the pixel's light (about +-half this), times POST_GRAIN of the tier. */
  grain: number;
}

/** No grade: what scenes without a city (the garage's workshop) render with. */
export const NEUTRAL_GRADE: GradeParams = {
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  shadow: 0xffffff,
  shadowAmount: 0,
  highlight: 0xffffff,
  highlightAmount: 0,
  saturation: 1,
  grain: 0,
};

/**
 * Grade constants: the linear luminance where the split toning crosses from shadow to highlight tint (a night
 * frame lives mostly well below 0.18 grey, so the pivot sits lower), the chroma band over which saturated
 * pixels are let off the tints and the saturation, and how much grain highlights keep (they show it least).
 */
export const GRADE = { pivot: 0.1, protect: [0.55, 0.95], grainHighlights: 0.35 } as const;

const FxShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.35 },
    blur: { value: 0.0 },
    uTaps: { value: 11 },
    center: { value: new THREE.Vector2(0.5, 0.55) },
    warp: { value: 0.0 },
    time: { value: 0.0 },
    inner: { value: NITRO_FX.inner },
    stretch: { value: NITRO_FX.stretch },
    flow: { value: NITRO_FX.flow },
    blurEdge: { value: NITRO_FX.blurEdge },
    fringe: { value: NITRO_FX.fringe },
    saturation: { value: NITRO_FX.saturation },
    contrast: { value: NITRO_FX.contrast },
    edgeTint: { value: NITRO_FX.edgeTint },
    tint: { value: new THREE.Vector3(...NITRO_FX.stageTint[0]) },
    gLift: { value: new THREE.Vector3(0, 0, 0) },
    gGamma: { value: new THREE.Vector3(1, 1, 1) },
    gGain: { value: new THREE.Vector3(1, 1, 1) },
    gShadow: { value: new THREE.Vector3(1, 1, 1) },
    gHigh: { value: new THREE.Vector3(1, 1, 1) },
    gSat: { value: 1 },
    gGrain: { value: 0 },
    gSeed: { value: new THREE.Vector2() },
    gPivot: { value: GRADE.pivot },
    gProtect: { value: new THREE.Vector2(...GRADE.protect) },
    streak: { value: 0 },
    streakTime: { value: 0 },
    lensRain: { value: 0 },
    lensTime: { value: 0 },
    lensAspect: { value: 16 / 9 },
    lensLayers: { value: 2 },
    uHaze: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) },
    uHazeN: { value: 0 },
    uHazeTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float blur;
    uniform int uTaps;
    uniform vec2 center;
    uniform float warp;
    uniform float time;
    uniform float inner;
    uniform float stretch;
    uniform float flow;
    uniform float blurEdge;
    uniform float fringe;
    uniform float saturation;
    uniform float contrast;
    uniform float edgeTint;
    uniform vec3 tint;
    uniform vec3 gLift;
    uniform vec3 gGamma;
    uniform vec3 gGain;
    uniform vec3 gShadow;
    uniform vec3 gHigh;
    uniform float gSat;
    uniform float gGrain;
    uniform vec2 gSeed;
    uniform float gPivot;
    uniform vec2 gProtect;
    uniform float streak;
    uniform float streakTime;
    uniform float lensRain;
    uniform float lensTime;
    uniform float lensAspect;
    uniform int lensLayers;
    uniform vec4 uHaze[6];
    uniform int uHazeN;
    uniform float uHazeTime;
    varying vec2 vUv;
    const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
    ${FINITE_GLSL}
    float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    // One grid of lens drops: xy the UV refraction, z the rim. A cell holds at most one drop; it is born at a seeded
    // phase, slides down the cell as its clock runs, and the cycle's hash against lensRain decides whether it shows.
    vec3 lensLayer(vec2 uv, float cells, float seed) {
      vec2 p = uv * vec2(cells, cells / lensAspect);
      vec2 id = floor(p);
      vec2 f = fract(p);
      float h0 = hash21(id + seed);
      float h1 = hash21(id + seed + 17.3);
      float h2 = hash21(id + seed + 41.9);
      float clock = lensTime + h0 * 8.0;
      float cyc = floor(clock);
      float t = clock - cyc;
      if (hash21(id + seed + cyc * 3.7) > lensRain * 0.6) return vec3(0.0);
      float r = (0.05 + 0.17 * h2 * h2) * smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.85, 1.0, t));
      vec2 c = vec2(0.3 + 0.4 * h1, mix(0.72, 0.28, t));
      vec2 d = (f - c) / max(r, 1e-3);
      float l = length(d);
      if (l >= 1.0) return vec3(0.0);
      // A lens: the image is flipped and magnified inside, strongest toward the rim.
      vec2 off = -d * (0.35 + l * l) * r * ${LENS.refract.toFixed(3)} * 6.0 / cells;
      float rim = smoothstep(0.88, 0.96, l) * (1.0 - smoothstep(0.96, 1.0, l));
      return vec3(off, rim);
    }
    void main() {
      vec2 uv = vUv;
      float lensRim = 0.0;
      if (lensRain > 0.0) {
        vec3 a = lensLayer(vUv, ${LENS.cells[0].toFixed(1)}, 0.0);
        if (lensLayers > 1) {
          vec3 b = lensLayer(vUv, ${LENS.cells[1].toFixed(1)}, 31.0);
          a = vec3(a.xy + b.xy, max(a.z, b.z));
        }
        uv += a.xy;
        lensRim = a.z;
      }
      vec2 dir0 = vUv - center;
      // Nitrous mask: 0 inside the middle 50% of the screen (an ellipse through
      // the half way marks), ramping to 1 at the frame edge.
      float re = length(dir0 / vec2(0.5, 0.5));
      float m = warp > 0.001 ? smoothstep(inner, 1.05, re) : 0.0;
      if (m > 0.0) {
        float m2 = m * m;
        // Stretch: pull the edge samples toward the vanishing point.
        uv = vUv - dir0 * stretch * warp * m2;
        // Fluid: a moving domain warp, the frame streaming past like liquid.
        vec2 p = uv * vec2(6.0, 4.0);
        vec2 q = vec2(sin(p.y * 1.7 + time * 3.1 + sin(p.x * 1.3 - time * 2.3)), cos(p.x * 1.9 - time * 2.7 + sin(p.y * 1.1 + time * 1.9)));
        // Outward streaming in drifting bands (not rings), so it reads as flow.
        float stream = sin(dot(p, vec2(0.9, 1.4)) - time * 5.0 + q.x) * 0.5 + 0.5;
        uv += (q * 0.6 + normalize(dir0 + 1e-5) * stream) * flow * warp * m;
      }
      if (uHazeN > 0) {
        // Heat haze behind the near exhausts: x, y the blob's centre, z its radius in screen heights, w how far it bends the picture.
        // The shimmer is a pair of sines drifting up the blob, so the air reads as rising.
        for (int i = 0; i < 6; i++) {
          if (i >= uHazeN) break;
          vec4 h = uHaze[i];
          vec2 d = (vUv - h.xy) * vec2(lensAspect, 1.0) / h.z;
          float l2 = dot(d, d);
          if (l2 < 1.0) {
            float fall = (1.0 - l2) * (1.0 - l2);
            vec2 p = d * 3.5 - vec2(0.0, uHazeTime * 3.2);
            vec2 w = vec2(sin(p.y * 4.0 + sin(p.x * 3.1 + uHazeTime * 1.7) * 1.4), cos(p.y * 3.3 + p.x * 2.3 - uHazeTime * 1.1));
            uv += w * h.w * fall * vec2(1.0 / lensAspect, 1.0);
          }
        }
      }
      vec4 c = vec4(scrubRgb(texture2D(tDiffuse, uv).rgb), 1.0);
      float zoom = blur * (1.0 + blurEdge * warp * m);
      if (zoom > 0.001) {
        // Zoom blur from the vanishing point: zero in the middle, growing
        // progressively toward the edges, streaking along the travel direction
        // (much longer at the edges under nitrous). A per pixel jitter of the
        // taps hides the banding of long streaks.
        vec2 dir = uv - center;
        float r = length(dir * vec2(1.25, 1.0));
        float w = pow(smoothstep(0.12, 0.85, r), 1.6);
        // The centre of the frame (w ~ 0) has nothing to streak: skip the taps there.
        if (w >= 0.02) {
          float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / float(uTaps);
          vec3 acc = c.rgb;
          float total = 1.0;
          for (int i = 1; i < 12; i++) {
            if (i > uTaps) break;
            float k = (float(i) - jit) / float(uTaps);
            float wt = 1.0 - k * 0.5;
            acc += scrubRgb(texture2D(tDiffuse, uv - dir * zoom * w * k * 0.16).rgb) * wt;
            total += wt;
          }
          c.rgb = acc / total;
        }
      }
      if (m > 0.0) {
        // Colour fringes split along the stretch.
        vec2 f = dir0 * fringe * warp * m;
        c.r = mix(c.r, scrubRgb(texture2D(tDiffuse, uv + f).rgb).r, m);
        c.b = mix(c.b, scrubRgb(texture2D(tDiffuse, uv - f).rgb).b, m);
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        // Saturation and contrast ramp in from the middle 50% to the edges only.
        c.rgb = max(vec3(0.0), mix(vec3(l), c.rgb, 1.0 + (saturation - 1.0) * warp * m));
        c.rgb = max(vec3(0.0), (c.rgb - 0.18) * (1.0 + (contrast - 1.0) * warp * m) + 0.18);
        // A faint glow creeping in from the edges, in the stage's color.
        c.rgb += tint * edgeTint * warp * m * m;
      }
      if (streak > 0.002) {
        // Speed streaks: thin radial dashes flying outward in a ring of angular cells, only toward the frame edge so the road stays clear.
        vec2 sd = dir0 * vec2(lensAspect, 1.0);
        float sm = smoothstep(${STREAKS.inner.toFixed(2)}, ${STREAKS.outer.toFixed(2)}, re);
        if (sm > 0.0) {
          float sa = atan(sd.y, sd.x) * ${(STREAKS.lines / (2 * Math.PI)).toFixed(4)};
          float cell = floor(sa);
          float h1 = fract(sin(cell * 12.9898 + 4.1) * 43758.5453);
          float h2 = fract(sin(cell * 78.233 + 1.7) * 24634.6345);
          // Only some cells carry a line.
          float on = step(h1, ${STREAKS.share.toFixed(2)});
          float line = 1.0 - smoothstep(0.0, ${STREAKS.width.toFixed(2)}, abs(fract(sa) - 0.5 - (h2 - 0.5) * 0.5));
          // A dash that brightens toward its outer end, like a motion blurred light: the tail fades back toward the centre.
          float t = fract(re * 1.3 - streakTime * ${STREAKS.rate.toFixed(2)} * (0.8 + 0.5 * h2) + h2 * 7.0);
          float dash = smoothstep(0.0, 0.85, t) * (1.0 - smoothstep(0.85, 1.0, t));
          c.rgb += vec3(0.82, 0.9, 1.0) * (on * line * dash * sm * streak * ${STREAKS.gain.toFixed(2)});
        }
      }
      if (lensRim > 0.0) c.rgb = c.rgb * (1.0 + lensRim * ${LENS.rim.toFixed(2)}) + vec3(0.02 * lensRim);
      // Colour grade, on linear HDR (see the header for why before tone mapping).
      vec3 g = pow(max(c.rgb * gGain, vec3(1e-7)), gGamma);
      float gl = dot(g, LUMA);
      // Luminance key: 0 in black, 0.5 at the pivot, toward 1 however bright (never clips like a 0..1 ramp would).
      float key = gl / (gl + gPivot);
      float mx = max(g.r, max(g.g, g.b));
      float keep = smoothstep(gProtect.x, gProtect.y, (mx - min(g.r, min(g.g, g.b))) / max(mx, 1e-5));
      g += gLift * (1.0 - key);
      g *= mix(vec3(1.0), mix(gShadow, gHigh, key), 1.0 - keep);
      g = max(vec3(0.0), mix(vec3(dot(g, LUMA)), g, mix(gSat, 1.0, keep)));
      if (gGrain > 0.0) {
        // Multiplicative, so black stays black; a fresh pattern every frame (gSeed), lighter in the highlights.
        float n = fract(sin(dot(gl_FragCoord.xy + gSeed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        g *= 1.0 + gGrain * n * (1.0 - key * (1.0 - ${GRADE.grainHighlights.toFixed(2)}));
      }
      c.rgb = g;
      vec2 q = vUv - 0.5;
      float v = 1.0 - vignette * smoothstep(0.25, 0.85, length(q * vec2(1.1, 1.0)) * 1.25);
      // Opaque whatever the scene's alpha did: the canvas has an alpha channel, and below 1 the page shows through.
      gl_FragColor = vec4(c.rgb * v, 1.0);
    }
  `,
};

const RetroShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(320, 240) },
  },
  vertexShader: FxShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    varying vec2 vUv;
    float bayer(vec2 p) {
      int x = int(mod(p.x, 4.0));
      int y = int(mod(p.y, 4.0));
      int i = x + y * 4;
      float m[16];
      m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;
      m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
      for (int k = 0; k < 16; k++) if (k == i) return m[k] / 16.0 - 0.5;
      return 0.0;
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = bayer(floor(vUv * resolution));
      vec3 q = floor(c.rgb * 31.0 + d + 0.5) / 31.0;
      gl_FragColor = vec4(q, 1.0);
    }
  `,
};

const PrefilterShader = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 srcTexel;
    uniform vec2 footprint;
    uniform vec2 taps;
    uniform float luminosityThreshold;
    uniform float knee;
    uniform float maxLuma;
    varying vec2 vUv;
    ${FINITE_GLSL}
    void main() {
      vec3 acc = vec3(0.0);
      float wsum = 0.0;
      vec2 stepTx = footprint / taps;
      // taps x taps bilinear fetches spread over the footprint of this bloom
      // texel in the scene buffer, so every scene pixel is seen exactly once.
      for (int y = 0; y < 6; y++) {
        if (float(y) >= taps.y) break;
        for (int x = 0; x < 6; x++) {
          if (float(x) >= taps.x) break;
          vec2 o = (vec2(float(x), float(y)) + 0.5) * stepTx - footprint * 0.5;
          vec3 c = texture2D(tDiffuse, vUv + o * srcTexel).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // NaN / Inf from any shader would smear across the whole blur (by the bits: isnan can be folded away).
          if (badRgb(c) || l > 6.0e4) { c = vec3(0.0); l = 0.0; }
          c = max(c, vec3(0.0));
          l = max(l, 0.0);
          if (l > maxLuma) { c *= maxLuma / l; l = maxLuma; }
          // Soft knee: brightness ramps into the bloom instead of snapping on.
          float a = smoothstep(luminosityThreshold - knee * 0.25, luminosityThreshold + knee, l);
          // Karis average: weight by inverse brightness so a lone hot pixel
          // cannot dominate (or flicker) the whole bloom texel.
          float w = 1.0 / (1.0 + l * a);
          acc += c * a * w;
          wsum += w;
        }
      }
      gl_FragColor = vec4(acc / max(wsum, 1e-4), 1.0);
    }
  `,
};

/** Bloom mip chain sizes are kept at multiples of this so every mip is an exact half. */
const BLOOM_ALIGN = 32;

/** UnrealBloomPass with a flicker resistant bright pass and aligned mip sizes. */
export class StableBloomPass extends UnrealBloomPass {
  /** Bloom resolution relative to the scene buffer. */
  scale = 0.5;
  private readonly prefilter: {
    tDiffuse: { value: THREE.Texture | null };
    luminosityThreshold: { value: number };
    srcTexel: { value: THREE.Vector2 };
    footprint: { value: THREE.Vector2 };
    taps: { value: THREE.Vector2 };
    knee: { value: number };
    maxLuma: { value: number };
  };

  constructor(resolution: THREE.Vector2, strength: number, radius: number, threshold: number) {
    super(resolution, strength, radius, threshold);
    this.prefilter = {
      tDiffuse: { value: null },
      luminosityThreshold: { value: threshold },
      srcTexel: { value: new THREE.Vector2(1, 1) },
      footprint: { value: new THREE.Vector2(2, 2) },
      taps: { value: new THREE.Vector2(1, 1) },
      knee: { value: 0.4 },
      maxLuma: { value: 24 },
    };
    // UnrealBloomPass.render() writes tDiffuse / luminosityThreshold into
    // highPassUniforms and draws materialHighPassFilter: swap both for ours.
    this.materialHighPassFilter.dispose();
    this.highPassUniforms = this.prefilter;
    this.materialHighPassFilter = new THREE.ShaderMaterial({
      uniforms: this.prefilter,
      vertexShader: PrefilterShader.vertexShader,
      fragmentShader: PrefilterShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Called by the composer with the scene buffer size. */
  setSize(width: number, height: number): void {
    const bw = Math.max(BLOOM_ALIGN, Math.ceil((width * this.scale) / BLOOM_ALIGN) * BLOOM_ALIGN);
    const bh = Math.max(BLOOM_ALIGN, Math.ceil((height * this.scale) / BLOOM_ALIGN) * BLOOM_ALIGN);
    super.setSize(bw, bh);
    // The bright target is half the bloom resolution.
    const fx = Math.max(1, width / (bw / 2));
    const fy = Math.max(1, height / (bh / 2));
    this.prefilter.srcTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.prefilter.footprint.value.set(fx, fy);
    this.prefilter.taps.value.set(Math.min(6, Math.ceil(fx / 2)), Math.min(6, Math.ceil(fy / 2)));
  }
}

/** RenderPass that can render through a multisampled target and resolve into the chain. */
class ScenePass extends RenderPass {
  private msaa: THREE.WebGLRenderTarget | null = null;
  private samples = 0;
  private size = new THREE.Vector2(1, 1);
  private copyMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
    vertexShader: CopyShader.vertexShader,
    fragmentShader: CopyShader.fragmentShader,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  });
  private copyQuad = new FullScreenQuad(this.copyMat);

  setSamples(n: number): void {
    if (n === this.samples) return;
    this.samples = n;
    this.msaa?.dispose();
    this.msaa = n > 0 ? new THREE.WebGLRenderTarget(this.size.x, this.size.y, { type: THREE.HalfFloatType, samples: n, stencilBuffer: true }) : null;
  }

  setSize(w: number, h: number): void {
    this.size.set(w, h);
    this.msaa?.setSize(w, h);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    if (!this.msaa) return super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    super.render(renderer, writeBuffer, this.msaa, deltaTime, maskActive);
    // Rendering into the next target resolves the samples; copy into the chain.
    this.copyMat.uniforms.tDiffuse.value = this.msaa.texture;
    renderer.setRenderTarget(readBuffer);
    this.copyQuad.render(renderer);
  }

  dispose(): void {
    this.msaa?.dispose();
    this.copyMat.dispose();
    this.copyQuad.dispose();
  }
}

export class PostFx {
  readonly composer: EffectComposer;
  readonly renderPass: ScenePass;
  readonly bloom: StableBloomPass;
  readonly fx: ShaderPass;
  readonly output: OutputPass;
  readonly retro: ShaderPass;
  /** MSAA on a half float target needs EXT_color_buffer_float. */
  readonly msaaSupported: boolean;
  /** Bloom strength from the quality profile; nitrous scales it up from here. */
  private bloomBase = 0.9;
  private nitro = 0;
  /** The grade's grain and the tier's share of it (POST_GRAIN). */
  private grain = 0;
  private grainTier = 0;
  private grainFrame = 0;
  /** Lens rain: the tier's layers and density share (POST_LENS), the session's amount and the car speed (m/s) that quickens the drops. */
  private lensStrength = 1;
  /** The tier's share of the speed streaks (POST_STREAKS). */
  private streakTier = 1;
  private lensSpeed = 0;
  private readonly gradeColor = new THREE.Color();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    // The stencil lets ground light skip the cars standing in it (vehicleMask.ts).
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, stencilBuffer: true });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new ScenePass(scene, camera);
    this.msaaSupported = renderer.capabilities.maxSamples > 0 && renderer.extensions.has('EXT_color_buffer_float');
    this.bloom = new StableBloomPass(new THREE.Vector2(size.x, size.y), 0.9, 0.4, 0.86);
    this.fx = new ShaderPass(FxShader);
    this.hazeBlobs = this.fx.uniforms.uHaze.value as THREE.Vector4[];
    this.output = new OutputPass();
    this.retro = new ShaderPass(RetroShader);
    this.retro.enabled = false;
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.fx);
    this.composer.addPass(this.output);
    this.composer.addPass(this.retro);
  }

  setScene(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderPass.scene = scene;
    this.renderPass.camera = camera;
  }

  /** Takes effect on the next setSize (GameRenderer always resizes after this). */
  configure(opts: { lens?: { layers: number; strength: number }; bloom: boolean; bloomScale: number; bloomStrength: number; retro: boolean; msaa?: number; taps?: number; grain?: number; streaks?: number }): void {
    this.streakTier = opts.streaks ?? 0;
    this.fx.uniforms.uTaps.value = Math.max(1, Math.min(11, Math.round(opts.taps ?? 11)));
    this.grainTier = opts.grain ?? 0;
    this.fx.uniforms.lensLayers.value = opts.lens?.layers ?? 2;
    this.lensStrength = opts.lens?.strength ?? 1;
    this.fx.uniforms.gGrain.value = this.grain * this.grainTier;
    this.bloom.enabled = opts.bloom;
    this.bloom.scale = opts.bloomScale;
    this.bloomBase = opts.bloomStrength;
    this.bloom.strength = this.bloomBase * (1 + (NITRO_FX.bloom - 1) * this.nitro);
    this.retro.enabled = opts.retro;
    // Retro mode renders a few hundred pixels tall on purpose: no MSAA there.
    this.renderPass.setSamples(this.msaaSupported && !opts.retro ? (opts.msaa ?? 0) : 0);
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.retro.uniforms.resolution.value.set(w * pixelRatio, h * pixelRatio);
    this.fx.uniforms.lensAspect.value = w / Math.max(1, h);
  }

  /** The colour grade of the scene being rendered (GameRenderer sets it whenever the rendered scene changes). */
  setGrade(p: GradeParams): void {
    const u = this.fx.uniforms;
    (u.gLift.value as THREE.Vector3).fromArray(p.lift);
    (u.gGamma.value as THREE.Vector3).fromArray(p.gamma);
    (u.gGain.value as THREE.Vector3).fromArray(p.gain);
    this.splitTint(u.gShadow.value as THREE.Vector3, p.shadow, p.shadowAmount);
    this.splitTint(u.gHigh.value as THREE.Vector3, p.highlight, p.highlightAmount);
    u.gSat.value = p.saturation;
    this.grain = p.grain;
    u.gGrain.value = this.grain * this.grainTier;
  }

  /** A split toning multiplier: the tint in linear light scaled to luminance 1 (so it shifts hue, not brightness), `amount` of the way from white. */
  private splitTint(out: THREE.Vector3, hex: number, amount: number): void {
    const c = this.gradeColor.setHex(hex);
    const l = Math.max(1e-6, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    out.set(1 + (c.r / l - 1) * amount, 1 + (c.g / l - 1) * amount, 1 + (c.b / l - 1) * amount);
  }

  /** Rain on the lens: 0 off (the shader skips it), up to 1 for a downpour (drop density); `speed` (m/s) quickens the drops. Eased by the caller. */
  setLensRain(amount: number, speed: number): void {
    this.fx.uniforms.lensRain.value = Math.max(0, Math.min(1, amount * this.lensStrength));
    this.lensSpeed = speed;
  }

  /** The heat haze blobs the session fills each frame (exhaustFx.ts `haze`): x, y screen UV, radius in screen heights, strength. */
  readonly hazeBlobs: THREE.Vector4[];

  /** Use the first `count` of `hazeBlobs` this frame (0: the shader skips the haze) on the clock `time` (s). */
  setHaze(count: number, time: number): void {
    this.fx.uniforms.uHazeN.value = count;
    this.fx.uniforms.uHazeTime.value = time;
  }

  /** Speed streaks (0 none .. 1 full, before the tier's POST_STREAKS share) on the clock `time` (s). */
  setSpeedStreaks(amount: number, time: number): void {
    const u = this.fx.uniforms;
    u.streak.value = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) * this.streakTier : 0;
    u.streakTime.value = Number.isFinite(time) ? time : 0;
  }

  setSpeedBlur(amount: number): void {
    this.fx.uniforms.blur.value = Number.isFinite(amount) ? amount : 0;
  }

  /**
   * Nitrous warp amount (0 off, 1 a stage 1 burn, up to the top of NITRO_FX.stageWarp), the clock (s) its
   * ripple runs on, and the stage 1..3 whose edge glow it takes (fractions blend; both eased by the caller).
   */
  setNitroFx(amount: number, time: number, stage = 1): void {
    // A NaN here would reach the bloom's strength, and through its composite every pixel: no warp instead.
    const a = Number.isFinite(amount) ? Math.max(0, Math.min(NITRO_FX.stageWarp[2], amount)) : 0;
    this.nitro = a;
    const u = this.fx.uniforms;
    u.warp.value = a;
    u.time.value = Number.isFinite(time) ? time : 0;
    const s = Number.isFinite(stage) ? Math.max(0, Math.min(2, stage - 1)) : 0;
    const i = Math.min(1, Math.floor(s));
    const lo = NITRO_FX.stageTint[i];
    const hi = NITRO_FX.stageTint[i + 1];
    const f = s - i;
    (u.tint.value as THREE.Vector3).set(lo[0] + (hi[0] - lo[0]) * f, lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f);
    this.bloom.strength = this.bloomBase * (1 + (NITRO_FX.bloom - 1) * a);
  }

  render(dt: number): void {
    const lens = this.fx.uniforms.lensRain;
    // The drop clock only runs while the lens is wet; it carries on from where it was, so a camera switch never jumps it.
    if (lens.value > 0) this.fx.uniforms.lensTime.value += dt * (LENS.rate + LENS.rateSpeed * this.lensSpeed);
    if (this.fx.uniforms.gGrain.value > 0) {
      // A new grain pattern each frame: a pixel offset that walks a large prime stride (no clock, no allocation).
      this.grainFrame = (this.grainFrame + 1) % 4096;
      (this.fx.uniforms.gSeed.value as THREE.Vector2).set((this.grainFrame * 97) % 1024, (this.grainFrame * 61) % 1024);
    }
    this.composer.render(dt);
  }
}
