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
 * them at once.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CarAssetLibrary } from '../render/car/carAssets';
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

/** The finished images by wheel id, kept for the session; a failed draw is dropped so a later garage tries again. */
const done = new Map<string, Promise<string | null>>();

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

  /** The wheel's thumbnail as a data URL, or null when its GLB is missing or the garage closed first. */
  thumb(entry: PartEntry): Promise<string | null> {
    let p = done.get(entry.id);
    if (!p) {
      const next = this.queue.then(() => this.draw(entry)).catch(() => null);
      this.queue = next;
      p = next.then((url) => {
        if (!url) done.delete(entry.id);
        return url;
      });
      done.set(entry.id, p);
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

  private async draw(entry: PartEntry): Promise<string | null> {
    if (this.disposed) return null;
    const model = await this.assets.part(entry);
    if (!model || this.disposed) return null;
    const r = this.setup();
    // The clone shares the cached GLB's geometry: only its materials are swapped, and nothing of it is disposed.
    model.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        // The cap is the face's finish; the lip is polished or the face's, as the wheel ships it.
        const pick = (m: THREE.Material) => this.materials[m.name === 'RimCap' ? 'Rim' : m.name === 'RimLip' ? (entry.lip === 'chrome' ? 'Chrome' : 'Rim') : m.name] ?? this.materials.Rim;
        o.material = Array.isArray(o.material) ? o.material.map(pick) : pick(o.material);
      }
    });
    // Wheel space: the center at the origin, the axle along X, the face toward +X.
    // Framed on the tire's radius, not the bounding sphere: the sphere counts the width too and leaves the wheel small.
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const dist = ((Math.max(size.y, size.z) / 2) * THUMB.fill) / Math.sin(((THUMB.fov / 2) * Math.PI) / 180);
    const c = Math.cos(THUMB.pitch);
    this.camera.position.set(Math.cos(THUMB.yaw) * c, Math.sin(THUMB.pitch), Math.sin(THUMB.yaw) * c).multiplyScalar(dist).add(center);
    this.camera.lookAt(center);
    this.scene.add(model);
    r.render(this.scene, this.camera);
    // Read in the same task as the draw: the drawing buffer is not kept past it.
    const url = r.domElement.toDataURL('image/png');
    this.scene.remove(model);
    return url;
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
