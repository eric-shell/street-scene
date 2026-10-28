/**
 * Ambient traffic: civilian cars as deterministic sim actors on the streets
 * the race does not use. They live on RaceState (`r.traffic`) and step once
 * per tick from stepRace, from their own seeded stream, so a replay of the
 * same config and inputs reproduces every one of them bit for bit.
 *
 * Where they drive (the network, built once per World and cached): one lane
 * per direction on every plain street kind (street, avenue, diagonal,
 * boulevard), keeping right; never alleys, back alley shortcuts, the
 * river's channel and ramps or a night market's street. In a race nothing
 * touches a route node either, so the route's edges, its shortcuts and every
 * closed side street (whose cyan closure and street meet stand at the route
 * end) are out: traffic loops in the off-route network and is seen crossing
 * beyond the barriers and on the cross streets. In an open world every other
 * street is open. Lanes
 * stop short of each junction where its curbs start; connectors (cubic
 * curves, or an arc around the island at a roundabout) join each incoming
 * lane to every outgoing one except the U-turn. Where roadworks shut the curb
 * lane (districts/roadworks.ts laneClosures), the lane on that side merges
 * out past the cones and barriers and back in. Lanes and connectors that
 * would rub a wall or leave the paving are dropped, then dead ends pruned,
 * so every lane always has a way on. That also keeps anything a district
 * builds in a street (now or later) out of the traffic's way.
 *
 * How they drive (kinematic, cheap and robust; no tire model): along their
 * path at a speed that is the minimum of the driver's cruise speed, the
 * curve limits of the next two paths and the braking profiles to the car
 * ahead (same lane or the next two paths, through per-path buckets), to the
 * stop line of a busy junction and to any foreign body ahead (race cars,
 * struck traffic). Where three or more traffic streets meet (or at a
 * roundabout) every connector is reserved before it is entered: the head car
 * of a lane (or the one right behind a car holding the same connector) asks
 * within braking distance, requests are served longest wait first, and one
 * is granted when the lane beyond has room (nobody blocks the box) and no
 * car holding a connector that crosses or merges with it (a table built with
 * the network) is still short of the end of the stretch the two share.
 * Opposite straights, right turns and platoons flow together; turns out of
 * the same lane follow each other through the start they share; a request
 * starved for a few seconds holds back the ones that conflict with it. The
 * reservation is released once the car's tail has left the junction.
 * Positions are also clamped so a driving car never advances into its
 * leader, which keeps driving cars from ever overlapping.
 *
 * Timed gates (sim/gates.ts: a level crossing's arms): every lane or connector
 * crossing a gate line from its holding side knows where. A driver stops
 * short of it whenever the gate is not open, or would close before the car
 * has cleared the crossing beyond it, unless it is already too close to stop;
 * so nobody is on the tracks when the train comes (and any car that still is,
 * after a crash say, is taken off them).
 *
 * The cable car (sim/cableCar.ts, sf seeds) is a foreign body ahead to every driver, and struck traffic that slides
 * into it meets it through the same contact (it is held to its cable).
 * Contact: race cars collide with traffic as solid bodies (collideCars), except
 * for a few seconds after a reset (collision.resetPassThrough). A
 * struck car turns loose: a passive body that slides, spins and scrapes off
 * walls to a stop, then, if it is close to its lane and roughly facing along
 * it, drives on, blending the offset out. One that cannot (or a driving car
 * stuck for long) is recycled once no race car is near. Hits raise 'crash'
 * events with `traffic` set (the car index), so the session plays the crash.
 *
 * Density: a fixed number of cars per mode kept in a bubble around the
 * player. Cars that drift out of it respawn on a lane between spawnMin and
 * spawnMax from the player and far from every race car, out of sight in the
 * night fog. Cost per tick is O(cars x race cars) with small constants.
 *
 * Kerb parking (city/parking.ts): every occupied slot of the world's plan is
 * a car in mode 'parked' after the moving fleet, standing at rest, never
 * driving and never recycled. Drivers do not look at them (their rows moved
 * the lanes clear); race cars and loose traffic meet them through the same
 * contact as any traffic car, so one struck turns loose and slides, skidding
 * on its locked wheels (traffic.parked.rollDecel). A struck parked car never
 * rejoins a lane or respawns as moving traffic: once it has stopped, or the
 * player has left it behind, and nobody sees either its spot or its slot, it
 * is put back in its slot, so a long free roam does not empty the kerbs.
 *
 * The parts live in traffic/: types (TRAFFIC_LAYOUT and the shared shapes), net (the network), fleet (the
 * cars: kinds, spawning, density). This module steps them each tick (stepTraffic) and answers what a driver
 * asks of them (trafficAhead), and is the public surface the rest of the sim imports.
 */
