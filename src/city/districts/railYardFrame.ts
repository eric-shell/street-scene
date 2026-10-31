/**
 * The rail yard's frames and the little algebra (world <-> local) everything else is placed with. Pure.
 *
 *  - YardFrame: the whole region in the race's travel frame. `t` runs along the spine's chord from the end the race
 *    enters at (railYard.ts reads the direction off the planned routes, raceDirection), `w` across it from the spine's
 *    axis, positive toward the yard's deeper side (P: the receiving tracks and the hump), negative toward the other (N:
 *    the departure yard, the dock, the transfer pad, the turnaround road). Writing the layout in t keeps the hump's
 *    run-up and the kicker ahead of their landings whichever way the region's path runs.
 *  - YardRect: an oriented rectangle (origin corner, unit u, unit v, length, depth), for the height modifiers that are
 *    boxes in their own frame (the dock).
 */
import type { Vec2 } from '../../sim/math';

/** The region's travel frame: origin on the spine's axis at the race's entry end, unit t along the travel, unit w toward side P. */
export interface YardFrame {
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  wx: number;
  wz: number;
  /** The spine's chord, entry junction to exit junction (m). */
  L: number;
  /** 1 when the race runs the region's path forward (entry to exit), -1 when it runs it back. */
  dir: 1 | -1;
}

/** World point at travel position t, offset w. */
export const framePoint = (f: YardFrame, t: number, w: number): Vec2 => ({ x: f.ox + f.tx * t + f.wx * w, z: f.oz + f.tz * t + f.wz * w });
export const frameT = (f: YardFrame, x: number, z: number): number => (x - f.ox) * f.tx + (z - f.oz) * f.tz;
export const frameW = (f: YardFrame, x: number, z: number): number => (x - f.ox) * f.wx + (z - f.oz) * f.wz;

/** The box [t0, t1] x [w0, w1] of the frame as a world polygon (the same winding for every call). */
export function frameBox(f: YardFrame, t0: number, t1: number, w0: number, w1: number): Vec2[] {
  return [framePoint(f, t0, w0), framePoint(f, t1, w0), framePoint(f, t1, w1), framePoint(f, t0, w1)];
}

/** An oriented rectangle: origin corner, unit u along it, unit v across it. */
export interface YardRect {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  /** Length along u and depth along v (m). */
  L: number;
  D: number;
}

export const rectPoint = (r: YardRect, u: number, v: number): Vec2 => ({ x: r.ox + r.ux * u + r.vx * v, z: r.oz + r.uz * u + r.vz * v });

export const rectU = (r: YardRect, x: number, z: number): number => (x - r.ox) * r.ux + (z - r.oz) * r.uz;
export const rectV = (r: YardRect, x: number, z: number): number => (x - r.ox) * r.vx + (z - r.oz) * r.vz;

/** An oriented box of length `len` (along unit a) and width `wid` centred on c, as a polygon. */
export function orientedBox(c: Vec2, ax: number, az: number, len: number, wid: number): Vec2[] {
  const hx = (ax * len) / 2;
  const hz = (az * len) / 2;
  const sx = (-az * wid) / 2;
  const sz = (ax * wid) / 2;
  return [
    { x: c.x - hx - sx, z: c.z - hz - sz },
    { x: c.x + hx - sx, z: c.z + hz - sz },
    { x: c.x + hx + sx, z: c.z + hz + sz },
    { x: c.x - hx + sx, z: c.z - hz + sz },
  ];
}

