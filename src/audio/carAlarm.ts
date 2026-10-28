/**
 * Car alarms: a struck parked car sets its alarm off. Synthesized, three seeded patterns, built on the siren
 * module's horn (`SIREN.horn` formants, its echo taps) so it is the same hard, nasal electronic voice:
 *  - classic: a six-note cycle (the note table `ALARM.classic.notes`, ratios of a seeded base), a pause, again;
 *  - wail: two tones with a glide between them, held half a second each;
 *  - chirp: two short chirps, then one rising wail, a pause.
 * The tone is an odd-harmonic wave (a square with a roll-off) through a mild clipper, the horn's formants, and a
 * gate that carries the pattern's on and off. The pitch and the gate are written as value curves from the alarm's
 * age, so a voice evicted for the three-voice cap or interrupted by a pause rejoins at the right place in its
 * pattern. No doppler (a parked car's alarm is not a flyby; the car slides when it is knocked about, and the
 * position follows it): the level and pan come from the car's live position every frame, with the high formant
 * falling and the echo growing with distance. The echo is a street's: two longer taps and enough feedback to
 * ring a couple of seconds after the alarm stops.
 *
 * `CarAlarms` is the manager. Every frame it reads the traffic state: a parked car (`home >= 0`) that is `loose`
 * has been struck, and its alarm starts `ALARM.delay` after the tick it was first seen so, runs `ALARM.len`
 * seconds (seeded 20 to 40), and stops when the car is recycled (it chirps off twice) or the time is up. The
 * pattern, length and pitch are drawn from `deriveSeed(world.seed, alarm:id:tick)` in a fixed order, and the
 * clock is the sim's tick, so a replay sounds the same. At most `ALARM.voices` sound at once, the nearest win.
 * Effects bus; render side only. The level is set against the city bed's siren pass (docs/audioMix.md).
 */
import type { RaceState } from '../sim/race';
import { TICK_HZ } from '../sim/constants';
import { Rng, deriveSeed } from '../sim/prng';
import { clamp, clamp01, lerp } from '../sim/math';
import { audioHub } from './engineAudio';
import { SIREN } from './siren';
import type { Listener } from './carHorn';

/** The alarms' constants. */
export const ALARM = {
  /** Seconds after the strike before the alarm starts, and how long it runs (s, seeded). */
  delay: 0.3,
  len: [20, 40],
  /** Voices at once; the nearest win. A playing voice counts this much closer, so two alarms at similar range do not swap. */
  voices: 3,
  hold: 0.8,
  /** Curve grid (Hz). */
  rate: 100,
  /** Level at the car, the distance (m) it falls to half at, and the range beyond which it is silent (m). */
  level: 0.07,
  near: 22,
  range: 220,
  /** How fast level and pan follow the car (s). */
  follow: 0.08,
  /** The base pitch (Hz, seeded) the patterns are built on, and a cycle's stretch. */
  base: [1000, 1250],
  stretch: [0.92, 1.08],
  /** The tone: harmonics, roll-off and the clipper's drive (tanh) before the horn. */
  tone: { partials: 11, rolloff: 0.8, drive: 2.2 },
  /** Air: the high formant's gain (dB) at the car and beyond `range / 2`. */
  air: { nearDb: 3, farDb: -6 },
  /** Echo: taps (s), feedback per tap, low pass (Hz), wet near and far, and the seconds the graph outlives the voice. */
  echo: { taps: [0.143, 0.197], feedback: 0.36, lp: 2200, near: 0.12, far: 0.3, tail: 3 },
  /** Classic: the six notes (ratios of the base), a note's length (s) and the pause after the cycle (s). */
  classic: { notes: [1, 1.32, 0.9, 1.5, 1.12, 1.75], note: 0.17, rest: 0.4 },
  /** Wail: the low and high tone (ratios), the hold (s) and the glide between (s). */
  wail: { lo: 0.68, hi: 1.05, hold: 0.5, glide: 0.12 },
  /** Chirp: the chirp pitch (ratio), its length and period (s), where the wail starts (s), its length (s), its range (ratios) and the cycle (s). */
  chirp: { hz: 1.7, len: 0.09, gap: 0.18, wailAt: 0.5, wailLen: 1.5, lo: 0.8, hi: 1.5, cycle: 2.6 },
  /** The chirp off: two beeps (Hz, length, gap in s). */
  off: { hz: 1900, len: 0.07, gap: 0.12 },
} as const;

