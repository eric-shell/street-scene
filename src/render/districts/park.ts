/**
 * Park renderer: grass draped over the hills, low poly trees on the trunks
 * the sim collides with (a denser wood in one spot), a gravel footpath loop
 * following the hills, and the race passes' cobbled paths (city park.ts
 * parkPasses): a wide strip of darker cobbles bowed through the park with a
 * pale kerb line each side and low path lights along it (kit.glow), drawn on
 * the grass only (the path's street ends are asphalt). Bushes, benches, bins
 * and lantern posts are destructible props drawn by render/street/props.ts;
 * the light on the lawn is render/street/areaLights.ts. Content to add:
 * hedges, a pond, better trees and grass shading.
 */
import * as THREE from 'three';
import { distToPolygonEdge, pointInPolygon } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, tree } from './kit';

/** Footpath strips are cut into pieces this long so they follow the hills (m). */
const PATH_PIECE = 3;

const PASS = {
  /** The cobbles are drawn in pieces this long (m), kept this far inside the park edge (m). */
  piece: 2,
  inset: 0.5,
  /** Cobble, kerb lines (m wide) and the path lights every studStep (m), their radius (m). */
  cobble: col(0x6e6453),
  kerb: 0.3,
  kerbColor: col(0xb0a894),
  studStep: 8,
  studR: 0.22,
  studColor: new THREE.Color(1, 0.86, 0.66).multiplyScalar(1.5),
} as const;

/** A race pass's path across the park: cobbles, kerb lines and path lights, clipped to the park. */
function passPath(kit: DistrictKit, pts: Vec2[], width: number, park: Vec2[]): void {
  const on = (p: Vec2) => pointInPolygon(p.x, p.z, park) && distToPolygonEdge(p.x, p.z, park) > PASS.inset;
  let stud = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.1) continue;
    const ux = (q.x - p.x) / len;
    const uz = (q.z - p.z) / len;
    const n = Math.max(1, Math.ceil(len / PASS.piece));
    for (let k = 0; k < n; k++) {
      const a = { x: p.x + (q.x - p.x) * (k / n), z: p.z + (q.z - p.z) * (k / n) };
      const b = { x: p.x + (q.x - p.x) * ((k + 1) / n), z: p.z + (q.z - p.z) * ((k + 1) / n) };
      if (!on(a) || !on(b)) continue;
      groundLine(kit, kit.paint, a, b, width, 0.075, PASS.cobble);
      for (const sgn of [-1, 1]) {
        const ox = -uz * sgn * (width / 2);
        const oz = ux * sgn * (width / 2);
        groundLine(kit, kit.paint, { x: a.x + ox, z: a.z + oz }, { x: b.x + ox, z: b.z + oz }, PASS.kerb, 0.08, PASS.kerbColor);
      }
    }
    // Path lights down both edges, evenly along the whole line.
    for (; stud <= len; stud += PASS.studStep) {
      const c = { x: p.x + ux * stud, z: p.z + uz * stud };
      for (const sgn of [-1, 1]) {
        const x = c.x - uz * sgn * (width / 2 + 0.6);
        const z = c.z + ux * sgn * (width / 2 + 0.6);
        if (!on({ x, z })) continue;
        const y = kit.h(x, z);
        cylinder(kit.glow, x, z, PASS.studR, y + 0.02, y + 0.09, 6, PASS.studColor);
      }
    }
    stud -= len;
  }
}

export const parkRenderer: DistrictRenderer = {
  kinds: ['park'],
  build(kit, areas) {
    const gravel = col(0x5a5446);
    for (const a of areas) {
      drapeConvex(kit, kit.ground, a.polygon, 0.04, col(0x1d3a22), 5);
      const b = kit.builds[a.id];
      for (const p of b.props) if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height, (p.yaw % 1) * 0.5);
      for (const h of b.hints) {
        if (h.kind === 'pass') {
          passPath(kit, h.points, h.values[0], a.polygon);
          continue;
        }
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
