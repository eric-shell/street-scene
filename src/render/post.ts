/**
 * Post processing chain: scene (optional MSAA) -> bloom (neon) -> vignette +
 * speed radial blur -> tone mapping/sRGB output -> optional retro PS2
 * quantize + dither.
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

const FxShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.35 },
    blur: { value: 0.0 },
    center: { value: new THREE.Vector2(0.5, 0.55) },
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
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (blur > 0.001) {
        // Zoom blur from the vanishing point: zero in the middle, growing
        // progressively toward the edges, streaking along the travel direction.
        vec2 dir = vUv - center;
        float r = length(dir * vec2(1.25, 1.0));
        float w = pow(smoothstep(0.12, 0.85, r), 1.6);
        vec4 acc = c;
        float total = 1.0;
        for (int i = 1; i < 12; i++) {
          float k = float(i) / 11.0;
          float wt = 1.0 - k * 0.5;
          acc += texture2D(tDiffuse, vUv - dir * blur * w * k * 0.16) * wt;
          total += wt;
        }
        c = acc / total;
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
    this.msaa = n > 0 ? new THREE.WebGLRenderTarget(this.size.x, this.size.y, { type: THREE.HalfFloatType, samples: n }) : null;
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

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
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
    this.bloom.strength = opts.bloomStrength;
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

  render(dt: number): void {
    this.composer.render(dt);
  }
}