/** The three patterns. */
export const ALARM_PATTERNS = ['classic', 'wail', 'chirp'] as const;
export type AlarmPattern = (typeof ALARM_PATTERNS)[number];

/** The pattern's pitch (Hz) and gate (0..1) at `t` seconds into the alarm, for a base pitch and a cycle stretch. */
export function alarmAt(pattern: AlarmPattern, t: number, base: number, stretch: number): { hz: number; gate: number } {
  const A = ALARM;
  const u = t / stretch;
  if (pattern === 'classic') {
    const c = A.classic;
    const cycle = c.notes.length * c.note + c.rest;
    const p = u % cycle;
    const n = Math.floor(p / c.note);
    if (n >= c.notes.length) return { hz: base, gate: 0 };
    return { hz: base * c.notes[n], gate: p - n * c.note < c.note * 0.88 ? 1 : 0 };
  }
  if (pattern === 'wail') {
    const w = A.wail;
    const step = w.hold + w.glide;
    const p = u % (2 * step);
    const at = (a: number, b: number, k: number): number => lerp(a, b, k * k * (3 - 2 * k));
    const hz = p < w.hold ? w.lo : p < step ? at(w.lo, w.hi, (p - w.hold) / w.glide) : p < step + w.hold ? w.hi : at(w.hi, w.lo, (p - step - w.hold) / w.glide);
    return { hz: base * hz, gate: 1 };
  }
  const k = A.chirp;
  const p = u % k.cycle;
  if (p < k.len) return { hz: base * k.hz, gate: 1 };
  if (p >= k.gap && p < k.gap + k.len) return { hz: base * k.hz, gate: 1 };
  if (p >= k.wailAt && p < k.wailAt + k.wailLen) {
    const x = (p - k.wailAt) / k.wailLen;
    return { hz: base * k.lo * Math.exp(Math.log(k.hi / k.lo) * x), gate: 1 };
  }
  return { hz: base, gate: 0 };
}

/** A sound's curves on the `ALARM.rate` grid, from `from` seconds into the pattern for `len` seconds. */
export function alarmCurves(pattern: AlarmPattern, base: number, stretch: number, from: number, len: number): { freq: Float32Array<ArrayBuffer>; gate: Float32Array<ArrayBuffer> } {
  const n = Math.max(2, Math.round(len * ALARM.rate) + 1);
  const freq = new Float32Array(n);
  const gate = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = alarmAt(pattern, from + i / ALARM.rate, base, stretch);
    freq[i] = a.hz;
    gate[i] = a.gate;
  }
  return { freq, gate };
}

/** What an alarm was drawn as. */
export interface AlarmPlan {
  pattern: AlarmPattern;
  /** Seconds the alarm runs. */
  len: number;
  base: number;
  stretch: number;
}

/** Draw an alarm from `rng`, in a fixed order. */
export function planAlarm(rng: Rng): AlarmPlan {
  return {
    pattern: ALARM_PATTERNS[rng.int(0, ALARM_PATTERNS.length - 1)],
    len: rng.range(ALARM.len[0], ALARM.len[1]),
    base: rng.range(ALARM.base[0], ALARM.base[1]),
    stretch: rng.range(ALARM.stretch[0], ALARM.stretch[1]),
  };
}

/** The context's shared tone wave and clipper (one set per context). */
interface Kit {
  wave: PeriodicWave;
  clip: Float32Array<ArrayBuffer>;
}
const kits = new WeakMap<BaseAudioContext, Kit>();

function kitFor(ctx: BaseAudioContext): Kit {
  let kit = kits.get(ctx);
  if (kit) return kit;
  const { partials, rolloff, drive } = ALARM.tone;
  const re = new Float32Array(partials + 1);
  const im = new Float32Array(partials + 1);
  for (let n = 1; n <= partials; n += 2) im[n] = 1 / n ** rolloff;
  const clip = new Float32Array(1025);
  for (let i = 0; i < clip.length; i++) clip[i] = Math.tanh(drive * ((i / (clip.length - 1)) * 2 - 1));
  kit = { wave: ctx.createPeriodicWave(re, im), clip };
  kits.set(ctx, kit);
  return kit;
}

/** Gain, high formant (dB), echo wet and pan of a ground position seen from the listener. */
export function alarmPlace(x: number, z: number, l: Listener): { gain: number; airDb: number; wet: number; pan: number } {
  const dx = x - l.x;
  const dz = z - l.z;
  const d = Math.hypot(dx, dz);
  const far = clamp01(d / (ALARM.range * 0.5));
  return {
    gain: (1 / (1 + (d / ALARM.near) ** 2)) * (1 - clamp01((d - ALARM.range * 0.6) / (ALARM.range * 0.4))),
    airDb: lerp(ALARM.air.nearDb, ALARM.air.farDb, far),
    wet: lerp(ALARM.echo.near, ALARM.echo.far, far),
    pan: clamp(((dx * l.rx + dz * l.rz) / Math.max(1, d)) * 0.9, -1, 1),
  };
}

