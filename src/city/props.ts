/**
 * Destructible props: street furniture (streetlights, traffic lights, garbage
 * cans, benches, bus stops, and by neighbourhood fire hydrants, mailboxes,
 * parking meters, phone booths and vending machines, see streetFurniture.ts)
 * and the clutter districts scatter where racers
 * cut through (bushes, planter pots, cafe tables, barrels, crates, dumpsters,
 * news boxes, trash bags, the lantern posts lighting parks and plazas, and
 * the construction site pieces that fence off and fill route shortcuts:
 * fence panels, traffic cones, sawhorse barricades, water filled barriers,
 * sandbags and pallets, and the harbor's dock clutter: oil drums and cable
 * spools). Generated once per city (deterministic, from the
 * seed) and stored on CityBlocks.props. The sim tracks which props are broken
 * per race (RaceState.brokenProps) so replays reproduce every hit; the
 * renderer hides a broken prop's intact instance and spawns debris.
 *
 * Id layout: props[i] for i < blocks.streetlights.length is streetlights[i]
 * (same position, `light` = i), then traffic lights, then sidewalk furniture,
 * then the power poles (UTILITY_POLES: a run of wooden poles along one side
 * of a street in the la neighbourhoods, each linked to the next by `wireTo`
 * for the wires the renderer hangs between them), then district props in
 * area order. Street furniture stands on a sidewalk,
 * never on the drivable road, and clear of intersection mouths (where route
 * barriers go); district props stand where their area put them (pockets,
 * parks, alleys). No prop overlaps another.
 */
import { CITY, UTILITY_POLES } from './config';
import type { EdgeMouths, Sector, Streetlight } from './blocks';
import { BUS_BAY, BusBay, bayHitsCircle, baysByEdge, bayPoint } from './busBays';
import { FURNITURE, furnishStreets } from './streetFurniture';
import type { RoadGraph } from './roadGraph';
import { chainOf, chains, downtownFactor, isChannelEdge, isFeatureEdge } from './roadGraph';
import type { Region } from './regions';
import { SpatialGrid } from './spatial';
import type { Terrain } from './terrain';
import { Rng, deriveSeed } from '../sim/prng';
import { DEG, Vec2, atan2, distToSegment, sin, sqrt } from '../sim/math';

/** Sidewalk furniture placed by generateProps itself. */
export type StreetPropKind = 'streetlight' | 'trafficLight' | 'garbageCan' | 'bench' | 'busStop' | 'utilityPole' | FurnitureKind;
/** Neighbourhood street furniture (streetFurniture.ts): what makes one street read different from the next. */
export type FurnitureKind = 'hydrant' | 'parkingMeter' | 'mailbox' | 'phoneBooth' | 'vendingMachine';
/** Construction site pieces fencing off and filling route shortcuts (districts/alleyDressing.ts). */
export type ConstructionPropKind = 'fencePanel' | 'trafficCone' | 'sawhorse' | 'waterBarrier' | 'sandbags' | 'pallets';
/** Night market pieces (districts/market.ts): lantern lit awning stalls, fruit crates spilling off the curb, food carts. */
export type MarketPropKind = 'marketStall' | 'fruitCrates' | 'foodCart';
/** A harbor's dock clutter (districts/waterfrontYard.ts): steel oil drums in rows, wooden cable spools on their sides. */
export type DockPropKind = 'drum' | 'cableSpool';
/** A beach's furniture (districts/waterfrontBeach.ts): umbrellas and loungers on the sand, volleyball net panels, the boardwalk's low picket fence. */
export type BeachPropKind = 'umbrella' | 'lounger' | 'volleyNet' | 'picketFence';
/** The scrapyard's tyre stacks (districts/scrapyard.ts): four tyres piled, in rows along the canyon and as walls round the bowls. */
export type ScrapPropKind = 'tyreStack';
/**
 * Clutter districts ask for (DistrictPropSpec): mostly soft, cheap to crash through. Park lamps light parks and
 * plazas (render/street/areaLights.ts); bollards fence the middle of a roundabout island (districts/roundabout.ts).
 */
