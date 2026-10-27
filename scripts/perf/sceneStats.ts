/**
 * Headless scene stats: builds the real night scene (`createNightScene`) for a seed and quality tier in Node and
 * prints triangles, vertices, draw calls and materials per mesh and per group, so every render change has a
 * before/after without a browser. Two modes: with no camera the counts are an upper bound (every chunk, cell and impostor level at
 * once, no frustum culling), and `--camera route[:s]` also runs a frame's culling hooks from a route camera and
 * counts only what that frame draws (the chunked layers' groups, compacted instances, shown cells, frustum-culled objects).
 * Both are deterministic across machines (fixed camera, tick and clock). Not countable without a GPU: the crowd impostor bake
 * has no renderer here so its far rig draws as in the upper bound, and the parked cars and the traffic (GLB models fetched at
 * runtime) are absent.
 * Usage: npm run perf:scene -- --seed 20261019 --tier medium [--camera route[:s]] [--json out.json] [--baseline file] [--check]
 */
import './shim';
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';

const argv = process.argv.slice(2);
const arg = (name: string, d?: string): string | undefined => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const seed = Number(arg('seed', '20261019'));
const tier = arg('tier', 'medium') as 'low' | 'medium' | 'high';

/** The camera a frame is drawn from: the game's chase camera lens, parked on the route, and the clock the per-frame hooks see. */
const CAMERA = {
  fov: 62, aspect: 16 / 9, near: 0.1, far: 2200,
  /** Height above the ground (m) and distance behind the route sample (m). */
  up: 3, back: 8,
  /** The aim point: this far ahead (m) along the route and this high (m) above the ground. */
  lookAhead: 30, lookHeight: 1.2,
  /** The route distances (m) `--camera route` samples; each is clamped to the route length. */
  samples: [200, 700, 1200],
  /** Sim tick of the frame (the El's trains and gates), its scene clock (s) and the frame time (s). */
  tick: 600, time: 10, dt: 1 / 60,
  /** The renderer's drawing buffer height (px) the scene's culling hook reads. */
  viewportHeight: 720,
  /** Rows of the heaviest meshes kept in the JSON. */
  keepMeshes: 40,
} as const;

interface Row { name: string; group: string; perInstance: number; instances: number; draws: number; tris: number; verts: number; transparent: boolean; additive: boolean }
interface Totals { tris: number; verts: number; drawCalls: number; materials: number; transparent: number; additive: number }
interface GroupStat { tris: number; verts: number; draws: number }
interface Counted { rows: Row[]; totals: Totals; groups: Record<string, GroupStat>; lights: Record<string, number> }
/** What a camera frame hands the counter: the frustum, and the arguments a BatchedMesh's own culling hook takes. */
interface View { frustum: THREE.Frustum; camera: THREE.Camera; scene: THREE.Scene; renderer: unknown }

/** Group of a mesh: props split by mesh name (one instanced mesh per prop kind), crowds stay one group, merged city and district layers are named, anything unnamed falls back to its scene group. */
function groupOf(name: string, top: string): string {
  if (top === 'props') return 'props:' + (name || '(unnamed)');
  if (top === 'crowds') return 'crowds';
  return name || top || '(root)';
}

/** Walk the scene the way the renderer does: hidden subtrees are skipped; with a view, objects outside the frustum and the groups, instances and batch entries a frame would not draw are left out. */
function count(scene: THREE.Scene, view: View | null): Counted {
  const rows: Row[] = [];
  const mats = new Set<THREE.Material>();
  const lights: Record<string, number> = {};
  const visit = (o: THREE.Object3D, top: string): void => {
    const any = o as any;
    if (any.isLight) lights[any.type] = (lights[any.type] ?? 0) + 1;
    if (o.visible === false) return;
    if ((any.isMesh || any.isPoints || any.isLine) && !(view && o.frustumCulled && !view.frustum.intersectsObject(o))) {
      const row = rowOf(o, top, mats, view);
      if (row) rows.push(row);
    }
    for (const c of o.children) visit(c, top);
  };
  for (const c of scene.children) visit(c, c.name || c.type);

  const groups: Record<string, GroupStat> = {};
  for (const r of rows) {
    const g = (groups[r.group] ??= { tris: 0, verts: 0, draws: 0 });
    g.tris += r.tris; g.verts += r.verts; g.draws += r.draws;
  }
  const totals: Totals = {
    tris: sum(rows, 'tris'), verts: sum(rows, 'verts'), drawCalls: sum(rows, 'draws'), materials: mats.size,
    transparent: rows.filter((r) => r.transparent).length, additive: rows.filter((r) => r.additive).length,
  };
  return { rows, totals, groups, lights };
}

