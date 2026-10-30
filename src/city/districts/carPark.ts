/**
 * Multi-storey car park: a shortcut variant that goes up through a garage.
 *
 * Where a route turns at a junction C with no street straight behind it, the
 * line of the street it turns into (E) runs on backwards into the block
 * behind C. A multi-storey garage taking that whole block lets racers leave
 * the route on an earlier street of the same block, climb its ramp to the
 * first parking floor (the deck, deckHeight up, with more levels drawn over
 * it), cross that floor and leave over a kicker at the end of a walled exit
 * lane (the chute) that lies exactly on E's line, out through the front
 * facade: the jump carries them over the sidewalk and the junction and drops
 * them onto E heading down it. Two layouts, both found by the planner:
 *  - side entry: the route reaches C along the block's side (an S bend: it
 *    turned at the block's corner before C); the ramp climbs from that street
 *    toward E's line and a turn on the deck lines the car up with the chute;
 *  - back entry: the route passes the block's far side first; ramp, deck and
 *    chute are one straight run across the block.
 * The footprint is the block: its building line inset, when the block is
 * convex and not comically large (CFG.blockArea), else cut down behind the
 * drive or the largest frame rectangle that fits (footprintFor). The whole
 * floor is drivable, a real parking floor, not an empty roof: stalls nose in
 * along the parapets and in double rows down the floor with aisles between
 * them, parked cars in half of them, columns on the bay grid and a stair core
 * in a corner (carParkFloor), all kept an open aisle's width off the racing
 * line, the exit lane and the ramp's mouth; the chute's funnel flares wider
 * on the side the turn arrives from. The ramp climbs inside the footprint
 * (only its flared apron reaches the building line), so the block's downtown
 * buildings are gone and its frontage is the garage's own facades.
 * Back entries need the far street's frontage free right on E's line, which
 * is where its junction usually sits, so nearly every car park is a side
 * entry; about a tenth of the seeds get one.
 *
 * In line: the chute is aligned with E's tangent and its walls bound the
 * launch heading for any straight line through it to LAUNCH_BOUND (a car's
 * width inside chuteWidth over chuteLength: about 6 degrees). The landing
 * zone is E's straight from C on, free of junctions and bends for the
 * furthest a launch can carry (flightReach of a run-up speed bound measured
 * in the sim) plus a roll-out; C's closures stay out of the flight, the route's
 * corner rail is cut where the flight crosses it (carParkRails) and street
 * furniture keeps off the launch cone (reserved circles). The apron gets the
 * shortcut treatment on the sidewalk, fence lines and cones funnelling in with
 * strings of bulbs across the mouth and the curb, and a string across the lip
 * (entryDressing).
 *
 * The sim is 2.5D (World.heightAt is single valued), so the drivable floor is
 * a raised surface with an exact gradient (one height modifier: the ramp's
 * eased profile, the deck deckHeight above the ground, the kicker's parabola)
 * and the storeys under and over it are render only. Every edge of the floor
 * is a thin two sided solid (Wall.solid): one body stops cars on the deck at
 * the parapet and cars in the street at the facade under it, with no one
 * sided band reaching through to the other side; the ramp's side walls part
 * it from the deck beside it the same way. The exception is the lip:
 * the face under it is a low wall (Wall.top) that stops cars in the street
 * but lets a car launching off the deck fly over it; its height is set once
 * the terrain exists (settleCarParks). Hills keep their slopes off car parks
 * (hills.ts) and a ramp is long enough that its climb, with the ground's own
 * rise, stays under maxClimb (a crest a fast car keeps its wheels on). On the
 * other route, which the car park is not a shortcut of, a shutter closes the
 * ramp (carParkGates).
 *
 * Planning: the best sites of both routes are held while the alley shortcuts
 * are carved (carParkSites, PlanContext.keepOut: a corner cut would take
 * their block), as long as each route keeps a spot for an alley of its own;
 * once the graph is final the car parks are planned for real (planCarParks).
 * Race progress on the ramp and the deck follows the car park's own line,
 * mapped onto the route stretch it skips (carParkProgress), so it runs on
 * smoothly and is credited in full; a car up there is never counted lost.
 * AI never takes it, like every shortcut. render/districts/carPark.ts draws it.
 *
 * The parts live in carPark/: geometry (CarParkGeo and what is read off it), floor (stalls, parked cars,
 * columns), walls (the solid pieces, corner rails and shutters), plan (where car parks go) and progress (race
 * progress on the ramp and deck). This module is the district itself (the DistrictModule, its entry dressing,
 * the settled lip height, the ground under it) and the public surface the rest of the city imports.
 */
