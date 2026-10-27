/**
 * Turns the pure city description into three.js meshes: roads with markings
 * (alleys cobbled and unmarked), curbs and sidewalks (stepping back at bus
 * bays and opening at park paths' mouths, busBays.ts), the buildings (regional
 * architecture, buildings.ts), streetlight lamp positions, neon signs and the
 * start line. Built once per world; read only.
 */
import * as THREE from 'three';
import { CITY } from '../../city/config';
import { World } from '../../city/world';
import { isBendNode, isRiverEdge } from '../../city/roadGraph';
import { groundHeight } from '../../city/districts/carPark';
import { Vec2 } from '../../sim/math';
import { GeoBuilder } from '../geoBuilder';
import { OCCLUSION, bakeOcclusion, occlusionFor, occlusionMaterial } from './bakedOcclusion';
import { buildFinishLines, FinishLines } from '../race/finishLine';
import { STREETLIGHT_ARM, STREETLIGHT_POLE_H } from './props';
import { createPodiumOutput, makeFacadeKitTextures } from '../buildings/facadeKit';
import type { ShopFront } from '../people/idleSpots';
import { buildBuildings, Detail } from '../buildings/buildings';
import { neonMood } from '../textures/cityMood';
import { FlickList, SIGNAGE, applyFlicker, buildSignageMeshes, planSignage, setSignageTime } from './signage';
import { ridgeLift } from '../districts/structureShapes';
import { baysByEdge, sideBays } from '../../city/busBays';
import { BAY_DASH, BayDraw, bayMouth, drawBayAsphalt, drawBayPaint, drawBaySidewalk } from './busBays';
import {
  NEON_COLORS,
  SIGN_ATLAS_COLS,
  SIGN_ATLAS_ROWS,
  SIGN_SLOTS,
  COBBLE_TILE,
  makeAsphalt,
  makeCobble,
  makeSidewalk,
  makeSignAtlas,
} from '../textures/textures';

export interface CityMeshes {
  group: THREE.Group;
  /** World space lamp head positions, for the dynamic light pool and light fx. */
  lampPositions: THREE.Vector3[];
  /** Neon sign centers with their colors, for reflections. */
  signLights: { pos: THREE.Vector3; color: THREE.Color }[];
  barrierLampMaterial: THREE.MeshBasicMaterial;
  /** Start / finish gantries: call update(time) per frame and burst() on the player's finish. */
  finishLine: FinishLines;
  /** Lit shop fronts from the podiums, for the idle people (people/idleSpots.ts). */
  shopFronts: readonly ShopFront[];
  /** Animated building windows and aviation lights (s). */
  update(time: number): void;
  dispose(): void;
}

export interface CityMeshOptions {
  /** Architectural detail tier (fire escapes, clutter, animated windows); default medium. */
  detail?: Detail;
}

/** Asphalt over the sim's ground (m): cars are drawn this much higher so their tires stand on it (CarView roadLift). */
export const ROAD_Y = 0.02;
const MARK_Y = 0.045;
/** Curb faces reach this far below the ground (m), under the road's edge. */
const CURB_FOOT = 0.08;
/** Junction fans wider than this (m, roundabouts, flared shortcut mouths) are cut into rings about this far apart, so they drape. */
const FAN_STEP = 7;
/** Under a roundabout the fan drapes over the island's mound or bowl (a meter up or down over a few meters), so its rings are this close. */
const FAN_STEP_RING = 2;
/**
 * Roads and cobbles glow faintly sodium orange, scaled by their own texture:
 * the streetlights' spill between their pools, so no street goes black far
 * from the few real lights that follow the car.
 */
