/**
 * The windshield, split from a car's glass once per loaded model (CarAssetLibrary.carModel), so the build's tint
 * dresses only the side and rear windows (the windshield stays clear) and the banner, a band across its top of the
 * the windows' tint (the same glass, in place of the windshield's) or of vinyl, can be drawn on it. No car model names its windshield: it is the glass in the front half
 * that leans forward and up (its inside back and down) with little sideways lean (WINDSHIELD), in the one glass mesh
 * with the most of it (a sunroof in a mesh of its own has a few such faces on its bevels), which picks it on every
 * shipped car and leaves the side glass, the backlight and a sunroof. The windshield and the banner are two
 * meshes under the glass mesh, sharing its attributes with an index of their own, so they ride its node and hide
 * with it; CarView.bindMaterials gives them their runtime materials (carMaterial on the placeholders). The band is
 * as deep all the way across: each vertex carries its drop below the top edge (topEdge), and the banner draws where
 * that is under the build's depth.
 */
import * as THREE from 'three';
import type { BannerHeight } from '../../shared/carBuild';
import { VEHICLE_ORDER } from '../vehicleMask';

/** The face tests, on unit face normals in car space (+Y up, +Z forward). */
const WINDSHIELD = {
  /** Least forward lean (backward, inside): a windshield raked 70 degrees from vertical still has 0.34. */
  lean: 0.2,
  /** Least upward lean (downward, inside), which the side glass's near vertical facets lack. */
  rise: 0.15,
  /** Most sideways lean: past it a face is side glass (a curved windshield's corners stay under it). */
  side: 0.7,
  /**
   * Steepest slope (rise over run, seen from the front) the top edge has: the upper outline turns down the pillars
   * past it, and the band holds level from there to the glass's sides instead of following them down.
   */
  topSlope: 1,
} as const;

/** The banner: each height's depth below the windshield's top edge, as a share of the windshield's height. */
export const BANNER = { height: { short: 0.14, medium: 0.22, tall: 0.32 } satisfies Record<BannerHeight, number> } as const;

/** The runtime materials the split's placeholders stand for (CarMaterialSet keys, in userData.carMaterial). */
export type WindshieldMaterial = 'Windshield' | 'Banner';

/** A car's windshield, bottom and top edge heights (m, car space): the banner's band is measured down from the top. */
export interface WindshieldSpan {
  bottom: number;
  top: number;
}

/** How far below the top edge (m) the banner reaches for a build's banner height. */
export function bannerDepth(span: WindshieldSpan, height: BannerHeight): number {
  return BANNER.height[height] * (span.top - span.bottom);
}

/**
 * The windshield's top edge seen from the front, as its height (m) at a car x: the upper outline of its points
 * (x, y), kept to the shallow run around its peak (WINDSHIELD.topSlope) and held level past its ends.
 */
export function topEdge(points: readonly (readonly [number, number])[]): (x: number) => number {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  // The upper hull, left to right (monotone chain): a point that makes a left turn or none drops out.
  const hull: (readonly [number, number])[] = [];
  for (const p of sorted) {
    while (hull.length >= 2) {
      const [o, a] = [hull[hull.length - 2], hull[hull.length - 1]];
      if ((a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0]) < 0) break;
      hull.pop();
    }
    hull.push(p);
  }
  const shallow = (i: number) => Math.abs(hull[i + 1][1] - hull[i][1]) <= WINDSHIELD.topSlope * (hull[i + 1][0] - hull[i][0]);
  let peak = 0;
  for (let i = 1; i < hull.length; i++) if (hull[i][1] > hull[peak][1]) peak = i;
  let l = peak;
  let r = peak;
  while (l > 0 && shallow(l - 1)) l--;
  while (r < hull.length - 1 && shallow(r)) r++;
  return (x) => {
    if (x <= hull[l][0]) return hull[l][1];
    for (let i = l; i < r; i++) {
      const [a, b] = [hull[i], hull[i + 1]];
      if (x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || 1);
    }
    return hull[r][1];
  };
}

