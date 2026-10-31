/**
 * The rail yard's overbridge (railYard.ts, docs/weekend.md): a works road carried across the whole width of the yard,
 * C.bridge.clear (6 m) over the tracks, the throat road and both routes' racers. Its centre line is a straight ramp up
 * along the P side's outer edge, a short level run, a turn onto the long diagonal over the yard, a turn back and a
 * straight ramp down onto the transfer pad on the N side, then the ground to the exit.
 *
 * Two levels (types.ts DeckSpan, the elevated highway's `upper` form): the terrain stays the ground under it, and each
 * chunk of the centre line is a span whose `upper` writes the roadway's absolute height and its exact gradient. The
 * ramps' spans are `solid` (an embankment between retaining walls: nothing drives under them); the deck's are not, so a
 * car body nearer the ground than the deck drives the yard beneath it. The heights come from the finished terrain
 * (settleRailYard): a ground profile along the centre line (BridgeLevels) plus C.bridge.clear times the ramps' eased
 * share, so the feet meet the ground, the deck keeps its clearance over the yard as the city's ground rolls, and each
 * ramp climbs its 6 m over the ground at C.bridge.grade at the steepest (the ground's own roll adds to the absolute grade).
 *
 * Walls (look yardFence, drawn by render/districts/railYardPlant.ts from this same geometry):
 *  - the ramps' parapets: thin solids whose Wall.top is the ramp surface plus C.bridge.parapet, so they stop a car on
 *    the ramp and a car on the ground beside it, and a car the kicker throws over them passes;
 *  - the deck's parapets: Wall.bottom C.bridge.barrierReach under the deck, so the yard beneath drives under them; one
 *    bay (`missing`, over the departure yard) has none: the drop;
 *  - an abutment across each ramp's top end and the piers under the deck: Wall.top C.bridge.pierReach under the deck, so
 *    a car beneath meets them and a car on the deck passes over.
 * Pure: the levels object is the only state, written once by settleBridge.
 */
import { CITY } from '../config';
import type { Wall } from '../blocks';
import type { Terrain } from '../terrain';
import type { Vec2 } from '../../sim/math';
import { sqrt } from '../../sim/math';
import type { AreaBuild, DeckSpan, HeightSample } from './types';
import { solidWalls } from './geom';
import { framePoint, orientedBox } from './railYardFrame';
import type { YardFrame } from './railYardFrame';
import { cumulative, fillet, offset } from './railYardPaths';

const B = CITY.districts.railYard.bridge;

/** Ramp run (m) for a `clear` m climb at the peak grade with both ends eased. */
export const rampRun = (): number => B.clear / (B.grade * (1 - B.ease));

/**
 * The bridge's ground profile: the ground under the centre line every `step` m (world m), smoothed along it, with no yard
 * shape in it (the hump, the dock). The roadway is this plus C.bridge.clear times the ramps' share, so the deck keeps its
 * clearance over the yard wherever the city's ground rolls and the ramps climb C.bridge.clear over their own run. Zero
 * until settleBridge writes it once the terrain exists.
 */
export interface BridgeLevels {
  base: number[];
  step: number;
}

export interface BridgeGeo {
  /** Centre line from ramp P's foot to ramp N's foot (world), its arc lengths, its length (m). */
  pts: Vec2[];
  cum: number[];
  S: number;
  /** Each ramp's run (m): ramp P is s in [0, R], ramp N s in [S - R, S]. */
  R: number;
  /** The roadway's edges (world), left and right of the centre line's travel. */
  left: Vec2[];
  right: Vec2[];
  /** Outer faces of the parapets. */
  leftOut: Vec2[];
  rightOut: Vec2[];
  levels: BridgeLevels;
  /** Pier stations along the deck (s, m). */
  piers: number[];
  /** The missing parapet bay: s range and side (1 left, -1 right). */
  missing: { s0: number; s1: number; side: 1 | -1 } | null;
  /** The world-side sign of the frame's +w (1: +w is left of the travel). */
  wLeft: 1 | -1;
}

