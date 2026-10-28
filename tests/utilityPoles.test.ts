import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { STREET_TREES, UTILITY_POLES } from '../src/city/config';
import { homeOf, regionMap } from '../src/city/regions';
import { FURNITURE } from '../src/city/streetFurniture';
import { downtownFactor } from '../src/city/roadGraph';
import { bayHitsCircle } from '../src/city/busBays';
import { PROP_DEFS } from '../src/city/props';
import { PROP_CULL } from '../src/render/street/props';
import { UTILITY_POLE, utilityPoleGeo, utilityTransformerGeo } from '../src/render/street/propGeometry';
import { buildUtilityWires } from '../src/render/street/utilityWires';

/** la homes (city/regions.ts homeOf), an sf one and an nyc one (their outer la streets only). */
const LA = [1, 6];
const AWAY = [20261019, 3];

describe('power poles', () => {
  it('line the la streets of an la home, a few outer ones elsewhere, the same every time', () => {
    for (const seed of LA) expect(homeOf(seed)).toBe('la');
    const count = (seed: number) => createWorld(seed, 'circuit').props.filter((p) => p.kind === 'utilityPole');
    for (const seed of [...LA, ...AWAY]) {
      const a = count(seed);
      expect(JSON.stringify(a), `${seed}`).toBe(JSON.stringify(count(seed)));
      if (LA.includes(seed)) expect(a.length, `${seed}`).toBeGreaterThan(150);
      else expect(a.length, `${seed}`).toBeLessThan(80);
    }
  });

  it('stand on la sidewalks, clear of corners, lamps, hydrants, bays, trees and every other prop', () => {
    for (const seed of [LA[0], AWAY[0]]) {
      const w = createWorld(seed, 'circuit');
      const regions = regionMap(seed, w.graph, w.areas, (x, z) => w.heightAt(x, z));
      const poles = w.props.filter((p) => p.kind === 'utilityPole');
      expect(poles.length, `${seed}`).toBeGreaterThan(0);
      let inLa = 0;
      for (const p of poles) {
        const e = w.graph.edges[p.edge];
        const mx = (w.graph.nodes[e.a].x + w.graph.nodes[e.b].x) / 2;
        const mz = (w.graph.nodes[e.a].z + w.graph.nodes[e.b].z) / 2;
        expect(w.surfaceAt(p.x, p.z), `${seed}`).toBe('sidewalk');
        expect(p.radius).toBe(0.2);
        // Its street is in an la neighbourhood (a run is placed by its street's middle and may reach a little past a cell border).
        if (regions.regionAt(mx, mz) === 'la') inLa++;
        if (homeOf(seed) !== 'la') expect(downtownFactor(w.graph.plan, mx, mz), `${seed}`).toBeLessThanOrEqual(FURNITURE.mid + 0.2);
        let corner = Infinity;
        w.graph.nodes.forEach((n, ni) => {
          if (n.edges.length < 3) return;
          for (const sec of w.blocks.sectors[ni]) for (const c of sec.curb) corner = Math.min(corner, Math.hypot(c.x - p.x, c.z - p.z));
        });
        expect(corner, `${seed} corner`).toBeGreaterThanOrEqual(UTILITY_POLES.cornerClear - UTILITY_POLES.slide * UTILITY_POLES.tries - 0.5);
        for (const q of w.props) {
          if (q === p) continue;
          const d = Math.hypot(q.x - p.x, q.z - p.z);
          expect(d, `${seed} ${q.kind}`).toBeGreaterThanOrEqual(p.radius + q.radius + 0.5 - 1e-9);
          if (q.kind === 'streetlight' || q.kind === 'trafficLight' || q.kind === 'utilityPole') expect(d, `${seed} ${q.kind}`).toBeGreaterThanOrEqual(UTILITY_POLES.lightClear - 1e-9);
          if (q.kind === 'hydrant') expect(d, `${seed} hydrant`).toBeGreaterThanOrEqual(UTILITY_POLES.hydrantClear - 1e-9);
        }
        for (const b of w.blocks.bays) expect(bayHitsCircle(b, p.x, p.z, p.radius), `${seed} bay`).toBe(false);
        for (const t of w.blocks.trees) expect(Math.hypot(t.x - p.x, t.z - p.z), `${seed} tree`).toBeGreaterThanOrEqual(STREET_TREES.propClear - 1e-9);
      }
      expect(inLa / poles.length, `${seed}`).toBeGreaterThan(0.8);
    }
  });

  it('hang their wires pole to pole along a run, with a drum on every fourth', () => {
    const w = createWorld(LA[0], 'circuit');
    const poles = w.props.filter((p) => p.kind === 'utilityPole');
    let spans = 0;
    for (const p of poles) {
      if (p.wireTo === undefined) continue;
      spans++;
      const q = w.props[p.wireTo];
      expect(q.kind).toBe('utilityPole');
      expect(Math.hypot(q.x - p.x, q.z - p.z)).toBeLessThanOrEqual(UTILITY_POLES.maxSpan + 2 * UTILITY_POLES.slide * UTILITY_POLES.tries);
    }
    expect(spans).toBeGreaterThan(poles.length / 2);
    const drums = poles.filter((p) => p.transformer).length;
    expect(Math.abs(drums - poles.length / UTILITY_POLES.transformerEvery)).toBeLessThanOrEqual(1);
  });

  it('are drawn: every pole a fog-culled instance with its crossarm, every span three wires that drop when a pole is struck', () => {
    expect(PROP_CULL.utilityPole).toBe('fog');
    expect(PROP_DEFS.utilityPole.height).toBeCloseTo(UTILITY_POLE.h, 1);
    for (const q of ['low', 'medium', 'high'] as const) {
      expect(utilityPoleGeo(q).getAttribute('position').count).toBeGreaterThan(40);
      expect(utilityTransformerGeo(q).getAttribute('position').count).toBeGreaterThan(20);
    }
    const w = createWorld(LA[0], 'circuit');
    const props = w.props;
    const spans = props.filter((p) => p.kind === 'utilityPole' && p.wireTo !== undefined);
    const wires = buildUtilityWires(props, 'medium')!;
    const pos = wires.lines.geometry.getAttribute('position');
    expect(pos.count).toBe(spans.length * UTILITY_POLE.wireZ.length * 8 * 2);
    // High overhead: every wire point well above the ground under it, out of any car's reach.
    let low = Infinity;
    for (let i = 0; i < pos.count; i++) low = Math.min(low, pos.getY(i) - w.heightAt(pos.getX(i), pos.getZ(i)));
    expect(low).toBeGreaterThan(6.5);
    // Struck: the wire ends at that pole come down to the pavement.
    const p = spans[0];
    wires.setBroken(p.id, true);
    let ground = Infinity;
    for (let i = 0; i < pos.count; i++) if (Math.hypot(pos.getX(i) - p.x, pos.getZ(i) - p.z) < 1.6) ground = Math.min(ground, pos.getY(i) - p.y);
    expect(ground).toBeLessThan(0.5);
    wires.dispose();
  });
});
