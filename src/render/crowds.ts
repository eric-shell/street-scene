/**
 * Spectator crowds at the start and finish: rows of low poly people lining
 * the sidewalks along the outer edge, and standing behind closure barriers
 * and corner rails near the line (on the spectator side, never on the
 * route). One InstancedMesh per gate (a single merged person with optional
 * phone / flag / glowstick that the vertex shader hides per instance), so
 * the whole crowd is one or two draw calls.
 *
 * Animation is all in the vertex shader: idle sway and bounce, arms up,
 * jumping and waving scaled by one float per instance ("excitement"),
 * plus stepping back from cars that come too close. The CPU only updates
 * that float: it rises when a racer passes close (speed weighted) and when a
 * cheer wave started at the gate (start, lap, finish) sweeps along the stands,
 * then decays. Everything is driven from car positions and race events, so
 * replays cheer exactly like the live race. Render only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../city/world';
import { CITY } from '../city/config';
import { Rng } from '../sim/prng';
import { routeSample } from '../city/route';
import { distToSegment } from '../sim/math';
import type { Contact } from '../city/world';

/** The gate fields the crowd needs (structurally a FinishGate). */
export interface CrowdGate {
  kind: 'start' | 'finish' | 'startFinish';
  s: number;
  position: { x: number; y: number; z: number };
  yaw: number;
  halfSpan: number;
}

/** A car as the crowd sees it (interpolated sim pose). */
export interface CrowdCar {
  x: number;
  z: number;
  speed: number;
}

/** One stand for the crowd audio: a segment along one side of a gate, with its current excitement. */
export interface CrowdSpot {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Excitement heard by the listener (0 idle murmur, 1 cheering, up to ~1.5 at the finish). */
  level: number;
}

export interface CrowdOptions {
  /** 0..1 people per meter scale (graphics quality). */
  density?: number;
  /** Rows on the sidewalk (1 to 3). */
  rows?: number;
}

export interface Crowds {
  group: THREE.Group;
  /** Audio stands; levels refresh in update(). */
  spots: CrowdSpot[];
  /** Number of spectators. */
  readonly count: number;
  readonly enabled: boolean;
  /** Hide the crowd (test drive / open world) or show it again. */
  setEnabled(on: boolean): void;
  /** Start a wave of excitement at a gate; strength 1 = cheer, 1.5 = finish frenzy. */
  cheer(at: 'start' | 'lap' | 'finish', strength?: number): void;
  /** Per frame: time (s), frame dt, racer positions, and the listener (camera) for the audio levels. */
  update(time: number, dt: number, cars: readonly CrowdCar[], listenerX: number, listenerZ: number): void;
  dispose(): void;
}

/** Cars the shader steps away from (player + three opponents). */
const MAX_CARS = 4;
/** A racer this close excites people (m). */
const CHEER_RADIUS = 17;
/** Cheer waves travel along the stands at this speed (m/s). */
const WAVE_SPEED = 26;
/** Crowd extent around the line along the route (m): mostly on the approach. */
const BACK = 58;
const FWD = 38;

const SHIRTS = [0x1b1d24, 0x2a2f3a, 0x8a1424, 0x1f3f8a, 0xd8d8d8, 0x121212, 0x3a5a2a, 0xc9a227, 0x6b2fc2, 0xff2d7a, 0x2de2ff, 0xff6a00, 0x7a7f8a, 0x0f3a3a, 0x5a1a4a].map((c) => new THREE.Color(c));

// ---------------------------------------------------------------------------
// The person: one merged low poly mesh. Attributes per vertex:
//   aPart: 0 body, 1 left arm, 2 right arm (items ride on the right arm)
//   aMat:  0 shirt, 1 pants, 2 skin, 3 hair, 4 dark, 5 glow, 6 flag cloth
//   aItem: 0 always, 1 phone, 2 flag, 3 glowstick (hidden unless the instance holds it)
// ---------------------------------------------------------------------------

const SHOULDER_Y = 1.4;
const SHOULDER_X = 0.28;

function personGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, part: number, mat: number, item = 0) => {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Float32Array(n).fill(part), 1));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(new Float32Array(n).fill(mat), 1));
    g.setAttribute('aItem', new THREE.Float32BufferAttribute(new Float32Array(n).fill(item), 1));
    parts.push(g);
  };
  add(0.34, 0.84, 0.2, 0, 0.42, 0, 0, 1); // legs
  add(0.44, 0.6, 0.25, 0, 1.13, 0, 0, 0); // torso
  add(0.22, 0.25, 0.23, 0, 1.585, 0.005, 0, 2); // head
  add(0.24, 0.08, 0.25, 0, 1.73, -0.01, 0, 3); // hair
  for (const [side, part] of [
    [1, 1],
    [-1, 2],
  ] as const) {
    const x = side * SHOULDER_X;
    add(0.12, 0.36, 0.13, x, 1.23, 0, part, 0); // sleeve
    add(0.1, 0.28, 0.11, x, 0.91, 0, part, 2); // forearm + hand
  }
  // Items in the right hand, along the arm past the hand.
  const hx = -SHOULDER_X;
  add(0.075, 0.14, 0.02, hx, 0.71, 0.03, 2, 5, 1); // phone (screen glows)
  add(0.03, 1.0, 0.03, hx, 0.3, 0, 2, 4, 2); // flag pole
  add(0.02, 0.34, 0.52, hx, -0.03, 0.27, 2, 6, 2); // flag cloth
  add(0.04, 0.34, 0.04, hx, 0.6, 0, 2, 5, 3); // glowstick
  const geo = mergeGeometries(parts)!;
  parts.forEach((g) => g.dispose());
  // Arms up and jumping reach above the rest pose.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 1.9);
  return geo;
}

const VERT_PARS = /* glsl */ `
uniform float uTime;
uniform vec4 uCars[${MAX_CARS}];
attribute float aPart;
attribute float aMat;
attribute float aItem;
attribute vec3 iShirt;
attribute vec4 iData;
attribute float iExcite;
varying vec3 vCrowdColor;
varying vec3 vCrowdGlow;
mat3 crowdRotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 crowdRotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
vec3 crowdHue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
`;