export type DistrictPropKind = 'bush' | 'planterPot' | 'cafeTable' | 'barrel' | 'crate' | 'dumpster' | 'newsBox' | 'trashBags' | 'parkLamp' | 'bollard' | ConstructionPropKind | MarketPropKind | DockPropKind | BeachPropKind
  | ScrapPropKind;
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
  /**
   * Long props (bus shelters): half thickness (m) along the facing. The
   * collision shape is then a capsule of this radius whose ends reach
   * `radius` each way along local X; `radius` stays the bounding circle.
   */
  depth?: number;
  /** A bus stop in a bus bay: index into CityBlocks.bays. */
  bay?: number;
  /** A power pole: the id of the next pole along its run, which its wires span to (absent at a run's end). */
  wireTo?: number;
  /** A power pole carrying a transformer drum (every UTILITY_POLES.transformerEvery along a run). */
  transformer?: boolean;
}

/** What the power poles need from the city beyond the graph (blocks.ts passes it). */
export interface PoleContext {
  /** The seed's home city (regions.ts homeOf). */
  home: Region;
  /** The neighbourhood region at a point (regions.ts regionMap). */
  regionAt(x: number, z: number): Region;
  /** Edges no run takes: a district's streets, lane closures. */
  skip: ReadonlySet<number>;
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
  // A cast iron lantern post: a lighter hit than a streetlight, but still a pole that holds a crawling car.
  parkLamp: { radius: 0.18, mass: 190, height: 4.4, anchor: 1.8, breakSpeed: 2 },
  // A steel bollard bolted into the paving: it holds a crawling car and costs a fast one about a fifth of its speed.
  bollard: { radius: 0.17, mass: 60, height: 1.0, anchor: 7, breakSpeed: 4 },
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
  // Night market: an awning stall on its table of goods costs a 1.5 t car about 3.5% of its speed, a
  // food cart 5%, a stack of fruit crates under 2%; all go down at any closing speed worth the name.
  marketStall: { radius: 1.1, mass: 55, height: 2.6, anchor: 1, breakSpeed: 0.3 },
  fruitCrates: { radius: 0.5, mass: 26, height: 0.85, anchor: 1, breakSpeed: 0.1 },
  foodCart: { radius: 0.75, mass: 85, height: 2.3, anchor: 1, breakSpeed: 0.5 },
  // Dock clutter. A 200 litre steel drum with a little oil in it is a solid knock (about 4% of a 1.5 t car's
  // speed) that still goes flying at any speed worth the name; a wooden cable spool on its side is a real hit,
  // about a tenth of the speed, and holds a car that only nudges it.
  drum: { radius: 0.32, mass: 70, height: 0.9, anchor: 1, breakSpeed: 0.7 },
  cableSpool: { radius: 0.8, mass: 150, height: 1.5, anchor: 1, breakSpeed: 1.2 },
  // Four tyres piled: a dull, heavy bounce that goes over at any speed worth the name and costs a fast 1.5 t car about 3% of it.
  tyreStack: { radius: 0.5, mass: 60, height: 0.9, anchor: 1, breakSpeed: 0.3 },
  // Beach furniture, all soft: a beach umbrella (a pole in the sand under a canopy) and a plastic lounger go down at any
  // speed and cost a fast car about 1%; a net panel (two poles' worth of netting) and a picket panel a couple of percent.
  umbrella: { radius: 1.0, mass: 16, height: 2.5, anchor: 1, breakSpeed: 0.04 },
  lounger: { radius: 0.85, mass: 12, height: 0.45, anchor: 1, breakSpeed: 0.03 },
  volleyNet: { radius: 0.95, mass: 22, height: 2.45, anchor: 1, breakSpeed: 0.05 },
  picketFence: { radius: 0.85, mass: 18, height: 1.1, anchor: 1, breakSpeed: 0.04 },
  // Neighbourhood furniture. A cast iron hydrant is a stubby, bolted lump: it holds a crawling car
  // and costs a fast one about a seventh of its speed (then gushes, render/street/hydrantSpray.ts). Parking
  // meters and mailboxes are light knocks; a phone booth or a vending machine is a real hit.
  hydrant: { radius: 0.24, mass: 110, height: 0.85, anchor: 2, breakSpeed: 2.5 },
  parkingMeter: { radius: 0.14, mass: 28, height: 1.45, anchor: 1.6, breakSpeed: 0.6 },
  mailbox: { radius: 0.36, mass: 85, height: 1.25, anchor: 1.2, breakSpeed: 1 },
  phoneBooth: { radius: 0.6, mass: 240, height: 2.4, anchor: 1.3, breakSpeed: 2.5 },
  vendingMachine: { radius: 0.52, mass: 330, height: 1.9, anchor: 1, breakSpeed: 3 },
  // A 40 ft wooden power pole set 2 m into the ground: a little lighter than a steel streetlight but buried deeper, so it
  // holds a crawling car and costs a fast one about as much; it snaps at its base like one (render/street/props.ts).
  utilityPole: { radius: 0.2, mass: 300, height: 10.4, anchor: 2.4, breakSpeed: 3.5 },
};

