/**
 * The Underground's geometry (districts/underground.ts, render/districts/underground.ts): the site's frame, where
 * every piece stands along the trench, the height profile with its exact gradient, the plaza's and the bridges'
 * decks, and the kickers' throws. Pure, and shared so the sim and the renderer agree on where the floor, the walls,
 * the decks and the ramps are.
 *
 * Frame: the area params hold the spine's chord as a structures.ts Frame (origin mid-run, u from the entry to the
 * exit, v right of +u) and `dir`, the race's direction along it. Everything here is written in the travel frame
 * (s, w) = (dir u, dir v): s runs the way the race drives, w to the right of travel, so the kickers, the windows and the
 * gallery come in the same order and on the same side whichever way the race runs (a half turn of the frame, never a
 * mirror). toWorld / toTravel convert.
 *
 * Along the travel, mirrored about the middle: a ramp (`rampRun`, eased) down from grade at |s| = top to the floor
 * `depth` under grade; the open floor (the bridge, a side kicker, the burst main on one side; the bridge, the other
 * kicker, the bus on the other); the roof over |s| <= R (a third of the trench), the works plaza at grade on it with
 * the plaza kicker under its first opening and the drop opening after it, the utility gallery under its right side.
 * The demolished windows are on the right, on the lower half of each ramp.
 *
 * Across, from the axis: the floor to |w| = F (the spine's half width), the plinth to F + P (a solid: its floor face
 * is the retaining wall; the climb from the floor to grade happens under it), the service road (7 m at grade), the
 * verge (3 m), the hoarding. Under the roof on the right the wall is 3 m thick and the gallery's floor lies beyond it,
 * `drop` below the trench floor in its middle, its outer wall at `outer`; two cross passages cut the wall at a skew.
 *
 * Profile: h = min(trench, gallery, passages) + kickers + bridge humps. The trench and the gallery never overlap (the
 * trench's climb ends at F + P, the gallery's starts there); the passages meet the trench floor and the gallery floor
 * at their own level, so the min is continuous and its kinks lie under the walls. Each term fades to 0 inside the box.
 */
import { CITY } from '../config';
import type { Area, HeightSample } from './types';
import type { Frame } from './structures';
import { smooth01, type Smooth } from './geom';
import type { Terrain } from '../terrain';
import { atan2, cos, sin, sqrt, tan, type Vec2 } from '../../sim/math';

const CFG = CITY.districts.underground;
const GRAVITY = 9.81;

/** The floor's half width (m): the spine's curb line, where the retaining walls stand. */
export const F = CFG.floor / 2;
/** The plinth's outer edge (m from the axis): the service road's inner edge. */
export const P_OUT = F + CFG.plinth;
/** The service road's outer edge and the verge's (m from the axis): the hoarding stands on the verge's. */
export const ROAD_OUT = P_OUT + CFG.service;
export const VERGE_OUT = ROAD_OUT + CFG.verge;
/** Mid service road (m from the axis). */
export const ROAD_MID = P_OUT + CFG.service / 2;
/** The roof's deck reaches this far right of the axis (the gallery's outer wall) and left (the left plinth). */
export const DECK_RIGHT = CFG.gallery.outer + CFG.gallery.wall;

/** A rectangle in the travel frame (m). */
export interface Rect {
  s0: number;
  s1: number;
  w0: number;
  w1: number;
}

/** A kicker: steel plates on a spoil heap, in the travel frame. */
export interface Kicker {
  id: 'plaza' | 'right' | 'left';
  /** The lip's centre, the foot (the far end of the grade) and the unit heading (all travel frame). */
  lipS: number;
  lipW: number;
  footS: number;
  footW: number;
  hs: number;
  hw: number;
  /** Length of the grade (m). */
  length: number;
  /** The side of the floor it stands on (+1 right, -1 left). */
  side: number;
}

/** A Bailey bridge over the open trench, from one service road to the other. */
export interface Bridge {
  /** Where its axis crosses the trench's (travel s, m). */
  s: number;
  /** Unit axis in the travel frame, heading on along the travel: from the left road to the right (`sign` 1) or back (-1). */
  as: number;
  aw: number;
  sign: number;
}

