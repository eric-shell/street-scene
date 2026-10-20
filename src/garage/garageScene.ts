/**
 * The garage showroom, with two presentations:
 *  - Garage: car on a slowly rotating turntable, moody studio lighting with
 *    neon tubes, glossy floor.
 *  - Street: the car cruises through a road tunnel (see tunnel.ts); it stays
 *    put while the tunnel streams past, wheels spinning, lights on.
 * Both share the orbit camera (drag to rotate, pinch or scroll to zoom) and a
 * few camera presets. The engine can be revved in either: a free-rev model
 * drives the synthesized engine voice and rocks the body on its springs.
 * Also turns a pointer position into a decal hit in car space for vinyl
 * placement. Render only.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GameRenderer } from '../render/scene';
import { CarPose, CarView } from '../render/carView';
import { CarAssetLibrary } from '../render/carAssets';
import { EngineVoice, audioHub } from '../audio/engineAudio';
import { BlipScript, RevModel } from './revModel';
import { Tunnel } from './tunnel';
import type { Presentation } from './storage';

/** Camera presets in car space, scaled by car length. [position, target]. */
const CAMERAS: { name: string; pos: [number, number, number]; target: [number, number, number] }[] = [
  { name: 'Three quarter', pos: [4.3, 1.55, 5.0], target: [0, 0.6, 0.1] },
  { name: 'Low side', pos: [4.6, 0.5, 0.5], target: [0, 0.55, 0] },
  { name: 'Wheel', pos: [2.5, 0.42, 2.7], target: [0.6, 0.38, 1.2] },
  { name: 'Rear', pos: [-3.5, 1.45, -4.6], target: [0, 0.65, 0] },
  { name: 'Front', pos: [0.6, 1.1, 5.4], target: [0, 0.6, 0] },
];

