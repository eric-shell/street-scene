/**
 * The menu car's cruise, pure (no scene, no three.js): the smoothed lane line
 * round the event route (CruisePath) and the driving on it (Cruise): the
 * speed to aim for at any point, held under what the corners within reach
 * allow and stopped short of a timed gate that is or is about to be down,
 * and the inputs that drive a sim car the same way. The street stage
 * (streetStage.ts) moves its render-only car with it; after the handoff into
 * free roam the session (session.ts) lets it drive the real car until the
 * player touches a control, so the car rolls on as it did behind the menu.
 */
import type { World } from '../city/world';
import { routeSample, type Route } from '../city/route';
import { gatePhase, type GatePhase } from '../sim/gates';
import { TICK_HZ } from '../sim/constants';
import type { InputFrame } from '../sim/input';

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
  /**
   * Driving the sim car (the handoff into free roam): pure pursuit on a point
   * this many seconds ahead (at least `pursuitMin` m), the throttle that holds
   * the cruise on the flat plus a share of the speed shortfall, the brake per
   * m/s over the target, and the least brake while stopping or stopped.
   */
  pursuitTime: 0.9,
  pursuitMin: 7,
  holdThrottle: 0.16,
  throttleGain: 0.22,
  brakeGain: 0.3,
  holdBrake: 0.25,
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

/** What the cruise needs to know of the car it drives: its wheelbase (m) and the steering lock at its speed (rad). */
export interface CruiseCar {
  wheelbase: number;
  steerLimit: number;
}

/**
 * The cruise's driving: the speed to aim for at a point on the path (held
 * under what the corners within reach allow, stopped short of a gate that is
 * or is about to be down) and, when free roam takes over from the menu, the
 * inputs that keep a sim car on the lane at that speed. Pure: it reads the
 * world and a clock, so the session can run it at the sim's tick.
 */
export class Cruise {
  readonly path: CruisePath;
  /** Where each timed gate crosses the path, approaching it: path distance and its cycle. */
  private readonly gates: { s: number; cycle: number }[] = [];
  private readonly ahead: PathSample = { x: 0, z: 0, tx: 0, tz: 1, yaw: 0, k: 0 };
  private readonly phase: GatePhase = { name: 'open', t: 0, len: 0, arm: 0, blocking: false, untilBlock: 0, untilClear: 0, cycleT: -1 };

  constructor(readonly world: World) {
    this.path = new CruisePath(world.route);
    const set = world.timedGates;
    if (set) set.gates.forEach((g) => this.path.crossings(g.ax, g.az, g.bx, g.bz, g.nx, g.nz).forEach((s) => this.gates.push({ s, cycle: g.cycle })));
  }

  /**
   * The speed to aim for at path distance s, going `speed` m/s at `time` s on
   * the stage clock: the cruise (or the sprint, with `throttle`), held under
   * what every corner within reach allows given the braking distance to it,
   * and brought to a stop short of any gate that is (or is about to be) down.
   */
  targetSpeed(s: number, speed: number, time: number, throttle = 0): number {
    const P = this.path;
    let v = CRUISE.speed + (CRUISE.sprint - CRUISE.speed) * Math.max(0, Math.min(1, throttle));
    for (let d = 0; d <= CRUISE.lookAhead; d += 4) {
      const k = Math.abs(P.sample(s + d, this.ahead).k);
      const corner = Math.sqrt(CRUISE.cornerAccel / Math.max(k, 1e-4));
      v = Math.min(v, Math.sqrt(corner * corner + 2 * CRUISE.brake * d));
    }
    const set = this.world.timedGates;
    if (set) {
      const tick = time * TICK_HZ;
      for (const g of this.gates) {
        const d = P.closed ? P.wrap(g.s - s) : g.s - s;
        // Past the stop line already: carry on through.
        if (d < CRUISE.stopShort - 0.5 || d > CRUISE.lookAhead) continue;
        const ph = gatePhase(set.cycles[g.cycle], tick, this.phase);
        // Stop for gates that are not open, or that will start blocking before the car is through.
        const through = (d + 8) / Math.max(4, speed);
        if (ph.name === 'open' && ph.untilBlock / TICK_HZ > through + 1.5) continue;
        v = Math.min(v, Math.sqrt(Math.max(0, 2 * CRUISE.brake * 0.8 * (d - CRUISE.stopShort))));
      }
    }
    return v < 0.4 ? 0 : v;
  }

  /**
   * Drive a sim car at (x, z, yaw, speed) along the lane: pure pursuit on a
   * point ahead for the steering, throttle and brake toward the target speed
   * (the cruise's, or `target` m/s with the brake held under `maxBrake`: the
   * runout to a stop when nobody takes the wheel). `s` is the car's last path
   * distance; the refined one comes back, so the caller carries it from tick
   * to tick (the path is only sampled every 2 m).
   */
  drive(s: number, x: number, z: number, yaw: number, speed: number, time: number, car: CruiseCar, out: InputFrame, opts: { target?: number; maxBrake?: number } = {}): number {
    const P = this.path;
    // Project the car onto the path near s: along the local tangent, then the point ahead from there.
    const c = P.sample(s, this.ahead);
    s = P.wrap(s + (x - c.x) * c.tx + (z - c.z) * c.tz);
    const a = P.sample(s + Math.max(CRUISE.pursuitMin, speed * CRUISE.pursuitTime), this.ahead);
    const dx = a.x - x;
    const dz = a.z - z;
    const fwd = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const left = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    // The arc through the point ahead: its curvature, the wheel angle that drives it, as a share of the lock
    // (InputFrame.steer is positive to the right; the sim turns left on a positive wheel angle).
    const reach = Math.max(1, Math.hypot(dx, dz));
    const curvature = (2 * Math.sin(Math.atan2(left, Math.max(0.5, fwd)))) / reach;
    const wheel = Math.atan(car.wheelbase * curvature);
    out.steer = Math.max(-1, Math.min(1, -wheel / Math.max(0.02, car.steerLimit)));
    const target = opts.target ?? this.targetSpeed(s, speed, time);
    const dv = target - speed;
    const maxBrake = opts.maxBrake ?? 1;
    // A stop (a gate, the runout) means no throttle and at least a light brake, held on once stopped.
    const stop = target < 0.5;
    out.throttle = !stop && dv > -0.6 ? Math.max(0, Math.min(0.75, CRUISE.holdThrottle + dv * CRUISE.throttleGain)) : 0;
    out.brake = stop ? Math.min(maxBrake, Math.max(CRUISE.holdBrake, -dv * CRUISE.brakeGain)) : dv < -0.6 ? Math.min(maxBrake, -dv * CRUISE.brakeGain) : 0;
    out.handbrake = false;
    out.nitrous = false;
    out.shift = 0;
    out.reset = false;
    return s;
  }
}
