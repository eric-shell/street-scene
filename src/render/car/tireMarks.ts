/**
 * Tire marks: the rubber a sliding, spinning or locked tire leaves on the
 * road. One mesh holds a ring buffer of flat quads laid just above the
 * asphalt (the decals' polygon offset against z-fighting); each wheel's
 * strip is extended one quad per sim tick from where its last quad ended, so
 * consecutive quads share an edge and a drift reads as one continuous line.
 * A quad fades by age in the shader and is darker the deeper the slide was,
 * and once the pool is full the oldest marks are overwritten. Rubber on
 * asphalt is near black; on concrete (the river channel, plazas) it reads a
 * little lighter. Render only: tireFx.ts feeds it from the sim's tire
 * telemetry; the CPU only writes new quads, one draw call, no per-frame
 * allocation, pool size by quality.
 */
import * as THREE from 'three';
import { FOG_COLOR, FOG_DENSITY } from '../lighting';

export type TireMarkQuality = 'low' | 'medium' | 'high';

export const TIRE_MARKS = {
  /** Quads kept per quality; the oldest are overwritten first. */
  pool: { low: 700, medium: 1600, high: 3200 } as Record<TireMarkQuality, number>,
  /** Lifetime (s): fully dark until fadeFrom of it has passed, gone at the end. */
  life: 50,
  fadeFrom: 0.55,
  /** Contact patch width (m): a 225 section tire. */
  width: 0.225,
  /** Height above the road (m), a hair over the decals' lift so marks sit on the paint. */
  lift: 0.036,
  /** Peak opacity of a fresh mark at full slide. */
  alpha: 0.72,
  /** Rubber on asphalt and on concrete (the frag mixes by the per vertex tint). */
  asphalt: 0x0b0b0d,
  concrete: 0x2b2926,
} as const;

const vert = /* glsl */ `
  attribute vec4 aData; // edge -1..1 across the strip, intensity 0..1, birth (s), tint 0 asphalt .. 1 concrete
  uniform float uTime;
  uniform float uLife;
  uniform float uFadeFrom;
  uniform float fogDensity;
  varying float vEdge;
  varying float vAlpha;
  varying float vTint;
  varying float vFog;
  void main() {
    float age = uTime - aData.z;
    if (age < 0.0 || age >= uLife) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vEdge = aData.x;
    vTint = aData.w;
    vAlpha = aData.y * (1.0 - smoothstep(uLife * uFadeFrom, uLife, age));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd);
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */ `
  uniform vec3 uAsphalt;
  uniform vec3 uConcrete;
  uniform vec3 fogColor;
  uniform float uAlpha;
  varying float vEdge;
  varying float vAlpha;
  varying float vTint;
  varying float vFog;
  void main() {
    // Soft shoulders: the tread's edges lay less rubber than its middle.
    float across = 1.0 - vEdge * vEdge;
    float a = vAlpha * uAlpha * smoothstep(0.0, 0.55, across);
    vec3 col = mix(fogColor, mix(uAsphalt, uConcrete, vTint), vFog);
    gl_FragColor = vec4(col, a);
  }
`;

export class TireMarks {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: THREE.BufferAttribute;
  private data: THREE.BufferAttribute;
  private size: number;
  private next = 0;
  /** Dirty quads since the last update: [from, from + count) in ring order. */
  private dirtyFrom = -1;
  private dirtyCount = 0;

  constructor(quality: TireMarkQuality = 'medium') {
    this.size = TIRE_MARKS.pool[quality] ?? TIRE_MARKS.pool.medium;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(this.size * 4 * 3), 3);
    // Born long ago: nothing draws until the first quad is laid.
    const data = new Float32Array(this.size * 4 * 4);
    for (let i = 0; i < this.size * 4; i++) data[i * 4 + 2] = -1e6;
    this.data = new THREE.BufferAttribute(data, 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aData', this.data);
    const index = new Uint32Array(this.size * 6);
    for (let i = 0; i < this.size; i++) {
      const v = i * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: TIRE_MARKS.life },
        uFadeFrom: { value: TIRE_MARKS.fadeFrom },
        uAlpha: { value: TIRE_MARKS.alpha },
        uAsphalt: { value: new THREE.Color(TIRE_MARKS.asphalt) },
        uConcrete: { value: new THREE.Color(TIRE_MARKS.concrete) },
        fogColor: { value: new THREE.Color(FOG_COLOR) },
        fogDensity: { value: FOG_DENSITY },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -8,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'tireMarks';
    this.mesh.frustumCulled = false;
    // Over the road decals (0), under the cars and their sparks.
    this.mesh.renderOrder = 1;
  }

  /**
   * Lay one quad between the strip's last edge (al .. ar, left and right
   * points, m) and its new edge (bl .. br) at scene time `time` (s), with
   * `intensity` 0..1 (how deep the slide was) and `tint` 0 (asphalt) .. 1
   * (concrete). Points carry their own y, already lifted above the road.
   */
  lay(time: number, al: THREE.Vector3, ar: THREE.Vector3, bl: THREE.Vector3, br: THREE.Vector3, intensity: number, tint: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.size;
    const P = this.pos.array as Float32Array;
    const D = this.data.array as Float32Array;
    const v = i * 4;
    P[v * 3] = al.x;
    P[v * 3 + 1] = al.y;
    P[v * 3 + 2] = al.z;
    P[v * 3 + 3] = ar.x;
    P[v * 3 + 4] = ar.y;
    P[v * 3 + 5] = ar.z;
    P[v * 3 + 6] = br.x;
    P[v * 3 + 7] = br.y;
    P[v * 3 + 8] = br.z;
    P[v * 3 + 9] = bl.x;
    P[v * 3 + 10] = bl.y;
    P[v * 3 + 11] = bl.z;
    for (let k = 0; k < 4; k++) {
      const o = (v + k) * 4;
      D[o] = k === 0 || k === 3 ? -1 : 1;
      D[o + 1] = intensity;
      D[o + 2] = time;
      D[o + 3] = tint;
    }
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = i;
      this.dirtyCount = 1;
    } else this.dirtyCount = Math.min(this.size, this.dirtyCount + 1);
  }

  /** Advance the clock (s) and upload the quads laid since the last frame. */
  update(time: number): void {
    this.mat.uniforms.uTime.value = time;
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyCount;
    for (const [a, stride] of [
      [this.pos, 12],
      [this.data, 16],
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
  }
}
