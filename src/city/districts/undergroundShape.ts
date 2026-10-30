/**
 * The Underground's geometry (districts/underground.ts, render/districts/underground.ts): the street-local
 * frame of the sunk run, the trench's height profile with its exact gradient, the demolished section's
 * rubble, the construction kicker, and the layout of everything along the run. Pure, and shared so the sim
 * and the renderer agree on where the floor, the walls and the ramps are.
 *
 * Frame: origin at the middle of the straight run, u along it from the first end node to the second, v across it
 * to the right of +u (structures.ts). `dir` is +1 when the circuit drives the run toward +u (-1 the other way)
 * and `s = dir * u` is the position along the travel; the layout is written in s so the kicker always comes
 * first and the window after it whichever way the race runs. `sd` (+-1) is the side of v the wall is demolished
 * on; the kicker throws toward the other side.
 *
 * Profile: the street drops to the floor `depth` under grade between the ramp feet (|u| <= top - run), rises to
 * grade at the ramp tops (|u| = top) with the quadratic lips of the channel's entrances at both ends, and across
 * the street the floor's edge (|v| = road, the curb line, the wall) climbs to grade inside the plinth over
 * `plinth` m. Under the demolished window that climb widens to the rubble's run, the taper blending back to the
 * plinth profile at the ends so the terrain stays continuous. The kicker's wedge adds on top of the floor.
 */
import { CITY } from '../config';
import type { Area, HeightSample } from './types';
import type { Frame } from './structures';
import { smooth01, type Smooth } from './geom';
import { Vec2 } from '../../sim/math';

const CFG = CITY.districts.underground;

/** The run as the area params describe it. */
export interface UndergroundShape extends Frame {
  /** Half length of the run, node to node (m). */
  half: number;
  /** The floor's half width: the street's curb line (m). */
  road: number;
  /** Ramp tops at |u| = top (m); the flat floor is |u| <= top - run. */
  top: number;
  /** +1 or -1: the direction the circuit drives the run in (u); the layout is in s = dir * u. */
  dir: number;
  /** Side (sign of v) the wall is demolished on. */
  sd: number;
}

export function undergroundShape(a: Area): UndergroundShape {
  const p = a.params;
  return { cx: p.cx, cz: p.cz, ux: p.ux, uz: p.uz, half: p.half, road: p.road, top: p.top, dir: p.dir, sd: p.sd };
}

/** Half length of the flat floor (m). */
export const floorHalf = (s: UndergroundShape): number => s.top - CFG.rampRun;

/** Where everything stands along the run: all positions in u (m), and v where it matters. */
export interface UndergroundLayout {
  /** The demolished window's centre (u), and its half length. */
  window: number;
  /** The kicker's lip (u, v), its heading in (u, v) (unit), the foot (u, v) and the length of its grade (m). */
  lip: Vec2;
  heading: Vec2;
  foot: Vec2;
  kickLength: number;
  /** The bus's centre (u) and its lane's v. */
  bus: Vec2;
  gantries: number[];
  bridges: number[];
}

export function undergroundLayout(s: UndergroundShape): UndergroundLayout {
  const K = CFG.kicker;
  const fh = floorHalf(s);
  const ease = 1 / (1 - K.ease / 2);
  const kickLength = (K.lip * ease) / K.grade;
  // The heading off the street's axis: the throw at K.aimSpeed lands in the middle of the far service road.
  const lipZ = s.road - K.lipInset;
  const vy = K.aimSpeed * K.grade;
  const fall = (vy + Math.sqrt(vy * vy + 2 * 9.81 * (K.lip - CFG.depth))) / 9.81;
  const across = s.road + CFG.plinth + CFG.service / 2 - lipZ;
  const th = Math.asin(Math.min(0.5, across / (K.aimSpeed * fall)));
  const hu = s.dir * Math.cos(th);
  const hv = -s.sd * Math.sin(th);
  // The foot (the far end of the grade) stays on the flat floor: slide the lip along the travel until it does.
  let sl = CFG.at.kicker;
  const reach = kickLength * Math.cos(th) + 1.5;
  if (sl - reach < -fh) sl = -fh + reach;
  const lip = { x: s.dir * sl, z: -s.sd * lipZ };
  const foot = { x: lip.x - hu * kickLength, z: lip.z - hv * kickLength };
  return {
    window: s.dir * CFG.at.window,
    lip,
    heading: { x: hu, z: hv },
    foot,
    kickLength,
    bus: { x: s.dir * CFG.at.bus, z: s.sd * (s.road - CFG.bus.width / 2 - CFG.bus.wallGap) },
    gantries: CFG.at.gantries.map((g) => s.dir * g),
    bridges: CFG.at.bridges.map((g) => s.dir * g),
  };
}

