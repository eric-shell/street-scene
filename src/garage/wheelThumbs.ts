/**
 * Thumbnails of the wheels for the Wheels tab's picker: each wheel GLB drawn
 * face on, three quarters round, in the stock wheel materials (carMaterials'
 * silver Rim, Chrome, rubber), on a transparent ground so the tile's plate
 * shows behind. A small offscreen renderer of its own draws them, since a
 * render target on the game's renderer would skip its tone mapping and sRGB
 * output and come out dark; it is made on the first request and freed with
 * the garage. One wheel at a time, in the order asked (the picker asks as
 * tiles scroll into view), so loading 44 GLBs never lands in one frame. The
 * images are data URLs kept for the session: a garage opened again shows
 * them at once. Each face is drawn where the car on show sets it (the car's
 * front offset target and the wheel's own bias, docs/carWheels.md, Offset),
 * so a tile shows the wheel as it will be fitted, not the GLB's stock dish.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CarAssetLibrary } from '../render/car/carAssets';
import { lugsGeometry } from '../render/car/lugNuts';
import { WidthFit, detectFaceFit, detectProfile, faceRange, remapWheel } from '../render/car/wheelFit';
import type { PartEntry } from '../shared/parts';

/** The thumbnail's size (px, square; the tile shows it at about half for a sharp image on 2x screens) and its view. */
const THUMB = {
  px: 192,
  /** Lens (deg): long, so the face is barely foreshortened. */
  fov: 20,
  /** Turned off the axle so the dish and the tire's shoulder show (rad). */
  yaw: 0.55,
  /** Looking a little down on it (rad). */
  pitch: 0.12,
  /** Margin round the wheel's radius (1 fills the frame edge to edge with the tire). */
  fill: 1.12,
} as const;

/** The finished images by wheel id and offset target, kept for the session; a failed draw is dropped so a later garage tries again. */
const done = new Map<string, Promise<string | null>>();

/** One mesh of the wheel unpacked to plain float positions and normals in the GLB's own frame (its node transforms baked in). */
interface Unpacked {
  pos: Float32Array;
  nrm: Float32Array | null;
  material: THREE.Material;
  tire: boolean;
  ring: boolean;
}

function unpack(mesh: THREE.Mesh): Unpacked {
  const geo = mesh.geometry;
  const p = geo.getAttribute('position');
  const n = geo.getAttribute('normal');
  const pos = new Float32Array(p.count * 3);
  const nrm = n ? new Float32Array(p.count * 3) : null;
  const m = mesh.matrixWorld;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  for (let k = 0; k < p.count; k++) {
    v.set(p.getX(k), p.getY(k), p.getZ(k)).applyMatrix4(m);
    pos[k * 3] = v.x;
    pos[k * 3 + 1] = v.y;
    pos[k * 3 + 2] = v.z;
    if (nrm && n) {
      v.set(n.getX(k), n.getY(k), n.getZ(k)).applyMatrix3(nm).normalize();
      nrm[k * 3] = v.x;
      nrm[k * 3 + 1] = v.y;
      nrm[k * 3 + 2] = v.z;
    }
  }
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return { pos, nrm, material: mat, tire: mat.name === 'Tire', ring: mat.name === 'RimLip' };
}

