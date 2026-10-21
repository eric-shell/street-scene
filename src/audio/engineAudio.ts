/**
 * Engine sound with Web Audio. Each car gets an EngineVoice: an AudioWorklet
 * running the pulse-train synth of engineSynth.ts (the car's firing order,
 * its exhaust path delays, engine-sim's jitter / derivative / turbulence
 * chain) whose exhaust output is convolved with a synthesized silencer
 * impulse response; beside it the intake through its trumpet resonance, the
 * valvetrain tick, and for turbo cars a spool whistle and a blow-off chuff
 * when you lift at boost. What the voice is told comes from the car's
 * EngineSpec (layout, aspiration and the optional `voice` block), so the
 * Proto Hatch burbles like a boxer on unequal headers, the Compact honks
 * through its throttle bodies and the Coupe whooshes through its turbo.
 *
 * Most of an engine's energy sits below 300 Hz, which laptop and phone
 * speakers barely reproduce, so a presence peak that tracks the firing
 * frequency lifts the harmonics in the 0.5 to 2.5 kHz range where small
 * speakers work, and the voice runs hot enough to sit above the music.
 * The worklet module loads once per AudioContext; until it is in, or when
 * the browser has no AudioWorklet, voices stay silent rather than fall back.
 * Render side only; reads interpolated car state.
 */
import type { EngineSpec } from '../shared/carSpec';
import { ENGINE_PROCESSOR, buildProgram, renderImpulse, type EngineProgram } from './engineSynth';
import workletUrl from './engineWorklet?worker&url';

export interface EngineInput {
  rpm: number;
  redline: number;
  throttle: number;
  nitro: boolean;
  /** 0..1 loudness from distance (1 = the player's own car). */
  proximity: number;
  /** -1..1 stereo position. */
  pan: number;
  /** A gear change is cutting the drive this frame. */
  shifting?: boolean;
  /** Seconds since the last update, for the overrun model (a 60 Hz frame when missing). */
  dt?: number;
}

/**
 * Rich overrun: when a sport silencer pops. Heat builds over seconds of hard
 * driving and cools slowly; a lift from high revs leaves fuel in the pipe that
 * burns off in about a second; while both are high there is a small chance per
 * second of a bang or a crackle burst, each using up fuel. Tuned to be rare:
 * most lifts stay silent, and a cold engine never pops.
 */
const OVERRUN = {
  /** Time constants (s): heat rising under load at revs, cooling when not. */
  heatUp: 6,
  coolDown: 25,
  /** Revs (fraction of the redline) a lift needs to leave fuel. */
  minRevs: 0.5,
  /** Fuel burn off (s), and how fast the pedal takes it back. */
  burnOff: 1.2,
  onThrottle: 0.15,
  /** Chance per second at full fuel, full heat, pops 1 (sport). */
  rate: 0.15,
  /** Share of events that are a single bang rather than a crackle burst. */
  bangShare: 0.45,
  /** Turbo cars run richer under boost and leave more fuel on a lift. */
  turboFuel: 1.3,
} as const;

