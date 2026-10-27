/**
 * Parking lot renderer (city/districts/parkingLot.ts): everything of an open-air lot that is not a car
 * (the parked cars are sim bodies, drawn by the traffic view, and the lamps and dumpsters are props).
 * All of it is read off the lot's layout (parkingLot/layout.ts), the same one the sim built its walls from:
 *  - the asphalt apron, draped on the terrain, with the bay lines painted in rows (no arrows, no signs: the
 *    way in and out is the gap in the fence and the lamps' glow), the planted islands and their trunks'
 *    trees, oil stains under some of the bays and puddles on the aisles (Medium and up);
 *  - concrete wheel stops at the back of every bay (Medium and up), a drive-over bump low enough that
 *    no wall is owed to it;
 *  - the fence round the street and back edges: a concrete kerb, posts and rails (chain link would be a
 *    translucent mesh; the rails and posts carry the same silhouette for a fraction of the triangles), with a
 *    taller post each side of every curb cut;
 *  - the ticket booth on its island between the entrance and the exit (a lit window to each lane and a blue
 *    P on a pole) and the cart corrals at the back, rails round a few shopping carts.
 * Merged into the district kit's builders, so a lot adds no draw calls; built once, no per frame work.
 */
import type * as THREE from 'three';
import { PARKING_LOT as C } from '../../city/config';
import { lotCuts, lotLayout } from '../../city/districts/parkingLot';
import { lotFrame, lotPoint } from '../../city/districts/parkingLot/layout';
import type { Area } from '../../city/districts/types';
import type { Vec2 } from '../../sim/math';
import { Rng, deriveSeed } from '../../sim/prng';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col, cylinder, drapeConvex, groundLine, groundVertex, orientedBox, prism } from './kit';
import { tree } from './trees';

const LOOK = {
  asphalt: col(0x2a2c33),
  paint: col(0xd8dce6, 0.8),
  concrete: col(0x70727b),
  kerb: col(0x5f6169),
  steel: col(0x6a6e76),
  grass: col(0x2c4a2a),
  oil: col(0x0d0e12),
  puddle: col(0x0b0f1a),
  boothBody: col(0x3a3c44),
  boothRoof: col(0x24252a),
  glass: col(0xffd9a0, 0.55),
  sign: col(0x2a6cff, 1.3),
  white: col(0xf2f4f8, 1.4),
  cart: col(0x9aa0aa),
  cartHandle: col(0xc2402e),
} as const;

/** Sizes (m) of the drawn parts. */
const SIZE = {
  paintWidth: 0.12,
  paintLift: 0.05,
  islandLift: 0.06,
  stop: { width: 1.6, depth: 0.18, height: 0.12, fromBack: 0.9 },
  rail: 0.05,
  post: 0.045,
  gatePost: { half: 0.14, height: 2.5 },
  step: 3,
} as const;

/** A flat blob (a puddle, an oil stain) on the ground: a fan of `n` points on an ellipse. */
function blob(kit: DistrictKit, x: number, z: number, rx: number, rz: number, yaw: number, color: THREE.Color, lift: number, n = 9): void {
  const c = groundVertex(kit, kit.paint, x, z, lift, color);
  const ring: number[] = [];
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // A little lumpy: the radius varies with the angle.
    const k = 1 + 0.18 * Math.sin(a * 3 + x * 7.3 + z * 3.1);
    const lx = Math.cos(a) * rx * k;
    const lz = Math.sin(a) * rz * k;
    ring.push(groundVertex(kit, kit.paint, x + lx * cs - lz * sn, z + lx * sn + lz * cs, lift, color));
  }
  for (let i = 0; i < n; i++) kit.paint.triFacing(c, ring[i], ring[(i + 1) % n], 0, 1, 0);
}

/** An axis box of the fence or a booth along the segment a-b with `thick` toward (nx, nz), from y0 to y1. */
const slab = (kit: DistrictKit, a: Vec2, b: Vec2, nx: number, nz: number, thick: number, y0: number, y1: number, color: THREE.Color): void => orientedBox(kit.solid, a.x, a.z, b.x, b.z, nx * thick, nz * thick, y0, y1, color);

