/**
 * The storage a tool truck sells and the shop's heavy equipment: double-bank
 * roll cabs with side lockers under a top chest or a lit hutch, full-height
 * lockers with one left open, utility carts, carry boxes, and the tire changer,
 * wheel balancer and MIG welder on its cart. The small private pieces
 * (socket rails, impact gun, scan tool, torque wrench, spray cans) are
 * the clutter those cabs carry. Render only.
 */
import * as THREE from 'three';
import { caster } from './kit';
import type { Kit } from './kit';

/** What stands on a roll cab: a top chest, a hutch with its own light, or the work left out on the worktop. */
export type CabTop = 'chest' | 'hutch' | 'bare';

/**
 * A pro roll cab along local x, the double-bank kind off a tool truck: two
 * banks of drawers on casters, a rubber bumper, end handles, a power strip and
 * a stainless worktop, side lockers at either end (`lockers`: -1 the left, 1
 * the right, 2 both) and on top a chest of drawers, a hutch (pegboard back,
 * overhead cabinet, an LED strip over the worktop) or the tools in use.
 * `open` leaves a drawer of the right bank pulled out with its wrenches;
 * `tall` runs the side lockers up to the top of the hutch.
 */
export function rollCab(k: Kit, x: number, z: number, yaw: number, w: number, body: THREE.Material, fronts: THREE.Material, top: CabTop, lockers: -1 | 0 | 1 | 2 = 0, open = false, tall = false): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const d = 0.62;
  const base = 0.17;
  const h = 0.9;
  const lw = 0.56;
  const chest = top === 'chest' ? 0.5 : 0;
  const sides = lockers === 2 ? [-1, 1] : lockers === 0 ? [] : [lockers];
  const x0 = -w / 2 - (sides.includes(-1) ? lw : 0);
  const x1 = w / 2 + (sides.includes(1) ? lw : 0);
  k.box(body, w, h, d, 0, base + h / 2, 0);
  for (const s of [-1, 1]) k.plane(fronts, w / 2 - 0.05, h - 0.08, (s * w) / 4, base + h / 2, d / 2 + 0.002);
  k.box(m.chrome, w - 0.04, 0.016, 0.012, 0, base + h - 0.02, d / 2 + 0.006);
  if (open) {
    const bw = w / 2 - 0.08;
    const fx = w / 4;
    const dy = base + h - 0.3;
    const out = 0.36;
    k.plane(m.black, bw, 0.1, fx, dy, d / 2 + 0.004);
    k.box(body, bw + 0.02, 0.1, 0.02, fx, dy, d / 2 + out);
    k.box(m.chrome, bw * 0.9, 0.018, 0.02, fx, dy + 0.02, d / 2 + out + 0.02);
    for (const s of [-1, 1]) k.box(m.steel, 0.01, 0.07, out, fx + (s * bw) / 2, dy - 0.005, d / 2 + out / 2);
    k.box(m.rubber, bw, 0.01, out - 0.02, fx, dy - 0.04, d / 2 + out / 2);
    for (let i = 0; i < 10; i++) k.box(m.chrome, 0.014, 0.008, 0.14 + i * 0.012, fx - bw / 2 + 0.04 + (i * (bw - 0.08)) / 9, dy - 0.03, d / 2 + out / 2, 0.15);
  }
  // Side lockers: a tall door each, its handle and vents, as high as the chest when there is one.
  const lh = h + (chest ? 0.03 + chest : tall ? 0.98 : 0);
  for (const s of sides) {
    const lx = s * (w / 2 + lw / 2);
    k.box(body, lw, lh, d, lx, base + lh / 2, 0);
    k.box(m.black, 0.008, lh, 0.006, s * (w / 2 + 0.004), base + lh / 2, d / 2 + 0.003);
    k.box(m.black, lw - 0.04, 0.008, 0.006, lx, base + 0.06, d / 2 + 0.003);
    k.box(m.chrome, 0.022, 0.32, 0.025, lx - s * (lw / 2 - 0.07), base + lh * 0.55, d / 2 + 0.016);
    for (let i = 0; i < 5; i++) k.box(m.black, lw * 0.5, 0.012, 0.006, lx, base + lh - 0.14 - i * 0.04, d / 2 + 0.003);
  }
  k.box(m.black, x1 - x0 + 0.03, 0.05, 0.04, (x0 + x1) / 2, base + 0.03, d / 2 + 0.01);
  const n = Math.max(2, Math.round((x1 - x0) / 0.9) + 1);
  for (let i = 0; i < n; i++) for (const cz of [-d / 2 + 0.1, d / 2 - 0.1]) caster(k, x0 + 0.1 + ((x1 - x0 - 0.2) * i) / (n - 1), cz, base);
  for (const s of [-1, 1]) {
    const ex = s > 0 ? x1 : x0;
    k.cyl(m.chrome, 0.014, d - 0.1, ex + s * 0.06, base + h - 0.12, 0, 'z', 6);
    for (const dz of [-(d / 2 - 0.08), d / 2 - 0.08]) k.box(m.chrome, 0.06, 0.02, 0.02, ex + s * 0.03, base + h - 0.12, dz);
  }
  k.box(m.black, 0.03, 0.06, 0.32, x1 + 0.015, base + h - 0.32, 0);
  const [t0, t1] = chest || tall ? [-w / 2, w / 2] : [x0, x1];
  const ty = base + h + 0.03;
  k.box(m.stainless, t1 - t0 + 0.03, 0.03, d + 0.03, (t0 + t1) / 2, ty - 0.015, 0);
  if (top === 'chest') {
    k.box(body, w - 0.02, chest, d - 0.06, 0, ty + chest / 2, -0.03);
    for (const s of [-1, 1]) k.plane(fronts, w / 2 - 0.06, chest - 0.1, (s * w) / 4, ty + chest / 2 - 0.02, d / 2 - 0.058);
    k.box(body, w, 0.04, d - 0.04, 0, ty + chest + 0.02, -0.03);
    k.box(m.chrome, w * 0.5, 0.02, 0.02, 0, ty + chest + 0.005, d / 2 - 0.04);
    carryBox(k, m.red, -w / 4, ty + chest + 0.04, -0.06);
    socketRail(k, w / 4, ty + chest + 0.04, 0.08, 10, m.red);
  } else if (top === 'hutch') {
    const hh = 0.95;
    const hd = 0.36;
    const bz = -d / 2 + 0.015;
    k.box(body, w, hh, 0.03, 0, ty + hh / 2, bz);
    for (const s of [-1, 1]) k.box(body, 0.03, hh, hd, s * (w / 2 - 0.015), ty + hh / 2, -d / 2 + hd / 2);
    k.plane(m.pegboard, w - 0.08, hh - 0.4, 0, ty + (hh - 0.38) / 2, bz + 0.016);
    // The overhead cabinet: two flip-up doors, their handles, the LED strip under it.
    k.box(body, w - 0.06, 0.34, hd, 0, ty + hh - 0.17, -d / 2 + hd / 2);
    k.box(m.black, 0.008, 0.32, 0.006, 0, ty + hh - 0.17, -d / 2 + hd + 0.003);
    for (const s of [-1, 1]) k.box(m.chrome, w * 0.25, 0.02, 0.02, (s * w) / 4, ty + hh - 0.31, -d / 2 + hd + 0.012);
    k.box(m.tube, w - 0.16, 0.012, 0.025, 0, ty + hh - 0.346, -d / 2 + hd - 0.05);
    k.box(m.black, w * 0.4, 0.05, 0.04, -w * 0.2, ty + 0.04, bz + 0.035);
    scanTool(k, -w / 2 + 0.3, ty, 0.02);
    socketRail(k, -0.05, ty, 0.12, 12, m.red);
    socketRail(k, 0.05, ty, 0.02, 9, m.black);
    impactGun(k, m.red, w / 2 - 0.28, ty, 0.05);
    torqueWrench(k, 0.1, ty, 0.22);
  } else {
    carryBox(k, m.black, x0 + 0.4, ty, -0.08);
    scanTool(k, 0.05, ty, -0.05);
    socketRail(k, x1 - 0.5, ty, 0.12, 11, m.red);
    impactGun(k, m.black, x1 - 0.3, ty, -0.12, -1);
    sprayCans(k, x0 + 0.85, ty, 0.12, 2);
  }
}

