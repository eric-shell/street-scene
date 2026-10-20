/**
 * Distant mountain range around the city: two low poly silhouette rings
 * (a hazy far ridge and a darker near one) that follow the camera like a
 * skybox, so they never get closer and never leave the far plane, plus a few
 * antenna towers with blinking red beacons on the highest peaks. Fog is off
 * on these materials; the haze is baked into the vertex colors. Two meshes
 * and one small beacon mesh: cheap enough for phones.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../sim/prng';
import { FOG_COLOR } from './lighting';

export interface Backdrop {
  group: THREE.Group;
  /** Keep the ring centered on the camera (call before rendering). */
  follow(camera: THREE.Camera): void;
  update(time: number): void;
  dispose(): void;
}

const SEGMENTS = 180;

function ridge(rng: Rng, radius: number, base: number, peak: number, rough: number, bottom: THREE.Color, top: THREE.Color): { geo: THREE.BufferGeometry; heights: number[] } {
  // Sum of a few seeded sines around the circle plus jagged noise: a skyline.
  const waves = Array.from({ length: 5 }, (_, i) => ({ k: [2, 3, 5, 9, 17][i] + rng.int(0, 2), a: rng.range(0.4, 1) / (i + 1), p: rng.range(0, Math.PI * 2) }));
  const heights: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    let v = 0;
    for (const w of waves) v += w.a * Math.sin(t * w.k + w.p);
    v = 0.5 + v * 0.35 + (rng.next() - 0.5) * rough;
    heights.push(base + Math.max(0.05, v) * peak);
  }
  const pos: number[] = [];
  const colors: number[] = [];
  const idx: number[] = [];
  const bottomY = -90;
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    const x = Math.cos(t) * radius;
    const z = Math.sin(t) * radius;
    const h = heights[i % SEGMENTS];
    pos.push(x, bottomY, z, x, h, z);
    colors.push(bottom.r, bottom.g, bottom.b, top.r, top.g, top.b);
    if (i < SEGMENTS) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return { geo, heights };
}

export function buildBackdrop(seed: number): Backdrop {
  const rng = new Rng(deriveSeed(seed, 'backdrop'));
  const group = new THREE.Group();
  group.name = 'backdrop';
  const fog = new THREE.Color(FOG_COLOR);
  // Both sides render: the ring is seen from inside.
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide });
  const far = ridge(rng, 1950, 40, 260, 0.08, fog.clone().multiplyScalar(1.1), new THREE.Color(0x2a2448));
  const near = ridge(rng, 1700, 10, 150, 0.14, fog.clone().multiplyScalar(0.7), new THREE.Color(0x15152c));
  const farMesh = new THREE.Mesh(far.geo, mat);
  const nearMesh = new THREE.Mesh(near.geo, mat);
  farMesh.renderOrder = -2;
  nearMesh.renderOrder = -1;
  farMesh.frustumCulled = false;
  nearMesh.frustumCulled = false;
  group.add(farMesh, nearMesh);

  // Antenna towers on the highest near peaks: a thin mast and a beacon.
  const beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.2, 0.15), fog: false });
  const mastMat = new THREE.MeshBasicMaterial({ color: 0x0a0b14, fog: false });
  const peaks = near.heights
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h - a.h)
    .filter((p, k, all) => all.slice(0, k).every((q) => Math.abs(q.i - p.i) > 12))
    .slice(0, 4);
  const mastGeo = new THREE.BoxGeometry(1.6, 34, 1.6);
  const beaconGeo = new THREE.BoxGeometry(5, 5, 5);
  for (const p of peaks) {
    const t = (p.i / SEGMENTS) * Math.PI * 2;
    const x = Math.cos(t) * 1690;
    const z = Math.sin(t) * 1690;
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.set(x, p.h + 17, z);
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    beacon.position.set(x, p.h + 36, z);
    mast.frustumCulled = false;
    beacon.frustumCulled = false;
    group.add(mast, beacon);
  }
  return {
    group,
    follow(camera) {
      group.position.set(camera.position.x, 0, camera.position.z);
    },
    update(time) {
      const on = Math.sin(time * 2.4) > 0.55 ? 1 : 0.08;
      beaconMat.color.setRGB(3 * on, 0.2 * on, 0.15 * on);
    },
    dispose() {
      far.geo.dispose();
      near.geo.dispose();
      mat.dispose();
      beaconMat.dispose();
      mastMat.dispose();
      mastGeo.dispose();
      beaconGeo.dispose();
    },
  };
}
