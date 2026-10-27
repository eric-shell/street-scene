/**
 * Roadworks renderer: the plant of every lane closure, built from the area's
 * hints (city/districts/roadworks.ts) over the solids the sim collides with:
 * a trailer mounted arrow board facing the oncoming traffic, its amber lamps
 * flashing an arrow toward the open lane; an excavator digging over steel
 * road plates, a beacon on its cab; a skip full of rubble; a light tower
 * whose floods pool white light over the lot. Cones, barriers, sawhorses,
 * pallets and sandbags are destructible props (render/street/props.ts).
 *
 * The excavator is MD.Jobair Hossain's Sketchfab model (CC BY 4.0), cut to
 * 6k triangles with its colors in the vertices by `npm run plant` into
 * public/plant/plant.glb; it loads once per page (loadExcavator), and every
 * excavator in the city is one instance of it, drawn at the size the sim
 * gave it (the hint's scale). A scene built before it lands shows the
 * excavators when it does. The rest of the plant goes into the shared merged
 * builders (solid, glow, paint); the flashing lamps are one extra mesh with
 * a material blinked on the scene clock, and the light pools one additive
 * mesh (Medium and High only), so all the city's closures cost three draw
 * calls beyond the kit's and nothing per frame but a color. Render only.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Vec2 } from '../../sim/math';
import type { AreaHint } from '../../city/districts/types';
import plantModels from '../../assets/plantModels.json';
import { GeoBuilder } from '../geoBuilder';
import { floatGeometry } from '../gltfGeometry';
import { makeRadialGlow } from '../textures/textures';
import type { DistrictKit, DistrictRenderer } from './kit';
import { col } from './kit';

const LOOK = {
  /** Lamp blink (Hz) of the arrow boards and beacons, and their colour (HDR). */
  blinkHz: 1.1,
  amber: new THREE.Color(1, 0.55, 0.1),
  /** Light tower: mast height (m), flood pool radius (m) and colour; the dim wash of a closure without one. */
  mastH: 6.4,
  poolR: 12,
  pool: new THREE.Color(0xfff0d8).multiplyScalar(0.55),
  washR: 7,
  wash: new THREE.Color(0xffc890).multiplyScalar(0.22),
} as const;

const DARK = col(0x22242a);
const STEEL = col(0x6a6e76);

/** A closure's frame: the center of a piece, its along (downstream) and toward-road unit vectors. */
interface Frame {
  c: Vec2;
  f: Vec2;
  n: Vec2;
}

const frameOf = (h: AreaHint): Frame => ({ c: h.points[0], f: h.points[1], n: h.points[2] });

/** The frame turned by `angle` (rad) about its center, from along toward across. */
function turned(F: Frame, angle: number): Frame {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { c: F.c, f: { x: F.f.x * c + F.n.x * s, z: F.f.z * c + F.n.z * s }, n: { x: F.n.x * c - F.f.x * s, z: F.n.z * c - F.f.z * s } };
}

/** World point of local (a along, c across) in a frame. */
const at = (F: Frame, a: number, c: number): Vec2 => ({ x: F.c.x + F.f.x * a + F.n.x * c, z: F.c.z + F.f.z * a + F.n.z * c });

/** Box over local [a0, a1] x [c0, c1], y0..y1 absolute: four sides and a top. */
function obox(gb: GeoBuilder, F: Frame, a0: number, a1: number, c0: number, c1: number, y0: number, y1: number, color: THREE.Color): void {
  const pts = [at(F, a0, c0), at(F, a1, c0), at(F, a1, c1), at(F, a0, c1)];
  const normals = [
    { x: -F.n.x, z: -F.n.z },
    { x: F.f.x, z: F.f.z },
    { x: F.n.x, z: F.n.z },
    { x: -F.f.x, z: -F.f.z },
  ];
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    const nn = normals[i];
    const a = gb.vertex(p.x, y0, p.z, nn.x, 0, nn.z, 0, 0, color);
    const b = gb.vertex(q.x, y0, q.z, nn.x, 0, nn.z, 0, 0, color);
    const c = gb.vertex(q.x, y1, q.z, nn.x, 0, nn.z, 0, 0, color);
    const d = gb.vertex(p.x, y1, p.z, nn.x, 0, nn.z, 0, 0, color);
    gb.quadFacing(a, b, c, d, nn.x, 0, nn.z);
  }
  const t = pts.map((p) => gb.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, color));
  gb.quadFacing(t[0], t[1], t[2], t[3], 0, 1, 0);
}

