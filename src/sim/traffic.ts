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
 */
import type { World, Contact } from '../city/world';
import type { RoadKind } from '../city/roadGraph';
import { isBendNode } from '../city/roadGraph';
import { ROADWORKS, laneClosures } from '../city/districts/roadworks';
import { CITY } from '../city/config';
import { CarState, createCar } from './car';
import { CarTuning, DEFAULT_CAR_ID, TRAFFIC, getBaseTuning } from './tuning';
import { collideCarWithWorld, collideCars } from './collision';
import { CRASH_EVENT, DT, TICK_HZ } from './constants';
import { Rng, deriveSeed } from './prng';
import { DEG, TAU, abs, approach, atan2, cos, distToSegment, exp, segmentT, sin, smoothstep, sqrt, wrapAngle, yawOf } from './math';
import type { RaceCar, RaceEvent, RaceState } from './race';
import { GatePhase, gatePhase } from './gates';
import { trainAt } from './levelCrossing';

/** Network layout, counts and spawning (not physics: those are TRAFFIC in drivingParams.json). */
export const TRAFFIC_LAYOUT = {
  /** Cars per race (they keep to the off-route streets) and per open world session. */
  count: { race: 30, openWorld: 44 },
  /** Street kinds traffic drives. */
  kinds: ['street', 'avenue', 'diagonal', 'boulevard'] as readonly RoadKind[],
  /** Cruise speed factor per street kind: the wide roads are a little quicker. */
  speedFactor: { street: 1, avenue: 1.15, diagonal: 1.1, boulevard: 1.25 } as Partial<Record<RoadKind, number>>,
  /** Lanes end this far beyond where the curbs of a junction start (m), and at least setbackMin from its node (m). */
  setbackMargin: 1.2,
  setbackMin: 4,
  /** At a bend node (a street's own kink, roadGraph.ts: no junction) lanes end this far from it (m), joined by a short connector. */
  bendSetback: 1.5,
  /** Streets whose lane would be shorter than this are left out (m). */
  minLaneLength: 8,
  /** Sharper turns than this (deg) are never taken (hairpins). */
  maxTurnDeg: 140,
  /** Roadworks: a lane merges out to keep the widest car this clear (m) of the barriers' reach, over rampLength (m) each way, sampled rampSteps times. */
  closurePad: 0.4,
  rampLength: 14,
  rampSteps: 5,
  /** Junction curves: Bezier handle length as a share of the chord, and the points sampled. */
  handle: 0.42,
  curveSteps: 10,
  /** Roundabouts: the lane runs at this share of the ring road out from the island; arc points every ringStepDeg, entering and leaving over ringLeadDeg. */
  ringLane: 0.6,
  ringStepDeg: 12,
  ringLeadDeg: 22,
  /** Wall probes along every lane and connector: spacing (m) and padding beyond the widest car's half width (m). */
  probeStep: 2.5,
  probePad: 0.3,
  /** Straight on through a junction is this many times likelier than any one turn. */
  straightWeight: 2.2,
  /** Cars further than this from the player are recycled (m). */
  bubble: 380,
  /** Respawns land this far from the player (m), and at least spawnMin from every race car. */
  spawnMin: 170,
  spawnMax: 340,
  /** At the start, cars are placed anywhere in the bubble but this clear of every race car (m). */
  startClear: 28,
  /** A struck or stuck car is only recycled with no race car closer than this (m). */
  hideDistance: 150,
  /** Lane positions tried per respawn, respawns per tick (keeps the cost flat), clearance to other traffic (m), distance kept from lane ends (m). */
  spawnTries: 8,
  spawnsPerTick: 2,
  spawnClear: 14,
  spawnEnd: 12,
  /** A lane's head car asks for its connector at a busy junction when its stop line is within braking distance plus this (m); it stops this far short of the junction (m). */
  askReach: 2,
  stopMargin: 0.8,
  /** A car turning another way out of the same lane is followed until it is this far (m, beyond both half lengths and standGap) into its turn. */
  siblingReach: 6,
  /** A car that holds a connector but has not got going after this long lets it go (s). */
  holdGiveUp: 6,
  /** A request waiting longer than this (s) holds back later requests that conflict with it. */
  starve: 3,
  /** A driver whose way out of a junction stays backed up this long (s) picks another turn. */
  reroute: 2.5,
  /** Two connectors of a junction conflict when they pass closer than the longest half length plus the widest half width plus this (m). */
  conflictPad: 0.4,
  /** Sample spacing when measuring where two connectors stop being in each other's way (m). */
  zoneStep: 1,
  /** A driving car stopped this long is recycled when no race car is near (s): breaks rare gridlocks and queues behind wrecks. */
  stuckRecycle: 40,
  /** Foreign bodies ahead: side clearance beyond both half widths (m) and the shortest lookahead (m). */
  obstacleSide: 0.5,
  lookMin: 22,
  /** A rejoining car counts as a foreign body for the others until its offset is below this (m). */
  offsetSettled: 0.4,
  /**
   * Timed gates: the nose stops this far short of the line (m); a driver goes
   * on when the gate stays open until it is this long (s) past the bridge
   * beyond, judged at no less than gateMinSpeed (m/s); nothing spawns within
   * gateSpawnClear (m) of a level crossing's gates.
   */
  gateStop: 1.6,
  gateMargin: 1.5,
  gateMinSpeed: 6,
  gateSpawnClear: 15,
  /** Within this long (s) of a closing, a driver waits at the gate rather than start across behind a car slower than gateQueueSpeed (m/s). */
  gateHorizon: 20,
  gateQueueSpeed: 3,
} as const;

