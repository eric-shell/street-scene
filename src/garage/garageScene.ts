/**
 * The garage's 3D view, with three presentations:
 *  - Garage: the car on the turntable in the middle of the workshop
 *    (garage/showroom.ts), turning slowly under the fluorescent battens among
 *    the lifts and the other builds.
 *  - Dyno: the car strapped to the workshop's chassis dyno, its driven axle over
 *    the rollers (the customer's car and straps make way). Holding the gas runs
 *    a pull: the revs climb under load from idle to the redline in a few seconds
 *    (garage/revModel.ts), the driven wheels spin on the drum, the giant fan
 *    spools up and the wall screen draws the car's power and torque curves,
 *    from the sim's own torque curve (garage/dynoRun.ts), up to the peak
 *    figures, which a toast repeats.
 *  - Street: the car cruising the event city (game/streetStage.ts, the same
 *    street and car the main menu shows); revving lifts the cruise toward a
 *    sprint, and the orbit camera rides along (game/streetCameras.ts).
 * All share the orbit camera (drag to rotate, pinch or scroll to zoom) and a
 * few camera presets in car space (the dyno has its own); the garage UI frames
 * the view beside its rail. The room follows what is being edited: each
 * Customize tab frames its own shot (`frame`), the Neon tab takes the room's
 * lights down, and on the Builds step, left alone, the camera tours the car in
 * slow drifting shots over the turning turntable. The engine can be revved in
 * any: a free-rev model drives the synthesized engine voice and rocks the body
 * on its springs. On the turntable the steering keys turn the front wheels,
 * straight ahead at rest. The shop's sound bed (audio/garageAmbience.ts) is
 * fed from here with where the camera is and what the room is doing. Also
 * turns a pointer position into a decal hit in car space for vinyl placement.
 * Render only.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GameRenderer } from '../render/scene';
import { CarPose, CarView, WHEEL_KEYS } from '../render/car/carView';
import { CarAssetLibrary } from '../render/car/carAssets';
import { EngineVoice, audioHub } from '../audio/engineAudio';
import { BlipScript, REV_LEVEL, RevModel, revVoice, type TwoStep } from './revModel';
import { PULL, pullLoad } from './dynoRun';
import type { DynoSetup } from './dynoRun';
import type { DynoPeaks, DynoRun } from './textures/effects';
import { ROOM, Showroom } from './showroom';
import { FollowOrbit } from '../game/streetCameras';
import type { StreetStage } from '../game/streetStage';
import type { Presentation } from './storage';
import type { Quality } from '../ui/settings';
import type { PartSlot } from '../shared/parts';
import { GarageAmbience } from '../audio/garageAmbience';
import type { GarageSoundState } from '../audio/garageAmbience';
import { prefersReducedMotion } from '../ui/kit/dom';
import { TAU, clamp01, smoothstep } from '../sim/math';

interface CameraPreset {
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
}

/** Camera presets in car space (x left, y up, z forward; m for a 4.45 m car, scaled by length): position and target. */
const CAMERAS: CameraPreset[] = [
  { name: 'Three quarter', pos: [4.6, 1.5, 5.6], target: [0, 0.6, 0.1] },
  { name: 'Low side', pos: [4.7, 0.55, 0.5], target: [0, 0.55, 0] },
  { name: 'Wheel', pos: [2.5, 0.42, 2.7], target: [0.6, 0.38, 1.2] },
  { name: 'Rear', pos: [-3.5, 1.45, -4.6], target: [0, 0.65, 0] },
  { name: 'Front', pos: [0.6, 1.1, 5.4], target: [0, 0.6, 0] },
];
/**
 * The dyno's presets, in car space like the others. The car stands 4 m from the right wall with its nose at
 * the fan, the absorber and the operator on its left at the tail, so the shots keep clear of them: a three
 * quarter from the nose-left, the tail from above the operator, the front wheel, the driven wheel from the
 * wall side (low, close, the rollers under it; z flips on a front drive) and the wall screen from high on the
 * car's left, across its roof (from behind, the operator and the exhaust hose stood in the shot).
 */
