/**
 * The garage's work areas: the workbench, rolling tool chest, steel
 * shelving, tires (flat, on a wheel, in a wall rack), an oil drum, the air
 * compressor, an engine hoist with an engine on the chain, a floor jack with its
 * stands and creeper, body panels waiting to go on, and the fire extinguisher.
 * Render only.
 */
import * as THREE from 'three';
import type { Kit } from './kit';

/**
 * A workbench along local x against the wall behind it: worn top, steel legs,
 * a shelf of parts underneath, a vise, and the work in hand on top (a turbo, brake
 * discs, a laptop with a tune on screen, a toolbox, rags, cans).
 */
export function workbench(k: Kit, x: number, z: number, yaw: number, len: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.wood, len, 0.06, 0.8, 0, 0.92, 0);
  k.box(m.steel, len, 0.06, 0.04, 0, 0.88, 0.39);
  for (const dx of [-len / 2 + 0.08, len / 2 - 0.08]) for (const dz of [-0.32, 0.32]) k.box(m.steel, 0.05, 0.9, 0.05, dx, 0.45, dz);
  k.box(m.steel, len - 0.1, 0.04, 0.7, 0, 0.26, 0);
  // Under the bench: a tire, boxes and a parts crate.
  k.add(m.rubber, new THREE.TorusGeometry(0.27, 0.1, 10, 22), -len / 2 + 0.5, 0.38, 0.05, 0, Math.PI / 2);
  k.box(m.cardboard, 0.5, 0.32, 0.45, -len / 2 + 1.3, 0.44, 0);
  k.box(m.cardboard, 0.4, 0.24, 0.4, -len / 2 + 1.36, 0.72, 0.02);
  k.box(m.blue, 0.6, 0.3, 0.42, len / 2 - 0.6, 0.43, 0);
  // Vise at the right end.
  k.box(m.blue, 0.2, 0.14, 0.26, len / 2 - 0.3, 1.02, 0.28);
  k.box(m.steel, 0.24, 0.05, 0.06, len / 2 - 0.3, 1.09, 0.41);
  k.cyl(m.chrome, 0.012, 0.3, len / 2 - 0.3, 1.0, 0.48, 'x', 6);
  // A turbo: housing, compressor snail and an inlet.
  k.add(m.cast, new THREE.TorusGeometry(0.1, 0.055, 8, 16), len / 2 - 0.95, 1.07, 0.05, 0.3);
  k.cyl(m.chrome, 0.07, 0.12, len / 2 - 0.85, 1.07, 0.1, 'x', 12);
  k.cyl(m.galv, 0.05, 0.1, len / 2 - 0.95, 1.07, -0.08, 'z', 10);
  // Brake discs and calipers, a toolbox, a laptop.
  for (let i = 0; i < 3; i++) k.cyl(m.cast, 0.16, 0.028, -0.2 + i * 0.02, 0.965 + i * 0.03, -0.15 + i * 0.01, 'y', 20);
  k.box(m.red, 0.12, 0.08, 0.18, 0.2, 0.99, 0.15);
  k.box(m.red, 0.5, 0.22, 0.24, -len / 2 + 0.5, 1.06, -0.15);
  k.box(m.chrome, 0.4, 0.025, 0.025, -len / 2 + 0.5, 1.2, -0.15);
  k.box(m.black, 0.36, 0.02, 0.25, -0.9, 0.96, 0.12);
  k.box(m.black, 0.36, 0.24, 0.012, -0.9, 1.08, -0.02, 0, -0.25);
  k.plane(m.screen, 0.32, 0.2, -0.9, 1.08, -0.012, 0, -0.25);
  for (const [dx, dz, c] of [
    [0.6, -0.2, m.yellow],
    [0.68, -0.25, m.red],
    [-1.4, 0.2, m.galv],
  ] as const)
    k.cyl(c, 0.05, 0.2, dx, 1.05, dz, 'y', 10);
  k.box(m.orange, 0.3, 0.03, 0.22, -0.4, 0.965, 0.25, 0.4);
}