/** Lowest ground under a piece's footprint, so nothing floats on a slope. */
function baseY(kit: DistrictKit, F: Frame, ha: number, hc: number): number {
  let y = Infinity;
  for (const [a, c] of [
    [-ha, -hc],
    [ha, -hc],
    [ha, hc],
    [-ha, hc],
  ]) {
    const p = at(F, a, c);
    y = Math.min(y, kit.h(p.x, p.z));
  }
  return y;
}

/** A flat lamp facing `dir` (unit, horizontal) at local (a, c) and height y. */
function lampQuad(gb: GeoBuilder, F: Frame, a: number, c: number, y: number, size: number, dir: Vec2, color: THREE.Color): void {
  const p = at(F, a, c);
  // Across the face: perpendicular to dir in the ground plane.
  const rx = -dir.z * (size / 2);
  const rz = dir.x * (size / 2);
  const ox = dir.x * 0.03;
  const oz = dir.z * 0.03;
  const v = [
    gb.vertex(p.x - rx + ox, y - size / 2, p.z - rz + oz, dir.x, 0, dir.z, 0, 0, color),
    gb.vertex(p.x + rx + ox, y - size / 2, p.z + rz + oz, dir.x, 0, dir.z, 0, 0, color),
    gb.vertex(p.x + rx + ox, y + size / 2, p.z + rz + oz, dir.x, 0, dir.z, 0, 0, color),
    gb.vertex(p.x - rx + ox, y + size / 2, p.z - rz + oz, dir.x, 0, dir.z, 0, 0, color),
  ];
  gb.quadFacing(v[0], v[1], v[2], v[3], dir.x, 0, dir.z);
}

/** A light pool on the ground: a grid draped over the road under (x, z), radius r, textured with the radial glow. */
function pool(kit: DistrictKit, gb: GeoBuilder, x: number, z: number, r: number, color: THREE.Color): void {
  const N = 6;
  const ids: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const px = x + (i / N - 0.5) * 2 * r;
      const pz = z + (j / N - 0.5) * 2 * r;
      ids.push(gb.vertex(px, kit.h(px, pz) + 0.07, pz, 0, 1, 0, i / N, j / N, color));
    }
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) gb.quadFacing(ids[j * (N + 1) + i], ids[j * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i + 1], ids[(j + 1) * (N + 1) + i], 0, 1, 0);
}

/** Arrow board trailer: chassis on two wheels, a mast, the board facing upstream with its lamps in `flash`. */
function arrowBoard(kit: DistrictKit, flash: GeoBuilder, F: Frame, along: number, across: number): void {
  const ha = along / 2;
  const hc = across / 2;
  const y = baseY(kit, F, ha, hc);
  const g = kit.solid;
  obox(g, F, -ha, ha - 0.5, -hc + 0.1, hc - 0.1, y + 0.32, y + 0.62, col(0xf0f0ea));
  obox(g, F, ha - 0.5, ha, -0.06, 0.06, y + 0.4, y + 0.5, DARK);
  for (const c of [-hc + 0.12, hc - 0.12]) obox(g, F, -0.32, 0.32, c - 0.1, c + 0.1, y - 0.05, y + 0.6, DARK);
  obox(g, F, -0.08, 0.08, -0.08, 0.08, y + 0.62, y + 2.25, STEEL);
  // The board: 2 m across the closure, facing the oncoming traffic (-f), black with an amber chevron.
  const bw = Math.min(2.1, across + 0.5) / 2;
  obox(g, F, -0.12, -0.04, -bw, bw, y + 2.15, y + 3.25, col(0x15161a));
  const toward = { x: -F.f.x, z: -F.f.z };
  const yc = y + 2.7;
  // An arrow pointing toward the open road (+c): a shaft and a head of lamps.
  for (let k = -3; k <= 3; k++) lampQuad(flash, F, -0.13, k * 0.16 - 0.05, yc, 0.11, toward, LOOK.amber);
  for (let k = 1; k <= 3; k++) {
    lampQuad(flash, F, -0.13, 0.42 - k * 0.15, yc + k * 0.13, 0.11, toward, LOOK.amber);
    lampQuad(flash, F, -0.13, 0.42 - k * 0.15, yc - k * 0.13, 0.11, toward, LOOK.amber);
  }
}

