/**
 * The garage's 3D view, with two presentations:
 *  - Garage: the car on the turntable in the middle of the workshop
 *    (garage/showroom.ts), turning slowly under the fluorescent battens among
 *    the lifts and the other builds.
 *  - Street: the car cruising the event city (game/streetStage.ts, the same
 *    street and car the main menu shows); revving lifts the cruise toward a
 *    sprint, and the orbit camera rides along (game/streetCameras.ts).
 * Both share the orbit camera (drag to rotate, pinch or scroll to zoom) and a
 * few camera presets in car space; the garage UI frames the view beside its
 * rail. The engine can be revved in either: a free-rev model drives the
 * synthesized engine voice and rocks the body on its springs. Also turns a
 * pointer position into a decal hit in car space for vinyl placement. Render
 * only.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GameRenderer } from '../render/scene';
import { CarPose, CarView, WHEEL_KEYS } from '../render/car/carView';
import { CarAssetLibrary } from '../render/car/carAssets';
import { EngineVoice, audioHub } from '../audio/engineAudio';
import { BlipScript, REV_LEVEL, RevModel, revVoice } from './revModel';
import { ROOM, Showroom } from './showroom';
import { FollowOrbit } from '../game/streetCameras';
import type { StreetStage } from '../game/streetStage';
import type { Presentation } from './storage';
import type { Quality } from '../ui/settings';
import { smoothstep } from '../sim/math';

/** Camera presets in car space (x left, y up, z forward; m for a 4.45 m car, scaled by length): position and target. */
const CAMERAS: { name: string; pos: [number, number, number]; target: [number, number, number] }[] = [
  { name: 'Three quarter', pos: [4.6, 1.5, 5.6], target: [0, 0.6, 0.1] },
  { name: 'Low side', pos: [4.7, 0.55, 0.5], target: [0, 0.55, 0] },
  { name: 'Wheel', pos: [2.5, 0.42, 2.7], target: [0.6, 0.38, 1.2] },
  { name: 'Rear', pos: [-3.5, 1.45, -4.6], target: [0, 0.65, 0] },
  { name: 'Front', pos: [0.6, 1.1, 5.4], target: [0, 0.6, 0] },
];

/** How fast the turntable turns (rad/s). */
const SPIN = 0.22;
/** The street view's auto tour: the next angle after this long without a touch (s). */
const TOUR = 10;
/** A camera preset is reached over this long (s). */
const TWEEN = 1.1;
/** In the showroom the engine falls silent this long after the last blip (s). */
const QUIET = 3.5;
/** The showroom is small and full of lights: the bloom is tamed to this share while it is on screen. */
const ROOM_BLOOM = 0.42;
/** The orbit camera's reach in each presentation: distance (m) and polar angle (rad) limits. */
const ORBIT: Record<Presentation, Pick<OrbitControls, 'minDistance' | 'maxDistance' | 'minPolarAngle' | 'maxPolarAngle'>> = {
  garage: { minDistance: 3.2, maxDistance: 8.4, minPolarAngle: 0.35, maxPolarAngle: 1.47 },
  street: { minDistance: 2.2, maxDistance: 7, minPolarAngle: 0.45, maxPolarAngle: 1.5 },
};
/**
 * Lens: the vertical field of view (deg) on a landscape screen, widened on a
 * portrait one (a phone) so the car still fits across, up to `max`.
 */
const LENS = { fov: 40, minAcross: 36, max: 66 } as const;