/** One drawable's row, or null when it draws nothing. */
function rowOf(o: THREE.Object3D, top: string, mats: Set<THREE.Material>, view: View | null): Row | null {
  const any = o as any;
  const g = any.geometry as THREE.BufferGeometry;
  const ms: THREE.Material[] = Array.isArray(any.material) ? any.material : [any.material];
  const m = ms[0];
  const make = (draws: number, perInstance: number, instances: number, tris: number, verts: number): Row => {
    ms.forEach((x) => mats.add(x));
    return { name: o.name || '(unnamed)', group: groupOf(o.name, top), perInstance, instances, draws, tris, verts, transparent: !!m?.transparent, additive: m?.blending === THREE.AdditiveBlending };
  };
  const posCount = g.attributes.position?.count ?? 0;
  const total = g.index ? g.index.count : posCount;
  if (any.isBatchedMesh) {
    // The batch culls and sorts its own entries in onBeforeRender; read back what it leaves to draw.
    if (view) any.onBeforeRender(view.renderer, view.scene, view.camera, g, m, null);
    const counts: ArrayLike<number> = any._multiDrawCounts;
    const n: number = view ? any._multiDrawCount : any._instanceInfo.filter((i: any) => i.visible && i.active).length;
    let idx = 0;
    if (view) for (let i = 0; i < n; i++) idx += counts[i];
    else for (const i of any._instanceInfo) if (i.visible && i.active) idx += any._geometryInfo[i.geometryIndex].count;
    return n > 0 ? make(1, idx / 3 / n, n, idx / 3, posCount) : null;
  }
  const inst = any.isInstancedMesh ? any.count : (g as any).isInstancedBufferGeometry ? (g as any).instanceCount : 1;
  if (!(inst > 0)) return null;
  if (view && Array.isArray(any.material)) {
    // A material array draws each of the geometry's groups, clipped to the draw range: how the chunked layers narrow to the visible cells.
    const dr = g.drawRange;
    let drawn = 0;
    let draws = 0;
    for (const grp of g.groups) {
      if (!ms[grp.materialIndex!]) continue;
      const span = Math.min(grp.start + grp.count, dr.start + dr.count, total) - Math.max(grp.start, dr.start);
      if (span > 0) { drawn += span; draws++; }
    }
    if (!draws) return null;
    return make(draws, drawn / 3, inst, drawn / 3 * inst, posCount * (drawn / (total || 1)) * (any.isInstancedMesh ? inst : 1));
  }
  const span = view ? Math.max(0, Math.min(total - g.drawRange.start, g.drawRange.count)) : total;
  const per = span / 3;
  return make(1, per, inst, per * inst, posCount * (any.isInstancedMesh ? inst : 1));
}

/** Pose the camera on the route and run the hooks a frame runs before the renderer draws (session.render, scene.onBeforeRender), then return the view. */
function frame(ns: any, world: any, routeSample: any, s: number): View {
  const rs = routeSample(world.route, s);
  const cam = new THREE.PerspectiveCamera(CAMERA.fov, CAMERA.aspect, CAMERA.near, CAMERA.far);
  const bx = rs.x - rs.tx * CAMERA.back;
  const bz = rs.z - rs.tz * CAMERA.back;
  cam.position.set(bx, world.heightAt(bx, bz) + CAMERA.up, bz);
  const ax = rs.x + rs.tx * CAMERA.lookAhead;
  const az = rs.z + rs.tz * CAMERA.lookAhead;
  cam.lookAt(ax, world.heightAt(ax, az) + CAMERA.lookHeight, az);
  const scene: THREE.Scene = ns.scene;
  const { time, dt } = CAMERA;
  ns.air.chase(null);
  ns.syncDistricts(CAMERA.tick, false);
  ns.update(time);
  ns.city.finishLine.update(time);
  ns.props.update(0, time, undefined, []);
  ns.idlers.update(time, [], cam.position.x, cam.position.z);
  ns.walkers.update(time, [], cam.position.x, cam.position.z);
  ns.crowds.update(time, dt, [], cam.position.x, cam.position.z);
  // The renderer's order: world matrices, then the scene's culling hook, then the frustum test per object.
  scene.updateMatrixWorld();
  cam.updateMatrixWorld();
  const renderer = { domElement: { clientHeight: CAMERA.viewportHeight } };
  (scene as any).onBeforeRender(renderer, scene, cam, null, null, null);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  return { frustum, camera: cam, scene, renderer };
}

