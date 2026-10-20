/**
 * A race on screen: owns the sim RaceState, the night scene, car views, the
 * camera and HUD. tick() advances the sim one fixed step (live input or a
 * recorded log); render() interpolates between the last two snapshots.
 */
import * as THREE from 'three';
import { CarState } from '../sim/car';
import { routeSample } from '../city/route';
import { createRace, RaceConfig, RaceState, raceTime, standings, stepRace, ticksToSeconds } from '../sim/race';
import { NEUTRAL_INPUT, unpackInput } from '../sim/input';
import { VisualBuild } from '../sim/build';
import { DT } from '../sim/constants';
import { CarView, CarPose } from '../render/carView';
import { LightTrails } from '../render/lightTrails';
import { EngineVoice, audioHub } from '../audio/engineAudio';
import { Sfx } from '../audio/sfx';
import { manifestCar } from '../render/carAssets';
import { CarAssetLibrary } from '../render/carAssets';
import { CAMERA, ChaseCamera } from '../render/camera';
import { RaceCinematics } from '../render/cinematics';
import { GameRenderer, NightScene, createNightScene } from '../render/scene';
import type { CrowdCar } from '../render/crowds';
import { FreeFlyCamera } from '../render/freeFly';
import { DroneMode } from './drone';
import type { CameraMode } from '../render/camera';
import { InputManager } from '../input/inputManager';
import { Hud, HudData } from '../ui/hud';
import { Settings } from '../ui/settings';
import { formatTime } from '../ui/format';
import { ReplayData } from '../replay/replay';
import type { Area } from '../city/districts/types';
import { PROP_DEFS } from '../city/props';

interface Snap extends CarPose {
  vx: number;
  vz: number;
  rpm: number;
  throttle: number;
}

function snap(c: CarState): Snap {
  return {
    x: c.x,
    y: c.y,
    z: c.z,
    yaw: c.yaw,
    pitch: c.pitch,
    roll: c.roll,
    steer: c.steerAngle,
    comp: c.wheels.map((w) => w.compression),
    spin: c.wheels.map((w) => w.spin),
    braking: c.aLong < -4 && c.speed > 1,
    nitro: c.nitroActive,
    speed: c.speed,
    vx: c.vx,
    vz: c.vz,
    rpm: c.rpm,
    throttle: c.throttle,
  };
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

function lerpSnap(a: Snap, b: Snap, t: number): Snap {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    x: l(a.x, b.x),
    y: l(a.y, b.y),
    z: l(a.z, b.z),
    yaw: lerpAngle(a.yaw, b.yaw, t),
    pitch: l(a.pitch, b.pitch),
    roll: l(a.roll, b.roll),
    steer: l(a.steer, b.steer),
    comp: a.comp.map((v, i) => l(v, b.comp[i])),
    spin: a.spin.map((v, i) => lerpAngle(v, b.spin[i], t)),
    braking: b.braking,
    nitro: b.nitro,
    speed: l(a.speed, b.speed),
    vx: l(a.vx, b.vx),
    vz: l(a.vz, b.vz),
    rpm: l(a.rpm, b.rpm),
    throttle: l(a.throttle, b.throttle),
  };
}

export type ReplayCamMode = 'chase' | 'close' | 'bumper' | 'hood' | 'tv' | 'orbit' | 'free';
const REPLAY_CAMS: ReplayCamMode[] = ['chase', 'tv', 'orbit', 'close', 'hood', 'free'];
/** Number key views: 1 chase, 2 close, 3 bumper, 4 hood, 5 trackside TV, 6 orbit, 7 free fly (replays); 0 is the drone. */
const VIEW_KEYS: ReplayCamMode[] = ['chase', 'close', 'bumper', 'hood', 'tv', 'orbit', 'free'];
const isFollowCam = (v: ReplayCamMode): v is CameraMode => v === 'chase' || v === 'close' || v === 'bumper' || v === 'hood';
/** The circuit gantry sign switches to the next label this many ticks after the player passes under it. */
const SIGN_DELAY = 70;
/** District names for the open world HUD; plain streets and filler pockets read as the city. */
const AREA_NAMES: Partial<Record<Area['kind'], string>> = {
  alley: 'Raceway alley',
  backAlley: 'Back alley',
  park: 'Park',
  subway: 'Under the El',
  river: 'River channel',
  roundabout: 'Roundabout',
  monument: 'Monument',
  waterfront: 'Waterfront',
  lake: 'Lake',
};
const INFILL_NAMES: Record<string, string> = { lot: 'Parking lot', plaza: 'Plaza', cornerPlaza: 'Corner plaza', verge: 'Downtown' };
/** A new district name shows as a HUD message once the car has been in it this long (s). */
const AREA_SETTLE = 0.6;
/** Nitrous screen warp easing rates in and out (1/s). */
const NITRO_IN = 5;
const NITRO_OUT = 2.5;
/** On a tick where the player only hit props, the speed drop must exceed slowdownMin by this many times over to count as a crash. */
const PROP_SLOWDOWN_EXTRA = 1.6;
/** A crowd section's heard excitement crossing this cheers out loud, at most every SECTION_CHEER_GAP s. */
const SECTION_CHEER_LEVEL = 0.7;
const SECTION_CHEER_GAP = 8;

