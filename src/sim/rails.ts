/**
 * Corner rails as heavy modular bodies.
 *
 * Every route corner rail (see src/city/routeRails.ts) is a chain of
 * pieces about 2.5 m long, each made of a few straight sub segments. A piece is
 * a very heavy sim body: when a car hits it, it is shoved back along the impact
 * normal by impulse / pieceMass * yieldTime (capped at maxOffset from its rest
 * pose, with a tiny rotation for off center hits) and stays there for the rest
 * of the race, so a wall rider leaves a dented, stepped rail behind for the
 * next lap. Neighbors are dragged along so the gap between two pieces never
 * exceeds maxGap (1/8 of a car width): their offsets differ by at most maxRel.
 *
 * Data model: RailLayout is the static part, built once per World (rest
 * geometry, chain neighbors, broadphase) and cached. RailState is per race
 * (RaceState.rails): offset (dx, dz) and rotation per piece plus the displaced
 * sub segments that collision reads. The broadphase holds every sub segment's
 * rest box padded by maxOffset, so it never needs updating. Deterministic:
 * fixed iteration order, sim math only.
 */
import type { Contact, World } from '../city/world';
import type { RailWall } from '../city/routeRails';
import type { Wall } from '../city/blocks';
import { SpatialGrid } from '../city/spatial';
import { abs, cos, segmentT, sign, sin, sqrt } from './math';

export const RAIL = {
  /** Effective mass of one piece (kg). Very heavy: a hard hit only nudges it. */
  pieceMass: 16000,
  /** Displacement per unit of velocity the impulse would give the piece (s): d = J / pieceMass * yieldTime. */
  yieldTime: 0.25,
  /** Impulses below this (N s) never move a piece. */
  minImpulse: 120,
  /** Max cumulative offset of a piece from its rest pose (m). */
  maxOffset: 0.6,
  /** Max rotation of a piece (rad), and rotation per meter an end hit pushes it. */
  maxRot: 0.02,
  rotPerMeter: 0.1,
  /** Max gap between neighboring pieces (m): 1/8 of the narrowest car width. */
  maxGap: 0.2,
} as const;

export interface RailLayout {
  /** Number of pieces and sub segments. */
  count: number;
  subCount: number;
  /** Per piece: first sub segment, sub segment count, chain neighbors (-1 at the rail ends), rail group. */
  first: Int32Array;
  subs: Int32Array;
  prev: Int32Array;
  next: Int32Array;
  group: Int32Array;
  /** Per piece rest pose: center, unit chord direction and half chord length. */
  cx: Float64Array;
  cz: Float64Array;
  tx: Float64Array;
  tz: Float64Array;
  half: Float64Array;
  /** Per sub segment at rest: ends and normal (toward the drivable side), owning piece, index in World.walls. */
  ax: Float64Array;
  az: Float64Array;
  bx: Float64Array;
  bz: Float64Array;
  nx: Float64Array;
  nz: Float64Array;
  piece: Int32Array;
  wall: Int32Array;
  /** Sub segments by index, rest boxes padded by maxOffset. */
  grid: SpatialGrid;
  /** Max offset difference between neighbors that keeps every gap within maxGap. */
  maxRel: number;
}

export interface RailState {
  layout: RailLayout;
  /** Per piece offset from the rest pose (m) and rotation about its rest center (rad, CCW in x/z). */
  dx: Float64Array;
  dz: Float64Array;
  rot: Float64Array;
  /** Displaced sub segments (what collision uses). */
  ax: Float64Array;
  az: Float64Array;
  bx: Float64Array;
  bz: Float64Array;
  nx: Float64Array;
  nz: Float64Array;
  /** Tick each piece last moved (-1 = never), for the renderer. */
  movedTick: Int32Array;
  /** Bumped whenever any piece moves. */
  version: number;
}

const layouts = new WeakMap<object, RailLayout>();

/** Static rail pieces of a world, built once and cached (worlds are never mutated). */
export function railLayout(world: World): RailLayout {
  const key = (world.walls ?? world) as object;
  let l = layouts.get(key);
  if (!l) {
    l = buildLayout(world.walls ?? []);
    layouts.set(key, l);
  }
  return l;
}