/**
 * A full-height tool locker against the wall behind it, along local x: a
 * shell, one door or two (vents, a handle, a label), the kick plate and a box
 * on top. `open` swings the right door out on its hinge to show the shelves:
 * air tools, a carry box, cans, cases and a coiled air line.
 */
export function locker(k: Kit, x: number, z: number, yaw: number, w: number, body: THREE.Material, open = false): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const h = 1.95;
  const d = 0.6;
  const t = 0.03;
  const fz = d / 2;
  for (const s of [-1, 1]) k.box(body, t, h, d, s * (w / 2 - t / 2), h / 2, 0);
  k.box(body, w, t, d, 0, h - t / 2, 0);
  k.box(body, w - 2 * t, t, d - t, 0, 0.1 + t / 2, t / 2);
  k.box(m.black, w - 2 * t, h - 0.1, t, 0, h / 2 + 0.05, -d / 2 + t / 2);
  k.box(m.black, w - 0.02, 0.1, d - 0.04, 0, 0.05, 0);
  const doors = w > 0.75 ? 2 : 1;
  const dw = w / doors;
  for (let i = 0; i < doors; i++) {
    const s = doors === 1 || i === 1 ? 1 : -1;
    const a = open && s === 1 ? 1.75 : 0;
    // A piece u along the door from its hinge and v out of its face, turned with the door.
    const put = (mat: THREE.Material, bw: number, bh: number, bd: number, u: number, y: number, v: number) =>
      k.box(mat, bw, bh, bd, (s * w) / 2 - s * Math.cos(a) * u + s * Math.sin(a) * v, y, fz + Math.sin(a) * u + Math.cos(a) * v, s * a);
    put(body, dw - 0.008, h - 0.13, 0.02, dw / 2, h / 2 + 0.04, -0.01);
    for (let j = 0; j < 5; j++) put(m.black, dw * 0.55, 0.012, 0.006, dw / 2, h - 0.22 - j * 0.04, 0.002);
    put(m.chrome, 0.022, 0.26, 0.03, dw - 0.06, 1.05, 0.015);
    if (i === 0) put(m.yellow, 0.1, 0.05, 0.004, dw / 2, h - 0.5, 0.002);
  }
  if (open) {
    const ix = doors === 2 ? w / 4 : 0;
    const iw = (doors === 2 ? w / 2 : w) - 2 * t;
    for (const y of [0.62, 1.08, 1.5]) k.box(m.galv, iw, 0.02, d - 0.08, ix, y, 0.01);
    k.add(m.yellow, new THREE.TorusGeometry(0.14, 0.03, 6, 18), ix, 0.16, 0, 0, Math.PI / 2);
    k.box(m.blue, iw * 0.8, 0.12, 0.34, ix, 0.39, -0.04);
    k.box(m.blue, iw * 0.7, 0.1, 0.3, ix + 0.02, 0.51, -0.06, 0.1);
    impactGun(k, m.red, ix - iw / 4, 0.63, 0.02);
    impactGun(k, m.black, ix + iw / 4, 0.63, -0.04, -1);
    carryBox(k, m.red, ix, 1.09, -0.02, Math.min(0.44, iw - 0.04));
    sprayCans(k, ix - iw / 2 + 0.06, 1.51, 0.08, 3);
    k.box(m.cardboard, iw * 0.45, 0.24, 0.36, ix + iw / 4, 1.63, -0.04);
  }
  k.box(m.cardboard, w * 0.55, 0.22, 0.4, (w - w * 0.55) / 2 - 0.05, h + 0.11, -0.04, 0.06);
}

