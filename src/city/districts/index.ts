/**
 * District registry and deterministic planner.
 *
 * planDistricts(seed, graph) runs every 'graph' phase module in registry
 * order (each with its own random stream), letting them claim nodes, edges
 * and block faces and edit the graph, then builds their areas. The result
 * feeds the terrain (height modifiers), block generation (exclusions,
 * openings, walls, reserved circles) and, through `late`, runs the 'late'
 * modules (infill) once buildings exist. finalize() indexes surfaces and
 * rasterizes areas for fast areaAt queries.
 *
 * Order matters and is fixed. Before anything plans, the lake carves (its
 * carve step, DistrictModule.carve): it deletes the streets between its
 * blocks, which renumbers every node and edge id, so it goes while nobody
 * holds one; it claims its shore streets and nodes then, and everything
 * planned after keeps off them (the river, the El's swings, the bluff and the
 * hills keep off its water too). Then the river (it decides bridges; its own
 * chain merge renumbers again, carrying the lake's claims through
 * graphChanged), the subway (claims a street column), roundabouts, alleys, the bluff (moves part
 * of the El off its street; before the routes, which run over its level
 * crossing), the elevated highway (claims a street row and its ramps' blocks,
 * keeping off everything planned before it), back alleys (the last
 * module allowed to change the graph topology, so face ids stay stable), the
 * monument plaza (before the parks: it takes a block the routes turn round,
 * for its race passes), parks (claim faces), hills (claim clusters of faces and keep
 * their slopes clear of everything placed before them), tunnels and
 * overpasses (they keep clear of every slope and claim the blocks a ridge
 * stands in, so they come after the hills and before downtown), reserved
 * features, and downtown (claims every face left). The optional topology hook runs
 * right after back alleys (route shortcuts); the night market, which goes on
 * the routes it picked (PlanContext.event), is planned right after it. Car
 * parks are planned in the hook too (they need both routes); they claim their
 * block only after the night market's graph edit, in carParkModule's plan,
 * and the lake claims its merged block right after them (the first slot with
 * the topology final), before anything else that claims blocks could take it.
 */
import { CITY } from '../config';
import type { RoadGraph, Renumber } from '../roadGraph';
import { sortNodeEdges } from '../roadGraph';
import { BlockFace, Sector, computeFaces, computeMouths, computeSectors } from '../blocks';
import { Rng, deriveSeed } from '../../sim/prng';
import { PolygonIndex, pointInPolygon, polygonBounds } from './geom';
import type { Vec2 } from '../../sim/math';
import type { Area, AreaBuild, AreaKind, BuildContext, Claims, DistrictModule, HeightMod, LateContext, PlanContext, PlannedEvent, SurfacePatch } from './types';
import { AREA_PRIORITY, emptyBuild } from './types';
import { riverModule } from './river';
import { subwayModule } from './subway';
import { bluffModule } from './bluff';
import { roundaboutModule } from './roundabout';
import { alleyModule, backAlleyModule } from './alley';
import { parkModule } from './park';
import { monumentModule } from './monument';
import { hillsModule } from './hills';
import { tunnelModule } from './tunnel';
import { overpassModule } from './overpass';
import { highwayModule } from './highway/highway';
import { waterfrontModule } from './waterfront';
import { lakeModule } from './lake';
import { downtownModule } from './downtown';
import { infillModule } from './infill';
import { marketModule } from './market';
import { roadworksModule } from './roadworks';
import { parkingLotModule } from './parkingLot';
import { carParkModule, CAR_HALF, carParks, flightCorridor } from './carPark';
import { jumpFlightZone } from './alleyDressing';

/** Every module, in planning order. */
export const DISTRICT_MODULES: readonly DistrictModule[] = [
  riverModule,
  subwayModule,
  roundaboutModule,
  alleyModule,
  bluffModule,
  highwayModule,
  backAlleyModule,
  marketModule,
  carParkModule,
  // Claims its block here; its streets were deleted in its carve step, before the river.
  lakeModule,
  monumentModule,
  parkModule,
  hillsModule,
  tunnelModule,
  overpassModule,
  waterfrontModule,
  downtownModule,
  infillModule,
  roadworksModule,
  // Last: a lot is part of a block downtown holds (it claims no face) on streets the lane closures left, and claims no edge, so
  // planning one never moves what the other modules planned (the closures, and so the drag strip, would shift with it).
  parkingLotModule,
];

export function districtModule(kind: AreaKind): DistrictModule {
  const m = DISTRICT_MODULES.find((d) => d.kind === kind);
  if (!m) throw new Error(`no district module for ${kind}`);
  return m;
}

const RASTER_CELL = 4;

