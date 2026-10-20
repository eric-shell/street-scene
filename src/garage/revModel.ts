/**
 * Free-revving engine for the garage (car in neutral, nobody driving) and
 * the body's reaction to it. Pure and DOM free so it can be unit tested.
 *
 *  - rpm chases a throttle dependent target through a second order filter:
 *    quick to rise with a little inertia, slower to fall, settling onto idle
 *    with a small dip and bounce.
 *  - At the redline a rev limiter cuts the throttle briefly, so holding the
 *    pedal gives the familiar bouncing "brap" at the top.
 *  - The crank's reaction torque rocks the body about its long axis (old
 *    muscle cars on a blip) through a soft, lightly damped spring, plus a
 *    slight squat. Wheels stay planted; the caller only rotates the body.
 */

export interface RevConfig {
  idle: number;
  redline: number;
  /** Rest rpm when no throttle (idle in the showroom, a cruise rpm on the street). */
  rest?: number;
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
  private pedal = 0;
  private cut = 0;
  private accel = 0;
  idle: number;
  redline: number;
  rest: number;

  constructor(cfg: RevConfig) {
    this.idle = cfg.idle;
    this.redline = cfg.redline;
    this.rest = cfg.rest ?? cfg.idle;
    this.rpm = this.rest;
  }

  configure(cfg: RevConfig): void {
    this.idle = cfg.idle;
    this.redline = cfg.redline;
    this.rest = cfg.rest ?? cfg.idle;
  }

  /** Advance by dt seconds with the pedal at `input` (0..1). */
  step(dt: number, input: number, rockGain = 1): void {
    dt = Math.min(dt, 1 / 20);
    // Pedal: a fast but not instant travel.
    this.pedal += (Math.max(0, Math.min(1, input)) - this.pedal) * Math.min(1, dt * 18);
    if (this.cut > 0) this.cut -= dt;
    if (this.rpm >= this.redline && this.cut <= 0) {
      // Limiter: cut fuel for a moment and knock the revs back.
      this.cut = 0.04;
      this.rpmVel = Math.min(this.rpmVel, 0) - 2000;
    }
    this.limiting = this.cut > 0;
    this.throttle = this.limiting ? 0 : this.pedal;
    // Aim a little past the redline so full throttle always meets the limiter.
    const top = this.redline * 1.12;
    const target = this.rest + this.throttle * (top - this.rest);
    const rising = target > this.rpm;
    const w = rising ? 8 : 3.4;
    const zeta = rising ? 0.95 : 0.62;
    const prevVel = this.rpmVel;
    this.rpmVel += (w * w * (target - this.rpm) - 2 * zeta * w * this.rpmVel) * dt;
    // A real crank cannot spin up or down arbitrarily fast.
    this.rpmVel = Math.max(-7000, Math.min(14000, this.rpmVel));
    this.rpm = Math.max(this.idle * 0.6, this.rpm + this.rpmVel * dt);
    // Engine angular acceleration, smoothed: the torque the body reacts to.
    const a = (this.rpmVel - prevVel) / Math.max(dt, 1e-4);
    this.accel += (a - this.accel) * Math.min(1, dt * 30);
    const torque = Math.max(-1, Math.min(1.2, this.accel / 60000 + this.throttle * 0.35));

    // Roll: ~1.6 Hz, lightly damped so it sways a few times after a blip.
    const wr = 2 * Math.PI * 1.6;
    this.rollVel += (-wr * wr * this.roll - 2 * 0.16 * wr * this.rollVel + wr * wr * 0.017 * rockGain * torque) * dt;
    this.roll += this.rollVel * dt;
    // Squat: stiffer and better damped.
    const wp = 2 * Math.PI * 2.2;
    this.pitchVel += (-wp * wp * this.pitch - 2 * 0.4 * wp * this.pitchVel - wp * wp * 0.005 * rockGain * Math.max(0, torque)) * dt;
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
