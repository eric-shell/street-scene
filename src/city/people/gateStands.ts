/**
 * The start / finish sidewalk stands as a pure plan: rows of people lining the outer edge of the route's own
 * road within BACK..FWD of a gate, facing the road and turned a little toward the line, in runs of friends that
 * share a group phase. A copy of the placer in render/race/crowds.ts (which keeps drawing its own until the
 * renderer reads the plan from `peopleOf`), written against the pure `PeopleGate` so the sim can collide with the
 * same people the stands draw. The meets stand behind the barriers and rails, never here. Reads World.
 */
import type { World } from '../world';
import { CITY } from '../config';
import { routeSample } from '../route';
import { distToSegment } from '../../sim/math';
import type { Rng } from '../../sim/prng';
import type { PeopleGate } from './gates';
import { BACK, FWD, groundY, thin } from './placer';
import type { Placer } from './placer';

/** Gate stands are thinned to this many people at density 1. */
export const GATE_CAP = 1100;

export interface GateSpot {
  x: number;
  y: number;
  z: number;
  /** Facing (three.js yaw): local +z toward the road. */
  yaw: number;
  /** Signed route distance from the gate line (0 for sections). */
  ds: number;
  /** Audio stand of the gate: 0 left of the road, 1 right. */
  side: 0 | 1;
  /** Sidewalk row, 0 at the front (the wall's side of the curb). */
  row: number;
  /** 0..1, shared by a run of 2 to 5 neighbours along a row (friends). */
  groupPhase: number;
}

/**
 * The start / finish crowd: sidewalk rows along the route near the line (the meets stand behind its barriers).
 * The people plan's copy of render/race/crowds.ts's placeGate (that one still draws the stands until the renderer
 * switches to the plan); it also numbers each person's row and group phase.
 */
export function placeGate(world: World, gate: PeopleGate, rng: Rng, density: number, rows: number, placer: Placer): GateSpot[] {
  const route = world.route;
  const L = route.length;
  const wrap = (d: number) => (route.closed ? ((((d + L / 2) % L) + L) % L) - L / 2 : d);
  const cy = Math.cos(gate.yaw);
  const sy = Math.sin(gate.yaw);
  const out: GateSpot[] = [];
  // Route distance, continued past the ends of a sprint route (routeProgress clamps there).
  const p0 = route.points[0];
  const p1 = route.points[route.points.length - 1];
  const t0 = routeSample(route, 0);
  const t1 = routeSample(route, L);
  const routeS = (x: number, z: number, s: number) => {
    if (route.closed) return s;
    if (s < 0.5) return Math.min(s, (x - p0.x) * t0.tx + (z - p0.z) * t0.tz);
    if (s > L - 0.5) return Math.max(s, L + (x - p1.x) * t1.tx + (z - p1.z) * t1.tz);
    return s;
  };

  const tryPlace = (x: number, z: number, nx: number, nz: number, sidewalkRow: boolean, row: number, groupPhase: number) => {
    const rp = world.routeProgress(x, z);
    const ds = wrap(routeS(x, z, rp.s) - gate.s);
    if (ds < -BACK || ds > FWD) return;
    if (sidewalkRow && world.surfaceAt(x, z) !== 'sidewalk') return;
    // Clear of the gantry pillars and the firework racks beside them.
    const lx = (x - gate.position.x) * cy - (z - gate.position.z) * sy;
    const lz = (x - gate.position.x) * sy + (z - gate.position.z) * cy;
    if (Math.abs(lz) < 2.2 && Math.abs(lx) > gate.halfSpan - 1.4 && Math.abs(lx) < gate.halfSpan + 2.2) return;
    if (!placer.ok(x, z)) return;
    placer.take(x, z);
    // Face the road, turned a little toward the line, with some personality.
    const gx = gate.position.x - x;
    const gz = gate.position.z - z;
    const gl = Math.hypot(gx, gz) || 1;
    const fx = nx + (gx / gl) * 0.35;
    const fz = nz + (gz / gl) * 0.35;
    const yaw = Math.atan2(fx, fz) + rng.range(-0.3, 0.3);
    out.push({ x, y: groundY(world, x, z), z, yaw, ds, side: rp.lateral >= 0 ? 0 : 1, row, groupPhase });
  };

  const spacing = 0.7 / Math.max(0.2, density);
  const sidewalkRows = [0.38, 0.98, 1.58].slice(0, Math.max(1, Math.min(3, rows)));
  for (const w of world.walls) {
    if (distToSegment(gate.position.x, gate.position.z, w.ax, w.az, w.bx, w.bz) > BACK + 30) continue;
    const mx = (w.ax + w.bx) / 2;
    const mz = (w.az + w.bz) / 2;
    const rp = world.routeProgress(mx, mz);
    const ds = wrap(routeS(mx, mz, rp.s) - gate.s);
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    if (ds < -BACK - len || ds > FWD + len) continue;
    const half = route.segWidth[rp.seg] / 2;
    let depths: number[];
    let sidewalk = false;
    if (w.kind === 'wall') {
      // The outer sidewalk line of the route's own road, facing it: people stand on the sidewalk in front of it.
      if (Math.abs(Math.abs(rp.lateral) - (half + CITY.sidewalk)) > 1.3) continue;
      const lside = rp.lateral >= 0 ? 1 : -1;
      // Toward the road = minus the side's left vector.
      if (-(w.nx * rp.tz - w.nz * rp.tx) * lside < 0.8) continue;
      depths = sidewalkRows.map((d) => -d);
      sidewalk = true;
    } else continue; // Behind the barriers and rails near the line stands the street meet (meetPlan.ts).
    const dx = (w.bx - w.ax) / (len || 1);
    const dz = (w.bz - w.az) / (len || 1);
    depths.forEach((depth, row) => {
      // Friends: runs of 2 to 5 neighbours along the row share a group phase.
      let runLeft = 0;
      let phase = 0;
      for (let u = rng.range(0, spacing) + (row % 2) * spacing * 0.5; u < len; u += spacing * rng.range(0.85, 1.2)) {
        // Small gaps between groups of friends.
        if (rng.next() < 0.1) continue;
        if (runLeft <= 0) {
          runLeft = rng.int(2, 5);
          phase = rng.next();
        }
        runLeft--;
        const along = u + rng.range(-0.1, 0.1);
        const back = depth + rng.range(-0.08, 0.08);
        tryPlace(w.ax + dx * along - w.nx * back, w.az + dz * along - w.nz * back, w.nx, w.nz, sidewalk, row, phase);
      }
    });
  }
  // Keep phones happy on busy corners: thin evenly down to the cap.
  return thin(out, Math.round(GATE_CAP * Math.max(0.2, density)));
}
