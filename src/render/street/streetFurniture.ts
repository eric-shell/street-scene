/**
 * Neighbourhood street furniture as render/street/props.ts draws it: fire hydrants
 * (gushing once broken, hydrantSpray.ts), parking meters, mailboxes, phone
 * booths with a lit sign and vending machines with a glowing front. Low poly,
 * vertex colored, one instanced mesh per kind and part (eight draw calls for
 * all of them), tinted per instance by the neighbourhood palettes below; and
 * how each comes apart as pooled debris (debris.ts). Local frame: +Z faces
 * the road, +X runs along the curb, y up from the sidewalk. Render only.
 */
import * as THREE from 'three';
import type { FurnitureKind } from '../../city/props';
import { GeoBuilder } from '../geoBuilder';
import { D_BOX, D_CYL, D_GLASS, D_GLOW, DebrisType } from './debris';

/** Mesh parts of a prop kind (geometry, material slot, tinted per instance?), its tints and whether instances get a random spin. */
export interface PropPartsDef {
  parts: { geo: () => THREE.BufferGeometry; mat: 'matte' | 'solid' | 'canopy' | 'glow' | 'lamp' | 'glass'; tint?: boolean }[];
  tints: number[];
  spin: boolean;
}

/** Debris spawner of one breaking prop (render/street/props.ts): local offsets, yaw, half extents, push, lift, spin, color, life, sparks. */
export type FurnitureSpawn = (
  type: DebrisType,
  lx: number,
  ly: number,
  lz: number,
  yaw: number,
  hx: number,
  hy: number,
  hz: number,
  push: number,
  lift: number,
  spin: number,
  color: THREE.Color,
  life?: number,
  sparky?: boolean,
) => void;

const col = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

function box(gb: GeoBuilder, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: THREE.Color): void {
  const x0 = cx - sx / 2;
  const x1 = cx + sx / 2;
  const y0 = cy - sy / 2;
  const y1 = cy + sy / 2;
  const z0 = cz - sz / 2;
  const z1 = cz + sz / 2;
  const face = (n: [number, number, number], pts: [number, number, number][]) => {
    const v = pts.map(([x, y, z]) => gb.vertex(x, y, z, n[0], n[1], n[2], 0, 0, color));
    gb.quadFacing(v[0], v[1], v[2], v[3], n[0], n[1], n[2]);
  };
  face([1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]);
  face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
  face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  face([0, 0, -1], [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]);
  face([0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
}

/** Vertical tapered cylinder from y0 to y1 with a top cap. */
function cyl(gb: GeoBuilder, cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, seg: number, color: THREE.Color): void {
  const ring: number[] = [];
  for (let k = 0; k <= seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const nx = Math.cos(a);
    const nz = Math.sin(a);
    ring.push(gb.vertex(cx + nx * r0, y0, cz + nz * r0, nx, 0, nz, 0, 0, color), gb.vertex(cx + nx * r1, y1, cz + nz * r1, nx, 0, nz, 0, 0, color));
  }
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2 + Math.PI / seg;
    gb.quadFacing(ring[k * 2], ring[k * 2 + 2], ring[k * 2 + 3], ring[k * 2 + 1], Math.cos(a), 0, Math.sin(a));
  }
  const c = gb.vertex(cx, y1, cz, 0, 1, 0, 0, 0, color);
  const top: number[] = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    top.push(gb.vertex(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, 0, 1, 0, 0, 0, color));
  }
  for (let k = 0; k < seg; k++) gb.triFacing(c, top[k], top[(k + 1) % seg], 0, 1, 0);
}

// ---------- Geometry ----------

/** Fire hydrant: flange, barrel, bonnet and cap, two hose outlets and the pumper nozzle facing the road (tinted). */
function hydrantGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const body = col(0xe8e8e8);
  const cap = col(0x9a9a9a);
  cyl(s, 0, 0, 0, 0.07, 0.2, 0.19, 7, cap);
  cyl(s, 0, 0, 0.07, 0.58, 0.135, 0.125, 7, body);
  cyl(s, 0, 0, 0.58, 0.64, 0.155, 0.15, 7, body);
  cyl(s, 0, 0, 0.64, 0.76, 0.15, 0.06, 7, body);
  cyl(s, 0, 0, 0.76, 0.84, 0.035, 0.03, 6, cap);
  for (const x of [-1, 1]) box(s, x * 0.18, 0.42, 0, 0.1, 0.1, 0.1, cap);
  box(s, 0, 0.38, 0.17, 0.16, 0.16, 0.1, cap);
  return s.build();
}

