/**
 * Roundabout renderer: the fountain island (basin wall the sim collides with,
 * glowing water, a center jet) or the low grassy planter mound you can jump.
 * The ring road itself is part of the city road mesh. Content to add: lane
 * arrows, give way lines, island lighting, shrubs, a statue.
 */
import { CITY } from '../../city/config';
import { circlePolygon } from '../../city/districts/geom';
import type { DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex } from './kit';

export const roundaboutRenderer: DistrictRenderer = {
  kinds: ['roundabout'],
  build(kit, areas) {
    for (const a of areas) {
      const { x, z, island } = a.params;
      const y = kit.h(x, z);
      if (a.params.solid) {
        cylinder(kit.solid, x, z, island, y - 0.3, y + 0.9, 18, col(0x6f717c));
        cylinder(kit.glow, x, z, island - 0.6, y + 0.7, y + 0.72, 18, col(0x2a6cff, 0.8));
        cylinder(kit.solid, x, z, 1.2, y, y + 2.6, 10, col(0x8a8c96), true, 0.6);
        cylinder(kit.glow, x, z, 0.5, y + 2.6, y + 4.2, 8, col(0x9fd0ff, 1.4), true, 0.1);
      } else {
        drapeConvex(kit, kit.ground, circlePolygon(x, z, island, 24), 0.05, col(0x1f3d24), 3);
        cylinder(kit.solid, x, z, island + 0.25, y - 0.2, y + CITY.curbHeight + 0.05, 24, col(0x77797f), false);
      }
    }
  },
};
