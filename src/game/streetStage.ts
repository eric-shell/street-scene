/**
 * The street stage: the player's car cruising the event city at night. It is
 * the scene behind the main menu (shot by the showreel camera,
 * game/streetCameras.ts), what the drone and the free camera fly over, and the
 * garage's Street presentation (with an orbit camera that rides along).
 *
 * Render only. The car follows a smoothed line in the right lane around the
 * event route (CruisePath), lifts off for corners and brakes for the level
 * crossings while their gates are down, and sits on the terrain
 * like a sprung car: it dives under braking, squats as it pulls away and leans
 * out of corners. The stage owns the menu city (World and NightScene) and keeps
 * its own clock, which the timed districts and the crossings read as ticks
 * (time x TICK_HZ), so the gates the car waits at are the gates on screen.
 *
 * The cars swing round roadworks closures (CruisePath) and knock over any
 * destructible they still touch, as a race car would; a knocked prop stands
 * back up once every car is PROPS.restore m away, so the loop round the
 * route never strips the street.
 *
 * Free roam from the menu carries straight on from this car: the session
 * borrows the scene (lend / reclaim) and the Cruise keeps driving the sim car
 * on the lane, at the cruise's speed, until the player touches a control.
 *
 * The setup step's car pick builds a convoy (setBuild's `hop`): a build
 * not on the street yet joins HOP.gap behind the last car in the line,
 * out of the setup shot (it looks forward from behind the car), and one
 * already there is simply driven to. The cars keep their places in the
 * line, all at one speed, so once every build has joined, picking walks
 * round them. The showreel glides along the lane to whichever car is
 * picked (it watches `hops`). Any other build set (the garage, a new
 * street) and free roam clear the line back to the one car.
 */
import * as THREE from 'three';
import { CityAmbience, ambienceTraits } from '../audio/cityAmbience';
import { TrainRumble } from '../audio/sceneVoices';
import type { World } from '../city/world';
import { routeSample, type Route } from '../city/route';
import { createNightScene, type GameRenderer, type NightScene } from '../render/scene';
import { CarView, WHEEL_KEYS, type CarPose } from '../render/car/carView';
import { Drivers } from '../render/people/drivers';
import { ROAD_Y } from '../render/street/cityMeshes';
import type { CarAssetLibrary } from '../render/car/carAssets';
import type { CarBuild } from '../shared/carBuild';
import { clamp } from '../sim/math';
import { LEVEL_GAP } from '../sim/constants';
import { damp } from '../shared/anim';
import { ExposureAdapt } from '../render/exposure';
import type { Settings } from '../ui/settings';
import type { CarMotion } from '../render/street/props';
import { CRUISE, Cruise, newPathSample, type CruisePath } from './cruise';
import { KeyLight } from './keyLight';
import { LIGHT_RIG } from '../render/lighting';

/**
 * The menu cars against the street's destructibles: a prop goes down when it
 * comes within `pad` m of a car's footprint (its manifest length and width),
 * and stands again once every car is `restore` m from it, well out of the
 * showreel's shot.
 */
const PROPS = { pad: 0.1, restore: 160 } as const;

/**
 * The setup step's convoy: the gap between cars in the line (m) and how
 * many cars it holds at most (the garage's slots; past that the car
 * farthest from the picked one goes).
 */
export const HOP = { gap: 38, maxCars: 6 } as const;

/** A car on the street: the picked one, or one waiting in the convoy. */
interface StreetCar {
  /** The garage slot it shows (setBuild's key), when one was given. */
  key: number | undefined;
  carId: string;
  view: CarView | null;
  /** Path distance from the picked car (m, + ahead); 0 for the picked car. */
  offset: number;
  pose: CarPose;
  /** Body lean (rad) and its rates: the springs the pitch and roll ride on. */
  lean: { pitch: number; pitchV: number; roll: number; rollV: number };
  /**
   * Height last frame (m), the level the car is on under a river bridge (World.heightAt): the
   * route dives under the decks, so the car stays on the channel floor beneath one. Unset before
   * the first pose (the route never starts in the channel).
   */
  level: number | undefined;
  /** Wheel spin (rad). */
  spin: number;
}

const newPose = (): CarPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, comp: [0, 0, 0, 0], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 });

