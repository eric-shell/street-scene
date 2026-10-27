/**
 * Lake: a park sized body of water in the city grid, with the streets round
 * it as a drivable shore road. Two to four adjacent plain blocks (four sided
 * grid cells of park size, a block in from the map edge) are merged into one
 * by deleting the streets between them; a 2 x 2 square is never taken, since
 * its middle junction would be left with no street at all, and on a seed that
 * rolls the expressway (which runs along the rows) the lake is one block deep.
 *
 * Planning, in two steps (districts/index.ts):
 *  - carve (DistrictModule.carve, before every other module plans): the roll
 *    (lakeRolled, CFG.chance from its own stream), the cluster search, and the
 *    deletion (roadGraph.ts removeEdges), tried first on a copy of the graph
 *    so a cluster whose shore rings would not fit is skipped untouched.
 *    Deleting renumbers every id, so it runs while nobody holds one; the area
 *    then claims every node and street of its shore (graphChanged carries the
 *    claims through the river's own renumbering), so roundabouts, alleys,
 *    shortcuts, the El, the expressway, closures and the market keep off it.
 *    The river, the El's swings, the bluff and the hills keep off the water by
 *    geometry (CFG.riverClear, CFG.clearance).
 *  - plan (its registry slot, right after the car parks: the first with the
 *    topology final): it claims the merged block, takes its ring as the
 *    area's polygon and sets the water level from the ground along the coping.
 *
 * Cross section, inward from the block's outer sidewalk line (shoreRing): a
 * promenade CFG.promenade wide, paved at curb height ('concrete', drivable:
 * the frontage is open, no building or infill); the railing on its inner edge
 * (look 'lakeRail', normal toward the promenade: nothing behind it is
 * reachable); a stone coping; then the bank, where the ground falls from the
 * terrain to a flat bed over CFG.bank (a height modifier blending the base
 * terrain into the bed level, exact gradient, 0 on the promenade and outside
 * the block). The water stands CFG.freeboard under the lowest point of the
 * coping, flat across the whole lake whatever the city's relief does there;
 * everything behind the coping is a 'water' surface.
 *
 * Dressing: lantern posts by the railing (destructible, lit like the parks'),
 * a bench facing the water between each pair, a few trees on the promenade
 * away from the corners (solid trunks, look 'tree'), and for the renderer
 * (render/districts/lake.ts) a jetty off the middle of the longest straight
 * shore, behind a gate in the railing, and a fountain jet at the most open
 * spot of a lake wide enough for one.
 */
import { CITY } from '../config';
import { type BlockFace, computeFaces, computeSectors, faceSides } from '../blocks';
import { type Chain, type RoadGraph, removeEdges, sortNodeEdges } from '../roadGraph';
import { createTerrain } from '../terrain';
import { Rng, deriveSeed } from '../../sim/prng';
import { type Vec2, atan2, sqrt } from '../../sim/math';
import type { Area, AreaBuild, DistrictModule, HeightSample, PlanContext } from './types';
import { emptyBuild } from './types';
import { circlePolygon, distToPolygonEdge, pointInPolygon, polygonArea, polygonBounds, polygonCentroid, polyWalls, smooth01, type Smooth, solidWalls } from './geom';
import { convexRing } from './park';
import { highwayRolled, highwayRows } from './highway/line';
import { riverL, riverModule } from './river';

const CFG = CITY.districts.lake;

/** Scratch for the basin's smoothstep (the terrain is queried per wheel per substep). */
const SMOOTH: Smooth = { v: 0, d: 0 };

/** Street kinds a lake's shore may be; only plain streets are deleted between its blocks. */
const SHORE_KINDS = new Set(['street', 'avenue', 'boulevard']);

/** Does this seed roll a lake (its own stream, the carve's first draw)? A seed that rolls one may still find no cluster. */
export function lakeRolled(seed: number): boolean {
  return CFG.enabled && new Rng(deriveSeed(seed, 'district:lake')).chance(CFG.chance);
}

