/**
 * The scrapyard's press: a timed gate (sim/gates.ts) across its canyon, so the short risky line is a gamble. The crusher's
 * ram comes down across the aisle for about a third of every cycle (blocking from the start of `closed` until the ram is half
 * way back up, as every timed gate), with warning lamps and the ram lowering before it blocks, so a driver in the canyon who
 * sees the lamps can brake, and one who guesses wrong stops against it. The gate is one sided like the others: it holds a car
 * coming down the canyon from the back lane toward the kicker (the side the layout's `w` axis points to) and lets one that is
 * already past it drive on out.
 *
 * Static data built with the world (createWorld, appended to World.timedGates after the level crossings), a pure function of
 * the area and the seed: the cycle's phase is drawn from `deriveSeed(seed, 'scrapyard:crusher')`, so every seed's press runs on
 * its own clock and a replay sees the same one. The renderer (render/districts/scrapyard.ts) poses the ram from the same
 * cycle with gatePhase at the interpolated sim tick.
 */
import type { City } from '../world';
import type { GateSet } from '../../sim/gates';
import { makeGate } from '../../sim/gates';
import { TICK_HZ } from '../../sim/constants';
import { Rng, deriveSeed } from '../../sim/prng';
import { CITY } from '../config';
import { scrapLayout } from './scrapyardLayout';

/** Index of the press gate in the world's gate list for each scrapyard area (area id to gate index), in a world with one. */
export interface ScrapPress {
  area: number;
  /** Its gate and cycle in World.timedGates. */
  gate: number;
  cycle: number;
}

/** Append the press of every scrapyard of the city to `set`; returns where they went. */
export function addScrapyardGates(city: City, set: GateSet): ScrapPress[] {
  const out: ScrapPress[] = [];
  const P = CITY.districts.scrapyard.press;
  for (const a of city.districts.areas) {
    if (a.kind !== 'scrapyard') continue;
    const L = scrapLayout(a);
    const period = Math.round(P.period * TICK_HZ);
    const rng = new Rng(deriveSeed(city.seed, 'scrapyard:crusher'));
    const cycle = set.cycles.length;
    set.cycles.push({ period, start: rng.int(0, period - 1), warn: Math.round(P.warn * TICK_HZ), lower: Math.round(P.lower * TICK_HZ), closed: Math.round(P.closed * TICK_HZ), raise: Math.round(P.raise * TICK_HZ) });
    const g = L.press;
    const gate = set.gates.length;
    set.gates.push(makeGate(g.a.x, g.a.z, g.b.x, g.b.z, g.nx, g.nz, 'crusher', cycle));
    out.push({ area: a.id, gate, cycle });
  }
  return out;
}
