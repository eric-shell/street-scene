/**
 * The traffic cars themselves: a kind's collision tuning (trafficTuning), the seeded draws that pick a kind
 * and a turn, putting a car on a lane (place, syncBody) and the density that keeps a fixed number of them in a
 * bubble around the player (trySpawn, createTraffic). The stream (rng) and the pose scratch are shared with
 * traffic.ts, whose stepTraffic loads the stream from TrafficState, draws on it and saves it back.
 */
import type { World } from '../../city/world';
import { createCar } from '../car';
import { CarTuning, DEFAULT_CAR_ID, TRAFFIC, getBaseTuning } from '../tuning';
import { CRASH_EVENT, DT } from '../constants';
import { Rng, deriveSeed } from '../prng';
import { cos, sin, sqrt, wrapAngle } from '../math';
import type { RaceCar } from '../race';
import { TRAFFIC_LAYOUT, type TrafficCar, type TrafficNet, type TrafficState } from './types';
import { samplePath, trafficNet } from './net';

const L = TRAFFIC_LAYOUT;
const P = TRAFFIC;

const tuningCache: CarTuning[] = [];

/** Collision tuning of a traffic kind: the base car's contact numbers with the kind's size and mass. */
export function trafficTuning(kind: number): CarTuning {
  let t = tuningCache[kind];
  if (!t) {
    const base = getBaseTuning(DEFAULT_CAR_ID);
    const k = P.kinds[kind];
    t = { ...base, carId: `traffic:${k.name}`, mass: k.mass, yawInertiaScale: P.yawInertiaScale, geometry: { ...base.geometry, halfLength: k.halfLength, halfWidth: k.halfWidth } };
    tuningCache[kind] = t;
  }
  return t;
}

export const pose = { x: 0, z: 0, yaw: 0 };
export const rng = new Rng(0);

function pickKind(): number {
  let total = 0;
  for (const k of P.kinds) total += k.share;
  let u = rng.next() * total;
  for (let i = 0; i < P.kinds.length; i++) {
    u -= P.kinds[i].share;
    if (u < 0) return i;
  }
  return P.kinds.length - 1;
}

/** The path after `id`: a lane's turn picked by weight, or a connector's lane. */
export function choose(net: TrafficNet, id: number): number {
  const p = net.paths[id];
  if (!p.lane) return p.out[0];
  if (p.out.length === 1) return p.out[0];
  let total = 0;
  for (const c of p.out) total += net.paths[c].weight;
  let u = rng.next() * total;
  for (const c of p.out) {
    u -= net.paths[c].weight;
    if (u < 0) return c;
  }
  return p.out[p.out.length - 1];
}

/** Write the car's pose (path pose plus rejoin offset) and kinematic velocity into its body. */
export function syncBody(net: TrafficNet, c: TrafficCar, prevYaw: number): void {
  samplePath(net.paths[c.path], c.s, pose);
  const b = c.body;
  b.x = pose.x + c.ox;
  b.z = pose.z + c.oz;
  b.yaw = wrapAngle(pose.yaw + c.oyaw);
  b.vx = sin(b.yaw) * c.v;
  b.vz = cos(b.yaw) * c.v;
  b.yawRate = wrapAngle(b.yaw - prevYaw) / DT;
  b.speed = c.v;
}

/** Put a fresh car (new kind and driver) on a lane at distance s, already rolling at 80% of its cruise speed. */
function place(net: TrafficNet, c: TrafficCar, lane: number, s: number, tick: number): void {
  c.mode = 'drive';
  c.kind = pickKind();
  c.cruise = P.cruiseSpeed * (1 + P.cruiseJitter * (2 * rng.next() - 1));
  c.path = lane;
  c.next = choose(net, lane);
  c.after = choose(net, c.next);
  c.s = s;
  c.v = c.cruise * net.paths[lane].factor * 0.8;
  c.hold = -1;
  c.wait = 0;
  c.still = 0;
  c.ox = c.oz = c.oyaw = 0;
  c.born = tick;
  c.braking = false;
  samplePath(net.paths[lane], s, pose);
  syncBody(net, c, pose.yaw);
  c.body.yawRate = 0;
}

/**
 * Try to spawn car c on a random lane (length weighted) whose point lies
 * between minD and maxD from (fx, fz), at least `clear` from every race car
 * and spawnClear from every other traffic car. Bounded tries.
 */
export function trySpawn(t: TrafficState, world: World, c: TrafficCar, cars: readonly RaceCar[], fx: number, fz: number, minD: number, maxD: number, clear: number, tick: number, tries: number): boolean {
  const net = t.net;
  if (!net.lanes.length) return false;
  const total = net.laneCum[net.laneCum.length - 1];
  for (let k = 0; k < tries; k++) {
    const u = rng.next() * total;
    let lo = 0;
    let hi = net.laneCum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (net.laneCum[mid] > u) hi = mid;
      else lo = mid + 1;
    }
    const lane = net.lanes[lo];
    const p = net.paths[lane];
    const span = p.length - 2 * L.spawnEnd;
    const s = span > 0 ? L.spawnEnd + rng.next() * span : p.length / 2;
    samplePath(p, s, pose);
    const d = sqrt((pose.x - fx) ** 2 + (pose.z - fz) ** 2);
    if (d < minD || d > maxD) continue;
    // Not on a level crossing's tracks (city/levelCrossings.ts).
    if (world.levelCrossings?.some((lc) => (lc.x - pose.x) ** 2 + (lc.z - pose.z) ** 2 < (lc.gate + L.gateSpawnClear) ** 2)) continue;
    let ok = true;
    for (const rc of cars) {
      if ((rc.state.x - pose.x) ** 2 + (rc.state.z - pose.z) ** 2 < clear * clear) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (const o of t.cars) {
      if (o === c || o.mode === 'gone') continue;
      if ((o.body.x - pose.x) ** 2 + (o.body.z - pose.z) ** 2 < L.spawnClear * L.spawnClear) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    place(net, c, lane, s, tick);
    return true;
  }
  return false;
}

/**
 * Traffic for a new race: count by mode, spread over the bubble around the
 * player's start; `discreet` keeps the first cars as far out as respawns go
 * (the player is already on screen when a race starts off the grid).
 */
export function createTraffic(world: World, cars: readonly RaceCar[], seed: number, openWorld: boolean, discreet = false): TrafficState {
  const net = trafficNet(world);
  const count = openWorld ? L.count.openWorld : L.count.race;
  rng.setState(deriveSeed(seed, 'traffic'));
  const t: TrafficState = { net, cars: [], rng: 0 };
  const focus = cars[0]?.state;
  for (let i = 0; i < count; i++) {
    const body = createCar(0, 0, 0, 0);
    const c: TrafficCar = { id: i, kind: 0, mode: 'gone', path: -1, next: -1, after: -1, s: 0, v: 0, cruise: 0, hold: -1, wait: 0, still: 0, ox: 0, oz: 0, oyaw: 0, born: 0, hitTick: -CRASH_EVENT.gap, braking: false, body };
    t.cars.push(c);
    if (focus) trySpawn(t, world, c, cars, focus.x, focus.z, discreet ? L.spawnMin : 0, L.bubble * 0.9, L.startClear, 0, 60);
  }
  t.rng = rng.getState();
  return t;
}
