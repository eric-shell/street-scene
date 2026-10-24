/**
 * The driver in every car: the character (person.ts) seated at the wheel of
 * each car view, one draw call for the whole field, at the mid level of
 * detail (it is seen through tinted glass). The seat is measured from each
 * car's own cabin (the donor's seats and wheel, SEATS; a new car gets the
 * default until measured). Each frame it is placed from the car body's
 * world matrix (so it rolls and pitches with the car),
 * the hands turn the wheel with the steer angle, the head looks into the
 * turn and the body leans against the roll. Drivers dress from the street
 * wardrobe with a cap and gloves, the same per car index. Render only.
 */
import * as THREE from 'three';
import { BODY, People, WEAR, standingPose } from './person';
import type { PersonArm, PersonPose } from './person';
import { streetLook } from './looks';
import type { CarPose, CarView } from '../car/carView';
import type { Disposable } from '../disposer';
import { clamp } from '../../sim/math';

/** A seat in car space: the hips left of center (+x), their height and distance ahead of the car's center (m), the recline (rad, negative leans back), and the wheel's place when the car's own is worth reaching for (else WHEEL). */
interface Seat {
  x: number;
  y: number;
  z: number;
  lean: number;
  wheel?: { ahead: number; up: number };
}
/**
 * The steering wheel the hands reach for, relative to the hips (m): ahead and
 * up, the rim's radius and its tilt (rad, the top leaning away from the
 * driver). The default for every car: most donors' wheels are reduced past
 * recognition (the Hatch's lies flat), and a wheel where a seated driver's
 * hands fall reads right through the glass whatever the cabin. A car whose
 * wheel survived (the Coupe's) names its own in its seat.
 */
const WHEEL = { ahead: 0.38, up: 0.28, r: 0.17, tilt: 0.4 } as const;
/**
 * Where the driver sits in each car, from its cabin's geometry: hips a
 * little into the cushion (the pelvis is hidden by it) and a hand's width
 * ahead of the seat back, reclined just enough that the head clears the roof
 * (the character is 1.75 m tall; a car's cabin is a little under 1.2 m
 * inside) without pulling the shoulders out of the wheel's reach. Measured
 * from the shipped GLBs' Interior faces: cushion top and seat back.
 */
const SEATS: Record<string, Seat> = {
  protoHatch: { x: 0.38, y: 0.48, z: -0.28, lean: -0.22 },
  // The Coupe's wheel is low and well ahead of its seat (the RX-7's long cabin): the driver sits forward to it.
  protoCoupe: { x: 0.38, y: 0.46, z: -0.42, lean: 0.12, wheel: { ahead: 0.55, up: 0.2 } },
  protoWagon: { x: 0.38, y: 0.47, z: -0.18, lean: -0.22 },
};
const DEFAULT_SEAT: Seat = { x: 0.38, y: 0.47, z: -0.3, lean: -0.22 };
/** Steer angle (rad) that turns the wheel fully for the hands, and how far round the rim they go there (rad). */
const FULL_LOCK = 0.5;
const GRIP_TURN = 1.1;

/** Seated, feet to the pedals; the hips' height and recline come from the seat and the arms are solved to the wheel each frame. */
function seatedPose(): PersonPose {
  const p = standingPose();
  p.hipY = 0;
  p.lean = DEFAULT_SEAT.lean;
  p.headPitch = 0.08;
  p.legs = [
    [1.3, 1.25],
    [1.3, 1.25],
  ];
  return p;
}

/**
 * Aim an arm at a target in the spine's frame (the rig's: the shoulder at
 * (s * BODY.shoulder, BODY.spine, 0), the arm hanging along -y, raised
 * toward +z, swung out along s * x, the elbow bending forward): the two bone
 * solve, the elbow's bend from the reach and the raise less the bend's share.
 * A target past the arm's reach straightens it toward the target.
 */
