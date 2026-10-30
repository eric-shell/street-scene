/**
 * Weekend special: the scrapyard (src/city/weekend.ts, docs/weekend.md).
 *
 * A walled lot behind a corrugated fence (scrapFence) with its gates open: a banked dirt figure eight (two
 * bowls, banking.ts, rims tangent at a flat neck) between stacks of crushed cars (carStack) under floodlights, a
 * crusher (crusher) and a magnet crane, tyre walls and, along the back, a canyon between two walls of stacks that
 * ends in a kicker over the crusher's pit into the far bowl's bank. Planned only on the seeds whose weekend
 * pick is `scrapyard`; every other seed's plan returns at once, so no other city changes. Registered right after
 * the back alleys so it plans after the topology hook (it reads both routes from PlanContext.event) and gets
 * first pick of the blocks along them, before the market, the car park, the lake's block claim and the lots.
 * Its kind is in CORRIDOR_AREAS (districts/types.ts) so a race through the yard is not reset as lost.
 *
 * Where it stands and how it fits the block: scrapyardPlan.ts. What is inside, as one pure function of the area
 * that the sim, this build and the renderer all read: scrapyardLayout.ts. This module turns that into the city's
 * parts:
 *  - walls: the fence (a solid body both sides, as the lot's) round the block ring with a gap at each curb cut and a
 *    solid post either side of it; the stacks, each a solid box (carStack); the crusher, the crane's base and the
 *    floodlight towers' bases (crusher). Nothing leaves the yard but through a cut;
 *  - ground: the whole ring is an `offroad` surface patch (dirt: the surface entry in drivingParams.json), buildings
 *    keep out of it and its frontage opens; the heights are four mods that each fade to 0 at their box: the two
 *    banked bowls, the pit and the kicker (a one sided table rise with solid sides: the canyon's walls);
 *  - the cuts: 'mouth' hints (the street's curb steps back the whole sidewalk) and reserved circles, so furniture keeps off;
 *  - clutter: tyre stacks, drums, crates, pallets, a cable spool and trash bags, mostly down the canyon (the risky line);
 *  - the press across the canyon is a timed gate (scrapyardGates.ts, appended to World.timedGates by createWorld).
 *
 * Lines: the figure eight (fast, banked), the canyon (short, blind, tyres and drums, the press and the jump) and the
 * perimeter aisle (the safe one, longest, with the crane and the crusher beside it). The eight is a drift zone
 * (sim/driftZones.ts). No sign and no arrow: the gap in the fence, the gravel mouth and the floodlights say "in here".
 */
import { CITY } from '../config';
import { MOUTH_REACH, bayHi, bayInset, bayLo, bayPoint, mouthBay } from '../busBays';
import type { Vec2 } from '../../sim/math';
import { bankedRingMod } from './banking';
import { type Smooth, smooth01, solidWalls } from './geom';
import type { DistrictModule, HeightMod, HeightSample } from './types';
import { emptyBuild } from './types';
import { planScrapyard } from './scrapyardPlan';
import { type YardFrame, scrapLayout, yardCuts, yardDims, yardFrame, yardPoint } from './scrapyardLayout';

export { scrapLayout, yardCuts, yardZone } from './scrapyardLayout';
export type { ScrapLayout, ScrapStack, YardCut } from './scrapyardLayout';

const C = CITY.districts.scrapyard;

/** Surface patch priority of the dirt: above the sidewalk (3) so no curb lifts it. */
const DIRT_PRIORITY = 4;

/** The pit's edges ease over this many metres (its slopes top out at 1.5 depth / PIT_EASE). */
const PIT_EASE = 3;

/** Scratch for the terrain's smoothsteps (queried per wheel per substep, so nothing allocates). */
const S1: Smooth = { v: 0, d: 0 };
const S2: Smooth = { v: 0, d: 0 };

/** A height mod over an oriented rectangle of the yard frame: `shape` writes the height and its u and w partials at (u, w). */
function frameMod(f: YardFrame, u0: number, u1: number, w0: number, w1: number, shape: (u: number, w: number, out: { h: number; hu: number; hw: number }) => void): HeightMod {
  const { o, u, w } = f;
  const corners = [yardPoint(f, u0, w0), yardPoint(f, u1, w0), yardPoint(f, u1, w1), yardPoint(f, u0, w1)];
  const out = { h: 0, hu: 0, hw: 0 };
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minZ: Math.min(...corners.map((p) => p.z)),
    maxZ: Math.max(...corners.map((p) => p.z)),
    add(x: number, z: number, s: HeightSample): void {
      const du = (x - o.x) * u.x + (z - o.z) * u.z;
      const dw = (x - o.x) * w.x + (z - o.z) * w.z;
      if (du <= u0 || du >= u1 || dw <= w0 || dw >= w1) return;
      out.h = 0;
      out.hu = 0;
      out.hw = 0;
      shape(du, dw, out);
      s.h += out.h;
      s.gx += out.hu * u.x + out.hw * w.x;
      s.gz += out.hu * u.z + out.hw * w.z;
    },
  };
}