const ROAD_GLOW = { color: 0xffb46a, intensity: 1.7 } as const;

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
    // dips finer than its grid (the river channel, ramps). A tunnel's ridge is left
    // out: it rises too steeply beside its street for a grid this coarse, and the
    // tunnel renderer drapes its own rock over it (render/districts/tunnel.ts).
    const r = size / 96;
    const ridges = ridgeLift(world);
    // The lowest level: under a river bridge the terrain is the deck, 4 m over the channel floor
    // the river renderer drapes on, and a grid vertex at deck height there would slope the plane
    // down through the banks, the piers and the floor beside every deck (render/districts/river.ts).
    const low = (x: number, z: number) => world.heightAt(x, z, -Infinity);
    // Car park roofs are structures, not ground either (render/districts/carPark.ts draws them).
    const gh = groundHeight({ areas: world.areas, heightAt: ridges ? (x: number, z: number) => low(x, z) - ridges(x, z) : low });
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let y = gh(x, z);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) y = Math.min(y, gh(x + dx * r * 0.5, z + dz * r * 0.5));
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
    occlusionMaterial(
      new THREE.MeshStandardMaterial({
        map: track(asphalt.map),
        roughnessMap: track(asphalt.roughness),
        roughness: 1,
        metalness: 0.0,
        color: 0x9a9eaa,
        envMapIntensity: 1.6,
        emissive: ROAD_GLOW.color,
        emissiveMap: asphalt.map,
        emissiveIntensity: ROAD_GLOW.intensity,
      }),
      true,
    ),
  );
  // Roads, cobbles, sidewalks and markings carry baked occlusion in their vertex colours (bakedOcclusion.ts).
  const occ = occlusionFor(world);
  const road = new GeoBuilder(true);
  const addGroundVertex = (gb: GeoBuilder, x: number, z: number, lift: number, uvScale: number) => {
    const [nx, ny, nz] = normalAt(x, z);
    return gb.vertex(x, h(x, z) + lift, z, nx, ny, nz, x / uvScale, z / uvScale);
  };
  const g = world.graph;
  const { sectors, mouths } = world.blocks;
  // ---- Where a shadow edge needs vertices. A strip or fan with vertices only at its ends cannot show
  // one, so rows are added across and along only where an overhead structure's soft edge crosses the
  // piece (and one column near a wall that darkens the ground at it); everywhere else the mesh is as it was.
  const OC = OCCLUSION;
  const groundY = (x: number, z: number) => h(x, z) + ROAD_Y;
  /** Whether any ground in the box lies under or near an overhead structure's shadow. */
  const shadedBox = (x0: number, z0: number, x1: number, z1: number, pts: Vec2[]) => {
    if (!occ.overheadNear(x0, z0, x1, z1)) return false;
    return pts.some((p) => occ.overhead(p.x, p.z, groundY(p.x, p.z)) > 0.004);
  };
  /** Sample points along a segment about every `step` m (ends included). */
  const along = (a: Vec2, b: Vec2, step: number, out: Vec2[]) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n });
  };
  /**
   * Stops (0..1, ends included) of the vertices across one row of a strip, from L to R: uniform ones where
   * a deck's shadow varies across the row, one where a wall's contact shadow ends.
   */
  const rowStops = (lx: number, lz: number, rx: number, rz: number): number[] => {
    const w = Math.hypot(rx - lx, rz - lz);
    if (w < 1e-3) return [0, 1];
    const extra: number[] = [];
    if (occ.wall(lx, lz) > 0.002 && OC.wallReach / w < 0.5) extra.push(OC.wallReach / w);
    if (occ.wall(rx, rz) > 0.002 && OC.wallReach / w < 0.5) extra.push(1 - OC.wallReach / w);
    if (occ.overheadNear(Math.min(lx, rx), Math.min(lz, rz), Math.max(lx, rx), Math.max(lz, rz))) {
      const n = Math.ceil(w / OC.crossStep);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = lx + (rx - lx) * t;
        const z = lz + (rz - lz) * t;
        const l = occ.overhead(x, z, groundY(x, z));
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
      }
      if (hi - lo > 0.01) for (let i = 1; i < n; i++) extra.push(i / n);
    }
    if (!extra.length) return [0, 1];
    extra.sort((p, q) => p - q);
    const out = [0];
    for (const t of extra) if (t - out[out.length - 1] > 0.04 && t < 0.96) out.push(t);
    out.push(1);
    return out;
  };
  /** Triangles between two rows of vertices (stops ts), each row running the same way across; equal stops make quads. */
  const zip = (gb: GeoBuilder, a: number[], ta: number[], b: number[], tb: number[]) => {
    let i = 0;
    let j = 0;
    while (i < a.length - 1 || j < b.length - 1) {
      const na = i < a.length - 1 ? ta[i + 1] : Infinity;
      const nb = j < b.length - 1 ? tb[j + 1] : Infinity;
      if (Math.abs(na - nb) < 1e-6) {
        gb.quadFacing(a[i], a[i + 1], b[j + 1], b[j], 0, 1, 0);
        i++;
        j++;
      } else if (na < nb) {
        gb.triFacing(a[i], a[i + 1], b[j], 0, 1, 0);
        i++;
      } else {
        gb.triFacing(a[i], b[j + 1], b[j], 0, 1, 0);
        j++;
      }
    }
  };
  // The river draws its channel floor and ramps itself (render/districts/river.ts): no asphalt, markings,
  // curbs or sidewalks on its edges, nor at the nodes that only join them. A loop mouth's dead end (the
  // foot of an expressway loop) has no junction either: the loop's road carries on from it.
  const riverOnly = g.nodes.map((n) => n.edges.every((eid) => isRiverEdge(g.edges[eid]) || g.edges[eid].kind === 'mouth'));
  g.nodes.forEach((n, ni) => {
    if (riverOnly[ni]) return;
    const ring: Vec2[] = [];
    for (const s of sectors[ni]) for (const p of s.curb) ring.push(p);
    const c = addGroundVertex(road, n.x, n.z, ROAD_Y, 10);
    let reach = 0;
    for (const p of ring) reach = Math.max(reach, Math.hypot(p.x - n.x, p.z - n.z));
    // Under or beside a deck's shadow the fan is cut finer, rings and arcs alike, so its edge shows.
    const samples: Vec2[] = [];
    if (occ.overheadNear(n.x - reach, n.z - reach, n.x + reach, n.z + reach)) {
      for (let dx = -reach; dx <= reach; dx += 3) for (let dz = -reach; dz <= reach; dz += 3) if (dx * dx + dz * dz <= reach * reach) samples.push({ x: n.x + dx, z: n.z + dz });
    }
    const fine = samples.length > 0 && shadedBox(n.x - reach, n.z - reach, n.x + reach, n.z + reach, samples);
    if (fine) {
      const cut: Vec2[] = [];
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / OC.rowStep));
        for (let q = 0; q < k; q++) cut.push({ x: a.x + ((b.x - a.x) * q) / k, z: a.z + ((b.z - a.z) * q) / k });
      }
      ring.length = 0;
      ring.push(...cut);
    }
    // Concentric rings out to the curb (the last one is the curb ring itself), so a wide fan drapes.
    const bands = Math.max(1, Math.ceil(reach / (fine ? OC.rowStep : n.ring ? FAN_STEP_RING : FAN_STEP)));
    let inner: number[] = [];
    for (let j = 1; j <= bands; j++) {
      const t = j / bands;
      const ids = ring.map((p) => addGroundVertex(road, n.x + (p.x - n.x) * t, n.z + (p.z - n.z) * t, ROAD_Y, 10));
      for (let i = 0; i < ids.length; i++) {
        const k = (i + 1) % ids.length;
        if (j === 1) road.triFacing(c, ids[i], ids[k], 0, 1, 0);
        else road.quadFacing(inner[i], ids[i], ids[k], inner[k], 0, 1, 0);
      }
      inner = ids;
    }
  });
  // A strip between two lines (each given as start/end points), subdivided along its length (every
  // 6 m; back alleys every 1 m so road and sidewalk follow their kicker humps). An edge passes one
  // step count (edgeSteps) to its road, both sidewalks and both curb faces, so they share vertices
  // along the curb lines and stay joined over crests and dips.
  const strip = (gb: GeoBuilder, l0: Vec2, l1: Vec2, r0: Vec2, r1: Vec2, liftL: number, liftR: number, uvScale: number, step = 6, count?: number) => {
    const len = Math.max(Math.hypot(l1.x - l0.x, l1.z - l0.z), Math.hypot(r1.x - r0.x, r1.z - r0.z));
    const steps = count ?? Math.max(1, Math.ceil(len / step));
    let prev: number[] = [];
    let prevT: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lx = l0.x + (l1.x - l0.x) * t;
      const lz = l0.z + (l1.z - l0.z) * t;
      const rx = r0.x + (r1.x - r0.x) * t;
      const rz = r0.z + (r1.z - r0.z) * t;
      const ts = rowStops(lx, lz, rx, rz);
      const ids = ts.map((q) => (q === 0 ? addGroundVertex(gb, lx, lz, liftL, uvScale) : q === 1 ? addGroundVertex(gb, rx, rz, liftR, uvScale) : addGroundVertex(gb, lx + (rx - lx) * q, lz + (rz - lz) * q, liftL + (liftR - liftL) * q, uvScale)));
      if (i > 0) zip(gb, prev, prevT, ids, ts);
      prev = ids;
      prevT = ts;
    }
  };
  const stepOf = (ei: number) => (g.edges[ei].kind === 'backAlley' ? 1 : 6);
  /** Pieces along an edge: its longest curb or building line over its step. */
  const stepsOf: number[] = [];
  const edgeSteps = (ei: number) => {
    const cached = stepsOf[ei];
    if (cached !== undefined) return cached;
    const m = mouths[ei];
    const len = Math.max(
      Math.hypot(m.bP.curb.x - m.aP.curb.x, m.bP.curb.z - m.aP.curb.z),
      Math.hypot(m.bN.curb.x - m.aN.curb.x, m.bN.curb.z - m.aN.curb.z),
      Math.hypot(m.bP.outer.x - m.aP.outer.x, m.bP.outer.z - m.aP.outer.z),
      Math.hypot(m.bN.outer.x - m.aN.outer.x, m.bN.outer.z - m.aN.outer.z),
    );
    let n = Math.max(1, Math.ceil(len / stepOf(ei)));
    // A deck's shadow edge crossing the street needs rows close enough to draw it: the whole edge gets them
    // (the road, both sidewalks and both curb faces share this count, so they stay joined).
    const corners = [m.aP.curb, m.bP.curb, m.aN.curb, m.bN.curb, m.aP.outer, m.bP.outer, m.aN.outer, m.bN.outer];
    const x0 = Math.min(...corners.map((p) => p.x));
    const x1 = Math.max(...corners.map((p) => p.x));
    const z0 = Math.min(...corners.map((p) => p.z));
    const z1 = Math.max(...corners.map((p) => p.z));
    if (occ.overheadNear(x0, z0, x1, z1)) {
      const pts: Vec2[] = [];
      for (const [a, b] of [[m.aP.curb, m.bP.curb], [m.aN.curb, m.bN.curb], [m.aP.outer, m.bP.outer], [m.aN.outer, m.bN.outer]] as [Vec2, Vec2][]) along(a, b, OC.rowStep, pts);
      along({ x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 }, { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 }, OC.rowStep, pts);
      if (shadedBox(x0, z0, x1, z1, pts)) n = Math.max(n, Math.ceil(len / OC.rowStep));
    }
    return (stepsOf[ei] = n);
  };
  // Alleys (raceway alleys, back alleys, route shortcuts) are cobbled curb to curb between their
  // mouths, matching the sim's 'cobble' surface patches; the junction fans stay asphalt. Their UVs
  // run along and across the strip so the stones follow the alley.
  const cobbled = (ei: number) => g.edges[ei].kind === 'alley' || g.edges[ei].kind === 'backAlley';
  const cobble = new GeoBuilder(true);
  // Rows are stationed by distance along the alley, not by equal fractions of each curb line: a diagonal
  // mouth starts the two lines at different distances, and rows between unequal fractions tilt across
  // the alley, so over a kicker or a jump exit's ramp the cobbles would cut up through the steel deck
  // drawn on the true profile (render/districts/alley.ts). Where one line has not started yet (or has
  // ended) its vertex waits at its corner, and the junction fan covers the mouth anyway.
  const alignedStrip = (gb: GeoBuilder, l0: Vec2, l1: Vec2, r0: Vec2, r1: Vec2, lift: number, uvScale: number, steps: number) => {
    let ax = l1.x - l0.x + (r1.x - r0.x);
    let az = l1.z - l0.z + (r1.z - r0.z);
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const along = (p: Vec2) => p.x * ax + p.z * az;
    const sL0 = along(l0);
    const sL1 = along(l1);
    const sR0 = along(r0);
    const sR1 = along(r1);
    const s0 = Math.min(sL0, sR0);
    const s1 = Math.max(sL1, sR1);
    const frac = (s: number, a: number, b: number) => (b - a > 1e-6 ? Math.max(0, Math.min(1, (s - a) / (b - a))) : 0);
    const across = Math.hypot(r0.x - l0.x, r0.z - l0.z) / uvScale;
    let prev: number[] = [];
    let prevT: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const s = s0 + ((s1 - s0) * i) / steps;
      const u = (s - s0) / uvScale;
      const tl = frac(s, sL0, sL1);
      const tr = frac(s, sR0, sR1);
      const lx = l0.x + (l1.x - l0.x) * tl;
      const lz = l0.z + (l1.z - l0.z) * tl;
      const rx = r0.x + (r1.x - r0.x) * tr;
      const rz = r0.z + (r1.z - r0.z) * tr;
      // Alley walls stand at both edges: a contact column beside each (rowStops).
      const ts = rowStops(lx, lz, rx, rz);
      const ids = ts.map((q) => {
        const x = q === 1 ? rx : lx + (rx - lx) * q;
        const z = q === 1 ? rz : lz + (rz - lz) * q;
        const [nx, ny, nz] = normalAt(x, z);
        return gb.vertex(x, h(x, z) + lift, z, nx, ny, nz, u, across * q);
      });
      if (i > 0) zip(gb, prev, prevT, ids, ts);
      prev = ids;
      prevT = ts;
    }
  };
  g.edges.forEach((e, ei) => {
    if (isRiverEdge(e)) return;
    const m = mouths[ei];
    if (cobbled(ei)) alignedStrip(cobble, m.aP.curb, m.bP.curb, m.aN.curb, m.bN.curb, ROAD_Y, COBBLE_TILE, edgeSteps(ei));
    else strip(road, m.aP.curb, m.bP.curb, m.aN.curb, m.bN.curb, ROAD_Y, ROAD_Y, 10, 6, edgeSteps(ei));
  });
  // Bus bays and path mouths (busBays.ts): asphalt where the curb steps back; their sidewalks and paint follow below.
  const bays = world.blocks.bays ?? [];
  const bayOf = baysByEdge(bays, g.edges.length);
  const bayDraw: BayDraw = {
    ground: (gb, x, z, lift, uvScale) => addGroundVertex(gb, x, z, lift, uvScale),
    h,
    normalAt,
    curbFace: (p, q, steps) => curbFace(p, q, steps),
  };
  for (const bay of bays) drawBayAsphalt(bay, road, bayDraw, ROAD_Y);
  bakeOcclusion(road, occ);
  const roadMesh = new THREE.Mesh(track(road.build()), roadMat);
  roadMesh.name = 'roads';
  group.add(roadMesh);
  if (cobble.vertexCount) {
    const stones = makeCobble(world.seed);
    const cobbleMat = track(
      occlusionMaterial(
        new THREE.MeshStandardMaterial({
          map: track(stones.map),
          roughnessMap: track(stones.roughness),
          roughness: 1,
          metalness: 0,
          color: 0xb0aea8,
          envMapIntensity: 1.2,
          emissive: ROAD_GLOW.color,
          emissiveMap: stones.map,
          emissiveIntensity: ROAD_GLOW.intensity,
        }),
        true,
      ),
    );
    bakeOcclusion(cobble, occ);
    const cobbleMesh = new THREE.Mesh(track(cobble.build()), cobbleMat);
    cobbleMesh.name = 'cobbles';
    group.add(cobbleMesh);
  }

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
    if (isRiverEdge(e)) return;
    // No lane lines or crosswalk stripes on cobbles.
    if (cobbled(ei)) return;
    const m = mouths[ei];
    const a = { x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 };
    const b = { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 };
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 8) return;
    const dx = (b.x - a.x) / len;
    const dz = (b.z - a.z) / len;
    // Keep markings clear of the crosswalks: a junction end has one, a bend node (where the street
    // goes on, roadGraph.ts) none, so the lines run right up to it and meet the next piece's.
    const clearA = isBendNode(g, e.a) ? 0 : 5;
    const clearB = isBendNode(g, e.b) ? 0 : 5;
    const a2 = { x: a.x + dx * clearA, z: a.z + dz * clearA };
    const b2 = { x: b.x - dx * clearB, z: b.z - dz * clearB };
    const half = e.width / 2;
    if (e.lanes === 2) {
      addLine(a2, b2, 0, 0.16, 3, 5, white);
    } else {
      addLine(a2, b2, 0.18, 0.14, 0, 0, yellow);
      addLine(a2, b2, -0.18, 0.14, 0, 0, yellow);
      addLine(a2, b2, half / 2, 0.14, 3, 6, white);
      addLine(a2, b2, -half / 2, 0.14, 3, 6, white);
    }
    for (const side of [1, -1]) {
      // The edge line: broken into dashes across each bay's (or path mouth's) mouth.
      const spans = bayOf[ei].filter((b) => b.side === side).map((b) => bayMouth(b, a, dx, dz)).sort((p, q) => p[0] - q[0]);
      const at = (s: number) => ({ x: a.x + dx * s, z: a.z + dz * s });
      let from = a2;
      for (const [s0, s1] of spans) {
        addLine(from, at(s0), side * (half - 0.45), 0.14, 0, 0, white);
        addLine(at(s0), at(s1), side * (half - 0.45), 0.14, BAY_DASH, BAY_DASH, white);
        from = at(s1);
      }
      addLine(from, b2, side * (half - 0.45), 0.14, 0, 0, white);
    }
    // crosswalk stripes near each junction end
    for (const [from, dir] of [
      [a, 1],
      [b, -1],
    ] as [Vec2, number][]) {
      if (isBendNode(g, dir > 0 ? e.a : e.b)) continue;
      for (let o = -half + 0.8; o < half - 0.6; o += 1.1) {
        const p0 = { x: from.x + dx * dir * 1.2, z: from.z + dz * dir * 1.2 };
        const p1 = { x: from.x + dx * dir * 4.2, z: from.z + dz * dir * 4.2 };
        addLine(dir > 0 ? p0 : p1, dir > 0 ? p1 : p0, o, 0.55, 0, 0, white);
      }
    }
  });
  for (const bay of bays) drawBayPaint(bay, marks, bayDraw);
  bakeOcclusion(marks, occ);
  const markMat = track(occlusionMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: 0x15161a }), true));
  const markMesh = new THREE.Mesh(track(marks.build()), markMat);
  markMesh.name = 'markings';
  group.add(markMesh);

  // ---------- Sidewalks and curbs ----------
  const walk = new GeoBuilder(true);
  const curbH = CITY.curbHeight;
  /**
   * Curb face from p to q in `steps` pieces, draped like the strips beside it (a single quad would
   * run straight through crests and sink under the road). Its foot reaches a little below the road
   * so no slit opens where the road's and the sidewalk's interpolations differ.
   */
  const curbFace = (p: Vec2, q: Vec2, steps = 1) => {
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const l = Math.hypot(dx, dz) || 1;
    // normal faces away from the sidewalk; caller passes points so either side works
    const nx = dz / l;
    const nz = -dx / l;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = p.x + dx * t;
      const z = p.z + dz * t;
      const y = h(x, z);
      const b = walk.vertex(x, y - CURB_FOOT, z, nx, 0, nz, (l * t) / 4, 0);
      const top = walk.vertex(x, y + curbH, z, nx, 0, nz, (l * t) / 4, 0.05);
      if (i > 0) {
        walk.quad(lo, b, top, hi);
        walk.quad(lo, hi, top, b); // both windings: curbs are seen from the road only, cheap enough
      }
      lo = b;
      hi = top;
    }
  };
  g.edges.forEach((e, ei) => {
    if (isRiverEdge(e)) return;
    const m = mouths[ei];
    const n = edgeSteps(ei);
    const pBays = sideBays(bayOf[ei], 1);
    const nBays = sideBays(bayOf[ei], -1);
    if (pBays.length) drawBaySidewalk(pBays, walk, bayDraw, m.aP.curb, m.bP.curb, m.aP.outer, m.bP.outer, n);
    else {
      strip(walk, m.aP.curb, m.bP.curb, m.aP.outer, m.bP.outer, curbH, curbH, 4, 6, n);
      curbFace(m.aP.curb, m.bP.curb, n);
    }
    if (nBays.length) drawBaySidewalk(nBays, walk, bayDraw, m.aN.curb, m.bN.curb, m.aN.outer, m.bN.outer, n);
    else {
      strip(walk, m.aN.curb, m.bN.curb, m.aN.outer, m.bN.outer, curbH, curbH, 4, 6, n);
      curbFace(m.aN.curb, m.bN.curb, n);
    }
  });
  g.nodes.forEach((_, ni) => {
    if (riverOnly[ni]) return;
    for (const s of sectors[ni]) {
      for (let i = 0; i + 1 < s.curb.length; i++) {
        const len = Math.max(Math.hypot(s.curb[i + 1].x - s.curb[i].x, s.curb[i + 1].z - s.curb[i].z), Math.hypot(s.outer[i + 1].x - s.outer[i].x, s.outer[i + 1].z - s.outer[i].z));
        const n = Math.max(1, Math.ceil(len / 6));
        strip(walk, s.curb[i], s.curb[i + 1], s.outer[i], s.outer[i + 1], curbH, curbH, 4, 6, n);
        curbFace(s.curb[i], s.curb[i + 1], n);
      }
    }
  });
  bakeOcclusion(walk, occ);
  const walkMat = track(occlusionMaterial(new THREE.MeshStandardMaterial({ map: track(makeSidewalk()), roughness: 0.75, color: 0x9da0ad, envMapIntensity: 0.4 })));
  const walkMesh = new THREE.Mesh(track(walk.build()), walkMat);
  walkMesh.name = 'sidewalks';
  group.add(walkMesh);

  // ---------- Buildings ----------
  // Regional architecture (architecture.ts plans the styles, buildings.ts builds them) over facade kit podiums.
  const neon = NEON_COLORS.map((c) => new THREE.Color(c));
  const mood = neonMood(world.seed);
  const detail = opts.detail ?? 'medium';
  const podium = createPodiumOutput(detail);
  const buildings = buildBuildings(world, podium, { detail });
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
    const flick = new FlickList(world, 'podium');
    const plan = planSignage(world, detail);
    const cellW = 1 / SIGN_ATLAS_COLS;
    const cellH = 1 / SIGN_ATLAS_ROWS;
    for (let si = 0; si < world.blocks.signs.length; si++) {
      const s = world.blocks.signs[si];
      const fl = flick.roll(s.blade ? SIGNAGE.flickerBlade : SIGNAGE.flickerPodium);
      // A clock sign takes this sign's wall (signage.ts): no name sign under the panel.
      if (plan.clocks.has(si)) continue;
      const idx = s.nameIndex % SIGN_SLOTS;
      const col = neon[mood.neon((s.colorIndex + 0.5) / 1024)];
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
      flick.fill(sb.vertexCount, fl);
      signLights.push({ pos: new THREE.Vector3(s.x + s.nx * (s.blade ? s.w / 2 : 0.3), s.y, s.z + s.nz * (s.blade ? s.w / 2 : 0.3)), color: col.clone() });
    }
    const signMat = track(new THREE.MeshBasicMaterial({ map: track(makeSignAtlas(world.seed)), vertexColors: true }));
    signMat.color.setScalar(2.6);
    applyFlicker(signMat);
    const signGeo = track(sb.build());
    signGeo.setAttribute('aFlick', flick.attribute(sb.vertexCount));
    const signMesh = new THREE.Mesh(signGeo, signMat);
    signMesh.name = 'signs';
    group.add(signMesh);
    // Bulbs, tickers and clocks: at most three draw calls for the whole city.
    const extras = buildSignageMeshes(world, plan);
    disposables.push(extras);
    for (const m of extras.meshes) group.add(m);
  }

  // ---------- Hazard lamp material ----------
  // Closures are cyan rail pieces now (routeArrows.ts); this blinking amber (animated by the scene) is
  // shared by the beacons on their posts, the hazards of the parked meet cars and every district's hazard
  // lamps (jump lips, gore noses, barricades: render/districts/kit.ts hazard).
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
    shopFronts: podium.shopFronts,
    barrierLampMaterial,
    finishLine,
    update(time) {
      setSignageTime(time);
      buildings.update(time);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
