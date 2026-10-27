/**
 * The city's pedestrians, drawn: people walking the sidewalks, back and forth
 * along the stretches walkPaths.ts plans. They are the game's people
 * (person.ts) at the crowd and far levels of detail, grouped into 100 m cells
 * like the idlers, each cell one InstancedMesh per level of detail sharing
 * its instance attributes, so the whole street is a handful of draw calls and
 * a cell off screen or too far costs nothing.
 *
 * The walk costs the CPU nothing. Where a walker is, which way it faces and
 * how its legs swing are a pure function of the scene clock, worked out in
 * the vertex shader: each instance carries its path as attributes (the first
 * point is the instance matrix's translation, four more are vec4s of x, y, z
 * relative to it and the length walked so far, padded by repeating the last)
 * plus its speed, phase and style. The cycle is one leg of the path, a pause
 * at the end to turn round and look about, the leg back and a pause; the
 * clock plus the phase picks the moment, the leg's time the arc position, the
 * polyline gives the point and a tangent smoothed across each corner. The gait
 * follows the distance walked (a stride is about 1.35 m), so feet do not skate
 * and a faster walker steps faster. Position is f(time): nothing is written
 * per frame but the clock and the two nearest cars, and a menu city and a race
 * agree wherever the clock does.
 *
 * Reactions are the idlers' (a head turn toward a car within ~14 m, a flinch
 * from a fast one within ~6 m), plus a step aside: a walker a car comes within
 * ~4 m of is pushed off its line, away from the car, easing back as the car
 * goes (no state, no sim contact: people are render only). Walkers keep to
 * the right of their way so two passing do not overlap.
 *
 * Cost: crowd detail is 816 triangles and far 204 per walker; a cell shows one
 * level (the crowd's within `near` m of its edge). Per vertex the shader adds
 * a four step polyline lookup and the gait on top of the rig; per frame the
 * CPU does the cell visibility test only. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Quality } from '../../ui/settings';
import { Rng } from '../../sim/prng';
import { WEAR, personGeometry, personMaterial, writeLook } from './person';
import { idleLook } from './looks';
import { nearestCars } from './placer';
import { WALK, WALKERS, planWalkers } from './walkPaths';
import type { Walker } from './walkPaths';
import type { IdleAvoid } from './idleSpots';
import type { IdlerCar } from './idlers';

export interface Walkers {
  group: THREE.Group;
  /** Number of walkers (all cells, shown or not). */
  readonly count: number;
  /** Per frame: the scene clock (s), the cars (interpolated), and the listener (camera). */
  update(time: number, cars: readonly IdlerCar[], listenerX: number, listenerZ: number): void;
  dispose(): void;
}

export interface WalkerOptions {
  quality: Quality;
  /** The seed's wardrobe mood from the idle planner (-1 cool .. 1 warm). */
  warmth: number;
  avoid?: IdleAvoid;
}

/** Cars the shader reacts to. */
const MAX_CARS = 2;

/** The people's shader inputs and the walk, as GLSL for person.ts' variant hooks. */
const WALK_PARS = /* glsl */ `
uniform float uTime;
uniform vec4 uCars[${MAX_CARS}];
// phase (0..1 of the cycle), style (0..1), speed (m/s), segments in the path (1..4)
attribute vec4 iData;
// The path's points after the first: x, y, z from the first, and the length walked.
attribute vec4 iP1;
attribute vec4 iP2;
attribute vec4 iP3;
attribute vec4 iP4;
mat4 walkRoot;
`;

/**
 * Sets the pose's four vec4s (person.ts, PersonShader) and walkRoot, the walker's
 * place and heading on its path at the scene clock, then the reactions.
 */
