/**
 * The workshop's sound bed: what the garage (garage/showroom.ts) sounds like around the car on the turntable.
 * Seven sources on the ambience bus, each placed in room space, quieter with the listener's distance from it
 * (half at `BED.halfDistance` m) and panned by its bearing against the camera's heading:
 *  - the ballasts' 120 Hz room tone, unplaced and very quiet;
 *  - the drum fan blowing at the dyno car, the loudest steady thing in the room, with a slow flutter;
 *  - the dying fluorescent batten's buzz, following the tube's flicker (silent while it is dark), with a starter
 *    tick as it catches;
 *  - the compressor by the front wall: an induction motor and its piston rattle while it runs, a hiss when it
 *    lets the pressure off;
 *  - the bench: an impact gun's "brrrt" (a hammer train through a band, a pneumatic hiss under it) and the
 *    ratchet's accelerating clicks;
 *  - the customer's car on the dyno: a cheap muffled engine (a harmonic wave at the firing frequency of a
 *    four-cylinder, rpm / 30 Hz, lowpassed and duller with distance), not an `EngineVoice`, since a prop does
 *    not earn a worklet; silent when the player's own car is on the dyno (`dynoRpm` -1);
 *  - the welder at the back: the arc's 60 Hz buzz and crackle, a hiss of sparks at each strike.
 * What is happening comes from `shopSchedule` (garage/shopSchedule.ts) read at the showroom's clock, the same
 * function the room can draw from, so the pull on the wall screen, the arc and the noise agree. Nothing here
 * keeps a schedule of its own; one-shots are edges (a new gun burst, a new click, a new strike) that drive a
 * gain envelope on a persistent chain, so a frame allocates nothing and no node is made after construction.
 *
 * Like the train rumble it is created only after a user gesture (`create` returns null before that), plays on the
 * ambience bus and fades out by itself: when `active` is false, or when the next frame does not renew it. The
 * oscillators keep running at zero gain until `dispose` (about a dozen, a few microseconds a quantum). Levels are
 * set in docs/audioMix.md: the bed about 12 dB under the garage engine's idle at the room's centre, the
 * one-shots peaking under it.
 */
import { audioHub } from './engineAudio';
import { TrainRumble } from './sceneVoices';
import { shopHash, shopSchedule, createShopState } from '../garage/shopSchedule';
import type { ShopState } from '../garage/shopSchedule';

/**
 * The mix. `level` scales everything at the bus. `halfDistance` is the distance (m) at which a source falls to
 * half (the fall is 1 / (1 + d / halfDistance)). Per source, the gain at the source itself before that fall:
 * `tone` the room hum, `fan` the drum fan, `batten` the tube's buzz and `tick` its starter, `motor` and `rattle`
 * the compressor's, `hiss` its release, `gun` the impact gun, `gunHiss` its air, `click` the ratchet, `dyno` the
 * customer's engine at full pull, `arc` the welder's buzz, `crackle` its sparks, `strike` the hiss of a new
 * strike. `pan` is how hard a source on one side pans (1 = fully). `deadMan` is how long (s) the bed plays
 * on without a new frame, `fade` the time constant (s) of the switch off, `ease` the rate (1/s) a source's gain
 * follows its target.
 */
const BED = {
  level: 1,
  halfDistance: 6,
  tone: 0.0085,
  fan: 0.52,
  batten: 0.25,
  tick: 0.1,
  motor: 0.215,
  rattle: 0.086,
  hiss: 0.2,
  gun: 0.25,
  gunHiss: 0.15,
  click: 1,
  dyno: 0.225,
  arc: 0.3,
  crackle: 0.5,
  strike: 0.3,
  pan: 0.85,
  deadMan: 0.35,
  fade: 0.08,
  ease: 40,
} as const;

