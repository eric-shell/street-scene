import { describe, expect, it } from 'vitest';
import { FixedStepLoop, MAX_CATCH_UP_STEPS, SIM_DT } from '../src/loop';

describe('FixedStepLoop', () => {
  it('runs whole ticks and exposes the remainder as alpha', () => {
    let ticks = 0;
    const loop = new FixedStepLoop({ tick: () => ticks++, render: () => {} });
    const r1 = loop.advance(SIM_DT * 2.5);
    expect(r1.steps).toBe(2);
    expect(r1.alpha).toBeCloseTo(0.5, 5);
    const r2 = loop.advance(SIM_DT * 0.51);
    expect(r2.steps).toBe(1);
    expect(ticks).toBe(3);
  });

  it('caps catch-up steps', () => {
    let ticks = 0;
    const loop = new FixedStepLoop({ tick: () => ticks++, render: () => {} });
    const r = loop.advance(0.2);
    expect(r.steps).toBe(MAX_CATCH_UP_STEPS);
    expect(r.alpha).toBeLessThan(1);
  });
});
