/**
 * Car stats for the garage, measured by actually driving the car in a flat,
 * endless test world with the real sim (so they always match the physics),
 * and the engine's power and torque curves read straight off the sim's own
 * torque curve (what the garage's dyno draws, so the garage never disagrees
 * with the physics). The sim stays metric: watts and Nm here, the display
 * converts (ui/kit/units.ts).
 */
import { createCar, stepCar, torqueAt } from './car';
import { CarTuning } from './tuning';
import type { World } from '../city/world';
import { NEUTRAL_INPUT } from './input';
import { TICK_HZ } from './constants';

const flatWorld = {
  heightAt: () => 0,
  driveHeightAt: () => 0,
  slopeAt: () => ({ gx: 0, gz: 0 }),
  surfaceAt: () => 'road',
} as unknown as World;

export interface CarStats {
  /** km/h reached after a long full throttle run (no nitrous). */
  topSpeed: number;
  /** Seconds from 0 to 100 km/h (the tuning tools and the stat bars). */
  zeroTo100: number;
  /** Seconds from 0 to 60 mph (26.8 m/s), the figure the garage shows. */
  zeroTo60: number;
  /** Peak lateral grip in g. */
  grip: number;
  /** Seconds of boost times boost force, in kN*s. */
  nitrous: number;
  /** Peak engine power at the crank (W), from the torque curve between idle and redline: not driven, so it costs nothing. */
  power: number;
  /** Peak engine torque (Nm), the same way. */
  torque: number;
  /** The car's mass (kg), as tuned: an engine swap moves it. */
  mass: number;
}

/**
 * The engine's output sampled evenly from idle to redline (`power[i]` and `torque[i]` at
 * `idle + i / (n - 1) * (redline - idle)`), with the peaks and where they fall.
 */
export interface PowerCurve {
  /** Lowest and highest rpm sampled (rpm): the engine's idle and redline. */
  idle: number;
  redline: number;
  /** Crank power (W) per sample: torque times angular speed. */
  power: number[];
  /** Crank torque (Nm) per sample: the sim's curve times the build's torque multiplier. */
  torque: number[];
  peakPower: number;
  /** Where the power peaks (rpm). */
  peakPowerRpm: number;
  peakTorque: number;
  /** Where the torque peaks (rpm). */
  peakTorqueRpm: number;
}

/** How many samples a power curve takes: about one per 100 rpm on a 6,000 rpm range, finer than the torque curve's own points. */
const CURVE_SAMPLES = 64;

/**
 * The engine's torque and power from idle to the redline, exactly as `stepCar`
 * applies them off the throttle (`torqueAt` times `torqueMul`): no gearing
 * bonus, boost or drivetrain losses, so the figure is the crank's.
 */
export function powerCurve(t: CarTuning, n = CURVE_SAMPLES): PowerCurve {
  const idle = t.engine.idleRpm;
  const redline = t.engine.redline;
  const power: number[] = [];
  const torque: number[] = [];
  const c: PowerCurve = { idle, redline, power, torque, peakPower: 0, peakPowerRpm: idle, peakTorque: 0, peakTorqueRpm: idle };
  for (let i = 0; i < n; i++) {
    const rpm = idle + (i / (n - 1)) * (redline - idle);
    const nm = torqueAt(t, rpm) * t.engine.torqueMul;
    const w = (nm * rpm * 2 * Math.PI) / 60;
    torque.push(nm);
    power.push(w);
    if (w > c.peakPower) {
      c.peakPower = w;
      c.peakPowerRpm = rpm;
    }
    if (nm > c.peakTorque) {
      c.peakTorque = nm;
      c.peakTorqueRpm = rpm;
    }
  }
  return c;
}

export function measureStats(t: CarTuning): CarStats {
  const c = createCar(0, 0, 0, 0);
  const inp = { ...NEUTRAL_INPUT, throttle: 1 };
  let zeroTo100 = 99;
  let zeroTo60 = 99;
  let top = 0;
  let still = 0;
  for (let i = 0; i < 60 * TICK_HZ; i++) {
    stepCar(c, t, inp, { world: flatWorld });
    const kmh = c.speed * 3.6;
    if (zeroTo100 === 99 && kmh >= 100) zeroTo100 = (i + 1) / TICK_HZ;
    if (zeroTo60 === 99 && kmh >= 60 * 1.609344) zeroTo60 = (i + 1) / TICK_HZ;
    if (kmh > top + 0.05) {
      top = kmh;
      still = 0;
    } else if (++still > 3 * TICK_HZ) break;
  }
  const curve = powerCurve(t);
  return {
    topSpeed: top,
    zeroTo100,
    zeroTo60,
    grip: ((t.tires.gripFront + t.tires.gripRear) / 2) * (1 + t.aero.downforce * 0.02),
    nitrous: (t.nitrous.capacity * t.nitrous.force) / 1000,
    power: curve.peakPower,
    torque: curve.peakTorque,
    mass: t.mass,
  };
}

/** 0..1 bars for the UI. */
export function statBars(s: CarStats): { topSpeed: number; acceleration: number; handling: number; nitrous: number; power: number; weight: number } {
  const n = (v: number, lo: number, hi: number) => Math.max(0.03, Math.min(1, (v - lo) / (hi - lo)));
  return {
    topSpeed: n(s.topSpeed, 170, 330),
    acceleration: n(1 / s.zeroTo100, 1 / 8, 1 / 2.4),
    handling: n(s.grip, 0.95, 1.45),
    nitrous: n(s.nitrous, 8, 32),
    // The stock roster runs from about 150 kW to 390 kW at the crank.
    power: n(s.power, 130_000, 400_000),
    // Not better or worse, so the bar simply grows with the mass: the roster runs from about 1,270 to 1,940 kg.
    weight: n(s.mass, 1100, 2000),
  };
}
