/**
 * Arcade street car model. 2.5D rigid body: planar dynamics (x, z, yaw) from
 * four tire forces, plus heave, pitch and roll from four raycast suspension
 * springs against the terrain. Deterministic: fixed dt, no globals.
 *
 * The body leans at most BODY_LEAN away from the ground under it, not from
 * level, so it lies over on a river bank and pitches up a ramp with all four
 * wheels loaded. The ground pushes back along its normal: the springs' load
 * times the slope is the force down a grade at rest and what slows a car
 * climbing a bank. Landings are absorbed by a stiff, lossy bump stop and a
 * rebound damper stronger than the bump damper, so the car settles with a
 * small rebound instead of bouncing. Braking is the tires plus an arcade
 * assist deceleration that does not use up cornering grip.
 *
 * Tires: each wheel's force follows its slip vector, sideways slip over the
 * peak slip angle and slip ratio over the peak slip ratio (the normalization
 * Forza's telemetry exposes), one grip curve over the vector's length and the
 * direction against it, so a spinning or locked wheel trades sideways grip for
 * the forward or braking force it makes. Driven axles have real wheel speed:
 * a locked pair of wheels with the engine's inertia geared onto them, held at
 * the slip that transmits the drive torque while the tires can, spinning up to
 * the limiter against the sliding tires' force when they cannot. That is what
 * makes a drift throttle steered: power spins the rear and takes its sideways
 * grip, lifting hands it back. The handbrake locks the rear axle, with the
 * clutch out on a car that drives it. docs/handling.md has the model.
 */
import { DT, SUBSTEPS } from './constants';
import { InputFrame } from './input';
import { CarTuning, GRAVITY, NITRO_STAGES, driveSplit } from './tuning';
import { DEG, TAU, abs, approach, atan2, clamp, cos, lerp, sign, sin, sqrt, tan } from './math';
import type { Surface, World } from '../city/world';
import { SURFACE_PHYSICS } from '../city/districts/types';

export interface WheelState {
  /** Positive = pushed up into the arch, relative to the rest pose. */
  compression: number;
  load: number;
  /** Wheel rotation angle (radians) for rendering. */
  spin: number;
  spinRate: number;
  contact: boolean;
  /** Lateral slip angle (radians). */
  slip: number;
  skid: number;
}

export interface CarState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Nose down positive. */
  pitch: number;
  /** Left side up positive. */
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  yawRate: number;
  pitchRate: number;
  rollRate: number;
  /** Front wheel angle in radians, positive = left. */
  steerAngle: number;
  rpm: number;
  /** -1 reverse, 1..n forward. */
  gear: number;
  shiftTimer: number;
  reverseHold: number;
  manualGearbox: boolean;
  /** Driver aid: drive force is limited to what the driven tires can transmit. */
  tractionControl: boolean;
  /** Wheelspin of the front / rear axle, 0 (at or under the peak slip ratio) .. 1 (fully spinning). Only driven axles spin. */
  spinFront: number;
  spinRear: number;
  /** Tread speed of each axle's wheels (m/s, signed): the wheels' own speed over the road, not the car's. */
  wheelSpeedFront: number;
  wheelSpeedRear: number;
  /** Nitrous in stages, 0..NITRO_STAGES: 1 is a full first stage. */
  nitro: number;
  nitroActive: boolean;
  /** Stage burning this tick (1..NITRO_STAGES, the top one in the tank), 0 when not boosting. */
  nitroStage: number;
  /** Full stages in the tank when the nitrous button went down (they set the chain refill), -1 while it is up. */
  nitroRun: number;
  /**
   * Telemetry for the HUD's callouts, written by the sim and never read by it:
   * the stages a chain put back this tick (0 when none), and what each style
   * source put in the tank this tick (stages, after the tank's cap; wreck is what props.ts paid).
   */
  nitroChain: number;
  nitroGain: { drift: number; nearMiss: number; draft: number; zone: number; wreck: number };
  /** Drive pedal actually applied this tick (0..1), for engine sound and telemetry. */
  throttle: number;
  /** Seconds left of a clutch kick's extra torque. */
  clutchKick: number;
  /**
   * Launch control and the pedal combos (launch tuning). twoStepCut: seconds left of the current rev cut
   * (> 0 while the two-step or antilag has the spark off: the stutter the tach and the engine voice show).
   * lineLock: throttle and brake together at a standstill, the brakes holding the undriven axle while the
   * driven wheels spin (a burnout). antilag: the same combo rolling in a turbo car, the engine held at
   * revs with boost pinned and no drive. boost: turbo spool, 0 (off boost) .. 1 (full), always 0 on a
   * naturally aspirated car. antilagHold: seconds boost stays pinned after the brake comes off antilag.
   */
  twoStepCut: number;
  lineLock: boolean;
  antilag: boolean;
  boost: number;
  antilagHold: number;
  throttleOffTime: number;
  prevThrottle: number;
  wheels: WheelState[];
  // telemetry, derived each tick
  speed: number;
  slipAngle: number;
  drifting: boolean;
  /** A driven axle is spinning noticeably (spinFront / spinRear > 0.2). */
  wheelspin: boolean;
  surface: Surface;
  impact: number;
  /**
   * Telemetry for sparks, written by the sim and never read by it. Deepest
   * bump stop overtravel of the tick (m past suspension travel, 0 when none):
   * the underbody hitting the ground. bottomWheel is the wheel (geometry
   * order) it happened at, -1 for the chassis itself scraping the ground.
   */
  bottomOut: number;
  bottomWheel: number;
  /** Sliding speed (m/s) along the deepest wall or rail contact of the tick, 0 when not touching. */
  scrape: number;
  /** That contact's point on the wall (m) and its unit normal into drivable space (0, 0 when not touching). */
  scrapeX: number;
  scrapeZ: number;
  scrapeNx: number;
  scrapeNz: number;
  nearMiss: boolean;
  drafting: boolean;
  /** Acceleration from the tires and the air (m/s^2), which loads the springs: the brake assist is not in it. */
  aLong: number;
  aLat: number;
}

export function createCar(x: number, z: number, yaw: number, y: number): CarState {
  return {
    x,
    y,
    z,
    yaw,
    pitch: 0,
    roll: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yawRate: 0,
    pitchRate: 0,
    rollRate: 0,
    steerAngle: 0,
    rpm: 900,
    gear: 1,
    shiftTimer: 0,
    reverseHold: 0,
    manualGearbox: false,
    tractionControl: false,
    spinFront: 0,
    spinRear: 0,
    wheelSpeedFront: 0,
    wheelSpeedRear: 0,
    nitro: 1,
    nitroActive: false,
    nitroStage: 0,
    nitroRun: -1,
    nitroChain: 0,
    nitroGain: { drift: 0, nearMiss: 0, draft: 0, zone: 0, wreck: 0 },
    throttle: 0,
    clutchKick: 0,
    twoStepCut: 0,
    lineLock: false,
    antilag: false,
    boost: 0,
    antilagHold: 0,
    throttleOffTime: 10,
    prevThrottle: 0,
    wheels: [0, 1, 2, 3].map(() => ({ compression: 0, load: 0, spin: 0, spinRate: 0, contact: true, slip: 0, skid: 0 })),
    speed: 0,
    slipAngle: 0,
    drifting: false,
    wheelspin: false,
    surface: 'road',
    impact: 0,
    bottomOut: 0,
    bottomWheel: 0,
    scrape: 0,
    scrapeX: 0,
    scrapeZ: 0,
    scrapeNx: 0,
    scrapeNz: 0,
    nearMiss: false,
    drafting: false,
    aLong: 0,
    aLat: 0,
  };
}