import { CITY } from '../config';
import type { Terrain } from '../terrain';
import type { PropKind } from '../props';
import { Vec2, atan2, sqrt } from '../../sim/math';
import { Rng } from '../../sim/prng';
import { pointInPolygon, polygonCentroid } from './geom';
import type { Area, AreaBuild, DistrictModule, HeightSample } from './types';
import { emptyBuild } from './types';
import { CAR_HALF, type CarParkGeo, LAUNCH_BOUND, carParkGeo, carParkLift, carParks, footprint, frontU, rampPoint, toWorld } from './carPark/geometry';
import { carParkWalls } from './carPark/walls';

export { APRON, CAR_HALF, LAUNCH_BOUND, ROUTE_INDEX, carParkGeo, carParkHeight, carParkLift, carParkOutline, carParks, flightCorridor, frontU, funnelFlare, rampHalf, rampPoint, rampProfile, type CarParkGeo } from './carPark/geometry';
export { COLUMN, PARKED_CAR, carParkFloor, columnBox, parkedCarBox, type CarParkFloor, type Stall } from './carPark/floor';
export { carParkGates, carParkRails, carParkWalls, deckEdges, deckOpenings, nearCarParkFlight, railsClearOf, type DeckEdgeKind } from './carPark/walls';
export { carParkCandidates, carParkSites, flightReach, planCarParks } from './carPark/plan';
export { carParkProgress, onCarPark } from './carPark/progress';

const CFG = CITY.districts.carPark;
/** Surface patch priority of the deck and ramp: above every street classification. */
const DECK_PRIORITY = 7;
/** The face under the lip stops street cars up to this far below the roof (m); a launching car is above it. */
const LIP_DROP = 1.6;
/**
 * The entry's funnel on the sidewalk (the shortcut language): each fence line splays this much wider
 * (m) from the apron's flared wall out to the curb, a panel every panelStep m; strings of shortcut
 * bulbs hang across the mouth and the curb line, and across the lip opening on the exit facade.
 */
const FUNNEL = { flare: 5, panelStep: 2.1 } as const;

