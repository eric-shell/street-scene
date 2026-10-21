/**
 * Ambient traffic on screen (the cars of src/sim/traffic.ts). Render only:
 * it reads the session's two traffic snapshots and interpolates them with
 * the loop's alpha, like the race cars.
 *
 * Cheap by construction, whatever the count:
 *  - one low poly civilian silhouette per vehicle kind (sedan, hatch, van,
 *    taxi), code-built and merged into two instanced parts per kind: the
 *    paint (per instance colour, a muted street palette; taxis yellow) and
 *    the dark parts (glass, tyres, trim) in vertex colours;
 *  - every lamp of every car (head, tail, taxi roof sign) in one instanced
 *    box mesh with HDR instance colours for the bloom: brake lights flare,
 *    struck cars blink their hazards, fresh spawns fade their lamps in;
 *  - one instanced additive pool of headlight on the road ahead of each car
 *    (Medium and High).
 * That is ten draw calls at most. Cars beyond the tier's draw distance are
 * dropped, and only the nearest `cars` of the rest are filled in, so the
 * per frame cost is a few dozen matrix composes and terrain samples.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import type { TrafficState } from '../sim/traffic';
import { TRAFFIC } from '../sim/tuning';
import type { Quality } from '../ui/settings';
import { GeoBuilder } from './geoBuilder';
import { kelvin, makeRadialGlow } from './textures';
import { fadeSubPixel } from './lightFx';

/** Per tier: most cars drawn, draw distance (m), headlight pools on the road. */
export const TRAFFIC_QUALITY: Record<Quality, { cars: number; drawDistance: number; beams: boolean }> = {
  low: { cars: 14, drawDistance: 200, beams: false },
  medium: { cars: 26, drawDistance: 280, beams: true },
  high: { cars: 44, drawDistance: 360, beams: true },
};

/** Snapshot layout per car: x, z, yaw, kind (-1 gone), born tick, flags (1 braking, 2 struck). */
export const TRAFFIC_SNAP = 6;

/** Copy the traffic's poses into a snapshot buffer (TRAFFIC_SNAP floats per car). */
export function snapTraffic(t: TrafficState, out: Float32Array): void {
  for (let i = 0; i < t.cars.length; i++) {
    const c = t.cars[i];
    const o = i * TRAFFIC_SNAP;
    out[o] = c.body.x;
    out[o + 1] = c.body.z;
    out[o + 2] = c.body.yaw;
    out[o + 3] = c.mode === 'gone' ? -1 : c.kind;
    out[o + 4] = c.born;
    out[o + 5] = (c.braking ? 1 : 0) | (c.mode === 'loose' ? 2 : 0);
  }
}

/** Muted street paint; vans run white and silver, taxis are always yellow. */
const PAINTS = [0x9aa0a6, 0x3a3d42, 0x16171a, 0xd8d8d4, 0x1e2a44, 0x5a1a1f, 0x223a2c, 0x9c8b6e, 0x3f5468, 0xb8a98a, 0x6d7276, 0x2b2f3a].map((c) => new THREE.Color(c));
const VAN_PAINTS = [0xe6e6e2, 0xd0d2d4, 0x9aa0a6, 0x2b3a52].map((c) => new THREE.Color(c));
const TAXI = new THREE.Color(0xe2ae1c);

/** Lamp colours (HDR, for the bloom). */
const HEAD = new THREE.Color(kelvin(5200)).multiplyScalar(2.4);
const TAIL = new THREE.Color(0xff1a24).multiplyScalar(1.1);
const BRAKE = new THREE.Color(0xff1a24).multiplyScalar(2.8);
const HAZARD = new THREE.Color(0xffa030).multiplyScalar(2.2);
const SIGN = new THREE.Color(0xfff2c0).multiplyScalar(1.8);

