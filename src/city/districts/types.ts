/**
 * District framework: the common vocabulary every area module speaks.
 *
 * About 80% of the city is plain downtown blocks; the rest is made of special
 * areas (alleys, parks, a river, an elevated subway, roundabouts, ...). Each
 * kind lives in its own module (src/city/districts/<kind>.ts) implementing
 * DistrictModule, with a matching renderer in src/render/districts/<kind>.ts.
 *
 * Lifecycle (all pure and deterministic, see index.ts):
 *  1. plan, phase 'graph': right after the road graph, modules claim nodes,
 *     edges and block faces (and may edit the graph: widths, new edges,
 *     roundabout rings, bridge flags). Order is fixed by the registry.
 *  2. build, phase 'graph': each area returns an AreaBuild. Height modifiers
 *     are folded into the terrain; exclusions keep buildings out; openings
 *     remove city (frontage) walls; walls, surfaces and props are added.
 *  3. plan + build, phase 'late': after buildings are placed, modules that
 *     fill leftover space (infill) see the void runs along every block ring.
 *
 * Collision rule: every wall must match something the renderer draws. Walls
 * carry a `look` naming what draws them, and every look has a renderer.
 * Walls are one sided (normal toward the drivable side) and push back a car
 * up to 3 m behind them, so two drivable spaces separated by a wall must be at
 * least ~4 m apart (use a solid body between them, see river.ts bridgeBody).
 */
