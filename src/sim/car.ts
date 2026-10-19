/**
 * Arcade street car model. 2.5D rigid body: planar dynamics (x, z, yaw) from
 * four tire forces, plus heave, pitch and roll from four raycast suspension
 * springs against the terrain. Deterministic: fixed dt, no globals.
 */
import { DT, SUBSTEPS } from './constants';
import { InputFrame } from './input';
import { CarTuning, GRAVITY } from './tuning';
import { DEG, abs, approach, atan2, clamp, cos, lerp, sign, sin, sqrt } from './math';
import type { Surface, World } from '../city/world';

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
  /** 0..1 */
  nitro: number;
  nitroActive: boolean;
  rearGrip: number;
  clutchKick: number;
  throttleOffTime: number;
  prevThrottle: number;
  wheels: WheelState[];
  // telemetry, derived each tick
  speed: number;
  slipAngle: number;
  drifting: boolean;
  wheelspin: boolean;
  surface: Surface;
  impact: number;
  nearMiss: boolean;
  drafting: boolean;
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
    nitro: 1,
    nitroActive: false,
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
    nearMiss: false,
    drafting: false,
    aLong: 0,
    aLat: 0,
  };
}

/** Put a car at rest at a position (used for grid and reset to road). */
export function placeCar(c: CarState, x: number, z: number, yaw: number, world: World): void {
  c.x = x;
  c.z = z;
  c.yaw = yaw;
  c.y = world.heightAt(x, z);
  c.vx = c.vy = c.vz = 0;
  c.yawRate = c.pitchRate = c.rollRate = 0;
  c.pitch = c.roll = 0;
  c.steerAngle = 0;
  c.rearGrip = 1;
  c.clutchKick = 0;
  c.gear = 1;
  c.shiftTimer = 0;
  for (const w of c.wheels) {
    w.compression = 0;
    w.spinRate = 0;
  }
}

const RPM_PER_RADS = 60 / (2 * Math.PI);

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
  c.surface = world.surfaceAt(c.x, c.z);

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
  let rpmTarget = Math.max(wr, lowGear ? clutchRpm : t.engine.idleRpm);
  if (c.shiftTimer > 0) rpmTarget = Math.max(t.engine.idleRpm, wr);
  c.rpm = approach(c.rpm, Math.min(rpmTarget, t.engine.redline + 150), 24000 * dt);

  c.nitroActive = inp.nitrous && c.nitro > 0 && c.gear > 0 && drive > 0.2;
  if (c.nitroActive) c.nitro = Math.max(0, c.nitro - dt / t.nitrous.capacity);

  let engineTorque = 0;
  if (c.shiftTimer === 0) {
    if (c.rpm < t.engine.redline) engineTorque = torqueAt(t, c.rpm) * t.engine.torqueMul * drive;
    if (c.nitroActive) engineTorque *= t.nitrous.torqueMul;
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
    c.clutchKick = Math.max(0, c.clutchKick - dt);
  }
  if (abs(beta) > t.drift.powerOversteerMinSlipDeg * DEG && speed > 8 && drive > 0.5 && c.gear > 0) {
    gripTarget = Math.min(gripTarget, lerp(1, t.drift.powerOversteerGrip, (drive - 0.5) / 0.5));
  }
  c.rearGrip = gripTarget < c.rearGrip ? approach(c.rearGrip, gripTarget, t.drift.gripDropRate * dt) : approach(c.rearGrip, gripTarget, t.drift.gripRecoverRate * dt);

  const surfaceGrip = c.surface === 'road' ? 1 : c.surface === 'sidewalk' ? t.surface.sidewalkGrip : t.surface.offroadGrip;
  const dragMul = c.drafting ? t.nitrous.draftDragMul : 1;

  const yawKick = inp.handbrake && c.gear > 0 ? -inp.steer * t.drift.handbrakeYawTorque * clamp(speed / 15, 0, 1) : 0;
  const ctl: Controls = { driveForce, brake, handbrake: inp.handbrake ? 1 : 0, surfaceGrip, dragMul, drive, yawKick };
  const h = dt / SUBSTEPS;
  let spun = false;
  for (let s = 0; s < SUBSTEPS; s++) spun = integrate(c, t, ctl, world, h) || spun;
  c.wheelspin = spun;

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
    let rate = vLong2 / r;
    if (i >= 2) {
      if (inp.handbrake) rate = 0;
      else if (spun) rate += sign(driveForce) * 25;
    }
    w.spinRate = rate;
    w.spin = (w.spin + rate * dt) % (Math.PI * 2);
    w.skid = w.contact ? clamp((abs(w.slip) - 6 * DEG) / (20 * DEG), 0, 1) + (i >= 2 && (spun || inp.handbrake) && c.speed > 3 ? 0.6 : 0) : 0;
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
}