/** The fence: kerb, posts and two rails along every piece, in steps of SIZE.step, and a tall post each side of a curb cut. */
function fence(kit: DistrictKit, a: Area): void {
  const L = lotLayout(a);
  const F = C.fence;
  const low = kit.quality === 'low';
  for (const p of L.fences) {
    const len = Math.hypot(p.bx - p.ax, p.bz - p.az);
    const k = Math.max(1, Math.round(len / SIZE.step));
    for (let i = 0; i < k; i++) {
      const A = { x: p.ax + ((p.bx - p.ax) * i) / k, z: p.az + ((p.bz - p.az) * i) / k };
      const B = { x: p.ax + ((p.bx - p.ax) * (i + 1)) / k, z: p.az + ((p.bz - p.az) * (i + 1)) / k };
      const base = Math.min(kit.h(A.x, A.z), kit.h(B.x, B.z), kit.h(A.x + p.nx * F.thickness, A.z + p.nz * F.thickness), kit.h(B.x + p.nx * F.thickness, B.z + p.nz * F.thickness));
      slab(kit, A, B, p.nx, p.nz, F.thickness, base - 0.15, base + F.kerb, LOOK.kerb);
      // Posts and rails stand on the kerb's inner half (toward the lot) so the fence line is the wall's outer face.
      const m = F.thickness * 0.5;
      const ra = { x: A.x + p.nx * m, z: A.z + p.nz * m };
      const rb = { x: B.x + p.nx * m, z: B.z + p.nz * m };
      cylinder(kit.solid, ra.x, ra.z, SIZE.post, base + F.kerb - 0.02, base + F.height, 5, LOOK.steel, false);
      slab(kit, ra, rb, p.nx, p.nz, SIZE.rail, base + F.height - 0.1, base + F.height - 0.05, LOOK.steel);
      if (!low) slab(kit, ra, rb, p.nx, p.nz, SIZE.rail, base + F.kerb + 0.5, base + F.kerb + 0.55, LOOK.steel);
    }
  }
  // Gate posts: a taller post each side of every cut, on the fence line.
  const poly = a.polygon;
  for (const c of lotCuts(a)) {
    const P = poly[c.edge];
    const Q = poly[(c.edge + 1) % poly.length];
    const len = Math.hypot(Q.x - P.x, Q.z - P.z) || 1;
    const dx = (Q.x - P.x) / len;
    const dz = (Q.z - P.z) / len;
    const e = L.fences.find((f) => f.edge === c.edge);
    if (!e) continue;
    for (const sg of [-1, 1]) {
      const t = c.t + sg * (c.hw + SIZE.gatePost.half + 0.05);
      const x = P.x + dx * t + e.nx * F.thickness * 0.5;
      const z = P.z + dz * t + e.nz * F.thickness * 0.5;
      const y = kit.h(x, z);
      slab(kit, { x: x - SIZE.gatePost.half, z: z - SIZE.gatePost.half }, { x: x + SIZE.gatePost.half, z: z - SIZE.gatePost.half }, 0, 1, SIZE.gatePost.half * 2, y - 0.1, y + SIZE.gatePost.height, LOOK.concrete);
    }
  }
}

