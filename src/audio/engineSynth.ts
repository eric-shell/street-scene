/**
 * Pure engine sound synthesis: the model behind every engine voice, with no
 * Web Audio in it so the same code runs inside an AudioWorklet and headless
 * in tests. The structure follows Ange Yaghi's Engine Simulator
 * (github.com/ange-yaghi/engine-sim, MIT) with its gas simulation replaced by
 * a shaped pulse per combustion event:
 *
 *  1. Each cylinder fires at its place in the cycle (the layout's firing
 *     order and bank) and its exhaust pulse reaches the tailpipe after
 *     travelling its own header primary plus the exhaust system at the speed
 *     of sound. Unequal paths arrive late and weaker, which is where a
 *     boxer's rumble and a cross-plane V8's burble come from: the per-pipe
 *     pulse train turns uneven even though the crank fires evenly.
 *  2. Per tailpipe the train is band limited (engine-sim's 1.9 kHz input
 *     filter), time jittered, DC blocked, then mixed as derivative (what a
 *     pipe end radiates) plus the pressure itself amplitude modulated by
 *     turbulence noise.
 *  3. A peak leveler keeps the sum at a steady level across rpm; the caller
 *     shapes loudness with load and distance. The silencer and pipe column
 *     are a synthesized impulse response (renderImpulse) the voice convolves
 *     with on the main thread, standing in for engine-sim's recorded ones.
 *
 * Besides the exhaust the renderer gives the intake (a pulse per firing half a
 * cycle later, loud only with the throttle open; a resonant filter outside
 * makes individual throttle bodies honk) and the body (the valvetrain tick
 * you hear at idle), a ragged limiter cut, and the overrun pops: a fourth
 * output, dry, since a backfire goes off at the tip, past the silencer.
 * Deterministic: all randomness comes from a seeded xorshift.
 */
import type { EngineLayout, EngineSpec, EngineVoiceSpec } from '../shared/carSpec';
import { ENGINE_LAYOUTS } from '../shared/carSpec';
import { Biquad, kWeighting, powerSpectrum } from './dsp';

// The chain model's filters, which the tests also build.
export { Biquad, kWeighting };

/** Speed of sound for exhaust path delays (m/s); engine-sim's figure, hot gas would be faster. */
const SOUND = 343;
/** How much further the second of two tailpipes runs (m). */
const CROSSOVER = 0.05;
/** Share of each pulse an H-pipe or X-pipe passes to the other tailpipe: a balance tube leaks a little, an X nearly halves. */
const CROSSOVER_SHARE = { none: 0, h: 0.2, x: 0.45 } as const;

export interface CylinderProgram {
  /** When this cylinder fires, as a fraction of the combustion cycle (720° for a four stroke, 360° for a rotor). */
  fire: number;
  /** Extra travel of this cylinder's pulse to the tailpipe beyond the shortest path (s). */
  delay: number;
  /** Which tailpipe the pulse arrives in. */
  pipe: number;
  /** Share of the pulse an H- or X-pipe hands to the other tailpipe (0 with one pipe or none). */
  cross: number;
  /** Pulse amplitude relative to the shortest path (longer paths arrive weaker). */
  gain: number;
}

export interface PulseShape {
  /** Blowdown rise, in cycle fractions. */
  rise: number;
  /** Exhaust stroke pressure decay, in cycle fractions. */
  decay: number;
  /** Depth of the scavenging dip after the pulse (0..1). */
  dip: number;
}

export interface ImpulseSpec {
  /** Impulse response length (s). */
  seconds: number;
  /**
   * Resonances as decaying sines, [Hz, Q, boost]: pipe column modes, the silencer chamber, the tailpipe ring.
   * `boost` is the linear gain at resonance over the direct path (2 is +6 dB); the sine's amplitude follows from it
   * and the Q, which is what keeps a 60 ms ring from being a +40 dB peak.
   */
  modes: [number, number, number][];
  /** Diffuse tail: decay (s), its energy relative to the direct path (0.5 is half), low pass (Hz). */
  tail: { decay: number; energy: number; lowpass: number };
  seed: number;
}

export interface EngineProgram {
  /** Crank revolutions per combustion cycle: 2 for a four stroke, 1 for a rotor. */
  revsPerCycle: number;
  cylinders: CylinderProgram[];
  pipes: number;
  pulse: PulseShape;
  /** Band limit on the raw pulse train (Hz); a turbine downstream lowers it. */
  lowpass: number;
  /** Timing noise on the pulse train, in samples at 44.1 kHz. */
  jitter: number;
  /** Derivative share: how much of the voice is the pipe end's radiation (bright, raspy). */
  edge: number;
  /** Turbulence: noise amplitude modulation depth 0..1. */
  air: number;
  /** Intake voice: gain, trumpet resonance (Hz) and its Q. */
  intake: { gain: number; hz: number; q: number };
  /** Valvetrain tick level at each firing. */
  mech: number;
  /** How freely the silencer lets overrun pops through (0 none, 1 sport, 2.5 straight through); the voice's rich overrun model scales its chances by it. */
  pops: number;
  /** Per-firing amplitude variance at idle (fraction); the lope. */
  rough: number;
  ir: ImpulseSpec;
  /** Level trim that brings this program to LOUDNESS_REF through the chain model (estimateLoudness). */
  trim: number;
  /** Noise seed; every voice gets its own so rivals never phase lock. */
  seed: number;
}