/**
 * The block's outer sidewalk line as the lake builds on it: the area's polygon with points closer than
 * half a metre to the one before dropped, in the face's order (the block on the right of travel).
 */
export function shoreRing(area: Area): Vec2[] {
  return cleanRing(area.polygon);
}

function cleanRing(ring: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || (p.x - q.x) ** 2 + (p.z - q.z) ** 2 >= 0.25) out.push({ x: p.x, z: p.z });
  }
  while (out.length > 3 && (out[0].x - out[out.length - 1].x) ** 2 + (out[0].z - out[out.length - 1].z) ** 2 < 0.25) out.pop();
  return out;
}

/**
 * `ring` moved d (m) into the block, one point per ring point (so strips between two offsets pair up):
 * each side shifted along its inward normal, consecutive sides meeting again (a side that runs straight
 * on through a point keeps the point's own offset). Null where it does not fit: a point out of the
 * ring or nearer its outline than d, or a side turned round.
 */
export function offsetRing(ring: readonly Vec2[], d: number): Vec2[] | null {
  const n = ring.length;
  if (n < 3) return null;
  const inward = polygonArea(ring as Vec2[]) < 0 ? 1 : -1;
  const sides = ring.map((p, i) => {
    const q = ring[(i + 1) % n];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
    const ux = (q.x - p.x) / l;
    const uz = (q.z - p.z) / l;
    return { x: p.x + uz * inward * d, z: p.z - ux * inward * d, ux, uz };
  });
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = sides[(i - 1 + n) % n];
    const b = sides[i];
    const den = a.ux * b.uz - a.uz * b.ux;
    if (Math.abs(den) < 1e-4) {
      out.push({ x: b.x, z: b.z });
      continue;
    }
    const t = ((b.x - a.x) * b.uz - (b.z - a.z) * b.ux) / den;
    out.push({ x: a.x + a.ux * t, z: a.z + a.uz * t });
  }
  for (let i = 0; i < n; i++) {
    const p = out[i];
    if (!pointInPolygon(p.x, p.z, ring as Vec2[]) || distToPolygonEdge(p.x, p.z, ring as Vec2[]) < d - 0.3) return null;
    const q = out[(i + 1) % n];
    const s = sides[i];
    if ((q.x - p.x) * s.ux + (q.z - p.z) * s.uz < 0) return null;
  }
  return out;
}

/** The railing's line, the water's edge (behind the coping) and the foot of the bank, inward from the shore ring. */
export function lakeRings(area: Area): { shore: Vec2[]; rail: Vec2[]; water: Vec2[]; bed: Vec2[] } {
  const shore = shoreRing(area);
  const rings = ringsOf(shore);
  if (!rings) throw new Error(`lake ${area.id}: its shore rings do not fit`);
  return rings;
}

function ringsOf(shore: Vec2[]): { shore: Vec2[]; rail: Vec2[]; water: Vec2[]; bed: Vec2[] } | null {
  const rail = offsetRing(shore, CFG.promenade);
  const water = rail && offsetRing(shore, CFG.promenade + CFG.coping);
  const bed = water && offsetRing(shore, CFG.promenade + CFG.coping + CFG.bank);
  return rail && water && bed ? { shore, rail, water, bed } : null;
}

/** A lake area's water level and bed (absolute heights, m), set when it claims its block. */
export function lakeLevels(area: Area): { water: number; bed: number } {
  return { water: area.params.water, bed: area.params.bed };
}

/** A plain block on the grid: one cell (i, j) between grid columns i, i + 1 and rows j, j + 1. */
interface Cell {
  face: BlockFace;
  i: number;
  j: number;
  sides: Chain[];
  /** Its four corners' node ids. */
  corners: number[];
}

