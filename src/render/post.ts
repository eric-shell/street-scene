/**
 * Post processing chain: scene -> bloom (neon) -> vignette + speed radial
 * blur -> tone mapping/sRGB output -> optional retro PS2 quantize + dither.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

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

export class PostFx {
  readonly composer: EffectComposer;
  readonly renderPass: RenderPass;
  readonly bloom: UnrealBloomPass;
  readonly fx: ShaderPass;
  readonly output: OutputPass;
  readonly retro: ShaderPass;
  private bloomScale = 0.5;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.9, 0.4, 0.86);
    const origSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w: number, h: number) => origSetSize(Math.max(1, Math.round(w * this.bloomScale)), Math.max(1, Math.round(h * this.bloomScale)));
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

  configure(opts: { bloom: boolean; bloomScale: number; bloomStrength: number; retro: boolean }): void {
    this.bloom.enabled = opts.bloom;
    this.bloomScale = opts.bloomScale;
    this.bloom.strength = opts.bloomStrength;
    this.retro.enabled = opts.retro;
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
