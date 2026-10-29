/**
 * What the dyno remembers between pulls, for the wall screen and the toast:
 * each pull's measured curves (the build's torque curve times a smooth gain of
 * about +-1 %, a little per-rpm noise, and the heat soak), the pull before it
 * ghosted behind, the running peak, the run counter, and the engine's heat.
 *
 * Heat is the garage's own story and never touches the sim: every pull adds to
 * an intake and engine heat value (a share of what is left, so quick runs
 * saturate) and it bleeds off on a time constant, so one cold pull reads true
 * and a string of them back to back reads a few percent down (HEAT.loss at full
 * soak) until the car has idled it off in about a minute. Randomness is the
 * garage's `Math.random`; the sim never sees any of this. Pure bookkeeping
 * (no DOM, no three.js), driven once a frame by the scene.
 */
import { PULL } from './dynoRun';
import type { DynoSetup } from './dynoRun';
import type { DynoRun } from './textures/effects';

/** How a pull's figures vary and how the engine heats and cools (presentation, not physics). */
export const DYNO_SESSION = {
  /** Samples a pull's curves are measured at over the rpm axis. */
  samples: 64,
  /** Each pull's curve-wide factor is 1 plus a triangular draw within this share (0.01 = +-1 %). */
  gain: 0.01,
  /** Per-rpm noise on top, smoothed over neighbours (share of the reading, +-). */
  noise: 0.0025,
} as const;

/** Heat soak: 0 (cold) to 1 (soaked). */
export const HEAT = {
  /** Power and torque lost at full soak (0.05 = 5 %), taken from the heat the pull starts at. */
  loss: 0.05,
  /** A full pull closes this share of the gap to full soak. */
  rise: 0.6,
  /** The heat falls off on this time constant (s): about 95 % gone in 70 s. */
  coolSeconds: 24,
  /** The intake temperature (deg F) cold and its rise at full soak. */
  ambientF: 78,
  riseF: 68,
} as const;

/** A pair of sampled curves (shares of the rated peaks). */
interface Curves {
  p: Float32Array;
  t: Float32Array;
}

export class DynoSession {
  /** What the wall screen draws; updated in place, never replaced. */
  readonly run: DynoRun;
  /** Heat soak now, 0..1. */
  heat = 0;
  private setup: DynoSetup | null = null;
  private carId = '';
  private name = '';
  private cur: Curves;
  private prev: Curves;
  private hasPrev = false;
  /** The furthest the revs have climbed this pull (0..1), and whether it reached the redline. */
  private max = 0;
  private done = false;
  /** The samples up to which the running peak has been taken, and the best shares so far. */
  private scanned = 0;
  private bestP = 0;
  private bestT = 0;
  private readonly raw: Float32Array;
  /** The ghost curves' readers (made once; they follow whichever buffer is the previous pull's). */
  private readonly ghostP: (x: number) => number;
  private readonly ghostT: (x: number) => number;

  constructor(private readonly rand: () => number = Math.random) {
    const n = DYNO_SESSION.samples + 1;
    this.cur = { p: new Float32Array(n), t: new Float32Array(n) };
    this.prev = { p: new Float32Array(n), t: new Float32Array(n) };
    this.raw = new Float32Array(n);
    const read = (buf: Float32Array, x: number): number => {
      const f = Math.max(0, Math.min(1, x)) * DYNO_SESSION.samples;
      const i = Math.min(DYNO_SESSION.samples - 1, Math.floor(f));
      return buf[i] + (buf[i + 1] - buf[i]) * (f - i);
    };
    this.ghostP = (x) => read(this.prev.p, x);
    this.ghostT = (x) => read(this.prev.t, x);
    this.run = {
      state: 'ready',
      progress: 0,
      power: (x) => read(this.cur.p, x),
      torque: (x) => read(this.cur.t, x),
      ghostPower: null,
      ghostTorque: null,
      ghostProgress: 0,
      rated: { hp: 0, lbft: 0, hpRpm: 0, lbftRpm: 0 },
      peaks: { hp: 0, lbft: 0, hpRpm: 0, lbftRpm: 0 },
      rpm: 0,
      rpmIdle: 900,
      rpmRedline: 7200,
      runNo: 1,
      doneFor: 0,
      heat: 0,
      iatF: HEAT.ambientF,
    };
  }

  /** A different car on the dyno: it starts cold on its first run with no ghost. */
  setCar(id: string, name: string): void {
    if (id !== this.carId) {
      this.carId = id;
      this.heat = 0;
      this.hasPrev = false;
      this.run.ghostPower = this.run.ghostTorque = null;
      this.run.runNo = 1;
      this.restart(false);
    }
    this.name = name.toUpperCase();
    this.retitle();
  }

