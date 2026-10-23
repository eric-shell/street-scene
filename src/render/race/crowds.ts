/**
 * Spectator crowds. At the start and finish: rows of people lining the
 * sidewalks along the outer edge. Everywhere else on the route: the crowd of
 * every street meet (meetPlan.ts), packed against the cyan barrier and
 * thinning back among the parked cars. Never on the route. They are the
 * game's people (render/people/person.ts) at the crowd level of detail, in
 * street clothes from the shared wardrobe, some with a phone, a flag or a
 * glowstick: one InstancedMesh per stand, plus the far level drawn instead
 * beyond LOD_NEAR; sections past the draw distance are not drawn at all, and
 * density and draw distance follow the graphics quality.
 *
 * Animation is all in the vertex shader: the person's pose is computed per
 * instance from one float ("excitement") and a phase: idle sway, weight
 * shifting and a glance around, clapping as it rises, arms up waving and
 * jumping at the top, a phone held up filming or a flag waved overhead,
 * plus stepping back from cars that come too close. The CPU only updates
 * that float: it rises when a racer passes close (speed weighted) and when a
 * cheer wave started at the gate (start, lap, finish) sweeps along the stands,
 * then decays. Everything is driven from car positions and race events, so
 * replays cheer exactly like the live race. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { MeetPerson, MeetPlan } from './meetPlan';
import { CITY } from '../../city/config';
import { Rng } from '../../sim/prng';
import { routeSample } from '../../city/route';
import { distToSegment } from '../../sim/math';
import type { Contact } from '../../city/world';
import type { Quality } from '../../ui/settings';
import { WEAR, personGeometry, personMaterial, writeLook } from '../people/person';
import { streetLook } from '../people/looks';

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
  /** A start / finish stand, or a section along a closure or corner. */
  kind: 'gate' | 'section';
}

/** Spectators per graphics quality: density scale and rows deep along the start and finish. */
export const CROWD_QUALITY: Record<Quality, { density: number; rows: number }> = {
  low: { density: 0.55, rows: 2 },
  medium: { density: 0.8, rows: 2 },
  high: { density: 1, rows: 3 },
};

export interface CrowdOptions {
  /** 0..1 people per meter scale (graphics quality). */
  density?: number;
  /** Rows on the sidewalk (1 to 3). */
  rows?: number;
  /** The street meets whose crowds become the sections (none in an open world). */
  meet?: MeetPlan;
  /** Sections further than this from the camera are not drawn (m). */
  drawDistance?: number;
  /** More sections that belong to the city rather than to a meet (the night market's pens, marketPlan.ts), drawn like a meet's. */
  sections?: readonly (readonly MeetPerson[])[];
}

export interface Crowds {
  group: THREE.Group;
  /** Audio stands; levels refresh in update(). */
  spots: CrowdSpot[];
  /** Number of spectators. */
  readonly count: number;
  /** Number of sections (stands away from the start / finish). */
  readonly sectionCount: number;
  readonly enabled: boolean;
  /** Hide the crowd (open world) or show it again. */
  setEnabled(on: boolean): void;
  /** Start a wave of excitement at a gate; strength 1 = cheer, 1.5 = finish frenzy. */
  cheer(at: 'start' | 'lap' | 'finish', strength?: number): void;
  /** Per frame: time (s), frame dt, racer positions, and the listener (camera) for the audio levels. */
  update(time: number, dt: number, cars: readonly CrowdCar[], listenerX: number, listenerZ: number): void;
  dispose(): void;
}

/**
 * Cars the shader steps away from. A full field is ten cars; the four nearest the camera are the
 * only ones whose dodge anyone sees, and a longer uniform loop runs for every crowd vertex.
 */
