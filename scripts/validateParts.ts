/**
 * Validates src/assets/partsCatalog.json against the files in public/:
 * matching file, known slot and car, known material names, triangle budget,
 * bounding box sanity against the car, hidden mesh names, and per car size;
 * plus every manifest car's engine spec (src/shared/carSpec.ts).
 *
 *   npm run validate
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MATERIAL_NAMES, PART_SLOTS, PartEntry, PartsCatalog, TRI_BUDGETS } from '../src/shared/parts';
import { engineSpecErrors } from '../src/shared/carSpec';
import { createIO } from './inspectAsset';
import { bakeTransforms, bounds, positions, triangleCount } from './gltfUtil';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  checked: number;
}

interface ManifestCar {
  id: string;
  file: string;
  provisional: boolean;
  dimensions: { length: number; width: number; height: number };
  engine?: unknown;
  engineSwaps?: { id: string; engine: unknown }[];
}

const ROOT = process.cwd();
/** A car with its parts, Meshopt compressed: a 16,000 triangle shell plus cabin is 540 to 610 KB (docs/carDonors.md). */
const CAR_BYTES_BUDGET = 700 * 1024;

export async function validateCatalog(catalogPath = 'src/assets/partsCatalog.json', manifestPath = 'src/assets/carManifest.json', publicDir = 'public'): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const catalog = JSON.parse(readFileSync(join(ROOT, catalogPath), 'utf8')) as PartsCatalog;
  const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath), 'utf8')) as { cars: ManifestCar[] };
  const cars = new Map(manifest.cars.map((c) => [c.id, c]));
  const io = await createIO();
  const ids = new Set<string>();
  const baseNames = new Map<string, Set<string>>();
  const carBytes = new Map<string, number>();

  for (const car of manifest.cars) {
    for (const e of engineSpecErrors(car.engine)) errors.push(`car ${car.id}: ${e}`);
    for (const s of car.engineSwaps ?? []) for (const e of engineSpecErrors(s.engine)) errors.push(`car ${car.id} swap ${s.id}: ${e}`);
    const file = join(ROOT, publicDir, car.file);
    if (!existsSync(file)) {
      if (!car.provisional) errors.push(`car ${car.id}: ${car.file} is missing (run npm run assets)`);
      continue;
    }
    carBytes.set(car.id, statSync(file).size);
    const doc = await io.read(file);
    baseNames.set(car.id, new Set(doc.getRoot().listNodes().map((n) => n.getName())));
  }

  for (const p of catalog.parts as PartEntry[]) {
    const where = `part ${p.id ?? '(no id)'}`;
    if (!p.id || !/^[A-Za-z0-9_\-.]+$/.test(p.id)) errors.push(`${where}: invalid id`);
    if (ids.has(p.id)) errors.push(`${where}: duplicate id`);
    ids.add(p.id);
    if (!PART_SLOTS.includes(p.slot)) errors.push(`${where}: unknown slot "${p.slot}" (known: ${PART_SLOTS.join(', ')})`);
    if (p.carId === 'universal') {
      if (p.slot !== 'wheels') errors.push(`${where}: only wheels can be universal`);
    } else if (!cars.has(p.carId)) errors.push(`${where}: unknown carId "${p.carId}"`);
    for (const m of p.materialSlots ?? []) if (!(MATERIAL_NAMES as readonly string[]).includes(m)) errors.push(`${where}: unknown material slot "${m}"`);
    const file = join(ROOT, publicDir, p.file ?? '');
    if (!p.file || !existsSync(file)) {
      errors.push(`${where}: file "${p.file}" not found in ${publicDir}/`);
      continue;
    }
    const size = statSync(file).size;
    if (p.carId !== 'universal') carBytes.set(p.carId, (carBytes.get(p.carId) ?? 0) + size);
    const doc = await io.read(file);
    if (p.node && !doc.getRoot().listNodes().some((n) => n.getName() === p.node)) errors.push(`${where}: node "${p.node}" not found in ${p.file}`);
    for (const m of doc.getRoot().listMaterials()) {
      if (!(MATERIAL_NAMES as readonly string[]).includes(m.getName())) errors.push(`${where}: material "${m.getName()}" is not in the shared vocabulary (${MATERIAL_NAMES.join(', ')})`);
    }
    const tris = triangleCount(doc);
    const budget = TRI_BUDGETS[p.slot] ?? 3000;
    if (tris > budget) errors.push(`${where}: ${tris} triangles exceeds the ${p.slot} budget of ${budget}`);
    if (p.tris && Math.abs(p.tris - tris) > Math.max(10, tris * 0.05)) warnings.push(`${where}: catalog says ${p.tris} tris, file has ${tris}`);

    await bakeTransforms(doc);
    const b = bounds(positions(doc));
    if (!Number.isFinite(b.min[0])) {
      errors.push(`${where}: no geometry`);
      continue;
    }
    const size3 = b.max.map((v, i) => v - b.min[i]);
    if (p.slot === 'wheels') {
      const r = Math.max(size3[1], size3[2]) / 2;
      if (r < 0.15 || r > 0.6) errors.push(`${where}: wheel radius ${r.toFixed(3)} m out of range 0.15..0.6 (wheel space is meters)`);
      const c = b.max.map((v, i) => (v + b.min[i]) / 2);
      if (Math.hypot(c[1], c[2]) > 0.05) warnings.push(`${where}: wheel not centered on its axle (center ${c.map((x) => x.toFixed(3)).join(', ')})`);
      if (size3[0] > size3[1]) errors.push(`${where}: wheel axle should run along X`);
    } else {
      const car = cars.get(p.carId);
      if (car) {
        const d = car.dimensions;
        const margin = 0.45;
        const ok = Math.abs(b.min[0]) < d.width / 2 + margin && Math.abs(b.max[0]) < d.width / 2 + margin && b.min[1] > -0.2 && b.max[1] < d.height + margin + 0.6 && Math.abs(b.min[2]) < d.length / 2 + margin && Math.abs(b.max[2]) < d.length / 2 + margin;
        if (!ok) errors.push(`${where}: bounding box [${b.min.map((x) => x.toFixed(2))}]..[${b.max.map((x) => x.toFixed(2))}] does not fit car ${car.id} (${d.length} x ${d.width} x ${d.height} m). Is it in car space (meters, Y up, origin between axles, facing +Z)?`);
      }
      const names = baseNames.get(p.carId);
      for (const h of p.hides ?? []) if (names && !names.has(h)) warnings.push(`${where}: hides "${h}" but the base car has no node with that name`);
    }
  }
  for (const [carId, bytes] of carBytes) {
    if (bytes > CAR_BYTES_BUDGET) warnings.push(`car ${carId}: car plus parts is ${(bytes / 1024).toFixed(0)} KB (budget ${CAR_BYTES_BUDGET / 1024} KB)`);
  }
  return { errors, warnings, checked: catalog.parts.length };
}

if (process.argv[1] && process.argv[1].endsWith('validateParts.ts')) {
  validateCatalog().then((r) => {
    for (const w of r.warnings) console.warn('warning:', w);
    for (const e of r.errors) console.error('ERROR:', e);
    console.log(r.errors.length ? `FAILED: ${r.errors.length} error(s)` : `OK: ${r.checked} parts valid`);
    process.exit(r.errors.length ? 1 : 0);
  });
}
