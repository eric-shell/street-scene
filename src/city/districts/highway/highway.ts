/**
 * Elevated highway: an expressway on a deck crossing the city west to east,
 * on 60% of seeds (highwayRolled: the first draw of its own stream). It is
 * planned like the El (subway.ts), transposed: it follows one grid row's
 * street centered over it, and once or twice swings to the next row on a
 * diagonal street of its own laid across one block corner to corner, the deck
 * turning through each of the swing's junctions on an arc; where its row's
 * street is missing that street is laid again. So the deck stands over a
 * street everywhere, and every street under it is widened to the deck's width
 * (UNDER_WIDTH, a boulevard's): its building lines stand under the deck's
 * edges, its columns on the sidewalks, and cars drive beneath the whole way,
 * straight on or across. railCurve.ts resamples and smooths the path into the
 * deck's line (deckCurve), the same way the El's track is built. Where it
 * crosses the El its deck rises over the El's trains on a gentle hump
 * (settleHighway, from the El's own track curve).
 *
 * The deck carries three lanes each way between wide shoulders, a median
 * barrier with long crossovers every few hundred meters (medianGaps), and
 * lamp posts down the median. Drivable, in two levels (districts/types.ts
 * DeckSpan `upper`): the deck is one level and the street beneath it another;
 * World.heightAt puts a car on the one its body is nearer. Its parapets and
 * median stop cars on the deck (Wall.bottom); its columns stop cars below
 * (Wall.under), and so does every other wall standing under the deck
 * (settleHighwayWalls), so nothing below stands in the way up there.
 *  - the ends (loopPlan.ts): no wall anywhere. The deck stops inside one of
 *    the last blocks at each end, where the median's barriers fan out into a
 *    V and both carriageways leave it on cloverleaf loops of three quarters
 *    of a circle, one through the block on each side: the outgoing one curls
 *    off to its right down to a mouth on the street beneath the deck, the
 *    incoming one climbs from a mouth across that street on its mirror. Each
 *    mouth is a junction on that street (layMouths: a stub of kind 'mouth' out
 *    to the loop's foot), and where the two face each other across it, as
 *    they mostly do, one crossroads of their own: lights, crosswalks, and a
 *    car coming down one loop may carry straight on up the other.
 *  - interchanges (rampPlan.ts, CFG.interchanges): slip ramps, the way an
 *    expressway over a street meets the street beneath. By a junction, on
 *    one side, an off-ramp leaves the deck on a long deceleration lane and
 *    comes down alongside it over the frontage to run along the street at
 *    its level just short of the junction, where its traffic slips across
 *    the cut sidewalk into the street's lanes; just past the junction the
 *    on-ramp peels off the street the same way, climbs alongside and merges
 *    on a long acceleration lane (the deck widened onto it, tapering back).
 *    Two lane one way roads with walls on both sides (but along a slip
 *    ramp's run, open to the street), no turn in either: a single level (a
 *    `solid` span: nothing under it) up the embankment in the block its foot
 *    is in, two levels like the deck from there on, over the cross street.
 *    Geometry and the profile: rampAxis.ts (a slip ramp's axis is a polyline
 *    along the deck's edge). Each ramp and loop is an area of its own
 *    (variant 'ramp'), so later planners keep off it.
 *  - alleys (alleys.ts): the frontage under every lane and slip ramp bridge
 *    is paved and opened to the street beneath and the cross streets, a back
 *    way under the deck (variant 'alley').
 *  - columns: along every street under the deck a bent of two square columns,
 *    one on each sidewalk behind the curb, carrying a cap beam under the deck,
 *    and an outer one behind an alley's back wall under a lane. Never on a
 *    road, clear of every junction's closure reach, the El's deck and
 *    stations, the river and every ramp's mouth;
 *  - exclusions: no buildings or infill near a swing's turns (the deck cuts
 *    the corner there), beside a block of street left at its width (an alley
 *    ends on it: its mouth stays as it was, the deck overhangs the frontage),
 *    nor on a ramp's or a loop's right of way, beside its lane or in an alley.
 *  - in a race an alley's mouth onto a cross street the route does not take
 *    is closed (highwayGates, drawn as a cyan barrier); the ramps and loops
 *    stay open, though the deck is no part of any route: it crosses route
 *    streets in the open and is not in the road graph, so routes never use
 *    it (they may well run under it), and a racer who climbs onto it is off
 *    the course until a reset puts it back on the route.
 *
 * Planned right after the bluff (districts/index.ts): it keeps off the river
 * channel, the bluff, roundabouts and alleys, edits the graph (the widening,
 * the swings' diagonals, the missing streets) before any face is claimed, and
 * claims the streets under its deck (not the El's) and its ramps' foot
 * streets, so back alleys, shortcuts, markets, parks, the monument, car parks
 * and lane closures keep off them; hills keep their slopes off it (hills.ts),
 * tunnels and overpasses keep clear (structures.ts siteHazards).
 *
 * The district is split along its seams in this folder: line.ts plans the
 * deck's line (rows, swings, hazards), loopPlan.ts its end loops, rampPlan.ts
 * its interchanges' slip ramps alongside it, alleys.ts the alleys under the
 * lanes, rampAxis.ts is a ramp's centerline and height profile, shape.ts the
 * deck and ramps as everything downstream reads them, build.ts their walls,
 * columns, spans and exclusions, settle.ts their heights from the finished
 * terrain and what the world asks of them in a race; this module is the
 * DistrictModule itself: the roll, the search for a line with its ends and
 * interchanges, the graph edit, the areas and claims.
 */
