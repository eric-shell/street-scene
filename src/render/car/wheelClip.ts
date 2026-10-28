/**
 * Keeps the wheels inside their arches. The sim's suspension travel, the stance's lowering and the
 * steering lock move a wheel further than the arch was cut for, so at full compression the tire's
 * crown came up through the fender and at full lock its corners swung out through the arch's ends.
 *
 * Each car measures its body once per part change: over each wheel, a height field of the body
 * surface above every spot (car space, from the ground up). The wheel materials discard any fragment
 * above that surface. Under the fender the field is the outer skin, the highest surface over the spot
 * (fender top, hood): what a tire pokes through. The wheel well's liner below it is interior, so a
 * lowered build's tire is left to pass into it and disappear, as a tucked tire does; cutting at the
 * liner (the lowest surface, as this once did) carved the crown away a few centimetres under the
 * fender and showed the liner, a flat black plane, through the arch in front of the wheel. At the
 * fender's edge the field is the lowest surface instead, the arch lip's underside, and outboard of the
 * body that lip height carries on, so a tire pushed out past the fender (offset, camber, lock) is cut
 * at the fender's line and reads as the wheel tucking under it.
 *
 * Cost: four texel fetches per wheel fragment, no extra pass or draw call; measuring rasterizes the body's
 * triangles into four small grids twice (lowest and highest surface; a few milliseconds, only when the
 * body or its parts change).
 */
import * as THREE from 'three';
import type { ManifestCar } from './carAssets';

const CLIP = {
  /** Grid cells across (x) and along (z) each wheel's field: about 2.5 cm by 2 cm on these cars. */
  nx: 28,
  nz: 40,
  /** How far the field reaches inboard and outboard of the wheel's center (m): the tire's width, the offset slider and the swing of full lock. */
  halfX: 0.35,
  /** How far it reaches ahead of and behind the tire (m), past the radius. */
  padZ: 0.2,
  /** Height stored where no body is over a spot (m): never clips. */
  open: 1e4,
} as const;

