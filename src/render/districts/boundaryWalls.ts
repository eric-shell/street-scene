/**
 * The low walls that close every gap in the street frontage the infill left
 * (look 'boundary', several kilometres of them in every city): drawn as
 * proper garden and yard walls instead of a plain box, in the finish of the
 * neighbourhood they stand in, so they belong to the architecture beside
 * them (architecture.ts regions):
 *  - brick (New York, Philadelphia): red brick, a stone coping, brick piers;
 *  - stucco (Los Angeles, Miami): a pale rendered wall, a tile or white cap,
 *    wider piers further apart;
 *  - painted (San Francisco): a painted board wall on a concrete plinth.
 * Piers stand at both ends of every run and every few meters along it, and
 * every few piers carry a lantern on their cap, a warm glow that makes the
 * wall read at night (the frontage's gaps were black holes otherwise).
 *
 * On a hill, where the street climbs steeply along the run, the wall is a
 * stone retaining wall instead (taller, heavier piers), and a stair walk
 * climbs behind it in the yard the block keeps open there (backlots.ts keeps
 * its buildings further back), stepped to the slope with a handrail: the
 * San Francisco stairs beside the steep sidewalks.
 *
 * Everything stands behind the sim's wall line (the side opposite its
 * normal): the wall face is the collision. Merged into the kit's solid and
 * glow builders, so the walls cost no draw calls. Low keeps the plain box.
 */
import * as THREE from 'three';
import type { Wall } from '../../city/blocks';
import { planArchitecture, type Region } from '../buildings/architecture';
import type { DistrictKit } from './kit';
import { col, cylinder, orientedBox, wallBox } from './kit';

type Finish = 'brick' | 'stucco' | 'painted' | 'retaining';

interface FinishLook {
  /** Wall body colour, coping colour, pier colour. */
  body: THREE.Color;
  cap: THREE.Color;
  pier: THREE.Color;
  /** Body height and thickness (m). */
  height: number;
  thick: number;
  /** Pier spacing along a run (m), width along it (m), height over the body's top (m). */
  pierEvery: number;
  pierW: number;
  pierRise: number;
  /** One lantern every this many piers. */
  lampEvery: number;
}

const FINISHES: Record<Finish, FinishLook> = {
  brick: { body: col(0x5c2f27), cap: col(0x8e877a), pier: col(0x67352b), height: 1.15, thick: 0.38, pierEvery: 3.6, pierW: 0.5, pierRise: 0.32, lampEvery: 3 },
  stucco: { body: col(0xb3a58c), cap: col(0x8c4b31), pier: col(0xbfb196), height: 1.2, thick: 0.34, pierEvery: 4.8, pierW: 0.6, pierRise: 0.38, lampEvery: 2 },
  painted: { body: col(0x56677a), cap: col(0xd8d6cf), pier: col(0x6a6c72), height: 1.1, thick: 0.3, pierEvery: 4.2, pierW: 0.44, pierRise: 0.28, lampEvery: 3 },
  retaining: { body: col(0x75716a), cap: col(0x8e8a82), pier: col(0x67635d), height: 1.45, thick: 0.5, pierEvery: 3.2, pierW: 0.6, pierRise: 0.25, lampEvery: 3 },
};

/** A run on a hill whose ground climbs at least this steeply along it (rise per m) is a retaining wall; a stair walk needs this much more, and this long a run (m). */
const HILL = { grade: 0.05, stairs: 0.06, stairRun: 10 } as const;

/**
 * The stair walk behind a retaining wall: from `from` to `to` along a straight piece a -> b (unit t, the
 * wall's normal n), `off0`..`off1` behind its line, a step wherever the ground has risen a riser height,
 * a handrail on posts along its far side.
 */
const STAIR = { off0: 0.75, off1: 2.05, riser: 0.18, rail: 0.95, post: 2.4 } as const;
const STEP = col(0x8a867e);
const HANDRAIL = col(0x2a2c30);

