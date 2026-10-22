/**
 * Drawbridge renderer (city/drawbridge.ts): the two bascule leaves, the
 * opening they lift over, four counterweight houses at the hinges (one
 * carrying the glazed control cabin), the gate arms at both ends with their
 * flashing signals, stop lines and red light washes on the road. Every moving part is
 * posed from the sim's pure functions (gatePhase, leafAngle) at the
 * interpolated sim tick the session passes to sync(), so a replay looks the
 * same as the race; scenes no session drives (the menu backdrop) run on the
 * scene clock instead. Render only.
 *
 * The leaves are built from the same pieces as the street they replace,
 * draped on the same terrain, with the city's own road, sidewalk and marking
 * materials and world mapped UVs, so a leaf lying down is the static street
 * pixel for pixel; they are only drawn while off the ground. The opening is
 * a trick that needs no change to the city meshes: the river renderer draws
 * the channel floor under the span first (renderOrder -4), then a depth-only
 * lid over the opening (-3) hides the static deck under it from everything
 * drawn after, so the street reads as cut open over the real channel while
 * the leaves are up (the lid is off while they lie down). Its rim stops a
 * little inside the hinge lines: the lid only goes on once the leaves are
 * clear of it.
 *
 * Cost: about nine draw calls when in view with the leaves down (merged
 * static parts, two instanced meshes for the four arms and their lamps, the
 * light washes), up to seven more while the bridge is up. Per frame: one phase
 * evaluation, two leaf quaternions and four arm matrices, only while moving.
 * The bell (audio/warningBell.ts) rings from view(camera) during the warning
 * and while the arms move.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Drawbridge } from '../../city/drawbridge';
import { leafAngle } from '../../city/drawbridge';
import { CITY } from '../../city/config';
import type { GatePhase } from '../../sim/gates';
import { gatePhase } from '../../sim/gates';
import { TICK_HZ } from '../../sim/constants';
import type { Quality } from '../../ui/settings';
import { GeoBuilder } from '../geoBuilder';
import { fadeSubPixel } from './lightFx';
import { WarningBell } from '../../audio/warningBell';

/** Layout (m), timing and tints of the dressing. */
const DB = {
  /** Lifts matching cityMeshes: road surface, lane markings, curb foot below the road. */
  roadY: 0.02,
  markY: 0.045,
  curbFoot: 0.08,
  /** Leaf: steel depth under the deck, gap between the two tips. */
  leafDepth: 0.9,
  tipGap: 0.12,
  /** Opening: its rim this far inside the hinge lines, the lid this far above the deck. */
  ledge: 1.2,
  lidLift: 0.12,
  /** The lid goes on once the leaves are past this angle (rad): ledge * sin(angle) clears lidLift. */
  lidAngle: 6.5 * (Math.PI / 180),
  /** Gate arms: this far inside the sim's gate line (a car held at the line stops short of the arm), pivot height,
   * post offset beyond the deck edge, arm section, raised angle (rad), stripe length. */
  armInset: 0.3,
  armHeight: 1.05,
  postOut: 0.55,
  armPivotOut: 0.4,
  armThick: 0.16,
  armDepth: 0.1,
  armUp: 85 * (Math.PI / 180),
  stripe: 0.9,
  /** Signal masts: distance beyond the gate line, height, lamp spacing. */
  mastBack: 0.9,
  mastHeight: 3.4,
  lampSpread: 0.45,
  /** Counterweight houses: footprint along the street and across, height above the deck. */
  houseLong: 5.6,
  houseWide: 3.2,
  houseHeight: 6.8,
  cabinHeight: 2.8,
  /** Stop line before each gate, and the red light washes on the road. */
  stopBack: 1.4,
  stopWidth: 0.45,
  washBack: 3.2,
  washRadius: 3.4,
  /** Signals flash this many times a second, alternating left and right. */
  flashHz: 1.3,
  /** The bell is heard out to this far (m), half as loud at bellHalf. */
  bellRange: 260,
  bellHalf: 45,
} as const;

const TINT = {
  steel: new THREE.Color(0x3b4049),
  steelDark: new THREE.Color(0x24272e),
  white: new THREE.Color(0xe8e8e2),
  red: new THREE.Color(0xc0242a),
  concrete: new THREE.Color(0x8a867d),
  trim: new THREE.Color(0x5e5b55),
  roof: new THREE.Color(0x35514a),
  post: new THREE.Color(0x9aa0a8),
  plate: new THREE.Color(0x101114),
  window: new THREE.Color(0xffc777),
  windowDim: new THREE.Color(0x4a3a24),
  cabin: new THREE.Color(0xffe0a8),
  beacon: new THREE.Color(0xff2a20),
  lampWarm: new THREE.Color(0xffb24a),
  poolWarm: new THREE.Color(0xff9a3a),
  black: new THREE.Color(0x000000),
  markWhite: new THREE.Color(0xd8dce6),
  markYellow: new THREE.Color(0xf2b632),
} as const;

export interface DrawbridgeView {
  group: THREE.Group;
  /** Pose everything at a (fractional) sim tick; `audible` lets the bell ring (a live, unpaused race or replay). */
  sync(tick: number, audible: boolean): void;
  /** Scene clock (s) for scenes no session drives; ignored once sync has been called. */
  clock(time: number): void;
  /** Bell from the camera: call before each render. */
  view(camera: THREE.Camera): void;
  dispose(): void;
}

