/**
 * Audits a shipped car GLB against its reference spec (scripts/blender/carSpecs.json):
 * proportions against the blended donors at the house scale, and the shared feature set
 * (glass band and pillars, mirrors, handles, cowl, lamps, indicators, interior, arch gaps),
 * each found by material and position rather than by name, so a modelling session starts
 * from numbers instead of screenshots. Everything is car space (meters, Y up, +Z forward,
 * +X left); a Blender session gets the same table from carRefs.py spec_check().
 *
 *   npm run audit                      every car in the spec
 *   npm run audit -- wendtFairway        one car
 *   npm run audit -- --json            machine readable (per car: measure, targets, checks)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Document } from '@gltf-transform/core';
import { createIO } from './inspectAsset';
import { bakeTransforms } from './gltfUtil';

type V3 = [number, number, number];

/** Lamp covers that stand taller than the house band (carFeatures.py TALL_COVERS). */
const TALL_COVERS = ['verticalUnit'];

interface Face {
  mat: string;
  v: [V3, V3, V3];
  /** Unit normal from the winding (exports are consistently outward). */
  n: V3;
  /** Center. */
  c: V3;
}

interface Donor {
  name: string;
  weight: number;
  /** Real dimensions in mm, plus angles in degrees. */
  mm: Record<string, number>;
  estimates?: string[];
  sources: string[];
  take: string[];
}
interface LampSpec {
  cover: string;
  elements: string;
  indicator: string;
  wrap?: boolean;
  centerBar?: boolean;
  notes: string;
}
export interface CarSpec {
  displayName: string;
  brief: string;
  donors: Donor[];
  body: { doors: number; pillars: string[]; roofline: string; exhaust: string };
  lights: { front: LampSpec; rear: LampSpec };
}
export interface House {
  wheelRadius: number;
  scale: Record<string, number>;
  tolerance: { ratio: number; angleDeg: number };
  features: { lamp: { heightRange: [number, number] }; arch: { gap: [number, number] } };
}
export interface Specs {
  house: House;
  cars: Record<string, CarSpec>;
}
interface ManifestCar {
  id: string;
  file: string;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
}

const ROOT = process.cwd();

// ----- geometry --------------------------------------------------------------

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function faces(doc: Document): Face[] {
  const out: Face[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== 4) continue;
      const pos = p.getAttribute('POSITION');
      if (!pos) continue;
      const idx = p.getIndices();
      const mat = p.getMaterial()?.getName() ?? '';
      const count = idx ? idx.getCount() : pos.getCount();
      const get = (i: number): V3 => pos.getElement(idx ? idx.getScalar(i) : i, [0, 0, 0]) as V3;
      for (let i = 0; i + 2 < count; i += 3) {
        const a = get(i);
        const b = get(i + 1);
        const c = get(i + 2);
        out.push({ mat, v: [a, b, c], n: unit(cross(sub(b, a), sub(c, a))), c: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
      }
    }
  }
  return out;
}

function bounds(fs: Face[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const f of fs) {
    for (const p of f.v) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < min[k]) min[k] = p[k];
        if (p[k] > max[k]) max[k] = p[k];
      }
    }
  }
  return { min, max };
}

interface Island {
  faces: Face[];
  min: V3;
  max: V3;
  mats: Set<string>;
}

/** Loose face islands, welding vertices by position (the exporter splits vertices on normals). */
function islands(fs: Face[]): Island[] {
  const vid = new Map<string, number>();
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const roots: number[] = [];
  for (const f of fs) {
    const ids = f.v.map((p) => {
      const k = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
      let id = vid.get(k);
      if (id === undefined) {
        id = parent.length;
        parent.push(id);
        vid.set(k, id);
      }
      return id;
    });
    union(ids[0], ids[1]);
    union(ids[1], ids[2]);
    roots.push(ids[0]);
  }
  const groups = new Map<number, Face[]>();
  fs.forEach((f, i) => {
    const r = find(roots[i]);
    const g = groups.get(r);
    if (g) g.push(f);
    else groups.set(r, [f]);
  });
  return [...groups.values()].map((g) => ({ faces: g, ...bounds(g), mats: new Set(g.map((f) => f.mat)) }));
}

/** Lowest surface above yMin hit by a vertical ray at (x, z), or null. */
function hitAbove(fs: Face[], x: number, z: number, yMin: number): number | null {
  let best: number | null = null;
  for (const f of fs) {
    const [a, b, c] = f.v;
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
    const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
    if (y > yMin && (best === null || y < best)) best = y;
  }
  return best;
}

