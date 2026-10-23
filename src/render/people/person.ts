/**
 * The game's people, one character for everyone (docs/people.md): stylized
 * and faceless, rounded low poly shapes in flat colored clothes, a cap, a
 * beanie, hair or a hood, a hi-vis stripe and gloves as options per person.
 * One merged mesh with a fixed 15 bone skeleton at three levels of detail
 * (hero beside the cars, mid for a crowd, far for the far rows); every vertex
 * carries its bone, its part (which of the person's colors it wears) and the
 * option it belongs to.
 *
 * People draws any number of them as one InstancedMesh: the vertex shader
 * poses each from 16 joint angles per instance (PersonPose, packed in four
 * vec4s) and colors it from six per instance colors (24 bit integers, four
 * and two to an attribute with the options' bits, which keeps the whole
 * character inside WebGL's 16 vertex attributes), so a crowd costs one draw
 * call and the CPU only writes what changed. personFrame() is the same
 * skeleton on the CPU, for things held in a hand; the two must stay in step.
 * Render only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from '../../sim/math';
import type { Disposable } from '../disposer';

/** Body measurements (m): standing hip joint height, the leg and arm bones, spine to shoulders and to the neck's top, joint spacing. */
export const BODY = { hip: 0.98, thigh: 0.45, shin: 0.45, ankle: 0.08, spine: 0.5, neck: 0.56, shoulder: 0.2, hipW: 0.1, upper: 0.3, fore: 0.27 } as const;

/** One arm (rad): raised forward from hanging, swung out to the side, the elbow's bend. */
export interface PersonArm {
  raise: number;
  out: number;
  elbow: number;
}

/** A person's 16 joint values: the hips' height (m), the spine, the head, both arms, both legs (thigh swing forward and knee bend, rad). */
export interface PersonPose {
  hipY: number;
  /** Forward lean, sideways tilt and twist of the spine. */
  lean: number;
  side: number;
  twist: number;
  /** Head turn and pitch (+ looks down). */
  headYaw: number;
  headPitch: number;
  /** Left (+x) and right arm. */
  arms: [PersonArm, PersonArm];
  /** Left and right leg: [thigh swing forward, knee bend]. */
  legs: [[number, number], [number, number]];
}

/** The options a person wears, as bits of PersonLook.wear. */
export const WEAR = { cap: 1, beanie: 2, hair: 4, stripe: 8, gloves: 16, hood: 32 } as const;

/** How much of the character to build: hero beside the cars (about 3k triangles), mid for a crowd (about 900), far for the back rows (about 60). */
export type PersonDetail = 'hero' | 'mid' | 'far';

/** A person's colors (hex) and options (WEAR bits). `cap` colors the cap or beanie. */
export interface PersonLook {
  skin: number;
  shirt: number;
  pants: number;
  shoes: number;
  hair: number;
  cap: number;
  wear: number;
}

/** The bones, in the order the shader's chain reads them. */
const BONE = { hips: 0, spine: 1, head: 2, upperL: 3, foreL: 4, handL: 5, upperR: 6, foreR: 7, handR: 8, thighL: 9, shinL: 10, footL: 11, thighR: 12, shinR: 13, footR: 14 } as const;
/** The parts, by which per instance color they wear (6 = the stripe's fixed reflective white, 7 = hands: skin or gloves, 8 = the fixed dark of soles and belt). */
const PART = { skin: 0, shirt: 1, pants: 2, shoes: 3, hair: 4, cap: 5, stripe: 6, hand: 7, trim: 8 } as const;

/** A standing pose: arms easy at the sides, feet under the hips. */
export function standingPose(): PersonPose {
  const p: PersonPose = {
    hipY: BODY.hip - 0.01,
    lean: 0,
    side: 0,
    twist: 0,
    headYaw: 0,
    headPitch: 0.05,
    arms: [
      { raise: 0.05, out: 0.1, elbow: 0.2 },
      { raise: 0.05, out: 0.1, elbow: 0.2 },
    ],
    legs: [
      [0, 0],
      [0, 0],
    ],
  };
  return plantFeet(p, 0.03, -0.03);
}

/** Solve both legs so the feet stand on the floor `left` and `right` m forward of their hips (a two bone leg, knees forward). */
export function plantFeet(p: PersonPose, left: number, right: number): PersonPose {
  const L1 = BODY.thigh;
  const L2 = BODY.shin;
  [left, right].forEach((f, k) => {
    const dy = p.hipY - BODY.ankle;
    const d = Math.min(Math.hypot(dy, f), L1 + L2 - 1e-3);
    const knee = Math.PI - Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
    const thigh = Math.atan2(f, dy) + Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
    p.legs[k] = [thigh, knee];
  });
  return p;
}

