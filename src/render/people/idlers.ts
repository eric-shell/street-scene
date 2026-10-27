/**
 * The city's idle people, drawn: the planner's (idleSpots.ts) people waiting
 * at bus stops, sitting on benches and at cafe tables, leaning by park lamps
 * and chatting in front of shops. They never walk. They are the game's
 * people (people/person.ts) at the crowd and far levels of detail, grouped
 * into ~100 m cells, each cell one InstancedMesh per level sharing its
 * instance attributes (the crowds' pattern), so the whole street costs a
 * handful of draw calls and a cell off screen or too far costs nothing.
 *
 * The pose is all in the vertex shader from the person's phase and pose kind
 * (stand, sit, lean, phone): sway, weight shifting, a glance around, a phone
 * held up, a seated pose with the thighs forward and the shin vertical. Two
 * cars are passed in (the nearest to the listener): a person turns their head
 * to one within ~14 m and flinches back from a fast one within ~6 m, stateless
 * in the shader; sitters only turn their heads. A prop knocked over takes its
 * sitters and standers with it: update() watches RaceState.brokenProps for the
 * few anchored idlers and zeroes their instance. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Quality } from '../../ui/settings';
import { Rng } from '../../sim/prng';
import { WEAR, personGeometry, personMaterial, writeLook } from './person';
import { idleLook } from './looks';
import { nearestCars } from './placer';
import type { IdlePerson, IdlePose } from './idleSpots';

/** Idle people per graphics quality: the planner's density scale and cap, and how far they are drawn (m). */
export const IDLE_QUALITY: Record<Quality, { density: number; cap: number; draw: number }> = {
  low: { density: 0.5, cap: 220, draw: 200 },
  medium: { density: 0.8, cap: 360, draw: 280 },
  high: { density: 1, cap: 520, draw: 360 },
};

export interface IdlerCar {
  x: number;
  z: number;
  speed: number;
}

export interface Idlers {
  group: THREE.Group;
  /** Number of idle people. */
  readonly count: number;
  /** Per frame: time (s), the cars (interpolated), the listener (camera), and RaceState.brokenProps when racing. */
  update(time: number, cars: readonly IdlerCar[], listenerX: number, listenerZ: number, broken?: Uint8Array): void;
  dispose(): void;
}

export interface IdlerOptions {
  quality: Quality;
  /** The seed's wardrobe mood from the planner (-1 cool .. 1 warm). */
  warmth: number;
}

/** Cars the shader reacts to. */
const MAX_CARS = 2;
/** Cell size (m) and the distance inside which a cell draws the full figure (m, from its edge). */
const CELL = 200;
const LOD_NEAR = 50;

/** iData.z: the pose kind. */
const KIND: Record<IdlePose, number> = { stand: 0, sit: 1, lean: 2, phone: 3 };

const IDLE_PARS = /* glsl */ `
uniform float uTime;
uniform vec4 uCars[${MAX_CARS}];
attribute vec4 iData;
`;

