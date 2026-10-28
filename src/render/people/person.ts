/**
 * The game's people, one character for everyone (docs/people.md): stylized,
 * rounded low poly shapes in flat colored clothes, with a light touch of a
 * face (eyes, brows, a nose, ears) at the two near levels and none beyond.
 * Options per person: what is on the head (a cap worn either way, a beanie,
 * a bucket hat, a bandana, a hood, headphones), the hair (swept, long, big),
 * an open jacket, cargo pockets, baggy hems, a backpack, a tool belt,
 * coverall sleeves tied at the waist, a name patch, a chain, work boots, a
 * rag, a hi-vis stripe, gloves, and a phone, a flag, a glowstick or a cup in
 * the right hand. A tank top, shorts and a crop top are colors, not shapes:
 * the upper arms, shins and midriff are their own parts and take the skin's
 * color when the bit says so. One merged mesh with a fixed 15 bone skeleton
 * at four levels of detail (hero beside the cars, crowd and far for the
 * stands, mid between); every vertex carries its bone, its part (which of
 * the person's colors it wears), the option it belongs to and a baked
 * occlusion (armpits, crotch, under the chin and the brim).
 *
 * People draws any number of them as one InstancedMesh: the vertex shader
 * poses each from 16 joint angles (PersonPose, four vec4s per instance, or a
 * GLSL snippet that computes them, as the crowds do from their excitement)
 * and colors it from seven per instance colors packed as 24 bit integers
 * with the options' bits (which keeps the whole character inside WebGL's 16
 * vertex attributes). One draw call per level of detail on screen; the CPU
 * writes only what changed. The fragment adds a cool rim so figures separate
 * from the night, and a roughness per part (matte cloth, a reflective
 * stripe). personFrame() is the same skeleton on the CPU, for things held in
 * a hand; it and RIG_GLSL must stay in step. Render only.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, lerp } from '../../sim/math';
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

/**
 * The options a person wears or holds, as bits of PersonLook.wear (a float in the shader: exact to 24 bits, and all
 * 24 are used). The items live in the right hand. Two groups are read as small numbers rather than single bits, so
 * mutually exclusive options share bits: the head (cap, beanie, hood: HEAD_STATE) and the hair (hair, long:
 * HAIR_STATE). The combinations below are those states; set them with `withHead` / `withHair` (clearing the group),
 * since `wear & WEAR.bucket` is also true of a plain cap. Clearing a group's bits and setting `cap` (the drivers)
 * always leaves a plain cap and at most long hair under it.
 */
export const WEAR = {
  cap: 1,
  beanie: 2,
  hair: 4,
  stripe: 8,
  gloves: 16,
  hood: 32,
  phone: 64,
  flag: 128,
  glowstick: 256,
  /** Long hair down the back (with `hair`: big hair). */
  long: 1 << 9,
  /** An open jacket over the shirt, in the sleeves' color, and its sleeves down both arms. */
  jacket: 1 << 10,
  /** Cargo pockets on the thighs. */
  cargo: 1 << 11,
  /** Wide legs that flare over the shoes (baggy jeans, cargos). */
  baggy: 1 << 12,
  backpack: 1 << 13,
  toolbelt: 1 << 14,
  /** A coverall's top rolled down and its sleeves tied at the waist, in the sleeves' color. */
  tied: 1 << 15,
  /** A name patch on the left chest. */
  patch: 1 << 16,
  chain: 1 << 17,
  cup: 1 << 18,
  boots: 1 << 19,
  /** Bare shoulders and arms (the arms take the skin's color, the jacket's sleeves still win). */
  tank: 1 << 20,
  /** Bare shins. */
  shorts: 1 << 21,
  /** A bare midriff. */
  crop: 1 << 22,
  /** A red shop rag hanging from the right back pocket. */
  rag: 1 << 23,
  /** Head states (combinations of cap, beanie and hood). */
  bucket: 1 | 2,
  backcap: 1 | 32,
  bandana: 2 | 32,
  headphones: 1 | 2 | 32,
  /** Hair state: a big curly crown. */
  big: 4 | (1 << 9),
} as const;

/** The bits of the head group and of the hair group. */
export const HEADWEAR = WEAR.cap | WEAR.beanie | WEAR.hood;
export const HAIRDO = WEAR.hair | WEAR.long;

/** What is on the head, by its state number (cap + 2 beanie + 4 hood). */
export const HEAD_STATE = { none: 0, cap: 1, beanie: 2, bucket: 3, hood: 4, backcap: 5, bandana: 6, headphones: 7 } as const;
/** The hair, by its state number (hair + 2 long): none is shaved or close cropped. */
export const HAIR_STATE = { none: 0, swept: 1, long: 2, big: 3 } as const;

/** The head state of a wear mask. */
export const headState = (wear: number): number => (wear & WEAR.cap ? 1 : 0) | (wear & WEAR.beanie ? 2 : 0) | (wear & WEAR.hood ? 4 : 0);
/** The hair state of a wear mask. */
export const hairState = (wear: number): number => (wear & WEAR.hair ? 1 : 0) | (wear & WEAR.long ? 2 : 0);
/** `wear` with its head group replaced by `head` (one of WEAR's head states, or 0 for a bare head). */
export const withHead = (wear: number, head: number): number => (wear & ~HEADWEAR) | head;
/** `wear` with its hair group replaced by `hair` (WEAR.hair, WEAR.long, WEAR.big or 0). */
export const withHair = (wear: number, hair: number): number => (wear & ~HAIRDO) | hair;

/** How much of the character to build: hero beside the cars, mid for a few at middle distance, crowd for the stands, far for their back rows. */
export type PersonDetail = 'hero' | 'mid' | 'crowd' | 'far';

/**
 * A person's colors (hex) and options (WEAR bits). `cap` colors whatever is on the head, the backpack and the
 * headphones' cans; `sleeves` the forearms, the hood, the jacket and its sleeves and tied coverall sleeves (a second
 * color, the shirt's for long sleeves, or the skin's for short ones).
 */
export interface PersonLook {
  skin: number;
  shirt: number;
  sleeves: number;
  pants: number;
  shoes: number;
  hair: number;
  cap: number;
  wear: number;
}

