/**
 * The rail yard's layout (railYard.ts, docs/weekend.md): everything inside the weekend region as one pure function of
 * the area (its params, path and polygon) and the area's own seeded streams, cached per area, so the sim's walls, the
 * terrain, the lines, the renderer and the tests all read one plan.
 *
 * Written in the travel frame (railYardFrame.ts: t along the race from its entry end, w across, + toward the deeper
 * side P). The region is a classification yard round its throat road (the spine):
 *  - P side, inner: the receiving yard (The Tracks): the lead track beside the throat road, then three to five tracks
 *    C.tracks.pitch apart with stopped consists between the throats (2 to 6 cars, 8 to 14 m between runs), the
 *    fuelling pad's oil on the first aisle, a water column;
 *  - P side, outer: the hump (The Hump): a 3 m crest with a 12% run-up, the yard tower beside it, and past it the
 *    classification bowl, tracks fanning out between retarders with short cuts of cars, the landing kept clear;
 *  - the overbridge (The Overbridge, railYardBridge.ts): up a ramp along the P side's fence, over the whole yard on
 *    the diagonal 6 m up, down a ramp onto the transfer pad; one parapet bay missing over the departure yard;
 *  - N side, inner: the departure yard's two tracks, the dock (The Dock) 1.1 m up with its ramps, forklifts and pallets,
 *    the freight house behind it, then the container transfer pad with its gantry crane and container stacks (the
 *    pad is the drift zone); the kicker sits in the hump band beside the bridge's first ramp, throwing a car off the hump
 *    lead over its parapet up onto it;
 *  - N side, outer: the turnaround road (The Turnaround) along the fence with a banked corner at each end, past the
 *    diesel shop and the sand tower, the fence opened twice onto the ring street beside it.
 * Everything a car can stop against keeps off every line's path by half the line's width (Clearance), so each line is
 * a centre line a rival can drive (sim/ai/driverLine.ts driverDetours, later); the layout is placed in that order:
 * the lines, the shapes and the bridge, the buildings, the piers, the tracks and their freight, the clutter.
 */
import { CITY } from '../config';
import { Rng, deriveSeed } from '../../sim/prng';
import type { Vec2 } from '../../sim/math';
import { atan2, cos, sin, sqrt } from '../../sim/math';
import type { PropKind } from '../props';
import type { Area, FeatureLine, Surface } from './types';
import { distToPolygonEdge, pointInPolygon } from './geom';
import { regionFence, regionOf, spineLine } from './weekendRegion';
import type { Region } from './weekendRegion';
import type { BankedArc } from './banking';
import { framePoint, frameT, frameW, frameBox, orientedBox } from './railYardFrame';
import type { YardFrame, YardRect } from './railYardFrame';
import { Clearance, fillet } from './railYardPaths';
import { type DockSpec, type WedgeSpec, dockRamp, runFor, wedgeLength, wedgePoint } from './railYardShapes';
import { type BridgeGeo, bridgeChunks, bridgeGeo, bridgeLevel, bridgePoint, rampRun } from './railYardBridge';

const C = CITY.districts.railYard;
const FLARE = CITY.districts.weekend.flare;

export const CAR_KINDS = ['boxcar', 'tank', 'hopper', 'flatcar', 'caboose', 'autorack'] as const;
export type CarKind = (typeof CAR_KINDS)[number];

/** A stretch of track (paint): its two ends (world) and what it is. */
export interface YardTrack {
  a: Vec2;
  b: Vec2;
  kind: 'lead' | 'yard' | 'departure' | 'bowl' | 'pad' | 'crossover' | 'ladder';
}

/** One railcar: centre, unit heading, length (m), kind, livery. */
export interface YardCar {
  c: Vec2;
  ux: number;
  uz: number;
  len: number;
  kind: CarKind;
  tex: number;
}

/** A consist (or a cut): coupled cars on one track, one solid body of look railcar. */
export interface Consist {
  poly: Vec2[];
  cars: YardCar[];
}

/** What a yard solid is (each look yardFence, drawn by its kind). */
export type SolidKind = 'post' | 'sheet' | 'forklift' | 'retarder' | 'gantryLeg' | 'container' | 'tower' | 'shop' | 'sand' | 'house' | 'flood' | 'signalLeg' | 'water' | 'switchStand' | 'dockFace' | 'bankWall';

export interface YardSolid {
  kind: SolidKind;
  poly: Vec2[];
  /** Height over the ground (m): Wall.top once the terrain exists (a car flying higher passes over); Infinity for none. */
  height: number;
}

/** A destructible: kind, position, yaw. */
export interface YardJunk {
  kind: PropKind;
  x: number;
  z: number;
  yaw: number;
}

/** A surface patch and what the renderer draws for it. */
export interface YardPatch {
  surface: Surface;
  poly: Vec2[];
  priority: number;
  look: 'plate' | 'oil' | 'grease' | 'spill' | 'concrete' | 'asphalt' | 'pad';
}

/** A floodlight tower: its foot and the unit direction its floods face. */
export interface YardLight {
  p: Vec2;
  fx: number;
  fz: number;
}

export interface YardLayout {
  region: Region;
  f: YardFrame;
  /** Usable depth (m from the spine's axis, inside the fence) per C.sample along t, P side and N side. */
  outP: number[];
  outN: number[];
  lines: FeatureLine[];
  tracks: YardTrack[];
  consists: Consist[];
  solids: YardSolid[];
  junk: YardJunk[];
  patches: YardPatch[];
  hump: WedgeSpec;
  kicker: WedgeSpec | null;
  dock: DockSpec | null;
  banks: BankedArc[];
  bridge: BridgeGeo;
  lights: YardLight[];
  /** Signal gantries over the throat road: their two legs. */
  gantries: [Vec2, Vec2][];
  /** The gantry crane over the pad: its four legs (world, two pairs). */
  crane: Vec2[] | null;
  /** The yard tower (foot) and the direction its cab faces. */
  tower: YardLight | null;
  /** The transfer pad (the drift zone). */
  pad: Vec2[];
  /** The fence: solid posts and destructible panels, and the mouths left open onto the turnaround road (world centres). */
  posts: Vec2[];
  panels: YardJunk[];
  mouths: Vec2[];
  /** Key stations, for the renderer and the tests (t, m): the hump's crest and the hump line's w. */
  tc: number;
  hm: number;
  /** Where the missing parapet's drop lands (a box beside the bay) and where the kicker's throw lands (world). */
  drop: Vec2[] | null;
  kickLand: Vec2 | null;
}

const cache = new WeakMap<Area, YardLayout | null>();

/** The area's layout (null for an area that is no planned rail yard region). */
export function yardLayout(area: Area): YardLayout | null {
  let l = cache.get(area);
  if (l === undefined) {
    const r = regionOf(area);
    l = r && area.params.planned === 1 ? layOut(r) : null;
    cache.set(area, l);
  }
  return l;
}

