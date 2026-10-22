/**
 * Park renderer: grass draped over the hills, low poly trees on the trunks
 * the sim collides with (a denser wood in one spot), and a gravel footpath
 * loop following the hills. Bushes, benches, bins and lantern posts are
 * destructible props drawn by render/street/props.ts; the light on the lawn is
 * render/street/areaLights.ts. Content to add: hedges, a pond, better trees and
 * grass shading.
 */
import type { DistrictRenderer } from './kit';
import { col, drapeConvex, groundLine, tree } from './kit';

/** Footpath strips are cut into pieces this long so they follow the hills (m). */
const PATH_PIECE = 3;

export const parkRenderer: DistrictRenderer = {
  kinds: ['park'],
  build(kit, areas) {
    const gravel = col(0x5a5446);
    for (const a of areas) {
      drapeConvex(kit, kit.ground, a.polygon, 0.04, col(0x1d3a22), 5);
      const b = kit.builds[a.id];
      for (const p of b.props) if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height, (p.yaw % 1) * 0.5);
      for (const h of b.hints) {
        if (h.kind !== 'path') continue;
        const pts = h.points;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const q = pts[(i + 1) % pts.length];
          const len = Math.hypot(q.x - p.x, q.z - p.z);
          const n = Math.max(1, Math.ceil(len / PATH_PIECE));
          for (let k = 0; k < n; k++) {
            const t0 = k / n;
            const t1 = (k + 1) / n;
            groundLine(kit, kit.paint, { x: p.x + (q.x - p.x) * t0, z: p.z + (q.z - p.z) * t0 }, { x: p.x + (q.x - p.x) * t1, z: p.z + (q.z - p.z) * t1 }, 2.2, 0.07, gravel);
          }
        }
      }
    }
  },
};
