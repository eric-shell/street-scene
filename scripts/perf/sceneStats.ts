/**
 * Headless scene stats: builds the real night scene (`createNightScene`) for a seed and quality tier in Node and
 * prints triangles, vertices, draw calls and materials per mesh and per group, so every render change has a
 * before/after without a browser. Counts are an upper bound (no frustum culling) but deterministic across machines.
 * Usage: npm run perf:scene -- --seed 20261019 --tier medium [--json out.json] [--baseline file] [--check]
 */
import './shim';
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';

const argv = process.argv.slice(2);
const arg = (name: string, d?: string): string | undefined => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const seed = Number(arg('seed', '20261019'));
const tier = arg('tier', 'medium') as 'low' | 'medium' | 'high';

interface Row { name: string; group: string; perInstance: number; instances: number; tris: number; verts: number; transparent: boolean; additive: boolean }

/** Group of a mesh: props split by mesh name (one instanced mesh per prop kind), crowds stay one group, merged city and district layers are named, anything unnamed falls back to its scene group. */
function groupOf(name: string, top: string): string {
  if (top === 'props') return 'props:' + (name || '(unnamed)');
  if (top === 'crowds') return 'crowds';
  return name || top || '(root)';
}

async function main(): Promise<void> {
  const { createWorld } = await import('../../src/city/world');
  const { createNightScene } = await import('../../src/render/scene');
  const { QUALITY } = await import('../../src/ui/settings');
  const world = createWorld(seed, 'circuit');
  const gr: any = { envMap: null, profile: QUALITY[tier] };
  const settings: any = { quality: tier, flashEffects: true };
  const ns = createNightScene(world, gr, settings);

  const rows: Row[] = [];
  const mats = new Set<THREE.Material>();
  const lights: Record<string, number> = {};
  const visit = (o: THREE.Object3D, top: string): void => {
    const any = o as any;
    if (any.isLight) lights[any.type] = (lights[any.type] ?? 0) + 1;
    if (o.visible === false) return;
    if (any.isMesh || any.isPoints || any.isLine) {
      const g = any.geometry as THREE.BufferGeometry;
      const inst = any.isInstancedMesh ? any.count : (g as any).isInstancedBufferGeometry ? (g as any).instanceCount : 1;
      if (inst > 0) {
        const per = g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
        const ms: THREE.Material[] = Array.isArray(any.material) ? any.material : [any.material];
        ms.forEach((m) => mats.add(m));
        const m = ms[0];
        rows.push({ name: o.name || '(unnamed)', group: groupOf(o.name, top), perInstance: per, instances: inst, tris: per * inst, verts: (g.attributes.position?.count ?? 0) * (any.isInstancedMesh ? inst : 1), transparent: !!m?.transparent, additive: m?.blending === THREE.AdditiveBlending });
      }
    }
    for (const c of o.children) visit(c, top);
  };
  for (const c of ns.scene.children) visit(c, c.name || c.type);

  const groups: Record<string, { tris: number; verts: number; draws: number }> = {};
  for (const r of rows) {
    const g = (groups[r.group] ??= { tris: 0, verts: 0, draws: 0 });
    g.tris += r.tris; g.verts += r.verts; g.draws++;
  }
  const result = {
    seed, tier,
    totals: { tris: sum(rows, 'tris'), verts: sum(rows, 'verts'), drawCalls: rows.length, materials: mats.size, transparent: rows.filter((r) => r.transparent).length, additive: rows.filter((r) => r.additive).length },
    lights,
    groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].tris - a[1].tris).map(([k, v]) => [k, { tris: Math.round(v.tris), verts: Math.round(v.verts), draws: v.draws }])),
    meshes: rows.sort((a, b) => b.tris - a.tris).map((r) => ({ ...r, tris: Math.round(r.tris), perInstance: Math.round(r.perInstance) })),
  };

  console.log(`Scene stats, seed ${seed}, tier ${tier} (upper bound: no frustum culling; counts are deterministic across machines)`);
  console.log(`totals: ${JSON.stringify(result.totals)}  lights: ${JSON.stringify(lights)}`);
  const base = arg('baseline') ? JSON.parse(readFileSync(arg('baseline')!, 'utf8')) : null;
  const table = Object.entries(result.groups).map(([k, v]) => {
    const b = base?.groups?.[k];
    return { group: k, tris: v.tris, verts: v.verts, draws: v.draws, ...(base ? { baseTris: b?.tris ?? 0, delta: b ? pct(v.tris, b.tris) : 'new' } : {}) };
  });
  if (base) for (const [k, b] of Object.entries<any>(base.groups)) if (!(k in result.groups)) table.push({ group: k, tris: 0, verts: 0, draws: 0, baseTris: b.tris, delta: '-100%' } as any);
  console.table(table);
  console.log('top meshes:');
  console.table(result.meshes.slice(0, 15).map((r) => ({ name: r.name, group: r.group, perInst: r.perInstance, inst: r.instances, tris: r.tris, verts: r.verts, transp: r.transparent ? 'T' : '' })));
  if (arg('json')) writeFileSync(arg('json')!, JSON.stringify(result, null, 1));
  if (argv.includes('--check') && base) {
    const bad = Object.entries(result.groups).filter(([k, v]) => v.tris > (base.groups[k]?.tris ?? 0) * 1.05 + (base.groups[k] ? 0 : 1));
    if (bad.length) { console.error('over baseline by more than 5%: ' + bad.map(([k]) => k).join(', ')); process.exit(1); }
  }
  process.exit(0);
}
const sum = (rows: Row[], k: 'tris' | 'verts'): number => Math.round(rows.reduce((a, r) => a + r[k], 0));
const pct = (a: number, b: number): string => (b ? ((a - b) / b * 100).toFixed(1) + '%' : 'new');
main();