import { CarState } from './car';
import { CarTuning, TRAFFIC } from './tuning';
import { collideCarWithWorld, collideCars } from './collision';
import { CRASH_EVENT, DT, TICK_HZ } from './constants';
import { DEG, abs, approach, cos, exp, segmentT, sin, sqrt, wrapAngle } from './math';
import type { RaceEvent, RaceState } from './race';
import { GatePhase, gatePhase } from './gates';
import { trainAt } from './levelCrossing';
import { TRAFFIC_LAYOUT, type TrafficCar, type TrafficNet, type TrafficState } from './traffic/types';
import { samplePath } from './traffic/net';
import { choose, parkHome, parkedNear, pose, rng, syncBody, trafficTuning, trySpawn, unparkCar } from './traffic/fleet';
import { planParking } from '../city/parking';
import { cableCarAhead, cableTuning, holdCableCar } from './cableCar';
import { CABLE_CAR_BODY } from './tuning';

export { TRAFFIC_LAYOUT, type TrafficCar, type TrafficMode, type TrafficNet, type TrafficPath, type TrafficState } from './traffic/types';
export { trafficNet } from './traffic/net';
export { createTraffic, trafficTuning } from './traffic/fleet';

const L = TRAFFIC_LAYOUT;
const P = TRAFFIC;

const hl = (c: TrafficCar): number => P.kinds[c.kind].halfLength;
/** Lane length one car claims: the longest kind plus the standstill gap (m). */
const CAR_SPAN = 2 * Math.max(...P.kinds.map((k) => k.halfLength)) + P.standGap;
const hw = (c: TrafficCar): number => P.kinds[c.kind].halfWidth;

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/** Per-tick scratch: parked cars near a body, the loose cars of the contact pass, struck parked cars to check. */
const nearParked: number[] = [];
const looseIds: number[] = [];
const unparkIds: number[] = [];
/** Longest traffic half length (m): the reach the parked broadphase adds. */
const MAX_HL = Math.max(...P.kinds.map((k) => k.halfLength));

/** Per-tick scratch: driving cars bucketed by path (singly linked lists), junction requests. */
let bucketFirst = new Int32Array(0);
let bucketNext = new Int32Array(0);
const vAllow: number[] = [];
const advance: number[] = [];
const foreign: number[] = [];
/** Connector each car asks for this tick (-1: none), the asking cars in service order, the holders, the starved connectors. */
const ask: number[] = [];
const asking: number[] = [];
const holders: number[] = [];
const pending: number[] = [];

/** Pick another turn out of the lane than the planned one (by weight), when there is one. */
function reroute(net: TrafficNet, c: TrafficCar): void {
  const p = net.paths[c.path];
  if (!p.lane || p.out.length < 2) return;
  let total = 0;
  for (const o of p.out) if (o !== c.next) total += net.paths[o].weight;
  let u = rng.next() * total;
  let pick = -1;
  for (const o of p.out) {
    if (o === c.next) continue;
    pick = o;
    u -= net.paths[o].weight;
    if (u < 0) break;
  }
  c.next = pick;
  c.after = choose(net, pick);
  c.wait = 0;
}

function release(c: TrafficCar): void {
  c.hold = -1;
}

function turnLoose(t: TrafficState, c: TrafficCar): void {
  if (c.home >= 0) unparkCar(t, c);
  release(c);
  c.mode = 'loose';
  c.still = 0;
  c.wait = 0;
  c.braking = true;
  // Recovery rejoins the lane: a car hit inside a junction rejoins the lane it was leaving into (a parked car has none).
  if (c.home < 0 && !t.net.paths[c.path].lane) {
    c.path = c.next;
    c.next = c.after;
    c.after = choose(t.net, c.next);
    c.s = 0;
  }
}

