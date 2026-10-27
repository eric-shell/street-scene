/**
 * Litter in the cars' wake: sheets of paper, leaves, cups and the odd plastic bag lifted off the road by a
 * passing car, tumbling in its slipstream and settling behind it. One pooled mesh of small double sided
 * quads, the same shape as the sparks and the tire smoke: a piece's whole flight (the wake's forward push and
 * an upward and sideways kick, air drag, gravity per kind, a tumble about two axes, a short slide once it lands,
 * the fade) is computed in the vertex shader from a birth record, so the CPU only writes new pieces into a ring
 * buffer. One draw call, no per-frame allocation, pool size by quality. Leaves and bags hang in the air
 * (little gravity, a lot of drag); a cup drops like the thing it is.
 *
 * Where the street is littered decides the rate: downtown and the race route (the main drag) carry the most,
 * the side streets a trickle (`routeNearness`, `downtownFactor`). Only cars near the camera shed any, and only
 * above `minSpeed`. The shapes are four tiny canvas drawings in one atlas; the shade of each piece is seeded.
 * Unlit like the smoke (the street is dark and a lit scrap would need the light list), dimmed to the night and
 * fogged with the shared height fog. Render only: reads the cars, never the sim's state, and its randomness is
 * `Math.random` like every other effect here, so replays are untouched.
 */
import * as THREE from 'three';
import type { RaceCar } from '../../sim/race';
import type { World } from '../../city/world';
import { downtownFactor } from '../../city/roadGraph';
import { clamp01 } from '../../sim/math';
import { FOG_COLOR, FOG_DENSITY } from '../lighting';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';
import { routeNearness } from '../street/routeNearness';
import { canvas, canvasTex } from '../textures/canvasKit';

export type LitterQuality = 'low' | 'medium' | 'high';

/** Per kind of scrap, in atlas order: paper, leaf, cup, bag. */
export const LITTER = {
  /** Live pieces at once per quality; the oldest are overwritten first. Low draws none. */
  pool: { low: 0, medium: 192, high: 384 } as Record<LitterQuality, number>,
  /** Lifetime range (s). */
  life: [1.5, 3],
  /** Only cars this close to the camera (m) shed litter, and only above this speed (m/s). */
  range: 60,
  minSpeed: 12,
  /** Speed (m/s) where the rate reaches its full value. */
  fullSpeed: 45,
  /** Pieces per second per car at full speed on the most littered street, at Medium (scaled by the pool). */
  perSecond: 6,
  /** The least a street sheds, as a share of the most (side streets away from downtown and the route). */
  minLitter: 0.25,
  /** Share of each kind among the pieces (paper, leaf, cup, bag; sums to 1). */
  mix: [0.34, 0.34, 0.16, 0.16],
  /** Gravity (m/s^2) per kind: leaves and bags float, paper flutters, a cup falls. */
  gravity: [4.5, 2.6, 9.81, 2.2],
  /** Horizontal air drag (1/s) per kind: how fast the wake's push dies out. */
  drag: [1.6, 2.2, 0.9, 2.6],
  /** Side of the quad (m) per kind, before the seeded 0.75..1.4 size scale. */
  size: [0.3, 0.22, 0.18, 0.38],
  /** Tumble rate (rad/s) per kind, before the seeded 0.4..1.4 factor. */
  spin: [5, 6.5, 8, 4],
  /** The wake: share of the car's velocity a piece is carried with at birth, and the kicks (m/s): sideways, and up at 0 m/s plus per m/s of car speed. */
  carry: [0.3, 0.55],
  side: 2.6,
  lift: [1.2, 0.06],
  /** Horizontal friction on the road once landed (1/s), and how fast the tumble settles flat (s). */
  slide: 5,
  settle: 0.25,
  /** The fade out over the last share of the life. */
  fade: 0.3,
  /** Brightness against the night: the scene has no light to give a scrap, so it is dimmed to read like a lit one at a distance. */
  dim: 0.8,
  /** Peak opacity (a bag is clear plastic, scaled again in the shader). */
  alpha: 0.95,
} as const;

/** Atlas cells in a row; the sheet is 4 cells of 64 px. */
const CELLS = 4;
const CELL_PX = 64;

