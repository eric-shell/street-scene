/**
 * The mirror caps, split from a car's body paint once per loaded model (CarAssetLibrary.carModel), so the build's
 * mirror paint (VisualBuild.mirrors) dresses them apart from the body: matched, a contrast color, or chrome. No car
 * model names its mirrors and most are welded to the door skin, so the manifest gives each car a box round its left
 * mirror (`mirrorCaps`, car space, mirrored for the right one), reaching inboard until no more faces come in: the whole
 * housing with its inner end and stalk, short of the door's own faces. A Paint face with all three corners in a box is
 * cap; a face across the box's edge (the door's) stays body, so the cut runs along the model's own edges. The caps become a mesh under each Paint mesh,
 * sharing its attributes with an index of their own (windshield.ts does the same for the glass), so they ride its
 * node and hide with it; CarView.bindMaterials gives them MirrorPaint (carMaterial on the placeholder).
 */
import * as THREE from 'three';

/** The runtime material the caps' placeholder stands for (a CarMaterialSet key, in userData.carMaterial). */
export type MirrorCapMaterial = 'MirrorPaint';

/** A car's left mirror cap in car space (m, x left, y up, z forward): the manifest's `mirrorCaps`. */
export interface MirrorCapBox {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Split the mirror caps out of the Paint meshes under `root` (a freshly loaded car scene, before any clone): each
 * Paint mesh with faces in `box` (or its mirror across x = 0) keeps the rest and gains a `MirrorCaps` child.
 * `isPaint` says which source materials are body paint. Sets `root.userData.mirrorCaps` when any face moved.
 */
export function splitMirrorCaps(root: THREE.Object3D, box: MirrorCapBox, isPaint: (m: THREE.Material) => boolean): void {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const inside = (p: THREE.Vector3) => Math.abs(p.x) >= x0 && Math.abs(p.x) <= x1 && p.y >= y0 && p.y <= y1 && p.z >= z0 && p.z <= z1;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && isPaint(mesh.material)) meshes.push(mesh);
  });
  const p = new THREE.Vector3();
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    const at = (i: number) => (index ? index.getX(i) : i);
    const toCar = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    // Each vertex tested once.
    const hit = Array.from({ length: pos.count }, (_, k) => inside(p.fromBufferAttribute(pos, k).applyMatrix4(toCar)));
    const caps: number[] = [];
    const rest: number[] = [];
    for (let t = 0; t + 2 < count; t += 3) {
      const i = at(t);
      const j = at(t + 1);
      const k = at(t + 2);
      (hit[i] && hit[j] && hit[k] ? caps : rest).push(i, j, k);
    }
    if (!caps.length) continue;
    const sub = (ids: number[]) => {
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.attributes)) g.setAttribute(name, attr);
      g.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? new Uint32Array(ids) : new Uint16Array(ids), 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      return g;
    };
    mesh.geometry = sub(rest);
    const placeholder = new THREE.MeshBasicMaterial({ name: 'MirrorCaps' });
    placeholder.userData.carMaterial = 'MirrorPaint' satisfies MirrorCapMaterial;
    const part = new THREE.Mesh(sub(caps), placeholder);
    part.name = 'MirrorCaps';
    mesh.add(part);
    root.userData.mirrorCaps = true;
  }
}
