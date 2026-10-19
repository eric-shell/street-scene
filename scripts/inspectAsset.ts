/**
 * Prints the node tree, mesh names, material names, triangle counts and
 * bounding boxes of GLB files. With no arguments it inspects every GLB under
 * assets/converted/ and writes the report to assets/inspect.md.
 *
 *   npx tsx scripts/inspectAsset.ts [file.glb ...]
 */
import { NodeIO, Document, Node, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface NodeInfo {
  name: string;
  depth: number;
  mesh: string | null;
  materials: string[];
  tris: number;
  min: number[] | null;
  max: number[] | null;
}

export interface AssetInfo {
  file: string;
  bytes: number;
  nodes: NodeInfo[];
  materials: string[];
  tris: number;
  min: number[];
  max: number[];
}

export async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

function primTris(p: Primitive): number {
  const idx = p.getIndices();
  const pos = p.getAttribute('POSITION');
  const count = idx ? idx.getCount() : pos ? pos.getCount() : 0;
  return p.getMode() === 4 ? Math.floor(count / 3) : 0;
}

/** World-space bounds of a node's own mesh. */
function nodeBounds(node: Node): { min: number[]; max: number[] } | null {
  const mesh = node.getMesh();
  if (!mesh) return null;
  const m = node.getWorldMatrix();
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
      const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
      const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      const w = [x, y, z];
      for (let k = 0; k < 3; k++) {
        if (w[k] < min[k]) min[k] = w[k];
        if (w[k] > max[k]) max[k] = w[k];
      }
    }
  }
  return min[0] === Infinity ? null : { min, max };
}

export function inspectDocument(doc: Document, file: string, bytes: number): AssetInfo {
  const nodes: NodeInfo[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let total = 0;
  const visit = (n: Node, depth: number) => {
    const mesh = n.getMesh();
    let tris = 0;
    const mats = new Set<string>();
    if (mesh) {
      for (const p of mesh.listPrimitives()) {
        tris += primTris(p);
        const mat = p.getMaterial();
        if (mat) mats.add(mat.getName() || '(unnamed)');
      }
    }
    const b = nodeBounds(n);
    if (b) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.min[k]);
        max[k] = Math.max(max[k], b.max[k]);
      }
    }
    total += tris;
    nodes.push({ name: n.getName(), depth, mesh: mesh ? mesh.getName() : null, materials: [...mats], tris, min: b?.min ?? null, max: b?.max ?? null });
    for (const c of n.listChildren()) visit(c, depth + 1);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, 0);
  return {
    file,
    bytes,
    nodes,
    materials: doc
      .getRoot()
      .listMaterials()
      .map((m) => m.getName()),
    tris: total,
    min,
    max,
  };
}

const f = (n: number) => n.toFixed(3);
const vec = (v: number[] | null) => (v ? `[${v.map(f).join(', ')}]` : '-');

export function formatInfo(info: AssetInfo): string {
  const size = info.max.map((x, i) => x - info.min[i]);
  const lines = [
    `### ${info.file}`,
    '',
    `${(info.bytes / 1024).toFixed(1)} KB, ${info.tris} triangles, bounds min ${vec(info.min)} max ${vec(info.max)} size ${vec(size)}`,
    '',
    `Materials: ${info.materials.map((m) => '`' + m + '`').join(', ') || '(none)'}`,
    '',
    '| Node | Mesh | Materials | Tris | Min | Max |',
    '|---|---|---|---|---|---|',
  ];
  for (const n of info.nodes) {
    lines.push(`| ${'&nbsp;&nbsp;'.repeat(n.depth)}${n.name || '(unnamed)'} | ${n.mesh ?? ''} | ${n.materials.join(', ')} | ${n.tris || ''} | ${vec(n.min)} | ${vec(n.max)} |`);
  }
  return lines.join('\n') + '\n';
}

function findGlbs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...findGlbs(p));
    else if (e.toLowerCase().endsWith('.glb')) out.push(p);
  }
  return out.sort();
}

export async function inspectFiles(files: string[]): Promise<AssetInfo[]> {
  const io = await createIO();
  const infos: AssetInfo[] = [];
  for (const file of files) {
    const doc = await io.read(file);
    infos.push(inspectDocument(doc, relative(process.cwd(), file), statSync(file).size));
  }
  return infos;
}

async function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args : findGlbs('assets/converted');
  if (!files.length) {
    console.log('No GLB files found. Run `npm run assets` first (it converts assets/source/icemaan/*).');
    return;
  }
  const infos = await inspectFiles(files);
  const text = infos.map(formatInfo).join('\n');
  console.log(text);
  if (!args.length) {
    writeFileSync('assets/inspect.raw.md', `# Raw asset inspection\n\nGenerated by \`scripts/inspectAsset.ts\`.\n\n${text}`);
    console.log('Wrote assets/inspect.raw.md');
  }
}

if (process.argv[1] && process.argv[1].endsWith('inspectAsset.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
