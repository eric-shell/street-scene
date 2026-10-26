/**
 * Putting a car back down as a reset: resetToRoad and resetToStreet (sim/race.ts), and the tow off a level
 * crossing's tracks (sim/levelCrossing.ts), and free roam's teleport (teleportCar). The car stands still
 * where it is put (placeCar), gets a second's cooldown before the next reset, a few seconds passing through
 * other cars (collision.resetPassThrough, as racing games do, so a reset never lands in a pile up), its stuck
 * and wrong way timers cleared, and the race a 'reset' event. It costs nitrous (nitrous.resetLoss, the whole
 * tank and overdrive as tuned), so a reset is a way out of trouble rather than a free shortcut past it;
 * a teleport, asked for rather than needed, costs nothing and raises no event. Pure and deterministic.
 */
import type { RaceCar, RaceState } from './race';
import { placeCar } from './car';

/**
 * Put `rc` down at (x, z) facing `yaw` as a reset. `tow`: a hazard moved it off its racing line's track,
 * so an AI also looks for its place on its line again (a reset to the road keeps the place it had).
 * `y` picks the level where two stack (World.heightAt): the highway's deck for a car put back up there.
 */
export function relocateCar(r: RaceState, rc: RaceCar, x: number, z: number, yaw: number, tow = false, y?: number): void {
  placeCar(rc.state, x, z, yaw, r.world, y);
  const c = rc.state;
  const keep = 1 - rc.tuning.nitrous.resetLoss;
  c.nitroReset += (c.nitro + c.nitroOver) * (1 - keep);
  c.nitro *= keep;
  c.nitroOver *= keep;
  // A button held through the reset counts its chain from what is left, not from the tank it had.
  c.nitroRun = -1;
  settle(rc, tow);
  r.events.push({ tick: r.tick, type: 'reset', car: rc.index });
}

/**
 * Put `rc` down at (x, z) facing `yaw` as free roam's teleport (sim/race.ts teleportToStreet): standing
 * still with the reset's cooldown and pass through, its nitrous kept and no 'reset' event (the session says
 * where it went). Asked for between ticks while the map is open; free roam keeps no replay.
 */
export function teleportCar(r: RaceState, rc: RaceCar, x: number, z: number, yaw: number): void {
  placeCar(rc.state, x, z, yaw, r.world);
  settle(rc, true);
}

/** What every put down shares: a second before the next reset, a spell passing through cars, the lost timers cleared. */
function settle(rc: RaceCar, tow: boolean): void {
  rc.resetCooldown = 1;
  rc.passThrough = rc.tuning.collision.resetPassThrough;
  rc.stuckTime = 0;
  rc.wrongWayTime = 0;
  if (tow && rc.ai) rc.ai.idx = -1;
}
