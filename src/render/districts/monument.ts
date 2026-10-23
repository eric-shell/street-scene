/**
 * Monument renderer: the plaza (concrete at sidewalk level with a paving
 * pattern), the step rings and base the sim collides with, and the floodlit
 * landmark on top: an obelisk, a statue column or a triumphal arch. The
 * landmark is drawn unlit and bright (kit.glow) through the floodlit painter
 * (monumentShapes.ts), which bakes an uplight wash and per-face shading into
 * the vertex colours, so it blooms and reads from across the city without a
 * single real light and still shows its mouldings up close: an octagonal
 * drum with plaques and a balustrade under the obelisk (pedestal, coursed
 * shaft with carved glyphs, gilded pyramidion, aviation light) and the
 * column (attic base, fluted shaft, Doric capital, a bronze statue with a
 * torch); the arch has pilastered piers, a coffered vault, an archivolt and
 * keystone, an entablature, an inscribed attic and a statue between urns.
 * The steps and the piers' foot courses are lit normally. Flags on poles
 * stand on the base, pavement lights ring it, and the floods themselves are
 * small bright pads. The paving pattern (rings and radials), the flower
 * beds' mulch and edging and the border band stop short of the plaza's edge,
 * never on the sidewalk or the road. All of it merges into the district kit,
 * so the monument costs no extra draw call.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { circlePolygon, distToPolygonEdge, pointInPolygon } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import type { DistrictKit } from './kit';
import { col, cylinder, drapeConvex, groundLine, prism } from './kit';
import type { DistrictRenderer } from './kit';
import { Floodlit, fp, frameAt, statue, subFrame } from './monumentShapes';
import type { Frame, Paint } from './monumentShapes';

const MONUMENT = {
  /** Step rings (outer first): height above the plaza (m) and radius as a fraction of the step band. */
  steps: [
    { h: 0.27, r: 1 },
    { h: 0.54, r: 0.72 },
    { h: 0.8, r: 0.45 },
  ],
  /** Drum height above the ground (m); its lowest 0.8 m hides behind the top step. */
  baseH: 3.6,
  /**
   * Flood washes: HDR brightness at the floods (g0) and at the top of what they light (g1), the
   * glow material adds x1.6: the landmark, the drum under it, and the statue's own floods.
   */
  wash: { g0: 0.5, g1: 0.22 },
  baseWash: { g0: 0.42, g1: 0.26 },
  statueWash: { g0: 0.55, g1: 0.3 },
  /** The key side of the floodlit shading, turned from the landmark's axis (rad). */
  keyTurn: 0.6,
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
  /**
   * A race pass's way: drawn in pieces (m) kept this far inside the plaza (m), a dark granite band
   * the line's width, lighter kerb lines (m wide) along its edges and flush lights every studStep (m).
   */
  pass: {
    piece: 2,
    inset: 0.6,
    band: col(0x56575f),
    kerb: 0.35,
    kerbColor: col(0x9a9ca6),
    studStep: 5,
    studR: 0.24,
    studColor: new THREE.Color(1, 0.86, 0.66).multiplyScalar(1.7),
  },
} as const;

const STONE = col(0x4a4b53);
const STONE_TOP = col(0x5a5b64);
const DARK = col(0x2c2d33);
const WARM = new THREE.Color(1, 0.86, 0.66);
const FLAGS = [0xffd27a, 0xff4a4a, 0xf2f2f2, 0x5aa0ff, 0x7cff9a].map((c) => col(c, 0.55));

/** The landmark's finishes on the floodlit painter (monumentShapes.ts). */
const LIT: Paint = { color: WARM, mul: 1 };
/** Archivolt voussoirs, keystone, impost and cornice bands: a shade lighter than the wall. */
const LIGHT: Paint = { color: WARM, mul: 1.14 };
/** Course joints in the obelisk's shaft. */
const JOINT: Paint = { color: WARM, mul: 0.55 };
/** Sunk panels, glyphs, triglyphs, coffers: carving reads darker than the face it is cut in. */
const CARVE: Paint = { color: WARM, mul: 0.7 };
const BRONZE: Paint = { color: new THREE.Color(0.62, 0.48, 0.3), mul: 0.8 };
/** Gilding catches the floods at any height. */
const GOLD: Paint = { color: new THREE.Color(1, 0.76, 0.34), mul: 0.8, glow: true };
const FLAME: Paint = { color: new THREE.Color(1, 0.55, 0.18), mul: 2, glow: true };
/** The obelisk's aviation light. */
const BEACON: Paint = { color: new THREE.Color(1, 0.12, 0.08), mul: 2.2, glow: true };

