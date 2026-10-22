/**
 * Level crossings in the sim (city/levelCrossings.ts builds them). Their
 * gates are timed gates (sim/gates.ts) for ambient traffic stopping, the lost
 * timer and the HUD, but no wall: a car that drives through a lowered arm
 * snaps it off (RaceState.brokenArms, an 'arm' event) and loses the momentum
 * the arm's mass takes, nothing more; racers time their run over the tracks
 * by the trains (TimedGate.train). The one hard thing here is the train:
 * while one is on the street (crossingTrain) its body is a wall across the
 * corridor on its track (collideTrains, from sim/collision.ts for every car
 * circle), so a car that comes at it stops against its side. A car already
 * on the rails when the train comes (it stopped there, spun there) is towed
 * off, put at a standstill behind the nearer gate facing the way it was
 * heading along the street, with a 'reset' event, the way the drawbridge
 * clears its span (sim/hazards.ts); ambient traffic caught there is recycled
 * (sim/traffic.ts). Pure and deterministic: a schedule lookup per crossing
 * per tick, a box against two arms per car while the arms are down, and a
 * point test per car while a train is on the street.
 */
import type { Contact, World } from '../city/world';
import type { RaceState } from './race';
import { CROSSING, crossingTrain, type LevelCrossing } from '../city/levelCrossings';
import { gatePhase, newGatePhase } from './gates';
import { relocateCar } from './reset';
import { abs, clamp, cos, sin, yawOf } from './math';

/** A towed car is put this far behind the gate line (m). */
const TOW_BACK = 4;
/** A car whose center is within the train's half width plus this (m) is on the rails when it comes: towed, not pushed. */
const TOW_SLACK = 0.3;
/** Arms down past this share of their travel are in a car's way (0 up, 1 down). */
const ARM_LOW = 0.5;

/** Is (x, z) within `reach` m of the centerline of a track a train occupies (`on`, crossingTrain), inside the street corridor? */
function onOccupiedTrack(lc: LevelCrossing, on: number, x: number, z: number, reach: number): boolean {
  const dx = x - lc.x;
  const dz = z - lc.z;
  if (abs(-dx * lc.rz + dz * lc.rx) > lc.half + 0.5) return false;
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
    if (on >= 0 && onOccupiedTrack(lc, on, x, z, CROSSING.trainHalf + halfWidth)) return true;
  }
  return false;
}

/**
 * Contacts of one car circle (center x, z, radius r) with the trains on the
 * level crossings at `tick`, for the car whose body center is (carX, carZ):
 * each occupied track is a wall either side of the train's body, across the
 * street corridor, pushing toward the side the car's center is on. A car
 * whose center is in the train already is left to the tow (stepLevelCrossings).
 * Pushed onto `out` (kind 'wall') with -1 onto `pieces`; returns how many.
 */
export function collideTrains(world: World, tick: number, carX: number, carZ: number, x: number, z: number, r: number, out: Contact[], pieces: number[]): number {
  const list = world.levelCrossings;
  const set = world.timedGates;
  if (!list || !list.length || !set) return 0;
  let added = 0;
  for (const lc of list) {
    const dx = x - lc.x;
    const dz = z - lc.z;
    if (dx * dx + dz * dz > (lc.half + lc.gate + r + 4) ** 2) continue;
    // Within the corridor: beyond it the El's fences close the right of way.
    if (abs(-dx * lc.rz + dz * lc.rx) > lc.half + 0.5) continue;
    const on = crossingTrain(lc, set.cycles[lc.cycle], tick);
    if (on < 0) continue;
    for (const k of [0, 1] as const) {
      if (on !== 2 && on !== k) continue;
      const ox = lc.x + lc.rx * lc.tracks[k];
      const oz = lc.z + lc.rz * lc.tracks[k];
      // Signed distance off the track's centerline, along (tz, -tx).
      const dc = (carX - ox) * lc.tz - (carZ - oz) * lc.tx;
      if (abs(dc) < CROSSING.trainHalf + TOW_SLACK) continue;
      const side = dc > 0 ? 1 : -1;
      const sd = ((x - ox) * lc.tz - (z - oz) * lc.tx) * side - CROSSING.trainHalf;
      if (sd >= r) continue;
      const nx = lc.tz * side;
      const nz = -lc.tx * side;
      out.push({ nx, nz, depth: r - sd, px: x - nx * sd, pz: z - nz * sd, kind: 'wall' });
      pieces.push(-1);
      added++;
    }
  }
  return added;
}

