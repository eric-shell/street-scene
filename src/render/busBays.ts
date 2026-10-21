/**
 * Bus bays as cityMeshes draws them (the sim side is city/busBays.ts): the
 * bay's asphalt, the block side's sidewalk with its curb stepping back along
 * the bay (S tapers, the curb face following it), and the paint: BUS across
 * the bay for the traffic pulling in, a yellow bus zone curb, and the lane's
 * edge line broken into dashes across the bay's mouth. Everything goes into
 * the city's existing merged builders (asphalt, sidewalks, markings), so bays
 * cost no draw calls; they are a few hundred triangles each, built once.
 * Render only.
 */
import * as THREE from 'three';
import type { BusBay } from '../city/busBays';
import { bayCurbStations, bayInset, bayPoint } from '../city/busBays';
import { CITY } from '../city/config';
import type { Vec2 } from '../sim/math';
import type { GeoBuilder } from './geoBuilder';

/** What the bay drawing borrows from cityMeshes. */
export interface BayDraw {
  /** A draped ground vertex at (x, z), `lift` above the terrain, UVs x / uvScale, z / uvScale. */
  ground(gb: GeoBuilder, x: number, z: number, lift: number, uvScale: number): number;
  /** Terrain height and unit normal. */
  h(x: number, z: number): number;
  normalAt(x: number, z: number): [number, number, number];
  /** A curb face from p to q (cityMeshes curbFace) into the sidewalk builder. */
  curbFace(p: Vec2, q: Vec2, steps?: number): void;
}

const PAINT = {
  /** Lift of the paint over the road (m, the markings' lift) and of the curb paint over the curb top. */
  lift: 0.045,
  curbLift: 0.012,
  /** BUS: letter width across, length along the lane, gap (m); stroke width across (m). */
  letterW: 0.72,
  letterL: 2.6,
  gap: 0.22,
  /** Lateral room kept from the back curb (m) and how far the text reaches out past the old curb line (m). */
  backClear: 0.3,
  out: 0.55,
  /** Yellow curb: strip width on the curb top (m). */
  curbStrip: 0.2,
  /** Dashes across the bay's mouth: dash and gap (m). */
  dash: 1.2,
} as const;

const WHITE = new THREE.Color(0xd8dce6);
const YELLOW = new THREE.Color(0xf2b632);

/** Block letters as rectangles in a unit cell (x across left to right, y along from near to far). */
const GLYPHS: Record<'B' | 'U' | 'S', [number, number, number, number][]> = {
  B: [
    [0, 0, 0.24, 1],
    [0, 0.88, 0.8, 1],
    [0, 0.45, 0.8, 0.56],
    [0, 0, 0.84, 0.12],
    [0.74, 0.56, 0.98, 0.9],
    [0.76, 0.1, 1, 0.47],
  ],
  U: [
    [0, 0.08, 0.24, 1],
    [0.76, 0.08, 1, 1],
    [0, 0, 1, 0.12],
  ],
  S: [
    [0, 0.88, 1, 1],
    [0, 0.5, 0.24, 0.9],
    [0, 0.44, 1, 0.56],
    [0.76, 0.1, 1, 0.5],
    [0, 0, 1, 0.12],
  ],
};

/** Sample positions along the bay for asphalt and paint: its curb stations plus one every 3 m over the full depth stretch. */
function asphaltStations(bay: BusBay): number[] {
  const out = bayCurbStations(bay);
  const a = bay.s0 + bay.taper;
  const b = bay.s1 - bay.taper;
  const n = Math.max(1, Math.ceil((b - a) / 3));
  for (let i = 1; i < n; i++) out.push(a + ((b - a) * i) / n);
  return out.sort((p, q) => p - q);
}

/** The bay's asphalt: from just over the old curb line (it overlaps the road strip a little: no slit) back to the indented curb. */
export function drawBayAsphalt(bay: BusBay, road: GeoBuilder, d: BayDraw, roadY: number): void {
  const st = asphaltStations(bay);
  let prevA = -1;
  let prevB = -1;
  for (let i = 0; i < st.length; i++) {
    const p = bayPoint(bay, st[i], -0.05);
    const q = bayPoint(bay, st[i], bayInset(bay, st[i]) + 0.02);
    const a = d.ground(road, p.x, p.z, roadY, 10);
    const b = d.ground(road, q.x, q.z, roadY, 10);
    if (i > 0) road.quadFacing(prevA, prevB, b, a, 0, 1, 0);
    prevA = a;
    prevB = b;
  }
}

/**
 * The block side's sidewalk with the bay cut out of it, in place of the
 * plain strip: curb and building lines interpolated by the same parameter as
 * the plain strip (so the ends meet the junction corners exactly), the curb
 * line pushed back by the bay's inset, and the curb face along it.
 */
