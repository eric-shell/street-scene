/** Small glTF-Transform helpers shared by the asset scripts, and their Blender lookup. */
import { spawnSync } from 'node:child_process';
import { Document, Material, Mesh, Node, Primitive } from '@gltf-transform/core';
import { clearNodeTransform, flatten, prune, transformMesh } from '@gltf-transform/functions';

export type Mat4 = number[];

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major multiply a*b. */
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

export const rotY = (t: number): Mat4 => {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
};
export const scaleM = (s: number): Mat4 => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
export const translate = (x: number, y: number, z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

export function apply(m: Mat4, v: number[]): number[] {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
}

/** Move every mesh node to the scene root and bake all transforms into vertices. */
export async function bakeTransforms(doc: Document): Promise<void> {
  await doc.transform(flatten());
  for (const node of doc.getRoot().listNodes()) if (node.getMesh()) clearNodeTransform(node);
  // Drop transform-only nodes left behind (e.g. FBX "RootNode").
  for (const scene of doc.getRoot().listScenes()) {
    for (const child of scene.listChildren()) {
      if (!child.getMesh() && child.listChildren().length === 0) child.dispose();
    }
  }
  // Keep vertex attributes: the Grille UVs feed a runtime texture the file itself does not carry.
  await doc.transform(prune({ keepAttributes: true }));
}

export function meshNodes(doc: Document): Node[] {
  return doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getMesh());
}

export function transformAll(doc: Document, m: Mat4): void {
  for (const mesh of doc.getRoot().listMeshes()) transformMesh(mesh, m as unknown as Parameters<typeof transformMesh>[1]);
}

/** All vertex positions (world space, assuming baked transforms), optionally filtered by material name. */
export function positions(doc: Document, material?: string): number[][] {
  const out: number[][] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (material && p.getMaterial()?.getName() !== material) continue;
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) out.push(pos.getElement(i, [0, 0, 0]) as number[]);
    }
  }
  return out;
}

export function bounds(pts: number[][]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  return { min, max };
}

export function centroid(pts: number[][]): number[] | null {
  if (!pts.length) return null;
  const c = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k];
  return c.map((x) => x / pts.length);
}

export function triangleCount(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const idx = p.getIndices();
      const count = idx ? idx.getCount() : (p.getAttribute('POSITION')?.getCount() ?? 0);
      if (p.getMode() === Primitive.Mode.TRIANGLES) n += Math.floor(count / 3);
    }
  }
  return n;
}

export function renameMaterials(doc: Document, map: Record<string, string>, known: readonly string[]): string[] {
  const unknown: string[] = [];
  for (const m of doc.getRoot().listMaterials()) {
    const raw = m.getName();
    const base = raw.replace(/\.\d+$/, '');
    const mapped = map[base] ?? known.find((k) => k.toLowerCase() === base.toLowerCase());
    if (mapped) m.setName(mapped);
    else unknown.push(raw);
  }
  return unknown;
}

/** Create a single-node, single-mesh document from scratch (used for procedural placeholder parts). */
export function newDoc(): { doc: Document; buffer: ReturnType<Document['createBuffer']> } {
  const doc = new Document();
  const buffer = doc.createBuffer();
  doc.createScene('Scene');
  return { doc, buffer };
}

export function material(doc: Document, name: string, cache: Map<string, Material>): Material {
  let m = cache.get(name);
  if (!m) {
    m = doc.createMaterial(name).setBaseColorFactor([0.8, 0.8, 0.8, 1]);
    cache.set(name, m);
  }
  return m;
}

export function addNode(doc: Document, name: string, mesh: Mesh): Node {
  const node = doc.createNode(name).setMesh(mesh);
  doc.getRoot().listScenes()[0].addChild(node);
  return node;
}

/** All triangles (world space, baked transforms) as flat [ax,ay,az,bx,by,bz,cx,cy,cz] arrays. */
export function triangles(doc: Document): number[][] {
  const out: number[][] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      const idx = p.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const get = (i: number) => pos.getElement(idx ? idx.getScalar(i) : i, [0, 0, 0]) as number[];
      for (let i = 0; i + 2 < count; i += 3) out.push([...get(i), ...get(i + 1), ...get(i + 2)]);
    }
  }
  return out;
}

/** Lowest surface y hit by a vertical ray at (x, z), or null. */
export function lowestHit(tris: number[][], x: number, z: number): number | null {
  let best: number | null = null;
  for (const t of tris) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = t;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    const y = l1 * ay + l2 * by + l3 * cy;
    if (best === null || y < best) best = y;
  }
  return best;
}

/** The Blender binary for the headless asset scripts: $BLENDER, then PATH, then the usual install places. */
export function findBlender(): string {
  const candidates = [process.env.BLENDER, 'blender', '/Applications/Blender.app/Contents/MacOS/Blender', 'C:/Program Files/Blender Foundation/Blender/blender.exe'].filter(Boolean) as string[];
  const bin = candidates.find((b) => spawnSync(b, ['--version'], { encoding: 'utf8' }).status === 0);
  if (!bin) throw new Error('Blender not found (set BLENDER)');
  return bin;
}
