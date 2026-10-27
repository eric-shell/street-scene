/**
 * Plaza dressing renderer (city/districts/plazaDressing.ts is the sim half): what the infill's
 * plazas and corner pockets and the monument plaza hold beyond the clutter props. The solid
 * pieces are drawn on exactly the walls the sim made: a tree on every plaza trunk (the street
 * trees' species and builder, growStreetTree, standing in a pit ring of iron grating) and a
 * statue on its plinth, a clock column or a kiosk on every 'plaza' wall (the fountain is the
 * city's one basin, kit.fountainBasin, drawn by the infill renderer). The statue and the
 * clock face are lit from below by small flood pads and glow, so a plaza's middle reads from
 * the street. Render only, over the ground: a paving pattern per kind of plaza (stripes
 * across a street plaza, arcs round the corner of a corner pocket, never over the sidewalk or
 * the road) and the strands between the lanterns (festoon bulbs, or bunting on the monument),
 * which hang from the lanterns' heads and are drawn only between lanterns the sim really
 * placed, so a strand never ties to nothing. All of it merges into the district kit's
 * builders (ground, paint, solid, glow, trees): no draw call, no per-frame work.
 */
import * as THREE from 'three';
import { CITY, STREET_TREES } from '../../city/config';
import type { Area, AreaBuild } from '../../city/districts/types';
import { PLAZA_HINT } from '../../city/districts/plazaDressing';
import { distToPolygonEdge, pointInPolygon } from '../../city/districts/geom';
import type { Vec2 } from '../../sim/math';
import { regionAt } from '../buildings/architecture';
import { PARK_LANTERN_Y } from '../street/propGeometry';
import type { DistrictKit } from './kit';
import { col, cylinder, groundLine, orientedBox } from './kit';
import { growStreetTree } from './streetTrees';

const PLAZA_LOOK = {
  /** Pit ring round a trunk: the iron grating's radius and its darker inner disc (m). */
  pit: { r: 1.05, inner: 0.8, ring: col(0x4a4b52), grate: col(0x23242a) },
  /** Paving patterns: line width (m), piece length (m), the inset from the plaza's sides (m), the radii step of the corner arcs (m), the stripe step of the street plaza (m). */
  paving: { width: 0.16, piece: 3.2, inset: 0.7, arcStep: 3.2, stripeStep: 2.4, plaza: col(0x848690), corner: col(0x8a8179), border: col(0x7a7c86) },
  /** Strands: bulb gain and colour, wire colour, the tie's drop under the lantern head (m), sag as a share of the span plus a floor (m), bulb pitch (m), bunting pitch and size (m). */
  strand: { bulb: new THREE.Color(1, 0.78, 0.43).multiplyScalar(2.2), wire: col(0x101114), drop: 0.15, sag: 0.035, sagBase: 0.35, pitch: 1.2, bulbR: 0.1, bulbH: 0.22, flag: 0.42, flagPitch: 0.9 },
  stone: col(0x5c5d66),
  stoneTop: col(0x7a7b84),
  iron: col(0x25262c),
  bronze: col(0x54482f),
  warm: new THREE.Color(1, 0.84, 0.62),
  face: new THREE.Color(1, 0.92, 0.68).multiplyScalar(1.5),
  kiosk: [col(0x3b5f66), col(0x6a3a3f), col(0x7d6a32), col(0x3d4f7a)],
  window: new THREE.Color(1, 0.8, 0.5).multiplyScalar(1.3),
  bunting: [0xffd27a, 0xff4a4a, 0xf2f2f2, 0x5aa0ff, 0x7cff9a].map((c) => col(c, 0.6)),
} as const;

/** A position hash in [0, 1) (render only: the same city draws the same piece). */
function hash(x: number, z: number, k: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

/** Paint a line from a to b in pieces, keeping only the pieces whose ends are inside the plaza by `inset` (m). */
function line(kit: DistrictKit, poly: Vec2[], a: Vec2, b: Vec2, color: THREE.Color, lift: number): void {
  const L = PLAZA_LOOK.paving;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / L.piece));
  const on = (p: Vec2) => pointInPolygon(p.x, p.z, poly) && distToPolygonEdge(p.x, p.z, poly) > L.inset;
  for (let k = 0; k < n; k++) {
    const p = { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n };
    const q = { x: a.x + ((b.x - a.x) * (k + 1)) / n, z: a.z + ((b.z - a.z) * (k + 1)) / n };
    if (on(p) && on(q)) groundLine(kit, kit.paint, p, q, L.width, lift, color);
  }
}

