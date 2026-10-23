/**
 * Multi-storey car park: a shortcut variant that goes up through a garage.
 *
 * Where a route turns at a junction C with no street straight behind it, the
 * line of the street it turns into (E) runs on backwards into the block
 * behind C. A multi-storey garage taking that whole block lets racers leave
 * the route on an earlier street of the same block, climb its ramp to the
 * first parking floor (the deck, deckHeight up, with more levels drawn over
 * it), cross that floor and leave over a kicker at the end of a walled exit
 * lane (the chute) that lies exactly on E's line, out through the front
 * facade: the jump carries them over the sidewalk and the junction and drops
 * them onto E heading down it. Two layouts, both found by the planner:
 *  - side entry: the route reaches C along the block's side (an S bend: it
 *    turned at the block's corner before C); the ramp climbs from that street
 *    toward E's line and a turn on the deck lines the car up with the chute;
 *  - back entry: the route passes the block's far side first; ramp, deck and
 *    chute are one straight run across the block.
 * The footprint is the block: its building line inset, when the block is
 * convex and not comically large (CFG.blockArea), else cut down behind the
 * drive or the largest frame rectangle that fits (footprintFor). The whole
 * floor is drivable, a real parking floor, not an empty roof: stalls nose in
 * along the parapets and in double rows down the floor with aisles between
 * them, parked cars in half of them, columns on the bay grid and a stair core
 * in a corner (carParkFloor), all kept an open aisle's width off the racing
 * line, the exit lane and the ramp's mouth; the chute's funnel flares wider
 * on the side the turn arrives from. The ramp climbs inside the footprint
 * (only its flared apron reaches the building line), so the block's downtown
 * buildings are gone and its frontage is the garage's own facades.
 * Back entries need the far street's frontage free right on E's line, which
 * is where its junction usually sits, so nearly every car park is a side
 * entry; about a tenth of the seeds get one.
 *
 * In line: the chute is aligned with E's tangent and its walls bound the
 * launch heading for any straight line through it to LAUNCH_BOUND (a car's
 * width inside chuteWidth over chuteLength: about 6 degrees). The landing
 * zone is E's straight from C on, free of junctions and bends for the
 * furthest a launch can carry (flightReach of a run-up speed bound measured
 * in the sim) plus a roll-out; C's closures stay out of the flight, the route's
 * corner rail is cut where the flight crosses it (carParkRails) and street
 * furniture keeps off the launch cone (reserved circles). The apron gets the
 * shortcut treatment on the sidewalk, fence lines and cones funnelling in with
 * strings of bulbs across the mouth and the curb, and a string across the lip
 * (entryDressing).
 *
 * The sim is 2.5D (World.heightAt is single valued), so the drivable floor is
 * a raised surface with an exact gradient (one height modifier: the ramp's
 * eased profile, the deck deckHeight above the ground, the kicker's parabola)
 * and the storeys under and over it are render only. Every edge of the floor
 * is a thin two sided solid (Wall.solid): one body stops cars on the deck at
 * the parapet and cars in the street at the facade under it, with no one
 * sided band reaching through to the other side; the ramp's side walls part
 * it from the deck beside it the same way. The exception is the lip:
 * the face under it is a low wall (Wall.top) that stops cars in the street
 * but lets a car launching off the deck fly over it; its height is set once
 * the terrain exists (settleCarParks). Hills keep their slopes off car parks
 * (hills.ts) and a ramp is long enough that its climb, with the ground's own
 * rise, stays under maxClimb (a crest a fast car keeps its wheels on). On the
 * other route, which the car park is not a shortcut of, a shutter closes the
 * ramp (carParkGates).
 *
 * Planning: the best sites of both routes are held while the alley shortcuts
 * are carved (carParkSites, PlanContext.keepOut: a corner cut would take
 * their block), as long as each route keeps a spot for an alley of its own;
 * once the graph is final the car parks are planned for real (planCarParks).
 * Race progress on the ramp and the deck follows the car park's own line,
 * mapped onto the route stretch it skips (carParkProgress), so it runs on
 * smoothly and is credited in full; a car up there is never counted lost.
 * AI never takes it, like every shortcut. render/districts/carPark.ts draws it.
 */
import { CITY, ROUTE } from '../config';
import { edgeBetween, isBendNode, otherNode } from '../roadGraph';
import type { RoadGraph } from '../roadGraph';
import { circuitStart, routeRuns } from '../route';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { PropKind } from '../props';
import { createTerrain } from '../terrain';
import { DEG, Vec2, atan2, cos, segmentT, sin, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { clipConvex, distToPath, distToPolygonEdge, insetRing, pointInPolygon, polygonArea, polygonBounds, polygonCentroid, segmentAt, segmentInConvex, solidWalls } from './geom';
import { convexRing } from './park';
import type { Area, AreaBuild, DistrictModule, HeightSample, PlanContext } from './types';
import { emptyBuild } from './types';
import type { CarveRoute } from './alleyShortcuts';
import type { Route, RouteKind } from '../route';
import type { RouteProgress } from '../world';

const CFG = CITY.districts.carPark;
/** Half width (m) of the widest car: the launch heading bound and the flight corridor's margin. */
export const CAR_HALF = 0.95;
/** Surface patch priority of the deck and ramp: above every street classification. */
const DECK_PRIORITY = 7;
/** The face under the lip stops street cars up to this far below the roof (m); a launching car is above it. */
const LIP_DROP = 1.6;
/**
 * The ramp's street end widens into a flared apron this deep (m): at the building line it is this
 * much wider on the side racers arrive from (they swing in from the lane), and on the other.
 */
export const APRON = { depth: 10, flareIn: 9, flareOut: 6 } as const;
/**
 * The entry's funnel on the sidewalk (the shortcut language): each fence line splays this much wider
 * (m) from the apron's flared wall out to the curb, a panel every panelStep m; strings of shortcut
 * bulbs hang across the mouth and the curb line, and across the lip opening on the exit facade.
 */
const FUNNEL = { flare: 5, panelStep: 2.1 } as const;
/** Building line straightness tolerance across the deck (m), outline sample step (m). */
const STRAIGHT_TOL = 0.35;
const SAMPLE = 2;
/** Upstream route edges that may hold the entry (2: the one before the street into C). */
const ENTRY_BACK = [2, 3, 4, 5, 6];
/** Sites held per route while the alleys are carved (carParkSites). */
const SITES_HELD = 3;
/** Landing point (m past C) both the route and the car park are measured to when scoring a site. */
const SCORE_LAND = 30;

/** The launch heading bound (rad): a straight line through the chute, a car's width clear of both walls. */
export const LAUNCH_BOUND = atan2(CFG.chuteWidth - 2 * CAR_HALF, CFG.chuteLength);

/** Route index (CarveRoute order in planRoads, Area.params.owner) of each route kind; the drag strip and the waypoint race own none (-1). */
export const ROUTE_INDEX = { circuit: 0, sprint: 1, drag: -1, waypoint: -1 } as const;

/**
 * A car park's geometry in world space, rebuilt from its area params.
 * Frame: origin O on the launch line, `inset` behind the building line; u
 * points into the block (the launch runs along -u), v is u turned left.
 */
export interface CarParkGeo {
  area: number;
  /** Route it is a shortcut of (ROUTE_INDEX). */
  owner: number;
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  vx: number;
  vz: number;
  /** Roof height above the ground (m). */
  H: number;
  /**
   * The drive's box on the deck (the turn or the run, the chute and their margins): its front follows
   * the building line (inset) as a polyline in frame coordinates, ascending v from v0 to v1 (a junction
   * corner may kink it); back edge u1, sides v0 .. v1 (m). The floor itself is `deck`, which holds it.
   */
  front: { u: number; v: number }[];
  u1: number;
  v0: number;
  v1: number;
  /** Chute half width and length of its parallel walls (m); its mouth funnel's length and extra half width (m); kicker length and rise (m). */
  hc: number;
  lc: number;
  cf: number;
  cw: number;
  kl: number;
  kh: number;
  /** Ramp foot center on the entry building line (inset) and up-ramp unit axis. */
  rcx: number;
  rcz: number;
  rax: number;
  raz: number;
  /** Ramp half width; the apron's flare on its right (-l) and left (+l) sides at the building line (m). */
  rhw: number;
  fl: number;
  fr: number;
  /** Apron start and end along the axis, profile length and where the deck takes over (m). */
  apron0: number;
  apron1: number;
  rl: number;
  rend: number;
  /** Entry building line's inward unit normal: the foot is clipped by the line through the foot center. */
  fnx: number;
  fnz: number;
  /** Side entry from +v (1) or -v (-1); back entry 0. */
  side: number;
  /** Roof turn radius (side entries, m). */
  turn: number;
  /** Junction the route turns at, the street it lands on, the entry's street. */
  node: number;
  landEdge: number;
  entryEdge: number;
  /** Distance from C back along E's line to O (m). */
  lipBack: number;
  /** Furthest landing the planner allowed for, from the lip (m), and the clear zone from C (m). */
  landMax: number;
  landZone: number;
  /**
   * World outlines: the deck (the footprint: the drivable floor's convex outline along the building
   * lines, where the parapets and the facades under them stand) and its bounds, the ramp (apron and
   * strip: six points from the building line, inside the deck), the chute's parallel walls, the lip.
   */
  deck: Vec2[];
  box: { minX: number; minZ: number; maxX: number; maxZ: number };
  ramp: Vec2[];
  chute: Vec2[];
  lip: [Vec2, Vec2];
  /** Racing line: apron start, ramp top, the roof (turn), chute mouth, lip. */
  path: Vec2[];
}

type Frame = Pick<CarParkGeo, 'ox' | 'oz' | 'ux' | 'uz' | 'vx' | 'vz'>;
const toWorld = (g: Frame, u: number, v: number): Vec2 => ({ x: g.ox + g.ux * u + g.vx * v, z: g.oz + g.uz * u + g.vz * v });
const toU = (g: Frame, p: Vec2) => (p.x - g.ox) * g.ux + (p.z - g.oz) * g.uz;
const toV = (g: Frame, p: Vec2) => (p.x - g.ox) * g.vx + (p.z - g.oz) * g.vz;

/** The deck's front (frame u) at lateral v: the front polyline, held flat past its ends. */
export function frontU(g: Pick<CarParkGeo, 'front'>, v: number): number {
  const f = g.front;
  if (v <= f[0].v) return f[0].u;
  for (let i = 1; i < f.length; i++) {
    if (v <= f[i].v) {
      const a = f[i - 1];
      const b = f[i];
      return b.v - a.v > 1e-9 ? a.u + ((b.u - a.u) * (v - a.v)) / (b.v - a.v) : b.u;
    }
  }
  return f[f.length - 1].u;
}

/** A point on the ramp: `a` m up its axis from the foot center, `l` m to the left of it. */
export function rampPoint(g: CarParkGeo, a: number, l: number): Vec2 {
  return { x: g.rcx + g.rax * a - g.raz * l, z: g.rcz + g.raz * a + g.rax * l };
}

/** Ramp half width (m) at `a` along its axis on side l (sign): the apron flares out toward the building line. */
export function rampHalf(g: CarParkGeo, a: number, l: number): number {
  const t = (g.apron1 - a) / (g.apron1 - g.apron0);
  return g.rhw + (l < 0 ? g.fl : g.fr) * (t > 1 ? 1 : t < 0 ? 0 : t);
}

/** Rebuild the geometry from an area's params (kind 'carPark'). */
export function carParkGeo(area: Area): CarParkGeo {
  const p = area.params;
  const geo: CarParkGeo = {
    area: area.id,
    owner: p.owner,
    ox: p.ox,
    oz: p.oz,
    ux: p.ux,
    uz: p.uz,
    vx: -p.uz,
    vz: p.ux,
    H: p.H,
    front: Array.from({ length: p.fn }, (_, i) => ({ u: p[`fu${i}`], v: p[`fv${i}`] })),
    u1: p.u1,
    v0: p.v0,
    v1: p.v1,
    hc: p.hc,
    lc: p.lc,
    cf: p.cf,
    cw: p.cw,
    kl: p.kl,
    kh: p.kh,
    rcx: p.rcx,
    rcz: p.rcz,
    rax: p.rax,
    raz: p.raz,
    rhw: p.rhw,
    fl: p.fl,
    fr: p.fr,
    apron0: p.apron0,
    apron1: p.apron1,
    rl: p.rl,
    rend: p.rend,
    fnx: p.fnx,
    fnz: p.fnz,
    side: p.side,
    turn: p.turn,
    node: p.node,
    landEdge: p.landEdge,
    entryEdge: p.entryEdge,
    lipBack: p.lipBack,
    landMax: p.landMax,
    landZone: p.landZone,
    deck: Array.from({ length: p.fpn }, (_, i) => ({ x: p[`fpx${i}`], z: p[`fpz${i}`] })),
    box: { minX: 0, minZ: 0, maxX: 0, maxZ: 0 },
    ramp: [],
    chute: [],
    lip: [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
    ],
    path: [],
  };
  const W = (u: number, v: number) => toWorld(geo, u, v);
  geo.box = polygonBounds(geo.deck);
  const fa = frontU(geo, -geo.hc);
  const fb = frontU(geo, geo.hc);
  geo.chute = [W(fa, -geo.hc), W(geo.lc, -geo.hc), W(geo.lc, geo.hc), W(fb, geo.hc)];
  geo.lip = [geo.chute[0], geo.chute[3]];
  // Where the building line through the foot center crosses the apron's outer edges (a, along the axis).
  const lx = -geo.raz;
  const lz = geo.rax;
  const an = geo.rax * geo.fnx + geo.raz * geo.fnz;
  const footA = (l: number) => -(l * (lx * geo.fnx + lz * geo.fnz)) / an;
  const wl = geo.rhw + geo.fl;
  const wr = geo.rhw + geo.fr;
  geo.ramp = [rampPoint(geo, footA(-wl), -wl), rampPoint(geo, geo.apron1, -geo.rhw), rampPoint(geo, geo.rend, -geo.rhw), rampPoint(geo, geo.rend, geo.rhw), rampPoint(geo, geo.apron1, geo.rhw), rampPoint(geo, footA(wr), wr)];
  const top = rampPoint(geo, geo.rend, 0);
  geo.path = [rampPoint(geo, geo.apron0, 0), top];
  if (geo.side !== 0) {
    // Roof turn: straight on from the ramp top to the arc, a quarter circle of radius R from heading
    // -side v at u = ur onto the chute's line (heading -u), then down the chute.
    const ur = toU(geo, top);
    const R = geo.turn;
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * (Math.PI / 2);
      geo.path.push(W(ur - R + R * cos(a), geo.side * R * (1 - sin(a))));
    }
  }
  const mouth = W(geo.lc + geo.cf, 0);
  const last = geo.path[geo.path.length - 1];
  if ((mouth.x - last.x) ** 2 + (mouth.z - last.z) ** 2 > 1e-4) geo.path.push(mouth);
  geo.path.push(W(0, 0));
  return geo;
}

