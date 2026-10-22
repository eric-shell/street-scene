/**
 * Race cameras. Chase cameras follow a smoothed point behind the car, pull
 * back and widen FOV under nitrous, and never go through buildings: the line
 * from the car to the camera is tested against the static wall segments and
 * the camera is pushed in front of any hit. A mouse drag orbits the chase
 * cameras around the car (and turns the head in the bumper and hood views);
 * after letting go the view eases back behind the car once it is moving
 * (ORBIT). The chase cameras also drift back a little with each upshift
 * (gearPullback, eased at gearEase), so climbing through the box reads as the
 * car pulling away from the viewer. Two shake layers ride on every follow camera: a heavy one for wall
 * and car crashes and sudden stops (crash()), a light one for knocking over
 * street furniture (knock()), plus a fine rumble on cobbles (rumble(), fed
 * each frame) and a buzz under nitrous that grows with the stage burning,
 * as do the nitrous FOV kick and pull back (update()'s `nitro`). Each trauma layer decays linearly and is shown
 * squared through smooth noise as sway, bob and roll, so it is the same at
 * any frame rate and small hits stay subtle. Render only.
 *
 * Every number lives in the CAMERA table (live, mutated by the camera debug
 * panel) with CAMERA_DEFAULTS as the stock values and CAMERA_PARAM_META as the
 * slider ranges and tooltips. The intro/outro sections are read by
 * cinematics.ts and the session.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { CarPose } from '../car/carView';
import { clampCeiling } from './ceilings';
import { NITRO_STAGES } from '../../sim/tuning';

export const CAMERA_MODES = ['chase', 'close', 'bumper', 'hood'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

/**
 * Mouse orbit: radians per dragged pixel, the elevation range on top of the
 * camera's own (rad), how long the view holds after release (s), how fast it
 * eases back (1/s), and the speed (m/s) below which it stays where you left it.
 */
export const ORBIT = { yawPerPx: 0.006, pitchPerPx: 0.004, pitchMin: -0.25, pitchMax: 1.1, hold: 1.4, returnRate: 2.2, stillSpeed: 3 } as const;

export interface ChaseParams {
  dist: number;
  height: number;
  lookHeight: number;
  lookAhead: number;
  speedPullback: number;
  speedPullbackMax: number;
  nitroPullback: number;
  /** Extra distance in top gear (m); each gear above first adds its share, none in reverse. */
  gearPullback: number;
  fov: number;
  speedFovGain: number;
  speedFovMax: number;
  nitroFov: number;
  followStiffness: number;
  lookStiffness: number;
  yawStiffness: number;
  driftSwing: number;
}

export interface CockpitParams {
  forward: number;
  height: number;
  lookDistance: number;
  lookDrop: number;
  fov: number;
  speedFovGain: number;
  speedFovMax: number;
  nitroFov: number;
  rollFollow: number;
}

export interface CameraParams {
  chase: ChaseParams;
  close: ChaseParams;
  bumper: CockpitParams;
  hood: CockpitParams;
  common: {
    fovStiffness: number;
    driftSwingMinSpeed: number;
    /** How fast the gear pull back eases to a new gear (1/s): slow, so a shift glides rather than jumps. */
    gearEase: number;
    heavyShake: number;
    heavyRoll: number;
    heavyDecay: number;
    lightShake: number;
    lightRoll: number;
    lightDecay: number;
    /** Cobble rumble: a fine, fast shake while rolling on cobbles, growing with speed between the two speeds (m/s), eased at rumbleEase (1/s). */
    rumbleShake: number;
    rumbleRoll: number;
    rumbleMinSpeed: number;
    rumbleFullSpeed: number;
    rumbleEase: number;
    /** Each nitrous stage above the first adds this share of the nitrous FOV kick and pull back. */
    nitroStageGain: number;
    /** Nitrous buzz: sway and bob (m) and roll (deg) at the top stage, a share of it per stage below, eased at nitroShakeEase (1/s). */
    nitroShake: number;
    nitroRoll: number;
    nitroShakeEase: number;
    crashMin: number;
    crashFull: number;
    slowdownMin: number;
    slowdownFull: number;
    wallMinFraction: number;
    wallMargin: number;
    wallLift: number;
    groundClearance: number;
  };
  /** Race start: a fly-in from ahead of the grid that lands on the chase camera at GO. */
  intro: {
    preRoll: number;
    aheadDist: number;
    startHeight: number;
    startSide: number;
    midHeight: number;
    midSide: number;
    startFov: number;
    lookHeight: number;
    lookAhead: number;
    landPortion: number;
    ease: number;
  };
  /** Finish: chase camera swings around to a low, wide hero shot in front of the car. */
  outro: {
    resultsDelay: number;
    holdTime: number;
    swingTime: number;
    heroRadius: number;
    heroHeight: number;
    heroAngle: number;
    heroLookHeight: number;
    heroFov: number;
    heroRoll: number;
    orbitSpeed: number;
    yawSmoothing: number;
    groundMin: number;
  };
}

