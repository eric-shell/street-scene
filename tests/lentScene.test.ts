import '../scripts/perf/shim';
import { describe, expect, it } from 'vitest';
import { createCity, createWorld } from '../src/city/world';
import { buildDistrictMeshes } from '../src/render/districts';
import { drawnGhosts, type Ghost } from './helpers';

/**
 * The menu's street stage draws its city from the race world and lends the scene to a free roam, whose world is the
 * open one (game/streetStage.ts lend): the open world has no route gates, shutters or barriers. Every district piece
 * that stands only because a race wall is under it must therefore sit in a race layer (kit.race) that lend() hides, or
 * it stays drawn with nothing to stop a car. This builds the race world's district meshes, hides that layer exactly as
 * lend() does, and finds drawn upright geometry at car height that a car circle fits through in the open world
 * (tests/helpers.ts drawnGhosts), minus whatever the open world's own scene draws there (render-only dressing that
 * stands where cars never go, which is not this class). The seeds carry what races shut: the highway's alley gates
 * (11, 17, 18, 24, 26) and a car park the circuit does not take, whose ramp is shuttered (13, 55, 74, 164; 90 was
 * one until Harbor Run reshuffled the event draws, and with them the routes the car parks are planned against).
 */
const SEEDS = [11, 55, 164];

/** Ghosts by district area kind and mesh, for a message. */
function tally(gs: Iterable<Ghost>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of gs) out[`${g.kind}/${g.mesh}`] = (out[`${g.kind}/${g.mesh}`] ?? 0) + 1;
  return out;
}

describe('the race scene lent to free roam', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: no drawn wall a car drives through that the open world's own scene does not also draw`, () => {
      const city = createCity(seed);
      const race = createWorld(seed, 'circuit', city);
      const open = createWorld(seed, 'circuit', city, { openWorld: true });
      const baseline = drawnGhosts(buildDistrictMeshes(open).group, open);
      const meshes = buildDistrictMeshes(race);
      const raceOnly = (m: Map<number, Ghost>) => [...m].filter(([k]) => !baseline.has(k)).map(([, g]) => g);
      // The stage itself keeps them: in the race world the walls are there, so the race layers are real drawn walls.
      meshes.showRaceOnly(true);
      const lentOut = drawnGhosts(meshes.group, open);
      meshes.showRaceOnly(false);
      const lent = drawnGhosts(meshes.group, open);
      expect(tally(raceOnly(lent)), `${seed} lent`).toEqual({});
      // Not vacuous: with the race layers shown, the open world finds what they draw (gates and shutters have no wall there).
      expect(raceOnly(lentOut).length, `${seed} race layers drawn`).toBeGreaterThan(0);
      // And in the race world itself, the race layers stand on sim walls: nothing of theirs a car drives through.
      const layers = meshes.group.getObjectByName('districtRaceOnly')!;
      expect(tally(drawnGhosts(layers, race).values()), `${seed} race layers in the race world`).toEqual({});
    });
  }
});
