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
import { People, WEAR, standingPose } from './person';
import type { PersonPose } from './person';
import { streetLook } from './looks';
import type { CarPose, CarView } from '../car/carView';
import type { Disposable } from '../disposer';
import { clamp } from '../../sim/math';

/** A seat in car space: the hips left of center (+x), their height and distance ahead of the car's center (m), the recline (rad, negative leans back). */
interface Seat {
  x: number;
  y: number;
  z: number;
  lean: number;
}
/**
 * Where the driver sits in each car, from its cabin's geometry: hips just
 * above the cushion and a hand's width ahead of the seat back, reclined so
 * the head clears the roof (the character is 1.75 m tall; a car's cabin is
 * a little under 1.2 m inside). Measured from the shipped GLBs' Interior
 * faces: cushion top, seat back and wheel stations.
 */
const SEATS: Record<string, Seat> = {
  protoHatch: { x: 0.38, y: 0.52, z: -0.28, lean: -0.4 },
  protoCoupe: { x: 0.38, y: 0.5, z: -0.5, lean: -0.45 },
  protoWagon: { x: 0.38, y: 0.51, z: -0.18, lean: -0.4 },
};
const DEFAULT_SEAT: Seat = { x: 0.38, y: 0.5, z: -0.3, lean: -0.4 };
/** Steer angle (rad) that turns the wheel fully for the hands. */
const FULL_LOCK = 0.5;

/** Seated, hands on the wheel at nine and three, feet to the pedals; the hips' height and recline come from the seat. */
function seatedPose(): PersonPose {
  const p = standingPose();
  p.hipY = 0;
  p.lean = DEFAULT_SEAT.lean;
  p.headPitch = 0.08;
  p.legs = [
    [1.3, 1.25],
    [1.3, 1.25],
  ];
  p.arms = [
    { raise: 0.95, out: 0.05, elbow: 0.6 },
    { raise: 0.95, out: 0.05, elbow: 0.6 },
  ];
  return p;
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

  constructor(max: number) {
    const track = <T extends Disposable>(x: T): T => {
      this.owned.push(x);
      return x;
    };
    this.people = new People(max, track, null, 'mid');
    this.group = this.people.group;
    for (let i = 0; i < max; i++) this.people.setLook(i, driverLook(i));
  }

  /** Seat a driver in each view for its pose this frame (views beyond the field's size go without). */
  update(views: readonly CarView[], poses: readonly CarPose[]): void {
    const p = this.pose;
    for (let i = 0; i < this.people.max; i++) {
      const view = views[i];
      if (!view) {
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
      // Turning left the wheel goes round anticlockwise: the left hand drops and the right rises.
      p.arms[0].raise = 0.95 - 0.5 * s;
      p.arms[1].raise = 0.95 + 0.5 * s;
      p.arms[0].elbow = 0.6 + 0.3 * Math.max(0, s);
      p.arms[1].elbow = 0.6 + 0.3 * Math.max(0, -s);
      p.headYaw = 0.35 * s;
      p.side = -poses[i].roll * 0.3;
      this.people.set(i, this.root, p);
    }
    this.people.commit();
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const o of this.owned) o.dispose();
  }
}
