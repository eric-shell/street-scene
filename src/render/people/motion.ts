/**
 * What a car does to the people, drawn: the dodge and the ragdoll every people shader shares (the stands, the
 * idlers, the walkers), and the plumbing that feeds them.
 *
 * The dodge is the GLSL twin of `sidestep()` in sim/people.ts, term for term, with the numbers baked in from
 * `PEOPLE` when the string is built: the sim moves each person by it before it tests a car against them, the
 * shader moves the drawn person by the same offset from the same cars, so what you see touch the car is what the
 * sim collided with. The two MUST change together (the spec is sidestep's JSDoc). The sim sums every car; a shader
 * sees the `PEOPLE_MAX_CARS` nearest the batch (`carsNear`), which is every car that can reach anyone in it in
 * practice and costs a fixed loop per vertex, the loop the stands' old radial push had.
 *
 * A person a car hits is flung and falls, stateless from (clock - hitTime, the fling velocity, a seed): `iHit` is
 * (hitTime s on the people clock, flingVx, flingVz, seed 0..1), hitTime < 0 = standing. The sim stamps each hit
 * (`PeopleState.hitTick`), `PeopleHits` copies new hits into the instance attribute only when `state.hits`
 * changes (one integer compare per frame otherwise), and the shader does the rest: airborne for 2 vy0 / g, then a
 * slide that brakes at 9 m/s^2 from 0.6 of the speed, a spin that dies with it, the body pitching to flat, the
 * limbs flailing with a damped oscillation and settling into a sprawl. The branch is per instance, so only hit
 * people pay for it. The fall starts where the sim registered the hit (`PeopleState.hitX/hitZ`: the person at their
 * dodged place, not at home): the shader's ragdoll runs from the instance's own translation, so `PeopleHits` moves
 * that translation once, at the hit, to put the drawn body exactly there (a walker's translation is shifted by what
 * its frozen walk adds, computed with `walkerAt`), and puts it back when the person stands up again.
 *
 * A material gets one `uCars` array per batch (its own nearest cars, written in the batch's update) rather than
 * one shared uniform written in `onBeforeRender`: three only uploads a material's uniforms when the material
 * changes between draw calls, so consecutive batches on one material would not see each other's cars.
 * Render only.
 */
import * as THREE from 'three';
import { PEOPLE } from '../../sim/people';
import type { PeopleState } from '../../sim/people';
import { nearestCars } from './placer';

/** Cars a people shader dodges and turns its head for: the nearest to the batch. */
export const PEOPLE_MAX_CARS = 4;

/** A car as the people shaders see it (the interpolated pose). */
export interface PeopleCar {
  x: number;
  z: number;
  /** Heading (three.js yaw, rad): forward is (sin, cos). */
  yaw: number;
  /** Speed (m/s). */
  speed: number;
}