export class WheelThumbs {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(THUMB.fov, 1, 0.05, 20);
  private env: THREE.WebGLRenderTarget | null = null;
  /** The stock wheel materials by the GLB's material names (as carMaterials makes them before a paint). */
  private readonly materials: Record<string, THREE.Material> = {
    Rim: new THREE.MeshPhysicalMaterial({ color: 0xc9ced8, metalness: 0.75, roughness: 0.32 }),
    Chrome: new THREE.MeshStandardMaterial({ color: 0xdedede, metalness: 1, roughness: 0.12 }),
    Tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 }),
    Black: new THREE.MeshStandardMaterial({ color: 0x111214, metalness: 0.2, roughness: 0.6 }),
  };
  /** The draws run one after another on this chain. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly assets: CarAssetLibrary) {}

  /**
   * The wheel's thumbnail as a data URL, or null when its GLB is missing or the garage closed first. `target` is
   * the car's front offset target (mm), so the tile shows the face where that car sets it (docs/carWheels.md,
   * Offset); the wheel's own bias applies either way.
   */
  thumb(entry: PartEntry, target?: number): Promise<string | null> {
    const key = `${entry.id}|${target ?? ''}`;
    let p = done.get(key);
    if (!p) {
      const next = this.queue.then(() => this.draw(entry, target)).catch(() => null);
      this.queue = next;
      p = next.then((url) => {
        if (!url) done.delete(key);
        return url;
      });
      done.set(key, p);
    }
    return p;
  }

  private setup(): THREE.WebGLRenderer {
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: true });
    r.setSize(THUMB.px, THUMB.px, false);
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    r.outputColorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(r);
    const room = new RoomEnvironment();
    this.env = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.env.texture;
    this.scene.environmentIntensity = 0.85;
    // A key from above the camera's shoulder, so the spokes model against the dish behind them.
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 1.5);
    this.scene.add(key);
    this.renderer = r;
    return r;
  }

  private async draw(entry: PartEntry, target?: number): Promise<string | null> {
    if (this.disposed) return null;
    const model = await this.assets.part(entry);
    if (!model || this.disposed) return null;
    const r = this.setup();
    // The wheel is rebuilt as plain meshes in the GLB's frame (wheel space: the center at the origin, the axle
    // along X, the face toward +X), the way the car view bakes it, so its face can be moved to the offset the
    // car sets without touching the cached GLB's geometry. The cap is the face's finish; the lip is polished or
    // the face's, as the wheel ships it.
    model.updateMatrixWorld(true);
    const parts: Unpacked[] = [];
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) parts.push(unpack(o));
    });
    // The house lug nuts, chrome, on the lug circle the catalog measured (the model is in the same space); they ride with the face.
    const lugs = entry.lugs ? lugsGeometry(entry.lugs) : null;
    const shift = this.faceShift(entry, parts, target);
    const shown = new THREE.Group();
    const geos: THREE.BufferGeometry[] = [];
    const add = (pos: Float32Array, nrm: Float32Array | null, material: THREE.Material, tire: boolean, rigid: boolean) => {
      const geo = new THREE.BufferGeometry();
      const p = Float32Array.from(pos);
      const n = nrm ? Float32Array.from(nrm) : null;
      if (shift.fit) remapWheel(pos, nrm, p, n, shift.profile, 1, 1, shift.fit, tire, rigid);
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      if (n) geo.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      geos.push(geo);
      shown.add(new THREE.Mesh(geo, material));
    };
    for (const part of parts) {
      const name = part.material.name;
      const material = this.materials[name === 'RimCap' ? 'Rim' : name === 'RimLip' ? (entry.lip === 'chrome' ? 'Chrome' : 'Rim') : name] ?? this.materials.Rim;
      add(part.pos, part.nrm, material, part.tire, false);
    }
    if (lugs) {
      add(lugs.getAttribute('position').array as Float32Array, (lugs.getAttribute('normal')?.array as Float32Array | undefined) ?? null, this.materials.Chrome, false, true);
      lugs.dispose();
    }
    // Framed on the tire's radius, not the bounding sphere: the sphere counts the width too and leaves the wheel small.
    const box = new THREE.Box3().setFromObject(shown);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dist = ((Math.max(size.y, size.z) / 2) * THUMB.fill) / Math.sin(((THUMB.fov / 2) * Math.PI) / 180);
    const c = Math.cos(THUMB.pitch);
    this.camera.position.set(Math.cos(THUMB.yaw) * c, Math.sin(THUMB.pitch), Math.sin(THUMB.yaw) * c).multiplyScalar(dist).add(center);
    this.camera.lookAt(center);
    this.scene.add(shown);
    r.render(this.scene, this.camera);
    // Read in the same task as the draw: the drawing buffer is not kept past it.
    const url = r.domElement.toDataURL('image/png');
    this.scene.remove(shown);
    for (const g of geos) g.dispose();
    return url;
  }

  /**
   * The face's move for the tile (docs/carWheels.md, Offset), as the car view works it out per axle: the wheel's
   * bias, plus on a multi-piece wheel with a stock offset the car's front target less that offset, clamped to what
   * the lip and barrel allow. The tile has no car, so mm are taken at the house wheel's scale (a 0.28 m tire; a
   * car's own scale is within a tenth of it). No fit when nothing moves, so most tiles draw the GLB as is.
   */
  private faceShift(entry: PartEntry, parts: Unpacked[], target?: number): { fit: WidthFit | null; profile: { outer: number; bead: number } } {
    let d = (entry.offsetBias ?? 0) / 1000;
    if (entry.construction === 'multi' && entry.offset !== undefined && target !== undefined) d += target / 1000 - entry.offset;
    if (d === 0) return { fit: null, profile: { outer: 1, bead: 1 } };
    const tireR: number[] = [], faceR: number[] = [], faceX: number[] = [], ringX: number[] = [];
    for (const part of parts) {
      for (let i = 0; i < part.pos.length; i += 3) {
        const r = Math.hypot(part.pos[i + 1], part.pos[i + 2]);
        if (part.tire) tireR.push(r);
        else if (part.ring) ringX.push(part.pos[i]), faceR.push(r);
        else faceX.push(part.pos[i]), faceR.push(r);
      }
    }
    const profile = detectProfile(tireR, faceR);
    const face = detectFaceFit(faceX, faceR.slice(0, faceX.length), ringX, profile.bead);
    const [lo, hi] = faceRange(face);
    const shift = Math.min(hi, Math.max(lo, d));
    return { fit: { spokeBack: 0, back: 0, tireMin: 0, tireMax: 0, tirePull: 0, cover: 1, face, shift }, profile };
  }

  dispose(): void {
    this.disposed = true;
    for (const m of Object.values(this.materials)) m.dispose();
    this.env?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
}
