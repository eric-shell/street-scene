/**
 * Destructible props: street furniture (streetlights, traffic lights, garbage
 * cans, benches, bus stops) and the clutter districts scatter where racers
 * cut through (bushes, planter pots, cafe tables, barrels, crates, dumpsters,
 * news boxes, trash bags, and the construction site pieces that fence off and
 * fill route shortcuts: fence panels, traffic cones, sawhorse barricades,
 * water filled barriers, sandbags and pallets). Generated once per city (deterministic, from the
 * seed) and stored on CityBlocks.props. The sim tracks which props are broken
 * per race (RaceState.brokenProps) so replays reproduce every hit; the
 * renderer hides a broken prop's intact instance and spawns debris.
 *
 * Id layout: props[i] for i < blocks.streetlights.length is streetlights[i]
 * (same position, `light` = i), then traffic lights, then sidewalk furniture,
 * then district props in area order. Street furniture stands on a sidewalk,
 * never on the drivable road, and clear of intersection mouths (where route
 * barriers go); district props stand where their area put them (pockets,
 * parks, alleys). No prop overlaps another.
 */
import { CITY } from './config';
import type { EdgeMouths, Sector, Streetlight } from './blocks';
import type { RoadGraph } from './roadGraph';
import { SpatialGrid } from './spatial';
import type { Terrain } from './terrain';
import { Rng, deriveSeed } from '../sim/prng';
import { DEG, Vec2, atan2, distToSegment, sin, sqrt } from '../sim/math';

/** Sidewalk furniture placed by generateProps itself. */
export type StreetPropKind = 'streetlight' | 'trafficLight' | 'garbageCan' | 'bench' | 'busStop';
/** Construction site pieces fencing off and filling route shortcuts (districts/alley.ts). */
export type ConstructionPropKind = 'fencePanel' | 'trafficCone' | 'sawhorse' | 'waterBarrier' | 'sandbags' | 'pallets';
/** Clutter districts ask for (DistrictPropSpec): mostly soft, cheap to crash through. */
export type DistrictPropKind = 'bush' | 'planterPot' | 'cafeTable' | 'barrel' | 'crate' | 'dumpster' | 'newsBox' | 'trashBags' | ConstructionPropKind;
export type PropKind = StreetPropKind | DistrictPropKind;

export interface Prop {
  /** Index into CityBlocks.props. Stable for a given seed. */
  id: number;
  kind: PropKind;
  x: number;
  z: number;
  /** Ground height at the prop base (top of the sidewalk). */
  y: number;
  /** Facing: local +Z points toward the road (traffic lights: toward the intersection center). */
  yaw: number;
  /** Collision circle radius in meters (benches/bus stops use their half width). */
  radius: number;
  /** Effective mass in kg: how much a hit slows the car (bigger = slower). */
  mass: number;
  /** Visual height in meters (for debris and render sizing). */
  height: number;
  /** Road edge index the prop sits along, or -1 at intersections. */
  edge: number;
  /** Traffic lights only: road graph node index of the intersection. */
  node?: number;
  /** Streetlights only: index into CityBlocks.streetlights (equal to id). */
  light?: number;
  /** District props: the area (CityDistricts.areas id) that placed it. */
  area?: number;
}

/** A destructible a district module asks for (AreaBuild.destructibles); generateProps places it last. */
export interface DistrictPropSpec {
  kind: PropKind;
  x: number;
  z: number;
  /** Facing (local +Z), rad. */
  yaw: number;
  /** Height of the surface it stands on above the terrain (m): 0 on ground, CITY.curbHeight at sidewalk level. */
  lift: number;
  area: number;
}

export interface PropDef {
  radius: number;
  mass: number;
  height: number;
  /**
   * Extra resistance of a prop bolted into the ground (tall poles, shelters):
   * the hit behaves as if the prop weighed mass * anchor.
   */
  anchor: number;
  /** Below this closing speed (m/s) the prop holds and the car stops against it like a wall. */
  breakSpeed: number;
}

/**
 * Default physical properties per kind. Tuned so a light pole is a big hit and
 * a trash can a small one. District clutter is mostly soft (bushes and trash
 * bags barely slow a car) so cutting through it is worth the risk; a dumpster
 * is the exception: it stops a slow car dead and only goes flying when hit hard.
 */