/** A per batch car list: (x, z, yaw, speed) per car, far away when there are fewer cars than slots. */
export function makeCarsUniform(): { value: THREE.Vector4[] } {
  return { value: Array.from({ length: PEOPLE_MAX_CARS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) };
}

/**
 * Write the cars nearest to a batch into its uniform: those nearest the point of the batch's circle (center and
 * radius, m) closest to the listener, since that is where a dodge or a hit is seen from (the player's car is
 * always among them), not the middle of a 200 m cell.
 */
export function carsNear(cars: readonly PeopleCar[], lx: number, lz: number, cx: number, cz: number, radius: number, out: readonly THREE.Vector4[]): void {
  const dx = lx - cx;
  const dz = lz - cz;
  const d = Math.hypot(dx, dz);
  const k = d > radius ? radius / d : 1;
  nearestCars(cars, cx + dx * k, cz + dz * k, PEOPLE_MAX_CARS, out);
}

/** A float literal for GLSL. */
const f = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const S = PEOPLE.sidestep;
const LANE = S.carHalfWidth + PEOPLE.radius + S.margin;

/**
 * `vec2 pmSidestep(vec2 p, vec2 back, float backRoom, float prefer)`: the offset (m, world x and z) a person at p
 * steps to out of the way of `uCars`, `back` the unit vector toward the wall behind them and `backRoom` the room
 * before it. The twin of sim/people.ts `sidestep()`: lane, along, tAvail, canStep, the softly signed side with the
 * person's own `prefer`, the sum clamped to max * 1.2, then the wall clamp.
 */
export const PEOPLE_SIDESTEP_GLSL = /* glsl */ `
vec2 pmSidestep(vec2 p, vec2 back, float backRoom, float prefer) {
  vec2 o = vec2(0.0);
  for (int k = 0; k < ${PEOPLE_MAX_CARS}; k++) {
    vec4 c = uCars[k];
    if (c.w < ${f(S.minSpeed)}) continue;
    vec2 fw = vec2(sin(c.z), cos(c.z));
    vec2 rt = vec2(fw.y, -fw.x);
    vec2 d = p - c.xy;
    float ahead = dot(d, fw);
    float lat = dot(d, rt);
    if (abs(lat) >= ${f(LANE)}) continue;
    float along = ahead >= ${f(S.carHalfLength + 4)} ? 1.0 - smoothstep(${f(S.carHalfLength + 4)}, ${f(S.carHalfLength + S.lookAhead)}, ahead)
      : ahead >= ${f(-S.carHalfLength)} ? 1.0 : smoothstep(${f(-S.carHalfLength - S.behind)}, ${f(-S.carHalfLength)}, ahead);
    if (along <= 0.0) continue;
    float tAvail = (${f(S.lookAhead)} - clamp(ahead - ${f(S.carHalfLength)}, 0.0, ${f(S.lookAhead)})) / c.w;
    float canStep = min(${f(S.max)}, ${f(S.speed)} * tAvail);
    float s = clamp(lat / ${f(S.softSign)}, -1.0, 1.0);
    float want = (${f(LANE)} - abs(lat)) * (s + (1.0 - abs(s)) * prefer);
    o += rt * (min(abs(want), canStep) * along * (want < 0.0 ? -1.0 : 1.0));
  }
  float len = length(o);
  if (len > ${f(S.max * 1.2)}) o *= ${f(S.max * 1.2)} / len;
  float al = dot(o, back);
  if (al > backRoom) o -= back * (al - backRoom);
  return o;
}
`;

/**
 * The ragdoll and the step pose, as GLSL functions. Frames: the person's local x is their left, z their
 * forward, y up; the rig stands the hips at p0.x, so a ragdoll sets p0.x to 0 and lets the root carry the height.
 */
export const PEOPLE_RAGDOLL_GLSL = /* glsl */ `
/** A world offset as the instance frame's own (the instance matrix scales and turns the person): per axis, dot(column, w) / |column|^2. */
vec3 pmLocal(mat4 m, vec3 w) {
  return vec3(dot(m[0].xyz, w) / max(dot(m[0].xyz, m[0].xyz), 1e-4), dot(m[1].xyz, w) / max(dot(m[1].xyz, m[1].xyz), 1e-4), dot(m[2].xyz, w) / max(dot(m[2].xyz, m[2].xyz), 1e-4));
}

/**
 * A step to the side: s is the step in the person's frame (x left, z forward, m), headTo the head turn toward
 * the car (rad). Blends over the variant's own pose by |s| / 0.5: the leg on the step side forward and bent, the
 * hips dropped as the weight shifts that way, the spine leaning away from the step, the arms a little out, the
 * head toward the car. The rig has no sideways leg, so a sidestep is a leading leg and a bent knee.
 */
void pmStepPose(vec2 s, float headTo, inout vec4 p0, inout vec4 p1, inout vec4 p2, inout vec4 p3) {
  float len = length(s);
  float k = clamp(len / 0.5, 0.0, 1.0);
  vec2 dir = s / max(len, 1e-4);
  float lead = 0.5 * abs(dir.x) + 0.45 * dir.y;
  float bend = 0.3 + 0.6 * abs(dir.x) + 0.3 * abs(dir.y);
  bool left = dir.x >= 0.0;
  vec4 legs = left ? vec4(lead, bend, -0.15 * abs(dir.x), 0.2) : vec4(-0.15 * abs(dir.x), 0.2, lead, bend);
  p3 = mix(p3, legs, k);
  p0.x -= 0.04 * k;
  p0.y -= 0.2 * dir.y * k;
  p0.z += 0.22 * dir.x * k;
  p1.x = mix(p1.x, headTo, k);
  p1.zw += vec2(0.3, 0.4) * k;
  p2.x += 0.3 * k;
  p2.yzw += vec3(0.3, 0.4, 0.3) * k;
}

/**
 * A person thrown by a car, t seconds after the hit (fling = the velocity in world x, z; seed 0..1 picks the spin,
 * the side they fall to and the sprawl; hip0 the hips' height in the pose they were standing in). Returns the body's
 * root matrix in the person's frame (height, spin, pitch to flat, a little roll) and 'disp', the horizontal travel in
 * world x and z from home; the variant adds both to its own placement. Overwrites the pose with the flail, which
 * dies away by tAir + 0.8 s and leaves the sprawl.
 *   airborne: vy0 = clamp(1.5 + 0.12 |v|, 1.5, 4), tAir = 2 vy0 / g, travel |v| t;
 *   then the slide brakes at 9 m/s^2 from 0.6 |v| (closed form), the spin (+-2..5 rad/s) dies with it;
 *   the pitch to flat takes 0.8 tAir and the hips settle at 0.16 m.
 */
mat4 pmRagdoll(float t, vec2 fling, float seed, float hip0, out vec2 disp, inout vec4 p0, inout vec4 p1, inout vec4 p2, inout vec4 p3) {
  float speed = length(fling);
  vec2 dir = fling / max(speed, 1e-3);
  float vy0 = clamp(1.5 + 0.12 * speed, 1.5, 4.0);
  float tAir = 2.0 * vy0 / 9.81;
  float tf = min(t, tAir);
  float s0 = 0.6 * speed;
  float ts = s0 / 9.0;
  float tg = clamp(t - tAir, 0.0, ts);
  disp = dir * (speed * tf + s0 * tg - 4.5 * tg * tg);
  float arc = max(vy0 * tf - 4.905 * tf * tf, 0.0);
  float fall = smoothstep(0.0, 0.8 * tAir, t);
  float hip = mix(hip0, 0.16, fall) + arc;
  float spinDir = fract(seed * 5.1) > 0.5 ? 1.0 : -1.0;
  float spin = spinDir * (2.0 + 3.0 * fract(seed * 3.7)) * (tf + tg - tg * tg / (2.0 * max(ts, 1e-3)));
  float pitch = (fract(seed * 9.3) > 0.5 ? 1.5 : -1.5) * fall;
  float roll = (fract(seed * 7.3) - 0.5) * 0.8 * fall;
  // The flail (arms up and out, legs splayed, knees bent, head back) fades into the sprawl by tAir + 0.8 s.
  float a = 1.0 - smoothstep(0.35 * tAir, tAir + 0.8, t);
  float ph = seed * 6.2832;
  float o1 = sin(t * 13.0 + ph);
  float o2 = sin(t * 11.0 + ph * 2.3);
  float o3 = sin(t * 15.0 + ph * 3.1);
  float r1 = fract(seed * 2.9);
  float r2 = fract(seed * 4.1);
  float r3 = fract(seed * 6.7);
  float r4 = fract(seed * 8.3);
  vec3 aL = mix(vec3(1.2 + 1.6 * r1, 0.5 + 0.6 * r2, 0.3 + 0.4 * r3), vec3(2.3 + 0.5 * o1, 1.1 + 0.4 * o2, 0.5 + 0.5 * abs(o3)), a);
  vec3 aR = mix(vec3(0.8 + 1.4 * r2, 0.5 + 0.6 * r3, 0.3 + 0.5 * r4), vec3(2.3 + 0.5 * o2, 1.1 + 0.4 * o3, 0.5 + 0.5 * abs(o1)), a);
  vec4 legs = mix(vec4(0.3 + 0.35 * r3, 0.2 + 0.4 * r4, -0.15 + 0.3 * r1, 0.5 * r2), vec4(0.5 + 0.6 * o2, 0.7 + 0.6 * abs(o1), 0.5 + 0.6 * o3, 0.7 + 0.6 * abs(o2)), a);
  float headYaw = mix((r4 - 0.5), 0.5 * o3, a);
  float headPitch = mix(0.15, -0.5, a);
  p0 = vec4(0.0, -0.3 * a, 0.2 * o1 * a, 0.3 * o2 * a);
  p1 = vec4(headYaw, headPitch, aL.x, aL.y);
  p2 = vec4(aL.z, aR.x, aR.y, aR.z);
  p3 = legs;
  return rigT(vec3(0.0, hip, 0.0)) * rigY(spin) * rigX(pitch) * rigZ(roll);
}
`;

/** The uniform, the attribute and the helper functions a people shader adds to its declarations (after RIG_GLSL, whose `rigT` / `rigX` / `rigY` / `rigZ` the ragdoll uses). */
export function PEOPLE_MOTION_PARS(maxCars: number = PEOPLE_MAX_CARS): string {
  if (maxCars !== PEOPLE_MAX_CARS) throw new Error('people shaders loop over PEOPLE_MAX_CARS cars');
  return /* glsl */ `
uniform vec4 uCars[${maxCars}];
// hitTime (s, the people clock; < 0 = standing), the fling velocity x and z (m/s), a seed 0..1.
attribute vec4 iHit;
${PEOPLE_SIDESTEP_GLSL}
${PEOPLE_RAGDOLL_GLSL}`;
}

/** A person's seed for the ragdoll, 0..1, from their look seed (a multiplicative hash, so neighbours differ). */
export const hitSeed = (lookSeed: number): number => (Math.imul(lookSeed | 0, 0x9e3779b1) >>> 0) / 4294967296;

/** An `iHit` attribute for n people, all standing, with each one's w lane in place (their ragdoll seed; walkers pack their dodge there, see walkers.ts). */
export function makeHitAttribute(seeds: ArrayLike<number>): THREE.InstancedBufferAttribute {
  const a = new Float32Array(seeds.length * 4);
  for (let i = 0; i < seeds.length; i++) a.set([-1, 0, 0, seeds[i]], i * 4);
  return new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage);
}