const L = TRAFFIC_LAYOUT;
const P = TRAFFIC;

/** A lane (one direction of a street) or a connector through a junction. */
export interface TrafficPath {
  lane: boolean;
  /** Polyline points (m). */
  x: number[];
  z: number[];
  /** Heading at each point (rad, yaw convention: forward is (sin, cos)). */
  yaw: number[];
  /** Distance along the polyline at each point (m). */
  cum: number[];
  /** m */
  length: number;
  /** Lane: graph edge; connector: -1. */
  edge: number;
  /** Lane: start and end graph node. Connector: its junction node (both). */
  from: number;
  to: number;
  /** Lane: connector ids leaving its end. Connector: [the lane it leads into]. */
  out: number[];
  /** Lane: connector ids arriving at its start. Connector: [the lane it leaves]. */
  in: number[];
  /** Connector at a busy junction: it is reserved before it is entered. */
  locked: boolean;
  /** Locked connectors of the same junction that cross or merge with this one (turns out of the same lane do not: they follow each other). */
  conflicts: number[];
  /** Per conflict: distance along this connector (m) past which a car on it is out of that connector's way (its full length for a merge). */
  clearAt: number[];
  /** Speed limit from curvature (m/s); Infinity on lanes. */
  vmax: number;
  /** Cruise speed factor of the street. */
  factor: number;
  /** Timed gates this path crosses from their holding side (World.timedGates.gates ids), and where along it (m). */
  gates: number[];
  gateS: number[];
  /** Choice weight among the turns of the lane it leaves (connectors). */
  weight: number;
}

export interface TrafficNet {
  paths: TrafficPath[];
  /** Lane path ids (where cars spawn) and their cumulative lengths (m), for length weighted picks. */
  lanes: number[];
  laneCum: number[];
  /** Per timed gate: the length of the crossing it guards (m, to the far gate of its cycle), which a car must clear before it closes. */
  gateSpan: number[];
}

export type TrafficMode = 'drive' | 'loose' | 'gone';

export interface TrafficCar {
  /** Slot index (stable for the race). */
  id: number;
  /** Index into TRAFFIC.kinds. */
  kind: number;
  mode: TrafficMode;
  /** The path driven now and the next two (TrafficNet.paths ids). */
  path: number;
  next: number;
  after: number;
  /** Distance along `path` (m) and speed along it (m/s). */
  s: number;
  v: number;
  /** This driver's cruise speed on a plain street (m/s). */
  cruise: number;
  /** Connector this car holds a reservation for (-1: none). */
  hold: number;
  /** Ticks waited for a reservation (the longest wait goes first). */
  wait: number;
  /** Seconds at a standstill: loose (recovery) or driving (stuck recycling, junction give-up). */
  still: number;
  /** Rejoin blend: the pose's offset from the lane pose (m, m, rad), fading as the car drives. */
  ox: number;
  oz: number;
  oyaw: number;
  /** Tick the car (re)spawned: the renderer gives each spawn a fresh paint and fades its lamps in. */
  born: number;
  /** Last tick a hit on this car raised an event. */
  hitTick: number;
  /** Brake lights on (slowing or held at a standstill). */
  braking: boolean;
  /** Pose and velocity for collisions and rendering (only the planar fields are used). */
  body: CarState;
}

