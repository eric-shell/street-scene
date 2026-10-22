/**
 * A race on screen: owns the sim RaceState, the night scene, car views, the
 * camera and HUD. tick() advances the sim one fixed step (live input or a
 * recorded log); render() interpolates between the last two snapshots.
 * Free roam taken over from the menu (SessionOptions.handoff) runs in the
 * menu city's own scene instead, borrowed from the street stage and handed
 * back when the session ends, with the menu's cruise still driving the car
 * until the player touches a control.
 */
import * as THREE from 'three';
import { CarState } from '../sim/car';
import { routeSample } from '../city/route';
import { createRace, RaceConfig, RaceState, raceTime, standings, stepRace, ticksToSeconds } from '../sim/race';
import { InputFrame, NEUTRAL_INPUT, unpackInput } from '../sim/input';
import { VisualBuild } from '../sim/build';
import { DT, TICK_HZ } from '../sim/constants';
import { DEG } from '../sim/math';
import { CarView, CarPose } from '../render/car/carView';
import { ROAD_Y } from '../render/street/cityMeshes';
import { unmaskVehicle } from '../render/vehicleMask';
import { LightTrails } from '../render/car/lightTrails';
import { Sparks } from '../render/car/sparks';
import { WaypointBeacons } from '../render/race/waypointBeacons';
import { EngineVoice, audioHub } from '../audio/engineAudio';
import { Sfx } from '../audio/sfx';
import { manifestCar } from '../render/car/carAssets';
import { CarAssetLibrary } from '../render/car/carAssets';
import { CAMERA, ChaseCamera } from '../render/camera/camera';
import { RaceCinematics, type HandoffShot } from '../render/camera/cinematics';
import { GameRenderer, NightScene, createNightScene } from '../render/scene';
import { NITRO_FX } from '../render/post';
import type { World } from '../city/world';
import type { Cruise } from './cruise';
import type { StreetStage } from './streetStage';
import type { CrowdCar } from '../render/race/crowds';
import { FreeFlyCamera } from '../render/camera/freeFly';
import { DroneMode } from './drone';
import type { CameraMode } from '../render/camera/camera';
import { InputManager } from '../input/inputManager';
import { Rumble } from '../input/rumble';
import { Hud, HudCar, HudData } from '../ui/hud';
import { courseFor, openFullMap, type FullMap, type WaypointStore } from '../ui/fullMap/fullMap';
import { placeName } from '../ui/places';
import { toast } from '../ui/dom';
import { Compass, MapIcon, MapPinned } from '../ui/icons';
import { HudCard } from '../ui/hudCard';
import { CONTROLS } from '../ui/screens';
import { btn } from '../ui/dom';
import type { Vec2 } from '../sim/math';
import { Settings } from '../ui/settings';
import { formatTime } from '../ui/format';
import { mph } from '../ui/units';
import { ReplayData } from '../replay/replay';
import { PROP_DEFS } from '../city/props';
import { TRAFFIC_SNAP, TrafficView, snapTraffic } from '../render/traffic/traffic';
import { driftZoneStatus } from '../sim/driftZones';
import { DRIFT_ZONES } from '../sim/tuning';
import { ChaseCall, policeChaseCall } from '../render/traffic/policeChase';
import { HazardFx } from './hazardFx';