export interface SynthParams {
  rpm: number;
  redline: number;
  /** Drive pedal 0..1. */
  load: number;
  /** 1 while a gear change cuts the drive. */
  cut: number;
  /** 1 while bouncing off the rev limiter. */
  limiter: number;
  nitro: number;
}

/** The parameters as the worklet declares them (k-rate AudioParams the voice ramps) and the voice looks them up. */
export const SYNTH_PARAMS = [
  { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 20000 },
  { name: 'redline', defaultValue: 7000, minValue: 1000, maxValue: 20000 },
  { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1 },
  { name: 'cut', defaultValue: 0, minValue: 0, maxValue: 1 },
  { name: 'limiter', defaultValue: 0, minValue: 0, maxValue: 1 },
  { name: 'nitro', defaultValue: 0, minValue: 0, maxValue: 1 },
] as const satisfies readonly { name: keyof SynthParams; defaultValue: number; minValue: number; maxValue: number }[];

/** What the voice posts to the worklet: 'stop' ends processing so the node can be collected, a pop fires an overrun bang or crackle (EngineSynth.pop). */
export type EngineMessage = 'stop' | { pop: { at: number; pipe: number; gain: number; size: number } };

// ---------------------------------------------------------------------------
// Programs: from a car's engine spec to the numbers above
// ---------------------------------------------------------------------------

/** One combustion event: [bank, position along the bank]; the list is in firing order and even fire. */
type Firing = [number, number];

const inline = (order: number[], split = Infinity): Firing[] => order.map((c) => (c <= split ? [0, c - 1] : [1, c - split - 1]));

/** 60° V12 1-7-5-11-3-9-6-12-2-8-4-10: every bank is an inline six. */
const V12: Firing[] = [[0, 0], [1, 0], [0, 4], [1, 4], [0, 2], [1, 2], [0, 5], [1, 5], [0, 1], [1, 1], [0, 3], [1, 3]];

/**
 * Firing schedules by layout, cylinders numbered the way the makers do.
 * Where a layout's sound depends on the crank the V8 has two entries.
 */
const SCHEDULE: Record<Exclude<EngineLayout, 'V8'> | 'V8cross' | 'V8flat', Firing[]> = {
  I3: inline([1, 3, 2]),
  I4: inline([1, 3, 4, 2]),
  I5: inline([1, 2, 4, 5, 3]),
  // 1-5-3-6-2-4; the usual 6-2-1 headers group 1-3 and 4-6.
  I6: inline([1, 5, 3, 6, 2, 4], 3),
  // Boxer 1-3-2-4 with 1 and 3 on the same bank: opposed pairs share crank timing, so a bank fires twice in a row then rests for a turn.
  B4: [[0, 0], [0, 1], [1, 0], [1, 1]],
  // Flat six 1-6-2-4-3-5, cylinders 1-3 on one bank: each bank an even three.
  B6: [[0, 0], [1, 2], [0, 1], [1, 0], [0, 2], [1, 1]],
  // 60° V6 1-2-3-4-5-6, odd cylinders on one bank: the banks alternate.
  V6: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]],
  // One head, one manifold, but a narrow V: odd cylinders on one side, so 1-5-3-6-2-4 fires three from one side
  // then three from the other. With that side's runners longer (unequal headers) the beat lands once a cycle:
  // the VR6's growl. Its runners are staggered within a side too (see stagger).
  VR6: [1, 5, 3, 6, 2, 4].map((c) => (c % 2 ? [0, (c - 1) / 2] : [1, c / 2 - 1]) as Firing),
  // Cross-plane 90° V8 1-8-7-2-6-5-4-3, odd cylinders left: a bank gets 180-270-180-90, the burble.
  V8cross: [[0, 0], [1, 3], [0, 3], [1, 0], [1, 2], [0, 2], [1, 1], [0, 1]],
  // Flat-plane 1-5-3-7-4-8-2-6, cylinders 1-4 on one bank: banks alternate like two inline fours.
  V8flat: [[0, 0], [1, 0], [0, 2], [1, 2], [0, 3], [1, 3], [0, 1], [1, 1]],
  // 72° V10 1-10-9-4-3-6-5-8-7-2, cylinders 1-5 on one bank.
  V10: [[0, 0], [1, 4], [1, 3], [0, 3], [0, 2], [1, 0], [0, 4], [1, 2], [1, 1], [0, 1]],
  V12,
  W12: V12,
  W16: Array.from({ length: 16 }, (_, k) => [k % 4, Math.floor(k / 4)] as Firing),
  R2: [[0, 0], [0, 1]],
  R3: [[0, 0], [0, 1], [0, 2]],
};

interface LayoutVoice {
  pipes: 1 | 2;
  headers: 'equal' | 'unequal';
  /** Extra primary length on the long bank when the headers are unequal (m). */
  headerSpread: number;
  crossover: 'none' | 'h' | 'x';
  edge: number;
  air: number;
  jitter: number;
  rough: number;
  mech: number;
  /** Extra path on every other cylinder (m): the VR6's staggered runners, an inline five's warble. */
  stagger: number;
  pulse: PulseShape;
  /** Intake trumpet resonance (Hz). */
  intakeHz: number;
}

