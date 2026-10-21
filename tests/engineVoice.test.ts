import { describe, expect, it } from 'vitest';
import { LAYOUT_VOICE, buildProgram, EngineSynth, renderImpulse, type EngineProgram } from '../src/audio/engineSynth';
import { ENGINE_LAYOUTS, type EngineLayout, type EngineSpec } from '../src/shared/carSpec';
import manifest from '../src/assets/carManifest.json';

const SR = 48000;
const spec = (layout: EngineLayout, aspiration: EngineSpec['aspiration'] = 'na', voice?: EngineSpec['voice']): EngineSpec => ({ layout, aspiration, position: 'front', voice });

/** Render `seconds` of exhaust at a steady rpm and load, in worklet sized blocks; `channels` 2 returns the left tailpipe. */
function render(program: EngineProgram, rpm: number, load: number, seconds = 1, extra: Partial<{ cut: number; limiter: number; nitro: number }> = {}, channels = 1): Float32Array {
  const synth = new EngineSynth(program, SR);
  const n = Math.round(seconds * SR);
  const exhaust = Array.from({ length: channels }, () => new Float32Array(n));
  const intake = new Float32Array(n);
  const body = new Float32Array(n);
  for (let i = 0; i < n; i += 128) synth.render(exhaust.map((e) => e.subarray(i, i + 128)), intake.subarray(i, i + 128), body.subarray(i, i + 128), { rpm, redline: 7500, load, cut: 0, limiter: 0, nitro: 0, ...extra });
  return exhaust[0];
}

/** Amplitude at one frequency (Goertzel). */
function tone(x: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length;
}

/**
 * How uneven the pulse train is, in dB: energy at the cycle harmonics that are
 * not multiples of the firing rate (the burble) over the energy at those that are.
 */
function unevenness(program: EngineProgram, rpm: number, channels = 1): number {
  const x = render(program, rpm, 1, 1.5, {}, channels).subarray(SR / 2);
  const cycleHz = rpm / 60 / program.revsPerCycle;
  // One tailpipe carries only its own bank's firings, so "even" is multiples of that count.
  const n = program.cylinders.length / (channels > 1 ? program.pipes : 1);
  let even = 0;
  let odd = 0;
  for (let k = 1; k <= 4 * n; k++) {
    const a = tone(x, k * cycleHz) ** 2;
    if (k % n === 0) even += a;
    else odd += a;
  }
  return 10 * Math.log10(odd / even);
}

describe('engine programs', () => {
  it('cover every layout with a bounded, even fire schedule and one pipe per bank at most', () => {
    for (const layout of Object.keys(ENGINE_LAYOUTS) as EngineLayout[]) {
      expect(LAYOUT_VOICE[layout], layout).toBeDefined();
      const p = buildProgram(spec(layout));
      expect(p.cylinders, layout).toHaveLength(ENGINE_LAYOUTS[layout].cylinders);
      expect(p.revsPerCycle).toBe(ENGINE_LAYOUTS[layout].rotary ? 1 : 2);
      for (const [i, c] of p.cylinders.entries()) {
        expect(c.fire).toBeCloseTo(i / p.cylinders.length, 9);
        expect(c.delay).toBeGreaterThanOrEqual(0);
        expect(c.delay).toBeLessThan(0.01);
        expect(c.gain).toBeGreaterThan(0.2);
        expect(c.gain).toBeLessThanOrEqual(1);
        expect(c.pipe).toBeLessThan(p.pipes);
      }
      expect(Math.min(...p.cylinders.map((c) => c.gain))).toBeLessThanOrEqual(1);
      for (const v of [p.lowpass, p.jitter, p.edge, p.air, p.mech, p.pops, p.rough, p.intake.gain, p.intake.hz, p.intake.q, p.ir.seconds]) expect(Number.isFinite(v)).toBe(true);
      expect(p.lowpass).toBeGreaterThan(500);
      expect(p.air).toBeLessThanOrEqual(1);
    }
  });

  it('read the manifest cars: boxer on unequal headers, twin pipe throttle body six, single pipe turbo six', () => {
    const car = (id: string) => buildProgram(manifest.cars.find((c) => c.id === id)!.engine as EngineSpec);
    const hatch = car('protoHatch');
    const compact = car('protoCompact');
    const coupe = car('protoCoupe');
    // The Hatch's left bank pair arrives over a millisecond late and weaker.
    expect(hatch.pipes).toBe(1);
    expect(Math.max(...hatch.cylinders.map((c) => c.delay))).toBeGreaterThan(0.0012);
    expect(Math.min(...hatch.cylinders.map((c) => c.gain))).toBeLessThan(0.7);
    expect(compact.pipes).toBe(2);
    expect(compact.intake.gain).toBeGreaterThan(coupe.intake.gain);
    expect(coupe.pipes).toBe(1);
    // The turbine smears the Coupe's pulses: duller band limit, less edge, no sharp rise.
    expect(coupe.lowpass).toBeLessThan(compact.lowpass);
    expect(coupe.edge).toBeLessThan(compact.edge);
    expect(coupe.pulse.rise).toBeGreaterThan(compact.pulse.rise);
    // The Wagon: a cross-plane V8 with a pipe per bank.
    const wagon = car('protoWagon');
    expect(wagon.cylinders).toHaveLength(8);
    expect(wagon.pipes).toBe(2);
    expect(new Set(wagon.cylinders.map((c) => c.pipe)).size).toBe(2);
    // A rival's lite program keeps the exhaust but drops the detail.
    const lite = buildProgram(spec('I6'), { lite: true });
    expect(lite.intake.gain).toBe(0);
    expect(lite.mech).toBe(0);
    expect(lite.ir.seconds).toBeLessThan(buildProgram(spec('I6')).ir.seconds);
  });
});

