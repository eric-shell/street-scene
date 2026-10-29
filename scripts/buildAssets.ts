/**
 * Asset pipeline: `npm run assets`
 *
 *  1. Authored cars: export every assets/source/eshell/<carId>/<carId>.blend
 *     with scripts/blender/exportCar.py (Blender in background mode). These
 *     are modelled in car space at the shared scale, so they are only
 *     optimized and cataloged, never measured or rescaled.
 *  2. Convert every FBX under assets/source/icemaan/<folder>/ to GLB
 *     (Blender in background mode if available, otherwise FBX2glTF).
 *  3. Normalize each FBX car to car space: meters, Y up, origin on the ground
 *     midway between the axles, facing +Z. Axles are found from the wheel
 *     arches in the body mesh; the front from the headlight material.
 *  4. Rename source materials to the shared vocabulary.
 *  5. Write cars to public/cars/ and parts (body kits, bumpers, skirts,
 *     spoilers, wheels) to public/parts/, optimized with glTF Transform
 *     (dedup, weld, Meshopt).
 *  6. Update src/assets/carManifest.json and src/assets/partsCatalog.json,
 *     write assets/inspect.md, then run parts validation (fails loudly).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Document, PropertyType } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { cloneDocument, dedup, meshopt, prune, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { MATERIAL_NAMES, PartEntry, PartsCatalog, WHEEL_CONSTRUCTIONS, WheelConstruction, WheelLugs, partFileName } from '../src/shared/parts';

const isConstruction = (c: string | undefined): c is WheelConstruction => (WHEEL_CONSTRUCTIONS as readonly string[]).includes(c ?? '');

/** A wheel's lug circle as the Blender export carries it: an object whose numbers are all finite and whose count is at least 1. */
const validLugs = (l: WheelLugs | null | undefined): l is WheelLugs => !!l && typeof l === 'object' && l.count >= 1 && [l.count, l.r, l.phase, l.x, l.size].every((n) => Number.isFinite(n));
import { createIO, formatInfo, inspectDocument } from './inspectAsset';
import { apply, bakeTransforms, triangles, lowestHit, bounds, centroid, mul, positions, renameMaterials, rotY, scaleM, transformAll, translate, triangleCount, Mat4 } from './gltfUtil';
import { validateCatalog } from './validateParts';

const ROOT = process.cwd();
const SRC = join(ROOT, 'assets/source/icemaan');
const AUTHORED = join(ROOT, 'assets/source/eshell');
/** The folder of the shared wheel set under AUTHORED. */
const WHEEL_SET = 'wheels';
const CONVERTED = join(ROOT, 'assets/converted');
const PUBLIC = join(ROOT, 'public');
const MANIFEST_PATH = join(ROOT, 'src/assets/carManifest.json');
const CATALOG_PATH = join(ROOT, 'src/assets/partsCatalog.json');
const config = JSON.parse(readFileSync(join(ROOT, 'scripts/assetConfig.json'), 'utf8')) as {
  cars: Record<string, { folders: string[]; targetLength: number; spoilerOffset: number[]; wheelOffset: number[] }>;
  standardWheel: { radius: number; width: number };
  materialMap: Record<string, string>;
};

const report: string[] = [];
const log = (s: string) => {
  console.log(s);
};

// ---------------------------------------------------------------------------
// 1. Conversion
// ---------------------------------------------------------------------------

type Converter = { kind: 'blender' | 'fbx2gltf'; bin: string } | null;

function findBlender(): string | null {
  const candidates = [process.env.BLENDER, 'blender', '/Applications/Blender.app/Contents/MacOS/Blender', 'C:/Program Files/Blender Foundation/Blender/blender.exe'].filter(Boolean) as string[];
  return candidates.find((b) => spawnSync(b, ['--version'], { encoding: 'utf8' }).status === 0) ?? null;
}

function findConverter(): Converter {
  const blender = findBlender();
  if (blender) return { kind: 'blender', bin: blender };
  const platform = process.platform === 'darwin' ? 'Darwin' : process.platform === 'win32' ? 'Windows_NT' : 'Linux';
  const fbx = join(ROOT, 'node_modules/fbx2gltf/bin', platform, platform === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF');
  if (existsSync(fbx)) return { kind: 'fbx2gltf', bin: fbx };
  return null;
}

function listFbx(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listFbx(p));
    else if (e.toLowerCase().endsWith('.fbx')) out.push(p);
  }
  return out.sort();
}

