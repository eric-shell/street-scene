/**
 * Standalone voices a scene owns rather than the race: the elevated train's
 * rumble, the news helicopter's rotors and the thunder of rain nights. Each
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
