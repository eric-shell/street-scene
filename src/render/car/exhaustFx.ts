/**
 * Exhaust flames and heat haze: what the tailpipes do beyond the nitrous cone and the audio synced pop flash
 * already on CarView. One pooled mesh of stretched, camera facing sprites (the sparks' and litter's pattern: a
 * flame's whole life is computed in the vertex shader from a birth record, the CPU only writes new ones into a
 * ring buffer; one draw call, no per-frame allocation, pool by quality), and a few screen space shimmer blobs the
 * post pass refracts (post.ts FxShader `uHaze`).
 *
 * What lights a flame, all read from the interpolated sim snapshots (`tick` compares the last two, once per sim
 * tick, so a replay shows the same flames at the same ticks):
 *  - an upshift near the redline with the pedal down: a short blue-rooted orange tongue and a glow on the bumper
 *    (a flat shift's ignition cut), bigger and bluer with nitrous;
 *  - a lift off the pedal at high rpm: a crackle of small pops over half a second, their times and tips hashed from
 *    the car and the tick (no Math.random: the same drive pops the same);
 *  - a lift on a turbo car: two soft blue white puffs, the flutter of the blow off, no flame;
 *  - nitrous: a bang when a stage lights, then a stream of stretched jets while it burns (layered over CarView's cone,
 *    which stays the core), at a rate per second so every frame rate shows the same plume.
 * Flames follow the car (they inherit its velocity and slow only by drag) so a flame at 40 m/s stays at the tip
 * instead of hanging in the air behind. The glow is a plain sprite on the bumper, never a real light.
 *
 * Haze: the nearest few cars with a hot exhaust get one blob each, projected to the screen here from the tips
 * (a point behind and above them) with a radius in screen heights and a strength that rises with rpm, pedal and
 * nitrous and eases with `damp`. Zero blobs when none is hot, which costs the post pass one uniform test.
 * Render only: reads snapshots and views, never writes into the sim.
 */
import * as THREE from 'three';
import type { RaceState } from '../../sim/race';
import { clamp01 } from '../../sim/math';
import { damp } from '../../shared/anim';
import type { PostFx } from '../post';
import type { CarView } from './carView';
import type { Snap } from '../../game/session/snap';

export type ExhaustQuality = 'low' | 'medium' | 'high';

/** Nitrous flame colors per stage (1..3, linear HDR): the stock blue, violet and hot pink of CarView's cone and the HUD bar. */
const STAGE_COLOR = [
  [0.5, 1.2, 3.2],
  [1.4, 0.9, 3.4],
  [3.4, 0.7, 1.9],
] as const;

