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
import { CHAIN, ENGINE_PROCESSOR, SYNTH_PARAMS, buildProgram, firingHz, presenceHz, renderImpulse, type EngineMessage, type EngineProgram, type SynthParams } from './engineSynth';
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
  heatUp: 4,
  coolDown: 20,
  /** Revs (fraction of the redline) a lift needs to leave fuel; from the top it leaves the most. */
  minRevs: 0.45,
  /** Fuel burn off (s), and how fast the pedal takes it back. */
  burnOff: 1.2,
  onThrottle: 0.15,
  /** Chance per second on the overrun at full fuel, full heat, pops 1 (sport). */
  rate: 0.3,
  /** Events per second while bouncing off the limiter: the cut dumps mixture every few firings. */
  limiterRate: 4,
  /** Chance that a high rev upshift's cut pops (times the silencer's freedom and the heat). */
  shiftChance: 0.35,
  /** Share of events that are a single bang rather than a crackle burst. */
  bangShare: 0.45,
  /** Turbo cars run richer under boost and leave more fuel on a lift. */
  turboFuel: 1.3,
} as const;

/** User levels 0..1 per bus (a slider maps to gain by its square), as the Sound settings hold them. */
export interface AudioLevels {
  masterVolume: number;
  engineVolume: number;
  effectsVolume: number;
  ambienceVolume: number;
  interfaceVolume: number;
}

/**
 * The mix. Four buses under one master, each with a calibration that sets
 * where the bus sits with every slider at its default (so the defaults are the
 * intended balance and a slider only moves away from it), then the user's
 * levels on top. The master ends in a safety limiter, not a musical
 * compressor: with sources gain staged against each other nothing should need
 * glue, and the old 4:1 compressor at -18 dB let a loud engine duck every
 * effect. Targets at the defaults, at the destination: the player's engine
 * about -17 dBFS RMS at full throttle (9 dB over the music's -26), impacts
 * peaking near -8, ambience beds (crowds, trains, weather) 6 to 10 dB under
 * the engine, menu sounds under everything.
 */
const MIX = {
  calibration: { engine: 0.9, effects: 0.9, ambience: 0.9, interface: 0.9 },
  limiter: { threshold: -3, knee: 2, ratio: 20, attack: 0.002, release: 0.12 },
  defaults: { masterVolume: 0.7, engineVolume: 1, effectsVolume: 1, ambienceVolume: 1, interfaceVolume: 1 } as AudioLevels,
} as const;

class AudioHub {
  readonly ctx: AudioContext;
  /** Engine voices. */
  readonly engineBus: GainNode;
  /** Effects of the drive: impacts, scrapes, nitrous, horn, beeps, fireworks. */
  readonly effectsBus: GainNode;
  /** The world around it: crowds, trains, helicopters, thunder, the crossing bell. */
  readonly ambienceBus: GainNode;
  /** Menu sounds. */
  readonly uiBus: GainNode;
  readonly master: GainNode;
  readonly noise: AudioBuffer;
  /** True once the engine worklet is registered; false when the browser has none or the module failed, and voices stay silent. */
  readonly worklet: Promise<boolean>;
  private levels: AudioLevels = { ...MIX.defaults };

  constructor() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = MIX.limiter.threshold;
    limiter.knee.value = MIX.limiter.knee;
    limiter.ratio.value = MIX.limiter.ratio;
    limiter.attack.value = MIX.limiter.attack;
    limiter.release.value = MIX.limiter.release;
    this.master.connect(limiter).connect(this.ctx.destination);
    const bus = () => {
      const g = this.ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.engineBus = bus();
    this.effectsBus = bus();
    this.ambienceBus = bus();
    this.uiBus = bus();
    this.applyLevels(this.levels);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const resume = () => {
      if (this.ctx.state !== 'running') void this.ctx.resume();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, resume, true);
    this.worklet = this.loadWorklet();
  }

