/**
 * Visual car: assembles a car from its base model and equipped parts (or a
 * code-built placeholder when files are missing), applies the visual build,
 * and poses itself from interpolated sim state. Render only.
 */
import * as THREE from 'three';
import { BODY_PART_SLOTS, PartSlot } from '../shared/parts';
import { VisualBuild, defaultVisual } from '../sim/build';
import { CarAssetLibrary, ManifestCar, manifestCar, partById, partsFor } from './carAssets';
import { CarMaterialSet, applyVisualToMaterials, createCarMaterials, disposeCarMaterials, resolveMaterialName, setBrake } from './carMaterials';
import { makeRadialGlow } from './textures';
import { DecalLayerView } from './decals';

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
  speed: number;
}

const WHEEL_KEYS = ['FL', 'FR', 'RL', 'RR'] as const;
const DEG = Math.PI / 180;

let glowTex: THREE.Texture | null = null;
const glow = () => (glowTex ??= makeRadialGlow());

export class CarView {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly model = new THREE.Group();
  readonly materials: CarMaterialSet = createCarMaterials();
  readonly car: ManifestCar;
  private wheelPivots: THREE.Group[] = [];
  private wheelSpins: THREE.Group[] = [];
  private wheelModels: THREE.Object3D[] = [];
  private slotObjects = new Map<PartSlot, THREE.Object3D>();
  private baseModel: THREE.Object3D | null = null;
  private placeholder = false;
  private visual: VisualBuild = defaultVisual();
  private headlights: THREE.SpotLight[] = [];
  private underglow: THREE.Mesh;
  private underglowLight: THREE.PointLight | null = null;
  private flames: THREE.Mesh[] = [];
  private beam: THREE.Mesh;
  readonly decals: DecalLayerView;
  private loadToken = 0;

  constructor(
    carId: string,
    private readonly assets: CarAssetLibrary,
    opts: { headlights?: boolean; underglowLight?: boolean } = {},
  ) {
    this.car = manifestCar(carId);
    this.root.name = `car:${carId}`;
    this.root.add(this.body);
    this.body.add(this.model);
    const dims = this.car.dimensions;

    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      pivot.add(spin);
      this.root.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpins.push(spin);
    }