/** Unit ramp profile (0 to 1 over length L, eased over `ease` at both ends) and its slope. */
export function rampProfile(s: number, L: number, ease: number): { q: number; dq: number } {
  if (s <= 0) return { q: 0, dq: 0 };
  if (s >= L) return { q: 1, dq: 0 };
  const m = 1 / (L - ease);
  if (s < ease) return { q: (m * s * s) / (2 * ease), dq: (m * s) / ease };
  if (s < L - ease) return { q: m * (s - ease / 2), dq: m };
  const r = L - s;
  return { q: 1 - (m * r * r) / (2 * ease), dq: (m * r) / ease };
}

/**
 * The car park's own height above the ground (m) and its gradient at
 * (x, z), added into `out`; nothing outside the footprint. The ramp comes
 * first, since it climbs inside the footprint: curb height across its apron,
 * then its eased profile up to H where the deck takes over. The rest of the
 * footprint is the deck, a flat offset H (it rolls with the ground under it),
 * with the kicker's parabola, steepest at the lip, in the exit lane.
 */
export function carParkLift(g: CarParkGeo, x: number, z: number, out: HeightSample): void {
  if (x < g.box.minX || x > g.box.maxX || z < g.box.minZ || z > g.box.maxZ) return;
  const rx = x - g.rcx;
  const rz = z - g.rcz;
  const a = rx * g.rax + rz * g.raz;
  if (a <= g.rend && rx * g.fnx + rz * g.fnz >= 0) {
    const l = -rx * g.raz + rz * g.rax;
    if ((l < 0 ? -l : l) <= rampHalf(g, a, l)) {
      const c = CITY.curbHeight;
      const p = rampProfile(a - g.apron1, g.rl, CFG.rampEase);
      out.h += c + (g.H - c) * p.q;
      const d = (g.H - c) * p.dq;
      out.gx += d * g.rax;
      out.gz += d * g.raz;
      return;
    }
  }
  if (!pointInPolygon(x, z, g.deck)) return;
  out.h += g.H;
  const dx = x - g.ox;
  const dz = z - g.oz;
  const u = dx * g.ux + dz * g.uz;
  const v = dx * g.vx + dz * g.vz;
  if (u < g.kl && v >= -g.hc && v <= g.hc) {
    const k = (g.kl - u) / g.kl;
    out.h += g.kh * k * k;
    const du = (-2 * g.kh * k) / g.kl;
    out.gx += du * g.ux;
    out.gz += du * g.uz;
  }
}

/** Height (m) and gradient of the car park alone at a point (0 outside it). */
export function carParkHeight(g: CarParkGeo, x: number, z: number): HeightSample {
  const s: HeightSample = { h: 0, gx: 0, gz: 0 };
  carParkLift(g, x, z, s);
  return s;
}

/** Thin two sided solid along a-b, t thick toward `toward` (any point on that side). */
function slab(a: Vec2, b: Vec2, toward: Vec2, t: number, area: number): Wall[] {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = sqrt(dx * dx + dz * dz);
  if (len < 0.3) return [];
  let nx = -dz / len;
  let nz = dx / len;
  if ((toward.x - a.x) * nx + (toward.z - a.z) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  return solidWalls([a, b, { x: b.x + nx * t, z: b.z + nz * t }, { x: a.x + nx * t, z: a.z + nz * t }], 'carPark', area);
}

/** The funnel's extra half width at its mouth on side s (sign of v, m): wider on the side a side entry's turn arrives from. */
export function funnelFlare(g: Pick<CarParkGeo, 'cw' | 'side'>, s: number): number {
  return g.cw + (g.side === s ? CFG.funnelArrive : 0);
}

/** A parking stall on the drivable floor: center, the unit heading of a car parked nose in (toward the parapet), its car. */
export interface Stall {
  x: number;
  z: number;
  dx: number;
  dz: number;
  /** A parked car's paint pick (0..1), or -1 for an empty stall. */
  car: number;
}

/** What stands on the drivable floor: stalls, the columns at the inner end of their runs, the stair core (null when no corner is free). */
export interface CarParkFloor {
  stalls: Stall[];
  /** Column centers (square, aligned to the frame; side CFG.wall * 1.5). */
  columns: Vec2[];
  /** The stair core's corners (a square of side CFG.core in the frame), or null. */
  core: Vec2[] | null;
}

/** A parked car's footprint (m): the box carParkWalls makes solid and the renderer draws. */
export const PARKED_CAR = { length: 4.3, width: 1.8 } as const;
/** Interior column side (m). */
export const COLUMN = 0.6;

/** Two convex polygons overlap (separating axis test). */
function convexOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q.z - p.z;
      const nz = p.x - q.x;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (const r of a) {
        const d = r.x * nx + r.z * nz;
        a0 = Math.min(a0, d);
        a1 = Math.max(a1, d);
      }
      for (const r of b) {
        const d = r.x * nx + r.z * nz;
        b0 = Math.min(b0, d);
        b1 = Math.max(b1, d);
      }
      if (a1 < b0 || b1 < a0) return false;
    }
  }
  return true;
}

/**
 * A parking floor's fittings, the same for the sim (carParkWalls makes the
 * drivable floor's cars, columns and core solid) and the renderer (which
 * draws every level): stalls nose in along the parapets and back to back in
 * double rows down the floor with an aisle between the rows, a car parked in
 * some, a column at the aisle end of every few stalls and a stair core in a
 * corner. On the drivable floor (`upper` false) all of it keeps aisleClear
 * from the racing line, off the exit lane and its funnel, out of the ramp's
 * mouth and off the straight on from it, so the drive itself is an open
 * aisle and nothing a car is meant to cross is in the way; the other levels
 * are render only and park right across that. Deterministic per seed.
 */
