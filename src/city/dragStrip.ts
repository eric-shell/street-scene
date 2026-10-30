/**
 * Which streets the drag strip may run along (routeSearch.ts findDragNodes takes this as its `edgeOk`), shared by the
 * finished city (world.ts createRoute, the rasterized areaAt) and the planners that must keep clear of the strip
 * before the city is finished (the parking lots: they are planned last, from the areas so far, so the strip they
 * keep off is the one the city will pick). Pure.
 */
import { ROUTE } from './config';
import type { RoadGraph } from './roadGraph';
import { ROADWORKS } from './districts/roadworks';
import type { Area } from './districts/types';

/**
 * Districts a drag strip keeps off: whatever stands in the street, narrows it or takes it off grade.
 * The El (columns on the sidewalk) and tunnels (full width bores) may stand over a strip; roadworks
 * may close a curb lane beside it (stripEdgeOk). The cable car's street is off it, and so is every street
 * out of its terminal junctions: a strip through one would close the line's street off with a barrier and
 * a street meet right where the car stands at its terminal.
 */
const OFF_STRIP = new Set<Area['kind']>(['market', 'channel', 'roundabout', 'overpass', 'carPark', 'monument', 'bluff', 'cableCar']);
/** Room a drag car needs from the centerline out to a roadworks closure's barriers (m): its lane plus half a car and a margin. */
const STRIP_CLEAR = ROUTE.dragLaneOffset + 1.5;

/**
 * Whether a street can be part of the drag strip: no district on its carriageway, sampled every 8 m along it
 * (`areaAt`: the area at a point). A street bridge over the channel stands in the channel's area and is fine, and a
 * lane closure is fine where its barriers stand clear of the drag lane on their side.
 */
export function stripEdgeOk(g: RoadGraph, edge: number, areas: readonly Area[], areaAt: (x: number, z: number) => Area | null): boolean {
  const e = g.edges[edge];
  if (areas.some((a) => a.kind === 'cableCar' && (a.params.first === e.a || a.params.first === e.b || a.params.last === e.a || a.params.last === e.b))) return false;
  const A = g.nodes[e.a];
  const B = g.nodes[e.b];
  const steps = Math.max(1, Math.ceil(e.length / 8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = areaAt(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t);
    if (a && OFF_STRIP.has(a.kind) && !(e.bridge && a.kind === 'channel')) return false;
  }
  return !areas.some((a) => a.kind === 'roadworks' && a.params.edge === edge && e.width / 2 - a.params.close - ROADWORKS.barrierReach < STRIP_CLEAR);
}