/** `--camera` as a route distance list: `route` is the fixed samples, `route:700` one. */
function parseCamera(spec: string): number | null {
  const m = /^route(?::(\d+(?:\.\d+)?))?$/.exec(spec);
  if (!m) { console.error(`unknown --camera ${spec} (use route or route:<metres>)`); process.exit(2); }
  return m[1] === undefined ? null : Number(m[1]);
}

async function main(): Promise<void> {
  const base = arg('baseline') ? JSON.parse(readFileSync(arg('baseline')!, 'utf8')) : null;
  const check = argv.includes('--check') && base;
  // A check compares what the baseline was recorded with: its camera is taken over unless one is named, and a different one is an error.
  const cameraSpec: string | null = arg('camera') ?? (check ? base.camera ?? null : null);
  if (check && (base.camera ?? null) !== cameraSpec) { console.error(`baseline was recorded with camera ${base.camera ?? 'none'}, this run has ${cameraSpec ?? 'none'}`); process.exit(2); }
  if (check && (base.seed !== seed || base.tier !== tier)) { console.error(`baseline is seed ${base.seed} ${base.tier}, this run is seed ${seed} ${tier}`); process.exit(2); }
  const fixed = cameraSpec ? parseCamera(cameraSpec) : null;

  const { createWorld } = await import('../../src/city/world');
  const { routeSample } = await import('../../src/city/route');
  const { createNightScene } = await import('../../src/render/scene');
  const { QUALITY } = await import('../../src/ui/settings');
  const world = createWorld(seed, 'circuit');
  const build = () => {
    const gr: any = { envMap: null, profile: QUALITY[tier] };
    const settings: any = { quality: tier, flashEffects: true };
    return createNightScene(world, gr, settings);
  };

  let ns = build();
  const upper = count(ns.scene, null);
  // One fresh scene per camera, so the culling's hysteresis never carries one sample into the next.
  const samples: { s: number; counted: Counted }[] = [];
  if (cameraSpec) {
    const wanted = fixed === null ? CAMERA.samples : [fixed];
    wanted.forEach((want, i) => {
      if (i > 0) ns = build();
      const s = Math.min(want, world.route.length);
      samples.push({ s, counted: count(ns.scene, frame(ns, world, routeSample, s)) });
    });
  }

  const at = samples.length ? average(samples.map((x) => x.counted)) : upper;
  const worst = samples.length ? samples.reduce((a, b) => (b.counted.totals.tris > a.counted.totals.tris ? b : a)).counted : upper;
  const result = {
    seed, tier,
    camera: cameraSpec,
    totals: at.totals,
    ...(samples.length ? {
      max: { tris: Math.max(...samples.map((x) => x.counted.totals.tris)), verts: Math.max(...samples.map((x) => x.counted.totals.verts)), drawCalls: Math.max(...samples.map((x) => x.counted.totals.drawCalls)) },
      samples: samples.map((x) => ({ s: Math.round(x.s), totals: x.counted.totals })),
      upper: { totals: upper.totals, groups: roundGroups(upper.groups) },
    } : {}),
    lights: at.lights,
    groups: roundGroups(at.groups),
    meshes: worst.rows.sort((a, b) => b.tris - a.tris).map((r) => ({ ...r, tris: Math.round(r.tris), verts: Math.round(r.verts), perInstance: Math.round(r.perInstance) })),
  };

  const label = samples.length ? `at the route camera (${samples.length === 1 ? `s = ${Math.round(samples[0].s)} m` : `mean of s = ${samples.map((x) => Math.round(x.s)).join(', ')} m`})` : 'upper bound: no frustum culling';
  console.log(`Scene stats, seed ${seed}, tier ${tier} (${label}; counts are deterministic across machines)`);
  console.log(`totals: ${JSON.stringify(result.totals)}  lights: ${JSON.stringify(result.lights)}`);
  if (samples.length) {
    console.log(`upper bound (no camera): ${JSON.stringify(upper.totals)}`);
    for (const x of samples) console.log(`  s = ${Math.round(x.s)} m: tris ${x.counted.totals.tris}, draws ${x.counted.totals.drawCalls}, verts ${x.counted.totals.verts}`);
    console.log(`max over samples: ${JSON.stringify((result as any).max)}`);
  }
  const table = Object.entries(result.groups).sort((a, b) => b[1].tris - a[1].tris).map(([k, v]) => {
    const b = base?.groups?.[k];
    return { group: k, tris: v.tris, verts: v.verts, draws: v.draws, ...(samples.length ? { upperTris: upper.groups[k] ? Math.round(upper.groups[k].tris) : 0 } : {}), ...(base ? { baseTris: b?.tris ?? 0, delta: b ? pct(v.tris, b.tris) : 'new' } : {}) };
  });
  if (base) for (const [k, b] of Object.entries<any>(base.groups)) if (!(k in result.groups)) table.push({ group: k, tris: 0, verts: 0, draws: 0, ...(samples.length ? { upperTris: 0 } : {}), baseTris: b.tris, delta: '-100%' } as any);
  console.table(table);
  console.log(samples.length ? `top meshes (worst sample):` : 'top meshes:');
  console.table(result.meshes.slice(0, 15).map((r) => ({ name: r.name, group: r.group, perInst: r.perInstance, inst: r.instances, draws: r.draws, tris: r.tris, verts: r.verts, transp: r.transparent ? 'T' : '' })));
  if (arg('json')) writeFileSync(arg('json')!, JSON.stringify({ ...result, meshes: result.meshes.slice(0, CAMERA.keepMeshes) }, null, 1));
  if (check) {
    const bad = Object.entries(result.groups).filter(([k, v]) => v.tris > (base.groups[k]?.tris ?? 0) * 1.05 + (base.groups[k] ? 0 : 1)).map(([k]) => k);
    // Camera baselines also hold the worst sample's totals: a regression at one camera must not hide in the mean.
    const m = (result as any).max;
    if (m && base.max) for (const k of ['tris', 'drawCalls'] as const) if (m[k] > base.max[k] * 1.05 + 1) bad.push(`max ${k} ${m[k]} > ${base.max[k]}`);
    if (bad.length) { console.error('over baseline by more than 5%: ' + bad.join(', ')); process.exit(1); }
    console.log('within 5% of the baseline');
  }
  process.exit(0);
}

