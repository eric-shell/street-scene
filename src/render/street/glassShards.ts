/**
 * Glass shards thrown off a breaking shop window: one pooled mesh of small flat bright quads, each flying its whole
 * life in the vertex shader from its birth time (outward velocity, air drag, gravity, a stop on the road, a
 * tumble that squeezes the quad as it turns edge on) so the CPU only writes new shards into a ring buffer. A
 * sparkle brightens a shard as its tumble catches the light. One draw call, no per-frame allocation; Medium and
 * High only (Low spawns none). Render only: the session bursts it when a car breaks a bay (street/glassBreak.ts).
 */
import * as THREE from 'three';

export type ShardQuality = 'low' | 'medium' | 'high';

export const SHARDS = {
  /** Live shards at once per quality (0: none); the oldest are overwritten first. A burst throws up to `burst[1]`. */
  pool: { low: 0, medium: 480, high: 960 } as Record<ShardQuality, number>,
  /** Shards per burst: the least (a slow hit) and the most (a hard one), and the impact speed (m/s) that gives the most. */
  burst: [60, 120],
  fullSpeed: 22,
  /** Lifetime (s) range. */
  life: [1.4, 3.2],
  /** Size (m) range; a shard is this long and 0.7 times as wide. */
  size: [0.035, 0.1],
  drag: 1.6,
  gravity: 9.81,
  /** Launch speed out from the facade (m/s) range, sideways scatter (m/s) and up kick (m/s). */
  out: [0.6, 3.6],
  side: 1.8,
  up: 2.4,
  /** HDR brightness of a glint, and of a shard between glints. */
  glint: 9,
  base: 0.8,
} as const;