  /** The effects bus under its old name (sound effects were the only other bus once). */
  get sfxBus(): GainNode {
    return this.effectsBus;
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

  /** Set every bus from the user's levels (any missing one keeps its value). */
  applyLevels(levels: Partial<AudioLevels>): void {
    const clamp = (v: number | undefined, prev: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v as number)) : prev);
    const l = this.levels;
    l.masterVolume = clamp(levels.masterVolume, l.masterVolume);
    l.engineVolume = clamp(levels.engineVolume, l.engineVolume);
    l.effectsVolume = clamp(levels.effectsVolume, l.effectsVolume);
    l.ambienceVolume = clamp(levels.ambienceVolume, l.ambienceVolume);
    l.interfaceVolume = clamp(levels.interfaceVolume, l.interfaceVolume);
    const t = this.ctx.currentTime;
    const gain = (v: number) => v * v;
    this.master.gain.setTargetAtTime(gain(l.masterVolume), t, 0.05);
    this.engineBus.gain.setTargetAtTime(gain(l.engineVolume) * MIX.calibration.engine, t, 0.05);
    this.effectsBus.gain.setTargetAtTime(gain(l.effectsVolume) * MIX.calibration.effects, t, 0.05);
    this.ambienceBus.gain.setTargetAtTime(gain(l.ambienceVolume) * MIX.calibration.ambience, t, 0.05);
    this.uiBus.gain.setTargetAtTime(gain(l.interfaceVolume) * MIX.calibration.interface, t, 0.05);
  }

  /** The engine level alone (the garage's volume control). */
  setVolume(v: number): void {
    this.applyLevels({ engineVolume: v });
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
 * Voice level: GAIN scales every voice (the bus compressor keeps a full grid in
 * check); the tone shaping around the worklet is CHAIN in engineSynth.ts, shared
 * with the loudness model that trims every program to one loudness.
 */
const VOICE = { gain: 16 } as const;

type ParamName = keyof SynthParams;

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
    this.presence.Q.value = CHAIN.presence.q;
    this.presence.gain.value = CHAIN.presence.gain;
    const top = ctx.createBiquadFilter();
    top.type = 'lowpass';
    top.frequency.value = CHAIN.top;
    top.Q.value = CHAIN.topQ;
    this.presence.connect(top).connect(this.out);
    // Exhaust: the silencer and pipe column as a convolution with a rendered impulse response.
    this.exhaust = ctx.createConvolver();
    // The response is peak normalized already; Web Audio's equal power normalization would bury a long one.
    this.exhaust.normalize = false;
    const ir = renderImpulse(this.program.ir, ctx.sampleRate);
    const buf = ctx.createBuffer(1, ir.length, ctx.sampleRate);
    buf.copyToChannel(ir, 0);
    this.exhaust.buffer = buf;
    this.exhaust.connect(this.presence);
    // Intake through its trumpet resonance; the valvetrain tick in its own narrow band.
    this.intake = ctx.createBiquadFilter();
    this.intake.type = 'bandpass';
    this.intake.frequency.value = this.program.intake.hz;
    this.intake.Q.value = this.program.intake.q;
    this.intake.connect(this.out);
    this.body = ctx.createBiquadFilter();
    this.body.type = 'bandpass';
    this.body.frequency.value = CHAIN.bodyHz;
    this.body.Q.value = CHAIN.bodyQ;
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
        // Two tips, left and right: a bank each on a twin pipe car (so a bank's uneven train is heard on its own, not
        // cancelled by the other's), the one exhaust through two tips otherwise, so every car is as wide.
        numberOfOutputs: 3,
        outputChannelCount: [2, 1, 1],
        processorOptions: { program: this.program },
      });
      node.connect(this.exhaust, 0);
      node.connect(this.intake, 1);
      node.connect(this.body, 2);
      this.node = node;
      this.params = Object.fromEntries(SYNTH_PARAMS.map((p) => [p.name, node.parameters.get(p.name)!])) as Record<ParamName, AudioParam>;
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
    // The sim holds rpm at the redline by cutting torque, a free revving garage engine dips under it between cuts; either way the pedal is down near the top.
    const limiter = rpm >= e.redline - 150 && Math.max(load, this.lastThrottle) > 0.5;
    const p = this.params;
    if (p) {
      p.rpm.setTargetAtTime(rpm, t, tc);
      p.redline.setValueAtTime(e.redline, t);
      p.load.setTargetAtTime(load, t, tc);
      p.cut.setValueAtTime(e.shifting ? 1 : 0, t);
      p.limiter.setValueAtTime(limiter ? 1 : 0, t);
      p.nitro.setValueAtTime(e.nitro ? 1 : 0, t);
    }
    this.presence.frequency.setTargetAtTime(presenceHz(firingHz(this.program, rpm)), t, tc);
    // Closed throttle is only a little quieter: the overrun is where the pops and the silencer's character are heard.
    const level = this.base * VOICE.gain * this.program.trim * e.proximity * (0.7 + 0.3 * load) * (0.7 + 0.3 * r) * (e.shifting ? 0.8 : 1);
    this.out.gain.setTargetAtTime(level, t, 0.05);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, e.pan)), t, 0.05);
    this.overrun(load, r, e.shifting === true, limiter, Math.min(0.1, e.dt ?? 1 / 60));

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

  /**
   * The rich overrun model (OVERRUN): decides the pops, then fires them in the
   * worklet and tells the owner. Three ways in: bouncing off the limiter (a
   * stream of crackles, the cut dumps mixture every few firings), a high rev
   * upshift's cut (sometimes), and the overrun after a lift from revs (the
   * hotter the exhaust and the higher the lift, the likelier).
   */
  private overrun(load: number, r: number, shifting: boolean, limiter: boolean, dt: number): void {
    const P = this.program;
    if (P.pops <= 0) return;
    const free = Math.min(1.5, P.pops);
    const drive = (load * Math.max(0, r - 0.2)) / 0.8;
    this.heat += (drive - this.heat) * (1 - Math.exp(-dt / (drive > this.heat ? OVERRUN.heatUp : OVERRUN.coolDown)));
    if (this.lastThrottle > 0.6 && load < 0.2 && r > OVERRUN.minRevs) {
      const lift = Math.min(1, (r - OVERRUN.minRevs) / (1 - OVERRUN.minRevs)) ** 1.2;
      this.fuel = Math.min(1, this.fuel + lift * (this.turbocharged ? OVERRUN.turboFuel : 1));
    }
    const upshift = shifting && !this.wasShifting && r > 0.8;
    this.wasShifting = shifting;
    this.fuel *= Math.exp(-dt / OVERRUN.burnOff);
    if (load > 0.3 && !limiter) this.fuel *= Math.exp(-dt / OVERRUN.onThrottle);
    let chance = 0;
    if (limiter) {
      chance = OVERRUN.limiterRate * (0.4 + 0.6 * free) * dt;
      this.heat = Math.min(1, this.heat + dt / 2);
    } else if (upshift) chance = OVERRUN.shiftChance * free * (0.3 + 0.7 * this.heat);
    else if (this.fuel > 0.1) chance = P.pops * OVERRUN.rate * this.fuel * this.heat * dt;
    if (Math.random() >= chance) return;
    this.fuel *= limiter ? 0.9 : 0.45;
    if (Math.random() < (limiter ? 0.2 : OVERRUN.bangShare)) this.pop(0, 1, 0.22 + 0.1 * Math.random());
    else {
      const n = limiter ? 1 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 3);
      let at = 0;
      for (let i = 0; i < n; i++) {
        this.pop(at, 0.3 * Math.random(), 0.09 + 0.06 * Math.random());
        at += 0.03 + Math.random() * 0.05;
      }
    }
  }

  private pop(delay: number, size: number, gain: number): void {
    const pipe = this.program.pipes > 1 && Math.random() < 0.5 ? 1 : 0;
    this.node?.port.postMessage({ pop: { at: delay, pipe, gain, size } } satisfies EngineMessage);
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
      node?.port.postMessage('stop' satisfies EngineMessage);
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
 *   const eng = new FreeRevEngine(manifestCar('protoHatch').engine, { idle: 900, redline: 6800 });
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