export const carParkModule: DistrictModule = {
  kind: 'carPark',
  phase: 'graph',
  // Planned by planCarParks from world.ts's topology hook (it needs both routes). Here, registered right
  // after the night market (whose carriageway edit forbids claimed faces), each claims its block.
  plan(ctx) {
    const faces = ctx.faces();
    for (const a of ctx.areas) {
      if (a.kind !== 'carPark' || a.faces.length) continue;
      const g = carParkGeo(a);
      // A point on the ramp (inside the deck by construction): a curved block's footprint is concave, and its
      // centroid can lie outside it, in the block across the street.
      const p = g.ramp.length ? polygonCentroid(g.ramp) : polygonCentroid(g.deck);
      const f = faces.find((x) => !x.outer && pointInPolygon(p.x, p.z, x.ring));
      if (!f || ctx.claims.face.has(f.id)) continue;
      a.faces = [f.id];
      ctx.claims.face.set(f.id, a.id);
    }
  },
  build(ctx, area) {
    const b = emptyBuild();
    const g = carParkGeo(area);
    b.heightMods.push({
      minX: g.box.minX - 0.5,
      minZ: g.box.minZ - 0.5,
      maxX: g.box.maxX + 0.5,
      maxZ: g.box.maxZ + 0.5,
      add(x: number, z: number, out: HeightSample) {
        carParkLift(g, x, z, out);
      },
    });
    b.surfaces.push({ surface: 'road', polygon: g.deck, priority: DECK_PRIORITY, area: area.id });
    b.walls.push(...carParkWalls(g, area.params.seed ?? 0));
    // The block's buildings go (the garage is the block; they keep `clear` off its facades where it
    // does not reach the building line) and its frontage opens (the parapets and the facades under them
    // are the walls), reaching out past the building line so every frontage probe falls in.
    b.exclusions.push(...footprint(g, CFG.clear));
    b.openings.push(...footprint(g, 2));
    const W = (u: number, v: number) => toWorld(g, u, v);
    // Street furniture keeps off the flight (the launch cone and a car's width, out to the furthest
    // landing: over the sidewalk, the junction and the landing street's sidewalks), and off the driveway.
    const spread = Math.tan(LAUNCH_BOUND);
    for (let s = 0; s <= g.landMax + 2.5; s += 2.5) {
      const c = W(-s, 0);
      b.reserved.push({ x: c.x, z: c.z, r: g.hc + s * spread + CAR_HALF });
    }
    for (let k = -1; k <= 1; k++) {
      const c = rampPoint(g, g.apron0 - 3, k * (g.rhw + (k < 0 ? g.fl : g.fr) * 0.6));
      b.reserved.push({ x: c.x, z: c.z, r: g.rhw + 1 });
    }
    // A sawhorse and cones at the ramp's foot (smashed on the way in). Inside, the ceiling's strip lights
    // light the floor (render/districts/carPark.ts): no lamp posts under a ceiling.
    const rng = new Rng(((area.params.seed ?? 0) >>> 0) || 1);
    const across = Math.atan2(-g.rax, -g.raz);
    b.destructibles.push({ kind: 'sawhorse', ...rampPoint(g, g.apron1 + 1.5, rng.range(-1.4, 1.4)), yaw: across + rng.range(-0.15, 0.15), lift: 0, area: area.id });
    for (let k = 0; k < 4; k++) {
      const p = rampPoint(g, g.apron0 + 1 + rng.range(0, 4), (k < 2 ? -1 : 1) * (g.rhw + (k < 2 ? g.fl : g.fr) * 0.4 - rng.range(0, 1.2)));
      b.destructibles.push({ kind: 'trafficCone', ...p, yaw: rng.range(0, Math.PI * 2), lift: 0, area: area.id });
    }
    entryDressing(g, b, rng, ctx.graph.edges[g.entryEdge].sidewalk, area.id);
    return b;
  },
};

/**
 * The entry's shortcut treatment, as a channel ramp top or an alley mouth gets
 * (districts/channel.ts funnel, alleyDressing.ts constructionSite): two lines
 * of fence panels on the sidewalk splaying from the ends of the apron's
 * flared walls out to the curb, cones scattered inside them, a sawhorse at
 * each line's curb end, and strings of the shortcut bulbs across the mouth at
 * the building line and across the curb line in front of it; a third string
 * hangs across the lip opening on the exit facade, so the way out reads from
 * the landing street too. Everything on the ground breaks before it can stop
 * a car; the strings are render only (hints, render/districts/carPark.ts).
 * The entry street's lanes stay clear: nothing stands past the curb.
 */
