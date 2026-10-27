/**
 * Spatial culling inside the city's merged layers. The night city is a handful
 * of giant merged meshes (GeoBuilder: podium trim, district solids, roofs ...),
 * so three.js frustum culling tests whole meshes and every one of their
 * millions of triangles is vertex processed every frame, though the fog hides
 * everything past about 400-630 m and the camera sees a slice of the city.
 *
 * Splitting the layers into per-cell meshes would multiply draw calls, objects
 * and materials. Instead each big layer stays one Mesh: at scene build its index
 * buffer is stable-sorted by the grid cell of each triangle's centroid, so a
 * cell's triangles are one contiguous run, and before each render
 * `geometry.groups` is set to the runs of the visible cells. three.js honours
 * groups only when the material is an array, so a chunked layer gets
 * `material = [mat]`: the same material object, so disposal, fadeSubPixel,
 * uniforms and transparent sorting are unchanged, and no vertex is duplicated or
 * GPU buffer added. Producer modules stay untouched.
 *
 * A cell is drawn when its triangle AABB meets the frustum and its nearest view
 * depth is inside the layer's cutoff: `fog` layers stop where FogExp2 has
 * reached 1 - fogEps, `detail` layers (paint, ties, fire escapes) at the
 * quality's detailDistance, `sky` layers (the skyline) only by the frustum. The cutoff is view depth, not radial distance,
 * because FogExp2 fogs by -mvPosition.z. Runs separated by fewer than gapTris
 * triangles merge, trading a few hidden triangles for a draw call.
 *
 * The instanced street props cull on the same grid (street/props.ts: cellsWithin,
 * fogCutoff), compacting each kind's drawn cells to the front of its buffers.
 */
import * as THREE from 'three';

export const CHUNKS = {
  /** Grid cell size (m). */
  cell: 200,
  /** Fog factor left (1 - fog) at which a fogged layer is cut off. */
  fogEps: 1 / 1024,
  /** Layers smaller than this (triangles) are not worth sorting. */
  minTris: 20_000,
  /** Hidden runs shorter than this (triangles) are drawn through rather than split into another draw call. */
  gapTris: 4_000,
  /** AABB pad (m) for vertex shader motion (tree sway) and float slack. */
  pad: 0.5,
} as const;

/**
 * How a layer is cut off in depth: where the fog closes, at the quality's detail
 * distance, or not at all (`sky`: frustum only). A fully fogged building is still
 * a fog-coloured silhouette against a sky that is not the fog colour, so the
 * layers that make the skyline (building shells, roofs) never cull by depth.
 */
export type ChunkClass = 'fog' | 'detail' | 'sky';

/** A square grid over the city, row major (cell = iz * nx + ix). */
export interface ChunkGrid {
  minX: number;
  minZ: number;
  /** Cell size (m). */
  cell: number;
  nx: number;
  nz: number;
  /** nx * nz. */
  count: number;
  /** The cell holding (x, z) (m); points outside the bounds go to the edge cells. */
  cellOf(x: number, z: number): number;
  /**
   * Mark in `out` (length count, cleared first) every cell whose ground rect lies within
   * r (m) of (x, z), or of the square of half size pad (m) centred there, edge cells
   * reaching out to infinity like cellOf. A negative r marks nothing. Allocates nothing.
   */
  cellsWithin(x: number, z: number, r: number, out: Uint8Array, pad?: number): void;
}

/** View depth (m) at which FogExp2 of this density has reached 1 - CHUNKS.fogEps (Infinity without fog). */
export function fogCutoff(density: number): number {
  return density > 0 ? Math.sqrt(Math.log(1 / CHUNKS.fogEps)) / density : Infinity;
}

export function chunkGrid(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }, cell: number = CHUNKS.cell): ChunkGrid {
  const nx = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const nz = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
  const minX = bounds.minX;
  const minZ = bounds.minZ;
  return {
    minX,
    minZ,
    cell,
    nx,
    nz,
    count: nx * nz,
    cellOf(x, z) {
      const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cell)));
      const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / cell)));
      return iz * nx + ix;
    },
    cellsWithin(x, z, r, out, pad = 0) {
      out.fill(0);
      if (!(r >= 0)) return;
      const ix0 = Math.min(nx - 1, Math.max(0, Math.floor((x - r - pad - minX) / cell)));
      const ix1 = Math.min(nx - 1, Math.max(0, Math.floor((x + r + pad - minX) / cell)));
      const iz0 = Math.min(nz - 1, Math.max(0, Math.floor((z - r - pad - minZ) / cell)));
      const iz1 = Math.min(nz - 1, Math.max(0, Math.floor((z + r + pad - minZ) / cell)));
      const r2 = r * r;
      for (let iz = iz0; iz <= iz1; iz++) {
        const lo = iz === 0 ? -Infinity : minZ + iz * cell;
        const hi = iz === nz - 1 ? Infinity : minZ + (iz + 1) * cell;
        const dz = Math.max(lo - pad - z, 0, z - pad - hi);
        for (let ix = ix0; ix <= ix1; ix++) {
          const l = ix === 0 ? -Infinity : minX + ix * cell;
          const h = ix === nx - 1 ? Infinity : minX + (ix + 1) * cell;
          const dx = Math.max(l - pad - x, 0, x - pad - h);
          if (dx * dx + dz * dz <= r2) out[iz * nx + ix] = 1;
        }
      }
    },
  };
}