export interface SessionOptions {
  config: RaceConfig;
  visuals: VisualBuild[];
  replay?: ReplayData & { decoded: number[] };
  ghost?: { config: RaceConfig; log: number[]; visual: VisualBuild } | null;
  /** Start / finish camera shots (default on; off for test drives). Replays never play them. */
  cinematics?: boolean;
}

export interface FinishInfo {
  race: RaceState;
  tuned: boolean;
}

export class RaceSession {
  readonly race: RaceState;
  readonly night: NightScene;
  readonly views: CarView[] = [];
  readonly cam: ChaseCamera;
  readonly hud: Hud;
  paused = false;
  /** Set when the dev panel changed tuning: results are not saved. */
  tuned = false;
  onFinish: ((info: FinishInfo) => void) | null = null;
  private prev: Snap[];
  private curr: Snap[];
  private ghostRace: RaceState | null = null;
  private ghostLog: number[] = [];
  private ghostView: CarView | null = null;
  private ghostPrev: Snap | null = null;
  private ghostCurr: Snap | null = null;
  private eventIndex = 0;
  private finishedAt = -1;
  /** Start / finish camera shots (render only). */
  readonly cine: RaceCinematics;
  private cineOn = false;
  /** Ticks left of the pre-countdown intro; the sim waits at tick 0 meanwhile, so replays are unaffected. */
  private preRoll = 0;
  private preRollTotal = 0;
  private skipFinish = false;
  private resultsShown = false;
  private outroStarted = false;
  private alpha = 0;
  private time = 0;
  /** A reset moved the player this tick (its speed drop is not a crash); the player hit props, a wall or a car. */
  private resetThisTick = false;
  private propOnlyTick = false;
  private hardHitTick = false;
  /** Nitrous screen warp, eased in and out (0..1). */
  private nitroFx = 0;
  /** Open world HUD: props the player broke, top speed (km/h), the district shown and the one being entered. */
  private smashed = 0;
  private topKmh = 0;
  private areaName = 'Downtown';
  private areaNext = '';
  private areaFor = 0;
  private blur = 0;
  private replayCam: ReplayCamMode = 'chase';
  /** Live sessions: a trackside or orbit view picked with the number keys (null: the follow camera). */
  private liveView: 'tv' | 'orbit' | null = null;
  /** Photo mode drone (0 key) and whether it paused the sim (live sessions hold still while it flies). */
  private drone: DroneMode | null = null;
  private droneResume = false;
  private readonly uiRoot: HTMLElement;
  /** The camera rendered last frame (the drone starts from it). */
  private lastCamera: THREE.PerspectiveCamera | null = null;
  private freeCam: FreeFlyCamera | null = null;
  private tvPoint = new THREE.Vector3();
  private tvValid = false;
  private tvSide = 1;
  private unsub: (() => void)[] = [];
  readonly isReplay: boolean;
  private trails: LightTrails;
  private carLight: THREE.PointLight;
  private engines: EngineVoice[] = [];
  private sfx: Sfx | null = null;
  /** Headlight flash level driven by the horn (render side only). */
  private flash = 0;
  /** Open world test drive: no crowds, fireworks or line celebrations. */
  private readonly openWorld: boolean;
  /** Text on the circuit gantry sign, and the tick a pending change is applied (-1 = none). */
  private signText = '';
  private signAt = -1;
  /** Player lap whose line approach fireworks were launched. */
  private fireworksLap = -1;
  /** Racer poses for the crowd (reused every frame). */
  private readonly crowdCars: CrowdCar[];
  /** Last heard excitement and last cheer time (s) per crowd section spot. */
  private readonly sectionLevel: number[] = [];
  private readonly sectionCheerAt: number[] = [];
  readyPromise: Promise<void>;

