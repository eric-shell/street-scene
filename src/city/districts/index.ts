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
 * Order matters and is fixed: the river first (it decides bridges), then the
 * subway (claims a street column), roundabouts, alleys, back alleys (the last
 * module allowed to change the graph topology, so face ids stay stable), parks
 * (claim faces), the monument plaza, hills (claim clusters of faces and keep
 * their slopes clear of everything placed before them), tunnels and
 * overpasses (they keep clear of every slope and claim the blocks a ridge
 * stands in, so they come after the hills and before downtown), reserved
 * features, and downtown (claims every face left). The optional topology hook runs
 * right after back alleys (route shortcuts).
 */
import { CITY } from '../config';
import type { RoadGraph } from '../roadGraph';
import { sortNodeEdges } from '../roadGraph';
import { BlockFace, CityBlocks, Sector, computeFaces, computeMouths, computeSectors } from '../blocks';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Vec2 } from '../../sim/math';
import { PolygonIndex, pointInPolygon, polygonBounds } from './geom';
import type { Area, AreaBuild, AreaKind, BuildContext, Claims, DistrictModule, HeightMod, LateContext, PlanContext, Surface, SurfacePatch } from './types';
import { emptyBuild } from './types';
import { riverModule } from './river';
import { subwayModule } from './subway';
import { roundaboutModule } from './roundabout';
import { alleyModule, backAlleyModule } from './alley';
import { parkModule } from './park';
import { monumentModule } from './monument';
import { hillsModule } from './hills';
import { tunnelModule } from './tunnel';
import { overpassModule } from './overpass';
import { waterfrontModule } from './waterfront';
import { lakeModule } from './lake';
import { downtownModule } from './downtown';
import { infillModule } from './infill';

/** Every module, in planning order. */
export const DISTRICT_MODULES: readonly DistrictModule[] = [
  riverModule,
  subwayModule,
  roundaboutModule,
  alleyModule,
  backAlleyModule,
  parkModule,
  monumentModule,
  hillsModule,
  tunnelModule,
  overpassModule,
  waterfrontModule,
  lakeModule,
  downtownModule,
  infillModule,
];

export function districtModule(kind: AreaKind): DistrictModule {
  const m = DISTRICT_MODULES.find((d) => d.kind === kind);
  if (!m) throw new Error(`no district module for ${kind}`);
  return m;
}

/** areaAt priority: more specific kinds win where footprints overlap. */
const AREA_PRIORITY: Record<AreaKind, number> = {
  downtown: 1,
  hills: 2,
  park: 3,
  subway: 4,
  alley: 5,
  backAlley: 6,
  river: 7,
  roundabout: 8,
  infill: 9,
  monument: 10,
  tunnel: 11,
  overpass: 4,
  waterfront: 2,
  lake: 2,
};

const RASTER_CELL = 4;

export interface CityDistricts {
  areas: Area[];
  /** builds[i] belongs to areas[i]. */
  builds: AreaBuild[];
  /** All height modifiers of graph phase areas. */
  heightMods: HeightMod[];
  /** For generateBlocks: graph phase builds and the late module runner. */
  blocksInput: { builds: AreaBuild[]; late: (ctx: LateContext) => AreaBuild[] };
  /** Area at a point (rasterized, RASTER_CELL m), or null on plain streets / outside. Call finalize first. */
  areaAt(x: number, z: number): Area | null;
  /** Highest priority surface patch at a point, or null. */
  surfaceAt(x: number, z: number): SurfacePatch | null;
  /** Index surfaces and rasterize areas once blocks exist. */
  finalize(blocks: CityBlocks): void;
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
    graphChanged() {
      if (claims.face.size) throw new Error('graph edited after faces were claimed');
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

export interface PlanHooks {
  /**
   * Runs once the street topology is final (right after back alleys, before
   * any module claims faces), with a context of its own random stream that
   * may still edit the graph and add areas: world.ts picks both routes here
   * and carves their shortcuts.
   */
  topology?(ctx: PlanContext): void;
}

export function planDistricts(seed: number, g: RoadGraph, hooks: PlanHooks = {}): CityDistricts {
  const areas: Area[] = [];
  const claims: Claims = { node: new Map(), edge: new Map(), face: new Map() };
  const blockArea = computeFaces(g, computeSectors(g)).reduce((s, f) => s + (f.outer ? 0 : f.area), 0);
  const budget = { total: blockArea * CITY.districts.maxSpecialFraction, used: 0 };
  let lastCtx: PlanContext | null = null;
  for (const m of DISTRICT_MODULES) {
    if (m.phase !== 'graph') continue;
    const ctx = makeContext(seed, g, areas, claims, budget, m.kind);
    m.plan(ctx);
    lastCtx = ctx;
    if (m === backAlleyModule && hooks.topology) {
      const hctx = makeContext(seed, g, areas, claims, budget, 'backAlley', 'routeShortcuts');
      hooks.topology(hctx);
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
    blocksInput: { builds: graphBuilds, late },
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
    finalize(blocks) {
      const pad = 220;
      rx0 = g.bounds.minX - pad;
      rz0 = g.bounds.minZ - pad;
      rcols = Math.ceil((g.bounds.maxX + pad - rx0) / RASTER_CELL);
      rrows = Math.ceil((g.bounds.maxZ + pad - rz0) / RASTER_CELL);
      raster = new Int16Array(rcols * rrows).fill(-1);
      const order = areas.filter((a) => a.polygon.length >= 3).sort((a, b) => AREA_PRIORITY[a.kind] - AREA_PRIORITY[b.kind] || a.id - b.id);
      for (const a of order) {
        const bb = polygonBounds(a.polygon);
        const i0 = Math.max(0, Math.floor((bb.minX - rx0) / RASTER_CELL));
        const i1 = Math.min(rcols - 1, Math.floor((bb.maxX - rx0) / RASTER_CELL));
        const j0 = Math.max(0, Math.floor((bb.minZ - rz0) / RASTER_CELL));
        const j1 = Math.min(rrows - 1, Math.floor((bb.maxZ - rz0) / RASTER_CELL));
        for (let j = j0; j <= j1; j++) {
          const z = rz0 + (j + 0.5) * RASTER_CELL;
          for (let i = i0; i <= i1; i++) {
            if (pointInPolygon(rx0 + (i + 0.5) * RASTER_CELL, z, a.polygon)) raster[j * rcols + i] = a.id;
          }
        }
      }
      surfaces = new PolygonIndex<SurfacePatch>(rx0, rz0, rx0 + rcols * RASTER_CELL, rz0 + rrows * RASTER_CELL);
      for (const b of builds) for (const s of b.surfaces) surfaces.add(s);
      void blocks;
    },
  };
}

/** Convenience for tests and tools: the surface a patch list gives at a point. */
export function patchSurface(patches: SurfacePatch[], p: Vec2): Surface | null {
  let best: SurfacePatch | null = null;
  for (const s of patches) if (pointInPolygon(p.x, p.z, s.polygon) && (!best || s.priority > best.priority)) best = s;
  return best ? best.surface : null;
}

export { emptyBuild };
export type { Area, AreaBuild, AreaKind } from './types';