export interface CityDistricts {
  areas: Area[];
  /** builds[i] belongs to areas[i]. */
  builds: AreaBuild[];
  /** All height modifiers of graph phase areas. */
  heightMods: HeightMod[];
  /** For generateBlocks: graph phase builds and the late module runner. */
  blocksInput: { builds: AreaBuild[]; late: (ctx: LateContext) => AreaBuild[]; areas: readonly Area[]; keepClear: () => Vec2[][] };
  /** Area at a point (rasterized, RASTER_CELL m), or null on plain streets / outside. Call finalize first. */
  areaAt(x: number, z: number): Area | null;
  /** Highest priority surface patch at a point, or null. */
  surfaceAt(x: number, z: number): SurfacePatch | null;
  /** Index surfaces and rasterize areas once blocks exist. */
  finalize(): void;
}

function makeContext(seed: number, g: RoadGraph, areas: Area[], claims: Claims, budget: { total: number; used: number }, kind: AreaKind, stream = `district:${kind}`): PlanContext {
  let faces: BlockFace[] | null = null;
  let sectors: Sector[][] | null = null;
  return {
    seed,
    rng: new Rng(deriveSeed(seed, stream)),
    graph: g,
    areas,
    claims,
    budget,
    sectors() {
      if (!sectors) sectors = computeSectors(g);
      return sectors;
    },
    faces() {
      if (!faces) faces = computeFaces(g, this.sectors());
      return faces;
    },
    graphChanged(renumber) {
      if (claims.face.size) throw new Error('graph edited after faces were claimed');
      if (renumber) renumberClaims(areas, claims, renumber);
      sortNodeEdges(g);
      faces = null;
      sectors = null;
    },
    addArea(a, footprint = 0) {
      const area: Area = { id: areas.length, ...a };
      areas.push(area);
      for (const n of area.nodes) claims.node.set(n, area.id);
      for (const e of area.edges) claims.edge.set(e, area.id);
      for (const f of area.faces) claims.face.set(f, area.id);
      budget.used += footprint;
      return area;
    },
  };
}

/** Carry the planned areas' node and edge lists and the node and edge claims through an id compaction (dropping removed ones). */
function renumberClaims(areas: Area[], claims: Claims, r: Renumber): void {
  const map = (ids: number[], to: Int32Array) => ids.map((id) => to[id]).filter((id) => id >= 0);
  for (const a of areas) {
    a.nodes = map(a.nodes, r.node);
    a.edges = map(a.edges, r.edge);
  }
  for (const [held, to] of [
    [claims.node, r.node],
    [claims.edge, r.edge],
  ] as const) {
    const old = [...held];
    held.clear();
    for (const [id, area] of old) if (to[id] >= 0) held.set(to[id], area);
  }
}

export interface PlanHooks {
  /**
   * Runs once the street topology is final (right after back alleys, before
   * any module claims faces), with a context of its own random stream that
   * may still edit the graph and add areas: world.ts picks both routes here
   * and carves their shortcuts. What it returns (the event flavour and both
   * routes) reaches every module planned after it as PlanContext.event.
   */
  topology?(ctx: PlanContext): PlannedEvent | void;
}