/**
 * The bridge's centre line in the travel frame: ramp P along w = wP from t = tP0, ramp N along w = wN ending at t = tN1.
 * The deck between the ramps' tops runs C.bridge.run level, turns (C.bridge.radius) onto the diagonal and back.
 */
export function bridgeGeo(f: YardFrame, wP: number, tP0: number, wN: number, tN1: number): BridgeGeo {
  const R = rampRun();
  const P = (t: number, w: number) => framePoint(f, t, w);
  const topP = tP0 + R;
  const topN = tN1 - R;
  // Corner vertices: the level run plus the fillet's tangent past each ramp top (the tangent from the turn's angle).
  let v1 = topP + B.run + 20;
  let v2 = topN - B.run - 20;
  for (let k = 0; k < 3; k++) {
    const th = Math.atan2(Math.abs(wP - wN), Math.max(1, v2 - v1));
    const tl = B.radius * Math.tan(th / 2);
    v1 = topP + B.run + tl;
    v2 = topN - B.run - tl;
  }
  const ramp = (t0: number, t1: number, w: number): Vec2[] => {
    const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / 6));
    return Array.from({ length: n + 1 }, (_, k) => P(t0 + ((t1 - t0) * k) / n, w));
  };
  const deck = fillet([P(topP, wP), P(v1, wP), P(v2, wN), P(topN, wN)], B.radius, 3);
  // Long straight legs in pieces of at most 8 m: the spans are the centre line's chunks.
  const deckPts: Vec2[] = [];
  for (let i = 0; i + 1 < deck.length; i++) {
    const a = deck[i];
    const b = deck[i + 1];
    const n = Math.max(1, Math.ceil(sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) / 8));
    for (let k = 0; k < n; k++) deckPts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  const pts = [...ramp(tP0, topP, wP).slice(0, -1), ...deckPts, ...ramp(topN, tN1, wN)];
  const cum = cumulative(pts);
  const S = cum[cum.length - 1];
  const half = B.width / 2;
  const wLeft: 1 | -1 = f.wx * -f.tz + f.wz * f.tx > 0 ? 1 : -1;
  return {
    pts,
    cum,
    S,
    R,
    left: offset(pts, half),
    right: offset(pts, -half),
    leftOut: offset(pts, half + B.thick),
    rightOut: offset(pts, -half - B.thick),
    levels: { base: new Array<number>(Math.ceil(S / 8) + 2).fill(0), step: 8 },
    piers: [],
    missing: null,
    wLeft,
  };
}

/** The roadway's eased ramp profile share at w in [0, 1] and its slope: quadratic over `ease` at both ends, straight between. */
function rampShare(w: number, out: { v: number; d: number }): void {
  const e = B.ease;
  const k = 1 / (1 - e);
  if (w <= 0) {
    out.v = 0;
    out.d = 0;
  } else if (w >= 1) {
    out.v = 1;
    out.d = 0;
  } else if (w < e) {
    out.v = (k * w * w) / (2 * e);
    out.d = (k * w) / e;
  } else if (w > 1 - e) {
    out.v = 1 - (k * (1 - w) * (1 - w)) / (2 * e);
    out.d = (k * (1 - w)) / e;
  } else {
    out.v = k * (w - e / 2);
    out.d = k;
  }
}

const RS = { v: 0, d: 0 };

/** The roadway's absolute height (m) and its slope along s (m/m) at arc length s: the ground profile (piecewise linear) plus the climb. */
export function bridgeLevel(b: BridgeGeo, s: number, out: { h: number; d: number }): { h: number; d: number } {
  const L = b.levels;
  const k = Math.max(0, Math.min(L.base.length - 2, Math.floor(s / L.step)));
  const g0 = L.base[k];
  const g1 = L.base[k + 1];
  const base = g0 + ((g1 - g0) * (s - k * L.step)) / L.step;
  const slope = (g1 - g0) / L.step;
  if (s < b.R) {
    rampShare(s / b.R, RS);
    out.h = base + B.clear * RS.v;
    out.d = slope + (B.clear * RS.d) / b.R;
  } else if (s > b.S - b.R) {
    rampShare((b.S - s) / b.R, RS);
    out.h = base + B.clear * RS.v;
    out.d = slope - (B.clear * RS.d) / b.R;
  } else {
    out.h = base + B.clear;
    out.d = slope;
  }
  return out;
}