export function carParkFloor(g: CarParkGeo, seed: number, upper = false): CarParkFloor {
  const t = CFG.wall;
  const [P, D] = CFG.stall;
  const W = (u: number, v: number) => toWorld(g, u, v);
  const rng = new Rng(((seed ^ (upper ? 0x0dd1ab1e : 0x5ca1ab1e)) >>> 0) || 1);
  // Inside the parapets; off the ramp and its walls (the strip it climbs in and the apron's flare).
  const floorIn = insetRing(g.deck, t - 0.02) ?? g.deck;
  const rampHole = insetRing(g.ramp, -(t + 0.4)) ?? g.ramp;
  // The exit lane and its funnel, a margin round them (convex, frame order).
  const m = t + 0.6;
  const fMin = Math.min(...g.front.map((f) => f.u));
  const lane = [W(fMin - 1, -(g.hc + m)), W(g.lc, -(g.hc + m)), W(g.lc + g.cf + 1, -(g.hc + funnelFlare(g, -1) + m)), W(g.lc + g.cf + 1, g.hc + funnelFlare(g, 1) + m), W(g.lc, g.hc + m), W(fMin - 1, g.hc + m)];
  const mouth = rampPoint(g, g.rend, 0);
  const mouthClear = g.rhw + CFG.aisleClear;
  // Straight on across the deck from the ramp's mouth: where a car that misses the turn ends up.
  const reach = g.box.maxX - g.box.minX + g.box.maxZ - g.box.minZ;
  const sw = g.rhw + 1.5;
  const straight = [rampPoint(g, g.rend - 1, -sw), rampPoint(g, g.rend + reach, -sw), rampPoint(g, g.rend + reach, sw), rampPoint(g, g.rend - 1, sw)];
  const placed: Vec2[][] = [];
  const clear = (poly: Vec2[]): boolean => {
    for (const p of poly) if (!pointInPolygon(p.x, p.z, floorIn)) return false;
    if (convexOverlap(poly, rampHole)) return false;
    for (const q of placed) if (convexOverlap(poly, q)) return false;
    if (upper) return true;
    if (convexOverlap(poly, lane) || convexOverlap(poly, straight)) return false;
    let cx = 0;
    let cz = 0;
    for (const p of poly) {
      if (distToPath(g.path, p.x, p.z) < CFG.aisleClear) return false;
      if ((p.x - mouth.x) ** 2 + (p.z - mouth.z) ** 2 < mouthClear * mouthClear) return false;
      cx += p.x / poly.length;
      cz += p.z / poly.length;
    }
    return distToPath(g.path, cx, cz) >= CFG.aisleClear;
  };
  const rect = (u0: number, u1: number, v0: number, v1: number) => [W(u0, v0), W(u1, v0), W(u1, v1), W(u0, v1)];
  // The footprint's frame bounds.
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of g.deck) {
    const u = toU(g, p);
    const v = toV(g, p);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }

  // Stair core: in the footprint's corner furthest from the racing line (never where a car runs wide),
  // slid in along the corner's diagonal until it fits.
  let core: Vec2[] | null = null;
  let coreFar = 0;
  const S = CFG.core;
  for (const [su, sv] of [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ] as const) {
    let corner = g.deck[0];
    let best = -Infinity;
    for (const p of g.deck) {
      const d = su * toU(g, p) + sv * toV(g, p);
      if (d > best) {
        best = d;
        corner = p;
      }
    }
    const cu = toU(g, corner);
    const cv = toV(g, corner);
    for (let k = t + 0.3; k <= 12; k += 1) {
      const u0 = su < 0 ? cu + k : cu - k - S;
      const v0 = sv < 0 ? cv + k : cv - k - S;
      const r = rect(u0, u0 + S, v0, v0 + S);
      if (!clear(r)) continue;
      const far = Math.min(...r.map((p) => distToPath(g.path, p.x, p.z)));
      if (far > coreFar) {
        coreFar = far;
        core = r;
      }
      break;
    }
  }
  if (core) placed.push(insetRing(core, -0.3) ?? core);

  const stalls: Stall[] = [];
  const columns: Vec2[] = [];
  /** A stall centred at c, nose along unit n (toward the wall or the row's spine), P wide across it. */
  const stallRect = (c: Vec2, n: Vec2): Vec2[] => {
    const lx = -n.z;
    const lz = n.x;
    return [
      { x: c.x - n.x * (D / 2) - lx * (P / 2), z: c.z - n.z * (D / 2) - lz * (P / 2) },
      { x: c.x + n.x * (D / 2) - lx * (P / 2), z: c.z + n.z * (D / 2) - lz * (P / 2) },
      { x: c.x + n.x * (D / 2) + lx * (P / 2), z: c.z + n.z * (D / 2) + lz * (P / 2) },
      { x: c.x - n.x * (D / 2) + lx * (P / 2), z: c.z - n.z * (D / 2) + lz * (P / 2) },
    ];
  };
  /**
   * A run of `count` stalls at `at(k)` with nose `nose(k)` (and `fits(k)`), a column at the aisle end
   * between every few of them at `columnAt(k)` (null: a row half whose other half places the spine's).
   */
  const run = (count: number, at: (k: number) => Vec2, nose: (k: number) => Vec2, columnAt: ((k: number) => Vec2) | null, fits: (k: number) => boolean = () => true) => {
    const ok: boolean[] = [];
    const rects: Vec2[][] = [];
    for (let k = 0; k < count; k++) {
      const r = stallRect(at(k), nose(k));
      ok.push(fits(k) && clear(r));
      rects.push(r);
    }
    for (let k = 0; k < count; k++) {
      if (!ok[k]) continue;
      placed.push(rects[k]);
      const c = at(k);
      const n = nose(k);
      stalls.push({ x: c.x, z: c.z, dx: n.x, dz: n.z, car: rng.chance(CFG.parkedShare) ? rng.next() : -1 });
      if (!columnAt || (k + 1) % CFG.columnEvery !== 0 || k + 1 >= count || !ok[k + 1]) continue;
      columns.push(columnAt(k));
    }
  };
  // Along the parapets, nose to the wall (inward by the footprint's way round).
  const inward = polygonArea(g.deck) < 0 ? 1 : -1;
  const nd = g.deck.length;
  const perimeter: Vec2[] = [];
  for (let i = 0; i < nd; i++) {
    const p = g.deck[i];
    const q = g.deck[(i + 1) % nd];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = sqrt(dx * dx + dz * dz);
    if (len < P + 2 * t) continue;
    const dir = { x: dx / len, z: dz / len };
    const n = { x: dir.z * inward, z: -dir.x * inward };
    const count = Math.floor((len - 2 * t) / P);
    const s0 = (len - count * P) / 2;
    const at = (k: number): Vec2 => ({ x: p.x + dir.x * (s0 + P * (k + 0.5)) + n.x * (t + D / 2), z: p.z + dir.z * (s0 + P * (k + 0.5)) + n.z * (t + D / 2) });
    const before = stalls.length;
    run(count, at, () => ({ x: -n.x, z: -n.z }), (k) => ({ x: p.x + dir.x * (s0 + P * (k + 1)) + n.x * (t + D - COLUMN / 2), z: p.z + dir.z * (s0 + P * (k + 1)) + n.z * (t + D - COLUMN / 2) }));
    for (let k = before; k < stalls.length; k++) perimeter.push(stalls[k]);
  }
  // Double rows down the floor along u, an aisle between them and from the parapets' stalls.
  const aisleGap = D + CFG.aisle - 1;
  const rowClear = (c: Vec2): boolean => perimeter.every((q) => (q.x - c.x) ** 2 + (q.z - c.z) ** 2 >= aisleGap * aisleGap);
  const nu = Math.floor((uMax - uMin) / P);
  for (let vr = vMin + t + D + CFG.aisle + D; vr + D + CFG.aisle + D + t <= vMax; vr += 2 * D + CFG.aisle) {
    for (const sv of [1, -1] as const) {
      const at = (k: number) => W(uMin + P * (k + 0.5), vr + (sv * D) / 2);
      const nose = { x: -sv * g.vx, z: -sv * g.vz };
      run(nu, at, () => nose, sv > 0 ? (k) => W(uMin + P * (k + 1), vr) : null, (k) => rowClear(at(k)));
    }
  }
  return { stalls, columns, core };
}

/** The parked car in a stall as a world polygon (the body's footprint, nose toward the parapet). */
export function parkedCarBox(s: Stall): Vec2[] {
  const hl = PARKED_CAR.length / 2;
  const hw = PARKED_CAR.width / 2;
  const lx = -s.dz;
  const lz = s.dx;
  return [
    { x: s.x - s.dx * hl - lx * hw, z: s.z - s.dz * hl - lz * hw },
    { x: s.x + s.dx * hl - lx * hw, z: s.z + s.dz * hl - lz * hw },
    { x: s.x + s.dx * hl + lx * hw, z: s.z + s.dz * hl + lz * hw },
    { x: s.x - s.dx * hl + lx * hw, z: s.z - s.dz * hl + lz * hw },
  ];
}

/** A column as a world polygon (square, aligned to the car park's frame). */
export function columnBox(g: Frame, c: Vec2): Vec2[] {
  const h = COLUMN / 2;
  return [-1, 1, 1, -1].map((su, i) => {
    const sv = i < 2 ? -1 : 1;
    return { x: c.x + g.ux * su * h + g.vx * sv * h, z: c.z + g.uz * su * h + g.vz * sv * h };
  });
}

/** What a piece of the footprint's outline is: parapet and facade, the lip's opening, or the ramp's mouth. */
export type DeckEdgeKind = 'wall' | 'lip' | 'ramp';

/**
 * The two openings in the footprint's outline as convex world polygons: the
 * lip (the exit lane's width across the front, reaching out past the
 * building line) and the ramp's mouth (the apron between its flared walls'
 * outer faces, reaching out across the sidewalk).
 */
export function deckOpenings(g: CarParkGeo): { lip: Vec2[]; ramp: Vec2[] } {
  const W = (u: number, v: number) => toWorld(g, u, v);
  const fMin = Math.min(...g.front.map((f) => f.u));
  const t = CFG.wall;
  const l0 = -(g.rhw + g.fl + t);
  const l1 = g.rhw + g.fr + t;
  return {
    lip: [W(fMin - 3, -g.hc), W(g.lc, -g.hc), W(g.lc, g.hc), W(fMin - 3, g.hc)],
    ramp: [rampPoint(g, -6, l0), rampPoint(g, g.apron0 + 1, l0), rampPoint(g, g.apron0 + 1, l1), rampPoint(g, -6, l1)],
  };
}

/**
 * The footprint's outline in ring order, each edge cut where an opening
 * crosses it: the pieces that are parapet (and facade under it), the lip's
 * span and the ramp's mouth. The sim walls the first kind (carParkWalls);
 * the renderer dresses all three (render/districts/carPark.ts).
 */
