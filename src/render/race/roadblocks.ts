/**
 * Street meet cars: the parked cars of every meet behind the cyan barriers
 * (placed by meetPlan.ts, nose to the course as if they pulled in to watch).
 * Each is a real garage model (manifest `selectable`) in one of a few
 * customization variants (stock, or a body kit with a spoiler and coloured
 * wheels), baked once into four instanced parts per variant (paint, dark details
 * + wheels, glass, lights), with random paint per instance, underglow on many
 * and hazards blinking on some front row cars. Meets outside the view frustum
 * or the draw distance are dropped from the instance buffers. Nothing here
 * collides: the rail in front of the meet is the closure. Render only.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import { CarAssetLibrary, MANIFEST, ManifestCar, partsFor } from '../car/carAssets';
import { buildPlaceholderCar } from '../car/carView';
import { resolveMaterialName } from '../car/carMaterials';
import { kelvin } from '../color';
import { Disposer } from '../disposer';
import { canvas } from '../textures/canvasKit';
import type { PartEntry } from '../../shared/parts';
import type { MeetPlan } from './meetPlan';
import { maskVehicleMesh, underVehicles } from '../vehicleMask';

/** Street paint: classics plus the loud colours a meet is full of. */
const PAINTS = [0xc81e2e, 0x1d55c4, 0xe8e8ea, 0x15161a, 0xf2b81c, 0x2a9d5a, 0x6b2fc2, 0x9aa3ad, 0xff6a00, 0x101a3a, 0x7a0f1a, 0x7cff3a, 0xff2d9a, 0x19c8ff, 0xffe14a, 0x9a3cff].map((c) => new THREE.Color(c));
/** Underglow colours. */
const GLOWS = [0x19e6ff, 0xff3df2, 0x9a7bff, 0x3dff9a, 0xff2e5b, 0xffb02e].map((c) => new THREE.Color(c).multiplyScalar(2.2));
/** Wheel colours per variant: stock silver, black, gold. */
const WHEEL_COLORS = [0x8a8f99, 0x1a1b1f, 0xc9a227].map((c) => new THREE.Color(c));
/** Variants per model: stock, then body kits with spoilers. */
export const MEET_VARIANTS = 3;

export interface Roadblocks {
  group: THREE.Group;
  /** Cull meets against the camera (call before rendering; cheap when nothing changed). */
  update(camera: THREE.Camera): void;
  dispose(): void;
}

export interface RoadblockOptions {
  /** Meets further than this from the camera are not drawn (fog hides them anyway). */
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

/** The parts of variant v of a model: stock, then each body kit with a spoiler (whatever the catalog has). */
function variantParts(car: ManifestCar, v: number): PartEntry[] {
  if (v === 0) return [];
  const bodies = partsFor(car.id, 'body');
  const spoilers = partsFor(car.id, 'spoiler');
  const out: PartEntry[] = [];
  const body = bodies[(v - 1) % Math.max(1, bodies.length)];
  if (body) out.push(body);
  const spoiler = spoilers[(v - 1) % Math.max(1, spoilers.length)];
  if (spoiler) out.push(spoiler);
  return out;
}

let library: CarAssetLibrary | null = null;
const kitCache = new Map<string, Promise<CarKit>>();

export function parkedCars(): ManifestCar[] {
  const sel = MANIFEST.cars.filter((c) => (c as unknown as { selectable?: boolean }).selectable);
  return sel.length ? sel : MANIFEST.cars.slice(0, 1);
}

function loadKit(car: ManifestCar, variant: number): Promise<CarKit> {
  const key = `${car.id}:${variant}`;
  let p = kitCache.get(key);
  if (!p) {
    library ??= new CarAssetLibrary();
    const lib = library;
    const entries = variantParts(car, variant);
    p = Promise.all([lib.carModel(car.id).catch(() => null), ...entries.map((e) => lib.part(e).catch(() => null))]).then(([model, ...parts]) => {
      const root = new THREE.Group();
      const base = model ?? buildPlaceholderCar(car);
      root.add(base);
      // A body kit replaces the stock body: hide what each part says it hides, then add the parts.
      for (const e of entries) for (const name of e.hides) {
        const o = base.getObjectByName(name);
        if (o) o.visible = false;
      }
      for (const part of parts) if (part) root.add(part);
      return bakeKit(car, root, WHEEL_COLORS[variant % WHEEL_COLORS.length]);
    });
    kitCache.set(key, p);
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
function bakeKit(car: ManifestCar, model: THREE.Object3D, wheelColor: THREE.Color): CarKit {
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
      // outer face: wheel disc
      const fy = wy + Math.cos(a0) * r * 0.72, fz = wz + Math.sin(a0) * r * 0.72;
      const gy = wy + Math.cos(a1) * r * 0.72, gz = wz + Math.sin(a1) * r * 0.72;
      const face = out > 0 ? [[x1, wy, wz], [x1, fy, fz], [x1, gy, gz]] : [[x1, wy, wz], [x1, gy, gz], [x1, fy, fz]];
      for (const [x, y, z] of face) push(x, y, z, out, 0, 0, wheelColor);
      const ring = out > 0 ? [[x1, fy, fz], [x1, y0, z0], [x1, y1, z1], [x1, fy, fz], [x1, y1, z1], [x1, gy, gz]] : [[x1, fy, fz], [x1, y1, z1], [x1, y0, z0], [x1, fy, fz], [x1, gy, gz], [x1, y1, z1]];
      for (const [x, y, z] of ring) push(x, y, z, out, 0, 0, tire);
    }
  }
  return { car, geos: [buckets[0].build(false), buckets[1].build(true), buckets[2].build(false), buckets[3].build(true)] };
}

// ---------------------------------------------------------------------------
// Meets
// ---------------------------------------------------------------------------

/** Underglow: a soft oval pool of light, drawn flat on the ground under the car. */
function glowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 128);
  const grad = g.createRadialGradient(32, 64, 4, 32, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.save();
  g.scale(0.5, 1);
  g.fillRect(0, 0, 128, 128);
  g.restore();
  return new THREE.CanvasTexture(c);
}