/** How far (m) a hit person may land from their batch, for the bounds (the fastest fling: 0.9 of a 90 m/s car is a long way, but the sim's cars top out near 80 m/s and the slide is short). */
export const FLING_MARGIN = 40;

/**
 * Where a person's drawn body starts, for `PeopleHits.bind`: the instance matrices holding their translation (the
 * batch's `instanceMatrix`, shared by its levels of detail) and, for a walker, where the unmoved shader draws them
 * at a time.
 */
export interface HitAnchor {
  matrix: THREE.InstancedBufferAttribute;
  /** A walker's frozen walk: writes the world x and z (m) the shader draws them at on the people clock at time t (s), `walkerAt`. Stands and idlers draw at their translation. */
  drawnAt?: (t: number, out: { x: number; z: number }) => void;
}

const drawn = { x: 0, z: 0 };

/** One attribute people are written into, and the callback that hears whether any of them is hit. */
interface HitSlot {
  attr: THREE.InstancedBufferAttribute;
  /** The matrices of the batch, marked for upload when a person in it moves to its hit position. */
  matrices: Set<THREE.InstancedBufferAttribute>;
  /** Called after a scan with whether any person of this attribute is hit now. */
  onChange?: (any: boolean) => void;
  n: number;
}

/**
 * Copies the sim's hits into the renderers' `iHit` attributes. Bind each drawn person (`bind`), call `update` every
 * frame with the race's `PeopleState` (or nothing in the menu city): it compares `state.hits` with the last seen
 * and does nothing else when they match. A new race (a different state object) clears every slot; a count that
 * went down in the same state (a replay rewound) rescans, so people stand up again.
 */
