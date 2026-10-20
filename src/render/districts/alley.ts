/**
 * Alley renderer (placeholder): warm string lights zig-zagging over raceway
 * alleys and a few dim lamps over back alley shortcuts. Content to add:
 * dumpsters, fire escapes, graffiti, steam vents, puddles.
 */
import type { DistrictRenderer } from './kit';
import { col, cylinder } from './kit';

export const alleyRenderer: DistrictRenderer = {
  kinds: ['alley', 'backAlley'],
  build(kit, areas) {
    for (const a of areas) {
      const g = kit.world.graph;
      const warm = col(0xffb35c, a.kind === 'alley' ? 2.2 : 1.2);
      for (const eid of a.edges) {
        const e = g.edges[eid];
        const p = g.nodes[e.a];
        const q = g.nodes[e.b];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        const nx = -(q.z - p.z) / len;
        const nz = (q.x - p.x) / len;
        const half = e.width / 2 + e.sidewalk * 0.5;
        const step = a.kind === 'alley' ? 4 : 10;
        for (let s = 16, k = 0; s < len - 16; s += step, k++) {
          const side = k % 2 ? 1 : -1;
          const t = (s % (step * 2)) / (step * 2);
          const x = p.x + ((q.x - p.x) * s) / len + nx * half * side * (1 - 2 * t) * 0.9;
          const z = p.z + ((q.z - p.z) * s) / len + nz * half * side * (1 - 2 * t) * 0.9;
          const y = kit.h(x, z) + (a.kind === 'alley' ? 6.2 : 4.5);
          cylinder(kit.glow, x, z, 0.12, y, y + 0.22, 4, warm);
        }
      }
    }
  },
};
