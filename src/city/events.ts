/**
 * Event flavours: every seed names its race event (Hill Climb, River Run,
 * Alley Sprint, Under the El, Ring Rush, Grand Tour, Downtown Dash) with a
 * one line tagline, so seeds feel different before the start. The flavour is
 * a weighted draw on its own stream (deriveSeed(seed, 'event')) among the
 * ones this city can deliver: no River Run without the river channel, no
 * Under the El without the El, no Ring Rush with fewer than two roundabouts.
 *
 * The flavour shapes the race. planRoads (world.ts) hands both route finders
 * the flavour's RoutePreference: a graded rating of what it wants (metres in
 * the channel, through raceway alleys or under the El, roundabouts on the
 * way, the block that can hold the monument, share on the wide fast roads,
 * open ground with room for a hill), anchor nodes the searches start from
 * and a Dijkstra weight bias toward its feature.
 * Every flavour but River Run keeps the river dive as a second wish where the
 * channel exists (rated below the flavour's own), so the channel stays part
 * of most races. Hills and the monument are planned after the routes
 * (districts/index.ts: the routes are picked as soon as the street topology
 * is final, before any block is claimed), so Hill Climb and Grand Tour work
 * the other way round: the hills and monument planners read the routes
 * through PlanContext.event and lift the blocks the routes run along, or set
 * the plaza on a block beside them.
 *
 * resolveEvent then checks, once everything is planned, that both routes
 * really deliver the flavour by its own measure; a seed whose routes do not
 * (no hill fitted on them, no alley within reach) falls back to Downtown
 * Dash, which every city has, so the name never promises what the race does
 * not have.
 *
 * Every seed then titles its event from the flavour's words: a lead from a
 * shared night street list and one of the flavour's own nouns (Cobalt
 * Ascent, Last Call Backstreet Run, Sodium Rail Run), and one of its
 * taglines, on a stream of their own (deriveSeed(seed, 'eventTitle')) so the
 * words never move the flavour draw or the city. The noun always says the
 * flavour, so the title still promises what the race has; with about a
 * hundred leads and a dozen nouns a flavour has over a thousand titles, so
 * neighbouring seeds rarely share one. Pure and deterministic.
 */
import { CITY, ROUTE } from './config';
import type { RoadGraph } from './roadGraph';
import { edgeBetween, isBendNode } from './roadGraph';
import { turnAngle } from './route';
import type { RoutePreference } from './routeSearch';
import type { Area, HeightSample, PlanContext } from './districts/types';
import { hillAt, hillSiteEdges, shapeOf } from './districts/hills';
import { TOUR_REACH, monumentSites, plazaSides, plazaWraps } from './districts/monument';
import { parkCorners } from './districts/park';
import { riverCenter } from './districts/river';
import { Rng, deriveSeed } from '../sim/prng';
import { DEG, type Vec2, abs, distToSegment, sqrt } from '../sim/math';

export type EventFlavourId = 'hillClimb' | 'riverRun' | 'alleySprint' | 'underTheEl' | 'ringRush' | 'grandTour' | 'downtownDash';

export interface EventFlavour {
  /** The flavour's own name (docs, tests, debugging); players see a seed's title built from `nouns`. */
  name: string;
  /** Title nouns that each say the flavour; a seed's title is a lead (EVENT_LEADS) and one of these. */
  nouns: readonly string[];
  /** One line under the title, one drawn per seed. */
  taglines: readonly string[];
  /** Relative weight of the draw among the flavours a city offers. */
  weight: number;
}