const MAX_CARS = 4;
/** Stands further than this from the camera (m, from their edge) draw the far level instead. */
const LOD_NEAR = 45;
/** A meet with fewer people than this gets no stand. */
const SECTION_MIN = 6;
/** A racer this close excites people (m). */
const CHEER_RADIUS = 17;
/** Cheer waves travel along the stands at this speed (m/s). */
const WAVE_SPEED = 26;
/** Crowd extent around the line along the route (m): mostly on the approach. */
const BACK = 58;
const FWD = 38;

// ---------------------------------------------------------------------------
// The person's pose from excitement, in the shader
// ---------------------------------------------------------------------------

const CROWD_PARS = /* glsl */ `
uniform float uTime;
uniform vec4 uCars[${MAX_CARS}];
attribute vec4 iData;
attribute float iExcite;
vec3 crowdHue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
`;

/** Sets the pose's four vec4s (person.ts, PersonShader) from excitement, phase and what the hand holds. */
const CROWD_POSE = /* glsl */ `
  float cT = uTime;
  float cPh = iData.x * 6.2832;
  float cStyle = iData.y;
  float cE = clamp(iExcite, 0.0, 1.6);
  float cEx = smoothstep(0.08, 0.7, cE);
  int cWorn = int(lookB.w + 0.5);
  bool cPhone = (cWorn & ${WEAR.phone}) != 0;
  bool cWaving = (cWorn & ${WEAR.flag | WEAR.glowstick}) != 0;
  // Hips: a small idle bounce and sway; the excited jump.
  float hop = (0.02 + 0.015 * cStyle) * abs(sin(cT * 2.0 + cPh)) * (1.0 - cEx)
    + 0.3 * smoothstep(0.45, 1.4, cE) * (0.6 + 0.6 * cStyle) * pow(max(0.0, sin(cT * 6.8 + cPh * 2.0)), 2.0);
  float sway = 0.035 * sin(cT * 1.1 + cPh) + 0.09 * cEx * sin(cT * 4.6 + cPh);
  float shift = sin(cT * 0.9 + cPh) * (1.0 - cEx);
  float hipY = 0.965 + hop;
  // Legs: weight shifting side to side when idle, knees tucked a little in the jump.
  float kneeL = 0.1 + 0.06 * shift + hop * 0.9;
  float kneeR = 0.1 - 0.06 * shift + hop * 0.9;
  // Arms: hanging with a little swing, clapping as the excitement rises, up and waving at the top.
  float wave = sin(cT * (8.0 + 3.0 * cStyle) + cPh);
  float pump = cStyle > 0.6 ? 0.5 * max(0.0, sin(cT * 9.0 + cPh)) : 0.0;
  float clap = smoothstep(0.25, 0.55, cE) * (1.0 - smoothstep(0.7, 1.0, cE));
  float clapIn = 0.08 + 0.3 * max(0.0, sin(cT * 9.0 + cPh));
  vec3 aL = mix(mix(vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh + 1.0), 0.1, 0.25), vec3(2.45 + 0.35 * sin(cT * (8.0 + 3.0 * cStyle) + cPh + 1.3) - pump, 0.35, 0.45), cEx), vec3(1.0, clapIn, 1.55), clap);
  vec3 aR = mix(mix(vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh - 1.0), 0.1, 0.25), vec3(2.45 + 0.35 * wave - pump, 0.35, 0.45), cEx), vec3(1.0, clapIn, 1.55), clap);
  // A phone held up toward the road, filming; a flag or glowstick waved overhead the whole time.
  if (cPhone) aR = vec3(mix(1.45, 1.9, cEx) + 0.12 * cEx * wave, 0.0, 1.05 - 0.3 * cEx);
  if (cWaving) aR = vec3(2.4 + (0.3 + 0.25 * cEx) * sin(cT * (2.2 + 4.5 * cEx) + cPh), 0.3, 0.2);
  // A look around when idle, up at the arms when cheering.
  float headYaw = 0.3 * sin(cT * 0.5 + cPh * 1.7) * (1.0 - cEx);
  float headPitch = 0.04 - 0.14 * cEx;
  vec4 p0 = vec4(hipY, 0.04 + 0.08 * cEx * sin(cT * 4.6 + cPh), sway, 0.0);
  vec4 p1 = vec4(headYaw, headPitch, aL.x, aL.y);
  vec4 p2 = vec4(aL.z, aR.x, aR.y, aR.z);
  vec4 p3 = vec4(kneeL * 0.5, kneeL, kneeR * 0.5, kneeR);
  // The items' light: a phone's screen (with the odd camera flash when the crowd goes wild), a glowstick or a flag in a neon hue.
  vec3 neon = crowdHue(fract(iData.x * 13.7));
  cloth = neon * 0.6;
  if (cPhone) {
    float flash = step(0.94, fract(sin(floor(cT * 7.0) * 78.233 + iData.x * 431.0) * 43758.5453)) * cEx;
    itemGlow = vec3(0.55, 0.7, 1.0) * (1.3 + 5.0 * flash);
  } else itemGlow = neon * (1.6 + 1.6 * cEx);
`;