/** The booth on its island and the lit P on a pole. */
function booth(kit: DistrictKit, a: Area): void {
  const L = lotLayout(a);
  const B = L.booth;
  if (!B) return;
  const isl = B.island;
  const y = Math.max(...isl.map((p) => kit.h(p.x, p.z)));
  prism(kit, kit.solid, isl, C.island.kerb, LOOK.kerb, LOOK.concrete, 0.3);
  // Axes: d along the island's width, n along its length (into the lot).
  const dx = isl[1].x - isl[0].x;
  const dz = isl[1].z - isl[0].z;
  const dl = Math.hypot(dx, dz) || 1;
  const d = { x: dx / dl, z: dz / dl };
  const n = { x: isl[3].x - isl[0].x, z: isl[3].z - isl[0].z };
  const nl = Math.hypot(n.x, n.z) || 1;
  n.x /= nl;
  n.z /= nl;
  const top = y + C.island.kerb;
  const hw = C.island.boothWidth / 2;
  const hd = C.island.boothDepth / 2;
  const corner = (u: number, v: number): Vec2 => ({ x: B.x + d.x * u + n.x * v, z: B.z + d.z * u + n.z * v });
  orientedBox(kit.solid, corner(-hw, -hd).x, corner(-hw, -hd).z, corner(hw, -hd).x, corner(hw, -hd).z, n.x * hd * 2, n.z * hd * 2, top, top + C.island.boothHeight, LOOK.boothBody);
  const ro = 0.25;
  orientedBox(kit.solid, corner(-hw - ro, -hd - ro).x, corner(-hw - ro, -hd - ro).z, corner(hw + ro, -hd - ro).x, corner(hw + ro, -hd - ro).z, n.x * (hd * 2 + ro * 2), n.z * (hd * 2 + ro * 2), top + C.island.boothHeight, top + C.island.boothHeight + 0.14, LOOK.boothRoof);
  // A window toward each lane (the island's two long sides), lit.
  for (const sg of [-1, 1]) {
    const a0 = corner(sg * (hw + 0.02), -hd + 0.25);
    const a1 = corner(sg * (hw + 0.02), hd - 0.25);
    orientedBox(kit.glow, a0.x, a0.z, a1.x, a1.z, d.x * sg * 0.03, d.z * sg * 0.03, top + 1.05, top + 1.95, LOOK.glass);
  }
  // The P: a blue panel on a pole at the booth's back corner, read from the entrance side.
  const pole = corner(hw + 0.5, hd - 0.2);
  const py = kit.h(pole.x, pole.z);
  cylinder(kit.solid, pole.x, pole.z, 0.06, py - 0.1, py + 4.1, 6, LOOK.steel, false);
  const panel = (u0: number, u1: number, v0: number, v1: number, c: THREE.Color, off: number) => {
    const p0 = { x: pole.x + n.x * u0 - d.x * off, z: pole.z + n.z * u0 - d.z * off };
    const p1 = { x: pole.x + n.x * u1 - d.x * off, z: pole.z + n.z * u1 - d.z * off };
    orientedBox(kit.glow, p0.x, p0.z, p1.x, p1.z, -d.x * 0.03, -d.z * 0.03, py + v0, py + v1, c);
  };
  panel(-0.4, 0.4, 3.4, 4.4, LOOK.sign, 0.04);
  panel(-0.12, -0.02, 3.55, 4.25, LOOK.white, 0.08);
  panel(-0.12, 0.2, 4.15, 4.25, LOOK.white, 0.08);
  panel(-0.12, 0.2, 3.85, 3.95, LOOK.white, 0.08);
  panel(0.1, 0.2, 3.85, 4.25, LOOK.white, 0.08);
}

/** Cart corrals: posts and two rails round the footprint, carts nested inside. */
function corrals(kit: DistrictKit, a: Area): void {
  const L = lotLayout(a);
  for (const c of L.corrals) {
    const p = c.poly;
    const y = Math.max(...p.map((q) => kit.h(q.x, q.z)));
    for (let i = 0; i < 4; i++) {
      const A = p[i];
      const B = p[(i + 1) % 4];
      cylinder(kit.solid, A.x, A.z, 0.05, y, y + 1.1, 5, LOOK.steel, false);
      for (const h of [0.45, 1.0]) {
        const dx = B.x - A.x;
        const dz = B.z - A.z;
        const l = Math.hypot(dx, dz) || 1;
        orientedBox(kit.solid, A.x, A.z, B.x, B.z, (-dz / l) * 0.04, (dx / l) * 0.04, y + h - 0.02, y + h + 0.02, LOOK.steel);
      }
    }
    // The carts nested along the long axis: a basket and a red handle each.
    const ax = p[1].x - p[0].x;
    const az = p[1].z - p[0].z;
    const al = Math.hypot(ax, az) || 1;
    const u = { x: ax / al, z: az / al };
    const v = { x: -u.z, z: u.x };
    const n = Math.floor((al - 0.8) / 0.55);
    for (let k = 0; k < n; k++) {
      const t = 0.4 + k * 0.55 + 0.275;
      const cx = p[0].x + u.x * t + v.x * (C.corral.width / 2);
      const cz = p[0].z + u.z * t + v.z * (C.corral.width / 2);
      orientedBox(kit.solid, cx - u.x * 0.25 - v.x * 0.3, cz - u.z * 0.25 - v.z * 0.3, cx + u.x * 0.25 - v.x * 0.3, cz + u.z * 0.25 - v.z * 0.3, v.x * 0.6, v.z * 0.6, y + 0.3, y + 0.85, LOOK.cart);
      orientedBox(kit.solid, cx - u.x * 0.25 - v.x * 0.3, cz - u.z * 0.25 - v.z * 0.3, cx - u.x * 0.2 - v.x * 0.3, cz - u.z * 0.2 - v.z * 0.3, v.x * 0.6, v.z * 0.6, y + 0.85, y + 0.95, LOOK.cartHandle);
    }
  }
}