export function buildRoadblocks(world: World, plan: MeetPlan, hazardMaterial: THREE.Material, opts: RoadblockOptions = {}): Roadblocks {
  const drawDistance = opts.drawDistance ?? 300;
  const group = new THREE.Group();
  group.name = 'carMeets';
  const cars = parkedCars();
  const placed = plan.cars;
  const zones = plan.zones;
  const kitOf = (i: number) => placed[i].model * MEET_VARIANTS + (placed[i].variant % MEET_VARIANTS);
  const kitCount = cars.length * MEET_VARIANTS;
  const perKit = new Array(kitCount).fill(0);
  placed.forEach((_, i) => perKit[kitOf(i)]++);

  // Instance matrices and paint per car; hazard lamps and underglow per meet.
  const carMats = new Float32Array(placed.length * 16);
  const paints = new Float32Array(placed.length * 3);
  const hazardList: number[] = [];
  const zoneHazards: number[][] = zones.map(() => []);
  const glowMats: number[] = [];
  const glowCols: number[] = [];
  const zoneGlows: number[][] = zones.map(() => []);
  {
    const m = new THREE.Matrix4();
    const lamp = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    placed.forEach((car, i) => {
      q.setFromAxisAngle(up, car.yaw);
      m.compose(p.set(car.x, world.heightAt(car.x, car.z) + 0.02, car.z), q, s.set(1, 1, 1));
      m.toArray(carMats, i * 16);
      c.copy(PAINTS[Math.floor(car.paint * PAINTS.length) % PAINTS.length]).multiplyScalar(0.72 + 0.34 * ((car.paint * 7.31) % 1));
      paints.set([c.r, c.g, c.b], i * 3);
    });
    zones.forEach((zone, zi) => {
      for (const ci of zone.cars) {
        const car = placed[ci];
        const d = cars[car.model].dimensions;
        m.fromArray(carMats, ci * 16);
        q.setFromAxisAngle(up, car.yaw);
        if (car.glow >= 0) {
          // Flat on the ground, a little bigger than the car.
          const gq = q.clone().multiply(flat);
          const gm = new THREE.Matrix4().compose(p.set(car.x, world.heightAt(car.x, car.z) + 0.05, car.z), gq, s.set(d.width + 0.9, d.length + 1.2, 1));
          zoneGlows[zi].push(glowMats.length / 16);
          for (const v of gm.elements) glowMats.push(v);
          const gc = GLOWS[Math.floor(car.glow * GLOWS.length) % GLOWS.length];
          glowCols.push(gc.r, gc.g, gc.b);
        }
        if (!car.hazards) continue;
        for (const [lx, ly, lz] of [
          [d.width * 0.4, 0.62, d.length / 2 - 0.05],
          [-d.width * 0.4, 0.62, d.length / 2 - 0.05],
          [d.width * 0.42, 0.76, -d.length / 2 + 0.05],
          [-d.width * 0.42, 0.76, -d.length / 2 + 0.05],
        ]) {
          lamp.compose(p.set(lx, ly, lz), q.identity(), s.set(0.16, 0.07, 0.08)).premultiply(m);
          zoneHazards[zi].push(hazardList.length / 16);
          for (const v of lamp.elements) hazardList.push(v);
        }
      }
    });
  }
  const hazardMats = new Float32Array(hazardList);
  const glowMatArr = new Float32Array(glowMats);
  const glowColArr = new Float32Array(glowCols);

  // ---------- Meshes (filled once the car models are loaded) ----------
  const res = new Disposer();
  const { track } = res;
  const paintMat = track(new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.6 }));
  const darkMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.5 }));
  const glassMat = track(new THREE.MeshStandardMaterial({ color: 0x0c1018, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.85, envMapIntensity: 1.4 }));
  const lightMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const glowMat = track(new THREE.MeshBasicMaterial({ map: track(glowTexture()), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  underVehicles(glowMat);
  const partMats = [paintMat, darkMat, glassMat, lightMat];
  const kitMeshes: (THREE.InstancedMesh | null)[][] = Array.from({ length: kitCount }, () => [null, null, null, null]);
  const hazardGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const glowGeo = track(new THREE.PlaneGeometry(1, 1));
  const hazardCount = hazardMats.length / 16;
  const hazardMesh = track(new THREE.InstancedMesh(hazardGeo, hazardMaterial, Math.max(1, hazardCount)));
  hazardMesh.count = 0;
  hazardMesh.frustumCulled = false;
  hazardMesh.name = 'carMeetHazards';
  group.add(hazardMesh);
  const glowCount = glowMatArr.length / 16;
  const glowMesh = track(new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, glowCount)));
  glowMesh.count = 0;
  glowMesh.frustumCulled = false;
  glowMesh.renderOrder = 2;
  glowMesh.name = 'carMeetUnderglow';
  if (glowCount) glowMesh.setColorAt(0, new THREE.Color(1, 1, 1));
  group.add(glowMesh);

  const visible = new Uint8Array(zones.length);
  let dirty = true;
  let disposed = false;
  const fill = () => {
    dirty = false;
    for (let k = 0; k < kitCount; k++) {
      const ms = kitMeshes[k];
      if (!ms.some((m) => m)) continue;
      let n = 0;
      zones.forEach((zone, zi) => {
        if (!visible[zi]) return;
        for (const ci of zone.cars) {
          if (kitOf(ci) !== k) continue;
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
    }
    let h = 0;
    let gl = 0;
    zones.forEach((_, zi) => {
      if (!visible[zi]) return;
      for (const hi of zoneHazards[zi]) (hazardMesh.instanceMatrix.array as Float32Array).set(hazardMats.subarray(hi * 16, hi * 16 + 16), h++ * 16);
      for (const gi of zoneGlows[zi]) {
        (glowMesh.instanceMatrix.array as Float32Array).set(glowMatArr.subarray(gi * 16, gi * 16 + 16), gl * 16);
        (glowMesh.instanceColor!.array as Float32Array).set(glowColArr.subarray(gi * 3, gi * 3 + 3), gl * 3);
        gl++;
      }
    });
    hazardMesh.count = h;
    hazardMesh.instanceMatrix.needsUpdate = true;
    glowMesh.count = gl;
    glowMesh.instanceMatrix.needsUpdate = true;
    if (glowMesh.instanceColor) glowMesh.instanceColor.needsUpdate = true;
  };

  for (let k = 0; k < kitCount; k++) {
    if (!perKit[k]) continue;
    const car = cars[Math.floor(k / MEET_VARIANTS)];
    loadKit(car, k % MEET_VARIANTS).then((kit) => {
      if (disposed) return;
      kit.geos.forEach((geo, part) => {
        if (!geo) return;
        // The baked geometry is shared (cached per app): only the instances go.
        const mesh = track(new THREE.InstancedMesh(geo, partMats[part], perKit[k]));
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.name = `carMeet:${car.id}:${k % MEET_VARIANTS}:${part}`;
        if (part === PART_PAINT) mesh.setColorAt(0, new THREE.Color(1, 1, 1));
        maskVehicleMesh(mesh);
        if (part === PART_GLASS) mesh.renderOrder = 3;
        kitMeshes[k][part] = mesh;
        group.add(mesh);
      });
      dirty = true;
    });
  }

  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();
  return {
    group,
    update(camera) {
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView);
      camPos.setFromMatrixPosition(camera.matrixWorld);
      for (let zi = 0; zi < zones.length; zi++) {
        const z = zones[zi];
        sphere.center.set(z.x, world.heightAt(z.x, z.z) + 1, z.z);
        sphere.radius = z.radius;
        const vis = z.cars.length > 0 && sphere.center.distanceTo(camPos) - z.radius < drawDistance && frustum.intersectsSphere(sphere) ? 1 : 0;
        if (vis !== visible[zi]) {
          visible[zi] = vis;
          dirty = true;
        }
      }
      if (dirty) fill();
    },
    dispose() {
      disposed = true;
      res.dispose();
    },
  };
}
