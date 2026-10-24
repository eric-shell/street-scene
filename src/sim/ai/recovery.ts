/**
 * Reverse-out recovery for an AI car pinned nose in against something. recoverInput decides when the car is
 * stuck (pressing on but not moving, with noseBlocked saying something solid is at the nose) and then drives
 * the reverse manoeuvre, swinging the nose toward the line, until the car points at it or time runs out.
 * Timed-gate waiting is not recovery: aiInput switches this off there.
 */
import type { RaceCar, RaceState } from '../race';
import { DEG, abs, atan2, cos, sign, sin } from '../math';
import { DT } from '../constants';
import { trafficAhead } from '../traffic';
import { AI } from './drivers';

/**
 * Reverse-out recovery. Pressing on below blockedSpeed for blockedTime means
 * the car is pinned (nose in against a wall, rail, barrier or another car):
 * brake into reverse with the steering flipped so the nose swings toward the
 * target, until it points at it (after reverseMin) or reverseTime runs out.
 * Returns the override, or null when driving normally.
 */
export function recoverInput(r: RaceState, rc: RaceCar, steer: number, throttle: number, tx: number, tz: number): { throttle: number; brake: number; steer: number } | null {
  const ai = rc.ai!;
  const c = rc.state;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const dx = tx - c.x;
  const dz = tz - c.z;
  // Heading error to the target, positive = target to the left.
  const herr = atan2(dx * fz - dz * fx, dx * fx + dz * fz);
  if (ai.reverse > 0) {
    ai.reverse -= DT;
    ai.reversed += DT;
    if (ai.reverse <= 0 || (ai.reversed > AI.reverseMin && abs(herr) < AI.reverseDoneDeg * DEG)) {
      ai.reverse = 0;
      ai.blocked = 0;
      return null;
    }
    return { throttle: 0, brake: 1, steer: ai.reverseSteer };
  }
  if (c.gear > 0 && throttle > 0.25 && c.speed < AI.blockedSpeed && r.tick >= r.countdownTicks && noseBlocked(r, rc)) ai.blocked += DT;
  else ai.blocked = Math.max(0, ai.blocked - DT * 2);
  if (ai.blocked < AI.blockedTime) return null;
  ai.blocked = 0;
  ai.reverse = AI.reverseTime;
  ai.reversed = 0;
  // Reversing, positive steer (right) swings the nose left: steer toward the target side.
  ai.reverseSteer = abs(herr) < 0.05 ? -sign(steer || 1) : herr > 0 ? 1 : -1;
  return { throttle: 0, brake: 1, steer: ai.reverseSteer };
}

/** Something solid right at the nose: a wall, rail or barrier, or another car. */
function noseBlocked(r: RaceState, rc: RaceCar): boolean {
  const c = rc.state;
  const g = rc.tuning.geometry;
  const fx = sin(c.yaw);
  const fz = cos(c.yaw);
  const px = c.x + fx * (g.halfLength - g.halfWidth * 0.5);
  const pz = c.z + fz * (g.halfLength - g.halfWidth * 0.5);
  if (r.world.wallClearance(px, pz, 2, c.y) < g.halfWidth + AI.noseClear) return true;
  for (const o of r.cars) {
    if (o === rc) continue;
    const dx = o.state.x - c.x;
    const dz = o.state.z - c.z;
    const ahead = dx * fx + dz * fz;
    if (ahead > 0 && ahead < g.halfLength + o.tuning.geometry.halfLength + 0.6 && abs(dx * fz - dz * fx) < g.halfWidth + o.tuning.geometry.halfWidth) return true;
  }
  // A traffic car at the nose pins it just the same.
  return trafficAhead(r, c.x, c.z, fx, fz, g.halfLength + 3, g.halfWidth) !== 0;
}
