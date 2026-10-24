/**
 * Elevated highway: a freeway on a deck crossing the whole map west to east,
 * on 60% of seeds (highwayRolled: the first draw of its own stream). It is
 * planned like the El (subway.ts), transposed: it follows one grid row's
 * street centered over it (the deck, CFG.deckWidth wide, fits inside a plain
 * street's corridor, clear of the facades), runs straight over a block where
 * that street is missing, and once or twice swings to the next row through
 * the blocks on a tangent S curve (a cubic past a junction, like the El's),
 * crossing the column streets between mid block at a skew; past both map
 * ends it runs on into the fog. railCurve.ts resamples and smooths the path
 * into the deck's line (deckCurve), the same way the El's track is built.
 * Where it crosses the El its deck rises over the El's trains on a gentle
 * hump (settleHighway, from the El's own track curve).
 *
 * Drivable, in two levels (districts/types.ts DeckSpan `upper`): the deck is
 * one level and the street beneath it another; World.heightAt puts a car on
 * the one its body is nearer. Its jersey barriers, median and the closures
 * at both ends (just past the boundary streets: the run on into the fog is
 * drawn only) stop cars on the deck (Wall.bottom); its columns stop cars
 * below (Wall.under), and so does every other wall standing under the deck
 * (settleHighwayWalls), so nothing below stands in the way up there.
 *  - columns: along the streets a bent of two square columns, one on each
 *    sidewalk behind the curb, carrying a cap beam under the deck; through
 *    the blocks hammerhead columns on the deck line, with one on each
 *    sidewalk of every street the deck crosses. Never on a road, clear of
 *    every junction's closure reach, the El's deck and stations, the river;
 *  - exclusions: no buildings or infill under the deck where it is off its
 *    street, nor on a ramp's right of way.
 *  - on-ramps (CFG.ramps, 2 to 4): each a two lane road with walls on both
 *    sides from a mouth on the street parallel to the deck's, one block over,
 *    up through the block between them on a straight leg and one curve, onto
 *    the deck beside its edge, heading the way traffic on that side runs; it
 *    merges over a stretch where the deck is widened onto it and tapers back
 *    to the deck's edge. A single level (a `solid` span: nothing under it)
 *    except near the top, where it passes over the sidewalk: there it is two
 *    levels like the deck, and the frontage below is a wall only street cars
 *    meet (Wall.under). Geometry and the profile: rampAxis.ts. Each ramp is
 *    an area of its own (variant 'ramp'), so later planners keep off it.
 *  - in a race the ramps are closed at their mouths (highwayGates, drawn as a
 *    cyan barrier): the deck crosses route streets in the open and is not in
 *    the road graph, so routes never use it; in free roam (an open world)
 *    it is open.
 *
 * Planned right after the bluff (districts/index.ts): it keeps off the river
 * channel, the bluff, roundabouts and alleys, and claims the streets it
 * follows (not the El's), the column streets its swings cross and its ramps'
 * foot streets, so back alleys, shortcuts, markets, parks, the monument,
 * car parks and lane closures keep off them; hills keep their slopes off it
 * (hills.ts), tunnels and overpasses keep clear (structures.ts siteHazards).
 *
 * The district is split along its seams in this folder: line.ts plans the
 * deck's line (rows, swings, hazards), rampPlan.ts fits its on-ramps into the
 * blocks beside it, rampAxis.ts is a ramp's centerline and height profile,
 * shape.ts the deck and ramps as everything downstream reads them, build.ts
 * their walls, columns, spans and exclusions, settle.ts their heights from the
 * finished terrain and what the world asks of them in a race; this module is
 * the DistrictModule itself: the roll, the search for a line with ramps, the
 * areas and claims.
 */
import { CITY } from '../../config';
import type { Rng } from '../../../sim/prng';
import type { DistrictModule, PlanContext } from '../types';
import { HALF } from './shape';
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
      for (const s of swings) {
        for (let i = s.i0 + 1; i < s.i1; i++) rows[i] = -1;
        for (let i = s.i1; i < W; i++) rows[i] = s.to;
      }
      return rows;
    };
    const candidates = (from: number, iMin: number): Swing[] => {
      const out: Swing[] = [];
      for (let i0 = iMin; i0 + CFG.swingCols[0] <= W - 2; i0++) {
        for (let L = CFG.swingCols[0]; L <= CFG.swingCols[1]; L++) {
          for (const d of [1, -1]) {
            const to = from + d;
            if (i0 + L > W - 2 || to < 1 || to > H - 2) continue;
            out.push({ i0, i1: i0 + L, from, to });
          }
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
    for (const t of tries) {
      const line = planLine(ctx, hz, t.rows, t.swings);
      if (!line) continue;
      const ramps = planRamps(ctx, hz, line, wantRamps, rng);
      if (!ramps) continue;
      commit(ctx, line, ramps, rng);
      return;
    }
  },

  build(ctx, area) {
    return area.variant === 'ramp' ? buildRamp(ctx, area) : buildDeck(ctx, area);
  },
};

function commit(ctx: PlanContext, line: LinePlan, ramps: RampPlan[], rng: Rng): void {
  const params: Record<string, number> = {
    deckWidth: CFG.deckWidth,
    swings: line.swings,
    ramps: ramps.length,
    seed: rng.int(1, 0x7ffffffe),
  };
  line.rows.forEach((r, i) => (params[`row${i}`] = r));
  line.at.forEach((k, i) => (params[`at${i}`] = k));
  const deck = ctx.addArea(
    { kind: 'highway', variant: 'deck', polygon: outline(line.path, HALF), path: line.path, nodes: line.nodes, edges: line.edges, faces: [], params },
    line.offStreet * CFG.deckWidth,
  );
  for (const e of line.crossed) ctx.claims.edge.set(e, deck.id);
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