/** A roof opening: its rectangle and which end has no hoarding (-1 the near end, +1 the far end along the travel). */
export interface Opening extends Rect {
  id: 'kicker' | 'drop';
  open: number;
}

/** A cross passage from the trench floor through the wall into the gallery: a straight corridor from p to q (travel frame). */
export interface Passage {
  ps: number;
  pw: number;
  qs: number;
  qw: number;
  /** Unit direction p -> q and the length (m). */
  ds: number;
  dw: number;
  len: number;
}

/** The utility gallery under the right side of the roof (travel frame). */
export interface Gallery {
  /** The end walls' inner faces (s). */
  s0: number;
  s1: number;
  /** Where its floor starts down from the trench floor's level and where it is back up (s), each ramp CFG.gallery.ramp long. */
  down: number;
  up: number;
  passages: [Passage, Passage];
}

/** The whole site: frame, sections and every placed piece (all along-travel positions in s, m). */
export interface UgSite extends Frame {
  /** +1 when the race drives the spine from the entry to the exit, -1 the other way. */
  dir: number;
  /** Half the spine's chord (m), the ramp tops (|s| = top), the flat floor's half length and the roof's. */
  half: number;
  top: number;
  fh: number;
  R: number;
  /** The demolished windows' centres (s), on the right. */
  windows: number[];
  kickers: Kicker[];
  bridges: Bridge[];
  openings: Opening[];
  gallery: Gallery;
  /** The bus's centre (travel frame). */
  bus: { s: number; w: number };
  /** The burst main's wet stretch on the floor, the mud at the spoil heap on the left road, the heap, and the gallery's wet patch. */
  burst: Rect;
  mud: Rect;
  heap: Rect;
  wet: Rect;
  /** The roof's slab, in rectangles round the openings (the plaza deck; the gallery's roof is its right part). */
  decks: Rect[];
}