export function deckEdges(g: CarParkGeo): { a: Vec2; b: Vec2; kind: DeckEdgeKind }[] {
  const open = deckOpenings(g);
  const holes: [Vec2[], DeckEdgeKind][] = [
    [open.lip, 'lip'],
    [open.ramp, 'ramp'],
  ];
  const out: { a: Vec2; b: Vec2; kind: DeckEdgeKind }[] = [];
  const n = g.deck.length;
  for (let i = 0; i < n; i++) {
    const a = g.deck[i];
    const b = g.deck[(i + 1) % n];
    const at = (t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    const spans: { t0: number; t1: number; kind: DeckEdgeKind }[] = [];
    for (const [poly, kind] of holes) {
      const span = segmentInConvex(a, b, poly);
      if (span && span[1] - span[0] > 1e-6) spans.push({ t0: span[0], t1: span[1], kind });
    }
    spans.sort((p, q) => p.t0 - q.t0);
    let t = 0;
    for (const sp of spans) {
      if (sp.t0 > t + 1e-6) out.push({ a: at(t), b: at(sp.t0), kind: 'wall' });
      out.push({ a: at(sp.t0), b: at(sp.t1), kind: sp.kind });
      t = sp.t1;
    }
    if (t < 1 - 1e-6) out.push({ a: at(t), b: at(1), kind: 'wall' });
  }
  return out;
}

/**
 * Every wall of a car park: thin solids (look 'carPark') along the
 * footprint's outline (open across the lip and the ramp's mouth), both chute
 * walls, the apron's flared sides and the ramp's sides; the drivable floor's
 * parked cars, columns and stair core (carParkFloor); then the one sided low
 * face under the lip (Wall.top, settled later).
 */
export function carParkWalls(g: CarParkGeo, seed: number): Wall[] {
  const out: Wall[] = [];
  const t = CFG.wall;
  const W = (u: number, v: number) => toWorld(g, u, v);
  // Parapets sit inside the footprint (thickened inward by its way round: an L's centroid may lie
  // outside it), chute and ramp walls outside the lane they line.
  const inward = polygonArea(g.deck) < 0 ? 1 : -1;
  for (const e of deckEdges(g)) {
    if (e.kind !== 'wall') continue;
    const n = { x: (e.b.z - e.a.z) * inward, z: -(e.b.x - e.a.x) * inward };
    out.push(...slab(e.a, e.b, { x: e.a.x + n.x, z: e.a.z + n.z }, t, g.area));
  }
  // Chute walls: parallel from the front line, then splaying out into the mouth's funnel.
  for (const s of [-1, 1]) {
    const cw = funnelFlare(g, s);
    out.push(...slab(W(frontU(g, g.hc * s), g.hc * s), W(g.lc, g.hc * s), W(g.lc / 2, g.hc * s * 3), t, g.area));
    out.push(...slab(W(g.lc, g.hc * s), W(g.lc + g.cf, (g.hc + cw) * s), W(g.lc + g.cf / 2, (g.hc + cw) * s * 3), t, g.area));
  }
  // The drivable floor's parked cars, columns and stair core.
  const floor = carParkFloor(g, seed);
  for (const s of floor.stalls) if (s.car >= 0) out.push(...solidWalls(parkedCarBox(s), 'carPark', g.area));
  for (const c of floor.columns) out.push(...solidWalls(columnBox(g, c), 'carPark', g.area));
  if (floor.core) out.push(...solidWalls(floor.core, 'carPark', g.area));
  const r = g.ramp;
  const mid = rampPoint(g, (g.apron1 + g.rend) / 2, 0);
  const away = (p: Vec2) => ({ x: 2 * p.x - mid.x, z: 2 * p.z - mid.z });
  out.push(...slab(r[0], r[1], away(r[0]), t, g.area));
  out.push(...slab(r[5], r[4], away(r[5]), t, g.area));
  for (const s of [-1, 1]) out.push(...slab(rampPoint(g, g.apron1, s * g.rhw), rampPoint(g, g.rend, s * g.rhw), rampPoint(g, g.apron1, s * g.rhw * 3), t, g.area));
  // The face under the lip: the front polyline across it, one sided toward the street.
  const lipV = [-g.hc, ...g.front.map((f) => f.v).filter((v) => v > -g.hc && v < g.hc), g.hc];
  for (let i = 1; i < lipV.length; i++) {
    const a = W(frontU(g, lipV[i - 1]), lipV[i - 1]);
    const b = W(frontU(g, lipV[i]), lipV[i]);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = sqrt(dx * dx + dz * dz);
    if (len < 0.05) continue;
    // Normal out of the deck (toward -u).
    let nx = -dz / len;
    let nz = dx / len;
    if (nx * g.ux + nz * g.uz > 0) {
      nx = -nx;
      nz = -nz;
    }
    out.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, nx, nz, kind: 'wall', look: 'carPark', area: g.area, top: Infinity });
  }
  return out;
}

/**
 * The flight corridor (world quad): from just behind the lip `reach` m down
 * E's line, widening at the launch bound, padded by `pad` m each side.
 */
export function flightCorridor(g: CarParkGeo, reach: number, pad = 0): Vec2[] {
  const spread = Math.tan(LAUNCH_BOUND);
  const h0 = g.hc + pad;
  const h1 = g.hc + reach * spread + pad;
  return [toWorld(g, 0.5, -h0), toWorld(g, -reach, -h1), toWorld(g, -reach, h1), toWorld(g, 0.5, h0)];
}

/** The outline of the whole structure (areaAt, maps): the footprint, which the ramp climbs inside of. */
export function carParkOutline(g: CarParkGeo): Vec2[] {
  return g.deck;
}

export const carParkModule: DistrictModule = {
  kind: 'carPark',
  phase: 'graph',
  // Planned by planCarParks from world.ts's topology hook (it needs both routes). Here, registered right
  // after the night market (whose carriageway edit forbids claimed faces), each claims its block.
  plan(ctx) {
    const faces = ctx.faces();
    for (const a of ctx.areas) {
      if (a.kind !== 'carPark' || a.faces.length) continue;
      const g = carParkGeo(a);
      const p = polygonCentroid(g.deck);
      const f = faces.find((x) => !x.outer && pointInPolygon(p.x, p.z, x.ring));
      if (!f || ctx.claims.face.has(f.id)) continue;
      a.faces = [f.id];
      ctx.claims.face.set(f.id, a.id);
    }
  },
  build(ctx, area) {
    const b = emptyBuild();
    const g = carParkGeo(area);
    b.heightMods.push({
      minX: g.box.minX - 0.5,
      minZ: g.box.minZ - 0.5,
      maxX: g.box.maxX + 0.5,
      maxZ: g.box.maxZ + 0.5,
      add(x: number, z: number, out: HeightSample) {
        carParkLift(g, x, z, out);
      },
    });
    b.surfaces.push({ surface: 'road', polygon: g.deck, priority: DECK_PRIORITY, area: area.id });
    b.walls.push(...carParkWalls(g, area.params.seed ?? 0));
    // The block's buildings go (the garage is the block; they keep `clear` off its facades where it
    // does not reach the building line) and its frontage opens (the parapets and the facades under them
    // are the walls), reaching out past the building line so every frontage probe falls in.
    b.exclusions.push(...footprint(g, CFG.clear));
    b.openings.push(...footprint(g, 2));
    const W = (u: number, v: number) => toWorld(g, u, v);
    // Street furniture keeps off the flight (the launch cone and a car's width, out to the furthest
    // landing: over the sidewalk, the junction and the landing street's sidewalks), and off the driveway.
    const spread = Math.tan(LAUNCH_BOUND);
    for (let s = 0; s <= g.landMax + 2.5; s += 2.5) {
      const c = W(-s, 0);
      b.reserved.push({ x: c.x, z: c.z, r: g.hc + s * spread + CAR_HALF });
    }
    for (let k = -1; k <= 1; k++) {
      const c = rampPoint(g, g.apron0 - 3, k * (g.rhw + (k < 0 ? g.fl : g.fr) * 0.6));
      b.reserved.push({ x: c.x, z: c.z, r: g.rhw + 1 });
    }
    // A sawhorse and cones at the ramp's foot (smashed on the way in). Inside, the ceiling's strip lights
    // light the floor (render/districts/carPark.ts): no lamp posts under a ceiling.
    const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
    const across = Math.atan2(-g.rax, -g.raz);
    b.destructibles.push({ kind: 'sawhorse', ...rampPoint(g, g.apron1 + 1.5, rng.range(-1.4, 1.4)), yaw: across + rng.range(-0.15, 0.15), lift: 0, area: area.id });
    for (let k = 0; k < 4; k++) {
      const p = rampPoint(g, g.apron0 + 1 + rng.range(0, 4), (k < 2 ? -1 : 1) * (g.rhw + (k < 2 ? g.fl : g.fr) * 0.4 - rng.range(0, 1.2)));
      b.destructibles.push({ kind: 'trafficCone', ...p, yaw: rng.range(0, Math.PI * 2), lift: 0, area: area.id });
    }
    entryDressing(g, b, rng, ctx.graph.edges[g.entryEdge].sidewalk, area.id);
    return b;
  },
};

/**
 * The entry's shortcut treatment, as a river ramp top or an alley mouth gets
 * (districts/river.ts funnel, alleyDressing.ts constructionSite): two lines
 * of fence panels on the sidewalk splaying from the ends of the apron's
 * flared walls out to the curb, cones scattered inside them, a sawhorse at
 * each line's curb end, and strings of the shortcut bulbs across the mouth at
 * the building line and across the curb line in front of it; a third string
 * hangs across the lip opening on the exit facade, so the way out reads from
 * the landing street too. Everything on the ground breaks before it can stop
 * a car; the strings are render only (hints, render/districts/carPark.ts).
 * The entry street's lanes stay clear: nothing stands past the curb.
 */
function entryDressing(g: CarParkGeo, b: AreaBuild, rng: Rng, sidewalk: number, area: number): void {
  const an = g.rax * g.fnx + g.raz * g.fnz;
  const ln = -g.raz * g.fnx + g.rax * g.fnz;
  /** The building line's a (m up the ramp axis) at lateral l: the apron's foot is cut by it. */
  const footA = (l: number) => -(l * ln) / an;
  /** A sidewalk point `back` m out from the building line toward the curb, at lateral l of the ramp axis. */
  const P = (l: number, back: number): Vec2 => {
    const q = rampPoint(g, footA(l), l);
    return { x: q.x - g.fnx * back, z: q.z - g.fnz * back };
  };
  const push = (kind: PropKind, q: Vec2, yaw: number) => b.destructibles.push({ kind, x: q.x, z: q.z, yaw, lift: 0, area });
  const t = CFG.wall;
  const curbBack = sidewalk - 0.9;
  const ends: Vec2[] = [];
  for (const sd of [-1, 1]) {
    // From just past the flared wall's end at the building line to the curb, FUNNEL.flare further out.
    const lIn = sd * (g.rhw + (sd < 0 ? g.fl : g.fr) + t + 0.6);
    const A = P(lIn, 0.8);
    const B = P(lIn + sd * FUNNEL.flare, curbBack);
    ends.push(B);
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const yaw = atan2(-uz, ux);
    const n = Math.max(2, Math.round(len / FUNNEL.panelStep));
    for (let k = 0; k <= n; k++) {
      const q = { x: A.x + (B.x - A.x) * (k / n), z: A.z + (B.z - A.z) * (k / n) };
      push('fencePanel', q, yaw + rng.range(-0.1, 0.1));
      // Street furniture keeps off the line (generateProps drops a destructible that overlaps a prop).
      b.reserved.push({ x: q.x, z: q.z, r: 1.6 });
    }
    // Cones inside the line (toward the mouth), light enough that a car through them barely notices.
    const inX = -sd * uz;
    const inZ = sd * ux;
    const k0 = (inX * -g.raz + inZ * g.rax) * sd < 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) {
      const f = 0.25 + k * 0.25 + rng.range(0, 0.1);
      const off = rng.range(1.5, 2.2);
      push('trafficCone', { x: A.x + (B.x - A.x) * f + k0 * inX * off, z: A.z + (B.z - A.z) * f + k0 * inZ * off }, rng.range(0, Math.PI * 2));
    }
    // A sawhorse along the curb past the line's end.
    const C = P(lIn + sd * (FUNNEL.flare + 2.4), curbBack - 0.3);
    push('sawhorse', C, atan2(-g.rax, -g.raz) + rng.range(-0.15, 0.15));
    b.reserved.push({ x: C.x, z: C.z, r: 1.6 });
  }
  // Strings of bulbs: across the mouth between the flared walls' ends, across the curb line in front
  // (both on posts: values [0]), and across the lip opening (hung under the ceiling: values [1]).
  const mouth = [P(-(g.rhw + g.fl + t + 0.3), 0.6), P(g.rhw + g.fr + t + 0.3, 0.6)];
  b.hints.push({ kind: 'stringLights', points: mouth, values: [0] });
  b.hints.push({ kind: 'stringLights', points: ends, values: [0] });
  for (const q of [...mouth, ...ends]) b.reserved.push({ x: q.x, z: q.z, r: 0.8 });
  const W = (u: number, v: number) => toWorld(g, u, v);
  b.hints.push({ kind: 'stringLights', points: [W(frontU(g, -g.hc) + 0.3, -(g.hc - 0.25)), W(frontU(g, g.hc) + 0.3, g.hc - 0.25)], values: [1] });
}