/** Neighbourhood furniture kinds (streetFurniture.ts). */
export const FURNITURE_KINDS: readonly FurnitureKind[] = ['hydrant', 'parkingMeter', 'mailbox', 'phoneBooth', 'vendingMachine'];

/** Street furniture kinds (sidewalk only), in the order generateProps places them. */
export const STREET_PROP_KINDS: readonly StreetPropKind[] = ['streetlight', 'trafficLight', 'garbageCan', 'bench', 'busStop', ...FURNITURE_KINDS, 'utilityPole'];
export const isStreetProp = (k: PropKind): k is StreetPropKind => (STREET_PROP_KINDS as readonly PropKind[]).includes(k);

/** Distance behind the curb line (into the sidewalk) of each kind's center. */
export const SETBACK: Record<StreetPropKind, number> = {
  streetlight: 0.8,
  trafficLight: 0.9,
  garbageCan: 0.9,
  bench: 2.0,
  busStop: 2.0,
  // Hydrants, meters and mailboxes stand at the curb, booths a step back, vending machines against the frontage.
  hydrant: 0.6,
  parkingMeter: 0.55,
  mailbox: 0.75,
  phoneBooth: 1.1,
  vendingMachine: 3.38,
  // Nominal: a power pole stands UTILITY_POLES.across of its own sidewalk's width back from the curb.
  utilityPole: 2.7,
};
/** Furniture keeps this far (along the curb) from each end of an edge: crosswalks, barriers, corners. */
export const MOUTH_CLEAR = 12;
/** Clear distance (along the curb) kept around each streetlight pole. */
export const POLE_CLEAR = 1.5;
/** Minimum gap between any two props. */
const PROP_GAP = 0.5;

/**
 * Where one side of an edge sits along its street's side: a street is a chain of pieces through
 * bend nodes (roadGraph.ts), and the poles, gaps and bus stops are laid out along the whole street,
 * not restarted at every piece. Curb length of the pieces before this one (m) and the street side's
 * total (m); a street of one piece has before 0 and total its own length.
 */
export interface SideSpan {
  before: number;
  total: number;
}

/** Streetlight stations (distance along the curb from the edge's start mouth) for one side: every CITY.streetlightSpacing along the street side, 10 m clear of its junctions. */
export function lightStations(len: number, phase: number, span: SideSpan = { before: 0, total: len }): number[] {
  const out: number[] = [];
  const spacing = CITY.streetlightSpacing;
  for (let s = 10 + spacing * phase; s < span.total - 10; s += spacing) {
    const local = s - span.before;
    if (local >= 0 && local < len) out.push(local);
  }
  return out;
}

/**
 * Furniture gaps along one block side (m from its start): between the mouth margins and the
 * streetlight poles, in order. The mouth margin belongs to the street's junction ends only: at a
 * bend node the sidewalk simply goes on.
 */
export function sidewalkGaps(len: number, phase: number, span: SideSpan = { before: 0, total: len }): { lo: number; hi: number }[] {
  const startClear = span.before > 1e-6 ? 0 : MOUTH_CLEAR;
  const endClear = span.before + len < span.total - 1e-6 ? 0 : MOUTH_CLEAR;
  const cuts = [startClear - POLE_CLEAR, ...lightStations(len, phase, span), len - endClear + POLE_CLEAR];
  const gaps: { lo: number; hi: number }[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const lo = Math.max(startClear, cuts[k] + POLE_CLEAR);
    const hi = Math.min(len - endClear, cuts[k + 1] - POLE_CLEAR);
    if (hi - lo > 2) gaps.push({ lo, hi });
  }
  return gaps;
}

/** Curb lengths of an edge's P and N sides (m). */
function curbLengths(mouths: EdgeMouths[], ei: number): [number, number] {
  const m = mouths[ei];
  return [sqrt((m.bP.curb.x - m.aP.curb.x) ** 2 + (m.bP.curb.z - m.aP.curb.z) ** 2), sqrt((m.bN.curb.x - m.aN.curb.x) ** 2 + (m.bN.curb.z - m.aN.curb.z) ** 2)];
}

