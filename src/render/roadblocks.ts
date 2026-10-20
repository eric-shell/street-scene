/**
 * Parked car meets: side streets the racers are unlikely to hit are closed
 * with rows of parked cars behind the barrier line, hazards blinking, and the
 * long corner rails get a row or two of spectators' cars behind them. The
 * cars are the real garage models (manifest `selectable`), baked once into
 * four instanced parts per model (paint, dark details + wheels, glass, lights)
 * with random paint per instance. Placement never overlaps another car,
 * a building, a prop or the route corridor. Groups outside the view frustum
 * or the draw distance are dropped from the instance buffers. The collision
 * is still the barrier / rail wall. Render only.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import { Rng } from '../sim/prng';
import { CarAssetLibrary, MANIFEST, ManifestCar } from './carAssets';
import { buildPlaceholderCar } from './carView';
import { resolveMaterialName } from './carMaterials';
import { kelvin } from './textures';
import { BarrierInfo, railCurves } from './routeArrows';

const PAINTS = [0xc81e2e, 0x1d55c4, 0xe8e8ea, 0x15161a, 0xf2b81c, 0x2a9d5a, 0x6b2fc2, 0x9aa3ad, 0xff6a00, 0x101a3a, 0x7a0f1a].map((c) => new THREE.Color(c));

/** A cluster of parked cars (one closed street, or one corner rail). */
export interface CarGroup {
  /** The closed street this group blocks; null for cars behind a corner rail. */
  barrier: BarrierInfo | null;
  /** Centroid of the cars and the ground height there. */
  x: number;
  y: number;
  z: number;
  radius: number;
  cars: number;
}

export interface Roadblocks {
  group: THREE.Group;
  groups: CarGroup[];
  /** Cull groups against the camera (call before rendering; cheap when nothing changed). */
  update(camera: THREE.Camera): void;
  dispose(): void;
}

export interface RoadblockOptions {
  /** Rows of cars behind each closed street barrier. */
  rows?: number;
  /** Rows of cars behind each corner rail. */
  railRows?: number;
  /** Groups further than this from the camera are not drawn (fog hides them anyway). */
  drawDistance?: number;
}

// ---------------------------------------------------------------------------
// Car kits: one garage model baked into instanceable parts (cached per app).
// ---------------------------------------------------------------------------

const PART_PAINT = 0;
const PART_DARK = 1;
const PART_GLASS = 2;
const PART_LIGHTS = 3;

interface CarKit {
  car: ManifestCar;
  /** Indexed by PART_*; null when the model has no such part. */
  geos: (THREE.BufferGeometry | null)[];
}

let library: CarAssetLibrary | null = null;
const kitCache = new Map<string, Promise<CarKit>>();

function parkedCars(): ManifestCar[] {
  const sel = MANIFEST.cars.filter((c) => (c as unknown as { selectable?: boolean }).selectable);
  return sel.length ? sel : MANIFEST.cars.slice(0, 1);
}

function loadKit(car: ManifestCar): Promise<CarKit> {
  let p = kitCache.get(car.id);
  if (!p) {
    library ??= new CarAssetLibrary();
    p = library
      .carModel(car.id)
      .catch(() => null)
      .then((m) => bakeKit(car, m ?? buildPlaceholderCar(car)));
    kitCache.set(car.id, p);
  }
  return p;
}

const DARK_COLORS: Record<string, number> = { Trim: 0x15161a, Black: 0x0b0b0d, Chrome: 0xb0b4bc, Rim: 0x8a8f99, Tire: 0x141414, Interior: 0x1a1a1e };

