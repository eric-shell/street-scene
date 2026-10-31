/**
 * Where the city's pedestrians walk, and who walks where: a pure planner (no
 * three.js) from the seeded world, so the menu city and a race put the same
 * people on the same sidewalks, and the sim (src/sim/people.ts) knows where
 * each walker is: `walkerAt` is the TypeScript twin of the walker shader's
 * position (WALK_POSE in render/people/walkers.ts) and the two MUST change
 * together, like RIG_GLSL and personFrame. Reads World.
 *
 * Paths first. Every ordinary street's sidewalk, each side of each edge, is
 * sampled along its middle between the junction corners; across the walk a
 * small dynamic program picks the lateral offset of each sample (a lane in
 * 0.25 m steps) that keeps clear of props by their collision radius, off the
 * curb and the walls and away from the road (a bus bay's cut), with cheap
 * moves between neighbours so a detour is a smooth bend rather than a jog. The
 * best lane through each clear run is simplified to a handful of points (a
 * straight sidewalk is two) and cut so no path needs more than MAX_PTS: that
 * is the budget the shader's per-instance attributes can hold.
 *
 * Then people. Each cell of the city gets walkers in proportion to the path
 * length in it, scaled up downtown and toward the route, capped by the plan's
 * canonical `perCell`. A walker is a path (a stretch of one, often running to a corner),
 * a speed, a phase in its back and forth cycle, a look seed and a body scale.
 * Nothing here moves: the shader turns (path, speed, phase, clock) into a
 * position (walkers.ts), so the plan is built once and costs nothing per frame;
 * the sim does the same with `walkerAt`.
 */
import type { World } from '../world';
import type { Contact } from '../world';
import { downtownFactor, isMouthEdge, isChannelEdge, isFeatureEdge } from '../roadGraph';
import { Rng, deriveSeed } from '../../sim/prng';
import { atan2, clamp, distToSegment, smoothstep, sqrt } from '../../sim/math';
import { groundY, wallRoom } from './placer';
import { routeSample } from '../route';
import { avoidCircles } from './idleSpots';
import { SpatialGrid } from '../spatial';
import type { IdleAvoid } from './idleSpots';

/** Tuning of the planner. */
export const WALK = {
  /** A cell of the grid walkers are grouped, culled and capped by (m). */
  cell: 100,
  /** A path's points per walker: the shader reads this many (the start is the instance origin, the rest are attributes). */
  maxPts: 5,
  /** Sample spacing along a sidewalk (m) and the lane spacing across it (m). */
  step: 0.75,
  lane: 0.25,
  /** Room kept from the curb and from the building line (m). */
  edgeMargin: 0.75,
  /** Room kept beyond a prop's collision radius (m): the walker's own body and the lane it keeps to. */
  propClear: 0.55,
  /** Radius of a walker for the walls (m). */
  body: 0.4,
  /** Pulled in from the junction corner at each end of a sidewalk (m). */
  endInset: 0.4,
  /** Shortest path (m), longest path before it is cut in two (m). */
  minLength: 8,
  maxLength: 110,
  /** How far a simplified path may stray from the lane it follows (m). */
  tolerance: 0.1,
  /** Cost of moving a lane over to the next sample (per step), of standing off the middle (per m), against a sample's route. */
  moveCost: 0.5,
  offCost: 0.05,
  /** Walking speeds (m/s). */
  speed: [1.1, 1.6],
  /** The shortest stretch a walker covers (m). */
  minWalk: 14,
  /** The most a walker keeps to the right of its path (m): the shader's 0.2 + 0.12 * fract(style * 5.3), so a lane toward the building can lose this much room. */
  keepRightMax: 0.32,
  /** Room kept beside the route's road and beside a route shortcut's alley (m): the curb lane. A path never runs inside the race line's corridor. */
  routeClear: 1,
  /** Streets with a narrower sidewalk than this (m) are not walked; walkers keep this far from a start / finish gate (m). */
  minSidewalk: 2.5,
  gateClear: 80,
  /** Boosts: downtown adds this much of the base density at its centre, the route this much within `routeNear` m of it falling off by `routeFar`. */
  downtownBoost: 0.9,
  routeBoost: 0.7,
  routeNear: 25,
  routeFar: 170,
} as const;

