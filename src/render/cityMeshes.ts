/**
 * Turns the pure city description into three.js meshes: roads with markings,
 * curbs and sidewalks, buildings with procedural windows, streetlights, neon
 * signs, barriers and the start line. Built once per world; read only.
 */
import * as THREE from 'three';
import { CITY } from '../city/config';
import { World } from '../city/world';
import { Building } from '../city/blocks';
import { routeSample } from '../city/route';
import { Vec2 } from '../sim/math';
import { Rng } from '../sim/prng';
import { GeoBuilder } from './geoBuilder';
import { addPodiumFace, createPodiumOutput, makeFacadeKitTextures, podiumExtrusions, podiumFloors, podiumHeight } from './facadeKit';
import { corridorClearance } from '../city/blocks';
import {
  NEON_COLORS,
  SIGN_ATLAS_COLS,
  SIGN_ATLAS_ROWS,
  SIGN_NAMES,
  WINDOW_COLS,
  WINDOW_ROWS,
  makeAsphalt,
  makeBarrierTexture,
  makeCheckerTexture,
  makeFacade,
  makeSidewalk,
  makeSignAtlas,
} from './textures';

export interface CityMeshes {
  group: THREE.Group;
  /** World space lamp head positions, for the dynamic light pool and light fx. */
  lampPositions: THREE.Vector3[];
  /** Neon sign centers with their colors, for reflections. */
  signLights: { pos: THREE.Vector3; color: THREE.Color }[];
  barrierLampMaterial: THREE.MeshBasicMaterial;
  dispose(): void;
}

const ROAD_Y = 0.02;
const MARK_Y = 0.045;

