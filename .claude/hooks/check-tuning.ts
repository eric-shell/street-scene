/**
 * Headless check of src/sim/drivingParams.json: merge and validate every car's
 * tuning (stock parts) exactly as the game does at startup, so a bad edit
 * surfaces here instead of in the browser.
 *   npx tsx .claude/hooks/check-tuning.ts
 */
import { CAR_IDS, getBaseTuning } from '../../src/sim/tuning';
import { stockPerformance, tuningForBuild } from '../../src/sim/build';

for (const id of CAR_IDS) {
  getBaseTuning(id);
  tuningForBuild(id, stockPerformance());
}
console.log(`drivingParams.json ok (${CAR_IDS.join(', ')})`);