/**
 * Split the windshield out of the glass under `root` (a freshly loaded car scene, before any clone): its glass mesh
 * keeps the rest, the windshield and its banner become its children, and `root.userData.windshield` holds their
 * span (WindshieldSpan), or stays unset on a car where no glass passes. Each windshield vertex also carries its drop
 * below the top edge (m, `bannerDrop`), which the banner's and the windshield's clips read. `isGlass` says which
 * source materials are glass.
 */
export function splitWindshield(root: THREE.Object3D, isGlass: (m: THREE.Material) => boolean): void {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && isGlass(mesh.material)) meshes.push(mesh);
  });
  // The glass's mid length over every glass mesh: the windshield is in front of it.
  const box = new THREE.Box3();
  for (const mesh of meshes) box.union(new THREE.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld)));
  const midZ = (box.min.z + box.max.z) / 2;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  // Each glass mesh's faces that pass, and their area (m²): the windshield is the mesh with the most.
  let best: { mesh: THREE.Mesh; car: THREE.Vector3[]; shield: number[]; rest: number[]; area: number } | null = null;
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const at = (i: number) => (index ? index.getX(i) : i);
    const toCar = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    // Car space positions, once per vertex.
    const car = Array.from({ length: pos.count }, (_, k) => new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(toCar));
    const shield: number[] = [];
    const rest: number[] = [];
    let area = 0;
    for (let t = 0; t + 2 < count; t += 3) {
      const i = at(t);
      const j = at(t + 1);
      const k = at(t + 2);
      a.copy(car[i]);
      b.copy(car[j]).sub(a);
      c.copy(car[k]).sub(a);
      n.crossVectors(b, c);
      const twice = n.length();
      n.divideScalar(twice || 1);
      // Forward and up together (or, inside, back and down together): the backlight leans back and up.
      const front = (car[i].z + car[j].z + car[k].z) / 3 > midZ;
      const hit = front && n.y * n.z > 0 && Math.abs(n.z) > WINDSHIELD.lean && Math.abs(n.y) > WINDSHIELD.rise && Math.abs(n.x) < WINDSHIELD.side;
      (hit ? shield : rest).push(i, j, k);
      if (hit) area += twice / 2;
    }
    if (shield.length && area > (best?.area ?? 0)) best = { mesh, car, shield, rest, area };
  }
  if (best) {
    const { mesh, car, shield, rest } = best;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const ids = [...new Set(shield)];
    const edge = topEdge(ids.map((k) => [car[k].x, car[k].y] as const));
    const drop = new Float32Array(pos.count);
    let bottom = Infinity;
    let top = -Infinity;
    for (const k of ids) {
      const { x, y } = car[k];
      drop[k] = Math.max(0, edge(x) - y);
      if (y < bottom) bottom = y;
      if (y > top) top = y;
    }
    // Both share the glass's attributes; only the index is their own.
    const sub = (ids: number[]) => {
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
      g.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? new Uint32Array(ids) : new Uint16Array(ids), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    };
    const shieldGeo = sub(shield);
    shieldGeo.setAttribute('bannerDrop', new THREE.BufferAttribute(drop, 1));
    mesh.geometry = sub(rest);
    for (const [name, key] of [['Windshield', 'Windshield'], ['WindshieldBanner', 'Banner']] as const) {
      const placeholder = new THREE.MeshBasicMaterial({ name });
      placeholder.userData.carMaterial = key satisfies WindshieldMaterial;
      const part = new THREE.Mesh(shieldGeo, placeholder);
      part.name = name;
      // Neither covers the other (each is clipped to its side of the band), so the order is only the car's.
      part.renderOrder = VEHICLE_ORDER;
      mesh.add(part);
    }
    root.userData.windshield = { bottom, top } satisfies WindshieldSpan;
  }
}
