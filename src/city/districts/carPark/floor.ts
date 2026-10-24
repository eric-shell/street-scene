/**
 * What stands on a car park's drivable floor: parking stalls nose in along the parapets and in double rows
 * with aisles between them, parked cars in half of them, columns on the bay grid and a stair core in a
 * corner (carParkFloor), all kept an open aisle's width off the racing line, the exit lane and the ramp's
 * mouth. Also the footprints of a parked car and a column that the walls make solid and the renderer draws.
 */
import { CITY } from '../../config';
import { Vec2, sqrt } from '../../../sim/math';
import { Rng } from '../../../sim/prng';
import { distToPath, insetRing, pointInPolygon, polygonArea } from '../geom';
import { type CarParkGeo, type Frame, funnelFlare, rampPoint, toU, toV, toWorld } from './geometry';

const CFG = CITY.districts.carPark;

/** A parking stall on the drivable floor: center, the unit heading of a car parked nose in (toward the parapet), its car. */
export interface Stall {
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** A parked car's paint pick (0..1), or -1 for an empty stall. */
  car: number;
}

/** What stands on the drivable floor: stalls, the columns at the inner end of their runs, the stair core (null when no corner is free). */
export interface CarParkFloor {
  stalls: Stall[];
  /** Column centers (square, aligned to the frame; side CFG.wall * 1.5). */
  columns: Vec2[];
  /** The stair core's corners (a square of side CFG.core in the frame), or null. */
  core: Vec2[] | null;
}

/** A parked car's footprint (m): the box carParkWalls makes solid and the renderer draws. */
export const PARKED_CAR = { length: 4.3, width: 1.8 } as const;
/** Interior column side (m). */
export const COLUMN = 0.6;

/** Two convex polygons overlap (separating axis test). */
function convexOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q.z - p.z;
      const nz = p.x - q.x;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (const r of a) {
        const d = r.x * nx + r.z * nz;
        a0 = Math.min(a0, d);
        a1 = Math.max(a1, d);
      }
      for (const r of b) {
        const d = r.x * nx + r.z * nz;
        b0 = Math.min(b0, d);
        b1 = Math.max(b1, d);
      }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

/**
 * A parking floor's fittings, the same for the sim (carParkWalls makes the
 * drivable floor's cars, columns and core solid) and the renderer (which
 * draws every level): stalls nose in along the parapets and back to back in
 * double rows down the floor with an aisle between the rows, a car parked in
 * some, a column at the aisle end of every few stalls and a stair core in a
 * corner. On the drivable floor (`upper` false) all of it keeps aisleClear
 * from the racing line, off the exit lane and its funnel, out of the ramp's
 * mouth and off the straight on from it, so the drive itself is an open
 * aisle and nothing a car is meant to cross is in the way; the other levels
 * are render only and park right across that. Deterministic per seed.
 */