/** Put a car at rest at a position (resets to the road, tows off a hazard); `y` picks the level under a bridge deck (World.heightAt). */
export function placeCar(c: CarState, x: number, z: number, yaw: number, world: World, y?: number): void {
  c.x = x;
  c.z = z;
  c.yaw = yaw;
  c.y = world.driveHeightAt(x, z, y);
  c.vx = c.vy = c.vz = 0;
  c.yawRate = c.pitchRate = c.rollRate = 0;
  // Lying on the ground at its own angle (a reset on a bank or a ramp sits flat on it).
  const sl = world.slopeAt(x, z, y);
  const fx = sin(yaw);
  const fz = cos(yaw);
  c.pitch = groundPitch(sl, fx, fz);
  c.roll = groundRoll(sl, fx, fz);
  c.steerAngle = 0;
  c.clutchKick = 0;
  c.twoStepCut = 0;
  c.antilagHold = 0;
  c.lineLock = c.antilag = false;
  c.spinFront = c.spinRear = 0;
  c.wheelSpeedFront = c.wheelSpeedRear = 0;
  c.gear = 1;
  c.shiftTimer = 0;
  for (const w of c.wheels) {
    w.compression = 0;
    w.spinRate = 0;
  }
}

const RPM_PER_RADS = 60 / TAU;
/** How fast the free engine chases its target revs (rpm/s): the flywheel's response, not tuning. */
const REV_RATE = 24000;
/** Most the body pitches or rolls away from the ground's own angle (rad): suspension geometry, not tuning. */
const BODY_LEAN = 0.15;
/**
 * Road speed the slips are measured against at a crawl (m/s): numerical conditioning, not tuning. Slip
 * angle and slip ratio divide by the wheel's road speed, which would make them explode as the car stops.
 */
const SLIP_REF_SPEED = 2.5;
/** Body height of the box the pitch and roll inertia are taken from (m): a car's, not a tuning value. */
const BODY_HEIGHT = 1.3;

/** Front wheel lock at a road speed (rad): maxDeg at a standstill, fading to highSpeedDeg by fadeSpeed. */
export function steerLimit(t: CarTuning, speed: number): number {
  return lerp(t.steering.maxDeg, t.steering.highSpeedDeg, clamp(speed / t.steering.fadeSpeed, 0, 1)) * DEG;
}

/** Yaw inertia (kg m^2): the footprint's box approximation, scaled by yawInertiaScale. */
export function yawInertia(t: CarTuning): number {
  const L = t.geometry.halfLength * 2;
  const W = t.geometry.halfWidth * 2;
  return ((t.mass * (L * L + W * W)) / 12) * t.yawInertiaScale;
}

/** The ground's slope (World.slopeAt: rise per meter along x and z). */
interface Slope {
  gx: number;
  gz: number;
}

/** The ground's pitch under a car heading (fx, fz) = (sin yaw, cos yaw) (rad, nose down positive). */
export function groundPitch(sl: Slope, fx: number, fz: number): number {
  return -atan2(sl.gx * fx + sl.gz * fz, 1);
}

/** The ground's roll under a car heading (fx, fz) (rad, left side up positive). */
export function groundRoll(sl: Slope, fx: number, fz: number): number {
  return atan2(sl.gx * fz - sl.gz * fx, 1);
}