class Bucket {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  build(withColor: boolean): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Flatten every visible mesh of the model into car space, bucketed by material. */
function bakeKit(car: ManifestCar, model: THREE.Object3D): CarKit {
  const buckets = [new Bucket(), new Bucket(), new Bucket(), new Bucket()];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  const c = new THREE.Color();
  model.updateMatrixWorld(true);
  const head = new THREE.Color(kelvin(5200)).multiplyScalar(2.2);
  const tail = new THREE.Color(0xff1a2a).multiplyScalar(1.6);
  const amber = new THREE.Color(0xffa040).multiplyScalar(1.2);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (!p.visible) return;
    let geo = mesh.geometry;
    if (!geo.attributes.normal) {
      geo = geo.clone();
      geo.computeVertexNormals();
    }
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const index = geo.index;
    nm.getNormalMatrix(mesh.matrixWorld);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const total = index ? index.count : pos.count;
    const ranges = Array.isArray(mesh.material) && geo.groups.length ? geo.groups : [{ start: 0, count: total, materialIndex: 0 }];
    for (const r of ranges) {
      const mat = mats[r.materialIndex ?? 0] ?? mats[0];
      const name = resolveMaterialName((mat?.userData.sourceName as string) ?? mat?.name ?? '', car.materialMap);
      let part = PART_DARK;
      c.setHex(DARK_COLORS[name ?? ''] ?? 0x202024);
      if (name === 'Paint') part = PART_PAINT;
      else if (name === 'Glass') part = PART_GLASS;
      else if (name === 'HeadLight' || name === 'TailLight' || name === 'Light') {
        part = PART_LIGHTS;
        c.copy(name === 'HeadLight' ? head : name === 'TailLight' ? tail : amber);
      }
      const b = buckets[part];
      const end = Math.min(total, r.start + r.count);
      for (let k = r.start; k < end; k++) {
        const i = index ? index.getX(k) : k;
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        b.pos.push(v.x, v.y, v.z);
        b.nor.push(n.x, n.y, n.z);
        b.col.push(c.r, c.g, c.b);
      }
    }
    if (geo !== mesh.geometry) geo.dispose();
  });
  // Low poly wheels (parked cars' wheels sit mostly inside the arches).
  const dark = buckets[PART_DARK];
  const tire = new THREE.Color(0x141414);
  const rim = new THREE.Color(0x8a8f99);
  const seg = 12;
  for (const key of ['FL', 'FR', 'RL', 'RR'] as const) {
    const [wx, wy, wz] = car.wheels[key];
    const r = car.wheelRadius;
    const out = wx > 0 ? 1 : -1;
    const x0 = wx - out * car.wheelWidth / 2;
    const x1 = wx + out * car.wheelWidth / 2;
    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, col: THREE.Color) => {
      dark.pos.push(x, y, z);
      dark.nor.push(nx, ny, nz);
      dark.col.push(col.r, col.g, col.b);
    };
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2;
      const a1 = ((k + 1) / seg) * Math.PI * 2;
      const y0 = wy + Math.cos(a0) * r, z0 = wz + Math.sin(a0) * r;
      const y1 = wy + Math.cos(a1) * r, z1 = wz + Math.sin(a1) * r;
      const ny0 = Math.cos(a0), nz0 = Math.sin(a0), ny1 = Math.cos(a1), nz1 = Math.sin(a1);
      // tread (both windings are not needed: seen from outside only)
      const tread: [number, number, number, number, number, number][] = [
        [x0, y0, z0, 0, ny0, nz0],
        [x1, y0, z0, 0, ny0, nz0],
        [x1, y1, z1, 0, ny1, nz1],
        [x0, y0, z0, 0, ny0, nz0],
        [x1, y1, z1, 0, ny1, nz1],
        [x0, y1, z1, 0, ny1, nz1],
      ];
      // wind so the outward normal faces out: flip for the right side
      const order = out > 0 ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
      for (const o of order) push(tread[o][0], tread[o][1], tread[o][2], tread[o][3], tread[o][4], tread[o][5], tire);
      // outer face: rim disc
      const fy = wy + Math.cos(a0) * r * 0.72, fz = wz + Math.sin(a0) * r * 0.72;
      const gy = wy + Math.cos(a1) * r * 0.72, gz = wz + Math.sin(a1) * r * 0.72;
      const face = out > 0 ? [[x1, wy, wz], [x1, fy, fz], [x1, gy, gz]] : [[x1, wy, wz], [x1, gy, gz], [x1, fy, fz]];
      for (const [x, y, z] of face) push(x, y, z, out, 0, 0, rim);
      const ring = out > 0 ? [[x1, fy, fz], [x1, y0, z0], [x1, y1, z1], [x1, fy, fz], [x1, y1, z1], [x1, gy, gz]] : [[x1, fy, fz], [x1, y1, z1], [x1, y0, z0], [x1, fy, fz], [x1, gy, gz], [x1, y1, z1]];
      for (const [x, y, z] of ring) push(x, y, z, out, 0, 0, tire);
    }
  }
  return { car, geos: [buckets[0].build(false), buckets[1].build(true), buckets[2].build(false), buckets[3].build(true)] };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Circles in a uniform hash, for overlap tests between cars and props. */