/** Where each source sits in room space (m, x and z): the same spots the showroom builds them at. */
export const SOUND_SPOTS = {
  /** In front of the dyno car, blowing at it (the showroom's `fanAt`: DYNO.z less half the car and 1.25 m). */
  fan: { x: 8.0, z: 3.2 },
  /** The dying batten over the front corner's lockers. */
  batten: { x: -5, z: 9 },
  /** The compressor by the front wall. */
  compressor: { x: 9.3, z: 11.6 },
  /** The bench under the OPEN LATE sign. */
  bench: { x: 10.78, z: -2.75 },
  /** The customer's car on the dyno. */
  dyno: { x: 8.0, z: 6.6 },
  /** The welder by the back wall. */
  welder: { x: 2.95, z: -11.2 },
} as const;

/** The customer's engine: idle and redline rpm (the pull's 0..1 maps between them), cylinders, the lowpass (Hz) at idle and at redline. */
const CUSTOMER = { idle: 1000, redline: 7000, cylinders: 4, lowIdle: 380, lowRedline: 1900 } as const;

/** What the garage hands the bed every frame (reuse one object: the call allocates nothing). */
export interface GarageSoundState {
  /** The showroom's clock (s): the one `shopSchedule` and the batten's flicker are functions of. */
  time: number;
  /** The camera in room space: where it is (m) and the heading it faces, `atan2(forward.x, forward.z)` (rad). */
  listener: { x: number; z: number; yaw: number };
  /** The dying batten's brightness this frame, 0..1. */
  flicker: number;
  /** The customer's revs on the dyno, 0..1 of idle to redline, from the room's rev model that the shop's pedal (`shopSchedule(time).dynoPedal`) drives (the wall screen and wheels follow the same revs), or -1 when the player's own car is on the dyno and this source is silent. */
  dynoRpm: number;
  /** False silences the bed within about 0.3 s: the garage was left, or the Street presentation is on screen. */
  active: boolean;
}

type HubT = NonNullable<ReturnType<typeof audioHub>>;

/** A placed source: where it is, its panner and its distance fall as of the last frame. */
interface Spot {
  x: number;
  z: number;
  pan: StereoPannerNode;
  /** The distance fall, 0..1. */
  near: number;
  /** The distance (m) as of the last frame. */
  dist: number;
}

/** A gain that eases toward a target: the node and where it is. */
interface Layer {
  node: GainNode;
  cur: number;
}

const finite = (x: number, fallback = 0) => (Number.isFinite(x) ? x : fallback);
const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

export class GarageAmbience {
  private readonly ctx: AudioContext;
  private readonly out: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly sched: ShopState = createShopState();
  private readonly noiseBuf: AudioBuffer;
  private readonly crackleBuf: AudioBuffer;
  private disposed = false;
  /** Seconds the bed has been told it is inactive (it stops writing once it is certainly silent). */
  private idle = 0;
  /** The next frame sets every gain straight to its target (after a stretch of silence). */
  private snap = true;

  private readonly spots: { fan: Spot; batten: Spot; compressor: Spot; bench: Spot; dyno: Spot; welder: Spot };
  private readonly layers: Record<'tone' | 'fan' | 'batten' | 'motor' | 'rattle' | 'hiss' | 'gun' | 'gunHiss' | 'click' | 'dyno' | 'arc' | 'crackle', Layer>;
  /** Envelope gates driven by edges: the gun's burst, the ratchet's click, the batten's tick, the weld's strike. */
  private readonly gates: Record<'gun' | 'click' | 'tick' | 'strike', GainNode>;
  private readonly motor: OscillatorNode;
  private readonly pulse: OscillatorNode;
  private readonly gunLfo: OscillatorNode;
  private readonly dynoOsc: OscillatorNode;
  private readonly dynoSub: OscillatorNode;
  private readonly dynoLow: BiquadFilterNode;
  private readonly arcOsc: OscillatorNode;
  private lastGun = -1;
  private lastClick = -1;
  private lastStrike = -1;
  private lastFlicker = 1;

