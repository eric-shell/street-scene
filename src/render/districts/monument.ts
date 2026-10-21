/**
 * Monument renderer: the plaza (concrete at sidewalk level with a paving
 * pattern), the step rings and base the sim collides with, and the floodlit
 * landmark on top: an obelisk, a statue column or a triumphal arch. The
 * landmark is drawn unlit and bright (kit.glow) with a wash that fades up
 * from the floods at its foot, so it blooms and reads from across the city
 * without a single real light; the dark stone (steps, base, the piers' lower
 * courses) is lit normally. Flags on poles stand on the base, pavement
 * lights ring it, and the floods themselves are small bright pads. The
 * paving pattern (rings and radials), the flower beds' mulch and edging and
 * the border band stop short of the plaza's edge, never on the sidewalk or
 * the road. All of it merges into the district kit, so the monument costs no
 * extra draw call.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { circlePolygon, distToPolygonEdge, pointInPolygon } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { GeoBuilder } from '../geoBuilder';
import type { DistrictKit } from './kit';
import { col, cylinder, drapeConvex, groundLine, prism } from './kit';
import type { DistrictRenderer } from './kit';

const MONUMENT = {
  /** Step rings (outer first): height above the plaza (m) and radius as a fraction of the step band. */
  steps: [
    { h: 0.4, r: 1 },
    { h: 0.8, r: 0.5 },
  ],
  /** Base block height (m). */
  baseH: 3,
  /** Flood wash: HDR brightness at the foot and at the top of the landmark (the glow material adds x1.6). */
  foot: 0.7,
  top: 0.26,
  /** Pavement lights and flood pads: radius (m) and brightness. */
  lampR: 0.32,
  lampGlow: 1,
  floodR: 0.5,
  floodGlow: 1.4,
  /** Flag poles: height (m), count scaled by the plan's `flags`. */
  flagH: 6.5,
  /** Paving pattern: ring spacing (m), radial pieces (m) and how far in from the plaza edge it stops (m). */
  ringStep: 9,
  radialPiece: 3,
  pavingInset: 1.2,
  /** Border band just inside the plaza edge: inset and width (m). */
  borderInset: 0.7,
  borderWidth: 0.4,
} as const;

const STONE = col(0x4a4b53);
const STONE_TOP = col(0x5a5b64);
const DARK = col(0x2c2d33);
const WARM = new THREE.Color(1, 0.86, 0.66);
const FLAGS = [0xffd27a, 0xff4a4a, 0xf2f2f2, 0x5aa0ff, 0x7cff9a].map((c) => col(c, 0.55));

/** Vertical prism in the glow builder with a brightness that fades from y0 to y1 (the flood wash). */
function washPrism(gb: GeoBuilder, poly: Vec2[], y0: number, y1: number, g0: number, g1: number): void {
  const c0 = WARM.clone().multiplyScalar(g0);
  const c1 = WARM.clone().multiplyScalar(g1);
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / poly.length;
    cz += p.z / poly.length;
  }
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    let nx = q.z - p.z;
    let nz = -(q.x - p.x);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((p.x + q.x) / 2 - cx) * nx + ((p.z + q.z) / 2 - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const a = gb.vertex(p.x, y0, p.z, nx, 0, nz, 0, 0, c0);
    const b = gb.vertex(q.x, y0, q.z, nx, 0, nz, 1, 0, c0);
    const c = gb.vertex(q.x, y1, q.z, nx, 0, nz, 1, 1, c1);
    const d = gb.vertex(p.x, y1, p.z, nx, 0, nz, 0, 1, c1);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  }
  const top = poly.map((p) => gb.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, c1));
  const center = gb.vertex(cx, y1, cz, 0, 1, 0, 0, 0, c1);
  for (let i = 0; i < top.length; i++) gb.triFacing(center, top[i], top[(i + 1) % top.length], 0, 1, 0);
}

