/**
 * Downtown renderer: buildings, sidewalks and signs are still drawn by
 * render/cityMeshes.ts; this hook is where per block dressing (rooftop
 * clutter, alley lights between towers, block specific signage) goes.
 */
import type { DistrictRenderer } from './kit';

export const downtownRenderer: DistrictRenderer = {
  kinds: ['downtown'],
  build() {},
};