/** Driving speed limit from the profile to a point `gap` m ahead moving at vAhead. */
const profile = (vAhead: number, gap: number, b: number): number => sqrt(Math.max(0, vAhead * vAhead + 2 * b * Math.max(0, gap)));

/** Gate phase scratch (gatePhase writes into it). */
const gatePh: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };

/** The obstacle scan's working values for the car being planned (no per-car allocations). */
const seen = { va: 0, room: 0, fx: 0, fz: 1, look: 0 };

/** A foreign body at (ox, oz) moving (ovx, ovz): if it is ahead in the lane of car c, brake for it. */
function obstacle(c: TrafficCar, ox: number, oz: number, ovx: number, ovz: number, ohl: number, ohw: number): void {
  const dx = ox - c.body.x;
  const dz = oz - c.body.z;
  const along = dx * seen.fx + dz * seen.fz;
  if (along <= 0 || along > seen.look + ohl) return;
  if (abs(dx * seen.fz - dz * seen.fx) > hw(c) + ohw + L.obstacleSide) return;
  const g = along - hl(c) - ohl;
  const vo = Math.max(0, ovx * seen.fx + ovz * seen.fz);
  seen.va = Math.min(seen.va, profile(vo, g - P.standGap, P.brake));
  seen.room = Math.min(seen.room, g - 0.3);
}

/**
 * One tick of traffic: drive (speed, junctions, plan), loose bodies, contact
 * with the race cars and among traffic, recycling and respawns. Called from
 * stepRace after the race cars have moved and collided.
 */