  /** True while the browser still waits for the first user gesture. */
  static blocked(): boolean {
    return TrainRumble.blocked();
  }

  /** The bed, or null before the first user gesture (the audio context does not exist yet): ask again later. */
  static create(): GarageAmbience | null {
    if (typeof window === 'undefined' || GarageAmbience.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new GarageAmbience(h);
    } catch {
      return null;
    }
  }

  private constructor(h: HubT) {
    const ctx = (this.ctx = h.ctx);
    this.out = this.track(ctx.createGain());
    this.out.gain.value = 0;
    this.out.connect(h.ambienceBus);
    this.noiseBuf = loopedNoise(ctx, 6);
    this.crackleBuf = sparseCrackle(ctx, 3);

    const S = SOUND_SPOTS;
    const spot = (p: { x: number; z: number }): Spot => {
      const pan = this.track(ctx.createStereoPanner());
      pan.connect(this.out);
      return { x: p.x, z: p.z, pan, near: 1, dist: 0 };
    };
    this.spots = { fan: spot(S.fan), batten: spot(S.batten), compressor: spot(S.compressor), bench: spot(S.bench), dyno: spot(S.dyno), welder: spot(S.welder) };
    const layer = (to: AudioNode): Layer => {
      const node = this.track(ctx.createGain());
      node.gain.value = 0;
      node.connect(to);
      return { node, cur: 0 };
    };
    const gate = (to: AudioNode, open = 0): GainNode => {
      const g = this.track(ctx.createGain());
      g.gain.value = open;
      g.connect(to);
      return g;
    };
    const noise = (rate = 1): AudioBufferSourceNode => {
      const s = this.track(ctx.createBufferSource());
      s.buffer = this.noiseBuf;
      s.loop = true;
      s.playbackRate.value = rate;
      this.sources.push(s);
      s.start(0, Math.random() * (this.noiseBuf.duration - 0.1));
      return s;
    };
    const osc = (type: OscillatorType | PeriodicWave, hz: number): OscillatorNode => {
      const o = this.track(ctx.createOscillator());
      if (type instanceof PeriodicWave) o.setPeriodicWave(type);
      else o.type = type;
      o.frequency.value = hz;
      this.sources.push(o);
      o.start();
      return o;
    };
    const filter = (type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode => {
      const f = this.track(ctx.createBiquadFilter());
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    const amp = (v: number): GainNode => {
      const g = this.track(ctx.createGain());
      g.gain.value = v;
      return g;
    };
    const wave = (amps: readonly number[]): PeriodicWave => ctx.createPeriodicWave(new Float32Array(amps.length + 1), Float32Array.from([0, ...amps]));

    const L = (this.layers = {} as GarageAmbience['layers']);
    const G = (this.gates = {} as GarageAmbience['gates']);

    // Room tone: the ballasts' 120 Hz with its next harmonics, straight to the bus (it has no place).
    L.tone = layer(this.out);
    for (const [k, a] of [[1, 1], [2, 0.5], [3, 0.3], [4, 0.14]] as const) {
      const g = amp(a);
      osc('sine', 120 * k).connect(g).connect(L.tone.node);
    }

    // The drum fan: a body of lowpassed noise and a rumble under it, its level breathing slowly.
    L.fan = layer(this.spots.fan.pan);
    const flutter = amp(1);
    flutter.connect(L.fan.node);
    noise(0.9).connect(filter('lowpass', 720, 0.5)).connect(flutter);
    noise(0.5).connect(filter('lowpass', 150, 0.8)).connect(amp(1.8)).connect(flutter);
    for (const [hz, depth] of [[0.43, 0.16], [3.7, 0.05]] as const) osc('sine', hz).connect(amp(depth)).connect(flutter.gain);

    // The batten: a sawtooth buzz through a band, and the tick of the starter catching.
    L.batten = layer(this.spots.batten.pan);
    osc(wave([1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12]), 100).connect(filter('bandpass', 420, 2.5)).connect(L.batten.node);
    G.tick = gate(this.spots.batten.pan);
    noise(1.2).connect(filter('bandpass', 2300, 1.5)).connect(G.tick);

    // The compressor: the motor's harmonic hum (its pitch rises as it spins up), the pump's rattle, the release's hiss.
    L.motor = layer(this.spots.compressor.pan);
    this.motor = osc(wave([1, 0.7, 0.45, 0.25, 0.14, 0.2, 0.08, 0.1]), 58);
    this.motor.connect(filter('lowpass', 900, 0.7)).connect(L.motor.node);
    L.rattle = layer(this.spots.compressor.pan);
    const pump = amp(0.5);
    pump.connect(L.rattle.node);
    noise(1).connect(filter('bandpass', 760, 0.9)).connect(pump);
    this.pulse = osc('sine', 29);
    this.pulse.connect(amp(0.5)).connect(pump.gain);
    L.hiss = layer(this.spots.compressor.pan);
    noise(1.3).connect(filter('highpass', 2200, 0.7)).connect(L.hiss.node);

    // The bench. The gun: a hammer train (noise chopped by a square wave near 30 Hz) through a band, an air hiss
    // under it, both behind a gate the burst opens and closes. The ratchet: two short bands, gated per click.
    G.gun = gate(this.spots.bench.pan);
    L.gun = layer(G.gun);
    const chop = amp(0.5);
    chop.connect(L.gun.node);
    noise(1.1).connect(filter('bandpass', 1500, 1.3)).connect(chop);
    this.gunLfo = osc('square', 30);
    this.gunLfo.connect(amp(0.5)).connect(chop.gain);
    L.gunHiss = layer(G.gun);
    noise(1.4).connect(filter('highpass', 2800, 0.7)).connect(L.gunHiss.node);
    G.click = gate(this.spots.bench.pan);
    L.click = layer(G.click);
    noise(1.6).connect(filter('bandpass', 3400, 4)).connect(L.click.node);
    noise(0.7).connect(filter('bandpass', 1100, 3)).connect(amp(0.6)).connect(L.click.node);

    // The customer's car: a harmonic wave at the firing frequency and one at half of it (the exhaust's
    // alternate pulses), through a low pass that opens with the revs, an intake breath of noise beside it.
    L.dyno = layer(this.spots.dyno.pan);
    this.dynoLow = filter('lowpass', CUSTOMER.lowIdle, 0.8);
    this.dynoLow.connect(L.dyno.node);
    const engineWave = wave([1, 0.85, 0.7, 0.55, 0.45, 0.36, 0.28, 0.22, 0.17, 0.13, 0.1, 0.08]);
    this.dynoOsc = osc(engineWave, 60);
    this.dynoOsc.connect(this.dynoLow);
    this.dynoSub = osc(engineWave, 30);
    this.dynoSub.connect(amp(0.5)).connect(this.dynoLow);
    noise(1).connect(filter('bandpass', 600, 0.8)).connect(amp(0.18)).connect(this.dynoLow);

    // The welder: the 60 Hz buzz, a bed of sparks (sparse impulses), and the hiss of each new strike.
    L.arc = layer(this.spots.welder.pan);
    this.arcOsc = osc(wave([1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.3, 0.25]), 60);
    this.arcOsc.connect(filter('bandpass', 1500, 0.9)).connect(L.arc.node);
    L.crackle = layer(this.spots.welder.pan);
    const sparks = this.track(ctx.createBufferSource());
    sparks.buffer = this.crackleBuf;
    sparks.loop = true;
    this.sources.push(sparks);
    sparks.start(0, Math.random() * (this.crackleBuf.duration - 0.1));
    sparks.connect(filter('bandpass', 3000, 0.7)).connect(L.crackle.node);
    G.strike = gate(this.spots.welder.pan);
    noise(1.5).connect(filter('bandpass', 4200, 0.8)).connect(G.strike);
  }

  private track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Ease a layer toward a target (the gain is never written non-finite, which a browser would throw on). */
  private ease(l: Layer, target: number, dt: number, rate: number): void {
    const t = finite(target);
    l.cur = this.snap ? t : l.cur + (t - l.cur) * (1 - Math.exp(-rate * dt));
    l.node.gain.value = l.cur;
  }

  /** Where a spot is against the listener: its distance fall and its pan. */
  private place(s: Spot, lx: number, lz: number, cos: number, sin: number): void {
    const dx = s.x - lx;
    const dz = s.z - lz;
    const d = Math.hypot(dx, dz);
    s.dist = d;
    s.near = 1 / (1 + d / BED.halfDistance);
    // The right of a listener heading `yaw` (forward (sin, cos)) is (-cos, sin); a source on top of the listener has no side.
    const side = d > 1e-3 ? (-dx * cos + dz * sin) / d : 0;
    s.pan.pan.value = finite(side * (d / (d + 1)) * BED.pan);
  }

  /** One frame: `dt` s since the last, and what the room is doing (see `GarageSoundState`). */
  update(dt: number, state: GarageSoundState): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    dt = Math.min(0.25, Math.max(0, finite(dt)));
    const g = this.out.gain;
    if (!state.active) {
      // Off: close the bed, and once it certainly is silent stop touching the graph until it is wanted again.
      if (this.idle < 1) {
        g.cancelScheduledValues(now);
        g.setTargetAtTime(0, now, BED.fade);
      }
      this.idle += dt;
      this.snap = true;
      return;
    }
    this.idle = 0;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(BED.level, now, 0.1);
    // Dead man's switch: silence unless the next frame renews it.
    g.setTargetAtTime(0, now + BED.deadMan, 0.12);

    const sc = shopSchedule(finite(state.time), this.sched);
    const lx = finite(state.listener.x);
    const lz = finite(state.listener.z);
    const yaw = finite(state.listener.yaw);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const sp = this.spots;
    this.place(sp.fan, lx, lz, cos, sin);
    this.place(sp.batten, lx, lz, cos, sin);
    this.place(sp.compressor, lx, lz, cos, sin);
    this.place(sp.bench, lx, lz, cos, sin);
    this.place(sp.dyno, lx, lz, cos, sin);
    this.place(sp.welder, lx, lz, cos, sin);
    const L = this.layers;
    const E = BED.ease;

    this.ease(L.tone, BED.tone, dt, E);
    this.ease(L.fan, BED.fan * clamp01(sc.fan) * sp.fan.near, dt, E);

    const flicker = clamp01(finite(state.flicker, 1));
    this.ease(L.batten, BED.batten * flicker * flicker * sp.batten.near, dt, 120);
    // The starter's tick as the tube catches or drops: a quick bright click on a big step.
    if (Math.abs(flicker - this.lastFlicker) > 0.5) this.hit(this.gates.tick, BED.tick * sp.batten.near, 0.003, 0.012);
    this.lastFlicker = flicker;

    const comp = clamp01(sc.compressor);
    this.ease(L.motor, BED.motor * comp * sp.compressor.near, dt, E);
    this.ease(L.rattle, BED.rattle * comp * comp * sp.compressor.near, dt, E);
    this.ease(L.hiss, BED.hiss * clamp01(sc.release) ** 2 * sp.compressor.near, dt, 60);
    this.motor.frequency.value = 58 * (0.45 + 0.55 * comp);
    this.pulse.frequency.value = 29 * (0.45 + 0.55 * comp);

    // The gun: a burst opens the gate, its end closes it; each burst has its own hammer rate (24 to 38 Hz).
    const bn = sp.bench.near;
    this.ease(L.gun, BED.gun * bn, dt, E);
    this.ease(L.gunHiss, BED.gunHiss * bn, dt, E);
    if (sc.gun !== this.lastGun) {
      const gate = this.gates.gun.gain;
      gate.cancelScheduledValues(now);
      if (sc.gun >= 0) {
        this.gunLfo.frequency.value = 24 + 14 * shopHash(sc.gun, 61);
        gate.setTargetAtTime(1, now, 0.005);
      } else {
        gate.setTargetAtTime(0, now, 0.012);
      }
      this.lastGun = sc.gun;
    }
    // The ratchet: each click is an edge (the series' ordinal and the click's index make a unique id).
    this.ease(L.click, BED.click * bn, dt, E);
    const click = sc.ratchet >= 0 ? sc.ratchet * 16 + sc.ratchetClick : -1;
    if (click !== this.lastClick) {
      if (click >= 0) this.hit(this.gates.click, 0.6 + 0.4 * shopHash(click, 62), 0.0008, 0.005);
      this.lastClick = click;
    }

    // The customer's pull: silent when the player's car is on the dyno or the car is between pulls.
    const pull = state.dynoRpm < 0 ? 0 : clamp01(finite(state.dynoRpm));
    const rpm = CUSTOMER.idle + (CUSTOMER.redline - CUSTOMER.idle) * pull;
    const firing = rpm / (60 / (CUSTOMER.cylinders / 2));
    this.dynoOsc.frequency.value = firing;
    this.dynoSub.frequency.value = firing / 2;
    const dull = 1 / (1 + sp.dyno.dist / 12);
    this.dynoLow.frequency.value = (CUSTOMER.lowIdle + (CUSTOMER.lowRedline - CUSTOMER.lowIdle) * pull) * (0.35 + 0.65 * dull);
    const open = pull <= 0 ? 0 : Math.min(1, pull / 0.06);
    this.ease(L.dyno, BED.dyno * open * (0.3 + 0.7 * pull) * sp.dyno.near, dt, E);

    // The welder: the arc's buzz and sparks while it burns, and a hiss as each strike is made.
    const arc = clamp01(sc.weld);
    const wn = sp.welder.near;
    this.ease(L.arc, BED.arc * arc * wn, dt, 150);
    this.ease(L.crackle, BED.crackle * arc * wn, dt, 150);
    if (sc.weldStrike !== this.lastStrike) {
      if (sc.weldStrike >= 0) this.hit(this.gates.strike, BED.strike * wn, 0.002, 0.07);
      this.lastStrike = sc.weldStrike;
    }
    this.snap = false;
  }

  /** A one-shot on a gate: up to `level` in `attack` s, falling with time constant `decay` s. */
  private hit(gate: GainNode, level: number, attack: number, decay: number): void {
    const now = this.ctx.currentTime;
    const p = gate.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(0, now);
    p.linearRampToValueAtTime(finite(level), now + attack);
    p.setTargetAtTime(0, now + attack, decay);
  }

  /** Stop every source and let go of every node (the garage was left). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const n of this.nodes) n.disconnect();
  }
}

/** A mono buffer of `seconds` of white noise that loops without a seam (the end is cross faded into the start, equal power). */
function loopedNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const fade = Math.round(ctx.sampleRate * 0.25);
  const raw = new Float32Array(n + fade);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  d.set(raw.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    d[i] = raw[i] * Math.sqrt(w) + raw[n + i] * Math.sqrt(1 - w);
  }
  return buf;
}

/** A mono buffer of sparse, sharp impulses with a 2 ms tail, about 90 a second at random strengths: sparks and crackle. */
function sparseCrackle(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const tail = Math.round(ctx.sampleRate * 0.002);
  for (let i = 0; i < n; i++) {
    if (Math.random() > 90 / ctx.sampleRate) continue;
    const a = (Math.random() * 2 - 1) * (0.3 + 0.7 * Math.random());
    for (let k = 0; k < tail && i + k < n; k++) d[i + k] += a * (1 - k / tail);
  }
  return buf;
}
