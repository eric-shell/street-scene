import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, createWorld } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import { parkPasses } from '../src/city/districts/park';
import { pondOf, pondPoint, pondRho } from '../src/city/districts/parkFeatures';
import { MOUTH_REACH } from '../src/city/busBays';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { distToSegment } from '../src/sim/math';

const PARK = CITY.districts.park;

/**
 * Race passes through the parks (city/districts/park.ts parkPasses): the
 * cobbled path a route takes through a park it turns round. Until the
 * passes are wired into createRoute (DistrictModule.passes), the routes are
 * built here with the park's passes handed to buildRoute directly.
 */
describe('park passes', () => {
  it('lay a cobbled path through a fair share of the parks the routes turn round, the same every time', () => {
    let parks = 0;
    let withPass = 0;
    let taken = 0;
    for (let seed = 0; seed < 24; seed++) {
      const city = createCity(seed);
      const again = createCity(seed);
      for (const a of city.districts.areas) {
        if (a.kind !== 'park') continue;
        parks++;
        const passes = parkPasses(city.graph, a);
        expect(JSON.stringify(passes)).toBe(JSON.stringify(parkPasses(again.graph, again.districts.areas[a.id])));
        expect(passes.length).toBe(a.params.passes);
        if (!passes.length) continue;
        withPass++;
        for (const p of passes) {
          expect(p.width).toBe(PARK.pathWidth);
          // Street ends off the park, the middle well inside it.
          expect(pointInPolygon(p.points[0].x, p.points[0].z, a.polygon)).toBe(false);
          expect(pointInPolygon(p.points[p.points.length - 1].x, p.points[p.points.length - 1].z, a.polygon)).toBe(false);
          const mid = p.points[p.points.length >> 1];
          expect(pointInPolygon(mid.x, mid.z, a.polygon)).toBe(true);
          expect(distToPolygonEdge(mid.x, mid.z, a.polygon)).toBeGreaterThan(PARK.pathWidth / 2 + PARK.passMargin - 0.01);
        }
        for (const kind of ['circuit', 'sprint'] as const) {
          const r = buildRoute(city.graph, kind, city.routeNodes[kind], [], passes);
          if (r.points.some((q) => pointInPolygon(q.x, q.z, a.polygon))) taken++;
        }
      }
    }
    expect(parks).toBeGreaterThan(30);
    // About one park in eight carries a pass with the routes picked blind to the parks (events.ts steers them once wired).
    expect(withPass).toBeGreaterThanOrEqual(4);
    expect(taken).toBeGreaterThanOrEqual(withPass);
  });

  it('keep the path clear: cobbles under the line, no tree or clutter on it, the walls half a path away', () => {
    let crossings = 0;
    for (let seed = 0; seed < 40 && crossings < 8; seed++) {
      const city = createCity(seed);
      for (const a of city.districts.areas) {
        if (a.kind !== 'park' || !a.params.passes) continue;
        const passes = parkPasses(city.graph, a);
        const w = createWorld(seed, 'circuit', city);
        for (const p of passes) {
          crossings++;
          for (let k = 0; k + 1 < p.points.length; k++) {
            const A = p.points[k];
            const B = p.points[k + 1];
            const len = Math.hypot(B.x - A.x, B.z - A.z);
            for (let t = 0; t <= len; t += 1) {
              const x = A.x + ((B.x - A.x) * t) / len;
              const z = A.z + ((B.z - A.z) * t) / len;
              if (!pointInPolygon(x, z, a.polygon) || distToPolygonEdge(x, z, a.polygon) < 1) continue;
              expect(w.surfaceAt(x, z), `${seed} surface`).toBe('cobble');
              expect(w.wallClearance(x, z, 10), `${seed} wall`).toBeGreaterThan(PARK.pathWidth / 2 - 1);
            }
          }
          // Nothing of the park stands on the path (its trees are walls, checked above).
          for (const pr of w.props.filter((q) => q.area === a.id)) {
            for (let k = 0; k + 1 < p.points.length; k++) expect(distToSegment(pr.x, pr.z, p.points[k].x, p.points[k].z, p.points[k + 1].x, p.points[k + 1].z) + 0.01, `${seed} ${pr.kind}`).toBeGreaterThan(PARK.pathWidth / 2 + pr.radius);
          }
          // Beside the path the grass goes on.
          const mid = p.points[p.points.length >> 1];
          const next = p.points[(p.points.length >> 1) + 1];
          const l = Math.hypot(next.x - mid.x, next.z - mid.z) || 1;
          const off = PARK.pathWidth / 2 + 3;
          expect(w.surfaceAt(mid.x - ((next.z - mid.z) / l) * off, mid.z + ((next.x - mid.x) / l) * off)).toBe('grass');
        }
      }
    }
    expect(crossings).toBeGreaterThanOrEqual(4);
  });

  it('meet the street at road level through a flared curb cut, its gate piers either side of the path', () => {
    let ends = 0;
    let cut = 0;
    let piers = 0;
    for (let seed = 0; seed < 24; seed++) {
      const w = createWorld(seed, 'circuit');
      expect(JSON.stringify(createCity(seed).blocks.bays)).toBe(JSON.stringify(w.blocks.bays));
      const mouths = w.blocks.bays.filter((b) => b.kind === 'mouth');
      for (const b of mouths) expect(b.depth).toBe(w.graph.edges[b.edge].sidewalk + MOUTH_REACH);
      for (const a of w.districts.areas) {
        if (a.kind !== 'park') continue;
        const passes = parkPasses(w.graph, a);
        for (const pass of passes) {
          for (const pts of [pass.points, [...pass.points].reverse()]) {
            ends++;
            // Along the line from the street to a metre inside the park: no curb to climb, cobbles over the sidewalk.
            let flat = true;
            for (let i = 0; i + 1 < pts.length; i++) {
              const q = pts[i];
              const r = pts[i + 1];
              const l = Math.hypot(r.x - q.x, r.z - q.z);
              for (let d = 0; d < l; d += 0.25) {
                const x = q.x + ((r.x - q.x) * d) / l;
                const z = q.z + ((r.z - q.z) * d) / l;
                if (pointInPolygon(x, z, a.polygon) && distToPolygonEdge(x, z, a.polygon) > 1) {
                  i = pts.length;
                  break;
                }
                if (w.driveHeightAt(x, z) - w.heightAt(x, z) > 1e-6 || w.surfaceAt(x, z) === 'sidewalk') flat = false;
              }
            }
            if (flat) cut++;
          }
        }
        // The gate piers stand off the path, outside its half width.
        for (const wall of w.walls.filter((x) => x.look === 'gatePier' && x.area === a.id)) {
          piers++;
          for (const pass of passes) {
            for (let i = 0; i + 1 < pass.points.length; i++) {
              const q = pass.points[i];
              const r = pass.points[i + 1];
              expect(distToSegment(wall.ax, wall.az, q.x, q.z, r.x, r.z)).toBeGreaterThan(PARK.pathWidth / 2);
            }
          }
        }
      }
    }
    // Most path ends get their cut (one too near a junction keeps its curb): about four in five over 60 seeds,
    // with or without lakes; these 24 carry only a dozen ends, so the bound leaves room for one more.
    expect(ends).toBeGreaterThan(8);
    expect(cut).toBeGreaterThanOrEqual(ends * (2 / 3));
    expect(piers).toBeGreaterThanOrEqual(cut * 2 * 4);
  });
});