/** A rolling tool chest along local x: base cabinet and top box with drawer fronts, handle, casters, clutter on top. */
export function toolChest(k: Kit, x: number, z: number, yaw: number, w: number, body: THREE.Material, fronts: THREE.Material, top = true): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(body, w, 1.0, 0.5, 0, 0.6, 0);
  k.plane(fronts, w * 0.94, 0.92, 0, 0.6, 0.252);
  k.box(m.steel, w + 0.02, 0.03, 0.52, 0, 1.115, 0);
  k.cyl(m.chrome, 0.014, 0.42, w / 2 + 0.05, 0.9, 0, 'z', 6);
  for (const dx of [-w / 2 + 0.08, w / 2 - 0.08]) for (const dz of [-0.18, 0.18]) k.cyl(m.rubber, 0.05, 0.04, dx, 0.05, dz, 'x', 10);
  if (top) {
    k.box(body, w * 0.98, 0.42, 0.46, 0, 1.34, -0.02);
    k.plane(fronts, w * 0.92, 0.36, 0, 1.33, 0.212);
    k.box(body, w * 0.98, 0.04, 0.46, 0, 1.6, -0.24, 0, -0.5);
    k.cyl(m.galv, 0.04, 0.14, -w / 2 + 0.2, 1.62, 0);
    k.box(m.black, 0.3, 0.05, 0.12, w / 2 - 0.25, 1.58, 0.05, 0.3);
  } else {
    // A tool tray instead of a top box: sockets and a ratchet left out.
    k.box(m.steel, w * 0.8, 0.04, 0.3, 0, 1.14, 0.02);
    for (let i = 0; i < 5; i++) k.cyl(m.chrome, 0.018, 0.04, -0.2 + i * 0.08, 1.17, 0.05, 'y', 8);
    k.box(m.chrome, 0.26, 0.02, 0.03, 0.22, 1.16, -0.05, 0.6);
  }
}

/** Steel shelving along local x: four shelves of boxes, cans and parts, a different arrangement on each. */
export function shelving(k: Kit, x: number, z: number, yaw: number, w: number, seed: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const sx of [-w / 2, w / 2]) for (const sz of [-0.25, 0.25]) k.box(m.galv, 0.05, 2.6, 0.05, sx, 1.3, sz);
  const fill = [m.cardboard, m.cardboard, m.red, m.yellow, m.primer, m.blue, m.cardboard];
  for (let i = 0; i < 4; i++) {
    const y = 0.22 + i * 0.68;
    k.box(m.galv, w, 0.04, 0.56, 0, y, 0);
    let px = -w / 2 + 0.12;
    for (let j = 0; px < w / 2 - 0.2; j++) {
      const h = (seed * 7 + i * 13 + j * 5) % 7;
      const big = h % 3 !== 1;
      const bw = big ? 0.32 + (h % 3) * 0.08 : 0.14;
      const bh = big ? 0.24 + (h % 4) * 0.06 : 0.22;
      if (big) k.box(fill[h], bw, bh, 0.42, px + bw / 2, y + 0.02 + bh / 2, (h % 2) * 0.04);
      else k.cyl(fill[(h + 2) % fill.length], 0.06, bh, px + bw / 2, y + 0.02 + bh / 2, 0.1, 'y', 10);
      px += bw + 0.06;
    }
  }
}

/** A tire lying flat at (x, y, z) in room space, optionally on a wheel (one taken off a car). */
export function tire(k: Kit, x: number, y: number, z: number, wheel = false): void {
  const m = k.m;
  k.place();
  k.add(m.rubber, new THREE.TorusGeometry(0.26, 0.1, 10, 24), x, y, z, 0, Math.PI / 2);
  if (wheel) {
    k.cyl(m.chrome, 0.2, 0.17, x, y, z, 'y', 20);
    k.cyl(m.steel, 0.07, 0.19, x, y, z, 'y', 10);
  }
}

/** Tires stood in a wall rack along local x: two rails and a row of tires on edge. */
export function tireRack(k: Kit, x: number, z: number, yaw: number, n: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  const w = n * 0.26 + 0.2;
  for (const y of [1.0, 2.3]) {
    for (const dz of [-0.12, 0.12]) k.box(m.galv, w, 0.04, 0.04, 0, y, dz);
    for (const dx of [-w / 2, w / 2]) k.box(m.galv, 0.05, y, 0.05, dx, y / 2, -0.2);
    for (let i = 0; i < n; i++) k.add(m.rubber, new THREE.TorusGeometry(0.29, 0.1, 10, 24), -w / 2 + 0.23 + i * 0.26, y + 0.32, 0, Math.PI / 2, 0, 0.04 * ((i % 3) - 1));
  }
}