/** Every flavour, in draw order (the order is part of the pick: keep it fixed). */
export const EVENT_FLAVOURS: Readonly<Record<EventFlavourId, EventFlavour>> = {
  hillClimb: {
    name: 'Hill Climb',
    nouns: ['Hill Climb', 'Ascent', 'Crest Run', 'Heights', 'Summit Run', 'Ridge Run', 'Hill Run', 'Switchbacks', 'Uphill', 'High Road', 'Climb', 'Peak Chase', 'Gradient', 'Rise'],
    taglines: [
      'Up the heights and light over the crests',
      'Every crest a blind one, every landing a hard one',
      'Climb the ridges, fly the tops, brake for the dips',
      'The city tilts and the throttle stays pinned',
      'Air over the summits, grip on the way down',
      'Steep streets and short sightlines',
    ],
    weight: 3,
  },
  riverRun: {
    name: 'River Run',
    nouns: ['River Run', 'Channel Run', 'Flood Run', 'Riverbed Dash', 'Spillway', 'Floodway', 'Canal Run', 'Low Water', 'Storm Drain', 'Dry Bed Dash', 'Undertow', 'Embankment', 'Waterline', 'Culvert Run'],
    taglines: [
      'Down the ramps and flat out along the channel',
      'Drop into the concrete river and keep it pinned',
      'Below the bridges, between the walls, no way out but forward',
      'The channel runs dry tonight and so does the grip',
      'Down the banks and under every bridge in town',
      'Floor it along the floodway before the tide turns',
    ],
    weight: 3,
  },
  alleySprint: {
    name: 'Alley Sprint',
    nouns: ['Alley Sprint', 'Backstreet Run', 'Back Alley', 'Cobble Dash', 'Narrows', 'Gauntlet', 'Alleyway', 'Lane Run', 'Brick Run', 'Squeeze', 'Side Streets', 'Cutthrough', 'Bottleneck', 'Back Lanes'],
    taglines: [
      'Wall to wall through the cobbled alleys',
      'Mirrors folded, inches either side',
      'Brick on the left, brick on the right, nothing in between',
      'The shortcuts nobody else dares',
      'Cobbles, bins and fire escapes at full tilt',
      'Thread the back lanes the cabs avoid',
    ],
    weight: 2.5,
  },
  underTheEl: {
    name: 'Under the El',
    nouns: ['El Run', 'Rail Run', 'Pillar Run', 'Elevated', 'Trestle Run', 'Underline', 'Girder Run', 'Line Chase', 'Third Rail', 'Train Chase', 'Overpass', 'Viaduct', 'Steel Canopy', 'Last Train'],
    taglines: [
      'Pillar to pillar beneath the trains',
      'Race the last train along the line',
      'Under the girders where the sparks come down',
      'Steel overhead and pillars on every side',
      'Follow the tracks and dodge the columns',
      'The trains run on time, and so do you',
    ],
    weight: 2.5,
  },
  ringRush: {
    name: 'Ring Rush',
    nouns: ['Ring Rush', 'Roundabout', 'Rotary Run', 'Circle Rush', 'Spin Cycle', 'Carousel', 'Whirl', 'Round Robin', 'Ring Road', 'Merry-Go-Round', 'Orbit', 'Loop', 'Gyre', 'Circus'],
    taglines: [
      'Roundabout to roundabout, never lift',
      'Round and round and out the other side',
      'Every circle taken flat, every exit a gamble',
      'Lean on the curbs and slingshot out',
      'The city spins and you spin with it',
      'Ring after ring, keep it on the edge',
    ],
    weight: 2,
  },
  grandTour: {
    name: 'Grand Tour',
    nouns: ['Grand Tour', 'Monument Run', 'Landmark Loop', 'City Tour', 'Grand Prix', 'Plaza Run', 'Memorial Run', 'Statue Run', 'Victory Lap', 'Promenade', 'Postcard Run', 'Pageant', 'Parade', 'Sightseer'],
    taglines: [
      'Downtown and past the floodlit monument',
      'The landmark tour, at three times the speed limit',
      'Past the statue and through the square',
      'All the sights, none of the stops',
      'Floodlights, flagstones and a monument to beat',
      'The postcard route, driven like a getaway',
    ],
    weight: 1.5,
  },
  downtownDash: {
    name: 'Downtown Dash',
    nouns: ['Downtown Dash', 'City Sprint', 'Boulevard Run', 'Avenue Blitz', 'Main Street', 'Uptown Run', 'Skyline Run', 'Midtown Rush', 'Express', 'Blitz', 'Fast Lane', 'Crosstown', 'Gridlock', 'Straightaway'],
    taglines: [
      'Long straights through the heart of the city',
      'Boulevards wide open and every light green',
      'Top gear down the avenues',
      'Through the towers, flat out',
      'Crosstown at full chat',
      'Wide roads, tall buildings, no brakes',
    ],
    weight: 1.5,
  },
};