/** A walkable stretch of sidewalk: x, y, z per point, the cumulative length at each, and how crowded the street around it is. */
export interface WalkPath {
  /** x, y, z of each point. */
  pts: number[];
  /** Cumulative length at each point (m); the last is the path's length. */
  cum: number[];
  length: number;
  /** Cell key of the path's middle. */
  cell: number;
  /** Relative walkers per metre: 1 on a quiet street, up to about 2.6 downtown on the route. */
  weight: number;
  /** Unit vector from the path toward the buildings (away from the road), and how far a walker can step that way before the wall (m, >= 0). */
  backX: number;
  backZ: number;
  backRoom: number;
}

/** One pedestrian: its stretch of path, absolute, and what the shader needs of its character. */
export interface Walker {
  /** x, y, z, cumulative length (m) per point, 2..maxPts points. */
  pts: number[];
  length: number;
  /** Walking speed (m/s). */
  speed: number;
  /** Where in the back and forth cycle the clock starts (0..1). */
  phase: number;
  /** Seeds the pauses, the stride and the body scale in the shader (0..1). */
  style: number;
  /** Seeds the wardrobe. */
  lookSeed: number;
  cell: number;
  /** 0..1, the walker's own (the sim's people share the field with groups). */
  groupPhase: number;
  /** Unit vector toward the wall the sidewalk ends in, and the room to step that way (m, >= 0): where a sidestep is limited. */
  backX: number;
  backZ: number;
  backRoom: number;
}

export interface WalkOptions {
  /** The walkers a cell may hold and per 100 m of walkable sidewalk (the plan's `CANON.walk`). */
  budget: { perCell: number; per100m: number };
  avoid?: IdleAvoid;
}

/** The grid cell holding (x, z), as one integer key. */
export const cellKey = (x: number, z: number): number => (Math.floor(x / WALK.cell) + 4096) * 8192 + (Math.floor(z / WALK.cell) + 4096);

/** The walkers of a world. Deterministic for (world, options). */
export function planWalkers(world: World, opts: WalkOptions): Walker[] {
  if (opts.budget.perCell <= 0 || opts.budget.per100m <= 0) return [];
  const paths = planPaths(world, opts.avoid);
  const rng = new Rng(deriveSeed(world.seed, 'walkers'));
  const byCell = new Map<number, WalkPath[]>();
  for (const p of paths) {
    let list = byCell.get(p.cell);
    if (!list) byCell.set(p.cell, (list = []));
    list.push(p);
  }
  const out: Walker[] = [];
  for (const key of [...byCell.keys()].sort((a, b) => a - b)) {
    const list = byCell.get(key)!;
    let weighted = 0;
    for (const p of list) weighted += p.length * p.weight;
    const n = Math.min(opts.budget.perCell, Math.round((weighted / 100) * opts.budget.per100m));
    for (let k = 0; k < n; k++) {
      // A path by its length and weight.
      let pick = rng.next() * weighted;
      let path = list[list.length - 1];
      for (const p of list) {
        pick -= p.length * p.weight;
        if (pick <= 0) {
          path = p;
          break;
        }
      }
      out.push(walkerOn(path, rng));
    }
  }
  return out;
}