/**
 * A three-tray utility cart along local x: lipped trays on corner posts, four
 * casters, the push handle at the left end, and a load picked by `seed`: an
 * impact gun, sockets and a scan tool, a torque wrench and brake cleaner, a
 * carry box, oil jugs and a coil of air line.
 */
export function utilityCart(k: Kit, x: number, z: number, yaw: number, body: THREE.Material, seed: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = 0.9;
  const d = 0.46;
  const trays = [0.24, 0.54, 0.86];
  for (const y of trays) {
    k.box(body, w, 0.02, d, 0, y, 0);
    for (const s of [-1, 1]) {
      k.box(body, w, 0.05, 0.015, 0, y + 0.025, s * (d / 2 - 0.007));
      k.box(body, 0.015, 0.05, d, s * (w / 2 - 0.007), y + 0.025, 0);
    }
  }
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      k.box(body, 0.03, 0.76, 0.03, sx * (w / 2 - 0.015), 0.51, sz * (d / 2 - 0.015));
      caster(k, sx * (w / 2 - 0.06), sz * (d / 2 - 0.07), 0.13);
    }
  for (const sz of [-1, 1]) k.bar(m.chrome, [-w / 2 + 0.01, 0.88, sz * (d / 2 - 0.03)], [-w / 2 - 0.1, 1.02, sz * (d / 2 - 0.03)], 0.022);
  k.cyl(m.black, 0.02, d - 0.04, -w / 2 - 0.1, 1.02, 0, 'z', 8);
  const [lo, mid, up] = trays.map((y) => y + 0.01);
  if (seed % 2 === 0) {
    impactGun(k, m.red, -0.22, up, 0.06);
    socketRail(k, 0.12, up, -0.1, 10, m.red);
    scanTool(k, 0.22, up, 0.06);
  } else {
    torqueWrench(k, 0, up, -0.12);
    sprayCans(k, -0.3, up, 0.08, 3);
    k.box(m.orange, 0.3, 0.025, 0.22, 0.2, up + 0.012, 0.06, 0.35);
  }
  carryBox(k, seed % 3 === 0 ? m.black : m.red, -0.1, mid, 0);
  sprayCans(k, 0.3, mid, -0.08, seed % 3);
  for (let i = 0; i < 2; i++) {
    k.box(m.yellow, 0.16, 0.26, 0.1, -0.3 + i * 0.2, lo + 0.13, -0.08);
    k.cyl(m.black, 0.022, 0.03, -0.25 + i * 0.2, lo + 0.275, -0.08, 'y', 8);
  }
  k.add(m.yellow, new THREE.TorusGeometry(0.13, 0.025, 6, 18), 0.22, lo + 0.03, 0.04, 0, Math.PI / 2);
}