function lot(kit: DistrictKit, a: Area): void {
  const L = lotLayout(a);
  const frame = lotFrame(a);
  const W = (u: number, w: number): Vec2 => lotPoint(frame, u, w);
  const medium = kit.quality !== 'low';
  drapeConvex(kit, kit.ground, a.polygon, 0.03, LOOK.asphalt, 8);

  // Bay lines: a stroke at each side of every bay, from the open side to the back line.
  for (const row of L.rows) {
    const wa = row.open === -1 ? row.w0 : row.w1;
    const wb = row.open === -1 ? row.w1 : row.w0;
    for (let k = 0; k <= row.n; k++) {
      const u = row.ub + k * C.bayWidth;
      groundLine(kit, kit.paint, W(u, wa), W(u, wb), SIZE.paintWidth, SIZE.paintLift, LOOK.paint);
    }
  }
  // Tree islands: a planted patch with a pale border, the tree on it.
  const grassLift = SIZE.islandLift;
  for (const isl of L.islands) {
    const r = isl.rect;
    const q = [W(r.u0, r.w0), W(r.u1, r.w0), W(r.u1, r.w1), W(r.u0, r.w1)];
    drapeConvex(kit, kit.paint, q, grassLift, LOOK.grass, 3);
    for (let i = 0; i < 4; i++) groundLine(kit, kit.paint, q[i], q[(i + 1) % 4], 0.22, grassLift + 0.012, LOOK.concrete);
  }
  for (const p of kit.builds[a.id].props) if (p.kind === 'tree') tree(kit, p.x, p.z, p.size, p.height, { conifer: 0.1 });

  if (medium) {
    // Wheel stops at the back of every bay that is not an island.
    const S = SIZE.stop;
    L.bays.forEach((bay) => {
      const row = L.rows[bay.row];
      const island = L.islands.some((i) => bay.u >= i.rect.u0 - 1e-6 && bay.u <= i.rect.u1 + 1e-6 && bay.w >= i.rect.w0 && bay.w <= i.rect.w1);
      if (island) return;
      const back = row.open === -1 ? row.w1 : row.w0;
      const w = back + row.open * S.fromBack;
      const A = W(bay.u - S.width / 2, w);
      const B = W(bay.u + S.width / 2, w);
      const base = Math.min(kit.h(A.x, A.z), kit.h(B.x, B.z));
      orientedBox(kit.solid, A.x, A.z, B.x, B.z, frame.w.x * S.depth, frame.w.z * S.depth, base - 0.05, base + S.height, LOOK.concrete);
    });
    // Oil under some of the bays, puddles on the aisles and the forecourt: stains seeded per lot.
    const rng = new Rng(deriveSeed(a.params.seed, 'lotDecals'));
    for (const car of L.cars) if (rng.next() < 0.3) blob(kit, car.x + rng.range(-0.3, 0.3), car.z + rng.range(-0.3, 0.3), rng.range(0.25, 0.5), rng.range(0.2, 0.4), rng.range(0, 6.28), LOOK.oil, 0.045);
    const wet: { u0: number; u1: number; w0: number; w1: number }[] = [...L.aisles];
    if (L.zone) wet.push(L.zone);
    for (const r of wet) {
      const k = 1 + Math.floor(((r.u1 - r.u0) * (r.w1 - r.w0)) / 450);
      for (let i = 0; i < k; i++) {
        const u = r.u0 + 3 + rng.next() * Math.max(0, r.u1 - r.u0 - 6);
        const w = r.w0 + 1.5 + rng.next() * Math.max(0, r.w1 - r.w0 - 3);
        const p = W(u, w);
        blob(kit, p.x, p.z, rng.range(0.7, 2.2), rng.range(0.5, 1.4), rng.range(0, 6.28), LOOK.puddle, 0.04, 11);
      }
    }
  }
  fence(kit, a);
  booth(kit, a);
  corrals(kit, a);
}

export const parkingLotRenderer: DistrictRenderer = {
  kinds: ['parkingLot'],
  build(kit, areas) {
    for (const a of areas) lot(kit, a);
  },
};
