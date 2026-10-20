/**
 * Infill: fills the voids of the street frontage (stretches of sidewalk line
 * with no building behind them) with low, mostly drivable space, so collision
 * always matches what is visibly there and racers can cut corners creatively.
 *
 * Runs in the 'late' phase, after buildings are placed, on the void runs
 * blocks.ts finds along every block ring. Heuristics, per run:
 *  - Convex block corners (where void runs are most likely: acute and obtuse
 *    junction angles, busy nodes where square corner buildings do not fit)
 *    become corner plazas (drivable concrete, a fountain on roomy corners of
 *    busy junctions). The sharper the corner, the likelier.
 *  - Long straight voids (large footprint gaps) become parking lots
 *    (drivable asphalt with painted bays), shorter ones small plazas, and the
 *    rest raised planters (solid, the frontage wall stays and is drawn as the
 *    planter's edge).
 *  - Drivable infill stays CITY.districts.infill.gap m from any other
 *    drivable space and out of buildings and exclusions, and is walled on
 *    its back sides with low curbs (look 'lotEdge').
 * Whatever is left is a low 'boundary' wall drawn by render/districts/infill.ts.
 *
 * Content to add: parked cars in lots, bollards, kiosks, plaza benches,
 * better fountains, light poles, food trucks.
 */
import { CITY } from '../config';
import { Vec2, sqrt } from '../../sim/math';
import type { Wall } from '../blocks';
import type { Area, DistrictModule } from './types';
import { emptyBuild } from './types';
import { PolygonIndex, circlePolygon, pointInPolygon, polyWalls, polygonBounds, rectPolygon } from './geom';

const CFG = CITY.districts.infill;

function distToPolyline(x: number, z: number, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-12 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = sqrt((x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2);
    if (d < best) best = d;
  }
  return best;
}

