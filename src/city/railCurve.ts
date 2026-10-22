/**
 * The elevated railway's centerline as the renderer uses it: the subway
 * area's path (city side, node to node over the curb lane) carried on past
 * both map ends into tunnel portals far out in the fog, resampled every 2 m
 * and smoothed so the small kinks at every node become gentle curves the
 * trains can ride without snapping. Along it:
 *  - the deck top height: the terrain dilated and smoothed along the line, so
 *    the deck never dips into the river channel or follows a pothole, plus
 *    the deck height, dropping to the portals at the ends; across a bluff
 *    (districts/bluff.ts) the deck holds one absolute level instead (`level`)
 *    and blends back into that profile beyond it, over whatever length keeps
 *    the grade gentle, so the ground comes up to the track on the high side
 *    and the track runs at grade there;
 *  - the unit tangent and the normal toward the pillar side (the deck's
 *    outer edge over the sidewalk);
 *  - the two tracks' lateral offsets: 2 m either side of the middle, except
 *    at stations, where the street side track swings out around an island
 *    platform and back.
 * Pure and deterministic apart from the height function it is handed (sqrt,
 * no trig), and it lives in the city because the sim needs it too: the level
 * crossings (sim/levelCrossing.ts) time their gates from where on this curve
 * the trains are. Everything is plain arrays so the per frame train update
 * never allocates.
 */
import { Vec2, sqrt } from '../sim/math';

const len2 = (x: number, z: number): number => sqrt(x * x + z * z);

export const RAIL = {
  /** Sample spacing along the curve (m). */
  step: 2,
  /** Smoothing half window (m): node kinks become arcs about twice this long. */
  smooth: 14,
  /** Terrain dilation half window (m) before smoothing: spans the river channel. */
  dilate: 30,
  /** Height smoothing half window (m). */
  heightSmooth: 22,
  /** Render-only run-off past each end of the area path, ending in a portal (m). */
  runOff: 320,
  /** Portal mouth this far from the curve's end; the track keeps descending beyond it (m). */
  portalFromEnd: 40,
  /** Ramp from the portal mouth up to full deck height (m). */
  ramp: 170,
  /** Deck top above ground at the portal mouth (m), and the tunnel's descent beyond it (rise per m). */
  mouthClearance: 0.4,
  tunnelGrade: 0.25,
  /** Track centers either side of the deck middle (m). */
  trackHalf: 2,
  /** At a station the street side track swings this much further out (m). */
  stationSpread: 4.4,
  /** Platform length (m) and the track's swing-out on each side of it (m). */
  platform: 92,
  swing: 50,
  /**
   * A blend back from a level stretch (RailLevel) grows in steps of blendStep (m) until the deck grade
   * along it stays under levelGrade, up to levelBlendMax (m): the level's offset from the profile is
   * what it is (a terrace meeting high ground, a ridge under the line), the grade is the trains'.
   */
  levelGrade: 0.06,
  blendStep: 20,
  levelBlendMax: 420,
  /** Deck edge beyond the outer track center (m). */
  edgeOut: 2.5,
  /**
   * Tightest curve the trains ride (m). The cars are rigid 15.4 m bodies posed from the tangent at
   * their middle, so on a curve their ends swing out of the arc by (7.7 m)² / 2R: at 55 m that is
   * 0.54 m, about the half gauge (0.72 m), and the body still covers its rails; tighter and the ends
   * hang beside the track. The subway planner keeps its swings well above this
   * (CITY.districts.subway.swingRadius); a bluff detour's legs come closest.
   */
  minRadius: 55,
} as const;

export interface RailStation {
  /** Platform center along the curve (m). */
  s: number;
  /** Board name index. */
  name: number;
}