export const CAMERA_DEFAULTS: CameraParams = {
  chase: {
    dist: 5.8,
    height: 2.15,
    lookHeight: 1.1,
    lookAhead: 2.5,
    speedPullback: 0.015,
    speedPullbackMax: 1.2,
    nitroPullback: 1.3,
    gearPullback: 0.9,
    fov: 62,
    speedFovGain: 0.14,
    speedFovMax: 12,
    nitroFov: 11,
    followStiffness: 7,
    lookStiffness: 14,
    yawStiffness: 5,
    driftSwing: 0.45,
  },
  close: {
    dist: 4.1,
    height: 1.6,
    lookHeight: 0.95,
    lookAhead: 2.5,
    speedPullback: 0.015,
    speedPullbackMax: 1.2,
    nitroPullback: 1.3,
    gearPullback: 0.7,
    fov: 62,
    speedFovGain: 0.14,
    speedFovMax: 12,
    nitroFov: 11,
    followStiffness: 7,
    lookStiffness: 14,
    yawStiffness: 5,
    driftSwing: 0.45,
  },
  bumper: { forward: 0.05, height: 0.55, lookDistance: 20, lookDrop: 0.4, fov: 70, speedFovGain: 0.18, speedFovMax: 18, nitroFov: 8, rollFollow: 0.5 },
  hood: { forward: 0.5, height: 1.18, lookDistance: 20, lookDrop: 0.4, fov: 70, speedFovGain: 0.18, speedFovMax: 18, nitroFov: 8, rollFollow: 0.5 },
  common: {
    fovStiffness: 4,
    driftSwingMinSpeed: 4,
    gearEase: 1.6,
    heavyShake: 0.55,
    heavyRoll: 4.5,
    heavyDecay: 1.6,
    lightShake: 0.09,
    lightRoll: 1.2,
    lightDecay: 3.5,
    rumbleShake: 0.012,
    rumbleRoll: 0.28,
    rumbleMinSpeed: 3,
    rumbleFullSpeed: 26,
    rumbleEase: 7,
    nitroStageGain: 0.2,
    nitroShake: 0.03,
    nitroRoll: 0.45,
    nitroShakeEase: 4,
    crashMin: 3,
    crashFull: 16,
    slowdownMin: 0.45,
    slowdownFull: 3,
    wallMinFraction: 0.15,
    wallMargin: 0.08,
    wallLift: 1.5,
    groundClearance: 0.6,
  },
  intro: {
    preRoll: 2,
    aheadDist: 62,
    startHeight: 17,
    startSide: 0.45,
    midHeight: 7,
    midSide: -0.7,
    startFov: 46,
    lookHeight: 2.5,
    lookAhead: 14,
    landPortion: 0.3,
    ease: 2.2,
  },
  outro: {
    resultsDelay: 5.8,
    holdTime: 0.35,
    swingTime: 3.4,
    heroRadius: 4.3,
    heroHeight: 0.28,
    heroAngle: 32,
    heroLookHeight: 0.85,
    heroFov: 80,
    heroRoll: 4,
    orbitSpeed: 0.08,
    yawSmoothing: 2.5,
    groundMin: 0.2,
  },
};

