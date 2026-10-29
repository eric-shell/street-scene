/**
 * Headless baseline of every multi-piece wheel's offset (docs/carWheels.md, "Offset"): the stock offset the
 * catalog carries (mm, the lug seat or cap front from the tire's centerline, +X outboard: the wheel's ET at the
 * house scale), where its face sits against the lip edge and the barrel's back, and the range of offsets its
 * face can be moved to at runtime (`faceRange`: the lip cone keeps `minLip`, the barrel `minBarrel`). A per-car
 * target outside a wheel's range clamps to it, so the table shows which wheels can reach which targets.
 *
 *   npx tsx scripts/checkWheelOffset.ts [file.glb ...]     (default: every multi-piece wheel in the catalog)
 */
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '../src/assets/partsCatalog.json';
import { detectFaceFit, detectProfile, faceRange } from '../src/render/car/wheelFit';
import { createIO } from './inspectAsset';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));

/** The wheel's vertices by part, in wheel space: X of the face and the ring, radii of the face and the tire. */
async function vertices(file: string): Promise<{ faceX: number[]; faceR: number[]; ringX: number[]; tireR: number[] }> {
  const io = await createIO();
  const doc = await io.read(file);
  const faceX: number[] = [], faceR: number[] = [], ringX: number[] = [], tireR: number[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const name = p.getMaterial()?.getName();
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        const r = Math.hypot(m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]);
        if (name === 'Tire') tireR.push(r);
        else if (name === 'RimLip') ringX.push(x);
        else faceX.push(x), faceR.push(r);
      }
    }
  }
  return { faceX, faceR, ringX, tireR };
}

async function main(): Promise<void> {
  const wheels = catalog.parts.filter((p) => p.slot === 'wheels' && p.construction === 'multi');
  const args = process.argv.slice(2);
  const picked = args.length ? wheels.filter((w) => args.some((a) => basename(a, '.glb') === w.id)) : wheels;
  const mm = (x: number) => Math.round(x * 1000).toString().padStart(5);
  console.log(`${'wheel'.padEnd(10)} ${'offset'.padStart(6)}  ${'face'.padStart(11)}  ${'lip'.padStart(4)} ${'barrel'.padStart(6)}  ${'reach'.padStart(12)}  (mm; offset: lug seat or cap front from the tire's centerline; reach: the offsets the face can be moved to)`);
  for (const w of picked) {
    const { faceX, faceR, ringX, tireR } = await vertices(`${PUBLIC}/${w.file}`);
    const f = detectFaceFit(faceX, faceR, ringX, detectProfile(tireR, faceR).bead);
    const [lo, hi] = faceRange(f);
    const offset = w.offset ?? NaN;
    const reach = Number.isFinite(offset) ? `${mm(offset + lo)}..${mm(offset + hi)}` : '  fixed (as modelled)';
    console.log(`${w.id.slice(6).padEnd(10)} ${(Number.isFinite(offset) ? mm(offset) : 'fixed').padStart(6)}  ${mm(f.back)}..${mm(f.front)}  ${mm(f.lipEdge - f.front).slice(1)} ${mm(f.back - f.barrelBack).padStart(6)}  ${reach}${w.offsetBias ? `  bias ${w.offsetBias > 0 ? '+' : ''}${w.offsetBias}` : ''}`);
  }
  console.log(`${picked.length} multi-piece wheels`);
}

void main();