/** Tapered square shaft: side s0 at y0 to s1 at y1, rotated by yaw, with the wash. */
function taperedShaft(gb: GeoBuilder, x: number, z: number, yaw: number, s0: number, s1: number, y0: number, y1: number, g0: number, g1: number): void {
  const c0 = WARM.clone().multiplyScalar(g0);
  const c1 = WARM.clone().multiplyScalar(g1);
  const corners = (s: number, y: number) =>
    [0, 1, 2, 3].map((k) => {
      const ang = yaw + Math.PI / 4 + (k * Math.PI) / 2;
      const r = (s / 2) * Math.SQRT2;
      return { x: x + Math.sin(ang) * r, y, z: z + Math.cos(ang) * r };
    });
  const lo = corners(s0, y0);
  const hi = corners(s1, y1);
  for (let k = 0; k < 4; k++) {
    const p = lo[k];
    const q = lo[(k + 1) % 4];
    const nx = (q.z - p.z) / Math.hypot(q.x - p.x, q.z - p.z);
    const nz = -(q.x - p.x) / Math.hypot(q.x - p.x, q.z - p.z);
    const a = gb.vertex(p.x, p.y, p.z, nx, 0, nz, 0, 0, c0);
    const b = gb.vertex(q.x, q.y, q.z, nx, 0, nz, 1, 0, c0);
    const c = gb.vertex(hi[(k + 1) % 4].x, hi[(k + 1) % 4].y, hi[(k + 1) % 4].z, nx, 0, nz, 1, 1, c1);
    const d = gb.vertex(hi[k].x, hi[k].y, hi[k].z, nx, 0, nz, 0, 1, c1);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  }
}

/** Pyramid over a square of side s at y0 up to the apex at y1. */
function pyramid(gb: GeoBuilder, x: number, z: number, yaw: number, s: number, y0: number, y1: number, color: THREE.Color): void {
  const r = (s / 2) * Math.SQRT2;
  const ring = [0, 1, 2, 3].map((k) => {
    const ang = yaw + Math.PI / 4 + (k * Math.PI) / 2;
    return { x: x + Math.sin(ang) * r, z: z + Math.cos(ang) * r };
  });
  for (let k = 0; k < 4; k++) {
    const p = ring[k];
    const q = ring[(k + 1) % 4];
    const mx = (p.x + q.x) / 2 - x;
    const mz = (p.z + q.z) / 2 - z;
    const l = Math.hypot(mx, mz) || 1;
    const a = gb.vertex(p.x, y0, p.z, mx / l, 0.5, mz / l, 0, 0, color);
    const b = gb.vertex(q.x, y0, q.z, mx / l, 0.5, mz / l, 1, 0, color);
    const c = gb.vertex(x, y1, z, mx / l, 0.5, mz / l, 0.5, 1, color);
    gb.triFacing(a, b, c, mx / l, 0.5, mz / l);
  }
}