const WHEEL_KEYS = ['FL', 'FR', 'RL', 'RR'] as const;
/** Street: cruise speed and the speed full throttle builds up to (m/s). */
const CRUISE = 17;
const SPRINT = 30;
/** Expansion joints in the tunnel road (m apart) and their height (m). */
const JOINT_GAP = 24;
const JOINT_H = 0.012;

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
  private showroom = new THREE.Group();
  private tunnel: Tunnel | null = null;
  private mode: Presentation = 'garage';
  // Street motion.
  private distance = 0;
  private speed = CRUISE;
  private wheelSpin = 0;
  private heave = 0;
  private heaveVel = 0;
  private bodyPitch = 0;
  private bodyPitchVel = 0;
  // Camera presets and the tween between them.
  private camIndex = 0;
  private camTween: { from: THREE.Vector3; fromT: THREE.Vector3; to: THREE.Vector3; toT: THREE.Vector3; t: number } | null = null;
  private lastInteraction = -100;
  // Engine.
  private rev = new RevModel({ idle: 900, redline: 7200 });
  private blipScript = new BlipScript();
  private gasHeld = 0;
  private voice: EngineVoice | null = null;
  private voiceCar = '';
  private audioOk = false;
  private engineVolume = 0.7;
  private quietFor = 0;

  constructor(
    private readonly gr: GameRenderer,
    private readonly assets: CarAssetLibrary,
  ) {
    const s = this.scene;
    s.environment = gr.envMap;
    s.environmentIntensity = 0.5;
    const track = <T extends { dispose(): void }>(x: T) => (this.disposables.push(x), x);
    const room = this.showroom;

    // Floor: glossy dark concrete.
    const floor = new THREE.Mesh(track(new THREE.CircleGeometry(30, 64).rotateX(-Math.PI / 2)), track(new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.55, metalness: 0.0 })));
    room.add(floor);
    // Turntable with a neon edge.
    const table = new THREE.Mesh(track(new THREE.CylinderGeometry(3.4, 3.5, 0.12, 64)), track(new THREE.MeshStandardMaterial({ color: 0x15171f, roughness: 0.35, metalness: 0.6 })));
    table.position.y = 0.06;
    this.turntable.add(table);
    this.ring = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0x19e6ff).multiplyScalar(2.2) }));
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(3.45, 0.03, 8, 96).rotateX(Math.PI / 2)), this.ring);
    ring.position.y = 0.12;
    this.turntable.add(ring);
    room.add(this.turntable);
    // Neon tubes on the back walls and ceiling.
    const tube = (color: number, w: number, x: number, y: number, z: number, ry: number, rz = 0) => {
      const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, 0.08, 0.08)), track(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6) })));
      m.position.set(x, y, z);
      m.rotation.set(0, ry, rz);
      room.add(m);
    };
    tube(0xff3df2, 8, 0, 4.2, -9, 0);
    tube(0x19e6ff, 8, 0, 3.6, -9, 0);
    tube(0x19e6ff, 6, -9, 3.2, -2, Math.PI / 2);
    tube(0xff3df2, 6, 9, 3.2, -2, Math.PI / 2);
    tube(0x19e6ff, 4, -6, 1.2, -8, 0.6, 0.9);
    tube(0xff3df2, 4, 6, 1.2, -8, -0.6, -0.9);
    const wall = new THREE.Mesh(track(new THREE.CylinderGeometry(10, 10, 9, 48, 1, true, Math.PI * 0.6, Math.PI * 1.8)), track(new THREE.MeshStandardMaterial({ color: 0x07080f, roughness: 0.9, side: THREE.BackSide })));
    wall.position.y = 4.5;
    room.add(wall);

    // Studio lights.
    room.add(new THREE.HemisphereLight(0x8090ff, 0x05050a, 0.22));
    const key = new THREE.SpotLight(0xffffff, 70, 30, 0.55, 0.6, 1.4);
    key.position.set(3, 8, 4);
    room.add(key, key.target);
    const rimC = new THREE.SpotLight(0x19e6ff, 14, 30, 0.5, 0.7, 1.4);
    rimC.position.set(-6, 6, -6);
    room.add(rimC, rimC.target);
    const rimM = new THREE.SpotLight(0xff3df2, 14, 30, 0.5, 0.7, 1.4);
    rimM.position.set(6, 6, -6);
    room.add(rimM, rimM.target);
    const fill = new THREE.PointLight(0xaab8ff, 4, 15, 1.5);
    fill.position.set(0, 2.5, 6);
    room.add(fill);
    s.add(room);

    this.camera.position.set(5.6, 2.1, 6.4);
    this.controls = new OrbitControls(this.camera, gr.canvas);
    this.controls.target.set(0, 0.65, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.addEventListener('start', () => {
      this.spin = false;
      this.camTween = null;
      this.lastInteraction = this.time;
    });
    this.applyMode();
  }

  get presentation(): Presentation {
    return this.mode;
  }

  /** Switch between the turntable showroom and the tunnel cruise. */
  setPresentation(p: Presentation): void {
    if (p === this.mode) return;
    this.mode = p;
    this.applyMode();
    if (p === 'street') this.setCamera(0);
    else {
      this.camTween = null;
      this.camera.position.set(5.6, 2.1, 6.4);
      this.controls.target.set(0, 0.65, 0);
      this.spin = true;
    }
  }

  private applyMode(): void {
    const street = this.mode === 'street';
    const s = this.scene;
    if (street && !this.tunnel) {
      this.tunnel = new Tunnel();
      s.add(this.tunnel.group);
    }
    if (this.tunnel) this.tunnel.group.visible = street;
    this.showroom.visible = !street;
    s.background = new THREE.Color(street ? 0x06060a : 0x04050c);
    s.fog = street ? new THREE.Fog(0x06060a, 22, 70) : new THREE.Fog(0x04050c, 14, 40);
    s.environmentIntensity = street ? 0.35 : 0.5;
    const c = this.controls;
    // Street: stay inside the tunnel (walls at 6.5 m, ceiling at 5.8 m).
    c.minDistance = street ? 1.8 : 3.2;
    c.maxDistance = street ? 5.6 : 11;
    c.minPolarAngle = street ? 0.62 : 0;
    c.maxPolarAngle = street ? 1.52 : 1.48;
    if (this.car) this.mountCar(this.car);
  }

  private mountCar(view: CarView): void {
    view.setHeadlightsEnabled(this.mode === 'street');
    if (this.mode === 'street') this.scene.add(view.root);
    else this.turntable.add(view.root);
  }

  /** Cycle (or pick) a camera preset; returns its name. */
  setCamera(index = this.camIndex + 1): string {
    this.camIndex = ((index % CAMERAS.length) + CAMERAS.length) % CAMERAS.length;
    const c = CAMERAS[this.camIndex];
    const k = this.car ? this.car.car.dimensions.length / 4.45 : 1;
    const to = new THREE.Vector3(...c.pos).multiplyScalar(k);
    const toT = new THREE.Vector3(...c.target).multiplyScalar(k);
    if (this.mode === 'garage') {
      // Presets are in car space; the turntable rotates the car.
      this.turntable.updateMatrixWorld();
      to.applyMatrix4(this.turntable.matrixWorld);
      toT.applyMatrix4(this.turntable.matrixWorld);
      to.y = Math.max(to.y, 0.6);
      to.setLength(Math.max(to.length(), this.controls.minDistance + 0.3));
    }
    this.camTween = { from: this.camera.position.clone(), fromT: this.controls.target.clone(), to, toT, t: 0 };
    this.lastInteraction = this.time;
    return c.name;
  }

  async setCar(carId: string, visual: Parameters<CarView['load']>[0]): Promise<CarView> {
    if (this.car && this.car.car.id === carId) {
      await this.car.applyVisual(visual);
      return this.car;
    }
    const old = this.car;
    const view = new CarView(carId, this.assets, { underglowLight: true, headlights: true, envMap: this.gr.envMap });
    this.car = view;
    await view.load(visual);
    if (this.car !== view) {
      view.dispose();
      return this.car!;
    }
    old?.dispose();
    this.mountCar(view);
    return view;
  }

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  /** Engine limits for the current build (from its tuning). */
  setEngine(idle: number, redline: number): void {
    this.rev.configure({ idle, redline, rest: this.restRpm(idle, redline) });
  }

  private restRpm(idle: number, redline: number): number {
    return this.mode === 'street' ? idle + 0.28 * (redline - idle) : idle;
  }

  setEngineVolume(v: number): void {
    this.engineVolume = v;
    if (this.audioOk) audioHub()?.setVolume(v);
  }

  /**
   * Call from a user gesture (click, tap, key). Browsers only let an
   * AudioContext start after one, so engine sound waits for this.
   */
  unlockAudio(): void {
    if (this.audioOk || this.engineVolume <= 0) return;
    const hub = audioHub();
    if (!hub) return;
    if (hub.ctx.state !== 'running') void hub.ctx.resume();
    hub.setVolume(this.engineVolume);
    this.audioOk = true;
  }

  /** Hold the gas (0..1). */
  setGas(x: number): void {
    this.gasHeld = x;
  }

  /** A short scripted double blip, e.g. when a car is picked. */
  blip(): void {
    this.blipScript.start();
  }

  private ensureVoice(): EngineVoice | null {
    if (!this.audioOk || !this.car || this.engineVolume <= 0) return null;
    if (this.voice && this.voiceCar === this.car.car.id) return this.voice;
    this.voice?.dispose();
    this.voice = null;
    try {
      this.voice = new EngineVoice(this.car.car.engine?.type ?? 'i4', 0.3);
      this.voiceCar = this.car.car.id;
    } catch {
      this.audioOk = false;
    }
    return this.voice;
  }

  private updateEngine(dt: number): void {
    const street = this.mode === 'street';
    this.rev.rest = this.restRpm(this.rev.idle, this.rev.redline);
    const throttle = Math.max(this.gasHeld, this.blipScript.step(dt));
    this.rev.step(dt, throttle, street ? 0.45 : 1);
    // Garage: the engine falls silent a few seconds after the last blip.
    const busy = street || throttle > 0 || Math.abs(this.rev.rpm - this.rev.rest) > 40;
    this.quietFor = busy ? 0 : this.quietFor + dt;
    if (this.quietFor > 3.5) {
      this.voice?.silence();
      return;
    }
    const voice = this.ensureVoice();
    voice?.update({
      rpm: this.rev.rpm,
      redline: this.rev.redline,
      throttle: street ? Math.max(0.22, this.rev.throttle) : this.rev.throttle,
      nitro: false,
      // Idling in the showroom stays a quiet burble.
      proximity: street ? 0.8 : 0.6 + 0.4 * Math.min(1, this.rev.throttle * 2 + (this.rev.rpm - this.rev.idle) / 3000),
      pan: 0,
    });
  }

  // -------------------------------------------------------------------------

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

  private updateCamera(dt: number): void {
    const tw = this.camTween;
    if (tw) {
      tw.t = Math.min(1, tw.t + dt / 1.1);
      const e = tw.t * tw.t * (3 - 2 * tw.t);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (tw.t >= 1) this.camTween = null;
    } else if (this.mode === 'street' && this.time - this.lastInteraction > 10) {
      // Slow auto tour of the angles while nobody is touching the camera.
      this.setCamera();
    }
    this.controls.update();
  }

  render(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const street = this.mode === 'street';
    if (this.spin && !street) this.turntable.rotation.y += dt * 0.25;
    this.updateEngine(dt);
    this.updateCamera(dt);
    this.ring.color.setRGB(0.1, 0.9, 1).multiplyScalar(1.2 + 0.3 * Math.sin(this.time * 2));

    const view = this.car;
    if (view) {
      const car = view.car;
      // Road under each wheel (street only): expansion joints and a faint ripple.
      const road = WHEEL_KEYS.map((k) => {
        if (!street) return 0;
        const z = this.distance + car.wheels[k][2];
        const j = (((z % JOINT_GAP) + JOINT_GAP) % JOINT_GAP) - JOINT_GAP / 2;
        return JOINT_H * Math.exp(-((j / 0.18) ** 2)) + 0.0015 * Math.sin(z * 2.3 + car.wheels[k][0] * 3);
      });
      if (street) {
        // Gas builds speed a little; lift and it settles back to the cruise.
        const target = CRUISE + (SPRINT - CRUISE) * Math.max(0, (this.rev.rpm - this.rev.rest) / (this.rev.redline - this.rev.rest));
        this.speed += (target - this.speed) * Math.min(1, dt * 0.6);
        this.distance += this.speed * dt;
        this.wheelSpin = (this.wheelSpin + (this.speed / car.wheelRadius) * dt) % (Math.PI * 2);
        this.tunnel?.update(this.distance);
      }
      // Body on its springs: heave and pitch follow the road, roll and squat come from the engine.
      const front = (road[0] + road[1]) / 2;
      const rear = (road[2] + road[3]) / 2;
      const w = 2 * Math.PI * 1.8;
      this.heaveVel += (w * w * ((front + rear) / 2 - this.heave) - 2 * 0.35 * w * this.heaveVel) * dt;
      this.heave += this.heaveVel * dt;
      const pitchTarget = -(front - rear) / Math.max(1, car.wheelbase);
      this.bodyPitchVel += (w * w * (pitchTarget - this.bodyPitch) - 2 * 0.35 * w * this.bodyPitchVel) * dt;
      this.bodyPitch += this.bodyPitchVel * dt;
      const roll = this.rev.roll;
      const pitch = this.rev.pitch + this.bodyPitch;
      const base = street ? 0 : 0.12;
      // Wheels stay on the road: cancel the body motion CarView would carry them along with.
      const comp = WHEEL_KEYS.map((k, i) => {
        const p = car.wheels[k];
        return road[i] - this.heave - (p[0] * roll - p[2] * pitch);
      });
      const pose: CarPose = {
        x: 0,
        y: base + this.heave,
        z: 0,
        yaw: 0,
        pitch,
        roll,
        steer: street ? 0 : 0.18,
        comp,
        spin: [this.wheelSpin, this.wheelSpin, this.wheelSpin, this.wheelSpin],
        braking: false,
        nitro: false,
        speed: street ? this.speed : 0,
      };
      view.update(pose, this.time);
    }
    this.gr.post.setSpeedBlur(0);
    // The studio is small and bright: tame the bloom while we are here.
    const bloom = this.gr.post.bloom;
    const saved = bloom.strength;
    bloom.strength = saved * (street ? 0.7 : 0.45);
    this.gr.render(this.scene, this.camera, dt);
    bloom.strength = saved;
  }

  dispose(): void {
    this.controls.dispose();
    this.voice?.dispose();
    this.voice = null;
    this.car?.dispose();
    this.tunnel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
