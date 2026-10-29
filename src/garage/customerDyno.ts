/**
 * The customer's car on the workshop dyno, as a prop that really pulls. The shop's schedule
 * (garage/shopSchedule.ts) only says when the operator's foot goes down; this turns that pedal into revs with
 * the same pieces the player's Dyno presentation uses: the car's stock tuning (`tuningForBuild`), a `RevModel`
 * loaded the way the rollers load it (`pullLoad`), a `DynoSession` keeping the pull's curves, ghost and peak
 * call-out for the wall screen, and the driven wheels and the drums under them turned from the revs by the
 * scene's own formula. So the screen, the wheels, the drums, the fan and the sound bed all follow one engine
 * and never disagree. Pure bookkeeping (no three.js, no DOM): the sim never sees it, and the session's
 * `Math.random` is garage display only. Costs one rev model step and one session update a frame.
 */
import { clamp01, smoothstep, TAU } from '../sim/math';
import { stockPerformance, tuningForBuild } from '../sim/build';
import { DynoSession } from './dynoSession';
import { PULL, dynoSetup, pullLoad } from './dynoRun';
import type { DynoSetup } from './dynoRun';
import { RevModel } from './revModel';
import { DYNO_DRUM } from './props/atmosphere';
import type { DynoDrive } from './props/atmosphere';
import type { DynoRun } from './textures/effects';

/** Revs this far above idle (rpm) count as the engine being worked: the car view keeps updating until they settle. */
const BUSY_RPM = 40;

export class CustomerDyno {
  /** The wall screen's run: updated in place by the session, never replaced. */
  readonly run: DynoRun;
  /** The revs' place on the idle-to-redline axis, 0..1 (what the sound bed, the fan and the screen follow). */
  x = 0;
  /** The driven wheels' turn (rad, wrapped to one turn) and the drums' (rad, about their axis, the other way and slower by the radii's ratio). */
  spin = 0;
  drumAngle = 0;
  /** The wheel's angular speed now (rad/s). */
  omega = 0;
  /** The body's rock from the rev model: pitch (rad, negative = nose up) and roll (rad, + = toward the car's right). */
  pitch = 0;
  roll = 0;
  /** The axles on the rollers. */
  readonly driven: DynoDrive;
  private readonly setup: DynoSetup;
  private readonly rev: RevModel;
  private readonly session = new DynoSession();
  private readonly idle: number;
  private readonly redline: number;

  constructor(carId: string, name: string) {
    const t = tuningForBuild(carId, stockPerformance(carId));
    this.setup = dynoSetup(t);
    this.driven = this.setup.driven;
    this.idle = t.engine.idleRpm;
    this.redline = t.engine.redline;
    this.rev = new RevModel({ idle: this.idle, redline: this.redline, rest: this.idle, load: pullLoad(this.idle, this.redline) });
    this.session.setCar(carId, name);
    this.session.setBuild(this.setup);
    this.session.setRevs(this.idle, this.redline);
    this.run = this.session.run;
  }

  /** Advance by dt seconds with the operator's pedal at `pedal` (0 or 1). */
  update(dt: number, pedal: number): void {
    const rev = this.rev;
    rev.step(dt, pedal, PULL.strapRock);
    this.x = clamp01((rev.rpm - this.idle) / Math.max(1, this.redline - this.idle));
    this.session.update(dt, this.x, pedal, rev.rpm);
    // In gear the wheels turn at the engine's speed over the pull gear's ratio, rolling from just off idle; the drum shares their surface speed.
    const omega = ((rev.rpm * TAU) / 60 / this.setup.overall) * smoothstep(0, PULL.wheelsEngage, this.x);
    this.omega = omega;
    this.spin = (this.spin + omega * dt) % TAU;
    this.drumAngle = (this.drumAngle - (omega * dt * this.setup.wheelRadius) / DYNO_DRUM.radius) % TAU;
    this.pitch = rev.pitch;
    this.roll = rev.roll;
  }

  /** True while the revs are off idle or the wheels turn: the car view needs posing. */
  get busy(): boolean {
    return this.rev.rpm - this.idle > BUSY_RPM || this.omega > 1e-3;
  }
}
