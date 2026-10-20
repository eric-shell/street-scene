/**
 * Hills: sections of the city with real elevation. One or two clusters of
 * two to four adjacent blocks are lifted on a smooth dome or ridge (a basin
 * now and then) 10-16 m high with a flat top, so the streets up its flanks
 * climb at grades up to about 11%, crest where they reach the plateau and
 * drop away again: downhill braking, crests to get light over at speed, and
 * side streets running along the slope with a camber. The blocks keep their
 * buildings (they are downtown blocks on a hill; the architecture planner
 * puts its San Francisco styles up here), and sidewalks, props, rails and
 * the El all follow the terrain already.
 *
 * Profile: the plateau is a rounded rectangle aligned with the cluster's
 * longest street side (a long thin one for a ridge); the height falls off
 * with a smoothstep of the distance to that rectangle over a slope width
 * derived from the height and the grade cap (a smoothstep is steepest at
 * 1.5 / width), so the modifier is C1 everywhere and exactly 0 at its
 * bounding box. Slopes keep clear of the river channel (its floor must stay
 * flat), the El (trains cannot climb), roundabouts (their islands are built
 * level), the monument plaza and each other; they may run on past the city
 * edge. The area polygon covers the plateau and most of the slope, so
 * areaAt and the minimap report the whole rise, not just the claimed blocks.
 */
import { CITY } from '../config';
import type { BlockFace } from '../blocks';
import { Vec2, atan2, cos, sin, sqrt } from '../../sim/math';
import type { Area, DistrictModule, HeightSample } from './types';
import { emptyBuild } from './types';
import { polygonCentroid, smooth01 } from './geom';
import { riverCenter } from './river';

const CFG = CITY.districts.hills;

/** A hill's plateau rectangle (local frame: u along, v across) and its profile. */
export interface HillShape {
  cx: number;
  cz: number;
  /** Unit axis along the plateau. */
  ux: number;
  uz: number;
  /** Plateau half extents along u and v (m). */
  a: number;
  b: number;
  /** Summit height (m, negative for a basin) and slope width (m). */
  h: number;
  w: number;
}

/** Distance from (x, z) to the plateau rectangle (0 inside, with `inner` the distance to its edge), plus local coordinates. */
export function plateauDistance(s: HillShape, x: number, z: number): { d: number; inner: number; pu: number; pv: number; dx: number; dz: number } {
  const rx = x - s.cx;
  const rz = z - s.cz;
  const pu = rx * s.ux + rz * s.uz;
  const pv = -rx * s.uz + rz * s.ux;
  const dx = Math.max(0, Math.abs(pu) - s.a);
  const dz = Math.max(0, Math.abs(pv) - s.b);
  return { d: sqrt(dx * dx + dz * dz), inner: Math.min(s.a - Math.abs(pu), s.b - Math.abs(pv)), pu, pv, dx, dz };
}

/** Height and exact gradient of the hill at (x, z). */
export function hillAt(s: HillShape, x: number, z: number, out: HeightSample): void {
  const q = plateauDistance(s, x, z);
  if (q.d >= s.w) return;
  const m = smooth01(0, s.w, q.d);
  out.h += s.h * (1 - m.v);
  if (q.d <= 0 || m.d === 0) return;
  // d(h)/d(d) along the direction the rectangle distance grows in (local), rotated to world.
  const k = -s.h * m.d;
  const lu = (q.pu < 0 ? -1 : 1) * (q.dx / q.d);
  const lv = (q.pv < 0 ? -1 : 1) * (q.dz / q.d);
  out.gx += k * (lu * s.ux - lv * s.uz);
  out.gz += k * (lu * s.uz + lv * s.ux);
}