/** After the pose: step back from cars that come too close (a world space push in the instance frame), and fade the tiny emitters with distance so they never sparkle in the bloom. */
const CROWD_POST = /* glsl */ `
  vec2 cAt = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  vec2 push = vec2(0.0);
  for (int i = 0; i < ${MAX_CARS}; i++) {
    vec2 d = cAt - uCars[i].xy;
    float l = length(d);
    if (l < 2.8 && l > 1e-3) push += d / l * (2.8 - l) * 0.65;
  }
  mat3 cInst = mat3(instanceMatrix);
  float cScale2 = max(dot(cInst[0], cInst[0]), 1e-4);
  transformed += transpose(cInst) * vec3(push.x, 0.0, push.y) / cScale2;
  vec3 cWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vPersonGlow *= clamp(28.0 / max(distance(cWorld, cameraPosition), 1.0), 0.15, 1.0);
`;

function crowdMaterial(uniforms: { uTime: { value: number }; uCars: { value: THREE.Vector4[] } }): THREE.MeshStandardMaterial {
  const mat = personMaterial({ pars: CROWD_PARS, pose: CROWD_POSE, post: CROWD_POST, key: 'crowd' });
  const compile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCars = uniforms.uCars;
    compile(shader, renderer);
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Gate stands are thinned to this many people at density 1. */
const GATE_CAP = 1100;

interface Spot {
  x: number;
  y: number;
  z: number;
  /** Facing (three.js yaw): local +z toward the road. */
  yaw: number;
  /** Signed route distance from the gate line (0 for sections). */
  ds: number;
  /** Audio stand of the gate: 0 left of the road, 1 right (sections have one). */
  side: number;
}

/** Shared placement state for every stand: spacing between everyone placed so far, plus the world checks. */
function makePlacer(world: World) {
  const cell = 0.5;
  const taken = new Map<number, number[]>();
  const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);
  const contacts: Contact[] = [];
  const near: number[] = [];
  const route = world.route;
  return {
    /** A free standing spot: off the route corridor, not inside a block, not on a prop, clear of everyone else. */
    ok(x: number, z: number): boolean {
      const rp = world.routeProgress(x, z);
      const half = route.segWidth[rp.seg] / 2;
      const beyondEnds = !route.closed && (rp.s < 0.5 || rp.s > route.length - 0.5);
      if (Math.abs(rp.lateral) < half + 0.5 && !beyondEnds) return false;
      const n = world.collideCircle(x, z, 0.3, contacts);
      for (let i = 0; i < n; i++) {
        const c = contacts[i];
        if (c.kind === 'wall' && (x - c.px) * c.nx + (z - c.pz) * c.nz < -0.15) return false;
      }
      if (world.propGrid && world.props) {
        world.propGrid.query(x - 2, z - 2, x + 2, z + 2, near);
        for (const id of near) {
          const p = world.props[id];
          if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < (p.radius * 1.15 + 0.4) ** 2) return false;
        }
      }
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
    },
    take(x: number, z: number): void {
      const k = key(Math.floor(x / cell), Math.floor(z / cell));
      let list = taken.get(k);
      if (!list) taken.set(k, (list = []));
      list.push(x, z);
    },
  };
}
type Placer = ReturnType<typeof makePlacer>;

