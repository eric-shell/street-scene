/**
 * Fills the space between roads: intersection corner geometry (round at
 * roundabouts), curbs, sidewalks, block faces, the wall line that bounds the
 * drivable network, building footprints and street furniture anchors. Pure
 * and deterministic.
 *
 * Walls follow what is visibly built. The outer sidewalk line of every block
 * (its frontage) is sampled every meter: in front of a building it is a
 * 'building' wall; where a district opened it (parks, lots, plazas, ramps)
 * there is no wall; where a district draws it (bridge parapets, planters) it
 * takes that look; any other gap is a void. Void runs are handed to the late
 * district modules (infill: lots, plazas, planters, fountains), and what is
 * left becomes a low 'boundary' wall that the infill renderer draws. The
 * river's channel and ramp edges are not streets: no curbs, sidewalks,
 * buildings or furniture, and the frontage along them is open ground (the
 * river's own trench and bank walls are the collision there).
 */
import { CITY } from './config';
import { Chain, RoadGraph, RoadEdge, RoadNode, edgeAngleFrom, isBendNode, isRiverEdge, otherNode, sectorAngle } from './roadGraph';
import { SpatialGrid } from './spatial';
import { Terrain } from './terrain';
import { Prop, edgeSides, generateProps, lightStations } from './props';
import { BusBay, planBusBays } from './busBays';
import { Rng, deriveSeed } from '../sim/prng';
import { DEG, Vec2, atan2, clamp, cos, distToSegment, exp, lineIntersectT, sin, sqrt, TAU } from '../sim/math';
import type { AreaBuild, Circle, FrontageRun, FrontLook, LateContext, WallLook } from './districts/types';
import { PolygonIndex } from './districts/geom';

export type WallKind = 'wall' | 'barrier' | 'rail';

const FLARE = CITY.districts.backAlley.mouth;

/** Gap between the sidewalk wall line and building footprints (room for podium protrusions). */
export const BUILDING_SETBACK = 1.3;
/** Frontage sampling step (m) and probe depths behind the sidewalk line. */
const FRONT_STEP = 1;
const BUILDING_PROBE = BUILDING_SETBACK + 0.7;
const AREA_PROBE = 0.5;

/** A static collision segment. (nx, nz) points toward the drivable side. */
export interface Wall {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  nx: number;
  nz: number;
  kind: WallKind;
  /**
   * Barriers: index into World.barrierGroups. Rails: index of the route corner
   * rail the segment belongs to (consecutive segments of one rail share it).
   * Undefined for city walls.
   */
  group?: number;
  /** City walls ('wall'): what draws this wall (see districts/types.ts WallLook). */
  look?: WallLook;
  /** Area (CityDistricts.areas id) that owns the wall, if any. */
  area?: number;
  /**
   * Small convex solids (tree trunks, El pillars and stairs, plaza fountains): the solid this
   * segment is a face of, shared by all its faces (consecutive walls). The sim collides with the
   * solid as a whole (World.collideCircle), not with each one sided face: a face's 3 m anti
   * tunnelling band reaches right through anything thinner than that and would shove a car out of
   * the far side, then back, every tick.
   */
  solid?: Solid;
  /**
   * World height (m) of a low wall's top: a car whose body is above it (CarState.y > top) passes
   * over it, the only case where collision looks at height. Unset: a full height wall. Used by the
   * face under a car park's launch lip, which stops cars in the street while a car launching off
   * the roof flies over it (districts/carPark.ts).
   */
  top?: number;
}

/** A small convex solid: its faces with outward unit normals, in order around it. */
export interface Solid {
  faces: { ax: number; az: number; bx: number; bz: number; nx: number; nz: number }[];
}

export interface Sector {
  /** Sector angle in radians. */
  angle: number;
  /** Corner points on the curb line, ordered from edge k toward edge k+1. */
  curb: Vec2[];
  /** Same corner on the outer sidewalk (building) line. Same point count as curb. */
  outer: Vec2[];
  /** A shortcut's mouth corner, rounded off into a funnel (flaredCorner); its asphalt is the junction fan's. */
  flared?: boolean;
}

export interface MouthPoint {
  curb: Vec2;
  outer: Vec2;
}

/** Where an edge's two sides meet the intersection at each end. P side has normal (-dz, dx) for a->b. */
export interface EdgeMouths {
  aP: MouthPoint;
  aN: MouthPoint;
  bP: MouthPoint;
  bN: MouthPoint;
}

/**
 * A face of the planar road graph: a city block bounded by the outer sidewalk
 * lines of its streets. The ring runs with the block on the right of travel
 * (clockwise in x/z for real blocks); the single unbounded face around the
 * city is flagged `outer`.
 */
export interface BlockFace {
  id: number;
  ring: Vec2[];
  /** Per ring segment i (ring[i] -> ring[i + 1]): the edge it runs along, or -1 inside a rounded corner. */
  segEdge: number[];
  /** Per ring vertex: graph node whose corner it belongs to. */
  vertNode: number[];
  /** (node, sector index) corners in ring order. */
  corners: { node: number; sector: number }[];
  edges: number[];
  /** Absolute area (m^2). */
  area: number;
  outer: boolean;
}

export interface Building {
  /** Footprint center. */
  x: number;
  z: number;
  /** Rotation about Y; local +X runs along the street, local +Z away from it. */
  yaw: number;
  w: number;
  d: number;
  h: number;
  baseY: number;
  style: number;
  seed: number;
  edge: number;
}

