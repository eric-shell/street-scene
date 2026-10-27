/**
 * Drift zone markings (sim/driftZones.ts): the monument plaza and the lots
 * that pay a drift bonus are marked the way a drift meet marks its ground,
 * so they read at night without a sign or an arrow:
 *  - yellow paint: a zone box (corner brackets and a dashed edge just inside
 *    the outline), skid pad circles on the roomy lots, a slalom line down the
 *    long narrow ones, and on the plaza one big circle round the landmark;
 *  - rubber: dark donut and slalom marks laid along those lines, seeded per
 *    area, as if the place had been used all night (Medium and up);
 *  - light: flush magenta studs (unlit, they bloom) along the circles and the
 *    slalom, and a soft magenta wash fading in from the zone's edge.
 * Paint and rubber merge into the district paint builder and the studs into
 * the glow builder (no extra draw call); the wash is one additive mesh for
 * every zone (Medium and up), faded to black in fog like the park washes in
 * areaLights.ts. No per frame work. Which areas are zones is the sim's call
 * (driftZones()), so what is drawn is exactly what pays.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import type { Area } from '../../city/districts/types';
import { distToPolygonEdge } from '../../city/districts/geom';
import { driftZones } from '../../sim/driftZones';
import type { Vec2 } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { GeoBuilder } from '../geoBuilder';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, groundLine } from './kit';
import { heightFogShader } from '../heightFog';

export const DRIFT_MARK = {
  /** Paint (lit), rubber (lit, dark), studs (unlit HDR, the glow material adds x1.6) and the edge wash (linear, additive). */
  paint: 0xffd866,
  rubber: 0x09090b,
  stud: new THREE.Color(1, 0.25, 0.85).multiplyScalar(1.1),
  wash: new THREE.Color(1, 0.22, 0.8).multiplyScalar(0.22),
  /** Paint widths (m): the zone box, the circles, the slalom line. Dashes along the box edge: dash and gap (m). */
  boxWidth: 0.16,
  circleWidth: 0.22,
  slalomWidth: 0.14,
  dash: [2.2, 1.4] as [number, number],
  /** Corner brackets run this far along each side from the corner (m); the box sits this far inside the outline (m). */
  bracket: 3,
  inset: 0.5,
  /** Lots: a skid pad circle needs this much radius (m) and keeps this far off the sides (m); narrower lots get a slalom of studs this far apart (m). */
  minCircle: 3.5,
  circleMargin: 1.6,
  slalomGap: 8,
  /** Plaza: the drift circle runs this far outside the benches (m) and keeps this far off the plaza edge (m). */
  plazaOut: 7,
  plazaMargin: 8,
  /** Studs: radius (m) and spacing along circles (m). */
  studR: 0.17,
  studGap: 6.5,
  /** Rubber marks per circle or slalom by quality (Low draws none), tire track width (m) and the gap between a car's two tracks (m). */
  rubberMarks: { low: 0, medium: 5, high: 8 } as Record<string, number>,
  trackWidth: 0.24,
  trackGap: 1.5,
  /** Edge wash width (m) on lots and on the plaza. */
  washLot: 2.6,
  washPlaza: 3.6,
  /** Lifts over the drawn ground (m): lots lie on the asphalt, the plaza at curb height. */
  liftLot: 0.05,
  liftPlaza: CITY.curbHeight + 0.035,
} as const;

/** One drift zone's local frame: a lot's frontage axis u and depth axis w, or the plaza's centre. */
interface Frame {
  o: Vec2;
  u: Vec2;
  w: Vec2;
  lu: number;
  lw: number;
}

function lotFrame(a: Area): Frame | null {
  const P = a.params;
  if (P.lu === undefined || P.lw === undefined) return null;
  return { o: { x: P.ox, z: P.oz }, u: { x: P.ux, z: P.uz }, w: { x: P.wx, z: P.wz }, lu: P.lu, lw: P.lw };
}

const at = (f: Frame, u: number, v: number): Vec2 => ({ x: f.o.x + f.u.x * u + f.w.x * v, z: f.o.z + f.u.z * u + f.w.z * v });

/** An arc of ground paint (a full circle for a1 - a0 = 2 pi), in pieces of about 6 degrees (0.8 to 3 m). */
function arc(kit: DistrictKit, gb: GeoBuilder, cx: number, cz: number, r: number, a0: number, a1: number, width: number, lift: number, color: THREE.Color, dr = 0): void {
  const n = Math.max(4, Math.ceil((Math.abs(a1 - a0) * r) / Math.min(3, Math.max(0.8, r * 0.1))));
  let prev = { x: cx + Math.cos(a0) * r, z: cz + Math.sin(a0) * r };
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = a0 + (a1 - a0) * t;
    const rr = r + dr * t;
    const p = { x: cx + Math.cos(a) * rr, z: cz + Math.sin(a) * rr };
    groundLine(kit, gb, prev, p, width, lift, color);
    prev = p;
  }
}

/**
 * A convex outline moved `d` m inward, side by side (mitred corners, the
 * miter capped so a sharp corner never shoots across).
 */
