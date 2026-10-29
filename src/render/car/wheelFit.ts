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
 */
export function remapWheel(pos: ArrayLike<number>, nrm: ArrayLike<number> | null, outPos: Float32Array, outNrm: Float32Array | null, p: WheelProfile, size: number, width = 1, fit: WidthFit | null = null, tire = false): void {
  const bead2 = beadForSize(p, size);
  // The barrel's stretch: the width slider, floored by what covers the brake (fit.cover).
  if (fit !== null) width = barrelStretch(width, fit.cover);
  // The tire's inner side moves as far as the barrel's back edge does, plus the pull that covers the stock barrel.
  const shift = fit !== null ? (fit.back - fit.spokeBack) * (width - 1) + fit.tirePull : 0;
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
    // New X and its slope dx'/dx.
    let x2 = x;
    let sx = 1;
    if (axial) {
      if (!tire) {
        if (x < fit.spokeBack) {
          x2 = fit.spokeBack + (x - fit.spokeBack) * width;
          sx = width;
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