/** One sounding alarm: a graph from the tone to the bus, steered every frame. */
export class AlarmVoice {
  /** True once the tone has ended (the pattern ran out or it was stopped). */
  done = false;
  private readonly osc: OscillatorNode;
  private readonly level: GainNode;
  private readonly high: BiquadFilterNode;
  private readonly wet: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly gate: GainNode;
  private readonly nodes: AudioNode[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start a voice now at `age` seconds into its pattern for `left` seconds more. `place` sets where it begins so it
   * does not sweep in from nowhere.
   */
  constructor(private readonly ctx: BaseAudioContext, out: AudioNode, plan: AlarmPlan, age: number, left: number, place: ReturnType<typeof alarmPlace>) {
    const kit = kitFor(ctx);
    const t0 = ctx.currentTime + 0.01;
    const curves = alarmCurves(plan.pattern, plan.base, plan.stretch, age, left);
    const biquad = (type: BiquadFilterType, hz: number, q: number, gainDb = 0): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = hz;
      b.Q.value = q;
      b.gain.value = gainDb;
      return b;
    };
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(kit.wave);
    this.osc.frequency.setValueCurveAtTime(curves.freq, t0, left);
    const clipper = ctx.createWaveShaper();
    clipper.curve = kit.clip;
    clipper.oversample = '2x';
    this.gate = ctx.createGain();
    this.gate.gain.value = 0;
    this.gate.gain.setValueCurveAtTime(curves.gate, t0, left);
    const H = SIREN.horn;
    const low = biquad('peaking', H.low.hz, H.low.q, H.low.db);
    this.high = biquad('peaking', H.high.hz, H.high.q, place.airDb);
    this.level = ctx.createGain();
    this.level.gain.value = 0;
    this.level.gain.setTargetAtTime(ALARM.level * place.gain, ctx.currentTime, 0.02);
    this.panner = ctx.createStereoPanner();
    this.panner.pan.value = place.pan;
    this.osc.connect(clipper).connect(this.gate).connect(biquad('highpass', H.hp, 0.7)).connect(low).connect(this.high).connect(biquad('lowpass', H.lp, 0.7)).connect(this.level);
    this.level.connect(this.panner).connect(out);

    // The echo: two long taps of a feedback delay, dulled, mixed by distance; it rings after the tone ends.
    const d1 = ctx.createDelay(0.5);
    const d2 = ctx.createDelay(0.5);
    d1.delayTime.value = ALARM.echo.taps[0];
    d2.delayTime.value = ALARM.echo.taps[1];
    const dull = biquad('lowpass', ALARM.echo.lp, 0.5);
    const feedback = ctx.createGain();
    feedback.gain.value = ALARM.echo.feedback;
    this.wet = ctx.createGain();
    this.wet.gain.value = place.wet;
    this.level.connect(d1).connect(dull);
    this.level.connect(d2).connect(dull);
    dull.connect(this.wet).connect(this.panner);
    dull.connect(feedback);
    feedback.connect(d1);
    feedback.connect(d2);
    this.nodes.push(this.osc, this.gate, this.level, this.panner, this.wet, d1, d2, dull, feedback);

    this.osc.onended = () => {
      this.done = true;
      this.osc.disconnect();
      this.timer = setTimeout(() => this.free(), ALARM.echo.tail * 1000);
    };
    this.osc.start(t0);
    this.osc.stop(t0 + left + 0.05);
  }

  /** Steer to where the car is now (or silence for a pause: `mute`). */
  update(place: ReturnType<typeof alarmPlace>, mute: boolean): void {
    if (this.done) return;
    const now = this.ctx.currentTime;
    this.level.gain.setTargetAtTime(mute ? 0 : ALARM.level * place.gain, now, ALARM.follow);
    this.panner.pan.setTargetAtTime(place.pan, now, ALARM.follow);
    this.high.gain.setTargetAtTime(place.airDb, now, ALARM.follow);
    this.wet.gain.setTargetAtTime(place.wet, now, ALARM.follow);
  }

