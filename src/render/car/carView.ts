/**
 * Visual car: assembles a car from its base model and equipped parts (or a
 * code-built placeholder when files are missing), applies the visual build,
 * and poses itself from interpolated sim state. Render only.
 */
import * as THREE from 'three';
import { BODY_PART_SLOTS, PartSlot } from '../../shared/parts';
import { GLOW_PATTERNS, STANCE_LIMITS, TireShape, VisualBuild, defaultVisual } from '../../shared/carBuild';
import { CarAssetLibrary, ManifestCar, manifestCar, partById, partsFor } from './carAssets';
import { CarMaterialSet, LAMP_GLOW, applyVisualToMaterials, createCarMaterials, disposeCarMaterials, resolveMaterialName, setBrake } from './carMaterials';
import { makeRadialGlow } from '../textures/textures';
import { DecalLayerView } from './decals';
import { FEATURES } from '../../shared/features';
import { BARREL_MARGIN, WheelProfile, WidthFit, barrelCover, beadForSize, detectFaceFit, detectProfile, faceRange, remapWheel, sizeForBead, spokeBackOf, tirePull } from './wheelFit';
import { BRAKE, brakeDepth, brakeReach, buildCaliperGeometry, buildRotorGeometry } from './brakes';
import { damp } from '../../shared/anim';
import { TIRE_SEGMENTS, latheTire, measureTire } from './tireShapes';
import { PLATE, buildPlateGeometry, createPlateMaterial, drawPlate, plateTexture, seatPlate } from './plate';
import { lugsGeometry } from './lugNuts';
import { maskVehicleMesh, underVehicles } from '../vehicleMask';
import { Disposer } from '../disposer';
import { WheelClip } from './wheelClip';
import type { LampFlares } from './lampFlares';

export interface CarPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  steer: number;
  comp: number[];
  spin: number[];
  braking: boolean;
  nitro: boolean;
  /** The nitrous stage burning (1..3) while nitro is on: the flames grow and run hotter with it (1 when missing). */
  nitroStage?: number;
  speed: number;
}

export const WHEEL_KEYS = ['FL', 'FR', 'RL', 'RR'] as const;
const DEG = Math.PI / 180;
/** Scratch for CarView.update's wheel placement. */
const WHEEL_POS = new THREE.Vector3();
const WHEEL_STEER = new THREE.Quaternion();
/** Scratch for the driving pose alone (the body adds the stance's rake on top; the wheels never take it). */
const POSE_Q = new THREE.Quaternion();
const POSE_E = new THREE.Euler();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** Scratch for the underglow's two colors, set every frame. */
const GLOW_C1 = new THREE.Color();
const GLOW_C2 = new THREE.Color();

/** The glows a car throws on the road (underglow, headlight pool), laid on the ground under its wheels. */
const GROUND_FX = {
  /** Underglow over the ground (m): just above the lane markings (cityMeshes MARK_Y over ROAD_Y), so they light too. */
  glowY: 0.06,
  /** Headlight pool over the ground (m). */
  beamY: 0.07,
  /** The headlight pool's colour (additive, linear-ish): 0x6f7a8a at 0.7 so the road beside the car keeps a falloff instead of a white blob. */
  beamColor: 0x4e5561,
  /**
   * The pool's footprint (m): the cookie (headlightCookie) spans this wide and long from just ahead of the nose,
   * so the lit road ends in the cutoff about 40 m out instead of fading by 20.
   */
  beamWidth: 12,
  beamLength: 44,
  beamStart: -0.5,
  /**
   * Brightest texel of the cookie, as a share of the old radial pool's peak (1, at the 0.7 tuning). Matching the
   * old pool's mean texel (0.144) instead left the pool at 0.44 of that peak, spread over 2.7x the road, and it
   * vanished in the street lighting (A/B on seed 20261019): the peak is what the eye reads, so the hotspots keep
   * the old brightness and the extra light is what lengthens the pool.
   */
  beamPeak: 1,
  /** Wet road: the pool, and the real spots, brighten by this share at full wet (the streaks throw the lamp light back). */
  wetBeam: 0.6,
  wetSpot: 0.25,
  /** Body height over its rest (m) at which the underglow on the road has faded to half: it spreads and dims on a jump. */
  airHalf: 0.5,
} as const;

let glowTex: THREE.Texture | null = null;
const glow = () => (glowTex ??= makeRadialGlow());

/**
 * The headlight cookie: a low beam laid on the road, seen from above. Canvas row 0 is the nose, the last row
 * beamLength m out; column 0 is the car's right. Two hotspots (the lamps) widen with distance over a soft
 * spill, brightest 10..15 m out and falling to about a quarter by the cutoff; the cutoff is a sharp
 * line, stepped as a real low beam's is: the right (kerb) side carries to 41 m, the left to 33 m so it does
 * not dazzle oncoming drivers. Opaque grey (the pool is additive, so grey is brightness), scaled so its brightest texel is GROUND_FX.beamPeak.
 */
const COOKIE = {
  /** Texels across and along. */
  size: [128, 512],
  /** Lamp centre off the car's axis (m) and the hotspot's spread there and its growth per m of distance. */
  lampX: 0.72,
  spread: [0.9, 0.075],
  /** Spill share and its half width (m) at the nose and growth per m. */
  spill: [0.3, 4, 0.04],
  /** Distance of the brightest ground (m): nearer it ramps up as a power of the distance, beyond it falls with this length (m). */
  peak: 12,
  ramp: 0.6,
  fall: 22,
  /** Cutoff distance (m) on the right and the left, the step between them centred on the axis (m), and the edge's softness (m). */
  cutRight: 41,
  cutLeft: 33,
  step: 0.6,
  soft: 0.35,
  /** The bright band hugging the line under the cutoff: gain and its half length (m). */
  band: [0.3, 2.5],
} as const;

/**
 * The player's two real headlight spots, matched to the cookie: cone half angle (rad) about the cookie's width
 * at its hotspot, penumbra (share of the cone that feathers) softening the sides, range (m) ending at the
 * cutoff line, intensity (cd, unchanged from before the cookie) and where on the road the axis lands (m ahead of the nose).
 */
const SPOT = { angle: 0.27, penumbra: 0.7, distance: 46, decay: 1.3, intensity: 90, aim: 12 } as const;