export function stepTraffic(r: RaceState): void {
  const t = r.traffic;
  if (!t) return;
  const net = t.net;
  const paths = net.paths;
  const cars = t.cars;
  // The moving fleet: the kerb's parked cars (after it) never drive, and are visited by place or as t.unparked.
  const n = t.fleet;
  const world = r.world;
  rng.setState(t.rng);
  if (bucketFirst.length < paths.length) bucketFirst = new Int32Array(paths.length);
  if (bucketNext.length < n) bucketNext = new Int32Array(n);
  bucketFirst.fill(-1, 0, paths.length);
  foreign.length = 0;
  // Buckets in descending id order give lists in ascending id order (only iteration, not results, depends on it).
  for (let i = n - 1; i >= 0; i--) {
    const c = cars[i];
    if (c.mode === 'loose' || (c.mode === 'drive' && abs(c.ox) + abs(c.oz) > L.offsetSettled)) foreign.push(i);
    if (c.mode !== 'drive') continue;
    bucketNext[i] = bucketFirst[c.path];
    bucketFirst[c.path] = i;
  }
  foreign.reverse();
  // Struck parked cars are foreign bodies too; the ones still in their slots stand clear of every lane.
  for (const id of t.unparked) foreign.push(id);

  const gates = r.world.timedGates && r.world.timedGates.gates.length ? r.world.timedGates : null;
  const cable = r.cableCar?.body ?? null;
  // 1. Speed limits for every driving car, from the state at the start of the tick.
  vAllow.length = n;
  advance.length = n;
  ask.length = n;
  const b = P.brake;
  for (let i = 0; i < n; i++) {
    const c = cars[i];
    ask[i] = -1;
    if (c.mode !== 'drive') continue;
    const p0 = paths[c.path];
    const p1 = paths[c.next];
    const p2 = paths[c.after];
    const d1 = p0.length - c.s;
    const d2 = d1 + p1.length;
    let va = Math.min(c.cruise * p0.factor, p0.vmax);
    va = Math.min(va, profile(Math.min(c.cruise * p1.factor, p1.vmax), d1, b), profile(Math.min(c.cruise * p2.factor, p2.vmax), d2, b));
    let room = Infinity; // bumper gap the car may close this tick without touching anything ahead (m)
    // The car ahead on this path or the next two.
    let gap = Infinity;
    let vLead = 0;
    /** Closest car ahead on the same path (-1: this car leads its lane). */
    let lead = -1;
    for (let j = bucketFirst[c.path]; j >= 0; j = bucketNext[j]) {
      const o = cars[j];
      if (o === c || o.s < c.s || (o.s === c.s && o.id < c.id)) continue;
      const g = o.s - c.s - hl(c) - hl(o);
      if (g < gap) {
        gap = g;
        vLead = o.v;
        lead = j;
      }
    }
    for (let j = bucketFirst[c.next]; j >= 0; j = bucketNext[j]) {
      const o = cars[j];
      const g = d1 + o.s - hl(c) - hl(o);
      if (g < gap) {
        gap = g;
        vLead = o.v;
      }
    }
    for (let j = bucketFirst[c.after]; j >= 0; j = bucketNext[j]) {
      const o = cars[j];
      if (o === c) continue;
      const g = d2 + o.s - hl(c) - hl(o);
      if (g < gap) {
        gap = g;
        vLead = o.v;
      }
    }
    // Cars turning another way out of the same lane: followed through the start the turns share.
    const src = p0.lane ? p0 : paths[p0.in[0]];
    const base = p0.lane ? d1 : -c.s;
    for (const sib of src.out) {
      if (sib === c.next || sib === c.path) continue;
      for (let j = bucketFirst[sib]; j >= 0; j = bucketNext[j]) {
        const o = cars[j];
        if (o.s > hl(o) + hl(c) + P.standGap + L.siblingReach || base + o.s < 0) continue;
        const g = base + o.s - hl(c) - hl(o);
        if (g < gap) {
          gap = g;
          vLead = o.v;
        }
      }
    }
    if (gap < Infinity) {
      va = Math.min(va, profile(vLead, gap - P.standGap, b), Math.max(0, gap - P.standGap) / P.headway + vLead * 0.5);
      room = Math.min(room, gap - 0.3);
    }
    // Foreign bodies ahead: race cars, struck traffic, cars still blending back into their lane.
    seen.va = va;
    seen.room = room;
    seen.fx = sin(c.body.yaw);
    seen.fz = cos(c.body.yaw);
    seen.look = Math.max(L.lookMin, (c.v * c.v) / (2 * b) + P.standGap + 8);
    for (const rc of r.cars) {
      const s = rc.state;
      obstacle(c, s.x, s.z, s.vx, s.vz, rc.tuning.geometry.halfLength, rc.tuning.geometry.halfWidth);
    }
    for (const j of foreign) {
      if (j === i) continue;
      const o = cars[j];
      obstacle(c, o.body.x, o.body.z, o.body.vx, o.body.vz, hl(o), hw(o));
    }
    // The cable car (sim/cableCar.ts), where its street crosses this lane's way (its own lanes keep clear of it).
    if (cable) obstacle(c, cable.x, cable.z, cable.vx, cable.vz, CABLE_CAR_BODY.halfLength, CABLE_CAR_BODY.halfWidth);
    va = seen.va;
    room = seen.room;
    // Timed gates on this path or the next two: stop short unless the bridge beyond stays open long enough.
    if (gates) {
      const d0 = -c.s;
      for (let k = 0; k < 3; k++) {
        const gp = k === 0 ? p0 : k === 1 ? p1 : p2;
        const base = k === 0 ? d0 : k === 1 ? d1 : d2;
        for (let gi = 0; gi < gp.gates.length; gi++) {
          const dist = base + gp.gateS[gi];
          if (dist < hl(c) || dist > 200) continue;
          const g = gates.gates[gp.gates[gi]];
          const ph = gatePhase(gates.cycles[g.cycle], r.tick, gatePh);
          const dStop = dist - hl(c) - L.gateStop;
          const across = dist + net.gateSpan[gp.gates[gi]] + hl(c);
          let stop = ph.name !== 'open';
          if (!stop) stop = ph.untilBlock / TICK_HZ < across / Math.max(c.v, L.gateMinSpeed) + L.gateMargin;
          // With a closing coming, nobody starts across behind a queue they might not clear the bridge with.
          if (!stop && ph.untilBlock / TICK_HZ < L.gateHorizon && gap < across && vLead < L.gateQueueSpeed) stop = true;
          // Too close to stop before the line while the arms are still up: carry on across.
          if (stop && !ph.blocking && (c.v * c.v) / (2 * P.hardBrake) > dist - hl(c)) stop = false;
          if (!stop) continue;
          va = Math.min(va, profile(0, dStop, b));
          room = Math.min(room, Math.max(0, dStop));
        }
      }
    }
    // A busy junction: stop at its line unless this car holds the connector; ask for it in time.
    if (p1.locked && c.hold !== c.next) {
      const dStop = d1 - hl(c) - L.stopMargin;
      va = Math.min(va, profile(0, dStop, b));
      room = Math.min(room, Math.max(0, dStop));
      if ((lead < 0 || cars[lead].hold === c.next) && dStop < (c.v * c.v) / (2 * b) + L.askReach) ask[i] = c.next;
    }
    vAllow[i] = va;
    advance[i] = room;
  }

  // 2. Reservations: longest wait first, granted when nothing held (or starved) conflicts and the exit has room.
  asking.length = 0;
  holders.length = 0;
  pending.length = 0;
  for (let i = 0; i < n; i++) {
    if (cars[i].hold >= 0) holders.push(i);
    if (ask[i] < 0) continue;
    cars[i].wait++;
    // Insertion into service order: wait descending, id ascending.
    let k = asking.length;
    asking.push(i);
    while (k > 0 && cars[asking[k - 1]].wait < cars[i].wait) {
      asking[k] = asking[k - 1];
      k--;
    }
    asking[k] = i;
  }
  for (const i of asking) {
    const c = cars[i];
    const want = ask[i];
    const wp = paths[want];
    let blocked = false;
    for (const h of holders) {
      const o = cars[h];
      const held = o.hold;
      if (held === want) continue;
      const hp = paths[held];
      const k = hp.conflicts.indexOf(want);
      if (k < 0) continue;
      // A holder stops being in the way once its tail is past the stretch the two connectors share.
      const past = o.path === hp.out[0] || (o.path === held && o.s - hl(o) > hp.clearAt[k]);
      if (!past) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      if (c.wait > L.starve / DT) pending.push(want);
      continue;
    }
    for (const q of pending) if (q !== want && wp.conflicts.includes(q)) blocked = true;
    if (blocked) continue;
    // Room beyond for this car and every holder of the same connector still on its way there.
    const exit = wp.out[0];
    let free = Infinity;
    for (let j = bucketFirst[exit]; j >= 0; j = bucketNext[j]) free = Math.min(free, cars[j].s - hl(cars[j]));
    let claimed = 1;
    for (const h of holders) if (cars[h].hold === want && cars[h].path !== exit) claimed++;
    if (free < claimed * CAR_SPAN) {
      // The street beyond is backed up: after a while the driver takes another way out of the junction.
      if (c.wait > L.reroute / DT) reroute(net, c);
      continue;
    }
    c.hold = want;
    c.wait = 0;
    // A fresh grant gets the full give-up time to get going.
    c.still = 0;
    holders.push(i);
  }

  // 3. Integrate the driving cars along their plans.
  for (let i = 0; i < n; i++) {
    const c = cars[i];
    if (c.mode !== 'drive') continue;
    const v0 = c.v;
    const va = vAllow[i];
    c.v = c.v < va ? Math.min(va, c.v + P.accel * DT) : Math.max(va, c.v - P.hardBrake * DT);
    let ds = c.v * DT;
    if (ds > advance[i]) {
      ds = Math.max(0, advance[i]);
      c.v = Math.min(c.v, ds / DT);
    }
    c.braking = c.v < v0 - 1e-4 || c.v < 0.5;
    c.still = c.v < 0.1 ? c.still + DT : 0;
    const prevYaw = c.body.yaw;
    c.s += ds;
    while (c.s >= paths[c.path].length) {
      c.s -= paths[c.path].length;
      c.path = c.next;
      c.next = c.after;
      c.after = choose(net, c.next);
    }
    // A reservation is let go once the tail is out of the junction, or when the car never got going.
    if (c.hold >= 0) {
      const hp = paths[c.hold];
      const onExit = c.path === hp.out[0];
      const approaching = c.path === hp.in[0];
      if ((onExit && c.s >= hl(c) + 1) || (approaching && c.still > L.holdGiveUp) || (!onExit && !approaching && c.path !== c.hold)) release(c);
    }
    if (c.ox !== 0 || c.oz !== 0 || c.oyaw !== 0) {
      const k = exp(-ds / P.rejoinLength);
      c.ox *= k;
      c.oz *= k;
      c.oyaw *= k;
      if (abs(c.ox) + abs(c.oz) + abs(c.oyaw) < 1e-3) c.ox = c.oz = c.oyaw = 0;
    }
    syncBody(net, c, prevYaw);
  }

  // 4. Loose bodies slide to a stop against the walls, then try to drive on (struck parked cars stay put).
  looseIds.length = 0;
  for (let i = 0; i < n; i++) if (cars[i].mode === 'loose') looseIds.push(i);
  for (const id of t.unparked) looseIds.push(id);
  for (const id of looseIds) {
    const c = cars[id];
    const bd = c.body;
    const fx = sin(bd.yaw);
    const fz = cos(bd.yaw);
    let vf = bd.vx * fx + bd.vz * fz;
    let vl = bd.vx * fz - bd.vz * fx;
    vf = approach(vf, 0, (c.home >= 0 ? P.parked.rollDecel : P.rollDecel) * DT);
    vl = approach(vl, 0, P.slideDecel * DT);
    bd.vx = fx * vf + fz * vl;
    bd.vz = fz * vf - fx * vl;
    bd.yawRate = approach(bd.yawRate, 0, P.spinDecel * DT);
    bd.x += bd.vx * DT;
    bd.z += bd.vz * DT;
    bd.yaw = wrapAngle(bd.yaw + bd.yawRate * DT);
    // On the street level (traffic never drives the river channel): over a deck's piers, held by its parapets.
    bd.y = world.heightAt(bd.x, bd.z);
    collideCarWithWorld(bd, trafficTuning(c.kind), world, undefined, undefined, r.tick);
    bd.speed = sqrt(bd.vx * bd.vx + bd.vz * bd.vz);
    c.still = bd.speed < P.restSpeed && abs(bd.yawRate) < 0.15 ? c.still + DT : 0;
    if (c.still >= P.recoverDelay && c.home < 0) tryRejoin(t, c);
  }

  // 5. Contact: race cars against traffic, then struck traffic against the rest.
  // Each body meets the moving fleet, the struck parked cars, then the parked cars standing near it.
  for (const rc of r.cars) {
    // A car just reset passes through traffic (collision.resetPassThrough).
    if (rc.finished || rc.passThrough > 0) continue;
    const s = rc.state;
    const meet = (c: TrafficCar) => {
      if (c.mode === 'gone') return;
      const reach = rc.tuning.geometry.halfLength + hl(c) + 0.5;
      if ((c.body.x - s.x) ** 2 + (c.body.z - s.z) ** 2 > reach * reach) return;
      // Its height on the street level: a race car on the channel floor under a bridge deck passes beneath it.
      c.body.y = world.heightAt(c.body.x, c.body.z);
      contact(t, r, rc.index, s, rc.tuning, c);
    };
    for (let i = 0; i < n; i++) meet(cars[i]);
    for (const id of t.unparked) meet(cars[id]);
    for (const id of parkedNear(t, world, s.x, s.z, rc.tuning.geometry.halfLength + MAX_HL + 0.5, nearParked)) meet(cars[id]);
  }
  looseIds.length = 0;
  for (let i = 0; i < n; i++) if (cars[i].mode === 'loose') looseIds.push(i);
  for (const id of t.unparked) looseIds.push(id);
  for (const ci of looseIds) {
    const c = cars[ci];
    const push = (o: TrafficCar) => {
      if (o === c || o.mode === 'gone' || (o.mode === 'loose' && o.id < c.id)) return;
      const reach = hl(c) + hl(o) + 0.5;
      if ((c.body.x - o.body.x) ** 2 + (c.body.z - o.body.z) ** 2 > reach * reach) return;
      contact(t, r, -1, c.body, trafficTuning(c.kind), o, c);
    };
    for (let i = 0; i < n; i++) push(cars[i]);
    for (let k = 0; k < t.unparked.length; k++) push(cars[t.unparked[k]]);
    for (const id of parkedNear(t, world, c.body.x, c.body.z, hl(c) + MAX_HL + 0.5, nearParked)) push(cars[id]);
  }
  // The cable car meets whatever traffic comes against it (a struck car sliding in, mostly), and is held to its cable.
  if (cable) {
    const ct = cableTuning();
    const meet = (o: TrafficCar) => {
      if (o.mode === 'gone') return;
      const reach = CABLE_CAR_BODY.halfLength + hl(o) + 0.5;
      if ((cable.x - o.body.x) ** 2 + (cable.z - o.body.z) ** 2 > reach * reach) return;
      contact(t, r, -1, cable, ct, o);
      holdCableCar(r, o.body);
    };
    for (let i = 0; i < n; i++) meet(cars[i]);
    for (let k = 0; k < t.unparked.length; k++) meet(cars[t.unparked[k]]);
  }

  // 6. Recycling: out of the bubble, or struck / stuck for good with nobody near, or met by a train; then respawns.
  const focus = r.cars[0]?.state;
  let spawns = 0;
  // Struck parked cars go back to their slots, never into the fleet (parked ones stand off the tracks).
  unparkIds.length = 0;
  for (const id of t.unparked) unparkIds.push(id);
  for (const id of unparkIds) unpark(t, r, cars[id], focus);
  for (let i = 0; i < n; i++) {
    const c = cars[i];
    // A car a train meets on a level crossing (struck there, say) goes too (sim/levelCrossing.ts).
    if (c.mode !== 'gone' && trainAt(r.world, r.tick, c.body.x, c.body.z, 1)) {
      release(c);
      c.mode = 'gone';
    }
    if (focus && c.mode !== 'gone') {
      const far = (c.body.x - focus.x) ** 2 + (c.body.z - focus.z) ** 2 > L.bubble * L.bubble;
      const stuck = (c.mode === 'loose' && c.still >= P.recoverDelay) || (c.mode === 'drive' && c.still > L.stuckRecycle);
      if (far || (stuck && hidden(r, c))) {
        release(c);
        c.mode = 'gone';
      }
    }
    if (c.mode === 'gone' && focus && spawns < L.spawnsPerTick) {
      spawns++;
      trySpawn(t, r.world, c, r.cars, focus.x, focus.z, L.spawnMin, L.spawnMax, L.spawnMin, r.tick, L.spawnTries);
    }
  }
  t.rng = rng.getState();
}

