/**
 * The city's idle people, drawn: the shared plan's (city/people/people.ts, kind 'idle') people waiting
 * at bus stops, sitting on benches and at cafe tables, leaning by park lamps
 * and chatting in front of shops. They never walk. They are the game's
 * people (people/person.ts) at the crowd and far levels of detail, grouped
 * into 200 m cells, each cell one InstancedMesh per level sharing its
 * instance attributes (the crowds' pattern), so the whole street costs a
 * handful of draw calls and a cell off screen or too far costs nothing.
 *
 * Every tier draws every idler the plan has: the sim collides with them (a car can hit a bench's sitters), so
 * a tier that planned or drew fewer would show a race that is not the one being played. Quality only sets how
 * far they are drawn (`IDLE_QUALITY.draw`).
 *
 * The pose is all in the vertex shader from the person's phase, style and pose kind
 * (stand, sit, lean, phone): sway, weight shifting, a glance around, a phone
 * held up, a seated pose with the thighs forward and the shin vertical, and a
 * variety by style band (arms crossed, hands in pockets, a watch checked, a
 * stretch, crossed legs or elbows on the knees, a foot up on the wall) with talking pairs
 * taking turns (gestures.ts). The
 * four cars nearest the cell are passed in (motion.ts): a person turns their head
 * to the nearest within ~14 m and flinches back from a fast one within ~6 m (pose flavour), and
 * steps out of the way of any car by the same stateless dodge the sim moves them by (motion.ts, `sidestep`);
 * a car that hits one sends them into the ragdoll (`iHit`, written by `PeopleHits` when the sim says so). A prop
 * knocked over takes its sitters with it in the sim, so they ragdoll like anyone else. Vertex attributes: 11 of
 * WebGL's 16 (position, normal, rig, lookA, lookB, the instance matrix's four, iData, iHit); iData.w packs the
 * dodge's `prefer` as its sign and `1 + backRoom` as its size, the wall behind being -facing. Render only.
 */
import * as THREE from 'three';
import type { PeoplePlan } from '../../city/people/people';
import type { IdlePose } from '../../city/people/idleSpots';
import type { Quality } from '../../ui/settings';
import type { PeopleState } from '../../sim/people';
import { Rng } from '../../sim/prng';
import { WEAR, personGeometry, personMaterial, writeLook } from './person';
import { idleLook } from './looks';
import { GESTURES_GLSL, talkCodes } from './gestures';
import { FLING_MARGIN, PEOPLE_MAX_CARS, PEOPLE_MOTION_PARS, PeopleHits, carsNear, growBounds, hitSeed, makeCarsUniform, makeHitAttribute } from './motion';
import type { PeopleCar } from './motion';

/** How far (m) idle people are drawn per graphics quality; the people themselves do not depend on it (see the header). */
export const IDLE_QUALITY: Record<Quality, { draw: number }> = {
  low: { draw: 200 },
  medium: { draw: 280 },
  high: { draw: 360 },
};

/** A car as the idlers see it: the interpolated pose. */
export type IdlerCar = PeopleCar;

export interface Idlers {
  group: THREE.Group;
  /** Number of idle people. */
  readonly count: number;
  /** Per frame: the people clock (s; the race's interpolated sim time, the menu stage's own), the cars (interpolated), the listener (camera) and, in a race, who the sim has hit. */
  update(time: number, cars: readonly IdlerCar[], listenerX: number, listenerZ: number, people?: PeopleState): void;
  dispose(): void;
}

export interface IdlerOptions {
  quality: Quality;
}

/** Cell size (m) and the distance inside which a cell draws the full figure (m, from its edge). */
const CELL = 200;
const LOD_NEAR = 50;
/** Friends share a phase to within this much of a cycle. */
const GROUP_JITTER = 0.05;

/** iData.z's low two bits: the pose kind (the talking code is above them, gestures.ts). */
const KIND: Record<IdlePose, number> = { stand: 0, sit: 1, lean: 2, phone: 3 };

const IDLE_PARS = /* glsl */ `
uniform float uTime;
attribute vec4 iData;
${GESTURES_GLSL}`;

/**
 * Sets the pose's four vec4s (person.ts, PersonShader): the crowd's idle motion, a seated and a leaning pose, a glance, a reaction to cars, then the dodge and the ragdoll (motion.ts) into `pRoot`.
 *
 * Variety, all read off the instance: the style `iData.y` is cut into a band (plain, arms crossed, hands in
 * pockets, hands on hips, weight on one leg with a hip pop, checking a watch now and then; a plain stander
 * stretches once in a long while; a sitter crosses their legs or rests their elbows on their knees; a leaner
 * puts one foot up on the wall behind), a cup holder sips every ~9 s, headphones bob to a 128 bpm beat, and the
 * pairs the plan puts together (they share `iData.x`, the group phase plus a small jitter) take turns gesturing
 * and turn their heads to each other: `iData.z` is the pose kind in its low two bits and the talking code above.
 */
