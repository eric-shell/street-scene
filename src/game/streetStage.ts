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
 */
import * as THREE from 'three';
import type { World } from '../city/world';
import { routeSample, type Route } from '../city/route';
import { createNightScene, type GameRenderer, type NightScene } from '../render/scene';
import { CarView, type CarPose } from '../render/carView';
import { ROAD_Y } from '../render/cityMeshes';
import type { CarAssetLibrary } from '../render/carAssets';
import type { CarBuild } from '../sim/build';
import { gatePhase, type GatePhase } from '../sim/gates';
import { TICK_HZ } from '../sim/constants';
import type { Settings } from '../ui/settings';

/** How the car drives: speeds (m/s), accelerations (m/s²), its lane and how the line is smoothed. */
export const CRUISE = {
  /** Cruising speed, and the speed full throttle (the garage's rev button) builds up to. */
  speed: 15,
  sprint: 27,
  /** Sideways acceleration it takes corners at, and how hard it speeds up and brakes. */
  cornerAccel: 3.2,
  accel: 2.2,
  brake: 3.6,
  /** Brake lights show when slowing harder than this, or when stopped. */
  brakeLights: 0.9,
  /** Lane: this share of the road width right of the centerline, at most `laneMax` m. */
  laneShare: 0.19,
  laneMax: 2.6,
  /** Path samples every `step` m, smoothed `smoothPasses` times over ±`smoothSpan` samples. */
  step: 2,
  smoothSpan: 3,
  smoothPasses: 3,
  /** How far ahead it plans for corners and gates (m), and where it stops before a gate line (m). */
  lookAhead: 70,
  stopShort: 5.5,
  /** Starts this far before the start line, so the first shots roll through the start gantry. */
  startBack: 60,
  /** Body motion: spring rate (Hz) and damping, and how far it pitches and rolls per m/s² (rad). */
  bodyHz: 1.6,
  bodyDamping: 0.45,
  pitchPerAccel: 0.006,
  rollPerAccel: 0.009,
  maxLean: 0.05,
} as const;

/** One point on the cruise path: position, unit heading and curvature (1/m, positive turning left). */
export interface PathSample {
  x: number;
  z: number;
  tx: number;
  tz: number;
  yaw: number;
  k: number;
}

/**
 * A smoothed lane line around the route, sampled every CRUISE.step m: the
 * centerline shifted into the right lane, then averaged so corners become
 * arcs. Distances wrap on circuits.
 */
export class CruisePath {
  readonly length: number;
  readonly closed: boolean;
  private readonly x: Float64Array;
  private readonly z: Float64Array;
  private readonly yaw: Float64Array;
  private readonly k: Float64Array;
  private readonly cum: Float64Array;

  constructor(route: Route) {
    this.closed = route.closed;
    const n = Math.max(8, Math.ceil(route.length / CRUISE.step));
    let x = new Float64Array(n);
    let z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const c = routeSample(route, (i / n) * route.length);
      const lane = Math.min(CRUISE.laneMax, route.segWidth[c.seg] * CRUISE.laneShare);
      // Right of a heading (tx, tz) is (-tz, tx).
      x[i] = c.x - c.tz * lane;
      z[i] = c.z + c.tx * lane;
    }
    const wrap = (i: number) => (this.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
    for (let pass = 0; pass < CRUISE.smoothPasses; pass++) {
      const nx = new Float64Array(n);
      const nz = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let sx = 0;
        let sz = 0;
        for (let j = -CRUISE.smoothSpan; j <= CRUISE.smoothSpan; j++) {
          sx += x[wrap(i + j)];
          sz += z[wrap(i + j)];
        }
        nx[i] = sx / (2 * CRUISE.smoothSpan + 1);
        nz[i] = sz / (2 * CRUISE.smoothSpan + 1);
      }
      x = nx;
      z = nz;
    }
    this.x = x;
    this.z = z;
    this.cum = new Float64Array(n + 1);
    this.yaw = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const j = this.closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      this.cum[i + 1] = this.cum[i] + Math.hypot(x[j] - x[i], z[j] - z[i]);
    }
    this.length = this.cum[n];
    // Heading at each sample from its neighbours, unwrapped so curvature is a plain difference.
    for (let i = 0; i <= n; i++) {
      const a = wrap(i - 1);
      const b = wrap(i + 1);
      let yw = Math.atan2(x[b] - x[a], z[b] - z[a]);
      if (i > 0) yw += Math.round((this.yaw[i - 1] - yw) / (2 * Math.PI)) * 2 * Math.PI;
      this.yaw[i] = yw;
    }
    this.k = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) this.k[i] = (this.yaw[i + 1] - this.yaw[i]) / Math.max(1e-3, this.cum[i + 1] - this.cum[i]);
    this.k[n] = this.k[0];
  }

  /** Distance s wrapped onto the path (clamped on an open route). */
  wrap(s: number): number {
    const L = this.length;
    return this.closed ? ((s % L) + L) % L : Math.max(0, Math.min(L, s));
  }

  /** The path at distance s; writes into `out`. */
  sample(sIn: number, out: PathSample): PathSample {
    const s = this.wrap(sIn);
    const cum = this.cum;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const n = this.x.length;
    const j = this.closed ? (lo + 1) % n : Math.min(n - 1, lo + 1);
    const t = (s - cum[lo]) / Math.max(1e-6, cum[lo + 1] - cum[lo]);
    out.x = this.x[lo] + (this.x[j] - this.x[lo]) * t;
    out.z = this.z[lo] + (this.z[j] - this.z[lo]) * t;
    out.yaw = this.yaw[lo] + (this.yaw[lo + 1] - this.yaw[lo]) * t;
    out.tx = Math.sin(out.yaw);
    out.tz = Math.cos(out.yaw);
    out.k = this.k[lo] + (this.k[lo + 1] - this.k[lo]) * t;
    return out;
  }

  /** Distance of the point on the path nearest (x, z) (coarse: sample spacing). */
  nearest(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < this.x.length; i++) {
      const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return this.cum[best];
  }

  /**
   * Where the path crosses the segment (ax, az)-(bx, bz) heading against its
   * normal (nx, nz), the side a gate holds traffic back on: path distances.
   */
  crossings(ax: number, az: number, bx: number, bz: number, nx: number, nz: number): number[] {
    const out: number[] = [];
    const n = this.x.length;
    const last = this.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      const px = this.x[i];
      const pz = this.z[i];
      const dx = this.x[j] - px;
      const dz = this.z[j] - pz;
      // Approaching: moving against the normal, from the side it points to.
      if (dx * nx + dz * nz >= 0) continue;
      const ex = bx - ax;
      const ez = bz - az;
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((ax - px) * ez - (az - pz) * ex) / den;
      const u = ((ax - px) * dz - (az - pz) * dx) / den;
      if (t >= 0 && t < 1 && u >= -0.1 && u <= 1.1) out.push(this.cum[i] + t * (this.cum[i + 1] - this.cum[i]));
    }
    return out;
  }
}