const WALK_POSE = /* glsl */ `
  float wPhase = iData.x;
  float wStyle = iData.y;
  float wSpeed = iData.z;
  int wSegs = int(iData.w + 0.5);
  vec4 wQ[5] = vec4[5](vec4(0.0), iP1, iP2, iP3, iP4);
  float wLen = wQ[4].w;
  float wLeg = wLen / wSpeed;
  float wPause = 0.8 + 2.2 * fract(wStyle * 7.31);
  float wCycle = 2.0 * (wLeg + wPause);
  float wT = mod(uTime + wPhase * wCycle, wCycle);
  // The cycle: along the path, the turn at its end, back, the turn at its start.
  float wU = 0.0;
  float wTurn = 0.0;
  float wWalked = 0.0;
  float wAmp = 0.0;
  float wFrac = 0.0;
  if (wT < wLeg) {
    wU = wT * wSpeed;
    wWalked = wU;
    wAmp = smoothstep(0.0, 0.35, wT) * smoothstep(0.0, 0.35, wLeg - wT);
  } else if (wT < wLeg + wPause) {
    wU = wLen;
    wFrac = (wT - wLeg) / wPause;
    wTurn = smoothstep(0.1, 0.55, wFrac);
  } else if (wT < 2.0 * wLeg + wPause) {
    float k = wT - wLeg - wPause;
    wU = wLen - k * wSpeed;
    wTurn = 1.0;
    wWalked = wLen + k * wSpeed;
    wAmp = smoothstep(0.0, 0.35, k) * smoothstep(0.0, 0.35, wLeg - k);
  } else {
    wU = 0.0;
    wFrac = (wT - 2.0 * wLeg - wPause) / wPause;
    wTurn = 1.0 - smoothstep(0.1, 0.55, wFrac);
  }
  // The point on the polyline and a tangent smoothed over 0.7 m either side of each corner.
  int wSi = 0;
  if (wU > wQ[1].w) wSi = 1;
  if (wU > wQ[2].w) wSi = 2;
  if (wU > wQ[3].w) wSi = 3;
  vec4 wA = wQ[wSi];
  vec4 wB = wQ[wSi + 1];
  vec3 wPos = mix(wA.xyz, wB.xyz, clamp((wU - wA.w) / max(wB.w - wA.w, 1e-4), 0.0, 1.0));
  vec2 wTg[4];
  vec2 wLast = vec2(0.0, 1.0);
  for (int k = 0; k < 4; k++) {
    vec2 d = wQ[k + 1].xz - wQ[k].xz;
    wLast = dot(d, d) > 1e-6 ? normalize(d) : wLast;
    wTg[k] = wLast;
  }
  vec2 wT0 = wTg[wSi];
  vec2 wTp = wSi > 0 ? wTg[wSi - 1] : wT0;
  vec2 wTn = wSi < wSegs - 1 ? wTg[wSi + 1] : wT0;
  float wWp = 0.5 * (1.0 - clamp((wU - wA.w) / 0.7, 0.0, 1.0));
  float wWn = 0.5 * (1.0 - clamp((wB.w - wU) / 0.7, 0.0, 1.0));
  vec2 wDir = normalize(wT0 + (wTp - wT0) * wWp + (wTn - wT0) * wWn + vec2(1e-5));
  float wYaw = atan(wDir.x, wDir.y) + 3.14159 * wTurn;
  // Keep to the right of the way being walked.
  float wLane = 0.2 + 0.12 * fract(wStyle * 5.3);
  vec2 wRight = vec2(-wDir.y, wDir.x) * mix(1.0, -1.0, wTurn);
  wPos.xz += wRight * wLane;
  float wScale = 0.94 + 0.12 * fract(wStyle * 13.7);

  // Cars: the two nearest the listener. A head turn, a flinch from a fast one, a step aside from any.
  vec2 wAt = instanceMatrix[3].xz + wPos.xz;
  float cBestD = 1e9;
  vec2 cTo = vec2(0.0, 1.0);
  float cSpeed = 0.0;
  for (int i = 0; i < ${MAX_CARS}; i++) {
    vec2 d = uCars[i].xy - wAt;
    float l = length(d);
    if (l < cBestD) { cBestD = l; cTo = d; cSpeed = uCars[i].z; }
  }
  vec2 cFwd = vec2(sin(wYaw), cos(wYaw));
  vec2 cRgt = vec2(cos(wYaw), -sin(wYaw));
  float cLook = 1.0 - smoothstep(9.0, 14.0, cBestD);
  float cCarYaw = clamp(atan(dot(cTo, cRgt), dot(cTo, cFwd)), -1.2, 1.2);
  float cFlinch = (1.0 - smoothstep(3.5, 6.0, cBestD)) * smoothstep(6.0, 14.0, cSpeed);
  float cAside = 1.0 - smoothstep(1.0, 4.0, cBestD);
  wPos.xz -= cTo / max(cBestD, 0.05) * 1.9 * cAside;
  wAmp = max(wAmp, cAside * 0.9);

  // The gait: a stride of ~1.35 m, legs and arms in opposition, a bob and a twist; blended to standing when paused.
  float wStride = 1.25 + 0.2 * fract(wStyle * 3.7);
  float th = wWalked / wStride * 6.2832;
  float sL = sin(th);
  float cL = cos(th);
  float sR = -sL;
  float cR = -cL;
  float swing = 0.42;
  float thighL = mix(0.05, swing * sL, wAmp);
  float thighR = mix(0.05, swing * sR, wAmp);
  float kneeL = mix(0.1, 0.12 + 0.75 * max(cL, 0.0) + 0.1 * max(-cL, 0.0), wAmp);
  float kneeR = mix(0.1, 0.12 + 0.75 * max(cR, 0.0) + 0.1 * max(-cR, 0.0), wAmp);
  float hipY = mix(0.965, 0.935 + 0.03 * cL * cL, wAmp);
  float cPh = wStyle * 6.2832;
  float armSwing = 0.5 * wAmp;
  int cWorn = int(lookB.w + 0.5);
  bool cPhone = (cWorn & ${WEAR.phone}) != 0;
  float aLR = 0.07 - armSwing * sL + 0.7 * cFlinch + 0.06 * sin(uTime * 1.6 + cPh);
  float aRR = 0.07 - armSwing * sR + 0.7 * cFlinch + 0.06 * sin(uTime * 1.6 + cPh + 2.0);
  float aLE = 0.2 + wAmp * (0.15 + 0.5 * max(-sL, 0.0)) + 0.3 * cFlinch;
  float aRE = 0.2 + wAmp * (0.15 + 0.5 * max(-sR, 0.0)) + 0.3 * cFlinch;
  vec3 aL = vec3(aLR, 0.1 + 0.3 * cFlinch, aLE);
  vec3 aR = vec3(aRR, 0.1 + 0.3 * cFlinch, aRE);
  if (cPhone) aR = vec3(1.45, 0.0, 1.05);
  float lean = 0.03 + 0.07 * wAmp - 0.3 * cFlinch;
  float wSide = 0.02 * cL * wAmp + 0.03 * sin(uTime * 1.1 + cPh) * (1.0 - wAmp);
  float twist = 0.14 * sL * wAmp;
  // Straight ahead while walking; a glance about while stopped; the car, when it is near.
  float headYaw = mix(0.35 * sin(uTime * 0.6 + cPh * 1.7) * (1.0 - 0.7 * wAmp), cCarYaw, cLook);
  float headPitch = cPhone ? 0.35 : 0.05 + 0.05 * sin(uTime * 0.7 + cPh);
  vec4 p0 = vec4(hipY, lean, wSide, twist);
  vec4 p1 = vec4(headYaw, headPitch, aL.x, aL.y);
  vec4 p2 = vec4(aL.z, aR.x, aR.y, aR.z);
  vec4 p3 = vec4(thighL, kneeL, thighR, kneeR);
  cloth = vec3(0.0);
  itemGlow = cPhone ? vec3(0.55, 0.7, 1.0) * 1.3 : vec3(0.0);
  float wC = cos(wYaw) * wScale;
  float wS = sin(wYaw) * wScale;
  walkRoot = mat4(wC, 0.0, -wS, 0.0, 0.0, wScale, 0.0, 0.0, wS, 0.0, wC, 0.0, wPos.x, wPos.y, wPos.z, 1.0);
`;

