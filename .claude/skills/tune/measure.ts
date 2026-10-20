/**
 * Headless car measurements from the real sim (src/sim/stats.ts): mass and
 * drivetrain, redline speed in every gear, and top speed / 0-100 km/h / grip /
 * nitrous for each performance tier.
 *   npx tsx .claude/skills/tune/measure.ts [carId ...]
 */
import { CAR_IDS, PERFORMANCE_CATEGORIES, TIER_NAMES, Tier, driveSplit, getBaseTuning } from '../../../src/sim/tuning';
import { PerformanceBuild, tuningForBuild } from '../../../src/sim/build';
import { measureStats } from '../../../src/sim/stats';

const ids = process.argv.length > 2 ? process.argv.slice(2) : CAR_IDS;
const tierBuild = (tier: Tier): PerformanceBuild => Object.fromEntries(PERFORMANCE_CATEGORIES.map((c) => [c, tier])) as PerformanceBuild;

for (const id of ids) {
  if (!CAR_IDS.includes(id)) {
    console.error(`unknown car "${id}" (known: ${CAR_IDS.join(', ')})`);
    process.exitCode = 1;
    continue;
  }
  const t = getBaseTuning(id);
  const split = driveSplit(t);
  const r = t.geometry.wheelRadius;
  console.log(`${id}: ${t.mass} kg, ${t.drivetrain.layout} ${Math.round(split.front * 100)}/${Math.round(split.rear * 100)}, redline ${t.engine.redline} rpm, ${t.gearbox.ratios.length} gears, final drive ${t.gearbox.finalDrive}`);
  const perGear = t.gearbox.ratios.map((g) => (((t.engine.redline / 60) * 2 * Math.PI * r) / (g * t.gearbox.finalDrive)) * 3.6);
  console.log(`  redline speed per gear: ${perGear.map((v) => v.toFixed(0)).join(' / ')} km/h`);
  for (const tier of [0, 1, 2, 3] as Tier[]) {
    const s = measureStats(tuningForBuild(id, tierBuild(tier)));
    console.log(`  ${TIER_NAMES[tier].padEnd(7)} top ${s.topSpeed.toFixed(1)} km/h, 0-100 ${s.zeroTo100.toFixed(2)} s, grip ${s.grip.toFixed(2)} g, nitrous ${s.nitrous.toFixed(1)} kN·s`);
  }
}
