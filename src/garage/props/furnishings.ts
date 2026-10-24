/**
 * Seats, bins, boxes and the coffee corner: the rolling stool and creeper
 * seat, the bins, rag can and wheel boxes, the coffee corner, and the
 * flagship tuners' cabs with their lit nameplates (cellPlane cuts one cell out
 * of an atlas for them). Render only.
 */
import * as THREE from 'three';
import { caster } from './kit';
import type { Kit } from './kit';
import { carryBox, rollCab } from './toolStorage';
import { BADGES } from './materials';
import { wallCabinets } from './wallDressing';

/** A rolling shop stool: five-star base on casters, gas column, foot ring and the round seat. */
export function rollingStool(k: Kit, x: number, z: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5 + 0.4;
    k.bar(m.chrome, [0, 0.1, 0], [Math.cos(a) * 0.26, 0.08, Math.sin(a) * 0.26], 0.025);
    caster(k, Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.07);
  }
  k.cyl(m.black, 0.03, 0.3, 0, 0.25, 0, 'y', 10);
  k.cyl(m.chrome, 0.02, 0.14, 0, 0.45, 0, 'y', 8);
  k.add(m.chrome, new THREE.TorusGeometry(0.17, 0.01, 6, 20), 0, 0.3, 0, 0, Math.PI / 2);
  k.cyl(m.black, 0.18, 0.08, 0, 0.55, 0, 'y', 18);
}

/** A creeper seat: the low frame on four casters, the parts tray under it, the post and the seat. */
export function creeperSeat(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.steel, 0.4, 0.03, 0.5, 0, 0.11, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) caster(k, sx * 0.16, sz * 0.21, 0.095);
  k.box(m.red, 0.38, 0.02, 0.3, 0, 0.14, 0.04);
  for (const s of [-1, 1]) k.box(m.red, 0.38, 0.04, 0.012, 0, 0.17, 0.04 + s * 0.15);
  k.cyl(m.chrome, 0.025, 0.28, 0, 0.27, -0.12, 'y', 8);
  k.box(m.black, 0.32, 0.07, 0.3, 0, 0.44, -0.08);
  for (let i = 0; i < 4; i++) k.cyl(m.chrome, 0.012, 0.03, -0.1 + i * 0.06, 0.165, 0.08, 'y', 8);
}

/** A big grey shop bin with rags spilling over its rim. */
export function trashCan(k: Kit, x: number, z: number, r = 0.28): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.cyl(m.primer, r, 0.85, 0, 0.425, 0, 'y', 18, r * 0.85);
  k.add(m.primer, new THREE.TorusGeometry(r, 0.02, 6, 20), 0, 0.85, 0, 0, Math.PI / 2);
  k.box(m.orange, r * 1.1, 0.08, r * 0.8, 0.04, 0.86, 0.02, 0.5, 0.2);
  k.box(m.cardboard, r * 0.8, 0.06, r * 0.6, -0.06, 0.88, -0.05, -0.3, -0.15);
}

/** A red oily-rag can with its domed lid and foot pedal. */
export function ragBin(k: Kit, x: number, z: number): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.cyl(m.red, 0.2, 0.5, 0, 0.26, 0, 'y', 16);
  k.add(m.red, new THREE.SphereGeometry(0.205, 16, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.35, 1), 0, 0.51, 0);
  k.box(m.black, 0.12, 0.03, 0.12, 0, 0.04, 0.24);
  k.box(m.yellow, 0.14, 0.08, 0.004, 0, 0.3, 0.201);
}

/** A stack of wheel boxes, flat squares a little askew, the brand on each. */
export function wheelBoxes(k: Kit, x: number, z: number, n: number, mat: THREE.Material): void {
  k.place(x, 0, z, 0);
  for (let i = 0; i < n; i++) k.box(mat, 0.72, 0.3, 0.72, (i % 2) * 0.04, 0.15 + i * 0.3, -(i % 3) * 0.03, i * 0.12 - 0.1);
}

/**
 * The coffee corner against a wall: a mini fridge with its stickers and the
 * coffee maker, mugs and a towel roll on top (the beer cooler stands beside it).
 */