/** Sets the pose's four vec4s (person.ts, PersonShader): the crowd's idle motion, a seated and a leaning pose, a glance, a reaction to cars. */
const IDLE_POSE = /* glsl */ `
  float cT = uTime;
  float cPh = iData.x * 6.2832;
  float cStyle = iData.y;
  bool cSit = iData.z > 0.5 && iData.z < 1.5;
  bool cLean = iData.z > 1.5 && iData.z < 2.5;
  int cWorn = int(lookB.w + 0.5);
  bool cPhone = (cWorn & ${WEAR.phone}) != 0;
  // The nearest car: a head turn within ~14 m, a flinch within ~6 m when it is fast (in the person's frame).
  vec2 cAt = instanceMatrix[3].xz;
  vec2 cFwd = normalize(instanceMatrix[2].xz + vec2(1e-5));
  vec2 cRgt = normalize(instanceMatrix[0].xz + vec2(1e-5));
  float cBestD = 1e9;
  vec2 cTo = vec2(0.0, 1.0);
  float cSpeed = 0.0;
  for (int i = 0; i < ${MAX_CARS}; i++) {
    vec2 d = uCars[i].xy - cAt;
    float l = length(d);
    if (l < cBestD) { cBestD = l; cTo = d; cSpeed = uCars[i].z; }
  }
  float cLook = 1.0 - smoothstep(9.0, 14.0, cBestD);
  float cCarYaw = clamp(atan(dot(cTo, cRgt), dot(cTo, cFwd)), -1.2, 1.2);
  float cFlinch = cSit ? 0.0 : (1.0 - smoothstep(3.5, 6.0, cBestD)) * smoothstep(6.0, 14.0, cSpeed);
  float sway = 0.03 * sin(cT * 1.1 + cPh);
  float shift = sin(cT * 0.9 + cPh);
  float hipY = cSit ? 0.57 : 0.965;
  float kneeL = 0.1 + 0.06 * shift + 0.25 * cFlinch;
  float kneeR = 0.1 - 0.06 * shift + 0.25 * cFlinch;
  vec3 aL = vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh + 1.0) + 0.7 * cFlinch, 0.1 + 0.3 * cFlinch, 0.25);
  vec3 aR = vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh - 1.0) + 0.7 * cFlinch, 0.1 + 0.3 * cFlinch, 0.25);
  // Hands in the lap when seated; a phone held up toward the road.
  if (cSit) { aL = vec3(0.6, 0.12, 0.95); aR = vec3(0.6, 0.12, 0.95); }
  if (cPhone) aR = cSit ? vec3(1.2, 0.0, 1.3) : vec3(1.45, 0.0, 1.05);
  float lean = cLean ? -0.14 : 0.04;
  lean += cSit ? 0.04 : 0.0;
  lean -= 0.3 * cFlinch;
  // A look around, or down at the phone, then at the car going by.
  float headYaw = mix(0.3 * sin(cT * 0.5 + cPh * 1.7), cCarYaw, cLook);
  float headPitch = cPhone ? 0.35 : 0.05 + 0.05 * sin(cT * 0.7 + cPh);
  vec4 p0 = vec4(hipY, lean, sway, 0.0);
  vec4 p1 = vec4(headYaw, headPitch, aL.x, aL.y);
  vec4 p2 = vec4(aL.z, aR.x, aR.y, aR.z);
  vec4 p3 = cSit ? vec4(1.45, 1.5, 1.45, 1.5) : vec4(kneeL * 0.5, kneeL, kneeR * 0.5, kneeR);
  cloth = vec3(0.0);
  itemGlow = cPhone ? vec3(0.55, 0.7, 1.0) * 1.3 : vec3(0.0);
`;

/** After the pose: fade the tiny phone emitters with distance so they never sparkle in the bloom. */
const IDLE_POST = /* glsl */ `
  vec3 cWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vPersonGlow *= clamp(28.0 / max(distance(cWorld, cameraPosition), 1.0), 0.15, 1.0);
`;

function idleMaterial(uniforms: { uTime: { value: number }; uCars: { value: THREE.Vector4[] } }): THREE.MeshStandardMaterial {
  // Its own program key: 'crowd' would hand this material the crowd's compiled program.
  const mat = personMaterial({ pars: IDLE_PARS, pose: IDLE_POSE, post: IDLE_POST, key: 'idle' });
  const compile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCars = uniforms.uCars;
    compile(shader, renderer);
  };
  return mat;
}

interface Cell {
  mesh: THREE.InstancedMesh;
  lite: THREE.InstancedMesh;
  cx: number;
  cz: number;
  radius: number;
}

/** An idler tied to a prop: where its instance lives and the matrix to restore. */
interface Anchored {
  cell: Cell;
  index: number;
  prop: number;
  /** The last brokenProps byte seen. */
  seen: number;
  matrix: Float32Array;
}

