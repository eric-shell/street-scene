/**
 * One car's render pose between two sim ticks: the `CarPose` the car view
 * draws plus what the engine voice, the camera and the crowd read (velocity,
 * rpm, throttle, shift and spark-cut flags, the post-reset pass-through
 * timer). `snap` copies it out of the sim's car state at the end of a tick;
 * `lerpSnap` blends the previous and current snapshots by the loop's alpha.
 * Render only: nothing here writes back into RaceState.
 */
import type { RaceCar } from '../../sim/race';
import type { CarPose } from '../../render/car/carView';

export interface Snap extends CarPose {
  nitroStage: number;
  vx: number;
  vz: number;
  rpm: number;
  throttle: number;
  /** A gear change is cutting the drive (engine voice). */
  shifting: boolean;
  /** The two-step or antilag has the spark off (engine voice: the limiter's stutter). */
  cut: boolean;
  /** Time left passing through other cars after a reset (s): the car blinks while it does. */
  passThrough: number;
}

export function snap(rc: RaceCar): Snap {
  const c = rc.state;
  return {
    x: c.x,
    y: c.y,
    z: c.z,
    yaw: c.yaw,
    pitch: c.pitch,
    roll: c.roll,
    steer: c.steerAngle,
    comp: c.wheels.map((w) => w.compression),
    spin: c.wheels.map((w) => w.spin),
    braking: c.aLong < -4 && c.speed > 1,
    nitro: c.nitroActive,
    nitroStage: c.nitroStage,
    speed: c.speed,
    vx: c.vx,
    vz: c.vz,
    rpm: c.rpm,
    throttle: c.throttle,
    shifting: c.shiftTimer > 0,
    cut: c.twoStepCut > 0,
    passThrough: rc.passThrough,
  };
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/**
 * Blend two snapshots by t. With `out` (same wheel count) it writes into that Snap and returns it, so the
 * per-frame path allocates nothing; without, it returns a fresh one.
 */
export function lerpSnap(a: Snap, b: Snap, t: number, out?: Snap): Snap {
  const l = (x: number, y: number) => x + (y - x) * t;
  const o = out ?? { ...b, comp: [], spin: [] };
  o.x = l(a.x, b.x);
  o.y = l(a.y, b.y);
  o.z = l(a.z, b.z);
  o.yaw = lerpAngle(a.yaw, b.yaw, t);
  o.pitch = l(a.pitch, b.pitch);
  o.roll = l(a.roll, b.roll);
  o.steer = l(a.steer, b.steer);
  for (let i = 0; i < b.comp.length; i++) {
    o.comp[i] = l(a.comp[i], b.comp[i]);
    o.spin[i] = lerpAngle(a.spin[i], b.spin[i], t);
  }
  o.braking = b.braking;
  o.nitro = b.nitro;
  o.nitroStage = b.nitroStage;
  o.speed = l(a.speed, b.speed);
  o.vx = l(a.vx, b.vx);
  o.vz = l(a.vz, b.vz);
  o.rpm = l(a.rpm, b.rpm);
  o.throttle = l(a.throttle, b.throttle);
  o.shifting = b.shifting;
  o.cut = b.cut;
  o.passThrough = b.passThrough;
  return o;
}
