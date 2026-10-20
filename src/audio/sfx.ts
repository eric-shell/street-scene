/**
 * Sound effects with Web Audio. Synthesized (no asset files):
 *  - impacts: car vs car crunch, wall/barrier thud, guard rail clang, and prop
 *    breaks by kind (pole clang + glass, hollow can bang, bench crunch, big
 *    bus stop shatter, leafy bush swish, pot crack, cafe chair clatter, plastic
 *    barrel thunk, crate splinter, dumpster boom, trash bag thump). Each is
 *    rendered once into a few AudioBuffer variants
 *    by the small DSP recipes below, then replayed with pitch and level from
 *    the impact speed, spatialized to the camera, rate limited and capped
 *    to a fixed number of voices.
 *  - loops: nitrous jet whoosh (sweeping filtered noise + turbine whine) and
 *    a wall/rail scrape while a car grinds along a wall.
 *  - the horn (dual tone), the countdown beeps and firework booms.
 * Crowd recordings (public/sfx, loaded lazily and decoded once per app):
 *  - a looped cheering bed per crowd stand, positioned on the stand's
 *    nearest point to the listener and swelling with the stand's excitement
 *  - cheering + applause one-shots when the player crosses the line.
 * Render side only: reads race events and interpolated car state, never the
 * other way around. All randomness here is cosmetic (Math.random is fine).
 */
import { audioHub } from './engineAudio';
import type { RaceEvent, RaceState } from '../sim/race';
import type { PropKind } from '../city/props';
import type { Contact, World } from '../city/world';
import { TICK_HZ } from '../sim/constants';

/** Where a sound is heard: 0..1 loudness from distance and -1..1 stereo position. */
export interface SfxPos {
  proximity: number;
  pan: number;
}

/** Per car state the loops need each frame (interpolated pose, world units). */
export interface SfxCar {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  nitro: boolean;
  halfLength: number;
  halfWidth: number;
}

export type WallHitKind = 'wall' | 'barrier' | 'rail';
/** Prop kinds with their own impact sound (news boxes sound like garbage cans). */
type PropSound = Exclude<PropKind, 'newsBox'>;
export type SfxBank = 'crash' | WallHitKind | PropSound | 'firework';
type Bank = SfxBank;
const PROP_SOUND: Record<PropKind, PropSound> = {
  streetlight: 'streetlight',
  trafficLight: 'trafficLight',
  garbageCan: 'garbageCan',
  bench: 'bench',
  busStop: 'busStop',
  bush: 'bush',
  planterPot: 'planterPot',
  cafeTable: 'cafeTable',
  barrel: 'barrel',
  crate: 'crate',
  dumpster: 'dumpster',
  newsBox: 'garbageCan',
  trashBags: 'trashBags',
};

const VARIANTS = 3;
const MAX_VOICES = 14;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ---------- offline DSP ----------

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

/** RBJ cookbook biquad (band pass has 0 dB peak gain). */
function biquad(type: 'lp' | 'hp' | 'bp', f: number, q: number, sr: number): Biquad {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  else if (type === 'hp') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function run(f: Biquad, x: number): number {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2;
  f.x2 = f.x1;
  f.x1 = x;
  f.y2 = f.y1;
  f.y1 = y;
  return y;
}

type FilterSpec = [type: 'lp' | 'hp' | 'bp', f: number, q: number];

/** A mono buffer that recipes add layers into. */
class Tape {
  readonly d: Float32Array;
  constructor(
    readonly sr: number,
    seconds: number,
  ) {
    this.d = new Float32Array(Math.ceil(sr * seconds));
  }

  /** Decaying sinusoids [freq, amp, decay seconds]: struck metal, wood, plastic. */
  modes(t0: number, list: [number, number, number][]): void {
    const { d, sr } = this;
    for (const [f, amp, decay] of list) {
      const start = Math.floor(t0 * sr);
      const len = Math.min(d.length - start, Math.ceil(decay * 7 * sr));
      const ph = Math.random() * Math.PI * 2;
      const w = (2 * Math.PI * f) / sr;
      for (let n = 0; n < len; n++) {
        const t = n / sr;
        d[start + n] += amp * Math.sin(ph + w * n) * Math.exp(-t / decay) * Math.min(1, t / 0.0015);
      }
    }
  }

  /** Filtered noise burst with an attack/decay envelope; rough > 0 adds a jittery grind. */
  noise(t0: number, dur: number, amp: number, decay: number, filters: FilterSpec[], attack = 0.001, rough = 0): void {
    const { d, sr } = this;
    const fs = filters.map(([type, f, q]) => biquad(type, f, q, sr));
    const mod = biquad('lp', 28, 0.7, sr);
    const start = Math.floor(t0 * sr);
    const len = Math.min(d.length - start, Math.ceil(dur * sr));
    for (let n = 0; n < len; n++) {
      const t = n / sr;
      let x = Math.random() * 2 - 1;
      for (const f of fs) x = run(f, x);
      let env = amp * Math.exp(-t / decay) * Math.min(1, t / attack);
      if (rough > 0) env *= 1 - rough + rough * Math.min(1, Math.abs(run(mod, Math.random() * 2 - 1)) * 9);
      d[start + n] += x * env;
    }
  }

  /** Sine with a falling pitch: the body thud of a heavy hit. */
  thud(t0: number, f0: number, f1: number, sweep: number, amp: number, decay: number): void {
    const { d, sr } = this;
    const start = Math.floor(t0 * sr);
    const len = Math.min(d.length - start, Math.ceil(decay * 8 * sr));
    let ph = 0;
    for (let n = 0; n < len; n++) {
      const t = n / sr;
      ph += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / sweep))) / sr;
      d[start + n] += amp * Math.sin(ph) * Math.exp(-t / decay) * Math.min(1, t / 0.002);
    }
  }

  /** Many tiny filtered noise grains: crunching panels, splintering wood, gravel of debris. */
  grains(t0: number, span: number, count: number, amp: number, fMin: number, fMax: number, q: number, lenMax = 0.009): void {
    for (let i = 0; i < count; i++) {
      const k = Math.random() ** 1.7;
      const len = rnd(0.002, lenMax);
      this.noise(t0 + k * span, len * 4, amp * rnd(0.3, 1) * (1 - 0.7 * k), len, [['bp', rnd(fMin, fMax), q]]);
    }
  }

  /** Glass: a bright crack, then shards tinkling down (front loaded). */
  glass(t0: number, span: number, count: number, amp: number): void {
    this.noise(t0, 0.25, amp, 0.05, [['hp', 2800, 0.7]]);
    this.noise(t0, 0.12, amp * 0.6, 0.02, [['bp', 6500, 1.2]]);
    for (let i = 0; i < count; i++) {
      const k = Math.random() ** 2.1;
      const t = t0 + 0.01 + k * span;
      const a = amp * rnd(0.12, 0.45) * (1 - 0.65 * k);
      const f = rnd(2600, 9200);
      this.modes(t, [
        [f, a, rnd(0.006, 0.035)],
        [f * rnd(1.4, 1.9), a * 0.5, rnd(0.004, 0.02)],
      ]);
      this.noise(t, 0.012, a * 0.7, 0.003, [['hp', 5000, 0.7]]);
    }
  }

  finish(): Float32Array<ArrayBuffer> {
    const d = this.d;
    let peak = 1e-6;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    const g = 0.95 / peak;
    const fade = Math.floor(this.sr * 0.03);
    for (let i = 0; i < d.length; i++) d[i] *= g * Math.min(1, (d.length - i) / fade);
    return d as Float32Array<ArrayBuffer>;
  }
}