export const monumentRenderer: DistrictRenderer = {
  kinds: ['monument'],
  build(kit, areas) {
    const concrete = col(0x6d6f78);
    const paving = col(0x7d7f88, 0.9);
    const mulch = col(0x2e2419);
    const lift = CITY.curbHeight;
    for (const a of areas) {
      const b = kit.builds[a.id];
      const P = a.params;
      const cx = P.cx;
      const cz = P.cz;
      const rng = new Rng((P.seed ^ 0x3a9) >>> 0 || 1);
      // Plaza paving (draped over the dome) with concentric rings and radial lines, every piece of
      // them clipped to the plaza: the rings reach into the corners but never cross the edge.
      drapeConvex(kit, kit.ground, a.polygon, lift, concrete, 4);
      const plazaY = kit.h(cx, cz) + lift;
      const inPlaza = (p: Vec2) => pointInPolygon(p.x, p.z, a.polygon) && distToPolygonEdge(p.x, p.z, a.polygon) > MONUMENT.pavingInset;
      const reach = Math.max(...a.polygon.map((p) => Math.hypot(p.x - cx, p.z - cz)));
      for (let r = 10; r < reach; r += MONUMENT.ringStep) {
        const pts = circlePolygon(cx, cz, r, Math.max(36, Math.round(r * 1.5)));
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const q = pts[(i + 1) % pts.length];
          if (inPlaza(p) && inPlaza(q)) groundLine(kit, kit.paint, p, q, 0.25, lift + 0.03, paving);
        }
      }
      for (let k = 0; k < 8; k++) {
        const ang = P.yaw + (k * Math.PI) / 4;
        for (let r = 10; r < reach; r += MONUMENT.radialPiece) {
          const p = { x: cx + Math.sin(ang) * r, z: cz + Math.cos(ang) * r };
          const q = { x: cx + Math.sin(ang) * (r + MONUMENT.radialPiece), z: cz + Math.cos(ang) * (r + MONUMENT.radialPiece) };
          if (inPlaza(p) && inPlaza(q)) groundLine(kit, kit.paint, p, q, 0.25, lift + 0.03, paving);
        }
      }
      // A light band along the plaza's edge, and the flower beds: a stone edging ring around a mulch disc.
      for (let i = 0; i < a.polygon.length; i++) {
        const p = a.polygon[i];
        const q = a.polygon[(i + 1) % a.polygon.length];
        const len = Math.hypot(q.x - p.x, q.z - p.z);
        if (len < 1) continue;
        let nx = (q.z - p.z) / len;
        let nz = -(q.x - p.x) / len;
        if (((p.x + q.x) / 2 - cx) * nx + ((p.z + q.z) / 2 - cz) * nz > 0) {
          nx = -nx;
          nz = -nz;
        }
        const n = Math.max(1, Math.ceil(len / 6));
        for (let k = 0; k < n; k++) {
          const t0 = k / n;
          const t1 = (k + 1) / n;
          groundLine(kit, kit.paint, { x: p.x + (q.x - p.x) * t0 + nx * MONUMENT.borderInset, z: p.z + (q.z - p.z) * t0 + nz * MONUMENT.borderInset }, { x: p.x + (q.x - p.x) * t1 + nx * MONUMENT.borderInset, z: p.z + (q.z - p.z) * t1 + nz * MONUMENT.borderInset }, MONUMENT.borderWidth, lift + 0.03, paving);
        }
      }
      for (const h of b.hints) {
        if (h.kind !== 'bed') continue;
        const bc = h.points[0];
        const y = kit.h(bc.x, bc.z) + lift;
        cylinder(kit.ground, bc.x, bc.z, h.values[0] + 0.45, y - 0.02, y + 0.06, 16, STONE_TOP);
        cylinder(kit.ground, bc.x, bc.z, h.values[0], y + 0.06, y + 0.08, 16, mulch);
      }
      // Pavement lights.
      for (const h of b.hints) {
        if (h.kind !== 'lamps') continue;
        for (const p of h.points) cylinder(kit.glow, p.x, p.z, MONUMENT.lampR, kit.h(p.x, p.z) + lift + 0.02, kit.h(p.x, p.z) + lift + 0.08, 8, WARM.clone().multiplyScalar(MONUMENT.lampGlow));
      }
      if (a.variant === 'arch') archLandmark(kit, a.params, b.hints.filter((h) => h.kind === 'pier').map((h) => h.points), plazaY, rng);
      else pedestalLandmark(kit, a.variant, a.params, rng);
    }
  },
};