/**
 * Title leads every flavour shares: night, light, weather, metal and the hours of a night out.
 * One word or two, so a title stays short enough for the gantry sign and the menu.
 */
const EVENT_LEADS: readonly string[] = [
  'Midnight', 'Neon', 'Chrome', 'Sodium', 'Afterglow', 'Static', 'Velvet', 'Redline', 'Graveyard', 'Cobalt',
  'Amber', 'Crimson', 'Violet', 'Indigo', 'Electric', 'Phantom', 'Ghost', 'Shadow', 'Silver', 'Golden',
  'Iron', 'Steel', 'Copper', 'Mercury', 'Nitro', 'Turbo', 'Hyper', 'Rogue', 'Outlaw', 'Wildcard',
  'Lucky', 'Last Call', 'Moonlit', 'Starlit', 'Blackout', 'Full Moon', 'Witching Hour', 'Late Shift', 'Night Owl', 'Sundown',
  'Twilight', 'Dusk', 'After Hours', 'Small Hours', 'Zero Hour', 'Overtime', 'Overdrive', 'Full Throttle', 'Flat Out', 'Wide Open',
  'Hot Lap', 'Blue Light', 'Red Light', 'Green Light', 'Tail Light', 'High Beam', 'Smoke', 'Thunder', 'Lightning', 'Storm',
  'Rain Slick', 'Asphalt', 'Concrete', 'Rubber', 'Burnout', 'Backfire', 'Boost', 'Apex', 'Slipstream', 'Vapor',
  'Plasma', 'Laser', 'Pulse', 'Voltage', 'Dynamo', 'Comet', 'Meteor', 'Nova', 'Eclipse', 'Cyclone',
  'Wildfire', 'Inferno', 'Ember', 'Frost', 'Black Ice', 'Northside', 'Southside', 'Eastside', 'Westside', 'Harbor',
  'Dockside', 'Old Town', 'Rooftop', 'Saturday Night', 'Friday Night', 'Neon Noir', 'Jackpot', 'Diamond', 'Obsidian', 'Onyx',
  'Scarlet', 'Ultraviolet', 'Infrared', 'Gasoline', 'Octane', 'Hot Wire', 'Getaway', 'Wanted', 'Renegade', 'Vandal',
];

/** Whole words of a title part, lower case, for keeping a word from appearing twice (Neon Noir Neon ...). */
const wordsOf = (s: string): string[] => s.toLowerCase().split(/[\s-]+/);

/** A seed's title and tagline for a flavour, on their own stream so they never move anything else. */
export function eventTitle(seed: number, id: EventFlavourId): { name: string; tagline: string } {
  const rng = new Rng(deriveSeed(seed, 'eventTitle'));
  const f = EVENT_FLAVOURS[id];
  const noun = f.nouns[Math.floor(rng.next() * f.nouns.length)];
  const nounWords = wordsOf(noun);
  // Ghost + Ghost Train: redraw a lead that repeats a word of the noun (bounded: few leads clash with any noun).
  let lead = EVENT_LEADS[Math.floor(rng.next() * EVENT_LEADS.length)];
  for (let i = 0; i < 8 && wordsOf(lead).some((w) => nounWords.includes(w)); i++) lead = EVENT_LEADS[Math.floor(rng.next() * EVENT_LEADS.length)];
  const tagline = f.taglines[Math.floor(rng.next() * f.taglines.length)];
  return { name: `${lead} ${noun}`, tagline };
}

const ORDER = Object.keys(EVENT_FLAVOURS) as EventFlavourId[];

/**
 * What each flavour asks of a route (m unless noted). A rating is 0 (none
 * of it), 1 (some) or 2 (plenty); a route delivers the flavour at 1. `bias`
 * multiplies the Dijkstra weight of the feature's edges (below 1 draws the
 * routes along them).
 */
