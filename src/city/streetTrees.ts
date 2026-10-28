/**
 * Sidewalk trees: a row of trunks along the sidewalks of plain streets, avenues,
 * boulevards and diagonals, planted toward the building line (the outer third of
 * the walk) so the canopy overhangs the sidewalk and not the road. Each trunk is a
 * small convex sim solid (wall look 'tree', no area), the same body the parks' and
 * roundabouts' trees are, so a car that climbs the curb meets it; the renderer
 * draws a tree on every one of them (render/districts/streetTrees.ts) and on
 * nothing else, which keeps invariant 5 (every solid is drawn, every drawn trunk a
 * solid). The species is the render's business (the neighbourhood decides palms);
 * the positions, radius, crown size and height are sim data.
 *
 * Runs in generateBlocks after generateProps, so it sees every streetlight, signal
 * and piece of furniture, the bus bays and path mouths, the district structures and
 * every frontage wall. Stations lie along each street side at STREET_TREES.pitch,
 * in street coordinates (a street's pieces through bend nodes share one rhythm, the
 * two sides stagger by half a pitch), with seeded jitter; a station is dropped when
 * it falls near a junction, on or too near a road, in a bay, a district structure,
 * a prop, or any wall that is not a building's frontage, when the frontage behind it
 * is not unbroken building (a lot or plaza opening stays open) or when another tree
 * is too close. Edges a district claims (the El, tunnels, the market street, the
 * lake's, overpasses, the highway, a bluff's crossing) and streets with a lane
 * closure take none. Own random stream, drawn the same whether or not a station
 * survives. Pure and deterministic.
 */
import { CITY, STREET_TREES } from './config';
import type { EdgeMouths, Wall } from './blocks';
import { BusBay, bayHitsCircle, baysByEdge } from './busBays';
import { circlePolygon, pointInPolygon, solidWalls } from './districts/geom';
import type { Prop } from './props';
import { edgeSides } from './props';
import type { RoadGraph } from './roadGraph';
import { isRiverEdge } from './roadGraph';
import { SpatialGrid } from './spatial';
import type { Terrain } from './terrain';
import { Rng, deriveSeed } from '../sim/prng';
import { Vec2, clamp, distToSegment, sqrt } from '../sim/math';

const T = STREET_TREES;

/** One sidewalk tree: a sim solid trunk and the crown the renderer grows on it. */
export interface StreetTree {
  x: number;
  z: number;
  /** Ground height at the foot (m): the top of the sidewalk. */
  y: number;
  /** Trunk radius (m): the sim solid's circle. */
  radius: number;
  /** Crown radius (m) and total height (m). */
  size: number;
  height: number;
  /** Road edge index it stands beside. */
  edge: number;
}

/** Why a station was dropped (counted by reason in StreetTreePlan.rejected). */
export type TreeReject = 'edge' | 'narrow' | 'skip' | 'junction' | 'road' | 'bay' | 'reserved' | 'prop' | 'frontage' | 'wall' | 'facade' | 'tree';

export interface StreetTreePlan {
  trees: StreetTree[];
  /** The trunks' solids, in tree order (`tree` i owns the walls `i * trunkSides` ...). */
  walls: Wall[];
  /** Stations dropped by reason (street sides counted for 'edge' and 'narrow'). */
  rejected: Record<TreeReject, number>;
}

export interface StreetTreeInput {
  seed: number;
  g: RoadGraph;
  mouths: EdgeMouths[];
  props: readonly Prop[];
  bays: readonly BusBay[];
  /** District structures standing on the sidewalks (the El's pillars, gate piers ...). */
  reserved: readonly { x: number; z: number; r: number }[];
  /** Every city wall: the frontage and the districts'. */
  walls: readonly Wall[];
  edgeGrid: SpatialGrid;
  terrain: Terrain;
  /** Edges a district claims or closes a lane on: no trees. */
  skipEdges: ReadonlySet<number>;
  /** Polygons no tree stands in (a jump exit's flight and rollout). */
  keepClear: readonly Vec2[][];
}