/** The footprint grown by d (m) all round (out over the sidewalk too: a probe there must fall in). */
function footprint(g: CarParkGeo, d: number): Vec2[][] {
  return [insetRing(g.deck, -d) ?? g.deck];
}

/**
 * Give the face under each lip its height (Wall.top): the ground in front of
 * it plus the roof less LIP_DROP. Runs once the terrain exists (createCity);
 * until then the face is full height (top Infinity).
 */
export function settleCarParks(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  areas.forEach((a, i) => {
    if (a.kind !== 'carPark') return;
    const g = carParkGeo(a);
    const front = toWorld(g, -1.2, 0);
    const top = terrain.heightAt(front.x, front.z) + g.H - LIP_DROP;
    for (const w of builds[i].walls) if (w.top !== undefined) w.top = top;
  });
}

/**
 * World height with the car parks taken back out: the ground under their
 * decks and ramps (the renderer's coarse ground mesh, which would otherwise
 * bulge up around a roof and poke out over the sidewalks).
 */
export function groundHeight(world: { areas: readonly Area[]; heightAt(x: number, z: number): number }): (x: number, z: number) => number {
  const list = carParks(world.areas);
  if (!list.length) return world.heightAt;
  const s: HeightSample = { h: 0, gx: 0, gz: 0 };
  return (x, z) => {
    s.h = 0;
    for (const g of list) carParkLift(g, x, z, s);
    return world.heightAt(x, z) - s.h;
  };
}

/** Every car park of a city as geometry. */
export function carParks(areas: readonly Area[]): CarParkGeo[] {
  return areas.filter((a) => a.kind === 'carPark').map(carParkGeo);
}

/** Segment a-b touches a convex polygon (an end inside or a crossing). */
function segmentTouches(ax: number, az: number, bx: number, bz: number, poly: Vec2[]): boolean {
  if (pointInPolygon(ax, az, poly) || pointInPolygon(bx, bz, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const d1 = (bx - ax) * (p.z - az) - (bz - az) * (p.x - ax);
    const d2 = (bx - ax) * (q.z - az) - (bz - az) * (q.x - ax);
    const d3 = (q.x - p.x) * (az - p.z) - (q.z - p.z) * (ax - p.x);
    const d4 = (q.x - p.x) * (bz - p.z) - (q.z - p.z) * (bx - p.x);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/**
 * A route's corner rails with every piece the flight off one of its car
 * parks would cross taken out (the rail at C runs along the building line in
 * front of the lip); the rest of each rail stays, its ends at the gap.
 */
export function carParkRails<T extends Wall>(areas: readonly Area[], route: number, rails: T[]): T[] {
  const zones = carParks(areas)
    .filter((g) => g.owner === route)
    .map((g) => flightCorridor(g, g.lipBack + 14, CAR_HALF + CFG.flightClear));
  return railsClearOf(zones, rails);
}

/**
 * `rails` with every piece touching one of the `zones` (convex polygons, a
 * flight corridor) taken out; the rest of each rail stays, its ends at the
 * gap. Shared with the alleys' jump exits (districts/alleyDressing.ts).
 */
export function railsClearOf<T extends Wall>(zones: readonly Vec2[][], rails: T[]): T[] {
  if (!zones.length) return rails;
  const cut = new Set<string>();
  const key = (w: Wall & { piece?: number }) => `${w.group ?? -1}:${w.piece ?? -1}`;
  for (const w of rails) if (zones.some((z) => segmentTouches(w.ax, w.az, w.bx, w.bz, z))) cut.add(key(w));
  if (!cut.size) return rails;
  // A rail cut in two is two rails: the run after the gap gets a group of its own (ids past the last).
  let next = 0;
  for (const w of rails) next = Math.max(next, (w.group ?? -1) + 1);
  const out: T[] = [];
  let group = -1;
  let gap = false;
  let renamed = -1;
  for (const w of rails) {
    if (w.group !== group) {
      group = w.group ?? -1;
      gap = false;
      renamed = -1;
    }
    if (cut.has(key(w))) {
      gap = true;
      renamed = -1;
      continue;
    }
    if (gap && renamed < 0) renamed = next++;
    out.push(renamed < 0 ? w : { ...w, group: renamed });
  }
  return out;
}

/** Whether a point is within `pad` m of a flight off one of the route's car parks (over the junction, render dressing keeps out). */
export function nearCarParkFlight(world: { areas: readonly Area[]; openWorld?: boolean; route: { kind: RouteKind } }, x: number, z: number, pad: number): boolean {
  for (const g of carParks(world.areas)) {
    if (!world.openWorld && g.owner !== ROUTE_INDEX[world.route.kind]) continue;
    if (pointInPolygon(x, z, flightCorridor(g, g.lipBack + 14, pad))) return true;
  }
  return false;
}

/** Shutters across the ramps of the car parks that are not this route's shortcut (thin solids, look 'carPark'). */
export function carParkGates(areas: readonly Area[], route: number): Wall[] {
  const out: Wall[] = [];
  for (const g of carParks(areas)) {
    if (g.owner === route) continue;
    const a = g.apron1 - 0.4;
    out.push(...slab(rampPoint(g, a, -g.rhw - CFG.wall), rampPoint(g, a, g.rhw + CFG.wall), rampPoint(g, a + 2, 0), CFG.wall, g.area));
  }
  return out;
}

/** What race progress needs of a world (race.ts passes its World). */
interface ProgressWorld {
  areas: readonly Area[];
  openWorld?: boolean;
  route: Route;
}

/** A route's car park as race progress sees it. */
interface ParkTrack {
  /** The footprint: a car inside it is on the car park (the ramp climbs inside it); its bounds. */
  zones: Vec2[][];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** The racing line from the ramp's foot to the lip, with cumulative lengths (m). */
  path: Vec2[];
  cum: number[];
  /** Route position the foot maps onto, and the route distance from there to the lip's (m). */
  sIn: number;
  span: number;
}
const tracks = new WeakMap<object, ParkTrack[]>();

/** Nearest point of a polyline: segment index and parameter. */
function nearestOnPath(path: Vec2[], x: number, z: number): { i: number; t: number; d2: number } {
  let best = { i: 0, t: 0, d2: Infinity };
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const t = segmentT(x, z, a.x, a.z, b.x, b.z);
    const px = a.x + (b.x - a.x) * t;
    const pz = a.z + (b.z - a.z) * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best.d2) best = { i, t, d2 };
  }
  return best;
}

/** Route position (polyline m) nearest a point, over the whole route. */
function routeS(route: Route, x: number, z: number): number {
  const q = nearestOnPath(route.points, x, z);
  return route.cum[q.i] + q.t * (route.cum[q.i + 1] - route.cum[q.i]);
}

/** The route's own car parks (the others are shuttered), built once per route. */
function tracksFor(world: ProgressWorld): ParkTrack[] {
  // Hand built test worlds have no districts.
  if (!world.areas || !world.route) return [];
  let list = tracks.get(world.route);
  if (list) return list;
  const route = world.route;
  const ri = ROUTE_INDEX[route.kind];
  list = world.openWorld
    ? []
    : carParks(world.areas)
        .filter((g) => g.owner === ri)
        .map((g) => {
          const path = g.path;
          const cum = [0];
          for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + unit(path[i - 1], path[i]).len);
          const sIn = routeS(route, path[0].x, path[0].z);
          let span = routeS(route, path[path.length - 1].x, path[path.length - 1].z) - sIn;
          if (route.closed) span = ((span % route.length) + route.length) % route.length;
          return { zones: [g.deck], ...g.box, path, cum, sIn, span };
        });
  tracks.set(world.route, list);
  return list;
}

function trackAt(world: ProgressWorld, x: number, z: number): ParkTrack | null {
  for (const t of tracksFor(world)) {
    if (x < t.minX || x > t.maxX || z < t.minZ || z > t.maxZ) continue;
    if (t.zones.some((p) => pointInPolygon(x, z, p))) return t;
  }
  return null;
}

/** Whether a point is on one of the route's car parks (anywhere on its floor or ramp): race.ts does not count a car up there as lost. */
export function onCarPark(world: ProgressWorld, x: number, z: number): boolean {
  return trackAt(world, x, z) !== null;
}

/**
 * Race progress for a car on one of the route's car parks, or null off them.
 * Up on the ramp and the roof the nearest street can be any of the block's
 * (an earlier stretch of the route included), so the car is placed along the
 * car park's own racing line instead, mapped linearly onto the route stretch
 * from its entry to the lip's junction: progress runs on smoothly while it
 * climbs, turns and launches, the direction for the wrong way check is the
 * line's, and once it is in the air over the junction the plain projection
 * (World.routeProgress) takes over where this one ends.
 */
