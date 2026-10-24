/**
 * The world the simulation queries: terrain height, surface type, static
 * collision and progress along the active route. Built once per race from
 * (seed, route kind) and never mutated afterwards.
 */
import { CITY, ROUTE } from './config';
import { CityBlocks, Solid, Wall, generateBlocks } from './blocks';
import { RoadGraph, generateRoadGraph, isRiverEdge } from './roadGraph';
import { PlannedRouteKind, Route, RouteKind, buildRoute } from './route';
import { BarrierGroup, routeBarrierGroups } from './routeBarriers';
import { RailWall, routeRails } from './routeRails';
import { findCircuitNodes, findDragNodes, findSprintNodes, findWaypointNodes } from './routeSearch';
import { Prop, buildPropGrid } from './props';
import { SpatialGrid } from './spatial';
import { Terrain, createTerrain } from './terrain';
import { Vec2, cos, distToSegment, segmentT, sin, sqrt } from '../sim/math';
import { settleRiver } from './districts/river';
import { CityDistricts, districtModule, planDistricts } from './districts';
import { settleAlleyLips, shortcutJumpRails } from './districts/alleyDressing';
import { carveRouteShortcuts, hasShortcutSpot, qualifiedCount } from './districts/alleyShortcuts';
import { ROUTE_INDEX, carParkGates, carParkRails, carParkSites, planCarParks, settleCarParks } from './districts/carPark';
import { bayRoadDistance, baysByEdge } from './busBays';
import { CityEvent, EventFlavourId, eventOffer, eventRoutePreference, pickEventFlavour, resolveEvent, routeEdges } from './events';
import type { GateSet } from '../sim/gates';
import { LevelCrossing, addLevelCrossings } from './levelCrossings';
import { highwayGates, settleHighway, settleHighwayWalls } from './districts/highway/settle';

/** Routes tried (the first pick, then alternatives) until one has room for a shortcut. */
const ROUTE_TRIES = 12;
import { pointInPolygon, polygonBounds } from './districts/geom';
import { ROADWORKS } from './districts/roadworks';
import { Area, DeckSpan, HeightSample, Surface } from './districts/types';

export type { Surface, SurfacePhysics } from './districts/types';

export interface Contact {
  /** Push direction (unit) out of the wall into drivable space. */
  nx: number;
  nz: number;
  depth: number;
  /** Contact point on the wall. */
  px: number;
  pz: number;
  kind: Wall['kind'];
}

export interface RouteProgress {
  /** Distance along the route polyline. */
  s: number;
  /** Signed offset from the centerline, positive = left of travel direction. */
  lateral: number;
  seg: number;
  /** Unit tangent of the segment. */
  tx: number;
  tz: number;
}

export interface City {
  seed: number;
  graph: RoadGraph;
  terrain: Terrain;
  blocks: CityBlocks;
  /** District areas (downtown blocks, parks, river, ...) and their builds. */
  districts: CityDistricts;
  /**
   * Both routes' graph nodes in driving order, picked while the city is
   * planned (see planRoads) so their shortcuts could be carved into it.
   */
  routeNodes: Record<PlannedRouteKind, number[]>;
  /** The seed's named event (Hill Climb, River Run, ...; see events.ts), which the routes were picked to match. */
  event: CityEvent;
}

/**
 * The street network as the game drives it: the road graph, every district
 * planned, and both routes picked as soon as the street topology is final.
 * Each route then gets its guaranteed shortcuts carved into the graph
 * (carveRouteShortcuts), which splits some of its edges; the stored node
 * lists include those split nodes, so routes stay on the same streets.
 * Cheap (no blocks): tests use it to sweep many seeds. `forceFlavour`
 * overrides the seed's drawn event flavour (tests and tools comparing them).
 */
export function planRoads(seed: number, forceFlavour?: EventFlavourId): { graph: RoadGraph; districts: CityDistricts; routeNodes: Record<PlannedRouteKind, number[]>; event: CityEvent } {
  const graph = generateRoadGraph(seed);
  let routeNodes: Record<PlannedRouteKind, number[]> | null = null;
  let flavour: EventFlavourId = 'downtownDash';
  // Districts claim space and edit the graph (alleys, shortcuts, roundabouts, bridges) first.
  const districts = planDistricts(seed, graph, {
    topology(ctx) {
      // A route with no room for a shortcut (one wrapped around the river, say) is swapped for the
      // next alternative that has one: alternatives that still match the event (and dive into the
      // channel) first, then routes picked without the preference, since on the rare seed that cannot
      // have both a shortcut on every route outranks the flavour; after ROUTE_TRIES each way the first
      // pick stands.
      const pick = (find: (variant: number, prefer: boolean) => number[], closed: boolean, others: { nodes: number[]; closed: boolean }[]) => {
        const first = { nodes: find(0, true), closed };
        if (hasShortcutSpot(ctx, first, others)) return first;
        for (const prefer of [true, false]) {
          for (let v = 1; v < ROUTE_TRIES; v++) {
            const alt = { nodes: find(v, prefer), closed };
            if (hasShortcutSpot(ctx, alt, others)) return alt;
          }
        }
        return first;
      };
      // The seed's event flavour, drawn from what this city can deliver, says what the routes should
      // have (events.ts); every flavour but River Run also keeps the river dive as a second wish.
      const g = ctx.graph;
      flavour = forceFlavour ?? pickEventFlavour(seed, eventOffer(g, ctx.areas));
      const preferCircuit = eventRoutePreference(flavour, ctx, true);
      const preferSprint = eventRoutePreference(flavour, ctx, false);
      // The circuit is checked against the first sprint pick (whose start and finish it must keep clear).
      const firstSprint = { nodes: findSprintNodes(g, seed, 0, preferSprint), closed: false };
      const circuit = pick((v, p) => findCircuitNodes(g, seed, v, p ? preferCircuit : undefined), true, [firstSprint]);
      const sprint = pick((v, p) => (v ? findSprintNodes(g, seed, v, p ? preferSprint : undefined) : firstSprint.nodes), false, [circuit]);
      // Car park sites are held while the alleys are carved (a corner cut would take their block), each
      // only while both routes keep a spot for an alley of their own.
      const keep: Vec2[][] = [];
      for (const site of carParkSites(ctx, [circuit, sprint])) {
        ctx.keepOut = keep.concat(site);
        if (hasShortcutSpot(ctx, circuit, [sprint]) && hasShortcutSpot(ctx, sprint, [circuit])) keep.push(...site);
      }
      ctx.keepOut = keep;
      carveRouteShortcuts(ctx, [circuit, sprint]);
      ctx.keepOut = undefined;
      // A route left without a cut (the other route's cuts took its only spot) is re-picked on the
      // carved graph and carved again, the other route kept clear as before.
      let sprint2 = sprint;
      let circuit2 = circuit;
      if (!qualifiedCount(g, sprint2)) {
        sprint2 = pick((v, p) => findSprintNodes(g, seed, v, p ? preferSprint : undefined), false, [circuit2]);
        carveRouteShortcuts(ctx, [circuit2, sprint2]);
      }
      if (!qualifiedCount(g, circuit2)) {
        circuit2 = pick((v, p) => findCircuitNodes(g, seed, v, p ? preferCircuit : undefined), true, [sprint2]);
        carveRouteShortcuts(ctx, [circuit2, sprint2]);
      }
      // Car park shortcuts once the routes are final: they claim their streets here, their block once the
      // night market has narrowed its streets (carParkModule, a graph edit claimed faces would forbid).
      planCarParks(ctx, [circuit2, sprint2]);
      routeNodes = { circuit: circuit2.nodes, sprint: sprint2.nodes };
      // Hills, the monument and the roadworks are planned after this: they read the routes to come to the race.
      return { flavour, routes: [circuit2, sprint2].map((r) => ({ nodes: r.nodes, edges: routeEdges(g, r.nodes, r.closed), closed: r.closed })) };
    },
  });
  if (!routeNodes) throw new Error('routes were not planned');
  const nodes: Record<PlannedRouteKind, number[]> = routeNodes;
  const event = resolveEvent(seed, flavour, graph, districts.areas, [
    { nodes: nodes.circuit, closed: true },
    { nodes: nodes.sprint, closed: false },
  ]);
  return { graph, districts, routeNodes: nodes, event };
}