const BASE: LayoutVoice = { pipes: 1, headers: 'equal', headerSpread: 0.5, crossover: 'none', edge: 0.9, air: 0.75, jitter: 5, rough: 0.08, mech: 0.5, stagger: 0, pulse: { rise: 0.012, decay: 0.07, dip: 0.35 }, intakeHz: 520 };
const ROTARY: LayoutVoice = { ...BASE, edge: 1.1, air: 0.9, rough: 0.05, mech: 0.3, pulse: { rise: 0.03, decay: 0.12, dip: 0.3 }, intakeHz: 600 };
const TWELVE: LayoutVoice = { ...BASE, pipes: 2, edge: 1.0, air: 0.65, rough: 0.04, intakeHz: 720 };

/** The character each layout starts from before the car's own voice spec. */
export const LAYOUT_VOICE: Record<EngineLayout, LayoutVoice> = {
  I3: { ...BASE, rough: 0.12, mech: 0.55 },
  I4: BASE,
  I5: { ...BASE, rough: 0.1, stagger: 0.03, intakeHz: 560 },
  I6: { ...BASE, pipes: 2, edge: 1.0, air: 0.7, rough: 0.05, intakeHz: 620 },
  B4: { ...BASE, headers: 'unequal', edge: 0.8, air: 0.85, rough: 0.14, mech: 0.6 },
  B6: { ...BASE, pipes: 2, edge: 1.0, rough: 0.06, intakeHz: 650 },
  V6: { ...BASE, edge: 0.85, air: 0.8 },
  VR6: { ...BASE, headers: 'unequal', headerSpread: 0.3, stagger: 0.07 },
  V8: { ...BASE, pipes: 2, edge: 0.7, air: 0.85, rough: 0.1, mech: 0.4, pulse: { rise: 0.012, decay: 0.08, dip: 0.35 } },
  V10: { ...BASE, pipes: 2, edge: 0.95, rough: 0.06, intakeHz: 700 },
  V12: TWELVE,
  W12: TWELVE,
  W16: { ...TWELVE, edge: 0.9, air: 0.7 },
  R2: ROTARY,
  R3: ROTARY,
};

/**
 * Silencers: exhaust system length (m), band limit (Hz), how freely pops get through, and the response recipe:
 * the pipe column's first three modes (Q and boost of the first, the rest fall off), the chamber [Hz, Q, boost],
 * the tailpipe ring [Hz, Q, boost] (none for a quiet box) and the diffuse tail.
 */
const MUFFLER = {
  // A big box rounds the top off and adds body, but not a hallway: its diffuse tail stays short.
  quiet: { system: 2.8, lowpass: 1800, pops: 0.3, pipeQ: 8, pipeBoost: 2.2, chamber: [110, 5, 2.2], ring: null, seconds: 0.2, tail: { decay: 0.06, energy: 0.3, lowpass: 1600 } },
  sport: { system: 2.3, lowpass: 2000, pops: 1.2, pipeQ: 7, pipeBoost: 2.2, chamber: [140, 4, 1.8], ring: [1800, 12, 1.5], seconds: 0.2, tail: { decay: 0.07, energy: 0.4, lowpass: 2600 } },
  straight: { system: 1.7, lowpass: 2600, pops: 2.5, pipeQ: 6, pipeBoost: 1.8, chamber: [180, 3, 1.4], ring: [2100, 15, 2.2], seconds: 0.15, tail: { decay: 0.04, energy: 0.3, lowpass: 5000 } },
} as const;

/** Header primary from the valve to the collector (m): tubular headers, or the short log manifold feeding a turbine. */
function primaryLength(v: LayoutVoice & EngineVoiceSpec, turbo: boolean, bank: number, slot: number): number {
  const unequal = v.headers === 'unequal';
  const base = turbo && !unequal ? 0.15 : 0.55;
  const step = turbo && !unequal ? 0.05 : 0.015;
  let len = base + step * slot + (slot % 2) * v.stagger;
  // One bank's runners run further: the Subaru's left bank crosses under the engine to the right bank's
  // collector, the VR6's far side reaches round the narrow V.
  if (unequal && bank === 1) len += v.headerSpread;
  return len;
}

/** Pipe column modes of an open pipe `system` m long, half wave spaced; higher modes are damped more and boost less. */
function pipeModes(system: number, q: number, boost: number, count: number): [number, number, number][] {
  const f1 = SOUND / (2 * system);
  return Array.from({ length: count }, (_, n) => [f1 * (n + 1), q / (1 + 0.3 * n), 1 + (boost - 1) / (1 + 0.8 * n)]);
}