const groundY = (world: World, x: number, z: number) => world.heightAt(x, z) + (world.surfaceAt(x, z) === 'road' ? 0 : CITY.curbHeight);

/** Keep every step-th person so a stand stays under its cap. */
function thin(out: Spot[], cap: number): Spot[] {
  if (out.length <= cap) return out;
  const keep: Spot[] = [];
  const step = out.length / cap;
  for (let i = 0; i < cap; i++) keep.push(out[Math.floor(i * step)]);
  return keep;
}

/** The start / finish crowd: sidewalk rows along the route near the line (the meets stand behind its barriers). */
function placeGate(world: World, gate: CrowdGate, rng: Rng, density: number, rows: number, placer: Placer): Spot[] {
  const route = world.route;
  const L = route.length;
  const wrap = (d: number) => (route.closed ? ((((d + L / 2) % L) + L) % L) - L / 2 : d);
  const cy = Math.cos(gate.yaw);
  const sy = Math.sin(gate.yaw);
  const out: Spot[] = [];
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
    if (sidewalkRow && world.surfaceAt(x, z) !== 'sidewalk') return;
    // Clear of the gantry pillars and the firework racks beside them.
    const lx = (x - gate.position.x) * cy - (z - gate.position.z) * sy;
    const lz = (x - gate.position.x) * sy + (z - gate.position.z) * cy;
    if (Math.abs(lz) < 2.2 && Math.abs(lx) > gate.halfSpan - 1.4 && Math.abs(lx) < gate.halfSpan + 2.2) return;
    if (!placer.ok(x, z)) return;
    placer.take(x, z);
    // Face the road, turned a little toward the line, with some personality.
    const gx = gate.position.x - x;
    const gz = gate.position.z - z;
    const gl = Math.hypot(gx, gz) || 1;
    const fx = nx + (gx / gl) * 0.35;
    const fz = nz + (gz / gl) * 0.35;
    const yaw = Math.atan2(fx, fz) + rng.range(-0.3, 0.3);
    out.push({ x, y: groundY(world, x, z), z, yaw, ds, side: rp.lateral >= 0 ? 0 : 1 });
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
    } else continue; // Behind the barriers and rails near the line stands the street meet (meetPlan.ts).
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
  return thin(out, Math.round(GATE_CAP * Math.max(0.2, density)));
}

// ---------------------------------------------------------------------------

interface Stand {
  /** The gate this stand cheers for, or null for a section (closure or corner). */
  gate: CrowdGate | null;
  mesh: THREE.InstancedMesh;
  /** The far stand-in, sharing the instance data. */
  lite: THREE.InstancedMesh;
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
  /** Index of this stand's first spot in Crowds.spots (gates: left side, then right). */
  spot0: number;
}