export interface World extends City {
  route: Route;
  /** City walls plus this route's barriers and corner rails. */
  walls: Wall[];
  wallGrid: SpatialGrid;
  /** Closed side street barriers grouped per intersection (see routeBarriers.ts). Barrier walls carry `group`. */
  barrierGroups: BarrierGroup[];
  /**
   * Open world (free roam, and the waypoint race's city): no route barriers,
   * corner rails, parked cars or crowds; every street is drivable. The route
   * still exists for the grid (and the waypoint race's suggestion).
   */
  openWorld?: boolean;
  /** Destructible props (same array as blocks.props). Broken state lives on RaceState.brokenProps. */
  props: Prop[];
  /** Broadphase over props by id (each prop inserted with its radius). */
  propGrid: SpatialGrid;
  /**
   * Props this route's barriers or rails stand on. Props are generated per
   * city but barriers per route, so these start every race as removed
   * (RaceState.brokenProps = 2): no collision, not rendered, no debris.
   */
  coveredProps: number[];
  /**
   * Terrain height (m): the ground everything is draped on, road level.
   * Under a bridge deck over the river channel two drivable levels stack
   * (districts/types.ts DeckSpan): with `y`, the querying car body's height
   * (m), the channel floor is returned when the body is nearer to it than to
   * the deck (below their midpoint); without `y` the deck, as everywhere
   * else (render draping, traffic, props and every other caller). Over the
   * elevated highway it is the other way up: the terrain is the street, and
   * with `y` the deck (or an on-ramp) is returned for a body nearer to it.
   */
  heightAt(x: number, z: number, y?: number): number;
  /**
   * Height a wheel stands at (m): the terrain plus CITY.curbHeight on the
   * paving the city draws at curb height (sidewalks, roundabout rings,
   * plazas), eased across the curb so a car rolls up onto a sidewalk instead
   * of sinking into it. `y` as for heightAt (the channel floor has no curbs).
   */
  driveHeightAt(x: number, z: number, y?: number): number;
  slopeAt(x: number, z: number, y?: number): { gx: number; gz: number };
  /** Surface under a point; `y` as for heightAt (the river's floor and trickle below a deck, the street on it). */
  surfaceAt(x: number, z: number, y?: number): Surface;
  /**
   * True inside a bridge deck's footprint over the river channel, where two levels stack and the
   * terrain is the deck (resets keep off it). Not under the highway: there the terrain is the street,
   * where a reset to the road belongs.
   */
  twoLevels(x: number, z: number): boolean;
  /** True when a body at height y over (x, z) drives an upper level: the highway's deck or one of its ramps. */
  upperLevel(x: number, z: number, y: number): boolean;
  /** Walls touching a circle; `y` (the car body's height, m) lets it pass over low walls (Wall.top) and under high ones (Wall.bottom). */
  collideCircle(x: number, z: number, r: number, out: Contact[], y?: number): number;
  collideBox(cx: number, cz: number, yaw: number, halfLength: number, halfWidth: number, out: Contact[], y?: number): number;
  /** Distance to the nearest wall, capped at maxDist; `y` as for collideCircle. */
  wallClearance(x: number, z: number, maxDist: number, y?: number): number;
  routeProgress(x: number, z: number, hintSeg?: number): RouteProgress;
  /** Every district area (same array as districts.areas). */
  areas: Area[];
  /** Area at a point (4 m raster): the block, park, plaza, channel... or null on plain streets. */
  areaAt(x: number, z: number): Area | null;
  /** Timed gates and their schedules (sim/gates.ts): the level crossings'. Absent on hand-built test worlds. */
  timedGates?: GateSet;
  /** Level crossings over the El at grade (city/levelCrossings.ts); their gates are in timedGates. */
  levelCrossings?: LevelCrossing[];
}