/** Is chunk i (pts[i]..pts[i+1]) on a ramp? */
const onRamp = (b: BridgeGeo, i: number): boolean => b.cum[i + 1] <= b.R + 1e-6 || b.cum[i] >= b.S - b.R - 1e-6;

/** The quad of chunk i between two offset lines. */
const chunkQuad = (l: Vec2[], r: Vec2[], i: number): Vec2[] => [l[i], l[i + 1], r[i + 1], r[i]];

/** Chunk i's span polygon: its quad stretched 0.1 m past both ends along the chunk, so neighbouring spans overlap and no point on a shared edge falls between them. */
function spanQuad(b: BridgeGeo, i: number): Vec2[] {
  const a = b.pts[i];
  const c = b.pts[i + 1];
  const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
  const ex = ((c.x - a.x) / len) * 0.1;
  const ez = ((c.z - a.z) / len) * 0.1;
  const [l0, l1, r1, r0] = chunkQuad(b.leftOut, b.rightOut, i);
  return [{ x: l0.x - ex, z: l0.z - ez }, { x: l1.x + ex, z: l1.z + ez }, { x: r1.x + ex, z: r1.z + ez }, { x: r0.x - ex, z: r0.z - ez }];
}

/** The footprint of the roadway with its parapets, chunk by chunk (what the spans cover). */
export function bridgeChunks(b: BridgeGeo): Vec2[][] {
  return b.pts.slice(0, -1).map((_, i) => spanQuad(b, i));
}

/** The world point at (s, offset across to the left) on the centre line, with its unit heading. */
export function bridgePoint(b: BridgeGeo, s: number, across = 0): { x: number; z: number; tx: number; tz: number } {
  let i = 0;
  while (i + 2 < b.pts.length && b.cum[i + 1] < s) i++;
  const a = b.pts[i];
  const c = b.pts[i + 1];
  const len = b.cum[i + 1] - b.cum[i] || 1;
  const k = Math.max(0, Math.min(1, (s - b.cum[i]) / len));
  const tx = (c.x - a.x) / len;
  const tz = (c.z - a.z) / len;
  return { x: a.x + (c.x - a.x) * k - tz * across, z: a.z + (c.z - a.z) * k + tx * across, tx, tz };
}

/** How each bridge wall gets its height once the levels exist (settleBridge). */
type WallRule = { kind: 'ramp' | 'deck' | 'pier'; walls: Wall[]; s0: number; s1: number };
const rules = new WeakMap<AreaBuild, WallRule[]>();

const LV = { h: 0, d: 0 };

/** The bridge's spans and walls into a build (the walls' heights wait for settleBridge). */
export function buildBridge(b: BridgeGeo, out: AreaBuild, area: number): void {
  const list: WallRule[] = rules.get(out) ?? [];
  rules.set(out, list);
  for (let i = 0; i + 1 < b.pts.length; i++) {
    const a = b.pts[i];
    const c = b.pts[i + 1];
    const len = b.cum[i + 1] - b.cum[i] || 1;
    const ux = (c.x - a.x) / len;
    const uz = (c.z - a.z) / len;
    const s0 = b.cum[i];
    const ramp = onRamp(b, i);
    const span: DeckSpan = {
      polygon: spanQuad(b, i),
      area,
      depth: B.clear,
      solid: ramp,
      upper(x: number, z: number, o: HeightSample): void {
        const t = Math.max(0, Math.min(len, (x - a.x) * ux + (z - a.z) * uz));
        bridgeLevel(b, s0 + t, LV);
        o.h = LV.h;
        o.gx = LV.d * ux;
        o.gz = LV.d * uz;
      },
    };
    out.decks.push(span);
    for (const side of [1, -1] as const) {
      const sm = s0 + len / 2;
      if (b.missing && side === b.missing.side && sm > b.missing.s0 && sm < b.missing.s1) continue;
      const quad = side > 0 ? chunkQuad(b.leftOut, b.left, i) : chunkQuad(b.right, b.rightOut, i);
      const walls = solidWalls(quad, 'yardFence', area);
      out.walls.push(...walls);
      list.push({ kind: ramp ? 'ramp' : 'deck', walls, s0, s1: b.cum[i + 1] });
    }
  }
  // The abutments: across each ramp's top end, a metre deep inside the ramp's solid body.
  const half = B.width / 2 + B.thick;
  for (const s of [b.R - 0.5, b.S - b.R + 0.5]) {
    const p = bridgePoint(b, s);
    const walls = solidWalls(orientedBox(p, p.tx, p.tz, 1, 2 * half), 'yardFence', area);
    out.walls.push(...walls);
    list.push({ kind: 'pier', walls, s0: s, s1: s });
  }
  for (const s of b.piers) {
    const p = bridgePoint(b, s);
    const walls = solidWalls(orientedBox(p, p.tx, p.tz, B.pier, B.pier * 1.5), 'yardFence', area);
    out.walls.push(...walls);
    list.push({ kind: 'pier', walls, s0: s, s1: s });
  }
}