// ---------------------------------------------------------------------------
// The mesh
// ---------------------------------------------------------------------------

/** One piece of the body: a geometry in its bone's frame, tagged with bone, part and option (0 = always worn). */
function piece(geo: THREE.BufferGeometry, bone: number, part: number, wear = 0): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  const tag = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) tag.set([bone, part, wear], i * 3);
  geo.setAttribute('rig', new THREE.Float32BufferAttribute(tag, 3));
  geo.deleteAttribute('uv');
  return geo;
}

/** A limb bone's shape: rounded at both joints, tapering from rTop at the joint to rBot, with a bulge of rMid part way down when given (a calf, a bicep). */
function limb(rTop: number, rBot: number, len: number, seg: number, rMid = 0, at = 0.4): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, rTop)];
  for (const a of [60, 30, 0]) pts.push(new THREE.Vector2(rTop * Math.cos((a * Math.PI) / 180), rTop * Math.sin((a * Math.PI) / 180)));
  if (rMid) pts.push(new THREE.Vector2(rMid, -len * at));
  pts.push(new THREE.Vector2(rBot, -len));
  for (const a of [30, 60]) pts.push(new THREE.Vector2(rBot * Math.cos((a * Math.PI) / 180), -len - rBot * Math.sin((a * Math.PI) / 180)));
  pts.push(new THREE.Vector2(0.001, -len - rBot));
  return new THREE.LatheGeometry(pts, seg);
}

/** A lathe from [radius, y] pairs, top to bottom, scaled across (z) to flatten it. */
function lathe(profile: [number, number][], seg: number, sz = 1): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  ).scale(1, 1, sz);
}

/**
 * The character: a belted pelvis, a torso that widens from the waist to the
 * shoulders under a collar, an egg of a head with no features and hair swept
 * back, a cap with its brim, a beanie with its cuff or a hood as options,
 * tapered limbs with a calf and a bicep in them, mitten hands, shoes on dark
 * soles, the hi-vis band round the chest. Every piece sits in its bone's frame.
 * The mid level keeps the shapes at half the segments without the trim; the
 * far level is nine boxes.
 */