let cookieTex: THREE.Texture | null = null;
function headlightCookie(): THREE.Texture {
  if (cookieTex) return cookieTex;
  const [w, h] = COOKIE.size;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h);
  const sm = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const v = new Float32Array(w * h);
  let peak = 0;
  for (let py = 0; py < h; py++) {
    const d = ((py + 0.5) / h) * GROUND_FX.beamLength + GROUND_FX.beamStart;
    for (let px = 0; px < w; px++) {
      // Canvas left is the car's right (-x in the plane's frame).
      const x = ((px + 0.5) / w - 0.5) * GROUND_FX.beamWidth;
      const cut = COOKIE.cutLeft + (COOKIE.cutRight - COOKIE.cutLeft) * (1 - sm(-COOKIE.step, COOKIE.step, x));
      const sig = COOKIE.spread[0] + COOKIE.spread[1] * Math.max(d, 0);
      const lamp = (xc: number) => Math.exp(-0.5 * ((x - xc) / sig) ** 2);
      const spill = COOKIE.spill[0] * Math.exp(-0.5 * (x / (COOKIE.spill[1] + COOKIE.spill[2] * Math.max(d, 0))) ** 2);
      const lat = Math.min(1, (lamp(COOKIE.lampX) + lamp(-COOKIE.lampX)) * 0.5 + spill);
      const lon = d < COOKIE.peak ? Math.pow(Math.max(d, 0) / COOKIE.peak, COOKIE.ramp) : Math.exp(-(d - COOKIE.peak) / COOKIE.fall);
      const edge = 1 - sm(cut - COOKIE.soft, cut + COOKIE.soft, d);
      const band = 1 + COOKIE.band[0] * Math.exp(-(((d - cut + COOKIE.band[1]) / COOKIE.band[1]) ** 2));
      const val = lat * lon * edge * band;
      v[py * w + px] = val;
      peak = Math.max(peak, val);
    }
  }
  const gain = GROUND_FX.beamPeak / peak;
  for (let i = 0; i < w * h; i++) {
    const b = Math.round(Math.min(1, v[i] * gain) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  cookieTex = t;
  return t;
}

/**
 * Overrun pop flash, each [crackle, bang]: lifetime (s), the orange tongue's length (m) and width (scale), the hot
 * core's share of the tongue, and the muzzle glow's size (m) at the tip; `flicker` jitters the length per frame.
 */
const POP_FLASH = {
  life: [0.07, 0.18],
  length: [0.45, 1.6],
  width: [0.8, 1.9],
  core: 0.55,
  glow: [0.35, 1.1],
  flicker: 0.35,
  color: new THREE.Color(0xff7a1f).multiplyScalar(3.5),
  coreColor: new THREE.Color(0xfff0c0).multiplyScalar(4),
  glowColor: new THREE.Color(0xff8a2a).multiplyScalar(2.2),
} as const;
/** Where the flames sit without measured tips (car space, m): a tip each side this far out and up, at the tail. */
const DEFAULT_TIP = { x: 0.38, y: 0.32 } as const;
/**
 * Nitrous flames per stage (1..3): the additive HDR color, from the stock
 * blue through violet to a hot pink (the HUD bar's stage colors, run hot so
 * they bloom), and the cone's width and length scale.
 */
const NITRO_FLAME = {
  color: [new THREE.Color(0x4fa8ff).multiplyScalar(3), new THREE.Color(0x9b6dff).multiplyScalar(3.2), new THREE.Color(0xff4fae).multiplyScalar(3.4)],
  width: [1, 1.12, 1.25],
  length: [1, 1.3, 1.6],
} as const;

export class CarView {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly model = new THREE.Group();
  readonly materials: CarMaterialSet;
  readonly car: ManifestCar;
  private wheelPivots: THREE.Group[] = [];
  private wheelSpins: THREE.Group[] = [];
  /** Per wheel, under the pivot beside the spin group: steers and cambers with the wheel but never spins (the caliper's frame). */
  private wheelHubs: THREE.Group[] = [];
  /** The brake unit behind each wheel (brakes.ts), null until its axle is baked or when brakes are off. */
  private brakes: ({ rotor: THREE.Mesh; caliper: THREE.Mesh } | null)[] = [null, null, null, null];
  private readonly brakesOn: boolean;
  /** The four wheels' holders (FL, FR, RL, RR), null until their axle is baked. */
  private wheelModels: (THREE.Object3D | null)[] = [null, null, null, null];
  /** Baked wheel meshes per axle (front, rear); the two wheels of an axle share geometry. */
  private axleMeshes: THREE.Mesh[][] = [[], []];
  /** Per axle, the size and width the meshes are remapped for (NaN until the first remap), so an unchanged slider costs nothing. */
  private axleSize = [NaN, NaN];
  private axleWidth = [NaN, NaN];
  /**
   * Per axle, where the wheel's depth lies along the axle (baked wheel space, m; +X outboard): the back of its
   * spokes (the brake sits behind it, and the width slider only lengthens what is behind it), the barrel's back
   * edge and the tire's extent.
   */
  private widthFit: WidthFit[] = [
    { spokeBack: 0, back: 0, tireMin: 0, tireMax: 0, tirePull: 0, cover: 1, face: { back: 0, front: 0, lipEdge: 0, barrelBack: 0 }, shift: 0 },
    { spokeBack: 0, back: 0, tireMin: 0, tireMax: 0, tirePull: 0, cover: 1, face: { back: 0, front: 0, lipEdge: 0, barrelBack: 0 }, shift: 0 },
  ];
  /** Each axle's wheel profile: front and rear may wear different wheels. */
  private wheelProfiles: WheelProfile[] = [
    { outer: 1, bead: 0.75 },
    { outer: 1, bead: 0.75 },
  ];
  /** What each axle wears ("wheel id:tire shape"), so an unchanged axle is not baked again. */
  private axleWear = ['', ''];
  /** The stance's ride height over each axle (front, rear; m), and the rake they give the body (rad about x). */
  private axleLift = [0, 0];
  private rake = 0;
  private slotObjects = new Map<PartSlot, THREE.Object3D>();
  private baseModel: THREE.Object3D | null = null;
  private placeholder = false;
  private visual: VisualBuild = defaultVisual();
  private headlights: THREE.SpotLight[] = [];
  private underglow: THREE.Mesh;
  private underglowMat: THREE.ShaderMaterial;
  private underglowLight: THREE.PointLight | null = null;
  /** Underglow and headlight pool, posed on the road plane through the four wheels' contact points. */
  private readonly groundFx = new THREE.Group();
  /** Underglow brightness left after the body's height over the road (1 on the ground). */
  private airFade = 1;
  private readonly roadLift: number;
  /** The exhaust tips in car space (x, y, z; m), left to right: where CarView's flames sit and ExhaustFx's start. */
  readonly tips: [number, number, number][] = [];
  /** Nitrous flames, one per exhaust tip. */
  private flames: THREE.Mesh[] = [];
  /** Overrun pop flames per exhaust tip (the tongue, its hot core, the muzzle glow), the pipe each tip belongs to (0 or 1), when each starts and how big it is (1 bang, 0 crackle). */
  private pops: { tongue: THREE.Mesh; core: THREE.Mesh; glow: THREE.Sprite }[] = [];
  private tipPipe: number[] = [];
  private popAt: number[] = [];
  private popSize: number[] = [];
  private lastTime = 0;
  /** Rotor heat, 0 cold to 1 glowing: builds under braking and fades quickly once off the brakes (BRAKE.heatUp / coolDown). */
  private rotorHeat = 0;
  /** How lit the lamp lenses are (1 the night street's full glow; the garage parks the car lower). */
  private lampLevel = 1;
  /** The painted surfaces' environment reflections, 1 full (the garage turns them down with its lights). */
  private envScale = 1;
  private beam: THREE.Mesh;
  /** The pool's colour before the wet road or the flash scale it. */
  private readonly beamBase = new THREE.Color();
  /** How wet the road reads 0..1 (the weather's), and the horn's flash level 0..1: both scale the pool and the spots. */
  private wet = 0;
  private flash = 0;
  /** The spots' own intensity and range (they differ per tier). */
  private spotBase: { intensity: number; distance: number }[] = [];
  /** The rear license plate (plate.ts), seated on the bumper after every load; null headless or when opted out. */
  private plate: THREE.Mesh | null = null;
  private plateTex: THREE.CanvasTexture | null = null;
  readonly decals: DecalLayerView;
  private loadToken = 0;
  /** The car's own effect materials (underglow, headlight pool, flames, pops); the shared car materials go with disposeCarMaterials. */
  private readonly owned = new Disposer();
  /** Hides whatever part of a wheel comes up through the body (wheelClip.ts), measured whenever the body's parts change. */
  private readonly clip: WheelClip;
  /** The parts the clip last measured ("" before the first measure). */
  private clipParts = '';
  /** The wheels' own copies of body materials they share (Chrome, Black...), so the clip never reaches the body. */
  private readonly wheelCopies = new Map<THREE.Material, THREE.Material>();
  /** The wheel paints (face, lip and center cap, each axle's own) that the clip is already on, so a wheel mesh wears them as they are. */
  private readonly paintedWheelMats: Set<THREE.Material>;

  constructor(
    carId: string,
    private readonly assets: CarAssetLibrary,
    /**
     * roadLift: how far the drawn road surface is above the sim's ground (m, cityMeshes ROAD_Y).
     * The sim rests the tires on the ground; on the city's asphalt they would sink that far into it.
     * 0 (the garage floor) by default.
     */
    opts: { headlights?: number; underglowLight?: boolean; envMap?: THREE.Texture | null; roadLift?: number; brakes?: boolean; plate?: string | null; tread?: boolean } = {},
  ) {
    this.materials = createCarMaterials(opts.envMap ?? null, opts.tread ?? true);
    const m = this.materials;
    this.paintedWheelMats = new Set([m.Rim, m.RimRear, m.RimLip, m.RimLipRear, m.RimCap, m.RimCapRear, m.Lug, m.LugRear, m.Hardware, m.HardwareRear]);
    this.car = manifestCar(carId);
    this.roadLift = opts.roadLift ?? 0;
    this.brakesOn = opts.brakes ?? true;
    this.root.name = `car:${carId}`;
    this.root.add(this.body, this.groundFx);
    this.body.add(this.model);
    const dims = this.car.dimensions;

    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      const hub = new THREE.Group();
      pivot.add(spin, hub);
      this.root.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpins.push(spin);
      this.wheelHubs.push(hub);
    }

    const { track } = this.owned;
    this.clip = track(new WheelClip(this.car, this.body));
    // Tire and wheel paints are the wheels' alone; the clip goes straight on them.
    this.clip.clipMaterial(this.materials.Tire, true);
    // The lip ring is only the bulb's visible shell (scripts/blender/carWheels.py turns it from the lip edge back to
    // the face), and a stretched tire's bead sits behind the bulb (tireShapes.ts), so the ring is drawn both sides
    // or its far side is see-through where its inside shows.
    this.materials.RimLip.side = THREE.DoubleSide;
    this.materials.RimLipRear.side = THREE.DoubleSide;
    for (const m of [this.materials.Rim, this.materials.RimRear, this.materials.RimLip, this.materials.RimLipRear, this.materials.RimCap, this.materials.RimCapRear, this.materials.Lug, this.materials.LugRear, this.materials.Hardware, this.materials.HardwareRear]) this.clip.clipMaterial(m);
    // Underglow: a shader glow on the road around the footprint, plus an optional real light.
    this.underglowMat = track(new THREE.ShaderMaterial({
      uniforms: {
        color1: { value: new THREE.Color(0x00e5ff) },
        color2: { value: new THREE.Color(0xff3df2) },
        intensity: { value: 1 },
        mode: { value: 0 },
        time: { value: 0 },
        halfSize: { value: new THREE.Vector2(dims.width / 2, dims.length / 2) },
        planeHalf: { value: new THREE.Vector2(dims.width * 1.3, dims.length * 0.95) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vPos;
        void main() {
          vPos = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 color1;
        uniform vec3 color2;
        uniform float intensity;
        uniform float mode;
        uniform float time;
        uniform vec2 halfSize;
        uniform vec2 planeHalf;
        varying vec2 vPos;
        void main() {
          // Distance from the car's rounded footprint: brightest at the sills, fading outward.
          vec2 q = abs(vPos) - halfSize * 0.82;
          float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
          float glow = exp(-max(d, 0.0) * 2.8) * smoothstep(-0.9, 0.05, d);
          // Fade out well before the plane's border so no edge ever shows.
          vec2 e = abs(vPos) / planeHalf;
          glow *= 1.0 - smoothstep(0.6, 0.98, max(e.x, e.y));
          vec3 c = color1;
          if (mode > 3.5 && mode < 4.5) {
            // alternate: whole car switches between the two colors
            c = mix(color1, color2, step(0.5, fract(time * 0.5)));
          } else if (mode > 5.5) {
            // chase: the two colors run around the car
            float a = atan(vPos.x, vPos.y) / 6.2831853 + 0.5;
            c = mix(color1, color2, smoothstep(0.35, 0.65, fract(a * 2.0 - time * 0.6)));
          }
          gl_FragColor = vec4(c * glow * intensity, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    underVehicles(this.underglowMat);
    this.underglow = new THREE.Mesh(new THREE.PlaneGeometry(dims.width * 2.6, dims.length * 1.9).rotateX(-Math.PI / 2), this.underglowMat);
    this.underglow.position.y = GROUND_FX.glowY;
    this.underglow.visible = false;
    this.underglow.renderOrder = 3;
    this.groundFx.add(this.underglow);
    if (opts.underglowLight) {
      this.underglowLight = new THREE.PointLight(0x00e5ff, 0, 6, 1.5);
      this.underglowLight.position.set(0, 0.25, 0);
      this.root.add(this.underglowLight);
    }

    // Headlight beams: the cookie's pool on the road ahead (cheap, every car), plus real spots for the player.
    const beamMat = track(new THREE.MeshBasicMaterial({ map: headlightCookie(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: GROUND_FX.beamColor }));
    underVehicles(beamMat);
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_FX.beamWidth, GROUND_FX.beamLength).rotateX(-Math.PI / 2).translate(0, GROUND_FX.beamY, dims.length / 2 + GROUND_FX.beamStart + GROUND_FX.beamLength / 2), beamMat);
    this.beam.renderOrder = 3;
    this.groundFx.add(this.beam);
    this.beamBase.copy(beamMat.color);
    // Spots shaped to the cookie: the cone is only as wide as the pool (a few degrees past the hotspots' spread at
    // 15 m), aimed at the hotspot 12 m out and cut off by its range at the cutoff line. One spot (the Low tier)
    // sits between the lamps with a wider cone, so its pool covers what the pair's would.
    const spots = opts.headlights ?? 0;
    if (spots > 0) {
      for (const side of spots === 1 ? [0] : [1, -1]) {
        const spot = new THREE.SpotLight(0xeaf2ff, SPOT.intensity, SPOT.distance, spots === 1 ? SPOT.angle * 1.35 : SPOT.angle, SPOT.penumbra, SPOT.decay);
        spot.position.set(side * dims.width * 0.32, 0.7, dims.length / 2 - 0.2);
        spot.target.position.set(side * 0.5, 0, dims.length / 2 + SPOT.aim);
        this.root.add(spot, spot.target);
        this.headlights.push(spot);
        this.spotBase.push({ intensity: spot.intensity, distance: spot.distance });
      }
    }

    // Nitrous exhaust flames, and the flash of an overrun pop, at each exhaust tip. On the body, so they ride with
    // its height and rake. Tips sorted left to right: on a twin pipe car the left half is pipe 0, the right pipe 1
    // (two tips on one side split outer and inner).
    const flameGeo = track(new THREE.ConeGeometry(0.11, 0.9, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.45));
    const tips = (this.car.exhaustTips ?? [[DEFAULT_TIP.x, DEFAULT_TIP.y, -dims.length / 2 + 0.05], [-DEFAULT_TIP.x, DEFAULT_TIP.y, -dims.length / 2 + 0.05]]).slice().sort((a, b) => b[0] - a[0]);
    this.tips.push(...tips);
    const additive = { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } as const;
    for (const [i, [x, y, z]] of tips.entries()) {
      const flame = new THREE.Mesh(flameGeo, track(new THREE.MeshBasicMaterial({ color: NITRO_FLAME.color[0].clone(), opacity: 0.85, ...additive })));
      flame.position.set(x, y, z);
      flame.visible = false;
      this.body.add(flame);
      this.flames.push(flame);
      const tongue = new THREE.Mesh(flameGeo, track(new THREE.MeshBasicMaterial({ color: POP_FLASH.color, opacity: 0.9, ...additive })));
      const core = new THREE.Mesh(flameGeo, track(new THREE.MeshBasicMaterial({ color: POP_FLASH.coreColor, opacity: 1, ...additive })));
      const muzzle = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glow(), color: POP_FLASH.glowColor, ...additive })));
      for (const o of [tongue, core, muzzle]) {
        o.position.set(x, y, z);
        o.visible = false;
        this.body.add(o);
      }
      this.pops.push({ tongue, core, glow: muzzle });
      this.tipPipe.push(i < tips.length / 2 ? 0 : 1);
      this.popAt.push(-1);
      this.popSize.push(0);
    }

    // The rear plate: drawn once, seated on the bumper once the body and its parts are in (applyVisual).
    if (FEATURES.plates && opts.plate !== null) {
      this.plateTex = plateTexture(opts.plate ?? PLATE.defaultText);
      if (this.plateTex) {
        track(this.plateTex);
        this.plate = new THREE.Mesh(buildPlateGeometry(), track(createPlateMaterial(this.plateTex, opts.envMap ?? null)));
        this.plate.name = 'Plate';
        this.plate.visible = false;
        maskVehicleMesh(this.plate);
        this.model.add(this.plate);
      }
    }

    this.decals = new DecalLayerView(this);
  }

  /** Redraw the rear plate for a registration (the player's name). */
  setPlate(text: string): void {
    if (this.plateTex) drawPlate(this.plateTex, text);
  }

  /** Seat the plate on whatever bumper the car wears now: after the body loads and after every rear bumper swap. */
  private seatPlate(): void {
    const plate = this.plate;
    if (!plate) return;
    plate.visible = false;
    const seat = seatPlate(this.model, this.materials, this.car.dimensions.length, plate);
    plate.position.copy(seat.position).addScaledVector(seat.normal, PLATE.proud);
    // The face follows the bumper's tilt: pitch only, the seat is on the centre line.
    plate.rotation.set(Math.atan2(seat.normal.y, -seat.normal.z), 0, 0);
    plate.visible = true;
  }

  get isPlaceholder(): boolean {
    return this.placeholder;
  }

  /** Load base model and all parts for a visual build. Safe to call repeatedly. */
  async load(visual: VisualBuild): Promise<void> {
    const token = ++this.loadToken;
    if (!this.baseModel) {
      const m = await this.assets.carModel(this.car.id);
      if (token !== this.loadToken) return;
      if (m) {
        this.baseModel = m;
        this.placeholder = false;
      } else {
        this.baseModel = buildPlaceholderCar(this.car);
        this.placeholder = true;
      }
      this.bindMaterials(this.baseModel);
      for (const name of this.car.wheelNodes) {
        const n = this.baseModel.getObjectByName(name);
        if (n) n.visible = false;
      }
      this.model.add(this.baseModel);
    }
    await this.applyVisual(visual, token);
  }

  /** The loaded build's pops & bangs multiple (1 stock): what the exhaust effects and the engine voice scale their backfires by. */
  get popRate(): number {
    return this.visual.popsBangs ?? 1;
  }

  /** Apply a visual build. Part swaps load asynchronously; everything else is instant. */
  async applyVisual(v: VisualBuild, token = ++this.loadToken): Promise<void> {
    this.visual = v;
    applyVisualToMaterials(this.materials, v, this.stockLips(), false, this.envScale);
    this.applyStance();
    this.applyUnderglow(0);

    // Parts per slot.
    for (const slot of [...BODY_PART_SLOTS, 'body' as PartSlot]) {
      const wanted = v.parts[slot] ?? null;
      const current = this.slotObjects.get(slot);
      if ((current?.userData.partId ?? null) === wanted) continue;
      let obj: THREE.Object3D | null = null;
      if (wanted) {
        const entry = partById(wanted) ?? this.devEntry(wanted);
        if (entry) obj = await this.assets.part(entry);
        if (token !== this.loadToken) return;
        if (!obj && this.placeholder) obj = buildPlaceholderPart(this.car, slot, wanted);
        if (obj) {
          obj.userData.partId = wanted;
          this.bindMaterials(obj);
        }
      }
      if (current) {
        this.model.remove(current);
      }
      if (obj) {
        this.model.add(obj);
        this.slotObjects.set(slot, obj);
      } else {
        this.slotObjects.delete(slot);
      }
    }
    this.updateHiddenBaseMeshes();
    this.seatPlate();
    const parts = [...BODY_PART_SLOTS, 'body' as PartSlot].map((slot) => v.parts[slot] ?? '').join('|');
    if (parts !== this.clipParts) {
      this.clipParts = parts;
      const glass = this.materials.Glass;
      const shared = new Set<THREE.Material>(Object.values(this.materials));
      this.clip.measure((mesh) => {
        if (!visibleInTree(mesh, this.body)) return false;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        return mats.every((m) => shared.has(m) && m !== glass);
      });
    }
    for (const [src, copy] of this.wheelCopies) {
      // Trim follows the build's trim color; the rest of what the copies share never changes.
      const color = (src as THREE.MeshStandardMaterial).color;
      if (color) (copy as THREE.MeshStandardMaterial).color.copy(color);
    }

    // Wheels, per axle: the rear wears the front's wheel unless it has one of its own.
    const frontWheel = v.parts.wheels ?? this.car.defaultWheel;
    const wear: [string, TireShape][] = [
      [frontWheel, v.wheels.tire],
      [v.wheels.rearPart ?? frontWheel, v.wheels.rearTire],
    ];
    for (const axle of [0, 1] as const) {
      const [wheelId, tire] = wear[axle];
      if (this.axleWear[axle] === `${wheelId}:${tire}`) continue;
      const entry = partById(wheelId) ?? partsFor(this.car.id, 'wheels')[0] ?? this.devEntry(wheelId);
      let model: THREE.Object3D | null = entry ? await this.assets.part(entry) : null;
      if (token !== this.loadToken) return;
      if (!model) model = buildPlaceholderWheel(wheelId);
      model.userData.partId = wheelId;
      this.bindMaterials(model);
      this.bakeAxle(axle, model, tire);
      this.axleWear[axle] = `${wheelId}:${tire}`;
    }
    this.applyStance();
    this.decals.rebuild(FEATURES.vinyls ? v.decals : []);
  }

  private devEntry(id: string) {
    const dev = this.assets.devParts.get(id);
    if (!dev) return undefined;
    return { id, displayName: dev.name, carId: this.car.id, slot: dev.slot, file: '', hides: [], materialSlots: [], tris: 0 };
  }

  private updateHiddenBaseMeshes(): void {
    if (!this.baseModel) return;
    const hidden = new Set<string>();
    for (const [, obj] of this.slotObjects) {
      const entry = partById(obj.userData.partId as string);
      for (const h of entry?.hides ?? []) hidden.add(h);
      for (const h of (obj.userData.hides as string[] | undefined) ?? []) hidden.add(h);
    }
    this.baseModel.traverse((o) => {
      if (o === this.baseModel) return;
      if (this.car.wheelNodes.includes(o.name)) return;
      if (o.userData.__baseVisible === undefined) o.userData.__baseVisible = o.visible;
      o.visible = hidden.has(o.name) ? false : (o.userData.__baseVisible as boolean);
    });
  }

  /** Mark base meshes hidden for a dev-dropped part. */
  setDevHides(slot: PartSlot, hides: string[]): void {
    const obj = this.slotObjects.get(slot);
    if (obj) obj.userData.hides = hides;
    this.updateHiddenBaseMeshes();
  }

  /** Base model mesh names (for the dev preview "hides" picker). */
  baseMeshNames(): string[] {
    const names: string[] = [];
    this.baseModel?.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name) names.push(o.name);
    });
    return names;
  }

  /** Meshes the decal projector may hit: everything painted. */
  paintMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !visibleInTree(mesh, this.model)) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.includes(this.materials.Paint)) out.push(mesh);
    });
    return out;
  }

  /**
   * Bake one axle's wheel into flat wheel space meshes (center at the origin,
   * axle along X), its own copy so front and rear wheels, tires and sizes can
   * differ, swap in the tire shape (tireShapes.ts) and find where the tire
   * meets the wheel (see wheelFit.ts).
   */
  private bakeAxle(axle: 0 | 1, model: THREE.Object3D, tire: TireShape): void {
    for (const i of [axle * 2, axle * 2 + 1]) {
      const old = this.wheelModels[i];
      old?.parent?.remove(old);
    }
    for (const m of this.axleMeshes[axle]) m.geometry.dispose();
    this.axleMeshes[axle] = [];
    this.axleSize[axle] = NaN;
    this.axleWidth[axle] = NaN;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const toWheel = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    const baked = new THREE.Group();
    const tireR: number[] = [];
    const otherR: number[] = [];
    const otherX: number[] = [];
    // The face (everything but tire and lip ring) and the ring apart, for where the offset shift acts.
    const faceX: number[] = [];
    const faceR: number[] = [];
    const ringX: number[] = [];
    let tireMin = Infinity;
    let tireMax = -Infinity;
    // The lathed tire's half section, which the tire's back is fitted to the barrel by (tirePull).
    let tireProfile: [number, number][] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !visibleInTree(mesh, model)) return;
      let geo = mesh.geometry.clone();
      // Part GLBs are Meshopt compressed: position and normal arrive as interleaved,
      // normalized Int16 attributes. Unpack them to plain floats so they can be baked
      // and remapped in place (writing floats into the int arrays zeroed the normals,
      // which turned wheels black whatever their color).
      for (const name of ['position', 'normal']) {
        const a = geo.getAttribute(name);
        if (!a) continue;
        const f = new Float32Array(a.count * 3);
        for (let k = 0; k < a.count; k++) {
          f[k * 3] = a.getX(k);
          f[k * 3 + 1] = a.getY(k);
          f[k * 3 + 2] = a.getZ(k);
        }
        geo.setAttribute(name, new THREE.BufferAttribute(f, 3));
      }
      geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toWheel, mesh.matrixWorld));
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const isTire = mats.length > 0 && mats.every((m) => m === this.materials.Tire);
      // Every tire is lathed where the wheel's own sat (tireShapes.ts), the standard one too, so they share UVs and
      // the tread texture; not on the placeholder, whose tire has no sidewall.
      const fit = isTire && !model.userData.ownGeometry ? measureTire(geo.getAttribute('position').array) : null;
      if (fit) {
        const t = latheTire(tire, fit);
        tireProfile = t.profile;
        geo.dispose();
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(t.position, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(t.uv, 2));
        geo.setIndex(new THREE.BufferAttribute(t.index, 1));
      }
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      // Keep the unscaled shape; every size change remaps from it.
      geo.userData.basePos = Float32Array.from(pos.array as ArrayLike<number>);
      geo.userData.baseNrm = nrm ? Float32Array.from(nrm.array as ArrayLike<number>) : null;
      geo.userData.isTire = isTire;
      const radii = isTire ? tireR : otherR;
      const isRing = !isTire && mats.length > 0 && mats.every((m) => m === this.materials.RimLip);
      for (let k = 0; k < pos.count; k++) {
        const r = Math.hypot(pos.getY(k), pos.getZ(k));
        radii.push(r);
        if (!isTire) {
          otherX.push(pos.getX(k));
          if (isRing) ringX.push(pos.getX(k));
          else faceX.push(pos.getX(k)), faceR.push(r);
        } else {
          tireMin = Math.min(tireMin, pos.getX(k));
          tireMax = Math.max(tireMax, pos.getX(k));
        }
      }
      // The rear axle wears its own wheel material (wheel color); everything wears a clipped material.
      const own = axle === 1 ? this.rearWheelMat : this.frontWheelMat;
      const material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
      const out = new THREE.Mesh(geo, material);
      out.name = mesh.name;
      maskVehicleMesh(out);
      baked.add(out);
    });
    // The house lug nuts: one more mesh on the face, baked and remapped like the wheel's own, but left out of the
    // profile and spoke measurements below (they sit in front of the spokes' back, so the width remap spares them).
    const lugs = partById(model.userData.partId as string)?.lugs;
    if (lugs) {
      const geo = lugsGeometry(lugs);
      geo.applyMatrix4(toWheel);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
      geo.userData.basePos = Float32Array.from(pos.array as ArrayLike<number>);
      geo.userData.baseNrm = Float32Array.from(nrm.array as ArrayLike<number>);
      geo.userData.isTire = false;
      // The nuts sit on the face, so the offset shift carries them whole.
      geo.userData.rigid = true;
      const out = new THREE.Mesh(geo, axle === 1 ? this.materials.LugRear : this.materials.Lug);
      out.name = 'Lug';
      maskVehicleMesh(out);
      baked.add(out);
    }
    const profile = detectProfile(tireR, otherR);
    this.wheelProfiles[axle] = profile;
    // The spokes' back: the innermost point of the spoke zone (between the center bore, which can run
    // deeper and sits inside the hat anyway, and the barrel with its lip).
    let back = Infinity;
    // The barrel's back edge: the rearmost vertex out where the barrel and lip are (the hub bore reaches deeper).
    let rearmost = Infinity;
    for (let k = 0; k < otherR.length; k++) {
      const r = otherR[k] / profile.bead;
      if (r > 0.3 && r < 0.75) back = Math.min(back, otherX[k]);
      else if (r >= 0.75) rearmost = Math.min(rearmost, otherX[k]);
    }
    const spokeBack = Number.isFinite(back) ? back : 0;
    const barrelBack = Math.min(spokeBack, Number.isFinite(rearmost) ? rearmost : spokeBack);
    // The offset shift: a multi-piece wheel's face goes from its stock offset to the car's target for this axle,
    // plus the wheel's own bias (a one-piece or a wheel shipped as modelled moves by its bias alone), as far as its
    // lip and barrel allow. The catalog's offset is in the GLB's frame, so it moves with the bake's centering; the
    // target and the bias are mm on the car, so they come back through the wheel's scale.
    const face = detectFaceFit(faceX, faceR, ringX, profile.bead);
    const part = partById(model.userData.partId as string);
    const target = this.car.targetOffset?.[axle === 0 ? 'front' : 'rear'];
    const scale = this.car.wheelRadius / (profile.outer || this.car.wheelRadius);
    let shift = (part?.offsetBias ?? 0) / 1000 / scale;
    if (part?.construction === 'multi' && part.offset !== undefined && target !== undefined) shift += target / 1000 / scale - (part.offset - center.x);
    if (shift !== 0) {
      const [lo, hi] = faceRange(face);
      shift = Math.min(hi, Math.max(lo, shift));
    }
    this.widthFit[axle] = {
      spokeBack,
      back: barrelBack,
      tireMin: Number.isFinite(tireMin) ? tireMin : 0,
      tireMax: Number.isFinite(tireMax) ? tireMax : 0,
      tirePull: tirePull(tireProfile, otherX, otherR, barrelBack, TIRE_SEGMENTS),
      cover: 1,
      face,
      shift,
    };
    if (model.userData.ownGeometry) model.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.axleMeshes[axle] = baked.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
    const baseScale = this.car.wheelRadius / (profile.outer || this.car.wheelRadius);
    for (const i of [axle * 2, axle * 2 + 1]) {
      const holder = new THREE.Group();
      // Mesh clones share geometry, so both wheels of an axle follow one remap.
      holder.add(i % 2 === 0 ? baked : baked.clone(true));
      holder.userData.baseScale = baseScale;
      this.wheelSpins[i].add(holder);
      this.wheelModels[i] = holder;
      holder.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) this.clip.watch(o as THREE.Mesh, profile.outer);
      });
    }
    this.bakeBrakes(axle);
  }

  /**
   * Build the axle's brake units: the rotor spins with the wheel, the caliper sits still on the hub. Both
   * wheels share the rotor; each side has its own caliper, the right's logo mapped to read true through
   * the mirroring.
   */
  private bakeBrakes(axle: 0 | 1): void {
    if (!this.brakesOn) return;
    const rotorGeo = buildRotorGeometry(axle);
    for (const i of [axle * 2, axle * 2 + 1]) {
      const caliperGeo = buildCaliperGeometry(axle, this.car.wheels[WHEEL_KEYS[i]][0] <= 0);
      const old = this.brakes[i];
      if (old) {
        old.rotor.removeFromParent();
        old.caliper.removeFromParent();
        old.rotor.geometry.dispose();
        old.caliper.geometry.dispose();
      }
      const rotor = new THREE.Mesh(rotorGeo, this.materials.Rotor);
      rotor.name = 'Rotor';
      const caliper = new THREE.Mesh(caliperGeo, this.materials.Caliper);
      caliper.name = 'Caliper';
      maskVehicleMesh(rotor);
      maskVehicleMesh(caliper);
      this.wheelSpins[i].add(rotor);
      this.wheelHubs[i].add(caliper);
      this.brakes[i] = { rotor, caliper };
    }
  }

  /** A wheel mesh's material: the tire and wheel paints as they are, a clipped copy of anything the body also wears. */
  private readonly wheelMat = (m: THREE.Material): THREE.Material => {
    if (m === this.materials.Tire || this.paintedWheelMats.has(m)) return m;
    let copy = this.wheelCopies.get(m);
    if (!copy) {
      copy = this.owned.track(m.clone());
      this.clip.clipMaterial(copy);
      this.wheelCopies.set(m, copy);
    }
    return copy;
  };
  private readonly frontWheelMat = (m: THREE.Material) => this.wheelMat(m === this.materials.Chrome ? this.materials.Hardware : m);
  private readonly rearWheelMat = (m: THREE.Material) => this.wheelMat(m === this.materials.Chrome ? this.materials.HardwareRear : m === this.materials.Rim ? this.materials.RimRear : m === this.materials.RimLip ? this.materials.RimLipRear : m === this.materials.RimCap ? this.materials.RimCapRear : m);

  /** Remap one axle's wheel meshes for a wheel size (tire outer diameter stays) and a width (only the barrel behind the spokes grows). */
  private applyWheelSize(axle: 0 | 1, size: number, width: number): void {
    if (this.axleSize[axle] === size && this.axleWidth[axle] === width) return;
    this.axleSize[axle] = size;
    this.axleWidth[axle] = width;
    // The brake is fixed by the spokes and scales with the bead, so the barrel's minimum depth follows the size:
    // its rearmost point (rotor back or caliper housing) plus a margin must stay inside the barrel.
    const fit = this.widthFit[axle];
    const profile = this.wheelProfiles[axle];
    const sc = this.car.wheelRadius / (profile.outer || this.car.wheelRadius);
    const k = (sc * beadForSize(profile, size)) / BRAKE.refBead;
    fit.cover = barrelCover(spokeBackOf(fit), fit.back, (BRAKE.clearance + k * (brakeReach(axle) + brakeDepth(axle)) + BARREL_MARGIN) / sc);
    for (const mesh of this.axleMeshes[axle]) {
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      remapWheel(geo.userData.basePos as Float32Array, (geo.userData.baseNrm as Float32Array | null) ?? null, pos.array as Float32Array, nrm ? (nrm.array as Float32Array) : null, this.wheelProfiles[axle], size, width, this.widthFit[axle], geo.userData.isTire === true, geo.userData.rigid === true);
      pos.needsUpdate = true;
      if (nrm) nrm.needsUpdate = true;
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
    }
  }

  /** Wheel diameter in inches for a size factor on this car and one axle's wheel (for the garage readout). */
  wheelInches(size: number, axle: 0 | 1 = 0): number {
    const p = this.wheelProfiles[axle];
    const scale = this.car.wheelRadius / (p.outer || 1);
    return (2 * beadForSize(p, size) * scale) / 0.0254;
  }

  /** Inverse of wheelInches: the wheel size that gives this wheel diameter (in) on this car and one axle's wheel. */
  wheelSizeForInches(inches: number, axle: 0 | 1 = 0): number {
    const p = this.wheelProfiles[axle];
    const scale = this.car.wheelRadius / (p.outer || 1);
    return sizeForBead(p, (inches * 0.0254) / 2 / scale);
  }

  /**
   * Wheel width in inches for a width factor on this car and one axle's wheel (for the garage readout): the lip's
   * edge to the barrel's back, the barrel behind the moved spokes stretched by the factor (the brake cover's floor
   * is not counted: the readout is what the slider asks for). A wheel without a lip ring reads its tire's width.
   */
  wheelWidthInches(width: number, axle: 0 | 1 = 0): number {
    const fit = this.widthFit[axle];
    const scale = this.car.wheelRadius / (this.wheelProfiles[axle].outer || 1);
    const { lipEdge, barrelBack } = fit.face;
    const sb = spokeBackOf(fit);
    const w = lipEdge === 0 && barrelBack === 0 ? fit.tireMax - fit.tireMin : lipEdge - sb + (sb - fit.back) * width;
    return (w * scale) / 0.0254;
  }

  /** Inverse of wheelWidthInches: the width factor that gives this wheel width (in) on this car and one axle's wheel (clamped to the slider range). */
  wheelWidthForInches(inches: number, axle: 0 | 1 = 0): number {
    const fit = this.widthFit[axle];
    const scale = this.car.wheelRadius / (this.wheelProfiles[axle].outer || 1);
    const sb = spokeBackOf(fit);
    const barrel = sb - fit.back;
    const [lo, hi] = STANCE_LIMITS.wheelWidth;
    if (barrel <= 0) return 1;
    const w = ((inches * 0.0254) / scale - (fit.face.lipEdge - sb)) / barrel;
    return Math.max(lo, Math.min(hi, w));
  }

  /** True once both axles are baked, so wheelInches measures the real profiles rather than the placeholder one. */
  get wheelsReady(): boolean {
    return this.wheelModels.every(Boolean);
  }

  private applyStance(): void {
    const v = this.visual;
    const s = v.stance;
    // Front and rear heights set a line along the car: the body sits where it crosses the body's origin and
    // pitches along it, so each axle's arch drops by its own height. The wheels stay where they stand.
    const zf = this.car.wheels.FL[2];
    const zr = this.car.wheels.RL[2];
    this.axleLift = [s.front.rideHeight, s.rear.rideHeight];
    this.rake = Math.asin((s.front.rideHeight - s.rear.rideHeight) / (zr - zf || 1));
    this.body.position.y = s.front.rideHeight + zf * Math.sin(this.rake);
    this.body.rotation.x = this.rake;
    this.applyWheelSize(0, s.front.wheelSize, s.front.wheelWidth);
    this.applyWheelSize(1, s.rear.wheelSize, s.rear.wheelWidth);
    for (let i = 0; i < 4; i++) {
      const p = this.car.wheels[WHEEL_KEYS[i]];
      const left = p[0] > 0;
      const axle = i < 2 ? s.front : s.rear;
      const pivot = this.wheelPivots[i];
      pivot.userData.restX = p[0] + (left ? axle.offset : -axle.offset);
      pivot.userData.restY = p[1];
      pivot.userData.restZ = p[2];
      pivot.position.set(pivot.userData.restX, p[1], p[2]);
      const camber = axle.camber * DEG;
      this.wheelSpins[i].rotation.z = left ? -camber : camber;
      this.wheelHubs[i].rotation.z = left ? -camber : camber;
      const holder = this.wheelModels[i];
      if (holder) {
        const sc = holder.userData.baseScale as number;
        holder.scale.set(left ? sc : -sc, sc, sc);
        const brake = this.brakes[i];
        if (brake) {
          // The brake follows the bead the wheel size slider moves, so it keeps filling the barrel.
          const ax = i < 2 ? 0 : 1;
          const k = (sc * beadForSize(this.wheelProfiles[ax], axle.wheelSize)) / BRAKE.refBead;
          // The unit's outboard-most point (the caliper's housing face, or the hat's) sits a clearance behind the
          // spokes of this axle's wheel, whatever its offset or width (the width only lengthens the barrel behind
          // the spokes); the holder's scale flips x on the right side.
          const x = (sc * spokeBackOf(this.widthFit[ax]) - BRAKE.clearance - k * brakeReach(ax)) * (left ? 1 : -1);
          brake.rotor.scale.set(left ? k : -k, k, k);
          brake.caliper.scale.set(left ? k : -k, k, k);
          brake.rotor.position.x = x;
          brake.caliper.position.x = x;
        }
      }
    }
  }

  private applyUnderglow(time: number): void {
    const g = this.visual.underglow;
    this.underglow.visible = g.enabled;
    if (!g.enabled) {
      if (this.underglowLight) this.underglowLight.intensity = 0;
      return;
    }
    const t = time * g.speed;
    let k = 1;
    const c1 = GLOW_C1.set(g.color);
    if (g.pattern === 'pulse') k = 0.45 + 0.55 * Math.abs(Math.sin(t * 3));
    else if (g.pattern === 'breathe') k = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 1.3));
    else if (g.pattern === 'strobe') k = Math.sin(t * 18) > 0.3 ? 1 : 0.08;
    else if (g.pattern === 'wave') c1.offsetHSL((t * 0.12) % 1, 0, 0);
    const u = this.underglowMat.uniforms;
    u.color1.value.copy(c1);
    u.color2.value.set(g.color2);
    u.intensity.value = 1.5 * g.brightness * k * this.airFade;
    // The shader picks the pattern by its index in GLOW_PATTERNS (4 alternate, 6 chase).
    u.mode.value = GLOW_PATTERNS.indexOf(g.pattern);
    u.time.value = t;
    this.underglow.scale.set(g.size, 1, g.size);
    if (this.underglowLight) {
      this.underglowLight.color.copy(g.pattern === 'alternate' && Math.floor(t * 0.5 * 2) % 2 ? GLOW_C2.set(g.color2) : c1);
      this.underglowLight.intensity = 14 * g.brightness * k;
      this.underglowLight.distance = 6 * g.size;
    }
  }

  /** Assign shared runtime materials by source material name. */
  bindMaterials(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: THREE.Material): THREE.Material => {
        const name = (m.userData.sourceName as string) ?? m.name;
        const resolved = resolveMaterialName(name, this.car.materialMap);
        if (!resolved) return m;
        const shared = this.materials[resolved];
        shared.userData.sourceName = resolved;
        return shared;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      mesh.castShadow = false;
      maskVehicleMesh(mesh);
    });
  }

  update(pose: CarPose, time: number): void {
    this.root.position.set(pose.x, pose.y + this.roadLift, pose.z);
    this.root.rotation.set(0, pose.yaw, 0);
    this.body.rotation.set(pose.pitch + this.rake, 0, pose.roll, 'YXZ');
    const tRoll = Math.tan(pose.roll);
    const tPitch = Math.tan(pose.pitch);
    const g = this.groundY;
    // The wheels hang off the body's own frame: its pitch and roll carry them, so on a steep bank they
    // lean with the body and stay in their arches. (The sim's sheared plane, tan below, only matches a
    // rotation at small angles: at 30 degrees of roll an upright wheel stands well clear of its arch.)
    const bq = POSE_Q.setFromEuler(POSE_E.set(pose.pitch, 0, pose.roll, 'YXZ'));
    for (let i = 0; i < 4; i++) {
      const pivot = this.wheelPivots[i];
      const p = this.car.wheels[WHEEL_KEYS[i]];
      // The body plane over the wheel as the sim measures it (car.ts: tan, so the wheels stay on a bank);
      // the compression is how far the ground under the wheel is above that plane.
      const plane = p[0] * tRoll - p[2] * tPitch;
      g[i] = pose.comp[i] + plane;
      const comp = Math.max(-0.12, Math.min(0.12, pose.comp[i]));
      const lift = this.axleLift[i < 2 ? 0 : 1];
      WHEEL_POS.set(pivot.userData.restX as number, (pivot.userData.restY as number) - lift + comp, pivot.userData.restZ as number).applyQuaternion(bq);
      pivot.position.set(WHEEL_POS.x, WHEEL_POS.y + lift, WHEEL_POS.z);
      pivot.quaternion.copy(bq);
      if (i < 2) pivot.quaternion.multiply(WHEEL_STEER.setFromAxisAngle(Y_AXIS, pose.steer));
      this.wheelSpins[i].rotation.x = pose.spin[i];
      this.wheelSpins[i].rotation.order = 'ZXY';
    }
    this.poseGroundFx(pose);
    const dt = Math.max(0, Math.min(0.1, time - this.lastTime));
    this.rotorHeat += ((pose.braking ? 1 : 0) - this.rotorHeat) * damp(pose.braking ? BRAKE.heatUp : BRAKE.coolDown, dt);
    setBrake(this.materials, pose.braking, this.rotorHeat, this.lampLevel);
    this.applyUnderglow(time);
    const stage = Math.max(1, Math.min(3, pose.nitroStage ?? 1)) - 1;
    for (const f of this.flames) {
      f.visible = pose.nitro;
      if (!pose.nitro) continue;
      const w = NITRO_FLAME.width[stage];
      f.scale.set(w, w, NITRO_FLAME.length[stage] * (0.7 + Math.random() * 0.6));
      (f.material as THREE.MeshBasicMaterial).color.copy(NITRO_FLAME.color[stage]);
    }
    this.lastTime = time;
    const F = POP_FLASH;
    const span = (r: readonly [number, number], size: number) => r[0] + (r[1] - r[0]) * size;
    for (const [i, p] of this.pops.entries()) {
      const age = time - this.popAt[i];
      const size = this.popSize[i];
      const life = span(F.life, size);
      const on = age >= 0 && age < life;
      p.tongue.visible = p.core.visible = p.glow.visible = on;
      if (!on) continue;
      // Bursts out in the first moments, then shrinks and dims; a bang is a fatter, longer tongue than a crackle,
      // with a white hot core inside it and a muzzle flash at the tip that is gone first.
      const k = age / life;
      const grow = Math.min(1, k * 5) * (1 - k * k);
      const length = span(F.length, size) * (1 - F.flicker / 2 + F.flicker * Math.random());
      const width = 0.8 + (span(F.width, size) - 0.8) * grow;
      p.tongue.scale.set(width, width, length * grow + 0.05);
      (p.tongue.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k);
      p.core.scale.set(width * F.core, width * F.core, length * F.core * grow + 0.03);
      (p.core.material as THREE.MeshBasicMaterial).opacity = 1 - k;
      const g = span(F.glow, size) * (1 - k) ** 0.5;
      p.glow.scale.set(g, g, 1);
      p.glow.material.opacity = (1 - k) ** 2;
    }
  }

  /**
   * An overrun pop: flash the flames at a pipe's tips (0 left, 1 right; -1 every tip, a single exhaust leaving
   * through all of them) `delay` seconds from the last update; size 1 a bang, 0 a crackle.
   */
  popFlash(pipe: number, size: number, delay = 0): void {
    for (let i = 0; i < this.pops.length; i++) {
      if (pipe >= 0 && this.tipPipe[i] !== pipe) continue;
      this.popAt[i] = this.lastTime + delay;
      this.popSize[i] = Math.max(0, Math.min(1, size));
    }
  }

  /**
   * The exhaust tips in the car's root frame (m; `tips` is the body's own), the body's ride height and rake
   * applied: where something that attaches to the tailpipes stands, like the dyno's extraction funnels.
   */
  tipsOnRoot(): [number, number, number][] {
    this.body.updateMatrix();
    return this.tips.map((t) => {
      const p = new THREE.Vector3(t[0], t[1], t[2]).applyMatrix4(this.body.matrix);
      return [p.x, p.y, p.z];
    });
  }

  /** Ground height under each wheel, in the root's frame (m); scratch for update(). */
  private readonly groundY = [0, 0, 0, 0];

  /**
   * Lay the underglow and the headlight pool on the road: the plane through the four ground points
   * the sim found under the wheels, so on a slope, a crown or a bank they neither sink into it at one
   * end nor float at the other. Up in the air they stay on the road and the underglow fades.
   */
  private poseGroundFx(pose: CarPose): void {
    const g = this.groundY;
    const w = this.car.wheels;
    const front = (g[0] + g[1]) / 2;
    const rear = (g[2] + g[3]) / 2;
    const left = (g[0] + g[2]) / 2;
    const right = (g[1] + g[3]) / 2;
    const slopeZ = (front - rear) / (w.FL[2] - w.RL[2] || 1);
    const slopeX = (left - right) / (w.FL[0] - w.FR[0] || 1);
    const midX = (w.FL[0] + w.FR[0]) / 2;
    const midZ = (w.FL[2] + w.RL[2]) / 2;
    this.groundFx.position.y = (front + rear) / 2 - slopeX * midX - slopeZ * midZ;
    // +X rotation tips +z down, +Z rotation tips +x up.
    this.groundFx.rotation.set(-Math.atan(slopeZ), 0, Math.atan(slopeX));
    const air = Math.max(0, -(pose.comp[0] + pose.comp[1] + pose.comp[2] + pose.comp[3]) / 4) / GROUND_FX.airHalf;
    this.airFade = 1 / (1 + air * air);
  }

  /** The head and tail lamps in car space (x, y, z triples; m), read off the HeadLight and TailLight meshes once the model is in, else off the body's dimensions. */
  private lamps: { head: number[]; tail: number[] } | null = null;

  private findLamps(): { head: number[]; tail: number[] } {
    const out = { head: [] as number[], tail: [] as number[] };
    const { length: L, width: W, height: H } = this.car.dimensions;
    if (this.baseModel) {
      this.root.updateWorldMatrix(true, true);
      const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
      const box = new THREE.Box3();
      const c = new THREE.Vector3();
      this.baseModel.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        const list = mat === this.materials.HeadLight ? out.head : mat === this.materials.TailLight ? out.tail : null;
        if (!list) return;
        mesh.geometry.computeBoundingBox();
        box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv).getCenter(c);
        // One mesh for both sides (centred): split it at a third of the car's width either side.
        if (Math.abs(c.x) < W * 0.05) list.push(-W * 0.32, c.y, c.z, W * 0.32, c.y, c.z);
        else list.push(c.x, c.y, c.z);
      });
    }
    if (out.head.length < 6) out.head = [-W * 0.32, H * 0.38, L * 0.5, W * 0.32, H * 0.38, L * 0.5];
    if (out.tail.length < 6) out.tail = [-W * 0.3, H * 0.4, -L * 0.5, W * 0.3, H * 0.4, -L * 0.5];
    return out;
  }

  /**
   * Offer this car's lamps to the frame's flares (lampFlares.ts): a flare per headlight along the car's forward and
   * per tail lamp backwards, at the root's current pose. Reads the lamp spots once; nothing is allocated after.
   */
  feedFlares(flares: LampFlares): void {
    const lamps = (this.lamps ??= this.findLamps());
    this.root.updateWorldMatrix(true, false);
    const e = this.root.matrixWorld.elements;
    let fx = e[8];
    let fy = e[9];
    let fz = e[10];
    const n = 1 / Math.max(1e-6, Math.hypot(fx, fy, fz));
    fx *= n;
    fy *= n;
    fz *= n;
    // A horn flash passes the lens at full: the flare follows it.
    const head = 1 + 1.5 * this.flash;
    for (let i = 0; i < lamps.head.length; i += 3) {
      const x = lamps.head[i];
      const y = lamps.head[i + 1];
      const z = lamps.head[i + 2];
      flares.head(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], fx, fy, fz, head);
    }
    for (let i = 0; i < lamps.tail.length; i += 3) {
      const x = lamps.tail[i];
      const y = lamps.tail[i + 1];
      const z = lamps.tail[i + 2];
      flares.tail(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14], -fx, -fy, -fz, 1);
    }
  }

  setHeadlightsEnabled(on: boolean): void {
    for (const h of this.headlights) h.visible = on;
    this.beam.visible = on;
  }

  /**
   * Scale the paint's environment reflections (0..1 of the build's own): a room whose lights go down keeps
   * the lit tubes in the paint's reflection map, so the garage turns them down with the lights. Re-dresses
   * the painted materials, so call it on a change, not every frame.
   */
  setEnvScale(scale: number): void {
    const k = Math.max(0, Math.min(1, scale));
    if (Math.abs(k - this.envScale) < 0.004) return;
    this.envScale = k;
    applyVisualToMaterials(this.materials, this.visual, this.stockLips(), false, k);
  }

  /** Each axle's wheel lip as it ships (front, rear), from the catalog: polished, or in the face's paint. */
  private stockLips(): ['chrome' | 'rim', 'chrome' | 'rim'] {
    const front = this.visual.parts.wheels ?? this.car.defaultWheel;
    const lip = (id: string): 'chrome' | 'rim' => (partById(id)?.lip === 'chrome' ? 'chrome' : 'rim');
    return [lip(front), lip(this.visual.wheels.rearPart ?? front)];
  }

  /**
   * How lit the lamp lenses are, 0 dark to 1 the night street's full glow: a parked car in a lit room keeps its
   * lamps on but low, so they read as lenses rather than blooming into blobs. Survives reloads of the visual
   * (the materials are the car's own); the brake lights keep following the pose through it.
   */
  setLampLevel(level: number): void {
    const k = Math.max(0, Math.min(1, level));
    this.lampLevel = k;
    const head = this.materials.HeadLight as THREE.MeshStandardMaterial | undefined;
    const marker = this.materials.Light as THREE.MeshStandardMaterial | undefined;
    if (head) head.emissiveIntensity = LAMP_GLOW.head * k;
    if (marker) marker.emissiveIntensity = LAMP_GLOW.marker * k;
  }

  /** Show or hide one wheel (0 FL, 1 FR, 2 RL, 3 RR), e.g. a car on a garage lift with its wheels off. Kept across reloads. */
  setWheelVisible(index: number, on: boolean): void {
    const pivot = this.wheelPivots[index];
    if (pivot) pivot.visible = on;
  }

  private lensBase = NaN;

  /** The wet road throws the lamps back: brighter pool and spots (0 dry .. 1 soaked). Cheap; call it every frame. */
  setWet(wet: number): void {
    const w = Math.max(0, Math.min(1, wet));
    if (w === this.wet) return;
    this.wet = w;
    this.applyBeams();
  }

  /** Flash to pass: 0 = normal beams, 1 = full high beam flash (spots, road pool and lenses). Driven by the session's horn. */
  flashHeadlights(level: number): void {
    const k = Math.max(0, Math.min(1, level));
    // Idle: leave the lights alone.
    if (k === 0 && this.flash === 0) return;
    this.flash = k;
    this.applyBeams();
    const lens = this.materials.HeadLight as THREE.MeshStandardMaterial | undefined;
    if (lens) {
      if (Number.isNaN(this.lensBase)) this.lensBase = lens.emissiveIntensity;
      lens.emissiveIntensity = this.lensBase * (1 + 2.5 * k);
      if (k === 0) this.lensBase = NaN;
    }
  }

  /** Pool colour and the spots' intensity and range from the wet road and the flash. */
  private applyBeams(): void {
    const k = this.flash;
    (this.beam.material as THREE.MeshBasicMaterial).color.copy(this.beamBase).multiplyScalar((1 + GROUND_FX.wetBeam * this.wet) * (1 + 1.6 * k));
    for (const [i, h] of this.headlights.entries()) {
      const b = this.spotBase[i];
      h.intensity = b.intensity * (1 + GROUND_FX.wetSpot * this.wet) * (1 + 1.8 * k);
      h.distance = b.distance * (1 + 0.6 * k);
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
    disposeCarMaterials(this.materials);
    this.owned.dispose();
    this.decals.dispose();
  }
}

