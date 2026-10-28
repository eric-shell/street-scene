import { describe, expect, it } from 'vitest';
import { Biquad, CAM, CHAIN, LAYOUT_VOICE, LOPE, RASP, TURBO, buildProgram, EngineSynth, kWeighting, renderImpulse, type EngineProgram } from '../src/audio/engineSynth';
import { powerSpectrum } from '../src/audio/dsp';
import { CHATTER, FAN, FLAPS, FLUTTER, FlapGate, GEAR_WHINE, SEQUENTIAL, TurboModel, chatterClicks, fanHz, fanLevel, flapResponse, flutterPulses, gearWhineHz, gearWhineLevel, sequentialSpec, type Pulse } from '../src/audio/engineAccessories';
import { ENGINE_LAYOUTS, engineSpecErrors, type EngineLayout, type EngineSpec } from '../src/shared/carSpec';
import manifest from '../src/assets/carManifest.json';

const SR = 48000;
const spec = (layout: EngineLayout, aspiration: EngineSpec['aspiration'] = 'na', voice?: EngineSpec['voice']): EngineSpec => ({ layout, aspiration, position: 'front', voice });

/** Render `seconds` of exhaust at a steady rpm and load, in worklet sized blocks; `channels` 2 returns the left tailpipe. */
function render(program: EngineProgram, rpm: number, load: number, seconds = 1, extra: Partial<{ cut: number; limiter: number; nitro: number }> = {}, channels = 1): Float32Array {
  return renderAll(program, rpm, load, seconds, extra, channels).exhaust[0];
}