export function personGeometry(detail: PersonDetail = 'hero'): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, bone: number, part: number, wear = 0) => pieces.push(piece(g, bone, part, wear));
  const arms = [
    [BONE.upperL, BONE.foreL, BONE.handL],
    [BONE.upperR, BONE.foreR, BONE.handR],
  ] as const;
  const legs = [
    [BONE.thighL, BONE.shinL, BONE.footL],
    [BONE.thighR, BONE.shinR, BONE.footR],
  ] as const;
  if (detail === 'far') {
    const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    add(box(0.3, 0.14, 0.2, 0, -0.02, 0), BONE.hips, PART.pants);
    add(box(0.34, 0.52, 0.22, 0, 0.3, 0), BONE.spine, PART.shirt);
    add(box(0.18, 0.22, 0.19, 0, 0.12, 0), BONE.head, PART.skin);
    add(box(0.19, 0.1, 0.2, 0, 0.19, -0.01), BONE.head, PART.hair, WEAR.hair);
    add(box(0.19, 0.08, 0.2, 0, 0.2, 0), BONE.head, PART.cap, WEAR.cap | WEAR.beanie);
    for (const [upper, fore] of arms) {
      add(box(0.09, 0.3, 0.09, 0, -0.15, 0), upper, PART.shirt);
      add(box(0.08, 0.34, 0.08, 0, -0.17, 0), fore, PART.shirt);
    }
    for (const [thigh, shin, foot] of legs) {
      add(box(0.14, 0.45, 0.14, 0, -0.22, 0), thigh, PART.pants);
      add(box(0.11, 0.45, 0.11, 0, -0.22, 0), shin, PART.pants);
      add(box(0.11, 0.08, 0.26, 0, -0.04, 0.06), foot, PART.shoes);
    }
  } else {
    const hero = detail === 'hero';
    const seg = hero ? 16 : 8;
    const lseg = hero ? 12 : 6;
    const sph = (r: number, w = seg, h = Math.round(seg * 0.6)) => new THREE.SphereGeometry(r, w, h);
    add(sph(0.15).scale(1.14, 0.7, 0.82).translate(0, -0.03, 0), BONE.hips, PART.pants);
    if (hero) add(new THREE.CylinderGeometry(0.172, 0.172, 0.035, seg).scale(1, 1, 0.74).translate(0, 0.035, 0), BONE.hips, PART.trim);
    add(
      lathe(
        [
          [0.001, -0.02],
          [0.13, 0.0],
          [0.152, 0.1],
          [0.158, 0.22],
          [0.178, 0.36],
          [0.188, 0.44],
          [0.165, 0.51],
          [0.07, 0.555],
          [0.001, 0.56],
        ],
        seg,
        0.68,
      ),
      BONE.spine,
      PART.shirt,
    );
    if (hero) add(new THREE.CylinderGeometry(0.075, 0.068, 0.035, lseg).translate(0, 0.555, 0), BONE.spine, PART.shirt);
    add(new THREE.CylinderGeometry(0.192, 0.192, 0.045, seg).scale(1, 1, 0.69).translate(0, 0.37, 0), BONE.spine, PART.stripe, WEAR.stripe);
    add(new THREE.CylinderGeometry(0.044, 0.05, 0.1, lseg).translate(0, BODY.neck - 0.03, 0), BONE.spine, PART.skin);
    // The head: an egg, a little narrower at the chin, that sits on the neck.
    add(
      lathe(
        [
          [0.001, 0.235],
          [0.06, 0.225],
          [0.095, 0.19],
          [0.105, 0.14],
          [0.1, 0.09],
          [0.082, 0.04],
          [0.05, 0.008],
          [0.001, 0.0],
        ],
        seg,
        1.02,
      ),
      BONE.head,
      PART.skin,
    );
    add(sph(0.112, seg, Math.round(seg * 0.5)).scale(1, 1, 1.02).rotateX(-0.3).translate(0, 0.13, -0.01), BONE.head, PART.hair, WEAR.hair);
    add(new THREE.SphereGeometry(0.115, seg, Math.round(seg * 0.4), 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.15, 0), BONE.head, PART.cap, WEAR.cap);
    add(new THREE.BoxGeometry(0.17, 0.012, 0.11).translate(0, 0.152, 0.1), BONE.head, PART.cap, WEAR.cap);
    add(new THREE.SphereGeometry(0.119, seg, Math.round(seg * 0.4), 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.15, 1).translate(0, 0.13, 0), BONE.head, PART.cap, WEAR.beanie);
    add(new THREE.CylinderGeometry(0.121, 0.121, 0.045, seg).translate(0, 0.14, 0), BONE.head, PART.cap, WEAR.beanie);
    // The hood: a shell round the back and top of the head, open at the face, in the shirt's color.
    add(new THREE.SphereGeometry(0.14, seg, Math.round(seg * 0.6), Math.PI * 0.85, Math.PI * 1.3).scale(1, 1.08, 1).translate(0, 0.115, -0.02), BONE.head, PART.shirt, WEAR.hood);
    for (const [upper, fore, hand] of arms) {
      add(limb(0.058, 0.046, BODY.upper, lseg, 0.054, 0.35), upper, PART.shirt);
      add(limb(0.046, 0.034, BODY.fore, lseg), fore, PART.shirt);
      add(sph(0.046, lseg, Math.round(lseg * 0.7)).scale(0.76, 1.35, 0.5).translate(0, -0.055, 0.004), hand, PART.hand);
    }
    for (const [thigh, shin, foot] of legs) {
      add(limb(0.082, 0.062, BODY.thigh, lseg).scale(1, 1, 0.95), thigh, PART.pants);
      add(limb(0.062, 0.044, BODY.shin, lseg, 0.066, 0.3), shin, PART.pants);
      add(sph(0.07, lseg, Math.round(lseg * 0.6)).scale(0.82, 0.55, 1.75).translate(0, -0.038, 0.06), foot, PART.shoes);
      add(new THREE.CylinderGeometry(0.072, 0.072, 0.02, lseg).scale(0.86, 1, 1.85).translate(0, -0.07, 0.06), foot, hero ? PART.trim : PART.shoes);
    }
  }
  const geo = mergeGeometries(pieces)!;
  pieces.forEach((g) => g.dispose());
  return geo;
}

// ---------------------------------------------------------------------------
// The shader rig
// ---------------------------------------------------------------------------

/**
 * The skeleton in GLSL: each vertex walks its bone's chain from the hips
 * (spine, head, shoulder, elbow, hand; hip, knee, ankle with the foot kept
 * flat), from the instance's four pose vec4s, the same as personFrame.
 */
