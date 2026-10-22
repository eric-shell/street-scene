/**
 * Roundabout renderer: the island's ground draped over its profile (a lawn, or
 * the plaza's paving with its lip in stone), the curb ring around it, the
 * solid pieces the sim collides with (tree trunks, the plaza's dry basin with
 * glowing water, the knoll's sculpture on its plinth, the garden's urn), the
 * garden's cobbled paths, and the island's own light: amber studs along the
 * curb, a warm strip at the foot of the plaza's lip and an uplight ring round
 * a plinth, all merged into the glow builder so none of it costs anything per
 * frame. Lantern posts and the clutter are destructible props drawn by
 * render/street/props.ts; their pools and the wash over the island are
 * render/street/areaLights.ts. The ring road itself is part of the city road mesh
 * (cityMeshes drapes it finely under a roundabout).
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { ISLAND_HINT, islandFlatRadius } from '../../city/districts/roundabout';
import { circlePolygon } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import type { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundLine, groundVertex, prism, tree } from './kit';

/** Pieces around an island (vertices per ring of the draped ground, of a curb or basin wall). */
const SEGS = 40;
/** Radial spacing of the draped ground's rings (m): the bevels are 4 to 8 m wide and must read as curves. */
const RING_STEP = 1.2;
/** Curb studs: amber glow every this far along the island's curb (m). */
const STUD_SPACING = 3;
/** Cobble path pieces (m) so the paint follows the garden's rise. */
const PATH_PIECE = 1.5;

/**
 * Ring wall of radius r around (x, z): its foot `sink` below the ground at
 * every vertex, its top at top(groundY) (a level basin rim or a draped curb),
 * capped with a flat rim `rim` wide on the inside.
 */
function ringWall(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, r: number, sink: number, top: (y: number) => number, rim: number, color: THREE.Color): void {
  const foot: number[] = [];
  const head: number[] = [];
  const inner: number[] = [];
  for (let i = 0; i <= SEGS; i++) {
    const a = (i / SEGS) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const px = x + c * r;
    const pz = z + s * r;
    const y = kit.h(px, pz);
    const t = top(y);
    foot.push(gb.vertex(px, y - sink, pz, c, 0, s, i / SEGS, 0, color));
    head.push(gb.vertex(px, t, pz, c, 0, s, i / SEGS, 1, color));
    inner.push(gb.vertex(x + c * (r - rim), t, z + s * (r - rim), 0, 1, 0, i / SEGS, 1, color));
  }
  for (let i = 0; i < SEGS; i++) {
    const a = ((i + 0.5) / SEGS) * Math.PI * 2;
    gb.quadFacing(foot[i], foot[i + 1], head[i + 1], head[i], Math.cos(a), 0, Math.sin(a));
    gb.quadFacing(head[i], head[i + 1], inner[i + 1], inner[i], 0, 1, 0);
  }
}

/**
 * Ground draped over the island's profile between two radii: vertices on
 * concentric rings every `step` m, so a radial profile (a bevel, a dome, a
 * bowl) comes out as the curve it is. From rIn = 0 it is a disc with a fan at
 * the middle.
 */
function drapePolar(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, rIn: number, rOut: number, lift: number, color: THREE.Color, step = RING_STEP): void {
  const n = Math.max(1, Math.ceil((rOut - rIn) / step));
  let prev: number[] | null = null;
  let center = -1;
  if (rIn <= 1e-6) center = groundVertex(kit, gb, x, z, lift, color);
  for (let j = rIn <= 1e-6 ? 1 : 0; j <= n; j++) {
    const r = rIn + ((rOut - rIn) * j) / n;
    const ring: number[] = [];
    for (let i = 0; i < SEGS; i++) {
      const a = (i / SEGS) * Math.PI * 2;
      ring.push(groundVertex(kit, gb, x + Math.cos(a) * r, z + Math.sin(a) * r, lift, color));
    }
    for (let i = 0; i < SEGS; i++) {
      const k = (i + 1) % SEGS;
      if (prev) gb.quadFacing(prev[i], ring[i], ring[k], prev[k], 0, 1, 0);
      else if (center >= 0) gb.triFacing(center, ring[i], ring[k], 0, 1, 0);
    }
    prev = ring;
  }
}

/** Amber glow studs along a curb top (lift over the ground), every STUD_SPACING m. */
function studs(kit: DistrictKit, x: number, z: number, r: number, lift: number, color: THREE.Color): void {
  const n = Math.max(8, Math.round((2 * Math.PI * r) / STUD_SPACING));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const y = kit.h(px, pz) + lift;
    cylinder(kit.glow, px, pz, 0.13, y, y + 0.09, 6, color);
  }
}

