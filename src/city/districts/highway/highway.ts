/**
 * Elevated highway: an expressway on a deck crossing the whole map west to
 * east, on 60% of seeds (highwayRolled: the first draw of its own stream). It
 * is planned like the El (subway.ts), transposed: it follows one grid row's
 * street centered over it, and once or twice swings to the next row on a
 * diagonal street of its own laid across one block corner to corner, the deck
 * turning through each of the swing's junctions on an arc; where its row's
 * street is missing that street is laid again. So the deck stands over a
 * street everywhere in the city, and every street under it is widened to the
 * deck's width (UNDER_WIDTH, a boulevard's): its building lines stand under
 * the deck's edges, its columns on the sidewalks, and cars drive beneath the
 * whole way, straight on or across. Past both map ends it runs on into the
 * fog. railCurve.ts resamples and smooths the path into the deck's line
 * (deckCurve), the same way the El's track is built. Where it crosses the El
 * its deck rises over the El's trains on a gentle hump (settleHighway, from
 * the El's own track curve).
 *
 * The deck carries three lanes each way between wide shoulders, a median
 * barrier with crossovers every few hundred meters (medianGaps), and lamp
 * posts down the median. Drivable, in two levels (districts/types.ts DeckSpan
 * `upper`): the deck is one level and the street beneath it another;
 * World.heightAt puts a car on the one its body is nearer. Its parapets,
 * median and the closures at both ends (just past the boundary streets: the
 * run on into the fog is drawn only) stop cars on the deck (Wall.bottom); its
 * columns stop cars below (Wall.under), and so does every other wall standing
 * under the deck (settleHighwayWalls), so nothing below stands in the way up
 * there.
 *  - columns: along every street under the deck a bent of two square columns,
 *    one on each sidewalk behind the curb, carrying a cap beam under the
 *    deck. Never on a road, clear of every junction's closure reach, the El's
 *    deck and stations, the river;
 *  - exclusions: no buildings or infill near a swing's turns (the deck cuts
 *    the corner there), beside a block of street left at its width (an alley
 *    ends on it: its mouth stays as it was, the deck overhangs the frontage),
 *    nor on a ramp's right of way and beside its merge.
 *  - on-ramps (CFG.ramps, 2 to 4): each a two lane road with walls on both
 *    sides from a mouth on the street parallel to the deck's, one block over,
 *    up through the block between them on a straight leg and one gentle
 *    curve, over the cross street at the block's far end on a short bridge,
 *    onto the deck beside its edge, heading the way traffic on that side
 *    runs; it merges over a long stretch where the deck is widened onto it
 *    and tapers back to the deck's edge. A single level (a `solid` span:
 *    nothing under it) up its embankment, two levels like the deck from where
 *    it leaves its block; the frontage it passes over is a wall only street
 *    cars meet (Wall.under). Geometry and the profile: rampAxis.ts. Each ramp
 *    is an area of its own (variant 'ramp'), so later planners keep off it.
 *  - in a race the ramps are closed at their mouths (highwayGates, drawn as a
 *    cyan barrier): the deck crosses route streets in the open and is not in
 *    the road graph, so routes never use it (they may well run under it); in
 *    free roam (an open world) it is open.
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
 * deck's line (rows, swings, hazards), rampPlan.ts fits its on-ramps into the
 * blocks beside it, rampAxis.ts is a ramp's centerline and height profile,
 * shape.ts the deck and ramps as everything downstream reads them, build.ts
 * their walls, columns, spans and exclusions, settle.ts their heights from the
 * finished terrain and what the world asks of them in a race; this module is
 * the DistrictModule itself: the roll, the search for a line with ramps, the
 * graph edit, the areas and claims.
 */
import { CITY } from '../../config';
import { addEdge, chainFrom, roadDims } from '../../roadGraph';
import type { RoadEdge } from '../../roadGraph';
import type { Rng } from '../../../sim/prng';
import type { DistrictModule, PlanContext } from '../types';
import { HALF, UNDER_WIDTH } from './shape';
import { LinePlan, Swing, hazards, outline, planLine } from './line';
import { RampPlan, planRamps } from './rampPlan';
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
    const rowsOrder: number[] = [];
    for (let j = 2; j <= H - 3; j++) rowsOrder.push(j);
    rng.shuffle(rowsOrder);
    // Rows next to the edges come last: a highway along the map's rim is seen by few races.
    rowsOrder.push(1, H - 2);
    const want = rng.int(CFG.swings[0], CFG.swings[1]);
    const wantRamps = rng.int(CFG.ramps[0], CFG.ramps[1]);
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
    const lines: (LinePlan | null | undefined)[] = [];
    for (const cap of CFG.rampGrade) {
      for (let k = 0; k < tries.length; k++) {
        if (lines[k] === undefined) lines[k] = planLine(ctx, hz, tries[k].rows, tries[k].swings);
        const line = lines[k];
        if (!line) continue;
        const ramps = planRamps(ctx, hz, line, wantRamps, rng, cap);
        if (!ramps) continue;
        commit(ctx, line, ramps, rng);
        return;
      }
    }
  },

  build(ctx, area) {
    return area.variant === 'ramp' ? buildRamp(ctx, area) : buildDeck(ctx, area);
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

function commit(ctx: PlanContext, line: LinePlan, ramps: RampPlan[], rng: Rng): void {
  const laid = layStreets(ctx, line);
  const params: Record<string, number> = {
    deckWidth: CFG.deckWidth,
    swings: line.swings,
    ramps: ramps.length,
    seed: rng.int(1, 0x7ffffffe),
    turns: line.turns.length,
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
  const deck = ctx.addArea(
    { kind: 'highway', variant: 'deck', polygon: outline(line.path, HALF), path: line.path, nodes: line.nodes, edges: [...line.edges, ...laid], faces: [], params },
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
    const area = ctx.addArea(
      {
        kind: 'highway',
        variant: 'ramp',
        polygon: r.polygon,
        path: [
          { x: ax.fx, z: ax.fz },
          { x: ax.ex, z: ax.ez },
        ],
        nodes: [],
        edges: r.footEdges.filter((e) => !ctx.claims.edge.has(e)),
        faces: [],
        params: {
          deck: deck.id,
          index: k,
          side: r.side,
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
      ax.length * 2 * CFG.rampHalf,
    );
    // The block's own streets are the highway's: no back alley, park or plaza cuts the ramp's block.
    for (const e of r.footEdges) if (!ctx.claims.edge.has(e)) ctx.claims.edge.set(e, area.id);
  });
}