/** The bones, in the order the shader's chain reads them. */
const BONE = { hips: 0, spine: 1, head: 2, upperL: 3, foreL: 4, handL: 5, upperR: 6, foreR: 7, handR: 8, thighL: 9, shinL: 10, footL: 11, thighR: 12, shinR: 13, footR: 14 } as const;
/**
 * The parts, by which per instance color they wear: the person's seven, then
 * the fixed ones (stripe white, hands skin or gloves, trim dark) and the
 * items' lit screen or glowstick and the flag's cloth, colored by the shader
 * variant (the crowd's neon). From 12 on the shader picks the color from the
 * options: the upper arm (skin in a tank top, the sleeves under a jacket,
 * else the shirt), the forearm (skin in a tank top, else the sleeves), the
 * shin (skin in shorts), the midriff (skin in a crop top), the far level's
 * torso (the shirt, mostly the jacket's color over it), then the fixed patch
 * cream, metal, leather, shop red and eyes, and the sole (a sneaker's light
 * midsole, a boot's dark one).
 */
const PART = {
  skin: 0,
  shirt: 1,
  pants: 2,
  shoes: 3,
  hair: 4,
  cap: 5,
  sleeves: 6,
  stripe: 7,
  hand: 8,
  trim: 9,
  glow: 10,
  cloth: 11,
  upper: 12,
  fore: 13,
  shin: 14,
  midriff: 15,
  outer: 16,
  patch: 17,
  metal: 18,
  leather: 19,
  red: 20,
  eye: 21,
  sole: 22,
} as const;

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

/** Baked occlusion for a vertex of a piece, from its position in the bone's frame (1 = open, lower = tucked in). */
type Occlusion = (x: number, y: number, z: number) => number;

/**
 * When a piece shows: a positive tag is WEAR bits (shown when any is worn, 0 always), a negative one names the head
 * states and hair states it shows in (`fits`), so one piece can serve several states of a group (the cap's crown under
 * a cap worn either way and a bandana) and hide under others (hair under a hat).
 */
type Need = number;

/** A piece shown in any of `heads` (HEAD_STATE numbers) and any of `hairs` (HAIR_STATE numbers); null is every state. */
function fits(heads: readonly number[] | null, hairs: readonly number[] | null = null): Need {
  const hm = heads ? heads.reduce((m, s) => m | (1 << s), 0) : 0xff;
  const rm = hairs ? hairs.reduce((m, s) => m | (1 << s), 0) : 0xf;
  return -(hm | (rm << 8));
}
const H = HEAD_STATE;
const R = HAIR_STATE;
/** Bare heads, the hood and headphones: where hair shows. */
const HAIR_SHOWS = [H.none, H.hood, H.headphones];
/** Everything but the hood, which covers the back of the head. */
const NOT_HOOD = [H.none, H.cap, H.beanie, H.bucket, H.backcap, H.bandana, H.headphones];

/** One piece of the body: a geometry in its bone's frame, tagged per vertex with bone, part, when it shows and occlusion. */
function piece(geo: THREE.BufferGeometry, bone: number, part: number, wear: Need = 0, ao?: Occlusion): THREE.BufferGeometry {
  if (!geo.index) geo.setIndex(Array.from({ length: geo.getAttribute('position').count }, (_, i) => i));
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const tag = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) tag.set([bone, part, wear, ao ? clamp(ao(pos.getX(i), pos.getY(i), pos.getZ(i)), 0, 1) : 1], i * 4);
  geo.setAttribute('rig', new THREE.Float32BufferAttribute(tag, 4));
  geo.deleteAttribute('uv');
  return geo;
}

/**
 * A limb bone's shape: rounded at both joints, tapering from rTop at the joint
 * to rBot, with a bulge of rMid part way down when given (a calf, a bicep).
 * `plain` skips the round caps and the bulge (the crowd's limbs: a third of the triangles).
 */
function limb(rTop: number, rBot: number, len: number, seg: number, rMid = 0, at = 0.4, plain = false): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, rTop)];
  if (plain) pts.push(new THREE.Vector2(rTop, 0), new THREE.Vector2(rBot, -len));
  else {
    for (const a of [60, 30, 0]) pts.push(new THREE.Vector2(rTop * Math.cos((a * Math.PI) / 180), rTop * Math.sin((a * Math.PI) / 180)));
    if (rMid) pts.push(new THREE.Vector2(rMid, -len * at));
    pts.push(new THREE.Vector2(rBot, -len));
    for (const a of [30, 60]) pts.push(new THREE.Vector2(rBot * Math.cos((a * Math.PI) / 180), -len - rBot * Math.sin((a * Math.PI) / 180)));
  }
  pts.push(new THREE.Vector2(0.001, -len - rBot));
  return new THREE.LatheGeometry(outward(pts), seg);
}

/**
 * A lathe profile ordered so its faces and normals point out: three's LatheGeometry faces outward when an open
 * profile runs up (and a closed loop runs counter-clockwise in radius and height). The character's head and limbs
 * were written top down and drew inside out, their far side showing, so whatever sat inside them (the neck in the
 * head) showed through; this turns any profile the right way round.
 */
function outward(pts: THREE.Vector2[]): THREE.Vector2[] {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.distanceTo(last) < 1e-6) {
    let area = 0;
    for (let i = 0; i < pts.length - 1; i++) area += pts[i].x * pts[i + 1].y - pts[i + 1].x * pts[i].y;
    return area < 0 ? pts.reverse() : pts;
  }
  return last.y < first.y ? pts.reverse() : pts;
}

/** A lathe from [radius, y] pairs, top to bottom, scaled across (z) to flatten it; `gap` (rad) leaves it open at the front (+z). */
function lathe(profile: readonly (readonly [number, number])[], seg: number, sz = 1, gap = 0): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    outward(profile.map(([r, y]) => new THREE.Vector2(r, y))),
    seg,
    gap / 2,
    Math.PI * 2 - gap,
  ).scale(1, 1, sz);
}

/** Keep only the lathe's bands between profile points `from` and `to` (a lathe of `np` points), so two parts of one lathe share its smooth seam. */
function band(geo: THREE.BufferGeometry, np: number, from: number, to: number): THREE.BufferGeometry {
  const idx = geo.index!;
  const keep: number[] = [];
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t);
    const b = idx.getX(t + 1);
    const c = idx.getX(t + 2);
    const j = Math.min(a % np, b % np, c % np);
    if (j >= from && j < to) keep.push(a, b, c);
  }
  geo.setIndex(keep);
  return geo;
}