const SM: Smooth = { v: 0, d: 0 };
const SW: Smooth = { v: 0, d: 0 };
const SX: Smooth = { v: 0, d: 0 };

/** Ramp share of the depth at |u| = au (0 at the top, 1 on the floor) and its derivative in au, eased (quadratic) at both ends. */
function ramp(s: UndergroundShape, au: number, out: Smooth): Smooth {
  const q = (s.top - au) / CFG.rampRun;
  if (q <= 0) {
    out.v = 0;
    out.d = 0;
    return out;
  }
  if (q >= 1 - 1e-12) {
    out.v = 1;
    out.d = 0;
    return out;
  }
  const a = CFG.rampEase;
  const k = 1 / (1 - a);
  let v: number;
  let dv: number;
  if (q < a) {
    v = (k * q * q) / (2 * a);
    dv = (k * q) / a;
  } else if (q <= 1 - a) {
    v = k * (q - a / 2);
    dv = k;
  } else {
    const r = 1 - q;
    v = 1 - (k * r * r) / (2 * a);
    dv = (k * r) / a;
  }
  out.v = v;
  // q falls as au grows.
  out.d = -dv / CFG.rampRun;
  return out;
}

/** The trench's height (m, <= 0) and partial derivatives in (u, v) at (u, v). */
export interface ProfileSample {
  h: number;
  hu: number;
  hv: number;
}

/** Smoothstep (3x^2 - 2x^3) of x in [0, 1] and its derivative. */
const ss = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const dss = (x: number): number => (x <= 0 || x >= 1 ? 0 : 6 * x * (1 - x));

/** The demolished window's weight at u: 1 inside, 0 beyond the plinth's ends, the taper between. */
function windowWeight(u: number, centre: number, out: Smooth): Smooth {
  const D = CFG.demolished;
  const du = u - centre;
  smooth01(D.half - D.taper, D.half, Math.abs(du), SM);
  out.v = 1 - SM.v;
  out.d = -SM.d * (du < 0 ? -1 : 1);
  return out;
}

/** The plinth's width (m) at u on `side`: the plinth where it stands, widening to the rubble's run across the demolished window. */
export function plinthWidthAt(s: UndergroundShape, win: number, side: number, u: number): number {
  if (side !== s.sd) return CFG.plinth;
  return CFG.plinth + (CFG.demolished.run - CFG.plinth) * windowWeight(u, win, SX).v;
}

/** Height of the trench alone (no kicker) at local (u, v). Scratch-based: nothing allocates. */
export function trenchProfile(s: UndergroundShape, win: number, u: number, v: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hu = 0;
  out.hv = 0;
  const au = Math.abs(u);
  if (au >= s.top) return out;
  const r = ramp(s, au, SW);
  if (r.v <= 0) return out;
  const av = Math.abs(v);
  const F = s.road;
  let pe: number = CFG.plinth;
  let dpe = 0;
  if (v * s.sd > 0) {
    const w = windowWeight(u, win, SX);
    pe = CFG.plinth + (CFG.demolished.run - CFG.plinth) * w.v;
    dpe = (CFG.demolished.run - CFG.plinth) * w.d;
  }
  const x = (av - F) / pe;
  const t = 1 - ss(x);
  const dtdav = -dss(x) / pe;
  // d x / d pe = -(av - F) / pe^2.
  const dtdu = x > 0 && x < 1 ? dss(x) * ((av - F) / (pe * pe)) * dpe : 0;
  const D = CFG.depth;
  const rv = r.v;
  const dr = r.d * (u < 0 ? -1 : 1);
  out.h = -D * rv * t;
  out.hu = -D * (dr * t + rv * dtdu);
  out.hv = -D * rv * dtdav * (v < 0 ? -1 : 1);
  return out;
}

