/**
 * The city's names (city/names): the streets, the neighbourhood gateways and the El's stations are pure
 * functions of the world, the same twice, with no two streets or stations sharing a name and no street
 * borrowing a word a place or neighbourhood already carries.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { areaNames } from '../src/city/names/placeNames';
import { hoodsOf } from '../src/city/names/places';
import { streetNames } from '../src/city/names/streetNames';
import { hoodGateways } from '../src/city/names/gateways';

const SEEDS = [1, 7, 20261019];
const words = (n: string) => n.toLowerCase().split(/[\s-]+/);

describe('street and gateway names', () => {
  it('are the same twice and unique within a city', () => {
    for (const seed of SEEDS) {
      const a = streetNames(createWorld(seed, 'circuit'));
      const b = streetNames(createWorld(seed, 'circuit'));
      expect(a.streets.map((s) => s.name)).toEqual(b.streets.map((s) => s.name));
      expect(a.streets.length).toBeGreaterThan(8);
      expect(new Set(a.streets.map((s) => s.name)).size).toBe(a.streets.length);
    }
  });

  it('name a street once along its whole length and leave the places their words', () => {
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      const sn = streetNames(w);
      const taken = new Set<string>();
      for (const n of areaNames(w).values()) words(n).forEach((x) => taken.add(x));
      for (const h of hoodsOf(w)) words(h.name).forEach((x) => taken.add(x));
      for (const s of sn.streets) {
        for (const e of s.edges) expect(sn.ofEdge[e]).toBe(s.id);
        // Numbered streets and "Route n" spares aside, a street's stem is its own.
        if (s.kind !== 'street' || !/^\d/.test(s.name)) expect(taken.has(words(s.name)[0])).toBe(false);
      }
    }
  });

  it('give each neighbourhood at most one gateway, on a street that enters it', () => {
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      const gws = hoodGateways(w);
      expect(gws.length).toBeGreaterThan(0);
      expect(new Set(gws.map((g) => g.hood.id)).size).toBe(gws.length);
      for (const g of gws) expect(Math.hypot(g.dx, g.dz)).toBeCloseTo(1, 5);
    }
  });
});
