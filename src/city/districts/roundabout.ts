/**
 * Roundabouts: some intersections become large circular junctions. The node
 * gets a RoundaboutRing (outer curb radius, island radius, solid flag), which
 * computeSectors turns into round corners, and the route generator drives
 * around the island (counterclockwise seen from above with the island on the
 * driver's left, right hand traffic: right turns take a quarter, left turns
 * three quarters of the ring).
 *
 * Variants: 'fountain' (solid island with a basin wall ring, look 'island')
 * or 'planter' (a low grassy mound with a beveled edge that can be jumped,
 * no walls). Content to add: fountain jets and lighting, planter shrubs and
 * signs, lane arrows and give way markings on the ring.
 */
import { CITY } from '../config';
import { edgeAngleFrom, otherNode, sectorAngle } from '../roadGraph';
import { DEG, sqrt } from '../../sim/math';
import type { DistrictModule } from './types';
import { emptyBuild } from './types';
import { circlePolygon, polyWalls, smooth01 } from './geom';

const CFG = CITY.districts.roundabout;

export const roundaboutModule: DistrictModule = {
  kind: 'roundabout',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const g = ctx.graph;
    const rng = ctx.rng;
    const count = rng.int(CFG.count[0], CFG.count[1]);
    const rivers = ctx.areas.filter((a) => a.kind === 'river');
    const candidates = g.nodes
      .filter((n) => {
        const m = n.edges.length;
        if (m < 3 || m > 4 || n.gi < 0 || ctx.claims.node.has(n.id)) return false;
        for (let k = 0; k < m; k++) {
          const e = g.edges[n.edges[k]];
          if (e.length < CFG.minEdge || e.bridge || e.kind === 'alley' || e.kind === 'backAlley' || ctx.claims.edge.has(e.id)) return false;
          if (g.nodes[otherNode(e, n.id)].ring) return false;
          if (sectorAngle(g, n, k) < CFG.minSectorDeg * DEG) return false;
        }
        // Keep clear of the river channel.
        for (const r of rivers) {
          const zc = r.params.zMid + r.params.amp * Math.sin(r.params.k * n.x + r.params.phase);
          if (Math.abs(n.z - zc) < r.params.top + CFG.outerRadius[1] + CITY.sidewalk + 12) return false;
        }
        return true;
      })
      .map((n) => n.id);
    rng.shuffle(candidates);
    const picked: number[] = [];
    for (const id of candidates) {
      if (picked.length >= count) break;
      const n = g.nodes[id];
      if (picked.some((p) => (g.nodes[p].x - n.x) ** 2 + (g.nodes[p].z - n.z) ** 2 < 320 * 320)) continue;
      const outer = rng.range(CFG.outerRadius[0], CFG.outerRadius[1]);
      const footprint = Math.PI * (outer + CITY.sidewalk) ** 2;
      if (ctx.budget.used + footprint > ctx.budget.total) break;
      const solid = rng.chance(CFG.fountainChance);
      n.ring = { outer, island: outer - CFG.ringWidth, solid };
      ctx.graphChanged();
      // Every corner must come out round (no road too wide for the ring at that angle).
      if (ctx.sectors()[id].some((s) => s.curb.length < 2)) {
        n.ring = undefined;
        ctx.graphChanged();
        continue;
      }
      picked.push(id);
      ctx.addArea(
        {
          kind: 'roundabout',
          variant: solid ? 'fountain' : 'planter',
          polygon: circlePolygon(n.x, n.z, outer + CITY.sidewalk, 24),
          path: [],
          nodes: [id],
          edges: [],
          faces: [],
          params: { x: n.x, z: n.z, outer, island: n.ring.island, solid: solid ? 1 : 0, heading: edgeAngleFrom(g, g.edges[n.edges[0]], id) },
        },
        footprint,
      );
    }
  },
  build(_ctx, area) {
    const b = emptyBuild();
    const { x, z, outer, island } = area.params;
    const id = area.id;
    b.exclusions.push(circlePolygon(x, z, outer + CITY.sidewalk + 1.5, 20));
    b.surfaces.push({ surface: 'sidewalk', polygon: circlePolygon(x, z, outer + CITY.sidewalk, 32), priority: 3.5, area: id });
    b.surfaces.push({ surface: 'road', polygon: circlePolygon(x, z, outer, 32), priority: 5.5, area: id });
    if (area.params.solid) {
      const ring = circlePolygon(x, z, island, 18);
      b.walls.push(...polyWalls(ring, false, 'island', id));
      b.surfaces.push({ surface: 'concrete', polygon: ring, priority: 10, area: id });
      b.props.push({ kind: 'fountain', x, z, yaw: 0, size: island, height: 1.1, area: id });
    } else {
      b.surfaces.push({ surface: 'grass', polygon: circlePolygon(x, z, island, 24), priority: 10, area: id });
      const H = CFG.planterHeight;
      const r0 = island - CFG.planterBevel;
      b.heightMods.push({
        minX: x - island,
        minZ: z - island,
        maxX: x + island,
        maxZ: z + island,
        add(px, pz, out) {
          const dx = px - x;
          const dz = pz - z;
          const r = sqrt(dx * dx + dz * dz);
          if (r >= island) return;
          const s = smooth01(r0, island, r);
          out.h += H * (1 - s.v);
          if (r > 1e-6 && s.d) {
            out.gx -= (H * s.d * dx) / r;
            out.gz -= (H * s.d * dz) / r;
          }
        },
      });
      b.props.push({ kind: 'planterIsland', x, z, yaw: 0, size: island, height: H, area: id });
    }
    return b;
  },
};