const cities = new Map<number, ReturnType<typeof createCity>>();
/** One city per seed for the whole file: building a city is the slow part. */
const cityOf = (seed: number) => {
  let c = cities.get(seed);
  if (!c) cities.set(seed, (c = createCity(seed)));
  return c;
};

/** Seeds (from 0) whose parks include `variant`, as many as `want`. */
function seedsWith(variant: string, want: number): number[] {
  const out: number[] = [];
  for (let seed = 0; seed < 60 && out.length < want; seed++) if (cityOf(seed).districts.areas.some((a) => a.kind === 'park' && a.variant === variant)) out.push(seed);
  return out;
}

/**
 * Park variants (city/districts/parkFeatures.ts): woodland, a formal garden and a lakeside pond,
 * drawn per park from its own stream and weighted so a city usually has two different ones.
 */
describe('park variants', () => {
  it('all appear over 60 seeds, a city usually mixes two, and the same seed gives the same parks', { timeout: 300000 }, () => {
    const tally: Record<string, number> = {};
    let mixed = 0;
    let cityCount = 0;
    for (let seed = 0; seed < 60; seed++) {
      const parks = cityOf(seed).districts.areas.filter((a) => a.kind === 'park');
      if (!parks.length) continue;
      cityCount++;
      for (const a of parks) tally[a.variant] = (tally[a.variant] ?? 0) + 1;
      if (new Set(parks.map((a) => a.variant)).size > 1) mixed++;
    }
    for (const v of ['woodland', 'formal', 'lakeside']) expect(tally[v] ?? 0, v).toBeGreaterThanOrEqual(10);
    expect(Object.keys(tally).sort()).toEqual(['formal', 'lakeside', 'woodland']);
    expect(mixed).toBeGreaterThanOrEqual(cityCount * 0.7);
    for (const seed of [0, 1, 2, 7]) {
      const a = cityOf(seed).districts.areas.filter((x) => x.kind === 'park');
      const b = createCity(seed).districts.areas.filter((x) => x.kind === 'park');
      expect(JSON.stringify(b.map((x) => [x.variant, x.params]))).toBe(JSON.stringify(a.map((x) => [x.variant, x.params])));
    }
  });

  it('formal gardens: a fountain, hedged parterres and gravel axes, clear of the race passes and of every road', { timeout: 300000 }, () => {
    let gardens = 0;
    let hedges = 0;
    let withBeds = 0;
    for (const seed of seedsWith('formal', 6)) {
      const city = cityOf(seed);
      const w = createWorld(seed, 'circuit', city);
      const again = createWorld(seed, 'circuit', city);
      for (const a of w.areas) {
        if (a.kind !== 'park' || a.variant !== 'formal') continue;
        gardens++;
        const mine = w.walls.filter((x) => x.area === a.id);
        expect(JSON.stringify(mine)).toBe(JSON.stringify(again.walls.filter((x) => x.area === a.id)));
        // The basin is a solid ring in the plaza; its hint says where.
        const b = city.districts.builds[a.id];
        expect(mine.some((x) => x.look === 'fountain'), `${seed} fountain`).toBe(true);
        expect(b.hints.filter((h) => h.kind === 'walk').length, `${seed} axes`).toBeGreaterThanOrEqual(2);
        if (b.hints.some((h) => h.kind === 'bed')) withBeds++;
        // Tall hedges are solids on the lawn, inside the footpath loop.
        for (const wall of mine.filter((x) => x.look === 'hedge')) {
          hedges++;
          const mx = (wall.ax + wall.bx) / 2;
          const mz = (wall.az + wall.bz) / 2;
          expect(pointInPolygon(mx, mz, a.polygon)).toBe(true);
          expect(distToPolygonEdge(mx, mz, a.polygon), `${seed} hedge off the edge`).toBeGreaterThan(PARK.pathInset);
          expect(w.surfaceAt(mx - wall.nx * 2, mz - wall.nz * 2)).toBe('grass');
        }
        // A low hedge is bushes (drive-through), many of them.
        expect(w.props.filter((p) => p.area === a.id && p.kind === 'bush').length, `${seed} low hedges`).toBeGreaterThan(30);
        // Nothing of the garden's walls on a pass's path.
        for (const pass of parkPasses(w.graph, a)) {
          for (const wall of mine) {
            for (let i = 0; i + 1 < pass.points.length; i++) {
              expect(distToSegment((wall.ax + wall.bx) / 2, (wall.az + wall.bz) / 2, pass.points[i].x, pass.points[i].z, pass.points[i + 1].x, pass.points[i + 1].z), `${seed} ${wall.look} on a pass`).toBeGreaterThan(PARK.pathWidth / 2);
            }
          }
        }
      }
    }
    expect(gardens).toBeGreaterThanOrEqual(4);
    expect(hedges).toBeGreaterThan(0);
    expect(withBeds).toBeGreaterThanOrEqual(2);
  });

  it('lakeside ponds: level water in a gentle bowl with exact slopes, a solid jetty, the passes and benches clear', { timeout: 300000 }, () => {
    let ponds = 0;
    for (const seed of seedsWith('lakeside', 5)) {
      const city = cityOf(seed);
      const w = createWorld(seed, 'circuit', city);
      for (const a of w.areas) {
        if (a.kind !== 'park' || a.variant !== 'lakeside') continue;
        ponds++;
        const p = pondOf(a.params)!;
        // The water: a water surface, under the bank's crest by the freeboard, over the bed.
        expect(p.water).toBeCloseTo(p.level - PARK.lakeside.freeboard, 9);
        expect(w.surfaceAt(p.cx, p.cz), `${seed} water`).toBe('water');
        expect(w.heightAt(p.cx, p.cz)).toBeCloseTo(p.level - PARK.lakeside.depth, 6);
        // The crest ring is level, the waterline lies where the ground meets the water.
        for (let k = 0; k < 12; k++) {
          const q = pondPoint(p, p.crest, (k / 12) * Math.PI * 2);
          expect(w.heightAt(q.x, q.z), `${seed} crest`).toBeCloseTo(p.level, 6);
          const s = pondPoint(p, p.a, (k / 12) * Math.PI * 2);
          expect(w.heightAt(s.x, s.z), `${seed} shore`).toBeCloseTo(p.water, 3);
        }
        // Exact gradient and a gentle grade everywhere over the bowl, bank and blend (the terrain launch rule).
        let steepest = 0;
        for (let x = p.cx - p.end; x <= p.cx + p.end; x += 3) {
          for (let z = p.cz - p.end; z <= p.cz + p.end; z += 3) {
            const g = w.slopeAt(x, z);
            steepest = Math.max(steepest, Math.hypot(g.gx, g.gz));
            const e = 0.05;
            expect(g.gx, `${seed} gx`).toBeCloseTo((w.heightAt(x + e, z) - w.heightAt(x - e, z)) / (2 * e), 3);
            expect(g.gz, `${seed} gz`).toBeCloseTo((w.heightAt(x, z + e) - w.heightAt(x, z - e)) / (2 * e), 3);
          }
        }
        expect(steepest, `${seed} steepest`).toBeLessThan(0.11);
        // The jetty is a solid in the water; the pond keeps off the passes and the furniture off the water.
        const jetty = w.walls.filter((x) => x.area === a.id && x.look === 'jetty');
        expect(jetty.length, `${seed} jetty`).toBe(4);
        for (const pass of parkPasses(w.graph, a)) {
          for (let i = 0; i + 1 < pass.points.length; i++) {
            expect(distToSegment(p.cx, p.cz, pass.points[i].x, pass.points[i].z, pass.points[i + 1].x, pass.points[i + 1].z), `${seed} pond on a pass`).toBeGreaterThan(p.crest + PARK.pathWidth / 2);
          }
        }
        for (const pr of w.props.filter((q) => q.area === a.id && (q.kind === 'bench' || q.kind === 'parkLamp'))) expect(pondRho(p, pr.x, pr.z), `${seed} ${pr.kind} in the water`).toBeGreaterThan(p.a);
      }
    }
    expect(ponds).toBeGreaterThanOrEqual(3);
  });
});
