/**
 * The performance half of a car build (shared/carBuild.ts holds the whole build and its visual half): the
 * garage Tune tab's four setup sliders (suspension, gear ratio, differential, brake balance: five positions
 * each, 3 the stock car), its launch rpm and its antilag rpm, and applyBuild, the only way the sim reads a build. The sliders
 * trade one thing for another rather than add performance, so a setup suits a track, not a tier. Validation
 * clamps imported positions, and a build saved with the retired component upgrades starts on the stock setup.
 */
import { CarTuning, SETUP, SETUP_SLIDERS, STOCK_POSITION, getBaseTuning, type SetupPosition, type SetupSlider } from './tuning';
import { clamp01, pow } from './math';
import { num, obj } from '../shared/validate';

/**
 * A position per setup slider (1 left .. 5 right, 3 stock), plus the launch rpm the two-step holds at the line
 * (rpm; 0 = off, free revs) and the rpm rolling antilag holds a turbo car at (rpm; 0 = off; missing keeps the
 * car's own, as race configs, replays and the AI's builds from before the setting do).
 */
export type PerformanceBuild = Record<SetupSlider, SetupPosition> & { launchRpm: number; antilagRpm?: number };

/** The Tune tab's launch and antilag rpm picks: off, then LAUNCH_RPM.min up to the car's redline less the two-step's depth, in LAUNCH_RPM.step. */
export const LAUNCH_RPM = { min: 2500, step: 250 } as const;

/**
 * The component upgrades' categories (tiers 0..3), retired for the setup sliders. A saved build or share
 * code holding them predates the sliders: its tiers are dropped and it starts on the stock setup (its old
 * `suspension` tier is not a slider position).
 */
const RETIRED_UPGRADES = ['engine', 'turbo', 'exhaust', 'transmission', 'tires', 'brakes', 'weight', 'nitrous'] as const;

/** The highest launch rpm a car's build can set: the two-step needs its depth of room under the redline. */
export function maxLaunchRpm(t: CarTuning): number {
  return Math.floor((t.engine.redline - t.launch.twoStepDepth) / LAUNCH_RPM.step) * LAUNCH_RPM.step;
}

/** The stock build: every slider at the stock position, and the car's stock launch and antilag rpm when a car is named (launch off and the car's own antilag without one). */
export function stockPerformance(carId?: string): PerformanceBuild {
  const p = { launchRpm: carId ? defaultLaunchRpm(carId) : 0 } as PerformanceBuild;
  if (carId) p.antilagRpm = defaultAntilagRpm(carId);
  for (const s of SETUP_SLIDERS) p[s] = STOCK_POSITION;
  return p;
}

/** Whether every slider is on the stock position (the launch and antilag rpm aside): the build drives on the car's own tuning. */
export function isStockSetup(perf: PerformanceBuild): boolean {
  return SETUP_SLIDERS.every((s) => perf[s] === STOCK_POSITION);
}

/**
 * Pure: derive the tuning the sim uses from the car's base tuning and its setup. Every table holds the
 * identity at the stock position (tuning.ts checks), so a stock setup is the base tuning bit for bit.
 */