export interface Streetlight {
  x: number;
  z: number;
  /** Unit vector from pole toward the road. */
  dx: number;
  dz: number;
  edge: number;
}

export interface SignAnchor {
  x: number;
  y: number;
  z: number;
  /** Unit outward facing normal of the building face. */
  nx: number;
  nz: number;
  w: number;
  h: number;
  blade: boolean;
  nameIndex: number;
  colorIndex: number;
}

export interface CityBlocks {
  sectors: Sector[][];
  mouths: EdgeMouths[];
  faces: BlockFace[];
  /** City walls: frontage (looks 'building' / 'boundary' / district looks) plus district walls. */
  walls: Wall[];
  buildings: Building[];
  /** Kept for the lighting code; every entry is also props[i] (kind 'streetlight'). */
  streetlights: Streetlight[];
  /** Destructible street furniture, see props.ts. */
  props: Prop[];
  /** Bus bays: stretches where the curb steps back into the sidewalk for a bus stop (busBays.ts). */
  bays: BusBay[];
  signs: SignAnchor[];
  edgeGrid: SpatialGrid;
}

/** What the district framework feeds into block generation (see districts/index.ts). */
export interface BlocksDistrictInput {
  /** Graph phase builds (exclusions, openings, front looks, reserved circles, walls). */
  builds: AreaBuild[];
  /** Runs the late modules on the void frontage; returns their builds. */
  late?: (ctx: LateContext) => AreaBuild[];
}

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
const add = (a: Vec2, b: Vec2, s = 1): Vec2 => ({ x: a.x + b.x * s, z: a.z + b.z * s });
const norm = (a: Vec2): Vec2 => {
  const l = sqrt(a.x * a.x + a.z * a.z) || 1;
  return { x: a.x / l, z: a.z / l };
};

export function edgeDir(g: RoadGraph, e: RoadEdge, from: number): Vec2 {
  const p = g.nodes[from];
  const q = g.nodes[otherNode(e, from)];
  return norm({ x: q.x - p.x, z: q.z - p.z });
}

/** A corner between 170 and 190 degrees is mitered only when its offset lines cross within this far (m) of the node along the first edge (a bend node: a few degrees, equal widths). */
const MITER_REACH = 1.5;

function sectorPoints(p: Vec2, dA: Vec2, oA: number, dB: Vec2, oB: number, angle: number): Vec2[] {
  const na: Vec2 = { x: -dA.z, z: dA.x };
  const nb: Vec2 = { x: dB.z, z: -dB.x };
  const pa = add(p, na, oA);
  const pb = add(p, nb, oB);
  // One sharp corner where the offset lines cross. Past 170 degrees only when the crossing sits
  // right by the node (MITER_REACH): a bend node's few degrees between two pieces of one street,
  // where two square-cut points would overlap on the inside and leave a wedge on the outside. A
  // street running straight on into a narrower one has nearly parallel lines that cross far down
  // the street: it keeps the square cut and its curb step at the node. Sharper outside corners are
  // rounded below; parallel lines (a ford's straight-through node) give two coincident points.
  if (angle < 190 * DEG) {
    const t = lineIntersectT(pa, dA, pb, dB);
    if (t !== null && (angle < 170 * DEG || (t > -MITER_REACH && t < MITER_REACH))) return [add(pa, dA, t)];
  }
  const pts: Vec2[] = [pa];
  if (angle > 190 * DEG) {
    // Round the outside of a bend.
    const steps = Math.ceil((angle - 180 * DEG) / (30 * DEG));
    const a0 = atan2(na.z, na.x);
    const arc = angle - 180 * DEG;
    const r = (oA + oB) / 2;
    for (let i = 1; i < steps; i++) {
      const a = a0 + (arc * i) / steps;
      pts.push({ x: p.x + cos(a) * r, z: p.z + sin(a) * r });
    }
  }
  pts.push(pb);
  return pts;
}

/**
 * Roundabout corner: the arc of a circle of radius R around the node between
 * where edge A's offset line (oA, CCW side) and edge B's (oB, CW side) meet it.
 * `steps` arc pieces; null if the arc would not fit inside the sector.
 */
function ringArc(p: Vec2, dA: Vec2, oA: number, dB: Vec2, oB: number, R: number, angle: number, steps: number): Vec2[] | null {
  if (R <= oA || R <= oB) return null;
  const na: Vec2 = { x: -dA.z, z: dA.x };
  const nb: Vec2 = { x: dB.z, z: -dB.x };
  const pa = add(add(p, na, oA), dA, sqrt(R * R - oA * oA));
  const pb = add(add(p, nb, oB), dB, sqrt(R * R - oB * oB));
  const a0 = atan2(pa.z - p.z, pa.x - p.x);
  let sweep = atan2(pb.z - p.z, pb.x - p.x) - a0;
  while (sweep <= 0) sweep += TAU;
  if (sweep >= angle) return null;
  const pts: Vec2[] = [pa];
  for (let i = 1; i < steps; i++) {
    const a = a0 + (sweep * i) / steps;
    pts.push({ x: p.x + cos(a) * R, z: p.z + sin(a) * R });
  }
  pts.push(pb);
  return pts;
}

/** Pieces of a flared shortcut corner. */
const FLARE_STEPS = 6;

