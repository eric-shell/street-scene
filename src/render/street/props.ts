/**
 * Destructible props from CityBlocks.props: street furniture (streetlights,
 * traffic lights, garbage cans, benches, bus stops) and district clutter
 * (bushes, planter pots, cafe tables, barrels, crates, dumpsters, news boxes,
 * trash bags, the lantern posts of parks and plazas, the bollards fencing a
 * roundabout island's middle, and the construction
 * pieces in route shortcuts: fence panels
 * with contractors' banners, cones, sawhorse barricades with a lamp, water
 * filled barriers, sandbags, pallets), and the neighbourhood furniture of
 * streetFurniture.ts (hydrants that gush when broken, hydrantSpray.ts, meters,
 * mailboxes, phone booths, vending machines), instanced per kind and part,
 * tinted per instance. Traffic
 * signals cycle red / amber / green in a shader (per intersection offset,
 * crossing directions out of phase), so they cost nothing on the CPU.
 *
 * Destruction mirrors RaceState.brokenProps: a broken prop's intact instances
 * collapse to zero scale (poles leave a stump), its light goes out, and its
 * parts break apart as pooled debris pushed along by the car that hit it.
 * Because the state is read back every frame from the sim's flags, a new
 * session (restart, replay) always starts consistent. Render only.
 *
 * Culling by cell (the 200 m grid of cityChunks.ts): each kind's instances are
 * sorted by grid cell, so every part mesh holds a cell as one contiguous run,
 * and a full-order copy of every instance buffer (matrices, tints, the lenses'
 * signal offsets) is the source of truth. view() picks the cells within the
 * kind's cutoff of the camera's 100 m lattice square (radial, so turning the
 * camera changes nothing, and snapped, so a drive changes the set about once a
 * second) and, only then, copies their runs to the front of the GPU buffers, sets
 * `count` and fits the bounding sphere to them, so three's frustum culling
 * works too. ~40 draws stay ~40 draws; a break writes its instance in both
 * copies. Tall far-visible kinds (lamp and signal poles, bus stops) cut where
 * the fog closes, the rest at the quality's detailDistance.
 *
 * Power poles (city/props.ts 'utilityPole', the la streets) are poles like the streetlights: a wooden shaft
 * with its crossarm and, on every fourth, a transformer drum; struck, they snap at the base, leave a stump (tinted
 * timber) and throw a burst of sparks off the crossarm, and the wires hung between them (utilityWires.ts, one
 * merged line mesh built here) drop at that end.
 *
 * Streetlights come in three post designs (cobra, historic, modern; lampStyle.ts picks one and a lamp colour per
 * neighbourhood). Each design is its own set of part meshes with its own cell runs, so the culling and the break
 * handling treat them like any other kind; the lens takes the lamp's colour as its instance colour.
 *
 * The meshes of each part are in propGeometry.ts; this module places the
 * instances, runs the signal shader and breaks props apart.
 */
import * as THREE from 'three';
import type { World } from '../../city/world';
import type { Prop, PropKind } from '../../city/props';
import type { Quality } from '../../ui/settings';
import { FOG_DENSITY } from '../lighting';
import { fadeSubPixel } from '../materialFx';
import { chunkGrid, VIEW_LATTICE, type ChunkGrid } from '../cityChunks';
import { D_BOX, D_CYL, D_GLASS, D_GLOW, Debris, DebrisType } from './debris';
import { shatterFurniture } from './streetFurniture';
import { buildHydrantSpray } from './hydrantSpray';
import { LAMP_TONES, planLamps, toneColor } from './lampStyle';
import { SIGNAL, type EmitterClass } from './lightFx';
import { buildUtilityWires } from './utilityWires';
import { UTILITY_POLE, utilityPoleGeo, utilityTransformerGeo, STUMP_H, TRAFFIC_POLE_H, TRAFFIC_ARM_Y, STREETLIGHT_POLE_H, STREETLIGHT_ARM, PARK_LAMP_H, PARK_LANTERN_Y, LAMP_DESIGNS, LAMP_DIMS, type LampDesign, col, streetlightGeo, stumpGeo, trafficPoleGeo, trafficArmGeo, trafficHeadGeo, trafficLensGeo, canGeo, benchGeo, busStopGeo, adTexture, PARTS, PART_KINDS, isFurniture, STALL } from './propGeometry';
import { HEIGHT_FOG_GLSL, HEIGHT_FOG_UNIFORMS } from '../heightFog';
import { regionAt } from '../buildings/architecture';
import { signatureAt } from '../cityIdentity';

export { STREETLIGHT_POLE_H, STREETLIGHT_ARM, PARK_LAMP_H, PARK_LANTERN_Y };

/** Signal cycle in seconds: green 0-9, amber 9-11, red 11-24 (the crossing direction is offset by half); lightFx.ts SIGNAL, which the lenses' streaks read too. */
const CYCLE = SIGNAL.cycle;