/** No race car within hideDistance: a car can vanish or appear without anyone seeing it. */
function hidden(r: RaceState, c: TrafficCar): boolean {
  return hiddenAt(r, c.body.x, c.body.z);
}

function hiddenAt(r: RaceState, x: number, z: number): boolean {
  for (const rc of r.cars) if ((rc.state.x - x) ** 2 + (rc.state.z - z) ** 2 < L.hideDistance * L.hideDistance) return false;
  return true;
}

/**
 * A struck parked car (loose, `home` set) goes back to its slot once it is at
 * rest or out of the player's bubble, unseen where it is and where it goes,
 * with the slot clear; met by a train, at once. Never into the moving fleet.
 */
function unpark(t: TrafficState, r: RaceState, c: TrafficCar, focus: CarState | undefined): void {
  const world = r.world;
  if (trainAt(world, r.tick, c.body.x, c.body.z, 1)) {
    parkHome(t, world, c, r.tick);
    return;
  }
  const far = !!focus && (c.body.x - focus.x) ** 2 + (c.body.z - focus.z) ** 2 > L.bubble * L.bubble;
  if (!far && c.still < P.recoverDelay) return;
  const slot = planParking(world).cars[c.home];
  if (!hidden(r, c) || !hiddenAt(r, slot.x, slot.z)) return;
  // Nobody standing in the slot: a moving car or another struck one (the parked ones keep to their own).
  const blocks = (o: TrafficCar) => o !== c && o.mode !== 'gone' && (o.body.x - slot.x) ** 2 + (o.body.z - slot.z) ** 2 < (hl(c) + hl(o)) ** 2;
  for (let i = 0; i < t.fleet; i++) if (blocks(t.cars[i])) return;
  for (const id of t.unparked) if (blocks(t.cars[id])) return;
  parkHome(t, world, c, r.tick);
}

