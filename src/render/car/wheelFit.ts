/**
 * Wheel size without changing the tire's outer diameter. Pure math on vertex
 * arrays in wheel space (center at the origin, axle along X), no three.js.
 *
 * Every vertex is remapped radially (distance from the axle) by one
 * continuous, monotonic function:
 *  - inside the bead (where the tire meets the wheel) everything scales by the
 *    wheel's size factor, so spokes, barrel, lip and caps grow together;
 *  - between the bead and the tread the sidewall is squeezed (or stretched)
 *    so the outer radius stays exactly where it was.
 * The axial (X) coordinate only changes for the width control, and only behind
 * the spokes: the face, lip and everything from the outer face back to the
 * spokes' back keep their exact shape, the barrel behind them grows (or
 * shortens) along the axle, and the tire's inner side follows the barrel's
 * back edge, so the barrel never pokes out of the tire.
 */

export interface WheelProfile {
  /** Tread radius (outer diameter / 2). */
  outer: number;
  /** Radius where the tire meets the wheel. */
  bead: number;
}

/**
 * Where a wheel's width change acts, in wheel space (X along the axle, +X outboard). Measured once per
 * baked wheel from the original vertices.
 */
export interface WidthFit {
  /** X of the spokes' back: everything behind it is barrel and stretches with the width. */
  spokeBack: number;
  /** X of the wheel's rearmost non-tire vertex (the barrel's back edge). */
  back: number;
  /** X range of the tire's vertices. */
  tireMin: number;
  tireMax: number;
  /**
   * How far (<= 0, along X) the tire's back bead must move at stock width so the tire covers the barrel (see
   * `tirePull`); the width's own shift comes on top. 0 when the tire already covers it or has no bead to move.
   */
  tirePull: number;
  /**
   * Least stretch the barrel behind the spokes needs so its back reaches past the brake unit (1 = none; see
   * `barrelCover`). Set by the car view whenever the wheel size changes, since the brake scales with the bead.
   */
  cover: number;
  /** Where the face sits along the axle (`detectFaceFit`), for the offset shift. */
  face: FaceFit;
  /**
   * The face's move along X (m, + outboard, 0 on a one-piece or without a target): the car's offset target for
   * the axle less the wheel's stock offset, clamped to `faceRange`. Applied before the width, so the spokes' back
   * the width and the brake work from is `spokeBack + shift`.
   */
  shift: number;
}

/** The spokes' back once the face has moved: what the width stretch and the brake's placing measure from. */
export const spokeBackOf = (fit: WidthFit): number => fit.spokeBack + fit.shift;

/**
 * Where a multi-piece wheel's face sits along the axle, in wheel space (X along the axle, +X outboard, the tire's
 * centerline at 0), measured once per baked wheel from the original vertices. The face is everything that is not
 * tire or lip ring (spokes, hub, cap, hardware); the ring is the lathed lip and barrel (`RimLip`). A per-car offset
 * target moves the face as one piece between the barrel's back and the lip's edge bulb (`faceShift`).
 */
export interface FaceFit {
  /** X of the face's back: the hub's or the flange's rearmost point. */
  back: number;
  /** X of the face's front: the spokes' or the flange's foremost point. */
  front: number;
  /** X of the lip's edge, the frontmost ring vertex. */
  lipEdge: number;
  /** X of the barrel's back, the rearmost ring vertex. */
  barrelBack: number;
}

/** Limits of a face shift, m at the house scale (a 0.28 m tire). */
export const FACE_FIT = {
  /** Width of the lip's edge bulb, which keeps its shape whatever the face does (docs/carWheels.md, Tires: every shipped lip is a 1.7 cm bulb). */
  bulb: 0.017,
  /** The least lip cone left between the face's front and the bulb when the face comes out. */
  minLip: 0.01,
  /** The least barrel left behind the face when it goes in (the brake cover stretches it back out past the tire where it must). */
  minBarrel: 0.02,
} as const;

/**
 * The face and ring extents of a wheel from its face vertices (X and radius) and its ring vertices' X, with the
 * bead radius. The face's back is the spoke zone's (0.3 to 0.75 of the bead, as `WidthFit.spokeBack`: the center
 * bore runs deeper and stretches with the barrel, inside the brake hat anyway); its front is read inside 0.8 of
 * the bead, so a sliver of ring left in the face's material (a shard at the lip radius) does not count as face.
 */
