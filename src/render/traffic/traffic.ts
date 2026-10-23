/**
 * Ambient traffic on screen (the cars of src/sim/traffic.ts). Render only:
 * it reads the session's two traffic snapshots and interpolates them with
 * the loop's alpha, like the race cars.
 *
 * The vehicles are Comrade1280's passenger and civil service packs (CC BY
 * 4.0), cut, simplified and atlased by `npm run traffic` into
 * public/traffic/traffic.glb (one node per kind, named as in
 * drivingParams.json traffic.kinds), public/traffic/trafficAtlas.webp and
 * src/assets/trafficModels.json (lamps, sizes, credits). They load once per
 * page (loadTrafficAssets, started at boot); a view built before they land
 * draws nothing until they do.
 *
 * Cheap by construction, whatever the count:
 *  - every body in one BatchedMesh (one draw call, per car frustum culling)
 *    and every decal (lettering, stripes; alpha tested) in a second one. The
 *    atlas alpha marks paint on the passenger cars, stored grey, so the
 *    instance colour tints only the paint (a muted street palette); the
 *    civil service liveries keep their colours;
 *  - every lamp of every car (head, tail, beacon, taxi sign) in one
 *    instanced box mesh with HDR instance colours for the bloom: brake
 *    lights flare, struck cars blink their hazards and beacons, fresh spawns
 *    fade their lamps in;
 *  - one instanced additive pool of headlight on the road ahead of each car
 *    (Medium and High).
 * Four draw calls. Cars beyond the tier's draw distance are dropped, and only
 * the nearest `cars` of the rest are filled in, so the per frame cost is a
 * few dozen matrix composes and terrain samples. Triangles: 2.2k per
 * passenger car up to 3.4k per truck or bus, so about 60k at Medium.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { World } from '../../city/world';
import type { TrafficState } from '../../sim/traffic';
import { TRAFFIC } from '../../sim/tuning';
import type { Quality } from '../../ui/settings';
import modelsJson from '../../assets/trafficModels.json';
import { kelvin, makeRadialGlow } from '../textures/textures';
import { fadeSubPixel } from '../materialFx';
import { floatGeometry } from '../gltfGeometry';
import { ROAD_Y } from '../street/cityMeshes';
import { maskVehicleMesh, underVehicles } from '../vehicleMask';

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

/** A lamp of a model: a box in car space (+z forward, y up, m) and what kind of lamp. */
export interface TrafficLamp {
  role: 'head' | 'tail' | 'beacon' | 'sign';
  /** Beacon lens colour. */
  color?: 'red' | 'blue' | 'amber';
  /** Centre and size (m). */
  p: [number, number, number];
  s: [number, number, number];
}

/** What `npm run traffic` measured of one model. */
export interface TrafficModel {
  /** Collision footprint of the body below the mirrors (m); drivingParams.json traffic.kinds matches it. */
  halfLength: number;
  halfWidth: number;
  /** m */
  height: number;
  triangles: number;
  /** Paint marked in the atlas alpha and tinted per car. */
  tinted: boolean;
  lamps: TrafficLamp[];
}

/** One source pack, as credited in the README. */
export interface TrafficCredit {
  title: string;
  creator: string;
  creatorUrl: string;
  url: string;
  license: string;
  licenseUrl: string;
  changes: string;
  kinds: string[];
}

export const TRAFFIC_MODELS = modelsJson as unknown as { paintRef: number; credits: TrafficCredit[]; kinds: Record<string, TrafficModel> };

/** The model of a traffic kind (index into TRAFFIC.kinds). */
export function trafficModel(kind: number): TrafficModel {
  return TRAFFIC_MODELS.kinds[TRAFFIC.kinds[kind].name];
}

/** Per kind (TRAFFIC.kinds order) its body and decal geometry in car space, and the shared atlas. */
interface TrafficAssets {
  body: THREE.BufferGeometry[];
  decal: (THREE.BufferGeometry | null)[];
  atlas: THREE.Texture;
}

const base = import.meta.env.BASE_URL ?? '/';
let loading: Promise<TrafficAssets | null> | null = null;

