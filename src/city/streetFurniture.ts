/**
 * Neighbourhood street furniture: fire hydrants, mailboxes, parking meters,
 * phone booths and vending machines, so a street reads as the part of town it
 * is in and every block has something new to clip. The downtown core gets
 * metered curbs, phone booths and vending machines; the ring around it a mix;
 * the outer neighbourhoods hydrants and mailboxes (the neighbourhood is the
 * same downtown factor blocks.ts sizes buildings with). Each block side gets
 * at most one of each single piece, hydrants and mailboxes near a corner,
 * and a row of meters in a couple of its streetlight gaps.
 *
 * Runs inside generateProps after the basic furniture, on its own random
 * stream so the cans, benches and shelters stay where they were; its fit test
 * keeps every piece on the sidewalk, out of the bus bays, off reserved
 * circles and clear of every other prop. Pure and deterministic.
 */
import { CITY } from './config';
import type { RoadGraph } from './roadGraph';
import { isRiverEdge } from './roadGraph';
import type { EdgeMouths } from './blocks';
import type { FurnitureKind } from './props';
import { SETBACK, edgeSides, sidewalkGaps } from './props';
import { Rng, deriveSeed } from '../sim/prng';
import { atan2, exp, sqrt } from '../sim/math';

export const FURNITURE = {
  /** Neighbourhood by downtown factor: core above `core`, the ring above `mid`, outer below. */
  core: 0.55,
  mid: 0.2,
  /** Chance per block side, by neighbourhood [core, ring, outer]. */
  chance: {
    hydrant: [0.6, 0.65, 0.72],
    mailbox: [0.12, 0.3, 0.42],
    phoneBooth: [0.3, 0.12, 0.04],
    vendingMachine: [0.26, 0.16, 0.06],
  },
  /** Block sides with metered parking by neighbourhood, gaps that get a row of meters, their spacing (m). */
  meters: [0.55, 0.2, 0.03],
  meterGaps: 2,
  meterSpacing: 6.5,
  /** Hydrants and mailboxes stand within this far (m) of the junction end of a corner gap. */
  cornerReach: 10,
  /** Tries per piece. */
  tries: 3,
} as const;

type Single = keyof typeof FURNITURE.chance;

/**
 * Place the neighbourhood furniture. `tryPlace` runs generateProps' fit test
 * and pushes the prop when it fits; it returns whether it did.
 */
export function furnishStreets(seed: number, g: RoadGraph, mouths: EdgeMouths[], tryPlace: (kind: FurnitureKind, x: number, z: number, yaw: number, edge: number) => boolean): void {
  const rng = new Rng(deriveSeed(seed, 'streetFurniture'));
  const F = FURNITURE;
  const cx = (g.bounds.minX + g.bounds.maxX) / 2;
  const cz = (g.bounds.minZ + g.bounds.maxZ) / 2;
  g.edges.forEach((e, ei) => {
    // Plain streets only: alleys are too narrow for it, bridges have parapets, shortcuts are building sites.
    if (e.kind === 'backAlley' || e.kind === 'alley' || isRiverEdge(e) || e.bridge || e.shortcut) return;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const mx = (A.x + B.x) / 2;
    const mz = (A.z + B.z) / 2;
    const f = exp(-((mx - cx) ** 2 + (mz - cz) ** 2) / (CITY.downtownRadius * CITY.downtownRadius));
    const tier = f > F.core ? 0 : f > F.mid ? 1 : 2;
    edgeSides(g, mouths, ei).forEach((side) => {
      const ax = side.to.x - side.from.x;
      const az = side.to.z - side.from.z;
      const len = sqrt(ax * ax + az * az);
      const gaps = sidewalkGaps(len, side.phase, side.span);
      if (gaps.length < 2) return;
      const u = { x: ax / len, z: az / len };
      const yaw = atan2(side.inward.x, side.inward.z);
      const put = (kind: FurnitureKind, s: number): boolean =>
        tryPlace(kind, side.from.x + u.x * s - side.inward.x * SETBACK[kind], side.from.z + u.z * s - side.inward.z * SETBACK[kind], yaw, ei);
      /** A few tries in [lo, hi]. */
      const near = (kind: FurnitureKind, lo: number, hi: number) => {
        for (let t = 0; t < F.tries; t++) if (hi > lo && put(kind, rng.range(lo, hi))) return;
      };
      const roll = (k: Single) => rng.chance(F.chance[k][tier]);
      // Corner pieces: a hydrant at one end of the side, a mailbox at the other (either may be missing).
      // Only an end at a junction is a corner: a piece that goes on through a bend node has none there.
      const flip = rng.chance(0.5);
      const first = gaps[0];
      const last = gaps[gaps.length - 1];
      const cornerStart = side.span.before <= 1e-6;
      const cornerEnd = side.span.before + len >= side.span.total - 1e-6;
      const atStart = (kind: FurnitureKind) => cornerStart && near(kind, first.lo + 0.4, Math.min(first.hi - 0.4, first.lo + F.cornerReach));
      const atEnd = (kind: FurnitureKind) => cornerEnd && near(kind, Math.max(last.lo + 0.4, last.hi - F.cornerReach), last.hi - 0.4);
      if (roll('hydrant')) (flip ? atStart : atEnd)('hydrant');
      if (roll('mailbox')) (flip ? atEnd : atStart)('mailbox');
      // Mid block pieces in a random gap.
      const anyGap = (kind: FurnitureKind) => {
        const gp = gaps[rng.int(0, gaps.length - 1)];
        near(kind, gp.lo + 0.8, gp.hi - 0.8);
      };
      if (roll('phoneBooth')) anyGap('phoneBooth');
      if (roll('vendingMachine')) anyGap('vendingMachine');
      // Metered parking: a row in a couple of the interior gaps, at a shared pitch.
      if (rng.chance(F.meters[tier]) && gaps.length > 2) {
        const inner = gaps.slice(1, -1);
        rng.shuffle(inner);
        for (const gp of inner.slice(0, F.meterGaps)) {
          for (let s = gp.lo + 1 + rng.range(0, 2); s < gp.hi - 1; s += F.meterSpacing) put('parkingMeter', s);
        }
      }
    });
  });
}