export interface TrafficState {
  net: TrafficNet;
  cars: TrafficCar[];
  /** Spawn and turn choices stream (Rng state). */
  rng: number;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

const netCache = new WeakMap<World, TrafficNet>();

/** The traffic network of a world (pure function of it, built once and cached). */
export function trafficNet(world: World): TrafficNet {
  let net = netCache.get(world);
  if (!net) {
    net = buildNet(world);
    netCache.set(world, net);
  }
  return net;
}

const maxHalfWidth = (): number => Math.max(...P.kinds.map((k) => k.halfWidth));

/** True when a car's footprint along the polyline would touch a wall or leave the paving. */
function pathBlocked(w: World, xs: number[], zs: number[], r: number, contacts: Contact[]): boolean {
  for (let i = 0; i + 1 < xs.length; i++) {
    const dx = xs[i + 1] - xs[i];
    const dz = zs[i + 1] - zs[i];
    const len = sqrt(dx * dx + dz * dz);
    const n = Math.max(1, Math.ceil(len / L.probeStep));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const x = xs[i] + (dx * k) / n;
      const z = zs[i] + (dz * k) / n;
      // Probed at street level: over the river channel a bridge's piers stand beneath its deck (Wall.top).
      if (w.collideCircle(x, z, r, contacts, w.heightAt(x, z)) > 0) return true;
      const s = w.surfaceAt(x, z);
      if (s === 'offroad' || s === 'grass' || s === 'water') return true;
    }
  }
  return false;
}

function polyPath(xs: number[], zs: number[], yaws: number[], lane: boolean, edge: number, from: number, to: number): TrafficPath {
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + sqrt((xs[i] - xs[i - 1]) ** 2 + (zs[i] - zs[i - 1]) ** 2));
  return { lane, x: xs, z: zs, yaw: yaws, cum, length: cum[cum.length - 1], edge, from, to, out: [], in: [], locked: false, conflicts: [], clearAt: [], vmax: Infinity, factor: 1, weight: 1, gates: [], gateS: [] };
}

/**
 * A lane's polyline from its start (x0, z0) along (fx, fz) for `len` m, kept
 * `off` m right of the street's centerline, merging left by `shift` over each
 * squeeze's [a, b] stretch (lane m), easing out and back over rampLength.
 */
function lanePolyline(x0: number, z0: number, fx: number, fz: number, len: number, off: number, squeeze: { a: number; b: number; shift: number }[]): { xs: number[]; zs: number[]; yaws: number[] } {
  const ss = [0, len];
  for (const q of squeeze) {
    for (let k = 0; k <= L.rampSteps; k++) {
      ss.push(q.a - L.rampLength + (L.rampLength * k) / L.rampSteps);
      ss.push(q.b + (L.rampLength * k) / L.rampSteps);
    }
  }
  const at = ss.filter((v) => v >= 0 && v <= len).sort((u, v) => u - v);
  const uniq = at.filter((v, i) => i === 0 || v - at[i - 1] > 1e-6);
  const offAt = (v: number) => {
    let o = off;
    for (const q of squeeze) o = Math.min(o, off - q.shift * smoothstep(q.a - L.rampLength, q.a, v) * (1 - smoothstep(q.b, q.b + L.rampLength, v)));
    return o;
  };
  const xs = uniq.map((v) => x0 + fx * v - fz * offAt(v));
  const zs = uniq.map((v) => z0 + fz * v + fx * offAt(v));
  const yaws = uniq.map((_, i) => {
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(uniq.length - 1, i + 1);
    return yawOf(xs[i1] - xs[i0], zs[i1] - zs[i0]);
  });
  return { xs, zs, yaws };
}