/** Inharmonic ratios of a struck bar / pole (free-free beam modes). */
const BAR = [1, 2.756, 5.404, 8.933];

const RECIPES: Record<Bank, { seconds: number; make(t: Tape): void }> = {
  // Car vs car: sheet metal crunch over a body thud, a short panel ring.
  crash: {
    seconds: 0.9,
    make(t) {
      t.thud(0, rnd(120, 150), 42, 0.05, 0.9, 0.14);
      t.noise(0, 0.3, 0.55, 0.07, [['bp', rnd(1400, 2200), 0.8]]);
      t.grains(0.005, 0.28, 34, 0.5, 1800, 5200, 2.5);
      const b = rnd(300, 380);
      t.modes(0.002, [1, 1.47, 2.09, 2.56, 3.9, 5.2].map((r, i) => [b * r * rnd(0.97, 1.03), 0.22 / (1 + i * 0.4), rnd(0.07, 0.22)] as [number, number, number]));
    },
  },
  // Concrete wall: heavy low thud, dull body, a gritty scrape tail.
  wall: {
    seconds: 1.0,
    make(t) {
      t.thud(0, rnd(95, 115), 34, 0.06, 1, 0.2);
      t.noise(0, 0.35, 0.6, 0.08, [['lp', 420, 0.7]]);
      t.noise(0.02, 0.8, 0.28, 0.28, [['bp', rnd(800, 1100), 1.2]], 0.03, 0.8);
      t.grains(0.01, 0.4, 14, 0.25, 1200, 3200, 2);
    },
  },
  // Road closure barrier: thud plus hollow plastic/board knock and a rattle.
  barrier: {
    seconds: 0.9,
    make(t) {
      t.thud(0, 110, 40, 0.05, 0.8, 0.15);
      t.modes(0, [
        [rnd(200, 240), 0.5, 0.09],
        [rnd(390, 430), 0.35, 0.07],
        [rnd(660, 720), 0.25, 0.05],
      ]);
      t.noise(0, 0.2, 0.45, 0.04, [['bp', 900, 1.1]]);
      t.noise(0.03, 0.6, 0.2, 0.2, [['bp', 1300, 1.4]], 0.02, 0.7);
    },
  },
  // Steel guard rail: long ringing clang with a metallic screech.
  rail: {
    seconds: 1.5,
    make(t) {
      const b = rnd(160, 200);
      t.modes(0, [
        [b, 0.5, 0.45],
        [b * 2.32, 0.4, 0.38],
        [b * 4.25, 0.3, 0.3],
        [b * 6.63, 0.2, 0.22],
        [b * 9.38, 0.12, 0.15],
        [rnd(1700, 1900), 0.12, 0.12],
        [rnd(2800, 3100), 0.08, 0.08],
      ]);
      t.noise(0, 0.05, 0.5, 0.012, [['hp', 1000, 0.7]]);
      t.thud(0, 90, 40, 0.05, 0.4, 0.1);
      t.noise(0.01, 0.6, 0.22, 0.25, [['bp', rnd(2300, 2800), 5]], 0.02, 0.85);
    },
  },
  // Streetlight: big pole clang, lamp glass, the pole hitting the road.
  streetlight: {
    seconds: 1.8,
    make(t) {
      const b = rnd(230, 290);
      t.modes(0, BAR.map((r, i) => [b * r, 0.55 / (1 + i * 0.6), 0.75 - i * 0.15] as [number, number, number]));
      t.thud(0, 120, 45, 0.05, 0.7, 0.12);
      t.glass(0.05, 0.7, 26, 0.5);
      t.modes(0.62, BAR.map((r, i) => [b * 0.8 * r, 0.25 / (1 + i), 0.35] as [number, number, number]));
      t.thud(0.62, 80, 35, 0.05, 0.4, 0.1);
    },
  },
  // Traffic light: smaller clang, plastic housing clack, lens glass.
  trafficLight: {
    seconds: 1.5,
    make(t) {
      const b = rnd(300, 360);
      t.modes(0, BAR.map((r, i) => [b * r, 0.45 / (1 + i * 0.6), 0.55 - i * 0.1] as [number, number, number]));
      t.thud(0, 125, 45, 0.05, 0.6, 0.12);
      t.modes(0.04, [
        [rnd(700, 800), 0.3, 0.03],
        [rnd(1300, 1500), 0.2, 0.02],
      ]);
      t.glass(0.04, 0.55, 20, 0.45);
    },
  },
  // Garbage can: hollow bang, then it bounces and rattles away.
  garbageCan: {
    seconds: 1.1,
    make(t) {
      const b = rnd(140, 170);
      const hollow = (at: number, a: number) => {
        t.modes(at, [
          [b, a, 0.14],
          [b * 1.71, a * 0.7, 0.11],
          [b * 2.73, a * 0.5, 0.08],
          [b * 3.6, a * 0.35, 0.06],
        ]);
        t.noise(at, 0.12, a * 0.8, 0.025, [['bp', 700, 1.4]]);
      };
      hollow(0, 0.8);
      t.thud(0, 110, 50, 0.04, 0.5, 0.08);
      hollow(rnd(0.2, 0.26), 0.35);
      hollow(rnd(0.38, 0.45), 0.2);
      hollow(rnd(0.52, 0.6), 0.1);
      t.grains(0.05, 0.6, 10, 0.15, 1500, 4000, 2);
    },
  },
  // Bench: wooden slats splintering over a metal frame clank.
  bench: {
    seconds: 1.0,
    make(t) {
      t.thud(0, 115, 45, 0.05, 0.75, 0.12);
      t.modes(0, [
        [rnd(170, 200), 0.45, 0.05],
        [rnd(330, 370), 0.35, 0.04],
        [rnd(560, 620), 0.25, 0.03],
      ]);
      t.grains(0, 0.35, 60, 0.55, 500, 1800, 1.6, 0.012);
      const b = rnd(480, 560);
      t.modes(0.01, BAR.map((r, i) => [b * r, 0.18 / (1 + i), 0.18] as [number, number, number]));
      t.grains(0.15, 0.5, 14, 0.2, 900, 2500, 2);
    },
  },
  // Firework shell: a deep boom, a sharp crack and the crackle of the stars.
  firework: {
    seconds: 2.2,
    make(t) {
      t.thud(0, rnd(70, 85), 28, 0.08, 1, 0.32);
      t.noise(0, 0.5, 0.75, 0.09, [['lp', 520, 0.7]]);
      t.noise(0, 0.06, 0.45, 0.012, [['hp', 1500, 0.7]]);
      t.noise(0.02, 1.6, 0.18, 0.6, [['lp', 260, 0.7]], 0.05);
      t.grains(0.25, 1.6, 70, 0.32, 2500, 7500, 2.5, 0.004);
    },
  },
  // Bus stop: a whole glass shelter coming down.
  busStop: {
    seconds: 2.2,
    make(t) {
      t.thud(0, 100, 36, 0.06, 0.9, 0.2);
      const b = rnd(200, 240);
      t.modes(0, BAR.map((r, i) => [b * r, 0.3 / (1 + i * 0.5), 0.5] as [number, number, number]));
      t.glass(0, 1.6, 140, 0.85);
      t.glass(0.1, 1.4, 60, 0.5);
      t.grains(0.05, 1.2, 40, 0.2, 2500, 7000, 2.2);
    },
  },
  // Bush: a leafy swish and snapping twigs, barely a thud.
  bush: {
    seconds: 0.8,
    make(t) {
      t.noise(0, 0.45, 0.6, 0.18, [['bp', rnd(2200, 3200), 0.6]], 0.015);
      t.noise(0, 0.3, 0.35, 0.1, [['hp', 5000, 0.7]], 0.01);
      t.grains(0.01, 0.35, 40, 0.4, 1800, 5200, 2.2, 0.006);
      t.thud(0, 90, 50, 0.04, 0.25, 0.06);
    },
  },
  // Planter pot: a concrete crack over a heavy thud, shards and spilling soil.
  planterPot: {
    seconds: 1.0,
    make(t) {
      t.thud(0, rnd(100, 120), 40, 0.05, 0.85, 0.14);
      t.modes(0, [
        [rnd(420, 520), 0.4, 0.03],
        [rnd(900, 1100), 0.3, 0.02],
        [rnd(1700, 2000), 0.2, 0.015],
      ]);
      t.noise(0, 0.2, 0.5, 0.05, [['bp', 1200, 0.9]]);
      t.grains(0.02, 0.5, 30, 0.35, 900, 3500, 2, 0.01);
      t.noise(0.05, 0.5, 0.2, 0.2, [['lp', 600, 0.7]], 0.02);
    },
  },
  // Cafe table: aluminium chairs clattering away in a few bounces.
  cafeTable: {
    seconds: 1.0,
    make(t) {
      const b = rnd(600, 720);
      const clank = (at: number, a: number) => t.modes(at, BAR.map((r, i) => [b * r * rnd(0.95, 1.05), a / (1 + i * 0.7), 0.12] as [number, number, number]));
      clank(0, 0.5);
      clank(rnd(0.12, 0.18), 0.35);
      clank(rnd(0.3, 0.38), 0.25);
      clank(rnd(0.5, 0.6), 0.15);
      t.thud(0, 120, 60, 0.03, 0.4, 0.06);
      t.grains(0.02, 0.4, 12, 0.2, 1500, 4000, 2);
    },
  },
  // Plastic barrel: a hollow thunk and a sloshing bounce.
  barrel: {
    seconds: 0.9,
    make(t) {
      const b = rnd(95, 120);
      t.modes(0, [
        [b, 0.7, 0.09],
        [b * 1.9, 0.4, 0.06],
        [b * 3.1, 0.25, 0.04],
      ]);
      t.noise(0, 0.1, 0.45, 0.03, [['bp', 500, 1.2]]);
      t.modes(rnd(0.25, 0.32), [
        [b * 1.05, 0.3, 0.07],
        [b * 2, 0.15, 0.05],
      ]);
      t.noise(0.02, 0.4, 0.15, 0.15, [['bp', 1200, 1]], 0.01, 0.6);
    },
  },
  // Crates: boards splintering, then the stack tumbling.
  crate: {
    seconds: 1.0,
    make(t) {
      t.thud(0, 105, 45, 0.05, 0.7, 0.1);
      t.modes(0, [
        [rnd(220, 260), 0.4, 0.04],
        [rnd(450, 520), 0.3, 0.03],
        [rnd(800, 900), 0.2, 0.02],
      ]);
      t.grains(0, 0.45, 80, 0.6, 400, 2200, 1.5, 0.014);
      t.modes(rnd(0.22, 0.3), [[rnd(240, 280), 0.25, 0.04]]);
      t.grains(0.25, 0.4, 20, 0.25, 600, 2000, 1.6);
    },
  },
  // Dumpster: a huge steel boom and the lid slamming.
  dumpster: {
    seconds: 1.6,
    make(t) {
      t.thud(0, rnd(70, 85), 30, 0.07, 1, 0.25);
      const b = rnd(110, 140);
      t.modes(0, [
        [b, 0.6, 0.5],
        [b * 1.83, 0.45, 0.4],
        [b * 2.97, 0.35, 0.3],
        [b * 4.4, 0.2, 0.2],
        [b * 6.1, 0.12, 0.12],
      ]);
      t.noise(0, 0.4, 0.6, 0.1, [['bp', 900, 0.8]]);
      t.modes(rnd(0.3, 0.36), [
        [b * 2.6, 0.3, 0.15],
        [b * 4.1, 0.2, 0.1],
      ]);
      t.grains(0.05, 0.9, 25, 0.25, 1200, 4000, 2);
    },
  },
  // Trash bags: a soft thump, plastic rustle and a bottle or two.
  trashBags: {
    seconds: 0.8,
    make(t) {
      t.thud(0, 80, 45, 0.05, 0.6, 0.08);
      t.noise(0, 0.35, 0.45, 0.12, [['bp', rnd(2500, 3500), 0.5]], 0.01, 0.7);
      t.glass(0.05, 0.4, 8, 0.25);
    },
  },
};