interface Snap extends CarPose {
  nitroStage: number;
  vx: number;
  vz: number;
  rpm: number;
  throttle: number;
  /** A gear change is cutting the drive (engine voice). */
  shifting: boolean;
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
    nitroStage: c.nitroStage,
    speed: c.speed,
    vx: c.vx,
    vz: c.vz,
    rpm: c.rpm,
    throttle: c.throttle,
    shifting: c.shiftTimer > 0,
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
    nitroStage: b.nitroStage,
    speed: l(a.speed, b.speed),
    vx: l(a.vx, b.vx),
    vz: l(a.vz, b.vz),
    rpm: l(a.rpm, b.rpm),
    throttle: l(a.throttle, b.throttle),
    shifting: b.shifting,
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
/** A new district name shows as a HUD message once the car has been in it this long (s). */
const AREA_SETTLE = 0.6;
/** Nitrous screen warp easing rates in and out (1/s); a change of stage eases its glow over at NITRO_IN too. */
const NITRO_IN = 5;
const NITRO_OUT = 2.5;
/** Nitrous swells the music by this much per stage burning (dB), easing in and back out at these rates (1/s). */
const MUSIC_LIFT = { db: [2, 4, 6], in: 4, out: 1.2 } as const;
/** On a tick where the player only hit props, the speed drop must exceed slowdownMin by this many times over to count as a crash. */
const PROP_SLOWDOWN_EXTRA = 1.6;
/** Free roam minimap: traffic this close to the player shows as dots (m; the map spans about 260 m to its edge). */
const TRAFFIC_DOT_RANGE = 280;
/**
 * Free roam waypoint (set on the city map, render only): driving this close
 * (m) reaches it. One set within reach of the car only counts once the car has
 * been `arm` m away, so it is not reached the moment the map closes.
 */
const WAYPOINT = { reach: 25, arm: 35 } as const;

/** Car sparks (render/car/sparks.ts): when, where and how many, from the sim's contact telemetry. */
const SPARK = {
  /** Only cars this close to the camera throw sparks (m). */
  range: 140,
  /**
   * Sparks leave the contact backward at this share of the car's speed and outward from the
   * wall. Real sparks shed forward with the car, but then the body hides them from every
   * camera; a fan trailing behind is what the eye expects from a grinding car.
   */
  carry: 0.45,
  outward: 2.4,
  /** Scraping: sliding speed (m/s) before it sparks, sparks per tick per m/s, cap per tick, height band above the road (m). */
  scrapeMin: 2,
  scrapePerMs: 0.22,
  scrapeMax: 6,
  scrapeHeight: [0.2, 0.6],
  /** Bottoming out: overtravel (m) and speed (m/s) before it sparks, sparks per m of overtravel at 25 m/s, cap per tick. */
  bottomMin: 0.004,
  bottomSpeed: 5,
  bottomPerM: 260,
  bottomMax: 14,
  /** A hard wall hit: sparks per m/s of impact on top of 8, cap. */
  burstPerMs: 2.2,
  burstMax: 46,
} as const;
/** After a handoff with nobody at the wheel: the cruise brakes to a stop this gently (share of the brake), and lets go under this speed (m/s). */
const CRUISE_RUNOUT = { target: 0, maxBrake: 0.12 } as const;
const CRUISE_STOPPED = 0.3;
/** A crowd section's heard excitement crossing this cheers out loud, at most every SECTION_CHEER_GAP s. */
const SECTION_CHEER_LEVEL = 0.7;
const SECTION_CHEER_GAP = 8;
/**
 * The start crowd builds through the countdown: a wave this strong at each count (GO is 1).
 * A waiting grid alone only stirs a murmur, which an idling engine buried.
 */
const COUNTDOWN_CHEER: Record<number, number> = { 3: 0.45, 2: 0.6, 1: 0.8 };

export interface SessionOptions {
  config: RaceConfig;
  visuals: VisualBuild[];
  replay?: ReplayData & { decoded: number[] };
  ghost?: { config: RaceConfig; log: number[]; visual: VisualBuild } | null;
  /** Start / finish camera shots (default on; off for free roam). Replays never play them. */
  cinematics?: boolean;
  /** Free roam: where the waypoint is kept (main.ts shares one with the menu's map); the session keeps its own without it. */
  waypoint?: WaypointStore;
  /** The seed as the player knows it, for the map's header. */
  seedText?: string;
  /** A world already built for this config (same seed, route kind and open world flag): createRace reuses it instead of building one. */
  world?: World;
  /**
   * Free roam taken over from the menu (main.ts): the session drives in the
   * street stage's own scene, borrowed with stage.lend() and given back on
   * dispose, from the config's start pose (the stage car's). The camera
   * starts on `shot` (the showreel's) and swings onto the chase camera over
   * `pan` s; the stage's cruise drives until the first input.
   */
  handoff?: {
    stage: StreetStage;
    shot: HandoffShot;
    pan: number;
  };
  /** Free roam: the HUD card's Exit, back to the menu. */
  onQuit?: () => void;
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
  /** Nitrous screen warp, eased in and out (0 off, 1 at stage 1, more at the stages above), and the stage its edge glow takes (eased). */
  private nitroFx = 0;
  private nitroTint = 1;
  /** Gain the music is lifted by while boosting (1 = none), eased; main.ts hands it to the music player. */
  private lift = 1;
  /** Open world HUD: props the player broke, top speed (mph), the district shown and the one being entered. */
  private smashed = 0;
  private topMph = 0;
  private areaName = 'Downtown';
  private areaNext = '';
  private areaFor = 0;
  private blur = 0;
  private replayCam: ReplayCamMode = 'chase';
  /** Live sessions: a trackside or orbit view picked with the number keys (null: the follow camera). */
  private liveView: 'tv' | 'orbit' | null = null;
  /** Photo mode drone (0 key) and whether it paused the sim (live sessions hold still while it flies). */
  private drone: DroneMode | null = null;
  /** The full city map (Tab or a click on the minimap); the session holds still while it is open. */
  private fullMap: FullMap | null = null;
  /** The waypoint set on the city map (render only, never RaceState), and whether it can be reached yet. */
  private readonly wp: WaypointStore;
  private waypointArmed = false;
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
  /** Underbody and wall sparks for every car near the camera (render/car/sparks.ts). */
  private sparks: Sparks;
  /** The waypoint race's columns of light over its waypoints (null in the other modes). */
  private readonly beacons: WaypointBeacons | null = null;
  /** Ambient traffic (render/traffic/traffic.ts) and its last two snapshots (TRAFFIC_SNAP floats per car), swapped every tick. */
  private traffic: TrafficView | null = null;
  private trafficPrev = new Float32Array(0);
  private trafficCurr = new Float32Array(0);
  private carLight: THREE.PointLight;
  private engines: EngineVoice[] = [];
  private sfx: Sfx | null = null;
  /** Gamepad rumble for the player's car; none in a replay. */
  private readonly rumble: Rumble | null;
  /** Headlight flash level driven by the horn (render side only). */
  private flash = 0;
  /** Open world (free roam): no crowds, fireworks or line celebrations. */
  private readonly openWorld: boolean;
  /** The scene is the street stage's (handoff): it goes back to the stage on dispose instead of being disposed. */
  private readonly borrowed: boolean;
  /**
   * The menu's cruise still at the wheel after a handoff: its path distance
   * (carried tick to tick) and the last tick it drives, unless the player
   * touches a control first. Null once the player has the car.
   */
  private cruise: { drive: Cruise; s: number; untilTick: number } | null = null;
  /** Free roam: the HUD card the drone shares (ui/hudCard.ts), on top of the HUD's chips. */
  private card: HudCard | null = null;
  /** The controls dialog paused the drive (and so unpauses it when it closes). */
  private controlsPaused = false;
  /** Text on the circuit gantry sign, and the tick a pending change is applied (-1 = none). */
  private signText = '';
  private signAt = -1;
  /** Player lap whose line approach fireworks were launched. */
  private fireworksLap = -1;
  /** The police helicopter's brief from the last tick (render/traffic/policeChase.ts): patrol, or chase which car. */
  private chaseCall: ChaseCall = { phase: 'patrol', car: -1 };
  /** The drawbridge posed at sim time, its bell and the HUD warning (game/hazardFx.ts). */
  private readonly hazards: HazardFx;
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
    this.rumble = opts.replay ? null : new Rumble();
    this.uiRoot = uiRoot;
    let own: Vec2 | null = null;
    this.wp = opts.waypoint ?? { get: () => own, set: (p) => (own = p) };
    this.race = createRace(opts.config, opts.world);
    const hand = opts.handoff;
    this.borrowed = !!hand;
    this.night = hand ? hand.stage.lend() : createNightScene(this.race.world, gr, settings);
    if (hand) {
      // The scene's clock carries on from the stage's: its blinking, weather, steam and air traffic never jump.
      this.time = hand.stage.time;
      this.cruise = { drive: hand.stage.cruise, s: hand.stage.s, untilTick: this.race.tick + Math.round((hand.pan + 1) / DT) };
    }
    this.cam = new ChaseCamera(this.race.world);
    this.cine = new RaceCinematics(this.cam, this.race.world, uiRoot);
    // Free roam (the waypoint race's world is open too, but it is a race: grid, rivals, finish).
    this.openWorld = opts.config.openWorld === true;
    this.night.crowds.setEnabled(!this.openWorld);
    this.crowdCars = this.race.cars.map(() => ({ x: 0, z: 0, speed: 0 }));
    this.hud = new Hud(uiRoot, this.race.world);
    this.hud.onMapClick = () => this.toggleMap();
    this.hazards = new HazardFx(this.night.drawbridge, this.hud.root);
    if (this.openWorld) {
      // The same card as the drone's, in free roam's green from the menu: the district, time, smashes and top speed.
      this.card = new HudCard({
        hue: 'green',
        icon: Compass,
        title: 'Free roam',
        status: '',
        stats: ['Time', 'Smashed', 'Top speed'],
        actions: [btn(MapIcon, 'Map', () => this.toggleMap(), 'small')],
        onExit: () => opts.onQuit?.(),
        exitTitle: 'Back to the menu',
        controls: [...CONTROLS.keyboard, [['Tab'], 'City map'], [['0'], 'Drone photo mode']],
        canHide: () => !this.paused && !this.fullMap && !this.cine.active,
        onControls: (open) => this.pauseForControls(open),
      });
      this.hud.setCard(this.card);
    }
    // Tab opens the city map while driving and closes it again; in menus (paused) it keeps moving focus.
    const onTab = (e: KeyboardEvent) => {
      if (e.code !== 'Tab' || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!this.fullMap && (this.paused || this.drone || this.cine.active || this.isReplay)) return;
      e.preventDefault();
      this.toggleMap();
    };
    window.addEventListener('keydown', onTab);
    this.unsub.push(() => window.removeEventListener('keydown', onTab));
    this.sparks = new Sparks(settings.quality);
    this.night.scene.add(this.sparks.mesh);
    if (this.race.config.mode === 'waypoint' && this.race.world.route.waypoints) {
      this.beacons = new WaypointBeacons(this.race.world);
      this.night.scene.add(this.beacons.group);
    }
    const traffic = this.race.traffic;
    if (traffic) {
      this.traffic = new TrafficView(this.race.world, traffic.cars.length);
      this.night.scene.add(this.traffic.group);
      this.trafficCurr = new Float32Array(traffic.cars.length * TRAFFIC_SNAP);
      snapTraffic(traffic, this.trafficCurr);
      this.trafficPrev = this.trafficCurr.slice();
    }
    const loads: Promise<void>[] = [];
    this.race.cars.forEach((rc, i) => {
      // In the menu's scene the player's car carries no real lights, like the menu's car it replaces: a new light
      // count would recompile every lit shader in the city (seconds of freeze). The beam and underglow glows stay.
      const lit = i === 0 && !hand;
      const view = new CarView(rc.carId, assets, { headlights: lit, underglowLight: lit, envMap: gr.envMap, roadLift: ROAD_Y });
      this.night.scene.add(view.root);
      this.views.push(view);
      loads.push(view.load(opts.visuals[i] ?? opts.visuals[0]));
    });
    if (opts.ghost) {
      this.ghostRace = createRace(opts.ghost.config, this.race.world);
      this.ghostLog = opts.ghost.log;
      const gv = new CarView(opts.ghost.config.player.carId, assets, { envMap: gr.envMap, roadLift: ROAD_Y });
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
              // See-through: the road and its light show through a ghost.
              unmaskVehicle(mat);
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
    this.night.scene.add(this.trails.mesh);
    // A soft key light that rides above the player so cars read clearly at night.
    this.carLight = new THREE.PointLight(0xdfe6ff, 9, 9, 1.6);
    this.night.scene.add(this.carLight);
    // Engine sound: the player's car loud and centered, rivals by distance.
    const hub = audioHub();
    if (hub) {
      hub.applyLevels(settings);
      this.engines = this.race.cars.map((rc, i) => {
        const voice = new EngineVoice(manifestCar(rc.carId).engine, i === 0 ? 0.26 : 0.2, { lite: i > 0 });
        // An overrun pop flashes a flame at the car's tailpipe when it sounds.
        voice.onPop = (pipe, size, delay) => this.views[i]?.popFlash(pipe, size, delay);
        return voice;
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
    if (hand) {
      // The first frame is the showreel's shot of the car where it stands; the HUD waits for the swing to settle.
      this.cine.startHandoff(hand.shot, this.curr[0], hand.pan);
      this.cine.syncHud(this.hud.root, false);
    }
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
    } else if (!this.openWorld && this.race.world.event) this.hud.message(this.race.world.event.name, 2.6);
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

  /** True while the city map is open (Escape closes it). */
  get mapOpen(): boolean {
    return !!this.fullMap;
  }

  /**
   * Tab or a click on the minimap opens the full city map over the paused
   * session (the same map as the menu's, through openFullMap); Tab, Escape,
   * its close button or the backdrop close it. In free roam a click on the
   * map sets the waypoint the HUD then points to; a race shows its course in
   * its type's color instead (its waypoints are the race's own).
   */
  toggleMap(): void {
    if (this.fullMap) return this.closeMap();
    if (this.isReplay || this.drone || this.cine.active || this.paused || this.race.phase === 'finished') return;
    const p = this.curr[0];
    this.paused = true;
    this.input.releaseAll();
    this.input.setTouchVisible(false);
    const world = this.race.world;
    this.fullMap = openFullMap(this.uiRoot, world, { x: p.x, z: p.z, yaw: p.yaw, isPlayer: true }, {
      onClose: () => this.closeMap(),
      ...(this.openWorld
        ? { waypoint: { get: () => this.wp.get(), set: (w: Vec2 | null) => this.setWaypoint(w) } }
        : { course: courseFor(this.race.config.mode, world.route) }),
      event: world.event?.name,
      seed: this.opts.seedText ?? String(this.opts.config.seed),
    });
  }

  /** Free roam: the drive pauses under the HUD card's controls dialog, as under the map (keys there never reach the car). */
  private pauseForControls(open: boolean): void {
    if (open === this.controlsPaused || (open && this.paused)) return;
    this.controlsPaused = open;
    this.paused = open;
    this.input.releaseAll();
    this.input.setTouchVisible(!open);
  }

  /** Set or clear the free roam waypoint (render only). */
  private setWaypoint(w: Vec2 | null): void {
    this.wp.set(w ? { x: w.x, z: w.z } : null);
    const p = this.curr[0];
    this.waypointArmed = !!w && Math.hypot(w.x - p.x, w.z - p.z) > WAYPOINT.reach;
  }

  /** Driving up to the waypoint clears it, with a toast. */
  private checkWaypoint(x: number, z: number): void {
    const w = this.wp.get();
    if (!w || this.paused) return;
    const d = Math.hypot(w.x - x, w.z - z);
    if (!this.waypointArmed) {
      this.waypointArmed = d > WAYPOINT.arm;
      return;
    }
    if (d > WAYPOINT.reach) return;
    this.wp.set(null);
    toast('Waypoint reached', MapPinned);
  }

  closeMap(): void {
    if (!this.fullMap) return;
    this.fullMap.dispose();
    this.fullMap = null;
    // Keys pressed on the map must not reach the car as driving input.
    this.input.releaseAll();
    this.paused = false;
    this.input.setTouchVisible(true);
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
      title: 'Drone',
      exitLabel: 'Back to the car',
      cars: () => this.mapCars(),
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

  /** Gain to lift the music by (1 = none): the player's nitrous swell, eased per frame. */
  get musicLift(): number {
    return this.lift;
  }

  /** One fixed sim step. */
  tick(): void {
    if (this.paused) return this.rumble?.stop();
    const r = this.race;
    if (this.preRoll > 0) {
      // Pre-countdown intro shot: hold the sim (and ghost) at tick 0.
      if (--this.preRoll === 0) this.input.setTouchVisible(true);
      return;
    }
    let frame = NEUTRAL_INPUT;
    if (this.opts.replay) {
      // The log starts on the race's first tick (0 on a grid, the start pose's tick off it).
      const log = this.opts.replay.decoded;
      const i = r.tick - (r.config.openWorld && r.config.start ? r.config.start.tick : 0);
      frame = i < log.length ? unpackInput(log[i]) : { ...NEUTRAL_INPUT, brake: 0.5 };
    } else {
      frame = this.input.sample(DT);
      if (this.cruise) frame = this.cruiseHold(frame);
    }
    this.prev = this.curr;
    const speedBefore = r.cars[0].state.speed;
    this.resetThisTick = false;
    this.propOnlyTick = false;
    this.hardHitTick = false;
    stepRace(r, frame);
    this.curr = r.cars.map((c) => snap(c.state));
    if (r.traffic) {
      const t = this.trafficPrev;
      this.trafficPrev = this.trafficCurr;
      this.trafficCurr = t;
      snapTraffic(r.traffic, t);
    }
    if (this.ghostRace) {
      this.ghostPrev = this.ghostCurr;
      const gt = this.ghostRace.tick;
      stepRace(this.ghostRace, gt < this.ghostLog.length ? unpackInput(this.ghostLog[gt]) : { ...NEUTRAL_INPUT, brake: 1 });
      this.ghostCurr = snap(this.ghostRace.cars[0].state);
    }
    // Callouts for the nitrous the player's style earned this tick (ui/boostCallouts.ts).
    this.hud.callouts.tick(r.cars[0].state);
    this.chaseCall = policeChaseCall(r);
    this.sfx?.syncCountdown(r);
    this.handleEvents();
    if (this.rumble) {
      if (this.settings.rumble && r.phase !== 'finished') this.rumble.tick(r);
      else this.rumble.stop();
    }
    this.emitSparks();
    // A sudden loss of speed (a hard hit on anything, a dumpster) shakes the camera hard; resets do not count.
    // Ploughing through soft props (bushes, tables, bags) costs a little speed too: that stays a light knock.
    const drop = speedBefore - r.cars[0].state.speed;
    if (!this.resetThisTick) this.cam.slowdown(this.propOnlyTick && !this.hardHitTick ? drop - CAMERA.common.slowdownMin * PROP_SLOWDOWN_EXTRA : drop);
    if (r.phase === 'finished' && this.finishedAt < 0) this.finishedAt = r.tick;
    if (!this.openWorld) {
      // Each count shows on its first tick, as the beep does (sfx.syncCountdown): the first tick, then whole seconds.
      const left = r.countdownTicks - r.tick;
      if (left > 0 && (r.tick === 1 || left % TICK_HZ === 0)) {
        const hype = COUNTDOWN_CHEER[Math.ceil(left / TICK_HZ)];
        if (hype) this.night.crowds.cheer('start', hype);
      }
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

  /**
   * After a handoff the menu's cruise keeps driving (lane, speed, gates) so
   * the car rolls on as it did behind the menu. Any input from the player
   * ends it for good. With nobody at the wheel a second past the camera's
   * swing it eases to a stop on its lane instead of cruising forever, and
   * lets go once stopped.
   */
  private cruiseHold(frame: InputFrame): InputFrame {
    const h = this.cruise!;
    const r = this.race;
    const c = r.cars[0].state;
    const stopping = r.tick >= h.untilTick;
    const touched = frame.throttle > 0 || frame.brake > 0 || frame.handbrake || frame.nitrous || frame.shift !== 0 || frame.reset || Math.abs(frame.steer) > 0.01;
    if (touched || (stopping && c.speed < CRUISE_STOPPED)) {
      this.cruise = null;
      return frame;
    }
    const rc = r.cars[0];
    const st = rc.tuning.steering;
    // The lock the sim allows at this speed (car.ts): the cruise asks for wheel angles, the frame carries shares of it.
    const steerLimit = (st.maxDeg + (st.highSpeedDeg - st.maxDeg) * Math.max(0, Math.min(1, c.speed / st.fadeSpeed))) * DEG;
    const out: InputFrame = { ...NEUTRAL_INPUT };
    h.s = h.drive.drive(h.s, c.x, c.z, c.yaw, c.speed, r.tick * DT, { wheelbase: rc.tuning.geometry.wheelbase, steerLimit }, out, stopping ? CRUISE_RUNOUT : {});
    return out;
  }

  /**
   * Sparks from this tick's car telemetry, for cars near the camera: a fan
   * trailing from the contact while a car scrapes a wall or rail, and a spray
   * out from under the corner that bottomed out (landings, crests, kickers).
   */
  private emitSparks(): void {
    const cam = (this.lastCamera ?? this.cam.camera).position;
    const w = this.race.world;
    for (const rc of this.race.cars) {
      const c = rc.state;
      if ((c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 > SPARK.range * SPARK.range) continue;
      if ((c.scrapeNx || c.scrapeNz) && c.scrape > SPARK.scrapeMin) {
        const g = w.heightAt(c.scrapeX, c.scrapeZ);
        const tx = -c.scrapeNz;
        const tz = c.scrapeNx;
        const back = -(c.vx * tx + c.vz * tz) * SPARK.carry;
        const n = Math.min(SPARK.scrapeMax, c.scrape * SPARK.scrapePerMs);
        const y = g + SPARK.scrapeHeight[0] + Math.random() * (SPARK.scrapeHeight[1] - SPARK.scrapeHeight[0]);
        this.sparks.emit(this.time, c.scrapeX + c.scrapeNx * 0.06, y, c.scrapeZ + c.scrapeNz * 0.06, tx * back + c.scrapeNx * SPARK.outward, 1.6, tz * back + c.scrapeNz * SPARK.outward, 2, n, g);
      }
      if (c.bottomOut > SPARK.bottomMin && c.speed > SPARK.bottomSpeed) {
        const fx = Math.sin(c.yaw);
        const fz = Math.cos(c.yaw);
        let wu = 0;
        let wv = 0;
        if (c.bottomWheel >= 0) {
          // Just outboard of that wheel, so the spray clears the body.
          const wh = rc.tuning.geometry.wheels[c.bottomWheel];
          wv = wh[0] * 1.15;
          wu = wh[2] * 0.8;
        }
        const x = c.x + fx * wu + fz * wv;
        const z = c.z + fz * wu - fx * wv;
        const g = w.heightAt(x, z);
        const n = Math.min(SPARK.bottomMax, 3 + c.bottomOut * SPARK.bottomPerM * Math.min(1, c.speed / 25));
        const side = wv < 0 ? -1 : wv > 0 ? 1 : 0;
        this.sparks.emit(this.time, x, g + 0.04, z, -c.vx * SPARK.carry * 0.7 + fz * side * SPARK.outward, 1.5, -c.vz * SPARK.carry * 0.7 - fx * side * SPARK.outward, 2.2, n, g);
      }
    }
  }

  /** A hard hit on a wall or rail: one burst off the contact, bigger the harder the hit (impact m/s). */
  private sparkBurst(car: number, impact: number): void {
    const rc = this.race.cars[car];
    const c = rc?.state;
    if (!c || !(c.scrapeNx || c.scrapeNz)) return;
    const cam = (this.lastCamera ?? this.cam.camera).position;
    if ((c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 > SPARK.range * SPARK.range) return;
    const g = this.race.world.heightAt(c.scrapeX, c.scrapeZ);
    const out = 1 + impact * 0.25;
    const n = Math.min(SPARK.burstMax, 8 + impact * SPARK.burstPerMs);
    this.sparks.emit(this.time, c.scrapeX + c.scrapeNx * 0.08, g + 0.45, c.scrapeZ + c.scrapeNz * 0.08, c.vx * 0.4 + c.scrapeNx * out, 2, c.vz * 0.4 + c.scrapeNz * out, 3.2, n, g);
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
      this.rumble?.event(e);
      if (e.type === 'wall') this.sparkBurst(e.car, e.value ?? 0);
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
      } else if (e.type === 'arm') {
        // A level crossing's gate arm snapping: a light knock, like a sawhorse.
        this.propOnlyTick = true;
        this.cam.knock(0.4);
      } else if (e.type === 'reset') this.resetThisTick = true;
      if (e.type === 'prop' || e.type === 'arm') this.smashed++;
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
        case 'checkpoint': {
          // The waypoint race's waypoints (its last target is the finish line, which says FINISH itself).
          const n = (r.world.route.waypoints?.length ?? 0) - 1;
          const k = e.value ?? 0;
          if (r.config.mode === 'waypoint' && k <= n) this.hud.message(k < n ? `Waypoint ${k}/${n}  ${formatTime(raceTime(r))}` : `Waypoint ${k}/${n}  ·  TO THE FINISH`, 2);
          break;
        }
        case 'driftBank':
          // A drift that ran through a zone shows what the zone added.
          this.hud.message(`+${(e.value ?? 0).toLocaleString()}${e.other ? `  ·  zone +${e.other.toLocaleString()}` : ''}`, 1.2);
          break;
      }
    }
  }

  render(alpha: number, dt: number): void {
    this.time += dt;
    {
      const cam = this.lastCamera ?? this.cam.camera;
      const px = this.gr.renderer.domElement.clientHeight || window.innerHeight;
      this.sparks.update(this.time, (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, px));
    }
    this.beacons?.update(this.race.cars[0].nextCheckpoint, this.time);
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
    this.trails.update(this.views[0].root, camera, this.paused ? 0 : p.nitroStage, dt);
    this.carLight.position.set(p.x - Math.sin(p.yaw) * 1.5, p.y + 4.2, p.z - Math.cos(p.yaw) * 1.5);
    // The few real point lights follow the action, or the drone when it flies off.
    this.night.lighting.update(this.drone ? camera.position : new THREE.Vector3(p.x, p.y, p.z));
    // Last lap: the police helicopter follows the leader's interpolated pose.
    const chase = this.chaseCall;
    this.night.air.chase(chase.phase === 'chase' ? (poses[chase.car] ?? null) : null);
    // The El's trains and level crossings at the interpolated sim time: the gates close for these trains.
    this.night.syncDistricts(Math.max(0, r.tick - 1 + (this.paused ? 1 : alpha)), !this.paused, r.brokenArms);
    this.night.update(this.time);
    // Timed hazards (the drawbridge) at the interpolated sim time, so replays look the same.
    this.hazards.update(r, this.paused ? 1 : alpha, !this.paused);
    // Corner rail pieces shoved by hits this race.
    this.night.arrows.syncRails(r.rails);
    this.night.city.finishLine.update(this.time);
    // Props mirror the sim's broken flags; fresh breaks come apart pushed by the nearest car.
    this.night.props.update(this.paused ? 0 : dt, this.time, r.brokenProps, this.curr);
    this.traffic?.update(this.trafficPrev, this.trafficCurr, this.paused ? 1 : alpha, camera, this.time, this.settings.quality, r.tick);
    // Progressive edge blur: grows with speed, much stronger while boosting (eased in and out).
    const target = this.settings.radialBlur && !this.paused ? Math.max(0, Math.min(1, (p.speed - 25) / 45)) * 0.4 + (p.nitro ? 1 : 0) : 0;
    this.blur += (target - this.blur) * (1 - Math.exp(-dt * (target > this.blur ? 6 : 3)));
    this.gr.post.setSpeedBlur(this.blur);
    // Nitrous warp: in fast, out a little slower, harder and hotter each stage; follows the speed blur setting, off in the drone and while paused.
    const stage = this.paused ? 0 : p.nitroStage;
    const warpTarget = this.settings.radialBlur && !this.drone && stage > 0 ? NITRO_FX.stageWarp[stage - 1] : 0;
    this.nitroFx += (warpTarget - this.nitroFx) * (1 - Math.exp(-dt * (warpTarget > this.nitroFx ? NITRO_IN : NITRO_OUT)));
    if (warpTarget === 0 && this.nitroFx < 0.002) this.nitroFx = 0;
    if (stage > 0) this.nitroTint += (stage - this.nitroTint) * (1 - Math.exp(-dt * NITRO_IN));
    this.gr.post.setNitroFx(this.nitroFx, this.time, this.nitroTint);
    // The music swells with the stage burning.
    const lift = stage > 0 ? 10 ** (MUSIC_LIFT.db[stage - 1] / 20) : 1;
    this.lift += (lift - this.lift) * (1 - Math.exp(-dt * (lift > this.lift ? MUSIC_LIFT.in : MUSIC_LIFT.out)));
    if (lift === 1 && this.lift < 1.001) this.lift = 1;
    this.updateHud(dt);
    this.updateEngines(poses, camera, dt);
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

  private updateEngines(poses: Snap[], camera: THREE.PerspectiveCamera, dt: number): void {
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
      voice.update({ rpm: p.rpm, redline: rc.tuning.engine.redline, throttle: p.throttle, nitro: p.nitro, proximity, pan: pan * 0.8, shifting: p.shifting, dt });
    });
  }

  /** Intro fly-in and finish hero shot (and the menu's handoff swing), layered over the chase camera. */
  private applyCinematics(p: Snap, dt: number): void {
    const step = this.paused ? 0 : dt;
    if (this.cine.phase === 'handoff') this.cine.applyHandoff(p, step);
    else if (this.cineOn) {
      const r = this.race;
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
    }
    if (this.cineOn || this.borrowed) this.cine.syncHud(this.hud.root, this.preRoll > 0, step);
  }

  private updateCamera(p: Snap, dt: number): THREE.PerspectiveCamera {
    const len = this.views[0].car.dimensions.length;
    // Cinematics always run on the follow camera; the number key views take over afterwards.
    const view: ReplayCamMode = this.isReplay ? this.replayCam : this.cine.active ? 'chase' : (this.liveView ?? 'chase');
    if (isFollowCam(view)) {
      // Cobbled alleys: a fine rumble that grows with speed (camera.ts rumble).
      this.cam.rumble(this.race.cars[0].state.surface === 'cobble' ? Math.hypot(p.vx, p.vz) : 0);
      // Gear share for the chase pull back: 0 in first or reverse, 1 in top.
      const rc = this.race.cars[0];
      const gears = rc.tuning.gearbox.ratios.length;
      const gear = gears > 1 ? Math.max(0, rc.state.gear - 1) / (gears - 1) : 0;
      this.cam.update(p, p.vx, p.vz, p.nitroStage, gear, len, dt);
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

  /** Car markers for the minimap: the field, then the ghost. */
  private mapCars(): HudCar[] {
    return [
      ...this.curr.map((s, i) => ({ x: s.x, z: s.z, yaw: s.yaw, isPlayer: i === 0 })),
      ...this.trafficDots(),
      ...(this.ghostCurr ? [{ x: this.ghostCurr.x, z: this.ghostCurr.z, yaw: this.ghostCurr.yaw, isPlayer: false, isGhost: true }] : []),
    ];
  }

  /** Free roam minimap: the traffic near the player as small dots (races keep the map to the field). */
  private trafficDots(): HudCar[] {
    if (!this.openWorld || !this.race.traffic) return [];
    const p = this.curr[0];
    const out: HudCar[] = [];
    const t = this.trafficCurr;
    for (let o = 0; o < t.length; o += TRAFFIC_SNAP) {
      if (t[o + 3] < 0 || (t[o] - p.x) ** 2 + (t[o + 1] - p.z) ** 2 > TRAFFIC_DOT_RANGE ** 2) continue;
      out.push({ x: t[o], z: t[o + 1], yaw: t[o + 2], isPlayer: false, isTraffic: true });
    }
    return out;
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
      speedMph: mph(c.speed),
      rpm: c.rpm,
      redline: rc.tuning.engine.redline,
      gear: c.gear,
      manual: c.manualGearbox,
      nitro: c.nitro,
      nitroActive: c.nitroActive,
      nitroStage: c.nitroStage,
      throttle: c.throttle,
      countdown,
      wrongWay: rc.wrongWay,
      progress: Math.max(0, rc.dist) / r.distance,
      drift: r.config.mode === 'drift' ? { total: r.drift.total, current: r.drift.current, multiplier: r.drift.multiplier, zoneBonus: r.drift.zoneBonus } : undefined,
      cars: this.mapCars(),
      ghost: !!this.ghostRace,
    };
    const zone = driftZoneStatus(r, 0);
    if (zone) data.zone = { mul: r.config.mode === 'drift' ? DRIFT_ZONES.scoreMul : DRIFT_ZONES.refillMul, nitro: r.config.mode !== 'drift', left: zone.left, resting: zone.resting };
    // The waypoint race points the waypoint chip and the minimap at the next target.
    const target = r.config.mode === 'waypoint' && !rc.finished ? r.world.route.waypoints?.[rc.nextCheckpoint] : undefined;
    if (target) {
      const n = r.world.route.waypoints!.length - 1;
      data.waypoint = target;
      data.waypointLabel = rc.nextCheckpoint < n ? `Waypoint ${rc.nextCheckpoint + 1}/${n}` : 'Finish';
    }
    if (this.openWorld) {
      this.topMph = Math.max(this.topMph, mph(c.speed));
      this.updateArea(c.x, c.z, dt);
      data.openWorld = { area: this.areaName, smashed: this.smashed, topMph: this.topMph };
      this.checkWaypoint(c.x, c.z);
      const wp = this.wp.get();
      if (wp) data.waypoint = wp;
    }
    this.hud.update(data, dt);
  }

  /** Track the district under the player; a new one is announced once the car settles in it. */
  private updateArea(x: number, z: number, dt: number): void {
    const a = this.race.world.areaAt(x, z);
    const name = placeName(a);
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
    this.fullMap?.dispose();
    this.fullMap = null;
    this.drone?.dispose();
    this.drone = null;
    this.card?.dispose();
    this.unsub.forEach((u) => u());
    this.freeCam?.dispose();
    this.hazards.dispose();
    this.hud.dispose();
    this.views.forEach((v) => v.dispose());
    this.ghostView?.dispose();
    this.trails.dispose();
    this.sparks.dispose();
    this.beacons?.dispose();
    this.traffic?.dispose();
    this.engines.forEach((e) => e.dispose());
    this.night.city.finishLine.onFirework = null;
    this.sfx?.dispose();
    this.rumble?.stop();
    this.cine.dispose();
    this.carLight.removeFromParent();
    this.carLight.dispose();
    // A borrowed scene goes back to the menu's stage as it was; everything this session added has left it above.
    if (this.borrowed) this.opts.handoff?.stage.reclaim();
    else this.night.dispose();
    this.input.setTouchVisible(false);
  }
}
