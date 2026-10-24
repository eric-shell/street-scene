/**
 * What hangs on the walls and from the ceiling: the louvred tool board with
 * its tools, wall cabinets, the jobs whiteboard, a clipboard with a work order,
 * and the air and lamp reels on the ceiling. Render only.
 */
import * as THREE from 'three';
import type { Kit, Vec } from './kit';

/**
 * A louvred steel tool board on a wall, centered at height y along local x:
 * a wrench rack, a screwdriver rack, hammers, pliers, ratchets and a magnetic
 * socket rail, each hung where it belongs, as many as the width holds at the
 * spacing the cabs' hutches use, under an LED strip washing down over them
 * the way the hutches are lit.
 */
export function toolBoard(k: Kit, x: number, y: number, z: number, yaw: number, w: number, h: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.gunmetal, w, h, 0.02, 0, 0, 0.01);
  for (let i = 0; i < Math.floor(h / 0.09); i++) k.box(m.black, w - 0.08, 0.008, 0.004, 0, -h / 2 + 0.05 + i * 0.09, 0.022);
  k.box(m.steel, w, 0.04, 0.08, 0, h / 2 + 0.02, 0.06);
  k.box(m.tube, w - 0.1, 0.012, 0.025, 0, h / 2 - 0.006, 0.08);
  k.plane(m.wash, w - 0.06, h, 0, 0, 0.026);
  const top = h / 2 - 0.08;
  // Wrenches, short to long, ring ends down.
  const ww = w * 0.45;
  k.box(m.black, ww, 0.02, 0.03, -w / 2 + 0.04 + ww / 2, top, 0.035);
  const nw = Math.max(12, Math.floor((ww - 0.06) / 0.045) + 1);
  for (let i = 0; i < nw; i++) {
    const f = i / (nw - 1);
    const len = 0.12 + f * 0.18;
    const wx = -w / 2 + 0.07 + f * (ww - 0.06);
    k.box(m.chrome, 0.016, len, 0.006, wx, top - 0.01 - len / 2, 0.04);
    k.cyl(m.chrome, 0.014 + f * 0.009, 0.008, wx, top - 0.01 - len, 0.04, 'z', 10);
  }
  // A second, shorter set across the middle on its own rail, where a wide board has the room.
  if (h >= 1.2) {
    const mw = w - 0.2;
    const mn = Math.floor(mw / 0.04) + 1;
    k.box(m.black, mw, 0.02, 0.03, 0, 0.08, 0.035);
    for (let i = 0; i < mn; i++) {
      const f = i / (mn - 1);
      const len = 0.08 + f * 0.13;
      const wx = -mw / 2 + f * mw;
      k.box(m.chrome, 0.013, len, 0.006, wx, 0.07 - len / 2, 0.04);
      k.cyl(m.chrome, 0.011 + f * 0.007, 0.008, wx, 0.07 - len, 0.04, 'z', 10);
    }
  }
  // Screwdrivers through their rack, handles up.
  const sx = w * 0.18;
  const sw = w * 0.32;
  k.box(m.black, sw, 0.02, 0.06, sx, top, 0.05);
  const colors = [m.red, m.yellow, m.black, m.blue];
  const ns = Math.max(9, Math.floor((sw - 0.06) / 0.045) + 1);
  Array.from({ length: ns }, (_, i) => colors[(i * 3 + (i >> 2)) % 4]).forEach((mat, i) => {
    const px = sx - sw / 2 + 0.03 + (i * (sw - 0.06)) / (ns - 1);
    k.cyl(mat, 0.013, 0.09, px, top + 0.055, 0.055, 'y', 8);
    const len = 0.1 + (i % 3) * 0.04;
    k.cyl(m.chrome, 0.004, len, px, top - 0.01 - len / 2, 0.055, 'y', 5);
  });
  // Lower left: hammers hung by their heads, pliers in a V, two ratchets.
  const low = -h / 2 + 0.12;
  for (let i = 0; i < 3; i++) {
    const hx = -w / 2 + 0.1 + i * 0.11;
    k.box(m.wood, 0.025, 0.28 - i * 0.03, 0.025, hx, low + 0.14, 0.04);
    k.box(m.steel, 0.1 - i * 0.015, 0.035, 0.035, hx, low + 0.29 - i * 0.03, 0.045);
  }
  for (let i = 0; i < 3; i++) {
    const px = -w / 2 + 0.48 + i * 0.09;
    for (const s of [-1, 1]) k.box(m.red, 0.014, 0.16, 0.01, px + s * 0.018, low + 0.09, 0.035, 0, 0, s * 0.12);
    k.box(m.chrome, 0.02, 0.06, 0.012, px, low + 0.2, 0.035);
  }
  for (let i = 0; i < 2; i++) {
    const rx = -0.05 + i * 0.09;
    k.box(m.chrome, 0.016, 0.24 + i * 0.06, 0.008, rx, low + 0.12 + i * 0.03, 0.035);
    k.cyl(m.chrome, 0.024, 0.016, rx, low + 0.26 + i * 0.06, 0.04, 'z', 12);
  }
  // Lower right: a magnetic rail of sockets standing out of the board.
  const rx0 = w * 0.12;
  const rw = w * 0.36;
  k.box(m.red, rw, 0.03, 0.012, rx0 + rw / 2, low + 0.06, 0.028);
  const nk = Math.max(10, Math.floor((rw - 0.06) / 0.042) + 1);
  for (let i = 0; i < nk; i++) {
    const f = i / (nk - 1);
    k.cyl(m.chrome, 0.012 + f * 0.0135, 0.04 + f * 0.018, rx0 + 0.03 + f * (rw - 0.06), low + 0.06, 0.06, 'z', 8);
  }
  k.box(m.black, rw, 0.02, 0.03, rx0 + rw / 2, low + 0.22, 0.035);
  for (let i = 0; i < 6; i++) k.box(m.chrome, 0.02, 0.09 + i * 0.012, 0.012, rx0 + 0.04 + (i * (rw - 0.08)) / 5, low + 0.21 - (0.09 + i * 0.012) / 2, 0.04);
}

