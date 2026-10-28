/**
 * The workshop's schedule (src/garage/shopSchedule.ts): repeatable, inside its stated rates over an hour, the
 * bench's two tools never at once, every value in range, and the dyno in step with the wall screen's cycle.
 */
import { describe, expect, it } from 'vitest';
import { SHOP, createShopState, shopSchedule } from '../src/garage/shopSchedule';
import type { ShopState } from '../src/garage/shopSchedule';

const HOUR = 3600;
const DT = 0.01;

/** Rising edges (start times) of a boolean signal over an hour, plus the run lengths. */
function runs(on: (s: ShopState) => boolean): { starts: number[]; lengths: number[] } {
  const s = createShopState();
  const starts: number[] = [];
  const lengths: number[] = [];
  let was = false;
  let began = 0;
  for (let t = 0; t < HOUR; t += DT) {
    shopSchedule(t, s);
    const now = on(s);
    if (now && !was) {
      starts.push(t);
      began = t;
    }
    if (!now && was) lengths.push(t - began);
    was = now;
  }
  return { starts, lengths };
}

const gaps = (starts: number[]) => starts.slice(1).map((v, i) => v - starts[i]);
const TOL = 2 * DT;

describe('shopSchedule', () => {
  it('is deterministic and reusable', () => {
    const a = createShopState();
    const b = createShopState();
    for (let i = 0; i < 4000; i++) {
      const t = i * 0.937;
      shopSchedule(t, a);
      shopSchedule(t + 5000, b);
      const first = JSON.stringify(a);
      shopSchedule(t, b);
      expect(JSON.stringify(b)).toBe(first);
      expect(JSON.stringify(shopSchedule(t))).toBe(first);
    }
  });

  it('keeps every value in range and finite', () => {
    const s = createShopState();
    for (let t = -50; t < 1200; t += 0.013) {
      shopSchedule(t, s);
      for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
      for (const v of [s.compressor, s.release, s.ratchetPhase, s.dynoRpm, s.weld, s.fan]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(s.gun).toBeGreaterThanOrEqual(-1);
      expect(s.ratchet).toBeGreaterThanOrEqual(-1);
      if (s.gun < 0) expect(s.gunAge).toBe(0);
    }
    expect(shopSchedule(NaN).compressor).toBe(0);
  });

  it('runs the compressor every 45 to 90 s for 6 to 10 s', () => {
    const { starts, lengths } = runs((s) => s.compressor > 0);
    expect(starts.length).toBeGreaterThan(40);
    for (const g of gaps(starts)) {
      expect(g).toBeGreaterThanOrEqual(45 - TOL);
      expect(g).toBeLessThanOrEqual(90 + TOL);
    }
    const C = SHOP.compressor;
    for (const l of lengths) {
      expect(l).toBeGreaterThanOrEqual(C.minRun - TOL);
      expect(l).toBeLessThanOrEqual(C.maxRun + C.spinDown + TOL);
    }
    // The hiss follows each run and lasts its second.
    const hiss = runs((s) => s.release > 0);
    expect(hiss.starts.length).toBe(starts.length);
    for (const l of hiss.lengths) expect(Math.abs(l - SHOP.releaseSeconds)).toBeLessThan(TOL);
  });

  it('fires impact gun series every 15 to 40 s in bursts of 0.3 to 0.8 s, two or three a series', () => {
    const s = createShopState();
    const bursts = new Map<number, number>();
    const series = new Map<number, number>();
    let first = -1;
    for (let t = 0; t < HOUR; t += DT) {
      shopSchedule(t, s);
      if (s.gun < 0) continue;
      bursts.set(s.gun, (bursts.get(s.gun) ?? 0) + DT);
      const n = Math.floor(s.gun / 4);
      if (!series.has(n)) series.set(n, t);
      first = s.gun;
    }
    expect(first).toBeGreaterThan(0);
    for (const len of bursts.values()) {
      expect(len).toBeGreaterThanOrEqual(SHOP.gun.minBurst - TOL);
      expect(len).toBeLessThanOrEqual(SHOP.gun.maxBurst + TOL);
    }
    const perSeries = new Map<number, number>();
    for (const id of bursts.keys()) perSeries.set(Math.floor(id / 4), (perSeries.get(Math.floor(id / 4)) ?? 0) + 1);
    for (const c of perSeries.values()) expect([2, 3]).toContain(c);
    for (const g of gaps([...series.values()])) {
      expect(g).toBeGreaterThanOrEqual(15 - TOL);
      expect(g).toBeLessThanOrEqual(40 + TOL);
    }
  });

  it('ratchets in series of 6 to 12 accelerating clicks, never over the gun', () => {
    const s = createShopState();
    const clicks = new Map<number, number>();
    const times = new Map<number, number[]>();
    const starts = new Map<number, number>();
    for (let t = 0; t < HOUR; t += 0.001) {
      shopSchedule(t, s);
      expect(s.gun >= 0 && s.ratchet >= 0).toBe(false);
      if (s.ratchet < 0) continue;
      clicks.set(s.ratchet, Math.max(clicks.get(s.ratchet) ?? 0, s.ratchetClick + 1));
      if (!starts.has(s.ratchet)) starts.set(s.ratchet, t);
      if (s.ratchetPhase < 0.002) {
        const list = times.get(s.ratchet) ?? [];
        if (list.length === s.ratchetClick) list.push(t);
        times.set(s.ratchet, list);
      }
    }
    for (const c of clicks.values()) {
      expect(c).toBeGreaterThanOrEqual(SHOP.ratchet.minClicks);
      expect(c).toBeLessThanOrEqual(SHOP.ratchet.maxClicks);
    }
    for (const list of times.values()) {
      const g = gaps(list);
      for (let i = 1; i < g.length; i++) expect(g[i]).toBeLessThanOrEqual(g[i - 1] + 0.003);
    }
    for (const g of gaps([...starts.values()])) {
      expect(g).toBeGreaterThanOrEqual(15 - 0.01);
      expect(g).toBeLessThanOrEqual(40 + 0.01);
    }
  });

  it('pulls the dyno on the wall screen\'s cycle', () => {
    const s = createShopState();
    for (let cycle = 0; cycle < 20; cycle++) {
      const at = (run: number) => shopSchedule(cycle * 9 + run, s).dynoRpm;
      expect(at(0)).toBe(0);
      expect(at(3)).toBeCloseTo(0.5, 6);
      expect(at(5.99)).toBeGreaterThan(0.99);
      expect(at(6.5)).toBeCloseTo(0.5, 6);
      expect(at(7.5)).toBe(0);
    }
  });

  it('welds in sessions every 20 to 50 s, arcs of 1 to 3 s', () => {
    const s = createShopState();
    const arcs = new Map<number, number>();
    const sessions = new Map<number, number>();
    for (let t = 0; t < HOUR; t += DT) {
      shopSchedule(t, s);
      expect(s.weld === 1).toBe(s.weldStrike >= 0);
      if (s.weldStrike < 0) continue;
      arcs.set(s.weldStrike, (arcs.get(s.weldStrike) ?? 0) + DT);
      const n = Math.floor(s.weldStrike / 8);
      if (!sessions.has(n)) sessions.set(n, t);
    }
    for (const l of arcs.values()) {
      expect(l).toBeGreaterThanOrEqual(SHOP.weld.minArc - TOL);
      expect(l).toBeLessThanOrEqual(SHOP.weld.maxArc + TOL);
    }
    for (const g of gaps([...sessions.values()])) {
      expect(g).toBeGreaterThanOrEqual(20 - TOL);
      expect(g).toBeLessThanOrEqual(50 + TOL);
    }
  });
});
