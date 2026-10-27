/**
 * Tire smoke: the cloud a spinning, locked or hard sliding tire boils off.
 * One pooled mesh of camera facing puffs (the steam's soft sprite); a puff's
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
  /** Live puffs at once per quality; the oldest are overwritten first. */
  pool: { low: 256, medium: 640, high: 1280 } as Record<TireSmokeQuality, number>,
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

const vert = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aMeta; // birth (s), life (s), seed 0..1, strength 0..1
  uniform float uTime;
  uniform float uDrag;
  uniform float uRise;
  uniform vec2 uSize;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vUv = uv;
    float t = uTime - aMeta.x;
    float u = t / aMeta.y;
    if (t < 0.0 || u >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float decay = exp(-uDrag * t);
    vec3 c = aPos + aVel * (1.0 - decay) / uDrag;
    // Buoyant: rises faster as it thins out.
    c.y += uRise * t * (0.6 + 0.8 * u);
    float size = mix(uSize.x, uSize.y, 1.0 - (1.0 - u) * (1.0 - u)) * (0.75 + 0.5 * aMeta.z);
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
  uniform vec3 uColor;
  uniform vec3 fogColor;
  ${HEIGHT_FOG_GLSL}
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float a = texture2D(map, vUv).a * vAlpha * uAlpha;
    gl_FragColor = vec4(mix(hfFogColorCam(fogColor), uColor, vFog), a);
  }
`;

export class TireSmoke {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.Texture;
  private pos: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private meta: THREE.InstancedBufferAttribute;
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
    for (const a of [this.pos, this.vel, this.meta]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.pos);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aMeta', this.meta);
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
        uAlpha: { value: TIRE_SMOKE.alpha },
        uColor: { value: new THREE.Color(TIRE_SMOKE.color) },
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
    const n = Math.min(this.size, Math.max(0, Math.round(count)));
    const [l0, l1] = TIRE_SMOKE.life;
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
