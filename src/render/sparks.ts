/**
 * Car sparks: the underbody grinding the road when the suspension bottoms out
 * (landings, crests, kickers) and metal on wall or rail when a car scrapes or
 * slams into one. One pooled mesh of camera facing streaks: a spark's whole
 * flight (launch velocity, air drag, gravity, a skid along the road once it
 * lands, cooling from white through orange to a dull red) is computed in the
 * vertex shader from its birth time, so the CPU only writes new sparks into a
 * ring buffer. One draw call, no per-frame allocation, pool size by quality.
 * Render only: the session feeds it from car telemetry (CarState.scrape*,
 * bottomOut) and wall hit events.
 */
import * as THREE from 'three';

export type SparkQuality = 'low' | 'medium' | 'high';

export const SPARKS = {
  /** Live sparks at once per quality; the oldest are overwritten first. */
  pool: { low: 160, medium: 384, high: 768 } as Record<SparkQuality, number>,
  /** Lifetime range (s). */
  life: [0.22, 0.55],
  /** Horizontal air drag (1/s): velocity falls as exp(-drag t). */
  drag: 3.2,
  gravity: 9.81,
  /** Streak width (m), never thinner than minPixels on screen, and length per m/s of speed (s), capped (m). */
  width: 0.065,
  minPixels: 1.6,
  stretch: 0.05,
  maxLength: 1.1,
  /**
   * HDR brightness when fresh. Streaks cover a pixel or two, so they need to
   * run far hotter than the neon to read through the tone mapping and catch
   * the bloom.
   */
  heat: 110,
} as const;

const vert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aMeta; // birth (s), life (s), ground y (m), seed 0..1
  uniform float uTime;
  uniform float uDrag;
  uniform float uGravity;
  uniform float uWidth;
  uniform float uStretch;
  uniform float uMaxLength;
  uniform float uPixel;
  varying float vAge;
  varying float vSeed;
  varying float vEdge;

  vec3 at(float t, out vec3 vel) {
    float decay = exp(-uDrag * t);
    vec3 p;
    p.xz = aPos.xz + aVel.xz * (1.0 - decay) / uDrag;
    p.y = aPos.y + aVel.y * t - 0.5 * uGravity * t * t;
    vel = vec3(aVel.x * decay, aVel.y - uGravity * t, aVel.z * decay);
    // Landed: skid along the road, still cooling.
    if (p.y < aMeta.z) {
      p.y = aMeta.z + 0.01;
      vel.y = 0.0;
    }
    return p;
  }

  void main() {
    float t = uTime - aMeta.x;
    vAge = t / aMeta.y;
    vSeed = aMeta.w;
    vEdge = corner.x * 2.0;
    if (t < 0.0 || vAge >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 vel;
    vec3 head = at(t, vel);
    float speed = length(vel);
    float len = min(uMaxLength, speed * uStretch + 0.04);
    vec3 tail = head - (speed > 0.001 ? vel / speed : vec3(0.0, 1.0, 0.0)) * len;
    vec4 hv = viewMatrix * vec4(head, 1.0);
    vec4 tv = viewMatrix * vec4(tail, 1.0);
    vec2 d = hv.xy - tv.xy;
    float dl = length(d);
    d = dl > 1e-5 ? d / dl : vec2(1.0, 0.0);
    // World width, but at least minPixels wide at this depth (uPixel: view height of one pixel at 1 m).
    float wide = max(uWidth * (0.6 + vSeed * 0.8) * (1.0 - 0.4 * vAge), uPixel * -hv.z);
    vec2 side = vec2(-d.y, d.x) * wide;
    vec4 p = mix(tv, hv, corner.y);
    p.xy += side * corner.x;
    gl_Position = projectionMatrix * p;
  }
`;

const frag = /* glsl */ `
  uniform float uHeat;
  varying float vAge;
  varying float vSeed;
  varying float vEdge;
  void main() {
    // Cooling steel: white hot, then yellow, orange and a dull red as it dies.
    vec3 hot = vec3(1.0, 0.92, 0.72);
    vec3 warm = vec3(1.0, 0.52, 0.14);
    vec3 cold = vec3(0.7, 0.12, 0.03);
    float a = vAge;
    vec3 col = a < 0.35 ? mix(hot, warm, a / 0.35) : mix(warm, cold, (a - 0.35) / 0.65);
    float glow = uHeat * (0.55 + 0.45 * vSeed) * (1.0 - a) * (1.0 - 0.5 * a);
    float edge = 1.0 - vEdge * vEdge;
    gl_FragColor = vec4(col * glow * edge, 1.0);
  }
`;

export class Sparks {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private meta: THREE.InstancedBufferAttribute;
  private size: number;
  private next = 0;
  /** Dirty slots since the last update: [from, to) in ring order, or the whole pool once it wraps. */
  private dirtyFrom = -1;
  private dirtyCount = 0;

  constructor(quality: SparkQuality = 'medium') {
    this.size = SPARKS.pool[quality] ?? SPARKS.pool.medium;
    const geo = new THREE.InstancedBufferGeometry();
    // A unit quad: x across the streak (-0.5..0.5), y from tail (0) to head (1).
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    // Born long ago and dead: nothing draws until the first emit.
    const meta = new Float32Array(this.size * 4);
    for (let i = 0; i < this.size; i++) meta[i * 4] = -1e6;
    for (let i = 0; i < this.size; i++) meta[i * 4 + 1] = 1;
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
        uDrag: { value: SPARKS.drag },
        uGravity: { value: SPARKS.gravity },
        uWidth: { value: SPARKS.width },
        uStretch: { value: SPARKS.stretch },
        uMaxLength: { value: SPARKS.maxLength },
        uPixel: { value: 0.001 },
        uHeat: { value: SPARKS.heat },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'carSparks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * Spray `count` sparks from (x, y, z) at scene time `time` (s): launch
   * velocity (vx, vy, vz) m/s, each scattered by up to `spread` m/s, landing
   * on the road at height `ground` (m).
   */
  emit(time: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, spread: number, count: number, ground: number): void {
    const n = Math.min(this.size, Math.max(0, Math.round(count)));
    const [l0, l1] = SPARKS.life;
    const P = this.pos.array as Float32Array;
    const V = this.vel.array as Float32Array;
    const M = this.meta.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.size;
      const r = Math.random;
      P[i * 3] = x + (r() - 0.5) * 0.12;
      P[i * 3 + 1] = y + (r() - 0.5) * 0.06;
      P[i * 3 + 2] = z + (r() - 0.5) * 0.12;
      V[i * 3] = vx + (r() * 2 - 1) * spread;
      V[i * 3 + 1] = vy + r() * spread * 0.8;
      V[i * 3 + 2] = vz + (r() * 2 - 1) * spread;
      // A few sparks fly a little before or after the tick that threw them, so a 60 Hz stream looks continuous.
      M[i * 4] = time - r() * 0.016;
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

  /**
   * Advance the clock (s) and upload this frame's new sparks. `pixel` is the
   * view space height of one screen pixel at 1 m (2 tan(fov / 2) / height px),
   * which keeps distant sparks from thinning into shimmer.
   */
  update(time: number, pixel: number): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uPixel.value = pixel * SPARKS.minPixels;
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
