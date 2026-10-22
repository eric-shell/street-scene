/**
 * Per tick step of the timed hazards, for what their gates alone cannot do.
 * The drawbridge (city/drawbridge.ts): the sim keeps its deck at street
 * level, so a car still on the span when the leaves start up (it stopped
 * there, or crashed there, through the seconds the gates stood closed with
 * the leaves flat) is towed off: put at a standstill on the approach behind
 * the nearer gate, facing the way it was heading along the bridge, with a
 * 'reset' event like any reset to the road. No car is ever left on a raised
 * leaf. A car on the channel floor under the span (the sim's lower level,
 * see World.heightAt) is not on it. Pure and deterministic; costs nothing
 * while the leaves are down and a point test per car while they are up.
 */
import type { RaceState } from './race';
import { DRAWBRIDGE, leafAngle, onSpan, spanCoords } from '../city/drawbridge';
import { placeCar } from './car';
import { stepLevelCrossings } from './levelCrossing';
import { clamp, cos, sin, yawOf } from './math';

export function stepHazards(r: RaceState): void {
  // Level crossings (sim/levelCrossing.ts): arms snap under cars, a car left on the tracks when a train comes is towed off.
  stepLevelCrossings(r);
  const db = r.world.drawbridge;
  const set = r.world.timedGates;
  if (!db || !set) return;
  if (leafAngle(db, set, r.tick) <= 0) return;
  for (const rc of r.cars) {
    const c = rc.state;
    if (!onSpan(db, c.x, c.z, DRAWBRIDGE.towMargin)) continue;
    // Under the span, on the channel floor: below the deck by more than half the channel's depth.
    if (c.y < r.world.heightAt(c.x, c.z) - DRAWBRIDGE.underDeck) continue;
    const { u, w } = spanCoords(db, c.x, c.z);
    const end = u >= 0 ? 1 : -1;
    const dir = sin(c.yaw) * db.dx + cos(c.yaw) * db.dz >= 0 ? 1 : -1;
    const at = end * (db.gate + DRAWBRIDGE.towBack);
    const lat = clamp(w, -(db.road - 1.5), db.road - 1.5);
    placeCar(c, db.cx + db.dx * at + db.nx * lat, db.cz + db.dz * at + db.nz * lat, yawOf(db.dx * dir, db.dz * dir), r.world);
    rc.resetCooldown = 1;
    rc.stuckTime = 0;
    rc.wrongWayTime = 0;
    if (rc.ai) rc.ai.idx = -1;
    r.events.push({ tick: r.tick, type: 'reset', car: rc.index });
  }
}