const base = import.meta.env.BASE_URL ?? '/';
let excavatorGeo: Promise<THREE.BufferGeometry | null> | null = null;

/** The excavator from public/plant/plant.glb, once per page, in plant space (null if it is missing). Kept for the page: every scene shares it. */
function loadExcavator(): Promise<THREE.BufferGeometry | null> {
  excavatorGeo ??= new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync(`${base}plant/plant.glb`)
    .then((g) => {
      g.scene.updateMatrixWorld(true);
      const node = g.scene.getObjectByName('excavator') as THREE.Mesh | undefined;
      if (!node?.isMesh) throw new Error('plant.glb has no excavator');
      return floatGeometry(node.geometry, node.matrixWorld);
    })
    .catch((e) => {
      console.warn('excavator model unavailable', e);
      return null;
    });
  return excavatorGeo;
}

const EXCAVATOR = plantModels.pieces.excavator;

/**
 * Excavator: its instance matrix (plant space: +z toward the dig, the body's footprint centered on
 * the hint) at the hint's scale `k`, and the amber beacon on its cab roof into `flash`.
 */
function excavator(kit: DistrictKit, flash: GeoBuilder, F: Frame, along: number, across: number, k: number): THREE.Matrix4 {
  const y = baseY(kit, F, along / 2, across / 2);
  // Plant +x is up x +z: (f.z, -f.x), toward the road or the curb by the side of the street (sim's sx).
  const x = new THREE.Vector3(F.f.z, 0, -F.f.x);
  const m = new THREE.Matrix4().makeBasis(x, new THREE.Vector3(0, 1, 0), new THREE.Vector3(F.f.x, 0, F.f.z));
  m.scale(new THREE.Vector3(k, k, k)).setPosition(F.c.x, y, F.c.z);
  const sx = F.f.z * F.n.x - F.f.x * F.n.z;
  const [bx, by, bz] = EXCAVATOR.beacon;
  lampQuad(flash, F, bz * k, sx * bx * k, y + by * k + 0.08, 0.14, F.f, LOOK.amber);
  lampQuad(flash, F, bz * k, sx * bx * k, y + by * k + 0.08, 0.14, { x: -F.f.x, z: -F.f.z }, LOOK.amber);
  return m;
}

/** Skip: a steel bin with sloped ends, rubble heaped inside. */
function skip(kit: DistrictKit, F: Frame, along: number, across: number, tint: THREE.Color): void {
  const ha = along / 2;
  const hc = across / 2;
  const y = baseY(kit, F, ha, hc);
  const g = kit.solid;
  obox(g, F, -ha + 0.5, ha - 0.5, -hc, hc, y - 0.05, y + 0.25, tint);
  obox(g, F, -ha + 0.2, ha - 0.2, -hc, hc, y + 0.25, y + 0.95, tint);
  obox(g, F, -ha, ha, -hc, hc, y + 0.95, y + 1.3, tint);
  const rubble = [0x6a6660, 0x8a7a68, 0x55524c, 0x9a958c, 0x4a3a2a];
  for (let k = 0; k < 7; k++) {
    const a = -ha + 0.45 + ((ha * 2 - 0.9) * (k + 0.5)) / 7;
    const c = ((k * 37) % 7) / 7 - 0.5;
    const s = 0.25 + ((k * 53) % 5) * 0.05;
    obox(g, F, a - s, a + s, c * (across - 0.6) - s, c * (across - 0.6) + s, y + 1.0, y + 1.3 + s * 0.8, col(rubble[k % rubble.length]));
  }
}

