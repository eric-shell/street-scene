/**
 * Headless look at which way every wheel GLB faces along its axle (docs/carWheels.md, "Facing"). A wheel ships
 * in wheel space with the axle along X and its face toward +X (the left side's outboard); the garage mirrors it
 * for the right side. Two checks, both from parallel rays along -X over the disc (the way the camera sees it):
 *   - winding (a hard check): the first `Rim` surface each ray meets must be a front face (geometric normal
 *     toward +X). Rim is drawn single sided, so a wheel wound the other way loses its spokes from outside.
 *     Every shipped wheel passes; a failure means the pipeline's hidden face cull or a mirror went wrong.
 *   - dish (a report, not a verdict): where the first visible surface sits along X at the hub, mid and tip
 *     radii, and how far the face is from the back of the wheel. Geometry cannot tell a deep concave design
 *     from a wheel whose `face` came out backwards (the doc's "the front cannot be told from the ring"), so a
 *     face flush with the back is flagged "deep" for a look, not failed.
 *
 *   npx tsx scripts/checkWheelFacing.ts [file.glb ...]     (default: every public/parts/wheel_*.glb)
 */
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIO } from './inspectAsset';

export interface WheelFacing {
  id: string;
  /** Share of the rays' first Rim hits that land on a face looking toward +X (0 to 1); a sound wheel reads 1. */
  front: number;
  /** First visible surface along X (m, wheel space, +X outboard) at the hub (0.15 to 0.3 of the lip radius), mid (0.4 to 0.6) and tips (0.7 to 0.9). */
  hub: number;
  mid: number;
  tips: number;
  /** How far the mid face sits behind the lip edge, as a share of the wheel's depth (0 flush with the front, 1 flush with the back). */
  depth: number;
  /** True when the winding check passes. */
  ok: boolean;
}

const PARTS = fileURLToPath(new URL('../public/parts', import.meta.url));
/** Below this share of front facing first Rim hits the wheel's winding counts as wrong (sound wheels read 1.00). */
export const FACING_MIN = 0.5;
/** A face deeper than this share of the wheel's depth is reported as deep (sound concave designs run to 0.7; a face this deep needs a look). */
export const DEEP = 0.85;

interface Tri {
  o: Float64Array;
  rim: boolean;
}

async function wheelTriangles(file: string): Promise<{ tris: Tri[]; r: number }> {
  const io = await createIO();
  const doc = await io.read(file);
  const tris: Tri[] = [];
  let r = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const name = p.getMaterial()?.getName();
      if (name === 'Tire') continue;
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      const idx = p.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const v = [0, 0, 0];
      const at = (i: number): number[] => {
        pos.getElement(idx ? idx.getScalar(i) : i, v);
        const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
        r = Math.max(r, Math.hypot(y, z));
        return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], y, z];
      };
      for (let t = 0; t + 2 < count; t += 3) tris.push({ o: Float64Array.from([...at(t), ...at(t + 1), ...at(t + 2)]), rim: name === 'Rim' || name === 'RimLip' || name === 'RimCap' });
    }
  }
  return { tris, r };
}

/** The nearest surface to a viewer at +X along the ray (y, z): its X and whether it faces +X; null when nothing is hit. */
function firstHit(tris: Tri[], y: number, z: number, rimOnly: boolean): { x: number; front: boolean } | null {
  let best: { x: number; front: boolean } | null = null;
  for (const { o, rim } of tris) {
    if (rimOnly && !rim) continue;
    // Barycentric test in the YZ plane; the hit's X is interpolated. The YZ determinant is the normal's X.
    const e1y = o[4] - o[1], e1z = o[5] - o[2];
    const e2y = o[7] - o[1], e2z = o[8] - o[2];
    const det = e1y * e2z - e1z * e2y;
    if (Math.abs(det) < 1e-12) continue;
    const py = y - o[1], pz = z - o[2];
    const u = (py * e2z - pz * e2y) / det;
    const w = (e1y * pz - e1z * py) / det;
    if (u < 0 || w < 0 || u + w > 1) continue;
    const x = o[0] + u * (o[3] - o[0]) + w * (o[6] - o[0]);
    if (!best || x > best.x) best = { x, front: det > 0 };
  }
  return best;
}

export async function wheelFacing(file: string): Promise<WheelFacing> {
  const { tris, r: R } = await wheelTriangles(file);
  let lo = Infinity;
  let hi = -Infinity;
  for (const { o } of tris) for (const k of [0, 3, 6]) (lo = Math.min(lo, o[k])), (hi = Math.max(hi, o[k]));
  const N = 50;
  let front = 0;
  let hits = 0;
  const band: Record<'hub' | 'mid' | 'tips', number[]> = { hub: [], mid: [], tips: [] };
  for (let iy = 0; iy < N; iy++) {
    for (let iz = 0; iz < N; iz++) {
      const y = (iy / (N - 1) - 0.5) * 1.8 * R;
      const z = (iz / (N - 1) - 0.5) * 1.8 * R;
      const rr = Math.hypot(y, z) / R;
      if (rr < 0.15 || rr > 0.9) continue;
      const k = rr < 0.3 ? 'hub' : rr > 0.7 ? 'tips' : rr > 0.4 && rr < 0.6 ? 'mid' : null;
      if (k) {
        const h = firstHit(tris, y, z, false);
        if (h) band[k].push(h.x);
      }
      const h = firstHit(tris, y, z, true);
      if (!h) continue;
      hits++;
      if (h.front) front++;
    }
  }
  const median = (a: number[]) => (a.sort((p, q) => p - q), a.length ? a[a.length >> 1] : NaN);
  const [hub, mid, tips] = [median(band.hub), median(band.mid), median(band.tips)];
  const share = hits ? front / hits : 0;
  return { id: basename(file, '.glb'), front: share, hub, mid, tips, depth: (hi - mid) / (hi - lo || 1), ok: share >= FACING_MIN };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const files = args.length ? args : readdirSync(PARTS).filter((f) => /^wheel_.*\.glb$/.test(f)).sort().map((f) => join(PARTS, f));
  let bad = 0;
  for (const f of files) {
    const r = await wheelFacing(f);
    if (!r.ok) bad++;
    const n = (x: number) => x.toFixed(3).padStart(6);
    console.log(`${r.ok ? 'ok    ' : 'WOUND '} ${r.id.padEnd(16)} front ${r.front.toFixed(2)}  hub ${n(r.hub)} mid ${n(r.mid)} tips ${n(r.tips)}  depth ${r.depth.toFixed(2)}${r.depth > DEEP ? '  deep' : ''}`);
  }
  console.log(`${files.length} wheels, ${bad} wound the wrong way`);
  if (bad) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