/** Tightest radius along a polyline (m) from the heading change between its segments. */
function minRadius(p: TrafficPath): number {
  let r = Infinity;
  for (let i = 1; i + 1 < p.x.length; i++) {
    const y0 = yawOf(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
    const y1 = yawOf(p.x[i + 1] - p.x[i], p.z[i + 1] - p.z[i]);
    const dth = abs(wrapAngle(y1 - y0));
    if (dth < 1e-6) continue;
    r = Math.min(r, (p.cum[i + 1] - p.cum[i - 1]) / 2 / dth);
  }
  return r;
}

function buildNet(w: World): TrafficNet {
  const g = w.graph;
  const routeNodes = new Set<number>(w.openWorld ? [] : w.route.nodes);
  const kinds = new Set<RoadKind>(L.kinds);
  const contacts: Contact[] = [];
  const probe = maxHalfWidth() + L.probePad;
  const paths: TrafficPath[] = [];
  /** Lane path id per edge and direction (2 * edge + 0 for a -> b, + 1 for b -> a), -1 for none. */
  const laneOf = new Int32Array(g.edges.length * 2).fill(-1);
  const mouths = w.blocks.mouths;
  // Roadworks closures per edge: the closure in its street frame (laneClosures runs in area order, as this filter does).
  const works = (w.areas ?? []).filter((a) => a.kind === 'roadworks');
  const closures = laneClosures(w.areas ?? [], g);
  const closuresOf = new Map<number, typeof closures>();
  works.forEach((a, i) => {
    const c = closures[i];
    if (!c) return;
    const list = closuresOf.get(a.params.edge);
    if (list) list.push(c);
    else closuresOf.set(a.params.edge, [c]);
  });

  // Night markets (districts/market.ts) close their street to traffic, in an open world too.
  const market = new Set((w.areas ?? []).filter((a) => a.kind === 'market').flatMap((a) => a.edges));

  // Lanes: keep right, stopping short of each junction where its curbs start.
  for (const e of g.edges) {
    if (!kinds.has(e.kind) || e.shortcut || market.has(e.id) || routeNodes.has(e.a) || routeNodes.has(e.b)) continue;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = e.length || 1;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const m = mouths[e.id];
    const reach = (N: typeof A, pts: { x: number; z: number }[], sx: number, sz: number) => {
      if (isBendNode(g, N.id)) return L.bendSetback;
      let t = 0;
      for (const p of pts) t = Math.max(t, (p.x - N.x) * sx + (p.z - N.z) * sz);
      if (N.ring) t = Math.max(t, N.ring.outer);
      return Math.max(L.setbackMin, t + L.setbackMargin);
    };
    const sa = reach(A, [m.aP.curb, m.aN.curb], dx, dz);
    const sb = reach(B, [m.bP.curb, m.bN.curb], -dx, -dz);
    if (len - sa - sb < L.minLaneLength) continue;
    const off = e.lanes === 4 ? CITY.laneWidth * 1.5 : e.width / 4;
    const factor = L.speedFactor[e.kind] ?? 1;
    for (const dir of [0, 1]) {
      const fx = dir === 0 ? dx : -dx;
      const fz = dir === 0 ? dz : -dz;
      const S = dir === 0 ? A : B;
      const T = dir === 0 ? B : A;
      const s0 = dir === 0 ? sa : sb;
      const s1 = dir === 0 ? sb : sa;
      // Right of travel is (-fz, fx).
      const rx = -fz;
      const rz = fx;
      const laneLen = len - s0 - s1;
      // Roadworks on this side: merge out to clear the barriers, in lane distance (m) from the lane's start.
      const squeeze: { a: number; b: number; shift: number }[] = [];
      for (const c of closuresOf.get(e.id) ?? []) {
        if (c.nx * rx + c.nz * rz < 0.5) continue;
        const clear = c.keep + ROADWORKS.aiMargin - maxHalfWidth() - L.closurePad;
        if (clear >= off) continue;
        const a = dir === 0 ? c.s0 - s0 : len - c.s1 - s0;
        const b = dir === 0 ? c.s1 - s0 : len - c.s0 - s0;
        squeeze.push({ a, b, shift: off - clear });
      }
      const { xs, zs, yaws } = lanePolyline(S.x + fx * s0, S.z + fz * s0, fx, fz, laneLen, off, squeeze);
      if (pathBlocked(w, xs, zs, probe, contacts)) continue;
      const p = polyPath(xs, zs, yaws, true, e.id, S.id, T.id);
      p.factor = factor;
      laneOf[2 * e.id + dir] = paths.length;
      paths.push(p);
    }
  }

  // Connectors: every incoming lane to every outgoing lane of another street at the node.
  const maxTurn = L.maxTurnDeg * DEG;
  for (const n of g.nodes) {
    const ins: number[] = [];
    const outs: number[] = [];
    for (const eid of n.edges) {
      const e = g.edges[eid];
      const toN = e.b === n.id ? laneOf[2 * eid] : laneOf[2 * eid + 1];
      const fromN = e.a === n.id ? laneOf[2 * eid] : laneOf[2 * eid + 1];
      if (toN >= 0) ins.push(toN);
      if (fromN >= 0) outs.push(fromN);
    }
    const streets = new Set([...ins, ...outs].map((id) => paths[id].edge)).size;
    for (const li of ins) {
      for (const lo of outs) {
        const a = paths[li];
        const b = paths[lo];
        if (a.edge === b.edge) continue;
        const ai = a.x.length - 1;
        const turn = wrapAngle(b.yaw[0] - a.yaw[ai]);
        if (abs(turn) > maxTurn) continue;
        const p0x = a.x[ai];
        const p0z = a.z[ai];
        const p3x = b.x[0];
        const p3z = b.z[0];
        const xs: number[] = [];
        const zs: number[] = [];
        const ys: number[] = [];
        if (n.ring) {
          // Around the island, island on the driver's left (decreasing atan2 angle), as the route does.
          const R = n.ring.island + L.ringLane * (n.ring.outer - n.ring.island);
          const aE = atan2(p0z - n.z, p0x - n.x);
          const aX = atan2(p3z - n.z, p3x - n.x);
          let sweep = aE - aX;
          while (sweep <= 1e-6) sweep += TAU;
          while (sweep > TAU) sweep -= TAU;
          const lead = Math.min(L.ringLeadDeg * DEG, sweep / 4);
          const arc = sweep - 2 * lead;
          const steps = Math.max(2, Math.ceil(arc / (L.ringStepDeg * DEG)));
          xs.push(p0x);
          zs.push(p0z);
          ys.push(a.yaw[ai]);
          for (let k = 0; k <= steps; k++) {
            const ang = aE - lead - (arc * k) / steps;
            xs.push(n.x + cos(ang) * R);
            zs.push(n.z + sin(ang) * R);
            ys.push(yawOf(sin(ang), -cos(ang)));
          }
          xs.push(p3x);
          zs.push(p3z);
          ys.push(b.yaw[0]);
        } else {
          const t0x = sin(a.yaw[ai]);
          const t0z = cos(a.yaw[ai]);
          const t3x = sin(b.yaw[0]);
          const t3z = cos(b.yaw[0]);
          const h = sqrt((p3x - p0x) ** 2 + (p3z - p0z) ** 2) * L.handle;
          const p1x = p0x + t0x * h;
          const p1z = p0z + t0z * h;
          const p2x = p3x - t3x * h;
          const p2z = p3z - t3z * h;
          for (let k = 0; k <= L.curveSteps; k++) {
            const t = k / L.curveSteps;
            const u = 1 - t;
            xs.push(u * u * u * p0x + 3 * u * u * t * p1x + 3 * u * t * t * p2x + t * t * t * p3x);
            zs.push(u * u * u * p0z + 3 * u * u * t * p1z + 3 * u * t * t * p2z + t * t * t * p3z);
            const dx = 3 * u * u * (p1x - p0x) + 6 * u * t * (p2x - p1x) + 3 * t * t * (p3x - p2x);
            const dz = 3 * u * u * (p1z - p0z) + 6 * u * t * (p2z - p1z) + 3 * t * t * (p3z - p2z);
            ys.push(dx * dx + dz * dz > 1e-12 ? yawOf(dx, dz) : a.yaw[ai]);
          }
        }
        if (pathBlocked(w, xs, zs, probe, contacts)) continue;
        const c = polyPath(xs, zs, ys, false, -1, n.id, n.id);
        c.locked = streets >= 3 || !!n.ring;
        c.vmax = Math.max(P.minTurnSpeed, sqrt(P.turnLatAccel * minRadius(c)));
        c.factor = b.factor;
        c.weight = abs(turn) < 30 * DEG ? L.straightWeight : 1;
        c.in.push(li);
        c.out.push(lo);
        a.out.push(paths.length);
        b.in.push(paths.length);
        paths.push(c);
      }
    }
  }

  // Prune dead ends until every lane has a way in and a way on.
  const alive = paths.map(() => true);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (!alive[i] || !p.lane) continue;
      if (p.out.some((c) => alive[c]) && p.in.some((c) => alive[c])) continue;
      alive[i] = false;
      changed = true;
      for (const c of [...p.out, ...p.in]) alive[c] = false;
    }
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (alive[i] && !p.lane && (!alive[p.in[0]] || !alive[p.out[0]])) {
        alive[i] = false;
        changed = true;
      }
    }
  }
  const remap = new Int32Array(paths.length).fill(-1);
  const kept: TrafficPath[] = [];
  paths.forEach((p, i) => {
    if (!alive[i]) return;
    remap[i] = kept.length;
    kept.push(p);
  });
  for (const p of kept) {
    p.out = p.out.filter((i) => alive[i]).map((i) => remap[i]);
    p.in = p.in.filter((i) => alive[i]).map((i) => remap[i]);
  }
  // Conflicts between the reserved connectors of each junction.
  // A nose can swing into a side where paths cross at an angle: half length plus half width, not two half widths.
  const gap = Math.max(...P.kinds.map((k) => k.halfLength)) + maxHalfWidth() + L.conflictPad;
  const byNode = new Map<number, number[]>();
  kept.forEach((p, i) => {
    if (p.lane || !p.locked) return;
    const list = byNode.get(p.from);
    if (list) list.push(i);
    else byNode.set(p.from, [i]);
  });
  for (const list of byNode.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let c = a + 1; c < list.length; c++) {
        const A = kept[list[a]];
        const B = kept[list[c]];
        // Turns out of the same lane only share their start, where the follower follows the leader (stepTraffic).
        if (A.in[0] === B.in[0]) continue;
        const merge = A.out[0] === B.out[0];
        if (merge || polyDistance(A, B) < gap) {
          A.conflicts.push(list[c]);
          A.clearAt.push(merge ? A.length : zoneEnd(A, B, gap));
          B.conflicts.push(list[a]);
          B.clearAt.push(merge ? B.length : zoneEnd(B, A, gap));
        }
      }
    }
  }
  // Ascending conflict ids (clearAt kept parallel).
  for (const p of kept) {
    const order = p.conflicts.map((_, k) => k).sort((x, y) => p.conflicts[x] - p.conflicts[y]);
    p.conflicts = order.map((k) => p.conflicts[k]);
    p.clearAt = order.map((k) => p.clearAt[k]);
  }
  const lanes: number[] = [];
  const laneCum: number[] = [];
  let total = 0;
  kept.forEach((p, i) => {
    if (!p.lane) return;
    lanes.push(i);
    total += p.length;
    laneCum.push(total);
  });
  // Timed gates: where each path crosses a gate line coming from its holding side.
  const set = w.timedGates;
  const gateSpan: number[] = [];
  if (set) {
    set.gates.forEach((g, gi) => {
      let span = 0;
      for (const o of set.gates) if (o.cycle === g.cycle) span = Math.max(span, sqrt((o.cx - g.cx) ** 2 + (o.cz - g.cz) ** 2));
      gateSpan.push(span);
      for (const p of kept) {
        for (let i = 0; i + 1 < p.x.length; i++) {
          const sx = p.x[i + 1] - p.x[i];
          const sz = p.z[i + 1] - p.z[i];
          if (sx * g.nx + sz * g.nz >= 0) continue;
          const t = crossAt(p.x[i], p.z[i], p.x[i + 1], p.z[i + 1], g.ax, g.az, g.bx, g.bz);
          if (t < 0) continue;
          p.gates.push(gi);
          p.gateS.push(p.cum[i] + (p.cum[i + 1] - p.cum[i]) * t);
          break;
        }
      }
    });
  }
  return { paths: kept, lanes, laneCum, gateSpan };
}