/** An oil drum with its rolling hoops, a bung, and a tray under it. */
export function drum(k: Kit, x: number, z: number, mat: THREE.Material): void {
  const m = k.m;
  k.place(x, 0, z, 0);
  k.cyl(mat, 0.29, 0.88, 0, 0.46, 0, 'y', 20);
  for (const y of [0.3, 0.62]) k.add(mat, new THREE.TorusGeometry(0.295, 0.015, 6, 24), 0, y, 0, 0, Math.PI / 2);
  k.cyl(m.galv, 0.03, 0.02, 0.12, 0.905, 0.05);
  k.box(m.black, 0.7, 0.03, 0.7, 0, 0.015, 0);
}

/** An air compressor: tank on wheels, motor, belt guard, a hose reel on the wall above. */
export function compressor(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.cyl(m.red, 0.24, 1.1, 0, 0.36, 0, 'x', 18);
  for (const dx of [-0.55, 0.55]) k.add(m.red, new THREE.SphereGeometry(0.24, 14, 8, 0, Math.PI * 2, 0, Math.PI), dx, 0.36, 0, 0, 0, dx > 0 ? -Math.PI / 2 : Math.PI / 2);
  k.box(m.black, 0.36, 0.26, 0.28, -0.2, 0.74, 0);
  k.cyl(m.cast, 0.1, 0.22, 0.2, 0.74, 0, 'x', 12);
  k.box(m.galv, 0.06, 0.32, 0.3, -0.42, 0.74, 0);
  for (const dx of [-0.4, 0.4]) k.cyl(m.rubber, 0.08, 0.06, dx, 0.08, 0.2, 'z', 12);
  k.cyl(m.chrome, 0.04, 0.03, 0.3, 0.62, 0.15, 'z', 10);
  k.add(m.yellow, new THREE.TorusGeometry(0.2, 0.035, 6, 20), 0, 2.0, -0.18);
  k.cyl(m.steel, 0.08, 0.1, 0, 2.0, -0.22, 'z', 10);
}

/**
 * An engine hoist with an engine hanging from it: the legs and casters, mast,
 * boom and ram in safety yellow, the chain, and a four cylinder on a leveler
 * (block, head, cam cover, intake runners, pulleys and a manifold).
 */
export function engineHoist(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  for (const dx of [-0.38, 0.38]) {
    k.box(m.yellow, 0.1, 0.1, 1.5, dx, 0.12, 0.55);
    k.cyl(m.rubber, 0.06, 0.05, dx, 0.06, 1.25, 'x', 10);
  }
  k.box(m.yellow, 0.86, 0.1, 0.12, 0, 0.12, -0.2);
  k.box(m.yellow, 0.12, 1.6, 0.12, 0, 0.95, -0.15);
  k.bar(m.yellow, [0, 1.65, -0.2], [0, 2.05, 1.1], 0.11);
  k.bar(m.chrome, [0, 0.55, -0.05], [0, 1.6, 0.45], 0.05);
  k.bar(m.cast, [0, 0.55, -0.05], [0, 1.15, 0.22], 0.08);
  k.bar(m.steel, [0, 2.0, 1.1], [0, 1.5, 1.1], 0.02);
  k.bar(m.steel, [0, 1.5, 1.1], [-0.25, 1.32, 1.0], 0.015);
  k.bar(m.steel, [0, 1.5, 1.1], [0.25, 1.32, 1.2], 0.015);
  const ex = 0;
  const ey = 1.0;
  const ez = 1.1;
  k.box(m.cast, 0.42, 0.42, 0.62, ex, ey, ez);
  k.box(m.galv, 0.4, 0.14, 0.6, ex, ey + 0.28, ez);
  k.box(m.red, 0.3, 0.08, 0.56, ex + 0.02, ey + 0.39, ez);
  for (let i = 0; i < 4; i++) k.bar(m.galv, [ex - 0.2, ey + 0.28, ez - 0.22 + i * 0.15], [ex - 0.42, ey + 0.38, ez - 0.22 + i * 0.15], 0.05);
  k.box(m.galv, 0.1, 0.12, 0.6, ex - 0.45, ey + 0.4, ez);
  k.bar(m.rust, [ex + 0.22, ey + 0.2, ez - 0.2], [ex + 0.38, ey - 0.05, ez + 0.1], 0.07);
  k.cyl(m.cast, 0.1, 0.04, ex, ey - 0.05, ez + 0.33, 'z', 16);
  k.cyl(m.cast, 0.06, 0.04, ex + 0.12, ey + 0.15, ez + 0.33, 'z', 12);
  k.box(m.cast, 0.36, 0.14, 0.5, ex, ey - 0.28, ez);
  // Oil drips under it on a tray.
  k.box(m.black, 0.6, 0.03, 0.7, 0, 0.015, 1.1);
}

