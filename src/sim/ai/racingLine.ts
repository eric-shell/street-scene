/**
 * The race's shared racing line and the geometry every line shares. A RacingLine is a sampled path (AI.spacing
 * m apart) hung off a reference polyline by lateral offsets, with the road's bounds either side and a target
 * speed per sample. buildRacingLine smooths the route's centerline within the road (narrowed past lane
 * closures); speedProfile turns any line into corner speeds and braking points; bendAt, turnAhead and
 * nearestIdx read a line while a car drives it. Rival lines (driverLine.ts) are the same shape.
 */
import type { World } from '../../city/world';
import { routeSample } from '../../city/route';
import { laneClosures } from '../../city/districts/roadworks';
import { undergroundClosures } from '../../city/districts/underground';
import { abs, clamp, sqrt, wrapIndex } from '../math';
import { GRAVITY } from '../tuning';
import { AI } from './drivers';

export interface RacingLine {
  n: number;
  closed: boolean;
  x: Float64Array;
  z: Float64Array;
  /** Route s of the sample's centerline point (a detour: m along it). */
  s: Float64Array;
  /** Reference point of the sample, which offsets hang off: the centerline (the shared line), the sweep frame's rounded reference (a driver's line), the path itself (a detour). */
  cx: Float64Array;
  cz: Float64Array;
  /** Unit left normal of the reference. */
  nx: Float64Array;
  nz: Float64Array;
  /** Max lateral offset allowed from the reference either way (to stay in the road). */
  room: Float64Array;
  /** Offset bounds from the reference (m): the road's, narrowed on the closed side past a lane closure. */
  lo: Float64Array;
  hi: Float64Array;
  /** Lateral offset of the line from the reference. */
  offset: Float64Array;
  speed: Float64Array;
}

export function buildRacingLine(world: World): RacingLine {
  const route = world.route;
  const n = Math.max(8, Math.floor(route.length / AI.spacing) + (route.closed ? 0 : 1));
  const step = route.length / (route.closed ? n : n - 1);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  const s = new Float64Array(n);
  const room = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const si = i * step;
    const p = routeSample(route, si);
    cx[i] = p.x;
    cz[i] = p.z;
    s[i] = si;
    room[i] = route.segWidth[p.seg] / 2 - AI.edgeMargin;
  }
  const { nx, nz } = lineNormals(cx, cz, route.closed);
  // Corners: the road is narrower in the polyline sense right at a node; use min of neighbors.
  const roomMin = Float64Array.from(room);
  for (let i = 0; i < n; i++) {
    for (let k = -2; k <= 2; k++) {
      const j = wrapIndex(i + k, n, route.closed);
      roomMin[i] = Math.min(roomMin[i], room[j]);
    }
  }
  // Lane closures (roadworks, and the Underground's kickers and bus on its trench floor) take the closed side's room away along their stretch.
  const lo = roomMin.map((v) => -v);
  const hi = Float64Array.from(roomMin);
  for (const c of [...laneClosures(world.areas ?? [], world.graph), ...undergroundClosures(world.areas ?? [])]) {
    for (let i = 0; i < n; i++) {
      const rx = cx[i] - c.ax;
      const rz = cz[i] - c.az;
      const along = rx * c.dx + rz * c.dz;
      const lat = rx * c.nx + rz * c.nz;
      // On that street's carriageway, within the stretch; the line's normal says which offset side is closed.
      if (along < c.s0 || along > c.s1 || abs(lat) > c.half) continue;
      const dot = c.nx * nx[i] + c.nz * nz[i];
      if (dot > 0.7) hi[i] = Math.min(hi[i], c.keep);
      else if (dot < -0.7) lo[i] = Math.max(lo[i], -c.keep);
    }
  }
  // Relax toward a smooth line, constrained to the road.
  const off = new Float64Array(n);
  const px = Float64Array.from(cx);
  const pz = Float64Array.from(cz);
  for (let it = 0; it < AI.smoothIterations; it++) {
    for (let i = 0; i < n; i++) {
      if (!route.closed && (i === 0 || i === n - 1)) continue;
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const mx = (px[a] + px[b]) / 2;
      const mz = (pz[a] + pz[b]) / 2;
      const o = clamp((mx - cx[i]) * nx[i] + (mz - cz[i]) * nz[i], lo[i], hi[i]);
      off[i] = o;
      px[i] = cx[i] + nx[i] * o;
      pz[i] = cz[i] + nz[i] * o;
    }
  }
  const speed = speedProfile(n, route.closed, px, pz, AI.lateralGrip, AI.brakeDecel);
  return { n, closed: route.closed, x: px, z: pz, s, cx, cz, nx, nz, room: roomMin, lo, hi, offset: off, speed };
}