const vert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aMeta; // birth (s), life (s), ground y (m), seed 0..1
  uniform float uTime;
  uniform float uDrag;
  uniform float uGravity;
  uniform vec2 uSize;
  varying float vAge;
  varying float vSeed;
  varying float vSpin;

  void main() {
    float t = uTime - aMeta.x;
    vAge = t / aMeta.y;
    vSeed = aMeta.w;
    if (t < 0.0 || vAge >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float decay = exp(-uDrag * t);
    vec3 p;
    p.xz = aPos.xz + aVel.xz * (1.0 - decay) / uDrag;
    p.y = aPos.y + aVel.y * t - 0.5 * uGravity * t * t;
    // Landed: it lies where it fell.
    float landed = 0.0;
    if (p.y < aMeta.z) {
      float tl = (aVel.y + sqrt(max(0.0, aVel.y * aVel.y + 2.0 * uGravity * (aPos.y - aMeta.z)))) / uGravity;
      float dl = exp(-uDrag * tl);
      p.xz = aPos.xz + aVel.xz * (1.0 - dl) / uDrag;
      p.y = aMeta.z + 0.012;
      landed = 1.0;
    }
    float spinRate = 6.0 + 18.0 * fract(aMeta.w * 7.31);
    float spin = (1.0 - landed) * spinRate * t + aMeta.w * 6.28;
    vSpin = spin;
    float size = mix(uSize.x, uSize.y, fract(aMeta.w * 3.77));
    // Squeezed along one axis by the tumble, and turned in the screen plane by a second angle.
    float squeeze = mix(max(0.12, abs(cos(spin))), 1.0, landed);
    float rot = aMeta.w * 25.0 + spin * 0.3;
    vec2 q = vec2(corner.x * size * 0.7 * squeeze, corner.y * size);
    q = vec2(q.x * cos(rot) - q.y * sin(rot), q.x * sin(rot) + q.y * cos(rot));
    vec4 hv = viewMatrix * vec4(p, 1.0);
    hv.xy += q;
    gl_Position = projectionMatrix * hv;
  }
`;

const frag = /* glsl */ `
  uniform float uGlint;
  uniform float uBase;
  varying float vAge;
  varying float vSeed;
  varying float vSpin;
  void main() {
    // A pale cool tint; the tumble flashes it bright when the face catches a light.
    float flash = pow(max(0.0, sin(vSpin * 1.7 + vSeed * 40.0)), 14.0);
    float glow = uBase + uGlint * flash;
    float fade = 1.0 - smoothstep(0.7, 1.0, vAge);
    vec3 col = mix(vec3(0.62, 0.8, 0.95), vec3(1.0), flash);
    gl_FragColor = vec4(col * glow * fade, 1.0);
  }
`;

export class GlassShards {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private meta: THREE.InstancedBufferAttribute;
  private size: number;
  private next = 0;
  /** Dirty slots since the last update: [from, count) in ring order. */
  private dirtyFrom = -1;
  private dirtyCount = 0;

  constructor(quality: ShardQuality = 'medium') {
    this.size = SHARDS.pool[quality];
    const geo = new THREE.InstancedBufferGeometry();
    // A unit quad centred on the shard.
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const n = Math.max(1, this.size);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const meta = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
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
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: { value: 0 },
        uDrag: { value: SHARDS.drag },
        uGravity: { value: SHARDS.gravity },
        uSize: { value: new THREE.Vector2(SHARDS.size[0], SHARDS.size[1]) },
        uGlint: { value: SHARDS.glint },
        uBase: { value: SHARDS.base },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'glassShards';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * Burst `count` shards from the window of a bay centred at (x, z) with outward normal (nx, nz), spread over its
   * width `halfLen` (m) either side and between heights y0 and y1 (m), landing at `ground`; `carVx`, `carVz` is the
   * car's velocity (m/s), which a share of every shard inherits.
   */
  burst(time: number, x: number, z: number, nx: number, nz: number, halfLen: number, y0: number, y1: number, ground: number, carVx: number, carVz: number, count: number): void {
    if (!this.size) return;
    const n = Math.min(this.size, Math.max(0, Math.round(count)));
    const [l0, l1] = SHARDS.life;
    const P = this.pos.array as Float32Array;
    const V = this.vel.array as Float32Array;
    const M = this.meta.array as Float32Array;
    const tx = -nz;
    const tz = nx;
    const r = Math.random;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.size;
      const s = (r() * 2 - 1) * halfLen * 0.9;
      const h = y0 + (y1 - y0) * r();
      P[i * 3] = x + tx * s + nx * 0.1;
      P[i * 3 + 1] = h;
      P[i * 3 + 2] = z + tz * s + nz * 0.1;
      const out = SHARDS.out[0] + (SHARDS.out[1] - SHARDS.out[0]) * r() ** 1.6;
      const sd = (r() * 2 - 1) * SHARDS.side;
      V[i * 3] = nx * out + tx * sd + carVx * 0.15;
      V[i * 3 + 1] = (r() - 0.35) * SHARDS.up;
      V[i * 3 + 2] = nz * out + tz * sd + carVz * 0.15;
      M[i * 4] = time - r() * 0.03;
      M[i * 4 + 1] = l0 + (l1 - l0) * r();
      M[i * 4 + 2] = ground;
      M[i * 4 + 3] = r();
    }
    if (!n) return;
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = (this.next - n + this.size) % this.size;
      this.dirtyCount = n;
    } else this.dirtyCount = Math.min(this.size, this.dirtyCount + n);
  }

  /** Advance the clock (s) and upload this frame's new shards. */
  update(time: number): void {
    this.mat.uniforms.uTime.value = time;
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyCount;
    for (const [a, size] of [
      [this.pos, 3],
      [this.vel, 3],
      [this.meta, 4],
    ] as const) {
      a.clearUpdateRanges();
      if (from + count <= this.size) a.addUpdateRange(from * size, count * size);
      else {
        a.addUpdateRange(from * size, (this.size - from) * size);
        a.addUpdateRange(0, (from + count - this.size) * size);
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
  }
}