export function torqueAt(t: CarTuning, rpm: number): number {
  const curve = t.engine.torqueCurve;
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (rpm <= curve[i][0]) {
      const [r0, n0] = curve[i - 1];
      const [r1, n1] = curve[i];
      return n0 + ((n1 - n0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return curve[curve.length - 1][1];
}

function gearRatio(t: CarTuning, gear: number): number {
  if (gear < 0) return t.gearbox.reverseRatio;
  return t.gearbox.ratios[Math.max(0, Math.min(t.gearbox.ratios.length - 1, gear - 1))];
}

export function wheelRpm(t: CarTuning, gear: number, vLong: number): number {
  return (abs(vLong) / t.geometry.wheelRadius) * gearRatio(t, gear) * t.gearbox.finalDrive * RPM_PER_RADS;
}

/** What a car steps against: the world it drives on. */
export interface StepEnv {
  world: World;
}

/** Advance one fixed tick. */
export function stepCar(c: CarState, t: CarTuning, inp: InputFrame, env: StepEnv): void {
  const dt = DT;
  const world = env.world;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const lx = fz;
  const lz = -fx;
  const vLong = c.vx * fx + c.vz * fz;
  const vLat = c.vx * lx + c.vz * lz;
  const speed = sqrt(c.vx * c.vx + c.vz * c.vz);
  const beta = speed > 1 ? atan2(vLat, abs(vLong)) : 0;
  c.surface = world.surfaceAt(c.x, c.z, c.y);

  // ---- pedals and gearbox ----
  let drive = inp.throttle;
  let brake = inp.brake;
  const nGears = t.gearbox.ratios.length;
  if (c.gear < 0) {
    drive = inp.brake;
    brake = inp.throttle;
    if (inp.throttle > 0.1 && vLong > -1) c.gear = 1;
  } else {
    // Reverse only from a standstill: the whole car stopped, not just its forward speed (a car sliding
    // sideways under the handbrake has no forward speed either, and must not drive off backwards).
    if (inp.brake > 0.5 && inp.throttle < 0.1 && speed < 0.8 && !inp.handbrake) c.reverseHold += dt;
    else c.reverseHold = 0;
    if (c.reverseHold > 0.3) {
      c.gear = -1;
      c.reverseHold = 0;
    }
  }
  if (c.shiftTimer > 0) c.shiftTimer = Math.max(0, c.shiftTimer - dt);
  if (c.gear > 0) {
    const up = t.gearbox.upshiftRpmFrac * t.engine.redline;
    if (c.manualGearbox) {
      if (inp.shift === 1 && c.gear < nGears) {
        c.gear++;
        c.shiftTimer = t.gearbox.shiftTime;
      } else if (inp.shift === -1 && c.gear > 1) {
        c.gear--;
        c.shiftTimer = t.gearbox.shiftTime * 0.6;
      }
    } else if (c.shiftTimer === 0) {
      // The automatic shifts on the car's speed over the ground: not the wheels' (spinning wheels would
      // upshift a drift) and not the forward component alone (a sideways drift would drop into first).
      const rpmNow = wheelRpm(t, c.gear, speed);
      if (c.gear < nGears && rpmNow > up && vLong > 0) {
        c.gear++;
        c.shiftTimer = t.gearbox.shiftTime;
      } else if (c.gear > 1 && rpmNow < t.gearbox.downshiftRpmFrac * t.engine.redline && wheelRpm(t, c.gear - 1, speed) < up * 0.9) {
        c.gear--;
        c.shiftTimer = t.gearbox.shiftTime * 0.6;
      }
    }
  }

  // ---- engine ----
  const ratio = gearRatio(t, c.gear);
  const gearing = ratio * t.gearbox.finalDrive;
  const lowGear = c.gear === 1 || c.gear === -1;
  const clutchRpm = t.engine.idleRpm + drive * (t.engine.launchRpm - t.engine.idleRpm);
  const split = driveSplit(t);
  // The handbrake locks the rear wheels, so a drivetrain that turns them drops the clutch (as Forza does):
  // the engine revs free and lets go with a bang on release. A front drive car keeps driving through it.
  const clutchIn = inp.handbrake && split.rear > 0;
  // In gear the engine turns with the driven wheels, spinning or not: wheelspin takes it to the limiter.
  const axleSpeed = split.front > 0 && split.rear > 0 ? (c.wheelSpeedFront + c.wheelSpeedRear) / 2 : split.front > 0 ? c.wheelSpeedFront : c.wheelSpeedRear;
  const axleRpm = (abs(axleSpeed) / t.geometry.wheelRadius) * gearing * RPM_PER_RADS;
  // Clutch slip before this tick's rpm update: revs above the wheels (launch, clutch dump).
  const clutchSlipRpm = Math.max(0, c.rpm - axleRpm);
  let rpmTarget = Math.max(axleRpm, lowGear ? clutchRpm : t.engine.idleRpm);
  if (c.shiftTimer > 0) rpmTarget = Math.max(t.engine.idleRpm, axleRpm);
  if (clutchIn) rpmTarget = t.engine.idleRpm + drive * (t.engine.redline - t.engine.idleRpm);
  // The pedal combos (launch tuning). Throttle and brake together: standing, a line lock (the brakes hold
  // the undriven axle, the driven wheels spin: a burnout); rolling in a turbo car, antilag (the clutch
  // slips, the engine is held at revs with boost pinned, the brakes drag the speed). The two-step is
  // armed at a standstill while a launch rpm is set: a hard cut that bounces the revs under it (the
  // countdown's launch control, gridRev), so the car leaves the line from exactly those revs.
  const L = t.launch;
  const combo = c.gear > 0 && inp.throttle > L.pedalThreshold && inp.brake > L.pedalThreshold;
  const standing = speed < L.lineLockSpeed;
  c.lineLock = combo && standing;
  c.antilag = combo && !standing && t.engine.turbo && !clutchIn;
  const holdRpm = L.twoStepRpm > 0 ? L.twoStepRpm : L.antilagRpm;
  const armed = L.twoStepRpm > 0 && c.gear > 0 && standing && drive > L.pedalThreshold && !clutchIn;
  if (c.antilag) rpmTarget = Math.max(axleRpm, holdRpm);
  else if (armed) rpmTarget = Math.max(rpmTarget, holdRpm);
  if (c.antilag || armed) rpmTarget = twoStep(c, holdRpm, L, dt, rpmTarget);
  else c.twoStepCut = 0;
  c.rpm = approach(c.rpm, Math.min(rpmTarget, t.engine.redline + 150), REV_RATE * dt);

  c.throttle = drive;
  // Nitrous burns the top stage in the tank first, at that stage's power. Holding the button until the tank
  // runs dry, from at least one full stage, chains: chainRefill puts some back and the burn goes on (a chain
  // of a whole stage can chain once more). Letting go ends the run; a dip off the throttle only pauses it.
  if (!inp.nitrous) c.nitroRun = -1;
  else if (c.nitroRun < 0) c.nitroRun = nitroFullStages(c.nitro);
  c.nitroChain = 0;
  c.nitroActive = inp.nitrous && c.nitro > 0 && c.gear > 0 && drive > 0.2;
  c.nitroStage = c.nitroActive ? nitroTopStage(c.nitro) : 0;
  if (c.nitroActive) {
    c.nitro -= dt / t.nitrous.capacity;
    if (c.nitro <= 0) {
      const refill = c.nitroRun > 0 ? t.nitrous.chainRefill[c.nitroRun - 1] : 0;
      c.nitro = refill;
      c.nitroChain = refill;
      c.nitroRun = nitroFullStages(refill);
    }
  }
  const boostPower = c.nitroActive ? t.nitrous.stagePower[c.nitroStage - 1] : 0;

  let engineTorque = 0;
  if (c.shiftTimer === 0 && !clutchIn && !c.antilag) {
    // The two-step's cut takes the spark away: no torque while it bounces.
    if (c.rpm < t.engine.redline && c.twoStepCut === 0) engineTorque = torqueAt(t, c.rpm) * t.engine.torqueMul * drive;
    if (t.engine.turbo) engineTorque *= 1 - L.turboShare * (1 - c.boost);
    if (c.nitroActive) engineTorque *= 1 + (t.nitrous.torqueMul - 1) * boostPower;
    // Dumping the clutch at high revs (launch, clutch kick, handbrake release) adds the flywheel's energy on top.
    const dump = c.clutchKick > 0 ? 1 : clamp(clutchSlipRpm / t.engine.redline, 0, 1);
    if (engineTorque > 0) engineTorque *= 1 + t.traction.launchBoost * dump;
    if (drive < 0.05 && c.gear > 0) engineTorque -= t.engine.engineBraking * clamp(c.rpm / t.engine.redline, 0, 1) * sign(axleSpeed);
  }
  if (t.engine.turbo) spoolTurbo(c, t, drive, dt);
  // Torque at the driven wheels, all axles together.
  let driveTorque = engineTorque * gearing * t.gearbox.efficiency;
  if (c.gear < 0) {
    driveTorque = -driveTorque;
    if (vLong < -t.gearbox.reverseMaxSpeed) driveTorque = 0;
  }

  // ---- steering ----
  const limit = steerLimit(t, speed);
  let target = -inp.steer * limit;
  if (speed > 5 && target !== 0 && sign(target) === sign(beta)) {
    // steering into a slide (counter steer) gets extra lock
    target = -inp.steer * (limit + abs(beta) * t.steering.counterSteerAllowance);
  }
  c.steerAngle = approach(c.steerAngle, target, t.steering.rateDegPerSec * DEG * dt);

  // ---- clutch kick ----
  if (inp.throttle < 0.3) {
    c.throttleOffTime += dt;
  } else if (c.prevThrottle < 0.3) {
    // A throttle stab after a short lift while steering hard reads as a clutch kick: the flywheel's energy
    // dumps into the driven wheels (a jump in their speed, which breaks them loose) and the clutch keeps
    // feeding extra torque for clutchKickTime. Traction control catches it.
    if (c.throttleOffTime > 0.04 && c.throttleOffTime < 0.35 && speed > 14 && abs(inp.steer) > 0.55 && c.gear > 0) {
      c.clutchKick = t.drift.clutchKickTime;
      if (!c.tractionControl) {
        if (split.front > 0) c.wheelSpeedFront += t.traction.clutchKickSpeed;
        if (split.rear > 0) c.wheelSpeedRear += t.traction.clutchKickSpeed;
      }
    }
    c.throttleOffTime = 0;
  }
  c.prevThrottle = inp.throttle;
  if (c.clutchKick > 0) c.clutchKick = Math.max(0, c.clutchKick - dt);

  // District surfaces (concrete, grass, water, cobbles) drive like one of the tuned ones.
  const sp = SURFACE_PHYSICS[c.surface];
  const surfaceGrip = sp === 'road' ? 1 : sp === 'sidewalk' ? t.surface.sidewalkGrip : sp === 'cobble' ? t.surface.cobbleGrip : t.surface.offroadGrip;
  const dragMul = c.drafting ? t.nitrous.draftDragMul : 1;

  // Traction control stability: cut the throttle once the body slides past a few degrees.
  const tcSlip = t.traction.tcMaxSlipDeg * DEG;
  if (c.tractionControl && driveTorque > 0 && speed > 6 && abs(beta) > tcSlip) {
    driveTorque *= Math.max(0.2, 1 - (abs(beta) - tcSlip) / (10 * DEG));
  }

  // Line lock: the driven wheels' brakes come off so they can spin; the others, and the brake assist, hold the car.
  const brakeFront = c.lineLock && split.front > 0 ? 0 : brake;
  const brakeRear = c.lineLock && split.rear > 0 ? 0 : brake;
  const ctl: Controls = { driveTorque, brake, brakeFront, brakeRear, handbrake: inp.handbrake, clutchIn: clutchIn || c.shiftTimer > 0 || c.antilag, gearing, surfaceGrip, dragMul, drive, frontShare: split.front, boostForce: t.nitrous.force * boostPower };
  const h = dt / SUBSTEPS;
  c.bottomOut = 0;
  for (let s = 0; s < SUBSTEPS; s++) integrate(c, t, ctl, world, h);
  c.wheelspin = c.spinFront > 0.2 || c.spinRear > 0.2;

  // ---- telemetry and wheel visuals ----
  const fx2 = sin(c.yaw);
  const fz2 = cos(c.yaw);
  const vLong2 = c.vx * fx2 + c.vz * fz2;
  const vLat2 = c.vx * fz2 - c.vz * fx2;
  c.speed = sqrt(c.vx * c.vx + c.vz * c.vz);
  c.slipAngle = c.speed > 1 ? atan2(vLat2, abs(vLong2)) : 0;
  c.drifting = c.speed > 10 && abs(c.slipAngle) > 10 * DEG;
  const r = t.geometry.wheelRadius;
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i];
    // The wheels turn at their own tread speed: ahead of the road when spinning, still under the handbrake.
    w.spinRate = (i < 2 ? c.wheelSpeedFront : c.wheelSpeedRear) / r;
    w.spin = (w.spin + w.spinRate * dt) % TAU;
  }
}

/**
 * The two-step (and antilag's rev hold): a hard cut that bounces the engine under `set`. Returns the revs
 * the engine chases this tick given what it wanted (`want`): the set point until it gets there, then a
 * cut of twoStepCutTime drops it twoStepDepth under and the climb back starts the next cut, the stutter
 * of a launch control. c.twoStepCut is the cut's timer (> 0 while the spark is off).
 */
function twoStep(c: CarState, set: number, L: CarTuning['launch'], dt: number, want: number): number {
  if (c.twoStepCut > 0) {
    c.twoStepCut = Math.max(0, c.twoStepCut - dt);
    return set - L.twoStepDepth;
  }
  if (want >= set && c.rpm >= set - 1) {
    c.twoStepCut = L.twoStepCutTime;
    return set - L.twoStepDepth;
  }
  return Math.min(want, set);
}

/**
 * Turbo spool for a turbocharged car: boost builds under load above spoolRpmFrac of the redline in
 * spoolTime and bleeds off the throttle in spoolDownTime. Antilag pins it at full and keeps it there
 * antilagHold after the brake comes off, so the release is on full boost at once.
 */
function spoolTurbo(c: CarState, t: CarTuning, drive: number, dt: number): void {
  const L = t.launch;
  if (c.antilag) {
    c.boost = 1;
    c.antilagHold = L.antilagHold;
    return;
  }
  if (c.antilagHold > 0) {
    c.antilagHold = Math.max(0, c.antilagHold - dt);
    c.boost = 1;
    return;
  }
  const spooling = drive > 0.3 && c.rpm > L.spoolRpmFrac * t.engine.redline;
  c.boost = spooling ? Math.min(1, c.boost + dt / L.spoolTime) : Math.max(0, c.boost - dt / L.spoolDownTime);
}

/**
 * The engine on the grid (race.ts, the countdown): the cars stand still and only rev. Free revving chases
 * the pedal to 85% of the redline, as it always has (old replays). With a launch rpm set, holding the
 * throttle past the pedal threshold arms the two-step and the revs bounce under it. Throttle and brake
 * together is a line lock burnout: the driven wheels spin up to the engine's tread speed in first (the
 * spin telemetry and the wheels' skid follow, for the smoke and the marks) and the car leaves the line
 * already spinning. A turbo builds boost through all of it.
 */
export function gridRev(c: CarState, t: CarTuning, inp: InputFrame, dt: number): void {
  const L = t.launch;
  const armed = L.twoStepRpm > 0 && inp.throttle > L.pedalThreshold;
  if (armed) {
    c.rpm = approach(c.rpm, twoStep(c, L.twoStepRpm, L, dt, L.twoStepRpm), REV_RATE * dt);
  } else {
    c.twoStepCut = 0;
    const target = t.engine.idleRpm + inp.throttle * (t.engine.redline * 0.85 - t.engine.idleRpm);
    c.rpm += (target - c.rpm) * 0.15;
  }
  c.lineLock = inp.throttle > L.pedalThreshold && inp.brake > L.pedalThreshold;
  c.antilag = false;
  const split = driveSplit(t);
  // The driven wheels' tread speed with the engine in first gear, the limiter's cut included.
  const gearing = gearRatio(t, 1) * t.gearbox.finalDrive;
  const tread = c.lineLock && c.twoStepCut === 0 ? (c.rpm / RPM_PER_RADS / gearing) * t.geometry.wheelRadius : 0;
  const rate = (c.lineLock ? 4 : 2) * t.traction.clutchKickSpeed * dt;
  c.wheelSpeedFront = split.front > 0 ? approach(c.wheelSpeedFront, tread, rate) : 0;
  c.wheelSpeedRear = split.rear > 0 ? approach(c.wheelSpeedRear, tread, rate) : 0;
  const spin = (ws: number) => clamp(ws / Math.max(1, tread), 0, 1);
  c.spinFront = split.front > 0 && c.lineLock ? spin(c.wheelSpeedFront) : 0;
  c.spinRear = split.rear > 0 && c.lineLock ? spin(c.wheelSpeedRear) : 0;
  c.wheelspin = c.spinFront > 0.2 || c.spinRear > 0.2;
  const r = t.geometry.wheelRadius;
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i];
    w.spinRate = (i < 2 ? c.wheelSpeedFront : c.wheelSpeedRear) / r;
    w.spin = (w.spin + w.spinRate * dt) % TAU;
    w.skid = 1.6 * (i < 2 ? c.spinFront : c.spinRear);
  }
  c.throttle = inp.throttle;
  if (t.engine.turbo) spoolTurbo(c, t, inp.throttle, dt);
}