export function carParkProgress(world: ProgressWorld, x: number, z: number): RouteProgress | null {
  const t = trackAt(world, x, z);
  if (!t) return null;
  const route = world.route;
  const q = nearestOnPath(t.path, x, z);
  const a = t.path[q.i];
  const b = t.path[q.i + 1];
  const len = t.cum[q.i + 1] - t.cum[q.i] || 1;
  const tx = (b.x - a.x) / len;
  const tz = (b.z - a.z) / len;
  let s = t.sIn + ((t.cum[q.i] + q.t * len) / t.cum[t.cum.length - 1]) * t.span;
  if (route.closed) s = ((s % route.length) + route.length) % route.length;
  else s = Math.min(s, route.length);
  // Polyline segment holding s: the hint the plain projection resumes from.
  const lo = segmentAt(route.cum, s);
  const px = a.x + (b.x - a.x) * q.t;
  const pz = a.z + (b.z - a.z) * q.t;
  return { s, lateral: (x - px) * tz - (z - pz) * tx, seg: lo, tx, tz };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface Candidate {
  face: number;
  /** Streets it claims: the entry's, the one into C, every one at C and the landing straight's. */
  edges: number[];
  params: Record<string, number>;
  outline: Vec2[];
  path: Vec2[];
  footprint: number;
  /** Route distance saved to the scoring landing point (m). */
  score: number;
}

function unit(from: Vec2, to: Vec2): { x: number; z: number; len: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / len, z: dz / len, len };
}

/** Route node positions along the node polyline (m), its length and the span cuts may use (alleyShortcuts.ts routeBounds and its sprint guards). */
function routeFrame(g: RoadGraph, r: CarveRoute): { cum: number[]; total: number; lo: number; hi: number } {
  const n = r.nodes.length;
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + unit(g.nodes[r.nodes[i - 1]], g.nodes[r.nodes[i]]).len);
  const total = cum[n - 1] + (r.closed ? unit(g.nodes[r.nodes[n - 1]], g.nodes[r.nodes[0]]).len : 0);
  if (r.closed) return { cum, total, lo: 0, hi: total };
  let finish = total - ROUTE.sprintFinishOffset;
  for (let i = n - 2; i > 0; i--) if (Math.abs(finish - cum[i]) < ROUTE.sprintFinishNodeClear) finish = cum[i] - ROUTE.sprintFinishNodeClear;
  return { cum, total, lo: ROUTE.sprintStartOffset + 25, hi: Math.min(finish - ROUTE.sprintFinishNodeClear, total - ROUTE.sprintFinishOffset - ROUTE.sprintFinishNodeClear - 30) };
}

/** Signed turn (rad) at route index i (0 at a sprint's ends). */
function turnAt(g: RoadGraph, r: CarveRoute, i: number): number {
  const n = r.nodes.length;
  if (!r.closed && (i <= 0 || i >= n - 1)) return 0;
  const a = g.nodes[r.nodes[(i - 1 + n) % n]];
  const b = g.nodes[r.nodes[i]];
  const c = g.nodes[r.nodes[(i + 1) % n]];
  const d1x = b.x - a.x;
  const d1z = b.z - a.z;
  const d2x = c.x - b.x;
  const d2z = c.z - b.z;
  return atan2(d1x * d2z - d1z * d2x, d1x * d2x + d1z * d2z);
}

/** First crossing (distance along unit d from p, at most max) of a ray with a polygon's outline, or null. */
function rayHit(p: Vec2, d: Vec2, poly: Vec2[], max: number): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sx = b.x - a.x;
    const sz = b.z - a.z;
    const den = d.x * sz - d.z * sx;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - p.x) * sz - (a.z - p.z) * sx) / den;
    const s = ((a.x - p.x) * d.z - (a.z - p.z) * d.x) / den;
    if (t >= 0 && t <= max && s >= 0 && s <= 1 && (best === null || t < best)) best = t;
  }
  return best;
}

/** Ballistic reach (m from the lip) of a launch at v m/s off the roof over the kicker (its lip slope 2 kh / kl). */
export function flightReach(v: number): number {
  const a = atan2((2 * CFG.kickHeight) / CFG.kickLength, 1);
  const vy = v * sin(a);
  const vx = v * cos(a);
  const g = 9.81;
  return (vx * (vy + sqrt(vy * vy + 2 * g * (CFG.deckHeight + CFG.kickHeight)))) / g;
}

/** The drive's box on the deck as a world polygon: its back corners at v0 and v1, then the front from v1 round to v0. */
function driveBox(g: CarParkGeo): Vec2[] {
  const W = (u: number, v: number) => toWorld(g, u, v);
  return [W(g.u1, g.v0), W(g.u1, g.v1), ...g.front.map((f) => W(f.u, f.v)).reverse()];
}

/** Whether a point is inside a polygon or within `tol` of its outline. */
function inOrOn(p: Vec2, poly: Vec2[], tol: number): boolean {
  return pointInPolygon(p.x, p.z, poly) || distToPolygonEdge(p.x, p.z, poly) <= tol;
}

/**
 * The garage's footprint for a planned drive (its box and ramp) in a block:
 * the block's building line inset (`base`) when its area is within
 * CFG.blockArea. A bigger convex block is cut down to the range's top along
 * a line behind the drive (u = ub), and beside it if that is not enough; a
 * bigger concave block (an L: a cut could split it) gets none. Null when
 * nothing fits or the drive does not fit the result (a cut would take the
 * ramp's foot).
 */
function footprintFor(ring: Vec2[], base: Vec2[] | null, g: CarParkGeo): Vec2[] | null {
  if (!base) return null;
  const [minA, maxA] = CFG.blockArea;
  const W = (u: number, v: number) => toWorld(g, u, v);
  const must = [...driveBox(g), ...g.ramp];
  const holds = (poly: Vec2[]) => poly.length >= 3 && must.every((p) => inOrOn(p, poly, 0.3));
  const area = (poly: Vec2[]) => Math.abs(polygonArea(poly));
  const a = area(base);
  if (a < minA) return null;
  if (a <= maxA) return holds(base) ? base : null;
  if (!convexRing(ring)) return null;
  // What the floor has to reach round the drive, in the frame (a clearance that runs out past a building
  // line the drive stands on is harmless: the cut there takes nothing).
  let uNeed = -Infinity;
  let vLo = Infinity;
  let vHi = -Infinity;
  for (const p of must) {
    uNeed = Math.max(uNeed, toU(g, p) + CFG.clear);
    vLo = Math.min(vLo, toV(g, p) - CFG.clear);
    vHi = Math.max(vHi, toV(g, p) + CFG.clear);
  }
  // u <= ub keeps the drive's side of the cut: (b - a) x (p - a) along the v axis is -du; along u it is dv.
  const cutU = (poly: Vec2[], ub: number) => clipConvex(poly, W(ub, 0), W(ub, 1), 1);
  const cutV = (poly: Vec2[], dv: number) => {
    const vc = (vLo + vHi) / 2;
    return clipConvex(clipConvex(poly, W(0, vc - dv), W(1, vc - dv), 1), W(0, vc + dv), W(1, vc + dv), -1);
  };
  let uMax = -Infinity;
  for (const p of base) uMax = Math.max(uMax, toU(g, p));
  let poly: Vec2[];
  if (area(cutU(base, uNeed)) <= maxA) {
    // The furthest cut (bisection, to half a meter) that keeps the area under the top.
    let lo = uNeed;
    let hi = uMax;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (area(cutU(base, mid)) <= maxA) lo = mid;
      else hi = mid;
    }
    poly = cutU(base, lo);
  } else {
    poly = cutU(base, uNeed);
    let lo = (vHi - vLo) / 2;
    if (area(cutV(poly, lo)) > maxA) return null;
    let hi = 400;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (area(cutV(poly, mid)) <= maxA) lo = mid;
      else hi = mid;
    }
    poly = cutV(poly, lo);
  }
  return holds(poly) ? poly : null;
}

/**
 * Plan car parks for the routes (see the header): at most CFG.perRoute per
 * route, the biggest saving first. Runs at the very end of the topology hook,
 * after every graph edit (it claims a block face). Deterministic.
 */
export function planCarParks(ctx: PlanContext, routes: CarveRoute[]): void {
  if (!CFG.enabled) return;
  routes.forEach((_, ri) => {
    for (let k = 0; k < CFG.perRoute; k++) {
      const list = carParkCandidates(ctx, routes, ri);
      // Biggest saving first; ties keep route order (stable sort), so the pick is deterministic.
      list.sort((a, b) => b.score - a.score);
      const c = list.find((x) => ctx.budget.used + x.footprint <= ctx.budget.total);
      if (!c) return;
      c.params.seed = ctx.rng.int(1, 0x7ffffffe);
      // Its streets and junction now (markets, roadworks, tunnels and overpasses keep off them), its block
      // once the night market's graph edit is done (carParkModule.plan).
      ctx.addArea({ kind: 'carPark', variant: c.params.side === 0 ? 'back' : 'side', polygon: c.outline, path: c.path, nodes: [c.params.node], edges: c.edges, faces: [], params: c.params }, c.footprint);
    }
  });
}

/**
 * The best car park site of each route on the graph as it is now, as the
 * polygons the alley carver keeps out of (PlanContext.keepOut): the block it
 * stands in, the frontage and the street in front of its lip and driveway,
 * and the flight down E. Planned again for real once the alleys are carved.
 */
export function carParkSites(ctx: PlanContext, routes: CarveRoute[]): Vec2[][][] {
  if (!CFG.enabled) return [];
  const sites: Vec2[][][] = [];
  const faces = new Set<number>();
  routes.forEach((_, ri) => {
    const list = carParkCandidates(ctx, routes, ri);
    list.sort((a, b) => b.score - a.score);
    // The best layout in each of the route's best few blocks: an alley's mouth may still spoil one.
    let held = 0;
    for (const c of list) {
      if (held >= SITES_HELD || faces.has(c.face)) continue;
      held++;
      faces.add(c.face);
      const g = carParkGeo({ id: -1, kind: 'carPark', variant: '', polygon: [], path: [], nodes: [], edges: [], faces: [], params: c.params });
      const W = (u: number, v: number) => toWorld(g, u, v);
      const out = -(g.lipBack + 3);
      // The driveway: from the foot out across the entry street, its flare and a mouth's reach either side.
      const wide = g.rhw + Math.max(g.fl, g.fr) + 10;
      const across = { x: -g.raz, z: g.rax };
      const foot = rampPoint(g, 0, 0);
      const street = (k: number, l: number) => ({ x: foot.x - g.fnx * k + across.x * l, z: foot.z - g.fnz * k + across.z * l });
      sites.push([
        ...footprint(g, 6),
        [W(frontU(g, g.v0) + 2, g.v0 - 10), W(out, g.v0 - 10), W(out, g.v1 + 10), W(frontU(g, g.v1) + 2, g.v1 + 10)],
        [street(-3, -wide), street(14, -wide), street(14, wide), street(-3, wide)],
        flightCorridor(g, g.lipBack + g.landZone, 6),
      ]);
    }
  });
  return sites;
}

