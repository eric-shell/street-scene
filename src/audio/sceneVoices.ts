/**
 * Standalone voices a scene owns rather than the race: the elevated train's
 * rumble, the news helicopter's rotors, the thunder of rain nights, a fireworks display, a far stadium crowd, the
 * San Francisco cable car's bell and the harbor ferry's horn (both struck, not fed: they play out). Each
 * is created only after a user gesture (browsers refuse audio before that),
 * plays on the effects bus and fades out by itself when it stops being fed.
 */
import { audioHub } from './engineAudio';
import { rnd } from './sfxRecipes';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));


/** Train rumble mix: overall level, deck boom and joint rattle gains, rattle pulse depth. */
const RUMBLE = { level: 0.5, boom: 4, boomHz: 120, rattle: 1.1, rattleHz: 700, pulse: 0.8, jointSpacing: 7.7 } as const;

/**
 * Elevated train rumble (render/traffic/trains.ts): low filtered noise for the deck
 * booming plus a mid band rattle pulsed at the rate the trucks cross rail
 * joints, panned and scaled by the nearest train's distance and speed. It
 * fades out by itself shortly after the last update, so when the scene stops
 * being drawn (garage, a menu over a finished race) it never keeps droning.
 * Only created after the page has had a user gesture: browsers refuse audio
 * before that, and creating the context early only earns a console warning.
 */
export class TrainRumble {
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private src: AudioBufferSourceNode;
  private lfo: OscillatorNode;

  /** True while the browser still waits for the first user gesture. */
  static blocked(): boolean {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    return !!ua && !ua.hasBeenActive;
  }

  static create(): TrainRumble | null {
    if (typeof window === 'undefined' || TrainRumble.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new TrainRumble(h);
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>) {
    const ctx = (this.ctx = h.ctx);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.ambienceBus);
    this.src = ctx.createBufferSource();
    this.src.buffer = h.noise;
    this.src.loop = true;
    const boom = ctx.createBiquadFilter();
    boom.type = 'lowpass';
    boom.frequency.value = RUMBLE.boomHz;
    boom.Q.value = 0.9;
    const boomGain = ctx.createGain();
    boomGain.gain.value = RUMBLE.boom;
    const rattle = ctx.createBiquadFilter();
    rattle.type = 'bandpass';
    rattle.frequency.value = RUMBLE.rattleHz;
    rattle.Q.value = 1.4;
    const rattleGain = ctx.createGain();
    rattleGain.gain.value = RUMBLE.rattle;
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfo.frequency.value = 2;
    const depth = ctx.createGain();
    depth.gain.value = RUMBLE.rattle * RUMBLE.pulse;
    this.lfo.connect(depth).connect(rattleGain.gain);
    this.src.connect(boom).connect(boomGain).connect(this.out);
    this.src.connect(rattle).connect(rattleGain).connect(this.out);
    this.src.start();
    this.lfo.start();
  }

  /** proximity 0..1 (1 = right overhead), speed of that train (m/s), pan -1..1. */
  update(proximity: number, speed: number, pan: number): void {
    const now = this.ctx.currentTime;
    const target = RUMBLE.level * Math.pow(Math.max(0, proximity), 1.3) * (0.35 + 0.65 * Math.min(1, speed / 17));
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(target, now, 0.1);
    // Dead man's switch: silence unless the next frame renews it.
    g.setTargetAtTime(0, now + 0.35, 0.2);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.8, now, 0.1);
    this.lfo.frequency.setTargetAtTime(Math.max(0.3, speed / RUMBLE.jointSpacing), now, 0.2);
  }

  dispose(): void {
    try {
      this.src.stop();
      this.lfo.stop();
    } catch {
      /* already stopped */
    }
    this.out.disconnect();
  }
}

