import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/city/world';
import { CITY, PLAZA, STREET_TREES } from '../src/city/config';
import { plazaPasses } from '../src/city/districts/monument';
import { PLAZA_HINT } from '../src/city/districts/plazaDressing';
import { distToPolygonEdge, pointInPolygon } from '../src/city/districts/geom';
import { distToSegment } from '../src/sim/math';

const SEEDS = [20261019, 7, 32, 11, 90210];

describe('plaza furnishing', () => {
  it('is deterministic, stays inside its pocket and leaves an alley mouth pocket bare', () => {
    let pieces = 0;
    let trees = 0;
    let mouths = 0;
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      const again = createWorld(seed, 'circuit');
      for (const a of w.areas) {
        if (a.kind !== 'infill' || (a.variant !== 'plaza' && a.variant !== 'cornerPlaza')) continue;
        const b = w.districts.builds[a.id];
        expect(JSON.stringify([b.props, b.hints])).toBe(JSON.stringify([again.districts.builds[a.id].props, again.districts.builds[a.id].hints]));
        const own = b.props.filter((p) => p.kind === 'tree' || p.kind === 'statue' || p.kind === 'clock' || p.kind === 'kiosk');
        if (a.params.mouth) {
          mouths++;
          // A racer cuts across it into the alley: nothing solid, no people, no strands.
          expect(own.length).toBe(0);
          expect(b.hints.some((h) => h.kind === PLAZA_HINT.gather || h.kind === PLAZA_HINT.strand)).toBe(false);
        }
        for (const p of own) {
          pieces++;
          if (p.kind === 'tree') trees++;
          expect(pointInPolygon(p.x, p.z, a.polygon)).toBe(true);
          expect(distToPolygonEdge(p.x, p.z, a.polygon)).toBeGreaterThan(p.kind === 'tree' ? STREET_TREES.trunkRadius : p.size);
          // Every solid piece has its wall and every plaza wall its piece (invariant 5).
          const walls = w.walls.filter((q) => q.area === a.id && q.look === (p.kind === 'tree' ? 'tree' : 'plaza') && Math.hypot((q.ax + q.bx) / 2 - p.x, (q.az + q.bz) / 2 - p.z) <= p.size + 0.5);
          expect(walls.length).toBeGreaterThan(0);
        }
        // Strands tie to lanterns that stand.
        for (const h of b.hints.filter((q) => q.kind === PLAZA_HINT.strand)) {
          for (const q of h.points) expect(w.props.some((p) => p.kind === 'parkLamp' && p.area === a.id && Math.hypot(p.x - q.x, p.z - q.z) < 0.1)).toBe(true);
        }
      }
      for (const wall of w.walls) if (wall.look === 'plaza') expect(wall.area).toBeDefined();
    }
    expect(pieces).toBeGreaterThan(50);
    expect(trees).toBeGreaterThan(20);
    expect(mouths).toBeGreaterThan(0);
  });

  it('keeps the monument plaza trees a car width off every race pass', () => {
    let monuments = 0;
    let trees = 0;
    for (const seed of SEEDS) {
      const w = createWorld(seed, 'circuit');
      for (const a of w.areas) {
        if (a.kind !== 'monument') continue;
        monuments++;
        const passes = plazaPasses(w.graph, a);
        for (const p of w.districts.builds[a.id].props.filter((q) => q.kind === 'tree')) {
          trees++;
          for (const ps of passes) for (let i = 0; i + 1 < ps.points.length; i++) expect(distToSegment(p.x, p.z, ps.points[i].x, ps.points[i].z, ps.points[i + 1].x, ps.points[i + 1].z)).toBeGreaterThanOrEqual(CITY.districts.monument.passWidth / 2 + PLAZA.monument.lane - 1e-6);
        }
      }
    }
    expect(monuments).toBeGreaterThan(0);
    expect(trees).toBeGreaterThan(0);
  });
});