  /** The build's curves and rated peaks; a build that makes different power starts its pull over (and drops the old ghost). */
  setBuild(setup: DynoSetup): void {
    const old = this.setup?.peaks;
    const p = setup.peaks;
    this.setup = setup;
    Object.assign(this.run.rated, p);
    if (!old || old.hp !== p.hp || old.lbft !== p.lbft || old.hpRpm !== p.hpRpm || old.lbftRpm !== p.lbftRpm) {
      this.hasPrev = false;
      this.run.ghostPower = this.run.ghostTorque = null;
      this.restart(false);
    }
  }

  /** The rpm range of the x axis (idle to redline, rpm). */
  setRevs(idle: number, redline: number): void {
    this.run.rpmIdle = idle;
    this.run.rpmRedline = redline;
  }

  private retitle(): void {
    this.run.title = `${this.name}  ·  RUN ${this.run.runNo}`;
  }

  /**
   * Begin a pull: with `count` (the last one got somewhere) it becomes the ghost and the run counter ticks.
   * Each pull draws its own curves from the build's, with the heat it starts at.
   */
  restart(count: boolean): void {
    const r = this.run;
    if (count) {
      const old = this.cur;
      this.cur = this.prev;
      this.prev = old;
      this.hasPrev = true;
      r.ghostProgress = this.max;
      r.runNo++;
    }
    this.roll();
    r.ghostPower = this.hasPrev ? this.ghostP : null;
    r.ghostTorque = this.hasPrev ? this.ghostT : null;
    this.max = 0;
    this.done = false;
    this.scanned = 0;
    this.bestP = this.bestT = 0;
    Object.assign(r.peaks, { hp: 0, lbft: 0, hpRpm: 0, lbftRpm: 0 });
    r.progress = 0;
    r.doneFor = 0;
    r.state = 'ready';
    this.retitle();
  }

  /** Measure this pull's curves: the build's, times the pull's gain, its heat soak and the per-rpm noise. */
  private roll(): void {
    const s = this.setup;
    if (!s) return;
    const n = DYNO_SESSION.samples;
    const gain = 1 + (this.rand() + this.rand() - 1) * DYNO_SESSION.gain;
    const k = gain * (1 - HEAT.loss * this.heat);
    for (let i = 0; i <= n; i++) this.raw[i] = this.rand() * 2 - 1;
    for (let i = 0; i <= n; i++) {
      const noise = ((this.raw[Math.max(0, i - 1)] + 2 * this.raw[i] + this.raw[Math.min(n, i + 1)]) / 4) * DYNO_SESSION.noise;
      const f = k * (1 + noise);
      this.cur.p[i] = s.power(i / n) * f;
      this.cur.t[i] = s.torque(i / n) * f;
    }
  }

  /** Let the engine cool for dt seconds (also called while the dyno is not on screen). */
  cool(dt: number): void {
    if (this.heat <= 0) return;
    this.heat *= Math.exp(-dt / HEAT.coolSeconds);
    if (this.heat < 1e-4) this.heat = 0;
  }

  /**
   * Follow the pull: `x` is the revs' place on the axis now (0..1) and `pedal` the gas. The furthest the revs have
   * climbed is how much of the curves is drawn and how much heat the pull has added; the pedal going down near idle
   * starts the next pull, and reaching the redline ends it. True on the frame a pull finishes.
   */
  update(dt: number, x: number, pedal: number, rpm: number): boolean {
    const r = this.run;
    this.cool(dt);
    if (pedal > 0.5 && x < PULL.restartBelow && this.max > x + 0.05) this.restart(this.max > 0.15);
    let finished = false;
    if (!this.done) {
      const m = Math.max(this.max, x);
      this.heat += (1 - this.heat) * HEAT.rise * (m - this.max);
      this.max = m;
      if (x >= PULL.doneAt) {
        this.max = 1;
        this.done = true;
        finished = true;
      }
      this.scan();
    } else r.doneFor += dt;
    r.progress = this.max;
    r.rpm = rpm;
    r.state = this.done ? 'done' : this.max > 0.02 ? 'pull' : 'ready';
    r.heat = this.heat;
    r.iatF = HEAT.ambientF + HEAT.riseF * this.heat;
    return finished;
  }

  /** Take the running peak over the samples the pull has newly passed. */
  private scan(): void {
    const n = DYNO_SESSION.samples;
    const r = this.run;
    const upTo = Math.min(n, Math.floor(this.max * n + 1e-6));
    for (; this.scanned <= upTo; this.scanned++) {
      const i = this.scanned;
      const rpm = r.rpmIdle + ((r.rpmRedline - r.rpmIdle) * i) / n;
      if (this.cur.p[i] > this.bestP) {
        this.bestP = this.cur.p[i];
        r.peaks.hp = this.bestP * r.rated.hp;
        r.peaks.hpRpm = rpm;
      }
      if (this.cur.t[i] > this.bestT) {
        this.bestT = this.cur.t[i];
        r.peaks.lbft = this.bestT * r.rated.lbft;
        r.peaks.lbftRpm = rpm;
      }
    }
  }
}