/** Copy a pose's values into another (its arrays too, kept as they are). */
function copyPose(from: CarPose, to: CarPose): void {
  const { comp, spin } = to;
  Object.assign(to, from);
  to.comp = comp;
  to.spin = spin;
  for (let i = 0; i < 4; i++) {
    comp[i] = from.comp[i];
    spin[i] = from.spin[i];
  }
}

function newCar(key: number | undefined, carId: string, view: CarView | null, offset: number, pose: CarPose = newPose()): StreetCar {
  return { key, carId, view, offset, pose, lean: { pitch: 0, pitchV: 0, roll: 0, rollV: 0 }, level: undefined, spin: 0 };
}

export class StreetStage {
  readonly night: NightScene;
  /** The cruise's driving logic and its path round the route. */
  readonly cruise: Cruise;
  readonly path: CruisePath;
  /** Scene clock (s): the timed districts and the gates the car waits at all read it. */
  time = 0;
  /** The picked car's distance along the path (m), and the speed every car on the street goes (m/s). */
  s: number;
  speed: number = CRUISE.speed;
  /** The picked car's pose this frame (what the cameras frame; the same object whichever car is picked). */
  readonly pose: CarPose = newPose();
  /** How many times the pick has moved to another car in the convoy (the showreel glides to it on each). */
  hops = 0;
  /** The picked car: `s` and `pose` are its. */
  private lead: StreetCar = newCar(undefined, '', null, 0, this.pose);
  /** The rest of the convoy, at their offsets from the picked car. */
  private readonly convoy: StreetCar[] = [];
  /** The drivers at every car's wheel, and who sits where this frame. */
  private readonly drivers = new Drivers(HOP.maxCars);
  private readonly seatViews: CarView[] = [];
  private readonly seatPoses: CarPose[] = [];
  private loading: Promise<void> = Promise.resolve();
  private loadToken = 0;
  /** The key light over the player's car; null on a tier whose light rig has none (LIGHT_RIG). */
  private readonly carLight: KeyLight | null;
  /** The scene is out on loan to a free roam session (lend). */
  private lent = false;
  /** The city's ambience bed (audio/cityAmbience.ts), made on the first step after a user gesture. */
  private ambience: CityAmbience | null = null;
  private ambienceTried = false;
  private readonly sample = newPathSample();
  private readonly focus = new THREE.Vector3();
  /** Eye adaptation to tunnels and cover under the cruising car (render/exposure.ts). */
  private readonly exposure = new ExposureAdapt();
  private accel = 0;
  /** Lean added by the caller this frame (the garage's revs), rad. */
  private extraPitch = 0;
  private extraRoll = 0;
  /** Road height under each wheel this frame (FL, FR, RL, RR). */
  private readonly road = [0, 0, 0, 0];
  /** The street's props as the race flags them (RaceState.brokenProps): 1 knocked down, 2 under a route barrier. */
  private readonly broken: Uint8Array;
  /** Props knocked down, waiting for the cars to leave so they can stand again. */
  private readonly down: number[] = [];
  /** Every car's motion this frame, which way a prop it hits comes apart. */
  private readonly motions: CarMotion[] = [];
  /** The same cars for the idle people's heads (x, z, speed), rebuilt from the motions each frame. */
  private readonly idleCars: { x: number; z: number; speed: number }[] = [];
  private readonly hits: number[] = [];

  constructor(
    gr: GameRenderer,
    private readonly assets: CarAssetLibrary,
    readonly world: World,
    private readonly settings: Settings,
  ) {
    this.night = createNightScene(world, gr, settings);
    this.cruise = new Cruise(world);
    this.path = this.cruise.path;
    this.broken = new Uint8Array(world.props.length);
    for (const id of world.coveredProps ?? []) this.broken[id] = 2;
    this.s = this.path.wrap(this.path.nearest(...startPoint(world.route)) - CRUISE.startBack);
    this.carLight = LIGHT_RIG[settings.quality].keyLight ? new KeyLight() : null;
    if (this.carLight) this.night.scene.add(this.carLight);
    this.place(0);
  }