/** Flatten the back (z < 0) by k, the normals with it: a torso is deeper at the chest than behind the shoulder blades. */
function flatBack(geo: THREE.BufferGeometry, k = 0.86): THREE.BufferGeometry {
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  for (let i = 0; i < p.count; i++) {
    if (p.getZ(i) >= 0) continue;
    p.setZ(i, p.getZ(i) * k);
    const nz = n.getZ(i) / k;
    const l = Math.hypot(n.getX(i), n.getY(i), nz) || 1;
    n.setXYZ(i, n.getX(i) / l, n.getY(i) / l, nz / l);
  }
  return geo;
}

/** Big hair's crown: an icosphere pushed in and out by a fixed lumpy pattern, smooth shaded, so it reads as curls rather than a ball. */
function curls(r: number, detail: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(r, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const geo = mergeVertices(ico);
  ico.dispose();
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + 0.07 * Math.sin(x * 61 + y * 37) * Math.cos(z * 53 - y * 29);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Darker toward the top of a limb (the joint it hangs from), from y = 0 down to `depth`. */
const jointShade = (depth: number, floor = 0.62): Occlusion => (_x, y) => floor + (1 - floor) * clamp(-y / depth, 0, 1);

/** The head's profile ([radius, y], crown to chin): an egg a little narrower at the chin. */
const HEAD: readonly (readonly [number, number])[] = [
  [0.001, 0.235],
  [0.06, 0.225],
  [0.095, 0.19],
  [0.105, 0.14],
  [0.1, 0.09],
  [0.082, 0.04],
  [0.05, 0.008],
  [0.001, 0.0],
];

/**
 * The scalp's hair: the head's own lathe down to the ears, at the head's segment count, blown up by a tenth about
 * the skull's middle, so every face of it stands a constant centimetre off the skull's (a sphere crossed the egg at a
 * shallow angle over much of the crown and the skull showed through in patches). Below the hairline (high at the
 * forehead, at the ears on the sides, low at the nape) its vertices sink well inside the skull, so the hair meets the
 * skin along one steep, clean line.
 */
function scalp(seg: number): THREE.BufferGeometry {
  const geo = lathe(HEAD.slice(0, 5), seg, 1.02);
  const p = geo.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i) * 1.1;
    let z = p.getZ(i) * 1.1;
    const y = 0.13 + (p.getY(i) - 0.13) * 1.1;
    const front = z / (Math.hypot(x, z) || 1);
    const line = front > 0 ? lerp(0.1, 0.168, clamp((front - 0.2) / 0.6, 0, 1)) : lerp(0.1, 0.06, clamp(-front / 0.7, 0, 1));
    if (y < line) {
      x *= 0.8;
      z *= 0.8;
    }
    p.setXYZ(i, x, y, z);
  }
  return geo;
}

/** The torso's profile ([radius, y] from the hips up), with the crop line at point 2. */
const TORSO: readonly (readonly [number, number])[] = [
  [0.001, -0.02],
  [0.13, 0.0],
  [0.155, 0.15],
  [0.158, 0.22],
  [0.178, 0.36],
  [0.19, 0.45],
  [0.18, 0.505],
  [0.075, 0.558],
  [0.001, 0.563],
];
/** Where the crop top ends: the profile point the midriff runs up to. */
const CROP_AT = 2;
/** The open jacket's shell: a little proud of the torso, down over the hips, a standing collar. */
const JACKET: readonly (readonly [number, number])[] = [
  [0.174, -0.075],
  [0.17, 0.0],
  [0.166, 0.1],
  [0.172, 0.22],
  [0.192, 0.36],
  [0.203, 0.45],
  [0.194, 0.512],
  [0.1, 0.566],
  [0.086, 0.6],
];
/** The crowd's jacket: the same shell at five points. */
const JACKET_PLAIN: readonly (readonly [number, number])[] = [
  [0.174, -0.075],
  [0.17, 0.15],
  [0.2, 0.44],
  [0.192, 0.512],
  [0.09, 0.585],
];

/**
 * The character: a belted pelvis, a torso that widens from the waist to the
 * shoulders under a collar (its midriff a part of its own, its back a little
 * flatter than its chest), an egg of a head with a chin, a light face (eyes,
 * brows, a nose, ears) at hero and mid, tapered limbs with a calf and a bicep
 * in them, a thumb at hero, mitten hands, shoes on soles.
 * Every option is in the mesh (hidden ones collapse to a point in the
 * shader): what is on the head, the hair, the jacket, pockets and hems, the
 * backpack, the shop's belt, tied sleeves, patch, rag and boots, the chain,
 * and what the right hand holds. Every piece sits in its bone's frame. The
 * mid level keeps the shapes at fewer segments without the trim, the shop's
 * hardware or the chain; the crowd level drops the face and the shop's
 * pieces too (the stands are race-goers and pedestrians); the far level is
 * boxes, one per silhouette change (a hat, a bucket brim, long hair, a
 * backpack). Occlusion is baked where the body folds.
 */