const WHEELS = ['FL', 'FR', 'RL', 'RR'] as const;

export class StreetStage {
  readonly night: NightScene;
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
  /** Where each timed gate crosses the path, approaching it: path distance and its cycle. */
  private readonly gates: { s: number; cycle: number }[] = [];
  private readonly sample: PathSample = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
  private readonly ahead: PathSample = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
  private readonly phase: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };
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
    this.path = new CruisePath(world.route);
    this.s = this.path.wrap(this.path.nearest(...startPoint(world.route)) - CRUISE.startBack);
    this.night.scene.add(this.carLight);
    const set = world.timedGates;
    if (set) set.gates.forEach((g) => this.path.crossings(g.ax, g.az, g.bx, g.bz, g.nx, g.nz).forEach((s) => this.gates.push({ s, cycle: g.cycle })));
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
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.extraPitch = opts.lean?.pitch ?? 0;
    this.extraRoll = opts.lean?.roll ?? 0;
    const target = this.targetSpeed(opts.throttle ?? 0);
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
    this.night.update(this.time);
  }

  /** Render the stage through `camera`. */
  render(gr: GameRenderer, camera: THREE.PerspectiveCamera, dt: number): void {
    gr.post.setSpeedBlur(0);
    gr.render(this.night.scene, camera, dt);
  }

  /**
   * The speed to aim for now: the cruise (or sprint, with throttle), held under
   * what every corner within reach allows given the braking distance to it,
   * and brought to a stop short of any gate that is (or is about to be) down.
   */
  private targetSpeed(throttle: number): number {
    const P = this.path;
    let v = CRUISE.speed + (CRUISE.sprint - CRUISE.speed) * Math.max(0, Math.min(1, throttle));
    for (let d = 0; d <= CRUISE.lookAhead; d += 4) {
      const k = Math.abs(P.sample(this.s + d, this.ahead).k);
      const corner = Math.sqrt(CRUISE.cornerAccel / Math.max(k, 1e-4));
      v = Math.min(v, Math.sqrt(corner * corner + 2 * CRUISE.brake * d));
    }
    const set = this.world.timedGates;
    if (set) {
      const tick = this.time * TICK_HZ;
      for (const g of this.gates) {
        const d = P.closed ? P.wrap(g.s - this.s) : g.s - this.s;
        // Past the stop line already: carry on through.
        if (d < CRUISE.stopShort - 0.5 || d > CRUISE.lookAhead) continue;
        const ph = gatePhase(set.cycles[g.cycle], tick, this.phase);
        // Stop for gates that are not open, or that will start blocking before the car is through.
        const through = (d + 8) / Math.max(4, this.speed);
        if (ph.name === 'open' && ph.untilBlock / TICK_HZ > through + 1.5) continue;
        v = Math.min(v, Math.sqrt(Math.max(0, 2 * CRUISE.brake * 0.8 * (d - CRUISE.stopShort))));
      }
    }
    return v < 0.4 ? 0 : v;
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