import { CITY } from '../../config';
import { addEdge, addNode, chainFrom, roadDims, splitEdge } from '../../roadGraph';
import type { RoadEdge } from '../../roadGraph';
import type { Rng } from '../../../sim/prng';
import { type Vec2, distToSegment, segmentT } from '../../../sim/math';
import type { DistrictModule, PlanContext } from '../types';
import { GORE, HALF, UNDER_WIDTH } from './shape';
import { LinePlan, Swing, hazards, highwayRows, outline, planLine } from './line';
import { RampPlan, RampSite, SLIP_NOSE, planInterchanges, rampSite, siteBase } from './rampPlan';
import { EndPlan, planEnds } from './loopPlan';
import { Stretch, alleyArea, buildAlley, planAlleys } from './alleys';
import { projectOnCurve } from '../../railCurve';
import { axisAt } from './rampAxis';
import { buildDeck, buildRamp } from './build';

const CFG = CITY.districts.highway;

export const highwayModule: DistrictModule = {
  kind: 'highway',
  phase: 'graph',
  plan(ctx) {
    if (!CFG.enabled) return;
    const rng = ctx.rng;
    // The roll first, so the rate is the chance whatever the city (highwayRolled).
    if (!rng.chance(CFG.chance)) return;
    const W = CITY.gridW;
    const H = CITY.gridH;
    const hz = hazards(ctx);
    const rowsOrder = highwayRows(rng);
    const want = rng.int(CFG.swings[0], CFG.swings[1]);
    const wantPairs = rng.int(CFG.interchanges[0], CFG.interchanges[1]);
    const rowsWith = (r0: number, swings: readonly Swing[]): number[] => {
      const rows = new Array<number>(W).fill(r0);
      for (const s of swings) for (let i = s.i1; i < W; i++) rows[i] = s.to;
      return rows;
    };
    // A swing's diagonal crosses one block: from column i0 on one row to i0 + 1 on the next.
    const candidates = (from: number, iMin: number): Swing[] => {
      const out: Swing[] = [];
      for (let i0 = iMin; i0 + 1 <= W - 2; i0++) {
        for (const d of [1, -1]) {
          const to = from + d;
          if (to < 1 || to > H - 2) continue;
          out.push({ i0, i1: i0 + 1, from, to });
        }
      }
      rng.shuffle(out);
      return out;
    };
    // Per row (in a seeded order): lines with the wanted number of swings first, then the others, so a
    // row with an alley, a roundabout or a claimed junction on it can still be dodged by a swing or two.
    const tries: { rows: number[]; swings: Swing[] }[] = [];
    for (const r0 of rowsOrder) {
      const singles = candidates(r0, 1);
      const one = singles.map((s) => ({ rows: rowsWith(r0, [s]), swings: [s] }));
      const two: { rows: number[]; swings: Swing[] }[] = [];
      for (const s of singles.slice(0, 8)) for (const s2 of candidates(s.to, s.i1 + 1).slice(0, 6)) two.push({ rows: rowsWith(r0, [s, s2]), swings: [s, s2] });
      const none = [{ rows: rowsWith(r0, []), swings: [] as Swing[] }];
      tries.push(...(want >= 2 ? [...two, ...one, ...none] : [...one, ...none, ...two]));
    }
    // Every line at the gentle grade cap first; a hilly city with no line under it tries the steeper one.
    // A line takes its end loops first (no line without them: nobody meets a wall at its ends), then its
    // interchanges between them; only where no line has room for one does a line go without.
    const lines: (LinePlan | null | undefined)[] = [];
    const base = siteBase(ctx);
    // A line's ends are the same whatever its interchanges: planned once per line and cap.
    const sites = new Map<number, RampSite>();
    const endsOf = new Map<string, EndPlan[] | null>();
    for (const least of [CFG.interchanges[0], 0]) {
      for (const cap of CFG.rampGrade) {
        for (let k = 0; k < tries.length; k++) {
          if (lines[k] === undefined) lines[k] = planLine(ctx, hz, tries[k].rows, tries[k].swings);
          const line = lines[k];
          if (!line) continue;
          if (!sites.has(k)) sites.set(k, rampSite(ctx, hz, line, base));
          const site = sites.get(k)!;
          const key = `${k}:${cap}`;
          if (!endsOf.has(key)) endsOf.set(key, planEnds(site, cap));
          const ends = endsOf.get(key)!;
          if (!ends) continue;
          // Lanes may run on toward an end until just short of where its loops take the carriageways over.
          const limits: [number, number] = [ends[0].s + 15, ends[1].s - 15];
          const pairs = planInterchanges(site, wantPairs, least, rng, cap, limits, ends.flatMap((e) => e.loops));
          if (!pairs) continue;
          commit(ctx, line, site, ends, pairs, rng);
          return;
        }
      }
    }
  },

  build(ctx, area) {
    if (area.variant === 'ramp') return buildRamp(ctx, area);
    if (area.variant === 'alley') return buildAlley(ctx, area);
    return buildDeck(ctx, area);
  },
};