/** u range of a feature standing out of the face at d0 (inside) to d1 (outside) on the su side. */
const side = (su: number, d0: number, d1: number): [number, number] => (su > 0 ? [d0, d1] : [-d1, -d0]);

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
      // Race passes (city monument.ts plazaPasses): a band of darker granite where the racing line
      // crosses the paving, edged with lighter stone and studded with flush lights, drawn on the plaza
      // only (the street ends of the line are asphalt).
      for (const h of b.hints) if (h.kind === 'pass') passWay(kit, h.points, h.values[0], a.polygon, lift);
      // Pavement lights.
      for (const h of b.hints) {
        if (h.kind !== 'lamps') continue;
        for (const p of h.points) cylinder(kit.glow, p.x, p.z, MONUMENT.lampR, kit.h(p.x, p.z) + lift + 0.02, kit.h(p.x, p.z) + lift + 0.08, 8, WARM.clone().multiplyScalar(MONUMENT.lampGlow));
      }
      if (a.variant === 'arch') archLandmark(kit, a.params, b.hints.filter((h) => h.kind === 'pier').map((h) => h.points), rng);
      else pedestalLandmark(kit, a.variant, a.params, rng);
    }
  },
};

/** A race pass's way across the plaza: its band, kerb lines and edge studs, in MONUMENT.pass pieces kept off the plaza's edge. */
function passWay(kit: DistrictKit, pts: Vec2[], width: number, plaza: Vec2[], lift: number): void {
  const W = MONUMENT.pass;
  const on = (p: Vec2) => pointInPolygon(p.x, p.z, plaza) && distToPolygonEdge(p.x, p.z, plaza) > W.inset;
  let stud = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.1) continue;
    const ux = (q.x - p.x) / len;
    const uz = (q.z - p.z) / len;
    const n = Math.max(1, Math.ceil(len / W.piece));
    for (let k = 0; k < n; k++) {
      const a = { x: p.x + (q.x - p.x) * (k / n), z: p.z + (q.z - p.z) * (k / n) };
      const b = { x: p.x + (q.x - p.x) * ((k + 1) / n), z: p.z + (q.z - p.z) * ((k + 1) / n) };
      if (!on(a) || !on(b)) continue;
      groundLine(kit, kit.paint, a, b, width, lift + 0.045, W.band);
      for (const sgn of [-1, 1]) {
        const ox = -uz * sgn * (width / 2);
        const oz = ux * sgn * (width / 2);
        groundLine(kit, kit.paint, { x: a.x + ox, z: a.z + oz }, { x: b.x + ox, z: b.z + oz }, W.kerb, lift + 0.05, W.kerbColor);
      }
    }
    // Flush lights down both edges, evenly along the whole line.
    for (; stud <= len; stud += W.studStep) {
      const c = { x: p.x + ux * stud, z: p.z + uz * stud };
      for (const sgn of [-1, 1]) {
        const x = c.x - uz * sgn * (width / 2 - 0.5);
        const z = c.z + ux * sgn * (width / 2 - 0.5);
        if (!on({ x, z })) continue;
        const y = kit.h(x, z) + lift;
        cylinder(kit.glow, x, z, W.studR, y + 0.02, y + 0.07, 6, W.studColor);
      }
    }
    stud -= len;
  }
}