/** Helicopter rotor mix: level, blade pass rate (Hz) and thump depth, the low body of the sound and the turbine whine. */
const ROTOR = { level: 0.48, bladeHz: 10.5, thump: 0.85, bodyHz: 220, body: 3.2, whineHz: 1700, whine: 0.08 } as const;
/** A rotor's voice: ROTOR's numbers, any of which a second helicopter (the police one) can change. */
export type RotorVoice = { [K in keyof typeof ROTOR]: number };

/**
 * News helicopter rotor (render/traffic/airTraffic.ts): low filtered noise chopped at
 * the blade pass rate for the thump, plus a thin turbine whine, panned and
 * scaled by the helicopter's distance. Same shape as TrainRumble: created
 * after the first user gesture, and the gain dies by itself unless the next
 * frame renews it, so a scene that stops rendering never keeps thumping.
 */
export class HeliRotor {
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private src: AudioBufferSourceNode;
  private lfo: OscillatorNode;
  private readonly level: number;

  /** True while the browser still waits for the first user gesture. */
  static blocked(): boolean {
    return TrainRumble.blocked();
  }

  static create(voice: Partial<RotorVoice> = {}): HeliRotor | null {
    if (typeof window === 'undefined' || HeliRotor.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new HeliRotor(h, { ...ROTOR, ...voice });
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>, voice: RotorVoice) {
    this.level = voice.level;
    const ctx = (this.ctx = h.ctx);
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.ambienceBus);
    this.src = ctx.createBufferSource();
    this.src.buffer = h.noise;
    this.src.loop = true;
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = voice.bodyHz;
    body.Q.value = 1.1;
    const bodyGain = ctx.createGain();
    bodyGain.gain.value = voice.body * (1 - voice.thump);
    // The chop: a square wave at the blade pass rate opens and closes the body gain.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'square';
    this.lfo.frequency.value = voice.bladeHz;
    const depth = ctx.createGain();
    depth.gain.value = voice.body * voice.thump;
    this.lfo.connect(depth).connect(bodyGain.gain);
    const whine = ctx.createBiquadFilter();
    whine.type = 'bandpass';
    whine.frequency.value = voice.whineHz;
    whine.Q.value = 9;
    const whineGain = ctx.createGain();
    whineGain.gain.value = voice.whine;
    this.src.connect(body).connect(bodyGain).connect(this.out);
    this.src.connect(whine).connect(whineGain).connect(this.out);
    this.src.start();
    this.lfo.start();
  }

  /** proximity 0..1 (1 = right overhead), pan -1..1. */
  update(proximity: number, pan: number): void {
    const now = this.ctx.currentTime;
    const target = this.level * Math.pow(Math.max(0, proximity), 1.2);
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(target, now, 0.12);
    // Dead man's switch: silence unless the next frame renews it.
    g.setTargetAtTime(0, now + 0.35, 0.2);
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.7, now, 0.1);
  }

  dispose(): void {
    try {
      this.src.stop();
      this.lfo.stop();
    } catch {
      /* already stopped */
    }
    this.out.disconnect();
  }
}

/**
 * Thunder mix: overall level, the distance (m) a strike is still heard at full
 * weight, the rumble's low pass (Hz) near and far, how long it rolls (s) near
 * and far, and the crack of a close strike: the distance it fades out by (m),
 * its level and its band (Hz).
 */
const THUNDER = { level: 0.4, near: 1800, lowNear: 420, lowFar: 150, rollNear: 4, rollFar: 8.5, crackUnder: 2400, crack: 0.9, crackHz: 2600 } as const;

/**
 * Thunder for the lightning on rain nights (render/sky/lightning.ts calls strike()
 * once the sound of a bolt has travelled to the camera). A rumble of looped
 * hub noise through two low passes, darker and longer the further the strike,
 * swelling in and rolling through a few random surges before it dies; a close
 * strike opens with a bright crack and a deep thump. Panned toward the bolt.
 * Nodes are made per strike (one every 15 s or more) and stopped and
 * disconnected when it ends. Created after the first user gesture, like the
 * rotors.
 */
export class Thunder {
  private ctx: AudioContext;
  private bus: GainNode;
  private noise: AudioBuffer;
  private live = new Set<AudioScheduledSourceNode>();