function convert(conv: NonNullable<Converter>, fbx: string, outGlb: string): void {
  if (existsSync(outGlb) && statSync(outGlb).mtimeMs > statSync(fbx).mtimeMs) return;
  mkdirSync(dirname(outGlb), { recursive: true });
  if (conv.kind === 'blender') {
    execFileSync(conv.bin, ['--background', '--factory-startup', '--python', join(ROOT, 'scripts/blender/fbxToGlb.py'), '--', fbx, outGlb], { stdio: 'pipe' });
  } else {
    execFileSync(conv.bin, ['--binary', '--input', fbx, '--output', outGlb.replace(/\.glb$/, '')], { stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// 2. Classification and normalization
// ---------------------------------------------------------------------------

type Kind = { type: 'body'; index: number } | { type: 'spoiler'; index: number } | { type: 'wheel'; index: number; side: 'L' | 'R' } | { type: 'unknown' };

function classify(file: string): Kind {
  const name = basename(file, '.fbx');
  const lower = file.toLowerCase();
  const num = (s: string) => {
    const m = s.match(/_(\d+)(?:_[LR])?$/i);
    return m ? Number(m[1]) : 0;
  };
  if (/rim|wheel/.test(lower)) {
    const side = /_R$/i.test(name) ? 'R' : 'L';
    return { type: 'wheel', index: num(name), side };
  }
  if (/spoiler|wing/.test(lower)) return { type: 'spoiler', index: num(name) };
  if (/body|kit/.test(lower)) return { type: 'body', index: num(name) || 1 };
  return { type: 'unknown' };
}

interface CarFrame {
  /** Raw (converted) to car space. */
  matrix: Mat4;
  /** Rotation and scale only (for wheels). */
  scale: number;
  wheelRadius: number;
  wheelWidth: number;
  wheels: Record<'FL' | 'FR' | 'RL' | 'RR', number[]>;
  dims: { length: number; width: number; height: number };
  notes: string[];
}

/**
 * Find wheel arches along Z in a body that already faces +Z. Casts vertical
 * rays up through the body near both sides; under an arch the first surface
 * hit is high (the fender), elsewhere it is the low sill or bumper.
 */
function findArches(tris: number[][], pts: number[][], halfW: number): { z: number; top: number; half: number }[] {
  const b = bounds(pts);
  const cx = (b.max[0] + b.min[0]) / 2;
  const bin = 0.02;
  const n = Math.ceil((b.max[2] - b.min[2]) / bin) + 1;
  const profile: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const z = b.min[2] + (i + 0.5) * bin;
    const ys: number[] = [];
    for (const f of [0.78, 0.86]) {
      for (const side of [1, -1]) {
        const y = lowestHit(tris, cx + side * halfW * f, z);
        if (y !== null) ys.push(y);
      }
    }
    profile.push(ys.length ? ys.reduce((a, c) => a + c, 0) / ys.length : null);
  }
  const filled = profile.filter((v): v is number => v !== null).sort((a, c) => a - c);
  const sill = filled[Math.floor(filled.length * 0.2)] ?? b.min[1];
  const height = b.max[1] - b.min[1];
  const thresh = sill + height * 0.12;
  const runs: { from: number; to: number }[] = [];
  let start = -1;
  let gap = 0;
  for (let i = 0; i < n; i++) {
    const v = profile[i];
    const high = v === null || v > thresh;
    // Ignore the very ends (bumper overhang with no surface below).
    const inside = i > n * 0.05 && i < n * 0.95;
    if (high && inside) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0) {
      if (++gap > 2) {
        runs.push({ from: start, to: i - gap });
        start = -1;
        gap = 0;
      }
    }
  }
  if (start >= 0) runs.push({ from: start, to: n - 1 });
  return runs
    .filter((r) => (r.to - r.from) * bin > 0.3 && (r.to - r.from) * bin < 1.4)
    .map((r) => {
      let top = -Infinity;
      for (let i = r.from; i <= r.to; i++) {
        const v = profile[i];
        if (v !== null) top = Math.max(top, v);
      }
      return { z: b.min[2] + ((r.from + r.to) / 2 + 0.5) * bin, top: Number.isFinite(top) ? top : sill + height * 0.5, half: ((r.to - r.from) * bin) / 2 };
    });
}

function computeFrame(carId: string, body: Document, wheelRaw: { radius: number; width: number }): CarFrame {
  const cfg = config.cars[carId];
  const notes: string[] = [];
  const all = positions(body);
  const rb = bounds(all);
  const extX = rb.max[0] - rb.min[0];
  const extZ = rb.max[2] - rb.min[2];
  const head = centroid(positions(body, 'HeadLight'));
  const tail = centroid(positions(body, 'TailLight'));
  // Forward direction from tail lights to head lights along the long axis.
  let angle = 0;
  if (extX > extZ) {
    const dir = head && tail ? Math.sign(head[0] - tail[0]) : 1;
    angle = dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    notes.push(`Long axis is X; front faces ${dir > 0 ? '+X' : '-X'} (from headlight vs taillight material centroids). Rotated ${dir > 0 ? '-90' : '+90'} degrees about Y.`);
  } else {
    const dir = head && tail ? Math.sign(head[2] - tail[2]) : 1;
    angle = dir > 0 ? 0 : Math.PI;
    notes.push(`Long axis is Z; front faces ${dir > 0 ? '+Z' : '-Z'}.`);
  }
  if (!head || !tail) notes.push('WARNING: no HeadLight/TailLight material found; assumed front direction.');
  const length = Math.max(extX, extZ);
  const scale = cfg.targetLength / length;
  notes.push(`Scale ${scale.toFixed(4)} (raw length ${length.toFixed(3)} m -> ${cfg.targetLength} m).`);
  const rs = mul(scaleM(scale), rotY(angle));
  const pts = all.map((p) => apply(rs, p));
  const b = bounds(pts);
  const halfW = (b.max[0] - b.min[0]) / 2;
  const cx = (b.max[0] + b.min[0]) / 2;
  const tris = triangles(body).map((t) => [...apply(rs, t.slice(0, 3)), ...apply(rs, t.slice(3, 6)), ...apply(rs, t.slice(6, 9))]);
  const arches = findArches(tris, pts, halfW);
  const mid = (b.max[2] + b.min[2]) / 2;
  // The arches closest to each end in each half are the wheel wells.
  const front = arches.filter((a) => a.z > mid).sort((a, c) => c.half - a.half)[0];
  const rear = arches.filter((a) => a.z < mid).sort((a, c) => c.half - a.half)[0];
  if (process.env.DEBUG_ARCHES) console.log(carId, arches);
  // Never let the wheel be larger than the arch opening.
  const archHalf = front && rear ? (front.half + rear.half) / 2 : Infinity;
  const wheelRadius = Math.min(wheelRaw.radius * scale, archHalf * 1.0);
  const wheelWidth = wheelRaw.width * scale;
  let zf: number;
  let zr: number;
  let centerY: number;
  if (front && rear) {
    zf = front.z;
    zr = rear.z;
    const top = (front.top + rear.top) / 2;
    centerY = top - wheelRadius * 1.08;
    notes.push(`Wheel arches found at z=${front.z.toFixed(3)} and z=${rear.z.toFixed(3)} (arch tops ${front.top.toFixed(3)} / ${rear.top.toFixed(3)}).`);
  } else {
    // Fallback: typical proportions.
    const L = b.max[2] - b.min[2];
    zf = b.min[2] + L * 0.8;
    zr = b.min[2] + L * 0.2;
    centerY = b.min[1] + wheelRadius * 0.55;
    notes.push('WARNING: wheel arches not detected; used 20%/80% of length. Set wheelOffset in scripts/assetConfig.json if wheels look wrong.');
  }
  const groundY = centerY - wheelRadius;
  const originZ = (zf + zr) / 2;
  const off = cfg.wheelOffset ?? [0, 0, 0];
  const m = mul(translate(-cx, -groundY, -originZ), rs);
  // Track: wheels sit just inside the body sides near the arches.
  const nearArch = pts.filter((p) => Math.abs(p[2] - zf) < 0.3 || Math.abs(p[2] - zr) < 0.3);
  const halfAtArch = nearArch.length ? Math.max(...nearArch.map((p) => Math.abs(p[0] - cx))) : halfW;
  const wx = halfAtArch - wheelWidth * 0.55 + off[0];
  const wy = wheelRadius + off[1];
  const wz = (zf - zr) / 2 + off[2];
  const finalB = bounds(pts.map((p) => [p[0] - cx, p[1] - groundY, p[2] - originZ]));
  return {
    matrix: m,
    scale,
    wheelRadius,
    wheelWidth,
    wheels: { FL: [wx, wy, wz], FR: [-wx, wy, wz], RL: [wx, wy, -wz], RR: [-wx, wy, -wz] },
    dims: { length: finalB.max[2] - finalB.min[2], width: finalB.max[0] - finalB.min[0], height: finalB.max[1] - finalB.min[1] },
    notes,
  };
}

function round(v: number, d = 3): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** Put a converted wheel in wheel space: center at origin, axle along X, outer face +X. */
function wheelToWheelSpace(doc: Document, scale: number): void {
  const pts = positions(doc);
  const b = bounds(pts);
  const ext = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  const axle = ext.indexOf(Math.min(...ext));
  const c = [0, 1, 2].map((k) => (b.max[k] + b.min[k]) / 2);
  let m = translate(-c[0], -c[1], -c[2]);
  // Outer face: the Rim material sits toward the outside of the wheel.
  const face = centroid(positions(doc, 'Rim')) ?? c;
  const outerSign = Math.sign(face[axle] - c[axle]) || 1;
  if (axle === 2) m = mul(rotY(outerSign > 0 ? Math.PI / 2 : -Math.PI / 2), m);
  else if (axle === 0 && outerSign < 0) m = mul(rotY(Math.PI), m);
  else if (axle === 1) throw new Error('wheel axle along Y is not supported');
  transformAll(doc, mul(scaleM(scale), m));
}

/** Place a spoiler on the rear deck of a normalized body. */
function placeSpoiler(spoiler: Document, body: Document, extra: number[]): string {
  const bp = positions(body);
  const bb = bounds(bp);
  const halfW = (bb.max[0] - bb.min[0]) / 2;
  const rearZ = bb.min[2];
  const deck = bp.filter((p) => p[2] > rearZ + 0.04 && p[2] < rearZ + 0.4 && Math.abs(p[0]) < halfW * 0.4);
  const deckY = deck.length ? Math.max(...deck.map((p) => p[1])) : bb.max[1] * 0.75;
  const sb = bounds(positions(spoiler));
  const dx = -(sb.max[0] + sb.min[0]) / 2 + (extra[0] ?? 0);
  const dy = deckY - sb.min[1] - 0.01 + (extra[1] ?? 0);
  const dz = rearZ + 0.05 - sb.min[2] + (extra[2] ?? 0);
  transformAll(spoiler, translate(dx, dy, dz));
  return `deck height ${deckY.toFixed(3)} m, offset [${[dx, dy, dz].map((v) => v.toFixed(3)).join(', ')}]`;
}

// ---------------------------------------------------------------------------
// 4. Optimize and write
// ---------------------------------------------------------------------------

async function writeOptimized(io: Awaited<ReturnType<typeof createIO>>, doc: Document, outPath: string, nodeName?: string): Promise<{ bytes: number; tris: number }> {
  if (nodeName) {
    const nodes = doc.getRoot().listNodes().filter((n) => n.getMesh());
    if (nodes.length === 1) nodes[0].setName(nodeName);
  }
  // UVs only where the game textures a surface: the Grille pattern is a runtime texture
  // (src/render/car/carMaterials.ts), so prune would drop its coordinates as unused; every other
  // material is flat colored and its UVs are only bytes.
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMaterial()?.getName() === 'Grille') continue;
      for (const sem of prim.listSemantics()) if (sem.startsWith('TEXCOORD_')) prim.setAttribute(sem, null);
    }
  }
  // Materials are not deduplicated: identical looking materials can carry different shared names.
  await doc.transform(dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }), weld(), prune({ keepAttributes: true }));
  await MeshoptEncoder.ready;
  doc.createExtension(EXTMeshoptCompression);
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  mkdirSync(dirname(outPath), { recursive: true });
  await io.write(outPath, doc);
  return { bytes: statSync(outPath).size, tris: triangleCount(doc) };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface ManifestCar {
  id: string;
  displayName: string;
  source: string;
  provisional: boolean;
  file: string;
  baseBodyNode: string;
  wheelNodes: string[];
  wheelRadius: number;
  wheelWidth: number;
  wheels: Record<string, number[]>;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  dimensions: { length: number; width: number; height: number };
  materialMap: Record<string, string>;
  defaultWheel: string;
  defaultPaint: string;
}

