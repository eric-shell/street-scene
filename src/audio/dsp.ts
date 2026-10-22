/**
 * The small offline DSP kit the synthesized sounds share: the cookbook biquad (the formulas BiquadFilterNode
 * uses, so a model and the live node agree), K-weighting for loudness, and a power spectrum. Pure and free of
 * Web Audio and the DOM, so it runs in the engine's AudioWorklet (through engineSynth.ts), in the impact
 * recipes (sfxRecipes.ts) and headless in the tests.
 */

/** A direct form biquad from the RBJ cookbook; the band pass has 0 dB peak gain. */
export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  private static make(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
    return new Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
  }

  /** From normalized coefficients (a0 = 1). */
  static coefficients(b0: number, b1: number, b2: number, a1: number, a2: number): Biquad {
    return new Biquad(b0, b1, b2, a1, a2);
  }

  static peaking(sr: number, hz: number, q: number, dbGain: number): Biquad {
    const A = 10 ** (dbGain / 40);
    const w = (2 * Math.PI * hz) / sr;
    const alpha = Math.sin(w) / (2 * q);
    return Biquad.make(1 + alpha * A, -2 * Math.cos(w), 1 - alpha * A, 1 + alpha / A, -2 * Math.cos(w), 1 - alpha / A);
  }

  static lowpass(sr: number, hz: number, q: number): Biquad {
    const w = (2 * Math.PI * hz) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    return Biquad.make((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  static highpass(sr: number, hz: number, q: number): Biquad {
    const w = (2 * Math.PI * hz) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const c = Math.cos(w);
    return Biquad.make((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  /** Constant 0 dB peak gain band pass. */
  static bandpass(sr: number, hz: number, q: number): Biquad {
    const w = (2 * Math.PI * hz) / sr;
    const alpha = Math.sin(w) / (2 * q);
    return Biquad.make(alpha, 0, -alpha, 1 + alpha, -2 * Math.cos(w), 1 - alpha);
  }

  /** |H| at `hz`. */
  magnitude(sr: number, hz: number): number {
    const w = (2 * Math.PI * hz) / sr;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -(this.a1 * s1 + this.a2 * s2);
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * K-weighting (ITU-R BS.1770, the LUFS pre-filter) at 48 kHz: a +4 dB high shelf above 1.5 kHz and a 38 Hz high
 * pass. Nearly flat through the bass an engine lives in, unlike A-weighting, which would call a V8 quiet and have
 * it trimmed up until its peaks fought the master limiter.
 */
export function kWeighting(): [Biquad, Biquad] {
  return [Biquad.coefficients(1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585), Biquad.coefficients(1, -2, 1, -1.99004745483398, 0.99007225036621)];
}

/** In-place radix-2 FFT; lengths are powers of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** One sided power spectrum |X_k|² of a real signal from `from` on, zero padded to `size` (a power of two). */
export function powerSpectrum(x: ArrayLike<number>, from: number, size: number): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = from; i < x.length; i++) re[i - from] = x[i];
  fft(re, im);
  const out = new Float64Array(size / 2 + 1);
  for (let k = 0; k <= size / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}