  constructor(
    private readonly gr: GameRenderer,
    assets: CarAssetLibrary,
    private readonly input: InputManager,
    private readonly settings: Settings,
    uiRoot: HTMLElement,
    private readonly opts: SessionOptions,
  ) {
    this.isReplay = !!opts.replay;
    this.uiRoot = uiRoot;
    this.race = createRace(opts.config);
    this.night = createNightScene(this.race.world, gr, settings);
    this.cam = new ChaseCamera(this.race.world);
    this.cine = new RaceCinematics(this.cam, this.race.world, uiRoot);
    this.openWorld = opts.config.openWorld === true || this.race.world.openWorld === true;
    this.night.crowds.setEnabled(!this.openWorld);
    this.crowdCars = this.race.cars.map(() => ({ x: 0, z: 0, speed: 0 }));
    this.hud = new Hud(uiRoot, this.race.world);
    const loads: Promise<void>[] = [];
    this.race.cars.forEach((rc, i) => {
      const view = new CarView(rc.carId, assets, { headlights: i === 0, underglowLight: i === 0, envMap: gr.envMap });
      this.night.scene.add(view.root);
      this.views.push(view);
      loads.push(view.load(opts.visuals[i] ?? opts.visuals[0]));
    });
    if (opts.ghost) {
      this.ghostRace = createRace(opts.ghost.config, this.race.world);
      this.ghostLog = opts.ghost.log;
      const gv = new CarView(opts.ghost.config.player.carId, assets, { envMap: gr.envMap });
      this.ghostView = gv;
      this.night.scene.add(gv.root);
      loads.push(
        gv.load(opts.ghost.visual).then(() => {
          gv.root.traverse((o) => {
            const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
            for (const mat of m ? (Array.isArray(m) ? m : [m]) : []) {
              mat.transparent = true;
              mat.opacity = 0.32;
              mat.depthWrite = false;
            }
          });
          gv.setHeadlightsEnabled(false);
        }),
      );
    }
    this.readyPromise = Promise.all(loads).then(() => undefined);
    // Nitrous light trails from the player's taillights.
    const pd = this.views[0].car.dimensions;
    this.trails = new LightTrails(pd.width, pd.length);
    this.trails.setColor(opts.visuals[0]?.taillightColor ?? '#ff1a2a');
    this.night.scene.add(this.trails.mesh);
    // A soft key light that rides above the player so cars read clearly at night.
    this.carLight = new THREE.PointLight(0xdfe6ff, 9, 9, 1.6);
    this.night.scene.add(this.carLight);
    // Engine sound: the player's car loud and centered, rivals by distance.
    const hub = audioHub();
    if (hub) {
      hub.setVolume(settings.engineVolume);
      this.engines = this.race.cars.map((rc, i) => {
        return new EngineVoice(manifestCar(rc.carId).engine, i === 0 ? 0.26 : 0.2);
      });
      // Crashes, nitrous, scrapes, horn and countdown beeps (src/audio/sfx.ts).
      this.sfx = new Sfx();
      const sfx = this.sfx;
      this.night.city.finishLine.onFirework = (x, y, z, size) => sfx.firework(x, y, z, size);
    }
    this.curr = this.race.cars.map((c) => snap(c.state));
    this.prev = this.curr.map((s) => ({ ...s }));
    if (!this.openWorld) this.updateCelebrations();
    if (this.ghostRace) {
      this.ghostCurr = snap(this.ghostRace.cars[0].state);
      this.ghostPrev = { ...this.ghostCurr };
    }
    this.unsub.push(
      input.on('camera', () => {
        // C is the drone's descend key: no camera cycling while it flies.
        if (this.cine.phase === 'outro' || this.drone) return;
        if (this.isReplay) this.cycleReplayCam();
        else {
          this.liveView = null;
          this.cam.resetOrbit();
          this.hud.message(`Camera: ${this.cam.cycle()}`, 1);
        }
      }),
      input.onView((n) => this.onViewKey(n)),
    );
    // A mouse drag orbits the follow camera around the car at any time (touch keeps its steering).
    {
      const canvas = gr.canvas;
      let drag: { id: number; x: number; y: number } | null = null;
      const down = (e: PointerEvent) => {
        if (e.pointerType === 'touch' || e.button !== 0 || this.drone || (this.isReplay && this.replayCam === 'free')) return;
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this.cam.setOrbiting(true);
        canvas.style.cursor = 'grabbing';
      };
      const move = (e: PointerEvent) => {
        if (!drag || e.pointerId !== drag.id) return;
        this.cam.orbitBy(e.clientX - drag.x, e.clientY - drag.y);
        drag.x = e.clientX;
        drag.y = e.clientY;
      };
      const up = (e: PointerEvent) => {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        this.cam.setOrbiting(false);
        canvas.style.cursor = '';
      };
      canvas.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      this.unsub.push(() => {
        canvas.removeEventListener('pointerdown', down);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        canvas.style.cursor = '';
      });
    }
    input.setTouchVisible(!this.isReplay);
    this.cineOn = !this.isReplay && opts.cinematics !== false;
    if (this.cineOn) {
      this.preRoll = this.preRollTotal = Math.round(CAMERA.intro.preRoll / DT);
      this.cine.startIntro(this.curr[0], this.race.cars[0].rawS);
      // Touch controls stay hidden through the pre-roll so a tap anywhere skips it.
      if (this.preRoll > 0) input.setTouchVisible(false);
      const onKey = (e: KeyboardEvent) => {
        if ((e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') && !e.repeat) this.skipCinematic();
      };
      const onTap = () => this.skipCinematic();
      window.addEventListener('keydown', onKey);
      gr.canvas.addEventListener('pointerdown', onTap);
      this.unsub.push(() => {
        window.removeEventListener('keydown', onKey);
        gr.canvas.removeEventListener('pointerdown', onTap);
      });
    }
  }

  /** True while the player's controls do nothing: intro, countdown and after the finish (runout). */
  get controlsLocked(): boolean {
    return this.preRoll > 0 || this.race.tick < this.race.countdownTicks || this.race.cars[0].finished;
  }

  /** True while a start or finish camera shot is on screen. */
  get cinematicActive(): boolean {
    return this.cine.active;
  }

  /** Skip the intro fly-in (the countdown still runs), or go straight to the results after the finish. */
  skipCinematic(): void {
    if (this.paused || !this.cineOn) return;
    if (this.cine.phase === 'intro') {
      if (this.preRoll > 0) {
        this.preRoll = 0;
        this.input.setTouchVisible(true);
      }
      this.cine.skip();
    } else if (this.finishedAt >= 0 && !this.resultsShown) this.skipFinish = true;
  }

  /** True while the photo mode drone flies (Escape brings the camera back to the car). */
  get droneActive(): boolean {
    return !!this.drone;
  }

  /**
   * 0 key: fly the camera drone from where the camera is now; 0 (or Escape)
   * again flies back to the car. A live session holds still meanwhile (the
   * drone uses the driving keys), a replay keeps playing.
   */
  toggleDrone(): void {
    if (this.drone) {
      this.drone.dispose();
      this.drone = null;
      // Keys pressed for the drone (WASD, E/Q, R) must not drive, shift or reset the car.
      this.input.releaseAll();
      if (this.droneResume) this.paused = false;
      this.droneResume = false;
      this.hud.root.style.display = '';
      this.input.setTouchVisible(!this.isReplay);
      this.cam.snap();
      return;
    }
    if (this.cine.active || this.paused) return;
    const cam = this.lastCamera ?? this.cam.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    this.drone = new DroneMode(this.gr, this.night, this.race.world, this.uiRoot, () => this.toggleDrone(), {
      start: { x: cam.position.x, y: cam.position.y, z: cam.position.z, yaw: Math.atan2(dir.x, dir.z), pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) },
      escape: false,
      hint: 'WASD fly · drag to look · Space / Ctrl up / down · Shift boost · wheel speed · T tour · 0 or Esc back to the car',
    });
    this.droneResume = !this.isReplay;
    if (this.droneResume) {
      this.paused = true;
      this.input.releaseAll();
    }
    this.hud.root.style.display = 'none';
    this.input.setTouchVisible(false);
  }

  /** Number keys: 1..7 pick a view (VIEW_KEYS), 0 toggles the drone. */
  private onViewKey(n: number): void {
    if (this.cine.phase === 'outro') return;
    if (n === 0) return this.toggleDrone();
    const view = VIEW_KEYS[n - 1];
    if (!view || (view === 'free' && !this.isReplay)) return;
    if (this.drone) this.toggleDrone();
    if (this.isReplay) return this.setReplayCam(view);
    this.cam.resetOrbit();
    if (isFollowCam(view)) {
      this.liveView = null;
      this.cam.mode = view;
      this.cam.snap();
    } else {
      this.liveView = view === 'tv' ? 'tv' : 'orbit';
      this.tvValid = false;
    }
    this.hud.message(`Camera: ${view}`, 1);
  }

  private cycleReplayCam(): void {
    this.setReplayCam(REPLAY_CAMS[(REPLAY_CAMS.indexOf(this.replayCam) + 1) % REPLAY_CAMS.length]);
  }

  private setReplayCam(view: ReplayCamMode): void {
    this.replayCam = view;
    this.tvValid = false;
    if (isFollowCam(this.replayCam)) {
      this.cam.mode = this.replayCam;
      this.cam.snap();
    }
    if (this.replayCam === 'free') {
      if (this.freeCam) return;
      this.freeCam = new FreeFlyCamera(this.gr.canvas);
      const p = this.curr[0];
      this.freeCam.set(new THREE.Vector3(p.x - Math.sin(p.yaw) * 12, p.y + 6, p.z - Math.cos(p.yaw) * 12), p.yaw, -0.3);
    } else if (this.freeCam) {
      this.freeCam.dispose();
      this.freeCam = null;
    }
    this.tvValid = false;
    this.hud.message(`Camera: ${this.replayCam}`, 1);
  }

  get replayCamMode(): ReplayCamMode {
    return this.replayCam;
  }

  /** One fixed sim step. */
  tick(): void {
    if (this.paused) return;
    const r = this.race;
    if (this.preRoll > 0) {
      // Pre-countdown intro shot: hold the sim (and ghost) at tick 0.
      if (--this.preRoll === 0) this.input.setTouchVisible(true);
      return;
    }
    let frame = NEUTRAL_INPUT;
    if (this.opts.replay) {
      const log = this.opts.replay.decoded;
      frame = r.tick < log.length ? unpackInput(log[r.tick]) : { ...NEUTRAL_INPUT, brake: 0.5 };
    } else {
      frame = this.input.sample(DT);
    }
    this.prev = this.curr;
    const speedBefore = r.cars[0].state.speed;
    this.resetThisTick = false;
    this.propOnlyTick = false;
    this.hardHitTick = false;
    stepRace(r, frame);
    this.curr = r.cars.map((c) => snap(c.state));
    if (this.ghostRace) {
      this.ghostPrev = this.ghostCurr;
      const gt = this.ghostRace.tick;
      stepRace(this.ghostRace, gt < this.ghostLog.length ? unpackInput(this.ghostLog[gt]) : { ...NEUTRAL_INPUT, brake: 1 });
      this.ghostCurr = snap(this.ghostRace.cars[0].state);
    }
    this.sfx?.syncCountdown(r);
    this.handleEvents();
    // A sudden loss of speed (a hard hit on anything, a dumpster) shakes the camera hard; resets do not count.
    // Ploughing through soft props (bushes, tables, bags) costs a little speed too: that stays a light knock.
    const drop = speedBefore - r.cars[0].state.speed;
    if (!this.resetThisTick) this.cam.slowdown(this.propOnlyTick && !this.hardHitTick ? drop - CAMERA.common.slowdownMin * PROP_SLOWDOWN_EXTRA : drop);
    if (r.phase === 'finished' && this.finishedAt < 0) this.finishedAt = r.tick;
    if (!this.openWorld) {
      if (r.tick === r.countdownTicks) this.celebrateStart();
      this.updateCelebrations();
    }
    // Results wait for the finish shot (or a skip); without cinematics, 2.5 s.
    const delay = this.cineOn ? CAMERA.outro.resultsDelay : 2.5;
    if (this.finishedAt >= 0 && !this.resultsShown && this.onFinish && (this.skipFinish || r.tick - this.finishedAt >= Math.round(delay / DT))) {
      this.resultsShown = true;
      this.cine.settle();
      this.onFinish({ race: r, tuned: this.tuned });
    }
  }

  /** Gate position for crowd sounds: the start line or the finish line (the same gate on circuits). */
  private gatePos(at: 'start' | 'finish'): THREE.Vector3 | null {
    const gates = this.night.city.finishLine.gates;
    return (gates.find((g) => (at === 'finish' ? g.kind !== 'start' : g.kind !== 'finish')) ?? gates[0])?.position ?? null;
  }

  /** Green light: sparks, fireworks and the crowd erupting at the start gate. */
  private celebrateStart(): void {
    const fl = this.night.city.finishLine;
    fl.burst('start', 0.7);
    fl.fireworks('start');
    this.night.crowds.cheer('start', 1);
    const g = this.gatePos('start');
    if (g) this.sfx?.crowdCheer(g.x, g.z, 1, true);
  }

  /**
   * Sim driven (so replays match): the circuit sign label (START, LAP n,
   * FINISH for the final lap) and the fireworks launched just before the
   * player reaches the line, so the shells burst ahead as they pass under.
   */
  private updateCelebrations(): void {
    const r = this.race;
    const rc = r.cars[0];
    const route = r.world.route;
    const fl = this.night.city.finishLine;
    const laps = r.config.laps;
    if (route.closed) {
      const want = rc.lap === 0 ? 'START' : rc.lap >= laps ? 'FINISH' : `LAP ${rc.lap + 1}`;
      if (want !== this.signText) {
        if (this.signAt < 0) this.signAt = r.tick + (this.signText ? SIGN_DELAY : 0);
        if (r.tick >= this.signAt) {
          const sub = want === 'START' ? (laps > 1 ? `${laps} LAPS` : '') : want === 'FINISH' ? (laps > 1 ? 'FINAL LAP' : '') : `OF ${laps}`;
          fl.setSign('startFinish', want, sub);
          this.signText = want;
          this.signAt = -1;
        }
      }
    }
    if (!rc.finished && rc.lap >= 1 && this.fireworksLap !== rc.lap && r.tick > r.countdownTicks) {
      const remaining = (route.closed ? rc.lap * route.length : r.distance) - rc.dist;
      if (remaining > 0 && remaining < Math.max(18, rc.state.speed * 1.1)) {
        this.fireworksLap = rc.lap;
        const final = !route.closed || rc.lap >= laps;
        // The final approach gets an opening salvo; the big show fires on the finish event.
        fl.fireworks(final ? 'finish' : 'lap', final ? 0.4 : 1);
      }
    }
  }

  private handleEvents(): void {
    const r = this.race;
    for (; this.eventIndex < r.events.length; this.eventIndex++) {
      const e = r.events[this.eventIndex];
      this.sfx?.raceEvent(e, r);
      // Rivals crossing the finish get a smaller cheer.
      if (e.type === 'finish' && e.car !== 0 && !this.openWorld) this.night.crowds.cheer('finish', 0.8);
      // A rival slamming into the player shakes the player's camera too.
      if (e.type === 'crash' && e.other === 0) this.cam.crashAt(e.value ?? 0);
      if (e.car !== 0) continue;
      // Camera shake: walls, rails and cars hit hard; knocking props over is a light knock, heavier props knock harder.
      if (e.type === 'wall' || e.type === 'crash') {
        this.cam.crashAt(e.value ?? 0);
        this.hardHitTick = true;
      } else if (e.type === 'prop') {
        this.propOnlyTick = true;
        const prop = r.world.props[e.value ?? -1];
        const def = prop ? PROP_DEFS[prop.kind] : null;
        if (def) this.cam.knock(Math.min(1, 0.35 + (def.mass * def.anchor) / 900));
      } else if (e.type === 'reset') this.resetThisTick = true;
      if (e.type === 'prop') this.smashed++;
      const rc = r.cars[0];
      switch (e.type) {
        case 'lap': {
          const t = ticksToSeconds(rc.lapTimes[rc.lapTimes.length - 1] ?? 0);
          const best = rc.bestLap === rc.lapTimes[rc.lapTimes.length - 1];
          if ((e.value ?? 0) < r.config.laps) {
            this.hud.message(`Lap ${e.value}  ${formatTime(t)}${best ? '  BEST' : ''}${(e.value ?? 0) === r.config.laps - 1 ? '  ·  FINAL LAP' : ''}`, 2.6);
            if (!this.openWorld) {
              this.night.crowds.cheer('lap', 1);
              const g = this.gatePos('finish');
              if (g) this.sfx?.crowdCheer(g.x, g.z, 1, true);
            }
          }
          break;
        }
        case 'finish':
          this.hud.message(`FINISH  ${formatTime(raceTime(r))}`, 4);
          if (!this.openWorld) {
            this.night.city.finishLine.burst('finish');
            this.night.city.finishLine.fireworks('finish');
            this.night.crowds.cheer('finish', 1.5);
            const g = this.gatePos('finish');
            if (g) this.sfx?.crowdCheer(g.x, g.z, 1.6, true);
          }
          if (this.cineOn) this.input.setTouchVisible(false);
          break;
        case 'reset':
          this.hud.message('Back on track', 1);
          break;
        case 'driftBank':
          this.hud.message(`+${(e.value ?? 0).toLocaleString()}`, 1.2);
          break;
      }
    }
  }

  render(alpha: number, dt: number): void {
    this.time += dt;
    this.alpha = alpha;
    const r = this.race;
    const poses = this.curr.map((c, i) => lerpSnap(this.prev[i], c, this.paused ? 1 : alpha));
    this.views.forEach((v, i) => v.update(poses[i], this.time));
    if (this.ghostView && this.ghostPrev && this.ghostCurr) this.ghostView.update(lerpSnap(this.ghostPrev, this.ghostCurr, alpha), this.time);
    const p = poses[0];
    let camera: THREE.PerspectiveCamera;
    if (this.drone) {
      this.drone.update(dt);
      camera = this.drone.camera;
    } else camera = this.updateCamera(p, dt);
    this.lastCamera = camera;
    this.trails.update(this.views[0].root, camera, p.nitro && !this.paused, dt);
    this.carLight.position.set(p.x - Math.sin(p.yaw) * 1.5, p.y + 4.2, p.z - Math.cos(p.yaw) * 1.5);
    // The few real point lights follow the action, or the drone when it flies off.
    this.night.lighting.update(this.drone ? camera.position : new THREE.Vector3(p.x, p.y, p.z));
    this.night.update(this.time);
    // Corner rail pieces shoved by hits this race.
    this.night.arrows.syncRails(r.rails);
    this.night.city.finishLine.update(this.time);
    // Props mirror the sim's broken flags; fresh breaks come apart pushed by the nearest car.
    this.night.props.update(this.paused ? 0 : dt, this.time, r.brokenProps, this.curr);
    // Progressive edge blur: grows with speed, much stronger while boosting (eased in and out).
    const target = this.settings.radialBlur && !this.paused ? Math.max(0, Math.min(1, (p.speed - 25) / 45)) * 0.4 + (p.nitro ? 1 : 0) : 0;
    this.blur += (target - this.blur) * (1 - Math.exp(-dt * (target > this.blur ? 6 : 3)));
    this.gr.post.setSpeedBlur(this.blur);
    // Nitrous warp: in fast, out a little slower; follows the speed blur setting, off in the drone and while paused.
    const warpTarget = this.settings.radialBlur && !this.paused && !this.drone && p.nitro ? 1 : 0;
    this.nitroFx += (warpTarget - this.nitroFx) * (1 - Math.exp(-dt * (warpTarget > this.nitroFx ? NITRO_IN : NITRO_OUT)));
    if (warpTarget === 0 && this.nitroFx < 0.002) this.nitroFx = 0;
    this.gr.post.setNitroFx(this.nitroFx, this.time);
    this.updateHud(dt);
    this.updateEngines(poses, camera);
    this.updateSfx(poses, camera, dt);
    this.gr.render(this.night.scene, camera, dt);
  }

  /** Nitrous and scrape loops, the listener for one-shots, and the horn with its headlight flash. */
  private updateSfx(poses: Snap[], camera: THREE.PerspectiveCamera, dt: number): void {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    this.sfx?.setListener(camera.position.x, camera.position.z, right.x, right.z);
    const cars = poses.map((p, i) => {
      const g = this.race.cars[i].tuning.geometry;
      return { x: p.x, z: p.z, yaw: p.yaw, vx: p.vx, vz: p.vz, nitro: p.nitro, halfLength: g.halfLength, halfWidth: g.halfWidth };
    });
    this.sfx?.updateCars(cars, this.race.world, dt, this.paused);
    // Crowds react to the racers' (sim) poses and are heard from the camera.
    const cc = this.crowdCars;
    for (let i = 0; i < cc.length; i++) {
      const p = poses[i];
      cc[i].x = p.x;
      cc[i].z = p.z;
      cc[i].speed = p.speed;
    }
    this.night.crowds.update(this.time, this.paused ? 0 : dt, cc, camera.position.x, camera.position.z);
    this.sfx?.updateCrowds(this.night.crowds.spots, this.paused);
    // A section erupting as racers pass: a burst of cheering and applause from it (at most every few seconds).
    if (!this.paused) {
      const spots = this.night.crowds.spots;
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        if (s.kind !== 'section') continue;
        const was = this.sectionLevel[i] ?? 0;
        this.sectionLevel[i] = s.level;
        if (s.level > SECTION_CHEER_LEVEL && was <= SECTION_CHEER_LEVEL && this.time > (this.sectionCheerAt[i] ?? -1e9) + SECTION_CHEER_GAP) {
          this.sectionCheerAt[i] = this.time;
          this.sfx?.crowdCheer((s.ax + s.bx) / 2, (s.az + s.bz) / 2, 0.55, true);
        }
      }
    }
    // Horn (live races only, never recorded) flashes the player's headlights while held.
    const horn = !this.isReplay && !this.paused && this.input.hornHeld();
    this.sfx?.horn(horn);
    this.flash = horn ? Math.min(1, this.flash + dt / 0.04) : Math.max(0, this.flash - dt / 0.12);
    this.views[0].flashHeadlights(this.flash);
  }