/** Every valid car park layout for route ri, scored (a dry run: nothing is claimed). */
export function carParkCandidates(ctx: PlanContext, routes: CarveRoute[], ri: number): Candidate[] {
  const g = ctx.graph;
  const r = routes[ri];
  const R = r.nodes;
  const n = R.length;
  const faces = ctx.faces();
  const { cum, total, lo, hi } = routeFrame(g, r);
  const out: Candidate[] = [];
  // The ground the car park will stand on (hills keep their slopes off car parks, see hills.ts).
  const ground = createTerrain(ctx.seed);
  /**
   * The shortest ramp length from `rl` up (to `Lmax`) whose climb, its own grade plus the ground's
   * rise along it, stays under maxClimb: steeper, a car's pitch sits at its clamp (car.ts) and the
   * front wheels leave the deck over the crest. Infinity when none does.
   */
  const climbable = (foot: Vec2, A: Vec2, apron1: number, rl: number, Lmax: number): number => {
    const c = CITY.curbHeight;
    const h0 = ground.heightAt(foot.x + A.x * apron1, foot.z + A.z * apron1);
    for (let L = rl; L <= Lmax + 1e-6; L += 4) {
      const rise = ground.heightAt(foot.x + A.x * (apron1 + L), foot.z + A.z * (apron1 + L)) - h0;
      if ((CFG.deckHeight - c) / (L - CFG.rampEase) + Math.max(0, rise / L) <= CFG.maxClimb) return L;
    }
    return Infinity;
  };
  // The circuit's start line and grid sit in the middle of its longest street (route.ts circuitStart:
  // a run of pieces through bend nodes, roadGraph.ts); none of that run hosts the chute or the entry.
  const startEdges = new Set<number>(r.closed ? circuitStart(g, R).run.edges : []);
  // The route's edges and their streets (runs): the entry street is a whole street back from C.
  const routeEdgeList: number[] = [];
  for (let i = 0; i + (r.closed ? 0 : 1) < n; i++) routeEdgeList.push(edgeBetween(g, R[i], R[(i + 1) % n]));
  const runs = routeRuns(g, R, routeEdgeList, r.closed);
  const runOf = new Int32Array(routeEdgeList.length).fill(-1);
  runs.forEach((run, ri) => run.edges.forEach((_, k) => (runOf[(run.from + k) % routeEdgeList.length] = ri)));
  // The route's alley shortcuts: a car park keeps its span clear of theirs.
  const pos = new Map<number, number>();
  R.forEach((id, i) => pos.set(id, cum[i]));
  const spans: [number, number][] = [];
  for (const e of g.edges) {
    if (!e.shortcut) continue;
    const a = pos.get(e.a);
    const b = pos.get(e.b);
    if (a !== undefined && b !== undefined) spans.push([Math.min(a, b), Math.max(a, b)]);
  }
  const blocked = ctx.areas.filter((a) => a.kind !== 'downtown' && a.kind !== 'hills');
  const okStreet = (eid: number) => {
    if (eid < 0) return false;
    const e = g.edges[eid];
    const claim = ctx.claims.edge.get(eid);
    return (e.kind === 'street' || e.kind === 'avenue' || e.kind === 'boulevard' || e.kind === 'diagonal') && !e.bridge && !e.shortcut && (claim === undefined || ctx.areas[claim].kind === 'hills');
  };
  for (let j = 0; j < n; j++) {
    if (!r.closed && (j < 2 || j > n - 2)) continue;
    const C = g.nodes[R[j]];
    if (C.ring || ctx.claims.node.has(C.id)) continue;
    const Q = g.nodes[R[(j + 1) % n]];
    const P = g.nodes[R[(j - 1 + n) % n]];
    const eE = edgeBetween(g, C.id, Q.id);
    const eIn = edgeBetween(g, P.id, C.id);
    if (!okStreet(eE) || !okStreet(eIn)) continue;
    const turn = turnAt(g, r, j);
    if (Math.abs(turn) < CFG.minTurnDeg * DEG || Math.abs(turn) > ROUTE.maxTurnDeg * DEG) continue;
    const t = unit(C, Q);
    let behind = false;
    for (const eid of C.edges) {
      const d = unit(C, g.nodes[otherNode(g.edges[eid], C.id)]);
      if (-(d.x * t.x + d.z * t.z) > cos(CFG.behindDeg * DEG)) behind = true;
    }
    if (behind) continue;
    // The landing straight: E and any straight continuation, up to the first junction or turn (its
    // corridor, where closures, crosswalks and rails start). E's own bend nodes are no such thing:
    // the street goes on through them a few degrees at a time, the landing with it.
    let run = 0;
    let end = Q;
    const runEdges: number[] = [];
    for (let k = 0; k < 6 * CITY.bendSegments; k++) {
      if (!r.closed && j + k + 1 > n - 1) break;
      const A = g.nodes[R[(j + k) % n]];
      const B = g.nodes[R[(j + k + 1) % n]];
      const d = unit(A, B);
      if (!isBendNode(g, A.id) && d.x * t.x + d.z * t.z < cos(3 * DEG)) break;
      run += d.len;
      end = B;
      runEdges.push(edgeBetween(g, A.id, B.id));
      if (B.edges.length > 2 || B.ring) break;
    }
    const endCorr = end.ring ? end.ring.outer + CITY.sidewalk : end.edges.reduce((m, eid) => Math.max(m, g.edges[eid].width / 2 + g.edges[eid].sidewalk), 0);
    const clearRun = run - endCorr - 4;
    // The face behind C and where the launch line meets its building line.
    const back = { x: -t.x, z: -t.z };
    const corrIn = g.edges[eIn].width / 2 + g.edges[eIn].sidewalk;
    const probe = { x: C.x + back.x * (corrIn + 3), z: C.z + back.z * (corrIn + 3) };
    const fi = faces.findIndex((f) => !f.outer && pointInPolygon(probe.x, probe.z, f.ring));
    // A block claimed, or held by a car park planned earlier in this hook (it claims its block later).
    if (fi < 0 || ctx.claims.face.has(fi) || ctx.areas.some((a) => a.kind === 'carPark' && a.params.face === fi)) continue;
    const F = faces[fi];
    const sLip = rayHit(C, back, F.ring, corrIn + 6);
    if (sLip === null) continue;
    const lipBack = sLip + CFG.inset;
    const frame: Frame = { ox: C.x + back.x * lipBack, oz: C.z + back.z * lipBack, ux: back.x, uz: back.z, vx: -back.z, vz: back.x };
    // The footprint's base: the block's building line inset (footprintFor); the deck's front is read
    // off it so the two agree exactly.
    const baseRing = insetRing(F.ring, CFG.inset);
    if (!baseRing) continue;
    /** The deck's front line (the base ring) at lateral v, as frame u, or null. */
    const frontAt = (v: number): number | null => {
      const hit = rayHit(toWorld(frame, -30, v), back, baseRing, 60);
      return hit === null ? null : hit - 30;
    };
    // Entry streets: the route's streets ENTRY_BACK[0] - 1 .. ENTRY_BACK[last] - 1 streets before the
    // one arriving at C, each of their pieces that fronts the block in turn.
    const inRun = runOf[(j - 1 + n) % n];
    const entries: { ia: number; ib: number }[] = [];
    for (const k of ENTRY_BACK) {
      const back = k - 1;
      if (inRun < 0 || (r.closed ? back >= runs.length : inRun - back < 0)) break;
      const run = runs[(inRun - back + runs.length) % runs.length];
      for (let q = 0; q < run.edges.length; q++) {
        const idx = (run.from + q) % routeEdgeList.length;
        entries.push({ ia: idx, ib: (idx + 1) % n });
      }
    }
    for (const { ia, ib } of entries) {
      const eY = edgeBetween(g, R[ia], R[ib]);
      if (eY === eIn || !F.edges.includes(eY) || !okStreet(eY)) continue;
      const Ya = g.nodes[R[ia]];
      const Yb = g.nodes[R[ib]];
      const dY = unit(Ya, Yb);
      // The entry street's building line on F (its longest straight ring segment along it).
      let seg: [Vec2, Vec2] | null = null;
      for (let i = 0; i < F.ring.length; i++) {
        if (F.segEdge[i] !== eY) continue;
        const a = F.ring[i];
        const b = F.ring[(i + 1) % F.ring.length];
        if (!seg || unit(a, b).len > unit(seg[0], seg[1]).len) seg = [a, b];
      }
      if (!seg) continue;
      const fl = unit(seg[0], seg[1]);
      // Inward normal: the block is on the right of the ring's travel.
      const N = { x: fl.z, z: -fl.x };
      const base = { x: seg[0].x + N.x * CFG.inset, z: seg[0].z + N.z * CFG.inset };
      const dotU = dY.x * frame.ux + dY.z * frame.uz;
      // Side entry when the entry street runs along the chute (within about 40 degrees, the warp
      // tilting streets, roadGraph.ts), back entry when it runs across it; layout checks the skew
      // the ramp can take (an >= 0.85) either way.
      const side = Math.abs(dotU) > 0.75 ? (toV(frame, seg[0]) > 0 ? 1 : -1) : Math.abs(dotU) < 0.6 ? 0 : NaN;
      if (Number.isNaN(side)) continue;
      // Entry clearance from each end of its street: a turning junction's corner rail runs along the
      // outside of the turn, so where the block is on the outside the entry keeps railClear from it.
      const clearAt = (idx: number, other: Vec2) => {
        // A bend node is no junction: the street (and the block's front) goes on past it.
        if (isBendNode(g, R[idx])) return 0;
        if (Math.abs(turnAt(g, r, idx)) < ROUTE.railMinTurnDeg * DEG) return CFG.entryNodeClear;
        const o = g.nodes[R[idx]];
        return (other.x - o.x) * N.x + (other.z - o.z) * N.z > 0 ? CFG.entryNodeClear : CFG.railClear;
      };
      const clearA = clearAt(ia, g.nodes[R[(ia - 1 + n) % n]]);
      const clearB = clearAt(ib, g.nodes[R[(ib + 1) % n]]);
      const feet: Vec2[] = [];
      const along = side !== 0 ? { x: frame.ux, z: frame.uz } : { x: frame.vx, z: frame.vz };
      const den = fl.x * along.x + fl.z * along.z;
      if (Math.abs(den) < 1e-6) continue;
      const mouth = CFG.chuteLength + CFG.chuteFunnel[0];
      const targets = side !== 0 ? [0, 4, -2, CFG.turnRadius[0] - CFG.turnRadius[1], 8, 12].map((du) => mouth + CFG.turnRadius[1] + du) : [0, 3, -3, 6, -6];
      for (const target of targets) {
        const s = (target - (side !== 0 ? toU(frame, base) : toV(frame, base))) / den;
        feet.push({ x: base.x + fl.x * s, z: base.z + fl.z * s });
      }
      const edgeRoom = CFG.rampWidth / 2 + APRON.flareIn + 2;
      for (const foot of feet) {
        const s = (foot.x - base.x) * fl.x + (foot.z - base.z) * fl.z;
        if (s < edgeRoom || s > fl.len - edgeRoom) continue;
        const at = (foot.x - Ya.x) * dY.x + (foot.z - Ya.z) * dY.z;
        if (at < clearA || at > dY.len - clearB) continue;
        const params = layout(side, foot, N);
        if (!params) continue;
        const cand = validate(params, cum[ia] + at);
        if (cand) out.push(cand);
      }

      /** Ramp, deck and chute for a ramp foot on the entry line; params, or null when the site has no room. */
      function layout(side: number, foot: Vec2, N: Vec2): Record<string, number> | null {
        const A = side !== 0 ? { x: -side * frame.vx, z: -side * frame.vz } : { x: -frame.ux, z: -frame.uz };
        const an = A.x * N.x + A.z * N.z;
        if (an < 0.85) {
          return null;
        }
        const rhw = CFG.rampWidth / 2;
        // The apron starts at the deepest point of the building line across its flared width.
        // The wide flare on the side racers come from: they arrive along the entry street (dY).
        const L = { x: -A.z, z: A.x };
        const inLeft = -(L.x * dY.x + L.z * dY.z) > 0;
        const fl = inLeft ? APRON.flareOut : APRON.flareIn;
        const fr = inLeft ? APRON.flareIn : APRON.flareOut;
        const lnS = L.x * N.x + L.z * N.z;
        const apron0 = Math.max(((rhw + fl) * lnS) / an, (-(rhw + fr) * lnS) / an);
        const apron1 = apron0 + APRON.depth;
        const c = CITY.curbHeight;
        const H = CFG.deckHeight;
        const Lmin = (H - c) / CFG.rampGrade[1] + CFG.rampEase;
        const Lmax = (H - c) / CFG.rampGrade[0] + CFG.rampEase;
        const hc = CFG.chuteWidth / 2;
        const wing = hc + CFG.wall + CFG.deckMargin;
        let rl: number;
        let u1: number;
        let v0: number;
        let v1: number;
        let turnR = 0;
        if (side !== 0) {
          // From the apron's end to E's line along the ramp; the deck edge stands rTarget out (or less).
          const reach = Math.abs(toV(frame, foot)) - apron1;
          rl = climbable(foot, A, apron1, Math.min(Lmax, Math.max(Lmin, reach - CFG.turnRadius[1])), Lmax);
          const vd = reach - rl;
          const ur = toU(frame, foot);
          turnR = Math.min(ur - CFG.chuteLength - CFG.chuteFunnel[0], vd);
          if (turnR < CFG.turnRadius[0] || vd < wing || vd > CFG.turnRadius[1] + 30) return null;
          u1 = ur + rhw;
          v0 = side > 0 ? -wing : -vd;
          v1 = side > 0 ? vd : wing;
        } else {
          const reach = toU(frame, foot) - apron1;
          const mouth = CFG.chuteLength + CFG.chuteFunnel[0];
          rl = climbable(foot, A, apron1, Math.min(Lmax, Math.max(Lmin, reach - mouth - CFG.deckRun[1])), Lmax);
          u1 = reach - rl;
          if (u1 - mouth < CFG.deckRun[0]) return null;
          const vr = toV(frame, foot);
          if (Math.abs(vr) > (u1 - mouth) * 0.35) return null;
          v0 = Math.min(vr - rhw - CFG.wall, -wing);
          v1 = Math.max(vr + rhw + CFG.wall, wing);
        }
        // The deck's front follows the building line: its ends, and the block's corner points between
        // them (a junction kinks it), must trace it within STRAIGHT_TOL.
        const f0 = frontAt(0);
        const fa = frontAt(v0);
        const fb = frontAt(v1);
        if (f0 === null || fa === null || fb === null || Math.abs(f0) > 0.05) {
          return null;
        }
        const front = [{ u: fa, v: v0 }];
        const corners = F.ring.map((q) => ({ u: toU(frame, q) + CFG.inset, v: toV(frame, q) })).filter((q) => q.v > v0 + 0.5 && q.v < v1 - 0.5 && Math.abs(q.u) < 10);
        corners.sort((a, b) => a.v - b.v);
        for (const q of corners) front.push(q);
        front.push({ u: fb, v: v1 });
        if (front.length > 6) {
          return null;
        }
        const geoF = { front };
        for (let v = v0; v <= v1; v += SAMPLE / 2) {
          const f = frontAt(v);
          if (f === null || Math.abs(f - frontU(geoF, v)) > STRAIGHT_TOL) {
            return null;
          }
        }
        if (Math.abs(frontU(geoF, -hc) - frontU(geoF, hc)) > 1.2) {
          return null;
        }
        if (u1 - Math.max(...front.map((f) => f.u)) < CFG.chuteLength + CFG.chuteFunnel[0] + 4) {
          return null;
        }
        const fp: Record<string, number> = { fn: front.length };
        front.forEach((f, i) => {
          fp[`fu${i}`] = f.u;
          fp[`fv${i}`] = f.v;
        });
        return {
          owner: ri,
          ox: frame.ox,
          oz: frame.oz,
          ux: frame.ux,
          uz: frame.uz,
          H,
          ...fp,
          u1,
          v0,
          v1,
          hc,
          lc: CFG.chuteLength,
          cf: CFG.chuteFunnel[0],
          cw: CFG.chuteFunnel[1],
          kl: CFG.kickLength,
          kh: CFG.kickHeight,
          rcx: foot.x,
          rcz: foot.z,
          rax: A.x,
          raz: A.z,
          rhw,
          fl,
          fr,
          apron0,
          apron1,
          rl,
          rend: apron1 + rl,
          fnx: N.x,
          fnz: N.z,
          side,
          turn: turnR,
          node: C.id,
          face: fi,
          landEdge: eE,
          entryEdge: eY,
          lipBack,
          landMax: 0,
          landZone: 0,
          seed: 0,
          fpn: 0,
        };
      }

      /** Check a layout against the block, the city and the route: a scored candidate, or null. */
      function validate(params: Record<string, number>, sEntry: number): Candidate | null {
        const geo = carParkGeo({ id: -1, kind: 'carPark', variant: '', polygon: [], path: [], nodes: [], edges: [], faces: [], params });
        // Fastest launch: turn limited for side entries (then the chute), a straight run-up for back ones.
        const runUp = geo.side !== 0 ? geo.lc + geo.cf : geo.u1 + geo.rl;
        const vIn = geo.side !== 0 ? sqrt(CFG.turnGrip * 9.81 * (geo.turn + CFG.turnSlack)) : CFG.entrySpeed;
        const climb = geo.side !== 0 ? 0 : 2 * 9.81 * geo.H;
        const vMax = sqrt(Math.max(0, vIn * vIn - climb + 2 * CFG.launchAccel * runUp));
        const landMax = flightReach(vMax);
        const zone = landMax - lipBack + CFG.rollout;
        if (zone > clearRun) {
          return null;
        }
        params.landMax = landMax;
        params.landZone = zone;
        // Inside the block: every outline sample of the drive (its box and the ramp) in F, clear of F's
        // other building lines (the box's front and the ramp's foot stand on theirs).
        const nearFront = (p: Vec2) => toU(geo, p) - frontU(geo, toV(geo, p)) < CFG.clear + 0.5;
        const nearFoot = (p: Vec2) => (p.x - geo.rcx) * geo.fnx + (p.z - geo.rcz) * geo.fnz < CFG.clear + 0.5;
        for (const poly of [driveBox(geo), geo.ramp]) {
          for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const steps = Math.max(1, Math.ceil(unit(a, b).len / SAMPLE));
            for (let s = 0; s <= steps; s++) {
              const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps };
              if (!pointInPolygon(p.x, p.z, F.ring)) return null;
              if (!nearFront(p) && !nearFoot(p) && distToPolygonEdge(p.x, p.z, F.ring) < CFG.clear) return null;
              for (const ar of blocked) {
                if (ar.polygon.length >= 3 && pointInPolygon(p.x, p.z, ar.polygon)) return null;
                if (ar.kind !== 'subway') continue;
                if (distToPath(ar.path, p.x, p.z) < CITY.districts.subway.deckWidth / 2 + 3) return null;
              }
            }
          }
          // The block's outline and other areas never cut into it.
          for (const q of F.ring) if (pointInPolygon(q.x, q.z, poly) && distToPolygonEdge(q.x, q.z, poly) > 0.3) return null;
          for (const ar of blocked) for (const q of ar.polygon) if (pointInPolygon(q.x, q.z, poly)) return null;
        }
        // The flight: closures across C's side streets stay out of the corridor (car half width and a margin).
        const corridor = flightCorridor(geo, lipBack + 25, CAR_HALF + CFG.flightClear);
        for (const eid of C.edges) {
          if (eid === eIn || eid === eE) continue;
          const X = g.edges[eid];
          const d = unit(C, g.nodes[otherNode(X, C.id)]);
          const m = g.edges[eE].width / 2 + g.edges[eE].sidewalk + ROUTE.barrierSetbackSide - 1;
          const hw = X.width / 2 + X.sidewalk;
          for (let s = -1; s <= 1; s += 0.1) {
            const p = { x: C.x + d.x * m - d.z * hw * s, z: C.z + d.z * m + d.x * hw * s };
            if (pointInPolygon(p.x, p.z, corridor)) return null;
          }
        }
        // The footprint: the block, or what the drive needs of it; nothing else planned stands in it.
        const fp = footprintFor(F.ring, baseRing, geo);
        if (!fp) return null;
        for (let i = 0; i < fp.length; i++) {
          const a = fp[i];
          const b = fp[(i + 1) % fp.length];
          const steps = Math.max(1, Math.ceil(unit(a, b).len / SAMPLE));
          for (let k = 0; k <= steps; k++) {
            const p = { x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps };
            for (const ar of blocked) if (ar.polygon.length >= 3 && pointInPolygon(p.x, p.z, ar.polygon)) return null;
          }
        }
        for (const ar of blocked) for (const q of ar.polygon) if (pointInPolygon(q.x, q.z, fp)) return null;
        params.fpn = fp.length;
        fp.forEach((p, i) => {
          params[`fpx${i}`] = p.x;
          params[`fpz${i}`] = p.z;
        });
        // Route positions: the entry, C and the far end of the landing zone.
        let sC = cum[j];
        if (r.closed && sC < sEntry) sC += total;
        const sOut = sC + zone;
        if (!r.closed && (sEntry < lo || sOut > hi)) return null;
        if (r.closed && (startEdges.has(eE) || startEdges.has(eY))) return null;
        // The car park against the route, both from the entry to SCORE_LAND m down E.
        const skip = sC + SCORE_LAND - sEntry;
        let path = lipBack + SCORE_LAND;
        for (let i = 1; i < geo.path.length; i++) path += unit(geo.path[i - 1], geo.path[i]).len;
        if (path > skip * (1 - CFG.minSave)) return null;
        const edges = [...new Set([eY, eIn, ...C.edges, ...runEdges])];
        return { face: fi, edges, params, outline: fp, path: geo.path, footprint: Math.abs(polygonArea(fp)), score: skip - path };
      }
    }
  }
  return out;
}