/** Rounded rectangle `dist` m outside the plateau, as a polygon. */
export function hillOutline(s: HillShape, dist: number): Vec2[] {
  const pts: Vec2[] = [];
  const corner = (su: number, sv: number, a0: number) => {
    for (let i = 0; i <= 6; i++) {
      const ang = a0 + (i / 6) * (Math.PI / 2);
      const lu = su * s.a + cos(ang) * dist;
      const lv = sv * s.b + sin(ang) * dist;
      pts.push({ x: s.cx + lu * s.ux - lv * s.uz, z: s.cz + lu * s.uz + lv * s.ux });
    }
  };
  corner(1, 1, 0);
  corner(-1, 1, Math.PI / 2);
  corner(-1, -1, Math.PI);
  corner(1, -1, 1.5 * Math.PI);
  return pts;
}

/** Unit direction of the longest ring side that runs along a street. */
function longestSide(f: BlockFace): Vec2 {
  let best = 0;
  let dir: Vec2 = { x: 1, z: 0 };
  for (let i = 0; i < f.ring.length; i++) {
    if (f.segEdge[i] < 0) continue;
    const p = f.ring[i];
    const q = f.ring[(i + 1) % f.ring.length];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (l > best) {
      best = l;
      dir = { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
    }
  }
  return dir;
}

function samplePath(path: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const p = path[i];
    const q = path[i + 1];
    const n = Math.max(1, Math.ceil(sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) / step));
    for (let k = 0; k < n; k++) out.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
  }
  if (path.length) out.push(path[path.length - 1]);
  return out;
}

export function shapeOf(area: Area): HillShape {
  const p = area.params;
  return { cx: p.cx, cz: p.cz, ux: p.ux, uz: p.uz, a: p.a, b: p.b, h: p.h, w: p.w };
}