export const EXHAUST_FX = {
  /** Live sprites at once per quality; the oldest are overwritten first. */
  pool: { low: 96, medium: 256, high: 512 } as Record<ExhaustQuality, number>,
  /** Whether rival cars flame too (Low: the player's car only). */
  rivals: { low: false, medium: true, high: true } as Record<ExhaustQuality, boolean>,
  /** Rivals this close to the camera (m) flame; the player's car always does. */
  range: 70,
  /** Horizontal air drag on a flame (1/s): it follows the car's velocity and the rest dies out. */
  drag: 2.5,
  /** Share of the car's velocity a flame is born with (1: it stays with the tip). */
  carry: 1,
  /** Never thinner than this many pixels on screen (distant flames would shimmer away). */
  minPixels: 1.5,
  /** Upshift flame (a flat shift's cut): needs the pedal this far down and rpm this share of the redline just before the shift. */
  upshift: {
    throttle: 0.6,
    rpmFrac: 0.72,
    /** Minimum gap between flames on one car (s). */
    cooldown: 0.4,
    /** Lifetime (s), length (m) and width (m) from a minimum shift to a redline one. */
    life: [0.15, 0.3],
    length: [0.55, 1.25],
    width: [0.1, 0.17],
    /** Exhaust speed (m/s) out of the tip, relative to the car. */
    kick: 6,
    /** Orange of the tongue (linear HDR); a nitrous shift takes the stage color instead. */
    color: [3.4, 0.95, 0.18],
  },
  /** Nitrous: the bang when a stage lights, and the stream of jets while it burns. */
  nitro: {
    bangLife: [0.3, 0.4, 0.5],
    bangLength: [1.6, 2.1, 2.6],
    bangWidth: [0.22, 0.26, 0.3],
    /** Jets per second per tip, their lifetime (s), and length and width (m) per stage. */
    rate: 42,
    jetLife: 0.12,
    jetLength: [1.5, 1.9, 2.4],
    jetWidth: [0.16, 0.19, 0.22],
    jetKick: 12,
    /** Bumper glow around the tips while it burns: size (m), per stage. */
    glow: [0.7, 0.85, 1],
  },
  /** Overrun crackle: pedal down within `held` ticks, then up (below `lift`) at this share of the redline and speed. */
  overrun: {
    throttle: 0.6,
    lift: 0.2,
    held: 20,
    rpmFrac: 0.6,
    minSpeed: 8,
    cooldown: 1,
    /** Seconds the crackle spans and how many pops it holds (min, max). */
    duration: 0.5,
    pops: [3, 8],
    /** Per pop: lifetime (s), length (m), width (m), at the smallest and largest of a seeded size. */
    life: [0.07, 0.14],
    length: [0.25, 0.6],
    width: [0.07, 0.12],
    color: [3.2, 0.8, 0.12],
    /** Glow on the bumper (m). */
    glow: 0.45,
  },
  /** Turbo flutter: a lift with the boost up (rpm share of the redline) puffs twice, `gap` s apart. */
  flutter: {
    rpmFrac: 0.45,
    cooldown: 0.6,
    count: 2,
    gap: 0.07,
    life: 0.3,
    /** Puff radius (m), first and last puff. */
    size: [0.2, 0.34],
    color: [0.7, 1.1, 1.8],
  },
  /** The bumper glow's life (s) with a shift flame, and its color (linear HDR). */
  glow: { life: 0.16, color: [2.4, 0.8, 0.22] },
  /** Heat haze: refraction blobs behind the nearest hot exhausts (post.ts `uHaze`). */
  haze: {
    /** Blobs per quality (the uniform array holds 4). Low: none. */
    blobs: { low: 0, medium: 3, high: 4 } as Record<ExhaustQuality, number>,
    /** Cars this close to the camera (m) shimmer, fading out toward the edge. */
    range: 40,
    /** World radius of a blob (m), and where it sits: this far behind the tips along the exhaust and this far up. */
    radius: 0.85,
    behind: 0.8,
    up: 0.2,
    /** Strength in screen heights of refraction at the blob's middle: idle, and the most (a nitrous redline pull). */
    min: 0.0006,
    max: 0.0075,
    /** Weights of rpm share (squared), the pedal and the nitrous stage burning in the heat, summing to 1. */
    rpmWeight: 0.55,
    pedalWeight: 0.2,
    nitroWeight: 0.25,
    /** How quickly the heat builds and cools (1/s). */
    rise: 3,
    fall: 1.6,
  },
} as const;

/** Most tips a car holds a world position for (the manifest has two or four). */
const MAX_TIPS = 4;
/** Pending timed events (pops, puffs, delayed flames) at once; more are dropped. */
const MAX_EVENTS = 64;
/** Event kinds. */
const SHIFT = 0;
const BANG = 1;
const POP = 2;
const PUFF = 3;

