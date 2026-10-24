/**
 * Free-revving engine for the garage (car in neutral, nobody driving) and
 * the body's reaction to it. Pure and DOM free so it can be unit tested.
 *
 *  - rpm chases a throttle dependent target through a second order filter:
 *    quick to rise with a little inertia, slower to fall, settling onto idle
 *    with a small dip and bounce.
 *  - At the redline a rev limiter cuts the throttle briefly, so holding the
 *    pedal gives the familiar bouncing "brap" at the top. With a two-step
 *    set (the Tune tab's Launch RPM) the pedal past halfway meets that cut at
 *    the launch rpm instead, bouncing the revs its depth under it, as the
 *    sim's two-step does at the line.
 *  - The crank's reaction torque rocks the body about its long axis (old
 *    muscle cars on a blip) through a soft, lightly damped spring, plus a
 *    slight squat. Wheels stay planted; the caller only rotates the body.
 */

/** The free rev's feel. */
const REV = {
  /** Longest step taken at once (s) and how fast the pedal travels (1/s). */
  maxDt: 1 / 20,
  pedalRate: 18,
  /** The limiter: how long it cuts (s) and how hard it knocks the revs back (rpm/s). */
  cut: 0.04,
  knock: 2000,
  /** Full throttle aims this far past the redline, so it always meets the limiter. */
  overshoot: 1.12,
  /** The rpm filter's natural frequency (rad/s) and damping, rising and falling. */
  rise: { w: 8, zeta: 0.95 },
  fall: { w: 3.4, zeta: 0.62 },
  /** The fastest the crank spins down and up (rpm/s), and the lowest rpm (share of idle). */
  spinDown: -7000,
  spinUp: 14000,
  floor: 0.6,
  /** The reaction torque: smoothing (1/s), rpm/s² per unit, the pedal's share and the clamp. */
  torqueRate: 30,
  torquePerAccel: 60000,
  torquePedal: 0.35,
  torqueMin: -1,
  torqueMax: 1.2,
  /** Body roll (soft, swaying a few times after a blip) and squat (stiffer): spring Hz, damping ratio, rad per unit torque. */
  roll: { hz: 1.6, damping: 0.16, gain: 0.017 },
  squat: { hz: 2.2, damping: 0.4, gain: 0.005 },
} as const;

export interface RevConfig {
  idle: number;
  redline: number;
  /** Rest rpm when no throttle (idle in the showroom, a cruise rpm on the street). */
  rest?: number;
  /** The two-step, as the build's launch tuning sets it; missing or null, free revs to the redline. */
  launch?: TwoStep | null;
}

/** A two-step launch limiter (the sim's launch tuning): where it holds, how far each cut drops the revs and for how long. */
export interface TwoStep {
  /** Launch rpm the cut holds at (rpm). */
  rpm: number;
  /** How far under it a cut lets the revs fall (rpm). */
  depth: number;
  /** How long each cut lasts (s). */
  cutTime: number;
  /** Pedal past which the two-step is armed (0..1). */
  pedal: number;
}

export class RevModel {
  rpm: number;
  /** rpm per second. */
  rpmVel = 0;
  /** Smoothed pedal 0..1 (what the engine actually gets, after the limiter). */
  throttle = 0;
  /** Body roll (rad, + = rolls toward the car's right) and its rate. */
  roll = 0;
  rollVel = 0;
  /** Body pitch (rad, negative = nose up / squat) and its rate. */
  pitch = 0;
  pitchVel = 0;
  /** True while the limiter is cutting. */
  limiting = false;
  /** True while the cut is the two-step's (at the launch rpm, not the redline). */
  twoStep = false;
  private pedal = 0;
  private cut = 0;
  private accel = 0;
  idle: number;
  redline: number;
  rest: number;
  launch: TwoStep | null;

  constructor(cfg: RevConfig) {
    this.idle = cfg.idle;
    this.redline = cfg.redline;
    this.rest = cfg.rest ?? cfg.idle;
    this.launch = cfg.launch ?? null;
    this.rpm = this.rest;
  }

  configure(cfg: RevConfig): void {
    this.idle = cfg.idle;
    this.redline = cfg.redline;
    this.rest = cfg.rest ?? cfg.idle;
    this.launch = cfg.launch ?? null;
  }