/** A walker on a stretch of the path: half walk the whole of it, the rest part of it, mostly running to an end. */
function walkerOn(path: WalkPath, rng: Rng): Walker {
  const L = path.length;
  const whole = rng.chance(0.5) || L <= WALK.minWalk * 1.2;
  const span = whole ? L : rng.range(WALK.minWalk, L);
  let u0 = whole ? 0 : rng.range(0, L - span);
  // Most stretches end at a corner: the walker arrives somewhere and turns round.
  if (!whole) {
    const r = rng.next();
    if (r < 0.3) u0 = 0;
    else if (r < 0.6) u0 = L - span;
  }
  const clipped = clip(path, u0, u0 + span);
  if (rng.chance(0.5)) reverse(clipped);
  const [lo, hi] = WALK.speed;
  return {
    pts: clipped,
    length: clipped[clipped.length - 1],
    speed: rng.range(lo, hi),
    phase: rng.next(),
    style: rng.next(),
    lookSeed: rng.int(1, 0x3fffffff),
    cell: path.cell,
    groupPhase: rng.next(),
    backX: path.backX,
    backZ: path.backZ,
    backRoom: path.backRoom,
  };
}

/** The path between arc positions a and b as x, y, z, cumulative length (from 0) per point. */
function clip(path: WalkPath, a: number, b: number): number[] {
  const out: number[] = [];
  const n = path.cum.length;
  const at = (u: number): [number, number, number] => {
    let i = 0;
    while (i < n - 2 && u > path.cum[i + 1]) i++;
    const span = path.cum[i + 1] - path.cum[i];
    const f = span > 1e-6 ? (u - path.cum[i]) / span : 0;
    const p = path.pts;
    return [p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * f, p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * f, p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * f];
  };
  const push = (x: number, y: number, z: number, u: number) => out.push(x, y, z, u - a);
  const [sx, sy, sz] = at(a);
  push(sx, sy, sz, a);
  for (let i = 0; i < n; i++) if (path.cum[i] > a + 1e-3 && path.cum[i] < b - 1e-3) push(path.pts[i * 3], path.pts[i * 3 + 1], path.pts[i * 3 + 2], path.cum[i]);
  const [ex, ey, ez] = at(b);
  push(ex, ey, ez, b);
  return out;
}

/** Walk the other way: the points in reverse with the lengths counted from the new start. */
function reverse(p: number[]): void {
  const n = p.length / 4;
  const L = p[p.length - 1];
  const pts: number[] = [];
  for (let i = n - 1; i >= 0; i--) pts.push(p[i * 4], p[i * 4 + 1], p[i * 4 + 2], L - p[i * 4 + 3]);
  for (let i = 0; i < pts.length; i++) p[i] = pts[i];
}

// ---------------------------------------------------------------------------
// The sidewalks
// ---------------------------------------------------------------------------