/** Parking meter: post, head with a lit coin slot window, domed top. */
function parkingMeterGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const metal = col(0x5a6068);
  cyl(s, 0, 0, 0, 1.05, 0.04, 0.035, 6, col(0x2a2c32));
  box(s, 0, 1.22, 0, 0.2, 0.34, 0.15, metal);
  cyl(s, 0, 0, 1.39, 1.46, 0.1, 0.06, 8, metal);
  box(s, 0, 1.27, 0.08, 0.13, 0.1, 0.02, col(0xbfe8c8));
  box(s, 0, 1.13, 0.08, 0.05, 0.05, 0.02, col(0x1a1c20));
  return s.build();
}

/** Mailbox: a blue collection box on four short legs, stepped round top, pull handle and slot (tinted). */
function mailboxGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const body = col(0xffffff);
  const dark = col(0x1c1e24);
  for (const x of [-0.2, 0.2]) for (const z of [-0.17, 0.17]) box(s, x, 0.15, z, 0.05, 0.3, 0.05, dark);
  box(s, 0, 0.66, 0, 0.5, 0.72, 0.44, body);
  box(s, 0, 1.06, 0, 0.5, 0.08, 0.38, body);
  box(s, 0, 1.13, 0, 0.5, 0.06, 0.26, body);
  box(s, 0, 0.96, 0.225, 0.3, 0.05, 0.02, dark);
  box(s, 0, 0.62, 0.225, 0.22, 0.2, 0.012, col(0xe8e8f0, 0.8));
  return s.build();
}

/** Phone booth frame: plinth, corner posts, roof, the phone on the back wall (tinted). */
function phoneBoothFrameGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const frame = col(0xffffff);
  box(s, 0, 0.04, 0, 1.0, 0.08, 1.0, col(0x55585e));
  for (const x of [-0.46, 0.46]) for (const z of [-0.46, 0.46]) box(s, x, 1.18, z, 0.07, 2.2, 0.07, frame);
  box(s, 0, 2.33, 0, 1.06, 0.14, 1.06, frame);
  box(s, 0, 0.12, 0, 0.98, 0.06, 0.98, frame);
  box(s, 0, 1.25, -0.43, 0.28, 0.42, 0.1, col(0x2a2c32));
  box(s, 0.12, 1.32, -0.37, 0.05, 0.2, 0.05, col(0x15161a));
  return s.build();
}

/** Glass on three sides and the door. */
function phoneBoothGlassGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder();
  box(s, 0, 1.12, -0.46, 0.86, 1.9, 0.02, col(0xffffff));
  box(s, -0.46, 1.12, 0, 0.02, 1.9, 0.86, col(0xffffff));
  box(s, 0.46, 1.12, 0, 0.02, 1.9, 0.86, col(0xffffff));
  box(s, 0, 1.12, 0.46, 0.86, 1.9, 0.02, col(0xffffff));
  return s.build();
}

/** The lit PHONE band under the roof on all four sides, and the light inside. */
function phoneBoothGlowGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  const sign = col(0xfff2d6, 2.2);
  box(s, 0, 2.18, 0, 1.0, 0.14, 1.0, sign);
  box(s, 0, 2.08, 0, 0.3, 0.03, 0.3, col(0xfff6e8, 3));
  return s.build();
}

/** Vending machine body: cabinet, delivery bin and the coin panel (tinted). */
function vendingBodyGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, 0, 0.95, 0, 0.98, 1.9, 0.78, col(0xffffff));
  box(s, 0, 0.03, 0, 0.94, 0.06, 0.74, col(0x15161a));
  box(s, -0.08, 0.3, 0.395, 0.6, 0.2, 0.02, col(0x15161a));
  box(s, 0.37, 1.0, 0.395, 0.16, 0.5, 0.02, col(0x3a3d44));
  return s.build();
}

/** Its lit display: rows of drinks behind the glass (unlit material, it blooms a little). */
function vendingGlowGeo(): THREE.BufferGeometry {
  const s = new GeoBuilder(true);
  box(s, -0.1, 1.15, 0.395, 0.66, 1.25, 0.012, col(0xdfefff, 1.25));
  const drinks = [0xff3040, 0x30a0ff, 0xffd030, 0x40e070, 0xff7a20, 0xf0f0f0];
  for (let r = 0; r < 5; r++) {
    for (let k = 0; k < 5; k++) box(s, -0.36 + k * 0.13, 0.65 + r * 0.24, 0.404, 0.07, 0.13, 0.008, col(drinks[(r * 2 + k) % drinks.length], 1.6));
  }
  return s.build();
}