  /** Advance by dt seconds with the pedal at `input` (0..1). */
  step(dt: number, input: number, rockGain = 1): void {
    dt = Math.min(dt, REV.maxDt);
    // Pedal: a fast but not instant travel.
    this.pedal += (Math.max(0, Math.min(1, input)) - this.pedal) * Math.min(1, dt * REV.pedalRate);
    if (this.cut > 0) this.cut -= dt;
    const L = this.launch && this.launch.rpm < this.redline && this.pedal > this.launch.pedal ? this.launch : null;
    if (this.rpm >= (L ? L.rpm : this.redline) && this.cut <= 0) {
      // Limiter: cut fuel for a moment and knock the revs back; the two-step's cut is longer and deeper.
      this.cut = L ? L.cutTime : REV.cut;
      this.rpmVel = Math.min(this.rpmVel, 0) - (L ? L.depth / L.cutTime : REV.knock);
      this.twoStep = L !== null;
    }
    this.limiting = this.cut > 0;
    if (!this.limiting) this.twoStep = false;
    this.throttle = this.limiting ? 0 : this.pedal;
    const top = this.redline * REV.overshoot;
    const target = this.rest + this.throttle * (top - this.rest);
    const { w, zeta } = target > this.rpm ? REV.rise : REV.fall;
    const prevVel = this.rpmVel;
    this.rpmVel += (w * w * (target - this.rpm) - 2 * zeta * w * this.rpmVel) * dt;
    // A real crank cannot spin up or down arbitrarily fast.
    this.rpmVel = Math.max(REV.spinDown, Math.min(REV.spinUp, this.rpmVel));
    this.rpm = Math.max(this.idle * REV.floor, this.rpm + this.rpmVel * dt);
    // Engine angular acceleration, smoothed: the torque the body reacts to.
    const a = (this.rpmVel - prevVel) / Math.max(dt, 1e-4);
    this.accel += (a - this.accel) * Math.min(1, dt * REV.torqueRate);
    const torque = Math.max(REV.torqueMin, Math.min(REV.torqueMax, this.accel / REV.torquePerAccel + this.throttle * REV.torquePedal));

    const R = REV.roll;
    const wr = 2 * Math.PI * R.hz;
    this.rollVel += (-wr * wr * this.roll - 2 * R.damping * wr * this.rollVel + wr * wr * R.gain * rockGain * torque) * dt;
    this.roll += this.rollVel * dt;
    const S = REV.squat;
    const wp = 2 * Math.PI * S.hz;
    this.pitchVel += (-wp * wp * this.pitch - 2 * S.damping * wp * this.pitchVel - wp * wp * S.gain * rockGain * Math.max(0, torque)) * dt;
    this.pitch += this.pitchVel * dt;
  }
}

/** A short scripted throttle pattern (blip-blip) used when a car is selected. */
export class BlipScript {
  private t = Infinity;
  private readonly pattern: [number, number, number][] = [
    // [start s, end s, throttle]
    [0, 0.16, 0.85],
    [0.42, 0.66, 1],
  ];

  start(): void {
    this.t = 0;
  }

  get active(): boolean {
    return this.t < 1.2;
  }

  /** Throttle for this frame. */
  step(dt: number): number {
    if (!this.active) return 0;
    const t = this.t;
    this.t += dt;
    for (const [a, b, v] of this.pattern) if (t >= a && t < b) return v;
    return 0;
  }
}

/**
 * How the garage's engine plays, so it never drones under the menus: the
 * EngineVoice's base level, and per presentation the proximity at the
 * engine's rest rpm (`rest`), at the redline (`top`) and how late the swell
 * comes between them (`curve`; above 1 the first revs add little). The
 * Street view cruises with a little throttle (`floor`) so it sounds driven,
 * but low; a rev swells to full either way. The levels at the output are in
 * docs/audioMix.md and held by e2e/audioMix.spec.ts.
 */
export const REV_LEVEL = {
  base: 0.3,
  garage: { rest: 0.18, top: 1, curve: 1.2, floor: 0 },
  street: { rest: 0.28, top: 0.85, curve: 1.3, floor: 0.22 },
} as const;

/** The garage engine voice's throttle and proximity for the rev model's state; the pedal leads the revs a little. */
export function revVoice(mode: 'garage' | 'street', rpm: number, rest: number, redline: number, pedal: number): { throttle: number; proximity: number } {
  const l = REV_LEVEL[mode];
  const p = Math.max(0, Math.min(1, pedal));
  const revs = Math.max(0, Math.min(1, (rpm - rest) / Math.max(1, redline - rest)));
  const amount = Math.max(revs, 0.5 * p);
  return { throttle: Math.max(l.floor, p), proximity: l.rest + (l.top - l.rest) * amount ** l.curve };
}