/** Distance (m) along the ray from p in unit direction d to the polygon's edge (0 when p is outside). */
function rayDepth(poly: readonly Vec2[], px: number, pz: number, dx: number, dz: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - px) * ez - (a.z - pz) * ex) / den;
    const u = ((a.x - px) * dz - (a.z - pz) * dx) / den;
    if (t > 0 && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return Number.isFinite(best) && pointInPolygon(px, pz, poly as Vec2[]) ? best : 0;
}

/** The usable depth at t on one side, interpolated from the profile. */
function outAt(prof: readonly number[], t: number): number {
  const k = t / C.sample;
  const i = Math.max(0, Math.min(prof.length - 2, Math.floor(k)));
  const a = prof[i];
  const b = prof[i + 1];
  return a + (b - a) * Math.max(0, Math.min(1, k - i));
}

/** The least usable depth over [t0, t1] on one side. */
function outMin(prof: readonly number[], t0: number, t1: number): number {
  let m = Infinity;
  for (let t = t0; t <= t1 + 1e-6; t += C.sample / 2) m = Math.min(m, outAt(prof, t));
  return m;
}

function pickKind(rng: Rng): CarKind {
  const w = C.cars.weights;
  let total = 0;
  for (const k of CAR_KINDS) total += w[k];
  let r = rng.next() * total;
  for (const k of CAR_KINDS) {
    r -= w[k];
    if (r < 0) return k;
  }
  return 'boxcar';
}

/** The corner arc a fillet lays at b (the same construction as railYardPaths.fillet, for a corner whose legs give it the whole radius). */
function cornerArc(a: Vec2, b: Vec2, c: Vec2, radius: number): { cx: number; cz: number; r: number; a0: number; turn: number } {
  const l0 = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
  const l1 = sqrt((c.x - b.x) ** 2 + (c.z - b.z) ** 2) || 1;
  const d0x = (b.x - a.x) / l0;
  const d0z = (b.z - a.z) / l0;
  const d1x = (c.x - b.x) / l1;
  const d1z = (c.z - b.z) / l1;
  const turn = atan2(d0x * d1z - d0z * d1x, d0x * d1x + d0z * d1z);
  const at = Math.abs(turn);
  const room = Math.min(l0 / 2, l1 / 2);
  const r = Math.min(radius, room / Math.tan(at / 2));
  const tl = r * Math.tan(at / 2);
  const p0 = { x: b.x - d0x * tl, z: b.z - d0z * tl };
  const s = turn > 0 ? 1 : -1;
  const cx = p0.x - d0z * r * s;
  const cz = p0.z + d0x * r * s;
  return { cx, cz, r, a0: atan2(p0.z - cz, p0.x - cx), turn };
}

