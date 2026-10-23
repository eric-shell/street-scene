/**
 * Geometry out of a Meshopt compressed glTF, ready to batch or instance:
 * Meshopt quantizes positions and normals into small integers and puts the
 * dequantizing scale on the node, so a mesh taken out of its node must have
 * that transform baked in, and integer attributes cannot hold the result.
 * Shared by the traffic (render/traffic/traffic.ts) and the roadworks plant
 * (render/districts/roadworks.ts).
 */
import * as THREE from 'three';

/** Attributes copied, with their sizes; any the source lacks are left out (the plant has color, no uv). */
const ATTRIBUTES = [
  ['position', 3],
  ['normal', 3],
  ['uv', 2],
  ['color', 3],
] as const;

/** A copy of a (possibly quantized) glTF geometry with float attributes, transformed by `m`. */
export function floatGeometry(src: THREE.BufferGeometry, m: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of ATTRIBUTES) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      out[i * size] = a.getX(i);
      out[i * size + 1] = a.getY(i);
      if (size === 3) out[i * size + 2] = a.getZ(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  const idx = src.getIndex();
  g.setIndex(idx ? Array.from(idx.array as ArrayLike<number>) : [...Array(src.getAttribute('position').count).keys()]);
  g.applyMatrix4(m);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