export interface RailCurve {
  n: number;
  length: number;
  x: Float64Array;
  z: Float64Array;
  /** Terrain under the centerline. */
  ground: Float64Array;
  /** Deck top (tie top) height. */
  deck: Float64Array;
  /** Unit tangent (direction of growing s). */
  tx: Float64Array;
  tz: Float64Array;
  /** Unit normal toward the pillar side (deck's outer edge). */
  px: Float64Array;
  pz: Float64Array;
  /** Portal mouths (s) at the start and end. */
  portalA: number;
  portalB: number;
  /** Where the city part of the line starts and ends (s): the area path's ends. */
  cityA: number;
  cityB: number;
  stations: RailStation[];
  /** The level stretch across a bluff (s, both NaN without one): the deck top is `level.y` between them. */
  levelA: number;
  levelB: number;
  /** How far before levelA and past levelB the deck blends back into its profile (m, NaN without a level). */
  blendA: number;
  blendB: number;
  /**
   * +1 when the pillar side is on the right of travel toward growing s. (With y up,
   * facing along (tx, tz) the right hand side is (-tz, tx).)
   */
  pillarRight: 1 | -1;
}

/** Point on the curve at s, linearly between samples. */
export interface CurvePoint {
  x: number;
  z: number;
  y: number;
  ground: number;
  tx: number;
  tz: number;
  px: number;
  pz: number;
}

export function curvePoint(): CurvePoint {
  return { x: 0, z: 0, y: 0, ground: 0, tx: 0, tz: 1, px: 1, pz: 0 };
}

export function sampleCurve(c: RailCurve, s: number, out: CurvePoint): CurvePoint {
  const f = Math.max(0, Math.min(c.n - 1.000001, s / RAIL.step));
  const i = Math.floor(f);
  const t = f - i;
  const j = i + 1;
  out.x = c.x[i] + (c.x[j] - c.x[i]) * t;
  out.z = c.z[i] + (c.z[j] - c.z[i]) * t;
  out.y = c.deck[i] + (c.deck[j] - c.deck[i]) * t;
  out.ground = c.ground[i] + (c.ground[j] - c.ground[i]) * t;
  let tx = c.tx[i] + (c.tx[j] - c.tx[i]) * t;
  let tz = c.tz[i] + (c.tz[j] - c.tz[i]) * t;
  const l = sqrt(tx * tx + tz * tz) || 1;
  tx /= l;
  tz /= l;
  out.tx = tx;
  out.tz = tz;
  out.px = -tz * c.pillarRight;
  out.pz = tx * c.pillarRight;
  return out;
}

/** Deck top slope dy/ds at s. */
export function deckSlope(c: RailCurve, s: number): number {
  const i = Math.max(0, Math.min(c.n - 2, Math.floor(s / RAIL.step)));
  return (c.deck[i + 1] - c.deck[i]) / RAIL.step;
}

/** 0..1: how far a station's swing-out has the street side track out at s. */
export function stationSwing(c: RailCurve, s: number): number {
  let w = 0;
  for (const st of c.stations) {
    const d = Math.abs(s - st.s) - RAIL.platform / 2;
    if (d <= 0) return 1;
    if (d < RAIL.swing) {
      const t = 1 - d / RAIL.swing;
      w = Math.max(w, t * t * (3 - 2 * t));
    }
  }
  return w;
}

/** Lateral offset (toward the pillar side) of track 0 (street side) or 1 (pillar side) at s. */
export function trackLateral(c: RailCurve, track: 0 | 1, s: number): number {
  if (track === 1) return RAIL.trackHalf;
  return -RAIL.trackHalf - RAIL.stationSpread * stationSwing(c, s);
}

/** Track a service toward growing s (dir +1) runs on: right hand running, like the streets. */
export function trackFor(c: RailCurve, dir: 1 | -1): 0 | 1 {
  // Pillar side on the right of +s travel: +s trains take the pillar side track.
  const rightIsPillar = c.pillarRight === 1;
  return (dir === 1) === rightIsPillar ? 1 : 0;
}

/** Direction (+1: toward growing s) of the trains on a track. */
export function dirOn(c: RailCurve, track: 0 | 1): 1 | -1 {
  return trackFor(c, 1) === track ? 1 : -1;
}