/** Silhouette proportions per kind name (m): body height, cabin span and height, wheel radius, glazing. */
interface Shape {
  /** Top of the lower body (hood / belt line) and of the roof (m). */
  belt: number;
  roof: number;
  /** Cabin along the car as shares of the half length: rear and front of its base, rear and front of the roof. */
  cabin: [number, number, number, number];
  /** m */
  wheel: number;
  /** Side windows as spans along the cabin side (0 rear .. 1 front), pillars between them. */
  side: [number, number][];
  /** Rear window from this share of the cabin height up (1: none). */
  rear: number;
  /** Roof sign (taxi). */
  sign?: boolean;
}
const SEDAN: Shape = { belt: 0.82, roof: 1.44, cabin: [-0.58, 0.42, -0.4, 0.14], wheel: 0.33, side: [[0.07, 0.47], [0.53, 0.93]], rear: 0.1 };
const SHAPES: Record<string, Shape> = {
  sedan: SEDAN,
  hatch: { belt: 0.8, roof: 1.46, cabin: [-0.84, 0.36, -0.72, 0.06], wheel: 0.31, side: [[0.05, 0.36], [0.42, 0.93]], rear: 0.12 },
  // A delivery van: glass only in the cab, a small pair of windows in the back doors.
  van: { belt: 1.02, roof: 1.98, cabin: [-0.97, 0.62, -0.97, 0.4], wheel: 0.35, side: [[0.74, 0.95]], rear: 0.45 },
  taxi: { ...SEDAN, roof: 1.45, sign: true },
};

const GLASS = new THREE.Color(0x0d121b);
const TYRE = new THREE.Color(0x111214);
const TRIM = new THREE.Color(0x1d1e22);
const RIM = new THREE.Color(0x6a6e75);

type V3 = [number, number, number];

/**
 * A convex block from its bottom and top rectangles: [x0, x1, z0, z1] each,
 * faces wound outward. Returns its eight corners: bottom (-x -z, +x -z, +x +z,
 * -x +z), then the top in the same order.
 */
function block(b: GeoBuilder, y0: number, bot: [number, number, number, number], y1: number, top: [number, number, number, number], color?: THREE.Color): V3[] {
  const P = [
    [bot[0], y0, bot[2]],
    [bot[1], y0, bot[2]],
    [bot[1], y0, bot[3]],
    [bot[0], y0, bot[3]],
    [top[0], y1, top[2]],
    [top[1], y1, top[2]],
    [top[1], y1, top[3]],
    [top[0], y1, top[3]],
  ];
  const face = (ids: number[], nx: number, ny: number, nz: number) => {
    const v = ids.map((i) => b.vertex(P[i][0], P[i][1], P[i][2], nx, ny, nz, 0, 0, color));
    b.quadFacing(v[0], v[1], v[2], v[3], nx, ny, nz);
  };
  const n = (ax: number, ay: number, az: number) => {
    const l = Math.hypot(ax, ay, az) || 1;
    return [ax / l, ay / l, az / l] as const;
  };
  face([0, 1, 2, 3], 0, -1, 0);
  face([4, 5, 6, 7], 0, 1, 0);
  // Sides lean by how far the top is inset from the bottom.
  face([0, 3, 7, 4], ...n(-(y1 - y0), top[0] - bot[0], 0));
  face([1, 2, 6, 5], ...n(y1 - y0, bot[1] - top[1], 0));
  face([0, 1, 5, 4], ...n(0, top[2] - bot[2], -(y1 - y0)));
  face([3, 2, 6, 7], ...n(0, bot[3] - top[3], y1 - y0));
  return P as V3[];
}

/**
 * A glass panel on a face given by its corners (bottom start, bottom end, top
 * end, top start): the (u0..u1, v0..v1) part of it, lifted 1 cm off the face
 * along its outward normal (nx, ny, nz) so the paint around it is the pillars.
 */
function panel(b: GeoBuilder, q: V3[], u0: number, u1: number, v0: number, v1: number, nx: number, ny: number, nz: number): void {
  const at = (u: number, v: number) => {
    const p = [0, 1, 2].map((k) => {
      const lo = q[0][k] + (q[1][k] - q[0][k]) * u;
      const hi = q[3][k] + (q[2][k] - q[3][k]) * u;
      return lo + (hi - lo) * v;
    });
    return b.vertex(p[0] + nx * 0.012, p[1] + ny * 0.012, p[2] + nz * 0.012, nx, ny, nz, 0, 0, GLASS);
  };
  b.quadFacing(at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), nx, ny, nz);
}

