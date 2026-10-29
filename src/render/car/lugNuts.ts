/**
 * The house lug nuts: every wheel wears the same closed-end tuner nut, drawn by the game instead of the donor
 * models' own (which the Blender wheel set strips). `lugNutGeometry` builds one nut along +X with its base at
 * x = 0 (a conical washer that covers the hole, a hex body with a flat shaded chamfer, a smooth rounded end, about
 * 60 triangles); `lugsGeometry` places `count` of them on a wheel's lug circle (the catalog's `lugs`, in the wheel
 * GLB's space) as one BufferGeometry, so a wheel pays one extra draw call per axle model. The nut's hex scales
 * with the seat but is clamped to read as a nut, and never overhangs the washer. The nut's vertex data is cached
 * by seat size (CPU only); each call hands back a fresh geometry, since the car view remaps and disposes its own.
 */
import * as THREE from 'three';
import type { WheelLugs } from '../../shared/parts';

/** The nut's proportions at the reference scale (16 mm across flats, a 17 mm-class nut at game scale). */
export const LUG = {
  /** Hex across flats at the reference scale, m. */
  flats: 0.016,
  /** Hex across flats as a multiple of the seat radius, before the clamp. */
  flatsPerSeat: 1.5,
  /** Smallest and largest hex across flats, m. */
  flatsMin: 0.012,
  flatsMax: 0.018,
  /** Stack heights at the reference scale, m: washer, hex, chamfer, dome (together about 17 mm). */
  washer: 0.0025,
  body: 0.009,
  chamfer: 0.0017,
  dome: 0.0034,
  /** The washer's top radius as a multiple of the hex corner radius (at most the seat radius). */
  washerTop: 1.06,
  /** The chamfer's top radius as a multiple of the hex apothem. */
  chamferTop: 0.74,
  /** Segments round the washer. */
  washerSegments: 10,
  /** Where the dome's middle ring sits, rad along its quarter ellipse. */
  domeRing: 0.75,
} as const;

/** One nut's flat vertex data, positions and normals (x,y,z triples; three per triangle). */
interface NutData {
  position: Float32Array;
  normal: Float32Array;
}

const nutCache = new Map<string, NutData>();

/** The nut along +X for a seat radius (m), built once per size. */
function nutData(size: number): NutData {
  const key = size.toFixed(5);
  const hit = nutCache.get(key);
  if (hit) return hit;
  const pos: number[] = [];
  const nrm: number[] = [];
  const tri = (a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[]): void => {
    pos.push(...a, ...b, ...c);
    nrm.push(...na, ...nb, ...nc);
  };
  const unit = (x: number, r: number, a: number): number[] => {
    const l = Math.hypot(x, r) || 1;
    return [x / l, (r / l) * Math.cos(a), (r / l) * Math.sin(a)];
  };
  const at = (x: number, r: number, a: number): number[] => [x, r * Math.cos(a), r * Math.sin(a)];

  // Across flats: about 1.5 x the seat, clamped, and never wider across the corners than the seat (the washer base is the catalog size; its top never exceeds it).
  const flats = Math.min(Math.max(LUG.flatsPerSeat * size, LUG.flatsMin), LUG.flatsMax, size * Math.sqrt(3));
  const s = flats / LUG.flats;
  const apothem = flats / 2;
  const corner = apothem / Math.cos(Math.PI / 6);
  const x1 = LUG.washer * s;
  const x2 = x1 + LUG.body * s;
  const x3 = x2 + LUG.chamfer * s;
  const dh = LUG.dome * s;
  const topR = apothem * LUG.chamferTop;

  // Washer: a cone from the seat circle up to just past the hex corners, smooth shaded.
  const wTop = Math.min(size, corner * LUG.washerTop);
  const slope = (size - wTop) / x1;
  const n = LUG.washerSegments;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const n0 = unit(slope, 1, a0);
    const n1 = unit(slope, 1, a1);
    tri(at(0, size, a0), at(0, size, a1), at(x1, wTop, a0), n0, n1, n0);
    tri(at(0, size, a1), at(x1, wTop, a1), at(x1, wTop, a0), n1, n1, n0);
  }
  // Hex corners sit at 0, 60, ... degrees; sides and chamfer are flat shaded per face.
  const rise = (corner - topR) / (x3 - x2);
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const side = [0, Math.cos(am), Math.sin(am)];
    tri(at(x1, corner, a0), at(x1, corner, a1), at(x2, corner, a0), side, side, side);
    tri(at(x1, corner, a1), at(x2, corner, a1), at(x2, corner, a0), side, side, side);
    // Chamfer: a six sided frustum from the hex corners in to the dome's base ring.
    const cn = unit(rise, 1, am);
    tri(at(x2, corner, a0), at(x2, corner, a1), at(x3, topR, a0), cn, cn, cn);
    tri(at(x2, corner, a1), at(x3, topR, a1), at(x3, topR, a0), cn, cn, cn);
    // Dome: a quarter ellipse, ring then apex, smooth normals from the ellipse's gradient.
    const t1 = LUG.domeRing;
    const ring = (t: number, a: number): { p: number[]; n: number[] } => ({
      p: at(x3 + dh * Math.sin(t), topR * Math.cos(t), a),
      n: unit(Math.sin(t) / dh, Math.cos(t) / topR, a),
    });
    const b0 = ring(0, a0);
    const b1 = ring(0, a1);
    const m0 = ring(t1, a0);
    const m1 = ring(t1, a1);
    const apex = ring(Math.PI / 2, am);
    tri(b0.p, b1.p, m0.p, b0.n, b1.n, m0.n);
    tri(b1.p, m1.p, m0.p, b1.n, m1.n, m0.n);
    tri(m0.p, m1.p, apex.p, m0.n, m1.n, apex.n);
  }
  const data = { position: new Float32Array(pos), normal: new Float32Array(nrm) };
  nutCache.set(key, data);
  return data;
}

/** One house lug nut along +X, base at x = 0, for a seat radius in meters. */
export function lugNutGeometry(size: number): THREE.BufferGeometry {
  const d = nutData(size);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(d.position), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(d.normal), 3));
  return g;
}

/** Triangles in one nut (the budget check, and the cost line of the report). */
export function lugNutTris(size: number): number {
  return nutData(size).position.length / 9;
}

/**
 * Every nut of a wheel's lug circle as one geometry in the wheel GLB's space: nut k at angle phase + 2πk/count
 * about X, at radius r, its base on the seat at x, turned with the circle so every hex faces alike. A fresh
 * geometry each call; the caller owns it.
 */
export function lugsGeometry(lugs: WheelLugs): THREE.BufferGeometry {
  const d = nutData(lugs.size);
  const per = d.position.length;
  const count = Math.max(1, Math.round(lugs.count));
  const position = new Float32Array(per * count);
  const normal = new Float32Array(per * count);
  for (let k = 0; k < count; k++) {
    const a = lugs.phase + (k / count) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const cy = lugs.r * c;
    const cz = lugs.r * s;
    const o = k * per;
    for (let i = 0; i < per; i += 3) {
      const y = d.position[i + 1];
      const z = d.position[i + 2];
      position[o + i] = d.position[i] + lugs.x;
      position[o + i + 1] = y * c - z * s + cy;
      position[o + i + 2] = y * s + z * c + cz;
      const ny = d.normal[i + 1];
      const nz = d.normal[i + 2];
      normal[o + i] = d.normal[i];
      normal[o + i + 1] = ny * c - nz * s;
      normal[o + i + 2] = ny * s + nz * c;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return g;
}