/**
 * A tire changer facing local +z: the red base with its three pedals, the
 * clamping turntable with a wheel on it, the tower, arm and mount head over
 * the rim, the bead breaker on the right with its rubber pad, the inflation
 * gauge and the bead lube bucket.
 */
export function tireChanger(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.78, 0.74, 0.96, 0, 0.4, 0);
  k.box(m.black, 0.8, 0.04, 0.98, 0, 0.02, 0);
  k.box(m.black, 0.6, 0.02, 0.62, 0, 0.775, 0.12);
  for (const dx of [-0.2, 0, 0.2]) k.box(m.black, 0.09, 0.04, 0.2, dx, 0.07, 0.56, 0, -0.15);
  const tz = 0.12;
  k.cyl(m.galv, 0.4, 0.05, 0, 0.81, tz, 'y', 24);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    k.box(m.steel, 0.07, 0.07, 0.13, Math.cos(a) * 0.3, 0.87, tz + Math.sin(a) * 0.3, Math.PI / 2 - a);
  }
  k.add(m.rubber, new THREE.TorusGeometry(0.27, 0.1, 10, 24), 0, 0.97, tz, 0, Math.PI / 2);
  k.cyl(m.chrome, 0.2, 0.17, 0, 0.97, tz, 'y', 20);
  // Tower, arm, the hex shaft down to the mount head at the rim.
  k.box(m.red, 0.2, 1.25, 0.2, 0, 1.36, -0.38);
  k.cyl(m.galv, 0.05, 0.6, 0, 1.2, -0.52, 'y', 10);
  k.box(m.red, 0.12, 0.12, 0.56, 0, 1.9, -0.12);
  k.box(m.black, 0.08, 0.1, 0.06, 0.07, 1.9, 0.1);
  k.box(m.chrome, 0.04, 0.8, 0.04, 0, 1.5, -0.1);
  k.box(m.black, 0.07, 0.07, 0.11, 0, 1.1, -0.07);
  // Bead breaker on the right: ram, arm and blade, the rubber pad on the cabinet.
  k.cyl(m.galv, 0.06, 0.46, 0.46, 0.5, -0.26, 'z', 12);
  k.bar(m.red, [0.46, 0.62, -0.42], [0.66, 0.52, 0.28], 0.06);
  k.box(m.steel, 0.03, 0.16, 0.14, 0.62, 0.42, 0.3);
  k.box(m.rubber, 0.02, 0.3, 0.46, 0.4, 0.42, 0.12);
  // The inflation gauge on the tower, its hose looped down; the lube bucket hung on the left.
  k.box(m.black, 0.12, 0.14, 0.06, -0.16, 1.4, -0.32);
  k.cyl(m.chrome, 0.045, 0.02, -0.16, 1.42, -0.28, 'z', 14);
  k.hose(m.rubber, [[-0.16, 1.33, -0.3], [-0.3, 1.0, -0.2], [-0.42, 0.85, 0.05], [-0.3, 0.95, 0.15]], 0.01, 24);
  k.cyl(m.blue, 0.08, 0.12, -0.47, 0.62, 0.25, 'y', 12);
  k.box(m.galv, 0.04, 0.02, 0.1, -0.41, 0.69, 0.25);
}