export const PROP_DEFS: Record<PropKind, PropDef> = {
  streetlight: { radius: 0.22, mass: 320, height: 8.2, anchor: 2.2, breakSpeed: 3 },
  trafficLight: { radius: 0.25, mass: 380, height: 5.6, anchor: 2.2, breakSpeed: 3 },
  garbageCan: { radius: 0.38, mass: 45, height: 1.0, anchor: 1, breakSpeed: 0.5 },
  bench: { radius: 0.9, mass: 110, height: 0.9, anchor: 1.3, breakSpeed: 1.5 },
  busStop: { radius: 1.6, mass: 650, height: 2.6, anchor: 2.6, breakSpeed: 4 },
  bush: { radius: 0.75, mass: 28, height: 1.1, anchor: 1, breakSpeed: 0.2 },
  planterPot: { radius: 0.55, mass: 150, height: 1.5, anchor: 1, breakSpeed: 1.2 },
  cafeTable: { radius: 0.8, mass: 38, height: 2.3, anchor: 1, breakSpeed: 0.3 },
  barrel: { radius: 0.42, mass: 65, height: 1.0, anchor: 1, breakSpeed: 0.4 },
  crate: { radius: 0.6, mass: 75, height: 1.2, anchor: 1, breakSpeed: 0.6 },
  dumpster: { radius: 1.0, mass: 700, height: 1.4, anchor: 1, breakSpeed: 6 },
  newsBox: { radius: 0.32, mass: 55, height: 1.1, anchor: 1, breakSpeed: 0.5 },
  trashBags: { radius: 0.5, mass: 22, height: 0.6, anchor: 1, breakSpeed: 0.1 },
  // Construction pieces. A fence panel (2.4 m of chain link on two feet, a contractor's banner on it)
  // goes down at any closing speed and costs a fast car about 2% of its speed, so a fenced mouth
  // never stops anyone; cones and sawhorses are lighter still. Water filled barriers and sandbag
  // piles are heavier and hold a crawling car, so they stand against the walls, off the line.
  fencePanel: { radius: 0.85, mass: 30, height: 2.1, anchor: 1, breakSpeed: 0.05 },
  trafficCone: { radius: 0.24, mass: 4, height: 0.75, anchor: 1, breakSpeed: 0.02 },
  sawhorse: { radius: 0.7, mass: 14, height: 1.1, anchor: 1, breakSpeed: 0.05 },
  waterBarrier: { radius: 0.9, mass: 120, height: 0.85, anchor: 1, breakSpeed: 0.8 },
  sandbags: { radius: 0.55, mass: 70, height: 0.55, anchor: 1, breakSpeed: 0.6 },
  pallets: { radius: 0.62, mass: 36, height: 0.75, anchor: 1, breakSpeed: 0.2 },
};

/** Construction kinds, for the shortcut builder and tests. */
export const CONSTRUCTION_PROP_KINDS: readonly ConstructionPropKind[] = ['fencePanel', 'trafficCone', 'sawhorse', 'waterBarrier', 'sandbags', 'pallets'];

/** Street furniture kinds (sidewalk only), in the order generateProps places them. */
export const STREET_PROP_KINDS: readonly StreetPropKind[] = ['streetlight', 'trafficLight', 'garbageCan', 'bench', 'busStop'];
export const isStreetProp = (k: PropKind): k is StreetPropKind => (STREET_PROP_KINDS as readonly PropKind[]).includes(k);

/** Emitted as RaceEvent { type: 'prop', car, value: propId } when a car breaks a prop. */
export const PROP_EVENT = 'prop' as const;

/** Distance behind the curb line (into the sidewalk) of each kind's center. */
const SETBACK: Record<StreetPropKind, number> = { streetlight: 0.8, trafficLight: 0.9, garbageCan: 0.9, bench: 2.0, busStop: 2.0 };
/** Furniture keeps this far (along the curb) from each end of an edge: crosswalks, barriers, corners. */
const MOUTH_CLEAR = 12;
/** Clear distance (along the curb) kept around each streetlight pole. */
const POLE_CLEAR = 1.5;
/** Minimum gap between any two props. */
const PROP_GAP = 0.5;

/** Streetlight stations (distance along the curb from the edge's start mouth) for one side. */
export function lightStations(len: number, phase: number): number[] {
  const out: number[] = [];
  const spacing = CITY.streetlightSpacing;
  for (let s = 10 + spacing * phase; s < len - 10; s += spacing) out.push(s);
  return out;
}

/** Curb line of each edge side, as used for streetlights. P side has phase 0, N side 0.5. */
export function edgeSides(g: RoadGraph, mouths: EdgeMouths[], ei: number) {
  const e = g.edges[ei];
  const m = mouths[ei];
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const dl = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
  const d = { x: (b.x - a.x) / dl, z: (b.z - a.z) / dl };
  return [
    { from: m.aP.curb, to: m.bP.curb, inward: { x: d.z, z: -d.x }, phase: 0 },
    { from: m.aN.curb, to: m.bN.curb, inward: { x: -d.z, z: d.x }, phase: 0.5 },
  ];
}