/** Build the program for a car's engine. `lite` is for rivals: shorter response, no intake or body detail. */
export function buildProgram(spec: EngineSpec, opts: { seed?: number; lite?: boolean } = {}): EngineProgram {
  const layout = ENGINE_LAYOUTS[spec.layout];
  const v = { ...LAYOUT_VOICE[spec.layout], ...spec.voice };
  const turbo = spec.aspiration === 'turbo';
  const seed = (opts.seed ?? 1) | 0 || 1;
  const muffler = MUFFLER[v.muffler ?? (turbo ? 'quiet' : 'sport')];
  const crank = v.crank ?? 'cross';
  const firings = spec.layout === 'V8' ? SCHEDULE[crank === 'flat' ? 'V8flat' : 'V8cross'] : SCHEDULE[spec.layout];

  // True duals are never quite equal: the second pipe runs a little further, so the two banks' trains never cancel when the ear sums them.
  const crossover = v.pipes === 2 ? CROSSOVER : 0;
  const primaries = firings.map(([bank, slot]) => primaryLength(v, turbo, bank, slot) + (bank % 2 === 1 ? crossover : 0));
  const shortest = Math.min(...primaries);
  const cylinders: CylinderProgram[] = firings.map(([bank], i) => ({
    fire: i / firings.length,
    // Every pulse also crosses the exhaust system, the same for all, so only the primaries set the arrival spread.
    delay: (primaries[i] - shortest) / SOUND,
    pipe: bank % v.pipes,
    cross: v.pipes === 2 ? CROSSOVER_SHARE[v.crossover] : 0,
    // engine-sim scales a pulse by 1 / length²; a 1 m reference keeps header differences audible without the system length drowning them.
    gain: ((shortest + 1) / (primaries[i] + 1)) ** 2,
  }));

  // A turbine between the ports and the pipe smears every pulse and eats the top end.
  const smear = turbo ? 1 : 0;
  const pulse: PulseShape = { rise: v.pulse.rise * (1 + 1.5 * smear), decay: v.pulse.decay * (1 + 0.5 * smear), dip: v.pulse.dip * (1 - 0.3 * smear) };
  const itb = v.intake === 'itb';
  const edge = v.edge * (1 - 0.3 * smear);
  const modes: [number, number, number][] = [...pipeModes(muffler.system, muffler.pipeQ, muffler.pipeBoost, 3), [...muffler.chamber]];
  if (muffler.ring) modes.push([...muffler.ring]);
  const ir: ImpulseSpec = { seconds: muffler.seconds * (opts.lite ? 0.5 : 1), modes, tail: muffler.tail, seed };
  const program: EngineProgram = {
    revsPerCycle: layout.rotary ? 1 : 2,
    cylinders,
    pipes: v.pipes,
    pulse,
    lowpass: muffler.lowpass * (1 - 0.12 * smear),
    jitter: v.jitter,
    edge,
    air: Math.min(1, v.air + 0.1 * smear),
    intake: { gain: opts.lite ? 0 : itb ? 0.55 : 0.15, hz: v.intakeHz, q: itb ? 2.5 : 1.4 },
    mech: opts.lite ? 0 : v.mech * 0.7,
    pops: muffler.pops * (turbo ? 0.6 : 1),
    rough: v.rough,
    ir,
    trim: 1,
    seed,
  };
  // Every program lands on one K-weighted loudness through a model of the voice's chain, whatever its spectrum,
  // pipes or intake: the trim is measured, never hand set, so new layouts and silencers stay matched.
  program.trim = Math.max(0.25, Math.min(4, LOUDNESS_REF / estimateLoudness(program)));
  return program;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Pulse wavetable entries per cycle: fine enough that the derivative of its linear interpolation never steps audibly at idle. */
const TABLE = 8192;
const RING = 64;
/**
 * Every voice renders two tailpipe tips, left and right: a twin pipe car one bank each, a single exhaust the same
 * train through two tips with their own turbulence and jitter and this much path difference (s), so it is as wide.
 */
const TIPS = 2;
const TWIN_TIP = 0.0003;
/** Derivative weight per sample at 44.1 kHz, so the mix does not depend on the sample rate. */
const DERIV = 30;
/** Makes the low passed noise's modulation about half depth at full `air`. */
const AIR = 3.5;
/** Turbulence noise band (Hz): above this it is hiss, not breathing. */
const AIR_HZ = 1200;
/** Jitter wander band (Hz): slow enough to read as the pipe moving, not as grain. */
const JITTER_HZ = 600;
/**
 * The overrun pop as a gunshot at the tip: a sub-millisecond crack (an impulse and a burst of white noise), the
 * thump of the pipe's air column sweeping down, and a darker tail. Time constants in s, `bang` scales each from a
 * crackle (size 0) to a full bang (size 1); `len` is the slot's whole life; `cross` is how much of a twin pipe car's
 * pop the other tip hears; `hp` the DC block (Hz) that keeps the impulse from leaving an offset.
 */
const POP = {
  len: [0.07, 0.32],
  click: 0.00035,
  crack: [0.0012, 0.0025],
  crackGain: 0.8,
  thump: { from: 190, to: 55, sweep: 0.012, tau: [0.012, 0.05], gain: [0.25, 0.9] },
  tail: { tau: [0.02, 0.1], gain: [0.08, 0.3], hz: 900 },
  cross: 0.35,
  hp: 30,
} as const;
/** Leveler target (RMS); peaks land around 0.4 to 0.8 and the soft clip after it keeps them bounded. */
const TARGET = 0.1;
const MAX_POPS = 8;

/** One cycle of exhaust pressure as a wavetable over the cycle fraction u, mean removed. */
function pulseTable(shape: PulseShape, n = TABLE): Float32Array<ArrayBuffer> {
  const t = new Float32Array(n + 1);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    let v: number;
    if (u < shape.rise) v = 0.5 - 0.5 * Math.cos((Math.PI * u) / shape.rise);
    else {
      const x = u - shape.rise;
      v = Math.exp(-x / shape.decay) - shape.dip * (1 - Math.exp(-x / (shape.decay * 0.6))) * Math.exp(-x / (shape.decay * 3));
    }
    t[i] = v;
    mean += v;
  }
  mean /= n;
  for (let i = 0; i < n; i++) t[i] -= mean;
  t[n] = t[0];
  return t;
}

/** xorshift32 in [0, 1). */
function nextRand(s: { v: number }): number {
  let x = s.v;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.v = x;
  return (x >>> 0) / 4294967296;
}