  private updateEngines(poses: Snap[], camera: THREE.PerspectiveCamera): void {
    if (!this.engines.length) return;
    if (this.paused) {
      this.engines.forEach((e) => e.silence());
      return;
    }
    const camPos = camera.position;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    this.engines.forEach((voice, i) => {
      const p = poses[i];
      const rc = this.race.cars[i];
      const dx = p.x - camPos.x;
      const dz = p.z - camPos.z;
      const d = Math.hypot(dx, dz);
      const proximity = i === 0 ? 1 : 1 / (1 + (d / 14) ** 2);
      const pan = i === 0 ? 0 : (dx * right.x + dz * right.z) / Math.max(1, d);
      voice.update({ rpm: p.rpm, redline: rc.tuning.engine.redline, throttle: p.throttle, nitro: p.nitro, proximity, pan: pan * 0.8 });
    });
  }

  /** Intro fly-in and finish hero shot, layered over the chase camera. */
  private applyCinematics(p: Snap, dt: number): void {
    if (!this.cineOn) return;
    const r = this.race;
    const step = this.paused ? 0 : dt;
    if (this.cine.phase === 'intro') {
      // Progress in sim ticks so the landing is exactly on the green light.
      const done = this.preRollTotal - this.preRoll + r.tick + (this.paused ? 0 : this.alpha);
      this.cine.applyIntro(Math.min(1, done / (this.preRollTotal + r.countdownTicks)), step);
    } else if (r.cars[0].finished) {
      if (!this.outroStarted) {
        this.outroStarted = true;
        this.cine.startOutro(p);
      }
      this.cine.applyOutro(p, step);
    }
    this.cine.syncHud(this.hud.root, this.preRoll > 0);
  }