/** After the pose: fade the tiny phone emitters with distance so they never sparkle in the bloom. */
const WALK_POST = /* glsl */ `
  vec3 cWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vPersonGlow *= clamp(28.0 / max(distance(cWorld, cameraPosition), 1.0), 0.15, 1.0);
`;

function walkMaterial(uniforms: { uTime: { value: number }; uCars: { value: THREE.Vector4[] } }): THREE.MeshStandardMaterial {
  const mat = personMaterial({ pars: WALK_PARS, pose: WALK_POSE, post: WALK_POST, root: 'walkRoot', key: 'walk' });
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
  /** Centre of the cell's walkers' paths and the reach of them (m). */
  cx: number;
  cz: number;
  radius: number;
}

export function buildWalkers(world: World, opts: WalkerOptions): Walkers {
  const group = new THREE.Group();
  group.name = 'walkers';
  const budget = WALKERS[opts.quality];
  const walkers = planWalkers(world, { budget, avoid: opts.avoid });
  const cells: Cell[] = [];
  const noop: Walkers = { group, count: 0, update() {}, dispose() {} };
  if (!walkers.length) return noop;

  const geo = personGeometry('crowd');
  const liteGeo = personGeometry('far');
  const uniforms = { uTime: { value: 0 }, uCars: { value: Array.from({ length: MAX_CARS }, () => new THREE.Vector4(1e6, 1e6, 0, 0)) } };
  const mat = walkMaterial(uniforms);
  const dummy = new THREE.Object3D();

  const byCell = new Map<number, Walker[]>();
  for (const w of walkers) {
    let list = byCell.get(w.cell);
    if (!list) byCell.set(w.cell, (list = []));
    list.push(w);
  }

  const share = (src: THREE.BufferGeometry, attrs: Record<string, THREE.BufferAttribute>): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(src.attributes)) g.setAttribute(name, src.attributes[name]);
    g.setIndex(src.index);
    g.boundingSphere = src.boundingSphere!.clone();
    for (const name of Object.keys(attrs)) g.setAttribute(name, attrs[name]);
    return g;
  };

  for (const key of [...byCell.keys()].sort((a, b) => a - b)) {
    const list = byCell.get(key)!;
    const n = list.length;
    const lookA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const lookB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const data = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const pts = [1, 2, 3, 4].map(() => new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
    const attrs: Record<string, THREE.BufferAttribute> = { lookA, lookB, iData: data, iP1: pts[0], iP2: pts[1], iP3: pts[2], iP4: pts[3] };
    const mesh = new THREE.InstancedMesh(share(geo, attrs), mat, n);
    mesh.name = 'walkers';
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    list.forEach((w, i) => {
      const rng = new Rng(w.lookSeed);
      const look = idleLook(() => rng.next(), opts.warmth);
      // One in six on a phone.
      if (rng.chance(0.17)) look.wear |= WEAR.phone;
      writeLook(lookA, lookB, i, look);
      const count = w.pts.length / 4;
      const ox = w.pts[0];
      const oy = w.pts[1];
      const oz = w.pts[2];
      // The instance origin is the path's first point; the shader moves the person along the rest.
      dummy.position.set(ox, oy, oz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      data.setXYZW(i, w.phase, w.style, w.speed, count - 1);
      // Points 1..4 relative to the first, padded by repeating the last so the shader's four steps always have somewhere to go.
      for (let k = 1; k <= WALK.maxPts - 1; k++) {
        const s = Math.min(k, count - 1) * 4;
        pts[k - 1].setXYZW(i, w.pts[s] - ox, w.pts[s + 1] - oy, w.pts[s + 2] - oz, w.pts[s + 3]);
      }
      for (let s = 0; s < w.pts.length; s += 4) {
        minX = Math.min(minX, w.pts[s]);
        maxX = Math.max(maxX, w.pts[s]);
        minZ = Math.min(minZ, w.pts[s + 2]);
        maxZ = Math.max(maxZ, w.pts[s + 2]);
      }
    });
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Paths, the lane and the step aside, plus the figure's own reach.
    const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 4;
    mesh.instanceMatrix.needsUpdate = true;
    // The matrices only carry each path's start: the cell's bounds are set by hand.
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 1, cz), radius);
    group.add(mesh);
    const lite = new THREE.InstancedMesh(share(liteGeo, attrs), mat, n);
    lite.name = 'walkersFar';
    lite.instanceMatrix = mesh.instanceMatrix;
    lite.boundingSphere = mesh.boundingSphere.clone();
    lite.visible = false;
    group.add(lite);
    cells.push({ mesh, lite, cx, cz, radius });
  }

  // The menu backdrop never calls update(): keep the walk going from the render clock.
  let externalAt = -1;
  const clock = () => {
    if (externalAt < 0 || performance.now() - externalAt > 500) uniforms.uTime.value = performance.now() / 1000;
  };
  for (const c of cells) c.mesh.onBeforeRender = c.lite.onBeforeRender = clock;

  function update(time: number, cars: readonly IdlerCar[], lx: number, lz: number): void {
    externalAt = performance.now();
    uniforms.uTime.value = time;
    nearestCars(cars, lx, lz, MAX_CARS, uniforms.uCars.value);
    for (const c of cells) {
      const d = Math.hypot(lx - c.cx, lz - c.cz) - c.radius;
      const shown = d < budget.draw;
      const near = d < budget.near;
      c.mesh.visible = shown && near;
      c.lite.visible = shown && !near;
    }
  }

  return {
    group,
    count: walkers.length,
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
