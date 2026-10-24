/**
 * The Kit every garage prop draws into: primitives (box, cylinder, bar, hose,
 * plane) collected per material through a local frame (x along the prop's wall,
 * +z facing into the room, set by place()) and merged into one mesh per
 * material by build(); plus the caster most wheeled props stand on. Render only.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Disposable } from '../../render/disposer';
import type { Mats } from './materials';

export type Vec = [number, number, number];

/** Merged primitives per material, placed through a local frame. */
export class Kit {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly frame = new THREE.Matrix4();
  private readonly m4 = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();
  private readonly v0 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();

  constructor(readonly m: Mats) {}

  /** Following pieces are in a local frame at (x, y, z) turned by yaw; no arguments puts them back in room space. */
  place(x = 0, y = 0, z = 0, yaw = 0): this {
    this.frame.makeRotationY(yaw).setPosition(x, y, z);
    return this;
  }

  add(mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): void {
    geo.applyMatrix4(this.m4.makeRotationFromEuler(this.euler.set(rx, ry, rz, 'YXZ')));
    geo.translate(x, y, z);
    geo.applyMatrix4(this.frame);
    const list = this.parts.get(mat) ?? [];
    list.push(geo);
    this.parts.set(mat, list);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0): void {
    this.add(mat, new THREE.BoxGeometry(w, h, d), x, y, z, ry, rx, rz);
  }

  /** A cylinder of radius r (r2 at the bottom) and length h along an axis. */
  cyl(mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y', seg = 14, r2 = r): void {
    const g = new THREE.CylinderGeometry(r, r2, h, seg);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    this.add(mat, g, x, y, z);
  }

  /** A bar of square section t from a to b (arms, braces, chains, cables). */
  bar(mat: THREE.Material, a: Vec, b: Vec, t: number, t2 = t): void {
    const from = this.v0.set(...a);
    const dir = this.v1.set(...b).sub(from);
    const len = dir.length();
    const g = new THREE.BoxGeometry(t, t2, len);
    g.applyMatrix4(this.m4.compose(from.addScaledVector(dir, 0.5), this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize()), new THREE.Vector3(1, 1, 1)));
    g.applyMatrix4(this.frame);
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }

  /** A hose or cable through points (a smooth curve), radius r. */
  hose(mat: THREE.Material, pts: Vec[], r: number, seg = 48): void {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    this.add(mat, new THREE.TubeGeometry(curve, seg, r, 6));
  }

  /** A flat decal lying on the floor (or a plane on a wall with rx = 0). */
  plane(mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry = 0, rx = 0): void {
    this.add(mat, new THREE.PlaneGeometry(w, h), x, y, z, ry, rx);
  }

  /** Merge each material's pieces into one mesh and add them to the scene. */
  build(scene: THREE.Object3D, track: <T extends Disposable>(x: T) => T): void {
    for (const [mat, list] of this.parts) {
      const mesh = new THREE.Mesh(track(mergeGeometries(list)), mat);
      mesh.renderOrder = (mat.userData.renderOrder as number | undefined) ?? 0;
      list.forEach((g) => g.dispose());
      scene.add(mesh);
    }
    this.parts.clear();
  }
}

/** A caster whose top plate is at height y, in the current frame: swivel plate, fork and wheel. */
export function caster(k: Kit, x: number, z: number, y: number): void {
  const m = k.m;
  const r = y * 0.38;
  k.box(m.steel, 0.08, 0.012, 0.08, x, y - 0.006, z);
  for (const s of [-1, 1]) k.box(m.steel, 0.008, y - r * 0.6, r * 1.3, x + s * 0.028, (y + r * 0.6) / 2, z);
  k.cyl(m.rubber, r, 0.04, x, r, z, 'x', 12);
}