const VERT_HEAD = /* glsl */ `
uniform mat4 uWorldToBody;
varying vec3 vArchPos;
`;
const VERT_BODY = /* glsl */ `
vArchPos = (uWorldToBody * modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const FRAG_HEAD = /* glsl */ `
uniform sampler2D uArchMap;
uniform vec4 uArchBox[4];
uniform float uArchMidZ;
varying vec3 vArchPos;
`;
// Which wheel's field by the quadrant of car space (FL, FR, RL, RR: +x is left, +z forward), then the cell under the fragment.
const FRAG_BODY = /* glsl */ `
{
  int wheel = (vArchPos.z > uArchMidZ ? 0 : 2) + (vArchPos.x > 0.0 ? 0 : 1);
  vec4 box = uArchBox[wheel];
  vec2 cell = (vArchPos.xz - box.xy) / box.zw;
  if (cell.x >= 0.0 && cell.y >= 0.0 && cell.x < ${CLIP.nx}.0 && cell.y < ${CLIP.nz}.0) {
    // Bilinear between the cell centers (by hand: float textures need not filter), so the cut is a smooth line, not steps.
    vec2 g = clamp(cell - 0.5, vec2(0.0), vec2(${CLIP.nx - 1}.0, ${CLIP.nz - 1}.0));
    ivec2 c0 = ivec2(min(floor(g), vec2(${CLIP.nx - 2}.0, ${CLIP.nz - 2}.0)));
    vec2 f = g - vec2(c0);
    c0.y += wheel * ${CLIP.nz};
    float h00 = texelFetch(uArchMap, c0, 0).r;
    float h10 = texelFetch(uArchMap, c0 + ivec2(1, 0), 0).r;
    float h01 = texelFetch(uArchMap, c0 + ivec2(0, 1), 0).r;
    float h11 = texelFetch(uArchMap, c0 + ivec2(1, 1), 0).r;
    if (vArchPos.y > mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y)) discard;
  }
}
`;

const TRI = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const TO_CAR = new THREE.Matrix4();
const BODY_INV = new THREE.Matrix4();

export class WheelClip {
  private readonly data = new Float32Array(CLIP.nx * CLIP.nz * 4).fill(CLIP.open);
  /** The highest body surface over each cell (the outer skin), gathered beside the lowest while measuring. */
  private readonly high = new Float32Array(CLIP.nx * CLIP.nz * 4).fill(-CLIP.open);
  private readonly map = new THREE.DataTexture(this.data, CLIP.nx, CLIP.nz * 4, THREE.RedFormat, THREE.FloatType);
  /** Shared by every wheel material of this car; the world to body matrix is set as each wheel mesh draws. */
  private readonly uniforms = {
    uArchMap: { value: this.map },
    uArchBox: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
    uArchMidZ: { value: 0 },
    uWorldToBody: { value: new THREE.Matrix4() },
  };
  /** Per wheel, the height of the ground in car space (m): body surfaces below it are not over the wheel. */
  private readonly floor: number[] = [];
  private readonly beforeRender: () => void;

  constructor(car: ManifestCar, private readonly body: THREE.Object3D) {
    this.map.magFilter = this.map.minFilter = THREE.NearestFilter;
    this.map.needsUpdate = true;
    const keys = ['FL', 'FR', 'RL', 'RR'] as const;
    for (const [i, k] of keys.entries()) {
      const [x, y, z] = car.wheels[k];
      const dx = (2 * CLIP.halfX) / CLIP.nx;
      const halfZ = car.wheelRadius + CLIP.padZ;
      this.uniforms.uArchBox.value[i].set(x - CLIP.halfX, z - halfZ, dx, (2 * halfZ) / CLIP.nz);
      this.floor[i] = y - car.wheelRadius;
    }
    this.uniforms.uArchMidZ.value = (car.wheels.FL[2] + car.wheels.RL[2]) / 2;
    // Body and wheels are posed separately (and the garage lift moves the whole car after update), so the
    // matrix is taken as the wheels draw, when the scene's world matrices are current.
    const toBody = this.uniforms.uWorldToBody.value;
    this.beforeRender = () => {
      toBody.copy(this.body.matrixWorld).invert();
    };
  }

  /**
   * Measure the body: the lowest and the highest surface over each cell of each wheel's field, from the
   * meshes the filter keeps (the opaque body and its parts, in car space: the body group's own frame);
   * settle then picks which one each cell clips against.
   */
  measure(keep: (mesh: THREE.Mesh) => boolean): void {
    const { nx, nz } = CLIP;
    this.data.fill(CLIP.open);
    this.high.fill(-CLIP.open);
    this.body.updateWorldMatrix(true, true);
    BODY_INV.copy(this.body.matrixWorld).invert();
    const boxes = this.uniforms.uArchBox.value;
    this.body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !keep(mesh)) return;
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) return;
      const index = mesh.geometry.getIndex();
      const count = index ? index.count : pos.count;
      TO_CAR.multiplyMatrices(BODY_INV, mesh.matrixWorld);
      for (let t = 0; t + 2 < count; t += 3) {
        for (let k = 0; k < 3; k++) TRI[k].fromBufferAttribute(pos, index ? index.getX(t + k) : t + k).applyMatrix4(TO_CAR);
        const [a, b, c] = TRI;
        // Barycentric weights over the triangle's footprint on the ground; edge on (vertical) triangles have none.
        const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(det) < 1e-10) continue;
        const minX = Math.min(a.x, b.x, c.x);
        const maxX = Math.max(a.x, b.x, c.x);
        const minZ = Math.min(a.z, b.z, c.z);
        const maxZ = Math.max(a.z, b.z, c.z);
        for (let w = 0; w < 4; w++) {
          const box = boxes[w];
          const i0 = Math.max(0, Math.ceil((minX - box.x) / box.z - 0.5));
          const i1 = Math.min(nx - 1, Math.floor((maxX - box.x) / box.z - 0.5));
          const j0 = Math.max(0, Math.ceil((minZ - box.y) / box.w - 0.5));
          const j1 = Math.min(nz - 1, Math.floor((maxZ - box.y) / box.w - 0.5));
          for (let j = j0; j <= j1; j++) {
            const z = box.y + (j + 0.5) * box.w;
            for (let i = i0; i <= i1; i++) {
              const x = box.x + (i + 0.5) * box.z;
              const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
              const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
              const l3 = 1 - l1 - l2;
              if (l1 < 0 || l2 < 0 || l3 < 0) continue;
              const y = l1 * a.y + l2 * b.y + l3 * c.y;
              const cell = (w * nz + j) * nx + i;
              if (y <= this.floor[w]) continue;
              if (y < this.data[cell]) this.data[cell] = y;
              if (y > this.high[cell]) this.high[cell] = y;
            }
          }
        }
      }
    });
    for (let w = 0; w < 4; w++) this.settle(w, boxes[w].x + CLIP.halfX > 0 ? 1 : -1);
    this.map.needsUpdate = true;
  }

  /**
   * Two passes over one wheel's field once the body is in. Along each row, from the inboard side out:
   * under the body the cell clips at the outer skin (the highest surface); the last two cells before the
   * body's edge keep the lowest, the arch lip's underside; outboard of the edge that lip height carries
   * on, so a tire pushed out by the offset, camber or steering lock tucks under the fender's line instead
   * of standing beside it. Then each cell takes the lowest of itself and its neighbours: a cell holds
   * the surface at its center, so on a steep lip half of it sat above the panel and the tire peeked
   * through in steps; the lowest neighbour keeps the cut at or just under the panel.
   */
  private settle(w: number, out: 1 | -1): void {
    const { nx, nz } = CLIP;
    const base = w * nz * nx;
    const d = this.data;
    const h = this.high;
    for (let j = 0; j < nz; j++) {
      const row = base + j * nx;
      const at = (k: number): number => row + (out > 0 ? k : nx - 1 - k);
      let edge = -1;
      for (let k = 0; k < nx; k++) if (d[at(k)] < CLIP.open) edge = k;
      for (let k = 0; k < nx; k++) {
        const cell = at(k);
        if (k < edge - 1) d[cell] = h[cell] > -CLIP.open ? h[cell] : CLIP.open;
        else if (k > edge) d[cell] = edge < 0 ? CLIP.open : d[at(edge)];
      }
    }
    const src = d.slice(base, base + nz * nx);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        let low = src[j * nx + i];
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= nz) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii >= 0 && ii < nx) low = Math.min(low, src[jj * nx + ii]);
          }
        }
        d[base + j * nx + i] = low;
      }
    }
  }

  /** Make a wheel material discard what is above the body (its own material: the body must not take the clip). */
  clipMaterial(mat: THREE.Material): void {
    // After whatever the material already patches in (the tire's tread shader).
    const prior = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prior.call(mat, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
        .replace('#include <clipping_planes_fragment>', `${FRAG_BODY}\n#include <clipping_planes_fragment>`);
    };
    mat.needsUpdate = true;
  }

  /** A wheel mesh drawn with a clipped material: keeps the body's matrix current for it. */
  watch(mesh: THREE.Mesh): void {
    mesh.onBeforeRender = this.beforeRender;
  }

  dispose(): void {
    this.map.dispose();
  }
}