  private updateCamera(p: Snap, dt: number): THREE.PerspectiveCamera {
    const len = this.views[0].car.dimensions.length;
    // Cinematics always run on the follow camera; the number key views take over afterwards.
    const view: ReplayCamMode = this.isReplay ? this.replayCam : this.cine.active ? 'chase' : (this.liveView ?? 'chase');
    if (isFollowCam(view)) {
      this.cam.update(p, p.vx, p.vz, p.nitro, len, dt);
      this.applyCinematics(p, dt);
      return this.cam.camera;
    }
    const cam = this.cam.camera;
    if (view === 'free' && this.freeCam) {
      this.freeCam.update(dt);
      return this.freeCam.camera;
    }
    if (view === 'orbit') {
      const a = this.time * 0.35;
      cam.position.set(p.x + Math.sin(a) * 8, p.y + 2.6, p.z + Math.cos(a) * 8);
      cam.lookAt(p.x, p.y + 0.8, p.z);
      return cam;
    }
    // TV: a roadside camera ahead of the car that tracks it as it passes.
    const d = this.tvPoint.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    if (!this.tvValid || d > 70) {
      const side = (this.tvSide = -this.tvSide);
      if (this.race.world.openWorld) {
        // Open world: off the route, so a point ahead along the car's heading, pulled in front of any wall.
        const fx = Math.sin(p.yaw);
        const fz = Math.cos(p.yaw);
        const pt = new THREE.Vector3(p.x + fx * 40 + fz * 5 * side, 0, p.z + fz * 40 - fx * 5 * side);
        this.cam.keepOutOfWalls(p.x, p.z, pt, 3.2, 0);
        pt.y = Math.max(pt.y, this.race.world.heightAt(pt.x, pt.z) + 3.2);
        this.tvPoint.copy(pt);
      } else {
        // Next roadside camera: on the route ahead, near the curb, so it is never inside a building.
        const route = this.race.world.route;
        const rc = this.race.cars[0];
        const ahead = routeSample(route, rc.rawS + 45);
        const half = route.segWidth[ahead.seg] / 2 - 1;
        const x = ahead.x + ahead.tz * half * side;
        const z = ahead.z - ahead.tx * half * side;
        this.tvPoint.set(x, this.race.world.heightAt(x, z) + 3.2, z);
      }
      this.tvValid = true;
    }
    cam.position.copy(this.tvPoint);
    cam.lookAt(p.x, p.y + 0.7, p.z);
    const fov = Math.max(18, Math.min(60, 1400 / Math.max(10, d)));
    if (Math.abs(cam.fov - fov) > 0.1) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    return cam;
  }