export function drawBaySidewalk(bay: BusBay, walk: GeoBuilder, d: BayDraw, curbA: Vec2, curbB: Vec2, outerA: Vec2, outerB: Vec2, steps: number): void {
  const ts: number[] = [];
  for (let i = 0; i <= steps; i++) ts.push(i / steps);
  for (const s of bayCurbStations(bay)) ts.push(s / bay.len);
  ts.sort((p, q) => p - q);
  const curbH = CITY.curbHeight;
  let prevC = -1;
  let prevO = -1;
  let prev: Vec2 | null = null;
  let last = -1;
  for (const t of ts) {
    if (t - last < 1e-6) continue;
    last = t;
    const inset = bayInset(bay, t * bay.len);
    const c = { x: curbA.x + (curbB.x - curbA.x) * t - bay.inward.x * inset, z: curbA.z + (curbB.z - curbA.z) * t - bay.inward.z * inset };
    const o = { x: outerA.x + (outerB.x - outerA.x) * t, z: outerA.z + (outerB.z - outerA.z) * t };
    const vc = d.ground(walk, c.x, c.z, curbH, 4);
    const vo = d.ground(walk, o.x, o.z, curbH, 4);
    if (prev) {
      walk.quadFacing(prevC, vc, vo, prevO, 0, 1, 0);
      d.curbFace(prev, c, 1);
    }
    prevC = vc;
    prevO = vo;
    prev = c;
  }
}

/** Positions (m along the lane line a -> b) of the bay's two ends, for breaking the edge line into dashes there. */
export function bayMouth(bay: BusBay, a: Vec2, dx: number, dz: number): [number, number] {
  const p = bayPoint(bay, bay.s0, 0);
  const q = bayPoint(bay, bay.s1, 0);
  const sp = (p.x - a.x) * dx + (p.z - a.z) * dz;
  const sq = (q.x - a.x) * dx + (q.z - a.z) * dz;
  return sp < sq ? [sp, sq] : [sq, sp];
}

/** Dash length and gap of the broken edge line across a bay's mouth. */
export const BAY_DASH = PAINT.dash;

/** BUS across the bay for the traffic pulling in, and the yellow bus zone along the indented curb. */
export function drawBayPaint(bay: BusBay, marks: GeoBuilder, d: BayDraw): void {
  // Right hand traffic: the P side (side 1, left of a -> b) carries b -> a, against the curb's direction.
  const fx = bay.u.x * -bay.side;
  const fz = bay.u.z * -bay.side;
  // The driver's right (streetDecals' convention for text that reads to a driver facing f).
  const rx = -fz;
  const rz = fx;
  const P = PAINT;
  const vBack = bay.depth - P.backClear;
  const vMid = (vBack - P.out) / 2;
  const center = bayPoint(bay, (bay.s0 + bay.s1) / 2, vMid);
  const word = 'BUS';
  const total = word.length * P.letterW + (word.length - 1) * P.gap;
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const ids = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ].map(([x, y]) => {
      const wx = center.x + rx * x + fx * y;
      const wz = center.z + rz * x + fz * y;
      const [nx, ny, nz] = d.normalAt(wx, wz);
      return marks.vertex(wx, d.h(wx, wz) + P.lift, wz, nx, ny, nz, 0, 0, WHITE);
    });
    marks.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
  };
  [...word].forEach((ch, k) => {
    const x0 = -total / 2 + k * (P.letterW + P.gap);
    for (const [a, b, c, e] of GLYPHS[ch as 'B' | 'U' | 'S']) rect(x0 + a * P.letterW, -P.letterL / 2 + b * P.letterL, x0 + c * P.letterW, -P.letterL / 2 + e * P.letterL);
  });
  // Yellow curb: a strip on the curb top and the face seen from the road, all along the indented curb.
  const st = asphaltStations(bay);
  const ch = CITY.curbHeight;
  for (let i = 0; i + 1 < st.length; i++) {
    const p = bayPoint(bay, st[i], bayInset(bay, st[i]));
    const q = bayPoint(bay, st[i + 1], bayInset(bay, st[i + 1]));
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 1e-3) continue;
    // Normal toward the road (bay) side of this piece of curb.
    let nx = -(q.z - p.z) / len;
    let nz = (q.x - p.x) / len;
    if (nx * bay.inward.x + nz * bay.inward.z < 0) {
      nx = -nx;
      nz = -nz;
    }
    const yp = d.h(p.x, p.z);
    const yq = d.h(q.x, q.z);
    const o = 0.015;
    const f0 = marks.vertex(p.x + nx * o, yp + 0.02, p.z + nz * o, nx, 0, nz, 0, 0, YELLOW);
    const f1 = marks.vertex(q.x + nx * o, yq + 0.02, q.z + nz * o, nx, 0, nz, 0, 0, YELLOW);
    const f2 = marks.vertex(q.x + nx * o, yq + ch + 0.005, q.z + nz * o, nx, 0, nz, 0, 0, YELLOW);
    const f3 = marks.vertex(p.x + nx * o, yp + ch + 0.005, p.z + nz * o, nx, 0, nz, 0, 0, YELLOW);
    marks.quadFacing(f0, f1, f2, f3, nx, 0, nz);
    const t0 = marks.vertex(p.x, yp + ch + P.curbLift, p.z, 0, 1, 0, 0, 0, YELLOW);
    const t1 = marks.vertex(q.x, yq + ch + P.curbLift, q.z, 0, 1, 0, 0, 0, YELLOW);
    const t2 = marks.vertex(q.x - nx * P.curbStrip, yq + ch + P.curbLift, q.z - nz * P.curbStrip, 0, 1, 0, 0, 0, YELLOW);
    const t3 = marks.vertex(p.x - nx * P.curbStrip, yp + ch + P.curbLift, p.z - nz * P.curbStrip, 0, 1, 0, 0, 0, YELLOW);
    marks.quadFacing(t0, t1, t2, t3, 0, 1, 0);
  }
}
