/**
 * Post processing chain: scene (optional MSAA) -> bloom (neon) -> vignette +
 * speed radial blur + nitrous warp -> tone mapping/sRGB output -> optional
 * retro PS2 quantize + dither.
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
 * Bloom stability: the stock UnrealBloomPass extracts bright pixels with one
 * bilinear tap per texel of a buffer 2x-8x smaller than the scene, with a hard
 * threshold. Sub-pixel emitters (distant lamp lenses, window lights, neon
 * edges) then land on a sampled texel one frame and between texels the next,
 * so their glow pops on and off as the camera moves. StableBloomPass replaces
 * that extraction with a prefilter that covers the whole footprint, weights
 * taps with a Karis average, clamps fireflies, drops NaN/Inf and uses a soft
 * knee, and keeps the bloom mip chain at exact halvings.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';

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

const FxShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.35 },
    blur: { value: 0.0 },
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
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float blur;
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
    varying vec2 vUv;
    void main() {
      vec2 uv = vUv;
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
      vec4 c = texture2D(tDiffuse, uv);
      float zoom = blur * (1.0 + blurEdge * warp * m);
      if (zoom > 0.001) {
        // Zoom blur from the vanishing point: zero in the middle, growing
        // progressively toward the edges, streaking along the travel direction
        // (much longer at the edges under nitrous). A per pixel jitter of the
        // taps hides the banding of long streaks.
        vec2 dir = uv - center;
        float r = length(dir * vec2(1.25, 1.0));
        float w = pow(smoothstep(0.12, 0.85, r), 1.6);
        float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) / 11.0;
        vec4 acc = c;
        float total = 1.0;
        for (int i = 1; i < 12; i++) {
          float k = (float(i) - jit) / 11.0;
          float wt = 1.0 - k * 0.5;
          acc += texture2D(tDiffuse, uv - dir * zoom * w * k * 0.16) * wt;
          total += wt;
        }
        c = acc / total;
      }
      if (m > 0.0) {
        // Colour fringes split along the stretch.
        vec2 f = dir0 * fringe * warp * m;
        c.r = mix(c.r, texture2D(tDiffuse, uv + f).r, m);
        c.b = mix(c.b, texture2D(tDiffuse, uv - f).b, m);
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        // Saturation and contrast ramp in from the middle 50% to the edges only.
        c.rgb = max(vec3(0.0), mix(vec3(l), c.rgb, 1.0 + (saturation - 1.0) * warp * m));
        c.rgb = max(vec3(0.0), (c.rgb - 0.18) * (1.0 + (contrast - 1.0) * warp * m) + 0.18);
        // A faint glow creeping in from the edges, in the stage's color.
        c.rgb += tint * edgeTint * warp * m * m;
      }
      vec2 q = vUv - 0.5;
      float v = 1.0 - vignette * smoothstep(0.25, 0.85, length(q * vec2(1.1, 1.0)) * 1.25);
      gl_FragColor = vec4(c.rgb * v, c.a);
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
          // NaN / Inf from any shader would smear across the whole blur.
          if (isnan(l) || isinf(l) || l > 6.0e4) { c = vec3(0.0); l = 0.0; }
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

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    // The stencil lets ground light skip the cars standing in it (vehicleMask.ts).
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, stencilBuffer: true });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new ScenePass(scene, camera);
    this.msaaSupported = renderer.capabilities.maxSamples > 0 && renderer.extensions.has('EXT_color_buffer_float');
    this.bloom = new StableBloomPass(new THREE.Vector2(size.x, size.y), 0.9, 0.4, 0.86);
    this.fx = new ShaderPass(FxShader);
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
  configure(opts: { bloom: boolean; bloomScale: number; bloomStrength: number; retro: boolean; msaa?: number }): void {
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
  }

  setSpeedBlur(amount: number): void {
    this.fx.uniforms.blur.value = amount;
  }

  /**
   * Nitrous warp amount (0 off, 1 a stage 1 burn, up to the top of NITRO_FX.stageWarp), the clock (s) its
   * ripple runs on, and the stage 1..3 whose edge glow it takes (fractions blend; both eased by the caller).
   */
  setNitroFx(amount: number, time: number, stage = 1): void {
    const a = Math.max(0, Math.min(NITRO_FX.stageWarp[2], amount));
    this.nitro = a;
    const u = this.fx.uniforms;
    u.warp.value = a;
    u.time.value = time;
    const s = Math.max(0, Math.min(2, stage - 1));
    const i = Math.min(1, Math.floor(s));
    const lo = NITRO_FX.stageTint[i];
    const hi = NITRO_FX.stageTint[i + 1];
    const f = s - i;
    (u.tint.value as THREE.Vector3).set(lo[0] + (hi[0] - lo[0]) * f, lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f);
    this.bloom.strength = this.bloomBase * (1 + (NITRO_FX.bloom - 1) * a);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }
}