/** The site from a planned area's params (underground.ts planArea). */
export function undergroundSite(a: Area): UgSite {
  const p = a.params;
  const top = p.top;
  const dir = p.dir;
  const fh = top - CFG.rampRun;
  const R = p.roof;
  const K = CFG.kicker;
  const kl = (K.lip / (1 - K.ease / 2)) / K.grade;
  // Side kickers: turned toward their side so the throw at aimSpeed lands mid service road.
  const fall = flightTime(K.aimSpeed);
  const sth = Math.min(0.5, (ROAD_MID - K.lipAt) / (K.aimSpeed * fall));
  const th = atan2(sth, sqrt(1 - sth * sth));
  const sideKicker = (id: 'right' | 'left', side: number, lipS: number): Kicker => {
    const hs = cos(th);
    const hw = side * sin(th);
    const lipW = side * K.lipAt;
    return { id, lipS, lipW, footS: lipS - hs * kl, footW: lipW - hw * kl, hs, hw, length: kl, side };
  };
  const B = CFG.bridge;
  const alpha = ((90 - B.skewDeg) * Math.PI) / 180;
  const bridgeA: Bridge = { s: -fh + B.at, as: cos(alpha), aw: sin(alpha), sign: 1 };
  const bridgeB: Bridge = { s: R + B.at, as: cos(alpha), aw: -sin(alpha), sign: -1 };
  const reach = bridgeReach();
  const plaza: Kicker = { id: 'plaza', lipS: -R + K.at, lipW: -K.lipAt, footS: -R + K.at - kl, footW: -K.lipAt, hs: 1, hw: 0, length: kl, side: -1 };
  const O = CFG.openings;
  const openings: Opening[] = [
    { id: 'kicker', s0: -R + O.kicker[0], s1: -R + O.kicker[0] + O.kicker[1], w0: -O.outer, w1: -O.inner, open: 1 },
    { id: 'drop', s0: -R + O.drop[0], s1: -R + O.drop[0] + O.drop[1], w0: O.inner, w1: O.outer, open: -1 },
  ];
  const G = CFG.gallery;
  const ang = (G.passageDeg * Math.PI) / 180;
  const across = (G.inner + G.outer) / 2 - G.passageFrom;
  const plen = across / sin(ang);
  const ps1 = -R + 12;
  const p1: Passage = { ps: ps1, pw: G.passageFrom, qs: ps1 + plen * cos(ang), qw: G.passageFrom + across, ds: cos(ang), dw: sin(ang), len: plen };
  const p2: Passage = { ps: -p1.qs, pw: p1.qw, qs: -p1.ps, qw: G.passageFrom, ds: cos(ang), dw: -sin(ang), len: plen };
  // The gallery's end wall stands just before the first passage's near side meets the gallery floor's edge (mirrored at the far end).
  const hp = G.passageHalf + 1;
  const aIn = (G.inner - p1.pw - hp * p1.ds) / p1.dw;
  const g0 = p1.ps + aIn * p1.ds - hp * p1.dw - 1;
  const D = CFG.demolished;
  const busS = fh - CFG.bus.before - CFG.bus.length / 2;
  const burst1 = -R - CFG.burst.before;
  const mudS = -fh + B.at + reach + 14;
  const H = CFG.mud.heap;
  const site: UgSite = {
    cx: p.cx,
    cz: p.cz,
    ux: p.ux,
    uz: p.uz,
    dir,
    half: p.half,
    top,
    fh,
    R,
    windows: [-fh - D.before - D.half, fh + D.before + D.half],
    kickers: [sideKicker('right', 1, bridgeA.s + reach + K.after), plaza, sideKicker('left', -1, bridgeB.s + reach + K.after)],
    bridges: [bridgeA, bridgeB],
    openings,
    gallery: { s0: g0, s1: -g0, down: p1.qs + 3, up: p2.ps - 3 - G.ramp, passages: [p1, p2] },
    bus: { s: busS, w: F - CFG.bus.wallGap - CFG.bus.width / 2 },
    burst: { s0: burst1 - CFG.burst.length, s1: burst1, w0: -F, w1: F },
    mud: { s0: mudS, s1: mudS + CFG.mud.length, w0: -ROAD_OUT, w1: -P_OUT - 1 },
    heap: { s0: mudS + (CFG.mud.length - H[0]) / 2, s1: mudS + (CFG.mud.length + H[0]) / 2, w0: -ROAD_OUT - H[1], w1: -ROAD_OUT },
    wet: { s0: -CFG.wet / 2, s1: CFG.wet / 2, w0: G.inner + 0.5, w1: G.outer - 0.8 },
    decks: [],
  };
  site.decks = deckRects(site);
  return site;
}

/** How far along the travel (m) a bridge's footprint reaches either side of its centre, humps included. */
export function bridgeReach(): number {
  const B = CFG.bridge;
  const alpha = ((90 - B.skewDeg) * Math.PI) / 180;
  const wEnd = P_OUT + B.hump;
  return wEnd / tan(alpha) + (B.half + 0.3) / sin(alpha);
}

/** The roof's slab: s in [-R, R], w from the left plinth's outer edge to the gallery's outer wall, less the openings. */
function deckRects(site: UgSite): Rect[] {
  const cuts = [-site.R, site.R];
  for (const o of site.openings) cuts.push(o.s0, o.s1);
  cuts.sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const s0 = cuts[i];
    const s1 = cuts[i + 1];
    if (s1 - s0 < 1e-6) continue;
    const mid = (s0 + s1) / 2;
    let w = -P_OUT;
    const holes = site.openings.filter((o) => mid > o.s0 && mid < o.s1).sort((a, b) => a.w0 - b.w0);
    for (const o of holes) {
      if (o.w0 > w) out.push({ s0, s1, w0: w, w1: o.w0 });
      w = o.w1;
    }
    out.push({ s0, s1, w0: w, w1: DECK_RIGHT });
  }
  return out;
}

/** World point of a travel-frame point. */
export function toWorld(site: UgSite, s: number, w: number): Vec2 {
  const u = site.dir * s;
  const v = site.dir * w;
  return { x: site.cx + site.ux * u - site.uz * v, z: site.cz + site.uz * u + site.ux * v };
}

/** Travel-frame point of a world point. */
export function toTravel(site: UgSite, x: number, z: number): { s: number; w: number } {
  const dx = x - site.cx;
  const dz = z - site.cz;
  return { s: site.dir * (dx * site.ux + dz * site.uz), w: site.dir * (-dx * site.uz + dz * site.ux) };
}