export function createCity(seed: number): City {
  const { graph, districts, routeNodes, event } = planRoads(seed);
  const terrain = createTerrain(seed, districts.heightMods);
  // The river's level walls (parapets, piers, abutments) take their heights from the finished terrain,
  // and so do the highway's deck, its ramps and their walls.
  settleRiver(graph, districts.areas, districts.builds, terrain);
  settleHighway(districts.areas, districts.builds, terrain);
  const blocks = generateBlocks(seed, graph, terrain, districts.blocksInput);
  // Every wall under the highway's deck stops only cars beneath it.
  settleHighwayWalls(districts.areas, districts.builds, blocks.walls);
  settleCarParks(districts.areas, districts.builds, terrain);
  settleAlleyLips(districts.areas, districts.builds, terrain);
  districts.finalize();
  return { seed, graph, terrain, blocks, districts, routeNodes, event };
}

/** Rails are planned around node centers; roundabouts get none (their ring has its own outer walls). */
function awayFromRoundabouts<T extends Wall>(graph: RoadGraph, rails: T[]): T[] {
  const rings = graph.nodes.filter((n) => n.ring);
  if (!rings.length) return rails;
  const bad = new Set<number>();
  for (const w of rails) {
    for (const n of rings) {
      const r = n.ring!.outer + CITY.sidewalk + 25;
      if (distToSegment(n.x, n.z, w.ax, w.az, w.bx, w.bz) < r) bad.add(w.group ?? -1);
    }
  }
  return rails.filter((w) => !bad.has(w.group ?? -1));
}

/** Drivable infill (corner pockets, plazas, verges, lots, alley bays) whose frontage is open to the street. */
const POCKETS = new Set(['cornerPlaza', 'plaza', 'verge', 'lot', 'alleyBay']);

/**
 * A closure barrier ends at its street's building line. Where a drivable
 * pocket opens right there, carry the barrier on across the pocket to its
 * far side, so the pocket is no way around the closure (and nobody drives
 * through the parked cars behind it). Parks stay open: they are shortcuts.
 * A tie's end at a corner rail (routeBarriers.ts) already closes: it stays.
 */
function sealBarriers(city: City, groups: BarrierGroup[], rails: readonly RailWall[]): void {
  const pockets = city.districts.areas.filter((a) => a.kind === 'infill' && POCKETS.has(a.variant));
  /** The corner rail group a barrier end leans on (a tie's rail end), or -1. */
  const railAt = (x: number, z: number): number => rails.find((r) => distToSegment(x, z, r.ax, r.az, r.bx, r.bz) < ROUTE.barrierTieGap + 0.2)?.group ?? -1;
  /** The pocket a barrier end opens into, carrying on along the barrier (from its other end). */
  const pocketPast = (ex: number, ez: number, ox: number, oz: number) => {
    const len = sqrt((ex - ox) ** 2 + (ez - oz) ** 2) || 1;
    return pockets.find((a) => pointInPolygon(ex + ((ex - ox) / len) * 0.6, ez + ((ez - oz) / len) * 0.6, a.polygon));
  };
  // Two ties onto one corner rail whose free ends open into the same pocket enclose it with the
  // rail between them: neither carries on across it (they would stand as two rails side by side).
  const tiesInto = new Map<string, number>();
  for (const gr of groups) {
    for (const w of gr.walls) {
      for (const atA of [true, false]) {
        const rail = railAt(atA ? w.bx : w.ax, atA ? w.bz : w.az);
        const pocket = rail >= 0 && pocketPast(atA ? w.ax : w.bx, atA ? w.az : w.bz, atA ? w.bx : w.ax, atA ? w.bz : w.az);
        if (pocket) tiesInto.set(`${rail}:${pocket.id}`, (tiesInto.get(`${rail}:${pocket.id}`) ?? 0) + 1);
      }
    }
  }
  const sealed: Wall[] = [];
  for (const gr of groups) {
    for (const w of gr.walls) {
      for (const atA of [true, false]) {
        const ex = atA ? w.ax : w.bx;
        const ez = atA ? w.az : w.bz;
        const ox = atA ? w.bx : w.ax;
        const oz = atA ? w.bz : w.az;
        if (railAt(ex, ez) >= 0) continue;
        const len = sqrt((ex - ox) ** 2 + (ez - oz) ** 2) || 1;
        const dx = (ex - ox) / len;
        const dz = (ez - oz) / len;
        const pocket = pocketPast(ex, ez, ox, oz);
        if (!pocket) continue;
        const rail = railAt(ox, oz);
        if (rail >= 0 && (tiesInto.get(`${rail}:${pocket.id}`) ?? 0) > 1) continue;
        // Farthest crossing of the ray with the pocket outline: where it leaves the pocket.
        let reach = 0;
        const P = pocket.polygon;
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          const q = P[(i + 1) % P.length];
          const sx = q.x - p.x;
          const sz = q.z - p.z;
          const den = dx * sz - dz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((p.x - ex) * sz - (p.z - ez) * sx) / den;
          const u = ((p.x - ex) * dz - (p.z - ez) * dx) / den;
          if (t > 0 && u >= 0 && u <= 1) reach = Math.max(reach, t);
        }
        if (reach <= 0 || reach > 40) continue;
        // Or the first city wall on the way (a fountain basin, a boundary wall), whichever comes first.
        for (const c of city.blocks.walls) {
          if (Math.abs(c.ax - ex) > 45 || Math.abs(c.az - ez) > 45) continue;
          const sx = c.bx - c.ax;
          const sz = c.bz - c.az;
          const den = dx * sz - dz * sx;
          if (Math.abs(den) < 1e-9) continue;
          const t = ((c.ax - ex) * sz - (c.az - ez) * sx) / den;
          const u = ((c.ax - ex) * dz - (c.az - ez) * dx) / den;
          // Walls touching the closure's own end count too (reach 0: no seal rather than a crossing).
          if (t > -0.05 && t < reach && u >= 0 && u <= 1) reach = Math.max(0, t);
        }
        if (reach <= 0.1) continue;
        // Just short of the pocket's back curb (never through it); the hair left is far narrower than a car.
        const nx = ex + dx * (reach - 0.05);
        const nz = ez + dz * (reach - 0.05);
        if (atA) {
          w.ax = nx;
          w.az = nz;
        } else {
          w.bx = nx;
          w.bz = nz;
        }
        gr.length += reach - 0.05;
        sealed.push(w);
      }
    }
  }
  // Two closures around one pocket both reach into it: clip them where they cross, a V like merged mouths.
  for (let i = 0; i < sealed.length; i++) {
    for (let j = i + 1; j < sealed.length; j++) {
      const a = sealed[i];
      const b = sealed[j];
      const dax = a.bx - a.ax;
      const daz = a.bz - a.az;
      const dbx = b.bx - b.ax;
      const dbz = b.bz - b.az;
      const den = dax * dbz - daz * dbx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((b.ax - a.ax) * dbz - (b.az - a.az) * dbx) / den;
      const u = ((b.ax - a.ax) * daz - (b.az - a.az) * dax) / den;
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
      const x = a.ax + dax * t;
      const z = a.az + daz * t;
      if (t > 0.5) {
        a.bx = x;
        a.bz = z;
      } else {
        a.ax = x;
        a.az = z;
      }
      if (u > 0.5) {
        b.bx = x;
        b.bz = z;
      } else {
        b.ax = x;
        b.az = z;
      }
    }
  }
}