const REJECTS: readonly TreeReject[] = ['edge', 'narrow', 'skip', 'junction', 'road', 'bay', 'reserved', 'prop', 'frontage', 'wall', 'facade', 'tree'];

export function planStreetTrees(input: StreetTreeInput): StreetTreePlan {
  const { g, mouths, props, bays, reserved, walls, edgeGrid, terrain, skipEdges, keepClear } = input;
  const rejected = Object.fromEntries(REJECTS.map((k) => [k, 0])) as Record<TreeReject, number>;
  const out: StreetTreePlan = { trees: [], walls: [], rejected };
  if (!T.enabled) return out;
  const rng = new Rng(deriveSeed(input.seed, 'streetTrees'));
  const r = T.trunkRadius;
  const pad = 40;
  const [bx0, bz0, bx1, bz1] = [g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad];
  const propGrid = SpatialGrid.forBounds(bx0, bz0, bx1, bz1, CITY.broadphaseCell);
  for (const p of props) propGrid.insertBox(p.id, p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius);
  const wallGrid = SpatialGrid.forBounds(bx0, bz0, bx1, bz1, CITY.broadphaseCell);
  walls.forEach((w, i) => wallGrid.insertSegment(i, w.ax, w.az, w.bx, w.bz, 0.5));
  const treeGrid = SpatialGrid.forBounds(bx0, bz0, bx1, bz1, CITY.broadphaseCell);
  const bayOf = baysByEdge(bays, g.edges.length);
  const scratch: number[] = [];

  /** On or too near a road, or off every sidewalk band (an oblique junction's carriageway reaches along a narrow street's walk). */
  const offWalk = (x: number, z: number): boolean => {
    edgeGrid.query(x - 1, z - 1, x + 1, z + 1, scratch);
    let corridor = Infinity;
    for (const id of scratch) {
      const e = g.edges[id];
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
      if (d - e.width / 2 < r + T.roadClear) return true;
      corridor = Math.min(corridor, d - e.width / 2 - e.sidewalk);
    }
    return corridor > -r - 0.1;
  };

  g.edges.forEach((e, ei) => {
    if (!(T.kinds as readonly string[]).includes(e.kind)) return;
    if (e.bridge || e.shortcut || isRiverEdge(e) || skipEdges.has(ei)) {
      rejected.edge += 2;
      return;
    }
    if (e.sidewalk < T.minSidewalk) {
      rejected.narrow += 2;
      return;
    }
    const pitch = T.pitch[e.kind as keyof typeof T.pitch];
    // The outer third (not nearer the facade than facadeClear); a boulevard's wide walk takes an inner row too.
    const rows = [{ phase: 0, depth: Math.min(e.sidewalk - T.facadeClear, e.sidewalk * T.across) }];
    if (e.kind === 'boulevard' && e.sidewalk >= T.secondRowMin) rows.push({ phase: 0.25, depth: e.sidewalk / 3 });
    for (const side of edgeSides(g, mouths, ei)) {
      const ax = side.to.x - side.from.x;
      const az = side.to.z - side.from.z;
      const len = sqrt(ax * ax + az * az);
      if (len < 1e-6) continue;
      const u = { x: ax / len, z: az / len };
      for (const row of rows) {
        // Stations in street coordinates: the first one at or past this piece's start.
        const k0 = Math.ceil((side.span.before - T.jitter) / pitch - 0.5 - side.phase - row.phase);
        for (let k = k0; ; k++) {
          const sStreet = pitch * (k + 0.5 + side.phase + row.phase);
          if (sStreet - T.jitter >= side.span.before + len) break;
          // The draws come first, whatever happens to the station.
          const jit = rng.range(-T.jitter, T.jitter);
          const dj = rng.range(-T.acrossJitter, T.acrossJitter);
          const drop = rng.chance(T.skip);
          const local = sStreet + jit - side.span.before;
          if (local < 0 || local >= len) continue;
          const reject = (why: TreeReject): void => {
            rejected[why]++;
          };
          // Clear of the junctions at both ends of the whole street, in street coordinates: a short piece
          // into a bend node (a roundabout's approach, say) leaves the next junction nearer than its own end.
          const along = side.span.before + local;
          if (along < T.junctionClear || along > side.span.total - T.junctionClear) {
            reject('junction');
            continue;
          }
          if (drop) {
            reject('skip');
            continue;
          }
          const depth = clamp(row.depth + dj, 0.8, e.sidewalk - T.facadeClear);
          const x = side.from.x + u.x * local - side.inward.x * depth;
          const z = side.from.z + u.z * local - side.inward.z * depth;
          if (offWalk(x, z)) {
            reject('road');
            continue;
          }
          let hit = false;
          // Bays of every edge that reaches here (a path mouth belongs to the edge it cuts).
          for (const id of scratch) for (const b of bayOf[id]) if (bayHitsCircle(b, x, z, r, T.bayClear)) hit = true;
          if (hit) {
            reject('bay');
            continue;
          }
          if (keepClear.some((poly) => pointInPolygon(x, z, poly))) {
            reject('reserved');
            continue;
          }
          if (reserved.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < (q.r + r + T.reservedClear) ** 2)) {
            reject('reserved');
            continue;
          }
          const reach = T.propClear + 2;
          propGrid.query(x - reach, z - reach, x + reach, z + reach, scratch);
          for (const id of scratch) {
            const p = props[id];
            const min = Math.max(T.propClear, p.radius + r + T.propGap);
            if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) hit = true;
          }
          if (hit) {
            reject('prop');
            continue;
          }
          // A building stands behind the trunk and 2.5 m to either side of it, along the curb: nothing here is an opening.
          let front = true;
          for (const off of [-T.frontProbe, 0, T.frontProbe]) {
            const l = local + off;
            const qx = side.from.x + u.x * l - side.inward.x * e.sidewalk;
            const qz = side.from.z + u.z * l - side.inward.z * e.sidewalk;
            wallGrid.query(qx - 0.5, qz - 0.5, qx + 0.5, qz + 0.5, scratch);
            let found = false;
            for (const id of scratch) {
              const w = walls[id];
              if (w.look === 'building' && w.nx * side.inward.x + w.nz * side.inward.z > 0.7 && distToSegment(qx, qz, w.ax, w.az, w.bx, w.bz) < 0.35) found = true;
            }
            if (!found) front = false;
          }
          if (!front) {
            reject('frontage');
            continue;
          }
          // Any other wall near the trunk (a planter, a fence, a district's) or the facade itself too close.
          const wr = r + T.wallClear;
          wallGrid.query(x - wr, z - wr, x + wr, z + wr, scratch);
          let facade = false;
          for (const id of scratch) {
            const w = walls[id];
            const d = distToSegment(x, z, w.ax, w.az, w.bx, w.bz);
            if (w.look === 'building') {
              if (d < T.facadeClear - 1e-6) facade = true;
            } else if (d < wr) hit = true;
          }
          if (hit) {
            reject('wall');
            continue;
          }
          if (facade) {
            reject('facade');
            continue;
          }
          treeGrid.query(x - T.treeGap, z - T.treeGap, x + T.treeGap, z + T.treeGap, scratch);
          for (const id of scratch) {
            const t = out.trees[id];
            if ((t.x - x) ** 2 + (t.z - z) ** 2 < T.treeGap * T.treeGap) hit = true;
          }
          if (hit) {
            reject('tree');
            continue;
          }
          const id = out.trees.length;
          out.trees.push({ x, z, y: terrain.heightAt(x, z) + CITY.curbHeight, radius: r, size: rng.range(T.size[0], T.size[1]), height: rng.range(T.height[0], T.height[1]), edge: ei });
          treeGrid.insertBox(id, x - r, z - r, x + r, z + r);
          // A solid with no area: it belongs to the street, not to a district.
          for (const w of solidWalls(circlePolygon(x, z, r, T.trunkSides), 'tree', 0)) {
            delete w.area;
            out.walls.push(w);
          }
        }
      }
    }
  });
  return out;
}
