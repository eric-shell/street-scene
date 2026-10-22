/**
 * The drive's live voices, one set per car: the nitrous jet, the wall and rail
 * scrape, and the player's horn, each a small Web Audio graph Sfx (sfx.ts)
 * steers every frame. Also the levels every effect of the drive is mixed at.
 */
import type { SfxPos } from './sfx';

/**
 * Levels of the drive's effects, set against the player's engine at full
 * throttle (about -17 dBFS RMS at the defaults; docs/audioMix.md has the
 * measurements): a hard crash peaks 10 dB over the engine's RMS, nitrous sits
 * just under the engine, the horn and the countdown beeps cut through it, a
 * firework pops like a distant crash. A centred mono source loses 3 dB in its
 * panner, which these allow for.
 */
export const IMPACT_LEVEL = 2;
export const NITRO_LEVEL = 1.2;
export const HORN_LEVEL = 0.6;
export const BEEP_LEVEL = 0.45;
export const FIREWORK_LEVEL = 1.1;

/** Nitrous: a jet like whoosh that climbs in pitch while held. */
export class NitroVoice {
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly hp: BiquadFilterNode;
  private readonly bp: BiquadFilterNode;
  private readonly whine: OscillatorNode;
  private readonly whineBp: BiquadFilterNode;
  private readonly gWhine: GainNode;
  private readonly src: AudioBufferSourceNode;
  private p = 0;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
    noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.out.connect(this.panner).connect(bus);
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    // Rushing air: a high pass and a broad band pass that both sweep up.
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.Q.value = 0.9;
    const gAir = ctx.createGain();
    gAir.gain.value = 0.9;
    this.src.connect(this.hp).connect(this.bp).connect(gAir).connect(this.out);
    // Low jet roar underneath.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const gRoar = ctx.createGain();
    gRoar.gain.value = 0.7;
    this.src.connect(lp).connect(gRoar).connect(this.out);
    // Turbine whine: a resonant sawtooth.
    this.whine = ctx.createOscillator();
    this.whine.type = 'sawtooth';
    this.whineBp = ctx.createBiquadFilter();
    this.whineBp.type = 'bandpass';
    this.whineBp.Q.value = 9;
    this.gWhine = ctx.createGain();
    this.gWhine.gain.value = 0.05;
    this.whine.connect(this.whineBp).connect(this.gWhine).connect(this.out);
    this.src.start();
    this.whine.start();
  }

  update(active: boolean, pos: SfxPos, base: number, dt: number): void {
    const t = this.ctx.currentTime;
    // Sweep: climbs over ~1.5 s while held, sinks quickly on release.
    if (active) this.p += (1 - this.p) * (1 - Math.exp(-dt / 1.3));
    else this.p *= Math.exp(-dt / 0.45);
    const p = this.p;
    this.hp.frequency.setTargetAtTime(300 + p * 2100, t, 0.05);
    this.bp.frequency.setTargetAtTime(900 + p * 4200, t, 0.05);
    this.whine.frequency.setTargetAtTime(650 + p * 2700, t, 0.05);
    this.whineBp.frequency.setTargetAtTime(650 + p * 2700, t, 0.05);
    this.gWhine.gain.setTargetAtTime(0.03 + 0.05 * p, t, 0.05);
    const level = active ? base * pos.proximity * (0.6 + 0.4 * p) : 0;
    this.out.gain.setTargetAtTime(level, t, active ? 0.06 : 0.22);
    this.panner.pan.setTargetAtTime(pos.pan, t, 0.05);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    this.src.stop(t + 0.2);
    this.whine.stop(t + 0.2);
    setTimeout(() => this.panner.disconnect(), 400);
  }
}

/** Continuous grind while a car slides along a wall (concrete grit) or rail (metal screech). */
export class ScrapeLoop {
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly metalA: BiquadFilterNode;
  private readonly metalB: BiquadFilterNode;
  private readonly grit: BiquadFilterNode;
  private readonly gMetal: GainNode;
  private readonly gGrit: GainNode;
  private readonly src: AudioBufferSourceNode;
  private level = 0;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
    noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.out.connect(this.panner).connect(bus);
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.src.playbackRate.value = 0.8;
    const bp = (q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      return f;
    };
    this.metalA = bp(6);
    this.metalB = bp(9);
    this.grit = bp(0.9);
    this.gMetal = ctx.createGain();
    this.gGrit = ctx.createGain();
    this.src.connect(this.metalA).connect(this.gMetal);
    this.src.connect(this.metalB).connect(this.gMetal);
    this.src.connect(this.grit).connect(this.gGrit);
    this.gMetal.connect(this.out);
    this.gGrit.connect(this.out);
    this.src.start();
  }

  /** target 0..1 from sliding speed; metal 0..1 (rail = 1, wall = 0). */
  update(target: number, metal: number, speed: number, pos: SfxPos, dt: number): void {
    const t = this.ctx.currentTime;
    this.level += (target - this.level) * (1 - Math.exp(-dt / (target > this.level ? 0.03 : 0.12)));
    const f = 1600 + speed * 45 + Math.random() * 260;
    this.metalA.frequency.setTargetAtTime(f, t, 0.02);
    this.metalB.frequency.setTargetAtTime(f * 1.53, t, 0.02);
    this.grit.frequency.setTargetAtTime(500 + speed * 18, t, 0.02);
    // Jitter gives the stick slip texture of a real grind.
    const j = 0.65 + 0.35 * Math.random();
    this.gMetal.gain.setTargetAtTime((0.15 + 1.1 * metal) * j, t, 0.015);
    this.gGrit.gain.setTargetAtTime((1.2 - 0.8 * metal) * (0.75 + 0.25 * Math.random()), t, 0.015);
    this.out.gain.setTargetAtTime(this.level * pos.proximity * 0.5, t, 0.03);
    this.panner.pan.setTargetAtTime(pos.pan, t, 0.05);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    this.src.stop(t + 0.2);
    setTimeout(() => this.panner.disconnect(), 400);
  }
}

/** Dual tone car horn (two detuned buzzy tones a third apart). Short honk on a tap. */
export class HornVoice {
  private readonly out: GainNode;
  private readonly oscs: OscillatorNode[];
  private on = false;
  private downAt = 0;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 511) * 2 - 1) * 3);
    shaper.curve = curve;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3600;
    shaper.connect(bp).connect(lp).connect(this.out).connect(bus);
    this.oscs = [420, 500].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g).connect(shaper);
      o.start();
      return o;
    });
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    const t = this.ctx.currentTime;
    const g = this.out.gain;
    if (on) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(HORN_LEVEL, t, 0.008);
      this.downAt = t;
    } else {
      // A tap still gives a proper honk.
      g.setTargetAtTime(0, Math.max(t, this.downAt + 0.17), 0.025);
    }
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.02);
    for (const o of this.oscs) o.stop(t + 0.2);
    setTimeout(() => this.out.disconnect(), 400);
  }
}