/** All impact sound banks. */
export const SFX_BANKS = Object.keys(RECIPES) as Bank[];

/** Render one variant of an impact bank to samples (pure; used by Sfx and the tests). */
export function renderImpact(b: Bank, sampleRate: number): Float32Array<ArrayBuffer> {
  const tape = new Tape(sampleRate, RECIPES[b].seconds);
  RECIPES[b].make(tape);
  return tape.finish();
}

// ---------- live voices ----------

/** Nitrous: a jet like whoosh that climbs in pitch while held. */
class NitroVoice {
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly hp: BiquadFilterNode;
  private readonly bp: BiquadFilterNode;
  private readonly whine: OscillatorNode;
  private readonly whineBp: BiquadFilterNode;
  private readonly gWhine: GainNode;
  private readonly src: AudioBufferSourceNode;
  private p = 0;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
    noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.out.connect(this.panner).connect(bus);
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    // Rushing air: a high pass and a broad band pass that both sweep up.
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.Q.value = 0.9;
    const gAir = ctx.createGain();
    gAir.gain.value = 0.9;
    this.src.connect(this.hp).connect(this.bp).connect(gAir).connect(this.out);
    // Low jet roar underneath.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const gRoar = ctx.createGain();
    gRoar.gain.value = 0.7;
    this.src.connect(lp).connect(gRoar).connect(this.out);
    // Turbine whine: a resonant sawtooth.
    this.whine = ctx.createOscillator();
    this.whine.type = 'sawtooth';
    this.whineBp = ctx.createBiquadFilter();
    this.whineBp.type = 'bandpass';
    this.whineBp.Q.value = 9;
    this.gWhine = ctx.createGain();
    this.gWhine.gain.value = 0.05;
    this.whine.connect(this.whineBp).connect(this.gWhine).connect(this.out);
    this.src.start();
    this.whine.start();
  }

  update(active: boolean, pos: SfxPos, base: number, dt: number): void {
    const t = this.ctx.currentTime;
    // Sweep: climbs over ~1.5 s while held, sinks quickly on release.
    if (active) this.p += (1 - this.p) * (1 - Math.exp(-dt / 1.3));
    else this.p *= Math.exp(-dt / 0.45);
    const p = this.p;
    this.hp.frequency.setTargetAtTime(300 + p * 2100, t, 0.05);
    this.bp.frequency.setTargetAtTime(900 + p * 4200, t, 0.05);
    this.whine.frequency.setTargetAtTime(650 + p * 2700, t, 0.05);
    this.whineBp.frequency.setTargetAtTime(650 + p * 2700, t, 0.05);
    this.gWhine.gain.setTargetAtTime(0.03 + 0.05 * p, t, 0.05);
    const level = active ? base * pos.proximity * (0.6 + 0.4 * p) : 0;
    this.out.gain.setTargetAtTime(level, t, active ? 0.06 : 0.22);
    this.panner.pan.setTargetAtTime(pos.pan, t, 0.05);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    this.src.stop(t + 0.2);
    this.whine.stop(t + 0.2);
    setTimeout(() => this.panner.disconnect(), 400);
  }
}

