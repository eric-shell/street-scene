/**
 * The garage: a tuner's workshop at night where cars are being built. The
 * player's car turns on a scuffed diamond-plate turntable in the middle of a
 * stained concrete floor, under a cluster of fluorescent battens; round it
 * four two-post lifts hold other cars mid-build (one high, one at working
 * height with its front wheels off, a lamp hung under it and the jack beside
 * it, one just off its wheels), among workbenches, rolling tool chests,
 * shelving, tire racks, drums, a compressor and an engine on the hoist. The
 * Street Scene logo is a neon sign on the back wall with a failing letter, one
 * of the battens is dying, and the light is mostly what the work throws: cool
 * tubes, a warm lamp under a car, the neon's spill on grimy block walls.
 *
 * The room is merged primitives (one mesh per material, garage/showroomProps.ts)
 * and canvas textures (garage/showroomTextures.ts); the signs are
 * garage/neonSign.ts. The car paint reflects a stand-in of the same lights (a
 * PMREM built once per visit) and the floor a low resolution mirror pass
 * (Medium and High). The lift cars are ordinary car views, posed once. Render
 * only: the garage scene (garageScene.ts) owns the camera, the spin and the
 * player's car; this owns the room.
 */
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { CarView } from '../render/car/carView';
import type { CarPose } from '../render/car/carView';
import { MANIFEST, partsFor } from '../render/car/carAssets';
import type { CarAssetLibrary } from '../render/car/carAssets';
import { defaultVisual } from '../sim/build';
import type { PaintFinish } from '../sim/build';
import type { PartSlot } from '../shared/parts';
import type { Quality } from '../ui/settings';
import { PALETTE } from '../ui/kit/palette';
import { concreteTextures, hazardTexture, noise, plateTexture, shadowTexture, wallTexture } from './showroomTextures';
import { GLOW, Kit, batten, compressor, createMaterials, drum, engineHoist, extinguisher, jackAndStands, lift, panels, roof, shelving, tire, tireRack, toolChest, workbench } from './showroomProps';
import type { LiftFit } from './showroomProps';
import { MAIN_SIGN, NEON, NeonSign, OPEN_SIGN } from './neonSign';

/**
 * Per quality tier: the floor's reflection pass (render scale of the screen,
 * 0 = off), the dust in the light, how many lifts have a car on them (each is
 * a full car view, about 20 draw calls and 20k triangles) and the work lights
 * (the dying batten's, the lamp under a car, the bench's).
 */
export const SHOWROOM_QUALITY: Record<Quality, { reflection: number; dust: boolean; liftCars: number; workLights: boolean }> = {
  low: { reflection: 0, dust: false, liftCars: 2, workLights: false },
  medium: { reflection: 0.35, dust: true, liftCars: 4, workLights: true },
  high: { reflection: 0.45, dust: true, liftCars: 4, workLights: true },
};

/** The room (m): half its width and depth, the roof, the turntable, the painted band on the walls, the battens' height. */
const ROOM = {
  half: 12,
  height: 6.6,
  /** Turntable radius and top (the car's ground). */
  table: 3,
  tableTop: 0.08,
  /** Hazard ring painted round the turntable: inner and outer radius. */
  ring: [3.2, 3.42],
  band: 1.3,
  battenY: 4.7,
} as const;

/**
 * The lifts, in the order their cars appear as the quality allows: where (m),
 * which way the car faces (rad), how high its ground is (m), and the build on
 * it (paint, finish, a seed for the parts it wears). The second has its front
 * wheels off with the work lamp under it.
 */
const LIFTS: { x: number; z: number; yaw: number; h: number; paint: string; finish: PaintFinish; trim: string; seed: number; wheelsOff?: boolean }[] = [
  { x: -5.4, z: -8.7, yaw: 0, h: 1.85, paint: '#5f6266', finish: 'matte', trim: '#111215', seed: 1 },
  { x: 1.4, z: -8.7, yaw: Math.PI, h: 0.95, paint: '#3b1f6e', finish: 'candy', trim: '#0d0d10', seed: 2, wheelsOff: true },
  { x: -8.7, z: -1.6, yaw: Math.PI / 2, h: 1.7, paint: '#e6e3dc', finish: 'pearl', trim: '#16171a', seed: 3 },
  { x: -8.7, z: 4.6, yaw: Math.PI / 2, h: 0.4, paint: '#0f1012', finish: 'matte', trim: '#c9a227', seed: 4 },
];