/**
 * The bridge's ground profile from the finished terrain (the highest ground across the roadway and 2 m either side every
 * step along it, the dock under the deck included; on the ramps without the yard shapes beside them), then smoothed over
 * 40 m and never under that highest ground, so the deck reads as one span and keeps its clearance; then every bridge wall's height:
 * a ramp parapet C.bridge.parapet over the roadway, a deck parapet's underside C.bridge.barrierReach under it, a pier's
 * and an abutment's top C.bridge.pierReach under it.
 */
export function settleBridge(b: BridgeGeo, build: AreaBuild, terrain: Terrain, raised: (x: number, z: number) => boolean): void {
  const L = b.levels;
  const n = L.base.length;
  const raw: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = Math.min(b.S, k * L.step);
    let top = -Infinity;
    for (const across of [-B.width / 2 - 2, -B.width / 4, 0, B.width / 4, B.width / 2 + 2]) {
      const p = bridgePoint(b, s, across);
      if (!raised(p.x, p.z) || (s > b.R && s < b.S - b.R)) top = Math.max(top, terrain.heightAt(p.x, p.z));
    }
    raw.push(top);
  }
  // Stations whose every sample a yard shape raises take their neighbours' ground.
  for (let k = 0; k < n; k++) {
    if (Number.isFinite(raw[k])) continue;
    let a = k - 1;
    while (a >= 0 && !Number.isFinite(raw[a])) a--;
    let c = k + 1;
    while (c < n && !Number.isFinite(raw[c])) c++;
    raw[k] = a >= 0 && c < n ? Math.max(raw[a], raw[c]) : a >= 0 ? raw[a] : c < n ? raw[c] : 0;
  }
  // The feet sit on the ground; between them a running mean over +-20 m, never under the ground it spans.
  const half = Math.round(20 / L.step);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(n - 1, k + half); j++) {
      sum += raw[j];
      cnt++;
    }
    L.base[k] = Math.max(sum / cnt, raw[k]);
  }
  L.base[0] = terrain.heightAt(b.pts[0].x, b.pts[0].z);
  const last = b.pts[b.pts.length - 1];
  const kl = Math.min(n - 1, Math.floor(b.S / L.step));
  for (let k = kl; k < n; k++) L.base[k] = terrain.heightAt(last.x, last.z);
  for (const r of rules.get(build) ?? []) {
    const hi = Math.max(bridgeLevel(b, r.s0, LV).h, bridgeLevel(b, r.s1, LV).h);
    const lo = Math.min(bridgeLevel(b, r.s0, LV).h, bridgeLevel(b, r.s1, LV).h);
    if (r.kind === 'ramp') for (const w of r.walls) w.top = hi + B.parapet;
    else if (r.kind === 'deck') for (const w of r.walls) w.bottom = lo - B.barrierReach;
    else for (const w of r.walls) w.top = lo - B.pierReach;
  }
}