/** Mean of several counts: per group and per total, rounded. */
function average(list: Counted[]): Counted {
  const n = list.length;
  const keys = new Set(list.flatMap((c) => Object.keys(c.groups)));
  const groups: Record<string, GroupStat> = {};
  for (const k of keys) groups[k] = { tris: list.reduce((a, c) => a + (c.groups[k]?.tris ?? 0), 0) / n, verts: list.reduce((a, c) => a + (c.groups[k]?.verts ?? 0), 0) / n, draws: list.reduce((a, c) => a + (c.groups[k]?.draws ?? 0), 0) / n };
  const t = (f: keyof Totals) => Math.round(list.reduce((a, c) => a + c.totals[f], 0) / n);
  const lights: Record<string, number> = {};
  for (const c of list) for (const [k, v] of Object.entries(c.lights)) lights[k] = Math.max(lights[k] ?? 0, v);
  return { rows: [], groups, lights, totals: { tris: t('tris'), verts: t('verts'), drawCalls: t('drawCalls'), materials: t('materials'), transparent: t('transparent'), additive: t('additive') } };
}

const roundGroups = (g: Record<string, GroupStat>): Record<string, GroupStat> =>
  Object.fromEntries(Object.entries(g).sort((a, b) => b[1].tris - a[1].tris).map(([k, v]) => [k, { tris: Math.round(v.tris), verts: Math.round(v.verts), draws: Math.round(v.draws * 10) / 10 }]));
const sum = (rows: Row[], k: 'tris' | 'verts' | 'draws'): number => Math.round(rows.reduce((a, r) => a + r[k], 0));
const pct = (a: number, b: number): string => (b ? ((a - b) / b * 100).toFixed(1) + '%' : 'new');
main();
