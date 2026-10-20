/**
 * Turns the pure city description into three.js meshes: roads with markings,
 * curbs and sidewalks, the buildings (regional architecture, buildings.ts),
 * streetlight lamp positions, neon signs and the start line. Built once per
 * world; read only.
 */
import * as THREE from 'three';
import { CITY } from '../city/config';
import { World } from '../city/world';
import { Vec2 } from '../sim/math';
import { GeoBuilder } from './geoBuilder';
import { buildFinishLines, FinishLines } from './finishLine';
import { STREETLIGHT_ARM, STREETLIGHT_POLE_H } from './props';
import { createPodiumOutput, makeFacadeKitTextures } from './facadeKit';
import { buildBuildings, Detail } from './buildings';
import {
  NEON_COLORS,
  SIGN_ATLAS_COLS,
  SIGN_ATLAS_ROWS,
  SIGN_NAMES,
  makeAsphalt,
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
  /** Start / finish gantries: call update(time) per frame and burst() on the player's finish. */
  finishLine: FinishLines;
  /** Animated building windows and aviation lights (s). */
  update(time: number): void;
  dispose(): void;
}

export interface CityMeshOptions {
  /** Architectural detail tier (fire escapes, clutter, animated windows); default medium. */
  detail?: Detail;
}

const ROAD_Y = 0.02;
const MARK_Y = 0.045;

export function buildCityMeshes(world: World, opts: CityMeshOptions = {}): CityMeshes {
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
    // Lowest height around each vertex, so the coarse ground never pokes through
    // dips finer than its grid (the river channel, ramps).
    const r = size / 96;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let y = h(x, z);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) y = Math.min(y, h(x + dx * r * 0.5, z + dz * r * 0.5));
      pos.setY(i, y - 0.4);
    }
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
  // A strip between two polylines (each given as start/end points), subdivided along its length
  // (every 6 m; back alleys every 1 m so road and sidewalk follow their kicker humps).
  const strip = (gb: GeoBuilder, l0: Vec2, l1: Vec2, r0: Vec2, r1: Vec2, liftL: number, liftR: number, uvScale: number, step = 6) => {
    const len = Math.max(Math.hypot(l1.x - l0.x, l1.z - l0.z), Math.hypot(r1.x - r0.x, r1.z - r0.z));
    const steps = Math.max(1, Math.ceil(len / step));
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
  const stepOf = (ei: number) => (g.edges[ei].kind === 'backAlley' ? 1 : 6);
  g.edges.forEach((_, ei) => {
    const m = mouths[ei];
    strip(road, m.aP.curb, m.bP.curb, m.aN.curb, m.bN.curb, ROAD_Y, ROAD_Y, 10, stepOf(ei));
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
    strip(walk, m.aP.curb, m.bP.curb, m.aP.outer, m.bP.outer, curbH, curbH, 4, stepOf(ei));
    strip(walk, m.aN.curb, m.bN.curb, m.aN.outer, m.bN.outer, curbH, curbH, 4, stepOf(ei));
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
  // Regional architecture (architecture.ts plans the styles, buildings.ts builds them) over facade kit podiums.
  const neon = NEON_COLORS.map((c) => new THREE.Color(c));
  const podium = createPodiumOutput();
  const buildings = buildBuildings(world, podium, { detail: opts.detail ?? 'medium' });
  disposables.push(buildings);
  for (const m of buildings.meshes) group.add(m);
  {
    const kit = makeFacadeKitTextures(world.seed);
    const podiumMat = track(
      new THREE.MeshStandardMaterial({ map: track(kit.map), emissiveMap: track(kit.emissive), emissive: 0xffffff, emissiveIntensity: 1.05, vertexColors: true, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.7 }),
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

  // ---------- Streetlights ----------
  // Poles and lenses are destructible props (props.ts); only the lamp heads are kept here.
  const lampPositions: THREE.Vector3[] = [];
  for (const l of world.blocks.streetlights) {
    const y = h(l.x, l.z) + curbH;
    lampPositions.push(new THREE.Vector3(l.x + l.dx * STREETLIGHT_ARM, y + STREETLIGHT_POLE_H - 0.4, l.z + l.dz * STREETLIGHT_ARM));
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

  // ---------- Hazard lamp material ----------
  // Closures are cyan rail pieces now (routeArrows.ts); this blinking amber (animated by the scene) is
  // shared by the beacons on their posts and the hazards of the parked meet cars.
  const barrierLampMaterial = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa020).multiplyScalar(3) }));

  // ---------- Start / finish line ----------
  // Gantries, painted line and celebration effects live in finishLine.ts.
  const finishLine = buildFinishLines(world);
  disposables.push(finishLine);
  group.add(finishLine.group);

  return {
    group,
    lampPositions,
    signLights,
    barrierLampMaterial,
    finishLine,
    update(time) {
      buildings.update(time);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