/** Battens: position (m), yaw, length and state. The cluster over the turntable, then the work areas. */
const BATTENS: { x: number; y: number; z: number; yaw: number; len: number; state: 'lit' | 'off' | 'flicker' }[] = [
  { x: -1.1, y: ROOM.battenY, z: 0, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  { x: 0, y: ROOM.battenY, z: 0, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  { x: 1.1, y: ROOM.battenY, z: 0, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  // Over the back lifts, hung high and forward so they stay under the sign from the default view.
  { x: -5.4, y: 5.75, z: -6.4, yaw: 0, len: 2.4, state: 'lit' },
  { x: 1.4, y: 5.75, z: -6.4, yaw: 0, len: 2.4, state: 'flicker' },
  { x: -8.7, y: 5.0, z: -1.6, yaw: 0, len: 2.4, state: 'lit' },
  { x: -8.7, y: 5.0, z: 4.6, yaw: 0, len: 2.4, state: 'off' },
  { x: 10.4, y: 4.6, z: -2.5, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  { x: 2.5, y: 5.0, z: 8, yaw: 0, len: 2.4, state: 'lit' },
  { x: -5, y: 5.0, z: 9, yaw: 0, len: 2.4, state: 'off' },
];

/** Where the neon signs hang: center (m) and facing yaw. */
const SIGNS = { main: { x: -2, y: 5.0, z: -ROOM.half + 0.02, yaw: 0 }, open: { x: ROOM.half - 0.02, y: 3.35, z: -2.5, yaw: -Math.PI / 2 } } as const;

/** The car's ground on the turntable and how far the lift cars' wheels hang when lifted (m). */
const DROOP = -0.06;

type Disposable = { dispose(): void };

export class Showroom {
  readonly scene = new THREE.Scene();
  /** Turns with the car on it (the garage scene spins it). */
  readonly turntable = new THREE.Group();
  /** The studio reflections for the car's paint. */
  readonly envMap: THREE.Texture;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly flickerMat: THREE.MeshBasicMaterial;
  private readonly flickerLight: THREE.PointLight | null = null;
  private readonly shadow: THREE.Mesh;
  private readonly reflector: Reflector | null = null;
  private readonly dust: THREE.Points | null = null;
  private readonly dustTime: { value: number } = { value: 0 };
  private readonly signs: NeonSign[] = [];
  private readonly liftCars: CarView[] = [];
  /** What the orbit camera must not pass through: the lifts and their cars, as room-space boxes. */
  private readonly obstacles: THREE.Box3[] = [];
  private readonly disposables: Disposable[] = [];
  private readonly offset = new THREE.Vector3();
  private disposed = false;
  private time = 0;

  constructor(renderer: THREE.WebGLRenderer, quality: Quality, assets: CarAssetLibrary) {
    const q = SHOWROOM_QUALITY[quality];
    const track = <T extends Disposable>(x: T): T => (this.disposables.push(x), x);
    const s = this.scene;
    s.background = new THREE.Color(0x070709);
    s.fog = new THREE.Fog(0x09090d, 14, 36);
    const H = ROOM.half;

    // ---------- walls, roof, battens ----------
    const m = createMaterials(track, track(wallTexture(ROOM.height, ROOM.band)));
    this.flickerMat = m.tubeFlicker;
    const k = new Kit(m);
    for (const [x, z, ry] of [
      [0, -H, 0],
      [-H, 0, Math.PI / 2],
      [H, 0, -Math.PI / 2],
      [0, H, Math.PI],
    ] as const) {
      const wall = new THREE.PlaneGeometry(2 * H, ROOM.height);
      scaleUv(wall, (2 * H) / 6.4, 1);
      k.place().add(m.wall, wall, x, ROOM.height / 2, z, ry);
    }
    roof(k, H, ROOM.height);
    for (const b of BATTENS) batten(k, b.x, b.y, b.z, b.yaw, b.len, b.state, ROOM.height - 0.1);
    // Roller doors: the way in on the front wall, a smaller one at the back.
    rollerDoor(k, 5.5, H - 0.03, Math.PI, 4.8, 4.2);
    rollerDoor(k, 8.6, -H + 0.03, 0, 3.6, 3.6);

    // ---------- the lifts and their cars ----------
    LIFTS.forEach((l, i) => {
      const carId = liftCarId(i);
      const car = MANIFEST.cars.find((c) => c.id === carId)!;
      const fit: LiftFit = { width: car.dimensions.width, length: car.dimensions.length, wheelbase: car.wheelbase };
      const loaded = i < q.liftCars;
      const h = loaded ? l.h : 0.3;
      const [ax, az] = lift(k, l.x, l.z, l.yaw, h, fit);
      this.obstacle(l.x, l.z, l.yaw, ax, az, 4.0);
      // Oil stains under every lift; a drain pan under the one being worked on.
      k.place().plane(m.stain, 2.2, 2.2, l.x + 0.3, 0.006, l.z - 0.4, i * 1.3, -Math.PI / 2);
      if (!loaded) return;
      if (l.wheelsOff) hubs(k, l.x, h + DROOP, l.z, l.yaw, car.wheels.FL, car.wheels.FR);
      void this.loadLiftCar(assets, carId, i, h);
    });
    for (const [x, z, hx, hz, h] of workArea(k, m)) this.obstacle(x, z, 0, hx, hz, h);
    k.build(s, track);

    // ---------- signs ----------
    for (const [spec, at] of [
      [MAIN_SIGN, SIGNS.main],
      [OPEN_SIGN, SIGNS.open],
    ] as const) {
      const sign = new NeonSign(spec);
      sign.group.position.set(at.x, at.y, at.z);
      sign.group.rotation.y = at.yaw;
      s.add(sign.group);
      this.signs.push(sign);
    }

    // ---------- floor ----------
    const concrete = concreteTextures();
    for (const t of [concrete.color, concrete.rough]) track(t).repeat.set((2 * H) / 8, (2 * H) / 8);
    const reflective = q.reflection > 0;
    const floor = new THREE.Mesh(
      track(new THREE.PlaneGeometry(2 * H, 2 * H).rotateX(-Math.PI / 2)),
      track(
        new THREE.MeshStandardMaterial({
          map: concrete.color,
          roughnessMap: concrete.rough,
          roughness: 1,
          metalness: 0,
          // Over the reflection pass, the sealed concrete lets a little of the mirror image through.
          transparent: reflective,
          opacity: reflective ? 0.86 : 1,
          polygonOffset: reflective,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        }),
      ),
    );
    s.add(floor);
    if (reflective) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(q.reflection);
      const r = new Reflector(new THREE.PlaneGeometry(2 * H, 2 * H), { textureWidth: Math.round(size.x), textureHeight: Math.round(size.y), clipBias: 0.003, multisample: 0, shader: REFLECTION_SHADER });
      r.rotation.x = -Math.PI / 2;
      r.position.y = -0.002;
      (r.material as THREE.ShaderMaterial).uniforms.texel.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
      // The lift cars stay out of the mirror: up on the arms, their image would land far out where the
      // reflection has faded, and each is some 35 draw calls the pass would repeat.
      const mirror = r.onBeforeRender.bind(r);
      r.onBeforeRender = (...args) => {
        for (const v of this.liftCars) v.root.visible = false;
        mirror(...args);
        for (const v of this.liftCars) v.root.visible = true;
      };
      s.add(r);
      this.reflector = r;
    }
    const hazard = new THREE.Mesh(track(ringGeometry(ROOM.ring[0], ROOM.ring[1], 96)), track(new THREE.MeshStandardMaterial({ map: track(hazardTexture()), roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })));
    hazard.position.y = 0.004;
    hazard.renderOrder = 1;
    s.add(hazard);

    // ---------- turntable ----------
    const top = ROOM.tableTop;
    const plate = track(new THREE.MeshStandardMaterial({ map: track(plateTexture()), color: 0x8a8a90, roughness: 0.45, metalness: 0.75 }));
    const side = track(new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.6, metalness: 0.5 }));
    const table = new THREE.Mesh(track(new THREE.CylinderGeometry(ROOM.table, ROOM.table + 0.04, top, 96)), [side, plate, side]);
    table.position.y = top / 2;
    this.turntable.add(table);
    this.ringMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.orange).multiplyScalar(2.2) }));
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(ROOM.table + 0.03, 0.016, 8, 128).rotateX(Math.PI / 2)), this.ringMat);
    ring.position.y = top;
    this.turntable.add(ring);
    // The car's contact shadow turns with it.
    this.shadow = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), track(new THREE.MeshBasicMaterial({ map: track(shadowTexture()), color: 0x000000, transparent: true, depthWrite: false, opacity: 0.85 })));
    this.shadow.position.y = top + 0.003;
    this.shadow.renderOrder = 1;
    this.turntable.add(this.shadow);
    s.add(this.turntable);

    // ---------- lights ----------
    // Low and moody: a dim sky fill, the battens over the car as one soft spot, rim lights in the
    // garage's two accents (the neon's orange and cyan), a fill from the front, a cool wash over the
    // left bays, the signs' own light.
    s.add(new THREE.HemisphereLight(0x9aa2c0, 0x1a1714, 0.55));
    const key = new THREE.SpotLight(0xe8eeff, 24, 14, 1.0, 1, 1.2);
    key.position.set(0, ROOM.battenY - 0.05, 0);
    s.add(key, key.target);
    const spot = (color: THREE.ColorRepresentation, intensity: number, x: number, y: number, z: number) => {
      const l = new THREE.SpotLight(color, intensity, 26, 0.32, 0.8, 1.4);
      l.position.set(x, y, z);
      s.add(l, l.target);
    };
    spot(PALETTE.orange, 18, -6.5, 4.4, -6.5);
    spot(NEON.cyan, 10, 6.5, 4.4, -6.5);
    const fill = new THREE.PointLight(0xc8d2ff, 7, 16, 1.2);
    fill.position.set(1.5, 3.2, 8);
    const bays = new THREE.PointLight(0xdfe8ff, 10, 12, 1.3);
    bays.position.set(-8.2, 4.5, 1.5);
    s.add(fill, bays);
    if (q.workLights) {
      // The dying batten over the second lift, the lamp hung under its car, the bench's strip.
      this.flickerLight = new THREE.PointLight(0xe8eeff, 6, 8, 1.4);
      this.flickerLight.position.set(LIFTS[1].x, 5.4, -6.6);
      const lamp = new THREE.PointLight(0xffb36a, 4, 4.5, 1.6);
      lamp.position.set(LIFTS[1].x - 0.4, 0.75, LIFTS[1].z + 0.9);
      const bench = new THREE.PointLight(0xfff0dc, 6, 7, 1.5);
      bench.position.set(10.4, 4.1, -2.5);
      s.add(this.flickerLight, lamp, bench);
    }

    // ---------- dust in the light ----------
    if (q.dust) {
      this.dust = dustMotes(this.dustTime);
      track(this.dust.geometry);
      track(this.dust.material as THREE.Material);
      s.add(this.dust);
    }

    // ---------- the studio reflections for the paint ----------
    this.envMap = track(studioEnvironment(renderer)).texture;
    // The room's own surfaces only take a little of it; the cars' paint carries its own, stronger.
    s.environment = this.envMap;
    s.environmentIntensity = 0.6;
  }

  /** A lift's room-space box (center, yaw, half extents across and along, height) for the camera to stay out of. */
  private obstacle(x: number, z: number, yaw: number, across: number, along: number, height: number): void {
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    const hx = across * c + along * s;
    const hz = across * s + along * c;
    this.obstacles.push(new THREE.Box3(new THREE.Vector3(x - hx, 0, z - hz), new THREE.Vector3(x + hx, height, z + hz)));
  }

  /** Load a lift's car, dress it in its build and pose it once on the arms (wheels hanging). */
  private async loadLiftCar(assets: CarAssetLibrary, carId: string, index: number, h: number): Promise<void> {
    const l = LIFTS[index];
    const view = new CarView(carId, assets, { envMap: this.envMap });
    view.setHeadlightsEnabled(false);
    await view.load(liftVisual(carId, l.paint, l.finish, l.trim, l.seed));
    if (this.disposed) {
      view.dispose();
      return;
    }
    if (l.wheelsOff) {
      view.setWheelVisible(0, false);
      view.setWheelVisible(1, false);
    }
    const pose: CarPose = { x: l.x, y: h, z: l.z, yaw: l.yaw, pitch: 0, roll: 0, steer: 0, comp: [DROOP, DROOP, DROOP, DROOP], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 };
    view.update(pose, 0);
    // Parked with the ignition off: dark lenses, no glow (posed once, nothing sets them again).
    const lamps = view.materials as Record<string, THREE.Material>;
    for (const [name, color] of [
      ['HeadLight', 0x3a3d42],
      ['TailLight', 0x1c0407],
      ['Light', 0x241a08],
    ] as const) {
      const lens = lamps[name] as THREE.MeshStandardMaterial;
      lens.color.setHex(color);
      lens.emissiveIntensity = 0;
    }
    this.scene.add(view.root);
    this.liftCars.push(view);
  }

  /**
   * Keep an orbit camera inside the room and out of the lifts: a camera rising
   * past the lights tips down to their height at the same distance (so
   * dragging up never ends in a close-up through the roof), and one past a
   * wall or behind a lift comes in along its line to the target.
   */
  contain(camera: THREE.Vector3, target: THREE.Vector3): void {
    const o = this.offset.subVectors(camera, target);
    const r = o.length();
    const hmax = ROOM.battenY - 0.4 - target.y;
    if (o.y > hmax && r > hmax) {
      const horiz = Math.hypot(o.x, o.z) || 1e-3;
      const k = Math.sqrt(r * r - hmax * hmax) / horiz;
      o.set(o.x * k, hmax, o.z * k);
    }
    const lim = ROOM.half - 0.6;
    const cx = o.x + target.x;
    const cz = o.z + target.z;
    let t = 1;
    if (Math.abs(cx) > lim) t = Math.min(t, (Math.sign(cx) * lim - target.x) / (cx - target.x));
    if (Math.abs(cz) > lim) t = Math.min(t, (Math.sign(cz) * lim - target.z) / (cz - target.z));
    const len = o.length() || 1;
    for (const b of this.obstacles) {
      const hit = rayBox(target, o, b);
      if (hit !== null) t = Math.min(t, hit - 0.25 / len);
    }
    camera.copy(target).addScaledVector(o, Math.max(0.05, t));
  }

  /** Put a car on the turntable; its contact shadow sizes to it. */
  mount(view: CarView): void {
    this.turntable.add(view.root);
    const d = view.car.dimensions;
    this.shadow.scale.set(d.width * 1.32, 1, d.length * 1.16);
  }

  /** Keep the reflection pass at its share of the screen after a resize. */
  resize(renderer: THREE.WebGLRenderer, quality: Quality): void {
    if (!this.reflector) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2()).multiplyScalar(SHOWROOM_QUALITY[quality].reflection);
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));
    this.reflector.getRenderTarget().setSize(w, h);
    (this.reflector.material as THREE.ShaderMaterial).uniforms.texel.value.set(1 / w, 1 / h);
  }

  /** Animate the turntable's LED rim, the dying batten, the failing neon letter and the dust (a few uniforms, no allocation). */
  update(dt: number): void {
    this.time += dt;
    const t = this.time;
    this.ringMat.color.copy(RING).multiplyScalar(1.45 + 0.3 * Math.sin(t * 1.6));
    const f = battenFlicker(t);
    this.flickerMat.color.copy(GLOW.tube).multiplyScalar(f);
    if (this.flickerLight) this.flickerLight.intensity = 6 * f;
    for (const sign of this.signs) sign.update(t);
    this.dustTime.value = t;
  }

  dispose(): void {
    this.disposed = true;
    this.reflector?.dispose();
    for (const v of this.liftCars) v.dispose();
    for (const sign of this.signs) sign.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** The LED rim's base color, and the axes the camera's box test walks (module constants: nothing allocated per frame). */
const RING = new THREE.Color(PALETTE.orange);
const AXES = ['x', 'y', 'z'] as const;

/** Which car sits on lift i: the garage's cars in turn, starting a little way into the list so the first lift differs from the default pick. */
function liftCarId(i: number): string {
  const ids = MANIFEST.cars.filter((c) => c.selectable).map((c) => c.id);
  return ids[(i + 2) % ids.length];
}

/** A lift car's build: its paint and trim, and a kit picked from the catalog by seed (some slots left stock), sat a little low. */
function liftVisual(carId: string, paint: string, finish: PaintFinish, trim: string, seed: number): ReturnType<typeof defaultVisual> {
  const v = defaultVisual();
  v.paint = { color: paint, finish };
  v.trimColor = trim;
  v.tint.darkness = 0.75;
  const slots: PartSlot[] = ['frontBumper', 'rearBumper', 'sideSkirts', 'spoiler', 'hood', 'wheels'];
  slots.forEach((slot, j) => {
    const list = partsFor(carId, slot);
    const pick = Math.floor(noise(seed * 17 + j * 5) * (list.length + 1));
    v.parts[slot] = pick < list.length ? list[pick].id : null;
  });
  v.wheels.color = v.wheels.rearColor = seed % 2 ? '#1a1b1f' : '#c9ced8';
  v.stance.rideHeight = -0.03;
  return v;
}

/** Where a car's front wheels came off: brake discs, hubs and calipers at the wheel centers (car space, posed like the car). */
function hubs(k: Kit, x: number, y: number, z: number, yaw: number, ...wheels: number[][]): void {
  const m = k.m;
  k.place(x, y, z, yaw);
  for (const [px, py, pz] of wheels) {
    k.cyl(m.cast, 0.16, 0.028, px * 0.93, py, pz, 'x', 20);
    k.cyl(m.steel, 0.07, 0.09, px * 0.97, py, pz, 'x', 10);
    k.box(m.red, 0.08, 0.17, 0.11, px * 0.89, py + 0.07, pz - 0.1);
  }
}

/** A roller door on a wall: the curtain, its guides, the drum housing over it, and the street's light under it. */
function rollerDoor(k: Kit, x: number, z: number, yaw: number, w: number, h: number): void {
  const m = k.m;
  k.place(x, 0, z, yaw);
  k.plane(m.door, w, h, 0, h / 2 + 0.025, 0);
  k.box(m.leakEdge, w - 0.1, 0.02, 0.01, 0, 0.012, -0.005);
  // Centered on the threshold: brightest at the gap, fading a meter into the room (the half outside is behind the wall).
  k.plane(m.leak, w * 1.2, 2.6, 0, 0.007, 0.02, 0, -Math.PI / 2);
  k.box(m.steel, w + 0.4, 0.34, 0.34, 0, h + 0.17, 0.15);
  for (const s of [-1, 1]) k.box(m.steel, 0.12, h, 0.12, s * (w / 2 + 0.08), h / 2, 0.06);
}

/** A worn yellow floor line from (x0, z0) to (x1, z1), 10 cm wide. */
function floorLine(k: Kit, x0: number, z0: number, x1: number, z1: number): void {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const g = new THREE.PlaneGeometry(len, 0.1);
  scaleUv(g, len / 4, 1);
  k.place().add(k.m.line, g, (x0 + x1) / 2, 0.005, (z0 + z1) / 2, -Math.atan2(z1 - z0, x1 - x0), -Math.PI / 2);
}

/**
 * Everything round the lifts: the walls' benches, chests, shelving, racks,
 * drums and the compressor, the hoist out on the floor, the work in progress
 * by the lifts, bay lines, stains, and the cords and air line across the floor.
 * Returns boxes the camera keeps out of: [x, z, half x, half z, height].
 */
function workArea(k: Kit, m: Kit['m']): [number, number, number, number, number][] {
  const H = ROOM.half;
  const Y = Math.PI / 2;
  // Back wall: chests and posters right of the lifts, drums, shelving in the corner.
  toolChest(k, 4.9, -H + 0.3, 0, 1.5, m.red, m.drawersRed);
  toolChest(k, 6.6, -H + 0.3, 0, 1.1, m.black, m.drawersBlack);
  k.place().plane(m.poster0, 1.0, 1.4, 4.9, 2.7, -H + 0.02);
  k.place().plane(m.poster1, 1.0, 1.4, 6.6, 2.7, -H + 0.02);
  drum(k, 3.7, -11.35, m.blue);
  drum(k, 3.75, -10.7, m.red);
  shelving(k, -9.8, -H + 0.32, 0, 2.4, 1);
  // Left wall: tire stacks in the back corner, a chest under a pegboard between the lifts.
  for (const [x, z, n] of [
    [-11.3, -5.3, 5],
    [-10.6, -5.0, 3],
    [-11.3, -9.2, 4],
  ] as const)
    for (let i = 0; i < n; i++) tire(k, x, 0.1 + i * 0.2, z);
  toolChest(k, -H + 0.3, 1.5, Y, 1.5, m.red, m.drawersRed);
  k.place().plane(m.pegboard, 2.2, 1.1, -H + 0.02, 2.45, 1.5, Y);
  // Front wall: shelving, drums in the corner, the compressor and its reel, the extinguisher by the door.
  shelving(k, -3.6, H - 0.32, Math.PI, 2.4, 2);
  shelving(k, -6.8, H - 0.32, Math.PI, 2.4, 3);
  drum(k, -10.9, 10.6, m.red);
  drum(k, -10.2, 11.25, m.blue);
  drum(k, -11.2, 11.3, m.red);
  compressor(k, 9.3, H - 0.4, Math.PI);
  for (let i = 0; i < 4; i++) tire(k, 10.7, 0.1 + i * 0.2, 11.2);
  for (let i = 0; i < 3; i++) tire(k, 1.9, 0.1 + i * 0.2, 11.3);
  extinguisher(k, 2.6, H, Math.PI);
  // Right wall: the bench under its pegboard and the small sign, a tool cart pulled out, the tire rack, panels.
  workbench(k, H - 0.45, -2.5, -Y, 3.2);
  k.place().plane(m.pegboard, 3.0, 1.5, H - 0.02, 1.95, -2.5, -Y);
  k.place().plane(m.poster2, 1.0, 1.4, H - 0.02, 2.6, 1.9, -Y);
  toolChest(k, 11.1, 0.7, -Y + 0.35, 1.0, m.blue, m.drawersBlue, false);
  tireRack(k, H - 0.25, 4.4, -Y, 8);
  panels(k, H - 0.45, 8.4, -Y);
  extinguisher(k, H, -6.2, -Y);
  k.place().cyl(m.red, 0.24, 0.7, 11.4, 0.35, -5.0, 'y', 14);
  k.place().cyl(m.black, 0.18, 0.06, 9.9, 0.66, -1.5, 'y', 14);
  for (const a of [0, 2.1, 4.2]) k.place().bar(m.steel, [9.9, 0.64, -1.5], [9.9 + Math.cos(a) * 0.2, 0, -1.5 + Math.sin(a) * 0.2], 0.025);
  // The hoist out on the floor with an engine on the chain.
  engineHoist(k, 7.6, -4.6, Math.PI * 0.8);
  // The second lift's work: its wheels stacked on the floor, the jack, stands and creeper, a drain pan, the lamp.
  const l2 = LIFTS[1];
  tire(k, l2.x + 2.4, 0.1, l2.z + 0.6, true);
  tire(k, l2.x + 2.42, 0.3, l2.z + 0.6, true);
  jackAndStands(k, l2.x + 1.6, l2.z + 2.8, -0.3);
  k.place().cyl(m.black, 0.36, 0.06, l2.x, 0.03, l2.z - 1.6, 'y', 18);
  const lamp: [number, number, number] = [l2.x - 0.4, 0.75, l2.z + 0.9];
  k.place().cyl(m.lamp, 0.035, 0.18, lamp[0], lamp[1], lamp[2], 'y', 10);
  for (const a of [0, 1.57, 3.14, 4.71]) k.place().box(m.galv, 0.008, 0.2, 0.008, lamp[0] + Math.cos(a) * 0.05, lamp[1], lamp[2] + Math.sin(a) * 0.05);
  k.place().cyl(m.rubber, 0.03, 0.14, lamp[0], lamp[1] - 0.16, lamp[2], 'y', 10);
  k.place().bar(m.galv, [lamp[0], lamp[1] + 0.1, lamp[2]], [lamp[0], l2.h + 0.12, lamp[2]], 0.006);
  // The lamp's cord from the bench's socket across the floor, and the air line from the compressor to an impact gun.
  k.place().hose(
    m.orange,
    [
      [H - 0.05, 0.45, -1.0],
      [H - 0.35, 0.015, -1.4],
      [9.0, 0.015, -3.6],
      [6.0, 0.015, -5.4],
      [3.6, 0.015, -6.3],
      [lamp[0] + 0.5, 0.015, lamp[2] + 0.2],
      [lamp[0] + 0.1, 0.25, lamp[2] + 0.05],
      [lamp[0], lamp[1] - 0.22, lamp[2]],
    ],
    0.012,
    80,
  );
  k.place().hose(
    m.yellow,
    [
      [9.3, 0.62, H - 0.45],
      [8.9, 0.015, 10.6],
      [5.0, 0.015, 9.2],
      [1.0, 0.015, 9.7],
      [-3.0, 0.015, 8.7],
      [-5.5, 0.015, 7.3],
      [-6.3, 0.03, 6.0],
    ],
    0.014,
    80,
  );
  k.place().box(m.black, 0.12, 0.1, 0.28, -6.3, 0.06, 5.75, 0.5);
  // The first lift: a new exhaust laid out under it.
  const l1 = LIFTS[0];
  k.place().bar(m.chrome, [l1.x - 0.3, 0.06, l1.z - 1.9], [l1.x + 0.1, 0.06, l1.z + 1.2], 0.08);
  k.place().cyl(m.chrome, 0.14, 0.6, l1.x + 0.15, 0.14, l1.z + 1.6, 'z', 14);
  // The third: an oil drainer under the engine. The fourth: coilovers and boxed parts waiting to go in.
  const l3 = LIFTS[2];
  k.place().cyl(m.yellow, 0.22, 0.4, l3.x + 1.4, 0.22, l3.z, 'y', 14);
  k.place().cyl(m.galv, 0.025, 1.0, l3.x + 1.4, 0.9, l3.z, 'y', 8);
  k.place().cyl(m.yellow, 0.3, 0.14, l3.x + 1.4, 1.42, l3.z, 'y', 16, 0.06);
  const l4 = LIFTS[3];
  for (const [dx, dz] of [
    [2.5, -1.4],
    [2.75, -1.2],
  ] as const) {
    k.place().cyl(m.galv, 0.03, 0.55, l4.x + dx, 0.3, l4.z + dz, 'y', 8);
    for (let i = 0; i < 6; i++) k.place().add(m.yellow, new THREE.TorusGeometry(0.06, 0.012, 6, 14), l4.x + dx, 0.1 + i * 0.065, l4.z + dz, 0, Math.PI / 2);
  }
  k.place().box(m.cardboard, 0.6, 0.4, 0.45, l4.x + 2.6, 0.2, l4.z + 1.9, 0.2);
  k.place().box(m.cardboard, 0.45, 0.3, 0.4, l4.x + 2.6, 0.55, l4.z + 1.9, 0.5);
  // Bay lines round the lifts.
  floorLine(k, -8.1, -H, -8.1, -5.4);
  floorLine(k, -1.95, -H, -1.95, -5.4);
  floorLine(k, 4.2, -H, 4.2, -5.4);
  floorLine(k, -8.1, -5.4, 4.2, -5.4);
  floorLine(k, -H, -4.2, -5.9, -4.2);
  floorLine(k, -H, 1.5, -5.9, 1.5);
  floorLine(k, -H, 7.4, -5.9, 7.4);
  floorLine(k, -5.9, -4.2, -5.9, 7.4);
  // Stains where the work happens.
  for (const [x, z, r] of [
    [8.3, -5.5, 1.6],
    [-10.6, 10.9, 1.8],
    [9.3, 10.9, 1.2],
    [10.6, -2.4, 1.3],
    [-3.6, 3.8, 0.9],
    [4.8, 5.4, 1.1],
    [l2.x + 1.0, l2.z + 2.4, 1.4],
  ] as const)
    k.place().plane(m.stain, r, r, x, 0.006, z, x * 0.7, -Math.PI / 2);
  return [[7.9, -5.0, 1.0, 1.0, 2.2]];
}

/** The dying batten's level (0..1) at time t (s): a few seconds lit, a moment out, then a stutter as the starter tries again. */
function battenFlicker(t: number): number {
  const c = t % 6.3;
  if (c > 4.9) return noise(Math.floor(t * 23) + 3) > 0.5 ? 1 : 0.05;
  if (c > 4.6) return 0.05;
  return 1;
}

/** Where the segment from o along d (t 0..1) enters box b, or null when it misses (or starts inside). */
function rayBox(o: THREE.Vector3, d: THREE.Vector3, b: THREE.Box3): number | null {
  let t0 = 0;
  let t1 = 1;
  for (const a of AXES) {
    const inv = 1 / d[a];
    let ta = (b.min[a] - o[a]) * inv;
    let tb = (b.max[a] - o[a]) * inv;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }
  return t0 > 0 ? t0 : null;
}

/** A flat ring with polar UVs (u round the ring, v across it), facing up. */
function ringGeometry(r0: number, r1: number, segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.push(c * r0, 0, s * r0, c * r1, 0, s * r1);
    uv.push((i / segments) * 48, 0, (i / segments) * 48, 1);
    // Wound counter-clockwise seen from above, so the ring faces up.
    if (i < segments) {
      const k = i * 2;
      idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Scale a geometry's UVs (texture repeats across a big plane without a texture per wall). */
function scaleUv(g: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

/**
 * The environment the paint reflects: a dark stand-in room with the lit
 * battens as hot strips, the neon's orange and pink and the cyan of the small
 * sign on the walls, the rim lights' patches, the doors and a dim panel in
 * front, rendered into a PMREM from the car's height.
 */
function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const env = new THREE.Scene();
  const disposables: Disposable[] = [];
  const track = <T extends Disposable>(x: T): T => (disposables.push(x), x);
  const basic = (color: THREE.ColorRepresentation, k = 1, side: THREE.Side = THREE.FrontSide) => track(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side }));
  const H = ROOM.half;
  const room = new THREE.Mesh(track(new THREE.BoxGeometry(2 * H, ROOM.height, 2 * H)), basic(0x0c0c0f, 1, THREE.BackSide));
  room.position.y = ROOM.height / 2;
  env.add(room);
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(2 * H, 2 * H).rotateX(-Math.PI / 2)), basic(0x121214));
  floor.position.y = 0.01;
  env.add(floor);
  const panel = (mat: THREE.Material, w: number, h: number, x: number, y: number, z: number, ry: number, rx = 0) => {
    const p = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), mat);
    p.position.set(x, y, z);
    p.rotation.set(rx, ry, 0, 'YXZ');
    env.add(p);
  };
  const tube = basic(0xeef3ff, 2.4, THREE.DoubleSide);
  for (const b of BATTENS) if (b.state !== 'off') panel(tube, b.len, 0.14, b.x, b.y, b.z, b.yaw, Math.PI / 2);
  const sz = -H + 0.05;
  panel(basic(NEON.orange, 1.1), 2.6, 0.9, SIGNS.main.x - 1.4, SIGNS.main.y + 0.2, sz, 0);
  panel(basic(NEON.pink, 1.1), 2.3, 0.9, SIGNS.main.x + 1.5, SIGNS.main.y + 0.2, sz, 0);
  panel(basic(NEON.cyan, 0.8), 4.4, 0.08, SIGNS.main.x, SIGNS.main.y - 0.4, sz, 0);
  panel(basic(NEON.cyan, 0.9), 1.6, 0.6, H - 0.05, SIGNS.open.y, SIGNS.open.z, -Math.PI / 2);
  panel(basic(PALETTE.orange, 0.5), 2.4, 1.6, -H + 0.05, 4.2, -7, Math.PI / 2);
  panel(basic(NEON.cyan, 0.35), 2.4, 1.6, H - 0.05, 4.2, -7, -Math.PI / 2);
  panel(basic(0x2a2d33), 4.8, 4.2, 5.5, 2.1, H - 0.05, Math.PI);
  panel(basic(0x24272c), 3.6, 3.6, 8.6, 1.8, sz, 0);
  // A dim panel in front, so the nose and the windscreen have something to reflect.
  panel(basic(0xd8dcff, 0.18), 8, 2.4, 0, 2.6, H - 0.05, Math.PI);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035, 0.1, 40, { position: new THREE.Vector3(0, 0.8, 0) });
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return rt;
}