/** Step rings, the drum, flags and floods under an obelisk or a statue column. */
function pedestalLandmark(kit: DistrictKit, kind: string, P: Record<string, number>, rng: Rng): void {
  const cx = P.cx;
  const cz = P.cz;
  const base = CITY.districts.monument.base;
  const band = CITY.districts.monument.steps;
  // Steps as stacked prisms from the ground (hidden overlap is cheaper than trimming); the outer ring is the collision.
  for (const st of MONUMENT.steps) prism(kit, kit.solid, circlePolygon(cx, cz, base + band * st.r, 20, P.yaw), st.h, STONE, STONE_TOP, 0.4);
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of circlePolygon(cx, cz, base, 8, P.yaw)) {
    lo = Math.min(lo, kit.h(p.x, p.z));
    hi = Math.max(hi, kit.h(p.x, p.z));
  }
  const yBase = hi + MONUMENT.baseH;
  const f = frameAt(cx, cz, P.yaw);
  const L = new Floodlit(kit.glow, P.yaw + MONUMENT.keyTurn, { y0: hi, y1: yBase, ...MONUMENT.baseWash });
  drum(L, f, lo, hi, yBase, rng);
  L.wash = { y0: yBase, y1: yBase + P.height, ...MONUMENT.wash };
  const half = kind === 'obelisk' ? obelisk(L, f, yBase, P.height, rng) : column(L, f, yBase, P.height, rng);
  // Floods on the top step aimed at the drum, a second ring on the drum at the pedestal's faces, and flag poles.
  const yStep = hi + MONUMENT.steps[MONUMENT.steps.length - 1].h + 0.02;
  for (let i = 0; i < 6; i++) {
    const ang = P.yaw + Math.PI / 6 + (i / 6) * Math.PI * 2;
    const p = fp(f, Math.cos(ang - P.yaw) * (base + 0.85), 0, Math.sin(ang - P.yaw) * (base + 0.85));
    cylinder(kit.glow, p.x, p.z, MONUMENT.floodR, yStep, yStep + 0.14, 8, WARM.clone().multiplyScalar(MONUMENT.floodGlow));
  }
  for (let k = 0; k < 4; k++) {
    const p = fp(subFrame(f, 0, 0, (k * Math.PI) / 2), half + 0.75, 0, 0);
    cylinder(kit.glow, p.x, p.z, MONUMENT.floodR * 0.7, yBase + 0.01, yBase + 0.12, 8, WARM.clone().multiplyScalar(MONUMENT.floodGlow));
  }
  const flags = Math.max(3, Math.round(P.flags));
  for (let i = 0; i < flags; i++) {
    const ang = P.yaw + (i / flags) * Math.PI * 2;
    flag(kit, cx + Math.sin(ang) * (base - 1.2), cz + Math.cos(ang) * (base - 1.2), yBase, ang, FLAGS[rng.int(0, FLAGS.length - 1)]);
  }
}

/**
 * The octagonal drum the landmark stands on: a plinth course behind the steps, the body with
 * bronze plaques on four faces, a cornice, and a balustrade round the top.
 */
function drum(L: Floodlit, f: Frame, lo: number, hi: number, yBase: number, rng: Rng): void {
  const R = CITY.districts.monument.base;
  const t = yBase - hi;
  L.lathe(f.x, f.z, [[R, lo - 0.4], [R, hi + 1.1], [R - 0.15, hi + 1.1], [R - 0.15, hi + 1.22], [R - 0.3, hi + 1.35], [R - 0.3, hi + t - 0.55], [R - 0.12, hi + t - 0.45], [R + 0.12, hi + t - 0.25], [R + 0.12, hi + t - 0.08], [R, yBase]], 8, f.yaw + Math.PI / 8, LIT);
  const ri = (R - 0.3) * Math.cos(Math.PI / 8);
  for (let k = 0; k < 8; k += 2) {
    const g = subFrame(f, 0, 0, (k * Math.PI) / 4);
    L.plate(g, ri + 0.02, 1, -1.3, 1.3, hi + 1.65, hi + t - 0.75, BRONZE);
    L.lettering(g, ri + 0.035, 1, -1.1, 1.1, hi + (t + 0.9) / 2, 0.16, GOLD, rng);
  }
  // Balustrade: a rail on balusters along each side between square posts at the corners.
  const Rb = R - 0.35;
  const hl = Rb * Math.sin(Math.PI / 8);
  const rb = Rb * Math.cos(Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const g = subFrame(f, 0, 0, (i * Math.PI) / 4);
    L.box(g, rb - 0.17, rb + 0.17, -hl, hl, yBase, yBase + 0.12, LIT, 'UuT');
    L.box(g, rb - 0.2, rb + 0.2, -hl, hl, yBase + 0.72, yBase + 0.86, LIGHT, 'UuTB');
    const m = Math.floor((2 * hl) / 0.45) - 1;
    for (let j = 1; j <= m; j++) {
      const p = fp(g, rb, 0, -hl + (j * 2 * hl) / (m + 1));
      L.lathe(p.x, p.z, [[0.09, yBase + 0.12], [0.13, yBase + 0.26], [0.07, yBase + 0.46], [0.11, yBase + 0.6], [0.08, yBase + 0.72]], 6, 0, LIT, false);
    }
    const c = subFrame(f, 0, 0, (i * Math.PI) / 4 + Math.PI / 8);
    L.square(c, Rb, 0, [[0.22, yBase], [0.22, yBase + 0.92], [0.26, yBase + 0.97], [0.26, yBase + 1.04]], LIT);
  }
}