/** Unit outward normal of a quad face (corners in perimeter order) of a convex shape centred at (0, cy, cz). */
function faceNormal(q: V3[], cy: number, cz: number): V3 {
  const ux = q[1][0] - q[0][0];
  const uy = q[1][1] - q[0][1];
  const uz = q[1][2] - q[0][2];
  const vx = q[3][0] - q[0][0];
  const vy = q[3][1] - q[0][1];
  const vz = q[3][2] - q[0][2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const mx = (q[0][0] + q[2][0]) / 2;
  const my = (q[0][1] + q[2][1]) / 2 - cy;
  const mz = (q[0][2] + q[2][2]) / 2 - cz;
  if (nx * mx + ny * my + nz * mz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** An eight sided tyre across the car at (x, y, z), its outer face a grey rim. */
function wheel(b: GeoBuilder, x: number, y: number, z: number, r: number, w: number): void {
  const out = x > 0 ? 1 : -1;
  const xi = x - (out * w) / 2;
  const xo = x + (out * w) / 2;
  const seg = 8;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const p = (xx: number, a: number, nx: number, ny: number, nz: number, c: THREE.Color) => b.vertex(xx, y + Math.cos(a) * r, z + Math.sin(a) * r, nx, ny, nz, 0, 0, c);
    const ny = Math.cos(am);
    const nz = Math.sin(am);
    const t = [p(xi, a0, 0, ny, nz, TYRE), p(xo, a0, 0, ny, nz, TYRE), p(xo, a1, 0, ny, nz, TYRE), p(xi, a1, 0, ny, nz, TYRE)];
    b.quadFacing(t[0], t[1], t[2], t[3], 0, ny, nz);
    const c = b.vertex(xo, y, z, out, 0, 0, 0, 0, RIM);
    b.triFacing(c, p(xo, a0, out, 0, 0, RIM), p(xo, a1, out, 0, 0, RIM), out, 0, 0);
  }
}

/** A lamp of a silhouette: a unit box placed and sized in car space, and what kind of lamp. */
export interface Lamp {
  m: THREE.Matrix4;
  role: 'head' | 'tail' | 'sign';
}

/** One kind's merged parts: paint (instance coloured), dark parts (vertex coloured), lamps. */
export interface KindKit {
  paint: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  lamps: Lamp[];
  /** m */
  halfLength: number;
}

/** The silhouette of a traffic kind (index into TRAFFIC.kinds), in car space: +z forward, y up, wheels on y = 0. */
export function buildKit(kind: number): KindKit {
  const k = TRAFFIC.kinds[kind];
  const sh = SHAPES[k.name] ?? SHAPES.sedan;
  const L = k.halfLength;
  const W = k.halfWidth;
  const paint = new GeoBuilder(false);
  const dark = new GeoBuilder(true);
  const floor = sh.wheel * 0.9;
  // Lower body: hood and trunk lines slightly rounded in.
  block(paint, floor, [-W, W, -L, L], sh.belt, [-W + 0.04, W - 0.04, -L + 0.12, L - 0.16]);
  // Cabin in paint, with glass panels on its faces: side windows between pillars, windscreen, rear window.
  const [cr0, cf0, cr1, cf1] = sh.cabin;
  const inset = sh.roof - sh.belt > 0.8 ? 0.06 : 0.14;
  const C = block(paint, sh.belt, [-W + 0.08, W - 0.08, cr0 * L, cf0 * L], sh.roof, [-W + inset, W - inset, cr1 * L, cf1 * L]);
  const cy = (sh.belt + sh.roof) / 2;
  const cz = ((cr0 + cf0) / 2) * L;
  for (const q of [
    [C[0], C[3], C[7], C[4]],
    [C[1], C[2], C[6], C[5]],
  ]) {
    const [nx, ny, nz] = faceNormal(q, cy, cz);
    for (const [u0, u1] of sh.side) panel(dark, q, u0, u1, 0.1, 0.86, nx, ny, nz);
  }
  const front = [C[3], C[2], C[6], C[7]];
  panel(dark, front, 0.06, 0.94, 0.06, 0.9, ...faceNormal(front, cy, cz));
  const back = [C[1], C[0], C[4], C[5]];
  if (sh.rear < 1) panel(dark, back, 0.08, 0.92, sh.rear, 0.88, ...faceNormal(back, cy, cz));
  // Bumpers and sills.
  block(dark, floor - 0.02, [-W + 0.02, W - 0.02, L - 0.1, L + 0.04], floor + 0.22, [-W + 0.02, W - 0.02, L - 0.1, L + 0.04], TRIM);
  block(dark, floor - 0.02, [-W + 0.02, W - 0.02, -L - 0.04, -L + 0.1], floor + 0.22, [-W + 0.02, W - 0.02, -L - 0.04, -L + 0.1], TRIM);
  const axle = L * 0.62;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) wheel(dark, sx * (W - 0.14), sh.wheel, sz * axle, sh.wheel, 0.24);
  const lamps: Lamp[] = [];
  const box = (x: number, y: number, z: number, sx: number, sy: number, sz: number, role: Lamp['role']) => lamps.push({ m: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz)), role });
  const lampY = (floor + sh.belt) / 2 + 0.06;
  for (const s of [-1, 1]) {
    box(s * (W - 0.24), lampY, L - 0.06, 0.34, 0.12, 0.1, 'head');
    box(s * (W - 0.2), lampY + 0.04, -L + 0.05, 0.3, 0.13, 0.1, 'tail');
  }
  if (sh.sign) box(0, sh.roof + 0.11, (cr1 + cf1) * 0.5 * L, 0.62, 0.2, 0.26, 'sign');
  return { paint: paint.build(), dark: dark.build(), lamps, halfLength: L };
}

