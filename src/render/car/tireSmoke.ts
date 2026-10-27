/**
 * Tire smoke: the cloud a spinning, locked or hard sliding tire boils off,
 * and on wet nights the road spray a tire throws at speed (the SPRAY birth
 * kind: the same puffs and shader, shorter lived, smaller, barely rising and
 * tinted per puff by the lamps' colour so the amber of sodium streets lights
 * the mist; the kind rides in the tint attribute's w). One pooled mesh of camera facing puffs (the steam's soft sprite); a puff's
 * whole life (carried off with the car's motion and slowing in the air,
 * rising, swelling, fading in and out) is a function of its birth time in the
 * vertex shader, so the CPU only writes new puffs into a ring buffer. Lit a
 * dim cool grey and fogged like the scene so a plume reads against the wet
 * asphalt under the streetlights without glowing. Render only: tireFx.ts
 * feeds it from the sim's tire telemetry; one draw call, no per-frame
 * allocation, pool size by quality.
 */
import * as THREE from 'three';
import { FOG_COLOR, FOG_DENSITY } from '../lighting';
import { makeSteamPuff } from '../textures/textures';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';

export type TireSmokeQuality = 'low' | 'medium' | 'high';

export const TIRE_SMOKE = {
  /** Live puffs at once per quality, smoke and spray together (spray added 128/320/512 to the old 256/640/1280); the oldest are overwritten first. */
  pool: { low: 384, medium: 960, high: 1792 } as Record<TireSmokeQuality, number>,
  /** Lifetime range (s). */
  life: [1.1, 2.2],
  /** Horizontal air drag (1/s): a puff's carried velocity falls as exp(-drag t). */
  drag: 1.8,
  /** Rise (m/s) and the puff's size at birth and death (m). */
  rise: 0.75,
  size: [0.35, 1.7],
  /** Peak opacity at full strength. A burnout stacks many puffs, so each stays thin. */
  alpha: 0.3,
  /** Puff colour before the fog takes it. */
  color: 0x8e9299,
} as const;

/**
 * Road spray: the puffs a tire throws off a wet road, born behind the rear tires at speed whatever the slip.
 * Shorter lived, smaller and less buoyant than smoke, streaming back with the car, thin at low alpha so the
 * headlights behind the car catch it; its colour is the nearest lamp tone's pool colour (set per puff at birth).
 */
export const SPRAY = {
  /** Lifetime range (s). */
  life: [0.5, 1.0],
  /** Horizontal air drag (1/s): higher than smoke, so the tail sheds behind the car. */
  drag: 2.4,
  /** Rise (m/s) and size at birth and death (m). */
  rise: 0.3,
  size: [0.25, 1.0],
  /** Peak opacity at full strength. */
  alpha: 0.32,
  /** How far the lamp tone is pulled toward the raw pale grey of the water (0 = pure lamp tone). */
  grey: 0.35,
} as const;