/**
 * The line's streets as the deck needs them: every piece under it widened to the deck's width (a
 * boulevard's carriageway and the plain sidewalks), its missing streets laid again and its swings'
 * diagonals laid, all at that width but where an alley ends (a plain street's there). Returns the pieces laid. The graph is edited before any face is
 * claimed (districts/index.ts), and every later planner and the blocks see the final streets.
 */
function layStreets(ctx: PlanContext, line: LinePlan): number[] {
  const g = ctx.graph;
  const dims = { width: UNDER_WIDTH, lanes: 4 as const, sidewalk: CITY.sidewalk };
  const widen = (e: RoadEdge) => {
    e.width = Math.max(e.width, dims.width);
    e.sidewalk = dims.sidewalk;
    e.lanes = 4;
  };
  for (const e of line.widen) widen(g.edges[e]);
  // Where an alley ends, a laid street keeps a plain street's width (LinePlan.narrow).
  const dimsOf = (a: number, b: number) => (line.narrow.some(([p, q]) => p === a && q === b) ? roadDims('street') : dims);
  const laid: number[] = [];
  for (const [a, b] of line.fills) laid.push(addEdge(g, a, b, 'street', dimsOf(a, b)));
  for (const [a, b] of line.diagonals) laid.push(addEdge(g, a, b, 'avenue', dimsOf(a, b)));
  ctx.graphChanged();
  return laid;
}

/**
 * Each end loop's mouth as a junction on the street beneath the deck: the street split where the foot
 * stands off it (a new node on its centerline, the foot square out from it on the building line) and a
 * stub of kind 'mouth' out to the foot, as wide as the loop and without sidewalks, so the junction's
 * corners cut the street's sidewalk just where the loop's walls begin. Two loops whose feet face each
 * other across the street share the node: a crossroads. Returns the new pieces of the deck's streets
 * (`deckEdges`, which grows with them) and the junctions, and each loop's stub and foot node (its own).
 * A piece split off a street some area planned before holds (the El's) is that area's, as the rest is.
 */