/**
 * Load the traffic GLB and atlas once per page (null if either is missing).
 * Geometry comes back in float attributes with the node transform baked in:
 * Meshopt quantizes positions into the node scale, and a BatchedMesh needs
 * every geometry in one attribute layout.
 */
export function loadTrafficAssets(): Promise<TrafficAssets | null> {
  if (loading) return loading;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = loader.loadAsync(`${base}traffic/traffic.glb`);
  const atlas = new THREE.TextureLoader().loadAsync(`${base}traffic/trafficAtlas.webp`);
  loading = Promise.all([gltf, atlas])
    .then(([g, tex]) => {
      tex.flipY = false; // glTF UVs
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      g.scene.updateMatrixWorld(true);
      const body: THREE.BufferGeometry[] = [];
      const decal: (THREE.BufferGeometry | null)[] = [];
      for (const k of TRAFFIC.kinds) {
        const node = g.scene.getObjectByName(k.name);
        if (!node) throw new Error(`traffic.glb has no ${k.name}`);
        const parts: Record<string, THREE.BufferGeometry> = {};
        node.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) parts[(m.material as THREE.Material).name] = floatGeometry(m.geometry, m.matrixWorld);
        });
        body.push(parts.Traffic);
        decal.push(parts.TrafficDecal ?? null);
      }
      return { body, decal, atlas: tex };
    })
    .catch((e) => {
      console.warn('traffic models unavailable', e);
      return null;
    });
  return loading;
}

/** Muted street paint for the tinted cars (the atlas holds their paint as grey). */
const PAINTS = [0x9aa0a6, 0x3a3d42, 0x16171a, 0xd8d8d4, 0x1e2a44, 0x5a1a1f, 0x223a2c, 0x9c8b6e, 0x3f5468, 0xb8a98a, 0x6d7276, 0x2b2f3a, 0x7a2a22, 0x2f4a5a].map((c) => new THREE.Color(c));
const WHITE = new THREE.Color(1, 1, 1);

/** Lamp colours (HDR, for the bloom). Beacons glow dim, under the bloom, until a struck car flashes them. */
const HEAD = new THREE.Color(kelvin(5200)).multiplyScalar(2.4);
const TAIL = new THREE.Color(0xff1a24).multiplyScalar(1.1);
const BRAKE = new THREE.Color(0xff1a24).multiplyScalar(2.8);
const HAZARD = new THREE.Color(0xffa030).multiplyScalar(2.2);
const SIGN = new THREE.Color(0xfff2c0).multiplyScalar(1.8);
const BEACON: Record<NonNullable<TrafficLamp['color']>, THREE.Color> = {
  red: new THREE.Color(0xff2030),
  blue: new THREE.Color(0x2a50ff),
  amber: new THREE.Color(0xffa030),
};
const BEACON_DIM = 0.35;
const BEACON_FLASH = 3;

/** The atlas stores paint at this sRGB grey (trafficPack.py PAINT_REF), here in linear. */
const PAINT_REF_LINEAR = new THREE.Color().setRGB(TRAFFIC_MODELS.paintRef, 0, 0, THREE.SRGBColorSpace).r;

/** Body material: the atlas alpha is the paint mask the instance colour tints, never transparency. */
function bodyMaterial(atlas: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: atlas, metalness: 0.3, roughness: 0.5, envMapIntensity: 1.1 });
  m.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <color_fragment>',
      `#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
        diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vColor.rgb / ${PAINT_REF_LINEAR.toFixed(5)}, diffuseColor.a );
      #endif
      diffuseColor.a = 1.0;`,
    );
  };
  m.customProgramCacheKey = () => 'trafficBody';
  return m;
}