/**
 * A wheel balancer facing local +z: the cabinet with its tray of weights, the
 * console on a mast (lit readouts), the shaft out of the right side with a
 * wheel spun up on it and the hood raised behind it, the cones on their peg.
 */
export function wheelBalancer(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.gunmetal, 0.62, 0.82, 0.6, 0, 0.41, 0);
  k.box(m.black, 0.64, 0.05, 0.5, 0, 0.845, 0.04);
  for (let i = 0; i < 8; i++) k.box(m.chrome, 0.05, 0.02, 0.05, -0.25 + i * 0.07, 0.88, 0.0 + (i % 2) * 0.12);
  k.box(m.gunmetal, 0.06, 0.5, 0.06, 0, 1.1, -0.26);
  k.box(m.black, 0.56, 0.34, 0.08, 0, 1.45, -0.24, 0, -0.2);
  k.plane(m.screen, 0.46, 0.22, 0, 1.47, -0.198, 0, -0.2);
  k.cyl(m.chrome, 0.03, 0.5, 0.52, 0.66, 0, 'x', 10);
  k.cyl(m.cast, 0.09, 0.05, 0.34, 0.66, 0, 'x', 14);
  k.add(m.rubber, new THREE.TorusGeometry(0.28, 0.1, 10, 24), 0.58, 0.66, 0, Math.PI / 2);
  k.cyl(m.chrome, 0.21, 0.18, 0.58, 0.66, 0, 'x', 20);
  k.cyl(m.black, 0.05, 0.12, 0.74, 0.66, 0, 'x', 10);
  const hood = new THREE.CylinderGeometry(0.48, 0.48, 0.36, 14, 1, true, Math.PI * 0.5, Math.PI * 0.6);
  hood.rotateZ(Math.PI / 2);
  k.add(m.gunmetal, hood, 0.58, 0.72, -0.12);
  k.bar(m.gunmetal, [0.32, 0.8, -0.28], [0.5, 1.12, -0.24], 0.04);
  k.cyl(m.chrome, 0.015, 0.22, -0.4, 0.62, 0, 'x', 6);
  for (let i = 0; i < 3; i++) k.cyl(m.chrome, 0.05 + i * 0.012, 0.05, -0.38 - i * 0.055, 0.62, 0, 'x', 12, 0.08 + i * 0.012);
}