/** Light tower: a trailer with outriggers, a mast and a bar of four floods aimed down at the lot. */
function lightTower(kit: DistrictKit, pools: GeoBuilder | null, F: Frame, along: number, across: number): void {
  const ha = along / 2;
  const hc = across / 2;
  const y = baseY(kit, F, ha, hc);
  const g = kit.solid;
  obox(g, F, -ha, ha, -hc + 0.05, hc - 0.05, y + 0.3, y + 0.95, col(0xe8e4d8));
  for (const c of [-hc, hc]) obox(g, F, -0.25, 0.25, c - 0.1, c + 0.1, y - 0.05, y + 0.6, DARK);
  for (const a of [-ha + 0.15, ha - 0.15]) obox(g, F, a - 0.06, a + 0.06, -hc - 0.05, hc + 0.05, y - 0.05, y + 0.3, STEEL);
  obox(g, F, -0.07, 0.07, -0.07, 0.07, y + 0.95, y + LOOK.mastH, STEEL);
  obox(g, F, -0.06, 0.06, -0.8, 0.8, y + LOOK.mastH - 0.1, y + LOOK.mastH, STEEL);
  for (const c of [-0.6, -0.2, 0.2, 0.6]) {
    obox(g, F, -0.18, 0.18, c - 0.17, c + 0.17, y + LOOK.mastH - 0.42, y + LOOK.mastH - 0.1, DARK);
    obox(kit.glow, F, -0.15, 0.15, c - 0.14, c + 0.14, y + LOOK.mastH - 0.45, y + LOOK.mastH - 0.42, col(0xfff4e0, 3.2));
  }
  if (pools) pool(kit, pools, F.c.x + F.n.x * 2, F.c.z + F.n.z * 2, LOOK.poolR, LOOK.pool);
}

/** A steel road plate over the dig, bolted flush (2 cm proud of the road). */
function plate(kit: DistrictKit, F: Frame, along: number, across: number, skew: number): void {
  const P = turned(F, skew);
  const y = baseY(kit, P, along / 2, across / 2);
  obox(kit.paint, P, -along / 2, along / 2, -across / 2, across / 2, y, y + 0.025, col(0x4a4c52));
  obox(kit.paint, P, -along / 2 + 0.1, along / 2 - 0.1, -across / 2 + 0.1, across / 2 - 0.1, y + 0.025, y + 0.028, col(0x5c5f66));
}

/** A quad over local [a0, a1] x [c0, c1] draped on the terrain at `lift` (m), facing up. */
function drapedQuad(kit: DistrictKit, gb: GeoBuilder, F: Frame, a0: number, a1: number, c0: number, c1: number, lift: number, color: THREE.Color): void {
  const v = [at(F, a0, c0), at(F, a1, c0), at(F, a1, c1), at(F, a0, c1)].map((p) => gb.vertex(p.x, kit.h(p.x, p.z) + lift, p.z, 0, 1, 0, 0, 0, color));
  gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
}

