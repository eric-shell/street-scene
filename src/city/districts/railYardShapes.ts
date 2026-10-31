/**
 * The rail yard's terrain shapes, each a height modifier with an exact analytic gradient that is zero on and beyond
 * its bounding box (tests/railYard.test.ts compares the numeric slope with the gradient):
 *
 *  - a wedge (`WedgeSpec`): an eased grade up to a crest, a flat top, a smooth fall behind it, tapered across its
 *    width. The hump is one (a 3 m crest, a 12% run-up whose foot is eased like the channel table's, a short top and
 *    a 12 m fall into the classification bowl: a car at speed leaves the crest climbing at 12% and flies the fall), the
 *    kicker another (a 1.9 m lip at 28% and a drop behind it, the ballast heap under steel plates);
 *  - the dock: the loading platform, `height` up, a ramp at each end (10%, the same eased foot), a hard edge on its
 *    face (a smoothstep over `ease`, the channel ledge's bevel) and a fall behind its back into the freight house,
 *    where nothing drives. The face is a solid wall (railYard.ts) with Wall.top set once the terrain exists
 *    (settleRailYard), so only a car up on the platform drops off it;
 *  - the turnaround's banked corners: banking.ts arcs.
 *
 * A wedge in its own frame (a along the heading from the foot, b across): h = rise * P(a) * W(b), so dh/da = rise P' W
 * and dh/db = rise P W', turned into world x/z by the heading. Pure.
 */
import { CITY } from '../config';
import type { HeightMod, HeightSample } from './types';
import { smooth01, type Smooth } from './geom';
import { rectPoint, rectU, rectV } from './railYardFrame';
import type { YardRect } from './railYardFrame';

const C = CITY.districts.railYard;

const S1: Smooth = { v: 0, d: 0 };
const S2: Smooth = { v: 0, d: 0 };

/**
 * The slope's share of the height at w (0 at the foot, 1 at the crest) and its derivative in w: a quadratic over the
 * first `ease` of the run, then straight (the channel table's `crest`), so the peak grade is rise / run / (1 - ease / 2).
 */
export function crest(w: number, ease: number, out: Smooth): Smooth {
  const s = 1 / (1 - ease / 2);
  if (w <= 0) {
    out.v = 0;
    out.d = 0;
  } else if (w >= 1) {
    out.v = 1;
    out.d = 0;
  } else if (w < ease) {
    out.v = (s * w * w) / (2 * ease);
    out.d = (s * w) / ease;
  } else {
    out.v = s * (w - ease / 2);
    out.d = s;
  }
  return out;
}

/** Run (m) that climbs `rise` with a peak grade `grade` when its first `ease` share is eased (crest). */
export const runFor = (rise: number, grade: number, ease: number): number => rise / grade / (1 - ease / 2);

/** An eased grade up to a crest, a flat top and a smooth fall, tapered across. All lengths in m. */
export interface WedgeSpec {
  /** The foot's middle (world) and the unit heading up the grade. */
  fx: number;
  fz: number;
  hx: number;
  hz: number;
  /** Length of the grade, the crest's height over the ground, the eased share of the grade. */
  run: number;
  rise: number;
  ease: number;
  /** Flat top past the grade, then the fall back to the ground. */
  top: number;
  fall: number;
  /** Half width at full height, then the taper to nothing either side. */
  half: number;
  edge: number;
}

/** The wedge's whole length along its heading (m). */
export const wedgeLength = (w: WedgeSpec): number => w.run + w.top + w.fall;

/** World point at (a along, b across) of a wedge. */
export const wedgePoint = (w: WedgeSpec, a: number, b: number): { x: number; z: number } => ({ x: w.fx + w.hx * a - w.hz * b, z: w.fz + w.hz * a + w.hx * b });

