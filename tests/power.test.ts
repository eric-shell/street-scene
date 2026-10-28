import { describe, expect, it } from 'vitest';
import manifest from '../src/assets/carManifest.json';
import { stockPerformance, tuningForBuild } from '../src/sim/build';
import { powerCurve, measureStats } from '../src/sim/stats';
import { dynoSetup, pullLoad, PULL } from '../src/garage/dynoRun';
import { RevModel } from '../src/garage/revModel';

const SELECTABLE = (manifest.cars as { id: string; selectable?: boolean }[]).filter((c) => c.selectable).map((c) => c.id);
const stock = (id: string) => tuningForBuild(id, stockPerformance(id));

describe('engine power curve (the garage dyno)', () => {
  it('is positive for every selectable car, and the Ridgeway Fiend has the highest peak', () => {
    const peaks = SELECTABLE.map((id) => ({ id, ...powerCurve(stock(id)) }));
    for (const p of peaks) {
      expect(p.peakPower).toBeGreaterThan(50_000);
      expect(p.peakTorque).toBeGreaterThan(100);
      expect(p.peakPowerRpm).toBeGreaterThan(p.idle);
      expect(p.peakPowerRpm).toBeLessThanOrEqual(p.redline);
    }
    const top = peaks.reduce((a, b) => (b.peakPower > a.peakPower ? b : a));
    expect(top.id).toBe('ridgewayFiend');
    expect(peaks.reduce((a, b) => (b.peakTorque > a.peakTorque ? b : a)).id).toBe('ridgewayFiend');
  });

  it('scales with the torque multiplier and is deterministic', () => {
    const t = stock('wendtStrom');
    const a = powerCurve(t);
    const b = powerCurve({ ...t, engine: { ...t.engine, torqueMul: t.engine.torqueMul * 1.5 } });
    expect(b.peakPower / a.peakPower).toBeCloseTo(1.5, 6);
    expect(b.peakTorque / a.peakTorque).toBeCloseTo(1.5, 6);
    expect(JSON.stringify(powerCurve(t))).toBe(JSON.stringify(a));
  });

  it('is part of the measured stats without driving, and matches the curve', () => {
    const t = stock('kazamaRotor');
    const s = measureStats(t);
    expect(s.power).toBe(powerCurve(t).peakPower);
    expect(s.torque).toBe(powerCurve(t).peakTorque);
  });

  it('hands the dyno its curves as shares of the peak, the pull gear and the driven axle', () => {
    for (const id of SELECTABLE) {
      const t = stock(id);
      const d = dynoSetup(t);
      let top = 0;
      for (let i = 0; i <= 100; i++) top = Math.max(top, d.power(i / 100));
      expect(top).toBeGreaterThan(0.97);
      expect(top).toBeLessThanOrEqual(1.0001);
      expect(d.torque(0)).toBeGreaterThan(0);
      // The redline in the pull gear lands near 160 km/h (within what the gearbox's steps allow).
      const kmh = ((t.engine.redline * 2 * Math.PI) / 60 / d.overall) * d.wheelRadius * 3.6;
      expect(kmh).toBeGreaterThan(120);
      expect(kmh).toBeLessThan(210);
      expect(d.driven).toBe(t.drivetrain.layout === 'fwd' ? 'front' : 'rear');
      expect(d.peaks.hp).toBeGreaterThan(0);
    }
  });
});

describe('dyno pull (the rev model under load)', () => {
  it('climbs from idle to the redline in a few seconds, bounces on the limiter and coasts down slowly', () => {
    const idle = 900;
    const redline = 7200;
    const m = new RevModel({ idle, redline, load: pullLoad(idle, redline) });
    const dt = 1 / 60;
    let t = 0;
    while (m.rpm < redline * 0.985 && t < 20) {
      m.step(dt, 1);
      t += dt;
    }
    expect(t).toBeGreaterThan(PULL.seconds * 0.9);
    expect(t).toBeLessThan(PULL.seconds * 1.2);
    let cuts = 0;
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      m.step(dt, 1);
      if (m.limiting) cuts++;
      peak = Math.max(peak, m.rpm);
    }
    expect(cuts).toBeGreaterThan(3);
    expect(peak).toBeLessThan(redline * 1.05);
    // Off the pedal the revs fall no faster than the rollers coast.
    const before = m.rpm;
    for (let i = 0; i < 60; i++) m.step(dt, 0);
    const fall = (before - m.rpm) / 1;
    expect(fall).toBeLessThan(pullLoad(idle, redline).coast * 1.35);
    expect(m.rpm).toBeGreaterThan(redline * 0.6);
  });

  it('is identical to the free rev with no load', () => {
    const a = new RevModel({ idle: 900, redline: 7600 });
    const b = new RevModel({ idle: 900, redline: 7600, load: null });
    for (let i = 0; i < 300; i++) {
      const pedal = i < 150 ? 1 : 0;
      a.step(1 / 60, pedal);
      b.step(1 / 60, pedal);
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