const vert = /* glsl */ `
  attribute vec2 corner;
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec3 aDir;
  attribute vec4 aMeta;  // birth (s), life (s), width (m), seed 0..1
  attribute vec4 aColor; // linear HDR rgb, length (m; 0: a round puff)
  uniform float uTime;
  uniform float uDrag;
  uniform float uPixel;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vRound;
  varying float vBoost;
  varying vec3 vColor;

  void main() {
    float t = uTime - aMeta.x;
    vAge = t / aMeta.y;
    vSeed = aMeta.w;
    vColor = aColor.rgb;
    if (t < 0.0 || vAge >= 1.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec3 centre = aPos + aVel * ((1.0 - exp(-uDrag * t)) / uDrag);
    vec4 pv = viewMatrix * vec4(centre, 1.0);
    float grow = min(1.0, t / (aMeta.y * 0.18));
    float minWide = uPixel * -pv.z;
    vec3 p = pv.xyz;
    if (aColor.w > 0.0) {
      // A stretched tongue from the tip along the exhaust: its direction on screen, at least as long as it is wide
      // so a flame pointing at (or away from) the camera still reads as a glow instead of collapsing to a line.
      float len = aColor.w * grow * (1.0 - 0.3 * vAge);
      float wide = max(aMeta.z * (1.0 + 0.4 * vAge), minWide);
      vec3 ax = (viewMatrix * vec4(aDir, 0.0)).xyz * len;
      float al = length(ax.xy);
      vec2 d2 = al > 1e-4 ? ax.xy / al : vec2(0.0, 1.0);
      float vis = max(al, wide * 1.7);
      p.xy += d2 * (corner.y * vis) + vec2(-d2.y, d2.x) * (corner.x * wide);
      p.z += ax.z * corner.y;
      vRound = 0.0;
      // Seen end on the flame's depth piles into one spot: brighter the shorter it looks.
      vBoost = 1.0 + 1.6 * (1.0 - clamp(al / max(len, 1e-4), 0.0, 1.0));
      vUv = vec2(corner.x, corner.y);
    } else {
      float r = max(aMeta.z * (0.6 + 0.9 * sqrt(vAge)) * mix(0.5, 1.0, grow), minWide);
      p.xy += vec2(corner.x, corner.y * 2.0 - 1.0) * r;
      vRound = 1.0;
      vBoost = 1.0;
      vUv = vec2(corner.x, corner.y);
    }
    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`;

const frag = /* glsl */ `
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vRound;
  varying float vBoost;
  varying vec3 vColor;
  void main() {
    float fade = (1.0 - vAge) * (1.0 - vAge);
    float f;
    vec3 col;
    if (vRound > 0.5) {
      vec2 q = vec2(vUv.x, vUv.y * 2.0 - 1.0);
      float r2 = dot(q, q);
      f = exp(-r2 * 3.2) * (1.0 - smoothstep(0.6, 1.0, r2));
      col = vColor;
    } else {
      float w = vUv.y;
      // Opens out of the pipe, then thins to nothing at the far end.
      float half_ = 0.3 + 0.7 * pow(w, 0.55);
      float across = abs(vUv.x) / half_;
      f = (1.0 - smoothstep(0.3, 1.0, across)) * pow(1.0 - w, 1.4);
      // Blue where the gas leaves the pipe, the stage or orange color after it, a hot core down the middle.
      float lum = max(vColor.r, max(vColor.g, vColor.b));
      vec3 root = vec3(0.3, 0.55, 1.0) * lum * 1.1;
      col = mix(root, vColor, smoothstep(0.0, 0.5, w));
      col += vec3(1.0, 0.92, 0.8) * pow(max(0.0, 1.0 - across), 3.0) * (1.0 - w) * lum * 0.25;
    }
    f *= (0.8 + 0.4 * vSeed) * fade * vBoost;
    gl_FragColor = vec4(col * f, 1.0);
  }
`;