  static create(): Thunder | null {
    if (typeof window === 'undefined' || TrainRumble.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new Thunder(h);
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>) {
    this.ctx = h.ctx;
    this.bus = h.ambienceBus;
    this.noise = h.noise;
  }

  /** One strike `distance` m away, power 0..1, pan -1..1 (left to right). */
  strike(distance: number, power: number, pan: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const T = THUNDER;
    const far = clamp01((distance - 600) / 5500);
    // Far strikes fall away properly: at `near` m half, at three times that a tenth.
    const level = T.level * power * (0.06 + 0.94 / (1 + (distance / T.near) ** 2));
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan)) * 0.7;
    out.connect(this.bus);
    let open = 0;
    const track = (src: AudioScheduledSourceNode, end: number) => {
      this.live.add(src);
      open++;
      src.onended = () => {
        this.live.delete(src);
        src.disconnect();
        if (--open === 0) out.disconnect();
      };
      src.stop(end);
    };
    // Rumble: slow noise (about half rate) through two low passes, swelling in and rolling.
    const roll = T.rollNear + (T.rollFar - T.rollNear) * far;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rnd(0.45, 0.6);
    const lp1 = ctx.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = T.lowNear + (T.lowFar - T.lowNear) * far;
    lp1.Q.value = 0.6;
    const lp2 = ctx.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = lp1.frequency.value * 1.4;
    lp2.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    const attack = 0.05 + 0.5 * far;
    g.gain.linearRampToValueAtTime(level * 2.2, now + attack);
    let t = now + attack;
    const surges = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < surges; i++) {
      t += rnd(0.35, 0.9) * (0.8 + far);
      g.gain.setTargetAtTime(level * 2.2 * rnd(0.3, 0.95), t, 0.18);
    }
    g.gain.setTargetAtTime(0, t + 0.3, roll * 0.22);
    src.connect(lp1).connect(lp2).connect(g).connect(out);
    src.start(now, Math.random() * this.noise.duration);
    track(src, t + 0.3 + roll);
    if (distance >= T.crackUnder) return;
    // Close: a crack (bright noise, fast decay) and a deep thump under it.
    const near = 1 - distance / T.crackUnder;
    const crack = ctx.createBufferSource();
    crack.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = T.crackHz;
    band.Q.value = 0.4;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0, now);
    cg.gain.linearRampToValueAtTime(level * T.crack * near, now + 0.006);
    cg.gain.setTargetAtTime(0, now + 0.02, 0.09);
    crack.connect(band).connect(cg).connect(out);
    crack.start(now, Math.random() * Math.max(0, this.noise.duration - 1));
    track(crack, now + 0.9);
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(70, now);
    thump.frequency.exponentialRampToValueAtTime(32, now + 0.6);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, now);
    tg.gain.linearRampToValueAtTime(level * 1.4 * near, now + 0.03);
    tg.gain.setTargetAtTime(0, now + 0.05, 0.35);
    thump.connect(tg).connect(out);
    thump.start(now);
    track(thump, now + 2);
  }

  /** Stop whatever is still rolling (the scene went away). */
  dispose(): void {
    for (const s of Array.from(this.live)) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
  }
}

/**
 * Cable car bell mix: the strike's partials (ratios of the fundamental, levels, decays in s), the hammer click, the
 * gripman's ring (strike offsets in s: "clang clang, clang-a-lang") and the output level.
 */
const CABLE_BELL = {
  f0: 1180,
  partials: [1, 2.02, 2.71, 4.13, 5.38],
  levels: [1, 0.5, 0.42, 0.2, 0.1],
  decays: [0.95, 0.6, 0.42, 0.24, 0.13],
  click: 0.4,
  seconds: 1.3,
  ring: [0, 0.17, 0.46, 0.58, 0.7],
  level: 0.5,
} as const;