  private updateHud(dt: number): void {
    const r = this.race;
    const rc = r.cars[0];
    const c = rc.state;
    const countdownLeft = r.countdownTicks - r.tick;
    const countdown = countdownLeft > 0 ? Math.ceil(countdownLeft / 60) : countdownLeft > -60 ? 0 : null;
    const st = standings(r);
    const data: HudData = {
      mode: r.config.mode,
      position: st.findIndex((s) => s.car.index === 0) + 1,
      carCount: r.cars.length,
      lap: rc.lap,
      laps: r.config.laps,
      raceTime: rc.finished ? ticksToSeconds(rc.finishTick - r.countdownTicks) : raceTime(r),
      bestLap: rc.bestLap ? ticksToSeconds(rc.bestLap) : null,
      lastLap: rc.lapTimes.length ? ticksToSeconds(rc.lapTimes[rc.lapTimes.length - 1]) : null,
      speedKmh: c.speed * 3.6,
      rpm: c.rpm,
      redline: rc.tuning.engine.redline,
      gear: c.gear,
      manual: c.manualGearbox,
      nitro: c.nitro,
      nitroActive: c.nitroActive,
      throttle: c.throttle,
      countdown,
      wrongWay: rc.wrongWay,
      progress: Math.max(0, rc.dist) / r.distance,
      drift: r.config.mode === 'drift' ? { total: r.drift.total, current: r.drift.current, multiplier: r.drift.multiplier } : undefined,
      cars: [
        ...this.curr.map((s, i) => ({ x: s.x, z: s.z, yaw: s.yaw, isPlayer: i === 0 })),
        ...(this.ghostCurr ? [{ x: this.ghostCurr.x, z: this.ghostCurr.z, yaw: this.ghostCurr.yaw, isPlayer: false, isGhost: true }] : []),
      ],
      ghost: !!this.ghostRace,
    };
    if (this.openWorld) {
      this.topKmh = Math.max(this.topKmh, c.speed * 3.6);
      this.updateArea(c.x, c.z, dt);
      data.openWorld = { area: this.areaName, smashed: this.smashed, topKmh: this.topKmh };
    }
    this.hud.update(data, dt);
  }