// Runs at the top of the normal chunk, so both the normal and the position see it.
const VERT_MAIN = /* glsl */ `
  float cT = uTime;
  float cPh = iData.x * 6.2832;
  float cItem = iData.y;
  float cStyle = iData.w;
  float cE = clamp(iExcite, 0.0, 1.6);
  float cEx = smoothstep(0.08, 0.7, cE);
  vec3 cP = position;
  vec3 cN = normal;
  // Arms: hang and swing a little when idle, go up and wave when excited.
  if (aPart > 0.5) {
    float side = aPart < 1.5 ? 1.0 : -1.0;
    float wave = sin(cT * (8.0 + 3.0 * cStyle) + cPh + side * 1.3);
    float pump = cStyle > 0.6 ? 0.5 * max(0.0, sin(cT * 9.0 + cPh)) : 0.0;
    float up = mix(0.07 + 0.04 * sin(cT * 1.6 + cPh + side), 2.45 + 0.35 * wave - pump, cEx);
    float fwd = 0.0;
    if (side < 0.0 && cItem > 0.5) {
      if (cItem < 1.5) {
        // Phone held up toward the road, filming.
        fwd = mix(1.9, 2.5, cEx);
        up = 0.12 + 0.18 * cEx * wave;
      } else {
        // Flag or glowstick waved overhead the whole time.
        up = 2.4 + (0.3 + 0.25 * cEx) * sin(cT * (2.2 + 4.5 * cEx) + cPh);
      }
    }
    mat3 arm = crowdRotZ(up * side) * crowdRotX(-fwd);
    vec3 pivot = vec3(SHOULDER_X * side, SHOULDER_Y, 0.0);
    cP = arm * (cP - pivot) + pivot;
    cN = arm * cN;
  }
  // Items the person does not hold collapse to a point.
  if (aItem > 0.5 && abs(aItem - cItem) > 0.5) cP = vec3(0.0);
  // Body: sway and a small bounce; excited people jump.
  float sway = 0.035 * sin(cT * 1.1 + cPh) + 0.09 * cEx * sin(cT * 4.6 + cPh);
  float hop = (0.02 + 0.015 * cStyle) * abs(sin(cT * 2.0 + cPh)) * (1.0 - cEx)
    + 0.3 * smoothstep(0.45, 1.4, cE) * (0.6 + 0.6 * cStyle) * pow(max(0.0, sin(cT * 6.8 + cPh * 2.0)), 2.0);
  mat3 body = crowdRotZ(sway);
  cP = body * cP + vec3(0.0, hop, 0.0);
  cN = body * cN;
  // Step back from cars that come too close (world space push, applied in the instance frame).
  vec2 cAt = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  vec2 push = vec2(0.0);
  for (int i = 0; i < ${MAX_CARS}; i++) {
    vec2 d = cAt - uCars[i].xy;
    float l = length(d);
    if (l < 2.8 && l > 1e-3) push += d / l * (2.8 - l) * 0.65;
  }
  mat3 cInst = mat3(instanceMatrix);
  float cScale2 = max(dot(cInst[0], cInst[0]), 1e-4);
  cP += transpose(cInst) * vec3(push.x, 0.0, push.y) / cScale2;
  // Colors per material slot; shirts and skin tones vary per instance.
  vec3 skin = mix(vec3(0.93, 0.72, 0.58), vec3(0.28, 0.17, 0.11), iData.z);
  vec3 pants = mix(vec3(0.035, 0.04, 0.055), vec3(0.08, 0.11, 0.24), fract(iData.x * 7.31));
  vec3 hair = mix(vec3(0.025, 0.02, 0.018), vec3(0.3, 0.19, 0.09), fract(iData.x * 3.7));
  vec3 neon = crowdHue(fract(iData.x * 13.7));
  vCrowdColor = aMat < 0.5 ? iShirt : aMat < 1.5 ? pants : aMat < 2.5 ? skin : aMat < 3.5 ? hair : aMat < 4.5 ? vec3(0.03) : aMat < 5.5 ? vec3(0.0) : neon * 0.6;
  vec3 glow = iShirt * 0.06;
  if (aMat > 4.5 && aMat < 5.5) {
    if (cItem < 1.5) {
      // Phone screen, with the odd camera flash when the crowd goes wild.
      float flash = step(0.94, fract(sin(floor(cT * 7.0) * 78.233 + iData.x * 431.0) * 43758.5453)) * cEx;
      glow = vec3(0.55, 0.7, 1.0) * (1.3 + 5.0 * flash);
    } else glow = neon * (1.6 + 1.6 * cEx);
  } else if (aMat > 5.5) glow = neon * 0.3;
  // Tiny emitters fade with distance so they never sparkle in the bloom.
  vec3 cWorld = (modelMatrix * instanceMatrix * vec4(cP, 1.0)).xyz;
  vCrowdGlow = glow * clamp(28.0 / max(distance(cWorld, cameraPosition), 1.0), 0.15, 1.0);
`;