/** A travel-frame direction as a world unit vector. */
export function worldDir(site: UgSite, ds: number, dw: number): Vec2 {
  const u = site.dir * ds;
  const v = site.dir * dw;
  return { x: site.ux * u - site.uz * v, z: site.uz * u + site.ux * v };
}

/** A travel-frame rectangle as a world polygon. */
export function rectWorld(site: UgSite, r: Rect): Vec2[] {
  return [toWorld(site, r.s0, r.w0), toWorld(site, r.s1, r.w0), toWorld(site, r.s1, r.w1), toWorld(site, r.s0, r.w1)];
}

/** The flight time (s) of a kicker throw at `speed` (m/s) from its lip back down to grade. */
export function flightTime(speed: number): number {
  const K = CFG.kicker;
  const vy = speed * K.grade;
  return (vy + sqrt(vy * vy + 2 * GRAVITY * (K.lip - CFG.depth))) / GRAVITY;
}

/** Where a throw off kicker `k` at `speed` (m/s) comes back down to grade (travel frame), after how long (s), and its apex over grade (m). Ballistic, no drag. */
export function kickerFlight(k: Kicker, speed: number): { s: number; w: number; time: number; apex: number } {
  const K = CFG.kicker;
  const vy = speed * K.grade;
  const time = flightTime(speed);
  return { s: k.lipS + k.hs * speed * time, w: k.lipW + k.hw * speed * time, time, apex: K.lip - CFG.depth + (vy * vy) / (2 * GRAVITY) };
}

/** Height over grade (m) of a throw off a kicker `d` m (horizontal) past its lip at `speed`. */
export function flightHeight(speed: number, d: number): number {
  const K = CFG.kicker;
  const t = d / speed;
  return K.lip - CFG.depth + speed * K.grade * t - 0.5 * GRAVITY * t * t;
}

// ---------------------------------------------------------------------------
// The profile

/** Height (m) and its partials in the travel frame. */
export interface ProfileSample {
  h: number;
  hs: number;
  hw: number;
}

/** Smoothstep (3x^2 - 2x^3) of x in [0, 1] and its derivative. */
const ss = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const dss = (x: number): number => (x <= 0 || x >= 1 ? 0 : 6 * x * (1 - x));

const SA: Smooth = { v: 0, d: 0 };
const SB: Smooth = { v: 0, d: 0 };