const DYNO_CAMERAS: CameraPreset[] = [
  { name: 'Three quarter', pos: [5.0, 1.6, 4.3], target: [0, 0.55, 0] },
  { name: 'Rear quarter', pos: [1.0, 1.8, -4.6], target: [0, 0.5, -1.5] },
  { name: 'Wheel', pos: [2.5, 0.42, 2.7], target: [0.6, 0.38, 1.2] },
  { name: 'Rollers', pos: [-3.0, 0.5, -2.2], target: [-0.8, 0.35, -1.3] },
  { name: 'Screen', pos: [2.4, 2.0, -1.0], target: [-4.5, 1.7, 0.1] },
];
/** The dyno's preset that flips z with the driven axle. */
const ROLLERS_PRESET = 'Rollers';

/** What a Customize tab asks the room to show: the tab, or the Body tab with the slot on show. */
export type TabFrame = 'model' | 'stance' | 'wheels' | 'paint' | 'vinyl' | 'tint' | 'neon' | 'tune' | `body:${PartSlot}`;

/**
 * The shots the Customize tabs frame, in car space like CAMERAS (a name found there reuses that preset), and
 * whether the turntable keeps turning under them: an edit is shown from where it reads best, the spin stopped
 * where the eye has to hold still (a wheel, a stance, a part) and kept where it helps (paint and tint, whose
 * reflections slide over the car as it turns; neon, so the underglow sweeps the floor).
 */
const FRAMES: Record<TabFrame, { shot: string | CameraPreset; spin: boolean }> = {
  model: { shot: 'Three quarter', spin: true },
  stance: { shot: 'Low side', spin: false },
  wheels: { shot: 'Wheel', spin: false },
  paint: { shot: 'Three quarter', spin: true },
  vinyl: { shot: 'Three quarter', spin: false },
  tint: { shot: { name: 'Tint', pos: [3.4, 1.35, 3.6], target: [0, 0.95, 0.2] }, spin: true },
  neon: { shot: { name: 'Neon', pos: [5.4, 0.75, 5.6], target: [0, 0.3, 0] }, spin: true },
  tune: { shot: { name: 'Exhaust', pos: [-3.2, 0.9, -4.3], target: [0, 0.5, -1.4] }, spin: false },
  'body:body': { shot: 'Three quarter', spin: true },
  'body:frontBumper': { shot: 'Front', spin: false },
  'body:rearBumper': { shot: 'Rear', spin: false },
  'body:spoiler': { shot: 'Rear', spin: false },
  'body:sideSkirts': { shot: 'Low side', spin: false },
  'body:hood': { shot: { name: 'Hood', pos: [2.8, 2.5, 4.8], target: [0, 0.8, 0.9] }, spin: false },
  'body:roof': { shot: { name: 'Roof', pos: [3.6, 3.1, 3.6], target: [0, 0.9, 0] }, spin: false },
  'body:wheels': { shot: 'Wheel', spin: false },
};

/** A parked car's lamp lenses: lit, but well under the street's glow, so they read as lenses under the room's lights rather than blooming. */
const PARKED_LAMPS = 0.45;
/** With the room's lights down the paint's reflections (its map still holds the lit battens) fall to this share. */
const DIM_REFLECTIONS = 0.3;
/**
 * The workshop's idle tour (the Builds step, nobody touching the camera for TOUR s): each shot holds `hold` s
 * while the camera pushes in (m/s) and sways across (m/s, at `swayHz`), then cuts to the next over `cut` s.
 */
const IDLE = { hold: 8, cut: 2.4, push: 0.045, sway: 0.25, swayHz: 0.3 } as const;

