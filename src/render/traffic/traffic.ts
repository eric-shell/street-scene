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
 *
 * The kerb's parked cars (city/parking.ts, sim mode 'parked') are traffic
 * cars too, so a struck one is drawn where the sim shoves it for free. They
 * are picked apart from the moving ones, the nearest `parked` within
 * `parkedDistance` (Low included: each is a body a car stops against), lamps
 * off but for a few parking lights, paint dimmed like the yard cars'
 * (parkedCars.ts), and a struck one blinks its hazards (an alarm). Their
 * triangles: about 2.2k each, so 130k more at Medium with every pick filled.
 *
 * Past the tier's switch distance (CAR_IMPOSTORS, 45 to 100 m) a car is a card
 * from a sprite sheet baked from these very models (carImpostors.ts): one more
 * InstancedMesh, for the moving cars beyond the body picks and the parked cars
 * out to 400 m. A car between the two is drawn by both, the body fading out
 * and the card in with complementary dithers, and the body is dropped once past
 * the band, so the bodies are only the cars near the camera. The near picks are
 * the same nearest-first lists as before (the far cars extend them, never
 * reorder them). Without a renderer the sheet is not baked and nothing changes.
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
import { FOG_HEIGHT, applyHeightFog } from '../heightFog';
import { fogCutoff } from '../cityChunks';
import { floatGeometry } from '../gltfGeometry';
import { ROAD_Y } from '../street/cityMeshes';
import { maskVehicleMesh, underVehicles } from '../vehicleMask';
import { CAR_IMPOSTORS, CAR_SWITCH_MARGIN, CarImpostors, fadeOutBeyond, getCarSheet } from './carImpostors';
import type { CarImpostorSpec } from './carImpostors';

/**
 * Per tier: most moving cars drawn, their draw distance (m), headlight pools on the road; most parked
 * cars drawn and theirs (m), and the parked cars more while the camera is at a parking lot (`lotParked`,
 * LOT_REACH): a lot is a few hundred bodies packed in rows, and the nearest dozens alone would leave the
 * rows beyond a stone's throw empty, hits a car would still take. Draw counts only: the sim's fleet and
 * kerbs and lots are the replayed config's.
 */
export const TRAFFIC_QUALITY: Record<Quality, { cars: number; drawDistance: number; beams: boolean; parked: number; lotParked: number; parkedDistance: number }> = {
  low: { cars: 14, drawDistance: 200, beams: false, parked: 24, lotParked: 16, parkedDistance: 110 },
  medium: { cars: 26, drawDistance: 280, beams: true, parked: 60, lotParked: 36, parkedDistance: 180 },
  high: { cars: 44, drawDistance: 360, beams: true, parked: 120, lotParked: 60, parkedDistance: 260 },
};

/** Ranks past the body cap a car that already has a body keeps it, so the cap's edge does not flicker between body and card. */
const RANK_SLACK = 6;

/** The camera counts as at a parking lot within this far (m) of the lot's outline's middle, beyond its reach. */
const LOT_REACH = 60;

/** Instance slots a view needs at most: the largest tier's picks. */
const MAX_DRAWN = Math.max(...Object.values(TRAFFIC_QUALITY).map((q) => q.cars + q.parked + q.lotParked));
/** Most cards a view draws: every body pick of the largest tier (they may sit past the switch) plus its far picks. */
const MAX_CARDS = Math.max(...(Object.keys(TRAFFIC_QUALITY) as Quality[]).map((t) => TRAFFIC_QUALITY[t].cars + TRAFFIC_QUALITY[t].parked + TRAFFIC_QUALITY[t].lotParked + CAR_IMPOSTORS[t].movingFar + CAR_IMPOSTORS[t].parkedFar));

/** Snapshot layout per car: x, z, yaw, kind (-1 gone), born tick, flags (1 braking, 2 struck, 4 kerb parked, struck or not). */
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
    out[o + 5] = (c.braking ? 1 : 0) | (c.mode === 'loose' ? 2 : 0) | (c.home >= 0 ? 4 : 0);
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