/** Deterministic 0..1 hash of a car slot and its spawn tick (paint stays put for one spawn). */
function hash01(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class TrafficView {
  readonly group = new THREE.Group();
  private readonly kits: KindKit[];
  private readonly paintMeshes: THREE.InstancedMesh[] = [];
  private readonly darkMeshes: THREE.InstancedMesh[] = [];
  private readonly lampMesh: THREE.InstancedMesh;
  private readonly beamMesh: THREE.InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  /** Per frame scratch: picked car indices and their squared distances, nearest first. */
  private readonly pick: number[] = [];
  private readonly pickD: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly lm = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();
  private readonly perKind: number[];

  constructor(
    private readonly world: World,
    count: number,
  ) {
    this.group.name = 'traffic';
    this.kits = TRAFFIC.kinds.map((_, i) => buildKit(i));
    this.perKind = this.kits.map(() => 0);
    const paintMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.38, envMapIntensity: 1.2 });
    const darkMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.42, envMapIntensity: 1.3 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    // Tiny HDR emitters flicker in the distance without this (see lightFx.ts).
    fadeSubPixel(lampMat, 0.12, 0.3);
    const glowTex = makeRadialGlow();
    const beamMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x5d6676 });
    const lampGeo = new THREE.BoxGeometry(1, 1, 1);
    const beamGeo = new THREE.PlaneGeometry(7, 17).rotateX(-Math.PI / 2);
    this.disposables.push(paintMat, darkMat, lampMat, glowTex, beamMat, lampGeo, beamGeo);
    this.kits.forEach((kit, i) => {
      this.disposables.push(kit.paint, kit.dark);
      const pm = new THREE.InstancedMesh(kit.paint, paintMat, count);
      const dm = new THREE.InstancedMesh(kit.dark, darkMat, count);
      pm.setColorAt(0, this.c.setRGB(1, 1, 1));
      for (const mesh of [pm, dm]) {
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.name = `traffic:${TRAFFIC.kinds[i].name}`;
        this.group.add(mesh);
        this.disposables.push(mesh);
      }
      this.paintMeshes.push(pm);
      this.darkMeshes.push(dm);
    });
    const maxLamps = Math.max(...this.kits.map((k) => k.lamps.length));
    this.lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, Math.max(1, count * maxLamps));
    this.lampMesh.setColorAt(0, this.c.setRGB(1, 1, 1));
    this.beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, Math.max(1, count));
    this.beamMesh.renderOrder = 3;
    for (const mesh of [this.lampMesh, this.beamMesh]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(mesh);
    }
    this.lampMesh.name = 'trafficLamps';
    this.beamMesh.name = 'trafficBeams';
  }

  /**
   * Place the cars between two snapshots. `tick` is the sim tick of `curr`
   * (spawn fades), `time` the scene clock (s, hazard blink), `tier` the
   * quality tier for count, distance and pools.
   */
  update(prev: Float32Array, curr: Float32Array, alpha: number, camera: THREE.Camera, time: number, tier: Quality, tick: number): void {
    const q = TRAFFIC_QUALITY[tier] ?? TRAFFIC_QUALITY.medium;
    const cam = camera.position;
    const n = Math.floor(curr.length / TRAFFIC_SNAP);
    const maxD2 = q.drawDistance * q.drawDistance;
    // Nearest `q.cars` within the draw distance, by insertion into a short sorted list.
    const pick = this.pick;
    const pickD = this.pickD;
    pick.length = 0;
    pickD.length = 0;
    for (let i = 0; i < n; i++) {
      const o = i * TRAFFIC_SNAP;
      if (curr[o + 3] < 0) continue;
      const d2 = (curr[o] - cam.x) ** 2 + (curr[o + 1] - cam.z) ** 2;
      if (d2 > maxD2) continue;
      if (pick.length >= q.cars && d2 >= pickD[pick.length - 1]) continue;
      let k = Math.min(pick.length, q.cars - 1);
      if (pick.length < q.cars) {
        pick.push(i);
        pickD.push(d2);
      }
      while (k > 0 && pickD[k - 1] > d2) {
        pick[k] = pick[k - 1];
        pickD[k] = pickD[k - 1];
        k--;
      }
      pick[k] = i;
      pickD[k] = d2;
    }
    const perKind = this.perKind;
    perKind.fill(0);
    let lamps = 0;
    let beams = 0;
    const blink = Math.sin(time * 6.5) > 0;
    const lampArr = this.lampMesh.instanceMatrix.array as Float32Array;
    const lampCol = this.lampMesh.instanceColor!.array as Float32Array;
    const beamArr = this.beamMesh.instanceMatrix.array as Float32Array;
    for (const i of pick) {
      const o = i * TRAFFIC_SNAP;
      const kind = curr[o + 3];
      const kit = this.kits[kind];
      // A fresh spawn (or a car that just vanished and reappeared) is not interpolated.
      const same = prev[o + 3] === kind && prev[o + 4] === curr[o + 4];
      const t = same ? alpha : 1;
      const x = same ? prev[o] + (curr[o] - prev[o]) * t : curr[o];
      const z = same ? prev[o + 1] + (curr[o + 1] - prev[o + 1]) * t : curr[o + 1];
      const yaw = same ? lerpAngle(prev[o + 2], curr[o + 2], t) : curr[o + 2];
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const hl = kit.halfLength * 0.8;
      const hf = this.world.heightAt(x + fx * hl, z + fz * hl);
      const hb = this.world.heightAt(x - fx * hl, z - fz * hl);
      this.e.set(Math.atan2(hb - hf, 2 * hl), yaw, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p.set(x, (hf + hb) / 2 + 0.01, z), this.q, this.s);
      const slot = perKind[kind]++;
      const pm = this.paintMeshes[kind];
      this.m.toArray(pm.instanceMatrix.array as Float32Array, slot * 16);
      this.m.toArray(this.darkMeshes[kind].instanceMatrix.array as Float32Array, slot * 16);
      const name = TRAFFIC.kinds[kind].name;
      const h = hash01(i, curr[o + 4]);
      const paint = name === 'taxi' ? TAXI : name === 'van' ? VAN_PAINTS[Math.floor(h * VAN_PAINTS.length)] : PAINTS[Math.floor(h * PAINTS.length)];
      this.c.copy(paint).multiplyScalar(0.85 + 0.3 * hash01(curr[o + 4], i));
      this.c.toArray(pm.instanceColor!.array as Float32Array, slot * 3);
      // Lamps: fade in over the first second of a spawn; brake lights, hazards when struck.
      const flags = curr[o + 5];
      const fade = Math.min(1, Math.max(0, (tick - curr[o + 4]) / 60));
      const struck = (flags & 2) !== 0;
      for (const lamp of kit.lamps) {
        this.lm.multiplyMatrices(this.m, lamp.m);
        this.lm.toArray(lampArr, lamps * 16);
        const col = lamp.role === 'head' ? HEAD : lamp.role === 'sign' ? SIGN : struck ? (blink ? HAZARD : TAIL) : flags & 1 ? BRAKE : TAIL;
        this.c.copy(col).multiplyScalar(lamp.role === 'head' && struck ? 0.4 * fade : fade);
        this.c.toArray(lampCol, lamps * 3);
        lamps++;
      }
      if (q.beams && !struck) {
        this.lm.makeRotationY(yaw).setPosition(x + fx * (kit.halfLength + 8.2), (hf + hb) / 2 + 0.07, z + fz * (kit.halfLength + 8.2));
        this.lm.toArray(beamArr, beams * 16);
        beams++;
      }
    }
    for (let k = 0; k < this.kits.length; k++) {
      const pm = this.paintMeshes[k];
      const dm = this.darkMeshes[k];
      pm.count = dm.count = perKind[k];
      pm.instanceMatrix.needsUpdate = dm.instanceMatrix.needsUpdate = true;
      if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
    }
    this.lampMesh.count = lamps;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceColor!.needsUpdate = true;
    this.beamMesh.count = beams;
    this.beamMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