/** One physics substep. Returns true if the driven wheels are spinning. */
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
  const omega = 2 * Math.PI * t.suspension.frequency;
  const k = (m / 4) * omega * omega;
  const damp = 2 * t.suspension.dampingRatio * sqrt(k * (m / 4));
  const sag = (m * GRAVITY) / (4 * k);
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
    const ground = world.heightAt(wx, wz);
    const comp = ground - (c.y + wv * c.roll - wu * c.pitch);
    const compVel = (comp - w.compression) / h;
    w.compression = comp;
    let F = 0;
    if (comp + sag > 0) {
      F = k * (comp + sag) + damp * compVel;
      if (comp > t.suspension.travel) F += k * 8 * (comp - t.suspension.travel);
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
  let Fu = 0;
  let Fv = 0;
  let torque = 0;
  let spinning = false;
  for (let i = 0; i < 4; i++) {
    const w = c.wheels[i];
    if (!w.contact) {
      w.slip = 0;
      continue;
    }
    const front = i < 2;
    const [wv, , wu] = geo.wheels[i];
    const pl = vLong - c.yawRate * wv;
    const pt = vLat + c.yawRate * wu;
    const cd = front ? cosd : 1;
    const sd = front ? sind : 0;
    const wl = pl * cd + pt * sd;
    const wt = -pl * sd + pt * cd;
    const mu = (front ? t.tires.gripFront : t.tires.gripRear * c.rearGrip) * ctl.surfaceGrip;
    const Fmax = mu * (loads[i] + down);

    let Fx = 0;
    if (!front) Fx += ctl.driveForce / 2;
    // Brake force split across the axle by load (EBD) so a light inside wheel does not lock.
    const axleLoad = front ? loads[0] + loads[1] : loads[2] + loads[3];
    const share = axleLoad > 1 ? loads[i] / axleLoad : 0.5;
    const brakeF = ctl.brake * t.brakes.force * (front ? t.brakes.frontBias : 1 - t.brakes.frontBias) * share + (!front ? (ctl.handbrake * t.brakes.handbrakeForce) / 2 : 0);
    if (brakeF > 0) {
      // Braking opposes wheel motion and never reverses it within a step.
      const stop = (wl * (m / 4)) / h;
      Fx -= clamp(stop, -brakeF, brakeF);
    }
    if (abs(Fx) > Fmax) {
      if (!front && abs(ctl.driveForce / 2) > Fmax * 0.95 && ctl.drive > 0.3) spinning = true;
      Fx = sign(Fx) * Fmax;
    }
    const latAvail = Math.max(t.tires.minLateralShare * Fmax, sqrt(Math.max(0, Fmax * Fmax - Fx * Fx)));
    const alpha = atan2(wt, Math.max(abs(wl), 2.5));
    w.slip = alpha;
    const a = abs(alpha);
    const g = a < peak ? a / peak : 1 - (1 - t.tires.slideGrip) * Math.min(1, (a - peak) / (full - peak));
    let Fy = -sign(alpha) * g * latAvail;
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
  if (c.surface === 'offroad') {
    Fu -= t.surface.offroadDrag * sign(vLong) * Math.min(1, abs(vLong));
  }
  if (c.nitroActive && contacts > 0) Fu += t.nitrous.force;

  let Fwx = Fu * fx + Fv * lx;
  let Fwz = Fu * fz + Fv * lz;
  if (contacts > 0) {
    const sl = world.slopeAt(c.x, c.z);
    Fwx -= m * GRAVITY * sl.gx;
    Fwz -= m * GRAVITY * sl.gz;
  }

  c.vx += (Fwx / m) * h;
  c.vz += (Fwz / m) * h;
  c.yawRate += ((torque + (contacts > 0 ? ctl.yawKick : 0) - t.drift.yawDamping * c.yawRate) / Iz) * h;
  c.aLong = Fu / m;
  c.aLat = Fv / m;

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
  c.pitch = clamp(c.pitch + c.pitchRate * h, -0.15, 0.15);
  c.roll = clamp(c.roll + c.rollRate * h, -0.15, 0.15);
  const ground = world.heightAt(c.x, c.z);
  if (c.y < ground - 0.35) {
    c.y = ground - 0.35;
    if (c.vy < 0) c.vy = 0;
  }
  return spinning;
}

/** Refill nitrous from style: drifting, near misses and drafting. Call once per tick after collisions. */
export function refillNitrous(c: CarState, t: CarTuning): void {
  let add = 0;
  if (c.drifting) add += t.nitrous.refillDrift * Math.min(1, abs(c.slipAngle) / (30 * DEG));
  if (c.nearMiss) add += t.nitrous.refillNearMiss;
  if (c.drafting) add += t.nitrous.refillDraft;
  c.nitro = Math.min(1, c.nitro + add * DT);
}
