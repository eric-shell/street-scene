/**
 * Car stats for the garage, measured by actually driving the car in a flat,
 * endless test world with the real sim (so they always match the physics).
 */
import { createCar, stepCar } from './car';
import { CarTuning } from './tuning';
import type { World } from '../city/world';
import { NEUTRAL_INPUT } from './input';
import { TICK_HZ } from './constants';

const flatWorld = {
  heightAt: () => 0,
  driveHeightAt: () => 0,
  slopeAt: () => ({ gx: 0, gz: 0 }),
  surfaceAt: () => 'road',
} as unknown as World;

export interface CarStats {
  /** km/h reached after a long full throttle run (no nitrous). */
  topSpeed: number;
  /** Seconds from 0 to 100 km/h (the tuning tools and the stat bars). */
  zeroTo100: number;
  /** Seconds from 0 to 60 mph (26.8 m/s), the figure the garage shows. */
  zeroTo60: number;
  /** Peak lateral grip in g. */
  grip: number;
  /** Seconds of boost times boost force, in kN*s. */
  nitrous: number;
}

export function measureStats(t: CarTuning): CarStats {
  const c = createCar(0, 0, 0, 0);
  const inp = { ...NEUTRAL_INPUT, throttle: 1 };
  let zeroTo100 = 99;
  let zeroTo60 = 99;
  let top = 0;
  let still = 0;
  for (let i = 0; i < 60 * TICK_HZ; i++) {
    stepCar(c, t, inp, { world: flatWorld });
    const kmh = c.speed * 3.6;
    if (zeroTo100 === 99 && kmh >= 100) zeroTo100 = (i + 1) / TICK_HZ;
    if (zeroTo60 === 99 && kmh >= 60 * 1.609344) zeroTo60 = (i + 1) / TICK_HZ;
    if (kmh > top + 0.05) {
      top = kmh;
      still = 0;
    } else if (++still > 3 * TICK_HZ) break;
  }
  return {
    topSpeed: top,
    zeroTo100,
    zeroTo60,
    grip: ((t.tires.gripFront + t.tires.gripRear) / 2) * (1 + t.aero.downforce * 0.02),
    nitrous: (t.nitrous.capacity * t.nitrous.force) / 1000,
  };
}

/** 0..1 bars for the UI. */
export function statBars(s: CarStats): { topSpeed: number; acceleration: number; handling: number; nitrous: number } {
  const n = (v: number, lo: number, hi: number) => Math.max(0.03, Math.min(1, (v - lo) / (hi - lo)));
  return {
    topSpeed: n(s.topSpeed, 170, 330),
    acceleration: n(1 / s.zeroTo100, 1 / 8, 1 / 2.4),
    handling: n(s.grip, 0.95, 1.45),
    nitrous: n(s.nitrous, 8, 32),
  };
}