// ----- measuring -------------------------------------------------------------

export interface Lamp {
  xInner: number;
  xOuter: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  height: number;
  faces: number;
}

export interface Measure {
  length: number;
  width: number;
  height: number;
  groundClearance: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  overhangFront: number;
  overhangRear: number;
  noseHeight: number;
  deckHeight: number;
  roof: number;
  beltLine: number | null;
  windowTop: number | null;
  cabinFront: number | null;
  cabinRear: number | null;
  windshieldDeg: number | null;
  rearGlassDeg: number | null;
  glassPieces: number;
  bPillar: { zMin: number; zMax: number } | null;
  mirrors: number;
  handles: number;
  cowl: boolean;
  indicator: boolean;
  interior: boolean;
  head: Lamp | null;
  tail: Lamp | null;
  archGapFront: number | null;
  archGapRear: number | null;
  tris: number;
}

const deg = (r: number) => (r * 180) / Math.PI;

function lamp(fs: Face[]): Lamp | null {
  if (!fs.length) return null;
  const b = bounds(fs);
  const ax = fs.flatMap((f) => f.v.map((p) => Math.abs(p[0])));
  return { xInner: Math.min(...ax), xOuter: Math.max(...ax), yMin: b.min[1], yMax: b.max[1], zMin: b.min[2], zMax: b.max[2], height: b.max[1] - b.min[1], faces: fs.length };
}

export function measure(fs: Face[], car: ManifestCar): Measure {
  const all = bounds(fs);
  const half = car.wheelbase / 2;
  const side = (f: Face) => Math.abs(f.n[0]) > 0.6;
  const glass = fs.filter((f) => f.mat === 'Glass');
  const sideGlass = glass.filter(side);
  const sg = sideGlass.length ? bounds(sideGlass) : null;
  const belt = sg ? sg.min[1] : null;
  const rake = (g: Face[]) => {
    if (!g.length) return null;
    const b = bounds(g);
    return deg(Math.atan2(b.max[1] - b.min[1], b.max[2] - b.min[2]));
  };
  const nose = fs.filter((f) => f.c[2] > all.max[2] - 0.3 && f.mat !== 'Glass');
  const deck = fs.filter((f) => f.c[2] < all.min[2] + 0.3 && f.mat !== 'Glass');
  const cabinFront = sg ? sg.max[2] : null;
  const cabinRear = sg ? sg.min[2] : null;
  // Windshield and backlight face up and along the car more than sideways (tumblehomed side glass on a real body faces up a lot
  // too); a fastback can lie at 20 degrees, so split them by position, not by normal.
  // Only the central band (|x| < 0.45 m) sets the rake: the window corners of a real body add stray faces.
  const topGlass = glass.filter((f) => f.n[1] > 0.25 && Math.abs(f.n[0]) < Math.abs(f.n[2]) && Math.abs(f.c[0]) < 0.45);
  const cabinMid = sg ? (sg.min[2] + sg.max[2]) / 2 : 0;

  const isl = islands(fs);
  const ext = (i: Island, k: number) => i.max[k] - i.min[k];
  const mirrors = belt === null || cabinFront === null ? 0 : isl.filter((i) => {
    const e = [ext(i, 0), ext(i, 1), ext(i, 2)];
    const cy = (i.min[1] + i.max[1]) / 2;
    const cz = (i.min[2] + i.max[2]) / 2;
    const ox = Math.max(Math.abs(i.min[0]), Math.abs(i.max[0]));
    return e.every((x) => x > 0.04 && x < 0.3) && cy > belt - 0.05 && cy < belt + 0.25 && cz > cabinFront - 0.15 && cz < cabinFront + 0.4 && ox > all.max[0] - 0.12;
  }).length;
  const handles = belt === null ? 0 : isl.filter((i) => {
    const e = [ext(i, 0), ext(i, 1), ext(i, 2)];
    const cy = (i.min[1] + i.max[1]) / 2;
    const ox = Math.max(Math.abs(i.min[0]), Math.abs(i.max[0]));
    return e[0] < 0.05 && e[1] > 0.008 && e[1] < 0.06 && e[2] > 0.06 && e[2] < 0.22 && cy > belt - 0.18 && cy < belt + 0.01 && ox > all.max[0] - 0.2;
  }).length;
  // On the glass band only: the mirror's Black pane sits in the same height band outboard of it, the wiper ends inboard.
  const gx = sideGlass.flatMap((f) => f.v.map((p) => Math.abs(p[0])));
  const [gx0, gx1] = gx.length ? [Math.min(...gx) - 0.02, Math.max(...gx) + 0.02] : [0, 0];
  const bFaces = belt === null || sg === null ? [] : fs.filter((f) => f.mat === 'Black' && side(f) && f.c[1] > belt && f.c[1] < sg.max[1] && f.c[2] > sg.min[2] && f.c[2] < sg.max[2] && Math.abs(f.c[0]) > gx0 && Math.abs(f.c[0]) < gx1);
  const bPillar = bFaces.length ? { zMin: bounds(bFaces).min[2], zMax: bounds(bFaces).max[2] } : null;
  const cowl = belt !== null && cabinFront !== null && fs.some((f) => f.mat === 'Black' && f.n[1] > 0.5 && f.c[2] > cabinFront - 0.02 && f.c[2] < cabinFront + 0.25 && f.c[1] > belt - 0.25 && f.c[1] < belt + 0.05);

  const r = car.wheelRadius;
  const gap = (x: number, z: number) => {
    const hits: number[] = [];
    for (const dx of [-0.1, 0, 0.08]) for (const dz of [-0.05, 0, 0.05]) {
      const h = hitAbove(fs, x + dx, z + dz, r + 0.01);
      if (h !== null) hits.push(h);
    }
    return hits.length ? Math.min(...hits) - 2 * r : null;
  };

  // Width without the mirrors: everything below the belt line.
  const low = bounds(belt === null ? fs : fs.filter((f) => f.c[1] < belt + 0.02));
  return {
    length: all.max[2] - all.min[2],
    width: low.max[0] - low.min[0],
    height: all.max[1],
    groundClearance: all.min[1],
    wheelbase: car.wheelbase,
    trackFront: car.trackFront,
    trackRear: car.trackRear,
    overhangFront: all.max[2] - half,
    overhangRear: -all.min[2] - half,
    noseHeight: nose.length ? bounds(nose).max[1] : 0,
    deckHeight: deck.length ? bounds(deck).max[1] : 0,
    roof: all.max[1],
    beltLine: belt,
    windowTop: sg ? sg.max[1] : null,
    cabinFront,
    cabinRear,
    windshieldDeg: rake(topGlass.filter((f) => f.c[2] > cabinMid)),
    rearGlassDeg: rake(topGlass.filter((f) => f.c[2] < cabinMid)),
    glassPieces: islands(glass).length,
    bPillar,
    mirrors,
    handles,
    cowl,
    indicator: fs.some((f) => f.mat === 'Light'),
    interior: fs.some((f) => f.mat === 'Interior'),
    head: lamp(fs.filter((f) => f.mat === 'HeadLight')),
    tail: lamp(fs.filter((f) => f.mat === 'TailLight')),
    archGapFront: gap(car.trackFront / 2, half),
    archGapRear: gap(car.trackRear / 2, -half),
    tris: fs.length,
  };
}