  /**
   * Hand the scene to a free roam session that carries on from the car as it
   * stands (game/session.ts). The circuit's dressing goes, since the open
   * world has none of it: barriers and the street meets behind them, corner
   * rails and route arrows, the crowds. The stage's own car, the rest of the
   * convoy, their drivers and the key light leave the scene for the session's, and the stage
   * stands still until reclaim() puts everything back.
   */
  lend(): NightScene {
    this.lent = true;
    this.dropConvoy();
    if (this.lead.view) this.lead.view.root.visible = false;
    // The drivers go with their cars: the stage stops placing them while lent, so they would sit where the convoy was.
    this.drivers.group.visible = false;
    if (this.carLight) this.carLight.visible = false;
    const n = this.night;
    n.crowds.setEnabled(false);
    n.roadblocks.group.visible = false;
    n.arrows.group.visible = false;
    return n;
  }

  /** The scene back from a session: the dressing, the car and the scene clock return, every prop back on its feet. */
  reclaim(): void {
    if (!this.lent) return;
    this.lent = false;
    const n = this.night;
    n.crowds.setEnabled(true);
    n.roadblocks.group.visible = true;
    n.arrows.group.visible = true;
    // NaN hands the El and the level crossings back to the scene clock (render/districts).
    n.syncDistricts(NaN, false);
    for (const id of this.down) this.broken[id] = 0;
    this.down.length = 0;
    n.props.update(0, this.time, this.broken, []);
    if (this.lead.view) this.lead.view.root.visible = true;
    this.drivers.group.visible = true;
    if (this.carLight) this.carLight.visible = true;
    this.place(0);
  }

  /** The picked car on the street, once a build has been set. */
  get car(): CarView | null {
    return this.lead.view;
  }

  /**
   * Put a build on the street: the paint and parts change in place, a different
   * car swaps the model once it has loaded (old out and new in on the same
   * frame, so the street is never without a car). `key` names the garage slot
   * it shows. With `hop` (the setup step's pick) the slot's car is driven to
   * if it is already in the convoy, or joins HOP.gap behind the last car once
   * loaded; without it, a different slot (or none) clears the convoy first.
   */
  setBuild(build: Pick<CarBuild, 'carId' | 'visual'>, opts: { key?: number; hop?: boolean } = {}): Promise<void> {
    const token = ++this.loadToken;
    const lead = this.lead;
    if (opts.hop && lead.view && !this.lent) return this.pickBuild(build, opts.key, token);
    if (opts.key === undefined || opts.key !== lead.key) this.dropConvoy();
    lead.key = opts.key;
    if (lead.view && lead.carId === build.carId) {
      // load(), not applyVisual(): a later call supersedes an earlier one still loading, and only load()
      // finishes the base model if that earlier one was the first.
      this.loading = lead.view.load(build.visual);
      return this.loading;
    }
    const first = !lead.view;
    const view = this.newView(build.carId);
    // The first car joins at once, so the city's shaders compile with it from the first frame.
    if (first) {
      lead.view = view;
      lead.carId = build.carId;
      this.night.scene.add(view.root);
    }
    this.loading = view.load(build.visual).then(() => {
      if (token !== this.loadToken) return void (first ? undefined : view.dispose());
      if (!first) {
        lead.view?.dispose();
        lead.view = view;
        lead.carId = build.carId;
        this.night.scene.add(view.root);
      }
      this.place(0);
    });
    return this.loading;
  }

  /** Resolves when the car on the street shows the last build set. */
  get ready(): Promise<void> {
    return this.loading;
  }

  /**
   * A car for the street. No headlight spots or underglow light: every lit pixel of the city pays for
   * each real light, and the menu is drawn on every device. The beams' glow on the road, the underglow
   * and the key light above stay.
   */
  private newView(carId: string): CarView {
    return new CarView(carId, this.assets, { envMap: this.night.scene.environment, roadLift: ROAD_Y });
  }