/**
 * The silencer and pipe column as an impulse response: a unit direct path, resonances sized so each peaks `boost`
 * above it (a decaying sine of amplitude A and time constant τ samples has gain A τ / 2 at its frequency), and a
 * diffuse tail sized by its energy against the direct path. Peak normalized, which the direct path keeps near 1.
 */
export function renderImpulse(spec: ImpulseSpec, sampleRate: number): Float32Array<ArrayBuffer> {
  const n = Math.max(1, Math.round(spec.seconds * sampleRate));
  const out = new Float32Array(n);
  out[0] = 1;
  for (const [hz, q, boost] of spec.modes) {
    const w = (2 * Math.PI * hz) / sampleRate;
    const tau = (q / (Math.PI * hz)) * sampleRate;
    const amp = (2 * boost) / tau;
    for (let t = 0; t < n; t++) out[t] += amp * Math.sin(w * t) * Math.exp(-t / tau);
  }
  const rng = { v: spec.seed | 0 || 1 };
  const coef = 1 - Math.exp((-2 * Math.PI * spec.tail.lowpass) / sampleRate);
  // Uniform noise through the one pole has variance (1 / 3) coef / (2 - coef); the decaying tail's energy is that times τ / 2.
  const tau = spec.tail.decay * sampleRate;
  const variance = (coef / (2 - coef)) / 3;
  const gain = Math.sqrt((2 * spec.tail.energy) / (variance * tau));
  let nz = 0;
  for (let t = 0; t < n; t++) {
    nz += (nextRand(rng) * 2 - 1 - nz) * coef;
    out[t] += nz * gain * Math.exp(-t / tau);
  }
  let peak = 0;
  for (let t = 0; t < n; t++) peak = Math.max(peak, Math.abs(out[t]));
  if (peak > 0) for (let t = 0; t < n; t++) out[t] /= peak;
  return out;
}

export class EngineSynth {
  readonly program: EngineProgram;
  private readonly sr: number;
  private readonly exhaustTable: Float32Array;
  private readonly intakeTable: Float32Array;
  private readonly fire: Float64Array;
  private readonly delay: Float64Array;
  private readonly pipe: Int32Array;
  /** Per cylinder: the share its pulse hands to the other pipe through a crossover. */
  private readonly cross: Float64Array;
  private readonly cgain: Float64Array;
  private readonly lastU: Float64Array;
  private readonly fireGain: Float64Array;
  private readonly pipeSum: Float64Array;
  /** Each tip's output after its post chain (TIPS entries, or one per pipe). */
  private readonly post: Float64Array;
  private readonly twin: number;
  private readonly lpA: Float64Array;
  private readonly lpB: Float64Array;
  private readonly ring: Float32Array;
  private readonly jit: Float64Array;
  private readonly dc: Float64Array;
  private readonly prevY: Float64Array;
  private readonly airNz: Float64Array;
  private readonly popStart = new Float64Array(MAX_POPS).fill(-1);
  private readonly popLeft = new Int32Array(MAX_POPS);
  private readonly popLen = new Int32Array(MAX_POPS);
  private readonly popPipe = new Int32Array(MAX_POPS);
  private readonly popGain = new Float64Array(MAX_POPS);
  private readonly popSize = new Float64Array(MAX_POPS);
  /** Each pop slot's thump phase (cycles) and dark tail noise. */
  private readonly popPhase = new Float64Array(MAX_POPS);
  private readonly popTail = new Float64Array(MAX_POPS);
  /** The pops per tip this sample, and their DC blocks; the pop output is apart from the leveler, so nothing ducks them. */
  private readonly popMix: Float64Array;
  private readonly popDc: Float64Array;
  private readonly popHp: number;
  private readonly popTailCoef: number;
  private readonly tickLen: number;
  private lastTick = -1e9;
  private readonly rng: { v: number };
  private readonly dcCoef: number;
  private readonly airCoef: number;
  private readonly jitCoef: number;
  private readonly derivK: number;
  private theta = 0;
  private ringPos = 0;
  private tickLeft = 0;
  private tickGain = 0;
  private env = TARGET * TARGET;
  private agc = 1;
  private samples = 0;

  constructor(program: EngineProgram, sampleRate: number) {
    this.program = program;
    this.sr = sampleRate;
    const n = program.cylinders.length;
    this.exhaustTable = pulseTable(program.pulse);
    this.intakeTable = pulseTable({ rise: 0.02, decay: 0.05, dip: 0.5 });
    this.fire = new Float64Array(program.cylinders.map((c) => c.fire));
    this.delay = new Float64Array(program.cylinders.map((c) => c.delay));
    this.pipe = new Int32Array(program.cylinders.map((c) => c.pipe));
    this.cross = new Float64Array(program.cylinders.map((c) => c.cross ?? 0));
    this.cgain = new Float64Array(program.cylinders.map((c) => c.gain / n));
    this.lastU = new Float64Array(n);
    this.fireGain = new Float64Array(n).fill(0.5 / n);
    const p = Math.max(program.pipes, TIPS);
    this.pipeSum = new Float64Array(program.pipes);
    this.post = new Float64Array(p);
    this.lpA = new Float64Array(p);
    this.lpB = new Float64Array(p);
    this.ring = new Float32Array(p * RING);
    this.jit = new Float64Array(p);
    this.dc = new Float64Array(p);
    this.prevY = new Float64Array(p);
    this.airNz = new Float64Array(p);
    this.popMix = new Float64Array(p);
    this.popDc = new Float64Array(p);
    this.twin = Math.round(TWIN_TIP * sampleRate);
    this.tickLen = Math.round(0.0015 * sampleRate);
    this.rng = { v: program.seed | 0 || 1 };
    this.dcCoef = 1 - Math.exp((-2 * Math.PI * 10) / sampleRate);
    this.airCoef = 1 - Math.exp((-2 * Math.PI * AIR_HZ) / sampleRate);
    this.jitCoef = 1 - Math.exp((-2 * Math.PI * JITTER_HZ) / sampleRate);
    this.popHp = 1 - Math.exp((-2 * Math.PI * POP.hp) / sampleRate);
    this.popTailCoef = 1 - Math.exp((-2 * Math.PI * POP.tail.hz) / sampleRate);
    this.derivK = (DERIV * sampleRate) / 44100;
  }

