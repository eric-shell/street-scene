/**
 * The performance half of a car build (shared/carBuild.ts holds the whole build and its visual half): a tier
 * per part category, and applyBuild, the only way the sim reads a build. Validation clamps imported tiers.
 */
import { CarTuning, PART_TIERS, PERFORMANCE_CATEGORIES, Tier, getBaseTuning, type PerformanceCategory } from './tuning';
import { num, obj } from '../shared/validate';

/** A tier per part category, plus the launch rpm the two-step holds at the line (rpm; 0 = off, free revs). */
export type PerformanceBuild = Record<PerformanceCategory, Tier> & { launchRpm: number };

/** The Tune tab's launch rpm picks: off, then LAUNCH_RPM.min up to the car's redline less the two-step's depth, in LAUNCH_RPM.step. */
export const LAUNCH_RPM = { min: 2500, step: 250 } as const;

/** The highest launch rpm a car's build can set: the two-step needs its depth of room under the redline. */
export function maxLaunchRpm(t: CarTuning): number {
  return Math.floor((t.engine.redline - t.launch.twoStepDepth) / LAUNCH_RPM.step) * LAUNCH_RPM.step;
}

/** The stock build: every category at tier 0, and the car's stock launch rpm when a car is named (off without one). */
export function stockPerformance(carId?: string): PerformanceBuild {
  const p = { launchRpm: carId ? defaultLaunchRpm(carId) : 0 } as PerformanceBuild;
  for (const c of PERFORMANCE_CATEGORIES) p[c] = 0;
  return p;
}

/** Pure: derive the tuning the sim uses from base tuning and performance parts. */
export function applyBuild(base: CarTuning, perf: PerformanceBuild): CarTuning {
  const t: CarTuning = JSON.parse(JSON.stringify(base));
  const p = validatePerformance(perf);
  t.engine.torqueMul *= PART_TIERS.engine.torqueMul[p.engine] * PART_TIERS.turbo.torqueMul[p.turbo] * PART_TIERS.exhaust.torqueMul[p.exhaust];
  t.engine.redline += PART_TIERS.engine.redlineAdd[p.engine];
  // Turbo adds more at the top of the rev range.
  const boost = PART_TIERS.turbo.highRpmBoost[p.turbo];
  t.engine.torqueCurve = t.engine.torqueCurve.map(([rpm, nm]) => [rpm, nm * (1 + boost * Math.max(0, (rpm - 3000) / 4000))]);
  t.gearbox.shiftTime = PART_TIERS.transmission.shiftTime[p.transmission];
  t.gearbox.finalDrive *= PART_TIERS.transmission.finalDriveMul[p.transmission];
  const grip = PART_TIERS.tires.gripMul[p.tires] * PART_TIERS.suspension.gripMul[p.suspension];
  t.tires.gripFront *= grip;
  t.tires.gripRear *= grip;
  t.suspension.frequency *= PART_TIERS.suspension.frequencyMul[p.suspension];
  t.steering.rateDegPerSec *= PART_TIERS.suspension.steerRateMul[p.suspension];
  t.brakes.force *= PART_TIERS.brakes.forceMul[p.brakes];
  t.brakes.assistDecel *= PART_TIERS.brakes.forceMul[p.brakes];
  t.mass *= PART_TIERS.weight.massMul[p.weight];
  t.nitrous.capacity = PART_TIERS.nitrous.capacity[p.nitrous];
  t.nitrous.force = PART_TIERS.nitrous.force[p.nitrous];
  // The launch rpm is the one build setting the sim reads as is: clamped under the (upgraded) redline.
  t.launch.twoStepRpm = p.launchRpm > 0 ? Math.min(Math.max(p.launchRpm, LAUNCH_RPM.min), maxLaunchRpm(t)) : 0;
  return t;
}

/** A car's stock launch rpm (drivingParams.json launch.defaultRpm; 0 = off), where its donor's owners launch. */
export function defaultLaunchRpm(carId: string): number {
  return getBaseTuning(carId).launch.defaultRpm;
}

export function tuningForBuild(carId: string, perf: PerformanceBuild): CarTuning {
  return applyBuild(getBaseTuning(carId), perf);
}

/**
 * Clamp an imported performance build. A build with no launch rpm (saved before launch control) takes the
 * car's stock one when the car is named (the garage), else off (the sim, so race configs, replays and the
 * AI's builds stay as they were); an explicit 0 is always off.
 */
export function validatePerformance(v: unknown, carId?: string): PerformanceBuild {
  const o = obj(v);
  const p = stockPerformance();
  for (const c of PERFORMANCE_CATEGORIES) p[c] = Math.round(num(o[c], 0, 3, 0)) as Tier;
  // Off, or a step of the Tune tab's slider; applyBuild clamps it under the car's redline.
  const lr = num(o.launchRpm, 0, 12000, carId ? defaultLaunchRpm(carId) : 0);
  p.launchRpm = lr >= LAUNCH_RPM.min ? Math.round(lr / LAUNCH_RPM.step) * LAUNCH_RPM.step : 0;
  return p;
}