export interface CarMotion {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

export interface PropRenderer {
  group: THREE.Group;
  /**
   * Mirror the sim's broken flags. Props that broke since the last call come
   * apart, pushed by the nearest car. Cheap when nothing changed.
   * `dirty` lists the prop ids that changed since the last call: only those are visited. Without it every
   * prop is scanned (the menu stage, which stands props back up, and a session's first sync).
   */
  update(dt: number, time: number, broken: ArrayLike<number> | undefined, cars: readonly CarMotion[], dirty?: readonly number[]): void;
  /**
   * Draw only the cells within reach of this camera: `detail` kinds out to detailDistance, `fog` kinds out to
   * fogDistance (m; Infinity draws everything). Call once per render (scene.onBeforeRender); uploads only when
   * the set of cells changes. Allocates nothing.
   */
  view(camera: THREE.Camera, detailDistance: number, fogDistance: number): void;
  /** Dev stats: compactions run, and bytes uploaded by the last one. */
  readonly cullStats: { compactions: number; lastBytes: number };
  dispose(): void;
}

/** Where a prop kind stops being drawn: at the quality's detail distance, or where the fog closes. */
export type PropCullClass = 'detail' | 'fog';

/**
 * The tall kinds a driver reads from afar (lamp and signal poles, lit shelters) stay until the fog swallows
 * them, so a row of lamp posts never pops in at 260 m; every other kind is small detail.
 */
export const PROP_CULL: Partial<Record<PropKind, PropCullClass>> = {
  streetlight: 'fog',
  trafficLight: 'fog',
  busStop: 'fog',
  parkLamp: 'fog',
  utilityPole: 'fog',
};

/** The lattice and hysteresis the props pick their cells with (cityChunks.ts VIEW_LATTICE, shared with the light streaks). */
export const PROP_CHUNKS = VIEW_LATTICE;

export interface PropRendererOptions {
  /** Geometry tier (ring segments, merged slats, fewer clumps); placement and hashing never depend on it. Default medium. */
  quality?: Quality;
  /**
   * A lamp switched off (broken) or back on: a streetlight's `light` index,
   * or streetlights.length + k for the k-th park lamp (parkLamps order).
   */
  onLamp?(light: number, on: boolean): void;
  /** Any prop broken (true) or put back (false), by prop id: the light streaks of shelters and signals follow their prop. */
  onBroken?(id: number, broken: boolean): void;
  /** The culling grid (scene.ts shares the city chunks' one); default chunkGrid(world.graph.bounds). */
  grid?: ChunkGrid;
  /** Per-kind cull class over PROP_CULL (unlisted kinds are `detail`). */
  cull?: Partial<Record<PropKind, PropCullClass>>;
}

/** The lantern posts of parks and plazas in light order: their lights follow the streetlights'. */
export function parkLamps(world: World): Prop[] {
  return (world.blocks.props ?? []).filter((p) => p.kind === 'parkLamp');
}

const lensVert = /* glsl */ `
  attribute float aSlot;
  attribute float aOffset;
  varying float vSlot;
  varying float vLit;
  varying float vFog;
  varying vec3 vView;
  uniform float time;
  uniform float fogDensity;
  ${HEIGHT_FOG_GLSL}
  void main() {
    vSlot = aSlot;
    float t = mod(time + aOffset, ${CYCLE.toFixed(1)});
    float state = t < ${SIGNAL.green.toFixed(1)} ? 2.0 : (t < ${SIGNAL.amber.toFixed(1)} ? 1.0 : 0.0);
    vLit = 1.0 - step(0.5, abs(state - aSlot));
    vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
    float d = length(mv.xyz);
    vFog = exp(-fogDensity * fogDensity * d * d * 0.5 * hfMulView(mv.xyz));
    vView = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const lensFrag = /* glsl */ `
  varying float vSlot;
  varying float vLit;
  varying float vFog;
  varying vec3 vView;
  void main() {
    // Fade sub pixel lenses instead of letting them pop (see fadeSubPixel in lightFx).
    float px = clamp(0.23 / (2.0 * max(length(fwidth(vView)), 1e-5)), 0.25, 1.0);
    vec3 c = vSlot < 0.5 ? vec3(1.0, 0.05, 0.03) : (vSlot < 1.5 ? vec3(1.0, 0.5, 0.04) : vec3(0.08, 1.0, 0.45));
    gl_FragColor = vec4(c * mix(0.045, 3.4 * px, vLit) * vFog, 1.0);
  }
`;

// ---------------------------------------------------------------------------

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0).elements;
const tmpTint = new THREE.Color();
/** Debris spawner of one breaking prop: local offsets (prop frame), half extents, push along the hit, lift, spin. */
type SpawnFn = (
  type: DebrisType,
  lx: number,
  ly: number,
  lz: number,
  yaw: number,
  hx: number,
  hy: number,
  hz: number,
  push: number,
  lift: number,
  spin: number,
  color: THREE.Color,
  life?: number,
  sparky?: boolean,
) => void;
/** Stump tints per slot: the steel poles' as built, and a power pole's (the shared stump's dark steel lifted to weathered timber). */
const STEEL_STUMP = new THREE.Color(1, 1, 1);
const TIMBER_STUMP = new THREE.Color(2.3, 1.55, 0.95);
const CAN_TINTS = [0x2f6a46, 0x2f6a46, 0x5a6068, 0x34507a, 0x7a3a2a].map((c) => new THREE.Color(c));
const AD_TINTS = [0xff3df2, 0x19e6ff, 0xffb020, 0x7cff6a, 0xffffff, 0xff4060].map((c) => new THREE.Color(c).multiplyScalar(1.5));

interface PartRef {
  mesh: number;
  /** Instance index in full (cell sorted) order. */
  index: number;
}

/** One part mesh culled by cell: its full-order buffers and where each cell's run lies in them. */
interface CellMesh {
  mesh: THREE.InstancedMesh;
  cls: PropCullClass;
  /** First instance of each cell's run, plus the end (length cells + 1). */
  start: Uint32Array;
  /** Current matrices (broken = zero scale), full order; the GPU buffer holds the drawn runs at its front. */
  state: Float32Array;
  color: Float32Array | null;
  offset: Float32Array | null;
  /** GPU slot of each full-order instance (-1: its cell is not drawn). */
  slot: Int32Array;
  /** Per-cell AABB of the instances' world bounds: minX, minY, minZ, maxX, maxY, maxZ (m). */
  box: Float32Array;
}

interface TrafficFrame {
  /** Unit arm direction (over the served road) and its length. */
  ax: number;
  az: number;
  len: number;
  /** Head facings (unit): arm heads face fa, the pole head faces fb. */
  fax: number;
  faz: number;
  fbx: number;
  fbz: number;
}

const _union = new THREE.Box3();
const _cellBox = new THREE.Box3();

/** Fit the mesh's bounding sphere to its drawn cells (all of them when bits is null), so three's frustum culling sees only those. */
function fitBounds(cm: CellMesh, bits: Uint8Array | null): void {
  _union.makeEmpty();
  const b = cm.box;
  for (let c = 0; c < cm.start.length - 1; c++) {
    if ((bits && !bits[c]) || cm.start[c + 1] === cm.start[c]) continue;
    const o = c * 6;
    _cellBox.min.set(b[o], b[o + 1], b[o + 2]);
    _cellBox.max.set(b[o + 3], b[o + 4], b[o + 5]);
    _union.union(_cellBox);
  }
  if (!_union.isEmpty()) _union.getBoundingSphere(cm.mesh.boundingSphere!);
}

/** Direction helpers: local +Z of yaw is (sin, cos), local +X is (cos, -sin). */
const yawOf = (x: number, z: number) => Math.atan2(x, z);

export function buildProps(world: World, opts: PropRendererOptions = {}): PropRenderer {
  const q: Quality = opts.quality ?? 'medium';
  const group = new THREE.Group();
  group.name = 'props';
  const props: Prop[] = world.blocks.props ?? [];
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };
  const solidMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.45 }));
  const glowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  const lampLensMat = track(new THREE.MeshBasicMaterial({ vertexColors: true }));
  fadeSubPixel(lampLensMat, 0.36, 0.25);
  fadeSubPixel(glowMat, 0.05, 0.3);
  const matteMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }));
  const canopyMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }));
  const glassMat = track(new THREE.MeshStandardMaterial({ color: 0x9fc6e0, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.6 }));
  const adMat = track(new THREE.MeshBasicMaterial({ map: track(adTexture()) }));
  const lensMat = track(
    new THREE.ShaderMaterial({ vertexShader: lensVert, fragmentShader: lensFrag, uniforms: { time: { value: 0 }, fogDensity: { value: FOG_DENSITY }, ...HEIGHT_FOG_UNIFORMS } }),
  );

  const grid = opts.grid ?? chunkGrid(world.graph.bounds);
  const cullOf = { ...PROP_CULL, ...opts.cull };
  /** Each drawn group's first index of every cell's run in its sorted list, plus the end (a group is a kind, or a kind's lamp design). */
  const runsOf = new Map<string, Uint32Array>();
  /** A kind's props (those passing `keep`), stable-sorted by grid cell so each cell is one run of instances (counting sort). */
  const byKind = (k: PropKind, key: string = k, keep?: (p: Prop) => boolean): Prop[] => {
    const list = props.filter((p) => p.kind === k && (!keep || keep(p)));
    const cells = list.map((p) => grid.cellOf(p.x, p.z));
    const start = new Uint32Array(grid.count + 1);
    for (const c of cells) start[c + 1]++;
    for (let c = 0; c < grid.count; c++) start[c + 1] += start[c];
    const at = start.slice(0, grid.count);
    const out: Prop[] = new Array(list.length);
    list.forEach((p, i) => (out[at[cells[i]]++] = p));
    runsOf.set(key, start);
    return out;
  };
  // Streetlights: one sorted list per post design; `lights` is all of them (design order) for the poles and lamp indices.
  const lampPlan = planLamps(world);
  const designOf: (LampDesign | undefined)[] = [];
  for (const p of props) if (p.kind === 'streetlight') designOf[p.id] = lampPlan.design[p.light ?? p.id] ?? 'cobra';
  const lightsOf = {} as Record<LampDesign, Prop[]>;
  for (const d of LAMP_DESIGNS) lightsOf[d] = byKind('streetlight', `streetlight:${d}`, (p) => designOf[p.id] === d);
  const lights = LAMP_DESIGNS.flatMap((d) => lightsOf[d]);
  const traffic = byKind('trafficLight');
  const cans = byKind('garbageCan');
  const benches = byKind('bench');
  const stops = byKind('busStop');
  const utility = byKind('utilityPole');
  const drums = byKind('utilityPole', 'utilityPole:transformer', (p) => p.transformer === true);
  // Light order, not draw order: the park lamps' meshes draw their own sorted list.
  const lanterns = parkLamps(world);
  // Light index of every lamp prop (-1 for the rest): streetlights by `light`, park lamps after them.
  const lightOf = new Int32Array(props.length).fill(-1);
  for (const p of lights) lightOf[p.id] = p.light ?? p.id;
  lanterns.forEach((p, k) => (lightOf[p.id] = lights.length + k));

  const meshes: THREE.InstancedMesh[] = [];
  /** The kind each mesh draws and its instances per prop (null: not culled by cell, the stumps). */
  const kindOf: ({ kind: PropKind; key: string; per: number } | null)[] = [];
  const parts: PartRef[][] = props.map(() => []);
  /** Index of each pole in `poles` (-1 for the rest): picks its stump matrix. */
  const poleOf = new Int32Array(props.length).fill(-1);
  /** Slot of each broken pole's stump among the drawn ones (-1: standing), and the prop id in each slot. */
  const slotOf = new Int32Array(props.length).fill(-1);
  const idOf: number[] = [];
  const addMesh = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material, count: number, kind: PropKind | null, per = 1, key: string = kind ?? ''): number => {
    const m = new THREE.InstancedMesh(track(geo), mat, Math.max(1, count));
    m.count = count;
    m.name = name;
    meshes.push(m);
    kindOf.push(kind ? { kind, key, per } : null);
    if (count > 0) group.add(m);
    return meshes.length - 1;
  };
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3(1, 1, 1);
  const place = (mesh: number, index: number, p: Prop | null, x: number, y: number, z: number, yaw: number, sx = 1): void => {
    quat.setFromAxisAngle(up, yaw);
    pos.set(x, y, z);
    scl.set(sx, 1, 1);
    mat4.compose(pos, quat, scl);
    meshes[mesh].setMatrixAt(index, mat4);
    if (p) parts[p.id].push({ mesh, index });
  };

  // Streetlights.
  for (const d of LAMP_DESIGNS) {
    const list = lightsOf[d];
    if (!list.length) continue;
    const geo = streetlightGeo(q, d);
    const key = `streetlight:${d}`;
    const suffix = d === 'cobra' ? '' : `:${d}`;
    const solid = addMesh(`streetlightPoles${suffix}`, geo.solid, solidMat, list.length, 'streetlight', 1, key);
    const lens = addMesh(`streetlightLenses${suffix}`, geo.lens, lampLensMat, list.length, 'streetlight', 1, key);
    list.forEach((p, i) => {
      place(solid, i, p, p.x, p.y, p.z, p.yaw);
      place(lens, i, p, p.x, p.y, p.z, p.yaw);
      meshes[lens].setColorAt(i, toneColor(LAMP_TONES[lampPlan.tone[p.light ?? p.id] ?? 'sodium'].lens));
    });
  }

  // Traffic lights: each serves the road on one side of its corner with a mast
  // arm and two hanging heads, plus a pole mounted head for the other road.
  const frames: TrafficFrame[] = traffic.map((p) => trafficFrame(world, p));
  const lensOffsets = new Float32Array(traffic.length * 3);
  {
    const pole = addMesh('trafficPoles', trafficPoleGeo(q), solidMat, traffic.length, 'trafficLight');
    const arm = addMesh('trafficArms', trafficArmGeo(), solidMat, traffic.length, 'trafficLight');
    const head = addMesh('trafficHeads', trafficHeadGeo(), solidMat, traffic.length * 3, 'trafficLight', 3);
    const lens = addMesh('trafficLenses', trafficLensGeo(), lensMat, traffic.length * 3, 'trafficLight', 3);
    traffic.forEach((p, i) => {
      const f = frames[i];
      place(pole, i, p, p.x, p.y, p.z, p.yaw);
      place(arm, i, p, p.x, p.y + TRAFFIC_ARM_Y, p.z, Math.atan2(-f.az, f.ax), f.len);
      trafficHeads(world, p, f).forEach((h, k) => {
        place(head, i * 3 + k, p, h.x, h.y, h.z, h.yaw);
        place(lens, i * 3 + k, p, h.x, h.y, h.z, h.yaw);
        lensOffsets[i * 3 + k] = h.offset;
      });
    });
    meshes[lens].geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(lensOffsets, 1));
  }

  // Power poles, and the transformer drums on every fourth (a part of its pole: it goes when the pole does).
  if (utility.length) {
    const m = addMesh('utilityPoles', utilityPoleGeo(q), matteMat, utility.length, 'utilityPole');
    utility.forEach((p, i) => place(m, i, p, p.x, p.y, p.z, p.yaw));
    const d = addMesh('utilityTransformers', utilityTransformerGeo(q), solidMat, drums.length, 'utilityPole', 1, 'utilityPole:transformer');
    drums.forEach((p, i) => place(d, i, p, p.x, p.y, p.z, p.yaw));
  }

  // Stumps left behind by broken poles: capacity for every pole, but only the broken ones are drawn (count grows
  // with each break; a repair swaps the last stump into the freed slot). Never frustum culled: its bounds would
  // be computed over an empty or changing set.
  const poles = [...lights, ...traffic, ...lanterns, ...utility];
  const stump = addMesh('propStumps', stumpGeo(q), solidMat, poles.length, null);
  // Per slot tint: steel stumps as built, a power pole's lifted to timber (the slots move, so the tint moves with them).
  for (let i = 0; i < poles.length; i++) meshes[stump].setColorAt(i, STEEL_STUMP);
  poles.forEach((p, i) => (poleOf[p.id] = i));
  meshes[stump].count = 0;
  meshes[stump].visible = false;
  meshes[stump].frustumCulled = false;

  // Garbage cans, tinted per instance.
  {
    const m = addMesh('garbageCans', canGeo(q), solidMat, cans.length, 'garbageCan');
    cans.forEach((p, i) => {
      place(m, i, p, p.x, p.y, p.z, p.yaw + hash01(p.id) * 6.28);
      meshes[m].setColorAt(i, CAN_TINTS[(hash01(p.id * 31) * CAN_TINTS.length) | 0]);
    });
  }
  {
    const m = addMesh('benches', benchGeo(q), solidMat, benches.length, 'bench');
    benches.forEach((p, i) => place(m, i, p, p.x, p.y, p.z, p.yaw));
  }
  const adTint: THREE.Color[] = [];
  {
    const geo = busStopGeo();
    const solid = addMesh('busStops', geo.solid, solidMat, stops.length, 'busStop');
    const glass = addMesh('busStopGlass', geo.glass, glassMat, stops.length, 'busStop');
    const ad = addMesh('busStopAds', geo.ad, adMat, stops.length, 'busStop');
    const glow = addMesh('busStopLights', geo.glow, glowMat, stops.length, 'busStop');
    meshes[glass].renderOrder = 4;
    stops.forEach((p, i) => {
      for (const m of [solid, glass, ad, glow]) place(m, i, p, p.x, p.y, p.z, p.yaw);
      const tint = AD_TINTS[(hash01(p.id * 13) * AD_TINTS.length) | 0];
      meshes[ad].setColorAt(i, tint);
      adTint[p.id] = tint;
    });
  }

  // District clutter and neighbourhood furniture, tinted per instance; most clutter gets a random spin so rows never look stamped.
  const tintOf: THREE.Color[] = [];
  const regionOf = regionAt(world);
  for (const kind of PART_KINDS) {
    const list = byKind(kind);
    if (!list.length) continue;
    const def = PARTS[kind]!;
    const matOf = { matte: matteMat, canopy: canopyMat, solid: solidMat, glow: glowMat, lamp: lampLensMat, glass: glassMat } as const;
    const ids = def.parts.map((part, k) => addMesh(`${kind}${k}`, part.geo(q), matOf[part.mat], list.length, kind));
    // Glass after the opaque pass, like the bus shelters'.
    def.parts.forEach((part, k) => part.mat === 'glass' && (meshes[ids[k]].renderOrder = 4));
    list.forEach((p, i) => {
      const yaw = p.yaw + (def.spin ? hash01(p.id * 7) * 6.28 : 0);
      // A New York home paints its hydrants red (cityIdentity.ts `hydrantRed`): the first tint of the kind, by a hash of the prop.
      const red = kind === 'hydrant' && hash01(p.id * 29) < (signatureAt(world.seed, regionOf(p.x, p.z)).hydrantRed ?? 0);
      const tint = tmpTint.setHex(def.tints[red ? 0 : (hash01(p.id * 17) * def.tints.length) | 0]).multiplyScalar(0.85 + 0.3 * hash01(p.id * 23));
      tintOf[p.id] = tint.clone();
      def.parts.forEach((part, k) => {
        place(ids[k], i, p, p.x, p.y, p.z, yaw);
        if (part.tint) meshes[ids[k]].setColorAt(i, tint);
      });
    });
  }

  // Keep the intact matrices so a prop can be restored.
  const intact = meshes.map((m) => (m.instanceMatrix.array as Float32Array).slice());

  // Cell culling: every kind's part meshes keep their full-order buffers and per-cell bounds. The GPU starts
  // with everything drawn in full order (slot = index), so the first view() only has to drop cells.
  const nCells = grid.count;
  const cellOfMesh: (CellMesh | null)[] = meshes.map(() => null);
  const cellMeshes: CellMesh[] = [];
  /** Height range of every prop's bounds (m): a camera above or below it reaches fewer cells. */
  let propMinY = Infinity;
  let propMaxY = -Infinity;
  {
    const geoBox = new THREE.Box3();
    const ib = new THREE.Box3();
    meshes.forEach((m, mi) => {
      const k = kindOf[mi];
      if (!k || m.count === 0) return;
      const runs = runsOf.get(k.key)!;
      const start = new Uint32Array(nCells + 1);
      for (let c = 0; c <= nCells; c++) start[c] = runs[c] * k.per;
      const box = new Float32Array(nCells * 6);
      for (let c = 0; c < nCells; c++) {
        box[c * 6] = box[c * 6 + 1] = box[c * 6 + 2] = Infinity;
        box[c * 6 + 3] = box[c * 6 + 4] = box[c * 6 + 5] = -Infinity;
      }
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      geoBox.copy(m.geometry.boundingBox!);
      for (let c = 0; c < nCells; c++)
        for (let i = start[c]; i < start[c + 1]; i++) {
          m.getMatrixAt(i, mat4);
          ib.copy(geoBox).applyMatrix4(mat4);
          const o = c * 6;
          box[o] = Math.min(box[o], ib.min.x);
          box[o + 1] = Math.min(box[o + 1], ib.min.y);
          box[o + 2] = Math.min(box[o + 2], ib.min.z);
          box[o + 3] = Math.max(box[o + 3], ib.max.x);
          box[o + 4] = Math.max(box[o + 4], ib.max.y);
          box[o + 5] = Math.max(box[o + 5], ib.max.z);
          propMinY = Math.min(propMinY, ib.min.y);
          propMaxY = Math.max(propMaxY, ib.max.y);
        }
      const offset = m.geometry.getAttribute('aOffset') as THREE.InstancedBufferAttribute | undefined;
      const cm: CellMesh = {
        mesh: m,
        cls: cullOf[k.kind] ?? 'detail',
        start,
        state: intact[mi].slice(),
        color: m.instanceColor ? (m.instanceColor.array as Float32Array).slice() : null,
        offset: offset ? (offset.array as Float32Array).slice() : null,
        slot: Int32Array.from({ length: m.count }, (_, i) => i),
        box,
      };
      cellOfMesh[mi] = cm;
      cellMeshes.push(cm);
      // Exact bounds (the default sphere would be computed once over the whole city), the lenses included.
      m.frustumCulled = true;
      m.boundingSphere = new THREE.Sphere();
      fitBounds(cm, null);
    });
  }
  /** Cells drawn now per class (1 = drawn); all of them until the first view(). */
  const drawn: Record<PropCullClass, Uint8Array> = { detail: new Uint8Array(nCells).fill(1), fog: new Uint8Array(nCells).fill(1) };
  const nextCells = new Uint8Array(nCells);
  const wideCells = new Uint8Array(nCells);
  const camPos = new THREE.Vector3();
  const cullStats = { compactions: 0, lastBytes: 0 };

  /** Write one instance's matrix (16 floats) into its full-order state and, when its cell is drawn, its GPU slot. */
  const writeMatrix = (mi: number, i: number, src: ArrayLike<number>) => {
    const m = meshes[mi];
    const cm = cellOfMesh[mi];
    const arr = m.instanceMatrix.array as Float32Array;
    if (!cm) arr.set(src, i * 16);
    else {
      cm.state.set(src, i * 16);
      const s = cm.slot[i];
      if (s < 0) return;
      arr.set(src, s * 16);
      m.instanceMatrix.addUpdateRange(s * 16, 16);
    }
    m.instanceMatrix.needsUpdate = true;
  };

  /**
   * Pick a class's cells within cut (m) of the camera's lattice square, keeping drawn ones until cut + hysteresis.
   * The reach shrinks with the camera's height above (or depth below) every prop. Returns the first cell whose
   * state changed (nCells: none).
   */
  const pickCells = (bits: Uint8Array, cut: number): number => {
    const dy = Math.max(0, camPos.y - propMaxY, propMinY - camPos.y);
    const far = cut + PROP_CHUNKS.hysteresis;
    const L = PROP_CHUNKS.snap;
    const sx = grid.minX + (Math.floor((camPos.x - grid.minX) / L) + 0.5) * L;
    const sz = grid.minZ + (Math.floor((camPos.z - grid.minZ) / L) + 0.5) * L;
    grid.cellsWithin(sx, sz, cut > dy ? Math.sqrt(cut * cut - dy * dy) : -1, nextCells, L / 2);
    grid.cellsWithin(sx, sz, far > dy ? Math.sqrt(far * far - dy * dy) : -1, wideCells, L / 2);
    let first = nCells;
    for (let c = 0; c < nCells; c++) {
      const v = nextCells[c] | (bits[c] & wideCells[c]);
      if (v !== bits[c]) {
        bits[c] = v;
        if (first === nCells) first = c;
      }
    }
    return first;
  };

  /**
   * Copy the drawn cells' runs to the front of the mesh's GPU buffers. Cells before `from` kept their state, so their
   * runs already sit where they belong and only the rest is copied and uploaded. Returns the bytes uploaded.
   */
  const compact = (cm: CellMesh, bits: Uint8Array, from: number): number => {
    const m = cm.mesh;
    const gm = m.instanceMatrix.array as Float32Array;
    const gc = m.instanceColor ? (m.instanceColor.array as Float32Array) : null;
    const offAttr = cm.offset ? (m.geometry.getAttribute('aOffset') as THREE.InstancedBufferAttribute) : null;
    const go = offAttr ? (offAttr.array as Float32Array) : null;
    let k = 0;
    for (let c = 0; c < from; c++) if (bits[c]) k += cm.start[c + 1] - cm.start[c];
    const k0 = k;
    cm.slot.fill(-1, cm.start[from]);
    for (let c = from; c < nCells; c++) {
      const s = cm.start[c];
      const e = cm.start[c + 1];
      if (!bits[c] || e === s) continue;
      gm.set(cm.state.subarray(s * 16, e * 16), k * 16);
      if (gc && cm.color) gc.set(cm.color.subarray(s * 3, e * 3), k * 3);
      if (go && cm.offset) go.set(cm.offset.subarray(s, e), k);
      for (let i = s; i < e; i++) cm.slot[i] = k + i - s;
      k += e - s;
    }
    m.count = k;
    m.visible = k > 0;
    fitBounds(cm, bits);
    const n = k - k0;
    if (n <= 0) return 0;
    // Ranges add to any single-instance writes (breaks) pending this frame.
    m.instanceMatrix.addUpdateRange(k0 * 16, n * 16);
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) {
      m.instanceColor.addUpdateRange(k0 * 3, n * 3);
      m.instanceColor.needsUpdate = true;
    }
    if (offAttr) {
      offAttr.addUpdateRange(k0, n);
      offAttr.needsUpdate = true;
    }
    return n * 4 * (16 + (gc ? 3 : 0) + (go ? 1 : 0));
  };
  const stumpBase = new Float32Array(poles.length * 16);
  poles.forEach((p, i) => {
    quat.setFromAxisAngle(up, p.yaw);
    mat4.compose(pos.set(p.x, p.y, p.z), quat, scl.set(1, 1, 1));
    mat4.toArray(stumpBase, i * 16);
  });

  // The wires between the power poles: one merged line mesh for the city.
  const wires = buildUtilityWires(props, q);
  if (wires) {
    group.add(wires.lines);
    disposables.push(wires);
  }

  const debris = new Debris(world.heightAt);
  const clutterYaw = (p: Prop) => p.yaw + (PARTS[p.kind]?.spin ? hash01(p.id * 7) * 6.28 : 0);
  group.add(debris.group);
  // Broken hydrants gush for the rest of the race.
  const spray = buildHydrantSpray();
  group.add(spray.mesh);
  const shown = new Uint8Array(props.length);
  const tmpC = new THREE.Color();

  const setBroken = (p: Prop, broken: boolean) => {
    for (const r of parts[p.id]) {
      writeMatrix(r.mesh, r.index, broken ? ZERO : intact[r.mesh].subarray(r.index * 16, r.index * 16 + 16));
    }
    const pole = poleOf[p.id];
    if (pole >= 0) {
      const m = meshes[stump];
      const arr = m.instanceMatrix.array as Float32Array;
      if (broken && slotOf[p.id] < 0) {
        const slot = m.count++;
        arr.set(stumpBase.subarray(pole * 16, pole * 16 + 16), slot * 16);
        m.setColorAt(slot, p.kind === 'utilityPole' ? TIMBER_STUMP : STEEL_STUMP);
        slotOf[p.id] = slot;
        idOf[slot] = p.id;
      } else if (!broken && slotOf[p.id] >= 0) {
        const slot = slotOf[p.id];
        const last = --m.count;
        if (slot !== last) {
          arr.copyWithin(slot * 16, last * 16, last * 16 + 16);
          m.setColorAt(slot, props[idOf[last]].kind === 'utilityPole' ? TIMBER_STUMP : STEEL_STUMP);
          idOf[slot] = idOf[last];
          slotOf[idOf[slot]] = slot;
        }
        slotOf[p.id] = -1;
      }
      m.visible = m.count > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    if (p.kind === 'utilityPole') wires?.setBroken(p.id, broken);
    if (lightOf[p.id] >= 0) opts.onLamp?.(lightOf[p.id], !broken);
    opts.onBroken?.(p.id, broken);
  };

  // ---------- Debris ----------
  /** World position of a local offset in a yaw frame. */
  const wx = (p: Prop, yaw: number, lx: number, lz: number) => p.x + lx * Math.cos(yaw) + lz * Math.sin(yaw);
  const wz = (p: Prop, yaw: number, lx: number, lz: number) => p.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);

  const shatter = (p: Prop, hitVx: number, hitVz: number) => {
    let speed = Math.hypot(hitVx, hitVz);
    let dx: number;
    let dz: number;
    if (speed > 0.5) {
      dx = hitVx / speed;
      dz = hitVz / speed;
    } else {
      // No car nearby (or a slow nudge): fall away from the road.
      dx = -Math.sin(p.yaw);
      dz = -Math.cos(p.yaw);
      speed = 4;
    }
    speed = Math.min(speed, 38);
    const spawn = (
      type: DebrisType,
      lx: number,
      ly: number,
      lz: number,
      yaw: number,
      hx: number,
      hy: number,
      hz: number,
      push: number,
      lift: number,
      spin: number,
      color: THREE.Color,
      life = rnd(4, 5.5),
      sparky = false,
    ) =>
      debris.spawn({
        type,
        x: wx(p, p.yaw, lx, lz),
        y: p.y + ly,
        z: wz(p, p.yaw, lx, lz),
        yaw,
        hx,
        hy,
        hz,
        vx: dx * speed * push + rnd(-1, 1) * (1 + speed * 0.05),
        vy: lift,
        vz: dz * speed * push + rnd(-1, 1) * (1 + speed * 0.05),
        wx: rnd(-spin, spin),
        wy: rnd(-spin, spin),
        wz: rnd(-spin, spin),
        color,
        life,
        sparky,
        bounce: type === D_GLASS ? 0.12 : 0.25,
      });

    if (p.kind === 'utilityPole') {
      // The shaft snaps at its base and falls along the hit; the crossarm and any drum go with it, and the lines arc.
      const U = UTILITY_POLE;
      const len = U.h - STUMP_H;
      const oy = p.y + STUMP_H + len / 2;
      const vx = dx * speed * 0.16;
      const vz = dz * speed * 0.16;
      const vy = 0.4 + speed * 0.03;
      const w = 0.22 + speed * 0.025;
      const wood = col(0x5b4532);
      debris.spawn({ type: D_CYL, x: p.x, y: oy, z: p.z, yaw: p.yaw, hx: 0.14, hy: len / 2, hz: 0.14, vx, vy, vz, wx: dz * w, wy: rnd(-0.3, 0.3), wz: -dx * w, color: wood, life: rnd(6, 7) });
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      const armMid = (U.armZ[0] + U.armZ[1]) / 2;
      const ax = p.x + fx * armMid;
      const az = p.z + fz * armMid;
      debris.spawn({ type: D_BOX, x: ax, y: p.y + U.armY, z: az, yaw: p.yaw, hx: 0.06, hy: 0.06, hz: (U.armZ[1] - U.armZ[0]) / 2, vx: vx * 1.6, vy, vz: vz * 1.6, wx: rnd(-1.5, 1.5), wy: rnd(-1.5, 1.5), wz: rnd(-1.5, 1.5), color: col(0x4a3a2a), life: rnd(5.5, 6.5) });
      if (p.transformer)
        debris.spawn({ type: D_CYL, x: p.x + fx * U.drumZ, y: p.y + U.drumY, z: p.z + fz * U.drumZ, yaw: p.yaw, hx: U.drumR, hy: U.drumH / 2, hz: U.drumR, vx: vx * 1.3, vy, vz: vz * 1.3, wx: rnd(-1, 1), wy: rnd(-1, 1), wz: rnd(-1, 1), color: col(0x7c838c), life: rnd(5.5, 6.5), sparky: true });
      // The lines short as they part: a shower of sparks off every insulator, a bigger one off a drum.
      for (const z of U.wireZ) debris.burst(p.x + fx * z, p.y + U.armY + U.wireLift, p.z + fz * z, dx, dz, 5 + speed * 0.15, 18);
      if (p.transformer) debris.burst(p.x + fx * U.drumZ, p.y + U.drumY, p.z + fz * U.drumZ, dx, dz, 7, 30);
      debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.3 + 2, 10);
      return;
    }

    if (p.kind === 'streetlight' || p.kind === 'trafficLight' || p.kind === 'parkLamp') {
      const isLamp = p.kind === 'streetlight';
      const isLantern = p.kind === 'parkLamp';
      const dim = LAMP_DIMS[designOf[p.id] ?? 'cobra'];
      const H = isLamp ? dim.h : isLantern ? PARK_LAMP_H : TRAFFIC_POLE_H;
      const len = H - STUMP_H;
      // The pole topples about its broken base, top falling along the hit direction.
      const ox = p.x;
      const oz = p.z;
      const oy = p.y + STUMP_H + len / 2;
      const vx = dx * speed * 0.2;
      const vz = dz * speed * 0.2;
      const vy = 0.6 + speed * 0.04;
      const w = 0.3 + speed * 0.03;
      const twx = dz * w;
      const twz = -dx * w;
      const twy = rnd(-0.4, 0.4);
      const metal = col(isLamp ? 0x2a2c33 : isLantern ? 0x22252b : 0x3a3d44);
      const r = isLantern ? 0.07 : 0.12;
      debris.spawn({ type: D_CYL, x: ox, y: oy, z: oz, yaw: p.yaw, hx: r, hy: len / 2, hz: r, vx, vy, vz, wx: twx, wy: twy, wz: twz, color: metal, life: rnd(5.5, 6.5), sparky: true });
      // Parts at the top start with the pole's rigid velocity, then fly loose.
      const attached = (type: DebrisType, x: number, y: number, z: number, yaw: number, hx: number, hy: number, hz: number, color: THREE.Color, life: number, kick = 0) => {
        const rx = x - ox;
        const ry = y - oy;
        const rz = z - oz;
        debris.spawn({
          type,
          x,
          y,
          z,
          yaw,
          hx,
          hy,
          hz,
          vx: vx + (twy * rz - twz * ry) + rnd(-kick, kick),
          vy: vy + (twz * rx - twx * rz) + rnd(0, kick),
          vz: vz + (twx * ry - twy * rx) + rnd(-kick, kick),
          wx: rnd(-2, 2),
          wy: rnd(-2, 2),
          wz: rnd(-2, 2),
          color,
          life,
          sparky: type !== D_GLASS,
          bounce: type === D_GLASS ? 0.12 : 0.25,
        });
      };
      if (isLamp) {
        const A = dim.reach;
        const design = designOf[p.id] ?? 'cobra';
        const glowCol = col(LAMP_TONES[lampPlan.tone[p.light ?? p.id] ?? 'sodium'].lens, 3);
        const fx = Math.sin(p.yaw);
        const fz = Math.cos(p.yaw);
        // Head: the housing and glowing lens of the design (cobra and modern hang under an arm, the historic lantern sits on the post).
        const headY = design === 'historic' ? H + 0.45 : design === 'modern' ? H - 0.2 : H - 0.25;
        const glowY = design === 'historic' ? H + 0.2 : design === 'modern' ? H - 0.25 : H - 0.36;
        const half = design === 'historic' ? [0.25, 0.05, 0.25] : design === 'modern' ? [0.15, 0.035, 0.5] : [0.225, 0.08, 0.45];
        const glowHalf = design === 'historic' ? [0.15, 0.2, 0.15] : design === 'modern' ? [0.11, 0.015, 0.45] : [0.17, 0.02, 0.33];
        if (A > 0) attached(D_BOX, p.x + fx * A * 0.5, p.y + H - 0.1, p.z + fz * A * 0.5, p.yaw, 0.05, 0.05, A / 2, metal, rnd(5, 6));
        attached(D_BOX, p.x + fx * A, p.y + headY, p.z + fz * A, p.yaw, half[0], half[1], half[2], metal, rnd(5, 6), 0.5);
        attached(D_GLOW, p.x + fx * A, p.y + glowY, p.z + fz * A, p.yaw, glowHalf[0], glowHalf[1], glowHalf[2], glowCol, rnd(4, 5), 1.5);
        for (let k = 0; k < 7; k++) attached(D_GLASS, p.x + fx * A + rnd(-0.2, 0.2), p.y + glowY, p.z + fz * A + rnd(-0.3, 0.3), rnd(0, 6.28), rnd(0.04, 0.1), 0.008, rnd(0.04, 0.12), col(0xfff0d8), rnd(2.5, 4), 3);
        debris.burst(p.x + fx * A, p.y + glowY + 0.01, p.z + fz * A, dx, dz, 3, 14);
      } else if (isLantern) {
        const Y = PARK_LANTERN_Y;
        attached(D_CYL, p.x, p.y + Y + 0.4, p.z, p.yaw, 0.28, 0.06, 0.28, metal, rnd(5, 6), 0.8);
        attached(D_GLOW, p.x, p.y + Y, p.z, p.yaw, 0.15, 0.25, 0.15, col(0xffd6a0, 2.5), rnd(3.5, 4.5), 1.2);
        for (let k = 0; k < 8; k++) attached(D_GLASS, p.x + rnd(-0.2, 0.2), p.y + Y + rnd(-0.25, 0.25), p.z + rnd(-0.2, 0.2), rnd(0, 6.28), rnd(0.04, 0.1), 0.008, rnd(0.04, 0.12), col(0xfff0d8), rnd(2.5, 4), 3);
        debris.burst(p.x, p.y + Y, p.z, dx, dz, 2.5, 10);
      } else {
        const f = frames[traffic.indexOf(p)];
        if (f) {
          const ay = Math.atan2(-f.az, f.ax);
          attached(D_BOX, p.x + f.ax * f.len * 0.5, p.y + TRAFFIC_ARM_Y, p.z + f.az * f.len * 0.5, ay, f.len / 2, 0.06, 0.06, metal, rnd(5, 6));
          const ya = yawOf(f.fax, f.faz);
          for (const t of [0.55, 0.92]) attached(D_BOX, p.x + f.ax * f.len * t, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * t, ya, 0.18, 0.5, 0.15, col(0x15161a), rnd(5, 6), 1);
          attached(D_BOX, p.x + f.fbx * 0.32, p.y + 3.1, p.z + f.fbz * 0.32, yawOf(f.fbx, f.fbz), 0.18, 0.5, 0.15, col(0x15161a), rnd(5, 6), 1);
          const lensCols = [col(0xff1a10, 3), col(0xff8a10, 3), col(0x20ff80, 3)];
          for (let k = 0; k < 5; k++) {
            const t = rnd(0.5, 0.95);
            attached(D_GLOW, p.x + f.ax * f.len * t, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * t, rnd(0, 6.28), 0.06, 0.06, 0.012, lensCols[k % 3], rnd(2.5, 4), 3);
          }
          debris.burst(p.x + f.ax * f.len * 0.7, p.y + TRAFFIC_ARM_Y - 0.6, p.z + f.az * f.len * 0.7, dx, dz, 2, 10);
        }
      }
      // Sparks where the car sheared the pole off.
      debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.45 + 3, 26);
      return;
    }

    if (p.kind === 'garbageCan') {
      const tint = CAN_TINTS[(hash01(p.id * 31) * CAN_TINTS.length) | 0];
      spawn(D_CYL, 0, 0.46, 0, 0, 0.3, 0.45, 0.3, rnd(0.6, 0.8), 2 + speed * 0.12, 7, tmpC.copy(tint).multiplyScalar(0.7));
      spawn(D_CYL, 0, 0.95, 0, 0, 0.33, 0.035, 0.33, rnd(0.6, 0.9), 3.5 + speed * 0.16, 12, col(0x30343a));
      const trash = [0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a, 0xe8e0a0, 0x505a68];
      for (let k = 0; k < 9; k++) {
        const s = rnd(0.04, 0.11);
        spawn(D_BOX, rnd(-0.2, 0.2), rnd(0.3, 0.8), rnd(-0.2, 0.2), rnd(0, 6.28), s, s * rnd(0.3, 1), s * rnd(0.5, 1.4), rnd(0.35, 0.8), rnd(1.5, 4.5) + speed * 0.05, 10, col(trash[k % trash.length]), rnd(3, 4.5));
      }
      return;
    }

    if (p.kind === 'bench') {
      const wood = col(0x7a5434);
      const iron = col(0x1a1b1f);
      for (const z of [-0.14, 0, 0.14]) spawn(D_BOX, rnd(-0.1, 0.1), 0.46, z, p.yaw + rnd(-0.2, 0.2), 0.9, 0.02, 0.06, rnd(0.45, 0.7), rnd(1.5, 3.5) + speed * 0.06, 5, wood);
      for (const y of [0.64, 0.82]) spawn(D_BOX, rnd(-0.1, 0.1), y, -0.25, p.yaw + rnd(-0.2, 0.2), 0.9, 0.065, 0.02, rnd(0.45, 0.7), rnd(2, 4) + speed * 0.06, 5, wood);
      for (const x of [-0.75, 0.75]) spawn(D_BOX, x, 0.35, 0, p.yaw, 0.03, 0.33, 0.22, rnd(0.4, 0.6), rnd(1, 3), 6, iron, rnd(4, 5.5), true);
      debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.3 + 2, 8);
      return;
    }

    if (isFurniture(p.kind)) {
      shatterFurniture(p.kind, spawn, speed, p.yaw, tintOf[p.id] ?? col(0xffffff), (ly, sp, n) => debris.burst(p.x, p.y + ly, p.z, dx, dz, sp, n));
      return;
    }
    if (p.kind !== 'busStop') {
      shatterClutter(p, spawn, speed, dx, dz);
      return;
    }
    {
      const frame = col(0x2b2e36);
      spawn(D_BOX, 0, 2.52, 0.04, p.yaw + rnd(-0.1, 0.1), 1.75, 0.05, 0.86, rnd(0.2, 0.35), rnd(1.5, 3), 1.5, frame, rnd(5, 6), true);
      for (const x of [-1.55, 1.55]) for (const z of [-0.62, 0.6]) spawn(D_BOX, x, 1.24, z, p.yaw, 0.04, 1.22, 0.04, rnd(0.3, 0.6), rnd(1, 3), 4, frame, rnd(4.5, 6), true);
      spawn(D_GLOW, 1.55, 1.25, -0.02, p.yaw, 0.08, 0.95, 0.56, rnd(0.3, 0.5), rnd(1, 2.5), 3, (adTint[p.id] ?? AD_TINTS[0]).clone());
      spawn(D_BOX, -0.2, 0.46, -0.4, p.yaw + rnd(-0.2, 0.2), 1.2, 0.03, 0.19, rnd(0.4, 0.6), rnd(1, 3), 3, col(0x8a9099));
      const glass = col(0xbfe0ff);
      for (let k = 0; k < 28; k++) {
        const back = k < 20;
        const lx = back ? rnd(-1.5, 1.5) : -1.55;
        const lz = back ? -0.62 : rnd(-0.55, 0.3);
        spawn(D_GLASS, lx, rnd(0.3, 2.3), lz, rnd(0, 6.28), rnd(0.06, 0.2), rnd(0.06, 0.2), 0.008, rnd(0.25, 0.75), rnd(0.5, 3.5), 9, glass, rnd(2.5, 4));
      }
      debris.burst(p.x, p.y + 1.2, p.z, dx, dz, speed * 0.3 + 2, 12);
    }
  };

  /** District clutter coming apart; `spawn` takes local offsets in the prop's frame. */
  function shatterClutter(p: Prop, spawn: SpawnFn, speed: number, dx: number, dz: number): void {
    const tint = tintOf[p.id] ?? col(0xffffff);
    const yaw = clutterYaw(p);
    const leaves = (n: number, y0: number, y1: number, r: number, base: number) => {
      for (let k = 0; k < n; k++) {
        const s = rnd(0.05, 0.14);
        const c = col(base, rnd(0.75, 1.15)).multiply(tint);
        spawn(D_BOX, rnd(-r, r), rnd(y0, y1), rnd(-r, r), rnd(0, 6.28), s, s * 0.4, s, rnd(0.35, 0.8), rnd(1.5, 4) + speed * 0.06, 10, c, rnd(2.5, 4));
      }
    };
    switch (p.kind) {
      case 'bush':
        leaves(16, 0.2, 1.0, 0.6, 0x3d7436);
        for (let k = 0; k < 4; k++) spawn(D_CYL, rnd(-0.2, 0.2), 0.4, rnd(-0.2, 0.2), rnd(0, 6.28), 0.02, rnd(0.2, 0.35), 0.02, rnd(0.4, 0.7), rnd(1.5, 3), 8, col(0x4a3420), rnd(3, 4));
        return;
      case 'planterPot':
        for (let k = 0; k < 7; k++) {
          const s = rnd(0.1, 0.22);
          spawn(D_BOX, rnd(-0.35, 0.35), rnd(0.15, 0.55), rnd(-0.35, 0.35), rnd(0, 6.28), s, s * rnd(0.5, 1), s * rnd(0.6, 1.2), rnd(0.35, 0.7), rnd(1, 3) + speed * 0.05, 7, col(0x8a8c94, rnd(0.8, 1.1)).multiply(tint), rnd(4, 5.5));
        }
        for (let k = 0; k < 8; k++) spawn(D_BOX, rnd(-0.3, 0.3), 0.62, rnd(-0.3, 0.3), rnd(0, 6.28), 0.06, 0.04, 0.06, rnd(0.4, 0.8), rnd(1, 2.5), 6, col(0x2a1d14), rnd(2.5, 4));
        spawn(D_BOX, 0, 1.0, 0, rnd(0, 6.28), 0.32, 0.3, 0.32, rnd(0.5, 0.8), 2 + speed * 0.08, 6, col(0x3a6e34).multiply(tint));
        leaves(8, 0.8, 1.4, 0.4, 0x3a6e34);
        debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.2 + 1, 6);
        return;
      case 'bollard':
        // The post shears off its collar and tumbles; the collar stays put.
        spawn(D_CYL, 0, 0.55, 0, yaw, 0.14, 0.45, 0.14, rnd(0.5, 0.8), 2 + speed * 0.09, 7, col(0x3c4048), rnd(4.5, 6), true);
        spawn(D_CYL, 0, 0.05, 0, yaw, 0.2, 0.05, 0.2, rnd(0.1, 0.2), rnd(0.3, 0.8), 2, col(0x2a2c32), rnd(4, 5));
        debris.burst(p.x, p.y + 0.4, p.z, dx, dz, speed * 0.2 + 1, 5);
        return;
      case 'cafeTable': {
        const alu = col(0xb4b8c0);
        spawn(D_CYL, 0, 0.74, 0, yaw, 0.38, 0.02, 0.38, rnd(0.5, 0.8), 2.5 + speed * 0.1, 9, col(0xe6e6e2), rnd(4, 5.5), true);
        spawn(D_CYL, 0, 0.4, 0, yaw, 0.035, 0.36, 0.035, rnd(0.4, 0.7), rnd(1.5, 3), 6, alu, rnd(4, 5.5), true);
        for (const side of [-0.62, 0.62]) spawn(D_BOX, side, 0.5, 0, yaw + rnd(-0.5, 0.5), 0.21, 0.3, 0.21, rnd(0.55, 0.95), rnd(2, 4) + speed * 0.08, 10, alu, rnd(4, 5.5), true);
        spawn(D_BOX, 0, 2.05, 0, yaw, 1.05, 0.03, 1.05, rnd(0.25, 0.45), rnd(3, 5) + speed * 0.1, 4, tint.clone(), rnd(4.5, 6));
        spawn(D_CYL, 0, 1.5, 0, yaw, 0.025, 0.75, 0.025, rnd(0.3, 0.5), rnd(1.5, 3), 5, alu, rnd(4, 5.5));
        return;
      }
      case 'barrel':
        spawn(D_CYL, 0, 0.48, 0, yaw, 0.38, 0.47, 0.38, rnd(0.6, 0.9), 2.5 + speed * 0.12, 8, col(0xff6a1a), rnd(4.5, 6));
        spawn(D_CYL, 0, 0.97, 0, yaw, 0.29, 0.025, 0.29, rnd(0.6, 0.9), 3.5 + speed * 0.15, 12, col(0x1c1d20));
        debris.burst(p.x, p.y + 0.4, p.z, dx, dz, speed * 0.15 + 1, 4);
        return;
      case 'crate': {
        const wood = col(0x9a7444).multiply(tint);
        for (let k = 0; k < 9; k++) spawn(D_BOX, rnd(-0.35, 0.35), rnd(0.1, 1.1), rnd(-0.35, 0.35), rnd(0, 6.28), rnd(0.25, 0.43), 0.03, rnd(0.05, 0.08), rnd(0.45, 0.85), rnd(1.5, 4) + speed * 0.07, 9, wood.clone().multiplyScalar(rnd(0.7, 1.1)));
        spawn(D_BOX, 0.08, 1.0, -0.06, yaw, 0.31, 0.2, 0.31, rnd(0.5, 0.8), 2.5 + speed * 0.1, 6, wood);
        return;
      }
      case 'dumpster': {
        const body = col(0x2f6a46).multiply(tint);
        spawn(D_BOX, 0, 0.72, 0, p.yaw, 0.95, 0.54, 0.58, rnd(0.3, 0.45), 1 + speed * 0.05, 2.5, body, rnd(6, 7), true);
        spawn(D_BOX, 0, 1.4, 0, p.yaw + rnd(-0.3, 0.3), 0.98, 0.04, 0.61, rnd(0.35, 0.55), 3 + speed * 0.1, 5, col(0x1c2a22), rnd(5, 6), true);
        const trash = [0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a, 0xe8e0a0, 0x17191c];
        for (let k = 0; k < 12; k++) {
          const s = rnd(0.05, 0.16);
          spawn(D_BOX, rnd(-0.8, 0.8), rnd(0.8, 1.3), rnd(-0.4, 0.4), rnd(0, 6.28), s, s * rnd(0.4, 1), s, rnd(0.4, 0.8), rnd(2, 4.5) + speed * 0.06, 10, col(trash[k % trash.length]), rnd(3, 4.5));
        }
        debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.35 + 3, 22);
        return;
      }
      case 'newsBox':
        spawn(D_BOX, 0, 0.6, 0, p.yaw, 0.25, 0.46, 0.22, rnd(0.55, 0.85), 2 + speed * 0.1, 7, col(0xd8d8d8).multiply(tint), rnd(4.5, 6), true);
        spawn(D_GLASS, 0, 0.8, 0.23, p.yaw, 0.2, 0.16, 0.01, rnd(0.5, 0.8), rnd(2, 3.5), 8, col(0xbfe0ff), rnd(2.5, 4));
        for (let k = 0; k < 10; k++) spawn(D_BOX, rnd(-0.2, 0.2), rnd(0.5, 1), rnd(-0.2, 0.2), rnd(0, 6.28), rnd(0.1, 0.16), 0.004, rnd(0.12, 0.2), rnd(0.25, 0.6), rnd(2.5, 5), 4, col(0xeeeae0), rnd(3.5, 5));
        return;
      case 'fencePanel': {
        // The panel folds over and skates off; its feet stay near the line, wire and banner tear loose.
        const steel = col(0x9aa0a8);
        spawn(D_BOX, 0, 1.1, 0, p.yaw + rnd(-0.4, 0.4), 1.18, 0.98, 0.03, rnd(0.55, 0.85), rnd(1.5, 3) + speed * 0.06, 4, col(0x7a8088), rnd(4.5, 6), true);
        spawn(D_BOX, rnd(-0.3, 0.3), 1.0, 0.05, p.yaw + rnd(-0.6, 0.6), 1.12, 0.46, 0.012, rnd(0.4, 0.7), rnd(2.5, 4.5) + speed * 0.08, 6, tint.clone(), rnd(4.5, 6));
        for (const x of [-1.15, 1.15]) spawn(D_BOX, x, 0.07, 0, p.yaw + rnd(-0.5, 0.5), 0.13, 0.07, 0.31, rnd(0.15, 0.3), rnd(0.5, 1.2), 4, col(0x7e8086), rnd(5, 6.5));
        for (let k = 0; k < 6; k++) spawn(D_CYL, rnd(-1, 1), rnd(0.3, 1.9), 0, rnd(0, 6.28), 0.012, rnd(0.2, 0.45), 0.012, rnd(0.4, 0.9), rnd(1.5, 4), 10, steel, rnd(3, 4.5), true);
        return;
      }
      case 'trafficCone':
        spawn(D_CYL, 0, 0.4, 0, yaw, 0.12, 0.36, 0.12, rnd(0.7, 1.1), rnd(2.5, 5) + speed * 0.12, 12, col(0xff5a14), rnd(4, 5.5));
        spawn(D_BOX, 0, 0.02, 0, yaw, 0.22, 0.02, 0.22, rnd(0.4, 0.8), rnd(1, 2.5), 8, col(0x1c1d22), rnd(4, 5.5));
        return;
      case 'sawhorse': {
        for (const y of [0.6, 0.92]) spawn(D_BOX, rnd(-0.1, 0.1), y, 0, p.yaw + rnd(-0.5, 0.5), 0.7, 0.11, 0.02, rnd(0.55, 0.95), rnd(2, 4) + speed * 0.09, 9, col(y > 0.8 ? 0xff6a1a : 0xf4f4f0), rnd(4.5, 6));
        for (let k = 0; k < 4; k++) spawn(D_BOX, k < 2 ? -0.62 : 0.62, 0.5, k % 2 ? 0.22 : -0.22, rnd(0, 6.28), 0.025, 0.48, 0.025, rnd(0.4, 0.8), rnd(1.5, 3), 9, col(0x3a3c42), rnd(4, 5.5));
        spawn(D_GLOW, 0.55, 1.1, 0, rnd(0, 6.28), 0.055, 0.065, 0.04, rnd(0.6, 1), rnd(2.5, 4.5), 12, col(0xffa21a, 2.4), rnd(2.5, 3.5));
        return;
      }
      case 'waterBarrier': {
        // The shell splits and the water goes everywhere.
        for (let k = 0; k < 3; k++) spawn(D_BOX, -0.6 + 0.6 * k, 0.45, 0, p.yaw + rnd(-0.6, 0.6), 0.32, rnd(0.25, 0.4), 0.26, rnd(0.35, 0.65), rnd(1.5, 3.5) + speed * 0.06, 6, col(0xf4f4f0).multiply(tint), rnd(5, 6.5));
        for (let k = 0; k < 18; k++) spawn(D_GLASS, rnd(-0.8, 0.8), rnd(0.3, 0.8), rnd(-0.25, 0.25), rnd(0, 6.28), rnd(0.05, 0.12), rnd(0.05, 0.12), 0.01, rnd(0.3, 0.8), rnd(2, 4.5), 8, col(0x9fc6e0), rnd(1.2, 2.2));
        debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.25 + 2, 10);
        return;
      }
      case 'sandbags':
        for (let k = 0; k < 6; k++) spawn(D_BOX, rnd(-0.6, 0.6), rnd(0.1, 0.45), rnd(-0.1, 0.1), rnd(0, 6.28), 0.2, 0.08, 0.15, rnd(0.25, 0.55), rnd(0.8, 2) + speed * 0.04, 5, col(0xb09a6a, rnd(0.8, 1.05)).multiply(tint), rnd(5, 6.5));
        for (let k = 0; k < 10; k++) {
          const s = rnd(0.03, 0.07);
          spawn(D_BOX, rnd(-0.5, 0.5), rnd(0.2, 0.5), rnd(-0.15, 0.15), rnd(0, 6.28), s, s, s, rnd(0.3, 0.7), rnd(1, 3), 8, col(0xc8b080), rnd(2, 3.5));
        }
        debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.15 + 1, 6);
        return;
      case 'pallets': {
        const wood = col(0xa8875a).multiply(tint);
        for (let k = 0; k < 10; k++) spawn(D_BOX, rnd(-0.5, 0.5), rnd(0.05, 0.4), rnd(-0.4, 0.4), rnd(0, 6.28), rnd(0.4, 0.55), 0.015, rnd(0.05, 0.07), rnd(0.45, 0.85), rnd(1.5, 3.5) + speed * 0.07, 9, wood.clone().multiplyScalar(rnd(0.75, 1.1)));
        spawn(D_BOX, 0.05, 0.6, 0, yaw + rnd(-0.4, 0.4), 0.45, 0.18, 0.4, rnd(0.45, 0.75), rnd(2, 3.5) + speed * 0.08, 6, col(0x8a6a44).multiply(tint), rnd(5, 6.5), true);
        return;
      }
      case 'drum':
        // The drum folds and rolls off, the lid spins away and the oil splashes.
        spawn(D_CYL, 0, 0.45, 0, yaw, 0.28, 0.42, 0.28, rnd(0.6, 0.9), 2.5 + speed * 0.12, 8, tint.clone(), rnd(5, 6.5), true);
        spawn(D_CYL, 0, 0.9, 0, yaw, 0.28, 0.02, 0.28, rnd(0.6, 0.95), 3.5 + speed * 0.14, 12, col(0x2a2c30), rnd(4, 5.5));
        for (let k = 0; k < 8; k++) spawn(D_GLASS, rnd(-0.3, 0.3), rnd(0.2, 0.6), rnd(-0.3, 0.3), rnd(0, 6.28), rnd(0.05, 0.1), rnd(0.05, 0.1), 0.01, rnd(0.3, 0.7), rnd(1.5, 3.5), 8, col(0x14110c), rnd(1.5, 2.5));
        debris.burst(p.x, p.y + 0.4, p.z, dx, dz, speed * 0.15 + 1, 5);
        return;
      case 'cableSpool': {
        // The flanges split off and roll, the cable unwinds in loops.
        const wood = col(0xb08a58).multiply(tint);
        for (const x of [-0.47, 0.47]) spawn(D_CYL, x, 0.75, 0, yaw + rnd(-0.4, 0.4), 0.72, 0.03, 0.72, rnd(0.4, 0.7), rnd(2, 4) + speed * 0.08, 6, wood, rnd(5, 6.5), true);
        spawn(D_CYL, 0, 0.75, 0, yaw, 0.5, 0.42, 0.5, rnd(0.3, 0.5), 1.5 + speed * 0.06, 4, col(0x1c1d20), rnd(5.5, 6.5), true);
        for (let k = 0; k < 6; k++) spawn(D_BOX, rnd(-0.6, 0.6), rnd(0.3, 1.2), rnd(-0.5, 0.5), rnd(0, 6.28), rnd(0.2, 0.4), 0.03, rnd(0.05, 0.08), rnd(0.45, 0.85), rnd(1.5, 3.5) + speed * 0.07, 9, wood.clone().multiplyScalar(rnd(0.7, 1.1)));
        debris.burst(p.x, p.y + 0.5, p.z, dx, dz, speed * 0.2 + 1, 6);
        return;
      }
      case 'trashBags':
        for (let k = 0; k < 3; k++) spawn(D_BOX, rnd(-0.3, 0.3), 0.3, rnd(-0.3, 0.3), rnd(0, 6.28), rnd(0.22, 0.3), rnd(0.18, 0.25), rnd(0.22, 0.3), rnd(0.5, 0.9), rnd(1.5, 3.5) + speed * 0.06, 6, col(0x17191c), rnd(4, 5.5));
        for (let k = 0; k < 10; k++) {
          const s = rnd(0.04, 0.1);
          spawn(D_BOX, rnd(-0.3, 0.3), rnd(0.2, 0.6), rnd(-0.3, 0.3), rnd(0, 6.28), s, s * rnd(0.3, 1), s, rnd(0.4, 0.9), rnd(1.5, 4) + speed * 0.05, 10, col([0xd8d4c8, 0x8a6a40, 0xc0302a, 0x3a7a4a][k % 4]), rnd(3, 4.5));
        }
        return;
      case 'umbrella':
        // The canopy lifts off whole and sails, the pole snaps and drops.
        spawn(D_BOX, 0, 2.3, 0, p.yaw + rnd(-0.5, 0.5), 1.0, 0.03, 1.0, rnd(0.4, 0.7), rnd(3, 5) + speed * 0.1, 5, tint.clone(), rnd(4.5, 6));
        spawn(D_CYL, 0, 1.2, 0, rnd(0, 6.28), 0.03, 1.2, 0.03, rnd(0.4, 0.8), rnd(1.5, 3.5), 7, col(0xd8d4c8), rnd(4, 5.5));
        debris.burst(p.x, p.y + 0.3, p.z, dx, dz, speed * 0.15 + 1, 6);
        return;
      case 'lounger':
        spawn(D_BOX, 0, 0.3, 0, p.yaw + rnd(-0.6, 0.6), 0.3, 0.03, 0.55, rnd(0.4, 0.8), rnd(1.5, 3) + speed * 0.07, 6, tint.clone(), rnd(4.5, 6));
        for (const x of [-0.3, 0.3]) spawn(D_BOX, x, 0.2, 0, p.yaw + rnd(-0.8, 0.8), 0.025, 0.02, 0.9, rnd(0.4, 0.8), rnd(1.5, 3), 8, col(0xe8e8e0), rnd(4, 5.5));
        return;
      case 'volleyNet':
        spawn(D_BOX, 0, 2.0, 0, p.yaw + rnd(-0.4, 0.4), 0.95, 0.37, 0.01, rnd(0.5, 0.8), rnd(2, 3.5) + speed * 0.07, 5, col(0x15161a), rnd(4, 5.5));
        spawn(D_BOX, 0, 2.43, 0, p.yaw + rnd(-0.5, 0.5), 0.95, 0.04, 0.01, rnd(0.5, 0.8), rnd(2.5, 4), 6, col(0xf0f0ea), rnd(4, 5.5));
        for (const x of [-0.94, 0.94]) spawn(D_CYL, x, 1.2, 0, rnd(0, 6.28), 0.035, 1.2, 0.035, rnd(0.3, 0.7), rnd(1, 2.5), 7, col(0x9aa0a8), rnd(4, 5.5));
        return;
      case 'picketFence':
        for (let k = 0; k < 7; k++) spawn(D_BOX, rnd(-1, 1), rnd(0.3, 0.8), 0.04, rnd(0, 6.28), 0.05, 0.45, 0.013, rnd(0.5, 1), rnd(1.5, 3.5) + speed * 0.07, 9, col(0xd8d2c0, rnd(0.7, 1)), rnd(3.5, 5));
        spawn(D_BOX, 0, 0.5, 0, p.yaw + rnd(-0.5, 0.5), 1.2, 0.03, 0.02, rnd(0.4, 0.7), rnd(1.5, 3), 5, col(0x8a7a60), rnd(4, 5.5));
        return;
      case 'marketStall': {
        // The awning sails off over the car, the poles scatter, the goods go everywhere and the lanterns tumble, still lit.
        spawn(D_BOX, 0, 2.3, 0, p.yaw + rnd(-0.3, 0.3), 1.25, 0.02, 1.1, rnd(0.25, 0.45), rnd(3, 5) + speed * 0.1, 4, tint.clone(), rnd(4.5, 6));
        for (const x of [-STALL.halfW, STALL.halfW]) for (const z of [STALL.front, STALL.back]) spawn(D_CYL, x, 1.1, z, rnd(0, 6.28), 0.03, 1.1, 0.03, rnd(0.4, 0.8), rnd(1.5, 3.5), 6, col(0x6a4a2c), rnd(4, 5.5));
        spawn(D_BOX, 0, 0.82, 0.42, p.yaw + rnd(-0.4, 0.4), 0.98, 0.03, 0.33, rnd(0.45, 0.75), rnd(2, 3.5) + speed * 0.08, 5, col(0x6a4a30), rnd(4.5, 6));
        spawn(D_BOX, 0, 0.45, 0.76, p.yaw + rnd(-0.5, 0.5), 0.98, 0.36, 0.01, rnd(0.5, 0.85), rnd(1.5, 3) + speed * 0.06, 6, col(0x8a1f22), rnd(4, 5.5));
        const goods = [0xff7a1a, 0xd8202a, 0x6ab82a, 0xf2c81c, 0x8a2a6a, 0xa07a48];
        for (let k = 0; k < 16; k++) {
          const sz = rnd(0.05, 0.1);
          spawn(D_BOX, rnd(-0.85, 0.85), rnd(0.85, 1.1), rnd(0.15, 0.7), rnd(0, 6.28), sz, sz, sz, rnd(0.55, 1.05), rnd(2, 5) + speed * 0.07, 12, col(goods[k % goods.length]), rnd(3, 4.5));
        }
        for (const x of [-0.7, 0, 0.7]) spawn(D_GLOW, x, STALL.lanternY, STALL.front + 0.22, rnd(0, 6.28), 0.13, 0.15, 0.13, rnd(0.4, 0.8), rnd(2, 4) + speed * 0.06, 6, col(x ? 0xff4a2a : 0xffa040, 2.6), rnd(3, 4.5));
        return;
      }
      case 'fruitCrates': {
        const wood = col(0xa07a48).multiply(tint);
        for (let k = 0; k < 9; k++) spawn(D_BOX, rnd(-0.4, 0.4), rnd(0.1, 0.6), rnd(-0.2, 0.2), rnd(0, 6.28), rnd(0.2, 0.28), 0.015, rnd(0.04, 0.06), rnd(0.45, 0.85), rnd(1.5, 3.5) + speed * 0.07, 9, wood.clone().multiplyScalar(rnd(0.7, 1.1)));
        const fruit = [0xff7a1a, 0x6ab82a, 0xd8202a, 0xf2c81c];
        for (let k = 0; k < 18; k++) {
          const sz = rnd(0.045, 0.07);
          spawn(D_BOX, rnd(-0.45, 0.45), rnd(0.3, 0.7), rnd(-0.2, 0.2), rnd(0, 6.28), sz, sz, sz, rnd(0.6, 1.1), rnd(1.5, 4) + speed * 0.06, 14, col(fruit[k % fruit.length]), rnd(3.5, 5));
        }
        return;
      }
      case 'foodCart': {
        spawn(D_BOX, 0, 0.8, 0, p.yaw + rnd(-0.3, 0.3), 0.75, 0.45, 0.4, rnd(0.3, 0.5), rnd(1.5, 3) + speed * 0.06, 3, tint.clone(), rnd(5.5, 6.5), true);
        spawn(D_BOX, 0, 2.18, 0.05, p.yaw + rnd(-0.6, 0.6), 0.9, 0.03, 0.58, rnd(0.25, 0.45), rnd(3, 4.5) + speed * 0.1, 5, tint.clone(), rnd(4.5, 6), true);
        for (const x of [-0.5, 0.5]) spawn(D_CYL, x, 0.24, 0.45, rnd(0, 6.28), 0.22, 0.03, 0.22, rnd(0.5, 0.9), rnd(1.5, 3), 8, col(0x17181c), rnd(4.5, 6));
        spawn(D_GLOW, 0, 0.98, 0.41, p.yaw + rnd(-0.4, 0.4), 0.55, 0.16, 0.01, rnd(0.5, 0.85), rnd(2, 3.5) + speed * 0.08, 6, col(0xffe0a0, 2), rnd(3, 4.5));
        spawn(D_CYL, -0.4, 1.4, 0.05, rnd(0, 6.28), 0.17, 0.1, 0.17, rnd(0.5, 0.9), rnd(2.5, 4.5) + speed * 0.08, 9, col(0x5a5c62), rnd(4, 5.5), true);
        for (let k = 0; k < 8; k++) spawn(D_BOX, rnd(-0.6, 0.6), rnd(1.2, 1.4), rnd(-0.3, 0.4), rnd(0, 6.28), rnd(0.04, 0.09), 0.02, rnd(0.04, 0.09), rnd(0.5, 1), rnd(2, 4.5) + speed * 0.06, 10, col(0xe8e4dc), rnd(3, 4.5));
        debris.burst(p.x, p.y + 0.8, p.z, dx, dz, speed * 0.25 + 2, 10);
        return;
      }
    }
  }

  return {
    group,
    cullStats,
    view(camera, detailDistance, fogDistance) {
      if (!cellMeshes.length) return;
      camera.getWorldPosition(camPos);
      const detail = pickCells(drawn.detail, detailDistance);
      const fog = pickCells(drawn.fog, fogDistance);
      if (detail === nCells && fog === nCells) return;
      let bytes = 0;
      for (const cm of cellMeshes) {
        const from = cm.cls === 'detail' ? detail : fog;
        if (from < nCells) bytes += compact(cm, drawn[cm.cls], from);
      }
      cullStats.compactions++;
      cullStats.lastBytes = bytes;
    },
    update(dt, time, broken, cars, dirty) {
      lensMat.uniforms.time.value = time;
      if (broken && broken.length === props.length) {
        let fresh = 0;
        if (dirty) fresh = dirty.length;
        else for (let i = 0; i < props.length; i++) if (!shown[i] && broken[i]) fresh++;
        const n = dirty ? dirty.length : props.length;
        for (let j = 0; j < n; j++) {
          const i = dirty ? dirty[j] : j;
          if (i < 0 || i >= props.length) continue;
          const b = broken[i] ? 1 : 0;
          if (b === shown[i]) continue;
          shown[i] = b;
          const p = props[i];
          setBroken(p, b === 1);
          if (p.kind === 'hydrant') {
            if (broken[i] === 1) spray.start(p.id, p.x, p.y, p.z, time);
            else spray.stop(p.id);
          }
          // A bulk change (e.g. a state jump) just hides; a few fresh hits come apart.
          // 2 = removed for this route (under a barrier/rail): just hidden.
          if (b && broken[i] === 1 && fresh <= 6) {
            let best = 144;
            let vx = 0;
            let vz = 0;
            for (const c of cars) {
              const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
              if (d < best) {
                best = d;
                vx = c.vx;
                vz = c.vz;
              }
            }
            shatter(p, vx, vz);
          }
        }
      }
      debris.update(dt);
      spray.update(time);
    },
    dispose() {
      debris.dispose();
      spray.dispose();
      for (const m of meshes) m.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}

/** One signal head of a traffic light: where it hangs (m), its facing (yaw, rad) and its offset into the signal cycle (s). */
interface TrafficHead {
  x: number;
  y: number;
  z: number;
  yaw: number;
  offset: number;
}

/** The three heads of a traffic light (two under the arm, one on the pole), placed and phased; the lenses and their streaks share this. */
function trafficHeads(world: World, p: Prop, f: TrafficFrame): TrafficHead[] {
  const ya = yawOf(f.fax, f.faz);
  const yb = yawOf(f.fbx, f.fbz);
  const heads: [number, number, number, number][] = [
    [p.x + f.ax * f.len * 0.55, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * 0.55, ya],
    [p.x + f.ax * f.len * 0.92, p.y + TRAFFIC_ARM_Y - 0.66, p.z + f.az * f.len * 0.92, ya],
    [p.x + f.fbx * 0.32, p.y + 3.1, p.z + f.fbz * 0.32, yb],
  ];
  // Per intersection offset; the direction crossing the reference axis runs half a cycle later.
  const node = p.node ?? -1;
  const base = node >= 0 ? hash01(node * 7919 + world.seed) * CYCLE : 0;
  const ref = node >= 0 ? nodeAxis(world, node) : 0;
  return heads.map(([x, y, z, yaw], k) => {
    const fx = k < 2 ? f.fax : f.fbx;
    const fz = k < 2 ? f.faz : f.fbz;
    let d = Math.abs(Math.atan2(fx, fz) - ref) % Math.PI;
    if (d > Math.PI / 2) d = Math.PI - d;
    return { x, y, z, yaw, offset: base + (d > Math.PI / 4 ? CYCLE / 2 : 0) };
  });
}

/** A glowing prop part that streaks on the wet street (lightFx.ts): which prop it belongs to (so a smashed one goes dark), where and how. */
export interface PropEmitter {
  /** Prop id. */
  prop: number;
  cls: EmitterClass;
  /** World position (m) and colour. */
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  /** A signal head's offset into the signal cycle (s); absent for a steady light. */
  phase?: number;
}

/**
 * The streaks of the props: per traffic light its far arm head and its pole head (the middle arm head sits right
 * beside the far one), per bus shelter its cool light strip and its lit poster. Placed with the same helpers and
 * offsets as the props' own meshes, so a streak sits under what it reflects.
 */
export function propEmitters(world: World): PropEmitter[] {
  const out: PropEmitter[] = [];
  const strip = new THREE.Color(0xcfe6ff);
  for (const p of world.blocks.props ?? []) {
    if (p.kind === 'trafficLight') {
      const heads = trafficHeads(world, p, trafficFrame(world, p));
      for (const k of [1, 2]) out.push({ prop: p.id, cls: 'signal', x: heads[k].x, y: heads[k].y, z: heads[k].z, color: strip, phase: heads[k].offset });
    } else if (p.kind === 'busStop') {
      // Local +Z is (sin yaw, cos yaw) and local +X is (cos yaw, -sin yaw), as for every placed part.
      const sn = Math.sin(p.yaw);
      const cs = Math.cos(p.yaw);
      out.push({ prop: p.id, cls: 'shelter', x: p.x + sn * 0.82, y: p.y + 2.455, z: p.z + cs * 0.82, color: strip });
      out.push({ prop: p.id, cls: 'shelter', x: p.x + cs * 1.55, y: p.y + 1.25, z: p.z - sn * 1.55, color: AD_TINTS[(hash01(p.id * 13) * AD_TINTS.length) | 0] });
    }
  }
  return out;
}

/** Arm and head directions for a traffic light at a corner of its intersection. */
function trafficFrame(world: World, p: Prop): TrafficFrame {
  const g = world.graph;
  const fallback: TrafficFrame = { ax: Math.sin(p.yaw), az: Math.cos(p.yaw), len: 4, fax: Math.cos(p.yaw), faz: -Math.sin(p.yaw), fbx: -Math.cos(p.yaw), fbz: Math.sin(p.yaw) };
  if (p.node === undefined || p.node < 0 || !g.nodes[p.node]) return fallback;
  const n = g.nodes[p.node];
  const ul = Math.hypot(p.x - n.x, p.z - n.z) || 1;
  const ux = (p.x - n.x) / ul;
  const uz = (p.z - n.z) / ul;
  // The two roads bracketing this corner: nearest edge direction on either side of u.
  let bestA = Infinity;
  let bestB = -Infinity;
  let dA: { x: number; z: number } | null = null;
  let dB: { x: number; z: number } | null = null;
  let wA = 13;
  for (const eid of n.edges) {
    const e = g.edges[eid];
    const o = g.nodes[e.a === p.node ? e.b : e.a];
    const l = Math.hypot(o.x - n.x, o.z - n.z) || 1;
    const dx = (o.x - n.x) / l;
    const dz = (o.z - n.z) / l;
    const ang = Math.atan2(ux * dz - uz * dx, ux * dx + uz * dz);
    if (ang > 0 && ang < bestA) {
      bestA = ang;
      dA = { x: dx, z: dz };
      wA = e.width;
    }
    if (ang < 0 && ang > bestB) {
      bestB = ang;
      dB = { x: dx, z: dz };
    }
  }
  if (!dA || !dB) return fallback;
  // Arm: from the pole, perpendicular across road A toward its centerline.
  const tx = n.x - p.x;
  const tz = n.z - p.z;
  const along = tx * dA.x + tz * dA.z;
  let ax = tx - dA.x * along;
  let az = tz - dA.z * along;
  const reach = Math.hypot(ax, az) || 1;
  ax /= reach;
  az /= reach;
  const len = Math.max(3, Math.min(9, Math.min(reach, wA / 2 + 1) * 0.95));
  // Heads face traffic approaching the intersection along each road (+d, outward).
  return { ax, az, len, fax: dA.x, faz: dA.z, fbx: dB.x, fbz: dB.z };
}

/** Reference axis angle of a node (its first road) for grouping signal phases. */
function nodeAxis(world: World, node: number): number {
  const n = world.graph.nodes[node];
  const e = world.graph.edges[n.edges[0]];
  if (!e) return 0;
  const o = world.graph.nodes[e.a === node ? e.b : e.a];
  return Math.atan2(o.x - n.x, o.z - n.z);
}

function hash01(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