interface Controls {
  /** Drive torque at the wheels, all axles together (Nm, signed; engine braking is negative). */
  driveTorque: number;
  /** Foot brake (0..1): the pedal for the arcade assist, and what reaches each axle's wheels (a line lock lifts it off the driven axle). */
  brake: number;
  brakeFront: number;
  brakeRear: number;
  handbrake: boolean;
  /** Clutch out (handbrake on a driven rear axle, a shift): no drive, and the engine's inertia is off the wheels. */
  clutchIn: boolean;
  /** Gear times final drive: engine turns per wheel turn. */
  gearing: number;
  surfaceGrip: number;
  dragMul: number;
  drive: number;
  /** Share of driveTorque sent to the front axle. */
  frontShare: number;
  /** Nitrous push along the car while boosting (N), at the burning stage's power. */
  boostForce: number;
}

/** Grip over the length of a normalized slip vector, given the sideways share of that vector (0..1). */
type GripCurve = (rho: number, latShare: number) => number;

const wFmax = [0, 0, 0, 0];
const wLong = [0, 0, 0, 0];
const wAlpha = [0, 0, 0, 0];
/** Sideways slip over the peak slip angle (0 rolling straight, 1 at the peak). */
const wSy = [0, 0, 0, 0];
/** Slip ratio: tread speed over road speed, minus one. */
const wKappa = [0, 0, 0, 0];
/** Per axle, from updateAxles: holding (not spinning), the torque it transmits, its forward capacity and its grip. */
const axleHold = [false, false];
const axleT = [0, 0];
const axleCap = [0, 0];
const axleGrip = [0, 0];

