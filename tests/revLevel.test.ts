import { describe, expect, it } from 'vitest';
import { REV_LEVEL, revVoice } from '../src/garage/revModel';

const db = (x: number) => 20 * Math.log10(x);
const IDLE = 900;
const REDLINE = 7200;
const CRUISE = IDLE + 0.28 * (REDLINE - IDLE);

describe('garage engine level', () => {
  it('rests quiet and swells with the revs in the showroom', () => {
    const rest = revVoice('garage', IDLE, IDLE, REDLINE, 0).proximity;
    const top = revVoice('garage', REDLINE, IDLE, REDLINE, 1).proximity;
    expect(db(top) - db(rest)).toBeGreaterThan(14);
    expect(top).toBe(REV_LEVEL.garage.top);
    let last = 0;
    for (let rpm = IDLE; rpm <= REDLINE; rpm += 300) {
      const p = revVoice('garage', rpm, IDLE, REDLINE, 0).proximity;
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it('cruises low on the Street view with a little throttle, and a rev swells over it', () => {
    const cruise = revVoice('street', CRUISE, CRUISE, REDLINE, 0);
    const rev = revVoice('street', REDLINE, CRUISE, REDLINE, 1);
    expect(cruise.throttle).toBe(REV_LEVEL.street.floor);
    expect(db(rev.proximity) - db(cruise.proximity)).toBeGreaterThan(9);
    // Pressing the pedal is heard before the revs climb.
    expect(revVoice('street', CRUISE, CRUISE, REDLINE, 1).proximity).toBeGreaterThan(cruise.proximity * 1.3);
  });
});