/** How a parked car is dressed, at the kerb (here) and in the yards (parkedCars.ts); colours linear, HDR for the lamps that bloom. */
export const PARKED_LOOK = {
  /** Paint brightness against the traffic's: parked cars sit under the night's dust and shade. */
  dim: [0.55, 0.9],
  /** Lit lamp colours: a head lamp as a warm parking light, a tail lamp red. Under the bloom's threshold: a glint, not a flare. */
  head: new THREE.Color(0xffb866).multiplyScalar(1.1),
  tail: new THREE.Color(0xff2a30).multiplyScalar(0.9),
  /** Share of the kerb's cars with their parking lights on. */
  lit: 0.08,
} as const;

/** Muted street paint for the tinted cars (the atlas holds their paint as grey). */
export const PAINTS = [0x9aa0a6, 0x3a3d42, 0x16171a, 0xd8d8d4, 0x1e2a44, 0x5a1a1f, 0x223a2c, 0x9c8b6e, 0x3f5468, 0xb8a98a, 0x6d7276, 0x2b2f3a, 0x7a2a22, 0x2f4a5a].map((c) => new THREE.Color(c));
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

/**
 * Body material: the atlas alpha is the paint mask the instance colour tints, never transparency. With a `band` (the
 * impostor switch: distance and half width, m) the body dithers away beyond it, trading places with its card.
 */
export function bodyMaterial(atlas: THREE.Texture, band?: { value: THREE.Vector2 }): THREE.MeshStandardMaterial {
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
  if (band) fadeOutBeyond(m, band, 'batch');
  return m;
}

/** The linear grey the atlas stores paint at, for the card shader. */
export const PAINT_REF = PAINT_REF_LINEAR;

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

/**
 * The nearest cars, nearest first, in preallocated arrays: `offer` binary searches the slot and shifts the tail with
 * copyWithin, so a few hundred picks per frame cost a few thousand element moves and no allocation.
 */
class NearestList {
  readonly idx: Int32Array;
  readonly d2: Float64Array;
  len = 0;
  max = 0;

  constructor(capacity: number) {
    this.idx = new Int32Array(capacity);
    this.d2 = new Float64Array(capacity);
  }

  reset(max: number): void {
    this.len = 0;
    this.max = Math.min(max, this.idx.length);
  }

  /** Keep car i at squared distance d if it is among the nearest `max` offered so far. */
  offer(i: number, d: number): void {
    const max = this.max;
    if (max <= 0 || (this.len >= max && d >= this.d2[this.len - 1])) return;
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.d2[mid] <= d) lo = mid + 1;
      else hi = mid;
    }
    const end = Math.min(this.len, max - 1);
    if (end > lo) {
      this.idx.copyWithin(lo + 1, lo, end);
      this.d2.copyWithin(lo + 1, lo, end);
    }
    this.idx[lo] = i;
    this.d2[lo] = d;
    if (this.len < max) this.len++;
  }
}

/** A car's paint tint (linear, scaled to its dimming) as the body colour and the card read it. */
function trafficPaint(out: THREE.Color, i: number, born: number, parked: boolean, tinted: boolean): void {
  if (!tinted) {
    out.copy(WHITE);
    return;
  }
  const h = hash01(i, born);
  const dim = parked ? PARKED_LOOK.dim[0] + (PARKED_LOOK.dim[1] - PARKED_LOOK.dim[0]) * hash01(born, i) : 0.85 + 0.3 * hash01(born, i);
  out.copy(PAINTS[Math.floor(h * PAINTS.length)]).multiplyScalar(dim);
}

/** What a kind's roof lamps are: a taxi sign, or beacons in these colours (alternating when there are two). */
interface RoofLamps {
  sign: boolean;
  beacons: THREE.Color[];
}

