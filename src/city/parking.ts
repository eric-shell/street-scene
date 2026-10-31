/**
 * Kerb parking: where cars stand parked along the streets. Pure and cached
 * per World (planParking), from its own random stream, so a race and its
 * replay park the same cars in the same places; the sim makes each occupied
 * slot a traffic car in mode 'parked' (sim/traffic/fleet.ts), a body a car
 * hits and shoves like any struck traffic, drawn by the traffic view.
 *
 * Where: one kerb (a seeded side per street, the same along its bend pieces)
 * of the plain streets whose kerb strip leaves every lane of that side clear
 * (kerbStrip: a two-lane street and a boulevard's wide outer kerb, never an
 * avenue or a diagonal, whose outer lanes run at the kerb). Never on an edge
 * touching a route node (the route, its closed side streets and their meets),
 * nor within routeClear of the route's line, in a race or an open world alike
 * (the menu's cruise and free roam's start drive the route); never a
 * shortcut, the channel, a bridge, a night market's street or a street with
 * roadworks. Along the kerb a slot keeps cornerClear from a junction's curb
 * corner, clear of bus bays and path mouths, a hydrant's front, a bus stop's painted zone (stopClear), a level
 * crossing's gates, and its footprint off every wall and prop and on the road
 * at street level (no deck over the channel), and out of the districts that
 * own their street (PARKING.offAreas: the channel's banks, a tunnel, a viaduct);
 * anything a district stands in the street is thereby never parked into.
 *
 * Parking lots (districts/parkingLot.ts) add their cars after the kerb's: each lot's bays at its occupancy,
 * poses from the lot's own layout (parkingLot/layout.ts), `edge` -1 and `lot` the lot's area id. They are in no
 * row (a lot has no lane to move); the rest of the machinery treats them as any parked car.
 *
 * Lanes keep clear by construction: the traffic network (sim/traffic/net.ts)
 * reads the same plan and, along each row (a run of contiguous valid slots,
 * taken or not), moves that side's lane in so the widest traffic car keeps
 * clear of the strip kerbStrip gives; kerbStrip only admits a street where a
 * full lane width of carriageway stays beside the strip, so the moved lane
 * never crosses the centreline into the opposite one.
 */
import type { World, Contact } from './world';
import type { RoadEdge } from './roadGraph';
import { chainOf, isBendNode, isChannelEdge, isFeatureEdge } from './roadGraph';
import { CITY, PARKING } from './config';
import { baysByEdge, bayHitsCircle } from './busBays';
import { lotLayout } from './districts/parkingLot';
import { Rng, deriveSeed } from '../sim/prng';
import { cos, distToSegment, sin, yawOf } from '../sim/math';

/** A stretch of one kerb carrying slots: the lane on that side keeps clear of it. */
export interface ParkingRow {
  edge: number;
  /** 1: the P side of the edge (normal (-dz, dx) for a -> b, the a -> b lane's kerb), -1: the N side. */
  side: 1 | -1;
  /** Along the edge from node a (m): the row's extent, half a pitch beyond its first and last slot centres. */
  s0: number;
  s1: number;
  /** Width of the strip from the kerb in (m): kerbStrip of the edge. */
  strip: number;
}

/** An occupied slot: a parked car's pose and kind. */
export interface ParkedCar {
  /** Centre (m) and heading (rad, along the kerb in the direction its side's traffic runs). */
  x: number;
  z: number;
  yaw: number;
  /** drivingParams.json traffic.kinds name (one of PARKING.kinds). */
  kind: string;
  edge: number;
  side: 1 | -1;
  /** Along the edge from node a (m). */
  s: number;
  /** A lot car: the parking lot's area id (the edge is then -1). Absent at the kerb. */
  lot?: number;
}

export interface ParkingPlan {
  rows: ParkingRow[];
  /** Occupied slots, in plan order (by edge, side, along the kerb). */
  cars: ParkedCar[];
  /** Every valid slot, taken or not. */
  slots: number;
}

/**
 * The kerb strip a row takes on a street (m from the kerb in), or 0 where none
 * fits: only on PARKING.edgeKinds, and only where at least that side's lanes
 * (lanes / 2 of CITY.laneWidth) of carriageway remain beside it. The plan and
 * the traffic network both read this, so a lane is always moved clear of a row.
 */
export function kerbStrip(e: Pick<RoadEdge, 'kind' | 'width' | 'lanes'>): number {
  if (!(PARKING.edgeKinds as readonly string[]).includes(e.kind)) return 0;
  const strip = PARKING.kerbGap + 2 * PARKING.bodyHalfWidth;
  return e.width / 2 - strip >= (e.lanes / 2) * CITY.laneWidth ? strip : 0;
}