/** The four shapes, white and grey so the seeded shade multiplies in (shader `tint`). */
function drawAtlas(): THREE.CanvasTexture {
  const [c, g] = canvas(CELL_PX * CELLS, CELL_PX);
  g.clearRect(0, 0, c.width, c.height);
  const P = CELL_PX;
  // Paper: a sheet with a fold shadow and a few printed lines.
  g.save();
  g.translate(P * 0.5, P * 0.5);
  g.rotate(0.12);
  g.fillStyle = '#f4f4f4';
  g.fillRect(-P * 0.3, -P * 0.4, P * 0.6, P * 0.8);
  g.fillStyle = '#cfcfcf';
  g.fillRect(-P * 0.3, -P * 0.02, P * 0.6, P * 0.05);
  g.fillStyle = '#b4b4b4';
  for (let i = 0; i < 6; i++) g.fillRect(-P * 0.23, -P * 0.34 + i * P * 0.06 + (i > 2 ? P * 0.08 : 0), P * (0.46 - (i % 3) * 0.1), P * 0.025);
  g.restore();
  // Leaf: an almond with a midrib and a stalk.
  g.save();
  g.translate(P * 1.5, P * 0.5);
  g.rotate(-0.5);
  g.fillStyle = '#e8e8e8';
  g.beginPath();
  g.moveTo(0, -P * 0.42);
  g.bezierCurveTo(P * 0.34, -P * 0.2, P * 0.3, P * 0.22, 0, P * 0.34);
  g.bezierCurveTo(-P * 0.3, P * 0.22, -P * 0.34, -P * 0.2, 0, -P * 0.42);
  g.fill();
  g.strokeStyle = '#a0a0a0';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, -P * 0.36);
  g.lineTo(0, P * 0.44);
  g.stroke();
  g.restore();
  // Cup: seen from above and a little aslant, a rim ring around a dark mouth.
  g.save();
  g.translate(P * 2.5, P * 0.5);
  g.fillStyle = '#f0f0f0';
  g.beginPath();
  g.ellipse(0, 0, P * 0.3, P * 0.26, 0.4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#8c8c8c';
  g.beginPath();
  g.ellipse(0, 0, P * 0.2, P * 0.16, 0.4, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // Bag: a crumpled, ragged blob with folds (the shader makes it translucent).
  g.save();
  g.translate(P * 3.5, P * 0.5);
  g.fillStyle = '#ffffff';
  g.beginPath();
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = P * (0.3 + 0.11 * Math.sin(i * 2.7) + 0.06 * Math.cos(i * 5.1));
    if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r * 0.9);
    else g.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.9);
  }
  g.closePath();
  g.fill();
  g.strokeStyle = '#b0b0b0';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-P * 0.2, -P * 0.1);
  g.lineTo(P * 0.1, P * 0.05);
  g.lineTo(P * 0.2, -P * 0.12);
  g.moveTo(-P * 0.1, P * 0.18);
  g.lineTo(P * 0.05, P * 0.1);
  g.stroke();
  g.restore();
  const tex = canvasTex(c, { repeat: false, anisotropy: 1 });
  // Cells touch: no mipmaps, so a far piece never blends in its neighbour's colour.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