/** A cylinder whose axis runs across the frame (local c from c0 to c1), centred at local `a`, height `cy` (absolute), radius r. */
function drum(gb: GeoBuilder, F: Frame, a: number, cy: number, c0: number, c1: number, r: number, color: THREE.Color, N = 12): void {
  const ring = (c: number, cap: number) => {
    const ids: number[] = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const ca = Math.cos(th);
      const sa = Math.sin(th);
      const p = at(F, a + ca * r, c);
      ids.push(cap ? gb.vertex(p.x, cy + sa * r, p.z, F.n.x * cap, 0, F.n.z * cap, 0, 0, color) : gb.vertex(p.x, cy + sa * r, p.z, F.f.x * ca, sa, F.f.z * ca, 0, 0, color));
    }
    return ids;
  };
  const s0 = ring(c0, 0);
  const s1 = ring(c1, 0);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const th = ((i + 0.5) / N) * Math.PI * 2;
    gb.quadFacing(s0[i], s0[j], s1[j], s1[i], F.f.x * Math.cos(th), Math.sin(th), F.f.z * Math.cos(th));
  }
  for (const [c, sign] of [[c0, -1], [c1, 1]] as const) {
    const cap = ring(c, sign);
    for (let i = 1; i + 1 < N; i++) gb.triFacing(cap[0], cap[i], cap[i + 1], F.n.x * sign, 0, F.n.z * sign);
  }
}

/** Open trench: a near black strip under a raised earth rim; the plates and the shoring box sit on it. */
function trench(kit: DistrictKit, F: Frame, along: number, across: number): void {
  const ha = along / 2;
  const hc = across / 2;
  const n = Math.max(1, Math.round(along / 4));
  for (let i = 0; i < n; i++) drapedQuad(kit, kit.paint, F, -ha + (along * i) / n, -ha + (along * (i + 1)) / n, -hc, hc, 0.012, col(0x07080a));
  const y = baseY(kit, F, ha, hc);
  // Earth rims 12 cm wide along both edges, 4 cm proud.
  obox(kit.paint, F, -ha, ha, -hc - 0.12, -hc, y, y + 0.04, col(0x5a4a38));
  obox(kit.paint, F, -ha, ha, hc, hc + 0.12, y, y + 0.04, col(0x5a4a38));
}

/** A spoil heap: two stacked tapered boxes of earth, `h` tall. */
function spoil(kit: DistrictKit, F: Frame, along: number, across: number, h: number): void {
  const y = baseY(kit, F, along / 2, across / 2);
  const g = kit.solid;
  const earth = [col(0x5a4632), col(0x6b5640)];
  const tier = (i: number, ia: number, ic: number, y0: number, y1: number) => {
    const ha = along / 2 - ia;
    const hc = across / 2 - ic;
    const ta = ha * 0.55;
    const tc = hc * 0.55;
    const color = earth[i];
    const bot = [at(F, -ha, -hc), at(F, ha, -hc), at(F, ha, hc), at(F, -ha, hc)];
    const top = [at(F, -ta, -tc), at(F, ta, -tc), at(F, ta, tc), at(F, -ta, tc)];
    const nrm = [[-F.n.x, -F.n.z], [F.f.x, F.f.z], [F.n.x, F.n.z], [-F.f.x, -F.f.z]];
    for (let k = 0; k < 4; k++) {
      const q = (k + 1) % 4;
      const nx = nrm[k][0] * 0.8;
      const nz = nrm[k][1] * 0.8;
      const a = g.vertex(bot[k].x, y0, bot[k].z, nx, 0.6, nz, 0, 0, color);
      const b = g.vertex(bot[q].x, y0, bot[q].z, nx, 0.6, nz, 0, 0, color);
      const c = g.vertex(top[q].x, y1, top[q].z, nx, 0.6, nz, 0, 0, color);
      const d = g.vertex(top[k].x, y1, top[k].z, nx, 0.6, nz, 0, 0, color);
      g.quadFacing(a, b, c, d, nx, 0.6, nz);
    }
    const t = top.map((p) => g.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, color));
    g.quadFacing(t[0], t[1], t[2], t[3], 0, 1, 0);
  };
  tier(0, 0, 0, y - 0.02, y + h * 0.7);
  tier(1, along * 0.2, across * 0.15, y + h * 0.5, y + h);
}

