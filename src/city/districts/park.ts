/**
 * Parks: one or two whole blocks become open grass with rolling hills. The
 * block's frontage is opened (no walls: you can cut straight across), the
 * surface is 'grass' (offroad grip and drag), buildings are kept out and the
 * terrain gets a bumpy hill that is flat at the park edge. Trees are solid
 * trunks (look 'tree') kept away from the edge so the shortcut stays open.
 *
 * Content to add (render/districts/park.ts): footpaths, lamps, benches,
 * hedges, a pond or playground, better trees.
 */
import { CITY } from '../config';
import { cos, sin } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polyWalls, polygonBounds, smooth01 } from './geom';

const CFG = CITY.districts.park;

/** True when every ring turn goes the same way (the block is convex). */
function convex(ring: { x: number; z: number }[]): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const c = ring[(i + 2) % ring.length];
    const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
    if (Math.abs(cr) < 1e-3) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

export const parkModule: DistrictModule = {
  kind: 'park',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(CFG.count[0], CFG.count[1]);
    const others = ctx.areas.filter((a) => a.kind === 'river' || a.kind === 'subway' || a.kind === 'backAlley' || a.kind === 'alley');
    const faces = ctx.faces().filter((f) => {
      if (f.outer || f.area < CFG.minArea || f.area > CFG.maxArea || ctx.claims.face.has(f.id)) return false;
      if (f.edges.some((e) => g.edges[e].shortcut || g.edges[e].bridge || ctx.claims.edge.has(e))) return false;
      // Clear of linear areas (river channel, subway deck, alleys).
      for (const a of others) {
        if (a.polygon.some((p) => pointInPolygon(p.x, p.z, f.ring))) return false;
        if (f.ring.some((p) => pointInPolygon(p.x, p.z, a.polygon))) return false;
      }
      return convex(f.ring);
    });
    rng.shuffle(faces);
    let made = 0;
    for (const f of faces) {
      if (made >= count) break;
      if (ctx.budget.used + f.area > ctx.budget.total) continue;
      // Not right next to another park.
      if (ctx.areas.some((a) => a.kind === 'park' && a.polygon.some((p) => f.ring.some((q) => (p.x - q.x) ** 2 + (p.z - q.z) ** 2 < 60 * 60)))) continue;
      ctx.addArea(
        {
          kind: 'park',
          variant: 'hills',
          polygon: f.ring,
          path: [],
          nodes: [],
          edges: [],
          faces: [f.id],
          params: { hill: CFG.hill * rng.range(0.6, 1), kx: rng.range(0.05, 0.09), kz: rng.range(0.05, 0.09), px: rng.range(0, 6.28), pz: rng.range(0, 6.28), seed: rng.int(0, 0x7fffffff) },
        },
        f.area,
      );
      made++;
    }
  },

  build(_ctx, area) {
    const b = emptyBuild();
    const ring = area.polygon;
    const id = area.id;
    b.exclusions.push(ring);
    b.openings.push(ring);
    b.surfaces.push({ surface: 'grass', polygon: ring, priority: 2, area: id });
    // Hill: H * bump(x, z) * prod_i smooth(0, edge, inside distance to side i).
    const { hill, kx, kz, px, pz } = area.params;
    const sides = ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      // The block is on the right of travel: inward normal (dz, -dx).
      return { x: p.x, z: p.z, nx: (q.z - p.z) / l, nz: -(q.x - p.x) / l, len: l };
    });
    const bb = polygonBounds(ring);
    b.heightMods.push({
      ...bb,
      add(x, z, out) {
        let P = 1;
        let sx = 0;
        let sz = 0;
        for (const s of sides) {
          if (s.len < 0.5) continue;
          const d = (x - s.x) * s.nx + (z - s.z) * s.nz;
          const m = smooth01(0, CFG.hillEdge, d);
          if (m.v <= 0) return;
          P *= m.v;
          sx += (m.d / m.v) * s.nx;
          sz += (m.d / m.v) * s.nz;
        }
        const bump = 0.55 + 0.45 * sin(x * kx + px) * cos(z * kz + pz);
        const dbx = 0.45 * kx * cos(x * kx + px) * cos(z * kz + pz);
        const dbz = -0.45 * kz * sin(x * kx + px) * sin(z * kz + pz);
        out.h += hill * P * bump;
        out.gx += hill * (P * sx * bump + P * dbx);
        out.gz += hill * (P * sz * bump + P * dbz);
      },
    });
    // Trees on a jittered grid, clear of the edge.
    const rng = new Rng(area.params.seed);
    const rnd = () => rng.next();
    const step = CFG.treeSpacing;
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
      for (let z = bb.minZ + step / 2; z < bb.maxZ; z += step) {
        if (rnd() < 0.35) continue;
        const tx = x + (rnd() - 0.5) * step * 0.7;
        const tz = z + (rnd() - 0.5) * step * 0.7;
        if (!pointInPolygon(tx, tz, ring) || distToPolygonEdge(tx, tz, ring) < 9) continue;
        b.walls.push(...polyWalls(circlePolygon(tx, tz, CFG.treeRadius, 6), false, 'tree', id));
        b.props.push({ kind: 'tree', x: tx, z: tz, yaw: rnd() * 6.28, size: 2.2 + rnd() * 1.6, height: 5 + rnd() * 4, area: id });
      }
    }
    return b;
  },
};