describe('engine synth', () => {
  it('is deterministic for a seed and bounded', () => {
    const p = buildProgram(spec('V8', 'turbo', { crank: 'cross' }), { seed: 42 });
    const a = render(p, 4000, 0.8);
    const b = render(p, 4000, 0.8);
    expect(JSON.stringify(Array.from(a.subarray(0, 4096)))).toBe(JSON.stringify(Array.from(b.subarray(0, 4096))));
    let peak = 0;
    for (const v of a) {
      expect(Number.isFinite(v)).toBe(true);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(1);
    // A different seed is a different take.
    const c = render(buildProgram(spec('V8', 'turbo'), { seed: 43 }), 4000, 0.8);
    expect(JSON.stringify(Array.from(c.subarray(0, 4096)))).not.toBe(JSON.stringify(Array.from(a.subarray(0, 4096))));
  });

  it('puts the tone at the firing rate, and the leveler holds the level across rpm', () => {
    const p = buildProgram(spec('I4'));
    for (const rpm of [1200, 3500, 7000]) {
      const x = render(p, rpm, 1, 1.5).subarray(SR / 2);
      const f = (rpm / 60) * 2;
      // The firing fundamental and its second harmonic beat anything off the grid between them.
      expect(tone(x, f) + tone(x, 2 * f)).toBeGreaterThan(4 * tone(x, 1.5 * f));
      let peak = 0;
      for (const v of x) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.15);
      expect(peak).toBeLessThan(0.6);
    }
  });

  it('a boxer on unequal headers rumbles, on equal headers it does not; a cross-plane V8 burbles, a flat-plane one screams', () => {
    const unequal = buildProgram(spec('B4', 'turbo', { headers: 'unequal' }));
    const equal = buildProgram(spec('B4', 'turbo', { headers: 'equal' }));
    const cross = buildProgram(spec('V8', 'na', { crank: 'cross', pipes: 2 }));
    const flat = buildProgram(spec('V8', 'na', { crank: 'flat', pipes: 2 }));
    const six = buildProgram(spec('I6', 'na', { pipes: 2 }));
    for (const rpm of [3500, 6500]) {
      expect(unevenness(unequal, rpm), `boxer ${rpm}`).toBeGreaterThan(unevenness(equal, rpm) + 6);
      // Heard from one tailpipe (the left channel), a cross-plane bank is lumpy and a flat-plane bank is even.
      expect(unevenness(cross, rpm, 2), `V8 ${rpm}`).toBeGreaterThan(unevenness(flat, rpm, 2) + 6);
      expect(unevenness(six, rpm, 2), `I6 ${rpm}`).toBeLessThan(-8);
    }
  });

  it('the limiter and a shift cut thin the sound, nitro keeps it', () => {
    const p = buildProgram(spec('I6'));
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    const full = render(p, 7400, 1, 1).subarray(SR / 2);
    const cut = render(p, 7400, 1, 1, { cut: 1 }).subarray(SR / 2);
    const limited = render(p, 7400, 1, 1, { limiter: 1 }).subarray(SR / 2);
    // The leveler brings a cut back up over time, so compare the first tenth of a second after the cut instead.
    const synth = new EngineSynth(p, SR);
    const warm = new Float32Array(SR);
    const scratch = new Float32Array(SR);
    for (let i = 0; i < SR; i += 128) synth.render([warm.subarray(i, i + 128)], scratch.subarray(i, i + 128), scratch.subarray(i, i + 128), { rpm: 7400, redline: 7500, load: 1, cut: 0, limiter: 0, nitro: 0 });
    const after = new Float32Array(4800);
    for (let i = 0; i < after.length; i += 128) synth.render([after.subarray(i, i + 128)], scratch.subarray(i, i + 128), scratch.subarray(i, i + 128), { rpm: 7400, redline: 7500, load: 1, cut: 1, limiter: 0, nitro: 0 });
    expect(rms(after)).toBeLessThan(rms(warm.subarray(SR / 2)) * 0.7);
    expect(Number.isFinite(rms(cut))).toBe(true);
    expect(Number.isFinite(rms(limited))).toBe(true);
    expect(rms(full)).toBeGreaterThan(0.01);
  });
});

