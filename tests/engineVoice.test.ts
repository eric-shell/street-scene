import { describe, expect, it } from 'vitest';
import { Biquad, CHAIN, LAYOUT_VOICE, TURBO, buildProgram, EngineSynth, kWeighting, renderImpulse, type EngineProgram } from '../src/audio/engineSynth';
import { ENGINE_LAYOUTS, engineSpecErrors, type EngineLayout, type EngineSpec } from '../src/shared/carSpec';
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

/** Energy in the orders below the firing order (cycle harmonics 1 to n - 1: the half orders of a five) over the firing order itself, in dB. */
function subOrders(program: EngineProgram, rpm: number, load = 1): number {
  const x = render(program, rpm, load, 1.5).subarray(SR / 2);
  const cycleHz = rpm / 60 / program.revsPerCycle;
  const n = program.cylinders.length;
  let sub = 0;
  for (let k = 1; k < n; k++) sub += tone(x, k * cycleHz) ** 2;
  return 10 * Math.log10(sub / tone(x, n * cycleHz) ** 2);
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
  it('is per car: only the Kombi has the whoosh and the recirculating valve; the vocabulary validates', () => {
    const voices = Object.fromEntries((manifest.cars as { id: string; engine: EngineSpec }[]).map((c) => [c.id, c.engine.voice ?? {}]));
    expect(voices.brandtKombi).toMatchObject({ diverter: 'recirculating', whoosh: 1 });
    for (const [id, v] of Object.entries(voices)) if (id !== 'brandtKombi') expect(v, id).not.toHaveProperty('whoosh');
    for (const [id, v] of Object.entries(voices)) if (id !== 'brandtKombi') expect(v, id).not.toHaveProperty('diverter');
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { diverter: 'recirculating', whoosh: 1.5 } })).toEqual([]);
    expect(engineSpecErrors({ ...spec('I5', 'turbo'), voice: { diverter: 'flutter' } })).toEqual([expect.stringContaining('engine.voice.diverter "flutter" is not one of vent, recirculating')]);
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
