/**
 * The El's station names: a station is named for the neighbourhood it stands in, the way a real line
 * names its stops, so the name on the platform board (render/districts/subway.ts) is the one the map
 * and the gateway banners use. A second station in one neighbourhood takes the nearest named street
 * instead ("Kessler Ave"), and a third the street's blade name plus a number, so no two boards on a
 * city's line read alike. Pure: the graph and the neighbourhood plan in, strings out.
 */
import type { World } from '../world';
import { hoodAt } from './neighbourhoods';
import { hoodsOf } from './places';
import { streetNames } from './streetNames';

/** The name of each station at the given world points, in order. */
export function stationNames(world: World, points: readonly { x: number; z: number }[]): string[] {
  hoodsOf(world);
  const streets = streetNames(world);
  const g = world.graph;
  const taken = new Set<string>();
  return points.map((p) => {
    let name = hoodAt(world, p.x, p.z, null).name;
    if (taken.has(name)) {
      let best = -1;
      let bestD = Infinity;
      for (const e of g.edges) {
        if (streets.ofEdge[e.id] < 0) continue;
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        const d = (a.x + dx * t - p.x) ** 2 + (a.z + dz * t - p.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = e.id;
        }
      }
      if (best >= 0) name = streets.streets[streets.ofEdge[best]].blade;
      for (let n = 2; taken.has(name); n++) name = `${name.replace(/ \d+$/, '')} ${n}`;
    }
    taken.add(name);
    return name;
  });
}