/**
 * A shortcut's mouth corner as a funnel: where edge A's offset line (CCW
 * side) crosses edge B's (CW side), the sharp corner is replaced by a
 * quadratic curve from reachA along A's line past the crossing to reachB along
 * B's, the crossing its control point. The curb and building lines use the
 * same reaches, so the sidewalk between them keeps its width at both ends.
 * Null when the lines do not cross.
 */
function flaredCorner(p: Vec2, dA: Vec2, oA: number, dB: Vec2, oB: number, reachA: number, reachB: number): Vec2[] | null {
  const na: Vec2 = { x: -dA.z, z: dA.x };
  const nb: Vec2 = { x: dB.z, z: -dB.x };
  const pa = add(p, na, oA);
  const t = lineIntersectT(pa, dA, add(p, nb, oB), dB);
  if (t === null) return null;
  const K = add(pa, dA, t);
  const P0 = add(K, dA, reachA);
  const P2 = add(K, dB, reachB);
  const pts: Vec2[] = [];
  for (let i = 0; i <= FLARE_STEPS; i++) {
    const u = i / FLARE_STEPS;
    const a = (1 - u) * (1 - u);
    const b = 2 * u * (1 - u);
    const c = u * u;
    pts.push({ x: a * P0.x + b * K.x + c * P2.x, z: a * P0.z + b * K.z + c * P2.z });
  }
  return pts;
}

/** Arc pieces per roundabout corner: about one per 15 degrees of the sector. */
function ringSteps(angle: number): number {
  return Math.max(2, Math.ceil(angle / (15 * DEG)));
}

export function computeSectors(g: RoadGraph): Sector[][] {
  return g.nodes.map((n) => {
    const m = n.edges.length;
    const out: Sector[] = [];
    for (let k = 0; k < m; k++) {
      const eA = g.edges[n.edges[k]];
      const eB = g.edges[n.edges[(k + 1) % m]];
      const dA = edgeDir(g, eA, n.id);
      const dB = edgeDir(g, eB, n.id);
      const angle = sectorAngle(g, n, k);
      const p = { x: n.x, z: n.z };
      const oA = eA.width / 2;
      const oB = eB.width / 2;
      if (n.ring && m >= 2) {
        const steps = ringSteps(angle);
        const curb = ringArc(p, dA, oA, dB, oB, n.ring.outer, angle, steps);
        const outer = ringArc(p, dA, oA + eA.sidewalk, dB, oB + eB.sidewalk, n.ring.outer + CITY.sidewalk, angle, steps);
        if (curb && outer) {
          out.push({ angle, curb, outer });
          continue;
        }
      }
      // Where a shortcut meets its street the corner flares into a funnel that draws cars in. Each
      // reach stops short of its edge's middle (measured from where the building lines cross), so a
      // flare never runs into the next junction's corner.
      if (eA.shortcut !== eB.shortcut && angle < 170 * DEG) {
        const OA = oA + eA.sidewalk;
        const OB = oB + eB.sidewalk;
        const k = lineIntersectT(add(p, { x: -dA.z, z: dA.x }, OA), dA, add(p, { x: dB.z, z: -dB.x }, OB), dB);
        if (k !== null) {
          const K = add(add(p, { x: -dA.z, z: dA.x }, OA), dA, k);
          const room = (e: RoadEdge, d: Vec2) => Math.max(0, e.length / 2 - 2 - ((K.x - p.x) * d.x + (K.z - p.z) * d.z));
          const reachA = Math.min(eA.shortcut ? FLARE.alley : FLARE.street, room(eA, dA));
          const reachB = Math.min(eB.shortcut ? FLARE.alley : FLARE.street, room(eB, dB));
          const curb = reachA > 0.5 || reachB > 0.5 ? flaredCorner(p, dA, oA, dB, oB, reachA, reachB) : null;
          const outer = curb && flaredCorner(p, dA, OA, dB, OB, reachA, reachB);
          if (curb && outer) {
            out.push({ angle, curb, outer, flared: true });
            continue;
          }
        }
      }
      out.push({
        angle,
        curb: sectorPoints(p, dA, oA, dB, oB, angle),
        outer: sectorPoints(p, dA, oA + eA.sidewalk, dB, oB + eB.sidewalk, angle),
      });
    }
    return out;
  });
}

export function computeMouths(g: RoadGraph, sectors: Sector[][]): EdgeMouths[] {
  const first = (s: Sector): MouthPoint => ({ curb: s.curb[0], outer: s.outer[0] });
  const last = (s: Sector): MouthPoint => ({ curb: s.curb[s.curb.length - 1], outer: s.outer[s.outer.length - 1] });
  return g.edges.map((e) => {
    const na = g.nodes[e.a];
    const nb = g.nodes[e.b];
    const ka = na.edges.indexOf(e.id);
    const kb = nb.edges.indexOf(e.id);
    const ma = na.edges.length;
    const mb = nb.edges.length;
    return {
      aP: first(sectors[e.a][ka]),
      aN: last(sectors[e.a][(ka - 1 + ma) % ma]),
      bP: last(sectors[e.b][(kb - 1 + mb) % mb]),
      bN: first(sectors[e.b][kb]),
    };
  });
}

/**
 * Block faces by walking sectors: from sector k at node v, follow edge k + 1
 * to its far node w, where the same side of that edge is sector j = index of
 * the edge at w. The block stays on the right of travel.
 */
