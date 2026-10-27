/**
 * The city's ambience bed: what the night sounds like away from the stands.
 * Three layers on the ambience bus, all synthesized from the hub's noise and
 * a few oscillators (no samples):
 *  - a hum: low filtered noise (the traffic and ventilation of a city that
 *    never quite sleeps) with a faint mains rumble underneath, its colour set
 *    by the seed's mood (misty is muffled, rain adds a wet hiss);
 *  - wind on the hazy and misty nights, rising with the listener's height
 *    (the hills, the expressway deck);
 *  - sparse distant one-shots: a far American siren going by (`siren.ts`), a car horn, a dog,
 *    a bottle, a shutter rattle, a train horn on seeds with an El, gulls on
 *    waterfront and lake seeds. Each comes from a random bearing (stereo pan)
 *    through a low pass that dulls with distance.
 * The one-shots are scheduled on the scene clock from seeded Rng streams, so
 * a replay (same seed, same clock) hears the same night. When the night turns (render/sky/weatherTimeline.ts)
 * the hum, hiss and wind follow the blend, and gusts lift the wind. The bed ducks a
 * little under the engine at full throttle. Like the other scene voices it is
 * only created after a user gesture and its gain dies by itself unless the
 * next frame renews it. The level is set in docs/audioMix.md.
 */
import { audioHub } from './engineAudio';
import { TrainRumble } from './sceneVoices';
import { playSiren } from './siren';
import { Rng, deriveSeed } from '../sim/prng';
import { clamp01, lerp } from '../sim/math';
import type { LiveWeather, MoodId } from '../render/sky/weather';
import type { Area } from '../city/districts/types';

/** What a seed's city offers the bed. */
export interface AmbienceTraits {
  seed: number;
  mood: MoodId;
  /** The mood the night turns to (the weather timeline's), when it does: the bed builds the layers either mood needs. */
  turnsTo?: MoodId;
  /** An elevated railway (the 'subway' district): a far train horn. */
  el: boolean;
  /** A harbor or a lake: gulls. */
  water: boolean;
}

/** The traits of a built city: its seed, its mood and which districts it has. */
export function ambienceTraits(seed: number, mood: MoodId, areas: readonly Area[], turnsTo?: MoodId): AmbienceTraits {
  return { seed, mood, turnsTo, el: areas.some((a) => a.kind === 'subway'), water: areas.some((a) => a.kind === 'waterfront' || a.kind === 'lake') };
}

/**
 * Per mood: the hum's low pass (Hz) and level, the wet hiss's level and band (Hz), the wind's level (0 = none),
 * and how much rarer the street one-shots are (rain keeps people and dogs indoors).
 */
const MOOD_BED: Record<MoodId, { humHz: number; hum: number; hiss: number; hissHz: number; wind: number; rare: number }> = {
  clear: { humHz: 420, hum: 1, hiss: 0, hissHz: 4000, wind: 0, rare: 1 },
  hazy: { humHz: 380, hum: 1, hiss: 0.06, hissHz: 3500, wind: 0.55, rare: 1 },
  misty: { humHz: 230, hum: 0.8, hiss: 0.04, hissHz: 2600, wind: 1, rare: 1.3 },
  drizzle: { humHz: 480, hum: 0.9, hiss: 0.5, hissHz: 4500, wind: 0, rare: 1.6 },
  rain: { humHz: 600, hum: 0.85, hiss: 1, hissHz: 5000, wind: 0, rare: 2 },
};

/**
 * The bed's mix. `level` scales the bed (hum, hiss, wind) at the bus, `rumble` the mains tone against the hum,
 * `shots` the one-shots. Wind rises from `windFrom` to `windTo` metres of height and gusts around `windHz`.
 * `duck` is how far the bed and the one-shots fall at full throttle, `duckRate` the time constant (s) of that,
 * `deadMan` how long (s) the bed plays on without a new frame.
 */
const BED = {
  level: 0.9,
  rumble: 0.02,
  shots: 1,
  windFrom: 4,
  windTo: 40,
  windHz: 520,
  duck: 0.3,
  duckRate: 0.4,
  deadMan: 0.5,
} as const;