/** A sculpture or urn on its plinth at the island's middle, with an uplight ring at the foot. */
function centrepiece(kit: DistrictKit, kind: string, x: number, z: number, R: number, height: number): void {
  const stone = col(0x8a8c96);
  const base = circlePolygon(x, z, R, 8, Math.PI / 8);
  prism(kit, kit.solid, base, height, col(0x6f717c), stone);
  const T = Math.max(...base.map((p) => kit.h(p.x, p.z))) + height;
  if (kind === 'sculpture') {
    // A tapered column with a glowing band near the top and a flared cap: reads at speed from the ring.
    cylinder(kit.solid, x, z, 0.55, T, T + 4.2, 10, stone, true, 0.22);
    cylinder(kit.glow, x, z, 0.3, T + 3.2, T + 3.45, 10, col(0x9fd0ff, 1.3));
    cylinder(kit.solid, x, z, 0.3, T + 4.2, T + 4.9, 10, stone, true, 0.85);
  } else {
    // A stone urn spilling foliage.
    cylinder(kit.solid, x, z, 0.4, T, T + 0.5, 10, stone, true, 0.75);
    cylinder(kit.solid, x, z, 0.75, T + 0.5, T + 1.3, 12, stone, true, 0.95);
    cylinder(kit.foliage, x, z, 1.1, T + 1.2, T + 2.0, 8, col(0x2a5a34), true, 0.4);
  }
  drapePolar(kit, kit.glow, x, z, R + 0.1, R + 0.6, 0.06, col(0xffc890, 0.55), 0.5);
}

export const roundaboutRenderer: DistrictRenderer = {
  kinds: ['roundabout'],
  build(kit, areas) {
    const curb = col(0x77797f);
    const lawn = col(0x1f3d24);
    const paving = col(0x8d8a84);
    const lipStone = col(0x6c6a66);
    const cobble = col(0x5d5a56);
    const amber = col(0xffb050, 1.3);
    for (const a of areas) {
      const { x, z, island } = a.params;
      const b = kit.builds[a.id];
      const r0 = islandFlatRadius(a.variant, island);
      if (a.variant === 'plaza') {
        drapePolar(kit, kit.ground, x, z, 0, r0, 0.03, paving);
        drapePolar(kit, kit.ground, x, z, r0, island, 0.03, lipStone, 0.8);
        // A warm strip where the lip's slope meets the floor: the step reads at night.
        drapePolar(kit, kit.glow, x, z, r0 + 0.15, r0 + 0.5, 0.05, col(0xffd0a0, 0.7), 0.5);
      } else {
        drapePolar(kit, kit.ground, x, z, 0, island, 0.05, lawn);
      }
      // The curb round the island (its top follows the ground) and the studs along it.
      ringWall(kit, kit.solid, x, z, island + 0.25, 0.2, (y) => y + CITY.curbHeight + 0.05, 0.25, curb);
      studs(kit, x, z, island + 0.1, CITY.curbHeight + 0.05, amber);
      // Cobbled garden paths, painted in pieces so they follow the bed's rise.
      for (const h of b.hints) {
        if (h.kind !== ISLAND_HINT.path) continue;
        const [p0, p1, p2, p3] = h.points;
        const A: Vec2 = { x: (p0.x + p3.x) / 2, z: (p0.z + p3.z) / 2 };
        const B: Vec2 = { x: (p1.x + p2.x) / 2, z: (p1.z + p2.z) / 2 };
        const n = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / PATH_PIECE));
        for (let k = 0; k < n; k++) {
          const t0 = k / n;
          const t1 = (k + 1) / n;
          groundLine(kit, kit.paint, { x: A.x + (B.x - A.x) * t0, z: A.z + (B.z - A.z) * t0 }, { x: A.x + (B.x - A.x) * t1, z: A.z + (B.z - A.z) * t1 }, h.values[0], 0.08, cobble);
        }
      }
      // Solid pieces: trunks, the basin, the centrepiece.
      for (const p of b.props) {
        if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height, (p.yaw % 1) * 0.5);
        else if (p.kind === 'basin') {
          // A level basin rim standing 0.85 m over the floor, blue water glowing just under it, a small jet.
          const T = kit.h(p.x, p.z) + p.height;
          ringWall(kit, kit.solid, p.x, p.z, p.size, 0.3, () => T, 0.45, col(0x6f717c));
          cylinder(kit.glow, p.x, p.z, p.size - 0.45, T - 0.17, T - 0.15, 24, col(0x2a6cff, 0.8));
          cylinder(kit.solid, p.x, p.z, 0.3, T - 0.3, T + 0.7, 8, col(0x8a8c96), true, 0.42);
          cylinder(kit.glow, p.x, p.z, 0.14, T + 0.7, T + 2.1, 6, col(0x9fd0ff, 1.4), true, 0.04);
        } else if (p.kind === 'sculpture' || p.kind === 'urn') centrepiece(kit, p.kind, p.x, p.z, p.size, p.height);
      }
    }
  },
};
