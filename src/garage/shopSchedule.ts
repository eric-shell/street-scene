/**
 * What the workshop is doing at a given moment, as a pure function of the showroom's clock: the compressor
 * motor and its pressure-release hiss, the impact gun's bursts, the ratchet's clicks, the customer's dyno pull,
 * the welder's arc and the drum fan. The garage's sound bed (audio/garageAmbience.ts) and whatever the room
 * shows read the same function, so a pull on the dyno screen, a spark at the welder and the noise they make
 * agree without either keeping state.
 *
 * Irregular but repeatable, and stateless: time is cut into slots of a fixed period, and each slot holds one
 * event whose start is pushed into the slot by a hash of the slot's ordinal (the style of `neonFlicker`, never
 * Math.random). With the jitter no longer than the period minus the longest event, a slot's event never reaches
 * the next slot, so a call only has to look at one slot, and the gap between consecutive starts is bounded:
 * period minus jitter at the least, period plus jitter at the most. The bench's two tools share one slot
 * (the gun early in it, the ratchet late), so they never overlap.
 */

/** One reusable result: `shopSchedule` fills it in place, so the per-frame call allocates nothing. */
export interface ShopState {
  /** The compressor motor's run, 0..1 (a short ramp up, a slower spin down). */
  compressor: number;
  /** The pressure-release hiss after the motor stops, 1 falling to 0 over `SHOP.releaseSeconds`. */
  release: number;
  /** The impact gun's burst in progress as a unique id (series ordinal x 4 + burst), or -1. */
  gun: number;
  /** Seconds into that burst (0 when none). */
  gunAge: number;
  /** The ratchet series in progress (its slot's ordinal), or -1. */
  ratchet: number;
  /** Which click of the series was last made (0-based; 0 when none). */
  ratchetClick: number;
  /** How far through the interval that click opens, 0..1 (0 when none): 0 is the click itself. */
  ratchetPhase: number;
  /** The customer's pull on the dyno, 0..1 (idle to redline), matching the wall screen's run: 0 between pulls. */
  dynoRpm: number;
  /** The welder's arc, 0 or 1. */
  weld: number;
  /** The strike in progress as a unique id (session ordinal x 8 + strike), or -1; a new id is a new strike of the rod. */
  weldStrike: number;
  /** The drum fan's share of its full speed, 0..1 (constant for now). */
  fan: number;
}

/** A fresh state to pass to `shopSchedule` every frame. */
export function createShopState(): ShopState {
  return { compressor: 0, release: 0, gun: -1, gunAge: 0, ratchet: -1, ratchetClick: 0, ratchetPhase: 0, dynoRpm: 0, weld: 0, weldStrike: -1, fan: 1 };
}

/**
 * The shop's timing, in seconds. Each event: the slot `period` and the `jitter` its start may be pushed by
 * (so consecutive starts are `period - jitter` to `period + jitter` apart), and its own lengths.
 */
export const SHOP = {
  /** The compressor kicks in every 45 to 90 s and runs 6 to 10 s: a 0.6 s ramp up, a 1.2 s spin down. */
  compressor: { period: 67.5, jitter: 22.5, minRun: 6, maxRun: 10, rampUp: 0.6, spinDown: 1.2 },
  /** The pressure release hisses for this long after the run ends (s). */
  releaseSeconds: 1,
  /** The bench's slot: a gun series 15 to 40 s after the last, bursts of 0.3 to 0.8 s, two or three, 0.25 to 0.5 s apart. */
  gun: { period: 27.5, jitter: 12.5, minBurst: 0.3, maxBurst: 0.8, minGap: 0.25, maxGap: 0.5 },
  /** The ratchet's series in the same slot, late in it (an offset 17 to 24 s in): 6 to 12 clicks, the interval shrinking by a factor each click to a floor (s). */
  ratchet: { from: 17, jitter: 7, minClicks: 6, maxClicks: 12, first: 0.34, shrink: 0.84, floor: 0.085 },
  /** The dyno's pull: a cycle of `period` s, rising over `rise` s, dropping back over `drop` s (the wall screen's `t % 9`, `run / 6`). */
  dyno: { period: 9, rise: 6, drop: 1 },
  /** The welder: a session every 20 to 50 s of two to four strikes of 1 to 3 s, 0.1 to 0.3 s apart. */
  weld: { period: 35, jitter: 15, minStrikes: 2, maxStrikes: 4, minArc: 1, maxArc: 3, minGap: 0.1, maxGap: 0.3 },
} as const;