/** Ramp share of the depth at |s| = as (0 at the top, 1 on the floor) and its derivative in as, eased (quadratic) at both ends. */
function ramp(site: UgSite, as: number, out: Smooth): Smooth {
  const q = (site.top - as) / CFG.rampRun;
  if (q <= 0) {
    out.v = 0;
    out.d = 0;
    return out;
  }
  if (q >= 1) {
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
  // q falls as |s| grows.
  out.d = -dv / CFG.rampRun;
  return out;
}

/** The trench's depth share at |s| (0 at the ramp tops, 1 on the floor): the renderer and the tests read it. */
export function rampShare(site: UgSite, s: number): number {
  return ramp(site, Math.abs(s), SA).v;
}

/** The demolished windows' weight at s (1 inside a window, 0 beyond its taper) and its derivative. */
function windowWeight(site: UgSite, s: number, out: Smooth): Smooth {
  const D = CFG.demolished;
  out.v = 0;
  out.d = 0;
  for (const c of site.windows) {
    const ds = s - c;
    if (Math.abs(ds) >= D.half) continue;
    smooth01(D.half - D.taper, D.half, Math.abs(ds), SB);
    out.v = 1 - SB.v;
    out.d = -SB.d * (ds < 0 ? -1 : 1);
  }
  return out;
}

/** The climb's width from the floor's edge to grade on side `side` at s (m): under the plinth, widening to the rubble across a window. */
export function climbWidth(site: UgSite, side: number, s: number): number {
  if (side < 0) return CFG.climb;
  return CFG.climb + (CFG.demolished.run - CFG.climb) * windowWeight(site, s, SA).v;
}

/** The trench alone (ramps, floor, the climb under the plinth, the rubble under the windows). */
function trench(site: UgSite, s: number, w: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hs = 0;
  out.hw = 0;
  const as = Math.abs(s);
  if (as >= site.top) return out;
  const aw = Math.abs(w);
  if (aw >= F + CFG.demolished.run) return out;
  const r = ramp(site, as, SA);
  if (r.v <= 0) return out;
  let pe: number = CFG.climb;
  let dpe = 0;
  if (w > 0) {
    const ww = windowWeight(site, s, SB);
    pe = CFG.climb + (CFG.demolished.run - CFG.climb) * ww.v;
    dpe = (CFG.demolished.run - CFG.climb) * ww.d;
  }
  const x = (aw - F) / pe;
  if (x >= 1) return out;
  const t = 1 - ss(x);
  const dtdaw = -dss(x) / pe;
  // d x / d pe = -(aw - F) / pe^2.
  const dtds = x > 0 ? dss(x) * ((aw - F) / (pe * pe)) * dpe : 0;
  const D = CFG.depth;
  const dr = r.d * (s < 0 ? -1 : 1);
  out.h = -D * r.v * t;
  out.hs = -D * (dr * t + r.v * dtds);
  out.hw = -D * r.v * dtdaw * (w < 0 ? -1 : 1);
  return out;
}

const GS: Smooth = { v: 0, d: 0 };
const GW: Smooth = { v: 0, d: 0 };

/** The gallery: a box under the right side of the roof, its floor ramping `drop` below the trench floor and back. */
function gallery(site: UgSite, s: number, w: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hs = 0;
  out.hw = 0;
  const G = CFG.gallery;
  const g = site.gallery;
  const wo = G.outer + G.wall / 2;
  if (w <= G.inner - G.fall || w >= wo || s <= g.s0 - G.wall || s >= g.s1 + G.wall) return out;
  // Across: down the inner wall's foot to the floor at `inner`, back up the outer wall's near half.
  smooth01(G.inner - G.fall, G.inner, w, GW);
  let cw = GW.v;
  let dcw = GW.d;
  smooth01(G.outer, wo, w, GW);
  dcw = dcw * (1 - GW.v) - cw * GW.d;
  cw *= 1 - GW.v;
  // Along: the end walls.
  smooth01(g.s0 - G.wall, g.s0, s, GS);
  let cs = GS.v;
  let dcs = GS.d;
  smooth01(g.s1, g.s1 + G.wall, s, GS);
  dcs = dcs * (1 - GS.v) - cs * GS.d;
  cs *= 1 - GS.v;
  // The floor's depth: the trench floor's, then `drop` more down the first ramp, back up the second.
  const a = (s - g.down) / G.ramp;
  const b = (s - g.up) / G.ramp;
  const dg = ss(a) * (1 - ss(b));
  const ddg = (dss(a) * (1 - ss(b)) - ss(a) * dss(b)) / G.ramp;
  const depth = CFG.depth + G.drop * dg;
  out.h = -depth * cw * cs;
  out.hs = -(G.drop * ddg * cw * cs + depth * cw * dcs);
  out.hw = -depth * dcw * cs;
  return out;
}

const PC: Smooth = { v: 0, d: 0 };
const PE: Smooth = { v: 0, d: 0 };

/** A cross passage: a flat corridor at the trench floor's level from the floor through the wall into the gallery. */
function passage(ps: Passage, s: number, w: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hs = 0;
  out.hw = 0;
  const hp = CFG.gallery.passageHalf;
  const rs = s - ps.ps;
  const rw = w - ps.pw;
  const a = rs * ps.ds + rw * ps.dw;
  const q = -rs * ps.dw + rw * ps.ds;
  const aq = Math.abs(q);
  if (a <= -2 || a >= ps.len + 2 || aq >= hp + 1) return out;
  smooth01(hp, hp + 1, aq, PC);
  const c = 1 - PC.v;
  const dc = -PC.d * (q < 0 ? -1 : 1);
  smooth01(-2, 0, a, PE);
  let e = PE.v;
  let de = PE.d;
  smooth01(ps.len, ps.len + 2, a, PE);
  de = de * (1 - PE.v) - e * PE.d;
  e *= 1 - PE.v;
  const D = CFG.depth;
  out.h = -D * c * e;
  const dha = -D * c * de;
  const dhq = -D * dc * e;
  // a = rs ds + rw dw, q = -rs dw + rw ds.
  out.hs = dha * ps.ds - dhq * ps.dw;
  out.hw = dha * ps.dw + dhq * ps.ds;
  return out;
}

/** A kicker's rise (m, >= 0) and partials: an eased grade to the lip, then the fall behind it, bevelled either side. */
function kicker(k: Kicker, s: number, w: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hs = 0;
  out.hw = 0;
  const K = CFG.kicker;
  const ds = s - k.footS;
  const dw = w - k.footW;
  const a = ds * k.hs + dw * k.hw;
  const b = -ds * k.hw + dw * k.hs;
  const L = k.length;
  if (a <= 0 || a >= L + K.drop) return out;
  const ab = Math.abs(b);
  const half = K.width / 2;
  if (ab >= half + K.edge) return out;
  const e = K.ease;
  const kk = 1 / (1 - e / 2);
  const t = a / L;
  let f: number;
  let df: number;
  if (a >= L) {
    const u = (a - L) / K.drop;
    f = 1 - ss(u);
    df = -dss(u) / K.drop;
  } else if (t < e) {
    f = (kk * t * t) / (2 * e);
    df = (kk * t) / (e * L);
  } else {
    f = kk * (t - e / 2);
    df = kk / L;
  }
  smooth01(half, half + K.edge, ab, SA);
  const g = 1 - SA.v;
  const dg = -SA.d * (b < 0 ? -1 : 1);
  out.h = K.lip * f * g;
  const dha = K.lip * df * g;
  const dhb = K.lip * f * dg;
  out.hs = dha * k.hs - dhb * k.hw;
  out.hw = dha * k.hw + dhb * k.hs;
  return out;
}

const HU: Smooth = { v: 0, d: 0 };
const HL: Smooth = { v: 0, d: 0 };

/**
 * A bridge's rise where it meets each service road: up from grade to the deck's `rise` over `hump` m of the road toward
 * the plinth, level under the plinth's back to the deck's edge, fading in over the trench's climb (under the solid), and
 * tapering off over a metre past the parapets' line. The deck itself is a DeckSpan at the same rise.
 */
function hump(br: Bridge, s: number, w: number, out: ProfileSample): ProfileSample {
  out.h = 0;
  out.hs = 0;
  out.hw = 0;
  const B = CFG.bridge;
  const aw = Math.abs(w);
  const lo = F + 0.2;
  if (aw <= lo || aw >= P_OUT + B.hump) return out;
  // Lateral distance off the bridge's axis (q, along its normal).
  const rs = s - br.s;
  const q = -rs * br.aw + w * br.as;
  const aq = Math.abs(q);
  const lat0 = B.half + 0.3;
  if (aq >= lat0 + 1) return out;
  smooth01(lat0, lat0 + 1, aq, HL);
  const l = 1 - HL.v;
  const dl = -HL.d * (q < 0 ? -1 : 1);
  let u: number;
  let du: number;
  if (aw < P_OUT) {
    smooth01(lo, F + CFG.climb, aw, HU);
    u = HU.v;
    du = HU.d;
  } else {
    const x = (aw - P_OUT) / B.hump;
    u = 1 - ss(x);
    du = -dss(x) / B.hump;
  }
  const sg = w < 0 ? -1 : 1;
  out.h = B.rise * u * l;
  // q = -rs aw + w as.
  out.hs = B.rise * u * dl * -br.aw;
  out.hw = B.rise * (du * sg * l + u * dl * br.as);
  return out;
}

const T0: ProfileSample = { h: 0, hs: 0, hw: 0 };
const T1: ProfileSample = { h: 0, hs: 0, hw: 0 };

/** The whole profile at a travel-frame point (h, partials in s and w). Scratch-based: nothing allocates. */
export function profileAt(site: UgSite, s: number, w: number, out: ProfileSample): ProfileSample {
  trench(site, s, w, out);
  if (w > 0) {
    gallery(site, s, w, T0);
    if (T0.h < out.h) Object.assign(out, T0);
    for (const ps of site.gallery.passages) {
      passage(ps, s, w, T0);
      if (T0.h < out.h) Object.assign(out, T0);
    }
  }
  for (const k of site.kickers) {
    kicker(k, s, w, T1);
    out.h += T1.h;
    out.hs += T1.hs;
    out.hw += T1.hw;
  }
  for (const br of site.bridges) {
    hump(br, s, w, T1);
    out.h += T1.h;
    out.hs += T1.hs;
    out.hw += T1.hw;
  }
  return out;
}

const PS: ProfileSample = { h: 0, hs: 0, hw: 0 };

/** Add the site's height at world (x, z) into `out`, the gradient exact. */
export function undergroundHeight(site: UgSite, x: number, z: number, out: HeightSample): void {
  const dx = x - site.cx;
  const dz = z - site.cz;
  const d = site.dir;
  const s = d * (dx * site.ux + dz * site.uz);
  const w = d * (-dx * site.uz + dz * site.ux);
  profileAt(site, s, w, PS);
  if (PS.h === 0 && PS.hs === 0 && PS.hw === 0) return;
  // dh/du = d dh/ds, dh/dv = d dh/dw.
  const hu = d * PS.hs;
  const hv = d * PS.hw;
  out.h += PS.h;
  out.gx += hu * site.ux - hv * site.uz;
  out.gz += hu * site.uz + hv * site.ux;
}

/** The profile's bounding box (world), for the height modifier: every term is 0 on and beyond it. */
export function undergroundBox(site: UgSite): { minX: number; minZ: number; maxX: number; maxZ: number } {
  const hw = DECK_RIGHT + 1;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [s, w] of [
    [-site.top - 1, -hw],
    [site.top + 1, -hw],
    [site.top + 1, hw],
    [-site.top - 1, hw],
  ]) {
    const p = toWorld(site, s, w);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX, minZ, maxX, maxZ };
}