/**
 * Resolve contact between a body (a race car, or the loose traffic car `src`)
 * and traffic car c. A driving car that is pushed or struck turns loose.
 */
function contact(t: TrafficState, r: RaceState, carIndex: number, a: CarState, ta: CarTuning, c: TrafficCar, src?: TrafficCar): void {
  const bd = c.body;
  const x0 = bd.x;
  const z0 = bd.z;
  const vx0 = bd.vx;
  const vz0 = bd.vz;
  const imp = collideCars(a, ta, bd, trafficTuning(c.kind));
  const moved = bd.x !== x0 || bd.z !== z0 || bd.vx !== vx0 || bd.vz !== vz0;
  if (!moved) return;
  if (c.mode === 'drive' || c.mode === 'parked') turnLoose(t, c);
  c.still = 0;
  if (carIndex >= 0) {
    const rc = r.cars[carIndex];
    rc.state.impact = Math.max(rc.state.impact, imp);
  }
  if (imp > CRASH_EVENT.speed && r.tick - c.hitTick >= CRASH_EVENT.gap) {
    c.hitTick = r.tick;
    if (src) src.hitTick = r.tick;
    const e: RaceEvent = { tick: r.tick, type: 'crash', car: carIndex, traffic: c.id, value: imp };
    r.events.push(e);
  }
}