    // Underglow: emissive glow plane on the road plus an optional real light.
    this.underglow = new THREE.Mesh(
      new THREE.PlaneGeometry(dims.width * 1.9, dims.length * 1.5).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glow(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x00e5ff }),
    );
    this.underglow.position.y = 0.06;
    this.underglow.visible = false;
    this.underglow.renderOrder = 3;
    this.root.add(this.underglow);
    if (opts.underglowLight) {
      this.underglowLight = new THREE.PointLight(0x00e5ff, 0, 6, 1.5);
      this.underglowLight.position.set(0, 0.25, 0);
      this.root.add(this.underglowLight);
    }

    // Headlight beams: a soft additive pool on the road ahead (cheap), plus real spots for the player.
    this.beam = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 22).rotateX(-Math.PI / 2).translate(0, 0.07, dims.length / 2 + 10),
      new THREE.MeshBasicMaterial({ map: glow(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x6f7a8a }),
    );
    this.beam.renderOrder = 3;
    this.root.add(this.beam);
    if (opts.headlights) {
      for (const side of [1, -1]) {
        const spot = new THREE.SpotLight(0xeaf2ff, 90, 70, 0.42, 0.55, 1.3);
        spot.position.set(side * dims.width * 0.32, 0.7, dims.length / 2 - 0.2);
        spot.target.position.set(side * 0.5, 0, dims.length / 2 + 18);
        this.root.add(spot, spot.target);
        this.headlights.push(spot);
      }
    }

    // Nitrous exhaust flames.
    const flameGeo = new THREE.ConeGeometry(0.11, 0.9, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.45);
    for (const side of [1, -1]) {
      const flame = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x4fa8ff).multiplyScalar(3), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      flame.position.set(side * 0.38, 0.32, -dims.length / 2 + 0.05);
      flame.visible = false;
      this.root.add(flame);
      this.flames.push(flame);
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

    // Wheels.
    const wheelId = v.parts.wheels ?? this.car.defaultWheel;
    const currentWheel = this.wheelModels[0]?.userData.partId;
    if (currentWheel !== wheelId || this.wheelModels.length === 0) {
      const entry = partById(wheelId) ?? partsFor(this.car.id, 'wheels')[0] ?? this.devEntry(wheelId);
      let model: THREE.Object3D | null = entry ? await this.assets.part(entry) : null;
      if (token !== this.loadToken) return;
      if (!model) model = buildPlaceholderWheel(wheelId);
      model.userData.partId = wheelId;
      this.bindMaterials(model);
      this.setWheelModel(model);
    }
    this.applyStance();
    this.decals.rebuild(v.decals);
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

  private setWheelModel(model: THREE.Object3D): void {
    for (const old of this.wheelModels) old.parent?.remove(old);
    this.wheelModels = [];
    // Normalize the wheel to the car's wheel radius using its bounding box.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.y, size.z) / 2 || this.car.wheelRadius;
    for (let i = 0; i < 4; i++) {
      const holder = new THREE.Group();
      const inst = i === 0 ? model : model.clone(true);
      inst.position.sub(center);
      holder.add(inst);
      holder.userData.partId = model.userData.partId;
      holder.userData.baseScale = this.car.wheelRadius / radius;
      this.wheelSpins[i].add(holder);
      this.wheelModels.push(holder);
    }
  }

  private applyStance(): void {
    const v = this.visual;
    const s = v.stance;
    this.body.position.y = s.rideHeight;
    for (let i = 0; i < 4; i++) {
      const p = this.car.wheels[WHEEL_KEYS[i]];
      const left = p[0] > 0;
      const pivot = this.wheelPivots[i];
      pivot.userData.restX = p[0] + (left ? s.offset : -s.offset);
      pivot.userData.restY = p[1];
      pivot.userData.restZ = p[2];
      pivot.position.set(pivot.userData.restX, p[1], p[2]);
      const camber = (i < 2 ? s.camberFront : s.camberRear) * DEG;
      this.wheelSpins[i].rotation.z = left ? -camber : camber;
      const holder = this.wheelModels[i];
      if (holder) {
        const sc = (holder.userData.baseScale as number) * v.wheels.size;
        holder.scale.set(left ? sc : -sc, sc, sc);
      }
    }
  }

  private applyUnderglow(time: number): void {
    const g = this.visual.underglow;
    this.underglow.visible = g.enabled;
    const mat = this.underglow.material as THREE.MeshBasicMaterial;
    let k = 1;
    const color = new THREE.Color(g.color);
    if (g.pattern === 'pulse') k = 0.55 + 0.45 * Math.sin(time * 4);
    else if (g.pattern === 'strobe') k = Math.sin(time * 18) > 0 ? 1 : 0.15;
    else if (g.pattern === 'wave') color.offsetHSL((time * 0.15) % 1, 0, 0);
    mat.color.copy(color).multiplyScalar(1.6 * k);
    if (this.underglowLight) {
      this.underglowLight.color.copy(color);
      this.underglowLight.intensity = g.enabled ? 14 * k : 0;
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
    });
  }

  update(pose: CarPose, time: number): void {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.set(0, pose.yaw, 0);
    this.body.rotation.set(pose.pitch, 0, pose.roll, 'YXZ');
    for (let i = 0; i < 4; i++) {
      const pivot = this.wheelPivots[i];
      const p = this.car.wheels[WHEEL_KEYS[i]];
      const comp = Math.max(-0.12, Math.min(0.12, pose.comp[i]));
      pivot.position.y = (pivot.userData.restY as number) + comp + p[0] * pose.roll - p[2] * pose.pitch;
      pivot.rotation.y = i < 2 ? pose.steer : 0;
      this.wheelSpins[i].rotation.x = pose.spin[i];
      this.wheelSpins[i].rotation.order = 'ZXY';
    }
    setBrake(this.materials, this.visual.taillightColor, pose.braking);
    this.applyUnderglow(time);
    for (const f of this.flames) {
      f.visible = pose.nitro;
      if (pose.nitro) f.scale.set(1, 1, 0.7 + Math.random() * 0.6);
    }
  }

  setHeadlightsEnabled(on: boolean): void {
    for (const h of this.headlights) h.visible = on;
    this.beam.visible = on;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry?.dispose();
    });
    disposeCarMaterials(this.materials);
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
  const r = 0.33;
  const w = 0.24;
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24, 1, true).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ name: 'Tire', side: THREE.DoubleSide }));
  tire.name = 'Tire';
  g.add(tire);
  const spokes = 4 + (id.length % 4);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.04, spokes * 2).rotateZ(Math.PI / 2).translate(w * 0.42, 0, 0), new THREE.MeshStandardMaterial({ name: 'Rim' }));
  rim.name = 'Rim';
  g.add(rim);
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