/** A street plaza's stripes run along the street, a corner pocket's arcs round its corner: a different floor to the sidewalk's, and to each other's. */
function paving(kit: DistrictKit, a: Area): void {
  const P = a.params;
  if (P.lu === undefined || Math.min(P.lu, P.lw) < 7) return;
  const L = PLAZA_LOOK.paving;
  const lift = CITY.curbHeight + 0.03;
  const at = (u: number, w: number): Vec2 => ({ x: P.ox + P.ux * u + P.wx * w, z: P.oz + P.uz * u + P.wz * w });
  if (a.variant === 'plaza') {
    for (let v = L.stripeStep; v < P.lw - 0.5; v += L.stripeStep) line(kit, a.polygon, at(0, v), at(P.lu, v), L.plaza, lift);
    // A border band just inside the back and the ends.
    line(kit, a.polygon, at(0.4, P.lw - 0.5), at(P.lu - 0.4, P.lw - 0.5), L.border, lift);
    return;
  }
  const reach = Math.max(P.lu, P.lw);
  for (let r = L.arcStep; r < reach; r += L.arcStep) {
    const n = Math.max(4, Math.ceil((r * Math.PI) / 2 / L.piece));
    for (let k = 0; k < n; k++) {
      const t0 = (k / n) * (Math.PI / 2);
      const t1 = ((k + 1) / n) * (Math.PI / 2);
      line(kit, a.polygon, at(Math.cos(t0) * r, Math.sin(t0) * r), at(Math.cos(t1) * r, Math.sin(t1) * r), L.corner, lift);
    }
  }
}

/** A tree's pit: an iron ring and a dark grating, flush with the paving. */
function treePit(kit: DistrictKit, x: number, z: number, lift: number): void {
  const P = PLAZA_LOOK.pit;
  const y = kit.h(x, z) + lift;
  cylinder(kit.ground, x, z, P.r, y - 0.02, y + 0.012, 12, P.ring);
  cylinder(kit.ground, x, z, P.inner, y + 0.005, y + 0.02, 12, P.grate);
}

/** The statue: a stepped stone plinth under a bronze figure with a raised torch, flood pads on the plinth's foot. */
function statue(kit: DistrictKit, x: number, z: number, R: number): void {
  const y = kit.h(x, z) + CITY.curbHeight;
  const L = PLAZA_LOOK;
  cylinder(kit.solid, x, z, R * 1.02, y - 0.1, y + 0.35, 8, L.stone, true);
  cylinder(kit.solid, x, z, R * 0.82, y + 0.3, y + 1.5, 8, L.stoneTop, true);
  cylinder(kit.solid, x, z, R * 0.95, y + 1.5, y + 1.64, 8, L.stone, true);
  // Figure: legs, coat, head and an arm up with a flame.
  cylinder(kit.solid, x, z, 0.2, y + 1.64, y + 2.5, 6, L.bronze, true, 0.26);
  cylinder(kit.solid, x, z, 0.3, y + 2.5, y + 3.2, 6, L.bronze, true, 0.2);
  cylinder(kit.solid, x, z, 0.13, y + 3.2, y + 3.5, 6, L.bronze, true, 0.11);
  cylinder(kit.solid, x + 0.27, z, 0.055, y + 2.85, y + 3.6, 5, L.bronze, true);
  cylinder(kit.glow, x + 0.27, z, 0.09, y + 3.6, y + 3.78, 6, L.warm.clone().multiplyScalar(2.2), true, 0.02);
  // The plinth's uplight: a warm disc on the paving and a pad at each corner.
  cylinder(kit.glow, x, z, R + 0.55, y + 0.012, y + 0.035, 16, L.warm.clone().multiplyScalar(0.45));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    cylinder(kit.glow, x + Math.sin(a) * (R + 0.35), z + Math.cos(a) * (R + 0.35), 0.1, y + 0.02, y + 0.12, 6, L.warm.clone().multiplyScalar(1.6));
  }
}