const IDLE_POSE = /* glsl */ `
  float cT = uTime;
  float cPh = iData.x * 6.2832;
  float cStyle = iData.y;
  int cZ = int(iData.z + 0.5);
  int cKind = cZ & 3;
  int cRole = (cZ >> 2) & 3;
  float cSide = ((cZ >> 4) & 1) != 0 ? 1.0 : -1.0;
  bool cSit = cKind == 1;
  bool cLean = cKind == 2;
  int cWorn = int(lookB.w + 0.5);
  bool cPhone = (cWorn & ${WEAR.phone}) != 0;
  bool cCup = (cWorn & ${WEAR.cup}) != 0;
  bool cHeadphones = (cWorn & ${WEAR.headphones}) == ${WEAR.headphones};
  // The nearest car: a head turn within ~14 m, a flinch within ~6 m when it is fast (in the person's frame).
  vec2 cAt = instanceMatrix[3].xz;
  vec2 cFwd = normalize(instanceMatrix[2].xz + vec2(1e-5));
  vec2 cRgt = normalize(instanceMatrix[0].xz + vec2(1e-5));
  float cBestD = 1e9;
  vec2 cTo = vec2(0.0, 1.0);
  float cSpeed = 0.0;
  for (int i = 0; i < ${PEOPLE_MAX_CARS}; i++) {
    vec2 d = uCars[i].xy - cAt;
    float l = length(d);
    if (l < cBestD) { cBestD = l; cTo = d; cSpeed = uCars[i].w; }
  }
  float cLook = 1.0 - smoothstep(9.0, 14.0, cBestD);
  float cCarYaw = clamp(atan(dot(cTo, cRgt), dot(cTo, cFwd)), -1.2, 1.2);
  float cFlinch = cSit ? 0.0 : (1.0 - smoothstep(3.5, 6.0, cBestD)) * smoothstep(6.0, 14.0, cSpeed);
  // The style bands: plain below 0.28 (and from 0.88, with the stretch), crossed arms, pockets, one leg, a watch.
  float cBand = fract(cStyle * 5.37 + 0.11);
  float up = cSit ? 0.0 : 1.0;
  float bX = (step(0.28, cBand) - step(0.44, cBand)) * up;
  float bP = (step(0.44, cBand) - step(0.6, cBand)) * up;
  float bL = (step(0.6, cBand) - step(0.74, cBand)) * up * (cLean ? 0.0 : 1.0);
  float bW = (step(0.74, cBand) - step(0.88, cBand)) * up;
  float bPlain = (1.0 - step(0.28, cBand) + step(0.88, cBand)) * up;
  float elbows = cSit ? step(0.5, cBand) : 0.0;
  float legS = fract(cStyle * 9.1) > 0.5 ? 1.0 : -1.0;
  float beat = cT * 13.404 + cPh;
  float pop = pow(max(0.0, sin(cT * 1.05 + cPh)), 8.0);
  float watch = bW * gPulse(cT, 14.0, cPh, 3.0, 0.5);
  float stretch = bPlain * gPulse(cT, 41.0, cPh, 1.5, 0.45);
  float talk = cRole > 0 ? 1.0 : 0.0;
  float spk = gSpeak(cT, cPh, cRole);
  float sip = cCup && !cPhone ? gPulse(cT, 9.0, cPh + 2.0, 2.6, 0.9) : 0.0;
  float sway = 0.03 * sin(cT * 1.1 + cPh) + 0.06 * legS * bL * (1.0 + pop);
  float shift = sin(cT * 0.9 + cPh);
  float hipY = (cSit ? 0.57 : 0.965) - (cHeadphones && !cSit ? 0.015 * (0.5 + 0.5 * cos(beat)) : 0.0);
  float kneeL = mix(0.1 + 0.06 * shift, legS > 0.0 ? 0.42 : 0.04, bL) + 0.25 * cFlinch;
  float kneeR = mix(0.1 - 0.06 * shift, legS > 0.0 ? 0.04 : 0.42, bL) + 0.25 * cFlinch;
  vec3 aL = vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh + 1.0) + 0.7 * cFlinch, 0.1 + 0.3 * cFlinch, 0.25);
  vec3 aR = vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh - 1.0) + 0.7 * cFlinch, 0.1 + 0.3 * cFlinch, 0.25);
  aL = mix(aL, G_CROSS_L, bX);
  aR = mix(aR, G_CROSS_R, bX);
  aL = mix(aL, G_POCKET, bP);
  aR = mix(aR, G_POCKET, bP);
  aL = mix(aL, G_WATCH, watch);
  aL = mix(aL, G_STRETCH, stretch);
  aR = mix(aR, G_STRETCH, stretch);
  // Hands in the lap when seated, or the elbows on the knees.
  if (cSit) {
    aL = mix(vec3(0.6, 0.12, 0.95), vec3(0.3, 0.12, 1.1), elbows);
    aR = aL;
  }
  // A voice in a talking pair gestures with one hand while it has the floor.
  aL = mix(aL, vec3(0.95 + 0.35 * sin(cT * 3.3 + cPh * 2.0), 0.3, 1.35 + 0.3 * sin(cT * 5.1 + cPh)), talk * spk);
  // A phone held up toward the road; a cup to the lips.
  if (cPhone) aR = cSit ? vec3(1.2, 0.0, 1.3) : vec3(1.45, 0.0, 1.05);
  aR = mix(aR, G_SIP, sip);
  float lean = cLean ? -0.14 : 0.04;
  lean += cSit ? 0.04 + 0.42 * elbows : 0.0;
  lean -= 0.3 * cFlinch + 0.12 * stretch;
  // A look around, or toward the person they talk to, or down at the phone or the watch, a nod to the beat, then at the car going by.
  float headYaw = mix(0.3 * sin(cT * 0.5 + cPh * 1.7), cSide * (0.35 + 0.3 * spk), talk);
  headYaw = mix(headYaw, cCarYaw, cLook);
  float headPitch = (cPhone ? 0.35 : 0.05 + 0.05 * sin(cT * 0.7 + cPh)) + 0.4 * watch - 0.25 * stretch - 0.2 * sip + (cHeadphones ? 0.08 * sin(beat) : 0.0);
  vec4 p0 = vec4(hipY, lean, sway, 0.1 * cSide * talk);
  vec4 p1 = vec4(headYaw, headPitch, aL.x, aL.y);
  vec4 p2 = vec4(aL.z, aR.x, aR.y, aR.z);
  vec4 legs = vec4(kneeL * 0.5, kneeL, kneeR * 0.5, kneeR);
  // A leaner with a foot up on the wall behind (the leg back, the knee bent) on one side by style.
  if (cLean && cBand > 0.5) legs = legS > 0.0 ? vec4(-0.1, 1.15, legs.zw) : vec4(legs.xy, -0.1, 1.15);
  // Seated: thighs forward, shins down; the right foot out over the left knee for crossed legs.
  vec4 p3 = cSit ? mix(vec4(1.45, 1.5, 1.52, 0.85), vec4(1.45, 1.5, 1.45, 1.5), elbows) : legs;
  cloth = vec3(0.0);
  itemGlow = cPhone ? vec3(0.55, 0.7, 1.0) * 1.3 : vec3(0.0);
  // Hit: the ragdoll from where the sim hit them. Standing: the dodge the sim moves them by (the wall behind is -facing, iData.w carries prefer and the room).
  mat4 pRoot = mat4(1.0);
  if (iHit.x >= 0.0 && cT >= iHit.x) {
    vec2 mDisp;
    mat4 mBody = pmRagdoll(cT - iHit.x, iHit.yz, iHit.w, p0.x, mDisp, p0, p1, p2, p3);
    pRoot = rigT(pmLocal(instanceMatrix, vec3(mDisp.x, 0.0, mDisp.y))) * mBody;
  } else {
    vec2 mOff = pmSidestep(cAt, -cFwd, abs(iData.w) - 1.0, iData.w < 0.0 ? -1.0 : 1.0);
    if (dot(mOff, mOff) > 0.0025) {
      pRoot = rigT(pmLocal(instanceMatrix, vec3(mOff.x, 0.0, mOff.y)));
      if (!cSit) pmStepPose(vec2(dot(mOff, cRgt), dot(mOff, cFwd)), cCarYaw, p0, p1, p2, p3);
    }
  }
`;