const GH: HeightSample = { h: 0, gx: 0, gz: 0 };

/** The ground's grade at (x, z) (the terrain less this site's own profile) and its gradient, into `out`. */
export function gradeAt(site: UgSite, terrain: Terrain, x: number, z: number, out: HeightSample): HeightSample {
  GH.h = 0;
  GH.gx = 0;
  GH.gz = 0;
  undergroundHeight(site, x, z, GH);
  const g = terrain.slopeAt(x, z);
  out.h = terrain.heightAt(x, z) - GH.h;
  out.gx = g.gx - GH.gx;
  out.gz = g.gz - GH.gz;
  return out;
}

/** The bridge's lateral offset (m) of a travel-frame point off its axis, and its position along it from the trench's axis. */
export function bridgeLocal(br: Bridge, s: number, w: number): { p: number; q: number } {
  const rs = s - br.s;
  return { p: rs * br.as + w * br.aw, q: -rs * br.aw + w * br.as };
}

/** Travel-frame point of a bridge-local point. */
export function bridgePoint(br: Bridge, p: number, q: number): { s: number; w: number } {
  return { s: br.s + p * br.as - q * br.aw, w: p * br.aw + q * br.as };
}

/** The s where a line of the bridge's (lateral offset q) crosses |w| = aw on side `side`. */
export function bridgeLineS(br: Bridge, q: number, w: number): number {
  // q = -(s - br.s) aw + w as  =>  s = br.s + (w as - q) / aw.
  return br.s + (w * br.as - q) / br.aw;
}

/** A bridge deck's footprint over the trench band (|w| <= F + P), out to the parapets' outer faces (travel frame). */
export function bridgeDeck(br: Bridge): { s: number; w: number }[] {
  const q = CFG.bridge.half + 0.3;
  return [
    { s: bridgeLineS(br, -q, -P_OUT), w: -P_OUT },
    { s: bridgeLineS(br, -q, P_OUT), w: P_OUT },
    { s: bridgeLineS(br, q, P_OUT), w: P_OUT },
    { s: bridgeLineS(br, q, -P_OUT), w: -P_OUT },
  ];
}
