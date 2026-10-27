/**
 * An American police siren going by, synthesized (no samples). The model is an electronic unit (a Federal Signal
 * PA300 or Whelen 295 class: a 100 W driver into a horn speaker behind the grille), not the European hi-lo:
 *  - the pitch: a wail sweeps roughly 700 to 1,600 Hz and back at a constant rate in cents (so it sounds even),
 *    one cycle every 4.4 to 5.2 s with a brief hold at the top; the yelp is the same sweep as a sawtooth
 *    (slow rise, fast drop) in 0.28 to 0.35 s; a rare phaser warbles 8 to 12 Hz over a narrower range;
 *  - the timbre: a harmonic-rich wave (1/n partials, the odd ones a little stronger) through a tanh soft clipper
 *    for the driver's overdrive, then the horn's formants (peaks near 1.2 and 2.4 kHz) between a high pass and
 *    a low pass. That is what makes it hard and nasal rather than a flute;
 *  - the airhorn: a separate blast about 480 Hz with a strong second harmonic, two or three of them;
 *  - the pass: the car drives a straight line at 18 to 28 m/s past the listener, and the gain (inverse distance),
 *    the doppler shift (f * c / (c + v away), c = 343 m/s) and the stereo bearing are all computed from that
 *    geometry and written as value curves. The mode runs wail, a yelp of 2 to 4 s around the closest approach
 *    (clearing the intersection), wail again; some passes honk before it, some cut off just after (it arrived);
 *  - the distance: air absorption (the high formant falls as the car gets further), and a short diffuse echo off
 *    the buildings (two taps of a feedback delay, dulled), more of it when far.
 * Every random choice comes from the passed Rng in a fixed order, so a seed's night is the same night.
 * The graph is a dozen or so nodes, and ends with its last source. The city bed plays it today; the police
 * chase can reuse it (`cutoff` and a closer `closest`).
 */
import type { Rng } from '../sim/prng';
import { clamp01, lerp } from '../sim/math';

/** The siren's constants. */
export const SIREN = {
  /** Speed of sound (m/s). */
  c: 343,
  /** Value curve rate (Hz): pitch, gain, pan and echo are written on this grid. */
  rate: 100,
  /** Seconds the graph lives on after the pass ends, for the echo to die away (s). */
  tail: 0.8,
  /** Overall level: the gain at the closest approach, set so a pass sits where the old siren did (docs/audioMix.md). */
  level: 0.34,
  /** The pass: its length (s), the car's speed (m/s) and where in the pass the closest approach falls (fraction). */
  pass: { len: [12, 22], speed: [18, 28], at: [0.4, 0.6], bearing: 1.1, fadeIn: 2.5, fadeOut: 3, pan: 0.9 },
  /** Wail: the sweep's low and high pitch (Hz), its period (s), where the rise ends and the fall starts (cycle fraction). */
  wail: { lo: 700, hi: 1600, period: [4.4, 5.2], riseEnd: 0.47, fallStart: 0.53, round: 0.35 },
  /** Yelp: the period (s) and the fraction of the cycle spent rising; the range is the wail's. */
  yelp: { period: [0.28, 0.35], rise: 0.8, length: [2, 4], before: [0.3, 0.6], phaser: 0.04 },
  /** Phaser: the warble rate (Hz) and its narrower range (Hz). */
  phaser: { rate: [8, 12], lo: 900, hi: 1450 },
  /** The cutoff: how likely it is (fraction of passes) and how long after the pass it comes (s). */
  cutoff: { chance: 0.25, after: [2.5, 5.5] },
  /** The driver: harmonics in the periodic wave (amplitude 1 / n^rolloff, flatter than a sawtooth's 1/n because the driver is a pulse, not a ramp), the odd ones boosted, the clipper's drive and bias (tanh(drive * (x + bias)); the bias is the driver's asymmetry, which keeps the even harmonics a symmetric clip would cancel). */
  driver: { partials: 14, rolloff: 0.6, oddBoost: 1.25, drive: 3, bias: 0.3 },
  /** The horn: the high pass and low pass (Hz), and the two formant peaks (Hz, dB, Q). */
  horn: { hp: 450, lp: 6000, low: { hz: 1200, db: 8, q: 2 }, high: { hz: 2450, db: 5, q: 3 } },
  /** Air absorption: the high formant's gain (dB) at the closest `near` range and at `far` beyond it. */
  air: { nearDb: 5, farDb: -4 },
  /** Echo off the buildings: the two taps (s), feedback, its low pass (Hz) and the wet mix when far and at the pass. */
  echo: { taps: [0.061, 0.089], feedback: 0.35, lp: 2500, far: 0.25, near: 0.1 },
  /** Airhorn: how likely it is, the pitch (Hz), the partials' amplitudes, blasts (min, max), blast and gap lengths (s), level, and the gap before the pass (s). */
  blast: { chance: 0.3, hz: 480, partials: [1, 1.4, 0.5, 0.35, 0.2, 0.12, 0.08], count: [2, 3], len: [0.4, 0.9], gap: [0.15, 0.3], level: 1.3, attack: 0.012, release: 0.05, before: 0.35 },
} as const;