/** One struck brass bell: inharmonic partials with exponential decays and a few ms of hammer noise. */
export function renderCableBellStrike(sampleRate: number): Float32Array<ArrayBuffer> {
  const B = CABLE_BELL;
  const n = Math.round(sampleRate * B.seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let k = 0; k < B.partials.length; k++) v += B.levels[k] * Math.exp(-t / B.decays[k]) * Math.sin(2 * Math.PI * B.f0 * B.partials[k] * t);
    if (t < 0.003) v += B.click * (Math.random() * 2 - 1) * (1 - t / 0.003);
    // A short fade at the end so a strike never clicks off.
    out[i] = (v * Math.min(1, (n - i) / (0.02 * sampleRate))) / 2.2;
  }
  return out;
}

/**
 * The San Francisco cable car's bell (render/traffic/cableCar.ts rings it at every departure and at a race car in
 * the car's way): one strike rendered offline once, played as the gripman's rhythm of strikes, each a buffer source
 * through the voice's gain and panner on the ambience bus, at the proximity and pan the caller gives for the ring
 * (distance faded from the camera). Nothing loops, so a voice that is never rung costs nothing. Created only after
 * a user gesture (browser policy); the cosmetic noise and the strikes' spread use Math.random.
 */
export class CableBell {
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private buf: AudioBuffer;

  /** True while the browser still waits for the first user gesture. */
  static blocked(): boolean {
    return TrainRumble.blocked();
  }

  static create(): CableBell | null {
    if (typeof window === 'undefined' || CableBell.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new CableBell(h);
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>) {
    const ctx = (this.ctx = h.ctx);
    this.out = ctx.createGain();
    this.out.gain.value = CABLE_BELL.level;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.ambienceBus);
    const data = renderCableBellStrike(ctx.sampleRate);
    this.buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    this.buf.copyToChannel(data, 0);
  }

  /** One ring: proximity 0..1 (1 = beside it), pan -1..1. */
  ring(proximity: number, pan: number): void {
    const now = this.ctx.currentTime;
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.8, now, 0.02);
    const g = clamp01(proximity);
    for (const at of CABLE_BELL.ring) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.buf;
      src.playbackRate.value = rnd(0.985, 1.015);
      const strike = this.ctx.createGain();
      strike.gain.value = g * rnd(0.8, 1);
      src.connect(strike).connect(this.out);
      src.start(now + at + rnd(0, 0.02));
      src.onended = () => strike.disconnect();
    }
  }

  dispose(): void {
    this.out.disconnect();
  }
}

/** The ferry's horn: two long blasts' worth of a ship's two tone chord, as an offline rendered buffer. Hz of the two fundamentals, harmonics summed, seconds, attack and release (s), level, and the farthest low pass (Hz). */
export const FERRY_HORN = {
  tones: [110, 138.6],
  harmonics: 8,
  seconds: 2.4,
  attack: 0.14,
  release: 0.65,
  level: 0.5,
  open: 4200,
} as const;

/** One blast of a ship's horn: two fundamentals with a falling harmonic series (a bright reed), a slow swell in and a long tail out. */
export function renderFerryHorn(sampleRate: number): Float32Array<ArrayBuffer> {
  const H = FERRY_HORN;
  const n = Math.round(sampleRate * H.seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let k = 0; k < H.tones.length; k++) {
      // A touch of drift between the two reeds so the chord beats slowly.
      const f0 = H.tones[k] * (1 + 0.0012 * Math.sin(2 * Math.PI * (0.31 + 0.07 * k) * t));
      for (let h = 1; h <= H.harmonics; h++) v += (1 / h) * Math.sin(2 * Math.PI * f0 * h * t + h * k);
    }
    const env = Math.min(1, t / H.attack) ** 1.5 * Math.min(1, (H.seconds - t) / H.release) ** 2;
    out[i] = (v * env) / 4.4;
  }
  return out;
}

/**
 * The harbor ferry's horn (render/districts/waterfrontFerry.ts blows it at the departure and as the boat comes in to the
 * quay): one blast rendered offline once, played through a low pass that closes with distance (far horns are mostly the
 * low tones), the voice's gain and panner on the ambience bus. Nothing loops, so a horn never blown costs nothing. Created
 * only after a user gesture (browser policy).
 */