  /**
   * Fire an overrun pop `at` seconds from now through `pipe`: size 1 is a bang
   * (a long thump and tail behind the crack), 0 a crackle (all crack); `gain`
   * is its peak on the pop output before the soft clip, independent of the
   * engine's level (a levelled tip runs near 0.1 RMS, so a 0.9 bang stands well
   * clear of it, as a gunshot does). The voice decides when (its rich overrun
   * model), so the sound and the exhaust flash are one event.
   */
  pop(at: number, pipe: number, gain: number, size: number): void {
    for (let k = 0; k < MAX_POPS; k++) {
      if (this.popStart[k] >= 0 || this.popLeft[k] > 0) continue;
      this.popStart[k] = this.samples + Math.round(Math.max(0, at) * this.sr);
      this.popPipe[k] = Math.max(0, Math.min(this.program.pipes - 1, pipe | 0));
      this.popGain[k] = gain;
      this.popSize[k] = size;
      this.popLen[k] = Math.round((POP.len[0] + (POP.len[1] - POP.len[0]) * size) * this.sr);
      this.popPhase[k] = 0;
      this.popTail[k] = 0;
      return;
    }
  }

  /**
   * Render one block for parameters held over the block: the exhaust with one
   * channel per tailpipe (a single channel sums every pipe), the intake and the
   * body mono, and the pops a channel per tip (dropped when `pops` is missing).
   */
  render(exhaust: Float32Array[], intake: Float32Array, body: Float32Array, q: SynthParams, pops?: Float32Array[]): void {
    const P = this.program;
    const n = intake.length;
    const channels = exhaust.length;
    const nc = this.fire.length;
    const sr = this.sr;
    const rpm = Math.max(300, q.rpm);
    const r = Math.min(1.05, rpm / Math.max(1000, q.redline));
    const cycleHz = rpm / 60 / P.revsPerCycle;
    const dTheta = cycleHz / sr;
    const cut = q.cut > 0.5;
    const limiter = q.limiter > 0.5;
    const nitro = q.nitro > 0.5;
    const load = cut ? 0 : Math.max(0, Math.min(1, q.load));
    const amp = (0.12 + 0.88 * load ** 0.8) * (nitro ? 1.2 : 1);
    const intakeAmp = (P.intake.gain * load ** 1.5 * (0.3 + 0.7 * Math.min(1, rpm / 6000))) / nc;
    const lowpass = Math.min(sr * 0.45, P.lowpass * (nitro ? 1.3 : 1) * (0.85 + 0.15 * load));
    const lpCoef = 1 - Math.exp((-2 * Math.PI * lowpass) / sr);
    const jitter = (P.jitter * sr) / 44100;
    const rough = P.rough * (0.3 + 0.7 * (1 - load));
    const edge = P.edge * this.derivK;
    const air = P.air;
    const envAtk = 1 - Math.exp(-1 / (0.01 * sr));
    const envRel = 1 - Math.exp(-1 / (0.25 * sr));
    const agcUp = 1 - Math.exp(-1 / (0.15 * sr));
    const agcDown = 1 - Math.exp(-1 / (0.005 * sr));
    const tickGap = Math.round(0.025 * sr);

    const T = this.exhaustTable;
    const TI = this.intakeTable;
    for (let i = 0; i < n; i++) {
      let theta = this.theta + dTheta;
      if (theta >= 1) theta -= 1;
      this.theta = theta;
      this.pipeSum.fill(0);
      this.popMix.fill(0);
      let inSum = 0;
      for (let c = 0; c < nc; c++) {
        let u = theta - this.fire[c] - this.delay[c] * cycleHz;
        u -= Math.floor(u);
        if (u < this.lastU[c]) {
          // A new firing: combustion varies shot to shot, most at idle; the limiter drops some entirely.
          let g = amp * (1 + rough * (nextRand(this.rng) * 2 - 1));
          if (limiter && nextRand(this.rng) < 0.45) g = 0;
          this.fireGain[c] = g * this.cgain[c];
          // Valvetrain tick: audible at idle and on a closed throttle, never a hiss at speed (one burst per 25 ms at most, gone by three quarters of the redline).
          if (P.mech > 0 && r < 0.75 && this.samples - this.lastTick > tickGap) {
            this.lastTick = this.samples;
            this.tickLeft = this.tickLen;
            this.tickGain = P.mech * (0.3 + 0.7 * (1 - load)) * (1 - r / 0.75) * (0.7 + 0.6 * nextRand(this.rng));
          }
        }
        this.lastU[c] = u;
        const x = u * TABLE;
        const k = x | 0;
        const fr = x - k;
        const pulse = (T[k] + (T[k + 1] - T[k]) * fr) * this.fireGain[c];
        const cross = this.cross[c];
        this.pipeSum[this.pipe[c]] += pulse * (1 - cross);
        if (cross > 0) this.pipeSum[1 - this.pipe[c]] += pulse * cross;
        if (intakeAmp > 0) {
          let w = theta - this.fire[c] + 0.5;
          w -= Math.floor(w);
          const xi = w * TABLE;
          const ki = xi | 0;
          inSum += TI[ki] + (TI[ki + 1] - TI[ki]) * (xi - ki);
        }
      }
      // Pops (POP): the crack, the thump sweeping down and the dark tail, out of one tip (both on a single exhaust).
      for (let k = 0; k < MAX_POPS; k++) {
        if (this.popStart[k] >= 0 && this.samples >= this.popStart[k]) {
          this.popStart[k] = -1;
          this.popLeft[k] = this.popLen[k];
        }
        if (this.popLeft[k] > 0) {
          const t = (this.popLen[k] - this.popLeft[k]) / sr;
          const size = this.popSize[k];
          const nz = nextRand(this.rng) * 2 - 1;
          let v = Math.exp(-t / POP.click) + POP.crackGain * nz * Math.exp(-t / (POP.crack[0] + (POP.crack[1] - POP.crack[0]) * size));
          const T = POP.thump;
          this.popPhase[k] += (T.to + (T.from - T.to) * Math.exp(-t / T.sweep)) / sr;
          v += (T.gain[0] + (T.gain[1] - T.gain[0]) * size) * Math.sin(2 * Math.PI * this.popPhase[k]) * Math.exp(-t / (T.tau[0] + (T.tau[1] - T.tau[0]) * size));
          const L = POP.tail;
          this.popTail[k] += (nz - this.popTail[k]) * this.popTailCoef;
          v += (L.gain[0] + (L.gain[1] - L.gain[0]) * size) * 4 * this.popTail[k] * Math.exp(-t / (L.tau[0] + (L.tau[1] - L.tau[0]) * size));
          const g = this.popGain[k] * v;
          const pp = this.popPipe[k];
          this.popMix[pp] += g;
          // One silencer, two tips: the pop leaves both. A twin pipe car's other tip hears some of it.
          if (P.pipes === 1) this.popMix[1] += g;
          else this.popMix[1 - pp] += g * POP.cross;
          this.popLeft[k]--;
        }
      }

      let sum = 0;
      const pos = this.ringPos;
      const tips = this.post.length;
      for (let p = 0; p < tips; p++) {
        // Band limit (two poles), then read the train back through a wandering delay: the jitter. A single
        // exhaust's second tip reads the same train a little later, through its own wander and turbulence.
        const src = this.pipeSum[Math.min(p, this.pipeSum.length - 1)];
        this.lpA[p] += (src - this.lpA[p]) * lpCoef;
        this.lpB[p] += (this.lpA[p] - this.lpB[p]) * lpCoef;
        const base = p * RING;
        this.ring[base + pos] = this.lpB[p];
        this.jit[p] += (nextRand(this.rng) - this.jit[p]) * this.jitCoef;
        const back = this.jit[p] * jitter + (p >= this.pipeSum.length ? this.twin : 0);
        const bi = back | 0;
        const bf = back - bi;
        const i0 = (pos - bi + RING) & (RING - 1);
        const i1 = (i0 - 1 + RING) & (RING - 1);
        const f = this.ring[base + i0] + (this.ring[base + i1] - this.ring[base + i0]) * bf;
        // DC block, then the pipe end's radiation (derivative) plus the pressure modulated by turbulence.
        this.dc[p] += (f - this.dc[p]) * this.dcCoef;
        const y = f - this.dc[p];
        const d = y - this.prevY[p];
        this.prevY[p] = y;
        this.airNz[p] += (nextRand(this.rng) * 2 - 1 - this.airNz[p]) * this.airCoef;
        const v = edge * d + y * (air * this.airNz[p] * AIR + (1 - air));
        this.post[p] = v;
        if (p < this.pipeSum.length) sum += v;
      }
      this.ringPos = (pos + 1) & (RING - 1);

      // Leveler: a power follower sets one slow gain for every tip, so the voice sits at one loudness whatever the
      // rpm or how peaky its train is (a derivative heavy six and a smeared turbo differ by 10 dB in crest factor).
      // Levelled on what both tips add up to, as a listener behind the car hears them.
      const mix = channels > 1 ? 0.5 * (this.post[0] + this.post[1]) : sum;
      const a = mix * mix;
      this.env = a > this.env ? this.env + (a - this.env) * envAtk : this.env + (a - this.env) * envRel;
      const want = Math.max(0.05, Math.min(30, TARGET / Math.sqrt(Math.max(1e-8, this.env))));
      this.agc += (want - this.agc) * (want < this.agc ? agcDown : agcUp);
      if (channels > 1) {
        for (let ch = 0; ch < channels; ch++) {
          const p = Math.min(ch, tips - 1);
          const out = this.post[p] * this.agc;
          exhaust[ch][i] = out / (1 + Math.abs(out) * 0.5);
        }
      } else {
        const out = sum * this.agc;
        exhaust[0][i] = out / (1 + Math.abs(out) * 0.5);
      }
      if (pops) {
        for (let ch = 0; ch < pops.length; ch++) {
          const p = Math.min(ch, this.popMix.length - 1);
          this.popDc[p] += (this.popMix[p] - this.popDc[p]) * this.popHp;
          const out = this.popMix[p] - this.popDc[p];
          pops[ch][i] = out / (1 + Math.abs(out) * 0.3);
        }
      }
      intake[i] = inSum * intakeAmp;
      if (this.tickLeft > 0) {
        const e = this.tickLeft / this.tickLen;
        body[i] = (nextRand(this.rng) * 2 - 1) * this.tickGain * e * e;
        this.tickLeft--;
      } else body[i] = 0;
      this.samples++;
    }
  }
}

