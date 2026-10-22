/**
 * The street stage: the player's car cruising the event city at night. It is
 * the scene behind the main menu (shot by the showreel camera,
 * game/streetCameras.ts), what the drone and the free camera fly over, and the
 * garage's Street presentation (with an orbit camera that rides along).
 *
 * Render only. The car follows a smoothed line in the right lane around the
 * event route (CruisePath), lifts off for corners and brakes for the drawbridge
 * and the level crossings while their gates are down, and sits on the terrain
 * like a sprung car: it dives under braking, squats as it pulls away and leans
 * out of corners. The stage owns the menu city (World and NightScene) and keeps
 * its own clock, which the timed districts and the drawbridge read as ticks
 * (time x TICK_HZ), so the gates the car waits at are the gates on screen.
 *
 * Free roam from the menu carries straight on from this car: the session
 * borrows the scene (lend / reclaim) and the Cruise keeps driving the sim car
 * on the lane, at the cruise's speed, until the player touches a control.
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import { routeSample, type Route } from '../city/route';
import { createNightScene, type GameRenderer, type NightScene } from '../render/scene';
import { CarView, type CarPose } from '../render/carView';
import { ROAD_Y } from '../render/cityMeshes';
import type { CarAssetLibrary } from '../render/carAssets';
import type { CarBuild } from '../sim/build';
import { TICK_HZ } from '../sim/constants';
import type { Settings } from '../ui/settings';
import { CRUISE, Cruise, type CruisePath, type PathSample } from './cruise';

const WHEELS = ['FL', 'FR', 'RL', 'RR'] as const;

export class StreetStage {
  readonly night: NightScene;
  /** The cruise's driving logic and its path round the route. */
  readonly cruise: Cruise;
  readonly path: CruisePath;
  /** Scene clock (s): the timed districts, the drawbridge and the gates the car waits at all read it. */
  time = 0;
  /** Distance along the path (m) and speed (m/s). */
  s: number;
  speed: number = CRUISE.speed;
  /** The car's pose this frame (what the cameras frame). */
  readonly pose: CarPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, comp: [0, 0, 0, 0], spin: [0, 0, 0, 0], braking: false, nitro: false, speed: 0 };
  private view: CarView | null = null;
  private viewCar = '';
  private loading: Promise<void> = Promise.resolve();
  private loadToken = 0;
  private readonly carLight = new THREE.PointLight(0xdfe6ff, 9, 9, 1.6);
  /** The scene is out on loan to a free roam session (lend). */
  private lent = false;
  private readonly sample: PathSample = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
  private readonly focus = new THREE.Vector3();
  /** The car's heading as a unit vector (sin, cos of the yaw). */
  private readonly fwd = { x: 0, z: 1 };
  private spin = 0;
  private accel = 0;
  /** Body lean (rad) and its rates: the springs the pitch and roll ride on. */
  private lean = { pitch: 0, pitchV: 0, roll: 0, rollV: 0 };
  /** Lean added by the caller this frame (the garage's revs), rad. */
  private extraPitch = 0;
  private extraRoll = 0;
  /** Road height under each wheel this frame (FL, FR, RL, RR). */
  private readonly road = [0, 0, 0, 0];

  constructor(
    gr: GameRenderer,
    private readonly assets: CarAssetLibrary,
    readonly world: World,
    settings: Settings,
  ) {
    this.night = createNightScene(world, gr, settings);
    this.cruise = new Cruise(world);
    this.path = this.cruise.path;
    this.s = this.path.wrap(this.path.nearest(...startPoint(world.route)) - CRUISE.startBack);
    this.night.scene.add(this.carLight);
    this.place(0);
  }

  /**
   * Hand the scene to a free roam session that carries on from the car as it
   * stands (game/session.ts). The circuit's dressing goes, since the open
   * world has none of it: barriers and the street meets behind them, corner
   * rails and route arrows, the crowds. The stage's own car and key light
   * leave the scene for the session's, and the stage stands still until
   * reclaim() puts everything back.
   */
  lend(): NightScene {
    this.lent = true;
    if (this.view) this.view.root.visible = false;
    this.carLight.visible = false;
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
    n.props.update(0, this.time, new Uint8Array(this.world.props.length), []);
    if (this.view) this.view.root.visible = true;
    this.carLight.visible = true;
    this.place(0);
  }

  /** The car on the street, once a build has been set. */
  get car(): CarView | null {
    return this.view;
  }

  /**
   * Put a build on the street: the paint and parts change in place, a different
   * car swaps the model once it has loaded (old out and new in on the same
   * frame, so the street is never without a car).
   */
  setBuild(build: Pick<CarBuild, 'carId' | 'visual'>): Promise<void> {
    const token = ++this.loadToken;
    if (this.view && this.viewCar === build.carId) {
      // load(), not applyVisual(): a later call supersedes an earlier one still loading, and only load()
      // finishes the base model if that earlier one was the first.
      this.loading = this.view.load(build.visual);
      return this.loading;
    }
    const first = !this.view;
    // No headlight spots or underglow light: every lit pixel of the city pays for each real light, and the
    // menu is drawn on every device. The beams' glow on the road, the underglow and the key light above stay.
    const view = new CarView(build.carId, this.assets, { envMap: this.night.scene.environment, roadLift: ROAD_Y });
    // The first car joins at once, so the city's shaders compile with it from the first frame.
    if (first) {
      this.view = view;
      this.viewCar = build.carId;
      this.night.scene.add(view.root);
    }
    this.loading = view.load(build.visual).then(() => {
      if (token !== this.loadToken) return void (first ? undefined : view.dispose());
      if (!first) {
        this.view?.dispose();
        this.view = view;
        this.viewCar = build.carId;
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
   * Advance the clock and the car by dt seconds. `throttle` (0..1, the garage's
   * rev) raises the cruise speed toward a sprint and `lean` rocks the body on
   * top of the road and the driving (rad); the real lights follow `focus`
   * (default the car) and the timed districts run on the stage clock.
   */
  step(dt: number, opts: { throttle?: number; focus?: THREE.Vector3; lean?: { pitch: number; roll: number } } = {}): void {
    if (this.lent) return;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.extraPitch = opts.lean?.pitch ?? 0;
    this.extraRoll = opts.lean?.roll ?? 0;
    const target = this.cruise.targetSpeed(this.s, this.speed, this.time, opts.throttle ?? 0);
    const before = this.speed;
    if (target > this.speed) this.speed = Math.min(target, this.speed + CRUISE.accel * dt);
    else this.speed = Math.max(target, this.speed - CRUISE.brake * dt);
    const a = (this.speed - before) / Math.max(dt, 1e-4);
    this.accel += (a - this.accel) * (1 - Math.exp(-dt * 6));
    this.s = this.path.wrap(this.s + this.speed * dt);
    this.place(dt);
    const p = this.pose;
    // A soft key light rides above and behind the car, as in a race, so it reads clearly at night.
    this.carLight.position.set(p.x - this.fwd.x * 1.5, p.y + 4.2, p.z - this.fwd.z * 1.5);
    this.night.lighting.update(opts.focus ?? this.focus.set(p.x, p.y, p.z));
    // The drawbridge on the stage clock, through sync: once a session has driven it, its own clock no longer does.
    this.night.drawbridge.sync(this.time * TICK_HZ, false);
    this.night.update(this.time);
  }

  /** Render the stage through `camera`. */
  render(gr: GameRenderer, camera: THREE.PerspectiveCamera, dt: number): void {
    gr.post.setSpeedBlur(0);
    gr.render(this.night.scene, camera, dt);
  }

  /** Pose the car at the current distance: on the terrain, steered by the path, leaning on its springs. */
  private place(dt: number): void {
    const c = this.path.sample(this.s, this.sample);
    const p = this.pose;
    const view = this.view;
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
        const w = car.wheels[WHEELS[i]];
        h[i] = this.world.heightAt(c.x + w[0] * cos + w[2] * sin, c.z - w[0] * sin + w[2] * cos);
      }
    } else h.fill(this.world.heightAt(c.x, c.z));
    const y = (h[0] + h[1] + h[2] + h[3]) / 4;
    const slopePitch = -Math.atan(((h[0] + h[1]) / 2 - (h[2] + h[3]) / 2) / wb);
    const slopeRoll = Math.atan(((h[0] + h[2]) / 2 - (h[1] + h[3]) / 2) / (2 * half));
    // Dive and squat from the speed change, lean out of the corner from the sideways pull.
    const L = this.lean;
    if (dt > 0) {
      const w = 2 * Math.PI * CRUISE.bodyHz;
      const pitchT = Math.max(-CRUISE.maxLean, Math.min(CRUISE.maxLean, -this.accel * CRUISE.pitchPerAccel));
      const rollT = Math.max(-CRUISE.maxLean, Math.min(CRUISE.maxLean, this.speed * this.speed * c.k * CRUISE.rollPerAccel));
      L.pitchV += (w * w * (pitchT - L.pitch) - 2 * CRUISE.bodyDamping * w * L.pitchV) * dt;
      L.pitch += L.pitchV * dt;
      L.rollV += (w * w * (rollT - L.roll) - 2 * CRUISE.bodyDamping * w * L.rollV) * dt;
      L.roll += L.rollV * dt;
    }
    p.x = c.x;
    p.z = c.z;
    p.y = y;
    p.yaw = yaw;
    this.fwd.x = sin;
    this.fwd.z = cos;
    p.pitch = slopePitch + L.pitch + this.extraPitch;
    p.roll = slopeRoll + L.roll + this.extraRoll;
    p.steer = Math.max(-0.5, Math.min(0.5, Math.atan(wb * c.k)));
    // Wheels on the road: CarView lifts each wheel with the body's tilt, so take that back off and
    // what is left is the springs (squashed on the side the body leans to).
    if (car)
      for (let i = 0; i < 4; i++) {
        const w = car.wheels[WHEELS[i]];
        p.comp[i] = h[i] - y - (w[0] * p.roll - w[2] * p.pitch);
      }
    this.spin = (this.spin + (this.speed / Math.max(0.2, car?.wheelRadius ?? 0.3)) * dt) % (Math.PI * 2);
    p.spin.fill(this.spin);
    p.braking = this.speed < 0.5 || this.accel < -CRUISE.brakeLights;
    p.speed = this.speed;
    view?.update(p, this.time);
  }

  dispose(): void {
    this.view?.dispose();
    this.view = null;
    this.night.dispose();
  }
}

/** The start line on the route, as a point. */
function startPoint(route: Route): [number, number] {
  const c = routeSample(route, route.startS);
  return [c.x, c.z];
}
