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
 * Everything stands behind the sim's wall line (the side opposite its
 * normal): the wall face is the collision. Merged into the kit's solid and
 * glow builders, so the walls cost no draw calls. Low keeps the plain box.
 */
import * as THREE from 'three';
import type { Wall } from '../../city/blocks';
import { planArchitecture, type Region } from '../buildings/architecture';
import type { DistrictKit } from './kit';
import { col, cylinder, orientedBox, wallBox } from './kit';

type Finish = 'brick' | 'stucco' | 'painted';

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
};

const FINISH_OF: Record<Region, Finish> = { nyc: 'brick', philly: 'brick', la: 'stucco', miami: 'stucco', sf: 'painted' };
/** Miami's stucco walls take a white cap, Los Angeles' a terracotta one. */
const MIAMI_CAP = col(0xe8e6df);
const LANTERN = col(0xffd39a, 2.1);
const LANTERN_FRAME = col(0x1a1b1f);
/** The plain box Low keeps. */
const PLAIN = col(0x4a4c55);

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
    const region = regionAt((mid.ax + mid.bx) / 2, (mid.az + mid.bz) / 2);
    const F = FINISHES[FINISH_OF[region]];
    const cap = region === 'miami' ? MIAMI_CAP : F.cap;
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