function visibleInTree(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n && n !== stop; n = n.parent) if (!n.visible) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Code-built placeholder car (used when the car's GLB is not present).
// Built in car space with named meshes and the shared material names.
// ---------------------------------------------------------------------------

function named(geo: THREE.BufferGeometry, mat: string, name: string): THREE.Mesh {
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ name: mat }));
  m.name = name;
  return m;
}

export function buildPlaceholderCar(car: ManifestCar): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'PlaceholderCar';
  const { length: L, width: W, height: H } = car.dimensions;
  const r = car.wheelRadius;
  const bodyH = H * 0.42;
  const bodyY = r * 0.55;
  const body = named(new THREE.BoxGeometry(W * 0.98, bodyH, L * 0.78), 'Paint', 'Body');
  body.position.set(0, bodyY + bodyH / 2, 0);
  g.add(body);
  // cabin with sloped glass
  const cabin = named(new THREE.BoxGeometry(W * 0.8, H * 0.36, L * 0.42), 'Glass', 'Cabin');
  cabin.position.set(0, bodyY + bodyH + H * 0.18 - 0.02, -L * 0.05);
  g.add(cabin);
  const roof = named(new THREE.BoxGeometry(W * 0.78, 0.06, L * 0.32), 'Paint', 'Roof');
  roof.position.set(0, bodyY + bodyH + H * 0.36, -L * 0.07);
  g.add(roof);
  const front = named(new THREE.BoxGeometry(W * 0.98, bodyH * 0.8, L * 0.11), 'Paint', 'Bumper_Front');
  front.position.set(0, bodyY + bodyH * 0.4, L * 0.445);
  g.add(front);
  const rear = named(new THREE.BoxGeometry(W * 0.98, bodyH * 0.85, L * 0.11), 'Paint', 'Bumper_Rear');
  rear.position.set(0, bodyY + bodyH * 0.43, -L * 0.445);
  g.add(rear);
  const hood = named(new THREE.BoxGeometry(W * 0.9, 0.04, L * 0.25), 'Paint', 'Hood');
  hood.position.set(0, bodyY + bodyH + 0.02, L * 0.26);
  g.add(hood);
  for (const side of [1, -1]) {
    const skirt = named(new THREE.BoxGeometry(0.06, 0.16, L * 0.5), 'Trim', side > 0 ? 'Skirt_L' : 'Skirt_R');
    skirt.position.set(side * W * 0.49, bodyY + 0.06, 0);
    g.add(skirt);
    const hl = named(new THREE.BoxGeometry(W * 0.22, 0.09, 0.04), 'HeadLight', side > 0 ? 'Headlight_L' : 'Headlight_R');
    hl.position.set(side * W * 0.32, bodyY + bodyH * 0.7, L * 0.5);
    g.add(hl);
    const tl = named(new THREE.BoxGeometry(W * 0.26, 0.1, 0.04), 'TailLight', side > 0 ? 'Taillight_L' : 'Taillight_R');
    tl.position.set(side * W * 0.3, bodyY + bodyH * 0.72, -L * 0.5);
    g.add(tl);
  }
  const grille = named(new THREE.BoxGeometry(W * 0.4, 0.12, 0.03), 'Black', 'Grille');
  grille.position.set(0, bodyY + bodyH * 0.45, L * 0.502);
  g.add(grille);
  return g;
}

