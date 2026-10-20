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
import { EngineType, EngineVoice, audioHub } from '../audio/engineAudio';
import { Sfx } from '../audio/sfx';
import { manifestCar } from '../render/carAssets';
import { CarAssetLibrary } from '../render/carAssets';
import { CAMERA, ChaseCamera } from '../render/camera';
import { RaceCinematics } from '../render/cinematics';
import { GameRenderer, NightScene, createNightScene } from '../render/scene';
import { FreeFlyCamera } from '../render/freeFly';
import { InputManager } from '../input/inputManager';
import { Hud, HudData } from '../ui/hud';
import { Settings } from '../ui/settings';
import { formatTime } from '../ui/format';
import { ReplayData } from '../replay/replay';

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

export type ReplayCamMode = 'chase' | 'close' | 'hood' | 'tv' | 'orbit' | 'free';
const REPLAY_CAMS: ReplayCamMode[] = ['chase', 'tv', 'orbit', 'close', 'hood', 'free'];

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
  private blur = 0;
  private replayCam: ReplayCamMode = 'chase';
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
    this.race = createRace(opts.config);
    this.night = createNightScene(this.race.world, gr, settings);
    this.cam = new ChaseCamera(this.race.world);
    this.cine = new RaceCinematics(this.cam, this.race.world, uiRoot);
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
        const type = ((manifestCar(rc.carId) as unknown as { engine?: { type?: EngineType } }).engine?.type ?? 'i4') as EngineType;
        return new EngineVoice(type, i === 0 ? 0.26 : 0.2);
      });
      // Crashes, nitrous, scrapes, horn and countdown beeps (src/audio/sfx.ts).
      this.sfx = new Sfx();
    }
    this.curr = this.race.cars.map((c) => snap(c.state));
    this.prev = this.curr.map((s) => ({ ...s }));
    if (this.ghostRace) {
      this.ghostCurr = snap(this.ghostRace.cars[0].state);
      this.ghostPrev = { ...this.ghostCurr };
    }
    this.unsub.push(
      input.on('camera', () => {
        if (this.cine.phase === 'outro') return;
        if (this.isReplay) this.cycleReplayCam();
        else this.hud.message(`Camera: ${this.cam.cycle()}`, 1);
      }),
    );
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

  private cycleReplayCam(): void {
    this.replayCam = REPLAY_CAMS[(REPLAY_CAMS.indexOf(this.replayCam) + 1) % REPLAY_CAMS.length];
    if (this.replayCam === 'chase' || this.replayCam === 'close' || this.replayCam === 'hood') {
      this.cam.mode = this.replayCam === 'hood' ? 'hood' : this.replayCam;
    }
    if (this.replayCam === 'free') {
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
    if (r.phase === 'finished' && this.finishedAt < 0) this.finishedAt = r.tick;
    if (r.tick === r.countdownTicks) this.night.city.finishLine.burst('start', 0.7);
    // Results wait for the finish shot (or a skip); without cinematics, 2.5 s.
    const delay = this.cineOn ? CAMERA.outro.resultsDelay : 2.5;
    if (this.finishedAt >= 0 && !this.resultsShown && this.onFinish && (this.skipFinish || r.tick - this.finishedAt >= Math.round(delay / DT))) {
      this.resultsShown = true;
      this.cine.settle();
      this.onFinish({ race: r, tuned: this.tuned });
    }
  }

  private handleEvents(): void {
    const r = this.race;
    for (; this.eventIndex < r.events.length; this.eventIndex++) {
      const e = r.events[this.eventIndex];
      this.sfx?.raceEvent(e, r);
      if (e.car !== 0) continue;
      const rc = r.cars[0];
      switch (e.type) {
        case 'lap': {
          const t = ticksToSeconds(rc.lapTimes[rc.lapTimes.length - 1] ?? 0);
          const best = rc.bestLap === rc.lapTimes[rc.lapTimes.length - 1];
          if ((e.value ?? 0) < r.config.laps) this.hud.message(`Lap ${e.value}  ${formatTime(t)}${best ? '  BEST' : ''}${(e.value ?? 0) === r.config.laps - 1 ? '  ·  FINAL LAP' : ''}`, 2.6);
          break;
        }
        case 'finish':
          this.hud.message(`FINISH  ${formatTime(raceTime(r))}`, 4);
          this.night.city.finishLine.burst('finish');
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
    const player = r.cars[0];
    this.cam.impact(player.state.impact);
    const camera = this.updateCamera(p, dt);
    this.trails.update(this.views[0].root, camera, p.nitro && !this.paused, dt);
    this.carLight.position.set(p.x - Math.sin(p.yaw) * 1.5, p.y + 4.2, p.z - Math.cos(p.yaw) * 1.5);
    this.night.lighting.update(new THREE.Vector3(p.x, p.y, p.z));
    this.night.update(this.time);
    this.night.city.finishLine.update(this.time);
    // Props mirror the sim's broken flags; fresh breaks come apart pushed by the nearest car.
    this.night.props.update(this.paused ? 0 : dt, this.time, r.brokenProps, this.curr);
    // Progressive edge blur: grows with speed, much stronger while boosting (eased in and out).
    const target = this.settings.radialBlur && !this.paused ? Math.max(0, Math.min(1, (p.speed - 25) / 45)) * 0.4 + (p.nitro ? 0.75 : 0) : 0;
    this.blur += (target - this.blur) * (1 - Math.exp(-dt * (target > this.blur ? 6 : 3)));
    this.gr.post.setSpeedBlur(this.blur);
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
    if (!this.isReplay || this.replayCam === 'chase' || this.replayCam === 'close' || this.replayCam === 'hood') {
      this.cam.update(p, p.vx, p.vz, p.nitro, len, dt);
      this.applyCinematics(p, dt);
      return this.cam.camera;
    }
    const cam = this.cam.camera;
    if (this.replayCam === 'free' && this.freeCam) {
      this.freeCam.update(dt);
      return this.freeCam.camera;
    }
    if (this.replayCam === 'orbit') {
      const a = this.time * 0.35;
      cam.position.set(p.x + Math.sin(a) * 8, p.y + 2.6, p.z + Math.cos(a) * 8);
      cam.lookAt(p.x, p.y + 0.8, p.z);
      return cam;
    }
    // TV: a roadside camera ahead of the car that tracks it as it passes.
    const d = this.tvPoint.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
    if (!this.tvValid || d > 70) {
      // Next roadside camera: on the route ahead, near the curb, so it is never inside a building.
      const route = this.race.world.route;
      const rc = this.race.cars[0];
      const ahead = routeSample(route, rc.rawS + 45);
      const half = route.segWidth[ahead.seg] / 2 - 1;
      const side = this.tvSide = -this.tvSide;
      const x = ahead.x + ahead.tz * half * side;
      const z = ahead.z - ahead.tx * half * side;
      this.tvPoint.set(x, this.race.world.heightAt(x, z) + 3.2, z);
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
    this.hud.update(data, dt);
  }

  dispose(): void {
    this.unsub.forEach((u) => u());
    this.freeCam?.dispose();
    this.hud.dispose();
    this.views.forEach((v) => v.dispose());
    this.ghostView?.dispose();
    this.trails.dispose();
    this.engines.forEach((e) => e.dispose());
    this.sfx?.dispose();
    this.cine.dispose();
    this.carLight.removeFromParent();
    this.carLight.dispose();
    this.night.dispose();
    this.input.setTouchVisible(false);
  }
}
