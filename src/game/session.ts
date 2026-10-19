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
import { CarAssetLibrary } from '../render/carAssets';
import { ChaseCamera } from '../render/camera';
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
  };
}

export type ReplayCamMode = 'chase' | 'close' | 'hood' | 'tv' | 'orbit' | 'free';
const REPLAY_CAMS: ReplayCamMode[] = ['chase', 'tv', 'orbit', 'close', 'hood', 'free'];

export interface SessionOptions {
  config: RaceConfig;
  visuals: VisualBuild[];
  replay?: ReplayData & { decoded: number[] };
  ghost?: { config: RaceConfig; log: number[]; visual: VisualBuild } | null;
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
  private time = 0;
  private replayCam: ReplayCamMode = 'chase';
  private freeCam: FreeFlyCamera | null = null;
  private tvPoint = new THREE.Vector3();
  private tvValid = false;
  private tvSide = 1;
  private unsub: (() => void)[] = [];
  readonly isReplay: boolean;
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
    this.hud = new Hud(uiRoot, this.race.world);
    const loads: Promise<void>[] = [];
    this.race.cars.forEach((rc, i) => {
      const view = new CarView(rc.carId, assets, { headlights: i === 0, underglowLight: i === 0 });
      this.night.scene.add(view.root);
      this.views.push(view);
      loads.push(view.load(opts.visuals[i] ?? opts.visuals[0]));
    });
    if (opts.ghost) {
      this.ghostRace = createRace(opts.ghost.config, this.race.world);
      this.ghostLog = opts.ghost.log;
      const gv = new CarView(opts.ghost.config.player.carId, assets);
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
    this.curr = this.race.cars.map((c) => snap(c.state));
    this.prev = this.curr.map((s) => ({ ...s }));
    if (this.ghostRace) {
      this.ghostCurr = snap(this.ghostRace.cars[0].state);
      this.ghostPrev = { ...this.ghostCurr };
    }
    this.unsub.push(
      input.on('camera', () => {
        if (this.isReplay) this.cycleReplayCam();
        else this.hud.message(`Camera: ${this.cam.cycle()}`, 1);
      }),
    );
    input.setTouchVisible(!this.isReplay);
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
    this.handleEvents();
    if (r.phase === 'finished' && this.finishedAt < 0) this.finishedAt = r.tick;
    if (this.finishedAt >= 0 && r.tick - this.finishedAt === Math.round(2.5 / DT) && this.onFinish) {
      this.onFinish({ race: r, tuned: this.tuned });
    }
  }

  private handleEvents(): void {
    const r = this.race;
    for (; this.eventIndex < r.events.length; this.eventIndex++) {
      const e = r.events[this.eventIndex];
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
    const r = this.race;
    const poses = this.curr.map((c, i) => lerpSnap(this.prev[i], c, this.paused ? 1 : alpha));
    this.views.forEach((v, i) => v.update(poses[i], this.time));
    if (this.ghostView && this.ghostPrev && this.ghostCurr) this.ghostView.update(lerpSnap(this.ghostPrev, this.ghostCurr, alpha), this.time);
    const p = poses[0];
    const player = r.cars[0];
    if (player.state.impact > 4) this.cam.bump(Math.min(1, player.state.impact / 20));
    const camera = this.updateCamera(p, dt);
    this.night.lighting.update(new THREE.Vector3(p.x, p.y, p.z));
    this.night.update(this.time);
    const blur = this.settings.radialBlur && !this.paused ? Math.max(0, Math.min(1, (p.speed - 28) / 40)) * 0.55 + (p.nitro ? 0.45 : 0) : 0;
    this.gr.post.setSpeedBlur(blur);
    this.updateHud(dt);
    this.gr.render(this.night.scene, camera, dt);
  }

  private updateCamera(p: Snap, dt: number): THREE.PerspectiveCamera {
    const len = this.views[0].car.dimensions.length;
    if (!this.isReplay || this.replayCam === 'chase' || this.replayCam === 'close' || this.replayCam === 'hood') {
      this.cam.update(p, p.vx, p.vz, p.nitro, len, dt);
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
    this.night.dispose();
    this.input.setTouchVisible(false);
  }
}