export function computeFaces(g: RoadGraph, sectors: Sector[][]): BlockFace[] {
  const seen = g.nodes.map((n) => new Uint8Array(n.edges.length));
  const faces: BlockFace[] = [];
  for (const start of g.nodes) {
    for (let k0 = 0; k0 < start.edges.length; k0++) {
      if (seen[start.id][k0]) continue;
      const ring: Vec2[] = [];
      const segEdge: number[] = [];
      const vertNode: number[] = [];
      const corners: { node: number; sector: number }[] = [];
      const edges: number[] = [];
      let v = start.id;
      let k = k0;
      for (let guard = 0; guard < 4 * g.edges.length + 8 && !seen[v][k]; guard++) {
        seen[v][k] = 1;
        corners.push({ node: v, sector: k });
        const s = sectors[v][k];
        for (let i = 0; i < s.outer.length; i++) {
          const p = s.outer[i];
          const prev = ring[ring.length - 1];
          if (prev && (prev.x - p.x) ** 2 + (prev.z - p.z) ** 2 < 1e-10) continue;
          if (prev) segEdge.push(i === 0 ? edges[edges.length - 1] : -1);
          ring.push(p);
          vertNode.push(v);
        }
        const node: RoadNode = g.nodes[v];
        const eid = node.edges[(k + 1) % node.edges.length];
        edges.push(eid);
        const w = otherNode(g.edges[eid], v);
        k = g.nodes[w].edges.indexOf(eid);
        v = w;
      }
      // Close the ring: the last segment runs along the last edge back to the first corner.
      if (ring.length > 1 && (ring[0].x - ring[ring.length - 1].x) ** 2 + (ring[0].z - ring[ring.length - 1].z) ** 2 < 1e-10) {
        ring.pop();
        vertNode.pop();
      } else segEdge.push(edges[edges.length - 1]);
      let a2 = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        a2 += p.x * q.z - q.x * p.z;
      }
      faces.push({ id: faces.length, ring, segEdge, vertNode, corners, edges, area: Math.abs(a2 / 2), outer: a2 > 0 });
    }
  }
  return faces;
}

/**
 * A block's sides: its edges grouped between junction corners, each side one street along the
 * block (its pieces through bend nodes, roadGraph.ts) as a chain from its first corner, in ring
 * order starting at a junction corner. A four sided block of three-piece streets has four sides
 * and twelve corners.
 */
export function faceSides(g: RoadGraph, f: BlockFace): Chain[] {
  const m = f.corners.length;
  let start = 0;
  while (start < m && isBendNode(g, f.corners[start].node)) start++;
  if (start >= m) start = 0;
  const sides: Chain[] = [];
  let cur: Chain | null = null;
  for (let k = 0; k < m; k++) {
    const i = (start + k) % m;
    const c = f.corners[i];
    if (!cur || !isBendNode(g, c.node)) {
      cur = { nodes: [c.node], edges: [], length: 0 };
      sides.push(cur);
    }
    const eid = f.edges[i];
    cur.edges.push(eid);
    cur.length += g.edges[eid].length;
    cur.nodes.push(f.corners[(i + 1) % m].node);
  }
  return sides;
}

