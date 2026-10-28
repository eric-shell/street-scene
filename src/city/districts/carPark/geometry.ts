/**
 * The car park's geometry: CarParkGeo (the footprint, deck, ramp, chute and kicker laid out in the car park's
 * own frame, rebuilt from an area's params by carParkGeo), the frame's conversions to the world, and what
 * is read off it: the deck's front line, the ramp's points and flared width, the height modifier (carParkLift:
 * the ramp's eased profile, the deck, the kicker's parabola), the funnel's flare, the flight corridor and the
 * structure's outline. Pure functions of an area, shared by the planner, the walls, the floor, race progress
 * and the renderer.
 */
import { CITY } from '../../config';
import { Vec2, atan2, cos, sin, sqrt } from '../../../sim/math';
import { insetRing, pointInPolygon, polygonBounds } from '../geom';
import type { Area, HeightSample } from '../types';

const CFG = CITY.districts.carPark;
/** Half width (m) of the widest car: the launch heading bound and the flight corridor's margin. */
export const CAR_HALF = 0.95;
/**
 * The ramp's street end widens into a flared apron this deep (m): at the building line it is this
 * much wider on the side racers arrive from (they swing in from the lane), and on the other.
 */
export const APRON = { depth: 10, flareIn: 9, flareOut: 6 } as const;

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

export type Frame = Pick<CarParkGeo, 'ox' | 'oz' | 'ux' | 'uz' | 'vx' | 'vz'>;
export const toWorld = (g: Frame, u: number, v: number): Vec2 => ({ x: g.ox + g.ux * u + g.vx * v, z: g.oz + g.uz * u + g.vz * v });
export const toU = (g: Frame, p: Vec2) => (p.x - g.ox) * g.ux + (p.z - g.oz) * g.uz;
export const toV = (g: Frame, p: Vec2) => (p.x - g.ox) * g.vx + (p.z - g.oz) * g.vz;

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
  // Only between the lip and the kicker's foot: a floor reaching behind the lip (a slanted footprint
  // edge beside the exit lane) is flat deck, not the parabola carried on past its top.
  if (u >= 0 && u < g.kl && v >= -g.hc && v <= g.hc) {
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

/** The funnel's extra half width at its mouth on side s (sign of v, m): wider on the side a side entry's turn arrives from. */
export function funnelFlare(g: Pick<CarParkGeo, 'cw' | 'side'>, s: number): number {
  return g.cw + (g.side === s ? CFG.funnelArrive : 0);
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

/** The footprint grown by d (m) all round (out over the sidewalk too: a probe there must fall in). */
export function footprint(g: CarParkGeo, d: number): Vec2[][] {
  return [insetRing(g.deck, -d) ?? g.deck];
}

/** Every car park of a city as geometry. */
export function carParks(areas: readonly Area[]): CarParkGeo[] {
  return areas.filter((a) => a.kind === 'carPark').map(carParkGeo);
}

export function unit(from: Vec2, to: Vec2): { x: number; z: number; len: number } {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / len, z: dz / len, len };
}
