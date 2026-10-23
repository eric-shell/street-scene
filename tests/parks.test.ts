import { describe, expect, it } from 'vitest';
import { CITY } from '../src/city/config';
import { createCity, createWorld } from '../src/city/world';
import { buildRoute } from '../src/city/route';
import { parkPasses } from '../src/city/districts/park';
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
});