export const infillModule: DistrictModule = {
  kind: 'infill',
  phase: 'late',
  plan(ctx) {
    const L = ctx.late;
    if (!CFG.enabled || !L) return;
    const rng = ctx.rng;
    const g = ctx.graph;
    const pad = 220;
    const placed = new PolygonIndex<{ polygon: Vec2[] }>(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad);

    /** Can this polygon be built? Drivable ones also keep clear of other drivable space. */
    const valid = (poly: Vec2[], front: Vec2[], drivable: boolean): boolean => {
      const bb = polygonBounds(poly);
      const step = 1.5;
      const pts: Vec2[] = [];
      for (let x = bb.minX + 0.3; x <= bb.maxX; x += step) for (let z = bb.minZ + 0.3; z <= bb.maxZ; z += step) if (pointInPolygon(x, z, poly)) pts.push({ x, z });
      // Corners, pulled slightly inside.
      const c = { x: (bb.minX + bb.maxX) / 2, z: (bb.minZ + bb.maxZ) / 2 };
      for (const p of poly) pts.push({ x: p.x + (c.x - p.x) * 0.02, z: p.z + (c.z - p.z) * 0.02 });
      for (const p of pts) {
        if (L.insideBuilding(p.x, p.z, 0.4) || L.excluded(p.x, p.z)) return false;
        if (!drivable) continue;
        const dF = distToPolyline(p.x, p.z, front);
        if (L.clearance(p.x, p.z) < Math.min(dF, CFG.gap) - 0.3) return false;
        if (placed.near(p.x, p.z, CFG.gap)) return false;
      }
      return true;
    };

    const add = (variant: string, polygon: Vec2[], frontSides: number, face: number, node: number, extra: Record<string, number>) => {
      placed.add({ polygon });
      ctx.addArea({ kind: 'infill', variant, polygon, path: [], nodes: node >= 0 ? [node] : [], edges: [], faces: [face], params: { frontSides, ...extra } });
    };

    for (const run of L.voids) {
      if (run.length < CFG.minRun) continue;
      const pts = run.points;
      const pos = [0];
      for (let i = 1; i < pts.length; i++) pos.push(pos[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
      const used: [number, number][] = [];

      // 1. Corner plazas.
      for (const c of run.corners) {
        if (c.angle > 160 * (Math.PI / 180)) continue;
        const i = c.index;
        if (i < 1 || i + 1 >= pts.length) continue;
        const C = pts[i];
        const len1 = pos[i] - pos[i - 1];
        const len2 = pos[i + 1] - pos[i];
        if (len1 < 5 || len2 < 5) continue;
        const deg = (c.angle * 180) / Math.PI;
        const chance = deg < 80 ? 0.9 : deg < 110 ? 0.75 : 0.55;
        if (!rng.chance(chance)) continue;
        const u1 = { x: (pts[i - 1].x - C.x) / len1, z: (pts[i - 1].z - C.z) / len1 };
        const u2 = { x: (pts[i + 1].x - C.x) / len2, z: (pts[i + 1].z - C.z) / len2 };
        let L1 = Math.min(CFG.cornerReach, len1);
        let L2 = Math.min(CFG.cornerReach, len2);
        for (let attempt = 0; attempt < 5 && Math.min(L1, L2) >= 5; attempt++) {
          const a = { x: C.x + u1.x * L1, z: C.z + u1.z * L1 };
          const b = { x: C.x + u2.x * L2, z: C.z + u2.z * L2 };
          const poly = [a, { x: C.x, z: C.z }, b, { x: a.x + u2.x * L2, z: a.z + u2.z * L2 }];
          if (valid(poly, [a, C, b], true)) {
            used.push([pos[i] - L1, pos[i] + L2]);
            const busy = c.node >= 0 && g.nodes[c.node].edges.length >= 4;
            const fountain = Math.min(L1, L2) >= 10 && rng.chance(CFG.fountainChance + (busy ? 0.25 : 0));
            const fr = Math.min(3, Math.max(1.6, Math.min(L1, L2) * 0.16));
            const cx = (poly[0].x + poly[1].x + poly[2].x + poly[3].x) / 4;
            const cz = (poly[0].z + poly[1].z + poly[2].z + poly[3].z) / 4;
            add('cornerPlaza', poly, 2, run.face, c.node, { angle: c.angle, reach1: L1, reach2: L2, fountain: fountain ? fr : 0, fx: cx, fz: cz });
            break;
          }
          L1 *= 0.8;
          L2 *= 0.8;
        }
      }

      // 2. Straight stretches between used corners.
      for (let k = 0; k + 1 < pts.length; k++) {
        let pieces: [number, number][] = [[pos[k], pos[k + 1]]];
        for (const [u0, u1] of used) {
          const next: [number, number][] = [];
          for (const [a, b] of pieces) {
            if (u1 <= a || u0 >= b) next.push([a, b]);
            else {
              if (u0 > a) next.push([a, u0]);
              if (u1 < b) next.push([u1, b]);
            }
          }
          pieces = next;
        }
        const segLen = pos[k + 1] - pos[k];
        if (segLen < 1e-6) continue;
        const u = { x: (pts[k + 1].x - pts[k].x) / segLen, z: (pts[k + 1].z - pts[k].z) / segLen };
        // Into the block: right of travel.
        const w = { x: u.z, z: -u.x };
        const at = (s: number) => ({ x: pts[k].x + u.x * (s - pos[k]), z: pts[k].z + u.z * (s - pos[k]) });
        for (const [s0, s1] of pieces) {
          if (s1 - s0 < CFG.minRun) continue;
          const r = rng.next();
          const kind = s1 - s0 >= CFG.lotMinLen && r < CFG.lotChance ? 'lot' : r < CFG.lotChance + CFG.plazaChance ? 'plaza' : 'planter';
          let done = false;
          if (kind !== 'planter') {
            const maxD = kind === 'lot' ? CFG.lotDepth : CFG.plazaDepth;
            for (const inset of [1, 4, 8]) {
              const a = s0 + inset;
              const len = s1 - s0 - 2 * inset;
              if (len < CFG.minRun) break;
              for (let D = maxD; D >= 5 && !done; D -= 3) {
                const o = at(a);
                const poly = rectPolygon(o, u, w, len, D);
                if (!valid(poly, [poly[0], poly[1]], true)) continue;
                const fountain = kind === 'plaza' && Math.min(len, D) >= 10 && rng.chance(CFG.fountainChance);
                const fr = Math.min(3, Math.max(1.6, Math.min(len, D) * 0.16));
                add(kind, poly, 1, run.face, -1, { depth: D, length: len, fountain: fountain ? fr : 0, fx: o.x + u.x * len * 0.5 + w.x * D * 0.5, fz: o.z + u.z * len * 0.5 + w.z * D * 0.5 });
                done = true;
              }
              if (done) break;
            }
          }
          if (!done) {
            const len = s1 - s0 - 0.4;
            const poly = rectPolygon(at(s0 + 0.2), u, w, len, CFG.planterDepth);
            if (valid(poly, [], false)) add('planter', poly, 1, run.face, -1, { depth: CFG.planterDepth, length: len });
          }
        }
      }
    }
  },

  build(_ctx, area: Area) {
    const b = emptyBuild();
    const poly = area.polygon;
    const id = area.id;
    if (area.variant === 'planter') {
      b.frontLooks.push({ polygon: poly, look: 'planter', area: id });
      return b;
    }
    b.openings.push(poly);
    b.surfaces.push({ surface: area.variant === 'lot' ? 'road' : 'concrete', polygon: poly, priority: 2, area: id });
    // Low curbs on the back sides (the first frontSides sides are the open frontage).
    const fs = area.params.frontSides;
    const sides: Wall[] = [];
    for (let i = fs; i < poly.length; i++) {
      const seg = [poly[i], poly[(i + 1) % poly.length]];
      const w = polyWalls(seg, true, 'lotEdge', id, false)[0];
      if (!w) continue;
      // Normal into the polygon.
      const mx = (w.ax + w.bx) / 2 + w.nx * 0.2;
      const mz = (w.az + w.bz) / 2 + w.nz * 0.2;
      if (!pointInPolygon(mx, mz, poly)) {
        w.nx = -w.nx;
        w.nz = -w.nz;
      }
      sides.push(w);
    }
    b.walls.push(...sides);
    if (area.params.fountain > 0) {
      const ring = circlePolygon(area.params.fx, area.params.fz, area.params.fountain, 12);
      b.walls.push(...polyWalls(ring, false, 'fountain', id));
      b.props.push({ kind: 'fountain', x: area.params.fx, z: area.params.fz, yaw: 0, size: area.params.fountain, height: 0.8, area: id });
    }
    if (area.variant === 'lot') {
      // Painted bays along the back side: one hint per stripe (from, to).
      const [p0, p1, , p3] = poly;
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      const depth = Math.hypot(p3.x - p0.x, p3.z - p0.z);
      const ux = (p1.x - p0.x) / len;
      const uz = (p1.z - p0.z) / len;
      const wx = (p3.x - p0.x) / depth;
      const wz = (p3.z - p0.z) / depth;
      const bay = 2.7;
      const bayDepth = Math.min(5.2, depth * 0.45);
      const n = Math.floor((len - 1) / bay);
      const start = (len - n * bay) / 2;
      for (let k = 0; k <= n; k++) {
        const s = start + k * bay;
        const a = { x: p0.x + ux * s + wx * depth, z: p0.z + uz * s + wz * depth };
        b.hints.push({ kind: 'bay', points: [a, { x: a.x - wx * bayDepth, z: a.z - wz * bayDepth }], values: [] });
      }
    }
    return b;
  },
};