/**
 * Closures become cyan modular rail pieces like the corner rails (src/sim/rails.ts):
 * straight pieces of about ROUTE.railPieceLength along each closure segment, one
 * rail group per barrier group (V joined segments chain like a bent rail), group
 * and piece ids continuing after the corner rails'. The groups' walls become
 * these pieces.
 */
function closureRails(groups: BarrierGroup[], cornerRails: RailWall[]): RailWall[] {
  let rail = 0;
  let piece = 0;
  for (const w of cornerRails) {
    rail = Math.max(rail, w.group + 1);
    piece = Math.max(piece, w.piece + 1);
  }
  const out: RailWall[] = [];
  for (const g of groups) {
    const pieces: RailWall[] = [];
    for (const w of g.walls) {
      const len = sqrt((w.bx - w.ax) ** 2 + (w.bz - w.az) ** 2);
      if (len < 0.05) continue;
      const n = Math.max(1, Math.round(len / ROUTE.railPieceLength));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        pieces.push({
          ax: w.ax + (w.bx - w.ax) * t0,
          az: w.az + (w.bz - w.az) * t0,
          bx: k === n - 1 ? w.bx : w.ax + (w.bx - w.ax) * t1,
          bz: k === n - 1 ? w.bz : w.az + (w.bz - w.az) * t1,
          nx: w.nx,
          nz: w.nz,
          kind: 'rail',
          group: rail,
          piece: piece++,
        });
      }
    }
    g.walls = pieces;
    out.push(...pieces);
    rail++;
  }
  return out;
}

/**
 * Districts a drag strip keeps off: whatever stands in the street, narrows it or takes it off grade.
 * The El (columns on the sidewalk) and tunnels (full width bores) may stand over a strip; roadworks
 * may close a curb lane beside it (stripStreet).
 */
const OFF_STRIP = new Set<Area['kind']>(['market', 'river', 'roundabout', 'overpass', 'carPark', 'monument', 'bluff']);
/** Room a drag car needs from the centerline out to a roadworks closure's barriers (m): its lane plus half a car and a margin. */
const STRIP_CLEAR = ROUTE.dragLaneOffset + 1.5;

/**
 * Whether a street can be part of the drag strip: no district on its
 * carriageway, sampled every 8 m along it. A street bridge over the river
 * stands in the river's area and is fine.
 */