/** Every walkable path of the world's streets. */
export function planPaths(world: World, avoid?: IdleAvoid): WalkPath[] {
  const g = world.graph;
  const circles = avoidCircles(avoid);
  const gates = avoid?.gates ?? [];
  const blockedAt = avoid?.blocked;
  const covered = new Set(world.coveredProps);
  const contacts: Contact[] = [];
  const near: number[] = [];
  const out: WalkPath[] = [];
  const route = world.route;
  // The race line's own ground: a cross street's sidewalk can run on through a ford or a race pass, so every
  // sample is held to the route's corridor and to each shortcut's (the shapes the idle planner and planMeets keep to).
  const alleys = route.shortcuts.map((sc) => {
    const edge = g.edges[sc.edges[0]];
    return { points: sc.points, half: edge.width / 2 + edge.sidewalk + WALK.routeClear };
  });
  // A broadphase so the many samples far from the race line cost one grid lookup, not a route projection.
  const lineGrid = SpatialGrid.forBounds(g.bounds.minX - 60, g.bounds.minZ - 60, g.bounds.maxX + 60, g.bounds.maxZ + 60, 32);
  const lineNear: number[] = [];
  const maxHalf = Math.max(...route.segWidth) / 2 + WALK.routeClear + 8;
  route.points.forEach((p, i) => {
    if (i + 1 < route.points.length) lineGrid.insertSegment(i, p.x, p.z, route.points[i + 1].x, route.points[i + 1].z, maxHalf);
  });
  for (const a of alleys) {
    for (let i = 0; i + 1 < a.points.length; i++) lineGrid.insertSegment(0, a.points[i].x, a.points[i].z, a.points[i + 1].x, a.points[i + 1].z, a.half + 8);
  }
  const onRaceLine = (x: number, z: number): boolean => {
    const rp = world.routeProgress(x, z);
    const beyondEnds = !route.closed && (rp.s < 0.5 || rp.s > route.length - 0.5);
    // The true distance to the projected route point: `lateral` alone is only the offset across the segment's line, small for a point far along it.
    const q = routeSample(route, rp.s);
    if (!beyondEnds && Math.hypot(x - q.x, z - q.z) < route.segWidth[rp.seg] / 2 + WALK.routeClear) return true;
    for (const a of alleys) {
      for (let i = 0; i + 1 < a.points.length; i++) if (distToSegment(x, z, a.points[i].x, a.points[i].z, a.points[i + 1].x, a.points[i + 1].z) < a.half) return true;
    }
    return false;
  };

  for (const e of g.edges) {
    if (e.shortcut || e.bridge || isChannelEdge(e) || isMouthEdge(e) || isFeatureEdge(e) || e.sidewalk < WALK.minSidewalk || e.length < WALK.minLength) continue;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const dx = (B.x - A.x) / e.length;
    const dz = (B.z - A.z) / e.length;
    // The P side's normal; side +1 is that side, -1 the other.
    const nx = -dz;
    const nz = dx;
    const m = world.blocks.mouths[e.id];
    const half = e.width / 2;
    const hs = Math.floor((e.sidewalk / 2 - WALK.edgeMargin) / WALK.lane);
    if (hs < 0) continue;
    const S = 2 * hs + 1;

    for (const side of [1, -1]) {
      // The stretch between the junction corners on this side: inside both ends' curb and building corners.
      const alongAt = (pt: { x: number; z: number }) => (pt.x - A.x) * dx + (pt.z - A.z) * dz;
      const sideOf = (pt: { x: number; z: number }) => ((pt.x - A.x) * nx + (pt.z - A.z) * nz) * side;
      const endA = sideOf(m.aP.curb) > sideOf(m.aN.curb) ? m.aP : m.aN;
      const endB = sideOf(m.bP.curb) > sideOf(m.bN.curb) ? m.bP : m.bN;
      const ta = Math.max(alongAt(endA.curb), alongAt(endA.outer)) + WALK.endInset;
      const tb = Math.min(alongAt(endB.curb), alongAt(endB.outer)) - WALK.endInset;
      if (tb - ta < WALK.minLength) continue;
      const count = Math.floor((tb - ta) / WALK.step) + 1;
      const centre = half + e.sidewalk / 2;
      const px = (t: number, lane: number) => A.x + dx * t + nx * side * (centre + lane);
      const pz = (t: number, lane: number) => A.z + dz * t + nz * side * (centre + lane);

      // Which lanes are free at each sample.
      const free = new Uint8Array(count * S);
      const reach = hs * WALK.lane;
      for (let i = 0; i < count; i++) {
        const t = ta + i * WALK.step;
        const cx = px(t, 0);
        const cz = pz(t, 0);
        let blocked = !!blockedAt && blockedAt(cx, cz);
        for (const c of circles) if ((cx - c.x) ** 2 + (cz - c.z) ** 2 < c.r2) blocked = true;
        for (const gate of gates) if ((cx - gate.position.x) ** 2 + (cz - gate.position.z) ** 2 < WALK.gateClear ** 2) blocked = true;
        if (blocked) continue;
        // Near the race line or an alley of it (a broadphase), then checked lane by lane.
        const nearRaceLine = lineGrid.query(cx, cz, cx, cz, lineNear).length > 0;
        // Road under the curb side of the width (a bus bay's cut) or water: probed there, the lanes one by one only where it shows.
        const odd = (x: number, z: number): boolean => {
          const s = world.surfaceAt(x, z);
          return s === 'road' || s === 'water';
        };
        const surfaceAround = odd(px(t, -reach - 0.3), pz(t, -reach - 0.3));
        // Walls: one query for the whole width, the lanes one by one only where something is there.
        const wallsAround = world.collideCircle(cx, cz, reach + WALK.body, contacts) > 0;
        world.propGrid.query(cx - reach - 0.6, cz - reach - 0.6, cx + reach + 0.6, cz + reach + 0.6, near);
        for (let j = 0; j < S; j++) {
          const lane = (j - hs) * WALK.lane;
          const x = px(t, lane);
          const z = pz(t, lane);
          if (wallsAround && world.collideCircle(x, z, WALK.body, contacts) > 0) continue;
          // Road (a bus bay's cut) or water under the lane is no sidewalk.
          if (surfaceAround && odd(x, z)) continue;
          if (nearRaceLine && onRaceLine(x, z)) continue;
          let ok = true;
          for (const id of near) {
            if (covered.has(id)) continue;
            const p = world.props[id];
            if (p && (p.x - x) ** 2 + (p.z - z) ** 2 < (p.radius + WALK.propClear) ** 2) {
              ok = false;
              break;
            }
          }
          if (ok) free[i * S + j] = 1;
        }
      }

      // The best lane through each clear run, by a dynamic program with cheap small moves.
      const cost = new Float64Array(S);
      const next = new Float64Array(S);
      const back = new Int8Array(count * S);
      let runStart = -1;
      const finish = (end: number) => {
        // Backtrack from the cheapest lane at `end` (inclusive) to the run's start.
        let best = 0;
        for (let j = 1; j < S; j++) if (cost[j] < cost[best]) best = j;
        const lanes = new Int32Array(end - runStart + 1);
        let j = best;
        for (let i = end; i >= runStart; i--) {
          lanes[i - runStart] = j;
          j += back[i * S + j];
        }
        cut(lanes, runStart);
      };
      /** Simplify and emit the run of lanes starting at sample `from`, cutting it where it is too long or too bent for maxPts. */
      const cut = (lanes: Int32Array, from: number): void => {
        const n = lanes.length;
        if (n < 2) return;
        const lengthM = (n - 1) * WALK.step;
        if (lengthM > WALK.maxLength) {
          const mid = Math.floor(n / 2);
          cut(lanes.subarray(0, mid + 1), from);
          cut(lanes.subarray(mid), from + mid);
          return;
        }
        const keep = simplify(lanes, WALK.maxPts);
        if (keep.worst > WALK.tolerance * 1.5 && n > 8) {
          const mid = Math.floor(n / 2);
          cut(lanes.subarray(0, mid + 1), from);
          cut(lanes.subarray(mid), from + mid);
          return;
        }
        if (lengthM < WALK.minLength) return;
        const pts: number[] = [];
        const cum: number[] = [];
        let prevX = 0;
        let prevZ = 0;
        let acc = 0;
        for (const k of keep.indices) {
          const t = ta + (from + k) * WALK.step;
          const lane = (lanes[k] - hs) * WALK.lane;
          const x = px(t, lane);
          const z = pz(t, lane);
          if (pts.length) acc += Math.hypot(x - prevX, z - prevZ);
          pts.push(x, groundY(world, x, z), z);
          cum.push(acc);
          prevX = x;
          prevZ = z;
        }
        const mx = (pts[0] + pts[pts.length - 3]) / 2;
        const mz = (pts[2] + pts[pts.length - 1]) / 2;
        // The buildings are on the outer side (+lane). Room to step toward them from the path: the sidewalk's
        // half width less the lane, the body and the shader's keep-right; tightened by a wall probe.
        let room = Infinity;
        for (let q = 0; q < pts.length; q += 3) {
          const lane = (lanes[keep.indices[q / 3]] - hs) * WALK.lane;
          room = Math.min(room, e.sidewalk / 2 - lane - WALK.body - WALK.keepRightMax, wallRoom(world, pts[q], pts[q + 2], nx * side, nz * side));
        }
        out.push({ pts, cum, length: acc, cell: cellKey(mx, mz), weight: crowdedness(world, mx, mz), backX: nx * side, backZ: nz * side, backRoom: Math.max(0, room) });
      };

      for (let i = 0; i < count; i++) {
        let alive = false;
        for (let j = 0; j < S; j++) {
          if (!free[i * S + j]) {
            next[j] = Infinity;
            continue;
          }
          const stay = WALK.offCost * Math.abs(j - hs) * WALK.lane;
          if (runStart < 0) {
            next[j] = stay;
            back[i * S + j] = 0;
            alive = true;
            continue;
          }
          let best = Infinity;
          let bestD = 0;
          for (let d = -1; d <= 1; d++) {
            const q = j + d;
            if (q < 0 || q >= S) continue;
            const c = cost[q] + (d === 0 ? 0 : WALK.moveCost);
            if (c < best) {
              best = c;
              bestD = d;
            }
          }
          if (best === Infinity) {
            next[j] = Infinity;
            continue;
          }
          next[j] = best + stay;
          back[i * S + j] = bestD;
          alive = true;
        }
        if (!alive) {
          if (runStart >= 0 && i - 1 > runStart) finish(i - 1);
          runStart = -1;
          continue;
        }
        if (runStart < 0) runStart = i;
        cost.set(next);
      }
      if (runStart >= 0 && count - 1 > runStart) finish(count - 1);
    }
  }
  return out;
}

