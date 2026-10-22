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
 */
import { DT, SUBSTEPS } from './constants';
import { InputFrame } from './input';
import { CarTuning, GRAVITY, driveSplit } from './tuning';
import { DEG, abs, approach, atan2, clamp, cos, lerp, sign, sin, sqrt, tan } from './math';
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
  /** Traction control cut the drive force this tick (for a HUD light). */
  tcActive: boolean;
  /** Wheelspin of the front / rear axle, 0 (gripping) .. 1 (fully spinning). Only driven axles spin. */
  spinFront: number;
  spinRear: number;
  /** 0..1 */
  nitro: number;
  nitroActive: boolean;
  /** Drive pedal actually applied this tick (0..1), for engine sound and telemetry. */
  throttle: number;
  rearGrip: number;
  clutchKick: number;
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
    tcActive: false,
    spinFront: 0,
    spinRear: 0,
    nitro: 1,
    nitroActive: false,
    throttle: 0,
    rearGrip: 1,
    clutchKick: 0,
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

/** Put a car at rest at a position (used for grid and reset to road); `y` picks the level under a bridge deck (World.heightAt). */
export function placeCar(c: CarState, x: number, z: number, yaw: number, world: World, y?: number): void {
  c.x = x;
  c.z = z;
  c.yaw = yaw;
  c.y = world.driveHeightAt(x, z, y);
  c.vx = c.vy = c.vz = 0;
  c.yawRate = c.pitchRate = c.rollRate = 0;
  // Lying on the ground at its own angle (a reset on a bank or a ramp sits flat on it).
  const sl = world.slopeAt(x, z, y);
  c.pitch = -atan2(sl.gx * sin(yaw) + sl.gz * cos(yaw), 1);
  c.roll = atan2(sl.gx * cos(yaw) - sl.gz * sin(yaw), 1);
  c.steerAngle = 0;
  c.rearGrip = 1;
  c.clutchKick = 0;
  c.spinFront = c.spinRear = 0;
  c.gear = 1;
  c.shiftTimer = 0;
  for (const w of c.wheels) {
    w.compression = 0;
    w.spinRate = 0;
  }
}