export function personGeometry(detail: PersonDetail = 'hero'): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, bone: number, part: number, wear: Need = 0, ao?: Occlusion) => pieces.push(piece(g, bone, part, wear, ao));
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
  /** Left (+x) then right: the side's sign and its bones. */
  const arms = [
    [1, BONE.upperL, BONE.foreL, BONE.handL],
    [-1, BONE.upperR, BONE.foreR, BONE.handR],
  ] as const;
  const legs = [
    [1, BONE.thighL, BONE.shinL, BONE.footL],
    [-1, BONE.thighR, BONE.shinR, BONE.footR],
  ] as const;
  if (detail === 'far') {
    add(box(0.3, 0.14, 0.2, 0, -0.02, 0), BONE.hips, PART.pants);
    add(box(0.34, 0.52, 0.22, 0, 0.3, 0), BONE.spine, PART.outer);
    add(box(0.18, 0.22, 0.19, 0, 0.12, 0), BONE.head, PART.skin, 0, jointShade(-0.12, 0.7));
    add(box(0.19, 0.1, 0.2, 0, 0.19, -0.01), BONE.head, PART.hair, fits(HAIR_SHOWS, [R.swept, R.long, R.big]));
    add(box(0.19, 0.08, 0.2, 0, 0.2, 0), BONE.head, PART.cap, fits([H.cap, H.beanie, H.bucket, H.backcap, H.bandana]));
    // What changes the outline at a distance: a bucket hat's brim, long hair down the back, a backpack.
    add(box(0.3, 0.02, 0.3, 0, 0.165, 0), BONE.head, PART.cap, fits([H.bucket]));
    add(box(0.17, 0.2, 0.07, 0, 0.04, -0.09), BONE.head, PART.hair, fits(NOT_HOOD, [R.long]));
    add(box(0.26, 0.3, 0.1, 0, 0.3, -0.16), BONE.spine, PART.cap, WEAR.backpack);
    for (const [, upper, fore] of arms) {
      add(box(0.09, 0.3, 0.09, 0, -0.15, 0), upper, PART.upper, 0, jointShade(0.25));
      add(box(0.08, 0.34, 0.08, 0, -0.17, 0), fore, PART.fore);
    }
    for (const [, thigh, shin, foot] of legs) {
      add(box(0.14, 0.45, 0.14, 0, -0.22, 0), thigh, PART.pants, 0, jointShade(0.3));
      add(box(0.11, 0.45, 0.11, 0, -0.22, 0), shin, PART.shin);
      add(box(0.11, 0.08, 0.26, 0, -0.04, 0.06), foot, PART.shoes);
    }
  } else {
    const hero = detail === 'hero';
    const plain = detail === 'crowd';
    /** Hero and mid: the face, the lapels, the patch, pockets' flaps and the shop's pieces. */
    const near = !plain;
    const seg = hero ? 16 : near ? 8 : 6;
    const lseg = hero ? 12 : 6;
    const sph = (r: number, w = seg, h = Math.round(seg * 0.6)) => new THREE.SphereGeometry(r, w, h);
    const dome = (r: number, w = seg) => new THREE.SphereGeometry(r, w, Math.max(3, Math.round(w * 0.4)), 0, Math.PI * 2, 0, Math.PI / 2);
    // The crotch under the pelvis, the armpits and the neck's hollow on the torso.
    add(sph(0.15).scale(1.14, 0.7, 0.82).translate(0, -0.03, 0), BONE.hips, PART.pants, 0, (_x, y) => 0.55 + 0.45 * clamp((y + 0.13) / 0.14, 0, 1));
    if (hero) add(new THREE.CylinderGeometry(0.172, 0.172, 0.035, seg, 1, true).scale(1, 1, 0.74).translate(0, 0.035, 0), BONE.hips, PART.trim);
    const torsoAo: Occlusion = (x, y) => {
      const pit = clamp(1 - Math.hypot((Math.abs(x) - 0.19) / 0.09, (y - 0.42) / 0.1), 0, 1);
      const waist = 1 - 0.25 * clamp(1 - y / 0.08, 0, 1);
      const neck = 1 - 0.3 * clamp((y - 0.5) / 0.06, 0, 1);
      return Math.min(waist, neck) * (1 - 0.45 * pit);
    };
    // One lathe cut in two at the crop line, so a crop top's bare midriff and a shirt share a smooth seam.
    add(flatBack(band(lathe(TORSO, seg, 0.68), TORSO.length, 0, CROP_AT)), BONE.spine, PART.midriff, 0, torsoAo);
    add(flatBack(band(lathe(TORSO, seg, 0.68), TORSO.length, CROP_AT, TORSO.length)), BONE.spine, PART.shirt, 0, torsoAo);
    if (hero) add(new THREE.CylinderGeometry(0.075, 0.068, 0.035, lseg).translate(0, 0.555, 0), BONE.spine, PART.shirt);
    add(flatBack(new THREE.CylinderGeometry(0.192, 0.192, 0.045, seg, 1, true).scale(1, 1, 0.69).translate(0, 0.37, 0)), BONE.spine, PART.stripe, WEAR.stripe);
    add(new THREE.CylinderGeometry(0.044, 0.05, near ? 0.13 : 0.1, lseg, 1, true).translate(0, BODY.neck - (near ? 0.015 : 0.03), 0), BONE.spine, PART.skin, 0, () => 0.7);
    // The head: an egg, a little narrower at the chin, that sits on the neck; shaded under the chin. Near, the lower
    // face comes forward into a chin and the back of the skull's base lifts, so the neck shows behind the jaw.
    const hseg = hero ? 20 : near ? 10 : seg;
    const head = lathe(HEAD, hseg, 1.02);
    if (near) {
      const p = head.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        const z = p.getZ(i);
        const low = clamp(1 - y / 0.1, 0, 1);
        if (z > 0) p.setZ(i, z + 0.016 * low * clamp(z / 0.06, 0, 1));
        else p.setY(i, y + 0.04 * low * clamp(-z / 0.05, 0, 1));
      }
    }
    // Shaded under the jaw, not on the chin's front, which faces the camera now that it comes forward.
    add(head, BONE.head, PART.skin, 0, (_x, y, z) => Math.max(0.55 + 0.45 * clamp(y / 0.07, 0, 1), 0.6 + 0.4 * clamp((z - 0.03) / 0.05, 0, 1)));
    if (near) {
      // A light face: dark flattened eyes, brows in the hair's color, a nose and ears. Kept small and simple so the
      // character stays stylized; the crowd and far levels are faceless.
      const f = hero ? 8 : 5;
      // Eye depth: just proud of the head's facets at each level's segment count.
      const ez = hero ? 0.0965 : 0.0925;
      for (const [s] of arms) {
        add(sph(0.011, f, f - 2).scale(1, 0.75, 0.42).translate(s * 0.035, 0.12, ez), BONE.head, PART.eye, 0, () => 0.45);
        add(new THREE.BoxGeometry(0.034, 0.0075, 0.012).rotateZ(-s * 0.12).translate(s * 0.037, 0.142, ez + 0.001), BONE.head, PART.hair, 0, () => 0.8);
        add(sph(0.021, f - 2, f - 3).scale(0.42, 1, 0.62).rotateY(s * 0.35).translate(s * 0.101, 0.11, -0.01), BONE.head, PART.skin, 0, () => 0.72);
      }
      add(sph(0.015, f, f - 2).scale(0.62, 1.5, 0.8).rotateX(-0.3).translate(0, 0.098, 0.1), BONE.head, PART.skin, 0, (_x, y) => 0.7 + 0.3 * clamp((y + 0.012) / 0.03, 0, 1));
    }
    // Hair: swept (the scalp, hidden under hats), long (the scalp plus a fall down the back, which shows under any
    // hat but the hood) or big (the scalp with a crown of curls behind its hairline, bare heads only).
    add(scalp(hseg), BONE.head, PART.hair, fits(HAIR_SHOWS, [R.swept, R.long, R.big]));
    add(sph(0.1, hero ? 12 : seg, hero ? 7 : 3).scale(1.1, 1.75, 0.7).translate(0, 0.09, -0.06), BONE.head, PART.hair, fits(NOT_HOOD, [R.long]), (_x, y) => 0.7 + 0.3 * clamp((y + 0.05) / 0.15, 0, 1));
    add(curls(0.132, hero ? 2 : 0).scale(1.05, 0.92, 1.05).translate(0, 0.178, -0.05), BONE.head, PART.hair, fits([H.none], [R.big]));
    // On the head. The crown of a cap serves the cap worn either way and the bandana; the beanie's serves the bucket hat.
    add(dome(0.115).translate(0, 0.15, 0), BONE.head, PART.cap, fits([H.cap, H.backcap, H.bandana]));
    add(box(0.17, 0.012, 0.11, 0, 0, 0).rotateX(0.06).translate(0, 0.152, 0.1), BONE.head, PART.cap, fits([H.cap]), () => 0.7);
    add(box(0.17, 0.012, 0.1, 0, 0, 0).rotateX(-0.12).translate(0, 0.156, -0.1), BONE.head, PART.cap, fits([H.backcap]), () => 0.8);
    add(sph(0.022, near ? 6 : 4, near ? 4 : 3).translate(0, 0.165, -0.11), BONE.head, PART.cap, fits([H.bandana]), () => 0.8);
    if (near) for (const [s] of arms) add(box(0.028, 0.075, 0.006, 0, 0, 0).rotateZ(s * 0.25).rotateX(0.3).translate(s * 0.016, 0.125, -0.12), BONE.head, PART.cap, fits([H.bandana]), () => 0.75);
    add(dome(0.119).scale(1, 1.15, 1).translate(0, 0.15, 0), BONE.head, PART.cap, fits(near ? [H.beanie] : [H.beanie, H.bucket]));
    // The bucket hat's crown near: soft straight sides and a flat top (the beanie's dome reads as a hard hat).
    if (near)
      add(
        lathe(
          (
            [
              [0.001, 0.262],
              [0.092, 0.258],
              [0.114, 0.243],
              [0.121, 0.19],
              [0.122, 0.16],
            ] as const
          ).filter((_, i) => hero || i !== 1),
          seg,
        ),
        BONE.head,
        PART.cap,
        fits([H.bucket]),
      );
    if (near) add(new THREE.CylinderGeometry(0.121, 0.121, 0.04, seg, 1, true).translate(0, 0.163, 0), BONE.head, PART.cap, fits([H.beanie]));
    add(
      lathe(
        [
          [0.118, 0.176],
          [0.168, 0.128],
          [0.116, 0.164],
          [0.118, 0.176],
        ],
        seg,
      ),
      BONE.head,
      PART.cap,
      fits([H.bucket]),
      (_x, y) => (y < 0.15 ? 0.75 : 1),
    );
    // The hood: a shell round the back and top of the head, open at the face, in the sleeves' color.
    add(new THREE.SphereGeometry(0.14, hero ? 12 : seg, hero ? 7 : near ? 4 : 3, Math.PI * 0.85, Math.PI * 1.3).scale(1, 1.08, 1).translate(0, 0.115, -0.02), BONE.head, PART.sleeves, fits([H.hood]), (_x, _y, z) => 0.75 + 0.25 * clamp(-z / 0.1, 0, 1));
    // Headphones, near only (in the stands they are too small to read): a band over the top, a can over each ear in the cap's color.
    if (near) {
      add(new THREE.TorusGeometry(0.122, 0.009, hero ? 4 : 3, hero ? 12 : 6, Math.PI).translate(0, 0.13, 0), BONE.head, PART.trim, fits([H.headphones]));
      for (const [s] of arms) add(new THREE.CylinderGeometry(0.036, 0.036, 0.028, hero ? lseg : 5).rotateZ(Math.PI / 2).translate(s * 0.116, 0.12, -0.005), BONE.head, PART.cap, fits([H.headphones]));
    }
    // The open jacket: a shell over the torso with a gap down the front, lapels near.
    add(flatBack(lathe(plain ? JACKET_PLAIN : hero ? JACKET : JACKET.filter((_, i) => i !== 1 && i !== 3), seg, 0.7, 0.62)), BONE.spine, PART.sleeves, WEAR.jacket, (_x, y, z) => (z < 0 ? 1 : 0.9) * (1 - 0.3 * clamp((y - 0.52) / 0.05, 0, 1)));
    if (near) for (const [s] of arms) add(new THREE.BoxGeometry(0.045, 0.16, 0.006).rotateZ(s * 0.28).rotateY(s * 0.45).translate(s * 0.074, 0.435, 0.132), BONE.spine, PART.sleeves, WEAR.jacket, () => 0.85);
    // On the chest: a name patch, a chain (hero).
    if (near) add(new THREE.BoxGeometry(0.06, 0.036, 0.006).rotateY(0.3).translate(0.075, 0.4, 0.1155), BONE.spine, PART.patch, WEAR.patch);
    if (hero) add(new THREE.TorusGeometry(0.105, 0.0045, 4, 16, Math.PI).scale(1, 1.17, 1).rotateX(2.13).translate(0, 0.535, 0.05), BONE.spine, PART.metal, WEAR.chain);
    // The backpack: a bag on the back in the cap's color, straps over the shoulders near.
    add(box(0.27, 0.34, 0.11, 0, 0.3, -0.165), BONE.spine, PART.cap, WEAR.backpack, (_x, _y, z) => (z > -0.12 ? 0.6 : 1));
    if (hero) add(box(0.18, 0.1, 0.03, 0, 0.22, -0.232), BONE.spine, PART.cap, WEAR.backpack, () => 0.8);
    if (near) for (const [s] of arms) add(new THREE.BoxGeometry(0.04, 0.2, 0.012).rotateX(-0.1).translate(s * 0.1, 0.42, 0.112), BONE.spine, PART.trim, WEAR.backpack);
    if (hero) {
      // The shop, at hero only (the crew is the only shop floor): a tool belt with pouches, a hammer and a buckle, a
      // coverall's top rolled down to the waist with its sleeves knotted in front.
      add(
        lathe(
          [
            [0.158, 0.065],
            [0.165, 0.06],
            [0.165, 0.0],
            [0.158, -0.005],
            [0.158, 0.065],
          ],
          lseg,
          0.78,
        ),
        BONE.hips,
        PART.leather,
        WEAR.toolbelt,
      );
      for (const [s] of arms) add(box(0.05, 0.11, 0.1, s * 0.19, -0.035, -0.035), BONE.hips, PART.leather, WEAR.toolbelt, (_x, y) => 0.7 + 0.3 * clamp((y + 0.09) / 0.1, 0, 1));
      add(box(0.022, 0.18, 0.022, -0.21, -0.12, 0.05), BONE.hips, PART.leather, WEAR.toolbelt);
      add(box(0.08, 0.026, 0.026, -0.21, -0.025, 0.05), BONE.hips, PART.metal, WEAR.toolbelt);
      add(box(0.04, 0.035, 0.008, 0, 0.03, 0.124), BONE.hips, PART.metal, WEAR.toolbelt);
      add(
        lathe(
          [
            [0.15, 0.1],
            [0.178, 0.085],
            [0.186, 0.045],
            [0.168, 0.012],
            [0.15, 0.1],
          ],
          lseg,
          0.8,
        ),
        BONE.hips,
        PART.sleeves,
        WEAR.tied,
        (_x, y) => 0.7 + 0.3 * clamp((y - 0.01) / 0.06, 0, 1),
      );
      add(sph(0.04, 8, 5).scale(1.2, 0.9, 0.8).translate(0, 0.04, 0.148), BONE.hips, PART.sleeves, WEAR.tied, () => 0.85);
    }
    for (const [s, upper, fore, hand] of arms) {
      add(limb(0.058, 0.046, BODY.upper, lseg, 0.054, 0.35, plain), upper, PART.upper, 0, jointShade(0.14));
      add(limb(0.046, 0.034, BODY.fore, lseg, 0, 0.4, plain), fore, PART.fore, 0, jointShade(0.06, 0.8));
      add(sph(0.046, plain ? 4 : lseg, plain ? 3 : Math.round(lseg * 0.7)).scale(0.76, 1.35, 0.5).translate(0, -0.055, 0.004), hand, PART.hand);
      if (hero) add(new THREE.CapsuleGeometry(0.0105, 0.026, 2, 6).rotateZ(s * 0.45).rotateX(0.35).translate(-s * 0.027, -0.04, 0.012), hand, PART.hand);
    }
    for (const [s, thigh, shin, foot] of legs) {
      add(limb(0.082, 0.062, BODY.thigh, lseg, 0, 0.4, plain).scale(1, 1, 0.95), thigh, PART.pants, 0, jointShade(0.2));
      add(limb(0.062, 0.044, BODY.shin, lseg, 0.066, 0.3, plain), shin, PART.shin, 0, jointShade(0.06, 0.82));
      add(sph(0.07, plain ? 5 : lseg, plain ? 3 : Math.round(lseg * 0.6)).scale(0.82, 0.6, 1.75).translate(0, -0.035, 0.06), foot, PART.shoes, 0, (_x, y) => 0.7 + 0.3 * clamp(-y / 0.06, 0, 1));
      if (!plain) add(new THREE.CylinderGeometry(0.072, 0.072, 0.02, lseg).scale(0.86, 1, 1.85).translate(0, -0.07, 0.06), foot, PART.sole, 0, () => 0.6);
      // Cargo pockets on the outside of the thigh (with a flap near), a wide leg flaring over the shoe.
      add(box(0.024, 0.11, 0.085, s * 0.078, -0.27, 0), thigh, PART.pants, WEAR.cargo, (_x, y) => 0.75 + 0.25 * clamp((y + 0.32) / 0.08, 0, 1));
      if (hero) add(box(0.03, 0.022, 0.092, s * 0.08, -0.205, 0), thigh, PART.pants, WEAR.cargo, () => 0.85);
      add(
        lathe(
          [
            [0.068, -0.16],
            [0.076, -0.31],
            [0.09, -0.445],
          ],
          plain ? 6 : lseg,
        ),
        shin,
        PART.pants,
        WEAR.baggy,
        (_x, y) => 0.8 + 0.2 * clamp((y + 0.45) / 0.1, 0, 1),
      );
      if (hero) {
        // Work boots: a shaft up the ankle in the shoes' color; tied sleeves hanging down the front of the thighs.
        add(
          lathe(
            [
              [0.05, -0.3],
              [0.059, -0.312],
              [0.063, -0.45],
              [0.068, -0.47],
            ],
            lseg,
          ),
          shin,
          PART.shoes,
          WEAR.boots,
          (_x, y) => (y > -0.315 ? 0.6 : 0.9),
        );
        add(limb(0.038, 0.032, 0.3, 8, 0, 0.4, true).rotateZ(-s * 0.12).translate(-s * 0.035, -0.03, 0.086), thigh, PART.sleeves, WEAR.tied, jointShade(0.1, 0.75));
      }
    }
    // A red shop rag hanging from the right back pocket.
    if (hero) add(box(0.07, 0.15, 0.008, 0, -0.1, -0.084), BONE.thighR, PART.red, WEAR.rag, (_x, y) => 0.7 + 0.3 * clamp((-y - 0.03) / 0.08, 0, 1));
  }
  // In the right hand's frame -y runs past the fingers: a phone held out, a pole with its flag, a glowstick along it
  // and at hero a cup standing up when the arm hangs (the far level keeps only the flag).
  if (detail !== 'far') {
    add(box(0.075, 0.15, 0.012, 0, -0.1, 0.03), BONE.handR, PART.trim, WEAR.phone);
    add(box(0.062, 0.13, 0.004, 0, -0.1, 0.038), BONE.handR, PART.glow, WEAR.phone);
    add(box(0.04, 0.36, 0.04, 0, -0.2, 0), BONE.handR, PART.glow, WEAR.glowstick);
    if (detail === 'hero') add(new THREE.CylinderGeometry(0.04, 0.03, 0.11, 10).translate(0, -0.065, 0.038), BONE.handR, PART.red, WEAR.cup);
  }
  add(box(0.03, 1.0, 0.03, 0, -0.5, 0), BONE.handR, PART.trim, WEAR.flag);
  add(box(0.012, 0.34, 0.52, 0, -0.82, 0.27), BONE.handR, PART.cloth, WEAR.flag);
  const geo = mergeGeometries(pieces)!;
  pieces.forEach((g) => g.dispose());
  // Arms up and jumping reach above the rest pose.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 2.1);
  return geo;
}