export function detectFaceFit(faceX: ArrayLike<number>, faceR: ArrayLike<number>, ringX: ArrayLike<number>, bead: number): FaceFit {
  let back = Infinity, front = -Infinity, lipEdge = -Infinity, barrelBack = Infinity;
  for (let i = 0; i < faceX.length; i++) {
    const r = faceR[i] / bead;
    if (r > 0.3 && r < 0.75) back = Math.min(back, faceX[i]);
    if (r < 0.8) front = Math.max(front, faceX[i]);
  }
  for (let i = 0; i < ringX.length; i++) (barrelBack = Math.min(barrelBack, ringX[i])), (lipEdge = Math.max(lipEdge, ringX[i]));
  if (!Number.isFinite(back) || !Number.isFinite(front) || !Number.isFinite(lipEdge)) return { back: 0, front: 0, lipEdge: 0, barrelBack: 0 };
  return { back, front, lipEdge, barrelBack };
}

/** Where the lip's edge bulb begins: a face that stands proud of it (a dome) leaves no lip cone at all. */
const bulbStart = (f: FaceFit): number => Math.max(f.lipEdge - FACE_FIT.bulb, f.front);

/** How far the face may go in (first, <= 0) and out (second, >= 0), m: the lip cone and the barrel each keep their minimum. */
export function faceRange(f: FaceFit): [number, number] {
  return [Math.min(0, -((f.back - f.barrelBack) - FACE_FIT.minBarrel)), Math.max(0, bulbStart(f) - f.front - FACE_FIT.minLip)];
}

/**
 * The axial map of a face shift `d` (m, + outboard): one piecewise linear function of X. The face's own depth
 * moves rigidly, so wherever it meets the ring (a flange, a sleeve under the dish wall) it still does; the lip
 * cone from the face's front to the edge bulb is squeezed or stretched into what is left (a narrower or wider
 * lip piece, the way a multi-piece wheel is built to an offset), the bulb and the tire stay, and the barrel
 * behind the face takes up the rest back to its unchanged end.
 */
export function faceShift(x: number, f: FaceFit, d: number): number {
  const bulb = bulbStart(f);
  if (d === 0 || x <= f.barrelBack || x >= bulb) return x;
  if (x < f.back) return f.barrelBack + (x - f.barrelBack) * ((f.back + d - f.barrelBack) / (f.back - f.barrelBack || 1));
  if (x <= f.front) return x + d;
  return f.front + d + (x - f.front) * ((bulb - f.front - d) / (bulb - f.front || 1));
}

/** The slope dx'/dx of `faceShift` at x, which the normals' X is divided by. */
export function faceSlope(x: number, f: FaceFit, d: number): number {
  const bulb = bulbStart(f);
  if (d === 0 || x <= f.barrelBack || x >= bulb) return 1;
  if (x < f.back) return (f.back + d - f.barrelBack) / (f.back - f.barrelBack || 1);
  if (x <= f.front) return 1;
  return (bulb - f.front - d) / (bulb - f.front || 1);
}

/** Share of the tire's width, from each side, where its inner side shifts in full (below) and not at all (above the outer one). */
const TIRE_SHIFT_BAND = 0.2;

/** Air kept between the brake's rearmost point and the barrel's back (m). */
export const BARREL_MARGIN = 0.008;

/**
 * The stretch that puts the barrel's back `depth` (m, behind the spokes' back) behind the spokes: 1 when it
 * already reaches that far or has no barrel behind the spokes to stretch.
 */
export function barrelCover(spokeBack: number, back: number, depth: number): number {
  const len = spokeBack - back;
  return len > 1e-4 ? Math.max(1, depth / len) : 1;
}

/**
 * The stretch the barrel gets for a width slider value. The slider acts on the stock barrel and the cover
 * (the brake's minimum) is a floor under it: a shorter width never pulls the back in past the brake, and a
 * longer one adds its share of the stock length on top of the cover, so the slider moves every wheel over its
 * whole range (a wheel that needs 3x covers the brake at 0.85 and 1.0 alike, and 1.35 gives 3.35x).
 */
export function barrelStretch(width: number, cover: number): number {
  return width <= 1 ? Math.max(width, cover) : cover + (width - 1);
}