/** The side two cells share (a street chain between their two common corners), or null. */
function sharedSide(a: Cell, b: Cell): Chain | null {
  const common = a.corners.filter((n) => b.corners.includes(n));
  if (common.length !== 2) return null;
  return a.sides.find((s) => common.includes(s.nodes[0]) && common.includes(s.nodes[s.nodes.length - 1])) ?? null;
}

function cloneGraph(g: RoadGraph): RoadGraph {
  return { nodes: g.nodes.map((n) => ({ ...n, edges: n.edges.slice() })), edges: g.edges.map((e) => ({ ...e })), bounds: { ...g.bounds }, plan: g.plan };
}

/**
 * The river's params as it would plan them on these streets with no lake (its own stream, on a copy of
 * the graph), or null for a city without one. The river plans right after the lake carves.
 */
function riverWithout(ctx: PlanContext): Record<string, number> | null {
  const g = cloneGraph(ctx.graph);
  const areas: Area[] = [];
  const trial: PlanContext = {
    seed: ctx.seed,
    rng: new Rng(deriveSeed(ctx.seed, 'district:river')),
    graph: g,
    areas,
    claims: { node: new Map(), edge: new Map(), face: new Map() },
    budget: { ...ctx.budget },
    sectors: () => computeSectors(g),
    faces: () => computeFaces(g, computeSectors(g)),
    addArea(a, footprint = 0) {
      const area: Area = { id: areas.length, ...a };
      areas.push(area);
      trial.budget.used += footprint;
      return area;
    },
    graphChanged: () => sortNodeEdges(g),
  };
  riverModule.plan(trial);
  return areas.find((a) => a.kind === 'river')?.params ?? null;
}

/** The face of `faces` holding (x, z), or null. */
function faceAt(faces: BlockFace[], x: number, z: number): BlockFace | null {
  return faces.find((f) => !f.outer && pointInPolygon(x, z, f.ring)) ?? null;
}