function buildLayout(walls: Wall[]): RailLayout {
  const ids: number[] = [];
  walls.forEach((w, i) => {
    if (w.kind === 'rail') ids.push(i);
  });
  const n = ids.length;
  const f64 = () => new Float64Array(n);
  const ax = f64();
  const az = f64();
  const bx = f64();
  const bz = f64();
  const nx = f64();
  const nz = f64();
  const piece = new Int32Array(n);
  const wall = Int32Array.from(ids);
  // Pieces: consecutive sub segments with the same (group, piece). Walls without a
  // piece id (hand made test worlds) are one piece each.
  const first: number[] = [];
  const subs: number[] = [];
  const group: number[] = [];
  let lastKey = '';
  ids.forEach((wi, k) => {
    const w = walls[wi] as Partial<RailWall> & Wall;
    ax[k] = w.ax;
    az[k] = w.az;
    bx[k] = w.bx;
    bz[k] = w.bz;
    nx[k] = w.nx;
    nz[k] = w.nz;
    const key = w.piece !== undefined ? `${w.group ?? -1}:${w.piece}` : `w${k}`;
    if (key !== lastKey) {
      first.push(k);
      subs.push(0);
      group.push(w.group ?? -1 - k);
      lastKey = key;
    }
    subs[subs.length - 1]++;
    piece[k] = first.length - 1;
  });
  const count = first.length;
  const prev = new Int32Array(count).fill(-1);
  const next = new Int32Array(count).fill(-1);
  const cx = new Float64Array(count);
  const cz = new Float64Array(count);
  const tx = new Float64Array(count);
  const tz = new Float64Array(count);
  const half = new Float64Array(count);
  let maxHalf = 0;
  for (let p = 0; p < count; p++) {
    const s0 = first[p];
    const s1 = s0 + subs[p] - 1;
    const ex = bx[s1] - ax[s0];
    const ez = bz[s1] - az[s0];
    const len = sqrt(ex * ex + ez * ez) || 1;
    tx[p] = ex / len;
    tz[p] = ez / len;
    cx[p] = (ax[s0] + bx[s1]) / 2;
    cz[p] = (az[s0] + bz[s1]) / 2;
    // Farthest sub segment end from the center (curved pieces bulge a little past the chord).
    let h = 0;
    for (let s = s0; s <= s1; s++) {
      h = Math.max(h, sqrt((ax[s] - cx[p]) ** 2 + (az[s] - cz[p]) ** 2), sqrt((bx[s] - cx[p]) ** 2 + (bz[s] - cz[p]) ** 2));
    }
    half[p] = h;
    maxHalf = Math.max(maxHalf, h);
    // Chain neighbors: same rail and touching ends.
    if (p > 0 && group[p - 1] === group[p]) {
      const q = first[p - 1] + subs[p - 1] - 1;
      if (abs(bx[q] - ax[s0]) < 1e-6 && abs(bz[q] - az[s0]) < 1e-6) {
        prev[p] = p - 1;
        next[p - 1] = p;
      }
    }
  }
  // Grid over the rails' own bounds.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    minX = Math.min(minX, ax[k], bx[k]);
    minZ = Math.min(minZ, az[k], bz[k]);
    maxX = Math.max(maxX, ax[k], bx[k]);
    maxZ = Math.max(maxZ, az[k], bz[k]);
  }
  const pad = 8;
  const grid = n ? SpatialGrid.forBounds(minX - pad, minZ - pad, maxX + pad, maxZ + pad, 16) : SpatialGrid.forBounds(0, 0, 1, 1, 16);
  for (let k = 0; k < n; k++) grid.insertSegment(k, ax[k], az[k], bx[k], bz[k], RAIL.maxOffset + maxHalf * RAIL.maxRot + 0.5);
  // Offsets of neighbors may differ by maxRel; each rotation moves an end by up to maxRot * half.
  const maxRel = Math.max(0.02, RAIL.maxGap - 2 * RAIL.maxRot * maxHalf - 0.005);
  return {
    count,
    subCount: n,
    first: Int32Array.from(first),
    subs: Int32Array.from(subs),
    prev,
    next,
    group: Int32Array.from(group),
    cx,
    cz,
    tx,
    tz,
    half,
    ax,
    az,
    bx,
    bz,
    nx,
    nz,
    piece,
    wall,
    grid,
    maxRel,
  };
}

/** Fresh rail state for a race: every piece at rest. */
export function createRailState(world: World): RailState {
  const layout = railLayout(world);
  const p = layout.count;
  return {
    layout,
    dx: new Float64Array(p),
    dz: new Float64Array(p),
    rot: new Float64Array(p),
    ax: Float64Array.from(layout.ax),
    az: Float64Array.from(layout.az),
    bx: Float64Array.from(layout.bx),
    bz: Float64Array.from(layout.bz),
    nx: Float64Array.from(layout.nx),
    nz: Float64Array.from(layout.nz),
    movedTick: new Int32Array(p).fill(-1),
    version: 0,
  };
}