/** Where segment a-b crosses segment c-d, as a share of a-b (-1 when they do not cross). */
function crossAt(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const den = (bx - ax) * (dz - cz) - (bz - az) * (dx - cx);
  if (abs(den) < 1e-12) return -1;
  const t = ((cx - ax) * (dz - cz) - (cz - az) * (dx - cx)) / den;
  const u = ((cx - ax) * (bz - az) - (cz - az) * (bx - ax)) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/** Distance between two segments (0 when they cross). */
function segDistance(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distToSegment(ax, az, cx, cz, dx, dz), distToSegment(bx, bz, cx, cz, dx, dz), distToSegment(cx, cz, ax, az, bx, bz), distToSegment(dx, dz, ax, az, bx, bz));
}

/** Distance along `a` (m) past which it stays further than `gap` from `b`: where a car on `a` is out of b's way. */
function zoneEnd(a: TrafficPath, b: TrafficPath, gap: number): number {
  let end = 0;
  const n = Math.max(2, Math.ceil(a.length / L.zoneStep));
  for (let k = 0; k <= n; k++) {
    const s = (a.length * k) / n;
    samplePath(a, s, pose);
    let d = Infinity;
    for (let j = 0; j + 1 < b.x.length && d >= gap; j++) d = Math.min(d, distToSegment(pose.x, pose.z, b.x[j], b.z[j], b.x[j + 1], b.z[j + 1]));
    if (d < gap) end = s;
  }
  return Math.min(a.length, end + a.length / n);
}