export const EVENTS = {
  /** Channel floor on the route (m) that delivers / rates 2: a dive and a good stretch along the channel, which runs the whole map. */
  riverRun: { some: 160, long: 420, bias: 0.7 },
  alleySprint: { long: 180, bias: 0.6 },
  underTheEl: { some: 100, long: 300, bias: 0.6 },
  /** Roundabouts on the route for a rating of 1 and 2; edges into a roundabout get the bias. */
  ringRush: { bias: 0.7 },
  /**
   * Before the monument exists: a route along one of the `targets` blocks nearest the center that
   * can hold its plaza (monumentSites) rates 2, along any such block 1; the targets' corners are the
   * searches' anchors. One target, so both routes aim for the same block. Afterwards a route
   * delivers when it passes the landmark within `pass`.
   */
  grandTour: { targets: 1, pass: 140 },
  /**
   * Hill climbing (sum of rises along the route from the hills alone) that delivers / rates 2. While
   * picking routes (no hills yet) a Hill Climb wants route metres on open ground, where a hill's
   * slopes fit: nodes this far (m) from the channel's bank top, the El and any roundabout.
   */
  hillClimb: { some: 5, long: 10, riverClear: 130, elClear: 100, ringClear: 140, openSome: 100, openLong: 300, bias: 0.6 },
  /** Share of the route on boulevards, avenues and diagonals that rates 1 / 2. */
  downtownDash: { some: 0.3, long: 0.45, bias: 0.85 },
  /** Hill sample spacing along a route (m). */
  sampleStep: 5,
  /** Dijkstra weight factor of the level crossing's street (districts/bluff.ts), for every flavour. */
  crossingBias: 0.5,
  /** Dijkstra weight factor of the sides of a block that can hold the monument plaza (its race passes), for every flavour. */
  plazaBias: 0.75,
} as const;

export interface CityEvent {
  id: EventFlavourId;
  /** The seed's title (menu, intro card, start gantry, results): a lead and one of the flavour's nouns. */
  name: string;
  /** One of the flavour's taglines. */
  tagline: string;
  /** The flavour the seed drew (differs from id when its routes could not deliver it). */
  drawn: EventFlavourId;
}

/** A route as the planners pass it around: graph nodes in driving order, closed for circuits. */
export interface EventRoute {
  nodes: number[];
  closed: boolean;
}

/** Graph edges between consecutive route nodes (with the wrap edge on circuits). */
export function routeEdges(g: RoadGraph, nodes: readonly number[], closed: boolean): number[] {
  const out: number[] = [];
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) out.push(edgeBetween(g, nodes[i], nodes[(i + 1) % nodes.length]));
  return out;
}

/** What a city offers the flavours, gathered once per graph from the areas planned so far. */
interface Venue {
  g: RoadGraph;
  /** The planning context, when there is one (route picking): for the monument's candidate blocks. */
  ctx?: SiteContext;
  channel: boolean;
  /** Total length of the channel floor edges (m). */
  channelLength: number;
  /** Feet of the river's side ramps (ford feet where there are none): the dive's anchors. */
  feet: number[];
  alleyNodes: number[];
  elEdges: Set<number>;
  elNodes: number[];
  /** River and El areas (channel profile, deck path), for the open ground a hill needs. */
  rivers: Area[];
  elPaths: Vec2[][];
  rings: number[];
  /** The bluff's level crossing streets (districts/bluff.ts): every flavour wishes its routes over the tracks. */
  crossings: Set<number>;
  crossingNodes: number[];
  cx: number;
  cz: number;
}

/** What monumentSites needs of a PlanContext. */
type SiteContext = Pick<PlanContext, 'graph' | 'areas' | 'claims' | 'faces'>;