/** The spans (SideSpan) of an edge's P and N sides along its street. */
function sideSpans(g: RoadGraph, mouths: EdgeMouths[], ei: number): [SideSpan, SideSpan] {
  const own = curbLengths(mouths, ei);
  const c = chainOf(g, ei);
  if (c.edges.length === 1) return [{ before: 0, total: own[0] }, { before: 0, total: own[1] }];
  // Walk the street piece by piece, each piece's sides in the walk's orientation (a piece running
  // against the walk swaps them), summing the curb lengths before this piece and overall.
  const before = [0, 0];
  const total = [0, 0];
  let seen = false;
  let forward = true;
  for (let k = 0; k < c.edges.length; k++) {
    const id = c.edges[k];
    const fwd = g.edges[id].a === c.nodes[k];
    const lens = curbLengths(mouths, id);
    const p = fwd ? lens[0] : lens[1];
    const n = fwd ? lens[1] : lens[0];
    if (id === ei) {
      seen = true;
      forward = fwd;
    } else if (!seen) {
      before[0] += p;
      before[1] += n;
    }
    total[0] += p;
    total[1] += n;
  }
  if (forward) return [{ before: before[0], total: total[0] }, { before: before[1], total: total[1] }];
  // Our P side is the walk's N side, measured from the other end.
  return [
    { before: total[1] - before[1] - own[0], total: total[1] },
    { before: total[0] - before[0] - own[1], total: total[0] },
  ];
}