/** Name the worklet registers its processor under; shared with the main thread so the two never drift. */
export const ENGINE_PROCESSOR = 'street-scene-engine';

// ---------------------------------------------------------------------------
// Loudness: every program is trimmed to one K-weighted loudness through a model of the voice's chain
// ---------------------------------------------------------------------------

/**
 * The main thread chain around the worklet (engineAudio.ts builds these nodes, the loudness model and the tests
 * run the same numbers): the presence peak that tracks the firing frequency, the top roll-off, the valvetrain band.
 */
export const CHAIN = {
  presence: { harmonic: 6, min: 550, max: 2400, q: 0.8, gain: 6 },
  /** Roll off above this (Hz): the voice has nothing but grain up there. */
  top: 6500,
  /**
   * The roll-off node's Q. The loudness model runs a Butterworth 0.707 instead; every program's trim was measured
   * with it, and matching the two would move each by about 0.05 dB for nothing heard.
   */
  topQ: 0.7,
  /** The valvetrain tick's band (Hz) and width: a tick, not a hiss. */
  bodyHz: 2200,
  bodyQ: 1.2,
} as const;

/** The firing frequency (Hz) of a program at `rpm`: combustion events per second over every cylinder. */
export function firingHz(program: EngineProgram, rpm: number): number {
  return (rpm / 60) * (program.cylinders.length / program.revsPerCycle);
}