export const hillsModule: DistrictModule = {
  kind: 'hills',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(CFG.count[0], CFG.count[1]);
    const faces = ctx.faces();
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const subways = ctx.areas.filter((a) => a.kind === 'subway').map((a) => samplePath(a.path, 10));
    const monuments = ctx.areas.filter((a) => a.kind === 'monument');
    const rings = g.nodes.filter((n) => n.ring);
    const byEdge = new Map<number, number[]>();
    for (const f of faces) {
      if (f.outer) continue;
      for (const e of f.edges) {
        let list = byEdge.get(e);
        if (!list) byEdge.set(e, (list = []));
        list.push(f.id);
      }
    }
    const taken = new Set<number>();
    const eligible = (f: BlockFace) => !f.outer && !ctx.claims.face.has(f.id) && !taken.has(f.id) && f.edges.every((e) => !g.edges[e].bridge) && f.corners.every((c) => !g.nodes[c.node].ring);
    const made: HillShape[] = [];

    /** Slopes clear of everything built level, and of other slopes (grades would add up). */
    const fits = (s: HillShape): boolean => {
      const reach = s.w + CFG.clearance;
      for (const r of rivers) {
        for (let x = r.params.x0; x <= r.params.x1; x += 12) if (plateauDistance(s, x, riverCenter(r.params, x)).d < reach + r.params.top) return false;
      }
      for (const path of subways) for (const p of path) if (plateauDistance(s, p.x, p.z).d < reach) return false;
      for (const n of rings) {
        const q = plateauDistance(s, n.x, n.z);
        const R = n.ring!.outer + CITY.sidewalk;
        if (q.d > 0 ? q.d < reach + R : q.inner < R + CFG.clearance) return false;
      }
      for (const m of monuments) {
        const q = plateauDistance(s, m.params.cx, m.params.cz);
        if (q.d > 0 ? q.d < reach + 30 : q.inner < 40) return false;
      }
      for (const o of made) {
        const apart = (1 - CFG.overlap) * (s.w + o.w);
        for (const p of hillOutline(o, 0)) if (plateauDistance(s, p.x, p.z).d < apart) return false;
        for (const p of hillOutline(s, 0)) if (plateauDistance(o, p.x, p.z).d < apart) return false;
      }
      return true;
    };

    const order = faces.filter(eligible).map((f) => f.id);
    rng.shuffle(order);
    for (const seedId of order) {
      if (made.length >= count) break;
      const seed = faces[seedId];
      if (!eligible(seed)) continue;
      // Grow a cluster of adjacent blocks from the seed.
      const target = rng.int(CFG.blocks[0], CFG.blocks[1]);
      const cluster = [seed];
      const inCluster = new Set([seed.id]);
      while (cluster.length < target) {
        const nb: BlockFace[] = [];
        for (const f of cluster) {
          for (const e of f.edges) {
            for (const id of byEdge.get(e) ?? []) {
              const n = faces[id];
              if (!inCluster.has(id) && eligible(n) && !nb.includes(n)) nb.push(n);
            }
          }
        }
        if (!nb.length) break;
        const pick = nb[rng.int(0, nb.length - 1)];
        cluster.push(pick);
        inCluster.add(pick.id);
      }
      if (cluster.length < CFG.blocks[0]) continue;
      // Frame along the seed block's longest street side, centred on the cluster.
      const u = longestSide(seed);
      let cx = 0;
      let cz = 0;
      let total = 0;
      for (const f of cluster) {
        const c = polygonCentroid(f.ring);
        cx += c.x * f.area;
        cz += c.z * f.area;
        total += f.area;
      }
      cx /= total;
      cz /= total;
      let eu = 0;
      let ev = 0;
      for (const f of cluster) {
        for (const p of f.ring) {
          eu = Math.max(eu, Math.abs((p.x - cx) * u.x + (p.z - cz) * u.z));
          ev = Math.max(ev, Math.abs(-(p.x - cx) * u.z + (p.z - cz) * u.x));
        }
      }
      const ridge = rng.chance(CFG.ridgeChance);
      const basin = rng.chance(CFG.basinChance);
      const a = Math.max(25, eu - CFG.inset);
      const b = ridge ? CFG.ridgeHalfWidth : Math.max(25, ev - CFG.inset);
      // Tallest hill that fits, from a random height down to the minimum.
      let shape: HillShape | null = null;
      for (let h = rng.range(CFG.height[0], CFG.height[1]); h >= CFG.height[0] - 1e-9; h -= 1) {
        const s: HillShape = { cx, cz, ux: u.x, uz: u.z, a, b, h: basin ? -h : h, w: (1.5 * h) / CFG.maxGrade };
        if (fits(s)) {
          shape = s;
          break;
        }
      }
      if (!shape) continue;
      if (ctx.budget.used + total > ctx.budget.total) continue;
      for (const f of cluster) taken.add(f.id);
      made.push(shape);
      ctx.addArea(
        {
          kind: 'hills',
          variant: basin ? 'basin' : ridge ? 'ridge' : 'dome',
          polygon: hillOutline(shape, shape.w * CFG.reach),
          path: [],
          nodes: [],
          edges: [],
          faces: cluster.map((f) => f.id),
          params: { cx, cz, ux: u.x, uz: u.z, a, b, h: shape.h, w: shape.w, yaw: atan2(u.x, u.z), blocks: cluster.length },
        },
        total,
      );
    }
  },

  build(_ctx, area) {
    const b = emptyBuild();
    const s = shapeOf(area);
    // Bounding box of the rectangle grown by the slope width (the rounded corners stay inside it).
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const lu = su * (s.a + s.w + 1);
        const lv = sv * (s.b + s.w + 1);
        const x = s.cx + lu * s.ux - lv * s.uz;
        const z = s.cz + lu * s.uz + lv * s.ux;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    b.heightMods.push({ minX, minZ, maxX, maxZ, add: (x, z, out) => hillAt(s, x, z, out) });
    b.hints.push({ kind: 'hill', points: [{ x: s.cx, z: s.cz }, { x: s.ux, z: s.uz }], values: [s.a, s.b, s.h, s.w] });
    return b;
  },
};