/** Closest approach of two polylines (m). */
function polyDistance(a: TrafficPath, b: TrafficPath): number {
  let d = Infinity;
  for (let i = 0; i + 1 < a.x.length; i++) {
    for (let j = 0; j + 1 < b.x.length; j++) d = Math.min(d, segDistance(a.x[i], a.z[i], a.x[i + 1], a.z[i + 1], b.x[j], b.z[j], b.x[j + 1], b.z[j + 1]));
  }
  return d;
}

/** Position and heading at distance s along a path. */
function samplePath(p: TrafficPath, s: number, out: { x: number; z: number; yaw: number }): void {
  const n = p.x.length;
  if (s <= 0) {
    out.x = p.x[0];
    out.z = p.z[0];
    out.yaw = p.yaw[0];
    return;
  }
  let i = 0;
  while (i < n - 2 && p.cum[i + 1] < s) i++;
  const seg = p.cum[i + 1] - p.cum[i] || 1;
  const t = Math.min(1, (s - p.cum[i]) / seg);
  out.x = p.x[i] + (p.x[i + 1] - p.x[i]) * t;
  out.z = p.z[i] + (p.z[i + 1] - p.z[i]) * t;
  out.yaw = p.yaw[i] + wrapAngle(p.yaw[i + 1] - p.yaw[i]) * t;
}

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

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

