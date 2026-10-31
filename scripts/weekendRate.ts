/**
 * Weekend region health over the coming weekend seeds (docs/weekend.md): per kind, how many seeds carved a region,
 * planned it, have the circuit, the sprint and the waypoint race drive its spine end to end, and promise the special.
 * Headless and pure; a check for the region framework's 30/30 target, not part of the suite.
 *
 *   npx tsx scripts/weekendRate.ts [count per kind = 30] [--waypoint]
 */
import { createCity, createRoute, planRoads } from '../src/city/world';
import { weekendOf, weekendSeeds } from '../src/city/weekend';
import { regionOf, spineDirection } from '../src/city/districts/weekendRegion';

const per = Number(process.argv[2] ?? 30);
const waypoint = process.argv.includes('--waypoint');
const seeds = weekendSeeds({ year: 2026, month: 10, dayOfMonth: 31 }, per * 3);
const tally = new Map<string, { n: number; carved: number; planned: number; circuit: number; sprint: number; waypoint: number; special: number; misses: number[] }>();
for (const seed of seeds) {
  const kind = weekendOf(seed)!.kind;
  const t = tally.get(kind) ?? { n: 0, carved: 0, planned: 0, circuit: 0, sprint: 0, waypoint: 0, special: 0, misses: [] };
  tally.set(kind, t);
  t.n++;
  const plan = planRoads(seed);
  const area = plan.districts.areas.find((a) => a.kind === kind && a.params.region === 1);
  const r = area ? regionOf(area) : null;
  if (r) t.carved++;
  if (area?.params.planned === 1) t.planned++;
  if (r && spineDirection(plan.graph, plan.routeNodes.circuit, true, r)) t.circuit++;
  if (r && spineDirection(plan.graph, plan.routeNodes.sprint, false, r)) t.sprint++;
  if (plan.event.special) t.special++;
  else t.misses.push(seed);
  if (waypoint && r) {
    const city = createCity(seed);
    const ca = city.districts.areas.find((a) => a.kind === kind && a.params.region === 1)!;
    const route = createRoute(city, 'waypoint');
    if (spineDirection(city.graph, route.nodes, false, regionOf(ca)!, false)) t.waypoint++;
  }
}
for (const [kind, t] of tally) {
  console.log(`${kind}: ${t.n} seeds, carved ${t.carved}, planned ${t.planned}, circuit ${t.circuit}, sprint ${t.sprint}${waypoint ? `, waypoint ${t.waypoint}` : ''}, special ${t.special}${t.misses.length ? `; no special: ${t.misses.join(' ')}` : ''}`);
}