function venue(g: RoadGraph, areas: readonly Area[], ctx?: SiteContext): Venue {
  const channel = g.edges.some((e) => e.kind === 'channel');
  const feet = (ford: boolean) => g.nodes.filter((nd) => nd.edges.some((e) => g.edges[e].kind === 'channel') && nd.edges.filter((e) => g.edges[e].kind === 'ramp').length === (ford ? 2 : 1)).map((nd) => nd.id);
  const alley = new Set<number>();
  for (const e of g.edges) if (e.kind === 'alley') alley.add(e.a).add(e.b);
  const elEdges = new Set<number>();
  const elNodes = new Set<number>();
  for (const a of areas) {
    if (a.kind !== 'subway') continue;
    for (const e of a.edges) elEdges.add(e);
    for (const n of a.nodes) elNodes.add(n);
  }
  return {
    g,
    ctx,
    channel,
    channelLength: g.edges.reduce((m, e) => m + (e.kind === 'channel' ? e.length : 0), 0),
    feet: channel ? (feet(false).length ? feet(false) : feet(true)) : [],
    alleyNodes: [...alley].sort((a, b) => a - b),
    elEdges,
    elNodes: [...elNodes].sort((a, b) => a - b),
    rivers: areas.filter((a) => a.kind === 'river'),
    // The El's line, and the highway's (its deck and ramps keep hills off too, hills.ts).
    elPaths: areas.filter((a) => a.kind === 'subway' || (a.kind === 'highway' && a.variant === 'deck')).map((a) => a.path),
    rings: g.nodes.filter((n) => n.ring).map((n) => n.id),
    crossings: new Set(areas.filter((a) => a.kind === 'bluff').map((a) => a.params.crestEdge)),
    crossingNodes: areas.filter((a) => a.kind === 'bluff').flatMap((a) => [g.edges[a.params.crestEdge].a, g.edges[a.params.crestEdge].b]),
    cx: (g.bounds.minX + g.bounds.maxX) / 2,
    cz: (g.bounds.minZ + g.bounds.maxZ) / 2,
  };
}

/** Flavours this city can deliver, in draw order. */
export function eventOffer(g: RoadGraph, areas: readonly Area[]): EventFlavourId[] {
  const v = venue(g, areas);
  const can: Record<EventFlavourId, boolean> = {
    hillClimb: CITY.districts.hills.enabled,
    riverRun: v.channel && v.feet.length > 0,
    alleySprint: v.alleyNodes.length > 0,
    underTheEl: v.elEdges.size > 0,
    ringRush: v.rings.length >= 2,
    grandTour: CITY.districts.monument.enabled,
    downtownDash: true,
  };
  return ORDER.filter((id) => can[id]);
}

/** The seed's flavour: a weighted draw among `offer` on its own stream. */
export function pickEventFlavour(seed: number, offer: readonly EventFlavourId[]): EventFlavourId {
  const rng = new Rng(deriveSeed(seed, 'event'));
  let total = 0;
  for (const id of offer) total += EVENT_FLAVOURS[id].weight;
  let r = rng.next() * total;
  for (const id of offer) {
    r -= EVENT_FLAVOURS[id].weight;
    if (r < 0) return id;
  }
  return offer.length ? offer[offer.length - 1] : 'downtownDash';
}

const tier = (x: number, some: number, long: number): number => (x >= long ? 2 : x >= some ? 1 : 0);

function metres(g: RoadGraph, edges: readonly number[], on: (e: number) => boolean): number {
  let m = 0;
  for (const e of edges) if (e >= 0 && on(e)) m += g.edges[e].length;
  return m;
}

/** A flavour's own wish at route picking time: its rating (0..2), anchors and edge bias. */
interface Wish {
  rate(edges: number[], nodes: number[]): number;
  anchors: number[];
  bias?: (edge: number) => number;
}

/** Ratings shared by route picking and the final check (the features exist by then). */
function featureRate(id: EventFlavourId, v: Venue, edges: number[], nodes: number[]): number {
  const g = v.g;
  switch (id) {
    case 'riverRun':
      return tier(metres(g, edges, (e) => g.edges[e].kind === 'channel'), EVENTS.riverRun.some, EVENTS.riverRun.long);
    case 'alleySprint':
      return tier(metres(g, edges, (e) => g.edges[e].kind === 'alley'), 1e-9, EVENTS.alleySprint.long);
    case 'underTheEl':
      return tier(metres(g, edges, (e) => v.elEdges.has(e)), EVENTS.underTheEl.some, EVENTS.underTheEl.long);
    case 'ringRush': {
      let n = 0;
      for (const id of nodes) if (g.nodes[id].ring) n++;
      return Math.min(2, n);
    }
    case 'downtownDash': {
      const fast = metres(g, edges, (e) => ['boulevard', 'avenue', 'diagonal'].includes(g.edges[e].kind));
      const all = metres(g, edges, () => true);
      return tier(fast / Math.max(1, all), EVENTS.downtownDash.some, EVENTS.downtownDash.long);
    }
    default:
      return 0;
  }
}