export function buildCrowds(world: World, gates: readonly CrowdGate[], opts: CrowdOptions = {}): Crowds {
  const group = new THREE.Group();
  group.name = 'crowds';
  const density = opts.density ?? 1;
  const rows = opts.rows ?? 3;
  const drawDistance = opts.drawDistance ?? 260;
  const rng = new Rng((world.seed ^ 0xc40d) >>> 0);
  const geo = personGeometry('crowd');
  const liteGeo = personGeometry('far');
  const uniforms = { uTime: { value: 0 }, uCars: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) } };
  const mat = crowdMaterial(uniforms);
  const stands: Stand[] = [];
  const spots: CrowdSpot[] = [];
  const dummy = new THREE.Object3D();
  const placer = makePlacer(world);
  let total = 0;

  const addStand = (gate: CrowdGate | null, people: Spot[]) => {
    const n = people.length;
    // Instance attributes live on a per stand geometry that shares the person's vertex buffers.
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    g.setIndex(geo.index);
    g.boundingSphere = geo.boundingSphere!.clone();
    const lookA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const lookB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const data = new Float32Array(n * 4);
    const excite = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.InstancedMesh(g, mat, n);
    mesh.name = gate ? 'crowd' : 'crowdSection';
    const x = new Float32Array(n);
    const z = new Float32Array(n);
    const ds = new Float32Array(n);
    const spot = new Uint8Array(n);
    let cx = 0;
    let cz = 0;
    // Audio stand ends: gates per side, along the route; sections along their first wall's direction.
    const sides = gate ? 2 : 1;
    const ends = Array.from({ length: sides }, () => ({ lo: Infinity, hi: -Infinity, a: [0, 0], b: [0, 0] }));
    const ax = people[0].x;
    const az = people[0].z;
    const ux = people[n - 1].x - ax;
    const uz = people[n - 1].z - az;
    people.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      const s = rng.range(0.9, 1.08);
      dummy.scale.set(s * rng.range(0.92, 1.15), s, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const look = streetLook(() => rng.next());
      const r = rng.next();
      // Items: about 22% phones, 10% flags, 10% glowsticks.
      look.wear |= r < 0.22 ? WEAR.phone : r < 0.32 ? WEAR.flag : r < 0.42 ? WEAR.glowstick : 0;
      writeLook(lookA, lookB, i, look);
      // Phase and style (how big a mover) for the shader's pose.
      data.set([rng.next(), rng.next(), 0, 0], i * 4);
      x[i] = p.x;
      z[i] = p.z;
      ds[i] = p.ds;
      spot[i] = p.side;
      const e = ends[p.side];
      const t = gate ? p.ds : (p.x - ax) * ux + (p.z - az) * uz;
      if (t < e.lo) {
        e.lo = t;
        e.a = [p.x, p.z];
      }
      if (t > e.hi) {
        e.hi = t;
        e.b = [p.x, p.z];
      }
      cx += p.x;
      cz += p.z;
    });
    const iData = new THREE.InstancedBufferAttribute(data, 4);
    g.setAttribute('lookA', lookA);
    g.setAttribute('lookB', lookB);
    g.setAttribute('iData', iData);
    g.setAttribute('iExcite', excite);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    // The stand-in shares the instance buffers, so excitement and placement stay in step.
    const gl = new THREE.BufferGeometry();
    for (const name of Object.keys(liteGeo.attributes)) gl.setAttribute(name, liteGeo.attributes[name]);
    gl.setIndex(liteGeo.index);
    gl.boundingSphere = liteGeo.boundingSphere!.clone();
    gl.setAttribute('lookA', lookA);
    gl.setAttribute('lookB', lookB);
    gl.setAttribute('iData', iData);
    gl.setAttribute('iExcite', excite);
    const lite = new THREE.InstancedMesh(gl, mat, n);
    lite.name = mesh.name + 'Far';
    lite.instanceMatrix = mesh.instanceMatrix;
    lite.boundingSphere = mesh.boundingSphere?.clone() ?? null;
    lite.visible = false;
    group.add(lite);
    cx /= n;
    cz /= n;
    let radius = 0;
    for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(x[i] - cx, z[i] - cz));
    const spot0 = spots.length;
    for (const e of ends) {
      // A side without people still gets a (silent) spot so indices stay fixed.
      if (e.lo > e.hi) e.a = e.b = [cx, cz];
      spots.push({ ax: e.a[0], az: e.a[1], bx: e.b[0], bz: e.b[1], level: 0, kind: gate ? 'gate' : 'section' });
    }
    stands.push({ gate, mesh, lite, excite, x, z, ds, spot, cx, cz, radius, waves: [], maxE: 0, spot0 });
    total += n;
  };

  // The meets' crowds are planned already (meetPlan.ts): the gate stands keep clear of them.
  const meetZones = world.openWorld ? [] : (opts.meet?.zones ?? []);
  for (const zone of meetZones) for (const p of zone.people) placer.take(p.x, p.z);
  for (const gate of gates) {
    const people = placeGate(world, gate, rng, density, rows, placer);
    if (people.length) addStand(gate, people);
  }
  for (const zone of meetZones) {
    if (zone.people.length < SECTION_MIN) continue;
    addStand(
      null,
      zone.people.map((p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, ds: 0, side: 0 })),
    );
  }
  for (const people of world.openWorld ? [] : (opts.sections ?? [])) {
    if (people.length >= SECTION_MIN) addStand(null, people.map((p) => ({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, ds: 0, side: 0 })));
  }

  // The menu backdrop never calls update(): keep the idle animation going from the render clock.
  let externalAt = -1;
  if (stands.length) {
    stands[0].mesh.onBeforeRender = stands[0].lite.onBeforeRender = () => {
      if (externalAt < 0 || performance.now() - externalAt > 500) uniforms.uTime.value = performance.now() / 1000;
    };
  }

  let enabled = true;
  let now = 0;
  const levelSum = new Float32Array(spots.length);
  const levelW = new Float32Array(spots.length);

  function standFor(at: 'start' | 'lap' | 'finish'): Stand | undefined {
    if (at === 'lap') return stands.find((c) => c.gate?.kind === 'startFinish');
    return stands.find((c) => c.gate && (at === 'finish' ? c.gate.kind !== 'start' : c.gate.kind !== 'finish'));
  }

  function update(time: number, dt: number, cars: readonly CrowdCar[], lx: number, lz: number): void {
    externalAt = performance.now();
    now = time;
    uniforms.uTime.value = time;
    const uc = uniforms.uCars.value;
    // Nearest MAX_CARS to the camera by repeated selection (ten cars at most, no allocation).
    let taken = 0;
    for (let i = 0; i < MAX_CARS; i++) {
      let best = -1;
      let bestD = Infinity;
      for (let k = 0; k < cars.length && k < 31; k++) {
        if (taken & (1 << k)) continue;
        const d = (cars[k].x - lx) ** 2 + (cars[k].z - lz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (best >= 0) {
        taken |= 1 << best;
        const c = cars[best];
        uc[i].set(c.x, c.z, c.speed, 0);
      } else uc[i].set(1e6, 1e6, 0, 0);
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
    for (const cr of stands) {
      // Sections far from the camera are not drawn (gates always are: the cinematics look at them);
      // beyond LOD_NEAR the few-box stand-in is drawn instead.
      const camD = Math.hypot(lx - cr.cx, lz - cr.cz) - cr.radius;
      const shown = !!cr.gate || camD < drawDistance;
      const near = camD < LOD_NEAR;
      cr.mesh.visible = shown && near;
      cr.lite.visible = shown && !near;
      // Drop finished waves.
      for (let w = cr.waves.length - 1; w >= 0; w--) {
        const wv = cr.waves[w];
        if (time - wv.t0 > wv.hold + (BACK + 10) / WAVE_SPEED + 2) cr.waves.splice(w, 1);
      }
      let carNear = false;
      const reach = cr.radius + CHEER_RADIUS;
      for (const c of cars) if ((c.x - cr.cx) ** 2 + (c.z - cr.cz) ** 2 < reach * reach) carNear = true;
      const listenerNear = camD < 220;
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
    sectionCount: stands.filter((s) => !s.gate).length,
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      enabled = on;
      group.visible = on;
    },
    cheer(at, strength = 1) {
      const cr = standFor(at);
      if (!cr || !enabled) return;
      cr.waves.push({ t0: now, strength, hold: at === 'finish' ? 7 : at === 'start' ? 3.5 : 2.5 });
    },
    update,
    dispose() {
      for (const c of stands) {
        c.mesh.geometry.dispose();
        c.mesh.dispose();
        c.lite.geometry.dispose();
        c.lite.dispose();
      }
      geo.dispose();
      liteGeo.dispose();
      mat.dispose();
    },
  };
}