const vert = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aMeta; // birth (s), life (s), ground y (m), seed 0..1 (whole part: kind, fraction: variation)
  uniform float uTime;
  uniform vec4 uKind[4]; // gravity, drag, size, spin
  uniform float uSlide;
  uniform float uSettle;
  uniform float uFade;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  varying vec2 vUv;
  varying float vFog;
  varying float vAlpha;
  varying float vKind;
  varying float vShade;

  float hash(float n) { return fract(sin(n * 91.3458) * 47453.5453); }

  void main() {
    float t = uTime - aMeta.x;
    float u = t / aMeta.y;
    if (t < 0.0 || u >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    float s4 = aMeta.w * 4.0;
    float kind = min(floor(s4), 3.0);
    float seed = fract(s4);
    vec4 k = uKind[int(kind)];
    float g = k.x;
    float drag = k.y;
    // Airborne until the height over the road runs out: solve y0 + vy t - g t^2 / 2 = ground.
    float h = max(aPos.y - aMeta.z, 0.0);
    float tl = (aVel.y + sqrt(aVel.y * aVel.y + 2.0 * g * h)) / g;
    float ta = min(t, tl);
    float decay = exp(-drag * ta);
    vec3 p;
    p.xz = aPos.xz + aVel.xz * (1.0 - decay) / drag;
    p.y = aPos.y + aVel.y * ta - 0.5 * g * ta * ta;
    if (t > tl) {
      // Landed: skid along the road on what is left of the push.
      p.xz += aVel.xz * decay * (1.0 - exp(-uSlide * (t - tl))) / uSlide;
      p.y = aMeta.z + 0.012;
    }
    // Tumble about two axes (and a turn about the vertical) until it lies flat.
    float lay = t > tl ? smoothstep(0.0, uSettle, t - tl) : 0.0;
    float rate = k.w * (0.4 + hash(seed + 1.0));
    float ax = (hash(seed + 2.0) * 6.2831 + rate * ta) * (1.0 - lay);
    float az = (hash(seed + 3.0) * 6.2831 + rate * 0.7 * ta * (hash(seed + 4.0) > 0.5 ? 1.0 : -1.0)) * (1.0 - lay);
    float ay = hash(seed + 5.0) * 6.2831 + 0.6 * rate * t * (hash(seed + 6.0) - 0.5) * (1.0 - lay);
    float size = k.z * (0.75 + 0.65 * hash(seed + 7.0));
    vec3 q = vec3(position.x, 0.0, position.y) * size;
    float cx = cos(ax), sx = sin(ax), cz = cos(az), sz = sin(az), cy = cos(ay), sy = sin(ay);
    q = vec3(q.x * cz - q.y * sz, q.x * sz + q.y * cz, q.z);
    q = vec3(q.x, q.y * cx - q.z * sx, q.y * sx + q.z * cx);
    q = vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
    vec4 mv = viewMatrix * vec4(p + q, 1.0);
    float fd = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * fd * fd * hfMulView(mv.xyz));
    vAlpha = smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(1.0 - uFade, 1.0, u));
    vKind = kind;
    vShade = hash(seed + 8.0);
    // The cell of the atlas this kind lives in.
    vUv = vec2((uv.x + kind) / 4.0, uv.y);
    gl_Position = projectionMatrix * mv;
  }
`;

const frag = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 fogColor;
  uniform float uDim;
  uniform float uAlpha;
  varying vec2 vUv;
  varying float vFog;
  varying float vAlpha;
  varying float vKind;
  varying float vShade;
  void main() {
    vec4 tex = texture2D(map, vUv);
    float a = tex.a * vAlpha * uAlpha;
    if (a < 0.04) discard;
    vec3 tint;
    if (vKind < 0.5) tint = mix(vec3(0.95, 0.95, 0.9), vec3(0.85, 0.78, 0.5), vShade);
    else if (vKind < 1.5) tint = mix(vec3(0.22, 0.38, 0.1), vec3(0.5, 0.28, 0.08), vShade);
    else if (vKind < 2.5) tint = mix(vec3(0.75, 0.1, 0.08), vec3(0.9, 0.9, 0.88), step(0.5, vShade));
    else { tint = vec3(0.85, 0.88, 0.9); a *= 0.55; }
    // Backs are as bright as fronts: nothing here is lit, only dimmed to the night.
    vec3 col = tex.rgb * tint * uDim;
    gl_FragColor = vec4(mix(fogColor, col, vFog), a);
  }
`;

export class Litter {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private tex: THREE.CanvasTexture;
  private pos: THREE.InstancedBufferAttribute;
  private vel: THREE.InstancedBufferAttribute;
  private meta: THREE.InstancedBufferAttribute;
  private size: number;
  private next = 0;
  /** Dirty slots since the last update: [from, from + count) in ring order. */
  private dirtyFrom = -1;
  private dirtyCount = 0;
  /** Fractional pieces carried to the next tick, per car. */
  private owed: number[] = [];
  private readonly rateScale: number;