/** Steel shoring box lowered in the trench: two side panels stood proud of the ground and the struts across. */
function trenchBox(kit: DistrictKit, F: Frame, along: number, across: number): void {
  const ha = along / 2;
  const hc = across / 2;
  const y = baseY(kit, F, ha, hc);
  const steel = col(0x6a7078);
  const yellow = col(0xd0a020);
  for (const s of [-1, 1]) obox(kit.solid, F, -ha, ha, s * (hc - 0.07) - 0.07, s * (hc - 0.07) + 0.07, y, y + 0.38, steel);
  for (const a of [-ha + 0.25, 0, ha - 0.25]) obox(kit.solid, F, a - 0.05, a + 0.05, -hc + 0.1, hc - 0.1, y + 0.22, y + 0.3, yellow);
  for (const a of [-ha + 0.05, ha - 0.05]) for (const s of [-1, 1]) obox(kit.solid, F, a - 0.04, a + 0.04, s * (hc - 0.07) - 0.04, s * (hc - 0.07) + 0.04, y + 0.38, y + 0.62, DARK);
}

/** Trash pump on a skid: engine block, impeller housing, exhaust stack and a hazard beacon. */
function pump(kit: DistrictKit, F: Frame, along: number, across: number): void {
  const ha = along / 2;
  const hc = across / 2;
  const y = baseY(kit, F, ha, hc);
  const g = kit.solid;
  obox(g, F, -ha, ha, -hc, hc, y + 0.02, y + 0.12, DARK);
  obox(g, F, -ha + 0.05, 0.1, -hc + 0.08, hc - 0.08, y + 0.12, y + 0.6, col(0xe0a020));
  obox(g, F, 0.1, ha - 0.05, -hc + 0.12, hc - 0.12, y + 0.12, y + 0.46, col(0x2f6aa0));
  obox(g, F, ha - 0.02, ha + 0.1, -0.07, 0.07, y + 0.22, y + 0.3, STEEL);
  obox(g, F, -ha + 0.15, -ha + 0.23, hc - 0.2, hc - 0.12, y + 0.6, y + 1.0, STEEL);
  obox(kit.hazard, F, -0.05, 0.05, -0.05, 0.05, y + 0.6, y + 0.7, LOOK.amber);
}

/** A lay flat discharge hose along the curb strip, snaking a little. */
function hose(kit: DistrictKit, F: Frame, along: number, across: number): void {
  const n = Math.max(2, Math.round(along / 0.9));
  const y = baseY(kit, F, along / 2, 0.3);
  for (let i = 0; i < n; i++) {
    const a0 = -along / 2 + (along * i) / n;
    const a1 = a0 + along / n;
    const w0 = Math.sin(i * 1.9) * 0.1;
    const w1 = Math.sin((i + 1) * 1.9) * 0.1;
    const ang = Math.atan2(w1 - w0, a1 - a0);
    const P = turned({ c: at(F, (a0 + a1) / 2, (w0 + w1) / 2), f: F.f, n: F.n }, ang);
    const len = Math.hypot(a1 - a0, w1 - w0);
    obox(kit.paint, P, -len / 2 - 0.02, len / 2 + 0.02, -across / 2, across / 2, y, y + 0.07, col(0x1c3550));
  }
}

/** The lane after the planer: coarse milled grooves over the oncoming `millLen` m, fresh black asphalt beyond. */
function milled(kit: DistrictKit, F: Frame, along: number, across: number, millLen: number): void {
  const hc = across / 2;
  const a0 = -along / 2;
  const cells = Math.max(1, Math.round(along / 3));
  for (let i = 0; i < cells; i++) {
    const s0 = a0 + (along * i) / cells;
    const s1 = a0 + (along * (i + 1)) / cells;
    const mid = (s0 + s1) / 2 - a0;
    drapedQuad(kit, kit.paint, F, s0, s1, -hc, hc, 0.012, mid < millLen ? col(0x2a2826) : col(0x0b0b0d));
  }
  for (let a = a0 + 0.4; a + 0.3 < a0 + millLen; a += 0.8) drapedQuad(kit, kit.paint, F, a, a + 0.3, -hc, hc, 0.02, col(0x3c3935));
}

