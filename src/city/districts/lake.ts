/**
 * Lake: a park sized body of water with a drivable shore road. Planned content: claim 2-4 adjacent faces, remove the edges between them, depress the terrain into a basin, 'water' surface with a fence ring.
 *
 * Reserved placeholder: disabled in CITY.districts.lake and plans nothing yet.
 * To implement: claim space in plan() through ctx.addArea (respect ctx.claims
 * and ctx.budget), and return walls / surfaces / height modifiers / openings in
 * build(). Its renderer is src/render/districts/lake.ts.
 */
import { CITY } from '../config';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';

export const lakeModule: DistrictModule = {
  kind: 'lake',
  phase: 'graph',
  plan() {
    if (!CITY.districts.lake.enabled) return;
  },
  build() {
    return emptyBuild();
  },
};