const clone = (p: CameraParams): CameraParams => JSON.parse(JSON.stringify(p)) as CameraParams;

/** Live camera parameters. The debug panel edits these in place. */
export const CAMERA: CameraParams = clone(CAMERA_DEFAULTS);

const CHASE_META = (s: string): Record<string, [number, number, number, string]> => ({
  [`${s}.dist`]: [2, 14, 0.05, 'Base distance behind the car (m).'],
  [`${s}.height`]: [0.5, 6, 0.05, 'Camera height above the car (m).'],
  [`${s}.lookHeight`]: [0, 3, 0.05, 'Height of the aim point above the car (m).'],
  [`${s}.lookAhead`]: [0, 12, 0.1, 'How far ahead of the car the camera aims (m).'],
  [`${s}.speedPullback`]: [0, 0.06, 0.001, 'Extra distance per m/s of speed.'],
  [`${s}.speedPullbackMax`]: [0, 4, 0.05, 'Cap on the speed pull back (m).'],
  [`${s}.nitroPullback`]: [0, 4, 0.05, 'Extra distance while nitrous fires (m).'],
  [`${s}.gearPullback`]: [0, 4, 0.05, 'Extra distance in top gear, shared out gear by gear (m).'],
  [`${s}.fov`]: [35, 100, 0.5, 'Base vertical field of view (deg).'],
  [`${s}.speedFovGain`]: [0, 0.5, 0.005, 'FOV added per m/s of speed.'],
  [`${s}.speedFovMax`]: [0, 30, 0.5, 'Cap on the speed FOV widening (deg).'],
  [`${s}.nitroFov`]: [0, 25, 0.5, 'FOV kick while nitrous fires (deg).'],
  [`${s}.followStiffness`]: [1, 30, 0.1, 'How fast the camera position catches up (1/s).'],
  [`${s}.lookStiffness`]: [1, 40, 0.1, 'How fast the aim point catches up (1/s).'],
  [`${s}.yawStiffness`]: [0.5, 20, 0.1, 'How fast the camera swings around behind the car (1/s).'],
  [`${s}.driftSwing`]: [0, 1, 0.01, 'How much the camera turns toward the slide direction.'],
});

const COCKPIT_META = (s: string): Record<string, [number, number, number, string]> => ({
  [`${s}.forward`]: [-1, 2, 0.01, s === 'bumper' ? 'Offset forward of the nose (m).' : 'Offset forward of the car center (m).'],
  [`${s}.height`]: [0.2, 2, 0.01, 'Eye height above the car origin (m).'],
  [`${s}.lookDistance`]: [5, 60, 0.5, 'Distance of the aim point ahead (m).'],
  [`${s}.lookDrop`]: [-1, 2, 0.01, 'How far below eye height the aim point sits (m).'],
  [`${s}.fov`]: [40, 110, 0.5, 'Base vertical field of view (deg).'],
  [`${s}.speedFovGain`]: [0, 0.5, 0.005, 'FOV added per m/s of speed.'],
  [`${s}.speedFovMax`]: [0, 35, 0.5, 'Cap on the speed FOV widening (deg).'],
  [`${s}.nitroFov`]: [0, 25, 0.5, 'FOV kick while nitrous fires (deg).'],
  [`${s}.rollFollow`]: [0, 1.5, 0.01, 'How much of the body roll the view follows.'],
});

