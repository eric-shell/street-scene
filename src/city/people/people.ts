/**
 * The people of a city as one plan the sim, the menu city and the race renderer all read: the start / finish
 * stands (gateStands.ts), the idle people (idleSpots.ts) and the walkers (walkPaths.ts), each a `WorldPerson` with
 * an id, a home, the numbers a sidestep needs (the wall behind) and the extras its kind has. `peopleOf(world)` is
 * a pure function of the World, planned once per World and cached (the pattern of sim/traffic/net.ts).
 *
 * One canonical density, whatever the graphics quality: the sim collides with these people, so every tier must
 * draw them all; quality only sets draw and LOD distances. The planners stay parameterized (tests sweep tiers);
 * the numbers they are called with live in CANON below.
 *
 * Zones the people keep out of (the gates, the street meets, the market pens) come from the city alone
 * (avoid.ts), not from the renderer's plans. Plan order: gate stands, idlers, walkers; ids index `people`.
 * Reads World, no three.js.
 */
import type { World } from '../world';
import { Rng, deriveSeed } from '../../sim/prng';
import { SpatialGrid } from '../spatial';
import { atan2 } from '../../sim/math';
import { peopleAvoid } from './avoid';
import { routeGates } from './gates';
import type { PeopleGate } from './gates';
import { placeGate } from './gateStands';
import { planIdlers } from './idleSpots';
import type { IdlePose } from './idleSpots';
import { makePlacer, wallBehind } from './placer';
import { planWalkers, walkerAt } from './walkPaths';
import type { WalkerPose } from './walkPaths';

export type PersonKind = 'gate' | 'idle' | 'walk';

export interface WorldPerson {
  /** Index in PeoplePlan.people. */
  id: number;
  kind: PersonKind;
  /** Home (m): walkers, the path's first point; y = floor height. */
  x: number;
  y: number;
  z: number;
  /** Facing (three.js yaw, rad; forward = (sin, cos)); walkers: the heading at the start. */
  yaw: number;
  /** Body scale, 0.9 to 1.1. */
  scale: number;
  /** Seeds wardrobe, phase and style in the renderer. */
  lookSeed: number;
  /** Which way this person steps when a car comes straight at them (+1 the car's right, -1 its left): `(lookSeed & 1) ? 1 : -1`, so the renderer derives the same from the look seed. */
  prefer: 1 | -1;
  /** 0..1, shared by a small group. */
  groupPhase: number;
  /** Unit vector toward the nearest wall behind (the direction a sidestep is limited in). */
  backX: number;
  backZ: number;
  /** How far one can step that way before the wall (m). */
  backRoom: number;
  /** Start / finish stands: gate index into PeoplePlan.gates, signed route distance from the line (m), audio side, sidewalk row (0 front). */
  gate?: { gate: number; ds: number; side: 0 | 1; row: number };
  idle?: { pose: IdlePose; anchorProp: number };
  /** The walker's path (x, y, z, cumulative length per point), length (m), speed (m/s), phase (0..1), style (0..1) and cell (walkPaths.Walker's fields). */
  walk?: { pts: number[]; length: number; speed: number; phase: number; style: number; cell: number };
}

export interface PeoplePlan {
  people: WorldPerson[];
  /** Everyone, by id: gate and idle people as circles of CIRCLE_R, walkers by each path segment padded by WALK_PAD. */
  grid: SpatialGrid;
  /** -1 (cool) .. 1 (warm): how the seed's wardrobe leans. */
  warmth: number;
  /** The gates the stands face (empty in an open world, like the drawn stands). */
  gates: PeopleGate[];
}

/**
 * The one density every graphics tier shares: the sim collides with these people, so a tier that planned fewer
 * would play a different race. The renderer scales draw and LOD distances, not the plan.
 */
export const CANON = {
  gate: { density: 0.9, rows: 3 },
  idle: { density: 0.9, cap: 440 },
  walk: { perCell: 80, per100m: 20 },
} as const;

/** Radius (m) a standing person claims in the grid: their body plus the biggest sidestep. */
const CIRCLE_R = 2;
/** Padding (m) of a walker's path segments in the grid. */
const WALK_PAD = 2.5;
/** Grid cell (m). */
const GRID_CELL = 8;

const cache = new WeakMap<World, PeoplePlan>();

/** The people of a world: planned once, cached per World, deterministic. */
export function peopleOf(world: World): PeoplePlan {
  let plan = cache.get(world);
  if (!plan) {
    plan = buildPlan(world);
    cache.set(world, plan);
  }
  return plan;
}

