/**
 * Tire shapes, lathed at runtime in place of the tire every wheel ships with (docs/carWheels.md) so any
 * wheel can wear any of them and all of them share one UV layout (the tread texture, tireTread.ts): the
 * standard tire (the house tire's own profile), a mild stretch and a full one; more shapes are another
 * profile in the table. Pure math on vertex arrays in wheel space (center at the origin, axle along X), no
 * three.js.
 *
 * A shape is a half profile in units of the tire it replaces: x is the distance from the tire's center
 * plane over the stock bead's (where the house tire meets the wheel's lip), v the height from the bead (0)
 * to the tread (1). The outer radius never changes, so the sim's wheel radius and the wheel size slider
 * (wheelFit.ts) work the same on every shape. The profile has two runs: the `side`, from the face side's
 * bead up to the tread's shoulder, and the `tread`, from the shoulder in to where the crown goes flat. The
 * crown carries two circumferential grooves (`TREAD`), real geometry dipping a few millimetres in, placed
 * along the tread's arc length so every shape gets the same layout.
 *
 * A stretched tire seats its face bead inboard of the stock one (`side[0]`'s x under 1), so the wheel's
 * lip stands proud of the rubber and shows as a band of metal past the sidewall from straight ahead or
 * behind, the way a stretched tire wears a wheel. Every shipped wheel's lip is a rounded bulb 1.7 cm wide
 * whose top sits 1 cm inboard of the stock bead and whose dish drops away a further 1.5 cm behind it
 * (measured over public/parts, 2026-10-28), so a bead up to 2 cm in still hides behind the bulb from the
 * front, and it dips a hair under the bead radius (v below 0) to sit in the metal rather than on it. The
 * profile starts with a bead band under the bulb's top (from 0.96 to the seat, the rubber a real bead
 * leaves on the seat): the lip ring is only the bulb's visible shell, so without it the far side of the
 * ring was see-through where its inside showed. The back bead stays where the stock one is whatever the
 * shape: the barrel behind the spokes must stay covered (wheelFit.tirePull), and nothing of the back shows.
 *
 * UVs: u runs once around the tire (the seam column is duplicated), v across the profile in three bands
 * (`TREAD.band`): the face side's sidewall, the tread, and a plain strip the back sidewall is pinned to,
 * so the texture spends its pixels where the lettering and the cuts are. The mapping is fixed to the
 * geometry, so a spinning tire carries its pattern.
 */
import type { TireShape } from '../../shared/carBuild';

interface ProfileDef {
  /** The sidewall, bead to the point before the tread starts (x, v). */
  side: readonly (readonly [x: number, v: number])[];
  /** The tread, from the outer shoulder to where the crown goes flat (x, v); the last point has v = 1. */
  tread: readonly (readonly [x: number, v: number])[];
}

/**
 * Each shape's half profile, from the face side's bead to the end of the crown's flat. For reference the
 * standard tire is the house tire (scripts/blender/carWheels.py house_tire): a sidewall bulging out to 1.24
 * and a tread flat from 0.71.
 */
const PROFILES: Record<TireShape, ProfileDef> = {
  standard: { side: [[1, 0], [1.19, 0.242], [1.238, 0.573], [1.167, 0.763]], tread: [[1, 0.963], [0.714, 1]] },
  // Pulled a little tight: the bead in the lip's bulb so its edge shows, the bulge gone, the shoulder tucked in,
  // the tread a touch narrower.
  mild: { side: [[0.96, -0.03], [0.93, -0.03], [0.95, 0.25], [0.9, 0.6], [0.8, 0.86]], tread: [[0.72, 0.97], [0.56, 1]] },
  // Pulled tight over a wide wheel: the bead at the back of the lip's bulb, a straight, steep sidewall leaning in
  // to a narrow tread, the lip standing a modest band proud of the rubber.
  stretched: { side: [[0.96, -0.03], [0.85, -0.03], [0.66, 0.7]], tread: [[0.56, 0.92], [0.5, 0.99], [0.38, 1]] },
};

/**
 * The tread's layout, shared with the texture (tireTread.ts). `t` runs across the tread from the face
 * side's shoulder (0) to the back shoulder (1) by arc length, so one texture fits every shape.
 */