/** Bronze plaques with gilded lettering on the four faces of a square die (half side `half`, m). */
function dieFaces(L: Floodlit, f: Frame, half: number, y0: number, y1: number, w: number, rng: Rng): void {
  for (let k = 0; k < 4; k++) {
    const g = subFrame(f, 0, 0, (k * Math.PI) / 2);
    L.plate(g, half + 0.02, 1, -w, w, y0, y1, BRONZE);
    L.lettering(g, half + 0.035, 1, -w + 0.2, w - 0.2, (y0 + y1) / 2, 0.17, GOLD, rng);
  }
}

/** Obelisk on a moulded pedestal: a shaft in courses with carved glyph columns, a gilded pyramidion and an aviation light. Returns the pedestal's half side (m). */
function obelisk(L: Floodlit, f: Frame, yB: number, H: number, rng: Rng): number {
  L.square(f, 0, 0, [[2.5, yB - 0.05], [2.5, yB + 0.45], [2.32, yB + 0.45], [2.32, yB + 0.6], [2.12, yB + 0.78], [2.12, yB + 2.8], [2.3, yB + 2.95], [2.48, yB + 3.15], [2.48, yB + 3.3], [2.2, yB + 3.3], [2.2, yB + 3.55]], LIT);
  dieFaces(L, f, 2.12, yB + 1.05, yB + 2.5, 1.35, rng);
  const y0 = yB + 3.55;
  const yS = yB + H * 0.88;
  const half = (y: number) => 1.5 - (0.55 * (y - y0)) / (yS - y0);
  const courses = Math.max(4, Math.round((yS - y0) / 2.6));
  for (let c = 0; c < courses; c++) {
    const a = y0 + ((yS - y0) * c) / courses;
    const b = y0 + ((yS - y0) * (c + 1)) / courses;
    const j = c + 1 < courses ? b - 0.1 : b;
    L.square(f, 0, 0, [[half(a), a], [half(j), j]], LIT, false);
    if (j < b) L.square(f, 0, 0, [[half(j), j], [half(b), b]], JOINT, false);
  }
  // Two columns of carved glyphs down each face, up to about two thirds of the shaft.
  for (let k = 0; k < 4; k++) {
    const g = subFrame(f, 0, 0, (k * Math.PI) / 2);
    for (let y = y0 + 1.2; y < y0 + (yS - y0) * 0.62; y += 0.85) {
      const sc = half(y) / 1.5;
      for (const vc of [-0.45, 0.45]) {
        if (!rng.chance(0.85)) continue;
        const w = rng.range(0.28, 0.5) * sc;
        L.plate(g, half(y) + 0.03, 1, vc * sc - w / 2, vc * sc + w / 2, y, y + rng.range(0.3, 0.62), CARVE);
      }
    }
  }
  L.square(f, 0, 0, [[half(yS), yS], [0, yB + H]], GOLD);
  L.square(f, 0, 0, [[0.14, yB + H - 0.05], [0.14, yB + H + 0.25], [0, yB + H + 0.4]], BEACON);
  return 2.5;
}