import type { Vec2 } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import type { RoadGraph } from '../roadGraph';
import type { BlockFace, Building, EdgeMouths, Sector, Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { DistrictPropSpec } from '../props';

export type AreaKind =
  | 'downtown'
  | 'alley'
  | 'backAlley'
  | 'park'
  | 'subway'
  | 'river'
  | 'roundabout'
  | 'infill'
  // Reserved unique features (planned later, disabled in config).
  | 'monument'
  | 'waterfront'
  | 'lake';

/**
 * Ground surface under a point. 'road' / 'sidewalk' / 'offroad' are the
 * original three; districts add concrete (plazas, channel floor), grass
 * (parks, planter islands) and water (the trickle in the river channel).
 */
export type Surface = 'road' | 'sidewalk' | 'offroad' | 'concrete' | 'grass' | 'water';

/** Which tuning entry (drivingParams.json `surface`) a surface drives with. */
export type SurfacePhysics = 'road' | 'sidewalk' | 'offroad';
export const SURFACE_PHYSICS: Record<Surface, SurfacePhysics> = {
  road: 'road',
  sidewalk: 'sidewalk',
  offroad: 'offroad',
  concrete: 'sidewalk',
  grass: 'offroad',
  water: 'offroad',
};

/**
 * What draws a wall (the renderer that owns the look):
 * building: a building facade right behind the sidewalk line (cityMeshes).
 * boundary: low concrete wall closing a gap in the street frontage (render/districts/infill).
 * lotEdge: low curb wall around a parking lot or plaza (infill).
 * planter / fountain: raised planter box, fountain basin (infill, roundabout).
 * island: solid roundabout island (roundabout).
 * pillar: elevated railway support (subway).
 * parapet / culvert / fence / trench / channelEnd: bridge sides, bridge body seen from the
 *   channel, bank top fence, ramp retaining walls, channel tunnel ends (river).
 * tree: park tree trunk (park).
 */
export type WallLook =
  | 'building'
  | 'boundary'
  | 'lotEdge'
  | 'planter'
  | 'fountain'
  | 'island'
  | 'pillar'
  | 'parapet'
  | 'culvert'
  | 'fence'
  | 'trench'
  | 'channelEnd'
  | 'tree';

export const WALL_LOOKS: readonly WallLook[] = ['building', 'boundary', 'lotEdge', 'planter', 'fountain', 'island', 'pillar', 'parapet', 'culvert', 'fence', 'trench', 'channelEnd', 'tree'];

export interface Area {
  /** Index into CityDistricts.areas. */
  id: number;
  kind: AreaKind;
  /** Module specific variant ('lot', 'plaza', 'fountain', 'planter', 'raceway', ...). */
  variant: string;
  /** Footprint polygon in XZ (any orientation), [] for areas without one. */
  polygon: Vec2[];
  /** Centerline for linear areas (river, subway), [] otherwise. */
  path: Vec2[];
  /** Claimed road graph nodes, edges and block faces (CityBlocks.faces ids). */
  nodes: number[];
  edges: number[];
  faces: number[];
  /** Numeric parameters chosen at plan time (radii, widths, heights, flags as 0/1). */
  params: Record<string, number>;
}

/** Static decoration placed by an area (render only; solid ones also add walls). */
export interface AreaProp {
  kind: string;
  x: number;
  z: number;
  yaw: number;
  /** Footprint radius or half size (m). */
  size: number;
  /** Height or other scale (m). */
  height: number;
  area: number;
}

/** A ground surface polygon. Higher priority wins; plain road is 5, sidewalk 3, offroad 0. */
export interface SurfacePatch {
  surface: Surface;
  polygon: Vec2[];
  priority: number;
  area: number;
}

export interface HeightSample {
  h: number;
  gx: number;
  gz: number;
}

/**
 * Additive terrain modifier with an exact analytic gradient. Only consulted
 * inside its bounding box, and it must fade to 0 at the box edges.
 */
export interface HeightMod {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Add this modifier's height and gradient at (x, z) into `out`. */
  add(x: number, z: number, out: HeightSample): void;
}

/** City frontage walls whose inside probe falls in `polygon` are drawn by this look instead. */
export interface FrontLook {
  polygon: Vec2[];
  look: WallLook;
  area: number;
}

export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** Free form render data for an area's renderer (decks, bays, bridge outlines...). */
export interface AreaHint {
  kind: string;
  points: Vec2[];
  values: number[];
}

/** What one area contributes to the city. Every list may be empty. */
export interface AreaBuild {
  /** Extra collision walls (kind 'wall'), each with a look and `area` set. */
  walls: Wall[];
  props: AreaProp[];
  surfaces: SurfacePatch[];
  /** Folded into the terrain (graph phase only). */
  heightMods: HeightMod[];
  /** No buildings or infill inside these polygons (graph phase only). */
  exclusions: Vec2[][];
  /** City frontage walls whose inside probe falls in these polygons are removed. */
  openings: Vec2[][];
  frontLooks: FrontLook[];
  /** Street furniture keeps clear of these circles (graph phase only). */
  reserved: Circle[];
  hints: AreaHint[];
  /** Destructible clutter (bushes, tables, crates...): becomes CityBlocks.props after the street furniture. */
  destructibles: DistrictPropSpec[];
}

export function emptyBuild(): AreaBuild {
  return { walls: [], props: [], surfaces: [], heightMods: [], exclusions: [], openings: [], frontLooks: [], reserved: [], hints: [], destructibles: [] };
}

/**
 * A run of city frontage (outer sidewalk line, seen from the road) with no
 * building behind it, in ring order around one block face. The block lies on
 * the right of the direction of travel along `points`.
 */
export interface FrontageRun {
  face: number;
  points: Vec2[];
  /** Road edge each segment runs along (-1 for rounded corner pieces). */
  edges: number[];
  /** Convex block corners strictly inside the run: point index, interior angle (rad), graph node. */
  corners: { index: number; angle: number; node: number }[];
  length: number;
}

/** Extra context for 'late' modules, after buildings are placed. */
export interface LateContext {
  terrain: Terrain;
  buildings: Building[];
  voids: FrontageRun[];
  /** Inside a building footprint grown by margin. */
  insideBuilding(x: number, z: number, margin: number): boolean;
  /** Inside an exclusion polygon of a graph phase area. */
  excluded(x: number, z: number): boolean;
  /** Signed distance to the nearest road corridor (road + sidewalk), negative inside. */
  clearance(x: number, z: number): number;
}

export interface Claims {
  node: Map<number, number>;
  edge: Map<number, number>;
  face: Map<number, number>;
}

export interface PlanContext {
  seed: number;
  /** This module's own random stream (deriveSeed(seed, 'district:' + kind)). */
  rng: Rng;
  graph: RoadGraph;
  /** Areas planned so far, by id. */
  areas: Area[];
  claims: Claims;
  /** Block faces of the current graph (recomputed after graphChanged()). */
  faces(): BlockFace[];
  sectors(): Sector[][];
  /** Special area budget in m^2: plan only while used + footprint <= total. */
  budget: { total: number; used: number };
  /** Register an area: assigns its id and records its node/edge/face claims. */
  addArea(a: Omit<Area, 'id'>, footprint?: number): Area;
  /** Call after editing the graph (sorts node edges, invalidates faces and sectors). */
  graphChanged(): void;
  /** Present for 'late' modules only. */
  late?: LateContext;
}

export interface BuildContext {
  seed: number;
  graph: RoadGraph;
  areas: Area[];
  faces: BlockFace[];
  sectors: Sector[][];
  mouths: EdgeMouths[];
  /** Present for 'late' modules only. */
  late?: LateContext;
}

export interface DistrictModule {
  kind: AreaKind;
  phase: 'graph' | 'late';
  /** Claim space and create areas (through ctx.addArea). Must be deterministic. */
  plan(ctx: PlanContext): void;
  /** Build one of this module's areas. */
  build(ctx: BuildContext, area: Area): AreaBuild;
}

/** Minimap look per kind (ui/hud.ts). Colors are CSS strings, widths in meters. */
export interface AreaMapStyle {
  fill?: string;
  stroke?: string;
  width?: number;
  dash?: number[];
}

export const AREA_MAP_STYLE: Record<AreaKind, AreaMapStyle> = {
  // Monokai Pro tints (ui/palette.ts) that stay clear of the orange route and yellow roadblocks.
  downtown: {},
  alley: { stroke: 'rgba(171,157,242,0.35)', width: 5 },
  backAlley: { stroke: 'rgba(147,146,147,0.12)', width: 4 },
  park: { fill: 'rgba(169,220,118,0.2)' },
  subway: { stroke: 'rgba(120,220,232,0.45)', width: 4, dash: [14, 10] },
  river: { fill: 'rgba(120,220,232,0.16)' },
  roundabout: { stroke: 'rgba(147,146,147,0.4)', width: 4 },
  infill: { fill: 'rgba(147,146,147,0.08)' },
  monument: { fill: 'rgba(255,216,102,0.2)' },
  waterfront: { fill: 'rgba(120,220,232,0.14)' },
  lake: { fill: 'rgba(120,220,232,0.18)' },
};
