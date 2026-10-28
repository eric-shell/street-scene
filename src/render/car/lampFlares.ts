/**
 * Lamp flares: the star-shaped glare a headlight throws into the lens when it points at you. One instanced
 * additive quad mesh (one draw call) for every lamp the frame feeds it: the traffic fleet's head and tail lamps
 * (traffic/traffic.ts) and the rivals' lenses (CarView.lampPoints). Render only: nothing here is read back.
 *
 * Each frame the owner calls `begin(camera)`, `add` once per lamp and `end()`. `add` rejects what cannot show
 * (past the tier's reach, behind the camera, a lamp facing away) and keeps the nearest `max` of the rest in
 * preallocated arrays, replacing the farthest, so there is no allocation and no sort. The vertex shader does the
 * rest from the lamp's position and the axis it shines along:
 *  - the lobe: cos(angle between the axis and the view vector) ^ `lobe`, tight enough that a car only glares as
 *    it points about 15 degrees at the camera. It lifts both the size and the brightness, on a faint floor
 *    (`floor`) while the lamp is merely turned toward the camera;
 *  - distance: the quad keeps a share of its angular size out to the tier's reach (`angular`), but shrinks
 *    inside `near` metres and fades out on the lens (`close`), so a car beside you is not a white card;
 *  - fog: the fleet's height fog dims it (a lamp in haze still glows a little), so far flares match the street;
 *  - depth: the quad is flat at its centre's depth, nudged `lift` m toward the camera so it clears its own car,
 *    and the normal depth test hides it behind a building or the car's own body.
 * Tail lamps use the same quad with the axis pointing backwards and `tail` of the strength.
 */
import * as THREE from 'three';
import type { Quality } from '../../ui/settings';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';

export const FLARES = {
  /** Per tier: most flares drawn (the nearest) and how far a lamp still flares (m). */
  tier: {
    low: { max: 8, reach: 90 },
    medium: { max: 24, reach: 170 },
    high: { max: 48, reach: 260 },
  } satisfies Record<Quality, { max: number; reach: number }>,
  /** The lobe's exponent on cos(axis, view): 18 is half strength at about 16 degrees off the axis. */
  lobe: 18,
  /** Strength while a lamp faces the camera but is off its axis (the lobe adds to this). */
  floor: 0.08,
  /** A tail lamp's share of the strength: half a headlight's. */
  tail: 0.5,
  /** Quad size (m) for a lamp of size 1: `rest` off axis, plus `peak` on it. */
  size: { rest: 0.5, peak: 2.4, max: 14 },
  /** Angular growth with distance (m of quad per m): off axis and on it. */
  angular: { rest: 0.002, peak: 0.009 },
  /** Inside `near` m the flare shrinks to half; inside `close` (m) it fades out (a lamp on the lens). */
  near: [3, 30] as [number, number],
  close: [1.5, 5] as [number, number],
  /** How far the quad is nudged toward the camera (m, at most a third of the distance). */
  lift: 0.35,
  /** Share of the fog that dims a flare (light scattered in haze still reads). */
  fogDim: 0.85,
  /** HDR colours (linear): a warm white headlight and a red tail lamp, before the lamp's own strength. */
  head: [2.6, 2.3, 1.8] as [number, number, number],
  taillight: [2.4, 0.18, 0.2] as [number, number, number],
} as const;