// ---------------------------------------------------------------------------
// The shader rig
// ---------------------------------------------------------------------------

/**
 * The skeleton in GLSL: each vertex walks its bone's chain from the hips
 * (spine, head, shoulder, elbow, hand; hip, knee, ankle with the foot kept
 * flat) from the pose's four vec4s, the same as personFrame.
 */
const RIG_GLSL = /* glsl */ `
attribute vec4 rig;
attribute vec4 lookA;
attribute vec4 lookB;
varying vec4 vPerson;
varying vec3 vPersonGlow;
vec3 rigColor(float c) {
  int i = int(c + 0.5);
  return pow(vec3(float((i >> 16) & 255), float((i >> 8) & 255), float(i & 255)) / 255.0, vec3(2.2));
}
mat4 rigT(vec3 t) { return mat4(1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., t.x, t.y, t.z, 1.); }
mat4 rigX(float a) { float c = cos(a), s = sin(a); return mat4(1., 0., 0., 0., 0., c, s, 0., 0., -s, c, 0., 0., 0., 0., 1.); }
mat4 rigY(float a) { float c = cos(a), s = sin(a); return mat4(c, 0., -s, 0., 0., 1., 0., 0., s, 0., c, 0., 0., 0., 0., 1.); }
mat4 rigZ(float a) { float c = cos(a), s = sin(a); return mat4(c, s, 0., 0., -s, c, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.); }
mat4 rigBone(float bone, vec4 p0, vec4 p1, vec4 p2, vec4 p3) {
  mat4 H = rigT(vec3(0., p0.x, 0.));
  if (bone < 0.5) return H;
  if (bone < 8.5) {
    mat4 S = H * rigY(p0.w) * rigX(p0.y) * rigZ(p0.z);
    if (bone < 1.5) return S;
    if (bone < 2.5) return S * rigT(vec3(0., ${BODY.neck.toFixed(3)} - 0.02, 0.)) * rigY(p1.x) * rigX(p1.y);
    float s = bone < 5.5 ? 1. : -1.;
    vec3 a = s > 0. ? vec3(p1.z, p1.w, p2.x) : p2.yzw;
    mat4 U = S * rigT(vec3(s * ${BODY.shoulder.toFixed(3)}, ${BODY.spine.toFixed(3)}, 0.)) * rigX(-a.x) * rigZ(s * a.y);
    float k = bone - (s > 0. ? 3. : 6.);
    if (k < 0.5) return U;
    mat4 F = U * rigT(vec3(0., -${BODY.upper.toFixed(3)}, 0.)) * rigX(-a.z);
    return k < 1.5 ? F : F * rigT(vec3(0., -${BODY.fore.toFixed(3)}, 0.));
  }
  float s = bone < 11.5 ? 1. : -1.;
  vec2 l = s > 0. ? p3.xy : p3.zw;
  mat4 T = H * rigT(vec3(s * ${BODY.hipW.toFixed(3)}, 0., 0.)) * rigX(-l.x);
  float k = bone - (s > 0. ? 9. : 12.);
  if (k < 0.5) return T;
  mat4 K = T * rigT(vec3(0., -${BODY.thigh.toFixed(3)}, 0.)) * rigX(l.y);
  return k < 1.5 ? K : K * rigT(vec3(0., -${BODY.shin.toFixed(3)}, 0.)) * rigX(l.x - l.y);
}
`;