  constructor(quality: LitterQuality = 'medium') {
    this.size = LITTER.pool[quality] ?? LITTER.pool.medium;
    this.rateScale = this.size / LITTER.pool.medium;
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
    this.tex = drawAtlas();
    const kinds = [0, 1, 2, 3].map((i) => new THREE.Vector4(LITTER.gravity[i], LITTER.drag[i], LITTER.size[i], LITTER.spin[i]));
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: {
        map: { value: this.tex },
        uTime: { value: 0 },
        uKind: { value: kinds },
        uSlide: { value: LITTER.slide },
        uSettle: { value: LITTER.settle },
        uFade: { value: LITTER.fade },
        uDim: { value: LITTER.dim },
        uAlpha: { value: LITTER.alpha },
        fogColor: { value: new THREE.Color(FOG_COLOR) },
        fogDensity: { value: FOG_DENSITY },
        ...HEIGHT_FOG_UNIFORMS,
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'litter';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = this.size > 0;
  }

  /**
   * Once per sim tick (dt s), after the step: every car near the camera (camX, camZ) above `minSpeed` sheds
   * pieces behind its rear axle, more on a littered street. `time` is the scene clock (s).
   */
  tick(cars: readonly RaceCar[], world: World, camX: number, camZ: number, time: number, dt: number): void {
    if (this.size === 0) return;
    const range2 = LITTER.range * LITTER.range;
    const near = routeNearness(world);
    const plan = world.graph.plan;
    for (let ci = 0; ci < cars.length; ci++) {
      const c = cars[ci].state;
      if (c.speed < LITTER.minSpeed || (c.x - camX) ** 2 + (c.z - camZ) ** 2 > range2) {
        this.owed[ci] = 0;
        continue;
      }
      const litter = LITTER.minLitter + (1 - LITTER.minLitter) * Math.max(downtownFactor(plan, c.x, c.z), near.at(c.x, c.z));
      const speed = clamp01((c.speed - LITTER.minSpeed) / (LITTER.fullSpeed - LITTER.minSpeed));
      const owed = (this.owed[ci] ?? 0) + LITTER.perSecond * this.rateScale * speed * litter * dt;
      const n = Math.floor(owed);
      this.owed[ci] = owed - n;
      if (n <= 0) continue;
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      const geo = cars[ci].tuning.geometry;
      const back = geo.wheels[2][2] - 0.4;
      const rx = c.x + fx * back;
      const rz = c.z + fz * back;
      const ground = world.heightAt(rx, rz, c.y);
      this.emit(time, rx, ground + 0.12, rz, c.vx, c.vz, fz, -fx, c.speed, ground, n, dt);
    }
  }

  /** Throw `n` pieces from (x, y, z) behind a car moving at (vx, vz) m/s; (sx, sz) is its sideways unit vector. */
  private emit(time: number, x: number, y: number, z: number, vx: number, vz: number, sx: number, sz: number, speed: number, ground: number, n: number, dt: number): void {
    const [l0, l1] = LITTER.life;
    const P = this.pos.array as Float32Array;
    const V = this.vel.array as Float32Array;
    const M = this.meta.array as Float32Array;
    const r = Math.random;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.size;
      // Kind by the mix, then the seed carries the kind in its whole part (the shader reads both).
      let kind = 0;
      let pick = r();
      while (kind < 3 && pick > LITTER.mix[kind]) pick -= LITTER.mix[kind++];
      const carry = LITTER.carry[0] + (LITTER.carry[1] - LITTER.carry[0]) * r();
      const side = (r() * 2 - 1) * LITTER.side;
      P[i * 3] = x + sx * (r() * 2 - 1) * 0.8;
      P[i * 3 + 1] = y + r() * 0.1;
      P[i * 3 + 2] = z + sz * (r() * 2 - 1) * 0.8;
      V[i * 3] = vx * carry + sx * side;
      V[i * 3 + 1] = (LITTER.lift[0] + LITTER.lift[1] * speed) * (0.5 + r());
      V[i * 3 + 2] = vz * carry + sz * side;
      // Spread across the tick that threw them so a 60 Hz stream looks continuous.
      M[i * 4] = time - r() * dt;
      M[i * 4 + 1] = l0 + (l1 - l0) * r();
      M[i * 4 + 2] = ground;
      M[i * 4 + 3] = (kind + Math.min(0.999, r())) / 4;
    }
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = (this.next - n + this.size) % this.size;
      this.dirtyCount = n;
    } else this.dirtyCount = Math.min(this.size, this.dirtyCount + n);
  }

  /** Once per frame: advance the clock (s) and upload the pieces the ticks since the last frame threw. */
  update(time: number): void {
    if (this.size === 0) return;
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
    this.tex.dispose();
  }
}
