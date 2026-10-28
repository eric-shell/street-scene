/**
 * Golden hashes of the deterministic layers: per seed, the generated city, and a race on autopilot for every
 * mode with traffic on (45 s or the finish), hashing every car, the events, the traffic and the race's world.
 * Run it on two trees (a baseline worktree and the working tree) and diff the output: any changed hash means
 * a sim or city change, which changes every replay, ghost and best for that seed.
 *
 *   npx tsx .claude/skills/refactor/golden.ts <repo root> [seed,seed,...] > out.txt
 *
 * The root is imported dynamically, so this one script hashes whichever tree it is pointed at.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? '.');
const seeds = (process.argv[3] ?? '1,2,3,7,11,19,32,42,77,101,256,999,2026,31337').split(',').map(Number);
const load = (rel: string) => import(pathToFileURL(path.join(root, rel)).href);

/** JSON of anything the sim holds: typed arrays, maps and sets as arrays, -0 and non-finite numbers spelled out. */
function stable(v: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(v, (_k, x) => {
    if (typeof x === 'function') return undefined;
    if (ArrayBuffer.isView(x)) return Array.from(x as unknown as ArrayLike<number>);
    if (x instanceof Map) return [...x.entries()];
    if (x instanceof Set) return [...x.values()];
    if (x && typeof x === 'object') {
      if (seen.has(x)) return '[circ]';
      seen.add(x);
    }
    if (typeof x === 'number' && !Number.isFinite(x)) return String(x);
    if (Object.is(x, -0)) return '-0';
    return x;
  });
}
const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// createCity moved between modules over time: find it wherever this tree keeps it.
const cityModule = await Promise.any(['src/city/city.ts', 'src/city/createCity.ts', 'src/city/world.ts'].map(async (m) => {
  const mod = await load(m);
  if (typeof mod.createCity !== 'function') throw new Error('no createCity');
  return mod;
}));
const { createRace, stepRace } = await load('src/sim/race.ts');
const { createAi, autopilotInput } = await load('src/sim/ai.ts');
const { stockPerformance } = await load('src/sim/build.ts');

for (const seed of seeds) {
  console.log(`city ${seed} ${h(stable(cityModule.createCity(seed)))}`);
  for (const mode of ['circuit', 'sprint', 'drift', 'drag', 'waypoint']) {
    const rivals = mode === 'drift' ? [] : [{ name: 'A', carId: 'kazamaRotor', performance: stockPerformance() }, { name: 'B', carId: 'wendtStrom', performance: stockPerformance() }];
    const r = createRace({ seed, mode, laps: 1, traffic: true, player: { name: 'P', carId: 'wendtStrom', performance: stockPerformance() }, opponents: rivals, difficulty: 'medium', manualGearbox: false });
    const pilot = createAi(0.97);
    for (let t = 0; t < 60 * 45 && r.phase !== 'finished'; t++) stepRace(r, autopilotInput(r, r.cars[0], pilot));
    console.log(`race ${seed} ${mode} tick ${r.tick} ${h(stable({ cars: r.cars, events: r.events, traffic: r.traffic }))} world ${h(stable({ ...r.world, city: undefined }))}`);
  }
}
