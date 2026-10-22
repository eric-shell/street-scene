/**
 * Night market layout for the renderer (no three.js, so tests can check it):
 * the crowd packed into every pen behind the market's crowd rail
 * (city/districts/market.ts), the lantern masts on the rails with the
 * strings zigzagging between them across the street, and where the real
 * lights that follow the car (NightLighting) may sit.
 *
 * The crowd fills a pen row by row from the rail back toward the shopfronts,
 * densest at the rail and thinning toward the back, never at the pen's ends
 * nor where a route's own rail crosses a pen. crowds.ts draws it as stands
 * like a street meet's (idle sway, cheering and stepping back as racers
 * pass), so it costs what a meet does. Seeded from the world: every session
 * sees the same crowd. Render only.
 */
import type { World } from '../../city/world';
import type { Area } from '../../city/districts/types';
import type { Contact } from '../../city/world';
import { MARKET_HINT } from '../../city/districts/market';
import { CITY } from '../../city/config';
import { Rng } from '../../sim/prng';
import type { MeetPerson } from '../race/meetPlan';

/** Crowd layout in a pen (m from the rail, along it) and how full each row is. */
const PEN = {
  /** First row behind the rail, row spacing, and room kept clear in front of the building line. */
  first: 0.42,
  rowStep: 0.58,
  backClear: 0.45,
  /** Spacing along the rail at density 1, and room kept at each end cap. */
  step: 0.64,
  endClear: 0.5,
  /** Share of spots filled per row, front to back (later rows use the last). */
  fill: [0.92, 0.8, 0.55, 0.3],
  /** People per pen at density 1. */
  cap: 200,
} as const;

/** Lantern strings: mast height above the sidewalk and how far masts sit behind the rail line (m). */
export const MARKET_MAST = { height: 6.4, inset: 0.1, stringY: 6.15 } as const;

export interface MarketMast {
  x: number;
  z: number;
  /** Ground under the mast (m, terrain at sidewalk level). */
  y: number;
}

/** One market edge as the renderer draws it: its frame, stall and pen ranges and the masts in zigzag order. */
export interface MarketEdgeView {
  area: Area;
  edge: number;
  ax: number;
  az: number;
  /** Unit direction a to b and the left normal. */
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  length: number;
  /** Lateral offsets (m): curb, crowd rail, building line. */
  curb: number;
  rail: number;
  outer: number;
  /** Stalls from / to (m along a to b, both sides together); 0, 0 for none. */
  lo: number;
  hi: number;
  /** Masts alternating sides along the stretch where both sides have a pen; strings join consecutive ones. */
  masts: MarketMast[];
}

/** Every market edge with its masts (masts every CFG.mastStep m, alternating sides). */
export function marketEdges(world: World): MarketEdgeView[] {
  const out: MarketEdgeView[] = [];
  const step = CITY.districts.market.mastStep;
  for (const area of world.areas) {
    if (area.kind !== 'market') continue;
    for (const h of world.districts.builds[area.id]?.hints ?? []) {
      if (h.kind !== MARKET_HINT.edge) continue;
      const [A, B] = h.points;
      const [edge, curb, rail, outer, lo, hi, penLo, penHi] = h.values;
      const length = Math.hypot(B.x - A.x, B.z - A.z) || 1;
      const ux = (B.x - A.x) / length;
      const uz = (B.z - A.z) / length;
      const v: MarketEdgeView = { area, edge, ax: A.x, az: A.z, ux, uz, nx: -uz, nz: ux, length, curb, rail, outer, lo, hi, masts: [] };
      const span = penHi - penLo - 1;
      if (span > step) {
        const n = Math.floor(span / step);
        const s0 = penLo + 0.5 + (span - n * step) / 2;
        for (let k = 0; k <= n; k++) {
          const side = k % 2 ? -1 : 1;
          const lat = side * (rail + MARKET_MAST.inset);
          const x = A.x + ux * (s0 + k * step) - uz * lat;
          const z = A.z + uz * (s0 + k * step) + ux * lat;
          v.masts.push({ x, z, y: world.heightAt(x, z) + CITY.curbHeight });
        }
      }
      out.push(v);
    }
  }
  return out;
}

/** Where the real lights may sit over the markets: over the middle of every other lantern string (m, world). */
export function marketLightPoints(world: World, edges: MarketEdgeView[] = marketEdges(world)): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (const e of edges) {
    for (let k = 0; k + 1 < e.masts.length; k += 2) {
      const a = e.masts[k];
      const b = e.masts[k + 1];
      const x = (a.x + b.x) / 2;
      const z = (a.z + b.z) / 2;
      out.push({ x, y: world.heightAt(x, z) + 5.2, z });
    }
  }
  return out;
}

/** The crowd in every pen of every market, one list per pen (a stand each). density: 0..1 people scale. */
export function planMarketCrowd(world: World, density = 1): MeetPerson[][] {
  const out: MeetPerson[][] = [];
  const d = Math.max(0.2, density);
  const rng = new Rng((world.seed ^ 0x6a7e7) >>> 0);
  const contacts: Contact[] = [];
  for (const area of world.areas) {
    if (area.kind !== 'market') continue;
    for (const h of world.districts.builds[area.id]?.hints ?? []) {
      if (h.kind !== MARKET_HINT.pen) continue;
      const [r0, r1, , o0] = h.points;
      const [, , rnx, rnz] = h.values;
      const len = Math.hypot(r1.x - r0.x, r1.z - r0.z);
      if (len < 2 * PEN.endClear + 1) continue;
      const ux = (r1.x - r0.x) / len;
      const uz = (r1.z - r0.z) / len;
      const depth = Math.hypot(o0.x - r0.x, o0.z - r0.z);
      const face = Math.atan2(rnx, rnz);
      const people: MeetPerson[] = [];
      const step = PEN.step / d;
      for (let k = 0; ; k++) {
        const back = PEN.first + k * PEN.rowStep;
        if (back > depth - PEN.backClear) break;
        const fill = PEN.fill[Math.min(k, PEN.fill.length - 1)];
        for (let s = PEN.endClear + rng.range(0, step) + (k % 2) * step * 0.5; s < len - PEN.endClear; s += step * rng.range(0.85, 1.2)) {
          if (!rng.chance(fill)) continue;
          const b = back + rng.range(-0.08, 0.08);
          const x = r0.x + ux * s - rnx * b;
          const z = r0.z + uz * s - rnz * b;
          // A route's corner rail or closure running through the pen: nobody stands on it.
          const n = world.collideCircle(x, z, 0.35, contacts);
          let blocked = false;
          for (let i = 0; i < n; i++) if (contacts[i].kind !== 'wall' && (x - contacts[i].px) ** 2 + (z - contacts[i].pz) ** 2 < 0.35 ** 2) blocked = true;
          if (blocked) continue;
          // Facing the course; toward the back some turn to the stalls or each other.
          const turn = k >= 2 && rng.chance(0.3) ? rng.pick([-1, 1]) * rng.range(0.9, 1.6) : rng.range(-0.45, 0.45);
          people.push({ x, y: world.heightAt(x, z) + CITY.curbHeight, z, yaw: face + turn });
        }
      }
      // A long pen keeps every few people, evenly, so it stays under the cap and still reads packed from end to end.
      const cap = Math.round(PEN.cap * d);
      const keep: MeetPerson[] = [];
      for (let i = 0; i < Math.min(cap, people.length); i++) keep.push(people[Math.floor((i * people.length) / Math.min(cap, people.length))]);
      if (keep.length) out.push(keep);
    }
  }
  return out;
}