export const lakeModule: DistrictModule = {
  kind: 'lake',
  phase: 'graph',

  carve(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    if (!rng.chance(CFG.chance)) return;
    const g = ctx.graph;
    const W = g.plan.gridW;
    const H = g.plan.gridH;
    const e0 = CFG.edgeCells;
    // Plain blocks: four sides, each corner a grid junction of one cell, park sized, convex.
    const cells = new Map<number, Cell>();
    for (const f of ctx.faces()) {
      if (f.outer || f.area < CFG.minArea || f.area > CFG.maxArea || ctx.claims.face.has(f.id)) continue;
      const sides = faceSides(g, f);
      if (sides.length !== 4) continue;
      const corners = sides.map((s) => s.nodes[0]);
      const ns = corners.map((id) => g.nodes[id]);
      if (ns.some((n) => n.gi < 0)) continue;
      const i = Math.min(...ns.map((n) => n.gi));
      const j = Math.min(...ns.map((n) => n.gj));
      const keys = new Set(ns.map((n) => (n.gj - j) * 2 + (n.gi - i)));
      if (keys.size !== 4 || ns.some((n) => n.gi - i > 1 || n.gj - j > 1)) continue;
      if (i < e0 || j < e0 || i > W - 2 - e0 || j > H - 2 - e0) continue;
      if (f.edges.some((e) => !SHORE_KINDS.has(g.edges[e].kind) || ctx.claims.edge.has(e))) continue;
      if (corners.some((n) => ctx.claims.node.has(n)) || !convexRing(f.ring)) continue;
      cells.set(j * W + i, { face: f, i, j, sides, corners });
    }
    const near = (c: Cell): Cell[] =>
      [cells.get(c.j * W + c.i - 1), cells.get(c.j * W + c.i + 1), cells.get((c.j - 1) * W + c.i), cells.get((c.j + 1) * W + c.i)].filter((n): n is Cell => {
        if (!n) return false;
        const s = sharedSide(c, n);
        return !!s && s.edges.every((e) => g.edges[e].kind === 'street');
      });
    // The expressway (planned later) runs along the rows, and a lake shuts every row its shore is on: on a
    // seed that rolls one, the lake stays one block deep (two rows, not three), off the rows the deck tries
    // first (its own stream's order, highway/line.ts highwayRows), so the deck still finds its way.
    const flat = highwayRolled(ctx.seed);
    const keep = new Set<number>();
    if (flat) {
      // Its stream as its plan draws it: the roll, then the row order.
      const hw = new Rng(deriveSeed(ctx.seed, 'district:highway'));
      hw.chance(CITY.districts.highway.chance);
      for (const r of highwayRows(hw, H).slice(0, CFG.highwayRows)) keep.add(r);
    }
    for (const [key, c] of cells) if (keep.has(c.j) || keep.has(c.j + 1)) cells.delete(key);
    // And off the river's band, where it would run with no lake (its plan on a copy of the streets): the
    // river then runs exactly there, its entrances and bridges as they would be, and so does everything
    // planned around it.
    const river = riverWithout(ctx);
    if (river) {
      const reach = river.top + CFG.riverClear;
      for (const [key, c] of cells) {
        const ls = c.face.ring.map((q) => riverL(river, q.x, q.z));
        if (ls.some((l) => Math.abs(l) < reach || l > 0 !== ls[0] > 0)) cells.delete(key);
      }
    }
    const order = [...cells.values()];
    rng.shuffle(order);
    for (let t = 0; t < Math.min(CFG.tries, order.length); t++) {
      const first = order[t];
      const target = rng.int(CFG.blocks[0], CFG.blocks[1]);
      const cluster = [first];
      while (cluster.length < target) {
        const next: Cell[] = [];
        for (const c of cluster) {
          for (const n of near(c)) {
            if (cluster.includes(n) || next.includes(n)) continue;
            // No more than three blocks one way and two the other, never a 2 x 2 square.
            const is = [...cluster, n].map((x) => x.i);
            const js = [...cluster, n].map((x) => x.j);
            const si = Math.max(...is) - Math.min(...is) + 1;
            const sj = Math.max(...js) - Math.min(...js) + 1;
            if (Math.max(si, sj) > 3 || Math.min(si, sj) > 2 || (si === 2 && sj === 2 && cluster.length + 1 >= 4) || (flat && sj > 1)) continue;
            next.push(n);
          }
        }
        if (!next.length) break;
        cluster.push(next[rng.int(0, next.length - 1)]);
      }
      if (cluster.length < CFG.blocks[0]) continue;
      // The streets between the blocks go; every junction keeps two streets at least.
      const dead = new Set<number>();
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          const s = sharedSide(cluster[a], cluster[b]);
          if (s) for (const e of s.edges) dead.add(e);
        }
      }
      if (!dead.size) continue;
      const lost = new Map<number, number>();
      for (const e of dead) for (const n of [g.edges[e].a, g.edges[e].b]) lost.set(n, (lost.get(n) ?? 0) + 1);
      if ([...lost].some(([n, k]) => g.nodes[n].gi >= 0 && g.nodes[n].edges.length - k < 2)) continue;
      const footprint = cluster.reduce((s, c) => s + c.face.area, 0);
      if (ctx.budget.used + footprint > ctx.budget.total) continue;
      // Tried on a copy first: the merged block must hold the promenade, the coping and the bank.
      // A point in the first block (convex), so in the merged one: how the block is found again later.
      const probe = polygonCentroid(cluster[0].face.ring);
      const trial = cloneGraph(g);
      removeEdges(trial, dead);
      const merged = faceAt(computeFaces(trial, computeSectors(trial)), probe.x, probe.z);
      if (!merged || !ringsOf(cleanRing(merged.ring))) continue;
      ctx.graphChanged(removeEdges(g, dead));
      const f = faceAt(ctx.faces(), probe.x, probe.z)!;
      const nodes = [...new Set(f.corners.map((c) => c.node))];
      const edges = [...new Set(f.edges)];
      ctx.addArea(
        {
          kind: 'lake',
          variant: 'lake',
          polygon: f.ring,
          path: [],
          nodes,
          edges,
          faces: [],
          params: { blocks: cluster.length, px: probe.x, pz: probe.z, seed: rng.int(1, 0x7ffffffe), water: 0, bed: 0 },
        },
        footprint,
      );
      return;
    }
  },

  // The streets are final from here on (the car parks claimed theirs just before): claim the merged block.
  plan(ctx) {
    for (const a of ctx.areas) {
      if (a.kind !== 'lake' || a.faces.length) continue;
      const f = faceAt(ctx.faces(), a.params.px, a.params.pz);
      if (!f || ctx.claims.face.has(f.id)) throw new Error(`lake ${a.id} lost its block`);
      a.faces = [f.id];
      a.polygon = f.ring;
      ctx.claims.face.set(f.id, a.id);
      // The water stands freeboard under the lowest point of the coping, on the base terrain (nothing
      // planned later slopes the ground here: the hills keep off).
      const base = createTerrain(ctx.seed);
      const { water } = lakeRings(a);
      let low = Infinity;
      for (let i = 0; i < water.length; i++) {
        const p = water[i];
        const q = water[(i + 1) % water.length];
        const n = Math.max(1, Math.ceil(sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) / 4));
        for (let k = 0; k < n; k++) low = Math.min(low, base.heightAt(p.x + ((q.x - p.x) * k) / n, p.z + ((q.z - p.z) * k) / n));
      }
      a.params.water = low - CFG.freeboard;
      a.params.bed = a.params.water - CFG.depth;
    }
  },

  build(ctx, area) {
    const b = emptyBuild();
    const id = area.id;
    const { shore, rail, water } = lakeRings(area);
    b.exclusions.push(shore);
    b.openings.push(shore);
    // The promenade (raised to curb height in world.ts), the water behind the coping above it.
    b.surfaces.push({ surface: 'concrete', polygon: shore, priority: 2, area: id });
    b.surfaces.push({ surface: 'water', polygon: water, priority: 3, area: id });
    b.walls.push(...polyWalls(rail, false, 'lakeRail', id));
    b.heightMods.push(basin(ctx.seed, area, shore));

    // The jetty: off the middle of the longest straight run of the railing, square to it.
    const rng = new Rng(area.params.seed);
    const runs = straightRuns(rail);
    runs.sort((p, q) => q.len - p.len);
    const reserve: { x: number; z: number; r: number }[] = [];
    const run = runs[0];
    const jettyLen = rng.range(CFG.jetty[0], CFG.jetty[1]);
    if (run) {
      const mid = alongRing(rail, run.from, run.len / 2);
      const tip = { x: mid.x + mid.nx * jettyLen, z: mid.z + mid.nz * jettyLen };
      if (pointInPolygon(tip.x, tip.z, water) && distToPolygonEdge(tip.x, tip.z, water) > jettyLen * 0.6) {
        b.hints.push({ kind: 'jetty', points: [{ x: mid.x, z: mid.z }, tip], values: [CFG.jettyWidth] });
        reserve.push({ x: mid.x, z: mid.z, r: 4 });
      }
    }
    // The fountain: at the most open spot of the water, when there is room for one.
    const spot = openSpot(water);
    if (spot.r >= CFG.fountainRoom) {
      const jetty = b.hints.find((h) => h.kind === 'jetty');
      const clear = !jetty || sqrt((jetty.points[1].x - spot.x) ** 2 + (jetty.points[1].z - spot.z) ** 2) > 20;
      if (clear) b.hints.push({ kind: 'fountain', points: [{ x: spot.x, z: spot.z }], values: [spot.r] });
    }

    // Along the railing on the promenade: a lantern post every lampSpacing, a bench facing the water
    // between each pair, and a few trees away from the corners (the racing line cuts those).
    const corners = shoreCorners(shore);
    const lift = CITY.curbHeight;
    const per = ringLength(rail);
    const lamps = Math.max(4, Math.round(per / CFG.lampSpacing));
    const step = per / lamps;
    const off = rng.range(0, step);
    const clearOf = (x: number, z: number, r: number) => reserve.every((c) => (c.x - x) ** 2 + (c.z - z) ** 2 > (c.r + r) ** 2);
    let treeRun = rng.range(0, CFG.treeSpacing);
    for (let k = 0; k < lamps; k++) {
      const s = off + k * step;
      const lamp = atRing(rail, s);
      const lx = lamp.x - lamp.nx * 0.7;
      const lz = lamp.z - lamp.nz * 0.7;
      if (clearOf(lx, lz, 1)) b.destructibles.push({ kind: 'parkLamp', x: lx, z: lz, yaw: atan2(-lamp.nx, -lamp.nz), lift, area: id });
      const mid = atRing(rail, s + step / 2);
      const bx = mid.x - mid.nx * 1.3;
      const bz = mid.z - mid.nz * 1.3;
      // Benches face the water (local +Z toward it, as a street bench faces the road).
      if (clearOf(bx, bz, 1.5)) b.destructibles.push({ kind: 'bench', x: bx, z: bz, yaw: atan2(mid.nx, mid.nz), lift, area: id });
      treeRun += step;
      if (treeRun < CFG.treeSpacing) continue;
      const q = atRing(rail, s + step / 4);
      const tx = q.x - q.nx * 2.6;
      const tz = q.z - q.nz * 2.6;
      if (corners.some((c) => (c.x - tx) ** 2 + (c.z - tz) ** 2 < CFG.treeCornerClear ** 2) || !clearOf(tx, tz, 2)) continue;
      treeRun = 0;
      b.walls.push(...solidWalls(circlePolygon(tx, tz, CFG.treeRadius, 6), 'tree', id));
      b.props.push({ kind: 'tree', x: tx, z: tz, yaw: rng.range(0, Math.PI * 2), size: 2.4 + rng.range(0, 1.4), height: 6 + rng.range(0, 3.5), area: id });
    }
    return b;
  },
};