export function buildCityMeshes(world: World, barrierWalls?: Set<unknown>): CityMeshes {
  const group = new THREE.Group();
  group.name = 'city';
  const h = world.heightAt;
  const slope = world.slopeAt;
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const normalAt = (x: number, z: number): [number, number, number] => {
    const s = slope(x, z);
    const l = Math.hypot(s.gx, 1, s.gz);
    return [-s.gx / l, 1 / l, -s.gz / l];
  };

  // ---------- Ground ----------
  {
    const b = world.graph.bounds;
    const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 900;
    const geo = new THREE.PlaneGeometry(size, size, 96, 96);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)) - 0.4);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(track(geo), track(new THREE.MeshStandardMaterial({ color: 0x0c0d12, roughness: 0.95 })));
    mesh.name = 'ground';
    group.add(mesh);
  }

  // ---------- Roads ----------
  const asphalt = makeAsphalt(world.seed);
  const roadMat = track(
    new THREE.MeshStandardMaterial({
      map: track(asphalt.map),
      roughnessMap: track(asphalt.roughness),
      roughness: 1,
      metalness: 0.0,
      color: 0x9a9eaa,
      envMapIntensity: 1.6,
    }),
  );
  const road = new GeoBuilder();
  const addGroundVertex = (gb: GeoBuilder, x: number, z: number, lift: number, uvScale: number) => {
    const [nx, ny, nz] = normalAt(x, z);
    return gb.vertex(x, h(x, z) + lift, z, nx, ny, nz, x / uvScale, z / uvScale);
  };
  const g = world.graph;
  const { sectors, mouths } = world.blocks;
  g.nodes.forEach((n, ni) => {
    const ring: Vec2[] = [];
    for (const s of sectors[ni]) for (const p of s.curb) ring.push(p);
    const c = addGroundVertex(road, n.x, n.z, ROAD_Y, 10);
    const ids = ring.map((p) => addGroundVertex(road, p.x, p.z, ROAD_Y, 10));
    for (let i = 0; i < ids.length; i++) road.triFacing(c, ids[i], ids[(i + 1) % ids.length], 0, 1, 0);
  });
  // A strip between two polylines (each given as start/end points), subdivided along its length.
  const strip = (gb: GeoBuilder, l0: Vec2, l1: Vec2, r0: Vec2, r1: Vec2, liftL: number, liftR: number, uvScale: number) => {
    const len = Math.max(Math.hypot(l1.x - l0.x, l1.z - l0.z), Math.hypot(r1.x - r0.x, r1.z - r0.z));
    const steps = Math.max(1, Math.ceil(len / 6));
    let prevL = -1;
    let prevR = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lx = l0.x + (l1.x - l0.x) * t;
      const lz = l0.z + (l1.z - l0.z) * t;
      const rx = r0.x + (r1.x - r0.x) * t;
      const rz = r0.z + (r1.z - r0.z) * t;
      const vl = addGroundVertex(gb, lx, lz, liftL, uvScale);
      const vr = addGroundVertex(gb, rx, rz, liftR, uvScale);
      if (i > 0) gb.quadFacing(prevL, prevR, vr, vl, 0, 1, 0);
      prevL = vl;
      prevR = vr;
    }
  };
  g.edges.forEach((_, ei) => {
    const m = mouths[ei];
    strip(road, m.aP.curb, m.bP.curb, m.aN.curb, m.bN.curb, ROAD_Y, ROAD_Y, 10);
  });
  const roadMesh = new THREE.Mesh(track(road.build()), roadMat);
  roadMesh.name = 'roads';
  group.add(roadMesh);

  // ---------- Lane markings and crosswalks ----------
  const marks = new GeoBuilder(true);
  const white = new THREE.Color(0xd8dce6);
  const yellow = new THREE.Color(0xf2b632);
  const addLine = (a: Vec2, b: Vec2, offset: number, width: number, dash: number, gap: number, color: THREE.Color) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1) return;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    const nx = -dz;
    const nz = dx;
    const period = dash + gap;
    for (let s = gap > 0 ? gap / 2 : 0; s < len; s += gap > 0 ? period : 6) {
      const e = Math.min(len, s + (gap > 0 ? dash : 6));
      const p0 = { x: a.x + dx * s + nx * offset, z: a.z + dz * s + nz * offset };
      const p1 = { x: a.x + dx * e + nx * offset, z: a.z + dz * e + nz * offset };
      const hw = width / 2;
      const v = [
        [p0.x + nx * hw, p0.z + nz * hw],
        [p1.x + nx * hw, p1.z + nz * hw],
        [p1.x - nx * hw, p1.z - nz * hw],
        [p0.x - nx * hw, p0.z - nz * hw],
      ].map(([x, z]) => {
        const [qx, qy, qz] = normalAt(x, z);
        return marks.vertex(x, h(x, z) + MARK_Y, z, qx, qy, qz, 0, 0, color);
      });
      marks.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
  };
  g.edges.forEach((e, ei) => {
    const m = mouths[ei];
    const a = { x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 };
    const b = { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 8) return;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    // keep markings clear of the crosswalks
    const a2 = { x: a.x + dx * 5, z: a.z + dz * 5 };
    const b2 = { x: b.x - dx * 5, z: b.z - dz * 5 };
    const half = e.width / 2;
    if (e.lanes === 2) {
      addLine(a2, b2, 0, 0.16, 3, 5, white);
    } else {
      addLine(a2, b2, 0.18, 0.14, 0, 0, yellow);
      addLine(a2, b2, -0.18, 0.14, 0, 0, yellow);
      addLine(a2, b2, half / 2, 0.14, 3, 6, white);
      addLine(a2, b2, -half / 2, 0.14, 3, 6, white);
    }
    addLine(a2, b2, half - 0.45, 0.14, 0, 0, white);
    addLine(a2, b2, -(half - 0.45), 0.14, 0, 0, white);
    // crosswalk stripes near each end
    for (const [from, dir] of [
      [a, 1],
      [b, -1],
    ] as [Vec2, number][]) {
      for (let o = -half + 0.8; o < half - 0.6; o += 1.1) {
        const p0 = { x: from.x + dx * dir * 1.2, z: from.z + dz * dir * 1.2 };
        const p1 = { x: from.x + dx * dir * 4.2, z: from.z + dz * dir * 4.2 };
        addLine(dir > 0 ? p0 : p1, dir > 0 ? p1 : p0, o, 0.55, 0, 0, white);
      }
    }
  });
  const markMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x15161a }));
  const markMesh = new THREE.Mesh(track(marks.build()), markMat);
  markMesh.name = 'markings';
  group.add(markMesh);

  // ---------- Sidewalks and curbs ----------
  const walk = new GeoBuilder();
  const curbH = CITY.curbHeight;
  const curbFace = (p: Vec2, q: Vec2) => {
    const yp = h(p.x, p.z);
    const yq = h(q.x, q.z);
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    // normal faces away from the sidewalk; caller passes points so either side works
    const nx = dz / l;
    const nz = -dx / l;
    const v0 = walk.vertex(p.x, yp + ROAD_Y, p.z, nx, 0, nz, 0, 0);
    const v1 = walk.vertex(q.x, yq + ROAD_Y, q.z, nx, 0, nz, l / 4, 0);
    const v2 = walk.vertex(q.x, yq + curbH, q.z, nx, 0, nz, l / 4, 0.05);
    const v3 = walk.vertex(p.x, yp + curbH, p.z, nx, 0, nz, 0, 0.05);
    walk.quad(v0, v1, v2, v3);
    walk.quad(v0, v3, v2, v1); // both windings: curbs are seen from the road only, cheap enough
  };
  g.edges.forEach((_, ei) => {
    const m = mouths[ei];
    strip(walk, m.aP.curb, m.bP.curb, m.aP.outer, m.bP.outer, curbH, curbH, 4);
    strip(walk, m.aN.curb, m.bN.curb, m.aN.outer, m.bN.outer, curbH, curbH, 4);
    curbFace(m.aP.curb, m.bP.curb);
    curbFace(m.aN.curb, m.bN.curb);
  });
  g.nodes.forEach((_, ni) => {
    for (const s of sectors[ni]) {
      for (let i = 0; i + 1 < s.curb.length; i++) {
        strip(walk, s.curb[i], s.curb[i + 1], s.outer[i], s.outer[i + 1], curbH, curbH, 4);
        curbFace(s.curb[i], s.curb[i + 1]);
      }
    }
  });
  const walkMat = track(new THREE.MeshStandardMaterial({ map: track(makeSidewalk()), roughness: 0.75, color: 0x9da0ad, envMapIntensity: 0.4 }));
  const walkMesh = new THREE.Mesh(track(walk.build()), walkMat);
  walkMesh.name = 'sidewalks';
  group.add(walkMesh);

  // ---------- Buildings ----------
  const facade = makeFacade(world.seed);
  const walls = new GeoBuilder(true);
  const roofs = new GeoBuilder(true);
  const trims = new GeoBuilder(true);
  const rng = new Rng(world.seed ^ 0xb1d);
  const facadeTints = [0x4a4f5e, 0x564c44, 0x3e4858, 0x5c6270, 0x4a4252, 0x36404c].map((c) => new THREE.Color(c));
  const neon = NEON_COLORS.map((c) => new THREE.Color(c));
  const podium = createPodiumOutput();
  const scratch: number[] = [];
  const addBuilding = (b: Building) => {
    const ux = Math.cos(b.yaw);
    const uz = -Math.sin(b.yaw);
    const wx = Math.sin(b.yaw);
    const wz = Math.cos(b.yaw);
    const hw = b.w / 2;
    const hd = b.d / 2;
    const corner = (su: number, sw: number): Vec2 => ({ x: b.x + ux * hw * su + wx * hd * sw, z: b.z + uz * hw * su + wz * hd * sw });
    const cs = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    const y1 = b.baseY + b.h;
    // Street level podium (2-4 floors) gets the facade kit; the tower starts above it.
    const street = b.baseY + 0.6;
    const floors = podiumFloors(rng, b.h - 0.6);
    const y0 = street + podiumHeight(floors);
    const ext = podiumExtrusions(rng, floors);
    const tint = facadeTints[b.style % facadeTints.length].clone().multiplyScalar(rng.range(0.7, 1.1));
    const offU = rng.int(0, WINDOW_COLS - 1) / WINDOW_COLS;
    const offV = rng.int(0, WINDOW_ROWS - 1) / WINDOW_ROWS;
    const floorsV = 1 / WINDOW_ROWS / 3.2;
    const colsU = 1 / WINDOW_COLS / 2.1;
    let uAcc = 0;
    for (let i = 0; i < 4; i++) {
      const p = cs[i];
      const q = cs[(i + 1) % 4];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const mx = (p.x + q.x) / 2 - b.x;
      const mz = (p.z + q.z) / 2 - b.z;
      const ml = Math.hypot(mx, mz) || 1;
      const nx = mx / ml;
      const nz = mz / ml;
      // Faces that look onto a street get storefronts; the rest get plain masonry.
      const front = corridorClearance(g, world.blocks.edgeGrid, (p.x + q.x) / 2 + nx * 1.5, (p.z + q.z) / 2 + nz * 1.5, scratch) < 2;
      addPodiumFace(podium, { ax: p.x, az: p.z, bx: q.x, bz: q.z, nx, nz, y0: street, yBase: b.baseY, front }, floors, rng, ext);
      if (y1 - y0 < 0.5) continue;
      const u0 = offU + uAcc * colsU;
      const u1 = offU + (uAcc + len) * colsU;
      uAcc += Math.round(len / 2.1) * 2.1 + 2.1;
      const v0 = offV;
      const v1 = offV + (y1 - y0) * floorsV;
      const a = walls.vertex(p.x, y0, p.z, nx, 0, nz, u0, v0, tint);
      const bb = walls.vertex(q.x, y0, q.z, nx, 0, nz, u1, v0, tint);
      const c = walls.vertex(q.x, y1, q.z, nx, 0, nz, u1, v1, tint);
      const d = walls.vertex(p.x, y1, p.z, nx, 0, nz, u0, v1, tint);
      walls.quadFacing(a, bb, c, d, nx, 0, nz);
    }
    const roofTint = new THREE.Color(0x15161c).multiplyScalar(rng.range(0.8, 1.4));
    const r = cs.map((p) => roofs.vertex(p.x, y1, p.z, 0, 1, 0, 0, 0, roofTint));
    roofs.quadFacing(r[0], r[1], r[2], r[3], 0, 1, 0);
    // neon roof trim on some buildings
    if (rng.chance(0.16) || (b.h > 50 && rng.chance(0.5))) {
      const col = neon[rng.int(0, neon.length - 1)];
      const ty0 = y1 - 0.5;
      for (let i = 0; i < 4; i++) {
        const p = cs[i];
        const q = cs[(i + 1) % 4];
        const mx = (p.x + q.x) / 2 - b.x;
        const mz = (p.z + q.z) / 2 - b.z;
        const ml = Math.hypot(mx, mz) || 1;
        const nx = mx / ml;
        const nz = mz / ml;
        const o = 0.06;
        const a = trims.vertex(p.x + nx * o, ty0, p.z + nz * o, nx, 0, nz, 0, 0, col);
        const bb = trims.vertex(q.x + nx * o, ty0, q.z + nz * o, nx, 0, nz, 0, 0, col);
        const c = trims.vertex(q.x + nx * o, y1, q.z + nz * o, nx, 0, nz, 0, 0, col);
        const d = trims.vertex(p.x + nx * o, y1, p.z + nz * o, nx, 0, nz, 0, 0, col);
        trims.quadFacing(a, bb, c, d, nx, 0, nz);
      }
    }
  };
  world.blocks.buildings.forEach(addBuilding);
  const buildingMat = track(
    new THREE.MeshStandardMaterial({
      map: track(facade.map),
      emissiveMap: track(facade.emissive),
      emissive: 0xffffff,
      emissiveIntensity: 1.1,
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.1,
      envMapIntensity: 0.6,
    }),
  );
  const bMesh = new THREE.Mesh(track(walls.build()), buildingMat);
  bMesh.name = 'buildings';
  group.add(bMesh);
  {
    const kit = makeFacadeKitTextures(world.seed);
    const podiumMat = track(
      new THREE.MeshStandardMaterial({ map: track(kit.map), emissiveMap: track(kit.emissive), emissive: 0xffffff, emissiveIntensity: 1.05, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.7 }),
    );
    const pm = new THREE.Mesh(track(podium.walls.build()), podiumMat);
    pm.name = 'podiums';
    group.add(pm);
    const tm = new THREE.Mesh(track(podium.trim.build()), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 })));
    tm.name = 'podiumTrim';
    group.add(tm);
    if (podium.awnings.vertexCount) {
      const am = new THREE.Mesh(track(podium.awnings.build()), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide })));
      am.name = 'awnings';
      group.add(am);
    }
    if (podium.spill.vertexCount) {
      const sm = new THREE.Mesh(
        track(podium.spill.build()),
        track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })),
      );
      sm.name = 'lightSpill';
      sm.renderOrder = 1;
      group.add(sm);
    }
  }
  const roofMesh = new THREE.Mesh(track(roofs.build()), track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })));
  roofMesh.name = 'roofs';
  group.add(roofMesh);
  if (trims.vertexCount > 0) {
    const trimMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
    trimMat.color.setScalar(1.5);
    const tm = new THREE.Mesh(track(trims.build()), trimMat);
    tm.name = 'roofNeon';
    group.add(tm);
  }

  // ---------- Streetlights ----------
  const lampPositions: THREE.Vector3[] = [];
  {
    const lights = world.blocks.streetlights;
    const poleH = 8.2;
    const arm = 2.4;
    const pole = new THREE.CylinderGeometry(0.09, 0.13, poleH, 6);
    pole.translate(0, poleH / 2, 0);
    const armGeo = new THREE.BoxGeometry(0.1, 0.1, arm);
    armGeo.translate(0, poleH - 0.1, arm / 2);
    const head = new THREE.BoxGeometry(0.45, 0.16, 0.9);
    head.translate(0, poleH - 0.25, arm);
    const lens = new THREE.BoxGeometry(0.36, 0.04, 0.75);
    lens.translate(0, poleH - 0.34, arm);
    const poleGeo = track(mergeGeometries([pole, armGeo, head]));
    const poleMesh = new THREE.InstancedMesh(poleGeo, track(new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.6, metalness: 0.5 })), lights.length);
    const lensMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc27a).multiplyScalar(4) }));
    const lensMesh = new THREE.InstancedMesh(track(lens), lensMat, lights.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    lights.forEach((l, i) => {
      const y = h(l.x, l.z) + curbH;
      q.setFromAxisAngle(up, Math.atan2(l.dx, l.dz));
      m.compose(new THREE.Vector3(l.x, y, l.z), q, new THREE.Vector3(1, 1, 1));
      poleMesh.setMatrixAt(i, m);
      lensMesh.setMatrixAt(i, m);
      lampPositions.push(new THREE.Vector3(l.x + l.dx * arm, y + poleH - 0.4, l.z + l.dz * arm));
    });
    poleMesh.name = 'streetlightPoles';
    lensMesh.name = 'streetlightLenses';
    group.add(poleMesh, lensMesh);
    [pole, armGeo, head].forEach((x) => x.dispose());
  }

  // ---------- Neon signs ----------
  const signLights: { pos: THREE.Vector3; color: THREE.Color }[] = [];
  {
    const sb = new GeoBuilder(true);
    const cellW = 1 / SIGN_ATLAS_COLS;
    const cellH = 1 / SIGN_ATLAS_ROWS;
    for (const s of world.blocks.signs) {
      const idx = s.nameIndex % SIGN_NAMES.length;
      const col = neon[s.colorIndex % neon.length];
      const u0 = (idx % SIGN_ATLAS_COLS) * cellW;
      const v1 = 1 - Math.floor(idx / SIGN_ATLAS_COLS) * cellH;
      const v0 = v1 - cellH;
      const u1 = u0 + cellW;
      // along-face axis
      const ax = -s.nz;
      const az = s.nx;
      if (!s.blade) {
        const hw = s.w / 2;
        const hh = s.h / 2;
        const p = (sa: number, sy: number, u: number, v: number) => sb.vertex(s.x + ax * hw * sa, s.y + hh * sy, s.z + az * hw * sa, s.nx, 0, s.nz, u, v, col);
        // text reads left to right when looking at the face
        const a = p(1, -1, u0, v0);
        const b = p(-1, -1, u1, v0);
        const c = p(-1, 1, u1, v1);
        const d = p(1, 1, u0, v1);
        sb.quadFacing(a, b, c, d, s.nx, 0, s.nz);
      } else {
        // blade sticks out from the wall, text runs vertically
        const out = s.w + 0.15;
        const hh = s.h / 2;
        const bx = s.x;
        const bz = s.z;
        const p = (o: number, sy: number, u: number, v: number, side: number) =>
          sb.vertex(bx + s.nx * o, s.y + hh * sy, bz + s.nz * o, ax * side, 0, az * side, u, v, col);
        for (const side of [1, -1]) {
          const a = p(0.15, -1, side > 0 ? u0 : u1, v1, side);
          const b = p(out, -1, side > 0 ? u0 : u1, v0, side);
          const c = p(out, 1, side > 0 ? u1 : u0, v0, side);
          const d = p(0.15, 1, side > 0 ? u1 : u0, v1, side);
          sb.quadFacing(a, b, c, d, ax * side, 0, az * side);
        }
      }
      signLights.push({ pos: new THREE.Vector3(s.x + s.nx * (s.blade ? s.w / 2 : 0.3), s.y, s.z + s.nz * (s.blade ? s.w / 2 : 0.3)), color: col.clone() });
    }
    const signMat = track(new THREE.MeshBasicMaterial({ map: track(makeSignAtlas()), vertexColors: true }));
    signMat.color.setScalar(2.6);
    const signMesh = new THREE.Mesh(track(sb.build()), signMat);
    signMesh.name = 'signs';
    group.add(signMesh);
  }

  // ---------- Barriers on closed side streets ----------
  const barrierLampMaterial = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa020).multiplyScalar(3) }));
  {
    const bb = new GeoBuilder();
    const lamps = new GeoBuilder();
    const H = 1.15;
    const T = 0.35;
    for (const w of world.walls) {
      if (w.kind !== 'barrier' || (barrierWalls && !barrierWalls.has(w))) continue;
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const dx = (w.bx - w.ax) / len;
      const dz = (w.bz - w.az) / len;
      const y = Math.min(h(w.ax, w.az), h(w.bx, w.bz));
      const box = (ox: number, oz: number, x0: number, x1: number, y0: number, y1: number, t: number, gb: GeoBuilder, uLen: number) => {
        // oriented box from along-offset x0..x1, centered at (ox, oz)
        const pts = [
          [x0, -t],
          [x1, -t],
          [x1, t],
          [x0, t],
        ].map(([a, b]) => ({ x: ox + dx * a + w.nx * b, z: oz + dz * a + w.nz * b }));
        for (let i = 0; i < 4; i++) {
          const p = pts[i];
          const q = pts[(i + 1) % 4];
          const mx = (p.x + q.x) / 2 - ox - dx * (x0 + x1) / 2;
          const mz = (p.z + q.z) / 2 - oz - dz * (x0 + x1) / 2;
          const ml = Math.hypot(mx, mz) || 1;
          const nx = mx / ml;
          const nz = mz / ml;
          const sideLen = Math.hypot(q.x - p.x, q.z - p.z);
          const a = gb.vertex(p.x, y0, p.z, nx, 0, nz, 0, 0);
          const b2 = gb.vertex(q.x, y0, q.z, nx, 0, nz, sideLen / uLen, 0);
          const c = gb.vertex(q.x, y1, q.z, nx, 0, nz, sideLen / uLen, 1);
          const d = gb.vertex(p.x, y1, p.z, nx, 0, nz, 0, 1);
          gb.quadFacing(a, b2, c, d, nx, 0, nz);
        }
        const t0 = gb.vertex(pts[0].x, y1, pts[0].z, 0, 1, 0, 0, 0);
        const t1 = gb.vertex(pts[1].x, y1, pts[1].z, 0, 1, 0, 0, 0);
        const t2 = gb.vertex(pts[2].x, y1, pts[2].z, 0, 1, 0, 0, 0);
        const t3 = gb.vertex(pts[3].x, y1, pts[3].z, 0, 1, 0, 0, 0);
        gb.quadFacing(t0, t1, t2, t3, 0, 1, 0);
      };
      box(w.ax, w.az, 0, len, y + 0.25, y + H, T / 2, bb, 2.2);
      // legs
      for (let s = 0.4; s < len; s += 3) box(w.ax, w.az, s, s + 0.15, y, y + 0.3, T / 2, bb, 2.2);
      for (let s = 1; s < len - 0.5; s += 2.5) box(w.ax, w.az, s, s + 0.25, y + H, y + H + 0.2, 0.12, lamps, 1);
    }
    if (bb.vertexCount) {
      const m = new THREE.Mesh(
        track(bb.build()),
        track(new THREE.MeshStandardMaterial({ map: track(makeBarrierTexture()), roughness: 0.5, emissive: 0x332200, emissiveIntensity: 0.5 })),
      );
      m.name = 'barriers';
      group.add(m);
      const lm = new THREE.Mesh(track(lamps.build()), barrierLampMaterial);
      lm.name = 'barrierLamps';
      group.add(lm);
    }
  }

  // ---------- Start / finish line ----------
  {
    const route = world.route;
    const lines = route.closed ? [route.startS] : [route.startS, route.finishS];
    const gb = new GeoBuilder();
    for (const s0 of lines) {
      const p = routeSample(route, s0);
      const half = route.segWidth[p.seg] / 2;
      const lx = p.tz;
      const lz = -p.tx;
      const v: number[] = [];
      for (const [along, lat, u, vv] of [
        [-0.9, half, 0, 0],
        [0.9, half, 0, 1],
        [0.9, -half, half / 1.5, 1],
        [-0.9, -half, half / 1.5, 0],
      ]) {
        const x = p.x + p.tx * along + lx * lat;
        const z = p.z + p.tz * along + lz * lat;
        v.push(gb.vertex(x, h(x, z) + MARK_Y + 0.005, z, 0, 1, 0, u, vv));
      }
      gb.quadFacing(v[0], v[1], v[2], v[3], 0, 1, 0);
    }
    const m = new THREE.Mesh(track(gb.build()), track(new THREE.MeshStandardMaterial({ map: track(makeCheckerTexture()), roughness: 0.5 })));
    m.name = 'startLine';
    group.add(m);
  }

  return {
    group,
    lampPositions,
    signLights,
    barrierLampMaterial,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/** Minimal non-indexed merge for static prop parts sharing one material. */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = parts.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