export function planDistricts(seed: number, g: RoadGraph, hooks: PlanHooks = {}): CityDistricts {
  const areas: Area[] = [];
  const claims: Claims = { node: new Map(), edge: new Map(), face: new Map() };
  const blockArea = computeFaces(g, computeSectors(g)).reduce((s, f) => s + (f.outer ? 0 : f.area), 0);
  const budget = { total: blockArea * CITY.districts.maxSpecialFraction, used: 0 };
  let lastCtx: PlanContext | null = null;
  let event: PlannedEvent | undefined;
  // Lifecycle step 0 (types.ts): street deletions, while no area holds an id.
  for (const m of DISTRICT_MODULES) if (m.phase === 'graph' && m.carve) m.carve(makeContext(seed, g, areas, claims, budget, m.kind));
  for (const m of DISTRICT_MODULES) {
    if (m.phase !== 'graph') continue;
    const ctx = makeContext(seed, g, areas, claims, budget, m.kind);
    if (event) ctx.event = event;
    m.plan(ctx);
    lastCtx = ctx;
    if (m === backAlleyModule && hooks.topology) {
      const hctx = makeContext(seed, g, areas, claims, budget, 'backAlley', 'routeShortcuts');
      event = hooks.topology(hctx) ?? undefined;
      lastCtx = hctx;
    }
  }
  const sectors = lastCtx ? lastCtx.sectors() : computeSectors(g);
  const faces = lastCtx ? lastCtx.faces() : computeFaces(g, sectors);
  const mouths = computeMouths(g, sectors);
  const bctx: BuildContext = { seed, graph: g, areas, faces, sectors, mouths };
  const builds = areas.map((a) => districtModule(a.kind).build(bctx, a));
  const heightMods = builds.flatMap((b) => b.heightMods);
  const graphBuilds = builds.slice();

  const late = (lc: LateContext): AreaBuild[] => {
    const first = areas.length;
    for (const m of DISTRICT_MODULES) {
      if (m.phase !== 'late') continue;
      const ctx = makeContext(seed, g, areas, claims, budget, m.kind);
      ctx.late = lc;
      if (event) ctx.event = event;
      // Late modules see the final faces and sectors.
      ctx.faces = () => faces;
      ctx.sectors = () => sectors;
      m.plan(ctx);
    }
    const lctx: BuildContext = { ...bctx, late: lc };
    const out: AreaBuild[] = [];
    for (let i = first; i < areas.length; i++) {
      const b = districtModule(areas[i].kind).build(lctx, areas[i]);
      builds[i] = b;
      out.push(b);
    }
    return out;
  };

  // Lookups, filled by finalize().
  let raster: Int16Array | null = null;
  let rx0 = 0;
  let rz0 = 0;
  let rcols = 0;
  let rrows = 0;
  let surfaces: PolygonIndex<SurfacePatch> | null = null;
  const hits: SurfacePatch[] = [];

  return {
    areas,
    builds,
    heightMods,
    blocksInput: {
      builds: graphBuilds,
      late,
      areas,
      // The sidewalk trees stay out of every jump exit's flight and its rollout on the landing street, and of a car park's launch and landing (a car lands and runs on across the street).
      keepClear: () => [
        ...areas.filter((a) => a.kind === 'backAlley' && a.params.jumpExit).map((a) => jumpFlightZone(a, a.params.landMax + CITY.districts.backAlley.route.jump.rollout, CAR_HALF + 1.5)),
        ...carParks(areas).map((g) => flightCorridor(g, g.lipBack + g.landZone, CAR_HALF + 1.5)),
      ],
    },
    areaAt(x, z) {
      if (!raster) return null;
      const i = Math.floor((x - rx0) / RASTER_CELL);
      const j = Math.floor((z - rz0) / RASTER_CELL);
      if (i < 0 || j < 0 || i >= rcols || j >= rrows) return null;
      const id = raster[j * rcols + i];
      // The raster samples cell centers, so an area thinner than a cell (a 5 m lot on a diagonal)
      // can be missed: test the areas of this cell and its neighbours against their outlines,
      // highest priority first, and keep the raster's answer only when none contains the point.
      let best: Area | null = null;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= rcols || jj >= rrows) continue;
          const c = raster[jj * rcols + ii];
          if (c < 0 || c === best?.id) continue;
          const a: Area = areas[c];
          const pa = AREA_PRIORITY[a.kind];
          const pb = best ? AREA_PRIORITY[best.kind] : -1;
          if (best && (pa < pb || (pa === pb && a.id < best.id))) continue;
          if (pointInPolygon(x, z, a.polygon)) best = a;
        }
      }
      return best ?? (id >= 0 ? areas[id] : null);
    },
    surfaceAt(x, z) {
      if (!surfaces) return null;
      surfaces.at(x, z, hits);
      let best: SurfacePatch | null = null;
      for (const h of hits) if (!best || h.priority > best.priority) best = h;
      return best;
    },
    finalize() {
      const pad = 220;
      rx0 = g.bounds.minX - pad;
      rz0 = g.bounds.minZ - pad;
      rcols = Math.ceil((g.bounds.maxX + pad - rx0) / RASTER_CELL);
      rrows = Math.ceil((g.bounds.maxZ + pad - rz0) / RASTER_CELL);
      raster = new Int16Array(rcols * rrows).fill(-1);
      const order = areas.filter((a) => a.polygon.length >= 3).sort((a, b) => AREA_PRIORITY[a.kind] - AREA_PRIORITY[b.kind] || a.id - b.id);
      const crossings: number[] = [];
      for (const a of order) {
        const bb = polygonBounds(a.polygon);
        const i0 = Math.max(0, Math.floor((bb.minX - rx0) / RASTER_CELL));
        const i1 = Math.min(rcols - 1, Math.floor((bb.maxX - rx0) / RASTER_CELL));
        const j0 = Math.max(0, Math.floor((bb.minZ - rz0) / RASTER_CELL));
        const j1 = Math.min(rrows - 1, Math.floor((bb.maxZ - rz0) / RASTER_CELL));
        // pointInPolygon's even-odd test, a row at a time: the edges that straddle the row's z give the same
        // crossing x as the test computes, sorted once; a cell is inside when an odd number are right of its center.
        const poly = a.polygon;
        for (let j = j0; j <= j1; j++) {
          const z = rz0 + (j + 0.5) * RASTER_CELL;
          crossings.length = 0;
          for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
            const p = poly[k];
            const q = poly[m];
            if (p.z > z !== q.z > z) crossings.push(((q.x - p.x) * (z - p.z)) / (q.z - p.z) + p.x);
          }
          crossings.sort((u, v) => u - v);
          let next = 0;
          for (let i = i0; i <= i1; i++) {
            const x = rx0 + (i + 0.5) * RASTER_CELL;
            while (next < crossings.length && !(x < crossings[next])) next++;
            if ((crossings.length - next) & 1) raster[j * rcols + i] = a.id;
          }
        }
      }
      surfaces = new PolygonIndex<SurfacePatch>(rx0, rz0, rx0 + rcols * RASTER_CELL, rz0 + rrows * RASTER_CELL);
      for (const b of builds) for (const s of b.surfaces) surfaces.add(s);
    },
  };
}

export { emptyBuild };
export type { Area, AreaBuild, AreaKind } from './types';