const RPM_PER_RADS = 60 / (2 * Math.PI);
/** Most the body pitches or rolls away from the ground's own angle (rad): suspension geometry, not tuning. */
const BODY_LEAN = 0.15;

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
    if (inp.brake > 0.5 && inp.throttle < 0.1 && vLong < 0.8) c.reverseHold += dt;
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
      const rpmNow = wheelRpm(t, c.gear, vLong);
      if (c.gear < nGears && rpmNow > up && vLong > 0) {
        c.gear++;
        c.shiftTimer = t.gearbox.shiftTime;
      } else if (c.gear > 1 && rpmNow < t.gearbox.downshiftRpmFrac * t.engine.redline && wheelRpm(t, c.gear - 1, vLong) < up * 0.9) {
        c.gear--;
        c.shiftTimer = t.gearbox.shiftTime * 0.6;
      }
    }
  }

  // ---- engine ----
  const ratio = gearRatio(t, c.gear);
  const wr = wheelRpm(t, c.gear, vLong);
  const lowGear = c.gear === 1 || c.gear === -1;
  const clutchRpm = t.engine.idleRpm + drive * (t.engine.launchRpm - t.engine.idleRpm);
  const split = driveSplit(t);
  // Spinning driven wheels turn faster than the road: the engine flares above road speed rpm.
  const spinNow = Math.max(split.front > 0 ? c.spinFront : 0, split.rear > 0 ? c.spinRear : 0);
  const spinWr = wr + spinNow * t.traction.spinRpm;
  // Clutch slip before this tick's rpm update: revs above the wheels (launch, clutch dump).
  const clutchSlipRpm = Math.max(0, c.rpm - spinWr);
  let rpmTarget = Math.max(spinWr, lowGear ? clutchRpm : t.engine.idleRpm);
  if (c.shiftTimer > 0) rpmTarget = Math.max(t.engine.idleRpm, wr);
  c.rpm = approach(c.rpm, Math.min(rpmTarget, t.engine.redline + 150), 24000 * dt);

  c.throttle = drive;
  c.nitroActive = inp.nitrous && c.nitro > 0 && c.gear > 0 && drive > 0.2;
  if (c.nitroActive) c.nitro = Math.max(0, c.nitro - dt / t.nitrous.capacity);

  let engineTorque = 0;
  if (c.shiftTimer === 0) {
    if (c.rpm < t.engine.redline) engineTorque = torqueAt(t, c.rpm) * t.engine.torqueMul * drive;
    if (c.nitroActive) engineTorque *= t.nitrous.torqueMul;
    // Dumping the clutch at high revs (launch, clutch kick) adds the flywheel's energy on top.
    const dump = c.clutchKick > 0 ? 1 : clamp(clutchSlipRpm / t.engine.redline, 0, 1);
    if (engineTorque > 0) engineTorque *= 1 + t.traction.launchBoost * dump;
    if (drive < 0.05 && c.gear > 0) engineTorque -= t.engine.engineBraking * clamp(c.rpm / t.engine.redline, 0, 1) * sign(vLong);
  }
  let driveForce = (engineTorque * ratio * t.gearbox.finalDrive * t.gearbox.efficiency) / t.geometry.wheelRadius;
  if (c.gear < 0) {
    driveForce = -driveForce;
    if (vLong < -t.gearbox.reverseMaxSpeed) driveForce = 0;
  }

  // ---- steering ----
  const limit = lerp(t.steering.maxDeg, t.steering.highSpeedDeg, clamp(speed / t.steering.fadeSpeed, 0, 1)) * DEG;
  let target = -inp.steer * limit;
  if (speed > 5 && target !== 0 && sign(target) === sign(beta)) {
    // steering into a slide (counter steer) gets extra lock
    target = -inp.steer * (limit + abs(beta) * t.steering.counterSteerAllowance);
  }
  c.steerAngle = approach(c.steerAngle, target, t.steering.rateDegPerSec * DEG * dt);

  // ---- drift state ----
  if (inp.throttle < 0.3) {
    c.throttleOffTime += dt;
  } else if (c.prevThrottle < 0.3) {
    // throttle stab after a short lift while steering hard = clutch kick
    if (c.throttleOffTime > 0.04 && c.throttleOffTime < 0.35 && speed > 14 && abs(inp.steer) > 0.55 && c.gear > 0) c.clutchKick = t.drift.clutchKickTime;
    c.throttleOffTime = 0;
  }
  c.prevThrottle = inp.throttle;
  let gripTarget = 1;
  if (inp.handbrake) gripTarget = Math.min(gripTarget, t.drift.handbrakeRearGrip);
  if (c.clutchKick > 0) {
    gripTarget = Math.min(gripTarget, t.drift.clutchKickRearGrip);
    // Kicking the clutch breaks the driven wheels loose (traction control would catch it).
    if (c.clutchKick === t.drift.clutchKickTime && !c.tractionControl) {
      if (split.front > 0) c.spinFront = Math.max(c.spinFront, t.traction.clutchKickSpin);
      if (split.rear > 0) c.spinRear = Math.max(c.spinRear, t.traction.clutchKickSpin);
    }
    c.clutchKick = Math.max(0, c.clutchKick - dt);
  }
  // Traction control also stops power oversteer.
  if (!c.tractionControl && abs(beta) > t.drift.powerOversteerMinSlipDeg * DEG && speed > 8 && drive > 0.5 && c.gear > 0) {
    gripTarget = Math.min(gripTarget, lerp(1, t.drift.powerOversteerGrip, (drive - 0.5) / 0.5));
  }
  c.rearGrip = gripTarget < c.rearGrip ? approach(c.rearGrip, gripTarget, t.drift.gripDropRate * dt) : approach(c.rearGrip, gripTarget, t.drift.gripRecoverRate * dt);

  // District surfaces (concrete, grass, water, cobbles) drive like one of the tuned ones.
  const sp = SURFACE_PHYSICS[c.surface];
  const surfaceGrip = sp === 'road' ? 1 : sp === 'sidewalk' ? t.surface.sidewalkGrip : sp === 'cobble' ? t.surface.cobbleGrip : t.surface.offroadGrip;
  const dragMul = c.drafting ? t.nitrous.draftDragMul : 1;

  // Traction control stability: cut the throttle once the body slides past a few degrees.
  let tcCut = false;
  const tcSlip = t.traction.tcMaxSlipDeg * DEG;
  if (c.tractionControl && driveForce > 0 && speed > 6 && abs(beta) > tcSlip) {
    driveForce *= Math.max(0.2, 1 - (abs(beta) - tcSlip) / (10 * DEG));
    tcCut = true;
  }

  const yawKick = inp.handbrake && c.gear > 0 ? -inp.steer * t.drift.handbrakeYawTorque * clamp(speed / 15, 0, 1) : 0;
  const ctl: Controls = { driveForce, brake, handbrake: inp.handbrake ? 1 : 0, surfaceGrip, dragMul, drive, yawKick, frontShare: split.front };
  const h = dt / SUBSTEPS;
  c.bottomOut = 0;
  for (let s = 0; s < SUBSTEPS; s++) tcCut = integrate(c, t, ctl, world, h) || tcCut;
  c.tcActive = tcCut;
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
    const axleSpin = i < 2 ? c.spinFront : c.spinRear;
    let rate = vLong2 / r;
    if (i >= 2 && inp.handbrake) rate = 0;
    else rate += (c.gear < 0 ? -1 : 1) * axleSpin * 40;
    w.spinRate = rate;
    w.spin = (w.spin + rate * dt) % (Math.PI * 2);
    const smoke = (i >= 2 && inp.handbrake && c.speed > 3 ? 0.6 : 0) + axleSpin * 0.8;
    w.skid = w.contact ? Math.min(1.6, clamp((abs(w.slip) - 6 * DEG) / (20 * DEG), 0, 1) + smoke) : 0;
  }
}

