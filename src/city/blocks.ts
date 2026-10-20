/**
 * Fills the space between roads: intersection corner geometry, curbs,
 * sidewalks, the wall line that bounds the drivable network, building
 * footprints and street furniture anchors. Pure and deterministic.
 */
import { CITY } from './config';
import { RoadGraph, RoadEdge, edgeAngleFrom, otherNode, sectorAngle } from './roadGraph';
import { SpatialGrid } from './spatial';
import { Terrain } from './terrain';
import { Prop, edgeSides, generateProps, lightStations } from './props';
import { Rng, deriveSeed } from '../sim/prng';
import { DEG, Vec2, atan2, clamp, cos, distToSegment, exp, lineIntersectT, sin, sqrt } from '../sim/math';

export type WallKind = 'wall' | 'barrier' | 'rail';

/** Gap between the sidewalk wall line and building footprints (room for podium protrusions). */
export const BUILDING_SETBACK = 1.3;

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
}

export interface Sector {
  /** Sector angle in radians. */
  angle: number;
  /** Corner points on the curb line, ordered from edge k toward edge k+1. */
  curb: Vec2[];
  /** Same corner on the outer sidewalk (building) line. Same point count as curb. */
  outer: Vec2[];
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
  walls: Wall[];
  buildings: Building[];
  /** Kept for the lighting code; every entry is also props[i] (kind 'streetlight'). */
  streetlights: Streetlight[];
  /** Destructible street furniture, see props.ts. */
  props: Prop[];
  signs: SignAnchor[];
  edgeGrid: SpatialGrid;
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

function sectorPoints(p: Vec2, dA: Vec2, oA: number, dB: Vec2, oB: number, angle: number): Vec2[] {
  const na: Vec2 = { x: -dA.z, z: dA.x };
  const nb: Vec2 = { x: dB.z, z: -dB.x };
  const pa = add(p, na, oA);
  const pb = add(p, nb, oB);
  if (angle < 170 * DEG) {
    const t = lineIntersectT(pa, dA, pb, dB);
    if (t !== null) return [add(pa, dA, t)];
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
      out.push({
        angle,
        curb: sectorPoints(p, dA, eA.width / 2, dB, eB.width / 2, angle),
        outer: sectorPoints(p, dA, eA.width / 2 + CITY.sidewalk, dB, eB.width / 2 + CITY.sidewalk, angle),
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
    grid.insertSegment(e.id, a.x, a.z, b.x, b.z, e.width / 2 + CITY.sidewalk + 2);
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
    const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - (e.width / 2 + CITY.sidewalk);
    if (d < best) best = d;
  }
  return best;
}

export function generateBlocks(seed: number, g: RoadGraph, terrain: Terrain): CityBlocks {
  const rng = new Rng(deriveSeed(seed, 'blocks'));
  const sectors = computeSectors(g);
  const mouths = computeMouths(g, sectors);
  const edgeGrid = buildEdgeGrid(g);
  const scratch: number[] = [];

  // Walls along the outer sidewalk line of every edge side, plus around corners.
  const walls: Wall[] = [];
  g.edges.forEach((e, i) => {
    const m = mouths[i];
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const wP = makeWall(m.aP.outer, m.bP.outer, mid, 'wall');
    const wN = makeWall(m.aN.outer, m.bN.outer, mid, 'wall');
    if (wP) walls.push(wP);
    if (wN) walls.push(wN);
  });
  g.nodes.forEach((n, ni) => {
    for (const s of sectors[ni]) {
      for (let i = 0; i + 1 < s.outer.length; i++) {
        const w = makeWall(s.outer[i], s.outer[i + 1], { x: n.x, z: n.z }, 'wall');
        if (w) walls.push(w);
      }
    }
  });

  // Buildings behind the wall line.
  const buildings: Building[] = [];
  const cx = (g.bounds.minX + g.bounds.maxX) / 2;
  const cz = (g.bounds.minZ + g.bounds.maxZ) / 2;
  const downtown = (x: number, z: number) => {
    const r2 = ((x - cx) ** 2 + (z - cz) ** 2) / (CITY.downtownRadius * CITY.downtownRadius);
    return exp(-r2);
  };

  const footprintOk = (o: Vec2, u: Vec2, w: Vec2, bw: number, bd: number): boolean => {
    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j <= 3; j++) {
        const p = add(add(o, u, (bw * i) / 3), w, (bd * j) / 3);
        if (corridorClearance(g, edgeGrid, p.x, p.z, scratch) < 0.25) return false;
      }
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
      if (s.angle > 170 * DEG) return;
      const eA = g.edges[n.edges[k]];
      const dA = edgeDir(g, eA, n.id);
      const corner = s.outer[0];
      const out = { x: -dA.z, z: dA.x };
      const size = rng.range(14, 24);
      const o = add(corner, out, BUILDING_SETBACK);
      if (footprintOk(o, dA, out, size, size)) pushBuilding(o, dA, out, size, size, eA.id);
    });
  });

  // Streetlights on the sidewalk just behind the curb, staggered per side.
  const streetlights: Streetlight[] = [];
  g.edges.forEach((_, ei) => {
    for (const side of edgeSides(g, mouths, ei)) {
      const along = sub(side.to, side.from);
      const len = sqrt(along.x * along.x + along.z * along.z);
      const u = { x: along.x / len, z: along.z / len };
      for (const s of lightStations(len, side.phase)) {
        const p = add(add(side.from, u, s), side.inward, -0.8);
        streetlights.push({ x: p.x, z: p.z, dx: side.inward.x, dz: side.inward.z, edge: ei });
      }
    }
  });

  // Destructible street furniture (streetlights first, ids aligned with `streetlights`).
  const props = generateProps(seed, g, sectors, mouths, streetlights, terrain, edgeGrid);

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

  return { sectors, mouths, walls, buildings, streetlights, props, signs, edgeGrid };
}

export function edgeAngle(g: RoadGraph, e: RoadEdge): number {
  return edgeAngleFrom(g, e, e.a);
}
