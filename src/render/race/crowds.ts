/**
 * Spectator crowds. At the start and finish: the shared people plan's gate stands
 * (city/people/gateStands.ts, one canonical density at every graphics quality: the
 * sim collides with these people, so every tier draws them all), rows lining the
 * sidewalks along the outer edge. Everywhere else on the route: the crowd of
 * every street meet (meetPlan.ts), packed against the cyan barrier and
 * thinning back among the parked cars. Never on the route. They are the
 * game's people (render/people/person.ts) at the crowd level of detail, in
 * street clothes from the shared wardrobe, some with a phone, a flag or a
 * glowstick: one InstancedMesh per batch of BATCH people along the stand (sorted along its axis, so each batch is a compact patch with its own frustum culling and level of detail), plus the far level drawn instead
 * beyond the quality's lodNear; sections past the draw distance are not drawn at all, and
 * the draw distance (and the meets' and market pens' density) follow the graphics quality.
 *
 * Far from the camera (CROWD_IMPOSTOR.distance, 40 to 90 m by quality) a person
 * is no longer a mesh but a camera-facing quad from a sprite sheet baked from
 * this very rig (people/impostors.ts): a third InstancedMesh per batch sharing
 * the instance buffers, the far level fading out and the quad in over a band
 * with complementary dithers, per person, so the switch does not pop. Where
 * there is no renderer to bake with the stands keep the far level to the end.
 *
 * Animation is all in the vertex shader: the person's pose is computed per
 * instance from one float ("excitement"), a phase and a style: idle sway, weight
 * shifting and a glance around (or arms crossed, hands in pockets or on hips,
 * weight on one leg, a dance bob; talking pairs taking turns; the front row of
 * a meet leaning on its rail), the head following the nearest car, clapping as
 * it rises (or pointing at the road), arms up waving and
 * jumping at the top, a phone held up filming or a flag waved overhead. Friends
 * (the plan's group phase, or the people of one cell in a render-only section) share a phase, so the stands cheer in
 * clusters. On top comes the shared dodge (people/motion.ts: the GLSL twin of the sim's `sidestep`, so a stand person
 * steps out of a car's way by what the sim moves them by) and the ragdoll of a person a car hit (`iHit`).
 * Hit people stay on the far level (never dithered into impostors) and the sprites discard them.
 * Meet crowds and market pens are behind rails the cars cannot reach: they have no sim identity, so no dodge
 * and no hits. The CPU only updates
 * that float: it rises when a racer passes close (speed weighted) and when a
 * cheer wave started at the gate (start, lap, finish) sweeps along the stands,
 * then decays. Everything is driven from car positions and race events, so
 * replays cheer exactly like the live race. The clock is the people clock (the race's interpolated
 * sim time), so the dodge and the falls agree with the sim. Vertex attributes: 12 of WebGL's 16 (the
 * rig's, the instance matrix, iData, iExcite and iHit; iData.w packs `prefer` as its sign and `1 + backRoom`
 * as its size, 0 = no dodge). Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { MeetPerson, MeetPlan } from './meetPlan';
import { peopleOf } from '../../city/people/people';
import type { WorldPerson } from '../../city/people/people';
import type { PeopleGate } from '../../city/people/gates';
import { Rng } from '../../sim/prng';
import type { PeopleState } from '../../sim/people';
import type { Quality } from '../../ui/settings';
import { WEAR, personGeometry, personMaterial, writeLook } from '../people/person';
import { IMPOSTOR_DITHER_GLSL, bakeImpostors, impostorMaterial, impostorQuad, nearestImpostorLook } from '../people/impostors';
import type { ImpostorPose, ImpostorSheet, ImpostorSpec } from '../people/impostors';
import { raceLook } from '../people/looks';
import { GESTURES_GLSL, talkCodes } from '../people/gestures';
import { BACK } from '../../city/people/placer';
import { FLING_MARGIN, PEOPLE_MAX_CARS, PEOPLE_MOTION_PARS, PeopleHits, carsNear, growBounds, hitSeed, makeCarsUniform, makeHitAttribute } from '../people/motion';

/** A car as the crowd sees it (interpolated sim pose). */
export interface CrowdCar {
  x: number;
  z: number;
  /** Heading (three.js yaw, rad): forward is (sin, cos). */
  yaw: number;
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

/**
 * Spectators per graphics quality: the market pens' density scale (the meets' is MEET_QUALITY's) and the distance (m)
 * inside which a batch draws the full person. The start / finish stands have no density or rows knob any more: they
 * are the shared plan's, the same at every tier, because the sim collides with them.
 */
export const CROWD_QUALITY: Record<Quality, { density: number; lodNear: number }> = {
  low: { density: 0.55, lodNear: 25 },
  medium: { density: 0.8, lodNear: 35 },
  high: { density: 1, lodNear: 45 },
};

/**
 * Impostors per graphics quality: the distance (m) where a person becomes a sprite, the width (m) of the band round
 * it where the far rig and the sprite dither into each other, and the sheet baked for it (people/impostors.ts: the
 * texture's edge and a cell in px, the looks by what they hold, frames per pose, view angles). Sheet memory with
 * mips: low 1.4 MB (512 px, 6 looks x 4 poses x 3 frames x 4 angles = 288 of 350 cells), medium 5.6 MB (1024 px,
 * 10 looks x 4 x 4 x 4 = 640 of 720 cells), high 22.4 MB (2048 px, 12 looks x 4 x 4 x 8 = 1536 of 1792 cells).
 */
export const CROWD_IMPOSTOR: Record<Quality, ImpostorSpec & { distance: number; fade: number }> = {
  low: { distance: 40, fade: 8, sheet: 512, cellW: 20, cellH: 36, plain: 3, phones: 1, flags: 1, sticks: 1, frames: 3, angles: 4 },
  medium: { distance: 60, fade: 10, sheet: 1024, cellW: 28, cellH: 50, plain: 6, phones: 2, flags: 1, sticks: 1, frames: 4, angles: 4 },
  high: { distance: 90, fade: 14, sheet: 2048, cellW: 36, cellH: 64, plain: 8, phones: 2, flags: 1, sticks: 1, frames: 4, angles: 8 },
};

/**
 * The poses a sheet bakes: the rig's excitement for each (idle, clapping, arms up waving, jumping) and the period
 * (s) of the motion that matters in it: the idle sway 2 pi / 1.1, the clap 2 pi / 9, the wave about 2 pi / 8.5.
 */
export const CROWD_IMPOSTOR_POSES: readonly ImpostorPose[] = [
  { excite: 0, period: 5.7 },
  { excite: 0.45, period: 0.7 },
  { excite: 1, period: 0.75 },
  { excite: 1.4, period: 0.75 },
];

export interface CrowdOptions {
  /** The street meets whose crowds become the sections (none in an open world). */
  meet?: MeetPlan;
  /** Sections further than this from the camera are not drawn (m). */
  drawDistance?: number;
  /** A batch nearer than this to the camera (m, from its edge) draws the full person, further the far level. */
  lodNear?: number;
  /** The renderer to bake the impostor sheet with; none (tests, the headless perf script) keeps the far rig out to the draw distance. */
  renderer?: THREE.WebGLRenderer;
  /** The quality's impostor distance, band and sheet; none draws no impostors. */
  impostor?: ImpostorSpec & { distance: number; fade: number };
  /** An already baked sheet instead of baking one (the headless LOD counts use a stand-in). */
  sheet?: ImpostorSheet | null;
  /** More sections that belong to the city rather than to a meet (the night market's pens, marketPlan.ts), drawn like a meet's. */
  sections?: readonly (readonly MeetPerson[])[];
}

export interface Crowds {
  group: THREE.Group;
  /** Audio stands; levels refresh in update(). */
  spots: CrowdSpot[];
  /** The impostor sheet the stands draw past the impostor distance (its memory is `sheet.bytes`), or null when they keep the far rig. */
  readonly sheet: ImpostorSheet | null;
  /** Number of spectators. */
  readonly count: number;
  /** Number of sections (stands away from the start / finish). */
  readonly sectionCount: number;
  readonly enabled: boolean;
  /** Hide the crowd (open world) or show it again. */
  setEnabled(on: boolean): void;
  /** Start a wave of excitement at a gate; strength 1 = cheer, 1.5 = finish frenzy. */
  cheer(at: 'start' | 'lap' | 'finish', strength?: number): void;
  /** Per frame: the people clock (s; the race's interpolated sim time), frame dt, racer poses, the listener (camera) for the audio levels, and in a race who the sim has hit. */
  update(time: number, dt: number, cars: readonly CrowdCar[], listenerX: number, listenerZ: number, people?: PeopleState): void;
  dispose(): void;
}

/** Friends share a phase to within this much of a cycle, so a group claps and bobs together (the stands out of step with each other). */
const GROUP_JITTER = 0.05;
/** Render-only sections group the people standing in one cell this wide (m). */
const GROUP_CELL = 2.2;
/** A section person's group phase from its cell's id (a hash: no stream draws, so the looks stay as they were). */
const cellPhase = (cell: number): number => {
  const v = Math.sin(cell * 12.9898) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Who stands in the front row at a rail: nobody within 1.3 m ahead of them (along their facing) and 0.65 m either
 * side. A section's people face the barrier or rail of their meet or pen, so the row nearest it leans on it.
 */
function frontRow(people: readonly StandPerson[]): boolean[] {
  return people.map((p, i) => {
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    for (let j = 0; j < people.length; j++) {
      if (j === i) continue;
      const dx = people[j].x - p.x;
      const dz = people[j].z - p.z;
      const ahead = dx * fx + dz * fz;
      if (ahead > 0.2 && ahead < 1.3 && Math.abs(dx * fz - dz * fx) < 0.65) return false;
    }
    return true;
  });
}

/** People per batch: a stand is cut into runs of this many along its axis, each culled and level-of-detailed on its own. */
const BATCH = 48;
/** A batch switches level only this far (m) past lodNear, so people do not pop at the line. */
const LOD_HYST = 4;
/** A person is a point plus its body and a step away from cars: the slack (m) added to a batch's bounds before skipping a level. */
const IMPOSTOR_MARGIN = 3;
/** A meet with fewer people than this gets no stand. */
const SECTION_MIN = 6;
/** A racer this close excites people (m). */
const CHEER_RADIUS = 17;
/** Cheer waves travel along the stands at this speed (m/s). */
const WAVE_SPEED = 26;

// ---------------------------------------------------------------------------
// The person's pose from excitement, in the shader
// ---------------------------------------------------------------------------

const CROWD_PARS = /* glsl */ `
uniform float uTime;
attribute vec4 iData;
attribute float iExcite;
vec3 crowdHue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
${GESTURES_GLSL}`;

/**
 * Sets the pose's four vec4s (person.ts, PersonShader) from excitement, phase and what the hand holds, in four
 * parts so the sprite bake can swap the two that read per instance state it has none of.
 *
 * Who does what is read off the instance. `iData.x` is the phase (the plan's group phase plus a small jitter, so a
 * group of friends moves together); `iData.y` the style, cut into two independent bands: `cBand` picks the idle
 * (plain sway, arms crossed, hands in pockets, hands on hips, weight on one leg with a hip pop, a dance bob to a
 * 128 bpm beat; headphones always bob) and `cBand2` the phone's grip (one hand or two) and who points at the road
 * instead of clapping; `iData.z` the talking code (a voice 1 or 2 of a group, the side of the nearest groupmate)
 * and the rail bit (a meet's front row, leaning on the barrier). As excitement rises the idles fade into
 * clapping (pointers point), then everyone cheers: arms up, jumping, flags, phones held high.
 */
const CROWD_HEAD = /* glsl */ `
  float cT = uTime;
  float cPh = iData.x * 6.2832;
  float cStyle = iData.y;
  int cWorn = int(lookB.w + 0.5);
`;

/** The live per instance state: the talking code, the bands and whether the headphones play. */
const CROWD_STATE = /* glsl */ `
  int cCode = int(iData.z + 0.5);
  float cBand = fract(cStyle * 5.37 + 0.11);
  float cBand2 = fract(cStyle * 3.91 + 0.43);
  bool cHeadphones = (cWorn & ${WEAR.headphones}) == ${WEAR.headphones};
`;

/** The nearest of the four cars: the head turns toward it within ~14 m (the idlers' maths, in the person's frame). */
const CROWD_CARS = /* glsl */ `
  vec2 cAt = instanceMatrix[3].xz;
  vec2 cFwd = normalize(instanceMatrix[2].xz + vec2(1e-5));
  vec2 cLeft = vec2(cFwd.y, -cFwd.x);
  float cBestD = 1e9;
  vec2 cTo = cFwd;
  for (int i = 0; i < ${PEOPLE_MAX_CARS}; i++) {
    vec2 d = uCars[i].xy - cAt;
    float l = length(d);
    if (l < cBestD) { cBestD = l; cTo = d; }
  }
  float cLook = 1.0 - smoothstep(9.0, 14.0, cBestD);
  float cCarYaw = clamp(atan(dot(cTo, cLeft), dot(cTo, cFwd)), -1.2, 1.2);
`;

/** The bake's stand-ins: the plain idle, no talk, no rail, no headphones, no car. */
const CROWD_STATE_BAKE = /* glsl */ `
  int cCode = 0;
  float cBand = 0.0;
  float cBand2 = 0.0;
  bool cHeadphones = false;
`;
const CROWD_CARS_BAKE = /* glsl */ `
  float cLook = 0.0;
  float cCarYaw = 0.0;
`;

const CROWD_BODY = /* glsl */ `
  float cE = clamp(iExcite, 0.0, 1.6);
  float cEx = smoothstep(0.08, 0.7, cE);
  float cCalm = 1.0 - cEx;
  int cRole = cCode & 3;
  float cSide = (cCode & 4) != 0 ? 1.0 : -1.0;
  bool cRail = (cCode & 8) != 0;
  bool cPhone = (cWorn & ${WEAR.phone}) != 0;
  bool cWaving = (cWorn & ${WEAR.flag | WEAR.glowstick}) != 0;
  bool cCup = (cWorn & ${WEAR.cup}) != 0;
  bool cItem = cPhone || cWaving;
  // The idle bands: plain below 0.3, then crossed arms, pockets, hands on hips, one leg, a dance.
  float bX = step(0.3, cBand) - step(0.46, cBand);
  float bP = step(0.46, cBand) - step(0.6, cBand);
  float bH = step(0.6, cBand) - step(0.72, cBand);
  float bL = step(0.72, cBand) - step(0.86, cBand);
  float rail = cRail ? cCalm : 0.0;
  float talk = cRole > 0 ? cCalm : 0.0;
  float spk = gSpeak(cT, cPh, cRole);
  float dance = (cHeadphones ? 1.0 : step(0.86, cBand)) * (cRole > 0 ? 0.0 : 1.0) * (1.0 - rail);
  float danceW = dance * cCalm;
  float legS = fract(cStyle * 9.1) > 0.5 ? 1.0 : -1.0;
  float beat = cT * 13.404 + cPh;
  float bob = 0.5 + 0.5 * cos(beat);
  float groove = sin(beat * 0.5);
  float pop = pow(max(0.0, sin(cT * 1.05 + cPh)), 8.0);
  // Hips: a small idle bounce and sway, the dance's dip on every beat; the excited jump.
  float hop = (0.02 + 0.015 * cStyle) * abs(sin(cT * 2.0 + cPh)) * (1.0 - cEx)
    + 0.3 * smoothstep(0.45, 1.4, cE) * (0.6 + 0.6 * cStyle) * pow(max(0.0, sin(cT * 6.8 + cPh * 2.0)), 2.0);
  float sway = 0.035 * sin(cT * 1.1 + cPh) + 0.09 * cEx * sin(cT * 4.6 + cPh) + cCalm * (0.06 * groove * dance + 0.06 * legS * bL * (1.0 + pop));
  float shift = sin(cT * 0.9 + cPh) * cCalm;
  float hipY = 0.965 + hop - 0.04 * bob * danceW;
  // Legs: weight shifting side to side when idle, one leg taking it (the other knee bent) in its band, a bounce on the beat, knees tucked a little in the jump.
  float kneeL = 0.1 + 0.06 * shift + hop * 0.9;
  float kneeR = 0.1 - 0.06 * shift + hop * 0.9;
  kneeL = mix(kneeL, legS > 0.0 ? 0.42 : 0.04, bL * cCalm) + 0.2 * bob * danceW;
  kneeR = mix(kneeR, legS > 0.0 ? 0.04 : 0.42, bL * cCalm) + 0.2 * bob * danceW;
  // Arms at rest: hanging with a little swing, or a posture of the band; at the rail, forearms on it; a voice in a talking group gestures on its half of the cycle; dancers pump to the beat.
  float wave = sin(cT * (8.0 + 3.0 * cStyle) + cPh);
  float pump = cStyle > 0.6 ? 0.5 * max(0.0, sin(cT * 9.0 + cPh)) : 0.0;
  vec3 iL = vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh + 1.0), 0.1, 0.25);
  vec3 iR = vec3(0.07 + 0.04 * sin(cT * 1.6 + cPh - 1.0), 0.1, 0.25);
  iL = mix(iL, G_CROSS_L, bX);
  iR = mix(iR, G_CROSS_R, bX);
  iL = mix(iL, G_POCKET, bP);
  iR = mix(iR, G_POCKET, bP);
  iL = mix(iL, G_HIPS, bH);
  iR = mix(iR, G_HIPS, bH);
  iL = mix(iL, G_RAIL, rail);
  iR = mix(iR, G_RAIL, rail);
  iL = mix(iL, vec3(0.95 + 0.35 * sin(cT * 3.3 + cPh * 2.0), 0.3, 1.35 + 0.3 * sin(cT * 5.1 + cPh)), talk * spk);
  iL = mix(iL, vec3(0.75 + 0.4 * groove, 0.25, 1.3), dance);
  iR = mix(iR, vec3(0.75 - 0.4 * groove, 0.25, 1.3), dance);
  // Clapping as the excitement rises, up and waving at the top.
  float clap = smoothstep(0.25, 0.55, cE) * (1.0 - smoothstep(0.7, 1.0, cE));
  // A share of the crowd points at the road instead (one arm straight out and up, the other hand on the hip) until the cheer takes them.
  float pointW = cItem ? 0.0 : step(0.72, cBand2) * smoothstep(0.2, 0.4, cE) * (1.0 - smoothstep(0.9, 1.15, cE));
  float clapIn = 0.08 + 0.3 * max(0.0, sin(cT * 9.0 + cPh));
  vec3 aL = mix(mix(iL, vec3(2.45 + 0.35 * sin(cT * (8.0 + 3.0 * cStyle) + cPh + 1.3) - pump, 0.35, 0.45), cEx), vec3(1.0, clapIn, 1.55), clap * (1.0 - pointW));
  vec3 aR = mix(mix(iR, vec3(2.45 + 0.35 * wave - pump, 0.35, 0.45), cEx), vec3(1.0, clapIn, 1.55), clap * (1.0 - pointW));
  aL = mix(aL, G_HIPS, pointW);
  aR = mix(aR, G_POINT + vec3(0.08 * sin(cT * 2.0 + cPh), 0.0, 0.0), pointW);
  // A phone held up toward the road, filming, higher as the crowd rises: in one hand, or by its band in two (landscape). A flag or glowstick is waved overhead the whole time.
  if (cPhone) {
    float land = step(0.5, cBand2);
    aR = vec3(mix(1.45 - 0.1 * land, 1.95 - 0.15 * land, cEx) + 0.12 * cEx * wave, 0.0, 1.05 - 0.3 * cEx - 0.25 * land);
    aL = mix(aL, vec3(mix(1.3, 1.8, cEx), -0.12, 1.5), land);
  }
  // Two fixed rates crossfaded by excitement: a rate scaled by it would multiply the absolute time, so every change in excitement would race the phase (flags whipping round).
  if (cWaving) aR = vec3(2.4 + (0.3 + 0.25 * cEx) * mix(sin(cT * 2.2 + cPh), sin(cT * 5.5 + cPh), cEx), 0.3, 0.2);
  // A sip from the cup every ~9 s.
  float sip = cCup && !cItem ? gPulse(cT, 9.0, cPh, 2.6, 0.9) * cCalm : 0.0;
  aR = mix(aR, G_SIP, sip);
  // The head: a look around when idle, toward the person they are talking to, down at a phone, a nod on the beat or at a word, at the road when pointing, up at the arms when cheering; then at the nearest car going by.
  float headYaw = mix(0.3 * sin(cT * 0.5 + cPh * 1.7) * cCalm, cSide * (0.35 + 0.3 * spk), talk);
  headYaw = mix(headYaw, cCarYaw, cLook);
  float headPitch = 0.04 - 0.14 * cEx + 0.12 * sin(beat) * danceW + 0.06 * sin(cT * 2.3 + cPh) * talk * spk + 0.1 * rail - 0.2 * sip;
  vec4 p0 = vec4(hipY, 0.04 + 0.08 * cEx * sin(cT * 4.6 + cPh) + 0.28 * rail + 0.05 * sin(beat) * danceW - 0.03 * bP * cCalm, sway, 0.1 * cSide * talk);
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

const CROWD_POSE = CROWD_HEAD + CROWD_STATE + CROWD_CARS + CROWD_BODY;

/**
 * After the pose (the scene's material only, the sprite bake has none): a hit person falls from where the sim hit them (`pmRagdoll`; `PeopleHits` has moved their translation there),
 * a standing one with a dodge ahead of them steps by what the sim moves them by (`pmSidestep`, the wall behind is
 * -facing, iData.w carries prefer and the room, 0 = a render-only person who does not dodge). `pRoot` is the placement in the instance frame.
 */
const CROWD_MOTION = /* glsl */ `
  vec2 mAt = instanceMatrix[3].xz;
  vec2 mFwd = normalize(instanceMatrix[2].xz + vec2(1e-5));
  mat4 pRoot = mat4(1.0);
  if (iHit.x >= 0.0 && cT >= iHit.x) {
    vec2 mDisp;
    mat4 mBody = pmRagdoll(cT - iHit.x, iHit.yz, iHit.w, p0.x, mDisp, p0, p1, p2, p3);
    pRoot = rigT(pmLocal(instanceMatrix, vec3(mDisp.x, 0.0, mDisp.y))) * mBody;
  } else if (iData.w != 0.0) {
    vec2 mOff = pmSidestep(mAt, -mFwd, abs(iData.w) - 1.0, iData.w < 0.0 ? -1.0 : 1.0);
    if (dot(mOff, mOff) > 0.0025) {
      pRoot = rigT(pmLocal(instanceMatrix, vec3(mOff.x, 0.0, mOff.y)));
      vec2 mLeft = vec2(mFwd.y, -mFwd.x);
      float mBestD = 1e9;
      vec2 mTo = mFwd;
      for (int i = 0; i < ${PEOPLE_MAX_CARS}; i++) {
        vec2 d = uCars[i].xy - mAt;
        float l = length(d);
        if (l < mBestD) { mBestD = l; mTo = d; }
      }
      pmStepPose(vec2(dot(mOff, mLeft), dot(mOff, mFwd)), clamp(atan(dot(mTo, mLeft), dot(mTo, mFwd)), -1.2, 1.2), p0, p1, p2, p3);
    }
  }
`;

/** After the pose: fade the tiny emitters with distance so they never sparkle in the bloom. */
const CROWD_POST = /* glsl */ `
  vec3 cWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vPersonGlow *= clamp(28.0 / max(distance(cWorld, cameraPosition), 1.0), 0.15, 1.0);
`;

/** The crowd's pose with the clock read from the instance (iData.z) instead of the uniform, and the plain idle (no group, no rail, no car): the sheet bakes one frame per instance. */
const BAKE_POSE = CROWD_HEAD.replace('float cT = uTime;', 'float cT = iData.z;') + CROWD_STATE_BAKE + CROWD_CARS_BAKE + CROWD_BODY;

/** The far level that fades into impostors: the person's distance to the camera, as a 0..1 fade (the impostor's own, people/impostors.ts). */
const LITE_PARS = /* glsl */ `
uniform vec2 uImp;
varying float vImpFade;
`;
const LITE_POST = /* glsl */ `
  float cImpDist = distance((modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz, cameraPosition);
  // A hit person stays on this level whatever the distance: the sprites cannot fall.
  vImpFade = iHit.x >= 0.0 ? 0.0 : smoothstep(uImp.x - uImp.y, uImp.x + uImp.y, cImpDist);
`;

/** A batch's material: the shared clock and the batch's own nearest cars (people/motion.ts says why per batch); `fade` is the far level's, which dithers out where the impostors dither in (uImp: distance and half band, m). */
function crowdMaterial(uniforms: { uTime: { value: number }; uCars: { value: THREE.Vector4[] } }, fade?: { value: THREE.Vector2 }): THREE.MeshStandardMaterial {
  const pars = (fade ? CROWD_PARS + LITE_PARS : CROWD_PARS) + PEOPLE_MOTION_PARS();
  const mat = personMaterial({ pars, pose: CROWD_POSE + CROWD_MOTION, post: fade ? CROWD_POST + LITE_POST : CROWD_POST, root: 'pRoot', key: fade ? 'crowd-fade' : 'crowd' });
  const compile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCars = uniforms.uCars;
    compile(shader, renderer);
    if (fade) {
      shader.uniforms.uImp = fade;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vImpFade;\n${IMPOSTOR_DITHER_GLSL}`)
        .replace('#include <color_fragment>', '#include <color_fragment>\nif (vImpFade > impNoise(gl_FragCoord.xy)) discard;');
    }
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Stands
// ---------------------------------------------------------------------------

/** One person of a stand: where, and for gate stands the plan's person (the dodge, the look and the hits come from it). */
interface StandPerson {
  x: number;
  y: number;
  z: number;
  /** Facing (three.js yaw): local +z toward the road. */
  yaw: number;
  /** Signed route distance from the gate line (0 for sections). */
  ds: number;
  /** Audio stand of the gate: 0 left of the road, 1 right (sections have one). */
  side: number;
  /** The plan's person; none for a section's (render-only people behind rails). */
  plan?: WorldPerson;
}

/** A run of a stand's people drawn as one InstancedMesh, with the far stand-in sharing its instance data. */
interface Batch {
  mesh: THREE.InstancedMesh;
  lite: THREE.InstancedMesh;
  /** The sprite level past the impostor distance, or null without a sheet. */
  imp: THREE.InstancedMesh | null;
  excite: THREE.InstancedBufferAttribute;
  /** This batch's own nearest cars (the uniform its materials read). */
  cars: { value: THREE.Vector4[] };
  cx: number;
  cz: number;
  radius: number;
  /** Whether the full person was drawn last update (hysteresis). */
  near: boolean;
  /** Whether any person of the batch is hit (they stay on the far level, and the bounds grow for the flung). */
  hit: boolean;
}

interface Stand {
  /** The gate this stand cheers for, or null for a section (closure or corner). */
  gate: PeopleGate | null;
  batches: Batch[];
  /** Per-person excitement for the whole stand; each batch's attribute is a view of a run of it. */
  excite: Float32Array;
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

export function buildCrowds(world: World, opts: CrowdOptions = {}): Crowds {
  const group = new THREE.Group();
  group.name = 'crowds';
  const plan = peopleOf(world);
  const drawDistance = opts.drawDistance ?? 260;
  const lodNear = opts.lodNear ?? CROWD_QUALITY.high.lodNear;
  const rng = new Rng((world.seed ^ 0xc40d) >>> 0);
  const geo = personGeometry('crowd');
  const liteGeo = personGeometry('far');
  const clock = { uTime: { value: 0 } };
  const hits = new PeopleHits();
  // The impostor sheet: baked once per page from the rig (or handed in); none keeps the far level to the draw distance.
  const spec = opts.impostor;
  const sheet = spec ? (opts.sheet !== undefined ? opts.sheet : opts.renderer ? bakeImpostors(opts.renderer, spec, CROWD_IMPOSTOR_POSES, { pars: CROWD_PARS, pose: BAKE_POSE, key: 'crowd' }) : null) : null;
  const band = { value: new THREE.Vector2(spec?.distance ?? 1e6, (spec?.fade ?? 0) / 2) };
  const impMat = sheet ? impostorMaterial(sheet, { uTime: clock.uTime, uImp: band }) : null;
  if (impMat) {
    // The sprites cannot fall: a hit person's quad is clipped away (the far rig draws them), its own program key since the shader differs.
    const compile = impMat.onBeforeCompile;
    impMat.onBeforeCompile = (shader, renderer) => {
      compile(shader, renderer);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 iHit;')
        .replace('#include <fog_vertex>', 'if (iHit.x >= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);\n#include <fog_vertex>');
    };
    impMat.customProgramCacheKey = () => 'person-impostor-hit';
  }
  const quad = sheet ? impostorQuad() : null;
  const stands: Stand[] = [];
  const spots: CrowdSpot[] = [];
  const dummy = new THREE.Object3D();
  const materials: THREE.Material[] = [];
  let total = 0;

  const addStand = (gate: PeopleGate | null, input: StandPerson[]) => {
    const n = input.length;
    // Sort along the stand's axis (route distance for gates, the section's first to last direction) so every batch is a compact patch.
    const ax = input[0].x;
    const az = input[0].z;
    const ux = input[n - 1].x - ax;
    const uz = input[n - 1].z - az;
    const along = (p: StandPerson) => (gate ? p.ds : (p.x - ax) * ux + (p.z - az) * uz);
    const people = input.slice().sort((p, q) => along(p) - along(q));
    // Groups: the plan's friends share their group phase; a render-only section's people are grouped by the 2.2 m cell they stand in (with a phase hashed from it). The talking pairs and the front row at the rail come from the groups and the rows.
    const cellOf = (p: StandPerson) => Math.floor(p.x / GROUP_CELL) * 4099 + Math.floor(p.z / GROUP_CELL);
    const groupKey = (p: StandPerson) => (p.plan ? p.plan.groupPhase : cellOf(p));
    const talk = talkCodes(people.map((p) => ({ key: groupKey(p), x: p.x, z: p.z, yaw: p.yaw })));
    const front = gate ? null : frontRow(people);
    const lookA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const lookB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const lookIdx = new Float32Array(n);
    const data = new Float32Array(n * 4);
    const hitAll = makeHitAttribute(people.map((p) => (p.plan ? hitSeed(p.plan.lookSeed) : 0.5)));
    const matrices = new Float32Array(n * 16);
    const excite = new Float32Array(n);
    const x = new Float32Array(n);
    const z = new Float32Array(n);
    const ds = new Float32Array(n);
    const spot = new Uint8Array(n);
    let cx = 0;
    let cz = 0;
    // Audio stand ends: gates per side, along the route; sections along their first wall's direction.
    const sides = gate ? 2 : 1;
    const ends = Array.from({ length: sides }, () => ({ lo: Infinity, hi: -Infinity, a: [0, 0], b: [0, 0] }));
    people.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      // Gate stands dress and scale from their plan person's own stream (the plan's scale is its first draw, skipped here); sections share the stand's.
      const pr = p.plan ? new Rng(p.plan.lookSeed) : rng;
      if (p.plan) pr.next();
      const s = p.plan ? p.plan.scale : rng.range(0.9, 1.08);
      dummy.scale.set(s * pr.range(0.92, 1.15), s, s);
      dummy.updateMatrix();
      dummy.matrix.toArray(matrices, i * 16);
      const look = raceLook(() => pr.next());
      const r = pr.next();
      // Items: about 22% phones, 10% flags, 10% glowsticks.
      look.wear |= r < 0.22 ? WEAR.phone : r < 0.32 ? WEAR.flag : r < 0.42 ? WEAR.glowstick : 0;
      writeLook(lookA, lookB, i, look);
      if (sheet) lookIdx[i] = nearestImpostorLook(sheet.looks, look);
      // Phase and style (how big a mover) for the shader's pose; w the dodge's prefer and room (0 = none).
      // z: the talking code (voice 1 or 2, 4 = the nearest groupmate on the left) and 8 = the front row at a rail.
      const code = talk[i] | (front?.[i] ? 8 : 0);
      if (p.plan) data.set([(p.plan.groupPhase + GROUP_JITTER * pr.next()) % 1, pr.next(), code, p.plan.prefer * (1 + p.plan.backRoom)], i * 4);
      else data.set([(cellPhase(cellOf(p)) + GROUP_JITTER * rng.next()) % 1, rng.next(), code, 0], i * 4);
      x[i] = p.x;
      z[i] = p.z;
      ds[i] = p.ds;
      spot[i] = p.side;
      const e = ends[p.side];
      const t = along(p);
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
    cx /= n;
    cz /= n;
    let radius = 0;
    for (let i = 0; i < n; i++) radius = Math.max(radius, Math.hypot(x[i] - cx, z[i] - cz));
    // Batches: each gets its own meshes whose instance attributes are views of the stand's arrays, so the update writes one array.
    const batches: Batch[] = [];
    for (let s0 = 0; s0 < n; s0 += BATCH) {
      const m = Math.min(BATCH, n - s0);
      const view = (arr: Float32Array, size: number) => new THREE.InstancedBufferAttribute(arr.subarray(s0 * size, (s0 + m) * size), size);
      const bExcite = view(excite, 1).setUsage(THREE.DynamicDrawUsage);
      const bA = view(lookA.array as Float32Array, 4);
      const bB = view(lookB.array as Float32Array, 4);
      const bData = view(data, 4);
      const bHit = view(hitAll.array as Float32Array, 4).setUsage(THREE.DynamicDrawUsage);
      // This batch's own materials and cars: a uniform written per batch only reaches a draw when the material differs from the last draw's.
      const cars = makeCarsUniform();
      const bMat = crowdMaterial({ uTime: clock.uTime, uCars: cars }, undefined);
      const bLite = sheet ? crowdMaterial({ uTime: clock.uTime, uCars: cars }, band) : bMat;
      materials.push(bMat);
      if (bLite !== bMat) materials.push(bLite);
      // Instance attributes live on a per batch geometry that shares the person's vertex buffers.
      const g = new THREE.BufferGeometry();
      for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
      g.setIndex(geo.index);
      g.boundingSphere = geo.boundingSphere!.clone();
      g.setAttribute('lookA', bA);
      g.setAttribute('lookB', bB);
      g.setAttribute('iData', bData);
      g.setAttribute('iExcite', bExcite);
      g.setAttribute('iHit', bHit);
      const mesh = new THREE.InstancedMesh(g, bMat, m);
      mesh.name = gate ? 'crowd' : 'crowdSection';
      mesh.instanceMatrix = view(matrices, 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      // The stand-in shares the instance buffers, so excitement and placement stay in step.
      const gl = new THREE.BufferGeometry();
      for (const name of Object.keys(liteGeo.attributes)) gl.setAttribute(name, liteGeo.attributes[name]);
      gl.setIndex(liteGeo.index);
      gl.boundingSphere = liteGeo.boundingSphere!.clone();
      gl.setAttribute('lookA', bA);
      gl.setAttribute('lookB', bB);
      gl.setAttribute('iData', bData);
      gl.setAttribute('iExcite', bExcite);
      gl.setAttribute('iHit', bHit);
      const lite = new THREE.InstancedMesh(gl, bLite, m);
      lite.name = mesh.name + 'Far';
      lite.instanceMatrix = mesh.instanceMatrix;
      lite.boundingSphere = mesh.boundingSphere?.clone() ?? null;
      lite.visible = false;
      group.add(lite);
      // The impostor shares the instance buffers too; its look index is its own.
      let imp: THREE.InstancedMesh | null = null;
      if (quad && impMat) {
        const gi = new THREE.BufferGeometry();
        gi.setAttribute('position', quad.attributes.position);
        gi.setIndex(quad.index);
        gi.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.1, 0), 2.1);
        gi.setAttribute('iData', bData);
        gi.setAttribute('iExcite', bExcite);
        gi.setAttribute('iHit', bHit);
        gi.setAttribute('iLook', view(lookIdx, 1));
        imp = new THREE.InstancedMesh(gi, impMat, m);
        imp.name = mesh.name + 'Impostor';
        imp.instanceMatrix = mesh.instanceMatrix;
        imp.boundingSphere = mesh.boundingSphere?.clone() ?? null;
        imp.visible = false;
        group.add(imp);
      }
      let bx = 0;
      let bz = 0;
      for (let i = s0; i < s0 + m; i++) {
        bx += x[i];
        bz += z[i];
      }
      bx /= m;
      bz /= m;
      let br = 0;
      for (let i = s0; i < s0 + m; i++) br = Math.max(br, Math.hypot(x[i] - bx, z[i] - bz));
      const batch: Batch = { mesh, lite, imp, excite: bExcite, cars, cx: bx, cz: bz, radius: br, near: false, hit: false };
      batches.push(batch);
      for (let i = s0; i < s0 + m; i++) {
        const plan = people[i].plan;
        if (!plan) continue;
        hits.bind(
          plan.id,
          bHit,
          i - s0,
          (any) => {
            if (any === batch.hit) return;
            batch.hit = any;
            growBounds(imp ? [mesh, lite, imp] : [mesh, lite], any ? FLING_MARGIN : -FLING_MARGIN);
          },
          { matrix: mesh.instanceMatrix },
        );
      }
    }
    const spot0 = spots.length;
    for (const e of ends) {
      // A side without people still gets a (silent) spot so indices stay fixed.
      if (e.lo > e.hi) e.a = e.b = [cx, cz];
      spots.push({ ax: e.a[0], az: e.a[1], bx: e.b[0], bz: e.b[1], level: 0, kind: gate ? 'gate' : 'section' });
    }
    stands.push({ gate, batches, excite, x, z, ds, spot, cx, cz, radius, waves: [], maxE: 0, spot0 });
    total += n;
  };