function aimArm(arm: PersonArm, s: 1 | -1, tx: number, ty: number, tz: number): void {
  const L1 = BODY.upper;
  const L2 = BODY.fore;
  const d = Math.min(Math.hypot(tx, ty, tz), L1 + L2 - 1e-3);
  const elbow = Math.acos(clamp((d * d - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1));
  // The bent arm's end lies at this angle from the upper arm's line, toward the bend.
  const beta = Math.atan2(L2 * Math.sin(elbow), L1 + L2 * Math.cos(elbow));
  const a = Math.hypot(tx, ty);
  arm.out = s * Math.atan2(tx, -ty);
  arm.raise = Math.atan2(tz, a) - beta;
  arm.elbow = elbow;
}

/** Who drives car i: street clothes under a cap, gloves on, nothing in the hands. */
function driverLook(i: number) {
  let k = i * 53 + 7;
  const rnd = () => {
    const x = Math.sin(k++ * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const look = streetLook(rnd);
  look.wear = (look.wear & ~(WEAR.hood | WEAR.beanie | WEAR.hair | WEAR.phone | WEAR.flag | WEAR.glowstick)) | WEAR.cap | WEAR.gloves;
  return look;
}

export class Drivers {
  readonly group: THREE.Group;
  private readonly people: People;
  private readonly owned: Disposable[] = [];
  private readonly pose = seatedPose();
  private readonly seat = new THREE.Matrix4();
  private readonly root = new THREE.Matrix4();
  // Scratch for the hands' targets: the spine's frame in car space and its inverse, a grip on the rim.
  private readonly spine = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly grip = new THREE.Vector3();

  constructor(max: number) {
    const track = <T extends Disposable>(x: T): T => {
      this.owned.push(x);
      return x;
    };
    this.people = new People(max, track, null, 'mid');
    this.group = this.people.group;
    for (let i = 0; i < max; i++) this.people.setLook(i, driverLook(i));
  }

  /** Seat a driver in each view for its pose this frame (views beyond the field's size go without, and a hidden car's driver hides with it: the reset blink). */
  update(views: readonly CarView[], poses: readonly CarPose[]): void {
    const p = this.pose;
    for (let i = 0; i < this.people.max; i++) {
      const view = views[i];
      if (!view || !view.root.visible) {
        this.people.hide(i);
        continue;
      }
      // The body carries the car's pitch and roll; its world matrix is one frame stale until asked.
      view.body.updateWorldMatrix(true, false);
      const seat = SEATS[view.car.id] ?? DEFAULT_SEAT;
      this.seat.makeTranslation(seat.x, seat.y, seat.z);
      this.root.multiplyMatrices(view.body.matrixWorld, this.seat);
      p.lean = seat.lean;
      // Reclined, the head would tip back with the spine: bring it level and a little down to the road.
      p.headPitch = 0.08 - seat.lean;
      const s = clamp(poses[i].steer / FULL_LOCK, -1, 1);
      p.headYaw = 0.35 * s;
      p.side = -poses[i].roll * 0.3;
      // Hands at nine and three, gone round the rim with the wheel (a left turn drops the left hand), each arm
      // solved to its grip: the grip in car space, into the spine's frame (the seat, the hips, the recline).
      const turn = s * GRIP_TURN;
      this.spine.makeRotationFromEuler(this.euler.set(p.lean, 0, p.side, 'YXZ')).setPosition(seat.x, seat.y, seat.z).invert();
      for (const k of [0, 1] as const) {
        const side = k === 0 ? 1 : -1;
        const c = Math.cos(turn) * side;
        const u = -Math.sin(turn) * side;
        const wheel = seat.wheel ?? WHEEL;
        this.grip.set(seat.x + WHEEL.r * c, seat.y + wheel.up + WHEEL.r * u * Math.cos(WHEEL.tilt), seat.z + wheel.ahead + WHEEL.r * u * Math.sin(WHEEL.tilt)).applyMatrix4(this.spine);
        aimArm(p.arms[k], side, this.grip.x - side * BODY.shoulder, this.grip.y - BODY.spine + 0.03, this.grip.z);
      }
      this.people.set(i, this.root, p);
    }
    this.people.commit();
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}