function layMouths(ctx: PlanContext, loops: readonly RampPlan[], deckEdges: Set<number>): { pieces: number[]; nodes: number[]; stubs: Map<RampPlan, { edge: number; node: number }> } {
  const g = ctx.graph;
  const pieces: number[] = [];
  const nodes: number[] = [];
  const stubs = new Map<RampPlan, { edge: number; node: number }>();
  // Every piece split off or reshaped (a moved bend node's) so far: a later foot may stand on one.
  const made: number[] = [];
  for (const r of loops) {
    if (r.footD === undefined) continue;
    const e0 = g.edges[r.edge];
    const A = g.nodes[e0.a];
    const B0 = g.nodes[e0.b];
    // The foot's place on the street's centerline, measured on the piece as planned (a split since keeps
    // its node a, so a later split finds its point on whichever piece now holds it).
    const len = Math.hypot(B0.x - A.x, B0.z - A.z) || 1;
    const P = { x: A.x + ((B0.x - A.x) / len) * r.footD, z: A.z + ((B0.z - A.z) / len) * r.footD };
    let node = nodes.find((n) => Math.hypot(g.nodes[n].x - P.x, g.nodes[n].z - P.z) < 0.5) ?? -1;
    if (node < 0) {
      // The piece nearest the place (a moved bend node shifts its pieces a hair off the planned line).
      let on = -1;
      let best = 1;
      for (const id of [r.edge, ...made]) {
        const e = g.edges[id];
        const d = distToSegment(P.x, P.z, g.nodes[e.a].x, g.nodes[e.a].z, g.nodes[e.b].x, g.nodes[e.b].z);
        if (d < best) {
          best = d;
          on = id;
        }
      }
      if (on < 0) continue;
      const e = g.edges[on];
      // A bend node of the street (a piece's end where the warp turns it a little) within the stub's reach
      // becomes the junction, moved onto the foot's place: split beside it, its corner would stand in the
      // stub's mouth and fold the block's frontage back across it.
      const bend = [e.a, e.b].find((id) => g.nodes[id].gi < 0 && g.nodes[id].edges.length === 2 && Math.hypot(g.nodes[id].x - P.x, g.nodes[id].z - P.z) < r.half + 3);
      if (bend !== undefined) {
        const b = g.nodes[bend];
        b.x = P.x;
        b.z = P.z;
        for (const id of b.edges) {
          const ed = g.edges[id];
          ed.length = Math.hypot(g.nodes[ed.a].x - g.nodes[ed.b].x, g.nodes[ed.a].z - g.nodes[ed.b].z);
          made.push(id);
        }
        node = bend;
      } else {
        const a = g.nodes[e.a];
        const b = g.nodes[e.b];
        node = splitEdge(g, on, Math.max(0.02, Math.min(0.98, segmentT(P.x, P.z, a.x, a.z, b.x, b.z))));
        const piece = g.edges.length - 1;
        made.push(piece);
        const owner = ctx.claims.edge.get(on);
        if (deckEdges.has(on)) {
          deckEdges.add(piece);
          pieces.push(piece);
        } else if (owner !== undefined) {
          ctx.claims.edge.set(piece, owner);
          ctx.areas[owner].edges.push(piece);
        }
      }
      nodes.push(node);
    }
    const foot = addNode(g, r.axis.fx, r.axis.fz);
    const edge = addEdge(g, node, foot, 'mouth', { width: 2 * r.half, lanes: 2, sidewalk: 0 });
    stubs.set(r, { edge, node: foot });
  }
  ctx.graphChanged();
  return { pieces, nodes, stubs };
}

