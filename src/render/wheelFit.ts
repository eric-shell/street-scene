/**
 * Rim size without changing the tire's outer diameter. Pure math on vertex
 * arrays in wheel space (center at the origin, axle along X), no three.js.
 *
 * Every vertex is remapped radially (distance from the axle) by one
 * continuous, monotonic function:
 *  - inside the bead (where the tire meets the rim) everything scales by the
 *    rim factor, so spokes, barrel, lip and caps grow together;
 *  - between the bead and the tread the sidewall is squeezed (or stretched)
 *    so the outer radius stays exactly where it was.
 * The axial (X) coordinate never changes, so wheel width and dish stay.
 */

export interface WheelProfile {
  /** Tread radius (outer diameter / 2). */
  outer: number;
  /** Radius where the tire meets the rim. */
  bead: number;
}

/** Largest bead allowed, as a fraction of the outer radius (keeps a visible sliver of sidewall). */
export const MAX_BEAD = 0.93;
/** Size slider range (matches STANCE_LIMITS.wheelSize). */
const SIZE_MIN = 0.85;
const SIZE_MAX = 1.25;

/**
 * Find the bead radius from vertex radii. `tire` are the radii of vertices
 * using the Tire material, `other` everything else (rim, chrome, black).
 * IceMaan wheels: the tire's innermost ring in the outer band is the bead.
 * Wheels whose tire is a closed cylinder (tire verts only at the center
 * and the tread, e.g. Proto RS and the placeholder) use the rim's edge.
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
 * Bead radius for a wheel size. 1 = stock. Below 1 the rim shrinks
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
 */
export function remapWheel(pos: ArrayLike<number>, nrm: ArrayLike<number> | null, outPos: Float32Array, outNrm: Float32Array | null, p: WheelProfile, size: number): void {
  const bead2 = beadForSize(p, size);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    const r = Math.hypot(y, z);
    const [r2, dr] = remapRadius(r, p, bead2);
    const t = r > 1e-9 ? r2 / r : bead2 / p.bead;
    outPos[i] = x;
    outPos[i + 1] = y * t;
    outPos[i + 2] = z * t;
    if (!nrm || !outNrm) continue;
    const nx = nrm[i];
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