export class PeopleHits {
  private slotOf: (HitSlot | undefined)[] = [];
  private seed: number[] = [];
  private index: number[] = [];
  private bound: number[] = [];
  private anchor: (HitAnchor | undefined)[] = [];
  /** Home translation (m, x and z) of each bound person, read from their matrix at bind. */
  private homeX: number[] = [];
  private homeZ: number[] = [];
  private on: Uint8Array = new Uint8Array(0);
  private slots = new Map<THREE.InstancedBufferAttribute, HitSlot>();
  private state: PeopleState | null = null;
  private seen = 0;

  /** Person `id` is slot `index` of `attr`; its w lane is already in the attribute (makeHitAttribute) and is kept as it is. */
  bind(id: number, attr: THREE.InstancedBufferAttribute, index: number, onChange?: (any: boolean) => void, anchor?: HitAnchor): void {
    let s = this.slots.get(attr);
    if (!s) this.slots.set(attr, (s = { attr, matrices: new Set(), onChange, n: 0 }));
    this.slotOf[id] = s;
    this.index[id] = index;
    this.seed[id] = attr.getW(index);
    this.bound.push(id);
    if (anchor) {
      this.anchor[id] = anchor;
      s.matrices.add(anchor.matrix);
      // The matrices are written before the people are bound (the batch is built first), so this is the person's home.
      this.homeX[id] = anchor.matrix.array[index * 16 + 12];
      this.homeZ[id] = anchor.matrix.array[index * 16 + 14];
    }
  }