/** A 32 bit integer hash of two integers, as a float in [0, 1): the crackle's times and tips come from the car and the tick. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const lerp = (r: readonly [number, number] | readonly number[], k: number) => r[0] + (r[1] - r[0]) * k;

const V = new THREE.Vector3();
const NDC = new THREE.Vector3();

export class ExhaustFx {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly vel: THREE.InstancedBufferAttribute;
  private readonly dir: THREE.InstancedBufferAttribute;
  private readonly meta: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly size: number;
  private next = 0;
  private dirtyFrom = -1;
  private dirtyCount = 0;
  private readonly quality: ExhaustQuality;

  /** Per car: session time (s) of the last flame of each kind (the cooldowns), and the sim tick the pedal was last down. */
  private readonly lastShift: Float64Array;
  private readonly lastOverrun: Float64Array;
  private readonly lastFlutter: Float64Array;
  private readonly pedalTick: Float64Array;
  /** Per car: nitrous jet spawns owed (fractions of one carry over frames). */
  private readonly jetOwed: Float32Array;
  /** Per car: smoothed exhaust heat 0..1 (the haze). */
  private readonly heat: Float32Array;
  /** Pending timed events (a ring of at most MAX_EVENTS): when (s), whose, kind, a size 0..1 / stage, and the tip (-1 all). */
  private evCount = 0;
  private readonly evAt = new Float64Array(MAX_EVENTS);
  private readonly evCar = new Int16Array(MAX_EVENTS);
  private readonly evKind = new Uint8Array(MAX_EVENTS);
  private readonly evSize = new Float32Array(MAX_EVENTS);
  private readonly evTip = new Int8Array(MAX_EVENTS);
  /** Each car's tips in the world (x, y, z per tip) and the exhaust direction (x, y, z), recomputed once per frame per car. */
  private readonly tipPos: Float32Array;
  private readonly tipDir: Float32Array;
  private readonly tipFrame: Int32Array;
  private frame = 1;
  private readonly p = new THREE.Vector3();

  constructor(
    quality: ExhaustQuality,
    private readonly views: readonly CarView[],
  ) {
    this.quality = quality;
    this.size = EXHAUST_FX.pool[quality];
    const n = views.length;
    this.lastShift = new Float64Array(n).fill(-1e9);
    this.lastOverrun = new Float64Array(n).fill(-1e9);
    this.lastFlutter = new Float64Array(n).fill(-1e9);
    this.pedalTick = new Float64Array(n).fill(-1e9);
    this.jetOwed = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.tipPos = new Float32Array(n * MAX_TIPS * 3);
    this.tipDir = new Float32Array(n * 3);
    this.tipFrame = new Int32Array(n);

    const geo = new THREE.InstancedBufferGeometry();
    // A unit quad: x across (-1..1), y along from the tip (0) to the far end (1).
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, 1, 1, -1, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    this.vel = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    this.dir = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 3), 3);
    const meta = new Float32Array(this.size * 4);
    for (let i = 0; i < this.size; i++) {
      meta[i * 4] = -1e6;
      meta[i * 4 + 1] = 1;
    }
    this.meta = new THREE.InstancedBufferAttribute(meta, 4);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(this.size * 4), 4);
    for (const a of [this.pos, this.vel, this.dir, this.meta, this.color]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.pos);
    geo.setAttribute('aVel', this.vel);
    geo.setAttribute('aDir', this.dir);
    geo.setAttribute('aMeta', this.meta);
    geo.setAttribute('aColor', this.color);
    geo.instanceCount = this.size;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uTime: { value: 0 }, uDrag: { value: EXHAUST_FX.drag }, uPixel: { value: 0.001 } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'exhaustFx';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  /** Whether car `i` flames at all this frame: the player's always, rivals on tiers that draw them and within range of the camera. */
  private wants(i: number, x: number, z: number, cam: THREE.Vector3): boolean {
    if (i === 0) return true;
    if (!EXHAUST_FX.rivals[this.quality]) return false;
    const dx = x - cam.x;
    const dz = z - cam.z;
    return dx * dx + dz * dz <= EXHAUST_FX.range * EXHAUST_FX.range;
  }

  private push(at: number, car: number, kind: number, size: number, tip: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    const k = this.evCount++;
    this.evAt[k] = at;
    this.evCar[k] = car;
    this.evKind[k] = kind;
    this.evSize[k] = size;
    this.evTip[k] = tip;
  }

  /**
   * Once per sim tick: compare each car's last two snapshots and queue what its pipes do. `time` is the session
   * clock (s), `cam` the camera's position (only cars near it queue anything).
   */
  tick(race: RaceState, prev: readonly Snap[], curr: readonly Snap[], time: number, cam: THREE.Vector3): void {
    const U = EXHAUST_FX.upshift;
    const O = EXHAUST_FX.overrun;
    const F = EXHAUST_FX.flutter;
    for (let i = 0; i < curr.length; i++) {
      const p = prev[i];
      const c = curr[i];
      if (!p || !this.views[i] || !this.wants(i, c.x, c.z, cam)) continue;
      const rc = race.cars[i];
      const frac = p.rpm / rc.tuning.engine.redline;
      if (c.throttle >= O.throttle) this.pedalTick[i] = race.tick;
      // Upshift under power near the redline.
      if (c.gear > p.gear && p.gear >= 1 && p.throttle >= U.throttle && frac >= U.rpmFrac && time - this.lastShift[i] >= U.cooldown) {
        this.lastShift[i] = time;
        this.push(time, i, SHIFT, p.nitro ? 1 : clamp01((frac - U.rpmFrac) / (1 - U.rpmFrac)), -1);
      }
      // A nitrous stage lighting.
      if (c.nitro && (!p.nitro || c.nitroStage > p.nitroStage)) this.push(time, i, BANG, Math.max(1, Math.min(3, c.nitroStage)), -1);
      // A lift off the pedal after it was down: flutter on a turbo car, a crackle of pops at high rpm.
      if (c.throttle <= O.lift && p.throttle > O.lift && race.tick - this.pedalTick[i] <= O.held && c.speed >= O.minSpeed && c.gear > 0) {
        if (rc.tuning.engine.turbo && frac >= F.rpmFrac && time - this.lastFlutter[i] >= F.cooldown) {
          this.lastFlutter[i] = time;
          for (let k = 0; k < F.count; k++) this.push(time + k * F.gap, i, PUFF, F.count > 1 ? k / (F.count - 1) : 0, -1);
        }
        if (frac >= O.rpmFrac && time - this.lastOverrun[i] >= O.cooldown) {
          this.lastOverrun[i] = time;
          const seed = race.tick * 131 + i * 7919;
          const n = Math.round(lerp(O.pops, hash01(seed, 1)));
          for (let k = 0; k < n; k++) {
            const at = time + (O.duration * (k + hash01(seed, 100 + k) * 0.8)) / n;
            this.push(at, i, POP, hash01(seed, 200 + k), Math.floor(hash01(seed, 300 + k) * MAX_TIPS));
          }
        }
      }
    }
  }

  /** The tips of car `i` and the exhaust direction in the world, from its body this frame (cached per frame). */
  private tips(i: number): number {
    const view = this.views[i];
    const n = Math.min(MAX_TIPS, view.tips.length);
    if (this.tipFrame[i] === this.frame) return n;
    this.tipFrame[i] = this.frame;
    view.body.updateWorldMatrix(true, false);
    const m = view.body.matrixWorld;
    for (let k = 0; k < n; k++) {
      const t = view.tips[k];
      this.p.set(t[0], t[1], t[2]).applyMatrix4(m);
      this.tipPos[(i * MAX_TIPS + k) * 3] = this.p.x;
      this.tipPos[(i * MAX_TIPS + k) * 3 + 1] = this.p.y;
      this.tipPos[(i * MAX_TIPS + k) * 3 + 2] = this.p.z;
    }
    // Local -Z (out of the tail), tipped a little down.
    this.p.set(0, -0.06, -1).transformDirection(m);
    this.tipDir[i * 3] = this.p.x;
    this.tipDir[i * 3 + 1] = this.p.y;
    this.tipDir[i * 3 + 2] = this.p.z;
    return n;
  }

  /** Write one sprite into the ring: a tongue of `length` m (0: a round puff) from tip `k` of car `i`, kicked `kick` m/s along the exhaust. */
  private spawn(time: number, i: number, k: number, pose: Snap, life: number, width: number, length: number, kick: number, rgb: readonly number[], boost = 1): void {
    const s = this.next;
    this.next = (this.next + 1) % this.size;
    const P = this.pos.array as Float32Array;
    const Vl = this.vel.array as Float32Array;
    const D = this.dir.array as Float32Array;
    const M = this.meta.array as Float32Array;
    const C = this.color.array as Float32Array;
    const o = (i * MAX_TIPS + k) * 3;
    const dx = this.tipDir[i * 3];
    const dy = this.tipDir[i * 3 + 1];
    const dz = this.tipDir[i * 3 + 2];
    const carry = EXHAUST_FX.carry;
    P[s * 3] = this.tipPos[o];
    P[s * 3 + 1] = this.tipPos[o + 1];
    P[s * 3 + 2] = this.tipPos[o + 2];
    Vl[s * 3] = pose.vx * carry + dx * kick;
    Vl[s * 3 + 1] = dy * kick;
    Vl[s * 3 + 2] = pose.vz * carry + dz * kick;
    D[s * 3] = dx;
    D[s * 3 + 1] = dy;
    D[s * 3 + 2] = dz;
    // Born a hair before this frame's clock, so a stream at 60 Hz does not tick.
    M[s * 4] = time - Math.random() * 0.012;
    M[s * 4 + 1] = life;
    M[s * 4 + 2] = width;
    M[s * 4 + 3] = Math.random();
    C[s * 4] = rgb[0] * boost;
    C[s * 4 + 1] = rgb[1] * boost;
    C[s * 4 + 2] = rgb[2] * boost;
    C[s * 4 + 3] = length;
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = s;
      this.dirtyCount = 1;
    } else this.dirtyCount = Math.min(this.size, this.dirtyCount + 1);
  }

  /** Bumper glow at tip `k`: a round puff of light on the tail around the pipe (no real light). */
  private glow(time: number, i: number, k: number, pose: Snap, size: number, rgb: readonly number[], life: number): void {
    this.spawn(time, i, k, pose, life, size, 0, 0, rgb);
  }

  /**
   * Once per frame, after the cars are posed: spawn what is due (queued events, the nitrous stream), advance the
   * clock and upload the new sprites. Paused frames spawn nothing and the sprites stand still with the clock.
   */
  update(time: number, dt: number, poses: readonly Snap[], cam: THREE.Vector3, paused: boolean, pixel: number): void {
    this.frame++;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uPixel.value = pixel * EXHAUST_FX.minPixels;
    if (!paused) {
      this.spawnEvents(time, poses);
      this.spawnJets(time, dt, poses, cam);
    }
    this.upload();
  }

  private spawnEvents(time: number, poses: readonly Snap[]): void {
    const U = EXHAUST_FX.upshift;
    const N = EXHAUST_FX.nitro;
    const O = EXHAUST_FX.overrun;
    const F = EXHAUST_FX.flutter;
    const G = EXHAUST_FX.glow;
    for (let e = 0; e < this.evCount; ) {
      if (this.evAt[e] > time) {
        e++;
        continue;
      }
      const i = this.evCar[e];
      const kind = this.evKind[e];
      const size = this.evSize[e];
      const tipK = this.evTip[e];
      // Remove by swapping in the last event.
      const last = --this.evCount;
      this.evAt[e] = this.evAt[last];
      this.evCar[e] = this.evCar[last];
      this.evKind[e] = this.evKind[last];
      this.evSize[e] = this.evSize[last];
      this.evTip[e] = this.evTip[last];
      const pose = poses[i];
      if (!pose || !this.views[i]) continue;
      const n = this.tips(i);
      if (kind === SHIFT) {
        // A nitrous shift runs in the stage's color; otherwise the blue rooted orange tongue.
        const stage = pose.nitro ? Math.max(1, Math.min(3, pose.nitroStage)) - 1 : -1;
        const rgb = stage >= 0 ? STAGE_COLOR[stage] : U.color;
        for (let k = 0; k < n; k++) {
          this.spawn(time, i, k, pose, lerp(U.life, size), lerp(U.width, size), lerp(U.length, size) * (stage >= 0 ? 1.3 : 1), U.kick, rgb);
          this.glow(time, i, k, pose, 0.5 + 0.4 * size, stage >= 0 ? STAGE_COLOR[stage] : G.color, G.life);
        }
      } else if (kind === BANG) {
        const s = Math.round(size) - 1;
        for (let k = 0; k < n; k++) {
          this.spawn(time, i, k, pose, N.bangLife[s], N.bangWidth[s], N.bangLength[s], U.kick * 1.4, STAGE_COLOR[s], 1.2);
          this.glow(time, i, k, pose, N.glow[s], STAGE_COLOR[s], N.bangLife[s] * 0.6);
        }
      } else if (kind === POP) {
        // One pipe spits: a small tongue and a pinch of glow on the bumper.
        const k = n > 0 ? tipK % n : 0;
        if (n > 0) {
          this.spawn(time, i, k, pose, lerp(O.life, size), lerp(O.width, size), lerp(O.length, size), U.kick * 0.6, O.color);
          this.glow(time, i, k, pose, O.glow * (0.7 + 0.5 * size), G.color, G.life * 0.6);
        }
      } else {
        // The flutter: soft blue white puffs at every tip, the second smaller and later.
        for (let k = 0; k < n; k++) this.spawn(time, i, k, pose, F.life, lerp(F.size, size), 0, 2.5, F.color);
      }
    }
  }

  private spawnJets(time: number, dt: number, poses: readonly Snap[], cam: THREE.Vector3): void {
    const N = EXHAUST_FX.nitro;
    for (let i = 0; i < poses.length; i++) {
      const pose = poses[i];
      if (!this.views[i] || !pose.nitro || !this.wants(i, pose.x, pose.z, cam)) {
        this.jetOwed[i] = 0;
        continue;
      }
      const stage = Math.max(1, Math.min(3, pose.nitroStage)) - 1;
      this.jetOwed[i] += dt * N.rate;
      const per = Math.min(4, Math.floor(this.jetOwed[i]));
      this.jetOwed[i] = this.jetOwed[i] >= 4 ? 0 : this.jetOwed[i] - per;
      if (per <= 0) continue;
      const n = this.tips(i);
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < per; j++) this.spawn(time, i, k, pose, N.jetLife, N.jetWidth[stage], N.jetLength[stage] * (0.75 + 0.5 * Math.random()), N.jetKick, STAGE_COLOR[stage]);
        this.glow(time, i, k, pose, N.glow[stage], STAGE_COLOR[stage], N.jetLife * 1.4);
      }
    }
  }

  private upload(): void {
    if (this.dirtyFrom < 0) return;
    const from = this.dirtyFrom;
    const count = this.dirtyCount;
    for (const [a, size] of [
      [this.pos, 3],
      [this.vel, 3],
      [this.dir, 3],
      [this.meta, 4],
      [this.color, 4],
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

  /**
   * Heat haze for this frame: the hottest nearby exhausts become up to `blobs` refraction blobs on `post`
   * (x, y in screen UV, radius in screen heights, strength). Call after the camera is placed for the frame.
   */
  haze(post: PostFx, camera: THREE.PerspectiveCamera, poses: readonly Snap[], redlines: readonly number[], time: number, dt: number, paused: boolean): void {
    const H = EXHAUST_FX.haze;
    const maxBlobs = paused ? 0 : H.blobs[this.quality];
    // Ease every car's heat toward what its engine and pedal say; a cold or far car cools to nothing.
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i];
      const rpm = clamp01(p.rpm / (redlines[i] || 7000));
      const hot = H.rpmWeight * rpm * rpm + H.pedalWeight * p.throttle * rpm + H.nitroWeight * (p.nitro ? 1 : 0);
      this.heat[i] += (hot - this.heat[i]) * damp(hot > this.heat[i] ? H.rise : H.fall, paused ? 0 : dt);
    }
    let count = 0;
    if (maxBlobs > 0) {
      camera.updateMatrixWorld();
      const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
      const blobs = post.hazeBlobs;
      // Nearest first: each pass picks the closest car not yet blobbed.
      let taken = 0;
      for (; count < maxBlobs; count++) {
        let best = -1;
        let bestD = H.range * H.range;
        for (let i = 0; i < poses.length; i++) {
          if (taken & (1 << i) || !this.views[i] || this.heat[i] < 0.01) continue;
          const dx = poses[i].x - camera.position.x;
          const dz = poses[i].z - camera.position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD) {
            bestD = d2;
            best = i;
          }
        }
        if (best < 0) break;
        taken |= 1 << best;
        // The blob's middle: behind the tips' centre along the exhaust and a little up.
        const n = this.tips(best);
        let cx = 0;
        let cy = 0;
        let cz = 0;
        for (let k = 0; k < n; k++) {
          cx += this.tipPos[(best * MAX_TIPS + k) * 3];
          cy += this.tipPos[(best * MAX_TIPS + k) * 3 + 1];
          cz += this.tipPos[(best * MAX_TIPS + k) * 3 + 2];
        }
        const inv = n > 0 ? 1 / n : 0;
        V.set(cx * inv + this.tipDir[best * 3] * H.behind, cy * inv + this.tipDir[best * 3 + 1] * H.behind + H.up, cz * inv + this.tipDir[best * 3 + 2] * H.behind);
        NDC.copy(V).applyMatrix4(camera.matrixWorldInverse);
        const depth = -NDC.z;
        if (depth < 0.5) {
          count--;
          continue;
        }
        NDC.copy(V).project(camera);
        // Fade toward the range's edge, and strength from the heat.
        const near = 1 - Math.sqrt(bestD) / H.range;
        const strength = (H.min + (H.max - H.min) * this.heat[best]) * near * near * 1.6;
        blobs[count].set(NDC.x * 0.5 + 0.5, NDC.y * 0.5 + 0.5, H.radius / (depth * 2 * tanHalf), strength);
      }
    }
    post.setHaze(count, time);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