/**
 * Axle speeds. Each axle is one rigid pair of wheels (a locked differential,
 * the drift setup) with the engine's inertia geared onto it while the clutch
 * is out. Under the peak slip ratio the tires hold the drive torque and the
 * axle rides just over road speed (quasi static, so it is stable at any speed
 * and tick); ask for more than they hold and the axle spins up against what
 * the sliding tires give back, until the limiter stops the engine. Lifting
 * lets the tires pull it back. The handbrake locks the rear axle; the foot
 * brake only reins spinning wheels in (its stopping force is per wheel in the
 * force pass). Traction control never asks the tires for more than
 * tcSlipTarget of what they hold. Fills wKappa, the axle tables and the spin
 * telemetry.
 */
function updateAxles(c: CarState, t: CarTuning, ctl: Controls, gripAt: GripCurve, h: number): void {
  const tr = t.traction;
  const R = t.geometry.wheelRadius;
  const peakK = t.tires.peakSlipRatio;
  const fullK = peakK * (t.tires.fullSlideDeg / t.tires.peakSlipDeg);
  const dir = c.gear < 0 ? -1 : 1;
  for (let a = 0; a < 2; a++) {
    const share = a === 0 ? ctl.frontShare : 1 - ctl.frontShare;
    const driven = share > 0;
    let ws = a === 0 ? c.wheelSpeedFront : c.wheelSpeedRear;
    const I = 2 * tr.wheelInertia + (driven && !ctl.clutchIn ? t.engine.inertia * ctl.gearing * ctl.gearing * share : 0);
    // The pair's rolling speed (where neither tire slips), its grip, and the peak forward force it holds at
    // its current sideways slip (the slip vector at the peak slip ratio), each tire weighted by its grip.
    let stiff = 0;
    let roll = 0;
    let grip = 0;
    let cap = 0;
    let capTc = 0;
    for (let i = a * 2; i < a * 2 + 2; i++) {
      if (wFmax[i] === 0) continue;
      const k = wFmax[i] / Math.max(abs(wLong[i]), SLIP_REF_SPEED);
      stiff += k;
      roll += k * wLong[i];
      grip += wFmax[i];
      const rho1 = sqrt(1 + wSy[i] * wSy[i]);
      cap += (gripAt(rho1, (wSy[i] * wSy[i]) / (rho1 * rho1)) * wFmax[i]) / rho1;
      // Traction control keeps the slip vector inside the peak, where drive costs no cornering grip, with
      // a little drive left even at full cornering slip so the car can still pull out of a slide.
      capTc += wFmax[i] * Math.max(tr.tcMinDrive, sqrt(Math.max(0, 1 - wSy[i] * wSy[i])));
    }
    let T = driven && !ctl.clutchIn ? ctl.driveTorque * share : 0;
    if (c.tractionControl && T * dir > 0 && abs(T) > tr.tcSlipTarget * capTc * R) T = sign(T) * tr.tcSlipTarget * capTc * R;
    let spin = 0;
    let hold = false;
    if (stiff === 0) {
      // Both wheels in the air: the axle spins up under power and coasts otherwise.
      ws += (h * R * T) / I;
    } else {
      const wsRoll = roll / stiff;
      const vref = grip / stiff;
      const kappa = (ws - wsRoll) / vref;
      hold = abs(kappa) <= peakK && abs(T) <= cap * R;
      if (hold) {
        // Holding: the tires transmit T, at a slip ratio in proportion to the capacity used; the axle moves
        // there as fast as the torques in play could take it, and never past it.
        const wsEq = wsRoll + ((peakK * T) / (cap * R)) * vref;
        ws = approach(ws, wsEq, (h * R * (abs(T) + cap * R)) / I);
      } else {
        // Spinning, or locked: the axle integrates against what the sliding tires give back.
        let Fx = 0;
        for (let i = a * 2; i < a * 2 + 2; i++) {
          if (wFmax[i] === 0) continue;
          const sx = (ws - wLong[i]) / Math.max(abs(wLong[i]), SLIP_REF_SPEED) / peakK;
          const rho = sqrt(sx * sx + wSy[i] * wSy[i]);
          if (rho > 0) Fx += (gripAt(rho, (wSy[i] * wSy[i]) / (rho * rho)) * wFmax[i] * sx) / rho;
        }
        ws += (h * R * (T - R * Fx)) / I;
      }
      // The foot brake pulls spinning wheels back to road speed, never under it.
      const axleBrake = a === 0 ? ctl.brakeFront : ctl.brakeRear;
      if (axleBrake > 0 && (ws - wsRoll) * dir > 0) {
        const bt = axleBrake * t.brakes.force * (a === 0 ? t.brakes.frontBias : 1 - t.brakes.frontBias) * R;
        ws = dir * Math.max(wsRoll * dir, ws * dir - (h * R * bt) / I);
      }
      // Telemetry: how far past the peak the axle spins, in the gear's direction.
      if (driven) spin = clamp((((ws - wsRoll) / vref) * dir - peakK) / (fullK - peakK), 0, 1);
    }
    // The handbrake locks the rear axle.
    if (a === 1 && ctl.handbrake) ws = approach(ws, 0, (h * R * t.brakes.handbrakeTorque) / I);
    for (let i = a * 2; i < a * 2 + 2; i++) wKappa[i] = wFmax[i] === 0 ? 0 : (ws - wLong[i]) / Math.max(abs(wLong[i]), SLIP_REF_SPEED);
    axleHold[a] = hold;
    axleT[a] = T;
    axleCap[a] = cap;
    axleGrip[a] = grip;
    if (a === 0) {
      c.wheelSpeedFront = ws;
      c.spinFront = spin;
    } else {
      c.wheelSpeedRear = ws;
      c.spinRear = spin;
    }
  }
}