interface Layer {
  mesh: THREE.Mesh;
  cls: ChunkClass;
  /** First index (into the index buffer) of each cell's run. */
  start: Uint32Array;
  /** Index count of each cell's run. */
  count: Uint32Array;
  /** Per-cell AABB: minX, minY, minZ, maxX, maxY, maxZ (m, world). */
  box: Float32Array;
  /** Pooled group objects, one per cell at most (the worst case of runs). */
  pool: { start: number; count: number; materialIndex: number }[];
  /** The whole layer as one group (culling off). */
  full: { start: number; count: number; materialIndex: number };
}

/** Grow the AABB at box[o..o+6] by the vertex at wp[v..v+3]. */
function grow(box: Float32Array, o: number, wp: Float32Array, v: number): void {
  const x = wp[v];
  const y = wp[v + 1];
  const z = wp[v + 2];
  if (x < box[o]) box[o] = x;
  if (y < box[o + 1]) box[o + 1] = y;
  if (z < box[o + 2]) box[o + 2] = z;
  if (x > box[o + 3]) box[o + 3] = x;
  if (y > box[o + 4]) box[o + 4] = y;
  if (z > box[o + 5]) box[o + 5] = z;
}

const IDENTITY = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _box = new THREE.Box3();
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export class CityChunks {
  /** False draws every layer whole (dev: `?cull=off`, or `window.__nr.session.night.chunks.enabled`). */
  enabled = true;
  /** Time spent sorting the layers at build (ms, wall clock; dev stat only). */
  buildMs = 0;
  readonly layers: Layer[] = [];
  /** Cells drawn by the last view() for fog and detail layers (1 = visible; sky layers mark neither). */
  readonly visibleFog: Uint8Array;
  readonly visibleDetail: Uint8Array;

  constructor(readonly grid: ChunkGrid) {
    this.visibleFog = new Uint8Array(grid.count);
    this.visibleDetail = new Uint8Array(grid.count);
  }

  /** The layer's one material, whether or not add() has wrapped it in an array. */
  static material(mesh: THREE.Mesh): THREE.Material {
    return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  }

  /** Register every mesh under root whose name has a class. */
  addByName(root: THREE.Object3D, classes: Record<string, ChunkClass>): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const cls = classes[o.name];
      if (cls && mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) this.add(mesh, cls);
    });
  }

  /** Sort one layer's triangles by cell and take over its groups. Skips small, non-indexed, grouped or multi-material meshes. */
  add(mesh: THREE.Mesh, cls: ChunkClass): void {
    const g = mesh.geometry;
    const index = g.index;
    if (!index || mesh.userData.chunked || Array.isArray(mesh.material) || g.groups.length) return;
    const tris = Math.floor(index.count / 3);
    if (tris < CHUNKS.minTris || g.drawRange.start !== 0 || g.drawRange.count < index.count) return;
    const t0 = performance.now();
    const grid = this.grid;
    const n = grid.count;
    const idx = index.array as Uint16Array | Uint32Array;
    const posAttr = g.attributes.position;
    mesh.updateWorldMatrix(true, false);
    const e = mesh.matrixWorld.elements;
    // World positions, read straight from the attribute when the layer sits at identity (they all do today).
    const vc = posAttr.count;
    const plain = !(posAttr as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && posAttr.itemSize === 3 && posAttr.array instanceof Float32Array;
    const wp = plain && mesh.matrixWorld.equals(IDENTITY) ? (posAttr.array as Float32Array) : new Float32Array(vc * 3);
    if (wp !== posAttr.array) for (let v = 0; v < vc; v++) {
      const x = posAttr.getX(v);
      const y = posAttr.getY(v);
      const z = posAttr.getZ(v);
      wp[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      wp[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      wp[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    // Counting sort by centroid cell, stable within a cell, written back into the same index array.
    const triCell = new Uint16Array(tris);
    const count = new Uint32Array(n);
    const box = new Float32Array(n * 6);
    for (let c = 0; c < n; c++) {
      box[c * 6] = box[c * 6 + 1] = box[c * 6 + 2] = Infinity;
      box[c * 6 + 3] = box[c * 6 + 4] = box[c * 6 + 5] = -Infinity;
    }
    for (let t = 0; t < tris; t++) {
      const a = idx[t * 3] * 3;
      const b = idx[t * 3 + 1] * 3;
      const d = idx[t * 3 + 2] * 3;
      const c = grid.cellOf((wp[a] + wp[b] + wp[d]) / 3, (wp[a + 2] + wp[b + 2] + wp[d + 2]) / 3);
      triCell[t] = c;
      count[c] += 3;
      grow(box, c * 6, wp, a);
      grow(box, c * 6, wp, b);
      grow(box, c * 6, wp, d);
    }
    const start = new Uint32Array(n);
    for (let c = 1; c < n; c++) start[c] = start[c - 1] + count[c - 1];
    const cursor = start.slice();
    const src = idx.slice(0, tris * 3);
    for (let t = 0; t < tris; t++) {
      const at = cursor[triCell[t]];
      cursor[triCell[t]] += 3;
      idx[at] = src[t * 3];
      idx[at + 1] = src[t * 3 + 1];
      idx[at + 2] = src[t * 3 + 2];
    }
    index.needsUpdate = true;
    for (let i = 0; i < n * 6; i++) box[i] += i % 6 < 3 ? -CHUNKS.pad : CHUNKS.pad;
    mesh.material = [mesh.material];
    mesh.userData.chunked = true;
    const full = { start: 0, count: index.count, materialIndex: 0 };
    g.groups.length = 0;
    g.groups.push(full);
    this.layers.push({ mesh, cls, start, count, box, pool: Array.from({ length: n }, () => ({ start: 0, count: 0, materialIndex: 0 })), full });
    this.buildMs += performance.now() - t0;
  }

  /**
   * Point every layer's groups at the cells this camera can see. Call once per
   * render (scene.onBeforeRender), after the camera's matrices are current.
   * `fogDensity` is the scene's FogExp2 density, `detailDistance` the quality's
   * cutoff for detail layers (m). Allocates nothing.
   */
  view(camera: THREE.Camera, fogDensity: number, detailDistance: number): void {
    if (!this.enabled) {
      for (const l of this.layers) {
        const groups = l.mesh.geometry.groups;
        groups.length = 1;
        groups[0] = l.full;
      }
      return;
    }
    _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m, camera.coordinateSystem);
    camera.getWorldPosition(_pos);
    camera.getWorldDirection(_fwd);
    const fogCut = fogCutoff(fogDensity);
    const n = this.grid.count;
    const fx = Math.abs(_fwd.x);
    const fy = Math.abs(_fwd.y);
    const fz = Math.abs(_fwd.z);
    // Cell visibility is per layer (each has its own AABBs), so the bitsets hold the union for callers.
    this.visibleFog.fill(0);
    this.visibleDetail.fill(0);
    for (const l of this.layers) {
      const cut = l.cls === 'fog' ? fogCut : l.cls === 'detail' ? detailDistance : Infinity;
      const bits = l.cls === 'fog' ? this.visibleFog : l.cls === 'detail' ? this.visibleDetail : null;
      const groups = l.mesh.geometry.groups;
      const gap = CHUNKS.gapTris * 3;
      let runs = 0;
      let runStart = 0;
      let runEnd = -1;
      for (let c = 0; c < n; c++) {
        const cnt = l.count[c];
        if (!cnt) continue;
        const b = l.box;
        const o = c * 6;
        const ex = (b[o + 3] - b[o]) / 2;
        const ey = (b[o + 4] - b[o + 1]) / 2;
        const ez = (b[o + 5] - b[o + 2]) / 2;
        const minDepth = (b[o] + ex - _pos.x) * _fwd.x + (b[o + 1] + ey - _pos.y) * _fwd.y + (b[o + 2] + ez - _pos.z) * _fwd.z - (ex * fx + ey * fy + ez * fz);
        if (minDepth > cut) continue;
        _box.min.set(b[o], b[o + 1], b[o + 2]);
        _box.max.set(b[o + 3], b[o + 4], b[o + 5]);
        if (!_frustum.intersectsBox(_box)) continue;
        if (bits) bits[c] = 1;
        const s = l.start[c];
        if (runEnd >= 0 && s - runEnd < gap) runEnd = s + cnt;
        else {
          if (runEnd >= 0) runs = this.emit(l, groups, runs, runStart, runEnd);
          runStart = s;
          runEnd = s + cnt;
        }
      }
      if (runEnd >= 0) runs = this.emit(l, groups, runs, runStart, runEnd);
      groups.length = runs;
    }
  }

  private emit(l: Layer, groups: THREE.BufferGeometry['groups'], i: number, start: number, end: number): number {
    const gr = l.pool[i];
    gr.start = start;
    gr.count = end - start;
    gr.materialIndex = 0;
    groups[i] = gr;
    return i + 1;
  }
}