export class GarageScene {
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2500);
  readonly controls: OrbitControls;
  /** The car on the turntable, or the one about to replace it while it loads (the street has its own, kept in step by setCar). */
  car: CarView | null = null;
  /** The car standing on the turntable now; `car` differs while a new one loads. */
  private mounted: CarView | null = null;
  spin = true;
  private time = 0;
  private readonly showroom: Showroom;
  private readonly follow = new FollowOrbit();
  private readonly raycaster = new THREE.Raycaster();
  private mode: Presentation = 'garage';
  private readonly pose: CarPose = { x: 0, y: ROOM.tableTop, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0.18, comp: [0, 0, 0, 0], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 };
  // Camera presets and the tween between them (in car space on the street, world space in the showroom).
  private camIndex = 0;
  private camTween: { from: THREE.Vector3; fromT: THREE.Vector3; to: THREE.Vector3; toT: THREE.Vector3; t: number; local: boolean } | null = null;
  private lastInteraction = -100;
  private readonly onResize = () => this.showroom.resize(this.gr.renderer, this.quality);
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
    private readonly street: StreetStage,
    private readonly quality: Quality,
  ) {
    this.showroom = new Showroom(gr.renderer, quality, assets);
    this.controls = new OrbitControls(this.camera, gr.canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.addEventListener('start', () => {
      this.spin = false;
      this.camTween = null;
      this.lastInteraction = this.time;
    });
    window.addEventListener('resize', this.onResize);
    this.applyMode();
    this.homeCamera();
  }

  get presentation(): Presentation {
    return this.mode;
  }

  /** Switch between the turntable showroom and the street. */
  setPresentation(p: Presentation): void {
    if (p === this.mode) return;
    this.mode = p;
    this.applyMode();
    this.homeCamera();
  }

  private applyMode(): void {
    Object.assign(this.controls, ORBIT[this.mode]);
    this.follow.reset();
  }

  /** Each presentation opens on the three quarter view; the showroom spins again. */
  private homeCamera(): void {
    this.camTween = null;
    this.camIndex = 0;
    const c = CAMERAS[0];
    const k = this.lengthScale();
    const pos = new THREE.Vector3(...c.pos).multiplyScalar(k);
    const target = new THREE.Vector3(...c.target).multiplyScalar(k);
    if (this.mode === 'street') {
      this.toWorld(pos);
      this.toWorld(target);
    } else this.spin = true;
    this.camera.position.copy(pos);
    this.controls.target.copy(target);
    this.lastInteraction = this.time;
  }

  private lengthScale(): number {
    return this.car ? this.car.car.dimensions.length / 4.45 : 1;
  }

  /** Car space to world on the street (in place). */
  private toWorld(v: THREE.Vector3): THREE.Vector3 {
    const p = this.street.pose;
    const s = Math.sin(p.yaw);
    const c = Math.cos(p.yaw);
    return v.set(p.x + v.x * c + v.z * s, p.y + v.y, p.z - v.x * s + v.z * c);
  }

  /** World to car space on the street (in place). */
  private toLocal(v: THREE.Vector3): THREE.Vector3 {
    const p = this.street.pose;
    const s = Math.sin(p.yaw);
    const c = Math.cos(p.yaw);
    const dx = v.x - p.x;
    const dz = v.z - p.z;
    return v.set(dx * c - dz * s, v.y - p.y, dx * s + dz * c);
  }

  /** Cycle (or pick) a camera preset; returns its name. */
  setCamera(index = this.camIndex + 1): string {
    this.camIndex = ((index % CAMERAS.length) + CAMERAS.length) % CAMERAS.length;
    const c = CAMERAS[this.camIndex];
    const k = this.lengthScale();
    const to = new THREE.Vector3(...c.pos).multiplyScalar(k);
    const toT = new THREE.Vector3(...c.target).multiplyScalar(k);
    if (this.mode === 'street') {
      this.camTween = { from: this.toLocal(this.camera.position.clone()), fromT: this.toLocal(this.controls.target.clone()), to, toT, t: 0, local: true };
    } else {
      // Presets are in car space; the turntable turns the car.
      this.showroom.turntable.updateMatrixWorld();
      to.applyMatrix4(this.showroom.turntable.matrixWorld);
      toT.applyMatrix4(this.showroom.turntable.matrixWorld);
      to.y = Math.max(to.y, 0.6);
      to.setLength(Math.max(to.length(), this.controls.minDistance + 0.3));
      this.camTween = { from: this.camera.position.clone(), fromT: this.controls.target.clone(), to, toT, t: 0, local: false };
    }
    this.lastInteraction = this.time;
    return c.name;
  }

  /**
   * Show a build: the turntable's car (swapped when the car changes, otherwise
   * repainted and re-parted in place) and the street's. A new car takes the
   * turntable once it has loaded, unless a newer one was asked for meanwhile
   * (that one disposes itself); the car it replaces is disposed then.
   */
  async setCar(carId: string, visual: Parameters<CarView['load']>[0]): Promise<CarView> {
    void this.street.setBuild({ carId, visual });
    if (this.car && this.car.car.id === carId) {
      // load(), not applyVisual(): it also finishes the first load if that one is still running.
      await this.car.load(visual);
      return this.car;
    }
    const view = new CarView(carId, this.assets, { underglowLight: true, envMap: this.showroom.envMap });
    view.setHeadlightsEnabled(false);
    this.car = view;
    await view.load(visual);
    if (this.car !== view) {
      view.dispose();
      return this.car ?? view;
    }
    this.mounted?.dispose();
    this.mounted = view;
    this.showroom.mount(view);
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
      this.voice = new EngineVoice(this.car.car.engine, REV_LEVEL.base);
      this.voiceCar = this.car.car.id;
      this.voice.onPop = (pipe, size, delay) => this.car?.popFlash(pipe, size, delay);
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
    if (this.quietFor > QUIET) {
      this.voice?.silence();
      return;
    }
    const voice = this.ensureVoice();
    // Quiet at rest (a burble in the showroom, a low hum on the Street view's cruise), swelling with the revs.
    const level = revVoice(this.mode, this.rev.rpm, this.rev.rest, this.rev.redline, this.rev.throttle);
    voice?.update({
      rpm: this.rev.rpm,
      redline: this.rev.redline,
      throttle: level.throttle,
      nitro: false,
      proximity: level.proximity,
      pan: 0,
      dt,
    });
  }

  // -------------------------------------------------------------------------

  /** Raycast the painted body of the turntable's car; returns hit position and normal in model (car) space. */
  pick(clientX: number, clientY: number): { pos: [number, number, number]; normal: [number, number, number] } | null {
    if (!this.car || this.mode !== 'garage') return null;
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
      tw.t = Math.min(1, tw.t + dt / TWEEN);
      const e = smoothstep(0, 1, tw.t);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (tw.local) {
        this.toWorld(this.camera.position);
        this.toWorld(this.controls.target);
      }
      if (tw.t >= 1) this.camTween = null;
    } else if (this.mode === 'street' && this.time - this.lastInteraction > TOUR) {
      // Slow auto tour of the angles while nobody is touching the camera.
      this.setCamera();
    }
    this.controls.update();
  }

  /** Widen the lens on a portrait screen: keep at least LENS.minAcross degrees across. */
  private fitLens(): void {
    const aspect = this.gr.aspect;
    const across = (2 * Math.atan(aspect * Math.tan((LENS.fov * Math.PI) / 360)) * 180) / Math.PI;
    const fov = across >= LENS.minAcross ? LENS.fov : Math.min(LENS.max, (2 * Math.atan(Math.tan((LENS.minAcross * Math.PI) / 360) / aspect) * 180) / Math.PI);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  render(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.fitLens();
    this.updateEngine(dt);
    const rev = this.rev;
    if (this.mode === 'street') {
      // Revving lifts the cruise toward a sprint, and the body rocks with the engine as in the showroom.
      const throttle = Math.max(0, Math.min(1, (rev.rpm - rev.rest) / Math.max(1, rev.redline - rev.rest)));
      this.street.step(dt, { throttle, lean: { pitch: rev.pitch, roll: rev.roll } });
      this.follow.follow(this.camera, this.controls, this.street.pose);
      this.updateCamera(dt);
      this.street.render(this.gr, this.follow.resolve(this.camera, this.controls.target, this.street.world), dt);
      return;
    }
    if (this.spin) this.showroom.turntable.rotation.y += dt * SPIN;
    this.showroom.update(dt);
    const view = this.car;
    if (view) {
      // Parked in neutral: the wheels stay on the turntable while the body rocks with the revs.
      const p = this.pose;
      p.pitch = rev.pitch;
      p.roll = rev.roll;
      for (let i = 0; i < 4; i++) {
        const w = view.car.wheels[WHEEL_KEYS[i]];
        p.comp[i] = -(w[0] * p.roll - w[2] * p.pitch);
      }
      view.update(p, this.time);
    }
    this.updateCamera(dt);
    // The orbit stays inside the room (it would otherwise rise through the ceiling looking down).
    this.showroom.contain(this.camera.position, this.controls.target);
    this.gr.post.setSpeedBlur(0);
    const bloom = this.gr.post.bloom;
    const saved = bloom.strength;
    bloom.strength = saved * ROOM_BLOOM;
    this.gr.render(this.showroom.scene, this.camera, dt);
    bloom.strength = saved;
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.voice?.dispose();
    this.voice = null;
    // A car still loading disposes itself when it lands (it is no longer `car`).
    this.car = null;
    this.mounted?.dispose();
    this.mounted = null;
    this.showroom.dispose();
  }
}