function insetPolygon(poly: Vec2[], d: number): Vec2[] {
  const n = poly.length;
  let cx = 0;
  let cz = 0;
  for (const p of poly) {
    cx += p.x / n;
    cz += p.z / n;
  }
  // Inward unit normal of each side.
  const normals = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    let nx = -(q.z - p.z) / l;
    let nz = (q.x - p.x) / l;
    if ((cx - p.x) * nx + (cz - p.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { x: nx, z: nz };
  });
  return poly.map((p, i) => {
    const a = normals[(i + n - 1) % n];
    const b = normals[i];
    let mx = a.x + b.x;
    let mz = a.z + b.z;
    const l = Math.hypot(mx, mz) || 1;
    mx /= l;
    mz /= l;
    const k = d / Math.max(0.35, mx * b.x + mz * b.z);
    return { x: p.x + mx * k, z: p.z + mz * k };
  });
}

/** Zone box: corner brackets and a dashed edge, `inset` inside a convex outline. */
function zoneBox(kit: DistrictKit, poly: Vec2[], lift: number, color: THREE.Color): void {
  const M = DRIFT_MARK;
  const inner = insetPolygon(poly, M.inset);
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1) continue;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    const br = Math.min(M.bracket, len / 2);
    groundLine(kit, kit.paint, a, { x: a.x + ux * br, z: a.z + uz * br }, M.boxWidth * 1.6, lift, color);
    groundLine(kit, kit.paint, { x: b.x - ux * br, z: b.z - uz * br }, b, M.boxWidth * 1.6, lift, color);
    for (let s = br + M.dash[1]; s + M.dash[0] < len - br; s += M.dash[0] + M.dash[1]) {
      groundLine(kit, kit.paint, { x: a.x + ux * s, z: a.z + uz * s }, { x: a.x + ux * (s + M.dash[0]), z: a.z + uz * (s + M.dash[0]) }, M.boxWidth, lift, color);
    }
  }
}

/** Studs every `gap` m round a circle. */
function studRing(kit: DistrictKit, cx: number, cz: number, r: number, gap: number, lift: number): void {
  const M = DRIFT_MARK;
  const n = Math.max(6, Math.round((2 * Math.PI * r) / gap));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const y = kit.h(x, z) + lift;
    cylinder(kit.glow, x, z, M.studR, y - 0.01, y + 0.02, 8, M.stud);
  }
}

/** Donut marks round a circle: pairs of tire tracks, partial arcs that wander in and out a little. */
function donuts(kit: DistrictKit, rng: Rng, cx: number, cz: number, r: number, spread: number, count: number, lift: number, color: THREE.Color): void {
  const M = DRIFT_MARK;
  for (let k = 0; k < count; k++) {
    const rr = r + rng.range(-spread, spread);
    const a0 = rng.range(0, Math.PI * 2);
    const span = rng.range(1.2, 3.6);
    const dr = rng.range(-1.2, 1.2);
    for (const side of [-0.5, 0.5]) arc(kit, kit.paint, cx, cz, rr + side * M.trackGap, a0, a0 + span, M.trackWidth, lift, color, dr);
  }
}

/** A lot: zone box, then skid pad circles if it is roomy, or a slalom down its middle if it is a long strip. */
function lotMarks(kit: DistrictKit, a: Area, outline: Vec2[], rubberCount: number, paint: THREE.Color, rubber: THREE.Color): void {
  const M = DRIFT_MARK;
  const f = lotFrame(a);
  const lift = M.liftLot;
  zoneBox(kit, outline, lift, paint);
  if (!f) return;
  const rng = new Rng(((a.params.seed ?? a.id) ^ 0x5d1f7) >>> 0 || 1);
  const n = Math.max(1, Math.floor(f.lu / Math.max(1, f.lw)));
  const r = Math.min(f.lw, f.lu / n) / 2 - M.circleMargin;
  if (r >= M.minCircle) {
    for (let k = 0; k < n; k++) {
      const c = at(f, (f.lu / n) * (k + 0.5), f.lw / 2);
      // Spread kept inside the circle's margin so no track spills over the lot's curb.
      donuts(kit, rng, c.x, c.z, r, M.circleMargin - M.trackGap / 2 - 0.1, rubberCount, lift - 0.004, rubber);
      arc(kit, kit.paint, c.x, c.z, r, 0, Math.PI * 2, M.circleWidth, lift, paint);
      studRing(kit, c.x, c.z, r, M.studGap * 0.75, lift);
      const y = kit.h(c.x, c.z) + lift;
      cylinder(kit.glow, c.x, c.z, M.studR * 2, y - 0.01, y + 0.02, 10, M.stud);
    }
    return;
  }
  // Slalom: studs down the middle like a gymkhana's cones, a dashed guide line, and weaving tracks.
  const v = f.lw / 2;
  const amp = Math.max(0.6, Math.min(2.2, f.lw / 2 - 1.2));
  const stops: number[] = [];
  for (let u = M.slalomGap / 2; u <= f.lu - M.slalomGap / 2; u += M.slalomGap) stops.push(u);
  for (const u of stops) {
    const p = at(f, u, v);
    const y = kit.h(p.x, p.z) + lift;
    cylinder(kit.glow, p.x, p.z, M.studR * 1.4, y - 0.01, y + 0.02, 8, M.stud);
  }
  for (let u = M.slalomGap / 2; u + 1.4 < f.lu - M.slalomGap / 2; u += 2.4) groundLine(kit, kit.paint, at(f, u, v), at(f, u + 1.4, v), M.slalomWidth, lift, paint);
  const tracks = Math.ceil(rubberCount / 3);
  for (let k = 0; k < tracks; k++) {
    const phase = rng.range(0, Math.PI * 2);
    const a2 = amp * rng.range(0.7, 1.1);
    const u0 = rng.range(0, M.slalomGap);
    const u1 = Math.min(f.lu - 1, u0 + rng.range(f.lu * 0.4, f.lu));
    for (const side of [-0.5, 0.5]) {
      let prev: Vec2 | null = null;
      for (let u = u0; u <= u1; u += 1.2) {
        const p = at(f, u, v + Math.sin(phase + (u / M.slalomGap) * Math.PI) * a2 + side * M.trackGap);
        if (prev) groundLine(kit, kit.paint, prev, p, M.trackWidth, lift - 0.004, rubber);
        prev = p;
      }
    }
  }
}