function wishOf(id: EventFlavourId, v: Venue): Wish {
  const g = v.g;
  const rate = (edges: number[], nodes: number[]) => featureRate(id, v, edges, nodes);
  const kindBias = (kinds: readonly string[], f: number) => (e: number) => (kinds.includes(g.edges[e].kind) ? f : 1);
  switch (id) {
    case 'riverRun':
      return { rate, anchors: v.feet, bias: kindBias(['channel'], EVENTS.riverRun.bias) };
    case 'alleySprint':
      return { rate, anchors: v.alleyNodes, bias: kindBias(['alley'], EVENTS.alleySprint.bias) };
    case 'underTheEl':
      return { rate, anchors: v.elNodes, bias: (e) => (v.elEdges.has(e) ? EVENTS.underTheEl.bias : 1) };
    case 'ringRush':
      return { rate, anchors: v.rings, bias: (e) => (g.nodes[g.edges[e].a].ring || g.nodes[g.edges[e].b].ring ? EVENTS.ringRush.bias : 1) };
    case 'downtownDash':
      return { rate, anchors: [], bias: kindBias(['boulevard', 'avenue', 'diagonal'], EVENTS.downtownDash.bias) };
    case 'grandTour': {
      // The monument is planned after the routes and takes a block on them (monument.ts): the routes
      // run along the blocks that can hold it, the nearest the center (shared by both) first.
      const sites = v.ctx ? monumentSites(v.ctx, TOUR_REACH) : [];
      const near = new Set<number>();
      const any = new Set<number>();
      const anchors = new Set<number>();
      sites.forEach((p, i) => {
        for (const e of p.f.edges) (i < EVENTS.grandTour.targets ? near : any).add(e);
        if (i < EVENTS.grandTour.targets) for (const c of p.f.corners) anchors.add(c.node);
      });
      return {
        rate: (edges) => (edges.some((e) => near.has(e)) ? 2 : edges.some((e) => any.has(e)) ? 1 : 0),
        anchors: [...anchors].filter((n) => !g.nodes[n].ring).sort((a, b) => a - b),
      };
    }
    case 'hillClimb': {
      // Hills are planned after the routes and come to the race (hills.ts); the routes only make sure
      // there is open ground on the way, clear of everything a hill's slopes must keep away from.
      const open = openGround(v);
      // A hill takes a whole block, not just the route's two junctions: where the planning context lists the
      // blocks, a street counts when a hill really fits on a free block along it (hillSiteEdges: variable block
      // spacing, the highway and the rest left far corners near what the slopes must keep off).
      let edgeOpen = (e: number) => open[g.edges[e].a] && open[g.edges[e].b];
      let anchors = g.nodes.filter((n) => open[n.id]).map((n) => n.id);
      if (v.ctx) {
        const sites = hillSiteEdges(v.ctx);
        edgeOpen = (e) => sites.has(e);
        anchors = [...new Set([...sites].flatMap((e) => [g.edges[e].a, g.edges[e].b]))].filter((n) => !g.nodes[n].ring).sort((a, b) => a - b);
      }
      return {
        rate: (edges) => tier(metres(g, edges, edgeOpen), EVENTS.hillClimb.openSome, EVENTS.hillClimb.openLong),
        anchors,
        bias: (e) => (edgeOpen(e) ? EVENTS.hillClimb.bias : 1),
      };
    }
  }
}

/** Per node: clear of the river channel, the El and the roundabouts by EVENTS.hillClimb's margins (room for a hill). */
function openGround(v: Venue): boolean[] {
  const c = EVENTS.hillClimb;
  return v.g.nodes.map((n) => {
    for (const r of v.rivers) if (Math.abs(n.z - riverCenter(r.params, n.x)) < r.params.top + c.riverClear) return false;
    for (const path of v.elPaths) for (let i = 0; i + 1 < path.length; i++) if (distToSegment(n.x, n.z, path[i].x, path[i].z, path[i + 1].x, path[i + 1].z) < c.elClear) return false;
    for (const id of v.rings) if (sqrt((v.g.nodes[id].x - n.x) ** 2 + (v.g.nodes[id].z - n.z) ** 2) < c.ringClear) return false;
    return true;
  });
}