/** Each spring's load this substep (N), from suspension(). */
const wLoad = [0, 0, 0, 0];
/** suspension()'s sums over the four springs: vertical force (N), pitch and roll torque (Nm), wheels touching. */
const springs = { sumF: 0, pitchTorque: 0, rollTorque: 0, contacts: 0, wet: 0 };
/** tireForces()'s sums over the four tires in the car's frame: forward and left force (N), yaw torque (Nm). */
const tireSum = { Fu: 0, Fv: 0, torque: 0 };

/** One physics substep: springs, tires, body forces, then the body's motion and attitude. */
function integrate(c: CarState, t: CarTuning, ctl: Controls, world: World, h: number): void {
  const m = t.mass;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const lx = fz;
  const lz = -fx;
  const vLong = c.vx * fx + c.vz * fz;
  const vLat = c.vx * lx + c.vz * lz;
  const speed = sqrt(c.vx * c.vx + c.vz * c.vz);

  // Box approximations for inertia.
  const L = t.geometry.halfLength * 2;
  const W = t.geometry.halfWidth * 2;
  const Iz = yawInertia(t);
  const Ip = (m * (L * L + BODY_HEIGHT * BODY_HEIGHT)) / 12;
  const Ir = (m * (W * W + BODY_HEIGHT * BODY_HEIGHT)) / 12;

  suspension(c, t, world, h, fx, fz, lx, lz);
  const { sumF, contacts } = springs;
  tireForces(c, t, ctl, h, vLong, vLat, speed);
  let Fu = tireSum.Fu;
  let Fv = tireSum.Fv;
  const torque = tireSum.torque;

  // ---- body forces ----
  const drag = t.aero.drag * ctl.dragMul;
  Fu -= drag * vLong * speed + t.tires.rollingResistance * vLong;
  Fv -= drag * vLat * speed;
  // Dirt and cobbles drag on the tires: a constant force once rolling (eased in below 1 m/s).
  const sp = SURFACE_PHYSICS[c.surface];
  const surfaceDrag = sp === 'offroad' ? t.surface.offroadDrag : sp === 'cobble' ? t.surface.cobbleDrag : 0;
  if (surfaceDrag > 0) Fu -= surfaceDrag * sign(vLong) * Math.min(1, abs(vLong));
  // Water drags with the square of speed, so the trickle costs a racer what clipping a destructible
  // does and a crawler nothing much: the dry line is the fast line down the channel.
  if (springs.wet > 0) {
    const kw = t.surface.waterDrag * (springs.wet / 4) * speed;
    Fu -= kw * vLong;
    Fv -= kw * vLat;
  }
  if (c.nitroActive && contacts > 0) Fu += ctl.boostForce;
  // The ground pushes back along its normal: the springs' vertical load times the slope, sideways. At
  // rest that is gravity's pull down a grade; climbing a bank, the extra load is what slows the car.
  const sl = world.slopeAt(c.x, c.z, c.y);
  Fu -= sumF * (sl.gx * fx + sl.gz * fz);
  Fv -= sumF * (sl.gx * lx + sl.gz * lz);
  // Load transfer (pitch and roll below) follows the body's actual acceleration, slope included, so a
  // bank or a grade alone does not unload the uphill wheels: a car holding a line along a river bank
  // sits on it as it would on the flat.
  c.aLong = Fu / m;
  c.aLat = Fv / m;
  // Brake assist: an arcade deceleration on top of the tires, shared over the wheels on the ground and
  // never reversing the car within a step. It leaves the tires' cornering grip alone and stays out of
  // aLong, so the load transfer is the tires' and a hard stop never lifts the rear light.
  // It acts along the car's path, not its nose (braking in a slide slows the slide instead of turning it
  // sideways), and fades out as the car goes sideways.
  if (ctl.brake > 0 && contacts > 0 && speed > 0) {
    const along = abs(vLong) / speed;
    const Fa = Math.min((t.brakes.assistDecel * ctl.brake * contacts * m * along) / 4, (speed * m) / h);
    Fu -= (Fa * vLong) / speed;
    Fv -= (Fa * vLat) / speed;
  }

  const Fwx = Fu * fx + Fv * lx;
  const Fwz = Fu * fz + Fv * lz;

  c.vx += (Fwx / m) * h;
  c.vz += (Fwz / m) * h;
  c.yawRate += ((torque - t.drift.yawDamping * c.yawRate) / Iz) * h;

  // ---- drift aids ----
  const vLongN = c.vx * fx + c.vz * fz;
  const vLatN = c.vx * lx + c.vz * lz;
  const beta = speed > 3 ? atan2(vLatN, abs(vLongN)) : 0;
  const maxSlip = t.drift.maxSlipDeg * DEG;
  // Anti spin aid: past maxSlipDeg of body slip a torque turns the nose back toward the direction of
  // travel. Only going forward, fading in from walking pace: a car sliding slowly sideways after a spin
  // has no meaningful slip angle and must not be whipped round.
  if (abs(beta) > maxSlip && contacts > 0 && vLongN > 0) {
    const fade = clamp((speed - 3) / 5, 0, 1);
    c.yawRate += ((sign(beta) * t.drift.assistTorque * (abs(beta) - maxSlip) * 4 * fade) / Iz) * h;
  }
  if (speed < 3) c.yawRate /= 1 + t.drift.yawDampingLowSpeed * h * (3 - speed);
  // Park: kill creep when stopped without throttle.
  if (speed < 0.25 && ctl.drive < 0.05 && contacts > 0) {
    c.vx *= 0.5;
    c.vz *= 0.5;
  }

  c.x += c.vx * h;
  c.z += c.vz * h;
  c.yaw += c.yawRate * h;

  heaveAndLean(c, t, world, sl, h, fx, fz, Ip, Ir);
}

