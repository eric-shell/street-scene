/**
 * Synthesized engine sound with Web Audio. Each car gets a voice whose pitch
 * follows the firing frequency (rpm / 60 * firings per revolution, from the
 * car's EngineSpec) and whose tone opens up with throttle. The spec picks the
 * voice:
 *  - under six cylinders (s64, Proto Compact: I4): raspy, with a second order
 *    bite; a turbocharged spec adds a spool whistle and a blow-off valve chuff
 *    when you lift at boost
 *  - six and up (gc14, Proto Hatch: V6): deeper, smoother, half-order growl
 * Most of an engine's energy sits below 300 Hz, which laptop and phone
 * speakers barely reproduce, so a presence peak that tracks the firing
 * frequency lifts the harmonics in the 0.5 to 2.5 kHz range where small
 * speakers work, and the voice runs hot enough to sit above the music.
 * Render side only; reads interpolated car state.
 */
import type { EngineSpec } from '../shared/carSpec';
import { cylinderCount, firingsPerRev } from '../shared/carSpec';

export interface EngineInput {
  rpm: number;
  redline: number;
  throttle: number;
  nitro: boolean;
  /** 0..1 loudness from distance (1 = the player's own car). */
  proximity: number;
  /** -1..1 stereo position. */
  pan: number;
}

class AudioHub {
  readonly ctx: AudioContext;
  readonly engineBus: GainNode;
  /** Sound effects (crashes, nitro, horn, beeps): same volume setting, same compressor. */
  readonly sfxBus: GainNode;
  readonly noise: AudioBuffer;
  private volume = 0.7;

  constructor() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.engineBus = this.ctx.createGain();
    // Gentle bus compression keeps four engines from clipping.
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.engineBus.connect(comp).connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(comp);
    this.setVolume(this.volume);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const resume = () => {
      if (this.ctx.state !== 'running') void this.ctx.resume();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, resume, true);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.engineBus.gain.setTargetAtTime(this.volume * this.volume * 0.9, this.ctx.currentTime, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volume * this.volume * 0.9, this.ctx.currentTime, 0.05);
  }
}

let hub: AudioHub | null = null;

export function audioHub(): AudioHub | null {
  if (typeof window === 'undefined') return null;
  try {
    hub ??= new AudioHub();
    return hub;
  } catch {
    return null;
  }
}

