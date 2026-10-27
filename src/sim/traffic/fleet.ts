/**
 * The traffic cars themselves: a kind's collision tuning (trafficTuning), the seeded draws that pick a kind
 * and a turn, putting a car on a lane (place, syncBody) and the density that keeps a fixed number of them in a
 * bubble around the player (trySpawn, createTraffic). The stream (rng) and the pose scratch are shared with
 * traffic.ts, whose stepTraffic loads the stream from TrafficState, draws on it and saves it back.
 *
 * The kerb's parked cars (city/parking.ts) follow the moving fleet in TrafficState.cars, one per occupied
 * slot of the world's plan, in mode 'parked' (parkHome). They draw nothing from the stream, so the moving
 * fleet is the same with them as without, and they are never recycled into it.
 */
import type { World } from '../../city/world';
import { planParking } from '../../city/parking';
import { SpatialGrid } from '../../city/spatial';
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
      // Parked cars stand clear of every lane (their rows moved it); one struck loose counts.
      if (o === c || o.mode === 'gone' || o.mode === 'parked') continue;
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
  const t: TrafficState = { net, cars: [], fleet: count, unparked: [], rng: 0 };
  const focus = cars[0]?.state;
  for (let i = 0; i < count; i++) {
    const body = createCar(0, 0, 0, 0);
    const c: TrafficCar = { id: i, kind: 0, mode: 'gone', home: -1, path: -1, next: -1, after: -1, s: 0, v: 0, cruise: 0, hold: -1, wait: 0, still: 0, ox: 0, oz: 0, oyaw: 0, born: 0, hitTick: -CRASH_EVENT.gap, braking: false, body };
    t.cars.push(c);
    if (focus) trySpawn(t, world, c, cars, focus.x, focus.z, discreet ? L.spawnMin : 0, L.bubble * 0.9, L.startClear, 0, 60);
  }
  // The kerb's parked cars, after the moving fleet (whose ids and draws they leave alone).
  const parked = planParking(world).cars;
  for (let h = 0; h < parked.length; h++) {
    const kind = kindIndex(parked[h].kind);
    const c: TrafficCar = { id: count + h, kind, mode: 'parked', home: h, path: -1, next: -1, after: -1, s: 0, v: 0, cruise: 0, hold: -1, wait: 0, still: 0, ox: 0, oz: 0, oyaw: 0, born: 0, hitTick: -CRASH_EVENT.gap, braking: false, body: createCar(0, 0, 0, 0) };
    t.cars.push(c);
    parkHome(t, world, c, 0);
  }
  t.rng = rng.getState();
  return t;
}

const kindIndices = new Map<string, number>();

/** Index into TRAFFIC.kinds of a kind name (city/parking.ts names its kinds; drivingParams.json must have them). */
function kindIndex(name: string): number {
  let k = kindIndices.get(name);
  if (k === undefined) {
    k = P.kinds.findIndex((kd) => kd.name === name);
    if (k < 0) throw new Error(`PARKING kind "${name}" is not in drivingParams.json traffic.kinds`);
    kindIndices.set(name, k);
  }
  return k;
}

/** Stand a parked car in its slot at rest (at creation, and back from loose), `tick` as its fresh spawn. */
export function parkHome(t: TrafficState, world: World, c: TrafficCar, tick: number): void {
  const slot = planParking(world).cars[c.home];
  const k = t.unparked.indexOf(c.id);
  if (k >= 0) t.unparked.splice(k, 1);
  const b = c.body;
  c.mode = 'parked';
  c.v = 0;
  c.still = 0;
  c.braking = false;
  c.born = tick;
  b.x = slot.x;
  b.z = slot.z;
  b.yaw = slot.yaw;
  b.y = world.heightAt(slot.x, slot.z);
  b.vx = 0;
  b.vz = 0;
  b.yawRate = 0;
  b.speed = 0;
}

/** Mark a parked car struck out of its slot (keeps TrafficState.unparked ascending). */
export function unparkCar(t: TrafficState, c: TrafficCar): void {
  const u = t.unparked;
  if (u.includes(c.id)) return;
  let k = u.length;
  u.push(c.id);
  while (k > 0 && u[k - 1] > c.id) {
    u[k] = u[k - 1];
    k--;
  }
  u[k] = c.id;
}

/** Broadphase over the kerb slots of a world (slot index per point), built once and cached. */
const slotGrids = new WeakMap<World, SpatialGrid>();

function slotGrid(world: World): SpatialGrid {
  let g = slotGrids.get(world);
  if (!g) {
    const b = world.graph.bounds;
    g = SpatialGrid.forBounds(b.minX - L.parkCell, b.minZ - L.parkCell, b.maxX + L.parkCell, b.maxZ + L.parkCell, L.parkCell);
    planParking(world).cars.forEach((s, h) => g!.insertBox(h, s.x, s.z, s.x, s.z));
    slotGrids.set(world, g);
  }
  return g;
}

const slotScratch: number[] = [];

/**
 * Car ids (ascending) of the parked cars still standing in their slots within
 * `r` (m, a box) of (x, z): the per tick contact and lookahead loops ask this
 * instead of walking every kerb in the city.
 */
export function parkedNear(t: TrafficState, world: World, x: number, z: number, r: number, out: number[]): number[] {
  out.length = 0;
  if (t.cars.length === t.fleet) return out;
  slotGrid(world).query(x - r, z - r, x + r, z + r, slotScratch);
  for (const h of slotScratch) {
    const c = t.cars[t.fleet + h];
    if (c.mode === 'parked') out.push(c.id);
  }
  return out;
}