/** Where a pass sits in the world and how to build it. */
export interface SirenOptions {
  /** Context time the pass begins (s). */
  at: number;
  /** Closest approach to the listener (m). */
  closest: number;
  /** The nearest and furthest the voice is placed (m): the range the air absorption is scaled over. */
  near: number;
  far: number;
  /** A stereo panner's pan, driven from the bearing; left alone when missing. */
  pan?: AudioParam;
  /** Cut off abruptly after the pass; drawn from the Rng (SIREN.cutoff.chance) when missing. */
  cutoff?: boolean;
  /** Start and stop a source (the caller's bookkeeping for freeing its chain); the default starts it and frees the graph at the last end. */
  start?: (src: AudioScheduledSourceNode, at: number, end: number) => void;
}

/** A pass that was built: how long it lasts (s) and what it chose (for tests and the listening rig). */
export interface SirenPass {
  /** Seconds from `at` to the last sound (the echo tail not counted). */
  duration: number;
  /** Seconds from `at` to the closest approach. */
  passAt: number;
  /** The yelp's (or phaser's) window, seconds from `at`. */
  yelp: [number, number];
  phaser: boolean;
  cutoff: boolean;
  /** The airhorn blasts' spans, seconds from `at` (empty without). */
  blasts: [number, number][];
}

/** Smoothstep on 0..1. */
const smooth = (u: number): number => u * u * (3 - 2 * u);

/** A sweep's shape, 0..1 over a cycle phase, with its ends rounded a little (a constant rate in cents otherwise). */
const ease = (x: number): number => lerp(x, smooth(x), SIREN.wail.round);

/** The wail's sweep position 0..1 at cycle phase `ph` (0..1): rise, a short hold at the top, fall. */
function wailAt(ph: number): number {
  const { riseEnd, fallStart } = SIREN.wail;
  if (ph < riseEnd) return ease(ph / riseEnd);
  if (ph < fallStart) return 1;
  return ease(1 - (ph - fallStart) / (1 - fallStart));
}

/** The yelp's sweep position at cycle phase `ph`: a slow rise and a fast drop. */
const yelpAt = (ph: number): number => (ph < SIREN.yelp.rise ? ph / SIREN.yelp.rise : 1 - (ph - SIREN.yelp.rise) / (1 - SIREN.yelp.rise));

/** The context's shared waves and clipper curve (one set per context). */
interface Kit {
  siren: PeriodicWave;
  blast: PeriodicWave;
  clip: Float32Array<ArrayBuffer>;
}
const kits = new WeakMap<BaseAudioContext, Kit>();

function kitFor(ctx: BaseAudioContext): Kit {
  let kit = kits.get(ctx);
  if (kit) return kit;
  const { partials, rolloff, oddBoost, drive, bias } = SIREN.driver;
  const re = new Float32Array(partials + 1);
  const im = new Float32Array(partials + 1);
  for (let n = 1; n <= partials; n++) im[n] = (n & 1 ? oddBoost : 1) / n ** rolloff;
  const bre = new Float32Array(SIREN.blast.partials.length + 1);
  const bim = new Float32Array(bre.length);
  SIREN.blast.partials.forEach((a, i) => (bim[i + 1] = a));
  const clip = new Float32Array(2049);
  for (let i = 0; i < clip.length; i++) clip[i] = Math.tanh(drive * ((i / (clip.length - 1)) * 2 - 1 + bias));
  kit = { siren: ctx.createPeriodicWave(re, im), blast: ctx.createPeriodicWave(bre, bim), clip };
  kits.set(ctx, kit);
  return kit;
}

/**
 * Play one pass of a siren into `out`. All the draws from `rng` happen up front in a fixed order, whatever
 * they turn out to select. Returns what it built.
 */