export class FerryHorn {
  private ctx: AudioContext;
  private out: GainNode;
  private pan: StereoPannerNode;
  private buf: AudioBuffer;

  /** True while the browser still waits for the first user gesture. */
  static blocked(): boolean {
    return TrainRumble.blocked();
  }

  static create(): FerryHorn | null {
    if (typeof window === 'undefined' || FerryHorn.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new FerryHorn(h);

/**
 * Firework mix (render/sky/fireworks.ts): the boom's level and low pass (Hz, near and far), the launch thump's
 * level, the crackle's level and band (Hz), the distance (m) a burst is still heard at full weight, and the least
 * share a far one keeps. Set against the thunder neighbourhood in docs/audioMix.md.
 */
const FIREWORK = { boom: 0.5, boomNear: 700, boomFar: 260, thump: 0.2, crackle: 0.1, crackleHz: 4200, near: 900, floor: 0.05 } as const;

/**
 * A fireworks display's sound, on the ambience bus like thunder: a thump when the shell leaves the barge, and a boom
 * with a crackle at the burst, each started once the sound has crossed the distance (the caller waits for it).
 * Louder for a bigger shell, duller and softer with distance, panned toward the water. A crackle shell's sizzle is
 * thirty-odd pulses of bright noise inside one gain envelope, so it costs one source.
 */
export class FireworkVoice {
  private ctx: AudioContext;
  private bus: GainNode;
  private noise: AudioBuffer;
  private live = new Set<AudioScheduledSourceNode>();

  static create(): FireworkVoice | null {
    if (typeof window === 'undefined' || TrainRumble.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new FireworkVoice(h);
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>) {
    const ctx = (this.ctx = h.ctx);
    this.out = ctx.createGain();
    this.out.gain.value = FERRY_HORN.level;
    this.pan = ctx.createStereoPanner();
    this.out.connect(this.pan).connect(h.ambienceBus);
    const data = renderFerryHorn(ctx.sampleRate);
    this.buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    this.buf.copyToChannel(data, 0);
  }

  /** One blast: proximity 0..1 (1 = alongside), pan -1..1, the distance (m) that closes the low pass. */
  blast(proximity: number, pan: number, distance: number): void {
    const now = this.ctx.currentTime;
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)) * 0.8, now, 0.02);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(380, FERRY_HORN.open / (1 + distance / 220));
    const g = this.ctx.createGain();
    g.gain.value = clamp01(proximity);
    src.connect(lp).connect(g).connect(this.out);
    src.start(now);
    src.onended = () => g.disconnect();
  }

  dispose(): void {
    this.out.disconnect();

    this.ctx = h.ctx;
    this.bus = h.ambienceBus;
    this.noise = h.noise;
  }

  private fall(distance: number): number {
    return FIREWORK.floor + (1 - FIREWORK.floor) / (1 + (distance / FIREWORK.near) ** 2);
  }

  private out(pan: number, end: number): { node: StereoPannerNode; track: (s: AudioScheduledSourceNode, stopAt: number) => void } {
    const node = this.ctx.createStereoPanner();
    node.pan.value = Math.max(-1, Math.min(1, pan)) * 0.7;
    node.connect(this.bus);
    let open = 0;
    return {
      node,
      track: (src, stopAt) => {
        this.live.add(src);
        open++;
        src.onended = () => {
          this.live.delete(src);
          src.disconnect();
          if (--open === 0) node.disconnect();
        };
        src.stop(Math.max(stopAt, end));
      },
    };
  }

  /** The shell leaving the mortar, `distance` m away: a short low whump. */
  launch(distance: number, pan: number, size: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const level = FIREWORK.thump * size * this.fall(distance);
    const { node, track } = this.out(pan, now + 0.5);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level * 1.6, now + 0.02);
    g.gain.setTargetAtTime(0, now + 0.04, 0.09);
    src.connect(lp).connect(g).connect(node);
    src.start(now, Math.random() * (this.noise.duration - 0.6));
    track(src, now + 0.6);
  }

