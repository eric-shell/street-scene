/**
 * Monument: a unique landmark (obelisk, statue plaza, arch) on a large block or at a big junction, visible from far away. Planned content: claim one interior face near the center or a high degree node, exclude buildings, add a plinth wall ring and a tall render-only spire.
 *
 * Reserved placeholder: disabled in CITY.districts.monument and plans nothing yet.
 * To implement: claim space in plan() through ctx.addArea (respect ctx.claims
 * and ctx.budget), and return walls / surfaces / height modifiers / openings in
 * build(). Its renderer is src/render/districts/monument.ts.
 */
import { CITY } from '../config';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';

export const monumentModule: DistrictModule = {
  kind: 'monument',
  phase: 'graph',
  plan() {
    if (!CITY.districts.monument.enabled) return;
  },
  build() {
    return emptyBuild();
  },
};