/** Step rings, base block, flags and floods under an obelisk or a statue column. */
function pedestalLandmark(kit: DistrictKit, kind: string, P: Record<string, number>, rng: Rng): void {
  const cx = P.cx;
  const cz = P.cz;
  const base = CITY.districts.monument.base;
  const band = CITY.districts.monument.steps;
  // Steps and base as stacked prisms from the ground (hidden overlap is cheaper than trimming).
  for (const st of MONUMENT.steps) prism(kit, kit.solid, circlePolygon(cx, cz, base + band * st.r, 20, P.yaw), st.h, STONE, STONE_TOP, 0.4);
  const basePoly = circlePolygon(cx, cz, base, 8, P.yaw + Math.PI / 8);
  prism(kit, kit.solid, basePoly, MONUMENT.baseH, DARK, STONE, 0.4);
  let hi = -Infinity;
  for (const p of basePoly) hi = Math.max(hi, kit.h(p.x, p.z));
  const yBase = hi + MONUMENT.baseH;
  const H = P.height;
  if (kind === 'obelisk') {
    // Plinth block, tapered shaft, gold tipped pyramidion.
    washPrism(kit.glow, circlePolygon(cx, cz, 2.4, 4, P.yaw + Math.PI / 4), yBase, yBase + 2.2, MONUMENT.foot, MONUMENT.foot * 0.9);
    const shaftTop = yBase + H * 0.86;
    taperedShaft(kit.glow, cx, cz, P.yaw, 3.2, 1.9, yBase + 2.2, shaftTop, MONUMENT.foot * 0.9, MONUMENT.top);
    pyramid(kit.glow, cx, cz, P.yaw, 1.9, shaftTop, yBase + H, col(0xffd27a, 0.9));
  } else {
    // Column: square plinth, fluted-looking shaft (16 sides), capital, and an abstract statue silhouette on top.
    washPrism(kit.glow, circlePolygon(cx, cz, 2.6, 4, P.yaw + Math.PI / 4), yBase, yBase + 1.6, MONUMENT.foot, MONUMENT.foot * 0.92);
    const capY = yBase + H * 0.8;
    const n = 16;
    const c0 = WARM.clone().multiplyScalar(MONUMENT.foot * 0.9);
    const c1 = WARM.clone().multiplyScalar(MONUMENT.top);
    const r0: number[] = [];
    const r1: number[] = [];
    for (let i = 0; i <= n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      r0.push(kit.glow.vertex(cx + c * 1.5, yBase + 1.6, cz + s * 1.5, c, 0, s, i / n, 0, c0));
      r1.push(kit.glow.vertex(cx + c * 1.3, capY, cz + s * 1.3, c, 0, s, i / n, 1, c1));
    }
    for (let i = 0; i < n; i++) {
      const ang = ((i + 0.5) / n) * Math.PI * 2;
      kit.glow.quadFacing(r0[i], r0[i + 1], r1[i + 1], r1[i], Math.cos(ang), 0, Math.sin(ang));
    }
    cylinder(kit.glow, cx, cz, 2.1, capY, capY + 1.2, 8, c1.clone().multiplyScalar(1.3), true, 2.3);
    // Statue: a figure with one arm raised, dim so it silhouettes against the sky.
    const dim = WARM.clone().multiplyScalar(0.3);
    const fig = (hu: number, hv: number, y0: number, y1: number, ox: number, oz: number) => {
      const ux = Math.sin(P.yaw);
      const uz = Math.cos(P.yaw);
      const px = cx + ux * ox - uz * oz;
      const pz = cz + uz * ox + ux * oz;
      prismAt(kit.glow, px, pz, P.yaw, hu, hv, y0, y1, dim);
    };
    const y = capY + 1.2;
    fig(0.75, 0.5, y, y + 2.6, 0, 0);
    fig(0.42, 0.42, y + 2.6, y + 3.4, 0, 0);
    fig(0.22, 0.22, y + 1.9, y + 4.2, 0.95, 0);
    fig(0.3, 0.28, y + 0.4, y + 2, -0.95, 0);
  }
  // Floods on the top step, aimed at the landmark, and flag poles around the base.
  for (let i = 0; i < 6; i++) {
    const ang = P.yaw + Math.PI / 6 + (i / 6) * Math.PI * 2;
    const x = cx + Math.sin(ang) * (base + 1.2);
    const z = cz + Math.cos(ang) * (base + 1.2);
    const y = hi + MONUMENT.steps[1].h + 0.02;
    cylinder(kit.glow, x, z, MONUMENT.floodR, y, y + 0.14, 8, WARM.clone().multiplyScalar(MONUMENT.floodGlow));
  }
  const flags = Math.max(3, Math.round(P.flags));
  for (let i = 0; i < flags; i++) {
    const ang = P.yaw + (i / flags) * Math.PI * 2;
    flag(kit, cx + Math.sin(ang) * (base - 0.9), cz + Math.cos(ang) * (base - 0.9), yBase, ang, FLAGS[rng.int(0, FLAGS.length - 1)]);
  }
}