/** Simple code-built stand-ins for parts in placeholder mode. */
export function buildPlaceholderPart(car: ManifestCar, slot: PartSlot, partId: string): THREE.Object3D | null {
  const { length: L, width: W, height: H } = car.dimensions;
  const r = car.wheelRadius;
  const bodyY = r * 0.55;
  const bodyH = H * 0.42;
  const g = new THREE.Group();
  const variant = partId.length % 3;
  if (slot === 'spoiler') {
    const wing = named(new THREE.BoxGeometry(W * 0.92, 0.04, 0.32 + variant * 0.06), 'Paint', 'Wing');
    wing.position.set(0, bodyY + bodyH + 0.28 + variant * 0.08, -L * 0.44);
    g.add(wing);
    for (const s of [1, -1]) {
      const post = named(new THREE.BoxGeometry(0.04, 0.3 + variant * 0.08, 0.08), 'Black', 'WingPost');
      post.position.set(s * W * 0.3, bodyY + bodyH + 0.13 + variant * 0.04, -L * 0.43);
      g.add(post);
    }
    return g;
  }
  if (slot === 'frontBumper') {
    const b = named(new THREE.BoxGeometry(W * 1.0, bodyH * 0.75, L * 0.13), 'Paint', 'FrontBumper');
    b.position.set(0, bodyY + bodyH * 0.35 - 0.04, L * 0.45);
    const lip = named(new THREE.BoxGeometry(W * 1.02, 0.04, 0.18 + variant * 0.06), 'Black', 'Lip');
    lip.position.set(0, bodyY - 0.02, L * 0.48);
    g.add(b, lip);
    g.userData.hides = ['Bumper_Front'];
    return g;
  }
  if (slot === 'rearBumper') {
    const b = named(new THREE.BoxGeometry(W * 1.0, bodyH * 0.8, L * 0.13), 'Paint', 'RearBumper');
    b.position.set(0, bodyY + bodyH * 0.4 - 0.04, -L * 0.45);
    const diff = named(new THREE.BoxGeometry(W * 0.7, 0.05, 0.25), 'Black', 'Diffuser');
    diff.position.set(0, bodyY - 0.01, -L * 0.47);
    g.add(b, diff);
    g.userData.hides = ['Bumper_Rear'];
    return g;
  }
  if (slot === 'sideSkirts') {
    for (const s of [1, -1]) {
      const sk = named(new THREE.BoxGeometry(0.12, 0.2, L * 0.56), 'Paint', 'Skirt');
      sk.position.set(s * W * 0.5, bodyY + 0.04, 0);
      g.add(sk);
    }
    g.userData.hides = ['Skirt_L', 'Skirt_R'];
    return g;
  }
  if (slot === 'hood') {
    const hd = named(new THREE.BoxGeometry(W * 0.9, 0.06, L * 0.25), 'Paint', 'Hood');
    hd.position.set(0, bodyY + bodyH + 0.03, L * 0.26);
    const scoop = named(new THREE.BoxGeometry(W * 0.3, 0.1, L * 0.1), 'Black', 'Scoop');
    scoop.position.set(0, bodyY + bodyH + 0.09, L * 0.24);
    g.add(hd, scoop);
    g.userData.hides = ['Hood'];
    return g;
  }
  return null;
}