// ----- targets ---------------------------------------------------------------

export interface Targets {
  length: number;
  width: number;
  height: number;
  overhangFront: number;
  overhangRear: number;
  trackFront: number;
  trackRear: number;
  beltLine: number;
  /** The wheel the donors would have at this wheelbase; the house wheel is fixed, so the ratio says how big the car reads. */
  wheelRadius: number;
  windshieldDeg: number;
  rearGlassDeg: number;
}

/** Blend the donors' ratios to their wheelbase, scale to the car's wheelbase and apply the house stylization. */
export function targets(spec: CarSpec, house: House, wheelbase: number): Targets {
  const total = spec.donors.reduce((s, d) => s + d.weight, 0) || 1;
  const ratio = (key: string) => spec.donors.reduce((s, d) => s + (d.weight / total) * (d.mm[key] / d.mm.wheelbase), 0);
  const avg = (key: string) => spec.donors.reduce((s, d) => s + (d.weight / total) * d.mm[key], 0);
  const at = (key: string, scaleKey: string) => ratio(key) * wheelbase * (house.scale[scaleKey] ?? 1);
  return {
    length: at('length', 'length'),
    width: at('width', 'width'),
    height: at('height', 'height'),
    overhangFront: at('overhangFront', 'overhangFront'),
    overhangRear: at('overhangRear', 'overhangRear'),
    trackFront: at('trackFront', 'track'),
    trackRear: at('trackRear', 'track'),
    beltLine: at('beltLine', 'beltLine'),
    wheelRadius: ratio('tireRadius') * wheelbase,
    windshieldDeg: avg('windshieldDeg'),
    rearGlassDeg: avg('rearGlassDeg'),
  };
}