/**
 * The basin: the base terrain blended into the flat bed level over the bank, by the inward distance d
 * from the shore ring (smoothstep from the coping's inner edge to the foot of the bank). With w(d) the
 * blend and b the base terrain, h = w (bed - b), so dh = w' (bed - b) grad d - w grad b: exact, and 0 on
 * the promenade and everywhere outside the block (so 0 at the box).
 */
function basin(seed: number, area: Area, shore: Vec2[]): AreaBuild['heightMods'][number] {
  const base = createTerrain(seed);
  const bed = area.params.bed;
  const d0 = CFG.promenade + CFG.coping;
  const d1 = d0 + CFG.bank;
  const segs = shore.map((p, i) => {
    const q = shore[(i + 1) % shore.length];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    return { ax: p.x, az: p.z, dx, dz, l2: dx * dx + dz * dz || 1 };
  });
  return {
    ...polygonBounds(shore),
    add(x: number, z: number, out: HeightSample) {
      if (!pointInPolygon(x, z, shore)) return;
      let best = Infinity;
      let qx = 0;
      let qz = 0;
      for (const s of segs) {
        let t = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = s.ax + s.dx * t;
        const pz = s.az + s.dz * t;
        const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
        if (d2 < best) {
          best = d2;
          qx = px;
          qz = pz;
        }
      }
      const d = sqrt(best);
      if (d <= d0) return;
      const m = smooth01(d0, d1, d, SMOOTH);
      const h = base.heightAt(x, z);
      const g = base.slopeAt(x, z);
      const diff = bed - h;
      const gdx = (x - qx) / d;
      const gdz = (z - qz) / d;
      out.h += m.v * diff;
      out.gx += m.d * gdx * diff - m.v * g.gx;
      out.gz += m.d * gdz * diff - m.v * g.gz;
    },
  };
}