/**
 * A MIG welder on its cart facing local +z: deck, wheels and casters, the set
 * with its knobs and readout, the gas bottle chained behind it with the
 * regulator, the torch lead coiled on the side and a helmet on top.
 */
export function welder(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.steel, 0.46, 0.03, 0.72, 0, 0.2, 0);
  for (const s of [-1, 1]) {
    k.cyl(m.rubber, 0.13, 0.06, s * 0.27, 0.13, -0.24, 'x', 16);
    k.cyl(m.galv, 0.05, 0.065, s * 0.27, 0.13, -0.24, 'x', 10);
    caster(k, s * 0.16, 0.27, 0.185);
  }
  k.box(m.blue, 0.36, 0.44, 0.58, 0, 0.44, 0.04);
  k.box(m.black, 0.32, 0.36, 0.01, 0, 0.44, 0.335);
  for (const dx of [-0.08, 0.08]) k.cyl(m.chrome, 0.025, 0.03, dx, 0.4, 0.345, 'z', 10);
  k.plane(m.screen, 0.1, 0.04, 0, 0.55, 0.341);
  k.box(m.galv, 0.01, 0.3, 0.4, 0.185, 0.46, 0.02);
  // Handle and the bottle on its platform behind.
  for (const s of [-1, 1]) k.box(m.steel, 0.025, 0.9, 0.025, s * 0.2, 0.65, -0.34);
  k.cyl(m.chrome, 0.015, 0.42, 0, 1.1, -0.34, 'x', 8);
  k.box(m.steel, 0.3, 0.02, 0.26, 0, 0.21, -0.48);
  k.cyl(m.primer, 0.11, 0.96, 0, 0.7, -0.48, 'y', 16);
  k.add(m.primer, new THREE.SphereGeometry(0.11, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.18, -0.48);
  k.cyl(m.chrome, 0.02, 0.1, 0, 1.32, -0.48, 'y', 8);
  k.box(m.galv, 0.06, 0.06, 0.08, 0, 1.38, -0.46);
  for (const dx of [-0.05, 0.05]) k.cyl(m.chrome, 0.03, 0.02, dx, 1.4, -0.41, 'z', 12);
  k.box(m.steel, 0.4, 0.012, 0.012, 0, 0.95, -0.37);
  // The torch lead coiled on the left, the earth clamp hung by it, a helmet on top.
  k.add(m.rubber, new THREE.TorusGeometry(0.15, 0.016, 6, 24), -0.2, 0.46, 0.04, Math.PI / 2);
  k.box(m.black, 0.04, 0.16, 0.04, -0.22, 0.4, 0.2, 0, 0.5);
  k.box(m.red, 0.03, 0.08, 0.05, -0.2, 0.52, -0.2);
  k.add(m.black, new THREE.SphereGeometry(0.13, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.66, 0.08);
  k.box(m.carbon, 0.12, 0.06, 0.02, 0, 0.72, 0.205);
}

/** A portable toolbox standing at (x, y, z) in the current frame along x: box, lid, latches and the carry handle. */
export function carryBox(k: Kit, mat: THREE.Material, x: number, y: number, z: number, w = 0.48): void {
  const m = k.m;
  k.box(mat, w, 0.17, 0.22, x, y + 0.085, z);
  k.box(mat, w + 0.012, 0.05, 0.232, x, y + 0.195, z);
  for (const s of [-1, 1]) {
    k.box(m.chrome, 0.04, 0.05, 0.012, x + s * w * 0.32, y + 0.17, z + 0.115);
    k.box(m.black, 0.02, 0.06, 0.02, x + s * 0.11, y + 0.25, z);
  }
  k.box(m.black, 0.25, 0.025, 0.03, x, y + 0.29, z);
}

/** A socket rail of n sockets, smallest at the left, standing at (x, y, z) in the current frame along x. */
function socketRail(k: Kit, x: number, y: number, z: number, n: number, rail: THREE.Material): void {
  const radii = Array.from({ length: n }, (_, i) => 0.009 + i * 0.0012);
  const len = radii.reduce((a, r) => a + 2 * r + 0.006, 0.02);
  k.box(rail, len, 0.012, 0.03, x, y + 0.006, z);
  let px = x - len / 2 + 0.01;
  radii.forEach((r, i) => {
    const sh = 0.028 + i * 0.002;
    k.cyl(k.m.chrome, r, sh, px + r + 0.003, y + 0.012 + sh / 2, z, 'y', 8);
    px += 2 * r + 0.006;
  });
}

/** A cordless impact gun stood on its battery at (x, y, z) in the current frame, its anvil toward +x (dir 1) or -x. */
function impactGun(k: Kit, mat: THREE.Material, x: number, y: number, z: number, dir = 1): void {
  const m = k.m;
  k.box(m.black, 0.1, 0.065, 0.075, x, y + 0.033, z);
  k.box(m.black, 0.04, 0.12, 0.045, x, y + 0.125, z);
  k.box(mat, 0.17, 0.075, 0.068, x + dir * 0.04, y + 0.22, z);
  k.cyl(m.chrome, 0.018, 0.05, x + dir * 0.15, y + 0.22, z, 'x', 8);
}

/** A diagnostic tablet in its rugged case leant back on its stand at (x, y, z) in the current frame, the screen lit. */
function scanTool(k: Kit, x: number, y: number, z: number): void {
  const m = k.m;
  const rx = -0.45;
  k.box(m.black, 0.3, 0.21, 0.03, x, y + 0.1, z, 0, rx);
  k.plane(m.screen, 0.24, 0.15, x, y + 0.1 - 0.016 * Math.sin(rx), z + 0.016 * Math.cos(rx), 0, rx);
  k.box(m.yellow, 0.31, 0.02, 0.035, x, y + 0.01, z + 0.04);
}

/** A click torque wrench lying along x at (x, y, z) in the current frame: ratchet head, chrome tube, scale, grip. */
function torqueWrench(k: Kit, x: number, y: number, z: number): void {
  const m = k.m;
  k.cyl(m.chrome, 0.013, 0.42, x, y + 0.014, z, 'x', 8);
  k.box(m.chrome, 0.05, 0.022, 0.04, x - 0.23, y + 0.014, z);
  k.cyl(m.black, 0.018, 0.14, x + 0.27, y + 0.018, z, 'x', 8);
}

/** n spray cans in a row along x from (x, y, z) in the current frame (brake cleaner, penetrant, paint). */
function sprayCans(k: Kit, x: number, y: number, z: number, n: number): void {
  const m = k.m;
  const colors = [m.red, m.blue, m.yellow];
  for (let i = 0; i < n; i++) {
    k.cyl(colors[i % 3], 0.032, 0.19, x + i * 0.075, y + 0.095, z, 'y', 10);
    k.cyl(m.galv, 0.024, 0.04, x + i * 0.075, y + 0.21, z, 'y', 8);
  }
}