// ----- checks ----------------------------------------------------------------

export interface Check {
  label: string;
  model: string;
  target: string;
  ok: boolean | null;
  note: string;
}

const m3 = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toFixed(3));
const d1 = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toFixed(1) + '°');

export function checks(m: Measure, t: Targets, spec: CarSpec, house: House): Check[] {
  const out: Check[] = [];
  const tol = house.tolerance;
  const dim = (label: string, model: number | null, target: number, note = '') => {
    if (model === null) return out.push({ label, model: '-', target: m3(target), ok: false, note: note || 'not found' });
    const dev = (model - target) / target;
    out.push({ label, model: m3(model), target: m3(target), ok: Math.abs(dev) <= tol.ratio, note: `${dev >= 0 ? '+' : ''}${(dev * 100).toFixed(1)}%${note ? ' ' + note : ''}` });
  };
  const ang = (label: string, model: number | null, target: number) => {
    if (model === null) return out.push({ label, model: '-', target: d1(target), ok: false, note: 'no glass found' });
    const dev = model - target;
    out.push({ label, model: d1(model), target: d1(target), ok: Math.abs(dev) <= tol.angleDeg, note: `${dev >= 0 ? '+' : ''}${dev.toFixed(1)}°` });
  };
  const info = (label: string, model: string, note = '') => out.push({ label, model, target: '', ok: null, note });
  const feat = (label: string, ok: boolean, model: string, note = '') => out.push({ label, model, target: '', ok, note });

  dim('length', m.length, t.length);
  dim('width', m.width, t.width, 'flares included, mirrors not');
  dim('height', m.height, t.height, 'roof, house chop applied');
  dim('overhang front', m.overhangFront, t.overhangFront);
  dim('overhang rear', m.overhangRear, t.overhangRear);
  dim('track front', m.trackFront, t.trackFront);
  dim('track rear', m.trackRear, t.trackRear);
  dim('belt line', m.beltLine, t.beltLine, 'side glass bottom');
  ang('windshield rake', m.windshieldDeg, t.windshieldDeg);
  ang('rear glass rake', m.rearGlassDeg, t.rearGlassDeg);
  const wr = house.wheelRadius / t.wheelRadius;
  info('wheel radius', m3(house.wheelRadius), `donors at this wheelbase: ${m3(t.wheelRadius)} (car reads ${((1 / wr - 1) * 100).toFixed(0)}% bigger than its wheels)`);
  info('ground clearance', m3(m.groundClearance));
  info('nose / deck height', `${m3(m.noseHeight)} / ${m3(m.deckHeight)}`, 'top of the body in the front / rear 0.3 m');
  info('cabin (side glass)', `z ${m3(m.cabinRear)} .. ${m3(m.cabinFront)}`, `window top ${m3(m.windowTop)}`);

  const [lo, hi] = house.features.lamp.heightRange;
  const lampRow = (label: string, l: Lamp | null, cover: string) => {
    if (!l) return feat(label, false, 'missing');
    // Tall covers (a unit climbing the D pillar) get twice the band, as carFeatures.py builds them.
    const top = TALL_COVERS.includes(cover) ? 2 * hi : hi;
    feat(label, l.height >= lo && l.height <= top, `|x| ${m3(l.xInner)}..${m3(l.xOuter)}, y ${m3(l.yMin)}..${m3(l.yMax)}, z ${m3(l.zMin)}..${m3(l.zMax)}`, `height ${m3(l.height)} (house ${lo}..${top})`);
  };
  lampRow('headlights', m.head, spec.lights.front.cover);
  lampRow('taillights', m.tail, spec.lights.rear.cover);
  feat('indicators (Light)', m.indicator, m.indicator ? 'found' : 'missing');
  feat('glass', m.glassPieces > 0 && m.windshieldDeg !== null && m.rearGlassDeg !== null && m.beltLine !== null, `${m.glassPieces} piece(s)`, 'one band per side plus windshield and rear glass');
  const bw = m.bPillar ? m.bPillar.zMax - m.bPillar.zMin : 0;
  feat('B pillar (Black)', !!m.bPillar && bw >= 0.06 && bw <= 0.2, m.bPillar ? `z ${m3(m.bPillar.zMin)}..${m3(m.bPillar.zMax)} (${m3(bw)} wide)` : 'missing', bw > 0.2 ? `Black spans ${m3(bw)} of the side band: window frames, not a pillar (pillars ${spec.body.pillars.join('')})` : `pillars ${spec.body.pillars.join('')}`);
  feat('mirrors', m.mirrors === 2, `${m.mirrors} found`, 'expect 2 at the A pillar foot');
  feat('door handles', m.handles === spec.body.doors, `${m.handles} found`, `expect ${spec.body.doors}`);
  feat('cowl (Black, under the windshield)', m.cowl, m.cowl ? 'found' : 'missing');
  feat('interior block', m.interior, m.interior ? 'found' : 'missing');
  const [g0, g1] = house.features.arch.gap;
  const gapRow = (label: string, g: number | null) => feat(label, g !== null && g >= g0 && g <= g1, m3(g), `house ${g0}..${g1}; negative means the tire pokes through`);
  gapRow('arch gap front', m.archGapFront);
  gapRow('arch gap rear', m.archGapRear);
  return out;
}

