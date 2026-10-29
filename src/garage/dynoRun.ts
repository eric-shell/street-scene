/**
 * What the garage's dyno presentation needs of a build, from its tuning: the
 * engine's power and torque curves as 0..1 shares of their peaks over the rpm
 * axis (what the wall screen draws), the peak figures in the units the game
 * speaks (hp, lb-ft), the gear the pull runs in and the axles that turn the
 * rollers. The curves are sampled by the sim (`sim/stats.ts powerCurve`, the
 * torque the physics itself applies), so the garage never disagrees with the
 * drive; the scene takes this whole and never reads the tuning. The pull's
 * feel (how long it takes, how the rollers coast) lives here as presentation
 * constants. Pure, so it can be unit tested.
 */
import type { CarTuning } from '../sim/tuning';
import { powerCurve } from '../sim/stats';
import { horsepower, poundFeet } from '../ui/kit/units';
import type { DynoPeaks } from './textures/effects';
import type { RevLoad } from './revModel';
import type { DynoDrive } from './props/atmosphere';

/** How the pull plays (presentation, not physics). */
export const PULL = {
  /** A roller dyno pull in a middle gear: idle to the redline at full pedal takes this long (s). */
  seconds: 5.5,
  /** The rollers coast the revs down from the redline over this long (s) when the pedal lifts. */
  coastSeconds: 9,
  /** The gear the pull runs in is the one whose redline lands nearest this road speed (km/h). */
  gearKmh: 160,
  /** A pull counts as finished when the revs reach this share of the way from idle to the redline. */
  doneAt: 0.985,
  /** A new pull starts when the pedal goes down with the revs under this share of the range. */
  restartBelow: 0.12,
  /** The dyno's wheels start rolling as the revs lift off idle and roll fully this far up the range (share of idle to redline). */
  wheelsEngage: 0.1,
  /** Strapped down the body hardly rocks: the share of the showroom's roll and squat a pull gives. */
  strapRock: 0.3,
} as const;

export interface DynoSetup {
  /** Power and torque at a point on the rpm axis (0 = idle, 1 = redline), each as a share of its peak (0..1). */
  power: (x: number) => number;
  torque: (x: number) => number;
  /** The peak figures (hp, lb-ft) and the rpm they fall at. */
  peaks: DynoPeaks;
  /** The pull gear's overall ratio (gear times final drive): engine turns per wheel turn. */
  overall: number;
  /** The axles on the rollers: the front for a front drive, the rear for a rear drive, both (two roller sets) for all wheel drive. */
  driven: DynoDrive;
  /** The wheel's rolling radius (m). */
  wheelRadius: number;
}

/** A sampled curve as a function of 0..1, linear between samples and scaled so its peak is 1. */
function share(samples: number[], peak: number): (x: number) => number {
  const last = samples.length - 1;
  return (x) => {
    const f = Math.max(0, Math.min(1, x)) * last;
    const i = Math.min(last - 1, Math.floor(f));
    return (samples[i] + (samples[i + 1] - samples[i]) * (f - i)) / peak;
  };
}

/** The gear whose redline speed is nearest `kmh`: its overall ratio with the final drive. */
export function pullRatio(t: CarTuning, kmh: number = PULL.gearKmh): number {
  let best = t.gearbox.ratios[0] * t.gearbox.finalDrive;
  let miss = Infinity;
  for (const r of t.gearbox.ratios) {
    const overall = r * t.gearbox.finalDrive;
    const v = ((t.engine.redline * 2 * Math.PI) / 60 / overall) * t.geometry.wheelRadius * 3.6;
    if (Math.abs(v - kmh) < miss) {
      miss = Math.abs(v - kmh);
      best = overall;
    }
  }
  return best;
}

/** The dyno's view of a build. */
export function dynoSetup(t: CarTuning): DynoSetup {
  const c = powerCurve(t);
  return {
    power: share(c.power, c.peakPower),
    torque: share(c.torque, c.peakTorque),
    peaks: { hp: horsepower(c.peakPower), lbft: poundFeet(c.peakTorque), hpRpm: c.peakPowerRpm, lbftRpm: c.peakTorqueRpm },
    overall: pullRatio(t),
    driven: t.drivetrain.layout === 'fwd' ? 'front' : t.drivetrain.layout === 'awd' ? 'all' : 'rear',
    wheelRadius: t.geometry.wheelRadius,
  };
}

/** The rev model's load for an engine's range: the climb of a pull and the rollers' coast (rpm/s). */
export function pullLoad(idle: number, redline: number): RevLoad {
  const range = Math.max(1, redline - idle);
  return { climb: range / PULL.seconds, coast: range / PULL.coastSeconds };
}