/** How fast the turntable turns (rad/s). */
const SPIN = 0.22;
/** The dyno's wheels start rolling as the revs lift off idle and roll fully this far up the range (share of idle to redline). */
const WHEELS_ENGAGE = 0.1;
/** Strapped down the body hardly rocks: the share of the showroom's roll and squat a pull gives. */
const STRAP_ROCK = 0.3;
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
  dyno: { minDistance: 2.2, maxDistance: 7.5, minPolarAngle: 0.35, maxPolarAngle: 1.5 },
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
  /** The car on the turntable (or strapped to the dyno), or the one about to replace it while it loads (the street has its own, kept in step by setCar). */
  car: CarView | null = null;
  /** The car standing on the turntable now; `car` differs while a new one loads. */
  private mounted: CarView | null = null;
  spin = true;
  /** The tab frame the camera sits on, untouched since (a drag or a new presentation lets it go). */
  private framed: TabFrame | null = null;
  /** The idle tour: allowed (the Builds step), how long the current shot has held (s), and whether motion is unwanted. */
  private tourOn = false;
  private tourHold = 0;
  private readonly stillness = prefersReducedMotion();
  // The shop's sound bed (audio/garageAmbience.ts): made once audio is unlocked, fed every frame.
  private shopSound: GarageAmbience | null = null;
  private readonly soundState: GarageSoundState = { time: 0, listener: { x: 0, z: 0, yaw: 0 }, flicker: 1, dynoRpm: 0, active: false };
  private readonly heading = new THREE.Vector3();
  private time = 0;
  private readonly showroom: Showroom;
  private readonly follow = new FollowOrbit();
  private readonly raycaster = new THREE.Raycaster();
  private mode: Presentation = 'garage';
  /** The dyno's view of the build (curves, pull gear, driven axle), and where the car stands on it. */
  private dynoSetup: DynoSetup | null = null;
  private readonly stand = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Car space to world on the dyno (and scratch for the camera presets). */
  private readonly dynoFrame = new THREE.Matrix4();
  /** The live pull the wall screen draws, which the showroom reads at each redraw. */
  private readonly run: DynoRun = { progress: 0, power: () => 0, torque: () => 0, peaks: { hp: 0, lbft: 0, hpRpm: 0, lbftRpm: 0 }, rpm: 0 };
  /** The pull in progress: the furthest the revs have climbed (0..1 of the range), whether it reached the redline, and its number. */
  private pull = { max: 0, done: false, no: 1 };
  /** Called once a pull reaches the redline, with its peak figures (the garage shows them as a toast). */
  onPull: ((peaks: DynoPeaks) => void) | null = null;
  private readonly pose: CarPose = { x: 0, y: ROOM.tableTop, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, comp: [0, 0, 0, 0], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 };
  // Camera presets and the tween between them (in car space on the street, world space in the showroom).
  private camIndex = 0;
  private camTween: { from: THREE.Vector3; fromT: THREE.Vector3; to: THREE.Vector3; toT: THREE.Vector3; t: number; seconds: number; local: boolean } | null = null;
  private lastInteraction = -100;
  private readonly onResize = () => this.showroom.resize(this.gr.renderer, this.quality);
  // Engine.
  private rev = new RevModel({ idle: 900, redline: 7200 });
  private blipScript = new BlipScript();
  private gasHeld = 0;
  /** The pedal this frame: the gas or the scripted blip, whichever is deeper. */
  private pedal = 0;
  /** Steering held on the keys (-1 left .. 1 right), and the build's lock (rad) and rate (rad/s) from its tuning. */
  private steerHeld = 0;
  private steerLock = 0;
  private steerRate = 0;
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
      this.framed = null;
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

  /** Switch between the turntable showroom, the dyno and the street. */
  setPresentation(p: Presentation): void {
    if (p === this.mode) return;
    const was = this.mode;
    this.mode = p;
    // The car changes places: onto the dyno's rollers, or back to the turntable.
    if (this.mounted) {
      if (p === 'dyno') this.showroom.mountDyno(this.mounted, this.axleZ(this.mounted));
      else if (was === 'dyno') this.showroom.releaseDyno(this.mounted);
    }
    this.applyMode();
    this.homeCamera();
  }

  private applyMode(): void {
    Object.assign(this.controls, ORBIT[this.mode]);
    this.follow.reset();
    const dyno = this.mode === 'dyno';
    // The engine turns the rollers on the dyno and revs free elsewhere; the wheels stand still off it.
    this.rev.load = dyno ? pullLoad(this.rev.idle, this.rev.redline) : null;
    this.pose.spin.fill(0);
    this.showroom.setRun(dyno ? this.run : null);
    this.showroom.setFan(dyno ? 0 : null);
    if (dyno) this.restartPull(false);
  }

  /** The driven axle's z in a car's own space (m): the front pair for a front drive, the rear otherwise. */
  private axleZ(view: CarView): number {
    return view.car.wheels[this.dynoSetup?.driven === 'front' ? 'FL' : 'RL'][2];
  }

  /** Car space to world: the turntable's matrix in the showroom, the parked car's on the dyno. */
  private frameMatrix(): THREE.Matrix4 {
    if (this.mode !== 'dyno') {
      this.showroom.turntable.updateMatrixWorld();
      return this.showroom.turntable.matrixWorld;
    }
    this.showroom.dynoStand(this.car ? this.axleZ(this.car) : 0, this.stand);
    const s = this.stand;
    return this.dynoFrame.makeRotationY(s.yaw).setPosition(s.x, s.y, s.z);
  }

  private presets(): CameraPreset[] {
    return this.mode === 'dyno' ? DYNO_CAMERAS : CAMERAS;
  }

  /** A preset's position and target in car space, scaled to the car (and the rollers shot on the front pair for a front drive). */
  private presetSpace(c: CameraPreset): { pos: THREE.Vector3; target: THREE.Vector3 } {
    const k = this.lengthScale();
    const pos = new THREE.Vector3(...c.pos).multiplyScalar(k);
    const target = new THREE.Vector3(...c.target).multiplyScalar(k);
    if (c.name === ROLLERS_PRESET && this.mode === 'dyno' && this.dynoSetup?.driven === 'front') {
      pos.z = -pos.z;
      target.z = -target.z;
    }
    return { pos, target };
  }

  /** Each presentation opens on the three quarter view; the showroom spins again. */
  private homeCamera(): void {
    this.framed = null;
    this.camTween = null;
    this.camIndex = 0;
    const { pos, target } = this.presetSpace(this.presets()[0]);
    if (this.mode === 'street') {
      this.toWorld(pos);
      this.toWorld(target);
    } else {
      if (this.mode === 'dyno') {
        const m = this.frameMatrix();
        pos.applyMatrix4(m);
        target.applyMatrix4(m);
      }
      this.spin = true;
    }
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

  /**
   * Frame what a Customize tab edits (FRAMES), or null for the Builds step: back to the three quarter view and
   * the spin. A new frame always moves the camera; leaving one moves it back only if nobody dragged it
   * meanwhile (then it stays where it was put). The Neon tab takes the room's lights down with it. The Street
   * view's camera follows the car and is left alone.
   */
  frame(view: TabFrame | null): void {
    this.showroom.setLightsDown(view === 'neon' ? 1 : 0);
    if (this.mode === 'street' || view === this.framed) return;
    this.framed = view;
    if (!view) {
      this.setCamera(0);
      this.spin = true;
      return;
    }
    const f = FRAMES[view];
    const shot = typeof f.shot === 'string' ? (this.presets().find((c) => c.name === f.shot) ?? CAMERAS.find((c) => c.name === f.shot)!) : f.shot;
    this.goTo(shot);
    this.lastInteraction = this.time;
    this.spin = f.spin;
  }

  /** Let the idle tour run (the Builds step) or hold it off (Customize, where the player is working). */
  tour(on: boolean): void {
    this.tourOn = on;
    this.tourHold = 0;
    this.lastInteraction = this.time;
  }

  /** A key or a press anywhere: the tour waits for TOUR s again. */
  touch(): void {
    this.lastInteraction = this.time;
    this.tourHold = 0;
  }

  /** Cycle (or pick) a camera preset; returns its name. */
  setCamera(index = this.camIndex + 1): string {
    const c = this.pickPreset(index);
    this.goTo(c);
    this.lastInteraction = this.time;
    return c.name;
  }

  private pickPreset(index: number): CameraPreset {
    const list = this.presets();
    this.camIndex = ((index % list.length) + list.length) % list.length;
    return list[this.camIndex];
  }

  /** Tween the camera to a shot in car space over `seconds`: the showroom places it by the car's frame, the street by its pose. */
  private goTo(c: CameraPreset, seconds = TWEEN): void {
    const { pos: to, target: toT } = this.presetSpace(c);
    if (this.mode === 'street') {
      this.camTween = { from: this.toLocal(this.camera.position.clone()), fromT: this.toLocal(this.controls.target.clone()), to, toT, t: 0, seconds, local: true };
    } else {
      // Presets are in car space; the turntable turns the car, the dyno holds it.
      const m = this.frameMatrix();
      to.applyMatrix4(m);
      toT.applyMatrix4(m);
      if (this.mode === 'garage') {
        to.y = Math.max(to.y, 0.6);
        to.setLength(Math.max(to.length(), this.controls.minDistance + 0.3));
      } else to.y = Math.max(to.y, 0.3);
      this.camTween = { from: this.camera.position.clone(), fromT: this.controls.target.clone(), to, toT, t: 0, seconds, local: false };
    }
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
    const view = new CarView(carId, this.assets, { underglowLight: true, envMap: this.showroom.envMap, tread: this.quality !== 'low' });
    view.setHeadlightsEnabled(false);
    this.car = view;
    await view.load(visual);
    if (this.car !== view) {
      view.dispose();
      return this.car ?? view;
    }
    view.setLampLevel(PARKED_LAMPS);
    this.mounted?.dispose();
    this.mounted = view;
    if (this.mode === 'dyno') {
      this.showroom.mountDyno(view, this.axleZ(view));
      this.retitle();
    } else this.showroom.mount(view);
    return view;
  }

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  /**
   * Engine limits for the current build (from its tuning), and the two-step the gas meets while the Tune tab
   * is open (null otherwise). Only on the turntable: the Street view's car is rolling, where no two-step arms.
   */
  setEngine(idle: number, redline: number, launch: TwoStep | null = null): void {
    this.rev.configure({ idle, redline, rest: this.restRpm(idle, redline), launch: this.mode === 'garage' ? launch : null, load: this.mode === 'dyno' ? pullLoad(idle, redline) : null });
  }

  /**
   * The build's dyno figures (curves, peaks, pull gear, driven axle, wheel radius; garage/dynoRun.ts), taken
   * whole so the scene never reads the tuning. A build whose peaks changed starts the screen's pull over.
   */
  setDyno(setup: DynoSetup): void {
    const old = this.dynoSetup?.peaks;
    this.dynoSetup = setup;
    const r = this.run;
    r.power = setup.power;
    r.torque = setup.torque;
    if (!old || old.hp !== setup.peaks.hp || old.lbft !== setup.peaks.lbft) {
      Object.assign(r.peaks, setup.peaks);
      this.restartPull(false);
    }
  }

  /** The screen's heading: the car and the pull's number (rebuilt only when either changes). */
  private retitle(): void {
    this.run.title = `${(this.car?.car.displayName ?? '').toUpperCase()}  ·  PULL ${this.pull.no}`;
  }

  /** Start a pull's record over (a new pull; `next` counts it). */
  private restartPull(next: boolean): void {
    this.pull.max = 0;
    this.pull.done = false;
    if (next) this.pull.no++;
    this.run.progress = 0;
    this.retitle();
  }

  /**
   * Follow the pull: the furthest the revs have climbed is how much of the curves the screen draws; the pedal
   * going down near idle starts the next pull over, and reaching the redline ends it and calls out the figures.
   */
  private updatePull(): void {
    const rev = this.rev;
    const x = clamp01((rev.rpm - rev.idle) / Math.max(1, rev.redline - rev.idle));
    const p = this.pull;
    if (this.pedal > 0.5 && x < PULL.restartBelow && p.max > x + 0.05) this.restartPull(p.max > 0.15);
    if (!p.done) {
      p.max = Math.max(p.max, x);
      if (x >= PULL.doneAt) {
        p.max = 1;
        p.done = true;
        this.onPull?.(this.run.peaks);
      }
    }
    this.run.progress = p.max;
    this.run.rpm = rev.rpm;
    this.showroom.setFan(x);
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

  /** The build's steering lock (deg) and how fast the wheels turn (deg/s), as the sim steers them. */
  setSteering(maxDeg: number, rateDegPerSec: number): void {
    this.steerLock = (maxDeg * Math.PI) / 180;
    this.steerRate = (rateDegPerSec * Math.PI) / 180;
  }

  /** Hold the steering (-1 full left .. 1 full right, 0 straight ahead). */
  setSteer(x: number): void {
    this.steerHeld = x;
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
    this.pedal = throttle;
    this.rev.step(dt, throttle, street ? 0.45 : this.mode === 'dyno' ? STRAP_ROCK : 1);
    // Garage: the engine falls silent a few seconds after the last blip.
    const busy = street || throttle > 0 || Math.abs(this.rev.rpm - this.rev.rest) > 40;
    this.quietFor = busy ? 0 : this.quietFor + dt;
    if (this.quietFor > QUIET) {
      this.voice?.silence();
      return;
    }
    const voice = this.ensureVoice();
    if (voice && this.car) voice.popRate = this.car.popRate;
    // Quiet at rest (a burble in the showroom, a low hum on the Street view's cruise), swelling with the revs.
    const level = revVoice(street ? 'street' : 'garage', this.rev.rpm, this.rev.rest, this.rev.redline, this.rev.throttle);
    voice?.update({
      rpm: this.rev.rpm,
      redline: this.rev.redline,
      throttle: level.throttle,
      nitro: false,
      proximity: level.proximity,
      pan: 0,
      cut: this.rev.twoStep,
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
      tw.t = Math.min(1, tw.t + dt / tw.seconds);
      const e = smoothstep(0, 1, tw.t);
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.fromT, tw.toT, e);
      if (tw.local) {
        this.toWorld(this.camera.position);
        this.toWorld(this.controls.target);
      }
      if (tw.t >= 1) this.camTween = null;
    } else if (this.mode === 'street') {
      // Slow auto tour of the angles while nobody is touching the camera.
      if (this.time - this.lastInteraction > TOUR) this.setCamera();
    } else if (this.touring()) {
      // The workshop's idle tour: a shot drifts (a push in and a sway across) over the turning car, then cuts.
      this.tourHold += dt;
      if (this.tourHold > IDLE.hold) {
        this.tourHold = 0;
        this.goTo(this.pickPreset(this.camIndex + 1), IDLE.cut);
      } else {
        const cam = this.camera.position;
        this.heading.subVectors(this.controls.target, cam).normalize();
        cam.addScaledVector(this.heading, IDLE.push * dt);
        this.heading.cross(this.camera.up).normalize();
        cam.addScaledVector(this.heading, IDLE.sway * Math.cos(this.tourHold * IDLE.swayHz * TAU) * dt);
      }
    }
    this.controls.update();
  }

  /** The idle tour runs in the showroom on the Builds step, off any tab frame, after TOUR s without a touch, unless motion is unwanted. */
  private touring(): boolean {
    return this.mode === 'garage' && this.tourOn && !this.framed && !this.stillness && this.time - this.lastInteraction > TOUR;
  }

  /**
   * Feed the shop's sound bed: made once audio is unlocked (null before the first gesture, so tried again
   * each frame until then), told where the camera is and what the room is doing, and silenced on the street,
   * where the city's own bed plays.
   */
  private updateSound(dt: number): void {
    if (!this.shopSound) {
      if (!this.audioOk) return;
      this.shopSound = GarageAmbience.create();
      if (!this.shopSound) return;
    }
    const s = this.soundState;
    s.active = this.mode !== 'street';
    if (s.active) {
      s.time = this.showroom.clock;
      const cam = this.camera.position;
      s.listener.x = cam.x;
      s.listener.z = cam.z;
      this.camera.getWorldDirection(this.heading);
      s.listener.yaw = Math.atan2(this.heading.x, this.heading.z);
      s.flicker = this.showroom.batten;
      // The customer's pull is heard unless the player's own car is on the dyno (that one has the real voice).
      s.dynoRpm = this.mode === 'dyno' ? -1 : this.showroom.shop.dynoRpm;
    }
    this.shopSound.update(dt, s);
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
      this.updateSound(dt);
      this.street.render(this.gr, this.follow.resolve(this.camera, this.controls.target, this.street.world), dt);
      return;
    }
    const dyno = this.mode === 'dyno';
    if (this.spin && !dyno) this.showroom.turntable.rotation.y += dt * SPIN;
    if (dyno) this.updatePull();
    this.showroom.update(dt);
    const view = this.car;
    if (view) {
      // Parked in neutral: the wheels stay on the turntable while the body rocks with the revs.
      // On the dyno the car stands strapped with its driven axle over the rollers and those wheels turn.
      const p = this.pose;
      if (dyno) {
        this.showroom.dynoStand(this.axleZ(view), this.stand);
        p.x = this.stand.x;
        p.y = this.stand.y;
        p.z = this.stand.z;
        p.yaw = this.stand.yaw;
        const setup = this.dynoSetup;
        if (setup) {
          const x = (rev.rpm - rev.idle) / Math.max(1, rev.redline - rev.idle);
          // Rolling from just off idle (in gear, the wheels turn at the engine's speed over the pull gear's ratio).
          const omega = ((rev.rpm * TAU) / 60 / setup.overall) * smoothstep(0, WHEELS_ENGAGE, x);
          const first = setup.driven === 'front' ? 0 : 2;
          for (let i = first; i < first + 2; i++) p.spin[i] = (p.spin[i] + omega * dt) % TAU;
        }
      } else {
        p.x = 0;
        p.y = ROOM.tableTop;
        p.z = 0;
        p.yaw = 0;
      }
      // The front wheels turn at the build's steering rate toward the held lock, like the sim's
      // (a right turn is a negative angle there), and come back straight when the keys let go.
      const step = this.steerRate * dt;
      p.steer += Math.max(-step, Math.min(step, -this.steerHeld * this.steerLock - p.steer));
      p.pitch = rev.pitch;
      p.roll = rev.roll;
      for (let i = 0; i < 4; i++) {
        const w = view.car.wheels[WHEEL_KEYS[i]];
        p.comp[i] = -(w[0] * p.roll - w[2] * p.pitch);
      }
      view.update(p, this.time);
      // With the lights down the paint's reflections go with them (its map still holds the lit battens).
      view.setEnvScale(1 - (1 - DIM_REFLECTIONS) * this.showroom.dimmed);
    }
    this.updateCamera(dt);
    this.updateSound(dt);
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
    this.shopSound?.dispose();
    this.shopSound = null;
    // A car still loading disposes itself when it lands (it is no longer `car`).
    this.car = null;
    this.mounted?.dispose();
    this.mounted = null;
    this.showroom.dispose();
  }
}