/** Wheel in wheel space: center at origin, axle along X, outer face toward +X. */
export function buildPlaceholderWheel(id: string): THREE.Object3D {
  const g = new THREE.Group();
  g.userData.ownGeometry = true;
  const r = 0.33;
  const w = 0.24;
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24, 1, true).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ name: 'Tire', side: THREE.DoubleSide }));
  tire.name = 'Tire';
  g.add(tire);
  const spokes = 4 + (id.length % 4);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.04, spokes * 2).rotateZ(Math.PI / 2).translate(w * 0.42, 0, 0), new THREE.MeshStandardMaterial({ name: 'Rim' }));
  face.name = 'Rim';
  g.add(face);
  for (let i = 0; i < spokes; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, r * 1.3, 0.05).translate(w * 0.46, 0, 0), new THREE.MeshStandardMaterial({ name: 'Chrome' }));
    spoke.rotation.x = (i / spokes) * Math.PI;
    g.add(spoke);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.15, r * 0.15, 0.06, 12).rotateZ(Math.PI / 2).translate(w * 0.48, 0, 0), new THREE.MeshStandardMaterial({ name: 'Black' }));
  g.add(hub);
  const side = new THREE.Mesh(new THREE.RingGeometry(r * 0.72, r, 24).rotateY(Math.PI / 2).translate(w / 2, 0, 0), new THREE.MeshStandardMaterial({ name: 'Tire' }));
  g.add(side);
  return g;
}