/**
 * The pit and the kicker as height mods in the yard frame: the pit a smoothstep plateau `depth` m below grade, `length` m along the
 * jump and `halfWidth` m each side of the canyon; the kicker the channel's `table` rise (a quadratic ease over the first `ease` of
 * the run at its foot, then constant grade up to the lip), bevelled at its sides over `edge`, and past the lip a smoothstep fall
 * of `drop` m back to grade. Exported for the tests.
 */
export function yardJumpMods(F: YardFrame, R: number, canyonU: number, lip: number): HeightMod[] {
  const { S } = yardDims(R);
  const pit = C.pit;
  const K = C.kicker;
  const half = C.canyon.aisle / 2;
  const pw0 = S;
  const pw1 = S + pit.length;
  const pmid = (pw0 + pw1) / 2;
  const e = K.ease;
  const sc = 1 / (1 - e / 2);
  return [
    frameMod(F, canyonU - pit.halfWidth, canyonU + pit.halfWidth, pw0, pw1, (u, w, out) => {
      const a = smooth01(pit.halfWidth - PIT_EASE, pit.halfWidth, Math.abs(u - canyonU), S1);
      const c = smooth01(pit.length / 2 - PIT_EASE, pit.length / 2, Math.abs(w - pmid), S2);
      out.h = -pit.depth * (1 - a.v) * (1 - c.v);
      out.hu = pit.depth * a.d * (u >= canyonU ? 1 : -1) * (1 - c.v);
      out.hw = pit.depth * (1 - a.v) * c.d * (w >= pmid ? 1 : -1);
    }),
    frameMod(F, canyonU - half, canyonU + half, lip - K.fall, lip + K.run, (u, w, out) => {
      const wl = smooth01(half - K.edge, half, Math.abs(u - canyonU), S1);
      const win = 1 - wl.v;
      const winU = -wl.d * (u >= canyonU ? 1 : -1);
      // k = 0 at the foot of either side, 1 at the lip; the run up and the fall away share the table's profile.
      const up = w >= lip;
      const k = up ? 1 - (w - lip) / K.run : 1 - (lip - w) / K.fall;
      let v: number;
      let dv: number;
      if (k < e) {
        v = (sc * k * k) / (2 * e);
        dv = (sc * k) / e;
      } else {
        v = sc * (k - e / 2);
        dv = sc;
      }
      out.h = K.rise * v * win;
      out.hw = up ? ((-K.rise * dv) / K.run) * win : ((K.rise * dv) / K.fall) * win;
      out.hu = K.rise * v * winU;
    }),
  ];
}

export const scrapyardModule: DistrictModule = {
  kind: 'scrapyard',
  phase: 'graph',
  plan(ctx) {
    planScrapyard(ctx);
  },
  build(ctx, area) {
    const b = emptyBuild();
    const id = area.id;
    const L = scrapLayout(area);
    const F = yardFrame(area);
    b.exclusions.push(area.polygon);
    b.openings.push(area.polygon);
    b.surfaces.push({ surface: 'offroad', polygon: area.polygon, priority: DIRT_PRIORITY, area: id });

    // Walls: the fence pieces (solid thin bodies inward from the ring), the posts, the stacks and the machines.
    const T = C.fence.thickness;
    for (const p of L.fences) {
      const quad: Vec2[] = [
        { x: p.ax, z: p.az },
        { x: p.bx, z: p.bz },
        { x: p.bx + p.nx * T, z: p.bz + p.nz * T },
        { x: p.ax + p.nx * T, z: p.az + p.nz * T },
      ];
      b.walls.push(...solidWalls(quad, 'scrapFence', id));
    }
    for (const p of L.posts) b.walls.push(...solidWalls(p.poly, 'scrapFence', id));
    for (const s of L.stacks) b.walls.push(...solidWalls(s.poly, 'carStack', id));
    for (const s of [L.crusher, L.crane, ...L.conveyor, ...L.towers]) b.walls.push(...solidWalls(s.poly, 'crusher', id));

    // Heights: the bowls, the pit, the kicker.
    for (const r of L.rings) b.heightMods.push(bankedRingMod(r));
    b.heightMods.push(...yardJumpMods(F, L.R, L.canyon.u, L.canyon.lip));

    b.destructibles.push(...L.clutter);

    // The curb cuts: the street's curb steps back the whole sidewalk; furniture keeps off.
    for (const c of yardCuts(area)) {
      const bay = mouthBay(ctx.graph, ctx.mouths, -1, c.road, c.side, c.s0, c.s1, c.taper);
      const depth = bay.depth - MOUTH_REACH;
      const lo = bayLo(bay);
      const hi = bayHi(bay);
      b.hints.push({ kind: 'mouth', points: bay.polygon, values: [c.road, c.side, c.s0, c.s1, c.taper] });
      for (let s = lo; s <= hi + 1e-6; s += 2) for (const v of [0.6, depth / 2, depth - 0.6]) if (v < bayInset(bay, s) + 0.6) b.reserved.push({ ...bayPoint(bay, s, v), r: 1.2 });
    }
    return b;
  },
};