/** Per kind: parts, neighbourhood tints (hydrants red, chrome yellow or safety green; mailboxes blue, the odd red and green...). */
export const FURNITURE_PARTS: Record<FurnitureKind, PropPartsDef> = {
  hydrant: { parts: [{ geo: hydrantGeo, mat: 'solid', tint: true }], tints: [0xd02020, 0xd02020, 0xf0c020, 0xe8e8e8, 0x30a050], spin: false },
  parkingMeter: { parts: [{ geo: parkingMeterGeo, mat: 'solid' }], tints: [0xffffff], spin: false },
  mailbox: { parts: [{ geo: mailboxGeo, mat: 'solid', tint: true }], tints: [0x2a5ad0, 0x2a5ad0, 0x2a5ad0, 0xc02424, 0x2e8a48], spin: false },
  phoneBooth: {
    parts: [
      { geo: phoneBoothFrameGeo, mat: 'solid', tint: true },
      { geo: phoneBoothGlassGeo, mat: 'glass' },
      { geo: phoneBoothGlowGeo, mat: 'glow' },
    ],
    tints: [0x9aa0a8, 0xc02020, 0x2050a0, 0x9aa0a8],
    spin: false,
  },
  vendingMachine: {
    parts: [
      { geo: vendingBodyGeo, mat: 'solid', tint: true },
      { geo: vendingGlowGeo, mat: 'glow' },
    ],
    tints: [0xd02030, 0x2050c0, 0xe8e8e8, 0x202226, 0xe06a1a],
    spin: false,
  },
};

/**
 * How a piece of neighbourhood furniture comes apart. `tint` is its instance
 * color; `burst` throws sparks (metal on metal) from a world point.
 */