/** Bit positions the shader reads the head and hair states from. */
const BIT = (b: number) => Math.round(Math.log2(b));
/**
 * Whether the vertex's piece is worn (`hidden` false): a positive tag shows with any of its bits, a negative one with
 * its head state and its hair state (bits 0-7 and 8-11 of the tag's magnitude, as `fits` packs them). Rounded away
 * from zero, since int() truncates.
 */
const WORN_GLSL = /* glsl */ `
int worn = int(lookB.w + 0.5);
int need = int(rig.z + (rig.z < 0.0 ? -0.5 : 0.5));
bool hidden = false;
if (need > 0) hidden = (worn & need) == 0;
else if (need < 0) {
  int fit = -need;
  int hs = ((worn >> ${BIT(WEAR.cap)}) & 1) | (((worn >> ${BIT(WEAR.beanie)}) & 1) << 1) | (((worn >> ${BIT(WEAR.hood)}) & 1) << 2);
  int rs = ((worn >> ${BIT(WEAR.hair)}) & 1) | (((worn >> ${BIT(WEAR.long)}) & 1) << 1);
  hidden = ((fit >> hs) & 1) == 0 || ((fit >> (8 + rs)) & 1) == 0;
}
`;

/**
 * Color, then roughness, per part. The option parts (12 on) resolve to a person color or the skin by the bits; a part
 * showing skin is `bare` and takes the skin's roughness (and a forearm whose sleeves are the skin's color is bare
 * too). Roughness: matte cloth, skin a touch less, glossier shoes, plastics and the cup, the stripe's reflective tape,
 * a polished chain and wet eyes.
 */