export function carParkFloor(g: CarParkGeo, seed: number, upper = false): CarParkFloor {
  const t = CFG.wall;
  const [P, D] = CFG.stall;
  const W = (u: number, v: number) => toWorld(g, u, v);
  const rng = new Rng(((seed ^ (upper ? 0x0dd1ab1e : 0x5ca1ab1e)) >>> 0) || 1);
  // Inside the parapets; off the ramp and its walls (the strip it climbs in and the apron's flare).
  const floorIn = insetRing(g.deck, t - 0.02) ?? g.deck;
  const rampHole = insetRing(g.ramp, -(t + 0.4)) ?? g.ramp;
  // The exit lane and its funnel, a margin round them (convex, frame order).
  const m = t + 0.6;
  const fMin = Math.min(...g.front.map((f) => f.u));
  const lane = [W(fMin - 1, -(g.hc + m)), W(g.lc, -(g.hc + m)), W(g.lc + g.cf + 1, -(g.hc + funnelFlare(g, -1) + m)), W(g.lc + g.cf + 1, g.hc + funnelFlare(g, 1) + m), W(g.lc, g.hc + m), W(fMin - 1, g.hc + m)];
  const mouth = rampPoint(g, g.rend, 0);
  const mouthClear = g.rhw + CFG.aisleClear;
  // Straight on across the deck from the ramp's mouth: where a car that misses the turn ends up.
  const reach = g.box.maxX - g.box.minX + g.box.maxZ - g.box.minZ;
  const sw = g.rhw + 1.5;
  const straight = [rampPoint(g, g.rend - 1, -sw), rampPoint(g, g.rend + reach, -sw), rampPoint(g, g.rend + reach, sw), rampPoint(g, g.rend - 1, sw)];
  const placed: Vec2[][] = [];
  const clear = (poly: Vec2[]): boolean => {
    for (const p of poly) if (!pointInPolygon(p.x, p.z, floorIn)) return false;
    if (convexOverlap(poly, rampHole)) return false;
    for (const q of placed) if (convexOverlap(poly, q)) return false;
    if (upper) return true;
    if (convexOverlap(poly, lane) || convexOverlap(poly, straight)) return false;
    let cx = 0;
    let cz = 0;
    for (const p of poly) {
      if (distToPath(g.path, p.x, p.z) < CFG.aisleClear) return false;
      if ((p.x - mouth.x) ** 2 + (p.z - mouth.z) ** 2 < mouthClear * mouthClear) return false;
      cx += p.x / poly.length;
      cz += p.z / poly.length;
    }
    return distToPath(g.path, cx, cz) >= CFG.aisleClear;
  };
  const rect = (u0: number, u1: number, v0: number, v1: number) => [W(u0, v0), W(u1, v0), W(u1, v1), W(u0, v1)];
  // The footprint's frame bounds.
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of g.deck) {
    const u = toU(g, p);
    const v = toV(g, p);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  // Stair core: in the footprint's corner furthest from the racing line (never where a car runs wide),
  // slid in along the corner's diagonal until it fits.
  let core: Vec2[] | null = null;
  let coreFar = 0;
  const S = CFG.core;
  for (const [su, sv] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    let corner = g.deck[0];
    let best = -Infinity;
    for (const p of g.deck) {
      const d = su * toU(g, p) + sv * toV(g, p);
      if (d > best) {
        best = d;
        corner = p;
      }
    }
    const cu = toU(g, corner);
    const cv = toV(g, corner);
    for (let k = t + 0.3; k <= 12; k += 1) {
      const u0 = su < 0 ? cu + k : cu - k - S;
      const v0 = sv < 0 ? cv + k : cv - k - S;
      const r = rect(u0, u0 + S, v0, v0 + S);
      if (!clear(r)) continue;
      const far = Math.min(...r.map((p) => distToPath(g.path, p.x, p.z)));
      if (far > coreFar) {
        coreFar = far;
        core = r;
      }
      break;
    }
  }
  if (core) placed.push(insetRing(core, -0.3) ?? core);

  const stalls: Stall[] = [];
  const columns: Vec2[] = [];
  /** A stall centred at c, nose along unit n (toward the wall or the row's spine), P wide across it. */
  const stallRect = (c: Vec2, n: Vec2): Vec2[] => {
    const lx = -n.z;
    const lz = n.x;
    return [
      { x: c.x - n.x * (D / 2) - lx * (P / 2), z: c.z - n.z * (D / 2) - lz * (P / 2) },
      { x: c.x + n.x * (D / 2) - lx * (P / 2), z: c.z + n.z * (D / 2) - lz * (P / 2) },
      { x: c.x + n.x * (D / 2) + lx * (P / 2), z: c.z + n.z * (D / 2) + lz * (P / 2) },
      { x: c.x - n.x * (D / 2) + lx * (P / 2), z: c.z - n.z * (D / 2) + lz * (P / 2) },
    ];
  };
  /**
   * A run of `count` stalls at `at(k)` with nose `nose(k)` (and `fits(k)`), a column at the aisle end
   * between every few of them at `columnAt(k)` (null: a row half whose other half places the spine's).
   */
  const run = (count: number, at: (k: number) => Vec2, nose: (k: number) => Vec2, columnAt: ((k: number) => Vec2) | null, fits: (k: number) => boolean = () => true) => {
    const ok: boolean[] = [];
    const rects: Vec2[][] = [];
    for (let k = 0; k < count; k++) {
      const r = stallRect(at(k), nose(k));
      ok.push(fits(k) && clear(r));
      rects.push(r);
    }
    for (let k = 0; k < count; k++) {
      if (!ok[k]) continue;
      placed.push(rects[k]);
      const c = at(k);
      const n = nose(k);
      stalls.push({ x: c.x, z: c.z, dx: n.x, dz: n.z, car: rng.chance(CFG.parkedShare) ? rng.next() : -1 });
      if (!columnAt || (k + 1) % CFG.columnEvery !== 0 || k + 1 >= count || !ok[k + 1]) continue;
      columns.push(columnAt(k));
    }
  };
  // Along the parapets, nose to the wall (inward by the footprint's way round).
  const inward = polygonArea(g.deck) < 0 ? 1 : -1;
  const nd = g.deck.length;
  const perimeter: Vec2[] = [];
  for (let i = 0; i < nd; i++) {
    const p = g.deck[i];
    const q = g.deck[(i + 1) % nd];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = sqrt(dx * dx + dz * dz);
    if (len < P + 2 * t) continue;
    const dir = { x: dx / len, z: dz / len };
    const n = { x: dir.z * inward, z: -dir.x * inward };
    const count = Math.floor((len - 2 * t) / P);
    const s0 = (len - count * P) / 2;
    const at = (k: number): Vec2 => ({ x: p.x + dir.x * (s0 + P * (k + 0.5)) + n.x * (t + D / 2), z: p.z + dir.z * (s0 + P * (k + 0.5)) + n.z * (t + D / 2) });
    const before = stalls.length;
    run(count, at, () => ({ x: -n.x, z: -n.z }), (k) => ({ x: p.x + dir.x * (s0 + P * (k + 1)) + n.x * (t + D - COLUMN / 2), z: p.z + dir.z * (s0 + P * (k + 1)) + n.z * (t + D - COLUMN / 2) }));
    for (let k = before; k < stalls.length; k++) perimeter.push(stalls[k]);
  }
  // Double rows down the floor along u, an aisle between them and from the parapets' stalls.
  const aisleGap = D + CFG.aisle - 1;
  const rowClear = (c: Vec2): boolean => perimeter.every((q) => (q.x - c.x) ** 2 + (q.z - c.z) ** 2 >= aisleGap * aisleGap);
  const nu = Math.floor((uMax - uMin) / P);
  for (let vr = vMin + t + D + CFG.aisle + D; vr + D + CFG.aisle + D + t <= vMax; vr += 2 * D + CFG.aisle) {
    for (const sv of [1, -1] as const) {
      const at = (k: number) => W(uMin + P * (k + 0.5), vr + (sv * D) / 2);
      const nose = { x: -sv * g.vx, z: -sv * g.vz };
      run(nu, at, () => nose, sv > 0 ? (k) => W(uMin + P * (k + 1), vr) : null, (k) => rowClear(at(k)));
    }
  }
  return { stalls, columns, core };
}

/** The parked car in a stall as a world polygon (the body's footprint, nose toward the parapet). */
export function parkedCarBox(s: Stall): Vec2[] {
  const hl = PARKED_CAR.length / 2;
  const hw = PARKED_CAR.width / 2;
  const lx = -s.dz;
  const lz = s.dx;
  return [
    { x: s.x - s.dx * hl - lx * hw, z: s.z - s.dz * hl - lz * hw },
    { x: s.x + s.dx * hl - lx * hw, z: s.z + s.dz * hl - lz * hw },
    { x: s.x + s.dx * hl + lx * hw, z: s.z + s.dz * hl + lz * hw },
    { x: s.x - s.dx * hl + lx * hw, z: s.z - s.dz * hl + lz * hw },
  ];
}

/** A column as a world polygon (square, aligned to the car park's frame). */
export function columnBox(g: Frame, c: Vec2): Vec2[] {
  const h = COLUMN / 2;
  return [-1, 1, 1, -1].map((su, i) => {
    const sv = i < 2 ? -1 : 1;
    return { x: c.x + g.ux * su * h + g.vx * sv * h, z: c.z + g.uz * su * h + g.vz * sv * h };
  });
}