/** Triumphal arch: two floodlit piers (the collision), a lintel over the opening and an attic with a bright inscription band. */
function archLandmark(kit: DistrictKit, P: Record<string, number>, piers: Vec2[][], plazaY: number, rng: Rng): void {
  const cx = P.cx;
  const cz = P.cz;
  const H = P.height;
  const pierTop = plazaY + H * 0.62;
  let hi = -Infinity;
  for (const poly of piers) for (const p of poly) hi = Math.max(hi, kit.h(p.x, p.z));
  for (const poly of piers) {
    // Dark stone course at the foot, then the floodlit pier.
    prism(kit, kit.solid, poly, 1.2, DARK, STONE, 0.4);
    washPrism(kit.glow, poly, hi + 1.2, pierTop, MONUMENT.foot, MONUMENT.top * 1.4);
  }
  // Half span across both piers' outer faces (the sim's clear radius, monument.ts).
  const span = CITY.districts.monument.archGap / 2 + CITY.districts.monument.pierWidth;
  const depth = CITY.districts.monument.pierDepth / 2;
  // Lintel across both piers, an attic block on top, and the inscription band on the attic's long faces.
  prismAt(kit.glow, cx, cz, P.yaw, depth + 0.2, span + 0.2, pierTop, pierTop + H * 0.22, WARM.clone().multiplyScalar(MONUMENT.top * 1.5));
  prismAt(kit.glow, cx, cz, P.yaw, depth + 0.5, span + 0.5, pierTop + H * 0.22, pierTop + H * 0.38, WARM.clone().multiplyScalar(MONUMENT.top * 1.1));
  prismAt(kit.glow, cx, cz, P.yaw, depth + 0.55, span * 0.7, pierTop + H * 0.26, pierTop + H * 0.34, WARM.clone().multiplyScalar(1.6));
  // Inner arch: fillets under the lintel at the inner top corners of the opening.
  const ux = Math.sin(P.yaw);
  const uz = Math.cos(P.yaw);
  const vx = -uz;
  const vz = ux;
  const gap = CITY.districts.monument.archGap / 2;
  const dimTop = WARM.clone().multiplyScalar(MONUMENT.top * 1.2);
  for (const sgn of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const y0 = pierTop - 3 + k * 0.75;
      const y1 = y0 + 0.75;
      const inset0 = 3 - 2.9 * Math.sqrt(1 - ((k + 1) / 4) ** 2);
      const inset1 = 3 - 2.9 * Math.sqrt(1 - (k / 4) ** 2);
      const a = { x: cx + vx * sgn * (gap - inset0) + ux * depth, z: cz + vz * sgn * (gap - inset0) + uz * depth };
      const b = { x: cx + vx * sgn * (gap - inset0) - ux * depth, z: cz + vz * sgn * (gap - inset0) - uz * depth };
      const c = { x: cx + vx * sgn * (gap - inset1) - ux * depth, z: cz + vz * sgn * (gap - inset1) - uz * depth };
      const d = { x: cx + vx * sgn * (gap - inset1) + ux * depth, z: cz + vz * sgn * (gap - inset1) + uz * depth };
      const nx = -vx * sgn;
      const nz = -vz * sgn;
      const i0 = kit.glow.vertex(a.x, y0, a.z, nx, 0, nz, 0, 0, dimTop);
      const i1 = kit.glow.vertex(b.x, y0, b.z, nx, 0, nz, 1, 0, dimTop);
      const i2 = kit.glow.vertex(c.x, y1, c.z, nx, 0, nz, 1, 1, dimTop);
      const i3 = kit.glow.vertex(d.x, y1, d.z, nx, 0, nz, 0, 1, dimTop);
      kit.glow.quadFacing(i0, i1, i2, i3, nx, 0, nz);
    }
  }
  // Floods at the foot of each pier, flags on the attic.
  for (const poly of piers) {
    let px = 0;
    let pz = 0;
    for (const p of poly) {
      px += p.x / poly.length;
      pz += p.z / poly.length;
    }
    for (const sgn of [-1, 1]) {
      const x = px + ux * sgn * (depth + 1.4);
      const z = pz + uz * sgn * (depth + 1.4);
      const y = kit.h(x, z) + CITY.curbHeight + 0.02;
      cylinder(kit.glow, x, z, MONUMENT.floodR, y, y + 0.14, 8, WARM.clone().multiplyScalar(MONUMENT.floodGlow));
    }
  }
  const flags = Math.max(3, Math.round(P.flags));
  for (let i = 0; i < flags; i++) {
    const t = (i + 0.5) / flags - 0.5;
    flag(kit, cx + vx * t * span * 1.6, cz + vz * t * span * 1.6, pierTop + H * 0.38, P.yaw + Math.PI / 2, FLAGS[rng.int(0, FLAGS.length - 1)]);
  }
}