/** Does the segment (ax, az)-(bx, bz) cross a box of half sizes hl (along yaw) and hw centered at (x, z)? */
function segmentHitsBox(x: number, z: number, yaw: number, hl: number, hw: number, ax: number, az: number, bx: number, bz: number): boolean {
  const fx = sin(yaw);
  const fz = cos(yaw);
  // Car space: u forward, v to the right (fz, -fx).
  const au = (ax - x) * fx + (az - z) * fz;
  const av = (ax - x) * fz - (az - z) * fx;
  const du = (bx - x) * fx + (bz - z) * fz - au;
  const dv = (bx - x) * fz - (bz - z) * fx - av;
  // Liang-Barsky against the four sides.
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-du, au + hl) && clip(du, hl - au) && clip(-dv, av + hw) && clip(dv, hw - av);
}

const armPhase = newGatePhase();

/**
 * Every race car on the level crossings, once a tick (from stepHazards): one
 * through a lowered arm snaps it off, one the train meets on the rails is
 * towed off them. Arms are RaceState.brokenArms[gate * 2 + half], half 0
 * from the gate's a end to the middle, 1 from the middle to b.
 */
export function stepLevelCrossings(r: RaceState): void {
  const list = r.world.levelCrossings;
  const set = r.world.timedGates;
  if (!list || !list.length || !set) return;
  for (const lc of list) {
    if (gatePhase(set.cycles[lc.cycle], r.tick, armPhase).arm >= ARM_LOW) breakArms(r, lc);
    const on = crossingTrain(lc, set.cycles[lc.cycle], r.tick);
    if (on < 0) continue;
    for (const rc of r.cars) {
      const c = rc.state;
      if (!onOccupiedTrack(lc, on, c.x, c.z, CROSSING.trainHalf + TOW_SLACK)) continue;
      const dx = c.x - lc.x;
      const dz = c.z - lc.z;
      const q = -dx * lc.rz + dz * lc.rx;
      const end = dx * lc.rx + dz * lc.rz >= 0 ? 1 : -1;
      const dir = sin(c.yaw) * lc.rx + cos(c.yaw) * lc.rz >= 0 ? 1 : -1;
      const at = end * (lc.gate + TOW_BACK);
      const lat = clamp(q, -(lc.half - 2), lc.half - 2);
      relocateCar(r, rc, lc.x + lc.rx * at - lc.rz * lat, lc.z + lc.rz * at + lc.rx * lat, yawOf(lc.rx * dir, lc.rz * dir), true);
    }
  }
}

/** Snap off every intact, lowered arm of a crossing a race car's body is through, in car order. */
function breakArms(r: RaceState, lc: LevelCrossing): void {
  const set = r.world.timedGates!;
  for (const gi of lc.gates) {
    const g = set.gates[gi];
    const mx = (g.ax + g.bx) / 2;
    const mz = (g.az + g.bz) / 2;
    for (const rc of r.cars) {
      const c = rc.state;
      if ((c.x - g.cx) ** 2 + (c.z - g.cz) ** 2 > (g.half + rc.tuning.geometry.halfLength + 1) ** 2) continue;
      for (let h = 0; h < 2; h++) {
        const arm = gi * 2 + h;
        if (r.brokenArms[arm]) continue;
        const geo = rc.tuning.geometry;
        if (!segmentHitsBox(c.x, c.z, c.yaw, geo.halfLength, geo.halfWidth, h ? mx : g.ax, h ? mz : g.az, h ? g.bx : mx, h ? g.bz : mz)) continue;
        // Inelastic along the gate's normal with the arm's mass: v_n' = v_n * m / (m + m_arm).
        const vn = c.vx * g.nx + c.vz * g.nz;
        const dv = (vn * CROSSING.armMass) / (rc.tuning.mass + CROSSING.armMass);
        c.vx -= dv * g.nx;
        c.vz -= dv * g.nz;
        r.brokenArms[arm] = 1;
        r.events.push({ tick: r.tick, type: 'arm', car: rc.index, value: arm });
      }
    }
  }
}