/**
 * How far the tire's back bead must move back along X (<= 0, wheel space units) so the tire covers the stock
 * barrel: the barrel's back edge (`back`, out where the barrel is) must not stand past the back bead, and no
 * wheel vertex above the bead on the back half (a back flange) may stand outside the back sidewall. The house
 * barrels end at half the tire's width while its bead sits at 0.42 of it (19 mm at the house scale,
 * carWheels.py X_BACK), and a stretched tire's back sidewall leans in over a flange, so most wheels need one.
 * `profile` is the lathed tire's half section, face bead to back bead (x, r); `x`/`r` the wheel's non-tire
 * vertices. A tire of `segments` flat facets sits inside its profile between columns, so a vertex is tested at
 * its radius over cos(pi / segments). Neither the size remap (which keeps radial order above the bead) nor the
 * width (which shifts the tire with the barrel's back) changes the answer, so it is measured once per bake.
 */
export function tirePull(profile: readonly (readonly [number, number])[], x: ArrayLike<number>, r: ArrayLike<number>, back: number, segments: number): number {
  const n = profile.length;
  if (n < 2) return 0;
  const [beadX, beadR] = profile[n - 1];
  let pull = Math.min(0, back - beadX);
  // The back sidewall, from the bead up while its radius rises (the grooves in the crown end it).
  let top = n - 1;
  while (top > 0 && profile[top - 1][1] >= profile[top][1]) top--;
  const topR = profile[top][1];
  const sag = 1 / Math.cos(Math.PI / segments);
  for (let i = 0; i < x.length; i++) {
    if (x[i] >= 0) continue;
    const re = r[i] * sag;
    if (re <= beadR || re > topR) continue;
    // The sidewall's X at this radius.
    let k = n - 1;
    while (k > top && profile[k - 1][1] < re) k--;
    const [x0, r0] = profile[k];
    const [x1, r1] = profile[k - 1];
    const side = x0 + ((x1 - x0) * (re - r0)) / (r1 - r0 || 1);
    pull = Math.min(pull, x[i] - side);
  }
  return pull;
}

/** Largest bead allowed, as a fraction of the outer radius (keeps a visible sliver of sidewall). */
export const MAX_BEAD = 0.93;
/** Size slider range (matches STANCE_LIMITS.wheelSize). */
const SIZE_MIN = 0.85;
const SIZE_MAX = 1.25;

/**
 * Find the bead radius from vertex radii. `tire` are the radii of vertices
 * using the Tire material, `other` everything else (wheel face, chrome, black).
 * IceMaan wheels: the tire's innermost ring in the outer band is the bead.
 * Wheels whose tire is a closed cylinder (tire verts only at the center
 * and the tread, e.g. the code-built placeholder) use the wheel's edge.
 */
export function detectProfile(tire: ArrayLike<number>, other: ArrayLike<number>): WheelProfile {
  let outer = 0;
  for (let i = 0; i < tire.length; i++) outer = Math.max(outer, tire[i]);
  if (outer <= 0) for (let i = 0; i < other.length; i++) outer = Math.max(outer, other[i]);
  if (outer <= 0) return { outer: 1, bead: 0.75 };
  let bead = Infinity;
  for (let i = 0; i < tire.length; i++) {
    const r = tire[i] / outer;
    if (r >= 0.55 && r <= 0.97) bead = Math.min(bead, r);
  }
  if (!Number.isFinite(bead)) {
    bead = 0;
    for (let i = 0; i < other.length; i++) {
      const r = other[i] / outer;
      if (r <= 0.97) bead = Math.max(bead, r);
    }
  }
  bead = Math.max(0.45, Math.min(0.9, bead || 0.75));
  return { outer, bead: bead * outer };
}

/**
 * Bead radius for a wheel size. 1 = stock. Below 1 the wheel shrinks
 * proportionally; above 1 it grows toward MAX_BEAD so 125% is the thinnest
 * believable sidewall on every wheel, whatever its stock profile.
 */
export function beadForSize(p: WheelProfile, size: number): number {
  const s = Math.max(SIZE_MIN, Math.min(SIZE_MAX, size));
  if (s <= 1) return p.bead * s;
  const max = Math.max(p.bead, MAX_BEAD * p.outer);
  return p.bead + (max - p.bead) * ((s - 1) / (SIZE_MAX - 1));
}

/** Inverse of beadForSize: the wheel size that puts the bead at this radius (clamped to the slider range). */
export function sizeForBead(p: WheelProfile, bead: number): number {
  const max = Math.max(p.bead, MAX_BEAD * p.outer);
  const s = bead <= p.bead || max <= p.bead ? bead / p.bead : 1 + ((bead - p.bead) / (max - p.bead)) * (SIZE_MAX - 1);
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, s));
}