  /** A burst `distance` m away: boom and thump, a crackle after it for the crackle shell, a sizzle for the rest. */
  burst(distance: number, pan: number, size: number, kind: string): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const F = FIREWORK;
    const far = Math.min(1, distance / 2400);
    const level = F.boom * size * this.fall(distance);
    const { node, track } = this.out(pan, now + 2.5);
    // Boom: noise through a low pass that darkens with distance, a fast attack and a rolling decay.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = rnd(0.5, 0.65);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = F.boomNear + (F.boomFar - F.boomNear) * far;
    lp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(level * 1.4, now + 0.012);
    g.gain.setTargetAtTime(0, now + 0.03, 0.16 + 0.12 * far);
    src.connect(lp).connect(g).connect(node);
    src.start(now, Math.random() * (this.noise.duration - 1));
    track(src, now + 1.8);
    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(75, now);
    thump.frequency.exponentialRampToValueAtTime(34, now + 0.4);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0, now);
    tg.gain.linearRampToValueAtTime(level * 0.9, now + 0.015);
    tg.gain.setTargetAtTime(0, now + 0.04, 0.12);
    thump.connect(tg).connect(node);
    thump.start(now);
    track(thump, now + 1);
    // Crackle: bright pulses scattered over the stars' fall, many for the crackle shell.
    const pulses = kind === 'crackle' ? 34 : kind === 'chrysanthemum' ? 12 : 6;
    const sizzle = ctx.createBufferSource();
    sizzle.buffer = this.noise;
    sizzle.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = F.crackleHz * (1 - 0.45 * far);
    band.Q.value = 0.8;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    const span = kind === 'crackle' ? 2.1 : 1.2;
    const start = kind === 'crackle' ? 0.9 : 0.15;
    for (let i = 0; i < pulses; i++) {
      const t = now + start + Math.random() * span;
      cg.gain.setValueAtTime(0, t);
      cg.gain.linearRampToValueAtTime(F.crackle * size * this.fall(distance) * rnd(0.3, 1), t + 0.002);
      cg.gain.setTargetAtTime(0, t + 0.004, 0.012);
    }
    sizzle.connect(band).connect(cg).connect(node);
    sizzle.start(now, Math.random() * this.noise.duration);
    track(sizzle, now + start + span + 0.3);
  }

  /** Stop whatever is still sounding (the scene went away). */
  dispose(): void {
    for (const s of Array.from(this.live)) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
  }
}

/**
 * Stadium mix: the swell's level, the distance (m) it is heard at full weight and the share a far one keeps,
 * the crowd body's band and low pass (Hz, the low pass falls with distance), the cheer layer's band (Hz), its
 * chatter rate (Hz), and the PA horn's level and notes (Hz).
 */
const ROAR = { level: 0.11, near: 1500, floor: 0.3, bodyHz: 650, bodyLow: 2400, cheerHz: 1500, chatterHz: 6.5, horn: 0.05, notes: [233, 311] } as const;

/**
 * The roar of a far stadium crowd (render/sky/stadium.ts calls swell() when a goal's worth of sound has crossed the
 * miles, and horn() for the odd PA blast): a body of band-passed noise that swells over a couple of seconds, surges
 * a few times and dies away, with a pitched-down, chattering cheer layer riding it, all dulled by distance and
 * panned toward the stadium. Synthesized from the hub's noise; nodes are made per swell (one every 40 s or more)
 * and released when it ends.
 */
export class StadiumRoar {
  private ctx: AudioContext;
  private bus: GainNode;
  private noise: AudioBuffer;
  private live = new Set<AudioScheduledSourceNode>();

  static create(): StadiumRoar | null {
    if (typeof window === 'undefined' || TrainRumble.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new StadiumRoar(h);
    } catch {
      return null;
    }
  }