  // The gate stands are the shared plan's (one canonical density), one stand per gate; the meets' and the market pens' crowds are render-only.
  plan.gates.forEach((gate, gi) => {
    const people: StandPerson[] = [];
    for (const p of plan.people) if (p.gate && p.gate.gate === gi) people.push({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, ds: p.gate.ds, side: p.gate.side, plan: p });
    if (people.length) addStand(gate, people);
  });
  const meetZones = world.openWorld ? [] : (opts.meet?.zones ?? []);
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
    const first = stands[0].batches[0];
    first.mesh.onBeforeRender = first.lite.onBeforeRender = () => {
      if (externalAt < 0 || performance.now() - externalAt > 500) clock.uTime.value = performance.now() / 1000;
    };
    if (first.imp) first.imp.onBeforeRender = first.lite.onBeforeRender;
  }

  let enabled = true;
  let now = 0;
  const levelSum = new Float32Array(spots.length);
  const levelW = new Float32Array(spots.length);

  function standFor(at: 'start' | 'lap' | 'finish'): Stand | undefined {
    if (at === 'lap') return stands.find((c) => c.gate?.kind === 'startFinish');
    return stands.find((c) => c.gate && (at === 'finish' ? c.gate.kind !== 'start' : c.gate.kind !== 'finish'));
  }