export function shatterFurniture(
  kind: FurnitureKind,
  spawn: FurnitureSpawn,
  speed: number,
  yaw: number,
  tint: THREE.Color,
  burst: (ly: number, speed: number, count: number) => void,
): void {
  switch (kind) {
    case 'hydrant': {
      // The barrel shears off its flange and tumbles away; the caps go flying.
      const body = col(0xe8e8e8).multiply(tint);
      spawn(D_CYL, 0, 0.4, 0, yaw, 0.13, 0.3, 0.13, rnd(0.3, 0.5), 2 + speed * 0.08, 6, body, rnd(5, 6.5), true);
      spawn(D_CYL, 0, 0.72, 0, yaw, 0.15, 0.06, 0.15, rnd(0.4, 0.7), 4 + speed * 0.1, 10, body, rnd(4.5, 6), true);
      for (let k = 0; k < 3; k++) spawn(D_BOX, rnd(-0.2, 0.2), 0.42, rnd(-0.1, 0.2), rnd(0, 6.28), 0.05, 0.05, 0.05, rnd(0.4, 0.8), rnd(3, 6), 12, col(0x9a9a9a), rnd(3.5, 5), true);
      for (let k = 0; k < 10; k++) spawn(D_GLASS, rnd(-0.1, 0.1), rnd(0.3, 0.6), rnd(-0.1, 0.1), rnd(0, 6.28), rnd(0.05, 0.1), rnd(0.05, 0.1), 0.01, rnd(0.1, 0.4), rnd(4, 8), 6, col(0xbfd8e8), rnd(1, 1.8));
      burst(0.3, speed * 0.3 + 2, 14);
      return;
    }
    case 'parkingMeter': {
      spawn(D_CYL, 0, 0.55, 0, yaw, 0.04, 0.52, 0.04, rnd(0.4, 0.7), 1.5 + speed * 0.06, 6, col(0x2a2c32), rnd(4.5, 6), true);
      spawn(D_BOX, 0, 1.22, 0, yaw + rnd(-0.4, 0.4), 0.1, 0.17, 0.075, rnd(0.6, 0.9), 3 + speed * 0.1, 10, col(0x5a6068), rnd(4.5, 6), true);
      // Coins: a shower of small glinting bits.
      for (let k = 0; k < 14; k++) spawn(D_GLOW, rnd(-0.08, 0.08), 1.2, rnd(-0.05, 0.05), rnd(0, 6.28), 0.014, 0.004, 0.014, rnd(0.3, 0.7), rnd(2, 5), 14, col(0xd8b860, 1.4), rnd(2, 3.5));
      burst(1.1, speed * 0.2 + 1, 6);
      return;
    }
    case 'mailbox': {
      const body = col(0xffffff).multiply(tint);
      spawn(D_BOX, 0, 0.66, 0, yaw + rnd(-0.2, 0.2), 0.25, 0.36, 0.22, rnd(0.45, 0.75), 2 + speed * 0.09, 6, body, rnd(5, 6.5), true);
      spawn(D_BOX, 0, 1.1, 0, yaw + rnd(-0.5, 0.5), 0.25, 0.05, 0.2, rnd(0.5, 0.8), 3 + speed * 0.12, 9, body, rnd(4.5, 6), true);
      // The post: letters and postcards fluttering everywhere.
      for (let k = 0; k < 18; k++) spawn(D_BOX, rnd(-0.2, 0.2), rnd(0.4, 1), rnd(-0.15, 0.15), rnd(0, 6.28), rnd(0.07, 0.12), 0.003, rnd(0.04, 0.07), rnd(0.2, 0.6), rnd(2.5, 6), 6, col(k % 4 ? 0xf2efe6 : 0xd8e4f0), rnd(4, 6));
      return;
    }
    case 'phoneBooth': {
      const frame = col(0xffffff).multiply(tint);
      spawn(D_BOX, 0, 2.33, 0, yaw + rnd(-0.2, 0.2), 0.53, 0.07, 0.53, rnd(0.25, 0.45), 2 + speed * 0.08, 3, frame, rnd(5, 6.5), true);
      for (const x of [-0.46, 0.46]) for (const z of [-0.46, 0.46]) spawn(D_BOX, x, 1.18, z, yaw, 0.035, 1.1, 0.035, rnd(0.3, 0.6), rnd(1, 3), 4, frame, rnd(4.5, 6), true);
      spawn(D_GLOW, 0, 2.18, 0, yaw, 0.5, 0.07, 0.04, rnd(0.3, 0.5), rnd(1.5, 3), 4, col(0xfff2d6, 2));
      spawn(D_BOX, 0, 1.25, -0.43, yaw + rnd(-0.6, 0.6), 0.14, 0.21, 0.05, rnd(0.4, 0.7), rnd(2, 4), 8, col(0x2a2c32));
      const glass = col(0xbfe0ff);
      for (let k = 0; k < 26; k++) spawn(D_GLASS, rnd(-0.45, 0.45), rnd(0.3, 2.1), rnd(-0.45, 0.45), rnd(0, 6.28), rnd(0.06, 0.18), rnd(0.06, 0.18), 0.008, rnd(0.25, 0.75), rnd(0.5, 3.5), 9, glass, rnd(2.5, 4));
      burst(1.2, speed * 0.3 + 2, 10);
      return;
    }
    case 'vendingMachine': {
      // The cabinet topples, the display goes dark in pieces, cans roll everywhere.
      spawn(D_BOX, 0, 0.95, 0, yaw + rnd(-0.1, 0.1), 0.49, 0.95, 0.39, rnd(0.2, 0.35), 0.8 + speed * 0.04, 2, col(0xffffff).multiply(tint), rnd(6, 7), true);
      spawn(D_GLOW, -0.1, 1.15, 0.4, yaw, 0.33, 0.6, 0.01, rnd(0.35, 0.55), rnd(1.5, 3), 4, col(0xdfefff, 1.2), rnd(2.5, 3.5));
      const drinks = [0xff3040, 0x30a0ff, 0xffd030, 0x40e070, 0xff7a20, 0xf0f0f0];
      for (let k = 0; k < 16; k++) spawn(D_CYL, rnd(-0.35, 0.35), rnd(0.4, 1.6), rnd(-0.2, 0.3), rnd(0, 6.28), 0.033, 0.06, 0.033, rnd(0.4, 0.9), rnd(2, 5) + speed * 0.05, 10, col(drinks[k % drinks.length]), rnd(4, 5.5), true);
      for (let k = 0; k < 10; k++) spawn(D_GLASS, rnd(-0.4, 0.3), rnd(0.6, 1.7), 0.4, rnd(0, 6.28), rnd(0.05, 0.14), rnd(0.05, 0.14), 0.008, rnd(0.3, 0.7), rnd(1, 3), 8, col(0xcfe6ff), rnd(2.5, 4));
      burst(0.9, speed * 0.3 + 3, 16);
      return;
    }
  }
}