/** The plaza: zone box round the block and one big circle round the landmark, outside its benches. */
function plazaMarks(kit: DistrictKit, a: Area, rubberCount: number, paint: THREE.Color, rubber: THREE.Color): void {
  const M = DRIFT_MARK;
  const MON = CITY.districts.monument;
  const lift = M.liftPlaza;
  zoneBox(kit, a.polygon, lift, paint);
  const cx = a.params.cx;
  const cz = a.params.cz;
  const clear = a.variant === 'arch' ? MON.archGap / 2 + MON.pierWidth : MON.base + MON.steps;
  const r = Math.min(clear + MON.benchRing + M.plazaOut, distToPolygonEdge(cx, cz, a.polygon) - M.plazaMargin);
  if (r < clear + MON.benchRing + 3) return;
  const rng = new Rng(((a.params.seed ?? a.id) ^ 0x2b7c1) >>> 0 || 1);
  donuts(kit, rng, cx, cz, r, 3, Math.round(rubberCount * 1.5), lift - 0.004, rubber);
  arc(kit, kit.paint, cx, cz, r, 0, Math.PI * 2, M.circleWidth * 1.4, lift, paint);
  studRing(kit, cx, cz, r, M.studGap, lift);
}

/**
 * Soft light fading in from a convex outline's edge: a strip `width` wide
 * (mitred at the corners), bright at the edge and black inside, draped every
 * few meters so it follows the ground.
 */
function edgeWash(kit: DistrictKit, gb: GeoBuilder, poly: Vec2[], width: number, lift: number, color: THREE.Color): void {
  const n = poly.length;
  const inner = insetPolygon(poly, width);
  const black = new THREE.Color(0, 0, 0);
  const v = (p: Vec2, c: THREE.Color) => gb.vertex(p.x, kit.h(p.x, p.z) + lift, p.z, 0, 1, 0, 0, 0, c);
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ia = inner[i];
    const ib = inner[(i + 1) % n];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const o0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const o1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const i0 = { x: ia.x + (ib.x - ia.x) * t0, z: ia.z + (ib.z - ia.z) * t0 };
      const i1 = { x: ia.x + (ib.x - ia.x) * t1, z: ia.z + (ib.z - ia.z) * t1 };
      gb.quadFacing(v(o0, color), v(o1, color), v(i1, black), v(i0, black), 0, 1, 0);
    }
  }
}

export const driftZoneRenderer: DistrictRenderer = {
  kinds: ['infill', 'monument', 'parkingLot'],
  build(kit) {
    const zones = driftZones(kit.world);
    if (!zones.length) return;
    const M = DRIFT_MARK;
    const paint = col(M.paint, 0.85);
    const rubber = col(M.rubber);
    const rubberCount = M.rubberMarks[kit.quality] ?? M.rubberMarks.medium;
    const washOn = kit.quality !== 'low';
    const wash = new GeoBuilder(true);
    for (const z of zones) {
      const a = kit.world.areas[z.area];
      if (z.kind === 'plaza') plazaMarks(kit, a, rubberCount, paint, rubber);
      else lotMarks(kit, a, z.polygon, rubberCount, paint, rubber);
      if (washOn) edgeWash(kit, wash, z.polygon, z.kind === 'plaza' ? M.washPlaza : M.washLot, (z.kind === 'plaza' ? M.liftPlaza : M.liftLot) + 0.02, M.wash);
    }
    if (!wash.vertexCount) return;
    const mat = kit.track(
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    // Added light fades out with distance instead of mixing toward the fog colour (as areaLights.ts).
    mat.onBeforeCompile = (shader) => {
      heightFogShader(shader, true);
    };
    const mesh = new THREE.Mesh(kit.track(wash.build()), mat);
    mesh.name = 'driftZoneWash';
    mesh.renderOrder = 1;
    kit.group.add(mesh);
  },
};
