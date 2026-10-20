/**
 * Infill renderer: parking lots (asphalt, painted bays), plazas (concrete at
 * sidewalk level), raised planters, fountains, low curbs around lots, and the
 * low 'boundary' walls that close every other gap in the street frontage.
 * Content to add: parked cars, bollards, benches, kiosks, lamp posts.
 */
import { CITY } from '../../city/config';
import type { DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, prism, wallBox } from './kit';

export const infillRenderer: DistrictRenderer = {
  kinds: ['infill'],
  build(kit, areas) {
    const asphalt = col(0x2a2c33);
    const concrete = col(0x6d6f78);
    const paint = col(0xd8dce6, 0.8);
    for (const a of areas) {
      const b = kit.builds[a.id];
      if (a.variant === 'lot') {
        drapeConvex(kit, kit.ground, a.polygon, 0.03, asphalt);
        for (const h of b.hints) if (h.kind === 'bay') groundLine(kit, kit.paint, h.points[0], h.points[1], 0.12, 0.05, paint);
      } else if (a.variant === 'plaza' || a.variant === 'cornerPlaza') {
        drapeConvex(kit, kit.ground, a.polygon, CITY.curbHeight, concrete);
      } else if (a.variant === 'planter') {
        prism(kit, kit.solid, a.polygon, 0.7, col(0x55565e), col(0x24442a));
      }
      for (const p of b.props) {
        if (p.kind !== 'fountain') continue;
        const y = kit.h(p.x, p.z);
        cylinder(kit.solid, p.x, p.z, p.size, y - 0.2, y + 0.75, 14, col(0x7a7c86));
        cylinder(kit.glow, p.x, p.z, p.size * 0.86, y + 0.55, y + 0.6, 14, col(0x2a6cff, 0.9));
        cylinder(kit.solid, p.x, p.z, 0.35, y, y + 2.2, 8, col(0x8a8c96));
      }
    }
    for (const w of kit.walls.get('boundary') ?? []) wallBox(kit, kit.solid, w, 0.35, 1.1, col(0x4a4c55));
    for (const w of kit.walls.get('lotEdge') ?? []) wallBox(kit, kit.solid, w, 0.4, 0.45, col(0x5a5c66));
  },
};