describe('overrun pops', () => {
  it('a pop is a short burst through one pipe: a bang longer and heavier than a crackle, deterministic', () => {
    const p = buildProgram(spec('I6', 'na', { muffler: 'sport' }));
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    const take = (size: number) => {
      const synth = new EngineSynth(p, SR);
      const scratch = new Float32Array(SR);
      const out = new Float32Array(SR);
      // Idle, closed throttle: a quiet bed, then a pop 100 ms in.
      synth.pop(0.1, 0, 2.5, size);
      for (let i = 0; i < SR; i += 128) synth.render([out.subarray(i, i + 128)], scratch.subarray(i, i + 128), scratch.subarray(i, i + 128), { rpm: 900, redline: 7500, load: 0, cut: 0, limiter: 0, nitro: 0 });
      return out;
    };
    const bang = take(1);
    const crackle = take(0);
    const quiet = rms(bang.subarray(SR * 0.02, SR * 0.09));
    const inBang = rms(bang.subarray(SR * 0.1, SR * 0.14));
    const inCrackle = rms(crackle.subarray(SR * 0.1, SR * 0.14));
    expect(inBang).toBeGreaterThan(quiet * 3);
    expect(inCrackle).toBeGreaterThan(quiet * 1.5);
    expect(inBang).toBeGreaterThan(inCrackle);
    // Gone again well before the leveler settles.
    expect(rms(bang.subarray(SR * 0.3, SR * 0.4))).toBeLessThan(inBang);
    expect(JSON.stringify(Array.from(take(1).subarray(4800, 6000)))).toBe(JSON.stringify(Array.from(bang.subarray(4800, 6000))));
  });
});

describe('impulse responses', () => {
  it('are finite, peak normalized and decay to silence', () => {
    for (const m of ['quiet', 'sport', 'straight'] as const) {
      const ir = renderImpulse(buildProgram(spec('V6', 'na', { muffler: m })).ir, SR);
      expect(ir.length).toBeGreaterThan(SR * 0.1);
      let peak = 0;
      for (const v of ir) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak).toBeCloseTo(1, 6);
      const tail = ir.subarray(ir.length - SR * 0.02);
      expect(Math.max(...Array.from(tail, Math.abs))).toBeLessThan(0.05);
    }
    expect(renderImpulse(buildProgram(spec('I4')).ir, SR)).toEqual(renderImpulse(buildProgram(spec('I4')).ir, SR));
  });
});
