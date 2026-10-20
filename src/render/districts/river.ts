/**
 * River renderer (placeholder): the concrete channel (floor, sloped banks,
 * bridge bodies, all following the sim terrain), a glowing water trickle,
 * parapets on bridge decks, culvert faces, bank top fences, ramp retaining
 * walls and the tunnel ends. Content to add: textures, graffiti, puddles,
 * reflections, bridge arches and lights, fence mesh, debris.
 */
import { riverCenter } from '../../city/districts/river';
import type { DistrictRenderer } from './kit';
import { col, groundVertex, wallBox } from './kit';

export const riverRenderer: DistrictRenderer = {
  kinds: ['river'],
  build(kit, areas) {
    for (const a of areas) {
      const p = a.params;
      const T = p.top + 0.5;
      const bridgesX = kit.builds[a.id].hints.filter((h) => h.kind === 'bridge').map((h) => (h.points[0].x + h.points[2].x) / 2);
      // Cross section samples: denser on the banks.
      const ls: number[] = [];
      for (let i = 0; i <= 8; i++) ls.push(-T + ((T - p.floor) * i) / 8);
      for (let i = 1; i < 4; i++) ls.push(-p.floor + (2 * p.floor * i) / 4);
      for (let i = 0; i <= 8; i++) ls.push(p.floor + ((T - p.floor) * i) / 8);
      const xs: number[] = [];
      for (let x = p.x0; x <= p.x1; ) {
        xs.push(x);
        const near = bridgesX.some((bx) => Math.abs(bx - x) < 26);
        x += near ? 1.5 : 8;
      }
      const floor = col(0x4a4d55);
      const bank = col(0x5d606a);
      let prev: number[] | null = null;
      for (const x of xs) {
        const zc = riverCenter(p, x);
        const row = ls.map((l) => groundVertex(kit, kit.ground, x, zc + l, 0.02, Math.abs(l) <= p.floor ? floor : bank));
        if (prev) for (let i = 0; i + 1 < row.length; i++) kit.ground.quadFacing(prev[i], prev[i + 1], row[i + 1], row[i], 0, 1, 0);
        prev = row;
      }
      // Water trickle down the middle.
      let pw: number[] | null = null;
      const water = col(0x1d4a8a, 0.55);
      for (const x of xs) {
        const zc = riverCenter(p, x);
        const row = [-2.2, 2.2].map((l) => groundVertex(kit, kit.paint, x, zc + l, 0.05, water));
        if (pw) kit.paint.quadFacing(pw[0], pw[1], row[1], row[0], 0, 1, 0);
        pw = row;
      }
    }
    const concrete = col(0x6a6c75);
    for (const w of kit.walls.get('parapet') ?? []) wallBox(kit, kit.solid, w, 0.45, 1.0, concrete);
    for (const w of kit.walls.get('fence') ?? []) wallBox(kit, kit.solid, w, 0.08, 1.4, col(0x30333a));
    for (const w of kit.walls.get('trench') ?? []) wallBox(kit, kit.solid, w, 0.6, 0.9, concrete, -0.3, kit.h((w.ax + w.bx) / 2 - w.nx * 2, (w.az + w.bz) / 2 - w.nz * 2) + 0.9);
    for (const w of kit.walls.get('channelEnd') ?? []) wallBox(kit, kit.solid, w, 3, 7, col(0x24262c));
    // Culvert faces: from the channel floor up to the deck behind them.
    for (const w of kit.walls.get('culvert') ?? []) {
      const top = Math.max(kit.h(w.ax - w.nx * 4.5, w.az - w.nz * 4.5), kit.h(w.bx - w.nx * 4.5, w.bz - w.nz * 4.5));
      wallBox(kit, kit.solid, w, 4, 0, col(0x55575f), -0.3, top + 0.05);
    }
  },
};