const cache = new WeakMap<World, ParkingPlan>();

/** The kerb parking of a world (pure function of it, built once and cached). */
export function planParking(w: World): ParkingPlan {
  let plan = cache.get(w);
  if (!plan) {
    plan = buildPlan(w);
    cache.set(w, plan);
  }
  return plan;
}

function buildPlan(w: World): ParkingPlan {
  const plan: ParkingPlan = { rows: [], cars: [], slots: 0 };
  const g = w.graph;
  const mouths = w.blocks?.mouths;
  if (!mouths) return plan;
  const rng = new Rng(deriveSeed(w.seed, 'parking'));
  const P = PARKING;
  const routeNodes = new Set(w.route.nodes);
  const pts = w.route.points;
  const areas = w.areas ?? [];
  const closedEdges = new Set<number>([...areas.filter((a) => a.kind === 'roadworks').map((a) => a.params.edge as number), ...areas.filter((a) => a.kind === 'market').flatMap((a) => a.edges)]);
  const bays = baysByEdge(w.blocks.bays ?? [], g.edges.length);
  const hydrants = w.props.filter((p) => p.kind === 'hydrant');
  const stops = w.props.filter((p) => p.kind === 'busStop');
  const contacts: Contact[] = [];
  const near: number[] = [];
  let kindTotal = 0;
  for (const k of P.kinds) kindTotal += k.share;
  const pickKind = (): string => {
    let u = rng.next() * kindTotal;
    for (const k of P.kinds) {
      u -= k.share;
      if (u < 0) return k.name;
    }
    return P.kinds[P.kinds.length - 1].name;
  };
  const half = P.pitch / 2;
  const hw = P.bodyHalfWidth;

  /** Distance from a point to the route's line (m). */
  const routeDistance = (x: number, z: number): number => {
    let d = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(x, z, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z));
    return d;
  };

  /** A slot centred at (x, z) facing yaw is free of everything the street holds. */
  const slotFree = (e: RoadEdge, x: number, z: number, yaw: number, nearRoute: boolean): boolean => {
    if (nearRoute && routeDistance(x, z) < P.routeClear + e.width / 2) return false;
    for (const b of bays[e.id]) if (bayHitsCircle(b, x, z, half + P.bayClear)) return false;
    for (const lc of w.levelCrossings ?? []) if ((lc.x - x) ** 2 + (lc.z - z) ** 2 < (lc.gate + P.crossingClear + half) ** 2) return false;
    if (w.twoLevels(x, z)) return false;
    const area = w.areaAt(x, z);
    if (area && (P.offAreas as readonly string[]).includes(area.kind)) return false;
    const y = w.heightAt(x, z);
    if (w.collideBox(x, z, yaw, half + P.probePad, hw + P.probePad, contacts, y) > 0) return false;
    // On the road under the whole body (the corners a hair inside it).
    const fx = sin(yaw);
    const fz = cos(yaw);
    for (const [u, v] of [
      [0, 0],
      [half - 0.3, hw - 0.1],
      [half - 0.3, -hw + 0.1],
      [-half + 0.3, hw - 0.1],
      [-half + 0.3, -hw + 0.1],
    ]) {
      if (w.surfaceAt(x + fx * u + fz * v, z + fz * u - fx * v) !== 'road') return false;
    }
    for (const h of hydrants) if ((h.x - x) ** 2 + (h.z - z) ** 2 < (half + P.hydrantClear) ** 2) return false;
    // A bus stop keeps its painted zone clear: along the kerb either side of its shelter, a few metres across.
    for (const p of stops) {
      const ddx = p.x - x;
      const ddz = p.z - z;
      if (Math.abs(ddx * fx + ddz * fz) < half + P.stopClear && Math.abs(ddx * fz - ddz * fx) < P.stopReach) return false;
    }
    w.propGrid.query(x - half - 2, z - half - 2, x + half + 2, z + half + 2, near);
    for (const id of near) {
      const p = w.props[id];
      const dx = p.x - x;
      const dz = p.z - z;
      const along = Math.abs(dx * fx + dz * fz);
      const across = Math.abs(dx * fz - dz * fx);
      if (along < half + p.radius + P.probePad && across < hw + p.radius + P.probePad) return false;
    }
    return true;
  };

  // A seeded side and whether it parks at all, per street (a chain of bend pieces), in the chain's own direction.
  const chainSide = new Map<number, 1 | -1 | 0>();
  for (const e of g.edges) {
    const strip = kerbStrip(e);
    if (!strip || e.shortcut || e.bridge || isChannelEdge(e) || isFeatureEdge(e) || closedEdges.has(e.id) || routeNodes.has(e.a) || routeNodes.has(e.b)) continue;
    const chain = chainOf(g, e.id);
    const key = Math.min(...chain.edges);
    let cs = chainSide.get(key);
    if (cs === undefined) {
      cs = rng.next() < P.streetShare ? (rng.next() < 0.5 ? 1 : -1) : 0;
      chainSide.set(key, cs);
    }
    if (!cs) continue;
    const k = chain.edges.indexOf(e.id);
    const side: 1 | -1 = (g.edges[e.id].a === chain.nodes[k] ? cs : -cs) as 1 | -1;
    const A = g.nodes[e.a];
    const B = g.nodes[e.b];
    const len = e.length || 1;
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const m = mouths[e.id];
    // The side's curb corner at each end, measured along the street from its node.
    const reach = (N: typeof A, cx: number, cz: number, sx: number, sz: number) => {
      const t = Math.max(0, (cx - N.x) * sx + (cz - N.z) * sz, N.ring ? N.ring.outer : 0);
      return t + (isBendNode(g, N.id) ? P.bendClear : P.cornerClear);
    };
    const ca = side === 1 ? m.aP.curb : m.aN.curb;
    const cb = side === 1 ? m.bP.curb : m.bN.curb;
    const lo = reach(A, ca.x, ca.z, dx, dz);
    const hi = len - reach(B, cb.x, cb.z, -dx, -dz);
    const n = Math.floor((hi - lo) / P.pitch);
    if (n < 1) continue;
    // Right of travel a -> b is (-dz, dx): the P side; its cars face a -> b, the N side's b -> a.
    const nx = -dz * side;
    const nz = dx * side;
    const off = e.width / 2 - P.kerbGap - hw;
    const yaw = side === 1 ? yawOf(dx, dz) : yawOf(-dx, -dz);
    const first = (lo + hi) / 2 - ((n - 1) * P.pitch) / 2;
    // Edges near the route get the per slot check; the rest are blocks away.
    const nearRoute = distToRoute(pts, A.x, A.z, B.x, B.z) < P.routeClear + e.width / 2 + 1;
    let run = -1;
    let runEnd = 0;
    const close = () => {
      if (run >= 0) plan.rows.push({ edge: e.id, side, s0: run - half, s1: runEnd + half, strip });
      run = -1;
    };
    for (let i = 0; i < n; i++) {
      const s = first + i * P.pitch;
      const x = A.x + dx * s + nx * off;
      const z = A.z + dz * s + nz * off;
      if (!slotFree(e, x, z, yaw, nearRoute)) {
        close();
        continue;
      }
      plan.slots++;
      if (run < 0) run = s;
      runEnd = s;
      if (rng.next() < P.occupancy) plan.cars.push({ x, z, yaw, kind: pickKind(), edge: e.id, side, s });
    }
    close();
  }
  // The lots' cars, in area order.
  for (const a of w.areas ?? []) {
    if (a.kind !== 'parkingLot') continue;
    for (const c of lotLayout(a).cars) plan.cars.push({ x: c.x, z: c.z, yaw: c.yaw, kind: c.kind, edge: -1, side: 1, s: 0, lot: a.id });
    plan.slots += lotLayout(a).bays.length;
  }
  return plan;
}

/** Closest approach of segment a-b to the route's polyline (m; 0 where they cross). */
function distToRoute(pts: readonly { x: number; z: number }[], ax: number, az: number, bx: number, bz: number): number {
  const side = (px: number, pz: number, qx: number, qz: number, x: number, z: number) => (qx - px) * (z - pz) - (qz - pz) * (x - px);
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    if (side(ax, az, bx, bz, p.x, p.z) * side(ax, az, bx, bz, q.x, q.z) < 0 && side(p.x, p.z, q.x, q.z, ax, az) * side(p.x, p.z, q.x, q.z, bx, bz) < 0) return 0;
    d = Math.min(d, distToSegment(p.x, p.z, ax, az, bx, bz), distToSegment(q.x, q.z, ax, az, bx, bz), distToSegment(ax, az, p.x, p.z, q.x, q.z), distToSegment(bx, bz, p.x, p.z, q.x, q.z));
  }
  return d;
}