export interface DrawbridgeOptions {
  quality: Quality;
  /** The city's own road, sidewalk and marking materials (cityMeshes), so a leaf lying down matches the street. */
  road?: THREE.Material;
  walk?: THREE.Material;
  marks?: THREE.Material;
}

/** An empty view for worlds without a drawbridge. */
function noBridge(): DrawbridgeView {
  const group = new THREE.Group();
  group.name = 'drawbridge';
  return { group, sync() {}, clock() {}, view() {}, dispose() {} };
}

export function buildDrawbridge(world: World, opts: DrawbridgeOptions): DrawbridgeView {
  const db = world.drawbridge;
  const set = world.timedGates;
  if (!db || !set) return noBridge();
  const cycle = set.cycles[db.cycle];
  const h = world.heightAt;
  const group = new THREE.Group();
  group.name = 'drawbridge';
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const dm = db.dx * db.mx + db.dz * db.mz;
  const nm = db.nx * db.mx + db.nz * db.mz;
  /** World point at lateral w and channel distance l (on the deck's parallelogram). */
  const Q = (w: number, l: number): THREE.Vector2 => {
    const u = (l - w * nm) / dm;
    return new THREE.Vector2(db.cx + db.dx * u + db.nx * w, db.cz + db.dz * u + db.nz * w);
  };
  /** World point at axis distance u and lateral w. */
  const P = (u: number, w: number): THREE.Vector2 => new THREE.Vector2(db.cx + db.dx * u + db.nx * w, db.cz + db.dz * u + db.nz * w);
  const normalAt = (x: number, z: number): [number, number, number] => {
    const s = world.slopeAt(x, z);
    const l = Math.hypot(s.gx, 1, s.gz);
    return [-s.gx / l, 1 / l, -s.gz / l];
  };

  // ---------- Materials ----------
  const solidMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08, envMapIntensity: 0.5 }));
  const steelMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.45, envMapIntensity: 0.8 }));
  const glowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  glowMat.color.setScalar(1.5);
  fadeSubPixel(glowMat, 0.35, 0.3);
  const sigA = track(new THREE.MeshBasicMaterial({ color: 0x220404 }));
  const sigB = track(new THREE.MeshBasicMaterial({ color: 0x220404 }));
  const beaconMat = track(new THREE.MeshBasicMaterial({ color: TINT.beacon.clone().multiplyScalar(1.8) }));
  const poolMat = () => track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  const warmPoolMat = poolMat();
  const redPoolA = poolMat();
  const redPoolB = poolMat();
  const roadMat = opts.road ?? track(new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.9 }));
  const walkMat = opts.walk ?? track(new THREE.MeshStandardMaterial({ color: 0x6d707a, roughness: 0.8 }));
  const marksMat = opts.marks ?? track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  const lidMat = track(new THREE.MeshBasicMaterial({ colorWrite: false }));
  const washes = opts.quality !== 'low';

  const addMesh = (gb: GeoBuilder, mat: THREE.Material, name: string, parent: THREE.Object3D, order = 0): THREE.Mesh | null => {
    if (!gb.vertexCount) return null;
    const m = new THREE.Mesh(track(gb.build()), mat);
    m.name = name;
    m.renderOrder = order;
    parent.add(m);
    return m;
  };

  // ---------- Static parts ----------
  const solid = new GeoBuilder(true);
  const glow = new GeoBuilder(true);
  const lampA = new GeoBuilder(true);
  const lampB = new GeoBuilder(true);
  const beacons = new GeoBuilder(true);
  const paint = new GeoBuilder(true);
  const warm = new GeoBuilder(true);
  const washA = new GeoBuilder(true);
  const washB = new GeoBuilder(true);
  const deckY = (p: THREE.Vector2) => h(p.x, p.y);

  // Gate posts and signal masts at both ends, both sides; stop lines and the red washes on the approach.
  const pivots: { x: number; y: number; z: number; ax: number; az: number }[] = [];
  for (const e of [-1, 1]) {
    // Approach direction (the gate's holding side) is +e along the axis.
    for (const side of [-1, 1]) {
      const post = P(e * (db.gate - DB.armInset), side * (db.half + DB.postOut));
      const y = deckY(post);
      cylinder(solid, post.x, post.y, 0.13, y - 0.3, y + DB.armHeight + 0.25, 8, TINT.post);
      box(solid, post.x, post.y, db.dx, db.dz, 0.32, 0.3, y - 0.3, y + 0.9, TINT.steelDark);
      const pivot = P(e * (db.gate - DB.armInset), side * (db.half + DB.armPivotOut));
      pivots.push({ x: pivot.x, y: deckY(pivot) + DB.armHeight, z: pivot.y, ax: -side * db.nx, az: -side * db.nz });
      // Signal mast: two lamps on a crossarm facing the approaching traffic.
      const mast = P(e * (db.gate + DB.mastBack), side * (db.half + DB.postOut + 0.25));
      const my = deckY(mast);
      cylinder(solid, mast.x, mast.y, 0.08, my - 0.3, my + DB.mastHeight, 6, TINT.post);
      const fx = db.dx * e;
      const fz = db.dz * e;
      for (const k of [-1, 1]) {
        const lx = mast.x + db.nx * k * DB.lampSpread + fx * 0.12;
        const lz = mast.y + db.nz * k * DB.lampSpread + fz * 0.12;
        const ly = my + DB.mastHeight - 0.55;
        box(solid, lx - fx * 0.06, lz - fz * 0.06, db.nx, db.nz, 0.2, 0.05, ly - 0.2, ly + 0.2, TINT.plate);
        // Left and right lamps alternate (A / B), mirrored across the street so both sides flash together.
        lampBox(k * side > 0 ? lampA : lampB, lx, ly, lz, fx, fz, 0.12, TINT.white);
      }
      box(solid, mast.x, mast.y, db.nx, db.nz, DB.lampSpread + 0.15, 0.04, my + DB.mastHeight - 0.62, my + DB.mastHeight - 0.5, TINT.post);
      if (washes) {
        const wpos = P(e * (db.gate + DB.washBack), side * Math.max(0, db.road - 2.2));
        pool(world, side > 0 ? washA : washB, wpos.x, wpos.y, DB.washRadius, TINT.beacon.clone().multiplyScalar(0.55));
      }
    }
    // Stop line across the roadway before the gate.
    const s0 = P(e * (db.gate + DB.stopBack), -db.road + 0.3);
    const s1 = P(e * (db.gate + DB.stopBack), db.road - 0.3);
    flatStrip(paint, world, s0, s1, DB.stopWidth, DB.markY, TINT.markWhite);
  }

  // Counterweight houses at both ends of both hinge lines; the cabin on one of them.
  for (const s of [-1, 1]) {
    for (const side of [-1, 1]) {
      const w = side * (db.half + 0.45 + DB.houseWide / 2);
      const c = Q(w, s * db.hinge);
      const base = deckY(Q(side * db.half, s * db.hinge));
      const y0 = base - world.areas[db.area].params.depth - 1;
      const y1 = base + DB.houseHeight;
      box(solid, c.x, c.y, db.dx, db.dz, DB.houseLong / 2, DB.houseWide / 2, y0, y1, TINT.concrete);
      box(solid, c.x, c.y, db.dx, db.dz, DB.houseLong / 2 + 0.18, DB.houseWide / 2 + 0.18, y1 - 0.45, y1, TINT.trim);
      const cabin = s > 0 && side > 0;
      if (cabin) {
        // Glazed cabin on top, warm light all round, a flat roof overhanging it.
        box(glow, c.x, c.y, db.dx, db.dz, DB.houseLong / 2 - 0.4, DB.houseWide / 2 - 0.3, y1, y1 + DB.cabinHeight - 0.5, TINT.cabin);
        box(solid, c.x, c.y, db.dx, db.dz, DB.houseLong / 2 - 0.2, DB.houseWide / 2 - 0.1, y1 + DB.cabinHeight - 0.5, y1 + DB.cabinHeight - 0.35, TINT.trim);
        box(solid, c.x, c.y, db.dx, db.dz, DB.houseLong / 2 + 0.4, DB.houseWide / 2 + 0.4, y1 + DB.cabinHeight - 0.35, y1 + DB.cabinHeight, TINT.roof);
      } else hipRoof(solid, c.x, c.y, db.dx, db.dz, DB.houseLong / 2 + 0.1, DB.houseWide / 2 + 0.1, y1, y1 + 1.6, TINT.roof);
      // Windows on the faces toward the street and along it, some lit.
      const top = cabin ? y1 + DB.cabinHeight : y1 + 1.6;
      for (const k of [-1, 1]) {
        const fx = db.dx * k;
        const fz = db.dz * k;
        const wx = c.x + fx * (DB.houseLong / 2 + 0.02);
        const wz = c.y + fz * (DB.houseLong / 2 + 0.02);
        windowQuad(glow, wx, base + 3.6, wz, fx, fz, 0.7, 1.1, (k + side + s) % 2 === 0 ? TINT.window : TINT.windowDim);
      }
      const rx = c.x - db.nx * side * (DB.houseWide / 2 + 0.02);
      const rz = c.y - db.nz * side * (DB.houseWide / 2 + 0.02);
      windowQuad(glow, rx, base + 3.9, rz, -db.nx * side, -db.nz * side, 1.2, 1.0, TINT.window);
      // A lamp over the deck on the street face, and the aviation beacon on top.
      const lx = c.x - db.nx * side * (DB.houseWide / 2 + 0.35);
      const lz = c.y - db.nz * side * (DB.houseWide / 2 + 0.35);
      lampBox(glow, lx, base + 5.4, lz, -db.nx * side, -db.nz * side, 0.22, TINT.lampWarm);
      if (washes) {
        const pp = Q(side * (db.half - 3), s * (db.hinge + 0.8));
        pool(world, warm, pp.x, pp.y, 6.5, TINT.poolWarm.clone().multiplyScalar(0.5));
      }
      lampBox(beacons, c.x, top + 0.25, c.y, 0, 1, 0.16, TINT.white);
    }
  }
  addMesh(solid, solidMat, 'drawbridgeHouses', group);
  addMesh(glow, glowMat, 'drawbridgeWindows', group);
  addMesh(lampA, sigA, 'drawbridgeSignalsA', group);
  addMesh(lampB, sigB, 'drawbridgeSignalsB', group);
  addMesh(beacons, beaconMat, 'drawbridgeBeacons', group);
  addMesh(paint, marksMat, 'drawbridgeStopLines', group);
  addMesh(warm, warmPoolMat, 'drawbridgeLightPools', group, 2);
  addMesh(washA, redPoolA, 'drawbridgeRedWashA', group, 2);
  addMesh(washB, redPoolB, 'drawbridgeRedWashB', group, 2);

  // ---------- Gate arms: four instances of one striped arm, and their lamps ----------
  const armLen = db.half + DB.armPivotOut - DB.tipGap * 1.5;
  const armGb = new GeoBuilder(true);
  const armLampGb = new GeoBuilder(true);
  {
    const t = DB.armThick / 2;
    const d = DB.armDepth / 2;
    for (let x = 0, k = 0; x < armLen; x += DB.stripe, k++) {
      const x1 = Math.min(armLen, x + DB.stripe);
      localBox(armGb, x, x1, -t, t, -d, d, k % 2 ? TINT.white : TINT.red);
    }
    // Counterweight behind the pivot.
    localBox(armGb, -0.85, 0, -t * 1.6, t * 1.6, -d * 1.8, d * 1.8, TINT.steelDark);
    for (const f of [0.3, 0.65, 0.96]) localBox(armLampGb, armLen * f - 0.07, armLen * f + 0.07, t, t + 0.12, -0.06, 0.06, TINT.white);
  }
  const arms = new THREE.InstancedMesh(track(armGb.build()), steelMat, pivots.length);
  const armLamps = new THREE.InstancedMesh(track(armLampGb.build()), sigA, pivots.length);
  arms.name = 'drawbridgeArms';
  armLamps.name = 'drawbridgeArmLamps';
  const sphere = new THREE.Sphere(new THREE.Vector3(db.cx, h(db.cx, db.cz), db.cz), db.gate + db.half + 6);
  arms.boundingSphere = sphere;
  armLamps.boundingSphere = sphere.clone();
  group.add(arms, armLamps);
  const mtx = new THREE.Matrix4();
  const vx = new THREE.Vector3();
  const vy = new THREE.Vector3();
  const vz = new THREE.Vector3();
  const setArms = (down: number) => {
    const phi = DB.armUp * (1 - ease(down));
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    pivots.forEach((p, i) => {
      vx.set(p.ax * c, s, p.az * c);
      vy.set(-p.ax * s, c, -p.az * s);
      vz.crossVectors(vx, vy);
      mtx.makeBasis(vx, vy, vz).setPosition(p.x, p.y, p.z);
      arms.setMatrixAt(i, mtx);
      armLamps.setMatrixAt(i, mtx);
    });
    arms.instanceMatrix.needsUpdate = true;
    armLamps.instanceMatrix.needsUpdate = true;
  };
  setArms(0);

  // ---------- Leaves ----------
  const leaves: { group: THREE.Group; s: number }[] = [];
  const edge = world.graph.edges[db.edge];
  const mouths = world.blocks.mouths[db.edge];
  for (const s of [-1, 1]) {
    const pivotXZ = Q(0, s * db.hinge);
    const pivot = new THREE.Vector3(pivotXZ.x, h(pivotXZ.x, pivotXZ.y), pivotXZ.y);
    const leaf = new THREE.Group();
    leaf.name = `drawbridgeLeaf${s > 0 ? 'Pos' : 'Neg'}`;
    leaf.position.copy(pivot);
    const road = new GeoBuilder(false);
    const walk = new GeoBuilder(false);
    const marks = new GeoBuilder(true);
    const steel = new GeoBuilder(true);
    const lamps = new GeoBuilder(true);
    const l0 = s * (DB.tipGap / 2);
    const l1 = s * db.hinge;
    const rows = Math.max(2, Math.ceil(db.hinge / 2));
    const ls: number[] = [];
    for (let i = 0; i <= rows; i++) ls.push(l0 + ((l1 - l0) * i) / rows);
    /** Vertex relative to the pivot, on the terrain plus a lift, with the street's own UVs and normals. */
    const vert = (gb: GeoBuilder, w: number, l: number, lift: number, uvScale: number, color?: THREE.Color) => {
      const q = Q(w, l);
      const [nx, ny, nz] = normalAt(q.x, q.y);
      return gb.vertex(q.x - pivot.x, h(q.x, q.y) + lift - pivot.y, q.y - pivot.z, nx, ny, nz, q.x / uvScale, q.y / uvScale, color);
    };
    // Road strip: columns every ~2.6 m between the curbs.
    const roadCols = Math.max(2, Math.ceil((2 * db.road) / 2.6));
    const ws: number[] = [];
    for (let j = 0; j <= roadCols; j++) ws.push(-db.road + (2 * db.road * j) / roadCols);
    gridStrip(road, ls, ws, (w, l) => vert(road, w, l, DB.roadY, 10));
    // Sidewalks with their curb faces.
    for (const side of [-1, 1]) {
      const wa = side * db.road;
      const wb = side * db.half;
      gridStrip(walk, ls, [Math.min(wa, wb), Math.max(wa, wb)], (w, l) => vert(walk, w, l, CITY.curbHeight, 4));
      let prev: [number, number] | null = null;
      for (const l of ls) {
        const q = Q(wa, l);
        const y = h(q.x, q.y);
        const nx = -side * db.nx;
        const nz = -side * db.nz;
        const lo = walk.vertex(q.x - pivot.x, y - DB.curbFoot - pivot.y, q.y - pivot.z, nx, 0, nz, l / 4, 0);
        const hi = walk.vertex(q.x - pivot.x, y + CITY.curbHeight - pivot.y, q.y - pivot.z, nx, 0, nz, l / 4, 0.05);
        if (prev) walk.quadFacing(prev[0], lo, hi, prev[1], nx, 0, nz);
        prev = [lo, hi];
      }
    }
    // Lane markings: the city's own dashes (cityMeshes), clipped to this leaf.
    markLeaf(marks, edge, mouths, db, l0, l1, (x, z, color) => {
      const [nx, ny, nz] = normalAt(x, z);
      return marks.vertex(x - pivot.x, h(x, z) + DB.markY - pivot.y, z - pivot.z, nx, ny, nz, 0, 0, color);
    });
    // Steel body: fascias along both deck edges, the striped tip, the heel and the underside.
    const down = (w: number, l: number, depth: number, color: THREE.Color, nx: number, ny: number, nz: number) => {
      const q = Q(w, l);
      return steel.vertex(q.x - pivot.x, h(q.x, q.y) - depth - pivot.y, q.y - pivot.z, nx, ny, nz, 0, 0, color);
    };
    for (const side of [-1, 1]) {
      const w = side * (db.half - 0.03);
      const nx = side * db.nx;
      const nz = side * db.nz;
      for (let i = 0; i + 1 < ls.length; i++) {
        const nearTip = i === 0;
        const c = nearTip ? TINT.red : TINT.steel;
        const a0 = down(w, ls[i], -CITY.curbHeight, c, nx, 0, nz);
        const a1 = down(w, ls[i + 1], -CITY.curbHeight, c, nx, 0, nz);
        const b1 = down(w, ls[i + 1], DB.leafDepth, c, nx, 0, nz);
        const b0 = down(w, ls[i], DB.leafDepth, c, nx, 0, nz);
        steel.quadFacing(a0, a1, b1, b0, nx, 0, nz);
      }
    }
    const tipCols = Math.max(2, Math.ceil((2 * db.half) / 0.8));
    for (const [l, facing] of [
      [l0, -s],
      [l1, s],
    ] as [number, number][]) {
      for (let j = 0; j < tipCols; j++) {
        const wa = -db.half + (2 * db.half * j) / tipCols;
        const wb = -db.half + (2 * db.half * (j + 1)) / tipCols;
        const c = l === l0 ? (j % 2 ? TINT.white : TINT.red) : TINT.steelDark;
        const fx = db.mx * facing;
        const fz = db.mz * facing;
        const a = down(wa, l, -DB.roadY, c, fx, 0, fz);
        const b = down(wb, l, -DB.roadY, c, fx, 0, fz);
        const bb = down(wb, l, DB.leafDepth, c, fx, 0, fz);
        const aa = down(wa, l, DB.leafDepth, c, fx, 0, fz);
        steel.quadFacing(a, b, bb, aa, fx, 0, fz);
      }
    }
    for (let i = 0; i + 1 < ls.length; i++) {
      const a = down(-db.half, ls[i], DB.leafDepth, TINT.steelDark, 0, -1, 0);
      const b = down(db.half, ls[i], DB.leafDepth, TINT.steelDark, 0, -1, 0);
      const c = down(db.half, ls[i + 1], DB.leafDepth, TINT.steelDark, 0, -1, 0);
      const d = down(-db.half, ls[i + 1], DB.leafDepth, TINT.steelDark, 0, -1, 0);
      steel.quadFacing(a, b, c, d, 0, -1, 0);
    }
    // Red lamps on both tip corners.
    for (const side of [-1, 1]) {
      const q = Q(side * (db.half - 0.25), l0 + s * 0.2);
      lampBox(lamps, q.x - pivot.x, h(q.x, q.y) + 0.35 - pivot.y, q.y - pivot.z, 0, 1, 0.16, TINT.white);
    }
    addMesh(road, roadMat, 'leafRoad', leaf);
    addMesh(walk, walkMat, 'leafSidewalk', leaf);
    addMesh(marks, marksMat, 'leafMarkings', leaf);
    addMesh(steel, steelMat, 'leafSteel', leaf);
    addMesh(lamps, beaconMat, 'leafLamps', leaf);
    leaf.visible = false;
    group.add(leaf);
    leaves.push({ group: leaf, s });
  }

  // ---------- The opening: a depth-only lid over the span (the river draws the floor beneath first) ----------
  const pit = new THREE.Group();
  pit.name = 'drawbridgeOpening';
  pit.visible = false;
  {
    const lid = new GeoBuilder(false);
    const L = db.hinge - DB.ledge;
    // The lid: a grid draped on the deck just above the sidewalks, depth only.
    const lidL: number[] = [];
    const lidW: number[] = [];
    const nl = Math.max(2, Math.ceil((2 * L) / 3));
    const nw = Math.max(2, Math.ceil((2 * db.half) / 3));
    for (let i = 0; i <= nl; i++) lidL.push(-L + (2 * L * i) / nl);
    for (let j = 0; j <= nw; j++) lidW.push(-db.half + (2 * db.half * j) / nw);
    gridStrip(lid, lidL, lidW, (w, l) => {
      const q = Q(w, l);
      return lid.vertex(q.x, h(q.x, q.y) + DB.lidLift, q.y, 0, 1, 0, 0, 0);
    });
    addMesh(lid, lidMat, 'spanLid', pit, -3);
  }
  group.add(pit);

  // ---------- Animation ----------
  const tAxis = new THREE.Vector3(db.tx, 0, db.tz);
  const phase: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };
  let driven = false;
  let lastArm = -1;
  let lastAngle = -1;
  let ringing = false;
  let audible = false;
  const lampOn = new THREE.Color();
  const lampOff = new THREE.Color(0x220404);
  const washOn = new THREE.Color(1, 1, 1);
  const washOff = new THREE.Color(0, 0, 0);
  const pose = (tick: number) => {
    gatePhase(cycle, tick, phase);
    if (phase.arm !== lastArm) {
      setArms(phase.arm);
      lastArm = phase.arm;
    }
    const angle = leafAngle(db, set, tick);
    if (angle !== lastAngle) {
      lastAngle = angle;
      for (const lf of leaves) {
        lf.group.visible = angle > 0;
        lf.group.quaternion.setFromAxisAngle(tAxis, lf.s * angle);
      }
      pit.visible = angle >= DB.lidAngle;
    }
    // Signals: dark while open, alternating left / right otherwise; the arm lamps flash with the left ones.
    const active = phase.name !== 'open';
    const flash = Math.floor((tick / TICK_HZ) * DB.flashHz * 2) % 2 === 0;
    lampOn.copy(TINT.beacon).multiplyScalar(2.2);
    sigA.color.copy(active && flash ? lampOn : lampOff);
    sigB.color.copy(active && !flash ? lampOn : lampOff);
    redPoolA.color.copy(active && flash ? washOn : washOff);
    redPoolB.color.copy(active && !flash ? washOn : washOff);
    ringing = phase.name === 'warn' || phase.name === 'lowering' || phase.name === 'raising';
  };
  pose(0);

  // ---------- Bell ----------
  let bell: WarningBell | null = null;
  let bellTried = false;
  const camPos = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const bellPos = new THREE.Vector3(db.cx, h(db.cx, db.cz) + 3, db.cz);

  return {
    group,
    sync(tick, canHear) {
      driven = true;
      audible = canHear;
      pose(tick);
    },
    clock(time) {
      if (driven) return;
      audible = false;
      pose(time * TICK_HZ);
    },
    view(camera) {
      camera.getWorldPosition(camPos);
      const d = camPos.distanceTo(bellPos);
      const proximity = ringing && audible && d < DB.bellRange ? 1 / (1 + (d / DB.bellHalf) ** 2) : 0;
      if (!bell && !bellTried && proximity > 0.03) {
        bell = WarningBell.create();
        bellTried = bell !== null || !WarningBell.blocked();
      }
      if (!bell) return;
      camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      const dx = bellPos.x - camPos.x;
      const dz = bellPos.z - camPos.z;
      const l = Math.hypot(dx, dz) || 1;
      bell.update(proximity, (dx * camRight.x + dz * camRight.z) / l);
    },
    dispose() {
      bell?.dispose();
      bell = null;
      for (const d of disposables) d.dispose();
      group.removeFromParent();
    },
  };
}

