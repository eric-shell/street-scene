/**
 * District framework: the common vocabulary every area module speaks.
 *
 * Roughly half the city is plain downtown blocks; the rest is special areas
 * (hills, parks, a river, an elevated subway, alleys, roundabouts, a monument
 * plaza, ...). Each kind lives in its own module (src/city/districts/<kind>.ts) implementing
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
 * least ~4 m apart (use a solid body between them). Where two drivable levels
 * stack (a bridge deck over the river channel) the walls of one level carry a
 * `top` or `bottom` height so cars on the other pass them (see DeckSpan).
 */
import type { Vec2 } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import type { RoadGraph } from '../roadGraph';
import type { BlockFace, Building, EdgeMouths, Sector, Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { DistrictPropSpec } from '../props';
import type { EventFlavourId } from '../events';

export type AreaKind =
  | 'downtown'
  | 'alley'
  | 'backAlley'
  | 'park'
  | 'subway'
  | 'river'
  | 'roundabout'
  | 'infill'
  | 'hills'
  | 'monument'
  | 'tunnel'
  | 'overpass'
  | 'market'
  | 'roadworks'
  | 'bluff'
  | 'carPark'
  // Reserved unique features (planned later, disabled in config).
  | 'waterfront'
  | 'lake';

/**
 * Ground surface under a point. 'road' / 'sidewalk' / 'offroad' are the
 * original three; districts add concrete (plazas, channel floor), grass
 * (parks, planter islands), water (the trickle in the river channel) and
 * cobble (the road strip of every alley, see districts/alley.ts).
 */
export type Surface = 'road' | 'sidewalk' | 'offroad' | 'concrete' | 'grass' | 'water' | 'cobble';

/** Which tuning entry (drivingParams.json `surface`) a surface drives with. */
export type SurfacePhysics = 'road' | 'sidewalk' | 'offroad' | 'cobble';
export const SURFACE_PHYSICS: Record<Surface, SurfacePhysics> = {
  road: 'road',
  sidewalk: 'sidewalk',
  offroad: 'offroad',
  concrete: 'sidewalk',
  grass: 'offroad',
  water: 'offroad',
  cobble: 'cobble',
};

/** Surface patch priority of an alley's cobbled road strip: above the plain street classification (road 5). */
export const COBBLE_PRIORITY = 6;

/**
 * What draws a wall (the renderer that owns the look):
 * building: a building facade right behind the sidewalk line (cityMeshes).
 * boundary: low concrete wall closing a gap in the street frontage (render/districts/infill).
 * lotEdge: low curb wall around a parking lot or plaza (infill).
 * planter / fountain: raised planter box, fountain basin (infill).
 * island: a roundabout island's solid pieces, the plaza's dry basin and a sculpture plinth (roundabout).
 * pillar: elevated railway support (subway).
 * parapet / culvert / fence / trench / channelEnd: bridge deck sides (a car in the channel below
 *   passes under them: Wall.bottom), a bridge's abutments on the banks under its deck (solids with
 *   Wall.top), bank top fence, ramp retaining walls, channel tunnel ends (river).
 * tree: a tree trunk (park, roundabout).
 * monument: the step ring around a landmark's base, or an arch's piers (monument).
 * tunnel / rock: tunnel walls, portal wingwalls and the shut in building line behind them;
 *   the rock face along a ridge's cutting (tunnel).
 * pier: overpass piers and abutments, sign gantry legs (overpass); a river bridge's piers standing on
 *   the channel floor under its deck (solids with Wall.top, river).
 * marketRail: the night market's crowd rail along a pen and its end caps back to the building line;
 *   marketFront: the frontage behind a pen, a facade or the market's shuttered back wall (market).
 * gate: a timed gate's arms across a street (sim/gates.ts; a level crossing's are drawn by render/districts/bluff.ts).
 *   Timed gates are not in World.walls: they block only while their schedule says so.
 * roadworks: the plant of a lane closure (arrow board, excavator, skip, light tower) (roadworks).
 * bluff: retaining wall where a street ramps or dips through the escarpment (bluff).
 * railFence: the El's fence across its right of way where it meets a street at grade (bluff).
 * carPark: a multi-storey car park's parapets, facades, chute and ramp walls, and the low face under its lip (carPark).
 * alleyLip: the face under a route shortcut's jump exit lip, toward the street (Wall.top: the launching car passes over it) (alley).
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
  | 'tree'
  | 'monument'
  | 'tunnel'
  | 'rock'
  | 'pier'
  | 'marketRail'
  | 'marketFront'
  | 'gate'
  | 'roadworks'
  | 'bluff'
  | 'railFence'
  | 'carPark'
  | 'alleyLip';

export const WALL_LOOKS: readonly WallLook[] = ['building', 'boundary', 'lotEdge', 'planter', 'fountain', 'island', 'pillar', 'parapet', 'culvert', 'fence', 'trench', 'channelEnd', 'tree', 'monument', 'tunnel', 'rock', 'pier', 'marketRail', 'marketFront', 'gate', 'roadworks', 'bluff', 'railFence', 'carPark', 'alleyLip'];

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

/**
 * A bridge deck over a sunken district (the river channel): two drivable
 * levels inside `polygon`. The terrain is the deck; `lower` adds the ground
 * beneath it (its height below the deck, 0 or negative, with the gradient),
 * which World.heightAt returns for a car body nearer to it than to the deck.
 */
export interface DeckSpan {
  polygon: Vec2[];
  area: number;
  /** The drop from the deck to the lower level's floor (m): a body less than half of it below the deck is on the deck. */
  depth: number;
  /**
   * Add the lower level's height relative to the terrain (m, <= 0) and its gradient at (x, z) into
   * `out`; returns the deck's height above the terrain there (0 on the deck proper, up to the drop
   * at the footprint's edge, where the terrain eases down to the lower level under the deck's edge).
   */
  lower(x: number, z: number, out: HeightSample): number;
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
  /** Two level spans (bridge decks over the river channel), read by World's height queries. */
  decks: DeckSpan[];
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
  return { walls: [], props: [], surfaces: [], heightMods: [], decks: [], exclusions: [], openings: [], frontLooks: [], reserved: [], hints: [], destructibles: [] };
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

/**
 * The seed's event flavour (src/city/events.ts) and both routes, as the
 * topology hook picked them: modules planned after the routes (hills, the
 * monument) read it to put their feature where the race goes.
 */
export interface PlannedEvent {
  flavour: EventFlavourId;
  /** Circuit then sprint: graph nodes in driving order and the edges between them. */
  routes: { nodes: number[]; edges: number[]; closed: boolean }[];
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
  /** Present for the modules planned after the topology hook, when it returned one. */
  event?: PlannedEvent;
  /** Polygons route shortcuts must not cut through (car park sites held while the alleys are carved, see world.ts). */
  keepOut?: Vec2[][];
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

/** Minimap look per kind (ui/hud/hud.ts). Colors are CSS strings, widths in meters. */
export interface AreaMapStyle {
  fill?: string;
  stroke?: string;
  width?: number;
  dash?: number[];
}

export const AREA_MAP_STYLE: Record<AreaKind, AreaMapStyle> = {
  // Monokai Pro tints (ui/kit/palette.ts) that stay clear of the orange route and yellow roadblocks.
  downtown: {},
  alley: { stroke: 'rgba(171,157,242,0.35)', width: 5 },
  backAlley: { stroke: 'rgba(147,146,147,0.12)', width: 4 },
  park: { fill: 'rgba(169,220,118,0.2)' },
  subway: { stroke: 'rgba(120,220,232,0.45)', width: 4, dash: [14, 10] },
  river: { fill: 'rgba(120,220,232,0.16)' },
  roundabout: { stroke: 'rgba(147,146,147,0.4)', width: 4 },
  infill: { fill: 'rgba(147,146,147,0.08)' },
  hills: { fill: 'rgba(147,146,147,0.07)', stroke: 'rgba(147,146,147,0.34)', width: 2.5, dash: [6, 7] },
  monument: { fill: 'rgba(255,216,102,0.2)' },
  tunnel: { fill: 'rgba(147,146,147,0.16)', stroke: 'rgba(25,24,26,0.8)', width: 6, dash: [7, 4] },
  overpass: { fill: 'rgba(193,192,192,0.22)', stroke: 'rgba(193,192,192,0.5)', width: 5, dash: [3, 3] },
  market: { fill: 'rgba(255,97,136,0.3)' },
  // A lane closure: the closures' yellow (ui/hud/minimap.ts), not the market's pink.
  roadworks: { fill: 'rgba(255,216,102,0.55)' },
  // The escarpment: its face line, a solid edge (the minimap strokes area.path).
  bluff: { stroke: 'rgba(252,152,103,0.5)', width: 5 },
  carPark: { fill: 'rgba(147,146,147,0.22)', stroke: 'rgba(255,97,136,0.4)', width: 1.5 },
  waterfront: { fill: 'rgba(120,220,232,0.14)' },
  lake: { fill: 'rgba(120,220,232,0.18)' },
};