/**
 * The lane indices' simplification: indices of the samples to keep (always the
 * first and last), added greedily where the lane strays furthest from the
 * chord until the error is small or `max` points are kept.
 */
function simplify(lanes: Int32Array, max: number): { indices: number[]; worst: number } {
  const n = lanes.length;
  const keep = [0, n - 1];
  let worst = 0;
  for (;;) {
    worst = 0;
    let at = -1;
    let seg = 0;
    for (let s = 0; s + 1 < keep.length; s++) {
      const a = keep[s];
      const b = keep[s + 1];
      for (let i = a + 1; i < b; i++) {
        const chord = lanes[a] + ((lanes[b] - lanes[a]) * (i - a)) / (b - a);
        const err = Math.abs(lanes[i] - chord) * WALK.lane;
        if (err > worst) {
          worst = err;
          at = i;
          seg = s;
        }
      }
    }
    if (at < 0 || worst <= WALK.tolerance || keep.length >= max) break;
    keep.splice(seg + 1, 0, at);
  }
  return { indices: keep, worst };
}

/** How many walkers a street wants against a quiet one: more downtown and nearer the route (the race is where the camera is). */
function crowdedness(world: World, x: number, z: number): number {
  const downtown = downtownFactor(world.graph.plan, x, z);
  const rp = world.routeProgress(x, z);
  const nearRoute = 1 - smoothstep(WALK.routeNear, WALK.routeFar, Math.abs(rp.lateral));
  return 1 + WALK.downtownBoost * downtown + WALK.routeBoost * nearRoute;
}

