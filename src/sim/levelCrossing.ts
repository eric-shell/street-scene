/**
 * Level crossings in the sim (city/levelCrossings.ts builds them). Their
 * gates are ordinary timed gates (sim/gates.ts): collision, AI braking and
 * waiting, ambient traffic stopping and the lost timer all come from there.
 * What a gate cannot do is here: a car still on the tracks when a train
 * reaches the street (it stopped there, spun there, or a gate came down with
 * it already past the line and it never drove out) is towed off, put at a
 * standstill behind the nearer gate facing the way it was heading along the
 * street, with a 'reset' event, the way the drawbridge clears its span
 * (sim/hazards.ts); ambient traffic caught there is recycled (sim/traffic.ts).
 * The gates close early enough that a moving car is always across before the
 * train (CROSSING.downBefore), and nobody is trapped (a car past a gate line
 * drives out freely), so only a car that stays on the rails meets the train,
 * and it loses the time the train takes to pass. Pure and deterministic: a
 * schedule lookup per crossing per tick, and a point test per car while a
 * train is on the street.
 */
import type { World } from '../city/world';
import type { RaceState } from './race';
import type { LevelCrossing } from '../city/levelCrossings';
import { CROSSING, crossingTrain } from '../city/levelCrossings';
import { placeCar } from './car';
import { abs, clamp, cos, sin, yawOf } from './math';

/** A towed car is put this far behind the gate line (m). */
const TOW_BACK = 4;

/** Is (x, z), with a body `halfWidth` m wide either side, on a track a train occupies at `tick` (inside the street corridor)? */
function onOccupiedTrack(lc: LevelCrossing, on: number, x: number, z: number, halfWidth: number): boolean {
  const dx = x - lc.x;
  const dz = z - lc.z;
  if (abs(-dx * lc.rz + dz * lc.rx) > lc.half + 0.5) return false;
  const reach = CROSSING.trainHalf + halfWidth;
  for (const k of [0, 1] as const) {
    if (on !== 2 && on !== k) continue;
    const ox = dx - lc.rx * lc.tracks[k];
    const oz = dz - lc.rz * lc.tracks[k];
    if (abs(ox * lc.tz - oz * lc.tx) < reach) return true;
  }
  return false;
}

/** True while a train is on a level crossing's track right where (x, z) is (a body `halfWidth` m either side). */
export function trainAt(world: World, tick: number, x: number, z: number, halfWidth: number): boolean {
  const list = world.levelCrossings;
  const set = world.timedGates;
  if (!list || !list.length || !set) return false;
  for (const lc of list) {
    if ((x - lc.x) ** 2 + (z - lc.z) ** 2 > (lc.half + lc.gate + 4) ** 2) continue;
    const on = crossingTrain(lc, set.cycles[lc.cycle], tick);
    if (on >= 0 && onOccupiedTrack(lc, on, x, z, halfWidth)) return true;
  }
  return false;
}

/** Tow every race car a train meets on a level crossing (called from stepHazards each tick). */
export function stepLevelCrossings(r: RaceState): void {
  const list = r.world.levelCrossings;
  const set = r.world.timedGates;
  if (!list || !list.length || !set) return;
  for (const lc of list) {
    const on = crossingTrain(lc, set.cycles[lc.cycle], r.tick);
    if (on < 0) continue;
    for (const rc of r.cars) {
      const c = rc.state;
      if (!onOccupiedTrack(lc, on, c.x, c.z, rc.tuning.geometry.halfWidth)) continue;
      const dx = c.x - lc.x;
      const dz = c.z - lc.z;
      const q = -dx * lc.rz + dz * lc.rx;
      const end = dx * lc.rx + dz * lc.rz >= 0 ? 1 : -1;
      const dir = sin(c.yaw) * lc.rx + cos(c.yaw) * lc.rz >= 0 ? 1 : -1;
      const at = end * (lc.gate + TOW_BACK);
      const lat = clamp(q, -(lc.half - 2), lc.half - 2);
      placeCar(c, lc.x + lc.rx * at - lc.rz * lat, lc.z + lc.rz * at + lc.rx * lat, yawOf(lc.rx * dir, lc.rz * dir), r.world);
      rc.resetCooldown = 1;
      rc.stuckTime = 0;
      rc.wrongWayTime = 0;
      if (rc.ai) rc.ai.idx = -1;
      r.events.push({ tick: r.tick, type: 'reset', car: rc.index });
    }
  }
}