class CircleHash {
  private cells = new Map<number, number[]>();
  constructor(private readonly size: number) {}
  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }
  add(x: number, z: number, r: number): void {
    const s = this.size;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++) {
      for (let cz = Math.floor((z - r) / s); cz <= Math.floor((z + r) / s); cz++) {
        const k = this.key(cx, cz);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(x, z, r);
      }
    }
  }
  hits(x: number, z: number, r: number): boolean {
    const s = this.size;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++) {
      for (let cz = Math.floor((z - r) / s); cz <= Math.floor((z + r) / s); cz++) {
        const l = this.cells.get(this.key(cx, cz));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 3) {
          const m = l[i + 2] + r;
          if ((l[i] - x) ** 2 + (l[i + 1] - z) ** 2 < m * m) return true;
        }
      }
    }
    return false;
  }
}

interface Placed {
  kit: number;
  x: number;
  z: number;
  yaw: number;
  hazards: boolean;
}

/** One closed street's barrier line (barrier walls along the same mouth merged). */
interface Mouth {
  info: BarrierInfo;
  ax: number;
  az: number;
  dx: number;
  dz: number;
  len: number;
  /** Car group (one per barrier group). */
  group: number;
  /** Free depth behind the barrier. */
  depth: number;
}

/** Side closures from the sim's barrier groups: one car group per group, one row block per segment. */
function groupMouths(world: World, barriers: BarrierInfo[]): Mouth[] | null {
  const groups = world.barrierGroups;
  if (!groups) return null;
  const info = new Map(barriers.map((b) => [b.wall, b]));
  const out: Mouth[] = [];
  groups.forEach((g, gi) => {
    for (const w of g.walls) {
      const b = info.get(w);
      if (!b || b.headOn) continue;
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
      out.push({ info: b, ax: w.ax, az: w.az, dx: (w.bx - w.ax) / len, dz: (w.bz - w.az) / len, len, group: gi, depth: g.depth });
    }
  });
  return out;
}

