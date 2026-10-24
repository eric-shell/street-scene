/**
 * Headless car measurements from the real sim (src/sim/stats.ts): mass and
 * drivetrain, redline speed in every gear, top speed / 0-100 km/h / grip /
 * nitrous on the stock setup, then each Tune tab slider's five positions with
 * the others stock (top speed, 0-100 and grip move; the rest of what a slider
 * does shows in a corner, so use drift.ts and the tests for those).
 *   npx tsx .claude/skills/tune/measure.ts [carId ...]
 */
import { CAR_IDS, SETUP_POSITIONS, SETUP_SLIDERS, driveSplit, getBaseTuning } from '../../../src/sim/tuning';
import { stockPerformance, tuningForBuild } from '../../../src/sim/build';
import { measureStats } from '../../../src/sim/stats';

const ids = process.argv.length > 2 ? process.argv.slice(2) : CAR_IDS;

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
  const s = measureStats(tuningForBuild(id, stockPerformance()));
  console.log(`  stock    top ${s.topSpeed.toFixed(1)} km/h, 0-100 ${s.zeroTo100.toFixed(2)} s, grip ${s.grip.toFixed(2)} g, nitrous ${s.nitrous.toFixed(1)} kN·s`);
  for (const slider of SETUP_SLIDERS) {
    const cells = SETUP_POSITIONS.map((p) => {
      const st = measureStats(tuningForBuild(id, { ...stockPerformance(), [slider]: p }));
      return `${p}: ${st.topSpeed.toFixed(0)} / ${st.zeroTo100.toFixed(2)} / ${st.grip.toFixed(2)}`;
    });
    console.log(`  ${slider.padEnd(12)} (top km/h / 0-100 s / grip g) ${cells.join(' | ')}`);
  }
}