/** Fluted column on a moulded pedestal: attic base, gilded astragal, Doric capital, a drum and the statue. Returns the pedestal's half side (m). */
function column(L: Floodlit, f: Frame, yB: number, H: number, rng: Rng): number {
  L.square(f, 0, 0, [[2.7, yB - 0.05], [2.7, yB + 0.45], [2.5, yB + 0.45], [2.5, yB + 0.6], [2.3, yB + 0.8], [2.3, yB + 2.6], [2.48, yB + 2.75], [2.66, yB + 2.95], [2.66, yB + 3.1], [2.3, yB + 3.1], [2.3, yB + 3.2]], LIT);
  dieFaces(L, f, 2.3, yB + 1.0, yB + 2.4, 1.5, rng);
  L.square(f, 0, 0, [[1.62, yB + 3.2], [1.62, yB + 3.55]], LIT);
  // Attic base: torus, scotia, torus, fillet.
  const yb = yB + 3.55;
  L.round(f, 0, 0, [[1.5, yb], [1.58, yb + 0.1], [1.5, yb + 0.23], [1.36, yb + 0.27], [1.3, yb + 0.37], [1.38, yb + 0.45], [1.42, yb + 0.5], [1.36, yb + 0.6], [1.22, yb + 0.6]], 24, LIT, false);
  const capY = yB + H * 0.8;
  // Shaft with entasis: a slight swell low down, tapering to the neck.
  const r = (t: number) => 1.2 - 0.17 * t + 0.05 * Math.sin(Math.PI * t);
  L.fluted(f, 0, 0, yb + 0.6, capY - 0.5, r, 20, 8, LIT);
  const rt = r(1);
  L.round(f, 0, 0, [[rt, capY - 0.5], [rt + 0.1, capY - 0.44], [rt + 0.1, capY - 0.36], [rt, capY - 0.3]], 24, GOLD, false);
  L.round(f, 0, 0, [[rt, capY - 0.3], [rt, capY], [rt + 0.17, capY + 0.12], [rt + 0.35, capY + 0.3], [rt + 0.47, capY + 0.5], [rt + 0.49, capY + 0.58]], 24, LIT, false);
  L.square(f, 0, 0, [[0, capY + 0.58], [1.58, capY + 0.58], [1.58, capY + 1.05]], LIT);
  const yd = capY + 1.95;
  L.round(f, 0, 0, [[1.0, capY + 1.05], [1.0, capY + 1.75], [1.12, capY + 1.85], [1.12, yd], [0.95, yd]], 16, LIT);
  L.wash = { y0: yd, y1: yd + 6, ...MONUMENT.statueWash };
  statue(L, f, 0, 0, yd, 1, BRONZE, GOLD, FLAME);
  return 2.7;
}

/**
 * Triumphal arch: two piers (the collision is their dark foot course) with pilasters, sunk
 * panels and gilded roundels, a coffered barrel vault over the drive through, an archivolt
 * with a keystone, an entablature with triglyphs, an attic carrying a gilded inscription, and
 * a statue between two flaming urns on top.
 */