function layOut(r: Region): YardLayout {
  const area = r.area;
  const seed = area.params.seed;
  const dir: 1 | -1 = (area.params.dir0 || area.params.dir1 || 1) > 0 ? 1 : -1;
  const E = dir > 0 ? r.path[0] : r.path[r.path.length - 1];
  const X = dir > 0 ? r.path[r.path.length - 1] : r.path[0];
  const L = sqrt((X.x - E.x) ** 2 + (X.z - E.z) ** 2);
  const tx = (X.x - E.x) / L;
  const tz = (X.z - E.z) / L;
  // Depth either side (left of the travel first), from the polygon, every C.sample m.
  const prof = (side: 1 | -1): number[] => {
    const out: number[] = [];
    for (let t = 0; t <= L + C.sample; t += C.sample) {
      const tt = Math.min(t, L);
      out.push(Math.max(0, rayDepth(r.polygon, E.x + tx * tt, E.z + tz * tt, -tz * side, tx * side) - C.margin));
    }
    return out;
  };
  const left = prof(1);
  const right = prof(-1);
  const mid = (p: number[]) => {
    let s = 0;
    let n = 0;
    for (let t = 0.2 * L; t <= 0.8 * L; t += C.sample) {
      s += outAt(p, t);
      n++;
    }
    return s / n;
  };
  const sigma: 1 | -1 = mid(left) >= mid(right) ? 1 : -1;
  const outP = sigma > 0 ? left : right;
  const outN = sigma > 0 ? right : left;
  const f: YardFrame = { ox: E.x, oz: E.z, tx, tz, wx: -tz * sigma, wz: tx * sigma, L, dir };
  const P = (t: number, w: number) => framePoint(f, t, w);
  const rng = new Rng(deriveSeed(seed, 'railYard:layout'));
  const B = C.bridge;
  const W = C.lineWidth;
  const book = new Clearance();
  const solids: YardSolid[] = [];
  const tracks: YardTrack[] = [];
  const patches: YardPatch[] = [];
  const junk: YardJunk[] = [];
  const lights: YardLight[] = [];
  const gantries: [Vec2, Vec2][] = [];
  const inside = (p: Vec2, m = 1) => pointInPolygon(p.x, p.z, r.polygon) && distToPolygonEdge(p.x, p.z, r.polygon) >= m;

  // ---- Stations and bands -----------------------------------------------------------------------------------
  const R = rampRun();
  const bw = B.width / 2 + B.thick;
  // Ramp P along the P side's fence, its foot where the bridge line can reach it from the throat at a 55 degree slant.
  let wRP = outMin(outP, 0.15 * L, 0.55 * L) - bw - 2.5;
  let tP0 = FLARE + 30 + (wRP - 4) / Math.tan((55 * Math.PI) / 180);
  wRP = Math.min(wRP, outMin(outP, tP0 - 10, tP0 + R + B.run + 30) - bw - 2.5);
  tP0 = FLARE + 30 + (wRP - 4) / Math.tan((55 * Math.PI) / 180);
  // Ramp N onto the pad, its foot C.bridge.footN short of the exit (less on a short region), at the pad's middle.
  const wRN = -34;
  const tN1 = L - Math.min(B.footN, Math.max(54, L * 0.16));
  // The receiving tracks: as many as leave the hump band 30 m between them and the ramp's inner parapet.
  const humpOuter0 = wRP - bw - 3;
  const nT = Math.max(C.tracks.count[0], Math.min(C.tracks.count[1], Math.floor((humpOuter0 - 30 - 8 - 1.5 - C.tracks.first) / C.tracks.pitch) + 1));
  const trackW = Array.from({ length: nT }, (_, k) => C.tracks.first + k * C.tracks.pitch);
  const tracksEdge = trackW[nT - 1] + C.cars.width / 2;
  const hb0 = tracksEdge + 8;
  const humpRun = runFor(C.hump.rise, C.hump.grade, C.hump.ease);
  const hm = (hb0 + humpOuter0) / 2;
  const humpHalf = Math.max(6, Math.min(C.hump.half, (humpOuter0 - hb0) / 2 - C.hump.edge));

  // ---- The bridge -------------------------------------------------------------------------------------------
  const bridge = bridgeGeo(f, wRP, tP0, wRN, tN1);
  // Where the deck's centre line passes over the hump line (its first crossing of w = hm past ramp P).
  let tDeckHm = L;
  for (let s = bridge.R; s < bridge.S - bridge.R; s += 2) {
    const p = bridgePoint(bridge, s);
    if (frameW(f, p.x, p.z) <= hm + B.width) {
      tDeckHm = frameT(f, p.x, p.z);
      break;
    }
  }
  // The hump's crest: its share of the region, after the hump line has reached the band, its landing clear of the deck.
  const tc = Math.max(FLARE + 18 + humpRun + 14 + (hm - 5) / Math.tan((52 * Math.PI) / 180), Math.min(C.hump.atMax, tDeckHm - C.hump.land[1] - 10, Math.max(C.hump.atMin, C.hump.at * L)));
  const bowlEnd = L - FLARE - 18 - (hm - 5) / Math.tan((48 * Math.PI) / 180);

  // The dock and the pad (N side).
  const padT1 = L - FLARE - C.pad.end;
  const padT0 = Math.max(padT1 - C.pad.length, L * 0.5);
  const dRamp = dockRamp();
  const tD0 = FLARE + 70;
  const tD1 = padT0 - 14;
  const dockFace = C.dock.face;
  const dockBack = dockFace - C.dock.depth;
  const wDk = (dockFace + dockBack) / 2;

  // The turnaround road (N side): along the fence, its corners C.turnaround.radius, a banked arc at each.
  const T = C.turnaround;
  const roadW = (t: number) => -(outAt(outN, t) - T.inset);
  const tT0 = FLARE + 52;
  const tT1 = L - FLARE - 52;

  // ---- The lines (travel order: (t, w) waypoints, then rounded in the world) ------------------------------------
  const fromTW = (pts: [number, number][]) => pts.map(([t, w]) => P(t, w));
  const ends = (side: number, first: [number, number][], radius: number): Vec2[] => {
    const pts: [number, number][] = [[0, 0], [FLARE, 0], [FLARE + 16, side * 4], ...first, [L - FLARE - 16, side * 4], [L - FLARE, 0], [L, 0]];
    return fillet(fromTW(pts), radius, 3);
  };
  const aisle = (k: number) => C.tracks.first + C.tracks.pitch * (k + 0.5);
  const throat = C.tracks.throat;
  const tracksPath = ends(1, [[throat - 12, aisle(0)], [L * 0.5 - 18, aisle(0)], [L * 0.5 + 18, aisle(Math.min(1, nT - 2))], [L - throat + 12, aisle(Math.min(1, nT - 2))]], 30);
  const humpPath = ends(1, [[tc - humpRun - 14, hm], [tc + 20, hm], [bowlEnd, hm]], 40);
  // The bridge line: the ground to ramp P's foot, the centre line over the yard, the ground from ramp N's foot.
  const bridgeIn = fromTW([[0, 0], [FLARE, 0], [FLARE + 14, 4], [tP0 - 22, wRP], [tP0, wRP]]);
  const bridgeOut = fromTW([[tN1, wRN], [tN1 + 14, wRN], [L - FLARE - 14, -4], [L - FLARE, 0], [L, 0]]);
  const bridgePath = [...fillet(bridgeIn, 30, 3).slice(0, -1), ...bridge.pts, ...fillet(bridgeOut, 30, 3).slice(1)];
  // The dock line: up the dock's first ramp, along the platform, off its far ramp onto the pad, under the crane, past the kicker.
  const wPadOut = Math.max(-(outMin(outN, padT0, padT1) - T.inset - T.width / 2 - 4), -70);
  const dockPadW = Math.max(wPadOut + W.dock / 2 + 1, -48);
  const padPoly = frameBox(f, padT0, padT1, -12, wPadOut);
  const dockPath = ends(-1, [[tD0 - 16, wDk], [tD1 + 4, wDk], [padT0 + 10, wDk], [tN1 - 6, dockPadW], [tN1 + 22, dockPadW]], 26);
  // The turnaround: out to the fence road at the first corner, along it, in at the last.
  const roadPts: [number, number][] = [];
  for (let t = tT0; t <= tT1 + 1e-6; t += 24) roadPts.push([t, roadW(t)]);
  if (roadPts[roadPts.length - 1][0] < tT1 - 1) roadPts.push([tT1, roadW(tT1)]);
  const turnWay: [number, number][] = [[0, 0], [FLARE, 0], [FLARE + 14, -5], ...roadPts, [L - FLARE - 14, -5], [L - FLARE, 0], [L, 0]];
  const turnPath = fillet(fromTW(turnWay), T.radius, 3);

  // ---- The clearance book: the spine (a road), every line --------------------------------------------------------
  const spineHalf = Math.max(r.spineWidth, r.widthE, r.widthX) / 2 + 0.6;
  book.corridor('spine', r.path.map((p) => ({ x: p.x, z: p.z })), spineHalf);
  const linePad = C.lineMargin;
  book.corridor('tracks', tracksPath, W.tracks / 2 + linePad);
  book.corridor('hump', humpPath, W.hump / 2 + linePad);
  book.corridor('bridgeIn', fillet(bridgeIn, 30, 3), W.bridge / 2 + linePad);
  book.corridor('bridgeOut', fillet(bridgeOut, 30, 3), W.bridge / 2 + linePad);
  book.corridor('dock', dockPath, W.dock / 2 + linePad);
  book.corridor('turnaround', turnPath, W.turnaround / 2 + linePad);
  // The ramps are solid bodies: nothing stands on their footprint. The deck's footprint keeps anything taller than the railcars out.
  const chunks = bridgeChunks(bridge);
  chunks.forEach((q, i) => {
    if (bridge.cum[i + 1] <= bridge.R + 1e-6 || bridge.cum[i] >= bridge.S - bridge.R - 1e-6) book.take(q);
  });
  const deckBook = new Clearance();
  deckBook.corridor('deck', bridge.pts, bw + 1.5);
  const tallOk = (poly: Vec2[]) => deckBook.clearOfLines(poly, 0);

  // ---- Shapes: the hump, the dock, the kicker, the banked corners ----------------------------------------------
  const hp = P(tc - humpRun, hm);
  const hump: WedgeSpec = { fx: hp.x, fz: hp.z, hx: tx, hz: tz, run: humpRun, rise: C.hump.rise, ease: C.hump.ease, top: C.hump.top, fall: C.hump.fall, half: humpHalf, edge: C.hump.edge };
  book.take(frameBox(f, tc - humpRun, tc + C.hump.top + C.hump.fall, hm - humpHalf - C.hump.edge, hm + humpHalf + C.hump.edge));
  // The landing past the crest stays clear across the hump line and a margin either side.
  const landHalf = W.hump / 2 + 7;
  book.take(frameBox(f, tc + C.hump.land[0], tc + C.hump.land[1], hm - landHalf, hm + landHalf));

  let dock: DockSpec | null = null;
  if (tD1 - tD0 > 2 * dRamp + 40) {
    // The rect: u along the travel, v from the face back (toward -w).
    const o = P(tD0, dockFace);
    const rect: YardRect = { ox: o.x, oz: o.z, ux: tx, uz: tz, vx: -f.wx, vz: -f.wz, L: tD1 - tD0, D: C.dock.depth };
    dock = { rect, ramp: dRamp };
    // The face: a thin solid along the platform (its Wall.top settles to half the dock's height over the ground in front).
    solids.push({ kind: 'dockFace', poly: frameBox(f, tD0 + 0.5, tD1 - 0.5, dockFace, dockFace + 0.4), height: -1 });
    book.take(frameBox(f, tD0, tD1, dockBack, dockFace + 0.4));
  }

  // The kicker: a ballast heap under steel plates in the hump band beside ramp P, aimed in toward it, so a car off the hump lead
  // is thrown over the ramp's parapet up onto the climbing ramp: placed so a C.kicker.aimSpeed throw crosses the parapet well
  // clear and comes down on the ramp's centre line a little over its surface. Tried at a few angles until one fits the band.
  let kicker: WedgeSpec | null = null;
  let kickLand: Vec2 | null = null;
  const K = C.kicker;
  const kRun = runFor(K.lip, K.grade, K.ease);
  const kickW = wRP - K.beside;
  for (const yawDeg of [K.yawDeg, K.yawDeg - 3, K.yawDeg + 3, K.yawDeg - 5]) {
    if (kicker) break;
    const yaw = (yawDeg * Math.PI) / 180;
    const g = K.grade;
    const c = 1 / sqrt(1 + g * g);
    const vh = K.aimSpeed * c;
    const vy = K.aimSpeed * g * c;
    const D = K.beside / sin(yaw);
    const tt = D / vh;
    const yLand = K.lip + vy * tt - 4.905 * tt * tt;
    // The ramp station whose surface (at the planned levels) is 0.6 m under the car there.
    const lv = { h: 0, d: 0 };
    let sL = -1;
    for (let s = 0; s < bridge.R; s += 0.5) {
      if (bridgeLevel(bridge, s, lv).h >= yLand - 0.6) break;
      sL = s;
    }
    if (sL < 10) continue;
    const land = bridgePoint(bridge, sL);
    const tL = frameT(f, land.x, land.z);
    const lipT = tL - D * cos(yaw);
    // In toward the ramp: +w when the ramp lies outward of the heap.
    const hx = tx * cos(yaw) + f.wx * sin(yaw);
    const hz = tz * cos(yaw) + f.wz * sin(yaw);
    const lip = P(lipT, kickW);
    const spec: WedgeSpec = { fx: lip.x - hx * kRun, fz: lip.z - hz * kRun, hx, hz, run: kRun, rise: K.lip, ease: K.ease, top: 0, fall: K.drop, half: K.width / 2, edge: K.edge };
    const Lk = wedgeLength(spec);
    const B2 = spec.half + spec.edge;
    const box = [wedgePoint(spec, 0, -B2), wedgePoint(spec, Lk, -B2), wedgePoint(spec, Lk, B2), wedgePoint(spec, 0, B2)];
    if (book.clearOfLines(box, 0.2) && book.clearOfTaken(box, 0.6) && deckBook.clearOfLines(box, -1.4) && inside(lip, 6)) {
      kicker = spec;
      kickLand = { x: land.x, z: land.z };
      book.take(box);
      // The throw's path in the air and its landing on the ramp: nothing stands under it.
      book.corridor('kick', [wedgePoint(spec, Lk, 0), { x: land.x, z: land.z }], 3);
    }
  }

  const banks: BankedArc[] = [];
  {
    const tw = turnWay.map(([t, w]) => P(t, w));
    for (const k of [3, turnWay.length - 5]) {
      // The corner vertices where the road meets its legs to the throat (the first and last fence road points).
      const arc = cornerArc(tw[k - 1], tw[k], tw[k + 1], T.radius);
      const Bk = T.bank;
      const mid = arc.a0 + arc.turn / 2;
      const rOut = arc.r + T.width / 2 + 1;
      // The span's middle points from the centre to the arc's middle: the outside of the turn, where the road's edge rises.
      banks.push({ cx: arc.cx, cz: arc.cz, rOut, rise: Bk.rise, hold: Bk.hold, fall: Bk.fall, height: Bk.height, mid: wrap(mid), half: Math.abs(arc.turn) / 2 + 0.05, taper: (Bk.taper * Math.PI) / 180 });
    }
  }
  for (const b of banks) {
    // The crash barrier on the crest: thin solids along the arc (a car riding the bank meets it; it stands outside the road).
    const R2 = b.rOut + b.hold / 2;
    const n = Math.max(2, Math.ceil((2 * b.half * R2) / 5));
    for (let i = 0; i < n; i++) {
      const a0 = b.mid - b.half + (2 * b.half * i) / n;
      const a1 = b.mid - b.half + (2 * b.half * (i + 1)) / n;
      const p0 = { x: b.cx + cos(a0) * R2, z: b.cz + sin(a0) * R2 };
      const p1 = { x: b.cx + cos(a1) * R2, z: b.cz + sin(a1) * R2 };
      const q0 = { x: b.cx + cos(a0) * (R2 + 0.5), z: b.cz + sin(a0) * (R2 + 0.5) };
      const q1 = { x: b.cx + cos(a1) * (R2 + 0.5), z: b.cz + sin(a1) * (R2 + 0.5) };
      const poly = [p0, p1, q1, q0];
      if (!inside(p0, 0.5) || !inside(p1, 0.5) || !book.clearOfLines(poly, 0)) continue;
      solids.push({ kind: 'bankWall', poly, height: Infinity });
      book.take(poly);
    }
  }

  // The missing parapet bay over the departure yard (w from -14 to -30), on the side facing the exit where it can: the drop
  // lands on the ballast beside the deck, which nothing may stand on.
  let drop: Vec2[] | null = null;
  {
    const half = B.missing / 2;
    for (let s = bridge.R + half; s < bridge.S - bridge.R - half && !drop; s += 1) {
      const p = bridgePoint(bridge, s);
      const w = frameW(f, p.x, p.z);
      if (w > -14 || w < -30) continue;
      const prefer: 1 | -1 = -p.tz * tx + p.tx * tz > 0 ? 1 : -1;
      for (const side of [prefer, -prefer as 1 | -1]) {
        const box = [bridgePoint(bridge, s - half, side * (bw + 0.6)), bridgePoint(bridge, s + half, side * (bw + 0.6)), bridgePoint(bridge, s + half, side * (bw + 16)), bridgePoint(bridge, s - half, side * (bw + 16))];
        if (!box.every((q) => inside(q, 2)) || !book.clearOfTaken(box, 0.5)) continue;
        bridge.missing = { s0: s - half, s1: s + half, side };
        drop = box;
        book.take(box);
        break;
      }
    }
  }

  // ---- Buildings, the crane, the containers, the tower, the signals, the lights -------------------------------
  const place = (kind: SolidKind, poly: Vec2[], height: number, pad = 0.3): boolean => {
    if (!poly.every((p) => inside(p, 0.6))) return false;
    // Anything taller than the freight keeps out from under the deck.
    if (height > C.cars.height + 0.2 && !tallOk(poly)) return false;
    if (!book.place(poly, 0, pad)) return false;
    solids.push({ kind, poly, height });
    return true;
  };
  // The freight house behind the dock, in pieces where it fits (clear of the turnaround and the deck).
  if (dock) {
    for (let t = tD0 + dRamp; t < tD1 - dRamp - 1; t += 24) {
      const t1 = Math.min(tD1 - dRamp, t + 24);
      place('house', frameBox(f, t, t1 - 0.6, dockBack - C.dock.house, dockBack - 0.3), C.dock.houseHeight, 0.05);
    }
  }
  // Forklifts parked on the dock's back edge, clear of the line along it.
  // (They stand on the dock's own footprint, so only the lines and the deck are asked.)
  if (dock) {
    for (let t = tD0 + dRamp + 12; t < tD1 - dRamp - 6; t += 38 + rng.range(0, 20)) {
      const poly = orientedBox(P(t, dockBack + 1.1), tx, tz, 2.8, 1.3);
      if (!book.clearOfLines(poly, 0.1)) continue;
      solids.push({ kind: 'forklift', poly, height: 2.3 });
      book.take(poly);
    }
  }
  // The diesel shop and the sand tower between the dock band and the turnaround road.
  {
    const [sl, sd, sh] = T.shop;
    const [ql, qd, qh] = T.sand;
    let done = 0;
    for (let t = L * 0.3; t < L * 0.75 && done < 2; t += 12) {
      const wIn = roadW(t) + T.width / 2 + 3;
      if (done === 0 && place('shop', frameBox(f, t, t + sl, wIn, wIn + sd), sh)) {
        done = 1;
        t += sl + 10;
      }
      if (done === 1 && place('sand', frameBox(f, t, t + ql, roadW(t) + T.width / 2 + 3, roadW(t) + T.width / 2 + 3 + qd), qh)) done = 2;
    }
  }
  // The gantry crane over the pad: two pairs of legs straddling the pad's tracks.
  let crane: Vec2[] | null = null;
  {
    const G = C.pad.gantry;
    for (let t = padT0 + 14; t < padT0 + 60 && !crane; t += 4) {
      const legs = [P(t, G.w0), P(t + G.span, G.w0), P(t, G.w1), P(t + G.span, G.w1)];
      const polys = legs.map((c) => orientedBox(c, tx, tz, G.leg, G.leg));
      if (polys.every((q) => inside(q[0], 1) && book.clearOfLines(q, 0) && book.clearOfTaken(q, 0.5) && tallOk(q))) {
        polys.forEach((q) => {
          book.take(q);
          solids.push({ kind: 'gantryLeg', poly: q, height: G.height });
        });
        crane = legs;
      }
    }
  }
  // Container stacks along the pad's outer edge and the region's ends.
  {
    const Ct = C.pad.container;
    for (let t = padT0 + 4; t < padT1 - Ct.length; t += Ct.length + 1.2) {
      for (let row = 0; row < 3; row++) {
        const w0 = wPadOut + 1 + row * (Ct.width + 0.4);
        const tiers = 1 + rng.int(0, Ct.tiers - 1);
        place('container', frameBox(f, t, t + Ct.length, w0, w0 + Ct.width), Ct.height * tiers, 0.2);
      }
    }
  }
  // The yard tower beside the hump's crest, facing it.
  let tower: YardLight | null = null;
  for (const dt of [6, 12, -4, 18]) {
    const c = P(tc + dt, hb0 - 4);
    if (place('tower', orientedBox(c, tx, tz, 4.2, 4.2), 13)) {
      tower = { p: c, fx: f.wx, fz: f.wz };
      break;
    }
  }
  // The water column at the fuelling pad, between the lead and the first track.
  place('water', orientedBox(P(throat + 34, (C.lead + C.tracks.first) / 2), tx, tz, 0.9, 0.9), 4.5, 0.2);
  // Signal gantries over the throat road: the entry's signal bridge, then evenly along it.
  {
    const legW = spineHalf + 2.6;
    const at: number[] = [FLARE - 8];
    for (let k = 1; k <= C.lights.gantries - 1; k++) at.push((L * k) / C.lights.gantries);
    for (const t0 of at) {
      for (const dt of [0, 8, -8, 16, -16]) {
        const t = t0 + dt;
        const wA = t < FLARE ? r.widthE / 2 + 2.2 : legW + 1.2;
        const a = orientedBox(P(t, wA), tx, tz, 0.9, 0.9);
        const b = orientedBox(P(t, -wA), tx, tz, 0.9, 0.9);
        if (a.every((p) => inside(p, 0.5)) && b.every((p) => inside(p, 0.5)) && book.clearOfLines(a, 0) && book.clearOfLines(b, 0) && book.clearOfTaken(a, 0.3) && book.clearOfTaken(b, 0.3) && tallOk(a) && tallOk(b)) {
          book.take(a);
          book.take(b);
          solids.push({ kind: 'signalLeg', poly: a, height: C.lights.gantryHeight }, { kind: 'signalLeg', poly: b, height: C.lights.gantryHeight });
          gantries.push([P(t, wA), P(t, -wA)]);
          break;
        }
      }
    }
  }
  // Floodlight towers every C.lights.every along the travel, on a few lanes across, facing the spine.
  {
    const lanes = (t: number): number[] => [C.lead + 3, hb0 - 3.5, outAt(outP, t) - 2, -11.8, dockBack - C.dock.house - 2.5, -(outAt(outN, t) - 1.8)];
    for (let t = 60; t < L - 40; t += C.lights.every) {
      lanes(t).forEach((w, li) => {
        for (const dt of [0, 9, -9, 18]) {
          const tt = t + dt + (li % 2) * (C.lights.every / 2);
          if (tt > L - 40) break;
          const ww = li === 2 ? outAt(outP, tt) - 2 : li === 5 ? -(outAt(outN, tt) - 1.8) : w;
          const c = P(tt, ww);
          if (place('flood', orientedBox(c, tx, tz, 1.4, 1.4), C.lights.mast)) {
            const s = ww > 0 ? -1 : 1;
            lights.push({ p: c, fx: f.wx * s, fz: f.wz * s });
            break;
          }
        }
      });
    }
  }

  // ---- The bridge's piers and its two drops (the missing bay, the kicker's landing kept clear) ---------------------
  {
    const s0 = bridge.R + 6;
    const s1 = bridge.S - bridge.R - 6;
    let last = s0 - B.pierEvery;
    for (let s = s0; s <= s1; s += 2) {
      if (s - last < B.pierEvery) continue;
      const p = bridgePoint(bridge, s);
      const poly = orientedBox(p, p.tx, p.tz, B.pier, B.pier * 1.5);
      if (book.clearOfLines(poly, 0.2, new Set(['bridge'])) && book.clearOfTaken(poly, 0.6)) {
        book.take(poly);
        bridge.piers.push(s);
        last = s;
      }
    }
  }
  const junkRng = new Rng(deriveSeed(seed, 'railYard:junk'));
  const KINDS: PropKind[] = ['crate', 'pallets', 'drum', 'cableSpool', 'sandbags', 'crate', 'drum', 'barrel'];
  const RADIUS: Partial<Record<PropKind, number>> = { crate: 0.7, pallets: 0.72, drum: 0.42, cableSpool: 0.9, sandbags: 0.65, barrel: 0.45 };
  const drop1 = (x: number, z: number, kind: PropKind, pad: number): boolean => {
    const rr = RADIUS[kind] ?? 0.8;
    const sq = orientedBox({ x, z }, tx, tz, 2 * rr, 2 * rr);
    if (!inside({ x, z }, 1.5) || !book.clearOfLines(sq, pad) || !book.clearOfTaken(sq, 0.4)) return false;
    book.take(sq);
    junk.push({ kind, x, z, yaw: junkRng.range(0, 6.28) });
    return true;
  };
  // The risky line's destructible field: past the hump's landing, drums and tie stacks close either side of the bowl's
  // middle lane for 60 m, so a car landing crooked ploughs through them.
  for (let t = tc + C.hump.land[1] + 4, k = 0; t < Math.min(bowlEnd - 10, tc + C.hump.land[1] + 64); t += 2.6, k++) {
    const side = k % 2 ? 1 : -1;
    const kind: PropKind = k % 3 === 0 ? 'crate' : 'drum';
    const p = P(t, hm + side * (W.hump / 2 + C.lineMargin + 0.25 + (RADIUS[kind] ?? 0.8) + junkRng.range(0, 1.6)));
    drop1(p.x, p.z, kind, 0.05);
  }

  // ---- Tracks and freight -----------------------------------------------------------------------------------------
  const carRng = new Rng(deriveSeed(seed, 'railYard:cars'));
  const consists: Consist[] = [];
  const lay = (a: Vec2, b: Vec2, kind: YardTrack['kind']) => tracks.push({ a, b, kind });
  /** Stand cars along the track a->b from s0 to s1 (m along it), runs of [run] with [gap] gaps, each car where it is clear. */
  const standCars = (a: Vec2, b: Vec2, s0: number, s1: number, run: readonly [number, number], gap: readonly [number, number]) => {
    const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let s = s0 + carRng.range(0, gap[1]);
    while (s < s1) {
      const want = carRng.int(run[0], run[1]);
      const cars: YardCar[] = [];
      let at = s;
      for (let k = 0; k < want; k++) {
        let kind = pickKind(carRng);
        if (kind === 'caboose' && k !== want - 1) kind = 'boxcar';
        const l = C.cars.length[kind] + carRng.range(-0.3, 0.3);
        if (at + l > s1) break;
        const c = { x: a.x + ux * (at + l / 2), z: a.z + uz * (at + l / 2) };
        const poly = orientedBox(c, ux, uz, l, C.cars.width);
        if (!book.clearOfLines(poly, 0.15) || !book.clearOfTaken(poly, 0.5) || !poly.every((p) => inside(p, 1))) break;
        cars.push({ c, ux, uz, len: l, kind, tex: carRng.int(0, 7) });
        at += l + C.cars.coupler;
      }
      if (cars.length) {
        const c0 = cars[0];
        const c1 = cars[cars.length - 1];
        const from = { x: c0.c.x - (ux * c0.len) / 2, z: c0.c.z - (uz * c0.len) / 2 };
        const to = { x: c1.c.x + (ux * c1.len) / 2, z: c1.c.z + (uz * c1.len) / 2 };
        const mid = { x: (from.x + to.x) / 2, z: (from.z + to.z) / 2 };
        const poly = orientedBox(mid, ux, uz, sqrt((to.x - from.x) ** 2 + (to.z - from.z) ** 2), C.cars.width);
        book.take(poly);
        consists.push({ poly, cars });
        s = at - C.cars.coupler + carRng.range(gap[0], gap[1]);
      } else {
        s += 6;
      }
    }
  };
  // The lead beside the throat road (clear: the switcher's), the receiving tracks with ladders into the lead at both throats.
  lay(P(FLARE + 6, C.lead), P(L - FLARE - 6, C.lead), 'lead');
  for (const w of trackW) {
    lay(P(throat - 20, w), P(L - throat + 20, w), 'yard');
    lay(P(throat - 20 - (w - C.lead), C.lead), P(throat - 20, w), 'ladder');
    lay(P(L - throat + 20, w), P(L - throat + 20 + (w - C.lead), C.lead), 'ladder');
  }
  for (const w of trackW) {
    if (!carRng.chance(C.cars.fill)) continue;
    standCars(P(throat, w), P(L - throat, w), 0, L - 2 * throat, C.cars.run, C.cars.gap);
  }
  // Crossovers from the lead over the throat road to the departure yard (wet steel plates where they cross the road).
  for (let k = 0; k < C.crossovers.count; k++) {
    const tm = L * (0.22 + (0.56 * (k + 0.5)) / C.crossovers.count);
    const a = P(tm - C.crossovers.run / 2, C.lead);
    const b = P(tm + C.crossovers.run / 2, C.departure[0]);
    lay(a, b, 'crossover');
    // The plate: the strip of the crossover over the road, C.slick.cover of the road's width (the rest bare asphalt).
    const half = r.spineWidth / 2;
    const keep = k % 2 === 0 ? 1 : -1;
    const wLo = keep > 0 ? -half : half - 2 * half * C.slick.cover;
    const wHi = keep > 0 ? -half + 2 * half * C.slick.cover : half;
    // The crossover's t at w (the track's line), then a plate C.slick.plate long around it across [wLo, wHi].
    const tAt = (w: number) => tm - C.crossovers.run / 2 + ((w - C.lead) / (C.departure[0] - C.lead)) * C.crossovers.run;
    const hp2 = C.slick.plate / 2;
    patches.push({ surface: 'slick', priority: 7, look: 'plate', poly: [P(tAt(wLo) - hp2, wLo), P(tAt(wHi) - hp2, wHi), P(tAt(wHi) + hp2, wHi), P(tAt(wLo) + hp2, wLo)] });
  }
  // The departure yard beside the dock.
  for (const w of C.departure) {
    lay(P(tD0 - 30, w), P(padT0 + 6, w), 'departure');
    standCars(P(tD0 - 10, w), P(tD1, w), 0, tD1 - tD0 + 10, C.cars.run, C.cars.gap);
  }
  // The pad's two tracks under the crane.
  for (const w of [C.pad.gantry.w0 - 6, C.pad.gantry.w1 + 6]) lay(P(padT0, w), P(padT1, w), 'pad');
  // The classification bowl: tracks fanning out from the hump's foot, cuts of cars past the landing, retarders.
  {
    const o = P(tc + C.hump.top + C.hump.fall + 2, hm);
    const tEnd = bowlEnd + 10;
    const wLo = hb0 + 2;
    const wHi = Math.min(outMin(outP, tc, tEnd) - 4, hm + (hm - wLo));
    const n = Math.max(C.bowl.tracks[0], Math.min(C.bowl.tracks[1], Math.floor((wHi - wLo) / C.bowl.pitch) + 1));
    for (let j = 0; j < n; j++) {
      const w = wLo + ((wHi - wLo) * j) / Math.max(1, n - 1);
      const b = P(tEnd, w);
      lay(o, b, 'bowl');
      const len = sqrt((b.x - o.x) ** 2 + (b.z - o.z) ** 2);
      const ux = (b.x - o.x) / len;
      const uz = (b.z - o.z) / len;
      // Retarders: low steel boxes either side of the rails.
      for (const s of [-1, 1]) {
        const c = { x: o.x + ux * C.bowl.retarder.at - uz * s * (C.rail.gauge / 2 + 0.55), z: o.z + uz * C.bowl.retarder.at + ux * s * (C.rail.gauge / 2 + 0.55) };
        place('retarder', orientedBox(c, ux, uz, C.bowl.retarder.length, C.bowl.retarder.width), C.bowl.retarder.height, 0.1);
      }
      standCars(o, b, C.hump.land[1] - C.hump.top - C.hump.fall + 6, len - 4, C.bowl.cut, [6, 22]);
      // Switch stands at the fan's points.
      place('switchStand', orientedBox({ x: o.x + ux * 24 - uz * 2.4, z: o.z + uz * 24 + ux * 2.4 }, ux, uz, 0.4, 0.4), 1.2, 0.2);
    }
  }

  // ---- Storage tracks over the ground left open: rails along the travel wherever they fit, cuts of cars where clear ------
  {
    const avoid = new Clearance();
    avoid.corridor('turnaround', turnPath, T.width / 2 + 3);
    avoid.corridor('spine', r.path.map((p) => ({ x: p.x, z: p.z })), spineHalf + 2);
    const keepOff: Vec2[][] = [padPoly, frameBox(f, tD0 - 4, tD1 + 4, dockBack - C.dock.house - 2, dockFace + 2)];
    const fanHi = Math.min(outMin(outP, tc, bowlEnd + 10) - 4, hm + (hm - hb0 - 2));
    const ok = (t: number, w: number): boolean => {
      const p = P(t, w);
      if (!inside(p, 3) || !avoid.clearOfLines([p], 0) || keepOff.some((q) => pointInPolygon(p.x, p.z, q))) return false;
      // The hump and its bowl have their own tracks.
      if (w > 0 && w < fanHi + 6 && t > tc - humpRun - 6 && t < bowlEnd + 14) return false;
      return book.clearOfTaken(orientedBox(p, tx, tz, 4, C.rail.ballast), 0.3);
    };
    const lanes: number[] = [];
    const pMax = outMin(outP, 0.1 * L, 0.9 * L) + 30;
    const nMax = outMin(outN, 0.1 * L, 0.9 * L) + 30;
    for (let w = hb0 + 2; w < pMax; w += C.tracks.pitch) lanes.push(w);
    for (let w = dockBack - C.dock.house - 7; w > -nMax; w -= C.tracks.pitch) lanes.push(w);
    for (const w of lanes) {
      let start = -1;
      const t1 = L - 10;
      for (let t = 10; t <= t1 + 4; t += 4) {
        const good = t <= t1 && ok(t, w);
        if (good && start < 0) start = t;
        if (!good && start >= 0) {
          const end = t - 4;
          if (end - start >= 24) {
            const a = P(start, w);
            const b = P(end, w);
            lay(a, b, 'yard');
            standCars(a, b, 2, end - start - 2, [1, 3], [12, 40]);
          }
          start = -1;
        }
      }
    }
  }

  // ---- Surfaces and slick patches --------------------------------------------------------------------------------
  // The fuelling pad: concrete over the lead and the first aisle, oil on part of the aisle the Tracks line runs.
  patches.push({ surface: 'concrete', priority: 6, look: 'pad', poly: frameBox(f, throat + 8, throat + 64, C.lead - 3, aisle(0) + 3) });
  patches.push({ surface: 'slick', priority: 7, look: 'oil', poly: frameBox(f, throat + 22, throat + 22 + C.slick.patch[0], aisle(0) - 1.2, aisle(0) + 2.6) });
  patches.push({ surface: 'slick', priority: 7, look: 'oil', poly: frameBox(f, throat + 44, throat + 44 + C.slick.patch[0] * 0.7, C.lead - 1.5, C.lead + 2) });
  // Grease by the retarders, on one side of the hump line.
  patches.push({ surface: 'slick', priority: 7, look: 'grease', poly: frameBox(f, tc + C.bowl.retarder.at - 6, tc + C.bowl.retarder.at + 10, hm - 0.5, hm + C.slick.patch[1] + 1) });
  // The transfer pad: concrete, the drift zone.
  patches.push({ surface: 'concrete', priority: 6, look: 'pad', poly: padPoly });
  // The turnaround road: asphalt, a diesel spill across half of it by the shop.
  for (let i = 0; i + 1 < turnPath.length; i++) {
    const a = turnPath[i];
    const b = turnPath[i + 1];
    const tm = frameT(f, (a.x + b.x) / 2, (a.z + b.z) / 2);
    if (tm < FLARE + 20 || tm > L - FLARE - 20) continue;
    const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
    const nx = (-(b.z - a.z) / len) * (T.width / 2);
    const nz = ((b.x - a.x) / len) * (T.width / 2);
    patches.push({ surface: 'road', priority: 6, look: 'asphalt', poly: [{ x: a.x - nx, z: a.z - nz }, { x: b.x - nx, z: b.z - nz }, { x: b.x + nx, z: b.z + nz }, { x: a.x + nx, z: a.z + nz }] });
  }
  {
    const ts = L * 0.5;
    const w = roadW(ts);
    patches.push({ surface: 'slick', priority: 7, look: 'spill', poly: frameBox(f, ts, ts + C.slick.patch[0] * 1.2, w - 0.5, w + T.width / 2 - 0.3) });
  }
  // The dock: a wet steel dock plate on the platform, half its width.
  if (dock) {
    const tm = (tD0 + tD1) / 2;
    patches.push({ surface: 'slick', priority: 7, look: 'plate', poly: frameBox(f, tm, tm + C.slick.patch[0], wDk - 0.4, dockFace - 0.8) });
  }

  // ---- The lines as FeatureLines (region order) ------------------------------------------------------------------
  const reg = (pts: Vec2[]) => (dir > 0 ? pts : pts.slice().reverse()).map((p) => ({ x: p.x, z: p.z }));
  const lines: FeatureLine[] = [
    spineLine(r, 'The throat road', 'road', 'ground', 1),
    { id: 'tracks', name: 'The Tracks', kind: 'alt', path: reg(tracksPath), width: W.tracks, level: 'ground', surface: 'quay', difficulty: 2 },
    { id: 'hump', name: 'The Hump', kind: 'alt', path: reg(humpPath), width: W.hump, level: 'ground', surface: 'quay', difficulty: 3 },
    { id: 'bridge', name: 'The Overbridge', kind: 'alt', path: reg(bridgePath), width: W.bridge, level: 'deck', surface: 'road', difficulty: 2 },
    { id: 'dock', name: 'The Dock', kind: 'alt', path: reg(dockPath), width: W.dock, level: 'ground', surface: 'concrete', difficulty: 2 },
    { id: 'turnaround', name: 'The Turnaround', kind: 'alt', path: reg(turnPath), width: W.turnaround, level: 'ground', surface: 'road', difficulty: 1 },
  ];

  // ---- Clutter beside every alt line -----------------------------------------------------------------------------
  for (const line of [
    // The Tracks' aisles leave room only in the gaps between consists: tried more often.
    { pts: tracksPath, half: W.tracks / 2, every: 0.35 },
    { pts: humpPath, half: W.hump / 2, every: 1 },
    { pts: fillet(bridgeIn, 30, 3), half: W.bridge / 2, every: 1 },
    { pts: fillet(bridgeOut, 30, 3), half: W.bridge / 2, every: 1 },
    { pts: dockPath, half: W.dock / 2, every: 1 },
    { pts: turnPath, half: W.turnaround / 2, every: 1 },
  ]) {
    const ll = line.pts;
    let acc = 0;
    let next = junkRng.range(C.junk.step[0], C.junk.step[1]) * line.every;
    for (let i = 0; i + 1 < ll.length; i++) {
      const a = ll[i];
      const b = ll[i + 1];
      const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
      while (acc + len >= next) {
        const k = (next - acc) / (len || 1);
        const x = a.x + (b.x - a.x) * k;
        const z = a.z + (b.z - a.z) * k;
        const tt = frameT(f, x, z);
        if (tt > FLARE + 24 && tt < L - FLARE - 24) {
          const kind = KINDS[junkRng.int(0, KINDS.length - 1)];
          const side = junkRng.chance(0.5) ? 1 : -1;
          const off = line.half + C.lineMargin + junkRng.range(C.junk.off[0], C.junk.off[1]) + (RADIUS[kind] ?? 0.8);
          const nx = (-(b.z - a.z) / (len || 1)) * side;
          const nz = ((b.x - a.x) / (len || 1)) * side;
          if (!drop1(x + nx * off, z + nz * off, kind, 0.05)) drop1(x - nx * off, z - nz * off, kind, 0.05);
        }
        next += junkRng.range(C.junk.step[0], C.junk.step[1]) * line.every;
      }
      acc += len;
    }
  }
  // Forklifts' pallets and crates on the dock (between the line and the face or the back).
  if (dock) {
    for (let t = tD0 + dRamp + 6; t < tD1 - dRamp - 6; t += junkRng.range(8, 16)) {
      const w = junkRng.chance(0.5) ? dockFace - 1.3 : dockBack + 1.3;
      const p = P(t, w);
      drop1(p.x, p.z, junkRng.chance(0.6) ? 'pallets' : 'crate', 0.05);
    }
  }
  // Tie stacks and drums over the open ground, so nothing a car can reach is bare.
  {
    const scatter = new Rng(deriveSeed(seed, 'railYard:scatter'));
    const tries = Math.round((L * (outMin(outP, 0, L) + outMin(outN, 0, L))) / 700);
    for (let k = 0; k < tries; k++) {
      const t = scatter.range(FLARE + 10, L - FLARE - 10);
      const side = scatter.chance(0.55) ? 1 : -1;
      const w = side * scatter.range(10, side > 0 ? outAt(outP, t) - 2 : outAt(outN, t) - 2);
      const p = P(t, w);
      drop1(p.x, p.z, scatter.chance(0.5) ? 'crate' : scatter.chance(0.5) ? 'drum' : 'pallets', 0.6);
    }
  }

  // ---- The fence: posts and panels on the ring, two mouths onto the turnaround road ---------------------------------
  const posts: Vec2[] = [];
  const panels: YardJunk[] = [];
  const mouths: Vec2[] = [];
  for (const tm of [L * 0.36, L * 0.64].slice(0, C.fence.mouths)) {
    const w = -(outAt(outN, tm) + C.margin);
    mouths.push(P(tm, w));
  }
  // Every third bay is a corrugated steel sheet (a thin solid) rather than chain link: the yard's patched fence, and the panels' props kept to a budget.
  let bay = 0;
  for (const pc of regionFence(r, C.fence.postEvery)) {
    const len = sqrt((pc.bx - pc.ax) ** 2 + (pc.bz - pc.az) ** 2);
    const mx = (pc.ax + pc.bx) / 2;
    const mz = (pc.az + pc.bz) / 2;
    if (mouths.some((m) => sqrt((m.x - mx) ** 2 + (m.z - mz) ** 2) < C.fence.mouth / 2 + len / 2)) continue;
    const ux = (pc.bx - pc.ax) / (len || 1);
    const uz = (pc.bz - pc.az) / (len || 1);
    const ix = pc.nx * C.fence.inset;
    const iz = pc.nz * C.fence.inset;
    posts.push({ x: pc.ax + ix, z: pc.az + iz });
    if (bay++ % 3 === 2 && len > 3) {
      const c = { x: (pc.ax + pc.bx) / 2 + ix, z: (pc.az + pc.bz) / 2 + iz };
      solids.push({ kind: 'sheet', poly: orientedBox(c, ux, uz, len - C.fence.post - 0.1, 0.14), height: Infinity });
      continue;
    }
    const n = Math.max(1, Math.round((len - C.fence.post) / C.fence.pitch));
    const pitch = (len - C.fence.post) / n;
    const yawP = atan2(pc.nx, pc.nz);
    for (let k = 0; k < n; k++) {
      const s = C.fence.post / 2 + pitch * (k + 0.5);
      panels.push({ kind: 'fencePanel', x: pc.ax + ux * s + ix, z: pc.az + uz * s + iz, yaw: yawP });
    }
  }

  return {
    region: r,
    f,
    outP,
    outN,
    lines,
    tracks,
    consists,
    solids,
    junk,
    patches,
    hump,
    kicker,
    dock,
    banks,
    bridge,
    lights,
    gantries,
    crane,
    tower,
    pad: padPoly,
    posts,
    panels,
    mouths,
    tc,
    hm,
    drop,
    kickLand,
  };
}

const wrap = (a: number): number => atan2(sin(a), cos(a));