export function playSiren(ctx: BaseAudioContext, out: AudioNode, rng: Rng, opts: SirenOptions): SirenPass {
  const S = SIREN;
  // Draws, in a fixed order.
  const dur = rng.range(S.pass.len[0], S.pass.len[1]);
  const speed = rng.range(S.pass.speed[0], S.pass.speed[1]);
  const passAt = dur * rng.range(S.pass.at[0], S.pass.at[1]);
  const dir = rng.chance(0.5) ? 1 : -1;
  const bearing = rng.range(-S.pass.bearing, S.pass.bearing);
  const wailPeriod = rng.range(S.wail.period[0], S.wail.period[1]);
  const wailPhase = rng.next();
  const cutoffDraw = rng.chance(S.cutoff.chance);
  const cutoffAfter = rng.range(S.cutoff.after[0], S.cutoff.after[1]);
  const phaser = rng.chance(S.yelp.phaser);
  const yelpLen = rng.range(S.yelp.length[0], S.yelp.length[1]);
  const yelpBefore = rng.range(S.yelp.before[0], S.yelp.before[1]);
  const yelpPeriod = rng.range(S.yelp.period[0], S.yelp.period[1]);
  const phaserRate = rng.range(S.phaser.rate[0], S.phaser.rate[1]);
  const honk = rng.chance(S.blast.chance);
  const blastCount = rng.int(S.blast.count[0], S.blast.count[1]);
  const blastLens = [rng.range(S.blast.len[0], S.blast.len[1]), rng.range(S.blast.len[0], S.blast.len[1]), rng.range(S.blast.len[0], S.blast.len[1])];
  const blastGaps = [rng.range(S.blast.gap[0], S.blast.gap[1]), rng.range(S.blast.gap[0], S.blast.gap[1])];
  const blastHz = S.blast.hz * rng.range(0.96, 1.04);
  const cutoff = opts.cutoff ?? cutoffDraw;
  const end = cutoff ? Math.min(dur, passAt + cutoffAfter) : dur;
  const yelpFrom = passAt - yelpLen * yelpBefore;
  const yelpTo = yelpFrom + yelpLen;

  // The pass geometry: the listener at the origin facing +z, the closest point at `bearing`, the car along the perpendicular.
  const n = Math.round(dur * S.rate) + 1;
  const freq = new Float32Array(n);
  const doppler = new Float32Array(n);
  const amp = new Float32Array(n);
  const wet = new Float32Array(n);
  const pan = new Float32Array(n);
  const air = new Float32Array(n);
  const sinB = Math.sin(bearing);
  const cosB = Math.cos(bearing);
  const dEnd = Math.hypot(opts.closest, speed * Math.max(passAt, dur - passAt));
  let mode: 0 | 1 | 2 = 0;
  let ph = wailPhase;
  let f = S.wail.lo;
  const lnSpan = Math.log(S.wail.hi / S.wail.lo);
  for (let i = 0; i < n; i++) {
    const t = i / S.rate;
    // Mode: wail, yelp (or phaser) around the closest approach, wail again. A switch keeps the pitch where it is.
    const want = t >= yelpFrom && t < yelpTo ? (phaser ? 2 : 1) : 0;
    if (want !== mode) {
      const w = clamp01(Math.log(f / S.wail.lo) / lnSpan);
      if (want === 0) ph = w * S.wail.riseEnd;
      else if (want === 1) ph = w * S.yelp.rise;
      else ph = 0;
      mode = want;
    }
    let sweep: number;
    if (mode === 0) {
      sweep = wailAt(ph);
      ph = (ph + 1 / S.rate / wailPeriod) % 1;
      f = S.wail.lo * Math.exp(lnSpan * sweep);
    } else if (mode === 1) {
      sweep = yelpAt(ph);
      ph = (ph + 1 / S.rate / yelpPeriod) % 1;
      f = S.wail.lo * Math.exp(lnSpan * sweep);
    } else {
      sweep = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      ph = (ph + phaserRate / S.rate) % 1;
      f = S.phaser.lo * Math.exp(Math.log(S.phaser.hi / S.phaser.lo) * sweep);
    }
    // Along the path (m, negative before the pass), the distance and the radial speed away from the listener.
    const p = speed * (t - passAt);
    const d = Math.hypot(opts.closest, p);
    doppler[i] = S.c / (S.c + (speed * p) / d);
    freq[i] = f * doppler[i];
    const fadeIn = smooth(clamp01(t / S.pass.fadeIn));
    const fadeOut = cutoff ? (t < end ? 1 : 0) : smooth(clamp01((dur - t) / S.pass.fadeOut));
    amp[i] = S.level * (opts.closest / d) * fadeIn * fadeOut;
    const far = clamp01((d - opts.closest) / Math.max(1, dEnd - opts.closest));
    wet[i] = lerp(S.echo.near, S.echo.far, far);
    air[i] = lerp(S.air.nearDb, S.air.farDb, clamp01((d - opts.near) / Math.max(1, opts.far * 1.2 - opts.near)));
    const x = opts.closest * sinB + p * dir * cosB;
    pan[i] = S.pass.pan * Math.max(-1, Math.min(1, x / d));
  }

  const kit = kitFor(ctx);
  const t0 = opts.at;
  const life = dur + S.tail;
  let open = 0;
  const finish: AudioNode[] = [];
  const start =
    opts.start ??
    ((src: AudioScheduledSourceNode, at: number, stopAt: number): void => {
      open++;
      src.onended = () => {
        src.disconnect();
        if (--open === 0) for (const node of finish) node.disconnect();
      };
      src.start(at);
      src.stop(stopAt);
    });
  const biquad = (type: BiquadFilterType, hz: number, q: number, gainDb = 0): BiquadFilterNode => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = hz;
    b.Q.value = q;
    b.gain.value = gainDb;
    return b;
  };
  const gain = (v: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };

  // The driver: the harmonic wave, clipped, then the horn's formants, then the distance and the pass's gain.
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(kit.siren);
  osc.frequency.setValueCurveAtTime(freq, t0, dur);
  const clipper = ctx.createWaveShaper();
  clipper.curve = kit.clip;
  clipper.oversample = '4x';
  const low = biquad('peaking', S.horn.low.hz, S.horn.low.q, S.horn.low.db);
  const high = biquad('peaking', S.horn.high.hz, S.horn.high.q, S.air.nearDb);
  high.gain.setValueCurveAtTime(air, t0, dur);
  const level = gain(0);
  level.gain.setValueCurveAtTime(amp, t0, dur);
  osc.connect(clipper).connect(biquad('highpass', S.horn.hp, 0.7)).connect(low).connect(high).connect(biquad('lowpass', S.horn.lp, 0.7)).connect(level).connect(out);
  start(osc, t0, t0 + life);

  // The echo: two taps of a feedback delay, dulled, mixed by distance.
  const d1 = ctx.createDelay(0.2);
  const d2 = ctx.createDelay(0.2);
  d1.delayTime.value = S.echo.taps[0];
  d2.delayTime.value = S.echo.taps[1];
  const dull = biquad('lowpass', S.echo.lp, 0.5);
  const feedback = gain(S.echo.feedback);
  const mix = gain(0);
  mix.gain.setValueCurveAtTime(wet, t0, dur);
  level.connect(d1).connect(dull);
  level.connect(d2).connect(dull);
  dull.connect(mix).connect(out);
  dull.connect(feedback);
  feedback.connect(d1);
  feedback.connect(d2);
  finish.push(level, mix);

  if (opts.pan) opts.pan.setValueCurveAtTime(pan, t0, dur);

  // The airhorn: blasts ending shortly before the pass, tracking the same doppler and gain.
  const blasts: [number, number][] = [];
  if (honk) {
    let hornEnd = passAt - S.blast.before;
    for (let b = blastCount - 1; b >= 0; b--) {
      blasts.unshift([hornEnd - blastLens[b], hornEnd]);
      hornEnd -= blastLens[b] + blastGaps[Math.min(b, 1)];
    }
    const from = Math.max(0, blasts[0][0] - 0.05);
    const to = blasts[blasts.length - 1][1] + S.blast.release + 0.05;
    const i0 = Math.floor(from * S.rate);
    const i1 = Math.min(n - 1, Math.ceil(to * S.rate));
    const horn = ctx.createOscillator();
    horn.setPeriodicWave(kit.blast);
    const bend = new Float32Array(i1 - i0 + 1);
    for (let i = 0; i < bend.length; i++) bend[i] = blastHz * doppler[i0 + i];
    horn.frequency.setValueCurveAtTime(bend, t0 + i0 / S.rate, (bend.length - 1) / S.rate);
    const hg = gain(0);
    for (const [a, b] of blasts) {
      hg.gain.setValueAtTime(0, t0 + a);
      hg.gain.linearRampToValueAtTime(S.blast.level, t0 + a + S.blast.attack);
      hg.gain.setValueAtTime(S.blast.level, t0 + b);
      hg.gain.linearRampToValueAtTime(0, t0 + b + S.blast.release);
    }
    horn.connect(hg).connect(level);
    start(horn, t0, t0 + life);
  }

  return { duration: end, passAt, yelp: [yelpFrom, yelpTo], phaser, cutoff, blasts };
}