function archLandmark(kit: DistrictKit, P: Record<string, number>, piers: Vec2[][], rng: Rng): void {
  const A = CITY.districts.monument;
  const g = A.archGap / 2;
  const pd = A.pierDepth / 2;
  const vo = g + A.pierWidth;
  // The piers' faces stand a little inside the collision so the pilasters come out to it.
  const pdI = pd - 0.12;
  let hi = -Infinity;
  for (const poly of piers) for (const p of poly) hi = Math.max(hi, kit.h(p.x, p.z));
  for (const poly of piers) prism(kit, kit.solid, poly, 1.2, DARK, STONE, 0.4);
  const y0 = hi;
  const ys = y0 + P.height * 0.47;
  const ys2 = ys + 0.35;
  const crown = ys2 + g;
  const yE = crown + 0.85;
  const f = frameAt(P.cx, P.cz, P.yaw);
  const t = subFrame(f, 0, 0, -Math.PI / 2);
  const L = new Floodlit(kit.glow, P.yaw + MONUMENT.keyTurn, { y0: y0 + 1.2, y1: yE + 5, ...MONUMENT.wash });
  for (const sv of [-1, 1]) {
    const v0 = sv > 0 ? g : -vo;
    const v1 = sv > 0 ? vo : -g;
    L.box(f, -pd, pd, v0, v1, y0 + 1.2, y0 + 1.45, LIT);
    L.box(f, -pdI, pdI, v0, v1, y0 + 1.45, ys2, LIT, 'UuVv');
    // Above the spring the vault is the pier's inner face.
    L.box(f, -pdI, pdI, v0, v1, ys2, yE, LIT, sv > 0 ? 'UuV' : 'Uuv');
    L.box(f, -(pdI + 0.1), pdI + 0.1, sv > 0 ? g - 0.12 : -vo, sv > 0 ? vo : -g + 0.12, ys, ys2, LIGHT, 'UuVvTB');
    const vc = sv * (g + A.pierWidth / 2);
    for (const su of [-1, 1]) {
      const front = su > 0 ? 'U' : 'u';
      for (const pv of [sv * (g + 0.75), sv * (vo - 0.75)]) {
        const [b0, b1] = side(su, pdI, pd);
        L.box(f, b0, b1, pv - 0.5, pv + 0.5, y0 + 1.45, y0 + 1.8, LIT, front + 'VvT');
        const [s0, s1] = side(su, pdI, pd - 0.04);
        L.box(f, s0, s1, pv - 0.38, pv + 0.38, y0 + 1.8, ys, LIT, front + 'Vv');
        L.box(f, s0, s1, pv - 0.38, pv + 0.38, ys2, yE - 0.55, LIT, front + 'Vv');
        const [c0, c1] = side(su, pdI, pd + 0.12);
        L.box(f, c0, c1, pv - 0.52, pv + 0.52, yE - 0.55, yE, LIGHT, front + 'VvB');
      }
      L.plate(f, su * (pdI + 0.015), su, vc - 0.55, vc + 0.55, y0 + 2.3, ys - 0.45, CARVE);
      L.wreath(f, su * (pdI + 0.02), su, vc, (ys2 + yE - 0.55) / 2, 0, 0.55, 16, BRONZE);
      L.wreath(f, su * (pdI + 0.02), su, vc, (ys2 + yE - 0.55) / 2, 0.55, 0.8, 16, GOLD);
    }
    // Sunk panels on the inner faces (the drive through) and the outer ones, a roundel high on the outer.
    L.plate(t, sv * (g - 0.015), -sv, -pdI + 1.2, pdI - 1.2, y0 + 2.3, ys - 0.45, CARVE);
    L.plate(t, sv * (vo + 0.015), sv, -pdI + 1.2, pdI - 1.2, y0 + 2.3, ys - 0.45, CARVE);
    L.wreath(t, sv * (vo + 0.02), sv, 0, (ys2 + yE) / 2, 0, 0.6, 16, BRONZE);
    L.wreath(t, sv * (vo + 0.02), sv, 0, (ys2 + yE) / 2, 0.6, 0.9, 16, GOLD);
  }
  // The vault: a coffered half barrel (ribs lit, coffers sunk), the spandrels over it on both faces,
  // the archivolt's voussoirs alternating in tone, a keystone and a gilded roundel in each spandrel.
  const N = 18;
  const M = 7;
  const av = (i: number) => g * Math.cos((Math.PI * i) / N);
  const ay = (i: number) => ys2 + g * Math.sin((Math.PI * i) / N);
  for (let i = 0; i < N; i++) {
    const th = (Math.PI * (i + 0.5)) / N;
    for (let j = 0; j < M; j++) {
      const u0 = -pdI + (2 * pdI * j) / M;
      const u1 = -pdI + (2 * pdI * (j + 1)) / M;
      L.quad(fp(f, u0, ay(i), av(i)), fp(f, u1, ay(i), av(i)), fp(f, u1, ay(i + 1), av(i + 1)), fp(f, u0, ay(i + 1), av(i + 1)), i % 2 && j % 2 ? CARVE : LIT, f.uz * Math.cos(th), -Math.sin(th), -f.ux * Math.cos(th));
    }
  }
  const ro = g + 0.55;
  for (const su of [-1, 1]) {
    const uf = su * pdI;
    for (let i = 0; i < N; i++) {
      L.quad(fp(f, uf, ay(i), av(i)), fp(f, uf, ay(i + 1), av(i + 1)), fp(f, uf, yE, av(i + 1)), fp(f, uf, yE, av(i)), LIT, su * f.ux, 0, su * f.uz);
      const c0 = Math.cos((Math.PI * i) / N);
      const s0 = Math.sin((Math.PI * i) / N);
      const c1 = Math.cos((Math.PI * (i + 1)) / N);
      const s1 = Math.sin((Math.PI * (i + 1)) / N);
      const [a0, a1] = side(su, pdI, pdI + 0.1);
      L.slab(f, [[g * c0, ys2 + g * s0], [ro * c0, ys2 + ro * s0], [ro * c1, ys2 + ro * s1], [g * c1, ys2 + g * s1]], a0, a1, i % 2 ? LIGHT : LIT);
    }
    const [k0, k1] = side(su, pdI, pdI + 0.3);
    L.slab(f, [[-0.34, crown - 0.12], [0.34, crown - 0.12], [0.52, yE], [-0.52, yE]], k0, k1, LIGHT);
    for (const sv of [-1, 1]) {
      L.wreath(f, su * (pdI + 0.02), su, sv * 4.6, ys2 + 5.15, 0, 0.38, 12, BRONZE);
      L.wreath(f, su * (pdI + 0.02), su, sv * 4.6, ys2 + 5.15, 0.38, 0.6, 12, GOLD);
    }
  }
  // Entablature: architrave, frieze with triglyphs, a two-step cornice with lit soffits.
  L.box(f, -(pd + 0.05), pd + 0.05, -(vo + 0.05), vo + 0.05, yE, yE + 0.5, LIT, 'UuVvB');
  L.box(f, -pdI, pdI, -vo, vo, yE + 0.5, yE + 1.25, LIT, 'UuVv');
  for (const su of [-1, 1]) for (let v = -vo + 0.6; v < vo - 0.3; v += 1.15) L.plate(f, su * (pdI + 0.015), su, v - 0.17, v + 0.17, yE + 0.55, yE + 1.2, CARVE);
  L.box(f, -(pd + 0.5), pd + 0.5, -(vo + 0.5), vo + 0.5, yE + 1.25, yE + 1.45, LIGHT, 'UuVvB');
  L.box(f, -(pd + 0.62), pd + 0.62, -(vo + 0.62), vo + 0.62, yE + 1.45, yE + 1.72, LIT, 'UuVvTB');
  // Attic: the inscription panel between pilaster strips, and its coping.
  const yA0 = yE + 1.72;
  const yA1 = yA0 + 2.7;
  const pa = pdI - 0.1;
  L.box(f, -pa, pa, -(vo - 0.3), vo - 0.3, yA0, yA1, LIT, 'UuVv');
  for (const su of [-1, 1]) {
    L.plate(f, su * (pa + 0.015), su, -5.4, 5.4, yA0 + 0.45, yA1 - 0.45, CARVE);
    L.lettering(f, su * (pa + 0.03), su, -5, 5, (yA0 + yA1) / 2, 0.42, GOLD, rng);
    const [p0, p1] = side(su, pa, pa + 0.1);
    for (const sv of [-1, 1]) L.box(f, p0, p1, sv * (vo - 1.1) - 0.35, sv * (vo - 1.1) + 0.35, yA0, yA1, LIT, (su > 0 ? 'U' : 'u') + 'Vv');
  }
  L.box(f, -(pa + 0.22), pa + 0.22, -(vo - 0.1), vo - 0.1, yA1, yA1 + 0.3, LIGHT, 'UuVvTB');
  const yTop = yA1 + 0.3;
  L.box(f, -1.5, 1.5, -2.3, 2.3, yTop, yTop + 0.9, LIT);
  L.wash = { y0: yTop, y1: yTop + 7, ...MONUMENT.statueWash };
  statue(L, f, 0, 0, yTop + 0.9, 1.15, BRONZE, GOLD, FLAME);
  for (const sv of [-1, 1]) {
    const v = sv * (vo - 1.1);
    L.square(f, 0, v, [[0.5, yTop], [0.5, yTop + 0.6]], LIT);
    const y = yTop + 0.6;
    L.round(f, 0, v, [[0.32, y], [0.32, y + 0.15], [0.18, y + 0.3], [0.5, y + 0.75], [0.42, y + 1.05], [0.25, y + 1.15], [0.38, y + 1.28]], 10, BRONZE, false);
    L.round(f, 0, v, [[0.3, y + 1.28], [0.2, y + 1.7], [0, y + 2.2]], 8, FLAME);
  }
  // Floods at the foot of each pier, flags on the attic either side of the statue.
  for (const poly of piers) {
    let px = 0;
    let pz = 0;
    for (const p of poly) {
      px += p.x / poly.length;
      pz += p.z / poly.length;
    }
    for (const sgn of [-1, 1]) {
      const x = px + f.ux * sgn * (pd + 1.4);
      const z = pz + f.uz * sgn * (pd + 1.4);
      const y = kit.h(x, z) + CITY.curbHeight + 0.02;
      cylinder(kit.glow, x, z, MONUMENT.floodR, y, y + 0.14, 8, WARM.clone().multiplyScalar(MONUMENT.floodGlow));
    }
  }
  const flags = Math.max(3, Math.round(P.flags));
  const per = Math.ceil(flags / 2);
  for (let i = 0; i < flags; i++) {
    const v = (i % 2 ? 1 : -1) * (3.2 + ((Math.floor(i / 2) + 0.5) / per) * 3.4);
    const p = fp(f, -1.2, 0, v);
    flag(kit, p.x, p.z, yTop, P.yaw + Math.PI / 2, FLAGS[rng.int(0, FLAGS.length - 1)]);
  }
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