async function main(): Promise<void> {
  const io = await createIO();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { version: number; notes: string; cars: ManifestCar[] };
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as PartsCatalog;
  const generated: PartEntry[] = [];
  const handAuthored = catalog.parts.filter((p) => !(p as PartEntry & { generated?: boolean }).generated);
  const inspectSections: string[] = [];
  const splitNeeded: string[] = [];
  const sizeReport: string[] = [];

  // ----- Authored cars (assets/source/eshell) -----
  // `wheels/wheels.blend` is the shared wheel set, not a car (below).
  const authored = existsSync(AUTHORED) ? readdirSync(AUTHORED).filter((d) => d !== WHEEL_SET && existsSync(join(AUTHORED, d, `${d}.blend`))) : [];
  const blender = authored.length ? findBlender() : null;
  if (authored.length && !blender) throw new Error('Authored .blend cars found but Blender is not available. Install Blender or set BLENDER=/path/to/blender.');
  for (const carId of authored) {
    const entry = manifest.cars.find((c) => c.id === carId);
    if (!entry) throw new Error(`${carId}: add a carManifest.json entry (displayName, engine, defaultPaint, selectable) before building it`);
    const blend = join(AUTHORED, carId, `${carId}.blend`);
    const out = join(CONVERTED, carId);
    const metaPath = join(out, 'car.json');
    const exporter = join(ROOT, 'scripts/blender/exportCar.py');
    const stale = !existsSync(metaPath) || statSync(metaPath).mtimeMs < Math.max(statSync(blend).mtimeMs, statSync(exporter).mtimeMs);
    if (stale) execFileSync(blender as string, ['--background', blend, '--python', exporter, '--', out], { stdio: 'pipe' });
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      car: { node: string; tris: number }[];
      parts: { slot: PartEntry['slot']; partId: string; displayName: string; hides: string[]; tris: number }[];
      wheels: { name: string; displayName: string }[];
      wheelCenters: Record<'FL' | 'FR' | 'RL' | 'RR', number[]>;
    };
    log(`\n== ${carId} (${relative(ROOT, blend)}) authored`);
    const section: string[] = [`## ${carId}`, '', `Source: \`${relative(ROOT, blend)}\` (authored in car space, exported with scripts/blender/exportCar.py).`, ''];
    let carBytes = 0;

    const base = await io.read(join(out, 'car.glb'));
    await bakeTransforms(base);
    const b = bounds(positions(base));
    const baseOut = await writeOptimized(io, base, join(PUBLIC, `cars/${carId}.glb`));
    carBytes += baseOut.bytes;
    section.push(`- Base car \`public/cars/${carId}.glb\`: ${(baseOut.bytes / 1024).toFixed(1)} KB, ${baseOut.tris} tris, nodes ${meta.car.map((c) => '`' + c.node + '`').join(', ')}.`);

    for (const p of meta.parts) {
      const doc = await io.read(join(out, 'parts', `${p.slot}_${p.partId}.glb`));
      const file = `parts/${partFileName(carId, p.slot, p.partId)}`;
      const w = await writeOptimized(io, doc, join(PUBLIC, file));
      carBytes += w.bytes;
      generated.push({ id: `${carId}_${p.slot}_${p.partId}`, displayName: p.displayName, carId, slot: p.slot, file, hides: p.hides, materialSlots: materialSlotsOf(doc), tris: w.tris, generated: true } as PartEntry);
    }
    section.push(`- Parts: ${meta.parts.map((p) => `${p.slot} ${p.partId}`).join(', ')}.`);

    const wheelIds: string[] = [];
    for (const wh of meta.wheels) {
      const doc = await io.read(join(out, 'wheels', `wheel_${wh.name}.glb`));
      const id = `wheel_${carId}_${wh.name}`;
      const w = await writeOptimized(io, doc, join(PUBLIC, `parts/${id}.glb`), 'Wheel');
      carBytes += w.bytes;
      wheelIds.push(id);
      generated.push({ id, displayName: wh.displayName || `${entry.displayName.replace(/^Proto /, '')} wheel ${wh.name}`, carId: 'universal', slot: 'wheels', file: `parts/${id}.glb`, hides: [], materialSlots: materialSlotsOf(doc), tris: w.tris, generated: true } as PartEntry);
    }

    const c = meta.wheelCenters;
    const radius = c.FL[1];
    const std = config.standardWheel;
    if (Math.abs(radius - std.radius) > 0.005) section.push(`- WARNING: wheel radius ${radius.toFixed(3)} m differs from the standard ${std.radius} m (assetConfig.json standardWheel). Every car shares one wheel size so scale reads the same.`);
    entry.provisional = false;
    entry.source = 'eshell';
    entry.file = `cars/${carId}.glb`;
    entry.baseBodyNode = 'Body';
    entry.wheelNodes = [];
    entry.wheelRadius = round(radius);
    entry.wheelWidth = std.width;
    entry.wheels = { FL: c.FL, FR: c.FR, RL: c.RL, RR: c.RR };
    entry.wheelbase = round(c.FL[2] - c.RL[2]);
    entry.trackFront = round(c.FL[0] - c.FR[0]);
    entry.trackRear = round(c.RL[0] - c.RR[0]);
    entry.dimensions = { length: round(b.max[2] - b.min[2], 2), width: round(b.max[0] - b.min[0], 2), height: round(b.max[1] - b.min[1], 2) };
    entry.materialMap = {};
    if (!wheelIds.includes(entry.defaultWheel) && wheelIds.length) entry.defaultWheel = wheelIds[0];
    section.push(`- Wheel radius ${radius.toFixed(3)} m, width ${std.width} m, wheelbase ${entry.wheelbase} m, track ${entry.trackFront} m.`);
    section.push(`- Car dimensions ${entry.dimensions.length} x ${entry.dimensions.width} x ${entry.dimensions.height} m.`, '');
    sizeReport.push(`| ${carId} | ${(carBytes / 1024).toFixed(1)} KB |`);
    inspectSections.push(section.join('\n'));
  }

  // ----- IceMaan cars -----
  const conv = findConverter();
  const present: string[] = [];
  const missing: string[] = [];
  for (const [carId, cfg] of Object.entries(config.cars)) {
    const folder = cfg.folders.map((f) => join(SRC, f)).find((p) => existsSync(p));
    if (!folder) {
      missing.push(carId);
      continue;
    }
    if (!conv) throw new Error('Source FBX files found but neither Blender nor FBX2glTF is available. Install Blender or run `npm i -D fbx2gltf`.');
    present.push(carId);
    log(`\n== ${carId} (${relative(ROOT, folder)}) via ${conv.kind}`);
    const files = listFbx(folder);
    const items = files.map((f) => ({ file: f, kind: classify(f), glb: join(CONVERTED, carId, basename(f, '.fbx') + '.glb') }));
    for (const it of items) convert(conv, it.file, it.glb);

    const load = async (glb: string) => {
      const doc = await io.read(glb);
      await bakeTransforms(doc);
      const unknown = renameMaterials(doc, config.materialMap, MATERIAL_NAMES);
      return { doc, unknown };
    };

    const bodies = items.filter((i) => i.kind.type === 'body').sort((a, b) => (a.kind as { index: number }).index - (b.kind as { index: number }).index);
    const spoilers = items.filter((i) => i.kind.type === 'spoiler');
    const wheels = items.filter((i) => i.kind.type === 'wheel' && (i.kind as { side: string }).side === 'L');
    if (!bodies.length) throw new Error(`${carId}: no body FBX found in ${folder}`);

    const unknownMats = new Set<string>();
    // Raw wheel size from the first wheel file (shared scale with the car).
    let wheelRaw = { radius: 0.3, width: 0.2 };
    if (wheels.length) {
      const w = await load(wheels[0].glb);
      const b = bounds(positions(w.doc));
      const ext = [0, 1, 2].map((k) => b.max[k] - b.min[k]).sort((a, c) => a - c);
      wheelRaw = { radius: ext[2] / 2, width: ext[0] };
    }
    const first = await load(bodies[0].glb);
    first.unknown.forEach((u) => unknownMats.add(u));
    const frame = computeFrame(carId, first.doc, wheelRaw);
    const section: string[] = [`## ${carId}`, '', `Source: \`${relative(ROOT, folder)}\` (${files.length} FBX files, converted with ${conv.kind}).`, ''];
    section.push(...frame.notes.map((n) => `- ${n}`));
    section.push(`- Wheel radius ${frame.wheelRadius.toFixed(3)} m, width ${frame.wheelWidth.toFixed(3)} m, wheelbase ${(frame.wheels.FL[2] * 2).toFixed(3)} m, track ${(frame.wheels.FL[0] * 2).toFixed(3)} m.`);
    section.push(`- Car dimensions ${frame.dims.length.toFixed(2)} x ${frame.dims.width.toFixed(2)} x ${frame.dims.height.toFixed(2)} m.`);

    let carBytes = 0;
    // Base car = body kit 1.
    transformAll(first.doc, frame.matrix);
    const normalizedBase = cloneDocument(first.doc);
    const baseOut = await writeOptimized(io, first.doc, join(PUBLIC, `cars/${carId}.glb`), 'Body');
    carBytes += baseOut.bytes;
    section.push(`- Base car \`public/cars/${carId}.glb\`: ${(baseOut.bytes / 1024).toFixed(1)} KB, ${baseOut.tris} tris (body kit 1).`);

    // Other body kits are whole-body variants (merged meshes).
    for (const kit of bodies.slice(1)) {
      const idx = (kit.kind as { index: number }).index;
      const k = await load(kit.glb);
      k.unknown.forEach((u) => unknownMats.add(u));
      transformAll(k.doc, frame.matrix);
      const id = `${carId}_body_kit${idx}`;
      const file = `parts/${partFileName(carId, 'body', `kit${idx}`)}`;
      const out = await writeOptimized(io, k.doc, join(PUBLIC, file), `Body_Kit${idx}`);
      carBytes += out.bytes;
      generated.push({ id, displayName: `Body kit ${idx}`, carId, slot: 'body', file, hides: ['Body'], materialSlots: materialSlotsOf(k.doc), tris: out.tris, generated: true } as PartEntry);
    }
    if (bodies.length) {
      splitNeeded.push(carId);
      section.push(`- Body kits are single merged meshes, registered as \`body\` variants (${bodies.length} kits). Bumpers need splitting in Blender to use the bumper slots (see below).`);
    }

    for (const sp of spoilers) {
      const idx = (sp.kind as { index: number }).index || 1;
      const s = await load(sp.glb);
      s.unknown.forEach((u) => unknownMats.add(u));
      transformAll(s.doc, mul(scaleM(frame.scale), rotY(computeAngle(frame))));
      const placed = placeSpoiler(s.doc, normalizedBase, config.cars[carId].spoilerOffset);
      const id = `${carId}_spoiler_${idx}`;
      const file = `parts/${partFileName(carId, 'spoiler', String(idx))}`;
      const out = await writeOptimized(io, s.doc, join(PUBLIC, file), `Spoiler_${idx}`);
      carBytes += out.bytes;
      generated.push({ id, displayName: `Spoiler ${idx}`, carId, slot: 'spoiler', file, hides: [], materialSlots: materialSlotsOf(s.doc), tris: out.tris, generated: true } as PartEntry);
      section.push(`- Spoiler ${idx}: auto placed on the rear deck (${placed}).`);
    }

    let defaultWheel = '';
    for (const w of wheels) {
      const idx = (w.kind as { index: number }).index;
      const d = await load(w.glb);
      d.unknown.forEach((u) => unknownMats.add(u));
      wheelToWheelSpace(d.doc, frame.scale);
      const id = `wheel_${carId}_${idx || 0}`;
      const file = `parts/${id}.glb`;
      const out = await writeOptimized(io, d.doc, join(PUBLIC, file), 'Wheel');
      carBytes += out.bytes;
      if (!defaultWheel) defaultWheel = id;
      generated.push({ id, displayName: `${carId.toUpperCase()} wheel ${idx || 0}`, carId: 'universal', slot: 'wheels', file, hides: [], materialSlots: materialSlotsOf(d.doc), tris: out.tris, generated: true } as PartEntry);
    }
    if (unknownMats.size) section.push(`- WARNING: unmapped source materials: ${[...unknownMats].map((m) => '`' + m + '`').join(', ')}. Add them to \`materialMap\` in scripts/assetConfig.json.`);
    sizeReport.push(`| ${carId} | ${(carBytes / 1024).toFixed(1)} KB |`);

    // Manifest entry.
    const entry = manifest.cars.find((c) => c.id === carId);
    if (entry) {
      entry.provisional = false;
      entry.file = `cars/${carId}.glb`;
      entry.baseBodyNode = 'Body';
      entry.wheelNodes = [];
      entry.wheelRadius = round(frame.wheelRadius);
      entry.wheelWidth = round(frame.wheelWidth);
      entry.wheels = Object.fromEntries(Object.entries(frame.wheels).map(([k, v]) => [k, v.map((x) => round(x))]));
      entry.wheelbase = round(frame.wheels.FL[2] * 2);
      entry.trackFront = round(frame.wheels.FL[0] * 2);
      entry.trackRear = round(frame.wheels.RL[0] * 2);
      entry.dimensions = { length: round(frame.dims.length, 2), width: round(frame.dims.width, 2), height: round(frame.dims.height, 2) };
      entry.materialMap = {};
      if (defaultWheel) entry.defaultWheel = defaultWheel;
    }

    // Raw inspection of the converted source files.
    section.push('', '<details><summary>Converted source files</summary>', '');
    for (const it of items) {
      const doc = await io.read(it.glb);
      section.push(formatInfo(inspectDocument(doc, relative(ROOT, it.glb), statSync(it.glb).size)));
    }
    section.push('</details>', '');
    inspectSections.push(section.join('\n'));
  }

  // ----- The shared wheel set (assets/source/eshell/wheels/wheels.blend, docs/carWheels.md) -----
  // Universal wheels from donor wheels on the house tire; ids are wheel_<name>.
  const wheelBlend = join(AUTHORED, WHEEL_SET, `${WHEEL_SET}.blend`);
  if (existsSync(wheelBlend)) {
    const blenderW = findBlender();
    if (!blenderW) throw new Error('The wheel set needs Blender. Install Blender or set BLENDER=/path/to/blender.');
    const out = join(CONVERTED, WHEEL_SET);
    const metaPath = join(out, 'car.json');
    const exporter = join(ROOT, 'scripts/blender/exportCar.py');
    const stale = !existsSync(metaPath) || statSync(metaPath).mtimeMs < Math.max(statSync(wheelBlend).mtimeMs, statSync(exporter).mtimeMs);
    if (stale) execFileSync(blenderW, ['--background', wheelBlend, '--python', exporter, '--', out], { stdio: 'pipe' });
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { wheels: { name: string; displayName: string; group?: string; construction?: string; offset?: number | null; lip?: string; lugs?: WheelLugs | null }[] };
    const section: string[] = ['## Wheel set', '', `Source: \`${relative(ROOT, wheelBlend)}\` (scripts/blender/carWheels.py).`, ''];
    for (const wh of meta.wheels) {
      const doc = await io.read(join(out, 'wheels', `wheel_${wh.name}.glb`));
      const id = `wheel_${wh.name}`;
      const w = await writeOptimized(io, doc, join(PUBLIC, `parts/${id}.glb`), 'Wheel');
      if (!isConstruction(wh.construction)) throw new Error(`wheel_${wh.name}: no construction on the wheel object (its recipe in carWheels.py states 'single' or 'multi'; rebuild it)`);
      if (wh.construction === 'multi' && !Number.isFinite(wh.offset)) throw new Error(`wheel_${wh.name}: a multi-piece wheel with no stock offset (carWheels.py wheel_offset)`);
      generated.push({ id, displayName: wh.displayName || wh.name, ...(wh.group ? { group: wh.group } : {}), construction: wh.construction, ...(wh.construction === 'multi' ? { offset: wh.offset as number } : {}), ...(wh.lip === 'chrome' || wh.lip === 'rim' ? { lip: wh.lip } : {}), ...(validLugs(wh.lugs) ? { lugs: wh.lugs } : {}), carId: 'universal', slot: 'wheels', file: `parts/${id}.glb`, hides: [], materialSlots: materialSlotsOf(doc), tris: w.tris, generated: true } as PartEntry);
      section.push(`- \`${id}\` ${wh.displayName}: ${(w.bytes / 1024).toFixed(1)} KB, ${w.tris} tris.`);
    }
    inspectSections.push(section.join('\n') + '\n');
    log(`wheel set: ${meta.wheels.length} wheels`);
  }

  // Cars without source files keep provisional geometry and render as code placeholders.
  for (const id of missing) {
    const entry = manifest.cars.find((c) => c.id === id);
    if (entry) entry.provisional = true;
  }

  // ----- Catalog and manifest -----
  const generatedIds = new Set(generated.map((g) => g.id));
  catalog.parts = [...handAuthored.filter((p) => !generatedIds.has(p.id)), ...generated];
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  log(`\ncatalog: ${catalog.parts.length} parts, manifest: ${manifest.cars.length} cars`);

  // ----- inspect.md -----
  const md: string[] = [
    '# Asset inspection',
    '',
    'Generated by `npm run assets` (scripts/buildAssets.ts). Re-run after changing files in `assets/source/eshell/` (authored .blend cars) or `assets/source/icemaan/` (FBX cars).',
    '',
    `Authored cars: ${authored.join(', ') || 'none'}. FBX cars with source files: ${present.join(', ') || 'none'}. Missing (rendered as code placeholders until added): ${missing.join(', ') || 'none'}.`,
    '',
    '## Output sizes (car + all its parts, Meshopt compressed)',
    '',
    '| Car | Size |',
    '|---|---|',
    ...sizeReport,
    '',
    '## Material vocabulary',
    '',
    `Source materials are renamed using \`materialMap\` in scripts/assetConfig.json to: ${MATERIAL_NAMES.map((m) => '`' + m + '`').join(', ')}.`,
    '',
    '```json',
    JSON.stringify(config.materialMap, null, 2),
    '```',
    '',
  ];
  if (splitNeeded.length) {
    md.push(
      '## Bumpers to split in Blender',
      '',
      `These cars ship each body kit as one merged mesh, so bumpers, skirts and hoods cannot be swapped independently yet: **${splitNeeded.join(', ')}**.`,
      '',
      'For each body kit FBX:',
      '',
      '1. Import the FBX in Blender (File > Import > FBX). Select the body mesh and enter Edit Mode (Tab).',
      '2. In face select mode, select the front bumper faces (hover a face and press L to select linked islands, or box select in side view with X-ray on). Press P > Selection to separate them into a new object.',
      '3. Rename the new object `Bumper_Front` (and similarly `Bumper_Rear`, `Skirts`, `Hood`). Leave the rest as `Body`.',
      '4. Export each separated piece as its own GLB following docs/partsAuthoring.md (car space, shared material names), name it `<carId>_<slot>_<partId>.glb`, put it in `public/parts/`, and add a catalog entry whose `hides` lists the base mesh name it replaces.',
      '5. Alternatively keep all pieces in the body FBX and re-run `npm run assets`; then point catalog entries at the car GLB with `"node": "Bumper_Front"`.',
      '',
    );
  }
  md.push(...inspectSections);
  writeFileSync(join(ROOT, 'assets/inspect.md'), md.join('\n'));
  log('wrote assets/inspect.md');

  // ----- validation -----
  const result = await validateCatalog();
  for (const w of result.warnings) console.warn('warning:', w);
  if (result.errors.length) {
    for (const e of result.errors) console.error('ERROR:', e);
    console.error(`\nParts validation failed with ${result.errors.length} error(s).`);
    process.exit(1);
  }
  log(`validation passed (${result.checked} parts)`);
  void report;
}

function computeAngle(frame: CarFrame): number {
  // Recover the Y rotation from the frame matrix (scale is uniform).
  const m = frame.matrix;
  return Math.atan2(m[8], m[0]);
}

function materialSlotsOf(doc: Document): PartEntry['materialSlots'] {
  const names = new Set<string>();
  for (const m of doc.getRoot().listMaterials()) names.add(m.getName());
  return [...names].filter((n) => (MATERIAL_NAMES as readonly string[]).includes(n)) as PartEntry['materialSlots'];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