/** Smooth start and stop. */
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Quads over a grid of rows (ls) and columns (ws), vertices from `v(w, l)`, facing up. */
function gridStrip(gb: GeoBuilder, ls: number[], ws: number[], v: (w: number, l: number) => number): void {
  let prev: number[] | null = null;
  for (const l of ls) {
    const row = ws.map((w) => v(w, l));
    if (prev) for (let j = 0; j + 1 < row.length; j++) gb.quadFacing(prev[j], prev[j + 1], row[j + 1], row[j], 0, 1, 0);
    prev = row;
  }
}

/** Box centered on (x, z), axes (ux, uz) and its left normal, half sizes a (along u) and b, from y0 to y1. */
function box(gb: GeoBuilder, x: number, z: number, ux: number, uz: number, a: number, b: number, y0: number, y1: number, color: THREE.Color): void {
  const vx = -uz;
  const vz = ux;
  const pts = [
    [x - ux * a - vx * b, z - uz * a - vz * b],
    [x + ux * a - vx * b, z + uz * a - vz * b],
    [x + ux * a + vx * b, z + uz * a + vz * b],
    [x - ux * a + vx * b, z - uz * a + vz * b],
  ];
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    let nx = q[1] - p[1];
    let nz = -(q[0] - p[0]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (((p[0] + q[0]) / 2 - x) * nx + ((p[1] + q[1]) / 2 - z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const v0 = gb.vertex(p[0], y0, p[1], nx, 0, nz, 0, 0, color);
    const v1 = gb.vertex(q[0], y0, q[1], nx, 0, nz, 1, 0, color);
    const v2 = gb.vertex(q[0], y1, q[1], nx, 0, nz, 1, 1, color);
    const v3 = gb.vertex(p[0], y1, p[1], nx, 0, nz, 0, 1, color);
    gb.quadFacing(v0, v1, v2, v3, nx, 0, nz);
  }
  const top = pts.map(([px, pz]) => gb.vertex(px, y1, pz, 0, 1, 0, 0, 0, color));
  gb.quadFacing(top[0], top[1], top[2], top[3], 0, 1, 0);
}

/** Box in a local frame (x along an arm, y up, z across), every face. */
function localBox(gb: GeoBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: THREE.Color): void {
  const faces: [number, number, number, [number, number, number][]][] = [
    [1, 0, 0, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [-1, 0, 0, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [0, 1, 0, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [0, -1, 0, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
    [0, 0, 1, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [0, 0, -1, [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  for (const [nx, ny, nz, q] of faces) {
    const ids = q.map(([x, y, z]) => gb.vertex(x, y, z, nx, ny, nz, 0, 0, color));
    gb.quadFacing(ids[0], ids[1], ids[2], ids[3], nx, ny, nz);
  }
}

/** Upright cylinder (n sides) from y0 to y1, capped. */
function cylinder(gb: GeoBuilder, x: number, z: number, r: number, y0: number, y1: number, n: number, color: THREE.Color): void {
  const lo: number[] = [];
  const hi: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    lo.push(gb.vertex(x + c * r, y0, z + s * r, c, 0, s, 0, 0, color));
    hi.push(gb.vertex(x + c * r, y1, z + s * r, c, 0, s, 0, 1, color));
  }
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    gb.quadFacing(lo[i], lo[i + 1], hi[i + 1], hi[i], Math.cos(a), 0, Math.sin(a));
  }
  const c = gb.vertex(x, y1, z, 0, 1, 0, 0, 0, color);
  for (let i = 0; i < n; i++) gb.triFacing(c, hi[i], hi[i + 1], 0, 1, 0);
}

/** Pyramid roof over a box footprint (axes as in box), eaves at y0, ridge point at y1. */
function hipRoof(gb: GeoBuilder, x: number, z: number, ux: number, uz: number, a: number, b: number, y0: number, y1: number, color: THREE.Color): void {
  const vx = -uz;
  const vz = ux;
  const pts = [
    [x - ux * a - vx * b, z - uz * a - vz * b],
    [x + ux * a - vx * b, z + uz * a - vz * b],
    [x + ux * a + vx * b, z + uz * a + vz * b],
    [x - ux * a + vx * b, z - uz * a + vz * b],
  ];
  const apex = gb.vertex(x, y1, z, 0, 1, 0, 0, 0, color);
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    const mx = (p[0] + q[0]) / 2 - x;
    const mz = (p[1] + q[1]) / 2 - z;
    const ml = Math.hypot(mx, mz) || 1;
    const ny = 0.7;
    const a0 = gb.vertex(p[0], y0, p[1], mx / ml, ny, mz / ml, 0, 0, color);
    const a1 = gb.vertex(q[0], y0, q[1], mx / ml, ny, mz / ml, 0, 0, color);
    gb.triFacing(a0, a1, apex, mx / ml, ny, mz / ml);
  }
}

/** A small glowing lamp box at (x, y, z), its face toward (fx, fz). */
function lampBox(gb: GeoBuilder, x: number, y: number, z: number, fx: number, fz: number, size: number, color: THREE.Color): void {
  const l = Math.hypot(fx, fz);
  const ux = l > 1e-6 ? fx / l : 1;
  const uz = l > 1e-6 ? fz / l : 0;
  box(gb, x, z, ux, uz, size / 2, size / 2, y - size / 2, y + size / 2, color);
}

/** A window pane on a wall face: center (x, y, z), facing (fx, fz), half width and half height. */
function windowQuad(gb: GeoBuilder, x: number, y: number, z: number, fx: number, fz: number, hw: number, hh: number, color: THREE.Color): void {
  const tx = -fz;
  const tz = fx;
  const v = [
    gb.vertex(x - tx * hw, y - hh, z - tz * hw, fx, 0, fz, 0, 0, color),
    gb.vertex(x + tx * hw, y - hh, z + tz * hw, fx, 0, fz, 0, 0, color),
    gb.vertex(x + tx * hw, y + hh, z + tz * hw, fx, 0, fz, 0, 0, color),
    gb.vertex(x - tx * hw, y + hh, z - tz * hw, fx, 0, fz, 0, 0, color),
  ];
  gb.quadFacing(v[0], v[1], v[2], v[3], fx, 0, fz);
}

/** A flat painted strip from a to b, `width` wide, draped `lift` above the terrain. */
function flatStrip(gb: GeoBuilder, world: World, a: THREE.Vector2, b: THREE.Vector2, width: number, lift: number, color: THREE.Color): void {
  const len = a.distanceTo(b);
  if (len < 0.05) return;
  const nx = (-(b.y - a.y) / len) * (width / 2);
  const nz = ((b.x - a.x) / len) * (width / 2);
  const steps = Math.max(1, Math.ceil(len / 3));
  let prev: [number, number] | null = null;
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const z = a.y + ((b.y - a.y) * i) / steps;
    const v0 = gb.vertex(x + nx, world.heightAt(x + nx, z + nz) + lift, z + nz, 0, 1, 0, 0, 0, color);
    const v1 = gb.vertex(x - nx, world.heightAt(x - nx, z - nz) + lift, z - nz, 0, 1, 0, 0, 0, color);
    if (prev) gb.quadFacing(prev[0], prev[1], v1, v0, 0, 1, 0);
    prev = [v0, v1];
  }
}

/** An additive light pool on the ground: bright center fading to nothing at the rim. */
function pool(world: World, gb: GeoBuilder, x: number, z: number, r: number, color: THREE.Color): void {
  const c = gb.vertex(x, world.heightAt(x, z) + 0.06, z, 0, 1, 0, 0, 0, color);
  const n = 14;
  const rim: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    rim.push(gb.vertex(px, world.heightAt(px, pz) + 0.06, pz, 0, 1, 0, 0, 0, TINT.black));
  }
  for (let i = 0; i < n; i++) gb.triFacing(c, rim[i], rim[(i + 1) % n], 0, 1, 0);
}

/**
 * The street's lane markings as cityMeshes lays them (same lines, dash phase
 * and colors), keeping only the stretch of each dash that lies on the leaf
 * between channel distances l0 and l1. `v` makes a vertex at a world point.
 */
function markLeaf(
  gb: GeoBuilder,
  e: { width: number; lanes: number },
  m: { aP: { curb: { x: number; z: number } }; aN: { curb: { x: number; z: number } }; bP: { curb: { x: number; z: number } }; bN: { curb: { x: number; z: number } } },
  db: Drawbridge,
  l0: number,
  l1: number,
  v: (x: number, z: number, color: THREE.Color) => number,
): void {
  const a = { x: (m.aP.curb.x + m.aN.curb.x) / 2, z: (m.aP.curb.z + m.aN.curb.z) / 2 };
  const b = { x: (m.bP.curb.x + m.bN.curb.x) / 2, z: (m.bP.curb.z + m.bN.curb.z) / 2 };
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 8) return;
  const dx = (b.x - a.x) / len;
  const dz = (b.z - a.z) / len;
  const a2 = { x: a.x + dx * 5, z: a.z + dz * 5 };
  const b2 = { x: b.x - dx * 5, z: b.z - dz * 5 };
  const half = e.width / 2;
  const lo = Math.min(l0, l1);
  const hi = Math.max(l0, l1);
  const lAt = (x: number, z: number) => (x - db.cx) * db.mx + (z - db.cz) * db.mz;
  const line = (offset: number, width: number, dash: number, gap: number, color: THREE.Color) => {
    const ll = Math.hypot(b2.x - a2.x, b2.z - a2.z);
    if (ll < 1) return;
    const ux = (b2.x - a2.x) / ll;
    const uz = (b2.z - a2.z) / ll;
    const nx = -uz;
    const nz = ux;
    const period = dash + gap;
    for (let s = gap > 0 ? gap / 2 : 0; s < ll; s += gap > 0 ? period : 6) {
      const e1 = Math.min(ll, s + (gap > 0 ? dash : 6));
      let p0x = a2.x + ux * s + nx * offset;
      let p0z = a2.z + uz * s + nz * offset;
      let p1x = a2.x + ux * e1 + nx * offset;
      let p1z = a2.z + uz * e1 + nz * offset;
      // Clip the dash to the leaf's band of l.
      const q0 = lAt(p0x, p0z);
      const q1 = lAt(p1x, p1z);
      if (Math.max(q0, q1) <= lo || Math.min(q0, q1) >= hi) continue;
      const dq = q1 - q0;
      let t0 = 0;
      let t1 = 1;
      if (Math.abs(dq) > 1e-9) {
        const ta = (lo - q0) / dq;
        const tb = (hi - q0) / dq;
        t0 = Math.max(0, Math.min(ta, tb));
        t1 = Math.min(1, Math.max(ta, tb));
      }
      if (t1 - t0 < 1e-4) continue;
      const sx = p1x - p0x;
      const sz = p1z - p0z;
      p1x = p0x + sx * t1;
      p1z = p0z + sz * t1;
      p0x = p0x + sx * t0;
      p0z = p0z + sz * t0;
      const hw = width / 2;
      const ids = [
        v(p0x + nx * hw, p0z + nz * hw, color),
        v(p1x + nx * hw, p1z + nz * hw, color),
        v(p1x - nx * hw, p1z - nz * hw, color),
        v(p0x - nx * hw, p0z - nz * hw, color),
      ];
      gb.quadFacing(ids[0], ids[1], ids[2], ids[3], 0, 1, 0);
    }
  };
  if (e.lanes === 2) line(0, 0.16, 3, 5, TINT.markWhite);
  else {
    line(0.18, 0.14, 0, 0, TINT.markYellow);
    line(-0.18, 0.14, 0, 0, TINT.markYellow);
    line(half / 2, 0.14, 3, 6, TINT.markWhite);
    line(-half / 2, 0.14, 3, 6, TINT.markWhite);
  }
  line(half - 0.45, 0.14, 0, 0, TINT.markWhite);
  line(-(half - 0.45), 0.14, 0, 0, TINT.markWhite);
}