// ---------------------------------------------------------------------------
// The twin of the shader
// ---------------------------------------------------------------------------

/** Where a walker is, and which way it faces, at a time: written by `walkerAt`. */
export interface WalkerPose {
  x: number;
  z: number;
  /** Heading (three.js yaw, rad): forward is (sin, cos). */
  yaw: number;
}

/** GLSL's fract. */
const frac = (v: number): number => v - Math.floor(v);

/** Scratch for the corner tangents. */
const tgX = [0, 0, 0, 0];
const tgZ = [0, 0, 0, 0];

/**
 * The TypeScript twin of the walker shader's position (WALK_POSE in render/people/walkers.ts), line by line:
 * the cycle is one leg along the path at `speed`, a pause of 0.8 + 2.2 * fract(style * 7.31) s turning round,
 * the leg back and a pause; `t + phase * cycle` picks the moment. The polyline gives the point, the heading
 * is the segment's tangent smoothed over 0.7 m either side of each corner, flipped by the turn, and the
 * walker keeps 0.2 + 0.12 * fract(style * 5.3) m to the right of the way it is walking. Writes the position
 * (x, z, m, absolute) and the heading into `out`. The sim collides with what this says, so keep it the shader's twin.
 */
export function walkerAt(walk: { pts: readonly number[]; length: number; speed: number; phase: number; style: number }, t: number, out: WalkerPose): void {
  const pts = walk.pts;
  const count = pts.length / 4;
  const segs = count - 1;
  const len = walk.length;
  const leg = len / walk.speed;
  const pause = 0.8 + 2.2 * frac(walk.style * 7.31);
  const cycle = 2 * (leg + pause);
  const tt = t + walk.phase * cycle;
  const wT = tt - Math.floor(tt / cycle) * cycle;
  let u = 0;
  let turn = 0;
  if (wT < leg) {
    u = wT * walk.speed;
  } else if (wT < leg + pause) {
    u = len;
    turn = smoothstep(0.1, 0.55, (wT - leg) / pause);
  } else if (wT < 2 * leg + pause) {
    u = len - (wT - leg - pause) * walk.speed;
    turn = 1;
  } else {
    turn = 1 - smoothstep(0.1, 0.55, (wT - 2 * leg - pause) / pause);
  }
  // Point k of the shader's padded path (the last repeated); absolute here where the shader's are relative to the first.
  const at = (k: number, o: number): number => pts[Math.min(k, segs) * 4 + o];
  const cum = (k: number): number => at(k, 3);
  let si = 0;
  if (u > cum(1)) si = 1;
  if (u > cum(2)) si = 2;
  if (u > cum(3)) si = 3;
  const aW = cum(si);
  const bW = cum(si + 1);
  const f = clamp((u - aW) / Math.max(bW - aW, 1e-4), 0, 1);
  let px = at(si, 0) + (at(si + 1, 0) - at(si, 0)) * f;
  let pz = at(si, 2) + (at(si + 1, 2) - at(si, 2)) * f;
  let lastX = 0;
  let lastZ = 1;
  for (let k = 0; k < 4; k++) {
    const dx = at(k + 1, 0) - at(k, 0);
    const dz = at(k + 1, 2) - at(k, 2);
    if (dx * dx + dz * dz > 1e-6) {
      const l = sqrt(dx * dx + dz * dz);
      lastX = dx / l;
      lastZ = dz / l;
    }
    tgX[k] = lastX;
    tgZ[k] = lastZ;
  }
  const t0x = tgX[si];
  const t0z = tgZ[si];
  const tpx = si > 0 ? tgX[si - 1] : t0x;
  const tpz = si > 0 ? tgZ[si - 1] : t0z;
  const tnx = si < segs - 1 ? tgX[si + 1] : t0x;
  const tnz = si < segs - 1 ? tgZ[si + 1] : t0z;
  const wp = 0.5 * (1 - clamp((u - aW) / 0.7, 0, 1));
  const wn = 0.5 * (1 - clamp((bW - u) / 0.7, 0, 1));
  let dirX = t0x + (tpx - t0x) * wp + (tnx - t0x) * wn + 1e-5;
  let dirZ = t0z + (tpz - t0z) * wp + (tnz - t0z) * wn + 1e-5;
  const dl = sqrt(dirX * dirX + dirZ * dirZ);
  dirX /= dl;
  dirZ /= dl;
  const yaw = atan2(dirX, dirZ) + 3.14159 * turn;
  const lane = 0.2 + 0.12 * frac(walk.style * 5.3);
  const flip = 1 - 2 * turn;
  px += -dirZ * flip * lane;
  pz += dirX * flip * lane;
  out.x = px;
  out.z = pz;
  out.yaw = yaw;
}