  /** The setup step's pick: drive to the slot's car in the convoy, or load it and add it behind the last car. */
  private pickBuild(build: Pick<CarBuild, 'carId' | 'visual'>, key: number | undefined, token: number): Promise<void> {
    const lead = this.lead;
    if (key === lead.key && lead.carId === build.carId) return (this.loading = lead.view!.load(build.visual));
    const i = this.convoy.findIndex((c) => c.key === key);
    if (i >= 0 && this.convoy[i].carId === build.carId) {
      this.pickCar(i);
      return (this.loading = Promise.resolve());
    }
    // The slot shows another car than the one in the line: that one goes.
    if (i >= 0) this.dropCar(i);
    const view = this.newView(build.carId);
    this.loading = view.load(build.visual).then(() => {
      if (token !== this.loadToken || this.lent) return void view.dispose();
      if (this.convoy.length + 1 >= HOP.maxCars) {
        let far = 0;
        for (let j = 1; j < this.convoy.length; j++) if (Math.abs(this.convoy[j].offset) > Math.abs(this.convoy[far].offset)) far = j;
        this.dropCar(far);
      }
      let rear = 0;
      for (const c of this.convoy) rear = Math.min(rear, c.offset);
      const car = newCar(key, build.carId, view, rear - HOP.gap);
      car.level = this.levelAt(car.offset);
      this.night.scene.add(view.root);
      this.convoy.push(car);
      this.pickCar(this.convoy.length - 1);
    });
    return this.loading;
  }

  /**
   * Make convoy car i the picked one. The cars keep their places on the lane:
   * the offsets move to the new pick, and the poses trade so `pose` stays the
   * picked car's.
   */
  private pickCar(i: number): void {
    const old = this.lead;
    const next = this.convoy[i];
    const shift = next.offset;
    const pose = newPose();
    copyPose(old.pose, pose);
    copyPose(next.pose, this.pose);
    old.pose = pose;
    next.pose = this.pose;
    for (const c of this.convoy) c.offset -= shift;
    old.offset = -shift;
    next.offset = 0;
    this.convoy[i] = old;
    this.lead = next;
    this.s = this.path.wrap(this.s + shift);
    this.hops++;
    this.place(0);
  }

  /**
   * The level (World.heightAt) `offset` m along the lane from the picked car,
   * walked there in 2 m steps, so a car placed on or under a river deck
   * stands on the deck or the channel floor it would have driven to.
   */
  private levelAt(offset: number): number | undefined {
    let level = this.lead.level;
    const n = Math.ceil(Math.abs(offset) / 2);
    for (let k = 1; k <= n; k++) {
      const c = this.path.sample(this.path.wrap(this.s + (offset * k) / n), this.sample);
      level = this.world.heightAt(c.x, c.z, level);
    }
    return level;
  }

  private dropCar(i: number): void {
    this.convoy[i].view?.dispose();
    this.convoy.splice(i, 1);
  }

  /** Back to the one car. */
  private dropConvoy(): void {
    while (this.convoy.length) this.dropCar(0);
  }

  /**
   * Advance the clock and the cars by dt seconds. `throttle` (0..1, the garage's
   * rev) raises the cruise speed toward a sprint and `lean` rocks the picked
   * car's body on top of the road and the driving (rad); the real lights follow
   * `focus` (default the picked car) and the timed districts run on the stage clock.
   */
  step(dt: number, opts: { throttle?: number; focus?: THREE.Vector3; lean?: { pitch: number; roll: number } } = {}): void {
    if (this.lent) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.extraPitch = opts.lean?.pitch ?? 0;
    this.extraRoll = opts.lean?.roll ?? 0;
    // One speed for the whole convoy, the slowest any car in it needs, so the gaps hold and none runs a lowered gate.
    let target = this.cruise.targetSpeed(this.s, this.speed, this.time, opts.throttle ?? 0);
    for (const c of this.convoy) target = Math.min(target, this.cruise.targetSpeed(this.path.wrap(this.s + c.offset), this.speed, this.time));
    const before = this.speed;
    if (target > this.speed) this.speed = Math.min(target, this.speed + CRUISE.accel * dt);
    else this.speed = Math.max(target, this.speed - CRUISE.brake * dt);
    const a = (this.speed - before) / Math.max(dt, 1e-4);
    this.accel += (a - this.accel) * damp(6, dt);
    this.s = this.path.wrap(this.s + this.speed * dt);
    this.place(dt);
    const p = this.pose;
    // The key light rides with the car, as in a race.
    this.carLight?.follow(p);
    this.night.lighting.update(opts.focus ?? this.focus.set(p.x, p.y, p.z));
    this.night.update(this.time);
    this.night.envProbes.update(p.x, p.z, dt);
    // The same city bed as a race, on the stage clock (silent while lent to a free roam session, which has its own).
    if (!this.ambience && !this.ambienceTried) {
      this.ambience = CityAmbience.create(ambienceTraits(this.world.seed, this.night.weather.mood, this.world.areas, this.night.weather.timeline.turn?.to));
      this.ambienceTried = this.ambience !== null || !TrainRumble.blocked();
    }
    this.ambience?.update(this.time, dt, opts.focus?.y ?? this.pose.y, 0, this.night.weather.live);
    // The street furniture's own clock: the traffic signals, the props the cars knock over, debris and spray.
    this.knockProps();
    this.night.props.update(dt, this.time, this.broken, this.motions);
    // The idle people turn their heads for the passing cars and keep their level of detail around the car the camera follows.
    const ic = this.idleCars;
    ic.length = this.motions.length;
    this.motions.forEach((m, i) => (ic[i] = { x: m.x, z: m.z, speed: Math.hypot(m.vx, m.vz) }));
    const f = opts.focus ?? this.focus;
    this.night.idlers.update(this.time, ic, f.x, f.z);
    this.night.walkers.update(this.time, ic, f.x, f.z);
  }