const COLOR_GLSL = /* glsl */ `
bool jacket = (worn & ${WEAR.jacket}) != 0;
bool tank = (worn & ${WEAR.tank}) != 0 && !jacket;
bool bare = pid == 12 ? tank : pid == 13 ? tank || lookB.z == lookA.x : pid == 14 ? (worn & ${WEAR.shorts}) != 0 : pid == 15 ? (worn & ${WEAR.crop}) != 0 : false;
vec3 pc;
if (pid == 0 || bare) pc = rigColor(lookA.x);
else if (pid == 1 || pid == 15 || (pid == 12 && !jacket)) pc = rigColor(lookA.y);
else if (pid == 2 || pid == 14) pc = rigColor(lookA.z);
else if (pid == 3) pc = rigColor(lookA.w);
else if (pid == 4) pc = rigColor(lookB.x);
else if (pid == 5) pc = rigColor(lookB.y);
else if (pid == 6 || pid == 12 || pid == 13) pc = rigColor(lookB.z);
else if (pid == 7) pc = vec3(1.4, 1.4, 1.3);
else if (pid == 8) pc = (worn & ${WEAR.gloves}) != 0 ? vec3(0.012) : rigColor(lookA.x);
else if (pid == 9) pc = vec3(0.02);
else if (pid == 10) pc = vec3(0.0);
else if (pid == 11) pc = cloth;
else if (pid == 16) pc = jacket ? mix(rigColor(lookA.y), rigColor(lookB.z), 0.65) : rigColor(lookA.y);
else if (pid == 17) pc = vec3(0.78, 0.74, 0.62);
else if (pid == 18) pc = vec3(0.85, 0.66, 0.3);
else if (pid == 19) pc = vec3(0.07, 0.04, 0.022);
else if (pid == 20) pc = vec3(0.42, 0.025, 0.02);
else if (pid == 21) pc = vec3(0.01);
else pc = (worn & ${WEAR.boots}) != 0 ? vec3(0.025) : mix(rigColor(lookA.w), vec3(0.8), 0.7);
float rough = pid == 7 ? 0.3 : pid == 18 || pid == 21 ? 0.22 : pid == 3 || pid == 9 || pid == 10 || pid == 20 ? 0.5 : pid == 19 || pid == 22 ? 0.62 : pid == 0 || pid == 8 || bare ? 0.72 : 0.86;
`;