/** The presence peak's centre (Hz) at a firing frequency: a harmonic of it, held inside the band small speakers reproduce. */
export function presenceHz(firing: number): number {
  const pr = CHAIN.presence;
  return Math.max(pr.min, Math.min(pr.max, firing * pr.harmonic));
}

/** The loudness every program is trimmed to (K-weighted RMS of the modelled chain at 3500 rpm, full throttle). */
const LOUDNESS_REF = 0.107;

/**
 * K-weighted RMS of the voice at 3500 rpm, full throttle, through the main thread chain: both tips convolved with
 * the silencer response, the presence peak and the top roll-off, the intake through its trumpet, the body through
 * its band. Done in the frequency domain (the spectra of 0.12 s of each output times the responses), which is the
 * real convolution's loudness for about ten milliseconds. Deterministic from the program's seed, always at 48 kHz.
 */
function estimateLoudness(program: EngineProgram): number {
  const sr = 48000;
  const synth = new EngineSynth(program, sr);
  const n = Math.round(0.27 * sr);
  const skip = Math.round(0.15 * sr);
  const ex = [new Float32Array(n), new Float32Array(n)];
  const intake = new Float32Array(n);
  const body = new Float32Array(n);
  const q: SynthParams = { rpm: 3500, redline: 7500, load: 1, cut: 0, limiter: 0, nitro: 0 };
  for (let i = 0; i < n; i += 128) synth.render([ex[0].subarray(i, i + 128), ex[1].subarray(i, i + 128)], intake.subarray(i, i + 128), body.subarray(i, i + 128), q);
  // 0.12 s of signal plus the response fits without wrapping.
  const size = 16384;
  const m = n - skip;
  const ir = renderImpulse(program.ir, sr);
  const irPow = powerSpectrum(ir, 0, size);
  const pr = CHAIN.presence;
  const presence = Biquad.peaking(sr, presenceHz(firingHz(program, 3500)), pr.q, pr.gain);
  const top = Biquad.lowpass(sr, CHAIN.top, 0.707);
  const intakeBp = Biquad.bandpass(sr, program.intake.hz, program.intake.q);
  const bodyBp = Biquad.bandpass(sr, CHAIN.bodyHz, CHAIN.bodyQ);
  const [kShelf, kHigh] = kWeighting();
  const inPow = powerSpectrum(intake, skip, size);
  const bodyPow = powerSpectrum(body, skip, size);
  const exPow = ex.map((x) => powerSpectrum(x, skip, size));
  let total = 0;
  for (let k = 0; k <= size / 2; k++) {
    const hz = (k * sr) / size;
    const w = k === 0 || k === size / 2 ? 1 : 2;
    const a = (kShelf.magnitude(sr, hz) * kHigh.magnitude(sr, hz)) ** 2;
    const chainGain = presence.magnitude(sr, hz) ** 2 * top.magnitude(sr, hz) ** 2 * irPow[k];
    const side = inPow[k] * intakeBp.magnitude(sr, hz) ** 2 + bodyPow[k] * bodyBp.magnitude(sr, hz) ** 2;
    for (let ch = 0; ch < 2; ch++) total += w * a * (exPow[ch][k] * chainGain + side);
  }
  // Parseval over both tips: mean square = Σ|X|² / (samples × size).
  return Math.sqrt(total / (2 * m * size));
}