/** A run of wall cabinets centered at height y along local x: n doors with their seams and handles, a light strip under them. */
export function wallCabinets(k: Kit, x: number, y: number, z: number, yaw: number, w: number, n: number, body: THREE.Material): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  const d = 0.36;
  k.box(body, w, 0.6, d, 0, 0, d / 2);
  for (let i = 1; i < n; i++) k.box(m.black, 0.008, 0.58, 0.006, -w / 2 + (i * w) / n, 0, d + 0.003);
  for (let i = 0; i < n; i++) k.box(m.chrome, 0.02, 0.14, 0.025, -w / 2 + ((i + 0.5) * w) / n + (i % 2 ? -1 : 1) * (w / n / 2 - 0.06), -0.18, d + 0.012);
  k.box(m.tube, w - 0.12, 0.012, 0.025, 0, -0.306, d - 0.06);
  k.plane(m.wash, w - 0.1, 0.75, 0, -0.31 - 0.375, 0.004);
}

/** The jobs whiteboard centered at height y on a wall: aluminium frame, the board, the marker tray with markers and an eraser. */
export function whiteboard(k: Kit, x: number, y: number, z: number, yaw: number, w: number, h: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.galv, w + 0.04, h + 0.04, 0.02, 0, 0, 0.01);
  k.plane(m.whiteboard, w, h, 0, 0, 0.021);
  k.box(m.galv, w * 0.6, 0.02, 0.06, 0, -h / 2 - 0.02, 0.04);
  [m.blue, m.red, m.black].forEach((c, i) => k.cyl(c, 0.008, 0.12, -0.1 + i * 0.05, -h / 2 - 0.002, 0.05, 'x', 6));
  k.box(m.black, 0.12, 0.03, 0.045, 0.2, -h / 2 + 0.005, 0.045);
}

/** A clipboard with a work order on it, hung at (x, y, z) facing local +z. */
export function clipboard(k: Kit, x: number, y: number, z: number, yaw: number): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  k.box(m.wood, 0.24, 0.32, 0.008, 0, 0, 0.004);
  k.plane(m.workOrder, 0.21, 0.29, 0, -0.01, 0.0095);
  k.box(m.chrome, 0.1, 0.03, 0.012, 0, 0.15, 0.012);
}

/**
 * A reel hung from the roof truss at height `y` (its center): the bracket up
 * to the chord at `chord`, the reel's flanges and drum with the line wound on
 * it, and the line run down to `end` (room space) with an air coupler and its
 * stop ball, or a caged drop light glowing at the end of a cord.
 */
export function ceilingReel(k: Kit, x: number, y: number, z: number, chord: number, line: THREE.Material, end: Vec, kind: 'air' | 'lamp'): void {
  const m = k.m;
  k.place();
  k.box(m.steel, 0.06, chord - y, 0.06, x, (chord + y) / 2, z);
  k.box(m.steel, 0.3, 0.03, 0.12, x, chord - 0.015, z);
  for (const s of [-1, 1]) {
    k.cyl(m.steel, 0.24, 0.015, x + s * 0.09, y, z, 'x', 18);
    k.box(m.steel, 0.02, 0.12, 0.04, x + s * 0.09, y + 0.1, z);
  }
  k.cyl(line, 0.17, 0.16, x, y, z, 'x', 16);
  k.cyl(m.galv, 0.06, 0.24, x, y, z, 'x', 8);
  const [ex, ey, ez] = end;
  k.hose(line, [[x, y - 0.17, z + 0.05], [x + (ex - x) * 0.3, y - 0.6, z + (ez - z) * 0.3], [ex, (y + ey) / 2, ez], [ex, ey, ez]], kind === 'air' ? 0.012 : 0.01, 40);
  if (kind === 'air') {
    k.cyl(m.yellow, 0.035, 0.05, ex, ey + 0.22, ez, 'y', 10);
    k.cyl(m.chrome, 0.012, 0.08, ex, ey - 0.04, ez, 'y', 8);
  } else {
    k.cyl(m.lamp, 0.035, 0.2, ex, ey - 0.12, ez, 'y', 10);
    for (const a of [0, 1.57, 3.14, 4.71]) k.box(m.galv, 0.008, 0.22, 0.008, ex + Math.cos(a) * 0.05, ey - 0.12, ez + Math.sin(a) * 0.05);
    k.cyl(m.rubber, 0.03, 0.08, ex, ey - 0.01, ez, 'y', 10);
    k.box(m.galv, 0.012, 0.14, 0.04, ex, ey + 0.06, ez + 0.04);
  }
}