/**
 * The springs against the ground under each wheel: fills wLoad and springs (the forces they push the body
 * with, the torques those make about its pitch and roll axes, and how many wheels touch), and each wheel's
 * compression, contact and load, with the deepest bump stop overtravel for the spark telemetry.
 */
function suspension(c: CarState, t: CarTuning, world: World, h: number, fx: number, fz: number, lx: number, lz: number): void {
  const m = t.mass;
  const geo = t.geometry;
  const sus = t.suspension;
  const omega = TAU * sus.frequency;
  const k = (m / 4) * omega * omega;
  const crit = 2 * sqrt(k * (m / 4));
  const kStop = k * sus.bumpStopRate;
  const dampStop = sus.bumpStopDamping * 2 * sqrt(kStop * (m / 4));
  const sag = (m * GRAVITY) / (4 * k);
  // The body over each wheel: the plane through c.y tilted by pitch and roll. tan, so a body lying
  // on a plane at the plane's own angle has the same compression at every wheel.
  const tPitch = tan(c.pitch);
  const tRoll = tan(c.roll);
  let sumF = 0;
  let pitchTorque = 0;
  let rollTorque = 0;
  let contacts = 0;
  let wet = 0;
  for (let i = 0; i < 4; i++) {
    const [wv, , wu] = geo.wheels[i];
    const w = c.wheels[i];
    const wx = c.x + fx * wu + lx * wv;
    const wz = c.z + fz * wu + lz * wv;
    // Wheels ride the paving: up onto a sidewalk over its curb, not through it.
    const ground = world.driveHeightAt(wx, wz, c.y);
    // Water is felt per wheel (the body's own surface is sampled at its center): a car straddling the
    // river trickle's edge ploughs with the wheels that are in it.
    if (world.surfaceAt(wx, wz, c.y) === 'water') wet++;
    const comp = ground - (c.y + wv * tRoll - wu * tPitch);
    const compVel = (comp - w.compression) / h;
    w.compression = comp;
    let F = 0;
    if (comp + sag > 0) {
      // Rebound damped harder than bump: the spring cannot fling the body back up after a hit.
      F = k * (comp + sag) + (compVel > 0 ? sus.dampingRatio : sus.reboundRatio) * crit * compVel;
      const over = comp - sus.travel;
      if (over > 0) {
        // Bump stop: stiff and lossy. It soaks up a landing while it compresses and gives back only
        // bumpStopReturn of its force as it unloads, so the car settles instead of bouncing.
        F += compVel > 0 ? kStop * over + dampStop * compVel : kStop * over * sus.bumpStopReturn;
        if (over > c.bottomOut) {
          c.bottomOut = over;
          c.bottomWheel = i;
        }
      }
      if (F < 0) F = 0;
    }
    w.contact = comp + sag > 0;
    if (w.contact) contacts++;
    w.load = F;
    wLoad[i] = F;
    sumF += F;
    pitchTorque += -wu * F;
    rollTorque += wv * F;
  }
  springs.sumF = sumF;
  springs.pitchTorque = pitchTorque;
  springs.rollTorque = rollTorque;
  springs.contacts = contacts;
  springs.wet = wet;
}

/**
 * The tires: each wheel's slip, the axles' drive (updateAxles), then each tire's force from its slip vector,
 * with the foot brake. Sums the forces and the yaw torque they make into tireSum, and writes each wheel's
 * slip and skid telemetry.
 */
function tireForces(c: CarState, t: CarTuning, ctl: Controls, h: number, vLong: number, vLat: number, speed: number): void {
  const m = t.mass;
  const geo = t.geometry;
  const cosd = cos(c.steerAngle);
  const sind = sin(c.steerAngle);
  const peakA = t.tires.peakSlipDeg * DEG;
  const peakK = t.tires.peakSlipRatio;
  const rhoFull = t.tires.fullSlideDeg / t.tires.peakSlipDeg;
  const down = (t.aero.downforce * speed * speed) / 4;
  const loadCap = (t.tires.loadCap * m * GRAVITY) / 4;
  // Grip over the length of the normalized slip vector (1 = the peak): up to the peak, then down to what a
  // sliding tire keeps, which is slideGrip sideways and slideGripLong lengthways (a spinning or locked
  // wheel keeps most of its forward bite, sideways slides are looser), by the direction of the slip.
  const gripAt: GripCurve = (rho, latShare) => {
    if (rho < 1) return rho;
    return 1 - (1 - lerp(t.tires.slideGripLong, t.tires.slideGrip, latShare)) * Math.min(1, (rho - 1) / (rhoFull - 1));
  };
  // Pass 1: each wheel's road velocity in its own frame, its grip and its sideways slip.
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i];
    const front = i < 2;
    const [wv, , wu] = geo.wheels[i];
    const pl = vLong - c.yawRate * wv;
    const pt = vLat + c.yawRate * wu;
    const cd = front ? cosd : 1;
    const sd = front ? sind : 0;
    const wl = pl * cd + pt * sd;
    const wt = -pl * sd + pt * cd;
    const mu = (front ? t.tires.gripFront : t.tires.gripRear) * ctl.surfaceGrip;
    const alpha = atan2(wt, Math.max(abs(wl), SLIP_REF_SPEED));
    // Grip stops growing past loadCap times the static wheel load: a landing or a bump stop hit on one
    // wheel loads the spring, not the tire, so it cannot turn into a sideways kick that spins the car.
    wFmax[i] = w.contact ? mu * (Math.min(wLoad[i], loadCap) + down) : 0;
    wLong[i] = wl;
    wAlpha[i] = alpha;
    wSy[i] = abs(alpha) / peakA;
  }
  // Pass 2: the axles (drive, wheelspin, handbrake), which sets each wheel's slip ratio.
  updateAxles(c, t, ctl, gripAt, h);
  // Pass 3: forces. A holding axle transmits its drive torque exactly, split by grip; otherwise the force
  // is the grip curve over the slip vector's length, pointed against it. Either way the sideways force is
  // what that vector leaves: the friction circle, so a spinning or locked wheel gives up cornering grip.
  let Fu = 0;
  let Fv = 0;
  let torque = 0;
  const R = geo.wheelRadius;
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i];
    if (!w.contact) {
      w.slip = 0;
      w.skid = 0;
      continue;
    }
    const front = i < 2;
    const a = front ? 0 : 1;
    const [wv, , wu] = geo.wheels[i];
    const cd = front ? cosd : 1;
    const sd = front ? sind : 0;
    const wl = wLong[i];
    const pt = vLat + c.yawRate * wu;
    const wt = -(vLong - c.yawRate * wv) * sd + pt * cd;
    const Fmax = wFmax[i];
    const alpha = wAlpha[i];
    w.slip = alpha;
    if (Fmax === 0) {
      // Touching with no load yet (the spring unloaded by its damper): nothing to push with.
      w.skid = 0;
      continue;
    }
    const sy = wSy[i];
    // Lengthways slip, normalized: the share of the axle's forward capacity in use while holding, the slip
    // ratio over its peak while spinning.
    const sx = axleHold[a] ? axleT[a] / (axleCap[a] * R) : wKappa[i] / peakK;
    const rho = sqrt(sx * sx + sy * sy);
    const mag = rho > 0 ? gripAt(rho, (sy * sy) / (rho * rho)) * Fmax : 0;
    let Fx = axleHold[a] ? (axleT[a] / R) * (Fmax / axleGrip[a]) : rho > 0 ? (mag * sx) / rho : 0;
    let Fy = rho > 0 ? -sign(alpha) * ((mag * sy) / rho) : 0;
    // Foot brake: split across the axle by load (EBD) so a light inside wheel does not lock, opposing wheel
    // motion and never reversing it within a step, on tires not already sliding lengthways (a locked or
    // spinning wheel has nothing more to give). It takes sideways grip by the friction circle but leaves
    // minLateralShare: the arcade ABS that lets the car still turn on the brakes.
    const wheelBrake = front ? ctl.brakeFront : ctl.brakeRear;
    if (wheelBrake > 0 && abs(wKappa[i]) < peakK) {
      const axleLoad = front ? wLoad[0] + wLoad[1] : wLoad[2] + wLoad[3];
      const share = axleLoad > 1 ? wLoad[i] / axleLoad : 0.5;
      const brakeF = wheelBrake * t.brakes.force * (front ? t.brakes.frontBias : 1 - t.brakes.frontBias) * share;
      const stop = (wl * (m / 4)) / h;
      const before = abs(Fx);
      Fx -= clamp(stop, -brakeF, brakeF);
      if (abs(Fx) > Fmax) Fx = sign(Fx) * Fmax;
      const used = clamp((abs(Fx) - before) / Fmax, 0, 1);
      Fy *= Math.max(t.tires.minLateralShare, sqrt(1 - used * used));
    }
    // Squeal and smoke telemetry: how far into the slide the tire is, whichever way it slides.
    w.skid = Math.min(1.6, Math.max(0, rho - 0.7));
    const maxFy = ((m / 4) * abs(wt)) / h;
    if (abs(Fy) > maxFy) Fy = sign(Fy) * maxFy;

    const fu = Fx * cd - Fy * sd;
    const fv = Fx * sd + Fy * cd;
    Fu += fu;
    Fv += fv;
    torque += wu * fv - wv * fu;
  }
  tireSum.Fu = Fu;
  tireSum.Fv = Fv;
  tireSum.torque = torque;
}