const scratch: number[] = [];

/**
 * Circle against the displaced rail pieces, same rules as World.collideCircle
 * (one sided with a 3 m anti tunnelling band, radial push at segment ends).
 * Appends to `out` (and the owning piece of each contact to `pieces`); returns
 * the number added.
 */
export function collideRails(rs: RailState, x: number, z: number, r: number, out: Contact[], pieces: number[]): number {
  const l = rs.layout;
  if (!l.subCount) return 0;
  let added = 0;
  l.grid.query(x - r - 3, z - r - 3, x + r + 3, z + r + 3, scratch);
  for (const k of scratch) {
    const ax = rs.ax[k];
    const az = rs.az[k];
    const bx = rs.bx[k];
    const bz = rs.bz[k];
    const t = segmentT(x, z, ax, az, bx, bz);
    const cx = ax + (bx - ax) * t;
    const cz = az + (bz - az) * t;
    const dx = x - cx;
    const dz = z - cz;
    let nx = rs.nx[k];
    let nz = rs.nz[k];
    const sd = dx * nx + dz * nz;
    if (sd < -3 || sd >= r) continue;
    let depth = r - sd;
    if (t <= 0 || t >= 1) {
      const d = sqrt(dx * dx + dz * dz);
      if (d >= r) continue;
      if (sd > 0 && d > 1e-6) {
        nx = dx / d;
        nz = dz / d;
        depth = r - d;
      }
    }
    out.push({ nx, nz, depth, px: cx, pz: cz, kind: 'rail' });
    pieces.push(l.piece[k]);
    added++;
  }
  return added;
}

/** Recompute the displaced sub segments of one piece from its offset and rotation. */
function place(rs: RailState, p: number): void {
  const l = rs.layout;
  const c = cos(rs.rot[p]);
  const s = sin(rs.rot[p]);
  const ox = l.cx[p];
  const oz = l.cz[p];
  const dx = rs.dx[p];
  const dz = rs.dz[p];
  for (let k = l.first[p], end = k + l.subs[p]; k < end; k++) {
    const ax = l.ax[k] - ox;
    const az = l.az[k] - oz;
    const bx = l.bx[k] - ox;
    const bz = l.bz[k] - oz;
    rs.ax[k] = ox + ax * c - az * s + dx;
    rs.az[k] = oz + ax * s + az * c + dz;
    rs.bx[k] = ox + bx * c - bz * s + dx;
    rs.bz[k] = oz + bx * s + bz * c + dz;
    rs.nx[k] = l.nx[k] * c - l.nz[k] * s;
    rs.nz[k] = l.nx[k] * s + l.nz[k] * c;
  }
}

/** Drag piece q toward ref so their offsets differ by at most maxRel. Returns true if q moved. */
function drag(rs: RailState, q: number, ref: number): boolean {
  const ex = rs.dx[q] - rs.dx[ref];
  const ez = rs.dz[q] - rs.dz[ref];
  const len = sqrt(ex * ex + ez * ez);
  const lim = rs.layout.maxRel;
  if (len <= lim) return false;
  // On the segment between the two offsets, so it stays within maxOffset too.
  rs.dx[q] = rs.dx[ref] + (ex * lim) / len;
  rs.dz[q] = rs.dz[ref] + (ez * lim) / len;
  return true;
}

/**
 * A car hit piece p with impulse j (N s) along the contact normal (nx, nz),
 * which points from the rail toward the car, at contact point (px, pz). Shoves
 * the piece back (and drags its neighbors along). Returns how far (m) the hit
 * piece moved.
 */