/** Fallback when the world has no barrier groups: merge collinear segments of the same closure. */
function mergeMouths(barriers: BarrierInfo[]): Mouth[] {
  const out: Mouth[] = [];
  const used = new Set<BarrierInfo>();
  for (const b of barriers) {
    if (b.headOn || used.has(b)) continue;
    const w = b.wall;
    const l0 = Math.hypot(w.bx - w.ax, w.bz - w.az) || 1;
    const dx = (w.bx - w.ax) / l0;
    const dz = (w.bz - w.az) / l0;
    let lo = 0;
    let hi = l0;
    // Segments of the same closure: same node, same direction into the street, on the same line.
    for (const o of barriers) {
      if (o === b || o.headOn || used.has(o) || o.node !== b.node || o.sx * b.sx + o.sz * b.sz < 0.95) continue;
      const off = (o.x - w.ax) * w.nx + (o.z - w.az) * w.nz;
      if (Math.abs(off) > 1) continue;
      used.add(o);
      for (const [px, pz] of [
        [o.wall.ax, o.wall.az],
        [o.wall.bx, o.wall.bz],
      ]) {
        const t = (px - w.ax) * dx + (pz - w.az) * dz;
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    used.add(b);
    out.push({ info: b, ax: w.ax + dx * lo, az: w.az + dz * lo, dx, dz, len: hi - lo, group: out.length, depth: Infinity });
  }
  return out;
}

export function buildRoadblocks(world: World, barriers: BarrierInfo[], hazardMaterial: THREE.Material, opts: RoadblockOptions = {}): Roadblocks {
  const rows = opts.rows ?? 4;
  const railRows = opts.railRows ?? 1;
  const drawDistance = opts.drawDistance ?? 300;
  const group = new THREE.Group();
  group.name = 'carMeets';
  const rng = new Rng(world.seed ^ 0xb10c);
  const cars = parkedCars();
  const route = world.route;

  // Obstacles: props and buildings (in a coarse grid), plus every car placed so far.
  const taken = new CircleHash(8);
  for (const p of world.blocks.props ?? []) taken.add(p.x, p.z, p.radius + 0.25);
  const B = world.blocks.buildings;
  const bCell = 32;
  const bGrid = new Map<number, number[]>();
  const bKey = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  B.forEach((b, i) => {
    const r = Math.hypot(b.w, b.d) / 2 + 2; // padded so a car circle near a cell edge still sees it
    for (let cx = Math.floor((b.x - r) / bCell); cx <= Math.floor((b.x + r) / bCell); cx++) {
      for (let cz = Math.floor((b.z - r) / bCell); cz <= Math.floor((b.z + r) / bCell); cz++) {
        const k = bKey(cx, cz);
        let l = bGrid.get(k);
        if (!l) bGrid.set(k, (l = []));
        l.push(i);
      }
    }
  });
  const hitsBuilding = (x: number, z: number, r: number): boolean => {
    const l = bGrid.get(bKey(Math.floor(x / bCell), Math.floor(z / bCell)));
    if (!l) return false;
    for (const i of l) {
      const b = B[i];
      const px = x - b.x;
      const pz = z - b.z;
      const lx = Math.abs(px * Math.cos(b.yaw) - pz * Math.sin(b.yaw)) - b.w / 2;
      const lz = Math.abs(px * Math.sin(b.yaw) + pz * Math.cos(b.yaw)) - b.d / 2;
      const ex = Math.max(lx, 0);
      const ez = Math.max(lz, 0);
      if (ex * ex + ez * ez < r * r) return true;
    }
    return false;
  };
  const onRoute = (x: number, z: number, r: number): boolean => {
    const p = world.routeProgress(x, z);
    return Math.abs(p.lateral) < route.segWidth[p.seg] / 2 + r + 0.6;
  };

  const placed: Placed[] = [];
  const groupCars: number[][] = [];
  const circles = new Float32Array(9);
  /** Try to park car kit k at (x, z, yaw); returns false (and parks nothing) if anything is in the way. */
  const park = (gi: number, k: number, x: number, z: number, yaw: number, hazards: boolean): boolean => {
    const d = cars[k].dimensions;
    const r = d.width / 2 + 0.1;
    const off = d.length / 2 - r;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    for (let i = 0; i < 3; i++) {
      const s = (i - 1) * off;
      const cx = x + fx * s;
      const cz = z + fz * s;
      if (taken.hits(cx, cz, r) || hitsBuilding(cx, cz, r) || onRoute(cx, cz, r)) return false;
      circles[i * 3] = cx;
      circles[i * 3 + 1] = cz;
      circles[i * 3 + 2] = r;
    }
    for (let i = 0; i < 3; i++) taken.add(circles[i * 3], circles[i * 3 + 1], circles[i * 3 + 2]);
    groupCars[gi].push(placed.length);
    placed.push({ kit: k, x, z, yaw, hazards });
    return true;
  };
  const pickKit = () => rng.int(0, cars.length - 1);

  // Closed side streets: front rows of every street first so they win over the back rows of a neighbor.
  const mouths = groupMouths(world, barriers) ?? mergeMouths(barriers);
  // Car groups: one per barrier group (indexed by Mouth.group), compacted below.
  const groupInfo: (BarrierInfo | null)[] = [];
  const groupOf = new Map<number, number>();
  for (const m of mouths) {
    if (groupOf.has(m.group)) continue;
    groupOf.set(m.group, groupCars.length);
    groupInfo.push(m.info);
    groupCars.push([]);
  }
  for (let r = 0; r < rows; r++) {
    mouths.forEach((m) => {
      const gi = groupOf.get(m.group)!;
      const w = m.info.wall;
      const ix = -w.nx;
      const iz = -w.nz;
      const trackYaw = Math.atan2(w.nx, w.nz);
      const depth = 2.7 + r * 5.6 + rng.range(-0.3, 0.3);
      // Stay short of the far end of the side street (or the barrier closing it there).
      if (depth + 2.4 > m.depth) return;
      const slots = Math.max(1, Math.floor((m.len - 0.4) / 2.75));
      for (let k = 0; k < slots; k++) {
        if (r > 0 && rng.chance(0.18)) continue; // gaps further back
        const along = ((k + 0.5) / slots) * m.len + rng.range(-0.3, 0.3);
        const roll = rng.next();
        // Mostly nose to the track, some angled, a few broadside.
        const broad = r > 0 && roll >= 0.92;
        if (broad && k % 2 === 1) continue; // broadside cars take two slots
        const yaw = broad ? Math.atan2(m.dx, m.dz) + rng.pick([0, Math.PI]) : roll < 0.75 ? trackYaw + rng.range(-0.25, 0.25) : trackYaw + rng.pick([-1, 1]) * rng.range(0.45, 0.8);
        const extra = broad ? 0 : rng.range(-0.2, 0.5);
        const kit = pickKit();
        const x = m.ax + m.dx * along + ix * (depth + extra);
        const z = m.az + m.dz * along + iz * (depth + extra);
        // Try the other model if the first one does not fit.
        if (!park(gi, kit, x, z, yaw, r === 0) && cars.length > 1) park(gi, (kit + 1) % cars.length, x, z, yaw, r === 0);
      }
    });
  }

  // Corner rails: a row or two of cars behind the rail, nose to the track.
  for (const curve of railCurves(world)) {
    const gi = groupCars.length;
    groupInfo.push(null);
    groupCars.push([]);
    const segLen = curve.map((w) => Math.hypot(w.bx - w.ax, w.bz - w.az));
    const total = segLen.reduce((a, b) => a + b, 0);
    for (let r = 0; r < railRows; r++) {
      for (let s = 2 + (r % 2) * 1.4; s < total - 2; s += 2.8 + rng.range(0, 0.6)) {
        let i = 0;
        let acc = 0;
        while (i < curve.length - 1 && acc + segLen[i] < s) acc += segLen[i++];
        const w = curve[i];
        const t = (s - acc) / (segLen[i] || 1);
        const px = w.ax + (w.bx - w.ax) * t;
        const pz = w.az + (w.bz - w.az) * t;
        const depth = 3.3 + r * 5.6 + rng.range(-0.2, 0.4);
        const yaw = Math.atan2(w.nx, w.nz) + rng.range(-0.25, 0.25);
        if (rng.chance(0.12)) continue;
        park(gi, pickKit(), px - w.nx * depth, pz - w.nz * depth, yaw, false);
      }
    }
  }

  // Groups (bounding spheres for culling).
  const groups: CarGroup[] = groupCars.map((list, gi) => {
    let x = 0;
    let z = 0;
    for (const c of list) {
      x += placed[c].x;
      z += placed[c].z;
    }
    x /= Math.max(1, list.length);
    z /= Math.max(1, list.length);
    let radius = 0;
    for (const c of list) radius = Math.max(radius, Math.hypot(placed[c].x - x, placed[c].z - z));
    return { barrier: groupInfo[gi], x, y: world.heightAt(x, z), z, radius: radius + 3.5, cars: list.length };
  });

  // Instance matrices per car and per hazard lamp.
  const carMats = new Float32Array(placed.length * 16);
  const paints = new Float32Array(placed.length * 3);
  const hazardList: number[] = [];
  const groupHazards: number[][] = groupCars.map(() => []);
  {
    const m = new THREE.Matrix4();
    const lamp = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    placed.forEach((car, i) => {
      q.setFromAxisAngle(up, car.yaw);
      m.compose(p.set(car.x, world.heightAt(car.x, car.z) + 0.02, car.z), q, s.set(1, 1, 1));
      m.toArray(carMats, i * 16);
      c.copy(PAINTS[rng.int(0, PAINTS.length - 1)]).multiplyScalar(rng.range(0.7, 1.05));
      paints.set([c.r, c.g, c.b], i * 3);
    });
    groupCars.forEach((list, gi) => {
      for (const ci of list) {
        const car = placed[ci];
        if (!car.hazards) continue;
        const d = cars[car.kit].dimensions;
        m.fromArray(carMats, ci * 16);
        for (const [lx, ly, lz] of [
          [d.width * 0.4, 0.62, d.length / 2 - 0.05],
          [-d.width * 0.4, 0.62, d.length / 2 - 0.05],
          [d.width * 0.42, 0.76, -d.length / 2 + 0.05],
          [-d.width * 0.42, 0.76, -d.length / 2 + 0.05],
        ]) {
          lamp.compose(p.set(lx, ly, lz), q.identity(), s.set(0.16, 0.07, 0.08)).premultiply(m);
          groupHazards[gi].push(hazardList.length / 16);
          for (const v of lamp.elements) hazardList.push(v);
        }
      }
    });
  }

  const hazardMats = new Float32Array(hazardList);

  // ---------- Meshes (filled once the car models are loaded) ----------
  const paintMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.6 });
  const darkMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0c1018, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.85, envMapIntensity: 1.4 });
  const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const partMats = [paintMat, darkMat, glassMat, lightMat];
  const disposables: { dispose(): void }[] = [...partMats];
  const kitMeshes: (THREE.InstancedMesh | null)[][] = cars.map(() => [null, null, null, null]);
  const kitCount = cars.map((_, k) => placed.filter((c) => c.kit === k).length);
  const hazardGeo = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(hazardGeo);
  const hazardCount = hazardMats.length / 16;
  const hazardMesh = new THREE.InstancedMesh(hazardGeo, hazardMaterial, Math.max(1, hazardCount));
  hazardMesh.count = 0;
  hazardMesh.frustumCulled = false;
  hazardMesh.name = 'carMeetHazards';
  group.add(hazardMesh);
  disposables.push(hazardMesh);

  const visible = new Uint8Array(groups.length);
  let dirty = true;
  let disposed = false;
  const fill = () => {
    dirty = false;
    cars.forEach((_, k) => {
      const ms = kitMeshes[k];
      if (!ms.some((m) => m)) return;
      let n = 0;
      groupCars.forEach((list, gi) => {
        if (!visible[gi]) return;
        for (const ci of list) {
          if (placed[ci].kit !== k) continue;
          for (const m of ms) if (m) (m.instanceMatrix.array as Float32Array).set(carMats.subarray(ci * 16, ci * 16 + 16), n * 16);
          const pm = ms[PART_PAINT];
          if (pm) (pm.instanceColor!.array as Float32Array).set(paints.subarray(ci * 3, ci * 3 + 3), n * 3);
          n++;
        }
      });
      for (const m of ms) {
        if (!m) continue;
        m.count = n;
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    });
    let h = 0;
    groupHazards.forEach((list, gi) => {
      if (!visible[gi]) return;
      for (const hi of list) (hazardMesh.instanceMatrix.array as Float32Array).set(hazardMats.subarray(hi * 16, hi * 16 + 16), h++ * 16);
    });
    hazardMesh.count = h;
    hazardMesh.instanceMatrix.needsUpdate = true;
  };

  cars.forEach((car, k) => {
    if (!kitCount[k]) return;
    loadKit(car).then((kit) => {
      if (disposed) return;
      kit.geos.forEach((geo, part) => {
        if (!geo) return;
        const mesh = new THREE.InstancedMesh(geo, partMats[part], kitCount[k]);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.name = `carMeet:${car.id}:${part}`;
        if (part === PART_PAINT) mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        if (part === PART_GLASS) mesh.renderOrder = 3;
        kitMeshes[k][part] = mesh;
        group.add(mesh);
        disposables.push(mesh); // the baked geometry is shared (cached per app), only the instances go
      });
      dirty = true;
    });
  });

  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();
  return {
    group,
    groups,
    update(camera) {
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
      camPos.setFromMatrixPosition(camera.matrixWorld);
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        sphere.center.set(g.x, g.y + 1, g.z);
        sphere.radius = g.radius;
        const vis = g.cars > 0 && sphere.center.distanceTo(camPos) - g.radius < drawDistance && frustum.intersectsSphere(sphere) ? 1 : 0;
        if (vis !== visible[gi]) {
          visible[gi] = vis;
          dirty = true;
        }
      }
      if (dirty) fill();
    },
    dispose() {
      disposed = true;
      for (const d of disposables) d.dispose();
    },
  };
}