function commit(ctx: PlanContext, line: LinePlan, site: RampSite, ends: EndPlan[], pairs: RampPlan[][], rng: Rng): void {
  const laid = layStreets(ctx, line);
  const mouths = layMouths(ctx, ends.flatMap((e) => e.loops), new Set([...line.edges, ...laid]));
  const ramps = [...ends.flatMap((e) => e.loops), ...pairs.flat()];
  const params: Record<string, number> = {
    deckWidth: CFG.deckWidth,
    swings: line.swings,
    ramps: ramps.length,
    interchanges: pairs.length,
    seed: rng.int(1, 0x7ffffffe),
    turns: line.turns.length,
    // The drivable deck: between its end loops' E.
    sW: ends[0].s,
    sE: ends[1].s,
  };
  line.rows.forEach((r, i) => (params[`row${i}`] = r));
  line.at.forEach((k, i) => (params[`at${i}`] = k));
  line.turns.forEach((p, k) => {
    params[`turn${k}x`] = p.x;
    params[`turn${k}z`] = p.z;
  });
  params.narrow = line.narrow.length;
  line.narrow.forEach(([a, b], k) => {
    const A = ctx.graph.nodes[a];
    const B = ctx.graph.nodes[b];
    params[`narrow${k}ax`] = A.x;
    params[`narrow${k}az`] = A.z;
    params[`narrow${k}bx`] = B.x;
    params[`narrow${k}bz`] = B.z;
  });
  params.crossroads = ends.filter((e) => e.cross).length;
  const deck = ctx.addArea(
    { kind: 'highway', variant: 'deck', polygon: outline(line.path, HALF), path: line.path, nodes: [...line.nodes, ...mouths.nodes], edges: [...line.edges, ...laid, ...mouths.pieces], faces: [], params },
    line.offStreet * CFG.deckWidth,
  );
  // The column streets at a swing's junctions, block by block: no back alley or market crowds the turn.
  for (const [a, b] of line.diagonals) {
    for (const n of [a, b]) {
      for (const eid of ctx.graph.nodes[n].edges) for (const e of chainFrom(ctx.graph, n, eid).edges) if (!ctx.claims.edge.has(e)) ctx.claims.edge.set(e, deck.id);
    }
  }
  ramps.forEach((r, k) => {
    const ax = r.axis;
    // A slip ramp's axis is its polyline; a loop's (its leg and arc in the params) every few meters, for the maps.
    const path: Vec2[] = [];
    if (ax.poly) for (let i = 0; i < ax.poly.x.length; i++) path.push({ x: ax.poly.x[i], z: ax.poly.z[i] });
    else {
      for (let u = 0; u < ax.length; u += 8) path.push(axisAt(ax, u));
      path.push(axisAt(ax, ax.length));
    }
    const stub = mouths.stubs.get(r);
    const area = ctx.addArea(
      {
        kind: 'highway',
        variant: 'ramp',
        polygon: r.polygon,
        path: path.map((q) => ({ x: q.x, z: q.z })),
        nodes: stub ? [stub.node] : [],
        edges: [...r.footEdges.filter((e) => !ctx.claims.edge.has(e)), ...(stub ? [stub.edge] : [])],
        faces: [],
        params: {
          deck: deck.id,
          index: k,
          side: r.side,
          along: r.along,
          on: r.on ? 1 : 0,
          loop: r.loop ? 1 : 0,
          half: r.half,
          flat: r.flat,
          sa: r.sa,
          sb: r.sb,
          fx: ax.fx,
          fz: ax.fz,
          dx: ax.dx,
          dz: ax.dz,
          a: ax.a,
          cx: ax.cx,
          cz: ax.cz,
          r: ax.r,
          sweep: ax.sweep,
          phi0: ax.phi0,
          ex: ax.ex,
          ez: ax.ez,
          tx: ax.tx,
          tz: ax.tz,
          length: ax.length,
          edge: r.edge,
          // A loop's mouth stub (RoadKind 'mouth', layMouths), -1 without one.
          mouth: stub?.edge ?? -1,
          mouthSide: r.mouthSide,
          m0: r.m0,
          m1: r.m1,
          building: r.building,
          sBlock: r.sBlock,
          uSolid: r.uSolid,
          rise: r.rise,
          grade: r.grade,
        },
      },
      ax.length * 2 * r.half,
    );
    // The block's own streets are the highway's: no back alley, park or plaza cuts the ramp's block.
    for (const e of r.footEdges) if (!ctx.claims.edge.has(e)) ctx.claims.edge.set(e, area.id);
  });
  // The alleys under the slip ramps' bridges and lanes, from the blocks as the widened streets leave them;
  // not where an embankment or a run along the street stands on the frontage.
  const elevated: Stretch[] = [];
  const solid: Stretch[] = [];
  const span = (side: 1 | -1, a: number, b: number): Stretch => ({ side, range: [Math.min(a, b), Math.max(a, b)] });
  for (const r of pairs.flat()) {
    const sf = projectOnCurve(site.curve, r.axis.fx, r.axis.fz).s;
    const sSolid = sf + r.along * r.uSolid;
    solid.push(span(r.side, sf - r.along * SLIP_NOSE, sSolid));
    elevated.push(span(r.side, sSolid, r.sa), span(r.side, r.sa + r.along * GORE, r.sb));
  }
  const loops = ends.flatMap((e) => e.loops.map((l) => l.polygon));
  for (const a of planAlleys(ctx, site.curve, elevated, solid, loops)) ctx.addArea(alleyArea(deck.id, a), 0);
}