/** The wedge's height (m) and partials along / across at (a, b). */
export function wedgeProfile(w: WedgeSpec, a: number, b: number, out: { h: number; ha: number; hb: number }): void {
  out.h = 0;
  out.ha = 0;
  out.hb = 0;
  const L = wedgeLength(w);
  const ab = Math.abs(b);
  if (a <= 0 || a >= L || ab >= w.half + w.edge) return;
  let p: number;
  let dp: number;
  if (a < w.run) {
    crest(a / w.run, w.ease, S1);
    p = S1.v;
    dp = S1.d / w.run;
  } else if (a <= w.run + w.top) {
    p = 1;
    dp = 0;
  } else {
    smooth01(w.run + w.top, L, a, S1);
    p = 1 - S1.v;
    dp = -S1.d;
  }
  smooth01(w.half, w.half + w.edge, ab, S2);
  const g = 1 - S2.v;
  const dg = -S2.d * (b < 0 ? -1 : 1);
  out.h = w.rise * p * g;
  out.ha = w.rise * dp * g;
  out.hb = w.rise * p * dg;
}

const WS = { h: 0, ha: 0, hb: 0 };

/** A wedge as a terrain modifier. */
export function wedgeMod(w: WedgeSpec): HeightMod {
  const L = wedgeLength(w);
  const B = w.half + w.edge;
  const corners = [wedgePoint(w, 0, -B), wedgePoint(w, L, -B), wedgePoint(w, L, B), wedgePoint(w, 0, B)];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x: number, z: number, out: HeightSample): void {
      const dx = x - w.fx;
      const dz = z - w.fz;
      const a = dx * w.hx + dz * w.hz;
      const b = -dx * w.hz + dz * w.hx;
      wedgeProfile(w, a, b, WS);
      if (WS.h === 0 && WS.ha === 0 && WS.hb === 0) return;
      out.h += WS.h;
      // a = dx hx + dz hz, b = -dx hz + dz hx: the partials back into x and z.
      out.gx += WS.ha * w.hx - WS.hb * w.hz;
      out.gz += WS.ha * w.hz + WS.hb * w.hx;
    },
  };
}


/** The loading dock: a box in a rectangle frame (u along the platform, v from its face back), with ramps at both u ends. */
export interface DockSpec {
  rect: YardRect;
  /** The ramps' length along u (m). */
  ramp: number;
}

/** The dock as a terrain modifier: the platform from v = 0 (the face, eased over C.dock.ease) to the back (falls over 3 m past D). */
export function dockMod(d: DockSpec): HeightMod {
  const r = d.rect;
  const D = C.dock;
  const u0 = 0;
  const u1 = r.L;
  const v0 = 0;
  const v1 = r.D + 3;
  const corners = [rectPoint(r, u0, v0), rectPoint(r, u1, v0), rectPoint(r, u1, v1), rectPoint(r, u0, v1)];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x: number, z: number, out: HeightSample): void {
      const u = rectU(r, x, z);
      const v = rectV(r, x, z);
      if (u <= u0 || u >= u1 || v <= v0 || v >= v1) return;
      let pv: number;
      let pu: number;
      if (u < d.ramp) {
        crest(u / d.ramp, 0.3, S1);
        pv = S1.v;
        pu = S1.d / d.ramp;
      } else if (u > r.L - d.ramp) {
        crest((r.L - u) / d.ramp, 0.3, S1);
        pv = S1.v;
        pu = -S1.d / d.ramp;
      } else {
        pv = 1;
        pu = 0;
      }
      const e = smooth01(0, D.ease, v, S1);
      const ev = e.v;
      const ed = e.d;
      const f = smooth01(r.D, r.D + 3, v, S2);
      const wv = ev * (1 - f.v);
      const dw = ed * (1 - f.v) - ev * f.d;
      const hu = D.height * pu * wv;
      const hv = D.height * pv * dw;
      out.h += D.height * pv * wv;
      out.gx += hu * r.ux + hv * r.vx;
      out.gz += hu * r.uz + hv * r.vz;
    },
  };
}

/** Length (m) of the dock's ramps for the configured grade. */
export const dockRamp = (): number => runFor(C.dock.height, C.dock.grade, 0.3);