export function buildIdlers(_world: World, people: IdlePerson[], opts: IdlerOptions): Idlers {
  const group = new THREE.Group();
  group.name = 'idlers';
  const geo = personGeometry('crowd');
  const liteGeo = personGeometry('far');
  const uniforms = { uTime: { value: 0 }, uCars: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) } };
  const mat = idleMaterial(uniforms);
  const drawDistance = IDLE_QUALITY[opts.quality].draw;
  const dummy = new THREE.Object3D();
  const cells: Cell[] = [];
  const anchored: Anchored[] = [];

  // Group by 100 m cell, in planner order inside each.
  const byCell = new Map<number, IdlePerson[]>();
  for (const p of people) {
    const k = (Math.floor(p.x / CELL) + 4096) * 8192 + (Math.floor(p.z / CELL) + 4096);
    let list = byCell.get(k);
    if (!list) byCell.set(k, (list = []));
    list.push(p);
  }

  const share = (src: THREE.BufferGeometry, attrs: Record<string, THREE.BufferAttribute>): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
    g.setIndex(src.index);
    g.boundingSphere = src.boundingSphere!.clone();
    for (const name of Object.keys(attrs)) g.setAttribute(name, attrs[name]);
    return g;
  };

  for (const list of byCell.values()) {
    const n = list.length;
    const lookA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const lookB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const data = new Float32Array(n * 4);
    const iData = new THREE.InstancedBufferAttribute(data, 4);
    const attrs = { lookA, lookB, iData };
    const mesh = new THREE.InstancedMesh(share(geo, attrs), mat, n);
    mesh.name = 'idlers';
    let cx = 0;
    let cz = 0;
    list.forEach((p, i) => {
      const rng = new Rng(p.lookSeed);
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      const s = rng.range(0.93, 1.06);
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const look = idleLook(() => rng.next(), opts.warmth);
      // The standing phone pose holds one; about one in ten of the rest do too.
      if (p.pose === 'phone' || rng.next() < 0.1) look.wear |= WEAR.phone;
      writeLook(lookA, lookB, i, look);
      data.set([rng.next(), rng.next(), KIND[p.pose], 0], i * 4);
      cx += p.x;
      cz += p.z;
    });
    cx /= n;
    cz /= n;
    let radius = 0;
    for (const p of list) radius = Math.max(radius, Math.hypot(p.x - cx, p.z - cz));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    const lite = new THREE.InstancedMesh(share(liteGeo, attrs), mat, n);
    lite.name = 'idlersFar';
    lite.instanceMatrix = mesh.instanceMatrix;
    lite.boundingSphere = mesh.boundingSphere?.clone() ?? null;
    lite.visible = false;
    group.add(lite);
    const cell: Cell = { mesh, lite, cx, cz, radius };
    cells.push(cell);
    list.forEach((p, i) => {
      if (p.anchorProp < 0) return;
      anchored.push({ cell, index: i, prop: p.anchorProp, seen: 0, matrix: Float32Array.from((mesh.instanceMatrix.array as Float32Array).subarray(i * 16, i * 16 + 16)) });
    });
  }

  // The menu backdrop never calls update(): keep the idle animation going from the render clock.
  let externalAt = -1;
  const clock = () => {
    if (externalAt < 0 || performance.now() - externalAt > 500) uniforms.uTime.value = performance.now() / 1000;
  };
  for (const c of cells) c.mesh.onBeforeRender = c.lite.onBeforeRender = clock;

  function update(time: number, cars: readonly IdlerCar[], lx: number, lz: number, broken?: Uint8Array): void {
    externalAt = performance.now();
    uniforms.uTime.value = time;
    nearestCars(cars, lx, lz, MAX_CARS, uniforms.uCars.value);
    for (const c of cells) {
      const d = Math.hypot(lx - c.cx, lz - c.cz) - c.radius;
      const shown = d < drawDistance;
      const near = d < LOD_NEAR;
      c.mesh.visible = shown && near;
      c.lite.visible = shown && !near;
    }
    if (!broken) return;
    for (const a of anchored) {
      const b = a.prop < broken.length ? broken[a.prop] : 0;
      if (b === a.seen) continue;
      a.seen = b;
      const arr = a.cell.mesh.instanceMatrix.array as Float32Array;
      const o = a.index * 16;
      if (b) {
        // Scale to zero, keeping the translation so the cell's bounds stay put.
        for (let k = 0; k < 16; k++) if (k !== 12 && k !== 13 && k !== 14 && k !== 15) arr[o + k] = 0;
      } else arr.set(a.matrix, o);
      a.cell.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    group,
    count: people.length,
    update,
    dispose() {
      for (const c of cells) {
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