export const TREAD = {
  /** Pitches of the tread pattern around the tire (the texture repeats this many times across its width). */
  pitches: 32,
  /** The texture's v bands: the face sidewall is 0 to `sidewall`, the tread `sidewall` to `tread`, and the plain strip past it. */
  band: { sidewall: 0.42, tread: 0.88, plain: 0.94 },
  /**
   * The circumferential grooves: centre and half width as a share of the tread's arc, depth (m). The wide one
   * sits toward the back (inner) shoulder, the narrow one toward the face side.
   */
  grooves: [
    { at: 0.4, half: 0.017, depth: 0.004 },
    { at: 0.68, half: 0.032, depth: 0.006 },
  ],
} as const;

/** Segments around the tire, as the house tire's (scripts/blender/carWheels.py TIRE_SEG). */
export const TIRE_SEGMENTS = 40;
const SEGMENTS = TIRE_SEGMENTS;

/** The tire a shape replaces, measured from its vertices (wheel space units). */
export interface TireFit {
  /** Radius of the bead, the tire's innermost ring. */
  inner: number;
  /** Tread radius. */
  outer: number;
  /** Distance of the bead from the tire's center plane. */
  beadX: number;
}

/**
 * Measure a tire mesh (xyz positions). Null when it has no sidewall to shape
 * (the placeholder wheel's open cylinder).
 */
export function measureTire(pos: ArrayLike<number>): TireFit | null {
  let inner = Infinity;
  let outer = 0;
  for (let i = 0; i < pos.length; i += 3) {
    const r = Math.hypot(pos[i + 1], pos[i + 2]);
    inner = Math.min(inner, r);
    outer = Math.max(outer, r);
  }
  if (!(outer > 0) || outer - inner < 0.1 * outer) return null;
  let beadX = 0;
  const near = inner + 0.05 * (outer - inner);
  for (let i = 0; i < pos.length; i += 3) if (Math.hypot(pos[i + 1], pos[i + 2]) <= near) beadX = Math.max(beadX, Math.abs(pos[i]));
  return beadX > 0 ? { inner, outer, beadX } : null;
}

/** One point of the full profile: where it is (x along the axle, r from it, m) and where it samples the texture (v). */
interface ProfilePoint {
  x: number;
  r: number;
  v: number;
}

/** The full bead to bead profile of a shape on a tire of this fit: sidewall, grooved tread, back sidewall. */
function fullProfile(shape: TireShape, fit: TireFit): ProfilePoint[] {
  const def = PROFILES[shape];
  const h = fit.outer - fit.inner;
  const at = ([x, v]: readonly [number, number]): [number, number] => [x * fit.beadX, fit.inner + v * h];
  const side = def.side.map(at);
  const half = def.tread.map(at);
  // The tread run, face side shoulder to back side shoulder, with its arc length.
  const run: [number, number][] = [...half, ...[...half].reverse().map(([x, r]): [number, number] => [-x, r])];
  const arc = [0];
  for (let k = 1; k < run.length; k++) arc.push(arc[k - 1] + Math.hypot(run[k][0] - run[k - 1][0], run[k][1] - run[k - 1][1]));
  const total = arc[arc.length - 1];
  const along = (s: number): [number, number] => {
    let k = 1;
    while (k < arc.length - 1 && arc[k] < s) k++;
    const f = (s - arc[k - 1]) / ((arc[k] - arc[k - 1]) || 1);
    return [run[k - 1][0] + (run[k][0] - run[k - 1][0]) * f, run[k - 1][1] + (run[k][1] - run[k - 1][1]) * f];
  };
  // The tread's points by position along it (t), the grooves' walls replacing whatever run points they cover.
  const tread: { t: number; x: number; r: number }[] = [];
  for (let k = 0; k < run.length; k++) {
    const t = arc[k] / total;
    if (TREAD.grooves.some((g) => t > g.at - g.half - 1e-6 && t < g.at + g.half + 1e-6)) continue;
    tread.push({ t, x: run[k][0], r: run[k][1] });
  }
  for (const g of TREAD.grooves) {
    // Edge, wall foot, wall foot, edge: a trapezoid dipping radially.
    for (const [f, dip] of [[-1, 0], [-0.7, g.depth], [0.7, g.depth], [1, 0]] as const) {
      const t = g.at + f * g.half;
      const [x, r] = along(t * total);
      tread.push({ t, x, r: r - dip });
    }
  }
  tread.sort((a, b) => a.t - b.t);
  // The sidewall's arc length from the bead to the shoulder spreads the face sidewall band.
  const sideArc = [0];
  const shoulder = half[0];
  const sidePts = [...side, shoulder];
  for (let k = 1; k < sidePts.length; k++) sideArc.push(sideArc[k - 1] + Math.hypot(sidePts[k][0] - sidePts[k - 1][0], sidePts[k][1] - sidePts[k - 1][1]));
  const out: ProfilePoint[] = side.map(([x, r], k) => ({ x, r, v: (TREAD.band.sidewall * sideArc[k]) / sideArc[sideArc.length - 1] }));
  for (const p of tread) out.push({ x: p.x, r: p.r, v: TREAD.band.sidewall + p.t * (TREAD.band.tread - TREAD.band.sidewall) });
  // The back sidewall is plain rubber, pinned to the plain strip; its bead is the stock one's whatever the face's.
  for (let k = side.length - 1; k >= 0; k--) out.push({ x: k === 0 ? -fit.beadX : -side[k][0], r: side[k][1], v: TREAD.band.plain });
  return out;
}

