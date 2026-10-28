/**
 * The session's sound: one engine voice per car (the player's loud and
 * centered, rivals by distance), the sound effects (crashes, nitrous, scrapes,
 * the horn, countdown beeps, the crowds) and the feeds that drive them every
 * render frame from the interpolated poses. Nothing exists when the browser
 * has no audio hub yet (it only starts after a user gesture). Render only.
 */
import * as THREE from 'three';
import type { RaceState } from '../../sim/race';
import type { CarView } from '../../render/car/carView';
import type { CrowdCar } from '../../render/race/crowds';
import type { NightScene } from '../../render/scene';
import type { Settings } from '../../ui/settings';
import { TrainRumble } from '../../audio/sceneVoices';
import { EngineVoice, audioHub } from '../../audio/engineAudio';
import { Sfx } from '../../audio/sfx';
import { CarAlarms } from '../../audio/carAlarm';
import { CarHorns } from '../../audio/carHorn';
import { CityAmbience, ambienceTraits } from '../../audio/cityAmbience';
import { manifestCar } from '../../render/car/carAssets';
import type { Snap } from './snap';

/** A crowd section's heard excitement crossing this cheers out loud, at most every SECTION_CHEER_GAP s. */
const SECTION_CHEER_LEVEL = 0.7;
const SECTION_CHEER_GAP = 8;

export class SessionAudio {
  readonly engines: EngineVoice[] = [];
  readonly sfx: Sfx | null = null;
  /** Alarms of struck parked cars and the horns of traffic that was passed close (both read the sim's traffic state). */
  private alarms: CarAlarms | null = null;
  private horns: CarHorns | null = null;
  /** Racer poses for the crowd (reused every frame). */
  private readonly crowdCars: CrowdCar[];
  /** Last heard excitement and last cheer time (s) per crowd section spot. */
  private readonly sectionLevel: number[] = [];
  private readonly sectionCheerAt: number[] = [];
  /** The city's hum, wind and distant one-shots; made on the first frame after a user gesture. */
  private ambience: CityAmbience | null = null;
  private ambienceTried = false;
  /** Headlight flash level driven by the horn (render side only). */
  private flash = 0;

  constructor(
    settings: Settings,
    private readonly race: RaceState,
    private readonly views: CarView[],
    private readonly night: NightScene,
  ) {
    this.crowdCars = race.cars.map(() => ({ x: 0, z: 0, yaw: 0, speed: 0 }));
    // Engine sound: the player's car loud and centered, rivals by distance.
    const hub = audioHub();
    if (hub) {
      hub.applyLevels(settings);
      this.engines = race.cars.map((rc, i) => {
        const voice = new EngineVoice(manifestCar(rc.carId).engine, i === 0 ? 0.26 : 0.2, { lite: i > 0 });
        // An overrun pop flashes a flame at the car's tailpipe when it sounds.
        voice.onPop = (pipe, size, delay) => views[i]?.popFlash(pipe, size, delay);
        return voice;
      });
      // Crashes, nitrous, scrapes, horn and countdown beeps (src/audio/sfx.ts).
      this.sfx = new Sfx();
      this.alarms = new CarAlarms();
      this.horns = new CarHorns();
      const sfx = this.sfx;
      night.city.finishLine.onFirework = (x, y, z, size) => sfx.firework(x, y, z, size);
    }
  }

  /** Nitrous and scrape loops, the listener for one-shots, and the horn with its headlight flash. */
  updateSfx(poses: Snap[], camera: THREE.PerspectiveCamera, dt: number, paused: boolean, time: number, horn: boolean, alpha: number): void {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    this.sfx?.setListener(camera.position.x, camera.position.z, right.x, right.z);
    const cars = poses.map((p, i) => {
      const g = this.race.cars[i].tuning.geometry;
      return { x: p.x, z: p.z, yaw: p.yaw, vx: p.vx, vz: p.vz, nitro: p.nitro, halfLength: g.halfLength, halfWidth: g.halfWidth };
    });
    // The city bed: scene clock, camera height, and the player's pedal (it ducks under the engine). A pause lets it fade out.
    if (!this.ambience && !this.ambienceTried) {
      const w = this.race.world;
      this.ambience = CityAmbience.create(ambienceTraits(w.seed, this.night.weather.mood, w.areas, this.night.weather.timeline.turn?.to));
      this.ambienceTried = this.ambience !== null || !TrainRumble.blocked();
    }
    if (!paused) this.ambience?.update(time, dt, camera.position.y, poses[0].throttle, this.night.weather.live);
    this.sfx?.updateCars(cars, this.race.world, dt, paused);
    const listener = { x: camera.position.x, z: camera.position.z, rx: right.x, rz: right.z };
    this.alarms?.update(this.race, listener, paused);
    this.horns?.update(this.race, listener, paused);
    // Crowds react to the racers' (sim) poses and are heard from the camera. The people run on the sim's own time
    // (the interpolated tick, as syncDistricts reads it) rather than the scene clock, so a walker is drawn where the sim
    // has it and a person hit falls from the tick they were hit; a pause freezes them with the sim.
    const cc = this.crowdCars;
    for (let i = 0; i < cc.length; i++) {
      const p = poses[i];
      cc[i].x = p.x;
      cc[i].z = p.z;
      cc[i].yaw = p.yaw;
      cc[i].speed = p.speed;
    }
    const peopleTime = Math.max(0, this.race.tick - 1 + (paused ? 1 : alpha)) / 60;
    const people = this.race.people;
    this.night.crowds.update(peopleTime, paused ? 0 : dt, cc, camera.position.x, camera.position.z, people);
    this.night.idlers.update(peopleTime, cc, camera.position.x, camera.position.z, people);
    this.night.walkers.update(peopleTime, cc, camera.position.x, camera.position.z, people);
    this.sfx?.updateCrowds(this.night.crowds.spots, paused);
    // A section erupting as racers pass: a burst of cheering and applause from it (at most every few seconds).
    if (!paused) {
      const spots = this.night.crowds.spots;
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        if (s.kind !== 'section') continue;
        const was = this.sectionLevel[i] ?? 0;
        this.sectionLevel[i] = s.level;
        if (s.level > SECTION_CHEER_LEVEL && was <= SECTION_CHEER_LEVEL && time > (this.sectionCheerAt[i] ?? -1e9) + SECTION_CHEER_GAP) {
          this.sectionCheerAt[i] = time;
          this.sfx?.crowdCheer((s.ax + s.bx) / 2, (s.az + s.bz) / 2, 0.55, true);
        }
      }
    }
    // Horn (live races only, never recorded) flashes the player's headlights while held.
    this.sfx?.horn(horn);
    this.flash = horn ? Math.min(1, this.flash + dt / 0.04) : Math.max(0, this.flash - dt / 0.12);
    this.views[0].flashHeadlights(this.flash);
  }

  updateEngines(poses: Snap[], camera: THREE.PerspectiveCamera, dt: number, paused: boolean): void {
    if (!this.engines.length) return;
    if (paused) {
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
      voice.update({ rpm: p.rpm, redline: rc.tuning.engine.redline, throttle: p.throttle, nitro: p.nitro, proximity, pan: pan * 0.8, shifting: p.shifting, cut: p.cut, dt });
    });
  }

  dispose(): void {
    this.engines.forEach((e) => e.dispose());
    this.night.city.finishLine.onFirework = null;
    this.sfx?.dispose();
    this.alarms?.dispose();
    this.horns?.dispose();
    this.ambience?.dispose();
  }
}
