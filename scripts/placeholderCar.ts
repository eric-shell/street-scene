/**
 * Procedural "Proto RS" placeholder car and parts, authored exactly like a
 * real car would be (car space, shared material names, one GLB per part) so
 * the whole parts pipeline works before any artist assets exist.
 */
import { Accessor, Buffer, Document, Material, Primitive } from '@gltf-transform/core';
import { addNode, material, newDoc } from './gltfUtil';

type V3 = [number, number, number];

/** A box with optional top taper (shrinks the top face in x and z for a less boxy look). */
function box(doc: Document, buffer: Buffer, mat: Material, c: V3, s: V3, taper: [number, number] = [0, 0]): Primitive {
  const [cx, cy, cz] = c;
  const [hx, hy, hz] = s.map((v) => v / 2);
  const tx = hx * (1 - taper[0]);
  const tz = hz * (1 - taper[1]);
  const b = [
    [cx - hx, cy - hy, cz - hz],
    [cx + hx, cy - hy, cz - hz],
    [cx + hx, cy - hy, cz + hz],
    [cx - hx, cy - hy, cz + hz],
    [cx - tx, cy + hy, cz - tz],
    [cx + tx, cy + hy, cz - tz],
    [cx + tx, cy + hy, cz + tz],
    [cx - tx, cy + hy, cz + tz],
  ];
  const faces = [
    [0, 1, 2, 3], // bottom
    [7, 6, 5, 4], // top
    [3, 2, 6, 7], // front +z
    [1, 0, 4, 5], // back -z
    [2, 1, 5, 6], // right? +x
    [0, 3, 7, 4], // -x
  ];
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (const f of faces) {
    const p = f.map((i) => b[i]);
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((x) => x / l);
    // make sure the normal points away from the box center
    const mid = [(p[0][0] + p[2][0]) / 2 - cx, (p[0][1] + p[2][1]) / 2 - cy, (p[0][2] + p[2][2]) / 2 - cz];
    const flip = n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0;
    const base = pos.length / 3;
    for (const q of p) {
      pos.push(...q);
      nor.push(...(flip ? n.map((x) => -x) : n));
    }
    if (flip) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(nor)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(mat);
  return prim;
}

/** Cylinder along X (wheel axle), centered at origin. */
function cylinderX(doc: Document, buffer: Buffer, mat: Material, r: number, w: number, x0: number, seg: number, open = false): Primitive {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const y = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    pos.push(x0 - w / 2, y, z, x0 + w / 2, y, z);
    nor.push(0, Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a));
    if (i < seg) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  if (!open) {
    for (const side of [1, -1]) {
      const c = pos.length / 3;
      pos.push(x0 + (side * w) / 2, 0, 0);
      nor.push(side, 0, 0);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        pos.push(x0 + (side * w) / 2, Math.cos(a) * r, Math.sin(a) * r);
        nor.push(side, 0, 0);
        if (i < seg) side > 0 ? idx.push(c, c + 1 + i, c + 2 + i) : idx.push(c, c + 2 + i, c + 1 + i);
      }
    }
  }
  return doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute('NORMAL', doc.createAccessor().setType(Accessor.Type.VEC3).setArray(new Float32Array(nor)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType(Accessor.Type.SCALAR).setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(mat);
}

const L = 4.36;
const W = 1.82;
const R = 0.33;
const SILL = 0.24;
const BODY_H = 0.5;
const WB = 1.32;

function single(name: string, prims: (d: Document, b: Buffer, m: (n: string) => Material) => Primitive[]): Document {
  const { doc, buffer } = newDoc();
  const cache = new Map<string, Material>();
  const mesh = doc.createMesh(name);
  for (const p of prims(doc, buffer, (n) => material(doc, n, cache))) mesh.addPrimitive(p);
  addNode(doc, name, mesh);
  return doc;
}

export function protoBase(): Document {
  const { doc, buffer } = newDoc();
  const cache = new Map<string, Material>();
  const m = (n: string) => material(doc, n, cache);
  const part = (name: string, prims: Primitive[]) => {
    const mesh = doc.createMesh(name);
    prims.forEach((p) => mesh.addPrimitive(p));
    addNode(doc, name, mesh);
  };
  const top = SILL + BODY_H;
  // Main shell minus the ends (bumpers are separate nodes so parts can replace them).
  part('Body', [
    box(doc, buffer, m('Paint'), [0, SILL + BODY_H / 2, -0.05], [W, BODY_H, L - 0.62], [0.02, 0]),
    // wheel arch flares
    ...[1, -1].flatMap((s) => [WB, -WB].map((z) => box(doc, buffer, m('Paint'), [s * (W / 2 - 0.02), SILL + 0.42, z], [0.08, 0.16, 0.9], [0, 0.25]))),
    box(doc, buffer, m('Black'), [0, SILL - 0.04, 0], [W - 0.2, 0.08, L - 0.9]),
  ]);
  part('Cabin', [
    box(doc, buffer, m('Glass'), [0, top + 0.21, -0.25], [W - 0.22, 0.42, 1.9], [0.12, 0.38]),
    box(doc, buffer, m('Paint'), [0, top + 0.43, -0.35], [W - 0.42, 0.04, 1.1]),
    box(doc, buffer, m('Interior'), [0, top + 0.05, -0.25], [W - 0.3, 0.1, 1.7]),
  ]);
  part('Hood', [box(doc, buffer, m('Paint'), [0, top + 0.02, 1.25], [W - 0.12, 0.05, 1.2], [0.04, 0])]);
  part('Bumper_Front', [
    box(doc, buffer, m('Paint'), [0, SILL + 0.2, L / 2 - 0.2], [W, 0.42, 0.4], [0.03, 0.2]),
    box(doc, buffer, m('Black'), [0, SILL + 0.16, L / 2 - 0.005], [W * 0.5, 0.12, 0.03]),
    box(doc, buffer, m('HeadLight'), [W * 0.33, SILL + 0.36, L / 2 - 0.08], [0.38, 0.09, 0.05]),
    box(doc, buffer, m('HeadLight'), [-W * 0.33, SILL + 0.36, L / 2 - 0.08], [0.38, 0.09, 0.05]),
  ]);
  part('Bumper_Rear', [
    box(doc, buffer, m('Paint'), [0, SILL + 0.22, -L / 2 + 0.2], [W, 0.46, 0.4], [0.03, 0.15]),
    box(doc, buffer, m('TailLight'), [W * 0.32, SILL + 0.4, -L / 2 + 0.03], [0.45, 0.1, 0.05]),
    box(doc, buffer, m('TailLight'), [-W * 0.32, SILL + 0.4, -L / 2 + 0.03], [0.45, 0.1, 0.05]),
    box(doc, buffer, m('Chrome'), [0.45, SILL + 0.02, -L / 2 + 0.05], [0.12, 0.08, 0.1]),
  ]);
  part('Skirts_Stock', [1, -1].map((s) => box(doc, buffer, m('Trim'), [s * (W / 2 - 0.01), SILL + 0.05, 0], [0.06, 0.12, 1.6])));
  part('Mirrors', [1, -1].map((s) => box(doc, buffer, m('Paint'), [s * (W / 2 + 0.06), top + 0.12, 0.45], [0.14, 0.08, 0.14])));
  return doc;
}

export interface ProtoPart {
  id: string;
  name: string;
  slot: 'frontBumper' | 'rearBumper' | 'sideSkirts' | 'spoiler' | 'hood' | 'wheels';
  hides: string[];
  doc: Document;
}

export function protoParts(): ProtoPart[] {
  const top = SILL + BODY_H;
  const parts: ProtoPart[] = [];
  parts.push({
    id: 'proto_frontBumper_street',
    name: 'Street splitter',
    slot: 'frontBumper',
    hides: ['Bumper_Front'],
    doc: single('FrontBumper_Street', (d, b, m) => [
      box(d, b, m('Paint'), [0, SILL + 0.19, L / 2 - 0.18], [W + 0.02, 0.44, 0.44], [0.05, 0.3]),
      box(d, b, m('Black'), [0, SILL - 0.06, L / 2 - 0.05], [W - 0.1, 0.03, 0.34]),
      box(d, b, m('Black'), [0, SILL + 0.12, L / 2 + 0.03], [W * 0.62, 0.16, 0.03]),
      box(d, b, m('HeadLight'), [W * 0.33, SILL + 0.36, L / 2 - 0.08], [0.38, 0.09, 0.05]),
      box(d, b, m('HeadLight'), [-W * 0.33, SILL + 0.36, L / 2 - 0.08], [0.38, 0.09, 0.05]),
    ]),
  });
  parts.push({
    id: 'proto_frontBumper_widemouth',
    name: 'Wide mouth',
    slot: 'frontBumper',
    hides: ['Bumper_Front'],
    doc: single('FrontBumper_Widemouth', (d, b, m) => [
      box(d, b, m('Paint'), [0, SILL + 0.3, L / 2 - 0.2], [W + 0.04, 0.24, 0.42], [0.04, 0.2]),
      box(d, b, m('Paint'), [0, SILL + 0.02, L / 2 - 0.18], [W + 0.04, 0.12, 0.48], [0, 0.1]),
      box(d, b, m('Black'), [0, SILL + 0.13, L / 2 - 0.03], [W * 0.85, 0.16, 0.06]),
      box(d, b, m('Light'), [W * 0.4, SILL + 0.06, L / 2 + 0.03], [0.16, 0.05, 0.03]),
      box(d, b, m('Light'), [-W * 0.4, SILL + 0.06, L / 2 + 0.03], [0.16, 0.05, 0.03]),
      box(d, b, m('HeadLight'), [W * 0.33, SILL + 0.36, L / 2 - 0.08], [0.38, 0.09, 0.05]),
      box(d, b, m('HeadLight'), [-W * 0.33, SILL + 0.36, L / 2 - 0.08], [0.38, 0.09, 0.05]),
    ]),
  });
  parts.push({
    id: 'proto_rearBumper_diffuser',
    name: 'Diffuser',
    slot: 'rearBumper',
    hides: ['Bumper_Rear'],
    doc: single('RearBumper_Diffuser', (d, b, m) => [
      box(d, b, m('Paint'), [0, SILL + 0.25, -L / 2 + 0.2], [W + 0.02, 0.42, 0.42], [0.04, 0.2]),
      box(d, b, m('Black'), [0, SILL - 0.02, -L / 2 + 0.12], [W * 0.8, 0.1, 0.36]),
      ...[-0.5, -0.17, 0.17, 0.5].map((x) => box(d, b, m('Black'), [x, SILL + 0.02, -L / 2 + 0.02], [0.02, 0.16, 0.3])),
      box(d, b, m('TailLight'), [W * 0.32, SILL + 0.4, -L / 2 + 0.03], [0.45, 0.1, 0.05]),
      box(d, b, m('TailLight'), [-W * 0.32, SILL + 0.4, -L / 2 + 0.03], [0.45, 0.1, 0.05]),
      box(d, b, m('Chrome'), [0.3, SILL + 0.06, -L / 2 - 0.02], [0.16, 0.16, 0.12]),
      box(d, b, m('Chrome'), [-0.3, SILL + 0.06, -L / 2 - 0.02], [0.16, 0.16, 0.12]),
    ]),
  });
  parts.push({
    id: 'proto_rearBumper_track',
    name: 'Track tow hook',
    slot: 'rearBumper',
    hides: ['Bumper_Rear'],
    doc: single('RearBumper_Track', (d, b, m) => [
      box(d, b, m('Paint'), [0, SILL + 0.26, -L / 2 + 0.22], [W + 0.06, 0.44, 0.46], [0.06, 0.25]),
      box(d, b, m('Black'), [0, SILL + 0.02, -L / 2 + 0.1], [W - 0.1, 0.06, 0.3]),
      box(d, b, m('Light'), [0.6, SILL + 0.1, -L / 2 - 0.01], [0.1, 0.06, 0.06]),
      box(d, b, m('TailLight'), [W * 0.32, SILL + 0.4, -L / 2 + 0.03], [0.45, 0.1, 0.05]),
      box(d, b, m('TailLight'), [-W * 0.32, SILL + 0.4, -L / 2 + 0.03], [0.45, 0.1, 0.05]),
      box(d, b, m('Chrome'), [0, SILL + 0.04, -L / 2 - 0.03], [0.2, 0.14, 0.12]),
    ]),
  });
  parts.push({
    id: 'proto_sideSkirts_aero',
    name: 'Aero skirts',
    slot: 'sideSkirts',
    hides: ['Skirts_Stock'],
    doc: single('SideSkirts_Aero', (d, b, m) => [1, -1].map((s) => box(d, b, m('Paint'), [s * (W / 2 + 0.02), SILL + 0.02, 0], [0.12, 0.2, 1.75], [0.3, 0.05]))),
  });
  parts.push({
    id: 'proto_hood_vented',
    name: 'Vented hood',
    slot: 'hood',
    hides: ['Hood'],
    doc: single('Hood_Vented', (d, b, m) => [
      box(d, b, m('Paint'), [0, top + 0.03, 1.25], [W - 0.12, 0.06, 1.2], [0.04, 0]),
      box(d, b, m('Black'), [0.32, top + 0.065, 1.3], [0.3, 0.02, 0.4]),
      box(d, b, m('Black'), [-0.32, top + 0.065, 1.3], [0.3, 0.02, 0.4]),
      box(d, b, m('Paint'), [0, top + 0.1, 1.15], [0.5, 0.1, 0.5], [0.3, 0.3]),
    ]),
  });
  parts.push({
    id: 'proto_spoiler_ducktail',
    name: 'Ducktail',
    slot: 'spoiler',
    hides: [],
    doc: single('Spoiler_Ducktail', (d, b, m) => [box(d, b, m('Paint'), [0, top + 0.06, -L / 2 + 0.38], [W - 0.2, 0.1, 0.36], [0.05, 0.4])]),
  });
  parts.push({
    id: 'proto_spoiler_gtwing',
    name: 'GT wing',
    slot: 'spoiler',
    hides: [],
    doc: single('Spoiler_GTWing', (d, b, m) => [
      box(d, b, m('Paint'), [0, top + 0.38, -L / 2 + 0.3], [W - 0.06, 0.04, 0.36], [0, 0.2]),
      box(d, b, m('Black'), [W / 2 - 0.05, top + 0.36, -L / 2 + 0.3], [0.02, 0.18, 0.42]),
      box(d, b, m('Black'), [-W / 2 + 0.05, top + 0.36, -L / 2 + 0.3], [0.02, 0.18, 0.42]),
      box(d, b, m('Black'), [0.45, top + 0.18, -L / 2 + 0.34], [0.04, 0.36, 0.1]),
      box(d, b, m('Black'), [-0.45, top + 0.18, -L / 2 + 0.34], [0.04, 0.36, 0.1]),
    ]),
  });
  // Universal wheels, in wheel space (center at origin, axle along X, outer face +X).
  const wheel = (id: string, name: string, spokes: number, dish: number): ProtoPart => ({
    id,
    name,
    slot: 'wheels',
    hides: [],
    doc: single(name.replace(/\s/g, ''), (d, b, m) => [
      cylinderX(d, b, m('Tire'), R, 0.24, 0, 28, false),
      cylinderX(d, b, m('Rim'), R * 0.7, 0.03, 0.115 - dish, 24, false),
      cylinderX(d, b, m('Black'), R * 0.69, 0.2, 0, 18, true),
      ...Array.from({ length: spokes }, (_, i) => {
        const a = (i / spokes) * Math.PI;
        const p = box(d, b, m('Rim'), [0.12 - dish / 2, 0, 0], [0.03, R * 1.36, 0.05]);
        // rotate the spoke about X by baking positions
        const pos = p.getAttribute('POSITION')!;
        const nor = p.getAttribute('NORMAL')!;
        for (let k = 0; k < pos.getCount(); k++) {
          const v = pos.getElement(k, [0, 0, 0]);
          pos.setElement(k, [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)]);
          const n = nor.getElement(k, [0, 0, 0]);
          nor.setElement(k, [n[0], n[1] * Math.cos(a) - n[2] * Math.sin(a), n[1] * Math.sin(a) + n[2] * Math.cos(a)]);
        }
        return p;
      }),
      cylinderX(d, b, m('Chrome'), R * 0.14, 0.05, 0.12, 12, false),
    ]),
  });
  parts.push(wheel('wheel_proto_5spoke', 'Proto 5 spoke', 5, 0));
  parts.push(wheel('wheel_proto_deepdish', 'Proto deep dish', 8, 0.06));
  return parts;
}
