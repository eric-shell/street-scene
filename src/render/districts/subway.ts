/**
 * Subway renderer (placeholder): concrete pillars where the sim has them and
 * a plain elevated deck with side rails and a strip of lights underneath.
 * Content to add: steel girders, rails and sleepers, catenary, stations, a
 * train on a timetable, sparks and rumble.
 */
import type { DistrictRenderer } from './kit';
import { col, cylinder, orientedBox } from './kit';

export const subwayRenderer: DistrictRenderer = {
  kinds: ['subway'],
  build(kit, areas) {
    for (const a of areas) {
      const b = kit.builds[a.id];
      const H = a.params.deckHeight;
      const W = a.params.deckWidth;
      for (const p of b.props) if (p.kind === 'pillar') cylinder(kit.solid, p.x, p.z, p.size, kit.h(p.x, p.z) - 0.3, kit.h(p.x, p.z) + H, 8, col(0x55575f), false);
      const path = a.path;
      for (let i = 0; i + 1 < path.length; i++) {
        const p = path[i];
        const q = path[i + 1];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        const steps = Math.max(1, Math.ceil(len / 24));
        const ux = (q.x - p.x) / len;
        const uz = (q.z - p.z) / len;
        const nx = -uz * W;
        const nz = ux * W;
        for (let k = 0; k < steps; k++) {
          const ax = p.x + (q.x - p.x) * (k / steps) - nx / 2;
          const az = p.z + (q.z - p.z) * (k / steps) - nz / 2;
          const bx = p.x + (q.x - p.x) * ((k + 1) / steps) - nx / 2;
          const bz = p.z + (q.z - p.z) * ((k + 1) / steps) - nz / 2;
          const y = (kit.h(ax + nx / 2, az + nz / 2) + kit.h(bx + nx / 2, bz + nz / 2)) / 2 + H;
          orientedBox(kit.solid, ax, az, bx, bz, nx, nz, y, y + 1.1, col(0x3c3e46));
          orientedBox(kit.solid, ax, az, bx, bz, nx * 0.04, nz * 0.04, y + 1.1, y + 2.0, col(0x2c2e35));
          orientedBox(kit.solid, ax + nx, az + nz, bx + nx, bz + nz, -nx * 0.04, -nz * 0.04, y + 1.1, y + 2.0, col(0x2c2e35));
          orientedBox(kit.glow, ax + nx * 0.48, az + nz * 0.48, bx + nx * 0.48, bz + nz * 0.48, nx * 0.04, nz * 0.04, y - 0.05, y, col(0xff9a3c, 1.3));
        }
      }
    }
  },
};