const vert = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iDir;
  attribute vec4 iCol;
  uniform float uDensity;
  uniform float uLobe;
  uniform float uFloor;
  uniform vec4 uSize;
  uniform vec2 uAngular;
  uniform vec2 uNear;
  uniform vec2 uClose;
  uniform float uLift;
  uniform float uFogDim;
  varying vec2 vUv;
  varying vec3 vCol;
  ${HEIGHT_FOG_GLSL}
  void main() {
    vec3 toCam = cameraPosition - iPos;
    float d = max(length(toCam), 0.05);
    vec3 v = toCam / d;
    float cosA = dot(iDir, v);
    float lobe = pow(clamp(cosA, 0.0, 1.0), uLobe);
    float facing = smoothstep(-0.1, 0.4, cosA);
    float s = iCol.w * (uSize.x + uSize.y * lobe) * mix(0.5, 1.0, smoothstep(uNear.x, uNear.y, d));
    s += d * mix(uAngular.x, uAngular.y, lobe);
    s = min(s, uSize.z);
    float strength = facing * (uFloor + lobe) * smoothstep(uClose.x, uClose.y, d);
    float fog = 1.0 - exp(-uDensity * uDensity * d * d * hfMul(iPos));
    strength *= 1.0 - uFogDim * fog;
    vCol = iCol.rgb * strength;
    vUv = position.xy * 2.0;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 centre = iPos + v * min(uLift, d * 0.33);
    vec3 wp = centre + right * (position.x * 2.4 * s * 2.0) + up * (position.y * s * 2.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;

const frag = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vCol;
  void main() {
    // p in units of the lamp's size: x spans 2.4 of them so the anamorphic streak has room.
    vec2 p = vec2(vUv.x * 2.4, vUv.y);
    float r2 = dot(p, p);
    float core = exp(-r2 * 14.0);
    float halo = exp(-r2 * 2.2) * 0.4;
    float streak = exp(-abs(p.y) * 18.0) * exp(-abs(p.x) * 0.9) * 0.7;
    float spike = exp(-abs(p.x) * 18.0) * exp(-abs(p.y) * 1.8) * 0.25;
    float edge = (1.0 - smoothstep(0.7, 1.0, abs(vUv.x))) * (1.0 - smoothstep(0.7, 1.0, abs(vUv.y)));
    float f = (core + halo + streak + spike) * edge;
    if (f < 0.002) discard;
    gl_FragColor = vec4(vCol * f, 1.0);
  }
`;

export class LampFlares {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly dir: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  /** Squared distance of each kept flare, for replacing the farthest. */
  private readonly d2: Float32Array;
  private readonly max: number;
  private readonly reach2: number;
  private n = 0;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private fx = 0;
  private fy = 0;
  private fz = 1;

  constructor(tier: Quality) {
    const q = FLARES.tier[tier] ?? FLARES.tier.medium;
    this.max = q.max;
    this.reach2 = q.reach * q.reach;
    this.d2 = new Float32Array(q.max);
    const geo = this.geo;
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(q.max * 3), 3);
    this.dir = new THREE.InstancedBufferAttribute(new Float32Array(q.max * 3), 3);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(q.max * 4), 4);
    for (const a of [this.pos, this.dir, this.col]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.pos);
    geo.setAttribute('iDir', this.dir);
    geo.setAttribute('iCol', this.col);
    geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        ...HEIGHT_FOG_UNIFORMS,
        uDensity: { value: 0.005 },
        uLobe: { value: FLARES.lobe },
        uFloor: { value: FLARES.floor },
        uSize: { value: new THREE.Vector4(FLARES.size.rest, FLARES.size.peak, FLARES.size.max, 0) },
        uAngular: { value: new THREE.Vector2(FLARES.angular.rest, FLARES.angular.peak) },
        uNear: { value: new THREE.Vector2(...FLARES.near) },
        uClose: { value: new THREE.Vector2(...FLARES.close) },
        uLift: { value: FLARES.lift },
        uFogDim: { value: FLARES.fogDim },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'lampFlares';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
  }

  /** Start a frame: the camera the flares face and the fog density they dim by. */
  begin(camera: THREE.Camera, fogDensity: number): void {
    this.n = 0;
    this.cx = camera.position.x;
    this.cy = camera.position.y;
    this.cz = camera.position.z;
    camera.getWorldDirection(_p);
    this.fx = _p.x;
    this.fy = _p.y;
    this.fz = _p.z;
    this.mat.uniforms.uDensity.value = fogDensity;
  }

  /**
   * Offer one lamp: world position, the unit axis it shines along, its HDR colour and its size (1 = a car lamp).
   * Kept only if it can show and is among the nearest `max` so far.
   */
  add(x: number, y: number, z: number, ax: number, ay: number, az: number, r: number, g: number, b: number, size: number): void {
    const vx = this.cx - x;
    const vy = this.cy - y;
    const vz = this.cz - z;
    const d2 = vx * vx + vy * vy + vz * vz;
    if (d2 > this.reach2 || d2 < 0.25) return;
    // Behind the camera, or the lamp turned away: nothing to show.
    if (vx * this.fx + vy * this.fy + vz * this.fz > 0) return;
    if (ax * vx + ay * vy + az * vz < -0.1 * Math.sqrt(d2)) return;
    let slot = this.n;
    if (slot >= this.max) {
      let far = 0;
      for (let i = 1; i < this.max; i++) if (this.d2[i] > this.d2[far]) far = i;
      if (this.d2[far] <= d2) return;
      slot = far;
    } else this.n++;
    this.d2[slot] = d2;
    this.pos.setXYZ(slot, x, y, z);
    this.dir.setXYZ(slot, ax, ay, az);
    this.col.setXYZW(slot, r, g, b, size);
  }

  /** A headlight (warm white) of `strength` (1 a full beam) shining along the unit (ax, ay, az). */
  head(x: number, y: number, z: number, ax: number, ay: number, az: number, strength: number, size = 1): void {
    const c = FLARES.head;
    this.add(x, y, z, ax, ay, az, c[0] * strength, c[1] * strength, c[2] * strength, size);
  }

  /** A tail lamp: red, `strength` 1 at the plain tail (a brake light passes more), half a headlight's, shining along the unit axis pointing backwards. */
  tail(x: number, y: number, z: number, ax: number, ay: number, az: number, strength: number, size = 0.8): void {
    const c = FLARES.taillight;
    const k = strength * FLARES.tail;
    this.add(x, y, z, ax, ay, az, c[0] * k, c[1] * k, c[2] * k, size);
  }

  /** Finish the frame: hand the kept flares to the GPU. */
  end(): void {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    this.pos.needsUpdate = true;
    this.dir.needsUpdate = true;
    this.col.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}

const _p = new THREE.Vector3();