/**
 * The route finders' preference for a flavour on this graph (findCircuitNodes /
 * findSprintNodes). Ratings: the flavour's own wish counts most, the river
 * dive (every flavour but River Run, where the channel exists), a run over
 * the bluff's level crossing (where there is one, districts/bluff.ts) add one
 * each, and a block that can hold the monument plaza (where the monument is
 * enabled) one for a run along a side, two for wrapping it (a route along,
 * round or wrapping such a block gets a race pass across the plaza,
 * districts/monument.ts), so a route with everything wins, then the flavour
 * alone, then the side wishes alone.
 */
export function eventRoutePreference(id: EventFlavourId, ctx: SiteContext, closed: boolean): RoutePreference {
  const g = ctx.graph;
  const v = venue(g, ctx.areas, ctx);
  const wish = wishOf(id, v);
  const dive = v.channel && id !== 'riverRun';
  const dives = (edges: number[]) => edges.some((e) => e >= 0 && g.edges[e].kind === 'channel');
  const cross = v.crossings.size > 0;
  const crosses = (edges: number[]) => edges.some((e) => v.crossings.has(e));
  const plazaStreets = CITY.districts.monument.enabled ? plazaSides(ctx, TOUR_REACH) : new Set<number>();
  // The parks' race passes share the wish: a turn round a corner of a block that can hold a park (park.ts).
  if (CITY.districts.park.enabled) for (const k of parkCorners(ctx)) plazaStreets.add(k.eA).add(k.eB);
  const plaza = plazaStreets.size > 0;
  const wraps = plaza ? plazaWraps(ctx, TOUR_REACH) : new Set<string>();
  // The plaza wish: 2 for wrapping a block (turning at both ends of one of its sides: a U cut
  // straight across the plaza), 1 for running along a side (a chicane or a corner pass).
  const plazaWish = (nodes: number[], edges: number[]) => {
    if (!edges.some((e) => plazaStreets.has(e))) return 0;
    const n = nodes.length;
    const turning = (i: number) => (closed || (i > 0 && i < n - 1)) && abs(turnAngle(g, nodes[(i - 1 + n) % n], nodes[i], nodes[(i + 1) % n])) > ROUTE.passStraightDeg * DEG;
    let prev = -1;
    for (let i = 0; i < n + (closed ? 1 : 0); i++) {
      const id = nodes[i % n];
      if (isBendNode(g, id)) continue;
      if (prev >= 0 && turning(prev) && turning(i % n) && wraps.has(`${Math.min(nodes[prev], id)}-${Math.max(nodes[prev], id)}`)) return 2;
      prev = i % n;
    }
    return 1;
  };
  const sides = (dive ? 1 : 0) + (cross ? 1 : 0) + (plaza ? 2 : 0);
  const rate = (nodes: number[]) => {
    const edges = routeEdges(g, nodes, closed);
    const own = wish.rate(edges, nodes);
    return sides ? own * (sides + 1) + (dive && dives(edges) ? 1 : 0) + (cross && crosses(edges) ? 1 : 0) + (plaza ? plazaWish(nodes, edges) : 0) : own;
  };
  const anchors = wish.anchors.length ? wish.anchors : v.feet;
  // The other end of a circuit (or every other sprint waypoint) from the ramp feet, or from the flavour's own anchors again.
  const via0 = dive && wish.anchors.length ? v.feet : anchors;
  const bias0 = wish.bias;
  const bias =
    cross || plaza
      ? (e: number) => (bias0 ? bias0(e) : 1) * (v.crossings.has(e) ? EVENTS.crossingBias : 1) * (plazaStreets.has(e) ? EVENTS.plazaBias : 1)
      : bias0;
  return {
    prefer: (nodes) => rate(nodes) > 0,
    rate,
    goal: sides ? 2 * (sides + 1) + sides : 2,
    anchors,
    // ... and the level crossing's street ends, its street a little cheaper to run along.
    via: cross ? [...via0, ...v.crossingNodes] : via0,
    bias,
  };
}