interface Controls {
  driveForce: number;
  brake: number;
  handbrake: number;
  surfaceGrip: number;
  dragMul: number;
  drive: number;
  yawKick: number;
  /** Share of driveForce sent to the front axle. */
  frontShare: number;
}

const wFmax = [0, 0, 0, 0];
const wLong = [0, 0, 0, 0];
const wAlpha = [0, 0, 0, 0];
const wLongAvail = [0, 0, 0, 0];
const axleDrive = [0, 0];

/**
 * Driven axle wheelspin. Demand = axle drive force / what its tires can still
 * transmit forward after cornering (friction circle). Above `breakaway` the
 * wheels break loose; the spin level grows with the excess, and once spinning
 * the threshold drops to breakaway * spinHold (a spinning tire grips less).
 * Traction control instead caps demand just under the limit.
 * Returns true when traction control cut the drive force.
 */
function updateWheelspin(c: CarState, t: CarTuning, ctl: Controls, h: number): boolean {
  const tr = t.traction;
  let cut = false;
  for (let a = 0; a < 2; a++) {
    const share = a === 0 ? ctl.frontShare : 1 - ctl.frontShare;
    let F = ctl.driveForce * share;
    let spin = a === 0 ? c.spinFront : c.spinRear;
    const avail = wLongAvail[a * 2] + wLongAvail[a * 2 + 1];
    const powered = share > 0 && ctl.drive > 0.05 && F * (c.gear < 0 ? -1 : 1) > 0;
    let demand = powered ? abs(F) / Math.max(1, avail) : 0;
    if (c.tractionControl && demand > tr.tcSlipTarget) {
      F *= tr.tcSlipTarget / demand;
      demand = tr.tcSlipTarget;
      cut = true;
    }
    const threshold = tr.breakaway * (spin > 0.05 ? tr.spinHold : 1);
    const target = a === 1 && ctl.handbrake > 0 ? 0 : clamp((demand - threshold) * tr.spinPerExcess, 0, 1);
    spin = approach(spin, target, (target > spin ? tr.spinBuildRate : tr.spinRecoverRate) * h);
    axleDrive[a] = F;
    if (a === 0) c.spinFront = spin;
    else c.spinRear = spin;
  }
  return cut;
}