export function applyBuild(base: CarTuning, perf: PerformanceBuild): CarTuning {
  const t: CarTuning = JSON.parse(JSON.stringify(base));
  const p = validatePerformance(perf);
  // Suspension: springs, travel, turn in, and the grip it finds on smooth and on rough ground.
  const sus = SETUP.suspension;
  const k = p.suspension - 1;
  t.suspension.frequency *= sus.frequencyMul[k];
  t.suspension.travel *= sus.travelMul[k];
  t.steering.rateDegPerSec *= sus.steerRateMul[k];
  t.tires.gripFront *= sus.roadGripMul[k];
  t.tires.gripRear *= sus.roadGripMul[k];
  // Surface grips multiply the tires' (car.ts), so the rough ones take their own factor over the road's.
  const rough = sus.roughGripMul[k] / sus.roadGripMul[k];
  t.surface.offroadGrip *= rough;
  t.surface.cobbleGrip *= rough;
  // Gear ratio: the final drive moves the top gear and its limiter; first gear moves by firstGearMul and the
  // gears between blend evenly (each step the same share closer or wider), a close-ratio box on Short and a
  // wide one on Long. Real gearing barely moves acceleration, so the arcade torque bonus does (car.ts fades it
  // out toward top speed).
  const gr = SETUP.gearing;
  const g = p.gearing - 1;
  t.gearbox.finalDrive *= gr.finalDriveMul[g];
  const spread = gr.firstGearMul[g] / gr.finalDriveMul[g];
  if (spread !== 1) {
    const n = t.gearbox.ratios.length;
    t.gearbox.ratios = t.gearbox.ratios.map((r, i) => r * pow(spread, (n - 1 - i) / (n - 1)));
  }
  t.gearbox.torqueBonus += gr.torqueBonus[g];
  const d = p.differential - 1;
  t.drivetrain.diffOpen = clamp01(t.drivetrain.diffOpen + SETUP.differential.open[d]);
  t.drivetrain.diffLock = clamp01(t.drivetrain.diffLock + SETUP.differential.lock[d]);
  t.brakes.frontBias = clamp01(t.brakes.frontBias + SETUP.brakeBalance.frontBiasAdd[p.brakeBalance - 1]);
  // The launch and antilag rpm are the build settings the sim reads as is: clamped under the redline.
  const rpm = (x: number) => (x > 0 ? Math.min(Math.max(x, LAUNCH_RPM.min), maxLaunchRpm(t)) : 0);
  t.launch.twoStepRpm = rpm(p.launchRpm);
  if (p.antilagRpm !== undefined) t.launch.antilagRpm = rpm(p.antilagRpm);
  return t;
}

/** A car's stock launch rpm (drivingParams.json launch.defaultRpm; 0 = off), where its donor's owners launch. */
export function defaultLaunchRpm(carId: string): number {
  return getBaseTuning(carId).launch.defaultRpm;
}

/** A car's stock rolling antilag rpm (drivingParams.json launch.antilagRpm; 0 = off): on boost, near its torque peak. */
export function defaultAntilagRpm(carId: string): number {
  return getBaseTuning(carId).launch.antilagRpm;
}

export function tuningForBuild(carId: string, perf: PerformanceBuild): CarTuning {
  return applyBuild(getBaseTuning(carId), perf);
}

/**
 * Clamp an imported performance build: each slider to a whole position (missing ones stock), and every
 * slider stock for a build from before the sliders (RETIRED_UPGRADES). A build with no launch rpm (saved
 * before launch control) takes the car's stock one when the car is named (the garage), else off (the sim,
 * so race configs, replays and the AI's builds stay as they were); an explicit 0 is always off. The antilag
 * rpm likewise: missing takes the car's stock one in the garage and stays missing (the car's own) in the sim.
 */
export function validatePerformance(v: unknown, carId?: string): PerformanceBuild {
  const o = obj(v);
  const p = stockPerformance();
  if (!RETIRED_UPGRADES.some((c) => c in o)) for (const s of SETUP_SLIDERS) p[s] = Math.round(num(o[s], 1, 5, STOCK_POSITION)) as SetupPosition;
  // Off, or a step of the Tune tab's slider; applyBuild clamps it under the car's redline.
  const lr = num(o.launchRpm, 0, 12000, carId ? defaultLaunchRpm(carId) : 0);
  const step = (x: number) => (x >= LAUNCH_RPM.min ? Math.round(x / LAUNCH_RPM.step) * LAUNCH_RPM.step : 0);
  p.launchRpm = step(lr);
  if (o.antilagRpm !== undefined || carId) p.antilagRpm = step(num(o.antilagRpm, 0, 12000, carId ? defaultAntilagRpm(carId) : 0));
  return p;
}