const KS: ProfileSample = { h: 0, hu: 0, hv: 0 };

/** The kicker's rise (m, >= 0) and partials in (u, v) at (u, v): an eased grade to the lip, then the drop behind it, over steel plates of width `width` bevelled at the edges. */
export function kickerProfile(lay: UndergroundLayout, u: number, v: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hu = 0;
  out.hv = 0;
  const K = CFG.kicker;
  const hx = lay.heading.x;
  const hz = lay.heading.z;
  const du = u - lay.foot.x;
  const dv = v - lay.foot.z;
  const a = du * hx + dv * hz;
  const b = -du * hz + dv * hx;
  const R = lay.kickLength;
  if (a <= 0 || a >= R + K.drop) return out;
  const ab = Math.abs(b);
  const half = K.width / 2;
  if (ab >= half + K.edge) return out;
  // Along: the eased grade (as the channel's table crest), then a smooth fall behind the lip.
  const e = K.ease;
  const k = 1 / (1 - e / 2);
  const w = a / R;
  let f: number;
  let df: number;
  if (a >= R) {
    const t = (a - R) / K.drop;
    f = 1 - ss(t);
    df = -dss(t) / K.drop;
  } else if (w < e) {
    f = (k * w * w) / (2 * e);
    df = (k * w) / (e * R);
  } else {
    f = k * (w - e / 2);
    df = k / R;
  }
  smooth01(half, half + K.edge, ab, SM);
  const g = 1 - SM.v;
  const dg = -SM.d * (b < 0 ? -1 : 1);
  out.h = K.lip * f * g;
  const dha = K.lip * df * g;
  const dhb = K.lip * f * dg;
  // a = du hx + dv hz and b = -du hz + dv hx: rotate the partials back into (u, v).
  out.hu = dha * hx - dhb * hz;
  out.hv = dha * hz + dhb * hx;
  return out;
}

/** Add the whole area's height (trench plus kicker) at (x, z) into `out`, the gradient exact. */
export function undergroundHeight(s: UndergroundShape, lay: UndergroundLayout, x: number, z: number, out: HeightSample): void {
  const dx = x - s.cx;
  const dz = z - s.cz;
  const u = dx * s.ux + dz * s.uz;
  const v = -dx * s.uz + dz * s.ux;
  const t = trenchProfile(s, lay.window, u, v, KS0);
  let h = t.h;
  let hu = t.hu;
  let hv = t.hv;
  if (t.h !== 0 || Math.abs(u) < s.top) {
    const k = kickerProfile(lay, u, v, KS);
    h += k.h;
    hu += k.hu;
    hv += k.hv;
  }
  out.h += h;
  out.gx += hu * s.ux - hv * s.uz;
  out.gz += hu * s.uz + hv * s.ux;
}
const KS0: ProfileSample = { h: 0, hu: 0, hv: 0 };

/** The trench's bounding box (world), for the height modifier. */
export function undergroundBox(s: UndergroundShape): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const hv = s.road + CFG.demolished.run + 0.5;
  const pts = [
    [-s.top, -hv],
    [s.top, -hv],
    [s.top, hv],
    [-s.top, hv],
  ];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [u, v] of pts) {
    const x = s.cx + s.ux * u - s.uz * v;
    const z = s.cz + s.uz * u + s.ux * v;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

/** Where a car leaves the kicker's lip at `speed` (m/s) heading along the kicker, and where it comes back down to grade (u, v) and after how long (s): ballistic, no drag. The lip is `lip` over the floor, the floor `depth` under grade (so the lip is `y0` under grade). */
export function kickerFlight(lay: UndergroundLayout, speed: number, gravity = 9.81): { land: Vec2; time: number; apex: number } {
  const K = CFG.kicker;
  const vy = speed * K.grade;
  const y0 = K.lip - CFG.depth;
  const time = (vy + Math.sqrt(vy * vy + 2 * gravity * y0)) / gravity;
  return { land: { x: lay.lip.x + lay.heading.x * speed * time, z: lay.lip.z + lay.heading.z * speed * time }, time, apex: y0 + (vy * vy) / (2 * gravity) };
}