export function generateProps(
  seed: number,
  g: RoadGraph,
  sectors: Sector[][],
  mouths: EdgeMouths[],
  streetlights: Streetlight[],
  terrain: Terrain,
  edgeGrid: SpatialGrid,
  reserved: { x: number; z: number; r: number }[] = [],
  districtProps: readonly DistrictPropSpec[] = [],
): Prop[] {
  const rng = new Rng(deriveSeed(seed, 'props'));
  const props: Prop[] = [];
  const pad = 40;
  const grid = SpatialGrid.forBounds(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad, CITY.broadphaseCell);
  const scratch: number[] = [];

  /** Min distance to any road surface (negative = on the road) and to the outer sidewalk line. */
  const clearances = (x: number, z: number) => {
    edgeGrid.query(x - 1, z - 1, x + 1, z + 1, scratch);
    let road = Infinity;
    let corridor = Infinity;
    for (const id of scratch) {
      const e = g.edges[id];
      const a = g.nodes[e.a];
      const b = g.nodes[e.b];
      const d = distToSegment(x, z, a.x, a.z, b.x, b.z);
      if (d - e.width / 2 < road) road = d - e.width / 2;
      if (d - e.width / 2 - e.sidewalk < corridor) corridor = d - e.width / 2 - e.sidewalk;
    }
    return { road, corridor };
  };

  const fits = (x: number, z: number, r: number): boolean => {
    const c = clearances(x, z);
    // On a sidewalk: off every road, inside some road's sidewalk band.
    if (c.road < r + 0.2 || c.corridor > -r - 0.1) return false;
    // District structures on the sidewalk (subway pillars...).
    for (const q of reserved) if ((q.x - x) ** 2 + (q.z - z) ** 2 < (q.r + r + PROP_GAP) ** 2) return false;
    const reach = r + 2 + PROP_GAP;
    grid.query(x - reach, z - reach, x + reach, z + reach, scratch);
    for (const id of scratch) {
      const p = props[id];
      const min = p.radius + r + PROP_GAP;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) return false;
    }
    return true;
  };

  const push = (kind: PropKind, x: number, z: number, yaw: number, edge: number, extra?: Partial<Prop>): Prop => {
    const def = PROP_DEFS[kind];
    const p: Prop = {
      id: props.length,
      kind,
      x,
      z,
      y: terrain.heightAt(x, z) + CITY.curbHeight,
      yaw,
      radius: def.radius,
      mass: def.mass,
      height: def.height,
      edge,
      ...extra,
    };
    props.push(p);
    grid.insertBox(p.id, x - p.radius, z - p.radius, x + p.radius, z + p.radius);
    return p;
  };

  // 1. Every streetlight is a prop, ids aligned with blocks.streetlights.
  streetlights.forEach((l, i) => push('streetlight', l.x, l.z, atan2(l.dx, l.dz), l.edge, { light: i }));

  // 2. Traffic lights on the corners of real intersections, facing the middle.
  g.nodes.forEach((n, ni) => {
    const m = n.edges.length;
    if (m < 3) return;
    const secs = sectors[ni];
    const eligible = secs.map((s) => s.angle < 170 * DEG && s.curb.length === 1);
    const pick: number[] = [];
    if (m >= 4) {
      // Diagonal corners.
      const parity = rng.int(0, 1);
      for (let k = 0; k < m; k++) if (eligible[k] && (k + parity) % 2 === 0 && !(k === m - 1 && m % 2 === 1 && pick.includes(0))) pick.push(k);
    } else {
      for (let k = 0; k < m; k++) if (eligible[k]) pick.push(k);
      if (pick.length > 2) pick.splice(rng.int(0, pick.length - 1), 1);
    }
    for (const k of pick) {
      const s = secs[k];
      const eA = g.edges[n.edges[k]];
      const eB = g.edges[n.edges[(k + 1) % m]];
      const dA = unitTo(n, g.nodes[eA.a === ni ? eA.b : eA.a]);
      const dB = unitTo(n, g.nodes[eB.a === ni ? eB.b : eB.a]);
      let bx = dA.x + dB.x;
      let bz = dA.z + dB.z;
      const bl = sqrt(bx * bx + bz * bz);
      if (bl < 1e-6) continue;
      bx /= bl;
      bz /= bl;
      // SETBACK behind both curbs: along the bisector that is SETBACK / sin(half angle).
      const off = SETBACK.trafficLight / Math.max(0.3, sin(s.angle / 2));
      const x = s.curb[0].x + bx * off;
      const z = s.curb[0].z + bz * off;
      if (!fits(x, z, PROP_DEFS.trafficLight.radius)) continue;
      push('trafficLight', x, z, atan2(n.x - x, n.z - z), -1, { node: ni });
    }
  });

  // 3. Sidewalk furniture in the gaps between streetlights: cans, benches and the odd bus stop.
  g.edges.forEach((e, ei) => {
    if (e.kind === 'backAlley') return;
    const sides = edgeSides(g, mouths, ei);
    const busSide = e.length >= CITY.propBusStopMinEdge && rng.chance(CITY.propBusStopChance) ? rng.int(0, 1) : -1;
    sides.forEach((side, si) => {
      const ax = side.to.x - side.from.x;
      const az = side.to.z - side.from.z;
      const len = sqrt(ax * ax + az * az);
      if (len < 2 * MOUTH_CLEAR + 4) return;
      const u = { x: ax / len, z: az / len };
      const yaw = atan2(side.inward.x, side.inward.z);
      const at = (s: number, kind: StreetPropKind) => ({
        x: side.from.x + u.x * s - side.inward.x * SETBACK[kind],
        z: side.from.z + u.z * s - side.inward.z * SETBACK[kind],
      });
      const place = (kind: StreetPropKind, lo: number, hi: number): boolean => {
        const r = PROP_DEFS[kind].radius;
        const a = lo + r + 0.3;
        const b = hi - r - 0.3;
        if (b < a) return false;
        const p = at(rng.range(a, b), kind);
        if (!fits(p.x, p.z, r)) return false;
        push(kind, p.x, p.z, yaw, ei);
        return true;
      };
      // Gaps between mouth margins and streetlight poles, in order along the curb.
      const cuts = [MOUTH_CLEAR - POLE_CLEAR, ...lightStations(len, side.phase), len - MOUTH_CLEAR + POLE_CLEAR];
      const gaps: { lo: number; hi: number }[] = [];
      for (let k = 0; k + 1 < cuts.length; k++) {
        const lo = Math.max(MOUTH_CLEAR, cuts[k] + POLE_CLEAR);
        const hi = Math.min(len - MOUTH_CLEAR, cuts[k + 1] - POLE_CLEAR);
        if (hi - lo > 2) gaps.push({ lo, hi });
      }
      if (!gaps.length) return;
      // The bus stop takes the widest gap nearest the middle of the block.
      let busGap = -1;
      if (busSide === si) {
        let best = Infinity;
        gaps.forEach((gp, k) => {
          if (gp.hi - gp.lo < 2 * PROP_DEFS.busStop.radius + 4) return;
          const score = Math.abs((gp.lo + gp.hi) / 2 - len / 2);
          if (score < best) {
            best = score;
            busGap = k;
          }
        });
      }
      gaps.forEach((gp, k) => {
        const mid = (gp.lo + gp.hi) / 2;
        if (k === busGap) {
          const r = PROP_DEFS.busStop.radius;
          const p = at(mid + rng.range(-1, 1), 'busStop');
          if (fits(p.x, p.z, r)) {
            push('busStop', p.x, p.z, yaw, ei);
            // A can beside the shelter.
            if (rng.chance(0.7)) place('garbageCan', mid + r + 1.2, Math.min(gp.hi, mid + r + 3.5));
            return;
          }
        }
        const bench = rng.chance(CITY.propBenchChance);
        const can = rng.chance(CITY.propCanChance);
        if (bench && can) {
          // Bench in one half, can in the other.
          if (rng.chance(0.5)) {
            place('bench', gp.lo, mid);
            place('garbageCan', mid, gp.hi);
          } else {
            place('garbageCan', gp.lo, mid);
            place('bench', mid, gp.hi);
          }
        } else if (bench) place('bench', gp.lo, gp.hi);
        else if (can) place('garbageCan', gp.lo, gp.hi);
      });
    });
  });

  // 4. District clutter, in area order. A spec that would overlap anything already placed is dropped.
  for (const d of districtProps) {
    const r = PROP_DEFS[d.kind].radius;
    const reach = r + 2 + PROP_GAP;
    grid.query(d.x - reach, d.z - reach, d.x + reach, d.z + reach, scratch);
    let clear = true;
    for (const id of scratch) {
      const p = props[id];
      const min = p.radius + r + PROP_GAP * 0.5;
      if ((p.x - d.x) ** 2 + (p.z - d.z) ** 2 < min * min) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    const p = push(d.kind, d.x, d.z, d.yaw, -1, { area: d.area });
    p.y = terrain.heightAt(d.x, d.z) + d.lift;
  }

  return props;
}

function unitTo(p: Vec2, q: Vec2): Vec2 {
  const l = sqrt((q.x - p.x) ** 2 + (q.z - p.z) ** 2) || 1;
  return { x: (q.x - p.x) / l, z: (q.z - p.z) / l };
}

/** Uniform grid over the props for collision queries (ids ascending per query). */
export function buildPropGrid(g: RoadGraph, props: Prop[]): SpatialGrid {
  const pad = 40;
  const grid = SpatialGrid.forBounds(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad, CITY.broadphaseCell);
  for (const p of props) grid.insertBox(p.id, p.x - p.radius, p.z - p.radius, p.x + p.radius, p.z + p.radius);
  return grid;
}