/**
 * Lathe a tire of the given shape to fit where the old one sat: smooth normals from the profile, faces
 * wound outward, UVs as the module header says. 41 x 20 vertices (the seam column twice), 1,520 triangles
 * (the house tire has 960, grooves not included). `profile` is the lathed half section, face bead to back bead
 * as (x, r) pairs, for the car view's fit of the tire's back to the barrel (wheelFit.tirePull).
 */
export function latheTire(shape: TireShape, fit: TireFit): { position: Float32Array; normal: Float32Array; uv: Float32Array; index: Uint16Array; profile: [x: number, r: number][] } {
  const prof = fullProfile(shape, fit);
  const P = prof.length;
  // Each point's normal in the profile plane: its tangent (central difference) turned outward.
  const n2 = prof.map((_, k) => {
    const a = prof[Math.max(0, k - 1)];
    const b = prof[Math.min(P - 1, k + 1)];
    const tx = b.x - a.x;
    const tr = b.r - a.r;
    const len = Math.hypot(tx, tr) || 1;
    return [tr / len, -tx / len];
  });
  const cols = SEGMENTS + 1;
  const position = new Float32Array(cols * P * 3);
  const normal = new Float32Array(cols * P * 3);
  const uv = new Float32Array(cols * P * 2);
  for (let i = 0; i < cols; i++) {
    const t = (2 * Math.PI * i) / SEGMENTS;
    const c = Math.cos(t);
    const s = Math.sin(t);
    // u runs the way the face side's text reads (clockwise seen from outside, tops outward).
    const u = 1 - i / SEGMENTS;
    for (let k = 0; k < P; k++) {
      const n = i * P + k;
      const o = n * 3;
      position[o] = prof[k].x;
      position[o + 1] = prof[k].r * c;
      position[o + 2] = prof[k].r * s;
      normal[o] = n2[k][0];
      normal[o + 1] = n2[k][1] * c;
      normal[o + 2] = n2[k][1] * s;
      uv[n * 2] = u;
      uv[n * 2 + 1] = prof[k].v;
    }
  }
  // Wound so every face points out of the tire (the tread's +r, the sidewalls' ±x).
  const index = new Uint16Array(SEGMENTS * (P - 1) * 6);
  let n = 0;
  for (let i = 0; i < SEGMENTS; i++) {
    const a0 = i * P;
    const b0 = (i + 1) * P;
    for (let k = 0; k < P - 1; k++) {
      const a = a0 + k;
      const b = a0 + k + 1;
      const c = b0 + k + 1;
      const d = b0 + k;
      index.set([a, b, c, a, c, d], n);
      n += 6;
    }
  }
  return { position, normal, uv, index, profile: prof.map((p): [number, number] => [p.x, p.r]) };
}