export function coffeeCorner(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.enamel, 0.5, 0.85, 0.55, 0, 0.44, 0);
  k.box(m.black, 0.5, 0.02, 0.55, 0, 0.01, 0);
  k.box(m.black, 0.48, 0.006, 0.006, 0, 0.62, 0.278);
  k.box(m.galv, 0.02, 0.24, 0.03, 0.2, 0.45, 0.29);
  k.box(m.yellow, 0.1, 0.06, 0.004, -0.1, 0.4, 0.276, 0, 0, 0.2);
  k.box(m.blue, 0.08, 0.08, 0.004, 0.05, 0.3, 0.276, 0, 0, -0.1);
  k.box(m.red, 0.12, 0.05, 0.004, -0.05, 0.72, 0.276);
  // On top: the coffee maker with its warm light, the carafe, mugs, the towel roll.
  k.box(m.black, 0.2, 0.32, 0.22, -0.1, 1.03, -0.05);
  k.box(m.black, 0.2, 0.04, 0.3, -0.1, 0.89, -0.01);
  k.cyl(m.carbon, 0.06, 0.12, -0.1, 0.97, 0.06, 'y', 12);
  k.box(m.lamp, 0.015, 0.015, 0.004, -0.03, 1.12, 0.062);
  for (const [dx, c] of [
    [0.08, m.red],
    [0.16, m.enamel],
    [0.12, m.black],
  ] as const)
    k.cyl(c, 0.04, 0.09, dx, 0.915, c === m.black ? -0.1 : 0.08 - (dx - 0.08), 'y', 10);
  k.cyl(m.enamel, 0.06, 0.24, 0.17, 1.12, -0.15, 'x', 12);
}

/** A flagship cab's configuration. */
export interface CabStyle {
  body: THREE.Material;
  fronts: THREE.Material;
  /** The accent light's strip material and its pool on the floor. */
  accent: THREE.Material;
  glow: THREE.Material;
  /** Row of BADGES on its nameplate. */
  badge: number;
  /** A hutch with full-height lockers, or a top chest with the lockers at its height. */
  top: 'hutch' | 'chest';
  lockers: -1 | 1 | 2;
  /** Doors in the run of wall cabinets over it, and their center height (m). */
  cabinets: number;
  cabinetY: number;
}

/**
 * A showpiece roll cab along local x, the rollCab with everything: glossy
 * paint, a hutch and full-height side lockers or a top chest with lockers to
 * match, chrome pulls on every drawer, a drawer pulled out, seams and an
 * underglow in the accent light pooling on a rubber mat, a lit nameplate,
 * a run of wall cabinets over it lit underneath, a helmet and a carry box on
 * the lockers. A hutch's back is a tool board of real tools, not the print.
 */
