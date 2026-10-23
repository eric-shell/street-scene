/**
 * Visual car: assembles a car from its base model and equipped parts (or a
 * code-built placeholder when files are missing), applies the visual build,
 * and poses itself from interpolated sim state. Render only.
 */
import * as THREE from 'three';
import { BODY_PART_SLOTS, PartSlot } from '../../shared/parts';
import { GLOW_PATTERNS, TireShape, VisualBuild, defaultVisual } from '../../shared/carBuild';
import { CarAssetLibrary, ManifestCar, manifestCar, partById, partsFor } from './carAssets';
import { CarMaterialSet, applyVisualToMaterials, createCarMaterials, disposeCarMaterials, resolveMaterialName, setBrake } from './carMaterials';
import { makeRadialGlow } from '../textures/textures';
import { DecalLayerView } from './decals';
import { FEATURES } from '../../shared/features';
import { WheelProfile, beadForSize, detectProfile, remapWheel, sizeForBead } from './wheelFit';
import { BRAKE, buildCaliperGeometry, buildRotorGeometry } from './brakes';
import { latheTire, measureTire } from './tireShapes';
import { maskVehicleMesh, underVehicles } from '../vehicleMask';
import { Disposer } from '../disposer';

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
  /** Body height over its rest (m) at which the underglow on the road has faded to half: it spreads and dims on a jump. */
  airHalf: 0.5,
} as const;

let glowTex: THREE.Texture | null = null;
const glow = () => (glowTex ??= makeRadialGlow());