/** Unit normals (to the left) of a polyline from each sample's neighbours, so they turn smoothly across a corner. */
export function lineNormals(x: Float64Array, z: Float64Array, closed: boolean): { nx: Float64Array; nz: Float64Array } {
  const n = x.length;
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrapIndex(i - 1, n, closed);
    const b = wrapIndex(i + 1, n, closed);
    const dx = x[b] - x[a];
    const dz = z[b] - z[a];
    const l = sqrt(dx * dx + dz * dz) || 1;
    nx[i] = dz / l;
    nz[i] = -dx / l;
  }
  return { nx, nz };
}

/** Target speeds from the line's curvature at `grip` (g), then a backward braking pass at `decel` (m/s^2). */
export function speedProfile(n: number, closed: boolean, px: Float64Array, pz: Float64Array, grip: number, decel: number): Float64Array {
  const speed = new Float64Array(n);
  const span = 3;
  for (let i = 0; i < n; i++) {
    const a = wrapIndex(i - span, n, closed);
    const b = wrapIndex(i + span, n, closed);
    const k = curvature(px[a], pz[a], px[i], pz[i], px[b], pz[b]);
    speed[i] = k > 1e-5 ? Math.min(AI.maxSpeed, sqrt((grip * GRAVITY) / k)) : AI.maxSpeed;
  }
  const passes = closed ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = n - 2 + (closed ? 1 : 0); i >= 0; i--) {
      const nextI = (i + 1) % n;
      const ds = AI.spacing;
      speed[i] = Math.min(speed[i], sqrt(speed[nextI] * speed[nextI] + 2 * decel * ds));
    }
  }
  return speed;
}

export function curvature(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const bcx = cx - bx;
  const bcz = cz - bz;
  const cross = abs(abx * bcz - abz * bcx);
  const la = sqrt(abx * abx + abz * abz);
  const lb = sqrt(bcx * bcx + bcz * bcz);
  const lc = sqrt((cx - ax) ** 2 + (cz - az) ** 2);
  const den = la * lb * lc;
  return den > 1e-9 ? (2 * cross) / den : 0;
}

/** Signed curvature of the line at sample i (1/m), positive bending left. */
export function bendAt(line: RacingLine, i: number): number {
  const a = wrapIndex(i - 3, line.n, line.closed);
  const b = wrapIndex(i + 3, line.n, line.closed);
  const k = curvature(line.x[a], line.z[a], line.x[i], line.z[i], line.x[b], line.z[b]);
  // Left of a heading (fx, fz) is (fz, -fx): the second chord on the left of the first bends left.
  const turn = (line.x[b] - line.x[i]) * (line.z[i] - line.z[a]) - (line.z[b] - line.z[i]) * (line.x[i] - line.x[a]);
  return turn > 0 ? k : -k;
}

/** Sine of the line's heading change from sample i over the next `k` samples, positive turning left. */
export function turnAhead(line: RacingLine, i: number, k: number): number {
  const a = wrapIndex(i + 1, line.n, line.closed);
  const b = wrapIndex(i + k, line.n, line.closed);
  const c = wrapIndex(i + k + 1, line.n, line.closed);
  const ax = line.x[a] - line.x[i];
  const az = line.z[a] - line.z[i];
  const bx = line.x[c] - line.x[b];
  const bz = line.z[c] - line.z[b];
  const l = sqrt((ax * ax + az * az) * (bx * bx + bz * bz));
  return l > 1e-9 ? (bx * az - bz * ax) / l : 0;
}

/**
 * The line sample nearest the car: around `hint`, or over the whole line with none. Where the route
 * stacks two levels (a start on a bridge deck with the lap's channel leg right beneath it) the nearest
 * sample in plan can be the wrong level, so with the car's route distance `sRef` known only the samples
 * within AI.seedWindow m of it along the route count, the whole line if none is that close.
 */
export function nearestIdx(line: RacingLine, x: number, z: number, hint: number, sRef = NaN): number {
  let best = 0;
  let bestD = Infinity;
  if (hint < 0) {
    const L = line.closed && line.n > 1 ? line.s[line.n - 1] + line.s[1] - line.s[0] : Infinity;
    for (let pass = Number.isNaN(sRef) ? 1 : 0; pass < 2 && bestD === Infinity; pass++) {
      for (let i = 0; i < line.n; i++) {
        if (pass === 0) {
          let ds = line.s[i] - sRef;
          if (line.closed) {
            ds = ((ds % L) + L) % L;
            if (ds > L / 2) ds -= L;
          }
          if (Math.abs(ds) > AI.seedWindow) continue;
        }
        const d = (line.x[i] - x) ** 2 + (line.z[i] - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best;
  }
  for (let k = -6; k <= 14; k++) {
    const i = wrapIndex(hint + k, line.n, line.closed);
    const d = (line.x[i] - x) ** 2 + (line.z[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