const RIG_GLSL = /* glsl */ `
attribute vec3 rig;
attribute vec4 pose0;
attribute vec4 pose1;
attribute vec4 pose2;
attribute vec4 pose3;
attribute vec4 lookA;
attribute vec3 lookB;
varying vec3 vPerson;
vec3 rigColor(float c) {
  int i = int(c + 0.5);
  return pow(vec3(float((i >> 16) & 255), float((i >> 8) & 255), float(i & 255)) / 255.0, vec3(2.2));
}
mat4 rigT(vec3 t) { return mat4(1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., t.x, t.y, t.z, 1.); }
mat4 rigX(float a) { float c = cos(a), s = sin(a); return mat4(1., 0., 0., 0., 0., c, s, 0., 0., -s, c, 0., 0., 0., 0., 1.); }
mat4 rigY(float a) { float c = cos(a), s = sin(a); return mat4(c, 0., -s, 0., 0., 1., 0., 0., s, 0., c, 0., 0., 0., 0., 1.); }
mat4 rigZ(float a) { float c = cos(a), s = sin(a); return mat4(c, s, 0., 0., -s, c, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.); }
mat4 rigBone(float bone) {
  mat4 H = rigT(vec3(0., pose0.x, 0.));
  if (bone < 0.5) return H;
  if (bone < 8.5) {
    mat4 S = H * rigY(pose0.w) * rigX(pose0.y) * rigZ(pose0.z);
    if (bone < 1.5) return S;
    if (bone < 2.5) return S * rigT(vec3(0., ${BODY.neck.toFixed(3)} - 0.02, 0.)) * rigY(pose1.x) * rigX(pose1.y);
    float s = bone < 5.5 ? 1. : -1.;
    vec3 a = s > 0. ? vec3(pose1.z, pose1.w, pose2.x) : pose2.yzw;
    mat4 U = S * rigT(vec3(s * ${BODY.shoulder.toFixed(3)}, ${BODY.spine.toFixed(3)}, 0.)) * rigX(-a.x) * rigZ(s * a.y);
    float k = bone - (s > 0. ? 3. : 6.);
    if (k < 0.5) return U;
    mat4 F = U * rigT(vec3(0., -${BODY.upper.toFixed(3)}, 0.)) * rigX(-a.z);
    return k < 1.5 ? F : F * rigT(vec3(0., -${BODY.fore.toFixed(3)}, 0.));
  }
  float s = bone < 11.5 ? 1. : -1.;
  vec2 l = s > 0. ? pose3.xy : pose3.zw;
  mat4 T = H * rigT(vec3(s * ${BODY.hipW.toFixed(3)}, 0., 0.)) * rigX(-l.x);
  float k = bone - (s > 0. ? 9. : 12.);
  if (k < 0.5) return T;
  mat4 K = T * rigT(vec3(0., -${BODY.thigh.toFixed(3)}, 0.)) * rigX(l.y);
  return k < 1.5 ? K : K * rigT(vec3(0., -${BODY.shin.toFixed(3)}, 0.)) * rigX(l.x - l.y);
}
`;