/** After the pose: fade the tiny phone emitters with distance so they never sparkle in the bloom. */
const IDLE_POST = /* glsl */ `
  vec3 cWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vPersonGlow *= clamp(28.0 / max(distance(cWorld, cameraPosition), 1.0), 0.15, 1.0);
`;

/** One cell's material: the shared clock and the cell's own nearest cars (motion.ts says why per cell). */
function idleMaterial(uTime: { value: number }, uCars: { value: THREE.Vector4[] }): THREE.MeshStandardMaterial {
  // Its own program key: 'crowd' would hand this material the crowd's compiled program.
  const mat = personMaterial({ pars: IDLE_PARS + PEOPLE_MOTION_PARS(), pose: IDLE_POSE, post: IDLE_POST, root: 'pRoot', key: 'idle' });
  const compile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uCars = uCars;
    compile(shader, renderer);
  };
  return mat;
}

interface Cell {
  mesh: THREE.InstancedMesh;
  lite: THREE.InstancedMesh;
  mat: THREE.MeshStandardMaterial;
  cars: { value: THREE.Vector4[] };
  cx: number;
  cz: number;
  radius: number;
  /** Whether the bounds are grown for flung people. */
  grown: boolean;
}

export function buildIdlers(plan: PeoplePlan, opts: IdlerOptions): Idlers {
  const group = new THREE.Group();
  group.name = 'idlers';
  const people = plan.people.filter((p) => p.kind === 'idle');
  const geo = personGeometry('crowd');
  const liteGeo = personGeometry('far');
  const clock = { uTime: { value: 0 } };
  const drawDistance = IDLE_QUALITY[opts.quality].draw;
  const dummy = new THREE.Object3D();
  const cells: Cell[] = [];
  const hits = new PeopleHits();

  // The talking pairs: the plan's groups (a prop's people, a frontage pair, a plaza circle) share their group phase.
  const talk = new Map<number, number>();
  talkCodes(people.map((p) => ({ key: p.groupPhase, x: p.x, z: p.z, yaw: p.yaw }))).forEach((code, i) => talk.set(people[i].id, code));

  // Group by cell, in planner order inside each.
  const byCell = new Map<number, typeof people>();
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
    const iHit = makeHitAttribute(list.map((p) => hitSeed(p.lookSeed)));
    const attrs = { lookA, lookB, iData, iHit };
    const cars = makeCarsUniform();
    const mat = idleMaterial(clock.uTime, cars);
    const mesh = new THREE.InstancedMesh(share(geo, attrs), mat, n);
    mesh.name = 'idlers';
    let cx = 0;
    let cz = 0;
    list.forEach((p, i) => {
      const rng = new Rng(p.lookSeed);
      // The plan's scale is the first draw of this stream: skip it so the look stays what it was.
      rng.next();
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.set(p.scale, p.scale, p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const look = idleLook(() => rng.next(), plan.warmth);
      // The standing phone pose holds one; about one in ten of the rest do too.
      if (p.idle!.pose === 'phone' || rng.next() < 0.1) look.wear |= WEAR.phone;
      writeLook(lookA, lookB, i, look);
      // The phase is the group's plus a small jitter, so a pair or a bench's sitters move together.
      data.set([(p.groupPhase + GROUP_JITTER * rng.next()) % 1, rng.next(), KIND[p.idle!.pose] + 4 * talk.get(p.id)!, p.prefer * (1 + p.backRoom)], i * 4);
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
    const cell: Cell = { mesh, lite, mat, cars, cx, cz, radius, grown: false };
    cells.push(cell);
    list.forEach((p, i) =>
      hits.bind(
        p.id,
        iHit,
        i,
        (any) => {
          if (any === cell.grown) return;
          cell.grown = any;
          growBounds([mesh, lite], any ? FLING_MARGIN : -FLING_MARGIN);
        },
        { matrix: mesh.instanceMatrix },
      ),
    );
  }

  // The menu backdrop never calls update(): keep the idle animation going from the render clock.
  let externalAt = -1;
  const tick = () => {
    if (externalAt < 0 || performance.now() - externalAt > 500) clock.uTime.value = performance.now() / 1000;
  };
  for (const c of cells) c.mesh.onBeforeRender = c.lite.onBeforeRender = tick;

  function update(time: number, cars: readonly IdlerCar[], lx: number, lz: number, state?: PeopleState): void {
    externalAt = performance.now();
    clock.uTime.value = time;
    hits.update(state);
    for (const c of cells) {
      const d = Math.hypot(lx - c.cx, lz - c.cz) - c.radius;
      const shown = d < drawDistance;
      const near = d < LOD_NEAR;
      c.mesh.visible = shown && near;
      c.lite.visible = shown && !near;
      if (shown) carsNear(cars, lx, lz, c.cx, c.cz, c.radius, c.cars.value);
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
        c.mat.dispose();
      }
      geo.dispose();
      liteGeo.dispose();
    },
  };
}