/** A stopped loose car drives on when it sits close to its lane, roughly facing along it, with room. */
function tryRejoin(t: TrafficState, c: TrafficCar): void {
  const net = t.net;
  const p = net.paths[c.path];
  if (!p.lane) return;
  const bd = c.body;
  // Nearest point of the lane's polyline (lanes bend round roadworks).
  let s = 0;
  let best = Infinity;
  for (let i = 0; i + 1 < p.x.length; i++) {
    const u = segmentT(bd.x, bd.z, p.x[i], p.z[i], p.x[i + 1], p.z[i + 1]);
    const d2 = (bd.x - p.x[i] - (p.x[i + 1] - p.x[i]) * u) ** 2 + (bd.z - p.z[i] - (p.z[i + 1] - p.z[i]) * u) ** 2;
    if (d2 < best) {
      best = d2;
      s = p.cum[i] + (p.cum[i + 1] - p.cum[i]) * u;
    }
  }
  // Past the stop line is fine: the car then waits there for its turn like any other.
  if (s < hl(c) + 0.5 || s > p.length - 0.3) return;
  samplePath(p, s, pose);
  const px = pose.x;
  const pz = pose.z;
  const off = sqrt((bd.x - px) ** 2 + (bd.z - pz) ** 2);
  const dyaw = wrapAngle(bd.yaw - pose.yaw);
  if (off > P.rejoinDistance || abs(dyaw) > P.rejoinYawDeg * DEG) return;
  for (let j = 0; j < t.fleet; j++) {
    const o = t.cars[j];
    if (o === c || o.mode !== 'drive' || o.path !== c.path) continue;
    // Room ahead for the standstill gap; a car right behind just waits until this one pulls away.
    if (o.s >= s ? o.s - s < hl(c) + hl(o) + P.standGap : s - o.s < hl(c) + hl(o)) return;
  }
  c.mode = 'drive';
  c.s = s;
  c.v = 0;
  c.still = 0;
  c.wait = 0;
  c.ox = bd.x - px;
  c.oz = bd.z - pz;
  c.oyaw = dyaw;
  c.next = choose(net, c.path);
  c.after = choose(net, c.next);
  syncBody(net, c, bd.yaw);
  bd.yawRate = 0;
}

