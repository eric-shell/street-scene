/**
 * Roadblocks: side streets the racers are unlikely to hit are closed with a
 * line of parked cars, broadside to the intersection, hazards blinking. The
 * collision is still the barrier wall segment. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import { Rng } from '../sim/prng';
import { GeoBuilder } from './geoBuilder';
import type { BarrierInfo } from './routeArrows';

const PAINTS = [0xc81e2e, 0x1d55c4, 0xe8e8ea, 0x15161a, 0xf2b81c, 0x2a9d5a, 0x6b2fc2, 0x9aa3ad, 0xff6a00].map((c) => new THREE.Color(c));

/** Box with an optional tapered top, oriented by yaw (local +Z forward), written into gb. */
function orientedBox(gb: GeoBuilder, cx: number, cy: number, cz: number, yaw: number, L: number, W: number, H: number, color: THREE.Color, taperX = 0, taperZ = 0): void {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const lx = fz;
  const lz = -fx;
  const p = (x: number, y: number, z: number) => ({ x: cx + lx * x + fx * z, y: cy + y, z: cz + lz * x + fz * z });
  const hw = W / 2;
  const hl = L / 2;
  const tw = hw * (1 - taperX);
  const tl = hl * (1 - taperZ);
  const b = [p(-hw, 0, -hl), p(hw, 0, -hl), p(hw, 0, hl), p(-hw, 0, hl), p(-tw, H, -tl), p(tw, H, -tl), p(tw, H, tl), p(-tw, H, tl)];
  const faces = [
    [7, 6, 5, 4],
    [3, 2, 6, 7],
    [1, 0, 4, 5],
    [2, 1, 5, 6],
    [0, 3, 7, 4],
  ];
  const center = { x: cx, y: cy + H / 2, z: cz };
  for (const f of faces) {
    const q = f.map((i) => b[i]);
    const ux = q[1].x - q[0].x;
    const uy = q[1].y - q[0].y;
    const uz = q[1].z - q[0].z;
    const vx = q[2].x - q[0].x;
    const vy = q[2].y - q[0].y;
    const vz = q[2].z - q[0].z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const mid = { x: (q[0].x + q[2].x) / 2 - center.x, y: (q[0].y + q[2].y) / 2 - center.y, z: (q[0].z + q[2].z) / 2 - center.z };
    if (nx * mid.x + ny * mid.y + nz * mid.z < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const v = q.map((pt) => gb.vertex(pt.x, pt.y, pt.z, nx, ny, nz, 0, 0, color));
    gb.quadFacing(v[0], v[1], v[2], v[3], nx, ny, nz);
  }
}

export interface Roadblocks {
  group: THREE.Group;
  dispose(): void;
}

export function buildRoadblocks(world: World, barriers: BarrierInfo[], hazardMaterial: THREE.Material): Roadblocks {
  const group = new THREE.Group();
  group.name = 'roadblocks';
  const rng = new Rng(world.seed ^ 0xb10c);
  const bodies = new GeoBuilder(true);
  const lights = new GeoBuilder(true);
  const hazards = new GeoBuilder(true);
  const glass = new THREE.Color(0x0c1018);
  const black = new THREE.Color(0x0b0b0c);
  const tail = new THREE.Color(0xff1a2a).multiplyScalar(2.2);
  const head = new THREE.Color(0xeaf2ff).multiplyScalar(1.6);
  const white = new THREE.Color(1, 1, 1);
  const L = 4.4;
  const W = 1.8;
  for (const b of barriers) {
    if (b.headOn) continue;
    const w = b.wall;
    const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    const dx = (w.bx - w.ax) / len;
    const dz = (w.bz - w.az) / len;
    const count = Math.max(1, Math.floor((len + 0.6) / (L + 0.3)));
    const gap = len / count;
    for (let i = 0; i < count; i++) {
      const along = gap * (i + 0.5);
      // Car centers sit just behind the barrier line, inside the closed street.
      const cx = w.ax + dx * along - w.nx * (W / 2 + 0.15);
      const cz = w.az + dz * along - w.nz * (W / 2 + 0.15);
      const ground = world.heightAt(cx, cz);
      const facing = rng.chance(0.5) ? 1 : -1;
      const yaw = Math.atan2(dx * facing, dz * facing) + rng.range(-0.12, 0.12);
      const paint = PAINTS[rng.int(0, PAINTS.length - 1)].clone().multiplyScalar(rng.range(0.75, 1));
      const y = ground + 0.12;
      orientedBox(bodies, cx, y + 0.18, cz, yaw, L, W, 0.62, paint, 0.03, 0.02);
      orientedBox(bodies, cx - Math.sin(yaw) * 0.25, y + 0.8, cz - Math.cos(yaw) * 0.25, yaw, 2.3, W * 0.9, 0.5, glass, 0.14, 0.32);
      orientedBox(bodies, cx - Math.sin(yaw) * 0.3, y + 1.27, cz - Math.cos(yaw) * 0.3, yaw, 1.3, W * 0.74, 0.04, paint);
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      for (const [su, sv] of [
        [1.35, 1],
        [1.35, -1],
        [-1.35, 1],
        [-1.35, -1],
      ]) {
        const wx = cx + fx * su + fz * sv * (W / 2 - 0.1);
        const wz = cz + fz * su - fx * sv * (W / 2 - 0.1);
        orientedBox(bodies, wx, ground, wz, yaw, 0.62, 0.24, 0.62, black);
      }
      for (const sv of [1, -1]) {
        const hx = cx + fx * (L / 2 + 0.01) + fz * sv * 0.6;
        const hz = cz + fz * (L / 2 + 0.01) - fx * sv * 0.6;
        orientedBox(lights, hx, y + 0.52, hz, yaw, 0.04, 0.38, 0.1, head);
        const tx = cx - fx * (L / 2 + 0.01) + fz * sv * 0.6;
        const tz = cz - fz * (L / 2 + 0.01) - fx * sv * 0.6;
        orientedBox(lights, tx, y + 0.55, tz, yaw, 0.04, 0.42, 0.11, tail);
        // hazards: small amber blinkers at the corners
        orientedBox(hazards, cx + fx * (L / 2 + 0.02) + fz * sv * 0.82, y + 0.5, cz + fz * (L / 2 + 0.02) - fx * sv * 0.82, yaw, 0.04, 0.12, 0.08, white);
        orientedBox(hazards, cx - fx * (L / 2 + 0.02) + fz * sv * 0.82, y + 0.56, cz - fz * (L / 2 + 0.02) - fx * sv * 0.82, yaw, 0.04, 0.12, 0.08, white);
      }
    }
  }
  const disposables: { dispose(): void }[] = [];
  if (bodies.vertexCount) {
    const geo = bodies.build();
    const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 });
    group.add(new THREE.Mesh(geo, mat));
    const lg = lights.build();
    const lm = new THREE.MeshBasicMaterial({ vertexColors: true });
    group.add(new THREE.Mesh(lg, lm));
    const hg = hazards.build();
    group.add(new THREE.Mesh(hg, hazardMaterial));
    disposables.push(geo, mat, lg, lm, hg);
  }
  return {
    group,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