function softClip(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

/**
 * Voice tone and level. PRESENCE: peak at the firing frequency times `harmonic`,
 * clamped to [min, max] Hz, `gain` dB. GAIN scales every voice (the bus
 * compressor keeps a full grid in check). LOWPASS: filter opening (Hz) at
 * idle, plus per unit of rpm fraction and of throttle.
 */
const VOICE = {
  presence: { harmonic: 6, min: 550, max: 2400, q: 0.8, gain: 9 },
  gain: 1.9,
  lowpass: { six: [480, 2400, 1700], four: [650, 3400, 2300] },
} as const;

export class EngineVoice {
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private filter: BiquadFilterNode;
  private presence: BiquadFilterNode;
  private oscMain: OscillatorNode;
  private oscOrder: OscillatorNode;
  private oscSub: OscillatorNode;
  private gMain: GainNode;
  private gOrder: GainNode;
  private gSub: GainNode;
  private noiseSrc: AudioBufferSourceNode;
  private noiseBand: BiquadFilterNode;
  private gNoise: GainNode;
  private turbo: OscillatorNode | null = null;
  private gTurbo: GainNode | null = null;
  private bov: GainNode | null = null;
  private boost = 0;
  private lastThrottle = 0;
  private stopped = false;
  /** Combustion events per revolution: the fundamental is rpm / 60 times this. */
  private readonly firings: number;
  /** Six or more cylinders get the deeper, smoother voice. */
  private readonly six: boolean;

  constructor(
    spec: EngineSpec,
    private readonly base = 0.24,
  ) {
    const h = audioHub()!;
    const ctx = (this.ctx = h.ctx);
    this.firings = firingsPerRev(spec);
    const six = (this.six = cylinderCount(spec) >= 6);
    const turbo = spec.aspiration === 'turbo';
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.engineBus);

    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(six ? 1.6 : 2.4);
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = six ? 2.2 : 1.2;
    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.Q.value = VOICE.presence.q;
    this.presence.gain.value = VOICE.presence.gain;
    shaper.connect(this.filter).connect(this.presence).connect(this.out);

    const osc = (wave: OscillatorType, gain: number): [OscillatorNode, GainNode] => {
      const o = ctx.createOscillator();
      o.type = wave;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(shaper);
      o.start();
      return [o, g];
    };
    // Fundamental firing order, a second order component, and a sub rumble.
    [this.oscMain, this.gMain] = osc('sawtooth', six ? 0.5 : 0.55);
    [this.oscOrder, this.gOrder] = osc(six ? 'sawtooth' : 'square', six ? 0.38 : 0.16);
    [this.oscSub, this.gSub] = osc('sine', six ? 0.55 : 0.3);
    this.oscOrder.detune.value = six ? -6 : 4;

    // Exhaust / intake rasp from filtered noise.
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = h.noise;
    this.noiseSrc.loop = true;
    this.noiseBand = ctx.createBiquadFilter();
    this.noiseBand.type = 'bandpass';
    this.noiseBand.Q.value = 1.4;
    this.gNoise = ctx.createGain();
    this.gNoise.gain.value = 0;
    this.noiseSrc.connect(this.noiseBand).connect(this.gNoise).connect(shaper);
    this.noiseSrc.start();

    if (turbo) {
      // Turbo spool whistle, straight to the output (not through the low pass).
      this.turbo = ctx.createOscillator();
      this.turbo.type = 'sine';
      this.gTurbo = ctx.createGain();
      this.gTurbo.gain.value = 0;
      this.turbo.connect(this.gTurbo).connect(this.out);
      this.turbo.start();
      // Blow-off valve: a burst of high passed noise when lifting at boost.
      const bovSrc = ctx.createBufferSource();
      bovSrc.buffer = h.noise;
      bovSrc.loop = true;
      bovSrc.playbackRate.value = 1.3;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      this.bov = ctx.createGain();
      this.bov.gain.value = 0;
      bovSrc.connect(hp).connect(this.bov).connect(this.out);
      bovSrc.start();
    }
  }

  update(e: EngineInput): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    const tc = 0.035;
    const rpm = Math.max(600, e.rpm);
    const f = (rpm / 60) * this.firings;
    const load = Math.max(0, Math.min(1, e.throttle));
    const r = Math.min(1.05, rpm / e.redline);
    this.oscMain.frequency.setTargetAtTime(f, t, tc);
    this.oscOrder.frequency.setTargetAtTime(this.six ? f * 0.5 : f * 2, t, tc);
    this.oscSub.frequency.setTargetAtTime(f * 0.5, t, tc);
    this.noiseBand.frequency.setTargetAtTime(f * (this.six ? 2.5 : 3.5), t, tc);
    const lp = this.six ? VOICE.lowpass.six : VOICE.lowpass.four;
    const open = lp[0] + r * lp[1] + load * lp[2];
    this.filter.frequency.setTargetAtTime(open * (e.nitro ? 1.3 : 1), t, tc);
    const pr = VOICE.presence;
    this.presence.frequency.setTargetAtTime(Math.max(pr.min, Math.min(pr.max, f * pr.harmonic)), t, tc);
    this.gNoise.gain.setTargetAtTime((this.six ? 0.1 : 0.16) * (0.3 + load) * (0.4 + r), t, tc);
    this.gMain.gain.setTargetAtTime((this.six ? 0.5 : 0.55) * (0.6 + 0.4 * load), t, tc);
    // Low rpm rumble fades as revs climb; the second order bites under load.
    this.gSub.gain.setTargetAtTime((this.six ? 0.55 : 0.3) * (1.1 - 0.6 * r), t, tc);
    this.gOrder.gain.setTargetAtTime((this.six ? 0.38 : 0.16) * (0.5 + 0.7 * load), t, tc);
    const level = this.base * VOICE.gain * e.proximity * (0.45 + 0.55 * load) * (0.7 + 0.3 * r);
    this.out.gain.setTargetAtTime(level, t, 0.05);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, e.pan)), t, 0.05);

    if (this.turbo && this.gTurbo && this.bov) {
      // Boost builds with load and rpm and spools up with lag.
      const target = load * Math.max(0, (r - 0.25) / 0.75);
      this.boost += (target - this.boost) * (target > this.boost ? 0.04 : 0.12);
      this.turbo.frequency.setTargetAtTime(1600 + this.boost * 5200, t, 0.08);
      this.gTurbo.gain.setTargetAtTime(this.boost * 0.05 * e.proximity, t, 0.08);
      if (this.lastThrottle > 0.6 && load < 0.25 && this.boost > 0.35) {
        const g = this.bov.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(0.22 * this.boost * e.proximity, t);
        g.exponentialRampToValueAtTime(0.0001, t + 0.38);
        this.boost *= 0.3;
      }
    }
    this.lastThrottle = load;
  }

  silence(): void {
    if (!this.stopped) this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    const nodes: AudioScheduledSourceNode[] = [this.oscMain, this.oscOrder, this.oscSub, this.noiseSrc];
    if (this.turbo) nodes.push(this.turbo);
    for (const n of nodes) n.stop(t + 0.2);
    setTimeout(() => this.pan.disconnect(), 400);
  }
}