/** Box centred at (x, z) with half sizes along and across `yaw`, in one colour. */
function prismAt(gb: GeoBuilder, x: number, z: number, yaw: number, hu: number, hv: number, y0: number, y1: number, color: THREE.Color): void {
  const ux = Math.sin(yaw);
  const uz = Math.cos(yaw);
  const vx = -uz;
  const vz = ux;
  const poly = [
    { x: x - ux * hu - vx * hv, z: z - uz * hu - vz * hv },
    { x: x + ux * hu - vx * hv, z: z + uz * hu - vz * hv },
    { x: x + ux * hu + vx * hv, z: z + uz * hu + vz * hv },
    { x: x - ux * hu + vx * hv, z: z - uz * hu + vz * hv },
  ];
  for (let i = 0; i < 4; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % 4];
    let nx = q.z - p.z;
    let nz = -(q.x - p.x);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((p.x + q.x) / 2 - x) * nx + ((p.z + q.z) / 2 - z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const a = gb.vertex(p.x, y0, p.z, nx, 0, nz, 0, 0, color);
    const b = gb.vertex(q.x, y0, q.z, nx, 0, nz, 1, 0, color);
    const c = gb.vertex(q.x, y1, q.z, nx, 0, nz, 1, 1, color);
    const d = gb.vertex(p.x, y1, p.z, nx, 0, nz, 0, 1, color);
    gb.quadFacing(a, b, c, d, nx, 0, nz);
  }
  const top = poly.map((p) => gb.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, color));
  gb.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
}

/** A flag pole with a triangular pennant, the pennant lit by the floods. */
function flag(kit: DistrictKit, x: number, z: number, y0: number, yaw: number, color: THREE.Color): void {
  cylinder(kit.solid, x, z, 0.07, y0, y0 + MONUMENT.flagH, 6, col(0x8a8c96), false);
  const tx = Math.cos(yaw) * 1.9;
  const tz = -Math.sin(yaw) * 1.9;
  const yTop = y0 + MONUMENT.flagH - 0.1;
  const a = kit.glow.vertex(x, yTop, z, 0, 0, 1, 0, 0, color);
  const b = kit.glow.vertex(x, yTop - 1.1, z, 0, 0, 1, 0, 1, color);
  const c = kit.glow.vertex(x + tx, yTop - 0.55, z + tz, 0, 0, 1, 1, 0.5, color);
  kit.glow.triFacing(a, b, c, 0, 0, 1);
  kit.glow.triFacing(a, c, b, 0, 0, -1);
}
