/**
 * The windshield, split from a car's glass once per loaded model (CarAssetLibrary.carModel), so the build's tint
 * dresses only the side and rear windows (the windshield stays clear) and the banner, a band of film or vinyl
 * across its top, can be drawn over it. No car model names its windshield: it is the glass in the front half
 * that leans forward and up (its inside back and down) with little sideways lean (WINDSHIELD), in the one glass mesh
 * with the most of it (a sunroof in a mesh of its own has a few such faces on its bevels), which picks it on every
 * shipped car and leaves the side glass, the backlight and a sunroof. The windshield and the banner are two
 * meshes under the glass mesh, sharing its attributes with an index of their own, so they ride its node and hide
 * with it; CarView.bindMaterials gives them their runtime materials (carMaterial on the placeholders).
 */
import * as THREE from 'three';
import type { BannerHeight } from '../../shared/carBuild';

/** The face tests, on unit face normals in car space (+Y up, +Z forward). */
const WINDSHIELD = {
  /** Least forward lean (backward, inside): a windshield raked 70 degrees from vertical still has 0.34. */
  lean: 0.2,
  /** Least upward lean (downward, inside), which the side glass's near vertical facets lack. */
  rise: 0.15,
  /** Most sideways lean: past it a face is side glass (a curved windshield's corners stay under it). */
  side: 0.7,
} as const;

/**
 * The banner: each height's share of the windshield's height down from its top edge, and the least darkness
 * (0..1, the tint's scale) of the tint film a linked banner is, so a light tint still shows a band.
 */
export const BANNER = { height: { short: 0.14, medium: 0.22, tall: 0.32 } satisfies Record<BannerHeight, number>, film: 0.85 } as const;

/** The runtime materials the split's placeholders stand for (CarMaterialSet keys, in userData.carMaterial). */
export type WindshieldMaterial = 'Windshield' | 'Banner';

/** A car's windshield, bottom and top edge heights (m, car space): the banner's band is measured down from the top. */
export interface WindshieldSpan {
  bottom: number;
  top: number;
}

/** The car height (m) the banner starts at for a build's banner height: below it the banner is clipped away. */
export function bannerFrom(span: WindshieldSpan, height: BannerHeight): number {
  return span.top - BANNER.height[height] * (span.top - span.bottom);
}

/**
 * Split the windshield out of the glass under `root` (a freshly loaded car scene, before any clone): its glass mesh
 * keeps the rest, the windshield and its banner become its children, and `root.userData.windshield` holds their
 * span (WindshieldSpan), or stays unset on a car where no glass passes. Each windshield vertex also carries its car
 * height (`carY`), which the banner's clip reads. `isGlass` says which source materials are glass.
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
  let best: { mesh: THREE.Mesh; carY: Float32Array; shield: number[]; rest: number[]; area: number } | null = null;
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const at = (i: number) => (index ? index.getX(i) : i);
    const toCar = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    // Car space positions, once per vertex.
    const carY = new Float32Array(pos.count);
    const car = Array.from({ length: pos.count }, (_, k) => {
      const v = new THREE.Vector3().fromBufferAttribute(pos, k).applyMatrix4(toCar);
      carY[k] = v.y;
      return v;
    });
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
    if (shield.length && area > (best?.area ?? 0)) best = { mesh, carY, shield, rest, area };
  }
  if (best) {
    const { mesh, carY, shield, rest } = best;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    let bottom = Infinity;
    let top = -Infinity;
    for (let t = 0; t < shield.length; t++) {
      const y = carY[shield[t]];
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
    shieldGeo.setAttribute('carY', new THREE.BufferAttribute(carY, 1));
    mesh.geometry = sub(rest);
    for (const [name, key] of [['Windshield', 'Windshield'], ['WindshieldBanner', 'Banner']] as const) {
      const placeholder = new THREE.MeshBasicMaterial({ name });
      placeholder.userData.carMaterial = key satisfies WindshieldMaterial;
      const part = new THREE.Mesh(shieldGeo, placeholder);
      part.name = name;
      mesh.add(part);
    }
    root.userData.windshield = { bottom, top } satisfies WindshieldSpan;
  }
}