/**
 * How a material variant gets its pose and extras, as GLSL inserted into the
 * person's vertex shader: `pars` declares uniforms and attributes; `pose`
 * must set `vec4 p0, p1, p2, p3` (the PersonPose packing: hipY, lean, side,
 * twist / headYaw, headPitch, L raise, L out / L elbow, R raise, R out, R
 * elbow / L thigh, L knee, R thigh, R knee) and may set `vec3 itemGlow`
 * (the phone screen or glowstick) and `vec3 cloth` (the flag); `post` runs
 * with the final `transformed` position and may move it or scale
 * `vPersonGlow`. The default reads the pose from the pose0..3 attributes.
 * `root` names a `mat4` the pose snippet has set: the person's placement,
 * applied after the rig to positions and normals alike (the walkers, whose
 * route along the street is computed in the shader).
 */
export interface PersonShader {
  pars?: string;
  pose?: string;
  post?: string;
  root?: string;
  /** A key for three's program cache, when `pars`/`pose`/`post` differ between materials. */
  key?: string;
}

/** The people's material: standard shading, the rig before the normals, colors, occlusion and roughness per part, a night rim. */
export function personMaterial(variant: PersonShader = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.04 });
  const pars = variant.pars ?? 'attribute vec4 pose0;\nattribute vec4 pose1;\nattribute vec4 pose2;\nattribute vec4 pose3;';
  const pose = variant.pose ?? 'vec4 p0 = pose0, p1 = pose1, p2 = pose2, p3 = pose3;';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${RIG_GLSL}\n${pars}`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 itemGlow = vec3(0.0);
        vec3 cloth = vec3(0.6);
        ${pose}
        ${WORN_GLSL}
        // A hidden option skips the rig: it collapses to a point below, so only shown pieces pay the chain.
        mat4 rigM = mat4(1.0);
        if (!hidden) rigM = ${variant.root ? `${variant.root} * ` : ''}rigBone(rig.x, p0, p1, p2, p3);
        int pid = int(rig.y + 0.5);
        ${COLOR_GLSL}
        vPerson = vec4(pc * rig.w, rough);
        vPersonGlow = pid == 10 ? itemGlow : pid == 11 ? cloth * 0.3 : vec3(0.0);
        vec3 objectNormal = mat3(rigM) * normal;`,
      )
      .replace('#include <begin_vertex>', `vec3 transformed = hidden ? vec3(0.) : (rigM * vec4(position, 1.)).xyz;\n${variant.post ?? ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vPerson;\nvarying vec3 vPersonGlow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPerson.rgb;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vPerson.a;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vPersonGlow;')
      .replace(
        '#include <opaque_fragment>',
        `// A cool rim so figures separate from the night, strongest edge on.
        float personRim = pow(1.0 - max(dot(normalize(normal), normalize(vViewPosition)), 0.0), 4.0);
        outgoingLight += vec3(0.5, 0.62, 0.8) * personRim * 0.09;
        #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `person-${variant.key ?? 'pose'}`;
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

/** Write a look into the packed per instance attributes at index i (shared by People and the crowds). */
export function writeLook(lookA: THREE.InstancedBufferAttribute, lookB: THREE.InstancedBufferAttribute, i: number, look: PersonLook): void {
  // The hex values go in as integers (exact in a float's 24 bit mantissa); the shader unpacks and linearizes them.
  lookA.setXYZW(i, look.skin, look.shirt, look.pants, look.shoes);
  lookB.setXYZW(i, look.hair, look.cap, look.sleeves, look.wear);
}

/** Up to `max` people at one level of detail in one draw call (and their blob shadows in another, given a map): place, pose and dress each by index, then commit(). */
export class People {
  readonly mesh: THREE.InstancedMesh;
  readonly shadows: THREE.InstancedMesh | null;
  readonly group = new THREE.Group();
  private readonly pose: THREE.InstancedBufferAttribute[];
  private readonly lookA: THREE.InstancedBufferAttribute;
  private readonly lookB: THREE.InstancedBufferAttribute;
  private readonly m4 = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    readonly max: number,
    track: <T extends Disposable>(x: T) => T,
    shadowMap: THREE.Texture | null,
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
    this.lookB = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    geo.setAttribute('lookA', this.lookA);
    geo.setAttribute('lookB', this.lookB);
    this.mesh = new THREE.InstancedMesh(geo, track(personMaterial()), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // People spread across the scene; one instance's bounds would cull the rest.
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.shadows = shadowMap
      ? new THREE.InstancedMesh(
          track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
          track(new THREE.MeshBasicMaterial({ color: 0x000000, map: shadowMap, transparent: true, opacity: 0.55, depthWrite: false })),
          max,
        )
      : null;
    if (this.shadows) {
      this.shadows.frustumCulled = false;
      this.shadows.renderOrder = 1;
      this.group.add(this.shadows);
    }
    for (let i = 0; i < max; i++) this.hide(i);
  }

  /** Dress person i. */
  setLook(i: number, look: PersonLook): void {
    writeLook(this.lookA, this.lookB, i, look);
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
    if (this.shadows) {
      this.v.setFromMatrixPosition(root);
      this.shadows.setMatrixAt(i, this.m4.makeScale(0.75, 1, 0.75).setPosition(this.v.x, this.v.y + 0.008, this.v.z));
    }
  }

  /** Take person i out of the scene. */
  hide(i: number): void {
    this.mesh.setMatrixAt(i, this.zero);
    this.shadows?.setMatrixAt(i, this.zero);
  }

  /** Upload this frame's changes. */
  commit(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.shadows) this.shadows.instanceMatrix.needsUpdate = true;
    for (const a of this.pose) a.needsUpdate = true;
  }
}