  /** Track the district under the player; a new one is announced once the car settles in it. */
  private updateArea(x: number, z: number, dt: number): void {
    const a = this.race.world.areaAt(x, z);
    const name = !a ? 'Downtown' : a.kind === 'infill' ? (INFILL_NAMES[a.variant] ?? 'Downtown') : (AREA_NAMES[a.kind] ?? 'Downtown');
    if (name === this.areaName) {
      this.areaNext = '';
      return;
    }
    if (name !== this.areaNext) {
      this.areaNext = name;
      this.areaFor = 0;
    }
    this.areaFor += dt;
    if (this.areaFor < AREA_SETTLE) return;
    this.areaName = name;
    this.areaNext = '';
    // Only the notable places get a callout; the plazas and lots just update the chip.
    if (a && a.kind !== 'infill' && a.kind !== 'downtown') this.hud.message(name, 1.6);
  }

  dispose(): void {
    this.gr.post.setNitroFx(0, 0);
    this.drone?.dispose();
    this.drone = null;
    this.unsub.forEach((u) => u());
    this.freeCam?.dispose();
    this.hud.dispose();
    this.views.forEach((v) => v.dispose());
    this.ghostView?.dispose();
    this.trails.dispose();
    this.engines.forEach((e) => e.dispose());
    this.night.city.finishLine.onFirework = null;
    this.sfx?.dispose();
    this.cine.dispose();
    this.carLight.removeFromParent();
    this.carLight.dispose();
    this.night.dispose();
    this.input.setTouchVisible(false);
  }
}