  /** Knock down the props the cars touch this frame, and stand up the ones every car has left behind. */
  private knockProps(): void {
    const motions = this.motions;
    motions.length = 0;
    this.knockBy(this.lead);
    for (const c of this.convoy) this.knockBy(c);
    const r2 = PROPS.restore * PROPS.restore;
    const down = this.down;
    for (let i = down.length - 1; i >= 0; i--) {
      const p = this.world.props[down[i]];
      let near = false;
      for (const m of motions) near ||= (m.x - p.x) ** 2 + (m.z - p.z) ** 2 < r2;
      if (near) continue;
      this.broken[down[i]] = 0;
      down[i] = down[down.length - 1];
      down.pop();
    }
  }

  /** One car against the props round it: its footprint box, as the sim's (sim/props.ts) but every touch breaks. */
  private knockBy(sc: StreetCar): void {
    const p = sc.pose;
    const sin = Math.sin(p.yaw);
    const cos = Math.cos(p.yaw);
    this.motions.push({ x: p.x, z: p.z, vx: this.speed * sin, vz: this.speed * cos });
    const dim = sc.view?.car.dimensions;
    if (!dim) return;
    const hl = dim.length / 2 + PROPS.pad;
    const hw = dim.width / 2 + PROPS.pad;
    const reach = hl + 2;
    const hits = this.hits;
    this.world.propGrid.query(p.x - reach, p.z - reach, p.x + reach, p.z + reach, hits);
    for (const id of hits) {
      if (this.broken[id]) continue;
      const q = this.world.props[id];
      if (Math.abs(q.y - p.y) > LEVEL_GAP) continue;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      // Car space: u forward, v right; the gap from the box to the prop's center against its radius.
      const u = Math.abs(dx * sin + dz * cos) - hl;
      const v = Math.abs(dx * cos - dz * sin) - hw;
      const r = q.depth ?? q.radius;
      if (Math.max(u, 0) ** 2 + Math.max(v, 0) ** 2 > r * r) continue;
      this.broken[id] = 1;
      this.down.push(id);
    }
  }

  /** Render the stage through `camera`, with `blur` of speed blur (the showreel's glide between cars; off when the setting is). */
  render(gr: GameRenderer, camera: THREE.PerspectiveCamera, dt: number, blur = 0): void {
    gr.post.setSpeedBlur(this.settings.radialBlur ? blur : 0);
    const p = this.pose;
    this.exposure.update(this.world, p.x, p.y, p.z, dt);
    this.exposure.apply((v) => gr.setExposure(v), this.night.scene.fog as THREE.FogExp2 | null, this.night.weather.live.density);
    gr.render(this.night.scene, camera, dt);
  }