const vert = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aMeta; // birth (s), life (s), seed 0..1, strength 0..1
  attribute vec4 aTint; // rgb colour before the fog, kind (0 smoke, 1 spray)
  uniform float uTime;
  uniform float uDrag;
  uniform float uRise;
  uniform vec2 uSize;
  uniform vec4 uSpray; // drag, rise, size min, size max
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  varying vec3 vTint;
  varying float vKind;
  void main() {
    vUv = uv;
    vTint = aTint.rgb;
    vKind = aTint.w;
    float drag = mix(uDrag, uSpray.x, aTint.w);
    float rise = mix(uRise, uSpray.y, aTint.w);
    vec2 sz = mix(uSize, uSpray.zw, aTint.w);
    float t = uTime - aMeta.x;
    float u = t / aMeta.y;
    if (t < 0.0 || u >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float decay = exp(-drag * t);
    vec3 c = aPos + aVel * (1.0 - decay) / drag;
    // Buoyant: rises faster as it thins out.
    c.y += rise * t * (0.6 + 0.8 * u);
    float size = mix(sz.x, sz.y, 1.0 - (1.0 - u) * (1.0 - u)) * (0.75 + 0.5 * aMeta.z);
    vAlpha = aMeta.w * smoothstep(0.0, 0.12, u) * (1.0 - smoothstep(0.3, 1.0, u));
    vec4 mv = viewMatrix * vec4(c, 1.0);
    float spin = aMeta.z * 6.2831 + t * (0.4 + 0.6 * aMeta.z) * (aMeta.z > 0.5 ? 1.0 : -1.0);
    vec2 r = vec2(cos(spin), sin(spin));
    vec2 p = vec2(position.x * r.x - position.y * r.y, position.x * r.y + position.y * r.x) * size;
    mv.xy += p;
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd * hfMulView(mv.xyz));
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 fogColor;
  ${HEIGHT_FOG_GLSL}
  uniform vec2 uAlpha; // smoke, spray
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  varying vec3 vTint;
  varying float vKind;
  void main() {
    float a = texture2D(map, vUv).a * vAlpha * mix(uAlpha.x, uAlpha.y, vKind);
    gl_FragColor = vec4(mix(hfFogColorCam(fogColor), vTint, vFog), a);
  }
`;

/** Smoke colour (linear, for the fog mix) and the water's pale grey that spray is pulled toward. */
const SMOKE_COLOR = new THREE.Color(TIRE_SMOKE.color);
const SMOKE_R = SMOKE_COLOR.r;
const SMOKE_G = SMOKE_COLOR.g;
const SMOKE_B = SMOKE_COLOR.b;
const SPRAY_GREY = 0.55;

export class TireSmoke {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.Texture;
  private pos: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private meta: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;
  private size: number;
  private next = 0;
  private dirtyFrom = -1;
  private dirtyCount = 0;

  constructor(quality: TireSmokeQuality = 'medium') {
    this.size = TIRE_SMOKE.pool[quality] ?? TIRE_SMOKE.pool.medium;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    // Born long ago and dead: nothing draws until the first emit.
    const meta = new Float32Array(this.size * 4);
    for (let i = 0; i < this.size; i++) {
      meta[i * 4] = -1e6;
      meta[i * 4 + 1] = 1;
    }
    this.meta = new THREE.InstancedBufferAttribute(meta, 4);
    // Smoke colour everywhere until a puff is born; w is the birth kind.
    const tint = new Float32Array(this.size * 4);
    this.tint = new THREE.InstancedBufferAttribute(tint, 4);
    for (const a of [this.pos, this.vel, this.meta, this.tint]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.pos);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aMeta', this.meta);
    geo.setAttribute('aTint', this.tint);
    geo.instanceCount = this.size;
    this.geo = geo;
    this.tex = makeSteamPuff();
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        map: { value: this.tex },
        uTime: { value: 0 },
        uDrag: { value: TIRE_SMOKE.drag },
        uRise: { value: TIRE_SMOKE.rise },
        uSize: { value: new THREE.Vector2(TIRE_SMOKE.size[0], TIRE_SMOKE.size[1]) },
        uSpray: { value: new THREE.Vector4(SPRAY.drag, SPRAY.rise, SPRAY.size[0], SPRAY.size[1]) },
        uAlpha: { value: new THREE.Vector2(TIRE_SMOKE.alpha, SPRAY.alpha) },
        fogColor: { value: new THREE.Color(FOG_COLOR) },
        fogDensity: { value: FOG_DENSITY },
        ...HEIGHT_FOG_UNIFORMS,
      },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'tireSmoke';
    this.mesh.frustumCulled = false;
    // After the cars and sparks: the smoke lies over the wheels it comes from.
    this.mesh.renderOrder = 3;
  }

  /**
   * Boil `count` puffs off (x, y, z) at scene time `time` (s), carried at
   * (vx, vy, vz) m/s each scattered by up to `spread` m/s, at `strength` 0..1
   * (their peak opacity share).
   */
  emit(time: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, count: number, strength: number): void {
    this.spawn(0, time, x, y, z, vx, vy, vz, spread, count, strength, SMOKE_R, SMOKE_G, SMOKE_B);
  }

  /**
   * Throw `count` spray puffs off (x, y, z): same arguments as `emit`, plus the lamp tone (linear r, g, b) the
   * mist takes, pulled a little toward grey. Shorter lived and smaller than smoke (SPRAY).
   */
  emitSpray(time: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, count: number, strength: number, r: number, g: number, b: number): void {
    const k = SPRAY.grey;
    this.spawn(1, time, x, y, z, vx, vy, vz, spread, count, strength, r + (SPRAY_GREY - r) * k, g + (SPRAY_GREY - g) * k, b + (SPRAY_GREY - b) * k);
  }

  private spawn(kind: 0 | 1, time: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, count: number, strength: number, cr: number, cg: number, cb: number): void {
    const n = Math.min(this.size, Math.max(0, Math.round(count)));
    const [l0, l1] = kind ? SPRAY.life : TIRE_SMOKE.life;
    const T = this.tint.array as Float32Array;
    const P = this.pos.array as Float32Array;
    const V = this.vel.array as Float32Array;
    const M = this.meta.array as Float32Array;
    const r = Math.random;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.size;
      P[i * 3] = x + (r() - 0.5) * 0.3;
      P[i * 3 + 1] = y + r() * 0.15;
      P[i * 3 + 2] = z + (r() - 0.5) * 0.3;
      V[i * 3] = vx + (r() * 2 - 1) * spread;
      V[i * 3 + 1] = vy + r() * spread * 0.5;
      V[i * 3 + 2] = vz + (r() * 2 - 1) * spread;
      // Spread over the tick so a 60 Hz stream reads as one cloud, not pulses.
      M[i * 4] = time - r() * 0.016;
      M[i * 4 + 1] = l0 + (l1 - l0) * r();
      M[i * 4 + 2] = r();
      M[i * 4 + 3] = strength * (0.7 + 0.3 * r());
      T[i * 4] = cr;
      T[i * 4 + 1] = cg;
      T[i * 4 + 2] = cb;
      T[i * 4 + 3] = kind;
    }
    if (!n) return;
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = (this.next - n + this.size) % this.size;
      this.dirtyCount = n;
    } else this.dirtyCount = Math.min(this.size, this.dirtyCount + n);
  }

  /** Advance the clock (s) and upload this frame's new puffs. */
  update(time: number): void {
    this.mat.uniforms.uTime.value = time;
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyCount;
    for (const [a, stride] of [
      [this.pos, 3],
      [this.vel, 3],
      [this.meta, 4],
      [this.tint, 4],
    ] as const) {
      a.clearUpdateRanges();
      if (from + count <= this.size) a.addUpdateRange(from * stride, count * stride);
      else {
        a.addUpdateRange(from * stride, (this.size - from) * stride);
        a.addUpdateRange(0, (from + count - this.size) * stride);
      }
      a.needsUpdate = true;
    }
    this.dirtyFrom = -1;
    this.dirtyCount = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose();
  }
}