/** Continuous grind while a car slides along a wall (concrete grit) or rail (metal screech). */
class ScrapeLoop {
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly metalA: BiquadFilterNode;
  private readonly metalB: BiquadFilterNode;
  private readonly grit: BiquadFilterNode;
  private readonly gMetal: GainNode;
  private readonly gGrit: GainNode;
  private readonly src: AudioBufferSourceNode;
  private level = 0;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
    noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.out.connect(this.panner).connect(bus);
    this.src = ctx.createBufferSource();
    this.src.buffer = noise;
    this.src.loop = true;
    this.src.playbackRate.value = 0.8;
    const bp = (q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      return f;
    };
    this.metalA = bp(6);
    this.metalB = bp(9);
    this.grit = bp(0.9);
    this.gMetal = ctx.createGain();
    this.gGrit = ctx.createGain();
    this.src.connect(this.metalA).connect(this.gMetal);
    this.src.connect(this.metalB).connect(this.gMetal);
    this.src.connect(this.grit).connect(this.gGrit);
    this.gMetal.connect(this.out);
    this.gGrit.connect(this.out);
    this.src.start();
  }

  /** target 0..1 from sliding speed; metal 0..1 (rail = 1, wall = 0). */
  update(target: number, metal: number, speed: number, pos: SfxPos, dt: number): void {
    const t = this.ctx.currentTime;
    this.level += (target - this.level) * (1 - Math.exp(-dt / (target > this.level ? 0.03 : 0.12)));
    const f = 1600 + speed * 45 + Math.random() * 260;
    this.metalA.frequency.setTargetAtTime(f, t, 0.02);
    this.metalB.frequency.setTargetAtTime(f * 1.53, t, 0.02);
    this.grit.frequency.setTargetAtTime(500 + speed * 18, t, 0.02);
    // Jitter gives the stick slip texture of a real grind.
    const j = 0.65 + 0.35 * Math.random();
    this.gMetal.gain.setTargetAtTime((0.15 + 1.1 * metal) * j, t, 0.015);
    this.gGrit.gain.setTargetAtTime((1.2 - 0.8 * metal) * (0.75 + 0.25 * Math.random()), t, 0.015);
    this.out.gain.setTargetAtTime(this.level * pos.proximity * 0.5, t, 0.03);
    this.panner.pan.setTargetAtTime(pos.pan, t, 0.05);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.03);
    this.src.stop(t + 0.2);
    setTimeout(() => this.panner.disconnect(), 400);
  }
}

