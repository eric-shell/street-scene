/**
 * Loads the car manifest, parts catalog and GLB files (with Meshopt
 * decoding), caching each file once. Anything missing resolves to null so the
 * caller can fall back to the code-built placeholder.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import manifestJson from '../../assets/carManifest.json';
import catalogJson from '../../assets/partsCatalog.json';
import type { PartEntry, PartSlot, PartsCatalog } from '../../shared/parts';
import type { EngineSpec } from '../../shared/carSpec';

export interface ManifestCar {
  id: string;
  displayName: string;
  source: string;
  provisional: boolean;
  file: string;
  baseBodyNode: string;
  wheelNodes: string[];
  wheelRadius: number;
  wheelWidth: number;
  wheels: Record<'FL' | 'FR' | 'RL' | 'RR', number[]>;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  dimensions: { length: number; width: number; height: number };
  materialMap: Record<string, string>;
  defaultWheel: string;
  defaultPaint: string;
  /** Offered in the garage. */
  selectable?: boolean;
  /** Engine layout, aspiration and position (src/shared/carSpec.ts); the driven wheels come from drivingParams.json. */
  engine: EngineSpec;
  /** Each exhaust tip's opening in car space (m, x left, y up, z forward), where the nitrous and backfire flames sit; missing, a tip each side at the tail. */
  exhaustTips?: [number, number, number][];
}

export const MANIFEST = manifestJson as unknown as { version: number; cars: ManifestCar[] };
export const CATALOG = catalogJson as unknown as PartsCatalog;

export function manifestCar(id: string): ManifestCar {
  return MANIFEST.cars.find((c) => c.id === id) ?? MANIFEST.cars[0];
}

export function partsFor(carId: string, slot: PartSlot): PartEntry[] {
  return CATALOG.parts.filter((p) => p.slot === slot && (p.carId === carId || (slot === 'wheels' && p.carId === 'universal')));
}

export function partById(id: string): PartEntry | undefined {
  return CATALOG.parts.find((p) => p.id === id);
}

const base = import.meta.env.BASE_URL ?? '/';

export class CarAssetLibrary {
  private loader = new GLTFLoader();
  private files = new Map<string, Promise<THREE.Group | null>>();
  /** Parts loaded from drag and drop in dev mode, keyed by a generated id. */
  readonly devParts = new Map<string, { slot: PartSlot; object: THREE.Object3D; name: string }>();

  constructor() {
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  private loadFile(file: string): Promise<THREE.Group | null> {
    let p = this.files.get(file);
    if (!p) {
      p = this.loader
        .loadAsync(base + file)
        .then((g) => g.scene as THREE.Group)
        .catch(() => null);
      this.files.set(file, p);
    }
    return p;
  }

  /** Base car model (cloned), or null if the GLB is not present. */
  async carModel(carId: string): Promise<THREE.Object3D | null> {
    const car = manifestCar(carId);
    const scene = await this.loadFile(car.file);
    return scene ? scene.clone(true) : null;
  }

  /** A part object (cloned), or null when missing. */
  async part(entry: PartEntry): Promise<THREE.Object3D | null> {
    const dev = this.devParts.get(entry.id);
    if (dev) return dev.object.clone(true);
    const scene = await this.loadFile(entry.file);
    if (!scene) return null;
    if (entry.node) {
      const node = scene.getObjectByName(entry.node);
      if (!node) return null;
      // Bake the node's world transform so it sits in car space.
      scene.updateMatrixWorld(true);
      const clone = node.clone(true);
      clone.matrix.copy(node.matrixWorld);
      clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
      const holder = new THREE.Group();
      holder.add(clone);
      return holder;
    }
    return scene.clone(true);
  }

  async parseDropped(buffer: ArrayBuffer): Promise<THREE.Object3D> {
    const gltf = await this.loader.parseAsync(buffer, '');
    return gltf.scene;
  }

  /** Which cars have their GLB available (placeholder cars are always available). */
  async availability(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    await Promise.all(
      MANIFEST.cars.map(async (c) => {
        out[c.id] = (await this.loadFile(c.file)) !== null;
      }),
    );
    return out;
  }
}