/** Where the view's cards come from and go: the sheet's spec and the cards mesh, or none without a renderer. */
interface CardSet {
  spec: CarImpostorSpec;
  cards: CarImpostors;
}

/** What the view needs beyond the world: the page's renderer (to bake the cards with) and the tier it bakes for. */
export interface TrafficViewOptions {
  renderer?: THREE.WebGLRenderer;
  tier?: Quality;
}

export class TrafficView {
  readonly group = new THREE.Group();
  /** Built once the models load; null until then (and when they are missing). */
  private bodies: THREE.BatchedMesh | null = null;
  private decals: THREE.BatchedMesh | null = null;
  private bodyIds: number[] = [];
  private decalIds: (number | null)[] = [];
  private readonly lamps = TRAFFIC.kinds.map((_, i) => lampMatrices(i));
  /** Per kind its roof lamps (taxi sign, beacons), for the cards, which glow them as one colour. */
  private readonly roof: RoofLamps[] = TRAFFIC.kinds.map((_, k) => {
    const lamps = trafficModel(k).lamps;
    const names = [...new Set(lamps.filter((l) => l.role === 'beacon').map((l) => l.color ?? 'amber'))];
    return { sign: lamps.some((l) => l.role === 'sign'), beacons: names.map((n) => BEACON[n]) };
  });
  private readonly lampMesh: THREE.InstancedMesh;
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly beamMesh: THREE.InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  private disposed = false;
  /** The cards beyond the bodies (null without a renderer or when the bake failed). */
  private cardSet: CardSet | null = null;
  /** Per frame scratch: the picked cars, moving and parked, nearest first. */
  private readonly moving: NearestList;
  private readonly parkedList: NearestList;
  /** Per car: 1 if it had a body last frame (the near rank cap gives it a few ranks of slack, so a car at the cap does not flip between body and card). */
  private readonly hadBody: Uint8Array;
  /** A parked car's ground height (m, NaN until sampled): it never moves until struck, so it is sampled once. */
  private readonly groundCache: Float32Array;
  /** Instance slots: every car up to the largest tier's picks. */
  private readonly slots: number;
  /** The parking lots: middle and reach (m) of each, for the extra parked picks near one. */
  private readonly lots: { x: number; z: number; r: number }[];
  private readonly m = new THREE.Matrix4();
  private readonly lm = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();
  private readonly fwd = new THREE.Vector3();
  private readonly cardHead = new THREE.Color();
  private readonly cardTail = new THREE.Color();
  private readonly cardAux = new THREE.Color();
  /** The frame being placed (set by update, read by put): snapshots, tick, camera, switch distances (m, squared for the body's end). */
  private prevS: Float32Array = new Float32Array(0);
  private currS: Float32Array = new Float32Array(0);
  private alphaS = 0;
  private tickS = 0;
  private blinkS = false;
  private beamsOn = false;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private bodyEnd2 = Infinity;
  private cardStart2 = Infinity;
  private slotN = 0;
  private shown = 0;
  private lampN = 0;
  private beamN = 0;