/** The people's material: standard shading, the rig before the normals, colors and options per instance. */
export function personMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.04 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_GLSL}`)
      .replace(
        '#include <beginnormal_vertex>',
        `mat4 rigM = rigBone(rig.x);
        int worn = int(lookB.z + 0.5);
        int need = int(rig.z + 0.5);
        bool hidden = need > 0 && (worn & need) == 0;
        int pid = int(rig.y + 0.5);
        vPerson = pid == 0 ? rigColor(lookA.x) : pid == 1 ? rigColor(lookA.y) : pid == 2 ? rigColor(lookA.z) : pid == 3 ? rigColor(lookA.w)
          : pid == 4 ? rigColor(lookB.x) : pid == 5 ? rigColor(lookB.y) : pid == 6 ? vec3(1.4, 1.4, 1.3)
          : pid == 7 ? ((worn & ${WEAR.gloves}) != 0 ? vec3(0.012) : rigColor(lookA.x)) : vec3(0.02);
        vec3 objectNormal = mat3(rigM) * normal;`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = hidden ? vec3(0.) : (rigM * vec4(position, 1.)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPerson;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPerson;');
  };
  return mat;
}

/**
 * The CPU's copy of the skeleton: `out` becomes the frame of a hand (0 left,
 * 1 right) or the spine for a person at `root` in pose p, matching the
 * shader's chain, for whatever they hold.
 */
export function personFrame(root: THREE.Matrix4, p: PersonPose, at: 0 | 1 | 'spine', out: THREE.Matrix4): THREE.Matrix4 {
  const t = TMP.t;
  const r = (x: number, y: number, z: number) => TMP.r.makeRotationFromEuler(TMP.e.set(x, y, z, 'YXZ'));
  out.copy(root).multiply(t.makeTranslation(0, p.hipY, 0)).multiply(r(p.lean, p.twist, p.side));
  if (at === 'spine') return out;
  const s = at === 0 ? 1 : -1;
  const a = p.arms[at];
  out.multiply(t.makeTranslation(s * BODY.shoulder, BODY.spine, 0)).multiply(r(-a.raise, 0, 0)).multiply(TMP.r.makeRotationZ(s * a.out));
  out.multiply(t.makeTranslation(0, -BODY.upper, 0)).multiply(TMP.r.makeRotationX(-a.elbow));
  return out.multiply(t.makeTranslation(0, -BODY.fore, 0));
}
const TMP = { t: new THREE.Matrix4(), r: new THREE.Matrix4(), e: new THREE.Euler() };

// ---------------------------------------------------------------------------
// The crowd of them
// ---------------------------------------------------------------------------

/** Up to `max` people at one level of detail in one draw call (and their blob shadows in another): place, pose and dress each by index, then commit(). */
export class People {
  readonly mesh: THREE.InstancedMesh;
  readonly shadows: THREE.InstancedMesh;
  readonly group = new THREE.Group();
  private readonly pose: THREE.InstancedBufferAttribute[];
  /** Skin, shirt, trousers and shoes; then hair, cap and the WEAR bits. */
  private readonly lookA: THREE.InstancedBufferAttribute;
  private readonly lookB: THREE.InstancedBufferAttribute;
  private readonly m4 = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    readonly max: number,
    track: <T extends Disposable>(x: T) => T,
    shadowMap: THREE.Texture,
    detail: PersonDetail = 'hero',
  ) {
    const geo = track(personGeometry(detail));
    const inst = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(max * size), size).setUsage(THREE.DynamicDrawUsage);
    this.pose = [0, 1, 2, 3].map((i) => {
      const a = inst(4);
      geo.setAttribute(`pose${i}`, a);
      return a;
    });
    this.lookA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.lookB = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    geo.setAttribute('lookA', this.lookA);
    geo.setAttribute('lookB', this.lookB);
    this.mesh = new THREE.InstancedMesh(geo, track(personMaterial()), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // People spread across the scene; one instance's bounds would cull the rest.
    this.mesh.frustumCulled = false;
    this.shadows = new THREE.InstancedMesh(
      track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
      track(new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowMap, transparent: true, opacity: 0.55, depthWrite: false })),
      max,
    );
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 1;
    for (let i = 0; i < max; i++) this.hide(i);
    this.group.add(this.mesh, this.shadows);
  }

  /** Dress person i. */
  setLook(i: number, look: PersonLook): void {
    // The hex values go in as integers (exact in a float's 24 bit mantissa); the shader unpacks and linearizes them.
    this.lookA.setXYZW(i, look.skin, look.shirt, look.pants, look.shoes);
    this.lookB.setXYZ(i, look.hair, look.cap, look.wear);
    this.lookA.needsUpdate = this.lookB.needsUpdate = true;
  }

  /** Stand person i at `root` (position and heading) in pose p, its shadow under the hips. */
  set(i: number, root: THREE.Matrix4, p: PersonPose): void {
    this.mesh.setMatrixAt(i, root);
    const [a, b, c, d] = this.pose;
    a.setXYZW(i, p.hipY, p.lean, p.side, p.twist);
    b.setXYZW(i, p.headYaw, p.headPitch, p.arms[0].raise, p.arms[0].out);
    c.setXYZW(i, p.arms[0].elbow, p.arms[1].raise, p.arms[1].out, p.arms[1].elbow);
    d.setXYZW(i, p.legs[0][0], p.legs[0][1], p.legs[1][0], p.legs[1][1]);
    this.v.setFromMatrixPosition(root);
    this.shadows.setMatrixAt(i, this.m4.makeScale(0.75, 1, 0.75).setPosition(this.v.x, this.v.y + 0.008, this.v.z));
  }

  /** Take person i out of the scene. */
  hide(i: number): void {
    this.mesh.setMatrixAt(i, this.zero);
    this.shadows.setMatrixAt(i, this.zero);
  }

  /** Upload this frame's changes. */
  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
    for (const a of this.pose) a.needsUpdate = true;
  }
}