/** Road roller: two drums under a yoke, engine hood, an open cab with a roof and an amber beacon. */
function roller(kit: DistrictKit, F: Frame, along: number, across: number): void {
  const ha = along / 2;
  const hc = across / 2;
  const y = baseY(kit, F, ha, hc);
  const g = kit.solid;
  const paint = col(0xe8b020);
  const steel = col(0x8a8e96);
  const r = 0.55;
  // Front drum and the rear one in two halves (a split drum).
  drum(g, F, ha - 0.8, y + r, -hc + 0.15, hc - 0.15, r, steel, 14);
  drum(g, F, -ha + 0.8, y + r, -hc + 0.05, -0.02, r, steel, 14);
  drum(g, F, -ha + 0.8, y + r, 0.02, hc - 0.05, r, steel, 14);
  // Yoke arms, chassis, hood, water tank.
  for (const s of [-1, 1]) obox(g, F, ha - 0.95, ha - 0.65, s * (hc - 0.1) - 0.05, s * (hc - 0.1) + 0.05, y + 0.35, y + 0.95, DARK);
  obox(g, F, -ha + 0.5, ha - 0.9, -hc + 0.2, hc - 0.2, y + 0.78, y + 1.0, paint);
  obox(g, F, ha - 1.9, ha - 0.95, -hc + 0.35, hc - 0.35, y + 1.0, y + 1.5, paint);
  obox(g, F, ha - 1.85, ha - 1.7, -0.08, 0.08, y + 1.5, y + 1.8, DARK);
  obox(g, F, -ha + 0.5, -ha + 1.3, -hc + 0.3, hc - 0.3, y + 1.0, y + 1.35, col(0xd0d4d8));
  // Cab: seat, wheel, four posts and a roof with the beacon.
  obox(g, F, -0.5, -0.1, -0.2, 0.2, y + 1.0, y + 1.25, DARK);
  obox(g, F, 0.05, 0.12, -0.04, 0.04, y + 1.0, y + 1.5, DARK);
  for (const a of [-0.6, 0.55]) for (const s of [-0.6, 0.6]) obox(g, F, a - 0.03, a + 0.03, s - 0.03, s + 0.03, y + 1.0, y + 2.4, DARK);
  obox(g, F, -0.7, 0.7, -0.75, 0.75, y + 2.4, y + 2.48, paint);
  obox(kit.hazard, F, -0.07, 0.07, -0.07, 0.07, y + 2.48, y + 2.62, LOOK.amber);
}

/** 3x5 glyphs of "FRESHTA" (rows top to bottom, 1 = lit). */
const GLYPH: Record<string, string[]> = {
  F: ['111', '100', '110', '100', '100'],
  R: ['110', '101', '110', '101', '101'],
  E: ['111', '100', '110', '100', '111'],
  S: ['011', '100', '010', '001', '110'],
  H: ['101', '101', '111', '101', '101'],
  T: ['111', '010', '010', '010', '010'],
  A: ['010', '101', '111', '101', '101'],
};

/** FRESH TAR board on two legs, its lettering in amber glow facing the oncoming traffic. */
function tarBoard(kit: DistrictKit, F: Frame, along: number, across: number): void {
  const y = baseY(kit, F, along / 2, across / 2);
  const g = kit.solid;
  const bw = Math.min(across, 2.0) / 2 - 0.05;
  for (const s of [-1, 1]) obox(g, F, -0.05, 0.05, s * (bw - 0.1) - 0.04, s * (bw - 0.1) + 0.04, y, y + 1.0, STEEL);
  obox(g, F, -0.06, 0.06, -bw, bw, y + 0.8, y + 1.95, col(0x15161a));
  // The viewer looks along +f; their right is (-f.z, f.x); u grows rightward, mapped to local c.
  const sgn = F.f.x * F.n.z - F.f.z * F.n.x;
  const toward = { x: -F.f.x, z: -F.f.z };
  const px = 0.082;
  const word = (text: string, yTop: number) => {
    let u0 = -((text.length * 4 - 1) * px) / 2;
    for (const ch of text) {
      GLYPH[ch].forEach((row, ry) => {
        for (let rx = 0; rx < 3; rx++) if (row[rx] === '1') lampQuad(kit.glow, F, -0.07, sgn * (u0 + (rx + 0.5) * px), yTop - (ry + 0.5) * px, px * 0.9, toward, col(0xffb020, 1.6));
      });
      u0 += 4 * px;
    }
  };
  word('FRESH', y + 1.88);
  word('TAR', y + 1.35);
}