/** Seconds between one-shots of each kind (min, max), and the closest and furthest they sound (m). */
const SHOT_GAPS = {
  siren: { min: 40, max: 120, near: 160, far: 420 },
  horn: { min: 14, max: 40, near: 70, far: 320 },
  dog: { min: 25, max: 70, near: 60, far: 280 },
  bottle: { min: 30, max: 90, near: 40, far: 200 },
  shutter: { min: 35, max: 100, near: 40, far: 200 },
  trainHorn: { min: 60, max: 140, near: 240, far: 600 },
  gull: { min: 12, max: 35, near: 80, far: 360 },
} as const;
type ShotKind = keyof typeof SHOT_GAPS;
const SHOT_KINDS = Object.keys(SHOT_GAPS) as ShotKind[];
/** Street sounds that rain and mist make rarer. */
const STREET: ReadonlySet<ShotKind> = new Set(['horn', 'dog', 'bottle', 'shutter', 'gull']);
/** Each kind's own level at its nearest distance (before the bed's `shots`). */
const SHOT_LEVEL: Record<ShotKind, number> = { siren: 0.5, horn: 0.5, dog: 0.7, bottle: 0.6, shutter: 0.8, trainHorn: 0.6, gull: 0.5 };

type HubT = NonNullable<ReturnType<typeof audioHub>>;

export class CityAmbience {
  private readonly ctx: AudioContext;
  private readonly hub: HubT;
  /** The bed's output (hum, hiss, wind) before the ducking stage. */
  readonly out: GainNode;
  private readonly master: GainNode;
  private readonly wind: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly live = new Set<AudioScheduledSourceNode>();
  private readonly kinds: ShotKind[];
  private readonly rng = {} as Record<ShotKind, Rng>;
  private readonly nextAt = {} as Record<ShotKind, number>;
  private readonly bed: (typeof MOOD_BED)[MoodId];
  /** The bed of the mood the night turns to (the opening bed when it never does). */
  private readonly bedTo: (typeof MOOD_BED)[MoodId];
  private hum!: GainNode;
  private humLow!: BiquadFilterNode;
  private humHigh!: BiquadFilterNode;
  private hiss: GainNode | null = null;
  private hissBand: BiquadFilterNode | null = null;
  /** The turn last pushed to the hum and hiss (-1: none yet). */
  private pushedTurn = -1;
  private lastTime = -1;
  private duck = 0;

  static create(traits: AmbienceTraits): CityAmbience | null {
    if (typeof window === 'undefined' || TrainRumble.blocked()) return null;
    const h = audioHub();
    if (!h) return null;
    try {
      return new CityAmbience(h, traits);
    } catch {
      return null;
    }
  }

