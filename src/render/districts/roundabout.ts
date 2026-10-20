/**
 * Roundabout renderer: the fountain island (basin wall the sim collides with,
 * glowing water, a tiered fountain in the middle with a center jet) or the
 * low grassy planter mound you can jump. The ring road itself is part of the
 * city road mesh. The islands are big (15 to 20 m across), so their rims
 * follow the ground instead of standing level at the center's height. Content
 * to add: lane arrows, give way lines, island lighting, shrubs, a statue.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { circlePolygon } from '../../city/districts/geom';
import type { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex } from './kit';

/** Pieces around an island's rim. */
const RIM_SEGS = 40;

/**
 * Ring wall of radius r around (x, z): its foot `sink` below the ground at
 * every vertex, its top at top(groundY) (a level basin rim or a draped curb),
 * capped with a flat rim `rim` wide on the inside.
 */
function ringWall(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, r: number, sink: number, top: (y: number) => number, rim: number, color: THREE.Color): void {
  const foot: number[] = [];
  const head: number[] = [];
  const inner: number[] = [];
  for (let i = 0; i <= RIM_SEGS; i++) {
    const a = (i / RIM_SEGS) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const px = x + c * r;
    const pz = z + s * r;
    const y = kit.h(px, pz);
    const t = top(y);
    foot.push(gb.vertex(px, y - sink, pz, c, 0, s, i / RIM_SEGS, 0, color));
    head.push(gb.vertex(px, t, pz, c, 0, s, i / RIM_SEGS, 1, color));
    inner.push(gb.vertex(x + c * (r - rim), t, z + s * (r - rim), 0, 1, 0, i / RIM_SEGS, 1, color));
  }
  for (let i = 0; i < RIM_SEGS; i++) {
    const a = ((i + 0.5) / RIM_SEGS) * Math.PI * 2;
    gb.quadFacing(foot[i], foot[i + 1], head[i + 1], head[i], Math.cos(a), 0, Math.sin(a));
    gb.quadFacing(head[i], head[i + 1], inner[i + 1], inner[i], 0, 1, 0);
  }
}

export const roundaboutRenderer: DistrictRenderer = {
  kinds: ['roundabout'],
  build(kit, areas) {
    for (const a of areas) {
      const { x, z, island } = a.params;
      if (a.params.solid) {
        // A level basin: its rim stands 0.9 m over the highest ground under it.
        let hi = -Infinity;
        for (const p of circlePolygon(x, z, island, RIM_SEGS)) hi = Math.max(hi, kit.h(p.x, p.z));
        const T = hi + 0.9;
        ringWall(kit, kit.solid, x, z, island, 0.3, () => T, 0.55, col(0x6f717c));
        cylinder(kit.glow, x, z, island - 0.55, T - 0.2, T - 0.18, RIM_SEGS, col(0x2a6cff, 0.8));
        // Tiered fountain: a wide lower bowl, a column, a small upper bowl and the jet.
        const R = Math.min(4.2, island * 0.24);
        cylinder(kit.solid, x, z, R * 0.55, T - 0.2, T + 0.5, 16, col(0x8a8c96), true);
        cylinder(kit.solid, x, z, R, T + 0.5, T + 0.85, 24, col(0x8a8c96), true, R * 1.08);
        cylinder(kit.glow, x, z, R * 0.95, T + 0.86, T + 0.88, 24, col(0x3f86ff, 0.9));
        cylinder(kit.solid, x, z, 0.75, T + 0.85, T + 2.9, 10, col(0x8a8c96), true, 0.55);
        cylinder(kit.solid, x, z, 1.5, T + 2.9, T + 3.15, 16, col(0x8a8c96), true, 1.65);
        cylinder(kit.glow, x, z, 0.5, T + 3.15, T + 5.4, 8, col(0x9fd0ff, 1.4), true, 0.1);
      } else {
        drapeConvex(kit, kit.ground, circlePolygon(x, z, island, RIM_SEGS), 0.05, col(0x1f3d24), 3);
        ringWall(kit, kit.solid, x, z, island + 0.25, 0.2, (y) => y + CITY.curbHeight + 0.05, 0.25, col(0x77797f));
      }
    }
  },
};