  /** Move person `id`'s drawn body to where the sim hit them (or back home with `state` null): the matrix translation's x and z, y and the rest of the matrix kept. */
  private place(id: number, state: PeopleState | null): void {
    const a = this.anchor[id];
    if (!a) return;
    let x = this.homeX[id];
    let z = this.homeZ[id];
    if (state) {
      x = state.hitX[id];
      z = state.hitZ[id];
      if (a.drawnAt) {
        // The shader draws a frozen walker at translation + (walk point - the walk's first point = home): shift by that.
        a.drawnAt(state.hitTick[id] / 60, drawn);
        x -= drawn.x - this.homeX[id];
        z -= drawn.z - this.homeZ[id];
      }
    }
    const m = a.matrix.array as Float32Array;
    m[this.index[id] * 16 + 12] = x;
    m[this.index[id] * 16 + 14] = z;
  }

  update(state: PeopleState | undefined): void {
    if (!state || !this.bound.length) return;
    if (state !== this.state) {
      this.state = state;
      this.on = new Uint8Array(Math.max(state.down.length, this.slotOf.length));
      this.seen = -1;
      this.clear();
    }
    if (state.hits === this.seen) return;
    this.seen = state.hits;
    const touched = new Set<HitSlot>();
    for (const id of this.bound) {
      const down = id < state.down.length && state.down[id] === 1;
      if (down === (this.on[id] === 1)) continue;
      const s = this.slotOf[id]!;
      if (down) s.attr.setXYZW(this.index[id], state.hitTick[id] / 60, state.hitVx[id], state.hitVz[id], this.seed[id]);
      else s.attr.setXYZW(this.index[id], -1, 0, 0, this.seed[id]);
      this.place(id, down ? state : null);
      this.on[id] = down ? 1 : 0;
      s.n += down ? 1 : -1;
      touched.add(s);
    }
    for (const s of touched) {
      s.attr.needsUpdate = true;
      for (const m of s.matrices) m.needsUpdate = true;
      s.onChange?.(s.n > 0);
    }
  }

  /** Stand everyone up. */
  private clear(): void {
    for (const s of this.slots.values()) {
      if (s.n === 0) continue;
      s.n = 0;
      s.attr.needsUpdate = true;
      for (const m of s.matrices) m.needsUpdate = true;
      s.onChange?.(false);
    }
    for (const id of this.bound) {
      if (!this.on[id]) continue;
      this.slotOf[id]!.attr.setXYZW(this.index[id], -1, 0, 0, this.seed[id]);
      this.place(id, null);
    }
    this.on.fill(0);
  }
}

/** Make a mesh's bounds reach `by` m further: a flung person leaves their batch, and a batch is culled by the sphere round its homes. */
export function growBounds(meshes: readonly THREE.Mesh[], by: number): void {
  for (const m of meshes) {
    const bs = (m as THREE.InstancedMesh).boundingSphere;
    if (bs) bs.radius += by;
  }
}