/** Total length of a closed ring (m). */
function ringLength(ring: readonly Vec2[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const q = ring[(i + 1) % ring.length];
    s += sqrt((q.x - ring[i].x) ** 2 + (q.z - ring[i].z) ** 2);
  }
  return s;
}

/** The point `s` m round a closed ring from its first point, with the unit normal into the block (toward the water). */
function atRing(ring: readonly Vec2[], s: number): { x: number; z: number; nx: number; nz: number } {
  return alongRing(ring, 0, s);
}

/** The point `s` m round a closed ring from point `from`, with the unit normal into the block. */
function alongRing(ring: readonly Vec2[], from: number, s: number): { x: number; z: number; nx: number; nz: number } {
  const n = ring.length;
  const inward = polygonArea(ring as Vec2[]) < 0 ? 1 : -1;
  const total = ringLength(ring);
  let left = ((s % total) + total) % total;
  for (let k = 0; k < n; k++) {
    const p = ring[(from + k) % n];
    const q = ring[(from + k + 1) % n];
    const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2);
    if (left <= l || k === n - 1) {
      const t = l > 0 ? Math.min(1, left / l) : 0;
      const ux = l > 0 ? (q.x - p.x) / l : 1;
      const uz = l > 0 ? (q.z - p.z) / l : 0;
      return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, nx: uz * inward, nz: -ux * inward };
    }
    left -= l;
  }
  return { x: ring[0].x, z: ring[0].z, nx: 0, nz: 0 };
}