/** Slider range, step and a one line tooltip for every camera parameter. */
export const CAMERA_PARAM_META: Record<string, [number, number, number, string]> = {
  ...CHASE_META('chase'),
  ...CHASE_META('close'),
  ...COCKPIT_META('bumper'),
  ...COCKPIT_META('hood'),
  'common.fovStiffness': [0.5, 20, 0.1, 'How fast the FOV eases toward its target (1/s).'],
  'common.driftSwingMinSpeed': [0, 20, 0.5, 'Speed above which the drift swing kicks in (m/s).'],
  'common.gearEase': [0.2, 10, 0.1, 'How fast the camera settles to a new gear\'s distance (1/s).'],
  'common.heavyShake': [0, 2, 0.01, 'Heavy shake (crashes, sudden stops): sway and bob at full trauma (m).'],
  'common.heavyRoll': [0, 15, 0.1, 'Heavy shake roll at full trauma (deg).'],
  'common.heavyDecay': [0.2, 10, 0.05, 'Heavy trauma lost per second (full trauma lasts 1 / this s).'],
  'common.lightShake': [0, 0.5, 0.005, 'Light shake (props knocked over): sway and bob at full trauma (m).'],
  'common.lightRoll': [0, 5, 0.05, 'Light shake roll at full trauma (deg).'],
  'common.lightDecay': [0.5, 20, 0.1, 'Light trauma lost per second.'],
  'common.rumbleShake': [0, 0.1, 0.001, 'Cobble rumble: sway and bob at full speed on cobbles (m).'],
  'common.rumbleRoll': [0, 2, 0.01, 'Cobble rumble roll at full speed (deg).'],
  'common.rumbleMinSpeed': [0, 20, 0.5, 'Speed on cobbles where the rumble starts (m/s).'],
  'common.rumbleFullSpeed': [5, 60, 0.5, 'Speed on cobbles that gives the full rumble (m/s).'],
  'common.rumbleEase': [0.5, 30, 0.5, 'How fast the rumble fades in and out at an alley mouth (1/s).'],
  'common.nitroStageGain': [0, 1, 0.01, 'Share of the nitrous FOV kick and pull back each stage above the first adds.'],
  'common.nitroShake': [0, 0.1, 0.001, 'Nitrous buzz: sway and bob at the top stage (m); lower stages get their share.'],
  'common.nitroRoll': [0, 2, 0.01, 'Nitrous buzz roll at the top stage (deg).'],
  'common.nitroShakeEase': [0.5, 30, 0.5, 'How fast the nitrous buzz comes in, changes stage and dies away (1/s).'],
  'common.crashMin': [0, 20, 0.5, 'Wall or car impact speed below which there is no heavy shake (m/s).'],
  'common.crashFull': [2, 60, 0.5, 'Wall or car impact speed that gives full heavy trauma (m/s).'],
  'common.slowdownMin': [0.1, 5, 0.05, 'Speed lost in one sim tick that counts as a crash (m/s; braking hard loses about 0.25).'],
  'common.slowdownFull': [0.5, 10, 0.1, 'Speed lost in one tick that gives full heavy trauma (m/s).'],
  'common.wallMinFraction': [0, 1, 0.01, 'Closest the wall push lets the camera get, as a fraction.'],
  'common.wallMargin': [0, 0.5, 0.01, 'Gap kept in front of a wall hit, as a fraction.'],
  'common.wallLift': [0, 5, 0.05, 'How much the camera rises when a wall pushes it in (m).'],
  'common.groundClearance': [0.1, 3, 0.05, 'Minimum camera height above the ground (m).'],
  'intro.preRoll': [0, 6, 0.1, 'Extra intro time before the countdown starts (s).'],
  'intro.aheadDist': [10, 120, 1, 'How far ahead of the player the fly-in starts (m).'],
  'intro.startHeight': [1, 50, 0.5, 'Height of the opening shot (m).'],
  'intro.startSide': [-1, 1, 0.01, 'Opening shot offset across the road (fraction of half width).'],
  'intro.midHeight': [0.5, 30, 0.5, 'Height of the curve as it passes over the grid (m).'],
  'intro.midSide': [-1, 1, 0.01, 'Curve offset across the road over the grid (fraction of half width).'],
  'intro.startFov': [20, 100, 0.5, 'FOV of the opening shot (deg).'],
  'intro.lookHeight': [0, 10, 0.1, 'Aim height of the opening shot (m).'],
  'intro.lookAhead': [-20, 60, 0.5, 'Aim point of the opening shot, ahead of the player (m).'],
  'intro.landPortion': [0.05, 0.8, 0.01, 'Final share of the shot spent settling onto the chase camera.'],
  'intro.ease': [1, 5, 0.05, 'Ease-in-out strength of the fly-in.'],
  'outro.resultsDelay': [1, 15, 0.1, 'Time from crossing the line to the results screen (s).'],
  'outro.holdTime': [0, 3, 0.05, 'Chase camera hold after crossing, before the swing (s).'],
  'outro.swingTime': [0.5, 10, 0.1, 'Duration of the swing around to the hero shot (s).'],
  'outro.heroRadius': [1.5, 15, 0.05, 'Hero shot distance from the car (m).'],
  'outro.heroHeight': [0.05, 5, 0.01, 'Hero shot camera height above the ground (m).'],
  'outro.heroAngle': [0, 90, 0.5, 'Hero shot angle off the car nose (deg).'],
  'outro.heroLookHeight': [0, 3, 0.01, 'Hero shot aim height on the car (m).'],
  'outro.heroFov': [30, 110, 0.5, 'Hero shot field of view (deg).'],
  'outro.heroRoll': [-20, 20, 0.1, 'Dutch tilt of the hero shot (deg).'],
  'outro.orbitSpeed': [-0.5, 0.5, 0.005, 'Slow orbit drift once the hero shot settles (rad/s).'],
  'outro.yawSmoothing': [0.2, 15, 0.1, 'How fast the shot follows the car heading (1/s).'],
  'outro.groundMin': [0.05, 1, 0.01, 'Minimum hero camera height above the ground (m).'],
};