/** Traffic cars ahead of a race car within `reach` (m) and `side` (m) of its heading: -1 / 1 for the side it is on (left positive), 0 for none. */
export function trafficAhead(r: RaceState, x: number, z: number, fx: number, fz: number, reach: number, side: number): number {
  // The cable car first: a racer dodges it like a slow truck.
  const cc = cableCarAhead(r, x, z, fx, fz, reach, side);
  if (cc) return cc;
  const t = r.traffic;
  if (!t) return 0;
  const look = (c: TrafficCar): number => {
    if (c.mode === 'gone') return 0;
    const dx = c.body.x - x;
    const dz = c.body.z - z;
    const ahead = dx * fx + dz * fz;
    if (ahead <= 0 || ahead > reach) return 0;
    const lat = dx * fz - dz * fx;
    return abs(lat) < side + hw(c) ? (lat >= 0 ? 1 : -1) : 0;
  };
  // In id order: the moving fleet, then the kerb's cars (struck or standing near) merged by id.
  for (let i = 0; i < t.fleet; i++) {
    const v = look(t.cars[i]);
    if (v) return v;
  }
  if (t.cars.length === t.fleet) return 0;
  parkedNear(t, r.world, x, z, reach + MAX_HL, nearParked);
  for (const id of t.unparked) nearParked.push(id);
  nearParked.sort((a, b) => a - b);
  for (const id of nearParked) {
    const v = look(t.cars[id]);
    if (v) return v;
  }
  return 0;
}