/** Overrun pop flash: lifetime (s) and tongue length (m) from a crackle to a bang. */
const POP_FLASH = { life: [0.07, 0.16], length: [0.4, 1.3] } as const;
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
  private axleSize = [NaN, NaN];
  /** Per axle, the back of the wheel's spokes along the axle (baked wheel space, m; +X outboard): the brake sits behind it. */
  private spokeBack = [0, 0];
  /** Each axle's wheel profile: front and rear may wear different wheels. */
  private wheelProfiles: WheelProfile[] = [
    { outer: 1, bead: 0.75 },
    { outer: 1, bead: 0.75 },
  ];
  /** What each axle wears ("wheel id:tire shape"), so an unchanged axle is not baked again. */
  private axleWear = ['', ''];
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
  private flames: THREE.Mesh[] = [];
  /** Overrun pop flames per tailpipe (0 left, 1 right): when each starts and how big it is (1 bang, 0 crackle). */
  private pops: THREE.Mesh[] = [];
  private popAt = [-1, -1];
  private popSize = [0, 0];
  private lastTime = 0;
  private beam: THREE.Mesh;
  readonly decals: DecalLayerView;
  private loadToken = 0;
  /** The car's own effect materials (underglow, headlight pool, flames, pops); the shared car materials go with disposeCarMaterials. */
  private readonly owned = new Disposer();

  constructor(
    carId: string,
    private readonly assets: CarAssetLibrary,
    /**
     * roadLift: how far the drawn road surface is above the sim's ground (m, cityMeshes ROAD_Y).
     * The sim rests the tires on the ground; on the city's asphalt they would sink that far into it.
     * 0 (the garage floor) by default.
     */
    opts: { headlights?: boolean; underglowLight?: boolean; envMap?: THREE.Texture | null; roadLift?: number; brakes?: boolean } = {},
  ) {
    this.materials = createCarMaterials(opts.envMap ?? null);
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

    // Headlight beams: a soft additive pool on the road ahead (cheap), plus real spots for the player.
    const beamMat = track(new THREE.MeshBasicMaterial({ map: glow(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x6f7a8a }));
    underVehicles(beamMat);
    this.beam = new THREE.Mesh(new THREE.PlaneGeometry(9, 22).rotateX(-Math.PI / 2).translate(0, GROUND_FX.beamY, dims.length / 2 + 10), beamMat);
    this.beam.renderOrder = 3;
    this.groundFx.add(this.beam);
    if (opts.headlights) {
      for (const side of [1, -1]) {
        const spot = new THREE.SpotLight(0xeaf2ff, 90, 70, 0.42, 0.55, 1.3);
        spot.position.set(side * dims.width * 0.32, 0.7, dims.length / 2 - 0.2);
        spot.target.position.set(side * 0.5, 0, dims.length / 2 + 18);
        this.root.add(spot, spot.target);
        this.headlights.push(spot);
      }
    }

    // Nitrous exhaust flames, and the orange flash of an overrun pop at the same tailpipes.
    const flameGeo = new THREE.ConeGeometry(0.11, 0.9, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.45);
    for (const side of [1, -1]) {
      const flame = new THREE.Mesh(flameGeo, track(new THREE.MeshBasicMaterial({ color: NITRO_FLAME.color[0].clone(), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })));
      flame.position.set(side * 0.38, 0.32, -dims.length / 2 + 0.05);
      flame.visible = false;
      this.root.add(flame);
      this.flames.push(flame);
      const pop = new THREE.Mesh(flameGeo, track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff8a2a).multiplyScalar(3.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })));
      pop.position.copy(flame.position);
      pop.visible = false;
      this.root.add(pop);
      this.pops.push(pop);
    }

    this.decals = new DecalLayerView(this);
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

  /** Apply a visual build. Part swaps load asynchronously; everything else is instant. */
  async applyVisual(v: VisualBuild, token = ++this.loadToken): Promise<void> {
    this.visual = v;
    applyVisualToMaterials(this.materials, v);
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
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const toWheel = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    const baked = new THREE.Group();
    const tireR: number[] = [];
    const otherR: number[] = [];
    const otherX: number[] = [];
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
      // Another tire shape: lathed where the wheel's own tire sat (not on the placeholder, whose tire has no sidewall).
      const fit = isTire && tire !== 'standard' && !model.userData.ownGeometry ? measureTire(geo.getAttribute('position').array) : null;
      if (fit && tire !== 'standard') {
        const t = latheTire(tire, fit);
        geo.dispose();
        geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(t.position, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(t.normal, 3));
        geo.setIndex(new THREE.BufferAttribute(t.index, 1));
      }
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      // Keep the unscaled shape; every size change remaps from it.
      geo.userData.basePos = Float32Array.from(pos.array as ArrayLike<number>);
      geo.userData.baseNrm = nrm ? Float32Array.from(nrm.array as ArrayLike<number>) : null;
      const radii = isTire ? tireR : otherR;
      for (let k = 0; k < pos.count; k++) {
        radii.push(Math.hypot(pos.getY(k), pos.getZ(k)));
        if (!isTire) otherX.push(pos.getX(k));
      }
      // The rear axle wears its own wheel material (wheel color).
      const material = axle === 1 ? (Array.isArray(mesh.material) ? mesh.material.map(this.rearMat) : this.rearMat(mesh.material)) : mesh.material;
      const out = new THREE.Mesh(geo, material);
      out.name = mesh.name;
      maskVehicleMesh(out);
      baked.add(out);
    });
    const profile = detectProfile(tireR, otherR);
    this.wheelProfiles[axle] = profile;
    // The spokes' back: the innermost point of the spoke zone (between the center bore, which can run
    // deeper and sits inside the hat anyway, and the barrel with its lip).
    let back = Infinity;
    for (let k = 0; k < otherR.length; k++) {
      const r = otherR[k] / profile.bead;
      if (r > 0.3 && r < 0.75) back = Math.min(back, otherX[k]);
    }
    this.spokeBack[axle] = Number.isFinite(back) ? back : 0;
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
    }
    this.bakeBrakes(axle);
  }

  /** Build the axle's brake units: the rotor spins with the wheel, the caliper sits still on the hub. Both wheels share the geometry. */
  private bakeBrakes(axle: 0 | 1): void {
    if (!this.brakesOn) return;
    const rotorGeo = buildRotorGeometry(axle);
    const caliperGeo = buildCaliperGeometry(axle);
    for (const i of [axle * 2, axle * 2 + 1]) {
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

  private readonly rearMat = (m: THREE.Material) => (m === this.materials.Rim ? this.materials.RimRear : m);

  /** Remap one axle's wheel meshes for a wheel size (tire outer diameter stays). */
  private applyWheelSize(axle: 0 | 1, size: number): void {
    if (this.axleSize[axle] === size) return;
    this.axleSize[axle] = size;
    for (const mesh of this.axleMeshes[axle]) {
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      remapWheel(geo.userData.basePos as Float32Array, (geo.userData.baseNrm as Float32Array | null) ?? null, pos.array as Float32Array, nrm ? (nrm.array as Float32Array) : null, this.wheelProfiles[axle], size);
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

  /** True once both axles are baked, so wheelInches measures the real profiles rather than the placeholder one. */
  get wheelsReady(): boolean {
    return this.wheelModels.every(Boolean);
  }

  private applyStance(): void {
    const v = this.visual;
    const s = v.stance;
    this.body.position.y = s.rideHeight;
    this.applyWheelSize(0, s.front.wheelSize);
    this.applyWheelSize(1, s.rear.wheelSize);
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
          // Behind the spokes of this axle's wheel, whatever its offset (the holder's scale flips x on the right side).
          const x = (sc * this.spokeBack[ax] - BRAKE.clearance) * (left ? 1 : -1);
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
    this.body.rotation.set(pose.pitch, 0, pose.roll, 'YXZ');
    const tRoll = Math.tan(pose.roll);
    const tPitch = Math.tan(pose.pitch);
    const g = this.groundY;
    // The wheels hang off the body's own frame: its pitch and roll carry them, so on a steep bank they
    // lean with the body and stay in their arches. (The sim's sheared plane, tan below, only matches a
    // rotation at small angles: at 30 degrees of roll an upright wheel stands well clear of its arch.)
    const bq = this.body.quaternion;
    const rideHeight = this.body.position.y;
    for (let i = 0; i < 4; i++) {
      const pivot = this.wheelPivots[i];
      const p = this.car.wheels[WHEEL_KEYS[i]];
      // The body plane over the wheel as the sim measures it (car.ts: tan, so the wheels stay on a bank);
      // the compression is how far the ground under the wheel is above that plane.
      const plane = p[0] * tRoll - p[2] * tPitch;
      g[i] = pose.comp[i] + plane;
      const comp = Math.max(-0.12, Math.min(0.12, pose.comp[i]));
      WHEEL_POS.set(pivot.userData.restX as number, (pivot.userData.restY as number) - rideHeight + comp, pivot.userData.restZ as number).applyQuaternion(bq);
      pivot.position.set(WHEEL_POS.x, WHEEL_POS.y + rideHeight, WHEEL_POS.z);
      pivot.quaternion.copy(bq);
      if (i < 2) pivot.quaternion.multiply(WHEEL_STEER.setFromAxisAngle(Y_AXIS, pose.steer));
      this.wheelSpins[i].rotation.x = pose.spin[i];
      this.wheelSpins[i].rotation.order = 'ZXY';
    }
    this.poseGroundFx(pose);
    setBrake(this.materials, pose.braking);
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
    for (const [i, p] of this.pops.entries()) {
      const age = time - this.popAt[i];
      const size = this.popSize[i];
      const life = POP_FLASH.life[0] + (POP_FLASH.life[1] - POP_FLASH.life[0]) * size;
      p.visible = age >= 0 && age < life;
      if (!p.visible) continue;
      // Bursts out in the first moments, then shrinks and dims; a bang is a fatter, longer tongue than a crackle.
      const k = age / life;
      const grow = Math.min(1, k * 4) * (1 - k * k);
      const length = POP_FLASH.length[0] + (POP_FLASH.length[1] - POP_FLASH.length[0]) * size;
      p.scale.set(0.8 + 0.9 * size * grow, 0.8 + 0.9 * size * grow, length * grow + 0.05);
      (p.material as THREE.MeshBasicMaterial).opacity = 0.95 * (1 - k);
    }
  }

  /** An overrun pop: flash a flame at a tailpipe (0 left, 1 right) `delay` seconds from the last update; size 1 a bang, 0 a crackle. */
  popFlash(pipe: number, size: number, delay = 0): void {
    const i = pipe === 1 && this.pops.length > 1 ? 1 : 0;
    this.popAt[i] = this.lastTime + delay;
    this.popSize[i] = Math.max(0, Math.min(1, size));
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

  setHeadlightsEnabled(on: boolean): void {
    for (const h of this.headlights) h.visible = on;
    this.beam.visible = on;
  }

  /** Show or hide one wheel (0 FL, 1 FR, 2 RL, 3 RR), e.g. a car on a garage lift with its wheels off. Kept across reloads. */
  setWheelVisible(index: number, on: boolean): void {
    const pivot = this.wheelPivots[index];
    if (pivot) pivot.visible = on;
  }

  private flashBase: { spot: number; spotDist: number; beam: THREE.Color; lens: number } | null = null;

  /** Flash to pass: 0 = normal beams, 1 = full high beam flash (spots, road pool and lenses). Driven by the session's horn. */
  flashHeadlights(level: number): void {
    const k = Math.max(0, Math.min(1, level));
    // Idle: leave the lights alone (base values are captured when a flash starts).
    if (k === 0 && !this.flashBase) return;
    const lens = this.materials.HeadLight as THREE.MeshStandardMaterial | undefined;
    const beamMat = this.beam.material as THREE.MeshBasicMaterial;
    this.flashBase ??= { spot: this.headlights[0]?.intensity ?? 0, spotDist: this.headlights[0]?.distance ?? 0, beam: beamMat.color.clone(), lens: lens?.emissiveIntensity ?? 1 };
    const b = this.flashBase;
    for (const h of this.headlights) {
      h.intensity = b.spot * (1 + 1.8 * k);
      h.distance = b.spotDist * (1 + 0.6 * k);
    }
    beamMat.color.copy(b.beam).multiplyScalar(1 + 1.6 * k);
    if (lens) lens.emissiveIntensity = b.lens * (1 + 2.5 * k);
    if (k === 0) this.flashBase = null;
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
