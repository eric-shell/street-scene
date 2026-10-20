/**
 * Waterfront: one map edge becomes a harbor promenade (piers, cranes, water beyond a sea wall). Planned content: claim the outer face strip along one side of the bounds, add a 'water' surface beyond a fence look, lower terrain past the sea wall.
 *
 * Reserved placeholder: disabled in CITY.districts.waterfront and plans nothing yet.
 * To implement: claim space in plan() through ctx.addArea (respect ctx.claims
 * and ctx.budget), and return walls / surfaces / height modifiers / openings in
 * build(). Its renderer is src/render/districts/waterfront.ts.
 */
import { CITY } from '../config';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';

export const waterfrontModule: DistrictModule = {
  kind: 'waterfront',
  phase: 'graph',
  plan() {
    if (!CITY.districts.waterfront.enabled) return;
  },
  build() {
    return emptyBuild();
  },
};