// ----- report ----------------------------------------------------------------

function lampLine(l: LampSpec): string {
  return `${l.cover}${l.elements !== 'none' ? ' + ' + l.elements : ''}${l.indicator !== 'none' ? ', indicator ' + l.indicator : ''}${l.wrap ? ', wraps the corner' : ''}${l.centerBar ? ', center bar' : ''}: ${l.notes}`;
}

export function report(id: string, spec: CarSpec, m: Measure, cs: Check[]): string {
  const lines = [`## ${spec.displayName} (${id})`, '', spec.brief, '', `Donors: ${spec.donors.map((d) => `${d.name} x${d.weight}`).join(', ')}. Wheelbase ${m3(m.wheelbase)} m, ${m.tris} triangles.`, '', '| Check | Model | Target | | Note |', '|---|---|---|---|---|'];
  for (const c of cs) lines.push(`| ${c.label} | ${c.model} | ${c.target} | ${c.ok === null ? '' : c.ok ? 'ok' : '**off**'} | ${c.note} |`);
  lines.push('', `Lamps: front ${lampLine(spec.lights.front)}; rear ${lampLine(spec.lights.rear)}.`, `Body: ${spec.body.doors} doors, pillars ${spec.body.pillars.join(' ')}; ${spec.body.roofline}; exhaust ${spec.body.exhaust}.`, '');
  for (const d of spec.donors) {
    lines.push(`Take from the ${d.name}:`);
    for (const x of d.take) lines.push(`- ${x}`);
    if (d.estimates?.length) lines.push(`  (estimated, a calibrated side photo overrides them: ${d.estimates.join(', ')})`);
    lines.push('');
  }
  const off = cs.filter((c) => c.ok === false).map((c) => c.label);
  lines.push(off.length ? `Off spec: ${off.join(', ')}.` : 'Everything within tolerance.', '');
  return lines.join('\n');
}

export async function audit(ids: string[]): Promise<{ id: string; measure: Measure; targets: Targets; checks: Check[]; text: string }[]> {
  const specs = JSON.parse(readFileSync(join(ROOT, 'scripts/blender/carSpecs.json'), 'utf8')) as Specs;
  const manifest = JSON.parse(readFileSync(join(ROOT, 'src/assets/carManifest.json'), 'utf8')) as { cars: ManifestCar[] };
  const io = await createIO();
  const out = [];
  for (const id of ids.length ? ids : Object.keys(specs.cars)) {
    const spec = specs.cars[id];
    const car = manifest.cars.find((c) => c.id === id);
    if (!spec) throw new Error(`${id}: no entry in scripts/blender/carSpecs.json`);
    if (!car) throw new Error(`${id}: no entry in src/assets/carManifest.json`);
    const doc = await io.read(join(ROOT, 'public', car.file));
    await bakeTransforms(doc);
    const m = measure(faces(doc), car);
    const t = targets(spec, specs.house, car.wheelbase);
    const cs = checks(m, t, spec, specs.house);
    out.push({ id, measure: m, targets: t, checks: cs, text: report(id, spec, m, cs) });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const ids = args.filter((a) => !a.startsWith('--'));
  const results = await audit(ids);
  if (json) console.log(JSON.stringify(results.map((r) => ({ id: r.id, measure: r.measure, targets: r.targets, checks: r.checks })), null, 2));
  else console.log(results.map((r) => r.text).join('\n'));
}

if (process.argv[1] && process.argv[1].endsWith('auditCar.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
