/**
 * Street meets behind the cyan barriers. Every rail chain with open ground
 * behind it (a closure across a side street; a corner rail where it crosses a
 * closed street's mouth or runs past a plaza or lot) gets, from the barrier
 * outward:
 *  1. a crowd packed right up against the barrier, thinning with depth;
 *  2. cars parked nose to the course as if they pulled in to watch, dense in
 *     the first rows (where the crowd thins, people mixing between them) and
 *     sparser toward the back.
 * There is no barrier behind them: the cyan rail in front is the closure
 * (src/city/world.ts). One plan per world, seeded so every session sees the
 * same meet; crowds.ts draws the people and roadblocks.ts the cars. Render
 * only: nothing here collides.
 */
import type { World } from '../city/world';
import type { Wall } from '../city/blocks';
import type { RailWall } from '../city/route';
import type { Contact } from '../city/world';
import { CITY } from '../city/config';
import { Rng } from '../sim/prng';
import { distToSegment } from '../sim/math';
import { RAIL } from '../sim/rails';
import { railCurves } from './routeArrows';

export interface MeetPerson {
  x: number;
  y: number;
  z: number;
  /** Facing (three.js yaw): local +z toward the course. */
  yaw: number;
}

export interface MeetCar {
  x: number;
  z: number;
  yaw: number;
  /** Index into MeetOptions.cars (the parked models). */
  model: number;
  /** Customization variant of that model (roadblocks.ts: body kit, spoiler, rims). */
  variant: number;
  /** Random 0..1 picks for the paint and the underglow colour (glow < 0: none). */
  paint: number;
  glow: number;
  /** Front row cars blink their hazards. */
  hazards: boolean;
}

export interface MeetZone {
  /** Rail group of the barrier this meet stands behind. */
  rail: number;
  /** A closure across a side street (vs a corner rail). */
  closure: boolean;
  people: MeetPerson[];
  /** Indices into MeetPlan.cars. */
  cars: number[];
  /** Bounds for culling: centroid and radius (m). */
  x: number;
  z: number;
  radius: number;
}

export interface MeetPlan {
  zones: MeetZone[];
  cars: MeetCar[];
}

export interface MeetOptions {
  /** Parked models: footprint (m) and how many customization variants each has. */
  cars: { length: number; width: number; variants: number }[];
  /** People per meter scale (graphics quality) and how deep the crowd reaches behind the barrier (m). */
  peopleDensity?: number;
  peopleDepth?: number;
  /** Rows of parked cars behind the crowd. */
  carRows?: number;
}

/** Layout (m from the barrier's rest line, plus how far a hit may shove it), densities and caps. */
const MEET = {
  /** People rows: spacing in depth and along the barrier at density 1. */
  rowStep: 0.55,
  personStep: 0.62,
  /** The crowd is packed this deep, then thins with this e-folding depth. */
  packed: 1.8,
  thin: 2.4,
  packedFill: 0.92,
  /** First car row (center) and row spacing; slot spacing along the barrier. */
  carFirst: 4.7,
  carRow: 5.4,
  carSlot: 2.9,
  /**
   * Share of slots filled per row, front to back: densest where the crowd thins, and the rows from
   * the third back together sparser than the first, so a deep meet still reads front heavy.
   */
  carFill: [0.85, 0.72, 0.4, 0.24, 0.14, 0.06],
  /** A closure's meet stops this short of the far end of its street; a corner rail's reaches this far. */
  closureEndClear: 3,
  cornerDepth: 16,
  maxDepth: 34,
  /** Clearance beyond the route's road and sidewalk (m), and the people cap per meet at density 1. */
  routeClear: 1,
  /** People and cars keep this far from a route shortcut's sidewalks (m). */
  shortcutClear: 2.5,
  peopleCap: 340,
  /** Steepest ground (rise per run) a car parks on: people stand on the river's banks, cars do not. */
  carMaxGrade: 0.18,
} as const;

/** Surfaces a meet may stand on (block interiors are 'offroad', the river 'water'). */
const GROUND = new Set(['road', 'sidewalk', 'concrete', 'grass']);

/** Circles in a uniform hash: everything placed so far. */
class Occupancy {
  private cells = new Map<number, number[]>();
  constructor(private readonly size: number) {}
  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }
  add(x: number, z: number, r: number): void {
    const s = this.size;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++) {
      for (let cz = Math.floor((z - r) / s); cz <= Math.floor((z + r) / s); cz++) {
        const k = this.key(cx, cz);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(x, z, r);
      }
    }
  }
  hits(x: number, z: number, r: number): boolean {
    const s = this.size;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++) {
      for (let cz = Math.floor((z - r) / s); cz <= Math.floor((z + r) / s); cz++) {
        const l = this.cells.get(this.key(cx, cz));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 3) {
          const m = l[i + 2] + r;
          if ((l[i] - x) ** 2 + (l[i + 1] - z) ** 2 < m * m) return true;
        }
      }
    }
    return false;
  }
}