export function flagshipCab(k: Kit, x: number, z: number, yaw: number, w: number, style: CabStyle): void {
  const m = k.m;
  const hutch = style.top === 'hutch';
  rollCab(k, x, z, yaw, w, style.body, style.fronts, style.top, style.lockers, true, hutch);
  // rollCab's frame and measurements: depth, the cab's base and height, the lockers' width and height, the worktop.
  const d = 0.62;
  const base = 0.17;
  const h = 0.9;
  const lw = 0.56;
  const lh = h + (hutch ? 0.98 : 0.53);
  const ty = base + h + 0.03;
  const sides = style.lockers === 2 ? [-1, 1] : [style.lockers];
  const x0 = -w / 2 - (sides.includes(-1) ? lw : 0);
  const x1 = w / 2 + (sides.includes(1) ? lw : 0);
  const cx = (x0 + x1) / 2;
  const span = x1 - x0;
  // Chrome pulls over the printed ones: seven rows a bank (the drawer layout of drawerTexture), the open drawer's row left dark.
  const top = base + h / 2 + (h - 0.08) / 2;
  const rows = [0, 20, 40, 60, 84, 112, 148];
  for (const s of [-1, 1])
    rows.forEach((r, i) => {
      if (s === 1 && i === 3) return;
      k.box(m.chrome, w / 2 - 0.16, 0.014, 0.02, (s * w) / 4, top - ((r + 6.5) / 192) * (h - 0.08), d / 2 + 0.012);
    });
  // Accent seams where the lockers meet the cab, the underglow strip and its pool on the mat.
  for (const s of sides) k.box(style.accent, 0.01, lh - 0.02, 0.008, s * (w / 2 + 0.004), base + lh / 2, d / 2 + 0.006);
  k.box(style.accent, span - 0.1, 0.012, 0.02, cx, base - 0.012, d / 2 - 0.04);
  k.box(m.rubber, span + 0.3, 0.012, 1.1, cx, 0.006, d / 2 + 0.5);
  k.plane(style.glow, span * 1.25, 1.8, cx, 0.014, d / 2 + 0.1, 0, -Math.PI / 2);
  // The nameplate: on the hutch's overhead cabinet, or across the top chest under its handle.
  const plate = cellPlane(hutch ? 0.66 : 0.5, hutch ? 0.124 : 0.094, 0, 1, style.badge, BADGES.length);
  if (hutch) k.add(m.badge, plate, 0, ty + 0.82, -d / 2 + 0.364);
  else k.add(m.badge, plate, 0, ty + 0.5 - 0.06, d / 2 - 0.054);
  if (hutch) {
    // Real tools on the hutch's back instead of the print.
    k.box(m.gunmetal, w - 0.1, 0.5, 0.012, 0, ty + 0.3, -d / 2 + 0.04);
    const n = Math.floor((w * 0.45) / 0.045);
    for (let i = 0; i < n; i++) {
      const len = 0.1 + i * 0.013;
      const wx = -w / 2 + 0.12 + i * 0.045;
      k.box(m.chrome, 0.014, len, 0.006, wx, ty + 0.5 - len / 2, -d / 2 + 0.05);
      k.cyl(m.chrome, 0.012 + i * 0.0006, 0.007, wx, ty + 0.5 - len, -d / 2 + 0.05, 'z', 10);
    }
    [m.red, m.yellow, m.black, m.blue, m.red, m.black, m.yellow, m.blue, m.red, m.black].forEach((mat, i) => {
      const px = 0.05 + i * (w * 0.3 / 9);
      k.cyl(mat, 0.013, 0.08, px, ty + 0.5, -d / 2 + 0.06, 'y', 8);
      k.cyl(m.chrome, 0.004, 0.1 + (i % 3) * 0.04, px, ty + 0.4 - (i % 3) * 0.02, -d / 2 + 0.06, 'y', 5);
    });
    for (let i = 0; i < 10; i++) k.cyl(m.chrome, 0.012 + i * 0.0014, 0.04, w / 2 - 0.5 + i * 0.042, ty + 0.2, -d / 2 + 0.07, 'z', 8);
    // The hutch's LED washing down its back.
    k.plane(m.wash, w - 0.12, 0.6, 0, ty + 0.3, -d / 2 + 0.048);
  }
  // On the lockers: a helmet in the cab's paint on one, a carry box on the other.
  const lt = base + lh;
  const lx = w / 2 + lw / 2;
  const helmetX = sides.includes(-1) ? -lx : lx;
  k.add(style.body, new THREE.SphereGeometry(0.15, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), helmetX, lt + 0.1, 0);
  k.box(m.carbon, 0.2, 0.08, 0.04, helmetX, lt + 0.12, 0.13, 0, -0.2);
  if (sides.length === 2) carryBox(k, m.black, lx, lt, 0, 0.44);
  // A run of wall cabinets over it all, in the same paint, lit underneath: centered over the span, backs on the wall.
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  wallCabinets(k, x + cx * c - (d / 2) * sn, style.cabinetY, z - cx * sn - (d / 2) * c, yaw, span, style.cabinets, style.body);
}

/** A plane w x h showing one cell (col, row) of a cols x rows atlas (row 0 at the top of the canvas). */
export function cellPlane(w: number, h: number, col: number, cols: number, row: number, rows: number): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / cols, 1 - (row + 1 - uv.getY(i)) / rows);
  return g;
}