/**
 * A free revving engine for the garage and menus: no car, no gearbox, just a
 * flywheel that chases the throttle, falls back to idle and bounces off the
 * rev limiter. Owns its EngineVoice (null when Web Audio is unavailable).
 *
 *   const eng = new FreeRevEngine(manifestCar('s64').engine, { idle: 900, redline: 7600 });
 *   // every frame: eng.update(throttle01, dt);   eng.rpm for a tach
 *   eng.dispose();
 */
export class FreeRevEngine {
  rpm: number;
  readonly voice: EngineVoice | null;
  private cut = 0;
  private readonly idle: number;
  private readonly redline: number;

  constructor(spec: EngineSpec, opts: { idle?: number; redline?: number; volume?: number } = {}) {
    this.idle = opts.idle ?? 900;
    this.redline = opts.redline ?? 7200;
    this.rpm = this.idle;
    this.voice = audioHub() ? new EngineVoice(spec, opts.volume ?? 0.24) : null;
  }

  /** Advance by dt seconds with throttle 0..1, then drive the voice. Returns rpm. */
  update(throttle: number, dt: number, proximity = 1, pan = 0): number {
    let load = Math.max(0, Math.min(1, throttle));
    if (this.cut > 0) {
      // Rev limiter: fuel cut for a moment, revs drop, then fire again.
      this.cut -= dt;
      load = 0;
    }
    const target = this.idle + (this.redline * 1.03 - this.idle) * load;
    // Unloaded engines spin up fast and fall back a little slower.
    const rate = target > this.rpm ? 3.5 + 5 * load : 2.2;
    this.rpm += (target - this.rpm) * (1 - Math.exp(-rate * dt));
    if (this.rpm >= this.redline) {
      this.rpm = this.redline - 350;
      this.cut = 0.07;
    }
    this.voice?.update({ rpm: this.rpm, redline: this.redline, throttle: load, nitro: false, proximity, pan });
    return this.rpm;
  }

  silence(): void {
    this.voice?.silence();
  }

  dispose(): void {
    this.voice?.dispose();
  }
}