function crowdMaterial(uniforms: { uTime: { value: number }; uCars: { value: THREE.Vector4[] } }): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCars = uniforms.uCars;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n#define SHOULDER_X ${SHOULDER_X.toFixed(3)}\n#define SHOULDER_Y ${SHOULDER_Y.toFixed(3)}\n${VERT_PARS}`)
      .replace('#include <color_vertex>', '')
      .replace('#include <beginnormal_vertex>', `${VERT_MAIN}\n  vec3 objectNormal = cN;\n  #ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n  #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = cP;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCrowdColor;\nvarying vec3 vCrowdGlow;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb = vCrowdColor;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vCrowdGlow;');
  };
  mat.customProgramCacheKey = () => 'crowd-v1';
  return mat;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface Spot {
  x: number;
  y: number;
  z: number;
  /** Facing (three.js yaw): local +z toward the road. */
  yaw: number;
  /** Signed route distance from the gate line. */
  ds: number;
  /** +1 left of the road, -1 right. */
  side: number;
}

function placeCrowd(world: World, gate: CrowdGate, rng: Rng, density: number, rows: number): Spot[] {
  const route = world.route;
  const L = route.length;
  const wrap = (d: number) => (route.closed ? ((((d + L / 2) % L) + L) % L) - L / 2 : d);
  const cy = Math.cos(gate.yaw);
  const sy = Math.sin(gate.yaw);
  const out: Spot[] = [];
  // Minimum spacing between people: a coarse hash of placed positions.
  const cell = 0.5;
  const taken = new Map<number, number[]>();
  const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);
  const free = (x: number, z: number) => {
    const ix = Math.floor(x / cell);
    const iz = Math.floor(z / cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const list = taken.get(key(ix + a, iz + b));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) if ((list[k] - x) ** 2 + (list[k + 1] - z) ** 2 < 0.42 * 0.42) return false;
      }
    }
    return true;
  };
  const take = (x: number, z: number) => {
    const k = key(Math.floor(x / cell), Math.floor(z / cell));
    let list = taken.get(k);
    if (!list) taken.set(k, (list = []));
    list.push(x, z);
  };
  const contacts: Contact[] = [];
  const near: number[] = [];
  // Route distance, continued past the ends of a sprint route (routeProgress clamps there).
  const p0 = route.points[0];
  const p1 = route.points[route.points.length - 1];
  const t0 = routeSample(route, 0);
  const t1 = routeSample(route, L);
  const routeS = (x: number, z: number, s: number) => {
    if (route.closed) return s;
    if (s < 0.5) return Math.min(s, (x - p0.x) * t0.tx + (z - p0.z) * t0.tz);
    if (s > L - 0.5) return Math.max(s, L + (x - p1.x) * t1.tx + (z - p1.z) * t1.tz);
    return s;
  };

  const tryPlace = (x: number, z: number, nx: number, nz: number, sidewalkRow: boolean) => {
    const rp = world.routeProgress(x, z);
    const ds = wrap(routeS(x, z, rp.s) - gate.s);
    if (ds < -BACK || ds > FWD) return;
    // Never on the route itself (also past the ends of a sprint route).
    const half = route.segWidth[rp.seg] / 2;
    const beyondEnds = !route.closed && (rp.s < 0.5 || rp.s > L - 0.5);
    if (Math.abs(rp.lateral) < half + 0.5 && !beyondEnds) return;
    if (sidewalkRow && world.surfaceAt(x, z) !== 'sidewalk') return;
    // Clear of the gantry pillars and the firework racks beside them.
    const lx = (x - gate.position.x) * cy - (z - gate.position.z) * sy;
    const lz = (x - gate.position.x) * sy + (z - gate.position.z) * cy;
    if (Math.abs(lz) < 2.2 && Math.abs(lx) > gate.halfSpan - 1.4 && Math.abs(lx) < gate.halfSpan + 2.2) return;
    // Not inside a block (behind a city wall) and not on a street prop.
    const n = world.collideCircle(x, z, 0.3, contacts);
    for (let i = 0; i < n; i++) {
      const c = contacts[i];
      if (c.kind === 'wall' && (x - c.px) * c.nx + (z - c.pz) * c.nz < -0.15) return;
    }
    if (world.propGrid && world.props) {
      world.propGrid.query(x - 2, z - 2, x + 2, z + 2, near);
      for (const id of near) {
        const p = world.props[id];
        if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < (p.radius * 1.15 + 0.4) ** 2) return;
      }
    }
    if (!free(x, z)) return;
    take(x, z);
    // Face the road, turned a little toward the line, with some personality.
    const gx = gate.position.x - x;
    const gz = gate.position.z - z;
    const gl = Math.hypot(gx, gz) || 1;
    const fx = nx + (gx / gl) * 0.35;
    const fz = nz + (gz / gl) * 0.35;
    const yaw = Math.atan2(fx, fz) + rng.range(-0.3, 0.3);
    const y = world.heightAt(x, z) + (world.surfaceAt(x, z) === 'road' ? 0 : CITY.curbHeight);
    out.push({ x, y, z, yaw, ds, side: rp.lateral >= 0 ? 1 : -1 });
  };

  const spacing = 0.7 / Math.max(0.2, density);
  const sidewalkRows = [0.38, 0.98, 1.58].slice(0, Math.max(1, Math.min(3, rows)));
  for (const w of world.walls) {
    if (distToSegment(gate.position.x, gate.position.z, w.ax, w.az, w.bx, w.bz) > BACK + 30) continue;
    const mx = (w.ax + w.bx) / 2;
    const mz = (w.az + w.bz) / 2;
    const rp = world.routeProgress(mx, mz);
    const ds = wrap(routeS(mx, mz, rp.s) - gate.s);
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (ds < -BACK - len || ds > FWD + len) continue;
    const half = route.segWidth[rp.seg] / 2;
    let depths: number[];
    let sidewalk = false;
    if (w.kind === 'wall') {
      // The outer sidewalk line of the route's own road, facing it: people stand on the sidewalk in front of it.
      if (Math.abs(Math.abs(rp.lateral) - (half + CITY.sidewalk)) > 1.3) continue;
      const lside = rp.lateral >= 0 ? 1 : -1;
      // Toward the road = minus the side's left vector.
      if (-(w.nx * rp.tz - w.nz * rp.tx) * lside < 0.8) continue;
      depths = sidewalkRows.map((d) => -d);
      sidewalk = true;
    } else {
      // Closure barriers and corner rails: on the spectator side, before the parked cars.
      if (Math.abs(rp.lateral) > half + 40) continue;
      depths = w.kind === 'barrier' ? [0.45] : [0.5, 1.05];
    }
    const dx = (w.bx - w.ax) / (len || 1);
    const dz = (w.bz - w.az) / (len || 1);
    depths.forEach((depth, row) => {
      for (let u = rng.range(0, spacing) + (row % 2) * spacing * 0.5; u < len; u += spacing * rng.range(0.85, 1.2)) {
        // Small gaps between groups of friends.
        if (rng.next() < 0.1) continue;
        const along = u + rng.range(-0.1, 0.1);
        const back = depth + rng.range(-0.08, 0.08);
        tryPlace(w.ax + dx * along - w.nx * back, w.az + dz * along - w.nz * back, w.nx, w.nz, sidewalk);
      }
    });
  }
  // Keep phones happy on busy corners: thin evenly down to the cap.
  const cap = Math.round(1100 * Math.max(0.2, density));
  if (out.length > cap) {
    const keep: Spot[] = [];
    const step = out.length / cap;
    for (let i = 0; i < cap; i++) keep.push(out[Math.floor(i * step)]);
    return keep;
  }
  return out;
}

// ---------------------------------------------------------------------------

interface GateCrowd {
  gate: CrowdGate;
  mesh: THREE.InstancedMesh;
  excite: THREE.InstancedBufferAttribute;
  x: Float32Array;
  z: Float32Array;
  ds: Float32Array;
  spot: Uint8Array;
  cx: number;
  cz: number;
  radius: number;
  /** Cheer waves: start time, strength, how long the stands hold it. */
  waves: { t0: number; strength: number; hold: number }[];
  maxE: number;
  /** Index of this gate's first spot in Crowds.spots (left side, then right). */
  spot0: number;
}

export function buildCrowds(world: World, gates: readonly CrowdGate[], opts: CrowdOptions = {}): Crowds {
  const group = new THREE.Group();
  group.name = 'crowds';
  const density = opts.density ?? 1;
  const rows = opts.rows ?? 3;
  const rng = new Rng((world.seed ^ 0xc40d) >>> 0);
  const geo = personGeometry();
  const uniforms = { uTime: { value: 0 }, uCars: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) } };
  const mat = crowdMaterial(uniforms);
  const crowds: GateCrowd[] = [];
  const spots: CrowdSpot[] = [];
  const dummy = new THREE.Object3D();
  let total = 0;

  for (const gate of gates) {
    const people = placeCrowd(world, gate, rng, density, rows);
    if (!people.length) continue;
    const n = people.length;
    // Instance attributes live on a per gate geometry that shares the person's vertex buffers.
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    g.setIndex(geo.index);
    g.boundingSphere = geo.boundingSphere!.clone();
    const shirt = new Float32Array(n * 3);
    const data = new Float32Array(n * 4);
    const excite = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.InstancedMesh(g, mat, n);
    mesh.name = 'crowd';
    const x = new Float32Array(n);
    const z = new Float32Array(n);
    const ds = new Float32Array(n);
    const spot = new Uint8Array(n);
    let cx = 0;
    let cz = 0;
    const ends = [
      { lo: Infinity, hi: -Infinity, a: [0, 0], b: [0, 0] },
      { lo: Infinity, hi: -Infinity, a: [0, 0], b: [0, 0] },
    ];
    people.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      const s = rng.range(0.9, 1.08);
      dummy.scale.set(s * rng.range(0.92, 1.15), s, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const c = SHIRTS[rng.int(0, SHIRTS.length - 1)];
      const bright = rng.range(0.75, 1.1);
      shirt.set([c.r * bright, c.g * bright, c.b * bright], i * 3);
      const r = rng.next();
      // Items: about 22% phones, 10% flags, 10% glowsticks.
      const item = r < 0.22 ? 1 : r < 0.32 ? 2 : r < 0.42 ? 3 : 0;
      data.set([rng.next(), item, rng.next() ** 1.3, rng.next()], i * 4);
      x[i] = p.x;
      z[i] = p.z;
      ds[i] = p.ds;
      const side = p.side > 0 ? 0 : 1;
      spot[i] = side;
      const e = ends[side];
      if (p.ds < e.lo) {
        e.lo = p.ds;
        e.a = [p.x, p.z];
      }
      if (p.ds > e.hi) {
        e.hi = p.ds;
        e.b = [p.x, p.z];
      }
      cx += p.x;
      cz += p.z;
    });
    g.setAttribute('iShirt', new THREE.InstancedBufferAttribute(shirt, 3));
    g.setAttribute('iData', new THREE.InstancedBufferAttribute(data, 4));
    g.setAttribute('iExcite', excite);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    cx /= n;
    cz /= n;
    let radius = 0;
    for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(x[i] - cx, z[i] - cz));
    const spot0 = spots.length;
    for (const e of ends) {
      // A side without people still gets a (silent) spot so indices stay fixed.
      if (e.lo > e.hi) e.a = e.b = [cx, cz];
      spots.push({ ax: e.a[0], az: e.a[1], bx: e.b[0], bz: e.b[1], level: 0 });
    }
    crowds.push({ gate, mesh, excite, x, z, ds, spot, cx, cz, radius, waves: [], maxE: 0, spot0 });
    total += n;
  }

  // The menu backdrop never calls update(): keep the idle animation going from the render clock.
  let externalAt = -1;
  if (crowds.length) {
    crowds[0].mesh.onBeforeRender = () => {
      if (externalAt < 0 || performance.now() - externalAt > 500) uniforms.uTime.value = performance.now() / 1000;
    };
  }

  let enabled = true;
  let now = 0;
  const levelSum = new Float32Array(spots.length);
  const levelW = new Float32Array(spots.length);

  function crowdFor(at: 'start' | 'lap' | 'finish'): GateCrowd | undefined {
    if (at === 'lap') return crowds.find((c) => c.gate.kind === 'startFinish');
    return crowds.find((c) => (at === 'finish' ? c.gate.kind !== 'start' : c.gate.kind !== 'finish'));
  }

  function update(time: number, dt: number, cars: readonly CrowdCar[], lx: number, lz: number): void {
    externalAt = performance.now();
    now = time;
    uniforms.uTime.value = time;
    const uc = uniforms.uCars.value;
    for (let i = 0; i < MAX_CARS; i++) {
      const c = cars[i];
      if (c) uc[i].set(c.x, c.z, c.speed, 0);
      else uc[i].set(1e6, 1e6, 0, 0);
    }
    levelSum.fill(0);
    levelW.fill(0);
    if (!enabled) {
      for (const s of spots) s.level = 0;
      return;
    }
    const up = 1 - Math.exp(-dt * 7);
    const down = 1 - Math.exp(-dt * 0.8);
    const r2 = CHEER_RADIUS * CHEER_RADIUS;
    for (const cr of crowds) {
      // Drop finished waves.
      for (let w = cr.waves.length - 1; w >= 0; w--) {
        const wv = cr.waves[w];
        if (time - wv.t0 > wv.hold + (BACK + 10) / WAVE_SPEED + 2) cr.waves.splice(w, 1);
      }
      let carNear = false;
      const reach = cr.radius + CHEER_RADIUS;
      for (const c of cars) if ((c.x - cr.cx) ** 2 + (c.z - cr.cz) ** 2 < reach * reach) carNear = true;
      const listenerNear = (lx - cr.cx) ** 2 + (lz - cr.cz) ** 2 < (cr.radius + 220) ** 2;
      // Idle and nobody around: nothing to compute.
      if (!carNear && !cr.waves.length && cr.maxE < 0.005) continue;
      const e = cr.excite.array as Float32Array;
      let maxE = 0;
      for (let i = 0; i < e.length; i++) {
        const px = cr.x[i];
        const pz = cr.z[i];
        let target = 0;
        if (carNear) {
          for (let k = 0; k < cars.length; k++) {
            const c = cars[k];
            const d2 = (c.x - px) ** 2 + (c.z - pz) ** 2;
            if (d2 < r2) {
              // Passing racers: louder the closer and faster; a waiting grid gets a murmur.
              const v = (1 - Math.sqrt(d2) / CHEER_RADIUS) * 1.35 * Math.min(1, 0.3 + c.speed / 14);
              if (v > target) target = v;
            }
          }
        }
        for (let w = 0; w < cr.waves.length; w++) {
          const wv = cr.waves[w];
          const tw = time - wv.t0 - Math.abs(cr.ds[i]) / WAVE_SPEED;
          if (tw > 0 && tw < wv.hold + 1.5) {
            const v = wv.strength * (tw < wv.hold ? 1 : 1 - (tw - wv.hold) / 1.5);
            if (v > target) target = v;
          }
        }
        let v = e[i];
        v += (target - v) * (target > v ? up : down);
        if (v < 0.001) v = 0;
        e[i] = v;
        if (v > maxE) maxE = v;
        if (listenerNear) {
          const sp = cr.spot0 + cr.spot[i];
          const wgt = 1 / (1 + ((px - lx) ** 2 + (pz - lz) ** 2) / 144);
          levelSum[sp] += v * wgt;
          levelW[sp] += wgt;
        }
      }
      cr.maxE = maxE;
      cr.excite.needsUpdate = true;
    }
    for (let i = 0; i < spots.length; i++) spots[i].level = levelW[i] > 1e-6 ? levelSum[i] / levelW[i] : 0;
  }

  return {
    group,
    spots,
    count: total,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      enabled = on;
      group.visible = on;
    },
    cheer(at, strength = 1) {
      const cr = crowdFor(at);
      if (!cr || !enabled) return;
      cr.waves.push({ t0: now, strength, hold: at === 'finish' ? 7 : at === 'start' ? 3.5 : 2.5 });
    },
    update,
    dispose() {
      for (const c of crowds) {
        c.mesh.geometry.dispose();
        c.mesh.dispose();
      }
      geo.dispose();
      mat.dispose();
    },
  };
}
