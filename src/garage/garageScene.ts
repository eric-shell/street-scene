/**
 * The garage showroom: car on a slowly rotating turntable, moody studio
 * lighting with neon tubes, glossy floor, orbit camera (drag to rotate,
 * pinch or scroll to zoom). Also turns a pointer position into a decal hit in
 * car space for vinyl placement. Render only.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GameRenderer } from '../render/scene';
import { CarView } from '../render/carView';
import { CarAssetLibrary } from '../render/carAssets';

export class GarageScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  readonly controls: OrbitControls;
  readonly turntable = new THREE.Group();
  car: CarView | null = null;
  spin = true;
  private time = 0;
  private disposables: { dispose(): void }[] = [];
  private ring: THREE.MeshBasicMaterial;
  private raycaster = new THREE.Raycaster();

  constructor(
    private readonly gr: GameRenderer,
    private readonly assets: CarAssetLibrary,
  ) {
    const s = this.scene;
    s.background = new THREE.Color(0x04050c);
    s.environment = gr.envMap;
    s.environmentIntensity = 0.5;
    s.fog = new THREE.Fog(0x04050c, 14, 40);
    const track = <T extends { dispose(): void }>(x: T) => (this.disposables.push(x), x);

    // Floor: glossy dark concrete.
    const floor = new THREE.Mesh(track(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2)), track(new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.55, metalness: 0.0 })));
    s.add(floor);
    // Turntable with a neon edge.
    const table = new THREE.Mesh(track(new THREE.CylinderGeometry(3.4, 3.5, 0.12, 64)), track(new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.35, metalness: 0.6 })));
    table.position.y = 0.06;
    this.turntable.add(table);
    this.ring = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x19e6ff).multiplyScalar(2.2) }));
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(3.45, 0.03, 8, 96).rotateX(Math.PI / 2)), this.ring);
    ring.position.y = 0.12;
    this.turntable.add(ring);
    s.add(this.turntable);
    // Neon tubes on the back walls and ceiling.
    const tube = (color: number, w: number, x: number, y: number, z: number, ry: number, rz = 0) => {
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.08, 0.08)), track(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6) })));
      m.position.set(x, y, z);
      m.rotation.set(0, ry, rz);
      s.add(m);
    };
    tube(0xff3df2, 8, 0, 4.2, -9, 0);
    tube(0x19e6ff, 8, 0, 3.6, -9, 0);
    tube(0x19e6ff, 6, -9, 3.2, -2, Math.PI / 2);
    tube(0xff3df2, 6, 9, 3.2, -2, Math.PI / 2);
    tube(0x19e6ff, 4, -6, 1.2, -8, 0.6, 0.9);
    tube(0xff3df2, 4, 6, 1.2, -8, -0.6, -0.9);
    const wall = new THREE.Mesh(track(new THREE.CylinderGeometry(10, 10, 9, 48, 1, true, Math.PI * 0.6, Math.PI * 1.8)), track(new THREE.MeshStandardMaterial({ color: 0x07080f, roughness: 0.9, side: THREE.BackSide })));
    wall.position.y = 4.5;
    s.add(wall);

    // Studio lights.
    s.add(new THREE.HemisphereLight(0x8090ff, 0x05050a, 0.22));
    const key = new THREE.SpotLight(0xffffff, 70, 30, 0.55, 0.6, 1.4);
    key.position.set(3, 8, 4);
    s.add(key, key.target);
    const rimC = new THREE.SpotLight(0x19e6ff, 14, 30, 0.5, 0.7, 1.4);
    rimC.position.set(-6, 6, -6);
    s.add(rimC, rimC.target);
    const rimM = new THREE.SpotLight(0xff3df2, 14, 30, 0.5, 0.7, 1.4);
    rimM.position.set(6, 6, -6);
    s.add(rimM, rimM.target);
    const fill = new THREE.PointLight(0xaab8ff, 4, 15, 1.5);
    fill.position.set(0, 2.5, 6);
    s.add(fill);

    this.camera.position.set(5.6, 2.1, 6.4);
    this.controls = new OrbitControls(this.camera, gr.canvas);
    this.controls.target.set(0, 0.65, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.2;
    this.controls.maxDistance = 11;
    this.controls.maxPolarAngle = 1.48;
    this.controls.addEventListener('start', () => (this.spin = false));
  }

  async setCar(carId: string, visual: Parameters<CarView['load']>[0]): Promise<CarView> {
    if (this.car && this.car.car.id === carId) {
      await this.car.applyVisual(visual);
      return this.car;
    }
    const old = this.car;
    const view = new CarView(carId, this.assets, { underglowLight: true });
    view.setHeadlightsEnabled(false);
    this.car = view;
    await view.load(visual);
    if (this.car !== view) {
      view.dispose();
      return this.car!;
    }
    old?.dispose();
    view.root.position.y = 0.12;
    this.turntable.add(view.root);
    return view;
  }

  /** Raycast the painted body; returns hit position and normal in model (car) space. */
  pick(clientX: number, clientY: number): { pos: [number, number, number]; normal: [number, number, number] } | null {
    if (!this.car) return null;
    const rect = this.gr.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.car.paintMeshes(), false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    const model = this.car.model;
    model.updateMatrixWorld(true);
    const p = model.worldToLocal(hit.point.clone());
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
    n.transformDirection(inv);
    return { pos: [p.x, p.y, p.z], normal: [n.x, n.y, n.z] };
  }

  render(dt: number): void {
    this.time += dt;
    if (this.spin) this.turntable.rotation.y += dt * 0.25;
    this.controls.update();
    this.ring.color.setRGB(0.1, 0.9, 1).multiplyScalar(1.2 + 0.3 * Math.sin(this.time * 2));
    if (this.car) {
      this.car.update(
        { x: 0, y: 0.12, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0.18, comp: [0, 0, 0, 0], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 },
        this.time,
      );
      this.car.root.position.set(0, 0.12, 0);
      this.car.root.rotation.set(0, 0, 0);
    }
    this.gr.post.setSpeedBlur(0);
    // The studio is small and bright: tame the bloom while we are here.
    const bloom = this.gr.post.bloom;
    const saved = bloom.strength;
    bloom.strength = saved * 0.45;
    this.gr.render(this.scene, this.camera, dt);
    bloom.strength = saved;
  }

  dispose(): void {
    this.controls.dispose();
    this.car?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