export function makeWall(a: Vec2, b: Vec2, inside: Vec2, kind: WallKind): Wall | null {
  const d = sub(b, a);
  const len = sqrt(d.x * d.x + d.z * d.z);
  if (len < 0.05) return null;
  let nx = -d.z / len;
  let nz = d.x / len;
  const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  if ((inside.x - mid.x) * nx + (inside.z - mid.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  return { ax: a.x, az: a.z, bx: b.x, bz: b.z, nx, nz, kind };
}

export function buildEdgeGrid(g: RoadGraph): SpatialGrid {
  const pad = 40;
  const grid = SpatialGrid.forBounds(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad, CITY.broadphaseCell);
  for (const e of g.edges) {
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    grid.insertSegment(e.id, a.x, a.z, b.x, b.z, e.width / 2 + e.sidewalk + 2);
  }
  return grid;
}

/** Signed clearance from a point to the nearest road corridor (curb + sidewalk). Negative = inside. */
export function corridorClearance(g: RoadGraph, grid: SpatialGrid, x: number, z: number, scratch: number[]): number {
  grid.query(x - 1, z - 1, x + 1, z + 1, scratch);
  let best = Infinity;
  for (const id of scratch) {
    const e = g.edges[id];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - (e.width / 2 + e.sidewalk);
    if (d < best) best = d;
  }
  // Roundabout rings are wider than their roads.
  for (const n of g.nodes) {
    if (!n.ring) continue;
    const d = sqrt((x - n.x) ** 2 + (z - n.z) ** 2) - (n.ring.outer + CITY.sidewalk);
    if (d < best) best = d;
  }
  return best;
}

/** Is (x, z) inside a building footprint grown by margin? */
export function insideBuilding(b: Building, x: number, z: number, margin: number): boolean {
  const ux = cos(b.yaw);
  const uz = -sin(b.yaw);
  const dx = x - b.x;
  const dz = z - b.z;
  const lu = dx * ux + dz * uz;
  const lw = dx * -uz + dz * ux;
  return lu * lu <= (b.w / 2 + margin) ** 2 && lw * lw <= (b.d / 2 + margin) ** 2;
}

/** Frontage sample classes. Values >= 0 index the front look list. */
const OPEN = -1;
const BUILT = -2;
const VOID = -3;

export function generateBlocks(seed: number, g: RoadGraph, terrain: Terrain, districts: BlocksDistrictInput = { builds: [] }): CityBlocks {
  const rng = new Rng(deriveSeed(seed, 'blocks'));
  const sectors = computeSectors(g);
  const mouths = computeMouths(g, sectors);
  const faces = computeFaces(g, sectors);
  const edgeGrid = buildEdgeGrid(g);
  const scratch: number[] = [];
  const pad = 200;
  const bminX = g.bounds.minX - pad;
  const bminZ = g.bounds.minZ - pad;
  const bmaxX = g.bounds.maxX + pad;
  const bmaxZ = g.bounds.maxZ + pad;

  // District inputs: exclusions keep buildings out, openings remove frontage, front looks restyle it.
  const exclusions = new PolygonIndex<{ polygon: Vec2[] }>(bminX, bminZ, bmaxX, bmaxZ);
  const openings = new PolygonIndex<{ polygon: Vec2[] }>(bminX, bminZ, bmaxX, bmaxZ);
  const fronts: FrontLook[] = [];
  const frontIndex = new PolygonIndex<{ polygon: Vec2[]; i: number }>(bminX, bminZ, bmaxX, bmaxZ);
  const reserved: Circle[] = [];
  const districtWalls: Wall[] = [];
  const absorb = (b: AreaBuild) => {
    for (const p of b.exclusions) exclusions.add({ polygon: p });
    for (const p of b.openings) openings.add({ polygon: p });
    for (const f of b.frontLooks) {
      frontIndex.add({ polygon: f.polygon, i: fronts.length });
      fronts.push(f);
    }
    for (const c of b.reserved) reserved.push(c);
    for (const w of b.walls) districtWalls.push(w);
  };
  districts.builds.forEach(absorb);
  const excluded = (x: number, z: number) => exclusions.first(x, z) !== null;

  // Buildings behind the wall line.
  const buildings: Building[] = [];
  const cx = (g.bounds.minX + g.bounds.maxX) / 2;
  const cz = (g.bounds.minZ + g.bounds.maxZ) / 2;
  const downtown = (x: number, z: number) => {
    const r2 = ((x - cx) ** 2 + (z - cz) ** 2) / (CITY.downtownRadius * CITY.downtownRadius);
    return exp(-r2);
  };

  // Open corners: a share of junction corners keeps its buildings back, leaving a void the late
  // infill turns into a corner pocket of clutter racers can cut through. Own random stream, so the
  // choice does not depend on how many buildings were tried before.
  const openCorners: Vec2[][] = [];
  const openIndex = new PolygonIndex<{ polygon: Vec2[] }>(bminX, bminZ, bmaxX, bmaxZ);
  if (CITY.districts.infill.enabled) {
    const crng = new Rng(deriveSeed(seed, 'openCorners'));
    const [r0, r1] = CITY.districts.infill.openCornerReach;
    g.nodes.forEach((n, ni) => {
      const m = n.edges.length;
      if (m < 3 || n.ring) return;
      sectors[ni].forEach((s, k) => {
        if (s.angle > 170 * DEG || s.outer.length !== 1) return;
        if (!crng.chance(CITY.districts.infill.openCornerChance)) return;
        const dA = edgeDir(g, g.edges[n.edges[k]], n.id);
        const dB = edgeDir(g, g.edges[n.edges[(k + 1) % m]], n.id);
        const C = s.outer[0];
        const rA = crng.range(r0, r1);
        const rB = crng.range(r0, r1);
        const poly = [{ x: C.x, z: C.z }, add(C, dA, rA), add(add(C, dA, rA), dB, rB), add(C, dB, rB)];
        openCorners.push(poly);
        openIndex.add({ polygon: poly });
      });
    });
  }
  /** Oriented footprint rectangle (o, u, w, bw, bd) contains (x, z). */
  const inFootprint = (o: Vec2, u: Vec2, w: Vec2, bw: number, bd: number, x: number, z: number) => {
    const a = (x - o.x) * u.x + (z - o.z) * u.z;
    const b = (x - o.x) * w.x + (z - o.z) * w.z;
    return a > 0 && a < bw && b > 0 && b < bd;
  };

  const footprintOk = (o: Vec2, u: Vec2, w: Vec2, bw: number, bd: number): boolean => {
    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j <= 3; j++) {
        const p = add(add(o, u, (bw * i) / 3), w, (bd * j) / 3);
        if (corridorClearance(g, edgeGrid, p.x, p.z, scratch) < 0.25 || excluded(p.x, p.z) || openIndex.first(p.x, p.z)) return false;
      }
    }
    // Open corners smaller than the sample spacing: their corners must not fall inside either.
    for (const poly of openCorners) {
      if (Math.abs(poly[0].x - o.x) > 60 || Math.abs(poly[0].z - o.z) > 60) continue;
      for (const q of poly) if (inFootprint(o, u, w, bw, bd, q.x, q.z)) return false;
    }
    return true;
  };

  const pushBuilding = (o: Vec2, u: Vec2, w: Vec2, bw: number, bd: number, edge: number) => {
    const c = add(add(o, u, bw / 2), w, bd / 2);
    const f = downtown(c.x, c.z);
    const low = rng.range(7, 24);
    const tall = f * rng.range(18, 120) * (rng.chance(0.75) ? 1 : 0.35);
    const h = Math.max(6.4, Math.round((low + tall) / 3.2) * 3.2);
    let baseY = Infinity;
    for (const [i, j] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const p = add(add(o, u, bw * i), w, bd * j);
      baseY = Math.min(baseY, terrain.heightAt(p.x, p.z));
    }
    buildings.push({
      x: c.x,
      z: c.z,
      // local +X along u, local +Z along w (away from street)
      yaw: atan2(u.z, u.x) * -1,
      w: bw,
      d: bd,
      h,
      baseY: baseY - 0.6,
      style: rng.int(0, 5),
      seed: rng.int(0, 0x7fffffff),
      edge,
    });
  };

  g.edges.forEach((e, ei) => {
    // Back alleys run between the backs of the street buildings; the river's edges are not streets.
    if (e.kind === 'backAlley' || isRiverEdge(e)) return;
    const m = mouths[ei];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const d = norm({ x: b.x - a.x, z: b.z - a.z });
    const sides: { from: Vec2; to: Vec2; out: Vec2 }[] = [
      { from: m.aP.outer, to: m.bP.outer, out: { x: -d.z, z: d.x } },
      { from: m.aN.outer, to: m.bN.outer, out: { x: d.z, z: -d.x } },
    ];
    for (const side of sides) {
      const along = sub(side.to, side.from);
      const len = sqrt(along.x * along.x + along.z * along.z);
      if (len < 8) continue;
      const u = { x: along.x / len, z: along.z / len };
      let s = rng.range(0, 3);
      while (s < len - 6) {
        const mid = add(side.from, u, s);
        const f = downtown(mid.x, mid.z);
        let bw = rng.range(12, 26 + 14 * f);
        let bd = rng.range(14, 26 + 18 * f);
        bw = Math.min(bw, len - s);
        // Set back from the sidewalk wall line so street level facades can protrude.
        const o = add(add(side.from, u, s), side.out, BUILDING_SETBACK);
        let placed = false;
        for (let tryI = 0; tryI < 3 && !placed; tryI++) {
          if (bw >= 6 && footprintOk(o, u, side.out, bw, bd)) {
            pushBuilding(o, u, side.out, bw, bd, ei);
            placed = true;
          } else {
            bw *= 0.6;
            bd *= 0.75;
          }
        }
        s += placed ? bw + rng.range(0, 1.2) : 4;
      }
    }
  });

  // Corner buildings fill the gaps where two streets meet.
  g.nodes.forEach((n, ni) => {
    sectors[ni].forEach((s, k) => {
      if (s.angle > 170 * DEG || s.outer.length !== 1) return;
      const eA = g.edges[n.edges[k]];
      const dA = edgeDir(g, eA, n.id);
      const corner = s.outer[0];
      const out = { x: -dA.z, z: dA.x };
      const size = rng.range(14, 24);
      const o = add(corner, out, BUILDING_SETBACK);
      if (footprintOk(o, dA, out, size, size)) pushBuilding(o, dA, out, size, size, eA.id);
    });
  });

  // ---------- Frontage: classify the outer sidewalk line of every block ----------
  const bgrid = SpatialGrid.forBounds(bminX, bminZ, bmaxX, bmaxZ, CITY.broadphaseCell);
  buildings.forEach((b, i) => {
    const r = sqrt(b.w * b.w + b.d * b.d) / 2;
    bgrid.insertBox(i, b.x - r, b.z - r, b.x + r, b.z + r);
  });
  const bscratch: number[] = [];
  const builtAt = (x: number, z: number, margin: number) => {
    bgrid.query(x, z, x, z, bscratch);
    for (const id of bscratch) if (insideBuilding(buildings[id], x, z, margin)) return true;
    return false;
  };
  /** Nodes on the river's channel or a ramp: their sector corners are open ground too. */
  const riverNode = g.nodes.map((n) => n.edges.some((eid) => isRiverEdge(g.edges[eid])));
  /** Per face, per ring segment: sample classes. */
  const classes: Int16Array[][] = faces.map((f) =>
    f.ring.map((p, i) => {
      const q = f.ring[(i + 1) % f.ring.length];
      const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      const n = Math.max(1, Math.round(len / FRONT_STEP));
      const out = new Int16Array(n);
      if (len < 1e-6) return out;
      // Along a channel or ramp edge, or around a corner of one: the river draws its own walls there.
      const se = f.segEdge[i];
      if (se >= 0 ? isRiverEdge(g.edges[se]) : riverNode[f.vertNode[i]]) {
        out.fill(OPEN);
        return out;
      }
      // Into the block: right of travel.
      const rx = (q.z - p.z) / len;
      const rz = -(q.x - p.x) / len;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = p.x + (q.x - p.x) * t;
        const z = p.z + (q.z - p.z) * t;
        const ax = x + rx * AREA_PROBE;
        const az = z + rz * AREA_PROBE;
        if (openings.first(ax, az)) out[k] = OPEN;
        else {
          const fl = frontIndex.first(ax, az);
          if (fl) out[k] = fl.i;
          else if (builtAt(x + rx * BUILDING_PROBE, z + rz * BUILDING_PROBE, 0.1)) out[k] = BUILT;
          else out[k] = VOID;
        }
      }
      return out;
    }),
  );

  // Void runs in ring order for the late modules.
  let lateBuilds: AreaBuild[] = [];
  if (districts.late) {
    const voids: FrontageRun[] = [];
    faces.forEach((f, fi) => {
      const m = f.ring.length;
      const cls = classes[fi];
      // Start the walk at a non void sample so runs never wrap.
      let s0 = -1;
      let k0 = 0;
      for (let i = 0; i < m && s0 < 0; i++) {
        const k = cls[i].findIndex((c) => c !== VOID);
        if (k >= 0) {
          s0 = i;
          k0 = k;
        }
      }
      if (s0 < 0) {
        s0 = 0;
        k0 = 0;
      }
      let run: FrontageRun | null = null;
      const pointAt = (i: number, k: number): Vec2 => {
        const p = f.ring[i];
        const q = f.ring[(i + 1) % m];
        const t = k / cls[i].length;
        return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t };
      };
      const close = () => {
        if (run && run.points.length > 1) voids.push(run);
        run = null;
      };
      for (let step = 0; step <= m; step++) {
        const i = (s0 + step) % m;
        const c = cls[i];
        const kStart = step === 0 ? k0 : 0;
        const kEnd = step === m ? k0 : c.length;
        for (let k = kStart; k < kEnd; k++) {
          if (c[k] === VOID) {
            if (!run) run = { face: fi, points: [pointAt(i, k)], edges: [], corners: [], length: 0 };
          } else if (run) {
            const r: FrontageRun = run;
            // k = 0: the run ended exactly at the ring vertex already pushed.
            if (k > 0) {
              const p = pointAt(i, k);
              r.length += Math.hypot(p.x - r.points[r.points.length - 1].x, p.z - r.points[r.points.length - 1].z);
              r.points.push(p);
              r.edges.push(f.segEdge[i]);
            }
            const lastCorner = r.corners[r.corners.length - 1];
            if (lastCorner && lastCorner.index >= r.points.length - 1) r.corners.pop();
            close();
          }
        }
        if (step < m && run && kEnd === c.length) {
          // The run continues past this segment's end, through ring vertex i + 1.
          const r: FrontageRun = run;
          const v = f.ring[(i + 1) % m];
          const last = r.points[r.points.length - 1];
          r.length += Math.hypot(v.x - last.x, v.z - last.z);
          r.points.push({ x: v.x, z: v.z });
          r.edges.push(f.segEdge[i]);
          const p = f.ring[i];
          const q = f.ring[(i + 2) % m];
          const d1x = v.x - p.x;
          const d1z = v.z - p.z;
          const d2x = q.x - v.x;
          const d2z = q.z - v.z;
          const cross = d1x * d2z - d1z * d2x;
          const turn = atan2(cross, d1x * d2x + d1z * d2z);
          if (cross < 0 && turn < -10 * DEG) r.corners.push({ index: r.points.length - 1, angle: Math.PI + turn, node: f.vertNode[(i + 1) % m] });
        }
      }
      if (run) {
        // The walk stops at the first non void sample (s0, k0), so a run still open here ends there.
        const r: FrontageRun = run;
        if (k0 > 0) {
          const p = pointAt(s0, k0);
          r.length += Math.hypot(p.x - r.points[r.points.length - 1].x, p.z - r.points[r.points.length - 1].z);
          r.points.push(p);
          r.edges.push(f.segEdge[s0]);
        }
        const lastCorner = r.corners[r.corners.length - 1];
        if (lastCorner && lastCorner.index >= r.points.length - 1) r.corners.pop();
      }
      close();
    });
    lateBuilds = districts.late({
      terrain,
      buildings,
      voids,
      insideBuilding: builtAt,
      excluded,
      clearance: (x, z) => corridorClearance(g, edgeGrid, x, z, scratch),
    });
    // Late openings and looks only reclaim void frontage.
    const lateOpen = new PolygonIndex<{ polygon: Vec2[] }>(bminX, bminZ, bmaxX, bmaxZ);
    const lateFront = new PolygonIndex<{ polygon: Vec2[]; i: number }>(bminX, bminZ, bmaxX, bmaxZ);
    for (const b of lateBuilds) {
      for (const p of b.openings) lateOpen.add({ polygon: p });
      for (const fl of b.frontLooks) {
        lateFront.add({ polygon: fl.polygon, i: fronts.length });
        fronts.push(fl);
      }
      for (const w of b.walls) districtWalls.push(w);
    }
    faces.forEach((f, fi) => {
      f.ring.forEach((p, i) => {
        const q = f.ring[(i + 1) % f.ring.length];
        const c = classes[fi][i];
        const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
        const rx = (q.z - p.z) / len;
        const rz = -(q.x - p.x) / len;
        for (let k = 0; k < c.length; k++) {
          if (c[k] !== VOID) continue;
          const t = (k + 0.5) / c.length;
          const ax = p.x + (q.x - p.x) * t + rx * AREA_PROBE;
          const az = p.z + (q.z - p.z) * t + rz * AREA_PROBE;
          if (lateOpen.first(ax, az)) c[k] = OPEN;
          else {
            const fl = lateFront.first(ax, az);
            if (fl) c[k] = fl.i;
          }
        }
      });
    });
  }

  // Emit frontage walls: one per run of equal class, normal toward the road (left of travel).
  const walls: Wall[] = [];
  faces.forEach((f, fi) => {
    f.ring.forEach((p, i) => {
      const q = f.ring[(i + 1) % f.ring.length];
      const c = classes[fi][i];
      const len = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
      if (len < 0.05) return;
      const nx = -(q.z - p.z) / len;
      const nz = (q.x - p.x) / len;
      let k = 0;
      while (k < c.length) {
        let j = k + 1;
        while (j < c.length && c[j] === c[k]) j++;
        if (c[k] !== OPEN) {
          const t0 = k / c.length;
          const t1 = j / c.length;
          const look: WallLook = c[k] === BUILT ? 'building' : c[k] === VOID ? 'boundary' : fronts[c[k]].look;
          const w: Wall = { ax: p.x + (q.x - p.x) * t0, az: p.z + (q.z - p.z) * t0, bx: p.x + (q.x - p.x) * t1, bz: p.z + (q.z - p.z) * t1, nx, nz, kind: 'wall', look };
          if (c[k] >= 0) w.area = fronts[c[k]].area;
          walls.push(w);
        }
        k = j;
      }
    });
  });
  for (const w of districtWalls) walls.push(w);

  // Streetlights on the sidewalk just behind the curb, staggered per side. Off every road: at an
  // oblique junction (the warp makes them, roadGraph.ts) a wide street's carriageway reaches along
  // the sidewalk of a narrow one well past the curb corner.
  const streetlights: Streetlight[] = [];
  const lightScratch: number[] = [];
  const onRoad = (x: number, z: number): boolean => {
    edgeGrid.query(x - 1, z - 1, x + 1, z + 1, lightScratch);
    for (const id of lightScratch) {
      const e = g.edges[id];
      if (isRiverEdge(e)) continue;
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      if (distToSegment(x, z, a.x, a.z, b.x, b.z) < e.width / 2 + 0.3) return true;
    }
    return false;
  };
  g.edges.forEach((e, ei) => {
    if (e.kind === 'backAlley' || isRiverEdge(e)) return;
    for (const side of edgeSides(g, mouths, ei)) {
      const along = sub(side.to, side.from);
      const len = sqrt(along.x * along.x + along.z * along.z);
      const u = { x: along.x / len, z: along.z / len };
      for (const s of lightStations(len, side.phase, side.span)) {
        const p = add(add(side.from, u, s), side.inward, -0.8);
        if (reserved.some((c) => (c.x - p.x) ** 2 + (c.z - p.z) ** 2 < (c.r + 0.8) ** 2)) continue;
        if (onRoad(p.x, p.z)) continue;
        streetlights.push({ x: p.x, z: p.z, dx: side.inward.x, dz: side.inward.z, edge: ei });
      }
    }
  });

  // Bus bays between two streetlights, clear of district structures, paving and lane closures.
  const bays = planBusBays(seed, g, mouths, reserved, [...districts.builds, ...lateBuilds]);

  // Destructible street furniture (streetlights first, ids aligned with `streetlights`), then district clutter.
  const clutter = [...districts.builds, ...lateBuilds].flatMap((b) => b.destructibles);
  const props = generateProps(seed, g, sectors, mouths, streetlights, terrain, edgeGrid, reserved, clutter, bays);

  // Neon sign anchors on building fronts, biased toward downtown.
  const signs: SignAnchor[] = [];
  const candidates = buildings.map((_, i) => i).filter((i) => buildings[i].h > 9);
  const weights = candidates.map((i) => 0.25 + downtown(buildings[i].x, buildings[i].z));
  for (let n = 0; n < CITY.signCount && candidates.length; n++) {
    let total = 0;
    for (const w of weights) total += w;
    let r = rng.next() * total;
    let pick = 0;
    for (; pick < weights.length - 1; pick++) {
      r -= weights[pick];
      if (r <= 0) break;
    }
    const bi = candidates[pick];
    candidates.splice(pick, 1);
    weights.splice(pick, 1);
    const bld = buildings[bi];
    // Building local axes: u along street, w away from street.
    const u = { x: cos(-bld.yaw), z: sin(-bld.yaw) };
    const w = { x: -u.z, z: u.x };
    // Make sure w points away from the street: front face is the one nearer the edge line.
    const e = g.edges[bld.edge];
    const ea = g.nodes[e.a];
    const eb = g.nodes[e.b];
    const front0 = add({ x: bld.x, z: bld.z }, w, -bld.d / 2);
    const back0 = add({ x: bld.x, z: bld.z }, w, bld.d / 2);
    const flip = distToSegment(front0.x, front0.z, ea.x, ea.z, eb.x, eb.z) > distToSegment(back0.x, back0.z, ea.x, ea.z, eb.x, eb.z);
    const outN = flip ? w : { x: -w.x, z: -w.z };
    const face = add({ x: bld.x, z: bld.z }, outN, bld.d / 2 + 0.12);
    const blade = rng.chance(0.45);
    const sw = blade ? rng.range(1.4, 2.2) : clamp(rng.range(6, 12), 4, bld.w * 0.85);
    const sh = blade ? rng.range(5, 9) : rng.range(1.6, 2.8);
    const offsetAlong = rng.range(-0.3, 0.3) * Math.max(0, bld.w - sw);
    const pos = add(face, u, offsetAlong);
    const y = bld.baseY + clamp(rng.range(4.5, 14), 4.5, bld.h - sh / 2 - 1) + sh / 2;
    signs.push({
      x: pos.x,
      y,
      z: pos.z,
      nx: outN.x,
      nz: outN.z,
      w: sw,
      h: sh,
      blade,
      nameIndex: rng.int(0, 1023),
      colorIndex: rng.int(0, 1023),
    });
  }

  return { sectors, mouths, faces, walls, buildings, streetlights, props, bays, signs, edgeGrid };
}

export function edgeAngle(g: RoadGraph, e: RoadEdge): number {
  return edgeAngleFrom(g, e, e.a);
}