function stairWalk(kit: DistrictKit, ax: number, az: number, tx: number, tz: number, nx: number, nz: number, from: number, to: number): void {
  const at = (s: number, off: number) => ({ x: ax + tx * s - nx * off, z: az + tz * s - nz * off });
  const ground = (s: number) => {
    const p = at(s, (STAIR.off0 + STAIR.off1) / 2);
    return kit.h(p.x, p.z);
  };
  let s0 = from;
  let level = Math.max(ground(from), ground(from + 0.5));
  const lo = Math.min(ground(from), ground(to)) - 0.3;
  while (s0 < to - 0.2) {
    // The next step starts where the ground has climbed a riser above this one (or fallen one below it).
    let s1 = s0 + 0.3;
    while (s1 < to && Math.abs(ground(s1) - level) < STAIR.riser) s1 += 0.1;
    s1 = Math.min(s1, to);
    const p = at(s0, STAIR.off0);
    const q = at(s1, STAIR.off0);
    // A level tread over the ground under its whole length (the ground climbs up to a riser along it).
    const tread = Math.max(level, ground(s1)) + 0.04;
    orientedBox(kit.solid, p.x, p.z, q.x, q.z, -nx * (STAIR.off1 - STAIR.off0), -nz * (STAIR.off1 - STAIR.off0), lo, tread, STEP);
    s0 = s1;
    level = ground(Math.min(to, s1 + 0.15));
  }
  // The handrail on its far side, piece by piece along the slope, on posts.
  for (let s = from; s < to - 0.1; s += STAIR.post) {
    const e = Math.min(to, s + STAIR.post);
    const p = at(s, STAIR.off1 - 0.05);
    const q = at(e, STAIR.off1 - 0.05);
    const yp = ground(s) + STAIR.rail;
    const yq = ground(e) + STAIR.rail;
    cylinder(kit.solid, p.x, p.z, 0.03, yp - STAIR.rail, yp, 4, HANDRAIL, false);
    const n = 4;
    for (let k = 0; k < n; k++) {
      const u0 = k / n;
      const u1 = (k + 1) / n;
      orientedBox(kit.solid, p.x + (q.x - p.x) * u0, p.z + (q.z - p.z) * u0, p.x + (q.x - p.x) * u1, p.z + (q.z - p.z) * u1, -nx * 0.05, -nz * 0.05, yp + (yq - yp) * u0 - 0.03, yp + (yq - yp) * u1 + 0.03, HANDRAIL);
    }
  }
}

const FINISH_OF: Record<Region, Finish> = { nyc: 'brick', philly: 'brick', la: 'stucco', miami: 'stucco', sf: 'painted' };
/** Miami's stucco walls take a white cap, Los Angeles' a terracotta one. */
const MIAMI_CAP = col(0xe8e6df);
const LANTERN = col(0xffd39a, 2.1);
const LANTERN_FRAME = col(0x1a1b1f);
/** The plain box Low keeps. */
const PLAIN = col(0x4a4c55);

/** A run's straight stretches: consecutive pieces heading the same way (within a few degrees) as one line. */
function stretches(run: readonly Wall[]): { ax: number; az: number; bx: number; bz: number; nx: number; nz: number }[] {
  const out: { ax: number; az: number; bx: number; bz: number; nx: number; nz: number }[] = [];
  for (const w of run) {
    const last = out[out.length - 1];
    const lw = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
    if (last) {
      const ll = Math.hypot(last.bx - last.ax, last.bz - last.az) || 1;
      const cos = ((last.bx - last.ax) * (w.bx - w.ax) + (last.bz - last.az) * (w.bz - w.az)) / (ll * lw);
      if (cos > 0.997 && Math.hypot(w.ax - last.bx, w.az - last.bz) < 0.05) {
        last.bx = w.bx;
        last.bz = w.bz;
        continue;
      }
    }
    out.push({ ax: w.ax, az: w.az, bx: w.bx, bz: w.bz, nx: w.nx, nz: w.nz });
  }
  return out;
}

/** Chains of walls meeting end to end, so piers are spaced along a whole run, not each 1 m sample. */
function chains(walls: readonly Wall[]): Wall[][] {
  const key = (x: number, z: number) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
  const byStart = new Map<string, number>();
  const hasPrev = new Uint8Array(walls.length);
  walls.forEach((w, i) => byStart.set(key(w.ax, w.az), i));
  const next = walls.map((w) => byStart.get(key(w.bx, w.bz)) ?? -1);
  next.forEach((j) => j >= 0 && (hasPrev[j] = 1));
  const used = new Uint8Array(walls.length);
  const out: Wall[][] = [];
  const walk = (i: number) => {
    const run: Wall[] = [];
    for (let k = i; k >= 0 && !used[k]; k = next[k]) {
      used[k] = 1;
      run.push(walls[k]);
    }
    if (run.length) out.push(run);
  };
  // Open runs from their first wall, then whatever closed loops are left.
  walls.forEach((_, i) => !hasPrev[i] && walk(i));
  walls.forEach((_, i) => walk(i));
  return out;
}

/** The region of the building nearest to a point (a coarse grid over the city's buildings). */
function regionLookup(kit: DistrictKit): (x: number, z: number) => Region {
  const B = kit.world.blocks.buildings;
  const plans = planArchitecture(kit.world);
  const CELL = 40;
  const grid = new Map<string, number[]>();
  B.forEach((b, i) => {
    const k = `${Math.floor(b.x / CELL)},${Math.floor(b.z / CELL)}`;
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  });
  return (x, z) => {
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    let best = -1;
    let bd = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          for (const i of grid.get(`${ci + di},${cj + dj}`) ?? []) {
            const d = (B[i].x - x) ** 2 + (B[i].z - z) ** 2;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
    }
    return best >= 0 ? plans[best].region : 'nyc';
  };
}

