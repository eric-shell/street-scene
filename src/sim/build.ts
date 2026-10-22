/**
 * The performance half of a car build (shared/carBuild.ts holds the whole build and its visual half): a tier
 * per part category, and applyBuild, the only way the sim reads a build. Validation clamps imported tiers.
 */
import { CarTuning, PART_TIERS, PERFORMANCE_CATEGORIES, Tier, getBaseTuning, type PerformanceCategory } from './tuning';
import { num, obj } from '../shared/validate';

export type PerformanceBuild = Record<PerformanceCategory, Tier>;

export function stockPerformance(): PerformanceBuild {
  const p = {} as PerformanceBuild;
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
  return t;
}

export function tuningForBuild(carId: string, perf: PerformanceBuild): CarTuning {
  return applyBuild(getBaseTuning(carId), perf);
}

export function validatePerformance(v: unknown): PerformanceBuild {
  const o = obj(v);
  const p = stockPerformance();
  for (const c of PERFORMANCE_CATEGORIES) p[c] = Math.round(num(o[c], 0, 3, 0)) as Tier;
  return p;
}