  private constructor(h: HubT, traits: AmbienceTraits) {
    this.hub = h;
    const ctx = (this.ctx = h.ctx);
    this.bed = MOOD_BED[traits.mood];
    this.bedTo = MOOD_BED[traits.turnsTo ?? traits.mood];
    this.kinds = SHOT_KINDS.filter((k) => (k !== 'trainHorn' || traits.el) && (k !== 'gull' || traits.water));
    for (const k of SHOT_KINDS) this.rng[k] = new Rng(deriveSeed(traits.seed, `ambience:${k}`));
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(h.ambienceBus);
    this.out = ctx.createGain();
    this.out.gain.value = BED.level;
    this.out.connect(this.master);
    const filter = (type: BiquadFilterType, hz: number, q: number): BiquadFilterNode => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = hz;
      f.Q.value = q;
      return f;
    };
    /** Looping hub noise at `rate` through a filter; returns the filter. */
    const noise = (type: BiquadFilterType, hz: number, q: number, rate = 1): BiquadFilterNode => {
      const src = ctx.createBufferSource();
      src.buffer = h.noise;
      src.loop = true;
      src.playbackRate.value = rate;
      src.start(0, Math.random() * h.noise.duration);
      this.sources.push(src);
      const f = filter(type, hz, q);
      src.connect(f);
      return f;
    };
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const o = ctx.createOscillator();
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = depth;
      o.connect(g).connect(target);
      o.start();
      this.sources.push(o);
    };
    // Hum: slow noise through two low passes, breathing a little.
    const hum = ctx.createGain();
    hum.gain.value = this.bed.hum * 0.35;
    this.hum = hum;
    this.humLow = noise('lowpass', this.bed.humHz, 0.7, 0.8);
    this.humHigh = filter('lowpass', this.bed.humHz * 1.6, 0.5);
    this.humLow.connect(this.humHigh).connect(hum);
    lfo(0.07, hum.gain.value * 0.15, hum.gain);
    hum.connect(this.out);
    // Mains rumble: 50 or 60 Hz by seed, with its second harmonic, faint.
    const mains = traits.seed & 1 ? 60 : 50;
    const rumble = ctx.createGain();
    rumble.gain.value = BED.rumble;
    for (const [mult, amp] of [[1, 1], [2, 0.4]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = mains * mult;
      const g = ctx.createGain();
      g.gain.value = amp;
      o.connect(g).connect(rumble);
      o.start();
      this.sources.push(o);
    }
    rumble.connect(this.out);
    // Wet hiss (rain on tarmac, a trace of it in the haze).
    if (this.bed.hiss > 0 || this.bedTo.hiss > 0) {
      const hiss = ctx.createGain();
      // A band this wide carries about five times the hum's amplitude, so it is trimmed to match.
      hiss.gain.value = this.bed.hiss * 0.05;
      this.hiss = hiss;
      this.hissBand = noise('bandpass', this.bed.hissHz, 0.5);
      this.hissBand.connect(hiss).connect(this.out);
    }
    // Wind: band noise gusting on slow oscillators, scaled by height every frame.
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    const gust = ctx.createGain();
    gust.gain.value = 0.45;
    const windBand = noise('bandpass', BED.windHz, 0.7, 0.9);
    windBand.connect(gust).connect(this.wind).connect(this.out);
    lfo(0.11, 0.2, gust.gain);
    lfo(0.29, 0.1, gust.gain);
    lfo(0.07, BED.windHz * 0.4, windBand.frequency);
    // The first of each kind lands a few seconds in, then on its own rhythm.
    for (const k of this.kinds) this.nextAt[k] = this.gap(k, true);
  }

  /** The next gap for `k` (s), drawn from its own stream; the first one is shorter. */
  private gap(k: ShotKind, first = false): number {
    const g = SHOT_GAPS[k];
    const r = this.rng[k];
    const rare = STREET.has(k) ? this.bed.rare : 1;
    return (first ? r.range(3, g.max * 0.6) : r.range(g.min, g.max)) * rare;
  }

  /**
   * Feed it every frame. `time` is the scene clock (s; one-shots are scheduled on it so a replay hears the same),
   * `height` the listener's height (m), `throttle` the player's pedal 0..1 (the bed ducks under the engine), `dt` seconds,
   * `weather` the live blend of the night (`turn` 0..1 between the opening mood and the one it turns to, and the current `gust`).
   */
  update(time: number, dt: number, height: number, throttle: number, weather?: Pick<LiveWeather, 'turn' | 'gust'>): void {
    const now = this.ctx.currentTime;
    this.duck += (clamp01(throttle) - this.duck) * (1 - Math.exp(-dt / BED.duckRate));
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(1 - BED.duck * this.duck, now, 0.25);
    // Dead man's switch: silence unless the next frame renews it.
    g.setTargetAtTime(0, now + BED.deadMan, 0.3);
    const turn = weather?.turn ?? 0;
    if (Math.abs(turn - this.pushedTurn) > 0.004) {
      // The hum and hiss follow the turn; a few dozen parameter ramps over the whole 40 to 90 s, not per frame.
      this.pushedTurn = turn;
      const a = this.bed;
      const b = this.bedTo;
      this.hum.gain.setTargetAtTime(lerp(a.hum, b.hum, turn) * 0.35, now, 0.6);
      this.humLow.frequency.setTargetAtTime(lerp(a.humHz, b.humHz, turn), now, 0.6);
      this.humHigh.frequency.setTargetAtTime(lerp(a.humHz, b.humHz, turn) * 1.6, now, 0.6);
      this.hiss?.gain.setTargetAtTime(lerp(a.hiss, b.hiss, turn) * 0.05, now, 0.6);
      this.hissBand?.frequency.setTargetAtTime(lerp(a.hissHz, b.hissHz, turn), now, 0.6);
    }
    const w = lerp(this.bed.wind, this.bedTo.wind, turn) * (weather?.gust ?? 1) * clamp01((height - BED.windFrom) / (BED.windTo - BED.windFrom));
    this.wind.gain.setTargetAtTime(w * (0.25 + 0.75 * w), now, 0.6);
    // A clock that went backwards (a restart) or leapt (a long stall) reschedules instead of firing a backlog.
    if (this.lastTime >= 0 && (time < this.lastTime - 0.5 || time > this.lastTime + 5)) for (const k of this.kinds) this.nextAt[k] = time + this.gap(k);
    this.lastTime = time;
    for (const k of this.kinds) {
      if (time < this.nextAt[k]) continue;
      this.nextAt[k] = time + this.gap(k);
      this.fire(k);
    }
  }

  /** Play one `k` now from a random bearing and distance (every draw comes from its own stream). */
  private fire(k: ShotKind): void {
    const r = this.rng[k];
    const d = SHOT_GAPS[k];
    const dist = lerp(d.near, d.far, r.next());
    const dn = (dist - d.near) / (d.far - d.near);
    const pan = r.range(-0.85, 0.85);
    const ctx = this.ctx;
    const now = ctx.currentTime + 0.02;
    // Distance: quieter and duller. Every voice runs into this chain.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lerp(5200, 1100, dn);
    lp.Q.value = 0.5;
    const level = ctx.createGain();
    level.gain.value = SHOT_LEVEL[k] * BED.shots * lerp(1, 0.3, dn);
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    lp.connect(level).connect(panner).connect(this.master);
    let open = 0;
    /** Start a source at `at`, stop it at `end`, and free the chain once all of them have ended. */
    const start = (src: AudioScheduledSourceNode, at: number, end: number, offset?: number): void => {
      this.live.add(src);
      open++;
      src.onended = () => {
        this.live.delete(src);
        src.disconnect();
        if (--open === 0) panner.disconnect();
      };
      if (offset === undefined) src.start(at);
      else (src as AudioBufferSourceNode).start(at, offset);
      src.stop(end);
    };
    const osc = (type: OscillatorType, freq: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      return o;
    };
    const env = (g: GainNode, at: number, peak: number, attack: number, decay: number): void => {
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + attack);
      g.gain.setTargetAtTime(0, at + attack, decay);
    };
    const noiseSrc = (at: number, len: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = this.hub.noise;
      start(s, at, at + len, r.range(0, this.hub.noise.duration - len - 0.1));
      return s;
    };
    const burst = (at: number, len: number, hz: number, q: number, peak: number, decay: number): void => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = hz;
      f.Q.value = q;
      const g = ctx.createGain();
      env(g, at, peak, 0.004, decay);
      noiseSrc(at, len).connect(f).connect(g).connect(lp);
    };
    switch (k) {
      case 'siren': {
        // A pass of an American electronic siren (wail, yelp at the intersection, sometimes an airhorn or a cutoff):
        // the module draws the geometry and drives the pan, the gain and the doppler from it.
        playSiren(ctx, lp, r, { at: now, closest: dist, near: d.near, far: d.far, pan: panner.pan, start });
        break;
      }
      case 'horn': {
        // One or two beeps of a two-note horn.
        const f = r.range(380, 470);
        const beeps = r.chance(0.35) ? 2 : 1;
        const len = r.range(0.18, 0.5);
        for (let b = 0; b < beeps; b++) {
          const at = now + b * (len + 0.14);
          const g = ctx.createGain();
          env(g, at, 1, 0.012, 0.02);
          g.gain.cancelScheduledValues(at + 0.012);
          g.gain.setValueAtTime(1, at + len);
          g.gain.setTargetAtTime(0, at + len, 0.015);
          const filt = ctx.createBiquadFilter();
          filt.type = 'lowpass';
          filt.frequency.value = 1800;
          g.connect(filt).connect(lp);
          for (const m of [1, 1.26]) {
            const o = osc('sawtooth', f * m);
            const og = ctx.createGain();
            og.gain.value = 0.5;
            o.connect(og).connect(g);
            start(o, at, at + len + 0.12);
          }
        }
        break;
      }
      case 'dog': {
        const barks = r.int(1, 4);
        const f0 = r.range(380, 620);
        let at = now;
        for (let b = 0; b < barks; b++) {
          const o = osc('sawtooth', f0);
          o.frequency.setValueAtTime(f0 * 1.15, at);
          o.frequency.exponentialRampToValueAtTime(f0 * 0.7, at + 0.16);
          const form = ctx.createBiquadFilter();
          form.type = 'bandpass';
          form.frequency.value = r.range(750, 1100);
          form.Q.value = 2.2;
          const g = ctx.createGain();
          env(g, at, 1 - b * 0.08, 0.012, 0.05);
          o.connect(form).connect(g).connect(lp);
          start(o, at, at + 0.3);
          burst(at, 0.14, 1500, 1.2, 0.35, 0.03);
          at += r.range(0.28, 0.45);
        }
        break;
      }
      case 'bottle': {
        // A bottle kicked over: a few glass clinks that bounce closer together and softer, then a short roll.
        const f = r.range(2300, 3400);
        let at = now;
        let gap = r.range(0.2, 0.35);
        let peak = 1;
        const n = r.int(3, 5);
        for (let i = 0; i < n; i++) {
          for (const [m, a] of [[1, 1], [1.52, 0.5], [2.31, 0.3]] as const) {
            const o = osc('sine', f * m);
            const g = ctx.createGain();
            env(g, at, peak * a * 0.7, 0.002, 0.035);
            o.connect(g).connect(lp);
            start(o, at, at + 0.3);
          }
          at += gap;
          gap *= 0.7;
          peak *= 0.7;
        }
        burst(now + 0.1, 1.1, 1100, 1, 0.12, 0.35);
        break;
      }
      case 'shutter': {
        // A roller shutter shaken: noise gated by a fast ragged pulse train in a metallic band, after a dull first knock.
        const len = r.range(0.8, 1.5);
        const n = Math.ceil(len * 60);
        const gate = new Float32Array(n);
        for (let i = 0; i < n; i++) gate[i] = (i % 2 ? 0.3 : 1) * r.range(0.4, 1) * Math.sin(Math.PI * Math.min(1, (i / (n - 1)) * 1.15)) ** 0.7;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = r.range(1500, 2300);
        f.Q.value = 2.5;
        const g = ctx.createGain();
        g.gain.setValueCurveAtTime(gate, now, len);
        noiseSrc(now, len).connect(f).connect(g).connect(lp);
        burst(now, 0.3, 380, 1.5, 0.6, 0.06);
        break;
      }
      case 'trainHorn': {
        // A long three-tone horn, swelling in and drooping a little at the end.
        const len = r.range(1.8, 2.8);
        const f = r.range(260, 330);
        const filt = ctx.createBiquadFilter();
        filt.type = 'lowpass';
        filt.frequency.value = 1100;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, now);
        g.gain.linearRampToValueAtTime(1, now + 0.25);
        g.gain.setValueAtTime(1, now + len - 0.2);
        g.gain.linearRampToValueAtTime(0, now + len);
        g.connect(filt).connect(lp);
        for (const m of [1, 1.26, 1.5]) {
          const o = osc('sawtooth', f * m);
          o.frequency.setValueAtTime(f * m, now);
          o.frequency.linearRampToValueAtTime(f * m * 0.97, now + len);
          const og = ctx.createGain();
          og.gain.value = 0.33;
          o.connect(og).connect(g);
          start(o, now, now + len + 0.05);
        }
        break;
      }
      case 'gull': {
        const calls = r.int(2, 4);
        let at = now;
        for (let c = 0; c < calls; c++) {
          const f = r.range(1500, 2000);
          const len = r.range(0.28, 0.45);
          const o = osc('triangle', f);
          o.frequency.setValueAtTime(f, at);
          o.frequency.linearRampToValueAtTime(f * 1.55, at + len * 0.35);
          o.frequency.linearRampToValueAtTime(f * 1.05, at + len);
          const vib = osc('sine', r.range(22, 34));
          const vg = ctx.createGain();
          vg.gain.value = f * 0.03;
          vib.connect(vg).connect(o.frequency);
          const band = ctx.createBiquadFilter();
          band.type = 'bandpass';
          band.frequency.value = 2400;
          band.Q.value = 0.9;
          const g = ctx.createGain();
          env(g, at, 1, 0.04, len * 0.35);
          o.connect(band).connect(g).connect(lp);
          start(o, at, at + len + 0.1);
          start(vib, at, at + len + 0.1);
          at += len + r.range(0.1, 0.4);
        }
        break;
      }
    }
  }

  dispose(): void {
    for (const s of [...this.sources, ...this.live]) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.length = 0;
    this.live.clear();
    this.master.disconnect();
  }
}