class AudioHub {
  readonly ctx: AudioContext;
  readonly engineBus: GainNode;
  /** Sound effects (crashes, nitro, horn, beeps): same volume setting, same compressor. */
  readonly sfxBus: GainNode;
  readonly noise: AudioBuffer;
  /** True once the engine worklet is registered; false when the browser has none or the module failed, and voices stay silent. */
  readonly worklet: Promise<boolean>;
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
    this.worklet = this.loadWorklet();
  }

  private async loadWorklet(): Promise<boolean> {
    if (!this.ctx.audioWorklet) return false;
    try {
      await this.ctx.audioWorklet.addModule(workletUrl);
      return true;
    } catch (err) {
      console.warn('Engine sound: the worklet module failed to load', err);
      return false;
    }
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

/**
 * Voice tone and level. PRESENCE: peak at the firing frequency times `harmonic`,
 * clamped to [min, max] Hz, `gain` dB. GAIN scales every voice (the bus
 * compressor keeps a full grid in check). BODY is the valvetrain's band.
 */
const VOICE = {
  presence: { harmonic: 6, min: 550, max: 2400, q: 0.8, gain: 6 },
  gain: 3,
  bodyHz: 1500,
} as const;

const PARAM_NAMES = ['rpm', 'redline', 'load', 'cut', 'limiter', 'nitro'] as const;
type ParamName = (typeof PARAM_NAMES)[number];

/** Each voice gets its own noise seed so rivals never phase lock with the player. */
let voiceCount = 0;

export class EngineVoice {
  readonly program: EngineProgram;
  /** Called when the overrun pops: which tailpipe (0 left, 1 right), size (1 bang, 0 crackle) and seconds until it fires. The owner draws the flame. */
  onPop: ((pipe: number, size: number, delay: number) => void) | null = null;
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private presence: BiquadFilterNode;
  private exhaust: ConvolverNode;
  private intake: BiquadFilterNode;
  private body: BiquadFilterNode;
  private node: AudioWorkletNode | null = null;
  private params: Record<ParamName, AudioParam> | null = null;
  private turbo: OscillatorNode | null = null;
  private gTurbo: GainNode | null = null;
  private bov: GainNode | null = null;
  private boost = 0;
  private lastThrottle = 0;
  private last: EngineInput | null = null;
  private stopped = false;
  private readonly turbocharged: boolean;
  /** Overrun state: exhaust heat and unburnt fuel, both 0..1. */
  private heat = 0;
  private fuel = 0;
  private wasShifting = false;

  /** `lite` (rivals): a shorter silencer response, no intake or valvetrain detail. */
  constructor(
    spec: EngineSpec,
    private readonly base = 0.24,
    opts: { lite?: boolean } = {},
  ) {
    const h = audioHub()!;
    const ctx = (this.ctx = h.ctx);
    this.turbocharged = spec.aspiration === 'turbo';
    this.program = buildProgram(spec, { seed: 7919 * ++voiceCount, lite: opts.lite });
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.engineBus);

    this.presence = ctx.createBiquadFilter();
    this.presence.type = 'peaking';
    this.presence.Q.value = VOICE.presence.q;
    this.presence.gain.value = VOICE.presence.gain;
    this.presence.connect(this.out);
    // Exhaust: the silencer and pipe column as a convolution with a rendered impulse response.
    this.exhaust = ctx.createConvolver();
    // The response is peak normalized already; Web Audio's equal power normalization would bury a long one.
    this.exhaust.normalize = false;
    const ir = renderImpulse(this.program.ir, ctx.sampleRate);
    const buf = ctx.createBuffer(1, ir.length, ctx.sampleRate);
    buf.copyToChannel(ir, 0);
    this.exhaust.buffer = buf;
    this.exhaust.connect(this.presence);
    // Intake through its trumpet resonance; the valvetrain tick above the exhaust's band.
    this.intake = ctx.createBiquadFilter();
    this.intake.type = 'bandpass';
    this.intake.frequency.value = this.program.intake.hz;
    this.intake.Q.value = this.program.intake.q;
    this.intake.connect(this.out);
    this.body = ctx.createBiquadFilter();
    this.body.type = 'highpass';
    this.body.frequency.value = VOICE.bodyHz;
    this.body.connect(this.out);

    if (spec.aspiration === 'turbo') {
      // Turbo spool whistle, straight to the output (not through the silencer).
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
    void h.worklet.then((ok) => this.attach(ok));
  }

  private attach(ok: boolean): void {
    if (!ok || this.stopped) return;
    try {
      const node = new AudioWorkletNode(this.ctx, ENGINE_PROCESSOR, {
        numberOfInputs: 0,
        // Twin tailpipes come out left and right, so a bank's uneven train is heard on its own, not cancelled by the other's.
        numberOfOutputs: 3,
        outputChannelCount: [this.program.pipes, 1, 1],
        processorOptions: { program: this.program },
      });
      node.connect(this.exhaust, 0);
      node.connect(this.intake, 1);
      node.connect(this.body, 2);
      this.node = node;
      this.params = Object.fromEntries(PARAM_NAMES.map((n) => [n, node.parameters.get(n)!])) as Record<ParamName, AudioParam>;
      if (this.last) this.update(this.last);
    } catch (err) {
      console.warn('Engine sound: could not start a voice', err);
    }
  }

  update(e: EngineInput): void {
    if (this.stopped) return;
    this.last = e;
    const t = this.ctx.currentTime;
    const tc = 0.03;
    const rpm = Math.max(500, e.rpm);
    const load = Math.max(0, Math.min(1, e.throttle));
    const r = Math.min(1.05, rpm / e.redline);
    const f = (rpm / 60) * (this.program.cylinders.length / this.program.revsPerCycle);
    // The sim holds rpm at the redline by cutting torque; the voice bounces off a limiter instead.
    const limiter = rpm >= e.redline - 40 && load > 0.5;
    const p = this.params;
    if (p) {
      p.rpm.setTargetAtTime(rpm, t, tc);
      p.redline.setValueAtTime(e.redline, t);
      p.load.setTargetAtTime(load, t, tc);
      p.cut.setValueAtTime(e.shifting ? 1 : 0, t);
      p.limiter.setValueAtTime(limiter ? 1 : 0, t);
      p.nitro.setValueAtTime(e.nitro ? 1 : 0, t);
    }
    const pr = VOICE.presence;
    this.presence.frequency.setTargetAtTime(Math.max(pr.min, Math.min(pr.max, f * pr.harmonic)), t, tc);
    const level = this.base * VOICE.gain * this.program.trim * e.proximity * (0.45 + 0.55 * load) * (0.7 + 0.3 * r) * (e.shifting ? 0.75 : 1);
    this.out.gain.setTargetAtTime(level, t, 0.05);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, e.pan)), t, 0.05);
    this.overrun(load, r, e.shifting === true, Math.min(0.1, e.dt ?? 1 / 60));

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

  /** The rich overrun model (OVERRUN): decides the pops, then fires them in the worklet and tells the owner. */
  private overrun(load: number, r: number, shifting: boolean, dt: number): void {
    const P = this.program;
    if (P.pops <= 0) return;
    const drive = (load * Math.max(0, r - 0.2)) / 0.8;
    this.heat += (drive - this.heat) * (1 - Math.exp(-dt / (drive > this.heat ? OVERRUN.heatUp : OVERRUN.coolDown)));
    if (this.lastThrottle > 0.6 && load < 0.2 && r > OVERRUN.minRevs) this.fuel = Math.min(1, this.fuel + (0.4 + 0.6 * r) * (this.turbocharged ? OVERRUN.turboFuel : 1));
    // A downshift blip at revs dumps a little too.
    if (shifting && !this.wasShifting && r > 0.6) this.fuel = Math.min(1, this.fuel + 0.25);
    this.wasShifting = shifting;
    this.fuel *= Math.exp(-dt / OVERRUN.burnOff);
    if (load > 0.3) this.fuel *= Math.exp(-dt / OVERRUN.onThrottle);
    if (this.fuel < 0.1 || Math.random() >= P.pops * OVERRUN.rate * this.fuel * this.heat * dt) return;
    this.fuel *= 0.45;
    if (Math.random() < OVERRUN.bangShare) this.pop(0, 1, 2.2 + Math.random());
    else {
      const n = 2 + Math.floor(Math.random() * 3);
      let at = 0;
      for (let i = 0; i < n; i++) {
        this.pop(at, 0, 0.9 + Math.random() * 0.6);
        at += 0.03 + Math.random() * 0.05;
      }
    }
  }

  private pop(delay: number, size: number, gain: number): void {
    const pipe = this.program.pipes > 1 && Math.random() < 0.5 ? 1 : 0;
    this.node?.port.postMessage({ pop: { at: delay, pipe, gain, size } });
    this.onPop?.(pipe, size, delay);
  }

  silence(): void {
    if (!this.stopped) this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    this.turbo?.stop(t + 0.2);
    const node = this.node;
    setTimeout(() => {
      node?.port.postMessage('stop');
      node?.disconnect();
      this.pan.disconnect();
    }, 400);
  }
}

/**
 * A free revving engine for the garage and menus: no car, no gearbox, just a
 * flywheel that chases the throttle, falls back to idle and bounces off the
 * rev limiter. Owns its EngineVoice (null when Web Audio is unavailable).
 *
 *   const eng = new FreeRevEngine(manifestCar('protoCompact').engine, { idle: 900, redline: 7600 });
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