/** Dust drifting in the light round the car: points moved in the shader, so nothing per frame on the CPU. */
function dustMotes(time: { value: number }): THREE.Points {
  const n = 320;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  let h = 7;
  const rnd = () => ((h = (h * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rnd() - 0.5) * 13;
    pos[i * 3 + 1] = 0.3 + rnd() * 4.2;
    pos[i * 3 + 2] = (rnd() - 0.5) * 13;
    seed[i] = rnd();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { time, scale: { value: 380 } },
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float time;
      uniform float scale;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float t = time * (0.05 + seed * 0.06);
        p.x += sin(t * 2.0 + seed * 40.0) * 0.6;
        p.z += cos(t * 1.7 + seed * 23.0) * 0.6;
        p.y += mod(t * 0.6 + seed * 4.0, 4.4) - 2.2 + sin(t * 3.0) * 0.1;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = scale * (0.012 + seed * 0.014) / -mv.z;
        // Brightest under the lights, gone near the floor and the ceiling.
        vAlpha = smoothstep(0.2, 1.2, p.y) * (1.0 - smoothstep(3.6, 4.6, p.y)) * (0.25 + 0.5 * seed);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d)) * vAlpha;
        gl_FragColor = vec4(vec3(1.0, 0.94, 0.86) * a, 1.0);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

/**
 * The floor's mirror image as the Reflector draws it: a few taps of blur for
 * sealed concrete rather than glass, strongest round the turntable and fading
 * toward the walls. The translucent floor over it decides how much shows.
 */
const REFLECTION_SHADER = {
  name: 'ShowroomReflection',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    texel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec2 uv = vUv.xy / vUv.w;
      vec2 o = texel * 1.6;
      vec3 c = texture2D(tDiffuse, uv).rgb * 0.36;
      c += texture2D(tDiffuse, uv + vec2(o.x, o.y)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(-o.x, o.y)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(o.x, -o.y)).rgb * 0.16;
      c += texture2D(tDiffuse, uv + vec2(-o.x, -o.y)).rgb * 0.16;
      float fade = 1.0 - smoothstep(4.0, 12.0, length(vWorld.xz));
      gl_FragColor = vec4(c * mix(0.3, 1.0, fade), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};