/** The clock column: a stone foot, an iron shaft, a four faced lit clock head under a cap. */
function clock(kit: DistrictKit, x: number, z: number, R: number): void {
  const y = kit.h(x, z) + CITY.curbHeight;
  const L = PLAZA_LOOK;
  cylinder(kit.solid, x, z, R, y - 0.1, y + 0.55, 8, L.stone, true, R * 0.7);
  cylinder(kit.solid, x, z, 0.2, y + 0.5, y + 3.5, 8, L.iron, true, 0.16);
  cylinder(kit.solid, x, z, 0.3, y + 3.45, y + 3.6, 8, L.iron, true);
  // The head: an octagon with a pale face on each of the four sides.
  cylinder(kit.solid, x, z, 0.52, y + 3.6, y + 4.25, 4, L.iron, true, 0.52);
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const nx = Math.sin(a);
    const nz = Math.cos(a);
    const cx = x + nx * 0.54;
    const cz = z + nz * 0.54;
    orientedBox(kit.glow, cx - nz * 0.3, cz + nx * 0.3, cx + nz * 0.3, cz - nx * 0.3, nx * 0.03, nz * 0.03, y + 3.7, y + 4.15, L.face);
  }
  cylinder(kit.solid, x, z, 0.62, y + 4.25, y + 4.45, 4, L.iron, true, 0.5);
  cylinder(kit.solid, x, z, 0.3, y + 4.45, y + 4.65, 6, L.iron, true, 0.04);
  cylinder(kit.glow, x, z, R + 0.45, y + 0.012, y + 0.03, 14, L.warm.clone().multiplyScalar(0.35));
}

/** The kiosk: a counter and a lit window band under a conical roof, eight posts between (hue by its position). */
function kiosk(kit: DistrictKit, x: number, z: number, R: number): void {
  const y = kit.h(x, z) + CITY.curbHeight;
  const L = PLAZA_LOOK;
  const body = L.kiosk[Math.floor(hash(x, z, 1) * L.kiosk.length)];
  const r = R * 0.88;
  cylinder(kit.solid, x, z, R, y - 0.1, y + 0.95, 8, body, true);
  cylinder(kit.glow, x, z, r + 0.02, y + 0.95, y + 1.95, 8, L.window, false);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    cylinder(kit.solid, x + Math.sin(a) * (r + 0.03), z + Math.cos(a) * (r + 0.03), 0.07, y + 0.9, y + 2.0, 5, L.iron, true);
  }
  cylinder(kit.solid, x, z, r, y + 1.95, y + 2.12, 8, body, true);
  cylinder(kit.solid, x, z, R + 0.45, y + 2.12, y + 2.8, 8, L.iron, true, 0.18);
  cylinder(kit.glow, x, z, 0.07, y + 2.8, y + 2.95, 5, L.warm.clone().multiplyScalar(2));
  cylinder(kit.glow, x, z, R + 0.5, y + 0.012, y + 0.03, 14, L.warm.clone().multiplyScalar(0.35));
}

/** The point on a strand at fraction t, sagging at the middle (a parabola, like stringLights.ts). */
function onStrand(a: THREE.Vector3, b: THREE.Vector3, sag: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  out.lerpVectors(a, b, t);
  out.y -= sag * 4 * t * (1 - t);
  return out;
}