  function update(time: number, dt: number, cars: readonly CrowdCar[], lx: number, lz: number, state?: PeopleState): void {
    externalAt = performance.now();
    now = time;
    clock.uTime.value = time;
    hits.update(state);
    // The band is read from the table each update, so tuning it in a dev console takes effect at once.
    if (spec) band.value.set(spec.distance, spec.fade / 2);
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
      // beyond lodNear the few-box stand-in is drawn instead, decided per batch with a little hysteresis.
      const camD = Math.hypot(lx - cr.cx, lz - cr.cz) - cr.radius;
      for (const b of cr.batches) {
        const bd = Math.hypot(lx - b.cx, lz - b.cz) - b.radius;
        const shown = !!cr.gate || bd < drawDistance;
        b.near = bd < lodNear + (b.near ? LOD_HYST : -LOD_HYST);
        if (shown) carsNear(cars, lx, lz, b.cx, b.cz, b.radius, b.cars.value);
        b.mesh.visible = shown && b.near;
        if (b.imp && spec) {
          // The far level fades out and the sprite in per person over distance +- fade / 2 (the shaders); a batch draws each only while some of its people can be inside its range, and the fade needs no hysteresis.
          const dc = bd + b.radius;
          b.lite.visible = shown && !b.near && (b.hit || dc - b.radius - IMPOSTOR_MARGIN < spec.distance + spec.fade / 2);
          b.imp.visible = shown && dc + b.radius + IMPOSTOR_MARGIN > spec.distance - spec.fade / 2;
        } else b.lite.visible = shown && !b.near;
      }
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
      const e = cr.excite;
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
      for (const b of cr.batches) b.excite.needsUpdate = true;
    }
    for (let i = 0; i < spots.length; i++) spots[i].level = levelW[i] > 1e-6 ? levelSum[i] / levelW[i] : 0;
  }

  return {
    group,
    spots,
    sheet,
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
        for (const b of c.batches) {
          b.mesh.geometry.dispose();
          b.mesh.dispose();
          b.lite.geometry.dispose();
          b.lite.dispose();
          if (b.imp) {
            b.imp.geometry.dispose();
            b.imp.dispose();
          }
        }
      }
      geo.dispose();
      liteGeo.dispose();
      for (const m of materials) m.dispose();
      impMat?.dispose();
      quad?.dispose();
      // The sheet's texture belongs to the page (people/impostors.ts caches it per renderer): later scenes reuse it.
    },
  };
}