/** A floor jack with its handle up, a pair of jack stands and a creeper, round a car being worked on. */
export function jackAndStands(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.red, 0.3, 0.14, 0.72, 0, 0.12, 0);
  k.cyl(m.cast, 0.07, 0.04, 0, 0.21, 0.32, 'y', 12);
  k.bar(m.chrome, [0, 0.16, -0.36], [0, 1.0, -0.9], 0.035);
  for (const dx of [-0.13, 0.13]) for (const dz of [-0.3, 0.3]) k.cyl(m.steel, 0.045, 0.04, dx, 0.045, dz, 'x', 10);
  for (const [sx, sz] of [
    [0.8, 0.3],
    [1.2, -0.2],
  ] as const) {
    k.cyl(m.red, 0.04, 0.42, sx, 0.22, sz, 'y', 4, 0.17);
    k.cyl(m.galv, 0.03, 0.35, sx, 0.5, sz, 'y', 8);
    k.box(m.galv, 0.1, 0.03, 0.06, sx, 0.68, sz);
  }
  k.box(m.black, 0.46, 0.04, 1.05, -0.9, 0.1, 0.4, 0.15);
  k.box(m.rubber, 0.36, 0.05, 0.22, -0.92, 0.13, 0.82, 0.15);
  for (const dx of [-0.18, 0.18]) for (const dz of [-0.45, 0.45]) k.cyl(m.rubber, 0.035, 0.03, -0.9 + dx + dz * 0.15, 0.04, 0.4 + dz, 'x', 8);
}

/** Body panels waiting to go on, along local x against a wall: a carbon hood leaned up, a primered bumper, a wing on its stands. */
export function panels(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.box(m.carbon, 1.35, 1.5, 0.04, -1.2, 0.74, -0.15, 0, -0.18);
  for (let i = 0; i < 5; i++) {
    const a = ((i - 2) / 2) * 0.55;
    k.box(m.primer, 0.42, 0.46, 0.08, 0.35 + Math.sin(a) * 0.9, 0.24, -0.05 + (1 - Math.cos(a)) * 0.9, a);
  }
  k.box(m.panel, 1.5, 0.04, 0.3, 1.9, 0.55, 0.1, 0, 0.12);
  for (const dx of [-0.45, 0.45]) k.box(m.panel, 0.03, 0.5, 0.18, 1.9 + dx, 0.3, 0.12);
  k.box(m.panel, 0.02, 0.24, 0.36, 1.9 - 0.76, 0.6, 0.1);
  k.box(m.panel, 0.02, 0.24, 0.36, 1.9 + 0.76, 0.6, 0.1);
}

/** A red fire extinguisher on a wall bracket, a sign board over it. */
export function extinguisher(k: Kit, x: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.cyl(m.red, 0.08, 0.5, 0, 1.0, 0.1, 'y', 12);
  k.box(m.black, 0.06, 0.1, 0.12, 0, 1.3, 0.1);
  k.box(m.galv, 0.18, 0.05, 0.08, 0, 0.9, 0.04);
  k.box(m.red, 0.24, 0.24, 0.01, 0, 1.6, 0.005);
}