const pose = { x: 0, z: 0, yaw: 0 };
const rng = new Rng(0);

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
function choose(net: TrafficNet, id: number): number {
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

const hl = (c: TrafficCar): number => P.kinds[c.kind].halfLength;
/** Lane length one car claims: the longest kind plus the standstill gap (m). */
const CAR_SPAN = 2 * Math.max(...P.kinds.map((k) => k.halfLength)) + P.standGap;
const hw = (c: TrafficCar): number => P.kinds[c.kind].halfWidth;

/** Write the car's pose (path pose plus rejoin offset) and kinematic velocity into its body. */
function syncBody(net: TrafficNet, c: TrafficCar, prevYaw: number): void {
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
function trySpawn(t: TrafficState, world: World, c: TrafficCar, cars: readonly RaceCar[], fx: number, fz: number, minD: number, maxD: number, clear: number, tick: number, tries: number): boolean {
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

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

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
  release(c);
  c.mode = 'loose';
  c.still = 0;
  c.wait = 0;
  c.braking = true;
  // Recovery rejoins the lane: a car hit inside a junction rejoins the lane it was leaving into.
  if (!t.net.paths[c.path].lane) {
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
  const n = cars.length;
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

  const gates = r.world.timedGates && r.world.timedGates.gates.length ? r.world.timedGates : null;
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

  // 4. Loose bodies slide to a stop against the walls, then try to drive on.
  for (const c of cars) {
    if (c.mode !== 'loose') continue;
    const bd = c.body;
    const fx = sin(bd.yaw);
    const fz = cos(bd.yaw);
    let vf = bd.vx * fx + bd.vz * fz;
    let vl = bd.vx * fz - bd.vz * fx;
    vf = approach(vf, 0, P.rollDecel * DT);
    vl = approach(vl, 0, P.slideDecel * DT);
    bd.vx = fx * vf + fz * vl;
    bd.vz = fz * vf - fx * vl;
    bd.yawRate = approach(bd.yawRate, 0, P.spinDecel * DT);
    bd.x += bd.vx * DT;
    bd.z += bd.vz * DT;
    bd.yaw = wrapAngle(bd.yaw + bd.yawRate * DT);
    // On the street level (traffic never drives the river channel): over a deck's piers, held by its parapets.
    bd.y = r.world.heightAt(bd.x, bd.z);
    collideCarWithWorld(bd, trafficTuning(c.kind), r.world, undefined, undefined, r.tick);
    bd.speed = sqrt(bd.vx * bd.vx + bd.vz * bd.vz);
    c.still = bd.speed < P.restSpeed && abs(bd.yawRate) < 0.15 ? c.still + DT : 0;
    if (c.still >= P.recoverDelay) tryRejoin(t, c);
  }

  // 5. Contact: race cars against traffic, then struck traffic against the rest.
  for (const rc of r.cars) {
    // A car just reset passes through traffic (collision.resetPassThrough).
    if (rc.finished || rc.passThrough > 0) continue;
    const s = rc.state;
    for (const c of cars) {
      if (c.mode === 'gone') continue;
      const reach = rc.tuning.geometry.halfLength + hl(c) + 0.5;
      if ((c.body.x - s.x) ** 2 + (c.body.z - s.z) ** 2 > reach * reach) continue;
      // Its height on the street level: a race car on the channel floor under a bridge deck passes beneath it.
      c.body.y = r.world.heightAt(c.body.x, c.body.z);
      contact(t, r, rc.index, s, rc.tuning, c);
    }
  }
  for (const c of cars) {
    if (c.mode !== 'loose') continue;
    for (const o of cars) {
      if (o === c || o.mode === 'gone' || (o.mode === 'loose' && o.id < c.id)) continue;
      const reach = hl(c) + hl(o) + 0.5;
      if ((c.body.x - o.body.x) ** 2 + (c.body.z - o.body.z) ** 2 > reach * reach) continue;
      contact(t, r, -1, c.body, trafficTuning(c.kind), o, c);
    }
  }

  // 6. Recycling: out of the bubble, or struck / stuck for good with nobody near, or met by a train; then respawns.
  const focus = r.cars[0]?.state;
  let spawns = 0;
  for (const c of cars) {
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
  for (const rc of r.cars) if ((rc.state.x - c.body.x) ** 2 + (rc.state.z - c.body.z) ** 2 < L.hideDistance * L.hideDistance) return false;
  return true;
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
  if (c.mode === 'drive') turnLoose(t, c);
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
  for (const o of t.cars) {
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
  const t = r.traffic;
  if (!t) return 0;
  for (const c of t.cars) {
    if (c.mode === 'gone') continue;
    const dx = c.body.x - x;
    const dz = c.body.z - z;
    const ahead = dx * fx + dz * fz;
    if (ahead <= 0 || ahead > reach) continue;
    const lat = dx * fz - dz * fx;
    if (abs(lat) < side + hw(c)) return lat >= 0 ? 1 : -1;
  }
  return 0;
}