export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2200);
  mode: CameraMode = 'chase';
  /** Where the gameplay camera is aiming this frame (world space). */
  readonly lookTarget = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private dirYaw = 0;
  /** Gear pull back eased toward the current gear's share, 0..1. */
  private gearLevel = 0;
  private fov = 62;
  private initialized = false;
  /** Shake trauma 0..1 of the heavy and light layers, and the noise clock (s). */
  private heavy = 0;
  private light = 0;
  /** Cobble rumble 0..1: what the surface asks for this frame, and the eased level shown. */
  private rumbleTarget = 0;
  private rumbleLevel = 0;
  /** Nitrous buzz 0..1: the stage burning as a share of the top one, and the eased level shown. */
  private boostTarget = 0;
  private boostLevel = 0;
  private shakeT = 0;
  private readonly shakeOff = new THREE.Vector3();
  private scratch: number[] = [];
  /** Mouse orbit offsets (rad) on top of the follow direction, and the time left before they ease back (s). */
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitHold = 0;
  private orbiting = false;

  constructor(private readonly world: World | null) {}

  /** Drag by (dx, dy) pixels: swing around the car (chase, close) or turn the head (bumper, hood). */
  orbitBy(dx: number, dy: number): void {
    this.orbitYaw -= dx * ORBIT.yawPerPx;
    while (this.orbitYaw > Math.PI) this.orbitYaw -= Math.PI * 2;
    while (this.orbitYaw < -Math.PI) this.orbitYaw += Math.PI * 2;
    this.orbitPitch = Math.max(ORBIT.pitchMin, Math.min(ORBIT.pitchMax, this.orbitPitch + dy * ORBIT.pitchPerPx));
    this.orbitHold = ORBIT.hold;
  }

  /** Mouse button held on the view (the orbit never eases back while held). */
  setOrbiting(on: boolean): void {
    this.orbiting = on;
    this.orbitHold = ORBIT.hold;
  }

  /** Back to the plain follow view at once (camera switches). */
  resetOrbit(): void {
    this.orbitYaw = 0;
    this.orbitPitch = 0;
  }

  cycle(): CameraMode {
    this.mode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.mode) + 1) % CAMERA_MODES.length];
    this.initialized = false;
    return this.mode;
  }

  /** Heavy shake: a crash into a wall, rail or car, or a sudden stop. amount 0..1 trauma (takes the larger, plus a little). */
  crash(amount: number): void {
    if (amount <= 0) return;
    this.heavy = Math.min(1, Math.max(this.heavy, amount) + amount * 0.15);
  }

  /** Light shake: knocking over street furniture. */
  knock(amount: number): void {
    if (amount <= 0) return;
    this.light = Math.min(1, Math.max(this.light, amount) + amount * 0.2);
  }

  /** Rolling on cobbles at this speed (m/s; 0 = not on cobbles): a fine rumble that grows with speed, eased in and out. */
  rumble(speed: number): void {
    const c = CAMERA.common;
    this.rumbleTarget = speed > 0 ? Math.max(0, Math.min(1, (speed - c.rumbleMinSpeed) / Math.max(0.1, c.rumbleFullSpeed - c.rumbleMinSpeed))) : 0;
  }

  /** Heavy trauma from a wall or car impact speed (m/s). */
  crashAt(speed: number): void {
    const c = CAMERA.common;
    this.crash((speed - c.crashMin) / Math.max(0.1, c.crashFull - c.crashMin));
  }

  /** Heavy trauma from the speed lost in one sim tick (m/s). */
  slowdown(dv: number): void {
    const c = CAMERA.common;
    if (dv > c.slowdownMin) this.crash(0.25 + (0.75 * (dv - c.slowdownMin)) / Math.max(0.05, c.slowdownFull - c.slowdownMin));
  }

  /**
   * This frame's shake: an offset in camera space (x right, y up, m) and a
   * roll (rad), from smooth noise at a low (heavy) and a high (light) band,
   * plus the cobble rumble at a higher band still (eased, with a slow
   * waver so it reads as stones rather than a buzz) and the nitrous buzz
   * between the two (eased, with a faster waver, like a pulsing jet).
   */
  private shakeNow(dt: number): number {
    const c = CAMERA.common;
    this.shakeT += dt;
    this.heavy = Math.max(0, this.heavy - dt * c.heavyDecay);
    this.light = Math.max(0, this.light - dt * c.lightDecay);
    this.rumbleLevel += (this.rumbleTarget - this.rumbleLevel) * (1 - Math.exp(-c.rumbleEase * dt));
    this.boostLevel += (this.boostTarget - this.boostLevel) * (1 - Math.exp(-c.nitroShakeEase * dt));
    const h = this.heavy * this.heavy;
    const l = this.light * this.light;
    const t = this.shakeT;
    const r = this.rumbleLevel * (0.75 + 0.25 * Math.sin(t * 9.7));
    const jet = this.boostLevel * (0.8 + 0.2 * Math.sin(t * 13.1));
    // Sums of incommensurate sines: smooth, never repeating, zero mean.
    const n = (a: number, b: number, p: number) => 0.6 * Math.sin(t * a + p) + 0.4 * Math.sin(t * b + p * 1.7);
    this.shakeOff.set(
      h * c.heavyShake * n(19, 31, 0.3) + l * c.lightShake * n(47, 61, 2.1) + r * c.rumbleShake * n(83, 127, 3.3) + jet * c.nitroShake * n(67, 101, 1.9),
      h * c.heavyShake * 0.75 * n(23, 37, 1.1) + l * c.lightShake * 0.75 * n(53, 71, 4.2) + r * c.rumbleShake * 0.75 * n(97, 139, 0.9) + jet * c.nitroShake * 0.75 * n(73, 113, 2.7),
      0,
    );
    return (h * c.heavyRoll * n(13, 29, 5.3) + l * c.lightRoll * n(41, 59, 0.7) + r * c.rumbleRoll * n(79, 109, 2.4) + jet * c.nitroRoll * n(59, 97, 4.4)) * (Math.PI / 180);
  }

  /** `nitro` is the nitrous stage burning (0 off, 1..NITRO_STAGES); `gear` how far up the box the car is: 0 in first (and reverse), 1 in top gear. */
  update(p: CarPose, vx: number, vz: number, nitro: number, gear: number, carLength: number, dt: number): void {
    const speed = Math.hypot(vx, vz);
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    const cam = this.camera;
    const common = CAMERA.common;
    // Nitrous: the FOV kick and pull back at stage 1, a share more per stage above; the buzz by stage.
    const boost = nitro > 0 ? 1 + (nitro - 1) * common.nitroStageGain : 0;
    this.boostTarget = Math.min(1, nitro / NITRO_STAGES);
    // Let go of a drag: hold a moment, then ease back behind the car once it moves.
    if (!this.orbiting && (this.orbitYaw !== 0 || this.orbitPitch !== 0)) {
      this.orbitHold -= dt;
      if (this.orbitHold <= 0 && speed > ORBIT.stillSpeed) {
        const k = 1 - Math.exp(-dt * ORBIT.returnRate);
        this.orbitYaw -= this.orbitYaw * k;
        this.orbitPitch -= this.orbitPitch * k;
        if (Math.abs(this.orbitYaw) < 1e-3 && Math.abs(this.orbitPitch) < 1e-3) this.orbitYaw = this.orbitPitch = 0;
      }
    }

    if (this.mode === 'bumper' || this.mode === 'hood') {
      const q = CAMERA[this.mode];
      const forward = this.mode === 'bumper' ? carLength / 2 + q.forward : q.forward;
      const h = q.height;
      cam.position.set(p.x + fx * forward, p.y + h - p.pitch * forward, p.z + fz * forward);
      cam.up.set(0, 1, 0);
      // Head turn: the look point swings around the camera; dragging down looks down.
      const ly = p.yaw + this.orbitYaw;
      const lx = Math.sin(ly) * q.lookDistance;
      const lz = Math.cos(ly) * q.lookDistance;
      this.lookTarget.set(cam.position.x + lx, p.y + h - q.lookDrop - Math.tan(this.orbitPitch * 0.8) * q.lookDistance, cam.position.z + lz);
      cam.lookAt(this.lookTarget);
      // In the car a crash jolts the view: a fraction of the sway as head movement, plus the roll.
      const roll = this.shakeNow(dt);
      cam.translateX(this.shakeOff.x * 0.25);
      cam.translateY(this.shakeOff.y * 0.25);
      cam.rotateZ(-p.roll * q.rollFollow + roll);
      this.setFov(q.fov + Math.min(q.speedFovMax, speed * q.speedFovGain) + q.nitroFov * boost, dt);
      this.initialized = true;
      return;
    }

    const prof = CAMERA[this.mode];
    const k = 1 - Math.exp(-dt * prof.followStiffness);
    // Swing toward the direction of travel when drifting, so the slide stays in view.
    let targetYaw = p.yaw;
    if (speed > common.driftSwingMinSpeed) {
      const velYaw = Math.atan2(vx, vz);
      let d = velYaw - p.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 2) targetYaw = p.yaw + d * prof.driftSwing;
    }
    if (!this.initialized) {
      this.dirYaw = targetYaw;
      this.gearLevel = gear;
    }
    this.gearLevel += (gear - this.gearLevel) * (1 - Math.exp(-dt * common.gearEase));
    let dy = targetYaw - this.dirYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.dirYaw += dy * (1 - Math.exp(-dt * prof.yawStiffness));

    const dist = prof.dist + prof.nitroPullback * boost + Math.min(prof.speedPullbackMax, speed * prof.speedPullback) + this.gearLevel * prof.gearPullback;
    // Orbit: around the car's look point, at the same range, raised by the drag.
    const oy = this.dirYaw + this.orbitYaw;
    const bx = Math.sin(oy);
    const bz = Math.cos(oy);
    const rise = prof.height - prof.lookHeight;
    const el = Math.atan2(rise, dist) + this.orbitPitch;
    const range = Math.hypot(rise, dist);
    const target = new THREE.Vector3(p.x - bx * range * Math.cos(el), p.y + prof.lookHeight + range * Math.sin(el), p.z - bz * range * Math.cos(el));
    // Looking ahead of the car only makes sense from behind it: the further round, the more it aims at the car.
    const ahead = prof.lookAhead * Math.max(0, Math.cos(this.orbitYaw));
    const lookT = new THREE.Vector3(p.x + fx * ahead, p.y + prof.lookHeight, p.z + fz * ahead);
    if (!this.initialized) {
      this.pos.copy(target);
      this.look.copy(lookT);
      this.initialized = true;
    } else {
      this.pos.lerp(target, k);
      this.look.lerp(lookT, 1 - Math.exp(-dt * prof.lookStiffness));
    }

    // Keep the camera out of buildings.
    const out = this.pos.clone();
    this.keepOutOfWalls(p.x, p.z, out, common.groundClearance, common.wallLift);
    cam.position.copy(out);
    cam.up.set(0, 1, 0);
    this.lookTarget.copy(this.look);
    cam.lookAt(this.look);
    // Shake in camera space after aiming, so it sways the picture rather than re-aiming at the car.
    const roll = this.shakeNow(dt);
    if (roll !== 0 || this.shakeOff.x !== 0 || this.shakeOff.y !== 0) {
      cam.translateX(this.shakeOff.x);
      cam.translateY(this.shakeOff.y);
      cam.rotateZ(roll);
    }
    this.setFov(prof.fov + Math.min(prof.speedFovMax, speed * prof.speedFovGain) + prof.nitroFov * boost, dt);
  }

  /**
   * Pull a camera position in toward (ax, az) if the line to it crosses a wall,
   * lifting it by `lift` m at full pull, and keep it `clearance` m above the ground
   * and out of anything overhead (render/camera/ceilings.ts).
   */
  keepOutOfWalls(ax: number, az: number, out: THREE.Vector3, clearance: number, lift: number): void {
    if (!this.world) return;
    const c = CAMERA.common;
    const hit = this.wallHit(ax, az, out.x, out.z);
    if (hit < 1) {
      const t = Math.max(c.wallMinFraction, hit - c.wallMargin);
      out.x = ax + (out.x - ax) * t;
      out.z = az + (out.z - az) * t;
      out.y += (1 - t) * lift;
    }
    out.y = Math.max(out.y, this.world.heightAt(out.x, out.z) + clearance);
    // Never inside a tunnel's roof, a viaduct's deck or a gantry's truss.
    clampCeiling(this.world, out);
  }

  /** Drop smoothing state so the next update snaps to the target pose. */
  snap(): void {
    this.initialized = false;
  }

  private setFov(target: number, dt: number): void {
    this.fov += (target - this.fov) * (1 - Math.exp(-dt * CAMERA.common.fovStiffness));
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Fraction along (ax,az)->(bx,bz) of the first wall hit, or 1. */
  wallHit(ax: number, az: number, bx: number, bz: number): number {
    return this.world ? wallHit(this.world, ax, az, bx, bz, this.scratch) : 1;
  }
}

/**
 * Fraction along (ax,az)->(bx,bz) of the first static wall the line crosses,
 * or 1 when it is clear: how every camera stays out of the buildings (the race
 * cameras here, the menu and garage street cameras in game/streetCameras.ts).
 * `scratch` is reused for the grid query.
 */
export function wallHit(w: World, ax: number, az: number, bx: number, bz: number, scratch: number[]): number {
  w.wallGrid.query(Math.min(ax, bx) - 1, Math.min(az, bz) - 1, Math.max(ax, bx) + 1, Math.max(az, bz) + 1, scratch);
  let best = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (const id of scratch) {
    const s = w.walls[id];
    const ex = s.bx - s.ax;
    const ez = s.bz - s.az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((s.ax - ax) * ez - (s.az - az) * ex) / den;
    const u = ((s.ax - ax) * dz - (s.az - az) * dx) / den;
    if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}
