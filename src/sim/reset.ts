/**
 * Putting a car back down as a reset: resetToRoad and resetToStreet (sim/race.ts), and the tow off a level
 * crossing's tracks (sim/levelCrossing.ts). The car stands still
 * where it is put (placeCar), gets a second's cooldown before the next reset, its stuck and wrong way timers
 * cleared, and the race a 'reset' event. Pure and deterministic.
 */
import type { RaceCar, RaceState } from './race';
import { placeCar } from './car';

/**
 * Put `rc` down at (x, z) facing `yaw` as a reset. `tow`: a hazard moved it off its racing line's track,
 * so an AI also looks for its place on its line again (a reset to the road keeps the place it had).
 */
export function relocateCar(r: RaceState, rc: RaceCar, x: number, z: number, yaw: number, tow = false): void {
  placeCar(rc.state, x, z, yaw, r.world);
  rc.resetCooldown = 1;
  rc.stuckTime = 0;
  rc.wrongWayTime = 0;
  if (tow && rc.ai) rc.ai.idx = -1;
  r.events.push({ tick: r.tick, type: 'reset', car: rc.index });
}
