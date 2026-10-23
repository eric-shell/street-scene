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