/** Dual tone car horn (two detuned buzzy tones a third apart). Short honk on a tap. */
class HornVoice {
  private readonly out: GainNode;
  private readonly oscs: OscillatorNode[];
  private on = false;
  private downAt = 0;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / 511) * 2 - 1) * 3);
    shaper.curve = curve;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3600;
    shaper.connect(bp).connect(lp).connect(this.out).connect(bus);
    this.oscs = [420, 500].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      o.connect(g).connect(shaper);
      o.start();
      return o;
    });
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    const t = this.ctx.currentTime;
    const g = this.out.gain;
    if (on) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0.3, t, 0.008);
      this.downAt = t;
    } else {
      // A tap still gives a proper honk.
      g.setTargetAtTime(0, Math.max(t, this.downAt + 0.17), 0.025);
    }
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.02);
    for (const o of this.oscs) o.stop(t + 0.2);
    setTimeout(() => this.out.disconnect(), 400);
  }
}

// ---------- crowd recordings ----------

/** Crowd clips in public/sfx (freesound_community, see the credits screen). */
const CROWD_FILES = { cheer: 'sfx/crowd-cheering.mp3', applause: 'sfx/applause.mp3' } as const;
type CrowdClip = keyof typeof CROWD_FILES;
const clipCache = new Map<CrowdClip, Promise<AudioBuffer | null>>();

/**
 * Bake a seamless loop: the last `fade` seconds are cross faded (equal power)
 * into the head, and the result is that much shorter, so looping never clicks.
 */
function seamless(ctx: BaseAudioContext, buf: AudioBuffer, fade: number): AudioBuffer {
  const f = Math.min(Math.floor(fade * buf.sampleRate), Math.floor(buf.length / 3));
  const len = buf.length - f;
  const out = ctx.createBuffer(buf.numberOfChannels, len, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, len));
    for (let i = 0; i < f; i++) {
      const k = i / f;
      dst[i] = src[i] * Math.sqrt(k) + src[len + i] * Math.sqrt(1 - k);
    }
  }
  return out;
}