/** A repeatable 0..1 from an ordinal and a salt (an integer hash: no state, no Math.random). */
export function shopHash(n: number, salt: number): number {
  let h = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const between = (a: number, b: number, u: number) => a + (b - a) * u;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Salts, one per hashed quantity, so no two share a stream. */
const SALT = { cStart: 11, cRun: 12, gStart: 21, gCount: 22, gBurst: 23, gGap: 24, rStart: 31, rClicks: 32, wStart: 41, wCount: 42, wArc: 43, wGap: 44 } as const;

/** The state of the shop at the showroom's clock `t` (s), written into `out` and returned. */
export function shopSchedule(t: number, out: ShopState = createShopState()): ShopState {
  if (!(t > 0)) t = 0;
  out.fan = 1;

  // Compressor and its release.
  const C = SHOP.compressor;
  const cn = Math.floor(t / C.period);
  const cStart = cn * C.period + shopHash(cn, SALT.cStart) * C.jitter;
  const cRun = between(C.minRun, C.maxRun, shopHash(cn, SALT.cRun));
  const cu = t - cStart;
  out.compressor = cu < 0 ? 0 : cu < cRun ? smooth(cu / C.rampUp) : Math.max(0, 1 - (cu - cRun) / C.spinDown);
  out.release = cu >= cRun && cu < cRun + SHOP.releaseSeconds ? 1 - (cu - cRun) / SHOP.releaseSeconds : 0;

  // The bench: the gun early in the slot, the ratchet late.
  const G = SHOP.gun;
  const gn = Math.floor(t / G.period);
  out.gun = -1;
  out.gunAge = 0;
  let u = t - (gn * G.period + shopHash(gn, SALT.gStart) * G.jitter);
  if (u >= 0) {
    const bursts = 2 + Math.floor(shopHash(gn, SALT.gCount) * 2);
    for (let k = 0; k < bursts; k++) {
      const len = between(G.minBurst, G.maxBurst, shopHash(gn * 4 + k, SALT.gBurst));
      if (u < len) {
        out.gun = gn * 4 + k;
        out.gunAge = u;
        break;
      }
      u -= len + between(G.minGap, G.maxGap, shopHash(gn * 4 + k, SALT.gGap));
      if (u < 0) break;
    }
  }
  const R = SHOP.ratchet;
  out.ratchet = -1;
  out.ratchetClick = 0;
  out.ratchetPhase = 0;
  u = t - (gn * G.period + R.from + shopHash(gn, SALT.rStart) * R.jitter);
  if (u >= 0) {
    const clicks = R.minClicks + Math.floor(shopHash(gn, SALT.rClicks) * (R.maxClicks - R.minClicks + 1));
    let interval: number = R.first;
    for (let k = 0; k < clicks; k++) {
      if (u < interval) {
        out.ratchet = gn;
        out.ratchetClick = k;
        out.ratchetPhase = u / interval;
        break;
      }
      u -= interval;
      interval = Math.max(R.floor, interval * R.shrink);
    }
  }

  // The customer's pull, the dyno screen's cycle: it climbs for `rise` s and falls back over `drop` s.
  const D = SHOP.dyno;
  const run = ((t % D.period) + D.period) % D.period;
  out.dynoRpm = run < D.rise ? run / D.rise : run < D.rise + D.drop ? 1 - (run - D.rise) / D.drop : 0;

  // The welder's session.
  const W = SHOP.weld;
  const wn = Math.floor(t / W.period);
  out.weld = 0;
  out.weldStrike = -1;
  u = t - (wn * W.period + shopHash(wn, SALT.wStart) * W.jitter);
  if (u >= 0) {
    const strikes = W.minStrikes + Math.floor(shopHash(wn, SALT.wCount) * (W.maxStrikes - W.minStrikes + 1));
    for (let k = 0; k < strikes; k++) {
      const arc = between(W.minArc, W.maxArc, shopHash(wn * 8 + k, SALT.wArc));
      if (u < arc) {
        out.weld = 1;
        out.weldStrike = wn * 8 + k;
        break;
      }
      u -= arc + between(W.minGap, W.maxGap, shopHash(wn * 8 + k, SALT.wGap));
      if (u < 0) break;
    }
  }
  return out;
}