function entryDressing(g: CarParkGeo, b: AreaBuild, rng: Rng, sidewalk: number, area: number): void {
  const an = g.rax * g.fnx + g.raz * g.fnz;
  const ln = -g.raz * g.fnx + g.rax * g.fnz;
  /** The building line's a (m up the ramp axis) at lateral l: the apron's foot is cut by it. */
  const footA = (l: number) => -(l * ln) / an;
  /** A sidewalk point `back` m out from the building line toward the curb, at lateral l of the ramp axis. */
  const P = (l: number, back: number): Vec2 => {
    const q = rampPoint(g, footA(l), l);
    return { x: q.x - g.fnx * back, z: q.z - g.fnz * back };
  };
  const push = (kind: PropKind, q: Vec2, yaw: number) => b.destructibles.push({ kind, x: q.x, z: q.z, yaw, lift: 0, area });
  const t = CFG.wall;
  const curbBack = sidewalk - 0.9;
  const ends: Vec2[] = [];
  for (const sd of [-1, 1]) {
    // From just past the flared wall's end at the building line to the curb, FUNNEL.flare further out.
    const lIn = sd * (g.rhw + (sd < 0 ? g.fl : g.fr) + t + 0.6);
    const A = P(lIn, 0.8);
    const B = P(lIn + sd * FUNNEL.flare, curbBack);
    ends.push(B);
    const len = sqrt((B.x - A.x) ** 2 + (B.z - A.z) ** 2);
    const ux = (B.x - A.x) / len;
    const uz = (B.z - A.z) / len;
    const yaw = atan2(-uz, ux);
    const n = Math.max(2, Math.round(len / FUNNEL.panelStep));
    for (let k = 0; k <= n; k++) {
      const q = { x: A.x + (B.x - A.x) * (k / n), z: A.z + (B.z - A.z) * (k / n) };
      push('fencePanel', q, yaw + rng.range(-0.1, 0.1));
      // Street furniture keeps off the line (generateProps drops a destructible that overlaps a prop).
      b.reserved.push({ x: q.x, z: q.z, r: 1.6 });
    }
    // Cones inside the line (toward the mouth), light enough that a car through them barely notices.
    const inX = -sd * uz;
    const inZ = sd * ux;
    const k0 = (inX * -g.raz + inZ * g.rax) * sd < 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) {
      const f = 0.25 + k * 0.25 + rng.range(0, 0.1);
      const off = rng.range(1.5, 2.2);
      push('trafficCone', { x: A.x + (B.x - A.x) * f + k0 * inX * off, z: A.z + (B.z - A.z) * f + k0 * inZ * off }, rng.range(0, Math.PI * 2));
    }
    // A sawhorse along the curb past the line's end.
    const C = P(lIn + sd * (FUNNEL.flare + 2.4), curbBack - 0.3);
    push('sawhorse', C, atan2(-g.rax, -g.raz) + rng.range(-0.15, 0.15));
    b.reserved.push({ x: C.x, z: C.z, r: 1.6 });
  }
  // Strings of bulbs: across the mouth between the flared walls' ends, across the curb line in front
  // (both on posts: values [0]), and across the lip opening (hung under the ceiling: values [1]).
  const mouth = [P(-(g.rhw + g.fl + t + 0.3), 0.6), P(g.rhw + g.fr + t + 0.3, 0.6)];
  b.hints.push({ kind: 'stringLights', points: mouth, values: [0] });
  b.hints.push({ kind: 'stringLights', points: ends, values: [0] });
  for (const q of [...mouth, ...ends]) b.reserved.push({ x: q.x, z: q.z, r: 0.8 });
  const W = (u: number, v: number) => toWorld(g, u, v);
  b.hints.push({ kind: 'stringLights', points: [W(frontU(g, -g.hc) + 0.3, -(g.hc - 0.25)), W(frontU(g, g.hc) + 0.3, g.hc - 0.25)], values: [1] });
}

/**
 * Give the face under each lip its height (Wall.top): the ground in front of
 * it plus the roof less LIP_DROP. Runs once the terrain exists (createCity);
 * until then the face is full height (top Infinity).
 */
export function settleCarParks(areas: readonly Area[], builds: readonly AreaBuild[], terrain: Terrain): void {
  areas.forEach((a, i) => {
    if (a.kind !== 'carPark') return;
    const g = carParkGeo(a);
    const front = toWorld(g, -1.2, 0);
    const top = terrain.heightAt(front.x, front.z) + g.H - LIP_DROP;
    for (const w of builds[i].walls) if (w.top !== undefined) w.top = top;
  });
}

/**
 * World height with the car parks taken back out: the ground under their
 * decks and ramps (the renderer's coarse ground mesh, which would otherwise
 * bulge up around a roof and poke out over the sidewalks).
 */
export function groundHeight(world: { areas: readonly Area[]; heightAt(x: number, z: number): number }): (x: number, z: number) => number {
  const list = carParks(world.areas);
  if (!list.length) return world.heightAt;
  const s: HeightSample = { h: 0, gx: 0, gz: 0 };
  return (x, z) => {
    s.h = 0;
    for (const g of list) carParkLift(g, x, z, s);
    return world.heightAt(x, z) - s.h;
  };
}