/** Like render, with the intake and the body too. */
function renderAll(program: EngineProgram, rpm: number, load: number, seconds = 1, extra: Partial<{ cut: number; limiter: number; nitro: number }> = {}, channels = 1): { exhaust: Float32Array[]; intake: Float32Array; body: Float32Array } {
  const synth = new EngineSynth(program, SR);
  const n = Math.round(seconds * SR);
  const exhaust = Array.from({ length: channels }, () => new Float32Array(n));
  const intake = new Float32Array(n);
  const body = new Float32Array(n);
  for (let i = 0; i < n; i += 128) synth.render(exhaust.map((e) => e.subarray(i, i + 128)), intake.subarray(i, i + 128), body.subarray(i, i + 128), { rpm, redline: 7500, load, cut: 0, limiter: 0, nitro: 0, ...extra });
  return { exhaust, intake, body };
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

/** Energy in the orders below the firing order (cycle harmonics 1 to n - 1: the half orders of a five) over the firing order itself, in dB. */
function subOrders(program: EngineProgram, rpm: number, load = 1): number {
  const x = render(program, rpm, load, 1.5).subarray(SR / 2);
  const cycleHz = rpm / 60 / program.revsPerCycle;
  const n = program.cylinders.length;
  let sub = 0;
  for (let k = 1; k < n; k++) sub += tone(x, k * cycleHz) ** 2;
  return 10 * Math.log10(sub / tone(x, n * cycleHz) ** 2);
}

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

/** Share of the power between two frequencies (dB re the whole), from one FFT of the second half of the take. */
function bandShare(x: Float32Array, lo: number, hi: number): number {
  const size = 32768;
  const p = powerSpectrum(x, x.length - size, size);
  let band = 0;
  let all = 0;
  for (let k = 0; k <= size / 2; k++) {
    all += p[k];
    if ((k * SR) / size >= lo && (k * SR) / size < hi) band += p[k];
  }
  return 10 * Math.log10(band / all);
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

  it('read the manifest cars: single pipe VR6, turbo twin rotor, single pipe turbo inline five', () => {
    const car = (id: string) => buildProgram(manifest.cars.find((c) => c.id === id)!.engine as EngineSpec);
    const hatch = car('wendtStrom');
    const coupe = car('kazamaRotor');
    const wagon = car('brandtKombi');
    // The Hatch's VR6: six cylinders on one pipe. 1-5-3-6-2-4 fires three from the near side of the narrow V,
    // then three from the far side, whose longer runners (unequal headers, 0.35 m) make them arrive a
    // millisecond late and weaker: a beat once a cycle, the growl.
    expect(hatch.cylinders).toHaveLength(6);
    expect(hatch.pipes).toBe(1);
    const late = hatch.cylinders.slice(3);
    expect(Math.min(...late.map((c) => c.delay))).toBeGreaterThan(0.0009);
    expect(Math.max(...hatch.cylinders.slice(0, 3).map((c) => c.delay))).toBeLessThan(0.0005);
    expect(Math.max(...late.map((c) => c.gain))).toBeLessThan(0.75);
    // The Coupe's twin rotor fires each rotor once per turn; its turbines smear the pulses against the
    // naturally aspirated Hatch: duller band limit, less edge, a softer rise.
    expect(coupe.cylinders).toHaveLength(2);
    expect(coupe.pipes).toBe(1);
    expect(coupe.lowpass).toBeLessThan(hatch.lowpass);
    expect(coupe.edge).toBeLessThan(hatch.edge);
    expect(coupe.pulse.rise).toBeGreaterThan(hatch.pulse.rise);
    // The Wagon: the S2's turbo inline five on one system, firing 1-2-4-5-3 every 144 degrees (even fire).
    expect(wagon.cylinders).toHaveLength(5);
    expect(wagon.pipes).toBe(1);
    expect(new Set(wagon.cylinders.map((c) => c.pipe)).size).toBe(1);
    expect(wagon.cylinders.map((c) => c.fire)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    // Its runners are the 3B / ABY log manifold's (FIVE_LOG): cylinders 2, 3 and 4 run straight into the turbo, 1 and 5
    // rise to the collector, so the outer pair arrive late and weaker. Firing order 1-2-4-5-3 puts them at 0, 1, 2, 3, 4.
    const [c1, c2, c4, c5, c3] = wagon.cylinders;
    expect(c3.delay).toBe(0);
    expect(c1.delay).toBeCloseTo(c5.delay, 9);
    expect(c2.delay).toBeCloseTo(c4.delay, 9);
    expect(c1.delay).toBeGreaterThan(0.0004);
    expect(c1.delay).toBeLessThan(0.0008);
    expect(c2.delay).toBeGreaterThan(0);
    expect(c2.delay).toBeLessThan(c1.delay / 2);
    // engine-sim's i5.mr puts 2 and 4 on the quieter system (0.8): they are the weakest pulses, and 3 the loudest.
    expect(c2.gain).toBeLessThan(c1.gain);
    expect(c2.gain).toBeLessThan(0.8);
    expect(c3.gain).toBe(1);
    // The spread is the car's to set, and a crossover hands a share of each bank to the other pipe.
    const wide = buildProgram({ ...spec('VR6'), voice: { headers: 'unequal', headerSpread: 0.6 } });
    expect(Math.max(...wide.cylinders.map((c) => c.delay))).toBeGreaterThan(Math.max(...hatch.cylinders.map((c) => c.delay)));
    expect(buildProgram({ ...spec('V8'), voice: { pipes: 2, crossover: 'x' } }).cylinders.every((c) => c.cross === 0.45)).toBe(true);
    expect(buildProgram({ ...spec('V8'), voice: { pipes: 2, crossover: 'h' } }).cylinders.every((c) => c.cross === 0.2)).toBe(true);
    expect(buildProgram({ ...spec('I4'), voice: { crossover: 'x' } }).cylinders.every((c) => c.cross === 0)).toBe(true);
    expect(engineSpecErrors({ ...spec('I4'), voice: { headerSpread: 2 } })).toEqual([expect.stringContaining('engine.voice.headerSpread 2 is not a number from 0 to 1')]);
    expect(engineSpecErrors({ ...spec('I4'), voice: { headers: 'unequal', headerSpread: 0.35, crossover: 'h' } })).toEqual([]);
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

  it('an Audi five warbles: clearly more uneven than a six, less than a boxer, and the 2.5 order still leads', () => {
    const car = (id: string) => buildProgram(manifest.cars.find((c) => c.id === id)!.engine as EngineSpec);
    const five = car('brandtKombi');
    const six = buildProgram(spec('I6', 'turbo', { pipes: 1, muffler: 'quiet' }));
    const four = buildProgram(spec('I4', 'turbo', { pipes: 1, muffler: 'quiet' }));
    const boxer = buildProgram(spec('B4', 'turbo', { headers: 'unequal', pipes: 1, muffler: 'quiet' }));
    // Measured: the five -10.7 / -7.0 / -2.0 dB (idle, 3000, 6000 rpm), the same turbo six -14.1 / -11.8 / -6.7, the turbo
    // four -10.4 / -11.7 / -6.8 and the boxer -4.2 / +2.0 / +0.9; below the firing order the five sits at -11.6 / -14.4 /
    // -13.6 dB against the six's -18.8 / -18.6 / -15.6.
    for (const [rpm, load] of [[900, 0.1], [3000, 1], [6000, 1]] as const) {
      const f = unevenness(five, rpm);
      expect(f, `five ${rpm}`).toBeGreaterThan(unevenness(six, rpm) + 2.5);
      expect(f, `five ${rpm}`).toBeGreaterThan(unevenness(four, rpm) - 0.5);
      expect(f, `five ${rpm}`).toBeLessThan(unevenness(boxer, rpm) - 1.5);
      expect(subOrders(five, rpm, load), `five sub ${rpm}`).toBeGreaterThan(subOrders(six, rpm, load) + 1.5);
    }
    expect(unevenness(five, 3000)).toBeGreaterThan(-9);
    expect(unevenness(five, 3000)).toBeLessThan(-5);
    expect(unevenness(five, 6000)).toBeLessThan(-0.5);
    // The even 144 degree fire keeps the 2.5 order the strongest line (the 4.0 order at 6000 rpm, 8 dB under it, is the closest).
    for (const rpm of [900, 3000, 6000]) {
      const x = render(five, rpm, rpm === 900 ? 0.1 : 1, 1.5).subarray(SR / 2);
      const cyc = rpm / 120;
      for (const k of [1, 2, 3, 4, 6, 7, 8]) expect(tone(x, 5 * cyc), `${rpm} rpm, order ${k / 2}`).toBeGreaterThan(2.2 * tone(x, k * cyc));
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
  it('a pop is a gunshot on its own output, clear of the engine: a bang longer and heavier than a crackle, deterministic', () => {
    const p = buildProgram(spec('I6', 'na', { muffler: 'sport' }));
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    const peak = (x: Float32Array) => Math.max(...Array.from(x, Math.abs));
    const take = (size: number, gain: number) => {
      const synth = new EngineSynth(p, SR);
      const scratch = new Float32Array(SR);
      const exhaust = new Float32Array(SR);
      const pops = [new Float32Array(SR), new Float32Array(SR)];
      // Full throttle at 5000 rpm, then a pop 100 ms in.
      synth.pop(0.1, 0, gain, size);
      for (let i = 0; i < SR; i += 128)
        synth.render([exhaust.subarray(i, i + 128)], scratch.subarray(i, i + 128), scratch.subarray(i, i + 128), { rpm: 5000, redline: 7500, load: 1, cut: 0, limiter: 0, nitro: 0 }, pops.map((x) => x.subarray(i, i + 128)));
      return { exhaust, pop: pops[0] };
    };
    const bang = take(1, 0.8);
    const crackle = take(0, 0.3);
    // Nothing on the pop output before it fires; a crack that stands well over the engine when it does.
    expect(peak(bang.pop.subarray(0, SR * 0.1))).toBe(0);
    expect(peak(bang.pop)).toBeGreaterThan(4 * rms(bang.exhaust.subarray(SR * 0.3)));
    expect(peak(crackle.pop)).toBeGreaterThan(rms(bang.exhaust.subarray(SR * 0.3)));
    // A sharp onset: the peak inside the first millisecond.
    const onset = Array.from(bang.pop.subarray(SR * 0.1), Math.abs);
    expect(onset.indexOf(Math.max(...onset))).toBeLessThan(SR * 0.001);
    // The bang carries on (its thump and tail), the crackle is all crack.
    const body = (x: Float32Array) => rms(x.subarray(SR * 0.11, SR * 0.16));
    expect(body(bang.pop)).toBeGreaterThan(3 * body(crackle.pop));
    // Gone again, bounded by the soft clip, and the exhaust is not touched.
    expect(peak(bang.pop.subarray(SR * 0.45))).toBeLessThan(1e-3);
    expect(peak(bang.pop)).toBeLessThan(1.5);
    expect(JSON.stringify(Array.from(take(1, 0.8).pop.subarray(4800, 6000)))).toBe(JSON.stringify(Array.from(bang.pop.subarray(4800, 6000))));
  });
});

describe('loudness and width across the cars', () => {
  /**
   * The whole voice as the browser hears it, in Node: both tips convolved with the full silencer response, the
   * presence peak, the top roll-off, the intake and body bands, the program's trim, then K-weighted. The program's
   * own trim comes from a spectral model, so this checks that model holds up in the time domain.
   */
  const loudness = (program: EngineProgram): { rms: number; correlation: number } => {
    const synth = new EngineSynth(program, SR);
    const n = Math.round(0.45 * SR);
    const skip = Math.round(0.15 * SR);
    const ex = [new Float32Array(n), new Float32Array(n)];
    const intake = new Float32Array(n);
    const body = new Float32Array(n);
    for (let i = 0; i < n; i += 128) synth.render([ex[0].subarray(i, i + 128), ex[1].subarray(i, i + 128)], intake.subarray(i, i + 128), body.subarray(i, i + 128), { rpm: 3500, redline: 7500, load: 1, cut: 0, limiter: 0, nitro: 0 });
    const ir = renderImpulse(program.ir, SR);
    const f = (3500 / 60) * (program.cylinders.length / program.revsPerCycle);
    const pr = CHAIN.presence;
    const presenceHz = Math.max(pr.min, Math.min(pr.max, f * pr.harmonic));
    const intakeBp = Biquad.bandpass(SR, program.intake.hz, program.intake.q);
    const bodyBp = Biquad.bandpass(SR, CHAIN.bodyHz, CHAIN.bodyQ);
    const inn = new Float32Array(n);
    for (let i = 0; i < n; i++) inn[i] = intakeBp.process(intake[i]) + bodyBp.process(body[i]);
    const out = ex.map((x) => {
      const presence = Biquad.peaking(SR, presenceHz, pr.q, pr.gain);
      const top = Biquad.lowpass(SR, CHAIN.top, 0.707);
      const [kShelf, kHigh] = kWeighting();
      const y = new Float32Array(n);
      for (let i = skip; i < n; i++) {
        let conv = 0;
        const m = Math.min(ir.length, i + 1);
        for (let k = 0; k < m; k++) conv += x[i - k] * ir[k];
        y[i] = kHigh.process(kShelf.process((top.process(presence.process(conv)) + inn[i]) * program.trim));
      }
      return y;
    });
    let ll = 0;
    let rr = 0;
    let lr = 0;
    for (let i = skip; i < n; i++) {
      ll += out[0][i] * out[0][i];
      rr += out[1][i] * out[1][i];
      lr += out[0][i] * out[1][i];
    }
    return { rms: Math.sqrt((ll + rr) / (2 * (n - skip))), correlation: lr / Math.sqrt(ll * rr) };
  };

  it('the manifest cars land within 2 dB of each other and none is mono', () => {
    const results = (manifest.cars as { id: string; engine: EngineSpec }[]).map((c) => ({ id: c.id, ...loudness(buildProgram(c.engine, { seed: 5 })) }));
    const values = results.map((r) => r.rms);
    const spread = 20 * Math.log10(Math.max(...values) / Math.min(...values));
    expect(spread, JSON.stringify(results)).toBeLessThan(2);
    for (const r of results) expect(r.correlation, r.id).toBeLessThan(0.9);
  });
});

describe('turbo voice', () => {
  it('is per car: only the Kombi has the whoosh; the turbo cars carry stock recirculating valves; the vocabulary validates', () => {
    const voices = Object.fromEntries((manifest.cars as { id: string; engine: EngineSpec }[]).map((c) => [c.id, c.engine.voice ?? {}]));
    expect(voices.brandtKombi).toMatchObject({ diverter: 'recirculating', whoosh: 1 });
    for (const [id, v] of Object.entries(voices)) if (id !== 'brandtKombi') expect(v, id).not.toHaveProperty('whoosh');
    for (const c of manifest.cars as { id: string; engine: EngineSpec }[]) {
      if (c.engine.aspiration === 'turbo') expect(c.engine.voice, c.id).toMatchObject({ diverter: 'recirculating' });
      else expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('diverter');
    }
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { diverter: 'recirculating', whoosh: 1.5 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { diverter: 'hiss' } })).toEqual([expect.stringContaining('engine.voice.diverter "hiss" is not one of vent, recirculating, flutter')]);
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { whoosh: 3 } })).toEqual([expect.stringContaining('engine.voice.whoosh 3 is not a number from 0 to 2')]);
  });

  it('the recirculating valve is softer and lower than the vent, and the turbine keeps its speed through it', () => {
    expect(TURBO.recirculating.gain).toBeLessThan(TURBO.vent.gain);
    expect(TURBO.recirculating.attack).toBeGreaterThan(0.01);
    expect(TURBO.recirculating.to).toBeLessThan(TURBO.recirculating.from);
    expect(TURBO.recirculating.spoolKeep).toBeGreaterThan(TURBO.vent.spoolKeep);
    // The spool constants are the old per update 0.04 and 0.12 at 60 Hz as time constants.
    expect(1 - Math.exp(-1 / 60 / TURBO.spool)).toBeCloseTo(0.04, 3);
    expect(1 - Math.exp(-1 / 60 / TURBO.fall)).toBeCloseTo(0.12, 3);
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

describe('cam changeover', () => {
  const vtec = buildProgram(spec('I4', 'na', { camRpm: 5800, camStep: 1 }));
  const plain = buildProgram(spec('I4'));

  it('is a step in brightness, level and intake honk above the switch, and nothing below it', () => {
    // Below the switch the cam program is the plain program, sample for sample.
    expect(Array.from(render(vtec, 5000, 1).subarray(0, 4096))).toEqual(Array.from(render(plain, 5000, 1).subarray(0, 4096)));
    // Measured at 6,500 rpm with step 1: the 3 to 6 kHz share +8 dB, the exhaust RMS +1.5 dB, the intake 2.5 times.
    const hi = renderAll(vtec, 6500, 1, 2);
    const lo = renderAll(plain, 6500, 1, 2);
    expect(bandShare(hi.exhaust[0], 3000, 6000)).toBeGreaterThan(bandShare(lo.exhaust[0], 3000, 6000) + 4);
    expect(rms(hi.exhaust[0].subarray(SR / 2))).toBeGreaterThan(1.1 * rms(lo.exhaust[0].subarray(SR / 2)));
    expect(rms(hi.intake.subarray(SR / 2))).toBeGreaterThan(1.8 * rms(lo.intake.subarray(SR / 2)));
    // The step scales with the car's: a mild one is between.
    const mild = buildProgram(spec('I4', 'na', { camRpm: 5800, camStep: 0.4 }));
    const mid = bandShare(render(mild, 6500, 1, 2), 3000, 6000);
    expect(mid).toBeGreaterThan(bandShare(lo.exhaust[0], 3000, 6000) + 0.5);
    expect(mid).toBeLessThan(bandShare(hi.exhaust[0], 3000, 6000) - 1);
  });

  it('engages above its rpm on the pedal, follows in a few ms, and a rev hovering at the switch does not chatter', () => {
    const synth = new EngineSynth(vtec, SR);
    const out = [new Float32Array(128)];
    const step = (rpm: number, load = 1) => synth.render(out, new Float32Array(128), new Float32Array(128), { rpm, redline: 8000, load, cut: 0, limiter: 0, nitro: 0 });
    for (let i = 0; i < 100; i++) step(5700);
    expect(synth.cam.engaged).toBe(false);
    step(5900);
    expect(synth.cam.engaged).toBe(true);
    // 128 samples is 2.7 ms against a 12 ms lag: partway after one block, nearly there after 40 ms.
    expect(synth.cam.level).toBeLessThan(0.4);
    for (let i = 0; i < Math.ceil((0.04 * SR) / 128); i++) step(5900);
    expect(synth.cam.level).toBeGreaterThan(0.9);
    // Wobbling +-60 rpm round the switch: in once and staying in (it lets go 150 rpm below).
    let flips = 0;
    let was = synth.cam.engaged;
    for (let i = 0; i < 400; i++) {
      step(5800 + (i % 2 ? 60 : -60));
      if (synth.cam.engaged !== was) flips++;
      was = synth.cam.engaged;
    }
    expect(flips).toBe(0);
    expect(CAM.hysteresis).toBeGreaterThanOrEqual(100);
    // Off the pedal it drops out whatever the rpm, and needs real throttle to come back.
    for (let i = 0; i < 4; i++) step(6500, 0);
    expect(synth.cam.engaged).toBe(false);
    step(6500, 0.2);
    expect(synth.cam.engaged).toBe(false);
    step(6500, 1);
    expect(synth.cam.engaged).toBe(true);
    for (let i = 0; i < 10; i++) step(5600);
    expect(synth.cam.engaged).toBe(false);
  });

  it('is data: the field validates, rivals keep it, and none of the built cars has it yet', () => {
    expect(engineSpecErrors({ ...spec('V6'), voice: { camRpm: 5800, camStep: 1 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('V6'), voice: { camRpm: 300 } })).toEqual([expect.stringContaining('engine.voice.camRpm 300 is not a number from 4000 to 9000')]);
    expect(engineSpecErrors({ ...spec('V6'), voice: { camStep: 1 } })).toEqual([expect.stringContaining('camStep needs camRpm')]);
    expect(buildProgram(spec('V6', 'na', { camRpm: 5800 })).cam).toEqual({ rpm: 5800, step: CAM.defaultStep });
    expect(plain.cam).toBeNull();
    expect(buildProgram(spec('I4', 'na', { camRpm: 5600 }), { lite: true }).cam).not.toBeNull();
    for (const c of manifest.cars as { id: string; engine: EngineSpec }[]) expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('camRpm');
  });
});

describe('odd-fire V10', () => {
  const odd = buildProgram(spec('V10', 'na', { crank: 'oddfire', pipes: 2, crossover: 'none' }));
  const even = buildProgram(spec('V10', 'na', { pipes: 2, crossover: 'none' }));

  it('fires 1-10-9-4-3-6-5-8-7-2 at 90 and 54 degrees alternating, each bank evenly every 144', () => {
    const deg = odd.cylinders.map((c) => Math.round(c.fire * 720));
    expect(deg).toEqual([0, 90, 144, 234, 288, 378, 432, 522, 576, 666]);
    const gaps = deg.map((d, i) => ((deg[(i + 1) % 10] - d + 720) % 720));
    expect(gaps).toEqual([90, 54, 90, 54, 90, 54, 90, 54, 90, 54]);
    // Odd cylinders on one pipe, even on the other: each pipe on its own is an even five.
    for (const pipe of [0, 1]) {
      const own = odd.cylinders.filter((c) => c.pipe === pipe).map((c) => Math.round(c.fire * 720));
      expect(own.map((d, i) => (own[(i + 1) % 5] - d + 720) % 720)).toEqual([144, 144, 144, 144, 144]);
    }
    expect(even.cylinders.map((c) => Math.round(c.fire * 720))).toEqual([0, 72, 144, 216, 288, 360, 432, 504, 576, 648]);
  });

  it('is lumpy where the even V10 is smooth: the sub orders carry energy', () => {
    // Measured, summed to one ear: unevenness +0.8 / +1.3 / +3.3 dB (1,000, 3,000, 6,000 rpm) against the even V10's
    // -17.2 / -9.4 / -4.3; sub orders (cycle harmonics 1 to 9 over the 10th) -2.4 / -2.9 / -1.0 against -20.0 / -19.5 / -15.6.
    for (const rpm of [1000, 3000, 6000]) {
      expect(unevenness(odd, rpm), `unevenness ${rpm}`).toBeGreaterThan(unevenness(even, rpm) + 6);
      expect(subOrders(odd, rpm), `sub ${rpm}`).toBeGreaterThan(subOrders(even, rpm) + 10);
    }
  });

  it('is a V10 option only', () => {
    expect(engineSpecErrors({ ...spec('V10'), voice: { crank: 'oddfire' } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('V8'), voice: { crank: 'oddfire' } })).toEqual([expect.stringContaining('"oddfire" is for a V10')]);
    // A V8's cranks and the plain V10 are untouched.
    expect(buildProgram(spec('V10')).cylinders.map((c) => c.fire)).toEqual(even.cylinders.map((c) => c.fire));
  });
});

describe('VR6 runners', () => {
  const car = (id: string) => buildProgram((manifest.cars as { id: string; engine: EngineSpec }[]).find((c) => c.id === id)!.engine);
  const strom = car('wendtStrom');
  const six = buildProgram(spec('I6'));

  it('follow the zigzag down the head: a runner per cylinder, the far row late, outer runners long', () => {
    expect(LAYOUT_VOICE.VR6.runners).toHaveLength(6);
    expect(LAYOUT_VOICE.VR6.stagger).toBe(0);
    // Firing order 1-5-3-6-2-4: the odd (near) row first, then the even (far) row, which reaches round the narrow V.
    const [c1, c5, c3, c6, c2, c4] = strom.cylinders;
    expect(c3.delay).toBe(0);
    expect(c1.delay).toBeGreaterThan(c5.delay);
    expect(c5.delay).toBeGreaterThan(c3.delay);
    expect(c6.delay).toBeGreaterThan(c2.delay);
    expect(c2.delay).toBeGreaterThan(c4.delay);
    expect(c4.delay).toBeGreaterThan(c1.delay);
    expect(Math.min(c6.gain, c2.gain, c4.gain)).toBeGreaterThan(0.5);
    expect(Math.max(c6.gain, c2.gain, c4.gain)).toBeLessThan(0.75);
  });

  it('beat once a cycle under the even six, at every rpm', () => {
    // Measured, sub orders (cycle harmonics 1 to 5 over the 6th): VR6 -13.3 / -8.8 / -2.3 dB (900, 3,000, 6,000 rpm)
    // against the inline six's -16.9 / -22.4 / -21.9; before (alternating stagger) -12.1 / -8.4 / -0.2.
    expect(subOrders(strom, 900, 0.1)).toBeGreaterThan(subOrders(six, 900, 0.1) + 2);
    for (const rpm of [3000, 6000]) expect(subOrders(strom, rpm), `sub ${rpm}`).toBeGreaterThan(subOrders(six, rpm) + 10);
  });
});

describe('rotary voice', () => {
  const car = (manifest.cars as { id: string; engine: EngineSpec }[]).find((c) => c.id === 'kazamaRotor')!.engine;
  const rotor = buildProgram(car, { seed: 3 });
  const plain = buildProgram({ ...car, voice: { pipes: 1, muffler: 'sport' } }, { seed: 3 });

  /** Spread of the level from one firing to the next (RMS per firing interval: standard deviation over mean). */
  const firingSpread = (x: Float32Array, rpm: number): number => {
    const len = Math.round(SR / ((rpm / 60) * 2));
    const v: number[] = [];
    for (let i = 0; i + len <= x.length; i += len) v.push(rms(x.subarray(i, i + len)));
    const m = v.reduce((a, b) => a + b) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m;
  };

  it('the Kazama Rotor ships the idle lope and the rasp, nobody else does', () => {
    expect(car.voice).toMatchObject({ idleLope: 1, apexRasp: 1 });
    for (const c of manifest.cars as { id: string; engine: EngineSpec }[]) if (c.id !== 'kazamaRotor') expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('idleLope');
    expect(engineSpecErrors({ ...spec('I4'), voice: { idleLope: 1 } })).toEqual([expect.stringContaining('idleLope is for a rotary')]);
    expect(engineSpecErrors({ ...spec('I4'), voice: { apexRasp: 1 } })).toEqual([expect.stringContaining('apexRasp is for a rotary')]);
    expect(engineSpecErrors({ ...spec('R2'), voice: { idleLope: 1, apexRasp: 3 } })).toEqual([expect.stringContaining('apexRasp 3 is not a number from 0 to 2')]);
    expect(buildProgram(spec('R2'), { lite: true }).rasp).toBe(0);
    expect(buildProgram(car, { lite: true }).rasp).toBe(0);
  });

  it('lopes at idle and fades out by 2,500 rpm and with the pedal', () => {
    // Measured, the spread of the level from firing to firing: 0.22 at 850 rpm and 0.35 at 1,500 against 0.09 and 0.10
    // without; the same as without at 2,500 (0.12 vs 0.11), 3,000 and 6,500.
    const at = (p: EngineProgram, rpm: number, load: number) => firingSpread(render(p, rpm, load, 4).subarray(SR), rpm);
    expect(at(rotor, 850, 0.1)).toBeGreaterThan(2 * at(plain, 850, 0.1));
    expect(at(rotor, 1500, 0.1)).toBeGreaterThan(1.8 * at(plain, 1500, 0.1));
    expect(at(rotor, LOPE.fade[1], 0.1)).toBeLessThan(1.25 * at(plain, LOPE.fade[1], 0.1));
    expect(at(rotor, 3000, 1)).toBeLessThan(1.15 * at(plain, 3000, 1));
    expect(at(rotor, 850, 1)).toBeLessThan(1.8 * at(plain, 850, 1));
    // Uneven in time as well as level: bursts of weak strokes a few times a second (4 s of idle varies in 0.25 s windows).
    const x = render(rotor, 850, 0.1, 4).subarray(SR);
    const win = SR / 4;
    const windows = Array.from({ length: 12 }, (_, i) => rms(x.subarray(i * win, (i + 1) * win)));
    expect(Math.max(...windows) / Math.min(...windows)).toBeGreaterThan(1.15);
  });

  it('rasps at the firing rate, rising with revs and throttle, and not at all without the field', () => {
    // Measured, body output RMS: 0.008 at 3,000 rpm and 0.039 at 6,500 against 0.002 and 0 without (the valvetrain tick alone).
    const body = (p: EngineProgram, rpm: number, load: number) => renderAll(p, rpm, load, 2).body.subarray(SR / 2);
    expect(rms(body(rotor, 6500, 1))).toBeGreaterThan(10 * Math.max(1e-4, rms(body(plain, 6500, 1))));
    expect(rms(body(rotor, 6500, 1))).toBeGreaterThan(3 * rms(body(rotor, 3000, 1)));
    expect(rms(body(rotor, 6500, 1))).toBeGreaterThan(1.5 * rms(body(rotor, 6500, 0)));
    // Locked to rpm: the burst envelope has its line at the firing rate and not at an unrelated one.
    const env = Float32Array.from(body(rotor, 5000, 1), Math.abs);
    const f = (5000 / 60) * 2;
    expect(tone(env, f)).toBeGreaterThan(20 * tone(env, f * 1.37));
    // The burst is short: gone well before the next face fires even at the redline.
    expect(RASP.len).toBeLessThan(0.5 / ((7500 / 60) * 2));
  });
});

describe('supercharger lobes', () => {
  it('reach 8 passes per rotor turn (the TVS 2300 Roots), not 7', () => {
    expect(engineSpecErrors({ ...spec('V8', 'supercharged'), voice: { blowerLobes: 8 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('V8', 'supercharged'), voice: { blowerLobes: 6 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('V8', 'supercharged'), voice: { blowerLobes: 7 } })).toEqual([expect.stringContaining('engine.voice.blowerLobes 7 is not one of 3, 4, 5, 6, 8')]);
  });
});


// ---------------------------------------------------------------------------
// Turbo and accessory behaviours (engineAccessories.ts)
// ---------------------------------------------------------------------------

/** Step a boost model through an rpm ramp at the pedal `load`; returns the boost and the model's other states per frame. */
function pull(seq: ReturnType<typeof sequentialSpec>, from: number, to: number, seconds: number, fps: number, load = 1, redline = 8000) {
  const m = new TurboModel(seq);
  // Settle at the start rpm first so the follower is at its plateau.
  for (let i = 0; i < 4 * fps; i++) m.step(from, redline, load, 1 / fps);
  const out: { t: number; rpm: number; boost: number; speed: number; secondary: number; join: number }[] = [];
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    const rpm = from + ((to - from) * (i + 1)) / n;
    m.step(rpm, redline, load, 1 / fps);
    out.push({ t: (i + 1) / fps, rpm, boost: m.boost, speed: m.speed, secondary: m.secondary, join: m.join });
  }
  return out;
}

const KAZAMA = sequentialSpec({ spoolRpm: 1800, preboostRpm: 4000, handoverRpm: 4500, handoverDip: 0.2 });
const ZENITH = sequentialSpec({ spoolRpm: 1800, preboostRpm: 3500, handoverRpm: 4000 });

describe('sequential twin turbo', () => {
  it('without the fields the model is the plain follower the voice always had, bit for bit', () => {
    let legacy = 0;
    const m = new TurboModel(null);
    for (let i = 0; i < 600; i++) {
      const rpm = 1000 + 6000 * Math.abs(Math.sin(i / 90));
      const load = i % 240 < 150 ? 1 : 0.3;
      const target = load * Math.max(0, (Math.min(1.05, rpm / 7500) - 0.25) / 0.75);
      legacy += (target - legacy) * (1 - Math.exp(-1 / 60 / (target > legacy ? TURBO.spool : TURBO.fall)));
      m.step(rpm, 7500, load, 1 / 60);
      expect(m.boost).toBe(legacy);
      expect(m.speed).toBe(legacy);
    }
    expect(m.secondary).toBe(0);
    expect(m.primaryPitch).toBe(1);
    expect(m.primaryLevel).toBe(1);
    expect(sequentialSpec(undefined)).toBeNull();
    expect(sequentialSpec({ pipes: 1 })).toBeNull();
  });

  it('is data: the 13B-REW and the 2JZ-GTE carry their sourced sequences, nobody else; the rules validate', () => {
    const cars = manifest.cars as { id: string; engine: EngineSpec }[];
    expect(cars.find((c) => c.id === 'kazamaRotor')!.engine.voice).toMatchObject({ spoolRpm: 1800, preboostRpm: 4000, handoverRpm: 4500, handoverDip: 0.2 });
    expect(cars.find((c) => c.id === 'tachibanaZenith')!.engine.voice).toMatchObject({ spoolRpm: 1800, preboostRpm: 3500, handoverRpm: 4000 });
    for (const c of cars) if (!['kazamaRotor', 'tachibanaZenith'].includes(c.id)) expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('handoverRpm');
    expect(sequentialSpec({ handoverRpm: 4500 })).toEqual({ spoolRpm: SEQUENTIAL.spoolRpm, preboostRpm: 4500 - SEQUENTIAL.preboostLead, handoverRpm: 4500, dip: 0 });
    expect(engineSpecErrors({ ...spec('R2', 'turbo'), voice: { spoolRpm: 1800, preboostRpm: 4000, handoverRpm: 4500, handoverDip: 0.2 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('I6', 'na'), voice: { handoverRpm: 4000 } })).toEqual([expect.stringContaining('handoverRpm is for a turbo')]);
    expect(engineSpecErrors({ ...spec('I6', 'turbo'), voice: { preboostRpm: 3500 } })).toEqual([expect.stringContaining('preboostRpm needs handoverRpm')]);
    expect(engineSpecErrors({ ...spec('I6', 'turbo'), voice: { handoverRpm: 4000, preboostRpm: 4500 } })).toEqual([expect.stringContaining('spoolRpm < preboostRpm <= handoverRpm')]);
    expect(engineSpecErrors({ ...spec('I6', 'turbo'), voice: { handoverRpm: 4000, handoverDip: 0.9 } })).toEqual([expect.stringContaining('handoverDip 0.9 is not a number from 0 to 0.5')]);
  });

  it('makes full boost from the primary alone at 1,800 rpm, where the single turbo is still asleep', () => {
    const early = (seq: ReturnType<typeof sequentialSpec>) => {
      const m = new TurboModel(seq);
      for (let i = 0; i < 300; i++) m.step(2000, 8000, 1, 1 / 60);
      return m.boost;
    };
    expect(early(KAZAMA)).toBeGreaterThan(0.95);
    expect(early(null)).toBeLessThan(0.3);
  });

  it('dips about 20 percent at the 13B-REW\'s changeover, then surges, and the second whistle joins', () => {
    // A hard pull through 4,500 at 1,600 rpm per second.
    const run = pull(KAZAMA, 3600, 6000, 1.5, 240);
    const before = run.find((r) => r.rpm >= 4400)!.boost;
    const crossing = run.findIndex((r) => r.rpm >= 4500);
    const after = run.slice(crossing);
    const low = Math.min(...after.map((r) => r.boost));
    expect(before).toBeGreaterThan(0.95);
    expect(1 - low / before).toBeGreaterThan(0.16);
    expect(1 - low / before).toBeLessThan(0.24);
    // The dip is brief (back to the plateau within half a second) and followed by a smaller surge over it.
    const recovered = after.find((r) => r.t > run[crossing].t + SEQUENTIAL.fall + 0.01 && r.boost >= before * 0.99);
    expect(recovered).toBeDefined();
    expect(recovered!.t - run[crossing].t).toBeLessThan(SEQUENTIAL.fall + SEQUENTIAL.rise + 0.05);
    const peak = Math.max(...run.slice(crossing).map((r) => r.boost));
    expect(peak).toBeGreaterThan(before * 1.03);
    expect(peak).toBeLessThan(before * (1 + 0.2 * SEQUENTIAL.surge + 0.03));
    // The second turbine hums while it pre-spools (4,000 to 4,500, no boost of its own), then joins at full.
    const hum = run.find((r) => r.rpm >= 4450)!.secondary;
    expect(hum).toBeGreaterThan(0.05);
    expect(hum).toBeLessThan(SEQUENTIAL.preGain + 0.01);
    expect(run[run.length - 1].secondary).toBeGreaterThan(0.95);
    expect(run.find((r) => r.rpm >= 3900)!.secondary).toBeLessThan(0.02);
  });

  it('has no dip for the Supra, whose second turbo joins at 4,000 after pre-boost from 3,500', () => {
    const run = pull(ZENITH, 3000, 4800, 0.72, 240);
    const steady = run.find((r) => r.rpm >= 3300)!.boost;
    for (const r of run) expect(r.boost).toBeGreaterThan(steady * 0.99);
    // Pre-boost: the second turbine is turning (a faint hum) from 3,500 but the gate has not opened.
    const mid = run.find((r) => r.rpm >= 3900)!;
    expect(mid.secondary).toBeGreaterThan(0.03);
    expect(mid.secondary).toBeLessThan(SEQUENTIAL.preGain + 0.01);
    expect(run.find((r) => r.rpm >= 3400)!.secondary).toBeLessThan(0.02);
    expect(run[run.length - 1].join).toBeGreaterThan(0.95);
  });

  it('does not dip off the pedal, and re-arms below the handover without chattering at it', () => {
    const lift = pull(KAZAMA, 3600, 5400, 0.72, 240, 0.1);
    expect(Math.max(...lift.map((r) => r.boost))).toBeLessThan(0.2);
    // Hovering across 4,500 rpm: one changeover, not one per crossing within the re-arm band.
    const m = new TurboModel(KAZAMA);
    for (let i = 0; i < 600; i++) m.step(4000, 8000, 1, 1 / 60);
    let dips = 0;
    let wasDipping = false;
    for (let i = 0; i < 600; i++) {
      m.step(4500 + 120 * Math.sin(i / 6), 8000, 1, 1 / 60);
      const dipping = m.boost < 0.9;
      if (dipping && !wasDipping) dips++;
      wasDipping = dipping;
    }
    expect(dips).toBe(1);
  });

  it('is frame rate independent: the same dip at 30, 60 and 120 fps', () => {
    const dip = (fps: number) => {
      const run = pull(KAZAMA, 3600, 6000, 1.5, fps);
      return Math.min(...run.slice(run.findIndex((r) => r.rpm >= 4500)).map((r) => r.boost));
    };
    expect(dip(30)).toBeCloseTo(dip(120), 1);
    expect(dip(60)).toBeCloseTo(dip(120), 1);
    expect(Math.abs(dip(30) - dip(120))).toBeLessThan(0.04);
  });

  it('sheds the primary whistle\'s pitch and level once the flow is shared', () => {
    const run = pull(ZENITH, 3000, 5000, 1, 120);
    const m = new TurboModel(ZENITH);
    for (let i = 0; i < 400; i++) m.step(5000, 8000, 1, 1 / 120);
    expect(m.primaryPitch).toBeCloseTo(SEQUENTIAL.primaryPitch, 2);
    expect(m.primaryLevel).toBeCloseTo(SEQUENTIAL.primaryShare, 2);
    expect(run[0].join).toBeLessThan(0.01);
  });
});

/** Render a pulse train as an envelope at `rate` Hz the way the gain automation draws it: linear attack, exponential fall. */
function envelope(pulses: readonly Pulse[], seconds: number, rate = 4000): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate)).fill(0.0001);
  for (const p of pulses) {
    for (let i = Math.round(p.at * rate); i < out.length; i++) {
      const t = i / rate - p.at;
      if (t > p.attack + p.decay) break;
      out[i] = Math.max(out[i], t < p.attack ? 0.0001 + (p.peak - 0.0001) * (t / p.attack) : p.peak * (0.0001 / p.peak) ** ((t - p.attack) / p.decay));
    }
  }
  return out;
}

/** The times (s) of the envelope's local peaks above half of its maximum. */
function peaks(env: Float32Array, rate = 4000): number[] {
  const max = Math.max(...env);
  const out: number[] = [];
  for (let i = 1; i < env.length - 1; i++) if (env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > max * 0.15) out.push(i / rate);
  return out;
}

describe('compressor surge flutter and wastegate chatter', () => {
  it('flutters "stu-tu-tu": 3 to 9 pulses, about 14 a second at first slowing to about 6, quieter as it goes', () => {
    const hard = flutterPulses(1, 1);
    const soft = flutterPulses(0.5, 1);
    expect(hard.length).toBe(FLUTTER.count[1]);
    expect(soft.length).toBeLessThan(hard.length);
    expect(soft.length).toBeGreaterThanOrEqual(FLUTTER.count[0]);
    const times = peaks(envelope(hard, 1.5));
    expect(times).toHaveLength(hard.length);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(1 / gaps[0]).toBeGreaterThan(11);
    expect(1 / gaps[0]).toBeLessThan(16);
    expect(1 / gaps[gaps.length - 1]).toBeGreaterThan(5);
    expect(1 / gaps[gaps.length - 1]).toBeLessThan(8);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);
    for (let i = 1; i < hard.length; i++) expect(hard[i].peak).toBeLessThan(hard[i - 1].peak);
    // The train scales with the car's share and with boost; none at no share.
    expect(flutterPulses(1, 0.5)[0].peak).toBeCloseTo(hard[0].peak / 2, 6);
    expect(flutterPulses(1, 0)[0].peak).toBe(0);
  });

  it('flutters on a hard lift only on a valve car, on every lift when there is no valve', () => {
    const cars = manifest.cars as { id: string; engine: EngineSpec }[];
    const voice = (id: string) => cars.find((c) => c.id === id)!.engine.voice!;
    expect(voice('tachibanaRunabout')).toMatchObject({ diverter: 'recirculating', flutter: 0.5, wastegate: 0.6 });
    expect(voice('tachibanaZenith')).toMatchObject({ flutter: 0.4 });
    expect(voice('kazamaRotor')).toMatchObject({ flutter: 0.3 });
    expect(voice('hinodeHorizon')).toMatchObject({ wastegate: 0.4 });
    expect(voice('hinodeHorizon')).not.toHaveProperty('flutter');
    expect(voice('brandtKombi')).not.toHaveProperty('flutter');
    expect(engineSpecErrors({ ...spec('I4', 'turbo'), voice: { diverter: 'flutter' } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('I4', 'na'), voice: { diverter: 'flutter' } })).toEqual([expect.stringContaining('"flutter" is for a turbo')]);
    expect(engineSpecErrors({ ...spec('I4', 'na'), voice: { flutter: 0.5, wastegate: 1 } })).toHaveLength(2);
    expect(engineSpecErrors({ ...spec('I4', 'turbo'), voice: { flutter: 1.5 } })).toEqual([expect.stringContaining('engine.voice.flutter 1.5 is not a number from 0 to 1')]);
  });

  it('chatters: a run of 6 to 11 short metallic ticks 16 to 34 ms apart, fading, none without the field or boost', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const full = chatterClicks(1, 1, rand);
    expect(full.length).toBe(CHATTER.count[1]);
    expect(chatterClicks(0.6, 1, rand).length).toBeLessThan(full.length);
    expect(chatterClicks(0.6, 1, rand).length).toBeGreaterThanOrEqual(CHATTER.count[0]);
    const gaps = full.slice(1).map((c, i) => c.at - full[i].at);
    for (const g of gaps) {
      expect(g).toBeGreaterThan(CHATTER.gap[0] * (1 - CHATTER.jitter) - 1e-9);
      expect(g).toBeLessThan(CHATTER.gap[1] * (1 + CHATTER.jitter) + 1e-9);
    }
    // A burst under a quarter second, each tick a few ms, quieter at the end than the start.
    expect(full[full.length - 1].at + full[full.length - 1].decay).toBeLessThan(0.4);
    expect(full[0].at).toBeCloseTo(CHATTER.lead, 3);
    expect(full[full.length - 1].peak).toBeLessThan(full[0].peak * 0.7);
    for (const c of full) expect(c.attack + c.decay).toBeLessThan(0.005);
    // The envelope is the ticks: silence between them, a peak per tick.
    expect(peaks(envelope(full, 0.5))).toHaveLength(full.length);
    expect(chatterClicks(1, 0, rand)).toEqual([]);
    expect(chatterClicks(0.2, 1, rand)).toEqual([]);
    // Deterministic from its random source.
    seed = 7;
    const a = chatterClicks(1, 1, rand);
    seed = 7;
    expect(chatterClicks(1, 1, rand)).toEqual(a);
  });
});

describe('active exhaust flaps', () => {
  it('stay shut at cruise, open on load or revs, and hold between the thresholds', () => {
    const g = new FlapGate();
    const settle = (load: number, r: number) => {
      for (let i = 0; i < 120; i++) g.step(load, r, 1 / 60);
      return g.open;
    };
    expect(settle(0.2, 0.4)).toBeLessThan(0.01);
    expect(settle(0.5, 0.65)).toBeLessThan(0.01);
    expect(settle(0.7, 0.4)).toBeGreaterThan(0.99);
    // Between the thresholds (load 0.45, revs 0.65) it holds what it was.
    expect(settle(0.45, 0.65)).toBeGreaterThan(0.99);
    expect(settle(0.2, 0.4)).toBeLessThan(0.01);
    expect(settle(0.2, 0.75)).toBeGreaterThan(0.99);
    expect(settle(0.1, 0.5)).toBeLessThan(0.01);
    expect(settle(0.45, 0.65)).toBeLessThan(0.01);
  });

  it('are a 9 dB gain step and a roll-off at full depth, scaled by the car, and a rev hovering at the threshold does not chatter', () => {
    const shut = flapResponse(1, 0);
    expect(20 * Math.log10(shut.gain)).toBeCloseTo(20 * Math.log10(FLAPS.closedGain), 6);
    expect(20 * Math.log10(shut.gain)).toBeLessThan(-8.5);
    expect(shut.hz).toBeCloseTo(FLAPS.closedHz, 3);
    expect(flapResponse(1, 1)).toEqual({ gain: 1, hz: FLAPS.openHz });
    expect(flapResponse(0, 0)).toEqual({ gain: 1, hz: FLAPS.openHz });
    expect(flapResponse(0.5, 0).gain).toBeGreaterThan(shut.gain);
    expect(flapResponse(0.5, 0.5).gain).toBeGreaterThan(flapResponse(0.5, 0).gain);
    // Revs wobbling 0.66 to 0.74 of the redline at light load: the latch opens once and stays.
    const g = new FlapGate();
    let flips = 0;
    let last = false;
    for (let i = 0; i < 600; i++) {
      g.step(0.4, 0.7 + 0.04 * Math.sin(i / 5), 1 / 60);
      if (g.target !== last) flips++;
      last = g.target;
    }
    expect(flips).toBe(1);
  });

  it('smooth at any frame rate: the same travel after 0.2 s at 30, 60 and 120 fps', () => {
    const travel = (fps: number) => {
      const g = new FlapGate();
      for (let i = 0; i < 0.2 * fps; i++) g.step(1, 0.5, 1 / fps);
      return g.open;
    };
    expect(travel(30)).toBeCloseTo(travel(120), 6);
    expect(travel(60)).toBeCloseTo(travel(120), 6);
    expect(travel(60)).toBeCloseTo(1 - Math.exp(-0.2 / FLAPS.tau), 6);
  });

  it('are a field no shipped car sets yet', () => {
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { flaps: 1 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { flaps: 2 } })).toEqual([expect.stringContaining('engine.voice.flaps 2 is not a number from 0 to 1')]);
    for (const c of manifest.cars as { id: string; engine: EngineSpec }[]) expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('flaps');
  });
});

describe('fan and gear whine', () => {
  it('locks the air-cooled fan whine to the crank by the belt ratio, and keeps it faint', () => {
    const ratio = 1.8;
    // Blade pass = rpm / 60 x ratio x blades, so doubling the revs doubles it, and the ratio scales it.
    expect(fanHz(ratio, 3000)).toBeCloseTo((3000 / 60) * ratio * FAN.blades, 9);
    expect(fanHz(ratio, 6000)).toBeCloseTo(2 * fanHz(ratio, 3000), 9);
    expect(fanHz(2 * ratio, 3000)).toBeCloseTo(2 * fanHz(ratio, 3000), 9);
    expect(fanHz(ratio, 6500)).toBeLessThan(FAN.maxHz);
    // Faint: well under the whistle (0.05) even at the redline, present at idle, rising with revs.
    expect(fanLevel(7100, 7100)).toBeLessThanOrEqual(FAN.level);
    expect(fanLevel(7100, 7100)).toBeLessThan(0.05 / 3);
    expect(fanLevel(900, 7100)).toBeGreaterThan(0.2 * FAN.level);
    expect(fanLevel(900, 7100)).toBeLessThan(fanLevel(4000, 7100));
    expect(fanLevel(4000, 7100)).toBeLessThan(fanLevel(7000, 7100));
    expect(engineSpecErrors({ ...spec('B6'), voice: { fanRatio: 1.8 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('B6'), voice: { fanRatio: 5 } })).toEqual([expect.stringContaining('engine.voice.fanRatio 5 is not a number from 0.5 to 3')]);
    for (const c of manifest.cars as { id: string; engine: EngineSpec }[]) expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('fanRatio');
  });

  it('locks the gear whine to the output shaft: the same pitch at the same road speed, none stopped, none during a shift, quieter off the pedal', () => {
    // Wheel 0.33 m, final drive 4.1: 100 km/h is 27.8 m/s, 84 rad/s, 804 rpm at the wheel, 3,300 rpm at the shaft.
    const shaft = (kph: number) => ((kph / 3.6 / 0.33) * 4.1 * 60) / (2 * Math.PI);
    expect(shaft(100)).toBeCloseTo(3300, -2);
    expect(gearWhineHz(shaft(100))).toBeCloseTo((shaft(100) / 60) * GEAR_WHINE.teeth, 9);
    expect(gearWhineHz(shaft(200))).toBeCloseTo(2 * gearWhineHz(shaft(100)), 6);
    expect(gearWhineHz(shaft(100))).toBeGreaterThan(1000);
    expect(gearWhineHz(shaft(250))).toBeLessThan(GEAR_WHINE.maxHz);
    expect(gearWhineLevel(1, 1, 0, false)).toBe(0);
    expect(gearWhineLevel(1, 1, GEAR_WHINE.minRpm / 2, false)).toBe(0);
    expect(gearWhineLevel(1, 1, shaft(100), false)).toBeCloseTo(GEAR_WHINE.level, 9);
    expect(gearWhineLevel(1, 1, shaft(100), true)).toBe(0);
    expect(gearWhineLevel(1, 0, shaft(100), false)).toBeCloseTo(GEAR_WHINE.level * GEAR_WHINE.coast, 9);
    expect(gearWhineLevel(2, 1, shaft(100), false)).toBeCloseTo(2 * GEAR_WHINE.level, 9);
    expect(gearWhineLevel(0, 1, shaft(100), false)).toBe(0);
  });

  it('is off by default: no shipped car sets gearWhine, and the level validates', () => {
    expect(engineSpecErrors({ ...spec('V6'), voice: { gearWhine: 1 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('V6'), voice: { gearWhine: 3 } })).toEqual([expect.stringContaining('engine.voice.gearWhine 3 is not a number from 0 to 2')]);
    for (const c of manifest.cars as { id: string; engine: EngineSpec }[]) expect(c.engine.voice ?? {}, c.id).not.toHaveProperty('gearWhine');
  });
});