/** One strand between two lantern heads: a wire and festoon bulbs, or bunting pennants on it. */
function strand(kit: DistrictKit, a: THREE.Vector3, b: THREE.Vector3, bunting: boolean): void {
  const S = PLAZA_LOOK.strand;
  const span = a.distanceTo(b);
  const sag = S.sagBase + S.sag * span;
  const n = Math.max(2, Math.round(span / (bunting ? S.flagPitch : S.pitch)));
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  const along = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
  const wires = Math.max(2, Math.round(span / 3));
  for (let i = 0; i < wires; i++) {
    onStrand(a, b, sag, i / wires, p);
    onStrand(a, b, sag, (i + 1) / wires, q);
    // The wire in pieces: a thin vertical-free sliver between the two points (a quad one thread wide).
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    const gb = kit.solid;
    const w = 0.012;
    const v0 = gb.vertex(p.x - (dz / l) * w, p.y, p.z + (dx / l) * w, 0, 1, 0, 0, 0, S.wire);
    const v1 = gb.vertex(q.x - (dz / l) * w, q.y, q.z + (dx / l) * w, 0, 1, 0, 0, 0, S.wire);
    const v2 = gb.vertex(q.x + (dz / l) * w, q.y, q.z - (dx / l) * w, 0, 1, 0, 0, 0, S.wire);
    const v3 = gb.vertex(p.x + (dz / l) * w, p.y, p.z - (dx / l) * w, 0, 1, 0, 0, 0, S.wire);
    gb.quad(v0, v1, v2, v3);
    gb.quad(v3, v2, v1, v0);
  }
  for (let k = 1; k < n; k++) {
    onStrand(a, b, sag, k / n, p);
    if (!bunting) {
      cylinder(kit.glow, p.x, p.z, S.bulbR, p.y - S.bulbH, p.y, 5, S.bulb.clone().multiplyScalar(k % 2 ? 0.75 : 1), false);
      continue;
    }
    // A pennant: a triangle hanging from the wire, drawn from both sides.
    const c = PLAZA_LOOK.bunting[Math.floor(hash(p.x, p.z, k) * PLAZA_LOOK.bunting.length)];
    const h = S.flag * 1.3;
    const gb = kit.glow;
    const v0 = gb.vertex(p.x - along.x * S.flag * 0.5, p.y, p.z - along.z * S.flag * 0.5, 0, 0, 1, 0, 0, c);
    const v1 = gb.vertex(p.x + along.x * S.flag * 0.5, p.y, p.z + along.z * S.flag * 0.5, 0, 0, 1, 1, 0, c);
    const v2 = gb.vertex(p.x, p.y - h, p.z, 0, 0, 1, 0.5, 1, c);
    gb.tri(v0, v1, v2);
    gb.tri(v2, v1, v0);
  }
}

/**
 * Everything the plazaDressing sim half left for the renderer on one area's build `b`: its trees and pits,
 * its centrepiece, its paving and its strands. The infill renderer calls it for plazas and corner pockets,
 * the monument renderer for the monument plaza.
 */
export function drawPlazaDressing(kit: DistrictKit, a: Area, b: AreaBuild): void {
  const lift = CITY.curbHeight;
  const region = regionAt(kit.world);
  for (const p of b.props) {
    if (p.kind === 'tree') {
      growStreetTree(kit, region, { x: p.x, z: p.z, y: kit.h(p.x, p.z) + lift, radius: STREET_TREES.trunkRadius, size: p.size, height: p.height });
      treePit(kit, p.x, p.z, lift);
    } else if (p.kind === 'statue') statue(kit, p.x, p.z, p.size);
    else if (p.kind === 'clock') clock(kit, p.x, p.z, p.size);
    else if (p.kind === 'kiosk') kiosk(kit, p.x, p.z, p.size);
  }
  if (a.kind === 'infill') paving(kit, a);
  drawStrands(kit, a, b);
}

/** The strands of an area's hints (a plaza's, the monument's, a roundabout plaza's): tied to the lanterns the sim placed (a lamp a neighbour overlapped was dropped), looked up by spot. */
export function drawStrands(kit: DistrictKit, a: Area, b: AreaBuild): void {
  if (!b.hints.some((h) => h.kind === PLAZA_HINT.strand)) return;
  const lamps = kit.world.props.filter((p) => p.kind === 'parkLamp' && p.area === a.id);
  const head = (q: Vec2): THREE.Vector3 | null => {
    const l = lamps.find((m) => (m.x - q.x) ** 2 + (m.z - q.z) ** 2 < 0.01);
    return l ? new THREE.Vector3(l.x, l.y + PARK_LANTERN_Y + 0.1 - PLAZA_LOOK.strand.drop, l.z) : null;
  };
  for (const h of b.hints) {
    if (h.kind !== PLAZA_HINT.strand) continue;
    const p = head(h.points[0]);
    const q = head(h.points[1]);
    if (p && q) strand(kit, p, q, h.values[0] === 1);
  }
}
