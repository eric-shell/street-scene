/**
 * What traffic is made of: TRAFFIC_LAYOUT (the network's layout, counts and spawning numbers; the physics are
 * TRAFFIC in drivingParams.json) and the shapes the rest of the sim shares: a TrafficPath (a lane or a
 * junction connector), the TrafficNet of them, a TrafficCar and the TrafficState that RaceState carries.
 */
import type { RoadKind } from '../../city/roadGraph';
import type { CarState } from '../car';

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
  /** Kerb parking (city/parking.ts): along a row the lane on that side moves in so the widest car keeps this clear (m) of the kerb strip. */
  parkClear: 0.4,
  /** Cell of the kerb slots' broadphase (m). */
  parkCell: 32,
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

/**
 * drive: on its path; loose: a struck passive body; gone: waiting to respawn (moving cars only);
 * parked: standing in its kerb slot (city/parking.ts), a body until struck, never driving.
 */
export type TrafficMode = 'drive' | 'loose' | 'gone' | 'parked';

export interface TrafficCar {
  /** Slot index (stable for the race). */
  id: number;
  /** Index into TRAFFIC.kinds. */
  kind: number;
  mode: TrafficMode;
  /** A parked car's slot (ParkingPlan.cars index), kept once it is struck loose; -1 for the moving fleet. */
  home: number;
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
  /** The moving fleet (ids 0 .. fleet - 1), then the kerb's parked cars (one per occupied slot, id fleet + slot). */
  cars: TrafficCar[];
  /** Size of the moving fleet. */
  fleet: number;
  /** Ids of the parked cars struck out of their slots (loose), ascending: the per tick loops visit these and find the parked ones by place (parkedNear). */
  unparked: number[];
  /** Spawn and turn choices stream (Rng state). */
  rng: number;
}
