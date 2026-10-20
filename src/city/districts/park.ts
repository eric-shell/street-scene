/**
 * Parks: one or two whole blocks become open grass with rolling hills. The
 * block's frontage is opened (no walls: you can cut straight across), the
 * surface is 'grass' (offroad grip and drag), buildings are kept out and the
 * terrain gets a bumpy hill that is flat at the park edge. Trees are solid
 * trunks (look 'tree') kept away from the edge so the shortcut stays open;
 * one small wood packs them tighter, with bushes underneath. Clusters of
 * bushes (destructible, a car ploughs straight through) dot the grass, and
 * a footpath loop inside the edge has benches and bins (destructible too)
 * and lantern posts (destructible, lighting the park: render/areaLights.ts).
 *
 * Content to add (render/districts/park.ts): hedges, a pond or playground,
 * better trees.
 */
import { CITY } from '../config';
import { cos, sin } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { DistrictModule } from './types';
import type { PropKind } from '../props';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polyWalls, polygonArea, polygonBounds, smooth01 } from './geom';

const CFG = CITY.districts.park;

/** True when every ring turn goes the same way (the block is convex). Shared with the monument plaza. */
export function convexRing(ring: { x: number; z: number }[]): boolean {
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

/** The ring moved inward by d (m), for a convex ring in block order (block on the right of travel); null when it collapses. */
function insetRing(ring: { x: number; z: number }[], d: number): { x: number; z: number }[] | null {
  const n = ring.length;
  const lines = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const nx = (q.z - p.z) / l;
    const nz = -(q.x - p.x) / l;
    return { x: p.x + nx * d, z: p.z + nz * d, dx: (q.x - p.x) / l, dz: (q.z - p.z) / l, l };
  });
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i - 1 + n) % n];
    const b = lines[i];
    if (a.l < 1 || b.l < 1) continue;
    const den = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(den) < 1e-6) continue;
    const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / den;
    out.push({ x: a.x + a.dx * t, z: a.z + a.dz * t });
  }
  if (out.length < 3) return null;
  // Collapsed or flipped (the inset passed the middle): every point must sit d inside the original.
  for (const p of out) if (!pointInPolygon(p.x, p.z, ring) || distToPolygonEdge(p.x, p.z, ring) < d - 0.5) return null;
  return out;
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
      return convexRing(f.ring);
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
    // Trees on a jittered grid, clear of the edge; one small wood packs them tighter.
    const rng = new Rng(area.params.seed);
    const rnd = () => rng.next();
    const trees: { x: number; z: number }[] = [];
    const addTree = (tx: number, tz: number) => {
      trees.push({ x: tx, z: tz });
      b.walls.push(...polyWalls(circlePolygon(tx, tz, CFG.treeRadius, 6), false, 'tree', id));
      b.props.push({ kind: 'tree', x: tx, z: tz, yaw: rnd() * 6.28, size: 2.2 + rnd() * 1.6, height: 5 + rnd() * 4, area: id });
    };
    // The wood: a random spot at least its radius inside the edge (none in a park too small for it).
    let grove: { x: number; z: number; r: number } | null = null;
    const gr = CFG.groveRadius[0] + rnd() * (CFG.groveRadius[1] - CFG.groveRadius[0]);
    for (let k = 0; k < 24 && !grove; k++) {
      const gx = bb.minX + rnd() * (bb.maxX - bb.minX);
      const gz = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
      if (pointInPolygon(gx, gz, ring) && distToPolygonEdge(gx, gz, ring) > gr + 6) grove = { x: gx, z: gz, r: gr };
    }
    const inGrove = (x: number, z: number) => !!grove && (x - grove.x) ** 2 + (z - grove.z) ** 2 < grove.r * grove.r;
    const step = CFG.treeSpacing;
    for (let x = bb.minX + step / 2; x < bb.maxX; x += step) {
      for (let z = bb.minZ + step / 2; z < bb.maxZ; z += step) {
        if (rnd() < 0.35) continue;
        const tx = x + (rnd() - 0.5) * step * 0.7;
        const tz = z + (rnd() - 0.5) * step * 0.7;
        if (!pointInPolygon(tx, tz, ring) || distToPolygonEdge(tx, tz, ring) < 9 || inGrove(tx, tz)) continue;
        addTree(tx, tz);
      }
    }
    const clutter = (kind: PropKind, x: number, z: number, yaw: number) => b.destructibles.push({ kind, x, z, yaw, lift: 0, area: id });
    /** Clear of tree trunks and of the park edge. */
    const open = (x: number, z: number, r: number, edge: number) =>
      pointInPolygon(x, z, ring) && distToPolygonEdge(x, z, ring) > edge && trees.every((t) => (t.x - x) ** 2 + (t.z - z) ** 2 > (CFG.treeRadius + r + 0.6) ** 2);
    if (grove) {
      const gs = CFG.groveSpacing;
      for (let x = grove.x - grove.r; x < grove.x + grove.r; x += gs) {
        for (let z = grove.z - grove.r; z < grove.z + grove.r; z += gs) {
          if (rnd() < 0.2) continue;
          const tx = x + (rnd() - 0.5) * gs * 0.8;
          const tz = z + (rnd() - 0.5) * gs * 0.8;
          if (inGrove(tx, tz) && open(tx, tz, CFG.treeRadius, 9)) addTree(tx, tz);
        }
      }
      // Undergrowth.
      for (let k = 0; k < grove.r * 1.6; k++) {
        const a = rnd() * 6.28;
        const d = Math.sqrt(rnd()) * grove.r;
        const x = grove.x + Math.cos(a) * d;
        const z = grove.z + Math.sin(a) * d;
        if (open(x, z, 0.75, 4)) clutter('bush', x, z, rnd() * 6.28);
      }
    }
    // Bush clusters on the open grass.
    const clusters = Math.round(polygonArea(ring) / CFG.bushClusterArea);
    for (let c = 0; c < clusters; c++) {
      const cx = bb.minX + rnd() * (bb.maxX - bb.minX);
      const cz = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
      if (!pointInPolygon(cx, cz, ring) || inGrove(cx, cz)) continue;
      const n = 2 + Math.floor(rnd() * 5);
      for (let k = 0; k < n; k++) {
        const x = cx + (rnd() - 0.5) * 5;
        const z = cz + (rnd() - 0.5) * 5;
        if (open(x, z, 0.75, 2.5)) clutter('bush', x, z, rnd() * 6.28);
      }
    }
    // Footpath loop with benches facing in and a bin beside some of them.
    const path = insetRing(ring, CFG.pathInset);
    if (path) {
      b.hints.push({ kind: 'path', points: path, values: [] });
      for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const q = path[(i + 1) % path.length];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        if (len < 8) continue;
        const ux = (q.x - p.x) / len;
        const uz = (q.z - p.z) / len;
        // Inward: right of travel along the ring (the block is on the right).
        const nx = uz;
        const nz = -ux;
        for (let s = CFG.benchSpacing * (0.3 + 0.4 * rnd()); s < len - 4; s += CFG.benchSpacing) {
          const x = p.x + ux * s + nx * 1.8;
          const z = p.z + uz * s + nz * 1.8;
          if (!open(x, z, 0.9, 3)) continue;
          // Benches face the path (local +Z toward it, i.e. away from the park middle).
          clutter('bench', x, z, Math.atan2(-nx, -nz));
          if (rnd() < 0.5) {
            const cx = x + ux * 1.6;
            const cz = z + uz * 1.6;
            if (open(cx, cz, 0.4, 3)) clutter('garbageCan', cx, cz, 0);
          }
        }
      }
      // Lantern posts just off the path's outer side (benches sit on the inner one): one at every
      // corner, the rest spread evenly along each side. No rng draws, so the lamps never shift the
      // benches and bins.
      const off = 1.7;
      for (let i = 0; i < path.length; i++) {
        const o = path[(i - 1 + path.length) % path.length];
        const p = path[i];
        const q = path[(i + 1) % path.length];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        const lenIn = Math.hypot(p.x - o.x, p.z - o.z);
        if (len < 1 || lenIn < 1) continue;
        const ux = (q.x - p.x) / len;
        const uz = (q.z - p.z) / len;
        // Outward (toward the street): left of travel.
        const ox = -uz;
        const oz = ux;
        const n = Math.max(1, Math.round(len / CFG.lampSpacing));
        for (let k = 0; k < n; k++) {
          let x = p.x + ux * (len * k) / n + ox * off;
          let z = p.z + uz * (len * k) / n + oz * off;
          if (k === 0) {
            // The corner: off the path on the bisector of both sides' outward normals.
            const bx = ox - (p.z - o.z) / lenIn;
            const bz = oz + (p.x - o.x) / lenIn;
            const bl = Math.hypot(bx, bz);
            if (bl > 1e-6) {
              const k2 = off / Math.max(0.5, (bx * ox + bz * oz) / bl);
              x = p.x + (bx / bl) * k2;
              z = p.z + (bz / bl) * k2;
            }
          }
          if (open(x, z, 0.4, 2)) clutter('parkLamp', x, z, Math.atan2(-ox, -oz));
        }
      }
    }
    return b;
  },
};