/** The side a person steps to when a car is dead ahead: odd look seeds the car's right, even its left (the renderer's shaders derive the same). */
const preferOf = (lookSeed: number): 1 | -1 => (lookSeed & 1 ? 1 : -1);

const scaleOf = (lookSeed: number): number => 0.93 + 0.13 * new Rng(lookSeed).next();

function buildPlan(world: World): PeoplePlan {
  const gates = world.openWorld ? [] : routeGates(world);
  const avoid = peopleAvoid(world, gates);
  const people: WorldPerson[] = [];
  const back = { backX: 0, backZ: 0, backRoom: 0 };

  // Gate stands.
  const gateRng = new Rng(deriveSeed(world.seed, 'gateStands'));
  const placer = makePlacer(world);
  const ok = placer.ok;
  const clear = { ok: (x: number, z: number, ignore?: number) => !avoid.blocked!(x, z) && ok(x, z, ignore), take: placer.take };
  gates.forEach((gate, gi) => {
    for (const s of placeGate(world, gate, gateRng, CANON.gate.density, CANON.gate.rows, clear)) {
      const lookSeed = gateRng.int(1, 0x3fffffff);
      wallBehind(world, s.x, s.z, s.yaw, back);
      people.push({ id: people.length, kind: 'gate', x: s.x, y: s.y, z: s.z, yaw: s.yaw, scale: scaleOf(lookSeed), lookSeed, prefer: preferOf(lookSeed), groupPhase: s.groupPhase, ...back, gate: { gate: gi, ds: s.ds, side: s.side, row: s.row } });
    }
  });

  // Idlers.
  const idle = planIdlers(world, { density: CANON.idle.density, cap: CANON.idle.cap, avoid });
  for (const p of idle.people) {
    people.push({ id: people.length, kind: 'idle', x: p.x, y: p.y, z: p.z, yaw: p.yaw, scale: scaleOf(p.lookSeed), lookSeed: p.lookSeed, prefer: preferOf(p.lookSeed), groupPhase: p.groupPhase, backX: p.backX, backZ: p.backZ, backRoom: p.backRoom, idle: { pose: p.pose, anchorProp: p.anchorProp } });
  }

  // Walkers.
  for (const w of planWalkers(world, { budget: CANON.walk, avoid })) {
    const yaw = w.pts.length >= 8 ? atan2(w.pts[4] - w.pts[0], w.pts[6] - w.pts[2]) : 0;
    const frac = w.style * 13.7 - Math.floor(w.style * 13.7);
    people.push({
      id: people.length,
      kind: 'walk',
      x: w.pts[0],
      y: w.pts[1],
      z: w.pts[2],
      yaw,
      scale: 0.94 + 0.12 * frac,
      lookSeed: w.lookSeed,
      prefer: preferOf(w.lookSeed),
      groupPhase: w.groupPhase,
      backX: w.backX,
      backZ: w.backZ,
      backRoom: w.backRoom,
      walk: { pts: w.pts, length: w.length, speed: w.speed, phase: w.phase, style: w.style, cell: w.cell },
    });
  }

  const b = world.graph.bounds;
  const grid = SpatialGrid.forBounds(b.minX - 100, b.minZ - 100, b.maxX + 100, b.maxZ + 100, GRID_CELL);
  for (const p of people) {
    if (p.walk) {
      const q = p.walk.pts;
      for (let i = 0; i + 7 < q.length; i += 4) grid.insertSegment(p.id, q[i], q[i + 2], q[i + 4], q[i + 6], WALK_PAD);
    } else grid.insertBox(p.id, p.x - CIRCLE_R, p.z - CIRCLE_R, p.x + CIRCLE_R, p.z + CIRCLE_R);
  }
  return { people, grid, warmth: idle.warmth, gates };
}

const pose: WalkerPose = { x: 0, z: 0, yaw: 0 };

/** Where a person is at time `t` (s): home for gate and idle people, the walker's place on its cycle (walkPaths.walkerAt) for a walker. */
export function personAt(p: WorldPerson, t: number, out: { x: number; z: number; yaw: number }): void {
  if (p.walk) {
    walkerAt(p.walk, t, pose);
    out.x = pose.x;
    out.z = pose.z;
    out.yaw = pose.yaw;
  } else {
    out.x = p.x;
    out.z = p.z;
    out.yaw = p.yaw;
  }
}