/** Curb line of each edge side, as used for streetlights. P side has phase 0, N side 0.5; `span` places the side along its street. */
export function edgeSides(g: RoadGraph, mouths: EdgeMouths[], ei: number) {
  const e = g.edges[ei];
  const m = mouths[ei];
  const a = g.nodes[e.a];
  const b = g.nodes[e.b];
  const dl = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2) || 1;
  const d = { x: (b.x - a.x) / dl, z: (b.z - a.z) / dl };
  const spans = sideSpans(g, mouths, ei);
  return [
    { from: m.aP.curb, to: m.bP.curb, inward: { x: d.z, z: -d.x }, phase: 0, span: spans[0] },
    { from: m.aN.curb, to: m.bN.curb, inward: { x: -d.z, z: d.x }, phase: 0.5, span: spans[1] },
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
  bays: readonly BusBay[] = [],
  poles?: PoleContext,
): Prop[] {
  const rng = new Rng(deriveSeed(seed, 'props'));
  const props: Prop[] = [];
  const pad = 40;
  const grid = SpatialGrid.forBounds(g.bounds.minX - pad, g.bounds.minZ - pad, g.bounds.maxX + pad, g.bounds.maxZ + pad, CITY.broadphaseCell);
  const scratch: number[] = [];
  const bayOf = baysByEdge(bays, g.edges.length);

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

  /** `across`: the prop's half size toward the road and the frontage (a shelter's half depth), `r` its bounding radius. */
  const fits = (x: number, z: number, r: number, across = r): boolean => {
    const c = clearances(x, z);
    // On a sidewalk: off every road, inside some road's sidewalk band.
    if (c.road < across + 0.2 || c.corridor > -across - 0.1) return false;
    // Out of the bus bays (their asphalt was sidewalk to the edge distances above).
    for (const id of scratch) for (const b of bayOf[id]) if (bayHitsCircle(b, x, z, across, 0.08)) return false;
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
    // Never on a corner beside a channel ramp or channel edge: a side ramp's T is no intersection, and a
    // pole there stands in the mouth a racer turns into.
    const eligible = secs.map((s, k) => s.angle < 170 * DEG && s.curb.length === 1 && !isChannelEdge(g.edges[n.edges[k]]) && !isChannelEdge(g.edges[n.edges[(k + 1) % m]]) && !isFeatureEdge(g.edges[n.edges[k]]) && !isFeatureEdge(g.edges[n.edges[(k + 1) % m]]));
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
    // One stop per street at most, on the piece that holds the street's middle (a street is a chain
    // of pieces through bend nodes; the stop goes to the gap nearest its middle below).
    const hostsMiddle = sides.some((s) => {
      const len = sqrt((s.to.x - s.from.x) ** 2 + (s.to.z - s.from.z) ** 2);
      return s.span.before <= s.span.total / 2 && s.span.total / 2 < s.span.before + len;
    });
    const streetLength = Math.max(sides[0].span.total, sides[1].span.total);
    const roll = hostsMiddle && streetLength >= CITY.propBusStopMinEdge && rng.chance(CITY.propBusStopChance) ? rng.int(0, 1) : -1;
    // A bus bay always has its stop (busBays.ts): the shelter at the back of the narrowed sidewalk.
    const bay = bayOf[ei].find((b) => b.kind === 'bus');
    const busSide = bay ? (bay.side === 1 ? 0 : 1) : roll;
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
      const gaps = sidewalkGaps(len, side.phase, side.span);
      if (!gaps.length) return;
      // A bay's stop stands in the bay's own gap; nothing else does.
      if (bay && busSide === si) {
        const k = gaps.findIndex((gp) => gp.lo <= bay.s0 + 1e-6 && gp.hi >= bay.s1 - 1e-6);
        const mid = (bay.s0 + bay.s1) / 2 + rng.range(-1.5, 1.5);
        const v = bay.depth + (e.sidewalk - bay.depth) / 2;
        const at2 = (s: number, back: number) => bayPoint(bay, s, back);
        const p = at2(mid, v);
        if (k >= 0 && fits(p.x, p.z, PROP_DEFS.busStop.radius, BUS_BAY.shelterDepth)) {
          push('busStop', p.x, p.z, yaw, ei, { depth: BUS_BAY.shelterDepth, bay: bay.id });
          // A can on the narrow sidewalk beside the shelter.
          if (rng.chance(0.7)) {
            const q = at2(mid + PROP_DEFS.busStop.radius + rng.range(1.1, 2.4), bay.depth + 0.75);
            if (fits(q.x, q.z, PROP_DEFS.garbageCan.radius)) push('garbageCan', q.x, q.z, yaw, ei);
          }
          gaps.splice(k, 1);
        }
      }
      // The bus stop takes the widest gap nearest the middle of the block.
      let busGap = -1;
      if (busSide === si && !bay) {
        let best = Infinity;
        gaps.forEach((gp, k) => {
          if (gp.hi - gp.lo < 2 * PROP_DEFS.busStop.radius + 4) return;
          const score = Math.abs((gp.lo + gp.hi) / 2 - (side.span.total / 2 - side.span.before));
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
          if (fits(p.x, p.z, r, BUS_BAY.shelterDepth)) {
            push('busStop', p.x, p.z, yaw, ei, { depth: BUS_BAY.shelterDepth });
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

  // 3b. Neighbourhood furniture (streetFurniture.ts): hydrants, mailboxes, meters, booths, vending machines.
  furnishStreets(seed, g, mouths, (kind, x, z, yaw, edge) => {
    if (!fits(x, z, PROP_DEFS[kind].radius)) return false;
    push(kind, x, z, yaw, edge);
    return true;
  });

  // 3c. Power poles along the la streets, on their own stream so everything above stays where it was.
  if (poles && UTILITY_POLES.enabled) {
    const fitsPole = (x: number, z: number): boolean => {
      if (!fits(x, z, PROP_DEFS.utilityPole.radius)) return false;
      const U = UTILITY_POLES;
      const reach = Math.max(U.lightClear, U.hydrantClear);
      grid.query(x - reach, z - reach, x + reach, z + reach, scratch);
      for (const id of scratch) {
        const p = props[id];
        const min = p.kind === 'streetlight' || p.kind === 'trafficLight' || p.kind === 'utilityPole' ? U.lightClear : p.kind === 'hydrant' ? U.hydrantClear : 0;
        if ((p.x - x) ** 2 + (p.z - z) ** 2 < min * min) return false;
      }
      return true;
    };
    placePoles(seed, g, mouths, poles, fitsPole, (x, z, yaw, edge) => push('utilityPole', x, z, yaw, edge));
  }

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

/**
 * The power pole runs (UTILITY_POLES): one per eligible street, a chain of pieces through bend nodes walked as one
 * curb, so the rhythm and the wires go on through a street's kinks. Every chain draws its share roll, its side and
 * its stations whether or not it takes a run or a station fits, so the stream never depends on what fits. A station
 * that does not fit slides along the curb; one that never fits is dropped, and a gap longer than maxSpan breaks the
 * run's wires.
 */
function placePoles(
  seed: number,
  g: RoadGraph,
  mouths: EdgeMouths[],
  ctx: PoleContext,
  fits: (x: number, z: number) => boolean,
  push: (x: number, z: number, yaw: number, edge: number) => Prop,
): void {
  const U = UTILITY_POLES;
  const rng = new Rng(deriveSeed(seed, 'utilityPoles'));
  const kinds = new Set<string>(U.kinds);
  /** Poles placed so far, city-wide: every transformerEvery'th carries a drum, so short runs share them evenly. */
  let count = 0;
  for (const c of chains(g)) {
    const roll = rng.next();
    const right = rng.next() < 0.5;
    const ok = c.edges.every((ei) => {
      const e = g.edges[ei];
      return kinds.has(e.kind) && !e.shortcut && !e.bridge && !isChannelEdge(e) && !isFeatureEdge(e) && !ctx.skip.has(ei) && e.sidewalk >= U.minSidewalk;
    });
    const me = g.edges[c.edges[c.edges.length >> 1]];
    const mx = (g.nodes[me.a].x + g.nodes[me.b].x) / 2;
    const mz = (g.nodes[me.a].z + g.nodes[me.b].z) / 2;
    const outer = downtownFactor(g.plan, mx, mz) <= FURNITURE.mid;
    const share = ctx.regionAt(mx, mz) !== 'la' ? 0 : ctx.home === 'la' ? U.homeShare : outer ? U.awayShare : 0;
    // The walk side's curb, piece by piece in walk order (the P side of a piece is right of its a -> b travel).
    const segs = c.edges.map((id, k) => {
      const e = g.edges[id];
      const m = mouths[id];
      const fwd = e.a === c.nodes[k];
      const useP = right === fwd;
      const A = g.nodes[e.a];
      const B = g.nodes[e.b];
      const dl = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2) || 1;
      const dx = (B.x - A.x) / dl;
      const dz = (B.z - A.z) / dl;
      const p0 = useP ? m.aP.curb : m.aN.curb;
      const p1 = useP ? m.bP.curb : m.bN.curb;
      const from = fwd ? p0 : p1;
      const to = fwd ? p1 : p0;
      const len = sqrt((to.x - from.x) ** 2 + (to.z - from.z) ** 2);
      // Toward the road from this side's curb (edgeSides' inward).
      const inx = useP ? dz : -dz;
      const inz = useP ? -dx : dx;
      return { edge: id, from, len, ux: (to.x - from.x) / (len || 1), uz: (to.z - from.z) / (len || 1), inx, inz, back: U.across * e.sidewalk };
    });
    let total = 0;
    for (const sg of segs) total += sg.len;
    const stations: number[] = [];
    for (let s = U.cornerClear + rng.range(0, U.lead); s <= total - U.cornerClear; s += rng.range(U.pitch[0], U.pitch[1])) stations.push(s);
    if (!ok || roll >= share) continue;
    /** The pole at curb distance s along the walk, or null where it does not fit. */
    const at = (s: number): { x: number; z: number; yaw: number; edge: number } | null => {
      if (s < U.cornerClear || s > total - U.cornerClear) return null;
      let k = 0;
      while (k < segs.length - 1 && s > segs[k].len) s -= segs[k++].len;
      const sg = segs[k];
      const t = Math.min(sg.len, Math.max(0, s));
      const x = sg.from.x + sg.ux * t - sg.inx * sg.back;
      const z = sg.from.z + sg.uz * t - sg.inz * sg.back;
      return fits(x, z) ? { x, z, yaw: atan2(sg.inx, sg.inz), edge: sg.edge } : null;
    };
    let prev: Prop | null = null;
    let prevS = 0;
    let run = 0;
    for (const s0 of stations) {
      let spot: { x: number; z: number; yaw: number; edge: number } | null = null;
      let s = s0;
      for (let k = 0; k <= 2 * U.tries && !spot; k++) {
        s = s0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * U.slide;
        spot = at(s);
      }
      if (!spot) continue;
      if (!prev || s - prevS > U.maxSpan) run = 0;
      const p = push(spot.x, spot.z, spot.yaw, spot.edge);
      if (count++ % U.transformerEvery === U.transformerAt) p.transformer = true;
      if (prev && run > 0) prev.wireTo = p.id;
      prev = p;
      prevS = s;
      run++;
    }
  }
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