export const roadworksRenderer: DistrictRenderer = {
  kinds: ['roadworks'],
  build(kit, areas) {
    const flash = new GeoBuilder(true);
    const pools = kit.quality === 'low' ? null : new GeoBuilder(true);
    const excavators: THREE.Matrix4[] = [];
    for (const a of areas) {
      const hints = kit.builds[a.id]?.hints ?? [];
      let lit = false;
      for (const h of hints) {
        if (h.kind === 'roadworks' || h.points.length < 3) continue;
        const F = frameOf(h);
        const [along, across, extra] = h.values;
        if (h.kind === 'arrowBoard') arrowBoard(kit, flash, F, along, across);
        else if (h.kind === 'excavator') excavators.push(excavator(kit, flash, F, along, across, extra));
        else if (h.kind === 'skip') skip(kit, F, along, across, col([0xf2b81c, 0xe06a1a, 0x2a7a4a, 0x2050a0][a.id % 4]));
        else if (h.kind === 'lightTower') {
          lightTower(kit, pools, F, along, across);
          lit = true;
        } else if (h.kind === 'plate') plate(kit, F, along, across, extra);
        else if (h.kind === 'trench') trench(kit, F, along, across);
        else if (h.kind === 'trenchBox') trenchBox(kit, F, along, across);
        else if (h.kind === 'spoil') spoil(kit, F, along, across, extra);
        else if (h.kind === 'pump') pump(kit, F, along, across);
        else if (h.kind === 'hose') hose(kit, F, along, across);
        else if (h.kind === 'milled') milled(kit, F, along, across, extra);
        else if (h.kind === 'roller') roller(kit, F, along, across);
        else if (h.kind === 'tarBoard') tarBoard(kit, F, along, across);
      }
      // A closure without a tower still glows a little from its lamps.
      if (!lit && pools && a.polygon.length) {
        let x = 0;
        let z = 0;
        for (const p of a.polygon) {
          x += p.x / a.polygon.length;
          z += p.z / a.polygon.length;
        }
        pool(kit, pools, x, z, LOOK.washR, LOOK.wash);
      }
    }
    if (excavators.length) {
      // An empty stand-in until the shared model lands (its own, disposed with the scene; the model is the page's).
      const mesh = new THREE.InstancedMesh(kit.track(new THREE.BufferGeometry()), kit.track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.5 })), excavators.length);
      mesh.name = 'roadworksExcavators';
      excavators.forEach((m, i) => mesh.setMatrixAt(i, m));
      kit.group.add(mesh);
      void loadExcavator().then((geo) => {
        if (!geo) return;
        mesh.geometry = geo;
        mesh.computeBoundingSphere();
      });
    }
    if (flash.vertexCount) {
      const mat = kit.track(new THREE.MeshBasicMaterial({ vertexColors: true }));
      const mesh = new THREE.Mesh(kit.track(flash.build()), mat);
      mesh.name = 'roadworksLamps';
      kit.group.add(mesh);
      // Soft edged blink (a hard square wave strobes the bloom), the same on every closure.
      kit.animate((time) => {
        const k = 0.15 + 2.6 * THREE.MathUtils.smoothstep(Math.sin(time * Math.PI * 2 * LOOK.blinkHz), -0.3, 0.3);
        mat.color.setScalar(k);
      });
    }
    if (pools?.vertexCount) {
      const map = kit.track(makeRadialGlow());
      const mat = kit.track(new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      const mesh = new THREE.Mesh(kit.track(pools.build()), mat);
      mesh.name = 'roadworksLightPools';
      mesh.renderOrder = 1;
      kit.group.add(mesh);
    }
  },
};