/** Fetch and decode a crowd clip once per app (shared by every race); null if it cannot load. */
function loadClip(ctx: AudioContext, name: CrowdClip): Promise<AudioBuffer | null> {
  let p = clipCache.get(name);
  if (!p) {
    const base = import.meta.env?.BASE_URL ?? '/';
    p = fetch(`${base}${CROWD_FILES[name]}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => loudEnough(ctx, buf, CROWD_TARGET_DB[name]))
      .then((buf) => (name === 'cheer' ? seamless(ctx, buf, 1.2) : buf))
      .catch(() => null);
    clipCache.set(name, p);
  }
  return p;
}

/**
 * The recordings are quiet (cheer about -28 dB RMS, applause -32 dB with -3 dB
 * clap peaks), so on decode each is brought up to a target RMS (dB) and its
 * peaks rounded off by a soft limiter instead of clipping.
 */
const CROWD_TARGET_DB: Record<CrowdClip, number> = { cheer: -17, applause: -19 };
/** Crowd mix on top of that: stand loops and the cheer / applause one-shots. */
const CROWD_LOOP_GAIN = 3.2;
const CROWD_SHOT_GAIN = 3;

/** A copy of `buf` at the target RMS, peaks soft limited (tanh) below full scale. */
function loudEnough(ctx: AudioContext, buf: AudioBuffer, targetDb: number): AudioBuffer {
  let e = 0;
  let n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) e += d[i] * d[i];
    n += d.length;
  }
  const rms = Math.sqrt(e / Math.max(1, n));
  if (rms < 1e-6) return buf;
  const gain = Math.min(30, 10 ** (targetDb / 20) / rms);
  if (gain <= 1) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  // Linear up to the knee, then tanh rounds the peaks off toward 0.98.
  const knee = 0.6;
  const room = 0.98 - knee;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < src.length; i++) {
      const x = src[i] * gain;
      const a = Math.abs(x);
      dst[i] = a <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((a - knee) / room));
    }
  }
  return out;
}

/** A crowd stand (segment) and its excitement, as the crowd renderer reports it each frame. */
export interface SfxCrowdSpot {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 0 idle murmur, 1 cheering, up to ~1.5 at the finish. */
  level: number;
  /** Sections (closures, corners) only play while the listener is close; gates from further away. */
  kind?: 'gate' | 'section';
}

/** Crowd loops start above this proximity and stop below the second (gates, sections). */
const CROWD_ON = { gate: 0.02, section: 0.06 };
const CROWD_OFF = { gate: 0.01, section: 0.03 };
/** At most this many crowd loops play at once. */
const MAX_CROWD_LOOPS = 8;

/** Crowds are loud: their loudness falls off over a longer distance than impacts (m). */
const CROWD_REF = 40;

/** The looped cheering bed of one stand, filtered and attenuated by distance. */
class CrowdLoop {
  private readonly src: AudioBufferSourceNode;
  private readonly lp: BiquadFilterNode;
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;

  constructor(
    private readonly ctx: AudioContext,
    bus: AudioNode,
    buf: AudioBuffer,
  ) {
    this.src = ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = true;
    this.src.playbackRate.value = rnd(0.94, 1.04);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 1200;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.src.connect(this.lp).connect(this.out).connect(this.panner).connect(bus);
    // Different stands start at different points of the loop so they never phase.
    this.src.start(ctx.currentTime, Math.random() * buf.duration);
  }

  update(level: number, pos: SfxPos, paused: boolean): void {
    const t = this.ctx.currentTime;
    const l = Math.max(0, Math.min(1.6, level));
    const gain = paused ? 0 : pos.proximity * CROWD_LOOP_GAIN * (0.12 + 0.42 * l ** 1.2);
    // Murmur sounds distant and muffled; cheering opens up the top end.
    this.lp.frequency.setTargetAtTime(700 + 15000 * pos.proximity ** 1.2 * (0.35 + 0.65 * Math.min(1, l)), t, 0.25);
    this.out.gain.setTargetAtTime(gain, t, paused ? 0.08 : 0.3);
    this.panner.pan.setTargetAtTime(pos.pan, t, 0.1);
  }

  dispose(): void {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0, t, 0.08);
    this.src.stop(t + 0.5);
    setTimeout(() => this.panner.disconnect(), 700);
  }
}

// ---------- the effects player ----------

const scratch: Contact[] = [];

/** The hardest sliding wall contact of a car right now (render side query of the static world). */
function wallContact(world: World, c: SfxCar): { vt: number; kind: WallHitKind } | null {
  const fx = Math.sin(c.yaw);
  const fz = Math.cos(c.yaw);
  const r0 = c.halfWidth * 0.95;
  const span = Math.max(0, c.halfLength - r0);
  let best: { vt: number; kind: WallHitKind } | null = null;
  for (const u of [-span, 0, span]) {
    const n = world.collideCircle(c.x + fx * u, c.z + fz * u, r0 + 0.18, scratch);
    for (let i = 0; i < n; i++) {
      const k = scratch[i];
      // Moving clearly away from the wall: not grinding.
      if (c.vx * k.nx + c.vz * k.nz > 2.5) continue;
      const vt = Math.abs(-c.vx * k.nz + c.vz * k.nx);
      if (!best || vt > best.vt) best = { vt, kind: k.kind as WallHitKind };
    }
  }
  return best;
}

/** Train rumble mix: overall level, deck boom and joint rattle gains, rattle pulse depth. */
const RUMBLE = { level: 0.5, boom: 4, boomHz: 120, rattle: 1.1, rattleHz: 700, pulse: 0.8, jointSpacing: 7.7 } as const;

/**
 * Elevated train rumble (render/trains.ts): low filtered noise for the deck
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
    this.out.connect(this.pan).connect(h.sfxBus);
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

export class Sfx {
  private readonly ctx: AudioContext;
  private readonly bus: GainNode;
  private readonly noise: AudioBuffer;
  private readonly banks = new Map<Bank, AudioBuffer[]>();
  private voices: { end: number; level: number; out: GainNode }[] = [];
  private readonly recent = new Map<string, { t: number; level: number }>();
  private readonly listener = { x: 0, z: 0, rx: 1, rz: 0 };
  private readonly nitro: (NitroVoice | undefined)[] = [];
  private readonly scrape: (ScrapeLoop | undefined)[] = [];
  private hornVoice: HornVoice | null = null;
  private crowdLoops: (CrowdLoop | undefined)[] = [];
  private cheerBuf: AudioBuffer | null = null;
  private applauseBuf: AudioBuffer | null = null;
  private crowdLoading = false;
  /** Crowd one-shots still playing (faded out on dispose). */
  private crowdShots: GainNode[] = [];
  private lastCount: number | null = null;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  /** Throws if Web Audio is unavailable; check audioHub() first. */
  constructor() {
    const h = audioHub()!;
    this.ctx = h.ctx;
    this.bus = h.sfxBus;
    this.noise = h.noise;
    // Render the impact variants in the background, one per slice, so the first crash has no hitch.
    const pending: Bank[] = [];
    for (let v = 0; v < VARIANTS; v++) pending.push(...SFX_BANKS);
    const warm = () => {
      const b = pending.shift();
      if (!b || this.disposed) return;
      if (this.bank(b, false).length < VARIANTS) this.addVariant(b);
      this.warmTimer = setTimeout(warm, 25);
    };
    this.warmTimer = setTimeout(warm, 300);
  }

  private addVariant(b: Bank): void {
    const data = renderImpact(b, this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    buf.copyToChannel(data, 0);
    this.bank(b, false).push(buf);
  }

  /** The rendered variants of a bank; renders one on demand if none is ready yet. */
  private bank(b: Bank, ensure = true): AudioBuffer[] {
    let bufs = this.banks.get(b);
    if (!bufs) this.banks.set(b, (bufs = []));
    if (ensure && !bufs.length) this.addVariant(b);
    return bufs;
  }

  /** Camera position and its right vector on the ground plane, once per frame. */
  setListener(x: number, z: number, rightX: number, rightZ: number): void {
    const l = this.listener;
    l.x = x;
    l.z = z;
    l.rx = rightX;
    l.rz = rightZ;
  }

  /** Loudness and pan of a world position; the player's car is always close and centered. */
  at(x: number, z: number, isPlayer = false): SfxPos {
    if (isPlayer) return { proximity: 1, pan: 0 };
    const l = this.listener;
    const dx = x - l.x;
    const dz = z - l.z;
    const d = Math.hypot(dx, dz);
    return { proximity: 1 / (1 + (d / 16) ** 2), pan: Math.max(-1, Math.min(1, ((dx * l.rx + dz * l.rz) / Math.max(1, d)) * 0.8)) };
  }

  /**
   * Play one impact buffer. Rate limited per key (a stronger hit may cut in),
   * capped at MAX_VOICES (the quietest voice is stolen), far sounds low passed.
   */
  private play(b: Bank, level: number, rate: number, pos: SfxPos, key: string, minGap = 0.09): void {
    const gain = level * pos.proximity;
    if (this.disposed || gain < 0.015) return;
    const now = this.ctx.currentTime;
    const last = this.recent.get(key);
    if (last && now - last.t < minGap && gain < last.level * 1.6) return;
    this.recent.set(key, { t: now, level: gain });
    this.voices = this.voices.filter((v) => v.end > now);
    if (this.voices.length >= MAX_VOICES) {
      let q = 0;
      for (let i = 1; i < this.voices.length; i++) if (this.voices[i].level < this.voices[q].level) q = i;
      if (this.voices[q].level >= gain) return;
      this.voices[q].out.gain.setTargetAtTime(0, now, 0.015);
      this.voices.splice(q, 1);
    }
    const bufs = this.bank(b);
    const buf = bufs[Math.floor(Math.random() * bufs.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200 + 18000 * pos.proximity ** 1.5;
    const out = this.ctx.createGain();
    out.gain.value = gain;
    const pan = this.ctx.createStereoPanner();
    pan.pan.value = pos.pan;
    src.connect(lp).connect(out).connect(pan).connect(this.bus);
    src.onended = () => pan.disconnect();
    src.start(now);
    this.voices.push({ end: now + buf.duration / rate, level: gain, out });
  }

  /** Car vs car. speed = impact speed (m/s). Heavier hits are louder and lower. */
  crash(speed: number, pos: SfxPos, key = 'crash'): void {
    const k = clamp01(speed / 24);
    this.play('crash', 0.95 * clamp01((speed - 1.2) / 15) ** 0.7, (1.14 - 0.28 * k) * rnd(0.94, 1.06), pos, key);
  }

  /** Car vs static geometry: concrete wall, closure barrier or guard rail. */
  wall(speed: number, kind: WallHitKind, pos: SfxPos, key = `wall:${kind}`): void {
    const k = clamp01(speed / 22);
    // Rails are mostly glancing hits, so their normal speeds are low: more sensitive.
    const level = kind === 'rail' ? clamp01((speed - 0.6) / 11) ** 0.7 * 0.85 : clamp01((speed - 1) / 16) ** 0.7;
    this.play(kind, level, (1.12 - 0.25 * k) * rnd(0.94, 1.06), pos, key, kind === 'rail' ? 0.16 : 0.1);
  }

  /** A prop broken at the given car speed (m/s). */
  prop(kind: PropKind, speed: number, pos: SfxPos, key = 'prop'): void {
    const base: Record<PropKind, number> = {
      streetlight: 0.9,
      trafficLight: 0.85,
      garbageCan: 0.65,
      bench: 0.75,
      busStop: 1,
      bush: 0.45,
      planterPot: 0.8,
      cafeTable: 0.6,
      barrel: 0.6,
      crate: 0.7,
      dumpster: 1,
      newsBox: 0.55,
      trashBags: 0.45,
    };
    const k = clamp01(speed / 25);
    // Props are distinct objects: a short gap only stops one hit playing twice.
    this.play(PROP_SOUND[kind], (base[kind] ?? 0.8) * (0.55 + 0.45 * k), (1.06 - 0.12 * k) * rnd(0.95, 1.05), pos, key, 0.03);
  }

  /** Countdown beep; GO is higher and longer. */
  beep(go: boolean): void {
    if (this.disposed) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = go ? 1760 : 880;
    const dur = go ? 0.8 : 0.17;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.006);
    if (go) g.gain.setTargetAtTime(0.12, t + 0.1, 0.25);
    else g.gain.setValueAtTime(0.22, t + dur - 0.03);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.connect(g).connect(this.bus);
    for (const [type, gain] of [['square', 0.35], ['sine', 0.8]] as [OscillatorType, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = gain;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.02);
      o.onended = () => og.disconnect();
    }
    setTimeout(() => g.disconnect(), (dur + 0.2) * 1000);
  }

  /**
   * Call once per sim tick: beeps when the countdown value shown on the HUD
   * changes (3, 2, 1, GO), so it stays locked to sim ticks in races and replays.
   */
  syncCountdown(r: RaceState): void {
    const left = r.countdownTicks - r.tick;
    const v = left > 0 ? Math.ceil(left / TICK_HZ) : left > -TICK_HZ ? 0 : null;
    if (v !== null && v !== this.lastCount) this.beep(v === 0);
    this.lastCount = v;
  }

  /**
   * React to one sim event (any car). Positions come from the race state, so
   * call it from the tick that consumed the event.
   */
  raceEvent(e: RaceEvent, r: RaceState): void {
    if (e.type !== 'crash' && e.type !== 'wall' && e.type !== 'prop') return;
    const car = r.cars[e.car]?.state;
    if (!car) return;
    const isPlayer = e.car === 0;
    if (e.type === 'crash') {
      const o = e.other ?? -1;
      const other = r.cars[o]?.state;
      // Both cars may report the same contact: one key per pair, heard at the midpoint.
      const x = other ? (car.x + other.x) / 2 : car.x;
      const z = other ? (car.z + other.z) / 2 : car.z;
      this.crash(e.value ?? 0, this.at(x, z, isPlayer || o === 0), `crash:${Math.min(e.car, o)}-${Math.max(e.car, o)}`);
    } else if (e.type === 'wall') {
      this.wall(e.value ?? 0, e.kind ?? 'wall', this.at(car.x, car.z, isPlayer), `wall:${e.car}`);
    } else {
      const props = (r.world as unknown as { blocks?: { props?: { kind: PropKind; x: number; z: number }[] } }).blocks?.props;
      const p = props?.[e.value ?? -1];
      const kind: PropKind = p?.kind && p.kind in PROP_SOUND ? p.kind : 'garbageCan';
      this.prop(kind, car.speed, this.at(p?.x ?? car.x, p?.z ?? car.z, isPlayer), `prop:${e.value}`);
    }
  }

  /** Start loading the crowd clips (lazy: only races with crowds call this). */
  private loadCrowd(): void {
    if (this.crowdLoading) return;
    this.crowdLoading = true;
    void loadClip(this.ctx, 'cheer').then((b) => {
      if (!this.disposed) this.cheerBuf = b;
    });
    void loadClip(this.ctx, 'applause').then((b) => {
      if (!this.disposed) this.applauseBuf = b;
    });
  }

  /** Loudness and pan of a crowd stand: from its nearest point to the listener. */
  private crowdAt(s: { ax: number; az: number; bx: number; bz: number }): SfxPos {
    const l = this.listener;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-6 ? clamp01(((l.x - s.ax) * dx + (l.z - s.az) * dz) / len2) : 0;
    const px = s.ax + dx * t - l.x;
    const pz = s.az + dz * t - l.z;
    const d = Math.hypot(px, pz);
    return { proximity: 1 / (1 + (d / CROWD_REF) ** 2), pan: Math.max(-1, Math.min(1, ((px * l.rx + pz * l.rz) / Math.max(4, d)) * 0.7)) };
  }

  /**
   * Per frame: the cheering bed of every crowd stand, louder as the listener
   * gets close and as the stand gets excited. Pass an empty list for no crowd.
   */
  updateCrowds(spots: readonly SfxCrowdSpot[], paused: boolean): void {
    if (this.disposed || !spots.length) return;
    this.loadCrowd();
    if (!this.cheerBuf) return;
    let playing = 0;
    for (const l of this.crowdLoops) if (l) playing++;
    for (let i = 0; i < spots.length; i++) {
      const pos = this.crowdAt(spots[i]);
      const kind = spots[i].kind ?? 'gate';
      let loop = this.crowdLoops[i];
      if (!loop) {
        // Far stands stay silent until the listener comes near.
        if (pos.proximity < CROWD_ON[kind] || playing >= MAX_CROWD_LOOPS) continue;
        loop = this.crowdLoops[i] = new CrowdLoop(this.ctx, this.bus, this.cheerBuf);
        playing++;
      } else if (pos.proximity < CROWD_OFF[kind]) {
        // Left behind: free the voice for the stands ahead.
        loop.dispose();
        this.crowdLoops[i] = undefined;
        playing--;
        continue;
      }
      loop.update(spots[i].level, pos, paused);
    }
  }

  /**
   * The crowd erupts at a world position (the player crossing the line):
   * a cheering swell, plus applause when `applause` is set. strength 1 = lap,
   * about 1.6 = finish (louder and longer).
   */
  crowdCheer(x: number, z: number, strength: number, applause: boolean): void {
    if (this.disposed) return;
    this.loadCrowd();
    const s = Math.max(0.2, strength);
    const pos = this.crowdAt({ ax: x, az: z, bx: x, bz: z });
    const shot = (buf: AudioBuffer | null, level: number, hold: number, offset: number) => {
      if (!buf || level * pos.proximity < 0.01) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rnd(0.97, 1.03);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level * pos.proximity, t + 0.25);
      g.gain.setTargetAtTime(0, t + hold, 0.8);
      const pan = ctx.createStereoPanner();
      pan.pan.value = pos.pan;
      src.connect(g).connect(pan).connect(this.bus);
      const start = Math.min(offset, Math.max(0, buf.duration - hold - 4));
      src.start(t, start);
      src.stop(t + hold + 4);
      this.crowdShots.push(g);
      src.onended = () => {
        pan.disconnect();
        this.crowdShots = this.crowdShots.filter((x) => x !== g);
      };
    };
    shot(this.cheerBuf, 0.32 * s * CROWD_SHOT_GAIN, 2 + 2.2 * s, rnd(0, 2));
    if (applause) shot(this.applauseBuf, 0.26 * s * CROWD_SHOT_GAIN, 2.5 + 4 * s, rnd(0.5, 3));
  }

  /** A firework shell bursting at a world position; heard with the speed of sound delay. */
  firework(x: number, y: number, z: number, size: number): void {
    if (this.disposed) return;
    const l = this.listener;
    const d = Math.hypot(x - l.x, y - 2, z - l.z);
    const pos: SfxPos = { proximity: 1 / (1 + (d / 60) ** 2), pan: Math.max(-1, Math.min(1, (((x - l.x) * l.rx + (z - l.z) * l.rz) / Math.max(1, d)) * 0.7)) };
    const delay = Math.min(0.6, d / 343);
    const level = (0.35 + 0.35 * Math.min(1.3, size)) * 0.8;
    this.later(() => this.play('firework', level, rnd(0.85, 1.1) / Math.max(0.7, Math.min(1.3, size)) ** 0.3, pos, `fw:${Math.floor(Math.random() * 6)}`, 0), delay);
  }

  /** setTimeout that respects dispose (firework booms arrive late). */
  private later(fn: () => void, seconds: number): void {
    setTimeout(() => {
      if (!this.disposed) fn();
    }, seconds * 1000);
  }

  /** Horn on/off for the player's car (centered). */
  horn(on: boolean): void {
    if (this.disposed || (!on && !this.hornVoice)) return;
    this.hornVoice ??= new HornVoice(this.ctx, this.bus);
    this.hornVoice.set(on);
  }

  /** Per frame: nitrous whoosh and wall/rail grind loops for every car (index 0 = player). */
  updateCars(cars: SfxCar[], world: World | null, dt: number, paused: boolean): void {
    if (this.disposed) return;
    cars.forEach((c, i) => {
      const pos = this.at(c.x, c.z, i === 0);
      const nitroOn = c.nitro && !paused && pos.proximity > 0.01;
      if (nitroOn && !this.nitro[i]) this.nitro[i] = new NitroVoice(this.ctx, this.bus, this.noise);
      this.nitro[i]?.update(nitroOn, pos, i === 0 ? 0.42 : 0.3, dt);

      let target = 0;
      let metal = 0;
      let vt = 0;
      if (world && !paused && pos.proximity > 0.02) {
        const hit = wallContact(world, c);
        if (hit) {
          vt = hit.vt;
          target = clamp01((vt - 2.5) / 20) ** 0.8;
          metal = hit.kind === 'rail' ? 1 : hit.kind === 'barrier' ? 0.4 : 0;
        }
      }
      if (target > 0 && !this.scrape[i]) this.scrape[i] = new ScrapeLoop(this.ctx, this.bus, this.noise);
      this.scrape[i]?.update(target, metal, vt, pos, dt);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    const t = this.ctx.currentTime;
    for (const v of this.voices) v.out.gain.setTargetAtTime(0, t, 0.03);
    this.voices = [];
    this.nitro.forEach((n) => n?.dispose());
    this.scrape.forEach((s) => s?.dispose());
    this.hornVoice?.dispose();
    this.crowdLoops.forEach((c) => c?.dispose());
    this.crowdLoops = [];
    for (const g of this.crowdShots) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, 0.1);
    }
    this.crowdShots = [];
  }
}
