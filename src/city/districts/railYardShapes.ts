/**
 * The rail yard's terrain shapes, each a height modifier with an exact analytic gradient that is
 * zero on and beyond its bounding box (the tests compare the numeric slope with the gradient):
 *
 *  - the hump: a ridge across every track, `rise` high. Each slope is the channel table's profile
 *    (channelFeatures.ts): a quadratic foot over the first `lip` share of the run, then a straight
 *    grade (12%, so a committed car leaves the flat top at its speed times 0.12 and flies the aisle
 *    gaps beyond), a flat top between. Across the tracks (v) the ridge tapers over `edge` at both sides;
 *  - the dock: the loading platform along the back, `height` up, a ramp at each end (10%, the same
 *    eased foot), a hard edge on its face (a smoothstep over `ease`, the channel ledge's bevel) and a
 *    fall behind the back wall where nothing can drive. The face is a solid wall (railYard.ts) with
 *    Wall.top set after the terrain exists (settleRailYard), so only a car up on the platform drops off it;
 *  - the bank: the turnaround's outer edge, banking.ts.
 *
 * In a block's local frame (u along the street, v into the block), h = H * P(u) * W(v), so
 * dh/du = H P' W and dh/dv = H P W', turned into world x/z by the frame's axes. Pure.
 */
import { CITY } from '../config';
import { atan2 } from '../../sim/math';
import type { HeightMod, HeightSample } from './types';
import { smooth01, type Smooth } from './geom';
import { rectPoint, rectU, rectV } from './railYardFrame';
import type { YardRect } from './railYardFrame';
import { RAMP_EASE, type YardBlock } from './railYardLayout';
import { bankMod } from './banking';
import type { BankedArc } from './banking';

const C = CITY.districts.railYard;

const S1: Smooth = { v: 0, d: 0 };
const S2: Smooth = { v: 0, d: 0 };

/**
 * The slope's share of the height at w (0 at the foot, 1 at the crest) and its derivative in w: a quadratic
 * over the first `lip` of the run, then straight (the channel table's `crest`).
 */
export function crest(w: number, lip: number, out: Smooth): Smooth {
  const s = 1 / (1 - lip / 2);
  if (w <= 0) {
    out.v = 0;
    out.d = 0;
  } else if (w >= 1) {
    out.v = 1;
    out.d = 0;
  } else if (w < lip) {
    out.v = (s * w * w) / (2 * lip);
    out.d = (s * w) / lip;
  } else {
    out.v = s * (w - lip / 2);
    out.d = s;
  }
  return out;
}

/** A modifier over the local box [u0, u1] x [v0, v1] of a rectangle: `shape` writes h, dh/du, dh/dv (into S), zero outside it. */
function localMod(r: YardRect, u0: number, u1: number, v0: number, v1: number, shape: (u: number, v: number, o: { h: number; hu: number; hv: number }) => void): HeightMod {
  const corners = [rectPoint(r, u0, v0), rectPoint(r, u1, v0), rectPoint(r, u1, v1), rectPoint(r, u0, v1)];
  const o = { h: 0, hu: 0, hv: 0 };
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minZ: Math.min(...corners.map((c) => c.z)),
    maxZ: Math.max(...corners.map((c) => c.z)),
    add(x, z, out: HeightSample) {
      const u = rectU(r, x, z);
      const v = rectV(r, x, z);
      if (u <= u0 || u >= u1 || v <= v0 || v >= v1) return;
      o.h = 0;
      o.hu = 0;
      o.hv = 0;
      shape(u, v, o);
      out.h += o.h;
      out.gx += o.hu * r.ux + o.hv * r.vx;
      out.gz += o.hu * r.uz + o.hv * r.vz;
    },
  };
}

/** The ridge across the tracks of a block with a hump, or null. */
export function humpMod(b: YardBlock): HeightMod | null {
  const h = b.hump;
  if (!h) return null;
  const T = C.hump;
  const ext = T.top / 2 + h.run;
  return localMod(b.rect, h.uc - ext, h.uc + ext, h.v0, h.v1, (u, v, o) => {
    const du = u - h.uc;
    const ad = Math.abs(du);
    let pv = 1;
    let pu = 0;
    if (ad > T.top / 2) {
      const k = crest(1 - (ad - T.top / 2) / h.run, T.lip, S1);
      pv = k.v;
      pu = (-k.d / h.run) * (du >= 0 ? 1 : -1);
    }
    const a = smooth01(h.v0, h.v0 + T.edge, v, S1);
    const c = smooth01(h.v1 - T.edge, h.v1, v, S2);
    const w = a.v * (1 - c.v);
    const dw = a.d * (1 - c.v) - a.v * c.d;
    o.h = T.rise * pv * w;
    o.hu = T.rise * pu * w;
    o.hv = T.rise * pv * dw;
  });
}

/** The loading dock of a block with one, or null. */
export function dockMod(b: YardBlock): HeightMod | null {
  const d = b.dock;
  if (!d) return null;
  const D = C.dock;
  const D0 = b.rect.D;
  return localMod(b.rect, d.u0, d.u1, b.dockFace, D0 + 3, (u, v, o) => {
    let pv: number;
    let pu: number;
    if (u < d.u0 + d.ramp) {
      const k = crest((u - d.u0) / d.ramp, RAMP_EASE, S1);
      pv = k.v;
      pu = k.d / d.ramp;
    } else if (u > d.u1 - d.ramp) {
      const k = crest((d.u1 - u) / d.ramp, RAMP_EASE, S1);
      pv = k.v;
      pu = -k.d / d.ramp;
    } else {
      pv = 1;
      pu = 0;
    }
    const e = smooth01(b.dockFace, b.dockFace + D.ease, v, S1);
    const ev = e.v;
    const ed = e.d;
    const f = smooth01(D0, D0 + 3, v, S2);
    const w = ev * (1 - f.v);
    const dw = ed * (1 - f.v) - ev * f.d;
    o.h = D.height * pv * w;
    o.hu = D.height * pu * w;
    o.hv = D.height * pv * dw;
  });
}

/** The banked arc of a block's turnaround: a half circle round the end of the tracks, or null. */
export function bankArc(b: YardBlock): BankedArc | null {
  const l = b.loop;
  if (!l) return null;
  const B = C.bank;
  const c = rectPoint(b.rect, l.cu, l.vmid);
  return {
    cx: c.x,
    cz: c.z,
    rOut: l.R - B.hold / 2,
    rise: B.rise,
    hold: B.hold,
    fall: B.fall,
    height: B.height,
    mid: atan2(b.rect.uz, b.rect.ux),
    half: Math.PI / 2,
    taper: (B.taper * Math.PI) / 180,
  };
}

/** Every height modifier of a block, in a fixed order. */
export function blockMods(b: YardBlock): HeightMod[] {
  const out: HeightMod[] = [];
  const hump = humpMod(b);
  if (hump) out.push(hump);
  const dock = dockMod(b);
  if (dock) out.push(dock);
  const arc = bankArc(b);
  if (arc) out.push(bankMod(arc));
  return out;
}
