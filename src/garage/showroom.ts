/**
 * The garage: a tuner's workshop at night where cars are being built. The
 * player's car turns on a scuffed diamond-plate turntable in the middle of a
 * stained concrete floor, under a cluster of fluorescent battens; round it
 * four two-post lifts hold other cars mid-build (one high, one at working
 * height with its front wheels off, a lamp hung under it and the jack beside
 * it, one just off its wheels), among workbenches, roll cabs with their
 * hutches, top chests and side lockers, tool lockers, tool boards and wall
 * cabinets, utility carts, shelving, tire racks, drums, a compressor, a tire
 * changer and balancer, a welder, a parts washer, grinder, drill press, shop
 * press and sandblast cabinet, the A/C and alignment machines, jacks and
 * stands under the cars, reels hung from the trusses, the jobs board and a
 * coffee corner under a beer sign, and an engine on the hoist. The
 * Street Scene logo is a neon sign on the back wall with a failing letter, one
 * of the battens is dying, and the light is mostly what the work throws: cool
 * tubes, a warm lamp under a car, the neon's spill on grimy block walls.
 *
 * The shop keeps its own time: the welder in the back corner arcs and throws
 * sparks and the compressor runs, on one pure schedule of the clock
 * (garage/shopSchedule.ts) that the sound bed reads too, so what is heard
 * matches what is shown. The customer's car on the dyno really pulls every two
 * to three minutes: the schedule's operator pedal drives a rev model and dyno
 * session (garage/customerDyno.ts), and its driven wheels and drums spin, the
 * wall screen draws the pull, the fan spools and the sound bed follows the
 * same revs.
 *
 * The room is merged primitives (one mesh per material, garage/showroomProps.ts)
 * and canvas textures (garage/showroomTextures.ts); the signs are
 * garage/neonSign.ts. The car paint reflects a stand-in of the same lights (a
 * PMREM built once per visit) and the floor a low resolution mirror pass
 * (Medium and High). The lift cars are ordinary car views, posed once. Render
 * only: the garage scene (garageScene.ts) owns the camera, the spin and the
 * player's car; this owns the room. The dyno presentation borrows the room's
 * dyno cell: `mountDyno` takes the player's car onto the rollers (the customer's
 * car, deck and straps hide; a deck cut for this car's driven axles replaces
 * them, with a roller set under each: one for a front or rear drive, two for
 * all wheel drive), `dynoStand` gives its pose, `spinDrums` turns the rollers,
 * `setFan` and `setRun` spool the fan and put the live pull on the wall screen
 * (without them the screen and the fan follow the customer's pull).
 */
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CarView, WHEEL_KEYS } from '../render/car/carView';
import type { CarPose } from '../render/car/carView';
import { MANIFEST, partsFor } from '../render/car/carAssets';
import type { CarAssetLibrary } from '../render/car/carAssets';
import { AXLES, defaultVisual } from '../shared/carBuild';
import type { PaintFinish, VisualBuild } from '../shared/carBuild';
import { PART_SLOTS } from '../shared/parts';
import type { Quality } from '../ui/settings';
import { PALETTE } from '../ui/kit/palette';
import { concreteTextures, dynoScreen, glowTexture, hazardTexture, noise, plateTextures, shadowTexture, wallTexture } from './showroomTextures';
import {
  GLOW,
  Kit,
  acMachine,
  banner,
  beerCooler,
  DYNO_DRUM,
  dyno,
  dynoDrum,
  dynoHalf,
  dynoStraps,
  dynoVents,
  bayNumber,
  calendar,
  cleanup,
  cones,
  drumFan,
  exitSign,
  floorDrain,
  lightPool,
  plateRow,
  spaceHeater,
  wallClock,
  wallTv,
  alignmentConsole,
  batten,
  batteryCharger,
  benchGrinder,
  brakeBleeder,
  carryBox,
  ceilingReel,
  clipboard,
  coffeeCorner,
  compressor,
  createMaterials,
  creeperSeat,
  drillPress,
  drum,
  engineHoist,
  extinguisher,
  flagshipCab,
  hydraulicPress,
  jackAndStands,
  laptopCart,
  lift,
  locker,
  panels,
  partsWasher,
  ragBin,
  rollCab,
  rollingStool,
  roof,
  sandblaster,
  shelving,
  smokeMachine,
  tire,
  tireChanger,
  tireRack,
  toolBoard,
  toolChest,
  transmissionJack,
  trashCan,
  underhoistStand,
  utilityCart,
  welder,
  wheelBalancer,
  wheelBoxes,
  whiteboard,
  workbench,
} from './showroomProps';
import type { DynoDrive, DynoFit, LiftFit, StrapFit } from './showroomProps';
import { MAIN_SIGN, NEON, NeonSign, OPEN_SIGN } from './neonSign';
import { Crew, liftHeight } from './showroomCrew';
import { createShopState, shopSchedule } from './shopSchedule';
import { CustomerDyno } from './customerDyno';
import type { ShopState } from './shopSchedule';
import type { CrewLift } from './showroomCrew';
import { Disposer } from '../render/disposer';
import { damp } from '../shared/anim';
import type { Mats } from './props/materials';
import type { DynoRun } from './textures/effects';
import type { ManifestCar } from '../render/car/carAssets';

/**
 * Per quality tier: the floor's reflection pass (render scale of the screen,
 * 0 = off), the dust in the light, how many lifts have a car on them and
 * whether the dyno does (each is a full car view, about 20 draw calls and 20k
 * triangles), the crew (garage/showroomCrew.ts: about fifteen instanced draw
 * calls, the fourth lift going up and down with its operator) and the work lights
 * (the second lift's batten, the lamp under a car, the bench's), and the
 * floor's and turntable's texture resolution (the concrete at 128 px/m times
 * `texRes`, the diamond plate at 1024 px across times `texRes`).
 */
export const SHOWROOM_QUALITY: Record<Quality, { reflection: number; dust: boolean; liftCars: number; dynoCar: boolean; crew: boolean; workLights: boolean; texRes: 1 | 2 }> = {
  low: { reflection: 0, dust: false, liftCars: 2, dynoCar: false, crew: false, workLights: false, texRes: 1 },
  medium: { reflection: 0.35, dust: true, liftCars: 4, dynoCar: true, crew: true, workLights: true, texRes: 2 },
  high: { reflection: 0.45, dust: true, liftCars: 4, dynoCar: true, crew: true, workLights: true, texRes: 2 },
};