  constructor(
    private readonly world: World,
    count: number,
    private readonly opts: TrafficViewOptions = {},
  ) {
    this.group.name = 'traffic';
    this.slots = Math.max(1, Math.min(count, MAX_DRAWN));
    this.groundCache = new Float32Array(Math.max(1, count)).fill(NaN);
    this.hadBody = new Uint8Array(Math.max(1, count));
    const tiers = Object.keys(TRAFFIC_QUALITY) as Quality[];
    this.moving = new NearestList(Math.max(...tiers.map((t) => TRAFFIC_QUALITY[t].cars + CAR_IMPOSTORS[t].movingFar)));
    this.parkedList = new NearestList(Math.max(...tiers.map((t) => TRAFFIC_QUALITY[t].parked + TRAFFIC_QUALITY[t].lotParked + CAR_IMPOSTORS[t].parkedFar)));
    this.lots = world.areas
      .filter((a) => a.kind === 'parkingLot')
      .map((a) => {
        const x = a.polygon.reduce((t, p) => t + p.x, 0) / a.polygon.length;
        const z = a.polygon.reduce((t, p) => t + p.z, 0) / a.polygon.length;
        return { x, z, r: Math.max(...a.polygon.map((p) => Math.hypot(p.x - x, p.z - z))) + LOT_REACH };
      });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lampMat = lampMat;
    // Tiny HDR emitters flicker in the distance without this (see lightFx.ts).
    fadeSubPixel(lampMat, 0.12, 0.3);
    const glowTex = makeRadialGlow();
    const beamMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x5d6676 });
    underVehicles(beamMat);
    const lampGeo = new THREE.BoxGeometry(1, 1, 1);
    const beamGeo = new THREE.PlaneGeometry(7, 17).rotateX(-Math.PI / 2);
    this.disposables.push(lampMat, glowTex, beamMat, lampGeo, beamGeo);
    const maxLamps = Math.max(...this.lamps.map((l) => l.length));
    this.lampMesh = new THREE.InstancedMesh(lampGeo, lampMat, this.slots * maxLamps);
    this.lampMesh.setColorAt(0, this.c.setRGB(1, 1, 1));
    this.beamMesh = new THREE.InstancedMesh(beamGeo, beamMat, this.slots);
    this.beamMesh.renderOrder = 3;
    for (const mesh of [this.lampMesh, this.beamMesh]) {
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.disposables.push(mesh);
    }
    this.lampMesh.name = 'trafficLamps';
    this.beamMesh.name = 'trafficBeams';
    // Built after the scene's height fog pass ran, so the views patch their own materials (idempotent).
    applyHeightFog(this.group);
    void loadTrafficAssets().then((a) => a && !this.disposed && this.build(a));
  }

  /** The two batched meshes, one instance slot per traffic car, all hidden until placed; and the cards if a sheet can be baked. */
  private build(a: TrafficAssets): void {
    const sum = (gs: (THREE.BufferGeometry | null)[], f: (g: THREE.BufferGeometry) => number) => gs.reduce((n, g) => n + (g ? f(g) : 0), 0);
    const verts = (g: THREE.BufferGeometry) => g.getAttribute('position').count;
    const idx = (g: THREE.BufferGeometry) => g.getIndex()!.count;
    const n = this.slots;
    // The cards first: their switch band feeds the body, decal and lamp materials.
    let band: { value: THREE.Vector2 } | undefined;
    const { renderer, tier = 'medium' } = this.opts;
    const sheet = renderer ? getCarSheet(renderer, tier, TRAFFIC.kinds.map((_, k) => ({ geometry: a.body[k], lamps: trafficModel(k).lamps })), a.atlas) : null;
    if (sheet) {
      const cards = new CarImpostors(sheet, PAINT_REF_LINEAR, MAX_CARDS);
      maskVehicleMesh(cards.mesh);
      this.group.add(cards.mesh);
      this.disposables.push(cards);
      band = cards.band;
      fadeOutBeyond(this.lampMat, band, 'instance');
      this.cardSet = { spec: sheet.spec, cards };
      const margin = CAR_SWITCH_MARGIN;
      this.bodyEnd2 = (sheet.spec.distance + sheet.spec.fade / 2 + margin) ** 2;
      this.cardStart2 = (sheet.spec.distance - sheet.spec.fade / 2 - margin) ** 2;
    }
    const bodyMat = bodyMaterial(a.atlas, band);
    const decalMat = new THREE.MeshStandardMaterial({ map: a.atlas, alphaTest: 0.5, metalness: 0.2, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    if (band) fadeOutBeyond(decalMat, band, 'batch');
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
    applyHeightFog(this.group);
  }

  /**
   * Place the cars between two snapshots. `tick` is the sim tick of `curr`
   * (spawn fades), `time` the scene clock (s, hazard blink), `tier` the
   * quality tier for count, distance and pools.
   */
  update(prev: Float32Array, curr: Float32Array, alpha: number, camera: THREE.Camera, time: number, tier: Quality, tick: number): void {
    const bodies = this.bodies;
    if (!bodies) return;
    const set = this.cardSet;
    const spec = set?.spec ?? null;
    const q = TRAFFIC_QUALITY[tier] ?? TRAFFIC_QUALITY.medium;
    const cam = camera.position;
    const n = Math.floor(curr.length / TRAFFIC_SNAP);
    // More parked cars drawn while the camera is at a lot (and the moving ones fewer, so the slots hold).
    const atLot = this.lots.some((l) => (l.x - cam.x) ** 2 + (l.z - cam.z) ** 2 < l.r * l.r);
    const parkedNear = q.parked + (atLot ? q.lotParked : 0);
    // The bodies' picks: the nearest `q.cars` moving cars within the draw distance and the nearest `parkedNear` kerb
    // cars within theirs. With cards the same lists run on, further out and longer, so the near ranks are the same.
    let movingReach = q.drawDistance;
    let parkedReach = q.parkedDistance;
    let movingCap = q.cars;
    let parkedCap = parkedNear;
    if (spec) {
      const fog = (this.group.parent as THREE.Scene | null)?.fog as THREE.FogExp2 | null | undefined;
      const fogReach = fog && fog.density > 0 ? fogCutoff(fog.density * Math.sqrt(FOG_HEIGHT.min)) : Infinity;
      movingReach = Math.max(movingReach, Math.min(spec.movingDistance, fogReach));
      parkedReach = Math.max(parkedReach, Math.min(spec.parkedDistance, fogReach));
      movingCap += spec.movingFar;
      parkedCap += spec.parkedFar;
      camera.getWorldDirection(this.fwd);
    }
    const maxD2 = q.drawDistance * q.drawDistance;
    const maxP2 = q.parkedDistance * q.parkedDistance;
    const moving = this.moving;
    const parked = this.parkedList;
    moving.reset(movingCap);
    parked.reset(parkedCap);
    const movingReach2 = movingReach * movingReach;
    const parkedReach2 = parkedReach * parkedReach;
    for (let i = 0; i < n; i++) {
      const o = i * TRAFFIC_SNAP;
      if (curr[o + 3] < 0) continue;
      const d2 = (curr[o] - cam.x) ** 2 + (curr[o + 1] - cam.z) ** 2;
      if (curr[o + 5] & 4) {
        if (d2 <= parkedReach2) parked.offer(i, d2);
      } else if (d2 <= movingReach2) moving.offer(i, d2);
    }
    this.prevS = prev;
    this.currS = curr;
    this.alphaS = alpha;
    this.tickS = tick;
    this.blinkS = Math.sin(time * 6.5) > 0;
    this.beamsOn = q.beams;
    this.camX = cam.x;
    this.camY = cam.y;
    this.camZ = cam.z;
    this.slotN = 0;
    this.lampN = 0;
    this.beamN = 0;
    set?.cards.begin();
    // With cards, a car that had a body keeps it a few ranks past the cap (hysteresis); without, the caps are exact.
    const slack = spec ? RANK_SLACK : 0;
    for (let r = 0; r < moving.len; r++) {
      const i = moving.idx[r];
      this.put(i, (r < q.cars || (this.hadBody[i] === 1 && r < q.cars + slack)) && moving.d2[r] <= maxD2, false);
    }
    for (let r = 0; r < parked.len; r++) {
      const i = parked.idx[r];
      this.put(i, (r < parkedNear || (this.hadBody[i] === 1 && r < parkedNear + slack)) && parked.d2[r] <= maxP2, true);
    }
    // Hide the slots the last frame used and this one did not.
    const decals = this.decals;
    for (let slot = this.slotN; slot < this.shown; slot++) {
      bodies.setVisibleAt(slot, false);
      decals?.setVisibleAt(slot, false);
    }
    this.shown = this.slotN;
    set?.cards.end();
    this.lampMesh.count = this.lampN;
    this.lampMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceColor!.needsUpdate = true;
    this.beamMesh.count = this.beamN;
    this.beamMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Place one picked car: a body (and its decal, lamps and beam) when `near` and inside the switch, a card when
   * past it, both across the band. `near` is false for the far picks, which only get a card, forced opaque.
   */
  private put(i: number, near: boolean, parked: boolean): void {
    const prev = this.prevS;
    const curr = this.currS;
    const o = i * TRAFFIC_SNAP;
    const kind = curr[o + 3];
    const model = trafficModel(kind);
    // A fresh spawn (or a car that just vanished and reappeared) is not interpolated.
    const same = prev[o + 3] === kind && prev[o + 4] === curr[o + 4];
    const t = same ? this.alphaS : 1;
    const x = same ? prev[o] + (curr[o] - prev[o]) * t : curr[o];
    const z = same ? prev[o + 1] + (curr[o + 1] - prev[o + 1]) * t : curr[o + 1];
    const yaw = same ? lerpAngle(prev[o + 2], curr[o + 2], t) : curr[o + 2];
    const flags = curr[o + 5];
    const struck = (flags & 2) !== 0;
    const set = this.cardSet;
    const dx = x - this.camX;
    const dz = z - this.camZ;
    const dxz2 = dx * dx + dz * dz;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    // A body needs a slot, the pick's rank and inside the switch (in 3D, as the shaders measure it).
    let body = near && this.slotN < this.slots && dxz2 <= this.bodyEnd2;
    let gh = NaN;
    if (body) {
      const hl = model.halfLength * 0.8;
      const hf = this.world.heightAt(x + fx * hl, z + fz * hl);
      const hb = this.world.heightAt(x - fx * hl, z - fz * hl);
      gh = (hf + hb) / 2;
      const dy = gh + ROAD_Y - this.camY;
      if (set && dxz2 + dy * dy > this.bodyEnd2) body = false;
      else {
        this.e.set(Math.atan2(hb - hf, 2 * hl), yaw, 0);
        this.q.setFromEuler(this.e);
        this.m.compose(this.p.set(x, gh + ROAD_Y, z), this.q, this.s);
      }
    }
    if (Number.isNaN(gh)) {
      // A card's car stands on the ground under its middle: a parked one's height is sampled once.
      const cached = parked && !struck;
      gh = cached && !Number.isNaN(this.groundCache[i]) ? this.groundCache[i] : this.world.heightAt(x, z);
      if (cached) this.groundCache[i] = gh;
    }
    const gy = gh + ROAD_Y;
    const born = curr[o + 4];
    if (model.tinted) trafficPaint(this.c, i, born, parked, true);
    else this.c.copy(WHITE);
    // Lamps: fade in over the first second of a spawn; brake lights, hazards and beacons when struck.
    const fade = Math.min(1, Math.max(0, (this.tickS - born) / 60));
    const blink = this.blinkS;
    // A parked car (its slot index is stable) shows no lamps but a few parking lights, and its hazards once struck.
    const lit = parked && hash01(i, 0x5eed) < PARKED_LOOK.lit;
    if (set) {
      const dy = gy - this.camY;
      const d3 = dxz2 + dy * dy;
      // Behind the camera nothing of a card shows; the band's near end is where its fade starts.
      if ((!body || d3 > this.cardStart2) && dx * this.fwd.x + dy * this.fwd.y + dz * this.fwd.z > -12) {
        let head: THREE.Color | null = null;
        let tail: THREE.Color | null = null;
        let aux: THREE.Color | null = null;
        if (parked) {
          if (lit) head = this.cardHead.copy(PARKED_LOOK.head);
          if (struck && blink) tail = this.cardTail.copy(HAZARD);
          else if (lit) tail = this.cardTail.copy(PARKED_LOOK.tail);
        } else {
          head = this.cardHead.copy(HEAD).multiplyScalar(struck ? 0.4 * fade : fade);
          tail = this.cardTail.copy(struck ? (blink ? HAZARD : TAIL) : flags & 1 ? BRAKE : TAIL).multiplyScalar(fade);
          const roof = this.roof[kind];
          if (roof.sign) aux = this.cardAux.copy(SIGN).multiplyScalar(fade);
          else if (roof.beacons.length) aux = this.cardAux.copy(roof.beacons[blink ? 0 : roof.beacons.length - 1]).multiplyScalar(struck ? BEACON_FLASH : BEACON_DIM);
        }
        set.cards.add(x, gy, z, yaw, kind, !body, this.c, head, tail, aux);
      }
    }
    this.hadBody[i] = body ? 1 : 0;
    if (body) this.placeBody(kind, parked, struck, flags, lit, fade, blink);
    if (near && this.beamsOn && !struck && !parked && this.beamN < this.slots) {
      this.lm.makeRotationY(yaw).setPosition(x + fx * (model.halfLength + 8.2), gh + 0.07, z + fz * (model.halfLength + 8.2));
      this.lm.toArray(this.beamMesh.instanceMatrix.array as Float32Array, this.beamN * 16);
      this.beamN++;
    }
  }

  /** Fill the next body slot with the car posed in `this.m`, with its decal, paint and lamps. */
  private placeBody(kind: number, parked: boolean, struck: boolean, flags: number, lit: boolean, fade: number, blink: boolean): void {
    const bodies = this.bodies!;
    const decals = this.decals;
    const slot = this.slotN++;
    bodies.setGeometryIdAt(slot, this.bodyIds[kind]);
    bodies.setMatrixAt(slot, this.m);
    bodies.setVisibleAt(slot, true);
    bodies.setColorAt(slot, this.c);
    if (decals) {
      const id = this.decalIds[kind];
      if (id !== null) {
        decals.setGeometryIdAt(slot, id);
        decals.setMatrixAt(slot, this.m);
      }
      decals.setVisibleAt(slot, id !== null);
    }
    const lampArr = this.lampMesh.instanceMatrix.array as Float32Array;
    const lampCol = this.lampMesh.instanceColor!.array as Float32Array;
    for (const { m, lamp } of this.lamps[kind]) {
      if (parked) {
        // The hazards blink on the tail lamps; between flashes only a lit car's parking lights show.
        const hazard = struck && lamp.role === 'tail' && blink;
        if (!hazard && !(lit && (lamp.role === 'head' || lamp.role === 'tail'))) continue;
        this.lm.multiplyMatrices(this.m, m);
        this.lm.toArray(lampArr, this.lampN * 16);
        this.c.copy(hazard ? HAZARD : lamp.role === 'head' ? PARKED_LOOK.head : PARKED_LOOK.tail);
        this.c.toArray(lampCol, this.lampN * 3);
        this.lampN++;
        continue;
      }
      this.lm.multiplyMatrices(this.m, m);
      this.lm.toArray(lampArr, this.lampN * 16);
      if (lamp.role === 'beacon') {
        // Alternate sides of the car flash in turn.
        const on = struck && (lamp.p[0] < 0) === blink;
        this.c.copy(BEACON[lamp.color ?? 'amber']).multiplyScalar(on ? BEACON_FLASH : BEACON_DIM);
      } else {
        const col = lamp.role === 'head' ? HEAD : lamp.role === 'sign' ? SIGN : struck ? (blink ? HAZARD : TAIL) : flags & 1 ? BRAKE : TAIL;
        this.c.copy(col).multiplyScalar(lamp.role === 'head' && struck ? 0.4 * fade : fade);
      }
      this.c.toArray(lampCol, this.lampN * 3);
      this.lampN++;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}