/** Points along a rail chain: position, the segment's normal (toward the course) at arc length s. */
function chainAt(chain: Wall[], cum: number[], s: number): { x: number; z: number; nx: number; nz: number } {
  let i = 0;
  while (i < chain.length - 1 && cum[i + 1] < s) i++;
  const w = chain[i];
  const len = cum[i + 1] - cum[i] || 1;
  const t = Math.max(0, Math.min(1, (s - cum[i]) / len));
  return { x: w.ax + (w.bx - w.ax) * t, z: w.az + (w.bz - w.az) * t, nx: w.nx, nz: w.nz };
}

export function planMeets(world: World, opts: MeetOptions): MeetPlan {
  const plan: MeetPlan = { zones: [], cars: [] };
  if (world.openWorld || !opts.cars.length) return plan;
  const density = Math.max(0.2, opts.peopleDensity ?? 0.7);
  const peopleDepth = opts.peopleDepth ?? 7;
  const carRows = Math.max(0, Math.min(MEET.carFill.length, opts.carRows ?? 3));
  const rng = new Rng((world.seed ^ 0x3ee7) >>> 0);
  const taken = new Occupancy(6);
  // Street furniture and buildings are in the way of everything.
  for (const p of world.props ?? []) taken.add(p.x, p.z, p.radius + 0.25);
  const B = world.blocks.buildings;
  const bCell = 32;
  const bGrid = new Map<number, number[]>();
  const bKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  B.forEach((b, i) => {
    const r = Math.hypot(b.w, b.d) / 2 + 2;
    for (let cx = Math.floor((b.x - r) / bCell); cx <= Math.floor((b.x + r) / bCell); cx++) {
      for (let cz = Math.floor((b.z - r) / bCell); cz <= Math.floor((b.z + r) / bCell); cz++) {
        const k = bKey(cx, cz);
        let l = bGrid.get(k);
        if (!l) bGrid.set(k, (l = []));
        l.push(i);
      }
    }
  });
  const inBuilding = (x: number, z: number, r: number): boolean => {
    const l = bGrid.get(bKey(Math.floor(x / bCell), Math.floor(z / bCell)));
    if (!l) return false;
    for (const i of l) {
      const b = B[i];
      const px = x - b.x;
      const pz = z - b.z;
      const lx = Math.abs(px * Math.cos(b.yaw) - pz * Math.sin(b.yaw)) - b.w / 2;
      const lz = Math.abs(px * Math.sin(b.yaw) + pz * Math.cos(b.yaw)) - b.d / 2;
      const ex = Math.max(lx, 0);
      const ez = Math.max(lz, 0);
      if (ex * ex + ez * ez < r * r) return true;
    }
    return false;
  };
  const contacts: Contact[] = [];
  const route = world.route;
  /**
   * Open ground: on a street, sidewalk, plaza or lawn, off the course, clear of walls, buildings and
   * everything placed. `flat` (parked cars) also rules out the river's sloped banks.
   */
  const free = (x: number, z: number, r: number, flat = false): boolean => {
    if (!GROUND.has(world.surfaceAt(x, z))) return false;
    if (flat) {
      const sl = world.slopeAt(x, z);
      if (sl.gx * sl.gx + sl.gz * sl.gz > MEET.carMaxGrade * MEET.carMaxGrade) return false;
    }
    const rp = world.routeProgress(x, z);
    const beyondEnds = !route.closed && (rp.s < 0.5 || rp.s > route.length - 0.5);
    if (!beyondEnds && Math.abs(rp.lateral) < route.segWidth[rp.seg] / 2 + CITY.sidewalk + MEET.routeClear + r) return false;
    // Shortcuts stay open: nobody stands or parks in the alley, its sidewalks or its mouths.
    for (const sc of route.shortcuts) {
      const half = world.graph.edges[sc.edge].width / 2 + world.graph.edges[sc.edge].sidewalk + MEET.shortcutClear + r;
      if (distToSegment(x, z, sc.ax, sc.az, sc.bx, sc.bz) < half) return false;
    }
    // collideCircle also reports walls up to 3 m in front of the point (its anti tunnelling band), and
    // standing right behind the barrier is the whole point: only a real overlap, or being behind a city
    // wall (inside a block), rules a spot out.
    const n = world.collideCircle(x, z, r, contacts);
    for (let i = 0; i < n; i++) {
      const c = contacts[i];
      const dx = x - c.px;
      const dz = z - c.pz;
      if (dx * dx + dz * dz < r * r) return false;
      if (c.kind === 'wall' && dx * c.nx + dz * c.nz < 0) return false;
    }
    if (taken.hits(x, z, r) || inBuilding(x, z, r)) return false;
    return true;
  };

  const closureDepth = new Map<number, number>();
  for (const g of world.barrierGroups ?? []) {
    const id = (g.walls[0] as RailWall | undefined)?.group;
    if (id === undefined) continue;
    // Behind a closure across a river ramp the trench climbs away: the meet stays near its foot.
    const steep = g.edges.some((e) => world.graph.edges[e].kind === 'ramp');
    closureDepth.set(id, steep ? Math.min(g.depth, MEET.cornerDepth + MEET.closureEndClear) : g.depth);
  }
  const d0 = RAIL.maxOffset;

  for (const chain of railCurves(world)) {
    const rail = (chain[0] as RailWall).group;
    const closure = closureDepth.has(rail);
    const maxDepth = Math.min(MEET.maxDepth, closure ? closureDepth.get(rail)! - MEET.closureEndClear : MEET.cornerDepth);
    if (maxDepth < 2.5) continue;
    const cum = [0];
    for (const w of chain) cum.push(cum[cum.length - 1] + Math.hypot(w.bx - w.ax, w.bz - w.az));
    const total = cum[cum.length - 1];
    if (total < 2) continue;
    const zone: MeetZone = { rail, closure, people: [], cars: [], x: 0, z: 0, radius: 0 };

    // Cars first (their rows are the skeleton), nose to the course.
    for (let r = 0; r < carRows; r++) {
      const depth = d0 + MEET.carFirst + r * MEET.carRow;
      for (let s = 1.5 + (r % 2) * MEET.carSlot * 0.5 + rng.range(0, 0.6); s < total - 1.2; s += MEET.carSlot + rng.range(-0.2, 0.5)) {
        if (!rng.chance(MEET.carFill[r])) continue;
        const model = rng.int(0, opts.cars.length - 1);
        const dims = opts.cars[model];
        const p = chainAt(chain, cum, s);
        const d = depth + rng.range(-0.3, 0.6);
        if (d + dims.length / 2 > maxDepth) continue;
        const roll = rng.next();
        // Mostly straight at the course, some angled in, a few broadside at the back.
        const face = Math.atan2(p.nx, p.nz);
        const yaw = r > 1 && roll > 0.9 ? face + Math.PI / 2 + rng.range(-0.2, 0.2) : roll < 0.72 ? face + rng.range(-0.22, 0.22) : face + rng.pick([-1, 1]) * rng.range(0.4, 0.75);
        const x = p.x - p.nx * d;
        const z = p.z - p.nz * d;
        // Three circles along the car.
        const rad = dims.width / 2 + 0.12;
        const off = dims.length / 2 - rad;
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        let ok = true;
        for (let k = -1; k <= 1 && ok; k++) ok = free(x + fx * off * k, z + fz * off * k, rad, true);
        if (!ok) continue;
        for (let k = -1; k <= 1; k++) taken.add(x + fx * off * k, z + fz * off * k, rad);
        zone.cars.push(plan.cars.length);
        plan.cars.push({ x, z, yaw, model, variant: rng.int(0, Math.max(0, dims.variants - 1)), paint: rng.next(), glow: rng.chance(0.45) ? rng.next() : -1, hazards: r === 0 && rng.chance(0.5) });
      }
    }

    // The crowd: packed against the barrier, thinning with depth, filling in around the front cars.
    const step = MEET.personStep / density;
    const cap = Math.round(MEET.peopleCap * density);
    for (let k = 0; ; k++) {
      const depth = d0 + 0.55 + k * MEET.rowStep;
      const dd = depth - d0;
      if (dd > peopleDepth || depth > maxDepth - 0.4 || zone.people.length >= cap) break;
      const fill = dd < MEET.packed ? MEET.packedFill : MEET.packedFill * Math.exp(-(dd - MEET.packed) / MEET.thin);
      for (let s = rng.range(0, step) + (k % 2) * step * 0.5; s < total && zone.people.length < cap; s += step * rng.range(0.85, 1.2)) {
        if (!rng.chance(fill)) continue;
        const p = chainAt(chain, cum, s);
        const d = depth + rng.range(-0.1, 0.1);
        const x = p.x - p.nx * d;
        const z = p.z - p.nz * d;
        if (!free(x, z, 0.3)) continue;
        taken.add(x, z, 0.21);
        const y = world.heightAt(x, z) + (world.surfaceAt(x, z) === 'road' ? 0 : CITY.curbHeight);
        zone.people.push({ x, y, z, yaw: Math.atan2(p.nx, p.nz) + rng.range(-0.45, 0.45) });
      }
    }
    if (!zone.people.length && !zone.cars.length) continue;
    let sx = 0;
    let sz = 0;
    const pts = [...zone.people.map((p) => [p.x, p.z]), ...zone.cars.map((i) => [plan.cars[i].x, plan.cars[i].z])];
    for (const [x, z] of pts) {
      sx += x;
      sz += z;
    }
    zone.x = sx / pts.length;
    zone.z = sz / pts.length;
    for (const [x, z] of pts) zone.radius = Math.max(zone.radius, Math.hypot(x - zone.x, z - zone.z));
    zone.radius += 3;
    plan.zones.push(zone);
  }
  return plan;
}