/** Nearest curve position of a point: distance along (s) and signed lateral (toward the pillar side). */
export function projectOnCurve(c: RailCurve, x: number, z: number): { s: number; lateral: number } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < c.n; i++) {
    const d = (c.x[i] - x) ** 2 + (c.z[i] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  // Refine along the tangent.
  const along = (x - c.x[best]) * c.tx[best] + (z - c.z[best]) * c.tz[best];
  const s = Math.max(0, Math.min(c.length, best * RAIL.step + along));
  const px = -c.tz[best] * c.pillarRight;
  const pz = c.tx[best] * c.pillarRight;
  return { s, lateral: (x - c.x[best]) * px + (z - c.z[best]) * pz };
}

/** A stretch of track held at one absolute height (a bluff: the trains stay level while the ground climbs to them). */
export interface RailLevel {
  /** Ends of the stretch on the area path (projected onto the curve). */
  a: Vec2;
  b: Vec2;
  /** Deck top (tie top) height along it (m, absolute). */
  y: number;
  /** Past each end the deck eases back into its normal profile over at least this distance (m; longer where the grade needs it, RailCurve.blendA/B). */
  blend: number;
}

/**
 * Build the curve from the subway area path. `side` is the area's pillar side
 * (+1: +x); `stationPoints` are the platform centers on the city path; `level`
 * holds a stretch at one height (see RailLevel).
 */
export function buildRailCurve(path: readonly Vec2[], side: number, deckHeight: number, heightAt: (x: number, z: number) => number, stationPoints: readonly Vec2[] = [], level?: RailLevel): RailCurve {
  // Run-offs straight on from the end segments.
  const ext = (a: Vec2, b: Vec2): Vec2 => {
    const l = len2(b.x - a.x, b.z - a.z) || 1;
    return { x: b.x + ((b.x - a.x) / l) * RAIL.runOff, z: b.z + ((b.z - a.z) / l) * RAIL.runOff };
  };
  const full = [ext(path[1], path[0]), ...path, ext(path[path.length - 2], path[path.length - 1])];
  // Resample the polyline every step.
  const raw: Vec2[] = [];
  let carry = 0;
  for (let i = 0; i + 1 < full.length; i++) {
    const a = full[i];
    const b = full[i + 1];
    const len = len2(b.x - a.x, b.z - a.z);
    let d = carry;
    while (d < len) {
      raw.push({ x: a.x + ((b.x - a.x) * d) / len, z: a.z + ((b.z - a.z) * d) / len });
      d += RAIL.step;
    }
    carry = d - len;
  }
  raw.push(full[full.length - 1]);
  const n = raw.length;
  // Moving average (ends clamped) turns the node kinks into arcs; then re-space evenly.
  const k = Math.round(RAIL.smooth / RAIL.step);
  const sm: Vec2[] = raw.map((_, i) => {
    let sx = 0;
    let sz = 0;
    let w = 0;
    for (let j = -k; j <= k; j++) {
      const q = raw[Math.max(0, Math.min(n - 1, i + j))];
      sx += q.x;
      sz += q.z;
      w++;
    }
    return { x: sx / w, z: sz / w };
  });
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + len2(sm[i].x - sm[i - 1].x, sm[i].z - sm[i - 1].z));
  const length = cum[n - 1];
  const m = Math.floor(length / RAIL.step) + 1;
  const x = new Float64Array(m);
  const z = new Float64Array(m);
  let seg = 0;
  for (let i = 0; i < m; i++) {
    const s = i * RAIL.step;
    while (seg < n - 2 && cum[seg + 1] < s) seg++;
    const t = (s - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    x[i] = sm[seg].x + (sm[seg + 1].x - sm[seg].x) * t;
    z[i] = sm[seg].z + (sm[seg + 1].z - sm[seg].z) * t;
  }
  const tx = new Float64Array(m);
  const tz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(m - 1, i + 1);
    const l = len2(x[b] - x[a], z[b] - z[a]) || 1;
    tx[i] = (x[b] - x[a]) / l;
    tz[i] = (z[b] - z[a]) / l;
  }
  // Pillar side: the area's side is along +x for its north-south line; pick the matching normal.
  const mid = m >> 1;
  const pillarRight: 1 | -1 = -tz[mid] * side >= 0 ? 1 : -1;
  const px = new Float64Array(m);
  const pz = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    px[i] = -tz[i] * pillarRight;
    pz[i] = tx[i] * pillarRight;
  }
  // Heights: terrain dilated then smoothed along the line.
  const ground = new Float64Array(m);
  for (let i = 0; i < m; i++) ground[i] = heightAt(x[i], z[i]);
  const kd = Math.round(RAIL.dilate / RAIL.step);
  const dil = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let v = -Infinity;
    for (let j = Math.max(0, i - kd); j <= Math.min(m - 1, i + kd); j++) v = Math.max(v, ground[j]);
    dil[i] = v;
  }
  const kh = Math.round(RAIL.heightSmooth / RAIL.step);
  const base = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let sum = 0;
    let w = 0;
    for (let j = Math.max(0, i - kh); j <= Math.min(m - 1, i + kh); j++) {
      sum += dil[j];
      w++;
    }
    base[i] = sum / w;
  }
  const portalA = RAIL.portalFromEnd;
  const portalB = (m - 1) * RAIL.step - RAIL.portalFromEnd;
  const deck = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const s = i * RAIL.step;
    const fromMouth = Math.min(s - portalA, portalB - s);
    let clear: number;
    if (fromMouth < 0) clear = RAIL.mouthClearance + fromMouth * RAIL.tunnelGrade;
    else if (fromMouth < RAIL.ramp) {
      const t = fromMouth / RAIL.ramp;
      clear = RAIL.mouthClearance + (deckHeight - RAIL.mouthClearance) * t * t * (3 - 2 * t);
    } else clear = deckHeight;
    // Near the portals the deck follows its own ground rather than the dilated profile.
    const blend = Math.max(0, Math.min(1, fromMouth / RAIL.ramp));
    deck[i] = ground[i] + (base[i] - ground[i]) * blend + clear;
  }
  const curve: RailCurve = {
    n: m,
    length: (m - 1) * RAIL.step,
    x,
    z,
    ground,
    deck,
    tx,
    tz,
    px,
    pz,
    portalA,
    portalB,
    cityA: 0,
    cityB: 0,
    stations: [],
    levelA: NaN,
    levelB: NaN,
    blendA: NaN,
    blendB: NaN,
    pillarRight,
  };
  curve.cityA = projectOnCurve(curve, path[0].x, path[0].z).s;
  curve.cityB = projectOnCurve(curve, path[path.length - 1].x, path[path.length - 1].z).s;
  curve.stations = stationPoints.map((p, i) => ({ s: projectOnCurve(curve, p.x, p.z).s, name: i }));
  if (level) {
    const sa = projectOnCurve(curve, level.a.x, level.a.z).s;
    const sb = projectOnCurve(curve, level.b.x, level.b.z).s;
    curve.levelA = Math.min(sa, sb);
    curve.levelB = Math.max(sa, sb);
    // Level across the stretch, a smoothstep back into the profile beyond each end. Over a fixed length
    // that step is as steep as the level's offset from the profile makes it (a terrace meeting high
    // ground, a ridge under the line), so each blend grows from level.blend until the deck grade along
    // it stays under RAIL.levelGrade: a gentle train grade whatever the offset.
    const profile = Float64Array.from(deck);
    const apply = (bA: number, bB: number) => {
      for (let i = 0; i < m; i++) {
        const s = i * RAIL.step;
        const out = s < curve.levelA ? curve.levelA - s : s > curve.levelB ? s - curve.levelB : 0;
        const b = s < curve.levelA ? bA : bB;
        if (out >= b) {
          deck[i] = profile[i];
          continue;
        }
        const t = 1 - out / b;
        const w = t * t * (3 - 2 * t);
        deck[i] = profile[i] + (level.y - profile[i]) * w;
      }
    };
    const steepest = (s0: number, s1: number) => {
      let g = 0;
      for (let i = Math.max(1, Math.floor(s0 / RAIL.step)); i <= Math.min(m - 1, Math.ceil(s1 / RAIL.step)); i++) g = Math.max(g, Math.abs(deck[i] - deck[i - 1]) / RAIL.step);
      return g;
    };
    let bA = level.blend;
    let bB = level.blend;
    apply(bA, bB);
    while (bA < RAIL.levelBlendMax && steepest(curve.levelA - bA, curve.levelA) > RAIL.levelGrade) {
      bA += RAIL.blendStep;
      apply(bA, bB);
    }
    while (bB < RAIL.levelBlendMax && steepest(curve.levelB, curve.levelB + bB) > RAIL.levelGrade) {
      bB += RAIL.blendStep;
      apply(bA, bB);
    }
    curve.blendA = bA;
    curve.blendB = bB;
  }
  return curve;
}