/** Lamps of each kind as boxes in car space. */
function lampMatrices(kind: number): { m: THREE.Matrix4; lamp: TrafficLamp }[] {
  return trafficModel(kind).lamps.map((lamp) => ({ m: new THREE.Matrix4().compose(new THREE.Vector3(...lamp.p), new THREE.Quaternion(), new THREE.Vector3(...lamp.s)), lamp }));
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
  /** Built once the models load; null until then (and when they are missing). */
  private bodies: THREE.BatchedMesh | null = null;
  private decals: THREE.BatchedMesh | null = null;
  private bodyIds: number[] = [];
  private decalIds: (number | null)[] = [];
  private readonly lamps = TRAFFIC.kinds.map((_, i) => lampMatrices(i));
  private readonly lampMesh: THREE.InstancedMesh;
  private readonly beamMesh: THREE.InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  private disposed = false;
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

  constructor(
    private readonly world: World,
    private readonly count: number,
  ) {
    this.group.name = 'traffic';
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    // Tiny HDR emitters flicker in the distance without this (see lightFx.ts).
    fadeSubPixel(lampMat, 0.12, 0.3);
    const glowTex = makeRadialGlow();
    const beamMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x5d6676 });
    underVehicles(beamMat);
    const lampGeo = new THREE.BoxGeometry(1, 1, 1);
    const beamGeo = new THREE.PlaneGeometry(7, 17).rotateX(-Math.PI / 2);
    this.disposables.push(lampMat, glowTex, beamMat, lampGeo, beamGeo);
    const maxLamps = Math.max(...this.lamps.map((l) => l.length));
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
    void loadTrafficAssets().then((a) => a && !this.disposed && this.build(a));
  }

  /** The two batched meshes, one instance slot per traffic car, all hidden until placed. */
  private build(a: TrafficAssets): void {
    const sum = (gs: (THREE.BufferGeometry | null)[], f: (g: THREE.BufferGeometry) => number) => gs.reduce((n, g) => n + (g ? f(g) : 0), 0);
    const verts = (g: THREE.BufferGeometry) => g.getAttribute('position').count;
    const idx = (g: THREE.BufferGeometry) => g.getIndex()!.count;
    const n = Math.max(1, this.count);
    const bodyMat = bodyMaterial(a.atlas);
    const decalMat = new THREE.MeshStandardMaterial({ map: a.atlas, alphaTest: 0.5, metalness: 0.2, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    this.disposables.push(bodyMat, decalMat);
    const bodies = new THREE.BatchedMesh(n, sum(a.body, verts), sum(a.body, idx), bodyMat);
    this.bodyIds = a.body.map((g) => bodies.addGeometry(g));
    const decalGeos = a.decal.filter((g): g is THREE.BufferGeometry => g !== null);
    const decals = new THREE.BatchedMesh(n, Math.max(1, sum(decalGeos, verts)), Math.max(1, sum(decalGeos, idx)), decalMat);
    this.decalIds = a.decal.map((g) => (g ? decals.addGeometry(g) : null));
    const firstDecal = this.decalIds.find((id) => id !== null) ?? null;
    for (let i = 0; i < n; i++) {
      bodies.setVisibleAt(bodies.addInstance(this.bodyIds[0]), false);
      if (firstDecal !== null) decals.setVisibleAt(decals.addInstance(firstDecal), false);
    }
    for (const [mesh, name] of [
      [bodies, 'trafficBodies'],
      [decals, 'trafficDecals'],
    ] as const) {
      // Instances move every frame, so the whole mesh's bounds are never current; each car is culled on its own.
      mesh.frustumCulled = false;
      mesh.name = name;
      maskVehicleMesh(mesh);
      this.group.add(mesh);
      this.disposables.push(mesh);
    }
    bodies.setColorAt(0, WHITE);
    this.bodies = bodies;
    this.decals = firstDecal !== null ? decals : null;
  }

  /**
   * Place the cars between two snapshots. `tick` is the sim tick of `curr`
   * (spawn fades), `time` the scene clock (s, hazard blink), `tier` the
   * quality tier for count, distance and pools.
   */
  update(prev: Float32Array, curr: Float32Array, alpha: number, camera: THREE.Camera, time: number, tier: Quality, tick: number): void {
    const bodies = this.bodies;
    if (!bodies) return;
    const decals = this.decals;
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
    let lamps = 0;
    let beams = 0;
    const blink = Math.sin(time * 6.5) > 0;
    const lampArr = this.lampMesh.instanceMatrix.array as Float32Array;
    const lampCol = this.lampMesh.instanceColor!.array as Float32Array;
    const beamArr = this.beamMesh.instanceMatrix.array as Float32Array;
    const slots = Math.max(1, this.count);
    for (let slot = 0; slot < slots; slot++) {
      const i = slot < pick.length ? pick[slot] : -1;
      if (i < 0) {
        bodies.setVisibleAt(slot, false);
        decals?.setVisibleAt(slot, false);
        continue;
      }
      const o = i * TRAFFIC_SNAP;
      const kind = curr[o + 3];
      const model = trafficModel(kind);
      // A fresh spawn (or a car that just vanished and reappeared) is not interpolated.
      const same = prev[o + 3] === kind && prev[o + 4] === curr[o + 4];
      const t = same ? alpha : 1;
      const x = same ? prev[o] + (curr[o] - prev[o]) * t : curr[o];
      const z = same ? prev[o + 1] + (curr[o + 1] - prev[o + 1]) * t : curr[o + 1];
      const yaw = same ? lerpAngle(prev[o + 2], curr[o + 2], t) : curr[o + 2];
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const hl = model.halfLength * 0.8;
      const hf = this.world.heightAt(x + fx * hl, z + fz * hl);
      const hb = this.world.heightAt(x - fx * hl, z - fz * hl);
      this.e.set(Math.atan2(hb - hf, 2 * hl), yaw, 0);
      this.q.setFromEuler(this.e);
      this.m.compose(this.p.set(x, (hf + hb) / 2 + ROAD_Y, z), this.q, this.s);
      bodies.setGeometryIdAt(slot, this.bodyIds[kind]);
      bodies.setMatrixAt(slot, this.m);
      bodies.setVisibleAt(slot, true);
      if (model.tinted) {
        const h = hash01(i, curr[o + 4]);
        this.c.copy(PAINTS[Math.floor(h * PAINTS.length)]).multiplyScalar(0.85 + 0.3 * hash01(curr[o + 4], i));
        bodies.setColorAt(slot, this.c);
      } else bodies.setColorAt(slot, WHITE);
      if (decals) {
        const id = this.decalIds[kind];
        if (id !== null) {
          decals.setGeometryIdAt(slot, id);
          decals.setMatrixAt(slot, this.m);
        }
        decals.setVisibleAt(slot, id !== null);
      }
      // Lamps: fade in over the first second of a spawn; brake lights, hazards and beacons when struck.
      const flags = curr[o + 5];
      const fade = Math.min(1, Math.max(0, (tick - curr[o + 4]) / 60));
      const struck = (flags & 2) !== 0;
      for (const { m, lamp } of this.lamps[kind]) {
        this.lm.multiplyMatrices(this.m, m);
        this.lm.toArray(lampArr, lamps * 16);
        if (lamp.role === 'beacon') {
          // Alternate sides of the car flash in turn.
          const on = struck && (lamp.p[0] < 0) === blink;
          this.c.copy(BEACON[lamp.color ?? 'amber']).multiplyScalar(on ? BEACON_FLASH : BEACON_DIM);
        } else {
          const col = lamp.role === 'head' ? HEAD : lamp.role === 'sign' ? SIGN : struck ? (blink ? HAZARD : TAIL) : flags & 1 ? BRAKE : TAIL;
          this.c.copy(col).multiplyScalar(lamp.role === 'head' && struck ? 0.4 * fade : fade);
        }
        this.c.toArray(lampCol, lamps * 3);
        lamps++;
      }
      if (q.beams && !struck) {
        this.lm.makeRotationY(yaw).setPosition(x + fx * (model.halfLength + 8.2), (hf + hb) / 2 + 0.07, z + fz * (model.halfLength + 8.2));
        this.lm.toArray(beamArr, beams * 16);
        beams++;
      }
    }
    this.lampMesh.count = lamps;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceColor!.needsUpdate = true;
    this.beamMesh.count = beams;
    this.beamMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
