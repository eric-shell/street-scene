/**
 * Shop glass broken by the cars, from the sim's wall events: a hard `wall` hit (the event carries no position) is
 * placed from the car's pose and velocity onto the glass bay it is driving into (render/street/glassBreak.ts), which
 * then breaks for the rest of the race, throws a burst of shards (render/street/glassShards.ts) and sounds the
 * shatter. Replays raise the same wall events, so they break the same bays. Render and audio only.
 */
import type { RaceState } from '../../sim/race';
import type { RaceEvent } from '../../sim/race';
import type { GlassBays } from '../../render/street/glassBreak';
import { GLASS } from '../../render/street/glassBreak';
import { SHARDS } from '../../render/street/glassShards';
import type { GlassShards } from '../../render/street/glassShards';
import { GROUND_H } from '../../render/buildings/facadeKit';
import type { Sfx } from '../../audio/sfx';
import type { Snap } from './snap';

/** The window's lowest point above the road (m): the sill. */
const SILL = 0.35;

/**
 * Break the bay that wall event `e` hit, if it was a hard hit on one; true when glass broke. `before` is the cars'
 * poses before the tick that raised the event: the hit torques the car, so its heading afterwards is no guide.
 */
export function breakGlass(bays: GlassBays | null, shards: GlassShards, sfx: Sfx | null, race: RaceState, before: readonly Snap[], time: number, e: RaceEvent, isPlayer: boolean): boolean {
  const speed = e.value ?? 0;
  if (!bays || e.type !== 'wall' || (e.kind !== undefined && e.kind !== 'wall') || speed < GLASS.minSpeed) return false;
  const rc = race.cars[e.car];
  if (!rc) return false;
  const c = rc.state;
  const p = before[e.car] ?? c;
  const id = bays.find(p.x, p.z, p.yaw, rc.tuning.geometry.halfLength + 0.3);
  if (id < 0 || !bays.breakBay(id)) return false;
  const b = bays.bays[id];
  const ground = race.world.heightAt(b.x, b.z);
  const k = Math.min(1, speed / SHARDS.fullSpeed);
  shards.burst(time, b.x, b.z, b.nx, b.nz, b.halfLen, ground + SILL, ground + GROUND_H - 0.2, ground, c.vx, c.vz, SHARDS.burst[0] + (SHARDS.burst[1] - SHARDS.burst[0]) * k);
  sfx?.glassBreak(speed, sfx.at(b.x, b.z, isPlayer), `glass:${id}`);
  return true;
}