  /** End the voice: fade it out, or (`chirp`) chirp twice as a locked car does. The echo rings on, then the graph is freed. */
  stop(chirp: boolean): void {
    if (this.done) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.done = true;
    this.gate.gain.cancelScheduledValues(now);
    this.gate.gain.setTargetAtTime(0, now, chirp ? 0.004 : 0.04);
    this.osc.frequency.cancelScheduledValues(now);
    let end = now + 0.2;
    if (chirp) {
      const o = ALARM.off;
      this.osc.frequency.setValueAtTime(o.hz, now + 0.03);
      for (let i = 0; i < 2; i++) {
        const at = now + 0.03 + i * (o.len + o.gap);
        this.gate.gain.setTargetAtTime(1, at, 0.004);
        this.gate.gain.setTargetAtTime(0, at + o.len, 0.004);
      }
      end = now + 0.1 + 2 * (o.len + o.gap);
    }
    this.osc.onended = () => {
      this.osc.disconnect();
      this.timer = setTimeout(() => this.free(), ALARM.echo.tail * 1000);
    };
    this.osc.stop(end);
  }

  /** Disconnect everything now. */
  free(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.done = true;
    for (const n of this.nodes) n.disconnect();
  }
}

/** A struck car's alarm as the manager keeps it. */
interface AlarmRecord {
  /** Tick the car was first seen struck. */
  since: number;
  plan: AlarmPlan;
  voice: AlarmVoice | null;
  /** Ended for good: the time ran out or the car was recycled. */
  over: boolean;
}

/** Keeps the alarms of the struck parked cars. */
export class CarAlarms {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly records = new Map<number, AlarmRecord>();
  private lastTick = 0;
  private disposed = false;

  /** Throws if Web Audio is unavailable; check audioHub() first. */
  constructor() {
    const h = audioHub()!;
    this.ctx = h.ctx;
    this.bus = h.effectsBus;
  }

  /** Every frame, from the current sim state and the camera. */
  update(race: RaceState, listener: Listener, paused: boolean): void {
    const t = race.traffic;
    if (!t || this.disposed) return;
    if (race.tick < this.lastTick) this.clear();
    this.lastTick = race.tick;
    // Newly struck parked cars get a record; the ones no longer loose are over.
    const struck = new Set<number>();
    for (const id of t.unparked) {
      const c = t.cars[id];
      if (c.home < 0 || c.mode !== 'loose') continue;
      struck.add(id);
      if (!this.records.has(id)) {
        const rng = new Rng(deriveSeed(race.world.seed, `alarm:${id}:${race.tick}`));
        this.records.set(id, { since: race.tick, plan: planAlarm(rng), voice: null, over: false });
      }
    }
    // The audible ones, nearest first.
    const live: { id: number; d: number; rec: AlarmRecord }[] = [];
    for (const [id, rec] of this.records) {
      const age = (race.tick - rec.since) / TICK_HZ - ALARM.delay;
      if (rec.over || !struck.has(id) || age >= rec.plan.len) {
        if (!rec.over) {
          rec.over = true;
          rec.voice?.stop(true);
        }
        if (!struck.has(id) && (!rec.voice || rec.voice.done)) this.records.delete(id);
        continue;
      }
      if (age < 0) continue;
      const b = t.cars[id].body;
      const d = Math.hypot(b.x - listener.x, b.z - listener.z);
      if (d > ALARM.range) continue;
      live.push({ id, d: rec.voice && !rec.voice.done ? d * ALARM.hold : d, rec });
    }
    live.sort((a, b) => a.d - b.d || a.id - b.id);
    for (let i = 0; i < live.length; i++) {
      const { id, rec } = live[i];
      const b = t.cars[id].body;
      const place = alarmPlace(b.x, b.z, listener);
      if (i >= ALARM.voices) {
        if (rec.voice && !rec.voice.done) rec.voice.stop(false);
        rec.voice = null;
        continue;
      }
      if (rec.voice?.done) rec.voice = null;
      if (!rec.voice) {
        const age = (race.tick - rec.since) / TICK_HZ - ALARM.delay;
        rec.voice = new AlarmVoice(this.ctx, this.bus, rec.plan, age, Math.max(0.2, rec.plan.len - age), place);
      }
      rec.voice.update(place, paused);
    }
    // Voices of records that dropped out of range.
    for (const [id, rec] of this.records) if (rec.voice && !live.some((l) => l.id === id) && !rec.over) {
      rec.voice.stop(false);
      rec.voice = null;
    }
  }

  private clear(): void {
    for (const rec of this.records.values()) rec.voice?.free();
    this.records.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }
}
