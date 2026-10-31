/**
 * Where the Scrapyard's pieces go in its region (districts/scrapyard.ts plans with this).
 *
 * The region (weekendRegion.ts): three or four cells along a sweeping spine and three or four across (SCRAPYARD_SHAPES),
 * carved before anything plans; the routes drive the spine end to end (world.ts planRoads). The yard fills all of it
 * (scrapyardLayout.ts), laid out in a frame from the race's entry junction (raceDirection: the circuit's way along the spine,
 * so both kickers face the way the race comes) with `d` positive toward the shallower side of the spine, measured at its
 * middle: the Canyon, the Bale Deck and the Perimeter there, the Eight on the deeper side.
 *
 * planScrapyard stores the frame's choices and the bowls' crest radius in the area's params (`dir`, `side`, `R`), the largest
 * of CFG.crestRadii whose Eight fits the deep side with its fence room and leaves the shallow side deep enough for the canyon
 * and the perimeter; a region nothing fits in builds nothing and promises nothing (none of the declared shapes is that cramped).
 */
import { CITY } from '../config';
import type { PlanContext } from './types';
import { planRegion, raceDirection } from './weekendRegion';
import type { WeekendShape } from './weekendRegion';
import { makeFrame } from './scrapyardShapes';
import { eightGeometry, sideDepth } from './scrapyardLayout';

const C = CITY.districts.scrapyard;

/** Region shapes (weekendRegion.ts): squarer than the other two, the spine free to sweep. */
export const SCRAPYARD_SHAPES: readonly WeekendShape[] = [
  { along: 3, across: 3 },
  { along: 4, across: 3 },
  { along: 3, across: 4 },
];

/** Least chord (m) the five lines need end to end: the canyon's mouth, the deck's ramps and flat, the perimeter's legs. */
const MIN_CHORD = C.deck.start + C.deck.endClear + 2 * C.deck.ramp + 60;
/** Least depth (m) the shallow side needs: the canyon at its shallowest, its back room and the perimeter. */
const MIN_SHALLOW = 30 + C.canyon.backRoom;

/** Plan the seed's Scrapyard in its region: the frame's side and direction and the bowls' size, or nothing built (and nothing promised). */
export function planScrapyard(ctx: PlanContext): void {
  if (!C.enabled) return;
  const r = planRegion(ctx, 'scrapyard');
  if (!r || !r.area.params.planned || r.area.params.R) return;
  const area = r.area;
  const dir = raceDirection(area);
  const rp = dir > 0 ? r.path : r.path.slice().reverse();
  // The shallow side at the spine's middle (and a little either way, in case one end of the region is notched).
  const probe = makeFrame(rp, 1);
  const depth = (sign: 1 | -1) => Math.min(...[0.35, 0.5, 0.65].map((f) => sideDepth(probe, r.polygon, probe.len * f, sign)));
  const side: 1 | -1 = depth(1) <= depth(-1) ? 1 : -1;
  const F = makeFrame(rp, side);
  const shallow = Math.min(...[0.2, 0.35, 0.5, 0.65, 0.8].map((f) => sideDepth(F, r.polygon, F.len * f, 1)));
  if (F.len >= MIN_CHORD && shallow >= MIN_SHALLOW) {
    for (const R of C.crestRadii) {
      const G = eightGeometry(F, R);
      // The Eight's far side, and its two outer ends, keep the dirt shoulder and a fence's worth of room inside the ring.
      const need = -G.cBd + G.reach + C.eight.dirt + 6;
      const spanOk = G.cBu - 3 * G.reach - C.eight.dirt > C.deck.start - 40 && G.cBu + G.reach + C.eight.dirt < F.len - 40;
      const deep = Math.min(...[-1.5, -1, 0, 1].map((k) => sideDepth(F, r.polygon, G.cBu - G.reach + k * G.reach, -1)));
      if (spanOk && deep >= need) {
        Object.assign(area.params, { R, side, dir, cuts: 0 });
        return;
      }
    }
  }
  area.params.planned = 0;
  area.params.special = 0;
}