export function pushRailPiece(rs: RailState, p: number, nx: number, nz: number, j: number, px: number, pz: number, tick: number): number {
  if (j < RAIL.minImpulse || p < 0) return 0;
  const l = rs.layout;
  const amount = (j / RAIL.pieceMass) * RAIL.yieldTime;
  const ox = rs.dx[p];
  const oz = rs.dz[p];
  let dx = ox - nx * amount;
  let dz = oz - nz * amount;
  const len = sqrt(dx * dx + dz * dz);
  if (len > RAIL.maxOffset) {
    dx *= RAIL.maxOffset / len;
    dz *= RAIL.maxOffset / len;
  }
  const moved = sqrt((dx - ox) ** 2 + (dz - oz) ** 2);
  if (moved < 1e-5) return 0;
  rs.dx[p] = dx;
  rs.dz[p] = dz;
  // Off center hits turn the piece a hair: the end that was hit goes back further.
  const u = (px - l.cx[p]) * l.tx[p] + (pz - l.cz[p]) * l.tz[p];
  const away = sign(-l.tz[p] * -nx + l.tx[p] * -nz);
  const rot = rs.rot[p] + away * moved * RAIL.rotPerMeter * (u / (l.half[p] || 1));
  rs.rot[p] = rot > RAIL.maxRot ? RAIL.maxRot : rot < -RAIL.maxRot ? -RAIL.maxRot : rot;
  place(rs, p);
  rs.movedTick[p] = tick;
  // Chain: neighbors follow just enough to keep the joints closed.
  for (let ref = p, q = l.next[p]; q >= 0 && drag(rs, q, ref); ref = q, q = l.next[q]) {
    place(rs, q);
    rs.movedTick[q] = tick;
  }
  for (let ref = p, q = l.prev[p]; q >= 0 && drag(rs, q, ref); ref = q, q = l.prev[q]) {
    place(rs, q);
    rs.movedTick[q] = tick;
  }
  rs.version++;
  return moved;
}

/**
 * Step caught by a car circle centered at (cx, cz), moving at (vx, vz), that
 * is touching piece p: if the circle crosses a joint of p within dt into a
 * piece whose face sticks out toward it (the joint ahead of p, or the one into
 * p when p itself is the protruding piece), how far (m) it sticks out; else 0.
 * Each joint crossing counts once. Dented rails are stepped, and the steps
 * catch wall riders.
 */
export function railStepAhead(rs: RailState, p: number, vx: number, vz: number, cx: number, cz: number, dt: number): number {
  const l = rs.layout;
  const a = l.first[p];
  const b = a + l.subs[p] - 1;
  const vt = vx * l.tx[p] + vz * l.tz[p];
  const fwd = vt > 0;
  const reach = abs(vt) * dt;
  // Joint ahead of p, into the next piece the car is heading for.
  const q = fwd ? l.next[p] : l.prev[p];
  if (q >= 0) {
    const jx = fwd ? rs.bx[b] : rs.ax[a];
    const jz = fwd ? rs.bz[b] : rs.az[a];
    const d = ((jx - cx) * l.tx[p] + (jz - cz) * l.tz[p]) * (fwd ? 1 : -1);
    if (d >= 0 && d < reach) {
      const qk = fwd ? l.first[q] : l.first[q] + l.subs[q] - 1;
      const step = ((fwd ? rs.ax[qk] : rs.bx[qk]) - jx) * rs.nx[fwd ? b : a] + ((fwd ? rs.az[qk] : rs.bz[qk]) - jz) * rs.nz[fwd ? b : a];
      return step > 0 ? step : 0;
    }
  }
  // Joint into p from the piece behind it (the circle is about to cross onto p).
  const o = fwd ? l.prev[p] : l.next[p];
  if (o >= 0) {
    const jx = fwd ? rs.ax[a] : rs.bx[b];
    const jz = fwd ? rs.az[a] : rs.bz[b];
    const d = ((jx - cx) * l.tx[p] + (jz - cz) * l.tz[p]) * (fwd ? 1 : -1);
    if (d >= 0 && d < reach) {
      const ok = fwd ? l.first[o] + l.subs[o] - 1 : l.first[o];
      const ox = fwd ? rs.bx[ok] : rs.ax[ok];
      const oz = fwd ? rs.bz[ok] : rs.az[ok];
      const step = (jx - ox) * rs.nx[ok] + (jz - oz) * rs.nz[ok];
      return step > 0 ? step : 0;
    }
  }
  return 0;
}

/** Largest gap (m) between the touching ends of neighboring pieces right now. */
export function maxRailGap(rs: RailState): number {
  const l = rs.layout;
  let gap = 0;
  for (let p = 0; p < l.count; p++) {
    const q = l.next[p];
    if (q < 0) continue;
    const a = l.first[p] + l.subs[p] - 1;
    const b = l.first[q];
    gap = Math.max(gap, sqrt((rs.bx[a] - rs.ax[b]) ** 2 + (rs.bz[a] - rs.az[b]) ** 2));
  }
  return gap;
}