function stripStreet(city: City, edge: number): boolean {
  const g = city.graph;
  const e = g.edges[edge];
  const A = g.nodes[e.a];
  const B = g.nodes[e.b];
  const steps = Math.max(1, Math.ceil(e.length / 8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = city.districts.areaAt(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
    if (a && OFF_STRIP.has(a.kind) && !(e.bridge && a.kind === 'river')) return false;
  }
  // A lane closure is fine where its barriers stand clear of the drag lane on their side.
  return !city.districts.areas.some((a) => a.kind === 'roadworks' && a.params.edge === edge && e.width / 2 - a.params.close - ROADWORKS.barrierReach < STRIP_CLEAR);
}

/**
 * A route of the city: the planned circuit and sprint as planRoads picked
 * them, the drag strip and the waypoint race picked from the finished city
 * (nothing was carved for them, so they changed no city).
 */
export function createRoute(city: City, kind: RouteKind): Route {
  const g = city.graph;
  if (kind === 'drag') return buildRoute(g, kind, findDragNodes(g, city.seed, (e) => stripStreet(city, e)));
  // The districts' race passes (DistrictModule.passes: across the monument plaza, say): every route driving through one takes it.
  const passes = city.districts.areas.flatMap((a) => districtModule(a.kind).passes?.(g, a) ?? []);
  if (kind === 'waypoint') {
    // The suggestion takes a pass where it can: one driving through a pass's node that is no waypoint is preferred.
    const through = (nodes: number[], stops: number[]) => {
      const edges = routeEdges(g, nodes, false);
      return passes.some((p) => {
        const i = nodes.indexOf(p.node);
        if (i < 1 || i + 1 >= nodes.length || stops.includes(p.node)) return false;
        const any = p.edgeA < 0;
        return (edges[i] === p.edgeB && (any ? edges[i - 1] !== p.edgeB : edges[i - 1] === p.edgeA)) || (edges[i - 1] === p.edgeB && (any ? edges[i] !== p.edgeB : edges[i] === p.edgeA));
      });
    };
    const { nodes, waypoints } = findWaypointNodes(g, city.seed, passes.length ? through : undefined);
    return buildRoute(g, kind, nodes, waypoints, passes, city.seed);
  }
  return buildRoute(g, kind, city.routeNodes[kind], [], passes, city.seed);
}

export function createWorld(seed: number, kind: RouteKind, city: City = createCity(seed), opts: { openWorld?: boolean } = {}): World {
  const route = createRoute(city, kind);
  const { graph, blocks, terrain } = city;
  const openWorld = opts.openWorld === true;
  // Corner rails, minus the pieces the flights off the route's car park and jump exits would cross.
  const rails = openWorld ? [] : carParkRails(city.districts.areas, ROUTE_INDEX[kind], shortcutJumpRails(route, city.districts.areas, awayFromRoundabouts(graph, routeRails(graph, route, blocks))));
  const barrierGroups = openWorld ? [] : routeBarrierGroups(graph, blocks.mouths, route, rails, city.districts.areas.find((a) => a.kind === 'river')?.params, blocks.walls);
  sealBarriers(city, barrierGroups, rails);
  const closures = closureRails(barrierGroups, rails);
  // A car park that is the other route's shortcut has its ramp shuttered (open world: all open).
  // The highway's ramps are shut in a race (it is no part of any route), open in free roam.
  const gates = openWorld ? [] : carParkGates(city.districts.areas, ROUTE_INDEX[kind]).concat(highwayGates(city.districts.areas));
  const walls = blocks.walls.concat(rails, closures, gates);
  const props = blocks.props;
  const propGrid = buildPropGrid(graph, props);
  const coveredProps = propsUnderWalls(props, propGrid, walls.slice(blocks.walls.length));
  // Timed gates (sim/gates.ts): the level crossings' (city/levelCrossings.ts) fill the set.
  const timedGates: GateSet = { cycles: [], gates: [] };
  const levelCrossings = addLevelCrossings(city, timedGates);
  const pad = 60;
  const wallGrid = SpatialGrid.forBounds(graph.bounds.minX - pad, graph.bounds.minZ - pad, graph.bounds.maxX + pad, graph.bounds.maxZ + pad, CITY.broadphaseCell);
  walls.forEach((w, i) => wallGrid.insertSegment(i, w.ax, w.az, w.bx, w.bz, 0.5));
  const edgeGrid = blocks.edgeGrid;
  const scratch: number[] = [];

  /**
   * Circle against a small convex solid as one body: from outside, pushed off the nearest point
   * of its outline; from inside, out through the nearest face. Never toward the far side.
   */
  function collideSolid(s: Solid, kind: Wall['kind'], x: number, z: number, r: number, out: Contact[]): void {
    let best = -Infinity;
    let bi = 0;
    for (let i = 0; i < s.faces.length; i++) {
      const f = s.faces[i];
      const sd = (x - f.ax) * f.nx + (z - f.az) * f.nz;
      if (sd > best) {
        best = sd;
        bi = i;
      }
    }
    if (best >= r) return;
    if (best <= 0) {
      const f = s.faces[bi];
      out.push({ nx: f.nx, nz: f.nz, depth: r - best, px: x - f.nx * best, pz: z - f.nz * best, kind });
      return;
    }
    let d2 = Infinity;
    let px = 0;
    let pz = 0;
    for (const f of s.faces) {
      const t = segmentT(x, z, f.ax, f.az, f.bx, f.bz);
      const cx = f.ax + (f.bx - f.ax) * t;
      const cz = f.az + (f.bz - f.az) * t;
      const e2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (e2 < d2) {
        d2 = e2;
        px = cx;
        pz = cz;
      }
    }
    const d = sqrt(d2);
    if (d >= r || d < 1e-9) return;
    out.push({ nx: (x - px) / d, nz: (z - pz) / d, depth: r - d, px, pz, kind });
  }

  /** Whether a wall stands for a car body at height y (m): low walls flown over, parapets and decks passed under. */
  function standsFor(w: Wall, y: number): boolean {
    // A low wall (a car park's lip face) is flown over by a car above its top; a deck's parapet is
    // passed under by a car on the channel floor below its bottom.
    if (w.top !== undefined && y > w.top) return false;
    if (w.bottom !== undefined && y < w.bottom) return false;
    // A column (or anything) under the highway's deck is nothing to a car up on the deck.
    return w.under === undefined || y <= w.under;
  }

  /**
   * Whether the way from (x, z) to (px, pz), a point on wall `self`, comes in through the front of
   * another wall standing for height y: the circle is out in the open past the far face of a solid
   * thinner than the anti tunnelling band, not inside it.
   */
  function pastFarFace(self: number, x: number, z: number, px: number, pz: number, y: number): boolean {
    const dx = px - x;
    const dz = pz - z;
    for (const id of scratch) {
      const w = walls[id];
      if (id === self || w.solid || !standsFor(w, y)) continue;
      // Entering from its front: heading against its normal.
      if (dx * w.nx + dz * w.nz >= 0) continue;
      const ex = w.bx - w.ax;
      const ez = w.bz - w.az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((w.ax - x) * ez - (w.az - z) * ex) / den;
      const u = ((w.ax - x) * dz - (w.az - z) * dx) / den;
      // A little past either end of the wall: at a sliver's tip the two faces meet at a corner, to a
      // few cm (the block ring and the alley's walls are traced separately).
      const slack = 0.1 / sqrt(ex * ex + ez * ez);
      if (t > 0 && t <= 1 + 1e-6 && u >= -slack && u <= 1 + slack) return true;
    }
    return false;
  }

  function collideCircle(x: number, z: number, r: number, out: Contact[], y = -Infinity): number {
    out.length = 0;
    wallGrid.query(x - r - 3, z - r - 3, x + r + 3, z + r + 3, scratch);
    // A solid's faces are consecutive walls and the query is in ascending id order, so they come
    // up one after another: the solid is handled once, at the first of them.
    let lastSolid: Solid | undefined;
    for (const id of scratch) {
      const w = walls[id];
      if (!standsFor(w, y)) continue;
      if (w.solid) {
        if (w.solid !== lastSolid) collideSolid(w.solid, w.kind, x, z, r, out);
        lastSolid = w.solid;
        continue;
      }
      const t = segmentT(x, z, w.ax, w.az, w.bx, w.bz);
      const cx = w.ax + (w.bx - w.ax) * t;
      const cz = w.az + (w.bz - w.az) * t;
      const dx = x - cx;
      const dz = z - cz;
      const sd = dx * w.nx + dz * w.nz;
      // One sided: a center up to 3 m behind the wall still gets pushed back,
      // which stops fast cars tunnelling through. Unless it is already out through the solid's far
      // face (a sliver of block between an alley and a street meeting at a shallow angle): pushing it
      // back from there would haul a car in the open through the solid.
      if (sd < -3 || sd >= r) continue;
      if (sd < 0 && pastFarFace(id, x, z, cx, cz, y)) continue;
      let nx = w.nx;
      let nz = w.nz;
      let depth = r - sd;
      if (t <= 0 || t >= 1) {
        // Endpoint: push radially, but only if actually overlapping.
        const d = sqrt(dx * dx + dz * dz);
        if (d >= r) continue;
        if (sd > 0 && d > 1e-6) {
          nx = dx / d;
          nz = dz / d;
          depth = r - d;
        }
      }
      out.push({ nx, nz, depth, px: cx, pz: cz, kind: w.kind });
    }
    return out.length;
  }

  const boxScratch: Contact[] = [];
  function collideBox(cx: number, cz: number, yaw: number, halfLength: number, halfWidth: number, out: Contact[], y = -Infinity): number {
    // Approximate the box with overlapping circles along its length.
    out.length = 0;
    const n = Math.max(2, Math.ceil(halfLength / halfWidth) + 1);
    const fx = sin(yaw);
    const fz = cos(yaw);
    for (let i = 0; i < n; i++) {
      const u = -halfLength + halfWidth + ((2 * (halfLength - halfWidth)) * i) / (n - 1);
      collideCircle(cx + fx * u, cz + fz * u, halfWidth, boxScratch, y);
      for (const c of boxScratch) out.push(c);
    }
    return out.length;
  }

  function wallClearance(x: number, z: number, maxDist: number, y = -Infinity): number {
    wallGrid.query(x - maxDist, z - maxDist, x + maxDist, z + maxDist, scratch);
    let best = maxDist;
    for (const id of scratch) {
      const w = walls[id];
      // Low walls (car park lips) are launched over, not skimmed; a deck's parapet is nothing to a car under it.
      if (w.top !== undefined) continue;
      if (w.bottom !== undefined && y < w.bottom) continue;
      if (w.under !== undefined && y > w.under) continue;
      const d = distToSegment(x, z, w.ax, w.az, w.bx, w.bz);
      if (d < best) best = d;
    }
    return best;
  }

  // ---- Two drivable levels (districts/types.ts DeckSpan): the river's bridge decks over the channel
  // (`lower`) and the highway's deck and ramps over the streets (`upper`), indexed in a coarse grid of
  // span ids so a query visits the few spans of its cell, first in list order as a scan would.
  const spans = city.districts.builds.flatMap((b) => b.decks).map((d) => ({ d, ...polygonBounds(d.polygon) }));
  const SPAN_CELL = 24;
  let spanX0 = Infinity;
  let spanZ0 = Infinity;
  let spanX1 = -Infinity;
  let spanZ1 = -Infinity;
  for (const s of spans) {
    spanX0 = Math.min(spanX0, s.minX);
    spanZ0 = Math.min(spanZ0, s.minZ);
    spanX1 = Math.max(spanX1, s.maxX);
    spanZ1 = Math.max(spanZ1, s.maxZ);
  }
  const spanCols = spans.length ? Math.max(1, Math.ceil((spanX1 - spanX0) / SPAN_CELL)) : 0;
  const spanRows = spans.length ? Math.max(1, Math.ceil((spanZ1 - spanZ0) / SPAN_CELL)) : 0;
  const spanCells: number[][] = Array.from({ length: spanCols * spanRows }, () => []);
  spans.forEach((s, id) => {
    const i0 = Math.max(0, Math.floor((s.minX - spanX0) / SPAN_CELL));
    const i1 = Math.min(spanCols - 1, Math.floor((s.maxX - spanX0) / SPAN_CELL));
    const j0 = Math.max(0, Math.floor((s.minZ - spanZ0) / SPAN_CELL));
    const j1 = Math.min(spanRows - 1, Math.floor((s.maxZ - spanZ0) / SPAN_CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) spanCells[j * spanCols + i].push(id);
  });
  const levelSample: HeightSample = { h: 0, gx: 0, gz: 0 };
  const upperSample: HeightSample = { h: 0, gx: 0, gz: 0 };
  function spanAt(x: number, z: number): DeckSpan | null {
    if (x < spanX0 || z < spanZ0 || x > spanX1 || z > spanZ1) return null;
    const cell = spanCells[Math.min(spanRows - 1, Math.floor((z - spanZ0) / SPAN_CELL)) * spanCols + Math.min(spanCols - 1, Math.floor((x - spanX0) / SPAN_CELL))];
    for (const id of cell) {
      const s = spans[id];
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      if (pointInPolygon(x, z, s.d.polygon)) return s.d;
    }
    return null;
  }
  /**
   * Whether a body at height y over (x, z) inside span s drives the lower level there: the span's
   * lower profile (left in levelSample, relative to the terrain height h) when the body is nearer the
   * span's floor than its deck, i.e. more than half the drop below the deck. Measured against the
   * deck and the drop, not the terrain under the body (which eases down from the deck under its
   * edge), so a car on the floor stays on it right up to the deck's edge and a car on the deck stays
   * up where the bank beneath rises to meet it.
   */
  function lowerOn(s: DeckSpan, x: number, z: number, y: number, h: number): boolean {
    levelSample.h = 0;
    levelSample.gx = 0;
    levelSample.gz = 0;
    const rise = s.lower!(x, z, levelSample);
    // Where the two levels meet (the bank tops under the deck's ends, the floor beyond the deck's
    // edge) the lower one is the terrain itself, gradient included, so no special case is needed.
    return y <= h + rise - s.depth / 2;
  }
  /**
   * Whether a body at height y over (x, z) inside an upper span s drives its upper level (its height
   * and gradient left in upperSample): always on a solid one (a ramp's walled body), else when the
   * body is nearer the upper level than the terrain h beneath. Where the two meet (a ramp's top over
   * the sidewalk) they are one height, so the choice there never jumps.
   */
  function upperOn(s: DeckSpan, x: number, z: number, y: number, h: number): boolean {
    s.upper!(x, z, upperSample);
    return s.solid === true || 2 * y > h + upperSample.h;
  }
  function lowerLevel(x: number, z: number, y: number | undefined, h: number): boolean {
    if (y === undefined || !spans.length) return false;
    const s = spanAt(x, z);
    return s !== null && s.lower !== undefined && lowerOn(s, x, z, y, h);
  }
  function heightAt(x: number, z: number, y?: number): number {
    const h = terrain.heightAt(x, z);
    if (y === undefined || !spans.length) return h;
    const s = spanAt(x, z);
    if (s === null) return h;
    if (s.lower) return lowerOn(s, x, z, y, h) ? h + levelSample.h : h;
    return upperOn(s, x, z, y, h) ? upperSample.h : h;
  }
  function slopeAt(x: number, z: number, y?: number): { gx: number; gz: number } {
    const s = terrain.slopeAt(x, z);
    if (y === undefined || !spans.length) return s;
    const sp = spanAt(x, z);
    if (sp !== null && sp.upper) return upperOn(sp, x, z, y, terrain.heightAt(x, z)) ? { gx: upperSample.gx, gz: upperSample.gz } : s;
    if (!lowerLevel(x, z, y, terrain.heightAt(x, z))) return s;
    return { gx: s.gx + levelSample.gx, gz: s.gz + levelSample.gz };
  }
  function twoLevels(x: number, z: number): boolean {
    if (!spans.length) return false;
    const s = spanAt(x, z);
    return s !== null && s.lower !== undefined;
  }
  function upperLevel(x: number, z: number, y: number): boolean {
    if (!spans.length) return false;
    const s = spanAt(x, z);
    return s !== null && s.upper !== undefined && upperOn(s, x, z, y, terrain.heightAt(x, z));
  }

  /** Bus bays and path mouths by edge (busBays.ts): their stretch of sidewalk is road, with a curb of its own. */
  const bayOf = baysByEdge(blocks.bays ?? [], graph.edges.length);
  const streetScratch: number[] = [];
  /** streetDistance's results (m): to the nearest road surface (negative on it) and to the outer sidewalk line. */
  let streetRoad = Infinity;
  let streetWalk = Infinity;
  /**
   * The street classification by distance to the edges near (x, z): road strips, their sidewalks, and the
   * bus bays (whose indented curb is a curb like any other). On a deck (`span`) the channel edges beneath
   * are no street of its own. Writes streetRoad / streetWalk: surfaceAt and curbLift run per wheel per
   * substep, so nothing allocates.
   */
  function streetDistance(x: number, z: number, span: DeckSpan | null): void {
    edgeGrid.query(x - 1, z - 1, x + 1, z + 1, streetScratch);
    let road = Infinity;
    let walk = Infinity;
    for (const id of streetScratch) {
      const e = graph.edges[id];
      if (span && isRiverEdge(e)) continue;
      const a = graph.nodes[e.a];
      const b = graph.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z) - e.width / 2;
      if (d < road) road = d;
      if (d - e.sidewalk < walk) walk = d - e.sidewalk;
      for (const bay of bayOf[id]) {
        const bd = bayRoadDistance(bay, x, z);
        if (bd < road) road = bd;
      }
    }
    streetRoad = road;
    streetWalk = walk;
  }
  function surfaceAt(x: number, z: number, y?: number): Surface {
    const found = spans.length ? spanAt(x, z) : null;
    // On the highway's deck or a ramp: road. Under it, the street as anywhere.
    if (found && found.upper && y !== undefined && upperOn(found, x, z, y, terrain.heightAt(x, z))) return 'road';
    const span = found && found.lower ? found : null;
    // Under a deck: the channel's own patches (its concrete, the trickle) below, the street above
    // (the channel edges running beneath are no part of the deck's classification).
    const patch = city.districts.surfaceAt(x, z);
    if (span && y !== undefined && lowerOn(span, x, z, y, terrain.heightAt(x, z))) return patch && patch.area === span.area ? patch.surface : 'concrete';
    streetDistance(x, z, span);
    // District surface patches win over the street classification by priority (road 5, sidewalk 3).
    const base = streetRoad <= 0 ? 5 : streetWalk <= 0 ? 3 : 0;
    if (patch && patch.priority > base && !(span && patch.area === span.area)) return patch.surface;
    return base === 5 ? 'road' : base === 3 ? 'sidewalk' : 'offroad';
  }

  const rings = graph.nodes.filter((n) => n.ring);
  /** Flared shortcut mouths: the junction fan out to the curved curbs, and how far it reaches from the node. */
  const fans = graph.nodes.flatMap((n, i) => {
    const secs = blocks.sectors[i];
    if (!secs.some((s) => s.flared)) return [];
    const ring = secs.flatMap((s) => s.curb);
    let reach = 0;
    for (const p of ring) reach = Math.max(reach, sqrt((p.x - n.x) ** 2 + (p.z - n.z) ** 2));
    return [{ x: n.x, z: n.z, ring, reach }];
  });
  const CURB_IN = CITY.curbRamp.road;
  const CURB_SPAN = CITY.curbRamp.road + CITY.curbRamp.walk;
  /** Paving a district draws at curb height: plazas, corner pockets and verges, the monument plaza. */
  const raisedPatch = (area: number): boolean => {
    const a = city.districts.areas[area];
    return a.kind === 'monument' || (a.kind === 'infill' && a.variant !== 'lot' && a.variant !== 'planter');
  };
  /**
   * Curb lift under a point (m). The street classification is surfaceAt's
   * (road strips and their sidewalks, by distance to the edges) plus the
   * roundabout rings (road inside the outer curb, sidewalk around it). A
   * district patch over the sidewalk's priority that is not sidewalk (alley
   * cobbles, the river) keeps the ground flat; plazas at curb height lift.
   * The lift eases in from curbRamp.road out on the road to curbRamp.walk
   * onto the paving.
   */
  function curbLift(x: number, z: number, span: DeckSpan | null): number {
    streetDistance(x, z, span);
    let road = streetRoad;
    let walk = streetWalk;
    for (const n of rings) {
      const d = sqrt((x - n.x) ** 2 + (z - n.z) ** 2) - n.ring!.outer;
      if (d < road) road = d;
      if (d - CITY.sidewalk < walk) walk = d - CITY.sidewalk;
    }
    // A flared mouth's curved curbs: distance outside its fan (the fan itself is a road patch).
    for (const f of fans) {
      if ((x - f.x) ** 2 + (z - f.z) ** 2 > (f.reach + CITY.sidewalk) ** 2) continue;
      let d = Infinity;
      for (let i = 0; i < f.ring.length; i++) {
        const p = f.ring[i];
        const q = f.ring[(i + 1) % f.ring.length];
        d = Math.min(d, distToSegment(x, z, p.x, p.z, q.x, q.z));
      }
      if (pointInPolygon(x, z, f.ring)) d = -d;
      if (d < road) road = d;
    }
    if (road <= -CURB_IN) return 0;
    const patch = city.districts.surfaceAt(x, z);
    if (patch && patch.priority > 3 && patch.surface !== 'sidewalk' && !(span && patch.area === span.area)) return 0;
    if (walk > 0 && !(patch && (patch.surface === 'sidewalk' || raisedPatch(patch.area)))) return 0;
    const t = (road + CURB_IN) / CURB_SPAN;
    if (t >= 1) return CITY.curbHeight;
    return CITY.curbHeight * t * t * (3 - 2 * t);
  }

  function driveHeightAt(x: number, z: number, y?: number): number {
    const h = terrain.heightAt(x, z);
    const found = spans.length ? spanAt(x, z) : null;
    // The highway's deck and ramps have no curbs (their barriers and walls stand on them).
    if (found && found.upper && y !== undefined && upperOn(found, x, z, y, h)) return upperSample.h;
    const span = found && found.lower ? found : null;
    // The channel floor under a deck has no curbs: the deck's sidewalks are above it.
    if (span && y !== undefined && lowerOn(span, x, z, y, h)) return h + levelSample.h;
    return h + curbLift(x, z, span);
  }

  const pts = route.points;
  const nseg = pts.length - 1;
  const HINT_REACH = 40;
  function projectSeg(i: number, x: number, z: number) {
    const a = pts[i];
    const b = pts[i + 1];
    const t = segmentT(x, z, a.x, a.z, b.x, b.z);
    const cx = a.x + (b.x - a.x) * t;
    const cz = a.z + (b.z - a.z) * t;
    return { t, d2: (x - cx) ** 2 + (z - cz) ** 2, cx, cz };
  }

  function routeProgress(x: number, z: number, hintSeg?: number): RouteProgress {
    let bestI = 0;
    let best = Infinity;
    const consider = (i: number) => {
      const p = projectSeg(i, x, z);
      if (p.d2 < best) {
        best = p.d2;
        bestI = i;
      }
    };
    if (hintSeg !== undefined && hintSeg >= 0 && hintSeg < nseg) {
      // At least two segments each way, and at least HINT_REACH m (roundabout arcs are short).
      consider(hintSeg);
      for (const dir of [-1, 1]) {
        let covered = 0;
        for (let k = 1; k < nseg / 2 && (k <= 2 || covered < HINT_REACH); k++) {
          let i = hintSeg + dir * k;
          if (route.closed) i = (i + nseg) % nseg;
          if (i < 0 || i >= nseg) break;
          consider(i);
          covered += route.cum[i + 1] - route.cum[i];
        }
      }
    } else {
      for (let i = 0; i < nseg; i++) consider(i);
    }
    const a = pts[bestI];
    const b = pts[bestI + 1];
    const p = projectSeg(bestI, x, z);
    const segLen = route.cum[bestI + 1] - route.cum[bestI] || 1;
    const tx = (b.x - a.x) / segLen;
    const tz = (b.z - a.z) / segLen;
    return {
      s: route.cum[bestI] + p.t * segLen,
      lateral: (x - p.cx) * tz - (z - p.cz) * tx,
      seg: bestI,
      tx,
      tz,
    };
  }

  return {
    ...city,
    route,
    walls,
    wallGrid,
    barrierGroups,
    openWorld,
    props,
    coveredProps,
    propGrid,
    heightAt,
    driveHeightAt,
    slopeAt,
    surfaceAt,
    twoLevels,
    upperLevel,
    collideCircle,
    collideBox,
    wallClearance,
    routeProgress,
    areas: city.districts.areas,
    areaAt: city.districts.areaAt,
    timedGates,
    levelCrossings,
  };
}

/** Ids of non-streetlight props that a route wall (barrier or rail) passes through. */
/** Props closer than this (m, beyond their radius) to a route barrier or rail start the race removed. */
const COVER_CLEAR = 0.25;

function propsUnderWalls(props: Prop[], grid: SpatialGrid, routeWalls: Wall[]): number[] {
  const out = new Set<number>();
  const scratch: number[] = [];
  for (const w of routeWalls) {
    grid.query(Math.min(w.ax, w.bx) - 3, Math.min(w.az, w.bz) - 3, Math.max(w.ax, w.bx) + 3, Math.max(w.az, w.bz) + 3, scratch);
    for (const id of scratch) {
      const p = props[id];
      // Clutter a rail would clip (alley tables and crates at the back of a narrow sidewalk) goes too.
      if (p.kind !== 'streetlight' && distToSegment(p.x, p.z, w.ax, w.az, w.bx, w.bz) <= p.radius + COVER_CLEAR) out.add(id);
    }
  }
  return [...out].sort((a, b) => a - b);
}
