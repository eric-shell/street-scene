/**
 * The start and finish gates of a route as the people plan sees them: where the line is, which way the road
 * runs through it and how wide the gantry spans. A circuit has one gate (start = finish), a sprint a start and a
 * finish; a circuit starting on a race pass (Route.passStart) has none, since the landmark is the gate and no
 * gantry or sidewalk crowd stands there. Pure; the finish line renderer (render/race/finishGantry.ts) builds its
 * gantries from the same numbers, so the planned stands and the drawn steel agree.
 */
import type { World } from '../world';
import { routeSample } from '../route';
import { atan2 } from '../../sim/math';

export type GateKind = 'start' | 'finish' | 'startFinish';

export interface PeopleGate {
  kind: GateKind;
  /** Route distance of the line (m). */
  s: number;
  /** Road centre on the line, at ground height (m). */
  position: { x: number; y: number; z: number };
  /** Heading of the road through the gate (three.js yaw, rad). */
  yaw: number;
  /** Half distance between the pillar centres (m). */
  halfSpan: number;
}

/** The pillars stand this far outside the road edge (m). */
const PILLAR_OUTSET = 1.7;

/** The route's lines: one `startFinish` on a circuit, `start` and `finish` on a sprint (also where a pass-start circuit has no gantry). */
export function gateLines(world: World): { s: number; kind: GateKind }[] {
  const route = world.route;
  return route.closed
    ? [{ s: route.startS, kind: 'startFinish' }]
    : [
        { s: route.startS, kind: 'start' },
        { s: route.finishS, kind: 'finish' },
      ];
}

/** The gate standing at route distance `s`. */
export function gateAt(world: World, s: number, kind: GateKind): PeopleGate {
  const route = world.route;
  const p = routeSample(route, s);
  return {
    kind,
    s,
    position: { x: p.x, y: world.heightAt(p.x, p.z), z: p.z },
    yaw: atan2(p.tx, p.tz),
    halfSpan: route.segWidth[p.seg] / 2 + PILLAR_OUTSET,
  };
}

/** The gates with a gantry: none on a pass-start circuit. */
export function routeGates(world: World): PeopleGate[] {
  if (world.route.passStart) return [];
  return gateLines(world).map((l) => gateAt(world, l.s, l.kind));
}