/** The room (m): half its width and depth, the roof, the turntable, the painted band on the walls, the battens' height. */
export const ROOM = {
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
 * which way the car faces (rad) and how high its ground is (m). The second has
 * its front wheels off with the work lamp under it. Which car each holds and
 * how it is built are rolled fresh every visit (liftBuilds).
 */
const LIFTS: { x: number; z: number; yaw: number; h: number; wheelsOff?: boolean }[] = [
  { x: -5.4, z: -8.7, yaw: 0, h: 1.85 },
  { x: 1.4, z: -8.7, yaw: Math.PI, h: 0.95, wheelsOff: true },
  { x: -8.7, z: -1.6, yaw: Math.PI / 2, h: 1.7 },
  { x: -8.7, z: 4.6, yaw: Math.PI / 2, h: 0.4 },
];

/** The lift the crew's operator raises and lowers, and how high its car's ground goes (m). */
const MOVING_LIFT = { index: 3, high: 1.75 } as const;

/** How long the wall screen waits between redraws when no pull climbs (s): the READY blink and the peak call-out. */
const SCREEN_IDLE = 1 / 10;

/** The dyno cell in the front right quadrant, beside the way in: where the car on it stands (m) and faces (rad: into the room, its tail and exhaust toward the door, the giant fan at its nose). */
const DYNO = { x: 8.0, z: 6.6, yaw: Math.PI, fanR: 0.75 } as const;

/**
 * The drum fan's blades (rad/s): spinning free while the customer's car is on the dyno between pulls, rising to
 * `full` as its revs climb; with the player's on it, turning over at `idle` until a pull spools it to `full`,
 * easing at `ease` (1/s).
 */
const FAN = { free: 14, idle: 3, full: 30, ease: 1.6 } as const;

/**
 * The welder by the back wall, arcing on the shop's schedule (shopSchedule.ts `weld`): where the arc burns
 * (m), its light (blue-white, flickering at `flickerHz`, up to `light` over `range` m, one more point light in
 * the room's shading on Medium and High) and the sparks it throws: `count` points living `life` s, thrown at
 * up to `speed` m/s into the room and falling under `gravity` m/s².
 */
const WELD = { x: 2.95, y: 1.05, z: -11.0, light: 14, range: 7, flickerHz: 31, count: 48, life: 0.45, speed: 2.8, gravity: 9.8, size: 150 } as const;

/** Body paints the customers' cars come in, each with its finish. */
const LIFT_PAINTS: [string, PaintFinish][] = [
  ['#5f6266', 'matte'],
  ['#3b1f6e', 'candy'],
  ['#e6e3dc', 'pearl'],
  ['#0f1012', 'matte'],
  ['#b3121e', 'candy'],
  ['#f2c230', 'gloss'],
  ['#1f6fd1', 'metallic'],
  ['#0e7a5a', 'pearl'],
  ['#ff6a1a', 'gloss'],
  ['#c9ced8', 'metallic'],
  ['#7d1fd1', 'candy'],
  ['#2b3a2e', 'matte'],
  ['#e83f8c', 'pearl'],
  ['#101a3a', 'metallic'],
  ['#f4f4f0', 'gloss'],
  ['#5a0f14', 'metallic'],
];
/** Wheel paints and caliper colors the builds pick from. */
const WHEEL_PAINTS: [string, PaintFinish][] = [
  ['#1a1b1f', 'gloss'],
  ['#c9ced8', 'metallic'],
  ['#b08d57', 'metallic'],
  ['#d8dade', 'gloss'],
  ['#2a2c31', 'matte'],
  ['#c41e3a', 'gloss'],
  ['#f2c230', 'gloss'],
  ['#3d4a5c', 'candy'],
];
const CALIPER_COLORS = ['#c41e3a', '#f2c230', '#1f6fd1', '#1a1b1f', '#ff6a1a', '#c9ced8', '#2fbf71'];

/** Battens: position (m), yaw, length and state. The cluster over the turntable, then the work areas. */
const BATTENS: { x: number; y: number; z: number; yaw: number; len: number; state: 'lit' | 'off' | 'flicker' }[] = [
  { x: -1.1, y: ROOM.battenY, z: 0, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  { x: 0, y: ROOM.battenY, z: 0, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  { x: 1.1, y: ROOM.battenY, z: 0, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  // Over the back lifts, hung high and forward so they stay under the sign from the default view.
  { x: -5.4, y: 5.75, z: -6.4, yaw: 0, len: 2.4, state: 'lit' },
  { x: 1.4, y: 5.75, z: -6.4, yaw: 0, len: 2.4, state: 'lit' },
  { x: -8.7, y: 5.0, z: -1.6, yaw: 0, len: 2.4, state: 'lit' },
  { x: -8.7, y: 5.0, z: 4.6, yaw: 0, len: 2.4, state: 'lit' },
  { x: 10.4, y: 4.6, z: -2.5, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  { x: 2.5, y: 5.0, z: 8, yaw: 0, len: 2.4, state: 'lit' },
  // Over the dyno.
  { x: DYNO.x, y: 5.0, z: DYNO.z, yaw: Math.PI / 2, len: 2.4, state: 'lit' },
  // Every lift's batten is on; the dying one hangs over the front corner's lockers.
  { x: -5, y: 5.0, z: 9, yaw: 0, len: 2.4, state: 'flicker' },
];

/** Where the neon signs hang: center (m) and facing yaw. */
const SIGNS = { main: { x: -2, y: 5.0, z: -ROOM.half + 0.02, yaw: 0 }, open: { x: ROOM.half - 0.02, y: 3.35, z: -2.5, yaw: -Math.PI / 2 } } as const;

/** The car's ground on the turntable and how far the lift cars' wheels hang when lifted (m). */
const DROOP = -0.06;

export class Showroom {
  readonly scene = new THREE.Scene();
  /** Turns with the car on it (the garage scene spins it). */
  readonly turntable = new THREE.Group();
  /** The studio reflections for the car's paint. */
  readonly envMap: THREE.Texture;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly flickerMat: THREE.MeshBasicMaterial;
  private readonly shadow: THREE.Mesh;
  private readonly reflector: Reflector | null = null;
  private readonly dust: THREE.Points | null = null;
  private readonly dustTime: { value: number } = { value: 0 };
  /** What the shop is doing this frame (shopSchedule at the clock), read by the room's effects and the sound bed. */
  readonly shop: ShopState = createShopState();
  /** The dying batten's brightness this frame, 0..1 (the sound bed's buzz follows it). */
  batten = 1;
  /** The welder's arc and sparks (Medium and High), or null. */
  private readonly weld: { light: THREE.PointLight; sparks: THREE.Points; pos: Float32Array; vel: Float32Array; life: Float32Array; alive: number } | null = null;
  private readonly signs: NeonSign[] = [];
  /** The drum fan's blades (spun in update) and the dyno screen on the wall (redrawn a few times a second). */
  private readonly fanBlades: THREE.Object3D;
  private readonly dyno: ReturnType<typeof dynoScreen>;
  private dynoWait = 0;
  /** The fan's speed now (rad/s) and the pull it follows (0..1 of the revs' range; null while the customer's car is on the dyno: it follows the customer's revs). */
  private fanRate: number = FAN.free;
  private fanLoad: number | null = null;
  /** The live pull the wall screen draws while the player's car is strapped on (null: the customer's own). */
  private run: DynoRun | null = null;
  /** The customer's car and straps on the dyno, hidden while the player's car takes their place. */
  private dynoCar: CarView | null = null;
  private readonly customerDyno = new THREE.Group();
  /** The customer's pull: the shop's pedal on a rev model and dyno session, shared by the screen, wheels, drums, fan and sound bed. */
  private readonly customer: CustomerDyno;
  /** The customer's drums (pivots in the customerDyno group, turned with its wheels) and the pose its car is updated with. */
  private readonly customerDrums: THREE.Group[] = [];
  private customerPose: CarPose | null = null;
  /** Whether the customer's car was being posed last frame (one more frame after it settles brings the wheels to rest). */
  private customerWasBusy = false;
  /** The deck, rollers and straps cut for the player's car, the drums in it that spin, and what built them (freed when it leaves). */
  private playerRig: THREE.Group | null = null;
  private drums: THREE.Group[] = [];
  private readonly rigOwner = new Disposer();
  /** The dyno's frame: the deck's height, the customer car's length, the exhaust hose's vent (dyno frame), the car box the camera ignores while the player's car is on. */
  private deckY = 0;
  private dynoLength = 0;
  private vent: [number, number, number] = [0, 0, 0];
  private dynoObstacle: THREE.Box3 | null = null;
  private occupied = false;
  private mats!: Mats;
  /** The crew, and the moving lift's carriage, arms and car (raised to the crew's cycle); null on Low. */
  private readonly crew: Crew | null = null;
  private liftRig: THREE.Group | null = null;
  private crewLift: CrewLift | null = null;
  private readonly liftCars: CarView[] = [];
  /** What the orbit camera must not pass through: the lifts and their cars, as room-space boxes. */
  private readonly obstacles: THREE.Box3[] = [];
  private readonly owned = new Disposer();
  private readonly offset = new THREE.Vector3();
  private disposed = false;
  private time = 0;
  /** The tire tread texture on the cars (medium and up; low keeps plain rubber). */
  private readonly tread: boolean;

  constructor(renderer: THREE.WebGLRenderer, quality: Quality, assets: CarAssetLibrary) {
    const q = SHOWROOM_QUALITY[quality];
    this.tread = quality !== 'low';
    const { track } = this.owned;
    const s = this.scene;
    s.background = new THREE.Color(0x070709);
    s.fog = new THREE.Fog(0x09090d, 14, 36);
    const H = ROOM.half;

    // ---------- walls, roof, battens ----------
    const m = createMaterials(track, track(wallTexture(ROOM.height, ROOM.band)));
    this.flickerMat = m.tubeFlicker;
    this.mats = m;
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
    const builds = liftBuilds(LIFTS.length + 1);
    LIFTS.forEach((l, i) => {
      const { carId, visual } = builds[i];
      const car = MANIFEST.cars.find((c) => c.id === carId)!;
      const fit: LiftFit = { width: car.dimensions.width, length: car.dimensions.length, wheelbase: car.wheelbase };
      const loaded = i < q.liftCars;
      const h = loaded ? l.h : 0.3;
      // The operator's lift: its carriage, arms and car in a rig that rises and falls with the crew's cycle.
      const moving = loaded && q.crew && i === MOVING_LIFT.index;
      const rigKit = moving ? new Kit(m) : undefined;
      const [ax, az] = lift(k, l.x, l.z, l.yaw, h, fit, rigKit);
      if (rigKit) {
        const rig = new THREE.Group();
        rig.position.y = h;
        rigKit.build(rig, track);
        s.add(rig);
        this.liftRig = rig;
        this.crewLift = { x: l.x, z: l.z, yaw: l.yaw, px: car.dimensions.width / 2 + 0.42, wheel: [car.wheels.FL[0], car.wheels.FL[2]], low: h, high: MOVING_LIFT.high };
      }
      this.obstacle(l.x, l.z, l.yaw, ax, az, 4.0);
      // Oil stains under every lift; a drain pan under the one being worked on.
      k.place().plane(m.stain, 2.2, 2.2, l.x + 0.3, 0.006, l.z - 0.4, i * 1.3, -Math.PI / 2);
      if (!loaded) return;
      if (l.wheelsOff) hubs(k, l.x, h + DROOP, l.z, l.yaw, car.wheels.FL, car.wheels.FR);
      void this.loadParkedCar(assets, carId, visual, { x: l.x, y: moving ? 0 : h, z: l.z, yaw: l.yaw }, DROOP, l.wheelsOff, moving ? this.liftRig! : this.scene);
    });
    // ---------- the dyno, its car and the giant fan in front of it ----------
    const dynoBuild = builds[LIFTS.length];
    const dynoCar = MANIFEST.cars.find((c) => c.id === dynoBuild.carId)!;
    // The exhaust hose vents under the front door: that point in the dyno's frame.
    const vdx = 7.3 - DYNO.x;
    const vdz = H - 0.1 - DYNO.z;
    const vent: [number, number, number] = [Math.cos(DYNO.yaw) * vdx - Math.sin(DYNO.yaw) * vdz, 0.06, Math.sin(DYNO.yaw) * vdx + Math.cos(DYNO.yaw) * vdz];
    this.vent = vent;
    // The customer's dyno is a group of its own (the player's car gets one cut for it): cut for the car's drive, its drums pivots the pull turns.
    this.customer = new CustomerDyno(dynoCar.id, dynoCar.displayName);
    const dk = new Kit(m);
    const { deck, rollers } = dyno(dk, DYNO.x, DYNO.z, DYNO.yaw, dynoFitOf(dynoCar, this.customer.driven));
    dk.build(this.customerDyno, track);
    for (const r of rollers) {
      const pivot = new THREE.Group();
      pivot.rotation.order = 'YXZ';
      pivot.rotation.y = DYNO.yaw;
      pivot.position.set(DYNO.x + r.z * Math.sin(DYNO.yaw), deck - DYNO_DRUM.radius + 0.01, DYNO.z + r.z * Math.cos(DYNO.yaw));
      const drum = new Kit(m);
      drum.place();
      dynoDrum(drum, r.track);
      drum.build(pivot, track);
      this.customerDyno.add(pivot);
      this.customerDrums.push(pivot);
    }
    s.add(this.customerDyno);
    this.customerPose = { x: DYNO.x, y: deck, z: DYNO.z, yaw: DYNO.yaw, pitch: 0, roll: 0, steer: 0, comp: [0, 0, 0, 0], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 };
    this.deckY = deck;
    this.dynoLength = dynoCar.dimensions.length;
    this.dynoObstacle = this.obstacle(DYNO.x, DYNO.z, DYNO.yaw, 1.45, dynoCar.dimensions.length / 2 + 0.6, 1.6);
    if (q.dynoCar) {
      // The customer's car and its straps (in the customer's dyno group, so the player's car swaps them out together).
      const straps = new Kit(m);
      dynoStraps(straps, DYNO.x, DYNO.z, DYNO.yaw, { length: dynoCar.dimensions.length, width: dynoCar.dimensions.width, z: 0 }, dynoHalf(dynoCar.dimensions.length));
      straps.build(this.customerDyno, track);
      // Its extraction funnels are cut to the tips of the car as loaded (the body's stance applied); the manifest's stand in if it fails.
      void this.loadParkedCar(assets, dynoBuild.carId, dynoBuild.visual, { x: DYNO.x, y: deck, z: DYNO.z, yaw: DYNO.yaw }, 0).then((v) => {
        this.dynoCar = v;
        if (v) {
          v.root.visible = !this.occupied;
          // Posed every frame of a pull: keep the lamps as parked (setBrake would light the tail lamps otherwise).
          v.setLampLevel(0);
        }
        if (!this.disposed) this.cutVents(this.customerDyno, v ? v.tipsOnRoot() : dynoCar.exhaustTips ?? [], dynoCar.dimensions.length, track);
      });
    } else this.cutVents(this.customerDyno, dynoCar.exhaustTips ?? [], dynoCar.dimensions.length, track);
    const fanAt = { x: DYNO.x, z: DYNO.z - dynoCar.dimensions.length / 2 - 1.25, yaw: 0 };
    const hub = drumFan(k, fanAt.x, fanAt.z, fanAt.yaw, DYNO.fanR);
    this.obstacle(fanAt.x, fanAt.z, 0, DYNO.fanR + 0.2, 0.4, 2 * DYNO.fanR + 0.3);
    for (const [x, z, hx, hz, h] of workArea(k, m)) this.obstacle(x, z, 0, hx, hz, h);
    // Faked light under the work areas' battens (the cluster over the table has real light): additive pools, no shading cost.
    BATTENS.slice(3).forEach((b) => {
      if (b.state === 'lit') lightPool(k, m.poolTube, b.x, b.z, b.len + 1.2, 2.4, b.yaw);
    });
    // The dyno's screen on the wall beside it, redrawn as the run goes.
    this.dyno = dynoScreen();
    this.dyno.draw(0, this.customer.run);
    const screen = track(new THREE.MeshBasicMaterial({ map: track(this.dyno.texture), color: new THREE.Color(1.25, 1.25, 1.25) }));
    wallTv(k, H, 2.6, 6.75, -Math.PI / 2, screen);
    k.build(s, track);
    // The giant fan's blades, spun in update: four broad blades pitched into the air, the hub.
    const blades = new Kit(m);
    const br = DYNO.fanR;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      blades.place(0, 0, 0, 0).box(m.galv, 0.34 * br, 0.82 * br, 0.014, Math.cos(a + Math.PI / 2) * 0.48 * br, Math.sin(a + Math.PI / 2) * 0.48 * br, 0, 0.35, 0, a);
    }
    blades.cyl(m.black, 0.14 * br, 0.1, 0, 0, 0, 'z', 16);
    const fan = new THREE.Group();
    fan.position.set(fanAt.x, 0, fanAt.z);
    fan.rotation.y = fanAt.yaw;
    this.fanBlades = new THREE.Group();
    this.fanBlades.position.set(...hub);
    fan.add(this.fanBlades);
    blades.build(this.fanBlades, track);
    s.add(fan);

    // ---------- the crew ----------
    if (this.crewLift) {
      const l1 = LIFTS[0];
      this.crew = new Crew(
        {
          lift: this.crewLift,
          overhead: { x: l1.x + 0.15, z: l1.z + 0.3, yaw: Math.PI },
          bench: { x: 10.78, z: -2.75, yaw: Math.PI / 2 },
          dyno: { x: 6.1, z: 8.7, screen: [H, 6.75], car: [DYNO.x, DYNO.z] },
          talk: [
            [-8.55, 8.85],
            [-7.75, 8.35],
          ],
          carry: [
            [9.95, -6.4],
            [9.95, -3.5],
          ],
        },
        track,
        track(glowTexture()),
      );
      s.add(this.crew.group);
    }

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
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const concrete = concreteTextures(q.texRes);
    for (const t of [concrete.color, concrete.rough]) track(t).repeat.set((2 * H) / 8, (2 * H) / 8);
    // The aggregate's bump repeats every 2 m, finer than the color's 8 m.
    track(concrete.bump).repeat.set(H, H);
    concrete.color.anisotropy = concrete.bump.anisotropy = aniso;
    const reflective = q.reflection > 0;
    const floor = new THREE.Mesh(
      track(new THREE.PlaneGeometry(2 * H, 2 * H).rotateX(-Math.PI / 2)),
      track(
        new THREE.MeshStandardMaterial({
          map: concrete.color,
          roughnessMap: concrete.rough,
          bumpMap: concrete.bump,
          bumpScale: 0.6,
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
        if (this.crew) this.crew.group.visible = false;
        mirror(...args);
        // Back on, except the customer's car while the player's stands on the dyno.
        for (const v of this.liftCars) v.root.visible = !(this.occupied && v === this.dynoCar);
        if (this.crew) this.crew.group.visible = true;
      };
      s.add(r);
      this.reflector = r;
    }
    const hazardMap = track(hazardTexture());
    hazardMap.anisotropy = aniso;
    const hazard = new THREE.Mesh(track(ringGeometry(ROOM.ring[0], ROOM.ring[1], 192)), track(new THREE.MeshStandardMaterial({ map: hazardMap, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })));
    hazard.position.y = 0.004;
    hazard.renderOrder = 1;
    s.add(hazard);

    // ---------- turntable ----------
    const top = ROOM.tableTop;
    const plateMaps = plateTextures(1024 * q.texRes);
    for (const t of [plateMaps.color, plateMaps.bump, plateMaps.rough]) track(t).anisotropy = aniso;
    const plate = track(new THREE.MeshStandardMaterial({ map: plateMaps.color, bumpMap: plateMaps.bump, bumpScale: 1.6, roughnessMap: plateMaps.rough, color: 0x8a8a90, roughness: 1, metalness: 0.75 }));
    const side = track(new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.6, metalness: 0.5 }));
    const table = new THREE.Mesh(track(new THREE.CylinderGeometry(ROOM.table, ROOM.table + 0.04, top, 192)), [side, plate, side]);
    table.position.y = top / 2;
    this.turntable.add(table);
    // Countersunk bolts round the rim and the bearing's hub cap with its own ring of bolts, one merged mesh turning with the table.
    const bolts: THREE.BufferGeometry[] = [];
    const bolt = (r: number, a: number, size: number, y: number) => bolts.push(new THREE.CylinderGeometry(size, size * 1.15, 0.008, 8).translate(Math.cos(a) * r, y + 0.004, Math.sin(a) * r));
    for (let i = 0; i < 48; i++) bolt(ROOM.table - 0.09, (i / 48) * Math.PI * 2, 0.014, top);
    bolts.push(new THREE.CylinderGeometry(0.26, 0.28, 0.012, 48).translate(0, top + 0.006, 0));
    for (let i = 0; i < 8; i++) bolt(0.2, (i / 8) * Math.PI * 2 + 0.2, 0.012, top + 0.012);
    const boltMat = track(new THREE.MeshStandardMaterial({ color: 0x9a9ca3, roughness: 0.35, metalness: 0.85 }));
    this.turntable.add(new THREE.Mesh(track(mergeGeometries(bolts)), boltMat));
    bolts.forEach((g) => g.dispose());
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
    // The battens over the turntable as one spot: strong enough to model the car, not so strong that a light
    // paint's roof saturates under it (a lighter spot and a touch more fill read better from above).
    // Held to what a light paint takes without saturating on the roof and hood (24 blew a white roof out).
    const key = new THREE.SpotLight(0xe8eeff, 9, 14, 1.0, 1, 1.2);
    key.position.set(0, ROOM.battenY - 0.05, 0);
    s.add(key, key.target);
    const spot = (color: THREE.ColorRepresentation, intensity: number, x: number, y: number, z: number) => {
      const l = new THREE.SpotLight(color, intensity, 26, 0.32, 0.8, 1.4);
      l.position.set(x, y, z);
      s.add(l, l.target);
    };
    spot(PALETTE.orange, 18, -6.5, 4.4, -6.5);
    spot(NEON.cyan, 10, 6.5, 4.4, -6.5);
    const fill = new THREE.PointLight(0xc8d2ff, 8, 16, 1.2);
    fill.position.set(1.5, 3.2, 8);
    const bays = new THREE.PointLight(0xdfe8ff, 10, 12, 1.3);
    bays.position.set(-8.2, 4.5, 1.5);
    s.add(fill, bays);
    if (q.workLights) {
      // The batten over the second lift, the lamp hung under its car, the bench's strip, the dyno cell's batten
      // (so a car on the rollers reads by more than its underglow).
      const liftLight = new THREE.PointLight(0xe8eeff, 6, 8, 1.4);
      liftLight.position.set(LIFTS[1].x, 5.4, -6.6);
      const lamp = new THREE.PointLight(0xffb36a, 4, 4.5, 1.6);
      lamp.position.set(LIFTS[1].x - 0.4, 0.75, LIFTS[1].z + 0.9);
      const bench = new THREE.PointLight(0xfff0dc, 6, 7, 1.5);
      bench.position.set(10.4, 4.1, -2.5);
      const dynoLight = new THREE.PointLight(0xe8eeff, 8, 9, 1.4);
      dynoLight.position.set(DYNO.x, 4.7, DYNO.z);
      s.add(liftLight, lamp, bench, dynoLight);
      // The welder: its light off until the schedule strikes an arc, its sparks a handful of points moved on
      // the CPU only while it burns.
      const arc = new THREE.PointLight(0x9fc4ff, 0, WELD.range, 2);
      arc.position.set(WELD.x, WELD.y, WELD.z + 0.2);
      const sparks = weldSparks();
      track(sparks.geometry);
      track(sparks.material as THREE.Material);
      sparks.visible = false;
      s.add(arc, sparks);
      const n = WELD.count;
      this.weld = { light: arc, sparks, pos: (sparks.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array, vel: new Float32Array(n * 3), life: (sparks.geometry.getAttribute('life') as THREE.BufferAttribute).array as Float32Array, alive: 0 };
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
  private obstacle(x: number, z: number, yaw: number, across: number, along: number, height: number): THREE.Box3 {
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    const hx = across * c + along * s;
    const hz = across * s + along * c;
    const box = new THREE.Box3(new THREE.Vector3(x - hx, 0, z - hz), new THREE.Vector3(x + hx, height, z + hz));
    this.obstacles.push(box);
    return box;
  }

  /** Load a car view standing still at `at` (its ground and yaw), its wheels hung by `droop` (m), the front pair off for a brake job. */
  private async loadParkedCar(assets: CarAssetLibrary, carId: string, visual: VisualBuild, at: { x: number; y: number; z: number; yaw: number }, droop: number, wheelsOff = false, parent: THREE.Object3D = this.scene): Promise<CarView | null> {
    const view = new CarView(carId, assets, { envMap: this.envMap, tread: this.tread });
    view.setHeadlightsEnabled(false);
    await view.load(visual);
    if (this.disposed) {
      view.dispose();
      return null;
    }
    if (wheelsOff) {
      view.setWheelVisible(0, false);
      view.setWheelVisible(1, false);
    }
    const pose: CarPose = { x: at.x, y: at.y, z: at.z, yaw: at.yaw, pitch: 0, roll: 0, steer: 0, comp: [droop, droop, droop, droop], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 };
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
    parent.add(view.root);
    this.liftCars.push(view);
    return view;
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
      // The player's car on the dyno takes the customer's place: the camera orbits it, not round it.
      if (this.occupied && b === this.dynoObstacle) continue;
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

  /** Where the player's car stands on the dyno (m, rad): centred on it like the customer's, its axles over the rollers cut for it. The deck is `y`. */
  dynoStand(out: { x: number; y: number; z: number; yaw: number }): void {
    out.x = DYNO.x;
    out.y = this.deckY;
    out.z = DYNO.z;
    out.yaw = DYNO.yaw;
  }

  /**
   * Strap the player's car to the dyno: it leaves the turntable (or the dyno it already stands on, for a new
   * car or drivetrain) for the room's scene, the customer's car, deck and straps hide, and a dyno cut for this
   * car replaces them: the deck pitted under its driven axles (one roller set, or two for all wheel drive),
   * chocks at the wheels that stand still, straps to its tow points, and the drums, which `spinDrums` turns.
   * The caller poses it (`dynoStand`).
   */
  mountDyno(view: CarView, driven: DynoDrive): void {
    this.scene.add(view.root);
    this.occupied = true;
    this.shadow.visible = false;
    if (this.dynoCar) this.dynoCar.root.visible = false;
    this.customerDyno.visible = false;
    this.clearPlayerRig();
    const fit = dynoFitOf(view.car, driven);
    const half = Math.max(dynoHalf(this.dynoLength), dynoHalf(fit.length));
    const group = new THREE.Group();
    const kit = new Kit(this.mats);
    const { rollers } = dyno(kit, DYNO.x, DYNO.z, DYNO.yaw, fit, half);
    dynoVents(kit, DYNO.x, DYNO.z, DYNO.yaw, view.tipsOnRoot(), -fit.length / 2, this.vent);
    dynoStraps(kit, DYNO.x, DYNO.z, DYNO.yaw, { length: fit.length, width: fit.width, z: 0 } satisfies StrapFit, half);
    kit.build(group, this.rigOwner.track);
    // A drum is a pivot at its axis in the dyno's frame, turned about the dyno's x as the wheels drive it.
    for (const r of rollers) {
      const pivot = new THREE.Group();
      pivot.rotation.order = 'YXZ';
      pivot.rotation.y = DYNO.yaw;
      pivot.position.set(DYNO.x + r.z * Math.sin(DYNO.yaw), this.deckY - DYNO_DRUM.radius + 0.01, DYNO.z + r.z * Math.cos(DYNO.yaw));
      const dk = new Kit(this.mats);
      dk.place();
      dynoDrum(dk, r.track);
      dk.build(pivot, this.rigOwner.track);
      group.add(pivot);
      this.drums.push(pivot);
    }
    this.scene.add(group);
    this.playerRig = group;
  }

  /** Unstrap: the customer's car, deck and straps are back, the player's car goes to the turntable. */
  releaseDyno(view: CarView): void {
    this.occupied = false;
    this.shadow.visible = true;
    if (this.dynoCar) this.dynoCar.root.visible = true;
    this.customerDyno.visible = true;
    this.clearPlayerRig();
    this.mount(view);
  }

  /** The exhaust extraction for a car's tips (car frame, m) and length, built into `into` (the customer's dyno group: it hides with it). */
  private cutVents(into: THREE.Group, tips: readonly (readonly number[])[], length: number, track: Disposer['track']): void {
    const kit = new Kit(this.mats);
    dynoVents(kit, DYNO.x, DYNO.z, DYNO.yaw, tips as [number, number, number][], -length / 2, this.vent);
    kit.build(into, track);
  }

  private clearPlayerRig(): void {
    this.playerRig?.removeFromParent();
    this.playerRig = null;
    this.drums.length = 0;
    this.rigOwner.dispose();
  }

  /** Turn the player's drums to this angle (rad, about their axis; the scene integrates it from the wheels' speed). */
  spinDrums(angle: number): void {
    for (const d of this.drums) d.rotation.x = angle;
  }

  /** Hand the wall screen a live pull to draw (null: back to the customer's own). The object is read at each redraw, so the caller may keep updating it. */
  setRun(run: DynoRun | null): void {
    this.run = run;
    this.dynoWait = 0;
  }

  /** The drum fan's pull: 0..1 of the revs' range while the player's car is on the dyno, null to follow the customer's car. */
  setFan(load: number | null): void {
    this.fanLoad = load;
  }

  /** The customer's revs on the dyno, 0..1 of idle to redline (the sound bed follows them). */
  get customerRpm(): number {
    return this.customer.x;
  }

  /** The room's clock (s): what the shop's schedule, the batten's flicker and the crew run on. */
  get clock(): number {
    return this.time;
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
    shopSchedule(t, this.shop);
    this.updateCustomer(dt, t);
    const f = battenFlicker(t);
    this.batten = f;
    this.flickerMat.color.copy(GLOW.tube).multiplyScalar(f);
    for (const sign of this.signs) sign.update(t);
    this.dustTime.value = t;
    if (this.weld) this.updateWeld(dt, this.shop.weld);
    const fanTarget = this.fanLoad === null ? FAN.free + this.customer.x * (FAN.full - FAN.free) : FAN.idle + this.fanLoad * (FAN.full - FAN.idle);
    this.fanRate += (fanTarget - this.fanRate) * damp(FAN.ease, dt);
    this.fanBlades.rotation.z -= dt * this.fanRate;
    if (this.crew && this.liftRig && this.crewLift) {
      this.crew.update(t);
      this.liftRig.position.y = liftHeight(this.crewLift, t);
    }
    // The wall screen redraws every frame while a pull climbs (the player's or the customer's), and a few times a
    // second otherwise (the READY blink, the peak call-out); each redraw is one 384 x 216 texture upload.
    this.dynoWait -= dt;
    if (this.dynoWait <= 0) {
      const run = this.run ?? this.customer.run;
      this.dynoWait = run.state === 'pull' ? 0 : SCREEN_IDLE;
      this.dyno.draw(t, run);
    }
  }

  /**
   * The customer's pull: the shop's pedal through its rev model and dyno session every frame (one rev step and
   * one session update), and, while its car is on show and the engine is working, the driven wheels and the
   * drums under them turn and the body rocks on its springs. The car view is only re-posed while busy (and the
   * frame after, so the wheels come to rest), which is a few seconds in every couple of minutes.
   */
  private updateCustomer(dt: number, t: number): void {
    const c = this.customer;
    c.update(dt, this.shop.dynoPedal);
    const car = this.dynoCar;
    const pose = this.customerPose;
    const busy = c.busy;
    if (!busy && !this.customerWasBusy) return;
    this.customerWasBusy = busy;
    if (!car || !pose || this.occupied) return;
    for (const d of this.customerDrums) d.rotation.x = c.drumAngle;
    for (let i = 0; i < 4; i++) {
      const driven = c.driven === 'all' || (c.driven === 'front') === i < 2;
      pose.spin[i] = driven ? c.spin : 0;
    }
    pose.pitch = c.pitch;
    pose.roll = c.roll;
    for (let i = 0; i < 4; i++) {
      const w = car.car.wheels[WHEEL_KEYS[i]];
      pose.comp[i] = -(w[0] * pose.roll - w[2] * pose.pitch);
    }
    car.update(pose, t);
  }

  /**
   * The welder's arc: the light flickers hard while it burns, and the sparks fly from it, each point thrown
   * into the room and up, falling under gravity and dying in under half a second; the dead respawn while the
   * arc is on and the burst goes dark once the last one lands.
   */
  private updateWeld(dt: number, arc: number): void {
    const w = this.weld!;
    w.light.intensity = arc > 0 ? WELD.light * arc * (0.45 + 0.55 * noise(Math.floor(this.time * WELD.flickerHz))) : 0;
    if (arc <= 0 && w.alive === 0) {
      w.sparks.visible = false;
      return;
    }
    const { pos, vel, life } = w;
    const fade = dt / WELD.life;
    let alive = 0;
    for (let i = 0; i < WELD.count; i++) {
      const j = i * 3;
      if (life[i] > 0) {
        life[i] -= fade;
        vel[j + 1] -= WELD.gravity * dt;
        pos[j] += vel[j] * dt;
        pos[j + 1] += vel[j + 1] * dt;
        pos[j + 2] += vel[j + 2] * dt;
        if (pos[j + 1] < 0.01) life[i] = 0;
      } else if (arc > 0 && Math.random() < 0.3) {
        // Reborn at the arc: a fan of sparks out into the room and up (render only, so Math.random is fine).
        const a = (Math.random() - 0.5) * 2.4;
        const v = WELD.speed * (0.3 + 0.7 * Math.random());
        life[i] = 0.6 + 0.4 * Math.random();
        pos[j] = WELD.x;
        pos[j + 1] = WELD.y;
        pos[j + 2] = WELD.z;
        vel[j] = Math.sin(a) * v;
        vel[j + 1] = v * (0.4 + 0.8 * Math.random());
        vel[j + 2] = Math.cos(a) * v * 0.8;
      }
      if (life[i] > 0) alive++;
    }
    w.alive = alive;
    w.sparks.visible = true;
    (w.sparks.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (w.sparks.geometry.getAttribute('life') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.reflector?.dispose();
    for (const v of this.liftCars) v.dispose();
    this.rigOwner.dispose();
    for (const sign of this.signs) sign.dispose();
    this.owned.dispose();
  }
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/** The LED rim's base color, and the axes the camera's box test walks (module constants: nothing allocated per frame). */
const RING = new THREE.Color(PALETTE.orange);
const AXES = ['x', 'y', 'z'] as const;

/**
 * The lift cars for this visit: a different car on each lift while there are
 * enough to go round, each built at random from the catalog the way a tuner's
 * customers bring them in (paint and finish, trim, some slots kitted and some
 * stock, wheels, calipers, tint and a stance from mild to slammed, kept inside
 * what the lift arms leave room for). Render only, so Math.random is fine here.
 */
function liftBuilds(n: number, rnd: () => number = Math.random): { carId: string; visual: VisualBuild }[] {
  const deck = MANIFEST.cars.filter((c) => c.selectable).map((c) => c.id);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const range = (a: number, b: number) => a + rnd() * (b - a);
  return Array.from({ length: n }, (_, i) => {
    const carId = deck[i % deck.length];
    const v = defaultVisual();
    const [color, finish] = pick(LIFT_PAINTS);
    v.paint = { color, finish };
    v.tint.darkness = range(0.4, 0.85);
    for (const slot of PART_SLOTS) {
      const list = partsFor(carId, slot);
      v.parts[slot] = list.length && rnd() < (slot === 'body' ? 0.35 : 0.65) ? pick(list).id : null;
    }
    const [wc, wf] = pick(WHEEL_PAINTS);
    v.wheels.paint = { color: wc, finish: wf, match: rnd() < 0.1 };
    v.wheels.rearPaint = { ...v.wheels.paint };
    v.wheels.tire = v.wheels.rearTire = rnd() < 0.25 ? 'stretched' : 'standard';
    v.calipers = { color: pick(CALIPER_COLORS), finish: 'gloss', match: false };
    const ride = range(-0.05, 0);
    const camber = rnd() < 0.4 ? range(-7, -2) : range(-1.5, 0);
    const offset = range(0, 0.04);
    const size = range(1, 1.15);
    for (const a of AXLES) v.stance[a] = { rideHeight: ride, camber: a === 'rear' ? camber * 0.7 : camber, offset, wheelSize: size, wheelWidth: 1 };
    return { carId, visual: v };
  });
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

/** The dyno's fit of a car (m, car space; the car stands centred on the dyno) and the axles that drive it. */
function dynoFitOf(car: Pick<ManifestCar, 'dimensions' | 'wheels'>, driven: DynoDrive): DynoFit {
  const w = car.wheels;
  return { length: car.dimensions.length, width: car.dimensions.width, rearZ: w.RL[2], frontZ: w.FL[2], rearTrack: 2 * Math.abs(w.RL[0]), frontTrack: 2 * Math.abs(w.FL[0]), driven };
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
 * Everything round the lifts: the walls' benches, roll cabs, chests, lockers,
 * shelving, racks, drums and the compressor, the tire machines by the rack,
 * the welder and the carts, the machines along the left wall, the tool
 * boards, cabinets, jobs board and ceiling reels, the coffee corner, the
 * jacks, stands, chargers and diagnostics at the lifts, the hoist out on the
 * floor, the work in progress
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
  // Behind the lifts: a black cab under the high car, the flagship under the main sign, the welder by the sandblaster.
  rollCab(k, -5.4, -H + 0.33, 0, 1.8, m.black, m.drawersBlack, 'bare');
  flagshipCab(k, SIGNS.main.x, -H + 0.33, 0, 3.2, { body: m.candy, fronts: m.drawersCandy, accent: m.accentCyan, glow: m.glowCyan, badge: 0, top: 'hutch', lockers: 2, cabinets: 6, cabinetY: 2.95 });
  welder(k, 2.95, -11.2, 0);
  toolBoard(k, -5.4, 1.85, -H, 0, 1.8, 0.9);
  acMachine(k, -7.3, -11.4, 0.2);
  sandblaster(k, 1.5, -11.55, 0);
  // The back right corner: the fridge with the coffee on it under the beer sign, a bin beside it.
  coffeeCorner(k, 11.1, -11.68, 0);
  beerCooler(k, 11.68, -11.68, 0);
  trashCan(k, 9.9, -10.25, 0.24);
  spaceHeater(k, 10.0, -11.3, 0.3);
  wallClock(k, 3.6, 3.0, -H, 0);
  // Left wall: tire stacks in the back corner, a chest under a pegboard between the lifts.
  for (const [x, z, n] of [
    [-11.3, -5.3, 5],
    [-10.6, -5.0, 3],
    [-11.3, -9.2, 4],
  ] as const)
    for (let i = 0; i < n; i++) tire(k, x, 0.1 + i * 0.2, z);
  // Between the left lifts: the candy blue flagship with its green light.
  flagshipCab(k, -H + 0.33, 1.6, Y, 1.7, { body: m.candyBlue, fronts: m.drawersCandyBlue, accent: m.accentGreen, glow: m.glowGreen, badge: 3, top: 'hutch', lockers: 2, cabinets: 5, cabinetY: 2.95 });
  // Left wall, front corner: a bank of black lockers.
  locker(k, -H + 0.32, 9.0, Y, 0.95, m.black);
  locker(k, -H + 0.32, 8.02, Y, 0.95, m.black, true);
  calendar(k, -H, 2.55, 8.5, Y);
  // The machines along the left wall: parts washer and grinder by the tires, the press, a charger, the drill press.
  partsWasher(k, -H + 0.32, -7.9, Y);
  benchGrinder(k, -11.5, -6.5, Y);
  hydraulicPress(k, -H + 0.3, -3.7, Y);
  batteryCharger(k, -11.5, 3.38, Y);
  drillPress(k, -11.55, 6.7, Y);
  // Front wall: shelving, drums in the corner, the compressor and its reel, the extinguisher by the door.
  shelving(k, -3.6, H - 0.32, Math.PI, 2.4, 2);
  shelving(k, -6.8, H - 0.32, Math.PI, 2.4, 3);
  // The gunmetal cab with its top chest and a locker each side, a cart pulled out by it; a blue locker by the drums.
  flagshipCab(k, -0.4, H - 0.33, Math.PI, 1.8, { body: m.gunmetal, fronts: m.drawersGunmetal, accent: m.accentPink, glow: m.glowPink, badge: 2, top: 'chest', lockers: 2, cabinets: 4, cabinetY: 2.6 });
  ragBin(k, 1.25, 10.85);
  plateRow(k, -0.4, 3.35, H, Math.PI);
  cones(k, 2.75, 10.95, 3);
  cleanup(k, 8.25, H - 0.5, Math.PI);
  trashCan(k, -5.2, 10.85);
  wheelBoxes(k, -7.0, 10.55, 3, m.boxKiba);
  k.place(-7.05, 0.9, 10.5, 0.3).box(m.boxHayate, 0.5, 0.36, 0.4, 0, 0.18, 0);
  utilityCart(k, -2.6, 10.85, Math.PI + 0.3, m.red, 1);
  locker(k, -9.0, H - 0.32, Math.PI, 1.0, m.blue);
  drum(k, -10.9, 10.6, m.red);
  drum(k, -10.2, 11.25, m.blue);
  drum(k, -11.2, 11.3, m.red);
  compressor(k, 9.3, H - 0.4, Math.PI);
  for (let i = 0; i < 4; i++) tire(k, 10.7, 0.1 + i * 0.2, 11.2);
  for (let i = 0; i < 3; i++) tire(k, 1.9, 0.1 + i * 0.2, 11.3);
  extinguisher(k, 2.6, H, Math.PI);
  // Right wall: the bench under its tool board and the small sign, a tool cart pulled out, the tire rack, panels.
  workbench(k, H - 0.45, -2.5, -Y, 3.2);
  toolBoard(k, H, 1.95, -2.5, -Y, 3.0, 1.4);
  k.place().plane(m.poster2, 1.0, 1.4, H - 0.02, 2.6, 1.9, -Y);
  toolChest(k, 11.1, 0.7, -Y + 0.35, 1.0, m.blue, m.drawersBlue, false);
  tireRack(k, H - 0.25, 4.4, -Y, 8);
  panels(k, H - 0.45, 8.4, -Y);
  // The tire machines out from the rack, and the big red cab with its hutch and side locker in the back corner, a cart beside it.
  tireChanger(k, 10.1, 3.0, -Y);
  wheelBalancer(k, 10.3, 5.5, -Y);
  flagshipCab(k, H - 0.33, -9.6, -Y, 2.1, { body: m.candyOrange, fronts: m.drawersCandyOrange, accent: m.accentPurple, glow: m.glowPurple, badge: 1, top: 'hutch', lockers: 1, cabinets: 4, cabinetY: 2.95 });
  utilityCart(k, 10.3, -7.1, -Y + 0.25, m.black, 0);
  toolBoard(k, H, 1.55, -7.15, -Y, 1.2, 0.9);
  whiteboard(k, H, 2.45, 8.6, -Y, 1.6, 0.9);
  rollingStool(k, 10.5, -8.9);
  // The dyno's computer beside it.
  alignmentConsole(k, 9.95, 7.4, -Y);
  // Air on a reel over the bench, another between the back lifts and the table, a drop light on a cord over the second lift.
  const chord = ROOM.height - 0.82;
  ceilingReel(k, 8.6, 5.45, 0, chord, m.yellow, [8.8, 2.3, 0.15], 'air');
  ceilingReel(k, -2.5, 5.45, -4.5, chord, m.yellow, [-2.3, 2.3, -4.3], 'air');
  ceilingReel(k, 3.4, 5.45, -9, chord, m.orange, [3.3, 2.5, -8.9], 'lamp');
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
  k.place(l2.x + 2.5, 0, l2.z + 1.7, 0.4);
  carryBox(k, m.red, 0, 0, 0);
  clipboard(k, l2.x + 1.32, 1.45, l2.z + 0.18, 0);
  // The laptop on its stand, wired in through the driver's window, the smoke machine by it.
  const lap: [number, number, number] = [l2.x - 2.0, 1.0, l2.z + 0.9];
  laptopCart(k, lap[0], lap[2], 0);
  smokeMachine(k, lap[0] + 0.6, lap[2] + 0.5, 0.4);
  k.place().hose(
    m.black,
    [
      [lap[0] + 0.2, lap[1] + 0.03, lap[2] + 0.1],
      [lap[0] + 0.45, 0.6, lap[2] - 0.1],
      [l2.x - 1.1, l2.h + 0.5, l2.z - 0.2],
      [l2.x - 0.8, l2.h + 0.9, l2.z - 0.3],
    ],
    0.008,
    32,
  );
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
      [8.9, 0.015, 11.0],
      [6.6, 0.015, 10.95],
      [5.0, 0.015, 9.6],
      [1.0, 0.015, 9.7],
      [-3.0, 0.015, 8.7],
      [-5.5, 0.015, 7.3],
      [-6.3, 0.03, 6.0],
    ],
    0.014,
    80,
  );
  k.place().box(m.black, 0.12, 0.1, 0.28, -6.3, 0.06, 5.75, 0.5);
  // The first lift: a new exhaust laid out under it, a tall stand under the tail.
  const l1 = LIFTS[0];
  underhoistStand(k, l1.x + 0.55, l1.z - 1.5, l1.h + 0.1);
  k.place().bar(m.chrome, [l1.x - 0.3, 0.06, l1.z - 1.9], [l1.x + 0.1, 0.06, l1.z + 1.2], 0.08);
  k.place().cyl(m.chrome, 0.14, 0.6, l1.x + 0.15, 0.14, l1.z + 1.6, 'z', 14);
  // The third: an oil drainer under the engine. The fourth: boxed parts waiting to go in.
  const l3 = LIFTS[2];
  k.place().cyl(m.yellow, 0.22, 0.4, l3.x + 1.4, 0.22, l3.z, 'y', 14);
  k.place().cyl(m.galv, 0.025, 1.0, l3.x + 1.4, 0.9, l3.z, 'y', 8);
  k.place().cyl(m.yellow, 0.3, 0.14, l3.x + 1.4, 1.42, l3.z, 'y', 16, 0.06);
  transmissionJack(k, l3.x + 0.4, l3.z, Y, 1.5);
  clipboard(k, l3.x + 0.18, 1.45, l3.z + 1.3, Y);
  const l4 = LIFTS[3];
  k.place().box(m.boxKurogane, 0.6, 0.4, 0.45, l4.x + 2.6, 0.2, l4.z + 1.9, 0.2);
  k.place().box(m.boxHayate, 0.45, 0.3, 0.4, l4.x + 2.6, 0.55, l4.z + 1.9, 0.5);
  k.place(l4.x + 2.4, 0, l4.z - 2.1, -0.5);
  carryBox(k, m.black, 0, 0, 0);
  // The third lift's cart, pulled up beside the drainer.
  utilityCart(k, l3.x + 2.3, l3.z + 1.2, Y + 0.2, m.blue, 2);
  // The fourth lift: the brake bleeder and a creeper seat by the front wheels.
  brakeBleeder(k, l4.x + 2.9, l4.z + 0.6, 0.3);
  creeperSeat(k, l4.x + 2.9, l4.z - 0.7, 0.6);
  // Exit signs over both doors, the bay numbers painted in front of the lifts, a drain in the floor.
  exitSign(k, 5.5, 4.85, H, Math.PI);
  exitSign(k, 8.6, 4.25, -H, 0);
  LIFTS.forEach((l, i) => (l.z < -5 ? bayNumber(k, l.x, -6.1, 0, i + 1) : bayNumber(k, -6.4, l.z, Y, i + 1)));
  floorDrain(k, 4.8, -2.6);
  // The tuners' banners hung from the trusses in the front half, and one over the bench, clear of the main sign.
  banner(k, -5.5, 4.5, 0, chord, 0);
  banner(k, 5.5, 4.5, 0, chord, 1);
  banner(k, 7.5, -4.5, 0, chord, 2);
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
  return [
    [7.9, -5.0, 1.0, 1.0, 2.2],
    [l3.x + 2.3, l3.z + 1.2, 0.6, 0.6, 1.1],
    [lap[0], lap[2], 0.4, 0.4, 1.3],
    [l4.x + 2.9, l4.z + 0.6, 0.3, 0.3, 1.0],
  ];
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
  const owned = new Disposer();
  const { track } = owned;
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
  owned.dispose();
  return rt;
}

/** The welder's sparks: a few points shaded as hot discs, white at birth cooling to orange as they die. */
function weldSparks(): THREE.Points {
  const n = WELD.count;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('life', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  // Never culled: the bounding sphere would be the arc's point until the first burst flies.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(WELD.x, WELD.y, WELD.z), 4);
  const mat = new THREE.ShaderMaterial({
    uniforms: { size: { value: WELD.size } },
    vertexShader: /* glsl */ `
      attribute float life;
      uniform float size;
      varying float vLife;
      void main() {
        vLife = life;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = life > 0.0 ? size * (0.006 + 0.01 * life) / -mv.z : 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vLife;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.1, length(d)) * vLife;
        vec3 c = mix(vec3(1.0, 0.45, 0.1), vec3(1.0, 0.95, 0.85), vLife * vLife);
        gl_FragColor = vec4(c * a * 2.0, 1.0);
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