/** One physics substep. Returns true if traction control cut the drive force. */
function integrate(c: CarState, t: CarTuning, ctl: Controls, world: World, h: number): boolean {
  const m = t.mass;
  const geo = t.geometry;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const lx = fz;
  const lz = -fx;
  const vLong = c.vx * fx + c.vz * fz;
  const vLat = c.vx * lx + c.vz * lz;
  const speed = sqrt(c.vx * c.vx + c.vz * c.vz);

  // Box approximations for inertia.
  const L = geo.halfLength * 2;
  const W = geo.halfWidth * 2;
  const Hh = 1.3;
  const Iz = ((m * (L * L + W * W)) / 12) * t.yawInertiaScale;
  const Ip = (m * (L * L + Hh * Hh)) / 12;
  const Ir = (m * (W * W + Hh * Hh)) / 12;

  // ---- suspension ----
  const sus = t.suspension;
  const omega = 2 * Math.PI * sus.frequency;
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
  const loads = [0, 0, 0, 0];
  let contacts = 0;
  for (let i = 0; i < 4; i++) {
    const [wv, , wu] = geo.wheels[i];
    const w = c.wheels[i];
    const wx = c.x + fx * wu + lx * wv;
    const wz = c.z + fz * wu + lz * wv;
    // Wheels ride the paving: up onto a sidewalk over its curb, not through it.
    const ground = world.driveHeightAt(wx, wz, c.y);
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
    loads[i] = F;
    sumF += F;
    pitchTorque += -wu * F;
    rollTorque += wv * F;
  }

  // ---- tires ----
  const cosd = cos(c.steerAngle);
  const sind = sin(c.steerAngle);
  const peak = t.tires.peakSlipDeg * DEG;
  const full = t.tires.fullSlideDeg * DEG;
  const down = (t.aero.downforce * speed * speed) / 4;
  const loadCap = (t.tires.loadCap * m * GRAVITY) / 4;
  const gripAt = (a: number) => (a < peak ? a / peak : 1 - (1 - t.tires.slideGrip) * Math.min(1, (a - peak) / (full - peak)));
  // Pass 1: grip, slip angle and how much forward grip each tire has left after cornering.
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
    const mu = (front ? t.tires.gripFront : t.tires.gripRear * c.rearGrip) * ctl.surfaceGrip;
    const alpha = atan2(wt, Math.max(abs(wl), 2.5));
    const lat = gripAt(abs(alpha));
    // Grip stops growing past loadCap times the static wheel load: a landing or a bump stop hit on one
    // wheel loads the spring, not the tire, so it cannot turn into a sideways kick that spins the car.
    wFmax[i] = w.contact ? mu * (Math.min(loads[i], loadCap) + down) : 0;
    wLong[i] = wl;
    wAlpha[i] = alpha;
    const used = lat * t.traction.cornerCoupling;
    wLongAvail[i] = wFmax[i] * sqrt(Math.max(0.04, 1 - used * used));
  }
  const tcCut = updateWheelspin(c, t, ctl, h);
  // Pass 2: forces.
  let Fu = 0;
  let Fv = 0;
  let torque = 0;
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i];
    if (!w.contact) {
      w.slip = 0;
      continue;
    }
    const front = i < 2;
    const [wv, , wu] = geo.wheels[i];
    const cd = front ? cosd : 1;
    const sd = front ? sind : 0;
    const wl = wLong[i];
    const pt = vLat + c.yawRate * wu;
    const wt = -(vLong - c.yawRate * wv) * sd + pt * cd;
    const Fmax = wFmax[i];
    const spin = front ? c.spinFront : c.spinRear;

    // Drive: half the axle force per wheel, limited to what the tire transmits (less while spinning).
    const Fd = axleDrive[front ? 0 : 1] / 2;
    let Fx = sign(Fd) * Math.min(abs(Fd), Math.max(wLongAvail[i], abs(Fd) > wLongAvail[i] ? Fmax * 0.2 : 0) * lerp(1, t.traction.spinLongGrip, spin));
    // Brake force split across the axle by load (EBD) so a light inside wheel does not lock.
    const axleLoad = front ? loads[0] + loads[1] : loads[2] + loads[3];
    const share = axleLoad > 1 ? loads[i] / axleLoad : 0.5;
    const brakeF = ctl.brake * t.brakes.force * (front ? t.brakes.frontBias : 1 - t.brakes.frontBias) * share + (!front ? (ctl.handbrake * t.brakes.handbrakeForce) / 2 : 0);
    if (brakeF > 0) {
      // Braking opposes wheel motion and never reverses it within a step.
      const stop = (wl * (m / 4)) / h;
      Fx -= clamp(stop, -brakeF, brakeF);
    }
    if (abs(Fx) > Fmax) Fx = sign(Fx) * Fmax;
    // A spinning axle loses most of its sideways grip: power oversteer (rear) or understeer (front).
    const latAvail = Math.max(t.tires.minLateralShare * Fmax, sqrt(Math.max(0, Fmax * Fmax - Fx * Fx))) * lerp(1, t.traction.spinLateralGrip, spin);
    const alpha = wAlpha[i];
    w.slip = alpha;
    let Fy = -sign(alpha) * gripAt(abs(alpha)) * latAvail;
    const maxFy = ((m / 4) * abs(wt)) / h;
    if (abs(Fy) > maxFy) Fy = sign(Fy) * maxFy;

    const fu = Fx * cd - Fy * sd;
    const fv = Fx * sd + Fy * cd;
    Fu += fu;
    Fv += fv;
    torque += wu * fv - wv * fu;
  }

  // ---- body forces ----
  const drag = t.aero.drag * ctl.dragMul;
  Fu -= drag * vLong * speed + t.tires.rollingResistance * vLong;
  Fv -= drag * vLat * speed;
  // Dirt and cobbles drag on the tires: a constant force once rolling (eased in below 1 m/s).
  const sp = SURFACE_PHYSICS[c.surface];
  const surfaceDrag = sp === 'offroad' ? t.surface.offroadDrag : sp === 'cobble' ? t.surface.cobbleDrag : 0;
  if (surfaceDrag > 0) Fu -= surfaceDrag * sign(vLong) * Math.min(1, abs(vLong));
  if (c.nitroActive && contacts > 0) Fu += t.nitrous.force;
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
  if (ctl.brake > 0 && contacts > 0) Fu -= sign(vLong) * Math.min((t.brakes.assistDecel * ctl.brake * contacts * m) / 4, (abs(vLong) * m) / h);

  const Fwx = Fu * fx + Fv * lx;
  const Fwz = Fu * fz + Fv * lz;

  c.vx += (Fwx / m) * h;
  c.vz += (Fwz / m) * h;
  c.yawRate += ((torque + (contacts > 0 ? ctl.yawKick : 0) - t.drift.yawDamping * c.yawRate) / Iz) * h;

  // ---- drift aids ----
  const vLongN = c.vx * fx + c.vz * fz;
  const vLatN = c.vx * lx + c.vz * lz;
  const beta = speed > 3 ? atan2(vLatN, abs(vLongN)) : 0;
  const maxSlip = t.drift.maxSlipDeg * DEG;
  if (abs(beta) > maxSlip && contacts > 0) {
    c.yawRate += ((sign(beta) * t.drift.assistTorque * (abs(beta) - maxSlip) * 4) / Iz) * h;
  }
  if (abs(beta) > 6 * DEG && ctl.drive > 0.3 && ctl.driveForce > 0 && contacts > 0 && vLongN > 0) {
    // Bend velocity toward the nose so drifts keep their speed.
    const th = sign(beta) * Math.min(abs(beta), t.drift.driftCarve * ctl.drive * h);
    const ct = cos(th);
    const st = sin(th);
    const nl = vLongN * ct + vLatN * st;
    const nt = -vLongN * st + vLatN * ct;
    c.vx = nl * fx + nt * lx;
    c.vz = nl * fz + nt * lz;
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

  // ---- heave, pitch, roll ----
  c.vy += (sumF / m - GRAVITY) * h;
  c.y += c.vy * h;
  c.pitchRate += ((pitchTorque - m * c.aLong * t.cgHeight) / Ip) * h;
  c.rollRate += ((rollTorque + m * c.aLat * t.cgHeight) / Ir) * h;
  // The body leans at most BODY_LEAN from the ground's own angle in the car's frame: level on a street,
  // laid over on a bank, pitched up a ramp (and in the air, over whatever it flies across). A rate
  // pushing past the limit stops there.
  const groundPitch = -atan2(sl.gx * fx + sl.gz * fz, 1);
  const groundRoll = atan2(sl.gx * lx + sl.gz * lz, 1);
  if (contacts === 0) {
    // In the air the body levels out over the ground below (arcade air control, critically damped at
    // airLevel rad/s), so a jump comes down flat on all four wheels instead of on its nose.
    const w = sus.airLevel;
    c.pitchRate += (w * w * (groundPitch - c.pitch) - 2 * w * c.pitchRate) * h;
    c.rollRate += (w * w * (groundRoll - c.roll) - 2 * w * c.rollRate) * h;
  }
  c.pitch += c.pitchRate * h;
  c.roll += c.rollRate * h;
  if (c.pitch > groundPitch + BODY_LEAN) {
    c.pitch = groundPitch + BODY_LEAN;
    if (c.pitchRate > 0) c.pitchRate = 0;
  } else if (c.pitch < groundPitch - BODY_LEAN) {
    c.pitch = groundPitch - BODY_LEAN;
    if (c.pitchRate < 0) c.pitchRate = 0;
  }
  if (c.roll > groundRoll + BODY_LEAN) {
    c.roll = groundRoll + BODY_LEAN;
    if (c.rollRate > 0) c.rollRate = 0;
  } else if (c.roll < groundRoll - BODY_LEAN) {
    c.roll = groundRoll - BODY_LEAN;
    if (c.rollRate < 0) c.rollRate = 0;
  }
  const ground = world.driveHeightAt(c.x, c.z, c.y);
  if (c.y < ground - 0.35) {
    if (c.vy < 0 && -c.vy * h > c.bottomOut) {
      c.bottomOut = -c.vy * h;
      c.bottomWheel = -1;
    }
    c.y = ground - 0.35;
    if (c.vy < 0) c.vy = 0;
  }
  return tcCut;
}

/** Refill nitrous from style: drifting, near misses and drafting. Call once per tick after collisions. */
export function refillNitrous(c: CarState, t: CarTuning): void {
  let add = 0;
  if (c.drifting) add += t.nitrous.refillDrift * Math.min(1, abs(c.slipAngle) / (30 * DEG));
  if (c.nearMiss) add += t.nitrous.refillNearMiss;
  if (c.drafting) add += t.nitrous.refillDraft;
  c.nitro = Math.min(1, c.nitro + add * DT);
}
