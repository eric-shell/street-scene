/**
 * Park renderer: grass draped over the hills and low poly trees on the
 * trunks the sim collides with. Content to add: paths, lamps, benches,
 * hedges, a pond, better trees and grass shading.
 */
import type { DistrictRenderer } from './kit';
import { col, drapeConvex, tree } from './kit';

export const parkRenderer: DistrictRenderer = {
  kinds: ['park'],
  build(kit, areas) {
    for (const a of areas) {
      drapeConvex(kit, kit.ground, a.polygon, 0.04, col(0x1d3a22), 5);
      for (const p of kit.builds[a.id].props) if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height, (p.yaw % 1) * 0.5);
    }
  },
};