export function boundaryWalls(kit: DistrictKit, walls: readonly Wall[]): void {
  if (kit.quality === 'low') {
    for (const w of walls) wallBox(kit, kit.solid, w, 0.35, 1.1, PLAIN);
    return;
  }
  const regionAt = regionLookup(kit);
  for (const run of chains(walls)) {
    const mid = run[run.length >> 1];
    const mx = (mid.ax + mid.bx) / 2;
    const mz = (mid.az + mid.bz) / 2;
    const region = regionAt(mx, mz);
    // On a hill, steep along the run: a retaining wall (and maybe its stairs, below).
    const first = run[0];
    const last = run[run.length - 1];
    const runLen = Math.hypot(last.bx - first.ax, last.bz - first.az);
    const grade = runLen > 0 ? Math.abs(kit.h(last.bx, last.bz) - kit.h(first.ax, first.az)) / runLen : 0;
    const hill = kit.world.areaAt(mx, mz)?.kind === 'hills' && grade >= HILL.grade;
    const F = FINISHES[hill ? 'retaining' : FINISH_OF[region]];
    const cap = !hill && region === 'miami' ? MIAMI_CAP : F.cap;
    if (hill) {
      // Straight stretches of the run (its pieces in line) long and steep enough for a flight, short of the
      // stretch's ends (a building or a corner starts there).
      for (const st of stretches(run)) {
        const len = Math.hypot(st.bx - st.ax, st.bz - st.az);
        if (len < HILL.stairRun || Math.abs(kit.h(st.bx, st.bz) - kit.h(st.ax, st.az)) / len < HILL.stairs) continue;
        stairWalk(kit, st.ax, st.az, (st.bx - st.ax) / len, (st.bz - st.az) / len, st.nx, st.nz, 1.5, len - 1.5);
      }
    }
    // The body and the coping over it (overhanging both faces a little), segment by segment.
    for (const w of run) {
      wallBox(kit, kit.solid, w, F.thick, F.height, F.body);
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      if (len < 0.05) continue;
      const tx = (w.bx - w.ax) / len;
      const tz = (w.bz - w.az) / len;
      const top = Math.max(kit.h(w.ax, w.az), kit.h(w.bx, w.bz)) + F.height;
      // From the wall line (the collision face: nothing stands in front of it) back past the body.
      const ax = w.ax - tx * 0.02;
      const az = w.az - tz * 0.02;
      const bx = w.bx + tx * 0.02;
      const bz = w.bz + tz * 0.02;
      orientedBox(kit.solid, ax, az, bx, bz, -w.nx * (F.thick + 0.1), -w.nz * (F.thick + 0.1), top - 0.02, top + 0.1, cap);
    }
    // Piers: at both ends of the run and evenly between, each a box straddling the body, its cap stone on
    // top, a lantern on every few.
    const lens = run.map((w) => Math.hypot(w.bx - w.ax, w.bz - w.az));
    const total = lens.reduce((a, b) => a + b, 0);
    if (total < 0.5) continue;
    const n = Math.max(1, Math.round(total / F.pierEvery));
    for (let k = 0; k <= n; k++) {
      // Distance along the run, the ends pulled in by half a pier so it stays on the wall.
      const s = Math.min(total - F.pierW / 2, Math.max(F.pierW / 2, (total * k) / n));
      let i = 0;
      let acc = 0;
      while (i < run.length - 1 && acc + lens[i] < s) acc += lens[i++];
      const w = run[i];
      const t = lens[i] > 0 ? (s - acc) / lens[i] : 0;
      const tx = lens[i] > 0 ? (w.bx - w.ax) / lens[i] : 1;
      const tz = lens[i] > 0 ? (w.bz - w.az) / lens[i] : 0;
      const px = w.ax + (w.bx - w.ax) * t;
      const pz = w.az + (w.bz - w.az) * t;
      const hw = F.pierW / 2;
      const ground = Math.min(kit.h(px - tx * hw, pz - tz * hw), kit.h(px + tx * hw, pz + tz * hw));
      const top = Math.max(kit.h(px - tx * hw, pz - tz * hw), kit.h(px + tx * hw, pz + tz * hw)) + F.height + F.pierRise;
      // Flush with the face on the wall line, standing out behind the body.
      const ax = px - tx * hw;
      const az = pz - tz * hw;
      const bx = px + tx * hw;
      const bz = pz + tz * hw;
      const deep = F.thick + 0.12;
      orientedBox(kit.solid, ax, az, bx, bz, -w.nx * deep, -w.nz * deep, ground - 0.3, top, F.pier);
      // Cap stone, a little wider along the run and behind.
      orientedBox(kit.solid, ax - tx * 0.05, az - tz * 0.05, bx + tx * 0.05, bz + tz * 0.05, -w.nx * (deep + 0.06), -w.nz * (deep + 0.06), top, top + 0.1, cap);
      if (k % F.lampEvery !== 0) continue;
      // A lantern on the cap: dark frame, warm glass.
      const lx = px - w.nx * deep * 0.5;
      const lz = pz - w.nz * deep * 0.5;
      cylinder(kit.solid, lx, lz, 0.13, top + 0.1, top + 0.16, 4, LANTERN_FRAME);
      cylinder(kit.glow, lx, lz, 0.1, top + 0.16, top + 0.42, 4, LANTERN);
      cylinder(kit.solid, lx, lz, 0.15, top + 0.42, top + 0.48, 4, LANTERN_FRAME, true, 0.04);
    }
  }
}