/** Hold one body angle within BODY_LEAN of the ground's; a rate pushing past the limit stops there. */
function holdLean(c: CarState, angle: 'pitch' | 'roll', rate: 'pitchRate' | 'rollRate', ground: number): void {
  if (c[angle] > ground + BODY_LEAN) {
    c[angle] = ground + BODY_LEAN;
    if (c[rate] > 0) c[rate] = 0;
  } else if (c[angle] < ground - BODY_LEAN) {
    c[angle] = ground - BODY_LEAN;
    if (c[rate] < 0) c[rate] = 0;
  }
}

/** Heave, pitch and roll from the springs' sums and the body's acceleration; the chassis never sinks into the ground. */
function heaveAndLean(c: CarState, t: CarTuning, world: World, sl: Slope, h: number, fx: number, fz: number, Ip: number, Ir: number): void {
  const m = t.mass;
  c.vy += (springs.sumF / m - GRAVITY) * h;
  c.y += c.vy * h;
  c.pitchRate += ((springs.pitchTorque - m * c.aLong * t.cgHeight) / Ip) * h;
  c.rollRate += ((springs.rollTorque + m * c.aLat * t.cgHeight) / Ir) * h;
  // The body leans at most BODY_LEAN from the ground's own angle in the car's frame: level on a street,
  // laid over on a bank, pitched up a ramp (and in the air, over whatever it flies across). A rate
  // pushing past the limit stops there.
  const gPitch = groundPitch(sl, fx, fz);
  const gRoll = groundRoll(sl, fx, fz);
  if (springs.contacts === 0) {
    // In the air the body levels out over the ground below (arcade air control, critically damped at
    // airLevel rad/s), so a jump comes down flat on all four wheels instead of on its nose.
    const w = t.suspension.airLevel;
    c.pitchRate += (w * w * (gPitch - c.pitch) - 2 * w * c.pitchRate) * h;
    c.rollRate += (w * w * (gRoll - c.roll) - 2 * w * c.rollRate) * h;
  }
  c.pitch += c.pitchRate * h;
  c.roll += c.rollRate * h;
  holdLean(c, 'pitch', 'pitchRate', gPitch);
  holdLean(c, 'roll', 'rollRate', gRoll);
  const ground = world.driveHeightAt(c.x, c.z, c.y);
  if (c.y < ground - 0.35) {
    if (c.vy < 0 && -c.vy * h > c.bottomOut) {
      c.bottomOut = -c.vy * h;
      c.bottomWheel = -1;
    }
    c.y = ground - 0.35;
    if (c.vy < 0) c.vy = 0;
  }
}

/** Slack for a tank level summed from many small refills: 0.9999999 of a stage counts as the full stage. */
const NITRO_EPS = 1e-6;

/** Full stages in a tank of `nitro` stages. */
export function nitroFullStages(nitro: number): number {
  return Math.floor(nitro + NITRO_EPS);
}

/** The stage a tank of `nitro` stages burns first (the top one with anything in it), 0 when empty. */
export function nitroTopStage(nitro: number): number {
  return nitro > NITRO_EPS ? Math.min(NITRO_STAGES, Math.ceil(nitro - NITRO_EPS)) : 0;
}

/** The drift refill reaches its full rate at this slip angle (rad). */
const FULL_REFILL_SLIP = 30 * DEG;

/** Nitrous a drift refills (stages/s) at the car's slip angle; driftZones.ts adds a share of it inside a zone. */
export function driftRefillRate(c: CarState, t: CarTuning): number {
  return t.nitrous.refillDrift * Math.min(1, abs(c.slipAngle) / FULL_REFILL_SLIP);
}

/**
 * Refill nitrous from style: drifting, near misses and drafting, filling the
 * stages in order up to a full tank. Call once per tick after collisions.
 */
export function refillNitrous(c: CarState, t: CarTuning): void {
  const drift = c.drifting ? driftRefillRate(c, t) : 0;
  const near = c.nearMiss ? t.nitrous.refillNearMiss : 0;
  const draft = c.drafting ? t.nitrous.refillDraft : 0;
  const add = drift + near + draft;
  const before = c.nitro;
  c.nitro = Math.min(NITRO_STAGES, c.nitro + add * DT);
  // Telemetry: each source's share of what the tank took (stages driftZones.ts adds go in .zone).
  const k = add > 0 ? (c.nitro - before) / add : 0;
  const g = c.nitroGain;
  g.drift = drift * k;
  g.nearMiss = near * k;
  g.draft = draft * k;
  g.zone = 0;
}