  private constructor(h: NonNullable<ReturnType<typeof audioHub>>) {
    this.ctx = h.ctx;
    this.bus = h.ambienceBus;
    this.noise = h.noise;
  }

  private fall(distance: number): number {
    return ROAR.floor + (1 - ROAR.floor) / (1 + (distance / ROAR.near) ** 2);
  }

  /** A swell `seconds` long, power 0..1, from `distance` m away, pan -1..1. */
  swell(distance: number, power: number, pan: number, seconds: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const level = ROAR.level * power * this.fall(distance);
    const far = Math.min(1, distance / 3000);
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan)) * 0.8;
    out.connect(this.bus);
    let open = 0;
    const track = (src: AudioScheduledSourceNode, end: number) => {
      this.live.add(src);
      open++;
      src.onended = () => {
        this.live.delete(src);
        src.disconnect();
        if (--open === 0) out.disconnect();
      };
      src.stop(end);
    };
    const attack = Math.min(2.4, seconds * 0.25);
    const end = now + seconds;
    // Body: the crowd's roar, a wide band of noise.
    const body = ctx.createBufferSource();
    body.buffer = this.noise;
    body.loop = true;
    body.playbackRate.value = 0.85;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = ROAR.bodyHz;
    bp.Q.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = ROAR.bodyLow * (1 - 0.6 * far);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0, now);
    bg.gain.linearRampToValueAtTime(level * 2.2, now + attack);
    let t = now + attack;
    while (t < end - 2.5) {
      t += rnd(0.8, 1.8);
      bg.gain.setTargetAtTime(level * 2.2 * rnd(0.55, 1), t, 0.35);
    }
    bg.gain.setTargetAtTime(0, Math.max(t, end - 2.2), 0.7);
    body.connect(bp).connect(lp).connect(bg).connect(out);
    body.start(now, Math.random() * (this.noise.duration - 1));
    track(body, end + 2);
    // Cheer: the same noise pitched down, higher band, chattering as thousands of voices do.
    const cheer = ctx.createBufferSource();
    cheer.buffer = this.noise;
    cheer.loop = true;
    cheer.playbackRate.value = 0.7;
    const cb = ctx.createBiquadFilter();
    cb.type = 'bandpass';
    cb.frequency.value = ROAR.cheerHz * (1 - 0.4 * far);
    cb.Q.value = 1.1;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = ROAR.chatterHz * rnd(0.85, 1.2);
    const depth = ctx.createGain();
    depth.gain.value = level * 0.5;
    lfo.connect(depth).connect(cg.gain);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + attack * 1.3);
    env.gain.setTargetAtTime(0, Math.max(now + attack * 1.3, end - 2.6), 0.6);
    cheer.connect(cb).connect(cg).connect(env).connect(out);
    cheer.start(now, Math.random() * (this.noise.duration - 1));
    lfo.start(now);
    track(cheer, end + 2);
    track(lfo, end + 2);
  }

  /** The PA horn: two blasts of a minor third, `distance` m away. */
  horn(distance: number, pan: number): void {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const level = ROAR.horn * this.fall(distance);
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan)) * 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    const g = ctx.createGain();
    g.gain.value = 0;
    lp.connect(g).connect(out);
    out.connect(this.bus);
    for (let b = 0; b < 2; b++) {
      const t = now + b * 0.95;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.04);
      g.gain.setValueAtTime(level, t + 0.7);
      g.gain.setTargetAtTime(0, t + 0.72, 0.06);
    }
    let open = 0;
    for (const f of ROAR.notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.connect(lp);
      this.live.add(osc);
      open++;
      osc.onended = () => {
        this.live.delete(osc);
        osc.disconnect();
        if (--open === 0) {
          lp.disconnect();
          g.disconnect();
          out.disconnect();
        }
      };
      osc.start(now);
      osc.stop(now + 2.2);
    }
  }

  /** Stop whatever is still sounding (the scene went away). */
  dispose(): void {
    for (const s of Array.from(this.live)) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
  }
}