/** Remap one radius. Returns [new radius, d(new)/d(old)]. */
export function remapRadius(r: number, p: WheelProfile, bead2: number): [number, number] {
  if (r <= p.bead) {
    const k = bead2 / p.bead;
    return [r * k, k];
  }
  const k = (p.outer - bead2) / Math.max(1e-6, p.outer - p.bead);
  // Anything beyond the tread (none in practice) keeps its offset.
  if (r >= p.outer) return [r, 1];
  return [bead2 + (r - p.bead) * k, k];
}

/**
 * Write remapped positions and normals for a wheel of the given size.
 * `pos`/`nrm` are the original xyz arrays; results go to `outPos`/`outNrm`
 * (may be the same length arrays, not the same objects). Normals follow the
 * inverse transpose of the local Jacobian, so shading stays right on the
 * squeezed sidewall.
 *
 * `width` (with its `fit`) works along X only. A wheel vertex behind the
 * spokes' back moves to spokeBack + (x - spokeBack) * width, so the barrel, a
 * lathed tube, just gets longer or shorter and nothing in front of that plane
 * changes. The tire (`tire` true) follows the barrel's back edge: its inner
 * side (the lowest share of its width) shifts as a whole by as much as the
 * barrel's back moved plus the stock pull (`fit.tirePull`) that covers it,
 * its outer side stays put, and the tread between is stretched to stay one
 * continuous surface. Normals' X is divided by the local dx'/dx (1 for the
 * parts that only shift).
 *
 * The offset shift (`fit.shift`, `faceShift`) comes first on every non-tire
 * vertex, moving the face as one piece between the barrel's back and the lip's
 * bulb; `rigid` parts (the house lug nuts) move with it whole. The width then
 * measures from the moved spokes' back.
 */
export function remapWheel(pos: ArrayLike<number>, nrm: ArrayLike<number> | null, outPos: Float32Array, outNrm: Float32Array | null, p: WheelProfile, size: number, width = 1, fit: WidthFit | null = null, tire = false, rigid = false): void {
  const bead2 = beadForSize(p, size);
  // The barrel's stretch: the width slider, floored by what covers the brake (fit.cover).
  if (fit !== null) width = barrelStretch(width, fit.cover);
  const spokeBack = fit !== null ? spokeBackOf(fit) : 0;
  const d = fit !== null && !tire ? fit.shift : 0;
  // The tire's inner side moves as far as the barrel's back edge does, plus the pull that covers the stock barrel.
  const shift = fit !== null ? (fit.back - spokeBack) * (width - 1) + fit.tirePull : 0;
  const axial = fit !== null && (width !== 1 || shift !== 0);
  const tireSpan = axial ? fit.tireMax - fit.tireMin : 0;
  const lo = axial ? fit.tireMin + TIRE_SHIFT_BAND * tireSpan : 0;
  const hi = axial ? fit.tireMax - TIRE_SHIFT_BAND * tireSpan : 0;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    const r = Math.hypot(y, z);
    const [r2, dr] = remapRadius(r, p, bead2);
    const t = r > 1e-9 ? r2 / r : bead2 / p.bead;
    // New X and its slope dx'/dx: the face's move, then the width behind the moved spokes.
    let x2 = x;
    let sx = 1;
    if (d !== 0) {
      x2 = rigid ? x + d : faceShift(x, fit!.face, d);
      sx = rigid ? 1 : faceSlope(x, fit!.face, d);
    }
    if (axial) {
      if (!tire) {
        if (x2 < spokeBack) {
          x2 = spokeBack + (x2 - spokeBack) * width;
          sx *= width;
        }
      } else if (x <= lo) x2 = x + shift;
      else if (x < hi) {
        const u = (x - lo) / (hi - lo);
        x2 = x + shift * (1 - u);
        sx = 1 - shift / (hi - lo);
      }
    }
    outPos[i] = x2;
    outPos[i + 1] = y * t;
    outPos[i + 2] = z * t;
    if (!nrm || !outNrm) continue;
    const nx = nrm[i] / sx;
    let ny = nrm[i + 1];
    let nz = nrm[i + 2];
    if (r > 1e-9) {
      // Split into radial and tangential parts, scale each by the inverse stretch.
      const uy = y / r;
      const uz = z / r;
      const nr = ny * uy + nz * uz;
      const ty = ny - nr * uy;
      const tz = nz - nr * uz;
      const a = nr / dr;
      ny = a * uy + ty / t;
      nz = a * uz + tz / t;
    } else {
      ny /= t;
      nz /= t;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    outNrm[i] = nx / len;
    outNrm[i + 1] = ny / len;
    outNrm[i + 2] = nz / len;
  }
}