  /** Pose every car on the street, then seat their drivers. */
  private place(dt: number): void {
    this.placeCar(this.lead, dt);
    for (const c of this.convoy) this.placeCar(c, dt);
    const lead = this.lead.view;
    if (!lead) return;
    if (!this.drivers.group.parent) this.night.scene.add(this.drivers.group);
    const views = this.seatViews;
    const poses = this.seatPoses;
    views.length = poses.length = 0;
    views.push(lead);
    poses.push(this.pose);
    for (const c of this.convoy)
      if (c.view) {
        views.push(c.view);
        poses.push(c.pose);
      }
    this.drivers.update(views, poses);
  }

  /** Pose a car at its place on the lane: on the terrain, steered by the path, leaning on its springs. */
  private placeCar(sc: StreetCar, dt: number): void {
    const c = this.path.sample(this.path.wrap(this.s + sc.offset), this.sample);
    const p = sc.pose;
    const view = sc.view;
    const car = view?.car;
    const yaw = c.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Road height under each wheel (local x left, z forward, rotated by yaw).
    const h = this.road;
    let half = 0.8;
    let wb = 2.6;
    if (car) {
      wb = Math.max(1, car.wheelbase);
      half = Math.max(0.4, Math.abs(car.wheels.FL[0]));
      for (let i = 0; i < 4; i++) {
        const w = car.wheels[WHEEL_KEYS[i]];
        h[i] = this.world.heightAt(c.x + w[0] * cos + w[2] * sin, c.z - w[0] * sin + w[2] * cos, sc.level);
      }
    } else h.fill(this.world.heightAt(c.x, c.z, sc.level));
    const y = (h[0] + h[1] + h[2] + h[3]) / 4;
    sc.level = y;
    const slopePitch = -Math.atan(((h[0] + h[1]) / 2 - (h[2] + h[3]) / 2) / wb);
    const slopeRoll = Math.atan(((h[0] + h[2]) / 2 - (h[1] + h[3]) / 2) / (2 * half));
    // Dive and squat from the speed change, lean out of the corner from the sideways pull.
    const L = sc.lean;
    if (dt > 0) {
      const w = 2 * Math.PI * CRUISE.bodyHz;
      const pitchT = clamp(-this.accel * CRUISE.pitchPerAccel, -CRUISE.maxLean, CRUISE.maxLean);
      const rollT = clamp(this.speed * this.speed * c.k * CRUISE.rollPerAccel, -CRUISE.maxLean, CRUISE.maxLean);
      L.pitchV += (w * w * (pitchT - L.pitch) - 2 * CRUISE.bodyDamping * w * L.pitchV) * dt;
      L.pitch += L.pitchV * dt;
      L.rollV += (w * w * (rollT - L.roll) - 2 * CRUISE.bodyDamping * w * L.rollV) * dt;
      L.roll += L.rollV * dt;
    }
    // The garage's revs rock only the picked car.
    const picked = sc === this.lead;
    p.x = c.x;
    p.z = c.z;
    p.y = y;
    p.yaw = yaw;
    p.pitch = slopePitch + L.pitch + (picked ? this.extraPitch : 0);
    p.roll = slopeRoll + L.roll + (picked ? this.extraRoll : 0);
    p.steer = Math.max(-0.5, Math.min(0.5, Math.atan(wb * c.k)));
    // Wheels on the road: CarView lifts each wheel with the body's tilt, so take that back off and
    // what is left is the springs (squashed on the side the body leans to).
    if (car)
      for (let i = 0; i < 4; i++) {
        const w = car.wheels[WHEEL_KEYS[i]];
        p.comp[i] = h[i] - y - (w[0] * p.roll - w[2] * p.pitch);
      }
    sc.spin = (sc.spin + (this.speed / Math.max(0.2, car?.wheelRadius ?? 0.3)) * dt) % (Math.PI * 2);
    p.spin.fill(sc.spin);
    p.braking = this.speed < 0.5 || this.accel < -CRUISE.brakeLights;
    p.speed = this.speed;
    view?.update(p, this.time);
  }

  dispose(): void {
    this.drivers.dispose();
    this.dropConvoy();
    this.lead.view?.dispose();
    this.lead.view = null;
    this.ambience?.dispose();
    this.night.dispose();
  }
}

/** The start line on the route, as a point. */
function startPoint(route: Route): [number, number] {
  const c = routeSample(route, route.startS);
  return [c.x, c.z];
}