/** Runs of a ring that go straight on (each turn under 8 degrees): their first point and length (m). */
function straightRuns(ring: readonly Vec2[]): { from: number; len: number }[] {
  const n = ring.length;
  const dir = (i: number) => {
    const p = ring[i % n];
    const q = ring[(i + 1) % n];
    return atan2(q.z - p.z, q.x - p.x);
  };
  const turn = (i: number) => {
    let d = dir(i) - dir(i - 1 + n);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  // Start at a sharp turn so no run wraps.
  let start = 0;
  for (let i = 0; i < n; i++) if (turn(i) >= 0.14) {
    start = i;
    break;
  }
  const runs: { from: number; len: number }[] = [];
  let cur: { from: number; len: number } | null = null;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!cur || turn(i) >= 0.14) runs.push((cur = { from: i, len: 0 }));
    const q = ring[(i + 1) % n];
    cur.len += sqrt((q.x - ring[i].x) ** 2 + (q.z - ring[i].z) ** 2);
  }
  return runs;
}

/** The shore ring's corners (where it turns more than 30 degrees, one point per rounded corner's arc). */
function shoreCorners(ring: readonly Vec2[]): Vec2[] {
  const n = ring.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const o = ring[(i - 1 + n) % n];
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const a = atan2(p.z - o.z, p.x - o.x);
    let d = atan2(q.z - p.z, q.x - p.x) - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    if (Math.abs(d) > 0.2) out.push(p);
  }
  return out;
}

/** The point of the polygon farthest from its outline, on a 6 m grid (deterministic), and that distance (m). */
function openSpot(poly: Vec2[]): { x: number; z: number; r: number } {
  const bb = polygonBounds(poly);
  let best = { x: (bb.minX + bb.maxX) / 2, z: (bb.minZ + bb.maxZ) / 2, r: 0 };
  for (let x = bb.minX + 3; x < bb.maxX; x += 6) {
    for (let z = bb.minZ + 3; z < bb.maxZ; z += 6) {
      if (!pointInPolygon(x, z, poly)) continue;
      const r = distToPolygonEdge(x, z, poly);
      if (r > best.r) best = { x, z, r };
    }
  }
  return best;
}