/**
 * Ground a flavour's routes run for that the route shortcuts must not cut through while they are carved
 * (PlanContext.keepOut, held by world.ts only while every route keeps a spot for a shortcut of its own).
 * A Grand Tour's routes hug its target block, and the shortcuts are cut across the blocks beside a route:
 * one through the target would take it from the monument (monumentSites wants no shortcut on its ring)
 * and leave the routes passing nothing.
 */
export function eventKeepOut(id: EventFlavourId, ctx: SiteContext): Vec2[][] {
  if (id !== 'grandTour' || !CITY.districts.monument.enabled) return [];
  return monumentSites(ctx, TOUR_REACH).slice(0, EVENTS.grandTour.targets).map((p) => p.f.ring);
}

/** Rise along a route from the hills alone (m): the sum of every climb, the base terrain's roll left out. */
export function hillClimbAlong(g: RoadGraph, areas: readonly Area[], nodes: readonly number[], closed: boolean): number {
  const hills = areas.filter((a) => a.kind === 'hills').map(shapeOf);
  if (!hills.length) return 0;
  const s: HeightSample = { h: 0, gx: 0, gz: 0 };
  const at = (x: number, z: number) => {
    s.h = 0;
    for (const h of hills) hillAt(h, x, z, s);
    return s.h;
  };
  let climb = 0;
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) {
    const a = g.nodes[nodes[i]];
    const b = g.nodes[nodes[(i + 1) % nodes.length]];
    const len = sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
    const steps = Math.max(1, Math.ceil(len / EVENTS.sampleStep));
    let prev = at(a.x, a.z);
    for (let k = 1; k <= steps; k++) {
      const h = at(a.x + ((b.x - a.x) * k) / steps, a.z + ((b.z - a.z) * k) / steps);
      if (h > prev) climb += h - prev;
      prev = h;
    }
  }
  return climb;
}

/** Closest a route passes the monument's landmark (m), Infinity without one. */
function monumentPass(g: RoadGraph, areas: readonly Area[], nodes: readonly number[], closed: boolean): number {
  const mon = areas.find((a) => a.kind === 'monument');
  if (!mon) return Infinity;
  const { cx, cz } = mon.params;
  let best = Infinity;
  const m = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < m; i++) {
    const a = g.nodes[nodes[i]];
    const b = g.nodes[nodes[(i + 1) % nodes.length]];
    best = Math.min(best, distToSegment(cx, cz, a.x, a.z, b.x, b.z));
  }
  return best;
}

/** How well a finished route delivers a flavour: 0 (not at all), 1 (it does), 2 (plenty). */
export function eventRating(id: EventFlavourId, g: RoadGraph, areas: readonly Area[], route: EventRoute): number {
  if (id === 'hillClimb') return tier(hillClimbAlong(g, areas, route.nodes, route.closed), EVENTS.hillClimb.some, EVENTS.hillClimb.long);
  if (id === 'grandTour') {
    const d = monumentPass(g, areas, route.nodes, route.closed);
    return d <= EVENTS.grandTour.pass / 2 ? 2 : d <= EVENTS.grandTour.pass ? 1 : 0;
  }
  // Downtown Dash is the fallback every city can run: it always delivers, plenty on the fast roads.
  if (id === 'downtownDash') return Math.max(1, featureRate(id, venue(g, areas), routeEdges(g, route.nodes, route.closed), route.nodes));
  return featureRate(id, venue(g, areas), routeEdges(g, route.nodes, route.closed), route.nodes);
}

/** The event a fully planned city runs: the drawn flavour when every route delivers it, else Downtown Dash. */
export function resolveEvent(seed: number, drawn: EventFlavourId, g: RoadGraph, areas: readonly Area[], routes: readonly EventRoute[]): CityEvent {
  const ok = routes.every((r) => eventRating(drawn, g, areas, r) >= 1);
  const id: EventFlavourId = ok ? drawn : 'downtownDash';
  return { id, ...eventTitle(seed, id), drawn };
}
